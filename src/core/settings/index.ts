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
export { getSetting, settingsGet, settingsList, settingsReset, settingsSet } from './settings.js';
export type { SettingView, SettingsGetOk, SettingsListOk, SettingsResetInput, SettingsSetInput, SettingsSetOk } from './settings.js';
export { SETTINGS_SCHEMA_SQL } from './schema.js';
