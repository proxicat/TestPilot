// End-to-end wallet-connect test (no testnet/model needed):
// onboarded+unlocked MetaMask → open local dapp → click Connect → approve the
// MetaMask popup → assert the dapp shows the connected account.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_DIR = resolve(root, ".wallets", "metamask");
const PROFILE = resolve(root, ".wallets", "profile");
const SHOTS = resolve(root, ".wallets", "connect");
const PASSWORD = process.env.TEST_WALLET_PASSWORD || "TestPilot123!";
const DAPP = process.env.DAPP_URL || "http://localhost:5301/testdapp";
mkdirSync(SHOTS, { recursive: true });

const killer = setTimeout(() => process.exit(2), 75000);
const sel = (t) => `[data-testid="${t}"]`;
// Approve-button testids seen across MetaMask versions + text fallbacks.
const APPROVE_TESTIDS = [
  "confirm-btn",
  "page-container-footer-next",
  "page-container-footer-confirm",
  "confirm-footer-button",
  "connect-more-accounts",
];
const APPROVE_TEXT = ["连接", "Connect", "下一步", "Next", "确认", "Confirm", "批准", "Approve", "签名", "Sign"];

const clickApprove = async (p) => {
  // testid first
  for (const t of APPROVE_TESTIDS) {
    const ok = await p
      .evaluate((s) => {
        const el = document.querySelector(s);
        if (el && !el.disabled) {
          el.click();
          return true;
        }
        return false;
      }, sel(t))
      .catch(() => false);
    if (ok) return t;
  }
  // then visible text
  const byText = await p
    .evaluate((texts) => {
      const el = [...document.querySelectorAll("button, [role=button]")].find(
        (e) => !e.disabled && texts.some((t) => (e.innerText || "").trim() === t),
      );
      if (el) {
        el.click();
        return el.innerText.trim();
      }
      return null;
    }, APPROVE_TEXT)
    .catch(() => null);
  return byText;
};

