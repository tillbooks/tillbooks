/**
 * A40, the payment-timing proposal (US-A40.4, US-A40.5): propose, read, list, and turn into A18 DRAFT
 * payment runs.
 *
 * A PROPOSAL IS A DATED RECORD, never an instruction. It stores the parameters, the canonical inputs
 * it was solved on, the floor, the objective, the proof status, and one line per open payable with its
 * date, its cash, its Skonto, its default interest and the reason (spec §4.4). Its economics are frozen
 * by trigger (`schema.ts`); the only thing that ever fills in is the draft record.
 *
 * IDEMPOTENT ON ROWS. `payment_plan` is UNIQUE on `(workspace_id, inputs_hash)`: proposing again on
 * unchanged books returns the stored proposal (`replayed:true`) under ANY key and inserts nothing.
 *
 * NOTHING HERE POSTS OR PAYS. The draft step calls A18's `createPaymentBatch`, which writes a `draft`
 * batch and no journal row; generating the pain.001, transmitting it and marking it paid stay A18's and
 * A33's own verbs (the latter two `pay`-governed by the dial). A line that captures a Skonto is NOT
 * drafted (`skonto_needs_reduced_amount`, D-A40.6): A18 pays a bill's full open amount, so drafting it
 * would pay the Skonto the plan says it saves.
 *
 * §H-TENANT on every statement.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';
import { createPaymentBatch, liveBatchOfBill } from '../banking/pain001.js';
import { classifyReference } from '../payments/reference.js';
import { getBankAccount } from '../banking/bankAccounts.js';
import { canonicalInputs, dailyBalances, gatherFlows, payableDefaultFlow, readFlowParams, readOpenPayables } from './flows.js';
import type { ConservativeLine, ExcludedFlow, FlowEvent, FlowModel, FlowParams, FlowParamsInput, OpenPayable } from './flows.js';
import { NoAdmissibleScheduleError, optimisePaymentPlan } from './optimise.js';
import type { DecisionBill, Optimality, PlanReason } from './optimise.js';

/** §H-ENUM: a proposal's lifecycle. */
export const PAYMENT_PLAN_STATUSES = ['proposed', 'drafted'] as const;
export type PaymentPlanStatus = (typeof PAYMENT_PLAN_STATUSES)[number];

/** §H-ENUM: every reason a line can carry: the optimiser's six plus the bill outside the horizon. */
export const PLAN_LINE_REASONS = [
  'skonto_captured',
  'on_time_latest',
  'skonto_forgone_floor',
  'skonto_forgone_search_limit',
  'late_floor',
  'already_overdue',
  'deferred_floor',
  'not_due_in_horizon',
  'skonto_remainder',
] as const;
export type PlanLineReason = PlanReason | 'not_due_in_horizon' | 'skonto_remainder';

/** §H-ENUM: why a line was not drafted into an A18 run. */
export const NOT_DRAFTED_REASONS = [
  'skonto_needs_reduced_amount',
  'needs_creditor_iban',
  'needs_qrr_reference',
  'invalid_reference',
  'unsupported_currency',
  'already_batched',
  'no_longer_open',
] as const;

/** OR 104 Abs. 1: 5 % per year. Abs. 3 lets merchants claim a higher usual bank rate, so it is an input. */
export const LATE_INTEREST_DEFAULT_BP = 500;
export const LATE_INTEREST_MAX_BP = 2000;
/** The floor is a balance in minor units; an overdraft limit may make it negative, within reason. */
const FLOOR_BOUND = 1_000_000_000_000;

interface PlanRow {
  id: string;
  status: PaymentPlanStatus;
  as_of: string;
  horizon_end: string;
  currency: string;
  floor_minor: number;
  params_json: string;
  inputs_hash: string;
  inputs_json: string;
  objective_minor: number;
  skonto_captured_minor: number;
  late_interest_minor: number;
  optimality: Optimality;
  upper_bound_minor: number;
  late_days_lower_bound: number;
  nodes_explored: number;
  min_balance_minor: number;
  min_balance_date: string;
  base_breach_json: string | null;
  idempotency_key: string;
  created_by: string | null;
  created_at: string;
  drafted_at: string | null;
  drafted_by: string | null;
  draft_key: string | null;
  draft_result_json: string | null;
}

