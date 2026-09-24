/**
 * The density context: Komfortabel or Kompakt, resolved once and stamped on the document (D118 B3).
 *
 * This is the deliberate twin of `theme.tsx`. Density is one global control, not a per-table menu:
 * the resolved value is written to `data-density` on the document element, where the token stylesheet
 * keys the compact spacing/height/type values (see `[data-density='kompakt']` in
 * `brand/tokens/tokens.css`). On mount the density is read from localStorage('till-density') if the
 * operator has chosen one, otherwise it defaults to Komfortabel (unlike the theme, there is no OS
 * signal for density, so the ground is the only default). An explicit choice persists.
 *
 * Every access to `window` is guarded: under SSR or jsdom (no localStorage) the provider resolves to
 * Komfortabel and never throws, exactly as the theme provider resolves to light.
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

export type Density = 'komfortabel' | 'kompakt';

/** The localStorage key that holds an explicit operator choice. Sibling of `till-theme`. */
export const DENSITY_STORAGE_KEY = 'till-density';

/** The ground default when the operator has made no choice. */
export const DEFAULT_DENSITY: Density = 'komfortabel';

/** The stored explicit choice, or null if none (or storage is unavailable). */
function readStored(): Density | null {
  try {
    const value = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    return value === 'komfortabel' || value === 'kompakt' ? value : null;
  } catch {
    return null;
  }
}

/** Best-effort persist. Storage can throw (private mode, disabled): a failure is not fatal. */
function persist(density: Density): void {
  try {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
  } catch {
    /* storage unavailable: the choice lives only for this session */
  }
}

/** Resolve the initial density: an explicit choice wins, else the Komfortabel ground. */
export function resolveInitialDensity(): Density {
  return readStored() ?? DEFAULT_DENSITY;
}

export interface DensityContextValue {
  density: Density;
  /** Set the density explicitly and persist the choice. */
  setDensity: (density: Density) => void;
  /** Flip between Komfortabel and Kompakt, persisting the result. */
  toggle: () => void;
}

const DensityContext = createContext<DensityContextValue | null>(null);

export function DensityProvider({
  children,
  initialDensity,
}: {
  children: ReactNode;
  /** Override the resolved initial density. Used by tests to pin a known start state. */
  initialDensity?: Density;
}) {
  const [density, setDensityState] = useState<Density>(
    () => initialDensity ?? resolveInitialDensity(),
  );

  // Reflect the density onto the document so the token stylesheet can pick up the compact values.
  // This runs on mount and on every change, and is the single place that touches `data-density`.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-density', density);
    }
  }, [density]);

  const setDensity = useCallback((next: Density) => {
    persist(next);
    setDensityState(next);
  }, []);

  const toggle = useCallback(() => {
    setDensityState((prev) => {
      const next: Density = prev === 'kompakt' ? 'komfortabel' : 'kompakt';
      persist(next);
      return next;
    });
  }, []);

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
