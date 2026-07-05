import express from "express";
import cors from "cors";
import {
  PORT,
  resolveModelConfig,
  resolveChainConfig,
  setChainConfig,
} from "./config.js";
import { probeModel, generateCode, refineCase } from "./model.js";
import {
  launchSession,
  screenshotBase64,
  openWalletPage,
} from "./agent.js";
import {
  isWalletInstalled,
  isWalletOnboarded,
  startPopupApprover,
  TEST_ACCOUNT,
} from "./wallet.js";
import type { Page } from "puppeteer";
import {
  listProjects,
  getProject,
  createProject,
  deleteProject,
  listCases,
  getCase,
  createCase,
  updateCase,
  deleteCase,
  listRuns,
  listRunsByProject,
  getRun,
  createRun,
  getBaseline,
  upsertBaseline,
  getPerfBaseline,
  upsertPerfBaseline,
  updateRunResults,
  ARTIFACT_DIR,
  listEnvironments,
  getEnvironment,
  upsertEnvironment,
  type StorageState,
  type ChainAssertion,
  deleteEnvironment,
  resolveEnvironment,
  listSecretMeta,
  getSecretValues,
  setSecret,
  deleteSecret,
  computeFlakiness,
  getFlakiness,
  listFlakiness,
  updateRunHealing,
  createBatch,
  updateBatch,
  getBatch,
  listBatches,
  addBatchRun,
  getBatchRuns,
  type Priority,
  type RunStatus,
  type VisualDiff,
  type OracleCheck,
  type Environment,
  type TestCase,
  type Batch,
  type RunRecord,
} from "./db.js";
import { enqueue, queueStatus } from "./queue.js";
import { computeTrends } from "./trends.js";
import {
  getSettings,
  updateSettings,
  resetPrompts,
  langDirective,
  DEFAULT_PROMPTS,
  LLM_DEBUG_DIR,
} from "./settings.js";
import { resolveText, resolveMap, redact, type ResolveContext } from "./interpolate.js";
import { snapshotBalances, evalChainAssertion, collectReceipts, evalTxSubmitted } from "./chain.js";
import { seedIfEmpty } from "./seed.js";
import { buildExportFiles } from "./export.js";
import { captureMidsceneReport } from "./report.js";
import { diffPng } from "./visual.js";
import { capturePerf, comparePerf, type PerfMetrics } from "./perf.js";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  createReadStream,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const MIDSCENE_DIR = resolve(process.cwd(), "midscene_run");
const VISUAL_THRESHOLD = 0.5; // % mismatch above which a step is flagged as a visual diff

// Execute Midscene steps against a URL (shared by /api/run and /api/cases/:id/run).
interface RunResult {
  status: "passed" | "failed";
  durationMs: number;
  startedAt: string;
  logs: string[];
  screenshots: string[];
  pngBuffers: Buffer[]; // lossless PNG per screenshot, aligned with `screenshots`, for visual diff
  sinceMs: number; // when the run started (to locate its Midscene report)
  perfMetrics: PerfMetrics; // navigation/paint timing of the page under test
  oracle: OracleCheck[]; // functional assertion results (from the case's `expected`)
  failureReason?: string;
  infraError?: boolean; // model/network failure (not a real test failure) — excluded from flake/gate
}

// Distinguish an infrastructure/model failure (couldn't get a verdict) from a real
// assertion failure. Infra errors must NOT count toward flake rate, MTTR, or the gate
// as if the test itself failed — they mean "unable to determine", not "test failed".
function isInfraError(msg: string): boolean {
  return /AI model service|502|503|504|terminated|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up|network error|model provider|rate limit|timeout/i.test(
    msg,
  );
}
async function executeRun(
  url: string,
  steps: string[],
  expected: string,
  opts: {
    injected?: boolean;
    wallet?: boolean;
    rpcUrl?: string;
    chainId?: number;
    cacheId?: string;
    login?: string[]; // login-flow step templates (登录态), run before case steps
    postSteps?: string[]; // teardown/cleanup step templates, run after the assert
    resolve?: ResolveContext; // ${env.*}/${secret.*} resolution context
    rowLabel?: string; // data-driven row label, logged for forensics
    extraHeaders?: Record<string, string>; // fixed request headers (resolved)
    query?: Record<string, string>; // fixed query-string params
    storageState?: StorageState | null; // captured login state to inject
    web3?: {
      // dapp run: settle-wait after nav + on-chain assertions checked before/after the steps
      chainAssertions: ChainAssertion[];
      rpcUrl: string;
      account: string;
      settleMs?: number;
    };
  } = {},
): Promise<RunResult> {
  const injected = !!opts.injected;
  const wallet = !injected && !!opts.wallet;
  const ctx: ResolveContext = opts.resolve ?? { env: {}, secrets: {} };
  const secretVals = Object.values(ctx.secrets);
  const rlog = (s: string) => logs.push(redact(s, secretVals));
  const startedAt = new Date().toISOString();
  const sinceMs = Date.now();
  const t0 = sinceMs;
  const logs: string[] = [];
  const screenshots: string[] = [];
  const pngBuffers: Buffer[] = [];
  let session;
  let stopApprover: (() => void) | undefined;
  const shot = async () => {
    const png = Buffer.from(await session!.page.screenshot({ type: "png" }));
    pngBuffers.push(png);
    screenshots.push(`data:image/png;base64,${png.toString("base64")}`);
  };
  try {
    if (opts.rowLabel) rlog(`data row ${opts.rowLabel}`);
    logs.push(`navigate → ${url}${injected ? " (injected wallet)" : wallet ? " (with MetaMask)" : ""}`);
    const dataOpts = {
      extraHeaders: opts.extraHeaders,
      query: opts.query,
      storageState: opts.storageState,
    };
    session = await launchSession(
      url,
      injected
        ? { injected: true, rpcUrl: opts.rpcUrl, chainId: opts.chainId, cacheId: opts.cacheId, ...dataOpts }
        : { wallet, cacheId: opts.cacheId, ...dataOpts },
    );
    if (injected) logs.push(`injected wallet ${session.injectedAddress}`);
    else if (wallet && session.walletId) {
      stopApprover = startPopupApprover(session.browser);
      logs.push(`wallet ready (unlocked=${session.walletUnlocked})`);
    }
    await shot();
    // Login flow (登录态): resolve ${secret.*}/${env.*} for execution, but log the
    // TEMPLATE text so credentials never appear in logs/reports.
    const login = opts.login ?? [];
    if (login.length) {
      rlog(`login flow (${login.length} steps)`);
      for (const t of login) {
        rlog(`  login: ${t}`);
        await session.agent.aiAction(resolveText(t, ctx));
      }
      await shot();
    }
    // Dapp/SPA settle: give the app time to detect the injected wallet + render before we
    // act/assert (a bare domcontentloaded fires before a React dapp is interactive).
    if (opts.web3) {
      await new Promise((r) => setTimeout(r, opts.web3!.settleMs ?? 4000));
    }
    // On-chain snapshot BEFORE the steps, so balance-delta assertions measure their effect.
    let chainBefore: bigint[] = [];
    if (opts.web3?.chainAssertions?.length) {
      chainBefore = await snapshotBalances(opts.web3.rpcUrl, opts.web3.chainAssertions, opts.web3.account);
      rlog(`chain snapshot (before) — ${chainBefore.length} balance(s)`);
    }
    for (const [i, step] of steps.entries()) {
      rlog(`step ${i + 1}: ${step}`);
      await session.agent.aiAction(resolveText(step, ctx));
      await shot();
    }
    // Functional oracle: verify the case's expected outcome and record it structurally.
    const oracle: OracleCheck[] = [];
    let assertFailed: string | undefined;
    let infraError = false;
    if (expected) {
      rlog(`assert: ${expected}`);
      try {
        await session.agent.aiAssert(resolveText(expected, ctx));
        oracle.push({ assertion: expected, status: "pass" });
        logs.push("assert ✓");
      } catch (e) {
        const detail = redact((e as Error).message, secretVals);
        if (isInfraError(detail)) {
          // Model/network failure during the assert — we never actually evaluated the
          // oracle, so don't record a functional fail. Flag it as an infra error.
          infraError = true;
          assertFailed = detail;
          rlog(`assert ⚠ infra error (not a test failure) — ${detail.slice(0, 80)}`);
        } else {
          oracle.push({ assertion: expected, status: "fail", detail });
          rlog(`assert ✗ — ${detail}`);
          assertFailed = detail;
        }
      }
    }
    // On-chain oracle: read the chain AFTER the steps and evaluate each assertion. These
    // join the same oracle array (so they show + gate the verdict) — verifies real state,
    // not just the UI. Snapshot before teardown so cleanup doesn't skew it.
    if (opts.web3?.chainAssertions?.length) {
      try {
        const after = await snapshotBalances(opts.web3.rpcUrl, opts.web3.chainAssertions, opts.web3.account);
        // If any assertion checks "the wallet sent a tx", poll receipts for the hashes our
        // injected wallet recorded this run (from the actual UI interaction — we ARE the wallet).
        const needsTx = opts.web3.chainAssertions.some((a) => a.kind === "txSubmitted");
        const sent = session.sentTxs ?? [];
        if (needsTx) rlog(`wallet sent ${sent.length} tx(s) this run — polling receipts`);
        const receipts = needsTx ? await collectReceipts(opts.web3.rpcUrl, sent, 30000) : [];
        opts.web3.chainAssertions.forEach((a, i) => {
          const r =
            a.kind === "txSubmitted"
              ? evalTxSubmitted(a, receipts)
              : evalChainAssertion(a, chainBefore[i] ?? 0n, after[i] ?? 0n);
          oracle.push(r);
          rlog(`chain ${r.status === "pass" ? "✓" : "✗"} ${r.assertion} — ${r.detail}`);
          if (r.status === "fail") assertFailed = assertFailed || `chain assertion: ${r.assertion}`;
        });
      } catch (e) {
        rlog(`chain assertions skipped — ${redact((e as Error).message, secretVals).slice(0, 70)}`);
      }
    }
    // Teardown (post steps): best-effort cleanup so runs stay independent/repeatable.
    for (const t of opts.postSteps ?? []) {
      try {
        rlog(`teardown: ${t}`);
        await session.agent.aiAction(resolveText(t, ctx));
      } catch (e) {
        rlog(`teardown skipped — ${redact((e as Error).message, secretVals).slice(0, 70)}`);
      }
    }
    const perfMetrics = await capturePerf(session.page).catch(() => ({}) as PerfMetrics);
    return {
      status: assertFailed ? "failed" : "passed",
      durationMs: Date.now() - t0,
      startedAt,
      logs,
      screenshots,
      pngBuffers,
      sinceMs,
      perfMetrics,
      oracle,
      failureReason: assertFailed,
      infraError,
    };
  } catch (e) {
    const message = redact((e as Error).message, secretVals);
    logs.push(`error: ${message}`);
    return {
      status: "failed",
      durationMs: Date.now() - t0,
      startedAt,
      logs,
      screenshots,
      pngBuffers,
      sinceMs,
      perfMetrics: {},
      oracle: [],
      failureReason: message,
      infraError: isInfraError(message),
    };
  } finally {
    stopApprover?.();
    await session?.cleanup();
  }
}

