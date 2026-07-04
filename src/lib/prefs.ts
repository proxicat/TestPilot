// User preferences: UI language + light/dark theme. Persisted to localStorage and
// applied to <html> (the `dark` class drives Tailwind's `dark:` variants, which are
// already written throughout the app). Kept separate from the data store on purpose.
import { create } from "zustand";
import { translate, type Lang } from "./i18n";

export type Theme = "light" | "dark";

const LANG_KEY = "tp-lang";
const THEME_KEY = "tp-theme";

function initialLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === "zh" || saved === "en" || saved === "ja") return saved;
  // Guess from the browser once; default to English otherwise.
  const nav = navigator.language.toLowerCase();
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("ja")) return "ja";
  return "en";
}

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

interface PrefsState {
  lang: Lang;
  theme: Theme;
  setLang: (lang: Lang) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const usePrefs = create<PrefsState>((set, get) => {
  const lang = initialLang();
  const theme = initialTheme();
  applyTheme(theme); // apply on store creation (import time) to avoid a flash

  return {
    lang,
    theme,
    setLang: (lang) => {
      localStorage.setItem(LANG_KEY, lang);
      set({ lang });
    },
    setTheme: (theme) => {
      localStorage.setItem(THEME_KEY, theme);
      applyTheme(theme);
      set({ theme });
    },
    toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  };
});

// Translation hook: re-renders components when the language changes.
export function useT(): (key: string) => string {
  const lang = usePrefs((s) => s.lang);
  return (key: string) => translate(key, lang);
}
