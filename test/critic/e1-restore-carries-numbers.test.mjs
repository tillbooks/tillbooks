/**
 * CRITIC PROBES (bank-parity E1, the Belegnummer, D178 point 2). Non-author. Synthetic by construction.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 * PROBE: a G04 backup and restore (the path env_copy and every Testmandant copy also run) carries the
 * Belegnummer run consistently: each restored entry reads the number its original reads, the counter and
 * the catch-up marker come along, the copy continues its own run without a collision or a restart, and
 * the original is untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { makeContext } from '../../dist/core/context.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { postEntry, listJournal } from '../../dist/core/ledger/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';

function must(res, what = 'call') {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

const accountId = (store, ws, number) =>
  store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, number).id;

/** The run as a person reads it: date|ref|description -> display, plus the counter and the marker. */
function runOf(store, ctx, ws) {
  const entries = must(listJournal(ctx, {}), 'list').entries;
  const byKey = Object.fromEntries(entries.map((e) => [`${e.date}|${e.ref ?? ''}|${e.description ?? ''}`, e.number]));
  const counter = store.db.prepare("SELECT year, next_value FROM document_number_seq WHERE workspace_id = ? AND type = 'journal'").all(ws);
  const pending = store.db.prepare('SELECT COUNT(*) AS n FROM journal_numbering_pending WHERE workspace_id = ?').get(ws).n;
  return { byKey, counter, pending };
}

test('[PROBE e1-restore] a restored copy reads the same numbers, carries the counter and the marker, and continues its own run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e1-restore-'));
  try {
    const clock = fixedClock('2026-07-19T00:00:00.000Z');
    const store = new SqliteStore({ clock });
    const ids = systemIdGen;
    const ws = must(createWorkspace({ store, clock, ids }, { name: 'Quelle GmbH' }), 'create').workspaceId;
    const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock, ids });
    const lines = (amount) => [
      { account: accountId(store, ws, '6500'), debit: amount },
      { account: accountId(store, ws, '1020'), credit: amount },
    ];
    const post = (date, key, extra = {}) => must(postEntry(ctx, { date, source: 'manual', idempotencyKey: key, description: key, lines: lines(1000), ...extra }), key);

    post('2026-02-01', 'mig', { source: 'import', ref: '41' });
    post('2026-02-02', 'n1');
    post('2026-02-03', 'n2');
    must(settingsSet(ctx, { key: 'ledger.belegnummer_mode', value: 'off', reason: 'Probe', idempotencyKey: 'off' }), 'off');
    post('2026-02-04', 'while-off');
    // (Author, after critic r1 L2: switching numbering on now catches up at once, so the backup is taken while
    // numbering is still OFF, which is the state in which a marker exists to be carried.)

    const before = runOf(store, ctx, ws);
    assert.deepEqual(Object.values(before.byKey).sort(), ['41', '42', '43', null].sort());
    assert.equal(before.pending, 1);

    const deps = { store, clock, ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const bkp = must(createBackup(deps, { workspaceId: ws, idempotencyKey: 'bk' }), 'backup');
    const restored = must(restoreBackup(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie GmbH', confirmed: true }), 'restore');
    const copyWs = restored.workspaceId;
    const copyCtx = makeContext(store, { workspaceId: copyWs, actor: 'user_1', clock, ids });

    const copied = runOf(store, copyCtx, copyWs);
    assert.deepEqual(copied.byKey, before.byKey, 'every restored entry reads the number its original reads');
    assert.deepEqual(copied.counter, before.counter, 'the counter comes along');
    assert.equal(copied.pending, 1, 'the catch-up marker comes along');

    // The copy continues ITS run: switching numbering on in the copy runs the owed catch-up, then the new post.
    must(settingsSet(copyCtx, { key: 'ledger.belegnummer_mode', value: 'continue_migrated', reason: 'Probe', idempotencyKey: 'copy-on' }), 'copy on');
    must(postEntry(copyCtx, { date: '2026-02-05', source: 'manual', idempotencyKey: 'copy-next', description: 'copy-next', lines: [
      { account: accountId(store, copyWs, '6500'), debit: 500 },
      { account: accountId(store, copyWs, '1020'), credit: 500 },
    ] }), 'copy post');
    const after = runOf(store, copyCtx, copyWs);
    assert.equal(after.byKey['2026-02-04||while-off'], '44');
    assert.equal(after.byKey['2026-02-05||copy-next'], '45');
    assert.equal(after.pending, 0);
    // And the original never moved.
    assert.deepEqual(runOf(store, ctx, ws), before, 'the source is untouched by the copy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