interface LineRow {
  id: string;
  vendor_bill_id: string;
  vendor_id: string | null;
  action: 'pay' | 'defer';
  option_kind: string;
  pay_date: string | null;
  arrival_date: string | null;
  open_minor: number;
  cash_minor: number;
  skonto_minor: number;
  interest_minor: number;
  days_late: number;
  reason: PlanLineReason;
  reason_json: string;
  batch_id: string | null;
  vendor_name: string | null;
  vendor_reference: string | null;
}

function readPlan(ctx: WorkspaceContext, planId: string): PlanRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM payment_plan WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, planId) as PlanRow | undefined;
}

/**
 * What the proposal's floor proof leaned on, read back from its frozen inputs (critic R4-M1): the
 * amounts debited conservatively and the flows not counted, each with its reason, so the plan itself
 * (MCP, REST and Studio alike) carries them and not only the forecast.
 */
function provisosOf(row: PlanRow): { conservative: ConservativeLine[]; excluded: ExcludedFlow[] } {
  let parsed: { conservative?: ConservativeLine[]; excluded?: ExcludedFlow[] } = {};
  try {
    parsed = JSON.parse(row.inputs_json) as typeof parsed;
  } catch {
    parsed = {};
  }
  return { conservative: parsed.conservative ?? [], excluded: parsed.excluded ?? [] };
}

function summaryView(row: PlanRow) {
  return {
    ...provisosOf(row),
    id: row.id,
    status: row.status,
    asOf: row.as_of,
    horizonEnd: row.horizon_end,
    currency: row.currency,
    floorMinor: row.floor_minor,
    params: JSON.parse(row.params_json) as Record<string, unknown>,
    inputsHash: row.inputs_hash,
    objectiveMinor: row.objective_minor,
    skontoCapturedMinor: row.skonto_captured_minor,
    lateInterestMinor: row.late_interest_minor,
    optimality: row.optimality,
    upperBoundMinor: row.upper_bound_minor,
    gapMinor: row.upper_bound_minor - row.objective_minor,
    lateDaysLowerBound: row.late_days_lower_bound,
    nodesExplored: row.nodes_explored,
    minBalanceMinor: row.min_balance_minor,
    minBalanceDate: row.min_balance_date,
    floorBreachedByBase: row.base_breach_json === null ? null : (JSON.parse(row.base_breach_json) as unknown),
    createdBy: row.created_by,
    createdAt: row.created_at,
    draftedAt: row.drafted_at,
    draftedBy: row.drafted_by,
    draft: row.draft_result_json === null ? null : (JSON.parse(row.draft_result_json) as unknown),
  };
}

/** The full proposal: the summary and every line with its reason. */
export function planView(ctx: WorkspaceContext, row: PlanRow) {
  const lines = ctx.store.db
    .prepare(
      `SELECT l.*, c.name AS vendor_name, b.vendor_reference AS vendor_reference
         FROM payment_plan_line l
         LEFT JOIN vendor_bill b ON b.workspace_id = l.workspace_id AND b.id = l.vendor_bill_id
         LEFT JOIN contact c ON c.workspace_id = l.workspace_id AND c.id = l.vendor_id
        WHERE l.workspace_id = ? AND l.plan_id = ?
        ORDER BY COALESCE(l.pay_date, '9999-12-31'), l.vendor_bill_id`,
    )
    .all(ctx.workspaceId, row.id) as LineRow[];
  const daysLateTotal = lines.reduce((s, l) => s + l.days_late, 0);
  return {
    ...summaryView(row),
    // Lateness states its gap like worth does (critic R2-L4): zero on a proven plan.
    daysLateTotal,
    lateGapDays: daysLateTotal - row.late_days_lower_bound,
    lines: lines.map((l) => ({
      vendorBillId: l.vendor_bill_id,
      vendorId: l.vendor_id,
      vendorName: l.vendor_name,
      vendorReference: l.vendor_reference,
      action: l.action,
      option: l.option_kind,
      payDate: l.pay_date,
      arrivalDate: l.arrival_date,
      openMinor: l.open_minor,
      cashMinor: l.cash_minor,
      skontoMinor: l.skonto_minor,
      interestMinor: l.interest_minor,
      daysLate: l.days_late,
      reason: l.reason,
      detail: JSON.parse(l.reason_json) as Record<string, unknown>,
      batchId: l.batch_id,
    })),
  };
}

