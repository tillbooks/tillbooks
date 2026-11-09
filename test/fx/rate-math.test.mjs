// §H-FX rate arithmetic: integer only, rounding stated and asserted at the Rappen.
//
// The three properties this pins are the ones a wrong FX implementation gets wrong:
//   1. a rate NEVER becomes a float (0.1 + 0.2 arithmetic has no place on the money path);
//   2. rounding is half away from zero at the Rappen, the same rule A06/A10 already use;
//   3. the allocation of a converted side total back over its lines SUMS EXACTLY to that total, so
//      an entry that balanced in the transaction currency still balances in CHF, with no plug.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RATE_SCALE,
  RATE_ONE,
  RATE_DECIMALS,
  RATE_MAX_SCALED,
  parseRate,
  formatRate,
  convertMinor,
  allocateBase,
  isCurrencyCode,
} from '../../dist/core/fx/index.js';

test('a rate parses EXACTLY from its decimal string, never through a float', () => {
  assert.equal(parseRate('0.9412'), 941_200_000_000n);
  assert.equal(parseRate('1'), RATE_ONE);
  assert.equal(parseRate('1.000000000000'), RATE_ONE);
  assert.equal(parseRate('0.000000000001'), 1n, 'the last place the ledger holds is one scaled unit');
  // The float trap, pinned: 1.005 as a double is 1.00499999999999989...; the string parse is exact.
  assert.equal(parseRate('1.005'), 1_005_000_000_000n);
  assert.equal(RATE_SCALE, 1_000_000_000_000n);
  // The scale and the decimal count are ONE decision. Two constants that can disagree eventually do.
  assert.equal(RATE_SCALE, 10n ** BigInt(RATE_DECIMALS));
});

test('a rate TILL cannot represent exactly is refused, never truncated', () => {
  // Nine decimals is what the BAZG daily series needs once a per-10000 quotation is divided out
  // (IDR, KHR, COP, LBP). It used to be refused; refusing it meant those currencies could not be
  // booked at all, which is why the scale was widened.
  assert.equal(parseRate('0.123456789'), 123_456_789_000n, 'nine decimals is well inside what the store holds');
  assert.equal(parseRate('0.1234567890123'), null, 'thirteen decimals is more precision than the store holds');
  assert.equal(parseRate('0'), null, 'a rate of zero would zero the books');
  assert.equal(parseRate('-0.9'), null);
  assert.equal(parseRate('1,5'), null);
  assert.equal(parseRate('1e-2'), null);
  assert.equal(parseRate(''), null);
  assert.equal(parseRate(0.9412), null, 'a NUMBER is refused: the wire carries a decimal string');
  assert.equal(parseRate(null), null);
});

test('a rate above the storage ceiling is refused, never clamped into range', () => {
  // The ceiling exists because rate_scaled is read back out of SQLite as a JavaScript number, and a
  // number stops being exact above MAX_SAFE_INTEGER. A rate quietly clamped to fit is a wrong rate.
  assert.equal(parseRate(formatRate(RATE_MAX_SCALED)), RATE_MAX_SCALED, 'the ceiling itself is holdable');
  assert.equal(parseRate(formatRate(RATE_MAX_SCALED + 1n)), null, 'one scaled unit above it is not');
  assert.equal(parseRate('9001'), null);
  assert.ok(RATE_MAX_SCALED <= BigInt(Number.MAX_SAFE_INTEGER), 'every holdable rate is an exact JS number');
  assert.ok(
    RATE_MAX_SCALED * 1000n < 9_223_372_036_854_775_807n,
    'and sits a thousandfold inside the 64-bit INTEGER column it is stored in',
  );
  // Real currencies are nowhere near it: the largest rate the published BAZG series carries is
  // KWD at 2.66992.
  assert.ok(RATE_MAX_SCALED / parseRate('2.66992') > 3000n);
});

test('formatRate renders one canonical form, so the same rate always reads the same way', () => {
  assert.equal(formatRate(parseRate('0.9412')), '0.9412');
  assert.equal(formatRate(parseRate('0.94120000')), '0.9412');
  assert.equal(formatRate(RATE_ONE), '1');
  assert.equal(formatRate(parseRate('12.5')), '12.5');
  assert.equal(formatRate(parseRate('0.00000001')), '0.00000001');
});

test('conversion rounds HALF AWAY FROM ZERO at the Rappen', () => {
  // 100 minor at 0.005 = 0.5 minor -> 1 (away from zero), not 0 (banker's rounding).
  assert.equal(convertMinor(100, parseRate('0.005')), 1);
  // 300 minor at 0.005 = 1.5 minor -> 2, where banker's rounding would give 2 as well; 500 -> 2.5 -> 3
  // is the case that separates the two rules (banker's would give 2).
  assert.equal(convertMinor(500, parseRate('0.005')), 3);
  assert.equal(convertMinor(108100, parseRate('0.9412')), 101744, "CHF 1'017.44 from EUR 1'081.00 at 0.9412");
  assert.equal(convertMinor(0, parseRate('0.9412')), 0);
});

