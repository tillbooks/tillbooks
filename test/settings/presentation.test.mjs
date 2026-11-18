// D202 (G00 §11.2): THE PRESENTATION GUARD. Every registry key is shown in plain words and found by them:
// an entry in `src/core/settings/presentation.ts` with a de-CH and an en label, an area of the ten, a
// sub-heading, and a label in both locales for every value of an enum, so no raw value (`propose_split`)
// ever reaches a screen. A builder who adds a registry row adds its entry here too, or this fails.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SETTINGS, SETTINGS_AREAS, SETTINGS_AREA_DEFS, SETTING_PRESENTATION, isSettingsArea } from '../../dist/core/settings/index.js';
import { settingValueWords } from '../../dist/core/settings/presentation.js';

test('every registry key has a presentation entry with labels in both locales and an area of the ten', () => {
  const missing = SETTINGS.filter((s) => SETTING_PRESENTATION[s.key] === undefined).map((s) => s.key);
  assert.deepEqual(missing, [], 'add these keys to src/core/settings/presentation.ts');
  for (const s of SETTINGS) {
    const p = SETTING_PRESENTATION[s.key];
    assert.ok(isSettingsArea(p.area), `${s.key}: area '${p.area}' is not one of ${SETTINGS_AREAS.join(', ')}`);
    for (const text of [p.label, p.subgroup]) {
      assert.ok(text['de-CH'].trim().length > 0, `${s.key}: a de-CH text is empty`);
      assert.ok(text.en.trim().length > 0, `${s.key}: an en text is empty`);
    }
  }
});

test('every enum value of every setting has a label in both locales, never the raw value', () => {
  for (const s of SETTINGS) {
    if (s.schema.type !== 'enum') continue;
    const labels = SETTING_PRESENTATION[s.key].valueLabels ?? {};
    for (const v of s.schema.values) {
      const l = labels[v];
      assert.ok(l !== undefined, `${s.key}: the value '${v}' has no label`);
      assert.ok(l['de-CH'].trim().length > 0 && l.en.trim().length > 0, `${s.key}.${v}: a label is empty`);
      assert.notEqual(l['de-CH'], v, `${s.key}.${v}: the de-CH label is the raw value`);
    }
  }
});

test('the ten areas are defined once each, in the home order, with a label and a rail glyph', () => {
  assert.deepEqual(SETTINGS_AREA_DEFS.map((a) => a.id), [...SETTINGS_AREAS]);
  assert.equal(SETTINGS_AREAS.length, 10);
  for (const a of SETTINGS_AREA_DEFS) {
    assert.ok(a.label['de-CH'].length > 0 && a.label.en.length > 0, a.id);
    assert.ok(a.icon.length > 0, a.id);
    for (const page of a.pages) assert.match(page.route, /^\/[a-z-]+$/, `${a.id}: ${page.id}`);
  }
});

test('every area a setting lives in, and every area with a page, is reachable: no area is empty', () => {
  for (const a of SETTINGS_AREA_DEFS) {
    const rows = SETTINGS.filter((s) => SETTING_PRESENTATION[s.key]?.area === a.id).length + a.pages.length;
    assert.ok(rows > 0, `${a.id} would be a dead tile`);
  }
});

test('critic L4: the agent\'s areas read as area names, never their ids', () => {
  const schema = { type: 'string' };
  assert.equal(settingValueWords('agent.settings_sections', schema, 'bank,mwst', 'de-CH'), 'Bank, MWST');
  assert.equal(settingValueWords('agent.settings_sections', schema, 'agent', 'en'), 'Agent and automation');
  assert.equal(settingValueWords('agent.settings_sections', schema, '', 'de-CH'), 'Keine');
});
