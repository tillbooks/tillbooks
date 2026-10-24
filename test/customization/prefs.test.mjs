// D178 point 7, the per-person preferences (G00 spec §10): the def registry and the four verbs.
//
// The conformance floor already holds idempotent-on-rows and §H-TENANT over every verb in ACTIONS. These
// tests state what the PREFERENCE registry promises on top: a def is asserted at load, every schema shape
// admits exactly its values, an unknown key or area is refused with a hint, a missing row reads the
// default, a preference belongs to the calling actor and nobody else, a `workspace` preference stays in
// its workspace while a `person` one follows the actor, a reset clears exactly what was stored, only a
// member reaches the verbs, and a plugin call never writes.
//
// SYNTHETIC BY CONSTRUCTION: the workspaces, the actors and every value here are invented.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { makeContext } from '../../dist/core/context.js';
import { withinPluginCall } from '../../dist/core/plugins/callScope.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import {
  PREF_DEFS,
  PREF_AREAS,
  MAX_PREF_JSON_BYTES,
  assertPrefDefs,
  prefDef,
  prefJsonProblem,
  prefValueFits,
  prefRegistry,
  prefsGet,
  prefsList,
  prefsReset,
  prefsSet,
  suggestPrefKey,
} from '../../dist/core/customization/index.js';
import { CAPABILITY_FOR_ACTION, requiredCapabilitiesFor, isUngated } from '../../dist/core/access/actionCapabilities.js';
import { NOT_AUTOMATABLE, NOT_AUTOMATABLE_LEGS } from '../../dist/core/automation/denylist.js';
import { WAY_BACK } from '../../dist/core/agent/wayBack.js';

const T = (en, de) => ({ en, 'de-CH': de });
const AREA = { id: 'probe', label: T('Probe', 'Probe') };

/** A synthetic registry covering every schema shape and BOTH scopes, driven through the real verbs. */
const TEST_DEFS = [
  {
    key: 'probe.colour',
    schema: { type: 'enum', values: ['red', 'green'] },
    default: 'red',
    scope: 'person',
    area: AREA,
    label: T('Colour', 'Farbe'),
    description: T('A colour.', 'Eine Farbe.'),
    valueLabels: { red: T('Red', 'Rot'), green: T('Green', 'Grün') },
  },
  {
    key: 'probe.rows',
    schema: { type: 'integer', min: 1, max: 50 },
    default: 10,
    scope: 'workspace',
    area: AREA,
    label: T('Rows', 'Zeilen'),
    description: T('How many rows.', 'Wie viele Zeilen.'),
  },
  {
    key: 'probe.ratio',
    schema: { type: 'number', min: 0, max: 1 },
    default: 0.5,
    scope: 'workspace',
    area: AREA,
    label: T('Ratio', 'Verhältnis'),
    description: T('A ratio.', 'Ein Verhältnis.'),
  },
  {
    key: 'probe.flag',
    schema: { type: 'boolean' },
    default: false,
    scope: 'person',
    area: AREA,
    label: T('Flag', 'Schalter'),
    description: T('A flag.', 'Ein Schalter.'),
  },
  {
    key: 'probe.name',
    schema: { type: 'string', maxLength: 8 },
    default: '',
    scope: 'person',
    area: AREA,
    label: T('Name', 'Name'),
    description: T('A short name.', 'Ein kurzer Name.'),
  },
  {
    key: 'probe.order',
    schema: { type: 'json', root: 'array', maxBytes: 64 },
    default: [],
    scope: 'workspace',
    area: AREA,
    label: T('Order', 'Reihenfolge'),
    description: T('An ordered list.', 'Eine geordnete Liste.'),
  },
];
const PROBE = prefRegistry(TEST_DEFS);

const ctxFor = (deps, workspaceId, actor, extra = {}) =>
  makeContext(deps.store, { workspaceId, actor, clock: deps.clock, ids: deps.ids, ...extra });

function world() {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Alpen GmbH', 'ws-a').workspaceId;
  const b = mintWorkspace(deps, 'Berg AG', 'ws-b').workspaceId;
  const call = (name, input, actor = 'studio') => getAction(name).run({ ...deps, actor }, input);
  const rows = (table) => deps.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return { deps, a, b, call, rows };
}

// --- the def registry ---------------------------------------------------------------------------

