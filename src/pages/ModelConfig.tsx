import { useCallback, useEffect, useState } from "react";
import {
  Cpu,
  CheckCircle,
  AlertTriangle,
  Loader2,
  Copy,
  Server,
  Boxes,
  KeyRound,
  Plus,
  Trash2,
  Lock,
  Bug,
  FileText,
  RotateCcw,
  RefreshCw,
  Languages,
} from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui";
import { useT, usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { AppSettings, PromptTemplates } from "@/lib/api";
import type { Environment, LoginFlow, SecretMeta } from "@/lib/types";

export function ModelConfigPage() {
  const t = useT();
  const model = useStore((s) => s.model);
  const setModel = useStore((s) => s.setModel);
  const connection = useStore((s) => s.connection);
  const connectionDetail = useStore((s) => s.connectionDetail);
  const testConnection = useStore((s) => s.testConnection);

  const isVL = /vl/i.test(model.modelFamily);
  const maskedKey = model.apiKey ? "****" : "";
  const envLines = [
    `MIDSCENE_MODEL_BASE_URL=${model.baseUrl}`,
    `MIDSCENE_MODEL_API_KEY=${maskedKey}`,
    `MIDSCENE_MODEL_NAME=${model.modelName}`,
  ];
  if (isVL) envLines.push("MIDSCENE_USE_QWEN3_VL=1");
  const envText = envLines.join("\n");

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
  };

  return (
    <>
      <TopBar />
      <div className="flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-2xl space-y-4">
          <div>
            <h1 className="font-display text-lg font-medium text-foreground">
              {t("model.title")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("model.subtitle")}
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div>
              <label
                htmlFor="baseUrl"
                className="mb-1 block text-xs text-muted-foreground"
              >
                {t("model.baseUrl")}
              </label>
              <input
                id="baseUrl"
                type="text"
                value={model.baseUrl}
                onChange={(e) => setModel({ baseUrl: e.target.value })}
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div>
              <label
                htmlFor="apiKey"
                className="mb-1 block text-xs text-muted-foreground"
              >
                {t("model.apiKey")}
              </label>
              <input
                id="apiKey"
                type="password"
                value={model.apiKey}
                onChange={(e) => setModel({ apiKey: e.target.value })}
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div>
              <label
                htmlFor="modelName"
                className="mb-1 block text-xs text-muted-foreground"
              >
                {t("model.modelName")}
              </label>
              <input
                id="modelName"
                type="text"
                value={model.modelName}
                onChange={(e) => setModel({ modelName: e.target.value })}
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div>
              <label
                htmlFor="modelFamily"
                className="mb-1 block text-xs text-muted-foreground"
              >
                {t("model.modelFamily")}
              </label>
              <input
                id="modelFamily"
                type="text"
                value={model.modelFamily}
                onChange={(e) => setModel({ modelFamily: e.target.value })}
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("model.modelFamilyHelp")}
              </p>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <Button
                variant="primary"
                onClick={() => testConnection()}
                disabled={connection === "testing"}
              >
                {connection === "testing" && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                {t("model.testConnection")}
              </Button>
              <Cpu className="h-4 w-4 text-muted-foreground" />
            </div>

            <div>
              {connection === "ok" && (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950">
                  <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                    <CheckCircle className="h-4 w-4" />
                    {t("model.okTitle")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("model.okHelp")}
                  </p>
                </div>
              )}

              {connection === "notMultimodal" && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-red-600 dark:text-red-400">
                    <AlertTriangle className="h-4 w-4" />
                    {t("model.notMultimodalTitle")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("model.notMultimodalHelp")}
                  </p>
                </div>
              )}

              {connection === "fail" && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
                  <p className="flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400">
                    <AlertTriangle className="h-4 w-4" />
                    {t("model.failTitle")}
                  </p>
                </div>
              )}

              {connection === "idle" && (
                <p className="text-xs text-muted-foreground">{t("model.notTested")}</p>
              )}

              {connection === "testing" && (
                <p className="text-xs text-muted-foreground">
                  {t("model.probing")}
                </p>
              )}

              {connectionDetail &&
                connection !== "idle" &&
                connection !== "testing" && (
                  <p className="mt-2 break-words font-mono text-[11px] text-muted-foreground">
                    {connectionDetail}
                  </p>
                )}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-sm font-medium text-foreground">
                {t("model.endpointPreview")}
              </h2>
              <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                HOST localhost
              </span>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-xs text-muted-foreground">
                  {t("model.openaiApi")}
                </span>
                <code className="flex-1 truncate font-mono text-xs text-foreground">
                  {model.baseUrl}
                </code>
                <button
                  onClick={() => copy(model.baseUrl)}
                  className="cursor-pointer text-muted-foreground hover:text-foreground"
                  aria-label="Copy base URL"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-xs text-muted-foreground">
                  {t("model.visionModel")}
                </span>
                <code className="flex-1 truncate font-mono text-xs text-foreground">
                  {model.modelName}
                </code>
                <button
                  onClick={() => copy(model.modelName)}
                  className="cursor-pointer text-muted-foreground hover:text-foreground"
                  aria-label="Copy vision model"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-sm font-medium text-foreground">
                {t("model.envVars")}
              </h2>
              <Button onClick={() => copy(envText)}>
                <Copy className="h-3.5 w-3.5" />
                {t("common.copy")}
              </Button>
            </div>
            <pre
              className={cn(
                "overflow-auto rounded-md bg-background p-3 font-mono text-[11px] text-foreground",
              )}
            >
              {envText}
            </pre>
          </div>

          <ChainConfigCard />

          <div className="pt-2">
            <h2 className="font-display text-base font-medium text-foreground">
              {t("model.envsSecrets")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("model.envsSecretsHelp")}
            </p>
          </div>

          <EnvironmentsCard />
          <SecretsCard />

          <div className="pt-2">
            <h2 className="font-display text-base font-medium text-foreground">
              {t("model.aiSection")}
            </h2>
          </div>
          <DebugPromptsCards />
        </div>
      </div>
    </>
  );
}

