/**
 * B04 period math: the ONE place a `period_key` is formed, bounded and stepped, so create,
 * generate, run-due, burn-down and the rollover carryover all agree on what "the 2026-06 period" or
 * "Q2 2026" means and when it has ended. Pure functions over ISO calendar days; no clock, no store.
 *
 * A `period_key` is `YYYY-MM` for a monthly retainer and `YYYY-Qn` (n in 1..4) for a quarterly one.
 * A period is CLOSED (generatable) relative to a reference day `asOf` when the whole period lies in
 * the past, i.e. `asOf >= periodEndExclusive(key)`. That is the US-B04.2 `period_not_closed` gate and
 * the US-B04.5 rollover boundary, both measured from the same function.
 */

import type { RetainerPeriod } from './enums.js';

const MONTHLY_KEY = /^(\d{4})-(\d{2})$/;
const QUARTERLY_KEY = /^(\d{4})-Q([1-4])$/;

/** A well-formed, in-range `period_key` for this retainer's period type. */
export function isPeriodKey(period: RetainerPeriod, key: unknown): key is string {
  if (typeof key !== 'string') return false;
  if (period === 'monthly') {
    const m = MONTHLY_KEY.exec(key);
    if (m === null) return false;
    const month = Number(m[2]);
    return month >= 1 && month <= 12;
  }
  return QUARTERLY_KEY.test(key);
}

/** The `period_key` that CONTAINS an ISO day, for this retainer's period type. */
export function periodKeyOf(period: RetainerPeriod, isoDay: string): string {
  const year = isoDay.slice(0, 4);
  const month = Number(isoDay.slice(5, 7));
  if (period === 'monthly') return `${year}-${isoDay.slice(5, 7)}`;
  const quarter = Math.floor((month - 1) / 3) + 1;
  return `${year}-Q${quarter}`;
}

/** The first ISO day of a period. */
export function periodStart(period: RetainerPeriod, key: string): string {
  if (period === 'monthly') {
    const m = MONTHLY_KEY.exec(key) as RegExpExecArray;
    return `${m[1]}-${m[2]}-01`;
  }
  const q = QUARTERLY_KEY.exec(key) as RegExpExecArray;
  const firstMonth = (Number(q[2]) - 1) * 3 + 1;
  return `${q[1]}-${String(firstMonth).padStart(2, '0')}-01`;
}

/** The first ISO day AFTER a period (its exclusive end). A period has ended at `asOf` when
 *  `asOf >= periodEndExclusive(key)`. */
export function periodEndExclusive(period: RetainerPeriod, key: string): string {
  if (period === 'monthly') {
    const m = MONTHLY_KEY.exec(key) as RegExpExecArray;
    const year = Number(m[1]);
    const month = Number(m[2]);
    return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  }
  const q = QUARTERLY_KEY.exec(key) as RegExpExecArray;
  const year = Number(q[1]);
  const quarter = Number(q[2]);
  return quarter === 4 ? `${year + 1}-01-01` : `${year}-${String(quarter * 3 + 1).padStart(2, '0')}-01`;
}

/** The `period_key` immediately following this one (for the rollover `carryover_in` row). */
export function nextPeriodKey(period: RetainerPeriod, key: string): string {
  return periodKeyOf(period, periodEndExclusive(period, key));
}

/** Is a period CLOSED (fully in the past) at reference day `asOf`? */
export function periodHasEnded(period: RetainerPeriod, key: string, asOf: string): boolean {
  return asOf >= periodEndExclusive(period, key);
}
