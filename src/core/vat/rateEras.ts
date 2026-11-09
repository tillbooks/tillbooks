/**
 * A05, the date-versioned Swiss VAT rate table.
 *
 * The Swiss VAT rates are NOT stable. A bare `NORMAL_RATE_BP = 810` silently mis-computes every
 * correction return for a pre-2024 period, so the rates are resolved from the DATE OF THE PERIOD
 * BEING REPORTED (or the transaction date), never from "now". Rates are integer basis points.
 *
 * BOUNDARY SEMANTICS (the whole point of this module, so it is stated once and precisely):
 *   An era is the HALF-OPEN interval [effectiveFrom, nextEra.effectiveFrom).
 *   `effectiveFrom` is INCLUSIVE: 2024-01-01 is already in the 2024 era.
 *   The next era's `effectiveFrom` is EXCLUSIVE: 2023-12-31 is still in the 2018 era.
 *   The newest era is open-ended: it governs every date from its `effectiveFrom` onward, until a
 *   later era is appended as DATA.
 *   A date BEFORE `EARLIEST_RATE_ERA_FROM` resolves to `null`. That is a deliberate, documented gap,
 *   not a guess: pre-2018 rates were not verified against a primary source, so they are absent
 *   rather than invented, and every caller treats "no era" as "cannot enforce", never as "reject".
 *
 * ADDING AN ERA IS A DATA CHANGE. Append a row to `VAT_RATE_ERAS` in ascending order. No resolver,
 * no caller, and no test that reads the table needs to change.
 *
 * NOT-YET-ENACTED RATES ARE NEVER LIVE DATA. A mandatory referendum is scheduled for 2026-11-29 on
 * raising the Normalsatz by 0.4 points (8.1 -> 8.5) from 2028 to fund the 13th AHV pension; both
 * chambers passed it on 2026-06-19 and the popular vote has NOT happened. It is therefore absent
 * from the table below. See `PROPOSED_RATE_ERAS`, which is inert scenario data, exported for
 * what-if modelling only and never consulted by `vatRatesOn`.
 *
 * STATUTORY PROVENANCE (verified 2026-07-19 against primary sources):
 *  - MWSTG SR 641.20 Art. 25, fedlex version in force 1.1.2023: 7.7 / 2.5 / 3.7. VERIFIED.
 *  - MWSTG SR 641.20 Art. 25, fedlex version in force 1.1.2024: 8.1 / 2.6 / 3.8. VERIFIED.
 *  - The 1.1.2018 start of the 7.7 era: Verordnung vom 8. November 2017 (AS 2017 6305), in force
 *    1.1.2018. VERIFIED.
 *  - SR 641.202.62 in force 1.1.2018, Saldosteuersatz ladder 0.1/0.6/1.2/2.0/2.8/3.5/4.3/5.1/5.9/
 *    6.5 %. VERIFIED (fedlex eli/cc/2010/874, version 20180101).
 *  - SR 641.202.62 as rebased by AS 2023 18, in force 1.1.2024, ladder 0.1/0.6/1.3/2.1/3.0/3.7/4.5/
 *    5.3/6.2/6.8 %. VERIFIED (fedlex eli/oc/2023/18).
 */

/** One statutory rate era. All rates are integer basis points (770 = 7.7%). */
export interface VatRateEra {
  /** ISO `YYYY-MM-DD`. INCLUSIVE lower bound of the era. */
  readonly effectiveFrom: string;
  /** Normalsatz (MWSTG Art. 25 Abs. 1). */
  readonly normalBp: number;
  /** Reduzierter Satz (Art. 25 Abs. 2). */
  readonly reducedBp: number;
  /** Sondersatz Beherbergung (Art. 25 Abs. 4). */
  readonly accommodationBp: number;
  /**
   * The Saldosteuersatz ladder published for the era (SR 641.202.62). The ladder is REBASED in the
   * septennial review, so it is era-dependent in principle and in fact: 2018 and 2024 differ on six
   * of ten rungs.
   */
  readonly saldoLadderBp: readonly number[];
  /** The primary source the row was read from, so a future reviewer can re-verify it. */
  readonly source: string;
}

/**
 * The eras, ascending. APPEND ONLY, and only once a rate is actually in force.
 *
 * The table deliberately begins at 2018-01-01. The 2011-2017 era (8.0 / 2.5 / 3.8) is widely
 * reported but was NOT confirmed against a primary source in this pass, so it is omitted rather
 * than guessed. Adding it is a data change once someone reads it off fedlex.
 */
