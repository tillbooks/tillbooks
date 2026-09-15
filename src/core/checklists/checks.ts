/**
 * G22's named live checks, composing EXISTING reads only (Pattern P5): the A02 draft count the A26
 * month-end checklist already runs, the A20/A21 unreconciled bank rows the G15 hub already counts,
 * the A26 `detectAnomalies` missing-tax-code kind (the same query A25's `preparePeriod` flags), A07's
 * own `computeVatReturn` and its promoted bridge, A03's `vat_filed` lock the way `vat_periods` reads
 * it, and (leg 2) A03's `period_lock` rows the way `list_period_locks` reads them. Nothing here
 * recomputes a figure.
 *
 * A check that THROWS reports `unavailable` with its key rather than failing the whole read: a
 * checklist row that says "Prüfung nicht verfügbar" is honest; a stack trace on a filing surface is
 * not.
 *
 * The two VAT-only checks read the return through the per-read memo (spec §10.2): on the
 * `vat_period` template that IS the anchor; on a close template it is fetched lazily, and a
 * workspace without A05 reads `unavailable` with `needs_vat_config` rather than a failing row.
 */

import type { WorkspaceContext } from '../context.js';
import { listVatPeriods } from '../vat/index.js';
import { detectAnomalies } from '../agent/index.js';
import { fiscalYearOf } from '../ledger/index.js';
import type { ReadMemo } from './anchor.js';
import { fiscalYearStartOf, monthsBetween, type ChecklistPeriod } from './periods.js';
import type { ChecklistCheckKey } from './types.js';

export { liveReturnOf } from './anchor.js';
export type { LiveReturn } from './anchor.js';

/** The period a run covers, as the checks need it (the resolved period's shape). */
export type CheckPeriod = ChecklistPeriod;

/** One check's live answer. `passed === null` means the check could not be evaluated. */
export interface CheckResult {
  readonly key: ChecklistCheckKey;
  readonly passed: boolean | null;
  /** The pending count behind a failing check, when the check counts things. */
  readonly count?: number;
  /** The reason a check is unavailable (a refusal code or an exception message). */
  readonly reason?: string;
}

