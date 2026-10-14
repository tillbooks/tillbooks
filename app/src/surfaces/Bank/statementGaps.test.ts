/**
 * A36 §4.7 (D150), critic round 1: the gap wording never renders an empty range (M1 / LOW 4), and a
 * refused statement waiting inside a chained gap is named as money missing, never "no money is
 * missing" (H1). Both locales, against the real merged catalogues.
 */
import { describe, it, expect } from 'vitest';

import { CATALOG, type Locale } from '../../i18n';
import { gapExplanation, gapTitle, type StatementGapDto } from './statementGaps';

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
