/**
 * A26, agent bookkeeping: the dial, the drafted-action inbox, and the three convenience reads.
 *
 * A26 adds NO new financial verb: it composes the existing ones (A02/A07/A08/A16/A17) under one
 * agent surface, adds the approval-gate DIAL (`decideAction` + `agent_dial`), and adds the inbox
 * (`agent_action`) where a drafted write waits for a human. The barrel is the only thing `src/api/`
 * imports from.
 */

export {
  DIAL_CAPABILITIES,
  STRONG_DEFAULT_ASK_CAPABILITIES,
  isDialCapability,
  decideAction,
  dialCapabilityIsForceAsk,
  readDialLevel,
  effectiveDialLevel,
  writeDialLevel,
  getAgentDial,
  setAgentDial,
} from './dial.js';
export type { DialLevel, DialResolution, DecideInput, Decision, DecideMode, SetAgentDialInput } from './dial.js';

export {
  enqueueDraftedAction,
  listDraftedActions,
  approveDraftedAction,
  rejectDraftedAction,
  REJECT_REASON_MAX_LENGTH,
} from './draftedActions.js';
export type {
  EnqueueDraftedActionInput,
  ListDraftedActionsInput,
  ResolveDraftedActionInput,
} from './draftedActions.js';

export {
  resolveAgentSession,
  recordAgentCall,
  recordProseTurn,
  insertCall,
  backfillDraftingCall,
  entityRefOf,
  pruneAgentTrace,
  listAgentSessions,
  getAgentSession,
  agentProseDelete,
} from './trace.js';
export type {
  RecordCallInput,
  ListAgentSessionsInput,
  GetAgentSessionInput,
  AgentProseDeleteInput,
} from './trace.js';

export { agentTrustSummary } from './trust.js';
export type { AgentTrustSummaryInput, TrustRow } from './trust.js';

export { agentAsk } from './ask.js';
export type { AgentAskInput } from './ask.js';

export { DIAL_CAPABILITY_FOR_ACTION, CONSEQUENCE_FOR_ACTION, INPUT_KEYED_DIAL_RULES, dialCapabilityForCall } from './dialMap.js';
export type { InputKeyedDialRule } from './dialMap.js';

export {
  SESSION_IDLE_MINUTES,
  TURN_GAP_SECONDS,
  TRACE_RETENTION_MONTHS,
  TRUST_WINDOW_DAYS,
  TRUST_SUGGEST_THRESHOLD,
} from './constants.js';

export { ledgerQa, classifyQuestion } from './ledgerQa.js';
export type { LedgerQaInput } from './ledgerQa.js';

export { monthEndChecklist } from './checklist.js';
export type { MonthEndChecklistInput, ChecklistItem } from './checklist.js';

export { detectAnomalies } from './anomalies.js';
export type { DetectAnomaliesInput, Anomaly } from './anomalies.js';

export { reviewSeam } from './reviewSeam.js';
export type { ReviewSeam } from './reviewSeam.js';

export { AGENT_SCHEMA_SQL } from './schema.js';
