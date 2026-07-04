import { useEffect } from "react";
import { Outlet, Navigate, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useStore } from "@/lib/store";

// Routes that require an active project (Level 1). Without one, redirect to /projects.
const SCOPED_PATHS = ["/explore", "/cases", "/suite", "/trends", "/runs"];

export function Layout() {
  const loadData = useStore((s) => s.loadData);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const location = useLocation();
  useEffect(() => {
    void loadData();
  }, [loadData]);

  const needsProject = SCOPED_PATHS.includes(location.pathname);
  const guarded = needsProject && !activeProjectId;

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {guarded ? <Navigate to="/projects" replace /> : <Outlet />}
      </div>
    </div>
  );
}
