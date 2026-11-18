/** D172, the workspace settings registry: the public surface of `src/core/settings/`. */
export {
  SETTINGS,
  SETTING_DIAL_CAPABILITIES,
  assertSettingsRegistry,
  dialCapabilityForSetting,
  owningCapabilityFor,
  settingDef,
  valueFitsSchema,
} from './registry.js';
export type { LocalisedText, SettingDef, SettingDialCapability, SettingSchema, SettingValue } from './registry.js';
export {
  answeredSetting,
  getSetting,
  isSettingsAgentSeat,
  liveSettingsAreaGrant,
  refuseHumanOnly,
  screenSettingsChange,
  settingAnswer,
  settingsGet,
  settingsHistory,
  settingsList,
  settingsReset,
  settingsSet,
  SETTINGS_HISTORY_DEFAULT_LIMIT,
  SETTINGS_HISTORY_MAX_LIMIT,
  SETTINGS_PROPOSALS_OPEN_MAX_KEY,
  SETTINGS_SECTIONS_KEY,
} from './settings.js';
export type {
  ChangeProvenance,
  SettingChangeView,
  SettingView,
  SettingsAreaView,
  SettingsGetOk,
  SettingsHistoryInput,
  SettingsHistoryOk,
  SettingsListOk,
  SettingsResetInput,
  SettingsSetInput,
  SettingsSetOk,
} from './settings.js';
export { SETTINGS_SCHEMA_SQL, SETTINGS_ADDITIVE_COLUMNS } from './schema.js';
// D202: the ten areas, the presentation and the agent's routes.
export { SETTINGS_AREAS, SETTINGS_AREA_DEFS, isSettingsArea, parseSettingsSections, settingsSectionsProblem } from './areas.js';
export type { SettingsArea, SettingsAreaDef } from './areas.js';
export { SETTING_PRESENTATION, presentationOf } from './presentation.js';
export type { SettingPresentation } from './presentation.js';
export { SETTINGS_WRITE_VERBS, isPersonOnlySettingsRow, openPersonOnlyProposals, planAgentSettingsCall, refuseTooManyProposals } from './agentAccess.js';
export type { AgentSettingsPlan } from './agentAccess.js';
