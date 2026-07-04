// Onboard MetaMask with a TEST seed phrase into a persistent profile, so the browser
// boots with an already-unlocked test wallet. Screenshots each step to .wallets/onboard/.
// TEST-ONLY mnemonic (public Hardhat/Anvil key) — never use a real one.
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_DIR = resolve(root, ".wallets", "metamask");
const PROFILE = resolve(root, ".wallets", "profile");
const SHOTS = resolve(root, ".wallets", "onboard");
const seedFile = resolve(root, ".wallets", "seed.txt");
// Prefer our OWN freshly-generated private seed (scripts/gen-wallet.mjs); fall back to
// the public Hardhat test mnemonic only if no private seed exists.
const SEED =
  process.env.TEST_SEED ||
  (existsSync(seedFile)
    ? readFileSync(seedFile, "utf8").trim()
    : "test test test test test test test test test test test junk");
const PASSWORD = process.env.TEST_WALLET_PASSWORD || "TestPilot123!";

mkdirSync(SHOTS, { recursive: true });
if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const log = [];
const record = (s) => {
  log.push(s);
  writeFileSync(resolve(SHOTS, "status.json"), JSON.stringify(log, null, 2));
};
const killer = setTimeout(() => {
  record({ step: "TIMEOUT", ok: false });
  process.exit(2);
}, 120000);

let n = 0;
// Headed by default — MetaMask's onboarding-completion button ("Open wallet") stays
// disabled in headless. Set HEADLESS=1 to force headless (not recommended for wallet).
const browser = await puppeteer.launch({
  headless: process.env.HEADLESS === "1",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    `--disable-extensions-except=${WALLET_DIR}`,
    `--load-extension=${WALLET_DIR}`,
  ],
  userDataDir: PROFILE,
  ignoreDefaultArgs: ["--disable-extensions"],
});

const sw = await browser.waitForTarget(
  (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
  { timeout: 15000 },
);
const id = new URL(sw.url()).host;
record({ step: "launched", extensionId: id, ok: true });

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const shot = async (label) => {
  n += 1;
  await page.screenshot({
    path: resolve(SHOTS, `${String(n).padStart(2, "0")}-${label}.png`),
  });
};
const sel = (t) => `[data-testid="${t}"]`;
// Dispatch the click in-page (el.click()) — returns immediately, unlike page.click()
// which can hang waiting on MetaMask's re-render/navigation in headless.
const domClick = (t) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.click();
    return true;
  }, sel(t));