// Compare a run's step screenshots against per-step visual baselines; save current/diff
// artifacts and return the diff results. First run for a case establishes the baselines.
function processVisual(caseId: string, runId: string, pngBuffers: Buffer[]): VisualDiff[] {
  const out: VisualDiff[] = [];
  for (let i = 0; i < pngBuffers.length; i += 1) {
    const cur = pngBuffers[i];
    const currentRef = `current/${runId}-${i}.png`;
    writeFileSync(resolve(ARTIFACT_DIR, currentRef), cur);
    const baseline = getBaseline(caseId, i);
    if (!baseline || !existsSync(baseline.imgPath)) {
      const blPath = resolve(ARTIFACT_DIR, "baselines", `${caseId}-${i}.png`);
      writeFileSync(blPath, cur);
      upsertBaseline(caseId, i, blPath);
      out.push({
        stepIdx: i,
        status: "new_baseline",
        mismatchPct: 0,
        baselineRef: `baselines/${caseId}-${i}.png`,
        currentRef,
      });
      continue;
    }
    const d = diffPng(readFileSync(baseline.imgPath), cur);
    const diffRef = `diff/${runId}-${i}.png`;
    writeFileSync(resolve(ARTIFACT_DIR, diffRef), d.diffPng);
    out.push({
      stepIdx: i,
      status: d.mismatchPct > VISUAL_THRESHOLD ? "diff" : "match",
      mismatchPct: d.mismatchPct,
      baselineRef: `baselines/${caseId}-${i}.png`,
      currentRef,
      diffRef,
    });
  }
  return out;
}

// Poll a dapp status element until it matches, or time out.
async function waitStatus(
  page: Page,
  match: (s: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await page.$eval("#status", (el) => el.textContent ?? "").catch(() => "");
    if (match(s)) return s;
    await new Promise((r) => setTimeout(r, 300));
  }
  return page.$eval("#status", (el) => el.textContent ?? "").catch(() => "?");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
// Serve baseline / current / diff images (referenced by VisualDiff.*Ref).
app.use("/api/artifacts", express.static(ARTIFACT_DIR));

const log = (...a: unknown[]) => console.log("[testpilot]", ...a);

// Prompt for AI test-planning is now a globally-configurable template (Model config →
// prompt templates). getSettings().prompts.explore holds the current text; the shipped
// default lives in settings.ts. Read it per-request so edits take effect immediately.

const CASE_TYPES = new Set(["functional", "negative", "boundary", "e2e"]);

// Minimal dapp for exercising wallet connect / signing locally (no testnet needed).
app.get("/testdapp", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>TestDapp</title></head>
<body style="font-family:sans-serif;padding:24px">
  <h1>TestPilot dapp</h1>
  <button id="connect" style="padding:10px 16px;font-size:16px">Connect wallet</button>
  <button id="sign" style="padding:10px 16px;font-size:16px">Sign message</button>
  <button id="addchain" style="padding:10px 16px;font-size:16px">Use Anvil Local</button>
  <button id="sendtx" style="padding:10px 16px;font-size:16px">Send 0.01 ETH</button>
  <button id="wrap" style="padding:10px 16px;font-size:16px">Wrap 0.001 ETH → WETH (Sepolia)</button>
  <pre id="status" data-testid="status">idle</pre>
  <div id="banner"></div>
  <script>
    // Simulate a performance regression for perf-baseline demos: /testdapp?slow=1
    if (location.search.includes('slow')) { const _e = Date.now() + 900; while (Date.now() < _e) {} }
    const s = document.getElementById('status');
    const set = (t) => { s.textContent = t; };
    addEventListener('load', () => {
      set(window.ethereum ? 'provider:present' : 'provider:absent');
      // Simulate a UI change for visual-regression demos: /testdapp?changed=1
      if (location.search.includes('changed')) {
        const b = document.getElementById('banner');
        b.textContent = '🔴 SUMMER SALE — 50% OFF EVERYTHING';
        b.style.cssText = 'background:#e11d48;color:#fff;font-size:22px;font-weight:700;padding:18px;margin:12px 0;border-radius:8px;text-align:center';
      }
    });
    connect.onclick = async () => {
      try { const a = await ethereum.request({ method: 'eth_requestAccounts' }); set('connected:' + a[0]); }
      catch (e) { set('connect-error:' + e.message); }
    };
    sign.onclick = async () => {
      try {
        const a = await ethereum.request({ method: 'eth_accounts' });
        const sig = await ethereum.request({ method: 'personal_sign', params: ['TestPilot hello', a[0]] });
        set('signed:' + sig.slice(0, 20) + '…');
      } catch (e) { set('sign-error:' + e.message); }
    };
    addchain.onclick = async () => {
      try {
        await ethereum.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: '0x7a69', chainName: 'Anvil Local',
          rpcUrls: ['http://127.0.0.1:8545'],
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        }]});
        set('chain:' + await ethereum.request({ method: 'eth_chainId' }));
      } catch (e) { set('chain-error:' + (e.code||'') + ':' + e.message); }
    };
    sendtx.onclick = async () => {
      try {
        const a = await ethereum.request({ method: 'eth_accounts' });
        const hash = await ethereum.request({ method: 'eth_sendTransaction', params: [{
          from: a[0], to: '0x000000000000000000000000000000000000dEaD', value: '0x2386f26fc10000',
        }]});
        set('tx:' + hash);
      } catch (e) { set('tx-error:' + (e.code||'') + ':' + e.message); }
    };
    wrap.onclick = async () => {
      // ETH -> WETH on Sepolia: call WETH.deposit() (selector 0xd0e30db0) with value.
      try {
        const a = await ethereum.request({ method: 'eth_accounts' });
        const hash = await ethereum.request({ method: 'eth_sendTransaction', params: [{
          from: a[0],
          to: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9', // canonical Sepolia WETH
          value: '0x38d7ea4c68000', // 0.001 ETH
          data: '0xd0e30db0',        // deposit()
        }]});
        set('wrap:' + hash);
      } catch (e) { set('wrap-error:' + (e.code||'') + ':' + e.message); }
    };
  </script>
</body></html>`);
});

// Minimal login SUT for exercising the login-flow + secrets pipeline locally.
// Valid credentials: any username + password "s3cr3t-pass". Wrong password → error.
app.get("/testlogin", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>TestLogin</title></head>
<body style="font-family:sans-serif;padding:24px;max-width:420px">
  <h1>Acme Portal — Sign in</h1>
  <div id="app">
    <label>Username<br><input id="username" style="width:100%;padding:8px;margin:6px 0"></label><br>
    <label>Password<br><input id="password" type="password" style="width:100%;padding:8px;margin:6px 0"></label><br>
    <button id="login" style="padding:10px 16px;font-size:16px;margin-top:8px">Sign in</button>
    <p id="error" style="color:#dc2626"></p>
  </div>
  <div id="dashboard" style="display:none">
    <h2 data-testid="welcome">Welcome, <span id="who"></span> 👋</h2>
    <p>Your dashboard is ready.</p>
    <button id="logout">Log out</button>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    $('login').onclick = () => {
      const u = $('username').value.trim();
      const p = $('password').value;
      if (u && p === 's3cr3t-pass') {
        $('who').textContent = u;
        $('app').style.display = 'none';
        $('dashboard').style.display = 'block';
        $('error').textContent = '';
      } else {
        $('error').textContent = 'Invalid username or password';
      }
    };
    $('logout').onclick = () => location.reload();
  </script>
</body></html>`);
});

