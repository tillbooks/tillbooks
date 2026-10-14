/**
 * G04 data freedom, the portability engine (P1, pure verbs over the store).
 *
 * Six verbs round-trip a WHOLE workspace to and from local, documented artifacts:
 *   - `exportWorkspace`  -> a `.tillexport` bundle (jsonl_bundle): one `<table>.jsonl` per table plus
 *     a `manifest.json` and `FORMAT.md`, a human-readable copy that is NOT a restore source.
 *   - `createBackup`     -> a `.tillbackup` bundle (sqlite_snapshot): a tenant-scoped `data.sqlite`
 *     any SQLite client can open, the byte-perfect artifact `restoreBackup` consumes.
 *   - `listBackups`      -> the `backups` history read model (§H-TENANT).
 *   - `verifyBackup`     -> checksums + schema-version + a balance sanity-check, writing nothing.
 *   - `restoreBackup`    -> composes A00 `createWorkspace` into a BRAND-NEW workspace, re-mints every
 *     surrogate id, re-chains the audit log under the new identity, and re-verifies balance +
 *     referential integrity BEFORE commit; any failure rolls the whole thing back.
 *   - `deleteBackup`     -> removes a local artifact and its registry row (housekeeping only).
 *
 * THREE THINGS ARE LOAD-BEARING and each was a real trap (spec §0a):
 *
 * 1. A `.tillbackup` is a tenant-SCOPED SQLite file built by copying ONE workspace's rows into a
 *    fresh file, never a `VACUUM INTO` of the live multi-tenant database (which would copy every other
 *    tenant's books and break §H-TENANT).
 *
 * 2. Restore RE-MINTS every surrogate id through one consistent map. Preserving literal ids cannot be
 *    collision-free (a restore into a store that still holds the source, or a second restore of one
 *    backup, collides on a global primary key). Money, timestamps and plain text are copied verbatim;
 *    EVERY value that names a re-minted row follows it through ONE chokepoint (`./idRemap.ts`, spec
 *    §0c), whatever the column is called and whether the id is the whole value or sits inside JSON.
 *    The audit chain is VERIFIED at the source and only then re-hashed under the new workspace id (it
 *    is a hash input), reusing `auditHashRow`; a chain that did not verify is carried broken.
 *
 * 3. The invariant gate runs BEFORE commit and any failure THROWS. Returning `{ok:false}` inside a
 *    `store.tx(...)` would COMMIT the partial write (the tx-commit-on-err trap). So the pre-commit
 *    `foreign_key_check` and per-entry balance re-check throw, and the throw is translated to an `err`
 *    Result OUTSIDE the transaction.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { SqliteStore } from '../store/sqlite-store.js';
import type { Clock } from '../clock.js';
import type { IdGen } from '../ids.js';
import { SCHEMA_GENERATION } from '../store/schema.js';
import {
  copySchemaDdl,
  fingerprintMatches,
  isEmptyGap,
  schemaFingerprint,
  schemaShapeOf,
  shapeGap,
  tillTables,
} from '../store/schemaShape.js';
import type { SchemaShape } from '../store/schemaShape.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { createWorkspace } from '../setup/workspace.js';
import type { IdentitySource } from '../access/index.js';
import { auditCanonicalRow, auditHashRow, appendAuditLog, AUDIT_GENESIS_PREV } from '../ledger/auditLog.js';
import { resetPublishDial } from '../sync/publishReset.js';
import { TILL_VERSION } from './catalog.js';
import { RestoreIdMap, AmbiguousReferenceError, CROSS_WORKSPACE_REFERENCE_COLUMNS, columnKey } from './idRemap.js';
import { SCHEMA_NEWER_THAN_RUNTIME, bookGenerationOf, newerGenerationRefusal } from '../store/generation.js';
import { approvalSurvivesRestore, planRowWithoutLink, stepRowWithoutTrial } from '../migration/trialReset.js';

/**
 * What a portability verb is handed. It carries the store and the same `clock`/`ids`/`actor` a
 * `WorkspaceContext` would, plus `backupDir`, the directory artifact bundles are written under
 * (injected so a test never writes into the developer's real `~/.till/`). The api layer builds this
 * from a ctx verb's context or a deps verb's raw deps (`src/api/data-actions.ts`).
 */
export interface PortDeps {
  store: SqliteStore;
  clock: Clock;
  ids: IdGen;
  actor: string;
  backupDir: string;
  /**
   * M01/D111 (security review F2): HOW this request's identity was established (`served_subject` in
   * served mode, absent or `local_client` locally). `restoreBackup` composes `createWorkspace`, and
   * the D111 gate there DENIES a served stranger and SEATS a served member. Before this field was
   * threaded, `loadIntoNewWorkspace` built a `createWorkspace` deps object that DROPPED it, so a served
   * stranger minted an orphan copy of another mandate's books (the exact spam/cross-tenant door D111
   * closed for `create_workspace`). Absent on every local caller, so the single-machine flow is
   * unchanged.
   */
  identitySource?: IdentitySource | undefined;
  /**
   * INTERNAL, env_copy only (`landscape/copy.ts`), never read from MCP or REST input (the api layer
   * builds `PortDeps` field by field, `src/api/data-actions.ts`). A restore CLEARS
   * `migration_plan.testmandant_workspace_id` (the plan's Testmandant, a sibling workspace the copy
   * does not own: `RESTORE_ROW_TRANSFORMS`). An instance copy restores the sibling too and re-points
   * the link at it afterwards (`remapCopiedWorkspaceIds`), so it keeps the link through the restore
   * and sweeps whatever it could not re-point itself.
   */
  keepSiblingTestmandantLinks?: boolean | undefined;
}

/** §H-ENUM single sources for the three `backups` enums (the D0 convention: no CHECK in the DDL). */
export const BACKUP_KINDS: readonly string[] = ['export', 'backup'];
export const BACKUP_FORMATS: readonly string[] = ['jsonl_bundle', 'sqlite_snapshot'];
export const BACKUP_STATUSES: readonly string[] = ['complete', 'failed'];

/**
 * Never carried across the tenant boundary in a scoped snapshot (spec §0a.8b): `user` has no
 * `workspace_id`, and copying the global roster into a single-workspace backup would carry other
 * workspaces' identities with it. A restored workspace is unprovisioned; whoever restores re-establishes
 * access. Workspace-scoped `role_def` IS kept (config, not identity) by NOT being on this list.
 */
const IDENTITY_TABLES: ReadonlySet<string> = new Set(['user', 'workspace_member', 'invite']);

/**
 * Operational / machine-local state, excluded from a snapshot:
 *
 *  - `idempotency` rows are keyed to the source workspace and replaying them in a restored workspace
 *    would return stale results carrying old ids. A restored workspace starts with a clean ledger.
 *  - `backups` is the artifact REGISTRY, and every row's `storage_ref` is a machine-local directory
 *    path to the SOURCE workspace's artifacts. Copying those rows into a restored (or re-backed-up)
 *    workspace would make its history list ANOTHER workspace's files, and a later `deleteBackup` on
 *    such an inherited row would `rmSync` the ORIGINAL artifact directory. A backup's history of prior
 *    backups is not ledger data; the honest state for a fresh workspace is an empty backup history, so
 *    the registry is excluded rather than carried across with dangling, dangerous references.
 */
const OPERATIONAL_TABLES: ReadonlySet<string> = new Set(['idempotency', 'backups']);

/**
 * A35/D103 (critic F7, 18.08.2026): `agent_dial` is EXCLUDED FROM A RESTORE, fail-closed. A dial
 * `auto` row is a standing GRANT of unattended agent execution, made by an attributed human act in
 * ONE workspace; a restore that carried it (still wearing that human's name) into a brand-new
 * tenant would be exactly the bulk, unattributed flip D103 forbids, reachable by the agent seat
 * itself (create_backup + restore_backup are pre-workspace/ungated). A restored workspace therefore
 * starts at `ask` on every capability, and whoever restores re-grants: the same posture as the
 * IDENTITY_TABLES above ("a restored workspace is unprovisioned; whoever restores re-establishes
 * access"), applied to the agent's autonomy. The rows still EXPORT (the bundle is the whole
 * workspace, and G04's data-freedom claim stays true); they are skipped on the way back IN.
 */
const RESTORE_EXCLUDED_TABLES: ReadonlySet<string> = new Set(['agent_dial']);

// --- Schema introspection (works off the live schema, so it never drifts from the DDL) ----------

interface ColumnMeta {
  name: string;
  type: string;
  pk: number;
  notnull: number;
}
interface FkMeta {
  from: string;
  table: string;
  to: string | null;
}

/**
 * Every TILL table of a connection, through the ONE chokepoint (`isTillTable` / `tillTables`): a
 * tool's table inside the file (Litestream's `_litestream_seq` / `_litestream_lock` on the owner's
 * replicated book) is never snapshotted, exported, wiped, loaded or fenced as if it were the book's.
 */
function allTables(db: Database.Database): string[] {
  return tillTables(db);
}

function columnsOf(db: Database.Database, table: string): ColumnMeta[] {
  return (db.pragma(`table_info("${table}")`) as { name: string; type: string; pk: number; notnull: number }[]).map(
    (c) => ({ name: c.name, type: c.type, pk: c.pk, notnull: c.notnull }),
  );
}

function foreignKeysOf(db: Database.Database, table: string): FkMeta[] {
  return (db.pragma(`foreign_key_list("${table}")`) as { from: string; table: string; to: string | null }[]).map(
    (f) => ({ from: f.from, table: f.table, to: f.to }),
  );
}

function hasColumn(cols: ColumnMeta[], name: string): boolean {
  return cols.some((c) => c.name === name);
}

/** A table's single-column TEXT surrogate primary key (`id`), or undefined for a natural/composite key. */
function surrogatePk(cols: ColumnMeta[]): string | undefined {
  const pks = cols.filter((c) => c.pk > 0);
  if (pks.length === 1 && pks[0]?.name === 'id') return 'id';
  return undefined;
}

/**
 * How a table is fenced to one workspace. Most tables carry `workspace_id` directly. A few do not and
 * are scoped through a foreign key: `journal_line` through its `account_id` to `account` (the first NOT
 * NULL foreign key to a scoped table in declaration order, which `scopeInfoFor` prefers; its `entry_id`
 * is held inside the workspace by the restore's foreign-reference gate, `assertReferencesStayInside`),
 * and `migration_map_template` through `created_in_workspace_id` to `workspace`. Scoping journal_line by
 * `workspace_id` would have SILENTLY DROPPED every posted line from the backup (it has no such column),
 * which is exactly the kind of "looks fine, loses money" defect this whole spec exists to prevent.
 */
