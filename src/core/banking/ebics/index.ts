/**
 * A33, EBICS bank channel: the module's public surface. The five composed verbs (spec §4), the enums
 * (§H-ENUM), the schema, and the default keystore. The transport and keystore PORTS live on
 * `WorkspaceContext` (context.ts); this module never opens a socket itself.
 */

export {
  connectBankChannel,
  syncBankChannel,
  transmitPaymentBatch,
  getBankChannelStatus,
  disconnectBankChannel,
  setBankSyncSchedule,
  assertNoSoleAuthority,
  guardNoSoleAuthority,
  SoleAuthorityViolation,
} from './channel.js';

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
export { createEbicsHttpsTransport, unpackContainer, BTF_DOWNLOAD_SERVICES, BTF_UPLOAD_PAIN001 } from './transport-https.js';
export type { EbicsHttpsTransportOptions, EbicsWire } from './transport-https.js';
