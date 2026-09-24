/**
 * The Environments surface's read model: the shapes the `env_*` verbs (D126, Phase A) send, mirrored
 * here so the surface reads typed fields rather than poking an open `Result`. The engine's `envView`
 * (`src/core/landscape/operations.ts`) is the source of truth for every field name; this is its
 * camelCase wire twin, and nothing here is derived in the browser.
 */

/** How an environment's data root is populated. `copy` is Phase B (the sanitize / secrets path). */
export type DataPolicy = 'synthetic' | 'copy' | 'live';

/** `protected` is `main` alone; every other environment is `open`. */
export type GuardTier = 'protected' | 'open';

/** Where the environment runs: a served Docker stack, or a local process / worktree. */
export type RuntimeTarget = 'served' | 'local';

/** How a copy out of a source treats PII. `raw` keeps it, `pseudonymize` masks it (still personal,
 *  DSG-honest: NOT "anonymised"), `structure_synthetic` replaces it so no source person remains. */
export type Sanitization = 'raw' | 'pseudonymize' | 'structure_synthetic';

/** One environment row, exactly as `envView` sends it. */
export interface EnvironmentRow {
  readonly name: string;
  readonly codeChannel: string;
  readonly dbPath: string;
  readonly dataPolicy: DataPolicy;
  readonly sourceEnv: string | null;
  readonly sanitization: Sanitization | null;
  readonly guardTier: GuardTier;
  readonly runtimeTarget: RuntimeTarget;
  readonly tierRank: number;
  readonly createdAt: string;
  readonly lastRefreshAt: string | null;
  readonly seed: string | null;
  readonly current: boolean;
  /** A served (hosted) env is read-only from a local face; a local main stays writable (`env_current.readOnly`, D135). */
  readonly readOnly: boolean;
  /** Whether the data root file exists on disk right now. */
  readonly exists: boolean;
  readonly sizeBytes: number | null;
}

/** `env_list` success payload. */
export interface EnvListOk {
  readonly environments: readonly EnvironmentRow[];
  readonly active: string;
  readonly count: number;
}

/** `env_status` success payload (finding #9: the Environment-detail read). */
export interface EnvStatusOk {
  readonly environment: EnvironmentRow;
  readonly current: boolean;
  readonly codeChannelDrift: 'none' | 'drifted' | 'unknown';
  readonly builtCodeChannel: string | null;
}

/** The three structural tiers, always present and pinned first (never deletable without force). */
export const STANDARD_TIERS = ['main', 'test', 'develop'] as const;
export type StandardTier = (typeof STANDARD_TIERS)[number];

export function isStandardTier(name: string): name is StandardTier {
  return (STANDARD_TIERS as readonly string[]).includes(name);
}

/** `main` is protected: it never offers a destructive action, only a padlock (E7). */
export function isProtected(env: EnvironmentRow): boolean {
  return env.guardTier === 'protected';
}

/**
 * A GENUINELY read-only face (D135). Only a SERVED (hosted / remote) environment answers an ordinary
 * write with a read-only face; a LOCAL environment is writable whatever its guard tier. `protected`
 * (main's env-wide destructive-op lock) is NOT read-only: a local `main` is the real books and stays
 * writable, so it must never wear the "read only" wording. The engine's row `readOnly` flag reports
 * protection (protected OR served) and is a presentation flag, not a write guard, so the Studio reads
 * the runtime target directly to decide the wording.
 */
export function isReadOnlyFace(env: EnvironmentRow): boolean {
  return env.runtimeTarget === 'served';
}

/**
 * Split a listing into the pinned standard tiers (in main -> test -> develop order) and the named
 * ad-hoc environments (kept in the order the engine returned them). At scale (15-20 envs) the three
 * tiers stay pinned while the named group scrolls and filters (E5b, surface block 7.2).
 */
export function partitionEnvironments(rows: readonly EnvironmentRow[]): {
  tiers: EnvironmentRow[];
  named: EnvironmentRow[];
} {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const tiers = STANDARD_TIERS.map((name) => byName.get(name)).filter(
    (r): r is EnvironmentRow => r !== undefined,
  );
  const named = rows.filter((r) => !isStandardTier(r.name));
  return { tiers, named };
}

/** Human-readable file size for a row (`sizeBytes` is bytes, or null when the root is absent). */
export function formatSize(sizeBytes: number | null): string | null {
  if (sizeBytes === null) return null;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kib = sizeBytes / 1024;
  if (kib < 1024) return `${kib.toFixed(0)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MB`;
  return `${(mib / 1024).toFixed(2)} GB`;
}
