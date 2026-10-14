/**
 * A40, the clearing-day calendar: which days a Swiss payment can actually execute on.
 *
 * A pain.001 `ReqdExctnDt` that falls on a non-business day is moved by the bank to the NEXT business
 * day (Swiss Payment Standards, the business rules on the requested execution date). For a Skonto
 * deadline that move is exactly the wrong direction, so every date A40 proposes is a clearing day on
 * or before its deadline, never a date the bank will silently push past it.
 *
 * THE SET is the SIX schedule of SIC clearing days (CHF): Saturdays and Sundays, plus New Year's Day,
 * Berchtoldstag (2.1.), Good Friday, Easter Monday, Labour Day (1.5.), Ascension, Whit Monday, the
 * National Day (1.8.), Christmas Day and St. Stephen's Day. 24.12. and 31.12. ARE clearing days. The
 * euroSIC (EUR) schedule is the same set minus Ascension and Whit Monday; A40 applies the SIC set to
 * every currency, which for EUR only ever proposes one day EARLIER, never later (the safe direction).
 *
 * Pure, string in and string out on ISO `YYYY-MM-DD`, UTC arithmetic, no clock.
 */

import { addDays } from '../recurring/dates.js';

export { addDays };

const DAY_MS = 86_400_000;

/** Calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

/** Easter Sunday of `year` (Gregorian, the anonymous "Meeus/Jones/Butcher" computus). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const holidayCache = new Map<number, ReadonlySet<string>>();

/** The SIC closing days of `year` that can fall on a weekday (weekends are closed anyway). */
export function sicHolidays(year: number): ReadonlySet<string> {
  const cached = holidayCache.get(year);
  if (cached !== undefined) return cached;
  const y = String(year).padStart(4, '0');
  const easter = easterSunday(year);
  const set = new Set<string>([
    `${y}-01-01`,
    `${y}-01-02`,
    addDays(easter, -2), // Karfreitag
    addDays(easter, 1), // Ostermontag
    `${y}-05-01`,
    addDays(easter, 39), // Auffahrt
    addDays(easter, 50), // Pfingstmontag
    `${y}-08-01`,
    `${y}-12-25`,
    `${y}-12-26`,
  ]);
  holidayCache.set(year, set);
  return set;
}

/** Is `date` a SIC clearing day (a weekday that is not a closing day)? */
export function isClearingDay(date: string): boolean {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !sicHolidays(Number(date.slice(0, 4))).has(date);
}

/** The latest clearing day on or before `date`. */
export function clearingDayOnOrBefore(date: string): string {
  let d = date;
  while (!isClearingDay(d)) d = addDays(d, -1);
  return d;
}

/** The earliest clearing day on or after `date`. */
export function clearingDayOnOrAfter(date: string): string {
  let d = date;
  while (!isClearingDay(d)) d = addDays(d, 1);
  return d;
}

/** The clearing day strictly after `date`. */
export function nextClearingDay(date: string): string {
  return clearingDayOnOrAfter(addDays(date, 1));
}

/** The clearing day strictly before `date`. */
export function previousClearingDay(date: string): string {
  return clearingDayOnOrBefore(addDays(date, -1));
}

/**
 * `n` clearing days after the clearing day `date` (`n = 0` answers `date` itself). This is the
 * ARRIVAL model: a payment executed on `date` is credited to the creditor `n` clearing days later
 * (OR Art. 74 Abs. 2 Ziff. 1: a money debt is a Bringschuld, so what counts is arrival).
 */
export function addClearingDays(date: string, n: number): string {
  let d = date;
  for (let i = 0; i < n; i += 1) d = nextClearingDay(d);
  return d;
}

/**
 * The LATEST clearing day whose payment still arrives by `deadline` after `lag` clearing days: the
 * last clearing day on or before the deadline, stepped back `lag` clearing days.
 */
export function lastExecutionFor(deadline: string, lag: number): string {
  let d = clearingDayOnOrBefore(deadline);
  for (let i = 0; i < lag; i += 1) d = previousClearingDay(d);
  return d;
}
