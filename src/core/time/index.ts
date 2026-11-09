/**
 * B01, time tracking: the barrel `src/api/` imports from.
 *
 * Importing this barrel also registers B01's rows in B00's close-guard and cost-source seams
 * (`./seams.js`, side-effecting at load, the `tick.ts` tick-source shape).
 */

import './seams.js';

export {
  timeStart,
  timeStop,
  timeLog,
  timeUpdate,
  timeDelete,
  timeSubmit,
  timeApprove,
  timeLock,
  timeList,
  readTimeEntry,
  mapTimeEntry,
  entryValueMinor,
} from './time.js';
export type { TimeEntryRow, TimeStartInput, TimeLogInput, TimeEntryPatch, TimeListFilter, TimePeriodInput } from './time.js';
export {
  rateCardUpsert,
  rateCardEnd,
  rateCardList,
  resolveRate,
  timeResolveRate,
  mapRateCard,
} from './rates.js';
export type { RateCardRow, RateCardUpsertInput, ResolveRateInput, ResolvedRate } from './rates.js';
export {
  TIME_STATUSES,
  TIME_TRANSITIONS,
  EDITABLE_TIME_STATUSES,
  RATE_CARD_SCOPES,
  isTimeStatus,
  isLegalTimeTransition,
  isRateCardScope,
} from './enums.js';
export type { TimeStatus, RateCardScope } from './enums.js';
export { TIME_SCHEMA_SQL } from './schema.js';
