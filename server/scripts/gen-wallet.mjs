// Generate a FRESH, private wallet we control (not the public Hardhat account).
// The mnemonic is written to .wallets/seed.txt (mode 600) and never printed.
import { Wallet } from "ethers";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, ".wallets");
mkdirSync(dir, { recursive: true });
const seedPath = resolve(dir, "seed.txt");

if (existsSync(seedPath) && !process.env.FORCE) {
  console.log(JSON.stringify({ note: "seed.txt already exists; set FORCE=1 to regenerate" }));
  process.exit(0);
}

const w = Wallet.createRandom(); // default path m/44'/60'/0'/0/0 (matches anvil account 0)
writeFileSync(seedPath, w.mnemonic.phrase + "\n", { mode: 0o600 });
writeFileSync(resolve(dir, "account.txt"), w.address + "\n"); // public address only
// Print ONLY the public address, never the mnemonic/private key.
console.log(JSON.stringify({ address: w.address, savedTo: ".wallets/seed.txt (mode 600)" }));
