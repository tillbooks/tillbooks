/**
 * I05's five verbs: reads and not one write, the C03 forecast posture exactly.
 *
 * Every tool here is `kind: 'read'`, so every one carries `readOnlyHint` on MCP and none carries an
 * `idempotencyKey` (a read needs none). I05 owns no table and posts nothing: the five verbs compute a
 * supplier scorecard, ranking, trend, explanation and alerts over the live I02 receipts and the D02
 * `po_match` trail at query time (P5), and `test/procurement/supplier-performance.test.mjs` asserts
 * the module is structurally INCAPABLE of writing rather than merely polite about it.
 *
 * THE DESCRIPTIONS SAY WHAT THE FIGURES ARE: derived scores, reproducible from the underlying POs,
 * receipts and matches, never a second source of truth and never a GL posting. An agent quotes a
 * tool description with no human filter, so each says the score is DERIVED and the source documents
 * are auditable via `supplier_performance_explain`.
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX, A08 and C03 established: the
 * registry is the one append-only tool list and several agents append to it at once, so the smaller
 * the hunk the cheaper the merge. The helpers arrive as a parameter to keep the module graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  supplierScorecardGet,
  supplierPerformanceRank,
  supplierPerformanceTrend,
  supplierPerformanceExplain,
  supplierPerformanceAlerts,
} from '../core/procurement/index.js';

export interface SupplierPerformanceActionHelpers {
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
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The `config_override` object schema: an untyped record the engine merges onto the default config. */
const CONFIG_OVERRIDE = { type: 'object' } as const;

/** The I05 verbs, in append order. */
export function supplierPerformanceActions(h: SupplierPerformanceActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;

  return [
    ctxAction(
      'supplier_scorecard_get',
      'read',
      `Die Lieferanten-Scorecard (supplier scorecard) for one supplier and window: OTIF, on-time %, quantity fill %, average delivery delay, quantity variance %, price variance %, match-override rate, inspection-rejection rate and a weight-normalised overall score 0-100, each with a green/amber/red light, plus the previous-window comparison and the top contributing exceptions (late deliveries, short shipments, price overrides) with deep-link PO / receipt / match ids. Every number is DERIVED from the live I02 goods receipts and the D02 three-way-match rows and is reproducible (same data, same result); nothing is posted. Empty period answers ok with empty:true, never an error. A supplier id from another workspace is not_found (tenant isolation). Pass configOverride for a what-if with different weights or tolerances.`,
      ctxSchema({ supplierId: STR, from: STR, to: STR, windowDays: INT, configOverride: CONFIG_OVERRIDE }, ['supplierId']),
      (ctx, input) => supplierScorecardGet(ctx, as(input)),
    ),
    ctxAction(
      'supplier_performance_rank',
      'read',
      `Rangliste der Lieferanten (supplier ranking) by one metric over a window (default the overall score): each row carries the supplier, the metric value, the overall score, the activity count and the delta versus the previous window. Suppliers below minActivity receipts are moved to a separate insufficient[] list rather than ranked on thin data. Ordering is stable (ties break by supplier name then id) and defaults to best-first for the chosen metric. Pure derivation over live receipts and matches; posts nothing.`,
      ctxSchema(
        { metric: STR, from: STR, to: STR, windowDays: INT, minActivity: INT, limit: INT, order: STR, configOverride: CONFIG_OVERRIDE },
      ),
      (ctx, input) => supplierPerformanceRank(ctx, as(input)),
    ),
    ctxAction(
      'supplier_performance_trend',
      'read',
      `Der Trend einer Kennzahl (metric trend) for one supplier over the last N consecutive windows, oldest first: each point is a pure re-evaluation of the chosen metric for that window, and a window with no activity reports value null (a genuine gap), never a fabricated zero. Use it for the scorecard sparkline or to see whether delivery reliability is improving. Derived, not stored.`,
      ctxSchema({ supplierId: STR, metric: STR, periods: INT, windowDays: INT, to: STR, configOverride: CONFIG_OVERRIDE }, ['supplierId', 'metric']),
      (ctx, input) => supplierPerformanceTrend(ctx, as(input)),
    ),
    ctxAction(
      'supplier_performance_explain',
      'read',
      `Die Herleitung einer Kennzahl (metric explanation, US-I05.3): the exact formula applied, the workspace tolerance / weight values used, and the full list of contributing source documents (goods-receipt ids and po-line ids for the delivery metrics, po_match ids for price and override) with their per-row values. This is the audit view a Treuhänder reads to reconstruct any number on the scorecard down to the Beleg. Re-running it with the same live data yields the identical result.`,
      ctxSchema({ supplierId: STR, metric: STR, from: STR, to: STR, windowDays: INT, configOverride: CONFIG_OVERRIDE }, ['supplierId', 'metric']),
      (ctx, input) => supplierPerformanceExplain(ctx, as(input)),
    ),
    ctxAction(
      'supplier_performance_alerts',
      'read',
      `Offene Leistungs-Warnungen (performance alerts, US-I05.5): for every supplier active in the window, each configured alert threshold a metric currently breaches (by default overall score below 70 or OTIF below 85) becomes an open alert with the supplier, metric, current value, threshold and period. Alerts are DERIVED and recomputed on every read, not stored as tickets. Pass onlyOpen:false to also see the metrics that were evaluated and did not breach. Posts nothing.`,
      ctxSchema({ asOf: STR, windowDays: INT, onlyOpen: { type: 'boolean' }, configOverride: CONFIG_OVERRIDE }),
      (ctx, input) => supplierPerformanceAlerts(ctx, as(input)),
    ),
  ];
}