test('the live registry is well formed: the appearance area carries the colour scheme and the density', () => {
  assertPrefDefs(PREF_DEFS);
  // Pinned, literally (critic N4 L3): appearance (E0), then attention (N4), then the rail's nav (N6), then bank (N2), then overview (N5). A later area file appends here.
  assert.deepEqual(PREF_AREAS.map((a) => a.id), ['appearance', 'attention', 'nav', 'bank', 'overview']);
  const theme = prefDef('appearance.theme');
  assert.deepEqual(theme.schema, { type: 'enum', values: ['light', 'dark', 'system'] });
  assert.equal(theme.default, 'system');
  assert.equal(theme.scope, 'person');
  assert.deepEqual(Object.keys(theme.valueLabels).sort(), ['dark', 'light', 'system']);
  const density = prefDef('appearance.density');
  assert.deepEqual(density.schema, { type: 'enum', values: ['komfortabel', 'kompakt'] });
  assert.equal(density.default, 'komfortabel');
  assert.equal(density.scope, 'person');
  for (const d of PREF_DEFS) assert.equal(prefValueFits(d.schema, d.default), true, `${d.key}: the default fits`);
});

test('D180: the Übersicht arranges its key figures and its cards; a full arrangement of either fits its byte cap', () => {
  const tiles = prefDef('overview.tiles');
  assert.deepEqual(tiles.schema, { type: 'json', root: 'array', maxBytes: 1024 });
  assert.deepEqual(tiles.default, []);
  assert.equal(tiles.scope, 'person');
  assert.equal(tiles.area.id, 'overview');
  // Every tile the registry knows, the bank item included, hidden and shown, in one stored list.
  const allTiles = ['revenue', 'cash', 'ar_aging', 'ap_aging', 'utilisation', 'project_margin', 'mwst_due', 'stock_value', 'bank_inbox'].map(
    (id, i) => ({ id, on: i % 2 === 0 }),
  );
  assert.equal(prefValueFits(tiles.schema, allTiles), true, 'nine tiles fit');
  const widgets = prefDef('overview.widgets');
  // All six cards, each one full width: the largest arrangement the Studio writes.
  const allCards = ['expense_donut', 'money_in_out', 'open_creditors', 'open_tasks', 'cash_flow', 'expense_bars'].map((id) => ({ id, on: true, w: 'full' }));
  assert.equal(prefValueFits(widgets.schema, allCards), true, 'six full-width cards fit');
  // The two existing keys keep their keys and values (no migration).
  assert.deepEqual(prefDef('overview.content').schema, { type: 'enum', values: ['bexio', 'trends', 'figures'] });
  assert.deepEqual(prefDef('overview.bank_action').schema, { type: 'enum', values: ['tile', 'card', 'bar'] });
});

test('a malformed def is a crash on load, one refusal per shape', () => {
  const ok = TEST_DEFS[0];
  assert.doesNotThrow(() => assertPrefDefs(TEST_DEFS));
  const bad = [
    [{ ...ok, key: 'NoDot' }, /lower case/],
    [{ ...ok, key: 'other.colour' }, /area id/],
    [{ ...ok, area: { id: 'Bad-Id', label: AREA.label }, key: 'Bad-Id.x' }, /lower case|area id/],
    [{ ...ok, scope: 'device' }, /scope/],
    [{ ...ok, default: 'blue' }, /default/],
    [{ ...ok, schema: { type: 'enum', values: ['red'] }, valueLabels: { red: T('Red', 'Rot') } }, /two values/],
    [{ ...ok, valueLabels: undefined }, /valueLabels/],
    [{ ...ok, valueLabels: { red: T('Red', 'Rot') } }, /'green' lacks/],
    [{ ...ok, valueLabels: { ...ok.valueLabels, blue: T('Blue', 'Blau') } }, /not one of its values/],
    [{ ...TEST_DEFS[1], valueLabels: { a: T('A', 'A') } }, /enum only/],
    [{ ...TEST_DEFS[5], schema: { type: 'json', root: 'array', maxBytes: MAX_PREF_JSON_BYTES + 1 } }, /maxBytes/],
    [{ ...TEST_DEFS[5], default: {} }, /default/],
    [{ ...ok, label: T('', 'Farbe') }, /en or de-CH/],
    [{ ...TEST_DEFS[1], schema: { type: 'integer', min: 5, max: 1 } }, /min is above max/],
  ];
  for (const [def, message] of bad) assert.throws(() => assertPrefDefs([def]), message, JSON.stringify(def.key));
  assert.throws(() => assertPrefDefs([ok, ok]), /twice/);
  assert.throws(
    () => assertPrefDefs([ok, { ...TEST_DEFS[3], area: { id: 'probe', label: T('Other', 'Andere') } }]),
    /two different labels/,
  );
});

