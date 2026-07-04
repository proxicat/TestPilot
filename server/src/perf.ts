// Web-performance capture + baseline comparison. Reads navigation/paint timing
// from an already-loaded Puppeteer page, then compares against a per-case
// baseline and per-metric budgets to flag performance regressions.
import type { Page } from "puppeteer";

export type PerfMetrics = Record<string, number>; // keys: ttfbMs, fcpMs, domContentLoadedMs, loadMs

export interface PerfVerdict {
  metric: string;
  current: number;
  baseline?: number;
  budgetMs?: number;
  deltaPct?: number; // % change vs baseline (positive = slower)
  status: "ok" | "regression" | "new_baseline";
}

export interface PerfResult {
  status: "new_baseline" | "ok" | "regression";
  metrics: PerfMetrics;
  baseline?: PerfMetrics;
  verdicts: PerfVerdict[];
}

// Per-metric budget fallbacks (ms) used when the caller supplies none.
const DEFAULT_BUDGETS: Record<string, number> = {
  ttfbMs: 800,
  fcpMs: 1800,
  domContentLoadedMs: 3000,
  loadMs: 5000,
};

// Read performance timing from an already-loaded page (no pre-injection needed).
// NOTE: the browser-side function is passed to page.evaluate() as a STRING, not
// a closure. tsx/esbuild runs with keepNames, which rewrites nested named
// functions into `__name(fn, "name")` calls — `__name` is undefined in the page
// context, so a transpiled closure throws and we silently lose all metrics.
// A raw string is never transpiled, so it is immune to that injection.
const PERF_EVAL = `(function () {
  function round(v) { return (v === undefined || Number.isNaN(v)) ? 0 : Math.round(v); }
  var nav = performance.getEntriesByType("navigation")[0];
  var paintEntries = performance.getEntriesByType("paint");
  var paint = null;
  for (var i = 0; i < paintEntries.length; i++) {
    if (paintEntries[i].name === "first-contentful-paint") { paint = paintEntries[i]; break; }
  }
  var ttfbMs = nav ? nav.responseStart : 0;
  var fcpMs = paint ? paint.startTime : 0;
  var domContentLoadedMs = nav ? nav.domContentLoadedEventEnd : 0;
  var loadMs = (nav && nav.loadEventEnd > 0) ? nav.loadEventEnd : performance.now();
  return {
    ttfbMs: round(ttfbMs),
    fcpMs: round(fcpMs),
    domContentLoadedMs: round(domContentLoadedMs),
    loadMs: round(loadMs),
  };
})()`;

export async function capturePerf(page: Page): Promise<PerfMetrics> {
  try {
    return (await page.evaluate(PERF_EVAL)) as PerfMetrics;
  } catch {
    return {};
  }
}

// Compare current metrics vs an optional baseline using per-metric budgets.
export function comparePerf(
  current: PerfMetrics,
  baseline: PerfMetrics | undefined,
  budgets: Record<string, number>,
): PerfResult {
  const mergedBudgets: Record<string, number> = { ...DEFAULT_BUDGETS, ...budgets };
  const verdicts: PerfVerdict[] = [];

  for (const metric of Object.keys(current)) {
    const value = current[metric];
    const budgetMs = mergedBudgets[metric];
    const base = baseline ? baseline[metric] : undefined;

    if (baseline === undefined || base === undefined) {
      verdicts.push({
        metric,
        current: value,
        budgetMs,
        status: "new_baseline",
      });
      continue;
    }

    const deltaPct = Math.round(((value - base) / Math.max(base, 1)) * 100);
    const overBudget = budgetMs !== undefined && value > budgetMs;
    const regressed = value > base * 1.25 || overBudget;

    verdicts.push({
      metric,
      current: value,
      baseline: base,
      budgetMs,
      deltaPct,
      status: regressed ? "regression" : "ok",
    });
  }

  let status: PerfResult["status"];
  if (baseline === undefined) {
    status = "new_baseline";
  } else if (verdicts.some((v) => v.status === "regression")) {
    status = "regression";
  } else {
    status = "ok";
  }

  return { status, metrics: current, baseline, verdicts };
}
