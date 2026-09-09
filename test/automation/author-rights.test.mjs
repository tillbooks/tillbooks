/**
 * A rule cannot outlive its author's rights, and the off switch works without any rights at all.
 *
 * THE CLAIM UNDER TEST. `invokerFor` passes `rule.created_by` as the actor, so the capability is
 * resolved LIVE at the moment of firing through the same shared dispatch a human's call goes through.
 * There is no automation identity and nothing is cached at save time, which means a demoted or revoked
 * author's rules start failing with nothing to invalidate. That is a strong claim and it is the one
 * thing standing between "someone left the company" and "their rules kept posting".
 *
 * ASSERTED ON THE LEDGER, NOT ON THE RESULT. Every refusal below is checked by counting
 * `journal_entry` and `journal_line`, because a verb that refuses in its answer and writes in its body
 * is the shape of defect a `{ ok: false }` assertion sleeps through, and it is the only shape that
 * matters on an append-only ledger. The run row is checked too, because a denial nobody can see is a
 * denial nobody can fix.
 *
 * AND THE LIVENESS IS PROVEN IN BOTH DIRECTIONS. A test that only demotes would pass over an engine
 * that resolved the capability once and cached a `false` for ever. So the author is restored and the
 * same rule, on a new occurrence, has to fire again.
 *
 * THE OFF SWITCH IS THE OTHER HALF, and its asymmetry is deliberate: `disable_automation_rule` is
 * ungated and `enable_automation_rule` is not, so the low-privilege direction is always the safe one.
 * Both are driven through MCP stdio AND the REST twins, because both resolve an `ActionDef` and call
 * `action.run`, and a gate that holds on one door is a gate on neither.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { CAPABILITY_FOR_ACTION, isUngated } from '../../dist/core/access/index.js';
import { call, count, defineRule, postTemplate, runRows, workspaceWhereActorHolds } from './support.mjs';

const ENTRIES = 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?';
const LINES = `SELECT COUNT(*) AS n FROM journal_line
                WHERE entry_id IN (SELECT id FROM journal_entry WHERE workspace_id = ?)`;

/**
 * An actor D13 does not seat, so it can still redeem an invite (both seated actors answer
 * `actor_already_member`). The named-subject shape `src/api/session.ts` anticipates for a cloud tier.
 */
const SECOND_OWNER_ACTOR = 'treuhand:mueller';

/**
 * A workspace holding one posting rule authored by `studio`, with `agent` narrowed to `role`.
 *
 * `agent` is what pulls the trigger and `studio` is what the rule runs as, so the two are genuinely
 * separable: a firing that succeeded because the TRIGGERING actor had the capability would be exactly
 * the confusion this file has to rule out.
 *
 * A SECOND HUMAN OWNER IS SEATED FIRST, and that is a fact about A24 rather than test scaffolding.
 * Narrowing `agent` to a non-owner role leaves `studio` as the only owner, and A24 refuses to demote
 * or revoke the last one (`last_owner`) precisely so a workspace cannot be locked out of itself. So
 * the author is made demotable the way an operator would make it demotable: by inviting someone else
 * to own the workspace. Done through the product's own invite-and-accept flow, never by hand.
 */
function workspaceWithPostingRule(role, seed) {
  const { deps, workspaceId, accId } = workspaceWhereActorHolds(role, seed);

  deps.actor = 'studio';
  const invited = call(deps, 'invite_member', {
    workspaceId,
    email: `${seed}-owner@muster.ch`,
    role: 'owner',
    idempotencyKey: `${seed}-owner-invite`,
  });
  assert.equal(invited.ok, true, `the second owner could not be invited: ${JSON.stringify(invited)}`);
  deps.actor = SECOND_OWNER_ACTOR;
  const accepted = call(deps, 'accept_invite', { token: invited.token });
  assert.equal(accepted.ok, true, `the second owner could not accept: ${JSON.stringify(accepted)}`);

  deps.actor = 'studio';
  const ruleId = defineRule(
    deps,
    workspaceId,
    { name: 'Automatisch buchen', event: 'contact.created', tool: 'post_entry', template: postTemplate(accId) },
    `${seed}-rule`,
  );
  assert.equal(
    deps.store.db.prepare('SELECT created_by FROM automation_rule WHERE id = ?').get(ruleId).created_by,
    'studio',
    'the rule did not record its author, so there is nothing to resolve against',
  );
  return { deps, workspaceId, accId, ruleId };
}

/** Pull the trigger as `agent`, which is a different identity from the rule's author. */
function trigger(deps, workspaceId, seed, name = 'Auslöser AG') {
  deps.actor = 'agent';
  const res = call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name, idempotencyKey: seed });
  assert.equal(res.ok, true, `the trigger itself was refused: ${JSON.stringify(res)}`);
  return res;
}