function countDrafts(ctx: WorkspaceContext, period: CheckPeriod): number {
  const row = ctx.store.db
    .prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'draft' AND date <= ?`)
    .get(ctx.workspaceId, period.periodEnd) as { n: number };
  return row.n;
}

/**
 * Unreconciled bank movements up to the period end: an A20 `bank_txn` with neither a `bank_txn_link`
 * nor a settled A21 credit, plus every A21 queue row still `open` that no camt row carries (the
 * QR-registered credits). The same tables the G15 `qr_match` provider counts, bounded by the period.
 */
function countUnreconciledBank(ctx: WorkspaceContext, period: CheckPeriod): number {
  const txns = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM bank_txn t
        WHERE t.workspace_id = ?
          AND COALESCE(t.value_date, t.booking_date, t.created_at) <= ?
          AND NOT EXISTS (SELECT 1 FROM bank_txn_link l WHERE l.workspace_id = t.workspace_id AND l.bank_txn_id = t.id)
          AND (t.credit_id IS NULL
               OR EXISTS (SELECT 1 FROM reconciliation_match m WHERE m.id = t.credit_id AND m.status = 'open'))`,
    )
    .get(ctx.workspaceId, period.periodEnd) as { n: number };
  const credits = ctx.store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM reconciliation_match m
        WHERE m.workspace_id = ? AND m.status = 'open' AND m.value_date <= ?
          AND NOT EXISTS (SELECT 1 FROM bank_txn t WHERE t.workspace_id = m.workspace_id AND t.credit_id = m.id)`,
    )
    .get(ctx.workspaceId, period.periodEnd) as { n: number };
  return txns.n + credits.n;
}

/** The A26 anomaly read per month of the period (from its bounds), the `missing_tax_code` kind unioned. */
function countMissingTaxCodes(ctx: WorkspaceContext, period: CheckPeriod): number {
  const ids = new Set<string>();
  for (const month of monthsBetween(period.periodStart, period.periodEnd)) {
    const res = detectAnomalies(ctx, { period: month });
    if (!res.ok) throw new Error(`detect_anomalies: ${res.error}`);
    const anomalies = Array.isArray(res.anomalies) ? (res.anomalies as { kind: string; entryIds: string[] }[]) : [];
    for (const a of anomalies) if (a.kind === 'missing_tax_code') for (const id of a.entryIds) ids.add(id);
  }
  return ids.size;
}

/** Every month of the period carries A03's hard `vat_filed` lock, the `vat_periods.filed` reading. */
function periodLockedVatFiled(ctx: WorkspaceContext, period: CheckPeriod): boolean {
  const res = listVatPeriods(ctx, { year: period.periodStart.slice(0, 4) });
  if (!res.ok) throw new Error(`vat_periods: ${res.error}`);
  const periods = Array.isArray(res.periods) ? (res.periods as { label: string; filed: boolean }[]) : [];
  const match = periods.find((p) => p.label === period.label);
  return match?.filed === true;
}

// --- A03 lock readers, shared with the probes ---------------------------------------------------

/** A03's lock row for a period label (`YYYY-MM` or `YYYY`), the way `list_period_locks` reads it. */
export function periodLockOf(ctx: WorkspaceContext, label: string): { kind: string; reason: string | null } | undefined {
  return ctx.store.db
    .prepare('SELECT kind, reason FROM period_lock WHERE workspace_id = ? AND period = ?')
    .get(ctx.workspaceId, label) as { kind: string; reason: string | null } | undefined;
}

/** The fiscal year label the period end falls in (the run's own label on a `year` run). */
export function yearLabelOf(ctx: WorkspaceContext, period: CheckPeriod): string {
  return /^\d{4}$/.test(period.label) ? period.label : fiscalYearOf(period.periodEnd, fiscalYearStartOf(ctx));
}

/** A soft or hard lock on the month the period ends in. */
export function lockOnMonth(ctx: WorkspaceContext, period: CheckPeriod): boolean {
  return periodLockOf(ctx, period.periodEnd.slice(0, 7)) !== undefined;
}

/** A lock of either kind on the fiscal year (the soft year lock is the "in Abschluss" state; a seal counts). */
export function lockOnYear(ctx: WorkspaceContext, period: CheckPeriod): boolean {
  return periodLockOf(ctx, yearLabelOf(ctx, period)) !== undefined;
}

/** The `year_close` seal on the fiscal year. */
export function sealOnYear(ctx: WorkspaceContext, period: CheckPeriod): boolean {
  const lock = periodLockOf(ctx, yearLabelOf(ctx, period));
  return lock !== undefined && lock.kind === 'hard' && lock.reason === 'year_close';
}

/** Evaluate one check. Never throws: an exception is an `unavailable` result carrying its message. */
export function evaluateCheck(ctx: WorkspaceContext, key: ChecklistCheckKey, period: CheckPeriod, memo: ReadMemo): CheckResult {
  try {
    switch (key) {
      case 'no_drafts': {
        const count = countDrafts(ctx, period);
        return { key, passed: count === 0, count };
      }
      case 'bank_reconciled': {
        const count = countUnreconciledBank(ctx, period);
        return { key, passed: count === 0, count };
      }
      case 'no_missing_tax_codes': {
        const count = countMissingTaxCodes(ctx, period);
        return { key, passed: count === 0, count };
      }
      case 'vat_return_computed': {
        const live = memo.vatReturn();
        if (live.ok) return { key, passed: true };
        // On the VAT template a refused return is a failing row (the run exists to compute it); on a
        // close template it is a check that cannot be evaluated (no A05, spec §10.2).
        return memo.anchor.kind === 'vat_return'
          ? { key, passed: false, reason: live.error ?? 'refused' }
          : { key, passed: null, reason: live.error ?? 'needs_vat_config' };
      }
      case 'abstimmung_resolved': {
        const live = memo.vatReturn();
        if (!live.ok || live.bridge === null) {
          return memo.anchor.kind === 'vat_return'
            ? { key, passed: false, reason: live.error ?? 'refused' }
            : { key, passed: null, reason: live.error ?? 'needs_vat_config' };
        }
        const kind = live.bridge.kind;
        return { key, passed: kind === 'match' || kind === 'notApplicable', count: kind === 'open' ? 1 : 0 };
      }
      case 'period_locked_vat_filed':
        return { key, passed: periodLockedVatFiled(ctx, period) };
      case 'lock_on_month':
        return { key, passed: lockOnMonth(ctx, period) };
      case 'soft_lock_on_year':
        return { key, passed: lockOnYear(ctx, period) };
      case 'seal_on_year':
        return { key, passed: sealOnYear(ctx, period) };
    }
  } catch (e) {
    return { key, passed: null, reason: e instanceof Error ? e.message : String(e) };
  }
}
