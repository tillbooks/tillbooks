/**
 * The currency picker's pure parts: the option list, the QR consequence, and the normaliser.
 *
 * These are unit tests over shapes the root drift guard (`test/sales/currency-picker-fixture.test.mjs`)
 * has already pinned to the live engine, so what is exercised here is the READING of those shapes,
 * never a belief about them.
 */
import { describe, it, expect } from 'vitest';

import {
  QR_IBAN_CHF_ONLY_FROM,
  currencyOptions,
  isQrCurrency,
  qrConsequence,
  readFxRate,
  withFxMethodContext,
} from './currency';
import fixture from './exchange-rate.fixture.json';

/** A Swiss QR-IBAN: the QR-IID at positions 5 to 9 falls in 30000 to 31999. */
const QR_IBAN = 'CH4431999123000889012';
/** A valid plain IBAN: same country, mod-97 clean, QR-IID outside the range, so SCOR. */
const PLAIN_IBAN = 'CH9300762011623852957';

const asked = { currency: 'EUR', date: '2026-07-16' };

describe('isQrCurrency', () => {
  it('is CHF and EUR, and nothing else (SIX IG v2.4 ch. 3.5.3)', () => {
    expect(isQrCurrency('CHF')).toBe(true);
    expect(isQrCurrency('EUR')).toBe(true);
    expect(isQrCurrency('USD')).toBe(false);
    expect(isQrCurrency('')).toBe(false);
  });
});

describe('qrConsequence', () => {
  it('promises QRR on a QR-IBAN and SCOR on a plain one', () => {
    expect(qrConsequence({ currency: 'CHF', iban: QR_IBAN, issueDate: '2026-07-16' })).toEqual({
      kind: 'qr',
      referenceType: 'QRR',
    });
    expect(qrConsequence({ currency: 'CHF', iban: PLAIN_IBAN, issueDate: '2026-07-16' })).toEqual({
      kind: 'qr',
      referenceType: 'SCOR',
    });
  });

  it('treats no IBAN and an unparseable IBAN alike: no payment part in any currency', () => {
    expect(qrConsequence({ currency: 'CHF', iban: null, issueDate: '2026-07-16' }).kind).toBe('no_iban');
    expect(qrConsequence({ currency: 'CHF', iban: '   ', issueDate: '2026-07-16' }).kind).toBe('no_iban');
    expect(qrConsequence({ currency: 'CHF', iban: 'CH00 nonsense', issueDate: '2026-07-16' }).kind).toBe('no_iban');
  });

  it('reports an unsupported currency before the cutover rule, mirroring buildQrBill gate order', () => {
    // USD on a QR-IBAN after the cutover is unsupported for the plain reason that the QR-bill carries
    // no USD at all. Reporting the QR-IBAN rule there would name a remedy (hold a plain IBAN) that
    // would not help, which is a worse answer than the true one.
    expect(qrConsequence({ currency: 'USD', iban: QR_IBAN, issueDate: '2026-12-01' }).kind).toBe(
      'unsupported_currency',
    );
  });

  it('fires the QR-IBAN CHF-only rule for EUR only from the cutover date, by the INVOICE date', () => {
    const dayBefore = qrConsequence({ currency: 'EUR', iban: QR_IBAN, issueDate: '2026-11-13' });
    expect(dayBefore).toEqual({ kind: 'qr', referenceType: 'QRR' });

    const onTheDay = qrConsequence({ currency: 'EUR', iban: QR_IBAN, issueDate: QR_IBAN_CHF_ONLY_FROM });
    expect(onTheDay).toEqual({ kind: 'qr_iban_chf_only', effectiveFrom: QR_IBAN_CHF_ONLY_FROM });

    // A plain IBAN is the remedy the copy names, so it had better actually work.
    expect(qrConsequence({ currency: 'EUR', iban: PLAIN_IBAN, issueDate: '2026-12-01' })).toEqual({
      kind: 'qr',
      referenceType: 'SCOR',
    });
    // And CHF on a QR-IBAN is unaffected: the rule narrows the currency, it does not retire the IBAN.
    expect(qrConsequence({ currency: 'CHF', iban: QR_IBAN, issueDate: '2027-01-01' })).toEqual({
      kind: 'qr',
      referenceType: 'QRR',
    });
  });
});

