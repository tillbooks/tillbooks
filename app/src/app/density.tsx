/**
 * The density context: Komfortabel or Kompakt, resolved from the person's preference and stamped on the
 * document (D118 B3).
 *
 * The deliberate twin of `theme.tsx`. Density is one global control, not a per-table menu: the value is
 * written to `data-density` on the document element, where the token stylesheet keys the compact
 * spacing/height/type values (see `[data-density='kompakt']` in `brand/tokens/tokens.css`).
 *
 * D178 point 7: the choice is the engine preference `appearance.density` (`komfortabel | kompakt`,
 * default `komfortabel`), read and written through `usePref`, so it follows the person to another
 * browser and an agent can read it. The browser-only choice of earlier builds
 * (`localStorage['till-density']`) moves into the engine once, through `importLegacyPref`, and is then
 * cleared. Outside a `PrefsProvider` (component tests) the provider keeps local state; `initialDensity`
 * pins its start there.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';

import { importLegacyPref, usePref } from '../lib/prefs';

export type Density = 'komfortabel' | 'kompakt';

/** The engine preference key (G00 spec §10, `src/core/customization/prefDefs/appearance.ts`). */
export const DENSITY_PREF = 'appearance.density';

/** The `localStorage` key earlier builds kept an explicit choice under. Read once, then cleared. */
export const DENSITY_STORAGE_KEY = 'till-density';

/** The ground default when the person has made no choice (the registry default, restated for callers). */
export const DEFAULT_DENSITY: Density = 'komfortabel';

export function parseLegacyDensity(raw: string): Density | undefined {
  return raw === 'komfortabel' || raw === 'kompakt' ? raw : undefined;
}

/** Move `till-density` into the engine once (queued until the preference store has loaded). */
export function importLegacyDensity() {
  return importLegacyPref<Density>(DENSITY_PREF, DENSITY_STORAGE_KEY, parseLegacyDensity);
}

void importLegacyDensity();

export interface DensityContextValue {
  density: Density;
  /** Set the density preference. */
  setDensity: (density: Density) => void;
  /** Flip between Komfortabel and Kompakt, storing the result. */
  toggle: () => void;
}

const DensityContext = createContext<DensityContextValue | null>(null);

export function DensityProvider({
  children,
  initialDensity,
}: {
  children: ReactNode;
  /** Pin the start outside a `PrefsProvider` (tests). Inside one, the engine's preference decides. */
  initialDensity?: Density;
}) {
  const [density, setPreference] = usePref<Density>(
    DENSITY_PREF,
    initialDensity === undefined ? undefined : { initial: initialDensity },
  );

  // Reflect the density onto the document so the token stylesheet can pick up the compact values.
  // This runs on mount and on every change, and is the single place that touches `data-density`.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-density', density);
    }
  }, [density]);

  const setDensity = useCallback((next: Density) => void setPreference(next), [setPreference]);
  const toggle = useCallback(
    () => void setPreference(density === 'kompakt' ? 'komfortabel' : 'kompakt'),
    [density, setPreference],
  );

  const value = useMemo<DensityContextValue>(
    () => ({ density, setDensity, toggle }),
    [density, setDensity, toggle],
  );

  return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>;
}

/** Access the density context. Throws outside a provider, which is a wiring bug, not a runtime state. */
export function useDensity(): DensityContextValue {
  const ctx = useContext(DensityContext);
  if (ctx === null) throw new Error('useDensity must be used within a DensityProvider.');
  return ctx;
}