interface ScopeInfo {
  column: string;
  refTable?: string;
  refPk?: string;
}

function scopeInfoFor(db: Database.Database, table: string): ScopeInfo | undefined {
  if (table === 'workspace') return undefined;
  const cols = columnsOf(db, table);
  if (hasColumn(cols, 'workspace_id')) return { column: 'workspace_id' };
  const fks = foreignKeysOf(db, table);
  const toWorkspace = fks.find((f) => f.table === 'workspace');
  if (toWorkspace !== undefined) return { column: toWorkspace.from };
  // Indirect: fence through a foreign key to a table that is itself workspace-scoped. Prefer a NOT
  // NULL foreign key (a nullable one like `cost_center_id` would drop every row that left it empty).
  const notNull = new Set(cols.filter((c) => c.notnull === 1).map((c) => c.name));
  const candidates = [...fks].sort((a, b) => Number(notNull.has(b.from)) - Number(notNull.has(a.from)));
  for (const fk of candidates) {
    if (fk.table === table) continue; // a self-FK (reverses_entry_id) is not a scoping parent.
    if (scopeInfoFor(db, fk.table) !== undefined) {
      return { column: fk.from, refTable: fk.table, refPk: fk.to ?? 'id' };
    }
  }
  return undefined;
}

/** The WHERE clause + params that select one workspace's rows of `table` (direct or via an FK chain). */
function scopedWhere(db: Database.Database, table: string, wsId: string): { clause: string; params: unknown[] } {
  const info = scopeInfoFor(db, table);
  if (info === undefined) return { clause: '1 = 0', params: [] };
  if (info.refTable === undefined) return { clause: `"${info.column}" = ?`, params: [wsId] };
  const parent = scopedWhere(db, info.refTable, wsId);
  return {
    clause: `"${info.column}" IN (SELECT "${info.refPk}" FROM "${info.refTable}" WHERE ${parent.clause})`,
    params: parent.params,
  };
}

/**
 * The WHERE clause + params selecting one workspace's rows of `table`, direct or through its FK chain:
 * the same scoping backup, restore and wipe use. Exported read-only for the list-free restore gate
 * (`test/data/restore-chokepoint.test.mjs`), which must scan exactly the rows a restore wrote.
 */
export function workspaceRowsWhere(db: Database.Database, table: string, wsId: string): { clause: string; params: unknown[] } {
  return scopedWhere(db, table, wsId);
}

/** The workspace-scoped tables a snapshot copies (directly or through an FK), minus identity/operational. */
function snapshotTables(db: Database.Database): string[] {
  return allTables(db).filter((t) => {
    if (t === 'workspace') return false; // copied specially (the single row, by id)
    if (IDENTITY_TABLES.has(t) || OPERATIONAL_TABLES.has(t)) return false;
    return scopeInfoFor(db, t) !== undefined;
  });
}

/**
 * Load order for a set of tables. The ONE hard constraint is the posted-row immutability trigger
 * `journal_line_no_insert_posted`: it aborts a `journal_line` insert whose parent `journal_entry` is
 * already `posted`. Inserting every `journal_line` BEFORE its `journal_entry` (the parent is absent, so
 * the trigger's status subquery is NULL) sidesteps it; deferred FKs handle every other order.
 */
function loadOrder(tables: string[]): string[] {
  const rest = tables.filter((t) => t !== 'journal_entry');
  return tables.includes('journal_entry') ? [...rest, 'journal_entry'] : rest;
}

// --- Row serialisation (Buffers survive a round-trip and hash stably) ---------------------------

type Row = Record<string, unknown>;

/** A canonical, Buffer-safe JSON of a table's rows, for the per-table manifest sha256. */
function canonicalRows(rows: Row[]): string {
  return JSON.stringify(
    rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(r).sort()) {
        const v = r[key];
        out[key] = Buffer.isBuffer(v) ? { $b64: v.toString('base64') } : v;
      }
      return out;
    }),
  );
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

// --- Snapshot build (a scoped .tillbackup data.sqlite) ------------------------------------------

interface TableManifest {
  [table: string]: { rowCount: number; sha256: string };
}

/**
 * Copy ONE workspace's rows out of the live database into a fresh SQLite file at `destPath`. The
 * destination gets the live BOOK's own schema (`copySchemaDdl`, spec §0c item 6), not the schema this
 * runtime's code would create: a book a NEWER TILL has opened carries columns this runtime does not
 * know, and a snapshot built from this runtime's `SCHEMA_SQL` could not receive them (the copy threw
 * `no column named ...`, critic A31 R2-M1). Rows are inserted with foreign keys off and lines before
 * entries, so a posted ledger loads without tripping the immutability trigger. Returns the per-table
 * manifest and the snapshot's shape.
 */
function writeScopedSqlite(srcDb: Database.Database, srcWsId: string, destPath: string): { tables: TableManifest; shape: SchemaShape } {
  const dest = new Database(destPath);
  try {
    dest.pragma('foreign_keys = OFF');
    copySchemaDdl(srcDb, dest);
    dest.pragma(`user_version = ${SCHEMA_GENERATION}`);
    const manifest: TableManifest = {};

    // The single workspace row.
    const wsRow = srcDb.prepare('SELECT * FROM "workspace" WHERE id = ?').get(srcWsId) as Row | undefined;
    const wsRows = wsRow === undefined ? [] : [wsRow];
    insertRows(dest, 'workspace', columnsOf(srcDb, 'workspace'), wsRows);
    manifest['workspace'] = { rowCount: wsRows.length, sha256: sha256Hex(canonicalRows(wsRows)) };

    for (const table of loadOrder(snapshotTables(srcDb))) {
      const where = scopedWhere(srcDb, table, srcWsId);
      const rows = srcDb.prepare(`SELECT * FROM "${table}" WHERE ${where.clause}`).all(...where.params) as Row[];
      insertRows(dest, table, columnsOf(srcDb, table), rows);
      manifest[table] = { rowCount: rows.length, sha256: sha256Hex(canonicalRows(rows)) };
    }
    return { tables: manifest, shape: schemaShapeOf(dest) };
  } finally {
    dest.close();
  }
}

function insertRows(db: Database.Database, table: string, cols: ColumnMeta[], rows: Row[]): void {
  if (rows.length === 0) return;
  const names = cols.map((c) => c.name);
  const sql = `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names
    .map(() => '?')
    .join(', ')})`;
  const stmt = db.prepare(sql);
  for (const row of rows) stmt.run(...names.map((n) => row[n] ?? null));
}

// --- Manifest (the artifact's self-description) -------------------------------------------------

interface ArtifactManifest {
  format: string;
  kind: string;
  schemaVersion: number;
  tillVersion: string;
  workspaceId: string;
  createdAt: string;
  files: Record<string, { sha256: string; bytes: number }>;
  tables: TableManifest;
  entryCount: number;
  /**
   * The SHAPE the artifact was written from (spec §0c item 6): every table and its columns, and the
   * sha256 of that. Absent on an artifact made before 30.09.2026; `verify_backup` reads the shape of
   * the snapshot FILE either way, so the manifest copy is the record a listing shows.
   */
  schemaShape?: SchemaShape;
  schemaFingerprint?: string;
}

function countEntries(tables: TableManifest): number {
  return tables['journal_entry']?.rowCount ?? 0;
}

// --- Public verbs -------------------------------------------------------------------------------

/**
 * G04.2. Snapshot the workspace into a `.tillbackup` bundle and record a `backups` row. Idempotent per
 * key (a replay returns the first backup's row, never a second file). The artifact is written to a temp
 * directory and renamed into place, so a failed run never leaves a partial bundle at the final path.
 */
export function createBackup(
  deps: PortDeps,
  input: { workspaceId: string; idempotencyKey?: string; planId?: string },
): Result {
  // G18 R1: an optional `planId` links the backup to a Datenübernahme plan so the commit gate's
  // pre-migration-backup leg (seams.ts:hasPreMigrationBackup) can bind to a real row. The plan link
  // is validated BEFORE any artifact is produced, so a cross-workspace or unknown planId REFUSES
  // (§H-TENANT) without ever writing a backup file. Only a backup taken after the plan reached
  // `planned` satisfies the leg; the status filter is applied where `backup_ref` is written.
  if (input.planId !== undefined) {
    if (typeof input.planId !== 'string' || input.planId.length === 0) {
      return err('invalid_input', { field: 'planId' });
    }
    const plan = deps.store.db
      .prepare('SELECT id FROM migration_plan WHERE id = ? AND workspace_id = ?')
      .get(input.planId, input.workspaceId) as { id: string } | undefined;
    if (plan === undefined) return err('not_found', { planId: input.planId });
  }
  return withKey(deps, input.workspaceId, input.idempotencyKey, 'create_backup', () =>
    produceArtifact(deps, input.workspaceId, 'backup', undefined, input.planId),
  );
}

/**
 * G04.1. Export the workspace into a `.tillexport` bundle (one JSONL file per table + a copy of every
 * document blob + manifest + FORMAT.md), a human-readable, tool-neutral copy that is deliberately NOT a
 * restore source. Idempotent per key.
 */
export function exportWorkspace(
  deps: PortDeps,
  input: { workspaceId: string; scope?: string[]; idempotencyKey?: string },
): Result {
  return withKey(deps, input.workspaceId, input.idempotencyKey, 'export_workspace', () =>
    produceArtifact(deps, input.workspaceId, 'export', input.scope),
  );
}

/**
 * Run `compute` once per `(workspaceId, key)`; a key is required on both write verbs, so it is always set.
 *
 * IN A DEFERRED TRANSACTION (`snapshotTx`, critic R2-1). Every other verb's transaction takes the
 * write lock in its BEGIN; these two read the whole workspace first (seconds on a large book), and
 * holding the lock for that long would make the D12 second writer's posts wait out the backup. The
 * marker is still the first read, so the snapshot is one this build knows. What that costs is stated
 * on `snapshotTx`: a commit by the other process during the read makes the final write fail at once as
 * the retryable `store_busy`.
 *
 * NO BUNDLE WITHOUT ITS ROW (critic R1 F2). `produceArtifact` publishes the bundle (the rename) inside
 * the transaction that records its `backups` row. When that transaction does not commit after
 * `compute` returned (a failed COMMIT), the published bundle is removed here, so the directory
 * `list_restorable_backups` scans never offers a bundle no row describes. A failure INSIDE `compute`
 * after the rename (the row's INSERT meeting SQLITE_BUSY_SNAPSHOT) is cleaned by `produceArtifact`.
 */
