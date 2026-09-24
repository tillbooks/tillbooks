/**
 * I03, the PURE landed-cost allocator (OP12-style). No `ctx`, no database, no clock: it takes a
 * voucher total and a set of targets and returns exactly how the total splits across them. That is
 * the whole point of the split, exactly as J03's `valuation.ts` keeps its money arithmetic pure so it
 * can be read and refuted without a store in scope.
 *
 * THE THREE RULES THAT MAKE THIS A MONEY-PATH FUNCTION (spec §4):
 *  (1) NO FLOATING POINT DECIDES A RAPPEN. Every allocated figure is produced by an exact
 *      largest-remainder split over integer weights, so the parts sum to the total to the Rappen by
 *      construction. `share` is a float for DISPLAY only and never feeds an allocated amount.
 *  (2) RESIDUAL IS ALWAYS ZERO. The largest-remainder distribution hands the Rappen that flooring
 *      dropped to the largest fractional remainders, so `Σ allocatedMinor === totalCostMinor` exactly,
 *      for every method and every input. A non-zero residual is a bug, not a rounding fact.
 *  (3) A METHOD THAT CANNOT BE COMPUTED FALLS BACK OR REFUSES, never guesses. by_weight / by_volume
 *      with a missing or zero attribute on any target warns and falls back to by_value; manual shares
 *      that do not sum to 1 are refused. There is no silent "value it at zero and move on".
 *
 * Signs: a positive total is an allocation (adds cost); this allocator only distributes magnitudes.
 * The reverse path negates the confirmed amounts directly and never re-runs the allocator, so a
 * reversal cannot drift from what it reverses.
 */

export const ALLOCATION_METHODS = ['by_value', 'by_qty', 'by_weight', 'by_volume', 'equal', 'manual'] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];
const METHOD_SET: ReadonlySet<string> = new Set(ALLOCATION_METHODS);
export function isAllocationMethod(x: unknown): x is AllocationMethod {
  return typeof x === 'string' && METHOD_SET.has(x);
}

export const COMPONENT_TYPES = ['freight', 'duty', 'insurance', 'handling', 'brokerage', 'other'] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];
const COMPONENT_SET: ReadonlySet<string> = new Set(COMPONENT_TYPES);
export function isComponentType(x: unknown): x is ComponentType {
  return typeof x === 'string' && COMPONENT_SET.has(x);
}

/** One target of an allocation, reduced to the numbers the split needs. All integers. */
export interface AllocatorTarget {
  id: string;
  itemId: string;
  originalMovementId: string;
  /** qty x receipt unit cost, in Rappen. The by_value weight. */
  baseValueMinor: number;
  /** whole units received on this line. The by_qty weight, and the denominator of unit impact. */
  baseQty: number;
  /** Relative integer weight for by_weight (grams, say). Missing / 0 triggers the fallback. */
  weightMilli?: number | null;
  /** Relative integer weight for by_volume (cm3, say). Missing / 0 triggers the fallback. */
  volumeMilli?: number | null;
}

export interface AllocationPreviewLine {
  targetId: string;
  itemId: string;
  originalMovementId: string;
  baseValueMinor: number;
  baseQty: number;
  /** 0..1, DISPLAY only (rule 1): never an input to `allocatedMinor`. */
  share: number;
  allocatedMinor: number;
  /** allocatedMinor / baseQty, commercial-rounded for display. 0 when baseQty is 0. */
  unitImpactMinor: number;
}

export interface AllocationInput {
  totalCostMinor: number;
  method: AllocationMethod;
  /** For `manual`: per target id, the fractional share (0..1), summing to 1 within 1e-6. */
  manualShares?: Record<string, number>;
}

export interface AllocationPreview {
  method: AllocationMethod;
  /** The method the amounts were ACTUALLY computed under (a fallback swaps this to `by_value`). */
  effectiveMethod: AllocationMethod;
  totalCostMinor: number;
  lines: AllocationPreviewLine[];
  residualMinor: number;
  warnings: string[];
}

/** Commercial rounding (half away from zero) of an exact bigint ratio, P2. Matches valuation.ts. */
function commercialRound(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0;
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const rounded = (2n * abs + d) / (2n * d);
  return Number(negative ? -rounded : rounded);
}

/**
 * Split `total` across `weights` so the parts sum to EXACTLY `total` (largest remainder). Each part
 * gets the floor of its exact share and the Rappen the flooring dropped go to the largest fractional
 * remainders, ties broken by position so the result is deterministic. This is the guarantee behind
 * "residual is always zero": rounding each share on its own would leave the parts summing to something
 * other than the whole.
 */
function allocateExactly(total: number, weights: readonly number[]): number[] {
  const positive = weights.map((w) => (w > 0 ? w : 0));
  const totalWeight = positive.reduce((s, w) => s + w, 0);
  if (totalWeight === 0 || total === 0) return weights.map(() => 0);

  const T = BigInt(total);
  const W = BigInt(totalWeight);
  const floors = positive.map((w) => (T * BigInt(w)) / W);
  const remainders = positive.map((w, i) => ({ i, rem: T * BigInt(w) - (floors[i] as bigint) * W }));
  let left = T - floors.reduce((s, f) => s + f, 0n);
  remainders.sort((a, b) => (b.rem === a.rem ? a.i - b.i : b.rem > a.rem ? 1 : -1));
  const out = floors.map((f) => Number(f));
  for (const { i } of remainders) {
    if (left <= 0n) break;
    out[i] = (out[i] as number) + 1;
    left -= 1n;
  }
  return out;
}

