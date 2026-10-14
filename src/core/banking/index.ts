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
export { lineNeedsReview } from './camtReconcile.js';

// A39, the bank inbox: one line, one proposal, confirm, undo by reversal.
export {
  BANK_LINE_STATES,
  BANK_LINE_IGNORE_REASONS,
  BANK_LINE_TARGET_KINDS,
  BANK_LINE_REMAINDER_MODES,
  BOOK_BANK_LINE_TARGET_KINDS,
  lineStateOf,
  readActiveLink,
  claimedLegs,
  bankLegsOf,
  bankLegIdsFor,
  bankLedgerOfLine,
  LINE_STATE_JOINS,
  LINE_STATE_EXPR,
  HAS_REVERSAL_SQL,
  entryIsReversed,
  BankAbort,
} from './bankLines.js';
export type {
  BankLineState,
  BankLineIgnoreReason,
  BankLineTargetKind,
  BankLineRemainderMode,
  BankLineLeg,
  BookBankLineTarget,
  ActiveLink,
  LineState,
  ClaimedLegs,
  BankLeg,
} from './bankLines.js';
export { bookBankLine, buildAccountsLines, ignoreBankLine, reopenBankLine } from './bankBooking.js';
export type {
  BookBankLineInput,
  BookBankLineOk,
  BankLineRemainder,
  IgnoreBankLineInput,
  IgnoreBankLineOk,
  ReopenBankLineInput,
  ReopenBankLineOk,
} from './bankBooking.js';
export {
  BANK_PROPOSAL_CERTAINTIES,
  BANK_PROPOSAL_REASONS,
  EXISTING_ENTRY_WINDOW_DAYS,
  proposalContext,
  proposeForLine,
} from './bankProposals.js';
export type { BankLineProposal, BankProposalCertainty, BankProposalReason } from './bankProposals.js';
export {
  BANK_INBOX_MODEL_CONSUMER,
  BANK_INBOX_MODEL_LANGUAGES,
  MODEL_SUGGEST_MIN_PROBABILITY,
  MODEL_SUGGEST_TOP_K,
  bankLineCandidates,
  bankLineDecisionState,
  modelCandidateBase,
} from './bankModelRung.js';
export { MODEL_SUGGEST_BATCH_MAX, MODEL_SUGGEST_IDS_MAX, MODEL_SUGGEST_SKIP_REASONS, suggestBankLines } from './bankModelSuggest.js';
export type { SuggestBankLinesInput, SuggestBankLinesOk, SuggestBankLinesDecision } from './bankModelSuggest.js';
export { invoiceSettlementFigures, planInvoiceSettlement } from './qrMatch.js';
export {
  BANK_INBOX_STATUS_FILTERS,
  BANK_INBOX_DEFAULT_LIMIT,
  BANK_INBOX_MAX_LIMIT,
  listBankInbox,
  bankReconciledForPeriod,
  ledgerBalanceInAccountCurrency,
  BANK_LINE_ATTENTIONS,
  attentionOf,
  bankInboxAttention,
  isProposalBookable,
  vorschlagLineIds,
} from './bankInbox.js';
export type {
  BankInboxLine,
  BankInboxDecision,
  BankAccountBalance,
  ListBankInboxInput,
  ListBankInboxOk,
  BankReconciledAccount,
  BankReconciledResult,
  BankLineAttention,
  BankInboxAttentionCounts,
} from './bankInbox.js';
export { BANK_INBOX_SCHEMA_SQL } from './bankInboxSchema.js';

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

// A36 §4.7 (D150), the hand repair: several camt.053 files, split and imported in number order.
export { importCamtFiles, IMPORT_CAMT_FILES_MAX } from './importCamtFiles.js';
export type { ImportCamtFilesInput, CamtFileOutcome } from './importCamtFiles.js';
export { splitCamt053 } from './camt.js';
export type { CamtSplitRefusal } from './camt.js';

// A36 §4.7 (D150), the statement gap read model and the confirmation that a chained gap holds nothing.
export { statementGaps, accountStatementGaps, STATEMENT_GAP_ACK_ACTIONS } from './statementGaps.js';
export { confirmStatementGap, revokeStatementGapConfirmation } from './statementGapAck.js';
export type {
  StatementGap,
  StatementGapRef,
  StatementGapRefused,
  StatementGapWithState,
  PendingGapStatement,
} from './statementGaps.js';
export type { ConfirmStatementGapInput } from './statementGapAck.js';
