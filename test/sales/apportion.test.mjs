// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { apportionNet } from '../../dist/core/sales/apportion.js';

/** @param {readonly number[]} xs */
const sum = (xs) => xs.reduce((n, v) => n + v, 0);

// Fixed, synthetic case list: integer Rappen amounts and non-negative integer weights.
const AMOUNTS = [0, 1, 2, 3, 5, 7, 10, 99, 100, 101, 999, 1_000, 12_345, 100_000, 7_654_321];
const WEIGHT_SETS = [
  [1],
  [1, 1],
  [1, 1, 1],
  [1, 2, 3],
  [3, 2, 1],
  [0, 3, 0, 4],
  [5, 0, 0, 5],
  [1, 1, 1, 1, 1, 1, 1],
  [100, 1],
  [1, 100],
  [333, 333, 334],
  [2_500, 7_500, 1],
  [7, 11, 13, 17, 19],
];

test('exact sum: the parts add up to the amount for a fixed table of cases', () => {
  let checked = 0;
  for (const amount of AMOUNTS) {
    for (const weights of WEIGHT_SETS) {
      const parts = apportionNet(amount, weights);
      assert.equal(parts.length, weights.length, `length for ${amount} / [${weights}]`);
      assert.equal(sum(parts), amount, `sum for ${amount} / [${weights}]`);
      checked += 1;
    }
  }
  assert.equal(checked, AMOUNTS.length * WEIGHT_SETS.length);
});

test('exact sum: a deterministic sweep over every small amount and weight triple', () => {
  for (let amount = 0; amount <= 40; amount += 1) {
    for (let a = 0; a <= 4; a += 1) {
      for (let b = 0; b <= 4; b += 1) {
        for (let c = 0; c <= 4; c += 1) {
          if (a + b + c === 0) continue;
          const parts = apportionNet(amount, [a, b, c]);
          assert.equal(sum(parts), amount, `sum for ${amount} / [${a},${b},${c}]`);
        }
      }
    }
  }
});

test('fair shares: each part is its exact share rounded down, or that plus 1', () => {
  for (const amount of AMOUNTS) {
    for (const weights of WEIGHT_SETS) {
      const total = sum(weights);
      if (total <= 0) continue;
      const parts = apportionNet(amount, weights);
      weights.forEach((w, i) => {
        const floor = Number((BigInt(amount) * BigInt(w)) / BigInt(total));
        const part = /** @type {number} */ (parts[i]);
        assert.ok(
          part === floor || part === floor + 1,
          `part ${i} is ${part}, expected ${floor} or ${floor + 1} for ${amount} / [${weights}]`,
        );
      });
    }
  }
});

