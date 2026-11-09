/**
 * seed-dates.mjs: the rolling-TODAY calendar for the rich demo seed (WP1, kaizen test instance).
 *
 * The frozen seed hardcodes its business dates around TODAY = 2026-08-23. This module remaps that
 * frozen calendar onto any target TODAY (env `TILL_SEED_TODAY`, ISO YYYY-MM-DD) WITHOUT rewriting
 * the date literals in the seed script:
 *
 *   - Year mapping: seed-year 2026 maps to year(TODAY), 2025 to year(TODAY)-1, 2024 to
 *     year(TODAY)-2 (generic: every seed year shifts by year(TODAY)-2026).
 *   - Feb-29 clamps to Feb-28 when the target year is not a leap year.
 *   - `isFuture` is the skip decision: an EVENT whose remapped date lands after TODAY is not
 *     seeded (the seed script counts and prints those skips). Attribute dates that may
 *     legitimately lie in the future (dueDate, task dueAt) are remapped but never skipped.
 *   - `months()` / `monthShift()` carry the frozen seed's RELATIVE month horizons: the frozen
 *     seed spans Jan of year(TODAY)-1 through month(TODAY), depreciation and bills run through
 *     month(TODAY)-1, paid invoices through month(TODAY)-3, closes through month(TODAY)-2.
 *
 * Identity guarantee: when TODAY equals DEFAULT_TODAY every remap function returns its input
 * unchanged, so the default seed output stays byte-identical to the frozen ledger.
 *
 * Pure and deterministic: no wall clock, no I/O.
 */

export const DEFAULT_TODAY = '2026-08-23';

/** The year the frozen seed treats as "the current year". */
export const SEED_ANCHOR_YEAR = 2026;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;
const ISO_QUARTER = /^\d{4}-Q[1-4]$/;

/** Resolve the seed's TODAY from the environment. Unset or empty means the frozen default. */
export function resolveSeedToday(env = process.env) {
  const raw = env.TILL_SEED_TODAY;
  if (raw === undefined || raw === '') return DEFAULT_TODAY;
  if (!ISO_DATE.test(raw)) {
    throw new Error('TILL_SEED_TODAY must be an ISO date (YYYY-MM-DD), got: ' + raw);
  }
  const parsed = new Date(raw + 'T00:00:00.000Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error('TILL_SEED_TODAY is not a real calendar date: ' + raw);
  }
  return raw;
}

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Build the calendar for a target TODAY. Returns bound pure functions:
 *   d(date), dm(month), dq(quarter), dt(dateTime), isFuture(dateOrDateTime),
 *   monthShift(delta), months(), plus `today` and `identity`.
 */
export function makeSeedCalendar(today = DEFAULT_TODAY) {
  if (!ISO_DATE.test(today)) throw new Error('makeSeedCalendar: not an ISO date: ' + today);
  const targetYear = Number(today.slice(0, 4));
  const yearDelta = targetYear - SEED_ANCHOR_YEAR;

  /** Remap a YYYY-MM-DD seed date onto the target calendar (Feb-29 clamps to Feb-28). */
  function d(iso) {
    if (!ISO_DATE.test(iso)) throw new Error('seed-dates d(): not YYYY-MM-DD: ' + iso);
    const y = Number(iso.slice(0, 4)) + yearDelta;
    let md = iso.slice(5);
    if (md === '02-29' && !isLeapYear(y)) md = '02-28';
    return String(y).padStart(4, '0') + '-' + md;
  }

  /** Remap a YYYY-MM seed month. */
  function dm(month) {
    if (!ISO_MONTH.test(month)) throw new Error('seed-dates dm(): not YYYY-MM: ' + month);
    const y = Number(month.slice(0, 4)) + yearDelta;
    return String(y).padStart(4, '0') + '-' + month.slice(5);
  }

  /** Remap a YYYY-Qn seed quarter label. */
  function dq(quarter) {
    if (!ISO_QUARTER.test(quarter)) throw new Error('seed-dates dq(): not YYYY-Qn: ' + quarter);
    const y = Number(quarter.slice(0, 4)) + yearDelta;
    return String(y).padStart(4, '0') + '-' + quarter.slice(5);
  }

  /** Remap the date part of an ISO date-time string, keeping the time suffix verbatim. */
  function dt(isoDateTime) {
    if (typeof isoDateTime !== 'string' || isoDateTime.length < 10) {
      throw new Error('seed-dates dt(): not an ISO date-time: ' + isoDateTime);
    }
    return d(isoDateTime.slice(0, 10)) + isoDateTime.slice(10);
  }

  /** The skip decision: does this (already remapped) event date land after TODAY? */
  function isFuture(dateOrDateTime) {
    if (typeof dateOrDateTime !== 'string' || dateOrDateTime.length < 10) {
      throw new Error('seed-dates isFuture(): not an ISO date: ' + dateOrDateTime);
    }
    return dateOrDateTime.slice(0, 10) > today;
  }

  /** month(TODAY) shifted by `delta` calendar months, as YYYY-MM. */
  function monthShift(delta) {
    const total = targetYear * 12 + (Number(today.slice(5, 7)) - 1) + delta;
    const y = Math.floor(total / 12);
    const m = (total - y * 12) + 1;
    return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0');
  }

  /** The seed's month span: Jan of year(TODAY)-1 through month(TODAY), inclusive. */
  function months() {
    const out = [];
    const endKey = today.slice(0, 7);
    for (let y = targetYear - 1; ; y += 1) {
      for (let m = 1; m <= 12; m += 1) {
        const key = String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0');
        if (key > endKey) return out;
        out.push(key);
      }
    }
  }

  return {
    today,
    identity: today === DEFAULT_TODAY,
    yearDelta,
    d,
    dm,
    dq,
    dt,
    isFuture,
    monthShift,
    months,
  };
}
