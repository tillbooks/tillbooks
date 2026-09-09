/**
 * G22's named live checks, composing EXISTING reads only (Pattern P5): the A02 draft count the A26
 * month-end checklist already runs, the A20/A21 unreconciled bank rows the G15 hub already counts,
 * the A26 `detectAnomalies` missing-tax-code kind (the same query A25's `preparePeriod` flags), A07's
 * own `computeVatReturn` and its promoted bridge, and A03's `vat_filed` lock the way `vat_periods`
 * reads it. Nothing here recomputes a figure.
 *
 * A check that THROWS reports `unavailable` with its key rather than failing the whole read: a
 * checklist row that says "Prüfung nicht verfügbar" is honest; a stack trace on a filing surface is
 * not.
 */

import type { WorkspaceContext } from '../context.js';
import { computeVatReturn, listVatPeriods, vatBridgeOf, type VatBridge } from '../vat/index.js';
import { detectAnomalies } from '../agent/index.js';
import { monthsOfVatPeriod } from '../vat/abrechnung.js';
import { returnHashOf } from './hash.js';
import type { ChecklistCheckKey } from './types.js';

/** The period a run covers, as the checks need it. */
export interface CheckPeriod {
  readonly label: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}

/** One check's live answer. `passed === null` means the check could not be evaluated. */
export interface CheckResult {
  readonly key: ChecklistCheckKey;
  readonly passed: boolean | null;
  /** The pending count behind a failing check, when the check counts things. */
  readonly count?: number;
  /** The reason a check is unavailable (a refusal code or an exception message). */
  readonly reason?: string;
}

/**
 * The computed return, evaluated ONCE per read and shared by every check and by the evidence
 * binding: `vat_return_computed`, `abstimmung_resolved`, and the hash a verb item is bound to.
 */
export interface LiveReturn {
  readonly ok: boolean;
  readonly error?: string;
  readonly hash: string | null;
  readonly bridge: VatBridge | null;
  readonly payload: Record<string, unknown> | null;
}

export function liveReturnOf(ctx: WorkspaceContext, period: CheckPeriod): LiveReturn {
  const res = computeVatReturn(ctx, { periodStart: period.periodStart, periodEnd: period.periodEnd });
  if (!res.ok) return { ok: false, error: res.error, hash: null, bridge: null, payload: null };
  const payload = res as unknown as Record<string, unknown>;
  const bridge =
    typeof payload.bridge === 'object' && payload.bridge !== null
      ? (payload.bridge as VatBridge)
      : vatBridgeOf(payload as never);
  return { ok: true, hash: returnHashOf(payload), bridge, payload };
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

/** The A26 anomaly read per month of the period, the `missing_tax_code` kind unioned. */
function countMissingTaxCodes(ctx: WorkspaceContext, period: CheckPeriod): number {
  const months = monthsOfVatPeriod(period.label) ?? [];
  const ids = new Set<string>();
  for (const month of months) {
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

/** Evaluate one check. Never throws: an exception is an `unavailable` result carrying its message. */
export function evaluateCheck(
  ctx: WorkspaceContext,
  key: ChecklistCheckKey,
  period: CheckPeriod,
  live: LiveReturn,
): CheckResult {
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
      case 'vat_return_computed':
        return live.ok ? { key, passed: true } : { key, passed: false, reason: live.error ?? 'refused' };
      case 'abstimmung_resolved': {
        if (!live.ok || live.bridge === null) return { key, passed: false, reason: live.error ?? 'refused' };
        const kind = live.bridge.kind;
        return { key, passed: kind === 'match' || kind === 'notApplicable', count: kind === 'open' ? 1 : 0 };
      }
      case 'period_locked_vat_filed':
        return { key, passed: periodLockedVatFiled(ctx, period) };
    }
  } catch (e) {
    return { key, passed: null, reason: e instanceof Error ? e.message : String(e) };
  }
}
