/**
 * A24, the guard that keeps the ADVERTISED bundle and the GRANTED bundle in step.
 *
 * THE SIBLING OF `declared-gate-matches-enforced.test.mjs`, one level out. That suite holds what a
 * VERB declares against what the engine enforces when it runs. This one holds what a ROLE is
 * advertised to carry against what `capabilityFor` actually answers for a member holding it. Same
 * class of defect, different surface, and the class has now produced three separate defects in A24:
 * five verbs declared a capability the engine did not enforce, two `ungated()` reasons were false,
 * and `list_roles` advertised `viewer` as holding nothing.
 *
 * WHAT THE THIRD ONE COST, because it is the argument for measuring this at all. `viewer` resolving
 * to `[]` was harmless while no read was gated: a viewer really did hold nothing. D50 gated reads
 * and moved `VIEWER_CAPABILITIES` to the five read domains, and the literal in `roles.ts` stayed
 * behind, so the Roles tab printed "Keine Rechte" for a role that could read the entire ledger, all
 * master data, all sales and all VAT. Measured on 29.07.2026 against the built engine:
 *
 *   viewer   advertised 0  []
 *            enforced   5  [read_automations, read_books, read_master_data, read_sales, read_vat]
 *
 * The other four built-ins matched, which is exactly why nobody noticed: it looked like a
 * convention rather than an asymmetry.
 *
 * IT UNDER-REPORTED, AND THAT IS THE DIRECTION THAT MATTERS. D50 accepted a real cost, seating the
 * MCP agent as an owner on provisioning, on the explicit mitigation that a person can SEE that on
 * the Members surface and narrow it. The screen IS the mitigation. A screen that over-reports access
 * is alarming and self-correcting; one that under-reports tells an operator they have contained an
 * agent that is still reading every book in the workspace. So the assertion below is equality, and
 * the failure message names the direction.
 *
 * DERIVED ON BOTH SIDES, never from a list. The roles come from `list_roles`'s own answer, so a
 * sixth built-in or a custom role added later is measured with nobody editing this file, and the
 * capabilities come from `CAPABILITY_IDS`. Nothing here restates a bundle: restating one is the
 * defect under test.
 *
 * BOTH ADVERTISEMENT SURFACES ARE HELD, and only one of them is cosmetic. `list_roles` feeds the
 * Roles tab, which is a display. `whoami` is the Studio's ONE permission source
 * (`app/src/lib/capabilities.ts`), so a `whoami` that disagreed with `capabilityFor` would be a
 * control rendered against the wrong answer rather than a wrong label. It resolves correctly today;
 * this suite is what keeps that true.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { CAPABILITY_IDS } from '../../dist/core/access/index.js';
import { capabilityFor } from '../../dist/core/access/capability.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/**
 * A provisioned workspace, with `studio` as an owner and `agent` as a seat to move around.
 *
 * Built through the product's own verbs and never by writing a row: `invite_member` performs the
 * D50 provisioning flip, which seats BOTH D13 actors as owners. A change to that flow reddens this
 * fixture rather than leaving it asserting against a world the engine cannot make.
 */
function provisioned(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Rechte GmbH', `ab-w-${seed}`);
  const invited = getAction('invite_member').run(deps, {
    workspaceId,
    email: `${seed}@muster.ch`,
    role: 'bookkeeper',
    idempotencyKey: `ab-i-${seed}`,
  });
  assert.equal(invited.ok, true, `invite failed: ${JSON.stringify(invited)}`);
  const seat = getAction('list_members')
    .run(deps, { workspaceId })
    .members.find((m) => m.actorId === 'agent');
  assert.ok(seat !== undefined, 'the flip did not seat the agent, so there is no seat to move');
  return { deps, workspaceId, seatId: seat.memberId };
}

/** What `list_roles` ADVERTISES, read by an owner, as a role id to sorted bundle map. */
function advertisedBundles(deps, workspaceId) {
  const listed = getAction('list_roles').run(deps, { workspaceId });
  assert.equal(listed.ok, true, `list_roles failed: ${JSON.stringify(listed)}`);
  return new Map(listed.roles.map((r) => [r.id, [...r.capabilities].sort()]));
}

/** What `capabilityFor` GRANTS the `agent` actor once its seat is moved onto `roleId`. */
function grantedBundle({ deps, workspaceId, seatId }, roleId) {
  const moved = getAction('set_role').run(deps, { workspaceId, memberId: seatId, role: roleId });
  assert.equal(moved.ok, true, `set_role ${roleId} failed: ${JSON.stringify(moved)}`);
  return CAPABILITY_IDS.filter((c) => capabilityFor(deps.store, workspaceId, 'agent', c)).sort();
}

