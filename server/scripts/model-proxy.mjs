// Thin adapter in front of the OpenAI-compatible model: injects
// `enable_thinking:false` (+ chat_template_kwargs) into every /chat/completions so
// "thinking" VL models (e.g. Qwen3.x) return concise structured output for Midscene.
//
// Also the single LLM-debug capture point: when .data/llm-debug.on exists (toggled
// from the app), it logs every /chat/completions request (text + images) and the
// model's response to .data/llm-debug/<id>.json for prompt-template tuning. All LLM
// traffic (Midscene aiQuery/aiAction/aiAssert AND our own chat()) flows through here.
import http from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "..", ".data");
const FLAG = resolve(DATA_DIR, "llm-debug.on");
const LOG_DIR = resolve(DATA_DIR, "llm-debug");

const UPSTREAM = process.env.MODEL_UPSTREAM || "http://127.0.0.1:8000";
const PORT = Number(process.env.PROXY_PORT || 8010);

let seq = 0;
let flag = { on: false, at: 0 };
function debugOn() {
  const now = Date.now();
  if (now - flag.at > 1000) flag = { on: existsSync(FLAG), at: now };
  return flag.on;
}

// Replace inline base64 images with a saved-file reference so the JSON stays readable.
function sanitizeContent(content, id, imgs) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part?.type === "image_url" && typeof part.image_url?.url === "string") {
      const url = part.image_url.url;
      const m = /^data:(image\/\w+);base64,(.*)$/s.exec(url);
      if (m) {
        const ext = m[1].split("/")[1] || "jpg";
        const buf = Buffer.from(m[2], "base64");
        const file = `${id}-img${imgs.n}.${ext}`;
        try {
          writeFileSync(join(LOG_DIR, file), buf);
        } catch {}
        imgs.n += 1;
        return { type: "image_url", savedImage: file, bytes: buf.length };
      }
      return { type: "image_url", url: url.slice(0, 120) };
    }
    return part;
  });
}

function logExchange(reqJson, respText, url, ms) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const id = `${String(++seq).padStart(4, "0")}-${ts.replace(/[:.]/g, "-")}`;
    const imgs = { n: 0 };
    const messages = (reqJson.messages || []).map((m) => ({
      role: m.role,
      content: sanitizeContent(m.content, id, imgs),
    }));
    let response;
    try {
      const rj = JSON.parse(respText);
      response = {
        content: rj.choices?.[0]?.message?.content ?? null,
        finish_reason: rj.choices?.[0]?.finish_reason,
        usage: rj.usage,
        error: rj.error,
      };
    } catch {
      response = { raw: String(respText).slice(0, 4000) };
    }
    writeFileSync(
      join(LOG_DIR, `${id}.json`),
      JSON.stringify(
        { ts, url, latencyMs: ms, model: reqJson.model, request: { messages }, response },
        null,
        2,
      ),
    );
    const chars = (response.content || "").length;
    console.log(
      `[llm-debug] ${id} · ${messages.length} msg · ${imgs.n} img · resp ${chars} chars · ${ms}ms`,
    );
  } catch (e) {
    console.log("[llm-debug] log error:", String(e));
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    let body = Buffer.concat(chunks).toString("utf8");
    let parsed = null;
    const isChat = req.url?.includes("/chat/completions") && body;
    if (isChat) {
      try {
        parsed = JSON.parse(body);
        parsed.enable_thinking = false;
        parsed.chat_template_kwargs = {
          ...(parsed.chat_template_kwargs || {}),
          enable_thinking: false,
        };
        body = JSON.stringify(parsed);
      } catch {
        /* pass through unmodified */
      }
    }
    const started = Date.now();
    try {
      const r = await fetch(UPSTREAM + req.url, {
        method: req.method,
        headers: {
          "content-type": "application/json",
          ...(req.headers.authorization
            ? { authorization: req.headers.authorization }
            : {}),
        },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const text = await r.text();
      if (isChat && parsed && debugOn()) logExchange(parsed, text, req.url, Date.now() - started);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(text);
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
});

server.listen(PORT, () =>
  console.log(`[model-proxy] :${PORT} → ${UPSTREAM} (enable_thinking:false; llm-debug when flag set)`),
);
