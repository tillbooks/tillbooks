/**
 * G22 period resolution per period kind (spec §10.3): the ONE place a run's label and ISO bounds come
 * from, for `checklist_start`, the prompt and the auto-start rule.
 *
 *   - `vat_period`: A07's `vat_periods` for the year (unchanged from D127). A label that is not one of
 *     the year's filing periods refuses `period_not_filable` naming them; no A05 configuration refuses
 *     `needs_vat_config` (the read's own code, passed through).
 *   - `month`: `YYYY-MM` over the calendar month.
 *   - `year`: the fiscal year label A03's `fiscalYearOf` uses (the calendar year the fiscal year STARTS
 *     in), bounded `[YYYY-<fiscal_year_start>, dayBefore(next start)]` from `workspace.fiscal_year_start`.
 *
 * `month` and `year` refuse `period_not_ended` while the period end has not passed (a close over a
 * period still being written to would be a claim about figures that are still moving), and `year`
 * refuses `year_already_closed` when A03 carries the `year_close` seal for that label: the
 * `year_close` template has nothing left to do there, and starting a run would suggest it does.
 *
 * With no label the last ENDED period of the kind is picked (the prompt's `pickChecklistPeriod`,
 * generalised), so `checklist_start` without `period` is legal and stays idempotent on the natural key:
 * that is what the seeded daily auto-start rule relies on (§10.8).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { listVatPeriods } from '../vat/index.js';
import { fiscalYearOf } from '../ledger/index.js';
import { addDays, dayBefore, endOfMonth } from './deadlines.js';
import type { ChecklistPeriodKind } from './types.js';

/** A resolved period: the label the run stores and its ISO bounds. A type alias: it rides in `Result`. */
export type ChecklistPeriod = {
  readonly label: string;
  readonly periodStart: string;
  readonly periodEnd: string;
};

/** The ledger's month shape: `2026-00` and `2026-13` are not months. */
export const MONTH_LABEL = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_LABEL = /^\d{4}$/;

/** Today as an ISO day, from the workspace clock (never `Date.now()`: the fixture clock is the truth). */
export function todayOf(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/** `workspace.fiscal_year_start` as `MM-DD`, `01-01` when unset (the A03 default). */
export function fiscalYearStartOf(ctx: WorkspaceContext): string {
  const row = ctx.store.db
    .prepare('SELECT fiscal_year_start FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { fiscal_year_start: string | null } | undefined;
  return row?.fiscal_year_start ?? '01-01';
}

/** The bounds of a calendar month label. */
export function monthBounds(label: string): ChecklistPeriod {
  const periodStart = `${label}-01`;
  return { label, periodStart, periodEnd: endOfMonth(periodStart) };
}

/** The bounds of a fiscal year label under a `MM-DD` fiscal year start. */
export function fiscalYearBounds(label: string, fiscalYearStart: string): ChecklistPeriod {
  const periodStart = `${label}-${fiscalYearStart}`;
  const nextStart = `${String(Number(label) + 1).padStart(4, '0')}-${fiscalYearStart}`;
  return { label, periodStart, periodEnd: dayBefore(nextStart) };
}

/** Every `YYYY-MM` from the month of `periodStart` to the month of `periodEnd`, in order. */
export function monthsBetween(periodStart: string, periodEnd: string): string[] {
  const out: string[] = [];
  let cursor = `${periodStart.slice(0, 7)}-01`;
  const last = periodEnd.slice(0, 7);
  while (cursor.slice(0, 7) <= last) {
    out.push(cursor.slice(0, 7));
    cursor = addDays(endOfMonth(cursor), 1);
  }
  return out;
}

/** Does A03 carry the `year_close` seal for a fiscal year label? (The same read `hardCloseYear` makes.) */
export function yearSealedOf(ctx: WorkspaceContext, yearLabel: string): boolean {
  const row = ctx.store.db
    .prepare("SELECT 1 AS one FROM period_lock WHERE workspace_id = ? AND period = ? AND kind = 'hard' AND reason = 'year_close'")
    .get(ctx.workspaceId, yearLabel) as { one: number } | undefined;
  return row !== undefined;
}

function vatPeriodsOf(ctx: WorkspaceContext, year: string): Result<{ periods: ChecklistPeriod[] }> {
  const res = listVatPeriods(ctx, { year });
  if (!res.ok) return res;
  const periods = Array.isArray(res.periods)
    ? (res.periods as ChecklistPeriod[]).map((p) => ({ label: p.label, periodStart: p.periodStart, periodEnd: p.periodEnd }))
    : [];
  return ok({ periods });
}

/**
 * Resolve the period a run covers. `label` may be omitted (the last ended period of the kind) or
 * given (validated against the kind, refused with the kind's own code when it is not a period).
 */
export function resolveChecklistPeriod(
  ctx: WorkspaceContext,
  periodKind: ChecklistPeriodKind,
  label?: unknown,
): Result<ChecklistPeriod> {
  const today = todayOf(ctx);
  const requested = typeof label === 'string' && label.length > 0 ? label : null;

  if (periodKind === 'vat_period') {
    if (requested !== null) {
      const res = vatPeriodsOf(ctx, requested.slice(0, 4));
      if (!res.ok) return res;
      const match = res.periods.find((p) => p.label === requested);
      if (match === undefined) return err('period_not_filable', { period: requested, periods: res.periods.map((p) => p.label) });
      return ok(match);
    }
    const year = Number(today.slice(0, 4));
    for (const y of [year, year - 1]) {
      const res = vatPeriodsOf(ctx, String(y));
      if (!res.ok) return res;
      const ended = res.periods.filter((p) => p.periodEnd < today);
      const last = ended[ended.length - 1];
      if (last !== undefined) return ok(last);
    }
    return err('period_not_filable', { period: null, reason: 'no period has ended yet' });
  }

  if (periodKind === 'month') {
    let period: ChecklistPeriod;
    if (requested !== null) {
      if (!MONTH_LABEL.test(requested)) return err('invalid_period', { period: requested, expected: 'YYYY-MM' });
      period = monthBounds(requested);
    } else {
      // The last ended month: today's month has not ended (its end is >= today), so the month before.
      period = monthBounds(dayBefore(`${today.slice(0, 7)}-01`).slice(0, 7));
    }
    if (period.periodEnd >= today) return err('period_not_ended', { period: period.label, periodEnd: period.periodEnd, today });
    return ok(period);
  }

  // year
  const fys = fiscalYearStartOf(ctx);
  let period: ChecklistPeriod;
  if (requested !== null) {
    if (!YEAR_LABEL.test(requested)) return err('invalid_period', { period: requested, expected: 'YYYY' });
    period = fiscalYearBounds(requested, fys);
  } else {
    // The fiscal year today falls in has not ended; the one before it has.
    const current = fiscalYearOf(today, fys);
    period = fiscalYearBounds(String(Number(current) - 1).padStart(4, '0'), fys);
  }
  if (period.periodEnd >= today) return err('period_not_ended', { period: period.label, periodEnd: period.periodEnd, today });
  if (yearSealedOf(ctx, period.label)) return err('year_already_closed', { period: period.label, periodEnd: period.periodEnd });
  return ok(period);
}
