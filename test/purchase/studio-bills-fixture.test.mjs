/**
 * The A17 STUDIO fixture-versus-engine drift guard, the pairing A16 established.
 *
 * The recordings in `app/src/surfaces/Bills/*.fixture.json` are what `Bills.test.tsx` renders
 * against, and this file is what keeps them the ENGINE's answers rather than an author's: it
 * replays the exact worlds the capture script recorded and compares VALUE for value through
 * `deepEqual`. Keys-and-kinds is not enough; that comparison has passed 6/6 green over fixtures
 * that disagreed with the shipped chart on eight account names.
 *
 * The load-bearing shape claims live here too: the healthy recording carries every display word the
 * row can show, the mismatch recording really fails its reconciliation, and no row carries a field
 * the engine does not send (a surface reading an invented field renders `undefined` under a green
 * unit suite, which is the defect family this whole mechanism exists for).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RESERVED_EXPENSE_ACCOUNTS } from '../../dist/core/purchase/index.js';
import { liveBills, liveMismatch, livePreview, AS_OF } from './studio-bills-world.mjs';

const DIR = new URL('../../app/src/surfaces/Bills/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'));

const LIST = read('list-vendor-bills.fixture.json');
const MISMATCH = read('list-vendor-bills.mismatch.fixture.json');
const PREVIEW = read('vat-preview.fixture.json');

test('the healthy and mismatch recordings are the live answers, value for value', () => {
  assert.deepEqual(LIST, JSON.parse(JSON.stringify(liveBills().list)));
  assert.deepEqual(MISMATCH, JSON.parse(JSON.stringify(liveMismatch())));
});

test('the preview recording is vat_preview own answer, value for value', () => {
  assert.deepEqual(PREVIEW, JSON.parse(JSON.stringify(livePreview())));
});

test('a bill row carries exactly the keys the engine emits, and no invented ones', () => {
  const expected = [
    'amountIsGross',
    'baseGrossMinor',
    'baseNetMinor',
    'baseOpenMinor',
    'basePayableMinor',
    'baseTaxMinor',
    'billDate',
    'bucket',
    'costCenterId',
    'createdAt',
    'currency',
    'daysOverdue',
    'displayStatus',
    'dueDate',
    'entryId',
    'expenseAccountId',
    'expenseAccountName',
    'expenseAccountNumber',
    'fxRate',
    'grossMinor',
    'id',
    'netMinor',
    'openMinor',
    'overdue',
    'paidMinor',
    'payableMinor',
    'postedAt',
    'projectId',
    'receiptRef',
    'reversalEntryId',
    'settlementStatus',
    'status',
    'supplyDate',
    'taxAmountMinor',
    'taxCode',
    'vendorId',
    'vendorName',
    'vendorReference',
    'voidReason',
  ];
  assert.ok(LIST.bills.length > 0, 'the fixture holds no bills at all');
  for (const bill of LIST.bills) {
    assert.deepEqual(Object.keys(bill).sort(), expected, JSON.stringify(bill));
  }
});

test('every display word the row can show is present in the healthy recording', () => {
  const words = new Set(LIST.bills.map((b) => b.displayStatus));
  for (const word of ['draft', 'posted', 'partly_paid', 'paid', 'void']) {
    assert.ok(words.has(word), `no ${word} row: that status chip renders against nothing`);
  }
  // The overdue chip branch too: at least one open row with a positive day count.
  assert.ok(
    LIST.bills.some((b) => b.overdue && b.openMinor > 0),
    'no overdue open row: the days chip is untested',
  );
});

test('the healthy recording reconciles and its figures tie: list total equals the 2000 balance', () => {
  assert.equal(LIST.asOf, AS_OF);
  assert.equal(LIST.reconciled, true);
  assert.equal(LIST.reconciliationDifferenceMinor, 0);
  assert.equal(LIST.filtered, false);
  assert.equal(LIST.baseTotalOpenMinor, LIST.payablesBalanceMinor + LIST.onAccountMinor);
  // The open figures agree row by row with the total the header renders.
  const summed = LIST.bills.filter((b) => b.status === 'posted').reduce((n, b) => n + b.baseOpenMinor, 0);
  assert.equal(summed, LIST.baseTotalOpenMinor);
});

test('the mismatch recording does NOT reconcile, and the difference is signed', () => {
  assert.equal(MISMATCH.reconciled, false);
  assert.notEqual(MISMATCH.reconciliationDifferenceMinor, 0);
  assert.equal(
    MISMATCH.reconciliationDifferenceMinor,
    MISMATCH.workspaceBaseTotalOpenMinor - MISMATCH.onAccountMinor - MISMATCH.payablesBalanceMinor,
  );
});

test('a settled bill stays on the list as paid, and a draft or void bill reports zero open', () => {
  const paid = LIST.bills.find((b) => b.displayStatus === 'paid');
  assert.ok(paid !== undefined);
  assert.equal(paid.openMinor, 0);
  assert.equal(paid.paidMinor, paid.payableMinor);
  for (const b of LIST.bills.filter((x) => x.status !== 'posted')) {
    assert.equal(b.openMinor, 0, `${b.status} bill reports a nonzero open amount`);
    assert.equal(b.paidMinor, 0);
  }
});

test('the Studio reserved-account list IS the engine list, number for number (A17-C3)', () => {
  // The Studio cannot import engine source, so `RESERVED_ACCOUNT_NUMBERS` is re-declared in
  // `app/src/surfaces/Bills/model.ts` and this is what keeps the two identical: the picker must
  // never offer a number the engine refuses, and the engine must never refuse one the picker
  // offers. The Studio literal is read off the DISK, the same way the repo's other source-scanning
  // guards work, and the scan asserts it FOUND the array so a rename cannot pass by matching
  // nothing.
  const source = readFileSync(new URL('model.ts', DIR), 'utf8');
  const match = source.match(/RESERVED_ACCOUNT_NUMBERS = \[([^\]]+)\] as const/);
  assert.ok(match, 'RESERVED_ACCOUNT_NUMBERS array literal not found in app/src/surfaces/Bills/model.ts');
  const studio = [...match[1].matchAll(/'(\d+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(studio, [...RESERVED_EXPENSE_ACCOUNTS].sort());
});

test('the preview recording is the canonical arithmetic and deductible, with the input form line', () => {
  assert.equal(PREVIEW.grossMinor, 108100);
  assert.equal(PREVIEW.netMinor, 100000);
  assert.equal(PREVIEW.taxMinor, 8100);
  assert.equal(PREVIEW.kind, 'input');
  assert.equal(PREVIEW.deductible, true);
  assert.equal(PREVIEW.formLine, '400');
});
