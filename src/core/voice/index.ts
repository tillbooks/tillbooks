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
export type { Op6Adapter, RuntimeManifestEntry, SelectRuntimeInput, DecideCalibration, DecideCapability } from './runtime.js';
export { DECIDE_MAX_CHOICES_CEILING } from './runtime.js';
export { decide, decideModel, DECIDE_SUM_TOLERANCE, DECIDE_MAX_STATE_CHARS, DECIDE_MAX_QUESTIONS } from './decide.js';
export type { DecideQuestion, DecideAnswer, DecideInput, DecideOk } from './decide.js';
export {
  recordModelDecision,
  findModelDecision,
  latestModelDecisions,
  decisionInputSha256,
  decisionFingerprint,
  readDecisionKey,
  ensureDecisionKey,
} from './decisionTrace.js';
export type { ModelDecisionRow, RecordModelDecisionInput } from './decisionTrace.js';
export {
  VOICE_SOURCE_KINDS,
  RUNTIME_SOURCES,
  DECIDE_QUESTION_TYPES,
  isVoiceSourceKind,
  isRuntimeSource,
  isDecideQuestionType,
} from './enums.js';
export type { VoiceSourceKind, RuntimeSource, DecideQuestionType } from './enums.js';
export { VOICE_SCHEMA_SQL, VOICE_TABLES } from './schema.js';
