import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { encryptSecret, decryptSecret } from "./vault.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "..", ".data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(resolve(DATA_DIR, "testpilot.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, targetUrl TEXT NOT NULL, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS test_cases (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'P1',
  priorityReason TEXT DEFAULT '',
  runStatus TEXT NOT NULL DEFAULT 'notRun',
  hasCode INTEGER NOT NULL DEFAULT 0,
  precondition TEXT DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  code TEXT DEFAULT '',
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  caseId TEXT NOT NULL,
  caseTitle TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  durationMs INTEGER NOT NULL,
  startedAt TEXT NOT NULL,
  failureReason TEXT,
  logs TEXT NOT NULL DEFAULT '[]',
  screenshots TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_cases_project ON test_cases(projectId);
CREATE INDEX IF NOT EXISTS idx_runs_case ON runs(caseId);

-- Visual baseline: one approved reference image per (case, step).
CREATE TABLE IF NOT EXISTS baselines (
  id TEXT PRIMARY KEY,
  caseId TEXT NOT NULL,
  stepIdx INTEGER NOT NULL,
  imgPath TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(caseId, stepIdx)
);
CREATE INDEX IF NOT EXISTS idx_baselines_case ON baselines(caseId);

-- Performance baseline: one metrics snapshot per case.
CREATE TABLE IF NOT EXISTS perf_baselines (
  caseId TEXT PRIMARY KEY,
  metricsJson TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- Environments: per-project target + non-secret variables + a central login flow
-- (login state) reused across cases. varsJson holds env.* placeholder values;
-- loginJson = { authRequired: bool, steps: string[] } (steps may reference env/secret vars).
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  name TEXT NOT NULL,
  baseUrl TEXT NOT NULL DEFAULT '',
  varsJson TEXT NOT NULL DEFAULT '{}',
  loginJson TEXT NOT NULL DEFAULT '{}',
  headersJson TEXT NOT NULL DEFAULT '{}',   -- fixed request headers (may hold secret refs)
  queryJson TEXT NOT NULL DEFAULT '{}',     -- fixed query-string params appended to navigations
  sessionEnc TEXT NOT NULL DEFAULT '',      -- captured login state (storageState), AES-encrypted
  isDefault INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  UNIQUE(projectId, name)
);
CREATE INDEX IF NOT EXISTS idx_env_project ON environments(projectId);

-- Secrets vault: value stored ONLY as AES-256-GCM ciphertext (see vault.ts).
-- The plaintext never touches this DB. Scoped per project (envId optional override).
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  envId TEXT,
  key TEXT NOT NULL,
  valueEnc TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(projectId, envId, key)
);
CREATE INDEX IF NOT EXISTS idx_secrets_project ON secrets(projectId);

-- Suite/batch runs: a fan-out of cases through the concurrency queue, with a
-- CI gate (pass/fail) and flake accounting. One batches row per suite run.
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,                       -- running | done
  total INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  healed INTEGER NOT NULL DEFAULT 0,          -- passed only after a self-heal retry
  flaky INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,     -- ran but excluded from the gate
  errored INTEGER NOT NULL DEFAULT 0,         -- infra/model errors (no verdict)
  gate TEXT NOT NULL DEFAULT 'pass',          -- pass | fail (CI门禁)
  startedAt TEXT NOT NULL,
  finishedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_batches_project ON batches(projectId);
CREATE TABLE IF NOT EXISTS batch_runs (
  batchId TEXT NOT NULL,
  caseId TEXT NOT NULL,
  caseTitle TEXT NOT NULL,
  runId TEXT,
  status TEXT NOT NULL,                       -- passed | failed | quarantined
  attempts INTEGER NOT NULL DEFAULT 1,
  healed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batchId, caseId)
);

