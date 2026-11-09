/**
 * D177: the rule form's computed amounts as exact fractions (`factor.ts`). Every figure is synthetic.
 */
import { describe, expect, it } from 'vitest';

import { applyFactor, decimalFactor, percentToBp, platformFactor } from './factor';

describe('factor authoring (D177)', () => {
  it('the platform preset: 8.1 % MWST and 9.9 % fee on the net give 1081/180, and 15.12 gives 90.80', () => {
    const f = platformFactor('8.1', '9.9');
    expect(f).toEqual({ num: 1081, den: 180, explain: { vatBp: 810, feeBp: 990 } });
    expect(applyFactor(1_512, f as NonNullable<typeof f>)).toBe(9_080);
    expect(applyFactor(-1_512, f as NonNullable<typeof f>)).toBe(9_080);
  });

  it('reads a comma, refuses a rate it cannot read or a zero denominator', () => {
    expect(platformFactor('8,1', '9,9')).toMatchObject({ num: 1081, den: 180 });
    expect(platformFactor('abc', '9.9')).toBeNull();
    expect(platformFactor('0', '0')).toBeNull();
    expect(percentToBp('8.125')).toBeNull();
    expect(percentToBp('101')).toBeNull();
  });

  it('a plain factor, decimal or fraction, is exact and reduced', () => {
    expect(decimalFactor('2.5')).toEqual({ num: 5, den: 2 });
    expect(decimalFactor('6,0056')).toEqual({ num: 7507, den: 1250 });
    expect(decimalFactor('1081/180')).toEqual({ num: 1081, den: 180 });
    expect(decimalFactor('2162/360')).toEqual({ num: 1081, den: 180 });
    expect(decimalFactor('0')).toBeNull();
    expect(decimalFactor('-2')).toBeNull();
  });

  it('rounds half up in Rappen', () => {
    expect(applyFactor(10_000, { num: 1081, den: 180 })).toBe(60_056);
    expect(applyFactor(1, { num: 1, den: 2 })).toBe(1);
    expect(applyFactor(3, { num: 1, den: 2 })).toBe(2);
  });
});
