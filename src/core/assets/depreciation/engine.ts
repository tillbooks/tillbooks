/**
 * H03, the PLUGGABLE depreciation engine (OP12): pure amount calculators and forward-schedule
 * projection. No database access, no posting, no shared mutable state, so the same inputs always
 * produce the same outputs and concurrent calls are safe. H04 consumes these numbers verbatim; a
 * schedule that summed to more or less than (cost - residual) over the life would be a money-path
 * defect, so the final period ALWAYS residual-adjusts (§4, §7).
 *
 * Rounding is commercial (half away from zero), applied ONCE per period amount, in exact integer
 * arithmetic over BigInt so no float ever touches a Rappen figure (P2). Every amount is >= 0 and the
 * post-period NBV is never driven below residual (§H-ASSET residual floor).
 *
 * The method registry is the single §H-ENUM point: a localisation pack calls
 * `registerDepreciationMethod` to add a method without touching the core dispatch, exactly as the
 * journal_entry.source convention lets a new source land without a migration.
 */

import type {
  AssetSnapshot,
  CalcContext,
  DepreciationResult,
  ScheduleLine,
  ProRataConvention,
} from './types.js';

/** A period key `YYYY-MM`. Lexical order equals chronological order because both parts are zero-padded. */
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isPeriod(p: unknown): p is string {
  return typeof p === 'string' && PERIOD_RE.test(p);
}

