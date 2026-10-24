// D172, the workspace settings registry: the business rules of the four verbs and the typed accessor.
//
// The conformance floor already holds append-only, idempotent-on-rows and §H-TENANT over every verb in
// ACTIONS. These tests state what the REGISTRY promises on top: a missing row reads the default, an unknown
// key is refused, a value is checked against its key's schema, a reason is required, every accepted change
// is audited with its old and new value, a replay writes nothing, the owning capability gates the change,
// a governed seat drafts under the key's dial family, a person's change after a proposal makes the approval
// stale, a rule can never fire a change, and the seed entry really drives the Pendenzen look-ahead.
//
// SYNTHETIC BY CONSTRUCTION: the fixture workspace and every value here are invented.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { makeContext } from '../../dist/core/context.js';
import { fixture } from '../api/conformance-contract.mjs';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { attentionList } from '../../dist/core/attention/index.js';
import {
  SETTINGS,
  assertSettingsRegistry,
  getSetting,
  settingDef,
  valueFitsSchema,
} from '../../dist/core/settings/index.js';
import { CAPABILITY_FOR_ACTION, requiredCapabilitiesFor } from '../../dist/core/access/actionCapabilities.js';
import { dialCapabilitiesForCall } from '../../dist/core/agent/dialMap.js';
import { NOT_AUTOMATABLE, NOT_AUTOMATABLE_LEGS } from '../../dist/core/automation/denylist.js';
import { WAY_BACK } from '../../dist/core/agent/wayBack.js';
import { CHECKLIST_DUE_WINDOW_DAYS, CHECKLIST_DUE_WINDOW_SETTING } from '../../dist/core/checklists/index.js';

const KEY = 'checklists.attention_window_days';

const counts = (fx) => ({
  rows: fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace_setting WHERE workspace_id = ?').get(fx.workspaceId).n,
  history: fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace_setting_change WHERE workspace_id = ?').get(fx.workspaceId).n,
  audit: fx.deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND entity_kind = 'workspace_setting'")
    .get(fx.workspaceId).n,
});

const ctxOf = (fx) => makeContext(fx.deps.store, { workspaceId: fx.workspaceId, actor: fx.deps.actor ?? 'studio', clock: fx.deps.clock, ids: fx.deps.ids });

test('the registry is well formed, and every entry has a default that fits its own schema', () => {
  assert.ok(SETTINGS.length >= 1, 'the registry carries at least its seed entry');
  assertSettingsRegistry(SETTINGS);
  for (const s of SETTINGS) {
    assert.ok(Object.prototype.hasOwnProperty.call(s, 'default'), `${s.key}: has a default`);
    assert.equal(valueFitsSchema(s.schema, s.default), true, `${s.key}: the default fits the schema`);
  }
  // The check bites: a row without a default, a default outside its bounds, a duplicate key, each throws.
  const seed = settingDef(KEY);
  const { default: _dropped, ...noDefault } = seed;
  assert.throws(() => assertSettingsRegistry([noDefault]), /default/);
  assert.throws(() => assertSettingsRegistry([{ ...seed, default: 91 }]), /default/);
  assert.throws(() => assertSettingsRegistry([seed, seed]), /twice/);
  assert.throws(() => assertSettingsRegistry([{ ...seed, key: 'NoDot' }]), /key/);
});

test('the seed entry is the Pendenzen look-ahead for checklist steps: 14 days, 1 to 90, owned by manage_checklists', () => {
  const s = settingDef(KEY);
  assert.equal(s.default, 14);
  assert.deepEqual(s.schema, { type: 'integer', min: 1, max: 90, unit: 'days' });
  assert.equal(s.owningCapability, 'manage_checklists');
  assert.equal(s.dialCapability, 'customize');
  assert.equal(CHECKLIST_DUE_WINDOW_SETTING, KEY);
  assert.equal(CHECKLIST_DUE_WINDOW_DAYS, 14, 'the exported default is the registry default');
});

