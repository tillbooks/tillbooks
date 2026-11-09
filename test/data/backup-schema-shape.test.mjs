/**
 * G04 backups carry their SCHEMA SHAPE (spec G04 §0c items 6 and 7, owner decision 30.09.2026).
 *
 * An additive schema change (a new table, an `ADDITIVE_COLUMNS` column) does not move the generation,
 * so before this a backup a newer TILL wrote passed an older TILL's `verify_backup` and then died
 * INSIDE the restore with a raw `SQLITE_ERROR ... has no column named ...` (critic A31 R2-M1), and an
 * older TILL could not back up a book a newer one had opened at all.
 *
 * "A newer TILL" is simulated exactly the way one looks to this runtime: a book whose schema carries a
 * table and a column this runtime's code does not create (`zz_newer_table`, `contact.zz_newer`), as an
 * additive change of a later release would leave it. Synthetic data only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { schemaShapeOf, schemaFingerprint } from '../../dist/core/store/schemaShape.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { manualPost } from '../api/support.mjs';

const clock = { now: () => '2026-09-30T10:00:00.000Z' };

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

/** What a NEWER TILL leaves in a book it opened: one more table and one more column, with data. */
function upgradeAsNewerTill(b) {
  b.store.db.exec('ALTER TABLE contact ADD COLUMN zz_newer TEXT');
  b.store.db.exec('CREATE TABLE zz_newer_table (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), note TEXT)');
  const c = b.call('create_contact', { partyRole: 'customer', name: 'Neu AG', idempotencyKey: 'c1' });
  assert.equal(c.ok, true, JSON.stringify(c));
  b.store.db.prepare("UPDATE contact SET zz_newer = 'only a newer TILL knows this' WHERE id = ?").run(c.contact.id);
  b.store.db.prepare("INSERT INTO zz_newer_table (id, workspace_id, note) VALUES ('zz_1', ?, 'newer row')").run(b.workspaceId);
}

test('a backup records its shape and fingerprint, read back from the snapshot file by verify_backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-shape-'));
  try {
    const b = book(dir, 'a', '');
    const bkp = b.call('create_backup', { idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));
    const manifest = JSON.parse(readFileSync(join(bkp.artifactRef, 'manifest.json'), 'utf8'));
    const snap = new Database(join(bkp.artifactRef, 'data.sqlite'), { readonly: true });
    const fileShape = schemaShapeOf(snap);
    snap.close();
    assert.deepEqual(manifest.schemaShape, fileShape);
    assert.equal(manifest.schemaFingerprint, schemaFingerprint(fileShape));
    // The snapshot carries the live book's shape exactly (every table, every column).
    assert.deepEqual(fileShape, schemaShapeOf(b.store.db));
    const verified = getAction('verify_backup').run(b.deps, { source: bkp.artifactRef });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.equal(verified.schemaFingerprint, manifest.schemaFingerprint);
    b.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an older TILL backs up a book a newer TILL upgraded, completely; only a TILL that knows that shape restores it, and an older one refuses CLEANLY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-shape-'));
  try {
    const upgraded = book(dir, 'upgraded', 'u');
    upgradeAsNewerTill(upgraded);
    // create_backup used to throw `table contact has no column named zz_newer` here.
    const bkp = upgraded.call('create_backup', { idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));
    const snap = new Database(join(bkp.artifactRef, 'data.sqlite'), { readonly: true });
    assert.equal(snap.prepare("SELECT zz_newer FROM contact WHERE name = 'Neu AG'").get().zz_newer, 'only a newer TILL knows this');
    assert.equal(snap.prepare('SELECT COUNT(*) AS n FROM zz_newer_table').get().n, 1);
    snap.close();

    // A plain book of THIS runtime has no place for the newer table and column: verify names them.
    const plain = book(dir, 'plain', 'p');
    const workspaces = plain.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;
    const verified = getAction('verify_backup').run(plain.deps, { source: bkp.artifactRef });
    assert.equal(verified.ok, false);
    assert.equal(verified.error, 'schema_newer_than_runtime');
    assert.equal(verified.reason, 'schema_shape_newer');
    assert.deepEqual(verified.unknownTables, ['zz_newer_table']);
    assert.deepEqual(verified.unknownColumns, ['contact.zz_newer']);
    assert.equal(verified.partial, false);
    assert.match(verified.message, /newer TILL/);
    assert.match(verified.message, /contact\.zz_newer/);
    // The restore refuses the same way BEFORE anything is created (it used to throw SQLITE_ERROR
    // half-way through the load).
    const restored = getAction('restore_backup').run(plain.deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(restored.ok, false, JSON.stringify(restored));
    assert.equal(restored.error, 'schema_newer_than_runtime');
    assert.equal(restored.reason, 'schema_shape_newer');
    assert.equal(plain.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, workspaces);
    // The first-run door names it before anyone presses restore.
    const listed = getAction('list_restorable_backups').run({ ...plain.deps, backupDir: upgraded.deps.backupDir }, {});
    assert.equal(listed.ok, true, JSON.stringify(listed));
    const entry = listed.backups.find((x) => x.source === bkp.artifactRef);
    assert.equal(entry.compatible, false);
    assert.deepEqual(entry.unknownSchema, ['zz_newer_table', 'contact.zz_newer']);

    // The book that knows the shape restores it, the newer column and table included.
    const back = getAction('restore_backup').run(upgraded.deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal(upgraded.store.db.prepare("SELECT zz_newer FROM contact WHERE workspace_id = ? AND name = 'Neu AG'").get(back.workspaceId).zz_newer, 'only a newer TILL knows this');
    assert.equal(upgraded.store.db.prepare('SELECT note FROM zz_newer_table WHERE workspace_id = ?').get(back.workspaceId).note, 'newer row');
    upgraded.store.close();
    plain.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a backup with FEWER columns (taken before an additive column shipped) restores; the new column takes its default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-shape-'));
  try {
    const older = book(dir, 'older', 'o');
    const bkp = older.call('create_backup', { idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));
    const newer = book(dir, 'newer', 'n');
    upgradeAsNewerTill(newer);
    const restored = getAction('restore_backup').run(newer.deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const rows = newer.store.db.prepare('SELECT zz_newer FROM contact WHERE workspace_id = ?').all(restored.workspaceId);
    assert.ok(rows.every((r) => r.zz_newer === null));
    assert.equal(
      newer.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(restored.workspaceId).n,
      2,
    );
    older.store.close();
    newer.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a backup made BEFORE the shape existed (no schemaShape in its manifest) is judged from its file and restores', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-shape-'));
  try {
    const b = book(dir, 'a', '');
    const bkp = b.call('create_backup', { idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true);
    const path = join(bkp.artifactRef, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    delete manifest.schemaShape;
    delete manifest.schemaFingerprint;
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    const verified = getAction('verify_backup').run(b.deps, { source: bkp.artifactRef });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    const restored = getAction('restore_backup').run(b.deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    b.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manifest whose fingerprint disagrees with its snapshot file is backup_corrupt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-shape-'));
  try {
    const b = book(dir, 'a', '');
    const bkp = b.call('create_backup', { idempotencyKey: 'bk' });
    const path = join(bkp.artifactRef, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.schemaFingerprint = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    const verified = getAction('verify_backup').run(b.deps, { source: bkp.artifactRef });
    assert.equal(verified.ok, false);
    assert.equal(verified.error, 'backup_corrupt');
    assert.equal(verified.reason, 'schema_fingerprint_mismatch');
    b.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
