/**
 * I06's ten verbs: reads and not one write, the I05 / C03 forecast posture exactly.
 *
 * Every tool here is `kind: 'read'`, so every one carries `readOnlyHint` on MCP and none carries an
 * `idempotencyKey` (a read needs none). I06 owns no table and posts nothing: the ten verbs compute
 * procurement analytics (open commitments, match status, spend, supplier scorecard, requisition
 * pipeline, GR/IR clearing, landed-cost variance, PO cycle, anomalies, PO history) over the live
 * I00-I05 + D02 documents at query time (P5), and `test/procurement/i06-analytics.test.mjs` asserts
 * the module is structurally INCAPABLE of writing rather than merely polite about it.
 *
 * THE DESCRIPTIONS SAY WHAT THE FIGURES ARE: pure projections of the live PO / receipt / match / bill
 * documents, reproducible (same data, same result), never a second source of truth and never a GL
 * posting. An agent quotes a tool description with no human filter, so each says the figures are
 * DERIVED and every money value is integer CHF Rappen.
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX, A08, C03 and I05
 * established: the registry is the one append-only tool list and several agents append to it at once,
 * so the smaller the hunk the cheaper the merge. The helpers arrive as a parameter to keep the module
 * graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  procurementOpenCommitments,
  procurementMatchStatus,
  procurementSpendSummary,
  procurementSupplierScorecard,
  procurementRequisitionPipeline,
  procurementGrirClearing,
  procurementLandedCostVariance,
  procurementPoCycle,
  procurementAnomalies,
  procurementPoHistory,
} from '../core/procurement/index.js';

export interface ProcurementAnalyticsActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

const OBJ = { type: 'object' } as const;
const STR_ARRAY = { type: 'array', items: { type: 'string' } } as const;

/** The I06 verbs, in append order. */
export function procurementAnalyticsActions(h: ProcurementAnalyticsActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  return [
    ctxAction(
      'procurement_open_commitments',
      'read',
      `Offene Bestellverpflichtungen (open purchase commitments): every still-open PO line with its ordered, received and billed quantities and the residual commitment value (ordered minus billed, at the PO base price in integer CHF Rappen), plus aging-bucketed totals (0-30 / 31-60 / 61-90 / 90+ days). Cancelled POs contribute nothing and closed POs are omitted unless includeClosed. Pass group_by (supplier / item / aging) for a rollup, or leave it flat with cursor pagination (default 500, max 5000 rows). A DERIVED read: it computes over the live D02 po_line counters and posts nothing. Empty answers ok with zero totals. A supplier or item id from another workspace simply matches nothing (tenant isolation).`,
      ctxSchema({ filter: OBJ, group_by: STR, cursor: STR, limit: INT, format: STR }),
      (ctx, input) => procurementOpenCommitments(ctx, as(input)),
    ),
    ctxAction(
      'procurement_match_status',
      'read',
      `Status und Ausnahmen des Belegabgleichs (three-way match status & exceptions): the summary counts and matched value by status (matched / partial / overridden) plus one exception row per non-fully-matched I04 record, with its quantity and price variance in Rappen, whether tolerance was breached, the override reason, the aging since the match and a suggested next action (await_receipt / review_override / escalate). Status is clean when there is no exception in the filter, else exceptions_present. Reads the live I04 three_way_match active rows and posts nothing; never auto-fixes a match. Filter by status, supplier or match date; include_detail expands the per-line variances.`,
      ctxSchema({ status: STR_ARRAY, supplier_ids: STR_ARRAY, from_date: STR, to_date: STR, include_detail: BOOL, as_of: STR, format: STR }),
      (ctx, input) => procurementMatchStatus(ctx, as(input)),
    ),
    ctxAction(
      'procurement_spend_summary',
      'read',
      `Einkaufsauswertung (procurement spend summary): grouped spend over the PO lines whose order date falls in the window, by supplier, item, item category or order month. Each row carries the document count and the ordered, received and billed value (the po_line counters times the base price, integer CHF Rappen); an optional compare_prior_period adds the prior equal window's billed value and the delta. All figures are DERIVED from the live PO lines and reproducible; nothing is posted. Empty range answers ok with zero totals. (Buyer and cost-centre groupings are not available: a PO carries neither, per the I06 spec reconciliation).`,
      ctxSchema({ from_date: STR, to_date: STR, group_by: STR, filter: OBJ, compare_prior_period: BOOL, format: STR }),
      (ctx, input) => procurementSpendSummary(ctx, as(input)),
    ),
    ctxAction(
      'procurement_supplier_scorecard',
      'read',
      `Lieferanten-Scorecards (supplier scorecards) for a window: one row per supplier with the I05 overall score, on-time delivery %, average days late, price and quantity variance %, match-override and rejection rates, plus the live open commitment and in-period spend in Rappen. The metric math is DELEGATED to I05 (supplier_scorecard_get); this verb only adds the open commitment and spend and never writes or recalculates a score. Suppliers are the requested set, or every supplier with a PO in the window; those below min_activity are dropped and thin-data suppliers carry an insufficient_data warning. Posts nothing.`,
      ctxSchema({ supplier_ids: STR_ARRAY, from_date: STR, to_date: STR, include_trend: BOOL, min_activity: INT }),
      (ctx, input) => procurementSupplierScorecard(ctx, as(input)),
    ),
    ctxAction(
      'procurement_requisition_pipeline',
      'read',
      `Bestellanforderungs-Pipeline (requisition pipeline): the summary count and estimated value by status (draft / pending_approval / approved / partially_converted / converted / rejected / cancelled / closed), the open requisition rows with days-in-status, the linked PO and the conversion lag, and the conversion rate plus the average request-to-PO cycle over the window. Requisitions stalled beyond the workspace threshold are flagged. A DERIVED read over the live I00 requisition + conversion tables; posts nothing. Filter by status, requester or minimum aging.`,
      ctxSchema({ status: STR_ARRAY, requester_ids: STR_ARRAY, aging_days_min: INT, from_date: STR, to_date: STR }),
      (ctx, input) => procurementRequisitionPipeline(ctx, as(input)),
    ),
    ctxAction(
      'procurement_grir_clearing',
      'read',
      `GR/IR-Abgrenzung (goods-received / invoice-received clearing) as of a date: two complementary sets from the live po_line counters, received-not-invoiced (received_qty > billed_qty) and invoiced-not-received (billed_qty > received_qty), each with its residual quantity and residual value at the PO base price (integer CHF Rappen), plus the net exposure. Status is cleared when both sides are empty within the materiality filter, else exposure_present. A pure projection that quantifies accrual exposure before period close; it never posts the accrual itself (that stays the period-close process). include_detail returns the per-line rows.`,
      ctxSchema({ as_of: STR, supplier_ids: STR_ARRAY, materiality_rappen: INT, include_detail: BOOL }),
      (ctx, input) => procurementGrirClearing(ctx, as(input)),
    ),
    ctxAction(
      'procurement_landed_cost_variance',
      'read',
      `Landed-Cost-Abweichung (landed-cost variance): for each allocated I03 voucher in the window, the planned total cost against the capitalized and expensed (variance) split the confirm actually posted, with the freight / duty / insurance / other component breakdown and the variance percentage. Largest absolute variance first. All figures are integer CHF Rappen read from the live landed_cost_voucher / landed_cost_line; posts nothing. No I03 activity answers ok with an empty list.`,
      ctxSchema({ from_date: STR, to_date: STR, filter: OBJ, format: STR }),
      (ctx, input) => procurementLandedCostVariance(ctx, as(input)),
    ),
    ctxAction(
      'procurement_po_cycle',
      'read',
      `PO-Durchlaufzeiten (PO cycle-time metrics) over POs that reached a terminal state (received / closed) in the window: the average and the p50 / p90 days for order-to-first-receipt and order-to-full-match, overall or grouped by supplier. Only completed POs count; open POs are excluded from the averages. Measures the timestamps the engine records (there is no sent_at stage, per the I06 reconciliation). A DERIVED read over the live PO / receipt / match documents; posts nothing.`,
      ctxSchema({ from_date: STR, to_date: STR, group_by: STR }),
      (ctx, input) => procurementPoCycle(ctx, as(input)),
    ),
    ctxAction(
      'procurement_anomalies',
      'read',
      `Beschaffungs-Anomalien (procurement anomalies) since a date (default 30 days): a prioritised, DERIVED-not-stored list of unusual events with type, severity (info / warning / critical), a summary, the related PO / bill / supplier / requisition id, the detection date and a structured payload. Phase-1 types: large_price_variance, match_override_high_value, open_commitment_aging, stalled_requisition and grir_material_exposure. Thresholds are sensible defaults; this verb never writes them. Recomputed on every read, so the next read reflects the current state. Empty answers ok with an empty list. Filter by type or severity.`,
      ctxSchema({ since: STR, types: STR_ARRAY, severity: STR_ARRAY, limit: INT }),
      (ctx, input) => procurementAnomalies(ctx, as(input)),
    ),
    ctxAction(
      'procurement_po_history',
      'read',
      `Vollständige Bestellhistorie (complete PO history) for one po_id: an ordered timeline of creation, I01 revisions/amendments, posted I02 goods receipts, I03 landed-cost allocations and I04 three-way matches, each with its timestamp, actor, summary, amount / quantity and a deep-link ref. The running open quantity and open value are the live commitment (ordered minus billed) for the PO and reconcile to it exactly. A DERIVED read; posts nothing. A po_id from another workspace is not_found (tenant isolation); a just-created PO returns only its creation event.`,
      ctxSchema({ po_id: STR, from_date: STR, to_date: STR }, ['po_id']),
      (ctx, input) => procurementPoHistory(ctx, as(input)),
    ),
  ];
}