/** The weights this method distributes by, plus any warning and whether it fell back. */
function weightsFor(
  method: AllocationMethod,
  targets: readonly AllocatorTarget[],
  manualShares: Record<string, number> | undefined,
): { weights: number[]; effectiveMethod: AllocationMethod; warnings: string[]; error?: string } {
  const warnings: string[] = [];
  switch (method) {
    case 'by_value':
      return { weights: targets.map((t) => t.baseValueMinor), effectiveMethod: 'by_value', warnings };
    case 'by_qty':
      return { weights: targets.map((t) => t.baseQty), effectiveMethod: 'by_qty', warnings };
    case 'equal':
      return { weights: targets.map(() => 1), effectiveMethod: 'equal', warnings };
    case 'by_weight': {
      const missing = targets.some((t) => t.weightMilli === undefined || t.weightMilli === null || t.weightMilli <= 0);
      if (missing) {
        warnings.push('missing_weight');
        return { weights: targets.map((t) => t.baseValueMinor), effectiveMethod: 'by_value', warnings };
      }
      return { weights: targets.map((t) => t.weightMilli as number), effectiveMethod: 'by_weight', warnings };
    }
    case 'by_volume': {
      const missing = targets.some((t) => t.volumeMilli === undefined || t.volumeMilli === null || t.volumeMilli <= 0);
      if (missing) {
        warnings.push('missing_volume');
        return { weights: targets.map((t) => t.baseValueMinor), effectiveMethod: 'by_value', warnings };
      }
      return { weights: targets.map((t) => t.volumeMilli as number), effectiveMethod: 'by_volume', warnings };
    }
    case 'manual': {
      if (manualShares === undefined) return { weights: [], effectiveMethod: 'manual', warnings, error: 'manual_shares_required' };
      let sum = 0;
      for (const t of targets) {
        const s = manualShares[t.id];
        if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) {
          return { weights: [], effectiveMethod: 'manual', warnings, error: 'invalid_manual_share' };
        }
        sum += s;
      }
      if (Math.abs(sum - 1) > 1e-6) return { weights: [], effectiveMethod: 'manual', warnings, error: 'manual_shares_must_sum_to_one' };
      // Scale each share to an integer weight; the largest-remainder split then forces the exact
      // total onto the last Rappen, so a share of 1/3 does not strand a Rappen no target owns.
      const weights = targets.map((t) => Math.round((manualShares[t.id] as number) * 1_000_000_000));
      return { weights, effectiveMethod: 'manual', warnings };
    }
    default:
      return { weights: [], effectiveMethod: method, warnings, error: 'unknown_method' };
  }
}

/**
 * Distribute a landed-cost voucher's total across its targets. NEVER writes, deterministic: the same
 * inputs produce the same preview every time. Returns `{ error }` for an input it cannot allocate
 * (empty targets, zero total, a bad manual-share set), so the confirm path can refuse before it posts.
 */
export function allocate(
  input: AllocationInput,
  targets: readonly AllocatorTarget[],
): AllocationPreview | { error: string } {
  if (!isAllocationMethod(input.method)) return { error: 'unknown_method' };
  if (!Number.isInteger(input.totalCostMinor) || input.totalCostMinor <= 0) return { error: 'invalid_amount' };
  if (targets.length === 0) return { error: 'nothing_to_allocate' };

  const w = weightsFor(input.method, targets, input.manualShares);
  if (w.error !== undefined) return { error: w.error };

  const totalWeight = w.weights.reduce((s, x) => s + (x > 0 ? x : 0), 0);
  // Every weight zero (every base value zero under by_value, say) cannot be split by ratio, so fall
  // back to an equal split rather than refusing: the cost is real and has to land somewhere.
  const weights = totalWeight === 0 ? targets.map(() => 1) : w.weights;
  const warnings = totalWeight === 0 ? [...w.warnings, 'fallback_equal'] : w.warnings;

  const allocated = allocateExactly(input.totalCostMinor, weights);
  const allocatedSum = allocated.reduce((s, x) => s + x, 0);
  const effectiveTotalWeight = weights.reduce((s, x) => s + (x > 0 ? x : 0), 0);

  const lines: AllocationPreviewLine[] = targets.map((t, i) => {
    const alloc = allocated[i] as number;
    const weight = weights[i] as number;
    return {
      targetId: t.id,
      itemId: t.itemId,
      originalMovementId: t.originalMovementId,
      baseValueMinor: t.baseValueMinor,
      baseQty: t.baseQty,
      share: effectiveTotalWeight === 0 ? 0 : (weight > 0 ? weight : 0) / effectiveTotalWeight,
      allocatedMinor: alloc,
      unitImpactMinor: t.baseQty > 0 ? commercialRound(BigInt(alloc), BigInt(t.baseQty)) : 0,
    };
  });

  return {
    method: input.method,
    effectiveMethod: w.effectiveMethod,
    totalCostMinor: input.totalCostMinor,
    lines,
    residualMinor: input.totalCostMinor - allocatedSum,
    warnings,
  };
}
