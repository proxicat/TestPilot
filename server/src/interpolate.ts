// Placeholder resolution + secret redaction. Case steps store ${env.KEY} and
// ${secret.KEY} placeholders — never literal credentials. At run time we resolve
// them to real values for the browser, but LOG the original template text, so a
// plaintext secret never reaches logs, reports, or the DB.
export interface ResolveContext {
  env: Record<string, string>; // non-secret vars (safe to show)
  secrets: Record<string, string>; // sensitive values (must be redacted)
}

const PLACEHOLDER = /\$\{(env|secret)\.([A-Za-z0-9_]+)\}/g;

// Resolve a template to its real value (for execution).
export function resolveText(text: string, ctx: ResolveContext): string {
  return text.replace(PLACEHOLDER, (whole, kind: string, key: string) => {
    const table = kind === "secret" ? ctx.secrets : ctx.env;
    return key in table ? table[key] : whole; // leave unknown placeholders intact
  });
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
