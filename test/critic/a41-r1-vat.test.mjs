// A41 critic round 1 (non-author), probe group 3: A41.4 the VAT figures.
//
// V1 (sound) the tolerance edges: |delta| 5 is a note, 6 is check, both signs.
// V2 computedVatOf sums ABS(tax) per leg, so a booking with a leg that runs AGAINST the line (a discount, a
//    credit inside the same payment) shows a "gerechnet" figure that is not the VAT the booking books; the
//    same for bookedVatOf on a booked line. The flag then compares the receipt with a figure nobody booked.
// V3 (sound) no path books the receipt's VAT: a line booked with an attached receipt that prints another
//    VAT carries the computed VAT.
//
// SYNTHETIC BY CONSTRUCTION: invented vendor, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { compareVat, computedVatOf, bookedVatOf } from '../../dist/core/banking/belegEvidence.js';
import { bookBankLine } from '../../dist/core/banking/bankBooking.js';
import { readBankTxn } from '../../dist/core/banking/bankLines.js';
import { must, world, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { receipt, lines } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

test('V1 sound: 5 Rappen either way is a note, 6 either way is check', () => {
  assert.equal(compareVat(4085, 4080, 5).withinTolerance, true);
  assert.equal(compareVat(4075, 4080, 5).withinTolerance, true);
  assert.equal(compareVat(4086, 4080, 5).withinTolerance, false);
  assert.equal(compareVat(4074, 4080, 5).withinTolerance, false);
  assert.equal(compareVat(4074, 4080, 5).deltaMinor, -6);
});

const signedVatOfEntry = (t, entryId) =>
  t.store.db.prepare('SELECT COALESCE(SUM(tax_amount_minor), 0) AS s, COUNT(*) AS n FROM journal_line WHERE entry_id = ? AND tax_code IS NOT NULL AND tax_amount_minor IS NOT NULL').get(entryId);

test('V2 fixed: a leg against the line reduces the computed VAT exactly as the booking does', () => {
  const t = world();
  const [line] = lines(t, [{ amount: 9000, date: '2026-07-14' }]);
  const target = {
    kind: 'accounts',
    legs: [
      { accountId: t.acc('6570'), amountMinor: 10000, taxCode: 'VST-M' },
      { accountId: t.acc('6570'), amountMinor: -1000, taxCode: 'VST-M' },
    ],
  };
  const shown = computedVatOf(t.ctx, readBankTxn(t.ctx, line), target);
  const booked = must(bookBankLine(t.ctx, { bankTxnId: line, target, idempotencyKey: 'v2' }));
  const entryId = booked.entryId;
  const trace = signedVatOfEntry(t, entryId);
  const net = Math.abs(trace.s);
  assert.ok(trace.n > 0, 'the booking taxes its legs');
  assert.equal(shown, net, `evidence shows "gerechnet" ${shown}, the entry books VAT ${net} (signed sum ${trace.s})`);
  assert.equal(bookedVatOf(t.ctx, entryId), net, `the booked-line figure ${bookedVatOf(t.ctx, entryId)} is not the booked VAT ${net}`);
});

test('V3 sound: a receipt printing another VAT never changes the booked VAT', () => {
  const t = world();
  const r = receipt(t, { amount: 61230, date: '2026-07-15', vat: 4000 });
  const [line] = lines(t, [{ amount: 61230, date: '2026-07-15' }]);
  const target = { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 61230, taxCode: 'VST-M' }] };
  const computed = computedVatOf(t.ctx, readBankTxn(t.ctx, line), target);
  const booked = must(bookBankLine(t.ctx, { bankTxnId: line, target, attach: [{ fileId: r.fileId }], idempotencyKey: 'v3' }));
  assert.equal(Math.abs(signedVatOfEntry(t, booked.entryId).s), computed);
  assert.notEqual(computed, 4000);
});