export const VAT_RATE_ERAS: readonly VatRateEra[] = [
  {
    effectiveFrom: '2018-01-01',
    normalBp: 770,
    reducedBp: 250,
    accommodationBp: 370,
    saldoLadderBp: [10, 60, 120, 200, 280, 350, 430, 510, 590, 650],
    source: 'MWSTG SR 641.20 Art. 25 (version in force 1.1.2023) + AS 2017 6305; ladder SR 641.202.62 (version in force 1.1.2018)',
  },
  {
    effectiveFrom: '2024-01-01',
    normalBp: 810,
    reducedBp: 260,
    accommodationBp: 380,
    saldoLadderBp: [10, 60, 130, 210, 300, 370, 450, 530, 620, 680],
    source: 'MWSTG SR 641.20 Art. 25 (version in force 1.1.2024); ladder SR 641.202.62 as rebased by AS 2023 18',
  },
];

/**
 * INERT SCENARIO DATA. Not law, never consulted by `vatRatesOn`, never merged into `VAT_RATE_ERAS`.
 *
 * The 2026-11-29 mandatory referendum on financing the 13th AHV pension would raise the Normalsatz
 * from 8.1% to 8.5% from 2028; the reduzierter Satz stays at 2.6%. The Beherbergung Sondersatz and
 * the accompanying Saldosteuersatz ladder are NOT settled in a primary source, so this row carries
 * the current values for them and must not be treated as a forecast. Present only so a what-if
 * projection has somewhere honest to read from.
 */
export const PROPOSED_RATE_ERAS: readonly VatRateEra[] = [
  {
    effectiveFrom: '2028-01-01',
    normalBp: 850,
    reducedBp: 260,
    accommodationBp: 400,
    saldoLadderBp: [],
    source:
      'NOT LAW: Vorlage passed by both chambers 2026-06-19, mandatory referendum 2026-11-29 pending, ' +
      'entry into force from 2028. Rates VERIFIED 2026-07-19 (admin.ch / bsv.admin.ch, 13. AHV-Rente): ' +
      'Normalsatz 8.1 to 8.5, Sondersatz Beherbergung 3.8 to 4.0, reduzierter Satz UNCHANGED at 2.6. ' +
      'The rebased Saldo ladder for this era is UNVERIFIED and stays empty.',
  },
];

/**
 * The Saldosteuersatz ELIGIBILITY limits of MWSTG Art. 37 Abs. 1, date-versioned like the rates
 * above and for the same reason: they MOVE, and a bare constant silently misstates the law for
 * every other era. The test is CUMULATIVE: at most `turnoverLimitMinor` taxable turnover including
 * tax AND at most `taxDueLimitMinor` tax due computed at the filer's own Saldosteuersatz. Both are
 * Rappen integers, interpolated into guidance copy (G17): no rendered sentence may hand-type them.
 *
 * BOUNDARY, verified 2026-08-17 against the year-versioned fedlex consolidations of SR 641.20
 * Art. 37 Abs. 1: the 20240101 text already carries 5'024'000 / 108'000 (the raise rode the
 * Steuersatzerhöhung of 1.1.2024), the 20230101 text carries 5'005'000 / 103'000. **The boundary is
 * 1.1.2024, not 1.1.2025**: G17's design critic caught exactly that misdate, and keyed to 2025 a
 * lookup would return the old limit for the whole 2024 Steuerperiode.
 *
 * The table deliberately begins at 2023-01-01: that is the earliest consolidation VERIFIED in this
 * pass. The 5'005'000 / 103'000 pair is widely reported to date from 1.1.2018 (AS 2017 6305), but
 * that boundary was not confirmed against a primary source here, so it is omitted rather than
 * guessed (the `VAT_RATE_ERAS` precedent above). A date before the first row resolves to `null`,
 * which callers treat as "cannot state", never as a made-up figure.
 */
export interface SaldoEligibilityEra {
  /** ISO `YYYY-MM-DD`. INCLUSIVE lower bound, next era exclusive, newest open-ended. */
  readonly effectiveFrom: string;
  /** Art. 37 Abs. 1: max taxable turnover incl. tax, in Rappen. */
  readonly turnoverLimitMinor: number;
  /** Art. 37 Abs. 1: max tax due at the filer's own Saldosteuersatz, in Rappen. */
  readonly taxDueLimitMinor: number;
  /** The primary source the row was read from, so a future reviewer can re-verify it. */
  readonly source: string;
}

