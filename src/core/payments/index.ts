/**
 * A14, payments and matching: the settlement half of the money path.
 *
 * The public surface is deliberately narrow. THREE verbs write (`recordPayment`, `allocatePayment`,
 * `reversePayment`) and they are the only writers of `payment`, `payment_allocation`, and of any
 * journal entry a settlement produces (Pattern P3). Everything else here reads.
 *
 * `planPayment` is exported because the P3 guard test asserts on this surface, and because the two
 * faces of the money math (the read-only preview and the write) must demonstrably be one function.
 * It writes nothing.
 */

export {
  recordPayment,
  allocatePayment,
  reversePayment,
  previewPayment,
  getPayment,
  listPayments,
  planPayment,
  documentSettlement,
  setWriteOffThreshold,
  PAYMENT_INTENTS,
  documentReferences,
  settledMinor,
  writeOffThresholdOf,
  PAYMENT_DIRECTIONS,
  PAYMENT_STATUSES,
  PAYMENT_SOURCES,
  PAYMENT_LIST_CEILING,
  ALLOCATION_TARGET_KINDS,
  COUNTERPARTY_KINDS,
  DEFAULT_WRITE_OFF_THRESHOLD_MINOR,
  SETTLEABLE_STATUSES,
} from './payment.js';
export type {
  AllocationInput,
  RecordPaymentInput,
  AllocatePaymentInput,
  ReversePaymentInput,
  PaymentDirection,
  PaymentStatus,
  PaymentPlan,
  PlannedRow,
  PaymentLeg,
  AllocationTargetKind,
  CounterpartyKind,
  MatchKind,
} from './payment.js';

export { suggestPaymentMatches } from './matching.js';
export type { SuggestMatchesInput } from './matching.js';

export {
  classifyReference,
  formatReference,
  buildQrrReference,
  buildScorReference,
  isValidQrrReference,
  isValidScorReference,
  mod10RecursiveCheckDigit,
  iso11649CheckDigits,
} from './reference.js';
export type { ClassifiedReference, ReferenceKind } from './reference.js';

export { PAYMENT_SCHEMA_SQL } from './schema.js';
export { ROLE_ACCOUNT_NUMBER, vatRoleFor } from './accounts.js';
export type { AccountRole } from './accounts.js';
