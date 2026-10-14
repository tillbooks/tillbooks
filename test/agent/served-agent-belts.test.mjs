/**
 * THE IN-VERB P8 BELTS READ THE ONE GOVERNED-SEAT RULE (D156 follow-up, the mechanical fixes).
 *
 * Two engine belts predate A35's dial and compared the actor string with `agent`: an agent-authored
 * automation rule lands DISABLED (G01 P8), and an agent-authored custom field lands as a DRAFT (G00
 * P8). A served agent member (`member:<user_id>`, its `user` row of kind `agent`) passed both as a
 * person: its rule was enabled at once and its field went live. Both now read `isGovernedSeat`.
 * Driven past the transport seam (`action.run`) on purpose: the belt is what holds for an embedder
 * that never meets the dial. A served HUMAN member is unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);

function servedMember(deps, workspaceId, email, kind) {
  const invite = human(deps, 'invite_member', { workspaceId, email, role: 'owner', kind, idempotencyKey: `inv-${email}` });
  assert.equal(invite.ok, true, JSON.stringify(invite));
  const served = () => {
    const id = resolveServedActor(deps.store, email);
    return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
  };
  assert.equal(getAction('accept_invite').run(served(), { token: invite.token }).ok, true);
  return served();
}

test('a served agent member: its automation rule lands disabled and its custom field lands as a draft; a served human is unchanged', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const bot = servedMember(deps, workspaceId, 'bot@seeblick.example', 'agent');
  const person = servedMember(deps, workspaceId, 'person@seeblick.example', 'human');

  const rule = (who, key) =>
    getAction('create_automation_rule').run(who, {
      workspaceId,
      name: `Regel ${key}`,
      trigger: { event: 'contact.created' },
      action: { tool: 'contacts_tag', inputTemplate: { contactId: 'x', segments: ['a'] } },
      enabled: true,
      idempotencyKey: `rule-${key}`,
    });
  const botRule = rule(bot, 'bot');
  assert.equal(botRule.ok, true, JSON.stringify(botRule));
  assert.equal(botRule.rule.enabled, false, 'enabled:true from an agent seat does not switch its rule on');
  const personRule = rule(person, 'person');
  assert.equal(personRule.rule.enabled, true, 'a person may author an enabled rule');

  const field = (who, key) =>
    getAction('define_field').run(who, {
      workspaceId,
      entityKind: 'contact',
      key,
      labelI18n: { 'de-CH': key, en: key },
      type: 'text',
      idempotencyKey: `field-${key}`,
    });
  const botField = field(bot, 'botfeld');
  assert.equal(botField.ok, true, JSON.stringify(botField));
  assert.equal(botField.fieldDef.draft, true, 'an agent-authored field is a draft until a person releases it');
  assert.equal(field(person, 'personfeld').fieldDef.draft, false);
  deps.store.close();
});
