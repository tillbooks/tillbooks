/**
 * A40's nine verbs (four writes, five reads), defined here and spread into `ACTIONS` as ONE line (the
 * `fxActions` / `pain001Actions` precedent), so several agents appending to the append-only registry
 * at once collide over a line rather than a block.
 *
 * THE DESCRIPTIONS SAY WHAT THE FIGURES ARE NOT, the C03 lesson: an agent quotes a tool description with
 * no human filter. The forecast is a projection over scheduled flows (Prognose, keine
 * Buchhaltungszahl), and a proposal is a proposal: nothing here posts, pays or transmits. The only
 * write that reaches another capability is `liquidity_plan_draft_batches`, and it reaches A18's
 * `createPaymentBatch`, which writes a DRAFT run and no journal row.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  liquidityForecast,
  setSkontoTerm,
  listSkontoTerms,
  setPlannedFlow,
  listPlannedFlows,
  proposePaymentPlan,
  getPaymentPlan,
  listPaymentPlans,
  draftPlanBatches,
  FORECAST_GRANULARITIES,
  PLANNED_FLOW_DIRECTIONS,
  PLANNED_FLOW_RECURRENCES,
  PAYMENT_PLAN_STATUSES,
  HORIZON_MIN_DAYS,
  HORIZON_MAX_DAYS,
  HORIZON_DEFAULT_DAYS,
  DELAY_QUANTILE_MIN,
  DELAY_QUANTILE_MAX,
  DELAY_QUANTILE_DEFAULT,
  LAG_MAX_DAYS,
  LAG_DEFAULT_DAYS,
  LATE_INTEREST_DEFAULT_BP,
  LATE_INTEREST_MAX_BP,
  SKONTO_MAX_BP,
  SKONTO_MAX_DAYS,
} from '../core/liquidity/index.js';
import type { ActionKind } from './actionKind.js';

export interface LiquidityActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
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

/** The A40 verbs, in append order. */
export function liquidityActions(h: LiquidityActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;
  const IDS = { type: 'array', items: STR };
  const flowParams = {
    currency: STR,
    horizonDays: INT,
    delayQuantile: INT,
    settlementLagDays: INT,
    bankAccountIds: IDS,
  };

  return [
    ctxAction(
      'liquidity_forecast',
      'read',
      `Die Liquiditätsvorschau (liquidity forecast): the bank balance day by day (granularity '${FORECAST_GRANULARITIES.join("' | '")}') over the next horizonDays (${HORIZON_MIN_DAYS}-${HORIZON_MAX_DAYS}, default ${HORIZON_DEFAULT_DAYS}) in ONE currency (default the base currency; never converted), from the flows the books already hold: the posted balance of the bank accounts, open invoices dated by due date plus each customer's observed payment delay (nearest-rank quantile delayQuantile ${DELAY_QUANTILE_MIN}-${DELAY_QUANTILE_MAX}, default ${DELAY_QUANTILE_DEFAULT}, conditional on how late the invoice already is), recurring-invoice occurrences, the MWST payable of started periods due within 60 days of period end, planned flows, live A18 payment runs, and every open bill on the last clearing day that still pays it on time (arrival settlementLagDays 0-${LAG_MAX_DAYS} clearing days after execution, default ${LAG_DEFAULT_DAYS}). Every flow names its source and assumption; anything not counted is listed in excluded with its reason; MWST no A07 return can compute (a refused return, today every period under vereinnahmte Entgelte, or output tax no return explains) follows a blunt conservative rule: the OUTPUT tax booked in that period, never less any Vorsteuer, due 60 days after the period end, capped by what the output-tax accounts still owe; each such debit is listed in conservative with its amount, day and reason. With planId the proposal's dates replace the bills' default dates and both balance series are returned. A projection over scheduled flows (Prognose, keine Buchhaltungszahl); writes nothing.`,
      ctxSchema({ ...flowParams, granularity: STR, planId: STR }),
      (ctx, input) => liquidityForecast(ctx, as(input)),
    ),
    ctxAction(
      'liquidity_skonto_set',
      'write:reversible:internal',
      `Skontobedingung erfassen (record a supplier's Skonto condition): EITHER vendorId with rateBp (0-${SKONTO_MAX_BP}, i.e. up to 10 %) and days (1-${SKONTO_MAX_DAYS}, the window counted from each bill's date), OR vendorBillId with rateBp and untilDate (the last day the payment may arrive). A bill override wins over the vendor default; rateBp 0 on a bill means "no Skonto on this bill". Replaces the existing condition for the same vendor or bill. Only what is recorded here is ever assumed: TILL never invents a Skonto. Posts nothing.`,
      ctxSchema(
        { vendorId: STR, vendorBillId: STR, rateBp: INT, days: INT, untilDate: STR, idempotencyKey: STR },
        ['rateBp', 'idempotencyKey'],
      ),
      (ctx, input) => setSkontoTerm(ctx, as(input)),
    ),
    ctxAction(
      'liquidity_skonto_list',
      'read',
      'The recorded Skonto conditions (vendor defaults and per-bill overrides), optionally narrowed to one vendor and the overrides on its bills.',
      ctxSchema({ vendorId: STR }),
      (ctx, input) => listSkontoTerms(ctx, as(input)),
    ),
    ctxAction(
      'liquidity_flow_set',
      'write:reversible:internal',
      `Geplanten Zahlungsfluss erfassen (record a planned flow such as rent or salaries) for the liquidity forecast: label, direction ('${PLANNED_FLOW_DIRECTIONS.join("' | '")}'), a positive amountMinor, currency, firstDate, recurrence ('${PLANNED_FLOW_RECURRENCES.join("' | '")}', anchored on firstDate, month-end clamped), optional endDate, optional bankAccountId (the account it moves, in its currency; without one a forecast solved on chosen accounts counts it there and says so). With flowId it replaces that flow; active:false retires it (never deleted). A forecast input only: posts nothing and pays nothing.`,
      ctxSchema(
        {
          flowId: STR,
          label: STR,
          direction: STR,
          amountMinor: INT,
          currency: STR,
          firstDate: STR,
          recurrence: STR,
          endDate: STR,
          active: BOOL,
          bankAccountId: STR,
          idempotencyKey: STR,
        },
        ['label', 'direction', 'amountMinor', 'currency', 'firstDate', 'recurrence', 'idempotencyKey'],
      ),
      (ctx, input) => setPlannedFlow(ctx, as(input)),
    ),
    ctxAction(
      'liquidity_flow_list',
      'read',
      'The planned flows (rent, salaries, loan instalments) the liquidity forecast adds to the booked ones; retired flows only with includeInactive.',
      ctxSchema({ includeInactive: BOOL }),
      (ctx, input) => listPlannedFlows(ctx, as(input)),
    ),
    ctxAction(
      'liquidity_plan_propose',
      'write:correctable:derived',
      `Zahlungsvorschlag berechnen (propose when to pay each open bill): over the liquidity forecast, choose for every open bill in the currency (not already in a live payment run) a clearing day or a deferral past the horizon that maximises Skonto captured minus default interest (OR 104: lateInterestBp, default ${LATE_INTEREST_DEFAULT_BP} = 5 % p.a., max ${LATE_INTEREST_MAX_BP}) while the projected balance never goes below floorMinor on any day. Without acceptLatePayments no bill is made late: when the scheduled flows plus every open bill paid on its on-time day take the balance under the floor inside the horizon AND no schedule without a late payment keeps it (a Skonto payment is earlier but smaller, so the search is asked first), the proposal STOPS with floor_breached_by_schedule {date, balanceMinor, shortfallMinor, suggestedFloorMinor, overdraws, noLateSearch}. suggestedFloorMinor is that on-time low (or 0 when a Skonto schedule keeps a floor of 0), so at it no bill is paid late; it is null (overdraws: true) when even a floor of 0 has no such schedule, and scheduleAloneOverdraws {date, balanceMinor} says when the scheduled flows alone go under 0 (no payment date fixes that); noLateSearch says whether that was proven ('proven') or only not found inside the search budget ('not_found'). Lower the floor, or propose again with acceptLatePayments: true: then a bill may be late for the floor or for a Skonto worth more, and no payment deepens a dip the scheduled flows cause alone (floorBreachedByBase says so). One exact search over each bill's admissible options (optimality 'proven': no schedule keeping the floor is worth more, or equally much with fewer days late); past its node budget the best schedule found is returned as 'heuristic' (not proven optimal) with upperBoundMinor and gapMinor, and its lateness likewise (daysLateTotal, lateDaysLowerBound, lateGapDays). Stores ONE proposal with its inputs, floor, objective and a reason per bill, and carries the forecast's conservative and excluded lines its floor proof leaned on; proposing again on unchanged books returns the SAME proposal (replayed:true) under any key. Pays nothing, posts nothing.`,
      ctxSchema({ ...flowParams, floorMinor: INT, lateInterestBp: INT, acceptLatePayments: BOOL, idempotencyKey: STR }, ['floorMinor', 'idempotencyKey']),
      (ctx, input) => proposePaymentPlan(ctx, as(input)),
    ),
    ctxAction(
      'liquidity_plan_get',
      'read',
      'One payment proposal with every line: the bill, the proposed execution and arrival dates, cash, Skonto, default interest, and the reason the bill got its date.',
      ctxSchema({ planId: STR }, ['planId']),
      (ctx, input) => getPaymentPlan(ctx, as(input)),
    ),
    ctxAction(
      'liquidity_plan_list',
      'read',
      `The payment proposals, newest first, without their lines; status filter '${PAYMENT_PLAN_STATUSES.join("' | '")}'.`,
      ctxSchema({ status: STR }),
      (ctx, input) => listPaymentPlans(ctx, as(input)),
    ),
    ctxAction(
      'liquidity_plan_draft_batches',
      'write:correctable:books',
      'Zahlungsläufe entwerfen (draft payment runs from a proposal): calls A18 create_payment_batch once per proposed execution date on bankAccountId (same currency as the proposal) and marks the proposal drafted. Refuses stale_plan when the books changed since the proposal (propose again). A line that captures a Skonto is NOT drafted (skonto_needs_reduced_amount: an A18 run pays the full open amount), nor is a bill A18 cannot pay yet (needs_creditor_iban, needs_qrr_reference, invalid_reference, unsupported_currency); each is returned in notDrafted with its reason. The runs are DRAFTS: generating the pain.001, transmitting and marking paid stay A18/A33 acts. Posts nothing.',
      ctxSchema({ planId: STR, bankAccountId: STR, idempotencyKey: STR }, ['planId', 'bankAccountId', 'idempotencyKey']),
      (ctx, input) => draftPlanBatches(ctx, as(input)),
    ),
  ];
}
