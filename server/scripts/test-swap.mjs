// Drive a REAL Uniswap transaction on Sepolia with our controllable, funded wallet.
// ETH -> WETH is a "wrap" (WETH.deposit()) — needs no pool/liquidity, so it reliably
// executes on Sepolia. Flow: connect -> switch Sepolia -> select WETH -> enter amount ->
// click Wrap/Review -> approver confirms the MetaMask tx popup -> verify WETH balance rose.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_DIR = resolve(root, ".wallets", "metamask");
const PROFILE = resolve(root, ".wallets", "profile");
const SHOTS = resolve(root, ".wallets", "swap");
const PASSWORD = process.env.TEST_WALLET_PASSWORD || "TestPilot123!";
const DAPP_URL = process.env.UNISWAP_URL || "https://app.uniswap.org/swap?chain=sepolia";
const RPC = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"; // canonical Sepolia WETH
const ACCOUNT = readFileSync(resolve(root, ".wallets", "account.txt"), "utf8").trim();
const AMOUNT = process.env.SWAP_AMOUNT || "0.001";
mkdirSync(SHOTS, { recursive: true });

const sel = (t) => `[data-testid="${t}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const rec = (o) => { log.push(o); writeFileSync(resolve(SHOTS, "log.json"), JSON.stringify(log, null, 2)); };
const killer = setTimeout(() => process.exit(2), 170000);

const rpc = async (method, params = []) => {
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return (await r.json()).result;
  } catch (e) { return "rpc-error:" + e.message; }
};
// WETH.balanceOf(account) via eth_call (selector 0x70a08231)
const wethBalance = async () => {
  const data = "0x70a08231" + ACCOUNT.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const r = await rpc("eth_call", [{ to: WETH, data }, "latest"]);
  return (typeof r === "string" && r.startsWith("0x")) ? BigInt(r) : 0n;
};

const APPROVE_IDS = ["confirm-btn", "confirm-footer-button", "page-container-footer-confirm", "page-container-footer-next"];
const APPROVE_TXT = ["连接", "Connect", "确认", "Confirm", "批准", "Approve", "允许", "Allow", "下一步", "Next", "切换网络", "Switch network", "添加", "Add", "签名", "Sign"];
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
const clickAny = (page, { texts = [], testids = [] }) =>
  page.evaluate((texts, testids) => {
    for (const id of testids) { const el = document.querySelector(`[data-testid="${id}"]`); if (el && !el.disabled) { el.click(); return "testid:" + id; } }
    const el = [...document.querySelectorAll("button, [role=button], a, [data-testid]")].find((e) => !e.disabled && texts.some((t) => (e.innerText || "").trim().toLowerCase().includes(t.toLowerCase())));
    if (el) { el.click(); return "text:" + (el.innerText || "").trim().slice(0, 18); }
    return null;
  }, texts, testids);

const browser = await puppeteer.launch({
  headless: process.env.HEADLESS === "1",
  args: ["--no-sandbox", "--disable-setuid-sandbox", `--disable-extensions-except=${WALLET_DIR}`, `--load-extension=${WALLET_DIR}`],
  userDataDir: PROFILE,
  ignoreDefaultArgs: ["--disable-extensions"],
});
const swt = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 15000 });
const id = new URL(swt.url()).host;

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
await dapp.setViewport({ width: 1280, height: 800 });
await dapp.goto(DAPP_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
await sleep(4000);
await clickAny(dapp, { texts: ["I agree", "Accept", "同意", "Got it"] }).catch(() => {});
await sleep(800);

// connect (auto if profile already permitted)
await clickAny(dapp, { testids: ["navbar-connect-wallet"], texts: ["Connect", "连接"] }).catch(() => {});
await sleep(2500);
await dapp.evaluate(() => {
  const grid = document.querySelector('[data-testid="option-grid"]');
  if (!grid) return;
  const c = [...grid.querySelectorAll("*")].filter((e) => /MetaMask/i.test(e.textContent || ""));
  c.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
  (c[0]?.closest("button,[role=button],a") || c[0])?.click();
}).catch(() => {});
for (let i = 0; i < 20; i += 1) { const t = await dapp.evaluate(() => document.body.innerText.toLowerCase()).catch(() => ""); if (t.includes("0x6765") || t.includes("test0")) break; await sleep(1000); }
rec({ stage: "connected" });
await clickAny(dapp, { texts: ["跳过", "Skip", "关闭"] }).catch(() => {});
await sleep(1000);

// switch to Sepolia
const chainId = await dapp.evaluate(async () => {
  try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] }); }
  catch (e) { return "switch-error:" + (e.code || ""); }
  await new Promise((r) => setTimeout(r, 1500));
  return await window.ethereum.request({ method: "eth_chainId" });
}).catch((e) => "eval-error:" + e.message);
rec({ stage: "switch-sepolia", chainId });
await sleep(3500);

const wethBefore = await wethBalance();
rec({ stage: "weth-before", wethBefore: wethBefore.toString() });

// select output token = WETH (Sepolia). Open selector, search WETH, pick the Sepolia one.
await clickAny(dapp, { testids: ["choose-output-token", "choose-output-token-label"], texts: ["选择代币", "Select token"] }).catch(() => {});
await sleep(2000);
await dapp.evaluate(() => {
  const s = document.querySelector('input[placeholder]');
  if (s) { s.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; setter.call(s, "WETH"); s.dispatchEvent(new Event("input", { bubbles: true })); }
}).catch(() => {});
await sleep(2000);
await dump(dapp, "01-token-search");
const pickedToken = await dapp.evaluate(() => {
  const all = [...document.querySelectorAll('[data-testid^="token-option-"]')];
  const sep = all.find((e) => (e.getAttribute("data-testid") || "").startsWith("token-option-11155111-WETH"))
    || all.find((e) => (e.getAttribute("data-testid") || "").includes("11155111"))
    || all.find((e) => /WETH/i.test(e.innerText || ""));
  if (sep) { sep.click(); return sep.getAttribute("data-testid"); }
  return null;
}).catch(() => null);
rec({ stage: "pick-token", pickedToken });
await sleep(2500);

// enter amount into the input field
const typed = await dapp.evaluate((amt) => {
  const input = document.querySelector('[data-testid="amount-input-in"], input[inputmode="decimal"]');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, amt); input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}, AMOUNT).catch(() => false);
rec({ stage: "enter-amount", typed, amount: AMOUNT });
await sleep(3500);
await dump(dapp, "02-ready");

// read + click the primary action (Wrap / Review / Swap)
const primary = await dapp.evaluate(() => {
  const btn = document.querySelector('[data-testid="review-swap"], [data-testid="wrap-button"], [data-testid="swap-button"]');
  return btn ? (btn.innerText || "").trim() : "no-button";
}).catch(() => "?");
rec({ stage: "primary-button", primary });

await clickAny(dapp, { testids: ["review-swap", "wrap-button", "swap-button"], texts: ["包装", "Wrap", "审核", "Review", "交换", "Swap"] }).catch(() => {});
await sleep(2500);
await dump(dapp, "03-after-primary");
// a swap (not wrap) shows a review modal with a confirm button
await clickAny(dapp, { testids: ["confirm-swap-button", "swap-modal-confirm"], texts: ["确认交换", "Confirm swap", "确认", "Confirm"] }).catch(() => {});
await sleep(3000);
await dump(dapp, "04-after-confirm");

// the approver confirms the MetaMask tx popup; wait and verify WETH balance rose
let mined = false;
let wethAfter = wethBefore;
for (let i = 0; i < 24; i += 1) {
  wethAfter = await wethBalance();
  if (wethAfter > wethBefore) { mined = true; break; }
  await sleep(3000);
}
rec({ stage: "verify", wethBefore: wethBefore.toString(), wethAfter: wethAfter.toString(), deltaWei: (wethAfter - wethBefore).toString(), mined });
await dump(dapp, "05-final");

console.log(JSON.stringify({ chainId, pickedToken, primary, mined, deltaWethWei: (wethAfter - wethBefore).toString() }));
approving = false;
clearTimeout(killer);
await browser.close();
process.exit(0);

// helper defined after use is fine for function declarations, but this is const — define at top-level
async function dump(page, label) {
  const els = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid], button")].map((el) => ({ testid: el.getAttribute("data-testid"), text: (el.innerText || "").trim().slice(0, 28) })).filter((x) => x.testid || x.text),
  ).catch(() => []);
  writeFileSync(resolve(SHOTS, `${label}.json`), JSON.stringify(els, null, 2));
  await page.screenshot({ path: resolve(SHOTS, `${label}.png`) }).catch(() => {});
}
