import { create } from "zustand";
import type {
  ConnectionState,
  ExploreLog,
  Flakiness,
  ModelConfig,
  Priority,
  Project,
  RunRecord,
  TestCase,
} from "./types";
import { api } from "./api";
import { usePrefs } from "./prefs";

const API_BASE = "http://localhost:5301";
// The live-explore SSE connection (module-scoped so stopExplore can close it).
let exploreES: EventSource | null = null;

let idSeq = 100;
const nextId = () => `x-${++idSeq}`;
const clock = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

interface StoreState {
  cases: TestCase[];
  selectedId: string;
  runs: RunRecord[];
  projects: Project[];
  activeProjectId: string;
  backendUp: boolean;
  model: ModelConfig;
  connection: ConnectionState;
  connectionDetail: string;
  exploring: boolean;
  exploreLogs: ExploreLog[];
  exploreUrl: string;
  exploreDeep: boolean;
  exploreScreenshot: string;
  exploreLastCount: number;
  flakiness: Flakiness[];

  loadData: () => Promise<void>;
  loadFlakiness: () => Promise<void>;
  setQuarantine: (id: string, quarantined: boolean) => Promise<void>;
  setExploreDeep: (v: boolean) => void;
  selectProject: (id: string) => Promise<void>;
  exitProject: () => void;
  createProject: (name: string, targetUrl: string) => Promise<void>;
  select: (id: string) => void;
  patchCase: (id: string, patch: Partial<TestCase>) => Promise<void>;
  setPriority: (id: string, p: Priority) => Promise<void>;
  generateCode: (id: string) => Promise<void>;
  runCase: (id: string) => Promise<void>;
  runAllP0: () => void;
  setExploreUrl: (url: string) => void;
  startExplore: () => Promise<void>;
  stopExplore: () => void;
  setModel: (patch: Partial<ModelConfig>) => void;
  testConnection: () => Promise<void>;
}