/**
 * The comparison, factored out so the suite can be turned on ITSELF below.
 *
 * Returns the two directions separately, because they are not equally dangerous and a reader of a
 * red run needs to know which one fired.
 */
function drift(advertised, granted) {
  return {
    advertisedButNotGranted: advertised.filter((c) => !granted.includes(c)),
    grantedButNotAdvertised: granted.filter((c) => !advertised.includes(c)),
  };
}

function assertNoDrift(roleId, advertised, granted, probeActor = 'agent') {
  // A35 critic F1 (re-critic R-F3: the tolerance is ACTOR-SCOPED, exactly like the engine rule it
  // mirrors): `capabilityFor` runs a step 0 denying the `agent` actor `manage_agent_dial` on every
  // role: the governed seat never holds its own governor. The role-level advertisement is still
  // correct for every HUMAN member, so the sweep tolerates that one advertised-not-granted entry
  // ONLY when the probe actor is the agent seat; a human probe gets no tolerance at all, so the
  // filter cannot hide a real advertisement defect if the probe actor ever changes. The exception
  // itself is pinned in its own test below, and `whoami` subtracts it for the agent actor so the
  // granted side and whoami still agree.
  const raw = drift(advertised, granted);
  const advertisedButNotGranted =
    probeActor === 'agent'
      ? raw.advertisedButNotGranted.filter((c) => c !== 'manage_agent_dial')
      : raw.advertisedButNotGranted;
  const grantedButNotAdvertised = raw.grantedButNotAdvertised;
  assert.deepEqual(
    grantedButNotAdvertised,
    [],
    `role '${roleId}' GRANTS capabilities the permissions screen does not show: ` +
      `[${grantedButNotAdvertised.join(', ')}]. This is the dangerous direction: an operator ` +
      `reading this screen believes the role is narrower than it is.`,
  );
  assert.deepEqual(
    advertisedButNotGranted,
    [],
    `role '${roleId}' is advertised as holding [${advertisedButNotGranted.join(', ')}], ` +
      `which the engine refuses. The Roles tab renders a checkbox as a promise the engine breaks.`,
  );
}

/** Every role in the workspace, advertised against granted. Shared by both fixtures below. */
function measureEveryRole(fixture, expectedAtLeast) {
  const advertised = advertisedBundles(fixture.deps, fixture.workspaceId);
  // Non-vacuous by construction: an empty or short map would pass every assertion below without
  // comparing a single bundle.
  assert.ok(
    advertised.size >= expectedAtLeast,
    `only ${advertised.size} roles were advertised; the fixture is wrong, not the engine`,
  );
  for (const [roleId, bundle] of advertised) {
    assertNoDrift(roleId, bundle, grantedBundle(fixture, roleId));
  }
  return advertised;
}

test('A24: every role list_roles advertises grants exactly what it advertises (unseeded built-ins)', () => {
  // No `define_role` here on purpose, so the three editable built-ins are answered through
  // `listRoles`'s UNSEEDED branch, which is a different expression from the stored one below.
  const fixture = provisioned('unseeded');
  const advertised = measureEveryRole(fixture, 5);

  // The two anchors and the three editable built-ins, and nothing has silently stopped being offered.
  assert.deepEqual(
    [...advertised.keys()].sort(),
    ['agent', 'bookkeeper', 'owner', 'treuhaender', 'viewer'],
    'the built-in role vocabulary changed; that is a policy change and it belongs in a decision',
  );
});

test('A24: the same holds once the built-ins are seeded and a custom role exists', () => {
  // `define_role` seeds, so the three editable built-ins now arrive through the STORED branch, and
  // the custom role exercises the ordinary path a workspace actually uses.
  const fixture = provisioned('stored');
  const defined = getAction('define_role').run(fixture.deps, {
    workspaceId: fixture.workspaceId,
    name: 'Nur die MWST',
    capabilities: ['read_vat', 'manage_vat_config'],
    idempotencyKey: 'ab-d-stored',
  });
  assert.equal(defined.ok, true, `define_role failed: ${JSON.stringify(defined)}`);

  const advertised = measureEveryRole(fixture, 6);
  assert.ok(advertised.has(defined.roleId), 'the custom role was not advertised at all');
  assert.deepEqual(
    advertised.get(defined.roleId),
    ['manage_vat_config', 'read_vat'],
    'a custom bundle must be advertised as exactly what was asked for',
  );
});