// Flaky SUT: the FIRST load for a given id renders an error ("warming up"); every
// subsequent load renders READY. Lets us exercise self-heal deterministically — the
// first attempt fails, the cache-busted retry passes → the run is marked "healed".
const flakyHits: Record<string, number> = {};
app.get("/testflaky", (req, res) => {
  const id = String(req.query.id || "default");
  flakyHits[id] = (flakyHits[id] || 0) + 1;
  const ready = flakyHits[id] > 1;
  const state = ready ? "READY" : "ERROR: service warming up";
  const color = ready ? "#16a34a" : "#dc2626";
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Flaky SUT</title></head>
<body style="font-family:sans-serif;padding:24px">
  <h1>Flaky service</h1>
  <p>Health status:</p>
  <pre data-testid="status" style="font-size:20px;color:${color}">${state}</pre>
</body></html>`);
});

// Full wallet-connect + sign smoke test against the built-in test dapp (headed).
app.post("/api/wallet/dapp-test", async (req, res) => {
  if (!isWalletOnboarded())
    return res.status(400).json({ error: "Wallet not onboarded. Run: pnpm setup:onboard" });
  const url = (req.body?.url as string) || `http://localhost:${PORT}/testdapp`;
  let session;
  try {
    session = await launchSession(url, { wallet: true });
    const stop = startPopupApprover(session.browser);
    const dapp = session.page;
    await dapp.evaluate(() => document.getElementById("connect")?.click());
    const connect = await waitStatus(
      dapp,
      (s) => s.startsWith("connected:") || s.startsWith("connect-error:"),
      35000,
    );
    let sign = "skipped";
    if (connect.startsWith("connected:")) {
      await dapp.evaluate(() => document.getElementById("sign")?.click());
      sign = await waitStatus(
        dapp,
        (s) => s.startsWith("signed:") || s.startsWith("sign-error:"),
        35000,
      );
    }
    stop();
    const screenshot = await screenshotBase64(dapp);
    res.json({ connect, sign, account: TEST_ACCOUNT, screenshot });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    await session?.cleanup();
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: resolveModelConfig().modelName,
    walletInstalled: isWalletInstalled(),
    walletOnboarded: isWalletOnboarded(),
    testAccount: isWalletOnboarded() ? TEST_ACCOUNT : undefined,
    chain: resolveChainConfig(),
  });
});

// Current chain config for the injected-wallet dapp-testing mode (RPC is configurable via
// CHAIN_RPC_URL / CHAIN_ID env, or overridden per request).
app.get("/api/config", (_req, res) => {
  res.json({ chain: resolveChainConfig(), account: TEST_ACCOUNT });
});

// Update the chain/RPC config at runtime (from the Model config page).
app.post("/api/config", (req, res) => {
  const rpcUrl = req.body?.rpcUrl as string | undefined;
  const chainId =
    req.body?.chainId !== undefined ? Number(req.body.chainId) : undefined;
  if (rpcUrl !== undefined && !/^https?:\/\//.test(rpcUrl)) {
    return res.status(400).json({ error: "rpcUrl must be an http(s) URL" });
  }
  if (chainId !== undefined && (!Number.isInteger(chainId) || chainId <= 0)) {
    return res.status(400).json({ error: "chainId must be a positive integer" });
  }
  const chain = setChainConfig({ rpcUrl, chainId });
  res.json({ chain, account: TEST_ACCOUNT });
});

