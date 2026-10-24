/**
 * The Studio's display copy of the engine's rate eras. It is a copy, so it is HELD true here: the era
 * rows are read back out of `src/core/vat/rateEras.ts` and compared, and the resolution is checked
 * on both sides of the 1.1.2024 boundary.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { STUDIO_RATE_ERAS, codeRateClass, displayRateBp } from './vatRates';

describe('vatRates (the Studio copy of the engine eras)', () => {
  it('carries exactly the era rows of src/core/vat/rateEras.ts', () => {
    const source = readFileSync(resolve(__dirname, '../../../src/core/vat/rateEras.ts'), 'utf8');
    const block = source.slice(source.indexOf('export const VAT_RATE_ERAS'), source.indexOf('export const PROPOSED_RATE_ERAS'));
    const rows = [...block.matchAll(/effectiveFrom: '(\d{4}-\d{2}-\d{2})',\s*normalBp: (\d+),\s*reducedBp: (\d+),\s*accommodationBp: (\d+)/g)].map((m) => ({
      from: m[1],
      normalBp: Number(m[2]),
      reducedBp: Number(m[3]),
      accommodationBp: Number(m[4]),
    }));
    expect(rows.length).toBeGreaterThan(0);
    expect(STUDIO_RATE_ERAS).toEqual(rows);
  });

  it('a zero-rate input code is the Normalsatz of the supply date', () => {
    expect(displayRateBp('input', 0, '2026-10-05')).toBe(810);
    expect(displayRateBp('input', 0, '2024-01-01')).toBe(810);
    expect(displayRateBp('input', 0, '2023-12-31')).toBe(770);
  });

  it('a classed rate takes the era of the date, and an unclassed one keeps its stored rate', () => {
    expect(displayRateBp('input', 260, '2023-06-30')).toBe(250);
    expect(displayRateBp('input', 380, '2026-02-01')).toBe(380);
    expect(displayRateBp('output', 810, '2019-03-01')).toBe(770);
    expect(displayRateBp('output', 123, '2026-03-01')).toBe(123);
    expect(displayRateBp('exempt', 0, '2026-03-01')).toBe(0);
  });

  it('names the rate class a code books at', () => {
    expect(codeRateClass('input', 0)).toBe('normal');
    expect(codeRateClass('input', 260)).toBe('reduced');
    expect(codeRateClass('output', 380)).toBe('accommodation');
    expect(codeRateClass('exempt', 0)).toBeNull();
  });
});
