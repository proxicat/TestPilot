// Connect the onboarded MetaMask to the REAL Uniswap app (headed, no model needed).
// Stages: load Uniswap → click Connect → pick MetaMask → approver handles popup →
// assert Uniswap shows the connected account. Screenshots + dumps at each stage.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_DIR = resolve(root, ".wallets", "metamask");
const PROFILE = resolve(root, ".wallets", "profile");
const SHOTS = resolve(root, ".wallets", "uniswap");
const PASSWORD = process.env.TEST_WALLET_PASSWORD || "TestPilot123!";
const DAPP_URL = process.env.UNISWAP_URL || "https://app.uniswap.org/swap";
mkdirSync(SHOTS, { recursive: true });

const ACCOUNT = "0xf39f"; // lowercased prefix of the test account
const DO_SWAP = process.env.NO_SWAP !== "1";
const killer = setTimeout(() => process.exit(2), 200000);
const sel = (t) => `[data-testid="${t}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const rec = (o) => { log.push(o); writeFileSync(resolve(SHOTS, "log.json"), JSON.stringify(log, null, 2)); };

// ---- background MetaMask popup approver (connect/sign) ----
const APPROVE_IDS = ["confirm-btn", "confirm-footer-button", "page-container-footer-confirm", "page-container-footer-next"];
const APPROVE_TXT = ["连接", "Connect", "确认", "Confirm", "签名", "Sign", "批准", "Approve", "下一步", "Next", "切换网络", "Switch network", "切换", "添加网络", "Add network", "允许", "Allow"];
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

const dump = async (page, label) => {
  const els = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid], button, [role=button], a")]
      .map((el) => ({ testid: el.getAttribute("data-testid"), text: (el.innerText || "").trim().slice(0, 30) }))
      .filter((x) => (x.testid || x.text) && x.text !== ""),
  ).catch(() => []);
  writeFileSync(resolve(SHOTS, `${label}.json`), JSON.stringify(els, null, 2));
  await page.screenshot({ path: resolve(SHOTS, `${label}.png`) }).catch(() => {});
  return els;
};
// click first element matching any of the given (case-insensitive) texts or testids
const clickAny = (page, { texts = [], testids = [] }) =>
  page.evaluate((texts, testids) => {
    for (const id of testids) { const el = document.querySelector(`[data-testid="${id}"]`); if (el) { el.click(); return "testid:" + id; } }
    const all = [...document.querySelectorAll("button, [role=button], a, [data-testid]")];
    const el = all.find((e) => texts.some((t) => (e.innerText || "").trim().toLowerCase().includes(t.toLowerCase())));
    if (el) { el.click(); return "text:" + el.innerText.trim().slice(0, 20); }
    return null;
  }, texts, testids);

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
rec({ stage: "unlocked" });

approver(browser);

// open Uniswap
const dapp = await browser.newPage();
await dapp.setViewport({ width: 1280, height: 800 });
await dapp.goto(DAPP_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
await sleep(4000);
await dump(dapp, "01-loaded");

// accept any ToS / cookie gate
await clickAny(dapp, { texts: ["I agree", "Accept", "Agree", "同意", "Got it"] }).catch(() => {});
await sleep(1000);

// click Connect / Get started
const c1 = await clickAny(dapp, { testids: ["navbar-connect-wallet", "connect-wallet-button"], texts: ["Connect", "Get started", "连接钱包", "连接"] });
rec({ stage: "click-connect", clicked: c1 });
await sleep(2500);
const modal = await dump(dapp, "02-connect-modal");

// pick MetaMask: the option rows live inside option-grid without their own testids,
// so find the SMALLEST element mentioning MetaMask and click its clickable ancestor.
const c2 = await dapp.evaluate(() => {
  const grid = document.querySelector('[data-testid="option-grid"]') || document.body;
  const cands = [...grid.querySelectorAll("*")].filter((e) =>
    /MetaMask/i.test(e.textContent || ""),
  );
  if (!cands.length) return null;
  cands.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
  const target = cands[0].closest("button, [role=button], a") || cands[0];
  target.click();
  return (target.textContent || "").trim().slice(0, 25);
});
rec({ stage: "pick-metamask", clicked: c2, modalCount: modal.length });
await sleep(4000);
await dump(dapp, "03-after-pick");

// wait for connection: Uniswap header shows the account (0xf39f…) or an account button
let connected = "no";
for (let i = 0; i < 30; i += 1) {
  const txt = await dapp.evaluate(() => document.body.innerText.toLowerCase()).catch(() => "");
  if (txt.includes(ACCOUNT) || txt.includes("0xf39f")) { connected = "account-visible"; break; }
  await sleep(1000);
}
rec({ stage: "connected", connected });
await dump(dapp, "04-connected");

let chainId = "n/a";
let swapState = "skipped";
if (connected === "account-visible" && DO_SWAP) {
  // dismiss any post-connect modal (e.g. the Solana upsell): click Skip / close
  await clickAny(dapp, { texts: ["跳过", "Skip", "关闭", "Close", "以后"] }).catch(() => {});
  await sleep(1200);

  // Switch the wallet to Sepolia (add it if MetaMask doesn't have it). The switch/add
  // triggers a MetaMask popup that the background approver confirms.
  chainId = await dapp.evaluate(async () => {
    const SEPOLIA = {
      chainId: "0xaa36a7",
      chainName: "Sepolia",
      nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
      blockExplorerUrls: ["https://sepolia.etherscan.io"],
    };
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] });
    } catch (e) {
      if (e.code === 4902) {
        try { await window.ethereum.request({ method: "wallet_addEthereumChain", params: [SEPOLIA] }); }
        catch (e2) { return "add-error:" + (e2.code || "") + ":" + (e2.message || "").slice(0, 40); }
      } else {
        return "switch-error:" + (e.code || "") + ":" + (e.message || "").slice(0, 40);
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
    return await window.ethereum.request({ method: "eth_chainId" });
  }).catch((e) => "eval-error:" + e.message);
  rec({ stage: "switch-sepolia", chainId });
  await sleep(4000);
  await dump(dapp, "05-after-switch");

  // check the account's Sepolia balance (a swap-to-confirm needs funds)
  const balance = await dapp.evaluate(async () => {
    try {
      const a = await window.ethereum.request({ method: "eth_accounts" });
      return await window.ethereum.request({ method: "eth_getBalance", params: [a[0], "latest"] });
    } catch (e) { return "bal-error:" + e.message; }
  }).catch(() => "?");
  const funded = /^0x0*$/.test(balance) === false && balance.startsWith("0x");
  rec({ stage: "balance", balance, funded });

  // Drive the swap UI: pick an output token, enter an amount.
  await clickAny(dapp, { testids: ["choose-output-token", "choose-output-token-label"], texts: ["选择代币", "Select token"] }).catch(() => {});
  await sleep(2500);
  await dump(dapp, "06-token-list");
  // Prefer a Sepolia (chainId 11155111) token so the swap stays on the testnet.
  const pickedToken = await dapp.evaluate(() => {
    const all = [...document.querySelectorAll('[data-testid^="token-option-"]')];
    const sepolia = all.filter((e) => (e.getAttribute("data-testid") || "").startsWith("token-option-11155111-"));
    const pick =
      sepolia.find((e) => /USDC|WETH|UNI|DAI/i.test(e.getAttribute("data-testid") || "")) ||
      sepolia[0] ||
      all.find((e) => /-(USDC|WETH)$/i.test(e.getAttribute("data-testid") || ""));
    if (pick) { pick.click(); return pick.getAttribute("data-testid"); }
    return null;
  }).catch(() => null);
  rec({ stage: "pick-token", pickedToken });
  await sleep(2500);

  // enter an amount into the sell (input) field
  const typedAmount = await dapp.evaluate(() => {
    const input = document.querySelector('[data-testid="amount-input-in"], input[inputmode="decimal"], #swap-currency-input input');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "0.001");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return false;
  }).catch(() => false);
  rec({ stage: "enter-amount", typedAmount });
  await sleep(3000);
  await dump(dapp, "07-swap-ready");

  // read the primary swap button state (Review / Insufficient balance / Swap)
  swapState = await dapp.evaluate(() => {
    const btn = document.querySelector('[data-testid="review-swap"], [data-testid="swap-button"]');
    return btn ? (btn.innerText || "").trim() : "no-swap-button";
  }).catch(() => "?");
  rec({ stage: "swap-state", swapState });

  // if fundable and a review/swap is offered, click it and let the approver confirm the tx
  if (/审核|Review|Swap|交换/.test(swapState)) {
    await clickAny(dapp, { testids: ["review-swap", "swap-button"], texts: ["审核", "Review", "Swap", "交换"] }).catch(() => {});
    await sleep(3000);
    await dump(dapp, "08-review");
    await clickAny(dapp, { testids: ["confirm-swap-button", "swap-modal-confirm"], texts: ["确认交换", "Confirm swap", "Confirm", "确认"] }).catch(() => {});
    await sleep(4000);
    await dump(dapp, "09-confirm");
  }
}

rec({ stage: "done", connected, chainId, swapState });
console.log(JSON.stringify({ connected, chainId, swapState }));
approving = false;
clearTimeout(killer);
await browser.close();
process.exit(0);
