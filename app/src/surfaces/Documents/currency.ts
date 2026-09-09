/**
 * A11 §6 / M11-M13: the currency picker's shapes and pure helpers.
 *
 * The engine has had full foreign-currency support since the §H-FX foundation landed, and the Studio
 * offered a bare text box, so the whole capability was unreachable to a human who did not already
 * know that typing "EUR" would work. This module holds the parts of the picker that are pure: the
 * option list, the QR consequence of a currency choice, and the normaliser that turns a
 * `get_exchange_rate` answer into a state the panel can render.
 *
 * Three rules govern everything here, and each one is a defect this repo has already paid for:
 *
 *  1. **The client never does money.** No conversion, no multiplication by a rate, no base total
 *     computed in JavaScript. The rate is a decimal STRING, it stays one, and it is rendered exactly
 *     as the engine emitted it: `formatRate` in `src/core/fx/rateMath.ts` already trims a canonical
 *     rate to its significant places, so a second formatter here would be a second opinion about
 *     what the books say the rate is.
 *  2. **A base-currency posting has no rate.** A rate of 1 is not FX (§H-FX), and rendering "1.00"
 *     next to a CHF invoice would make every domestic invoice look converted. The base arm is its own
 *     state and it shows no rate at all.
 *  3. **Every shape is pinned to the live engine**, keys and kinds, by
 *     `test/sales/currency-picker-fixture.test.mjs`. The Studio has shipped four defects by assuming
 *     a key the engine never sends; an unpinned fixture is the fifth waiting to happen.
 */

import { isQrIban, isValidIban } from '../../../../src/core/setup/iban.js';

/**
 * The date the QR-IBAN goes CHF-only, mirroring the engine's `QR_IBAN_CHF_ONLY_FROM`
 * (`src/core/sales/invoice.ts`). SIX Implementation Guidelines QR-bill v2.4, "valid from 14 November
 * 2026", ch. 2.10: a QR-IBAN "can only be used for invoicing and payments in CHF".
 *
 * Mirrored rather than imported because the engine's copy lives in a module that pulls in the store,
 * and the browser bundle never touches engine code that touches SQLite. The drift guard asserts the
 * two are the same string, so the mirror cannot rot silently.
 */
export const QR_IBAN_CHF_ONLY_FROM = '2026-11-14';

/** The QR-bill carries these two currencies and no others (SIX IG v2.4 ch. 3.5.3, `Ccy`). */
export const QR_CURRENCIES: readonly string[] = ['CHF', 'EUR'];

/** True for a currency the Swiss QR-bill can carry at all (ST3/M13). */
export function isQrCurrency(currency: string): boolean {
  return QR_CURRENCIES.includes(currency);
}

/**
 * What choosing this currency does to the payment part, decided AT the control (M13: prevent at the
 * control, never a refusal at issue). The arms mirror `buildQrBill`'s own gate order, so the panel
 * never promises a bill the engine would refuse and never warns about one it would produce.
 *
 * None of these blocks the invoice. An invoice in any currency issues, posts and renders; what it
 * loses is the payment part, which is a different thing and is said as a different thing.
 */
export type QrConsequence =
  /** A conformant payment part will be produced, with this reference type. */
  | { kind: 'qr'; referenceType: 'QRR' | 'SCOR' }
  /** No IBAN of any kind is configured, so there is no payment part in any currency (M9). */
  | { kind: 'no_iban' }
  /** Outside CHF/EUR: the invoice is fine, the QR-bill is not possible at all (M13). */
  | { kind: 'unsupported_currency' }
  /** A QR-IBAN cannot carry a non-CHF bill from the v2.4 cutover. Names the date it starts. */
  | { kind: 'qr_iban_chf_only'; effectiveFrom: string };

