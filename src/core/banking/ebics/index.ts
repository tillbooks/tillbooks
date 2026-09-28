/**
 * A33 + A36, the EBICS bank channel (download only): the module's public surface. The composed verbs,
 * the successor rule (`feed.ts`), the certificates and hashes, the enums (§H-ENUM), the schema, and the
 * keystores. The transport and keystore PORTS live on `WorkspaceContext` (context.ts); this module never
 * opens a socket itself.
 */

export {
  connectBankChannel,
  syncBankChannel,
  transmitPaymentBatch,
  getBankChannelStatus,
  disconnectBankChannel,
  setBankSyncSchedule,
  sameHashes,
  exactSameHashes,
} from './channel.js';
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
export { lookupBankDirectory, lookupBankDirectoryData, BANK_DIRECTORY } from './banks.js';
export type { BankDirectoryEntry, BankFeeNote, BankDirectoryQuirks } from './banks.js';
export { createEbicsHttpsTransport, readZipContainer, STATEMENT_BTF, MAX_CONTAINER_MEMBERS, MAX_MEMBER_BYTES } from './transport-https.js';
export type { EbicsHttpsTransportOptions, EbicsWire, EbicsBtf, ZipReadResult } from './transport-https.js';
export { KEYSTORE_CHANGED_ELSEWHERE } from './keystore-file.js';
