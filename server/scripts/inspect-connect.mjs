// Launch onboarded+unlocked MetaMask, open the local test dapp, click Connect, and
// capture the MetaMask connection popup's DOM so we can automate approving it.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_DIR = resolve(root, ".wallets", "metamask");
const PROFILE = resolve(root, ".wallets", "profile");
const SHOTS = resolve(root, ".wallets", "connect");
const PASSWORD = process.env.TEST_WALLET_PASSWORD || "TestPilot123!";
const DAPP = process.env.DAPP_URL || "http://localhost:5301/testdapp";
import { mkdirSync } from "node:fs";
mkdirSync(SHOTS, { recursive: true });

const killer = setTimeout(() => process.exit(2), 70000);
const sel = (t) => `[data-testid="${t}"]`;

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

// unlock, keep this page open (MV3 keep-alive)
const home = await browser.newPage();
await home.goto(`chrome-extension://${id}/home.html`, {
  waitUntil: "domcontentloaded",
  timeout: 20000,
});
await new Promise((r) => setTimeout(r, 2500));
if (await home.$(sel("unlock-password"))) {
  await home.type(sel("unlock-password"), PASSWORD, { delay: 10 });
  await new Promise((r) => setTimeout(r, 300));
  await home.evaluate((s) => document.querySelector(s)?.click(), sel("unlock-submit"));
  await home.waitForSelector(sel("unlock-password"), { hidden: true, timeout: 12000 }).catch(() => {});
}
await home.waitForSelector(sel("passkey-maybe-later-button"), { timeout: 4000 })
  .then(() => home.evaluate((s) => document.querySelector(s)?.click(), sel("passkey-maybe-later-button")))
  .catch(() => {});
await new Promise((r) => setTimeout(r, 1500));

// open the dapp and click Connect
const dapp = await browser.newPage();
await dapp.goto(DAPP, { waitUntil: "domcontentloaded", timeout: 20000 });
await new Promise((r) => setTimeout(r, 1500));
const provider = await dapp.$eval("#status", (el) => el.textContent).catch(() => "?");
await dapp.evaluate(() => document.getElementById("connect").click());

// wait for the MetaMask notification popup
const popupTarget = await browser
  .waitForTarget((t) => t.type() === "page" && t.url().includes("notification.html"), {
    timeout: 15000,
  })
  .catch(() => null);

const out = { id, provider };
if (popupTarget) {
  const popup = await popupTarget.page();
  await new Promise((r) => setTimeout(r, 2000));
  await popup.screenshot({ path: resolve(SHOTS, "popup.png") });
  out.popupUrl = popup.url();
  out.els = await popup.evaluate(() =>
    [...document.querySelectorAll("[data-testid], button")]
      .map((el) => ({
        testid: el.getAttribute("data-testid"),
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || "").trim().slice(0, 30),
        disabled: el.disabled ?? null,
      }))
      .filter((x) => x.testid || x.text),
  );
} else {
  out.popup = "not found";
}
writeFileSync(resolve(SHOTS, "connect-dump.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ provider, popup: !!popupTarget, url: out.popupUrl }));

clearTimeout(killer);
await browser.close();
process.exit(0);
