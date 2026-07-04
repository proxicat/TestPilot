import { resolveModelConfig, PROBE_IMAGE, type ModelConfig } from "./config.js";
import { getSettings, langDirective } from "./settings.js";

interface ChatMessage {
  role: "system" | "user";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
}

async function chat(
  messages: ChatMessage[],
  cfg: ModelConfig,
  opts: { timeoutMs?: number; maxTokens?: number } = {},
): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.modelName,
        messages,
        max_tokens: opts.maxTokens ?? 512,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(t);
  }
}

export type ProbeResult =
  | { state: "ok"; detail: string }
  | { state: "notMultimodal"; detail: string }
  | { state: "fail"; detail: string };

// Probe the endpoint: reachable? accepts images (multimodal)?
export async function probeModel(
  override?: Partial<ModelConfig>,
): Promise<ProbeResult> {
  const cfg = resolveModelConfig(override);

  // Step 1: reachability + basic text completion.
  try {
    await chat(
      [{ role: "user", content: "Reply with the single word: ok" }],
      cfg,
      { timeoutMs: 8000, maxTokens: 16 },
    );
  } catch (e) {
    return {
      state: "fail",
      detail: `Could not reach the endpoint. ${(e as Error).message}`,
    };
  }

  // Step 2: multimodal probe — send an image and see if the model handles it.
  try {
    const out = await chat(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image? Answer in one word." },
            { type: "image_url", image_url: { url: PROBE_IMAGE } },
          ],
        },
      ],
      cfg,
      { timeoutMs: 15000, maxTokens: 32 },
    );
    return {
      state: "ok",
      detail: `Reachable and multimodal. Model replied: "${out.trim().slice(0, 60)}"`,
    };
  } catch (e) {
    return {
      state: "notMultimodal",
      detail: `Endpoint reachable, but the image request failed — likely not a vision-language model. ${(e as Error).message}`,
    };
  }
}

// Generate runnable Midscene code from natural-language steps (falls back to a template).
export async function generateCode(
  title: string,
  steps: string[],
  expected: string,
  override?: Partial<ModelConfig>,
): Promise<string> {
  const cfg = resolveModelConfig(override);
  // The instruction preamble is a configurable template; the case-specific data is
  // always appended by code so the placeholders can't be broken by an edit.
  const preamble = getSettings().prompts.generateCode;
  const prompt = `${preamble}

Test: ${title}
Steps:
${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}
Expected result: ${expected || "the action succeeds"}`;

  try {
    const out = await chat(
      [
        { role: "system", content: "You output only code, no prose." },
        { role: "user", content: prompt },
      ],
      cfg,
      { timeoutMs: 20000, maxTokens: 400 },
    );
    const cleaned = out.replace(/```[a-z]*\n?/gi, "").trim();
    if (cleaned) return cleaned;
  } catch {
    // fall through to template
  }
  return [
    ...steps.map((s) => `await agent.aiAction(${JSON.stringify(s)});`),
    `await agent.aiAssert(${JSON.stringify(expected || "the action succeeds")});`,
  ].join("\n");
}

// Edit-time AI node intervention: given a case and a natural-language instruction, return a
// proposed change to either its steps or its oracle. Returns the proposal only — the caller
// diffs it against the current value and applies it (via PATCH) if the user accepts. Nothing
// is ever mutated silently.
export type RefineTarget = "steps" | "oracle" | "data";
export interface RefineResult {
  target: RefineTarget;
  proposedSteps?: string[]; // present when target === "steps" or "data" (both edit the step list)
  proposedExpected?: string; // present when target === "oracle"
  note: string; // one-line explanation of what changed (for the diff header)
}

function extractJson(raw: string): any {
  const cleaned = raw.replace(/```[a-z]*\n?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function refineCase(
  input: {
    title: string;
    steps: string[];
    expected: string;
    type: string;
    target: RefineTarget;
    instruction: string;
    stepIdx?: number; // optional: focus the edit on one step
    lang?: string; // optional: UI language to force the output into (when enforced)
  },
  override?: Partial<ModelConfig>,
): Promise<RefineResult> {
  const cfg = resolveModelConfig(override);
  const focus =
    typeof input.stepIdx === "number"
      ? `Focus your change on step ${input.stepIdx + 1}, but you may add/split steps around it if needed.`
      : "";

  const stepsShape =
    `Return JSON: {"steps": ["<step 1>", "<step 2>", ...], "note": "<one short line: what you changed>"}. ` +
    `Each step is a short, concrete natural-language UI action (as passed to Midscene aiAction). ` +
    `Keep placeholders like \${env.KEY} and \${secret.KEY} intact. Return the FULL updated step list, not a diff.`;
  const shape =
    input.target === "steps"
      ? stepsShape
      : input.target === "data"
        ? `The instruction is about the TEST DATA / inputs (which account, values, edge-case inputs, or ` +
          `parameterization the steps use). Adjust the data used INSIDE the steps accordingly — prefer ` +
          `placeholders \${env.KEY} / \${secret.KEY} for credentials over literal values, and use concrete ` +
          `literals for non-secret test data. ` +
          stepsShape
        : `Return JSON: {"expected": "<one concrete, checkable assertion of the successful/error outcome>", "note": "<one short line: what you changed>"}. ` +
          `This is the pass/fail oracle checked by Midscene aiAssert.`;

  const prompt = `You are refining an automated UI test based on a QA engineer's instruction.
Return ONLY JSON, no prose, no markdown fences.

Test title: ${input.title}
Type: ${input.type}
Current steps:
${input.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "(none)"}
Current expected (oracle): ${input.expected || "(none)"}

Instruction: ${input.instruction}
${focus}

${shape}${langDirective(input.lang)}`;

  const out = await chat(
    [
      { role: "system", content: "You output only strict JSON, no prose." },
      { role: "user", content: prompt },
    ],
    cfg,
    { timeoutMs: 60000, maxTokens: 600 },
  );
  const parsed = extractJson(out);
  const note = typeof parsed.note === "string" ? parsed.note : "AI-proposed change";
  if (input.target === "steps" || input.target === "data") {
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.map((s: unknown) => String(s)).filter((s: string) => s.trim())
      : [];
    if (!steps.length) throw new Error("model returned no steps");
    return { target: input.target, proposedSteps: steps, note };
  }
  const expected = typeof parsed.expected === "string" ? parsed.expected.trim() : "";
  if (!expected) throw new Error("model returned no expected");
  return { target: "oracle", proposedExpected: expected, note };
}
