/**
 * §H-IDEMPOTENT for Wave F1's seven new write verbs, asserted on ROWS.
 *
 * WHY NOT ON THE RESULT. A verb that returns the same id twice while writing twice is exactly the
 * defect this phrasing exists to catch, and it is invisible to a return-value assertion by
 * construction: `rememberIdempotent` replays a stored answer, so an id that matches proves the
 * RECEIPT was replayed and says nothing about what the body did on the way there. Every claim below
 * is a count of rows in the table the verb writes.
 *
 * THE CONFORMANCE GATE ALREADY DOES A WHOLE-DATABASE SNAPSHOT AROUND EVERY WRITE VERB, and this is
 * not a duplicate of it. That rule proves "nothing anywhere moved" for a scenario chosen to make the
 * verb's FIRST call succeed; these tests name the specific table and the specific count, and they
 * cover the shapes that scenario deliberately avoids, above all a replay whose first call has already
 * changed the workspace's provisioning state. A count that names its table is also the failure
 * message a person can act on: "the database changed" sends someone diffing a snapshot.
 *
 * THREE OF THE SEVEN CARRY NO KEY, and that is a decision rather than a gap. `accept_invite`,
 * `set_role` and `revoke_member` are ABSOLUTE state-setting writes: the second call re-asserts the
 * state the first one made true, so a replay settles instead of replaying a receipt. Their claim is
 * therefore stronger, not weaker: the SECOND call genuinely runs, and the rows still must not move.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { SEATED_ACTORS } from '../../dist/core/access/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/**
 * Member rows a provisioned workspace holds BEFORE any invitee, derived rather than written as `1`.
 *
 * D50 made the flip seat every D13 actor rather than only the caller, so every row count in this
 * file that used to read "the seated owner plus the invitee" is now "the seats plus the invitee".
 * Deriving it from the engine's own set means an actor added to D13 later does not silently redden
 * a suite that is about idempotency and has no opinion about how many actors there are.
 */
const SEATS = SEATED_ACTORS.length;

/**
 * An actor D13 does NOT seat, which is the only kind that can still redeem an invite.
 *
 * Both `studio` and `agent` are accepted members before an invite exists, so `accept_invite` from
 * either answers `actor_already_member` (asserted in `provisioning-flip.test.mjs`). This is the
 * named-subject shape `src/api/session.ts` anticipates for a cloud tier.
 */
const GUEST_ACTOR = 'treuhand:mueller';

const call = (deps, name, input) => getAction(name).run(deps, input);

const count = (deps, sql, ...args) => deps.store.db.prepare(sql).get(...args).n;

/** A workspace owned by `studio`, already past the provisioning flip. */
function ownedWorkspace(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Wiederholung GmbH', `${seed}-ws`);
  return { deps, workspaceId, accId };
}

test('H-IDEMPOTENT: invite_member twice on one key writes ONE member, ONE invite and ONE identity', () => {
  const { deps, workspaceId } = ownedWorkspace('ir-invite');
  const input = {
    workspaceId,
    email: 'buchhalter@muster.ch',
    role: 'bookkeeper',
    displayName: 'B. Halter',
    idempotencyKey: 'ir-invite-1',
  };

  const first = call(deps, 'invite_member', input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = call(deps, 'invite_member', input);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.memberId, first.memberId);

  // The seats and the one invitee. One more than that would be the double.
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?', workspaceId), SEATS + 1);
  assert.equal(
    count(deps, 'SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ? AND role = ?', workspaceId, 'bookkeeper'),
    1,
  );
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM invite WHERE workspace_id = ?', workspaceId), 1);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM user WHERE email = ?', 'buchhalter@muster.ch'), 1);
});

test('H-IDEMPOTENT: a SECOND invite to the same address without the key is refused, not duplicated', () => {
  // The key protects a redelivery of the same request. A genuinely new request naming an address that
  // is already bound must be told so, because the schema's `workspace_member_one_per_user` index
  // would otherwise decide the outcome with a constraint violation.
  const { deps, workspaceId } = ownedWorkspace('ir-twice');
  const first = call(deps, 'invite_member', {
    workspaceId,
    email: 'buchhalter@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'ir-twice-1',
  });
  assert.equal(first.ok, true, JSON.stringify(first));

  const again = call(deps, 'invite_member', {
    workspaceId,
    email: 'buchhalter@muster.ch',
    role: 'viewer',
    idempotencyKey: 'ir-twice-2',
  });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_member');
  assert.equal(again.memberId, first.memberId);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?', workspaceId), SEATS + 1);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM invite WHERE workspace_id = ?', workspaceId), 1);
});

