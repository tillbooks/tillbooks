/**
 * CRITIC PROBES, round 2 (bank-parity E1, the Belegnummer, D178 point 2 and point 18). Non-author.
 * Synthetic by construction: invented bexio-shaped refs, accounts and amounts.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 *  - a G04 restore carries `voucher_ref` and the shared / suffixed numbers of split vouchers, the copy's next
 *    late piece still joins its voucher, and two workspaces may hold the same voucher ref independently;
 *  - a reversal of a piece of a shared-number voucher takes TILL's next number; the pieces keep theirs;
 *  - a refused numbering setting leaves nothing behind (no override, no history, no audit row, no number);
 *  - an accepted change whose catch-up fails rolls the CHANGE back with it (one transaction);
 *  - a voucher mixing labels around one number, or two counters around one number, is adopted by neither.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setup } from '../ledger/support.mjs';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { makeContext } from '../../dist/core/context.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';

function must(r, what = 'call') {
  assert.equal(r.ok, true, `${what}: ${JSON.stringify(r)}`);
  return r;
}

test('[R2 sound] restore carries voucher_ref and split numbers; the copy’s late piece joins its voucher; two workspaces hold one ref apart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e1r2-restore-'));
  try {
    const clock = fixedClock('2026-07-19T00:00:00.000Z');
    const store = new SqliteStore({ clock });
    const ids = systemIdGen;
    const ws = must(createWorkspace({ store, clock, ids }, { name: 'Quelle GmbH' })).workspaceId;
    const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock, ids });
    const acc = (w, n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(w, n).id;
    // ADAPTED in the r2 remediation (author): each piece books its own amount. Real pieces of a split voucher
    // differ; two entries with the same ref AND the same lines are flagged as a possible double import.
    const post = (c, w, ref, key, source = 'import', amount = 700) =>
      must(postEntry(c, { date: '2025-04-01', source, idempotencyKey: key, ...(ref ? { ref } : {}), lines: [
        { account: acc(w, '6500'), debit: amount },
        { account: acc(w, '1020'), credit: amount },
      ] }), key).entryId;
    must(settingsSet(ctx, { key: 'ledger.belegnummer_split_voucher', value: 'suffix', reason: 'Probe', idempotencyKey: 'sfx' }));
    post(ctx, ws, 'Bank Buchung 12 (4401)', 'p1', 'import', 701);
    post(ctx, ws, 'Bank Buchung 12 (4401)', 'p2', 'import', 702);
    post(ctx, ws, 'Manuelle Buchung 3 (4400)', 'm1');
    post(ctx, ws, null, 'n1', 'manual');
    const shape = (w) =>
      store.db
        .prepare('SELECT n.display, n.origin, n.voucher_ref, e.idempotency_key AS k FROM journal_entry_number n JOIN journal_entry e ON e.id = n.entry_id WHERE n.workspace_id = ? ORDER BY e.idempotency_key')
        .all(w)
        .map((r) => `${r.k}:${r.display}:${r.origin}:${r.voucher_ref ?? '-'}`);
    const before = shape(ws);
    // Which piece reads 4401 and which 4401.2 depends on the id tiebreak (see the L-order probe); both are the voucher's.
    assert.deepEqual(before.map((r) => r.replace(/^p[12]:/, 'p:')).sort(), [
      'm1:4400:adopted:Manuelle Buchung 3 (4400)',
      'n1:4402:assigned:-',
      'p:4401.2:adopted:Bank Buchung 12 (4401)',
      'p:4401:adopted:Bank Buchung 12 (4401)',
    ]);

    const deps = { store, clock, ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const bkp = must(createBackup(deps, { workspaceId: ws, idempotencyKey: 'bk' }), 'backup');
    const copy = must(restoreBackup(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie GmbH', confirmed: true }), 'restore').workspaceId;
    assert.deepEqual(shape(copy), before, 'the copy reads the same numbers, origins and voucher refs');

    // A late third piece of the voucher arrives in the COPY: it joins (4401.3), the source is untouched.
    const copyCtx = makeContext(store, { workspaceId: copy, actor: 'user_1', clock, ids });
    post(copyCtx, copy, 'Bank Buchung 12 (4401)', 'p3', 'import', 703);
    assert.ok(shape(copy).includes('p3:4401.3:adopted:Bank Buchung 12 (4401)'), JSON.stringify(shape(copy)));
    assert.deepEqual(shape(ws), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function imp(t, ref, key, amount = 1000) {
  return must(postEntry(t.ctx, { date: '2025-02-03', source: 'import', ref, idempotencyKey: key, lines: [
    { account: t.accounts['6500'], debit: amount },
    { account: t.accounts['1020'], credit: amount },
  ] }), key).entryId;
}
const nat = (t, key) => must(postEntry(t.ctx, { date: '2025-03-01', source: 'manual', idempotencyKey: key, lines: [
  { account: t.accounts['6500'], debit: 100 },
  { account: t.accounts['1000'], credit: 100 },
] }), key).entryId;
const num = (t, id) => t.store.db.prepare('SELECT display, origin FROM journal_entry_number WHERE entry_id = ?').get(id);

test('[R2 sound] reversing one piece of a shared-number voucher: the reversal takes the next number, the pieces keep theirs', () => {
  const t = setup();
  const a = imp(t, 'Manuelle Buchung 9 (300)', 'a', 500);
  const b = imp(t, 'Manuelle Buchung 9 (300)', 'b', 600);
  nat(t, 'n'); // starts the run: 300 shared, n = 301
  const rv = must(reverseEntry(t.ctx, { entryId: b, idempotencyKey: 'rv' })).reversalId;
  assert.deepEqual([num(t, a), num(t, b), num(t, rv)], [
    { display: '300', origin: 'adopted' },
    { display: '300', origin: 'adopted' },
    { display: '302', origin: 'assigned' },
  ]);
});

test('[R2 sound] mixed labels or two counters around one number: no entry adopts it, both follow the run', () => {
  const t = setup();
  const x = imp(t, 'Manuelle Buchung 4 (510)', 'x');
  const y = imp(t, 'Bank Buchung 4 (510)', 'y');
  const z1 = imp(t, 'Manuelle Buchung 5 (511)', 'z1');
  const z2 = imp(t, 'Manuelle Buchung 6 (511)', 'z2');
  nat(t, 'n');
  for (const id of [x, y, z1, z2]) assert.equal(num(t, id).origin, 'assigned', id);
  const shown = t.store.db.prepare('SELECT display, COUNT(*) AS c FROM journal_entry_number GROUP BY display HAVING c > 1').all();
  assert.deepEqual(shown, []);
});

test('[R2 sound] a refused numbering setting leaves nothing; an accepted change whose catch-up fails rolls the change back', () => {
  const t = setup();
  const db = t.store.db;
  const counts = () => ({
    setting: db.prepare('SELECT COUNT(*) AS n FROM workspace_setting').get().n,
    history: db.prepare('SELECT COUNT(*) AS n FROM workspace_setting_change').get().n,
    audit: db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_kind = 'workspace_setting'").get().n,
    numbers: db.prepare('SELECT COUNT(*) AS n FROM journal_entry_number').get().n,
  });
  imp(t, '41', 'w1'); // waits (rule a)
  const before = counts();
  const bad = settingsSet(t.ctx, { key: 'ledger.belegnummer_prefix', value: 'B 7', reason: 'Probe', idempotencyKey: 'bad' });
  assert.equal(bad.error, 'belegnummer_prefix_invalid');
  assert.deepEqual(counts(), before, 'a refusal wrote nothing and started nothing');
  // The same key may be used again once the value is valid (the refusal was not memoised).
  must(settingsSet(t.ctx, { key: 'ledger.belegnummer_prefix', value: 'B-', reason: 'Probe', idempotencyKey: 'bad' }));

  // Fault injection: the catch-up the change runs must fail half-way (a table it reads is gone). The change
  // and everything the catch-up did before failing must roll back together: one transaction.
  // ADAPTED in the r2 remediation (author): a numbering setting change no longer starts the run over import
  // postings alone (critic r2 M2-1), so the owed catch-up here comes from a NATIVE posting made while
  // numbering was off; switching it back on runs that catch-up (which adopts 41) inside the change.
  const t2 = setup();
  must(settingsSet(t2.ctx, { key: 'ledger.belegnummer_mode', value: 'off', reason: 'Probe', idempotencyKey: 'off' }));
  imp(t2, '41', 'w2');
  nat(t2, 'n-off'); // posted while off: the change below owes a catch-up over both
  const db2 = t2.store.db;
  db2.exec('DROP TABLE wage_journal_posts');
  const c2 = () => ({
    setting: db2.prepare("SELECT value_json FROM workspace_setting WHERE key = 'ledger.belegnummer_mode'").get()?.value_json ?? null,
    history: db2.prepare('SELECT COUNT(*) AS n FROM workspace_setting_change').get().n,
    audit: db2.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_kind = 'workspace_setting'").get().n,
    numbers: db2.prepare('SELECT COUNT(*) AS n FROM journal_entry_number').get().n,
    counters: db2.prepare("SELECT COUNT(*) AS n FROM document_number_seq WHERE type = 'journal'").get().n,
    pending: db2.prepare('SELECT COUNT(*) AS n FROM journal_numbering_pending').get().n,
  });
  const b2 = c2();
  assert.equal(b2.pending, 1);
  let r;
  try {
    r = settingsSet(t2.ctx, { key: 'ledger.belegnummer_mode', value: 'continue_migrated', reason: 'Probe', idempotencyKey: 'p' });
  } catch (e) {
    r = { ok: false, thrown: String(e.message) };
  }
  assert.equal(r.ok, false, `premise: the injected fault must fail the change (${JSON.stringify(r)})`);
  assert.deepEqual(c2(), b2, `a failed change left something behind: ${JSON.stringify(r)}`);
});

test('[R2 PROBE L-order] suffix numbers the pieces of a split voucher in the order they were imported', () => {
  // Two pieces posted in one millisecond (one import call), ids from the production generator (random UUIDs).
  let firstGotBase = 0;
  const runs = 24;
  for (let i = 0; i < runs; i += 1) {
    const t = setup({ ids: systemIdGen });
    must(settingsSet(t.ctx, { key: 'ledger.belegnummer_split_voucher', value: 'suffix', reason: 'Probe', idempotencyKey: 'sfx' }));
    const first = imp(t, 'Bank Buchung 77 (900)', 'first', 100);
    imp(t, 'Bank Buchung 77 (900)', 'second', 200);
    nat(t, 'n');
    if (num(t, first).display === '900') firstGotBase += 1;
  }
  assert.equal(firstGotBase, runs, `the first imported piece read 900 in ${firstGotBase} of ${runs} identical books (the rest read 900.2)`);
});
