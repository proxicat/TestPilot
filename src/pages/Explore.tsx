import { Radar, Globe, Loader2, Sparkles, StopCircle, ArrowRight, Blocks } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { TopBar } from "@/components/TopBar";
import { Button, PriorityBadge } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/cn";

export function ExplorePage() {
  const t = useT();
  const navigate = useNavigate();
  const exploreUrl = useStore((s) => s.exploreUrl);
  const setExploreUrl = useStore((s) => s.setExploreUrl);
  const exploreDeep = useStore((s) => s.exploreDeep);
  const setExploreDeep = useStore((s) => s.setExploreDeep);
  const exploreWeb3 = useStore((s) => s.exploreWeb3);
  const setExploreWeb3 = useStore((s) => s.setExploreWeb3);
  const exploring = useStore((s) => s.exploring);
  const startExplore = useStore((s) => s.startExplore);
  const stopExplore = useStore((s) => s.stopExplore);
  const exploreLogs = useStore((s) => s.exploreLogs);
  const exploreScreenshot = useStore((s) => s.exploreScreenshot);
  const exploreLastCount = useStore((s) => s.exploreLastCount);
  const cases = useStore((s) => s.cases);

  const latest = exploreLogs.length
    ? exploreLogs[exploreLogs.length - 1]
    : undefined;

  return (
    <>
      <TopBar
        actions={
          <Button
            variant="success"
            onClick={startExplore}
            disabled={exploring}
          >
            <Radar className="h-3.5 w-3.5" /> {t("topbar.startExplore")}
          </Button>
        }
      />
      <div className="flex-1 overflow-auto p-4">
        <div className="space-y-4">
          {/* URL bar */}
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-1 items-center gap-2 rounded-md border border-border bg-muted px-2.5 py-1.5">
                <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  value={exploreUrl}
                  onChange={(e) => setExploreUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>
              <label
                className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
                title={t("explore.deepCrawlTitle")}
              >
                <input
                  type="checkbox"
                  checked={exploreDeep}
                  onChange={(e) => setExploreDeep(e.target.checked)}
                  className="cursor-pointer"
                />
                {t("explore.deepCrawl")}
              </label>
              <label
                className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
                title={t("explore.web3Title")}
              >
                <input
                  type="checkbox"
                  checked={exploreWeb3}
                  onChange={(e) => setExploreWeb3(e.target.checked)}
                  className="cursor-pointer"
                />
                <Blocks className="h-3.5 w-3.5 text-violet-500" />
                {t("explore.web3")}
              </label>
              <Button
                variant="success"
                onClick={startExplore}
                disabled={exploring}
              >
                <Radar className="h-3.5 w-3.5" /> Start explore
              </Button>
              {exploring && (
                <Button variant="outline" onClick={stopExplore}>
                  <StopCircle className="h-3.5 w-3.5" /> {t("common.stop")}
                </Button>
              )}
              {exploring && (
                <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("explore.exploring")}
                </span>
              )}
            </div>
          </div>

          {!exploring && exploreLastCount > 0 && (
            <button
              onClick={() => navigate("/cases")}
              className="flex w-full cursor-pointer items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-left text-sm text-emerald-700 transition-colors hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
            >
              <Sparkles className="h-4 w-4" />
              <span className="flex-1">
                {t("explore.discoveredPrefix")}{" "}
                <span className="font-medium">{exploreLastCount}</span>{" "}
                {t("explore.discoveredSuffix")}
              </span>
              <span className="flex items-center gap-1 font-medium">
                {t("explore.viewInCases")} <ArrowRight className="h-3.5 w-3.5" />
              </span>
            </button>
          )}

          {/* Viewport + log columns */}
          <div className="flex flex-col gap-4 lg:flex-row">
            {/* Left: faux browser viewport */}
            <div className="flex-1">
              <div className="rounded-xl border border-border bg-card p-3">
                <div className="mb-3 flex items-center gap-2">
                  <div className="flex gap-1.5">
                    <span className="h-3 w-3 rounded-full bg-muted-foreground/40" />
                    <span className="h-3 w-3 rounded-full bg-muted-foreground/40" />
                    <span className="h-3 w-3 rounded-full bg-muted-foreground/40" />
                  </div>
                  <div className="flex flex-1 items-center gap-1.5 truncate rounded-md border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                    <Globe className="h-3 w-3 shrink-0" />
                    <span className="truncate">{exploreUrl}</span>
                  </div>
                </div>
                <div className="relative flex min-h-[260px] items-center justify-center overflow-hidden rounded-md bg-muted">
                  {exploreScreenshot ? (
                    <img
                      src={exploreScreenshot}
                      alt="explored page"
                      className="h-[260px] w-full object-cover object-top"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      {exploring ? (
                        <Loader2 className="h-6 w-6 animate-spin" />
                      ) : (
                        <Sparkles className="h-6 w-6" />
                      )}
                      <span className="text-sm">
                        {exploring ? t("explore.agentExploring") : t("explore.liveView")}
                      </span>
                    </div>
                  )}
                  {latest && (
                    <div
                      className={cn(
                        "absolute bottom-3 left-3 right-3 truncate rounded-md border border-border bg-card px-2.5 py-1.5 text-xs",
                        latest.kind === "found"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : latest.kind === "warn"
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground",
                      )}
                    >
                      {latest.message}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Right: live exploration log */}
            <div className="flex w-full flex-col gap-4 lg:w-[300px] lg:shrink-0">
              <div className="rounded-xl border border-border bg-card p-3">
                <h2 className="mb-2 font-display text-sm text-foreground">
                  {t("explore.explorationLog")}
                </h2>
                <div className="max-h-[300px] space-y-1 overflow-auto">
                  {exploreLogs.length === 0 && !exploring && (
                    <p className="text-xs text-muted-foreground">
                      {t("explore.pointAndStart")}
                    </p>
                  )}
                  {exploreLogs.map((log) => (
                    <div key={log.id} className="flex gap-2 text-xs">
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {log.ts}
                      </span>
                      <span
                        className={cn(
                          log.kind === "found"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : log.kind === "warn"
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground",
                        )}
                      >
                        {log.message}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Discovered flows — full-width horizontal grid of cards */}
          {cases.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="mb-2.5 flex items-center gap-2">
                <h2 className="font-display text-sm text-foreground">
                  {t("explore.discoveredFlows")}
                </h2>
                <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                  {cases.length}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {cases.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => navigate("/cases")}
                    className="flex flex-col gap-1.5 rounded-lg border border-border bg-background p-2.5 text-left transition-colors hover:border-foreground/30 hover:bg-muted"
                  >
                    <div className="flex items-center gap-1.5">
                      <PriorityBadge priority={c.priority} />
                      <span className="truncate text-sm font-medium text-foreground">
                        {c.title}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">
                      {c.priorityReason}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