function withKey(deps: PortDeps, workspaceId: string, key: string | undefined, verb: string, compute: () => Result): Result {
  if (typeof key !== 'string' || key.length === 0) return err('invalid_input', { field: 'idempotencyKey' });
  let published: string | undefined;
  try {
    // `rememberIdempotent`'s own `tx` runs as a savepoint inside the deferred snapshot.
    return deps.store.snapshotTx(() =>
      deps.store.rememberIdempotent(workspaceId, key, verb, () => {
        const produced = compute();
        if (produced.ok && typeof produced.artifactRef === 'string') published = produced.artifactRef;
        return produced;
      }),
    );
  } catch (e) {
    if (published !== undefined) rmSync(published, { recursive: true, force: true });
    throw e;
  }
}

/**
 * The shared producer for both artifact kinds. Builds the bundle in a temp directory, hashes what it
 * wrote, re-reads and re-hashes to catch a disk fault (spec US-G04.2 error path), renames into place,
 * and records the `backups` row. An unwritable destination degrades to `export_destination_unwritable`.
 */
function produceArtifact(deps: PortDeps, workspaceId: string, kind: 'backup' | 'export', scope?: string[], planId?: string): Result {
  const backupId = deps.ids.next(kind);
  const createdAt = deps.clock.now();
  const format = kind === 'backup' ? 'sqlite_snapshot' : 'jsonl_bundle';
  const suffix = kind === 'backup' ? '.tillbackup' : '.tillexport';
  const finalDir = join(deps.backupDir, `${backupId}${suffix}`);

  let tmpDir: string;
  let published = false;
  try {
    mkdirSync(deps.backupDir, { recursive: true });
    tmpDir = mkdtempSync(join(deps.backupDir, '.tmp-'));
  } catch (e) {
    return err('export_destination_unwritable', { message: e instanceof Error ? e.message : String(e) });
  }

  try {
    const files: Record<string, { sha256: string; bytes: number }> = {};
    let tables: TableManifest;
    let topHash: string;
    let byteSize: number;
    // An export describes the live book's shape; a backup the shape of the snapshot it wrote (the same
    // DDL, `copySchemaDdl`).
    let shape: SchemaShape = schemaShapeOf(deps.store.db);

    if (kind === 'backup') {
      const sqlitePath = join(tmpDir, 'data.sqlite');
      const snapshot = writeScopedSqlite(deps.store.db, workspaceId, sqlitePath);
      tables = snapshot.tables;
      shape = snapshot.shape;
      const bytes = readFileSync(sqlitePath);
      // Re-hash what was actually written (spec: catch a disk fault before recording `complete`).
      const written = statSync(sqlitePath).size;
      topHash = sha256Hex(bytes);
      byteSize = written;
      files['data.sqlite'] = { sha256: topHash, bytes: written };
    } else {
      const result = writeJsonlBundle(deps.store.db, workspaceId, tmpDir, scope);
      tables = result.tables;
      files['__manifest_files__'] = { sha256: '', bytes: 0 }; // placeholder, replaced below
      delete files['__manifest_files__'];
      Object.assign(files, result.files);
      byteSize = Object.values(result.files).reduce((n, f) => n + f.bytes, 0);
      // The export's top hash binds every jsonl file together (there is no single data.sqlite).
      topHash = sha256Hex(
        Object.keys(result.files)
          .sort()
          .map((name) => `${name}:${result.files[name]?.sha256 ?? ''}`)
          .join('\n'),
      );
    }

    const manifest: ArtifactManifest = {
      format,
      kind,
      schemaVersion: SCHEMA_GENERATION,
      tillVersion: TILL_VERSION,
      workspaceId,
      createdAt,
      files,
      tables,
      entryCount: countEntries(tables),
      schemaShape: shape,
      schemaFingerprint: schemaFingerprint(shape),
    };
    writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(tmpDir, 'FORMAT.md'), formatDoc(kind, manifest));

    // Atomic publish: rename the fully-built temp bundle onto the final path.
    renameSync(tmpDir, finalDir);
    published = true;

    deps.store.db
      .prepare(
        `INSERT INTO backups
           (id, workspace_id, kind, format, storage_ref, sha256, byte_size, schema_version, till_version, table_manifest, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?)`,
      )
      .run(
        backupId,
        workspaceId,
        kind,
        format,
        finalDir,
        topHash,
        byteSize,
        SCHEMA_GENERATION,
        TILL_VERSION,
        JSON.stringify(tables),
        deps.actor,
        createdAt,
      );

    // G18 R1: link the backup to the plan. Only a plan that has reached `planned` (or beyond, but
    // not `closed`/`abandoned`) accepts the link: a backup taken while the plan is still `draft`
    // does NOT satisfy the pre-migration-backup gate (the specced since-`planned` condition), so its
    // `backup_ref` stays null and the gate remains honestly unsatisfied. `backup_ref` records the
    // backup id, its top-level sha256 and when it was taken, which is what `hasPreMigrationBackup`
    // reads. §H-TENANT: the plan was already proven to be in this workspace by `createBackup`.
    let planLink: { planId: string; linked: boolean; reason?: string } | undefined;
    if (kind === 'backup' && planId !== undefined) {
      const plan = deps.store.db
        .prepare('SELECT id, status FROM migration_plan WHERE id = ? AND workspace_id = ?')
        .get(planId, workspaceId) as { id: string; status: string } | undefined;
      if (plan === undefined) {
        planLink = { planId, linked: false, reason: 'plan_not_found' };
      } else if (plan.status === 'draft' || plan.status === 'closed' || plan.status === 'abandoned') {
        planLink = { planId, linked: false, reason: 'plan_not_planned' };
      } else {
        deps.store.db
          .prepare('UPDATE migration_plan SET backup_ref = ? WHERE id = ? AND workspace_id = ?')
          .run(JSON.stringify({ backupId, sha256: topHash, createdAt }), planId, workspaceId);
        planLink = { planId, linked: true };
      }
    }

    return ok({
      backupId,
      artifactRef: finalDir,
      kind,
      format,
      status: 'complete',
      manifest,
      ...(planLink === undefined ? {} : { planLink }),
    });
  } catch (e) {
    // Clean up the temp bundle; the row was never written, so nothing partial persists. A failure
    // AFTER the rename (the row's INSERT refused, e.g. SQLITE_BUSY_SNAPSHOT because a newer TILL
    // committed meanwhile, critic R1 F2) must not leave the published bundle either. Only a bundle
    // THIS call published is removed: when the rename itself failed because `finalDir` already exists
    // (an id collision, which only a sequence-id test book can produce), that directory is another
    // artifact's, and deleting it would destroy a backup (found by the cross-runtime measurement).
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      if (published) rmSync(finalDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    const message = e instanceof Error ? e.message : String(e);
    if (isFsError(e)) return err('export_destination_unwritable', { message });
    throw e;
  }
}

function isFsError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && ['EACCES', 'ENOSPC', 'EROFS', 'ENOENT', 'EPERM'].includes(code);
}

/**
 * Write a `.tillexport` jsonl_bundle: one `<table>.jsonl` per table, plus a `documents/<sha256>.<bin>`
 * copy of every blob for external readability. `scope`, when given, narrows WHICH tables are written; it
 * never narrows how faithfully each row is copied (spec §6b Fixed).
 */
function writeJsonlBundle(
  srcDb: Database.Database,
  srcWsId: string,
  destDir: string,
  scope?: string[],
): { files: Record<string, { sha256: string; bytes: number }>; tables: TableManifest } {
  const files: Record<string, { sha256: string; bytes: number }> = {};
  const tables: TableManifest = {};
  const scopeSet = scope && scope.length > 0 ? new Set(scope) : undefined;

  const write = (table: string, rows: Row[]): void => {
    if (scopeSet !== undefined && !scopeSet.has(table)) return;
    const lines = rows
      .map((r) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(r)) {
          const v = r[key];
          out[key] = Buffer.isBuffer(v) ? { $b64: v.toString('base64') } : v;
        }
        return JSON.stringify(out);
      })
      .join('\n');
    const body = lines.length > 0 ? `${lines}\n` : '';
    const name = `${table}.jsonl`;
    writeFileSync(join(destDir, name), body);
    files[name] = { sha256: sha256Hex(body), bytes: Buffer.byteLength(body) };
    tables[table] = { rowCount: rows.length, sha256: sha256Hex(canonicalRows(rows)) };
  };

  write('workspace', srcDb.prepare('SELECT * FROM "workspace" WHERE id = ?').all(srcWsId) as Row[]);
  for (const table of snapshotTables(srcDb)) {
    const where = scopedWhere(srcDb, table, srcWsId);
    write(table, srcDb.prepare(`SELECT * FROM "${table}" WHERE ${where.clause}`).all(...where.params) as Row[]);
  }

  // A documents/ folder for external readers: the authoritative copy is still the stored_file_blob row
  // above, so this is a convenience, not the restore source (spec §0a.1).
  const blobs = srcDb
    .prepare('SELECT sha256, content FROM "stored_file_blob" WHERE workspace_id = ?')
    .all(srcWsId) as { sha256: string; content: Buffer }[];
  if (blobs.length > 0) {
    mkdirSync(join(destDir, 'documents'), { recursive: true });
    for (const blob of blobs) {
      writeFileSync(join(destDir, 'documents', `${blob.sha256}.bin`), blob.content);
    }
  }
  return { files, tables };
}

/**
 * G04.2 read model. This workspace's artifacts, newest first, with the fields a history list shows.
 */