test('every schema shape admits exactly its values, with no coercion', () => {
  const s = (key) => PROBE.byKey.get(key).schema;
  assert.equal(prefValueFits(s('probe.colour'), 'green'), true);
  assert.equal(prefValueFits(s('probe.colour'), 'blue'), false);
  assert.equal(prefValueFits(s('probe.rows'), 50), true);
  assert.equal(prefValueFits(s('probe.rows'), 51), false);
  assert.equal(prefValueFits(s('probe.rows'), 2.5), false);
  assert.equal(prefValueFits(s('probe.rows'), '10'), false, '"10" is not the integer 10');
  assert.equal(prefValueFits(s('probe.ratio'), 0.25), true);
  assert.equal(prefValueFits(s('probe.ratio'), Number.NaN), false);
  assert.equal(prefValueFits(s('probe.flag'), true), true);
  assert.equal(prefValueFits(s('probe.flag'), 'true'), false);
  assert.equal(prefValueFits(s('probe.name'), 'Kasse'), true);
  assert.equal(prefValueFits(s('probe.name'), 'zu langer Name'), false);
  assert.equal(prefValueFits(s('probe.order'), ['a', 'b']), true);
  assert.equal(prefJsonProblem(s('probe.order'), { a: 1 }), 'wrong_root');
  assert.equal(prefJsonProblem(s('probe.order'), [Number.POSITIVE_INFINITY]), 'not_json');
  assert.equal(prefJsonProblem(s('probe.order'), ['x'.repeat(80)]), 'too_large');
  // 35 characters, 66 UTF-8 bytes: over a 64-byte bound although far under it in characters.
  assert.equal(prefJsonProblem(s('probe.order'), ['ä'.repeat(31)]), 'too_large', 'the bound is UTF-8 bytes, not characters');
});

// --- the verbs ----------------------------------------------------------------------------------

test('a preference with no stored value reads its default, and prefs_list says so for every key', () => {
  const w = world();
  const listed = w.call('prefs_list', { workspaceId: w.a });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.prefs.map((p) => p.key), PREF_DEFS.map((d) => d.key));
  for (const p of listed.prefs) {
    assert.equal(p.isDefault, true);
    assert.equal(p.stale, false);
    assert.deepEqual(p.value, p.default);
    assert.equal(p.updatedAt, null);
  }
  assert.deepEqual(listed.areas.map((a) => a.id), ['appearance', 'attention', 'nav', 'bank', 'overview']);
  const got = w.call('prefs_get', { workspaceId: w.a, key: 'appearance.theme' });
  assert.equal(got.pref.value, 'system');
  assert.deepEqual(got.pref.valueLabels.dark, { en: 'Dark', 'de-CH': 'Dunkel' });
  assert.deepEqual(w.rows('person_pref'), []);
});

test('prefs_set stores the value, answers the previous one, and a second identical set writes nothing', () => {
  const w = world();
  const set = w.call('prefs_set', { workspaceId: w.a, key: 'appearance.theme', value: 'dark' });
  assert.deepEqual(
    { key: set.key, value: set.value, previousValue: set.previousValue, isDefault: set.isDefault, changed: set.changed },
    { key: 'appearance.theme', value: 'dark', previousValue: 'system', isDefault: false, changed: true },
  );
  assert.equal(w.call('prefs_get', { workspaceId: w.a, key: 'appearance.theme' }).pref.value, 'dark');
  const before = JSON.stringify(w.rows('person_pref'));
  const again = w.call('prefs_set', { workspaceId: w.a, key: 'appearance.theme', value: 'dark' });
  assert.equal(again.changed, false);
  assert.equal(JSON.stringify(w.rows('person_pref')), before, 'a replay moved no row');
  // A set to the default while nothing is stored stores nothing; the same set over a stored value pins it.
  const fresh = world();
  const noop = fresh.call('prefs_set', { workspaceId: fresh.a, key: 'appearance.density', value: 'komfortabel' });
  assert.equal(noop.changed, false);
  assert.equal(noop.isDefault, true);
  assert.deepEqual(fresh.rows('person_pref'), []);
  const pinned = w.call('prefs_set', { workspaceId: w.a, key: 'appearance.theme', value: 'system' });
  assert.equal(pinned.changed, true);
  assert.equal(pinned.isDefault, false);
});

