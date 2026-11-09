/**
 * D01's §H-ENUM points, one place each (spec §7). Validated at the verb boundary, never a CHECK
 * constraint, so the vocabulary lives in exactly one place and §6b's "customization can never express
 * an enum" holds by construction: a custom field is typed data, it can never widen one of these sets.
 *
 * `STOCK_REASON` is the OP2 audit-trail vocabulary an auditor reads (OR 957a orderly bookkeeping);
 * `VALUATION_METHOD` is the workspace-level Stetigkeit choice (OR 958c); `STOCKTAKE_STATUS` is the
 * OR 958c Abs. 2 Bestandesnachweis state machine, whose committed state is terminal and immutable.
 */

/** The signed direction each reason applies to the caller's magnitude. `adjust` keeps the sign given. */
export const STOCK_REASONS = ['receipt', 'issue', 'adjust', 'transfer', 'return'] as const;
export type StockReason = (typeof STOCK_REASONS)[number];
const STOCK_REASON_SET: ReadonlySet<string> = new Set(STOCK_REASONS);
export function isStockReason(x: unknown): x is StockReason {
  return typeof x === 'string' && STOCK_REASON_SET.has(x);
}

export const VALUATION_METHODS = ['fifo', 'weighted_avg'] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];
const VALUATION_METHOD_SET: ReadonlySet<string> = new Set(VALUATION_METHODS);
export function isValuationMethod(x: unknown): x is ValuationMethod {
  return typeof x === 'string' && VALUATION_METHOD_SET.has(x);
}

export const STOCKTAKE_STATUSES = ['open', 'committed', 'cancelled'] as const;
export type StocktakeStatus = (typeof STOCKTAKE_STATUSES)[number];
const STOCKTAKE_STATUS_SET: ReadonlySet<string> = new Set(STOCKTAKE_STATUSES);
export function isStocktakeStatus(x: unknown): x is StocktakeStatus {
  return typeof x === 'string' && STOCKTAKE_STATUS_SET.has(x);
}