export function listBackups(
  deps: PortDeps,
  input: { workspaceId: string; kind?: string; status?: string },
): Result {
  // Optional filters (a G00 saved preset resolves to these at the api boundary, spec §6b). Both are
  // exact-match over the registry columns; an unknown value simply lists nothing rather than erroring.
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [input.workspaceId];
  if (typeof input.kind === 'string' && input.kind.length > 0) {
    clauses.push('kind = ?');
    params.push(input.kind);
  }
  if (typeof input.status === 'string' && input.status.length > 0) {
    clauses.push('status = ?');
    params.push(input.status);
  }
  const rows = deps.store.db
    .prepare(
      `SELECT id, kind, format, storage_ref, sha256, byte_size, schema_version, till_version, status, created_by, created_at
         FROM backups WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, rowid DESC`,
    )
    .all(...params) as {
    id: string;
    kind: string;
    format: string;
    storage_ref: string;
    sha256: string;
    byte_size: number;
    schema_version: number;
    till_version: string;
    status: string;
    created_by: string | null;
    created_at: string;
  }[];
  const backups = rows.map((r) => ({
    backupId: r.id,
    kind: r.kind,
    format: r.format,
    artifactRef: r.storage_ref,
    sha256: r.sha256,
    byteSize: r.byte_size,
    schemaVersion: r.schema_version,
    tillVersion: r.till_version,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
  return ok({ backups });
}

/**
 * G04.3. Check a `.tillbackup`/`.tillexport` bundle without writing anything: per-file checksums, an
 * EXACT schema-version match (spec §0a.6), and a per-entry balance sanity-check. `source` is a bundle
 * directory path.
 */
export function verifyBackup(deps: PortDeps, input: { source: string }): Result {
  const source = String(input.source ?? '');
  if (source.length === 0 || !existsSync(source)) return err('backup_corrupt', { reason: 'source_missing' });
  const manifestPath = join(source, 'manifest.json');
  if (!existsSync(manifestPath)) return err('backup_corrupt', { reason: 'manifest_missing' });

  let manifest: ArtifactManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ArtifactManifest;
  } catch {
    return err('backup_corrupt', { reason: 'manifest_unreadable' });
  }

  if (manifest.schemaVersion !== SCHEMA_GENERATION) {
    return err('incompatible_schema_version', {
      artifactSchemaVersion: manifest.schemaVersion,
      currentSchemaVersion: SCHEMA_GENERATION,
    });
  }

  // Every file the manifest names must re-hash to the recorded value.
  for (const [name, meta] of Object.entries(manifest.files)) {
    const filePath = join(source, name);
    if (!existsSync(filePath)) return err('backup_corrupt', { reason: 'file_missing', file: name });
    if (sha256Hex(readFileSync(filePath)) !== meta.sha256) {
      return err('backup_corrupt', { reason: 'checksum_mismatch', file: name });
    }
  }

  // A balance sanity-check, read-only. For a sqlite_snapshot open data.sqlite and re-foot every posted
  // entry; a jsonl_bundle reports the manifest's entry count without opening a queryable ledger.
  let entryCount = manifest.entryCount;
  let balanceOk = true;
  let fingerprint: string | undefined;
  if (manifest.format === 'sqlite_snapshot') {
    const sqlitePath = join(source, 'data.sqlite');
    const snap = new Database(sqlitePath, { readonly: true });
    try {
      // The snapshot FILE's own generation, not only the manifest's claim about it, is held to the
      // same EXACT match (spec §0a.6, critic R1 F6) before a single row is read or restored: a
      // snapshot a newer TILL wrote is the named refusal (`../store/generation.ts`); an older one
      // under a manifest that claims the current generation would load unmigrated rows.
      const snapshotGeneration = bookGenerationOf(snap);
      const newer = newerGenerationRefusal(snapshotGeneration, sqlitePath);
      if (newer !== null) return err(SCHEMA_NEWER_THAN_RUNTIME, { ...newer });
      if (snapshotGeneration !== SCHEMA_GENERATION) {
        return err('incompatible_schema_version', {
          artifactSchemaVersion: snapshotGeneration,
          currentSchemaVersion: SCHEMA_GENERATION,
          reason: 'snapshot_generation_mismatch',
        });
      }
      // The SHAPE, read from the snapshot FILE (spec §0c item 6): every table and column it holds
      // needs a place in the book a restore would load it into, or the load dies half-way with a raw
      // SQLITE_ERROR. The generation does not catch this: an additive column does not move it.
      // TILL's tables only (`isTillTable`): a tool's table the file may carry (a backup taken from a
      // Litestream book before the chokepoint existed) is not a table this book must hold. Such a
      // backup's manifest fingerprinted the whole file, tool tables included, and `fingerprintMatches`
      // accepts that too; what verify REPORTS is the TILL shape's fingerprint, the comparable form.
      const snapShape = schemaShapeOf(snap);
      fingerprint = schemaFingerprint(snapShape);
      if (manifest.schemaFingerprint !== undefined && !fingerprintMatches(manifest.schemaFingerprint, snap)) {
        return err('backup_corrupt', { reason: 'schema_fingerprint_mismatch' });
      }
      const gap = shapeGap(schemaShapeOf(deps.store.db), snapShape);
      if (!isEmptyGap(gap)) return err(SCHEMA_NEWER_THAN_RUNTIME, shapeNewerRefusal(gap, sqlitePath, manifest, fingerprint, deps.store.db));
      const check = footPostedEntries(snap);
      entryCount = check.entryCount;
      balanceOk = check.balanceOk;
    } finally {
      snap.close();
    }
  }

  return ok({
    schemaVersion: manifest.schemaVersion,
    tillVersion: manifest.tillVersion,
    entryCount,
    balanceOk,
    format: manifest.format,
    ...(fingerprint === undefined ? {} : { schemaFingerprint: fingerprint }),
  });
}

/**
 * The refusal for a snapshot whose SHAPE this installation cannot hold (spec §0c item 6). It rides the
 * existing `schema_newer_than_runtime` code on purpose: that is the code every face already names for
 * "a database file newer than the runtime opening it", the Studio already words it ("update TILL, the
 * file was not changed"), and the remedy is the same. `reason` tells it apart from a generation
 * refusal, and the payload names every table and column that has no place here.
 */
function shapeNewerRefusal(
  gap: { tables: readonly string[]; columns: readonly string[] },
  path: string,
  manifest: ArtifactManifest,
  backupFingerprint: string,
  target: Database.Database,
): Record<string, unknown> {
  const missing = [...gap.tables.map((t) => `table ${t}`), ...gap.columns.map((c) => `column ${c}`)];
  const listed = missing.length > 6 ? `${missing.slice(0, 6).join(', ')} and ${missing.length - 6} more` : missing.join(', ');
  return {
    reason: 'schema_shape_newer',
    bookGeneration: SCHEMA_GENERATION,
    buildGeneration: SCHEMA_GENERATION,
    path,
    partial: false,
    completed: false,
    unknownTables: gap.tables,
    unknownColumns: gap.columns,
    backupTillVersion: manifest.tillVersion,
    backupSchemaFingerprint: backupFingerprint,
    runtimeSchemaFingerprint: schemaFingerprint(schemaShapeOf(target)),
    message:
      `This backup was made by a newer TILL: it holds ${listed}, which this TILL does not know. ` +
      `Update TILL to restore it; a backup taken before that update restores here. The backup was not changed: ${path}`,
  };
}

/** Σbase_debit == Σbase_credit per POSTED entry. Returns the count and whether every entry balances. */
function footPostedEntries(db: Database.Database): { entryCount: number; balanceOk: boolean } {
  const entries = db.prepare("SELECT id FROM \"journal_entry\" WHERE status = 'posted'").all() as { id: string }[];
  for (const entry of entries) {
    const sums = db
      .prepare(
        'SELECT COALESCE(SUM(base_debit_minor),0) AS d, COALESCE(SUM(base_credit_minor),0) AS c FROM "journal_line" WHERE entry_id = ?',
      )
      .get(entry.id) as { d: number; c: number };
    if (sums.d !== sums.c) return { entryCount: entries.length, balanceOk: false };
  }
  return { entryCount: entries.length, balanceOk: true };
}

/**
 * G04.3. Restore a `.tillbackup` into a BRAND-NEW workspace. Agent-staged (P8): without `confirmed`, it
 * returns a plan and writes nothing. With `confirmed`, it composes `createWorkspace`, re-mints every id,
 * re-chains the audit log, and re-verifies balance + referential integrity before commit; any failure
 * rolls the whole transaction back and the new workspace never existed.
 */
export function restoreBackup(
  deps: PortDeps,
  input: { source: string; newWorkspaceName: string; confirmed?: boolean; idempotencyKey?: string },
): Result {
  const source = String(input.source ?? '');
  const name = String(input.newWorkspaceName ?? '');
  if (name.trim().length === 0) return err('invalid_input', { field: 'newWorkspaceName' });

  // Pre-flight, all read-only and OUTSIDE any transaction, so a rejection here writes nothing.
  const verified = verifyBackup(deps, { source });
  // backup_corrupt / incompatible_schema_version / schema_newer_than_runtime pass straight through.
  if (!verified.ok) return verified;
  if ((verified as { format?: string }).format !== 'sqlite_snapshot') {
    // A .tillexport optimises for external readability, not reconstruction (spec §0a.5 / §6b Fixed).
    return err('restore_source_not_backup', { format: (verified as { format?: string }).format });
  }

  // P8: an unconfirmed restore returns a plan and writes nothing (minting a workspace is a human act).
  if (input.confirmed !== true) {
    return ok({
      staged: true,
      plan: {
        newWorkspaceName: name,
        entryCount: (verified as { entryCount?: number }).entryCount ?? 0,
        schemaVersion: (verified as { schemaVersion?: number }).schemaVersion ?? SCHEMA_GENERATION,
        tillVersion: (verified as { tillVersion?: string }).tillVersion ?? TILL_VERSION,
      },
    });
  }

  const doRestore = (): Result => loadIntoNewWorkspace(deps, source, name);
  try {
    if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
      return deps.store.rememberIdempotent('_system', input.idempotencyKey, 'restore_backup', doRestore);
    }
    return deps.store.tx(doRestore);
  } catch (e) {
    // The pre-commit invariant gate throws to roll the transaction back; translate it OUTSIDE the tx.
    if (e instanceof RestoreInvariantError) return err('restore_invariant_failed', { ...e.detail, reason: e.reason });
    // A constraint the load broke (a global UNIQUE natural key the restore did not foresee) rolled the
    // whole transaction back; say so cleanly instead of escaping as an unexpected error.
    if (isConstraintError(e)) {
      return err('restore_invariant_failed', { reason: 'constraint_violation', message: e instanceof Error ? e.message : String(e) });
    }
    throw e;
  }
}

/** A SQLite constraint failure (`SQLITE_CONSTRAINT_*`) thrown by the driver. */
function isConstraintError(e: unknown): boolean {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

class RestoreInvariantError extends Error {
  constructor(
    readonly reason: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(reason);
    this.name = 'RestoreInvariantError';
  }
}

/**
 * The transactional core of restore. Composes `createWorkspace`, wipes the seeded scaffold, loads the
 * snapshot with every surrogate id re-minted and every reference sent through the id chokepoint
 * (`./idRemap.ts`, spec §0c), carries the audit chain (verified, then re-sealed), and runs the
 * invariant gate. It runs inside `store.tx` (via `rememberIdempotent` or directly), so it THROWS on an
 * invariant failure to roll everything back, and never returns `{ok:false}` after a write.
 */
function loadIntoNewWorkspace(deps: PortDeps, source: string, newWorkspaceName: string): Result {
  const db = deps.store.db;
  const snap = new Database(join(source, 'data.sqlite'), { readonly: true });
  try {
    // 1. Compose A00 createWorkspace (NO idempotency key: this function owns the outer idempotency).
    //    M01/D111 (security review F2): thread `identitySource` so the D111 served-mode gate FIRES.
    //    A served stranger is DENIED here (createWorkspace returns permission_denied, which this
    //    function returns straight through, minting nothing); a served member is SEATED as the owner
    //    of the restored copy (the F6 seating), instead of the orphan an unthreaded deps produced. A
    //    local caller leaves it absent and is unaffected.
    const created = createWorkspace(
      { store: deps.store, clock: deps.clock, ids: deps.ids, actor: deps.actor, identitySource: deps.identitySource },
      { name: newWorkspaceName },
    );
    if (!created.ok) return created; // createWorkspace rejected before any G04 write; safe to return.
    const newWsId = (created as unknown as { workspaceId: string }).workspaceId;

    // 2. Defer FK enforcement to commit, so lines can load before entries and the wipe order is free.
    db.pragma('defer_foreign_keys = ON');

    // 3. Wipe the seeded scaffold wholesale (chart, genesis audit, audit_head) for the new workspace.
    //    journal_line first (before its parent entries), so a seeded posted entry (there are none on a
    //    fresh workspace, but be safe) could not trip the delete trigger.
    for (const table of loadOrder(snapshotTables(db))) {
      const where = scopedWhere(db, table, newWsId);
      db.prepare(`DELETE FROM "${table}" WHERE ${where.clause}`).run(...where.params);
    }

    const srcWsId = (snap.prepare('SELECT id FROM "workspace"').get() as { id: string } | undefined)?.id;
    if (srcWsId === undefined) throw new RestoreInvariantError('snapshot_missing_workspace');

    // 4. Pass one: mint a fresh id for every surrogate primary key across every loaded table and for
    //    every audit row, into the per-table maps (declared foreign keys resolve through these) AND the
    //    one chokepoint map every other reference resolves through (spec §0c item 2).
    const loaded = restoreLoadTables(snap);
    const idMap = new Map<string, Map<string, string>>();
    const remap = new RestoreIdMap();
    remap.add('workspace', srcWsId, newWsId);
    for (const table of [...loaded, AUDIT_TABLE]) {
      const pk = surrogatePk(columnsOf(snap, table));
      if (pk === undefined) continue;
      const where = scopedWhere(snap, table, srcWsId);
      const map = new Map<string, string>();
      const rows = snap.prepare(`SELECT "${pk}" AS id FROM "${table}" WHERE ${where.clause}`).all(...where.params) as { id: string }[];
      for (const r of rows) {
        const minted = mintRestoredId(deps.ids, table, String(r.id), srcWsId, newWsId);
        map.set(String(r.id), minted);
        remap.add(table, String(r.id), minted);
      }
      idMap.set(table, map);
    }

    // 5. Update the new workspace row from the snapshot (keeping the caller's chosen name).
    updateWorkspaceRow(db, snap, srcWsId, newWsId, remap);

    // 6. Pass two: load every scoped row with ids/FKs/workspace_id remapped and every other value sent
    //    through the chokepoint.
    const rowCtx: RestoreRowContext = { now: deps.clock.now(), keepSiblingLinks: deps.keepSiblingTestmandantLinks === true };
    for (const table of loaded) {
      loadTable(db, snap, table, srcWsId, newWsId, idMap, remap, rowCtx);
    }
    // 6a. D161.2: no portal link comes back live (see `portalGrantsAwaitHandover`). The count rides
    //     the result (critic F2), so the person learns that links wait for them instead of finding out
    //     from a customer whose link stopped working.
    const portalLinksAwaitingHandover = portalGrantsAwaitHandover(db, newWsId, rowCtx.now);

    // 6b. The copy never inherits an ON egress dial nor the source's stream epoch (critic R1-M2): the
    //     same rule env_copy applies to its copies (`sync/publishReset.ts` `resetPublishDial`), here in the
    //     restore's own transaction. Egress is consent, and a fresh epoch makes the fork a consumer was
    //     following VISIBLE (`sync/outbox.ts` `remintEpoch`, the seam this restore is named in).
    resetPublishDial(db, deps.ids, [newWsId]);

    // 7. Carry the audit chain: verify it at the source, re-seal it under the new identity only if it
    //    verified, carry the break otherwise (spec §0c item 4).
    const auditChain = carryAuditChain(db, snap, srcWsId, newWsId, idMap.get(AUDIT_TABLE) ?? new Map(), remap);

    // 8. The invariant gate, BEFORE commit. Any failure THROWS to roll the whole restore back.
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) throw new RestoreInvariantError('referential_integrity');
    // `foreign_key_check` is satisfied by ANY row with the id, another workspace's included. THE
    // TENANT FENCE is at the chokepoint (critic R2-M2): every minted-shape value the chokepoint met in
    // a reference position and left unmapped, whatever column it sits in, must not name a row of
    // another workspace. The declared-FK check (critic R1-M3) stays behind it as a second line.
    assertUnmappedStayInside(db, remap, newWsId, srcWsId, loaded);
    assertReferencesStayInside(db, loaded, newWsId);
    for (const entry of db
      .prepare("SELECT id FROM \"journal_entry\" WHERE workspace_id = ? AND status = 'posted'")
      .all(newWsId) as { id: string }[]) {
      const sums = db
        .prepare(
          'SELECT COALESCE(SUM(base_debit_minor),0) AS d, COALESCE(SUM(base_credit_minor),0) AS c FROM "journal_line" WHERE entry_id = ?',
        )
        .get(entry.id) as { d: number; c: number };
      if (sums.d !== sums.c) throw new RestoreInvariantError('unbalanced_entry');
    }

    // 9. The restore is itself on record in the copy's chain (critic R1-L1), appended AFTER the carried
    //    rows through the one append path, so a verified copy still verifies and a broken one stays broken.
    recordRestoreInChain(deps, newWsId, auditChain);

    return ok({ workspaceId: newWsId, auditChain, portalLinksAwaitingHandover });
  } catch (e) {
    // A value the chokepoint cannot resolve without guessing refuses the whole restore (spec §0c).
    if (e instanceof AmbiguousReferenceError) {
      throw new RestoreInvariantError('ambiguous_reference');
    }
    throw e;
  } finally {
    snap.close();
  }
}

/** The audit log: loaded by `carryAuditChain`, never by the generic `loadTable`. */
const AUDIT_TABLE = 'audit_log';

/**
 * The foreign-reference gate (critic R1-M3). A declared foreign key the per-table maps do not resolve
 * falls through the chokepoint and lands VERBATIM, and `PRAGMA foreign_key_check` accepts any row with
 * that id, including one of ANOTHER workspace of this book. A hand-edited backup (the manifest sha256
 * is a checksum, not a signature) could so point a restored row into a neighbouring tenant: the probe's
 * copy held an entry reversing another tenant's posted entry, and that tenant could no longer reverse
 * its own (the one-reversal index is global).
 *
 * So every declared foreign key of every restored table, read from the schema's own metadata (no table
 * list: a table added later is covered by being restorable at all), must resolve to a row of the NEW
 * workspace: a reference to `workspace` is the new workspace itself, a reference to a workspace-scoped
 * table is a row inside the new workspace's scope (direct or through its FK chain, `scopedWhere`). A
 * reference to a table no workspace owns (a global catalogue) is existence only, which
 * `foreign_key_check` already holds. A failure refuses the restore, `restore_invariant_failed` with
 * reason `foreign_reference`, naming the table and column but never the foreign value (§H-TENANT: it
 * would name another tenant's row).
 */
function assertReferencesStayInside(db: Database.Database, tables: readonly string[], newWsId: string): void {
  for (const table of [...tables, 'workspace']) {
    const own = table === 'workspace' ? { clause: '"id" = ?', params: [newWsId] as unknown[] } : scopedWhere(db, table, newWsId);
    for (const fk of foreignKeysOf(db, table)) {
      const target = referenceScope(db, fk.table, newWsId);
      if (target === undefined) continue; // a global table: existence is foreign_key_check's
      const to = fk.to ?? surrogatePk(columnsOf(db, fk.table)) ?? 'id';
      const outside = db
        .prepare(
          `SELECT 1 AS hit FROM "${table}" AS __row WHERE ${own.clause} AND __row."${fk.from}" IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM "${fk.table}" WHERE "${fk.table}"."${to}" = __row."${fk.from}" AND ${target.clause}) LIMIT 1`,
        )
        .get(...own.params, ...target.params) as { hit: number } | undefined;
      if (outside !== undefined) {
        throw new RestoreInvariantError('foreign_reference', { table, column: fk.from, references: fk.table });
      }
    }
  }
}

/**
 * THE TENANT FENCE, at the chokepoint (critic R2-M2). The declared-FK check below reads the schema's
 * DECLARED keys, and a column that names a row without declaring it (149 such columns at the last
 * census, `capture_fields.capture_id` among them) crossed the tenant boundary exactly as R1-M3 did: a
 * hand-edited backup planted a field row on ANOTHER tenant's capture, and that tenant's own extract then
 * died on the global `capture_fields_live` index. Declaring one more foreign key would close that
 * instance only.
 *
 * So the fence reads what the chokepoint itself saw. Every value `RestoreIdMap.remapValue` met in a
 * reference position (a whole value, a JSON string, a token of a structured value, a declared FK the
 * per-table map did not resolve) that has the minted id shape and named no row of the backup is on its
 * `unmappedReferences` list. Each one that names an existing row OUTSIDE the new workspace refuses the
 * restore, `restore_invariant_failed` / `foreign_reference`, naming the table and column that held it
 * and the table it pointed into (never the value: §H-TENANT). "Outside" means a row of another
 * workspace (`workspace` itself, or any workspace-scoped table, through `scopedWhere`); a row of a table
 * no workspace owns is not a tenant's, and a value naming nothing is a dangling reference, not a
 * crossing. Two crossings are legitimate, and each is bounded:
 *
 *  - a column naming a SIBLING WORKSPACE, `CROSS_WORKSPACE_REFERENCE_COLUMNS` (G18's test mandate),
 *    exempt for the `workspace` table only;
 *  - a reference into a table the restore deliberately does NOT carry (the identity and operational
 *    tables, spec §0a.8b: a restored workspace is unprovisioned) whose row belongs to the SOURCE
 *    workspace. Nothing can re-map it, and beside the original it names the source's own row (the
 *    audit trail's `workspace_member` entities, measured by the gate worlds). A row of a table the
 *    restore DOES carry is never exempt: every one the backup holds was re-minted, so a value still
 *    naming one outside the new workspace was put there by hand.
 *
 * No table or column is named here: a table added later is fenced by being restorable at all.
 *
 * Exported for the fence's volume test (`test/data/restore-tenant-fence.test.mjs`); the restore is its
 * only production caller.
 */
export function assertUnmappedStayInside(
  db: Database.Database,
  remap: RestoreIdMap,
  newWsId: string,
  srcWsId: string,
  loaded: readonly string[],
): void {
  const refs = remap.unmappedReferences();
  if (refs.length === 0) return;
  const carried = new Set(loaded);
  // THE COST (critic R3-L1): one lookup per table, whatever the volume. The distinct tokens go into a
  // temp table ONCE, with the minted PREFIX each carries; per table, one query finds which of those
  // prefixes the table's ids carry at all (a primary-key range probe per prefix), and only tokens of a
  // carried prefix are joined against the table, once. A token whose prefix no table carries (the
  // `vbk_` run inside an idempotency key, measured as one per posted entry) costs nothing further. The
  // old shape ran an `IN` query per table per 400 tokens: 31 s at 100'000 tokens, inside the write lock.
  const tokens = new Map<string, string>(); // token -> its minted prefix
  for (const ref of refs) {
    const prefix = mintedPrefix(ref.token);
    if (prefix !== undefined) tokens.set(ref.token, prefix);
  }
  if (tokens.size === 0) return;
  const foreign = new Map<string, string>(); // token -> the table holding it outside the new workspace
  db.exec('CREATE TEMP TABLE IF NOT EXISTS g04_fence_token (g04_token TEXT PRIMARY KEY, g04_prefix TEXT NOT NULL) WITHOUT ROWID');
  db.exec('CREATE TEMP TABLE IF NOT EXISTS g04_fence_prefix (g04_prefix TEXT PRIMARY KEY, g04_lo TEXT NOT NULL, g04_hi TEXT NOT NULL) WITHOUT ROWID');
  try {
    db.exec('DELETE FROM temp.g04_fence_token; DELETE FROM temp.g04_fence_prefix');
    const putToken = db.prepare('INSERT INTO temp.g04_fence_token (g04_token, g04_prefix) VALUES (?, ?)');
    const putPrefix = db.prepare('INSERT OR IGNORE INTO temp.g04_fence_prefix (g04_prefix, g04_lo, g04_hi) VALUES (?, ?, ?)');
    for (const [token, prefix] of tokens) {
      putToken.run(token, prefix);
      // Every id of this prefix sorts in [prefix_, prefix`): `_` is 0x5F and the backtick 0x60.
      putPrefix.run(prefix, `${prefix}_`, `${prefix}\``);
    }
    for (const table of ['workspace', ...allTables(db)]) {
      if (table.startsWith('g04_fence_')) continue;
      const pk = table === 'workspace' ? 'id' : surrogatePk(columnsOf(db, table));
      if (pk === undefined) continue;
      const scope = referenceScope(db, table, newWsId);
      if (scope === undefined) continue; // a table no workspace owns: not a tenant's row
      const prefixes = (
        db
          .prepare(
            `SELECT p.g04_prefix AS prefix FROM temp.g04_fence_prefix AS p
              WHERE EXISTS (SELECT 1 FROM "${table}" WHERE "${pk}" >= p.g04_lo AND "${pk}" < p.g04_hi)`,
          )
          .all() as { prefix: string }[]
      ).map((r) => r.prefix);
      if (prefixes.length === 0) continue;
      const marks = prefixes.map(() => '?').join(', ');
      const join = `FROM temp.g04_fence_token AS k JOIN "${table}" ON "${table}"."${pk}" = k.g04_token WHERE k.g04_prefix IN (${marks})`;
      const hits = db.prepare(`SELECT k.g04_token AS id ${join}`).all(...prefixes) as { id: string }[];
      if (hits.length === 0) continue;
      const within = (clause: { clause: string; params: unknown[] }): Set<string> =>
        new Set((db.prepare(`SELECT k.g04_token AS id ${join} AND ${clause.clause}`).all(...prefixes, ...clause.params) as { id: string }[]).map((r) => r.id));
      const inside = within(scope);
      // A table the restore does not carry: its source-workspace rows are the by-design dangling kind.
      const sourceSide = table !== 'workspace' && !carried.has(table) ? within(scopedWhere(db, table, srcWsId)) : new Set<string>();
      for (const hit of hits) {
        if (inside.has(hit.id) || sourceSide.has(hit.id) || foreign.has(hit.id)) continue;
        foreign.set(hit.id, table);
      }
    }
  } finally {
    db.exec('DELETE FROM temp.g04_fence_token; DELETE FROM temp.g04_fence_prefix');
  }
  for (const ref of refs) {
    const into = foreign.get(ref.token);
    if (into === undefined) continue;
    if (into === 'workspace' && CROSS_WORKSPACE_REFERENCE_COLUMNS[columnKey(ref.table, ref.column)] !== undefined) continue;
    throw new RestoreInvariantError('foreign_reference', { table: ref.table, column: ref.column, references: into });
  }
}

/** The minted prefix of a minted-shape token (`<prefix>_<suffix>`), the part before its last `_`. */
function mintedPrefix(token: string): string | undefined {
  const at = token.lastIndexOf('_');
  return at > 0 ? token.slice(0, at) : undefined;
}

/** The rows of `table` that belong to workspace `wsId`, or undefined for a table no workspace owns. */
function referenceScope(db: Database.Database, table: string, wsId: string): { clause: string; params: unknown[] } | undefined {
  if (table === 'workspace') return { clause: '"id" = ?', params: [wsId] };
  if (scopeInfoFor(db, table) === undefined) return undefined;
  return scopedWhere(db, table, wsId);
}

/**
 * Put the restore itself on record in the copy's audit chain (critic R1-L1). Every carried hash is new
 * (the identity is a hash input), so without this row nothing in the copy says it was re-sealed, or
 * from which head: an auditor holding the source's externally anchored head (A03, the OP4 archive) could
 * not tie the copy back to it. The row names the SOURCE anchor it was re-sealed from (the `audit_head`
 * hash the source stored, which is what an external anchor holds), the verdict, and the source row
 * count, as one JSON value in `entity_id`; it is `workspace` / `import` in the A03 vocabulary (a
 * workspace brought in from a backup), so every surface already words it.
 *
 * It goes through `appendAuditLog`, the one append path, which chains off the carried head. A verified
 * copy therefore still verifies; a chain carried broken stays broken (the append cannot mend an earlier
 * link, and it chains off the carried, mismatching head, so the anchor check fails as before).
 */
function recordRestoreInChain(deps: PortDeps, newWsId: string, chain: CarriedAuditChain): void {
  appendAuditLog(
    { store: deps.store, workspaceId: newWsId, ids: deps.ids },
    {
      entityKind: 'workspace',
      entityId: JSON.stringify({
        restoredFrom: {
          chain: chain.verified ? 'verified' : 'broken',
          sourceHead: chain.sourceHeadHash,
          sourceRows: chain.rows,
          ...(chain.brokenAtRow === undefined ? {} : { brokenAtRow: chain.brokenAtRow }),
        },
      }),
      action: 'import',
      actor: deps.actor ?? 'system',
      at: deps.clock.now(),
    },
  );
}

/**
 * The tables a restore loads through `loadTable`, in load order: every scoped table of the snapshot
 * but the audit pair (carried by `carryAuditChain`) and the restore-excluded ones. Exported for the
 * list-free gate, which scans exactly what a restore wrote.
 */
export function restoreLoadTables(snap: Database.Database): string[] {
  return loadOrder(
    snapshotTables(snap).filter((t) => t !== AUDIT_TABLE && t !== 'audit_head' && !RESTORE_EXCLUDED_TABLES.has(t)),
  );
}

/**
 * N00 `env_copy`: a copied workspace that names ANOTHER workspace of the same source instance.
 *
 * A backup holds one workspace, so its restore can only re-map that workspace's own ids: a value naming
 * a DIFFERENT workspace (G18: `migration_plan.testmandant_workspace_id`, the plan's test mandate) is
 * cleared by a single restore (`RESTORE_ROW_TRANSFORMS`: beside the original it names the ORIGINAL's
 * Testmandant), and kept only for env_copy (`PortDeps.keepSiblingTestmandantLinks`). An instance copy restores EVERY workspace, one after the other, so once all of them exist
 * the copy knows where each source workspace went (`pairs`, source workspace id to target workspace
 * id) and sends the rows of `scope` through the SAME chokepoint again with exactly those pairs. Found by
 * the list-free gate over an env_copy target (30.09.2026). The audit chain is not touched (its content
 * is sealed; a cross-workspace audit entity would need a re-seal, and the gate would name it).
 * Returns how many cells changed. The caller holds the transaction and any trigger suspension.
 */
export function remapCopiedWorkspaceIds(
  db: Database.Database,
  pairs: Readonly<Record<string, string>>,
  scope: readonly string[],
): number {
  const remap = new RestoreIdMap();
  for (const [source, target] of Object.entries(pairs)) remap.add('workspace', source, target);
  let changed = 0;
  for (const wsId of scope) {
    for (const table of restoreLoadTables(db)) {
      const names = columnsOf(db, table).map((c) => c.name);
      const where = scopedWhere(db, table, wsId);
      const rows = db.prepare(`SELECT rowid AS "__rowid", * FROM "${table}" WHERE ${where.clause}`).all(...where.params) as Row[];
      for (const row of rows) {
        for (const name of names) {
          const before = row[name];
          if (typeof before !== 'string') continue;
          const after = remap.remapValue(table, name, before);
          if (after === before) continue;
          db.prepare(`UPDATE "${table}" SET "${name}" = ? WHERE rowid = ?`).run(after, row['__rowid']);
          changed += 1;
        }
      }
    }
  }
  return changed;
}

/**
 * The restored id for one source surrogate id. An id DERIVED from the workspace id (it carries the
 * workspace id as one of its delimited tokens: `<prefix>:<workspaceId>`, the seeded G22 autostart
 * rules, `core/checklists/autostart.ts`) is RE-DERIVED under the new workspace id, so it keeps the
 * meaning the engine reads back out of it (the rule's template, a run's provenance) and stays unique
 * (the new workspace id is fresh); every other id is freshly minted.
 */
function mintRestoredId(ids: IdGen, table: string, sourceId: string, srcWsId: string, newWsId: string): string {
  const tokens: string[] = sourceId.match(/[A-Za-z0-9_-]+/g) ?? [];
  if (tokens.length > 1 && tokens.includes(srcWsId)) {
    return sourceId.replace(/[A-Za-z0-9_-]+/g, (t) => (t === srcWsId ? newWsId : t));
  }
  return ids.next(table);
}

/**
 * Copy the snapshot's workspace fields onto the freshly-minted workspace row, keeping id + chosen name.
 * Every copied value passes the chokepoint like any other restored value (a workspace default that
 * names one of its own rows follows that row).
 */
function updateWorkspaceRow(
  db: Database.Database,
  snap: Database.Database,
  srcWsId: string,
  newWsId: string,
  remap: RestoreIdMap,
): void {
  const srcRow = snap.prepare('SELECT * FROM "workspace" WHERE id = ?').get(srcWsId) as Row | undefined;
  if (srcRow === undefined) return;
  // The name stays the caller's choice; everything else (currency, fiscal year, vat config, created_at)
  // is the source's, so the restored books are configured identically.
  const cols = columnsOf(snap, 'workspace')
    .map((c) => c.name)
    .filter((n) => n !== 'id' && n !== 'name');
  if (cols.length === 0) return;
  db.prepare(`UPDATE "workspace" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`).run(
    ...cols.map((c) => remap.remapValue('workspace', c, srcRow[c] ?? null) ?? null),
    newWsId,
  );
}

/**
 * Insert every row of one scoped table into the live db. The tenant key becomes the new workspace, the
 * primary key and every declared foreign key resolve through their own table's map, and EVERY other
 * value goes through the one chokepoint (`RestoreIdMap.remapValue`, spec §0c): no column needs to be
 * named for its references to follow their rows.
 */
function loadTable(
  db: Database.Database,
  snap: Database.Database,
  table: string,
  srcWsId: string,
  newWsId: string,
  idMap: Map<string, Map<string, string>>,
  remap: RestoreIdMap,
  rowCtx: RestoreRowContext,
): void {
  const cols = columnsOf(snap, table);
  const pk = surrogatePk(cols);
  const fks = new Map<string, FkMeta>();
  for (const fk of foreignKeysOf(snap, table)) fks.set(fk.from, fk);
  const where = scopedWhere(snap, table, srcWsId);
  const rows = snap.prepare(`SELECT * FROM "${table}" WHERE ${where.clause}`).all(...where.params) as Row[];
  if (rows.length === 0) return;

  const remapValue = (colName: string, value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (colName === 'workspace_id') return newWsId;
    if (colName === pk) return idMap.get(table)?.get(String(value)) ?? value;
    const fk = fks.get(colName);
    if (fk !== undefined) {
      if (fk.table === 'workspace') return newWsId;
      const mapped = idMap.get(fk.table)?.get(String(value));
      if (mapped !== undefined) return mapped;
    }
    // THE CHOKEPOINT: every other value, whatever its column is called (money, timestamps and plain
    // text come back unchanged; a value naming a re-minted row comes back as the restored id).
    return remap.remapValue(table, colName, value);
  };

  const names = cols.map((c) => c.name);
  const stmt = db.prepare(
    `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  );
  const transform = RESTORE_ROW_TRANSFORMS[table];
  const sourceTransform = RESTORE_SOURCE_ROW_TRANSFORMS[table];
  for (const source of rows) {
    const row = sourceTransform === undefined ? source : sourceTransform(snap, source, rowCtx);
    if (row === null) continue; // a row the restore drops (see RESTORE_SOURCE_ROW_TRANSFORMS)
    const values: Row = {};
    for (const n of names) values[n] = remapValue(n, row[n]);
    const out = transform === undefined ? values : transform(db, values, rowCtx);
    stmt.run(...names.map((n) => out[n] ?? null));
  }
}

/**
 * Per-table STATE rules a restored row needs before it lands (its references are already remapped by
 * the chokepoint). These are the only per-table entries left after the chokepoint retired
 * `RESTORE_NAMED_REFS` (spec §0c item 3), because what they express is not a reference:
 *
 * `ebics_connection` (A36 §4.2): a restored book is older than the bank's view of it, so an `active`
 * connection lands `bank_keys_changed` with its keys and pin KEPT: the reviewed bank-key confirm resumes
 * it, and whatever ZKB delivered after the snapshot comes back as gaps the owner fills from eBanking.
 * When the database already holds a live connection for the same subscriber (a restore beside the
 * original, the one-live-per-subscriber index of §4.5), the restored one lands `retired` with its key
 * locator cleared, so it can never feed or destroy the live connection's keys.
 *
 * `portal_grant` (F02/F03): `token_hash` is a GLOBAL unique key (a portal link resolves by the token
 * alone). Restored into an empty book, a grant keeps its hash, so the link the customer or vendor holds
 * can work on the new machine again once a person hands it over anew (D161.2: it lands a draft, see
 * `portalGrantsAwaitHandover`). Restored BESIDE the original, the same hash is already live: the
 * copy used to collide on the UNIQUE constraint and the whole restore died with a raw SQLite error
 * (found by the list-free gate, 30.09.2026). One link cannot open two workspaces, so the COPY's grant
 * lands revoked at the restore time, its hash replaced by a marker no token can hash to (a SHA-256 hex
 * digest never contains a colon); the original's link is untouched and the copy keeps the grant's
 * history (the revDSG access trail).
 */
interface RestoreRowContext {
  /** The restore's own time (the clock of the restoring runtime). */
  readonly now: string;
  /** env_copy only: keep the Testmandant links for its re-point and sweep (`PortDeps`). */
  readonly keepSiblingLinks: boolean;
}

const RESTORE_ROW_TRANSFORMS: Readonly<Record<string, (db: Database.Database, row: Row, ctx: RestoreRowContext) => Row>> = {
  // G12 (owner decision 11.10.2026): a restored plan does not own the Testmandant its link names. Beside
  // the original that sandbox is the ORIGINAL's, and in an empty book it does not exist. So the link is
  // cleared, and what only existed because a trial ran is reset with it: `trial` goes back to `planned`
  // and a `trial_loaded`/`checked` step back to `mapped` (`migration/trialReset.ts`), after ANY restore,
  // a disaster recovery included. Maps and checks survive; `live`, `closed` and `abandoned` keep their
  // status. The chokepoint saw the value before this runs, which is why the column stays on
  // `CROSS_WORKSPACE_REFERENCE_COLUMNS`. env_copy keeps the link and re-points it instead.
  migration_plan: (_db, row, ctx) => (ctx.keepSiblingLinks ? row : planRowWithoutLink(row)),
  portal_grant: (db, row, ctx) => {
    const taken = db.prepare('SELECT 1 AS taken FROM portal_grant WHERE token_hash = ? LIMIT 1').get(row['token_hash']) as
      | { taken: number }
      | undefined;
    if (taken === undefined) return row;
    return { ...row, token_hash: `restored-copy:${String(row['id'])}`, revoked_at: row['revoked_at'] ?? ctx.now, updated_at: ctx.now };
  },
  ebics_connection: (db, input) => {
    // D142: a restored book never inherits the lease of a sync that was running when it was saved.
    const row: Row = 'sync_started_at' in input ? { ...input, sync_started_at: null, sync_lease_owner: null } : input;
    if (row['state'] === 'retired') return row;
    const live = db
      .prepare("SELECT 1 AS live FROM ebics_connection WHERE host_id = ? AND partner_id = ? AND user_id_ebics = ? AND state != 'retired' LIMIT 1")
      .get(row['host_id'], row['partner_id'], row['user_id_ebics']) as { live: number } | undefined;
    if (live !== undefined) return { ...row, state: 'retired', key_ref: null, sync_rule_id: null };
    if (row['state'] === 'active') return { ...row, state: 'bank_keys_changed' };
    return row;
  },
};

/**
 * D161.2: a restore never makes a revoked or expired portal link live again. A backup is a picture
 * of one moment, and a link the owner revoked AFTER it (it leaked, the customer left) is still live in
 * the picture; nothing the restore can read tells it about the later revocation. Restored into an
 * empty book (the disaster recovery) the grant kept its token hash and its hand-over, so the revoked
 * link opened the restored book again.
 *
 * So every restored grant that is not revoked lands as a DRAFT again, the D157 liveness rule: the
 * engine-written marker `minted_draft = 1` and no `sent_at`, so `isLive` is false and the token
 * resolves to `grant_denied` until a person hands it over again with `portal_grant_send` (governed
 * under `share`), which refuses a revoked or expired grant. The token hash is kept, so the person may
 * reopen the very link the customer or supplier already holds. The original hand-over stays on record
 * in the carried audit chain (its `send` row). A revoked grant keeps its `revoked_at`; an expired one
 * stays expired (expiry is a date, never a state). This runs AFTER the load, on the target's own
 * columns, so an old-shaped snapshot that has no `minted_draft` column (its rows read the DDL DEFAULT 0,
 * live) is covered the same way. Beside the original the copy already lands revoked
 * (`RESTORE_ROW_TRANSFORMS.portal_grant`), and this leaves it so.
 *
 * Returns how many links now wait for a new hand-over; `restore_backup` reports it as
 * `portalLinksAwaitingHandover` (critic F2: D157.1, nothing breaks silently). It counts the links a
 * person can hand over again: an expired grant lands a draft like the rest but is not counted, because
 * the send refuses it and only a new grant gives that customer or supplier access again.
 */
function portalGrantsAwaitHandover(db: Database.Database, newWsId: string, now: string): number {
  const liveInBackup = "workspace_id = ? AND revoked_at IS NULL AND (sent_at IS NOT NULL OR minted_draft = 0)";
  const awaiting = (
    db.prepare(`SELECT COUNT(*) AS n FROM portal_grant WHERE ${liveInBackup} AND expires_at >= ?`).get(newWsId, now.slice(0, 10)) as { n: number }
  ).n;
  db.prepare(`UPDATE portal_grant SET sent_at = NULL, minted_draft = 1, updated_at = ? WHERE ${liveInBackup}`).run(now, newWsId);
  return awaiting;
}

/**
 * Per-table rules applied to the SOURCE row BEFORE the chokepoint reads it, for a value the restore
 * drops rather than re-maps, so the tenant fence never records it as a reference.
 *
 * `migration_step` (G12, owner decision 11.10.2026): the trial reset that goes with the cleared
 * Testmandant link (`migration_plan` above). A trial-loaded step's counts name the Testmandant it
 * wrote into (`trialTarget`); beside the original that is the original's sandbox, a foreign workspace,
 * and the fence refused the whole restore of any book that had ever trial-loaded. The step drops it
 * and leaves `trial_loaded`/`checked` for `mapped` (`migration/trialReset.ts`), and the approvals on
 * such a step are dropped with it. env_copy keeps all three, and re-points or sweeps them afterwards
 * (the sweep voids the approvals of what it resets).
 */
const RESTORE_SOURCE_ROW_TRANSFORMS: Readonly<Record<string, (snap: Database.Database, row: Row, ctx: RestoreRowContext) => Row | null>> = {
  migration_step: (_snap, row, ctx) => (ctx.keepSiblingLinks ? row : stepRowWithoutTrial(row, ctx.now)),
  // The approvals on a step the reset returns to `mapped` are voided with it (canon blocker 6, the
  // `steps.ts` returnToMapped rule): the row is not loaded at all (`null`). Read off the backup's own
  // step, so the order the tables load in does not matter.
  migration_approval: (snap, row, ctx) => {
    if (ctx.keepSiblingLinks) return row;
    const step = snap.prepare('SELECT status FROM migration_step WHERE id = ?').get(row['step_id']) as { status: string } | undefined;
    return step === undefined || approvalSurvivesRestore(step.status) ? row : null;
  },
};

/** What a restore reports about the audit chain it carried. */
export interface CarriedAuditChain {
  /** True when the SOURCE chain verified (every link and the head anchor) and was re-sealed. */
  readonly verified: boolean;
  /** Rows carried. */
  readonly rows: number;
  /** Zero-based position of the first source row that did not verify, when a link broke. */
  readonly brokenAtRow?: number;
  /** The SOURCE chain's stored anchor (`audit_head.head_hash`), or null when the source had none. */
  readonly sourceHeadHash: string | null;
}

/**
 * Carry the audit log into the restored workspace (spec §0c item 4). `workspace_id` and `entity_id`
 * are hash inputs (`auditCanonicalRow`), so a copy under a new identity must be re-hashed; re-hashing
 * blindly would also turn a TAMPERED source chain into a clean one. So the source chain is walked
 * first, exactly as `getAuditLog` walks it (each link, then the `audit_head` count and hash):
 *
 *  - VERIFIED at the source: every row is re-hashed from `AUDIT_GENESIS_PREV` with `auditHashRow` (the
 *    one source of truth for the chain hash) and the head is rebuilt, so the copy verifies.
 *  - BROKEN at row k: rows before k are re-hashed; rows from k on keep their SOURCE `prev_hash` and
 *    `hash`, which cannot match the new chain, so the copy breaks at the same row.
 *  - HEAD mismatched (a truncated or head-tampered log): the source's count, and its head hash where it
 *    did not match, are carried, so the copy's anchor check fails the same way; a missing head stays
 *    missing.
 *
 * Every text field goes through the chokepoint like any restored value (`entity_id` names a restored
 * row); the audit ids come from pass one's map, so a reference to an audit row elsewhere follows it.
 */
function carryAuditChain(
  db: Database.Database,
  snap: Database.Database,
  srcWsId: string,
  newWsId: string,
  auditIds: Map<string, string>,
  remap: RestoreIdMap,
): CarriedAuditChain {
  const rows = snap
    .prepare(
      'SELECT id, entity_kind, entity_id, action, actor, at, prev_hash, hash FROM "audit_log" WHERE workspace_id = ? ORDER BY rowid ASC',
    )
    .all(srcWsId) as {
    id: string;
    entity_kind: string;
    entity_id: string;
    action: string;
    actor: string;
    at: string;
    prev_hash: string | null;
    hash: string;
  }[];
  const head = snap.prepare('SELECT row_count, head_hash FROM "audit_head" WHERE workspace_id = ?').get(srcWsId) as
    | { row_count: number; head_hash: string }
    | undefined;

  // Walk the SOURCE chain under the SOURCE identity (the getAuditLog walk).
  let srcPrev = AUDIT_GENESIS_PREV;
  let brokenAt = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] as (typeof rows)[number];
    const canonical = auditCanonicalRow({
      id: r.id,
      workspaceId: srcWsId,
      entityKind: r.entity_kind,
      entityId: r.entity_id,
      action: r.action,
      actor: r.actor,
      at: r.at,
    });
    if ((r.prev_hash ?? AUDIT_GENESIS_PREV) !== srcPrev || r.hash !== auditHashRow(srcPrev, canonical)) {
      brokenAt = i;
      break;
    }
    srcPrev = r.hash;
  }
  const headCount = head?.row_count ?? 0;
  const headHash = head?.head_hash ?? AUDIT_GENESIS_PREV;
  const headMatches = brokenAt === -1 && headCount === rows.length && headHash === srcPrev;

  const insert = db.prepare(
    `INSERT INTO "audit_log" (id, workspace_id, entity_kind, entity_id, action, actor, at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let prev = AUDIT_GENESIS_PREV;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] as (typeof rows)[number];
    const newId = auditIds.get(r.id);
    if (newId === undefined) throw new RestoreInvariantError('audit_row_unmapped');
    const text = (column: string, value: string): string => String(remap.remapValue(AUDIT_TABLE, column, value));
    const content = {
      id: newId,
      workspaceId: newWsId,
      entityKind: text('entity_kind', r.entity_kind),
      entityId: text('entity_id', r.entity_id),
      action: text('action', r.action),
      actor: text('actor', r.actor),
      at: text('at', r.at),
    };
    let storedPrev: string | null;
    let hash: string;
    if (brokenAt === -1 || i < brokenAt) {
      storedPrev = i === 0 ? null : prev;
      hash = auditHashRow(prev, auditCanonicalRow(content));
    } else {
      // Carried broken: the source's own link values, which the re-sealed prefix cannot match.
      storedPrev = r.prev_hash;
      hash = r.hash;
    }
    insert.run(content.id, newWsId, content.entityKind, content.entityId, content.action, content.actor, content.at, storedPrev, hash);
    prev = hash;
  }

  if (head !== undefined) {
    // A verified chain gets its rebuilt anchor. An anchor that did not match at the source keeps its
    // count, and its hash wherever that hash was not the chain's real tail, so it mismatches again.
    const carriedHash = headMatches || (brokenAt === -1 && headHash === srcPrev) ? prev : headHash;
    const carriedCount = headMatches ? rows.length : headCount;
    db.prepare('INSERT INTO "audit_head" (workspace_id, row_count, head_hash) VALUES (?, ?, ?)').run(newWsId, carriedCount, carriedHash);
  }

  return {
    verified: brokenAt === -1 && headMatches,
    rows: rows.length,
    ...(brokenAt === -1 ? {} : { brokenAtRow: brokenAt }),
    sourceHeadHash: head?.head_hash ?? null,
  };
}

/**
 * G04.2. Delete a local artifact and its registry row (housekeeping only: a backup file carries no
 * legal retention lock of its own, spec §6b). Idempotent per key: a replay returns the first result.
 */
export function deleteBackup(
  deps: PortDeps,
  input: { workspaceId: string; backupId: string; idempotencyKey?: string },
): Result {
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || key.length === 0) return err('invalid_input', { field: 'idempotencyKey' });
  // `rememberIdempotent`, so `store.tx`: IMMEDIATE, like every write but the two long reads (critic
  // R3-3). Through `withKey` this ran in the DEFERRED `snapshotTx`, which read first and so could not
  // wait for the D12 second writer's lock: a delete met a held lock with `store_busy` at once.
  return deps.store.rememberIdempotent(input.workspaceId, key, 'delete_backup', () => {
    const row = deps.store.db
      .prepare('SELECT storage_ref FROM backups WHERE id = ? AND workspace_id = ?')
      .get(input.backupId, input.workspaceId) as { storage_ref: string } | undefined;
    if (row === undefined) return err('backup_not_found', { backupId: input.backupId });
    deps.store.db.prepare('DELETE FROM backups WHERE id = ? AND workspace_id = ?').run(input.backupId, input.workspaceId);
    try {
      rmSync(row.storage_ref, { recursive: true, force: true });
    } catch {
      // The row is the record of truth; a missing directory is not an error worth failing the delete.
    }
    return ok({ backupId: input.backupId, deleted: true });
  });
}

