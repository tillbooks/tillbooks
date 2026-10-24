/**
 * CRITIC PROBES, round 2 (bank-parity E1, the Belegnummer, D178 point 18). Non-author. Synthetic by
 * construction: invented bexio-shaped refs, accounts and amounts.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 * PROBES on `journal_numbering_plan`, the owner's inspection before trusting a run (A02 §4b.6):
 *  - a bexio voucher imported TWICE (the same lines under two idempotency keys, a re-run import) reads exactly
 *    like a split voucher: both entries share its number and the plan lists it under `splitVouchers`, the
 *    normal case, not as something to look at. "No guessing" is the rule for a plain integer twice; for an
 *    identical bexio ref it is a guess that the second entry is a piece and not a double.
 *  - `duplicates` is documented as "never adopted (no guessing)", but when the two claims arrive in two
 *    batches the first one DID adopt the number, and the plan still lists it as never adopted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { setup } from '../ledger/support.mjs';
import { postEntry, journalNumberingPlan } from '../../dist/core/ledger/index.js';

function must(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function imported(t, ref, key, amount, date = '2025-02-03') {
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
const native = (t, key) =>
  must(postEntry(t.ctx, { date: '2025-03-01', source: 'manual', idempotencyKey: key, lines: [
    { account: t.accounts['6500'], debit: 100 },
    { account: t.accounts['1000'], credit: 100 },
  ] })).entryId;

const row = (t, id) => t.store.db.prepare('SELECT display, origin, voucher_ref FROM journal_entry_number WHERE entry_id = ?').get(id);

test('[R2 PROBE L-double] the same bexio voucher imported twice (identical lines) is not presented as an ordinary split', () => {
  const t = setup();
  const first = imported(t, 'Bank Buchung 41 (8802)', 'run-1:8802', 23450);
  const again = imported(t, 'Bank Buchung 41 (8802)', 'run-2:8802', 23450); // the import re-run under new keys
  native(t, 'n1');
  const plan = must(journalNumberingPlan(t.ctx));
  const listedAsSplit = plan.migrated.splitVouchers.some((s) => s.number === 8802);
  const listedAsDuplicate = plan.migrated.duplicates.some((d) => d.ref === 8802);
  assert.ok(
    listedAsDuplicate || !listedAsSplit,
    `two entries with identical lines under one bexio ref share ${row(t, first).display} / ${row(t, again).display} and the plan files them under splitVouchers only`,
  );
});

test('[R2 PROBE L-dupes] the plan never lists an ADOPTED number as "never adopted"', () => {
  const t = setup();
  const early = imported(t, '7', 'a7', 1000, '2025-01-05');
  native(t, 'n1'); // the run starts: 7 adopted
  const late = imported(t, '7', 'b7', 1100, '2025-01-06'); // a second claim on 7, after the start: next number
  assert.equal(row(t, early).origin, 'adopted');
  assert.equal(row(t, late).origin, 'assigned');
  const plan = must(journalNumberingPlan(t.ctx));
  const listed = plan.migrated.duplicates.find((d) => d.ref === 7);
  assert.ok(
    listed === undefined || !listed.entryIds.includes(early),
    `duplicates (documented "never adopted") lists ${JSON.stringify(listed)}, but ${early} reads adopted Beleg-Nr. ${row(t, early).display}`,
  );
});
