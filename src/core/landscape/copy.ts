/**
 * The COPY + SANITIZE engine (Phase B, D126 section 4). MONEY-PATH ADJACENT: it moves real Swiss
 * client financial data and access secrets across a trust boundary, so it is built to survive an
 * adversarial critic and lands behind one.
 *
 * `env_copy` is a one-way copy source -> target. It REUSES the proven `portability.ts` snapshot/restore
 * (`createBackup` + `restoreBackup`), which already re-mints every surrogate id, re-chains the audit log
 * under the new identity, and gates balance + referential integrity before commit. On top of that it
 * adds the three net-new passes the concept requires:
 *
 *   1. THE SECRET FLOOR (D-ENV-5): `neutralizeSecrets` strips every live access secret from the target
 *      regardless of sanitization level, so a copy can never touch a real bank or move real money. Only
 *      the owner-only `retainSecrets` override (gated in the api layer) lifts it.
 *   2. SANITIZATION (`applySanitization`): raw / pseudonymize / structure_synthetic.
 *   3. CROSS-CHANNEL MIGRATION (finding #6): a copy REFUSES when the source schema generation is newer
 *      than this (target) build, and otherwise the target is rebuilt at the current generation.
 *
 * BUILD-THEN-SWAP (finding #5, matrix E2a): the whole copy is assembled in a `<target>.building` file
 * and the target is only replaced on success, so a failed copy leaves the prior target intact and
 * selectable. The source is NEVER mutated: it is byte-copied to a scratch file first, so the snapshot`s
 * bookkeeping writes land in the throwaway, never in `main`.
 *
 * P8 (finding, section 6): an unconfirmed call returns the exact plan (source, target, scope,
 * sanitization, workspaces affected, secrets action) and changes nothing.
 */

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ok, err, type Result } from '../result.js';
import { SqliteStore } from '../store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../store/schema.js';
import { createBackup, restoreBackup } from '../data/portability.js';
import { writeLandscape, LandscapeIntegrityError } from './controlFile.js';
import { type Environment, type LandscapeControlFile, type Sanitization } from './model.js';
import { canCopyDown, resolveTierRank } from './tierRank.js';
import { applySanitization, workspaceScope } from './sanitize.js';
import { neutralizeSecrets, type NeutralizeSummary } from './secrets.js';
// `readOrBootstrap` is a VALUE import from operations.ts, and operations.ts value-imports this module`s
// copy verbs: a cycle that is safe because every use on both sides is inside a function body (lazy),
// never at module-init time. `LandscapeDeps` is a type-only import (erased at runtime).
import { readOrBootstrap, confineDataRoot, type LandscapeDeps } from './operations.js';

// --- inputs ------------------------------------------------------------------------------------

interface CopyInput {
  source?: unknown;
  target?: unknown;
  scope?: unknown;
  sanitize?: unknown;
  scaleFactor?: unknown;
  retainSecrets?: unknown;
  force?: unknown;
  confirmed?: unknown;
}

interface CreateCopyInput {
  name?: unknown;
  source?: unknown;
  scope?: unknown;
  sanitize?: unknown;
  scaleFactor?: unknown;
  retainSecrets?: unknown;
  codeChannel?: unknown;
  dbPath?: unknown;
  runtimeTarget?: unknown;
  tierRank?: unknown;
  confirmed?: unknown;
}

interface ResetCopyInput {
  name?: unknown;
  force?: unknown;
  confirmed?: unknown;
}

type CopyScope = { kind: 'instance' } | { kind: 'mandate'; workspaceId: string };

const SANITIZE_LEVELS: readonly Sanitization[] = ['raw', 'pseudonymize', 'structure_synthetic'];

// --- small primitives (self-contained so this module has no runtime cycle with operations.ts) ---

class GateError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'GateError';
  }
}

function integrityError(e: unknown): Result {
  if (e instanceof LandscapeIntegrityError) return err('landscape_integrity_failed', { reason: e.reason });
  throw e;
}

/** The raw stored schema generation of a db FILE, without opening a store (which would migrate it). */
function rawSchemaGeneration(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.pragma('user_version', { simple: true }) as number;
  } finally {
    db.close();
  }
}

/** Byte-copy a db file and its WAL/SHM sidecars (best effort on the sidecars). */
function copyDbFiles(src: string, dest: string): void {
  mkdirSync(join(dest, '..'), { recursive: true });
  copyFileSync(src, dest);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(src + suffix)) copyFileSync(src + suffix, dest + suffix);
  }
}

/** Remove a db file and its WAL/SHM sidecars, best effort. */
function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {
      // best effort
    }
  }
}

/** Move a gated `.building` file (and its sidecars) over the live target, replacing it. */
function swapInto(building: string, target: string): void {
  removeDbFiles(target);
  renameSync(building, target);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(building + suffix)) renameSync(building + suffix, target + suffix);
  }
}

/**
 * The invariant gate over the freshly-built target FILE (a fresh readonly connection, so it sees the
 * committed, checkpointed state): referential integrity + every posted entry balances. Throws
 * `GateError` on any violation, so the caller`s build-then-swap can leave the prior target intact.
 */
