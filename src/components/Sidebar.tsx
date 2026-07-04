import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  Plane,
  Folder,
  Radar,
  ListChecks,
  Play,
  Cpu,
  Rocket,
  TrendingUp,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  Check,
  ArrowLeft,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { AppControls } from "./AppControls";
import { cn } from "@/lib/cn";

// Project-scoped nav (Level 1 only — visible after entering a project).
const SCOPED_NAV = [
  { to: "/explore", key: "nav.explore", icon: Radar },
  { to: "/cases", key: "nav.cases", icon: ListChecks },
  { to: "/suite", key: "nav.suite", icon: Rocket },
  { to: "/trends", key: "nav.trends", icon: TrendingUp },
  { to: "/runs", key: "nav.runs", icon: Play },
];

const STORAGE_KEY = "tp-sidebar-collapsed";

export function Sidebar() {
  const t = useT();
  const navigate = useNavigate();
  const connection = useStore((s) => s.connection);
  const model = useStore((s) => s.model);
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const selectProject = useStore((s) => s.selectProject);
  const exitProject = useStore((s) => s.exitProject);
  const ok = connection === "ok";
  const bad = connection === "fail" || connection === "notMultimodal";

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const inProject = Boolean(activeProjectId);

  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(STORAGE_KEY) === "1",
  );
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  };

  const navItemClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center rounded-md py-1.5 text-sm transition-colors",
      collapsed ? "justify-center px-0" : "gap-2.5 px-2",
      isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
    );

  return (
    <aside
      className={cn(
        "flex flex-shrink-0 flex-col border-r border-border bg-muted/30 p-2.5 transition-[width] duration-200 ease-out",
        collapsed ? "w-[60px]" : "w-44",
      )}
    >
      {/* Brand + collapse toggle */}
      <div
        className={cn(
          "flex items-center pb-4 pt-1",
          collapsed ? "justify-center" : "gap-2 px-1.5",
        )}
      >
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-emerald-600 text-white">
          <Plane className="h-3.5 w-3.5" />
        </div>
        {!collapsed && (
          <>
            <span className="font-display text-sm font-medium">TestPilot</span>
            <button
              onClick={toggle}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      {collapsed && (
        <button
          onClick={toggle}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className="mb-1 flex h-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      )}

      <nav className="flex flex-col gap-0.5">
        {!inProject ? (
          /* ---- Level 0: portfolio ---- */
          <NavLink
            to="/projects"
            title={collapsed ? t("nav.projects") : undefined}
            className={navItemClass}
          >
            <Folder className="h-4 w-4 flex-shrink-0" />
            {!collapsed && t("nav.projects")}
          </NavLink>
        ) : (
          /* ---- Level 1: in a project ---- */
          <>
            {/* Project switcher */}
            <div className="relative mb-1">
              <button
                onClick={() => setSwitcherOpen((o) => !o)}
                title={collapsed ? activeProject?.name : undefined}
                className={cn(
                  "flex w-full items-center rounded-md border border-border bg-card py-1.5 text-sm transition-colors hover:border-foreground/30",
                  collapsed ? "justify-center px-0" : "gap-2 px-2",
                )}
              >
                {collapsed ? (
                  <span className="flex h-4 w-4 items-center justify-center text-xs font-medium uppercase">
                    {activeProject?.name?.[0] ?? <Folder className="h-4 w-4" />}
                  </span>
                ) : (
                  <>
                    <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-left font-medium">
                      {activeProject?.name ?? t("common.noProjectSelected")}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                  </>
                )}
              </button>
              {switcherOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setSwitcherOpen(false)} />
                  <div className="absolute left-0 top-full z-20 mt-1 max-h-72 w-56 overflow-auto rounded-md border border-border bg-card p-1 shadow-lg">
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          void selectProject(p.id);
                          setSwitcherOpen(false);
                        }}
                        className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted"
                      >
                        <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                        {p.id === activeProjectId && (
                          <Check className="h-4 w-4 flex-shrink-0 text-primary" />
                        )}
                      </button>
                    ))}
                    <div className="my-1 border-t border-border" />
                    <button
                      onClick={() => {
                        setSwitcherOpen(false);
                        exitProject();
                        navigate("/projects");
                      }}
                      className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted"
                    >
                      <ArrowLeft className="h-3.5 w-3.5 flex-shrink-0" />
                      {t("nav.allProjects")}
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Project-scoped nav */}
            {SCOPED_NAV.map(({ to, key, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                title={collapsed ? t(key) : undefined}
                className={navItemClass}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                {!collapsed && t(key)}
              </NavLink>
            ))}
          </>
        )}
      </nav>

      <div
        className={cn(
          "mt-auto flex flex-col gap-2 border-t border-border pt-2.5",
          collapsed && "items-center",
        )}
      >
        {/* Global: Model config (footer, both levels) */}
        <NavLink
          to="/model"
          title={collapsed ? t("nav.model") : undefined}
          className={({ isActive }) =>
            cn(
              "flex items-center rounded-md py-1.5 text-sm transition-colors",
              collapsed ? "justify-center px-0" : "gap-2.5 px-2",
              isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
            )
          }
        >
          <Cpu className="h-4 w-4 flex-shrink-0" />
          {!collapsed && t("nav.model")}
        </NavLink>

        <AppControls collapsed={collapsed} />
        <div
          title={collapsed ? t(`conn.${connection}`) : undefined}
          className={cn(
            "flex items-center gap-1.5 text-xs",
            ok
              ? "text-emerald-600 dark:text-emerald-400"
              : bad
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 flex-shrink-0 rounded-full",
              ok ? "bg-emerald-500" : bad ? "bg-red-500" : "bg-muted-foreground",
            )}
          />
          {!collapsed && t(`conn.${connection}`)}
        </div>
        {!collapsed && (
          <div className="pl-3 font-mono text-[10px] text-muted-foreground">
            {model.baseUrl.replace(/^https?:\/\//, "")}
          </div>
        )}
      </div>
    </aside>
  );
}