-- Per-case flake governance: stability over a rolling window of recent runs.
CREATE TABLE IF NOT EXISTS flakiness (
  caseId TEXT PRIMARY KEY,
  windowSize INTEGER NOT NULL,
  passes INTEGER NOT NULL,
  fails INTEGER NOT NULL,
  healedCount INTEGER NOT NULL,
  failRate REAL NOT NULL,
  verdict TEXT NOT NULL,                      -- stable | flaky | broken | unknown
  updatedAt TEXT NOT NULL
);
`);

// Migrations: add columns if missing (DB may predate them).
const runCols = new Set(
  (db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((r) => r.name),
);
if (!runCols.has("reportPath")) db.exec("ALTER TABLE runs ADD COLUMN reportPath TEXT");
if (!runCols.has("visualJson"))
  db.exec("ALTER TABLE runs ADD COLUMN visualJson TEXT NOT NULL DEFAULT '[]'");
if (!runCols.has("tokens")) db.exec("ALTER TABLE runs ADD COLUMN tokens INTEGER");
if (!runCols.has("perfJson")) db.exec("ALTER TABLE runs ADD COLUMN perfJson TEXT");
if (!runCols.has("oracleJson"))
  db.exec("ALTER TABLE runs ADD COLUMN oracleJson TEXT NOT NULL DEFAULT '[]'");
// Flake governance: how many attempts a run took, and whether it only passed after a self-heal.
if (!runCols.has("attempts"))
  db.exec("ALTER TABLE runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1");
if (!runCols.has("healed"))
  db.exec("ALTER TABLE runs ADD COLUMN healed INTEGER NOT NULL DEFAULT 0");
// Infra/model error (couldn't get a verdict) vs a real test failure — kept out of flake/MTTR.
if (!runCols.has("infraError")) {
  db.exec("ALTER TABLE runs ADD COLUMN infraError INTEGER NOT NULL DEFAULT 0");
  // Backfill: reclassify historical model/network failures so old flake stats self-correct.
  db.exec(
    "UPDATE runs SET infraError=1 WHERE status='failed' AND (" +
      "failureReason LIKE '%AI model service%' OR failureReason LIKE '%terminated%' OR " +
      "failureReason LIKE '%ECONNREFUSED%' OR failureReason LIKE '%502%' OR failureReason LIKE '%timeout%')",
  );
}
const caseCols = new Set(
  (db.prepare("PRAGMA table_info(test_cases)").all() as { name: string }[]).map((r) => r.name),
);
if (!caseCols.has("expected"))
  db.exec("ALTER TABLE test_cases ADD COLUMN expected TEXT DEFAULT ''");
// Case spec upgrade (§3.2 gold-standard): design type, requirement trace, env binding, cleanup.
if (!caseCols.has("type"))
  db.exec("ALTER TABLE test_cases ADD COLUMN type TEXT NOT NULL DEFAULT 'functional'");
if (!caseCols.has("requirementId"))
  db.exec("ALTER TABLE test_cases ADD COLUMN requirementId TEXT DEFAULT ''");
if (!caseCols.has("envRef"))
  db.exec("ALTER TABLE test_cases ADD COLUMN envRef TEXT DEFAULT ''");
if (!caseCols.has("postSteps"))
  db.exec("ALTER TABLE test_cases ADD COLUMN postSteps TEXT NOT NULL DEFAULT '[]'");
if (!caseCols.has("quarantined"))
  db.exec("ALTER TABLE test_cases ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0");
if (!caseCols.has("dataKey"))
  db.exec("ALTER TABLE test_cases ADD COLUMN dataKey TEXT DEFAULT ''");
const batchCols = new Set(
  (db.prepare("PRAGMA table_info(batches)").all() as { name: string }[]).map((r) => r.name),
);
if (batchCols.size && !batchCols.has("errored"))
  db.exec("ALTER TABLE batches ADD COLUMN errored INTEGER NOT NULL DEFAULT 0");
// Data-binding upgrade: fixed request headers, query params, and captured login state.
const envCols = new Set(
  (db.prepare("PRAGMA table_info(environments)").all() as { name: string }[]).map((r) => r.name),
);
if (envCols.size && !envCols.has("headersJson"))
  db.exec("ALTER TABLE environments ADD COLUMN headersJson TEXT NOT NULL DEFAULT '{}'");
if (envCols.size && !envCols.has("queryJson"))
  db.exec("ALTER TABLE environments ADD COLUMN queryJson TEXT NOT NULL DEFAULT '{}'");
if (envCols.size && !envCols.has("sessionEnc"))
  db.exec("ALTER TABLE environments ADD COLUMN sessionEnc TEXT NOT NULL DEFAULT ''");

export type Priority = "P0" | "P1" | "P2";
export type RunStatus = "passed" | "failed" | "notRun" | "running";

export interface Project {
  id: string;
  name: string;
  targetUrl: string;
  createdAt: string;
}
export interface Step {
  order: number;
  text: string;
}
export type CaseType = "functional" | "negative" | "boundary" | "e2e";
export interface TestCase {
  id: string;
  projectId: string;
  title: string;
  priority: Priority;
  priorityReason: string;
  runStatus: RunStatus;
  hasCode: boolean;
  precondition?: string;
  expected?: string; // the functional oracle: what "passed" means for this case
  type: CaseType; // test-design category (equivalence/boundary/negative/e2e)
  requirementId?: string; // trace back to a requirement/PRD item
  envRef?: string; // environment name this case binds to ("" = project default)
  dataKey?: string; // env array var to iterate — data-driven: one run per row (${row}/${row.col})
  postSteps: Step[]; // cleanup / teardown actions
  quarantined: boolean; // flaky → runs but excluded from the CI gate
  steps: Step[];
  code?: string;
  createdAt: string;
}

// A captured browser session (Playwright-compatible storageState shape) — cookies plus
// per-origin localStorage. Injected before navigation so runs start authenticated.
export interface StorageState {
  cookies: Array<Record<string, unknown>>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}
// Environment: per-project target + non-secret vars + a reusable login flow.
export interface LoginFlow {
  authRequired?: boolean; // when true, cases run the login steps first
  steps?: string[]; // login actions; may reference env/secret placeholders
  session?: StorageState | null; // captured login state — when present, injected + login SKIPPED
  capturedAt?: string; // when the session was captured (for staleness display)
}
export interface Environment {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  // Value may be an array (data-driven / multi-value); ${env.KEY.N} picks an element.
  vars: Record<string, string | string[]>;
  headers: Record<string, string>; // fixed request headers (may hold ${env}/${secret} refs)
  query: Record<string, string>; // fixed query-string params appended to navigations
  login: LoginFlow;
  isDefault: boolean;
  createdAt: string;
}
// Secret: metadata only — the plaintext value is never returned to the client.
export interface SecretMeta {
  id: string;
  projectId: string;
  envId?: string;
  key: string;
  updatedAt: string;
}
export type VisualStatus = "new_baseline" | "match" | "diff";
export interface VisualDiff {
  stepIdx: number;
  status: VisualStatus;
  mismatchPct: number;
  baselineRef?: string; // artifact filename served by /api/artifacts/:name
  currentRef?: string;
  diffRef?: string;
}
export interface Baseline {
  id: string;
  caseId: string;
  stepIdx: number;
  imgPath: string;
  updatedAt: string;
}
export interface OracleCheck {
  assertion: string; // the expected condition that was verified
  status: "pass" | "fail";
  detail?: string;
}
export interface RunRecord {
  id: string;
  caseId: string;
  caseTitle: string;
  priority: Priority;
  status: Exclude<RunStatus, "notRun">;
  durationMs: number;
  startedAt: string;
  failureReason?: string;
  logs: string[];
  screenshots?: string[];
  reportPath?: string;
  tokens?: number;
  visual?: VisualDiff[];
  perf?: unknown; // PerfResult from perf.ts (stored opaque to avoid coupling)
  oracle?: OracleCheck[];
  attempts?: number; // how many tries this run took (1 = passed first time)
  healed?: boolean; // passed only after a self-heal retry → a flake signal
  infraError?: boolean; // model/network failure — not a real test failure; excluded from flake/MTTR
}

export type FlakeVerdict = "stable" | "flaky" | "broken" | "unknown";
export interface Flakiness {
  caseId: string;
  windowSize: number;
  passes: number;
  fails: number;
  healedCount: number;
  failRate: number;
  verdict: FlakeVerdict;
  updatedAt: string;
}
export interface Batch {
  id: string;
  projectId: string;
  label: string;
  status: "running" | "done";
  total: number;
  passed: number;
  failed: number;
  healed: number;
  flaky: number;
  quarantined: number;
  errored: number; // infra/model errors — no verdict, not counted as test failures
  gate: "pass" | "fail";
  startedAt: string;
  finishedAt?: string;
}
export interface BatchRun {
  batchId: string;
  caseId: string;
  caseTitle: string;
  runId?: string;
  status: "passed" | "failed" | "quarantined" | "error";
  attempts: number;
  healed: boolean;
}

/* ---- serialization ---- */
type CaseRow = Omit<TestCase, "steps" | "postSteps" | "hasCode" | "quarantined"> & {
  steps: string;
  postSteps: string;
  hasCode: number;
  quarantined: number;
};
const rowToCase = (r: CaseRow): TestCase => ({
  ...r,
  hasCode: !!r.hasCode,
  quarantined: !!r.quarantined,
  type: r.type || "functional",
  postSteps: JSON.parse(r.postSteps || "[]"),
  steps: JSON.parse(r.steps || "[]"),
});
type RunRow = Omit<
  RunRecord,
  "logs" | "screenshots" | "visual" | "perf" | "oracle" | "healed" | "infraError"
> & {
  logs: string;
  screenshots: string;
  visualJson: string | null;
  perfJson: string | null;
  oracleJson: string | null;
  healed: number;
  infraError: number;
};
const rowToRun = (r: RunRow): RunRecord => ({
  ...r,
  logs: JSON.parse(r.logs || "[]"),
  screenshots: JSON.parse(r.screenshots || "[]"),
  visual: JSON.parse(r.visualJson || "[]"),
  perf: r.perfJson ? JSON.parse(r.perfJson) : undefined,
  oracle: JSON.parse(r.oracleJson || "[]"),
  healed: !!r.healed,
  infraError: !!r.infraError,
});

let seq = 1000;
export const newId = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

/* ---- projects ---- */
export const listProjects = (): Project[] =>
  db.prepare("SELECT * FROM projects ORDER BY createdAt").all() as Project[];
export const getProject = (id: string): Project | undefined =>
  db.prepare("SELECT * FROM projects WHERE id=?").get(id) as Project | undefined;
export function createProject(name: string, targetUrl: string): Project {
  const p: Project = { id: newId("prj"), name, targetUrl, createdAt: new Date().toISOString() };
  db.prepare("INSERT INTO projects (id,name,targetUrl,createdAt) VALUES (?,?,?,?)").run(
    p.id, p.name, p.targetUrl, p.createdAt,
  );
  return p;
}

/* ---- cases ---- */
export const listCases = (projectId?: string): TestCase[] =>
  (
    projectId
      ? (db.prepare("SELECT * FROM test_cases WHERE projectId=? ORDER BY createdAt").all(projectId) as CaseRow[])
      : (db.prepare("SELECT * FROM test_cases ORDER BY createdAt").all() as CaseRow[])
  ).map(rowToCase);
export const getCase = (id: string): TestCase | undefined => {
  const r = db.prepare("SELECT * FROM test_cases WHERE id=?").get(id) as CaseRow | undefined;
  return r ? rowToCase(r) : undefined;
};
export function createCase(input: Partial<TestCase> & { projectId: string; title: string }): TestCase {
  const c: TestCase = {
    id: input.id || newId("tc"),
    projectId: input.projectId,
    title: input.title,
    priority: input.priority || "P1",
    priorityReason: input.priorityReason || "",
    runStatus: input.runStatus || "notRun",
    hasCode: input.hasCode ?? !!input.code,
    precondition: input.precondition || "",
    expected: input.expected || "",
    type: input.type || "functional",
    requirementId: input.requirementId || "",
    envRef: input.envRef || "",
    dataKey: input.dataKey || "",
    postSteps: input.postSteps || [],
    quarantined: input.quarantined ?? false,
    steps: input.steps || [],
    code: input.code || "",
    createdAt: input.createdAt || new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO test_cases (id,projectId,title,priority,priorityReason,runStatus,hasCode,precondition,expected,type,requirementId,envRef,dataKey,postSteps,quarantined,steps,code,createdAt)
     VALUES (@id,@projectId,@title,@priority,@priorityReason,@runStatus,@hasCode,@precondition,@expected,@type,@requirementId,@envRef,@dataKey,@postSteps,@quarantined,@steps,@code,@createdAt)`,
  ).run({
    ...c,
    hasCode: c.hasCode ? 1 : 0,
    quarantined: c.quarantined ? 1 : 0,
    postSteps: JSON.stringify(c.postSteps),
    steps: JSON.stringify(c.steps),
  });
  return c;
}
export function updateCase(id: string, patch: Partial<TestCase>): TestCase | undefined {
  const cur = getCase(id);
  if (!cur) return undefined;
  const next: TestCase = {
    ...cur,
    ...patch,
    steps: patch.steps ?? cur.steps,
    postSteps: patch.postSteps ?? cur.postSteps,
    hasCode: patch.hasCode ?? (patch.code !== undefined ? !!patch.code : cur.hasCode),
  };
  db.prepare(
    `UPDATE test_cases SET title=@title,priority=@priority,priorityReason=@priorityReason,
     runStatus=@runStatus,hasCode=@hasCode,precondition=@precondition,expected=@expected,
     type=@type,requirementId=@requirementId,envRef=@envRef,dataKey=@dataKey,postSteps=@postSteps,quarantined=@quarantined,steps=@steps,code=@code WHERE id=@id`,
  ).run({
    ...next,
    expected: next.expected ?? "",
    requirementId: next.requirementId ?? "",
    envRef: next.envRef ?? "",
    dataKey: next.dataKey ?? "",
    hasCode: next.hasCode ? 1 : 0,
    quarantined: next.quarantined ? 1 : 0,
    postSteps: JSON.stringify(next.postSteps ?? []),
    steps: JSON.stringify(next.steps),
  });
  return next;
}
export const deleteCase = (id: string): void => {
  db.prepare("DELETE FROM test_cases WHERE id=?").run(id);
};

