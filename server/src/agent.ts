import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { PuppeteerAgent } from "@midscene/web/puppeteer";
import {
  WALLET_DIR,
  PROFILE_DIR,
  isWalletInstalled,
  isWalletOnboarded,
  getExtensionId,
  unlockWallet,
} from "./wallet.js";
import { resolveChainConfig, resolveViewport } from "./config.js";
import { setupInjectedWallet } from "./injectedWallet.js";
import type { StorageState } from "./db.js";

// Append fixed query params to a navigation URL (e.g. ?e2e=1&feature=x).
function appendQuery(url: string, query?: Record<string, string>): string {
  if (!query || !Object.keys(query).length) return url;
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return url; // non-absolute URL (about:blank etc.) — leave as-is
  }
}

// Fixed headers + captured cookies must be set BEFORE the first navigation.
async function applyPreNav(page: Page, opts: LaunchOpts): Promise<void> {
  if (opts.extraHeaders && Object.keys(opts.extraHeaders).length) {
    await page.setExtraHTTPHeaders(opts.extraHeaders);
  }
  const cookies = opts.storageState?.cookies;
  if (cookies?.length) {
    // Keep only the fields Puppeteer's setCookie accepts (page.cookies() adds extras).
    const clean = cookies.map((c) => {
      const o = c as Record<string, unknown>;
      const p: Record<string, unknown> = { name: o.name, value: o.value };
      for (const k of ["domain", "path", "expires", "httpOnly", "secure", "sameSite", "url"])
        if (o[k] !== undefined) p[k] = o[k];
      return p;
    });
    try {
      await page.setCookie(...(clean as unknown as Parameters<Page["setCookie"]>));
    } catch {
      /* some cookies may be rejected (e.g. bad domain) — best effort */
    }
  }
}

// Captured localStorage is per-origin and only applies once the page is on that origin,
// so it runs AFTER the first navigation. Returns true if anything was injected (→ reload).
async function applyPostNav(page: Page, storageState?: StorageState | null): Promise<boolean> {
  const origins = storageState?.origins;
  if (!origins?.length) return false;
  let injected = false;
  try {
    const here = new URL(page.url()).origin;
    const match = origins.find((o) => o.origin === here) ?? origins[0];
    if (match?.localStorage?.length) {
      await page.evaluate((items: { name: string; value: string }[]) => {
        for (const it of items) {
          try {
            window.localStorage.setItem(it.name, it.value);
          } catch {
            /* quota / disabled — skip */
          }
        }
      }, match.localStorage);
      injected = true;
    }
  } catch {
    /* cross-origin / no storage — skip */
  }
  return injected;
}

export interface Session {
  agent: PuppeteerAgent;
  page: Page;
  browser: Browser;
  walletId?: string;
  walletUnlocked?: boolean;
  walletPage?: Page; // kept-open MetaMask page holding the unlock (MV3 keep-alive)
  injectedAddress?: string; // address of the injected virtual wallet (injected mode)
  cleanup: () => Promise<void>;
}

export interface LaunchOpts {
  wallet?: boolean; // load the MetaMask extension
  unlock?: boolean; // unlock the onboarded wallet (default true when onboarded)
  injected?: boolean; // inject a virtual wallet (no extension) pointed at a configurable RPC
  rpcUrl?: string; // override the injected wallet's chain RPC
  chainId?: number; // override the injected wallet's chainId
  cacheId?: string; // Midscene cache key (with MIDSCENE_CACHE=1, re-runs replay from cache)
  headless?: boolean;
  extraHeaders?: Record<string, string>; // fixed request headers (resolved, secrets injected)
  query?: Record<string, string>; // fixed query-string params appended to navigations
  storageState?: StorageState | null; // captured login state → cookies + localStorage injected
}

