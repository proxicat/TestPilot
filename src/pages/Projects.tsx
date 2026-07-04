import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Globe, ListChecks, Plus, ChevronRight } from "lucide-react";
import { useStore } from "@/lib/store";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";

export function ProjectsPage() {
  const t = useT();
  const navigate = useNavigate();
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.activeProjectId);
  const selectProject = useStore((s) => s.selectProject);
  const createProject = useStore((s) => s.createProject);
  const backendUp = useStore((s) => s.backendUp);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");
  const [busy, setBusy] = useState(false);

  const open = async (id: string) => {
    await selectProject(id);
    navigate("/cases");
  };
  const submit = async () => {
    if (!name.trim() || !/^https?:\/\/.+/.test(url)) return;
    setBusy(true);
    await createProject(name.trim(), url.trim());
    setBusy(false);
    setAdding(false);
    setName("");
    setUrl("https://");
    navigate("/cases");
  };

  return (
    <>
      <TopBar
        actions={
          <Button variant="primary" onClick={() => setAdding((a) => !a)}>
            <Plus className="h-3.5 w-3.5" />
            {t("projects.newProject")}
          </Button>
        }
      />
      <div className="flex-1 overflow-auto p-4">
        <h1 className="mb-1 font-display text-lg font-medium">{t("projects.title")}</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("projects.subtitle")}
          {!backendUp && ` ${t("projects.backendOfflineLocal")}`}
        </p>

        {adding && (
          <div className="mb-4 rounded-xl border border-border bg-card p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label htmlFor="pname" className="mb-1 block text-xs text-muted-foreground">
                  {t("projects.name")}
                </label>
                <input
                  id="pname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My web app"
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label htmlFor="purl" className="mb-1 block text-xs text-muted-foreground">
                  {t("projects.targetUrl")}
                </label>
                <input
                  id="purl"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="primary" onClick={submit} disabled={busy}>
                {t("projects.createProject")}
              </Button>
              <Button variant="outline" onClick={() => setAdding(false)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}

        {projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {t("projects.empty")}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => void open(p.id)}
                className="group cursor-pointer rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/30"
              >
                <div className="mb-3 flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted">
                    <Globe className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {p.targetUrl.replace(/^https?:\/\//, "")}
                    </div>
                  </div>
                  <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                    {t("nav.enter")}
                    <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ListChecks className="h-3.5 w-3.5" />
                  {t("projects.openTestCases")}
                  {p.id === activeId && (
                    <span className="ml-auto rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      {t("projects.active")}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
