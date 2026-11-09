/**
 * M02, the §I sync/publish contract (MIT core, the CONTRACT half of D51). The barrel the API layer
 * imports. The managed runtime that CONSUMES this contract is a separate private repo; nothing of it
 * lives here beyond the contract, its verbs, and the conformance/reconstruct fixtures.
 */

export {
  CONTRACT_VERSION,
  SUPPORTED_CONTRACT_VERSIONS,
  STREAM_KINDS,
  ALL_STREAM_KINDS,
  FACT_FAMILIES,
  PAYLOAD_SCHEMAS,
  SYNC_ERRORS,
  isFactKind,
} from './contract.js';
export type { StreamEnvelope, StreamKind } from './contract.js';

export {
  enableSyncPublish,
  disableSyncPublish,
  remintEpoch,
  readPublishState,
  headSeqOf,
} from './outbox.js';
export type { SyncDialInput } from './outbox.js';

export {
  getSyncContract,
  readSyncStream,
  syncStreamStatus,
  readSyncArtifact,
} from './stream.js';
export type { ReadStreamInput, ReadArtifactInput, StreamCursor } from './stream.js';

export { reconstructFromStream } from './reconstruct.js';
export type { ReconstructResult } from './reconstruct.js';
