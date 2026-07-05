// Placeholder resolution + secret redaction. Case steps store ${env.KEY} and
// ${secret.KEY} placeholders — never literal credentials. At run time we resolve
// them to real values for the browser, but LOG the original template text, so a
// plaintext secret never reaches logs, reports, or the DB.
export interface ResolveContext {
  env: Record<string, string | string[]>; // non-secret vars (safe to show); may be arrays
  secrets: Record<string, string>; // sensitive values (must be redacted)
}

// ${env.KEY}, ${secret.KEY}, or ${env.KEY.3} (indexed element of an array var).
const PLACEHOLDER = /\$\{(env|secret)\.([A-Za-z0-9_]+)(?:\.(\d+))?\}/g;

// Resolve a template to its real value (for execution).
export function resolveText(text: string, ctx: ResolveContext): string {
  return text.replace(PLACEHOLDER, (whole, kind: string, key: string, idx?: string) => {
    if (kind === "secret") return key in ctx.secrets ? ctx.secrets[key] : whole;
    const val = ctx.env[key];
    if (val === undefined) return whole; // leave unknown placeholders intact
    if (Array.isArray(val)) {
      // ${env.KEY.N} → the Nth element; ${env.KEY} on an array → comma-joined.
      if (idx !== undefined) return val[Number(idx)] ?? whole;
      return val.join(",");
    }
    return val;
  });
}

// Resolve every value of a key→template map (used for fixed headers / query params).
export function resolveMap(
  map: Record<string, string>,
  ctx: ResolveContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map || {})) out[k] = resolveText(v, ctx);
  return out;
}

// True if the template references a secret placeholder (so we know to keep the
// template out of any resolved log line).
export function hasSecretRef(text: string): boolean {
  let m: RegExpExecArray | null;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(text))) if (m[1] === "secret") return true;
  return false;
}

// Defense-in-depth: mask any raw secret value that slipped into a string
// (e.g. an error message echoing an input). Longest values first.
export function redact(text: string, secretValues: string[]): string {
  let out = text;
  for (const v of [...secretValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(v).join("••••••");
  }
  return out;
}
