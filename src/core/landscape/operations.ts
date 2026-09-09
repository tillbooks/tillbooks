/**
 * The environment landscape OPERATIONS: the engine behind the `env_*` verb family (Phase A).
 *
 * These are pure functions over `LandscapeDeps` (the support dir where the control file lives, the
 * local environments root, the PROTECTED main data root, the actor, a clock, and the injectable seed
 * registry). They return `Result`; the api layer (`src/api/env-actions.ts`) wraps the confirmed writes
 * in idempotency and A24, and does not re-implement any of this.
 *
 * The invariants they enforce, each a canon finding folded into the build spec (section 10):
 *   - #2  the control file is tamper-evident and every mutation is audited; a read FAILS LOUD on a
 *         mismatch (`readOrBootstrap` -> `readLandscape` throws -> `integrityError`).
 *   - #3  `main` protection keys on the DATA ROOT, not the name: create refuses a db_path that
 *         collides with an existing env's root or resolves to `main`'s volume, and reset/delete refuse
 *         when the resolved target root IS `main`'s, whatever the name argument says.
 *   - #5  reset is BUILD-THEN-SWAP: seed a new file, run `foreign_key_check` + a balance re-foot, and
 *         swap only on success, so a failed reset leaves the prior env intact (matrix E3a).
 *   - #10 each env carries a tier rank; `canCopyDown` (tierRank.ts) is ready for Phase B's `env.copy`.
 *   - #11 reset/delete on the ACTIVE env require switching away first (or `force`).
 *   - P8  every write returns a PLAN when unconfirmed and changes nothing.
 *
 * `copy` policy (env.create policy=copy, and reset of a copy-policy env) is PHASE B: it needs the
 * sanitize + secret-neutralization + build-then-swap copy path a concurrent agent owns. Phase A
 * refuses it with a clear `phase_b_not_implemented`, and synthetic + live work fully.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { ok, err, type Result } from '../result.js';
import type { Clock } from '../clock.js';
import type { IdGen } from '../ids.js';
import { SqliteStore } from '../store/sqlite-store.js';
import {
  landscapeExists,
  readLandscape,
  writeLandscape,
  LandscapeIntegrityError,
} from './controlFile.js';
import {
  isStandardEnvironment,
  type Environment,
  type GuardTier,
  type LandscapeControlFile,
  type RuntimeTarget,
} from './model.js';
import { DEFAULT_SEED, type SeederRegistry } from './seed.js';
// Phase B copy verbs. A value import that forms a cycle with copy.ts`s type-only import of
// `LandscapeDeps` and value import of `readOrBootstrap`; safe because every use is inside a function
// body (lazy), never at module-init time.
import { envCreateCopy, envResetCopy } from './copy.js';
import {
  RANK_DEVELOP,
  RANK_MAIN,
  RANK_TEST,
  STANDARD_TIER_RANKS,
  resolveTierRank,
} from './tierRank.js';

/** What the operations need. Everything is injectable so a unit test never touches the real machine. */
export interface LandscapeDeps {
  /** Where `environments.json` + `environments.audit.jsonl` live (resolved from TILL_SUPPORT_DIR). */
  readonly supportDir: string;
  /** Where local (non-main) environment data roots are created (`<supportDir>/environments` by default). */
  readonly environmentsRoot: string;
  /** The PROTECTED `main` data root (the real ledger path). Protection keys on this, not on the name. */
  readonly mainDbPath: string;
  /** The stamping actor for the host-level audit record. */
  readonly actor: string;
  /** ISO-8601 UTC now, from the injected clock. */
  now(): string;
  /** The synthetic seed vocabulary (`env_create`/`env_reset` validate the `seed` input against it). */
  readonly seeders: SeederRegistry;
  /** The code channel THIS process was built from, for `env_status` drift; undefined = not probed. */
  readonly currentCodeChannel?: string | undefined;
  /**
   * Phase B (the copy path) reuses the proven `portability.ts` snapshot/restore, which needs a real
   * id generator and clock (to re-mint ids and stamp the copy). Phase A`s synthetic/live paths do not,
   * so these are optional; `copy.ts` refuses with a clear internal error if a copy is attempted without
   * them, and the api layer always supplies `ctx.ids` / `ctx.clock`.
   */
  readonly ids?: IdGen | undefined;
  readonly clock?: Clock | undefined;
}