// Proof of the injected-wallet capability (no model, no MetaMask): open a dapp with a virtual
// wallet pointed at the configured RPC, connect, send a real tx, verify the receipt on-chain.
app.post("/api/dapp/verify", async (req, res) => {
  const chain = resolveChainConfig({
    rpcUrl: req.body?.rpcUrl,
    chainId: req.body?.chainId,
  });
  const url = req.body?.url || `http://localhost:${PORT}/testdapp`;
  const rpcCall = async (method: string, params: unknown[]) => {
    const r = await fetch(chain.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await r.json()).result;
  };
  let session;
  try {
    session = await launchSession(url, {
      injected: true,
      rpcUrl: chain.rpcUrl,
      chainId: chain.chainId,
    });
    const page = session.page;
    const status = () =>
      page.$eval("#status", (el) => el.textContent || "").catch(() => "");
    const waitStatus = async (pred: (s: string) => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const s = await status();
        if (pred(s)) return s;
        await new Promise((r) => setTimeout(r, 400));
      }
      return status();
    };

    await page.evaluate(() =>
      (document.getElementById("connect") as HTMLElement | null)?.click(),
    );
    const connect = await waitStatus(
      (s) => s.startsWith("connected:") || s.startsWith("connect-error:"),
      30000,
    );

    await page.evaluate(() =>
      (document.getElementById("sendtx") as HTMLElement | null)?.click(),
    );
    const tx = await waitStatus(
      (s) => s.startsWith("tx:") || s.startsWith("tx-error:"),
      30000,
    );

    let receipt: { status?: string; blockNumber?: string } | null = null;
    if (tx.startsWith("tx:")) {
      const hash = tx.slice(3).trim();
      for (let i = 0; i < 20; i += 1) {
        receipt = await rpcCall("eth_getTransactionReceipt", [hash]);
        if (receipt) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    const screenshot = await screenshotBase64(page);
    res.json({
      account: session.injectedAddress,
      chain,
      connect,
      tx,
      mined: !!receipt,
      txStatus: receipt?.status,
      block: receipt?.blockNumber,
      screenshot,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    await session?.cleanup();
  }
});

// Verify the wallet extension loads: launch with it, resolve its id, screenshot its UI.
app.post("/api/wallet/check", async (req, res) => {
  if (!isWalletInstalled()) {
    return res.status(400).json({
      error: "Wallet not installed. Run: pnpm setup:wallet",
    });
  }
  const path = (req.body?.path as string) || "home.html";
  let session;
  try {
    session = await launchSession("about:blank", { wallet: true });
    if (!session.walletId) {
      return res.json({ loaded: false, detail: "extension worker not found" });
    }
    // Prefer the kept-open, already-unlocked page; else open a fresh one.
    const walletPage =
      session.walletPage ??
      (await openWalletPage(session.browser, session.walletId, path));
    await new Promise((r) => setTimeout(r, 3500)); // let the account view render
    const screenshot = await screenshotBase64(walletPage);
    res.json({
      loaded: true,
      walletId: session.walletId,
      onboarded: isWalletOnboarded(),
      unlocked: session.walletUnlocked ?? false,
      account: isWalletOnboarded() ? TEST_ACCOUNT : undefined,
      screenshot,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    await session?.cleanup();
  }
});

// Probe the vision-language endpoint: reachable + multimodal?
app.post("/api/model/test", async (req, res) => {
  const result = await probeModel(req.body ?? {});
  res.json(result);
});

// Generate runnable Midscene code from natural-language steps.
app.post("/api/generate-code", async (req, res) => {
  const { title = "", steps = [], expected = "" } = req.body ?? {};
  try {
    const code = await generateCode(title, steps, expected);
    res.json({ code });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Execute a test case with Midscene against a live URL.
app.post("/api/run", async (req, res) => {
  const {
    url,
    steps = [],
    expected = "",
  }: { url?: string; steps?: string[]; expected?: string } = req.body ?? {};
  if (!url) return res.status(400).json({ error: "url is required" });
  const injected = req.body?.provider === "injected" || !!req.body?.injected;
  const { pngBuffers: _p, sinceMs: _s, ...result } = await executeRun(url, steps, expected, {
    injected,
    wallet: !!req.body?.wallet,
    rpcUrl: req.body?.rpcUrl,
    chainId: req.body?.chainId,
  });
  void _p;
  void _s;
  res.json(result);
});

/* ─────────────── Persistence: projects / cases / runs ─────────────── */

app.get("/api/projects", (_req, res) => res.json({ projects: listProjects() }));
app.post("/api/projects", (req, res) => {
  const { name, targetUrl } = req.body ?? {};
  if (!name || !targetUrl) return res.status(400).json({ error: "name and targetUrl required" });
  res.json({ project: createProject(String(name), String(targetUrl)) });
});
app.delete("/api/projects/:id", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  deleteProject(req.params.id);
  res.json({ ok: true });
});

// One-click Uniswap dapp-testing example: a project pointed at the real Uniswap app with
// starter web3 cases (injected wallet + on-chain assertions). Reused if it already exists.
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
app.post("/api/examples/uniswap", (_req, res) => {
  const existing = listProjects().find((p) => p.name === "Uniswap (example)");
  if (existing) return res.json({ project: existing, reused: true });
  const project = createProject("Uniswap (example)", "https://app.uniswap.org/swap");
  // 1) Wallet connects — works out of the box (injected wallet auto-connects via EIP-6963).
  createCase({
    projectId: project.id,
    title: "Wallet connects to Uniswap",
    priority: "P0",
    type: "e2e",
    priorityReason: "The injected wallet auto-connects to Uniswap via EIP-6963 — verify the app shows it.",
    steps: [],
    expected:
      "The Uniswap swap page is loaded and the connected wallet address (an account like 0x…) is shown in the top-right; the swap form with a 'You pay' / 'You receive' layout is visible",
    web3Mode: "injected",
    chainAssertions: [],
  });
  // 2) Swap template with an ON-CHAIN assertion — the recommended dapp pattern. NOTE: against
  // Uniswap's PRODUCTION app on a fork the UI reads balances from Uniswap's backend gateway
  // (not the fork), so the UI swap may show "insufficient funds"; point this at your own
  // deployment / a provider-reading UI, or rely on the on-chain assertion.
  createCase({
    projectId: project.id,
    title: "Swap 0.01 ETH → USDC (on-chain verified)",
    priority: "P0",
    type: "e2e",
    priorityReason:
      "Template for a swap verified on-chain (USDC balance rose). On a fork, Uniswap's prod UI reads balances from its own backend — use your own RPC/deployment for a full UI swap.",
    steps: [
      { order: 1, text: "In the 'You pay' amount field, enter 0.01" },
      { order: 2, text: "Open the 'You receive' token selector, search USDC, and select it" },
      { order: 3, text: "Click the Swap button, then confirm the swap" },
    ],
    expected: "A swap confirmation or success state is shown (e.g. 'Swap submitted' / a success toast)",
    web3Mode: "injected",
    chainAssertions: [
      { kind: "erc20Balance", op: "increased", token: USDC_MAINNET, decimals: 6, label: "USDC balance increased after the swap" },
    ],
  });
  res.json({ project, reused: false });
});

app.get("/api/cases", (req, res) =>
  res.json({ cases: listCases(req.query.projectId as string | undefined) }),
);
app.post("/api/cases", (req, res) => {
  const { projectId, title } = req.body ?? {};
  if (!projectId || !title) return res.status(400).json({ error: "projectId and title required" });
  res.json({ case: createCase(req.body) });
});
app.patch("/api/cases/:id", (req, res) => {
  const c = updateCase(req.params.id, req.body ?? {});
  if (!c) return res.status(404).json({ error: "case not found" });
  res.json({ case: c });
});
app.delete("/api/cases/:id", (req, res) => {
  deleteCase(req.params.id);
  res.json({ ok: true });
});

app.get("/api/runs", (req, res) => {
  const caseId = req.query.caseId as string | undefined;
  const projectId = req.query.projectId as string | undefined;
  const runs = caseId
    ? listRuns(caseId)
    : projectId
      ? listRunsByProject(projectId)
      : listRuns();
  res.json({ runs });
});

// A single run record (for drilling into a run from the suite view).
app.get("/api/runs/:id", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "run not found" });
  res.json({ run });
});

// Serve Midscene's full interactive HTML report for a run (for failure localization).
app.get("/api/runs/:id/report", (req, res) => {
  const run = getRun(req.params.id);
  if (!run?.reportPath || !existsSync(run.reportPath)) {
    return res.status(404).send("No Midscene report captured for this run.");
  }
  res.sendFile(run.reportPath);
});

// Approve the current image of a step as the new visual baseline (accept the change).
app.post("/api/cases/:id/baselines/approve", (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return res.status(404).json({ error: "case not found" });
  const stepIdx = Number(req.body?.stepIdx);
  const ref = String(req.body?.ref || "");
  if (!Number.isInteger(stepIdx) || !ref.startsWith("current/")) {
    return res.status(400).json({ error: "stepIdx and a current/* ref required" });
  }
  const src = resolve(ARTIFACT_DIR, ref);
  if (!existsSync(src)) return res.status(404).json({ error: "artifact not found" });
  const blPath = resolve(ARTIFACT_DIR, "baselines", `${c.id}-${stepIdx}.png`);
  copyFileSync(src, blPath);
  const baseline = upsertBaseline(c.id, stepIdx, blPath);
  res.json({ ok: true, baseline });
});

// Export a project's cases as a standalone runnable Playwright + Midscene project.
// ?format=json returns the file map; otherwise streams a .zip download.
app.get("/api/projects/:id/export", (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "project not found" });
  const files = buildExportFiles(project, listCases(project.id), {
    environments: listEnvironments(project.id),
    secretKeys: listSecretMeta(project.id).map((s) => s.key),
  });

  if (req.query.format === "json") return res.json({ files });

  const dir = mkdtempSync(join(tmpdir(), "tp-export-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    execFileSync("zip", ["-r", "-q", "export.zip", ".", "-x", "export.zip"], { cwd: dir });
    const zipName = project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-e2e.zip";
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
    const stream = createReadStream(join(dir, "export.zip"));
    stream.pipe(res);
    stream.on("close", () => rmSync(dir, { recursive: true, force: true }));
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    res.status(500).json({ error: (e as Error).message });
  }
});

// Generate code for a stored case and persist it.
app.post("/api/cases/:id/generate-code", async (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return res.status(404).json({ error: "case not found" });
  try {
    const { code } = { code: await generateCode(c.title, c.steps.map((s) => s.text), c.priorityReason) };
    const updated = updateCase(c.id, { code, hasCode: true });
    res.json({ case: updated });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Bust the Midscene plan cache for a case → the next run replans instead of
// replaying a stale plan. This is the self-heal mechanism for selector/visual drift.
function bustCache(cacheId: string): void {
  const f = resolve(MIDSCENE_DIR, "cache", `${cacheId}.cache.yaml`);
  try {
    if (existsSync(f)) rmSync(f);
  } catch {
    /* ignore */
  }
}

// Run one case once (env/secret/login resolution, perf, oracle, report, visual), persist a run.
async function runAndPersistCase(
  c: TestCase,
  body: Record<string, any>,
): Promise<RunRecord> {
  const project = getProject(c.projectId);
  const env = resolveEnvironment(c.projectId, body?.env || c.envRef);
  const ctx: ResolveContext = {
    env: env?.vars ?? {},
    secrets: getSecretValues(c.projectId),
    row: body?.__row, // data-driven: current row → ${row} / ${row.col}
  };
  const url = resolveText(body?.url || env?.baseUrl || project?.targetUrl || "", ctx);
  if (!url) throw new Error("no url (set an environment baseUrl or project targetUrl)");
  // Login state: if a session was captured, INJECT it and skip the login steps (fast,
  // best-practice). Otherwise fall back to running the UI login flow.
  const session = env?.login?.session ?? null;
  const useSession = !!env?.login?.authRequired && !!session && !body?.skipLogin;
  const login =
    env?.login?.authRequired && !useSession && !body?.skipLogin ? env.login.steps ?? [] : [];
  // Wallet mode: from the run body OR the case's web3Mode (so suite/debug honor it too).
  const injected = body?.provider === "injected" || !!body?.injected || c.web3Mode === "injected";
  const wallet = !!body?.wallet || c.web3Mode === "metamask";
  // Dapp run: resolve the chain + on-chain assertions when the case is a web3 case.
  const chainCfg = resolveChainConfig({ rpcUrl: body?.rpcUrl, chainId: body?.chainId });
  const web3 =
    c.web3Mode || (c.chainAssertions && c.chainAssertions.length)
      ? {
          chainAssertions: c.chainAssertions ?? [],
          rpcUrl: chainCfg.rpcUrl,
          account: TEST_ACCOUNT,
          settleMs: 4000,
        }
      : undefined;

  const result = await executeRun(url, c.steps.map((s) => s.text), body?.expected || c.expected || "", {
    injected,
    wallet,
    rpcUrl: body?.rpcUrl,
    chainId: body?.chainId,
    cacheId: c.id + (body?.__cacheSuffix ?? ""), // per-row cache so data-driven rows don't collide
    login,
    web3,
    postSteps: c.postSteps.map((s) => s.text),
    resolve: ctx,
    rowLabel: body?.__rowLabel,
    // Fixed headers + any auth header captured by API login (when the session is used).
    extraHeaders: { ...resolveMap(env?.headers ?? {}, ctx), ...(useSession ? session?.headers ?? {} : {}) },
    query: resolveMap(env?.query ?? {}, ctx),
    storageState: useSession ? session : null,
  });

  const perf = comparePerf(result.perfMetrics, getPerfBaseline(c.id), {});
  if (perf.status === "new_baseline" && Object.keys(result.perfMetrics).length > 0) {
    upsertPerfBaseline(c.id, result.perfMetrics);
  }
  const run = createRun({
    caseId: c.id,
    caseTitle: c.title,
    priority: c.priority,
    status: result.status,
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    failureReason: result.failureReason,
    logs: result.logs,
    screenshots: result.screenshots,
    oracle: result.oracle,
    perf,
    infraError: result.infraError,
  });
  const report = captureMidsceneReport({
    midsceneDir: MIDSCENE_DIR,
    sinceMs: result.sinceMs,
    destPath: resolve(ARTIFACT_DIR, "reports", `${run.id}.html`),
  });
  const visual = processVisual(c.id, run.id, result.pngBuffers);
  updateRunResults(run.id, { reportPath: report.reportPath, tokens: report.tokens, visual, perf, oracle: result.oracle });
  run.reportPath = report.reportPath;
  run.tokens = report.tokens;
  run.visual = visual;
  return run;
}

// Run a case with self-heal: on failure, bust the plan cache and retry up to maxRetries.
// The final run is tagged attempts + healed; per-case flakiness is recomputed.
async function runCaseWithHeal(
  c: TestCase,
  body: Record<string, any>,
  maxRetries: number,
): Promise<{ run: RunRecord; attempts: number; healed: boolean }> {
  updateCase(c.id, { runStatus: "running" as RunStatus });
  let attempts = 0;
  let run: RunRecord;
  for (;;) {
    attempts++;
    run = await runAndPersistCase(c, body);
    if (run.status === "passed" || attempts > maxRetries) break;
    bustCache(c.id + (body?.__cacheSuffix ?? "")); // self-heal: drop the stale (per-row) plan
  }
  const healed = run.status === "passed" && attempts > 1;
  updateRunHealing(run.id, attempts, healed);
  run.attempts = attempts;
  run.healed = healed;
  computeFlakiness(c.id);
  updateCase(c.id, { runStatus: run.status });
  return { run, attempts, healed };
}

// Data-driven wrapper: if the case binds an env array var (dataKey) with ≥1 rows, run it
// once per row (each row injected as ${row}/${row.col}, with its own plan cache), and
// report the aggregate — the case passes only if EVERY row passes. Otherwise a single run.
async function runCaseDataDriven(
  c: TestCase,
  body: Record<string, any>,
  maxRetries: number,
): Promise<{ run: RunRecord; attempts: number; healed: boolean; rows?: number; rowsPassed?: number }> {
  const env = resolveEnvironment(c.projectId, body?.env || c.envRef);
  const dataset = c.dataKey ? env?.vars?.[c.dataKey] : undefined;
  const rows = Array.isArray(dataset) ? dataset : null;
  if (!rows || !rows.length) return runCaseWithHeal(c, body, maxRetries);

  let last: { run: RunRecord; attempts: number; healed: boolean } | undefined;
  let passed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label = `${i + 1}/${rows.length}: ${typeof row === "object" ? JSON.stringify(row) : String(row)}`;
    last = await runCaseWithHeal(
      c,
      { ...body, __row: row, __cacheSuffix: `#${i}`, __rowLabel: label },
      maxRetries,
    );
    if (last.run.status === "passed") passed++;
  }
  const allPassed = passed === rows.length;
  updateCase(c.id, { runStatus: allPassed ? "passed" : "failed" });
  // The immediate API response reflects the AGGREGATE; each row's run is persisted on its own.
  return {
    ...last!,
    run: { ...last!.run, status: allPassed ? "passed" : "failed" },
    rows: rows.length,
    rowsPassed: passed,
  };
}

// Edit-time AI node intervention: propose a change to a case's steps or oracle from a
// natural-language instruction. Returns { current, proposed } for a diff preview — does NOT
// mutate. The client applies it via PATCH /api/cases/:id only if the user accepts.
app.post("/api/cases/:id/refine", async (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return res.status(404).json({ error: "case not found" });
  const rt = req.body?.target;
  const target: "steps" | "oracle" | "data" =
    rt === "oracle" ? "oracle" : rt === "data" ? "data" : "steps";
  const instruction = String(req.body?.instruction || "").trim();
  if (!instruction) return res.status(400).json({ error: "instruction is required" });
  try {
    const result = await refineCase({
      title: c.title,
      steps: c.steps.map((s) => s.text),
      expected: c.expected || "",
      type: c.type,
      target,
      instruction,
      stepIdx: typeof req.body?.stepIdx === "number" ? req.body.stepIdx : undefined,
      lang: typeof req.body?.lang === "string" ? req.body.lang : undefined,
    });
    // "data" edits the step list too, so it diffs against steps like the "steps" target.
    const editsSteps = target === "steps" || target === "data";
    const current = editsSteps
      ? { steps: c.steps.map((s) => s.text) }
      : { expected: c.expected || "" };
    const proposed = editsSteps
      ? { steps: result.proposedSteps ?? [] }
      : { expected: result.proposedExpected ?? "" };
    res.json({ target, current, proposed, note: result.note });
  } catch (e) {
    res.status(502).json({ error: `refine failed: ${(e as Error).message}` });
  }
});

// Visual step-by-step debug (SSE). Runs the case live, streaming one event per step
// (screenshot + action + status), stops on the first failure, and does NOT persist a run
// (debugging is exploratory). An optional ?hint= is injected as agent action-context —
// human-in-the-loop steering for a guided re-run. Secrets are resolved for execution but
// only the redacted TEMPLATE text is streamed. EventSource is GET-only → params via query.
app.get("/api/cases/:id/debug", async (req, res) => {
  const c = getCase(req.params.id);
  if (!c) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const send = (evt: Record<string, unknown>) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  const env = resolveEnvironment(c.projectId, String(req.query.env || c.envRef || ""));
  const ctx: ResolveContext = { env: env?.vars ?? {}, secrets: getSecretValues(c.projectId) };
  const secretVals = Object.values(ctx.secrets);
  const url = resolveText(
    String(req.query.url || "") || env?.baseUrl || getProject(c.projectId)?.targetUrl || "",
    ctx,
  );
  const hint = String(req.query.hint || "").trim();
  // Same login-state policy as a real run: captured session → inject + skip login steps.
  const session0 = env?.login?.session ?? null;
  const useSession = !!env?.login?.authRequired && !!session0 && req.query.skipLogin !== "1";
  const doLogin = env?.login?.authRequired && !useSession && req.query.skipLogin !== "1";
  const loginSteps = doLogin ? env?.login?.steps ?? [] : [];
  const dataLaunch = {
    extraHeaders: { ...resolveMap(env?.headers ?? {}, ctx), ...(useSession ? session0?.headers ?? {} : {}) },
    query: resolveMap(env?.query ?? {}, ctx),
    storageState: useSession ? session0 : null,
  };
  const plan = [
    ...loginSteps.map((t) => ({ text: t, kind: "login" as const })),
    ...c.steps.map((s) => ({ text: s.text, kind: "step" as const })),
  ];

  let session: Awaited<ReturnType<typeof launchSession>> | undefined;
  let closed = false;
  req.on("close", () => {
    closed = true;
    void session?.cleanup?.();
  });

  const jpeg = async (): Promise<string | undefined> => {
    try {
      const buf = await session!.page.screenshot({ type: "jpeg", quality: 55 });
      return `data:image/jpeg;base64,${Buffer.from(buf).toString("base64")}`;
    } catch {
      return undefined;
    }
  };

  let idx = 0;
  try {
    if (!url) throw new Error("no url (set an environment baseUrl or project targetUrl)");
    send({ type: "start", url, steps: plan.map((p) => ({ text: redact(p.text, secretVals), kind: p.kind })), hint: hint || undefined });
    // Fresh session, no cacheId → the model replans (true debug, not cache replay).
    session = await launchSession(url, dataLaunch);
    if (hint) {
      try {
        (session.agent as { setAIActionContext?: (h: string) => void }).setAIActionContext?.(hint);
      } catch {
        /* older Midscene without action-context — hint is best-effort */
      }
    }
    send({ type: "navigated", screenshot: await jpeg() });

    for (const step of plan) {
      if (closed) return;
      send({ type: "step", idx, kind: step.kind, text: redact(step.text, secretVals), status: "running" });
      await session.agent.aiAction(resolveText(step.text, ctx));
      if (closed) return;
      send({ type: "step", idx, kind: step.kind, text: redact(step.text, secretVals), status: "done", screenshot: await jpeg() });
      idx += 1;
    }

    if (c.expected) {
      if (closed) return;
      send({ type: "assert", assertion: c.expected, status: "running" });
      try {
        await session.agent.aiAssert(resolveText(c.expected, ctx));
        send({ type: "assert", assertion: c.expected, status: "pass", screenshot: await jpeg() });
        send({ type: "done", status: "passed" });
      } catch (e) {
        const detail = redact((e as Error).message, secretVals);
        send({ type: "assert", assertion: c.expected, status: "fail", detail, screenshot: await jpeg() });
        send({ type: "done", status: "failed", failedIdx: idx, failedKind: "assert" });
      }
    } else {
      send({ type: "done", status: "passed" });
    }
  } catch (e) {
    const message = redact((e as Error).message, secretVals);
    const infra = isInfraError(message);
    send({ type: "step", idx, status: "fail", detail: message, screenshot: session ? await jpeg() : undefined });
    send({ type: "done", status: infra ? "error" : "failed", failedIdx: idx, message });
  } finally {
    await session?.cleanup?.();
    if (!closed && !res.writableEnded) res.end();
  }
});

// Execute a stored case (with optional self-heal retry), persist, update status.
app.post("/api/cases/:id/run", async (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return res.status(404).json({ error: "case not found" });
  try {
    const maxRetries = Math.max(0, Number(req.body?.retries ?? 0));
    const { run, rows, rowsPassed } = await runCaseDataDriven(c, req.body ?? {}, maxRetries);
    res.json({ case: getCase(c.id), run, rows, rowsPassed });
  } catch (e) {
    updateCase(c.id, { runStatus: "failed" as RunStatus });
    res.status(500).json({ error: (e as Error).message });
  }
});

// Accept a run's current performance metrics as the new baseline for the case.
app.post("/api/cases/:id/perf-baseline/approve", (req, res) => {
  const c = getCase(req.params.id);
  if (!c) return res.status(404).json({ error: "case not found" });
  const run = getRun(String(req.body?.runId || ""));
  const metrics = (run?.perf as { metrics?: PerfMetrics } | undefined)?.metrics;
  if (!metrics) return res.status(400).json({ error: "runId with perf metrics required" });
  upsertPerfBaseline(c.id, metrics);
  res.json({ ok: true, metrics });
});

interface Flow {
  title: string;
  priority: Priority;
  reason: string;
  steps: string[];
  expected?: string;
  type?: string;
  // Dapp explore: the model's suggested on-chain check for a state-changing flow.
  chain?: { kind?: string; op?: string; token?: string; decimals?: number; note?: string };
}
function asFlows(data: unknown): Flow[] {
  const arr = Array.isArray(data)
    ? data
    : ((data as { flows?: unknown[] })?.flows ?? []);
  return (arr as Flow[]).filter((f) => f && f.title);
}
// Map a dapp flow's `chain` hint → a concrete on-chain assertion for the case.
function flowChainAssertions(f: Flow): ChainAssertion[] {
  const c = f.chain;
  if (!c || !c.kind) return [];
  const op = (["increased", "decreased", "changed", "gte", "lte", "eq"].includes(c.op ?? "")
    ? c.op
    : "changed") as ChainAssertion["op"];
  const kind: ChainAssertion["kind"] = c.kind === "erc20Balance" ? "erc20Balance" : "nativeBalance";
  const a: ChainAssertion = { kind, op, label: c.note };
  if (kind === "erc20Balance" && c.token && /^0x[a-fA-F0-9]{40}$/.test(c.token)) {
    a.token = c.token;
    a.decimals = typeof c.decimals === "number" ? c.decimals : 18;
  }
  return [a];
}

// Explore a project's site and persist the discovered flows as cases.
// With { deep: true } it does an agentic crawl: advance one screen (log in / primary CTA)
// and re-query, so flows reached after the entry page are grounded in the real UI.
app.post("/api/projects/:id/explore", async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "project not found" });
  const url = req.body?.url || project.targetUrl;
  const deep = !!req.body?.deep;
  const web3 = !!req.body?.web3;
  const explLog: string[] = [];
  let session;
  try {
    const { explore, exploreDeepPrefix, exploreDapp } = getSettings().prompts;
    const explorePrompt = web3 ? exploreDapp : explore;
    // Force the model's flow text into the UI language when the global toggle is on.
    const dir = langDirective(req.body?.lang);
    session = await launchSession(url, { cacheId: `explore-${project.id}`, ...exploreLaunch(project.id, web3) });
    if (web3) await new Promise((r) => setTimeout(r, 4000));
    const collected: Flow[] = asFlows(await session.agent.aiQuery(explorePrompt + dir));
    explLog.push(`entry page → ${collected.length} flows`);

    if (deep) {
      try {
        await session.agent.aiAction(
          "If a login form is present, log in using any test/demo credentials shown on " +
            "this page; otherwise click the primary button to enter the application.",
        );
        await new Promise((r) => setTimeout(r, 1500));
        const deeper = asFlows(await session.agent.aiQuery(exploreDeepPrefix + explorePrompt + dir));
        collected.push(...deeper);
        explLog.push(`advanced one screen → ${deeper.length} more flows`);
      } catch (e) {
        explLog.push(`deep crawl skipped: ${(e as Error).message.slice(0, 70)}`);
      }
    }

    const seen = new Set(listCases(project.id).map((c) => c.title.toLowerCase()));
    const created = [];
    for (const f of collected) {
      const key = f.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      created.push(
        createCase({
          projectId: project.id,
          title: f.title,
          priority: (["P0", "P1", "P2"].includes(f.priority) ? f.priority : "P1") as Priority,
          priorityReason: f.reason || "",
          expected: f.expected || "",
          type: (CASE_TYPES.has(f.type ?? "") ? f.type : "functional") as TestCase["type"],
          steps: (f.steps || []).map((t, i) => ({ order: i + 1, text: t })),
          web3Mode: web3 ? "injected" : "",
          chainAssertions: web3 ? flowChainAssertions(f) : [],
        }),
      );
    }
    const screenshot = await screenshotBase64(session.page).catch(() => "");
    res.json({ created, count: created.length, log: explLog, screenshot });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    await session?.cleanup();
  }
});

// Data-binding launch opts for exploration: apply the project default env's fixed headers,
// query params, and captured session so a gated / behind-login site can still be explored.
function exploreLaunch(
  projectId: string,
  web3 = false,
): {
  extraHeaders: Record<string, string>;
  query: Record<string, string>;
  storageState: StorageState | null;
  injected?: boolean;
  rpcUrl?: string;
  chainId?: number;
} {
  const env = resolveEnvironment(projectId);
  const ctx: ResolveContext = { env: env?.vars ?? {}, secrets: getSecretValues(projectId) };
  const session = env?.login?.session ?? null;
  const base = {
    extraHeaders: { ...resolveMap(env?.headers ?? {}, ctx), ...(session?.headers ?? {}) },
    query: resolveMap(env?.query ?? {}, ctx),
    storageState: session,
  };
  // Dapp explore: inject the wallet so the dapp connects + shows real state while the
  // model plans (chain/RPC from the global Web3 config).
  if (!web3) return base;
  const chain = resolveChainConfig();
  return { ...base, injected: true, rpcUrl: chain.rpcUrl, chainId: chain.chainId };
}

// Streaming explore (SSE): the same planning as POST /explore, but pushes the LIVE page
// screenshot, log lines, and each discovered flow as they happen — so the UI shows the
// real page being analysed instead of an indefinite spinner. EventSource is GET-only.
app.get("/api/projects/:id/explore/stream", async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const send = (evt: Record<string, unknown>) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  const url = String(req.query.url || "") || project.targetUrl;
  const deep = req.query.deep === "1";
  const web3 = req.query.web3 === "1";
  const lang = String(req.query.lang || "");

  let session: Awaited<ReturnType<typeof launchSession>> | undefined;
  let closed = false;
  let hb: ReturnType<typeof setInterval> | undefined;
  const stopHb = () => {
    if (hb) clearInterval(hb);
    hb = undefined;
  };
  req.on("close", () => {
    closed = true;
    stopHb();
    void session?.cleanup?.();
  });

  const jpeg = async (): Promise<string | undefined> => {
    try {
      const buf = await session!.page.screenshot({ type: "jpeg", quality: 55 });
      return `data:image/jpeg;base64,${Buffer.from(buf).toString("base64")}`;
    } catch {
      return undefined;
    }
  };
  // Refresh the live screenshot on a timer while a (slow) model call is in flight.
  const beat = () => {
    stopHb();
    hb = setInterval(async () => {
      if (closed) return;
      const shot = await jpeg();
      if (shot && !closed) send({ type: "navigated", screenshot: shot });
    }, 4000);
  };

  try {
    if (!url) throw new Error("no url (set a project targetUrl)");
    send({ type: "start", url });
    const { explore, exploreDeepPrefix, exploreDapp } = getSettings().prompts;
    const explorePrompt = web3 ? exploreDapp : explore;
    const dir = langDirective(lang);
    session = await launchSession(url, { cacheId: `explore-${project.id}`, ...exploreLaunch(project.id, web3) });
    send({ type: "navigated", screenshot: await jpeg() });
    send({ type: "log", message: `Analyzing ${url}${web3 ? " (dapp mode — wallet injected)" : ""}…`, kind: "info" });

    // Dapp: give the app a moment to detect the injected wallet + render connected state.
    if (web3) await new Promise((r) => setTimeout(r, 4000));
    beat();
    const collected: Flow[] = asFlows(await session.agent.aiQuery(explorePrompt + dir));
    stopHb();
    if (closed) return;
    send({ type: "log", message: `entry page → ${collected.length} flows`, kind: "info" });

    if (deep) {
      try {
        send({ type: "log", message: "Advancing one screen (deep crawl)…", kind: "info" });
        await session.agent.aiAction(
          "If a login form is present, log in using any test/demo credentials shown on " +
            "this page; otherwise click the primary button to enter the application.",
        );
        await new Promise((r) => setTimeout(r, 1500));
        send({ type: "navigated", screenshot: await jpeg() });
        beat();
        const deeper = asFlows(await session.agent.aiQuery(exploreDeepPrefix + explorePrompt + dir));
        stopHb();
        collected.push(...deeper);
        send({ type: "log", message: `advanced one screen → ${deeper.length} more flows`, kind: "info" });
      } catch (e) {
        stopHb();
        send({ type: "log", message: `deep crawl skipped: ${(e as Error).message.slice(0, 70)}`, kind: "warn" });
      }
    }

    if (closed) return;
    const seen = new Set(listCases(project.id).map((c) => c.title.toLowerCase()));
    let count = 0;
    for (const f of collected) {
      const key = f.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const created = createCase({
        projectId: project.id,
        title: f.title,
        priority: (["P0", "P1", "P2"].includes(f.priority) ? f.priority : "P1") as Priority,
        priorityReason: f.reason || "",
        expected: f.expected || "",
        type: (CASE_TYPES.has(f.type ?? "") ? f.type : "functional") as TestCase["type"],
        steps: (f.steps || []).map((t, i) => ({ order: i + 1, text: t })),
        web3Mode: web3 ? "injected" : "",
        chainAssertions: web3 ? flowChainAssertions(f) : [],
      });
      count++;
      send({ type: "flow", case: created });
    }
    send({ type: "done", count, screenshot: await jpeg() });
  } catch (e) {
    stopHb();
    if (!closed) send({ type: "error", message: (e as Error).message });
  } finally {
    stopHb();
    await session?.cleanup?.();
    if (!res.writableEnded) res.end();
  }
});

// Explore a site: let the VL model propose the key user flows to test.
app.post("/api/explore", async (req, res) => {
  const { url }: { url?: string } = req.body ?? {};
  if (!url) return res.status(400).json({ error: "url is required" });

  let session;
  try {
    session = await launchSession(url);
    const data = await session.agent.aiQuery(getSettings().prompts.explore);
    const flows = Array.isArray(data) ? data : (data?.flows ?? []);
    res.json({ flows });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    await session?.cleanup();
  }
});

/* ---- environments (per-project target + vars + headers/query + login/session) ---- */
// The captured session blob (live auth cookies + localStorage) NEVER leaves the server.
// The UI only sees whether one exists + when it was captured + its size.
function sanitizeEnv(env: Environment) {
  const s = env.login?.session ?? null;
  return {
    ...env,
    login: {
      authRequired: env.login?.authRequired ?? false,
      steps: env.login?.steps ?? [],
      apiLogin: env.login?.apiLogin ?? null, // config only (contains placeholders, not secrets)
      capturedAt: env.login?.capturedAt,
      hasSession: !!s,
      sessionCookies: s?.cookies?.length ?? 0,
      sessionOrigins: s?.origins?.length ?? 0,
      sessionHeaders: Object.keys(s?.headers ?? {}).length,
    },
  };
}

// Parse Set-Cookie response headers into Puppeteer-shaped cookie objects.
function parseSetCookies(setCookies: string[], reqUrl: string): Array<Record<string, unknown>> {
  const host = (() => {
    try {
      return new URL(reqUrl).hostname;
    } catch {
      return "";
    }
  })();
  const out: Array<Record<string, unknown>> = [];
  for (const sc of setCookies) {
    const [nv, ...attrs] = sc.split(";").map((p) => p.trim());
    const eq = nv.indexOf("=");
    if (eq < 0) continue;
    const cookie: Record<string, unknown> = {
      name: nv.slice(0, eq),
      value: nv.slice(eq + 1),
      path: "/",
      domain: host,
    };
    for (const a of attrs) {
      const [k, v] = a.split("=");
      const lk = k.toLowerCase();
      if (lk === "domain" && v) cookie.domain = v.replace(/^\./, "");
      else if (lk === "path" && v) cookie.path = v;
      else if (lk === "httponly") cookie.httpOnly = true;
      else if (lk === "secure") cookie.secure = true;
      else if (lk === "samesite" && v)
        cookie.sameSite = v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(); // Lax/Strict/None
    }
    out.push(cookie);
  }
  return out;
}
// Read a dot-path (e.g. "data.token") out of a parsed JSON value.
function getJsonPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      obj,
    );
}

