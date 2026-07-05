export type Priority = "P0" | "P1" | "P2";
export type RunStatus = "passed" | "failed" | "notRun" | "running";
export type CaseType = "functional" | "negative" | "boundary" | "e2e";

export interface LoginFlow {
  authRequired?: boolean;
  steps?: string[];
  // Captured-session summary (the blob itself never leaves the server).
  capturedAt?: string;
  hasSession?: boolean;
  sessionCookies?: number;
  sessionOrigins?: number;
}

export interface Environment {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  vars: Record<string, string | string[]>; // value may be an array (data-driven)
  headers: Record<string, string>; // fixed request headers
  query: Record<string, string>; // fixed query-string params
  login: LoginFlow;
  isDefault: boolean;
  createdAt: string;
}

export interface SecretMeta {
  id: string;
  projectId: string;
  envId?: string;
  key: string;
  updatedAt: string;
}
export type ConnectionState =
  | "idle"
  | "testing"
  | "ok"
  | "fail"
  | "notMultimodal";

export interface Step {
  order: number;
  text: string;
}

export interface Project {
  id: string;
  name: string;
  targetUrl: string;
  createdAt: string;
}

export interface TestCase {
  id: string;
  projectId?: string;
  title: string;
  priority: Priority;
  priorityReason: string;
  runStatus: RunStatus;
  hasCode: boolean;
  precondition?: string;
  expected?: string;
  steps: Step[];
  code?: string;
  type: CaseType;
  requirementId?: string;
  envRef?: string;
  postSteps?: Step[];
  quarantined?: boolean;
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
  gate: "pass" | "fail";
  startedAt: string;
  finishedAt?: string;
}
export interface BatchRun {
  batchId: string;
  caseId: string;
  caseTitle: string;
  runId?: string;
  status: "passed" | "failed" | "quarantined";
  attempts: number;
  healed: boolean;
}

export interface PerfVerdict {
  metric: string;
  current: number;
  baseline?: number;
  budgetMs?: number;
  deltaPct?: number;
  status: "ok" | "regression" | "new_baseline";
}
export interface PerfResult {
  status: "new_baseline" | "ok" | "regression";
  metrics: Record<string, number>;
  baseline?: Record<string, number>;
  verdicts: PerfVerdict[];
}
export interface OracleCheck {
  assertion: string;
  status: "pass" | "fail";
  detail?: string;
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

export interface RunRecord {
  id: string;
  caseId: string;
  caseTitle: string;
  priority: Priority;
  status: Exclude<RunStatus, "notRun">;
  durationMs: number;
  startedAt: string; // ISO
  failureReason?: string;
  logs: string[];
  screenshots?: string[]; // data URLs from real Midscene runs
  reportPath?: string; // present → Midscene full report available at /api/runs/:id/report
  tokens?: number;
  visual?: VisualDiff[];
  perf?: PerfResult;
  oracle?: OracleCheck[];
  attempts?: number;
  healed?: boolean;
}

export interface TrendsKpis {
  passRate: number; // 0..1 over recent runs
  flakeRate: number; // 0..1, flaky cases / cases-with-runs; TARGET < 0.02
  mttrMs: number | null; // mean time to recovery, ms
  coverage: number; // 0..1, cases with >=1 passing run / total cases
  healRate: number; // 0..1, healed / (healed+failed) runs
  totalCases: number;
  casesWithRuns: number;
  totalRuns: number;
  runsWindow: number;
}
export interface TrendsBatch {
  id: string;
  label: string;
  startedAt: string;
  passed: number;
  failed: number;
  healed: number;
  flaky: number;
  quarantined: number;
  passRate: number;
  gate: "pass" | "fail";
}
export interface TrendsDay {
  day: string;
  passed: number;
  failed: number;
  passRate: number;
}
export interface Trends {
  kpis: TrendsKpis;
  batches: TrendsBatch[]; // chronological oldest→newest
  days: TrendsDay[];
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  modelFamily: string;
}

export interface ExploreLog {
  id: string;
  ts: string;
  message: string;
  kind: "info" | "found" | "warn";
}