test('a rate of 1 is the IDENTITY: a base-currency posting is bit-identical to the pre-FX engine', () => {
  const amounts = [108100, 100000, 8100, 7, 1, 999999];
  assert.deepEqual(allocateBase(amounts, RATE_ONE), amounts);
});

test('the allocation sums EXACTLY to the converted side total (no drift, no plug)', () => {
  const rate = parseRate('0.9412');
  const amounts = [33333, 33333, 33334];
  const allocated = allocateBase(amounts, rate);
  const total = amounts.reduce((s, a) => s + a, 0);
  assert.equal(
    allocated.reduce((s, a) => s + a, 0),
    convertMinor(total, rate),
    'Sigma of the allocated base amounts is the conversion of the side TOTAL, not the sum of per-line conversions',
  );
});

test('the two sides of a balanced entry convert to the SAME base total, so CHF balance is structural', () => {
  const rate = parseRate('0.9412');
  // The invoice shape that breaks naive per-line conversion: one gross debit against net + VAT
  // credits. EUR 12.00 net + EUR 0.97 VAT (8.1%) = EUR 12.97 gross.
  const debits = [1297];
  const credits = [1200, 97];
  const d = allocateBase(debits, rate).reduce((s, a) => s + a, 0);
  const c = allocateBase(credits, rate).reduce((s, a) => s + a, 0);
  assert.equal(d, c, 'the entry balances in CHF by construction');
  assert.equal(d, 1221);

  // And the naive alternative genuinely would NOT have balanced, which is why the allocation exists:
  // CHF 11.29 + CHF 0.91 = CHF 12.20 against a receivable of CHF 12.21.
  const naive = credits.reduce((s, a) => s + convertMinor(a, rate), 0);
  assert.equal(naive, 1220, 'per-line rounding drifts by a Rappen: the case this design refuses to plug');
  assert.notEqual(naive, convertMinor(1297, rate));
});

test('every allocated line stays within ONE Rappen of its own conversion', () => {
  const rate = parseRate('0.87654321');
  const amounts = [1, 2, 3, 7, 13, 9999, 123456, 1000001];
  const allocated = allocateBase(amounts, rate);
  amounts.forEach((amount, i) => {
    assert.ok(
      Math.abs(allocated[i] - convertMinor(amount, rate)) <= 1,
      `line ${i}: allocated ${allocated[i]} vs own conversion ${convertMinor(amount, rate)}`,
    );
  });
});

test('the allocation is deterministic: ties go to the lower line index', () => {
  const rate = parseRate('0.3333');
  const amounts = [100, 100, 100];
  const first = allocateBase(amounts, rate);
  assert.deepEqual(first, allocateBase(amounts, rate), 'same input, same output, every time');
  // 300 * 0.3333 = 99.99 -> 100; three equal shares of 100 are 33.33 each, so one Rappen is left over
  // and lands on the FIRST line.
  assert.equal(first.reduce((s, a) => s + a, 0), convertMinor(300, rate));
  assert.ok(first[0] >= first[1] && first[1] >= first[2]);
});

test('a fuzz sweep: the allocation never loses or invents a Rappen', () => {
  const rates = ['0.9412', '1.0824', '0.00012345', '17.5', '1'];
  let seed = 42;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed % n) + 1;
  };
  for (const rateText of rates) {
    const rate = parseRate(rateText);
    for (let trial = 0; trial < 200; trial += 1) {
      const n = rnd(8);
      const amounts = Array.from({ length: n }, () => rnd(5_000_000));
      const allocated = allocateBase(amounts, rate);
      const total = amounts.reduce((s, a) => s + a, 0);
      assert.equal(
        allocated.reduce((s, a) => s + a, 0),
        convertMinor(total, rate),
        `rate ${rateText}, amounts ${JSON.stringify(amounts)}`,
      );
      assert.ok(allocated.every((a) => Number.isSafeInteger(a) && a >= 0), 'every base amount is a non-negative integer');
    }
  }
});

test('a currency code is three uppercase letters, and the engine never normalises one', () => {
  assert.equal(isCurrencyCode('CHF'), true);
  assert.equal(isCurrencyCode('EUR'), true);
  assert.equal(isCurrencyCode('eur'), false, 'lowercase is a caller error, not something to silently fix');
  assert.equal(isCurrencyCode('EURO'), false);
  assert.equal(isCurrencyCode(''), false);
  assert.equal(isCurrencyCode(978), false);
});
