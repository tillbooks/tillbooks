/**
 * The theme context: light or dark, resolved once and stamped on the document.
 *
 * On mount the theme is read from localStorage('till-theme') if the operator has chosen one,
 * otherwise from the OS `prefers-color-scheme` (light is the ground default when neither is known).
 * The resolved theme is written to `data-theme` on the document element, which is where the token
 * stylesheet keys the palette. An explicit choice (setTheme/toggle) persists; a system-derived
 * default does NOT persist, so the app keeps following the OS until the operator picks a side.
 *
 * Every access to `window` is guarded: under SSR or jsdom (no matchMedia, no localStorage) the
 * provider resolves to light and never throws.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark';

/** The localStorage key that holds an explicit operator choice. */
export const THEME_STORAGE_KEY = 'till-theme';

/** True when the OS asks for a dark scheme. Guarded for environments without matchMedia. */
function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** The stored explicit choice, or null if none (or storage is unavailable). */
function readStored(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** Best-effort persist. Storage can throw (private mode, disabled): a failure is not fatal. */
function persist(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage unavailable: the choice lives only for this session */
  }
}

/** Resolve the initial theme: an explicit choice wins, else the OS preference, else light. */
export function resolveInitialTheme(): Theme {
  return readStored() ?? (prefersDark() ? 'dark' : 'light');
}

export interface ThemeContextValue {
  theme: Theme;
  /** Set the theme explicitly and persist the choice. */
  setTheme: (theme: Theme) => void;
  /** Flip between light and dark, persisting the result. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  children,
  initialTheme,
}: {
  children: ReactNode;
  /** Override the resolved initial theme. Used by tests to pin a known start state. */
  initialTheme?: Theme;
}) {
  const [theme, setThemeState] = useState<Theme>(() => initialTheme ?? resolveInitialTheme());

  // Reflect the theme onto the document so the token stylesheet can pick up the palette. This runs
  // on mount and on every change, and is the single place that touches `data-theme`.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    persist(next);
    setThemeState(next);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      persist(next);
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggle }),
    [theme, setTheme, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Access the theme context. Throws outside a provider, which is a wiring bug, not a runtime state. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error('useTheme must be used within a ThemeProvider.');
  return ctx;
}