const clickId = async (t, timeout = 12000) => {
  await page.waitForSelector(sel(t), { timeout, visible: true });
  await domClick(t);
};
// Fill a field via keyboard only: focus (no mouse → no hang), select-all, clear,
// type. MetaMask pages run under LavaMoat, so we avoid touching global constructors.
const fillField = async (cssSelector, value) => {
  await page.waitForSelector(cssSelector, { timeout: 8000 });
  await page.focus(cssSelector);
  await page.keyboard.down("Meta");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Meta");
  await page.keyboard.press("Backspace");
  await page.type(cssSelector, value, { delay: 6 });
};
// Click if present within a short window; return whether it clicked.
const maybeClick = async (t, timeout = 4000) => {
  try {
    await page.waitForSelector(sel(t), { timeout, visible: true });
    return await domClick(t);
  } catch {
    return false;
  }
};
// Click a button/link by (partial) visible text — for screens without stable testids.
const clickByText = async (text, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const clicked = await page.evaluate((t) => {
      const el = [...document.querySelectorAll("button, [role=button], a")].find(
        (e) => (e.innerText || "").trim().includes(t) && !e.disabled,
      );
      if (el) {
        el.click();
        return true;
      }
      return false;
    }, text);
    if (clicked) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

await page.goto(`chrome-extension://${id}/home.html#onboarding/welcome`, {
  waitUntil: "domcontentloaded",
  timeout: 25000,
});
await new Promise((r) => setTimeout(r, 2500));
await shot("welcome");

try {
  // 1) welcome → import existing wallet (accept terms checkbox if present first)
  await maybeClick("onboarding-terms-checkbox", 2500);
  await clickId("onboarding-import-wallet");
  record({ step: "clicked import", ok: true });
  await new Promise((r) => setTimeout(r, 1500));
  await shot("after-import");

  // 2) choose import method → seed phrase (v13 added social-login options)
  await clickId("onboarding-import-with-srp-button");
  record({ step: "chose SRP import", ok: true });
  await new Promise((r) => setTimeout(r, 1500));
  await shot("srp-screen");

  // 3) SRP entry. The note textarea splits into 12 verification fields; typing
  // char-by-char during the split can scramble a word, so we RE-FILL each field.
  const words = SEED.trim().split(/\s+/);
  await page.waitForSelector(sel("srp-input-import__srp-note"), {
    timeout: 12000,
  });
  // Type the phrase into the note; MetaMask splits it into 12 verification fields.
  await page.type(sel("srp-input-import__srp-note"), SEED.trim(), { delay: 8 });
  await new Promise((r) => setTimeout(r, 1200));
  // Verify each split field; fix only the ones that came out wrong (el.select() is a
  // DOM instance method, so it works despite LavaMoat locking down globals).
  if (await page.$(sel("import-srp__srp-word-11"))) {
    for (let i = 0; i < words.length; i += 1) {
      const s = sel(`import-srp__srp-word-${i}`);
      const val = await page.$eval(s, (el) => el.value).catch(() => "");
      if (val !== words[i]) {
        await page.focus(s);
        await page.$eval(s, (el) => el.select()).catch(() => {});
        await page.keyboard.press("Backspace");
        await page.type(s, words[i], { delay: 6 });
      }
    }
  }
  await new Promise((r) => setTimeout(r, 800));
  await shot("srp-filled");
  await clickId("import-srp-confirm");
  await new Promise((r) => setTimeout(r, 1500));
  const again = await maybeClick("import-srp-confirm", 3000);
  record({ step: "srp confirmed", secondConfirm: again, ok: true });
  await new Promise((r) => setTimeout(r, 2000));
  await shot("after-srp");

  // metametrics consent may appear around here
  await maybeClick("metametrics-i-agree", 3000);
  await maybeClick("metametrics-no-thanks", 1500);

  // 4) create password
  await page.waitForSelector(sel("create-password-new-input"), {
    timeout: 12000,
  });
  await fillField(sel("create-password-new-input"), PASSWORD);
  await fillField(sel("create-password-confirm-input"), PASSWORD);
  await maybeClick("create-password-terms", 3000);
  await shot("password-filled");
  await clickId("create-password-submit");
  record({ step: "password set", ok: true });
  await new Promise((r) => setTimeout(r, 2500));
  await shot("after-password");

  // 5) walk the trailing interstitials: passkey → metametrics consent → pin/popovers
  const skippedPasskey = await maybeClick("passkey-maybe-later-button", 8000);
  await new Promise((r) => setTimeout(r, 1200));
  // MetaMetrics consent ("help us improve") — accept/continue.
  const mm =
    (await maybeClick("metametrics-i-agree", 4000)) ||
    (await maybeClick("onboarding-metametrics-agree", 1500)) ||
    (await clickByText("继续", 3000)) ||
    (await clickByText("Continue", 1500)) ||
    (await clickByText("I agree", 1500));
  await new Promise((r) => setTimeout(r, 1500));
  await maybeClick("onboarding-complete-done", 4000);
  await maybeClick("pin-extension-next", 3000);
  await maybeClick("pin-extension-done", 3000);
  await maybeClick("popover-close", 2500);
  await clickByText("以后再说", 1500);
  // Finish into the real account. "Open wallet / 打开钱包" is disabled until MetaMask
  // finishes finalizing — poll until it is ENABLED, then click.
  for (let k = 0; k < 24; k += 1) {
    const state = await page.evaluate(() => {
      const el = [...document.querySelectorAll("button, [role=button]")].find((b) =>
        /打开钱包|Open wallet|完成|^Done$|知道了|Got it/.test(b.innerText || ""),
      );
      if (!el) return "gone";
      if (el.disabled || el.getAttribute("aria-disabled") === "true")
        return "disabled";
      el.click();
      return "clicked";
    });
    if (state === "clicked") {
      await new Promise((r) => setTimeout(r, 1500));
      break;
    }
    if (state === "gone") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await maybeClick("popover-close", 2000);
  record({ step: "completed", skippedPasskey, metametrics: mm, ok: true });
  await new Promise((r) => setTimeout(r, 2500));
  await shot("account-overview");
  // Verify we reached the account view (address/settings testids present).
  const onAccount = await page
    .evaluate(
      () =>
        !!document.querySelector('[data-testid="account-menu-icon"]') ||
        !!document.querySelector('[data-testid="app-header-copy-button"]') ||
        !!document.querySelector('[data-testid="eth-overview__primary-currency"]'),
    )
    .catch(() => false);
  record({ step: "account-overview", onAccount, ok: true });
} catch (e) {
  const els = await page
    .evaluate(() =>
      [...document.querySelectorAll("[data-testid], input, button, textarea")]
        .map((el) => ({
          testid: el.getAttribute("data-testid"),
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type"),
          text: (el.innerText || el.placeholder || "").trim().slice(0, 30),
        }))
        .filter((x) => x.testid || x.type || x.text),
    )
    .catch(() => []);
  record({ step: "ERROR", message: e.message, ok: false, els });
  await shot("error-state");
}

clearTimeout(killer);
await browser.close();
record({ step: "closed", ok: true });
process.exit(0);
