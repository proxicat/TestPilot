import {
  Radar,
  Play,
  Sparkles,
  RefreshCw,
  Copy,
  Check,
  Download,
  Ban,
  Wand2,
  Loader2,
  Bug,
  CircleCheck,
  CircleX,
  AlertTriangle,
  Lock,
  Plus,
  Trash2,
  Blocks,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import type {
  ChainAssertion,
  Flakiness,
  Priority,
  RunRecord,
  Step,
  TestCase,
  Web3Mode,
} from "@/lib/types";
import { RunDetail } from "@/components/RunDetail";
import { cn } from "@/lib/cn";
import { api, type RefineTarget } from "@/lib/api";
import { useT } from "@/lib/prefs";
import { TopBar } from "@/components/TopBar";
import { Drawer, Dialog } from "@/components/overlay";
import {
  Button,
  PriorityBadge,
  RunStatusPill,
  CodeIndicator,
  TypeBadge,
  StabilityChip,
} from "@/components/ui";

const COLUMNS: Priority[] = ["P0", "P1", "P2"];

function CaseCard({
  tc,
  active,
  flake,
  onClick,
}: {
  tc: TestCase;
  active: boolean;
  flake?: Flakiness;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full cursor-pointer rounded-xl border bg-card p-3 text-left transition-colors hover:border-foreground/30",
        active ? "border-2 border-primary" : "border-border",
      )}
    >
      <div className="mb-2 flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">
          {tc.title}
        </span>
        <TypeBadge type={tc.type} className="shrink-0" />
      </div>
      {(flake || tc.quarantined) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {flake && (
            <StabilityChip verdict={flake.verdict} failRate={flake.failRate} />
          )}
          {tc.quarantined && (
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              <Ban className="h-3 w-3" /> {t("cases.quarantined")}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <RunStatusPill status={tc.runStatus} />
        <span className="ml-auto">
          <CodeIndicator hasCode={tc.hasCode} />
        </span>
      </div>
    </button>
  );
}

function Column({
  priority,
  activeId,
  flakeById,
  onSelect,
}: {
  priority: Priority;
  activeId: string;
  flakeById: Record<string, Flakiness>;
  onSelect: (id: string) => void;
}) {
  const allCases = useStore((s) => s.cases);
  const cases = allCases.filter((c) => c.priority === priority);
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2.5 flex items-center gap-1.5">
        <PriorityBadge priority={priority} />
        <span className="text-xs text-muted-foreground">{cases.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {cases.map((c) => (
          <CaseCard
            key={c.id}
            tc={c}
            active={c.id === activeId}
            flake={flakeById[c.id]}
            onClick={() => onSelect(c.id)}
          />
        ))}
      </div>
    </div>
  );
}

// Quick-prompt chips per target — fill the input when clicked. Stored as dict
// keys so the visible chip text follows the current language.
const QUICK_PROMPTS: Record<RefineTarget, string[]> = {
  steps: ["cases.prompt.addWait", "cases.prompt.robustLocators", "cases.prompt.splitSteps"],
  oracle: [
    "cases.prompt.moreSpecific",
    "cases.prompt.assertVisibleText",
    "cases.prompt.checkErrorToast",
  ],
  data: [
    "cases.prompt.lockedAccount",
    "cases.prompt.emptyEmail",
    "cases.prompt.parametrizeEmail",
  ],
};

// The three refine targets, in display order, for the segmented control.
const REFINE_TARGETS: { target: RefineTarget; label: string }[] = [
  { target: "steps", label: "cases.target.steps" },
  { target: "oracle", label: "cases.target.oracle" },
  { target: "data", label: "cases.target.data" },
];

// A single old/new diff line row (full-list replace, no LCS).
function DiffRow({ kind, text }: { kind: "removed" | "added"; text: string }) {
  return (
    <div
      className={cn(
        "flex gap-1.5 rounded px-1.5 py-0.5 font-mono text-[11px] leading-relaxed",
        kind === "removed"
          ? "bg-red-50 text-red-700 line-through dark:bg-red-950 dark:text-red-300"
          : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
      )}
    >
      <span className="select-none opacity-60">{kind === "removed" ? "−" : "+"}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{text}</span>
    </div>
  );
}

// Unified ⌘K-style AI refine affordance. A single entry opens the box; a
// segmented control picks the target (steps / oracle / data). It calls the
// (non-mutating) refine endpoint, previews a line-by-line diff, and applies the
// proposal via patchCase. Both `steps` and `data` targets return updated steps
// and apply to case.steps; `oracle` applies to case.expected.
function RefineBox({ tc }: { tc: TestCase }) {
  const t = useT();
  const patchCase = useStore((s) => s.patchCase);
  const [target, setTarget] = useState<RefineTarget>("steps");
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof api.refineCase>
  > | null>(null);

  const reset = () => {
    setTarget("steps");
    setInstruction("");
    setResult(null);
    setError(false);
    setLoading(false);
  };

  // Switching target clears any in-flight proposal so the diff never mixes
  // steps against an oracle etc.
  const pickTarget = (next: RefineTarget) => {
    if (next === target) return;
    setTarget(next);
    setResult(null);
    setError(false);
  };

  const generate = async () => {
    if (!instruction.trim() || loading) return;
    setLoading(true);
    setError(false);
    setResult(null);
    try {
      const r = await api.refineCase(tc.id, target, instruction.trim());
      setResult(r);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  // `oracle` applies to expected; `steps` and `data` both apply to case.steps.
  const appliesToSteps = target === "steps" || target === "data";

  const accept = async () => {
    if (!result) return;
    try {
      if (appliesToSteps && result.proposed.steps) {
        const steps: Step[] = result.proposed.steps.map((text, i) => ({
          order: i + 1,
          text,
        }));
        await patchCase(tc.id, { steps });
      } else if (target === "oracle" && typeof result.proposed.expected === "string") {
        await patchCase(tc.id, { expected: result.proposed.expected });
      }
      reset();
    } catch {
      setError(true);
    }
  };

  const placeholder =
    target === "oracle"
      ? t("cases.refineOraclePlaceholder")
      : target === "data"
        ? t("cases.refineDataPlaceholder")
        : t("cases.refineStepsPlaceholder");

  // Old/new value pairs for the diff preview.
  const oldLines = appliesToSteps
    ? tc.steps.map((s) => s.text)
    : [tc.expected ?? t("cases.noAssertionYet")];
  const newLines = appliesToSteps
    ? result?.proposed.steps ?? []
    : [result?.proposed.expected ?? ""];

  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900 dark:bg-violet-950/30">
      {/* Header: title + target segmented control (steps / oracle / data) */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium text-violet-700 dark:text-violet-300">
          <Sparkles className="h-4 w-4" /> {t("cases.askAiShort")}
        </span>
        <div className="ml-auto inline-flex rounded-md border border-violet-200 bg-background p-0.5 dark:border-violet-900">
          {REFINE_TARGETS.map(({ target: tg, label }) => (
            <button
              key={tg}
              onClick={() => pickTarget(tg)}
              className={cn(
                "cursor-pointer rounded px-2.5 py-1 text-xs font-medium transition-colors",
                target === tg
                  ? "bg-violet-600 text-white"
                  : "text-violet-600 hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-900",
              )}
            >
              {t(label)}
            </button>
          ))}
        </div>
      </div>

      {/* Prompt input + generate, side by side and roomy */}
      <div className="flex items-center gap-2">
        <Wand2 className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" />
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void generate();
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <Button
          variant="primary"
          className="shrink-0 bg-violet-600 hover:bg-violet-700"
          disabled={loading || !instruction.trim()}
          onClick={generate}
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> {t("common.generating")}
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" /> {t("common.generate")}
            </>
          )}
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {QUICK_PROMPTS[target].map((q) => (
          <button
            key={q}
            onClick={() => setInstruction(t(q))}
            className="cursor-pointer rounded-full border border-violet-200 bg-background px-2 py-0.5 text-xs text-violet-600 hover:bg-violet-100 dark:border-violet-900 dark:text-violet-300 dark:hover:bg-violet-900"
          >
            {t(q)}
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {t("cases.refineFailed")}
        </p>
      )}

      {result && (
        <div className="mt-3">
          {result.note && (
            <div className="mb-1.5 flex items-start gap-1 text-xs text-violet-700 dark:text-violet-300">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{result.note}</span>
            </div>
          )}
          <div className="space-y-0.5">
            {oldLines.map((tx, i) => (
              <DiffRow key={`o-${i}`} kind="removed" text={tx} />
            ))}
            {newLines.map((tx, i) => (
              <DiffRow key={`n-${i}`} kind="added" text={tx} />
            ))}
          </div>
          <div className="mt-2 flex gap-1.5">
            <Button variant="success" className="flex-1 text-xs" onClick={accept}>
              <Check className="h-3.5 w-3.5" /> {t("common.accept")}
            </Button>
            <Button
              variant="outline"
              className="flex-1 text-xs"
              onClick={() => setResult(null)}
            >
              {t("common.discard")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Feature A: live visual debug over SSE ----
const API = "http://localhost:5301";

type DebugKind = "login" | "step";
interface PlanStep {
  text: string;
  kind: DebugKind;
}
// One row in the timeline: a planned step or an assertion, with live status +
// its latest screenshot.
interface TimelineItem {
  key: string;
  kind: "step" | "assert";
  idx?: number;
  text: string;
  stepKind?: DebugKind;
  status: "running" | "done" | "pass" | "fail";
  detail?: string;
  screenshot?: string;
}
type DoneStatus = "passed" | "failed" | "error";
// How the user wants to act on a failure: guide a transient re-run, or rewrite (and save)
// the steps / the assertion. Chosen explicitly; falls back to a safe per-failure default.
type FixMode = "retry" | "steps" | "oracle";

function statusIcon(status: TimelineItem["status"]) {
  if (status === "running")
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  if (status === "fail")
    return <CircleX className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />;
  return <CircleCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />;
}

function DebugModal({ tc, onClose }: { tc: TestCase; onClose: () => void }) {
  const t = useT();
  const esRef = useRef<EventSource | null>(null);
  const [hint, setHint] = useState("");
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [selectedShot, setSelectedShot] = useState<string | undefined>();
  const [done, setDone] = useState<{ status: DoneStatus; message?: string } | null>(null);
  const [lost, setLost] = useState(false);
  // Bumping this restarts the stream (used by "retry with hint").
  const [runNonce, setRunNonce] = useState(0);
  // The hint captured at the moment a run starts, so editing the input mid-run
  // doesn't change the live query.
  const [activeHint, setActiveHint] = useState("");
  // "Fix with AI": turn the hint into an actual edit of the failing node (persisted).
  const patchCase = useStore((s) => s.patchCase);
  const [fixState, setFixState] = useState<"idle" | "loading" | "error">("idle");
  // User's explicit choice of what to change (null = follow the safe auto-default).
  const [fixMode, setFixMode] = useState<FixMode | null>(null);
  const [fixProposal, setFixProposal] = useState<{
    target: "steps" | "oracle";
    oldLines: string[];
    newLines: string[];
    note: string;
  } | null>(null);

  const closeStream = () => {
    esRef.current?.close();
    esRef.current = null;
  };

  useEffect(() => {
    setItems([]);
    setSelectedShot(undefined);
    setDone(null);
    setLost(false);
    setFixMode(null);
    setFixProposal(null);
    setFixState("idle");

    const qs = activeHint.trim() ? `?hint=${encodeURIComponent(activeHint.trim())}` : "";
    const es = new EventSource(`${API}/api/cases/${tc.id}/debug${qs}`);
    esRef.current = es;

    es.onmessage = (e) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      const type = ev.type as string;

      if (type === "start") {
        // Seed the timeline from the plan. Rows start as "running" (pending);
        // subsequent step events flip them to done/fail.
        const plan = (ev.steps as PlanStep[] | undefined) ?? [];
        setItems(
          plan.map((p, i) => ({
            key: `step-${i}`,
            kind: "step",
            idx: i,
            text: p.text,
            stepKind: p.kind,
            status: "running" as const,
          })),
        );
      } else if (type === "navigated") {
        const shot = ev.screenshot as string | undefined;
        if (shot) setSelectedShot(shot);
      } else if (type === "step") {
        const idx = ev.idx as number;
        const status = ev.status as TimelineItem["status"];
        const shot = ev.screenshot as string | undefined;
        if (shot) setSelectedShot(shot);
        setItems((prev) => {
          const next = [...prev];
          const at = next.findIndex((it) => it.kind === "step" && it.idx === idx);
          const patch: Partial<TimelineItem> = {
            status,
            detail: ev.detail as string | undefined,
            text: (ev.text as string) ?? next[at]?.text ?? "",
            stepKind: (ev.kind as DebugKind) ?? next[at]?.stepKind,
            screenshot: shot ?? next[at]?.screenshot,
          };
          if (at >= 0) next[at] = { ...next[at], ...patch };
          else
            next.push({
              key: `step-${idx}`,
              kind: "step",
              idx,
              text: patch.text ?? "",
              status,
              detail: patch.detail,
              stepKind: patch.stepKind,
              screenshot: shot,
            });
          return next;
        });
      } else if (type === "assert") {
        const status = ev.status as TimelineItem["status"];
        const shot = ev.screenshot as string | undefined;
        if (shot) setSelectedShot(shot);
        const assertion = (ev.assertion as string) ?? "";
        setItems((prev) => {
          const next = [...prev];
          const at = next.findIndex((it) => it.kind === "assert");
          const patch: TimelineItem = {
            key: "assert",
            kind: "assert",
            text: assertion,
            status,
            detail: ev.detail as string | undefined,
            screenshot: shot,
          };
          if (at >= 0) next[at] = { ...next[at], ...patch, screenshot: shot ?? next[at].screenshot };
          else next.push(patch);
          return next;
        });
      } else if (type === "done") {
        setDone({
          status: ev.status as DoneStatus,
          message: ev.message as string | undefined,
        });
        closeStream();
      }
    };

    es.onerror = () => {
      // A normal terminal close also fires onerror; only surface it if we
      // didn't already receive a done event.
      setDone((d) => {
        if (!d) setLost(true);
        return d;
      });
      closeStream();
    };

    return closeStream;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tc.id, runNonce]);

  const retry = () => {
    setFixProposal(null);
    setActiveHint(hint);
    setRunNonce((n) => n + 1);
  };

  const running = !done && !lost;
  const failedItem = items.find((it) => it.status === "fail");

  // Auto-scroll the timeline to the failing node so the user sees it without hunting.
  const failRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (failedItem) failRef.current?.scrollIntoView({ block: "nearest" });
  }, [failedItem?.key]);

  const failedLabel = failedItem
    ? failedItem.kind === "assert"
      ? t("cases.debugAssert")
      : failedItem.stepKind === "login"
        ? t("cases.debugLogin")
        : `${t("cases.debugStep")} ${(failedItem.idx ?? 0) + 1}`
    : "";

  // What the user wants to change is DECOUPLED from what failed. `fixMode` is the
  // user's explicit choice; when null we fall back to a safe auto-default:
  //   • a failed step        → "steps"  (rewrite the step)
  //   • a failed assertion   → "retry"  (usually an earlier step / the environment is
  //                                       off — do NOT default to weakening the oracle)
  //   • login-step failure   → "retry"  (login belongs to the environment, not the case)
  const loginCount = items.filter((it) => it.kind === "step" && it.stepKind === "login").length;
  const autoMode: FixMode =
    failedItem && failedItem.kind === "step" && failedItem.stepKind !== "login"
      ? "steps"
      : "retry";
  const mode: FixMode = fixMode ?? autoMode;

  // Rewrite a case node (steps or oracle) from the prompt → preview a diff → Accept saves.
  const runFix = async (target: "steps" | "oracle") => {
    if (!hint.trim()) return;
    setFixState("loading");
    setFixProposal(null);
    try {
      // Focus the rewrite on the failing step when that's what failed; otherwise let the
      // model rewrite the whole list guided by the prompt.
      const stepIdx =
        target === "steps" && failedItem?.kind === "step"
          ? (failedItem.idx ?? 0) - loginCount
          : undefined;
      const r = await api.refineCase(tc.id, target, hint.trim(), stepIdx);
      if (target === "oracle") {
        setFixProposal({
          target: "oracle",
          oldLines: [tc.expected || "(none)"],
          newLines: [r.proposed.expected || ""],
          note: r.note,
        });
      } else {
        setFixProposal({
          target: "steps",
          oldLines: tc.steps.map((s) => s.text),
          newLines: r.proposed.steps ?? [],
          note: r.note,
        });
      }
      setFixState("idle");
    } catch {
      setFixState("error");
    }
  };

  const acceptFix = async () => {
    if (!fixProposal) return;
    if (fixProposal.target === "oracle") {
      await patchCase(tc.id, { expected: fixProposal.newLines[0] });
    } else {
      await patchCase(tc.id, {
        steps: fixProposal.newLines.map((text, i) => ({ order: i + 1, text })),
      });
    }
    // The case is now corrected in the DB; re-run (without the transient hint) to confirm.
    setFixProposal(null);
    setActiveHint("");
    setRunNonce((n) => n + 1);
  };

  const showCorrection =
    done?.status === "failed" || done?.status === "error" || lost || !!failedItem;

  return (
    <Dialog
      open
      onClose={onClose}
      widthClass="max-w-5xl"
      title={`${t("cases.debugTitle")} — ${tc.title}`}
    >
      <div className="flex h-[74vh] w-full flex-col gap-4 md:flex-row">
        {/* LEFT: status → failure summary → timeline → correction */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Status banner */}
          {done && (
            <div
              className={cn(
                "mb-2 flex shrink-0 items-start gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium",
                done.status === "passed" &&
                  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
                done.status === "failed" &&
                  "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
                done.status === "error" &&
                  "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
              )}
            >
              <span className="mt-px shrink-0">
                {done.status === "passed" && <CircleCheck className="h-3.5 w-3.5" />}
                {done.status === "failed" && <CircleX className="h-3.5 w-3.5" />}
                {done.status === "error" && <AlertTriangle className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0 break-words">
                {done.status === "passed"
                  ? t("cases.debugPassed")
                  : done.status === "failed"
                    ? t("cases.debugFailed")
                    : t("cases.debugError")}
                {done.message ? ` — ${done.message}` : ""}
              </span>
            </div>
          )}
          {lost && (
            <div className="mb-2 flex shrink-0 items-center gap-1.5 rounded-md bg-amber-100 px-2 py-1.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" /> {t("cases.debugLost")}
            </div>
          )}
          {running && (
            <div className="mb-2 flex shrink-0 items-center gap-1.5 text-xs text-primary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("cases.debugging")}
            </div>
          )}

          {/* Failure summary — pinned above the timeline so the "what & why" is
              the first thing seen; clicking jumps its screenshot into the panel. */}
          {failedItem && (
            <button
              onClick={() => failedItem.screenshot && setSelectedShot(failedItem.screenshot)}
              className="mb-2 block w-full shrink-0 rounded-md border border-red-300 bg-red-50 p-2 text-left dark:border-red-900 dark:bg-red-950/40"
            >
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-red-700 dark:text-red-300">
                <CircleX className="h-3.5 w-3.5 shrink-0" />
                {t("cases.failedNode")}
                <span className="rounded bg-red-200/70 px-1 text-[9px] uppercase tracking-wide dark:bg-red-900/70">
                  {failedLabel}
                </span>
              </span>
              <span className="mt-1 block break-words text-xs leading-snug text-foreground">
                {failedItem.text}
              </span>
              {failedItem.detail && (
                <span className="mt-1 block max-h-24 overflow-y-auto break-words text-[11px] leading-snug text-red-600 dark:text-red-400">
                  {failedItem.detail}
                </span>
              )}
            </button>
          )}

          {/* Timeline (scrolls) */}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {items.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                {t("cases.debugWaiting")}
              </p>
            ) : (
              items.map((it) => (
                <button
                  key={it.key}
                  ref={it.status === "fail" ? failRef : undefined}
                  onClick={() => it.screenshot && setSelectedShot(it.screenshot)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                    it.screenshot === selectedShot && it.screenshot && "ring-2 ring-primary/40",
                    it.status === "running" && "border-primary/50 bg-primary/5",
                    it.status === "fail" && "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40",
                    it.status !== "running" && it.status !== "fail" && "border-border hover:bg-muted",
                  )}
                >
                  <span className="mt-0.5 shrink-0">{statusIcon(it.status)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="rounded bg-muted px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                        {it.kind === "assert"
                          ? t("cases.debugAssert")
                          : it.stepKind === "login"
                            ? t("cases.debugLogin")
                            : `${t("cases.debugStep")} ${(it.idx ?? 0) + 1}`}
                      </span>
                    </span>
                    <span className="mt-0.5 block break-words text-xs leading-snug text-foreground">
                      {it.text}
                    </span>
                    {it.detail && (
                      <span className="mt-0.5 block break-words text-[11px] leading-snug text-red-600 dark:text-red-400">
                        {it.detail}
                      </span>
                    )}
                  </span>
                  {it.screenshot && (
                    <img
                      src={it.screenshot}
                      alt=""
                      className="h-9 w-14 shrink-0 rounded border border-border object-cover"
                    />
                  )}
                </button>
              ))
            )}
          </div>

          {/* Correction panel. One prompt, then the user chooses WHAT to change —
              independent of what failed. Retry = transient guidance (nothing saved);
              Steps / Assertion = rewrite that node and save. Safe default per failure. */}
          {showCorrection && (
            <div className="mt-2 shrink-0 space-y-2 border-t border-border pt-2.5">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                <Wand2 className="h-3.5 w-3.5 text-violet-500" />
                {t("cases.fixSectionTitle")}
              </div>
              <input
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (mode === "retry") retry();
                    else void runFix(mode);
                  }
                }}
                placeholder={t("cases.hintPlaceholder")}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
              />

              {/* Intent selector: what should the AI change? */}
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t("cases.fixModeQ")}
                </p>
                <div className="inline-flex rounded-md border border-border p-0.5">
                  {(["retry", "steps", "oracle"] as FixMode[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => {
                        setFixMode(m);
                        setFixProposal(null);
                      }}
                      className={cn(
                        "rounded px-2 py-1 text-[11px] transition-colors",
                        mode === m
                          ? "bg-primary/10 font-medium text-primary"
                          : "text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {t(`cases.fixMode.${m}` as Parameters<typeof t>[0])}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {mode === "retry" ? (
                  // Transient re-run — no hint required (good for a flaky failure).
                  <Button variant="outline" className="text-xs" onClick={retry}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    {hint.trim() ? t("cases.retryWithHint") : t("cases.retryPlain")}
                    <span className="ml-1 rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">
                      {t("cases.transientTag")}
                    </span>
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    className="bg-violet-600 text-xs hover:bg-violet-700"
                    onClick={() => void runFix(mode)}
                    disabled={!hint.trim() || fixState === "loading"}
                  >
                    {fixState === "loading" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {mode === "oracle" ? t("cases.rewriteOracle") : t("cases.rewriteSteps")}
                    <span className="ml-1 rounded bg-white/20 px-1 text-[9px] uppercase">
                      {t("cases.persistTag")}
                    </span>
                  </Button>
                )}
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t(`cases.help.${mode}` as Parameters<typeof t>[0])}
              </p>
              {mode === "steps" && failedItem?.stepKind === "login" && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  {t("cases.fixLoginNote")}
                </p>
              )}
              {fixState === "error" && (
                <p className="text-[11px] text-red-600 dark:text-red-400">
                  {t("cases.refineFailed")}
                </p>
              )}
              {/* AI fix diff preview → accept persists to the case and re-runs. */}
              {fixProposal && (
                <div className="overflow-hidden rounded-md border border-border">
                  <div className="flex items-center gap-1.5 border-b border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                    <span className="rounded bg-violet-200/70 px-1 text-[9px] font-medium uppercase tracking-wide text-violet-800 dark:bg-violet-900/70 dark:text-violet-200">
                      {fixProposal.target === "oracle"
                        ? t("cases.debugAssert")
                        : t("cases.steps")}
                    </span>
                    <span className="min-w-0 break-words">{fixProposal.note}</span>
                  </div>
                  <div className="max-h-40 overflow-y-auto font-mono text-[11px]">
                    {fixProposal.oldLines.map((l, i) => (
                      <div
                        key={`o-${i}`}
                        className="break-words bg-red-50 px-2 py-0.5 text-red-700 line-through dark:bg-red-950/40 dark:text-red-300"
                      >
                        − {l}
                      </div>
                    ))}
                    {fixProposal.newLines.map((l, i) => (
                      <div
                        key={`n-${i}`}
                        className="break-words bg-emerald-50 px-2 py-0.5 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                      >
                        + {l}
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-end gap-1.5 border-t border-border bg-muted/50 px-2 py-1.5">
                    <Button variant="outline" className="text-xs" onClick={() => setFixProposal(null)}>
                      {t("common.discard")}
                    </Button>
                    <Button variant="primary" className="text-xs" onClick={acceptFix}>
                      <Check className="h-3.5 w-3.5" /> {t("cases.acceptAndRerun")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* RIGHT: large screenshot of the latest / selected frame */}
        <div className="flex min-h-0 w-full shrink-0 flex-col md:w-[44%]">
          {selectedShot ? (
            <img
              src={selectedShot}
              alt=""
              className="max-h-full w-full rounded-md border border-border object-contain"
            />
          ) : (
            <div className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
              {t("cases.debugNoShot")}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// Web3 run options + on-chain assertions. When a wallet mode is set, the run injects that
// wallet (chain/RPC from the global Web3 config) and waits for the dapp to settle; chain
// assertions read balances before/after the steps and join the oracle.
const INPUT = "rounded border border-border bg-background px-1.5 py-1 text-[11px] outline-none focus:ring-2 focus:ring-ring";
function Web3Section({ tc }: { tc: TestCase }) {
  const t = useT();
  const patchCase = useStore((s) => s.patchCase);
  const mode = tc.web3Mode ?? "";
  const [rows, setRows] = useState<ChainAssertion[]>(tc.chainAssertions ?? []);
  useEffect(() => setRows(tc.chainAssertions ?? []), [tc.id, tc.chainAssertions]);
  const commit = (next: ChainAssertion[]) => {
    setRows(next);
    void patchCase(tc.id, { chainAssertions: next });
  };
  const setLocal = (i: number, patch: Partial<ChainAssertion>) =>
    setRows(rows.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  const commitLocal = (i: number, patch: Partial<ChainAssertion>) =>
    commit(rows.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  const show = mode !== "" || rows.length > 0;

  return (
    <div className="border-b border-border px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Blocks className="h-3.5 w-3.5 text-violet-500" />
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("cases.web3")}</span>
      </div>
      <select
        value={mode}
        onChange={(e) => void patchCase(tc.id, { web3Mode: e.target.value as Web3Mode })}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="">{t("cases.web3None")}</option>
        <option value="injected">{t("cases.web3Injected")}</option>
        <option value="metamask">{t("cases.web3Metamask")}</option>
      </select>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{t("cases.web3Help")}</p>

      {show && (
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">{t("cases.chainAssertions")}</span>
            <button
              onClick={() => commit([...rows, { kind: "erc20Balance", op: "increased", token: "", account: "", value: "", decimals: 6 }])}
              className="flex cursor-pointer items-center gap-1 text-[11px] text-primary hover:underline"
            >
              <Plus className="h-3 w-3" /> {t("common.add")}
            </button>
          </div>
          <div className="space-y-1.5">
            {rows.map((a, i) => (
              <div key={i} className="space-y-1 rounded-md border border-border p-1.5">
                <div className="flex items-center gap-1">
                  <select
                    value={a.kind}
                    onChange={(e) => {
                      const kind = e.target.value as ChainAssertion["kind"];
                      // txSubmitted counts txs (op ≥/≤/=, value=count) — snap sane defaults on switch.
                      commitLocal(i, kind === "txSubmitted" ? { kind, op: "gte", value: a.value || "1" } : { kind });
                    }}
                    className={cn(INPUT, "flex-1")}
                  >
                    <option value="erc20Balance">{t("cases.erc20")}</option>
                    <option value="nativeBalance">{t("cases.native")}</option>
                    <option value="txSubmitted">{t("cases.txSubmitted")}</option>
                  </select>
                  <select value={a.op} onChange={(e) => commitLocal(i, { op: e.target.value as ChainAssertion["op"] })} className={INPUT}>
                    {a.kind !== "txSubmitted" && <option value="increased">↑ increased</option>}
                    {a.kind !== "txSubmitted" && <option value="decreased">↓ decreased</option>}
                    {a.kind !== "txSubmitted" && <option value="changed">≠ changed</option>}
                    <option value="gte">≥</option>
                    <option value="lte">≤</option>
                    <option value="eq">=</option>
                  </select>
                  {(a.kind === "txSubmitted" || a.op === "gte" || a.op === "lte" || a.op === "eq") && (
                    <input
                      value={a.value ?? ""}
                      onChange={(e) => setLocal(i, { value: e.target.value })}
                      onBlur={() => commit(rows)}
                      placeholder={a.kind === "txSubmitted" ? "1" : "0.0"}
                      className={cn(INPUT, "w-14 font-mono")}
                    />
                  )}
                  <button onClick={() => commit(rows.filter((_, idx) => idx !== i))} aria-label="Remove" className="cursor-pointer text-muted-foreground hover:text-red-500">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                {a.kind === "erc20Balance" && (
                  <div className="flex gap-1">
                    <input value={a.token ?? ""} onChange={(e) => setLocal(i, { token: e.target.value })} onBlur={() => commit(rows)} placeholder="token 0x… (USDC 0xA0b8…eB48)" className={cn(INPUT, "min-w-0 flex-1 font-mono")} />
                    <input type="number" value={a.decimals ?? 6} onChange={(e) => commitLocal(i, { decimals: Number(e.target.value) })} title="decimals" className={cn(INPUT, "w-12 font-mono")} />
                  </div>
                )}
                {a.kind === "txSubmitted" ? (
                  <p className="text-[10px] leading-tight text-muted-foreground">{t("cases.txSubmittedHint")}</p>
                ) : (
                  <input value={a.account ?? ""} onChange={(e) => setLocal(i, { account: e.target.value })} onBlur={() => commit(rows)} placeholder={t("cases.accountDefault")} className={cn(INPUT, "w-full font-mono")} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailPanel({ tc, flake }: { tc: TestCase; flake?: Flakiness }) {
  const t = useT();
  const setPriority = useStore((s) => s.setPriority);
  const generateCode = useStore((s) => s.generateCode);
  const runCase = useStore((s) => s.runCase);
  const setQuarantine = useStore((s) => s.setQuarantine);
  const patchCase = useStore((s) => s.patchCase);
  const [copied, setCopied] = useState(false);
  // Data-driven binding draft (patched on blur to avoid a request per keystroke).
  const [dataKeyDraft, setDataKeyDraft] = useState(tc.dataKey ?? "");
  useEffect(() => setDataKeyDraft(tc.dataKey ?? ""), [tc.id, tc.dataKey]);
  const [debugOpen, setDebugOpen] = useState(false);
  // Last run of THIS case (single or suite) — shown inline. The Runs page is the
  // suite ledger; single-case forensics live here with the case.
  const [lastRun, setLastRun] = useState<RunRecord | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (tc.runStatus === "notRun") {
      setLastRun(null);
      return;
    }
    api
      .getRuns({ caseId: tc.id })
      .then(({ runs }) => {
        if (!cancelled) setLastRun(runs[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setLastRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tc.id, tc.runStatus]);

  const copy = () => {
    if (tc.code) navigator.clipboard?.writeText(tc.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  // Test data the case pulls in: ${env.KEY} / ${secret.KEY} placeholders referenced
  // across steps + expected, plus any bound environment. Empty → the section shows a hint.
  const dataText = [...tc.steps.map((s) => s.text), tc.expected ?? ""].join("\n");
  const envKeys = [...new Set([...dataText.matchAll(/\$\{env\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]))];
  const secretKeys = [...new Set([...dataText.matchAll(/\$\{secret\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]))];
  const hasData = envKeys.length > 0 || secretKeys.length > 0 || !!tc.envRef;

  return (
    <div className="flex flex-col">
      <div className="border-b border-border px-3 py-2.5">
        <div className="mb-1.5 flex items-center gap-1.5">
          <select
            aria-label="Priority"
            value={tc.priority}
            onChange={(e) => setPriority(tc.id, e.target.value as Priority)}
            className="cursor-pointer rounded-md border border-border bg-background px-1.5 py-0.5 text-xs outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="P0">P0</option>
            <option value="P1">P1</option>
            <option value="P2">P2</option>
          </select>
          <TypeBadge type={tc.type} />
          <RunStatusPill status={tc.runStatus} />
        </div>
        {flake && (
          <div className="mt-1.5">
            <StabilityChip verdict={flake.verdict} failRate={flake.failRate} />
          </div>
        )}
      </div>

      <div className="border-b border-border px-3 py-2.5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <Ban className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            {t("cases.quarantine")}
          </span>
          <button
            role="switch"
            aria-checked={!!tc.quarantined}
            aria-label="Toggle quarantine"
            onClick={() => setQuarantine(tc.id, !tc.quarantined)}
            className={cn(
              "relative h-5 w-9 cursor-pointer rounded-full transition-colors",
              tc.quarantined ? "bg-amber-500" : "bg-muted-foreground/30",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                tc.quarantined ? "left-[18px]" : "left-0.5",
              )}
            />
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
          {t("cases.quarantineHelp")}
        </p>
      </div>

      {/* Data section — above Steps. Shows the env/secret data the case uses; empty otherwise. */}
      <div className="border-b border-border px-3 py-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t("cases.data")}
          </span>
        </div>
        {hasData ? (
          <div className="flex flex-col gap-1.5 text-xs">
            {tc.envRef && (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">{t("cases.dataEnvRef")}:</span>
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{tc.envRef}</span>
              </div>
            )}
            {envKeys.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">{t("cases.dataEnv")}:</span>
                {envKeys.map((k) => (
                  <span key={k} className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-[11px] text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                    {"${env." + k + "}"}
                  </span>
                ))}
              </div>
            )}
            {secretKeys.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">{t("cases.dataSecret")}:</span>
                {secretKeys.map((k) => (
                  <span key={k} className="flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 font-mono text-[11px] text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                    <Lock className="h-2.5 w-2.5" />
                    {"${secret." + k + "}"}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-[11px] leading-snug text-muted-foreground">{t("cases.dataEmpty")}</p>
        )}

        {/* Data-driven binding: iterate an env array var — one run per row. */}
        <div className="mt-2 border-t border-border pt-2">
          <div className="mb-1 flex items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t("cases.dataDriven")}
            </span>
            {tc.dataKey && (
              <span className="rounded bg-emerald-100 px-1.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                {"${env." + tc.dataKey + "}"}
              </span>
            )}
          </div>
          <input
            value={dataKeyDraft}
            onChange={(e) => setDataKeyDraft(e.target.value)}
            onBlur={() => {
              const v = dataKeyDraft.trim();
              if (v !== (tc.dataKey ?? "")) void patchCase(tc.id, { dataKey: v });
            }}
            placeholder={t("cases.dataDrivenPlaceholder")}
            className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px] outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            {t("cases.dataDrivenHelp")}
          </p>
        </div>
      </div>

      <div className="border-b border-border px-3 py-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t("cases.steps")}
          </span>
        </div>
        {tc.steps.length > 0 ? (
          <ol className="list-decimal pl-4 text-xs leading-relaxed text-muted-foreground">
            {tc.steps.map((s) => (
              <li key={s.order}>{s.text}</li>
            ))}
          </ol>
        ) : (
          <p className="text-[11px] italic leading-snug text-muted-foreground">
            {t("cases.noSteps")}
          </p>
        )}
        {tc.priorityReason && (
          <div className="mt-2 flex items-start gap-1 rounded-md bg-primary/10 px-2 py-1.5 text-[11px] leading-snug text-primary">
            <Sparkles className="mt-0.5 h-3 w-3 flex-shrink-0" />
            <span>
              {tc.priority} — {tc.priorityReason}
            </span>
          </div>
        )}
      </div>

      <div className="border-b border-border px-3 py-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t("cases.expectedOracle")}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {tc.expected ?? (
            <span className="italic opacity-70">{t("cases.noAssertion")}</span>
          )}
        </p>
      </div>

      <Web3Section tc={tc} />

      <div className="flex flex-col border-b border-border px-3 py-2.5">
        <div className="mb-1.5 flex items-center">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t("cases.generatedCode")}
          </span>
          {tc.code && (
            <button
              onClick={copy}
              aria-label="Copy code"
              className="ml-auto cursor-pointer text-muted-foreground hover:text-foreground"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
        {tc.code ? (
          <pre className="overflow-x-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed">
            {tc.code}
          </pre>
        ) : (
          <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
            {t("cases.noCodeYet")}
          </div>
        )}

        <div className="mt-2.5 flex gap-1.5">
          {tc.hasCode ? (
            <Button
              variant="outline"
              className="flex-1 text-xs"
              onClick={() => generateCode(tc.id)}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("common.regenerate")}
            </Button>
          ) : (
            <Button
              variant="outline"
              className="flex-1 text-xs"
              onClick={() => generateCode(tc.id)}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t("common.generate")}
            </Button>
          )}
          <Button
            variant="outline"
            className="flex-1 border-violet-300 text-xs text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950"
            onClick={() => setDebugOpen(true)}
          >
            <Bug className="h-3.5 w-3.5" />
            {t("cases.debug")}
          </Button>
          <Button
            variant="success"
            className="flex-1 text-xs"
            disabled={tc.runStatus === "running"}
            onClick={() => runCase(tc.id)}
          >
            <Play className="h-3.5 w-3.5" />
            {t("common.run")}
          </Button>
        </div>
      </div>

      {/* Last run of this case, inline (single-case forensics live with the case). */}
      {lastRun && (
        <div className="border-t border-border px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t("cases.lastRun")}
            </span>
          </div>
          <RunDetail run={lastRun} />
        </div>
      )}

      {/* Unified Ask AI — full-width, at the very bottom (steps / oracle / data). */}
      <div className="px-3 py-3">
        <RefineBox tc={tc} />
      </div>

      {debugOpen && <DebugModal tc={tc} onClose={() => setDebugOpen(false)} />}
    </div>
  );
}

export function CasesBoard() {
  const t = useT();
  const navigate = useNavigate();
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const runAllP0 = useStore((s) => s.runAllP0);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const flakiness = useStore((s) => s.flakiness);
  const loadFlakiness = useStore((s) => s.loadFlakiness);
  const active = useStore(
    (s) => s.cases.find((c) => c.id === s.selectedId) ?? s.cases[0],
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  const openCase = (id: string) => {
    select(id);
    setDrawerOpen(true);
  };

  useEffect(() => {
    void loadFlakiness();
  }, [loadFlakiness, activeProjectId]);

  const flakeById: Record<string, Flakiness> = {};
  for (const f of flakiness) flakeById[f.caseId] = f;

  const exportTests = () => {
    if (!activeProjectId) return;
    window.location.href = `http://localhost:5301/api/projects/${activeProjectId}/export`;
  };

  return (
    <>
      <TopBar
        actions={
          <>
            <Button variant="outline" onClick={() => navigate("/explore")}>
              <Radar className="h-3.5 w-3.5" />
              {t("topbar.startExplore")}
            </Button>
            <Button
              variant="outline"
              onClick={exportTests}
              disabled={!activeProjectId}
            >
              <Download className="h-3.5 w-3.5" />
              {t("topbar.exportTests")}
            </Button>
            <Button variant="success" onClick={runAllP0}>
              <Play className="h-3.5 w-3.5" />
              {t("topbar.runAllP0")}
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        {/* Kanban board — full width; clicking a case opens the detail Drawer. */}
        <div className="flex flex-1 gap-2.5 overflow-auto p-3">
          {COLUMNS.map((p) => (
            <Column
              key={p}
              priority={p}
              activeId={drawerOpen ? selectedId : ""}
              flakeById={flakeById}
              onSelect={openCase}
            />
          ))}
        </div>
      </div>

      <Drawer
        open={drawerOpen && !!active}
        onClose={() => setDrawerOpen(false)}
        title={active?.title}
        widthClass="w-[60vw] max-w-[60vw] min-w-[420px]"
      >
        {active && <DetailPanel tc={active} flake={flakeById[active.id]} />}
      </Drawer>
    </>
  );
}
