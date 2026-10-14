/**
 * A40, the Zahlungsplanung read-model types and the pure helpers the tab needs.
 *
 * Mirrored from `src/core/liquidity/{forecast,plan,terms,plannedFlows}.ts`, never invented: every field
 * here is one the A40 verbs answer with. The GUI adds and rounds no money: every figure on the tab is
 * rendered verbatim from `liquidity_forecast` / `liquidity_plan_*`. The only arithmetic here is the
 * chart's pixel geometry, which is a drawing and not a figure.
 */

/** §H-ENUM mirror of `PLAN_LINE_REASONS` (src/core/liquidity/plan.ts). */
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
export type PlanLineReason = (typeof PLAN_LINE_REASONS)[number];

/** §H-ENUM mirror of `NOT_DRAFTED_REASONS` (src/core/liquidity/plan.ts). */
export const NOT_DRAFTED_REASONS = [
  'skonto_needs_reduced_amount',
  'needs_creditor_iban',
  'needs_qrr_reference',
  'invalid_reference',
  'unsupported_currency',
  'already_batched',
  'no_longer_open',
] as const;
export type NotDraftedReason = (typeof NOT_DRAFTED_REASONS)[number];

/**
 * The reasons a flow is not counted, each with its own words (critic L4). Not an engine enum: an MWST
 * refusal code can arrive here too, so anything outside this list reads as "anderer Grund".
 */
export const EXCLUDED_REASON_WORDS = [
  'other_currency',
  'no_due_date',
  'overdue_beyond_history',
  'overdue_no_history',
  'credit_balance',
  'customer_credit',
  'skonto_remainder',
  'run_item_missing',
  'vat_not_configured',
  'vat_period_not_started',
  'vat_period_overdue',
  'vat_unattributed',
  'vat_due_beyond_horizon',
  'unsupported',
  'vat_period_filed_payment_unknown',
  'other_account',
] as const;

/** The distinct excluded reasons, known ones by name and the rest as `other`, in a stable order. */
export function excludedReasonKeys(excluded: readonly { reason: string }[]): string[] {
  const known = new Set<string>(EXCLUDED_REASON_WORDS);
  const keys = new Set(excluded.map((e) => (known.has(e.reason) ? e.reason : 'other')));
  return [...EXCLUDED_REASON_WORDS, 'other'].filter((k) => keys.has(k));
}

/** The flow kinds an `accountUnknown` tally can name, in the order the Annahmen line lists them. */
export const ACCOUNT_UNKNOWN_KINDS = ['receivable', 'recurring', 'planned', 'payment_run', 'vat'] as const;

/** §H-ENUM mirror of `PLANNED_FLOW_DIRECTIONS` / `PLANNED_FLOW_RECURRENCES` (plannedFlows.ts). */
export const PLANNED_FLOW_DIRECTIONS = ['in', 'out'] as const;
export const PLANNED_FLOW_RECURRENCES = ['once', 'monthly', 'quarterly', 'yearly'] as const;
export type PlannedFlowDirection = (typeof PLANNED_FLOW_DIRECTIONS)[number];
export type PlannedFlowRecurrence = (typeof PLANNED_FLOW_RECURRENCES)[number];

/**
 * §H-ENUM mirror of `OPTIMALITIES` (optimise.ts): `proven` is a completed exact search, `heuristic` the
 * best schedule found when the search stopped at its budget, never called optimal.
 */
export const OPTIMALITIES = ['proven', 'heuristic'] as const;
export type Optimality = (typeof OPTIMALITIES)[number];

/** The horizons the tab offers: every one inside the engine's 7..366 bound. */
export const PLAN_HORIZONS = [30, 60, 90, 180] as const;

export interface ForecastDay {
  date: string;
  inMinor: number;
  outMinor: number;
  balanceMinor: number;
  balanceWithPlanMinor?: number;
  inWithPlanMinor?: number;
  outWithPlanMinor?: number;
}

