/**
 * D150: an item's params reach the screen as Swiss words. A `...Date` day is `23.09.2026`, a
 * `...Minor` number beside a `currency` is money, an `...At` instant is Swiss time, and nothing else
 * changes. The gap item's title and subtitle render in both locales with no raw key.
 */
import { describe, it, expect } from 'vitest';

import { CATALOG, type Locale } from '../../i18n';
import { formatItemParams, itemSubtitle, itemTitle } from './itemText';

function tFor(locale: Locale) {
  return (key: string, params?: Record<string, string | number>): string => {
    const value = key.split('.').reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined), CATALOG[locale]);
    if (typeof value !== 'string') throw new Error(`${locale}: no message at ${key}`);
    return value.replace(/\{(\w+)\}/g, (whole, name: string) => (params !== undefined && name in params ? String(params[name]) : whole));
  };
}

describe('formatItemParams', () => {
  it('formats days, money and instants, and leaves the rest', () => {
    expect(formatItemParams({ fromDate: '2026-09-23', differenceMinor: 50000, currency: 'CHF', after: 182, bank: 'ZKB' })).toEqual({
      fromDate: '23.09.2026',
      differenceMinor: 'CHF 500.00',
      currency: 'CHF',
      after: 182,
      bank: 'ZKB',
    });
    // No currency: a ...Minor number stays a number (never a guessed currency).
    expect(formatItemParams({ amountMinor: 100 })).toEqual({ amountMinor: 100 });
  });
});

describe('the statement gap item in words', () => {
  const item = {
    queueId: 'bank_statement_gap',
    titleKey: 'attention.item.bankStatementGap.titleManyDays',
    titleParams: { bank: 'ZKB Geschäftskonto', range: '183–186', fromDate: '2026-09-23', toDate: '2026-09-28' },
    subtitleKey: 'attention.item.bankStatementGap.subtitleChained',
    subtitleParams: { after: 182, before: 187, differenceMinor: 0, currency: 'CHF' },
  };
  it('de-CH', () => {
    const t = tFor('de-CH');
    expect(itemTitle(t, item)).toBe('ZKB Geschäftskonto: Auszüge 183–186 fehlen (23.09.2026 bis 28.09.2026)');
    expect(itemSubtitle(t, item)).toContain('Der Saldo von Auszug 182 geht genau in Auszug 187 über: es fehlt kein Geld.');
    expect(itemSubtitle(t, { ...item, subtitleKey: 'attention.item.bankStatementGap.subtitleUnchained', subtitleParams: { ...item.subtitleParams, differenceMinor: 50000 } })).toBe(
      'In den fehlenden Auszügen stehen CHF 500.00, die noch nicht im Buch sind. Importiere sie aus dem eBanking.',
    );
  });
  it('en', () => {
    const t = tFor('en');
    expect(itemTitle(t, item)).toBe('ZKB Geschäftskonto: statements 183–186 are missing (23.09.2026 to 28.09.2026)');
  });
  it('every gap and fetch key exists in both locales', () => {
    for (const locale of ['de-CH', 'en'] as Locale[]) {
      const t = tFor(locale);
      for (const k of ['titleManyDays', 'titleManyDay', 'titleOneDays', 'titleOneDay', 'subtitleChained', 'subtitleUnchained', 'subtitlePending']) {
        expect(() => t(`attention.item.bankStatementGap.${k}`)).not.toThrow();
      }
      for (const k of ['title', 'notGranted', 'busy', 'tooLarge', 'refused', 'unreachable', 'keystore', 'noActor', 'noWire', 'keysChanged', 'untrusted', 'local', 'other']) {
        expect(() => t(`attention.item.bankFetchFailed.${k}`)).not.toThrow();
      }
      for (const k of ['one', 'other']) expect(() => t(`attention.item.bankLinesWaiting.title.${k}`)).not.toThrow();
    }
  });
});
