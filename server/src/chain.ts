// On-chain assertions: verify real chain state (balances) after a dapp case's steps run,
// not just the UI. Balance ops (increased/decreased/changed) snapshot BEFORE the steps and
// compare AFTER; threshold ops (gte/lte/eq) compare the after value to a human-unit value.
import type { ChainAssertion } from "./db.js";

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

// Human decimal string → raw integer units (e.g. "0.01" @ 6 decimals → 10000n).
function parseUnits(value: string, decimals: number): bigint {
  const neg = String(value).trim().startsWith("-");
  const [i, f = ""] = String(value).trim().replace(/^-/, "").split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  const raw = BigInt((i || "0") + (frac || "")) * (decimals === 0 ? 1n : 1n);
  return neg ? -raw : raw;
}
// Raw integer units → human decimal string (trailing zeros trimmed).
function formatUnits(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const s = (raw < 0n ? -raw : raw).toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals);
  const f = s.slice(s.length - decimals).replace(/0+$/, "");
  return (raw < 0n ? "-" : "") + (f ? `${i}.${f}` : i);
}

const decimalsOf = (a: ChainAssertion): number =>
  a.decimals ?? (a.kind === "nativeBalance" ? 18 : 18);

// Read the current balance the assertion targets (ERC-20 balanceOf or native).
export async function readBalance(
  rpcUrl: string,
  a: ChainAssertion,
  defaultAccount: string,
): Promise<bigint> {
  const account = (a.account && a.account.trim()) || defaultAccount;
  if (a.kind === "erc20Balance" && a.token) {
    // balanceOf(address) selector 0x70a08231 + left-padded address
    const data = "0x70a08231" + account.replace(/^0x/, "").toLowerCase().padStart(64, "0");
    const r = await rpcCall(rpcUrl, "eth_call", [{ to: a.token, data }, "latest"]);
    return typeof r === "string" && r.startsWith("0x") ? BigInt(r) : 0n;
  }
  const r = await rpcCall(rpcUrl, "eth_getBalance", [account, "latest"]);
  return typeof r === "string" && r.startsWith("0x") ? BigInt(r) : 0n;
}

// Snapshot every assertion's balance in parallel (called before + after the steps).
export async function snapshotBalances(
  rpcUrl: string,
  assertions: ChainAssertion[],
  defaultAccount: string,
): Promise<bigint[]> {
  return Promise.all(assertions.map((a) => readBalance(rpcUrl, a, defaultAccount).catch(() => 0n)));
}

function defaultLabel(a: ChainAssertion): string {
  const what =
    a.kind === "erc20Balance"
      ? `token ${(a.token || "").slice(0, 10)}… balance`
      : "native balance";
  const op =
    a.op === "gte"
      ? `≥ ${a.value}`
      : a.op === "lte"
        ? `≤ ${a.value}`
        : a.op === "eq"
          ? `= ${a.value}`
          : a.op;
  return `${what} ${op}`;
}

// Evaluate one assertion given its before/after snapshots → an oracle-shaped result.
export function evalChainAssertion(
  a: ChainAssertion,
  before: bigint,
  after: bigint,
): { assertion: string; status: "pass" | "fail"; detail?: string } {
  const dec = decimalsOf(a);
  const label = a.label?.trim() || defaultLabel(a);
  const fb = formatUnits(before, dec);
  const fa = formatUnits(after, dec);
  let ok = false;
  let detail = "";
  switch (a.op) {
    case "increased":
      ok = after > before;
      detail = `${fb} → ${fa} (Δ ${formatUnits(after - before, dec)})`;
      break;
    case "decreased":
      ok = after < before;
      detail = `${fb} → ${fa} (Δ ${formatUnits(after - before, dec)})`;
      break;
    case "changed":
      ok = after !== before;
      detail = `${fb} → ${fa}`;
      break;
    case "gte": {
      const v = parseUnits(a.value || "0", dec);
      ok = after >= v;
      detail = `${fa} ≥ ${a.value ?? "0"}`;
      break;
    }
    case "lte": {
      const v = parseUnits(a.value || "0", dec);
      ok = after <= v;
      detail = `${fa} ≤ ${a.value ?? "0"}`;
      break;
    }
    case "eq": {
      const v = parseUnits(a.value || "0", dec);
      ok = after === v;
      detail = `${fa} = ${a.value ?? "0"}`;
      break;
    }
  }
  return { assertion: `⛓ ${label}`, status: ok ? "pass" : "fail", detail };
}
