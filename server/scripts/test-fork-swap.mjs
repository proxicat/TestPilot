// Real Uniswap ETH->USDC swap on an Anvil mainnet FORK, headless, no MetaMask.
// We inject an EIP-1193 + EIP-6963 provider that reports chainId 1 and proxies RPC to the
// fork; signing/sending happens in Node with our controllable key. Uniswap sees "MetaMask",
// connects, quotes against real mainnet liquidity, and the swap tx mines on the fork.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer";
import { Wallet, JsonRpcProvider, getBytes } from "ethers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = resolve(root, ".wallets", "forkswap");
const ANVIL = "http://127.0.0.1:8545";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // mainnet USDC
const SEED = readFileSync(resolve(root, ".wallets", "seed.txt"), "utf8").trim();
const AMOUNT = process.env.SWAP_AMOUNT || "0.01";
mkdirSync(SHOTS, { recursive: true });

const provider = new JsonRpcProvider(ANVIL, 1);
const wallet = Wallet.fromPhrase(SEED).connect(provider);
const ADDRESS = wallet.address;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const rec = (o) => { log.push(o); writeFileSync(resolve(SHOTS, "log.json"), JSON.stringify(log, null, 2)); };
const killer = setTimeout(() => process.exit(2), 150000);

// USDC.balanceOf(ADDRESS)
const usdcBalance = async () => {
  const data = "0x70a08231" + ADDRESS.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const r = await provider.send("eth_call", [{ to: USDC, data }, "latest"]);
  return (typeof r === "string" && r.startsWith("0x")) ? BigInt(r) : 0n;
};

// Node-side RPC handler the injected page provider calls. Signs with our key; else proxies.
const forkRpc = async (method, params = []) => {
  try {
    if (method === "eth_sendTransaction") {
      const t = params[0] || {};
      const sent = await wallet.sendTransaction({
        to: t.to,
        data: t.data,
        value: t.value ? BigInt(t.value) : 0n,
        ...(t.gas ? { gasLimit: BigInt(t.gas) } : {}),
      });
      rec({ ev: "tx-sent", hash: sent.hash, to: t.to, value: t.value });
      return sent.hash;
    }
    if (method === "personal_sign") return await wallet.signMessage(getBytes(params[0]));
    if (method === "eth_sign") return await wallet.signMessage(getBytes(params[1]));
    if (method === "eth_signTypedData_v4" || method === "eth_signTypedData") {
      const typed = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
      const types = { ...typed.types }; delete types.EIP712Domain;
      return await wallet.signTypedData(typed.domain, types, typed.message);
    }
    return await provider.send(method, params);
  } catch (e) {
    rec({ ev: "rpc-error", method, error: String(e).slice(0, 120) });
    throw new Error(e.shortMessage || e.message || String(e));
  }
};

// Injected into every page BEFORE its scripts: an EIP-1193 provider announced via EIP-6963.
function injectProvider(address) {
  const listeners = {};
  const emit = (e, ...a) => (listeners[e] || []).forEach((cb) => { try { cb(...a); } catch {} });
  const eth = {
    isMetaMask: true,
    _metamask: { isUnlocked: async () => true },
    selectedAddress: address,
    chainId: "0x1",
    networkVersion: "1",
    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts": return [address];
        case "eth_chainId": return "0x1";
        case "net_version": return "1";
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain": return null;
        case "wallet_requestPermissions":
        case "wallet_getPermissions": return [{ parentCapability: "eth_accounts" }];
        case "wallet_getCapabilities": return {};
        case "wallet_watchAsset": return true;
        default: return await window.__forkRpc(method, params || []);
      }
    },
    on(e, cb) { (listeners[e] = listeners[e] || []).push(cb); return this; },
    removeListener(e, cb) { listeners[e] = (listeners[e] || []).filter((x) => x !== cb); return this; },
    async enable() { return [address]; },
  };
  window.ethereum = eth;
  setTimeout(() => emit("connect", { chainId: "0x1" }), 0);
  const info = { uuid: "11111111-1111-1111-1111-111111111111", name: "MetaMask", icon: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", rdns: "io.metamask" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider: eth }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}

const dump = async (page, label) => {
  const els = await page.evaluate(() => [...document.querySelectorAll("[data-testid], button")].map((el) => ({ testid: el.getAttribute("data-testid"), text: (el.innerText || "").trim().slice(0, 28) })).filter((x) => x.testid || x.text)).catch(() => []);
  writeFileSync(resolve(SHOTS, `${label}.json`), JSON.stringify(els, null, 2));
  await page.screenshot({ path: resolve(SHOTS, `${label}.png`) }).catch(() => {});
};
const clickAny = (page, { texts = [], testids = [] }) =>
  page.evaluate((texts, testids) => {
    for (const id of testids) { const el = document.querySelector(`[data-testid="${id}"]`); if (el && !el.disabled) { el.click(); return "testid:" + id; } }
    const el = [...document.querySelectorAll("button, [role=button], a, [data-testid]")].find((e) => !e.disabled && texts.some((t) => (e.innerText || "").trim().toLowerCase().includes(t.toLowerCase())));
    if (el) { el.click(); return "text:" + (el.innerText || "").trim().slice(0, 18); }
    return null;
  }, texts, testids);

rec({ stage: "start", address: ADDRESS });
const browser = await puppeteer.launch({
  headless: process.env.HEADLESS !== "0",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
await page.exposeFunction("__forkRpc", forkRpc);
await page.evaluateOnNewDocument(injectProvider, ADDRESS);

// Redirect Uniswap's own on-chain reads (JSON-RPC POSTs to Infura/Alchemy/its gateway) to
// our fork, so its UI sees the fork's balances/state — not real mainnet where we have 0.
const rpcHosts = new Set();
await page.setRequestInterception(true);
page.on("request", async (req) => {
  try {
    const pd = req.method() === "POST" ? req.postData() : null;
    if (pd && /"method"\s*:\s*"(eth_|net_|web3_|debug_|trace_|erigon_)/.test(pd)) {
      try { rpcHosts.add(new URL(req.url()).host); } catch {}
      const r = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: pd });
      const body = await r.text();
      await req.respond({ status: 200, contentType: "application/json", body });
      return;
    }
  } catch { /* fall through */ }
  try { await req.continue(); } catch {}
});

await page.goto("https://app.uniswap.org/swap", { waitUntil: "domcontentloaded", timeout: 45000 });
await sleep(5000);
await clickAny(page, { texts: ["I agree", "Accept", "同意", "Got it"] }).catch(() => {});
await sleep(1000);
await dump(page, "01-loaded");

// connect: open modal, pick MetaMask (our injected provider)
await clickAny(page, { testids: ["navbar-connect-wallet"], texts: ["Connect", "连接"] }).catch(() => {});
await sleep(2500);
await dump(page, "02-connect-modal");
await page.evaluate(() => {
  const grid = document.querySelector('[data-testid="option-grid"]') || document.body;
  const c = [...grid.querySelectorAll("*")].filter((e) => /MetaMask/i.test(e.textContent || ""));
  c.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
  (c[0]?.closest("button,[role=button],a") || c[0])?.click();
}).catch(() => {});
let connected = "no";
for (let i = 0; i < 25; i += 1) { const t = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => ""); if (t.includes("0x6765") || t.includes("test0")) { connected = "yes"; break; } await sleep(1000); }
rec({ stage: "connect", connected });
await clickAny(page, { texts: ["跳过", "Skip", "关闭"] }).catch(() => {});
await sleep(1500);
await dump(page, "03-connected");

