/**
 * C01, leads & deals: the barrel `src/api/` imports from.
 */

export {
  createDeal,
  updateDeal,
  moveDeal,
  markDeal,
  logDealActivity,
  listDeals,
  dealToQuote,
  readDeal,
  weightedMinor,
} from './deals.js';
export type { CreateDealInput, DealPatch, MarkDealInput, LogDealActivityInput, ListDealsFilter, DealInvoker, DealRow } from './deals.js';

export {
  upsertPipeline,
  upsertPipelineStage,
  ensureDefaultPipeline,
  firstOpenStage,
  outcomeStage,
  listStages,
  readPipeline,
  readStage,
} from './pipelines.js';
export type { UpsertPipelineInput, UpsertStageInput, PipelineRow, StageRow } from './pipelines.js';

export { DEAL_STATUSES, isDealStatus, STAGE_OUTCOMES, isStageOutcome } from './enums.js';
export type { DealStatus, StageOutcome } from './enums.js';

export { QUOTE_CREATE_TOOL, buildQuoteInput, quoteIdOf } from './quoteSeam.js';
export type { QuoteSeed } from './quoteSeam.js';

export { DEALS_SCHEMA_SQL } from './schema.js';
