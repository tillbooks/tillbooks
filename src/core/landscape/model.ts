/**
 * The ENVIRONMENT LANDSCAPE model (D126, `docs/planning/environments-landscape-concept.md`).
 *
 * An environment is an isolated TILL runtime: its own data root (a SQLite file plus a support and a
 * backup directory), a pinned code channel, a data policy (synthetic seed / copy of a source / live),
 * a guard tier (`protected` for `main`, `open` for the rest), and a runtime target (`served` or
 * `local`). This is the ONE object the multi-tenant schema does not carry, and deliberately so: the
 * landscape sits ABOVE any single workspace, so it lives in a host-level control file, not in a
 * per-environment database (which could not hold the cross-environment registry without a
 * chicken-and-egg bootstrap, section 3).
 *
 * This module is types and constants only. `controlFile.ts` reads/writes the tamper-evident control
 * file, `tierRank.ts` owns the down-only ranking, and `operations.ts` is the verb layer.
 */

/** How an environment's data is populated. `copy` is Phase B (the sanitize/secrets path). */
export type DataPolicy = 'synthetic' | 'copy' | 'live';

/** `protected` is `main` only: destructive environment ops are refused against it (the landscape law). */
export type GuardTier = 'protected' | 'open';

/** Where the environment runs: a served Docker stack, or a local process / worktree. */
export type RuntimeTarget = 'served' | 'local';

/** How a copy out of `main` treats PII (Phase B decides the transform; recorded here from birth). */
export type Sanitization = 'raw' | 'pseudonymize' | 'structure_synthetic';

/**
 * One environment, as persisted in the control file. Every field from section 3's object model, plus
 * the tier rank (finding #10, the down-only invariant) the copy path will check.
 */
export interface Environment {
  /** The id (unique per landscape) and the display name. */
  readonly name: string;
  /** The git branch / release this environment pins (`develop`, `staging`, `main`, or a custom ref). */
  readonly code_channel: string;
  /** `TILL_DB_PATH`: this environment's own SQLite file. The DATA ROOT protection keys on this. */
  readonly db_path: string;
  /** `TILL_SUPPORT_DIR`: diagnostics, the up-lock, and this environment's own landscape-adjacent state. */
  readonly support_dir: string;
  /** `TILL_BACKUP_DIR`: where this environment's `.tillbackup` bundles are written. */
  readonly backup_dir: string;
  /** How the data root is populated. */
  readonly data_policy: DataPolicy;
  /** The environment a `copy` was taken from, or null for `synthetic` / `live`. */
  readonly source_env: string | null;
  /** The sanitization applied on the last copy out of a source, or null. */
  readonly sanitization: Sanitization | null;
  /** `protected` (only `main`) or `open`. */
  readonly guard_tier: GuardTier;
  /** `served` or `local`. */
  readonly runtime_target: RuntimeTarget;
  /**
   * The DOWN-ONLY rank (finding #10). Data may be copied only from a HIGHER rank to a LOWER one, so a
   * larger number is a more sensitive tier. `main` sits at the top; a named env defaults below dev.
   */
  readonly tier_rank: number;
  /** When the environment was first created (ISO-8601 UTC). */
  readonly created_at: string;
  /** When the data root was last refreshed (seeded / copied / reset), or null if never. */
  readonly last_refresh_at: string | null;
  /** The synthetic seed this environment uses (`synthetic` policy only), for reset. */
  readonly seed: string | null;
  /**
   * COPY PROVENANCE (E8 mandate refresh): the host-level mapping SOURCE workspace id -> the TARGET
   * workspace id its last copy produced here. A mandate refresh dedups the prior copy by THIS stable
   * key, never by `workspace.name` (a maskable PII column: under pseudonymize / structure_synthetic the
   * name is rewritten, so a name-match would find nothing and `restoreBackup` would APPEND a duplicate,
   * silently doubling instance totals). Absent on non-copy envs; a fresh (instance) copy replaces it,
   * a mandate copy merges the refreshed mandate in. Kept out of the ledger so no schema change is owed.
   */
  readonly copy_provenance?: Readonly<Record<string, string>> | null;
}

/**
 * The tip of the host-level audit chain, bound INTO the control file so a hand-edit of either file is
 * detected. `null` before the first audit record (a landscape that has only been bootstrapped carries
 * the genesis record, so this is null only transiently during the very first write).
 */
export interface AuditHead {
  readonly seq: number;
  readonly hash: string;
}

/**
 * The whole control file, `environments.json`. `checksum` covers the canonical serialization of every
 * other field, so a hand-edit that does not also recompute it is a detected, refused condition
 * (finding #2). `active` is the current environment for this face (the switch pointer).
 */
export interface LandscapeControlFile {
  readonly version: 1;
  readonly environments: Readonly<Record<string, Environment>>;
  readonly active: string;
  readonly audit_head: AuditHead | null;
  /** sha256 over the canonical serialization of `{version, environments, active, audit_head}`. */
  readonly checksum: string;
}

/** One appended host-level audit record. Hash-chained like the ledger audit (finding #2). */
export interface EnvAuditRecord {
  readonly seq: number;
  readonly at: string;
  readonly actor: string;
  /** The env.* verb that produced this record (`env_create`, `env_reset`, ...). */
  readonly action: string;
  /** The environment the mutation was about. */
  readonly target: string;
  /** A short machine-readable outcome tag (`created`, `reset`, `deleted`, `switched`, `bootstrap`). */
  readonly outcome: string;
  /** The previous record's hash, or the genesis constant for the first record. */
  readonly prev_hash: string;
  /** `H(prev_hash || canonical(record without prev_hash/hash))`. */
  readonly hash: string;
}

/** The control file's name inside the support directory. */
export const CONTROL_FILE_NAME = 'environments.json';

/** The appended host-level audit log's name inside the support directory. */
export const AUDIT_FILE_NAME = 'environments.audit.jsonl';

/** The `prev_hash` used for the genesis (first) audit record. Mirrors the ledger's genesis constant. */
export const AUDIT_GENESIS_PREV = '0'.repeat(64);

/** The three standard environments, always present in a bootstrapped landscape. */
export const STANDARD_ENVIRONMENTS = ['main', 'test', 'develop'] as const;
export type StandardEnvironment = (typeof STANDARD_ENVIRONMENTS)[number];

/** Is `name` one of the three structural tiers (which `env_delete` refuses without `force`)? */
export function isStandardEnvironment(name: string): name is StandardEnvironment {
  return (STANDARD_ENVIRONMENTS as readonly string[]).includes(name);
}