const usdcBefore = await usdcBalance();
rec({ stage: "usdc-before", usdcBefore: usdcBefore.toString() });

// select output USDC
await clickAny(page, { testids: ["choose-output-token", "choose-output-token-label"], texts: ["选择代币", "Select token"] }).catch(() => {});
await sleep(2000);
await page.evaluate(() => { const s = document.querySelector('input[placeholder]'); if (s) { s.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; setter.call(s, "USDC"); s.dispatchEvent(new Event("input", { bubbles: true })); } }).catch(() => {});
await sleep(2000);
const picked = await page.evaluate(() => {
  const all = [...document.querySelectorAll('[data-testid^="token-option-"]')];
  const el = all.find((e) => (e.getAttribute("data-testid") || "") === "token-option-1-USDC") || all.find((e) => /-1-USDC$/.test(e.getAttribute("data-testid") || "")) || all.find((e) => /USDC/i.test(e.innerText || ""));
  if (el) { el.click(); return el.getAttribute("data-testid"); }
  return null;
}).catch(() => null);
rec({ stage: "pick-usdc", picked });
await sleep(2500);

// enter amount
const typed = await page.evaluate((amt) => { const i = document.querySelector('[data-testid="amount-input-in"], input[inputmode="decimal"]'); if (!i) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; setter.call(i, amt); i.dispatchEvent(new Event("input", { bubbles: true })); return true; }, AMOUNT).catch(() => false);
rec({ stage: "amount", typed, amount: AMOUNT });
await sleep(4000);
await dump(page, "04-quote");

// review -> confirm (drives eth_sendTransaction -> forkRpc -> mines on fork)
const primary = await page.evaluate(() => { const b = document.querySelector('[data-testid="review-swap"], [data-testid="swap-button"]'); return b ? (b.innerText || "").trim() : "no-button"; }).catch(() => "?");
rec({ stage: "primary", primary });
await clickAny(page, { testids: ["review-swap", "swap-button"], texts: ["审核", "Review", "交换", "Swap"] }).catch(() => {});
await sleep(3000);
await dump(page, "05-review");
await clickAny(page, { testids: ["confirm-swap-button", "swap-modal-confirm"], texts: ["确认交换", "Confirm swap", "确认", "Confirm"] }).catch(() => {});
await sleep(5000);
await dump(page, "06-after-confirm");

// verify: USDC balance rose
let usdcAfter = usdcBefore;
for (let i = 0; i < 24; i += 1) { usdcAfter = await usdcBalance(); if (usdcAfter > usdcBefore) break; await sleep(2500); }
const delta = usdcAfter - usdcBefore;
rec({ stage: "verify", usdcBefore: usdcBefore.toString(), usdcAfter: usdcAfter.toString(), usdcDelta: delta.toString(), usdcDeltaHuman: (Number(delta) / 1e6).toFixed(6) });
await dump(page, "07-final");

rec({ stage: "rpc-hosts-redirected", hosts: [...rpcHosts] });
console.log(JSON.stringify({ address: ADDRESS, connected, picked, primary, usdcDelta: delta.toString(), usdcReceived: (Number(delta) / 1e6).toFixed(6), rpcHosts: [...rpcHosts] }));
clearTimeout(killer);
await browser.close();
process.exit(0);