test('a missing row reads the default; settings_list says so for every registry key', () => {
  const fx = fixture();
  const listed = fx.call('settings_list', {});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.settings.map((s) => s.key), SETTINGS.map((s) => s.key));
  for (const s of listed.settings) {
    assert.equal(s.overridden, false);
    assert.equal(s.value, s.default);
    assert.equal(s.updatedAt, null);
  }
  assert.equal(getSetting(ctxOf(fx), KEY), 14);
  assert.deepEqual(counts(fx), { rows: 0, history: 0, audit: 0 }, 'a read writes nothing');
});

test('settings_set stores the value, records old, new, actor and reason, and audits once; settings_get reads it back', () => {
  const fx = fixture();
  const set = fx.call('settings_set', { key: KEY, value: 21, reason: 'Monatsabschluss früher sehen', idempotencyKey: 's1' });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.deepEqual({ ...set, changeId: typeof set.changeId }, { ok: true, key: KEY, value: 21, previousValue: 14, overridden: true, changed: true, changeId: 'string' });
  assert.equal(getSetting(ctxOf(fx), KEY), 21);
  const got = fx.call('settings_get', { key: KEY });
  assert.equal(got.setting.value, 21);
  assert.equal(got.setting.default, 14);
  assert.equal(got.setting.overridden, true);
  assert.equal(typeof got.setting.updatedBy, 'string');
  const hist = fx.deps.store.db.prepare('SELECT kind, old_value_json, new_value_json, reason, actor FROM workspace_setting_change WHERE workspace_id = ?').all(fx.workspaceId);
  assert.deepEqual(hist.map((h) => ({ ...h })), [{ kind: 'set', old_value_json: null, new_value_json: '21', reason: 'Monatsabschluss früher sehen', actor: got.setting.updatedBy }]);
  assert.deepEqual(counts(fx), { rows: 1, history: 1, audit: 1 });

  // A second change names the first value as old.
  fx.call('settings_set', { key: KEY, value: 30, reason: 'noch früher', idempotencyKey: 's2' });
  const last = fx.deps.store.db.prepare("SELECT old_value_json, new_value_json FROM workspace_setting_change WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 1").get(fx.workspaceId);
  assert.deepEqual({ ...last }, { old_value_json: '21', new_value_json: '30' });
});

test('idempotent on rows: a replayed key answers the stored result and writes nothing; the same value again is a no-op', () => {
  const fx = fixture();
  const first = fx.call('settings_set', { key: KEY, value: 21, reason: 'r', idempotencyKey: 'k' });
  const before = counts(fx);
  const again = fx.call('settings_set', { key: KEY, value: 21, reason: 'r', idempotencyKey: 'k' });
  assert.deepEqual(again, first);
  assert.deepEqual(counts(fx), before);
  const same = fx.call('settings_set', { key: KEY, value: 21, reason: 'nochmals', idempotencyKey: 'k2' });
  assert.equal(same.ok, true);
  assert.equal(same.changed, false);
  assert.deepEqual(counts(fx), before, 'setting the value in force records nothing');
  const defaultNoRow = fixture();
  const noop = defaultNoRow.call('settings_set', { key: KEY, value: 14, reason: 'Standard', idempotencyKey: 'd' });
  assert.equal(noop.changed, false, 'setting the default while no override exists records nothing');
  assert.deepEqual(counts(defaultNoRow), { rows: 0, history: 0, audit: 0 });
});