/* ---- runs ---- */
export const getRun = (id: string): RunRecord | undefined => {
  const r = db.prepare("SELECT * FROM runs WHERE id=?").get(id) as RunRow | undefined;
  return r ? rowToRun(r) : undefined;
};
export const listRuns = (caseId?: string): RunRecord[] =>
  (
    caseId
      ? (db.prepare("SELECT * FROM runs WHERE caseId=? ORDER BY startedAt DESC").all(caseId) as RunRow[])
      : (db.prepare("SELECT * FROM runs ORDER BY startedAt DESC LIMIT 200").all() as RunRow[])
  ).map(rowToRun);
// Project-scoped runs for the Runs page. Runs is the SUITE (batch) execution ledger,
// so it only lists runs that came from a suite (id present in batch_runs). Ad-hoc
// single-case runs are viewed inline in the case detail, not here.
export const listRunsByProject = (projectId: string): RunRecord[] =>
  (
    db
      .prepare(
        `SELECT r.* FROM runs r
         JOIN test_cases c ON c.id = r.caseId
         WHERE c.projectId = ?
           AND r.id IN (SELECT runId FROM batch_runs WHERE runId IS NOT NULL)
         ORDER BY r.startedAt DESC LIMIT 200`,
      )
      .all(projectId) as RunRow[]
  ).map(rowToRun);
