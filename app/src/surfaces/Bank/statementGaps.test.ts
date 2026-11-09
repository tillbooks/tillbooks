/**
 * A36 §4.7 (D150), critic round 1: the gap wording never renders an empty range (M1 / LOW 4), and a
 * refused statement waiting inside a chained gap is named as money missing, never "no money is
 * missing" (H1). Both locales, against the real merged catalogues.
 */
import { describe, it, expect } from 'vitest';

import { CATALOG, type Locale } from '../../i18n';
import { gapExplanation, gapTitle, gapsSummary, type StatementGapDto } from './statementGaps';

function tFor(locale: Locale) {
  return (key: string, params?: Record<string, string | number>): string => {
    const value = key.split('.').reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined), CATALOG[locale]);
    if (typeof value !== 'string') throw new Error(`${locale}: no message at ${key}`);
    return value.replace(/\{(\w+)\}/g, (whole, name: string) => (params !== undefined && name in params ? String(params[name]) : whole));
  };
}

const YEAR_TURN: StatementGapDto = {
  gapId: 'a:b',
  bankAccountId: 'ba',
  source: 'book',
  after: { statementRowId: 'a', documentId: null, number: 250, year: 2025, fromDate: '2025-12-29', toDate: '2025-12-29' },
  before: { statementRowId: 'b', documentId: null, number: 1, year: 2026, fromDate: '2026-01-05', toDate: '2026-01-05' },
  missing: [],
  oldYearTailUnknown: true,
  missingDates: { from: '2025-12-30', to: '2026-01-04' },
  chains: true,
  differenceMinor: 0,
  currency: 'CHF',
  confirmable: true,
};

describe('gap wording, critic round 1', () => {
  for (const locale of ['de-CH', 'en'] as Locale[]) {
    it(`${locale}: a year turn with no knowable number names the statement it follows`, () => {
      const t = tFor(locale);
      const title = gapTitle(t, YEAR_TURN);
      expect(title).toContain('250/2025');
      expect(title).not.toMatch(/\(\s*\)|\s{2}|Auszüge\s+fehlen|Statements\s+are/);
      expect(gapExplanation(t, YEAR_TURN)).not.toContain('{range}');
    });
  }
  it('de-CH: exact sentences', () => {
    const t = tFor('de-CH');
    expect(gapTitle(t, YEAR_TURN)).toBe('Nach Auszug 250/2025 fehlen vielleicht Auszüge (30.12.2025 bis 04.01.2026)');
    const inside = { ...YEAR_TURN, missing: [{ year: 2026, from: 183, to: 186 }], oldYearTailUnknown: false, confirmable: false, refused: [{ number: 184, year: 2026, fromDate: '2026-09-24', differenceMinor: 300 }] };
    expect(gapExplanation(t, inside)).toBe('Auszug 184 wartet in dieser Lücke und schliesst nicht an: es stehen CHF 3.00, die noch nicht im Buch sind.');
  });
});

describe('gapsSummary: one line and one repair target per account (owner, 18.10.2026)', () => {
  const chained = (from: number, to: number, after: number, before: number): StatementGapDto => ({
    ...YEAR_TURN,
    gapId: `${after}:${before}`,
    after: { ...YEAR_TURN.after, number: after, year: 2026 },
    before: { ...YEAR_TURN.before, number: before, year: 2026 },
    missing: [{ year: 2026, from, to }],
    oldYearTailUnknown: false,
  });
  it('none: nothing to say', () => {
    expect(gapsSummary(tFor('de-CH'), [])).toBeNull();
  });
  it('one chained gap: its own title, no explanation, its own id', () => {
    const one = gapsSummary(tFor('de-CH'), [chained(183, 186, 182, 187)]);
    expect(one).toMatchObject({ gapId: '182:187', note: null, many: false });
    expect(one?.title).toContain('Auszüge 183–186 fehlen');
  });
  for (const locale of ['de-CH', 'en'] as Locale[]) {
    it(`${locale}: several chained gaps are ONE line with every range and the target all`, () => {
      const sum = gapsSummary(tFor(locale), [chained(183, 186, 182, 187), chained(188, 190, 187, 191), chained(192, 192, 191, 193)]);
      expect(sum).toMatchObject({ gapId: 'all', note: null, many: true });
      expect(sum?.title).toBe(locale === 'de-CH' ? 'Auszüge 183–186, 188–190, 192 fehlen' : 'Statements 183–186, 188–190, 192 are missing');
    });
  }
  it('money missing in one of several gaps: that gap explains itself, the chained ones stay silent', () => {
    const money = { ...chained(188, 190, 187, 191), chains: false, differenceMinor: 4_200, confirmable: false };
    const sum = gapsSummary(tFor('de-CH'), [chained(183, 186, 182, 187), money]);
    expect(sum?.note).toBe(gapExplanation(tFor('de-CH'), money));
  });
});
