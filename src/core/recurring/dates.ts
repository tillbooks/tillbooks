/**
 * A12's period arithmetic: the occurrence series, computed FROM THE ANCHOR, never from the previous
 * period.
 *
 * The month-end rule (US-A12.2 boundary): a schedule anchored on the 31st clamps to the last day of
 * shorter months and RETURNS to the 31st afterwards, because every occurrence is derived from the
 * anchor's own day-of-month rather than from the (already clamped) previous occurrence. Anchored
 * 2025-07-31, the series runs ...-08-31, -09-30, -10-31, ..., 2026-02-28, 2026-03-31 (critic probe
 * R3): no month billed twice, none skipped.
 *
 * All arithmetic is UTC and string-in/string-out on ISO `YYYY-MM-DD`. Nothing here reads a clock.
 */

import type { RecurringInterval } from './enums.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** A strict ISO calendar date: the right shape AND a real day (2026-02-30 is refused). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** An ISO instant (or date) truncated to its UTC calendar date. */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** `iso` plus `days` calendar days. */
export function addDays(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00.000Z`);
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

function daysInMonth(year: number, month1: number): number {
  // Day 0 of the NEXT month is the last day of this one.
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

const MONTH_STEP: Partial<Record<RecurringInterval, number>> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/**
 * Occurrence `n` (zero-based) of the series `(anchor, interval, customDays)`. Occurrence 0 IS the
 * anchor. For the month-based intervals the day-of-month is the ANCHOR's day, clamped per target
 * month; for `custom` it is a plain day stride.
 */
export function occurrenceAt(
  anchor: string,
  interval: RecurringInterval,
  customDays: number | null,
  n: number,
): string {
  if (interval === 'custom') {
    return addDays(anchor, n * (customDays ?? 1));
  }
  const step = MONTH_STEP[interval] ?? 1;
  const year = Number(anchor.slice(0, 4));
  const month1 = Number(anchor.slice(5, 7));
  const day = Number(anchor.slice(8, 10));
  const totalMonths = month1 - 1 + n * step;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth1 = (totalMonths % 12 + 12) % 12 + 1;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth1));
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

/**
 * The iteration bound: ~274 years at a one-day cadence. DELIBERATELY a bounded linear walk that
 * REFUSES past the bound rather than a closed-form solve: `updateRecurringSchedule` surfaces the
 * `undefined` as `invalid_input { field: 'anchorDate' }` (the anchor is what is unreachable), the
 * behaviour critic probe R9 pinned. It refuses, it never spins, and it never throws.
 */
export const MAX_OCCURRENCE_STEPS = 100_000;

/**
 * The first occurrence of the series on or after `from`, or `undefined` past the bound.
 */
export function firstOccurrenceOnOrAfter(
  anchor: string,
  interval: RecurringInterval,
  customDays: number | null,
  from: string,
): string | undefined {
  for (let n = 0; n <= MAX_OCCURRENCE_STEPS; n += 1) {
    const at = occurrenceAt(anchor, interval, customDays, n);
    if (at >= from) return at;
  }
  return undefined;
}

/**
 * The next occurrence strictly after `current`, or `undefined` past the bound. `current` is itself
 * an occurrence of the series in every caller (`next_run_date` is only ever written from this
 * module), but nothing here assumes it: the walk is from the anchor either way.
 */
export function nextOccurrenceAfter(
  anchor: string,
  interval: RecurringInterval,
  customDays: number | null,
  current: string,
): string | undefined {
  for (let n = 0; n <= MAX_OCCURRENCE_STEPS; n += 1) {
    const at = occurrenceAt(anchor, interval, customDays, n);
    if (at > current) return at;
  }
  return undefined;
}