test('a preference writes no audit row and no history: it is the person`s own UI state', () => {
  const w = world();
  const audit = () => w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  const n = audit();
  w.call('prefs_set', { workspaceId: w.a, key: 'appearance.density', value: 'kompakt' });
  w.call('prefs_reset', { workspaceId: w.a, key: 'appearance.density' });
  assert.equal(audit(), n);
});

test('an unknown key is refused with the key it most likely meant; an unknown area with the known ones', () => {
  const w = world();
  for (const verb of ['prefs_get', 'prefs_set', 'prefs_reset']) {
    const r = w.call(verb, { workspaceId: w.a, key: 'appearance.them', value: 'dark' });
    assert.equal(r.ok, false, verb);
    assert.equal(r.error, 'unknown_pref', verb);
    assert.equal(r.suggestion, 'appearance.theme', verb);
    assert.deepEqual(r.known, PREF_DEFS.map((d) => d.key), verb);
  }
  assert.equal(suggestPrefKey('theme'), 'appearance.theme', 'a bare name finds its key');
  assert.equal(suggestPrefKey('completely.unrelated.thing'), null, 'nothing close, no guess');
  const area = w.call('prefs_list', { workspaceId: w.a, area: 'apperance' });
  assert.deepEqual([area.error, area.known], ['unknown_pref_area', ['appearance', 'attention', 'nav', 'bank', 'overview']]);
  assert.equal(w.call('prefs_reset', { workspaceId: w.a, area: 'nope' }).error, 'unknown_pref_area');
  assert.equal(w.call('prefs_get', { workspaceId: w.a, key: '' }).error, 'invalid_input');
});

test('a value that does not fit is refused invalid_pref_value naming the schema, and nothing is written', () => {
  const w = world();
  const r = w.call('prefs_set', { workspaceId: w.a, key: 'appearance.theme', value: 'blue' });
  assert.equal(r.error, 'invalid_pref_value');
  assert.deepEqual(r.schema, { type: 'enum', values: ['light', 'dark', 'system'] });
  assert.equal(w.call('prefs_set', { workspaceId: w.a, key: 'appearance.theme' }).error, 'invalid_input');
  const ctx = ctxFor(w.deps, w.a, 'studio');
  assert.equal(prefsSet(ctx, { key: 'probe.rows', value: '12' }, PROBE).error, 'invalid_pref_value');
  const large = prefsSet(ctx, { key: 'probe.order', value: ['x'.repeat(80)] }, PROBE);
  assert.deepEqual([large.error, large.reason], ['invalid_pref_value', 'too_large']);
  assert.deepEqual(w.rows('person_pref'), []);
  assert.deepEqual(w.rows('person_workspace_pref'), []);
});

test('actor isolation: a person reads and writes only their own preferences, never another actor`s', () => {
  const w = world();
  w.call('prefs_set', { workspaceId: w.a, key: 'appearance.theme', value: 'dark' }, 'studio');
  // The agent seat is its own actor: it sees the default, and its own set does not move the person's.
  assert.equal(w.call('prefs_get', { workspaceId: w.a, key: 'appearance.theme' }, 'agent').pref.value, 'system');
  w.call('prefs_set', { workspaceId: w.a, key: 'appearance.theme', value: 'light' }, 'agent');
  assert.equal(w.call('prefs_get', { workspaceId: w.a, key: 'appearance.theme' }, 'studio').pref.value, 'dark');
  // A reset of the whole area by the agent removes the agent's row only.
  const reset = w.call('prefs_reset', { workspaceId: w.a, area: 'appearance' }, 'agent');
  assert.deepEqual(reset.reset, ['appearance.theme']);
  assert.equal(w.call('prefs_get', { workspaceId: w.a, key: 'appearance.theme' }, 'studio').pref.value, 'dark');
  assert.deepEqual(w.rows('person_pref').map((r) => [r.actor, r.key, r.value_json]), [['studio', 'appearance.theme', '"dark"']]);
  // No verb takes an actor: an input naming one is ignored, the session actor decides.
  w.call('prefs_set', { workspaceId: w.a, key: 'appearance.density', value: 'kompakt', actor: 'studio' }, 'agent');
  assert.equal(w.call('prefs_get', { workspaceId: w.a, key: 'appearance.density' }, 'studio').pref.value, 'komfortabel');
});