test("A24 x G01: DEMOTING the author stops the rule posting, and the ledger proves it", () => {
  const { deps, workspaceId, ruleId } = workspaceWithPostingRule('bookkeeper', 'ar-demote');

  // While the author still holds `post`, the rule works. Without this the test below would pass over
  // a rule that never fired for some entirely different reason.
  trigger(deps, workspaceId, 'ar-demote-a', 'Vorher AG');
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'the rule never fired even before the demotion');
  assert.equal(count(deps, LINES, workspaceId), 2);

  // Now narrow the AUTHOR. `viewer` holds every read domain but `read_members`, and no write at all.
  deps.actor = 'studio';
  const members = call(deps, 'list_members', { workspaceId });
  const authorSeat = members.members.find((m) => m.actorId === 'studio');
  assert.ok(authorSeat !== undefined);
  assert.equal(call(deps, 'set_role', { workspaceId, memberId: authorSeat.memberId, role: 'viewer' }).ok, true);

  trigger(deps, workspaceId, 'ar-demote-b', 'Nachher AG');

  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'a demoted author kept posting');
  assert.equal(count(deps, LINES, workspaceId), 2, 'a demoted author wrote journal lines');

  const rows = runRows(deps, workspaceId);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].status, 'failed');
  assert.equal(rows[1].error_code, 'permission_denied', 'the run log does not say WHY the rule stopped');
  assert.equal(rows[1].rule_id, ruleId);
  assert.equal(rows[1].actor, 'studio', 'the run ran as the trigger-puller rather than as the author');
});

test('A24 x G01: REVOKING the author stops the rule, and the ledger proves that too', () => {
  const { deps, workspaceId } = workspaceWithPostingRule('bookkeeper', 'ar-revoke');
  trigger(deps, workspaceId, 'ar-revoke-a', 'Vorher AG');
  assert.equal(count(deps, ENTRIES, workspaceId), 1);

  deps.actor = 'studio';
  const members = call(deps, 'list_members', { workspaceId });
  const authorSeat = members.members.find((m) => m.actorId === 'studio');
  const revoked = call(deps, 'revoke_member', { workspaceId, memberId: authorSeat.memberId });
  assert.equal(revoked.ok, true, `revoke failed: ${JSON.stringify(revoked)}`);

  trigger(deps, workspaceId, 'ar-revoke-b', 'Nachher AG');

  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'a revoked author kept posting');
  assert.equal(count(deps, LINES, workspaceId), 2);
  const rows = runRows(deps, workspaceId);
  assert.equal(rows[rows.length - 1].status, 'failed');
  assert.equal(rows[rows.length - 1].error_code, 'permission_denied');
});

test('A24 x G01: the capability is resolved LIVE, so restoring the author restores the rule', () => {
  // The other direction, and the one a demotion-only test cannot make. An engine that resolved the
  // capability once at save time and cached a `false` would pass both tests above and fail here.
  const { deps, workspaceId } = workspaceWithPostingRule('bookkeeper', 'ar-live');

  deps.actor = 'studio';
  const members = call(deps, 'list_members', { workspaceId });
  const authorSeat = members.members.find((m) => m.actorId === 'studio');
  assert.equal(call(deps, 'set_role', { workspaceId, memberId: authorSeat.memberId, role: 'viewer' }).ok, true);

  trigger(deps, workspaceId, 'ar-live-a', 'Gesperrt AG');
  assert.equal(count(deps, ENTRIES, workspaceId), 0, 'the demoted author posted');

  // The SECOND owner restores the author, because a demoted `studio` is a viewer and cannot restore
  // itself. That is A24 working, not scaffolding: a role change is `manage_members`, and the whole
  // point of demoting someone is that they cannot undo it.
  deps.actor = SECOND_OWNER_ACTOR;
  assert.equal(call(deps, 'set_role', { workspaceId, memberId: authorSeat.memberId, role: 'bookkeeper' }).ok, true);

  trigger(deps, workspaceId, 'ar-live-b', 'Wieder frei AG');
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'the restored author is still locked out, so the grant is cached');

  assert.deepEqual(
    runRows(deps, workspaceId).map((r) => [r.status, r.error_code]),
    [
      ['failed', 'permission_denied'],
      ['ok', null],
    ],
  );
});

// --- The off switch -----------------------------------------------------------------------------

