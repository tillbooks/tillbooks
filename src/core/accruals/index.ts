/**
 * A38, Abgrenzungen, Rückstellungen und MWST-Saldierung: the public surface of the module.
 *
 * N2 owns `accrual.ts`, `provision.ts`, `taxProvision.ts`, `lines.ts` and `schema.ts`; N3 adds
 * `vatSettlement.ts` and `annualReconciliation.ts` and re-exports them from here in a block of its
 * own below this one.
 */

export {
  ACCRUAL_KINDS,
  ACCRUAL_KIND_RULES,
  ACCRUAL_STATUSES,
  PROVISION_REASONS,
  PROVISION_STATUSES,
  SONSTIGE_MIN_DESCRIPTION,
  ACTIVE_ACCRUAL_ACCOUNT,
  PASSIVE_ACCRUAL_ACCOUNT,
  SHORT_TERM_PROVISION_ACCOUNT,
  LONG_TERM_PROVISION_ACCOUNT,
  DIRECT_TAX_ACCOUNT,
  ACCRUAL_SOURCE,
  PROVISION_SOURCE,
  accrualLinesOf,
  mirrorLinesOf,
  provisionLinesOf,
  releaseLinesOf,
  firstDayAfter,
  isAccrualKind,
  isProvisionReason,
} from './lines.js';
export type { AccrualKind, AccrualKindRule, AccrualStatus, ProvisionReason, ProvisionStatus, LineView } from './lines.js';

export { accrualCreate, accrualGet, accrualList, accrualDiscard, accrualPost, accrualReverse } from './accrual.js';
export type {
  AccrualView,
  AccrualCreateInput,
  AccrualIdInput,
  AccrualListInput,
  AccrualDiscardInput,
  AccrualPostInput,
  AccrualPostOk,
  AccrualReverseInput,
  AccrualReverseOk,
} from './accrual.js';

export {
  provisionCreate,
  provisionGet,
  provisionList,
  provisionDiscard,
  provisionPost,
  provisionRelease,
  provisionReleaseReverse,
  provisionReverse,
} from './provision.js';
export type {
  ProvisionView,
  ReleaseView,
  ProvisionCreateInput,
  ProvisionIdInput,
  ProvisionListInput,
  ProvisionDiscardInput,
  ProvisionPostInput,
  ProvisionReleaseInput,
  ProvisionReleaseOk,
  ProvisionReleaseReverseInput,
  ProvisionReleaseReverseOk,
  ProvisionReverseInput,
} from './provision.js';

export { taxProvisionPreview, fiscalYearStartFor, grossTaxProvisionMinor, DEFAULT_TAX_RATE_BP } from './taxProvision.js';
export type { TaxProvisionPreviewInput } from './taxProvision.js';

export { ACCRUALS_SCHEMA_SQL } from './schema.js';

// A38, MWST-Saldierung und Abstimmung.
export {
  settlementModelOf,
  vatSettlementPreview,
  vatSettlementPost,
  vatSettlementReverse,
  vatSettlementList,
  VAT_SETTLEMENT_TARGET_ACCOUNT,
  SALDO_TAX_ACCOUNT,
  VAT_SETTLEMENT_STATUSES,
} from './vatSettlement.js';
export type {
  VatSettlementModel,
  VatSettlementLine,
  VatSettlementLineRole,
  VatSettlementRow,
  VatSettlementPreviewInput,
  VatSettlementPostInput,
  VatSettlementReverseInput,
  VatSettlementListInput,
} from './vatSettlement.js';
export { vatAnnualReconciliation } from './annualReconciliation.js';
export type { VatAnnualReconciliationInput, ReconciliationAdjustment, ReconciliationStatus } from './annualReconciliation.js';
export { VAT_SETTLEMENT_SCHEMA_SQL } from './vatSettlementSchema.js';
