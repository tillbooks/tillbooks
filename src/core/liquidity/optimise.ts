/**
 * A40, the pay-date optimiser: PURE, no store, no clock, no dependency (spec §4.4).
 *
 * REBUILT on 30.09.2026 after three critic FAILs (house rule: three FAILs mean the design is wrong).
 * Round 3 found that a hand-rolled LP bound silently relied on every bill having a zero-cash option, so
 * in the no-consent mode it turned into NaN, the search never ran and a local-search answer was labelled
 * `proven`. This file replaces that with ONE model, ONE exact search and bounds that are finite by
 * construction. What it does not do any more: a second algorithm per mode, a bound that can be infinite,
 * a `proven` label on anything but a completed search.
 *
 * ## The problem
 *
 * Days `t` run over the horizon `dates[0..T-1]`. `C_t` (`baseBalance`) is the end-of-day balance
 * from every scheduled flow EXCEPT the bills being decided. The headroom is `h_t = max(0, C_t - floor)`
 * and the capacity is `H_t = min_{s >= t} h_s`, which is nondecreasing in `t`. A decided bill `i`
 * paid on clearing day `x` arrives `lag` clearing days later, `a(x)`, and:
 *
 *   - costs cash `A_i - K_i` and is worth `K_i = round(A_i * r_i)` when `a(x) <= S_i` (Skonto),
 *   - costs cash `A_i` and is worth 0 when `S_i < a(x) <= D_i` (on time),
 *   - costs cash `A_i` and is worth `-round(A_i * bp * (a(x) - D_i) / 365)` after `D_i` (OR 104).
 *
 * A bill may also be DEFERRED past the horizon (no cash inside it, worth the interest it would have
 * accrued had it been paid on the first clearing day after the horizon, or 0 when it is not due in
 * the horizon at all). Every day `t` must satisfy
 *
 *     sum of the cash of the bills paid on or before t  <=  H_t
 *
 * which is exactly "no payment pushes the balance under the floor on any later day, and where the
 * scheduled flows alone are already under it, no payment deepens the dip". The objective is
 * LEXICOGRAPHIC: the most worth, then the fewest days late (critic H1: a payment in default is never
 * free, even where OR 104 interest rounds to 0.00).
 *
 * ## One model, two consent levels
 *
 * Each bill has a finite set of ADMISSIBLE options. `allowLate: false` (the owner decision of 30.09.2026:
 * no bill is paid late without the person's consent) keeps, per bill, the options with the FEWEST days
 * late that bill can have: 0 for a bill with an on-time day or not due in the horizon, the first
 * clearing day's lateness for a bill already overdue before today. `allowLate: true` keeps every option.
 * The search below is the same code for both; only the admissible sets differ.
 *
 * ## Why a small option set is enough (the exchange arguments)
 *
 *  1. Moving a Skonto-class or on-time payment LATER inside its class keeps its worth and lateness and
 *     never raises any prefix sum, so an optimum exists with each such payment on the LAST clearing
 *     day of its class (`lastExecutionFor`).
 *  2. Moving a late payment one clearing day EARLIER (from `x` to the previous clearing day `y`) lowers
 *     its lateness (and never raises its interest) and raises the prefix sums only on `[y, x)`, where
 *     they all equal `P_y` (no clearing day lies between). If `H_y = H_x` then `H` is constant on
 *     `[y, x]` and `P_y + c <= P_x <= H_x`, so the move is feasible and strictly better. Hence an
 *     optimum exists where every late payment sits on the first late clearing day or on a clearing day
 *     whose capacity is higher than the previous clearing day's.
 *  3. An option is DOMINATED when another is worth at least as much, is no more days late, costs no more
 *     cash and is paid on no earlier day: swapping it in lowers or keeps every prefix sum.
 *
 * Each bill therefore keeps at most: its Skonto day, its on-time day, its late candidates, defer.
 * The reduction is checked against a plain brute force over EVERY clearing day, which lives in the test
 * tree (`test/liquidity/oracle.mjs`), never in this module.
 *
 * ## The exact search (depth first, pruned only by facts that hold for every completion)
 *
 * Bills are decided one at a time; each bill's options are tried in preference order. A branch is cut
 * for exactly two reasons, and both are sound because cash is never negative:
 *
 *  - INFEASIBLE: an option that does not fit the slack left by the bills already placed fits no
 *    completion either (adding bills only adds cash).
 *  - BOUNDED: no completion can beat the incumbent. The bound is the minimum of
 *      (a) each remaining bill's best option that fits ALONE in the current slack (a bill with no such
 *          option makes the node infeasible), and
 *      (b) at selected check points `k`, the LP relaxation of the one-constraint multiple-choice
 *          knapsack "sum of the cash drawn on or before k <= slack_k". Every bill starts from its option
 *          that draws the LEAST cash at `k` (its base, finite: every bill has at least one option), the
 *          base cash is subtracted from the slack (a negative remainder proves infeasibility), and the
 *          greedy walk over the upper-convex-hull increments in descending slope, last one fractional,
 *          is the LP optimum (Sinha and Zoltners, 1979). Slopes are compared by exact cross
 *          multiplication and the fractional part is floored in BigInt, so the bound is an integer that
 *          is never below the true optimum. Lateness is bounded by (a)'s fewest days late.
 *    Every bound is an integer sum of finite integers; `assertSafe` refuses anything else.
 *
 * A completed search returns the lexicographically best schedule, ties broken by the first one in
 * preference order (options by worth, then fewer days late, then dated before defer, then the later
 * day; bills by best worth, then id): `optimality: 'proven'`. The problem contains 0/1 knapsack, so the
 * search is exponential in the worst case: past `nodeBudget` nodes or `WORK_BUDGET` counted steps
 * (counted, never timed, so every machine stops at the same place) the best schedule found, polished by
 * single and pair moves under their own counted allowance, is returned as `optimality: 'heuristic'` with
 * the root bound as `upperBoundMinor`, so the gap is stated and never hidden.
 *
 * ## Time (critic R4-M2)
 *
 * The proposal runs on the single MCP / Studio thread, so the work it may do is bounded, not only the
 * nodes: every fit test and slack update is charged per check point it touches, the option preparation
 * and the hull construction are charged, the Lagrangian walk stops at a quarter of the budget, the
 * dominance filter is linear (two late options never dominate each other), and a bill keeps at most
 * `MAX_LATE_CANDIDATES` late days (its first late day and the largest capacity rises). When that cap
 * bites the reduction is no longer exact: the answer is `heuristic`, and the bound it states is a
 * Lagrangian over the kept AND the dropped options, so it holds for the full problem. A wall-clock
 * backstop (`DEFAULT_WALL_MS`) ends the search as `heuristic` should the counted budgets ever not.
 */

import {
  addDays,
  addClearingDays,
  clearingDayOnOrAfter,
  daysBetween,
  isClearingDay,
  lastExecutionFor,
  nextClearingDay,
} from './calendar.js';

