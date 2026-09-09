import { describe, it, expect } from 'vitest';

import { summariseVat, contributionOf, type VatContribution } from './summary';
import type { LineVat } from './types';

const out81 = (base: number, tax: number): VatContribution => ({ kind: 'output', rateBp: 810, baseMinor: base, taxMinor: tax });

describe('summariseVat', () => {
  it('is an honest empty for no contributions', () => {
    const s = summariseVat([]);
    expect(s.rows).toEqual([]);
    expect(s.totalTaxMinor).toBe(0);
  });

  it('groups by rate and totals the per-line taxes (per-rate ESTV treatment)', () => {
    const s = summariseVat([
      out81(100000, 8100),
      { kind: 'output', rateBp: 260, baseMinor: 50000, taxMinor: 1300 },
      out81(20000, 1620),
    ]);
    // Two rows: 8.1% (aggregated) and 2.6%, ordered high to low.
    expect(s.rows.map((r) => r.rateBp)).toEqual([810, 260]);
    const row81 = s.rows[0];
    expect(row81.baseMinor).toBe(120000);
    expect(row81.taxMinor).toBe(9720);
    // The total is exactly the SUM of the line taxes, never a re-round.
    expect(s.totalTaxMinor).toBe(9720 + 1300);
  });

  it('gives reverse-charge and import their own rows, never folded into an output rate', () => {
    const s = summariseVat([
      out81(100000, 8100),
      { kind: 'reverse_charge', rateBp: 810, baseMinor: 200000, taxMinor: 16200 },
      { kind: 'import', rateBp: 0, baseMinor: 0, taxMinor: 15500 },
    ]);
    expect(s.rows.map((r) => r.key)).toEqual(['rate:810', 'reverse_charge', 'import']);
    expect(s.totalTaxMinor).toBe(8100 + 16200 + 15500);
  });

  it('surfaces a zero-rated line as a 0% row (base real, tax nil), never hidden', () => {
    const s = summariseVat([{ kind: 'zero', rateBp: 0, baseMinor: 100000, taxMinor: 0 }]);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].rateBp).toBe(0);
    expect(s.rows[0].baseMinor).toBe(100000);
    expect(s.totalTaxMinor).toBe(0);
  });

  it('keeps the two 0% kinds as DISTINCT rows, never merged into one 0.0% row (M31)', () => {
    const s = summariseVat([
      { kind: 'zero', rateBp: 0, baseMinor: 50000, taxMinor: 0 },
      { kind: 'exempt', rateBp: 0, baseMinor: 20000, taxMinor: 0 },
    ]);
    // Two rows, keyed by kind (Ziffer 220 vs 230), not one collapsed 0.0% row.
    expect(s.rows).toHaveLength(2);
    const byKind = new Map(s.rows.map((r) => [r.kind, r]));
    expect(byKind.get('zero')?.baseMinor).toBe(50000);
    expect(byKind.get('exempt')?.baseMinor).toBe(20000);
    expect(s.rows.map((r) => r.key).sort()).toEqual(['exempt', 'zero']);
  });

  it('skips untaxed (none) lines and empty (0 base, 0 tax) contributions', () => {
    const s = summariseVat([
      { kind: 'none', rateBp: 0, baseMinor: 100000, taxMinor: 0 },
      { kind: 'output', rateBp: 810, baseMinor: 0, taxMinor: 0 },
    ]);
    expect(s.rows).toEqual([]);
  });
});

describe('contributionOf', () => {
  const ok: LineVat = {
    ok: true,
    kind: 'output',
    netMinor: 100000,
    taxMinor: 8100,
    grossMinor: 108100,
    rateBp: 810,
    deductible: false,
    formLine: '303',
    trace: { taxCode: 'UST81', taxBaseMinor: 100000, taxAmountMinor: 8100 },
  };

  it('maps a successful preview to a contribution', () => {
    expect(contributionOf(ok)).toEqual({ kind: 'output', rateBp: 810, baseMinor: 100000, taxMinor: 8100 });
  });

  it('returns null for undefined, an error, or a none line', () => {
    expect(contributionOf(undefined)).toBeNull();
    expect(contributionOf({ ok: false, error: 'unknown_tax_code' })).toBeNull();
    expect(contributionOf({ ...ok, kind: 'none' })).toBeNull();
  });
});