test('refusals write nothing: unknown_setting, invalid_setting_value, reason_required, invalid_input', () => {
  const fx = fixture();
  const refuse = (input, code) => {
    const r = fx.call('settings_set', { idempotencyKey: `x-${code}-${JSON.stringify(input.value)}`, ...input });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, code, JSON.stringify(r));
  };
  refuse({ key: 'checklists.nope', value: 1, reason: 'r' }, 'unknown_setting');
  refuse({ key: KEY, value: 0, reason: 'r' }, 'invalid_setting_value');
  refuse({ key: KEY, value: 91, reason: 'r' }, 'invalid_setting_value');
  refuse({ key: KEY, value: 14.5, reason: 'r' }, 'invalid_setting_value');
  refuse({ key: KEY, value: '21', reason: 'r' }, 'invalid_setting_value');
  refuse({ key: KEY, value: true, reason: 'r' }, 'invalid_setting_value');
  refuse({ key: KEY, value: 21, reason: '   ' }, 'reason_required');
  refuse({ key: KEY, value: 21 }, 'reason_required');
  assert.equal(fx.call('settings_get', { key: 'unknown.key' }).error, 'unknown_setting');
  assert.equal(fx.call('settings_reset', { key: 'unknown.key', reason: 'r', idempotencyKey: 'u' }).error, 'unknown_setting');
  assert.equal(fx.call('settings_reset', { key: KEY, reason: '  ', idempotencyKey: 'u2' }).error, 'reason_required');
  assert.equal(fx.call('settings_reset', { key: KEY, reason: '', idempotencyKey: 'u3' }).error, 'reason_required');
  assert.equal(fx.call('settings_reset', { key: KEY, idempotencyKey: 'u4' }).error, 'reason_required');
  assert.deepEqual(counts(fx), { rows: 0, history: 0, audit: 0 });
});

test('settings_reset removes the override, records the removed value, and a reset with no override is a no-op', () => {
  const fx = fixture();
  fx.call('settings_set', { key: KEY, value: 45, reason: 'Quartal', idempotencyKey: 'a' });
  const reset = fx.call('settings_reset', { key: KEY, reason: 'zurück zum Standard', idempotencyKey: 'b' });
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal(reset.value, 14);
  assert.equal(reset.previousValue, 45);
  assert.equal(reset.changed, true);
  assert.equal(getSetting(ctxOf(fx), KEY), 14);
  const last = fx.deps.store.db.prepare('SELECT kind, old_value_json, new_value_json FROM workspace_setting_change WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 1').get(fx.workspaceId);
  assert.deepEqual({ ...last }, { kind: 'reset', old_value_json: '45', new_value_json: null });
  assert.deepEqual(counts(fx), { rows: 0, history: 2, audit: 2 });
  const noop = fx.call('settings_reset', { key: KEY, reason: 'nochmals', idempotencyKey: 'c' });
  assert.equal(noop.changed, false);
  assert.deepEqual(counts(fx), { rows: 0, history: 2, audit: 2 });
});

