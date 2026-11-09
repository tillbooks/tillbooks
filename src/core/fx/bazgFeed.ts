/**
 * §H-FX, the ESTV/BAZG rate feed: the parser that finally gives `source='rate_api'` a writer.
 *
 * ## Which published series is admissible, established by citation rather than by guess
 *
 * The §H-FX foundation deliberately refused to wire a feed, because picking the wrong published
 * series shifts every conversion by a day and a wrong rate is wrong money in the books. The series
 * is now settled, in two hops from the ESTV's own pages (all fetched 2026-07-25):
 *
 *  1. **ESTV, "Fremdwährungskurse MWST"** (https://www.estv.admin.ch/de/mwst-fremdwaehrungskurse,
 *     the URL slug is ASCII, the page heading is not): "Für die Umrechnung kann wahlweise der von der
 *     Eidgenössischen Steuerverwaltung ESTV publizierte Monatsmittelkurs oder der Tageskurs
 *     (Devisenkurs Verkauf) angewendet werden."
 *  2. **ESTV, "Tageskurse MWST"** (https://www.estv.admin.ch/de/mwst-tageskurse): "Der aktuelle
 *     Tageskurs wird übermittelt vom Bundesamt für Zoll und Grenzsicherheit (BAZG)", under a link
 *     labelled "Tageskurs BAZG: Devisenkurse (Verkauf)".
 *  3. **BAZG, "Devisenkurse (Verkauf)"**
 *     (https://www.bazg.admin.ch/bazg/de/home/services/services-firmen/services-firmen_einfuhr-ausfuhr-durchfuhr/devisenkurse-verkauf.html)
 *     publishes the machine endpoint `BAZG_DAILY_URL` below. The underlying data is attributed on
 *     that page to SIX Financial Information.
 *  4. The **Monatsmittelkurs** endpoint (`BAZG_MONTHLY_URL`) is linked directly from the ESTV page in
 *     (1), which also notes the monthly averages are made available by the BAZG "unverbindlich".
 *
 * So the endpoint is not a customs series that looks close enough. It IS the series the ESTV names
 * as the MWST Tageskurs, and it is reached from the ESTV's own page.
 *
 * ## The three traps in the payload
 *
 * **The forward-dated window is not a wrong series.** `<datum>` is the day the rate was DETERMINED
 * and `<gueltigkeit>` is the comma-separated list of days it is VALID FOR. A Friday determination
 * carries Saturday, Sunday and Monday. `exchange_rate.as_of` means "the date the rate is valid FOR"
 * (§H-FX), so the importer writes one row per VALIDITY date and never per determination date. A
 * historical determination is fetchable as `?d=YYYYMMDD`, keyed on `<datum>`.
 *
 * **Unit scaling.** `<waehrung>` carries the quotation unit: `1 EUR`, but `100 EGP`, `1000 CLP`,
 * `10000 IDR`. Ignoring it is wrong by up to four orders of magnitude. The division is done in
 * decimal STRING arithmetic (shifting the point), never in floating point.
 *
 * **Not every published rate is representable.** TILL holds rates as exact integers at `RATE_SCALE`
 * and refuses what it cannot hold exactly, because a truncated rate is a wrong rate. The deepest the
 * series goes today is nine decimal places (five quoted places divided by a unit of 10000: IDR, KHR,
 * COP and LBP), which the 1e12 scale holds with room to spare. Anything deeper is still REPORTED
 * with its published unit and quote rather than rounded into the books.
 *
 * ## Why the engine does not fetch
 *
 * Every verb in this engine is synchronous, and that is not an accident to work around: TILL is
 * local-first, and the correctness of a posting must never depend on a network call at posting time.
 * So this module PARSES a payload the host fetched, and `describeRateFeed` tells a caller exactly
 * what to fetch. An agent with a fetch tool, a CLI with curl, or a Studio with a proxy all wire the
 * same verb. `fetchBazgFeed` below is a convenience for hosts and for the live drift guard; nothing
 * in the engine calls it.
 */

import { RATE_DECIMALS } from './rateMath.js';

/** The BAZG "Devisenkurse (Verkauf)" daily series: the ESTV MWST Tageskurs (MWSTV Art. 45 Abs. 3). */
export const BAZG_DAILY_URL = 'https://www.backend-rates.bazg.admin.ch/api/xmldaily';

/** The BAZG Monatsmittelkurs series, linked from the ESTV Fremdwährungskurse page. */
export const BAZG_MONTHLY_URL = 'https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth';

export type RateFeedSeries = 'daily' | 'monthly_avg';

