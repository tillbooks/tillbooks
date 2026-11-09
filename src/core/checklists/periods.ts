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
import { fiscalYearOf, OPENING_KEY_PREFIX } from '../ledger/index.js';
import { BANK_OPENING_KEY_PREFIX } from '../banking/bankAccounts.js';
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

/**
 * Where these books begin, for the AUTO-start bound (beta launch P0.4a, spec §10.8 amendment).
 *
 * THE DEFECT. A company created on 30.09 opened its first Pendenzen on four "überfällig" items of the
 * August Monatsabschluss: the daily rule starts "the last ended period", and on day 0 that is a month
 * the books never covered. An auto-start is a reminder to close a period THESE books kept, so it is
 * bounded by the day they begin. The base bound is:
 *
 *   - the Stichtag, when the workspace has one: the earliest Übernahmestichtag of a migration plan that
 *     was not abandoned (`migration_plan.cutover_date`, G09) or the date of a posted opening-balance
 *     entry (A04, dated AT its Stichtag), whichever is earlier. A migrated company's books begin
 *     there, even when the workspace was created months later, so its catch-up months still start;
 *   - otherwise the day the workspace was created.
 *
 * A period that ENDS on or before the base bound is not auto-started: the Stichtag is the last day of
 * the old system, and a period ending on the creation day with nothing booked in it has nothing to close.
 *
 * THE FOURTH SOURCE (critic phase0-installable r1, P0.4a-1). The books also begin on the earliest day
 * they hold a POSTED entry (`first_posting`). A company that opens TILL on 05.10 and books its Q3 by
 * hand to prepare the MWST return it still owes keeps Q3 in THESE books, so Q3 must still auto-start.
 * The earliest of the two wins. A first posting is a book day itself, so a period is skipped only when
 * it ends strictly BEFORE it (`inclusive: true`): a company created on 30.09 that books on 30.09 still
 * gets September and Q3.
 *
 * What does NOT count: the engine's own opening postings, the carried-over position that belongs to the
 * Stichtag and not to activity in the period (A04's `opening-balances:` entry and A19's `bank-opening:`
 * entry, both `source = 'import'`). They are recognised by their idempotency-key namespaces, NOT by the
 * source (critic phase0-installable r2, R2-3): `post_entry` lets any caller choose `import`, and a
 * back-posted Q3 labelled so must keep its reminder. Nor do `reversal` entries: a reversal mirrors an
 * original that is itself counted, and one of an opening entry is a Stichtag correction.
 *
 * A HAND start is never bounded: a person (or an agent) naming a period asks for it deliberately.
 */
export type BooksStart = {
  /** The ISO day the books begin. */
  readonly date: string;
  readonly source: 'migration_cutover' | 'opening_balance' | 'workspace_created' | 'first_posting';
  /**
   * Whether `date` is itself a book day. `true` (a first posting): a period ending ON `date` holds an
   * entry and is auto-started. `false` (a Stichtag, the creation day): a period ending on or before
   * `date` is not.
   */
  readonly inclusive: boolean;
};

/** The one auto-start rule over a `BooksStart`: does a period ending on `periodEnd` predate these books? */
export function periodPredatesBooks(periodEnd: string, booksStart: BooksStart): boolean {
  return booksStart.inclusive ? periodEnd < booksStart.date : periodEnd <= booksStart.date;
}

function baseBooksStartOf(ctx: WorkspaceContext): BooksStart {
  const cutover = ctx.store.db
    .prepare(
      `SELECT MIN(cutover_date) AS d FROM migration_plan
        WHERE workspace_id = ? AND cutover_date IS NOT NULL AND cutover_date <> '' AND status <> 'abandoned'`,
    )
    .get(ctx.workspaceId) as { d: string | null } | undefined;
  const opening = ctx.store.db
    .prepare(
      `SELECT MIN(date) AS d FROM journal_entry
        WHERE workspace_id = ? AND status = 'posted' AND source = 'import' AND idempotency_key LIKE ?`,
    )
    .get(ctx.workspaceId, `${OPENING_KEY_PREFIX}:%`) as { d: string | null } | undefined;
  const cutoverDay = cutover?.d?.slice(0, 10) ?? null;
  const openingDay = opening?.d?.slice(0, 10) ?? null;
  if (cutoverDay !== null && (openingDay === null || cutoverDay <= openingDay)) {
    return { date: cutoverDay, source: 'migration_cutover', inclusive: false };
  }
  if (openingDay !== null) return { date: openingDay, source: 'opening_balance', inclusive: false };
  const ws = ctx.store.db
    .prepare('SELECT created_at FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { created_at: string } | undefined;
  return { date: (ws?.created_at ?? ctx.clock.now()).slice(0, 10), source: 'workspace_created', inclusive: false };
}

export function booksStartOf(ctx: WorkspaceContext): BooksStart {
  const base = baseBooksStartOf(ctx);
  const first = ctx.store.db
    .prepare(
      `SELECT MIN(date) AS d FROM journal_entry
        WHERE workspace_id = ? AND status = 'posted' AND source <> 'reversal'
          AND NOT (source = 'import' AND (idempotency_key LIKE ? OR idempotency_key LIKE ?))`,
    )
    .get(ctx.workspaceId, `${OPENING_KEY_PREFIX}:%`, `${BANK_OPENING_KEY_PREFIX}:%`) as { d: string | null } | undefined;
  const firstDay = first?.d?.slice(0, 10) ?? null;
  if (firstDay === null) return base;
  // An inclusive first posting on day P lets a period ending on P start; the exclusive base bound B lets
  // one ending on B+1 start. So the first posting is the earlier start when P < B, and on a tie when B
  // is the creation day (a book day). A Stichtag is the old system's last day: an entry dated ON it
  // (a cutover adjustment) does not hand the period ending on it to these books.
  const earlier = firstDay < base.date || (firstDay === base.date && base.source === 'workspace_created');
  return earlier ? { date: firstDay, source: 'first_posting', inclusive: true } : base;
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
