import { useState } from "react";
import { Play } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button, PriorityBadge, RunStatusPill } from "@/components/ui";
import { Drawer } from "@/components/overlay";
import { RunDetail, fmtDuration } from "@/components/RunDetail";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/cn";
import type { RunRecord } from "@/lib/types";

type Filter = "all" | "passed" | "failed";

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted p-4">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="font-display text-2xl font-medium text-foreground">
        {value}
      </div>
    </div>
  );
}

export function RunReportPage() {
  const t = useT();
  const runs = useStore((s) => s.runs);
  const runAllP0 = useStore((s) => s.runAllP0);

  const [filter, setFilter] = useState<Filter>("all");
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
    runs[0]?.id,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Summary metrics (all rounded).
  const total = runs.length;
  const passed = runs.filter((r) => r.status === "passed").length;
  const passRate = total > 0 ? `${Math.round((passed / total) * 100)}%` : "—";

  const p0Runs = runs.filter((r) => r.priority === "P0");
  const p0Passed = p0Runs.filter((r) => r.status === "passed").length;
  const p0PassRate =
    p0Runs.length > 0
      ? `${Math.round((p0Passed / p0Runs.length) * 100)}%`
      : "—";

  const avgDuration =
    total > 0
      ? fmtDuration(
          runs.reduce((sum, r) => sum + r.durationMs, 0) / total,
        )
      : "—";

  const filtered = runs.filter((r) =>
    filter === "all" ? true : r.status === filter,
  );

  const selected: RunRecord | undefined =
    filtered.find((r) => r.id === selectedRunId) ??
    runs.find((r) => r.id === selectedRunId);

  const filters: Array<{ key: Filter; label: string }> = [
    { key: "all", label: t("common.all") },
    { key: "passed", label: t("status.passed") },
    { key: "failed", label: t("status.failed") },
  ];

  return (
    <>
      <TopBar
        actions={
          <Button variant="success" onClick={runAllP0}>
            <Play className="h-3.5 w-3.5" /> {t("topbar.runAllP0")}
          </Button>
        }
      />
      <div className="flex-1 overflow-auto p-4">
        {runs.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <h2 className="font-display text-sm font-medium text-foreground">
              {t("runs.noRunsYet")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("runs.noRunsHelp")}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary metrics */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <MetricCard label={t("runs.totalRuns")} value={String(total)} />
              <MetricCard label={t("runs.passRate")} value={passRate} />
              <MetricCard label={t("runs.p0PassRate")} value={p0PassRate} />
              <MetricCard label={t("runs.avgDuration")} value={avgDuration} />
            </div>

            {/* Filter row */}
            <div className="flex gap-2">
              {filters.map((f) => (
                <Button
                  key={f.key}
                  variant={filter === f.key ? "primary" : "outline"}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </Button>
              ))}
            </div>

            {/* Run list — full width; clicking a run opens the detail Drawer. */}
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {filtered.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  {t("runs.noRunsMatch")}
                </p>
              ) : (
                filtered.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => {
                      setSelectedRunId(r.id);
                      setDrawerOpen(true);
                    }}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/60",
                      r.id === selected?.id && drawerOpen && "bg-muted",
                    )}
                  >
                    <RunStatusPill status={r.status} />
                    <PriorityBadge priority={r.priority} />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {r.caseTitle}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {fmtDuration(r.durationMs)}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {new Date(r.startedAt).toLocaleTimeString()}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <Drawer
        open={drawerOpen && !!selected}
        onClose={() => setDrawerOpen(false)}
        title={selected?.caseTitle}
      >
        {selected && <RunDetail run={selected} />}
      </Drawer>
    </>
  );
}
