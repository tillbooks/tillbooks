// D201 point 4: the per-person preference of Pendenzen, the one list with filters.
//
// The registry asserts every def on load; this states what the ATTENTION area promises on top: the filters
// a person last used persist, the default shows everything (no kind chosen, area all, actor all), the D178
// grouping is gone with the sections it chose between, both locales carry the texts, and the verbs answer
// it for the calling person like any other preference. SYNTHETIC BY CONSTRUCTION: the workspace and the
// actors are invented.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { PREF_DEFS, prefDef, prefValueFits } from '../../dist/core/customization/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

test('the attention area carries one preference, the filters, per person; the grouping is gone', () => {
  const attention = PREF_DEFS.filter((d) => d.area.id === 'attention');
  assert.deepEqual(
    attention.map((d) => d.key),
    ['attention.filters'],
  );
  assert.equal(prefDef('attention.grouping'), undefined, 'one list, no sections to group (D201 point 4)');
  const d = prefDef('attention.filters');
  assert.equal(d.scope, 'person');
  assert.deepEqual(d.schema, { type: 'json', root: 'object', maxBytes: 512 });
  for (const text of [d.label, d.description]) {
    assert.ok(text.en.trim() !== '' && text['de-CH'].trim() !== '', 'both locales');
    assert.ok(!text['de-CH'].includes(String.fromCharCode(0xdf)), 'no sharp s in de-CH');
    assert.ok(!`${text.en} ${text['de-CH']}`.includes(String.fromCharCode(0x2014)), 'no em dash');
  }
});

test('the default shows everything; a filter object fits, a list or an oversized value does not', () => {
  const d = prefDef('attention.filters');
  assert.deepEqual(d.default, { kinds: [], area: 'all', actor: 'all' });
  assert.equal(prefValueFits(d.schema, { kinds: ['approve', 'do'], area: 'bank', actor: 'agent' }), true);
  assert.equal(prefValueFits(d.schema, ['approve']), false, 'the root is an object');
  assert.equal(prefValueFits(d.schema, { kinds: [], area: 'x'.repeat(600), actor: 'all' }), false, 'bounded by size');
});

test('the verbs answer the filters for the calling person: set, read back, another person keeps the default, reset', () => {
  const deps = freshDeps();
  const ws = mintWorkspace(deps, 'Seeblick Probe GmbH', 'ws-attention').workspaceId;
  const call = (name, input, actor = 'studio') => getAction(name).run({ ...deps, actor }, input);

  const listed = call('prefs_list', { workspaceId: ws });
  assert.equal(listed.ok, true);
  assert.deepEqual(
    listed.prefs.filter((p) => p.area.id === 'attention').map((p) => [p.key, p.value, p.isDefault]),
    [['attention.filters', { kinds: [], area: 'all', actor: 'all' }, true]],
  );

  const chosen = { kinds: ['approve'], area: 'bank', actor: 'agent' };
  const set = call('prefs_set', { workspaceId: ws, key: 'attention.filters', value: chosen });
  assert.equal(set.ok, true);
  assert.deepEqual(call('prefs_get', { workspaceId: ws, key: 'attention.filters' }).pref.value, chosen);
  assert.deepEqual(call('prefs_get', { workspaceId: ws, key: 'attention.filters' }, 'agent').pref.value, { kinds: [], area: 'all', actor: 'all' });

  const wrong = call('prefs_set', { workspaceId: ws, key: 'attention.filters', value: 'bank' });
  assert.equal(wrong.ok, false, 'a bare string is not a filter object');

  const reset = call('prefs_reset', { workspaceId: ws, area: 'attention' });
  assert.equal(reset.ok, true);
  assert.deepEqual(call('prefs_get', { workspaceId: ws, key: 'attention.filters' }).pref.value, { kinds: [], area: 'all', actor: 'all' });
});
