import { useEffect, useState } from "react";
import { TrendingUp, Wand2, Zap, Ban } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Trends, TrendsBatch } from "@/lib/types";

const pct = (n: number) => `${Math.round(n * 100)}%`;

function fmtMttr(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// KPI metric card — mirrors the RunReport MetricCard, with an optional tone + hint.
function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl bg-muted p-4">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className={cn("font-display text-2xl font-medium text-foreground", tone)}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

// Headline pass-rate trend: one bar per batch, 0–100%, colored by CI gate.
function PassRateChart({ batches }: { batches: TrendsBatch[] }) {
  const W = 720;
  const H = 220;
  const padL = 34;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const y = (v: number) => padT + plotH * (1 - v); // v in 0..1

  const n = batches.length;
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.min(38, Math.max(6, slot * 0.6));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      className="overflow-visible"
      role="img"
      aria-label="Pass rate per suite run over time"
    >
      {/* y-guides at 0 / 50 / 100% */}
      {[0, 0.5, 1].map((g) => (
        <g key={g}>
          <line
            x1={padL}
            x2={W - padR}
            y1={y(g)}
            y2={y(g)}
            className="stroke-border"
            strokeWidth={1}
            strokeDasharray={g === 0 ? "0" : "3 3"}
          />
          <text
            x={padL - 6}
            y={y(g) + 3}
            textAnchor="end"
            className="fill-muted-foreground"
            style={{ fontSize: 10 }}
          >
            {Math.round(g * 100)}%
          </text>
        </g>
      ))}

      {batches.map((b, i) => {
        const cx = padL + slot * i + slot / 2;
        const bh = plotH * b.passRate;
        const pass = b.gate === "pass";
        return (
          <g key={b.id}>
            <rect
              x={cx - barW / 2}
              y={y(b.passRate)}
              width={barW}
              height={Math.max(1, bh)}
              rx={3}
              className={cn(
                pass
                  ? "fill-emerald-500 dark:fill-emerald-500"
                  : "fill-red-500 dark:fill-red-500",
              )}
            >
              <title>
                {`${b.label}\n${fmtDate(b.startedAt)}\npass rate ${pct(
                  b.passRate,
                )} · ${b.passed} passed / ${b.failed} failed · gate ${b.gate}`}
              </title>
            </rect>
            <circle cx={cx} cy={y(b.passRate)} r={2.5} className="fill-background" />
          </g>
        );
      })}

      {/* x-axis baseline */}
      <line
        x1={padL}
        x2={W - padR}
        y1={y(0)}
        y2={y(0)}
        className="stroke-border"
        strokeWidth={1}
      />
    </svg>
  );
}

// Tiny per-batch stacked bars: passed / failed / healed / quarantined.
function StackedBars({ batches }: { batches: TrendsBatch[] }) {
  const t = useT();
  const segs: Array<{
    key: keyof TrendsBatch;
    label: string;
    tkey: string;
    cls: string;
  }> = [
    { key: "passed", label: "passed", tkey: "trends.legendPassed", cls: "bg-emerald-500" },
    { key: "failed", label: "failed", tkey: "trends.legendFailed", cls: "bg-red-500" },
    { key: "healed", label: "healed", tkey: "trends.legendHealed", cls: "bg-violet-500" },
    { key: "quarantined", label: "quarantined", tkey: "trends.legendQuarantined", cls: "bg-slate-400" },
  ];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {segs.map((s) => (
          <span key={s.label} className="flex items-center gap-1">
            <span className={cn("h-2 w-2 rounded-sm", s.cls)} />
            {t(s.tkey)}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <Wand2 className="h-3 w-3 text-violet-500" /> {t("trends.legendHeal")}
        </span>
        <span className="flex items-center gap-1">
          <Zap className="h-3 w-3 text-amber-500" /> {t("trends.legendFlaky")}
        </span>
        <span className="flex items-center gap-1">
          <Ban className="h-3 w-3 text-slate-400" /> {t("trends.legendQuarantine")}
        </span>
      </div>
      <div className="space-y-1.5">
        {batches.map((b) => {
          const total =
            b.passed + b.failed + b.healed + b.quarantined || 1;
          return (
            <div key={b.id} className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate text-[11px] text-muted-foreground">
                {b.label}
              </span>
              <div className="flex h-3 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted">
                {segs.map((s) => {
                  const v = b[s.key] as number;
                  if (!v) return null;
                  return (
                    <div
                      key={s.label}
                      className={s.cls}
                      style={{ width: `${(v / total) * 100}%` }}
                      title={`${t(s.tkey)}: ${v}`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TrendsPage() {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);

  const [trends, setTrends] = useState<Trends | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProjectId) {
      setTrends(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getTrends(activeProjectId)
      .then((t) => {
        if (!cancelled) setTrends(t);
      })
      .catch((e) => {
        if (!cancelled) {
          setTrends(null);
          setError(
            `Couldn't load trends: ${(e as Error).message}. Check the backend at localhost:5301.`,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  const flakeOver = trends ? trends.kpis.flakeRate > 0.02 : false;

  return (
    <>
      <TopBar />
      <div className="flex-1 overflow-auto p-4">
        {!activeProjectId ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <h2 className="font-display text-sm font-medium">{t("common.noProjectSelected")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("trends.seeTrends")}
            </p>
          </div>
        ) : loading && !trends ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            {t("trends.loading")}
          </div>
        ) : error ? (
          <div className="rounded-lg bg-red-100 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        ) : !trends || trends.batches.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {t("trends.empty")}
          </div>
        ) : (
          <div className="space-y-4">
            {/* KPI cards */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
              <KpiCard label={t("trends.passRate")} value={pct(trends.kpis.passRate)} />
              <KpiCard
                label={t("trends.flakeRate")}
                value={pct(trends.kpis.flakeRate)}
                hint={t("trends.flakeTarget")}
                tone={
                  flakeOver
                    ? trends.kpis.flakeRate > 0.05
                      ? "text-red-600 dark:text-red-400"
                      : "text-amber-600 dark:text-amber-400"
                    : undefined
                }
              />
              <KpiCard label={t("trends.mttr")} value={fmtMttr(trends.kpis.mttrMs)} />
              <KpiCard label={t("trends.coverage")} value={pct(trends.kpis.coverage)} />
              <KpiCard label={t("trends.selfHealRate")} value={pct(trends.kpis.healRate)} />
            </div>

            {/* Pass-rate trend (headline) */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="mb-3 flex items-center gap-1.5 font-display text-sm font-medium">
                <TrendingUp className="h-3.5 w-3.5" /> {t("trends.passRateOverTime")}
                <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                  {trends.batches.length}{" "}
                  {trends.batches.length > 1 ? t("trends.suiteRuns") : t("trends.suiteRun")} ·{" "}
                  {t("trends.gateHint")}
                </span>
              </h2>
              <PassRateChart batches={trends.batches} />
            </div>

            {/* Stacked breakdown */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="mb-3 font-display text-sm font-medium">
                {t("trends.outcomeBreakdown")}
              </h2>
              <StackedBars batches={trends.batches} />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
