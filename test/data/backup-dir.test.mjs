// @ts-check
/**
 * F-06 (2026-09-05): the G04 artefact location follows the support dir.
 *
 * DEFECT CLASS: artefact-escapes-the-sandbox. `create_backup` and `export_workspace` wrote every
 * bundle into the developer's real `~/.till/backups` whatever `TILL_SUPPORT_DIR` said (the J7
 * friction run left `backup_*.tillbackup` and `export_*.tillexport` there), and a served instance
 * that mounts its support dir on a volume would have kept its backups off that volume.
 *
 * Three rungs are asserted, most specific first: `TILL_BACKUP_DIR` names the directory outright;
 * otherwise a set `TILL_SUPPORT_DIR` puts the artefacts under `<support>/backups`; otherwise the
 * default `~/.till/backups` stands. And the rung is proven END TO END, not only on the resolver:
 * the registry's `create_backup` and `export_workspace`, with no `backupDir` injected and only the
 * env set, land their bundles under the support dir, and `list_backups` reports that path.
 *
 * How it bites when reverted: with the middle rung removed, `resolveBackupDir` answers
 * `~/.till/backups` under a set support dir, the two `startsWith` assertions fail, and the
 * end-to-end run would write into the developer's home again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { resolveBackupDir } from '../../dist/api/db-path.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';
import { defined, objs } from '../support/narrow.mjs';

test('TILL_BACKUP_DIR names the artefact directory outright, above the support dir', () => {
  const dir = resolveBackupDir({ TILL_BACKUP_DIR: '/vol/explicit', TILL_SUPPORT_DIR: '/vol/support' });
  assert.equal(dir, '/vol/explicit');
});

test('a set TILL_SUPPORT_DIR puts the artefacts under <support>/backups', () => {
  assert.equal(resolveBackupDir({ TILL_SUPPORT_DIR: '/vol/support' }), join('/vol/support', 'backups'));
  // Whitespace is not a directory.
  assert.equal(resolveBackupDir({ TILL_SUPPORT_DIR: '   ' }), resolveBackupDir({}));
});

test('with neither set, the default stays the home directory (a plain local install does not move)', () => {
  const dir = resolveBackupDir({});
  assert.ok(dir.startsWith(homedir()), `expected a home-relative default, got ${dir}`);
  assert.ok(dir.endsWith(join('.till', 'backups')), `expected .../.till/backups, got ${dir}`);
});

test('create_backup and export_workspace, driven through the registry with only the env set, land under the support dir', () => {
  const support = mkdtempSync(join(tmpdir(), 'till-f06-support-'));
  const before = { TILL_SUPPORT_DIR: process.env.TILL_SUPPORT_DIR, TILL_BACKUP_DIR: process.env.TILL_BACKUP_DIR };
  process.env.TILL_SUPPORT_DIR = support;
  delete process.env.TILL_BACKUP_DIR;
  try {
    const deps = freshDeps();
    // Deliberately NO deps.backupDir: this is the host's path, where the env is the only signal.
    const { workspaceId, accId } = mintWorkspace(deps);
    /** @param {string} name @param {Record<string, unknown>} input */
    const call = (name, input) => defined(getAction(name), name).run(deps, { workspaceId, ...input });
    assert.equal(call('post_entry', manualPost(accId, 'f06-p1', 1000)).ok, true);

    const backup = call('create_backup', { idempotencyKey: 'f06-bkp' });
    assert.equal(backup.ok, true, JSON.stringify(backup));
    const exported = call('export_workspace', { idempotencyKey: 'f06-exp' });
    assert.equal(exported.ok, true, JSON.stringify(exported));

    const expectedDir = join(support, 'backups');
    for (const ref of [backup.artifactRef, exported.artifactRef]) {
      assert.equal(typeof ref, 'string');
      assert.ok(String(ref).startsWith(expectedDir + '/'), `artefact ${ref} is not under ${expectedDir}`);
      assert.ok(existsSync(String(ref)), `artefact ${ref} was not written`);
    }
    const listed = call('list_backups', {});
    assert.equal(listed.ok, true);
    const refs = objs(listed.backups, 'backups').map((b) => b.artifactRef);
    assert.ok(refs.every((r) => String(r).startsWith(expectedDir + '/')), `list_backups reports a path outside ${expectedDir}: ${refs}`);
    // And nothing new landed in the real home directory under this key.
    const home = join(homedir(), '.till', 'backups');
    assert.ok(!refs.some((r) => String(r).startsWith(home)), 'an artefact escaped into ~/.till/backups');
  } finally {
    if (before.TILL_SUPPORT_DIR === undefined) delete process.env.TILL_SUPPORT_DIR;
    else process.env.TILL_SUPPORT_DIR = before.TILL_SUPPORT_DIR;
    if (before.TILL_BACKUP_DIR !== undefined) process.env.TILL_BACKUP_DIR = before.TILL_BACKUP_DIR;
    rmSync(support, { recursive: true, force: true });
  }
});
