/**
 * H03, the depreciation engine's shared shapes.
 *
 * These interfaces are the CONTRACT H04 posts against: the amounts `calculateDepreciation` returns are
 * exactly the figures the period-end run will book, so any change to a field's meaning here is a
 * breaking change to the money path and must move the golden fixtures with it (§8). Everything is
 * integer Rappen (P2); there is no float on this path.
 */

/** The registered depreciation methods (§H-ENUM). Re-exported from H00's category module so the two
 * cannot drift; H03 adds no method key of its own beyond the four Phase-1 built-ins. */
export type DepreciationMethod =
  | 'straight_line'
  | 'declining_balance'
  | 'units_of_production'
  | 'none';

/** How a partial first/last period is charged. `full_period` ignores the calendar and charges a whole
 * month (the default); `actual_days` scales by days-in-service / days-in-period. */
export type ProRataConvention = 'full_period' | 'actual_days';

/**
 * The self-contained view of an asset a pure calculator needs. The engine NEVER reads the database:
 * the caller (the preview/schedule verbs, or H04) supplies this snapshot, which is what makes the
 * calculators referentially transparent and safe to call concurrently.
 */
export interface AssetSnapshot {
  id: string;
  workspaceId: string;
  status: string;
  acquisitionDate: string; // ISO date YYYY-MM-DD
  acquisitionCostRappen: number; // > 0
  residualValueRappen: number; // >= 0, the RESOLVED absolute residual
  usefulLifeMonths: number | null;
  depreciationMethod: string;
  /** Basis points per annum, e.g. 2000 = 20% p.a. Required for declining_balance. */
  decliningRateBp?: number | null;
  /** Required for units_of_production. */
  totalEstimatedUnits?: number | null;
  accumulatedDeprRappen: number;
  netBookValueRappen: number;
  lastDepreciationPeriod: string | null; // 'YYYY-MM'
}

/** The per-call context: the period being calculated plus method-specific inputs. */
export interface CalcContext {
  period: string; // 'YYYY-MM'
  proRata?: ProRataConvention;
  /** Units produced in THIS period, required for units_of_production. */
  unitsProduced?: number;
  /** For actual_days on a first/last partial period. */
  daysInService?: number;
}

/** The deterministic result of one period's calculation for one asset. */
export interface DepreciationResult {
  assetId: string;
  period: string;
  method: string;
  amountRappen: number; // >= 0, integer
  isFinal: boolean; // this period brings NBV to residual
  remainingLifeMonths?: number;
  remainingUnits?: number;
  projectedNbvAfterRappen: number; // always >= residual
  reason?: string; // e.g. already_at_residual | missing_production_data | period_already_processed | non_depreciable | unknown_method
  /** An i18n key the Studio resolves; never a hardcoded human sentence (§6). */
  explanation: string;
}

/** One line of a projected forward schedule. */
export interface ScheduleLine {
  period: string;
  amountRappen: number;
  projectedAccumRappen: number;
  projectedNbvRappen: number;
  isFinal: boolean;
}

/** What `listDepreciationMethods` returns per method (registry + workspace enablement). */
export interface MethodDescriptor {
  key: DepreciationMethod;
  labelKey: string;
  descriptionKey: string;
  requiresUnits: boolean;
  requiresRate: boolean;
  enabled: boolean;
}