app.get("/api/projects/:id/environments", (req, res) => {
  res.json({ environments: listEnvironments(req.params.id).map(sanitizeEnv) });
});
app.post("/api/projects/:id/environments", (req, res) => {
  const { name, baseUrl, vars, headers, query, login, isDefault } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const environment = upsertEnvironment({
    projectId: req.params.id,
    id: req.body?.id,
    name,
    baseUrl: baseUrl ?? "",
    vars: vars ?? {},
    headers: headers ?? {},
    query: query ?? {},
    // No `session` key here → upsert preserves any captured session.
    login: login ?? {},
    isDefault: !!isDefault,
  });
  res.json({ environment: sanitizeEnv(environment) });
});
app.delete("/api/environments/:id", (req, res) => {
  deleteEnvironment(req.params.id);
  res.json({ ok: true });
});

// Capture login state: run the env's login flow once, then read cookies + localStorage
// into a reusable storageState. Subsequent runs inject it and SKIP the login steps.
app.post("/api/environments/:id/capture-session", async (req, res) => {
  const env = getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: "environment not found" });
  const steps = env.login?.steps ?? [];
  if (!steps.length)
    return res.status(400).json({ error: "this environment has no login steps to run" });
  const ctx: ResolveContext = { env: env.vars, secrets: getSecretValues(env.projectId) };
  const secretVals = Object.values(ctx.secrets);
  const url = resolveText(env.baseUrl || getProject(env.projectId)?.targetUrl || "", ctx);
  if (!url) return res.status(400).json({ error: "no baseUrl set for this environment" });

  let session: Awaited<ReturnType<typeof launchSession>> | undefined;
  try {
    session = await launchSession(url, {
      extraHeaders: resolveMap(env.headers, ctx),
      query: resolveMap(env.query, ctx),
    });
    const log: string[] = [];
    for (const t of steps) {
      log.push(redact(`login: ${t}`, secretVals));
      await session.agent.aiAction(resolveText(t, ctx));
    }
    const cookies = await session.page.cookies();
    const ls = await session.page.evaluate(() => {
      const items: { name: string; value: string }[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k != null) items.push({ name: k, value: window.localStorage.getItem(k) ?? "" });
      }
      return { origin: location.origin, items };
    });
    const storageState: StorageState = {
      cookies: cookies as unknown as StorageState["cookies"],
      origins: ls.items.length ? [{ origin: ls.origin, localStorage: ls.items }] : [],
    };
    const capturedAt = new Date().toISOString();
    const saved = upsertEnvironment({
      ...env,
      login: { ...env.login, authRequired: true, session: storageState, capturedAt },
    });
    res.json({
      ok: true,
      cookies: storageState.cookies.length,
      localStorage: ls.items.length,
      log,
      environment: sanitizeEnv(saved),
    });
  } catch (e) {
    res.status(502).json({ error: `capture failed: ${(e as Error).message}` });
  } finally {
    await session?.cleanup?.();
  }
});

