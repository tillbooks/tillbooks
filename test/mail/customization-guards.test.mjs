/**
 * E04's §6b guards, each an ASSERTION about the flexible surface staying exactly as narrow as the
 * spec declares (zero-egress inversion: fixed unless provably leak-safe):
 *
 *   - the free-text-field refusal: no `custom_field_def` with a free-form type can EVER exist on
 *     the mail-thread kind, refused at runtime by the registry row's own `fieldTypes` fact;
 *   - the no-automation-target rule: all three mail writes are denied to stored rules, at save
 *     time and in the denylist itself;
 *   - the no-send rule at the REGISTRY face: no tool named like a mail send exists;
 *   - the A24 wiring: every mail verb resolves the declared capability, and the G00 verbs scoped
 *     to the mail-thread kind inherit the mail pair rather than any softer domain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installEgressProbe } from './egress-probe.mjs';

const probe = installEgressProbe();

const { ACTIONS, getAction } = await import('../../dist/api/registry.js');
const { NOT_AUTOMATABLE } = await import('../../dist/core/automation/denylist.js');
const { entityKindDef } = await import('../../dist/core/customization/entities.js');
const { CAPABILITY_FOR_ACTION, readCapabilityForKind } = await import('../../dist/core/access/actionCapabilities.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
const { tempStoreDir, makeMaildirStore, sampleMessages } = await import('./fixtures.mjs');

function world() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, call };
}

const LABEL = { 'de-CH': 'Kennzeichnung', en: 'Label' };

test('E04 §6b: every free-form field type is refused on the mail-thread kind, at runtime', () => {
  const { call } = world();
  for (const type of ['text', 'number', 'money', 'contact_ref', 'entity_ref']) {
    const refused = call('define_field', {
      entityKind: 'mail_thread',
      key: `probe_${type}`,
      labelI18n: LABEL,
      type,
      idempotencyKey: `cg-${type}`,
    });
    assert.equal(refused.ok, false, `type ${type} was ACCEPTED on mail_thread: a pasted excerpt could now live in custom_field_value`);
    assert.equal(refused.error, 'type_not_allowed_for_kind');
    assert.deepEqual(refused.allowed, ['select', 'multiselect', 'bool', 'date']);
  }
  // And the four bounded types really are admissible, so the slice is a slice and not a lockout.
  for (const [type, extra] of [
    ['select', { options: ['dringend', 'normal'] }],
    ['multiselect', { options: ['a', 'b'] }],
    ['bool', {}],
    ['date', {}],
  ]) {
    const defined = call('define_field', {
      entityKind: 'mail_thread',
      key: `ok_${type}`,
      labelI18n: LABEL,
      type,
      ...extra,
      idempotencyKey: `cg-ok-${type}`,
    });
    assert.equal(defined.ok, true, `bounded type ${type} was refused: ${JSON.stringify(defined)}`);
  }
});

test('E04 §6b: the registry row itself declares exactly the four bounded types', () => {
  const def = entityKindDef('mail_thread');
  assert.ok(def !== undefined, 'mail_thread is not in the OP3 registry');
  assert.equal(def.table, 'mail_thread');
  assert.equal(def.editCapability, 'mail.write');
  assert.deepEqual([...(def.fieldTypes ?? [])], ['select', 'multiselect', 'bool', 'date']);
});

test('E04 §6b: no automation rule may target any mail write, at save time and in the denylist', () => {
  for (const tool of ['mail_connect', 'mail_reindex', 'mail_draft_write']) {
    assert.equal(NOT_AUTOMATABLE.has(tool), true, `${tool} is missing from NOT_AUTOMATABLE`);
  }
  const { call } = world();
  const refused = call('create_automation_rule', {
    name: 'Entwurf um 03:00',
    trigger: { event: 'invoice.issued' },
    action: { tool: 'mail_draft_write', input: { threadId: 'x', body: 'y' } },
    idempotencyKey: 'cg-auto',
  });
  assert.equal(refused.ok, false, 'a stored rule was allowed to target the draft write-back');
  assert.equal(refused.error, 'action_not_automatable');
});

test('E04: no send-shaped mail tool exists at the registry face, and none may ever land', () => {
  assert.equal(getAction('mail_send'), undefined);
  const sendShaped = ACTIONS.map((a) => a.name).filter((name) => /mail/.test(name) && /send|transmit|smtp/.test(name));
  assert.deepEqual(sendShaped, [], 'a send-shaped mail tool reached the registry');
  // The seven that DO exist, by name, so a rename or a quiet eighth is a conscious edit here.
  const mailTools = ACTIONS.map((a) => a.name).filter((name) => name.startsWith('mail_')).sort();
  assert.deepEqual(mailTools, [
    'mail_accounts_list',
    'mail_connect',
    'mail_draft_write',
    'mail_drafts_list',
    'mail_reindex',
    'mail_thread_get',
    'mail_threads_list',
  ]);
});

test('E04 A24: every mail verb resolves its declared capability, and the G00 seam inherits the pair', () => {
  assert.equal(CAPABILITY_FOR_ACTION.mail_connect, 'mail.write');
  assert.equal(CAPABILITY_FOR_ACTION.mail_draft_write, 'mail.write');
  // A WRITE gating on the READ capability, per the spec's own US-E04.2: the index is derived.
  assert.equal(CAPABILITY_FOR_ACTION.mail_reindex, 'mail.read');
  for (const read of ['mail_accounts_list', 'mail_threads_list', 'mail_thread_get', 'mail_drafts_list']) {
    assert.equal(CAPABILITY_FOR_ACTION[read], 'mail.read', `${read} lost its read gate`);
  }
  // A custom field on a thread is exactly as hard to write as the thread, and exactly as hard to
  // read as the queue: never a softer domain.
  const rule = CAPABILITY_FOR_ACTION.set_field_value;
  assert.equal(rule({ entityKind: 'mail_thread' }), 'mail.write');
  assert.equal(readCapabilityForKind('mail_thread'), 'mail.read');
});

test('E04 OP6: none of the above opened a socket', () => {
  assert.deepEqual(probe.violations, []);
});