function gateDbFile(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true });
  try {
    const fk = db.pragma('foreign_key_check') as unknown[];
    if (fk.length > 0) throw new GateError('referential_integrity');
    const entries = db.prepare("SELECT id FROM \"journal_entry\" WHERE status = 'posted'").all() as { id: string }[];
    for (const entry of entries) {
      const sums = db
        .prepare(
          'SELECT COALESCE(SUM(base_debit_minor),0) AS d, COALESCE(SUM(base_credit_minor),0) AS c FROM "journal_line" WHERE entry_id = ?',
        )
        .get(entry.id) as { d: number; c: number };
      if (sums.d !== sums.c) throw new GateError('unbalanced_entry');
    }
  } finally {
    db.close();
  }
}

/**
 * The SHAPE of an immutability / append-only guard trigger: a body that RAISEs ABORT. Every such guard
 * in the schema matches this, whichever module owns it: the journal `posted_immutable` guards
 * (store/schema.ts), `payment_immutable` / `payment_allocation_immutable` (payments), the payment-batch
 * `payment_batch_immutable` / `payment_batch_item_immutable` / `..._status_is_one_way` (banking/pain001),
 * `vendor_bill_immutable`, the asset / inventory / payroll / HR / procurement / migration append-only
 * guards, and any future one. Whitespace between RAISE and `(` is tolerated so a re-formatting never
 * silently drops a guard out of the set.
 *
 * `withImmutabilitySuspended` derives the set from sqlite_master at RUNTIME with this shape, so it is
 * SELF-MAINTAINING: a new immutability trigger anywhere in the schema is covered the moment it exists,
 * with no hardcoded list to drift (the earlier hardcoded 5-journal-trigger list is exactly what let
 * `payment_batch_item_immutable` abort a real-ledger copy). `test/landscape/copy.test.mjs` asserts the
 * derived set is non-empty, covers the payment-batch guards, and is recreated IDENTICALLY on the target.
 */
const IMMUTABILITY_TRIGGER_SHAPE = /RAISE\s*\(\s*ABORT/i;

/** Every trigger in `db` whose body RAISEs ABORT (an immutability / append-only guard), name + its own SQL. */
function immutabilityTriggers(db: Database.Database): { name: string; sql: string }[] {
  return (
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL")
      .all() as { name: string; sql: string }[]
  ).filter((t) => IMMUTABILITY_TRIGGER_SHAPE.test(t.sql));
}

/**
 * Run `fn` with EVERY immutability / append-only guard trigger dropped, then RECREATE them ALL from their
 * own stored SQL. Used only while CONSTRUCTING a sanitized/scaled clone on the throwaway building db, and
 * for the mandate-refresh delete of a prior copy: the transform rewrites masked/scaled values into, and
 * deletes, posted and otherwise-frozen rows (a posted journal line, a payment-batch item with a posted
 * payment, a filed VAT figure, ...), which the live append protection would otherwise ABORT with an
 * opaque unexpected_error. The guards are the SAME class of protection at every table, so ALL of them are
 * suspended, not a hand-picked few. They are restored before the copy`s invariant gate + swap, so the
 * shipped target carries the identical trigger set and stays append-only; a throw inside `fn` still runs
 * the finally (guards recreated) and leaves the building db discarded by the caller`s build-then-swap.
 */
function withImmutabilitySuspended<T>(db: Database.Database, fn: () => T): T {
  const saved = immutabilityTriggers(db);
  for (const t of saved) db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
  try {
    return fn();
  } finally {
    for (const t of saved) db.exec(t.sql);
  }
}

interface PublishResetSummary {
  /** Workspaces whose `sync_publish_state.publishing` was forced to 0 (in scope). */
  readonly workspacesReset: number;
  /** Workspaces whose stream `epoch` was re-minted (those that had a non-null epoch, i.e. a live stream). */
  readonly epochsReminted: number;
}

/**
 * FINDING #2: force the egress publish dial OFF and re-mint the stream epoch on every copied workspace.
 * `sync_publish_state` is workspace-scoped, so `restoreBackup` carries `publishing = 1` and the SAME
 * `epoch` verbatim into the copy: a copied env would be primed to egress the source`s ledger facts under
 * the LIVE epoch. `remintEpoch` (sync/outbox.ts) is a `WorkspaceContext` seam the raw-db copy path cannot
 * reach, so the identical effect is applied here in SQL on the building db, scoped exactly like the
 * secret floor (`wsIds` empty = whole instance; §H-TENANT for a mandate copy). Egress is CONSENT: a copy
 * must never inherit an ON dial, and re-minting the epoch makes any consumer that had been following the
 * source see a fork rather than silently replay mismatched history (the remintEpoch contract).
 */
function resetPublishDial(db: Database.Database, ids: { next(prefix: string): string }, wsIds: readonly string[]): PublishResetSummary {
  const has = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_publish_state'")
    .get();
  if (has === undefined) return { workspacesReset: 0, epochsReminted: 0 };

  const idList = wsIds.length > 0 ? wsIds.map(() => '?').join(', ') : null;
  const whereScope = idList !== null ? ` WHERE workspace_id IN (${idList})` : '';
  const params = idList !== null ? [...wsIds] : [];

  // Re-mint the epoch only where a stream actually exists (epoch not null), mirroring remintEpoch.
  const streams = db
    .prepare(`SELECT workspace_id AS wid FROM sync_publish_state${whereScope}${whereScope ? ' AND' : ' WHERE'} epoch IS NOT NULL`)
    .all(...params) as { wid: string }[];
  const remint = db.prepare('UPDATE sync_publish_state SET epoch = ? WHERE workspace_id = ?');
  for (const s of streams) remint.run(ids.next('epoch'), s.wid);

  // Force publishing OFF unconditionally across the scope (a copy is never primed to egress).
  const off = db.prepare(`UPDATE sync_publish_state SET publishing = 0${whereScope}`).run(...params);

  return { workspacesReset: off.changes, epochsReminted: streams.length };
}

/** Delete a workspace and all of its scoped rows from a building db (for the mandate replace-on-refresh). */
function deleteWorkspace(db: Database.Database, wsId: string): void {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);

  // CAPTURE the victim rowids per table AGAINST THE INTACT DB, before deleting anything. `workspaceScope`
  // can fence a table TRANSITIVELY through a parent (e.g. journal_line via account_id -> account); if we
  // deleted table-by-table in name order, `account` would be emptied before `journal_line`, whose scope
  // subquery would then match nothing and leave orphan lines that fail the commit-time FK check. Snapshot
  // the rowids first so deletion ORDER is irrelevant. No table is WITHOUT ROWID, so rowid is always present.
  const victims: { table: string; rids: number[] }[] = [];
  for (const table of tables) {
    if (table === 'workspace') continue;
    const scope = workspaceScope(db, table, [wsId]);
    if (scope.clause === '1 = 0' || scope.clause === '1 = 1') continue;
    const rids = (
      db.prepare(`SELECT rowid AS rid FROM "${table}" WHERE ${scope.clause}`).all(...scope.params) as { rid: number }[]
    ).map((r) => r.rid);
    if (rids.length > 0) victims.push({ table, rids });
  }

  db.pragma('defer_foreign_keys = ON');
  db.transaction(() => {
    for (const { table, rids } of victims) {
      const del = db.prepare(`DELETE FROM "${table}" WHERE rowid = ?`);
      for (const rid of rids) del.run(rid);
    }
    db.prepare('DELETE FROM "workspace" WHERE id = ?').run(wsId);
  })();
}

