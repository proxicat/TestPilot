// End-to-end REAL transaction on our controllable local Anvil devnet (not Sepolia):
// onboarded fresh wallet → connect → add Anvil network → send 0.01 ETH → approver
// confirms the MetaMask tx popup → verify the tx mined on-chain (receipt + balance).
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_DIR = resolve(root, ".wallets", "metamask");
const PROFILE = resolve(root, ".wallets", "profile");
const SHOTS = resolve(root, ".wallets", "localtx");
const PASSWORD = process.env.TEST_WALLET_PASSWORD || "TestPilot123!";
const DAPP = "http://localhost:5301/testdapp";
const RPC = "http://127.0.0.1:8545";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const ACCOUNT = readFileSync(resolve(root, ".wallets", "account.txt"), "utf8").trim();
mkdirSync(SHOTS, { recursive: true });

const sel = (t) => `[data-testid="${t}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const rec = (o) => { log.push(o); writeFileSync(resolve(SHOTS, "log.json"), JSON.stringify(log, null, 2)); };
const rpc = async (method, params = []) => {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
};

const killer = setTimeout(() => process.exit(2), 90000);

// background MetaMask approver (connect / add-network / tx confirm)
const APPROVE_IDS = ["confirm-btn", "confirm-footer-button", "page-container-footer-confirm", "page-container-footer-next"];
const APPROVE_TXT = ["连接", "Connect", "确认", "Confirm", "批准", "Approve", "允许", "Allow", "下一步", "Next", "切换网络", "Switch network", "添加", "Add"];
let approving = true;
const approver = async (browser) => {
  while (approving) {
    try {
      for (const p of await browser.pages()) {
        if (p.isClosed() || !/chrome-extension:\/\/[a-z]+\/(notification|home)\.html/.test(p.url())) continue;
        if (await p.$(sel("unlock-password"))) {
          await p.type(sel("unlock-password"), PASSWORD, { delay: 6 });
          await p.evaluate((s) => document.querySelector(s)?.click(), sel("unlock-submit"));
          await sleep(900);
        }
        await p.evaluate((s) => document.querySelector(s)?.click(), sel("passkey-maybe-later-button")).catch(() => {});
        await p.evaluate((ids, txt) => {
          for (const id of ids) { const el = document.querySelector(`[data-testid="${id}"]`); if (el && !el.disabled) { el.click(); return; } }
          const el = [...document.querySelectorAll("button,[role=button]")].find((b) => !b.disabled && txt.some((t) => (b.innerText || "").trim() === t));
          el?.click();
        }, APPROVE_IDS, APPROVE_TXT).catch(() => {});
      }
    } catch { /* churn */ }
    await sleep(300);
  }
};

const browser = await puppeteer.launch({
  headless: process.env.HEADLESS === "1",
  args: ["--no-sandbox", "--disable-setuid-sandbox", `--disable-extensions-except=${WALLET_DIR}`, `--load-extension=${WALLET_DIR}`],
  userDataDir: PROFILE,
  ignoreDefaultArgs: ["--disable-extensions"],
});
const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 15000 });
const id = new URL(sw.url()).host;

// unlock + keep open
const home = await browser.newPage();
await home.goto(`chrome-extension://${id}/home.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
await sleep(2500);
if (await home.$(sel("unlock-password"))) {
  await home.type(sel("unlock-password"), PASSWORD, { delay: 10 });
  await home.evaluate((s) => document.querySelector(s)?.click(), sel("unlock-submit"));
  await home.waitForSelector(sel("unlock-password"), { hidden: true, timeout: 12000 }).catch(() => {});
}
await home.waitForSelector(sel("passkey-maybe-later-button"), { timeout: 4000 })
  .then(() => home.evaluate((s) => document.querySelector(s)?.click(), sel("passkey-maybe-later-button"))).catch(() => {});
await sleep(1500);
rec({ stage: "unlocked", account: ACCOUNT });
approver(browser);

const dapp = await browser.newPage();
await dapp.setViewport({ width: 900, height: 700 });
await dapp.goto(DAPP, { waitUntil: "domcontentloaded", timeout: 20000 });
await sleep(1200);

const waitStatus = async (pred, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await dapp.$eval("#status", (el) => el.textContent).catch(() => "");
    if (pred(s)) return s;
    await sleep(400);
  }
  return dapp.$eval("#status", (el) => el.textContent).catch(() => "?");
};

// 1) connect
await dapp.evaluate(() => document.getElementById("connect").click());
const connect = await waitStatus((s) => s.startsWith("connected:") || s.startsWith("connect-error:"), 30000);
rec({ stage: "connect", connect });

// 2) add + switch to Anvil Local
await dapp.evaluate(() => document.getElementById("addchain").click());
const chain = await waitStatus((s) => s.startsWith("chain:") || s.startsWith("chain-error:"), 30000);
rec({ stage: "add-chain", chain });
await sleep(1500);

// 3) send a real 0.01 ETH tx
const deadBefore = await rpc("eth_getBalance", [DEAD, "latest"]);
await dapp.evaluate(() => document.getElementById("sendtx").click());
const tx = await waitStatus((s) => s.startsWith("tx:") || s.startsWith("tx-error:"), 40000);
rec({ stage: "send-tx", tx });
await sleep(1500);
await dapp.screenshot({ path: resolve(SHOTS, "dapp.png") }).catch(() => {});

// 4) verify on-chain
let verify = { mined: false };
if (tx.startsWith("tx:")) {
  const hash = tx.slice(3).trim();
  const receipt = await rpc("eth_getTransactionReceipt", [hash]);
  const deadAfter = await rpc("eth_getBalance", [DEAD, "latest"]);
  verify = {
    mined: !!receipt,
    status: receipt?.status,
    blockNumber: receipt?.blockNumber,
    deadBefore, deadAfter,
    deltaWei: deadAfter && deadBefore ? (BigInt(deadAfter) - BigInt(deadBefore)).toString() : null,
  };
}
rec({ stage: "verify", verify });

console.log(JSON.stringify({ connect, chain, tx, verify }));
approving = false;
clearTimeout(killer);
await browser.close();
process.exit(0);
