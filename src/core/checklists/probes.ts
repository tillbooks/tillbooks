/**
 * The probes (spec G22 §10.4): how a `posting` row sees its artefact. A probe READS the ledger and the
 * domain tables and never writes, because it runs inside `checklist_get`; the domain verb is the act
 * and the row flips by derivation. `found === null` is `unavailable` with a reason.
 *
 *   - `fx_revaluation_posted`: the A22 run row for the period end, its entry posted and the run not
 *     reverted through `fx_revaluation_reverse` (the run row's `storno_entry_id`, D129 Q2).
 *   - `depreciation_charged`: every month of the period carries a posted H04 run, or the H03
 *     `asset_depreciation_preview` READ for that month answers no line with an amount (nothing was
 *     eligible). The row names the months without a run. Never the run-create write (reconciled).
 *   - `accruals_posted`: no A38 draft left for the period end and at least one posted, unreversed
 *     accrual dated it; the entry ids and the auto-reversal date feed the row.
 *   - `provisions_posted`: no draft left for the period end and at least one posting or release dated
 *     it. Provisions with reason `steuern` are the tax row's (13a) and are excluded here so the two
 *     rows stay disjoint (reconciled 2026-09-10).
 *   - `tax_provision_posted`: a posted, unreversed provision with reason `steuern` for the period end.
 *   - `vat_settlement_posted`: on a MWST-Periode run the one settlement of that period; on a year run
 *     every FILED period of the calendar year settled, with the per-period table in `detail.periods`
 *     (label, filed, settled, settlement id, net) that the row and the prompt render. A FILED period
 *     whose settlement model says `nothingToSettle` (no tax booked at all) holds vacuously: the tax
 *     accounts already read zero for it, `vat_settlement_post` would refuse `nothing_to_settle`, and a
 *     row nobody can ever flip would be the dead end §4 forbids; such a period carries
 *     `nothingToSettle: true` so the row and the prompt say "nichts zu saldieren", never "gebucht".
 *     A workspace without A05 answers `unavailable` (`needs_vat_config`).
 *   - the three lock probes read A03 the way the checks do.
 */

import type { WorkspaceContext } from '../context.js';
import { previewDepreciation } from '../assets/index.js';
import { listVatPeriods } from '../vat/index.js';
import { settlementModelOf } from '../accruals/index.js';
import { lockOnMonth, lockOnYear, sealOnYear } from './checks.js';
import { monthsBetween, type ChecklistPeriod } from './periods.js';
import type { ChecklistProbeKey } from './types.js';

/** What a probe found. `entryIds` and `reversalDate` feed the row ("die Buchungen, das Rückbuchungsdatum"). */
export interface ProbeResult {
  readonly key: ChecklistProbeKey;
  /** `true`: a live, unreversed artefact for the period; `false`: none; `null`: could not look. */
  readonly found: boolean | null;
  readonly reason?: string;
  readonly entryIds: readonly string[];
  readonly reversalDate: string | null;
  readonly detail: Record<string, unknown>;
}

/**
 * The reason the A38-dependent probes and validations answered until that engine landed. Kept as a
 * named constant because the N1 tests and the Studio message catalogue name it; no probe answers
 * it any more (N4, 2026-09-10).
 */
export const NEEDS_A38 = 'needs_a38';

/** A fiscal-year label (`2026`), as opposed to a month or a MWST period label. */
const YEAR_LABEL = /^\d{4}$/;

/** Is a FILED period one with nothing on its tax accounts (A38's own model, a pure read)? */
function filedWithNothingToSettle(ctx: WorkspaceContext, label: string): boolean {
  const model = settlementModelOf(ctx, label);
  return model.ok && model.filed === true && model.nothingToSettle === true;
}

/** One row of the year run's settlement table. */
export interface SettlementPeriodRow {
  readonly label: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly filed: boolean;
  readonly settled: boolean;
  /** Filed, nothing booked on the tax accounts: settled by vacuity, no entry to show. */
  readonly nothingToSettle: boolean;
  readonly settlementId: string | null;
  readonly entryId: string | null;
  readonly netMinor: number | null;
}

function none(key: ChecklistProbeKey, detail: Record<string, unknown> = {}): ProbeResult {
  return { key, found: false, entryIds: [], reversalDate: null, detail };
}