/** The default node budget (spec §4.4). */
export const DEFAULT_NODE_BUDGET = 200_000;
/**
 * The deterministic work budget: EVERY inner step counted (bound evaluations, each check point a fit
 * test or a slack update touches, the option preparation), never timed, so the same instance stops at
 * the same place and answers the same schedule on any machine (critic R4-M2).
 */
export const WORK_BUDGET = 40_000_000;
/** The heuristic polish after a budget cut gets its own counted allowance, then stops wherever it is. */
export const POLISH_WORK_BUDGET = 8_000_000;
/**
 * The wall-clock BACKSTOP, in milliseconds (critic R4-M2): `liquidity_plan_propose` runs on the single
 * MCP and Studio thread, so no proposal may hold it for long. The counted budgets normally stop first;
 * if the clock does, the answer is `heuristic` like any other budget cut (never `proven`).
 */
export const DEFAULT_WALL_MS = 2_500;
/** The pair-swap polish gets its own slice of wall time after the search, then stops (critic R5-M3). */
export const POLISH_WALL_MS = 300;
/** When the clock runs out while the options are still being prepared, the remaining bills keep this many late days. */
const DEGRADED_LATE_CANDIDATES = 4;
/**
 * The late candidates a bill keeps beyond its first late day (critic R4-M2): the capacity rises with the
 * LARGEST increase. When a bill has more, the reduction is no longer exact, so the answer is
 * `heuristic` and its stated bound is one that holds for the full problem.
 */
export const MAX_LATE_CANDIDATES = 48;
/** The check points a node evaluates the LP bound at (the tightest at the root, plus the last). */
export const LP_POINTS_PER_NODE = 6;

/** §H-ENUM: `proven` (a completed exact search) or `heuristic` (past the budget, gap stated). */
export const OPTIMALITIES = ['proven', 'heuristic'] as const;
export type Optimality = (typeof OPTIMALITIES)[number];

export interface DecisionBill {
  id: string;
  /** The open amount, integer minor units, > 0. */
  openMinor: number;
  /** The Verfalltag (OR 102 Abs. 2). */
  dueDate: string;
  /** Basis points of the open amount; 0 = no Skonto. */
  skontoRateBp: number;
  /** The last day the payment may ARRIVE and still earn the Skonto, or null. */
  skontoUntil: string | null;
}

export interface OptimiseInput {
  /** Consecutive calendar days, `dates[0]` = asOf. */
  dates: readonly string[];
  /** End-of-day balance per date from every flow except the decided bills. */
  baseBalance: readonly number[];
  floorMinor: number;
  bills: readonly DecisionBill[];
  /** Clearing days between execution and arrival (OR 74: a money debt is a Bringschuld). */
  lagDays: number;
  /** Default interest, basis points per year (OR 104 Abs. 1: 500). */
  lateInterestBp: number;
  nodeBudget?: number;
  /** The wall-clock backstop in ms (`DEFAULT_WALL_MS`); hitting it answers `heuristic`. */
  wallMs?: number;
  /**
   * May the plan pay a bill LATER than it has to? `true` (the default) keeps every option. `false` is
   * the owner decision of 30.09.2026 (critic M8, R2-H1): each bill keeps only the options with the fewest
   * days late it can have, so no bill is made late by the plan. The same search runs either way.
   */
  allowLate?: boolean;
}

export const OPTION_KINDS = ['skonto', 'on_time', 'late', 'defer'] as const;
export type OptionKind = (typeof OPTION_KINDS)[number];

export interface PayOption {
  kind: OptionKind;
  /** The execution date, or null for `defer`. */
  date: string | null;
  arrival: string | null;
  cashMinor: number;
  skontoMinor: number;
  interestMinor: number;
  daysLate: number;
  /** skontoMinor - interestMinor. */
  valueMinor: number;
}

export const PLAN_REASONS = [
  'skonto_captured',
  'on_time_latest',
  'skonto_forgone_floor',
  'skonto_forgone_search_limit',
  'late_floor',
  'already_overdue',
  'deferred_floor',
] as const;
export type PlanReason = (typeof PLAN_REASONS)[number];

export interface PlanLineResult {
  billId: string;
  option: PayOption;
  reason: PlanReason;
  detail: {
    dueDate: string;
    skontoUntil: string | null;
    skontoRateBp: number;
    lastExecutionSkonto: string | null;
    lastExecutionDue: string;
    /** The best-worth option this bill had, when it was not the one chosen, and whether it alone fits. */
    bestAlternative: { kind: OptionKind; date: string | null; valueMinor: number; fitsAlone: boolean } | null;
  };
}

export interface OptimiseResult {
  lines: PlanLineResult[];
  /** Bills with neither a Skonto window nor a due date inside the horizon: nothing to decide yet. */
  beyondHorizon: string[];
  objectiveMinor: number;
  skontoCapturedMinor: number;
  lateInterestMinor: number;
  optimality: Optimality;
  /** Proven: the objective itself. Heuristic: the root bound, which no schedule exceeds. */
  upperBoundMinor: number;
  /** The days late of the proposal, summed over its bills. */
  daysLateTotal: number;
  /**
   * No schedule keeping the floor has fewer days late (critic R2-L4). Proven: the proposal's own total
   * (the search was exhaustive on worth, then lateness). Heuristic: the sum over bills of the fewest days
   * late among the options that fit ALONE, a floor every feasible schedule is at or above.
   */
  lateDaysLowerBound: number;
  nodesExplored: number;
  /** End-of-day balance per date WITH the proposal. */
  balances: number[];
  minBalance: { date: string; minor: number };
  /** The lowest base balance under the floor, when the scheduled flows alone breach it. */
  baseBreach: { date: string; balanceMinor: number } | null;
}

/** Integer rounding half away from zero on (numerator / denominator), exact in BigInt. */
export function roundHalfAway(numerator: bigint, denominator: bigint): number {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return Number(negative ? -q : q);
}

/** The Skonto on an open amount: round(A * bp / 10'000). */
export function skontoMinor(openMinor: number, rateBp: number): number {
  return roundHalfAway(BigInt(openMinor) * BigInt(rateBp), 10_000n);
}

/** OR 104 default interest: round(A * bp * days / (10'000 * 365)). */
export function interestMinor(openMinor: number, rateBp: number, days: number): number {
  if (days <= 0 || rateBp <= 0) return 0;
  return roundHalfAway(BigInt(openMinor) * BigInt(rateBp) * BigInt(days), 3_650_000n);
}

/**
 * Without consent, no schedule keeps the floor (or none was found inside the budget: `proven` false).
 * plan.ts turns it into the owner's question, `floor_breached_by_schedule` (critic R4-L1).
 */
export class NoAdmissibleScheduleError extends Error {
  constructor(public readonly proven: boolean) {
    super(
      proven
        ? 'optimise: no admissible schedule keeps the floor without late payments (proven by a complete search)'
        : 'optimise: no admissible schedule keeps the floor without late payments was found inside the budget',
    );
  }
}

/** Every bound and every worth is a safe integer; anything else is a defect, never a silent NaN. */
function assertSafe(x: number, what: string): number {
  if (!Number.isSafeInteger(x)) throw new Error(`optimise: ${what} is not a finite integer (${x})`);
  return x;
}

