/**
 * A33 + A36, the EBICS bank channel (download only): the module's public surface. The composed verbs,
 * the successor rule (`feed.ts`), the certificates and hashes, the enums (§H-ENUM), the schema, and the
 * keystores. The transport and keystore PORTS live on `WorkspaceContext` (context.ts); this module never
 * opens a socket itself.
 */

export {
  connectBankChannel,
  syncBankChannel,
  SYNC_LEASE_MS,
  processSyncLeaseHolder,
  reclaimDeadSyncLeases,
  releaseSyncLeaseOf,
  setSyncLeaseHolder,
  syncLeaseFreesAt,
  transmitPaymentBatch,
  getBankChannelStatus,
  disconnectBankChannel,
  setBankSyncSchedule,
  sameHashes,
  exactSameHashes,
  checkBankActivation,
  readStatementGaps,
  pendingGapStatements,
} from './channel.js';
export type { ActivationCheckReport } from './channel.js';
export {
  ACTIVATION_CHECK_STATES,
  ACTIVATION_CHECK_MAX_ATTEMPTS,
  ACTIVATION_CHECK_OUTCOMES,
  ACTIVATION_CHECK_RELATED_KIND,
  activationCheckConnections,
  activationCheckDecision,
  activationStatus,
  bankReadyForReview,
  isActivationInProgress,
  recordUnknownActivationAttempt,
} from './activationCheck.js';
export type { ActivationCheckOutcome, ActivationCheckDecision, ActivationStatus, ActivationCheckConnectionRow } from './activationCheck.js';
export {
  decideSuccessor,
  dayEndPosition,
  comparePositions,
  isEbicsFedAccount,
  readFeedBook,
  newestFeedStatement,
  FEED_FINAL_OUTCOMES,
  FEED_REFUSAL_CODES,
} from './feed.js';
export type { FeedDecision, FeedPosition, FeedCandidate, FeedBookRow, FeedRefusalCode } from './feed.js';
export { issueSelfSignedCertificate, certificateCommonName, EBICS_CERT_NOT_AFTER } from './certificates.js';
export { ebicsKeyHashHex, certificateHashHex, hashesOfCertificate, EBICS_KEY_PURPOSES } from './key-hashes.js';
export { formatBankHash, formatBankHashLines, BANK_HASH_BYTES_PER_LINE } from './hash-format.js';

export {
  EBICS_CONNECTION_STATE,
  EBICS_ORDER_DIRECTION,
  EBICS_ORDER_TYPE,
  EBICS_ORDER_STATUS,
  EBICS_DEFAULT_KEY_PARAMS,
  EBICS_UNLIMITED_VALIDITY,
  isEbicsConnectionState,
  isEbicsOrderStatus,
} from './enums.js';
export type {
  EbicsConnectionState,
  EbicsOrderDirection,
  EbicsOrderType,
  EbicsOrderStatus,
} from './enums.js';

export { EBICS_SCHEMA_SQL } from './schema.js';
export { defaultEbicsKeystore } from './keystore.js';
export { fileEbicsKeystore } from './keystore-file.js';
export type { FileEbicsKeystore, PassphraseProvider } from './keystore-file.js';
export { lookupBankDirectory, lookupBankDirectoryData, BANK_DIRECTORY, bankShortName } from './banks.js';
export type { BankDirectoryEntry, BankFeeNote, BankDirectoryQuirks } from './banks.js';
export { createEbicsHttpsTransport, readZipContainer, STATEMENT_BTF, MAX_CONTAINER_MEMBERS, MAX_MEMBER_BYTES } from './transport-https.js';
export type { EbicsHttpsTransportOptions, EbicsWire, EbicsBtf, ZipReadResult } from './transport-https.js';
export { KEYSTORE_CHANGED_ELSEWHERE } from './keystore-file.js';
export {
  AUTO_SYNC_MODES,
  AUTO_SYNC_MAX_ATTEMPTS,
  AUTO_SYNC_RETRY_MS,
  AUTO_SYNC_TIME_ZONE,
  DEFAULT_AUTO_SYNC_AT,
  AUTO_SYNC_FALLBACK_ACTOR,
  autoSyncActor,
  autoSyncConnections,
  autoSyncDecision,
  autoSyncKey,
  autoSyncNoActorReason,
  autoSyncSetterKind,
  autoSyncTried,
  autoSyncSettings,
  autoSyncStatus,
  isAutoSyncMode,
  isAutoSyncTime,
  isRetryableAutoOutcome,
  nextDay,
  recordAutoSyncAttempt,
  zurichInstant,
  zurichParts,
} from './autoSync.js';
export type { AutoSyncMode, AutoSyncDecision, AutoSyncSettings, AutoSyncSetterKind, AutoSyncStatus, AutoSyncAttemptView, AutoSyncConnectionRow } from './autoSync.js';
