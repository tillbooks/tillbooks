export {
  BTC_QR_BILL_INCOMING,
  BTC_DIRECT_DEBIT_COLLECTED,
  BTC_DIRECT_DEBIT_PAID,
  BTC_REVERSALS,
  formatBtc,
  btcEquals,
  isReversalBtc,
} from './bankTransactionCodes.js';
export type { BankTransactionCode, BtcClassification, BtcConfidence } from './bankTransactionCodes.js';

// A19, the bank-account register.
export {
  QR_IID_MIN,
  QR_IID_MAX,
  OPENING_BALANCE_ACCOUNT_NUMBER,
  validateIban,
  createBankAccount,
  updateBankAccount,
  setBankOpeningBalance,
  previewBankOpeningBalance,
  archiveBankAccount,
  unarchiveBankAccount,
  listBankAccounts,
  getBankAccount,
} from './bankAccounts.js';
export type {
  BankAccountRow,
  BankAccountView,
  CreateBankAccountInput,
  UpdateBankAccountInput,
  SetBankOpeningBalanceInput,
  PreviewBankOpeningBalanceInput,
  PreviewBankOpeningBalanceOk,
  PreviewOpeningLine,
} from './bankAccounts.js';
export { BANKING_SCHEMA_SQL } from './schema.js';

// A21, QR incoming-payment matching.
export {
  QR_MATCH_CONFIDENCES,
  QR_MATCH_REASONS,
  QR_MATCH_STATUSES,
  QR_APPLY_MODES,
  QR_OVERRIDE_ACTIONS,
  qrAutoApplyEnabled,
  recordIncomingCredit,
  matchIncomingByQrr,
  applyQrMatch,
  overrideQrMatch,
  listUnmatchedIncoming,
  setQrAutoApply,
} from './qrMatch.js';
export type {
  QrMatchConfidence,
  QrMatchReason,
  QrMatchStatus,
  QrMatchScore,
  QrCreditView,
  RecordIncomingCreditInput,
  RecordIncomingCreditOk,
  MatchQrPaymentInput,
  MatchQrPaymentOk,
  ApplyQrMatchInput,
  ApplyQrMatchOk,
  OverrideQrMatchInput,
  OverrideQrMatchOk,
  ListUnmatchedIncomingInput,
  SetQrAutoApplyInput,
  SetQrAutoApplyOk,
} from './qrMatch.js';
export { QR_MATCH_SCHEMA_SQL } from './qrMatchSchema.js';

// A20, camt reconciliation.
export { parseCamt } from './camt.js';
export type {
  CamtMessageType,
  CamtCreditDebit,
  CamtReferenceKind,
  CamtClassification,
  ParsedCamtEntry,
  ParsedCamtStatement,
  ParseCamtResult,
} from './camt.js';
export {
  importCamt,
  suggestCamtMatches,
  confirmCamtMatch,
  createEntryForTxn,
  listReconciliation,
  listBankStatements,
  reviewBankTxn,
  setCamtMatching,
  readCamtMatchConfig,
} from './camtReconcile.js';
export type {
  ImportCamtInput,
  ImportCamtOk,
  CamtMatchProposal,
  CamtMatchSignal,
  CamtMatchConfig,
  CamtTxnProposal,
  ReviewBankTxnInput,
  ReviewBankTxnOk,
  SetCamtMatchingInput,
  SuggestCamtMatchesInput,
  ConfirmCamtMatchAllocation,
  ConfirmCamtMatchInput,
  ConfirmCamtMatchOk,
  CreateEntryForTxnInput,
  CreateEntryForTxnOk,
  ListReconciliationInput,
  ListReconciliationOk,
  ListBankStatementsInput,
  ListBankStatementsOk,
  BankStatementSummary,
  CamtTxnStatus,
  CamtTxnView,
} from './camtReconcile.js';
export { CAMT_SCHEMA_SQL } from './camtSchema.js';

// A18, creditor payments: select A17's open items, generate a pain.001, mark paid via A14.
export {
  PAYMENT_BATCH_STATUSES,
  minorToDecimalString,
  decimalStringToMinor,
  escapeXmlText,
  toReferenceSafe,
  swissBcNumberFromIban,
  setCreditorBankProfile,
  listPayableOpenItems,
  createPaymentBatch,
  generatePain001,
  validatePain001,
  getPaymentBatch,
  listPaymentBatches,
  markBatchPaid,
  discardPaymentBatch,
} from './pain001.js';
export type {
  PaymentBatchStatus,
  SetCreditorBankProfileInput,
  ListPayableOpenItemsInput,
  CreatePaymentBatchInput,
  GeneratePain001Input,
  ListPaymentBatchesInput,
  MarkBatchPaidInput,
  DiscardPaymentBatchInput,
} from './pain001.js';
export { PAIN001_SCHEMA_SQL } from './pain001Schema.js';