test('the history is append-only by trigger', () => {
  const fx = fixture();
  fx.call('settings_set', { key: KEY, value: 21, reason: 'r', idempotencyKey: 'a' });
  const db = fx.deps.store.db;
  assert.throws(() => db.prepare("UPDATE workspace_setting_change SET reason = 'x'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM workspace_setting_change').run(), /append-only/);
});

test('§H-TENANT: a setting in one workspace is invisible to another', () => {
  const fx = fixture();
  fx.call('settings_set', { key: KEY, value: 60, reason: 'r', idempotencyKey: 'a' });
  const { workspaceId: other } = mintWorkspace(fx.deps, 'Zweite GmbH', 'ws-settings-2');
  const read = getAction('settings_get').run(fx.deps, { workspaceId: other, key: KEY });
  assert.equal(read.setting.value, 14);
  assert.equal(read.setting.overridden, false);
});

test('a stored value that no longer fits its schema reads as the default, never throws', () => {
  const fx = fixture();
  fx.call('settings_set', { key: KEY, value: 21, reason: 'r', idempotencyKey: 'a' });
  fx.deps.store.db.prepare("UPDATE workspace_setting SET value_json = '500' WHERE workspace_id = ?").run(fx.workspaceId);
  assert.equal(getSetting(ctxOf(fx), KEY), 14);
  fx.deps.store.db.prepare("UPDATE workspace_setting SET value_json = 'not json' WHERE workspace_id = ?").run(fx.workspaceId);
  assert.equal(fx.call('settings_get', { key: KEY }).setting.value, 14);
  assert.throws(() => getSetting(ctxOf(fx), 'checklists.typo'), /not in the settings registry/);
});

test('A24: reading is read_master_data; a change needs the capability that owns the key', () => {
  assert.equal(CAPABILITY_FOR_ACTION.settings_list, 'read_master_data');
  assert.equal(CAPABILITY_FOR_ACTION.settings_get, 'read_master_data');
  assert.deepEqual([...requiredCapabilitiesFor('settings_set', { key: KEY })], ['manage_checklists']);
  assert.deepEqual([...requiredCapabilitiesFor('settings_reset', { key: KEY })], ['manage_checklists']);
  assert.deepEqual([...requiredCapabilitiesFor('settings_set', { key: 'unknown.key' })], ['manage_settings']);
  // Measured: a seat moved onto the viewer role reads the setting and is refused the change.
  const fx = fixture();
  getAction('invite_member').run(fx.deps, { workspaceId: fx.workspaceId, email: 'leser@muster.example', role: 'bookkeeper', idempotencyKey: 'inv' });
  const seat = getAction('list_members').run(fx.deps, { workspaceId: fx.workspaceId }).members.find((m) => m.actorId === 'agent');
  assert.ok(seat, 'the agent seat exists');
  assert.equal(getAction('set_role').run(fx.deps, { workspaceId: fx.workspaceId, memberId: seat.memberId, role: 'viewer' }).ok, true);
  const viewer = { ...fx.deps, actor: 'agent' };
  assert.equal(getAction('settings_get').run(viewer, { workspaceId: fx.workspaceId, key: KEY }).ok, true);
  const denied = getAction('settings_set').run(viewer, { workspaceId: fx.workspaceId, key: KEY, value: 21, reason: 'r', idempotencyKey: 'v' });
  assert.equal(denied.error, 'permission_denied', JSON.stringify(denied));
});

test('the dial: a governed seat drafts a change under the key family (customize for the seed), and the approval applies it', () => {
  assert.deepEqual(dialCapabilitiesForCall('settings_set', { key: KEY, value: 21, reason: 'r' }), ['customize']);
  assert.deepEqual(dialCapabilitiesForCall('settings_reset', { key: KEY, reason: 'r' }), ['customize']);
  // A reasonless call is never drafted: the verb refuses it reason_required and writes nothing.
  assert.deepEqual(dialCapabilitiesForCall('settings_set', { key: KEY, value: 21 }), []);
  const fx = fixture();
  const drafted = handleRest('settings_set', { workspaceId: fx.workspaceId, key: KEY, value: 21, reason: 'Agent schlägt vor', idempotencyKey: 'ag' }, { ...fx.deps, actor: 'agent' }).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted).slice(0, 300));
  assert.equal(getSetting(ctxOf(fx), KEY), 14, 'nothing changed before the approval');
  const approved = getAction('approve_drafted_action').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, actionId: drafted.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved).slice(0, 300));
  assert.equal(getSetting(ctxOf(fx), KEY), 21);
});

test('the pin: a person changing the setting after the proposal makes the approval refuse vorschlag_stale', () => {
  const fx = fixture();
  const drafted = handleRest('settings_set', { workspaceId: fx.workspaceId, key: KEY, value: 21, reason: 'Agent', idempotencyKey: 'ag' }, { ...fx.deps, actor: 'agent' }).body;
  assert.equal(drafted.drafted, true);
  assert.equal(fx.call('settings_set', { key: KEY, value: 60, reason: 'Mensch entscheidet', idempotencyKey: 'h' }).ok, true);
  const decided = getAction('approve_drafted_action').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, actionId: drafted.actionId });
  assert.equal(decided.error, 'vorschlag_stale', JSON.stringify(decided).slice(0, 300));
  assert.equal(getSetting(ctxOf(fx), KEY), 60, 'the person\'s value stands');
});

test('G01: no rule may fire a settings change (leg e); the way back is a set or a reset', () => {
  assert.ok(NOT_AUTOMATABLE.has('settings_set'));
  assert.ok(NOT_AUTOMATABLE.has('settings_reset'));
  assert.deepEqual(NOT_AUTOMATABLE_LEGS.settings_set, ['e']);
  assert.deepEqual(NOT_AUTOMATABLE_LEGS.settings_reset, ['e']);
  assert.deepEqual(WAY_BACK.settings_set, ['self', 'settings_reset']);
  assert.deepEqual(WAY_BACK.settings_reset, ['settings_set']);
});

