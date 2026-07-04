import type { Project, TestCase, Environment } from "./db.js";

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "case";

// Turn a ${env.KEY}/${secret.KEY} template into a JS template-literal body that
// reads process.env at run time: "hi ${env.USER}" → `hi ${process.env.USER ?? ""}`.
function toEnvTemplate(text: string): string {
  const body = text.replace(
    /\$\{(?:env|secret)\.([A-Za-z0-9_]+)\}/g,
    (_m, key) => "${process.env." + key + ' ?? ""}',
  );
  return "`" + body.replace(/`/g, "\\`") + "`";
}
// Does the text reference any injected variable? (→ use a template literal vs plain string)
const usesVars = (text: string) => /\$\{(?:env|secret)\.[A-Za-z0-9_]+\}/.test(text);
const lit = (text: string) => (usesVars(text) ? toEnvTemplate(text) : JSON.stringify(text));

const TAG: Record<TestCase["type"], string> = {
  functional: "@functional",
  negative: "@negative",
  boundary: "@boundary",
  e2e: "@e2e",
};

function specForCase(tc: TestCase, targetUrl: string): string {
  const tags = `@${tc.priority} ${TAG[tc.type] ?? "@functional"}`;
  const steps = tc.steps.map((s) => `  await aiAction(${lit(s.text)});`).join("\n");
  const post = tc.postSteps.length
    ? "\n  // teardown\n" +
      tc.postSteps
        .map((s) => `  await aiAction(${lit(s.text)}).catch(() => {});`)
        .join("\n")
    : "";
  const assert = tc.expected
    ? `  await aiAssert(${lit(tc.expected)});`
    : `  await aiAssert("the page reached the expected state");`;
  const trace = tc.requirementId ? ` — req ${tc.requirementId}` : "";
  return `import { test } from "./ai";

// ${tc.priority} · ${tc.type}${trace} — ${tc.priorityReason || ""}
test(${JSON.stringify(`[${tags}] ${tc.title}`)}, async ({ page, aiAction, aiAssert }) => {
  await page.goto(process.env.BASE_URL || ${JSON.stringify(targetUrl)});
${steps}
${assert}${post}
});
`;
}

// Build a standalone, runnable Playwright + Midscene project from a project's cases.
// Includes env/secrets config, a shared login setup (storageState reuse), tags,
// retries, and a CI workflow — a maintainable suite, not just a flat list of specs.
export function buildExportFiles(
  project: Project,
  cases: TestCase[],
  opts: { environments?: Environment[]; secretKeys?: string[] } = {},
): Record<string, string> {
  const files: Record<string, string> = {};
  const name = slug(project.name) + "-e2e";
  const environments = opts.environments ?? [];
  const defaultEnv = environments.find((e) => e.isDefault) ?? environments[0];
  const login = defaultEnv?.login;
  const hasAuth = !!(login?.authRequired && login.steps?.length);

  // Collect the env-var + secret names referenced anywhere, for .env.example.
  const envVarNames = new Set<string>();
  const secretNames = new Set<string>(opts.secretKeys ?? []);
  const scanText = (t: string) => {
    for (const m of t.matchAll(/\$\{(env|secret)\.([A-Za-z0-9_]+)\}/g)) {
      (m[1] === "secret" ? secretNames : envVarNames).add(m[2]);
    }
  };
  for (const e of environments) Object.keys(e.vars).forEach((k) => envVarNames.add(k));
  for (const c of cases) [...c.steps, ...c.postSteps].forEach((s) => scanText(s.text));
  for (const s of login?.steps ?? []) scanText(s);

  files["package.json"] = JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: {
        test: "playwright test",
        "test:headed": "playwright test --headed",
        "test:p0": "playwright test --grep @P0",
      },
      devDependencies: {
        // Pinned to the versions TestPilot validates against. Do NOT loosen to a
        // caret range: @playwright/test >= 1.61 has a test-loader regression that
        // crashes collecting the Midscene fixture on a transitive @azure module.
        "@midscene/web": "0.30.10",
        "@playwright/test": "1.48.2",
        dotenv: "16.4.7",
      },
    },
    null,
    2,
  );

  // storageState reuse: an auth "setup" project logs in once and saves the session;
  // all test projects start already-authenticated. This is the exported 登录态.
  const projects = hasAuth
    ? `  projects: [
    { name: "setup", testMatch: /auth\\.setup\\.ts/ },
    {
      name: "chromium",
      dependencies: ["setup"],
      use: { storageState: ".auth/state.json" },
    },
  ],`
    : `  projects: [{ name: "chromium" }],`;

  files["playwright.config.ts"] =
    `import { defineConfig } from "@playwright/test";
import "dotenv/config";

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    baseURL: process.env.BASE_URL || ${JSON.stringify(defaultEnv?.baseUrl || project.targetUrl)},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
${projects}
});
`;

  files["tests/ai.ts"] =
    `import { test as base } from "@playwright/test";