export const SALDO_ELIGIBILITY_ERAS: readonly SaldoEligibilityEra[] = [
  {
    effectiveFrom: '2023-01-01',
    // CHF 5'005'000.00 and CHF 103'000.00, as Rappen.
    turnoverLimitMinor: 500_500_000,
    taxDueLimitMinor: 10_300_000,
    source: 'MWSTG SR 641.20 Art. 37 Abs. 1, fedlex consolidation in force 1.1.2023 (verified 2026-08-17)',
  },
  {
    effectiveFrom: '2024-01-01',
    // CHF 5'024'000.00 and CHF 108'000.00, as Rappen.
    turnoverLimitMinor: 502_400_000,
    taxDueLimitMinor: 10_800_000,
    source: 'MWSTG SR 641.20 Art. 37 Abs. 1, fedlex consolidation in force 1.1.2024 (verified 2026-08-17)',
  },
];

/** The Art. 37 Abs. 1 limits in force on `date`, or `null` before the earliest verified era. */
export function saldoEligibilityOn(date: unknown): SaldoEligibilityEra | null {
  const day = toIsoDay(date);
  let found: SaldoEligibilityEra | null = null;
  for (const era of SALDO_ELIGIBILITY_ERAS) {
    if (era.effectiveFrom <= day) found = era;
    else break;
  }
  return found;
}

/** The INCLUSIVE start of the earliest published era. Before this, no era resolves. */
export const EARLIEST_RATE_ERA_FROM: string = VAT_RATE_ERAS[0]!.effectiveFrom;

/** The effective-from of the newest published era, which runs open-ended. */
export const CURRENT_RATE_ERA_FROM: string = VAT_RATE_ERAS[VAT_RATE_ERAS.length - 1]!.effectiveFrom;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Narrow a caller-supplied date to the `YYYY-MM-DD` day it names. A full ISO timestamp is accepted
 * (its date part is used); anything else throws `invalid_date` rather than being coerced, because a
 * silently-coerced date on the money path picks the wrong rate era without ever telling anyone.
 */
export function toIsoDay(date: unknown): string {
  if (typeof date !== 'string') throw new Error(`invalid_date: ${String(date)}`);
  const day = date.length > 10 && date[10] === 'T' ? date.slice(0, 10) : date;
  if (!ISO_DATE_RE.test(day)) throw new Error(`invalid_date: ${date}`);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== m || probe.getUTCDate() !== d) {
    throw new Error(`invalid_date: ${date}`);
  }
  return day;
}

/** True when `date` parses as a day this module can resolve. Never throws. */
export function isValidRateDate(date: unknown): boolean {
  try {
    toIsoDay(date);
    return true;
  } catch {
    return false;
  }
}

/**
 * The rates in force on `date`, or `null` when `date` precedes the earliest published era.
 *
 * ISO day strings compare correctly lexicographically, so the scan is a plain string comparison:
 * the LAST era whose `effectiveFrom` is `<= date` governs (effective-from inclusive, next era
 * exclusive).
 */
export function vatRatesOn(date: unknown): VatRateEra | null {
  const day = toIsoDay(date);
  let found: VatRateEra | null = null;
  for (const era of VAT_RATE_ERAS) {
    if (era.effectiveFrom <= day) found = era;
    else break;
  }
  return found;
}

/** The Normalsatz in force on `date` in basis points, or `null` when no era covers it. */
export function normalRateBpOn(date: unknown): number | null {
  return vatRatesOn(date)?.normalBp ?? null;
}

/**
 * The Saldosteuersatz allow-list in force on `date`, or `null` when no era covers it. A `null` means
 * "no published ladder for that date", which callers must treat as "cannot enforce", NEVER as
 * "reject": an old rate has to stay declarable indefinitely for correction returns.
 */
export function saldoLadderOn(date: unknown): ReadonlySet<number> | null {
  const era = vatRatesOn(date);
  return era === null ? null : new Set(era.saldoLadderBp);
}

/** The newest published era. What `NORMAL_RATE_BP` and the default allow-list derive from. */
export function currentVatRates(): VatRateEra {
  return VAT_RATE_ERAS[VAT_RATE_ERAS.length - 1]!;
}
