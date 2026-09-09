/**
 * §H-TENANT for everything Wave F1 added: members, invites, roles, Saldo approvals and the Art. 88
 * Abs. 6 election.
 *
 * THE TRAP THIS SUITE IS BUILT AROUND. Two workspaces in TWO databases prove nothing at all: every
 * assertion below passes with the `workspace_id` predicate deleted from every query in the engine,
 * because the other tenant's rows are in a file the query could never have reached. So both
 * workspaces here are minted on ONE `ApiDeps`, sharing one store AND one id sequence, and the second
 * workspace is a real co-tenant rather than a second universe. `test/vat/support.mjs` carries the
 * same warning in its own header for the same reason.
 *
 * AND THE SECOND HALF, which a leak test usually forgets. It is not enough that a cross-tenant call
 * ANSWERS wrong-tenant-shaped; it must also not WRITE. `revoke_member` is the sharp case: it settles
 * a replay by returning `ok({ revoked: true })` when the member row is absent (§H-IDEMPOTENT, the
 * verb is absolute and carries no key), so a cross-tenant revoke gets a SUCCESS back. The only thing
 * that distinguishes "correctly ignored someone else's member" from "deleted someone else's member"
 * is the other tenant's row, counted afterwards. That is what is asserted, not the return value.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { SEATED_ACTORS } from '../../dist/core/access/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/**
 * Seats a provisioned workspace holds before any invitee, derived from the engine's own actor set.
 *
 * D50 made the flip seat every D13 actor rather than only the caller, so a provisioned workspace's
 * baseline row count is `SEATS`, not 1, and each seat carries a NULL email (a transport has no
 * address). This suite is about the tenant boundary and has no opinion about how many actors there
 * are, so it derives the number instead of restating it.
 */
const SEATS = SEATED_ACTORS.length;

const call = (deps, name, input) => getAction(name).run(deps, input);

/**
 * Two workspaces in ONE store, each claimed by a different D13 session actor.
 *
 * `alpha` is owned by `studio` and `beta` by `agent`, which is the closest the local tier gets to two
 * unrelated operators: the actor set is a closed registry of transports (`src/api/session.ts`), and
 * `user.actor_id` is the whole of local authentication.
 */
function twoTenants() {
  const deps = freshDeps();

  deps.actor = 'studio';
  const alpha = mintWorkspace(deps, 'Alpha GmbH', 'ti-alpha-ws');
  const alphaInvite = call(deps, 'invite_member', {
    workspaceId: alpha.workspaceId,
    email: 'alpha-buchhalter@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'ti-alpha-invite',
  });
  assert.equal(alphaInvite.ok, true, JSON.stringify(alphaInvite));

  deps.actor = 'agent';
  const beta = mintWorkspace(deps, 'Beta GmbH', 'ti-beta-ws');
  const betaInvite = call(deps, 'invite_member', {
    workspaceId: beta.workspaceId,
    email: 'beta-buchhalter@muster.ch',
    role: 'treuhaender',
    idempotencyKey: 'ti-beta-invite',
  });
  assert.equal(betaInvite.ok, true, JSON.stringify(betaInvite));

  // The fixture is only worth anything if the two really share a database.
  const tables = deps.store.db
    .prepare('SELECT COUNT(DISTINCT workspace_id) AS n FROM workspace_member')
    .get().n;
  assert.equal(tables, 2, 'the two workspaces must be co-tenants of ONE store, or nothing below is a leak test');

  return { deps, alpha, beta, alphaInvite, betaInvite };
}

test('H-TENANT: list_members answers one workspace, never the store', () => {
  const { deps, alpha, beta } = twoTenants();

  deps.actor = 'studio';
  const inAlpha = call(deps, 'list_members', { workspaceId: alpha.workspaceId });
  assert.equal(inAlpha.ok, true);
  assert.deepEqual(
    inAlpha.members.map((m) => m.email).sort(),
    // One NULL per seated actor (a transport has no email address) plus Alpha's own invitee.
    [...Array(SEATS).fill(null), 'alpha-buchhalter@muster.ch'].sort(),
    "Alpha's list must hold its own owner seats and its own invitee, and nothing of Beta's",
  );

  deps.actor = 'agent';
  const inBeta = call(deps, 'list_members', { workspaceId: beta.workspaceId });
  assert.equal(inBeta.ok, true);
  const betaEmails = inBeta.members.map((m) => m.email);
  assert.ok(betaEmails.includes('beta-buchhalter@muster.ch'));
  assert.equal(
    betaEmails.includes('alpha-buchhalter@muster.ch'),
    false,
    "Beta's member list carried Alpha's bookkeeper",
  );
  assert.equal(inBeta.members.length, SEATS + 1);
});

