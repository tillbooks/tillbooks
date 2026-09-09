/**
 * A24's provisioning edge: the moment a workspace stops being ungated, from both sides.
 *
 * THIS IS THE HIGHEST-RISK MOMENT IN THE WHOLE CAPABILITY, and it is worth saying why in one
 * paragraph rather than leaving it to be re-derived. A workspace with zero rows in
 * `workspace_member` GRANTS EVERYTHING, to any actor, on every verb. That is not a default that
 * slipped through: it is the state of every workspace that exists today, because A24 is the first
 * thing that ever writes such a row, and denying there would lock every existing book out of its own
 * ledger on the next release. From the moment ONE member row exists the matrix is authoritative.
 *
 * So the capability has three states and exactly one transition between the first two, and each has
 * a way of being wrong that the other two would not notice:
 *
 *   1. UNPROVISIONED. Everything is granted. A regression here does not fail loudly, it locks people
 *      out, and the first person to notice is an operator who cannot post to their own book.
 *   2. THE FLIP, `invite_member`. It seats EVERY D13 actor as an accepted owner before it writes the
 *      invitee's pending row, so "a workspace with a pending invite and nobody in charge" is a state
 *      this engine cannot produce. A regression here is the opposite failure: an operator invites a
 *      bookkeeper and locks somebody out of their own books in the same call.
 *   3. PROVISIONED. The matrix decides, and the transition is ONE-WAY: `revoke_member` and `setRole`
 *      both refuse `last_owner`, so no sequence of verbs walks a provisioned workspace back into the
 *      ungated state. That is asserted here by trying, not by reading the rail's source.
 *
 * The flip is also the one place in the product where an idempotent replay crosses a state boundary,
 * which is why it is counted on the ROWS below and not on the returned id.
 *
 * UPDATED FOR D50 (owner-decided 29.07.2026), and the assertions that moved are named here rather
 * than left for a reader to diff. This suite originally asserted that the flip seats ONE owner, the
 * CALLER, and proved the gated world by showing `agent` holding nothing after a `studio` invite.
 * That was a faithful description of an engine whose behaviour the wave critic then reproduced as a
 * defect: an MCP-first product in which the owner's first invite from the Studio silently cut the
 * agent out of every write. Provisioning now seats BOTH D13 actors, so:
 *
 *   - the flip writes THREE member rows, not two (studio owner, agent owner, pending invitee);
 *   - `agent` after the flip is an accepted `owner`, which is the point, and the cost is stated in
 *     `seatFirstOwner`: whoever reaches the MCP socket holds everything until the operator narrows
 *     it, which they do with `set_role` on a row that is visible on the Members surface;
 *   - the `last_owner` rail is counted against TWO accepted owners, so revoking one is allowed and
 *     revoking the second is refused. The one-way claim is therefore proved harder than before, not
 *     relaxed: the route out now has an extra step and still does not reach the ungated state;
 *   - an actor that is NOT seated is what redeems an invite. That is the `treuhand:mueller`-shaped
 *     named subject `src/api/session.ts` anticipates, and it is now the only way `accept_invite`
 *     succeeds, because both D13 actors are already members. A seated actor gets the new
 *     `actor_already_member` rejection, which names the row it already holds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { CAPABILITY_FOR_ACTION, SEATED_ACTORS, isUngated } from '../../dist/core/access/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

const countMembers = (deps, workspaceId) =>
  deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?').get(workspaceId).n;

const countInvites = (deps, workspaceId) =>
  deps.store.db.prepare('SELECT COUNT(*) AS n FROM invite WHERE workspace_id = ?').get(workspaceId).n;

const countUsers = (deps) => deps.store.db.prepare('SELECT COUNT(*) AS n FROM user').get().n;

/** A type-VALID filler, so the CAPABILITY is the first thing that could refuse. */
function validFiller(action, workspaceId) {
  const out = {};
  for (const field of action.inputSchema.required) {
    if (field === 'workspaceId') {
      out[field] = workspaceId;
      continue;
    }
    const declared = action.inputSchema.properties[field]?.type;
    if (declared === 'integer') out[field] = 1;
    else if (declared === 'boolean') out[field] = true;
    else if (declared === 'array') out[field] = [];
    else if (declared === 'object') out[field] = {};
    else out[field] = 'x';
  }
  return out;
}