export interface ForecastFlow {
  date: string;
  amountMinor: number;
  kind: 'booked' | 'receivable' | 'recurring' | 'vat' | 'planned' | 'payable' | 'payment_run';
  ref: string | null;
  label: string | null;
  provenance: string;
}

/**
 * §H-ENUM mirror of `CONSERVATIVE_REASONS` (flows.ts): an amount debited although the books cannot say
 * exactly what it is (owner decision 01.10.2026, critic R4-M1). Each is shown as its own line.
 */
export const CONSERVATIVE_REASONS = ['vat_return_refused', 'vat_unattributed', 'vat_input_not_settled'] as const;
export type ConservativeReason = (typeof CONSERVATIVE_REASONS)[number];
export interface ConservativeLine {
  kind: string;
  reason: ConservativeReason;
  ref: string | null;
  amountMinor: number;
  date: string;
  dueDate: string | null;
  refusal: string | null;
}

export interface ForecastView {
  asOf: string;
  horizonEnd: string;
  currency: string;
  openingBalanceMinor: number;
  days?: ForecastDay[];
  flows: ForecastFlow[];
  lowest: { date: string; balanceMinor: number };
  lowestWithPlan: { date: string; balanceMinor: number } | null;
  excluded: { kind: string; reason: string; ref: string | null; currency: string | null; amountMinor: number | null }[];
  conservative?: ConservativeLine[];
  assumptions?: {
    noHistory?: { count: number; amountMinor: number };
    pooledHistory?: { count: number; amountMinor: number };
    openingSource?: 'ledger';
    accountCount?: number;
    vatPartial?: { count: number; amountMinor: number };
    lastPossibleDay?: boolean;
    /** Flows whose account the books cannot know, counted on the chosen account (critic R2-M2). */
    accountUnknown?: { count: number; inMinor: number; outMinor: number; kinds: string[] };
  };
}

export interface PlanLine {
  vendorBillId: string;
  vendorId: string | null;
  vendorName: string | null;
  vendorReference: string | null;
  action: 'pay' | 'defer';
  option: string;
  payDate: string | null;
  arrivalDate: string | null;
  openMinor: number;
  cashMinor: number;
  skontoMinor: number;
  interestMinor: number;
  daysLate: number;
  reason: PlanLineReason;
  detail: { dueDate?: string | null; skontoUntil?: string | null; skontoRateBp?: number };
  batchId: string | null;
}

export interface DraftResult {
  batches: { batchId: string; executionDate: string; itemCount: number; totalMinor: number; itemIds?: string[] }[];
  notDrafted: { vendorBillId: string; payDate: string; reason: NotDraftedReason }[];
}

export interface PlanView {
  id: string;
  /** What the floor proof leaned on (critic R4-M1): debited conservatively, and not counted. */
  conservative?: ConservativeLine[];
  excluded?: ForecastView['excluded'];
  status: 'proposed' | 'drafted';
  asOf: string;
  horizonEnd: string;
  currency: string;
  floorMinor: number;
  objectiveMinor: number;
  skontoCapturedMinor: number;
  lateInterestMinor: number;
  optimality: Optimality;
  upperBoundMinor: number;
  gapMinor: number;
  /** Days late summed over the lines, and the fewest any schedule could have (critic R2-L4). */
  daysLateTotal?: number;
  lateDaysLowerBound?: number;
  lateGapDays?: number;
  minBalanceMinor: number;
  minBalanceDate: string;
  floorBreachedByBase: { date: string; balanceMinor: number } | null;
  draft: DraftResult | null;
  lines: PlanLine[];
}

export interface SkontoTermView {
  id: string;
  scope: 'vendor' | 'bill';
  vendorId: string | null;
  vendorBillId: string | null;
  name: string | null;
  rateBp: number;
  days: number | null;
  untilDate: string | null;
}

