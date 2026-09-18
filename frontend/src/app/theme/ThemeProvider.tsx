import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "dark" | "light";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
};

const THEME_STORAGE_KEY = "practice.appearance.theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The visual theme still works when private browsing blocks storage.
    }
  }, [theme]);

  const setTheme = useCallback((nextTheme: Theme) => setThemeState(nextTheme), []);
  const toggleTheme = useCallback(() => {
    setThemeState((current) => current === "dark" ? "light" : "dark");
  }, []);

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [setTheme, theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