test('H-TENANT: a role defined in one workspace is invisible and unassignable in the other', () => {
  const { deps, alpha, beta } = twoTenants();

  deps.actor = 'studio';
  const role = call(deps, 'define_role', {
    workspaceId: alpha.workspaceId,
    name: 'Nur Alpha',
    capabilities: ['post'],
    idempotencyKey: 'ti-role',
  });
  assert.equal(role.ok, true, JSON.stringify(role));

  deps.actor = 'agent';
  const betaRoles = call(deps, 'list_roles', { workspaceId: beta.workspaceId });
  assert.equal(betaRoles.ok, true);
  assert.equal(
    betaRoles.roles.some((r) => r.id === role.roleId),
    false,
    "Beta's role list carried Alpha's custom role",
  );
  // The five built-ins are present in both, because they are code and not rows.
  assert.deepEqual(
    betaRoles.roles
      .filter((r) => r.isBuiltin)
      .map((r) => r.id)
      .sort(),
    ['agent', 'bookkeeper', 'owner', 'treuhaender', 'viewer'],
  );

  // Assigning across the boundary is refused, and nothing is written.
  const invited = call(deps, 'invite_member', {
    workspaceId: beta.workspaceId,
    email: 'fremd@muster.ch',
    role: role.roleId,
    idempotencyKey: 'ti-cross-invite',
  });
  assert.equal(invited.ok, false);
  assert.equal(invited.error, 'unknown_role');
  assert.equal(
    deps.store.db
      .prepare('SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?')
      .get(beta.workspaceId).n,
    SEATS + 1,
    "the refused cross-tenant invite wrote a member row into Beta anyway",
  );
});

test("H-TENANT: revoke_member cannot delete another workspace's member, though it answers ok", () => {
  // The sharp one. `revoke_member` settles a replay with `ok({ revoked: true })` when the row is
  // absent, so the RETURN VALUE cannot tell a correctly-ignored cross-tenant id from a deletion. Only
  // the other tenant's row count can.
  const { deps, alpha, beta, betaInvite } = twoTenants();
  const betaBefore = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?')
    .get(beta.workspaceId).n;

  deps.actor = 'studio';
  const res = call(deps, 'revoke_member', { workspaceId: alpha.workspaceId, memberId: betaInvite.memberId });
  assert.equal(res.ok, true, 'the absent-row settle is the documented behaviour; the row count is the real claim');

  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?').get(beta.workspaceId).n,
    betaBefore,
    "a revoke issued in Alpha deleted a member of Beta",
  );
  assert.ok(
    deps.store.db.prepare('SELECT id FROM workspace_member WHERE id = ?').get(betaInvite.memberId) !== undefined,
    "Beta's member row is gone",
  );
});