/** What each series is, where it lives, and the pages that establish it is the admissible one. */
export const RATE_FEED_SERIES: readonly {
  method: RateFeedSeries;
  name: string;
  endpoint: string;
  validity: string;
  citations: readonly string[];
}[] = [
  {
    method: 'daily',
    name: 'BAZG Devisenkurse (Verkauf), the ESTV MWST Tageskurs',
    endpoint: BAZG_DAILY_URL,
    validity:
      'the payload carries the determination day in <datum> and the days the rate is VALID FOR in <gueltigkeit>, so a Friday determination prices the weekend. A historical determination is ?d=YYYYMMDD.',
    citations: [
      'https://www.estv.admin.ch/de/mwst-fremdwaehrungskurse',
      'https://www.estv.admin.ch/de/mwst-tageskurse',
      'https://www.bazg.admin.ch/bazg/de/home/services/services-firmen/services-firmen_einfuhr-ausfuhr-durchfuhr/devisenkurse-verkauf.html',
      'MWSTV Art. 45 Abs. 3 (SR 641.201)',
    ],
  },
  {
    method: 'monthly_avg',
    name: 'BAZG Monatsmittelkurs, published for the ESTV',
    endpoint: BAZG_MONTHLY_URL,
    validity:
      'the payload carries one <monat> (YYYY-MM) and the rate governs that whole calendar month. TILL stores it once, on the first of the month.',
    citations: ['https://www.estv.admin.ch/de/mwst-fremdwaehrungskurse', 'MWSTV Art. 45 Abs. 3 (SR 641.201)'],
  },
];

export interface ParsedFeedRate {
  /** The ISO 4217 code, uppercased from the payload's lowercase `code` attribute. */
  currency: string;
  /** The quotation unit from `<waehrung>`: 1, 100, 1000 or 10000. */
  unit: number;
  /** The published figure from `<kurs>`, verbatim: the price of `unit` units in CHF. */
  quotedRate: string;
  /** The price of ONE unit, exact, or null when TILL cannot hold it exactly. */
  rate: string | null;
  /** The exact per-unit value, present when it is NOT representable at `RATE_DECIMALS`. */
  exact?: string;
  rateDecimals?: number;
  reason?: string;
}

export interface ParsedFeed {
  ok: true;
  series: RateFeedSeries;
  endpoint: string;
  /** Daily only: the day the rates were determined (`<datum>`). */
  determinedOn?: string;
  determinedTime?: string;
  /** Monthly only: the month the averages are for (`<monat>`). */
  month?: string;
  /** The dates the rates are valid FOR: what becomes `exchange_rate.as_of`. */
  validFor: string[];
  rates: ParsedFeedRate[];
}

export interface ParsedFeedError {
  ok: false;
  error: string;
  reason: string;
}