// --- the core copy (no control-file write; the callers own that) --------------------------------

interface CopyPlanOpts {
  readonly scope: CopyScope;
  readonly sanitize: Sanitization;
  readonly retainSecrets: boolean;
  readonly scaleFactor?: number | undefined;
  /**
   * The target env`s recorded copy provenance (SOURCE workspace id -> the TARGET workspace id its last
   * copy produced), so a mandate refresh can drop the prior copy BY ID rather than by the maskable name.
   * Empty for a fresh env or a first copy.
   */
  readonly priorProvenance: Readonly<Record<string, string>>;
}

interface CopyRunResult {
  readonly workspacesCopied: number;
  readonly sanitize: ReturnType<typeof applySanitization>;
  readonly secrets: NeutralizeSummary;
  readonly targetSizeBytes: number | null;
  /** SOURCE workspace id -> the TARGET workspace id minted for it THIS run (the fresh provenance). */
  readonly provenance: Readonly<Record<string, string>>;
  /** The publish-dial reset (finding #2): how many copied workspaces had publishing forced off + epoch reminted. */
  readonly publishReset: PublishResetSummary;
}

/**
 * Assemble the target in `<target>.building`, gate it, and swap it into place. Returns a Result: an
 * `err` here means the prior target is untouched (nothing was swapped). The source env`s db is only
 * ever READ (byte-copied to scratch first). `phaseOnError` names where a failure happened, for the
 * four-phase progress the api surfaces.
 */