test("H-TENANT: set_role cannot change another workspace's member", () => {
  const { deps, alpha, beta, betaInvite } = twoTenants();

  deps.actor = 'studio';
  const res = call(deps, 'set_role', {
    workspaceId: alpha.workspaceId,
    memberId: betaInvite.memberId,
    role: 'viewer',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'member_not_found');
  assert.equal(
    deps.store.db.prepare('SELECT role FROM workspace_member WHERE id = ?').get(betaInvite.memberId).role,
    'treuhaender',
    "a set_role issued in Alpha changed a member of Beta",
  );
  // And Beta's own list still reads the untouched role, through the verb rather than the table.
  deps.actor = 'agent';
  const listed = call(deps, 'list_members', { workspaceId: beta.workspaceId });
  assert.equal(listed.members.find((m) => m.memberId === betaInvite.memberId).role, 'treuhaender');
});

test("H-TENANT: define_role and archive_role cannot reshape another workspace's role", () => {
  const { deps, alpha, beta } = twoTenants();

  deps.actor = 'agent';
  const betaRole = call(deps, 'define_role', {
    workspaceId: beta.workspaceId,
    name: 'Nur Beta',
    capabilities: ['post', 'pay'],
    idempotencyKey: 'ti-beta-role',
  });
  assert.equal(betaRole.ok, true, JSON.stringify(betaRole));

  deps.actor = 'studio';
  const reshaped = call(deps, 'define_role', {
    workspaceId: alpha.workspaceId,
    roleId: betaRole.roleId,
    name: 'Übernommen',
    capabilities: ['manage_members'],
    idempotencyKey: 'ti-reshape',
  });
  assert.equal(reshaped.ok, false);
  assert.equal(reshaped.error, 'role_not_found');

  const archived = call(deps, 'archive_role', {
    workspaceId: alpha.workspaceId,
    roleId: betaRole.roleId,
    idempotencyKey: 'ti-archive',
  });
  assert.equal(archived.ok, false);
  assert.equal(archived.error, 'role_not_found');

  const row = deps.store.db
    .prepare('SELECT name, capabilities_json, archived FROM role_def WHERE workspace_id = ? AND id = ?')
    .get(beta.workspaceId, betaRole.roleId);
  assert.equal(row.name, 'Nur Beta', "Alpha's define_role renamed Beta's role");
  assert.deepEqual(JSON.parse(row.capabilities_json), ['post', 'pay'], "Alpha's define_role rewrote Beta's bundle");
  assert.equal(row.archived, 0, "Alpha's archive_role archived Beta's role");
});

test('H-TENANT: provisioning one workspace does not gate the other, and a role in one grants nothing in the other', () => {
  // Both halves matter and they fail in opposite directions. If `isProvisioned` lost its tenant
  // predicate, claiming Alpha would lock every other book on the machine. If `memberFor` lost its
  // tenant predicate, Alpha's owner would silently own Beta as well.
  const deps = freshDeps();
  deps.actor = 'studio';
  const alpha = mintWorkspace(deps, 'Alpha GmbH', 'ti-p-alpha');
  const beta = mintWorkspace(deps, 'Beta GmbH', 'ti-p-beta');

  const invited = call(deps, 'invite_member', {
    workspaceId: alpha.workspaceId,
    email: 'alpha@muster.ch',
    role: 'viewer',
    idempotencyKey: 'ti-p-invite',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));

  // Beta is untouched, so it is still unprovisioned and open to anyone.
  deps.actor = 'agent';
  const betaMe = call(deps, 'whoami', { workspaceId: beta.workspaceId });
  assert.equal(betaMe.provisioned, false, 'claiming Alpha gated Beta as well');
  const betaPost = call(deps, 'post_entry', {
    workspaceId: beta.workspaceId,
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'ti-p-post',
    lines: [
      { account: beta.accId('6500'), debit: 5000 },
      { account: beta.accId('1000'), credit: 5000 },
    ],
  });
  assert.equal(betaPost.ok, true, `Beta refused a post after Alpha was claimed: ${JSON.stringify(betaPost)}`);

  // And Alpha's owner is nobody in Beta: Beta is ungated, so `studio` is granted there for that
  // reason and NOT because it owns Alpha. `whoami` is what tells the two apart.
  deps.actor = 'studio';
  const inBeta = call(deps, 'whoami', { workspaceId: beta.workspaceId });
  assert.equal(inBeta.provisioned, false);
  assert.equal(inBeta.isMember, false, "Alpha's owner appeared as a member of Beta");

  const inAlpha = call(deps, 'whoami', { workspaceId: alpha.workspaceId });
  assert.equal(inAlpha.provisioned, true);
  assert.equal(inAlpha.isMember, true);
  assert.equal(inAlpha.role, 'owner');
});

// --- F11: the Saldo approval history and the Art. 88 Abs. 6 election --------------------------

/** Configure one workspace onto two approved Saldosteuersätze with three mapped Tätigkeiten. */
function configureSaldo(deps, workspaceId, seed) {
  const res = call(deps, 'vat_configure', {
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
    idempotencyKey: `${seed}-cfg`,
  });
  assert.equal(res.ok, true, `vat_configure failed: ${JSON.stringify(res)}`);
  return res;
}

test('H-TENANT: the Bewilligungsverlauf of one workspace is not the other workspace evidence', () => {
  // Under Saldo NO rate is stamped on a journal line, so this history is the ONLY evidence of what a
  // filed period was computed with. A leak here would not be a privacy question, it would put another
  // company's approved rates on the screen where an operator checks their own filings.
  const deps = freshDeps();
  deps.actor = 'studio';
  const alpha = mintWorkspace(deps, 'Alpha Gastro GmbH', 'ti-s-alpha');
  const beta = mintWorkspace(deps, 'Beta Bau GmbH', 'ti-s-beta');

  configureSaldo(deps, alpha.workspaceId, 'ti-s-alpha');

  const inAlpha = call(deps, 'vat_saldo_generations', { workspaceId: alpha.workspaceId });
  assert.equal(inAlpha.ok, true, JSON.stringify(inAlpha));
  assert.equal(inAlpha.generations.length, 1);
  assert.deepEqual(
    inAlpha.generations[0].rates.map((r) => r.rateBp),
    [620, 370],
  );

  const inBeta = call(deps, 'vat_saldo_generations', { workspaceId: beta.workspaceId });
  assert.equal(inBeta.ok, true, JSON.stringify(inBeta));
  assert.deepEqual(inBeta.generations, [], "Beta read Alpha's ESTV approval");
  assert.deepEqual(inBeta.elections, []);

  // Now give Beta its OWN, different approval, and check neither answer moved toward the other.
  const betaCfg = call(deps, 'vat_configure', {
    workspaceId: beta.workspaceId,
    method: 'saldo',
    timing: 'soll',
    registered: true,
    asOf: '2026-01-01',
    saldoRates: [{ rateBp: 530 }],
    saldoActivities: [{ activityId: 'bau', name: 'Bau', rateBp: 530, accounts: ['3200'] }],
    idempotencyKey: 'ti-s-beta-cfg',
  });
  assert.equal(betaCfg.ok, true, JSON.stringify(betaCfg));

  const alphaAgain = call(deps, 'vat_saldo_generations', { workspaceId: alpha.workspaceId });
  assert.equal(alphaAgain.generations.length, 1, "Beta's approval appeared in Alpha's history");
  assert.deepEqual(
    alphaAgain.generations[0].rates.map((r) => r.rateBp),
    [620, 370],
  );
  const betaAgain = call(deps, 'vat_saldo_generations', { workspaceId: beta.workspaceId });
  assert.equal(betaAgain.generations.length, 1);
  assert.deepEqual(
    betaAgain.generations[0].rates.map((r) => r.rateBp),
    [530],
  );
  assert.deepEqual(
    betaAgain.generations[0].activities.map((a) => a.activityId),
    ['bau'],
    "Beta's Tätigkeiten carried Alpha's",
  );
});

test('H-TENANT: the Art. 88 Abs. 6 election is per workspace as well as per Steuerperiode', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const alpha = mintWorkspace(deps, 'Alpha Gastro GmbH', 'ti-e-alpha');
  const beta = mintWorkspace(deps, 'Beta Gastro GmbH', 'ti-e-beta');
  configureSaldo(deps, alpha.workspaceId, 'ti-e-alpha');
  configureSaldo(deps, beta.workspaceId, 'ti-e-beta');

  const elected = call(deps, 'vat_saldo_declaration_basis', {
    workspaceId: alpha.workspaceId,
    taxPeriod: '2026',
    basis: 'highest_rate',
    idempotencyKey: 'ti-e-1',
  });
  assert.equal(elected.ok, true, JSON.stringify(elected));

  const alphaGens = call(deps, 'vat_saldo_generations', { workspaceId: alpha.workspaceId });
  assert.deepEqual(
    alphaGens.elections.map((e) => [e.taxPeriod, e.basis]),
    [['2026', 'highest_rate']],
  );

  const betaGens = call(deps, 'vat_saldo_generations', { workspaceId: beta.workspaceId });
  assert.deepEqual(betaGens.elections, [], "Beta inherited Alpha's Art. 88 Abs. 6 election");

  // And the config read, which is what the Studio renders the radio from, agrees.
  const betaConfig = call(deps, 'vat_config', { workspaceId: beta.workspaceId });
  assert.equal(betaConfig.ok, true);
  assert.equal(betaConfig.config.saldoDeclarationBasis, null, "Beta's config reported Alpha's election");

  const alphaConfig = call(deps, 'vat_config', { workspaceId: alpha.workspaceId });
  assert.equal(alphaConfig.config.saldoDeclarationBasis, 'highest_rate');

  // The row count is the last word: one election in the whole store, and it belongs to Alpha.
  const rows = deps.store.db
    .prepare('SELECT workspace_id, tax_period, basis FROM vat_saldo_declaration_election')
    .all();
  assert.deepEqual(rows, [{ workspace_id: alpha.workspaceId, tax_period: '2026', basis: 'highest_rate' }]);
});
