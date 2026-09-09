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
 *    backup, collides on a global primary key). Money, timestamps and the audit CONTENT are copied
 *    verbatim; ids, the `reverses_entry_id` chain, blob linkage and the audit `workspace_id`/`entity_id`
 *    are remapped. The audit chain is RE-HASHED under the new workspace id (it is a hash input), reusing
 *    `auditHashRow` so there is one source of truth for the chain hash.
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
import { SCHEMA_SQL, SCHEMA_GENERATION } from '../store/schema.js';
import { applyAdditiveSchema } from '../store/sqlite-store.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { createWorkspace } from '../setup/workspace.js';
import { auditCanonicalRow, auditHashRow, AUDIT_GENESIS_PREV } from '../ledger/auditLog.js';
import { TILL_VERSION } from './catalog.js';

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

function allTables(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
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
 * are scoped through a foreign key: `journal_line` through its `entry_id` to `journal_entry`, and
 * `migration_map_template` through `created_in_workspace_id` to `workspace`. Scoping journal_line by
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
 * destination gets the SAME schema (so it is a faithful, standalone-queryable copy) and its rows are
 * inserted with foreign keys off and lines before entries, so a posted ledger loads without tripping
 * the immutability trigger. Returns the per-table manifest.
 */
function writeScopedSqlite(srcDb: Database.Database, srcWsId: string, destPath: string): TableManifest {
  const dest = new Database(destPath);
  try {
    dest.pragma('foreign_keys = OFF');
    dest.exec(SCHEMA_SQL);
    // The snapshot must carry the SAME schema the live store runs, not just the base CREATE path:
    // columns TILL ships only through ADDITIVE_COLUMNS (e.g. G05's `document.rendered_template_id`)
    // are absent from SCHEMA_SQL, so without this the row copy throws `no column named ...`.
    applyAdditiveSchema(dest);
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
    return manifest;
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

/** Run `compute` once per `(workspaceId, key)`; a key is required on both write verbs, so it is always set. */
function withKey(deps: PortDeps, workspaceId: string, key: string | undefined, verb: string, compute: () => Result): Result {
  if (typeof key !== 'string' || key.length === 0) return err('invalid_input', { field: 'idempotencyKey' });
  return deps.store.rememberIdempotent(workspaceId, key, verb, compute);
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

    if (kind === 'backup') {
      const sqlitePath = join(tmpDir, 'data.sqlite');
      tables = writeScopedSqlite(deps.store.db, workspaceId, sqlitePath);
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
    };
    writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(tmpDir, 'FORMAT.md'), formatDoc(kind, manifest));

    // Atomic publish: rename the fully-built temp bundle onto the final path.
    renameSync(tmpDir, finalDir);

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
    // Clean up the temp bundle; the row was never written, so nothing partial persists.
    try {
      rmSync(tmpDir, { recursive: true, force: true });
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
export function verifyBackup(_deps: PortDeps, input: { source: string }): Result {
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
  if (manifest.format === 'sqlite_snapshot') {
    const sqlitePath = join(source, 'data.sqlite');
    const snap = new Database(sqlitePath, { readonly: true });
    try {
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
  });
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
  if (!verified.ok) return verified; // backup_corrupt / incompatible_schema_version pass straight through.
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
    if (e instanceof RestoreInvariantError) return err('restore_invariant_failed', { reason: e.reason });
    throw e;
  }
}

class RestoreInvariantError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'RestoreInvariantError';
  }
}

/**
 * The transactional core of restore. Composes `createWorkspace`, wipes the seeded scaffold, loads the
 * snapshot with every surrogate id re-minted, re-chains the audit log, and runs the invariant gate. It
 * runs inside `store.tx` (via `rememberIdempotent` or directly), so it THROWS on an invariant failure to
 * roll everything back, and never returns `{ok:false}` after a write.
 */
function loadIntoNewWorkspace(deps: PortDeps, source: string, newWorkspaceName: string): Result {
  const db = deps.store.db;
  const snap = new Database(join(source, 'data.sqlite'), { readonly: true });
  try {
    // 1. Compose A00 createWorkspace (NO idempotency key: this function owns the outer idempotency).
    const created = createWorkspace(
      { store: deps.store, clock: deps.clock, ids: deps.ids, actor: deps.actor },
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

    // 4. Pass one: mint a fresh id for every surrogate primary key across every loaded table, plus the
    //    workspace remap. `combined` is the value-lookup used for the polymorphic audit `entity_id`.
    const loaded = loadOrder(
      snapshotTables(snap).filter(
        (t) => t !== 'audit_log' && t !== 'audit_head' && !RESTORE_EXCLUDED_TABLES.has(t),
      ),
    );
    const idMap = new Map<string, Map<string, string>>();
    const combined = new Map<string, string>([[srcWsId, newWsId]]);
    for (const table of loaded) {
      const pk = surrogatePk(columnsOf(snap, table));
      if (pk === undefined) continue;
      const map = new Map<string, string>();
      const rows = snap.prepare(`SELECT "${pk}" AS id FROM "${table}"`).all() as { id: string }[];
      for (const r of rows) {
        const minted = deps.ids.next(table);
        map.set(r.id, minted);
        combined.set(r.id, minted);
      }
      idMap.set(table, map);
    }

    // 5. Update the new workspace row from the snapshot (keeping the caller's chosen name).
    updateWorkspaceRow(db, snap, srcWsId, newWsId, newWorkspaceName);

    // 6. Pass two: load every scoped row with ids/FKs/workspace_id remapped.
    for (const table of loaded) {
      loadTable(db, snap, table, srcWsId, newWsId, idMap, combined);
    }

    // 7. Re-chain the audit log under the new workspace identity, and rebuild the head anchor.
    rechainAudit(db, snap, srcWsId, newWsId, deps.ids, combined);

    // 8. The invariant gate, BEFORE commit. Any failure THROWS to roll the whole restore back.
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) throw new RestoreInvariantError('referential_integrity');
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

    return ok({ workspaceId: newWsId });
  } finally {
    snap.close();
  }
}

/** Copy the snapshot's workspace fields onto the freshly-minted workspace row, keeping id + chosen name. */
function updateWorkspaceRow(
  db: Database.Database,
  snap: Database.Database,
  srcWsId: string,
  newWsId: string,
  newWorkspaceName: string,
): void {
  const srcRow = snap.prepare('SELECT * FROM "workspace" WHERE id = ?').get(srcWsId) as Row | undefined;
  if (srcRow === undefined) return;
  const cols = columnsOf(snap, 'workspace')
    .map((c) => c.name)
    .filter((n) => n !== 'id' && n !== 'name');
  if (cols.length === 0) return;
  db.prepare(`UPDATE "workspace" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`).run(
    ...cols.map((c) => srcRow[c] ?? null),
    newWsId,
  );
  // The name stays the caller's choice; everything else (currency, fiscal year, vat config, created_at)
  // is the source's, so the restored books are configured identically.
  void newWorkspaceName;
}

/** Insert every row of one scoped table into the live db, remapping ids, FKs and workspace_id. */
function loadTable(
  db: Database.Database,
  snap: Database.Database,
  table: string,
  srcWsId: string,
  newWsId: string,
  idMap: Map<string, Map<string, string>>,
  combined: Map<string, string>,
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
    const fk = fks.get(colName);
    if (fk !== undefined) {
      if (fk.table === 'workspace') return newWsId;
      const map = idMap.get(fk.table);
      const mapped = map?.get(String(value));
      return mapped ?? value;
    }
    if (colName === pk) return idMap.get(table)?.get(String(value)) ?? value;
    // A polymorphic entity reference (audit_log/custom-field/stored_file `entity_id`) that names a
    // remapped surrogate id is remapped through the combined value-map; a natural value (a period
    // string, a sha256) is not present there and passes through untouched.
    if (colName === 'entity_id') return combined.get(String(value)) ?? value;
    return value; // money, timestamps, text, natural keys, content-address sha256: verbatim.
  };

  const names = cols.map((c) => c.name);
  const stmt = db.prepare(
    `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  );
  for (const row of rows) stmt.run(...names.map((n) => remapValue(n, row[n])));
}

/**
 * Re-chain the audit log under the new workspace id. `workspace_id` is a hash input (`auditCanonicalRow`),
 * so the copied hashes are recomputed from `AUDIT_GENESIS_PREV` forward using the SAME `auditHashRow` the
 * live append uses. `entity_id` is remapped for the workspace and journal-entry rows whose ids changed; a
 * period-lock row's entity_id is a period string and passes through. The head anchor is rebuilt to match.
 */
function rechainAudit(
  db: Database.Database,
  snap: Database.Database,
  srcWsId: string,
  newWsId: string,
  ids: IdGen,
  combined: Map<string, string>,
): void {
  const rows = snap
    .prepare(
      'SELECT id, entity_kind, entity_id, action, actor, at FROM "audit_log" WHERE workspace_id = ? ORDER BY rowid ASC',
    )
    .all(srcWsId) as { id: string; entity_kind: string; entity_id: string; action: string; actor: string; at: string }[];

  const insert = db.prepare(
    `INSERT INTO "audit_log" (id, workspace_id, entity_kind, entity_id, action, actor, at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let prev = AUDIT_GENESIS_PREV;
  let count = 0;
  for (const r of rows) {
    const newId = ids.next('audit');
    const entityId = r.entity_kind === 'workspace' ? newWsId : combined.get(r.entity_id) ?? r.entity_id;
    const canonical = auditCanonicalRow({
      id: newId,
      workspaceId: newWsId,
      entityKind: r.entity_kind,
      entityId,
      action: r.action,
      actor: r.actor,
      at: r.at,
    });
    const hash = auditHashRow(prev, canonical);
    insert.run(newId, newWsId, r.entity_kind, entityId, r.action, r.actor, r.at, count === 0 ? null : prev, hash);
    prev = hash;
    count += 1;
  }
  if (count > 0) {
    db.prepare('INSERT INTO "audit_head" (workspace_id, row_count, head_hash) VALUES (?, ?, ?)').run(
      newWsId,
      count,
      prev,
    );
  }
}

/**
 * G04.2. Delete a local artifact and its registry row (housekeeping only: a backup file carries no
 * legal retention lock of its own, spec §6b). Idempotent per key: a replay returns the first result.
 */
export function deleteBackup(
  deps: PortDeps,
  input: { workspaceId: string; backupId: string; idempotencyKey?: string },
): Result {
  return withKey(deps, input.workspaceId, input.idempotencyKey, 'delete_backup', () => {
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
