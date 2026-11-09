import test from 'node:test';
import assert from 'node:assert/strict';

import {
  money,
  fromFranken,
  toFranken,
  add,
  subtract,
  negate,
  sum,
  isZero,
  equals,
  format,
  MoneyError,
} from '../dist/money.js';

test('rejects a float amount, because floats do not belong on the money path', () => {
  assert.throws(() => money(10.5), MoneyError);
});

test('the classic float defect does not survive contact with Rappen', () => {
  // 0.1 + 0.2 !== 0.3 in floats. In Rappen it is just 10 + 20 === 30.
  const total = add(fromFranken(0.1), fromFranken(0.2));
  assert.equal(total.amount, 30);
  assert.equal(toFranken(total), 0.3);
});

test('fromFranken rounds half away from zero, symmetrically for negatives', () => {
  assert.equal(fromFranken(0.005).amount, 1);
  assert.equal(fromFranken(-0.005).amount, -1);
  // Math.round(-0.5) is -0, which would silently lose a Rappen on every credit.
  assert.equal(fromFranken(-1.005).amount, -101);
});

test('refuses to mix currencies rather than guessing a rate', () => {
  assert.throws(() => add(money(100, 'CHF'), money(100, 'EUR')), MoneyError);
});

test('add and subtract are inverse', () => {
  const a = fromFranken(1234.55);
  const b = fromFranken(99.99);
  assert.ok(equals(subtract(add(a, b), b), a));
});

test('an entry and its reversal sum to zero, which is the whole point', () => {
  const entry = fromFranken(4500.0);
  assert.ok(isZero(sum([entry, negate(entry)])));
});

test('sum of nothing is zero, not NaN', () => {
  assert.ok(isZero(sum([])));
});

test('formats with the Swiss apostrophe separator', () => {
  assert.equal(format(fromFranken(1234.55)), "CHF 1'234.55");
  assert.equal(format(fromFranken(1234567.05)), "CHF 1'234'567.05");
  assert.equal(format(fromFranken(-1234.55)), "-CHF 1'234.55");
  assert.equal(format(fromFranken(0)), 'CHF 0.00');
  assert.equal(format(fromFranken(0.5)), 'CHF 0.50');
});

test('does not group below a thousand', () => {
  assert.equal(format(fromFranken(999.99)), 'CHF 999.99');
});