// --- inputs (loose; the api layer maps the wire object straight through) ------------------------

interface CreateInput {
  name?: unknown;
  policy?: unknown;
  codeChannel?: unknown;
  source?: unknown;
  seed?: unknown;
  dbPath?: unknown;
  guardTier?: unknown;
  runtimeTarget?: unknown;
  tierRank?: unknown;
  sanitize?: unknown;
  confirmed?: unknown;
}
interface ResetInput {
  name?: unknown;
  seed?: unknown;
  force?: unknown;
  confirmed?: unknown;
}
interface SwitchInput {
  name?: unknown;
  confirmed?: unknown;
}
interface DeleteInput {
  name?: unknown;
  force?: unknown;
  confirmed?: unknown;
}

// --- shared helpers ----------------------------------------------------------------------------

function integrityError(e: unknown): Result {
  if (e instanceof LandscapeIntegrityError) return err('landscape_integrity_failed', { reason: e.reason });
  throw e;
}

/** Read the control file, bootstrapping the three standard tiers on first use. May throw (tamper). */
/** Exported so `copy.ts` (Phase B) reads-or-bootstraps through the SAME path, one source of truth. */
export function readOrBootstrap(deps: LandscapeDeps): LandscapeControlFile {
  if (landscapeExists(deps.supportDir)) return readLandscape(deps.supportDir);
  const environments = standardEnvironments(deps);
  return writeLandscape(
    deps.supportDir,
    { version: 1, environments, active: 'develop' },
    { at: deps.now(), actor: deps.actor, action: 'bootstrap', target: 'landscape', outcome: 'bootstrap' },
    null,
  );
}

/** The three standard environments a fresh landscape is seeded with (section 2's table). */
function standardEnvironments(deps: LandscapeDeps): Record<string, Environment> {
  const now = deps.now();
  const local = (name: string): string => join(deps.environmentsRoot, name);
  return {
    main: {
      name: 'main',
      code_channel: 'main',
      db_path: deps.mainDbPath,
      support_dir: deps.supportDir,
      backup_dir: join(deps.supportDir, 'backups'),
      data_policy: 'live',
      source_env: null,
      sanitization: null,
      guard_tier: 'protected',
      runtime_target: 'served',
      tier_rank: RANK_MAIN,
      created_at: now,
      last_refresh_at: null,
      seed: null,
    },
    test: {
      name: 'test',
      code_channel: 'staging',
      db_path: join(local('test'), 'till.db'),
      support_dir: join(local('test'), 'support'),
      backup_dir: join(local('test'), 'backups'),
      data_policy: 'copy',
      source_env: 'main',
      sanitization: 'pseudonymize',
      guard_tier: 'open',
      runtime_target: 'local',
      tier_rank: RANK_TEST,
      created_at: now,
      last_refresh_at: null,
      seed: null,
    },
    develop: {
      name: 'develop',
      code_channel: 'develop',
      db_path: join(local('develop'), 'till.db'),
      support_dir: join(local('develop'), 'support'),
      backup_dir: join(local('develop'), 'backups'),
      data_policy: 'synthetic',
      source_env: null,
      sanitization: null,
      guard_tier: 'open',
      runtime_target: 'local',
      tier_rank: RANK_DEVELOP,
      created_at: now,
      last_refresh_at: null,
      seed: DEFAULT_SEED,
    },
  };
}

/** An environment is read-only from a local face when it is protected or served (finding #13). */
function isReadOnly(env: Environment): boolean {
  return env.guard_tier === 'protected' || env.runtime_target === 'served';
}

/** The resolved size of an environment's db file, or null when it has not been populated yet. */
function dbSize(dbPath: string): number | null {
  try {
    return statSync(dbPath).size;
  } catch {
    return null;
  }
}