test('H-IDEMPOTENT: accept_invite twice binds one actor once and activates one membership', () => {
  // Key-EXEMPT, so the second call really runs. It must settle to the first call's answer rather
  // than reject: a client that retried a lost response would otherwise be told its own success was
  // an error.
  const { deps, workspaceId } = ownedWorkspace('ir-accept');
  const invited = call(deps, 'invite_member', {
    workspaceId,
    email: 'agent@muster.ch',
    role: 'agent',
    idempotencyKey: 'ir-accept-invite',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));

  // A NON-SEATED actor, because after D50 both D13 actors are already members and neither can
  // redeem anything. See GUEST_ACTOR above.
  deps.actor = GUEST_ACTOR;
  const first = call(deps, 'accept_invite', { token: invited.token });
  assert.equal(first.ok, true, JSON.stringify(first));
  const acceptedAt = deps.store.db
    .prepare('SELECT accepted_at FROM workspace_member WHERE id = ?')
    .get(invited.memberId).accepted_at;

  const second = call(deps, 'accept_invite', { token: invited.token });
  assert.equal(second.ok, true, `a replayed accept must settle, got ${JSON.stringify(second)}`);
  assert.equal(second.memberId, first.memberId);

  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?', workspaceId), SEATS + 1);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM invite WHERE token = ?', invited.token), 1);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM user WHERE actor_id = ?', GUEST_ACTOR), 1);
  assert.equal(
    deps.store.db.prepare('SELECT accepted_at FROM workspace_member WHERE id = ?').get(invited.memberId).accepted_at,
    acceptedAt,
    'the replayed accept re-stamped the acceptance time',
  );
});

