/**
 * D123 (governance critic F3, 2026-09-05): THE MEMBERSHIP VERBS CALLED BY A GOVERNED SEAT ARE
 * DIAL-GOVERNED UNDER `customize`.
 *
 * D50 seats the local `agent` as an owner on every local install, so the governed seat holds
 * `manage_members`, and until this commit `invite_member`, `set_role`, `revoke_member` and
 * `define_role` were outside the dial map: the agent seated a person as `owner` at once, with a trace
 * row and no Vorschlag (critic probe P4), and the branch's premise "the inviter is human" was false on
 * every local install. Now a governed seat PROPOSES a membership change, the human approves it, and the
 * approval replays as the approver, so the invite the human vouched for is created by the human.
 * A human member's call is byte-identical with before: it executes at once.
 *
 * Driven through the REAL transport dispatch (`callTool`) for the governed seat and through the
 * registry for the human, the split the Studio makes. HOW IT BITES: delete the four `customize` entries
 * from `DIAL_CAPABILITY_FOR_ACTION` and the local agent's `invite_member` answers a token with a pending
 * member row and no Vorschlag, `set_role` rewrites the role at once, and the served agent owner seats
 * a person ungoverned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { DIAL_CAPABILITY_FOR_ACTION } from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const MEMBERSHIP_VERBS = ['invite_member', 'set_role', 'revoke_member', 'define_role'];

const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
/** The human decider (studio) acts through the registry directly: no session, no dial. */
const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);

const memberRows = (deps, workspaceId, email) =>
  deps.store.db
    .prepare(
      `SELECT m.id, m.role, m.accepted_at, m.created_by FROM workspace_member m JOIN user u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND u.email = ?`,
    )
    .all(workspaceId, email);

const traceRows = (deps, workspaceId, verb) =>
  deps.store.db
    .prepare('SELECT mode, dial_capability, decision_reason FROM agent_call WHERE workspace_id = ? AND verb = ? ORDER BY id')
    .all(workspaceId, verb);

test('the four membership verbs are mapped under customize and each carries its sentence', () => {
  for (const name of MEMBERSHIP_VERBS) {
    assert.equal(DIAL_CAPABILITY_FOR_ACTION[name], 'customize', `${name} is governed under customize (D123)`);
    const action = getAction(name);
    assert.equal(typeof action.consequence, 'string', `${name}: the engine sentence exists`);
    assert.ok(action.consequence.length > 20, `${name}: a sentence, not a label`);
  }
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.accept_invite, undefined, 'redeeming a token a human issued stays outside the map');
});

