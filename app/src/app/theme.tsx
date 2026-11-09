/**
 * The theme context: light or dark, resolved from the person's colour-scheme preference and stamped on
 * the document.
 *
 * D178 point 7: the choice is the engine preference `appearance.theme` (`light | dark | system`, default
 * `system`), read and written through `usePref`, so it follows the person to another browser and an agent
 * can read it. `system` follows the OS `prefers-color-scheme` live (light when the OS says nothing). The
 * resolved theme is written to `data-theme` on the document element, where the token stylesheet keys the
 * palette.
 *
 * The browser-only choice of earlier builds (`localStorage['till-theme']`) moves into the engine once,
 * through `importLegacyPref`, and is then cleared. Outside a `PrefsProvider` (component tests) the
 * provider keeps local state; `initialTheme` pins its start there.
 *
 * Every access to `window` is guarded: under SSR or jsdom (no matchMedia) the provider resolves `system`
 * to light and never throws.
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

import { importLegacyPref, usePref } from '../lib/prefs';

export type Theme = 'light' | 'dark';

/** The stored preference: an explicit side, or the operating system's. */
export type ThemePreference = Theme | 'system';

/** The engine preference key (G00 spec §10, `src/core/customization/prefDefs/appearance.ts`). */
export const THEME_PREF = 'appearance.theme';

/** The `localStorage` key earlier builds kept an explicit choice under. Read once, then cleared. */
export const THEME_STORAGE_KEY = 'till-theme';

/** The legacy value as a preference: only an explicit side was ever stored (no key meant "system"). */
export function parseLegacyTheme(raw: string): ThemePreference | undefined {
  return raw === 'light' || raw === 'dark' ? raw : undefined;
}

/** Move `till-theme` into the engine once (queued until the preference store has loaded). */
export function importLegacyTheme() {
  return importLegacyPref<ThemePreference>(THEME_PREF, THEME_STORAGE_KEY, parseLegacyTheme);
}

void importLegacyTheme();

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** True when the OS asks for a dark scheme. Guarded for environments without matchMedia. */
function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/** The OS scheme, kept live while the person follows the system. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(prefersDark);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => setDark(media.matches);
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);
  return dark;
}

export interface ThemeContextValue {
  /** The theme on screen: the preference, with `system` resolved against the OS. */
  theme: Theme;
  /** The stored preference. */
  preference: ThemePreference;
  /** Set the preference (an explicit side, or `system`). */
  setTheme: (theme: ThemePreference) => void;
  /** Flip the theme on screen, storing the explicit side. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  children,
  initialTheme,
}: {
  children: ReactNode;
  /** Pin the start outside a `PrefsProvider` (tests). Inside one, the engine's preference decides. */
  initialTheme?: ThemePreference;
}) {
  const [preference, setPreference] = usePref<ThemePreference>(
    THEME_PREF,
    initialTheme === undefined ? undefined : { initial: initialTheme },
  );
  const systemDark = useSystemDark();
  const theme: Theme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  // Reflect the theme onto the document so the token stylesheet can pick up the palette. This runs
  // on mount and on every change, and is the single place that touches `data-theme`.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  const setTheme = useCallback((next: ThemePreference) => void setPreference(next), [setPreference]);
  const toggle = useCallback(() => void setPreference(theme === 'dark' ? 'light' : 'dark'), [theme, setPreference]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, preference, setTheme, toggle }),
    [theme, preference, setTheme, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Access the theme context. Throws outside a provider, which is a wiring bug, not a runtime state. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error('useTheme must be used within a ThemeProvider.');
  return ctx;
}
