// Downloads the latest MetaMask Chrome build and unpacks it to .wallets/metamask
// so Chrome for Testing can load it via --load-extension.
// Usage: node scripts/setup-wallet.mjs  (or: pnpm setup:wallet)
import { execSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const walletsDir = resolve(root, ".wallets");
const outDir = resolve(walletsDir, "metamask");
const zip = resolve(walletsDir, "metamask.zip");

mkdirSync(walletsDir, { recursive: true });

console.log("Resolving latest MetaMask Chrome release…");
const api = execSync(
  "curl -sSL https://api.github.com/repos/MetaMask/metamask-extension/releases/latest",
  { encoding: "utf8" },
);
const assets = JSON.parse(api).assets ?? [];
// Prefer the plain chrome asset; fall back to any metamask-chrome-*.zip.
const asset =
  assets.find((a) => /^metamask-chrome-[\d.]+\.zip$/.test(a.name)) ??
  assets.find((a) => a.name.startsWith("metamask-chrome-") && a.name.endsWith(".zip"));
if (!asset) throw new Error("No metamask-chrome-*.zip asset in latest release");

console.log(`Downloading ${asset.name}…`);
execSync(`curl -sSL "${asset.browser_download_url}" -o "${zip}"`, {
  stdio: "inherit",
});

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
execSync(`unzip -q -o "${zip}" -d "${outDir}"`);
rmSync(zip, { force: true });

console.log(`MetaMask unpacked to ${outDir}`);
