/**
 * A15, Mahnwesen: multi-level dunning over A16's open items, the reminder letter with its
 * per-invoice QR payment parts, and the optional booked Mahngebühr.
 */

export {
  getDunningConfig,
  setDunningConfig,
  dunningLevelsOf,
  DEFAULT_DUNNING_LEVELS,
  DUNNING_LEVELS,
  DUNNING_RUN_STATUSES,
  INTEREST_FLOOR_BP,
} from './config.js';
export type { DunningLevelConfig, DunningRunStatus, SetDunningConfigInput } from './config.js';

export {
  proposeDunningRun,
  issueDunningRun,
  sendDunningRun,
  interestNoteMinor,
  dunningEmailSubject,
  DUNNING_SOURCE,
} from './run.js';
export type { ProposeDunningRunInput, IssueDunningRunInput, SendDunningRunInput } from './run.js';

export { renderDunningPdf, letterTitle } from './pdf.js';
export type { RenderDunningPdfInput } from './pdf.js';

export { listDunningRuns, getDunningRun, DUNNING_RUN_LIST_CEILING } from './reads.js';
export type { ListDunningRunsInput, GetDunningRunInput } from './reads.js';

// THE shared "is this booked fee LIVE" predicate (critic C1/C2, A14's dunning-fee target): A14's
// settlement planner and A16's open-item read model both import this rather than each keeping its
// own definition of a live fee.
export { liveDunningFeeItemsAsOf, readLiveDunningFeeItem, dunningFeeLabel } from './reads.js';
export type { LiveDunningFeeItem } from './reads.js';

export { DUNNING_SCHEMA_SQL } from './schema.js';