/** The human-readable FORMAT.md that ships in every bundle (GeBüV Art. 9/10: readable across systems). */
function formatDoc(kind: 'backup' | 'export', manifest: ArtifactManifest): string {
  const header =
    kind === 'backup'
      ? '# TILL backup (.tillbackup, sqlite_snapshot)\n\nA tenant-scoped SQLite snapshot any standard SQLite client can open. This is the byte-perfect artifact `restore_backup` consumes.'
      : '# TILL export (.tillexport, jsonl_bundle)\n\nOne JSON-lines file per table (one JSON object per row), a human-readable copy. Not a restore source: it optimises for external readability, not reconstruction.';
  const tables = Object.keys(manifest.tables)
    .sort()
    .map((t) => `- \`${t}\`: ${manifest.tables[t]?.rowCount ?? 0} rows`)
    .join('\n');
  return [
    header,
    '',
    `Schema version: ${manifest.schemaVersion}`,
    `TILL version: ${manifest.tillVersion}`,
    `Created: ${manifest.createdAt}`,
    '',
    '## Files',
    '- `manifest.json`: schema_version, till_version, per-file sha256, per-table row counts.',
    kind === 'backup'
      ? '- `data.sqlite`: the scoped SQLite snapshot (every money column is a stored integer Rappen; ids are re-minted on restore).'
      : '- `<table>.jsonl`: one JSON object per row. `documents/<sha256>.bin`: document blobs, byte-identical.',
    '',
    '## Tables',
    tables,
    '',
  ].join('\n');
}