// Launch Chrome for Testing (Puppeteer's default build) and wrap the page in a Midscene agent.
// Extensions require the NEW headless mode (headless:true in Puppeteer v23) + full Chrome —
// NOT chrome-headless-shell. We also use a persistent userDataDir, required for extensions.
export async function launchSession(
  url: string,
  opts: LaunchOpts = {},
): Promise<Session> {
  // Injected virtual wallet mode: no extension, headless, provider proxies to a config RPC.
  if (opts.injected) {
    const cfg = resolveChainConfig({ rpcUrl: opts.rpcUrl, chainId: opts.chainId });
    const browser = await puppeteer.launch({
      headless: opts.headless ?? true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setViewport(resolveViewport());
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    const { address } = await setupInjectedWallet(page, cfg);
    await applyPreNav(page, opts);
    const navUrl = appendQuery(url, opts.query);
    await page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (await applyPostNav(page, opts.storageState))
      await page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    const agent = new PuppeteerAgent(page, opts.cacheId ? { cacheId: opts.cacheId } : undefined);
    const cleanup = async () => {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    };
    return { agent, page, browser, injectedAddress: address, cleanup };
  }

  const wantsWallet = opts.wallet && isWalletInstalled();

  const args = ["--no-sandbox", "--disable-setuid-sandbox"];
  if (wantsWallet) {
    args.push(
      `--disable-extensions-except=${WALLET_DIR}`,
      `--load-extension=${WALLET_DIR}`,
    );
  }

  // Use the onboarded profile (test wallet already imported) when available; else a
  // fresh temp profile. Extensions require a real profile dir either way.
  const onboarded = wantsWallet && isWalletOnboarded();
  // MetaMask's onboarding-completion + connect popups need a real display; headless
  // leaves the wallet half-initialized. Default wallet runs to HEADED (override with
  // opts.headless, or HEADLESS=1 env). Non-wallet runs stay headless.
  const headless =
    opts.headless ??
    (wantsWallet ? process.env.HEADLESS === "1" : true);
  const browser = await puppeteer.launch({
    headless, // wallet → headed; otherwise new headless
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args,
    userDataDir: onboarded
      ? PROFILE_DIR
      : wantsWallet
        ? mkdtempSync(join(tmpdir(), "testpilot-profile-"))
        : undefined,
    // Puppeteer disables extensions by default; allow them.
    ignoreDefaultArgs: wantsWallet ? ["--disable-extensions"] : undefined,
  });

  let walletId: string | undefined;
  let walletUnlocked: boolean | undefined;
  let walletPage: Page | undefined;
  if (wantsWallet) {
    try {
      walletId = await getExtensionId(browser);
      // Auto-unlock the onboarded wallet so dapp tests start with a ready wallet.
      // Keep the returned page open — it holds the MV3 service worker alive.
      if (walletId && onboarded && opts.unlock !== false) {
        const r = await unlockWallet(browser, walletId);
        walletUnlocked = r.unlocked;
        walletPage = r.page;
      }
    } catch {
      // extension failed to register a worker — continue without it
    }
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await applyPreNav(page, opts);
  const navUrl = appendQuery(url, opts.query);
  // domcontentloaded (not networkidle0): robust for sites with analytics/polling that
  // never fully idle. aiAction waits for its target elements anyway.
  await page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  // Inject captured localStorage (per-origin) then reload so the app reads it.
  if (await applyPostNav(page, opts.storageState))
    await page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

  const agent = new PuppeteerAgent(page, opts.cacheId ? { cacheId: opts.cacheId } : undefined);
  const cleanup = async () => {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  };
  return { agent, page, browser, walletId, walletUnlocked, walletPage, cleanup };
}

// Open the wallet's own UI page (onboarding/home) so an agent can drive it.
export async function openWalletPage(
  browser: Browser,
  walletId: string,
  path = "home.html",
): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${walletId}/${path}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  return page;
}

export async function screenshotBase64(page: Page): Promise<string> {
  const buf = await page.screenshot({ type: "jpeg", quality: 60 });
  return `data:image/jpeg;base64,${Buffer.from(buf).toString("base64")}`;
}
