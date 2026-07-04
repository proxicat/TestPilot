// Walk MetaMask onboarding by clicking a sequence of testids (CLI args), writing the
// DOM after each step to .wallets/onboarding-dump.json (readable even if it hangs).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET_DIR = resolve(root, ".wallets", "metamask");
const OUT = resolve(root, ".wallets", "onboarding-dump.json");
const steps = process.argv.slice(2);
const results = [];
const save = () => writeFileSync(OUT, JSON.stringify(results, null, 2));

// hard safety: never hang the harness
const killer = setTimeout(() => {
  results.push({ note: "TIMEOUT — force exit" });
  save();
  process.exit(2);
}, 55000);

const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    `--disable-extensions-except=${WALLET_DIR}`,
    `--load-extension=${WALLET_DIR}`,
  ],
  userDataDir: mkdtempSync(join(tmpdir(), "mm-inspect-")),
  ignoreDefaultArgs: ["--disable-extensions"],
});

const sw = await browser.waitForTarget(
  (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
  { timeout: 15000 },
);
const id = new URL(sw.url()).host;
results.push({ step: "launched", extensionId: id });
save();

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(`chrome-extension://${id}/home.html#onboarding/welcome`, {
  waitUntil: "domcontentloaded",
  timeout: 25000,
});
await new Promise((r) => setTimeout(r, 3000));

const grab = async (label) => {
  const els = await page.evaluate(() =>
    [...document.querySelectorAll("[data-testid], button, input, a[role=button]")]
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        testid: el.getAttribute("data-testid"),
        type: el.getAttribute("type"),
        text: (el.innerText || el.value || "").trim().slice(0, 45),
      }))
      .filter((e) => e.testid || e.text || e.type),
  );
  results.push({ step: label, hash: await page.evaluate(() => location.hash), els });
  save();
};

await grab("welcome");
for (const testid of steps) {
  const sel = `[data-testid="${testid}"]`;
  try {
    await page.waitForSelector(sel, { timeout: 8000 });
    await page.evaluate((s) => document.querySelector(s)?.click(), sel);
    await new Promise((r) => setTimeout(r, 2000));
    await grab(`after:${testid}`);
  } catch (e) {
    results.push({ step: `missing:${testid}`, error: e.message });
    await grab(`state-when-missing:${testid}`);
    break;
  }
}

clearTimeout(killer);
await browser.close();
process.exit(0);
