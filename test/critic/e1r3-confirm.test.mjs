/**
 * CRITIC PROBES, round-3 confirmation pass (bank-parity E1, the Belegnummer; the L3-2 table
 * `journal_number_withheld`). Non-author. Synthetic by construction: invented refs, accounts and amounts.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 *  - [R3C sound] withheld numbers never open a gap in TILL's ASSIGNED run, the table is tenant-scoped, a
 *    restore carries it, and the read-only plan never writes it.
 *  - [R3C PROBE L-top] a number withheld at the TOP of the migrated range (the highest old number is
 *    contested: a plain integer claimed twice, or two different vouchers) is not skipped when the run starts.
 *    The run starts at highest ADOPTED + 1, so TILL hands that very old number to its first assigned entry,
 *    and a Beleg-Nr. then equals an old voucher number that names other bookings (the round-1 M1 class).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setup } from '../ledger/support.mjs';
import { postEntry, journalNumberingPlan } from '../../dist/core/ledger/index.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { makeContext } from '../../dist/core/context.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';

function must(r, what = 'call') {
  assert.equal(r.ok, true, `${what}: ${JSON.stringify(r)}`);
  return r;
}
function imp(t, ref, key, amount, date) {
  return must(postEntry(t.ctx, { date, source: 'import', ref, description: `Beleg ${key}`, idempotencyKey: key, lines: [
    { account: t.accounts['6500'], debit: amount },
    { account: t.accounts['1020'], credit: amount },
  ] }), key).entryId;
}
const nat = (t, key, date = '2025-12-01') =>
  must(postEntry(t.ctx, { date, source: 'manual', idempotencyKey: key, lines: [
    { account: t.accounts['6500'], debit: 100 },
    { account: t.accounts['1000'], credit: 100 },
  ] }), key).entryId;
const row = (t, id) => t.store.db.prepare('SELECT display, origin FROM journal_entry_number WHERE entry_id = ?').get(id) ?? null;

test('[R3C sound] withheld numbers never open a gap in the assigned run; the plan never writes them; tenant-scoped', () => {
  const t = setup();
  imp(t, '5', 'a5', 500, '2025-01-05');
  imp(t, '5', 'b5', 501, '2025-01-06'); // a plain integer twice: 5 withheld
  imp(t, '9', 'a9', 900, '2025-01-09');
  const before = t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_number_withheld').get().n;
  must(journalNumberingPlan(t.ctx)); // a read: writes nothing
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_number_withheld').get().n, before);
  nat(t, 'n1');
  for (let i = 2; i <= 6; i += 1) nat(t, `n${i}`);
  imp(t, '5', 'c5', 502, '2025-01-07'); // a late third claim: 5 stays withheld
  const assigned = t.store.db.prepare("SELECT number FROM journal_entry_number WHERE origin = 'assigned' ORDER BY number").all().map((r) => r.number);
  for (let i = 1; i < assigned.length; i += 1) assert.equal(assigned[i], assigned[i - 1] + 1, `gap in ${assigned.join(',')}`);
  assert.deepEqual(t.store.db.prepare('SELECT workspace_id, series, number FROM journal_number_withheld').all(), [{ workspace_id: 'ws_1', series: 'all', number: 5 }]);
});

test('[R3C sound] a backup and restore carry the withheld numbers, so the copy keeps refusing them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e1r3c-'));
  try {
    const clock = fixedClock('2026-07-19T00:00:00.000Z');
    const store = new SqliteStore({ clock });
    const ws = must(createWorkspace({ store, clock, ids: systemIdGen }, { name: 'Quelle GmbH' })).workspaceId;
    const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock, ids: systemIdGen });
    const acc = (w, n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(w, n).id;
    const post = (c, w, source, ref, key, amount) =>
      must(postEntry(c, { date: '2025-03-01', source, ...(ref ? { ref } : {}), idempotencyKey: key, lines: [
        { account: acc(w, '6500'), debit: amount },
        { account: acc(w, '1020'), credit: amount },
      ] }), key).entryId;
    post(ctx, ws, 'import', '7', 'a7', 70);
    post(ctx, ws, 'import', '7', 'b7', 71);
    post(ctx, ws, 'import', '20', 'a20', 200);
    post(ctx, ws, 'manual', null, 'n1', 10);
    const deps = { store, clock, ids: systemIdGen, actor: 'user_1', backupDir: join(dir, 'b') };
    const bkp = must(createBackup(deps, { workspaceId: ws, idempotencyKey: 'bk' }), 'backup');
    const copy = must(restoreBackup(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie GmbH', confirmed: true }), 'restore').workspaceId;
    assert.deepEqual(store.db.prepare('SELECT series, number FROM journal_number_withheld WHERE workspace_id = ?').all(copy), [{ series: 'all', number: 7 }]);
    const copyCtx = makeContext(store, { workspaceId: copy, actor: 'user_1', clock, ids: systemIdGen });
    const late = post(copyCtx, copy, 'import', '7', 'c7', 72);
    assert.equal(store.db.prepare('SELECT origin FROM journal_entry_number WHERE entry_id = ?').get(late).origin, 'assigned');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[R3C sound] the Testmandant hard delete removes only the sandbox’s withheld rows; the live book keeps its own and the guards come back biting', async () => {
  const { hardDeleteWorkspace } = await import('../../dist/core/migration/index.js');
  const clock = fixedClock('2026-07-19T00:00:00.000Z');
  const store = new SqliteStore({ clock });
  const mk = (name) => {
    const ws = must(createWorkspace({ store, clock, ids: systemIdGen }, { name })).workspaceId;
    return { ws, ctx: makeContext(store, { workspaceId: ws, actor: 'user_1', clock, ids: systemIdGen }) };
  };
  const live = mk('Live GmbH');
  const sandbox = mk('Sandbox GmbH');
  const acc = (w, n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(w, n).id;
  for (const { ws, ctx } of [live, sandbox]) {
    for (const [source, ref, key] of [['import', '6', 'a6'], ['import', '6', 'b6'], ['manual', null, 'n1']]) {
      must(postEntry(ctx, { date: '2025-03-01', source, ...(ref ? { ref } : {}), idempotencyKey: key, lines: [
        { account: acc(ws, '6500'), debit: 50 },
        { account: acc(ws, '1020'), credit: 50 },
      ] }), key);
    }
  }
  const withheld = (w) => store.db.prepare('SELECT number FROM journal_number_withheld WHERE workspace_id = ?').all(w).map((r) => r.number);
  assert.deepEqual([withheld(live.ws), withheld(sandbox.ws)], [[6], [6]]);
  store.tx(() => hardDeleteWorkspace(sandbox.ctx, sandbox.ws));
  assert.deepEqual([withheld(live.ws), withheld(sandbox.ws)], [[6], []], 'only the sandbox lost its row');
  const guards = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'journal_number_withheld' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(guards, ['journal_number_withheld_no_delete', 'journal_number_withheld_no_update']);
  assert.throws(() => store.db.prepare('DELETE FROM journal_number_withheld WHERE workspace_id = ?').run(live.ws), /entry_number_immutable/);
  // And the live book still refuses a late claim on its withheld 6.
  const late = must(postEntry(live.ctx, { date: '2025-03-02', source: 'import', ref: '6', idempotencyKey: 'c6', lines: [
    { account: acc(live.ws, '6500'), debit: 60 },
    { account: acc(live.ws, '1020'), credit: 60 },
  ] })).entryId;
  assert.equal(store.db.prepare('SELECT origin FROM journal_entry_number WHERE entry_id = ?').get(late).origin, 'assigned');
  store.close();
});

test('[R3C PROBE L-top] a contested TOP old number is skipped by the run, never handed to a TILL-assigned entry', () => {
  const t = setup();
  // The old journal: vouchers 1 and 2, and the last voucher 3 migrated as two entries with a plain ref (a plain
  // integer is not splittable, so 3 is withheld). Plus the engine's opening balance, dated at the year start.
  must(postEntry(t.ctx, { date: '2025-01-01', source: 'import', idempotencyKey: 'opening-balances:2025:ob', lines: [
    { account: t.accounts['1000'], debit: 5000 },
    { account: t.accounts['1020'], credit: 5000 },
  ] }));
  imp(t, '1', 'v1', 100, '2025-01-03');
  imp(t, '2', 'v2', 200, '2025-01-04');
  imp(t, '3', 'v3a', 300, '2025-01-05');
  imp(t, '3', 'v3b', 301, '2025-01-05');
  nat(t, 'first-own'); // the run starts
  const three = t.store.db.prepare("SELECT e.ref, e.source, e.idempotency_key AS k FROM journal_entry_number n JOIN journal_entry e ON e.id = n.entry_id WHERE n.display = '3'").all();
  assert.deepEqual(
    three.filter((r) => r.ref !== '3'),
    [],
    `Beleg-Nr. 3, an old voucher number two migrated entries still claim, was handed to ${JSON.stringify(three)}`,
  );
  // FLIPPED to the fix (author, critic's setup kept): the run starts above the highest CLAIMED old number,
  // so the withheld 3 is read by nobody and TILL's assigned run is 4..7, gap-free.
  assert.deepEqual(three, [], 'nobody reads the contested old number 3');
  const run = t.store.db
    .prepare("SELECT n.number, n.origin, e.idempotency_key AS k FROM journal_entry_number n JOIN journal_entry e ON e.id = n.entry_id ORDER BY n.number, e.rowid")
    .all()
    .map((r) => `${r.number}:${r.origin}:${r.k}`);
  assert.deepEqual(run, ['1:adopted:v1', '2:adopted:v2', '4:assigned:opening-balances:2025:ob', '5:assigned:v3a', '6:assigned:v3b', '7:assigned:first-own']);
  const plan = must(journalNumberingPlan(t.ctx));
  assert.equal(plan.series.find((s) => s.series === 'all').nextNumber, 8);
  assert.deepEqual(plan.migrated.duplicates.map((d) => [d.ref, d.reason]), [[3, 'conflict']]);
});