function gatedCtxWrites() {
  return ACTIONS.filter(
    (a) =>
      a.kind === 'write' &&
      a.inputSchema.required.includes('workspaceId') &&
      CAPABILITY_FOR_ACTION[a.name] !== undefined &&
      !isUngated(CAPABILITY_FOR_ACTION[a.name]),
  );
}

test('A24 before the flip: an unprovisioned workspace has zero member rows and grants EVERY write', () => {
  const deps = freshDeps();
  deps.actor = 'agent';
  const { workspaceId } = mintWorkspace(deps, 'Ungeschützt GmbH', 'pf-open-ws');

  assert.equal(countMembers(deps, workspaceId), 0, 'a fresh workspace must have no member rows at all');

  const verbs = gatedCtxWrites();
  assert.ok(verbs.length > 40, `only ${verbs.length} gated ctx writes were derived; the filter is wrong`);

  // Every one of them is called with a type-valid filler. The verbs will refuse for their OWN
  // reasons (an unknown id, a missing domain field) and that is fine and expected: the only answer
  // this rule forbids is `permission_denied`, because nobody has claimed this workspace.
  //
  // ONE pinned exception since the A35 critic's F1 (18.08.2026): the fixture actor is the AGENT
  // seat, and `capabilityFor` step 0 denies that seat `manage_agent_dial` on every path, the
  // unprovisioned grant included, because the governed seat must never hold its own governor. The
  // four verbs riding that capability are therefore expected denials FOR THIS ACTOR and only those;
  // a human actor on an unprovisioned workspace still holds every write (asserted in the F1
  // regression suite the other way round).
  const F1_GOVERNOR_VERBS = new Set(['set_agent_dial', 'approve_drafted_action', 'reject_drafted_action', 'agent_prose_delete']);
  const denied = [];
  for (const action of verbs) {
    const res = action.run(deps, validFiller(action, workspaceId));
    if (res.ok === false && res.error === 'permission_denied' && !F1_GOVERNOR_VERBS.has(action.name)) {
      denied.push(action.name);
    }
  }
  assert.deepEqual(denied, [], 'an unprovisioned workspace denied a write: every existing book would be locked out');
});

test('A24 before the flip: whoami says so out loud rather than faking an owner', () => {
  // The Studio has to be able to say two different things: "you are the owner", and "nobody has
  // claimed this workspace yet, so everything is open and inviting anyone will make you the owner".
  // A synthetic owner grant would collapse them into one and the second sentence could not be said.
  const deps = freshDeps();
  deps.actor = 'agent';
  const { workspaceId } = mintWorkspace(deps, 'Ungeschützt GmbH', 'pf-who-ws');

  const me = call(deps, 'whoami', { workspaceId });
  assert.equal(me.ok, true, JSON.stringify(me));
  assert.equal(me.provisioned, false);
  assert.equal(me.isMember, false);
  assert.equal(me.memberId, null);
  assert.equal(me.role, 'owner', 'the effective role is owner, and provisioned:false is how that is qualified');
  assert.ok(me.capabilities.includes('post'), 'an unclaimed workspace resolves the full bundle');
  assert.ok(me.capabilities.includes('manage_members'));
});

