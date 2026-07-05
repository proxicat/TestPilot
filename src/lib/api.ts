import type {
  ApiLoginConfig,
  ModelConfig,
  Project,
  TestCase,
  RunRecord,
  Environment,
  SecretMeta,
  Batch,
  BatchRun,
  Flakiness,
  Trends,
} from "./types";

import { usePrefs } from "./prefs";

const BASE = "http://localhost:5301";

// The current UI language, read outside React — attached to AI requests so the backend
// can force the model's output language to match (when the global toggle is on).
const uiLang = () => usePrefs.getState().lang;

async function get<T>(path: string, timeoutMs = 5000): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function patch<T>(path: string, body: unknown, timeoutMs = 8000): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function del<T>(path: string, timeoutMs = 8000): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown, timeoutMs = 120000): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function isBackendUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export type ProbeState = "ok" | "notMultimodal" | "fail";

export type RefineTarget = "steps" | "oracle" | "data";
export interface RefineResponse {
  target: RefineTarget;
  current: { steps?: string[]; expected?: string };
  proposed: { steps?: string[]; expected?: string };
  note: string;
}

export interface ChainConfig {
  rpcUrl: string;
  chainId: number;
}

// ---- app settings: LLM-debug toggle + prompt templates ----
export type PromptTemplates = {
  explore: string;
  exploreDeepPrefix: string;
  generateCode: string;
};
export type AppSettings = {
  debugLLM: boolean;
  enforceLang: boolean;
  prompts: PromptTemplates;
};

