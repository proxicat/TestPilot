// Global, runtime-configurable settings: the LLM-debug toggle and the editable
// prompt templates. Persisted to .data/settings.json. When debug is on, a flag file
// (.data/llm-debug.on) is written so the standalone model-proxy can pick it up and
// log every request/response (images + text) for prompt-template tuning.
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "..", ".data");
const SETTINGS_PATH = resolve(DATA_DIR, "settings.json");
export const LLM_DEBUG_FLAG = resolve(DATA_DIR, "llm-debug.on");
export const LLM_DEBUG_DIR = resolve(DATA_DIR, "llm-debug");

// ---- default prompt templates (the shipped baseline) ----
// NOTE: \${...} stays literal in the template literal — these are placeholders the
// run pipeline fills in, not JS interpolation.
const DEFAULT_EXPLORE =
  'You are a senior QA engineer applying test-design methodology (equivalence ' +
  "partitioning, boundary-value analysis, negative/error paths, and state transitions). " +
  "From this page and the type of web app it belongs to, return the user flows worth " +
  'testing as an array named "flows". Cover both (a) the happy path AND (b) deliberate ' +
  "NEGATIVE/BOUNDARY cases (invalid input, empty required fields, wrong credentials, " +
  "limits) — a good suite is not all happy-path. Include the most important downstream " +
  "flows a user reaches after login (search/browse, add to cart, checkout, account). " +
  "Each flow object has: " +
  "title (string); " +
  'type ("functional" | "negative" | "boundary" | "e2e"); ' +
  'priority ("P0"|"P1"|"P2" — auth/payment/checkout/core happy-path = P0; important ' +
  "secondary = P1; minor/cosmetic = P2); " +
  "reason (string — why this matters / what requirement it covers); " +
  "steps (array of short concrete natural-language actions). " +
  "IMPORTANT for credentials: NEVER inline real usernames/passwords/keys in steps. Use " +
  "placeholders ${env.USERNAME} and ${secret.PASSWORD} so values are injected at run time; " +
  "expected (string — ONE concrete, checkable assertion of the outcome; for negative cases " +
  'assert the ERROR is shown, e.g. "an error message about locked-out user is displayed" — ' +
  "this is the pass/fail oracle). " +
  "Return 6-10 DISTINCT flows spanning different areas and including at least 2 negative/" +
  "boundary cases, not variations of one.";

const DEFAULT_EXPLORE_DEEP_PREFIX =
  "This screen was reached AFTER the entry page (e.g. after logging in). " +
  "Focus on flows available from here. ";

const DEFAULT_GENERATE_CODE =
  "You are generating a Midscene.js test using the agent API.\n" +
  "Available calls: await agent.aiAction('<natural language step>'), await agent.aiAssert('<condition>'), await agent.aiInput('<text>', '<field description>').\n" +
  "Return ONLY the body statements (no imports, no function wrapper, no markdown fences).";

export interface Prompts {
  explore: string;
  exploreDeepPrefix: string;
  generateCode: string;
}
export const DEFAULT_PROMPTS: Prompts = {
  explore: DEFAULT_EXPLORE,
  exploreDeepPrefix: DEFAULT_EXPLORE_DEEP_PREFIX,
  generateCode: DEFAULT_GENERATE_CODE,
};

export interface Settings {
  debugLLM: boolean;
  // When true, every AI request carries a directive forcing the model's natural-language
  // output (flow titles, reasons, steps, assertions, refine notes) into the UI language.
  enforceLang: boolean;
  prompts: Prompts;
}

// Map a UI language code → the name we tell the model to write in.
const LANG_NAMES: Record<string, string> = {
  zh: "Simplified Chinese (简体中文)",
  en: "English",
  ja: "Japanese (日本語)",
};

// The instruction appended to a prompt when language enforcement is on; empty otherwise,
// so callers can unconditionally do `prompt + langDirective(lang)`.
export function langDirective(lang?: string): string {
  if (!getSettings().enforceLang) return "";
  const name = LANG_NAMES[lang ?? ""] ?? LANG_NAMES.en;
  return (
    `\n\nLANGUAGE REQUIREMENT (STRICT): Write ALL natural-language output — titles, ` +
    `reasons, descriptions, step text, assertions, and notes — in ${name}, and in that ` +
    `language ONLY. Do NOT translate or alter code, JSON keys, URLs, or placeholders ` +
    `like \${env.KEY} / \${secret.KEY}; leave those exactly as-is.`
  );
}

let cache: Settings | null = null;

function applyDebugFlag(on: boolean): void {
  try {
    mkdirSync(LLM_DEBUG_DIR, { recursive: true });
    if (on) writeFileSync(LLM_DEBUG_FLAG, new Date().toISOString());
    else if (existsSync(LLM_DEBUG_FLAG)) rmSync(LLM_DEBUG_FLAG);
  } catch {
    /* best effort */
  }
}

export function getSettings(): Settings {
  if (cache) return cache;
  let loaded: Partial<Settings> = {};
  try {
    if (existsSync(SETTINGS_PATH)) loaded = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    /* fall back to defaults */
  }
  cache = {
    debugLLM: !!loaded.debugLLM,
    enforceLang: !!loaded.enforceLang,
    prompts: { ...DEFAULT_PROMPTS, ...(loaded.prompts || {}) },
  };
  applyDebugFlag(cache.debugLLM); // keep the flag file in sync on boot
  return cache;
}

function persist(s: Settings): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
  } catch {
    /* best effort */
  }
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const cur = getSettings();
  const next: Settings = {
    debugLLM: patch.debugLLM ?? cur.debugLLM,
    enforceLang: patch.enforceLang ?? cur.enforceLang,
    prompts: { ...cur.prompts, ...(patch.prompts || {}) },
  };
  cache = next;
  persist(next);
  if (patch.debugLLM !== undefined) applyDebugFlag(next.debugLLM);
  return next;
}

export function resetPrompts(): Settings {
  return updateSettings({ prompts: { ...DEFAULT_PROMPTS } });
}
