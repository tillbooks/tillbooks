/**
 * A24, the guard that keeps the DECLARED gate and the ENFORCED gate in step.
 *
 * WHY THIS SUITE IS WORTH MORE THAN THE ROWS IT FIXED. `CAPABILITY_FOR_ACTION` is not documentation:
 * it is what the Roles tab renders as a checkbox and what `whoami` hands the Studio to pre-disable a
 * control with. A verb whose engine body asserts a capability the declaration does not name is
 * therefore a LIE ON A PERMISSIONS SCREEN, and it is invisible to every built-in role, because all
 * of them carry `post`. It becomes visible on the first CUSTOM role, which is the feature A24
 * shipped. Measured on 29.07.2026 against the built engine, five verbs lied:
 *
 *   unlock_period     declared 'unlock_period'     -> refused, wanting 'manage_periods'
 *   set_fx_method     declared 'manage_vat_config' -> refused, wanting 'post'
 *   record_payment    declared 'pay'               -> refused, wanting 'post'
 *   allocate_payment  declared 'pay'               -> refused, wanting 'post'
 *   reverse_payment   declared 'pay'               -> refused, wanting 'post'
 *
 * The wave critic reproduced two of them. The other three were found by this measurement, which is
 * the argument for having it: two rows repaired by hand would have left three lying, and the sixth
 * would arrive with the next capability that appends a verb.
 *
 * WHAT IS ASSERTED, in one sentence, because the declaration promises exactly this and no more: a
 * role holding EVERY capability the verb declares, and nothing else, is not refused for lack of a
 * capability. It may be refused for anything else (`invalid_input` on a filler payload,
 * `period_locked`, `unknown_role`); those are the verb working. It may also be refused by a further
 * STATE-dependent capability that the boundary cannot see, and `unlock_period` is the one such verb
 * in the product: its filler input names a period with no lock, so the hard-lock branch is not
 * reached, which is the same thing as saying the declaration covers every unconditional gate.
 *
 * DERIVED FROM `ACTIONS`, never from a list, so a verb appended next month is measured with nobody
 * editing this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { CAPABILITY_FOR_ACTION, isUngated } from '../../dist/core/access/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/** The write verbs the boundary really gates: ctx verbs with a capability rather than an exemption. */
function gatedCtxWrites() {
  return ACTIONS.filter(
    (a) =>
      a.kind === 'write' &&
      a.inputSchema.required.includes('workspaceId') &&
      CAPABILITY_FOR_ACTION[a.name] !== undefined &&
      !isUngated(CAPABILITY_FOR_ACTION[a.name]),
  );
}

/** A type-VALID filler for every required field, so a CAPABILITY is the first thing that can refuse. */
function validFiller(action, workspaceId, extra = {}) {
  const out = { ...extra };
  for (const field of action.inputSchema.required) {
    if (field === 'workspaceId') {
      out[field] = workspaceId;
      continue;
    }
    if (out[field] !== undefined) continue;
    const declared = action.inputSchema.properties[field]?.type;
    if (declared === 'integer') out[field] = 1;
    else if (declared === 'boolean') out[field] = true;
    else if (declared === 'array') out[field] = [];
    else if (declared === 'object') out[field] = {};
    else out[field] = 'x';
  }
  return out;
}

/**
 * A workspace where the `agent` actor holds a CUSTOM role carrying exactly `capabilities`.
 *
 * Built through the product's own verbs, never by writing a row: `invite_member` performs the D50
 * flip (which seats BOTH D13 actors as owners), `define_role` mints the custom bundle (it CREATES
 * when `roleId` is absent; a `roleId` that does not exist is an update and answers `role_not_found`),
 * and `set_role` narrows the AGENT's own seat onto it. A change to that flow reddens this fixture
 * rather than leaving it asserting against a world the engine cannot make.
 */
function agentHoldingExactly(capabilities, seed, probeActor = 'agent') {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Rollen GmbH', `dg-${seed}`);

  const invited = getAction('invite_member').run(deps, {
    workspaceId,
    email: `${seed}@muster.ch`,
    role: 'bookkeeper',
    idempotencyKey: `dg-i-${seed}`,
  });
  assert.equal(invited.ok, true, `invite failed: ${JSON.stringify(invited)}`);

  const defined = getAction('define_role').run(deps, {
    workspaceId,
    name: 'Genau diese Rechte',
    capabilities: [...capabilities],
    idempotencyKey: `dg-d-${seed}`,
  });
  assert.equal(defined.ok, true, `define_role failed: ${JSON.stringify(defined)}`);
  assert.deepEqual(
    [...defined.capabilities].sort(),
    [...new Set(capabilities)].sort(),
    'the stored bundle is not the bundle that was asked for',
  );

  const seat = getAction('list_members')
    .run(deps, { workspaceId })
    .members.find((m) => m.actorId === probeActor);
  assert.ok(seat !== undefined, `the flip did not seat ${probeActor}, so there is no row to narrow`);
  const moved = getAction('set_role').run(deps, {
    workspaceId,
    memberId: seat.memberId,
    role: defined.roleId,
  });
  assert.equal(moved.ok, true, `set_role failed: ${JSON.stringify(moved)}`);

  deps.actor = probeActor;
  return { deps, workspaceId };
}

