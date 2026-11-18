/**
 * Critic D207 F1 (16.11.2026): a rule read off a booked line (`set_bank_standard { fromBankTxnId }`, the N03
 * "Als Regel speichern" path and the rule miner) keeps EVERY tax code the booking carries. `bookedShapeOf`
 * grouped the booked lines by account alone and kept the first code, so a split on one account under two
 * codes, or a coded and an uncoded part on one account, became a rule taxing the whole line with one code:
 * over-claimed Vorsteuer (Ziffer 400/405). The legs are now grouped by account AND code.
 *
 * SYNTHETIC BY CONSTRUCTION: invented counterparties and amounts in a fresh in-memory workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { bookBankLine } from '../../dist/core/banking/bankBooking.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { world, importLines, must } from './bank-inbox-support.mjs';

const IBAN = 'CH9300762011623852957';

function oneLine(t, id, amountMinor) {
  return importLines(t, { statementId: id, entries: [{ ref: 'L1', cd: 'DBIT', name: 'Mischwerk Beispiel AG', iban: IBAN, amountMinor, date: '2026-07-14' }] }).lines.L1;
}

const legsOf = (std) => std.legs.map((x) => [x.accountNumber, x.taxCode, x.amount.kind]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));

test('one account under two codes stays two legs, each with its own code', () => {
  const t = world();
  const line = oneLine(t, 'D207-S1', 10000);
  must(
    bookBankLine(t.ctx, {
      bankTxnId: line,
      target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 6000, taxCode: 'VST-M' }, { accountId: t.acc('6570'), amountMinor: 4000, taxCode: 'VST-M26' }] },
      idempotencyKey: 'split-codes',
    }),
  );
  const saved = must(setBankStandard(t.ctx, { fromBankTxnId: line, idempotencyKey: 'from-codes' })).standard;
  assert.deepEqual(legsOf(saved), [
    ['6570', 'VST-M', 'rest'],
    ['6570', 'VST-M26', 'ask'],
  ]);
});

test('a coded part and an uncoded part on one account stay apart: the uncoded part carries no code', () => {
  const t = world();
  const line = oneLine(t, 'D207-S2', 10000);
  must(
    bookBankLine(t.ctx, {
      bankTxnId: line,
      target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 3000, taxCode: 'VST-M' }, { accountId: t.acc('6570'), amountMinor: 7000 }] },
      idempotencyKey: 'split-nocode',
    }),
  );
  const saved = must(setBankStandard(t.ctx, { fromBankTxnId: line, idempotencyKey: 'from-nocode' })).standard;
  const legs = legsOf(saved);
  assert.equal(legs.length, 2);
  assert.deepEqual(legs.find((l) => l[1] === null), ['6570', null, 'rest']);
  assert.deepEqual(legs.find((l) => l[1] === 'VST-M'), ['6570', 'VST-M', 'ask']);
});

test('a single coded leg is unchanged: one rest leg with its code', () => {
  const t = world();
  const line = oneLine(t, 'D207-S3', 5405);
  must(bookBankLine(t.ctx, { bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 5405, taxCode: 'VST-M' }] }, idempotencyKey: 'single' }));
  const saved = must(setBankStandard(t.ctx, { fromBankTxnId: line, idempotencyKey: 'from-single' })).standard;
  assert.deepEqual(legsOf(saved), [['6570', 'VST-M', 'rest']]);
});

test('re-check LOW 2: two asked legs on one account read apart: a coded leg names its number and MWST rate or code', () => {
  const t = world();
  const line = oneLine(t, 'D207-S4', 10000);
  must(
    bookBankLine(t.ctx, {
      bankTxnId: line,
      target: {
        kind: 'accounts',
        legs: [
          { accountId: t.acc('6570'), amountMinor: 5000 },
          { accountId: t.acc('6570'), amountMinor: 3000, taxCode: 'VST-M' },
          { accountId: t.acc('6570'), amountMinor: 2000, taxCode: 'VST-M26' },
        ],
      },
      idempotencyKey: 'three-parts',
    }),
  );
  const saved = must(setBankStandard(t.ctx, { fromBankTxnId: line, idempotencyKey: 'from-three' })).standard;
  const asks = saved.legs.filter((x) => x.amount.kind === 'ask').map((x) => x.amount.label);
  assert.equal(asks.length, 2);
  assert.equal(new Set(asks).size, 2, `the asked labels must differ: ${asks.join(' | ')}`);
  for (const label of asks) {
    assert.match(label, /^6570 .+ · (\d+(\.\d+)? %|VST-[A-Z0-9]+)$/);
    assert.ok(label.length <= 40, label);
  }
});