/** A stable public view of one environment (no secret is carried; a data root is machine topology). */
function envView(env: Environment, active: string): Record<string, unknown> {
  return {
    name: env.name,
    codeChannel: env.code_channel,
    dbPath: env.db_path,
    dataPolicy: env.data_policy,
    sourceEnv: env.source_env,
    sanitization: env.sanitization,
    guardTier: env.guard_tier,
    runtimeTarget: env.runtime_target,
    tierRank: env.tier_rank,
    createdAt: env.created_at,
    lastRefreshAt: env.last_refresh_at,
    seed: env.seed,
    current: env.name === active,
    readOnly: isReadOnly(env),
    exists: dbSize(env.db_path) !== null,
    sizeBytes: dbSize(env.db_path),
  };
}

/** Standard tiers pinned first (main, test, develop), then named envs sorted (matrix E5b). */
function orderedNames(environments: Readonly<Record<string, Environment>>): string[] {
  const named = Object.keys(environments)
    .filter((n) => !isStandardEnvironment(n))
    .sort();
  const standard = ['main', 'test', 'develop'].filter((n) => n in environments);
  return [...standard, ...named];
}

/** Canonical absolute path, for a data-root collision / main-aliasing comparison (finding #3). */
function canonical(p: string): string {
  return resolve(p);
}

/** Remove a db file and its WAL/SHM sidecars, best effort. */
function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {
      // best effort: a missing sidecar is fine.
    }
  }
}

/**
 * BUILD a fresh db at `targetPath` per the data policy, THEN gate it (foreign_key_check + a per-entry
 * balance re-foot). Throws `BuildError` on any failure, so the caller's build-then-swap can leave the
 * prior file untouched (finding #5 / matrix E3a). `synthetic` runs the named seeder; `live` writes an
 * empty schema-only ledger.
 */
class BuildError extends Error {
  constructor(readonly reason: string, readonly phase: 'seed' | 'gate') {
    super(reason);
    this.name = 'BuildError';
  }
}

function buildDb(deps: LandscapeDeps, policy: 'synthetic' | 'live', seedName: string, targetPath: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  removeDbFiles(targetPath); // a stale building file from a prior crashed attempt

  if (policy === 'synthetic') {
    const seeder = deps.seeders[seedName];
    if (seeder === undefined) throw new BuildError('unknown_seed', 'seed');
    try {
      seeder(targetPath);
    } catch (e) {
      throw new BuildError(e instanceof Error ? e.message : String(e), 'seed');
    }
  } else {
    // live: an empty, valid ledger (schema only). Opening the store applies the schema.
    try {
      const store = new SqliteStore({ location: targetPath });
      store.close();
    } catch (e) {
      throw new BuildError(e instanceof Error ? e.message : String(e), 'seed');
    }
  }

  gateDb(targetPath);
}

/** The invariant gate over a freshly-built db: referential integrity + every posted entry balances. */
function gateDb(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true });
  try {
    const fk = db.pragma('foreign_key_check') as unknown[];
    if (fk.length > 0) throw new BuildError('referential_integrity', 'gate');
    const entries = db.prepare("SELECT id FROM \"journal_entry\" WHERE status = 'posted'").all() as {
      id: string;
    }[];
    for (const entry of entries) {
      const sums = db
        .prepare(
          'SELECT COALESCE(SUM(base_debit_minor),0) AS d, COALESCE(SUM(base_credit_minor),0) AS c FROM "journal_line" WHERE entry_id = ?',
        )
        .get(entry.id) as { d: number; c: number };
      if (sums.d !== sums.c) throw new BuildError('unbalanced_entry', 'gate');
    }
  } finally {
    db.close();
  }
}

// --- the reads ---------------------------------------------------------------------------------

/** `env_list`: every environment with its status, standard tiers pinned first. FAILS LOUD on tamper. */
export function envList(deps: LandscapeDeps): Result {
  let file: LandscapeControlFile;
  try {
    file = readOrBootstrap(deps);
  } catch (e) {
    return integrityError(e);
  }
  const environments = orderedNames(file.environments).map((n) => envView(file.environments[n]!, file.active));
  return ok({ environments, active: file.active, count: environments.length });
}

