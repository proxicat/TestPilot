import { CircleCheck, CircleX, Loader2, Minus, Code2, CodeXml } from "lucide-react";
import type { CaseType, FlakeVerdict, Priority, RunStatus } from "@/lib/types";
import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";

const STABILITY_BADGE: Record<FlakeVerdict, string> = {
  stable: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  flaky: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  broken: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  unknown: "bg-muted text-muted-foreground",
};

export function StabilityChip({
  verdict,
  failRate,
  className,
}: {
  verdict: FlakeVerdict;
  failRate: number;
  className?: string;
}) {
  const passPct = Math.round((1 - failRate) * 100);
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 text-xs font-medium",
        STABILITY_BADGE[verdict],
        className,
      )}
    >
      {verdict} · {passPct}%
    </span>
  );
}

export const PRIORITY_BADGE: Record<Priority, string> = {
  P0: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  P1: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  P2: "bg-muted text-muted-foreground",
};

export const TYPE_BADGE: Record<CaseType, string> = {
  functional: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  negative: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  boundary: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  e2e: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
};

export function TypeBadge({
  type,
  className,
}: {
  type: CaseType;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 text-xs font-medium",
        TYPE_BADGE[type],
        className,
      )}
    >
      {type}
    </span>
  );
}

export function PriorityBadge({
  priority,
  className,
}: {
  priority: Priority;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 text-xs font-medium",
        PRIORITY_BADGE[priority],
        className,
      )}
    >
      {priority}
    </span>
  );
}

export function RunStatusPill({ status }: { status: RunStatus }) {
  const t = useT();
  if (status === "running")
    return (
      <span className="flex items-center gap-1 text-xs text-primary">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("status.running")}
      </span>
    );
  if (status === "passed")
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
        <CircleCheck className="h-3.5 w-3.5" /> {t("status.passed")}
      </span>
    );
  if (status === "failed")
    return (
      <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
        <CircleX className="h-3.5 w-3.5" /> {t("status.failed")}
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Minus className="h-3.5 w-3.5" /> {t("status.notRun")}
    </span>
  );
}

export function CodeIndicator({ hasCode }: { hasCode: boolean }) {
  const t = useT();
  return hasCode ? (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Code2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> {t("status.code")}
    </span>
  ) : (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <CodeXml className="h-3.5 w-3.5 opacity-50" /> {t("status.noCode")}
    </span>
  );
}

export function Button({
  children,
  variant = "outline",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "outline" | "primary" | "success";
}) {
  const base =
    "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const variants = {
    outline: "border border-border hover:bg-muted",
    primary: "bg-primary text-primary-foreground hover:opacity-90",
    success: "bg-emerald-600 text-white hover:bg-emerald-700",
  };
  return (
    <button className={cn(base, variants[variant], className)} {...props}>
      {children}
    </button>
  );
}
