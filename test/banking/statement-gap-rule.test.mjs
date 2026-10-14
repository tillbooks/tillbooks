// A36 §4.7 (D150), THE ONE RULE for the rows at one position (`positionVerdict` in statementGaps.ts),
// narrow critic round 01.10.2026: one test per bullet of the rule, each in BOTH import orders, plus the
// three LOWs of that round (proven to fail on 5c52fb00 by re-run). Hand accounts (no successor rule),
// synthetic fixtures only (`ebics-support.mjs`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup } from './support.mjs';
import { syntheticIban, camt053 } from './ebics-support.mjs';
import { createBankAccount, statementGaps } from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

let seq = 0;
/**
 * A fresh book with statement 4 (closing 10.00) and 6 (opening `sixOpens`), plus the rows of statement
 * 5 imported in the given order. Returns the gap answer without ids.
 */
function verdictOf(rowsOf5, order, { sixOpens = 1500 } = {}) {
  const t = setup();
  seq += 1;
  const n = 300 + seq;
  const iban = syntheticIban(n);
  const id = must(createBankAccount(t.ctx, { name: `Konto ${n}`, iban, ledgerAccountId: t.acc('1020'), idempotencyKey: `ba-${n}` }), 'account').bankAccountId;
  const imp = (xml) => must(importCamt(t.ctx, { bankAccountId: id, xml, idempotencyKey: `imp-${(seq += 1)}` }), 'import');
  imp(camt053({ iban, seq: 4, date: '2026-06-04', opening: 1000 }));
  imp(camt053({ iban, seq: 6, date: '2026-06-06', opening: sixOpens }));
  const rows = rowsOf5(iban);
  for (const xml of order === 'forward' ? rows : [...rows].reverse()) imp(xml);
  return statementGaps(t.ctx, { bankAccountId: id }).map((g) => ({
    after: g.after.number,
    before: g.before.number,
    chains: g.chains,
    confirmable: g.confirmable,
    incomplete: g.after.incomplete === true || g.before.incomplete === true,
    conflicting: g.after.conflicting === true || g.before.conflicting === true,
  }));
}

function bothOrders(rowsOf5, expected, opts) {
  for (const order of ['forward', 'reverse']) assert.deepEqual(verdictOf(rowsOf5, order, opts), expected, order);
}

const day = '2026-06-05';
const PRESENT = [];
const CONFLICT = [{ after: 5, before: 6, chains: false, confirmable: false, incomplete: false, conflicting: true }];
const INCOMPLETE = [{ after: 5, before: 6, chains: false, confirmable: false, incomplete: true, conflicting: false }];

// --- the three LOWs of the narrow round ----------------------------------------------------------

test('LOW (1): a duplicated page with different balances is a conflict, never silently dropped', () => {
  bothOrders(
    (iban) => [
      camt053({ iban, seq: 5, date: day, opening: 1000, entries: [{ minor: 200 }], stmtId: 'S5', msgId: 'M-S5', stmtPage: { number: 1, last: false } }),
      camt053({ iban, seq: 5, date: day, opening: 1200, entries: [{ minor: 300 }], stmtId: 'S5', msgId: 'M-S5', stmtPage: { number: 2, last: true } }),
      // The same page 2 delivered again under another Stmt/Id, with other figures.
      camt053({ iban, seq: 5, date: day, opening: 1200, entries: [{ minor: 900 }], stmtId: 'T5', msgId: 'M-T5', stmtPage: { number: 2, last: true } }),
    ],
    CONFLICT,
  );
});

test('LOW (2): pages that do not chain are a conflict (page 1 of X 10 to 12, page 2 of Y 19 to 25 hides 7.00)', () => {
  bothOrders(
    (iban) => [
      camt053({ iban, seq: 5, date: day, opening: 1000, closing: 1200, stmtId: 'X5', msgId: 'M-X5', stmtPage: { number: 1, last: false } }),
      camt053({ iban, seq: 5, date: day, opening: 1900, closing: 2500, stmtId: 'Y5', msgId: 'M-Y5', stmtPage: { number: 2, last: true } }),
    ],
    CONFLICT,
    { sixOpens: 2500 },
  );
});

test('LOW (3): a whole copy without a closing balance next to a proper copy is ignored, no false conflict', () => {
  bothOrders(
    (iban) => [
      camt053({ iban, seq: 5, date: day, opening: 1000, entries: [{ minor: 500 }], stmtId: 'A5', msgId: 'M-A5' }),
      camt053({ iban, seq: 5, date: day, opening: 1000, entries: [{ minor: 500 }], stmtId: 'B5', msgId: 'M-B5', noClosing: true }),
    ],
    PRESENT,
  );
});

// --- one test per bullet of the rule ---------------------------------------------------------------

test('bullet 1, ignored: a candidate without both balances takes no part; alone it leaves the number INCOMPLETE, never complete', () => {
  bothOrders((iban) => [camt053({ iban, seq: 5, date: day, opening: 1000, stmtId: 'A5', msgId: 'M-A5', noClosing: true })], INCOMPLETE);
});

test('bullet 2, the split: identical duplicate pages collapse; pages 1..n chained and the last marked is complete', () => {
  bothOrders(
    (iban) => [
      camt053({ iban, seq: 5, date: day, opening: 1000, closing: 1200, stmtId: 'S5', msgId: 'M-S5', stmtPage: { number: 1, last: false } }),
      camt053({ iban, seq: 5, date: day, opening: 1200, closing: 1500, stmtId: 'S5', msgId: 'M-S5', stmtPage: { number: 2, last: true } }),
      camt053({ iban, seq: 5, date: day, opening: 1200, closing: 1500, stmtId: 'T5', msgId: 'M-T5', stmtPage: { number: 2, last: true } }),
    ],
    PRESENT,
  );
});

test('bullet 2, the split: a missing page is an incomplete candidate, and the number is INCOMPLETE', () => {
  bothOrders(
    (iban) => [
      camt053({ iban, seq: 5, date: day, opening: 1000, closing: 1200, stmtId: 'S5', msgId: 'M-S5', stmtPage: { number: 1, last: false } }),
      camt053({ iban, seq: 5, date: day, opening: 1300, closing: 1500, stmtId: 'S5', msgId: 'M-S5', stmtPage: { number: 3, last: true } }),
    ],
    INCOMPLETE,
  );
});

test('bullet 3, the verdict: two complete candidates that disagree are a conflict; agreeing ones are complete', () => {
  bothOrders(
    (iban) => [
      camt053({ iban, seq: 5, date: day, opening: 1000, entries: [{ minor: 500 }], stmtId: 'A5', msgId: 'M-A5' }),
      camt053({ iban, seq: 5, date: day, opening: 1000, closing: 1200, stmtId: 'S5', msgId: 'M-S5', stmtPage: { number: 1, last: false } }),
      camt053({ iban, seq: 5, date: day, opening: 1200, closing: 1900, stmtId: 'S5', msgId: 'M-S5', stmtPage: { number: 2, last: true } }),
    ],
    CONFLICT,
  );
  bothOrders(
    (iban) => [
      camt053({ iban, seq: 5, date: day, opening: 1000, entries: [{ minor: 500 }], stmtId: 'A5', msgId: 'M-A5' }),
      camt053({ iban, seq: 5, date: day, opening: 1000, closing: 1200, stmtId: 'S5', msgId: 'M-S5', stmtPage: { number: 1, last: false } }),
      camt053({ iban, seq: 5, date: day, opening: 1200, closing: 1500, stmtId: 'S5', msgId: 'M-S5', stmtPage: { number: 2, last: true } }),
    ],
    PRESENT,
  );
});