/** `env_status`: detail one environment (freshness, guard, code-channel drift). FAILS LOUD on tamper. */
export function envStatus(deps: LandscapeDeps, input: { name?: unknown }): Result {
  const name = typeof input.name === 'string' ? input.name : '';
  if (name.length === 0) return err('invalid_input', { field: 'name' });
  let file: LandscapeControlFile;
  try {
    file = readOrBootstrap(deps);
  } catch (e) {
    return integrityError(e);
  }
  const env = file.environments[name];
  if (env === undefined) return err('environment_not_found', { name });
  // Code-channel drift (D-ENV-6): compare the recorded channel to the one this process was built from,
  // when known. v1 records and WARNS; it does not auto-provision a matching build.
  const drift =
    deps.currentCodeChannel === undefined
      ? 'unknown'
      : deps.currentCodeChannel === env.code_channel
        ? 'none'
        : 'drifted';
  return ok({
    environment: envView(env, file.active),
    current: env.name === file.active,
    codeChannelDrift: drift,
    builtCodeChannel: deps.currentCodeChannel ?? null,
  });
}

/** `env_current`: the active environment for this face, and whether it is read-only. */
export function envCurrent(deps: LandscapeDeps): Result {
  let file: LandscapeControlFile;
  try {
    file = readOrBootstrap(deps);
  } catch (e) {
    return integrityError(e);
  }
  const env = file.environments[file.active];
  if (env === undefined) {
    // The active pointer names a missing env: report it rather than silently inventing one.
    return err('active_environment_missing', { active: file.active });
  }
  return ok({ active: file.active, environment: envView(env, file.active), readOnly: isReadOnly(env) });
}

// --- the writes (P8: unconfirmed returns a plan and changes nothing) ---------------------------

/** `env_switch`: set the active environment for the local face. Switching to a served/main env is */
/** allowed but marks the face read-only (finding #13); destructive verbs stay refused on `main`. */
export function envSwitch(deps: LandscapeDeps, input: SwitchInput): Result {
  const name = typeof input.name === 'string' ? input.name : '';
  if (name.length === 0) return err('invalid_input', { field: 'name' });
  let file: LandscapeControlFile;
  try {
    file = readOrBootstrap(deps);
  } catch (e) {
    return integrityError(e);
  }
  const env = file.environments[name];
  if (env === undefined) return err('environment_not_found', { name });

  if (input.confirmed !== true) {
    return ok({ staged: true, plan: { from: file.active, to: name, readOnly: isReadOnly(env) } });
  }

  try {
    const written = writeLandscape(
      deps.supportDir,
      { version: 1, environments: file.environments, active: name },
      { at: deps.now(), actor: deps.actor, action: 'env_switch', target: name, outcome: 'switched' },
      file.audit_head,
    );
    return ok({ active: written.active, previous: file.active, readOnly: isReadOnly(env) });
  } catch (e) {
    return integrityError(e);
  }
}

