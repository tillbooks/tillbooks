/**
 * B03, job costing / project P&L: the barrel `src/api/` imports from.
 *
 * A PURE READ MODEL (P5): no schema file, no writes, no events. The four verbs recompute the
 * project P&L from B00/B01/B02/A11 rows on every call; see `costing.ts` for what is computable
 * today and what degrades honestly.
 */

export { costingProjectPl, costingPlList, costingBudgetVsActual, costingDrilldown } from './costing.js';
export type { ProjectPlInput, PlListInput, BudgetVsActualInput, DrilldownInput } from './costing.js';
export {
  COSTING_COMPONENTS,
  COSTING_BASES,
  UNATTRIBUTABLE_COMPONENTS,
  isCostingComponent,
  isCostingBasis,
} from './enums.js';
export type { CostingComponent, CostingBasis } from './enums.js';