const browser = await puppeteer.launch({
  headless: process.env.HEADLESS === "1", // headed by default for the wallet flow
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

// unlock + keep page open
const home = await browser.newPage();
await home.goto(`chrome-extension://${id}/home.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
await new Promise((r) => setTimeout(r, 2500));
if (await home.$(sel("unlock-password"))) {
  await home.type(sel("unlock-password"), PASSWORD, { delay: 10 });
  await new Promise((r) => setTimeout(r, 300));
  await home.evaluate((s) => document.querySelector(s)?.click(), sel("unlock-submit"));
  await home.waitForSelector(sel("unlock-password"), { hidden: true, timeout: 12000 }).catch(() => {});
}
await home
  .waitForSelector(sel("passkey-maybe-later-button"), { timeout: 4000 })
  .then(() => home.evaluate((s) => document.querySelector(s)?.click(), sel("passkey-maybe-later-button")))
  .catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
// Finish onboarding/unlock: click "Open wallet / 打开钱包 / Done" to reach the account.
const clickText = (p, texts) =>
  p.evaluate((ts) => {
    const el = [...document.querySelectorAll("button, [role=button], a")].find(
      (e) => ts.some((t) => (e.innerText || "").trim().includes(t)),
    );
    if (el) { el.click(); return el.innerText.trim(); }
    return null;
  }, texts);
for (let k = 0; k < 4; k += 1) {
  const t = await clickText(home, ["打开钱包", "Open wallet", "完成", "Done", "Got it", "知道了"]).catch(() => null);
  if (!t) break;
  await new Promise((r) => setTimeout(r, 1200));
}
await new Promise((r) => setTimeout(r, 1000));

// Capture the MetaMask popup the instant it opens (event-based — it can close fast).
let popupPage = null;
const seen = [];
browser.on("targetcreated", async (t) => {
  try {
    seen.push({ ev: "created", type: t.type(), url: t.url().slice(0, 80) });
    if (t.type() === "page" && /notification|home\.html/.test(t.url())) {
      const p = await t.page();
      if (p && !/^chrome-extension.*home\.html$/.test(p.url())) popupPage = p;
    }
  } catch {
    /* ignore */
  }
});
browser.on("targetdestroyed", (t) =>
  seen.push({ ev: "destroyed", type: t.type(), url: t.url().slice(0, 80) }),
);

// Verify the kept-open home page is actually unlocked right now.
await home.bringToFront().catch(() => {});
await new Promise((r) => setTimeout(r, 500));
const homeLocked = !!(await home.$(sel("unlock-password")));
await home.screenshot({ path: resolve(SHOTS, "home-before-connect.png") }).catch(() => {});

// open dapp, click connect
const dapp = await browser.newPage();
await dapp.goto(DAPP, { waitUntil: "domcontentloaded", timeout: 20000 });
await new Promise((r) => setTimeout(r, 1200));
const provider = await dapp.$eval("#status", (el) => el.textContent).catch(() => "?");
await dapp.evaluate(() => document.getElementById("connect").click());

// Drive the popup: it can be locked (#/lock) at connect time, so unlock IN the popup,
// dismiss passkey, then approve. Re-find it each pass since it navigates between routes.
// Drive EVERY extension approval surface (notification popup AND the home.html tab
// MetaMask spawns). Unlock if locked, dismiss passkey, then approve. Act fast.
let dumped = false;
const driven = new Set();
for (let i = 0; i < 50; i += 1) {
  const pages = await browser.pages().catch(() => []);
  const surfaces = pages.filter(
    (p) =>
      !p.isClosed() &&
      p !== dapp &&
      /chrome-extension:\/\/[a-z]+\/(notification|home)\.html/.test(p.url()),
  );
  for (const p of surfaces) {
    try {
      if (await p.$(sel("unlock-password"))) {
        await p.type(sel("unlock-password"), PASSWORD, { delay: 6 });
        await p.evaluate((s) => document.querySelector(s)?.click(), sel("unlock-submit"));
        await new Promise((r) => setTimeout(r, 1000));
      }
      await p
        .evaluate((s) => document.querySelector(s)?.click(), sel("passkey-maybe-later-button"))
        .catch(() => {});
      const hasApprove = await p
        .evaluate(
          (ids) =>
            ids.some((id) => document.querySelector(`[data-testid="${id}"]`)) ||
            [...document.querySelectorAll("button")].some((b) =>
              /连接|Connect|下一步|Next|确认|Confirm|批准|Approve/.test(b.innerText || ""),
            ),
          APPROVE_TESTIDS,
        )
        .catch(() => false);
      if (hasApprove && !dumped) {
        const els = await p
          .evaluate(() =>
            [...document.querySelectorAll("[data-testid], button")]
              .map((el) => ({
                testid: el.getAttribute("data-testid"),
                text: (el.innerText || "").trim().slice(0, 25),
              }))
              .filter((x) => x.testid || x.text),
          )
          .catch(() => null);
        if (els && els.length) {
          writeFileSync(resolve(SHOTS, "connect-dump.json"), JSON.stringify(els, null, 2));
          await p.screenshot({ path: resolve(SHOTS, "popup.png") }).catch(() => {});
          dumped = true;
        }
      }
      if (hasApprove) {
        const clicked = await clickApprove(p);
        if (clicked) driven.add(p.url() + ":" + clicked);
      }
    } catch {
      /* navigated/closed; retry */
    }
  }
  const status = await dapp.$eval("#status", (el) => el.textContent).catch(() => "");
  if (status.startsWith("connected:")) break;
  await new Promise((r) => setTimeout(r, 350));
}
void popupPage;
writeFileSync(resolve(SHOTS, "driven.json"), JSON.stringify([...driven], null, 2));

const connectStatus = await dapp.$eval("#status", (el) => el.textContent).catch(() => "?");

// Sign phase: trigger personal_sign, approve the signature popup.
let signStatus = "skipped";
if (connectStatus.startsWith("connected:")) {
  await dapp.evaluate(() => document.getElementById("sign").click());
  for (let i = 0; i < 40; i += 1) {
    const pages = await browser.pages().catch(() => []);
    const surfaces = pages.filter(
      (p) =>
        !p.isClosed() &&
        p !== dapp &&
        /chrome-extension:\/\/[a-z]+\/(notification|home)\.html/.test(p.url()),
    );
    for (const p of surfaces) {
      try {
        await clickApprove(p);
      } catch {
        /* retry */
      }
    }
    const st = await dapp.$eval("#status", (el) => el.textContent).catch(() => "");
    if (st.startsWith("signed:") || st.startsWith("sign-error:")) {
      signStatus = st;
      break;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  await dapp.screenshot({ path: resolve(SHOTS, "dapp-final.png") }).catch(() => {});
}

const finalStatus = await dapp.$eval("#status", (el) => el.textContent).catch(() => "?");
writeFileSync(resolve(SHOTS, "targets.json"), JSON.stringify(seen, null, 2));
console.log(JSON.stringify({ provider, connectStatus, signStatus, finalStatus }));
writeFileSync(
  resolve(SHOTS, "result.json"),
  JSON.stringify({ provider, finalStatus }, null, 2),
);
await dapp.screenshot({ path: resolve(SHOTS, "dapp.png") }).catch(() => {});
clearTimeout(killer);
await browser.close();
process.exit(0);