/** `env_create`: provision a new environment's data root and populate it per its policy. */
export function envCreate(deps: LandscapeDeps, input: CreateInput): Result {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) return err('invalid_input', { field: 'name' });
  // A name is an id and part of a filesystem path: no separators, no traversal.
  if (/[\\/]/.test(name) || name === '.' || name === '..') return err('invalid_input', { field: 'name' });

  const policy = input.policy;
  if (policy !== 'synthetic' && policy !== 'copy' && policy !== 'live') {
    return err('invalid_input', { field: 'policy', allowed: ['synthetic', 'copy', 'live'] });
  }
  if (policy === 'copy') {
    // Phase B: compose the create checks + the copy + sanitize + secret-neutralization path.
    return envCreateCopy(deps, input);
  }

  let file: LandscapeControlFile;
  try {
    file = readOrBootstrap(deps);
  } catch (e) {
    return integrityError(e);
  }
  if (name in file.environments) return err('environment_exists', { name });

  const tierRank = resolveTierRank(name, input.tierRank);
  if (tierRank === undefined) return err('invalid_input', { field: 'tierRank' });

  const runtimeTarget: RuntimeTarget = input.runtimeTarget === 'served' ? 'served' : 'local';
  const guardTier: GuardTier = 'open'; // only `main` is ever protected (section 2).
  const dbPath =
    typeof input.dbPath === 'string' && input.dbPath.trim().length > 0
      ? input.dbPath.trim()
      : join(deps.environmentsRoot, name, 'till.db');

  // DATA ROOT protection (finding #3): a new env may not alias `main`'s volume, and may not collide
  // with any existing env's data root. Both keyed on the RESOLVED path, not the name.
  if (canonical(dbPath) === canonical(deps.mainDbPath)) {
    return err('data_root_is_main', {
      dbPath,
      reason: 'a non-main environment may not point its data root at main`s volume',
    });
  }
  for (const other of Object.values(file.environments)) {
    if (canonical(other.db_path) === canonical(dbPath)) {
      return err('data_root_collision', { dbPath, collidesWith: other.name });
    }
  }

  const seedName = policy === 'synthetic' ? (typeof input.seed === 'string' && input.seed.length > 0 ? input.seed : DEFAULT_SEED) : null;
  if (policy === 'synthetic' && seedName !== null && deps.seeders[seedName] === undefined) {
    return err('unknown_seed', { seed: seedName, available: Object.keys(deps.seeders).sort() });
  }

  const codeChannel = typeof input.codeChannel === 'string' && input.codeChannel.length > 0 ? input.codeChannel : name;

  if (input.confirmed !== true) {
    return ok({
      staged: true,
      plan: { name, policy, codeChannel, dbPath, dataPolicy: policy, tierRank, runtimeTarget, seed: seedName },
    });
  }

  // BUILD-THEN-SWAP even on create: build into a temp file, gate, then move into place, so a failed
  // seed leaves no half-written data root and never records an env that does not have a valid ledger.
  const building = dbPath + '.building';
  try {
    buildDb(deps, policy as 'synthetic' | 'live', seedName ?? '', building);
  } catch (e) {
    removeDbFiles(building);
    if (e instanceof BuildError) {
      return e.reason === 'unknown_seed'
        ? err('unknown_seed', { seed: seedName, available: Object.keys(deps.seeders).sort() })
        : err('seed_failed', { phase: e.phase, reason: e.reason });
    }
    throw e;
  }
  swapInto(building, dbPath);

  const now = deps.now();
  const env: Environment = {
    name,
    code_channel: codeChannel,
    db_path: dbPath,
    support_dir: join(deps.environmentsRoot, name, 'support'),
    backup_dir: join(deps.environmentsRoot, name, 'backups'),
    data_policy: policy,
    source_env: null,
    sanitization: null,
    guard_tier: guardTier,
    runtime_target: runtimeTarget,
    tier_rank: tierRank,
    created_at: now,
    last_refresh_at: now,
    seed: seedName,
  };
  try {
    const written = writeLandscape(
      deps.supportDir,
      { version: 1, environments: { ...file.environments, [name]: env }, active: file.active },
      { at: now, actor: deps.actor, action: 'env_create', target: name, outcome: 'created' },
      file.audit_head,
    );
    return ok({ environment: envView(written.environments[name]!, written.active), created: true });
  } catch (e) {
    return integrityError(e);
  }
}

