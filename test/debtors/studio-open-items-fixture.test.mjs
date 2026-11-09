/**
 * The A16 STUDIO fixture-versus-engine drift guard.
 *
 * This closes the mechanism behind a defect family this repo has shipped six times: "the Studio
 * assumed a shape the engine never sends". The cheapest version of it is a fixture more generous
 * than the engine, which agrees with the consumer's bug instead of with the product.
 *
 * ## Three halves, and all of them have to hold
 *
 *  1. PRESENT: the recording is the live answer, VALUE for value, through `deepEqual`. Not keys and
 *     kinds. `test/sales/invoice-gui-fixture.test.mjs` is the reason: a keys-and-kinds comparison let
 *     a fixture spelling Zürich in ASCII sit against a seed spelling it with the umlaut and pass 6/6
 *     green, and the same blindness let eight wrong account names ride in three Studio suites.
 *  2. ABSENT: the engine does NOT send the two fields the design was tempted to read. `OpenItem` has
 *     no `documentNumber` (the field is `number`) and the response has no `truncated`, because
 *     `list_open_items` has no ceiling at all (finding F1). A surface reading either would render
 *     `undefined` while a keys-and-kinds guard stayed green.
 *  3. LOAD-BEARING: the three fixtures differ in the ways the surface branches on. A mismatch
 *     recording that reconciled, or a mixed recording holding one currency, would leave the two
 *     hardest states rendered against a payload that cannot produce them.
 *
 * Every scan asserts its own corpus is non-empty, so a broken path or a renamed file cannot make
 * this file pass by finding nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { liveOpenItems, liveMixedCurrency, liveMismatch, AS_OF } from './studio-open-items-world.mjs';

const DIR = new URL('../../app/src/surfaces/OpenItems/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'));

const LIST = read('list-open-items.fixture.json');
const AGING = read('aging-report.fixture.json');
const BALANCE = read('customer-balance.fixture.json');
const CONFIG = read('aging-bucket-config.fixture.json');
const MIXED = read('list-open-items.mixed.fixture.json');
const MISMATCH = read('list-open-items.mismatch.fixture.json');

test('the four healthy fixtures are the live answers, value for value', () => {
  const live = liveOpenItems();
  assert.deepEqual(LIST, JSON.parse(JSON.stringify(live.items)));
  assert.deepEqual(AGING, JSON.parse(JSON.stringify(live.aging)));
  assert.deepEqual(BALANCE, JSON.parse(JSON.stringify(live.balance)));
  assert.deepEqual(CONFIG, JSON.parse(JSON.stringify(live.config)));
});

test('the mixed-currency and mismatch fixtures are the live answers too', () => {
  assert.deepEqual(MIXED, JSON.parse(JSON.stringify(liveMixedCurrency())));
  assert.deepEqual(MISMATCH, JSON.parse(JSON.stringify(liveMismatch())));
});

test('an open item carries exactly the keys the engine emits, and no invented ones', () => {
  const expected = [
    'baseOpenMinor',
    'bucket',
    // A13/D68: the invoice a credit row offsets, and the invoice row's linked-credit sum.
    'creditedDocumentId',
    'creditedOpenMinor',
    'currency',
    'customerId',
    'customerName',
    'daysOverdue',
    'direction',
    'documentId',
    'dueDate',
    'dunningFeeMinor',
    'dunningLevel',
    'grossMinor',
    'issueDate',
    'kind',
    'number',
    'openMinor',
    'overdue',
    'paidMinor',
    'paymentId',
  ];
  assert.ok(LIST.items.length > 0, 'the fixture holds no items at all');
  for (const item of LIST.items) {
    assert.deepEqual(Object.keys(item).sort(), expected, JSON.stringify(item));
  }
});

test('the response does NOT carry a documentNumber or a truncated flag', () => {
  // `number` is the field, and there is no ceiling on this verb (F1). A surface reading either name
  // would render `undefined` under a passing reconciliation mark, which is the worst place for it.
  for (const item of LIST.items) {
    assert.equal('documentNumber' in item, false);
  }
  assert.equal('truncated' in LIST, false);
  assert.equal('ceiling' in LIST, false);
});

test('the base bucket totals sum to the base grand total, which is what the tiles claim', () => {
  const summed = Object.values(LIST.baseBucketTotals).reduce((n, v) => n + v, 0);
  assert.equal(summed, LIST.baseTotalOpenMinor);
  assert.equal(LIST.currencies.length, 1, 'the healthy fixture is single-currency, so face equals base');
});

test('the healthy fixture holds both parked directions, which is the two-chip branch', () => {
  const parked = LIST.items.filter((i) => i.kind === 'on_account');
  const credit = parked.find((i) => i.direction === 'incoming');
  const refund = parked.find((i) => i.direction === 'outgoing');
  assert.ok(credit !== undefined, 'no incoming parked row: the Guthaben chip is untested');
  assert.ok(refund !== undefined, 'no outgoing parked row: the Rückzahlung chip is untested');
  assert.ok(credit.openMinor < 0, 'an incoming parked row must be negative');
  assert.ok(refund.openMinor > 0, 'an outgoing parked row must be positive');
  assert.ok(parked.every((i) => i.paymentId !== null && i.documentId === null));
});

test('a fully settled invoice is absent from the list, which is D1 acceptance', () => {
  assert.ok(LIST.items.every((i) => i.kind !== 'document' || i.openMinor !== 0));
});

test('every default bucket carries at least one item, so the tile row is exercised at full width', () => {
  const keys = CONFIG.bucketKeys;
  assert.deepEqual(keys, ['0-30', '31-60', '61-90', '90+']);
  for (const key of keys) {
    assert.ok(
      LIST.items.some((i) => i.bucket === key),
      `no item lands in bucket ${key}, so that tile renders against nothing`,
    );
  }
});

test('the healthy fixture reconciles and the mismatch fixture does not', () => {
  assert.equal(LIST.reconciled, true);
  assert.equal(LIST.reconciliationDifferenceMinor, 0);
  assert.equal(MISMATCH.reconciled, false);
  assert.notEqual(MISMATCH.reconciliationDifferenceMinor, 0);
  // The band names a SIGNED difference, so the sign has to survive the recording.
  assert.equal(
    MISMATCH.reconciliationDifferenceMinor,
    MISMATCH.workspaceBaseTotalOpenMinor - MISMATCH.receivablesBalanceMinor,
  );
});

test('the mixed fixture really holds more than one currency', () => {
  assert.ok(MIXED.currencies.length > 1, 'the withheld-amount tiles would never render');
  assert.ok(MIXED.items.some((i) => i.currency !== MIXED.baseCurrency));
});

test('the aging report ranks the largest debtor first and carries a base bucket split', () => {
  assert.ok(AGING.byCustomer.length > 1, 'one customer cannot demonstrate an ordering');
  for (let i = 1; i < AGING.byCustomer.length; i += 1) {
    assert.ok(AGING.byCustomer[i - 1].baseTotalOpenMinor >= AGING.byCustomer[i].baseTotalOpenMinor);
  }
  assert.ok(AGING.byCustomer.every((c) => typeof c.baseByBucket === 'object' || c.baseBucketTotals !== undefined));
  assert.ok('baseByBucket' in AGING, 'the report-level base split is what the tiles would tie to');
});

test('the customer balance carries a signed parked position and the longest overdue span', () => {
  assert.equal(typeof BALANCE.onAccountMinor, 'number');
  assert.ok(BALANCE.oldestOverdueDays > 0);
  assert.ok(BALANCE.items.length > 0);
  assert.equal(BALANCE.asOf, AS_OF);
});

test('the config distinguishes "never set" from "chose these", which the popover renders', () => {
  assert.equal(CONFIG.configured, false);
  assert.deepEqual(CONFIG.boundariesDays, [30, 60, 90]);
});