interface Candidate extends PayOption {
  /** Index into the check-point array, or -1 for defer. */
  point: number;
  /** The day index of the payment (Infinity for defer), computed once. */
  dk: number;
  /** The lexicographic objective as ONE integer: `valueMinor * W - daysLate` (see `W` below). */
  score: number;
}

interface PreparedBill {
  bill: DecisionBill;
  /** The admissible options, dominance-reduced, in preference order. */
  options: Candidate[];
  maxValue: number;
  maxScore: number;
  lastExecSkonto: string | null;
  lastExecDue: string;
  /** Late candidates the cap dropped (with consent only): they still enter the full-problem bound. */
  dropped: Candidate[];
}

/** A hull increment of one bill at one check point: `dc` more cash drawn buys `dv` more worth. */
interface Increment {
  bill: number;
  dc: number;
  dv: number;
}

/** floor(a / b) for integers, b > 0, exact in BigInt (negative numerators round down, not to zero). */
function floorDiv(a: number, b: number): number {
  const A = BigInt(a);
  const B = BigInt(b);
  const q = A / B;
  return Number(A % B !== 0n && A < 0n ? q - 1n : q);
}

/** a.dv / a.dc compared with b.dv / b.dc, exactly (both denominators positive). */
function compareSlope(a: { dv: number; dc: number }, b: { dv: number; dc: number }): number {
  const l = BigInt(a.dv) * BigInt(b.dc);
  const r = BigInt(b.dv) * BigInt(a.dc);
  return l > r ? 1 : l < r ? -1 : 0;
}

/**
 * Solve (spec §4.4). Returns a schedule that keeps the floor. With `allowLate` true one always exists
 * (deferring every bill draws no cash); with `allowLate` false the caller must have proven that the
 * on-time schedule keeps the floor (plan.ts does), and an instance without any admissible schedule throws.
 */