/** `env_reset`: wipe and repopulate an environment from its data policy, BUILD-THEN-SWAP (finding #5). */
export function envReset(deps: LandscapeDeps, input: ResetInput): Result {
  const name = typeof input.name === 'string' ? input.name : '';
  if (name.length === 0) return err('invalid_input', { field: 'name' });
  let file: LandscapeControlFile;
  try {
    file = readOrBootstrap(deps);
  } catch (e) {
    return integrityError(e);
  }
  const env = file.environments[name];
  if (env === undefined) return err('environment_not_found', { name });

  // main protection by DATA ROOT (finding #3) AND by guard tier: either makes reset refuse.
  if (env.guard_tier === 'protected' || canonical(env.db_path) === canonical(deps.mainDbPath)) {
    return err('environment_protected', { name, reason: 'main is protected against reset (the landscape law)' });
  }
  // Active-env guard (finding #11): reset the active env only after switching away, or with force.
  if (name === file.active && input.force !== true) {
    return err('environment_active', { name, hint: 'switch away first, or pass force to quiesce' });
  }
  // copy policy is Phase B: reset of a copy-policy env re-copies from its recorded source (build-then-swap).
  if (env.data_policy === 'copy') {
    return envResetCopy(deps, input);
  }

  const seedName =
    env.data_policy === 'synthetic'
      ? typeof input.seed === 'string' && input.seed.length > 0
        ? input.seed
        : (env.seed ?? DEFAULT_SEED)
      : null;
  if (env.data_policy === 'synthetic' && seedName !== null && deps.seeders[seedName] === undefined) {
    return err('unknown_seed', { seed: seedName, available: Object.keys(deps.seeders).sort() });
  }

  if (input.confirmed !== true) {
    return ok({ staged: true, plan: { name, dataPolicy: env.data_policy, seed: seedName, willRebuild: true } });
  }

  // BUILD-THEN-SWAP: build into a temp file and gate it. On ANY failure the prior env db is untouched
  // and still selectable (matrix E3a); only a passing build is swapped into place.
  const building = env.db_path + '.building';
  try {
    buildDb(deps, env.data_policy as 'synthetic' | 'live', seedName ?? '', building);
  } catch (e) {
    removeDbFiles(building);
    if (e instanceof BuildError) {
      return e.reason === 'unknown_seed'
        ? err('unknown_seed', { seed: seedName, available: Object.keys(deps.seeders).sort() })
        : err('seed_failed', { phase: e.phase, reason: e.reason });
    }
    throw e;
  }
  swapInto(building, env.db_path);

  const now = deps.now();
  const updated: Environment = { ...env, last_refresh_at: now, seed: seedName };
  try {
    const written = writeLandscape(
      deps.supportDir,
      { version: 1, environments: { ...file.environments, [name]: updated }, active: file.active },
      { at: now, actor: deps.actor, action: 'env_reset', target: name, outcome: 'reset' },
      file.audit_head,
    );
    return ok({ name, reset: true, seed: seedName, environment: envView(written.environments[name]!, written.active) });
  } catch (e) {
    return integrityError(e);
  }
}

/** `env_delete`: remove a named env's data root and landscape entry (guarded, P8). */
export function envDelete(deps: LandscapeDeps, input: DeleteInput): Result {
  const name = typeof input.name === 'string' ? input.name : '';
  if (name.length === 0) return err('invalid_input', { field: 'name' });
  let file: LandscapeControlFile;
  try {
    file = readOrBootstrap(deps);
  } catch (e) {
    return integrityError(e);
  }
  const env = file.environments[name];
  if (env === undefined) return err('environment_not_found', { name });

  // main is always refused, by guard tier AND by data root (E7, finding #3).
  if (env.guard_tier === 'protected' || canonical(env.db_path) === canonical(deps.mainDbPath)) {
    return err('environment_protected', { name, reason: 'main is protected against deletion' });
  }
  // A standard tier is structural: refuse without force, and point at reset (E9a).
  if (isStandardEnvironment(name) && input.force !== true) {
    return err('standard_tier', { name, hint: 'the three tiers are structural; use reset, or pass force' });
  }
  // The active env cannot be deleted out from under the face (E9b).
  if (name === file.active) {
    return err('environment_active', { name, hint: 'switch away first, then delete' });
  }

  if (input.confirmed !== true) {
    return ok({ staged: true, plan: { name, willRemoveDataRoot: env.db_path } });
  }

  removeDbFiles(env.db_path);
  const remaining: Record<string, Environment> = { ...file.environments };
  delete remaining[name];
  try {
    const written = writeLandscape(
      deps.supportDir,
      { version: 1, environments: remaining, active: file.active },
      { at: deps.now(), actor: deps.actor, action: 'env_delete', target: name, outcome: 'deleted' },
      file.audit_head,
    );
    return ok({ name, deleted: true, count: Object.keys(written.environments).length });
  } catch (e) {
    return integrityError(e);
  }
}

/** Move a gated `.building` file (and its sidecars) over the live path, replacing it atomically. */
function swapInto(building: string, target: string): void {
  removeDbFiles(target);
  renameSync(building, target);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(building + suffix)) renameSync(building + suffix, target + suffix);
  }
}

// Re-exported so a caller (and a test) can read the standard ranks without importing tierRank too.
export { RANK_MAIN, RANK_TEST, RANK_DEVELOP, STANDARD_TIER_RANKS };