export function qrConsequence(input: {
  currency: string;
  /** The workspace's stored creditor IBAN, or null when none is configured. */
  iban: string | null;
  /** The invoice's own date: the bill is dated by its issue date, never by today. */
  issueDate: string;
}): QrConsequence {
  const iban = input.iban === null ? '' : input.iban.trim();
  if (iban === '' || !isValidIban(iban)) return { kind: 'no_iban' };
  if (!isQrCurrency(input.currency)) return { kind: 'unsupported_currency' };
  if (isQrIban(iban) && input.currency !== 'CHF' && input.issueDate >= QR_IBAN_CHF_ONLY_FROM) {
    return { kind: 'qr_iban_chf_only', effectiveFrom: QR_IBAN_CHF_ONLY_FROM };
  }
  return { kind: 'qr', referenceType: isQrIban(iban) ? 'QRR' : 'SCOR' };
}

/**
 * The state of the rate that WOULD price this invoice, as `get_exchange_rate` reports it.
 *
 * `base` is not "a rate of 1": it is the absence of FX, and the panel renders no rate for it.
 */
export type FxState =
  | { kind: 'loading' }
  /** The document is in the workspace's own base currency: nothing is converted, nothing is stored. */
  | { kind: 'base'; baseCurrency: string }
  | {
      kind: 'resolved';
      currency: string;
      baseCurrency: string;
      /** The canonical decimal rate STRING the engine resolved. Never parsed into a number here. */
      rate: string;
      /** The validity date of the rate that governs, which may precede the invoice date. */
      rateAsOf: string | null;
      /** `manual` | `rate_api`, or `explicit` when a caller named the rate. */
      rateSource: string;
      /** The admissible MWSTV Art. 45 basis the rate declares, when it declares one. */
      rateMethod: string | null;
      /** The date asked about: the invoice date, which is the date that governs (MWSTV Art. 45 Abs. 1). */
      date: string;
    }
  /** M12: no admissible rate for the pair and date. Issue is blocked until one is recorded. */
  | {
      kind: 'needs_rate';
      currency: string;
      baseCurrency: string;
      date: string;
      /** The newest rate on file for this pair, or null when none was ever recorded. */
      latestAsOf: string | null;
      /** How old a rate may be and still price a posting. */
      maxAgeDays: number | null;
      /** How old the newest one actually is, when there is one. */
      ageDays: number | null;
    }
  /**
   * The workspace elected a different MWSTV Art. 45 basis for this Steuerperiode, and Abs. 5 binds
   * the election for at least one period. The rate on file declares a basis this workspace is not on.
   */
  | {
      kind: 'method_not_elected';
      /**
       * The currency asked about. The engine's `fx_method_not_elected` payload does NOT carry it
       * (the refusal is about the basis, not the pair), so it comes from the request rather than
       * from the response, which is why `readFxRate` takes the requested currency at all.
       */
      currency: string;
      /** The date asked about, which decides the Steuerperiode. */
      date: string;
      /** The basis the rate on file declares. */
      method: string;
      /** The basis this workspace elected, which is the one a usable rate has to carry. */
      electedMethod: string;
      /** The Steuerperiode the election was made for. */
      electedFor: string | null;
      /** The Steuerperiode of the invoice date. */
      taxPeriod: string;
      /** From `get_fx_method`: the first period whose basis may still be chosen, when known. */
      earliestChangeablePeriod: string | null;
      /** From `get_fx_method`: whether this period's basis is already settled by a posted entry. */
      locked: boolean;
    }
  | { kind: 'denied' }
  | { kind: 'error'; code: string };