test('H-IDEMPOTENT: set_role twice leaves one row at one role', () => {
  const { deps, workspaceId } = ownedWorkspace('ir-setrole');
  const invited = call(deps, 'invite_member', {
    workspaceId,
    email: 'wechsler@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'ir-setrole-invite',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));

  const input = { workspaceId, memberId: invited.memberId, role: 'viewer' };
  assert.equal(call(deps, 'set_role', input).ok, true);
  assert.equal(call(deps, 'set_role', input).ok, true);

  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?', workspaceId), SEATS + 1);
  const rows = deps.store.db
    .prepare('SELECT role FROM workspace_member WHERE id = ?')
    .all(invited.memberId);
  assert.deepEqual(rows, [{ role: 'viewer' }], 'set_role must UPDATE one row, never append a second');
});

test('H-IDEMPOTENT: revoke_member twice deletes one row and settles the second time', () => {
  const { deps, workspaceId } = ownedWorkspace('ir-revoke');
  const invited = call(deps, 'invite_member', {
    workspaceId,
    email: 'abgang@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'ir-revoke-invite',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?', workspaceId), SEATS + 1);

  const first = call(deps, 'revoke_member', { workspaceId, memberId: invited.memberId });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?', workspaceId), SEATS);

  const second = call(deps, 'revoke_member', { workspaceId, memberId: invited.memberId });
  assert.equal(second.ok, true, 'a replayed revoke must settle, not reject');
  assert.equal(
    count(deps, 'SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?', workspaceId),
    SEATS,
    'the replayed revoke removed a seated owner as well',
  );
  // The identity survives, so re-inviting the same person restores their history.
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM user WHERE email = ?', 'abgang@muster.ch'), 1);
});

test('H-IDEMPOTENT: define_role twice on one key writes ONE custom role', () => {
  const { deps, workspaceId } = ownedWorkspace('ir-define');
  const input = {
    workspaceId,
    name: 'Nur Buchen',
    capabilities: ['post', 'post'],
    idempotencyKey: 'ir-define-1',
  };

  const first = call(deps, 'define_role', input);
  assert.equal(first.ok, true, JSON.stringify(first));
  // The bundle is a SET: two spellings of one grant cannot make a stored bundle disagree with itself.
  assert.deepEqual(first.capabilities, ['post']);

  const second = call(deps, 'define_role', input);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.roleId, first.roleId);

  assert.equal(
    count(deps, 'SELECT COUNT(*) AS n FROM role_def WHERE workspace_id = ? AND is_builtin = 0', workspaceId),
    1,
    'the replay minted a SECOND custom role under a new id',
  );
  // The lazy seed materialised the three editable built-ins exactly once as well.
  assert.equal(
    count(deps, 'SELECT COUNT(*) AS n FROM role_def WHERE workspace_id = ? AND is_builtin = 1', workspaceId),
    3,
  );
});

test('H-IDEMPOTENT: define_role reshaping a built-in twice leaves one row with one bundle', () => {
  const { deps, workspaceId } = ownedWorkspace('ir-reshape');
  const input = {
    workspaceId,
    roleId: 'agent',
    name: 'agent',
    capabilities: ['post'],
    idempotencyKey: 'ir-reshape-1',
  };
  assert.equal(call(deps, 'define_role', input).ok, true);
  assert.equal(call(deps, 'define_role', input).ok, true);

  const rows = deps.store.db
    .prepare('SELECT capabilities_json FROM role_def WHERE workspace_id = ? AND id = ?')
    .all(workspaceId, 'agent');
  assert.equal(rows.length, 1, 'reshaping a built-in appended a row instead of updating one');
  assert.deepEqual(JSON.parse(rows[0].capabilities_json), ['post']);
});

test('H-IDEMPOTENT: archive_role twice leaves the role archived once', () => {
  const { deps, workspaceId } = ownedWorkspace('ir-archive');
  const created = call(deps, 'define_role', {
    workspaceId,
    name: 'Vorübergehend',
    capabilities: ['post'],
    idempotencyKey: 'ir-archive-define',
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const input = { workspaceId, roleId: created.roleId, idempotencyKey: 'ir-archive-1' };
  assert.equal(call(deps, 'archive_role', input).ok, true);
  assert.equal(call(deps, 'archive_role', input).ok, true);

  const rows = deps.store.db
    .prepare('SELECT archived FROM role_def WHERE workspace_id = ? AND id = ?')
    .all(workspaceId, created.roleId);
  assert.deepEqual(rows, [{ archived: 1 }], 'archive is a soft flag on ONE row and never a delete');
  // And it is never a delete, so historical attributions still resolve to a name.
  assert.equal(
    deps.store.db.prepare('SELECT name FROM role_def WHERE workspace_id = ? AND id = ?').get(workspaceId, created.roleId).name,
    'Vorübergehend',
  );
});

test('H-IDEMPOTENT: vat_saldo_declaration_basis is ONE row per Steuerperiode, however often it is called', () => {
  const { deps, workspaceId } = ownedWorkspace('ir-basis');
  const cfg = call(deps, 'vat_configure', {
    workspaceId,
    method: 'saldo',
    timing: 'soll',
    registered: true,
    asOf: '2026-01-01',
    saldoRates: [{ rateBp: 620 }, { rateBp: 370 }],
    saldoActivities: [
      { activityId: 'restauration', name: 'Restauration', rateBp: 620, accounts: ['3200'] },
      { activityId: 'ablieferung', name: 'Ablieferung', rateBp: 370, accounts: ['3000'] },
    ],
    idempotencyKey: 'ir-basis-cfg',
  });
  assert.equal(cfg.ok, true, JSON.stringify(cfg));

  const input = { workspaceId, taxPeriod: '2026', basis: 'highest_rate', idempotencyKey: 'ir-basis-1' };
  const first = call(deps, 'vat_saldo_declaration_basis', input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = call(deps, 'vat_saldo_declaration_basis', input);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(JSON.stringify(second), JSON.stringify(first), 'the replay answered differently');

  assert.equal(
    count(deps, 'SELECT COUNT(*) AS n FROM vat_saldo_declaration_election WHERE workspace_id = ?', workspaceId),
    1,
  );

  // A genuinely NEW request, with a fresh key, re-elects the same Steuerperiode. It is an UPSERT, so
  // it must still be one row: two rows for one year would make `electedDeclarationBasis` pick one.
  const withdrawn = call(deps, 'vat_saldo_declaration_basis', {
    workspaceId,
    taxPeriod: '2026',
    basis: 'per_activity',
    idempotencyKey: 'ir-basis-2',
  });
  assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
  assert.equal(withdrawn.supersededBasis, 'highest_rate', 'the withdrawal must report what it superseded');
  const rows = deps.store.db
    .prepare('SELECT tax_period, basis FROM vat_saldo_declaration_election WHERE workspace_id = ?')
    .all(workspaceId);
  assert.deepEqual(rows, [{ tax_period: '2026', basis: 'per_activity' }]);

  // A different Steuerperiode is a different row: the election is per year (MWSTG Art. 34 Abs. 2).
  assert.equal(
    call(deps, 'vat_saldo_declaration_basis', {
      workspaceId,
      taxPeriod: '2027',
      basis: 'highest_rate',
      idempotencyKey: 'ir-basis-3',
    }).ok,
    true,
  );
  assert.equal(
    count(deps, 'SELECT COUNT(*) AS n FROM vat_saldo_declaration_election WHERE workspace_id = ?', workspaceId),
    2,
  );
});

test('H-IDEMPOTENT: the SAME key delivered to the two different doors still writes once', () => {
  // The realistic redelivery is not two calls on one face, it is a Studio call the client thinks was
  // lost and an agent retry of the same request. The idempotency receipt lives in the store, not in
  // an adapter, so both doors must land on it.
  const { deps, workspaceId } = ownedWorkspace('ir-doors');
  const input = {
    workspaceId,
    email: 'beidetueren@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'ir-doors-1',
  };

  const viaMcp = JSON.parse(callTool(deps, 'invite_member', input).content[0].text);
  assert.equal(viaMcp.ok, true, JSON.stringify(viaMcp));
  const viaRest = handleRest('invite_member', input, deps);
  assert.equal(viaRest.status, 200);
  assert.equal(viaRest.body.memberId, viaMcp.memberId, 'the REST retry minted a new member');
  assert.equal(viaRest.body.token, viaMcp.token, 'the REST retry minted a new invite token');

  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?', workspaceId), SEATS + 1);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM invite WHERE workspace_id = ?', workspaceId), 1);
});