export function createRun(r: Omit<RunRecord, "id">): RunRecord {
  const run: RunRecord = { ...r, id: newId("run") };
  db.prepare(
    `INSERT INTO runs (id,caseId,caseTitle,priority,status,durationMs,startedAt,failureReason,logs,screenshots,reportPath,tokens,visualJson,perfJson,oracleJson,attempts,healed,infraError)
     VALUES (@id,@caseId,@caseTitle,@priority,@status,@durationMs,@startedAt,@failureReason,@logs,@screenshots,@reportPath,@tokens,@visualJson,@perfJson,@oracleJson,@attempts,@healed,@infraError)`,
  ).run({
    ...run,
    failureReason: run.failureReason ?? null,
    logs: JSON.stringify(run.logs),
    screenshots: JSON.stringify(run.screenshots ?? []),
    reportPath: run.reportPath ?? null,
    tokens: run.tokens ?? null,
    visualJson: JSON.stringify(run.visual ?? []),
    perfJson: run.perf ? JSON.stringify(run.perf) : null,
    oracleJson: JSON.stringify(run.oracle ?? []),
    attempts: run.attempts ?? 1,
    healed: run.healed ? 1 : 0,
    infraError: run.infraError ? 1 : 0,
  });
  return run;
}

/* ---- artifacts + visual baselines ---- */
export const ARTIFACT_DIR = resolve(DATA_DIR, "artifacts");
for (const sub of ["reports", "baselines", "current", "diff"])
  mkdirSync(resolve(ARTIFACT_DIR, sub), { recursive: true });

