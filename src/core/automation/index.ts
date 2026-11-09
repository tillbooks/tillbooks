/**
 * G01, automation rules: the one trigger -> condition -> action engine, and the only place in this
 * repo where a write happens without a person or an agent asking for it at that moment.
 *
 * The barrel is what `src/api/` imports from. Nothing outside this directory reaches a file inside it.
 */

export {
  AUTOMATION_EVENTS,
  AUTOMATION_EVENT_IDS,
  automationEventDef,
  eventsEmittedBy,
  isScheduleEvent,
  registerWriteActions,
  registeredWriteActions,
  isRegisteredWriteAction,
  automationActionsConfigured,
  readPath,
} from './events.js';
export type { AutomationEventDef } from './events.js';

export { CONDITION_OPS, validateCondition, conditionHolds, resolveTemplate } from './condition.js';

export {
  MAX_CASCADE_DEPTH,
  RUN_STATUSES,
  dispatchAutomationEvent,
  evaluateAndFire,
  isSelfTriggering,
  retryAutomationRun,
} from './fire.js';
export type { ActionInvoker, AutomationEvent, FireOutcome, RuleRow } from './fire.js';

export {
  createAutomationRule,
  updateAutomationRule,
  enableAutomationRule,
  disableAutomationRule,
  archiveAutomationRule,
  getAutomationRule,
  listAutomationRules,
} from './rules.js';
export type { AutomationRuleView } from './rules.js';

export { runDueAutomations, TICK_SOURCES } from './tick.js';
export type { TickSource } from './tick.js';

export { listAutomationRuns, getAutomationRun } from './runs.js';
export type { AutomationRunView } from './runs.js';

export { AUTOMATION_SCHEMA_SQL } from './schema.js';
