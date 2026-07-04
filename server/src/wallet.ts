import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Browser, Page } from "puppeteer";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Unpacked MetaMask lives in server/.wallets/metamask (see scripts/setup-wallet.mjs).
export const WALLET_DIR = resolve(__dirname, "..", ".wallets", "metamask");
// Onboarded profile (test seed already imported) — see scripts/onboard-wallet.mjs.
export const PROFILE_DIR = resolve(__dirname, "..", ".wallets", "profile");

// Our freshly-generated controllable account (scripts/gen-wallet.mjs writes account.txt);
// falls back to the public Hardhat account only if no private wallet was generated.
const accountFile = resolve(__dirname, "..", ".wallets", "account.txt");
export const TEST_ACCOUNT = existsSync(accountFile)
  ? readFileSync(accountFile, "utf8").trim()
  : "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const DEFAULT_WALLET_PASSWORD =
  process.env.TEST_WALLET_PASSWORD || "TestPilot123!";

// Local Anvil devnet the wallet is meant to use (chainId 31337) — NOT a public testnet.
export const LOCAL_CHAIN = {
  chainId: "0x7a69", // 31337
  chainName: "Anvil Local",
  rpcUrls: ["http://127.0.0.1:8545"],
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
} as const;

export function isWalletInstalled(): boolean {
  return existsSync(resolve(WALLET_DIR, "manifest.json"));
}

export function isWalletOnboarded(): boolean {
  return existsSync(PROFILE_DIR) && existsSync(resolve(PROFILE_DIR, "Default"));
}

// Background approver: watches for MetaMask popups (connect / signature / tx confirm)
// and approves them — unlock-in-popup if locked, dismiss passkey, click confirm. Runs
// until the returned stop() is called. Use during a dapp test that triggers popups.
export function startPopupApprover(
  browser: Browser,
  opts: { password?: string; intervalMs?: number } = {},
): () => void {
  const password = opts.password ?? DEFAULT_WALLET_PASSWORD;
  const interval = opts.intervalMs ?? 350;
  const sel = (t: string) => `[data-testid="${t}"]`;
  const APPROVE_IDS = [
    "confirm-btn",
    "confirm-footer-button",
    "page-container-footer-confirm",
    "page-container-footer-next",
  ];
  const APPROVE_TEXT = ["连接", "Connect", "确认", "Confirm", "签名", "Sign", "批准", "Approve", "下一步", "Next"];
  let stopped = false;
  const isSurface = (u: string) =>
    /chrome-extension:\/\/[a-z]+\/(notification|home)\.html/.test(u);

  const loop = async () => {
    while (!stopped) {
      try {
        for (const p of await browser.pages()) {
          if (p.isClosed() || !isSurface(p.url())) continue;
          if (await p.$(sel("unlock-password"))) {
            await p.type(sel("unlock-password"), password, { delay: 6 });
            await p.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.click(), sel("unlock-submit"));
            await new Promise((r) => setTimeout(r, 900));
          }
          await p
            .evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.click(), sel("passkey-maybe-later-button"))
            .catch(() => {});
          await p
            .evaluate(
              (ids: string[], texts: string[]) => {
                for (const id of ids) {
                  const el = document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
                  if (el && !el.disabled) {
                    el.click();
                    return;
                  }
                }
                const el = [...document.querySelectorAll("button, [role=button]")].find(
                  (b) => !(b as HTMLButtonElement).disabled && texts.some((t) => (b as HTMLElement).innerText.trim() === t),
                ) as HTMLElement | undefined;
                el?.click();
              },
              APPROVE_IDS,
              APPROVE_TEXT,
            )
            .catch(() => {});
        }
      } catch {
        /* pages churn; retry */
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}

// Unlock a locked MetaMask and KEEP the page open. MetaMask is MV3: if every
// extension page closes, the service worker is killed and the in-memory decrypted
// vault is lost, re-locking the wallet. Holding one page open keeps it unlocked.
export async function unlockWallet(
  browser: Browser,
  walletId: string,
  password = DEFAULT_WALLET_PASSWORD,
): Promise<{ page: Page; unlocked: boolean }> {
  const page: Page = await browser.newPage();
  const sel = (t: string) => `[data-testid="${t}"]`;
  const click = (t: string) =>
    page.evaluate(
      (s) => (document.querySelector(s) as HTMLElement | null)?.click(),
      sel(t),
    );

  await page.goto(`chrome-extension://${walletId}/home.html`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await new Promise((r) => setTimeout(r, 2500));

  if (await page.$(sel("unlock-password"))) {
    await page.type(sel("unlock-password"), password, { delay: 10 });
    await new Promise((r) => setTimeout(r, 300));
    await click("unlock-submit");
    // wait for the login form to disappear (real confirmation of unlock)
    await page
      .waitForSelector(sel("unlock-password"), { hidden: true, timeout: 12000 })
      .catch(() => {});
  }
  // dismiss the passkey/biometric prompt if it appears
  await page.waitForSelector(sel("passkey-maybe-later-button"), { timeout: 4000 })
    .then(() => click("passkey-maybe-later-button"))
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  // Verify: unlocked iff the login form is gone.
  const stillLocked = await page.$(sel("unlock-password"));
  return { page, unlocked: !stillLocked };
}

// Resolve the extension id of an MV3 wallet by finding its service-worker target.
export async function getExtensionId(
  browser: Browser,
  timeoutMs = 15000,
): Promise<string> {
  // The extension's MV3 background is a service worker: chrome-extension://<id>/...
  const target = await browser.waitForTarget(
    (t) =>
      (t.type() === "service_worker" || t.type() === "background_page") &&
      t.url().startsWith("chrome-extension://"),
    { timeout: timeoutMs },
  );
  return new URL(target.url()).host;
}