test('local agent seat: invite_member at ask DRAFTS and mints nothing; approval creates the invite once; a human is unchanged', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);

  // Premise (D50): the local agent is an owner and holds manage_members, and customize reads ask.
  const me = mcp(deps, 'whoami', { workspaceId });
  assert.ok(me.capabilities.includes('manage_members'), 'premise: the governed seat holds manage_members by D50');
  assert.equal(me.agentDial.customize, 'ask');

  const args = { workspaceId, email: 'neu@seeblick.example', role: 'owner', idempotencyKey: 'inv-neu' };
  const drafted = mcp(deps, 'invite_member', args);
  assert.equal(drafted.ok, true, JSON.stringify(drafted));
  assert.equal(drafted.drafted, true, 'a governed seat proposes a membership change, it does not make one');
  assert.equal(drafted.dialCapability, 'customize');
  assert.equal('token' in drafted, false, 'no token: nothing to redeem yet');
  assert.deepEqual(memberRows(deps, workspaceId, 'neu@seeblick.example'), [], 'no membership row was minted');
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM invite WHERE workspace_id = ?').get(workspaceId).n, 0);
  assert.deepEqual(traceRows(deps, workspaceId, 'invite_member'), [{ mode: 'draft', dial_capability: 'customize', decision_reason: 'dial_ask' }]);

  // Idempotent on the draft: the same key answers the same Vorschlag (F-08 c), never a second one.
  const again = mcp(deps, 'invite_member', args);
  assert.equal(again.actionId, drafted.actionId);
  assert.equal(again.replayed, true);
  assert.equal(human(deps, 'list_drafted_actions', { workspaceId }).actions.length, 1);

  // The agent cannot approve its own proposal (approve rides `manage_agent_dial`, which the governed
  // seat never holds, so the A24 gate answers before the self-approve ban is even asked); the human
  // can, and the replay runs AS the human.
  assert.equal(mcp(deps, 'approve_drafted_action', { workspaceId, actionId: drafted.actionId }).error, 'permission_denied');
  const approved = human(deps, 'approve_drafted_action', { workspaceId, actionId: drafted.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(typeof approved.result.token, 'string', 'the approval hands the human the token to deliver');
  assert.equal(approved.result.kind, 'human');
  const rows = memberRows(deps, workspaceId, 'neu@seeblick.example');
  assert.equal(rows.length, 1, 'exactly one pending membership');
  assert.equal(rows[0].role, 'owner');
  assert.equal(rows[0].accepted_at, null);
  assert.equal(rows[0].created_by, 'studio', 'the inviter of record is the human who approved (P3)');
  // Approve twice, and replay the agent's key after the approval: still one invite, one row.
  assert.equal(human(deps, 'approve_drafted_action', { workspaceId, actionId: drafted.actionId }).ok, true);
  const afterwards = mcp(deps, 'invite_member', args);
  assert.equal(afterwards.token, approved.result.token, 'the same key answers the stored result');
  assert.equal(memberRows(deps, workspaceId, 'neu@seeblick.example').length, 1);
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM invite WHERE workspace_id = ?').get(workspaceId).n, 1);

  // A human member's invite_member is unchanged: it executes at once, through the registry and over MCP
  // as the Studio's own seat alike, and opens no session.
  const direct = human(deps, 'invite_member', { workspaceId, email: 'zwei@seeblick.example', role: 'viewer', idempotencyKey: 'inv-zwei' });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.equal(typeof direct.token, 'string');
  assert.notEqual(direct.drafted, true);
  const viaStudioSeat = mcp({ ...deps, actor: 'studio' }, 'invite_member', { workspaceId, email: 'drei@seeblick.example', role: 'viewer', idempotencyKey: 'inv-drei' });
  assert.equal(typeof viaStudioSeat.token, 'string', 'the studio seat over MCP executes at once');
  assert.notEqual(viaStudioSeat.drafted, true);
  assert.equal(memberRows(deps, workspaceId, 'drei@seeblick.example').length, 1);
  assert.equal(traceRows(deps, workspaceId, 'invite_member').filter((r) => r.mode === 'execute').length, 1, 'only the idempotent replay of the approved draft is an execute row; humans open no session');
  deps.store.close();
});

