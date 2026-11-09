/**
 * D186 point 3, FAIR COMPARISONS: the windows a key figure is compared against, like for like.
 *
 * The old revenue trend compared the chosen range with the equal-length window before it, so on the 9th
 * of a month the current month (nine booked days) was set against the whole previous month and read as a
 * fall every month. Both windows here stop at the same point: the range is cut at `through`, the earlier
 * of its end and today (the injected clock), and the comparison window is cut at the matching day.
 *
 *  - `previous_period`: a range of whole calendar months (a month, a quarter, a year, any run of months)
 *    is shifted back by its own number of months, day for day (01.11. to 09.11. against 01.10. to 09.10.;
 *    a 31st falls to the last day of a shorter month). Any other range keeps the old rule: the window of
 *    the same length ending the day before `from`, cut at the same offset.
 *  - `previous_year`: the same days one year earlier (29.02. falls to 28.02.).
 *
 * Which mode a tile shows is the person's setting (`overview.compare`, per tile in `overview.tiles`); the
 * engine always answers both, so an agent and every Studio choice read the same figures.
 */

export const COMPARE_MODES = ['previous_period', 'previous_year'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export interface Window {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;

function parse(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return iso(new Date(parse(date).getTime() + days * DAY_MS));
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `date` moved by `months` calendar months, its day clamped to the target month's length. */
export function shiftMonths(date: string, months: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const total = y * 12 + (m - 1) + months;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const td = Math.min(d, lastDay(ty, tm));
  return `${ty}-${String(tm).padStart(2, '0')}-${String(td).padStart(2, '0')}`;
}

/**
 * `date` moved by `months`, a month's LAST day landing on the target month's last day (critic D186-5: the
 * whole February 2029 compares with the whole February 2028, its 29th included).
 */
export function shiftMonthsEnd(date: string, months: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (Number(date.slice(8, 10)) !== lastDay(y, m)) return shiftMonths(date, months);
  const shifted = shiftMonths(`${date.slice(0, 7)}-01`, months);
  const ty = Number(shifted.slice(0, 4));
  const tm = Number(shifted.slice(5, 7));
  return `${shifted.slice(0, 7)}-${String(lastDay(ty, tm)).padStart(2, '0')}`;
}

/** The number of whole calendar months [from, to] spans, or null when it is not whole months. */
export function wholeMonths(from: string, to: string): number | null {
  if (from.slice(8, 10) !== '01') return null;
  const y = Number(to.slice(0, 4));
  const m = Number(to.slice(5, 7));
  if (Number(to.slice(8, 10)) !== lastDay(y, m)) return null;
  return (y - Number(from.slice(0, 4))) * 12 + (m - Number(from.slice(5, 7))) + 1;
}

/**
 * D186 (D172): how a running range is cut. `same_day` (default) stops at today; `whole_period` compares
 * the whole range with the whole earlier one, the old rule, for a person who wants it.
 */
export const COMPARE_CUTS = ['same_day', 'whole_period'] as const;
export type CompareCut = (typeof COMPARE_CUTS)[number];

/** Where the range is compared up to: its end, or today when the range runs past today (`same_day`). */
export function comparedThrough(range: Window, today: string, cut: CompareCut = 'same_day'): string {
  if (cut === 'whole_period') return range.to;
  return range.to > today && range.from <= today ? today : range.to;
}

/** The comparison window for `mode`, cut at the day matching `through`. */
export function compareWindow(mode: CompareMode, range: Window, through: string): Window {
  if (mode === 'previous_year') return { from: shiftMonths(range.from, -12), to: shiftMonthsEnd(through, -12) };
  const months = wholeMonths(range.from, range.to);
  if (months !== null) {
    const from = shiftMonths(range.from, -months);
    // The matching day: as far into the earlier window as `through` is into this one, never past its end.
    const end = addDays(range.from, -1);
    const to = through === range.to ? end : minIso(shiftMonthsEnd(through, -months), end);
    return { from, to };
  }
  const lengthDays = Math.round((parse(range.to).getTime() - parse(range.from).getTime()) / DAY_MS);
  const offsetDays = Math.round((parse(through).getTime() - parse(range.from).getTime()) / DAY_MS);
  const prevTo = addDays(range.from, -1);
  const prevFrom = addDays(prevTo, -lengthDays);
  return { from: prevFrom, to: addDays(prevFrom, offsetDays) };
}

function minIso(a: string, b: string): string {
  return a < b ? a : b;
}

/** A change in basis points against `base`: one division, one rounding; null against a zero base. */
export function changeBp(value: number, base: number): number | null {
  return base === 0 ? null : Math.round(((value - base) * 10000) / Math.abs(base));
}