export const api = {
  testModel: (model: ModelConfig) =>
    post<{ state: ProbeState; detail: string }>("/api/model/test", model, 30000),

  getConfig: async () => {
    const res = await fetch(`${BASE}/api/config`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { chain: ChainConfig; account: string };
  },

  saveConfig: (chain: ChainConfig) =>
    post<{ chain: ChainConfig; account: string }>("/api/config", chain, 8000),

  runCase: (payload: { url: string; steps: string[]; expected: string }) =>
    post<{
      status: "passed" | "failed";
      durationMs: number;
      startedAt: string;
      logs: string[];
      screenshots: string[];
      failureReason?: string;
    }>("/api/run", payload),

  explore: (url: string) =>
    post<{
      flows: Array<{
        title: string;
        priority: "P0" | "P1" | "P2";
        reason: string;
        steps: string[];
      }>;
    }>("/api/explore", { url }),

  generateCode: (payload: { title: string; steps: string[]; expected: string }) =>
    post<{ code: string }>("/api/generate-code", payload, 30000),

  // ---- persistence (backend is the source of truth) ----
  getProjects: () => get<{ projects: Project[] }>("/api/projects"),
  createProject: (name: string, targetUrl: string) =>
    post<{ project: Project }>("/api/projects", { name, targetUrl }, 8000),
  getCases: (projectId?: string) =>
    get<{ cases: TestCase[] }>(`/api/cases${projectId ? `?projectId=${projectId}` : ""}`),
  // Runs are project-scoped (like cases/suite/trends). Pass caseId for a single case,
  // or projectId for the whole project.
  getRuns: (opts?: { projectId?: string; caseId?: string }) => {
    const q = opts?.caseId
      ? `?caseId=${opts.caseId}`
      : opts?.projectId
        ? `?projectId=${opts.projectId}`
        : "";
    return get<{ runs: RunRecord[] }>(`/api/runs${q}`);
  },
  getRun: (id: string) => get<{ run: RunRecord }>(`/api/runs/${id}`),
  patchCase: (id: string, body: Partial<TestCase>) =>
    patch<{ case: TestCase }>(`/api/cases/${id}`, body),
  // AI refine of steps/oracle — a long model call (up to ~60s), so a generous
  // timeout. Does NOT mutate; caller applies the proposal via patchCase.
  refineCase: (
    caseId: string,
    target: RefineTarget,
    instruction: string,
    stepIdx?: number,
  ) =>
    post<RefineResponse>(
      `/api/cases/${caseId}/refine`,
      { target, instruction, stepIdx, lang: uiLang() },
      90000,
    ),
  genCaseCode: (id: string) =>
    post<{ case: TestCase }>(`/api/cases/${id}/generate-code`, {}, 60000),
  runCaseApi: (
    id: string,
    opts: { url?: string; provider?: string; wallet?: boolean; rpcUrl?: string; chainId?: number } = {},
  ) => post<{ case: TestCase; run: RunRecord }>(`/api/cases/${id}/run`, opts, 600000),
  exploreProject: (projectId: string, url?: string, deep?: boolean) =>
    post<{ created: TestCase[]; count: number; log?: string[]; screenshot?: string }>(
      `/api/projects/${projectId}/explore`,
      { url, deep, lang: uiLang() },
      600000,
    ),

  // ---- environments (per project) ----
  getEnvironments: (projectId: string) =>
    get<{ environments: Environment[] }>(`/api/projects/${projectId}/environments`),
  saveEnvironment: (
    projectId: string,
    env: {
      id?: string;
      name: string;
      baseUrl: string;
      vars: Record<string, string | string[]>;
      headers: Record<string, string>;
      query: Record<string, string>;
      login: { authRequired?: boolean; steps?: string[]; apiLogin?: ApiLoginConfig | null };
      isDefault: boolean;
    },
  ) =>
    post<{ environment: Environment }>(
      `/api/projects/${projectId}/environments`,
      env,
      8000,
    ),
  deleteEnvironment: (envId: string) =>
    del<{ ok: true }>(`/api/environments/${envId}`),
  // Run the env's login flow once and cache the resulting session (storageState).
  captureSession: (envId: string) =>
    post<{
      ok: true;
      cookies: number;
      localStorage: number;
      log: string[];
      environment: Environment;
    }>(`/api/environments/${envId}/capture-session`, {}, 600000),
  clearSession: (envId: string) =>
    del<{ ok: true; environment: Environment }>(`/api/environments/${envId}/session`),
  // Paste a session directly: a cookie string or a storageState JSON.
  setSession: (envId: string, raw: string) =>
    post<{ ok: true; cookies: number; origins: number; environment: Environment }>(
      `/api/environments/${envId}/set-session`,
      { raw },
      8000,
    ),
  // API-style login: call the configured endpoint, capture cookies/token as the session.
  apiLogin: (envId: string) =>
    post<{
      ok: true;
      status: number;
      cookies: number;
      token: boolean;
      environment: Environment;
    }>(`/api/environments/${envId}/api-login`, {}, 30000),

  // ---- secrets (per project; values are write-only, never returned) ----
  getSecrets: (projectId: string) =>
    get<{ secrets: SecretMeta[] }>(`/api/projects/${projectId}/secrets`),
  setSecret: (projectId: string, key: string, value: string) =>
    post<{ secret: SecretMeta }>(
      `/api/projects/${projectId}/secrets`,
      { key, value },
      8000,
    ),
  deleteSecret: (projectId: string, key: string) =>
    del<{ ok: true }>(
      `/api/projects/${projectId}/secrets/${encodeURIComponent(key)}`,
    ),

  // ---- suite runs / flake governance / quarantine (scale features) ----
  // The suite run is a genuinely long request (runs the whole suite through a queue).
  runSuite: (
    projectId: string,
    filter: "P0" | "P1" | "P2" | "all",
    retries?: number,
  ) =>
    post<{ batch: Batch; items: BatchRun[]; gate: "pass" | "fail" }>(
      `/api/projects/${projectId}/suite`,
      { filter, retries },
      600000,
    ),
  getBatches: (projectId: string) =>
    get<{ batches: Batch[] }>(`/api/projects/${projectId}/batches`),
  getBatch: (batchId: string) =>
    get<{ batch: Batch; items: BatchRun[] }>(`/api/batches/${batchId}`),
  getQueue: () =>
    get<{
      concurrency: number;
      active: number;
      waiting: number;
      totalQueued: number;
      totalDone: number;
      activeLabels: string[];
    }>("/api/queue", 3000),
  getFlakiness: (projectId: string) =>
    get<{ flakiness: Flakiness[] }>(`/api/projects/${projectId}/flakiness`),
  setQuarantine: (caseId: string, quarantined: boolean) =>
    patch<{ case: TestCase }>(`/api/cases/${caseId}`, { quarantined }),

  // ---- trends dashboard (per project) ----
  getTrends: (projectId: string) =>
    get<Trends>(`/api/projects/${projectId}/trends`),

  // ---- app settings: LLM-debug toggle + prompt templates ----
  getSettings: () =>
    get<{ settings: AppSettings; defaults: PromptTemplates }>("/api/settings", 4000),
  saveSettings: (patch: {
    debugLLM?: boolean;
    enforceLang?: boolean;
    prompts?: Partial<PromptTemplates>;
  }) => post<{ settings: AppSettings }>("/api/settings", patch, 8000),
  resetPrompts: () =>
    post<{ settings: AppSettings }>("/api/settings/reset-prompts", {}, 8000),
  getLlmDebug: () =>
    get<{ on: boolean; dir?: string; entries: string[] }>("/api/llm-debug", 4000),
};
