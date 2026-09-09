// @ts-check
/**
 * F-06 (J7.2): `list_restorable_backups`, the pre-workspace read behind the first-run restore door.
 *
 * What it must hold: a real `.tillbackup` taken by `create_backup` is listed with its creation time,
 * its schema generation, its entry count and `compatible: true` against this runtime, and the answer
 * names the generation this runtime expects; an EXPORT in the same directory is NOT listed (an
 * export is not a restore source); a directory entry with no manifest, or a manifest that is not a
 * sqlite snapshot, is skipped rather than crashing the read; a missing directory reads as an empty
 * list, never an error; and the read writes nothing (the directory listing is byte-identical after).
 *
 * How it bites when reverted: drop the `.tillbackup` filter and the export row appears (assertion
 * two fails); drop the manifest guard and the garbage entry throws or appears (assertion three);
 * make a missing directory an error and assertion four fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';
import { at, defined, objs } from '../support/narrow.mjs';

/** @param {string} name */
const action = (name) => defined(getAction(name), name);

function world() {
  const deps = freshDeps();
  deps.backupDir = mkdtempSync(join(tmpdir(), 'till-f06-restorable-'));
  const { workspaceId, accId } = mintWorkspace(deps);
  /** @param {string} name @param {Record<string, unknown>} input */
  const call = (name, input) => action(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, accId, call };
}

test('a backup taken by create_backup is listed with its generation, entry count and compatibility; an export is not', () => {
  const w = world();
  assert.equal(w.call('post_entry', manualPost(w.accId, 'r-1', 1000)).ok, true);
  assert.equal(w.call('post_entry', manualPost(w.accId, 'r-2', 2000)).ok, true);
  const backup = w.call('create_backup', { idempotencyKey: 'lrb-bkp' });
  assert.equal(backup.ok, true);
  const exported = w.call('export_workspace', { idempotencyKey: 'lrb-exp' });
  assert.equal(exported.ok, true);

  const before = readdirSync(w.deps.backupDir).sort();
  const listed = action('list_restorable_backups').run(w.deps, {});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.directory, w.deps.backupDir);
  assert.equal(listed.currentSchemaVersion, SCHEMA_GENERATION);
  const backups = objs(listed.backups, 'backups');
  assert.equal(backups.length, 1, 'exactly the one .tillbackup, never the .tillexport');
  const row = at(backups, 0);
  assert.equal(row.source, backup.artifactRef);
  assert.equal(row.schemaVersion, SCHEMA_GENERATION);
  assert.equal(row.compatible, true);
  assert.equal(row.entryCount, 2);
  assert.equal(row.workspaceId, w.workspaceId);
  assert.match(String(row.createdAt), /^\d{4}-\d{2}-\d{2}T/);
  // A pure read: the directory is untouched.
  assert.deepEqual(readdirSync(w.deps.backupDir).sort(), before);
});

test('garbage beside the bundles is skipped, and an incompatible generation is named, not hidden', () => {
  const w = world();
  assert.equal(w.call('create_backup', { idempotencyKey: 'lrb-bkp-2' }).ok, true);
  // A .tillbackup directory with no manifest, a file (not a directory) with the suffix, and a bundle
  // from another generation.
  mkdirSync(join(w.deps.backupDir, 'stray.tillbackup'));
  writeFileSync(join(w.deps.backupDir, 'notadir.tillbackup'), 'x');
  const old = join(w.deps.backupDir, 'old.tillbackup');
  mkdirSync(old);
  writeFileSync(
    join(old, 'manifest.json'),
    JSON.stringify({ format: 'sqlite_snapshot', kind: 'backup', schemaVersion: SCHEMA_GENERATION - 1, tillVersion: '0.0.1', workspaceId: 'ws_old', createdAt: '2020-01-01T00:00:00.000Z', entryCount: 5, files: {}, tables: {} }),
  );
  const listed = action('list_restorable_backups').run(w.deps, {});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const backups = objs(listed.backups, 'backups');
  assert.equal(backups.length, 2);
  const older = defined(backups.find((b) => b.workspaceId === 'ws_old'), 'the older-generation bundle is listed so the door can name it before the act');
  assert.equal(older.compatible, false);
  assert.equal(older.schemaVersion, SCHEMA_GENERATION - 1);
  // Newest first: the bundle taken now precedes the 2020 one.
  assert.notEqual(at(backups, 0).workspaceId, 'ws_old');
});

test('a missing directory is an empty list, never an error (a fresh machine has nothing yet)', () => {
  const deps = freshDeps();
  deps.backupDir = join(mkdtempSync(join(tmpdir(), 'till-f06-none-')), 'does-not-exist');
  const listed = action('list_restorable_backups').run(deps, {});
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.backups, []);
  assert.equal(listed.currentSchemaVersion, SCHEMA_GENERATION);
});