// Global LLM-debug toggle + prompt-template editors. Both read/write the backend's
// app settings (/api/settings); the debug card also lists the most recent capture
// files (/api/llm-debug) when logging is on. Degrades gracefully when offline.
function DebugPromptsCards() {
  const t = useT();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [defaults, setDefaults] = useState<PromptTemplates | null>(null);
  const [offline, setOffline] = useState(false);

  // Local, editable copies of the prompts so typing doesn't fire requests.
  const [prompts, setPrompts] = useState<PromptTemplates>({
    explore: "",
    exploreDeepPrefix: "",
    generateCode: "",
  });

  const load = useCallback(async () => {
    try {
      const { settings, defaults } = await api.getSettings();
      setSettings(settings);
      setDefaults(defaults);
      setPrompts(settings.prompts);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (offline) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">{t("model.debugOffline")}</p>
      </div>
    );
  }

  if (!settings || !defaults) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <>
      <LanguageCard settings={settings} setSettings={setSettings} />
      <DebugCard settings={settings} setSettings={setSettings} />
      <PromptsCard
        defaults={defaults}
        prompts={prompts}
        setPrompts={setPrompts}
        onReset={(next) => {
          setPrompts(next.prompts);
          setSettings(next);
        }}
      />
    </>
  );
}

// Global toggle: when on, the current UI language is injected into every AI request so
// the model's natural-language output (flow titles, reasons, steps, assertions, notes)
// comes back in that language. The language followed is whatever the UI is set to.
function LanguageCard({
  settings,
  setSettings,
}: {
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
}) {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const LANG_LABEL: Record<string, string> = { zh: "简体中文", en: "English", ja: "日本語" };

  const toggle = async () => {
    const next = !settings.enforceLang;
    setSettings({ ...settings, enforceLang: next }); // optimistic
    try {
      const { settings: saved } = await api.saveSettings({ enforceLang: next });
      setSettings(saved);
    } catch {
      setSettings({ ...settings, enforceLang: !next });
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <Languages className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">
          {t("model.langCard")}
        </h2>
      </div>

      <label className="mt-2 flex cursor-pointer items-center gap-2.5">
        <button
          type="button"
          role="switch"
          aria-checked={settings.enforceLang}
          onClick={toggle}
          className={cn(
            "relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors",
            settings.enforceLang ? "bg-primary" : "bg-muted",
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
              settings.enforceLang ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
        <span className="text-sm text-foreground">{t("model.langToggle")}</span>
      </label>

      <p className="mt-2 text-xs text-muted-foreground">{t("model.langHelp")}</p>

      {settings.enforceLang && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-foreground">
          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
            {LANG_LABEL[lang] ?? lang}
          </span>
          <span className="text-muted-foreground">{t("model.langCurrent")}</span>
        </p>
      )}
    </div>
  );
}

function DebugCard({
  settings,
  setSettings,
}: {
  settings: AppSettings;
  setSettings: (s: AppSettings) => void;
}) {
  const t = useT();
  const [captures, setCaptures] = useState<{
    dir?: string;
    entries: string[];
  } | null>(null);
  const [loadingCaptures, setLoadingCaptures] = useState(false);

  const refreshCaptures = useCallback(async () => {
    setLoadingCaptures(true);
    try {
      const { dir, entries } = await api.getLlmDebug();
      setCaptures({ dir, entries });
    } catch {
      setCaptures({ entries: [] });
    } finally {
      setLoadingCaptures(false);
    }
  }, []);

  useEffect(() => {
    if (settings.debugLLM) void refreshCaptures();
    else setCaptures(null);
  }, [settings.debugLLM, refreshCaptures]);

  const toggle = async () => {
    const next = !settings.debugLLM;
    // Optimistic; revert on failure.
    setSettings({ ...settings, debugLLM: next });
    try {
      const { settings: saved } = await api.saveSettings({ debugLLM: next });
      setSettings(saved);
    } catch {
      setSettings({ ...settings, debugLLM: !next });
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <Bug className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">
          {t("model.debugCard")}
        </h2>
      </div>

      <label className="mt-2 flex cursor-pointer items-center gap-2.5">
        <button
          type="button"
          role="switch"
          aria-checked={settings.debugLLM}
          onClick={toggle}
          className={cn(
            "relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors",
            settings.debugLLM ? "bg-primary" : "bg-muted",
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
              settings.debugLLM ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
        <span className="text-sm text-foreground">{t("model.debugToggle")}</span>
      </label>

      <p className="mt-2 text-xs text-muted-foreground">{t("model.debugHelp")}</p>

      {settings.debugLLM && (
        <div className="mt-3 border-t border-border pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">
              {captures ? captures.entries.length : 0}{" "}
              {t("model.debugCapturesCount")}
            </span>
            <button
              onClick={refreshCaptures}
              disabled={loadingCaptures}
              className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", loadingCaptures && "animate-spin")}
              />
              {t("model.refresh")}
            </button>
          </div>
          {captures?.dir && (
            <p className="mb-2 break-all font-mono text-[11px] text-muted-foreground">
              {captures.dir}
            </p>
          )}
          {captures && captures.entries.length > 0 ? (
            <div className="max-h-40 overflow-auto rounded-md bg-background p-2">
              {captures.entries.slice(0, 10).map((name) => (
                <p
                  key={name}
                  className="truncate font-mono text-[11px] text-muted-foreground"
                >
                  {name}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("model.debugNoCaptures")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const PROMPT_KEYS: {
  key: keyof PromptTemplates;
  label: string;
  desc: string;
  hint?: string;
}[] = [
  {
    key: "explore",
    label: "model.promptExplore",
    desc: "model.promptExploreDesc",
    hint: "model.promptExploreHint",
  },
  {
    key: "exploreDeepPrefix",
    label: "model.promptDeepPrefix",
    desc: "model.promptDeepPrefixDesc",
  },
  {
    key: "generateCode",
    label: "model.promptGenerateCode",
    desc: "model.promptGenerateCodeDesc",
  },
];

function PromptsCard({
  defaults,
  prompts,
  setPrompts,
  onReset,
}: {
  defaults: PromptTemplates;
  prompts: PromptTemplates;
  setPrompts: (p: PromptTemplates) => void;
  onReset: (settings: AppSettings) => void;
}) {
  const t = useT();
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [detail, setDetail] = useState("");

  // Reset-to-default is available whenever the editors differ from defaults.
  const dirty = PROMPT_KEYS.some(({ key }) => prompts[key] !== defaults[key]);
  // Track the last persisted value so Save only enables on unsaved edits.
  const [saved, setSaved] = useState<PromptTemplates>(prompts);
  const editorsDirty = PROMPT_KEYS.some(({ key }) => prompts[key] !== saved[key]);

  const save = async () => {
    setState("saving");
    setDetail("");
    try {
      const { settings } = await api.saveSettings({ prompts });
      setPrompts(settings.prompts);
      setSaved(settings.prompts);
      setState("saved");
      window.setTimeout(() => setState("idle"), 1500);
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  const reset = async () => {
    setState("saving");
    setDetail("");
    try {
      const { settings } = await api.resetPrompts();
      setSaved(settings.prompts);
      onReset(settings);
      setState("saved");
      window.setTimeout(() => setState("idle"), 1500);
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">
          {t("model.promptsCard")}
        </h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("model.promptsHelp")}
      </p>

      <div className="space-y-4">
        {PROMPT_KEYS.map(({ key, label, desc, hint }) => {
          const modified = prompts[key] !== defaults[key];
          return (
            <div key={key}>
              <div className="mb-1 flex items-center gap-2">
                <label
                  htmlFor={`prompt-${key}`}
                  className="text-xs font-medium text-foreground"
                >
                  {t(label)}
                </label>
                {modified && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                    {t("model.modified")}
                  </span>
                )}
              </div>
              <p className="mb-1 text-[11px] text-muted-foreground">{t(desc)}</p>
              <textarea
                id={`prompt-${key}`}
                rows={key === "exploreDeepPrefix" ? 5 : 8}
                value={prompts[key]}
                onChange={(e) =>
                  setPrompts({ ...prompts, [key]: e.target.value })
                }
                className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
              {hint && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t(hint)}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-border pt-3">
        <Button
          variant="primary"
          onClick={save}
          disabled={state === "saving" || !editorsDirty}
        >
          {state === "saving" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t("common.save")}
        </Button>
        <Button onClick={reset} disabled={state === "saving" || !dirty}>
          <RotateCcw className="h-3.5 w-3.5" />
          {t("model.resetPrompts")}
        </Button>
        {state === "saved" && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="h-4 w-4" /> {t("model.saved")}
          </span>
        )}
        {editorsDirty && state !== "saved" && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            {t("model.modified")}
          </span>
        )}
        {state === "error" && (
          <span className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle className="h-4 w-4" /> {detail}
          </span>
        )}
      </div>
    </div>
  );
}

// Chain / RPC config for the injected-wallet dapp-testing capability. Reads/writes the
// backend's runtime chain config (/api/config); point it at a local fork, Tenderly, etc.
function ChainConfigCard() {
  const t = useT();
  const [rpcUrl, setRpcUrl] = useState("");
  const [chainId, setChainId] = useState<number>(1);
  const [account, setAccount] = useState<string>("");
  const [state, setState] = useState<"loading" | "idle" | "saving" | "saved" | "error">(
    "loading",
  );
  const [detail, setDetail] = useState("");

  useEffect(() => {
    api
      .getConfig()
      .then((c) => {
        setRpcUrl(c.chain.rpcUrl);
        setChainId(c.chain.chainId);
        setAccount(c.account);
        setState("idle");
      })
      .catch(() => {
        setState("error");
        setDetail(t("model.chainOffline"));
      });
  }, []);

  const save = async () => {
    setState("saving");
    try {
      const c = await api.saveConfig({ rpcUrl, chainId });
      setRpcUrl(c.chain.rpcUrl);
      setChainId(c.chain.chainId);
      setState("saved");
      setDetail("");
      window.setTimeout(() => setState("idle"), 1500);
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <Server className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">
          {t("model.chainRpc")}
        </h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("model.chainHelp")}
      </p>

      <div className="space-y-3">
        <div>
          <label
            htmlFor="rpcUrl"
            className="mb-1 block text-xs text-muted-foreground"
          >
            {t("model.rpcUrl")}
          </label>
          <input
            id="rpcUrl"
            type="text"
            value={rpcUrl}
            placeholder="http://127.0.0.1:8545"
            onChange={(e) => setRpcUrl(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div>
          <label
            htmlFor="chainId"
            className="mb-1 block text-xs text-muted-foreground"
          >
            {t("model.chainId")}
          </label>
          <input
            id="chainId"
            type="number"
            value={chainId}
            onChange={(e) => setChainId(Number(e.target.value))}
            className="w-40 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button
            variant="primary"
            onClick={save}
            disabled={state === "saving" || state === "loading"}
          >
            {state === "saving" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("model.saveChainConfig")}
          </Button>
          {state === "saved" && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle className="h-4 w-4" /> {t("model.saved")}
            </span>
          )}
          {state === "error" && (
            <span className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
              <AlertTriangle className="h-4 w-4" /> {detail}
            </span>
          )}
        </div>

        {account && (
          <p className="pt-1 font-mono text-[11px] text-muted-foreground">
            test wallet: {account}
          </p>
        )}
      </div>
    </div>
  );
}

const NEW_ENV = "__new__";
type VarRow = { key: string; value: string };

function blankEnvForm() {
  return {
    id: undefined as string | undefined,
    name: "",
    baseUrl: "",
    vars: [{ key: "", value: "" }] as VarRow[],
    authRequired: false,
    steps: "",
    isDefault: false,
  };
}

function formFromEnv(env: Environment) {
  const vars = Object.entries(env.vars ?? {}).map(([key, value]) => ({ key, value }));
  return {
    id: env.id,
    name: env.name,
    baseUrl: env.baseUrl,
    vars: vars.length ? vars : [{ key: "", value: "" }],
    authRequired: !!env.login?.authRequired,
    steps: (env.login?.steps ?? []).join("\n"),
    isDefault: env.isDefault,
  };
}

// Per-project environments: base URL, non-secret vars, optional login flow, default toggle.
function EnvironmentsCard() {
  const t = useT();
  const projectId = useStore((s) => s.activeProjectId);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [selected, setSelected] = useState<string>(NEW_ENV);
  const [form, setForm] = useState(blankEnvForm());
  const [state, setState] = useState<"loading" | "idle" | "saving" | "error">(
    "loading",
  );
  const [detail, setDetail] = useState("");

  const load = useCallback(async () => {
    if (!projectId) {
      setState("idle");
      setEnvs([]);
      return;
    }
    setState("loading");
    try {
      const { environments } = await api.getEnvironments(projectId);
      setEnvs(environments);
      // Auto-select the default env (or the first one) so existing config is visible.
      const target = environments.find((e) => e.isDefault) ?? environments[0];
      if (target) {
        setSelected(target.id);
        setForm(formFromEnv(target));
      } else {
        setSelected(NEW_ENV);
        setForm(blankEnvForm());
      }
      setState("idle");
    } catch {
      setEnvs([]);
      setState("error");
      setDetail("Backend offline — start the server to manage environments.");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pick = (id: string) => {
    setSelected(id);
    setDetail("");
    if (id === NEW_ENV) {
      setForm(blankEnvForm());
      return;
    }
    const env = envs.find((e) => e.id === id);
    if (env) setForm(formFromEnv(env));
  };

  const setVar = (i: number, patch: Partial<VarRow>) =>
    setForm((f) => ({
      ...f,
      vars: f.vars.map((v, idx) => (idx === i ? { ...v, ...patch } : v)),
    }));
  const addVar = () =>
    setForm((f) => ({ ...f, vars: [...f.vars, { key: "", value: "" }] }));
  const removeVar = (i: number) =>
    setForm((f) => ({ ...f, vars: f.vars.filter((_, idx) => idx !== i) }));

  const save = async () => {
    if (!projectId || !form.name.trim()) return;
    setState("saving");
    setDetail("");
    const vars: Record<string, string> = {};
    for (const { key, value } of form.vars) {
      if (key.trim()) vars[key.trim()] = value;
    }
    const login: LoginFlow = {
      authRequired: form.authRequired,
      steps: form.authRequired
        ? form.steps
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    };
    try {
      const { environment } = await api.saveEnvironment(projectId, {
        id: form.id,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        vars,
        login,
        isDefault: form.isDefault,
      });
      await load();
      setSelected(environment.id);
      setState("idle");
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  const remove = async () => {
    if (!form.id) return;
    setState("saving");
    try {
      await api.deleteEnvironment(form.id);
      setSelected(NEW_ENV);
      setForm(blankEnvForm());
      await load();
      setState("idle");
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <Boxes className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">
          {t("model.environments")}
        </h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("model.environmentsHelp")}
      </p>

      {!projectId ? (
        <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          {t("model.selectProjectFirst")}
        </p>
      ) : (
        <div className="space-y-3">
          <div>
            <label
              htmlFor="envPick"
              className="mb-1 block text-xs text-muted-foreground"
            >
              {t("model.environment")}
            </label>
            <select
              id="envPick"
              value={selected}
              onChange={(e) => pick(e.target.value)}
              className="w-full cursor-pointer rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value={NEW_ENV}>{t("model.newEnvironment")}</option>
              {envs.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                  {env.isDefault ? ` (${t("model.default")})` : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="envName"
              className="mb-1 block text-xs text-muted-foreground"
            >
              {t("model.name")}
            </label>
            <input
              id="envName"
              type="text"
              value={form.name}
              placeholder="staging"
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label
              htmlFor="envBaseUrl"
              className="mb-1 block text-xs text-muted-foreground"
            >
              {t("model.baseUrl")}
            </label>
            <input
              id="envBaseUrl"
              type="text"
              value={form.baseUrl}
              placeholder="https://staging.acme.com"
              onChange={(e) =>
                setForm((f) => ({ ...f, baseUrl: e.target.value }))
              }
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {t("model.varsNonSecret")}
              </span>
              <button
                onClick={addVar}
                className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" /> {t("common.add")}
              </button>
            </div>
            <div className="space-y-1.5">
              {form.vars.map((v, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={v.key}
                    placeholder="KEY"
                    onChange={(e) => setVar(i, { key: e.target.value })}
                    className="w-1/3 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
                  />
                  <input
                    type="text"
                    value={v.value}
                    placeholder="value"
                    onChange={(e) => setVar(i, { value: e.target.value })}
                    className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    onClick={() => removeVar(i)}
                    aria-label="Remove variable"
                    className="cursor-pointer text-muted-foreground hover:text-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={form.authRequired}
              onChange={(e) =>
                setForm((f) => ({ ...f, authRequired: e.target.checked }))
              }
              className="h-3.5 w-3.5 cursor-pointer"
            />
            {t("model.requiresLogin")}
          </label>

          {form.authRequired && (
            <div>
              <label
                htmlFor="envSteps"
                className="mb-1 block text-xs text-muted-foreground"
              >
                {t("model.loginFlow")}
              </label>
              <textarea
                id="envSteps"
                rows={4}
                value={form.steps}
                placeholder={
                  "Open ${env.BASE_URL}/login\nType ${env.USER} into the email field\nType ${secret.PASSWORD} into the password field\nClick Sign in"
                }
                onChange={(e) =>
                  setForm((f) => ({ ...f, steps: e.target.value }))
                }
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("model.placeholderReferences")}{" "}
                <code className="font-mono">{"${env.KEY}"}</code> {t("model.andPlaceholders")}{" "}
                <code className="font-mono">{"${secret.KEY}"}</code>{" "}
                {t("model.placeholders")}
              </p>
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) =>
                setForm((f) => ({ ...f, isDefault: e.target.checked }))
              }
              className="h-3.5 w-3.5 cursor-pointer"
            />
            {t("model.defaultEnvironment")}
          </label>

          <div className="flex items-center gap-3 pt-1">
            <Button
              variant="primary"
              onClick={save}
              disabled={
                state === "saving" ||
                state === "loading" ||
                !form.name.trim()
              }
            >
              {state === "saving" && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              {t("model.saveEnvironment")}
            </Button>
            {form.id && (
              <Button onClick={remove} disabled={state === "saving"}>
                <Trash2 className="h-3.5 w-3.5" />
                {t("common.delete")}
              </Button>
            )}
            {state === "error" && (
              <span className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                <AlertTriangle className="h-4 w-4" /> {detail}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Per-project secrets. Values are write-only: the backend never returns them,
// so we only ever list keys + updatedAt.
function SecretsCard() {
  const t = useT();
  const projectId = useStore((s) => s.activeProjectId);
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [state, setState] = useState<"loading" | "idle" | "saving" | "error">(
    "loading",
  );
  const [detail, setDetail] = useState("");

  const load = useCallback(async () => {
    if (!projectId) {
      setState("idle");
      setSecrets([]);
      return;
    }
    setState("loading");
    try {
      const { secrets } = await api.getSecrets(projectId);
      setSecrets(secrets);
      setState("idle");
    } catch {
      setSecrets([]);
      setState("error");
      setDetail("Backend offline — start the server to manage secrets.");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!projectId || !key.trim() || !value) return;
    setState("saving");
    setDetail("");
    try {
      await api.setSecret(projectId, key.trim(), value);
      setKey("");
      setValue("");
      await load();
      setState("idle");
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  const remove = async (k: string) => {
    if (!projectId) return;
    setState("saving");
    try {
      await api.deleteSecret(projectId, k);
      await load();
      setState("idle");
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-display text-sm font-medium text-foreground">
          {t("model.secrets")}
        </h2>
      </div>
      <p className="mb-3 flex items-start gap-1.5 text-xs text-muted-foreground">
        <Lock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        {t("model.secretsHelp")}{" "}
        <code className="font-mono">{"${secret.KEY}"}</code>.
      </p>

      {!projectId ? (
        <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          {t("model.selectProjectFirst")}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            {state === "loading" ? (
              <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
            ) : secrets.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                {t("model.noSecrets")}
              </p>
            ) : (
              secrets.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5"
                >
                  <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                  <code className="flex-1 truncate font-mono text-xs text-foreground">
                    {s.key}
                  </code>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    ••••••
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(s.updatedAt).toLocaleDateString()}
                  </span>
                  <button
                    onClick={() => remove(s.key)}
                    aria-label={`Delete secret ${s.key}`}
                    className="cursor-pointer text-muted-foreground hover:text-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="flex items-end gap-1.5 border-t border-border pt-3">
            <div className="w-1/3">
              <label
                htmlFor="secretKey"
                className="mb-1 block text-xs text-muted-foreground"
              >
                {t("model.key")}
              </label>
              <input
                id="secretKey"
                type="text"
                value={key}
                placeholder="PASSWORD"
                onChange={(e) => setKey(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex-1">
              <label
                htmlFor="secretValue"
                className="mb-1 block text-xs text-muted-foreground"
              >
                {t("model.valueWriteOnly")}
              </label>
              <input
                id="secretValue"
                type="password"
                value={value}
                placeholder="••••••••"
                autoComplete="new-password"
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <Button
              variant="primary"
              onClick={save}
              disabled={state === "saving" || !key.trim() || !value}
            >
              {state === "saving" && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              {t("common.save")}
            </Button>
          </div>

          {state === "error" && (
            <span className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
              <AlertTriangle className="h-4 w-4" /> {detail}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