export function optimisePaymentPlan(input: OptimiseInput): OptimiseResult {
  const { dates, baseBalance, floorMinor, lagDays, lateInterestBp } = input;
  const allowLate = input.allowLate !== false;
  const deadline = performance.now() + (input.wallMs ?? DEFAULT_WALL_MS);
  let work = 0;
  let clockHit = false;
  /** True once the wall-clock backstop has passed (checked sparsely: the clock is a backstop only). */
  const outOfTime = (): boolean => {
    if (!clockHit && performance.now() > deadline) clockHit = true;
    return clockHit;
  };
  const T = dates.length;
  if (T === 0 || baseBalance.length !== T) throw new Error('optimise: dates and baseBalance must align');
  assertSafe(floorMinor, 'floorMinor');
  for (const b of baseBalance) assertSafe(b, 'a base balance');
  const first = dates[0] as string;
  const end = dates[T - 1] as string;
  const indexOf = (date: string): number => daysBetween(first, date);

  // Capacity: headroom per day, then the suffix minimum.
  const cap: number[] = new Array<number>(T);
  let running = Number.POSITIVE_INFINITY;
  let breach: { date: string; balanceMinor: number } | null = null;
  for (let t = T - 1; t >= 0; t -= 1) {
    const bal = baseBalance[t] as number;
    running = Math.min(running, Math.max(0, bal - floorMinor));
    cap[t] = running;
  }
  for (let t = 0; t < T; t += 1) {
    const bal = baseBalance[t] as number;
    if (bal < floorMinor && (breach === null || bal < breach.balanceMinor)) {
      breach = { date: dates[t] as string, balanceMinor: bal };
    }
  }

  // The clearing days of the horizon and where capacity rises between consecutive ones.
  const clearing: string[] = [];
  for (const d of dates) if (isClearingDay(d)) clearing.push(d);
  const rises = new Set<string>();
  const riseBy = new Map<string, number>();
  for (let k = 0; k < clearing.length; k += 1) {
    const d = clearing[k] as string;
    const by = k === 0 ? Number.POSITIVE_INFINITY : (cap[indexOf(d)] as number) - (cap[indexOf(clearing[k - 1] as string)] as number);
    if (by > 0) {
      rises.add(d);
      riseBy.set(d, by);
    }
  }
  let reduced = false;
  const firstExec = clearing[0] ?? null;
  const afterHorizonExec = nextClearingDay(end);
  // Arrival per clearing day, computed once (the lag is fixed): every bill's options reuse it.
  const arrivalOf = new Map<string, string>();
  const arrive = (date: string): string => {
    let a = arrivalOf.get(date);
    if (a === undefined) {
      a = addClearingDays(date, lagDays);
      arrivalOf.set(date, a);
    }
    return a;
  };

  // --- The admissible, reduced option set of every bill (one model for both consent levels). ------
  const beyondHorizon: string[] = [];
  const prepared: PreparedBill[] = [];
  const optionDays = new Set<string>();
  const dayKey = (o: Candidate): number => o.dk;

  let lateCap = MAX_LATE_CANDIDATES;
  let billNo = 0;
  for (const bill of input.bills) {
    // The clock is checked inside the preparation too (critic R5-M3): past it, the remaining bills keep
    // fewer late days, which makes the answer heuristic rather than late.
    if ((billNo++ & 31) === 0 && lateCap > DEGRADED_LATE_CANDIDATES && outOfTime()) lateCap = DEGRADED_LATE_CANDIDATES;
    const A = assertSafe(bill.openMinor, `the open amount of ${bill.id}`);
    const skontoUntil =
      bill.skontoRateBp > 0 && bill.skontoUntil !== null
        ? bill.skontoUntil < bill.dueDate
          ? bill.skontoUntil
          : bill.dueDate
        : null;
    const lastExecSkonto = skontoUntil === null ? null : lastExecutionFor(skontoUntil, lagDays);
    const lastExecDue = lastExecutionFor(bill.dueDate, lagDays);
    const K = skontoUntil === null ? 0 : skontoMinor(A, bill.skontoRateBp);

    const skontoInHorizon =
      lastExecSkonto !== null && firstExec !== null && lastExecSkonto >= firstExec && lastExecSkonto <= end && K > 0;
    const dueInHorizon = lastExecDue <= end;
    if (!skontoInHorizon && !dueInHorizon) {
      beyondHorizon.push(bill.id);
      continue;
    }

    const make = (date: string | null): Candidate => {
      if (date === null) {
        // Defer: executed on the first clearing day after the horizon.
        const arrival = addClearingDays(afterHorizonExec, lagDays);
        const late = dueInHorizon ? Math.max(1, daysBetween(bill.dueDate, arrival)) : 0;
        const interest = interestMinor(A, lateInterestBp, late);
        return { kind: 'defer', date: null, arrival: null, cashMinor: 0, skontoMinor: 0, interestMinor: interest, daysLate: late, valueMinor: -interest, point: -1, dk: Number.POSITIVE_INFINITY, score: 0 };
      }
      const arrival = arrive(date);
      const captured = skontoUntil !== null && arrival <= skontoUntil ? K : 0;
      const late = Math.max(0, daysBetween(bill.dueDate, arrival));
      const interest = interestMinor(A, lateInterestBp, late);
      const kind: OptionKind = captured > 0 ? 'skonto' : late > 0 ? 'late' : 'on_time';
      work += 1;
      return { kind, date, arrival, cashMinor: A - captured, skontoMinor: captured, interestMinor: interest, daysLate: late, valueMinor: captured - interest, point: 0, dk: indexOf(date), score: 0 };
    };

    const raw: Candidate[] = [];
    const dropped: Candidate[] = [];
    if (skontoInHorizon) raw.push(make(lastExecSkonto));
    if (firstExec !== null && dueInHorizon && lastExecDue >= firstExec) raw.push(make(lastExecDue));
    if (firstExec !== null && dueInHorizon) {
      const firstLate = lastExecDue >= firstExec ? nextClearingDay(lastExecDue) : firstExec;
      let lateDays = clearing.filter((d) => d >= firstLate && (d === firstLate || rises.has(d)));
      if (lateDays.length > lateCap) {
        // Keep the first late day and the largest capacity rises, in date order. The reduction is exact
        // no longer, but only where a dropped day was ADMISSIBLE (critic R5-L1): without consent a bill
        // keeps only its fewest days late, the first late day, which the cap always keeps.
        if (allowLate) reduced = true;
        const keep = new Set(
          lateDays
            .filter((d) => d !== firstLate)
            .sort((x, y) => (riseBy.get(y) as number) - (riseBy.get(x) as number) || (x < y ? -1 : 1))
            .slice(0, lateCap - 1),
        );
        if (allowLate) for (const d of lateDays) if (d !== firstLate && !keep.has(d)) dropped.push(make(d));
        lateDays = lateDays.filter((d) => d === firstLate || keep.has(d));
      }
      work += lateDays.length;
      for (const d of lateDays) raw.push(make(d));
    }
    raw.push(make(null));

    // The consent level: without it, only the fewest days late this bill can have.
    const fewestLate = raw.reduce((m, o) => Math.min(m, o.daysLate), Number.POSITIVE_INFINITY);
    const admissible = allowLate ? raw : raw.filter((o) => o.daysLate === fewestLate);

    // Exchange argument 3: drop a dominated option (the earlier index survives an exact tie). LINEAR, not
    // quadratic (critic R4-M2): two LATE options never dominate each other (distinct clearing days arrive
    // on distinct days, so the later one is strictly more days late), so every comparison has a non-late
    // option (Skonto, on time, defer: at most three) on at least one side.
    const dominates = (p: Candidate, o: Candidate, j: number, i: number): boolean =>
      p.valueMinor >= o.valueMinor &&
      p.daysLate <= o.daysLate &&
      p.cashMinor <= o.cashMinor &&
      dayKey(p) >= dayKey(o) &&
      (p.valueMinor > o.valueMinor || p.daysLate < o.daysLate || p.cashMinor < o.cashMinor || dayKey(p) > dayKey(o) || j < i);
    const nonLate = admissible.map((_o, j) => j).filter((j) => (admissible[j] as Candidate).kind !== 'late');
    const kept = admissible.filter((o, i) => {
      const rivals = o.kind === 'late' ? nonLate : admissible.map((_, j) => j);
      work += rivals.length;
      return !rivals.some((j) => j !== i && dominates(admissible[j] as Candidate, o, j, i));
    });
    // THE ORDER IS THE PREFERENCE: worth, then fewer days late, then a dated payment before defer, then
    // the later day (the liquidity tie-break exchange argument 1 justifies).
    kept.sort(
      (x, y) =>
        y.valueMinor - x.valueMinor ||
        x.daysLate - y.daysLate ||
        (x.date === null ? 1 : 0) - (y.date === null ? 1 : 0) ||
        dayKey(y) - dayKey(x),
    );
    for (const o of kept) {
      assertSafe(o.valueMinor, 'an option worth');
      if (o.date !== null) optionDays.add(o.date);
    }
    prepared.push({
      bill,
      options: kept,
      maxValue: (kept[0] as Candidate).valueMinor,
      maxScore: 0,
      dropped,
      lastExecSkonto: skontoInHorizon ? lastExecSkonto : null,
      lastExecDue,
    });
  }

  // ONE INTEGER OBJECTIVE. Two schedules' total lateness differ by at most the sum over bills of (most
  // minus fewest days late among its options), so with W one larger than that, comparing
  // `worth * W - daysLate` IS the lexicographic comparison (worth first, then fewer days late), and every
  // bound below bounds lateness and worth together. `assertSafe` refuses an instance where the product
  // would leave the exact integer range rather than compare rounded floats.
  let W = 1;
  let lateMax = 0;
  for (const p of prepared) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (const o of p.options) {
      lo = Math.min(lo, o.daysLate);
      hi = Math.max(hi, o.daysLate);
    }
    W += hi - lo;
    lateMax += hi;
  }
  let lateMaxFull = lateMax;
  for (const p of prepared) {
    for (const o of p.dropped) o.score = assertSafe(o.valueMinor * W - o.daysLate, 'an option score');
    const keptMax = Math.max(...p.options.map((o) => o.daysLate));
    const droppedMax = p.dropped.reduce((m, o) => Math.max(m, o.daysLate), 0);
    lateMaxFull += Math.max(0, droppedMax - keptMax);
  }
  for (const p of prepared) {
    for (const o of p.options) o.score = assertSafe(o.valueMinor * W - o.daysLate, 'an option score');
    p.maxScore = (p.options[0] as Candidate).score;
  }

  // Check points: every day an option can pay on, ascending. The constraint only needs checking there
  // (between two of them neither the prefix sum nor the nondecreasing capacity can get tighter).
  const points = [...optionDays].sort();
  const pointIndex = new Map(points.map((d, k) => [d, k] as const));
  for (const p of prepared) for (const o of p.options) o.point = o.date === null ? -1 : (pointIndex.get(o.date) as number);
  const K = points.length;
  const slack = points.map((d) => cap[indexOf(d)] as number);
  const initialSlack = slack.slice();
  for (const s of slack) assertSafe(s, 'a capacity');

  const fits = (point: number, cash: number): boolean => {
    if (point < 0 || cash === 0) return true;
    work += K - point;
    for (let k = point; k < K; k += 1) if ((slack[k] as number) < cash) return false;
    return true;
  };
  const apply = (point: number, cash: number, sign: 1 | -1): void => {
    if (point < 0 || cash === 0) return;
    work += K - point;
    for (let k = point; k < K; k += 1) slack[k] = (slack[k] as number) - sign * cash;
  };

  // Search order: the most valuable decisions first, then the id (deterministic).
  prepared.sort((x, y) => y.maxValue - x.maxValue || (x.bill.id < y.bill.id ? -1 : x.bill.id > y.bill.id ? 1 : 0));
  const n = prepared.length;
  const opt = (i: number, k: number): Candidate => (prepared[i] as PreparedBill).options[k] as Candidate;
  const suffixBest: number[] = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) suffixBest[i] = assertSafe((suffixBest[i + 1] as number) + (prepared[i] as PreparedBill).maxScore, 'a score sum');

  // --- Bound (b): the LP relaxation per check point, precomputed (the hulls do not depend on slack). -
  const baseCashSuffix: number[][] = [];
  const baseValueSuffix: number[][] = [];
  const increments: Increment[][] = [];
  // The LP bound is an accelerator only: past the clock its precomputation stops and no node uses it.
  let lpOn = true;
  for (let k = 0; k < K; k += 1) {
    if ((k & 7) === 0 && outOfTime()) {
      lpOn = false;
      break;
    }
    const cSuf = new Array<number>(n + 1).fill(0);
    const vSuf = new Array<number>(n + 1).fill(0);
    const list: Increment[] = [];
    const c0s: number[] = [];
    const v0s: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const pts = (prepared[i] as PreparedBill).options.map((o) => ({
        c: o.point >= 0 && o.point <= k ? o.cashMinor : 0,
        v: o.score,
      }));
      // The base: the least cash drawn at k, and the most worth among those. Always finite: every bill
      // has at least one option.
      let c0 = Number.POSITIVE_INFINITY;
      for (const p of pts) c0 = Math.min(c0, p.c);
      let v0 = Number.NEGATIVE_INFINITY;
      for (const p of pts) if (p.c === c0) v0 = Math.max(v0, p.v);
      assertSafe(c0, 'an LP base cash');
      assertSafe(v0, 'an LP base worth');
      c0s.push(c0);
      v0s.push(v0);
      work += pts.length;
      const cand = pts.filter((p) => p.c > c0 && p.v > v0).sort((a, b) => a.c - b.c || b.v - a.v);
      const hull: { c: number; v: number }[] = [{ c: c0, v: v0 }];
      for (const p of cand) {
        const last = hull[hull.length - 1] as { c: number; v: number };
        if (p.v <= last.v) continue;
        while (hull.length >= 2) {
          const a = hull[hull.length - 2] as { c: number; v: number };
          const b = hull[hull.length - 1] as { c: number; v: number };
          // Pop b when it lies on or under the chord a..p (slope a->b <= slope b->p).
          if (compareSlope({ dv: b.v - a.v, dc: b.c - a.c }, { dv: p.v - b.v, dc: p.c - b.c }) <= 0) hull.pop();
          else break;
        }
        hull.push(p);
      }
      for (let h = 1; h < hull.length; h += 1) {
        const prev = hull[h - 1] as { c: number; v: number };
        const cur = hull[h] as { c: number; v: number };
        list.push({ bill: i, dc: cur.c - prev.c, dv: cur.v - prev.v });
      }
    }
    for (let i = n - 1; i >= 0; i -= 1) {
      cSuf[i] = (cSuf[i + 1] as number) + (c0s[i] as number);
      vSuf[i] = (vSuf[i + 1] as number) + (v0s[i] as number);
    }
    list.sort((x, y) => compareSlope(y, x) || x.bill - y.bill || x.dc - y.dc);
    baseCashSuffix.push(cSuf);
    baseValueSuffix.push(vSuf);
    increments.push(list);
  }

  /** The LP bound at point k over the bills i..n-1 against the CURRENT slack, or null when infeasible. */
  const lpBound = (k: number, i: number): number | null => {
    let capLeft = (slack[k] as number) - ((baseCashSuffix[k] as number[])[i] as number);
    if (capLeft < 0) return null;
    let v = (baseValueSuffix[k] as number[])[i] as number;
    for (const inc of increments[k] as Increment[]) {
      work += 1;
      if (inc.bill < i) continue;
      if (capLeft === 0) break;
      if (inc.dc <= capLeft) {
        v += inc.dv;
        capLeft -= inc.dc;
      } else {
        v += Number((BigInt(inc.dv) * BigInt(capLeft)) / BigInt(inc.dc));
        break;
      }
    }
    return assertSafe(v, 'an LP bound');
  };

  /** Bound (a): the sum of each remaining bill's best score among the options that fit alone. */
  const minFrom = new Array<number>(K + 1).fill(Number.POSITIVE_INFINITY);
  const aloneBound = (i: number): number | null => {
    for (let k = K - 1; k >= 0; k -= 1) minFrom[k] = Math.min(minFrom[k + 1] as number, slack[k] as number);
    let ub = 0;
    for (let r = i; r < n; r += 1) {
      let best: number | null = null;
      for (const o of (prepared[r] as PreparedBill).options) {
        work += 1;
        if (o.point < 0 || o.cashMinor === 0 || (minFrom[o.point] as number) >= o.cashMinor) {
          best = o.score; // options are sorted by score, so the first that fits is the best
          break;
        }
      }
      if (best === null) return null;
      ub += best;
    }
    return assertSafe(ub, 'a fits-alone bound');
  };

  // The root bound over EVERY point is the certificate a heuristic answer states. Nodes evaluate the
  // tightest points at the root plus the last one; any subset is still a valid bound.
  const rootAlone = aloneBound(0);
  let rootBound = rootAlone === null ? 0 : rootAlone;
  let rootFeasible = rootAlone !== null;
  const rootByPoint: { k: number; b: number }[] = [];
  for (let k = 0; k < K && rootFeasible && lpOn; k += 1) {
    const b = lpBound(k, 0);
    if (b === null) rootFeasible = false;
    else {
      rootByPoint.push({ k, b });
      rootBound = Math.min(rootBound, b);
    }
  }
  const evalPoints = [...rootByPoint].sort((x, y) => x.b - y.b || x.k - y.k).slice(0, LP_POINTS_PER_NODE).map((x) => x.k);
  if (lpOn && K > 0 && !evalPoints.includes(K - 1)) evalPoints.push(K - 1);

  // --- Bound (c): a Lagrangian relaxation of ALL check points at once. ----------------------------
  // For ANY multipliers lambda_k >= 0 and any completion that keeps the floor,
  //   score <= sum_k lambda_k * slack_k + sum_bills max_option (score - cash * Lambda(point)),
  // where Lambda(p) = sum_{k >= p} lambda_k (a payment on point p draws on every point from p on) and
  // the max may skip options that do not fit alone (no completion uses them). The multipliers are tuned
  // once at the root by a plain subgradient walk in floating point and then FLOORED onto the grid
  // 1 / LAGRANGE_SCALE: ANY non-negative multipliers give a valid bound, so the walk and the rounding
  // cost tightness, never soundness. Every node evaluates the bound exactly, in BigInt.
  const LAGRANGE_SCALE = 1n << 20n;
  const LAGRANGE_ITERATIONS = 200;
  const lambdaN: bigint[] = new Array<bigint>(K).fill(0n);
  if (rootFeasible && K > 0 && n > 0) {
    // A feasible score to aim the step at: the greedy schedule (each bill its best option that fits).
    let target: number | null = 0;
    const placed: Candidate[] = [];
    for (let i = 0; i < n && target !== null; i += 1) {
      const o = (prepared[i] as PreparedBill).options.find((x) => fits(x.point, x.cashMinor));
      if (o === undefined) target = null;
      else {
        apply(o.point, o.cashMinor, 1);
        placed.push(o);
        target += o.score;
      }
    }
    for (const o of placed) apply(o.point, o.cashMinor, -1);
    const aim = target ?? rootBound - Math.abs(rootBound) * 0.1 - 1;
    const lam = new Array<number>(K).fill(0);
    let bestL = Number.POSITIVE_INFINITY;
    let bestLam = lam.slice();
    let theta = 1;
    let stall = 0;
    const usage = new Array<number>(K).fill(0);
    // The walk only tightens the bound, so it stops early when the instance is large: a quarter of the
    // counted budget, or the wall clock (any multipliers it has by then are valid).
    for (let it = 0; it < LAGRANGE_ITERATIONS && work < WORK_BUDGET / 4 && !outOfTime(); it += 1) {
      const suffix = new Array<number>(K + 1).fill(0);
      for (let k = K - 1; k >= 0; k -= 1) suffix[k] = (suffix[k + 1] as number) + (lam[k] as number);
      usage.fill(0);
      let L = 0;
      for (let k = 0; k < K; k += 1) L += (lam[k] as number) * (slack[k] as number);
      for (let i = 0; i < n; i += 1) {
        let bestAdj = Number.NEGATIVE_INFINITY;
        let arg: Candidate | null = null;
        for (const o of (prepared[i] as PreparedBill).options) {
          work += 1;
          const adj = o.score - (o.point < 0 ? 0 : o.cashMinor * (suffix[o.point] as number));
          if (adj > bestAdj) {
            bestAdj = adj;
            arg = o;
          }
        }
        L += bestAdj;
        if (arg !== null && arg.point >= 0) usage[arg.point] = (usage[arg.point] as number) + arg.cashMinor;
      }
      if (L < bestL) {
        bestL = L;
        bestLam = lam.slice();
        stall = 0;
      } else if (++stall >= 10) {
        theta /= 2;
        stall = 0;
      }
      // The subgradient of L in lambda_k is slack_k minus the cash the relaxed choice draws by k.
      let used = 0;
      let norm = 0;
      const g = new Array<number>(K).fill(0);
      for (let k = 0; k < K; k += 1) {
        used += usage[k] as number;
        g[k] = (slack[k] as number) - used;
        if (!((lam[k] as number) === 0 && (g[k] as number) > 0)) norm += (g[k] as number) * (g[k] as number);
      }
      const gap = L - aim;
      if (norm === 0 || !(gap > 0) || theta < 1e-6) break;
      const step = (theta * gap) / norm;
      for (let k = 0; k < K; k += 1) lam[k] = Math.max(0, (lam[k] as number) - step * (g[k] as number));
    }
    for (let k = 0; k < K; k += 1) {
      const x = (bestLam[k] as number) * Number(LAGRANGE_SCALE);
      lambdaN[k] = Number.isFinite(x) && x > 0 ? BigInt(Math.floor(Math.min(x, Number.MAX_SAFE_INTEGER))) : 0n;
    }
  }
  const lambdaSuffix: bigint[] = new Array<bigint>(K + 1).fill(0n);
  for (let k = K - 1; k >= 0; k -= 1) lambdaSuffix[k] = (lambdaSuffix[k + 1] as bigint) + (lambdaN[k] as bigint);

  // The bound for the FULL problem when the late candidates were capped: the same Lagrangian (a
  // relaxation of the check-point constraints is a relaxation of every constraint), with the max taken
  // over the kept AND the dropped options. A payment on a day between check points draws on every
  // check point from that day on.
  let fullProblemWorthBound: number | null = null;
  if (reduced) {
    const pointDay = points.map((d) => indexOf(d));
    const lambdaFrom = (dk: number): bigint => {
      if (!Number.isFinite(dk)) return 0n;
      let k = 0;
      while (k < K && (pointDay[k] as number) < dk) k += 1;
      return lambdaSuffix[k] as bigint;
    };
    let total = 0n;
    for (let k = 0; k < K; k += 1) total += (lambdaN[k] as bigint) * BigInt(initialSlack[k] as number);
    for (const p of prepared) {
      let best: bigint | null = null;
      for (const o of [...p.options, ...p.dropped]) {
        work += 1;
        const adj = BigInt(o.score) * LAGRANGE_SCALE - (o.date === null ? 0n : BigInt(o.cashMinor) * lambdaFrom(o.dk));
        if (best === null || adj > best) best = adj;
      }
      total += best as bigint;
    }
    const q = total / LAGRANGE_SCALE;
    const scoreBound = Number(total % LAGRANGE_SCALE !== 0n && total < 0n ? q - 1n : q);
    fullProblemWorthBound = Math.min(
      assertSafe(floorDiv(assertSafe(scoreBound, 'a full-problem bound') + lateMaxFull, W), 'a full-problem bound'),
      prepared.reduce((sum, p) => sum + p.maxValue, 0),
    );
  }
  // Per option its adjusted score (fixed, the multipliers are), per bill its options best first.
  const adjusted: bigint[][] = prepared.map((p) =>
    p.options.map((o) => BigInt(o.score) * LAGRANGE_SCALE - (o.point < 0 ? 0n : BigInt(o.cashMinor) * (lambdaSuffix[o.point] as bigint))),
  );
  const adjustedOrder: number[][] = adjusted.map((row) =>
    row.map((_, j) => j).sort((a, b) => ((row[b] as bigint) > (row[a] as bigint) ? 1 : (row[b] as bigint) < (row[a] as bigint) ? -1 : a - b)),
  );
  /** Bound (c) over the bills i..n-1 against the current slack; `minFrom` must be current (aloneBound). */
  const lagrangeBound = (i: number): number | null => {
    let total = 0n;
    for (let k = 0; k < K; k += 1) if ((lambdaN[k] as bigint) !== 0n) total += (lambdaN[k] as bigint) * BigInt(slack[k] as number);
    for (let r = i; r < n; r += 1) {
      const p = prepared[r] as PreparedBill;
      let found = false;
      for (const j of adjustedOrder[r] as number[]) {
        work += 1;
        const o = p.options[j] as Candidate;
        if (o.point < 0 || o.cashMinor === 0 || (minFrom[o.point] as number) >= o.cashMinor) {
          total += (adjusted[r] as bigint[])[j] as bigint;
          found = true;
          break;
        }
      }
      if (!found) return null;
    }
    const q = total / LAGRANGE_SCALE;
    return assertSafe(Number(total % LAGRANGE_SCALE !== 0n && total < 0n ? q - 1n : q), 'a Lagrangian bound');
  };
  if (rootFeasible) {
    aloneBound(0); // refreshes minFrom for the root slack
    const lg = lagrangeBound(0);
    if (lg === null) rootFeasible = false;
    else rootBound = Math.min(rootBound, lg);
  }

  const nodeBound = (i: number): number | null => {
    let ub = aloneBound(i);
    if (ub === null) return null;
    const lg = lagrangeBound(i);
    if (lg === null) return null;
    if (lg < ub) ub = lg;
    for (const k of evalPoints) {
      const b = lpBound(k, i);
      if (b === null) return null;
      if (b < ub) ub = b;
    }
    return ub;
  };

  // --- The exact search. -----------------------------------------------------------------------
  const budget = input.nodeBudget ?? DEFAULT_NODE_BUDGET;
  const choice: number[] = new Array<number>(n).fill(-1);
  let best: number[] | null = null;
  let bestScore = 0;
  let nodes = 0;
  let aborted = false;

  const dfs = (i: number, score: number): void => {
    if (i === n) {
      // Strictly better only: among equal schedules the first in preference order stays.
      if (best === null || score > bestScore) {
        best = [...choice];
        bestScore = score;
      }
      return;
    }
    const ub = nodeBound(i);
    if (ub === null || (best !== null && score + ub <= bestScore)) return;
    const p = prepared[i] as PreparedBill;
    for (let k = 0; k < p.options.length; k += 1) {
      const o = p.options[k] as Candidate;
      // Options are sorted by score: once even the best completion of this one cannot win, neither can the rest.
      if (best !== null && score + o.score + (suffixBest[i + 1] as number) <= bestScore) break;
      if (!fits(o.point, o.cashMinor)) continue;
      nodes += 1;
      if (nodes > budget || work > WORK_BUDGET || ((nodes & 255) === 0 && outOfTime())) {
        aborted = true;
        return;
      }
      apply(o.point, o.cashMinor, 1);
      choice[i] = k;
      dfs(i + 1, score + o.score);
      apply(o.point, o.cashMinor, -1);
      choice[i] = -1;
      if (aborted) return;
    }
  };
  if (rootFeasible) {
    if (outOfTime()) aborted = true; // the preparation used the time: no search, the fallback below
    else dfs(0, 0);
  }

  const lateOf = (ch: readonly number[]): number => ch.reduce((s, k, i) => s + opt(i, k).daysLate, 0);
  const feasibleSchedule = (ch: readonly number[]): boolean => {
    let okAll = true;
    const placed: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const o = opt(i, ch[i] as number);
      if (!fits(o.point, o.cashMinor)) {
        okAll = false;
        break;
      }
      apply(o.point, o.cashMinor, 1);
      placed.push(i);
    }
    for (const i of placed) {
      const o = opt(i, ch[i] as number);
      apply(o.point, o.cashMinor, -1);
    }
    return okAll;
  };

  if (best === null) {
    // No leaf: either the search proved there is none, or the budget ran out before the first one.
    if (!aborted) {
      if (allowLate) throw new Error('optimise: no feasible schedule (a defect: deferring every bill always fits)');
      throw new NoAdmissibleScheduleError(true); // a complete search: no schedule without a late payment
    }
    // The fallback is a FEASIBLE GREEDY schedule (critic R5-M3), never "every bill on its latest option"
    // (with consent that is "defer everything"): each bill, in search order, takes its best option that
    // still fits. With consent deferral always fits, so it always completes. Without consent the on-time
    // schedule (every bill's latest admissible option) is tried when the greedy one gets stuck.
    const greedy: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const k = (prepared[i] as PreparedBill).options.findIndex((o) => fits(o.point, o.cashMinor));
      if (k < 0) break;
      const o = opt(i, k);
      apply(o.point, o.cashMinor, 1);
      greedy.push(k);
    }
    for (let i = 0; i < greedy.length; i += 1) {
      const o = opt(i, greedy[i] as number);
      apply(o.point, o.cashMinor, -1);
    }
    if (greedy.length === n) best = greedy;
    else {
      const onTime = prepared.map((p) => {
        let k = 0;
        p.options.forEach((o, j) => {
          const cur = p.options[k] as Candidate;
          if (dayKey(o) > dayKey(cur) || (dayKey(o) === dayKey(cur) && o.cashMinor < cur.cashMinor)) k = j;
        });
        return k;
      });
      if (allowLate || !feasibleSchedule(onTime)) {
        if (allowLate) throw new Error('optimise: the greedy schedule did not complete (a defect: deferral always fits)');
        throw new NoAdmissibleScheduleError(false); // the budget ran out: not found, not proven absent
      }
      best = onTime;
    }
  }
  const chosen: number[] = [...(best as number[])];

  // Commit the chosen schedule to the slack.
  for (let i = 0; i < n; i += 1) {
    const o = opt(i, chosen[i] as number);
    apply(o.point, o.cashMinor, 1);
  }
  if (slack.some((s) => s < 0)) throw new Error('optimise: the chosen schedule breaks the floor (a defect)');

  const better = (v: number, late: number, bv: number, blate: number): boolean => v > bv || (v === bv && late < blate);
  /**
   * Single moves to a FIXPOINT: every bill moves to its best option that fits with all the others where
   * they are. Always run to the end on a heuristic answer (critic R5-M3): afterwards no bill is late, or
   * forgoes a Skonto, while a better option of its own fits, so `late_floor` and `deferred_floor` are
   * statements about the floor, never about the clock. Each pass strictly improves the score or stops.
   */
  const singleMoves = (): boolean => {
    let any = false;
    for (let pass = 0; pass < 10_000; pass += 1) {
      let improved = false;
      for (let i = 0; i < n; i += 1) {
        const cur = opt(i, chosen[i] as number);
        apply(cur.point, cur.cashMinor, -1);
        let to = -1;
        for (let k = 0; k < (chosen[i] as number); k += 1) {
          const o = opt(i, k);
          if (better(o.valueMinor, o.daysLate, cur.valueMinor, cur.daysLate) && fits(o.point, o.cashMinor)) {
            to = k;
            break;
          }
        }
        const next = to >= 0 ? opt(i, to) : cur;
        apply(next.point, next.cashMinor, 1);
        if (to >= 0) {
          chosen[i] = to;
          improved = true;
        }
      }
      if (!improved) break;
      any = true;
    }
    return any;
  };
  if (aborted || reduced) {
    // HEURISTIC ONLY (a completed search on the full option sets is already optimal and never touched).
    singleMoves();
    // Pair swaps under their own counted allowance and their own slice of wall time.
    const polishLimit = work + POLISH_WORK_BUDGET;
    const polishDeadline = performance.now() + POLISH_WALL_MS;
    const spent = (): boolean => work > polishLimit || performance.now() > polishDeadline;
    let improved = true;
    while (improved && !spent()) {
      improved = false;
      for (let i = 0; i < n && !improved && !spent(); i += 1) {
        for (let j = 0; j < n && !improved && !spent(); j += 1) {
          if (j === i) continue;
          const curI = opt(i, chosen[i] as number);
          const curJ = opt(j, chosen[j] as number);
          apply(curI.point, curI.cashMinor, -1);
          apply(curJ.point, curJ.cashMinor, -1);
          for (let a = 0; a < (prepared[i] as PreparedBill).options.length && !improved; a += 1) {
            const oa = opt(i, a);
            if (!fits(oa.point, oa.cashMinor)) continue;
            apply(oa.point, oa.cashMinor, 1);
            for (let b = 0; b < (prepared[j] as PreparedBill).options.length; b += 1) {
              const ob = opt(j, b);
              const v = oa.valueMinor + ob.valueMinor;
              const l = oa.daysLate + ob.daysLate;
              if (better(v, l, curI.valueMinor + curJ.valueMinor, curI.daysLate + curJ.daysLate) && fits(ob.point, ob.cashMinor)) {
                apply(ob.point, ob.cashMinor, 1);
                chosen[i] = a;
                chosen[j] = b;
                improved = true;
                break;
              }
            }
            if (!improved) apply(oa.point, oa.cashMinor, -1);
          }
          if (!improved) {
            apply(curI.point, curI.cashMinor, 1);
            apply(curJ.point, curJ.cashMinor, 1);
          }
        }
      }
      if (improved) singleMoves(); // a swap can open a single move: back to the fixpoint
    }
  }

  // The lateness no feasible schedule can beat (critic R2-L4), measured against the EMPTY slack.
  let lateFloor = lateOf(chosen);
  if (reduced) {
    // The capped option sets keep each bill's fewest days late (its first late day or better), but a
    // dropped day could fit where a kept one does not: the floor ignores fit, which holds for the full problem.
    lateFloor = prepared.reduce((sum, p) => sum + Math.min(...p.options.map((o) => o.daysLate)), 0);
  } else if (aborted) {
    for (let i = 0; i < n; i += 1) {
      const o = opt(i, chosen[i] as number);
      apply(o.point, o.cashMinor, -1);
    }
    lateFloor = 0;
    for (let i = 0; i < n; i += 1) {
      let fewest = Number.POSITIVE_INFINITY;
      for (const o of (prepared[i] as PreparedBill).options) if (o.daysLate < fewest && fits(o.point, o.cashMinor)) fewest = o.daysLate;
      if (Number.isFinite(fewest)) lateFloor += fewest;
    }
    for (let i = 0; i < n; i += 1) {
      const o = opt(i, chosen[i] as number);
      apply(o.point, o.cashMinor, 1);
    }
  }

  const lines: PlanLineResult[] = [];
  let skontoTotal = 0;
  let interestTotal = 0;
  for (let i = 0; i < n; i += 1) {
    const p = prepared[i] as PreparedBill;
    const k = chosen[i] as number;
    const o = p.options[k] as Candidate;
    skontoTotal += o.skontoMinor;
    interestTotal += o.interestMinor;

    // Would the best option fit on its own, with this bill's own choice taken out?
    let bestAlternative: PlanLineResult['detail']['bestAlternative'] = null;
    if (k !== 0) {
      const alt = p.options[0] as Candidate;
      apply(o.point, o.cashMinor, -1);
      const fitsAlone = fits(alt.point, alt.cashMinor);
      apply(o.point, o.cashMinor, 1);
      bestAlternative = { kind: alt.kind, date: alt.date, valueMinor: alt.valueMinor, fitsAlone };
    }
    const hadSkonto = p.options.some((x) => x.skontoMinor > 0);
    let reason: PlanReason;
    if (o.skontoMinor > 0) reason = 'skonto_captured';
    else if (o.kind === 'defer') {
      reason =
        p.lastExecDue > end
          ? bestAlternative?.fitsAlone === true && (aborted || reduced)
            ? 'skonto_forgone_search_limit'
            : 'skonto_forgone_floor'
          : 'deferred_floor';
    } else if (o.daysLate > 0) {
      // Late, and never for nothing (critic H1, L1): a bill that still had an on-time day is late only
      // because that day did not fit (or, with consent, for a Skonto worth more elsewhere); a bill that
      // was already overdue before today is paid on the first clearing day unless the floor pushed it.
      const hadOnTimeDay = firstExec !== null && p.lastExecDue >= firstExec;
      reason = !hadOnTimeDay && o.date === firstExec ? 'already_overdue' : 'late_floor';
    } else if (hadSkonto) {
      reason = (aborted || reduced) && bestAlternative?.fitsAlone === true ? 'skonto_forgone_search_limit' : 'skonto_forgone_floor';
    } else reason = 'on_time_latest';

    lines.push({
      billId: p.bill.id,
      option: {
        kind: o.kind,
        date: o.date,
        arrival: o.arrival,
        cashMinor: o.cashMinor,
        skontoMinor: o.skontoMinor,
        interestMinor: o.interestMinor,
        daysLate: o.daysLate,
        valueMinor: o.valueMinor,
      },
      reason,
      detail: {
        dueDate: p.bill.dueDate,
        skontoUntil: p.bill.skontoRateBp > 0 ? p.bill.skontoUntil : null,
        skontoRateBp: p.bill.skontoRateBp,
        lastExecutionSkonto: p.lastExecSkonto,
        lastExecutionDue: p.lastExecDue,
        bestAlternative,
      },
    });
  }
  lines.sort((x, y) => {
    const dx = x.option.date ?? '9999-12-31';
    const dy = y.option.date ?? '9999-12-31';
    return dx < dy ? -1 : dx > dy ? 1 : x.billId < y.billId ? -1 : x.billId > y.billId ? 1 : 0;
  });

  // The balance with the proposal.
  const paidOn = new Array<number>(T).fill(0);
  for (const l of lines) if (l.option.date !== null) paidOn[indexOf(l.option.date)] = (paidOn[indexOf(l.option.date)] as number) + l.option.cashMinor;
  const balances: number[] = [];
  let paid = 0;
  let min = { date: first, minor: Number.POSITIVE_INFINITY };
  for (let t = 0; t < T; t += 1) {
    paid += paidOn[t] as number;
    const b = (baseBalance[t] as number) - paid;
    balances.push(b);
    if (b < min.minor) min = { date: dates[t] as string, minor: b };
  }

  const objective = assertSafe(skontoTotal - interestTotal, 'the objective');
  // The root bound is on the SCORE. Any schedule's worth * W = score + daysLate <= rootBound + lateMax,
  // so its worth is at most floor((rootBound + lateMax) / W), floored exactly in BigInt.
  // With capped late candidates the root bound speaks for the reduced sets only; the full-problem
  // Lagrangian above (never below a feasible schedule, by construction) is stated instead.
  const heuristic = aborted || reduced;
  const upperBound = reduced
    ? Math.max(objective, fullProblemWorthBound as number)
    : aborted
      ? assertSafe(floorDiv(rootBound + lateMax, W), 'the root bound')
      : objective;
  if (upperBound < objective) throw new Error('optimise: the root bound is below a feasible schedule (a defect)');
  const daysLateTotal = lines.reduce((s, l) => s + l.option.daysLate, 0);
  return {
    lines,
    beyondHorizon: beyondHorizon.sort(),
    objectiveMinor: objective,
    skontoCapturedMinor: skontoTotal,
    lateInterestMinor: interestTotal,
    optimality: heuristic ? 'heuristic' : 'proven',
    upperBoundMinor: upperBound,
    daysLateTotal,
    lateDaysLowerBound: Math.min(lateFloor, daysLateTotal),
    nodesExplored: Math.min(nodes, budget),
    balances,
    minBalance: min,
    baseBreach: breach,
  };
}

/** The consecutive calendar days from `from` for `count` days. */
export function horizonDates(from: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(addDays(from, i));
  return out;
}

export { clearingDayOnOrAfter };
