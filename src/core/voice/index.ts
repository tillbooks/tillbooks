/**
 * E05, voice profile + the OP6 local runtime: the barrel `src/api/` imports from.
 *
 * The runtime registry is exported for the companion package (`registerRuntime` at its startup)
 * and for E06, whose drafting consumes `registeredRuntime()` and never names an inference library
 * itself; `purgeVoiceForContact` is exported for C00's `contacts_anonymise` (called INSIDE that
 * verb's transaction and deliberately not an MCP tool of its own, the E04 `purgeMailForContact`
 * shape); the schema constants feed the store and the guard suites.
 */

export {
  buildVoiceProfile,
  getVoiceProfile,
  listVoiceProfiles,
  retrieveVoiceExemplars,
  purgeVoiceForContact,
  distilStyleCard,
  corpusFingerprint,
  cosineSimilarity,
  CORPUS_FLOOR,
} from './voice.js';
export type { BuildVoiceProfileInput, RetrieveInput } from './voice.js';
export {
  registerRuntime,
  reportRuntimeLoadFailure,
  registeredRuntime,
  resetRuntimeRegistration,
  machineRamGb,
  recommendModel,
  readRuntimeSelection,
  runtimeStatus,
  runtimeCatalog,
  selectRuntimeModel,
} from './runtime.js';
export type { Op6Adapter, RuntimeManifestEntry, SelectRuntimeInput } from './runtime.js';
export {
  VOICE_SOURCE_KINDS,
  RUNTIME_SOURCES,
  isVoiceSourceKind,
  isRuntimeSource,
} from './enums.js';
export type { VoiceSourceKind, RuntimeSource } from './enums.js';
export { VOICE_SCHEMA_SQL, VOICE_TABLES } from './schema.js';