// API-style login (method C): call the login endpoint directly, capture the session
// cookie and/or a token (→ auth header) from the response — no UI driving. Stored as the
// same session that runs inject + skip login. Credentials come from ${env}/${secret}.
app.post("/api/environments/:id/api-login", async (req, res) => {
  const env = getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: "environment not found" });
  const cfg = env.login?.apiLogin;
  if (!cfg?.url) return res.status(400).json({ error: "no API-login endpoint configured" });
  const ctx: ResolveContext = { env: env.vars, secrets: getSecretValues(env.projectId) };
  const secretVals = Object.values(ctx.secrets);
  try {
    const url = resolveText(cfg.url, ctx);
    const method = (cfg.method || "POST").toUpperCase();
    const headers: Record<string, string> = {
      "content-type": cfg.contentType || "application/json",
      ...resolveMap(cfg.headers ?? {}, ctx),
    };
    const body = method === "GET" || !cfg.body ? undefined : resolveText(cfg.body, ctx);
    const resp = await fetch(url, { method, headers, body });

    const setCookies =
      typeof (resp.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (resp.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [];
    const cookies = parseSetCookies(setCookies, url);

    const capturedHeaders: Record<string, string> = {};
    let tokenFound = false;
    if (cfg.tokenPath) {
      let json: unknown;
      try {
        json = await resp.json();
      } catch {
        json = undefined;
      }
      const token = json !== undefined ? getJsonPath(json, cfg.tokenPath) : undefined;
      if (typeof token === "string" && token) {
        capturedHeaders[cfg.tokenHeader || "Authorization"] = (cfg.tokenPrefix ?? "Bearer ") + token;
        tokenFound = true;
      }
    }

    if (!resp.ok)
      return res.status(502).json({ error: `login endpoint returned HTTP ${resp.status}` });
    if (!cookies.length && !tokenFound)
      return res
        .status(502)
        .json({ error: "no session cookie and no token found in the login response" });

    const session: StorageState = {
      cookies,
      origins: [],
      headers: Object.keys(capturedHeaders).length ? capturedHeaders : undefined,
    };
    const capturedAt = new Date().toISOString();
    const saved = upsertEnvironment({
      ...env,
      login: { ...env.login, authRequired: true, session, capturedAt },
    });
    res.json({
      ok: true,
      status: resp.status,
      cookies: cookies.length,
      token: tokenFound,
      environment: sanitizeEnv(saved),
    });
  } catch (e) {
    res.status(502).json({ error: `API login failed: ${redact((e as Error).message, secretVals)}` });
  }
});

