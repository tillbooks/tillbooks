/**
 * NON-AUTHOR critic probe (backup-tool-tables, 13.10.2026): a REAL legacy backup, not a simulated one.
 *
 * The author's suite fakes "a backup taken the old way" by editing a new backup's file and manifest.
 * This probe instead takes the backup with the PRE-FIX engine (develop 65aaca9c, built to a separate
 * dist whose path is given in TILL_CRITIC_OLD_DIST) from a synthetic Litestream book, then verifies
 * and restores it with THIS branch's engine into a fresh install. Skipped when the env var is absent.
 *
 *   git archive 65aaca9c src tsconfig.json package.json | tar -x -C <dir>; (cd <dir>; tsc -p .)
 *   TILL_CRITIC_OLD_DIST=<dir>/dist node --test test/critic/backup-tool-tables-prefix-legacy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { schemaFingerprint, schemaShapeOf } from '../../dist/core/store/schemaShape.js';

const OLD = process.env.TILL_CRITIC_OLD_DIST;
const clock = { now: () => '2026-10-13T10:00:00.000Z' };

test('critic P9: a backup the PRE-FIX engine took of a Litestream book verifies and restores on this branch', { skip: OLD === undefined }, async () => {
  const oldReg = await import(pathToFileURL(join(OLD, 'api', 'registry.js')).href);
  const oldStoreMod = await import(pathToFileURL(join(OLD, 'core', 'store', 'sqlite-store.js')).href);
  const oldIds = await import(pathToFileURL(join(OLD, 'core', 'ids.js')).href);
  const dir = mkdtempSync(join(tmpdir(), 'critic-legacy-'));
  try {
    // The owner's situation: a book on the OLD engine, replicated by Litestream, backed up.
    const oldStore = new oldStoreMod.SqliteStore({ location: join(dir, 'owner.sqlite'), clock });
    const g = oldIds.sequenceIdGen();
    const oldDeps = { store: oldStore, clock, ids: { next: (p) => `o${g.next(p)}` }, actor: 'user_1', backupDir: join(dir, 'owner-backups') };
    const ws = oldReg.getAction('create_workspace').run(oldDeps, { name: 'Owner GmbH', idempotencyKey: 'ws' });
    assert.equal(ws.ok, true, JSON.stringify(ws));
    const acc = (n) => oldStore.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws.workspaceId, n).id;
    const post = oldReg.getAction('post_entry').run(oldDeps, {
      workspaceId: ws.workspaceId,
      idempotencyKey: 'p1',
      date: '2026-03-01',
      description: 'Bareinlage',
      source: 'manual',
      lines: [
        { account: acc('1000'), debit: 50000 },
        { account: acc('2800'), credit: 50000 },
      ],
    });
    assert.equal(post.ok, true, JSON.stringify(post));
    oldStore.db.exec('CREATE TABLE IF NOT EXISTS _litestream_seq (id INTEGER PRIMARY KEY, seq INTEGER);');
    oldStore.db.exec('CREATE TABLE IF NOT EXISTS _litestream_lock (id INTEGER);');
    oldStore.db.exec('INSERT INTO _litestream_seq (id, seq) VALUES (1, 17)');
    const bkp = oldReg.getAction('create_backup').run(oldDeps, { workspaceId: ws.workspaceId, idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));
    oldStore.close();

    // The defect, reproduced with the real old artifact: its file and manifest name the tool tables.
    const manifest = JSON.parse(readFileSync(join(bkp.artifactRef, 'manifest.json'), 'utf8'));
    assert.ok('_litestream_seq' in manifest.schemaShape, 'the pre-fix manifest named the Litestream table');
    const snap = new Database(join(bkp.artifactRef, 'data.sqlite'), { readonly: true });
    assert.equal(manifest.schemaFingerprint, schemaFingerprint(schemaShapeOf(snap, { includeForeignTables: true })));
    assert.equal(snap.prepare('SELECT COUNT(*) AS n FROM _litestream_seq').get().n, 0, 'old copy took the DDL, no rows');
    snap.close();

    // The fix: the new engine on a fresh install verifies and restores it, balance re-verified.
    const fresh = new SqliteStore({ location: join(dir, 'fresh.sqlite'), clock });
    const g2 = sequenceIdGen();
    const deps = { store: fresh, clock, ids: { next: (p) => `f${g2.next(p)}` }, actor: 'user_1', backupDir: join(dir, 'fresh-backups') };
    const v = getAction('verify_backup').run(deps, { source: bkp.artifactRef });
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.balanceOk, true);
    assert.equal(v.entryCount, 1);
    const r = getAction('restore_backup').run(deps, { source: bkp.artifactRef, newWorkspaceName: 'Wiederhergestellt AG', confirmed: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    const sums = fresh.db
      .prepare('SELECT SUM(base_debit_minor) AS d, SUM(base_credit_minor) AS c FROM journal_line WHERE entry_id IN (SELECT id FROM journal_entry WHERE workspace_id = ? AND status = ?)')
      .get(r.workspaceId, 'posted');
    assert.deepEqual(sums, { d: 50000, c: 50000 });
    assert.equal(fresh.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '\\_%' ESCAPE '\\'").get().n, 0);
    fresh.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