export interface ProposePaymentPlanInput extends FlowParamsInput {
  floorMinor: number;
  lateInterestBp?: number;
  /**
   * The owner decision of 30.09.2026 (critic M8): when the scheduled flows alone take the balance under
   * the floor inside the horizon, the proposal STOPS (`floor_breached_by_schedule`) and the person
   * chooses: lower the floor, or say explicitly that the late payments are accepted (this flag).
   */
  acceptLatePayments?: boolean;
  idempotencyKey: string;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/.test(e.message);
}

/** The per-call inputs beyond the flow parameters that change the answer. */
function extraInputs(floorMinor: number, lateInterestBp: number, acceptLatePayments: boolean): Record<string, unknown> {
  return { floorMinor, lateInterestBp, acceptLatePayments };
}

/** Solve and persist (US-A40.4). */
export function proposePaymentPlan(ctx: WorkspaceContext, input: ProposePaymentPlanInput): Result {
  const guard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!Number.isSafeInteger(input.floorMinor) || Math.abs(input.floorMinor) > FLOOR_BOUND) {
    return err('invalid_input', { field: 'floorMinor' });
  }
  const lateInterestBp = input.lateInterestBp ?? LATE_INTEREST_DEFAULT_BP;
  if (!Number.isSafeInteger(lateInterestBp) || lateInterestBp < 0 || lateInterestBp > LATE_INTEREST_MAX_BP) {
    return err('invalid_input', { field: 'lateInterestBp', min: 0, max: LATE_INTEREST_MAX_BP });
  }
  if (input.acceptLatePayments !== undefined && typeof input.acceptLatePayments !== 'boolean') {
    return err('invalid_input', { field: 'acceptLatePayments' });
  }
  const params = readFlowParams(ctx, input);
  if ('ok' in params) return params;

  const scopedKey = JSON.stringify(['liquidity_plan_propose', input.idempotencyKey]);
  const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'liquidity_plan_propose');
  if (replay !== undefined) {
    // The key answers the SAME plan, but as it stands now (critic L7): a plan drafted since the first
    // call replays as drafted, never as the `proposed` snapshot the memo holds. Same rows, current view.
    const planId = replay.ok ? (replay as { planId?: unknown }).planId : undefined;
    const current = typeof planId === 'string' ? readPlan(ctx, planId) : undefined;
    return current === undefined ? replay : ok({ ...replay, plan: planView(ctx, current) });
  }

  const model = gatherFlows(ctx, params);
  if ('ok' in model) return model;
  // THE OWNER DECISION (30.09.2026, critic M8): scheduled flows that already breach the floor are not
  // silently answered with "pay nothing before that day". The proposal stops and names the day, the
  // shortfall and the highest floor the schedule keeps; the person lowers the floor or accepts the
  // late payments explicitly (`acceptLatePayments`), and only then is the strict schedule proposed.
  //
  // THE MEASURE IS THE ON-TIME SCHEDULE (critic R2-H1): the scheduled flows PLUS every open bill paid on
  // its on-time day (an overdue one on the first clearing day), which is the forecast's own baseline and
  // its `lowest`. When that baseline keeps the floor, the plan below pays every bill with an on-time day
  // on time or with its Skonto, never later (the optimiser's no-consent mode); when it does not, the
  // proposal stops. `suggestedFloorMinor` is that baseline's low: at that floor every bill IS paid on
  // time, which is exactly what "Mindestbestand senken" promises. A low under zero means even an empty
  // floor overdraws the account, so there is no floor to suggest (`suggestedFloorMinor: null`) and the
  // only way on is to accept the late payments.
  //
  // BUT THE ON-TIME SCHEDULE PAYS IN FULL (critic R4-L1): a Skonto payment is earlier and SMALLER, so it
  // can keep a floor the on-time schedule breaks. Before refusing, the no-consent search itself is asked;
  // only when it finds no schedule (proven, or not found inside its budget, said which) does the proposal
  // stop, and "only late payments help" is said only when even a floor of 0 has no such schedule.
  const acceptLate = input.acceptLatePayments === true;
  const base = dailyBalances(model.dates, model.openingBalanceMinor, model.fixedFlows);
  const bills: DecisionBill[] = model.payables.map((p) => ({
    id: p.billId,
    openMinor: p.openMinor,
    dueDate: p.dueDate,
    skontoRateBp: p.skonto.rateBp,
    skontoUntil: p.skonto.untilDate,
  }));
  const solve = (floorMinor: number, allowLate: boolean) =>
    optimisePaymentPlan({
      dates: model.dates,
      baseBalance: base.balance,
      floorMinor,
      bills,
      lagDays: params.settlementLagDays,
      lateInterestBp,
      allowLate,
    });
  /**
   * The no-consent search at `floorMinor`: its answer, or how it failed. An answer counts only when its
   * balance stays at or above the floor on EVERY day: the optimiser lets the scheduled flows alone dip
   * under the floor (it only forbids payments that deepen the dip), and such a dip is the owner's
   * question too, never a plan.
   */
  const noLate = (floorMinor: number): ReturnType<typeof solve> | { none: 'proven' | 'not_found' } => {
    try {
      const r = solve(floorMinor, false);
      return r.minBalance.minor >= floorMinor ? r : { none: 'proven' };
    } catch (e) {
      if (e instanceof NoAdmissibleScheduleError) return { none: e.proven ? 'proven' : 'not_found' };
      throw e;
    }
  };
  let solved: ReturnType<typeof solve> | null = null;
  if (!acceptLate) {
    const onTime: FlowEvent[] = [...model.fixedFlows];
    for (const p of model.payables) {
      const f = payableDefaultFlow(model, p);
      if (f !== null) onTime.push(f);
    }
    const series = dailyBalances(model.dates, model.openingBalanceMinor, onTime).balance;
    let low = 0;
    for (let t = 1; t < series.length; t += 1) if ((series[t] as number) < (series[low] as number)) low = t;
    const lowBalance = series[low] as number;
    if (lowBalance < input.floorMinor) {
      const rescue = noLate(input.floorMinor);
      if ('none' in rescue) {
        let baseAt = 0;
        for (let t = 1; t < base.balance.length; t += 1) if ((base.balance[t] as number) < (base.balance[baseAt] as number)) baseAt = t;
        const baseLow = { date: model.dates[baseAt] as string, balanceMinor: base.balance[baseAt] as number };
        // The suggested floor: the on-time low when it is not negative (every bill on time there); else 0
        // when the search finds a no-late schedule at 0 (a Skonto keeps it); else none.
        const atZero = lowBalance >= 0 ? null : noLate(0);
        const suggested = lowBalance >= 0 ? lowBalance : atZero !== null && !('none' in atZero) ? 0 : null;
        const searched = atZero !== null && 'none' in atZero ? atZero.none : rescue.none;
        return err('floor_breached_by_schedule', {
          date: model.dates[low],
          currency: params.currency,
          balanceMinor: lowBalance,
          shortfallMinor: input.floorMinor - lowBalance,
          suggestedFloorMinor: suggested,
          overdraws: suggested === null,
          noLateSearch: searched,
          // The scheduled flows ALONE (no bill paid at all) go under 0: no payment date, late or not, fixes
          // that, so nobody is told that late payments would help (critic R4-L1 wording residual).
          scheduleAloneOverdraws: baseLow.balanceMinor < 0 ? baseLow : null,
          hint:
            suggested !== null
              ? 'lower floorMinor to suggestedFloorMinor (no bill is then paid late), or propose again with acceptLatePayments: true'
              : baseLow.balanceMinor < 0
                ? 'the scheduled flows alone take the balance under 0 (scheduleAloneOverdraws): no payment date fixes that; it needs more money on the account or other scheduled flows'
                : searched === 'proven'
                ? 'even a floor of 0 has no schedule without a late payment: only acceptLatePayments: true can go on'
                : 'no schedule without a late payment was found inside the search budget, even at a floor of 0: propose again with acceptLatePayments: true, or lower the bills in the horizon',
        });
      }
      solved = rescue;
    }
  }
  const { json, hash } = canonicalInputs(model, extraInputs(input.floorMinor, lateInterestBp, acceptLate));

  const existing = ctx.store.db
    .prepare("SELECT * FROM payment_plan WHERE workspace_id = ? AND inputs_hash = ? AND status = 'proposed'")
    .get(ctx.workspaceId, hash) as PlanRow | undefined;
  if (existing !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'liquidity_plan_propose', () =>
      ok({ planId: existing.id, replayed: true, plan: planView(ctx, existing) }),
    );
  }

  if (solved === null) solved = solve(input.floorMinor, acceptLate);
  const byBill = new Map(model.payables.map((p) => [p.billId, p] as const));

  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'liquidity_plan_propose', () => {
      const planId = ctx.ids.next('pplan');
      const now = ctx.clock.now();
      ctx.store.db
        .prepare(
          `INSERT INTO payment_plan
             (id, workspace_id, status, as_of, horizon_end, currency, floor_minor, params_json, inputs_hash,
              inputs_json, objective_minor, skonto_captured_minor, late_interest_minor, optimality,
              upper_bound_minor, late_days_lower_bound, nodes_explored, min_balance_minor, min_balance_date,
              base_breach_json, idempotency_key, created_by, created_at)
           VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          planId,
          ctx.workspaceId,
          model.asOf,
          model.horizonEnd,
          params.currency,
          input.floorMinor,
          JSON.stringify({ ...params, lateInterestBp, acceptLatePayments: acceptLate, accountIds: model.accounts.map((a) => a.bankAccountId) }),
          hash,
          json,
          solved.objectiveMinor,
          solved.skontoCapturedMinor,
          solved.lateInterestMinor,
          solved.optimality,
          solved.upperBoundMinor,
          solved.lateDaysLowerBound,
          solved.nodesExplored,
          solved.minBalance.minor,
          solved.minBalance.date,
          solved.baseBreach === null ? null : JSON.stringify(solved.baseBreach),
          input.idempotencyKey,
          ctx.actor,
          now,
        );
      const insert = ctx.store.db.prepare(
        `INSERT INTO payment_plan_line
           (id, plan_id, workspace_id, vendor_bill_id, vendor_id, action, option_kind, pay_date, arrival_date,
            open_minor, cash_minor, skonto_minor, interest_minor, days_late, reason, reason_json, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      );
      for (const l of solved.lines) {
        const p = byBill.get(l.billId);
        insert.run(
          ctx.ids.next('ppline'),
          planId,
          ctx.workspaceId,
          l.billId,
          p?.vendorId ?? null,
          l.option.date === null ? 'defer' : 'pay',
          l.option.kind,
          l.option.date,
          l.option.arrival,
          p?.openMinor ?? 0,
          l.option.cashMinor,
          l.option.skontoMinor,
          l.option.interestMinor,
          l.option.daysLate,
          l.reason,
          JSON.stringify({ ...l.detail, skontoSource: p?.skonto.source ?? 'none', dueAssumed: p?.dueAssumed ?? false }),
        );
      }
      for (const billId of solved.beyondHorizon) {
        const p = byBill.get(billId);
        insert.run(
          ctx.ids.next('ppline'),
          planId,
          ctx.workspaceId,
          billId,
          p?.vendorId ?? null,
          'defer',
          'defer',
          null,
          null,
          p?.openMinor ?? 0,
          0,
          0,
          0,
          0,
          'not_due_in_horizon',
          JSON.stringify({
            dueDate: p?.dueDate ?? null,
            skontoUntil: p !== undefined && p.skonto.rateBp > 0 ? p.skonto.untilDate : null,
            skontoRateBp: p?.skonto.rateBp ?? 0,
            skontoSource: p?.skonto.source ?? 'none',
            dueAssumed: p?.dueAssumed ?? false,
          }),
        );
      }
      // The Skonto a supplier conceded, still open because A14 cannot book it yet: a line so the plan
      // accounts for every open bill, and a defer so it is never drafted (critic M3).
      for (const r of model.skontoRemainders) {
        insert.run(
          ctx.ids.next('ppline'),
          planId,
          ctx.workspaceId,
          r.billId,
          r.vendorId,
          'defer',
          'defer',
          null,
          null,
          r.openMinor,
          0,
          0,
          0,
          0,
          'skonto_remainder',
          JSON.stringify({ skontoUntil: r.skontoUntil }),
        );
      }
      const row = readPlan(ctx, planId) as PlanRow;
      return ok({ planId, replayed: false, plan: planView(ctx, row) });
    });
  } catch (e) {
    // A concurrent proposal on the same books won the UNIQUE (workspace_id, inputs_hash): answer it.
    if (!isUniqueViolation(e)) throw e;
    const winner = ctx.store.db
      .prepare("SELECT * FROM payment_plan WHERE workspace_id = ? AND inputs_hash = ? AND status = 'proposed'")
      .get(ctx.workspaceId, hash) as PlanRow | undefined;
    if (winner === undefined) throw e;
    return ok({ planId: winner.id, replayed: true, plan: planView(ctx, winner) });
  }
}