function unavailable(key: ChecklistProbeKey, reason: string, detail: Record<string, unknown> = {}): ProbeResult {
  return { key, found: null, reason, entryIds: [], reversalDate: null, detail };
}

function fxRevaluationPosted(ctx: WorkspaceContext, period: ChecklistPeriod): ProbeResult {
  const key = 'fx_revaluation_posted';
  const run = ctx.store.db
    .prepare('SELECT id, entry_id, reversal_id, storno_entry_id, storno_reversal_id FROM fx_revaluation WHERE workspace_id = ? AND period_end = ?')
    .get(ctx.workspaceId, period.periodEnd) as
    | { id: string; entry_id: string | null; reversal_id: string | null; storno_entry_id: string | null; storno_reversal_id: string | null }
    | undefined;
  if (run === undefined || run.entry_id === null) return none(key, { periodEnd: period.periodEnd });
  const entry = ctx.store.db
    .prepare('SELECT status FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, run.entry_id) as { status: string } | undefined;
  if (entry === undefined || entry.status !== 'posted') return none(key, { runId: run.id, entryStatus: entry?.status ?? null });
  const reversalDate = run.reversal_id === null
    ? null
    : ((ctx.store.db.prepare('SELECT date FROM journal_entry WHERE id = ?').get(run.reversal_id) as { date: string } | undefined)?.date ?? null);
  // Gone means REVERTED THROUGH THE OWNER VERB: `fx_revaluation_reverse` (D129 Q2) books a mirror pair
  // and links it on the run row (`storno_entry_id` / `storno_reversal_id`). Every FX entry and its
  // mirrors are `owned_by` that verb (A38's reversal-ownership guard), so no other entry can ever
  // reverse the revaluation; reading the run row is therefore the whole truth, and the earlier
  // "an entry other than the scheduled one reversing it" query was dead by construction.
  if (run.storno_entry_id !== null) {
    const stornoIds = [run.storno_entry_id, ...(run.storno_reversal_id === null ? [] : [run.storno_reversal_id])];
    const entryIds = [run.entry_id, ...(run.reversal_id === null ? [] : [run.reversal_id]), ...stornoIds];
    return { key, found: false, entryIds, reversalDate, detail: { runId: run.id, reversedBy: stornoIds } };
  }
  const entryIds = run.reversal_id === null ? [run.entry_id] : [run.entry_id, run.reversal_id];
  return { key, found: true, entryIds, reversalDate, detail: { runId: run.id } };
}

function depreciationCharged(ctx: WorkspaceContext, period: ChecklistPeriod): ProbeResult {
  const key = 'depreciation_charged';
  const months = monthsBetween(period.periodStart, period.periodEnd);
  const posted = ctx.store.db
    .prepare(
      `SELECT id, period, journal_entry_id FROM asset_depreciation_run
        WHERE workspace_id = ? AND status = 'posted' AND period >= ? AND period <= ? ORDER BY period ASC`,
    )
    .all(ctx.workspaceId, months[0] ?? period.periodStart.slice(0, 7), months[months.length - 1] ?? period.periodEnd.slice(0, 7)) as {
    id: string;
    period: string;
    journal_entry_id: string | null;
  }[];
  const postedMonths = new Set(posted.map((r) => r.period));
  const missing: string[] = [];
  const nothingEligible: string[] = [];
  for (const month of months) {
    if (postedMonths.has(month)) continue;
    const preview = previewDepreciation(ctx, { period: month });
    if (!preview.ok) return unavailable(key, preview.error ?? 'asset_depreciation_preview refused');
    const results = Array.isArray(preview.results) ? (preview.results as { amountRappen: number }[]) : [];
    if (results.some((r) => r.amountRappen > 0)) missing.push(month);
    else nothingEligible.push(month);
  }
  const entryIds = posted.map((r) => r.journal_entry_id).filter((id): id is string => id !== null);
  const detail = { months, postedMonths: [...postedMonths], nothingEligible, missingMonths: missing, runIds: posted.map((r) => r.id) };
  if (missing.length > 0) return { key, found: false, entryIds, reversalDate: null, detail };
  // Every month is either posted or had nothing to charge. A period where NOTHING was ever
  // eligible has no artefact either: that is the paired preview's `excluded` case, not a posting.
  return { key, found: posted.length > 0, entryIds, reversalDate: null, detail };
}

// --- A38 (D129 leg 2) ----------------------------------------------------------------------------

interface AccrualProbeRow {
  id: string;
  status: string;
  entry_id: string | null;
  reversal_entry_id: string | null;
  reversal_date: string;
}

function accrualsPosted(ctx: WorkspaceContext, period: ChecklistPeriod): ProbeResult {
  const key = 'accruals_posted';
  const rows = ctx.store.db
    .prepare('SELECT id, status, entry_id, reversal_entry_id, reversal_date FROM accrual WHERE workspace_id = ? AND period_end = ? ORDER BY created_at ASC, id ASC')
    .all(ctx.workspaceId, period.periodEnd) as AccrualProbeRow[];
  const drafts = rows.filter((r) => r.status === 'draft').map((r) => r.id);
  const posted = rows.filter((r) => r.status === 'posted');
  const reversed = rows.filter((r) => r.status === 'reversed').map((r) => r.id);
  const entryIds = posted.flatMap((r) => [r.entry_id, r.reversal_entry_id]).filter((id): id is string => id !== null);
  const reversalDate = posted[0]?.reversal_date ?? null;
  const detail = { periodEnd: period.periodEnd, draftIds: drafts, postedIds: posted.map((r) => r.id), reversedIds: reversed };
  return { key, found: drafts.length === 0 && posted.length > 0, entryIds, reversalDate, detail };
}

interface ProvisionProbeRow {
  id: string;
  reason: string;
  status: string;
  entry_id: string | null;
}

function provisionsPosted(ctx: WorkspaceContext, period: ChecklistPeriod): ProbeResult {
  const key = 'provisions_posted';
  const rows = ctx.store.db
    .prepare("SELECT id, reason, status, entry_id FROM provision WHERE workspace_id = ? AND period_end = ? AND reason <> 'steuern' ORDER BY created_at ASC, id ASC")
    .all(ctx.workspaceId, period.periodEnd) as ProvisionProbeRow[];
  const drafts = rows.filter((r) => r.status === 'draft').map((r) => r.id);
  const posted = rows.filter((r) => r.status === 'posted' || r.status === 'released');
  // A release dated the period end counts as the period's act too (row 10b: "gebucht oder aufgelöst"),
  // whichever period the provision was formed in; a release that was itself reversed does not.
  const releases = ctx.store.db
    .prepare(
      `SELECT r.id, r.entry_id FROM provision_release r
        WHERE r.workspace_id = ? AND r.release_date = ?
          AND NOT EXISTS (SELECT 1 FROM journal_entry e WHERE e.workspace_id = r.workspace_id AND e.reverses_entry_id = r.entry_id AND e.status = 'posted')`,
    )
    .all(ctx.workspaceId, period.periodEnd) as { id: string; entry_id: string }[];
  const entryIds = [...posted.map((r) => r.entry_id).filter((id): id is string => id !== null), ...releases.map((r) => r.entry_id)];
  const detail = { periodEnd: period.periodEnd, draftIds: drafts, postedIds: posted.map((r) => r.id), releaseIds: releases.map((r) => r.id) };
  return { key, found: drafts.length === 0 && (posted.length > 0 || releases.length > 0), entryIds, reversalDate: null, detail };
}

function taxProvisionPosted(ctx: WorkspaceContext, period: ChecklistPeriod): ProbeResult {
  const key = 'tax_provision_posted';
  const rows = ctx.store.db
    .prepare("SELECT id, reason, status, entry_id FROM provision WHERE workspace_id = ? AND period_end = ? AND reason = 'steuern' ORDER BY created_at ASC, id ASC")
    .all(ctx.workspaceId, period.periodEnd) as ProvisionProbeRow[];
  const posted = rows.filter((r) => r.status === 'posted' || r.status === 'released');
  const drafts = rows.filter((r) => r.status === 'draft').map((r) => r.id);
  const entryIds = posted.map((r) => r.entry_id).filter((id): id is string => id !== null);
  return { key, found: posted.length > 0, entryIds, reversalDate: null, detail: { periodEnd: period.periodEnd, draftIds: drafts, postedIds: posted.map((r) => r.id) } };
}

interface SettlementRow {
  id: string;
  period_label: string;
  period_start: string;
  net_minor: number;
  entry_id: string;
}

function settlementsBetween(ctx: WorkspaceContext, from: string, to: string): SettlementRow[] {
  return ctx.store.db
    .prepare(
      `SELECT id, period_label, period_start, net_minor, entry_id FROM vat_settlement
        WHERE workspace_id = ? AND status = 'posted' AND period_start >= ? AND period_start <= ? ORDER BY period_start ASC`,
    )
    .all(ctx.workspaceId, from, to) as SettlementRow[];
}

function vatSettlementPosted(ctx: WorkspaceContext, period: ChecklistPeriod): ProbeResult {
  const key = 'vat_settlement_posted';
  if (!YEAR_LABEL.test(period.label)) {
    const row = settlementsBetween(ctx, period.periodStart, period.periodStart)[0];
    if (row === undefined) {
      if (filedWithNothingToSettle(ctx, period.label)) return { key, found: true, entryIds: [], reversalDate: null, detail: { period: period.label, nothingToSettle: true } };
      return none(key, { period: period.label });
    }
    return { key, found: true, entryIds: [row.entry_id], reversalDate: null, detail: { period: period.label, settlementId: row.id, netMinor: row.net_minor } };
  }
  // A year run: the MWST Steuerperiode is the CALENDAR year (MWSTG Art. 34 Abs. 2) whatever the
  // fiscal year, so the table lists the calendar year the fiscal year ends in.
  const year = period.periodEnd.slice(0, 4);
  const listed = listVatPeriods(ctx, { year });
  if (!listed.ok) return unavailable(key, listed.error ?? 'vat_periods refused', { year });
  const settled = new Map(settlementsBetween(ctx, `${year}-01-01`, `${year}-12-31`).map((s) => [s.period_start, s]));
  const periods: SettlementPeriodRow[] = (listed.periods as { label: string; periodStart: string; periodEnd: string; filed: boolean }[]).map((p) => {
    const s = settled.get(p.periodStart);
    const nothingToSettle = s === undefined && p.filed && filedWithNothingToSettle(ctx, p.label);
    return {
      label: p.label,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      filed: p.filed,
      settled: s !== undefined || nothingToSettle,
      nothingToSettle,
      settlementId: s?.id ?? null,
      entryId: s?.entry_id ?? null,
      netMinor: s?.net_minor ?? null,
    };
  });
  const filed = periods.filter((p) => p.filed);
  const unsettledFiled = filed.filter((p) => !p.settled).map((p) => p.label);
  const unfiled = periods.filter((p) => !p.filed).map((p) => p.label);
  const entryIds = periods.map((p) => p.entryId).filter((id): id is string => id !== null);
  const detail = { year, method: listed.method ?? null, periods, unsettledFiled, unfiled };
  // Found when every filed period is settled and at least one is; a year with nothing filed yet has
  // no artefact, and the row names the periods still waiting on their MWST-Periode run.
  return { key, found: filed.length > 0 && unsettledFiled.length === 0 && unfiled.length === 0, entryIds, reversalDate: null, detail };
}

/** Evaluate one probe. Never throws: an exception is an `unavailable` result carrying its message. */
export function evaluateProbe(ctx: WorkspaceContext, key: ChecklistProbeKey, period: ChecklistPeriod): ProbeResult {
  try {
    switch (key) {
      case 'fx_revaluation_posted':
        return fxRevaluationPosted(ctx, period);
      case 'depreciation_charged':
        return depreciationCharged(ctx, period);
      case 'accruals_posted':
        return accrualsPosted(ctx, period);
      case 'provisions_posted':
        return provisionsPosted(ctx, period);
      case 'tax_provision_posted':
        return taxProvisionPosted(ctx, period);
      case 'vat_settlement_posted':
        return vatSettlementPosted(ctx, period);
      case 'lock_on_month':
        return lockOnMonth(ctx, period) ? { key, found: true, entryIds: [], reversalDate: null, detail: { period: period.periodEnd.slice(0, 7) } } : none(key);
      case 'soft_lock_on_year':
        return lockOnYear(ctx, period) ? { key, found: true, entryIds: [], reversalDate: null, detail: {} } : none(key);
      case 'seal_on_year':
        return sealOnYear(ctx, period) ? { key, found: true, entryIds: [], reversalDate: null, detail: {} } : none(key);
    }
  } catch (e) {
    return unavailable(key, e instanceof Error ? e.message : String(e));
  }
}