test('scope: a person preference follows the actor across workspaces, a workspace one stays in its workspace', () => {
  const w = world();
  w.call('prefs_set', { workspaceId: w.a, key: 'appearance.theme', value: 'dark' });
  assert.equal(w.call('prefs_get', { workspaceId: w.b, key: 'appearance.theme' }).pref.value, 'dark', 'one theme, every mandate');
  const inA = ctxFor(w.deps, w.a, 'studio');
  const inB = ctxFor(w.deps, w.b, 'studio');
  assert.equal(prefsSet(inA, { key: 'probe.rows', value: 25 }, PROBE).ok, true);
  assert.equal(prefsGet(inA, { key: 'probe.rows' }, PROBE).pref.value, 25);
  assert.equal(prefsGet(inB, { key: 'probe.rows' }, PROBE).pref.value, 10, 'workspace B reads its own default (§H-TENANT)');
  assert.deepEqual(prefsReset(inB, { key: 'probe.rows' }, PROBE).reset, [], 'a reset in B removes nothing of A');
  assert.equal(prefsGet(inA, { key: 'probe.rows' }, PROBE).pref.value, 25);
  assert.deepEqual(
    w.rows('person_workspace_pref').map((r) => [r.workspace_id, r.actor, r.key]),
    [[w.a, 'studio', 'probe.rows']],
  );
  // The other actor in the same workspace reads the default too.
  assert.equal(prefsGet(ctxFor(w.deps, w.a, 'agent'), { key: 'probe.rows' }, PROBE).pref.value, 10);
});

test('every schema shape round-trips through the verbs, and a json value compares by meaning, not key order', () => {
  const w = world();
  const ctx = ctxFor(w.deps, w.a, 'studio');
  const values = { 'probe.colour': 'green', 'probe.rows': 30, 'probe.ratio': 0.75, 'probe.flag': true, 'probe.name': 'Kasse', 'probe.order': ['b', 'a'] };
  for (const [key, value] of Object.entries(values)) {
    assert.equal(prefsSet(ctx, { key, value }, PROBE).changed, true, key);
    assert.deepEqual(prefsGet(ctx, { key }, PROBE).pref.value, value, key);
  }
  const list = prefsList(ctx, {}, PROBE);
  assert.ok(list.prefs.every((p) => p.isDefault === false));
  const obj = prefRegistry([{ ...TEST_DEFS[5], key: 'probe.widths', schema: { type: 'json', root: 'object', maxBytes: 128 }, default: {} }]);
  assert.equal(prefsSet(ctx, { key: 'probe.widths', value: { a: 1, b: 2 } }, obj).changed, true);
  assert.equal(prefsSet(ctx, { key: 'probe.widths', value: { b: 2, a: 1 } }, obj).changed, false);
});

test('a reset clears exactly the stored values, of one key or of one area, and a reset of nothing writes nothing', () => {
  const w = world();
  const ctx = ctxFor(w.deps, w.a, 'studio');
  prefsSet(ctx, { key: 'probe.colour', value: 'green' }, PROBE);
  prefsSet(ctx, { key: 'probe.rows', value: 20 }, PROBE);
  prefsSet(ctx, { key: 'probe.flag', value: true }, PROBE);
  const one = prefsReset(ctx, { key: 'probe.colour' }, PROBE);
  assert.deepEqual([one.reset, one.changed], [['probe.colour'], true]);
  assert.equal(prefsGet(ctx, { key: 'probe.colour' }, PROBE).pref.isDefault, true);
  assert.equal(prefsGet(ctx, { key: 'probe.flag' }, PROBE).pref.value, true, 'the other keys are untouched');
  const area = prefsReset(ctx, { area: 'probe' }, PROBE);
  assert.deepEqual(area.reset.sort(), ['probe.flag', 'probe.rows']);
  assert.ok(prefsList(ctx, {}, PROBE).prefs.every((p) => p.isDefault));
  const nothing = prefsReset(ctx, { area: 'probe' }, PROBE);
  assert.deepEqual([nothing.reset, nothing.changed], [[], false]);
  assert.equal(prefsReset(ctx, {}, PROBE).error, 'invalid_input', 'neither key nor area');
  assert.equal(prefsReset(ctx, { key: 'probe.flag', area: 'probe' }, PROBE).error, 'invalid_input', 'both');
});

test('a stored value that no longer fits reads as the default and is listed stale; a reset clears it', () => {
  const w = world();
  w.deps.store.db
    .prepare('INSERT INTO person_pref (actor, key, value_json, updated_at) VALUES (?, ?, ?, ?)')
    .run('studio', 'appearance.theme', '"sepia"', '2026-07-16T00:00:00.000Z');
  const got = w.call('prefs_get', { workspaceId: w.a, key: 'appearance.theme' }).pref;
  assert.deepEqual([got.value, got.isDefault, got.stale], ['system', true, true]);
  assert.deepEqual(w.call('prefs_reset', { workspaceId: w.a, key: 'appearance.theme' }).reset, ['appearance.theme']);
  assert.equal(w.call('prefs_get', { workspaceId: w.a, key: 'appearance.theme' }).pref.stale, false);
});

