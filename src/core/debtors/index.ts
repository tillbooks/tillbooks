/**
 * A16, Debitoren (open items, aging, receivables reconciliation).
 *
 * A pure read model over A11's documents and A14's allocations, plus one workspace-scoped view
 * preference. Nothing here posts, and nothing here writes a document status.
 */

export {
  listOpenItems,
  customerBalance,
  agingReport,
  getAgingBucketConfig,
  setAgingBucketConfig,
  agingBoundariesOf,
  receivablesBalanceAsOf,
  bucketKeys,
  DEFAULT_AGING_BOUNDARIES,
} from './openItems.js';

export type {
  OpenItem,
  OpenItemDirection,
  ListOpenItemsInput,
  CustomerBalanceInput,
  AgingReportInput,
  SetAgingBucketConfigInput,
} from './openItems.js';

export { DEBTORS_SCHEMA_SQL } from './schema.js';