// Normalize a pasted cookie array into Puppeteer-shaped cookies (fill domain/path/sameSite).
function normalizeCookies(list: unknown[], host: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const o = { ...(c as Record<string, unknown>) };
    if (typeof o.name !== "string" || o.value === undefined) continue;
    if (!o.domain && host) o.domain = host;
    if (!o.path) o.path = "/";
    if (typeof o.sameSite === "string")
      o.sameSite = o.sameSite.charAt(0).toUpperCase() + o.sameSite.slice(1).toLowerCase();
    out.push(o);
  }
  return out;
}
// Parse a pasted session: a Playwright storageState JSON ({cookies,origins}), a raw cookie
// array, or a `name=value; name2=value2` Cookie header string (domain from the env host).
function parsePastedSession(raw: string, host: string): StorageState | null {
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return { cookies: normalizeCookies(j, host), origins: [] };
    if (j && typeof j === "object" && (Array.isArray(j.cookies) || Array.isArray(j.origins))) {
      return {
        cookies: normalizeCookies(Array.isArray(j.cookies) ? j.cookies : [], host),
        origins: Array.isArray(j.origins) ? j.origins : [],
        headers: j.headers && typeof j.headers === "object" ? j.headers : undefined,
      };
    }
  } catch {
    /* not JSON — fall through to cookie-header parsing */
  }
  const cookies = raw
    .replace(/^cookie:\s*/i, "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return null;
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: host, path: "/" };
    })
    .filter(Boolean) as Array<Record<string, unknown>>;
  return cookies.length ? { cookies, origins: [] } : null;
}