/** The rejection shape as `getExchangeRate` passes it through from `resolveFxRate`. */
interface FxRejection {
  ok: false;
  error: string;
  [key: string]: unknown;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function numOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * Normalise a `get_exchange_rate` answer into an `FxState`.
 *
 * The base arm is recognised from the engine's own `rateSource: 'base'` rather than by comparing the
 * two currency strings in the client: the engine owns which currency the books are kept in, and a
 * client-side comparison would be a second opinion about it.
 *
 * `requested` supplies what the ANSWER does not: `fx_method_not_elected` describes a basis and names
 * no currency, so the pair the caller asked about is the caller's own to remember.
 */
export function readFxRate(body: unknown, requested: { currency: string; date: string }): FxState {
  if (body === null || typeof body !== 'object') return { kind: 'error', code: 'unexpected_error' };
  const b = body as Record<string, unknown>;

  if (b.ok === false) {
    const rejection = b as unknown as FxRejection;
    switch (rejection.error) {
      case 'needs_fx_rate':
        return {
          kind: 'needs_rate',
          currency: str(b.currency) === '' ? requested.currency : str(b.currency),
          baseCurrency: str(b.baseCurrency),
          date: str(b.date) === '' ? requested.date : str(b.date),
          latestAsOf: strOrNull(b.latestAsOf),
          maxAgeDays: numOrNull(b.maxAgeDays),
          ageDays: numOrNull(b.ageDays),
        };
      case 'fx_method_not_elected':
        return {
          kind: 'method_not_elected',
          currency: requested.currency,
          date: str(b.date) === '' ? requested.date : str(b.date),
          method: str(b.method),
          electedMethod: str(b.electedMethod),
          electedFor: strOrNull(b.electedFor),
          taxPeriod: str(b.taxPeriod),
          earliestChangeablePeriod: null,
          locked: false,
        };
      case 'permission_denied':
        return { kind: 'denied' };
      default:
        return { kind: 'error', code: str(b.error) === '' ? 'unexpected_error' : str(b.error) };
    }
  }

  if (b.rateSource === 'base') return { kind: 'base', baseCurrency: str(b.baseCurrency) };
  if (typeof b.rate !== 'string' || b.rate === '') return { kind: 'error', code: 'unexpected_error' };
  return {
    kind: 'resolved',
    currency: str(b.currency),
    baseCurrency: str(b.baseCurrency),
    rate: b.rate,
    rateAsOf: strOrNull(b.rateAsOf),
    rateSource: str(b.rateSource),
    rateMethod: strOrNull(b.rateMethod),
    date: str(b.date),
  };
}

/**
 * Fold what `get_fx_method` knows into an already-diagnosed `method_not_elected` state, so the
 * refusal can say WHEN the basis becomes changeable instead of only that it is not.
 *
 * Applied to any other state it is the identity: the second read is only made when the first one
 * refused on the election, and a late answer must never rewrite a state it does not describe.
 */
export function withFxMethodContext(state: FxState, body: unknown): FxState {
  if (state.kind !== 'method_not_elected') return state;
  if (body === null || typeof body !== 'object') return state;
  const b = body as Record<string, unknown>;
  if (b.ok !== true) return state;
  return {
    ...state,
    earliestChangeablePeriod: strOrNull(b.earliestChangeablePeriod),
    locked: b.locked === true,
  };
}

/** A recorded rate row as `list_exchange_rates` sends it. */
export interface ExchangeRateRowDto {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  asOf: string;
  source: string;
  method: string | null;
  provenance: string | null;
  createdAt: string;
}

/**
 * The currencies to offer, in display order: the workspace's own base currency first (the common
 * case does the common thing), then EUR (the only other currency the QR-bill carries), then every
 * currency someone has actually recorded a rate for, then whatever the document already carries.
 *
 * A currency with no rate on file is still selectable, deliberately: the refusal that follows
 * (`needs_fx_rate`) is one call from being cleared and names the verb that clears it, so hiding the
 * option would hide the capability rather than protect anyone. Free entry of any other ISO code stays
 * available through the picker's own "other" arm, so nothing the text box could do is lost.
 */
export function currencyOptions(input: {
  baseCurrency: string;
  rates: ExchangeRateRowDto[];
  current: string;
}): string[] {
  const out: string[] = [];
  const add = (code: string) => {
    if (code !== '' && !out.includes(code)) out.push(code);
  };
  add(input.baseCurrency);
  add('EUR');
  for (const row of input.rates) {
    // The pair is stored as "the price of one unit of baseCurrency IN quoteCurrency", and the ledger
    // base currency is the QUOTE side, so the billable foreign currency is the row's `baseCurrency`.
    if (row.quoteCurrency === input.baseCurrency) add(row.baseCurrency);
  }
  add(input.current);
  return out;
}

/** The i18n key for an admissible MWSTV Art. 45 basis. Unknown values fall back to the raw value. */
export function fxMethodKey(method: string): string {
  return `invoice.fx.method.${method}`;
}

/** The i18n key for where a rate came from (`manual`, `rate_api`, `explicit`). */
export function fxSourceKey(source: string): string {
  return `invoice.fx.source.${source}`;
}
