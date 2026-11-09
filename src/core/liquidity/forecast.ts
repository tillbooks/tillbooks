/**
 * A40, `liquidity_forecast` (US-A40.1): the day-by-day balance over the scheduled flows. A PURE READ
 * (Pattern P5): no table, no INSERT, recomputed on every call, so a booked payment changes the answer
 * on the next read with nothing to invalidate.
 *
 * Every open payable is placed on the last clearing day that still pays it on time (overdue: today).
 * With `planId` the proposal's own dates replace those for the bills it decided, and BOTH series are
 * returned, so a surface can draw the balance without and with the proposal on one chart.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { optionalId } from '../ledger/inputGuards.js';
import { addDays } from './calendar.js';
import { dailyBalances, gatherFlows, payableDefaultFlow, readFlowParams } from './flows.js';
import type { FlowEvent, FlowModel, FlowParamsInput } from './flows.js';

/** §H-ENUM: the two resolutions a forecast is answered in. */
export const FORECAST_GRANULARITIES = ['day', 'week'] as const;
export type ForecastGranularity = (typeof FORECAST_GRANULARITIES)[number];

export interface LiquidityForecastInput extends FlowParamsInput {
  granularity?: string;
  planId?: string;
}

/** The payable flows a proposal implies: its pay lines, dated by the plan; nothing for a defer. */
export function planFlows(
  ctx: WorkspaceContext,
  planId: string,
  model: FlowModel,
): { flows: FlowEvent[]; decided: Set<string> } | Result {
  const plan = ctx.store.db
    .prepare('SELECT id, currency FROM payment_plan WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, planId) as { id: string; currency: string } | undefined;
  if (plan === undefined) return err('not_found', { planId });
  if (plan.currency !== model.params.currency) {
    return err('currency_mismatch', { planCurrency: plan.currency, forecastCurrency: model.params.currency });
  }
  const lines = ctx.store.db
    .prepare(
      `SELECT vendor_bill_id AS billId, action, pay_date AS payDate, cash_minor AS cash
         FROM payment_plan_line WHERE workspace_id = ? AND plan_id = ? ORDER BY vendor_bill_id`,
    )
    .all(ctx.workspaceId, planId) as { billId: string; action: string; payDate: string | null; cash: number }[];
  const open = new Map(model.payables.map((p) => [p.billId, p] as const));
  const flows: FlowEvent[] = [];
  const decided = new Set<string>();
  for (const l of lines) {
    const p = open.get(l.billId);
    if (p === undefined) continue; // settled or batched since: the model already carries the truth
    // A deferred line whose bill is not due in the horizon keeps the default placement (none in it).
    if (l.action !== 'pay' || l.payDate === null) {
      decided.add(l.billId);
      continue;
    }
    if (l.payDate < model.asOf || l.payDate > model.horizonEnd) continue;
    decided.add(l.billId);
    flows.push({ date: l.payDate, amountMinor: -l.cash, kind: 'payable', ref: l.billId, label: p.vendorName, provenance: `plan_${planId}` });
  }
  return { flows, decided };
}

/**
 * The assumptions that can break the floor in reality, counted and summed so a person can judge them
 * (critic M9). Every figure is a sum of flows the forecast already carries; nothing new is estimated.
 */
function assumptionSummary(model: FlowModel, flows: readonly FlowEvent[]) {
  const tally = (pick: (f: FlowEvent) => boolean) => {
    const hit = flows.filter(pick);
    return { count: hit.length, amountMinor: hit.reduce((s, f) => s + f.amountMinor, 0) };
  };
  return {
    /** Inflows from customers with fewer than three settled invoices, and none in the pool: assumed paid ON the due date. */
    noHistory: tally((f) => f.provenance.includes('delay_no_history')),
    /** Inflows dated by the whole workspace's payment habit, not the customer's own. */
    pooledHistory: tally((f) => f.provenance.includes('delay_pooled')),
    /** The opening balance is the posted LEDGER balance of these accounts, not the bank's statement. */
    openingSource: 'ledger' as const,
    accountCount: model.accounts.length,
    /** MWST outflows that carry only posted and scheduled tax (the rest of a running period is unknown). */
    vatPartial: tally((f) => f.kind === 'vat' && f.provenance.includes('scheduled')),
    /** Open bills are placed on the LAST clearing day that still arrives on time. */
    lastPossibleDay: true as const,
    /**
     * Flows whose account the books cannot know, counted on the chosen account(s) (critic R2-M2): with
     * a count above zero the floor does NOT hold for these accounts alone, and the Studio says so.
     */
    accountUnknown: (() => {
      const hit = flows.filter((f) => f.provenance.includes('account_unknown'));
      return {
        count: hit.length,
        inMinor: hit.filter((f) => f.amountMinor > 0).reduce((s, f) => s + f.amountMinor, 0),
        outMinor: hit.filter((f) => f.amountMinor < 0).reduce((s, f) => s - f.amountMinor, 0),
        kinds: [...new Set(hit.map((f) => f.kind))].sort(),
      };
    })(),
  };
}

/** Monday of the ISO week containing `date`. */
function weekStart(date: string): string {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/** US-A40.1. */
export function liquidityForecast(ctx: WorkspaceContext, input: LiquidityForecastInput = {}): Result {
  const guard = optionalId(input.planId, 'planId');
  if (guard) return guard;
  const granularity = input.granularity ?? 'day';
  if (!(FORECAST_GRANULARITIES as readonly string[]).includes(granularity)) {
    return err('invalid_input', { field: 'granularity', allowed: [...FORECAST_GRANULARITIES] });
  }
  const params = readFlowParams(ctx, input);
  if ('ok' in params) return params;
  const model = gatherFlows(ctx, params);
  if ('ok' in model) return model;

  const defaults: FlowEvent[] = [];
  for (const p of model.payables) {
    const f = payableDefaultFlow(model, p);
    if (f !== null) defaults.push(f);
  }
  const baseline = [...model.fixedFlows, ...defaults];
  const base = dailyBalances(model.dates, model.openingBalanceMinor, baseline);

  let withPlan: ReturnType<typeof dailyBalances> | null = null;
  let planned: FlowEvent[] | null = null;
  if (input.planId !== undefined) {
    const pf = planFlows(ctx, input.planId, model);
    if ('ok' in pf) return pf;
    planned = [...model.fixedFlows, ...defaults.filter((f) => !pf.decided.has(f.ref as string)), ...pf.flows];
    withPlan = dailyBalances(model.dates, model.openingBalanceMinor, planned);
  }

  const lowest = (series: number[]): { date: string; balanceMinor: number } => {
    let at = 0;
    for (let i = 1; i < series.length; i += 1) if ((series[i] as number) < (series[at] as number)) at = i;
    return { date: model.dates[at] as string, balanceMinor: series[at] as number };
  };

  const days = model.dates.map((date, i) => ({
    date,
    inMinor: base.inMinor[i] as number,
    outMinor: base.outMinor[i] as number,
    balanceMinor: base.balance[i] as number,
    ...(withPlan !== null
      ? {
          balanceWithPlanMinor: withPlan.balance[i] as number,
          inWithPlanMinor: withPlan.inMinor[i] as number,
          outWithPlanMinor: withPlan.outMinor[i] as number,
        }
      : {}),
  }));

  let weeks: unknown[] | undefined;
  if (granularity === 'week') {
    const byWeek = new Map<string, { weekStart: string; inMinor: number; outMinor: number; endBalanceMinor: number; minBalanceMinor: number; endBalanceWithPlanMinor?: number; minBalanceWithPlanMinor?: number }>();
    for (const d of days) {
      const key = weekStart(d.date);
      const w = byWeek.get(key) ?? {
        weekStart: key,
        inMinor: 0,
        outMinor: 0,
        endBalanceMinor: d.balanceMinor,
        minBalanceMinor: d.balanceMinor,
      };
      w.inMinor += d.inMinor;
      w.outMinor += d.outMinor;
      w.endBalanceMinor = d.balanceMinor;
      w.minBalanceMinor = Math.min(w.minBalanceMinor, d.balanceMinor);
      if (d.balanceWithPlanMinor !== undefined) {
        w.endBalanceWithPlanMinor = d.balanceWithPlanMinor;
        w.minBalanceWithPlanMinor = Math.min(w.minBalanceWithPlanMinor ?? d.balanceWithPlanMinor, d.balanceWithPlanMinor);
      }
      byWeek.set(key, w);
    }
    weeks = [...byWeek.values()];
  }

  return ok({
    asOf: model.asOf,
    horizonEnd: model.horizonEnd,
    currency: model.params.currency,
    granularity,
    openingBalanceMinor: model.openingBalanceMinor,
    accounts: model.accounts,
    ...(granularity === 'day' ? { days } : { weeks }),
    flows: (planned ?? baseline).slice().sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)),
    lowest: lowest(base.balance),
    lowestWithPlan: withPlan === null ? null : lowest(withPlan.balance),
    excluded: model.excluded,
    /** Debited conservatively, each with its reason (owner decision 01.10.2026, critic R4-M1). */
    conservative: model.conservative,
    assumptions: {
      horizonDays: model.params.horizonDays,
      delayQuantile: model.params.delayQuantile,
      settlementLagDays: model.params.settlementLagDays,
      bankAccountIds: model.params.bankAccountIds,
      ...assumptionSummary(model, planned ?? baseline),
    },
    planId: input.planId ?? null,
  });
}