test('end to end: the setting drives the Pendenzen look-ahead for due checklist steps', () => {
  // A configured effektiv/soll workspace at the fixture clock (2026-07-16). The 2026-Q2 MWST checklist
  // has open steps due 2026-07-30 (inside the 14-day default) and 2026-08-29 (outside it).
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Vorschau GmbH', 'settings-e2e');
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  assert.equal(call('vat_seed_defaults', {}).ok, true);
  assert.equal(call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }).ok, true);
  assert.equal(call('checklist_start', { templateId: 'vat_period', period: '2026-Q2', idempotencyKey: 'e2e-start' }).ok, true);
  const ctx = makeContext(deps.store, { workspaceId, actor: 'studio', clock: deps.clock, ids: deps.ids });
  const dueDates = () => {
    const r = attentionList(ctx, { queueId: 'checklist_items_due', limit: 200 });
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    return r.items.length;
  };
  const atDefault = dueDates();
  assert.ok(atDefault >= 1, 'the 2026-07-30 steps are due within the 14-day default');
  assert.equal(call('settings_set', { key: KEY, value: 45, reason: 'ein Monat mehr', idempotencyKey: 'w1' }).ok, true);
  const atLong = dueDates();
  assert.ok(atLong > atDefault, `45 days also lists the 2026-08-29 steps (${atLong} > ${atDefault})`);
  assert.equal(call('settings_set', { key: KEY, value: 1, reason: 'nur morgen', idempotencyKey: 'w2' }).ok, true);
  assert.equal(dueDates(), 0, 'one day lists nothing: no step is overdue or due tomorrow');
  assert.equal(call('settings_reset', { key: KEY, reason: 'Standard', idempotencyKey: 'w3' }).ok, true);
  assert.equal(dueDates(), atDefault, 'the reset restores the default window');
});

test('critic D172 r1: a missing reason answers reason_required on the REST face, the MCP registry face and the engine alike', async () => {
  const fx = fixture();
  const body = handleRest('settings_set', { workspaceId: fx.workspaceId, key: KEY, value: 21, idempotencyKey: 'rest' }, fx.deps).body;
  assert.equal(body.error, 'reason_required', JSON.stringify(body));
  const viaRun = getAction('settings_reset').run(fx.deps, { workspaceId: fx.workspaceId, key: KEY, idempotencyKey: 'run' });
  assert.equal(viaRun.error, 'reason_required', JSON.stringify(viaRun));
  const { settingsSet } = await import('../../dist/core/settings/index.js');
  assert.equal(settingsSet(ctxOf(fx), { key: KEY, value: 21, idempotencyKey: 'eng' }).error, 'reason_required');
});

test('critic D172 r1: a stored override that no longer fits is visible as stale with the ignored raw value, and a reset clears it', () => {
  const fx = fixture();
  fx.call('settings_set', { key: KEY, value: 21, reason: 'r', idempotencyKey: 'a' });
  fx.deps.store.db.prepare("UPDATE workspace_setting SET value_json = '120' WHERE workspace_id = ?").run(fx.workspaceId);
  const got = fx.call('settings_get', { key: KEY }).setting;
  assert.equal(got.value, 14, 'the default applies');
  assert.equal(got.overridden, false);
  assert.equal(got.stale, true);
  assert.equal(got.ignoredStoredValue, '120');
  const listed = fx.call('settings_list', {}).settings.find((s) => s.key === KEY);
  assert.equal(listed.stale, true);
  assert.equal(listed.ignoredStoredValue, '120');
  const reset = fx.call('settings_reset', { key: KEY, reason: 'passt nicht mehr', idempotencyKey: 'b' });
  assert.equal(reset.changed, true, 'the misfit row is removed by a reset');
  const after = fx.call('settings_get', { key: KEY }).setting;
  assert.deepEqual([after.stale, after.ignoredStoredValue], [false, null]);
  const fresh = fixture().call('settings_get', { key: KEY }).setting;
  assert.deepEqual([fresh.stale, fresh.ignoredStoredValue], [false, null]);
});
