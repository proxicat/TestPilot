// Local secrets vault: AES-256-GCM encryption at rest so credentials are never
// stored as plaintext in the SQLite DB. The key lives in .data/secret.key (mode
// 0600, gitignored). This is the local-first stand-in for a Vault/KMS backend —
// the storage interface (encrypt/decrypt) is what a production KMS would replace.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = resolve(__dirname, "..", ".data", "secret.key");

function loadOrCreateKey(): Buffer {
  if (existsSync(KEY_PATH)) {
    const raw = readFileSync(KEY_PATH);
    if (raw.length === 32) return raw;
  }
  const key = randomBytes(32);
  writeFileSync(KEY_PATH, key, { mode: 0o600 });
  try {
    chmodSync(KEY_PATH, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return key;
}

const KEY = loadOrCreateKey();

// Ciphertext layout (base64): iv(12) || authTag(16) || ciphertext.
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