test('only a member reaches the verbs: a non-member and the served stranger are refused, a viewer is not', () => {
  const w = world();
  const invited = w.call('invite_member', { workspaceId: w.a, email: 'leser@example.invalid', role: 'viewer', idempotencyKey: 'inv-1' });
  assert.equal(invited.ok, true, JSON.stringify(invited));
  for (const actor of ['member:not-here', 'served:stranger']) {
    for (const [verb, input] of [
      ['prefs_list', {}],
      ['prefs_get', { key: 'appearance.theme' }],
      ['prefs_set', { key: 'appearance.theme', value: 'dark' }],
      ['prefs_reset', { area: 'appearance' }],
    ]) {
      const r = w.call(verb, { workspaceId: w.a, ...input }, actor);
      assert.deepEqual([r.error, r.reason], ['permission_denied', 'not_a_member'], `${actor} ${verb}`);
    }
  }
  // The seated local operator is a member (owner) and keeps working once the workspace is provisioned.
  assert.equal(w.call('prefs_set', { workspaceId: w.a, key: 'appearance.theme', value: 'dark' }, 'studio').ok, true);
  // A served subject never gets the unprovisioned grant (workspace B has no member yet).
  const served = prefsGet(ctxFor(w.deps, w.b, 'member:someone', { identitySource: 'served_subject' }), { key: 'appearance.theme' });
  assert.equal(served.error, 'permission_denied');
});

test('a plugin call may read its installer`s preferences but never change them', () => {
  const w = world();
  const ctx = ctxFor(w.deps, w.a, 'studio');
  withinPluginCall('studio', () => {
    assert.equal(prefsGet(ctx, { key: 'appearance.theme' }).ok, true);
    const set = prefsSet(ctx, { key: 'appearance.theme', value: 'dark' });
    assert.deepEqual([set.error, set.reason], ['capability_forbidden', 'needs_a_person']);
    assert.equal(prefsReset(ctx, { area: 'appearance' }).error, 'capability_forbidden');
  });
  assert.deepEqual(w.rows('person_pref'), []);
});

test('the REST twin and the MCP tool answer exactly what the registry answers', () => {
  const w = world();
  const input = { workspaceId: w.a, key: 'appearance.density', value: 'kompakt' };
  const rest = handleRest('prefs_set', input, { ...w.deps, actor: 'studio' });
  assert.equal(rest.status, 200);
  assert.equal(rest.body.changed, true);
  const viaMcp = JSON.parse(callTool({ ...w.deps, actor: 'studio' }, 'prefs_get', { workspaceId: w.a, key: 'appearance.density' }).content[0].text);
  assert.equal(viaMcp.pref.value, 'kompakt');
  const refused = handleRest('prefs_set', { workspaceId: w.a, key: 'nope.key', value: 1 }, { ...w.deps, actor: 'studio' });
  assert.equal(refused.body.error, 'unknown_pref');
});

test('wiring: ungated at A24 and asserted in the engine, ui-state writes with a way back, never fired by a rule', () => {
  for (const verb of ['prefs_list', 'prefs_get', 'prefs_set', 'prefs_reset']) {
    const rule = CAPABILITY_FOR_ACTION[verb];
    assert.ok(isUngated(rule), verb);
    assert.equal(rule.shape, 'asserted_in_engine', verb);
    assert.deepEqual([...requiredCapabilitiesFor(verb, {})], [], verb);
  }
  for (const verb of ['prefs_set', 'prefs_reset']) {
    const action = getAction(verb);
    assert.deepEqual([action.kind, action.reversibility, action.consequenceTag], ['write', 'reversible', 'ui-state']);
    assert.ok(!('idempotencyKey' in action.inputSchema.properties), `${verb} is a key-exempt absolute setter`);
    assert.ok(NOT_AUTOMATABLE.has(verb));
    assert.deepEqual(NOT_AUTOMATABLE_LEGS[verb], ['d']);
  }
  assert.deepEqual(WAY_BACK.prefs_set, ['self', 'prefs_reset']);
  assert.deepEqual(WAY_BACK.prefs_reset, ['prefs_set']);
});