export interface PlannedFlowView {
  id: string;
  label: string;
  direction: PlannedFlowDirection;
  amountMinor: number;
  currency: string;
  firstDate: string;
  recurrence: PlannedFlowRecurrence;
  endDate: string | null;
  active: boolean;
  /** The bank account the flow moves; null when it names none (critic R2-M2). */
  bankAccountId?: string | null;
}

/**
 * A decimal amount ("20000", "20'000.50") to integer minor units, exactly (digits, never a float), or
 * null. Non-negative only: a floor below zero (an overdraft limit) is typed with a leading minus.
 */
export function parseAmountToMinor(raw: string): number | null {
  const cleaned = raw.trim().replace(/[\s']/g, '');
  if (cleaned === '') return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) return null;
  const minor = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  return match[1] === '-' ? -minor : minor;
}

/** Integer minor units back into the plain decimal an input field holds ("45324.00"); never formatMoney. */
export function minorToInput(minor: number): string {
  const negative = minor < 0;
  const absolute = Math.abs(Math.trunc(minor));
  return `${negative ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/** A percentage ("2", "2.5") to basis points (200, 250), or null. At most two decimals, at most 10 %. */
export function percentToBp(raw: string): number | null {
  const cleaned = raw.trim().replace(',', '.');
  const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bp <= 1000 ? bp : null;
}

/** Basis points as the percentage a person reads ("2", "2.5"). Display only. */
export function bpToPercent(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

export interface ChartGeometry {
  width: number;
  height: number;
  base: string;
  withPlan: string | null;
  floorY: number | null;
  lowest: { x: number; y: number };
  ticks: { y: number; valueMinor: number }[];
}

/**
 * The chart's pixel geometry: step paths for the balance without and with the proposal, the floor
 * line, the lowest point and three value ticks. A drawing of the engine's figures, never a figure.
 */
export function chartGeometry(
  days: readonly ForecastDay[],
  floorMinor: number | null,
  width = 720,
  height = 200,
  pad = 8,
): ChartGeometry | null {
  if (days.length === 0) return null;
  const values: number[] = [];
  for (const d of days) {
    values.push(d.balanceMinor);
    if (d.balanceWithPlanMinor !== undefined) values.push(d.balanceWithPlanMinor);
  }
  if (floorMinor !== null) values.push(floorMinor);
  let min = Math.min(...values, 0);
  let max = Math.max(...values);
  if (max === min) {
    max += 1;
    min -= 1;
  }
  const x = (i: number) => pad + (i / Math.max(1, days.length)) * (width - 2 * pad);
  const y = (v: number) => pad + ((max - v) / (max - min)) * (height - 2 * pad);
  const step = (pick: (d: ForecastDay) => number): string => {
    let path = '';
    days.forEach((d, i) => {
      const yy = y(pick(d)).toFixed(1);
      path += i === 0 ? `M${x(0).toFixed(1)},${yy}` : `H${x(i).toFixed(1)}V${yy}`;
    });
    return `${path}H${x(days.length).toFixed(1)}`;
  };
  const hasPlan = days.some((d) => d.balanceWithPlanMinor !== undefined);
  const series = (d: ForecastDay) => (hasPlan ? (d.balanceWithPlanMinor ?? d.balanceMinor) : d.balanceMinor);
  let lowIndex = 0;
  days.forEach((d, i) => {
    if (series(d) < series(days[lowIndex] as ForecastDay)) lowIndex = i;
  });
  return {
    width,
    height,
    base: step((d) => d.balanceMinor),
    withPlan: hasPlan ? step(series) : null,
    floorY: floorMinor === null ? null : y(floorMinor),
    lowest: { x: x(lowIndex) + (x(lowIndex + 1) - x(lowIndex)) / 2, y: y(series(days[lowIndex] as ForecastDay)) },
    ticks: [max, (max + min) / 2, min].map((v) => ({ y: y(v), valueMinor: Math.round(v) })),
  };
}
