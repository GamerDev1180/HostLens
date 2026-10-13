import { useEffect, useState } from "react";
import { loadJson, saveJson } from "./storage";

export type ThemePreference = "dark" | "light" | "system";

export interface AppSettings {
  theme: ThemePreference;
}

const KEY = "hostlens.settings";
const DEFAULTS: AppSettings = { theme: "dark" };

const prefersDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;

/** App-wide preferences; applies the theme to <html data-theme>. */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...DEFAULTS,
    ...loadJson<Partial<AppSettings>>(KEY, {}, (v) => typeof v === "object" && v !== null),
  }));

  useEffect(() => saveJson(KEY, settings), [settings]);

  useEffect(() => {
    const apply = () => {
      const dark = settings.theme === "dark" || (settings.theme === "system" && prefersDark());
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    if (settings.theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.theme]);

  return { settings, setSettings };
}
