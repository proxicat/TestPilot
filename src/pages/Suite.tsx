import { useEffect, useRef, useState } from "react";
import {
  Rocket,
  Loader2,
  Wand2,
  ShieldCheck,
  ShieldX,
  Zap,
  Ban,
  Clock,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui";
import { Drawer } from "@/components/overlay";
import { RunDetail } from "@/components/RunDetail";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Batch, BatchRun, RunRecord } from "@/lib/types";

type Filter = "P0" | "P1" | "P2" | "all";

interface QueueStatus {
  concurrency: number;
  active: number;
  waiting: number;
  totalQueued: number;
  totalDone: number;
  activeLabels: string[];
}

function GateBadge({ gate, big }: { gate: "pass" | "fail"; big?: boolean }) {
  const t = useT();
  const pass = gate === "pass";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md font-display font-medium",
        big ? "px-3 py-1.5 text-base" : "px-2 py-0.5 text-xs",
        pass
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
          : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
      )}
    >
      {pass ? (
        <ShieldCheck className={big ? "h-4 w-4" : "h-3.5 w-3.5"} />
      ) : (
        <ShieldX className={big ? "h-4 w-4" : "h-3.5 w-3.5"} />
      )}
      {pass ? t("suite.gatePass") : t("suite.gateFail")}
    </span>
  );
}

function StatusPill({ status }: { status: BatchRun["status"] }) {
  const t = useT();
  if (status === "passed")
    return (
      <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        {t("suite.statPassed")}
      </span>
    );
  if (status === "failed")
    return (
      <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">
        {t("suite.statFailed")}
      </span>
    );
  return (
    <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
      {t("suite.statQuarantined")}
    </span>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: string;
}) {
  return (
    <div className="rounded-xl bg-muted p-3">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {Icon && <Icon className={cn("h-3 w-3", tone)} />}
        {label}
      </div>
      <div className={cn("font-display text-xl font-medium", tone)}>{value}</div>
    </div>
  );
}