export const useStore = create<StoreState>((set, get) => ({
  cases: [],
  selectedId: "",
  runs: [],
  projects: [],
  activeProjectId: "",
  backendUp: false,
  model: {
    // The no-think proxy (:8010), not the raw model (:8000). The proxy injects
    // enable_thinking:false so vision requests return fast/clean — the raw endpoint
    // runs in thinking mode and times out the connection probe. Matches server/.env.
    baseUrl: "http://127.0.0.1:8010/v1",
    apiKey: "1234",
    modelName: "Qwen3.6-35B-A3B-4bit",
    modelFamily: "qwen-vl",
  },
  connection: "idle",
  connectionDetail: "",
  exploring: false,
  exploreLogs: [],
  exploreUrl: "",
  exploreDeep: false,
  exploreScreenshot: "",
  exploreLastCount: 0,
  flakiness: [],

  // Load projects/cases/runs from the backend (source of truth). Falls back to the
  // built-in mock data if the backend is offline, so the UI still works standalone.
  loadData: async () => {
    try {
      const { projects } = await api.getProjects();
      if (!projects.length) {
        // Backend is up but has no projects → a genuinely empty state. Clear the
        // built-in mock data (which is only a fallback for when the backend is OFFLINE),
        // otherwise the UI shows a phantom "shop.acme.com" project + mock cases.
        set({
          backendUp: true,
          projects: [],
          activeProjectId: "",
          cases: [],
          runs: [],
          flakiness: [],
          selectedId: "",
          exploreUrl: "",
          exploreLastCount: 0,
          exploreScreenshot: "",
          exploreLogs: [],
        });
        return;
      }
      // Backend is up and has projects. Do NOT auto-select — Level 0 (the portfolio)
      // is the default landing. Cases/runs load lazily on enter (selectProject).
      set({ projects, activeProjectId: "", backendUp: true });
    } catch {
      set({ backendUp: false }); // keep mock data
    }
  },

  loadFlakiness: async () => {
    const pid = get().activeProjectId;
    if (!pid) return;
    try {
      const { flakiness } = await api.getFlakiness(pid);
      set({ flakiness });
    } catch {
      set({ flakiness: [] }); // backend offline / no data
    }
  },

  setQuarantine: async (id, quarantined) => {
    // optimistic
    set((s) => ({
      cases: s.cases.map((c) => (c.id === id ? { ...c, quarantined } : c)),
    }));
    try {
      const { case: updated } = await api.setQuarantine(id, quarantined);
      set((s) => ({ cases: s.cases.map((c) => (c.id === id ? updated : c)) }));
    } catch {
      // revert on failure
      set((s) => ({
        cases: s.cases.map((c) =>
          c.id === id ? { ...c, quarantined: !quarantined } : c,
        ),
      }));
    }
  },

  // Switch the active project → load its cases from the backend.
  selectProject: async (id) => {
    const proj = get().projects.find((p) => p.id === id);
    if (!proj) return;
    try {
      const [{ cases }, { runs }] = await Promise.all([
        api.getCases(id),
        api.getRuns({ projectId: id }),
      ]);
      set({
        activeProjectId: id,
        cases,
        runs, // project-scoped: Runs page now follows the active project
        exploreUrl: proj.targetUrl,
        selectedId: cases[0]?.id ?? "",
      });
      void get().loadFlakiness();
    } catch {
      /* backend offline */
    }
  },

  // Leave the project → return to the portfolio (Level 0). Clears project-scoped data.
  exitProject: () =>
    set({
      activeProjectId: "",
      cases: [],
      runs: [],
      flakiness: [],
      selectedId: "",
      exploreUrl: "",
    }),

  createProject: async (name, targetUrl) => {
    try {
      const { project } = await api.createProject(name, targetUrl);
      set((s) => ({ projects: [...s.projects, project] }));
      await get().selectProject(project.id);
    } catch {
      /* backend offline */
    }
  },

  select: (id) => set({ selectedId: id }),

  // Generic case patcher (steps/expected/etc.). Optimistic; falls back to the
  // backend's canonical row when online. Used by the AI-refine accept flow.
  patchCase: async (id, patch) => {
    set((s) => ({ cases: s.cases.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
    if (get().backendUp) {
      try {
        const { case: updated } = await api.patchCase(id, patch);
        set((s) => ({ cases: s.cases.map((c) => (c.id === id ? updated : c)) }));
      } catch {
        /* kept optimistic */
      }
    }
  },

  setPriority: async (id, p) => {
    set((s) => ({ cases: s.cases.map((c) => (c.id === id ? { ...c, priority: p } : c)) }));
    if (get().backendUp) {
      try {
        await api.patchCase(id, { priority: p });
      } catch {
        /* kept optimistic */
      }
    }
  },

  generateCode: async (id) => {
    if (!get().backendUp) return;
    try {
      const { case: updated } = await api.genCaseCode(id);
      set((s) => ({ cases: s.cases.map((c) => (c.id === id ? updated : c)) }));
    } catch {
      /* backend error — leave the case unchanged */
    }
  },

  runCase: async (id) => {
    if (!get().cases.some((c) => c.id === id) || !get().backendUp) return;
    set((s) => ({ cases: s.cases.map((c) => (c.id === id ? { ...c, runStatus: "running" } : c)) }));
    try {
      const { case: updated } = await api.runCaseApi(id, {});
      // Single-case runs do NOT enter s.runs — the Runs page is the suite ledger.
      // The case detail shows this run inline (fetched by caseId).
      set((s) => ({ cases: s.cases.map((c) => (c.id === id ? updated : c)) }));
    } catch {
      set((s) => ({ cases: s.cases.map((c) => (c.id === id ? { ...c, runStatus: "failed" } : c)) }));
    }
  },

  runAllP0: () => {
    const p0 = get().cases.filter((c) => c.priority === "P0");
    p0.forEach((c, i) => window.setTimeout(() => void get().runCase(c.id), i * 300));
  },

  setExploreUrl: (url) => set({ exploreUrl: url }),
  setExploreDeep: (v) => set({ exploreDeep: v }),

  startExplore: async () => {
    if (get().exploring) return;
    const url = get().exploreUrl;
    const pid = get().activeProjectId;
    const pushLog = (message: string, kind: ExploreLog["kind"]) =>
      set((s) => ({ exploreLogs: [...s.exploreLogs, { id: nextId(), ts: clock(), message, kind }] }));

    if (!get().backendUp || !pid) {
      pushLog(pid ? "Backend offline — cannot explore" : "Enter a project first", "warn");
      return;
    }

    set({ exploring: true, exploreLogs: [], exploreScreenshot: "", exploreLastCount: 0 });
    const deep = get().exploreDeep;
    pushLog(`Exploring ${url} with Midscene${deep ? " (deep crawl)" : ""}…`, "info");

    const qs = new URLSearchParams({
      url,
      deep: deep ? "1" : "0",
      lang: usePrefs.getState().lang,
    }).toString();
    const es = new EventSource(`${API_BASE}/api/projects/${pid}/explore/stream?${qs}`);
    exploreES = es;
    const finish = () => {
      es.close();
      if (exploreES === es) exploreES = null;
      set({ exploring: false });
    };

    es.onmessage = (e) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (ev.type) {
        case "navigated":
          if (ev.screenshot) set({ exploreScreenshot: ev.screenshot as string });
          break;
        case "log":
          pushLog(ev.message as string, (ev.kind as ExploreLog["kind"]) || "info");
          break;
        case "flow": {
          const c = ev.case as TestCase;
          set((s) => ({ cases: [...s.cases, c] }));
          pushLog(`Found flow: ${c.title} → ${c.priority}`, "found");
          break;
        }
        case "done":
          if (ev.screenshot) set({ exploreScreenshot: ev.screenshot as string });
          if (!(ev.count as number)) pushLog("No new flows returned by the model", "warn");
          set({ exploreLastCount: (ev.count as number) || 0 });
          pushLog("Exploration complete", "info");
          finish();
          break;
        case "error":
          pushLog(`Explore failed: ${ev.message as string}`, "warn");
          finish();
          break;
      }
    };
    // A terminal close also fires onerror; only surface it if we're still exploring.
    es.onerror = () => {
      if (get().exploring) pushLog("Exploration stream ended / connection lost", "warn");
      finish();
    };
  },

  stopExplore: () => {
    exploreES?.close();
    exploreES = null;
    set({ exploring: false });
  },

  setModel: (patch) =>
    set((s) => ({ model: { ...s.model, ...patch }, connection: "idle", connectionDetail: "" })),

  testConnection: async () => {
    set({ connection: "testing", connectionDetail: "" });
    try {
      const r = await api.testModel(get().model);
      set({ connection: r.state, connectionDetail: r.detail });
    } catch {
      set({
        connection: "fail",
        connectionDetail: "Backend offline — could not reach /api/model/test.",
      });
    }
  },
}));
