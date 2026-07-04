// Put our CONTROLLABLE wallet (scripts/gen-wallet.mjs) on the REAL Sepolia testnet:
// connect → switch to Sepolia → report chainId + balance → if funded, send a real tx
// (approver confirms the popup) and verify via a public Sepolia RPC.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_DIR = resolve(root, ".wallets", "metamask");
const PROFILE = resolve(root, ".wallets", "profile");
const SHOTS = resolve(root, ".wallets", "sepolia");
const PASSWORD = process.env.TEST_WALLET_PASSWORD || "TestPilot123!";
const DAPP = "http://localhost:5301/testdapp";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const ACCOUNT = readFileSync(resolve(root, ".wallets", "account.txt"), "utf8").trim();
mkdirSync(SHOTS, { recursive: true });

const sel = (t) => `[data-testid="${t}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const rec = (o) => { log.push(o); writeFileSync(resolve(SHOTS, "log.json"), JSON.stringify(log, null, 2)); };
const rpc = async (method, params = []) => {
  try {
    const r = await fetch(SEPOLIA_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return (await r.json()).result;
  } catch (e) { return "rpc-error:" + e.message; }
};
const fmtEth = (wei) => (typeof wei === "string" && wei.startsWith("0x")) ? (Number(BigInt(wei)) / 1e18).toFixed(6) : wei;

const killer = setTimeout(() => process.exit(2), 90000);

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
const swt = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 15000 });
const id = new URL(swt.url()).host;

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

// connect
await dapp.evaluate(() => document.getElementById("connect").click());
const connect = await waitStatus((s) => s.startsWith("connected:") || s.startsWith("connect-error:"), 30000);
rec({ stage: "connect", connect });

// switch to real Sepolia (built-in; add with a public RPC on 4902)
const chainId = await dapp.evaluate(async () => {
  const SEPOLIA = { chainId: "0xaa36a7", chainName: "Sepolia", nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"], blockExplorerUrls: ["https://sepolia.etherscan.io"] };
  try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] }); }
  catch (e) { if (e.code === 4902) { try { await window.ethereum.request({ method: "wallet_addEthereumChain", params: [SEPOLIA] }); } catch (e2) { return "add-error:" + (e2.code || ""); } } else return "switch-error:" + (e.code || ""); }
  await new Promise((r) => setTimeout(r, 1500));
  return await window.ethereum.request({ method: "eth_chainId" });
}).catch((e) => "eval-error:" + e.message);
rec({ stage: "switch-sepolia", chainId });
await sleep(3000);
await dapp.screenshot({ path: resolve(SHOTS, "on-sepolia.png") }).catch(() => {});

// balance on real Sepolia (independent public RPC + via the wallet)
const balChain = await rpc("eth_getBalance", [ACCOUNT, "latest"]);
rec({ stage: "balance", account: ACCOUNT, balanceWei: balChain, balanceEth: fmtEth(balChain) });

// if funded, send a real 0.001 ETH tx and verify
let tx = "skipped-no-funds";
let verify = null;
const funded = typeof balChain === "string" && balChain.startsWith("0x") && BigInt(balChain) > 2000000000000000n;
if (funded) {
  await dapp.evaluate(() => document.getElementById("sendtx").click());
  tx = await waitStatus((s) => s.startsWith("tx:") || s.startsWith("tx-error:"), 40000);
  rec({ stage: "send-tx", tx });
  if (tx.startsWith("tx:")) {
    const hash = tx.slice(3).trim();
    for (let i = 0; i < 30; i += 1) { const rcpt = await rpc("eth_getTransactionReceipt", [hash]); if (rcpt) { verify = { mined: true, status: rcpt.status, block: rcpt.blockNumber }; break; } await sleep(3000); }
    verify = verify || { mined: false };
  }
  rec({ stage: "verify", verify });
}

console.log(JSON.stringify({ connect, chainId, balanceEth: fmtEth(balChain), funded, tx, verify }));
approving = false;
clearTimeout(killer);
await browser.close();
process.exit(0);