/** `24.07.2026` to `2026-07-24`. Returns null for anything else, never a partial date. */
function swissDate(text: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());
  return m === null ? null : `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Divide a published decimal string by a power-of-ten quotation unit, EXACTLY, by moving the point.
 *
 * String arithmetic rather than `Number`: `1.60858 / 100` in binary floating point is not
 * `0.0160858`, and the whole reason money is integer Rappen here is that the moment a rate becomes a
 * double the exactness is gone. Returns the canonical decimal (no trailing zeros), so a published
 * trailing zero does not cost a currency its representability.
 */
function scaleByUnit(quoted: string, unit: number): string | null {
  if (!/^\d+(\.\d+)?$/.test(quoted)) return null;
  const shift = Math.round(Math.log10(unit));
  if (unit <= 0 || 10 ** shift !== unit) return null;

  const [wholePart, fracPart = ''] = quoted.split('.') as [string, string?];
  const digits = wholePart + fracPart;
  let point = wholePart.length - shift;
  let padded = digits;
  if (point < 0) {
    padded = '0'.repeat(-point) + digits;
    point = 0;
  }
  const whole = padded.slice(0, point).replace(/^0+(?=\d)/, '') || '0';
  const frac = padded.slice(point).replace(/0+$/, '');
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

const DEVISE_RE =
  /<devise\s+code="([A-Za-z]{3})"\s*>([\s\S]*?)<\/devise>/g;

function parseDevises(xml: string): ParsedFeedRate[] | null {
  const rates: ParsedFeedRate[] = [];
  const seen = new Set<string>();
  DEVISE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEVISE_RE.exec(xml)) !== null) {
    const body = m[2] as string;
    const waehrung = /<waehrung>\s*(\d+)\s+([A-Za-z]{3})\s*<\/waehrung>/.exec(body);
    const kurs = /<kurs>\s*([\d.]+)\s*<\/kurs>/.exec(body);
    // A block missing either half is a payload TILL does not understand, and half-understanding a
    // rate feed is how a conversion silently goes wrong. Refuse the whole document.
    if (waehrung === null || kurs === null) return null;
    const currency = (waehrung[2] as string).toUpperCase();
    if (seen.has(currency)) return null;
    seen.add(currency);

    const unit = Number(waehrung[1]);
    const quotedRate = kurs[1] as string;
    const exact = scaleByUnit(quotedRate, unit);
    if (exact === null) {
      rates.push({
        currency,
        unit,
        quotedRate,
        rate: null,
        reason: 'unsupported_quotation_unit',
      });
      continue;
    }
    const decimals = (exact.split('.')[1] ?? '').length;
    if (decimals > RATE_DECIMALS) {
      rates.push({
        currency,
        unit,
        quotedRate,
        rate: null,
        exact,
        rateDecimals: RATE_DECIMALS,
        reason: 'unrepresentable',
      });
      continue;
    }
    rates.push({ currency, unit, quotedRate, rate: exact });
  }
  return rates.length === 0 ? null : rates;
}

/**
 * Parse a BAZG payload into dated, per-unit rates. Pure: no network, no clock, no store.
 *
 * The payload IDENTIFIES ITS OWN SERIES through its root element, which is what lets the importer
 * refuse a mis-paired payload instead of dating a monthly average like a daily rate.
 */
export function parseBazgFeed(payload: unknown): ParsedFeed | ParsedFeedError {
  if (typeof payload !== 'string' || payload.trim().length === 0) {
    return { ok: false, error: 'invalid_rate_feed', reason: 'the payload is not a non-empty XML string' };
  }

  if (/<wechselkurse[\s>]/.test(payload)) {
    const datum = /<datum>([^<]*)<\/datum>/.exec(payload);
    const gueltigkeit = /<gueltigkeit>([^<]*)<\/gueltigkeit>/.exec(payload);
    const zeit = /<zeit>([^<]*)<\/zeit>/.exec(payload);
    if (datum === null || gueltigkeit === null) {
      return { ok: false, error: 'invalid_rate_feed', reason: 'a daily payload must carry <datum> and <gueltigkeit>' };
    }
    const determinedOn = swissDate(datum[1] as string);
    const validFor = (gueltigkeit[1] as string)
      .split(',')
      .map((d) => swissDate(d))
      .filter((d): d is string => d !== null);
    if (determinedOn === null || validFor.length === 0) {
      return { ok: false, error: 'invalid_rate_feed', reason: 'the dates are not DD.MM.YYYY' };
    }
    const rates = parseDevises(payload);
    if (rates === null) {
      return { ok: false, error: 'invalid_rate_feed', reason: 'no readable <devise> block: every one needs <waehrung> and <kurs>' };
    }
    return {
      ok: true,
      series: 'daily',
      endpoint: BAZG_DAILY_URL,
      determinedOn,
      ...(zeit !== null ? { determinedTime: (zeit[1] as string).trim() } : {}),
      validFor,
      rates,
    };
  }

  if (/<monatsmittelkurs[\s>]/.test(payload)) {
    const monat = /<monat>([^<]*)<\/monat>/.exec(payload);
    if (monat === null || !/^\d{4}-\d{2}$/.test((monat[1] as string).trim())) {
      return { ok: false, error: 'invalid_rate_feed', reason: 'a monthly payload must carry <monat> as YYYY-MM' };
    }
    const month = (monat[1] as string).trim();
    const rates = parseDevises(payload);
    if (rates === null) {
      return { ok: false, error: 'invalid_rate_feed', reason: 'no readable <devise> block: every one needs <waehrung> and <kurs>' };
    }
    // One row, on the first of the month. The average governs the whole month by construction, and
    // `resolveFxRate` widens its window to the calendar month for exactly this reason.
    return { ok: true, series: 'monthly_avg', endpoint: BAZG_MONTHLY_URL, month, validFor: [`${month}-01`], rates };
  }

  return {
    ok: false,
    error: 'invalid_rate_feed',
    reason: 'not a BAZG rate payload: expected a <wechselkurse> or <monatsmittelkurs> document',
  };
}

/**
 * Fetch a published payload. FOR HOSTS AND FOR THE LIVE DRIFT GUARD ONLY: no engine verb calls this,
 * and none may. A ledger whose correctness depends on a network call at posting time is not
 * local-first, and a test suite that depends on one is not offline.
 *
 * `determinedOn` selects a historical DETERMINATION date (`?d=YYYYMMDD`, keyed on `<datum>`, not on
 * the validity date), which is what the BAZG endpoint accepts.
 */
export async function fetchBazgFeed(
  series: RateFeedSeries,
  options: { determinedOn?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const base = series === 'daily' ? BAZG_DAILY_URL : BAZG_MONTHLY_URL;
  const url =
    options.determinedOn !== undefined && series === 'daily'
      ? `${base}?d=${options.determinedOn.replace(/-/g, '')}`
      : base;
  const response = await fetch(url, options.signal !== undefined ? { signal: options.signal } : {});
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return await response.text();
}
