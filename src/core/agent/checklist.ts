/**
 * A26 US-A26.4, `monthEndChecklist`: aggregate the existing read models into a close checklist. It
 * WRITES NOTHING (readOnlyHint): every item is a count plus its drill-down ids, and the human (or
 * Treuhänder) acts on it. It composes A02 (drafts), A16 (`listOpenItems`) and A07 (`computeVatReturn`)
 * rather than recomputing any of them. The A22 FX line reads the revaluation run row for the month end
 * (D129 leg 2, N4): `ok` when the month's revaluation is posted and unreverted or when the books carry
 * no foreign-currency position at the month end, `attention` when positions exist and no run does
 * (the count is the positions, the note names a missing rate). Until 2026-09-10 the line said
 * `not_available` because the revaluation was not built; it is, and the line reads it.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { listOpenItems } from '../debtors/index.js';
import { computeVatReturn } from '../vat/index.js';
import { computeFxRevaluation } from '../fx/index.js';

export interface MonthEndChecklistInput {
  period?: unknown;
}

export interface ChecklistItem {
  kind: string;
  count: number;
  drillIds: string[];
  status: 'ok' | 'attention' | 'not_available';
  note?: string;
}

/** Inclusive [start, end] ISO days for a `YYYY-MM` period. Pure arithmetic, no wall clock. */
function monthRange(period: string): { start: string; end: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const daysInMonth = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const last = daysInMonth[month - 1] as number;
  return { start: `${m[1]}-${m[2]}-01`, end: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
}

/** The A22 line of the month-end checklist (see the module docblock). */
function fxRevaluationItem(ctx: WorkspaceContext, periodEnd: string): ChecklistItem {
  const run = ctx.store.db
    .prepare('SELECT id, entry_id, storno_entry_id FROM fx_revaluation WHERE workspace_id = ? AND period_end = ?')
    .get(ctx.workspaceId, periodEnd) as { id: string; entry_id: string | null; storno_entry_id: string | null } | undefined;
  if (run !== undefined && run.entry_id !== null && run.storno_entry_id === null) {
    return { kind: 'fx_revaluation', count: 0, drillIds: [run.entry_id], status: 'ok', note: `posted, run ${run.id}` };
  }
  const res = computeFxRevaluation(ctx, { periodEnd });
  if (!res.ok) {
    return { kind: 'fx_revaluation', count: 0, drillIds: [], status: 'not_available', note: `fx_revaluation refused: ${res.error ?? 'refused'}` };
  }
  const positions = Array.isArray(res.positions) ? (res.positions as { accountId?: string }[]) : [];
  const needsRate = Array.isArray(res.needsRate) ? (res.needsRate as unknown[]) : [];
  if (positions.length === 0 && needsRate.length === 0) {
    return { kind: 'fx_revaluation', count: 0, drillIds: [], status: 'ok', note: 'no foreign-currency position at the month end' };
  }
  const drillIds = positions.map((p) => p.accountId).filter((id): id is string => typeof id === 'string');
  return {
    kind: 'fx_revaluation',
    count: positions.length + needsRate.length,
    drillIds,
    status: 'attention',
    note: needsRate.length > 0 ? `${needsRate.length} position(s) without a rate; post_fx_revaluation {periodEnd: ${periodEnd}} once the rates are on file` : `not posted; post_fx_revaluation {periodEnd: ${periodEnd}}`,
  };
}

export function monthEndChecklist(ctx: WorkspaceContext, input: MonthEndChecklistInput): Result {
  if (typeof input.period !== 'string') return err('invalid_input', { field: 'period' });
  const range = monthRange(input.period);
  if (range === null) return err('invalid_input', { field: 'period', expected: 'YYYY-MM' });

  const items: ChecklistItem[] = [];

  // A02: dangling / unbalanced drafts up to the period end.
  const drafts = ctx.store.db
    .prepare(
      `SELECT id FROM journal_entry
        WHERE workspace_id = ? AND status = 'draft' AND date <= ?
        ORDER BY date DESC LIMIT 200`,
    )
    .all(ctx.workspaceId, range.end) as { id: string }[];
  items.push({
    kind: 'dangling_drafts',
    count: drafts.length,
    drillIds: drafts.map((d) => d.id),
    status: drafts.length > 0 ? 'attention' : 'ok',
  });

  // A16: open debtors as of the period end (composed, not recomputed).
  const op = listOpenItems(ctx, { asOf: range.end });
  if (op.ok) {
    const opItems = Array.isArray(op.items) ? (op.items as { documentId?: string }[]) : [];
    const drillIds = opItems.map((i) => i.documentId).filter((d): d is string => typeof d === 'string');
    items.push({
      kind: 'open_debtors',
      count: opItems.length,
      drillIds,
      status: opItems.length > 0 ? 'attention' : 'ok',
    });
  }

  // A17: open creditor bills (posted vendor bills) as of the period end.
  const bills = ctx.store.db
    .prepare(
      `SELECT id FROM vendor_bill
        WHERE workspace_id = ? AND status = 'posted' AND bill_date <= ?
        ORDER BY bill_date DESC LIMIT 200`,
    )
    .all(ctx.workspaceId, range.end) as { id: string }[];
  items.push({
    kind: 'open_creditors',
    count: bills.length,
    drillIds: bills.map((b) => b.id),
    status: bills.length > 0 ? 'attention' : 'ok',
  });

  // A07: a MWST preview for the month (composed).
  const vat = computeVatReturn(ctx, { periodStart: range.start, periodEnd: range.end } as never);
  if (vat.ok) {
    const payableMinor = typeof vat.payableMinor === 'number' ? vat.payableMinor : 0;
    const creditMinor = typeof vat.creditMinor === 'number' ? vat.creditMinor : 0;
    items.push({
      kind: 'vat_preview',
      count: 0,
      drillIds: [],
      status: 'ok',
      note: `payableMinor=${payableMinor}, creditMinor=${creditMinor}`,
    });
  }

  // A22 FX revaluation at the month end: the run row first (posted and not reverted through
  // fx_revaluation_reverse), then the positions the read would revalue.
  items.push(fxRevaluationItem(ctx, range.end));

  return ok({ period: input.period, items });
}
