import { Globe } from "lucide-react";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";

export function TopBar({ actions }: { actions?: React.ReactNode }) {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.activeProjectId);
  const exploreUrl = useStore((s) => s.exploreUrl);

  const active = projects.find((p) => p.id === activeId);
  const host = (u: string) => u.replace(/^https?:\/\//, "");
  const label = active
    ? active.name
    : exploreUrl
      ? host(exploreUrl)
      : t("common.noProjectSelected");

  return (
    <header className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2.5">
      {/* The project switcher now lives in the sidebar. Here it's a plain breadcrumb. */}
      <div className="flex items-center gap-1.5 px-1 text-sm">
        <Globe className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{label}</span>
      </div>
      <div className="ml-auto flex gap-2">{actions}</div>
    </header>
  );
}