describe('currencyOptions', () => {
  it('leads with the base currency, then EUR, then whatever has a rate on file', () => {
    expect(
      currencyOptions({
        baseCurrency: 'CHF',
        rates: [
          { ...fixture.list.rates[0], baseCurrency: 'USD' },
          { ...fixture.list.rates[0], baseCurrency: 'EUR' },
        ],
        current: 'CHF',
      }),
    ).toEqual(['CHF', 'EUR', 'USD']);
  });

  it('reads the pair the way the store writes it: the ledger currency is the QUOTE side', () => {
    // A row quoting into something else is not a rate this workspace can bill on, so it is not an
    // option. Reading the pair backwards would have offered CHF as a foreign currency.
    expect(
      currencyOptions({
        baseCurrency: 'CHF',
        rates: [{ ...fixture.list.rates[0], baseCurrency: 'GBP', quoteCurrency: 'EUR' }],
        current: 'CHF',
      }),
    ).toEqual(['CHF', 'EUR']);
  });

  it('always keeps the currency the document already carries, however it got there', () => {
    expect(currencyOptions({ baseCurrency: 'CHF', rates: [], current: 'JPY' })).toEqual(['CHF', 'EUR', 'JPY']);
  });

  it('honours a base currency that is not CHF, because a workspace setting is not a constant', () => {
    expect(currencyOptions({ baseCurrency: 'EUR', rates: [], current: 'EUR' })).toEqual(['EUR']);
  });
});

describe('readFxRate', () => {
  it('reads the base arm off the engine rateSource, and carries no rate at all', () => {
    const state = readFxRate(fixture.base, { currency: 'CHF', date: '2026-07-16' });
    expect(state).toEqual({ kind: 'base', baseCurrency: 'CHF' });
    // A rate of 1 is not FX: if the state carried one, some panel would eventually render it.
    expect(Object.keys(state)).not.toContain('rate');
  });

  it('reads the resolved arm without touching the rate string', () => {
    const state = readFxRate(fixture.resolved, asked);
    expect(state).toMatchObject({
      kind: 'resolved',
      currency: 'EUR',
      baseCurrency: 'CHF',
      rate: '0.9412',
      rateAsOf: '2026-07-15',
      rateSource: 'manual',
      rateMethod: 'daily',
    });
  });

  it('distinguishes the two needs_fx_rate worlds by the keys the engine actually varies', () => {
    const empty = readFxRate(fixture.needsRateEmpty, asked);
    expect(empty).toMatchObject({ kind: 'needs_rate', latestAsOf: null, ageDays: null, maxAgeDays: 7 });

    const stale = readFxRate(fixture.needsRateStale, asked);
    expect(stale).toMatchObject({ kind: 'needs_rate', latestAsOf: '2026-07-15', ageDays: 77, maxAgeDays: 7 });
  });

  it('supplies the currency the fx_method_not_elected payload does not carry', () => {
    // The engine's refusal is about the BASIS and names no pair. Reading `currency` off it would
    // render an empty string into the sentence, which is how a "the rate for  is on the" reaches a user.
    expect(fixture.methodNotElected).not.toHaveProperty('currency');
    const state = readFxRate(fixture.methodNotElected, asked);
    expect(state).toMatchObject({
      kind: 'method_not_elected',
      currency: 'EUR',
      method: 'daily',
      electedMethod: 'monthly_avg',
      taxPeriod: '2026',
      locked: false,
      earliestChangeablePeriod: null,
    });
  });

  it('maps a refused read to denied, and anything unrecognised to a named error', () => {
    expect(readFxRate({ ok: false, error: 'permission_denied' }, asked)).toEqual({ kind: 'denied' });
    expect(readFxRate({ ok: false, error: 'invalid_currency_pair' }, asked)).toEqual({
      kind: 'error',
      code: 'invalid_currency_pair',
    });
    expect(readFxRate(null, asked)).toEqual({ kind: 'error', code: 'unexpected_error' });
    // An ok answer with no rate is not a rate of 1 either: it is an answer nobody can render.
    expect(readFxRate({ ok: true, rateSource: 'manual' }, asked)).toEqual({
      kind: 'error',
      code: 'unexpected_error',
    });
  });
});

describe('withFxMethodContext', () => {
  it('folds the lock and the earliest changeable period into the election refusal', () => {
    const state = readFxRate(fixture.methodNotElected, asked);
    expect(withFxMethodContext(state, fixture.fxMethodLocked)).toMatchObject({
      kind: 'method_not_elected',
      locked: true,
      earliestChangeablePeriod: '2027',
    });
  });

  it('is the identity for every other state, so a late answer cannot rewrite one it does not describe', () => {
    const resolved = readFxRate(fixture.resolved, asked);
    expect(withFxMethodContext(resolved, fixture.fxMethodLocked)).toBe(resolved);
    const needs = readFxRate(fixture.needsRateEmpty, asked);
    expect(withFxMethodContext(needs, fixture.fxMethodLocked)).toBe(needs);
  });

  it('leaves the refusal alone when the method read itself failed', () => {
    const state = readFxRate(fixture.methodNotElected, asked);
    expect(withFxMethodContext(state, { ok: false, error: 'permission_denied' })).toMatchObject({
      locked: false,
      earliestChangeablePeriod: null,
    });
  });
});