/** Every (verb, declared-bundle, extra-input) triple this suite has to measure. */
function casesUnderTest() {
  const cases = [];
  for (const action of gatedCtxWrites()) {
    const rule = CAPABILITY_FOR_ACTION[action.name];
    if (typeof rule === 'function') {
      // The one input-dependent rule (`transition_document`). BOTH branches it can take are
      // measured, because a rule that reads the input has two declarations, not one.
      for (const to of ['sent', 'accepted']) {
        cases.push({ action, capabilities: [rule({ to })], extra: { to }, label: `${action.name}[to=${to}]` });
      }
      continue;
    }
    const capabilities = Array.isArray(rule) ? rule : [rule];
    cases.push({ action, capabilities, extra: {}, label: action.name });
  }
  return cases;
}

test('A24: holding exactly what a verb DECLARES is never refused for lack of a capability', () => {
  const cases = casesUnderTest();
  // Non-vacuous by construction: a filter that silently matched nothing would pass every assertion
  // below without calling a single verb.
  assert.ok(cases.length > 40, `only ${cases.length} declared gates were derived; the filter is wrong`);

  const lies = [];
  for (const { action, capabilities, extra, label } of cases) {
    // A35 critic F1: `manage_agent_dial` is the one capability the AGENT actor can never hold
    // (capabilityFor step 0: the governed seat never holds its own governor), so the declared-gate
    // claim for the four governor verbs is measured with a HUMAN probe. That is also who those
    // verbs exist for: approve, reject, grant and erase are the human's decisions over the agent.
    const probeActor = capabilities.includes('manage_agent_dial') ? 'studio' : 'agent';
    const { deps, workspaceId } = agentHoldingExactly(capabilities, label.replace(/[^a-z0-9]/gi, '-'), probeActor);
    const res = action.run(deps, validFiller(action, workspaceId, extra));
    if (res.ok === false && res.error === 'permission_denied') {
      lies.push(
        `${label}: declares [${capabilities.join(', ')}] but the engine refused, wanting '${res.capability}'`,
      );
    }
  }
  assert.deepEqual(lies, [], 'the Roles tab would render these checkboxes as a promise the engine breaks');
});

test('A24: the ALL-OF form really requires all of it, measured on each half of a payment gate', () => {
  // The regression this pins: collapsing `['pay', 'post']` back to either half alone. Both roles
  // below are refused, and each is refused for the half it is missing, which is the fact a caller
  // acts on.
  const missingPost = agentHoldingExactly(['pay'], 'allof-pay');
  const withoutPost = getAction('record_payment').run(missingPost.deps, {
    workspaceId: missingPost.workspaceId,
    direction: 'inbound',
    date: '2026-03-01',
    amountMinor: 1000,
    bankAccountId: 'x',
    intent: 'x',
    idempotencyKey: 'allof-1',
  });
  assert.equal(withoutPost.ok, false);
  assert.equal(withoutPost.error, 'permission_denied');
  assert.equal(withoutPost.capability, 'post');

  const missingPay = agentHoldingExactly(['post'], 'allof-post');
  const withoutPay = getAction('record_payment').run(missingPay.deps, {
    workspaceId: missingPay.workspaceId,
    direction: 'inbound',
    date: '2026-03-01',
    amountMinor: 1000,
    bankAccountId: 'x',
    intent: 'x',
    idempotencyKey: 'allof-2',
  });
  assert.equal(withoutPay.ok, false);
  assert.equal(withoutPay.error, 'permission_denied');
  // Declaration order decides which half is named, and `pay` is declared first because it is the
  // capability the operator was reasoning about when they opened the Roles tab.
  assert.equal(withoutPay.capability, 'pay');
});

test('A24: unlock_period still refuses a hard lock without the narrower capability', () => {
  // The state-dependent gate the declaration deliberately does NOT name. `manage_periods` clears a
  // soft lock (which is why declaring both would have been a regression) and is refused on an
  // unsealed hard one, naming `unlock_period`.
  const { deps, workspaceId } = agentHoldingExactly(['manage_periods'], 'unlock');

  const locked = getAction('lock_period').run(deps, {
    workspaceId,
    period: '2026-03',
    kind: 'hard',
    idempotencyKey: 'ul-lock',
  });
  assert.equal(locked.ok, true, `lock_period failed: ${JSON.stringify(locked)}`);

  const refused = getAction('unlock_period').run(deps, {
    workspaceId,
    period: '2026-03',
    idempotencyKey: 'ul-unlock',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'permission_denied');
  assert.equal(refused.capability, 'unlock_period');

  // And the soft-lock clear the declaration exists to preserve: same role, same verb, allowed.
  const soft = getAction('lock_period').run(deps, {
    workspaceId,
    period: '2026-04',
    kind: 'soft',
    idempotencyKey: 'ul-soft',
  });
  assert.equal(soft.ok, true, `soft lock_period failed: ${JSON.stringify(soft)}`);
  const cleared = getAction('unlock_period').run(deps, {
    workspaceId,
    period: '2026-04',
    idempotencyKey: 'ul-clear',
  });
  assert.equal(cleared.ok, true, `a manage_periods role could not clear a SOFT lock: ${JSON.stringify(cleared)}`);
});