test('G01: the stop button is UNGATED and the start button is not, by the declared map', () => {
  // Derived from the map the dispatch really reads, so the asymmetry cannot drift away from the two
  // tests below without reddening this one first.
  assert.equal(
    isUngated(CAPABILITY_FOR_ACTION.disable_automation_rule),
    true,
    'a stop button that requires a permission is not a stop button',
  );
  assert.equal(isUngated(CAPABILITY_FOR_ACTION.enable_automation_rule), false);
  assert.equal(CAPABILITY_FOR_ACTION.enable_automation_rule, 'manage_automations');

  // And the stop button stays AIMABLE. A rule can only be halted by its `ruleId`, and the only source
  // of a `ruleId` is `list_automation_rules`. A viewer without `read_automations` would hold a stop
  // button it could never aim, which is the same as not holding one. Read through `whoami` rather
  // than off the constant, because what a viewer RESOLVES to is the product's answer and the
  // constant is only one input to it.
  const { deps, workspaceId } = workspaceWhereActorHolds('viewer', 'ar-aimable');
  deps.actor = 'agent';
  const me = call(deps, 'whoami', { workspaceId });
  assert.equal(me.ok, true, JSON.stringify(me));
  assert.equal(me.role, 'viewer');
  assert.ok(
    me.capabilities.includes('read_automations'),
    'a viewer cannot read the rule list, so the ungated stop button is unreachable',
  );
  assert.equal(
    me.capabilities.includes('manage_automations'),
    false,
    'a viewer holding manage_automations would make the asymmetry below untestable',
  );
});

test('G01: a viewer may STOP a rule through both doors, and may not start it through either', () => {
  const { deps, workspaceId } = workspaceWithPostingRule('viewer', 'ar-switch');
  const ruleId = deps.store.db.prepare('SELECT id FROM automation_rule WHERE workspace_id = ?').get(workspaceId).id;
  const enabledNow = () => deps.store.db.prepare('SELECT enabled FROM automation_rule WHERE id = ?').get(ruleId).enabled;

  deps.actor = 'agent'; // narrowed to `viewer` by the fixture
  assert.equal(enabledNow(), 1);

  // The viewer can find the rule at all, which is what makes the stop button aimable.
  const listed = call(deps, 'list_automation_rules', { workspaceId });
  assert.equal(listed.ok, true, `a viewer cannot read the rule list: ${JSON.stringify(listed)}`);
  assert.deepEqual(listed.rules.map((r) => r.ruleId), [ruleId]);

  // STOP, through MCP stdio.
  const stopMcp = JSON.parse(callTool(deps, 'disable_automation_rule', { workspaceId, ruleId }).content[0].text);
  assert.equal(stopMcp.ok, true, `a viewer was refused the stop button: ${JSON.stringify(stopMcp)}`);
  assert.equal(enabledNow(), 0, 'the stop button answered ok and changed nothing');

  // START, through both doors: refused, and the row does not move.
  const startMcp = JSON.parse(callTool(deps, 'enable_automation_rule', { workspaceId, ruleId }).content[0].text);
  assert.equal(startMcp.ok, false, 'a viewer restarted a rule');
  assert.equal(startMcp.error, 'permission_denied');
  assert.equal(enabledNow(), 0);

  const startRest = handleRest('enable_automation_rule', { workspaceId, ruleId }, deps);
  assert.equal(startRest.status, 422, 'a verb rejection is 422 on the REST twin');
  assert.equal(startRest.body.error, 'permission_denied');
  assert.equal(enabledNow(), 0, 'the REST door restarted a rule the MCP door refused');

  // STOP again, through REST, so both doors are proven on both directions.
  assert.equal(call(deps, 'enable_automation_rule', { workspaceId, ruleId }).ok, false);
  const stopRest = handleRest('disable_automation_rule', { workspaceId, ruleId }, deps);
  assert.equal(stopRest.status, 200);
  assert.equal(enabledNow(), 0);
});

test('G01: a stopped rule really stops, measured on the ledger and not on the flag', () => {
  // The flag is the mechanism; not posting is the property. They are only the same thing if the fire
  // path reads the flag, which is what this asserts.
  const { deps, workspaceId } = workspaceWithPostingRule('bookkeeper', 'ar-stopped');
  trigger(deps, workspaceId, 'ar-stopped-a', 'Vorher AG');
  assert.equal(count(deps, ENTRIES, workspaceId), 1);

  const ruleId = deps.store.db.prepare('SELECT id FROM automation_rule WHERE workspace_id = ?').get(workspaceId).id;
  assert.equal(call(deps, 'disable_automation_rule', { workspaceId, ruleId }).ok, true);

  trigger(deps, workspaceId, 'ar-stopped-b', 'Nachher AG');
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'a disabled rule posted');
  // And it is silent rather than merely unsuccessful: a disabled rule is not evaluated at all, so it
  // writes no run row of any status.
  assert.equal(runRows(deps, workspaceId).length, 1, 'a disabled rule was still evaluated');
});