export const getBaseline = (caseId: string, stepIdx: number): Baseline | undefined =>
  db.prepare("SELECT * FROM baselines WHERE caseId=? AND stepIdx=?").get(caseId, stepIdx) as
    | Baseline
    | undefined;
export const listBaselines = (caseId: string): Baseline[] =>
  db.prepare("SELECT * FROM baselines WHERE caseId=? ORDER BY stepIdx").all(caseId) as Baseline[];
export function upsertBaseline(caseId: string, stepIdx: number, imgPath: string): Baseline {
  const now = new Date().toISOString();
  const existing = getBaseline(caseId, stepIdx);
  if (existing) {
    db.prepare("UPDATE baselines SET imgPath=?, updatedAt=? WHERE id=?").run(imgPath, now, existing.id);
    return { ...existing, imgPath, updatedAt: now };
  }
  const b: Baseline = { id: newId("bl"), caseId, stepIdx, imgPath, updatedAt: now };
  db.prepare(
    "INSERT INTO baselines (id,caseId,stepIdx,imgPath,updatedAt) VALUES (?,?,?,?,?)",
  ).run(b.id, b.caseId, b.stepIdx, b.imgPath, b.updatedAt);
  return b;
}

// Attach report / tokens / visual / perf / oracle results to a run after processing.
export function updateRunResults(
  id: string,
  patch: {
    reportPath?: string;
    tokens?: number;
    visual?: VisualDiff[];
    perf?: unknown;
    oracle?: OracleCheck[];
  },
): void {
  const cur = db
    .prepare("SELECT reportPath, tokens, visualJson, perfJson, oracleJson FROM runs WHERE id=?")
    .get(id) as
    | { reportPath: string | null; tokens: number | null; visualJson: string | null; perfJson: string | null; oracleJson: string | null }
    | undefined;
  if (!cur) return;
  db.prepare(
    "UPDATE runs SET reportPath=?, tokens=?, visualJson=?, perfJson=?, oracleJson=? WHERE id=?",
  ).run(
    patch.reportPath ?? cur.reportPath ?? null,
    patch.tokens ?? cur.tokens ?? null,
    JSON.stringify(patch.visual ?? JSON.parse(cur.visualJson || "[]")),
    patch.perf !== undefined ? JSON.stringify(patch.perf) : cur.perfJson,
    JSON.stringify(patch.oracle ?? JSON.parse(cur.oracleJson || "[]")),
    id,
  );
}

