// D178 point 10 (A39 §18.2): the per-person preferences of the /bank detail area.
//
// The registry asserts every def on load; this states what the BANK area promises on top: the owner's
// pick is the default (automatic, the threshold 8), every alternative is a value a person can choose, the
// sizes are bounded, every text exists in both locales, and the verbs answer them for the calling person
// like any other preference. SYNTHETIC BY CONSTRUCTION: the workspace and the actors are invented.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { PREF_AREAS, PREF_DEFS, prefDef, prefValueFits } from '../../dist/core/customization/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const KEYS = ['bank.detail_position', 'bank.detail_auto_threshold', 'bank.detail_width', 'bank.detail_height', 'bank.booking_view', 'bank.focus_list_hidden'];

test('the bank area carries the detail-area and booking-view preferences, in this order, all per person', () => {
  const bank = PREF_DEFS.filter((d) => d.area.id === 'bank');
  assert.deepEqual(
    bank.map((d) => d.key),
    KEYS,
  );
  assert.ok(PREF_AREAS.some((a) => a.id === 'bank' && a.label['de-CH'] === 'Bank'));
  for (const d of bank) {
    assert.equal(d.scope, 'person', `${d.key} follows the person, not the mandate`);
    assert.equal(prefValueFits(d.schema, d.default), true, `${d.key}: the default fits`);
    for (const text of [d.label, d.description]) {
      assert.ok(text.en.trim() !== '' && text['de-CH'].trim() !== '', `${d.key}: both locales`);
      assert.ok(!text['de-CH'].includes(String.fromCharCode(0xdf)), `${d.key}: no sharp s in de-CH`);
      assert.ok(!`${text.en} ${text['de-CH']}`.includes(String.fromCharCode(0x2014)), `${d.key}: no em dash`);
    }
  }
});

test('the owner pick is the default; right and bottom stay choosable (D178 rule: every option is a setting)', () => {
  const position = prefDef('bank.detail_position');
  assert.deepEqual(position.schema, { type: 'enum', values: ['automatic', 'right', 'bottom'] });
  assert.equal(position.default, 'automatic');
  assert.deepEqual(Object.keys(position.valueLabels), ['automatic', 'right', 'bottom']);
  assert.equal(position.valueLabels.bottom['de-CH'], 'Unten');
  const threshold = prefDef('bank.detail_auto_threshold');
  assert.deepEqual(threshold.schema, { type: 'integer', min: 0, max: 500 });
  assert.equal(threshold.default, 8);
});

test('D178 point 9: focus is the default booking view; tabs and one field stay choosable', () => {
  const view = prefDef('bank.booking_view');
  assert.deepEqual(view.schema, { type: 'enum', values: ['focus', 'tabs', 'smart'] });
  assert.equal(view.default, 'focus');
  assert.deepEqual(Object.keys(view.valueLabels), ['focus', 'tabs', 'smart']);
  assert.equal(view.valueLabels.tabs['de-CH'], 'Reiter');
  const hidden = prefDef('bank.focus_list_hidden');
  assert.deepEqual(hidden.schema, { type: 'boolean' });
  assert.equal(hidden.default, false);
});

test('the sizes are bounded pixels with a default inside the bounds', () => {
  const width = prefDef('bank.detail_width');
  const height = prefDef('bank.detail_height');
  assert.deepEqual(width.schema, { type: 'integer', min: 320, max: 960 });
  assert.deepEqual(height.schema, { type: 'integer', min: 200, max: 800 });
  assert.equal(width.default, 360);
  assert.equal(height.default, 320);
  assert.equal(prefValueFits(width.schema, 319), false, 'under the minimum is refused');
  assert.equal(prefValueFits(height.schema, 801), false, 'over the maximum is refused');
  assert.equal(prefValueFits(width.schema, 360.5), false, 'a fraction of a pixel is refused');
});

test('the verbs answer the bank preferences for the calling person: set, read back, refuse a stranger value, reset', () => {
  const deps = freshDeps();
  const ws = mintWorkspace(deps, 'Seeblick Probe GmbH', 'ws-bank').workspaceId;
  const call = (name, input, actor = 'studio') => getAction(name).run({ ...deps, actor }, input);

  const listed = call('prefs_list', { workspaceId: ws });
  assert.equal(listed.ok, true);
  const rows = listed.prefs.filter((p) => p.area.id === 'bank');
  assert.deepEqual(rows.map((p) => [p.key, p.value, p.isDefault]), [
    ['bank.detail_position', 'automatic', true],
    ['bank.detail_auto_threshold', 8, true],
    ['bank.detail_width', 360, true],
    ['bank.detail_height', 320, true],
    ['bank.booking_view', 'focus', true],
    ['bank.focus_list_hidden', false, true],
  ]);

  const docked = call('prefs_set', { workspaceId: ws, key: 'bank.detail_position', value: 'bottom' });
  assert.equal(docked.ok, true);
  assert.equal(docked.value, 'bottom');
  assert.equal(call('prefs_get', { workspaceId: ws, key: 'bank.detail_position' }).pref.value, 'bottom');
  // Another person keeps the default: a layout is one person's.
  assert.equal(call('prefs_get', { workspaceId: ws, key: 'bank.detail_position' }, 'agent').pref.value, 'automatic');

  const wrong = call('prefs_set', { workspaceId: ws, key: 'bank.detail_position', value: 'left' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, 'invalid_pref_value');

  const wide = call('prefs_set', { workspaceId: ws, key: 'bank.detail_width', value: 2000 });
  assert.equal(wide.ok, false, 'a width over the bound is refused, never clamped silently');

  const reset = call('prefs_reset', { workspaceId: ws, area: 'bank' });
  assert.equal(reset.ok, true);
  assert.equal(call('prefs_get', { workspaceId: ws, key: 'bank.detail_position' }).pref.value, 'automatic');
});
