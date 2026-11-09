// A41 (D184 point 6), ASK-FIRST settings: until a person answered, the behaviour stays conservative and the
// setting reads `answered: false`; the registry default is only the suggestion. Answering with the
// suggestion is an answer (it is stored), an agent can never answer (human_only), a reset asks again, and
// the answer is per workspace (§H-TENANT).
//
// SYNTHETIC BY CONSTRUCTION: the fixture workspaces and every value here are invented.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { makeContext } from '../../dist/core/context.js';
import { fixture } from '../api/conformance-contract.mjs';
import { mintWorkspace } from '../api/support.mjs';
import { SETTINGS, answeredSetting, assertSettingsRegistry, settingAnswer, settingDef } from '../../dist/core/settings/index.js';

const BULK = 'bank.bulk_learned_min';
const OFFER = 'rules.autobook_offer_after';
// The fixture's default seat is the agent; a person answers as the Studio seat.
const person = (fx, name, input) => getAction(name).run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, ...input });
const ctxOf = (fx, workspaceId = fx.workspaceId) => makeContext(fx.deps.store, { workspaceId, actor: 'studio', clock: fx.deps.clock, ids: fx.deps.ids });

test('the ask-first settings are flagged, human-only, and the registry refuses an ask-first row an agent could answer', () => {
  const askFirst = SETTINGS.filter((s) => s.askFirst === true).map((s) => s.key);
  assert.deepEqual(askFirst.sort(), [BULK, OFFER].sort());
  for (const key of askFirst) assert.equal(settingDef(key).humanOnly, true, `${key} is human-only`);
  assert.equal(settingDef(BULK).default, 5);
  assert.equal(settingDef(OFFER).default, 5, 'the suggestion moved from 10 to 5 (D184 point 6)');
  assert.throws(() => assertSettingsRegistry([{ ...settingDef(BULK), humanOnly: false }]), /humanOnly/);
});

test('unanswered: the behaviour reads null, settings_list names the open questions, the suggestion is shown', () => {
  const fx = fixture();
  const ctx = ctxOf(fx);
  assert.deepEqual(settingAnswer(ctx, BULK), { answered: false, value: 5 });
  assert.equal(answeredSetting(ctx, BULK), null);
  assert.equal(answeredSetting(ctx, OFFER), null);
  // A setting that is not ask first is always answered.
  assert.equal(settingAnswer(ctx, 'checklists.attention_window_days').answered, true);
  const listed = fx.call('settings_list', {});
  assert.deepEqual([...listed.unanswered].sort(), [BULK, OFFER].sort());
  const view = listed.settings.find((s) => s.key === BULK);
  assert.equal(view.askFirst, true);
  assert.equal(view.answered, false);
  assert.equal(view.value, 5, 'the suggestion the question pre-selects');
  assert.equal(fx.call('settings_get', { key: 'checklists.attention_window_days' }).setting.answered, true);
});

test('answering with the suggestion is stored and applies; a reset asks again', () => {
  const fx = fixture();
  const ctx = ctxOf(fx);
  const set = person(fx, 'settings_set', { key: BULK, value: 5, reason: 'Gelernte ab 5', idempotencyKey: 'a1' });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.changed, true, 'the default value as an answer is a change, not a no-op');
  assert.equal(answeredSetting(ctx, BULK), 5);
  assert.equal(fx.call('settings_get', { key: BULK }).setting.answered, true);
  assert.deepEqual(fx.call('settings_list', {}).unanswered, [OFFER]);
  // "Nur sichere" is an answer too: 0.
  person(fx, 'settings_set', { key: BULK, value: 0, reason: 'Nur sichere', idempotencyKey: 'a2' });
  assert.equal(answeredSetting(ctx, BULK), 0);
  person(fx, 'settings_reset', { key: BULK, reason: 'nochmals fragen', idempotencyKey: 'a3' });
  assert.equal(answeredSetting(ctx, BULK), null);
});

test('an agent can never answer an ask-first setting, under any dial (human_only, nothing drafted)', () => {
  const fx = fixture();
  const res = handleRest('settings_set', { workspaceId: fx.workspaceId, key: BULK, value: 1, reason: 'Agent', idempotencyKey: 'ag' }, { ...fx.deps, actor: 'agent' }).body;
  assert.equal(res.ok, false);
  assert.equal(res.error, 'human_only');
  assert.equal(answeredSetting(ctxOf(fx), BULK), null);
  const drafts = fx.deps.store.db.prepare("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND action_tool = 'settings_set'").get(fx.workspaceId).n;
  assert.equal(drafts, 0);
});

test('§H-TENANT: an answer in one workspace leaves the other one asking', () => {
  const fx = fixture();
  person(fx, 'settings_set', { key: OFFER, value: 3, reason: 'früh anbieten', idempotencyKey: 'o1' });
  const { workspaceId: other } = mintWorkspace(fx.deps, 'Zweite Muster GmbH', 'ws-ask-2');
  assert.equal(answeredSetting(ctxOf(fx), OFFER), 3);
  assert.equal(answeredSetting(ctxOf(fx, other), OFFER), null);
  const read = getAction('settings_get').run(fx.deps, { workspaceId: other, key: OFFER });
  assert.equal(read.setting.answered, false);
});