test('A24: viewer is advertised as the read domains it really holds, and not as nothing', () => {
  // The specific regression, pinned by name rather than only by the derived sweep above, because the
  // sweep would also pass if BOTH sides became empty together.
  const fixture = provisioned('viewer');
  const advertised = advertisedBundles(fixture.deps, fixture.workspaceId).get('viewer');

  assert.ok(advertised.length > 0, 'viewer advertises nothing again; the Roles tab says "Keine Rechte"');
  assert.deepEqual(
    advertised,
    ['egress.read', 'landscape.read', 'read_automations', 'read_books', 'read_master_data', 'read_sales', 'read_vat'],
    'the viewer anchor moved; if that is deliberate it is a D50-class decision, not a refactor',
  );
  // `landscape.read` was added to the viewer anchor ON PURPOSE (N00, D126): the environment indicator
  // and the LIVE banner (matrix E6a) must be visible to everyone, a read-only viewer included, and it
  // discloses only machine topology, never a client's books. This is the "deliberate D50-class
  // decision" the assertion above asks the editor to make consciously.
  // The one read `viewer` is deliberately denied (D50: a Treuhänder sees the books, not the roster),
  // so the assertion above is a real cut and not just "every read".
  assert.ok(!advertised.includes('read_members'), 'viewer must not see the member roster');
  assert.ok(!advertised.includes('diagnostics.read'), 'viewer has never held recorded diagnostics');
});

test('A24: whoami advertises exactly what capabilityFor grants, for every role', () => {
  // The half that would be a HOLE rather than a wrong label. `whoami` is the Studio's only permission
  // source, so a divergence here renders a control against an answer the engine does not hold.
  const fixture = provisioned('whoami');
  const roles = [...advertisedBundles(fixture.deps, fixture.workspaceId).keys()];
  assert.ok(roles.length >= 5, `only ${roles.length} roles to measure; the fixture is wrong`);

  for (const roleId of roles) {
    const granted = grantedBundle(fixture, roleId);
    const me = getAction('whoami').run({ ...fixture.deps, actor: 'agent' }, { workspaceId: fixture.workspaceId });
    assert.equal(me.ok, true, `whoami failed: ${JSON.stringify(me)}`);
    assert.equal(me.role, roleId, 'whoami reported a role the seat does not hold');
    assertNoDrift(`${roleId} (via whoami)`, [...me.capabilities].sort(), granted);
  }
});

test('A24: the guard itself detects the defect it was written for', () => {
  // FALSIFICATION, in the suite rather than only in a commit message. The shipped defect was the
  // literal `[]` where the viewer bundle belonged. Feeding that exact wrong value through the same
  // comparison the assertions above use must produce drift in the under-reporting direction; if it
  // did not, every test in this file would be measuring nothing.
  const fixture = provisioned('falsify');
  const granted = grantedBundle(fixture, 'viewer');
  assert.ok(granted.length > 0, 'a viewer grants nothing, so the defect is unrepresentable here');

  const asShipped = drift([], granted);
  assert.deepEqual(
    asShipped.grantedButNotAdvertised,
    granted,
    'the comparison does not notice a role that advertises nothing and grants everything it reads',
  );
  assert.deepEqual(asShipped.advertisedButNotGranted, [], 'the other direction must stay quiet here');

  // And the opposite direction, so neither half of the comparison is dead code.
  const overClaiming = drift([...granted, 'manage_members'], granted);
  assert.deepEqual(overClaiming.advertisedButNotGranted, ['manage_members']);
  assert.deepEqual(overClaiming.grantedButNotAdvertised, []);
});


test('A35/F1: the AGENT actor is the one pinned exception, denied and un-advertised alike', () => {
  // The sweep above measures ROLE bundles with a human probe. This is the exception it deliberately
  // does not measure: the governed seat never holds `manage_agent_dial` (capabilityFor step 0), on
  // any role, provisioned or not, and whoami advertises the SAME subtraction so no client renders a
  // control the engine refuses.
  const fixture = provisioned('agent-exception');
  const grantedToAgent = CAPABILITY_IDS.filter((c) =>
    capabilityFor(fixture.deps.store, fixture.workspaceId, 'agent', c),
  );
  assert.ok(!grantedToAgent.includes('manage_agent_dial'), 'the governed seat never holds its own governor');
  assert.ok(grantedToAgent.length > 0, 'and the exception is ONLY the governor: the agent-owner still works');

  const me = getAction('whoami').run({ ...fixture.deps, actor: 'agent' }, { workspaceId: fixture.workspaceId });
  assert.equal(me.ok, true);
  assert.ok(!me.capabilities.includes('manage_agent_dial'), 'whoami advertises exactly what is granted');
});
