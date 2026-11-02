// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  requireString,
  optionalId,
  optionalText,
  requireDate,
  optionalDate,
} from '../../dist/core/ledger/inputGuards.js';

/** The exact refusal shape: the field name echoed back, never a thrown error. */
const refusal = (/** @type {string} */ field) => ({ field, ok: false, error: 'invalid_input' });

test('requireString: a non-empty string passes', () => {
  assert.equal(requireString('x', 'name'), null);
});

test('requireString: empty string, number, null and undefined are refused with the exact shape', () => {
  assert.deepEqual(requireString('', 'name'), refusal('name'));
  assert.deepEqual(requireString(1, 'name'), refusal('name'));
  assert.deepEqual(requireString(null, 'name'), refusal('name'));
  assert.deepEqual(requireString(undefined, 'name'), refusal('name'));
});

test('requireString: other non-string values are refused too', () => {
  for (const value of [0, true, false, {}, [], ['x'], () => 'x', Symbol('s'), 10n]) {
    assert.deepEqual(requireString(value, 'k'), refusal('k'));
  }
});

test('requireString: the field name is echoed back as given', () => {
  assert.deepEqual(requireString('', 'entry.date'), refusal('entry.date'));
  assert.equal(requireString('', 'entry.date')?.field, 'entry.date');
});

test('optionalId: undefined and a non-empty string pass', () => {
  assert.equal(optionalId(undefined, 'accountId'), null);
  assert.equal(optionalId('acc-1', 'accountId'), null);
});

test('optionalId: null and the empty string are refused (absent means undefined, not null)', () => {
  assert.deepEqual(optionalId(null, 'accountId'), refusal('accountId'));
  assert.deepEqual(optionalId('', 'accountId'), refusal('accountId'));
});

test('optionalId: a number or object is refused', () => {
  assert.deepEqual(optionalId(7, 'accountId'), refusal('accountId'));
  assert.deepEqual(optionalId({}, 'accountId'), refusal('accountId'));
});

test('optionalText: undefined and the empty string pass (empty text is allowed)', () => {
  assert.equal(optionalText(undefined, 'memo'), null);
  assert.equal(optionalText('', 'memo'), null);
  assert.equal(optionalText('Miete Oktober', 'memo'), null);
});

test('optionalText: a number is refused, and so is null', () => {
  assert.deepEqual(optionalText(5, 'memo'), refusal('memo'));
  assert.deepEqual(optionalText(null, 'memo'), refusal('memo'));
  assert.deepEqual(optionalText({}, 'memo'), refusal('memo'));
});

test('requireDate accepts real calendar dates, including a leap day', () => {
  for (const date of ['2026-02-28', '2024-02-29', '2026-01-01', '2026-12-31', '2000-02-29']) {
    assert.equal(requireDate(date, 'date'), null, date);
  }
});

test('requireDate refuses dates that are not on the calendar', () => {
  for (const date of ['2026-02-29', '2026-02-30', '2026-13-45', '2026-00-10', '2026-04-31', '2100-02-29', '2026-01-00']) {
    assert.deepEqual(requireDate(date, 'date'), refusal('date'), date);
  }
});

test('requireDate refuses dates that only look right', () => {
  for (const date of ['2026-1-5', '2026-01-05T00:00:00Z', ' 2026-01-05', '2026-01-05 ', '2026/01/05', '05.01.2026', '20260105', '']) {
    assert.deepEqual(requireDate(date, 'date'), refusal('date'), JSON.stringify(date));
  }
});

test('requireDate refuses a Date object, a number, null and undefined', () => {
  assert.deepEqual(requireDate(new Date('2026-01-05T00:00:00Z'), 'date'), refusal('date'));
  assert.deepEqual(requireDate(20260105, 'date'), refusal('date'));
  assert.deepEqual(requireDate(null, 'date'), refusal('date'));
  assert.deepEqual(requireDate(undefined, 'date'), refusal('date'));
});

test('optionalDate: undefined and a valid date pass', () => {
  assert.equal(optionalDate(undefined, 'asOf'), null);
  assert.equal(optionalDate('2026-02-28', 'asOf'), null);
  assert.equal(optionalDate('2024-02-29', 'asOf'), null);
});

test('optionalDate: null and invalid dates are refused', () => {
  assert.deepEqual(optionalDate(null, 'asOf'), refusal('asOf'));
  assert.deepEqual(optionalDate('2026-02-30', 'asOf'), refusal('asOf'));
  assert.deepEqual(optionalDate('2026-02-29', 'asOf'), refusal('asOf'));
  assert.deepEqual(optionalDate('2026-1-5', 'asOf'), refusal('asOf'));
  assert.deepEqual(optionalDate('', 'asOf'), refusal('asOf'));
  assert.deepEqual(optionalDate(20260105, 'asOf'), refusal('asOf'));
  assert.deepEqual(optionalDate(new Date(0), 'asOf'), refusal('asOf'));
});

test('composition with ??: the first refusal wins, null when every guard passes', () => {
  // both pass: the chain yields null
  assert.equal(requireString('a', 'a') ?? optionalId('b', 'b'), null);
  assert.equal(requireString('a', 'a') ?? optionalId(undefined, 'b'), null);
  // first fails: its refusal is returned, the second guard is not consulted
  assert.deepEqual(requireString('', 'a') ?? optionalId('b', 'b'), refusal('a'));
  assert.deepEqual(requireString('', 'a') ?? optionalId('', 'b'), refusal('a'));
  // first passes, second fails
  assert.deepEqual(requireString('a', 'a') ?? optionalId('', 'b'), refusal('b'));
  // a longer chain stops at the first refusal
  assert.deepEqual(
    requireString('a', 'a') ?? requireDate('2026-02-29', 'date') ?? optionalText(5, 'memo'),
    refusal('date'),
  );
  assert.equal(
    requireString('a', 'a') ?? requireDate('2026-02-28', 'date') ?? optionalDate(undefined, 'due') ?? optionalText('', 'memo'),
    null,
  );
});
