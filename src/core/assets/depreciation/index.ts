/**
 * H03, the depreciation engine barrel. The pure calculators (OP12) and the ctx-facing verbs, kept
 * separate: `engine.ts` never touches the store, `service.ts` marshals the store in and out.
 */

export {
  calculateDepreciation,
  calculateDepreciationBatch,
  projectDepreciationSchedule,
  registerDepreciationMethod,
  hasDepreciationMethod,
  registeredMethods,
  isPeriod,
  nextPeriod,
  daysInPeriod,
} from './engine.js';
export type { ScheduleOptions, ScheduleProjection } from './engine.js';

export {
  listDepreciationMethods,
  setMethodEnabled,
  previewDepreciation,
  scheduleDepreciation,
} from './service.js';
export type { SetMethodEnabledInput, PreviewInput, ScheduleInput } from './service.js';

export { DEPRECIATION_SCHEMA_SQL } from './schema.js';

export type {
  DepreciationMethod,
  ProRataConvention,
  AssetSnapshot,
  CalcContext,
  DepreciationResult,
  ScheduleLine,
  MethodDescriptor,
} from './types.js';