test('A24 the flip: the first invite_member seats BOTH D13 actors as accepted owners, counted on rows', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Erste Einladung GmbH', 'pf-flip-ws');
  assert.equal(countMembers(deps, workspaceId), 0);

  const invited = call(deps, 'invite_member', {
    workspaceId,
    email: 'buchhalter@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'pf-flip-1',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));

  // THREE rows: both seated owners and the pending invitee. Counted rather than inferred from the
  // returned memberId, which names only the invitee.
  assert.equal(countMembers(deps, workspaceId), 3, 'the flip must write BOTH owner seats AND the invitee');
  assert.equal(countInvites(deps, workspaceId), 1);

  const rows = deps.store.db
    .prepare(
      `SELECT m.role, m.accepted_at, u.actor_id, u.email
         FROM workspace_member m JOIN user u ON u.id = m.user_id
        WHERE m.workspace_id = ? ORDER BY m.invited_at, m.id`,
    )
    .all(workspaceId);

  // Derived from the engine's own actor set, so an actor added to D13 later is held to this rule
  // with nobody editing this file. That is the drift D50 was decided to stop.
  for (const actor of SEATED_ACTORS) {
    const seat = rows.find((r) => r.actor_id === actor);
    assert.ok(seat !== undefined, `the D13 actor '${actor}' was not seated, so it lost every write`);
    assert.equal(seat.role, 'owner', `'${actor}' was seated at ${seat.role} rather than owner`);
    assert.notEqual(seat.accepted_at, null, `the seat for '${actor}' must be accepted, not pending`);
  }
  assert.equal(
    rows.filter((r) => r.role === 'owner').length,
    SEATED_ACTORS.length,
    'the flip seated an owner nobody asked for, or missed one',
  );

  const invitee = rows.find((r) => r.role === 'bookkeeper');
  assert.ok(invitee !== undefined);
  assert.equal(invitee.accepted_at, null, 'the invitee is pending until the token is redeemed');
  assert.equal(invitee.actor_id, null, 'a pending invitee is bound to no session actor');
  assert.equal(invitee.email, 'buchhalter@muster.ch');

  // And the answer says nothing was sent. There is no transport in the MIT core.
  assert.equal(invited.delivery, 'prepared');
  assert.equal(typeof invited.token, 'string');
});

test('A24 the flip: the agent keeps working after a Studio invite, which is what D50 bought', () => {
  // The defect the wave critic reproduced, asserted as its repair on the money path itself. Before
  // D50 this sequence answered `permission_denied capability=post role=null`, with nothing in the
  // invite result, in `whoami` or on the Members surface saying the agent had just been cut out.
  const deps = freshDeps();
  deps.actor = 'agent';
  const { workspaceId, accId } = mintWorkspace(deps, 'MCP GmbH', 'pf-mcp-ws');
  const post = (idempotencyKey) =>
    call(deps, 'post_entry', {
      workspaceId,
      date: '2026-03-01',
      description: 'Büromaterial bar bezahlt',
      source: 'manual',
      idempotencyKey,
      lines: [
        { account: accId('6500'), debit: 5000 },
        { account: accId('1000'), credit: 5000 },
      ],
    });

  assert.equal(post('pf-mcp-before').ok, true, 'the ungated world refused a post');

  deps.actor = 'studio';
  const invited = call(deps, 'invite_member', {
    workspaceId,
    email: 'buchhalter@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'pf-mcp-invite',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));

  deps.actor = 'agent';
  const after = post('pf-mcp-after');
  assert.equal(after.ok, true, `the Studio's first invite cut the MCP agent out: ${JSON.stringify(after)}`);

  // And it is DISCOVERABLE rather than folklore: `whoami` names the role, and the agent is a row on
  // the Members surface with an id the operator can narrow or revoke.
  const me = call(deps, 'whoami', { workspaceId });
  assert.equal(me.isMember, true, 'the agent must be able to see that it is a member');
  assert.equal(me.role, 'owner');

  const listed = call(deps, 'list_members', { workspaceId });
  const agentRow = listed.members.find((m) => m.actorId === 'agent');
  assert.ok(agentRow !== undefined, 'the Members surface cannot show what list_members does not return');
  assert.equal(agentRow.role, 'owner');
  assert.equal(agentRow.status, 'active');

  // Narrowing it is one call on that row, which is the flow D50 put in place of the lockout.
  deps.actor = 'studio';
  const narrowed = call(deps, 'set_role', { workspaceId, memberId: agentRow.memberId, role: 'viewer' });
  assert.equal(narrowed.ok, true, JSON.stringify(narrowed));

  deps.actor = 'agent';
  const denied = post('pf-mcp-narrowed');
  assert.equal(denied.ok, false, 'narrowing the agent to viewer did not take away its write');
  assert.equal(denied.error, 'permission_denied');
  assert.equal(denied.role, 'viewer');
});

test('A24 the flip: replaying the invite key does NOT seat a second owner (rows, not the result)', () => {
  // The one place in the product where an idempotent replay crosses a state boundary. The first call
  // runs in the ungated world and the second in the gated one, and the verb that decides whether the
  // second is allowed is the same verb whose first call created the grant.
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Doppelte Einladung GmbH', 'pf-replay-ws');

  const input = {
    workspaceId,
    email: 'buchhalter@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'pf-replay-1',
  };
  const first = call(deps, 'invite_member', input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const membersAfterFirst = countMembers(deps, workspaceId);
  const usersAfterFirst = countUsers(deps);

  const second = call(deps, 'invite_member', input);
  assert.equal(second.ok, true, `the replay must succeed, got ${JSON.stringify(second)}`);
  assert.equal(second.memberId, first.memberId, 'the replay must answer the ORIGINAL member id');
  assert.equal(second.token, first.token, 'the replay must answer the ORIGINAL token');

  assert.equal(countMembers(deps, workspaceId), membersAfterFirst, 'the replay wrote an extra member row');
  assert.equal(countMembers(deps, workspaceId), SEATED_ACTORS.length + 1);
  assert.equal(countInvites(deps, workspaceId), 1, 'the replay minted a second invite token');
  assert.equal(countUsers(deps), usersAfterFirst, 'the replay minted a second identity');
  const owners = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ? AND role = 'owner'")
    .get(workspaceId).n;
  assert.equal(owners, SEATED_ACTORS.length, 'the replay seated an EXTRA owner');
});

test('A24 after the flip: the matrix is authoritative and a stranger actor holds nothing', () => {
  // D50 moved WHO the stranger is, not whether there is one. The seated actors are `studio` and
  // `agent`, so the actor that proves the matrix is authoritative has to be one D13 does not mint on
  // this machine: an embedder's own actor, or the named subject a cloud tier will bring.
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Geschützt GmbH', 'pf-after-ws');

  const post = {
    workspaceId,
    date: '2026-03-01',
    source: 'manual',
    lines: [
      { account: accId('6500'), debit: 5000 },
      { account: accId('1000'), credit: 5000 },
    ],
  };
  // Before: even a stranger actor may post into an unclaimed workspace. That is state 1, and it is
  // the state every book that exists today is in.
  deps.actor = 'treuhand:mueller';
  const before = call(deps, 'post_entry', { ...post, idempotencyKey: 'pf-after-before' });
  assert.equal(before.ok, true, `the ungated world refused a post: ${JSON.stringify(before)}`);

  // The flip, performed by `studio`.
  deps.actor = 'studio';
  const invited = call(deps, 'invite_member', {
    workspaceId,
    email: 'buchhalter@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'pf-after-invite',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));

  // After: the stranger is not a member of anything, so it holds nothing at all, and `whoami`
  // reports the difference between "not a member" (role null) and "a role that lacks the
  // capability". Note the stranger was the actor that CLAIMED nothing: seating follows D13's set and
  // `seatingOrder` only adds the caller, which here was `studio`.
  deps.actor = 'treuhand:mueller';
  const me = call(deps, 'whoami', { workspaceId });
  assert.equal(me.provisioned, true);
  assert.equal(me.isMember, false);
  assert.equal(me.role, null, 'a non-member holds no role at all, which is not the same as an empty bundle');
  assert.deepEqual([...me.capabilities], []);

  const entriesBefore = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?')
    .get(workspaceId).n;
  const after = call(deps, 'post_entry', { ...post, idempotencyKey: 'pf-after-after' });
  assert.equal(after.ok, false);
  assert.equal(after.error, 'permission_denied');
  assert.equal(after.role, null);
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n,
    entriesBefore,
    'the denied post wrote an entry after the flip',
  );

  // And BOTH seated actors still hold everything, which is the half of this the critic showed was
  // broken: the owner who performed the flip, and the MCP agent who did not.
  for (const actor of SEATED_ACTORS) {
    deps.actor = actor;
    const seat = call(deps, 'whoami', { workspaceId });
    assert.equal(seat.isMember, true, `'${actor}' lost its membership at the flip`);
    assert.equal(seat.role, 'owner');
    assert.ok(seat.capabilities.includes('post'));
  }
});

test('A24 the flip is ONE-WAY: no sequence of verbs walks a workspace back to ungated', () => {
  // The rail is `last_owner` on both `set_role` and `revoke_member`. Asserted by trying every route
  // out rather than by reading the rail's source, because "a provisioned workspace can never be
  // walked back into the ungated state" is a claim about the whole verb surface, not about one file.
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Einbahn GmbH', 'pf-oneway-ws');

  const invited = call(deps, 'invite_member', {
    workspaceId,
    email: 'buchhalter@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'pf-oneway-invite',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));
  // The CALLER's own seat is taken last on purpose. Revoking it first would make `studio` a
  // non-member, and every later revoke would then answer `permission_denied` rather than exercising
  // the rail at all: a route out that ends in the wrong refusal proves nothing about `last_owner`.
  const ownerRows = deps.store.db
    .prepare(
      `SELECT m.id, u.actor_id FROM workspace_member m JOIN user u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND m.role = 'owner'
        ORDER BY (u.actor_id = 'studio'), m.id`,
    )
    .all(workspaceId);
  assert.equal(ownerRows.length, SEATED_ACTORS.length, 'the flip did not seat every D13 actor');
  assert.equal(ownerRows[ownerRows.length - 1].actor_id, 'studio', 'the caller must be the last seat standing');

  // Route 1: revoke the pending invitee. Allowed, and it leaves the owners behind.
  const revoked = call(deps, 'revoke_member', { workspaceId, memberId: invited.memberId });
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  assert.equal(countMembers(deps, workspaceId), SEATED_ACTORS.length);

  // Route 2: revoke owners one at a time. D50 seats more than one, so the route out is LONGER than
  // it was, and the rail has to hold at the end of it rather than at the first step. Every revoke
  // but the last is allowed; the last is refused.
  for (const row of ownerRows.slice(0, -1)) {
    const out = call(deps, 'revoke_member', { workspaceId, memberId: row.id });
    assert.equal(out.ok, true, `revoking a non-last owner was refused: ${JSON.stringify(out)}`);
  }
  const lastRow = ownerRows[ownerRows.length - 1];
  const lastOut = call(deps, 'revoke_member', { workspaceId, memberId: lastRow.id });
  assert.equal(lastOut.ok, false);
  assert.equal(lastOut.error, 'last_owner');
  assert.equal(countMembers(deps, workspaceId), 1, 'the refused revoke deleted the last owner anyway');

  // Route 3: demote the only remaining owner. Refused, and the role is unchanged.
  const demoted = call(deps, 'set_role', { workspaceId, memberId: lastRow.id, role: 'viewer' });
  assert.equal(demoted.ok, false);
  assert.equal(demoted.error, 'last_owner');
  assert.equal(
    deps.store.db.prepare('SELECT role FROM workspace_member WHERE id = ?').get(lastRow.id).role,
    'owner',
    'the refused set_role demoted the last owner anyway',
  );

  // And the workspace is still gated: a stranger actor still holds nothing.
  deps.actor = 'treuhand:mueller';
  const me = call(deps, 'whoami', { workspaceId });
  assert.equal(me.provisioned, true);
  assert.equal(me.isMember, false);
});

test('A24: a seated actor cannot redeem an invite, and is told which row it already holds', () => {
  // The consequence D50 carries and did not name. Both D13 actors are members before any invite
  // exists, so `accept_invite` from either can never succeed on a local install. The rejection has
  // to say THAT rather than `actor_already_bound` ("this session belongs to another person"), which
  // would be flatly wrong for an operator looking at the agent's own row.
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Schon dabei GmbH', 'pf-seated-ws');

  const invited = call(deps, 'invite_member', {
    workspaceId,
    email: 'agentin@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'pf-seated-invite',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));

  deps.actor = 'agent';
  const refused = call(deps, 'accept_invite', { token: invited.token });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'actor_already_member');
  assert.equal(refused.actor, 'agent');
  assert.equal(refused.role, 'owner');
  assert.equal(typeof refused.memberId, 'string');

  // The refusal wrote nothing: the invite is still pending and still redeemable by someone else.
  const stillPending = deps.store.db
    .prepare('SELECT accepted_at FROM invite WHERE token = ?')
    .get(invited.token);
  assert.equal(stillPending.accepted_at, null, 'the refused accept consumed the invite anyway');

  // And an actor D13 does not seat redeems it, which is the cloud-tier subject `session.ts` describes.
  deps.actor = 'treuhand:mueller';
  const accepted = call(deps, 'accept_invite', { token: invited.token });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.memberId, invited.memberId);
});

test('A24: a pending invitee holds NOTHING until the token is redeemed, and everything after', () => {
  // The window between writing the row and the invitee holding the grant is measured in DAYS here,
  // because the invite is delivered by the operator (P8, there is no transport in the MIT core).
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Wartezimmer GmbH', 'pf-pending-ws');

  const invited = call(deps, 'invite_member', {
    workspaceId,
    email: 'buchhalter@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'pf-pending-invite',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));

  const listed = call(deps, 'list_members', { workspaceId });
  assert.equal(listed.ok, true);
  const pending = listed.members.find((m) => m.memberId === invited.memberId);
  assert.equal(pending.status, 'pending', 'the pending member must be LABELLED pending, not merely be one');
  assert.equal(pending.acceptedAt, null);
  assert.equal(pending.actorId, null);

  const post = {
    workspaceId,
    date: '2026-03-01',
    source: 'manual',
    lines: [
      { account: accId('6500'), debit: 5000 },
      { account: accId('1000'), credit: 5000 },
    ],
  };

  // The redeeming actor is a NON-SEATED one, because after D50 both D13 actors are already members
  // and the "pending holds nothing" claim needs an actor whose only route in is the token.
  deps.actor = 'treuhand:mueller';
  const beforeAccept = call(deps, 'post_entry', { ...post, idempotencyKey: 'pf-pending-a' });
  assert.equal(beforeAccept.ok, false);
  assert.equal(beforeAccept.error, 'permission_denied');
  assert.equal(beforeAccept.role, null, 'a pending member resolves exactly like a non-member');

  const accepted = call(deps, 'accept_invite', { token: invited.token });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.memberId, invited.memberId);

  const afterAccept = call(deps, 'post_entry', { ...post, idempotencyKey: 'pf-pending-b' });
  assert.equal(afterAccept.ok, true, `redeeming the invite did not grant the role: ${JSON.stringify(afterAccept)}`);

  // `bookkeeper` keeps the books and cannot govern them: no `vat_file`.
  const filing = call(deps, 'vat_mark_filed', { workspaceId, period: '2026-Q1', idempotencyKey: 'pf-pending-c' });
  assert.equal(filing.ok, false);
  assert.equal(filing.error, 'permission_denied');
  assert.equal(filing.capability, 'vat_file');
  assert.equal(filing.role, 'bookkeeper');
});
