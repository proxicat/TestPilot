import { useState } from "react";
import {
  AlertTriangle,
  Image,
  Clock,
  ExternalLink,
  Check,
  X,
  Eye,
  Gauge,
  CheckSquare,
  Wand2,
} from "lucide-react";
import { PriorityBadge, RunStatusPill } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import type { RunRecord, VisualDiff } from "@/lib/types";

const API = "http://localhost:5301";

export function fmtDuration(ms: number): string {
  return (Math.round(ms / 100) / 10).toFixed(1) + "s";
}

// Functional oracle: the explicit assertions verified for this run (pass/fail).
function OracleSection({ run }: { run: RunRecord }) {
  const t = useT();
  const oracle = run.oracle ?? [];
  if (!oracle.length) return null;
  const failed = oracle.filter((o) => o.status === "fail").length;
  return (
    <div className="mt-4">
      <h3 className="flex items-center gap-1.5 font-display text-xs font-medium text-foreground">
        <CheckSquare className="h-3.5 w-3.5" /> {t("runs.functionalOracle")}
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[11px] font-medium",
            failed
              ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
              : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
          )}
        >
          {failed ? `${failed} ${t("runs.failedCount")}` : t("status.passed")}
        </span>
      </h3>
      <div className="mt-1.5 space-y-1">
        {oracle.map((o, i) => (
          <div
            key={i}
            className={cn(
              "flex items-start gap-1.5 rounded-md p-2 text-xs",
              o.status === "pass"
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
            )}
          >
            {o.status === "pass" ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span>
              {o.assertion}
              {o.status === "fail" && o.detail ? ` — ${o.detail}` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Performance baseline: per-metric current vs baseline with % delta; regressions flagged.
const PERF_LABELS: Record<string, string> = {
  ttfbMs: "TTFB",
  fcpMs: "FCP",
  domContentLoadedMs: "DCL",
  loadMs: "Load",
};
function PerfSection({ run }: { run: RunRecord }) {
  const t = useT();
  const perf = run.perf;
  if (!perf || !perf.verdicts?.length) return null;
  return (
    <div className="mt-4">
      <h3 className="flex items-center gap-1.5 font-display text-xs font-medium text-foreground">
        <Gauge className="h-3.5 w-3.5" /> {t("runs.performance")}
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[11px] font-medium",
            perf.status === "regression"
              ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
              : perf.status === "new_baseline"
                ? "bg-muted text-muted-foreground"
                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
          )}
        >
          {perf.status === "regression"
            ? t("runs.regression")
            : perf.status === "new_baseline"
              ? t("runs.baselineSet")
              : t("runs.withinBudget")}
        </span>
      </h3>
      <table className="mt-1.5 w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-normal">{t("runs.metricMetric")}</th>
            <th className="text-right font-normal">{t("runs.metricCurrent")}</th>
            <th className="text-right font-normal">{t("runs.metricBaseline")}</th>
            <th className="text-right font-normal">Δ</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {perf.verdicts.map((v) => (
            <tr
              key={v.metric}
              className={cn(
                v.status === "regression" && "text-red-600 dark:text-red-400",
              )}
            >
              <td className="py-0.5 font-sans">{PERF_LABELS[v.metric] ?? v.metric}</td>
              <td className="py-0.5 text-right">{v.current}ms</td>
              <td className="py-0.5 text-right text-muted-foreground">
                {typeof v.baseline === "number" ? `${v.baseline}ms` : "—"}
              </td>
              <td className="py-0.5 text-right">
                {typeof v.deltaPct === "number"
                  ? `${v.deltaPct > 0 ? "+" : ""}${v.deltaPct}%`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {perf.status === "new_baseline" && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("runs.perfNewBaseline")}
        </p>
      )}
    </div>
  );
}

// Visual-baseline results for a run: per-step baseline|current|diff with mismatch %, and an
// "Approve" that promotes the current image to the new baseline (accept the change).
function VisualSection({ run }: { run: RunRecord }) {
  const t = useT();
  const [approved, setApproved] = useState<Record<number, boolean>>({});
  const visual = run.visual ?? [];
  if (!visual.length) return null;
  const changed = visual.filter((v) => v.status === "diff");
  const newBaselines = visual.filter((v) => v.status === "new_baseline").length;

  const approve = async (v: VisualDiff) => {
    try {
      await fetch(`${API}/api/cases/${run.caseId}/baselines/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepIdx: v.stepIdx, ref: v.currentRef }),
      });
      setApproved((a) => ({ ...a, [v.stepIdx]: true }));
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="mt-4">
      <h3 className="flex items-center gap-1.5 font-display text-xs font-medium text-foreground">
        <Eye className="h-3.5 w-3.5" /> {t("runs.visualBaseline")}
        {changed.length > 0 ? (
          <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
            {changed.length}{" "}
            {changed.length > 1 ? t("runs.visualRegressions") : t("runs.visualRegression")}
          </span>
        ) : newBaselines > 0 ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {newBaselines}{" "}
            {newBaselines > 1
              ? t("runs.baselinesEstablished")
              : t("runs.baselineEstablished")}
          </span>
        ) : (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            {t("runs.allMatch")}
          </span>
        )}
      </h3>

      {changed.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {newBaselines > 0 ? t("runs.visualFirstRun") : t("runs.noVisualDiff")}
        </p>
      ) : (
        <div className="mt-1.5 space-y-3">
          {changed.map((v) => (
            <div key={v.stepIdx} className="rounded-md border border-border p-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-red-600 dark:text-red-400">
                  {t("runs.step")} {v.stepIdx + 1} · {v.mismatchPct.toFixed(2)}% {t("runs.stepChanged")}
                </span>
                {approved[v.stepIdx] ? (
                  <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                    <Check className="h-3.5 w-3.5" /> {t("runs.baselineUpdated")}
                  </span>
                ) : (
                  <button
                    onClick={() => approve(v)}
                    className="cursor-pointer rounded border border-border px-2 py-0.5 text-xs hover:bg-muted"
                  >
                    {t("runs.approveAsBaseline")}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { label: "baseline", tkey: "runs.metricBaseline", ref: v.baselineRef },
                  { label: "current", tkey: "runs.metricCurrent", ref: v.currentRef },
                  { label: "diff", tkey: "runs.diff", ref: v.diffRef },
                ].map((col) => (
                  <div key={col.label}>
                    {col.ref ? (
                      <img
                        src={`${API}/api/artifacts/${col.ref}`}
                        alt={col.label}
                        className={cn(
                          "aspect-video w-full rounded border object-cover object-top",
                          col.label === "diff" ? "border-red-300 dark:border-red-800" : "border-border",
                        )}
                      />
                    ) : (
                      <div className="aspect-video rounded bg-muted" />
                    )}
                    <span className="text-[11px] text-muted-foreground">{t(col.tkey)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The full run-detail content (previously an inline right column). Relocated
// unchanged into the Drawer body. Exported so both the Runs page and the Suite
// drill-down render the identical detail UI.
export function RunDetail({ run }: { run: RunRecord }) {
  const t = useT();
  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        <PriorityBadge priority={run.priority} />
        <RunStatusPill status={run.status} />
        {run.healed && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
            <Wand2 className="h-3 w-3" /> {t("runs.selfHealed")}
            {typeof run.attempts === "number" ? ` (${run.attempts} ${t("runs.attempts")})` : ""}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          <span className="font-mono">{fmtDuration(run.durationMs)}</span>
        </span>
        <span>· {new Date(run.startedAt).toLocaleTimeString()}</span>
        {typeof run.tokens === "number" && (
          <span>· {run.tokens.toLocaleString()} {t("runs.tokens")}</span>
        )}
      </div>

      {run.reportPath && (
        <a
          href={`${API}/api/runs/${run.id}/report`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t("runs.openReport")}
        </a>
      )}

      <OracleSection run={run} />
      <PerfSection run={run} />
      <VisualSection run={run} />

      {run.failureReason && (
        <div className="mt-3 flex items-start gap-1.5 rounded-md bg-red-50 p-2.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{run.failureReason}</span>
        </div>
      )}

      <div className="mt-4">
        <h3 className="font-display text-xs font-medium text-foreground">
          {t("runs.stepsLogs")}
        </h3>
        <div className="mt-1.5 space-y-0.5">
          {run.logs.map((line, i) => (
            <div key={i} className="font-mono text-xs text-muted-foreground">
              {line}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <h3 className="flex items-center gap-1.5 font-display text-xs font-medium text-foreground">
          <Image className="h-3.5 w-3.5" /> {t("runs.screenshots")}
        </h3>
        <div className="mt-1.5 grid grid-cols-2 gap-2">
          {(run.screenshots && run.screenshots.length > 0
            ? run.screenshots
            : [null, null, null, null]
          ).map((shot, i) => (
            <div key={i}>
              {shot ? (
                <img
                  src={shot}
                  alt={`step ${i + 1}`}
                  className="aspect-video w-full rounded-md border border-border object-cover"
                />
              ) : (
                <div className="aspect-video rounded-md bg-muted" />
              )}
              <span className="text-xs text-muted-foreground">{t("runs.step")} {i + 1}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