test('set_role, revoke_member and define_role draft at ask; after an explicit customize grant (D103) they run at auto', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const invited = human(deps, 'invite_member', { workspaceId, email: 'ann@seeblick.example', role: 'viewer', idempotencyKey: 'inv-ann' });
  assert.equal(invited.ok, true, JSON.stringify(invited));
  const memberId = invited.memberId;
  const roleOf = () => deps.store.db.prepare('SELECT role FROM workspace_member WHERE workspace_id = ? AND id = ?').get(workspaceId, memberId)?.role;

  const setRole = mcp(deps, 'set_role', { workspaceId, memberId, role: 'bookkeeper' });
  assert.equal(setRole.drafted, true, JSON.stringify(setRole));
  assert.equal(roleOf(), 'viewer', 'the role did not move');
  const revoke = mcp(deps, 'revoke_member', { workspaceId, memberId });
  assert.equal(revoke.drafted, true, JSON.stringify(revoke));
  assert.equal(roleOf(), 'viewer', 'the member is still there');
  const define = mcp(deps, 'define_role', { workspaceId, roleId: 'auditor', name: 'Prüfer', capabilities: ['read_members'], idempotencyKey: 'role-auditor' });
  assert.equal(define.drafted, true, JSON.stringify(define));
  assert.equal(human(deps, 'list_roles', { workspaceId }).roles.some((r) => r.roleId === 'auditor' || r.id === 'auditor'), false, 'no role was defined');
  assert.equal(human(deps, 'list_drafted_actions', { workspaceId }).actions.length, 3);

  // The human approves the role change: it lands once, as the human.
  const approved = human(deps, 'approve_drafted_action', { workspaceId, actionId: setRole.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(roleOf(), 'bookkeeper');

  // D103: an explicit, attributed grant of `customize` lets the governed seat run these at auto.
  const grant = human(deps, 'set_agent_dial', { workspaceId, capability: 'customize', level: 'auto', idempotencyKey: 'grant-customize' });
  assert.equal(grant.ok, true, JSON.stringify(grant));
  assert.equal(mcp(deps, 'whoami', { workspaceId }).agentDial.customize, 'auto');
  const atAuto = mcp(deps, 'set_role', { workspaceId, memberId, role: 'viewer' });
  assert.equal(atAuto.ok, true, JSON.stringify(atAuto));
  assert.notEqual(atAuto.drafted, true, 'granted: executes, and is traced as an execute under customize');
  assert.equal(roleOf(), 'viewer');
  const executed = traceRows(deps, workspaceId, 'set_role').filter((r) => r.mode === 'execute');
  assert.deepEqual(executed, [{ mode: 'execute', dial_capability: 'customize', decision_reason: 'dial_auto' }]);
  deps.store.close();
});

test('served agent member: with manage_members its invite_member drafts; with the built-in agent role it is denied before any write', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const asOwner = human(deps, 'invite_member', { workspaceId, email: 'bot@seeblick.example', role: 'owner', kind: 'agent', idempotencyKey: 'inv-bot' });
  const asAgent = human(deps, 'invite_member', { workspaceId, email: 'helper@seeblick.example', role: 'agent', kind: 'agent', idempotencyKey: 'inv-helper' });
  assert.equal(asOwner.ok, true, JSON.stringify(asOwner));
  assert.equal(asAgent.ok, true, JSON.stringify(asAgent));
  const served = (subject) => {
    const id = resolveServedActor(deps.store, subject);
    return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
  };
  assert.equal(getAction('accept_invite').run(served('bot@seeblick.example'), { token: asOwner.token }).ok, true);
  assert.equal(getAction('accept_invite').run(served('helper@seeblick.example'), { token: asAgent.token }).ok, true);

  // Critic probe P3b: the served agent invited as OWNER used to seat a person ungoverned.
  const bot = served('bot@seeblick.example');
  const drafted = mcp(bot, 'invite_member', { workspaceId, email: 'person@seeblick.example', role: 'owner', idempotencyKey: 'bot-inv' });
  assert.equal(drafted.ok, true, JSON.stringify(drafted));
  assert.equal(drafted.drafted, true, 'a served agent owner proposes, it does not seat');
  assert.deepEqual(memberRows(deps, workspaceId, 'person@seeblick.example'), []);
  const self = mcp(bot, 'set_role', { workspaceId, memberId: asOwner.memberId, role: 'viewer' });
  assert.equal(self.drafted, true, 'its own row too');

  // The built-in `agent` role lacks manage_members: the A24 gate answers before the dial (registry order).
  const helper = served('helper@seeblick.example');
  const denied = mcp(helper, 'invite_member', { workspaceId, email: 'x@seeblick.example', role: 'viewer', idempotencyKey: 'helper-inv' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'permission_denied');
  assert.deepEqual(traceRows(deps, workspaceId, 'invite_member').map((r) => r.mode), ['draft', 'deny']);
  deps.store.close();
});
