/**
 * C03's four verbs: reads and not one write, the A08 posture exactly.
 *
 * Every tool here is `kind: 'read'`, so every one carries `readOnlyHint` on MCP and none carries an
 * `idempotencyKey` (a read needs none). C03 owns no table and posts nothing: the four verbs compute
 * a management forecast over C01 deals, C02 quotes and the A08 statements at query time (P5), and
 * `test/forecast/forecast-c03.test.mjs` asserts the module is structurally INCAPABLE of writing
 * rather than merely polite about it.
 *
 * THE DESCRIPTIONS SAY WHAT THE FIGURES ARE NOT, the A08 lesson: an agent quotes a tool description
 * with no human filter, and a forecast repeated as an accounting figure is a defect with a person
 * attached. Every description below says "Prognose, keine Buchhaltungszahl" in substance: only
 * `forecast_vs_actual`'s actual column is posted A08 revenue; everything else is a projection.
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX, A08 and C01 established:
 * the registry is the one append-only tool list and several agents append to it at once, so the
 * smaller the hunk the cheaper the merge. The helpers arrive as a parameter to keep the module
 * graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  weightedPipeline,
  salesKpis,
  revenue,
  vsActual,
  FORECAST_GROUP_BY,
  HORIZON_MIN,
  HORIZON_MAX,
} from '../core/forecast/index.js';

export interface ForecastActionHelpers {
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

/** The C03 verbs, in append order. */
export function forecastActions(h: ForecastActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;

  return [
    ctxAction(
      'forecast_weighted_pipeline',
      'read',
      `Die gewichtete Pipeline (weighted pipeline): every OPEN deal contributes round-once(valueBaseMinor times probability over 100), C01's own formula, grouped by '${FORECAST_GROUP_BY.join("' | '")}' of expectedCloseOn or by any confirmed select/multiselect custom-field key on deal (rows re-bucket, totals never move: totalWeightedMinor is identical for every valid groupBy). Sums are integer Rappen over the stored CHF base (never re-converted); deals without a close date bucket under 'none', never dropped. An empty pipeline answers rows:[] and zero totals, not an error. This is a PROJECTION over estimates (Prognose, keine Buchhaltungszahl), not an accounting figure: revenue exists when A11 issues an invoice.`,
      ctxSchema({ pipelineId: STR, groupBy: STR, horizonMonths: INT }),
      (ctx, input) => weightedPipeline(ctx, as(input)),
    ),
    ctxAction(
      'forecast_sales_kpis',
      'read',
      `Verkaufskennzahlen (sales KPIs) over deals CLOSED in the from/to window: conversionRateBp = won over (won plus lost) in integer basis points, avgDealSizeMinor = round-once mean of won base values, avgCycleDays = whole-day mean from deal creation to the OP5 won-timestamp. Zero closed deals answers null KPIs with sample:0, never a fake 0 percent an agent could misread. Management figures over pipeline estimates, not accounting figures.`,
      ctxSchema({ pipelineId: STR, from: STR, to: STR }, ['from', 'to']),
      (ctx, input) => salesKpis(ctx, as(input)),
    ),
    ctxAction(
      'forecast_revenue',
      'read',
      `Die Umsatzprognose (revenue forecast) per month over a ${HORIZON_MIN}-${HORIZON_MAX} month horizon, three labelled components with each expected Rappen in exactly ONE: weightedOpenMinor (open deals, probability-weighted, overdue or dateless closes in the first period), wonUninvoicedMinor (won deals with no A11 invoice reachable over the document source chain, at 100 percent), and openQuotesMinor (sent, unexpired C02 quotes with NO deal on either link side, at 100 percent of their base-currency total; a deal-linked quote is represented by its deal, so nothing double-counts). A foreign-currency quote has no stored CHF base and lands in excluded[] with needs_fx_rate instead of a silently wrong total. A projection (Prognose, keine Buchhaltungszahl): nothing here is posted revenue.`,
      ctxSchema({ horizonMonths: INT }, ['horizonMonths']),
      (ctx, input) => revenue(ctx, as(input)),
    ),
    ctxAction(
      'forecast_vs_actual',
      'read',
      `Prognose vs. Ist (forecast vs actual) for one period (YYYY, YYYY-MM or YYYY-Qn): actualRevenueMinor is the A08 Erfolgsrechnung's Nettoerlöse subtotal (POSTED revenue, net of VAT, the only accounting figure in this capability) against wonInPeriodMinor (won-deal base value with the OP5 close date in the period), with the delta and the two named gap buckets: wonNotInvoicedMinor (revenue still to come) and invoicedWithoutDealMinor (posted invoices whose source chain reaches no deal, at their net subtotal). A period with neither answers zeros with sample:0. Stores no snapshot (P5): scheduled history belongs to F01.`,
      ctxSchema({ period: STR }, ['period']),
      (ctx, input) => vsActual(ctx, as(input)),
    ),
  ];
}
