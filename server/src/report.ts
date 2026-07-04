// Captures Midscene.js's generated run report so our platform can surface it.
// Midscene writes, under a `midscene_run/` dir: `report/*.html` (one interactive
// HTML report per agent run) and `log/` files (ai-profile-stats.log, ai-call.log).
// This module finds the newest report HTML produced during a run window, copies it
// to a destination path, and makes a best-effort attempt to total the tokens used.
// It never throws: on any error it degrades to omitting tokens or returning `{}`.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

export interface CapturedReport {
  reportPath?: string; // absolute path where the report HTML was copied (destPath), if found
  tokens?: number;     // best-effort total tokens used during the run (omit if not parseable)
}

// Find the Midscene HTML report produced by a run and copy it to destPath.
export function captureMidsceneReport(opts: {
  midsceneDir: string; // absolute path to the midscene_run dir
  sinceMs: number;     // Date.now() captured just before the run started
  destPath: string;    // absolute path to copy the newest report HTML to
}): CapturedReport {
  try {
    const reportDir = `${opts.midsceneDir}/report`;
    if (!existsSync(reportDir)) return {};

    let newest: { path: string; mtimeMs: number } | undefined;
    for (const name of readdirSync(reportDir)) {
      if (!name.endsWith(".html")) continue;
      const path = `${reportDir}/${name}`;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < opts.sinceMs) continue;
      if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
    }
    if (!newest) return {};

    mkdirSync(dirname(opts.destPath), { recursive: true });
    copyFileSync(newest.path, opts.destPath);

    const result: CapturedReport = { reportPath: opts.destPath };
    const tokens = parseTokens(opts.midsceneDir);
    if (tokens !== undefined) result.tokens = tokens;
    return result;
  } catch {
    return {};
  }
}

// Best-effort token total: scan the log files and sum token-ish integers.
// Prefers omitting (returns undefined) over guessing a wrong number.
function parseTokens(midsceneDir: string): number | undefined {
  const logDir = `${midsceneDir}/log`;
  const files = ["ai-profile-stats.log", "ai-call.log"];
  let total = 0;
  let found = false;

  for (const file of files) {
    const path = `${logDir}/${file}`;
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }

    try {
      // Prefer an explicit total_tokens / totalTokens field when present.
      const totalRe = /["']?total[_-]?tokens["']?\s*[:=]\s*(\d+)/gi;
      let m: RegExpExecArray | null;
      let sawTotal = false;
      while ((m = totalRe.exec(text)) !== null) {
        total += Number(m[1]);
        sawTotal = true;
        found = true;
      }
      if (sawTotal) continue;

      // Otherwise sum prompt + completion token fields.
      const partRe = /["']?(?:prompt|completion)[_-]?tokens["']?\s*[:=]\s*(\d+)/gi;
      while ((m = partRe.exec(text)) !== null) {
        total += Number(m[1]);
        found = true;
      }
    } catch {
      // Ignore this file; degrade to whatever we already have.
    }
  }

  if (!found || !Number.isFinite(total) || total <= 0) return undefined;
  return total;
}
