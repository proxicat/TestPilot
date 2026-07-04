// Trend analytics (planning doc §3e): pass rate / flake rate / MTTR / coverage,
// as headline KPIs plus per-batch and per-day series for charting over time.
import { db } from "./db.js";

export interface TrendKPIs {
  passRate: number; // 0..1 over the recent-runs window
  flakeRate: number; // flaky cases / cases-with-runs (target < 0.02)
  mttrMs: number | null; // mean time from first failure to recovery pass
  coverage: number; // cases with >=1 passing run / total cases
  healRate: number; // healed runs / failing-or-healed runs (self-heal effectiveness)
  totalCases: number;
  casesWithRuns: number;
  totalRuns: number;
  runsWindow: number;
}
export interface BatchPoint {
  id: string;
  label: string;
  startedAt: string;
  passed: number;
  failed: number;
  healed: number;
  flaky: number;
  quarantined: number;
  passRate: number; // passed / (passed + failed)
  gate: "pass" | "fail";
}
export interface DayPoint {
  day: string; // YYYY-MM-DD
  passed: number;
  failed: number;
  passRate: number;
}
export interface Trends {
  kpis: TrendKPIs;
  batches: BatchPoint[]; // chronological (oldest → newest) for line charts
  days: DayPoint[];
}

interface RunLite {
  caseId: string;
  status: string;
  healed: number;
  startedAt: string;
}

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// Mean time to recovery: per case, the gap from the first failure of a failing
// streak to the pass that ends it, averaged across all such recoveries.
function computeMttr(runsAscByCase: Map<string, RunLite[]>): number | null {
  const recoveries: number[] = [];
  for (const runs of runsAscByCase.values()) {
    let failStart: number | null = null;
    for (const r of runs) {
      const t = Date.parse(r.startedAt);
      if (r.status === "failed") {
        if (failStart === null) failStart = t;
      } else if (failStart !== null) {
        recoveries.push(t - failStart);
        failStart = null;
      }
    }
  }
  return mean(recoveries);
}

export function computeTrends(projectId: string, runsWindow = 100): Trends {
  // infraError=0: model/network failures are excluded from all trend math (pass rate,
  // MTTR, coverage) — they are not test signal.
  const runs = db
    .prepare(
      `SELECT r.caseId, r.status, r.healed, r.startedAt
       FROM runs r JOIN test_cases c ON c.id = r.caseId
       WHERE c.projectId = ? AND r.infraError = 0 ORDER BY r.startedAt ASC`,
    )
    .all(projectId) as RunLite[];

  const totalCases = (
    db.prepare("SELECT COUNT(*) n FROM test_cases WHERE projectId=?").get(projectId) as { n: number }
  ).n;

  // Pass rate over the most recent window of runs.
  const recent = runs.slice(-runsWindow);
  const recentPass = recent.filter((r) => r.status === "passed").length;
  const passRate = recent.length ? recentPass / recent.length : 0;

  // Heal effectiveness: healed runs / (failed + healed) runs.
  const healed = runs.filter((r) => !!r.healed).length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const healRate = healed + failed ? healed / (healed + failed) : 0;

  // Coverage: cases with at least one passing run.
  const passedCaseIds = new Set(runs.filter((r) => r.status === "passed").map((r) => r.caseId));
  const coverage = totalCases ? passedCaseIds.size / totalCases : 0;

  // Flake rate: flaky-verdict cases / cases that have any run.
  const casesWithRuns = new Set(runs.map((r) => r.caseId)).size;
  const flakyCount = (
    db
      .prepare(
        `SELECT COUNT(*) n FROM flakiness f JOIN test_cases c ON c.id=f.caseId
         WHERE c.projectId=? AND f.verdict='flaky'`,
      )
      .get(projectId) as { n: number }
  ).n;
  const flakeRate = casesWithRuns ? flakyCount / casesWithRuns : 0;

  // MTTR.
  const byCase = new Map<string, RunLite[]>();
  for (const r of runs) {
    const arr = byCase.get(r.caseId) ?? [];
    arr.push(r);
    byCase.set(r.caseId, arr);
  }
  const mttrMs = computeMttr(byCase);

  // Per-batch series (chronological).
  const batches = (
    db
      .prepare(
        "SELECT id,label,startedAt,passed,failed,healed,flaky,quarantined,gate FROM batches WHERE projectId=? ORDER BY startedAt ASC",
      )
      .all(projectId) as Omit<BatchPoint, "passRate">[]
  ).map((b) => ({
    ...b,
    passRate: b.passed + b.failed ? b.passed / (b.passed + b.failed) : 0,
  }));

  // Per-day series.
  const dayRows = db
    .prepare(
      `SELECT substr(r.startedAt,1,10) day,
              SUM(CASE WHEN r.status='passed' THEN 1 ELSE 0 END) passed,
              SUM(CASE WHEN r.status='failed' THEN 1 ELSE 0 END) failed
       FROM runs r JOIN test_cases c ON c.id=r.caseId
       WHERE c.projectId=? AND r.infraError=0 GROUP BY day ORDER BY day ASC`,
    )
    .all(projectId) as { day: string; passed: number; failed: number }[];
  const days: DayPoint[] = dayRows.map((d) => ({
    ...d,
    passRate: d.passed + d.failed ? d.passed / (d.passed + d.failed) : 0,
  }));

  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    kpis: {
      passRate: round(passRate),
      flakeRate: round(flakeRate),
      mttrMs: mttrMs === null ? null : Math.round(mttrMs),
      coverage: round(coverage),
      healRate: round(healRate),
      totalCases,
      casesWithRuns,
      totalRuns: runs.length,
      runsWindow: recent.length,
    },
    batches,
    days,
  };
}