function runCopy(deps: LandscapeDeps, srcEnv: Environment, tgtEnv: Environment, opts: CopyPlanOpts): Result {
  const ids = deps.ids;
  const clock = deps.clock;
  if (ids === undefined || clock === undefined) {
    // A programming error, not a user one: the api layer always supplies these.
    return err('landscape_copy_unconfigured', { reason: 'copy requires ids and clock deps' });
  }

  mkdirSync(deps.supportDir, { recursive: true });
  const scratch = mkdtempSync(join(deps.supportDir, '.copy-'));
  const srcCopyPath = join(scratch, 'source.db');
  const bundleDir = join(scratch, 'bundles');
  const building = tgtEnv.db_path + '.building';

  let srcStore: SqliteStore | undefined;
  let buildingStore: SqliteStore | undefined;
  let swapped = false;

  try {
    mkdirSync(bundleDir, { recursive: true });

    // PHASE 1 snapshot: byte-copy the source (never mutate it), open a throwaway store over the copy.
    copyDbFiles(srcEnv.db_path, srcCopyPath);
    srcStore = new SqliteStore({ location: srcCopyPath });
    srcStore.checkpoint();

    let sources: { id: string; name: string }[];
    if (opts.scope.kind === 'mandate') {
      const row = srcStore.db.prepare('SELECT id, name FROM "workspace" WHERE id = ?').get(opts.scope.workspaceId) as
        | { id: string; name: string }
        | undefined;
      if (row === undefined) {
        const available = srcStore.db.prepare('SELECT id, name FROM "workspace" ORDER BY rowid').all() as {
          id: string;
          name: string;
        }[];
        return err('mandate_not_found', { workspaceId: opts.scope.workspaceId, available });
      }
      sources = [row];
    } else {
      sources = srcStore.db.prepare('SELECT id, name FROM "workspace" ORDER BY rowid').all() as {
        id: string;
        name: string;
      }[];
    }

    // PHASE 2 restore: prepare the building file. A mandate copy preserves the existing target`s other
    // workspaces (byte-copy the target first); an instance copy builds a fresh target from scratch. The
    // data-root directory may not exist yet (env_create policy=copy provisions a brand-new env), so make it.
    mkdirSync(join(building, '..'), { recursive: true });
    removeDbFiles(building);
    if (opts.scope.kind === 'mandate' && existsSync(tgtEnv.db_path)) {
      copyDbFiles(tgtEnv.db_path, building);
    }
    buildingStore = new SqliteStore({ location: building });
    buildingStore.checkpoint();

    if (opts.scope.kind === 'mandate') {
      // FINDING #1: replace-ON-REFRESH by a STABLE SOURCE-PROVENANCE key, NOT by `workspace.name`.
      // `workspace.name` is a masked PII column (sanitize.ts): under pseudonymize / structure_synthetic
      // a name-match on the refresh finds nothing and `restoreBackup` would APPEND a second copy of the
      // mandate, silently doubling instance-wide totals while the verb still returns ok:true. Instead we
      // look up the prior TARGET workspace id this same SOURCE mandate produced last time (recorded at
      // the host level in the control file) and delete THAT workspace by id. The delete runs with ALL the
      // immutability / append-only guard triggers suspended (finding #1b): a prior copy holds posted
      // journal rows AND other frozen rows (e.g. a payment-batch item with a posted payment, whose
      // `payment_batch_item_no_delete` guard fires on DELETE), and removing them would otherwise throw
      // SQLITE_CONSTRAINT_TRIGGER as an opaque unexpected_error. This is the throwaway building db (ids
      // re-minted, audit re-chained); the guards are restored before the gate + swap, so the shipped
      // target stays append-only.
      const priorTargetWs = opts.priorProvenance[opts.scope.workspaceId];
      if (priorTargetWs !== undefined) {
        const exists = buildingStore.db.prepare('SELECT 1 FROM "workspace" WHERE id = ?').get(priorTargetWs);
        if (exists !== undefined) {
          withImmutabilitySuspended(buildingStore.db, () => deleteWorkspace(buildingStore!.db, priorTargetWs));
        }
      }
    }

    const newWsIds: string[] = [];
    const provenance: Record<string, string> = {};
    let idx = 0;
    for (const ws of sources) {
      const cb = createBackup(
        { store: srcStore, clock, ids, actor: deps.actor, backupDir: bundleDir },
        { workspaceId: ws.id, idempotencyKey: `env-copy-cb-${idx}` },
      );
      if (!cb.ok) return err('copy_snapshot_failed', { workspace: ws.id, cause: cb });
      const rb = restoreBackup(
        { store: buildingStore, clock, ids, actor: deps.actor, backupDir: bundleDir },
        { source: (cb as unknown as { artifactRef: string }).artifactRef, newWorkspaceName: ws.name, confirmed: true },
      );
      if (!rb.ok) return err('copy_restore_failed', { workspace: ws.id, cause: rb });
      const newWsId = (rb as unknown as { workspaceId: string }).workspaceId;
      newWsIds.push(newWsId);
      provenance[ws.id] = newWsId; // SOURCE workspace id -> the TARGET id minted for it this run.
      idx += 1;
    }

    // PHASE 3 sanitize: scope to the copied workspace(s). An instance copy built a fresh target, so
    // every row is a copy and whole-instance scope ([] ) is correct and cheaper; a mandate copy must
    // touch ONLY its new workspace so the target`s other workspaces stay byte-identical (H-TENANT).
    const scopeIds = opts.scope.kind === 'mandate' ? newWsIds : [];
    // The sanitize + secret passes rewrite masked/scaled values into frozen rows: POSTED journal entries,
    // and money-adjacent columns of a payment-batch item with a posted payment (`payment_batch_item.
    // creditor_iban` is a masked PII column and `amount_minor` is scaled by structure_synthetic), which
    // the append-only immutability guards forbid mutating. That protection is about the LIVE ledger`s
    // append path; here we are CONSTRUCTING a transformed clone (ids already re-minted, audit re-chained),
    // so ALL immutability guards are suspended on the throwaway building db for the transform and RESTORED
    // before the swap, and the invariant gate re-foots every posted entry afterwards. A failure in the
    // block still discards the whole building file (build-then-swap), so nothing partial can ship.
    const db = buildingStore.db;
    const { sanitize, secrets } = withImmutabilitySuspended(db, () => {
      const san = applySanitization(db, { level: opts.sanitize, workspaceIds: scopeIds, scaleFactor: opts.scaleFactor });
      let sec: NeutralizeSummary = { columnsProcessed: 0, rowsNeutralized: 0, perColumn: {} };
      if (!opts.retainSecrets) sec = neutralizeSecrets(db, scopeIds);
      return { sanitize: san, secrets: sec };
    });

    // FINDING #2: force the egress publish dial OFF and re-mint the stream epoch on the copied
    // workspace(s), so a copy is never primed to egress the source`s ledger under the LIVE epoch. This
    // touches no money column and no posted row, so it needs no trigger suspension; it runs regardless of
    // sanitization level and regardless of the (owner-only) retainSecrets override, because publishing is
    // an EGRESS capability, not a stored secret: a full-fidelity debug clone must still not egress.
    const publishReset = resetPublishDial(db, ids, scopeIds);

    // PHASE 4 verify: the built payload must be at THIS build`s schema generation (finding #6: a source
    // newer than the target is refused earlier; here we assert the rebuilt target is current), then the
    // invariant gate runs on the checkpointed file, and only a passing build is swapped in.
    const builtGeneration = buildingStore.db.pragma('user_version', { simple: true }) as number;
    buildingStore.checkpoint();
    buildingStore.close();
    buildingStore = undefined;
    srcStore.close();
    srcStore = undefined;

    if (builtGeneration !== SCHEMA_GENERATION) {
      return err('copy_schema_generation_mismatch', { built: builtGeneration, expected: SCHEMA_GENERATION });
    }
    gateDbFile(building); // throws GateError -> caught below

    swapInto(building, tgtEnv.db_path);
    swapped = true;

    const targetSizeBytes = (() => {
      try {
        return statSync(tgtEnv.db_path).size;
      } catch {
        return null;
      }
    })();

    const runResult: CopyRunResult = {
      workspacesCopied: sources.length,
      sanitize,
      secrets,
      targetSizeBytes,
      provenance,
      publishReset,
    };
    return ok({ run: runResult });
  } catch (e) {
    if (e instanceof GateError) {
      return err('copy_gate_failed', { reason: e.reason });
    }
    throw e;
  } finally {
    try {
      buildingStore?.close();
    } catch {
      // best effort
    }
    try {
      srcStore?.close();
    } catch {
      // best effort
    }
    if (!swapped) removeDbFiles(building);
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/** The four named phases (finding #12), surfaced so Phase C`s dialog can show progress. */
function phases(current: 'snapshot' | 'restore' | 'sanitize' | 'verify'): Record<string, unknown> {
  const order = ['snapshot', 'restore', 'sanitize', 'verify'] as const;
  return {
    current,
    steps: order.map((p) => ({ phase: p, status: 'done' as const })),
  };
}

// --- shared validation -------------------------------------------------------------------------

function parseScope(scope: unknown): CopyScope | { error: string } {
  if (scope === undefined || scope === null || scope === 'instance') return { kind: 'instance' };
  if (typeof scope !== 'string') return { error: 'scope' };
  if (scope === 'instance') return { kind: 'instance' };
  if (scope.startsWith('mandate:')) {
    const workspaceId = scope.slice('mandate:'.length);
    if (workspaceId.length === 0) return { error: 'scope' };
    return { kind: 'mandate', workspaceId };
  }
  return { error: 'scope' };
}

function resolveSanitize(sanitize: unknown): Sanitization | undefined {
  // finding #8: an omitted sanitize resolves to the D-ENV-4 default (raw, with the secret floor still
  // applied), and can NEVER silently resolve to a secret-retaining raw.
  if (sanitize === undefined || sanitize === null) return 'raw';
  if (SANITIZE_LEVELS.includes(sanitize as Sanitization)) return sanitize as Sanitization;
  return undefined;
}

/** The secrets action string for a plan / result: neutralized (the floor) or owner-retained. */
function secretsAction(retain: boolean): 'neutralized' | 'retained_owner_override' {
  return retain ? 'retained_owner_override' : 'neutralized';
}

/** Guard the target of a copy: never `main` (by data root AND guard tier), and down-only by tier rank. */
function guardCopyTarget(srcEnv: Environment, tgtEnv: Environment, mainDbPath: string): Result | undefined {
  if (tgtEnv.guard_tier === 'protected' || resolvePath(tgtEnv.db_path) === resolvePath(mainDbPath)) {
    return err('environment_protected', { name: tgtEnv.name, reason: 'main is protected against copy INTO (the landscape law)' });
  }
  if (!canCopyDown(srcEnv.tier_rank, tgtEnv.tier_rank)) {
    return err('copy_not_down', {
      source: srcEnv.name,
      target: tgtEnv.name,
      sourceRank: srcEnv.tier_rank,
      targetRank: tgtEnv.tier_rank,
      reason: 'data flows down only: the source rank must be strictly above the target`s',
    });
  }
  return undefined;
}

function resolvePath(p: string): string {
  return resolve(p);
}

/** The source must exist on disk and not be newer than this build (finding #6). */
function guardSource(srcEnv: Environment): Result | undefined {
  if (!existsSync(srcEnv.db_path)) {
    return err('source_data_missing', { source: srcEnv.name, dbPath: srcEnv.db_path });
  }
  const gen = rawSchemaGeneration(srcEnv.db_path);
  if (gen > SCHEMA_GENERATION) {
    return err('source_schema_newer', {
      source: srcEnv.name,
      sourceGeneration: gen,
      targetGeneration: SCHEMA_GENERATION,
      reason: 'the source was written by a newer code channel than the target; refuse rather than reinterpret',
    });
  }
  return undefined;
}

// --- env_copy ----------------------------------------------------------------------------------

export function envCopy(deps: LandscapeDeps, input: CopyInput): Result {
  const sourceName = typeof input.source === 'string' ? input.source : '';
  const targetName = typeof input.target === 'string' ? input.target : '';
  if (sourceName.length === 0) return err('invalid_input', { field: 'source' });
  if (targetName.length === 0) return err('invalid_input', { field: 'target' });
  if (sourceName === targetName) return err('invalid_input', { field: 'target', reason: 'source and target must differ' });

  const scope = parseScope(input.scope);
  if ('error' in scope) return err('invalid_input', { field: scope.error });
  const sanitize = resolveSanitize(input.sanitize);
  if (sanitize === undefined) return err('invalid_input', { field: 'sanitize', allowed: SANITIZE_LEVELS });
  const retainSecrets = input.retainSecrets === true;
  const scaleFactor = typeof input.scaleFactor === 'number' ? input.scaleFactor : undefined;

  let file: LandscapeControlFile;
  try {
    file = readOrBootstrap(deps);
  } catch (e) {
    return integrityError(e);
  }

  const srcEnv = file.environments[sourceName];
  if (srcEnv === undefined) return err('environment_not_found', { name: sourceName, role: 'source' });
  const tgtEnv = file.environments[targetName];
  if (tgtEnv === undefined) return err('environment_not_found', { name: targetName, role: 'target' });

  const targetGuard = guardCopyTarget(srcEnv, tgtEnv, deps.mainDbPath);
  if (targetGuard !== undefined) return targetGuard;
  const srcGuard = guardSource(srcEnv);
  if (srcGuard !== undefined) return srcGuard;

  // finding #11: a copy INTO the active env requires switching away first, or a forced quiesce.
  if (targetName === file.active && input.force !== true) {
    return err('environment_active', {
      name: targetName,
      hint: 'switch away first, or pass force to quiesce the active environment before the swap',
    });
  }

  const affected = scope.kind === 'mandate' ? 1 : countWorkspaces(srcEnv.db_path);

  // P8: an unconfirmed call returns the exact plan and changes nothing.
  if (input.confirmed !== true) {
    return ok({
      staged: true,
      plan: {
        source: sourceName,
        target: targetName,
        scope: scope.kind === 'mandate' ? `mandate:${scope.workspaceId}` : 'instance',
        sanitize,
        workspacesAffected: affected,
        secrets: secretsAction(retainSecrets),
      },
    });
  }

  const priorProvenance = tgtEnv.copy_provenance ?? {};
  const copied = runCopy(deps, srcEnv, tgtEnv, { scope, sanitize, retainSecrets, scaleFactor, priorProvenance });
  if (!copied.ok) return copied;
  const run = (copied as unknown as { run: CopyRunResult }).run;

  // Record the refresh: the target becomes a copy-policy env sourced from `source` under `sanitize`.
  // A mandate copy MERGES the refreshed mandate`s provenance over the prior map (other mandates keep
  // their recorded target ids); an instance copy rebuilt the whole target, so its map fully REPLACES.
  const now = deps.now();
  const copyProvenance = scope.kind === 'mandate' ? { ...priorProvenance, ...run.provenance } : { ...run.provenance };
  const updated: Environment = {
    ...tgtEnv,
    data_policy: 'copy',
    source_env: sourceName,
    sanitization: sanitize,
    last_refresh_at: now,
    seed: null,
    copy_provenance: copyProvenance,
  };
  try {
    writeLandscape(
      deps.supportDir,
      { version: 1, environments: { ...file.environments, [targetName]: updated }, active: file.active },
      { at: now, actor: deps.actor, action: 'env_copy', target: targetName, outcome: 'copied' },
      file.audit_head,
    );
  } catch (e) {
    return integrityError(e);
  }

  return ok({
    copied: true,
    source: sourceName,
    target: targetName,
    scope: scope.kind === 'mandate' ? `mandate:${scope.workspaceId}` : 'instance',
    sanitize,
    secrets: secretsAction(retainSecrets),
    phases: phases('verify'),
    summary: {
      workspacesCopied: run.workspacesCopied,
      piiCellsMasked: run.sanitize.piiCellsMasked,
      ibansReplaced: run.sanitize.ibansReplaced,
      freeTextRedacted: run.sanitize.freeTextRedacted,
      amountsScaled: run.sanitize.amountsScaled,
      secretColumnsProcessed: run.secrets.columnsProcessed,
      secretRowsNeutralized: run.secrets.rowsNeutralized,
      secretsPerColumn: run.secrets.perColumn,
      publishWorkspacesReset: run.publishReset.workspacesReset,
      publishEpochsReminted: run.publishReset.epochsReminted,
    },
  });
}

// --- env_create policy=copy --------------------------------------------------------------------

export function envCreateCopy(deps: LandscapeDeps, input: CreateCopyInput): Result {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) return err('invalid_input', { field: 'name' });
  if (/[\\/]/.test(name) || name === '.' || name === '..') return err('invalid_input', { field: 'name' });

  const sourceName = typeof input.source === 'string' ? input.source : '';
  if (sourceName.length === 0) return err('invalid_input', { field: 'source', reason: 'policy=copy requires a source' });
  if (sourceName === name) return err('invalid_input', { field: 'source', reason: 'source and target must differ' });

  const scope = parseScope(input.scope);
  if ('error' in scope) return err('invalid_input', { field: scope.error });
  const sanitize = resolveSanitize(input.sanitize);
  if (sanitize === undefined) return err('invalid_input', { field: 'sanitize', allowed: SANITIZE_LEVELS });
  // SECURITY: the owner-only secret-RETAINING override lives ONLY on env_copy, which carries the
  // landscape.retain_secrets A24 sub-gate. env_create policy=copy is gated on landscape.manage (not
  // owner-only), so it must NEVER honour retainSecrets: that would let a non-owner with landscape.manage
  // mint a secret-retaining clone through the create door. Requesting it here is refused outright; the
  // owner path is `env_create` (neutralized) then `env_copy retainSecrets=true`.
  if (input.retainSecrets === true) {
    return err('retain_secrets_not_allowed_on_create', {
      reason: 'the secret-retaining override is owner-only and lives on env_copy; create then copy with retainSecrets',
    });
  }
  const retainSecrets = false;
  const scaleFactor = typeof input.scaleFactor === 'number' ? input.scaleFactor : undefined;

  let file: LandscapeControlFile;
  try {
    file = readOrBootstrap(deps);
  } catch (e) {
    return integrityError(e);
  }
  if (name in file.environments) return err('environment_exists', { name });

  const srcEnv = file.environments[sourceName];
  if (srcEnv === undefined) return err('environment_not_found', { name: sourceName, role: 'source' });

  const tierRank = resolveTierRank(name, input.tierRank);
  if (tierRank === undefined) return err('invalid_input', { field: 'tierRank' });

  const dbPath =
    typeof input.dbPath === 'string' && input.dbPath.trim().length > 0
      ? input.dbPath.trim()
      : join(deps.environmentsRoot, name, 'till.db');

  // DATA ROOT protection (finding #3): never alias main`s volume, never collide with an existing root.
  if (resolvePath(dbPath) === resolvePath(deps.mainDbPath)) {
    return err('data_root_is_main', { dbPath, reason: 'a non-main environment may not point its data root at main`s volume' });
  }
  for (const other of Object.values(file.environments)) {
    if (resolvePath(other.db_path) === resolvePath(dbPath)) {
      return err('data_root_collision', { dbPath, collidesWith: other.name });
    }
  }

  // PATH CONFINEMENT (M01 security review F1, D59 critic): the copy path is confined too. Without this,
  // `env_create policy:'copy' dbPath:<anywhere>` wrote a sanitised copy of `main` onto any host path the
  // process could reach (the critic's F1 bypass). Same fence as the synthetic/live path in `envCreate`.
  const confined = confineDataRoot(dbPath, deps.environmentsRoot, file.environments);
  if ('rejected' in confined) return confined.rejected;
  const resolvedDb = confined.resolvedDb;

  const codeChannel = typeof input.codeChannel === 'string' && input.codeChannel.length > 0 ? input.codeChannel : name;
  const runtimeTarget = input.runtimeTarget === 'served' ? 'served' : 'local';

  // Compose the target env record (not yet persisted) so the down-only + source guards can run.
  const now = deps.now();
  const tgtEnv: Environment = {
    name,
    code_channel: codeChannel,
    db_path: resolvedDb,
    support_dir: join(deps.environmentsRoot, name, 'support'),
    backup_dir: join(deps.environmentsRoot, name, 'backups'),
    data_policy: 'copy',
    source_env: sourceName,
    sanitization: sanitize,
    guard_tier: 'open',
    runtime_target: runtimeTarget,
    tier_rank: tierRank,
    created_at: now,
    last_refresh_at: null,
    seed: null,
  };

  const targetGuard = guardCopyTarget(srcEnv, tgtEnv, deps.mainDbPath);
  if (targetGuard !== undefined) return targetGuard;
  const srcGuard = guardSource(srcEnv);
  if (srcGuard !== undefined) return srcGuard;

  const affected = scope.kind === 'mandate' ? 1 : countWorkspaces(srcEnv.db_path);

  if (input.confirmed !== true) {
    return ok({
      staged: true,
      plan: {
        name,
        policy: 'copy',
        source: sourceName,
        scope: scope.kind === 'mandate' ? `mandate:${scope.workspaceId}` : 'instance',
        sanitize,
        dbPath,
        tierRank,
        runtimeTarget,
        workspacesAffected: affected,
        secrets: secretsAction(retainSecrets),
      },
    });
  }

  const copied = runCopy(deps, srcEnv, tgtEnv, { scope, sanitize, retainSecrets, scaleFactor, priorProvenance: {} });
  if (!copied.ok) return copied;
  const run = (copied as unknown as { run: CopyRunResult }).run;

  // A fresh env has no prior copy: record this run`s provenance (SOURCE ws id -> TARGET ws id) so a
  // later mandate refresh into it dedups by id, not by the maskable name.
  const created: Environment = { ...tgtEnv, last_refresh_at: now, copy_provenance: { ...run.provenance } };
  try {
    writeLandscape(
      deps.supportDir,
      { version: 1, environments: { ...file.environments, [name]: created }, active: file.active },
      { at: now, actor: deps.actor, action: 'env_create', target: name, outcome: 'created' },
      file.audit_head,
    );
  } catch (e) {
    // The data root exists but the record did not persist: remove the orphan so no unregistered root lingers.
    removeDbFiles(dbPath);
    return integrityError(e);
  }

  return ok({
    created: true,
    environment: { name, dataPolicy: 'copy', sourceEnv: sourceName, sanitization: sanitize, dbPath, tierRank, runtimeTarget },
    source: sourceName,
    sanitize,
    secrets: secretsAction(retainSecrets),
    phases: phases('verify'),
    summary: {
      workspacesCopied: run.workspacesCopied,
      piiCellsMasked: run.sanitize.piiCellsMasked,
      ibansReplaced: run.sanitize.ibansReplaced,
      freeTextRedacted: run.sanitize.freeTextRedacted,
      amountsScaled: run.sanitize.amountsScaled,
      secretColumnsProcessed: run.secrets.columnsProcessed,
      secretRowsNeutralized: run.secrets.rowsNeutralized,
    },
  });
}

// --- env_reset of a copy-policy env (re-copy from its recorded source) --------------------------

export function envResetCopy(deps: LandscapeDeps, input: ResetCopyInput): Result {
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
  if (env.data_policy !== 'copy') {
    return err('not_a_copy_environment', { name, dataPolicy: env.data_policy });
  }
  if (env.guard_tier === 'protected' || resolvePath(env.db_path) === resolvePath(deps.mainDbPath)) {
    return err('environment_protected', { name, reason: 'main is protected against reset' });
  }
  if (name === file.active && input.force !== true) {
    return err('environment_active', { name, hint: 'switch away first, or pass force to quiesce' });
  }
  const sourceName = env.source_env;
  if (sourceName === null || sourceName === undefined || file.environments[sourceName] === undefined) {
    return err('copy_source_missing', { name, sourceEnv: sourceName ?? null });
  }
  const srcEnv = file.environments[sourceName];

  const sanitize: Sanitization = (env.sanitization as Sanitization | null) ?? 'raw';
  const scope: CopyScope = { kind: 'instance' };

  const targetGuard = guardCopyTarget(srcEnv, env, deps.mainDbPath);
  if (targetGuard !== undefined) return targetGuard;
  const srcGuard = guardSource(srcEnv);
  if (srcGuard !== undefined) return srcGuard;

  if (input.confirmed !== true) {
    return ok({
      staged: true,
      plan: {
        name,
        dataPolicy: 'copy',
        source: sourceName,
        scope: 'instance',
        sanitize,
        secrets: secretsAction(false),
        willRebuild: true,
      },
    });
  }

  const copied = runCopy(deps, srcEnv, env, { scope, sanitize, retainSecrets: false, priorProvenance: env.copy_provenance ?? {} });
  if (!copied.ok) return copied;
  const run = (copied as unknown as { run: CopyRunResult }).run;

  // A reset is a whole-instance rebuild, so its provenance fully replaces the prior map.
  const now = deps.now();
  const updated: Environment = { ...env, last_refresh_at: now, copy_provenance: { ...run.provenance } };
  try {
    writeLandscape(
      deps.supportDir,
      { version: 1, environments: { ...file.environments, [name]: updated }, active: file.active },
      { at: now, actor: deps.actor, action: 'env_reset', target: name, outcome: 'reset' },
      file.audit_head,
    );
  } catch (e) {
    return integrityError(e);
  }

  return ok({
    name,
    reset: true,
    source: sourceName,
    sanitize,
    phases: phases('verify'),
    summary: { workspacesCopied: run.workspacesCopied, secretRowsNeutralized: run.secrets.rowsNeutralized },
  });
}

// --- helpers -----------------------------------------------------------------------------------

/** Count the workspaces in a source db FILE (read-only), for the plan`s `workspacesAffected`. */
function countWorkspaces(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM "workspace"').get() as { n: number };
    return row.n;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}