/* ---- performance baselines ---- */
export const getPerfBaseline = (caseId: string): Record<string, number> | undefined => {
  const r = db.prepare("SELECT metricsJson FROM perf_baselines WHERE caseId=?").get(caseId) as
    | { metricsJson: string }
    | undefined;
  return r ? (JSON.parse(r.metricsJson) as Record<string, number>) : undefined;
};
export function upsertPerfBaseline(caseId: string, metrics: Record<string, number>): void {
  db.prepare(
    "INSERT INTO perf_baselines (caseId,metricsJson,updatedAt) VALUES (?,?,?) " +
      "ON CONFLICT(caseId) DO UPDATE SET metricsJson=excluded.metricsJson, updatedAt=excluded.updatedAt",
  ).run(caseId, JSON.stringify(metrics), new Date().toISOString());
}

/* ---- environments ---- */
type EnvRow = {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  varsJson: string;
  loginJson: string;
  headersJson: string;
  queryJson: string;
  sessionEnc: string;
  isDefault: number;
  createdAt: string;
};
const rowToEnv = (r: EnvRow): Environment => {
  const login: LoginFlow = JSON.parse(r.loginJson || "{}");
  // The session blob is stored encrypted in its own column, not in loginJson.
  if (r.sessionEnc) {
    try {
      login.session = JSON.parse(decryptSecret(r.sessionEnc)) as StorageState;
    } catch {
      login.session = null;
    }
  }
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    baseUrl: r.baseUrl,
    vars: JSON.parse(r.varsJson || "{}"),
    headers: JSON.parse(r.headersJson || "{}"),
    query: JSON.parse(r.queryJson || "{}"),
    login,
    isDefault: !!r.isDefault,
    createdAt: r.createdAt,
  };
};
export const listEnvironments = (projectId: string): Environment[] =>
  (db.prepare("SELECT * FROM environments WHERE projectId=? ORDER BY createdAt").all(projectId) as EnvRow[]).map(rowToEnv);
