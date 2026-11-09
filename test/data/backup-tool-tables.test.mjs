/**
 * G04 backups and the tables TILL does not own (owner's Mac, 13.10.2026).
 *
 * THE DEFECT. The owner's real book is replicated by Litestream, which keeps its own bookkeeping
 * tables INSIDE the SQLite file (`_litestream_seq`, `_litestream_lock`; the DDL below is Litestream's
 * own, from `db.go` `init()`). `create_backup` copied every non-`sqlite_` table's DDL into the
 * snapshot, so the backup's shape named them, and `verify_backup` / `restore_backup` against any book
 * WITHOUT Litestream (a fresh install after a disaster, a scratch book) refused with
 * `schema_newer_than_runtime` / `schema_shape_newer`, unknownTables `["_litestream_lock",
 * "_litestream_seq"]`: the backup of a replicated book could not be restored anywhere else.
 *
 * THE RULE. One predicate (`isTillTable`, `src/core/store/schemaShape.ts`) says which tables are
 * TILL's, and every enumeration a backup, an export, a verify or a restore makes goes through it.
 *
 * Synthetic books built from scratch in a tmp dir; no real data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { isTillTable, tillTables, schemaShapeOf, schemaFingerprint } from '../../dist/core/store/schemaShape.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { manualPost } from '../api/support.mjs';

const clock = { now: () => '2026-10-13T10:00:00.000Z' };

/** Litestream's own DDL (benbjohnson/litestream `db.go`, `init()`), verbatim. */
const LITESTREAM_DDL = [
  'CREATE TABLE IF NOT EXISTS _litestream_seq (id INTEGER PRIMARY KEY, seq INTEGER);',
  'CREATE TABLE IF NOT EXISTS _litestream_lock (id INTEGER);',
];

/** What Litestream leaves in a book it replicates: its two tables, with the rows it writes. */
function replicateWithLitestream(db, seq = 7) {
  for (const ddl of LITESTREAM_DDL) db.exec(ddl);
  db.prepare('INSERT INTO _litestream_seq (id, seq) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq').run(seq);
  db.exec('INSERT INTO _litestream_lock (id) VALUES (1)');
}

/** The whole-FILE shape a pre-isTillTable backup fingerprinted (tool tables included), computed here:
 *  the engine no longer exports a way to ask for it (critic L3, 14.10.2026). */
function wholeFileShape(db) {
  const shape = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    shape[name] = db.pragma(`table_info("${name}")`).map((c) => c.name).sort();
  }
  return shape;
}

const litestreamRows = (db) => ({
  seq: db.prepare('SELECT id, seq FROM _litestream_seq ORDER BY id').all(),
  lock: db.prepare('SELECT id FROM _litestream_lock ORDER BY rowid').all(),
});

const tableNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

/** A file-backed book with one workspace and two posted entries. */
function book(dir, name, prefix) {
  const store = new SqliteStore({ location: join(dir, `${name}.sqlite`), clock });
  const ids = { next: ((g) => (p) => `${prefix}${g.next(p)}`)(sequenceIdGen()) };
  const deps = { store, clock, ids, actor: 'user_1', backupDir: join(dir, `${name}-backups`) };
  const ws = getAction('create_workspace').run(deps, { name: `${name} GmbH`, idempotencyKey: 'ws' });
  assert.equal(ws.ok, true, JSON.stringify(ws));
  const accId = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws.workspaceId, n).id;
  const call = (verb, input) => getAction(verb).run(deps, { workspaceId: ws.workspaceId, ...input });
  assert.equal(call('post_entry', manualPost(accId, 'p1', 1200)).ok, true);
  assert.equal(call('post_entry', manualPost(accId, 'p2', 3400)).ok, true);
  return { store, deps, workspaceId: ws.workspaceId, call };
}

/** A brand-new install: a store with no workspace at all, the disaster-recovery target. */
function freshInstall(dir, name, prefix) {
  const store = new SqliteStore({ location: join(dir, `${name}.sqlite`), clock });
  const ids = { next: ((g) => (p) => `${prefix}${g.next(p)}`)(sequenceIdGen()) };
  return { store, deps: { store, clock, ids, actor: 'user_1', backupDir: join(dir, `${name}-backups`) } };
}

/** The restored workspace's posted entries, each footed. */
function postedAndBalanced(db, wsId) {
  const entries = db.prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").all(wsId);
  for (const e of entries) {
    const s = db
      .prepare('SELECT COALESCE(SUM(base_debit_minor),0) AS d, COALESCE(SUM(base_credit_minor),0) AS c FROM journal_line WHERE entry_id = ?')
      .get(e.id);
    assert.equal(s.d, s.c, `entry ${e.id} foots`);
  }
  return entries.length;
}

/**
 * Turn a backup into one the PRE-FIX `create_backup` wrote from a Litestream book: its data.sqlite
 * carries Litestream's tables (the old code copied every non-`sqlite_` table's DDL), and its manifest
 * records the shape and fingerprint of that file, Litestream tables included, with the file re-hashed.
 */
