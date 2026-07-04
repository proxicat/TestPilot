import { Sun, Moon } from "lucide-react";
import { usePrefs } from "@/lib/prefs";
import { LANGS } from "@/lib/i18n";
import { cn } from "@/lib/cn";

// Language (中 / EN / 日) + light/dark toggle. `collapsed` renders an icon-only
// variant for the collapsed sidebar rail.
export function AppControls({ collapsed = false }: { collapsed?: boolean }) {
  const lang = usePrefs((s) => s.lang);
  const setLang = usePrefs((s) => s.setLang);
  const theme = usePrefs((s) => s.theme);
  const toggleTheme = usePrefs((s) => s.toggleTheme);
  const isDark = theme === "dark";

  if (collapsed) {
    const nextLang = LANGS[(LANGS.findIndex((l) => l.code === lang) + 1) % LANGS.length];
    const current = LANGS.find((l) => l.code === lang);
    return (
      <div className="flex flex-col items-center gap-1.5">
        <button
          onClick={() => setLang(nextLang.code)}
          title={`Language: ${current?.name} → ${nextLang.name}`}
          aria-label="Cycle language"
          className="flex h-7 w-7 items-center justify-center rounded-md text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {current?.label}
        </button>
        <button
          onClick={toggleTheme}
          title={isDark ? "Switch to light" : "Switch to dark"}
          aria-label="Toggle theme"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {/* Language segmented control */}
      <div className="flex flex-1 rounded-md border border-border p-0.5">
        {LANGS.map((l) => (
          <button
            key={l.code}
            onClick={() => setLang(l.code)}
            title={l.name}
            className={cn(
              "flex-1 rounded px-1 py-0.5 text-xs font-medium transition-colors",
              lang === l.code
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {l.label}
          </button>
        ))}
      </div>
      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        title={isDark ? "Switch to light" : "Switch to dark"}
        aria-label="Toggle theme"
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
