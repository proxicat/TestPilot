// Launch with the persistent profile (which already holds the onboarded vault),
// unlock MetaMask with the password, and screenshot the account overview.
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_DIR = resolve(root, ".wallets", "metamask");
const PROFILE = resolve(root, ".wallets", "profile");
const SHOTS = resolve(root, ".wallets", "onboard");
const PASSWORD = process.env.TEST_WALLET_PASSWORD || "TestPilot123!";

const killer = setTimeout(() => process.exit(2), 60000);
const browser = await puppeteer.launch({
  headless: true,
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
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(`chrome-extension://${id}/home.html`, {
  waitUntil: "domcontentloaded",
  timeout: 20000,
});
await new Promise((r) => setTimeout(r, 2500));

const dump = await page.evaluate(() =>
  [...document.querySelectorAll("[data-testid], input, button")]
    .map((el) => ({
      testid: el.getAttribute("data-testid"),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type"),
      text: (el.innerText || el.placeholder || "").trim().slice(0, 30),
    }))
    .filter((x) => x.testid || x.type),
);
writeFileSync(resolve(SHOTS, "login-dump.json"), JSON.stringify(dump, null, 2));
await page.screenshot({ path: resolve(SHOTS, "10-login.png") });

// Try to unlock with the standard MetaMask unlock testids.
const sel = (t) => `[data-testid="${t}"]`;
let unlocked = false;
try {
  await page.waitForSelector(sel("unlock-password"), { timeout: 8000 });
  await page.type(sel("unlock-password"), PASSWORD, { delay: 10 });
  await page.evaluate(
    (s) => document.querySelector(s)?.click(),
    sel("unlock-submit"),
  );
  await new Promise((r) => setTimeout(r, 4000));
  await page.screenshot({ path: resolve(SHOTS, "11-unlocked.png") });
  // Post-unlock interstitials (biometric/passkey, what's-new). Dump + dismiss.
  const post = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid], button, a[role=button]")]
      .map((el) => ({
        testid: el.getAttribute("data-testid"),
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || "").trim().slice(0, 25),
      }))
      .filter((x) => x.testid || x.text),
  );
  writeFileSync(resolve(SHOTS, "post-unlock-dump.json"), JSON.stringify(post, null, 2));
  unlocked = true;
} catch (e) {
  writeFileSync(resolve(SHOTS, "unlock-error.txt"), e.message);
}
console.log(JSON.stringify({ id, unlocked, fields: dump.length }));
clearTimeout(killer);
await browser.close();
process.exit(0);
