/** D185, the settlement socket: the public surface of `src/core/settlement/`. */
export {
  SETTLEMENT_SCHEMA,
  SETTLEMENT_KINDS,
  SETTLEMENT_MAX_EVENTS,
  SETTLEMENT_EVENT_REFUSALS,
  parseExactMinor,
  isSettlementDay,
  normalizeSourceName,
  readSettlementDocument,
} from './format.js';
export type { SettlementKind, SettlementEvent, RefusedSettlementEvent, SettlementDocument } from './format.js';
export {
  TEMPLATE_ACTIONS,
  TEMPLATE_KIND_DEFAULTS,
  BOOKABLE_TAX_KINDS,
  setSettlementTemplate,
  prevalidateSetSettlementTemplate,
  getSettlementTemplate,
  readStoredTemplate,
} from './template.js';
export type { KindRule, SettlementTemplate, SetSettlementTemplateOk, GetSettlementTemplateOk } from './template.js';
export {
  importSettlement,
  prevalidateImportSettlement,
  SETTLEMENT_MAX_BYTES,
  SETTLEMENT_MAX_ATTACHMENTS,
  SETTLEMENT_ATTACHMENTS_MAX_BYTES,
  SETTLEMENT_OUTCOME_TEXT,
} from './importSettlement.js';
export type { ImportSettlementOk, ImportSettlementInput, SettlementEventOutcome, KindTotals } from './importSettlement.js';
export { SETTLEMENT_SCHEMA_SQL } from './schema.js';