/** The month AFTER `period`, wrapping the year. Assumes a valid period. */
export function nextPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** Calendar days in the month a period names (handles leap Februaries). */
export function daysInPeriod(period: string): number {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Round `numer/denom` half away from zero in exact integer arithmetic (P2). `denom` must be > 0. */
function roundDiv(numer: bigint, denom: bigint): bigint {
  const sign = numer < 0n ? -1n : 1n;
  const a = numer < 0n ? -numer : numer;
  // floor((2a + denom) / (2*denom)) == round-half-up on the magnitude.
  return sign * ((2n * a + denom) / (2n * denom));
}

/** Ceiling of `x/y` for non-negative integers. */
function ceilDiv(x: number, y: number): number {
  if (y <= 0) return 0;
  return Math.floor((x + y - 1) / y);
}

/** A per-method pure calculator: given a snapshot and a normalised context, produce the period result.
 * It is only ever called AFTER the shared guards (unknown/none/at-residual/already-processed) have
 * passed, so it may assume there is depreciable base left to allocate. */
type MethodCalculator = (asset: AssetSnapshot, ctx: Required<Pick<CalcContext, 'period' | 'proRata'>> & CalcContext) => DepreciationResult;

const REGISTRY = new Map<string, MethodCalculator>();

/** Register (or replace) a method's calculator. The single §H-ENUM extension point (OP12). */
export function registerDepreciationMethod(key: string, calculator: MethodCalculator): void {
  REGISTRY.set(key, calculator);
}

/** Is a method key known to the engine? */
export function hasDepreciationMethod(key: string): boolean {
  return REGISTRY.has(key);
}

/** The registered method keys, in registration order. */
export function registeredMethods(): string[] {
  return [...REGISTRY.keys()];
}

function zeroResult(
  asset: AssetSnapshot,
  period: string,
  reason: string,
  explanation: string,
): DepreciationResult {
  const nbv = asset.netBookValueRappen;
  const residual = asset.residualValueRappen;
  return {
    assetId: asset.id,
    period,
    method: asset.depreciationMethod,
    amountRappen: 0,
    isFinal: false,
    projectedNbvAfterRappen: Math.max(nbv, residual),
    reason,
    explanation,
  };
}

/** The remaining depreciable base for this asset right now: NBV above residual, never negative. */
function remainingDepreciable(asset: AssetSnapshot): number {
  return Math.max(0, asset.netBookValueRappen - asset.residualValueRappen);
}

// --- The four Phase-1 calculators (normative, spec §4) ---------------------------------------------

const straightLine: MethodCalculator = (asset, ctx) => {
  const cost = asset.acquisitionCostRappen;
  const residual = asset.residualValueRappen;
  const life = asset.usefulLifeMonths;
  const depreciable = Math.max(0, cost - residual);
  const remaining = remainingDepreciable(asset);
  if (life === null || life <= 0 || depreciable === 0) {
    return zeroResult(asset, ctx.period, 'already_at_residual', 'assets.depreciation.reason.already_at_residual');
  }
  // The base monthly charge, commercial-rounded ONCE (P2). `min(depreciable/life)` floor-rounding
  // leaves a sub-Rappen tail; the NOMINAL final period absorbs it so a life-month asset finishes in
  // exactly `life` months AND the schedule sums to exactly `depreciable` (§7). Finality is still
  // NBV-driven underneath, so a residual set so high that a full monthly would overshoot ends early.
  const baseMonthly = Number(roundDiv(BigInt(depreciable), BigInt(life)));
  const fullPeriod = ctx.proRata !== 'actual_days';
  let periodAmount = baseMonthly;
  if (!fullPeriod && typeof ctx.daysInService === 'number' && ctx.daysInService > 0) {
    const dip = daysInPeriod(ctx.period);
    const served = Math.min(ctx.daysInService, dip);
    periodAmount = Number(roundDiv(BigInt(baseMonthly) * BigInt(served), BigInt(dip)));
  }
  // How many full periods are already behind us (exact under full_period, where each is baseMonthly).
  const periodsElapsed = baseMonthly > 0 ? Math.round(asset.accumulatedDeprRappen / baseMonthly) : 0;
  const isNominalLast = fullPeriod && periodsElapsed + 1 >= life;
  const amount = isNominalLast ? remaining : Math.min(periodAmount, remaining);
  const projected = asset.netBookValueRappen - amount;
  const isFinal = projected <= residual;
  const remainingLifeMonths = fullPeriod
    ? Math.max(0, life - (periodsElapsed + 1))
    : baseMonthly > 0
      ? ceilDiv(projected - residual, baseMonthly)
      : 0;
  return {
    assetId: asset.id,
    period: ctx.period,
    method: asset.depreciationMethod,
    amountRappen: amount,
    isFinal,
    remainingLifeMonths,
    projectedNbvAfterRappen: projected,
    explanation: 'assets.depreciation.explain.straight_line',
  };
};

const decliningBalance: MethodCalculator = (asset, ctx) => {
  const residual = asset.residualValueRappen;
  const nbv = asset.netBookValueRappen;
  const rateBp = asset.decliningRateBp;
  const remaining = remainingDepreciable(asset);
  if (typeof rateBp !== 'number' || rateBp <= 0) {
    // No rate, no charge. A 0% rate is a legitimate "never depreciates" configuration (§8), not an error.
    return {
      assetId: asset.id,
      period: ctx.period,
      method: asset.depreciationMethod,
      amountRappen: 0,
      isFinal: false,
      projectedNbvAfterRappen: nbv,
      explanation: 'assets.depreciation.explain.declining_balance',
    };
  }
  // raw = nbv * (rateBp/10000) / 12, one rounding.
  let raw = Number(roundDiv(BigInt(nbv) * BigInt(rateBp), 10000n * 12n));
  if (ctx.proRata === 'actual_days' && typeof ctx.daysInService === 'number' && ctx.daysInService > 0) {
    const dip = daysInPeriod(ctx.period);
    const served = Math.min(ctx.daysInService, dip);
    raw = Number(roundDiv(BigInt(raw) * BigInt(served), BigInt(dip)));
  }
  const amount = Math.min(raw, remaining);
  const projected = nbv - amount;
  const isFinal = projected <= residual;
  return {
    assetId: asset.id,
    period: ctx.period,
    method: asset.depreciationMethod,
    amountRappen: amount,
    isFinal,
    projectedNbvAfterRappen: projected,
    explanation: 'assets.depreciation.explain.declining_balance',
  };
};

const unitsOfProduction: MethodCalculator = (asset, ctx) => {
  const cost = asset.acquisitionCostRappen;
  const residual = asset.residualValueRappen;
  const total = asset.totalEstimatedUnits;
  const nbv = asset.netBookValueRappen;
  const depreciable = Math.max(0, cost - residual);
  const remaining = remainingDepreciable(asset);
  if (typeof total !== 'number' || total <= 0 || typeof ctx.unitsProduced !== 'number') {
    return zeroResult(asset, ctx.period, 'missing_production_data', 'assets.depreciation.reason.missing_production_data');
  }
  const producedRaw = ctx.unitsProduced < 0 ? 0 : ctx.unitsProduced;
  // Units already consumed, inferred from accumulated depreciation, so cumulative units never exceed
  // total_estimated even across periods the engine did not itself compute.
  const consumed = depreciable > 0 ? Number(roundDiv(BigInt(asset.accumulatedDeprRappen) * BigInt(total), BigInt(depreciable))) : 0;
  const capacity = Math.max(0, total - consumed);
  const units = Math.min(producedRaw, capacity);
  const raw = Number(roundDiv(BigInt(depreciable) * BigInt(units), BigInt(total)));
  // The FINAL period residual-adjusts, exactly as straight line's does (§7, and the header contract
  // "the final period ALWAYS residual-adjusts"). `depreciable * units / total` is rounded once per
  // period, so the rounding tail has to land somewhere: without this it lands nowhere. A 175'000-unit
  // life at 12'000 a month sums to 23'999'996 of a 24'000'000 base, and the asset then strands above
  // residual as `active` FOR EVER, because its capacity is spent and every later run reports it as a
  // zero amount. The last period is the one that consumes the remaining capacity.
  const isLastByUnits = units > 0 && capacity - units <= 0;
  const amount = isLastByUnits ? remaining : Math.min(raw, remaining);
  const projected = nbv - amount;
  const isFinal = projected <= residual;
  return {
    assetId: asset.id,
    period: ctx.period,
    method: asset.depreciationMethod,
    amountRappen: amount,
    isFinal,
    remainingUnits: Math.max(0, capacity - units),
    projectedNbvAfterRappen: projected,
    explanation: 'assets.depreciation.explain.units_of_production',
  };
};

// `none` never depreciates; registered so the registry is the single source of truth even for it.
const nonDepreciable: MethodCalculator = (asset, ctx) =>
  zeroResult(asset, ctx.period, 'non_depreciable', 'assets.depreciation.reason.non_depreciable');

registerDepreciationMethod('straight_line', straightLine);
registerDepreciationMethod('declining_balance', decliningBalance);
registerDepreciationMethod('units_of_production', unitsOfProduction);
registerDepreciationMethod('none', nonDepreciable);

// --- The pure public engine ------------------------------------------------------------------------

/**
 * The single-period result for one asset. Never writes. The shared guards run first, in this order,
 * so a caller reads exactly one reason:
 *   1. unknown_method       - the key is not registered (impossible after H01 validation).
 *   2. non_depreciable      - method `none`.
 *   3. already_at_residual  - terminal status, or NBV already at/below residual (nothing left).
 *   4. period_already_processed - this period is not after the last one posted (H04 also guards).
 * Only then does the method calculator run against genuine remaining base.
 */
export function calculateDepreciation(asset: AssetSnapshot, context: CalcContext): DepreciationResult {
  const period = context.period;
  const method = asset.depreciationMethod;
  if (!REGISTRY.has(method)) {
    return zeroResult(asset, period, 'unknown_method', 'assets.depreciation.reason.unknown_method');
  }
  if (method === 'none') {
    return zeroResult(asset, period, 'non_depreciable', 'assets.depreciation.reason.non_depreciable');
  }
  const nbv = asset.netBookValueRappen;
  const residual = asset.residualValueRappen;
  if (
    asset.status === 'disposed' ||
    asset.status === 'archived' ||
    asset.status === 'fully_depreciated' ||
    nbv <= residual
  ) {
    return zeroResult(asset, period, 'already_at_residual', 'assets.depreciation.reason.already_at_residual');
  }
  if (asset.lastDepreciationPeriod !== null && period <= asset.lastDepreciationPeriod) {
    return zeroResult(asset, period, 'period_already_processed', 'assets.depreciation.reason.period_already_processed');
  }
  const proRata: ProRataConvention = context.proRata === 'actual_days' ? 'actual_days' : 'full_period';
  const calc = REGISTRY.get(method) as MethodCalculator;
  return calc(asset, { ...context, period, proRata });
}

/** Batch convenience used by the preview verb and by H04. Order-preserving, one result per asset. */
export function calculateDepreciationBatch(
  assets: AssetSnapshot[],
  context: CalcContext,
): DepreciationResult[] {
  return assets.map((a) => calculateDepreciation(a, context));
}

export interface ScheduleOptions {
  unitsForecast?: Record<string, number>;
  proRata?: ProRataConvention;
  /** A hard cap on the number of projected lines, so a mis-configured asset cannot loop forever. */
  maxPeriods?: number;
}

export interface ScheduleProjection {
  lines: ScheduleLine[];
  complete: boolean;
  warning?: string;
}

/**
 * Project the remaining schedule for a single asset from `fromPeriod` (inclusive) to `toPeriod`
 * (inclusive, optional). Straight-line and declining project without any external input;
 * units_of_production needs a `unitsForecast` map keyed by period, and without it returns an empty,
 * incomplete projection carrying `units_forecast_required` rather than inventing usage (§2 US-H03.6).
 *
 * The projection runs the SAME per-period engine over a rolling snapshot, so a schedule line is never
 * inconsistent with what a live preview would return, and it stops the moment a line is final (NBV has
 * reached residual). The final line residual-adjusts, so the lines sum to exactly (cost - residual).
 */
export function projectDepreciationSchedule(
  asset: AssetSnapshot,
  fromPeriod: string,
  toPeriod?: string,
  options: ScheduleOptions = {},
): ScheduleProjection {
  const lines: ScheduleLine[] = [];
  if (!isPeriod(fromPeriod)) return { lines, complete: false, warning: 'invalid_period' };
  if (toPeriod !== undefined && !isPeriod(toPeriod)) return { lines, complete: false, warning: 'invalid_period' };
  if (asset.depreciationMethod === 'units_of_production' && options.unitsForecast === undefined) {
    return { lines, complete: false, warning: 'units_forecast_required' };
  }
  const cap = options.maxPeriods ?? 1200; // 100 years of months: a sane ceiling.
  // A rolling snapshot the projection advances period by period.
  let accum = asset.accumulatedDeprRappen;
  let nbv = asset.netBookValueRappen;
  let last = asset.lastDepreciationPeriod;
  let period = fromPeriod;
  let complete = false;
  for (let i = 0; i < cap; i += 1) {
    if (toPeriod !== undefined && period > toPeriod) {
      complete = true; // reached the requested window end with base possibly remaining
      break;
    }
    const rolling: AssetSnapshot = {
      ...asset,
      accumulatedDeprRappen: accum,
      netBookValueRappen: nbv,
      lastDepreciationPeriod: last,
    };
    const unitsProduced =
      asset.depreciationMethod === 'units_of_production' ? options.unitsForecast?.[period] : undefined;
    const calcCtx: CalcContext = { period };
    if (options.proRata !== undefined) calcCtx.proRata = options.proRata;
    if (unitsProduced !== undefined) calcCtx.unitsProduced = unitsProduced;
    const res = calculateDepreciation(rolling, calcCtx);
    // A zero, non-final result at/after residual means there is nothing left to project: stop clean.
    if (res.amountRappen === 0 && (res.reason === 'already_at_residual' || res.reason === 'non_depreciable')) {
      complete = true;
      break;
    }
    accum += res.amountRappen;
    nbv = res.projectedNbvAfterRappen;
    last = period;
    lines.push({
      period,
      amountRappen: res.amountRappen,
      projectedAccumRappen: accum,
      projectedNbvRappen: nbv,
      isFinal: res.isFinal,
    });
    if (res.isFinal) {
      complete = true;
      break;
    }
    period = nextPeriod(period);
  }
  return { lines, complete };
}
