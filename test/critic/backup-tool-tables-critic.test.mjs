/**
 * NON-AUTHOR critic probes for branch claude/backup-tool-tables (deb46a22), 13.10.2026.
 *
 * Independent re-derivations of the fix's claims, beyond the author's own suite:
 *  - every object the runtime schema creates (tables AND indexes, triggers, views) is a TILL object;
 *  - a tool table that looks workspace-scoped (`workspace_id` column) never enters a snapshot, an
 *    export or a restore (pins the `allTables -> tillTables` switch, which the author's suite does not);
 *  - a crafted snapshot cannot smuggle rows, triggers or views through an underscore-named object;
 *  - a tool trigger on a TILL table in the live book does not travel into the snapshot;
 *  - env_copy (instance and mandate) and the Testmandant hard delete on Litestream books;
 *  - TILL_PACKAGE_VERSION from a packed-tarball layout, and its `unknown` fallback.
 *
 * Synthetic books only, built from scratch in tmp dirs. No real data, no ~/.till.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen, systemIdGen } from '../../dist/core/ids.js';
import { isTillTable } from '../../dist/core/store/schemaShape.js';
import { hardDeleteWorkspace } from '../../dist/core/migration/testmandant.js';
import { envCreate, envCopy } from '../../dist/core/landscape/index.js';
import { createWorkspace } from '../../dist/core/setup/workspace.js';
import { manualPost } from '../api/support.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const clock = { now: () => '2026-10-13T10:00:00.000Z' };

const LITESTREAM_DDL = [
  'CREATE TABLE IF NOT EXISTS _litestream_seq (id INTEGER PRIMARY KEY, seq INTEGER);',
  'CREATE TABLE IF NOT EXISTS _litestream_lock (id INTEGER);',
];
function replicate(db, seq) {
  for (const ddl of LITESTREAM_DDL) db.exec(ddl);
  db.prepare('INSERT INTO _litestream_seq (id, seq) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq').run(seq);
  db.exec('INSERT INTO _litestream_lock (id) VALUES (1)');
}
const lsRows = (db) => ({
  seq: db.prepare('SELECT id, seq FROM _litestream_seq ORDER BY id').all(),
  lock: db.prepare('SELECT rowid, id FROM _litestream_lock ORDER BY rowid').all(),
});
const underscoreObjects = (db) =>
  db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE substr(name,1,1) = '_' OR substr(tbl_name,1,1) = '_' ORDER BY name").all();

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
function fresh(dir, name, prefix) {
  const store = new SqliteStore({ location: join(dir, `${name}.sqlite`), clock });
  const ids = { next: ((g) => (p) => `${prefix}${g.next(p)}`)(sequenceIdGen()) };
  return { store, deps: { store, clock, ids, actor: 'user_1', backupDir: join(dir, `${name}-backups`) } };
}
function rehash(artifactRef) {
  const sqlitePath = join(artifactRef, 'data.sqlite');
  const manifestPath = join(artifactRef, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files['data.sqlite'] = { sha256: createHash('sha256').update(readFileSync(sqlitePath)).digest('hex'), bytes: statSync(sqlitePath).size };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

test('critic P1: no object of ANY type in the runtime schema starts with an underscore (tables, indexes, triggers, views)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-tt-'));
  try {
    const { store } = fresh(dir, 'schema', 's');
    const all = store.db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    assert.ok(all.length > 300, `whole schema enumerated (${all.length} objects)`);
    assert.deepEqual(all.filter((o) => !isTillTable(o.name) || !isTillTable(o.tbl_name)), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('critic P2: a tool table that LOOKS workspace-scoped never enters a snapshot, an export, or a restore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-tt-'));
  try {
    const src = book(dir, 'src', 's');
    src.store.db.exec('CREATE TABLE _tool_state (id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspace(id), note TEXT)');
    src.store.db.prepare("INSERT INTO _tool_state (id, workspace_id, note) VALUES ('t1', ?, 'TOOLROW')").run(src.workspaceId);
    const bkp = src.call('create_backup', { idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));
    const snap = new Database(join(bkp.artifactRef, 'data.sqlite'), { readonly: true });
    assert.deepEqual(underscoreObjects(snap), [], 'snapshot holds no tool object');
    snap.close();
    const manifest = JSON.parse(readFileSync(join(bkp.artifactRef, 'manifest.json'), 'utf8'));
    assert.equal('_tool_state' in manifest.tables, false, 'manifest table list names no tool table');
    const exp = src.call('export_workspace', { idempotencyKey: 'ex' });
    assert.equal(exp.ok, true, JSON.stringify(exp));
    const expManifest = JSON.parse(readFileSync(join(exp.artifactRef, 'manifest.json'), 'utf8'));
    assert.equal(Object.keys(expManifest.files).some((f) => f.startsWith('_')), false, 'export wrote no tool table');

    const tgt = fresh(dir, 'tgt', 't');
    tgt.store.db.exec('CREATE TABLE _tool_state (id TEXT PRIMARY KEY, workspace_id TEXT, note TEXT)');
    const r = getAction('restore_backup').run(tgt.deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(tgt.store.db.prepare('SELECT COUNT(*) AS n FROM _tool_state').get().n, 0, 'the target tool table got no row');
    src.store.close();
    tgt.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('critic P3: a CRAFTED snapshot cannot smuggle rows, a trigger or a view through underscore-named objects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-tt-'));
  try {
    const src = book(dir, 'src', 's');
    const bkp = src.call('create_backup', { idempotencyKey: 'bk' });
    const snap = new Database(join(bkp.artifactRef, 'data.sqlite'));
    const wsId = snap.prepare('SELECT id FROM workspace').get().id;
    snap.exec('CREATE TABLE _smuggle (id TEXT PRIMARY KEY, workspace_id TEXT, entry_id TEXT, base_debit_minor INTEGER)');
    snap.prepare("INSERT INTO _smuggle VALUES ('x1', ?, 'e1', 999999)").run(wsId);
    snap.exec("CREATE TRIGGER _evil AFTER INSERT ON journal_entry BEGIN UPDATE journal_line SET base_debit_minor = 1; END");
    snap.exec('CREATE VIEW _v AS SELECT * FROM journal_line');
    snap.close();
    rehash(bkp.artifactRef);
    const tgt = fresh(dir, 'tgt', 't');
    const v = getAction('verify_backup').run(tgt.deps, { source: bkp.artifactRef });
    assert.equal(v.ok, true, JSON.stringify(v)); // the manifest fingerprint is TILL-shape: unchanged by the extras
    const r = getAction('restore_backup').run(tgt.deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(underscoreObjects(tgt.store.db), [], 'nothing underscore-named reached the target');
    const sums = tgt.store.db
      .prepare('SELECT SUM(base_debit_minor) AS d, SUM(base_credit_minor) AS c FROM journal_line WHERE entry_id IN (SELECT id FROM journal_entry WHERE workspace_id = ?)')
      .get(r.workspaceId);
    assert.deepEqual(sums, { d: 4600, c: 4600 });
    src.store.close();
    tgt.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('critic P4: a tool trigger and a tool index on a TILL table in the live book do not travel into the snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-tt-'));
  try {
    const src = book(dir, 'src', 's');
    replicate(src.store.db, 5);
    src.store.db.exec('CREATE TRIGGER _tool_trg AFTER UPDATE ON contact BEGIN UPDATE _litestream_seq SET seq = seq + 1; END');
    src.store.db.exec('CREATE INDEX _tool_ix ON journal_entry (date)');
    const bkp = src.call('create_backup', { idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));
    const snap = new Database(join(bkp.artifactRef, 'data.sqlite'), { readonly: true });
    assert.deepEqual(underscoreObjects(snap), []);
    snap.close();
    src.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('critic P5: the Testmandant hard delete on a Litestream book leaves the Litestream rows untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-tt-'));
  try {
    const b = book(dir, 'b', 'b');
    replicate(b.store.db, 11);
    const before = lsRows(b.store.db);
    b.store.tx(() => hardDeleteWorkspace({ store: b.store }, b.workspaceId));
    assert.equal(b.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, 0);
    assert.deepEqual(lsRows(b.store.db), before);
    b.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedLitestreamBook(seq) {
  return (path) => {
    const store = new SqliteStore({ location: path });
    const at = '2026-01-01T00:00:00.000Z';
    const created = createWorkspace({ store, clock: { now: () => at }, ids: systemIdGen, actor: 'seed' }, { name: 'Quelle AG' });
    if (!created.ok) throw new Error('seed failed');
    replicate(store.db, seq);
    store.close();
  };
}
function landscapeDeps(dir, seeders) {
  return {
    supportDir: dir,
    environmentsRoot: join(dir, 'environments'),
    mainDbPath: join(dir, 'main', 'till.db'),
    actor: 'owner',
    now: () => '2026-10-13T00:00:00.000Z',
    seeders,
    ids: systemIdGen,
    clock: { now: () => '2026-10-13T00:00:00.000Z' },
  };
}

for (const sanitize of ['raw', 'pseudonymize', 'structure_synthetic']) {
  test(`critic P6: env_copy (instance, ${sanitize}) of a Litestream SOURCE succeeds and the target carries no tool table`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'critic-tt-'));
    try {
      const deps = landscapeDeps(dir, { ls: seedLitestreamBook(7), minimal: (p) => new SqliteStore({ location: p }).close() });
      assert.equal(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'ls', tierRank: 250, confirmed: true }).ok, true);
      assert.equal(envCreate(deps, { name: 'dst', policy: 'synthetic', seed: 'minimal', tierRank: 40, confirmed: true }).ok, true);
      const res = envCopy(deps, { source: 'src', target: 'dst', scope: 'instance', sanitize, confirmed: true });
      assert.equal(res.ok, true, JSON.stringify(res));
      const t = new Database(join(dir, 'environments', 'dst', 'till.db'), { readonly: true });
      assert.deepEqual(underscoreObjects(t), []);
      t.close();
      const s = new Database(join(dir, 'environments', 'src', 'till.db'), { readonly: true });
      assert.deepEqual(lsRows(s).seq, [{ id: 1, seq: 7 }], 'source untouched');
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('critic P7: env_copy (mandate) INTO a Litestream TARGET keeps the target Litestream rows exactly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-tt-'));
  try {
    const deps = landscapeDeps(dir, { ls: seedLitestreamBook(7), keeper: seedLitestreamBook(42) });
    assert.equal(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'ls', tierRank: 250, confirmed: true }).ok, true);
    assert.equal(envCreate(deps, { name: 'dst', policy: 'synthetic', seed: 'keeper', tierRank: 40, confirmed: true }).ok, true);
    const dstPath = join(dir, 'environments', 'dst', 'till.db');
    const pre = new Database(dstPath, { readonly: true });
    const before = lsRows(pre);
    pre.close();
    assert.deepEqual(before.seq, [{ id: 1, seq: 42 }]);
    const srcDb = new Database(join(dir, 'environments', 'src', 'till.db'), { readonly: true });
    const srcWs = srcDb.prepare('SELECT id FROM workspace LIMIT 1').get().id;
    srcDb.close();
    const res = envCopy(deps, { source: 'src', target: 'dst', scope: `mandate:${srcWs}`, sanitize: 'pseudonymize', confirmed: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    const post = new Database(dstPath, { readonly: true });
    assert.deepEqual(lsRows(post), before, 'the target Litestream rows are exactly as they were');
    assert.equal(post.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, 2);
    post.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('critic P8: TILL_PACKAGE_VERSION reads package.json from the packed-tarball layout, and says unknown without one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-ver-'));
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    // node_modules/tillbooks/{package.json, dist/core/version.js}: the layout `npm pack` ships.
    const inst = join(dir, 'node_modules', 'tillbooks');
    mkdirSync(join(inst, 'dist', 'core'), { recursive: true });
    copyFileSync(join(repoRoot, 'package.json'), join(inst, 'package.json'));
    copyFileSync(join(repoRoot, 'dist', 'core', 'version.js'), join(inst, 'dist', 'core', 'version.js'));
    const m = await import(pathToFileURL(join(inst, 'dist', 'core', 'version.js')).href);
    assert.equal(m.TILL_PACKAGE_VERSION, pkg.version);
    const bare = join(dir, 'bare', 'dist', 'core');
    mkdirSync(bare, { recursive: true });
    copyFileSync(join(repoRoot, 'dist', 'core', 'version.js'), join(bare, 'version.js'));
    const m2 = await import(pathToFileURL(join(bare, 'version.js')).href);
    assert.equal(m2.TILL_PACKAGE_VERSION, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