export const getEnvironment = (id: string): Environment | undefined => {
  const r = db.prepare("SELECT * FROM environments WHERE id=?").get(id) as EnvRow | undefined;
  return r ? rowToEnv(r) : undefined;
};
// Resolve which environment a case runs in: explicit name → that env; else the project default.
export function resolveEnvironment(projectId: string, envRef?: string): Environment | undefined {
  const envs = listEnvironments(projectId);
  if (envRef) {
    const byName = envs.find((e) => e.name === envRef || e.id === envRef);
    if (byName) return byName;
  }
  return envs.find((e) => e.isDefault) ?? envs[0];
}
export function upsertEnvironment(
  input: Partial<Environment> & { projectId: string; name: string },
): Environment {
  const existing = listEnvironments(input.projectId).find(
    (e) => e.id === input.id || e.name === input.name,
  );
  const env: Environment = {
    id: existing?.id || input.id || newId("env"),
    projectId: input.projectId,
    name: input.name,
    baseUrl: input.baseUrl ?? existing?.baseUrl ?? "",
    vars: input.vars ?? existing?.vars ?? {},
    headers: input.headers ?? existing?.headers ?? {},
    query: input.query ?? existing?.query ?? {},
    // Preserve the captured session across saves: the UI never round-trips the blob, so
    // only overwrite it when the caller explicitly provides `session` (object or null).
    login: input.login
      ? {
          ...input.login,
          session:
            input.login.session !== undefined
              ? input.login.session
              : existing?.login?.session ?? null,
        }
      : existing?.login ?? {},
    isDefault: input.isDefault ?? existing?.isDefault ?? false,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  // Session lives in its own encrypted column, not in loginJson.
  const { session, ...loginRest } = env.login;
  const sessionEnc = session ? encryptSecret(JSON.stringify(session)) : "";
  // Only one default per project.
  if (env.isDefault)
    db.prepare("UPDATE environments SET isDefault=0 WHERE projectId=?").run(env.projectId);
  db.prepare(
    `INSERT INTO environments (id,projectId,name,baseUrl,varsJson,loginJson,headersJson,queryJson,sessionEnc,isDefault,createdAt)
     VALUES (@id,@projectId,@name,@baseUrl,@varsJson,@loginJson,@headersJson,@queryJson,@sessionEnc,@isDefault,@createdAt)
     ON CONFLICT(id) DO UPDATE SET name=@name,baseUrl=@baseUrl,varsJson=@varsJson,loginJson=@loginJson,headersJson=@headersJson,queryJson=@queryJson,sessionEnc=@sessionEnc,isDefault=@isDefault`,
  ).run({
    id: env.id,
    projectId: env.projectId,
    name: env.name,
    baseUrl: env.baseUrl,
    varsJson: JSON.stringify(env.vars),
    loginJson: JSON.stringify(loginRest),
    headersJson: JSON.stringify(env.headers),
    queryJson: JSON.stringify(env.query),
    sessionEnc,
    isDefault: env.isDefault ? 1 : 0,
    createdAt: env.createdAt,
  });
  return env;
}
export const deleteEnvironment = (id: string): void => {
  db.prepare("DELETE FROM environments WHERE id=?").run(id);
};

/* ---- secrets vault (values stored encrypted; only metadata leaves the server) ---- */
export const listSecretMeta = (projectId: string): SecretMeta[] =>
  db
    .prepare("SELECT id,projectId,envId,key,updatedAt FROM secrets WHERE projectId=? ORDER BY key")
    .all(projectId) as SecretMeta[];
// Returns { KEY: plaintext } for a project (server-only; used at run/export time).
export function getSecretValues(projectId: string): Record<string, string> {
  const rows = db
    .prepare("SELECT key,valueEnc FROM secrets WHERE projectId=?")
    .all(projectId) as { key: string; valueEnc: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) {
    try {
      out[r.key] = decryptSecret(r.valueEnc);
    } catch {
      /* skip corrupt entry */
    }
  }
  return out;
}
export function setSecret(projectId: string, key: string, value: string): SecretMeta {
  const now = new Date().toISOString();
  const id = newId("sec");
  db.prepare(
    `INSERT INTO secrets (id,projectId,envId,key,valueEnc,updatedAt) VALUES (?,?,?,?,?,?)
     ON CONFLICT(projectId,envId,key) DO UPDATE SET valueEnc=excluded.valueEnc, updatedAt=excluded.updatedAt`,
  ).run(id, projectId, null, key, encryptSecret(value), now);
  return { id, projectId, key, updatedAt: now };
}
export function deleteSecret(projectId: string, key: string): void {
  db.prepare("DELETE FROM secrets WHERE projectId=? AND key=? AND envId IS NULL").run(projectId, key);
}

/* ---- flake governance ---- */
// Recompute a case's stability from its last `windowSize` runs and persist the verdict.
// broken = every run in the window failed; flaky = mixed pass/fail OR any self-heal;
// stable = all passed with no heals.
export function computeFlakiness(caseId: string, windowSize = 10): Flakiness {
  // Infra/model errors are excluded — they mean "no verdict", not a flaky test.
  const recent = (
    db
      .prepare(
        "SELECT status, healed FROM runs WHERE caseId=? AND infraError=0 ORDER BY startedAt DESC LIMIT ?",
      )
      .all(caseId, windowSize) as { status: string; healed: number }[]
  );
  const total = recent.length;
  const fails = recent.filter((r) => r.status === "failed").length;
  const passes = total - fails;
  const healedCount = recent.filter((r) => !!r.healed).length;
  const failRate = total ? fails / total : 0;
  let verdict: FlakeVerdict = "unknown";
  if (total > 0) {
    if (fails === total) verdict = "broken";
    else if (fails > 0 || healedCount > 0) verdict = "flaky";
    else verdict = "stable";
  }
  const f: Flakiness = {
    caseId,
    windowSize,
    passes,
    fails,
    healedCount,
    failRate: Math.round(failRate * 100) / 100,
    verdict,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO flakiness (caseId,windowSize,passes,fails,healedCount,failRate,verdict,updatedAt)
     VALUES (@caseId,@windowSize,@passes,@fails,@healedCount,@failRate,@verdict,@updatedAt)
     ON CONFLICT(caseId) DO UPDATE SET windowSize=@windowSize,passes=@passes,fails=@fails,
       healedCount=@healedCount,failRate=@failRate,verdict=@verdict,updatedAt=@updatedAt`,
  ).run(f);
  return f;
}
export const getFlakiness = (caseId: string): Flakiness | undefined =>
  db.prepare("SELECT * FROM flakiness WHERE caseId=?").get(caseId) as Flakiness | undefined;
export const listFlakiness = (projectId: string): Flakiness[] =>
  db
    .prepare(
      `SELECT f.* FROM flakiness f JOIN test_cases c ON c.id=f.caseId WHERE c.projectId=?`,
    )
    .all(projectId) as Flakiness[];

/* ---- batches (suite runs) ---- */
export function createBatch(projectId: string, label: string): Batch {
  const b: Batch = {
    id: newId("bat"),
    projectId,
    label,
    status: "running",
    total: 0,
    passed: 0,
    failed: 0,
    healed: 0,
    flaky: 0,
    quarantined: 0,
    errored: 0,
    gate: "pass",
    startedAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO batches (id,projectId,label,status,total,passed,failed,healed,flaky,quarantined,errored,gate,startedAt)
     VALUES (@id,@projectId,@label,@status,@total,@passed,@failed,@healed,@flaky,@quarantined,@errored,@gate,@startedAt)`,
  ).run(b);
  return b;
}
export function updateBatch(id: string, patch: Partial<Batch>): void {
  const cur = getBatch(id);
  if (!cur) return;
  const next = { ...cur, ...patch };
  db.prepare(
    `UPDATE batches SET status=@status,total=@total,passed=@passed,failed=@failed,healed=@healed,
       flaky=@flaky,quarantined=@quarantined,errored=@errored,gate=@gate,finishedAt=@finishedAt WHERE id=@id`,
  ).run({ ...next, finishedAt: next.finishedAt ?? null });
}
export const getBatch = (id: string): Batch | undefined =>
  db.prepare("SELECT * FROM batches WHERE id=?").get(id) as Batch | undefined;
export const listBatches = (projectId: string): Batch[] =>
  db.prepare("SELECT * FROM batches WHERE projectId=? ORDER BY startedAt DESC LIMIT 50").all(projectId) as Batch[];
export function addBatchRun(r: BatchRun): void {
  db.prepare(
    `INSERT INTO batch_runs (batchId,caseId,caseTitle,runId,status,attempts,healed)
     VALUES (@batchId,@caseId,@caseTitle,@runId,@status,@attempts,@healed)
     ON CONFLICT(batchId,caseId) DO UPDATE SET runId=@runId,status=@status,attempts=@attempts,healed=@healed`,
  ).run({ ...r, runId: r.runId ?? null, healed: r.healed ? 1 : 0 });
}
export function updateRunHealing(id: string, attempts: number, healed: boolean): void {
  db.prepare("UPDATE runs SET attempts=?, healed=? WHERE id=?").run(attempts, healed ? 1 : 0, id);
}
export const getBatchRuns = (batchId: string): BatchRun[] =>
  (db.prepare("SELECT * FROM batch_runs WHERE batchId=?").all(batchId) as (Omit<BatchRun, "healed"> & { healed: number })[]).map(
    (r) => ({ ...r, healed: !!r.healed }),
  );
