/**
 * CRITIC PROBES (bank-parity E1, the Belegnummer, D178 point 2), round 1, finding M1. Written by the
 * non-author critic; kept as REGRESSION TESTS by the author after the fix, with the assertions' intent
 * unchanged: under the default `continue_migrated`, a migrated bexio voucher keeps its bexio number however
 * and whenever the old journal is imported. Synthetic by construction: invented accounts, refs and amounts
 * on an in-memory store.
 *
 * The fix (A02 §4b.3):
 *  (a) an import posting never STARTS the continuous series: it waits on the pending marker, and the first
 *      non-import posting (or a change of a numbering setting) starts the series with ONE adoption batch;
 *  (b) once the series runs, a migrated voucher still adopts its number when that number is FREE in the series
 *      and BELOW the run's next number; otherwise it takes the next number and keeps its ref in `ref`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setup } from '../ledger/support.mjs';
import { postEntry, listJournal, setOpeningBalances, journalNumberingPlan } from '../../dist/core/ledger/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';

function must(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function bexio(t, ref, date, key, amount = 1000) {
  return must(
    postEntry(t.ctx, {
      date,
      source: 'import',
      ref,
      idempotencyKey: key,
      lines: [
        { account: t.accounts['6500'], debit: amount },
        { account: t.accounts['1020'], credit: amount },
      ],
    }),
  ).entryId;
}

function native(t, date, key) {
  return must(
    postEntry(t.ctx, {
      date,
      source: 'manual',
      idempotencyKey: key,
      lines: [
        { account: t.accounts['6500'], debit: 100 },
        { account: t.accounts['1000'], credit: 100 },
      ],
    }),
  ).entryId;
}

function openingBalance(t) {
  must(
    setOpeningBalances(t.ctx, {
      asOf: '2026-01-01',
      lines: [
        { account: '1000', debitMinor: 50000 },
        { account: '1020', creditMinor: 50000 },
      ],
      idempotencyKey: 'ob',
    }),
  );
  return t.store.db.prepare("SELECT id FROM journal_entry WHERE idempotency_key LIKE 'opening-balances:%'").get().id;
}

const numberOf = (store, entryId) =>
  store.db.prepare('SELECT display FROM journal_entry_number WHERE entry_id = ?').get(entryId)?.display ?? null;

test('[PROBE e1-M1a] opening balance first, then the bexio journal: every migrated entry keeps its bexio number', () => {
  const t = setup();
  // The usual cutover order: A04's opening position first (source import, the engine's own key).
  const ob = openingBalance(t);
  // Then the old system's journal, each with its bexio Belegnummer in ref.
  const a = bexio(t, '501', '2026-01-05', 'bx-501');
  const b = bexio(t, '502', '2026-01-06', 'bx-502');
  const c = bexio(t, '510', '2026-01-09', 'bx-510');
  // (a) The imports wait: nothing has started the run, and the plan says a catch-up is owed.
  assert.deepEqual([ob, a, b, c].map((id) => numberOf(t.store, id)), [null, null, null, null]);
  const plan = must(journalNumberingPlan(t.ctx));
  assert.equal(plan.pending, true);
  assert.deepEqual(
    plan.wouldAssign.map((w) => [w.entryId, w.display, w.origin]),
    [
      [ob, '511', 'assigned'],
      [a, '501', 'adopted'],
      [b, '502', 'adopted'],
      [c, '510', 'adopted'],
    ],
  );
  // The first non-import posting starts the run with the one adoption batch.
  const n = native(t, '2026-02-01', 'n1');
  assert.deepEqual(
    [numberOf(t.store, a), numberOf(t.store, b), numberOf(t.store, c)],
    ['501', '502', '510'],
    'continue_migrated: migrated entries keep their old plain-integer number',
  );
  assert.equal(numberOf(t.store, ob), '511');
  assert.equal(numberOf(t.store, n), '512');
  assert.equal(must(journalNumberingPlan(t.ctx)).pending, false);
});

test('[PROBE e1-M1 workaround, passes] numbering off during the import, on afterwards: the adoption runs once over the whole import', () => {
  const t = setup();
  must(settingsSet(t.ctx, { key: 'ledger.belegnummer_mode', value: 'off', reason: 'Datenübernahme', idempotencyKey: 'off' }));
  openingBalance(t);
  const a = bexio(t, '501', '2026-01-05', 'bx-501');
  const b = bexio(t, '502', '2026-01-06', 'bx-502');
  const c = bexio(t, '510', '2026-01-09', 'bx-510');
  must(settingsSet(t.ctx, { key: 'ledger.belegnummer_mode', value: 'continue_migrated', reason: 'Datenübernahme fertig', idempotencyKey: 'on' }));
  const n = native(t, '2026-02-01', 'n1');
  assert.deepEqual([numberOf(t.store, a), numberOf(t.store, b), numberOf(t.store, c)], ['501', '502', '510']);
  // The opening balance (dated first) and the native post follow the highest adopted, in date order.
  assert.equal(numberOf(t.store, n), '512');
});

test('[PROBE e1-M1b] the bexio journal first: a TILL Beleg-Nr. never names a DIFFERENT bexio voucher', () => {
  const t = setup();
  const v501 = bexio(t, '501', '2026-01-05', 'bx-501');
  const v510 = bexio(t, '510', '2026-01-09', 'bx-510');
  const v503 = bexio(t, '503', '2026-01-07', 'bx-503');
  native(t, '2026-02-01', 'n1');
  const shown = { v501: numberOf(t.store, v501), v510: numberOf(t.store, v510), v503: numberOf(t.store, v503) };
  assert.deepEqual(shown, { v501: '501', v510: '510', v503: '503' });
  // Looking up "Beleg-Nr. 502" must not land on bexio voucher 510.
  const hit = must(listJournal(t.ctx, { number: '502' })).entries;
  assert.ok(
    hit.every((e) => e.ref === null || e.ref === '502'),
    `Beleg-Nr. 502 resolves to the entry whose bexio voucher is ${hit.map((e) => e.ref).join(', ')} (numbers shown: ${JSON.stringify(shown)})`,
  );
  // When bexio's real voucher 502 arrives AFTER the run started (rule b), it still keeps 502: free and below
  // the run's next number (512).
  const v502 = bexio(t, '502', '2026-01-06', 'bx-502');
  assert.equal(numberOf(t.store, v502), '502');
  assert.deepEqual(must(listJournal(t.ctx, { number: '502' })).entries.map((e) => e.id), [v502]);
});

test('[e1-M1 rule b] after the run started: a free lower ref is adopted; a taken, a duplicate or a higher ref takes the next number', () => {
  const t = setup();
  bexio(t, '501', '2026-01-05', 'bx-501');
  bexio(t, '510', '2026-01-09', 'bx-510');
  const n1 = native(t, '2026-02-01', 'n1'); // starts the run: 501, 510 adopted; n1 = 511
  assert.equal(numberOf(t.store, n1), '511');
  const free = bexio(t, '505', '2026-01-07', 'bx-505'); // free, below 512: adopted, counter stays
  const taken = bexio(t, '501', '2026-01-08', 'bx-501-again'); // 501 is taken: next number
  const higher = bexio(t, '700', '2026-01-10', 'bx-700'); // above the run: next number, never a future clash
  const word = bexio(t, 'B-9', '2026-01-11', 'bx-word'); // not a plain integer: next number
  const n2 = native(t, '2026-02-02', 'n2');
  assert.deepEqual(
    [free, taken, higher, word, n2].map((id) => numberOf(t.store, id)),
    ['505', '512', '513', '514', '515'],
  );
  const origins = Object.fromEntries(
    t.store.db.prepare('SELECT entry_id, origin FROM journal_entry_number').all().map((r) => [r.entry_id, r.origin]),
  );
  assert.equal(origins[free], 'adopted');
  assert.equal(origins[taken], 'assigned');
  assert.equal(origins[higher], 'assigned');
  // TILL's own run (assigned) stays gap-free: 511 to 515.
  const assigned = t.store.db
    .prepare("SELECT number FROM journal_entry_number WHERE origin = 'assigned' ORDER BY number")
    .all()
    .map((r) => r.number);
  assert.deepEqual(assigned, [511, 512, 513, 514, 515]);
  // The refs stay as the old system wrote them.
  assert.equal(t.store.db.prepare('SELECT ref FROM journal_entry WHERE id = ?').get(higher).ref, '700');
});

test('[e1-M1 rule a] a wage journal or an opening balance alone never starts the run; a non-continuous mode is unaffected', () => {
  const t = setup();
  const ob = openingBalance(t);
  assert.equal(numberOf(t.store, ob), null, 'continue_migrated: the engine import waits like a migrated one');
  must(settingsSet(t.ctx, { key: 'ledger.belegnummer_mode', value: 'from_start', reason: 'Lauf ab 1', idempotencyKey: 'fs' }));
  // The mode change itself runs the owed catch-up (critic r1 L2): the waiting opening balance is numbered.
  assert.equal(numberOf(t.store, ob), '1', 'the waiting opening balance is caught up by the change');
  const imp = bexio(t, '900', '2026-01-03', 'bx-900');
  assert.equal(numberOf(t.store, imp), '2', 'from_start numbers an import at once and never adopts');
});