/** One proposal with its lines. */
export function getPaymentPlan(ctx: WorkspaceContext, input: { planId: string }): Result {
  const guard = requireString(input.planId, 'planId');
  if (guard) return guard;
  const row = readPlan(ctx, input.planId);
  if (row === undefined) return err('not_found', { planId: input.planId });
  return ok({ plan: planView(ctx, row) });
}

/** The proposals, newest first, without their lines. */
export function listPaymentPlans(ctx: WorkspaceContext, input: { status?: string } = {}): Result {
  if (input.status !== undefined && !(PAYMENT_PLAN_STATUSES as readonly string[]).includes(input.status)) {
    return err('invalid_input', { field: 'status', allowed: [...PAYMENT_PLAN_STATUSES] });
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM payment_plan_line l WHERE l.workspace_id = p.workspace_id AND l.plan_id = p.id) AS line_count
         FROM payment_plan p WHERE p.workspace_id = ? AND (? IS NULL OR p.status = ?)
        ORDER BY p.created_at DESC, p.id DESC`,
    )
    .all(ctx.workspaceId, input.status ?? null, input.status ?? null) as (PlanRow & { line_count: number })[];
  return ok({ plans: rows.map((r) => ({ ...summaryView(r), lineCount: r.line_count })), total: rows.length });
}

export interface DraftPlanBatchesInput {
  planId: string;
  bankAccountId: string;
  idempotencyKey: string;
}

/**
 * The currencies an A18 run can pay (SIX payment type D: CHF and EUR). A18 keeps its own set private and
 * refuses anything else with `unsupported_currency` at the door; this mirror only sorts such a line into
 * `notDrafted` instead of letting A18's refusal abort every run of the draft.
 */
const A18_BATCHABLE_CURRENCIES: ReadonlySet<string> = new Set(['CHF', 'EUR']);

/**
 * Why A18 would refuse to batch this open bill today, or null (A18's own rules in `prepareBatchItems`,
 * read here WITHOUT A18's list ceiling, critic H2): in a live run, an unsupported currency, no creditor
 * IBAN, a QR-IBAN without a valid QRR, or a QRR on a plain IBAN.
 */
function a18Refusal(ctx: WorkspaceContext, bill: OpenPayable): (typeof NOT_DRAFTED_REASONS)[number] | null {
  if (liveBatchOfBill(ctx, bill.id) !== null) return 'already_batched';
  if (!A18_BATCHABLE_CURRENCIES.has(bill.currency)) return 'unsupported_currency';
  const profile = ctx.store.db
    .prepare('SELECT is_qr_iban FROM creditor_bank_profile WHERE workspace_id = ? AND contact_id = ?')
    .get(ctx.workspaceId, bill.vendorId) as { is_qr_iban: number } | undefined;
  if (profile === undefined) return 'needs_creditor_iban';
  const classified = classifyReference(bill.vendorReference ?? undefined);
  if (profile.is_qr_iban === 1) return classified.kind === 'qrr' && classified.valid ? null : 'needs_qrr_reference';
  return classified.kind === 'qrr' ? 'invalid_reference' : null;
}

/** A refusal raised inside the memoised write, so it rolls the whole draft back and is never memoised. */
class DraftAbort extends Error {
  constructor(readonly result: Err) {
    super(result.error);
  }
}

/** Is this plan still the answer the books give today? Recomputes the canonical inputs. */
function planIsFresh(ctx: WorkspaceContext, row: PlanRow): { fresh: true; model: FlowModel } | { fresh: false; result: Result } {
  const stored = JSON.parse(row.params_json) as FlowParams & { lateInterestBp: number; acceptLatePayments?: boolean };
  const params = readFlowParams(ctx, {
    currency: row.currency,
    horizonDays: stored.horizonDays,
    delayQuantile: stored.delayQuantile,
    settlementLagDays: stored.settlementLagDays,
    ...(stored.bankAccountIds !== null ? { bankAccountIds: stored.bankAccountIds } : {}),
  });
  if ('ok' in params) return { fresh: false, result: params };
  const model = gatherFlows(ctx, params);
  if ('ok' in model) return { fresh: false, result: model };
  const { hash } = canonicalInputs(model, extraInputs(row.floor_minor, stored.lateInterestBp, stored.acceptLatePayments === true));
  if (hash !== row.inputs_hash) {
    return {
      fresh: false,
      result: err('stale_plan', {
        planId: row.id,
        planAsOf: row.as_of,
        today: model.asOf,
        hint: 'the books changed since this proposal; call liquidity_plan_propose again',
      }),
    };
  }
  return { fresh: true, model };
}

/** K1 read-back: the A18 run `batchId` is the one this draft asked for, bill for bill. */
function isOwnPlanRun(
  ctx: WorkspaceContext,
  batchId: string,
  asked: { bankAccountId: string; itemIds: string[]; executionDate: string; idempotencyKey: string },
): boolean {
  const batch = ctx.store.db
    .prepare('SELECT bank_account_id, execution_date, idempotency_key FROM payment_batch WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, batchId) as { bank_account_id: string; execution_date: string; idempotency_key: string } | undefined;
  if (batch === undefined) return false;
  if (batch.bank_account_id !== asked.bankAccountId || batch.execution_date !== asked.executionDate || batch.idempotency_key !== asked.idempotencyKey) {
    return false;
  }
  const bills = (
    ctx.store.db
      .prepare('SELECT vendor_bill_id FROM payment_batch_item WHERE workspace_id = ? AND batch_id = ?')
      .all(ctx.workspaceId, batchId) as { vendor_bill_id: string }[]
  )
    .map((r) => r.vendor_bill_id)
    .sort();
  const wanted = [...asked.itemIds].sort();
  return bills.length === wanted.length && bills.every((b, i) => b === wanted[i]);
}

/** Turn a proposal into A18 draft payment runs, one per execution date (US-A40.5). */
export function draftPlanBatches(ctx: WorkspaceContext, input: DraftPlanBatchesInput): Result {
  const guard =
    requireString(input.planId, 'planId') ??
    requireString(input.bankAccountId, 'bankAccountId') ??
    requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['liquidity_plan_draft_batches', input.idempotencyKey]);
  const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'liquidity_plan_draft_batches');
  if (replay !== undefined) return replay;

  const row = readPlan(ctx, input.planId);
  if (row === undefined) return err('not_found', { planId: input.planId });
  if (row.status === 'drafted') {
    return err('already_drafted', {
      planId: row.id,
      draftedAt: row.drafted_at,
      draft: row.draft_result_json === null ? null : (JSON.parse(row.draft_result_json) as unknown),
    });
  }

  const account = getBankAccount(ctx, { bankAccountId: input.bankAccountId });
  if (!account.ok) return err('needs_bank_account', { reason: 'unknown', bankAccountId: input.bankAccountId });
  const bank = account.bankAccount as { currency: string; archived: boolean; receiveOnly: boolean };
  if (bank.archived) return err('needs_bank_account', { reason: 'archived' });
  if (bank.receiveOnly) return err('needs_bank_account', { reason: 'receive_only_qr_iban' });
  if (bank.currency !== row.currency) {
    return err('currency_mismatch', { planCurrency: row.currency, bankAccountCurrency: bank.currency });
  }

  // The floor was proven on THESE accounts' balance (critic M4): a run may only debit one of them, and
  // only when the plan was solved on that account alone. A plan pooled over several accounts is proposed
  // again per debit account (`bankAccountIds: [id]`), so the floor it proves is the floor that account keeps.
  const planAccounts = (JSON.parse(row.params_json) as { accountIds?: string[] }).accountIds ?? [];
  if (planAccounts.length !== 1 || planAccounts[0] !== input.bankAccountId) {
    return err('account_mismatch', {
      planId: row.id,
      planAccountIds: planAccounts,
      bankAccountId: input.bankAccountId,
      hint: 'propose again with bankAccountIds: [the debit account], so the floor is kept on the account that pays',
    });
  }

  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'liquidity_plan_draft_batches', () => {
      // EVERYTHING the draft decides on is read INSIDE this IMMEDIATE transaction (critic L5): a second
      // writer (D12) that lands a bill or a payment after the checks above cannot slip in between the
      // freshness proof and the runs it justifies. A refusal here rolls back and is never memoised.
      const current = readPlan(ctx, row.id) as PlanRow;
      if (current.status !== 'proposed') {
        throw new DraftAbort(err('already_drafted', { planId: row.id, draftedAt: current.drafted_at }));
      }
      const freshness = planIsFresh(ctx, current);
      if (!freshness.fresh) throw new DraftAbort(freshness.result as Err);

      const open = new Map(readOpenPayables(ctx).map((b) => [b.id, b] as const));
      const lines = ctx.store.db
        .prepare(
          `SELECT id, vendor_bill_id, pay_date, skonto_minor, cash_minor FROM payment_plan_line
            WHERE workspace_id = ? AND plan_id = ? AND action = 'pay' ORDER BY pay_date, vendor_bill_id`,
        )
        .all(ctx.workspaceId, row.id) as { id: string; vendor_bill_id: string; pay_date: string; skonto_minor: number; cash_minor: number }[];

      const notDrafted: { vendorBillId: string; payDate: string; reason: (typeof NOT_DRAFTED_REASONS)[number] }[] = [];
      const byDate = new Map<string, { lineId: string; billId: string }[]>();
      for (const l of lines) {
        const bill = open.get(l.vendor_bill_id);
        let reason: (typeof NOT_DRAFTED_REASONS)[number] | null = null;
        if (l.skonto_minor > 0) reason = 'skonto_needs_reduced_amount';
        else if (bill === undefined) reason = 'no_longer_open';
        else reason = a18Refusal(ctx, bill);
        if (reason !== null) {
          notDrafted.push({ vendorBillId: l.vendor_bill_id, payDate: l.pay_date, reason });
          continue;
        }
        const group = byDate.get(l.pay_date) ?? [];
        group.push({ lineId: l.id, billId: l.vendor_bill_id });
        byDate.set(l.pay_date, group);
      }
      if (byDate.size === 0) throw new DraftAbort(err('nothing_to_draft', { planId: row.id, notDrafted }));
      const batches: {
        batchId: string;
        executionDate: string;
        itemCount: number;
        totalMinor: number;
        /** The bills of this run and the key A18 was called with: A18's own event input (critic R2-L1). */
        itemIds: string[];
        batchIdempotencyKey: string;
      }[] = [];
      const setBatch = ctx.store.db.prepare('UPDATE payment_plan_line SET batch_id = ? WHERE workspace_id = ? AND id = ?');
      for (const date of [...byDate.keys()].sort()) {
        const group = byDate.get(date) as { lineId: string; billId: string }[];
        const a18Input = {
          bankAccountId: input.bankAccountId,
          itemIds: group.map((g) => g.billId),
          executionDate: date,
          idempotencyKey: `${input.idempotencyKey}:${date}`,
        };
        // K1: the run's key is DERIVED from the draft's own key, so A18 runs in this composite's own
        // idempotency scope: a `create_payment_batch` made first under `K:<date>` used to be replayed
        // here and adopted as the plan's run. (A18's raw key is also unique on `payment_batch`, so such a
        // squat now refuses `idempotency_key_conflict` and the draft rolls back, never adopts.)
        const created = ctx.store.innerWrite('liquidity_plan_draft_batches', () => createPaymentBatch(ctx, a18Input));
        if (!created.ok) throw new DraftAbort(created);
        const batchId = created.batchId as string;
        // ...and the run is READ BACK: this key, this debit account, this date, exactly this group's bills.
        if (!isOwnPlanRun(ctx, batchId, a18Input)) {
          throw new DraftAbort(err('inner_write_not_own', { composite: 'liquidity_plan_draft_batches', inner: 'create_payment_batch', batchId, executionDate: date }));
        }
        const batch = created.batch as { ctrlSumMinor: number | null; items: { amountMinor: number }[] };
        for (const g of group) setBatch.run(batchId, ctx.workspaceId, g.lineId);
        batches.push({
          batchId,
          executionDate: date,
          itemCount: group.length,
          totalMinor: batch.items.reduce((s, it) => s + it.amountMinor, 0),
          itemIds: a18Input.itemIds,
          batchIdempotencyKey: a18Input.idempotencyKey,
        });
      }
      const result = { batches, notDrafted };
      ctx.store.db
        .prepare(
          `UPDATE payment_plan SET status = 'drafted', drafted_at = ?, drafted_by = ?, draft_key = ?, draft_result_json = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(ctx.clock.now(), ctx.actor, input.idempotencyKey, JSON.stringify(result), ctx.workspaceId, row.id);
      return ok({ planId: row.id, status: 'drafted', ...result, plan: planView(ctx, readPlan(ctx, row.id) as PlanRow) });
    });
  } catch (e) {
    if (e instanceof DraftAbort) return e.result;
    throw e;
  }
}