test('ties go to the earlier index', () => {
  assert.deepEqual(apportionNet(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(apportionNet(2, [1, 1, 1]), [1, 1, 0]);
  assert.deepEqual(apportionNet(1, [1, 1, 1]), [1, 0, 0]);
  assert.deepEqual(apportionNet(5, [2, 2, 2, 2]), [2, 1, 1, 1]);
});

test('a larger remainder beats an earlier index', () => {
  // exact shares of 10 over [1, 2]: 3.33 and 6.67, so the single missing Rappen goes to index 1
  assert.deepEqual(apportionNet(10, [1, 2]), [3, 7]);
});

test('a zero weight gets zero', () => {
  assert.deepEqual(apportionNet(7, [0, 3, 0, 4]), [0, 3, 0, 4]);
  for (const amount of AMOUNTS) {
    const parts = apportionNet(amount, [0, 3, 0, 4]);
    assert.equal(parts[0], 0, `leading zero weight for ${amount}`);
    assert.equal(parts[2], 0, `inner zero weight for ${amount}`);
  }
});

test('no weight at all: a zero total returns all zeros, an empty list returns []', () => {
  assert.deepEqual(apportionNet(5, [0, 0]), [0, 0]);
  assert.deepEqual(apportionNet(5, [0]), [0]);
  assert.deepEqual(apportionNet(0, [0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(apportionNet(5, []), []);
  assert.deepEqual(apportionNet(0, []), []);
});

test('a zero amount yields all zeros', () => {
  assert.deepEqual(apportionNet(0, [1, 2, 3]), [0, 0, 0]);
});

test('a single weight takes the whole amount', () => {
  assert.deepEqual(apportionNet(12_345, [1]), [12_345]);
  assert.deepEqual(apportionNet(12_345, [9]), [12_345]);
});

test('large amounts stay exact where amount * weight exceeds the safe integer range', () => {
  const amount = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
  const weights = [1_000_003, 999_999];
  // the premise of the test: the plain-number product is NOT safe here
  assert.ok(amount * 1_000_003 > Number.MAX_SAFE_INTEGER);
  const parts = apportionNet(amount, weights);
  assert.equal(parts.length, 2);
  assert.equal(sum(parts), amount);
  // exact answer, derived by hand with BigInt: floors 4503608634560743 (remainder 101487) and
  // 4503590620180247 (remainder 1898515); the one missing Rappen goes to the larger remainder
  assert.deepEqual(parts, [4_503_608_634_560_743, 4_503_590_620_180_248]);
  assert.deepEqual(apportionNet(amount, [999_999, 1_000_003]), [4_503_590_620_180_248, 4_503_608_634_560_743]);
  // fair shares, computed exactly with BigInt
  const total = BigInt(sum(weights));
  weights.forEach((w, i) => {
    const floor = (BigInt(amount) * BigInt(w)) / total;
    const part = BigInt(/** @type {number} */ (parts[i]));
    assert.ok(part === floor || part === floor + 1n, `part ${i} is a fair share`);
  });
});

test('large amounts: exact parts where a float product would round to a neighbour', () => {
  const amount = 9_007_199_254_740_991;
  // expected values derived by hand with BigInt (floor of amount * w / total, then the largest
  // remainders take the missing Rappen); a plain-number amount * weight lands one Rappen off here
  assert.deepEqual(apportionNet(amount, [2, 3]), [3_602_879_701_896_396, 5_404_319_552_844_595]);
  assert.deepEqual(apportionNet(amount, [13, 17]), [3_903_119_677_054_429, 5_104_079_577_686_562]);
  assert.deepEqual(
    apportionNet(amount, [1, 2, 3]),
    [1_501_199_875_790_165, 3_002_399_751_580_330, 4_503_599_627_370_496],
  );
});

test('large amounts: a float division of the exact product still lands one Rappen off', () => {
  // exact floors 948126237341156 and 8059073017399834, remainders 18 and 1: the one missing Rappen
  // goes to index 0. Dividing Number(product) by Number(total) rounds the first floor up by one.
  assert.deepEqual(
    apportionNet(9_007_199_254_740_991, [2, 17]),
    [948_126_237_341_157, 8_059_073_017_399_834],
  );
});

test('large amounts: every fair share over all weight pairs 1..40 is the exact BigInt floor or floor + 1', () => {
  const amount = Number.MAX_SAFE_INTEGER;
  for (let a = 1; a <= 40; a += 1) {
    for (let b = 1; b <= 40; b += 1) {
      const weights = [a, b];
      const parts = apportionNet(amount, weights);
      assert.equal(sum(parts), amount, `sum for [${a},${b}]`);
      const total = BigInt(a + b);
      weights.forEach((w, i) => {
        const floor = (BigInt(amount) * BigInt(w)) / total;
        const part = BigInt(/** @type {number} */ (parts[i]));
        assert.ok(part === floor || part === floor + 1n, `part ${i} for [${a},${b}] is ${part}, floor ${floor}`);
      });
    }
  }
});

test('large amounts stay exact over many equal weights', () => {
  const amount = 9_007_199_254_740_991;
  const parts = apportionNet(amount, [1, 1, 1, 1, 1, 1, 1]);
  assert.equal(sum(parts), amount);
  const min = Math.min(...parts);
  const max = Math.max(...parts);
  assert.ok(max - min <= 1, 'equal weights differ by at most one Rappen');
  // the earlier indices take the extra Rappen, so the list never increases
  for (let i = 1; i < parts.length; i += 1) {
    assert.ok(/** @type {number} */ (parts[i - 1]) >= /** @type {number} */ (parts[i]));
  }
});

test('no mutation: the weights array is unchanged after the call', () => {
  const weights = [3, 0, 5, 2];
  const snapshot = [...weights];
  apportionNet(1_001, weights);
  assert.deepEqual(weights, snapshot);

  const frozen = Object.freeze([1, 1, 1]);
  assert.deepEqual(apportionNet(100, frozen), [34, 33, 33]);
});

test('the result is a fresh array, not the weights array', () => {
  const weights = [1, 1];
  assert.notEqual(apportionNet(2, weights), weights);
  const zeroWeights = [0, 0];
  const zeros = apportionNet(5, zeroWeights);
  assert.notEqual(zeros, zeroWeights);
  zeros[0] = 99; // mutating the result must not reach the caller's weights
  assert.deepEqual(zeroWeights, [0, 0]);
});

test('deterministic: the same input gives the same output every time', () => {
  const first = apportionNet(99_999, [7, 11, 13]);
  for (let i = 0; i < 5; i += 1) assert.deepEqual(apportionNet(99_999, [7, 11, 13]), first);
});