function makeLegacyLitestreamBackup(artifactRef) {
  const sqlitePath = join(artifactRef, 'data.sqlite');
  const snap = new Database(sqlitePath);
  // The old copy took Litestream's DDL but none of its rows (the tables are not workspace-scoped).
  // Rows are put in here anyway, so the test also proves nothing ever reads them back out.
  replicateWithLitestream(snap, 99);
  const rawShape = wholeFileShape(snap);
  snap.close();
  assert.ok('_litestream_seq' in rawShape && '_litestream_lock' in rawShape, 'the legacy file carries the Litestream tables');
  const manifestPath = join(artifactRef, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.schemaShape = rawShape;
  manifest.schemaFingerprint = schemaFingerprint(rawShape);
  manifest.files['data.sqlite'] = {
    sha256: createHash('sha256').update(readFileSync(sqlitePath)).digest('hex'),
    bytes: statSync(sqlitePath).size,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

test('the predicate: SQLite internals and leading-underscore tool tables are not TILL tables; no TILL table is hidden by it', () => {
  for (const name of ['_litestream_seq', '_litestream_lock', '_cf_KV', 'sqlite_sequence', 'sqlite_stat1', 'SQLITE_STAT4']) {
    assert.equal(isTillTable(name), false, name);
  }
  for (const name of ['journal_entry', 'journal_line', 'backups', 'workspace', 'zz_newer_table']) {
    assert.equal(isTillTable(name), true, name);
  }
  // THE GUARD on the general rule: every table this runtime's schema creates is a TILL table, so the
  // leading-underscore rule can never silently drop a real table from a backup. A future TILL table
  // named `_something` reds HERE instead of vanishing from every snapshot.
  const dir = mkdtempSync(join(tmpdir(), 'g04-tooltables-'));
  try {
    const { store } = freshInstall(dir, 'schema', 's');
    const all = tableNames(store.db).filter((n) => !/^sqlite_/i.test(n));
    assert.ok(all.length > 50, `the real schema is enumerated (${all.length} tables)`);
    assert.deepEqual(all.filter((n) => !isTillTable(n)), [], 'no TILL table starts with an underscore');
    assert.deepEqual(tillTables(store.db), all);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a NEW backup of a Litestream book carries no _litestream table and restores into a fresh install, balance re-verified', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-tooltables-'));
  try {
    const owner = book(dir, 'owner', 'o');
    replicateWithLitestream(owner.store.db);
    // A tool index on a tool table must not travel either (copySchemaDdl filters by the owning table).
    owner.store.db.exec('CREATE INDEX ix_tool_lock ON _litestream_lock (id)');
    const bkp = owner.call('create_backup', { idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));

    const snap = new Database(join(bkp.artifactRef, 'data.sqlite'), { readonly: true });
    const inFile = snap.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE '%litestream%' OR tbl_name LIKE '%litestream%' OR name = 'ix_tool_lock'").all();
    snap.close();
    assert.deepEqual(inFile, [], 'the snapshot file holds no Litestream object');
    const manifest = JSON.parse(readFileSync(join(bkp.artifactRef, 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.schemaShape).filter((t) => t.startsWith('_')), []);
    // The book's TILL shape is still exactly what the snapshot carries.
    assert.deepEqual(manifest.schemaShape, schemaShapeOf(owner.store.db));

    const fresh = freshInstall(dir, 'fresh', 'f');
    const verified = getAction('verify_backup').run(fresh.deps, { source: bkp.artifactRef });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.equal(verified.balanceOk, true);
    assert.equal(verified.entryCount, 2);
    assert.equal(verified.schemaFingerprint, manifest.schemaFingerprint);
    const listed = getAction('list_restorable_backups').run({ ...fresh.deps, backupDir: owner.deps.backupDir }, {});
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(listed.backups.find((x) => x.source === bkp.artifactRef).compatible, true);

    const restored = getAction('restore_backup').run(fresh.deps, { source: bkp.artifactRef, newWorkspaceName: 'Wiederhergestellt AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(postedAndBalanced(fresh.store.db, restored.workspaceId), 2);
    assert.deepEqual(tableNames(fresh.store.db).filter((n) => n.startsWith('_')), [], 'the restore created no tool table');
    owner.store.close();
    fresh.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a backup ALREADY TAKEN the old way (Litestream tables in its file and in its fingerprint) verifies and restores', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-tooltables-'));
  try {
    const owner = book(dir, 'owner', 'o');
    replicateWithLitestream(owner.store.db);
    const bkp = owner.call('create_backup', { idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));
    const legacy = makeLegacyLitestreamBackup(bkp.artifactRef);

    const fresh = freshInstall(dir, 'fresh', 'f');
    const verified = getAction('verify_backup').run(fresh.deps, { source: bkp.artifactRef });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.equal(verified.balanceOk, true);
    assert.equal(verified.entryCount, 2);
    // What verify reports is the TILL shape's fingerprint, the comparable form.
    const snap = new Database(join(bkp.artifactRef, 'data.sqlite'), { readonly: true });
    assert.equal(verified.schemaFingerprint, schemaFingerprint(schemaShapeOf(snap)));
    snap.close();
    assert.notEqual(verified.schemaFingerprint, legacy.schemaFingerprint);

    const listed = getAction('list_restorable_backups').run({ ...fresh.deps, backupDir: owner.deps.backupDir }, {});
    const entry = listed.backups.find((x) => x.source === bkp.artifactRef);
    assert.equal(entry.compatible, true, JSON.stringify(entry));
    assert.equal(entry.unknownSchema, undefined);

    const restored = getAction('restore_backup').run(fresh.deps, { source: bkp.artifactRef, newWorkspaceName: 'Wiederhergestellt AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(postedAndBalanced(fresh.store.db, restored.workspaceId), 2);
    assert.deepEqual(tableNames(fresh.store.db).filter((n) => n.startsWith('_')), [], 'the restore created no tool table');
    owner.store.close();
    fresh.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy backup whose manifest fingerprint matches NEITHER shape of its file is still backup_corrupt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-tooltables-'));
  try {
    const owner = book(dir, 'owner', 'o');
    const bkp = owner.call('create_backup', { idempotencyKey: 'bk' });
    makeLegacyLitestreamBackup(bkp.artifactRef);
    const path = join(bkp.artifactRef, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.schemaFingerprint = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    const verified = getAction('verify_backup').run(owner.deps, { source: bkp.artifactRef });
    assert.equal(verified.ok, false);
    assert.equal(verified.error, 'backup_corrupt');
    assert.equal(verified.reason, 'schema_fingerprint_mismatch');
    owner.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restoring INTO a Litestream book never writes into its Litestream tables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-tooltables-'));
  try {
    const source = book(dir, 'source', 's');
    replicateWithLitestream(source.store.db, 3);
    const bkp = source.call('create_backup', { idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));
    makeLegacyLitestreamBackup(bkp.artifactRef); // its file carries seq 99, which must never land

    const target = book(dir, 'target', 't');
    replicateWithLitestream(target.store.db, 42);
    const before = litestreamRows(target.store.db);
    const restored = getAction('restore_backup').run(target.deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(postedAndBalanced(target.store.db, restored.workspaceId), 2);
    assert.deepEqual(litestreamRows(target.store.db), before, 'the Litestream rows are exactly as they were');
    assert.deepEqual(before.seq, [{ id: 1, seq: 42 }]);
    source.store.close();
    target.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shape guard still bites for a REAL unknown table and column, and names only those (never the tool tables)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-tooltables-'));
  try {
    const upgraded = book(dir, 'upgraded', 'u');
    replicateWithLitestream(upgraded.store.db);
    upgraded.store.db.exec('ALTER TABLE contact ADD COLUMN zz_newer TEXT');
    upgraded.store.db.exec('CREATE TABLE zz_newer_table (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), note TEXT)');
    upgraded.store.db.prepare("INSERT INTO zz_newer_table (id, workspace_id, note) VALUES ('zz_1', ?, 'newer row')").run(upgraded.workspaceId);
    const bkp = upgraded.call('create_backup', { idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));
    makeLegacyLitestreamBackup(bkp.artifactRef);

    const fresh = freshInstall(dir, 'fresh', 'f');
    const verified = getAction('verify_backup').run(fresh.deps, { source: bkp.artifactRef });
    assert.equal(verified.ok, false, JSON.stringify(verified));
    assert.equal(verified.error, 'schema_newer_than_runtime');
    assert.equal(verified.reason, 'schema_shape_newer');
    assert.deepEqual(verified.unknownTables, ['zz_newer_table']);
    assert.deepEqual(verified.unknownColumns, ['contact.zz_newer']);
    const restored = getAction('restore_backup').run(fresh.deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(restored.ok, false);
    assert.equal(restored.reason, 'schema_shape_newer');
    assert.equal(fresh.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, 0, 'nothing was created');
    const listed = getAction('list_restorable_backups').run({ ...fresh.deps, backupDir: upgraded.deps.backupDir }, {});
    assert.deepEqual(listed.backups.find((x) => x.source === bkp.artifactRef).unknownSchema, ['zz_newer_table', 'contact.zz_newer']);
    upgraded.store.close();
    fresh.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the generation guard still bites on a snapshot carrying tool tables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-tooltables-'));
  try {
    const owner = book(dir, 'owner', 'o');
    replicateWithLitestream(owner.store.db);
    const bkp = owner.call('create_backup', { idempotencyKey: 'bk' });
    const path = join(bkp.artifactRef, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.schemaVersion = manifest.schemaVersion + 1;
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    const verified = getAction('verify_backup').run(owner.deps, { source: bkp.artifactRef });
    assert.equal(verified.ok, false);
    assert.equal(verified.error, 'incompatible_schema_version');
    owner.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