// Paste a session directly (method B): a cookie string or a storageState JSON → stored as
// the session that runs inject + skip login. No login run needed.
app.post("/api/environments/:id/set-session", (req, res) => {
  const env = getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: "environment not found" });
  const raw = typeof req.body?.raw === "string" ? req.body.raw.trim() : "";
  if (!raw) return res.status(400).json({ error: "paste a cookie string or a storageState JSON" });
  const ctx: ResolveContext = { env: env.vars, secrets: getSecretValues(env.projectId) };
  const host = (() => {
    try {
      return new URL(
        resolveText(env.baseUrl || getProject(env.projectId)?.targetUrl || "", ctx),
      ).hostname;
    } catch {
      return "";
    }
  })();
  const session = parsePastedSession(raw, host);
  if (!session || (!session.cookies.length && !session.origins.length))
    return res.status(400).json({ error: "could not parse any cookies or storageState" });
  const saved = upsertEnvironment({
    ...env,
    login: { ...env.login, authRequired: true, session, capturedAt: new Date().toISOString() },
  });
  res.json({
    ok: true,
    cookies: session.cookies.length,
    origins: session.origins.length,
    environment: sanitizeEnv(saved),
  });
});

// Clear a captured session (revert to running the UI login flow each run).
app.delete("/api/environments/:id/session", (req, res) => {
  const env = getEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: "environment not found" });
  const saved = upsertEnvironment({
    ...env,
    login: { ...env.login, session: null, capturedAt: undefined },
  });
  res.json({ ok: true, environment: sanitizeEnv(saved) });
});

/* ---- secrets vault (metadata in/out; plaintext only ever set, never read back) ---- */
app.get("/api/projects/:id/secrets", (req, res) => {
  res.json({ secrets: listSecretMeta(req.params.id) });
});
app.post("/api/projects/:id/secrets", (req, res) => {
  const { key, value } = req.body ?? {};
  if (!key || typeof value !== "string")
    return res.status(400).json({ error: "key and value are required" });
  const secret = setSecret(req.params.id, key, value);
  res.json({ secret }); // returns metadata only — never the value
});
app.delete("/api/projects/:id/secrets/:key", (req, res) => {
  deleteSecret(req.params.id, req.params.key);
  res.json({ ok: true });
});

/* ---- scale: suite runs through the concurrency queue + CI gate ---- */
// Run a suite (filter: "P0" | "P1" | "P2" | "all") via the bounded queue, self-healing
// each case. Quarantined cases run but are excluded from the pass/fail gate (CI门禁).
app.post("/api/projects/:id/suite", async (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "project not found" });
  const filter = String(req.body?.filter || "P0");
  const retries = Math.max(0, Number(req.body?.retries ?? 1));
  const all = listCases(project.id);
  const cases = filter === "all" ? all : all.filter((c) => c.priority === filter);
  if (!cases.length) return res.status(400).json({ error: `no ${filter} cases to run` });

  const batch = createBatch(project.id, `${filter} suite · ${cases.length} cases`);
  updateBatch(batch.id, { total: cases.length });

  // Fan out: each case flows through the queue (bounded concurrency) and self-heals.
  await Promise.all(
    cases.map((c) =>
      enqueue(async () => {
        try {
          const { run, attempts, healed } = await runCaseDataDriven(c, req.body ?? {}, retries);
          const quarantined = !!getCase(c.id)?.quarantined;
          const outcome = run.infraError ? "error" : run.status === "passed" ? "passed" : "failed";
          addBatchRun({
            batchId: batch.id,
            caseId: c.id,
            caseTitle: c.title,
            runId: run.id,
            status: quarantined && outcome !== "error" ? "quarantined" : outcome,
            attempts,
            healed,
          });
        } catch {
          addBatchRun({
            batchId: batch.id,
            caseId: c.id,
            caseTitle: c.title,
            status: getCase(c.id)?.quarantined ? "quarantined" : "failed",
            attempts: 1,
            healed: false,
          });
        }
      }, `${filter}:${c.title.slice(0, 28)}`),
    ),
  );

  // Aggregate + CI gate. A real failure fails the gate; an infra/model error means
  // "no verdict" so it also blocks a green gate (can't confirm pass) but is reported
  // distinctly and excluded from flake stats. Quarantined cases never affect the gate.
  const items = getBatchRuns(batch.id);
  const passed = items.filter((i) => i.status === "passed").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const errored = items.filter((i) => i.status === "error").length;
  const quarantined = items.filter((i) => i.status === "quarantined").length;
  const healed = items.filter((i) => i.healed).length;
  const flaky = cases.filter((c) => getFlakiness(c.id)?.verdict === "flaky").length;
  const gate: Batch["gate"] = failed > 0 || errored > 0 ? "fail" : "pass";
  updateBatch(batch.id, {
    status: "done",
    total: items.length,
    passed,
    failed,
    healed,
    flaky,
    quarantined,
    errored,
    gate,
    finishedAt: new Date().toISOString(),
  });
  res.json({ batch: getBatch(batch.id), items, gate });
});

app.get("/api/queue", (_req, res) => res.json(queueStatus()));
app.get("/api/projects/:id/batches", (req, res) =>
  res.json({ batches: listBatches(req.params.id) }),
);
app.get("/api/batches/:id", (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: "batch not found" });
  res.json({ batch, items: getBatchRuns(batch.id) });
});
app.get("/api/projects/:id/flakiness", (req, res) =>
  res.json({ flakiness: listFlakiness(req.params.id) }),
);
app.post("/api/cases/:id/recompute-flakiness", (req, res) => {
  if (!getCase(req.params.id)) return res.status(404).json({ error: "case not found" });
  res.json({ flakiness: computeFlakiness(req.params.id) });
});

// Trend dashboard: pass rate / flake rate / MTTR / coverage + per-batch/day series.
app.get("/api/projects/:id/trends", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ error: "project not found" });
  res.json(computeTrends(req.params.id));
});

/* ---- global settings: LLM-debug toggle + editable prompt templates ---- */
app.get("/api/settings", (_req, res) => {
  res.json({ settings: getSettings(), defaults: DEFAULT_PROMPTS });
});
app.post("/api/settings", (req, res) => {
  const patch: Partial<Awaited<ReturnType<typeof getSettings>>> = {};
  if (typeof req.body?.debugLLM === "boolean") patch.debugLLM = req.body.debugLLM;
  if (typeof req.body?.enforceLang === "boolean") patch.enforceLang = req.body.enforceLang;
  if (req.body?.prompts && typeof req.body.prompts === "object") patch.prompts = req.body.prompts;
  res.json({ settings: updateSettings(patch) });
});
app.post("/api/settings/reset-prompts", (_req, res) => {
  res.json({ settings: resetPrompts() });
});
// Recent LLM-debug captures (metadata) for the UI — actual payloads live as files.
app.get("/api/llm-debug", (_req, res) => {
  try {
    if (!existsSync(LLM_DEBUG_DIR)) return res.json({ on: getSettings().debugLLM, entries: [] });
    const files = readdirSync(LLM_DEBUG_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .slice(-50)
      .reverse();
    res.json({ on: getSettings().debugLLM, dir: LLM_DEBUG_DIR, entries: files });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

seedIfEmpty();
app.listen(PORT, () => log(`server listening on http://localhost:${PORT}`));
