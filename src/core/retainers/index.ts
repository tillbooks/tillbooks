/**
 * B04, retainers & mandates: the barrel `src/api/` imports from. Two files, disjoint from B01's
 * `time/` and B02's `billing/`: the agreement CRUD (`retainers.ts`) and the money-touching
 * generation + burn-down (`draws.ts`). B04 posts nothing (P3): generation delegates to A10
 * `createDocument`, and A11 -> A02 own the only journal entry, at issue.
 */

export {
  createRetainer,
  updateRetainer,
  closeRetainer,
  listRetainers,
  readRetainer,
  pendingPeriods,
  mapRetainer,
} from './retainers.js';
export type {
  RetainerRow,
  RetainerCreateInput,
  RetainerUpdateInput,
  RetainerCloseInput,
  RetainerListFilter,
} from './retainers.js';
export { generateInvoice, runDue, burnDown, computeCoverage } from './draws.js';
export type { GenerateInvoiceInput, RunDueInput, BurnDownInput } from './draws.js';
export {
  RETAINER_PERIODS,
  RETAINER_STATUSES,
  RETAINER_DRAW_KINDS,
  isRetainerPeriod,
  isRetainerStatus,
  isRetainerDrawKind,
} from './enums.js';
export type { RetainerPeriod, RetainerStatus, RetainerDrawKind } from './enums.js';
export {
  isPeriodKey,
  periodKeyOf,
  periodStart,
  periodEndExclusive,
  nextPeriodKey,
  periodHasEnded,
} from './periods.js';
export { RETAINER_SCHEMA_SQL } from './schema.js';
