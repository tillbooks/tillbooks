/**
 * The settings test kit: a `settings_list` answer built from the REAL engine registry, presentation and
 * areas (`src/core/settings`), exactly as `settingsList` shapes it for a workspace with no override. A
 * search test that feeds it finds or misses what a person would on the real catalog, including every
 * setting added after the test was written (the owner's search for D209's `agent.approve_on_owner_word`
 * found nothing on 18.11.2026). Registry rows are definitions, not data: nothing here is a real book.
 *
 * Not a test file itself: the settings, index and palette suites import it.
 */
import { SETTINGS } from '../../../src/core/settings/registry.js';
import { presentationOf } from '../../../src/core/settings/presentation.js';
import { SETTINGS_AREA_DEFS } from '../../../src/core/settings/areas.js';
import type { SettingEntryView, SettingsAreaEntry, SettingsCatalog } from './settings-index';

/** The `settings_list` body of a workspace that changed nothing. */
export function realSettingsListBody(): Record<string, unknown> & { ok: true } & SettingsCatalog {
  const settings: SettingEntryView[] = SETTINGS.map((def) => {
    const shown = presentationOf(def.key, def.label);
    return {
      key: def.key,
      value: def.default,
      default: def.default,
      overridden: false,
      schema: def.schema as SettingEntryView['schema'],
      owningCapability: def.owningCapability,
      dialCapability: def.dialCapability,
      label: { ...def.label },
      description: { ...def.description },
      humanOnly: def.humanOnly === true,
      askFirst: def.askFirst === true,
      answered: def.askFirst !== true,
      updatedAt: null,
      updatedBy: null,
      stale: false,
      ignoredStoredValue: null,
      section: shown.area,
      presentation: {
        subgroup: { ...shown.subgroup },
        label: { ...shown.label },
        ...(shown.valueLabels !== undefined ? { valueLabels: { ...shown.valueLabels } } : {}),
        keywords: { en: [...shown.keywords.en], 'de-CH': [...shown.keywords['de-CH']] },
        ...(shown.widensAgent === true ? { widensAgent: true } : {}),
      },
    };
  });
  const areas: SettingsAreaEntry[] = SETTINGS_AREA_DEFS.map((a) => ({
    id: a.id,
    label: { ...a.label },
    icon: a.icon,
    keywords: { en: [...a.keywords.en], 'de-CH': [...a.keywords['de-CH']] },
    pages: a.pages.map((p) => ({ id: p.id, route: p.route, label: { ...p.label }, keywords: { en: [...p.keywords.en], 'de-CH': [...p.keywords['de-CH']] } })),
    agentMayChange: false,
  }));
  return { ok: true, settings, unanswered: settings.filter((s) => !s.answered).map((s) => s.key), areas };
}
