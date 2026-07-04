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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
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
  // domcontentloaded (not networkidle0): robust for sites with analytics/polling that
  // never fully idle. aiAction waits for its target elements anyway.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

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