// Per-case results for a batch. Rows that produced a run (have a runId) are
// clickable — click/Enter/Space opens that run's full detail in a Drawer.
// Rows without a runId (e.g. an "error" that never produced a run) render plain.
function BatchItems({
  items,
  onOpenRun,
}: {
  items: BatchRun[];
  onOpenRun: (item: BatchRun) => void;
}) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <tbody>
          {items.map((it) => {
            const clickable = !!it.runId;
            return (
              <tr
                key={it.caseId}
                onClick={clickable ? () => onOpenRun(it) : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onOpenRun(it);
                        }
                      }
                    : undefined
                }
                tabIndex={clickable ? 0 : undefined}
                role={clickable ? "button" : undefined}
                className={cn(
                  "border-b border-border last:border-b-0",
                  clickable
                    ? "cursor-pointer hover:bg-muted/60 focus:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    : "",
                )}
              >
                <td className="px-3 py-2">
                  <span className="font-medium">{it.caseTitle}</span>
                  {!clickable && (
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      {t("suite.noRunDetail")}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={it.status} />
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                  {it.attempts > 1 ? `×${it.attempts}` : ""}
                </td>
                <td className="px-3 py-2 text-right">
                  {it.healed && (
                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                      <Wand2 className="h-3 w-3" /> {t("suite.healed")}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ResultSummary({
  batch,
  items,
  onOpenRun,
}: {
  batch: Batch;
  items: BatchRun[];
  onOpenRun: (item: BatchRun) => void;
}) {
  const t = useT();
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-3">
        <GateBadge gate={batch.gate} big />
        <span className="min-w-0 flex-1 truncate font-display text-sm font-medium">
          {batch.label}
        </span>
        {batch.status === "running" && (
          <span className="flex items-center gap-1 text-xs text-primary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("suite.running")}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <Stat label={t("suite.statTotal")} value={batch.total} />
        <Stat
          label={t("suite.statPassed")}
          value={batch.passed}
          tone="text-emerald-600 dark:text-emerald-400"
        />
        <Stat
          label={t("suite.statFailed")}
          value={batch.failed}
          tone="text-red-600 dark:text-red-400"
        />
        <Stat
          label={t("suite.statHealed")}
          value={batch.healed}
          icon={Wand2}
          tone="text-violet-600 dark:text-violet-400"
        />
        <Stat
          label={t("suite.statFlaky")}
          value={batch.flaky}
          icon={Zap}
          tone="text-amber-600 dark:text-amber-400"
        />
        <Stat
          label={t("suite.statQuarantined")}
          value={batch.quarantined}
          icon={Ban}
          tone="text-muted-foreground"
        />
      </div>

      {items.length > 0 && (
        <div className="mt-4">
          <BatchItems items={items} onOpenRun={onOpenRun} />
        </div>
      )}
    </div>
  );
}

export function SuitePage() {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);
  const backendUp = useStore((s) => s.backendUp);

  const [filter, setFilter] = useState<Filter>("P0");
  const [retries, setRetries] = useState(1);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [result, setResult] = useState<{
    batch: Batch;
    items: BatchRun[];
  } | null>(null);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);

  // Run-detail drawer (shared by result + recent-suite drill-down).
  const [runDrawer, setRunDrawer] = useState<{
    title: string;
    loading: boolean;
    run?: RunRecord;
    error?: boolean;
  } | null>(null);

  // Recent suites: which batch is expanded, and its lazily-fetched items.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [batchItems, setBatchItems] = useState<Record<string, BatchRun[]>>({});

  const pollRef = useRef<number | null>(null);

  const openRun = async (item: BatchRun) => {
    if (!item.runId) return;
    setRunDrawer({ title: item.caseTitle, loading: true });
    try {
      const { run } = await api.getRun(item.runId);
      setRunDrawer({ title: item.caseTitle, loading: false, run });
    } catch {
      setRunDrawer({ title: item.caseTitle, loading: false, error: true });
    }
  };

  const toggleBatch = async (batchId: string) => {
    if (expanded === batchId) {
      setExpanded(null);
      return;
    }
    setExpanded(batchId);
    if (!batchItems[batchId]) {
      try {
        const { items } = await api.getBatch(batchId);
        setBatchItems((m) => ({ ...m, [batchId]: items }));
      } catch {
        setBatchItems((m) => ({ ...m, [batchId]: [] }));
      }
    }
  };

  const loadBatches = async () => {
    if (!activeProjectId) return;
    try {
      const { batches } = await api.getBatches(activeProjectId);
      setBatches(batches);
    } catch {
      /* backend offline */
    }
  };

  useEffect(() => {
    setResult(null);
    void loadBatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  // Poll the queue while a suite is running to show live progress.
  useEffect(() => {
    if (!running) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setQueue(null);
      return;
    }
    const tick = async () => {
      try {
        setQueue(await api.getQueue());
      } catch {
        /* ignore transient errors while running */
      }
    };
    void tick();
    pollRef.current = window.setInterval(() => void tick(), 1500);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [running]);

  const runSuite = async () => {
    if (!activeProjectId || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.runSuite(activeProjectId, filter, retries);
      setResult({ batch: res.batch, items: res.items });
      await loadBatches();
    } catch (e) {
      setError(
        `Suite run failed: ${(e as Error).message}. Check the backend is running at localhost:5301.`,
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <TopBar
        actions={
          <Button
            variant="success"
            onClick={runSuite}
            disabled={running || !activeProjectId}
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Rocket className="h-3.5 w-3.5" />
            )}
            {running ? t("suite.runningSuite") : t("topbar.runSuite")}
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-4">
        {!activeProjectId ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <h2 className="font-display text-sm font-medium">{t("common.noProjectSelected")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("suite.pickProject")}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Control row */}
            <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-3">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t("suite.filter")}
                <select
                  aria-label="Suite filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as Filter)}
                  disabled={running}
                  className="cursor-pointer rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                >
                  <option value="P0">{t("suite.p0Only")}</option>
                  <option value="P1">{t("suite.p1Only")}</option>
                  <option value="P2">{t("suite.p2Only")}</option>
                  <option value="all">{t("suite.allPriorities")}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t("suite.retries")}
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={retries}
                  disabled={running}
                  onChange={(e) =>
                    setRetries(Math.max(0, Number(e.target.value) || 0))
                  }
                  className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                />
              </label>
              <Button
                variant="success"
                onClick={runSuite}
                disabled={running || !activeProjectId}
                className="mb-0.5"
              >
                {running ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Rocket className="h-3.5 w-3.5" />
                )}
                {running ? t("suite.runningSuite") : t("topbar.runSuite")}
              </Button>

              {/* Live queue status while running */}
              {running && (
                <div className="ml-auto flex items-center gap-3 rounded-lg bg-muted px-3 py-2 text-xs">
                  <span className="flex items-center gap-1 text-primary">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {queue ? `${queue.active} ${t("suite.nRunning")}` : t("suite.starting")}
                  </span>
                  {queue && (
                    <>
                      <span className="text-muted-foreground">
                        {queue.waiting} {t("suite.nQueued")}
                      </span>
                      <span className="text-muted-foreground">
                        {t("suite.concurrency")} {queue.concurrency}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>

            {!backendUp && (
              <div className="rounded-lg bg-amber-100 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                {t("suite.backendOffline")}
              </div>
            )}
            {error && (
              <div className="rounded-lg bg-red-100 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                {error}
              </div>
            )}

            {/* Result summary */}
            {result && (
              <ResultSummary
                batch={result.batch}
                items={result.items}
                onOpenRun={openRun}
              />
            )}

            {/* Recent suites */}
            <div>
              <h2 className="mb-2 flex items-center gap-1.5 font-display text-sm font-medium">
                <Clock className="h-3.5 w-3.5" /> {t("suite.recentSuites")}
              </h2>
              {batches.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  {t("suite.noSuiteRuns")}
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  {batches.map((b) => {
                    const isOpen = expanded === b.id;
                    const items = batchItems[b.id];
                    return (
                      <div key={b.id} className="border-b border-border last:border-b-0">
                        <button
                          type="button"
                          onClick={() => void toggleBatch(b.id)}
                          aria-expanded={isOpen}
                          className={cn(
                            "flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left text-sm hover:bg-muted/60",
                            "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          )}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <GateBadge gate={b.gate} />
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {b.label}
                          </span>
                          <span className="text-xs text-emerald-600 dark:text-emerald-400">
                            {b.passed} {t("suite.nPassed")}
                          </span>
                          <span className="text-xs text-red-600 dark:text-red-400">
                            {b.failed} {t("suite.nFailed")}
                          </span>
                          {b.healed > 0 && (
                            <span className="flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400">
                              <Wand2 className="h-3 w-3" />
                              {b.healed} {t("suite.nHealed")}
                            </span>
                          )}
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {new Date(b.startedAt).toLocaleString()}
                          </span>
                        </button>
                        {isOpen && (
                          <div className="px-3 pb-3">
                            {items === undefined ? (
                              <p className="py-2 text-xs text-muted-foreground">
                                {t("common.loading")}
                              </p>
                            ) : items.length === 0 ? (
                              <p className="py-2 text-xs text-muted-foreground">
                                {t("suite.noRunDetail")}
                              </p>
                            ) : (
                              <BatchItems items={items} onOpenRun={openRun} />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <Drawer
        open={!!runDrawer}
        onClose={() => setRunDrawer(null)}
        title={runDrawer?.title}
      >
        {runDrawer?.loading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
          </div>
        ) : runDrawer?.error ? (
          <p className="p-4 text-sm text-muted-foreground">
            {t("suite.runDetailUnavailable")}
          </p>
        ) : runDrawer?.run ? (
          <RunDetail run={runDrawer.run} />
        ) : null}
      </Drawer>
    </>
  );
}