import { PlaywrightAiFixture } from "@midscene/web/playwright";

// Adds ai / aiAction / aiQuery / aiAssert to the test context, driven by the
// OpenAI-compatible vision model configured in .env (see .env.example).
export const test = base.extend(PlaywrightAiFixture());
export { expect } from "@playwright/test";
`;

  if (hasAuth) {
    const loginSteps = (login!.steps ?? [])
      .map((s) => `  await aiAction(${lit(s)});`)
      .join("\n");
    files["tests/auth.setup.ts"] =
      `import { test as setup } from "./ai";

// Runs ONCE before the suite: performs the login flow using credentials injected
// from .env (never hard-coded), then persists the session to .auth/state.json so
// every test starts authenticated. Central login state — change it in one place.
setup("authenticate", async ({ page, aiAction }) => {
  await page.goto(process.env.BASE_URL || ${JSON.stringify(defaultEnv?.baseUrl || project.targetUrl)});
${loginSteps}
  await page.context().storageState({ path: ".auth/state.json" });
});
`;
  }

  for (const tc of cases) {
    files[`tests/${tc.priority.toLowerCase()}-${slug(tc.title)}.spec.ts`] = specForCase(
      tc,
      defaultEnv?.baseUrl || project.targetUrl,
    );
  }

  const envLines = [...envVarNames].sort().map((k) => {
    const v = defaultEnv?.vars?.[k];
    return `${k}=${v ?? ""}`;
  });
  const secretLines = [...secretNames].sort().map((k) => `${k}=            # set me (never commit real values)`);
  files[".env.example"] =
    `# ---- Vision-language model Midscene uses to drive the tests ----
OPENAI_BASE_URL=http://127.0.0.1:8010/v1
OPENAI_API_KEY=1234
MIDSCENE_MODEL_NAME=Qwen3.6-35B-A3B-4bit
MIDSCENE_USE_QWEN3_VL=1

# ---- Target ----
BASE_URL=${defaultEnv?.baseUrl || project.targetUrl}

# ---- Environment variables (non-secret) ----
${envLines.length ? envLines.join("\n") : "# (none)"}

# ---- Secrets (injected at run time; keep out of version control) ----
${secretLines.length ? secretLines.join("\n") : "# (none)"}
`;

  files[".gitignore"] = `node_modules/\n.env\n.auth/\nplaywright-report/\ntest-results/\n`;

  files[".github/workflows/e2e.yml"] =
    `name: E2E
on: [push, pull_request, workflow_dispatch]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
      - run: npx playwright install --with-deps chromium
      - run: npm test
        env:
          OPENAI_BASE_URL: \${{ secrets.OPENAI_BASE_URL }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          MIDSCENE_MODEL_NAME: \${{ vars.MIDSCENE_MODEL_NAME }}
          BASE_URL: \${{ vars.BASE_URL }}
${[...secretNames].sort().map((k) => `          ${k}: \${{ secrets.${k} }}`).join("\n")}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: playwright-report, path: playwright-report/ }
`;

  const p0 = cases.filter((c) => c.priority === "P0").length;
  const neg = cases.filter((c) => c.type === "negative" || c.type === "boundary").length;
  files["README.md"] =
    `# ${project.name} — E2E tests

Generated by TestPilot from ${cases.length} test cases (${p0} P0, ${neg} negative/boundary).
Runnable Playwright + [Midscene](https://midscenejs.com) suite — the vision model
drives each step by natural language.

## Run

\`\`\`bash
npm install
npx playwright install chromium
cp .env.example .env    # point at your vision model + set secrets
npm test                # all tests
npm run test:p0         # only P0 (tagged @P0)
npm run test:headed     # watch it drive the browser
\`\`\`

${hasAuth ? "## Login state\n\nLogin runs once in `tests/auth.setup.ts` using credentials from `.env`, and the\nauthenticated session is saved to `.auth/state.json` and reused by every test —\nno per-test re-login, and no credentials in the specs.\n\n" : ""}## Secrets & environments

Credentials are injected from environment variables at run time (see \`.env.example\`) —
the specs reference \`process.env.*\`, never literal passwords. In CI, set them as
GitHub Actions **secrets**; non-secret config as **vars**.

## Cases
${cases.map((c) => `- **${c.priority}** \`${c.type}\` ${c.title}`).join("\n")}
`;

  return files;
}
