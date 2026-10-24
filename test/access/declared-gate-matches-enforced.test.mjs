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
import { handleRest } from '../../dist/api/rest.js';
import { CAPABILITY_FOR_ACTION, MINIMUM_CAPABILITIES_FOR_DYNAMIC, isUngated, requiredCapabilitiesFor } from '../../dist/core/access/index.js';
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

test('A24, critic D175-C6: compose_entry in its bank form asks the bank inbox read right; the plain form does not', () => {
  // Guards the input-keyed `compose_entry` rule in actionCapabilities.ts: without it a seat holding the
  // books and the VAT but not the bank could preview any bank line's amount and a rule's expansion.
  const bankInput = (workspaceId) => ({
    workspaceId,
    mode: 'expand',
    bankTxnId: 'btx_unknown',
    target: { kind: 'accounts', legs: [{ accountId: 'x', amountMinor: 100 }] },
  });
  const seat = agentHoldingExactly(['read_books', 'read_vat'], 'c6-books');
  const bank = getAction('compose_entry').run(seat.deps, bankInput(seat.workspaceId));
  assert.equal(bank.ok, false);
  assert.equal(bank.error, 'permission_denied');
  assert.equal(bank.capability, 'read_sales');
  const plain = getAction('compose_entry').run(seat.deps, { workspaceId: seat.workspaceId, mode: 'expand', date: '2026-03-02', lines: [] });
  assert.notEqual(plain.error, 'permission_denied', 'the journal composer stays on the books and the VAT');
  const banked = agentHoldingExactly(['read_books', 'read_vat', 'read_sales'], 'c6-bank');
  const allowed = getAction('compose_entry').run(banked.deps, bankInput(banked.workspaceId));
  assert.equal(allowed.error, 'not_found', 'with the bank read right the read runs (and finds no such line)');
});

test('A24, D176: the TEMPLATE forms of compose_entry and post_entry both ask the bank inbox read right; their plain forms do not', () => {
  // Guards the input-keyed `compose_entry` and `post_entry` rules in actionCapabilities.ts (and the
  // engine's own assert in postEntryFromTemplate): both read a Vorlage, a rule row `list_bank_standards`
  // reads under `read_sales`, so neither may be a side door to it.
  const template = { standardId: 'bstd_unknown', asks: {} };
  const seat = agentHoldingExactly(['post', 'read_books', 'read_vat'], 'd176-books');
  const composed = getAction('compose_entry').run(seat.deps, { workspaceId: seat.workspaceId, mode: 'expand', date: '2026-03-02', template });
  assert.deepEqual([composed.error, composed.capability], ['permission_denied', 'read_sales']);
  const posted = getAction('post_entry').run(seat.deps, { workspaceId: seat.workspaceId, date: '2026-03-02', source: 'manual', template, idempotencyKey: 'd176-p1' });
  assert.deepEqual([posted.error, posted.capability], ['permission_denied', 'read_sales']);
  const plainPost = getAction('post_entry').run(seat.deps, { workspaceId: seat.workspaceId, date: '2026-03-02', source: 'manual', lines: [], idempotencyKey: 'd176-p2' });
  assert.notEqual(plainPost.error, 'permission_denied', 'typed lines stay on post alone');
  const banked = agentHoldingExactly(['post', 'read_books', 'read_vat', 'read_sales'], 'd176-bank');
  const allowedCompose = getAction('compose_entry').run(banked.deps, { workspaceId: banked.workspaceId, mode: 'expand', date: '2026-03-02', template });
  assert.equal(allowedCompose.verdict?.error, 'rule_not_found', 'with the right the read runs (and finds no such Vorlage)');
  const allowedPost = getAction('post_entry').run(banked.deps, { workspaceId: banked.workspaceId, date: '2026-03-02', source: 'manual', template, idempotencyKey: 'd176-p3' });
  assert.equal(allowedPost.error, 'rule_not_found');
});

test('A24, critic D176-R2-2: a NULL template is absent: typed lines with template: null post on post alone, through MCP and REST alike', () => {
  // Guards `hasTemplate` (actionCapabilities.ts) and the null-aware dispatch of post_entry (registry.ts)
  // and compose_entry (compose-actions.ts): a null template used to read as present and ask read_sales.
  const seat = agentHoldingExactly(['post', 'read_books', 'read_vat'], 'r22-null');
  const accounts = getAction('list_accounts').run({ ...seat.deps, actor: 'studio' }, { workspaceId: seat.workspaceId }).accounts;
  const acc = (n) => accounts.find((a) => a.number === n).id;
  const lines = [
    { account: acc('6570'), debit: 1000 },
    { account: acc('2800'), credit: 1000 },
  ];
  const base = { workspaceId: seat.workspaceId, date: '2026-03-02', source: 'manual', lines, template: null };
  const viaMcp = getAction('post_entry').run(seat.deps, { ...base, idempotencyKey: 'r22-m' });
  const viaRest = handleRest('post_entry', { ...base, idempotencyKey: 'r22-r' }, seat.deps).body;
  for (const [face, answer] of [
    ['MCP', viaMcp],
    ['REST', viaRest],
  ]) {
    assert.equal(answer.ok, true, `${face}: ${JSON.stringify(answer).slice(0, 200)}`);
    assert.notEqual(answer.error, 'permission_denied', face);
  }
  const composed = getAction('compose_entry').run(seat.deps, { workspaceId: seat.workspaceId, mode: 'expand', date: '2026-03-02', lines, template: null });
  assert.equal(composed.ok, true, `compose_entry with template: null composes the typed lines: ${JSON.stringify(composed).slice(0, 200)}`);
  assert.equal(composed.verdict.ok, true);
});

test('A24, D176: an input-keyed rule declares a MINIMUM the palette disables on, and every form of the verb asks it', () => {
  // Guards MINIMUM_CAPABILITIES_FOR_DYNAMIC (actionCapabilities.ts), which the command source projects for
  // the Studio palette: post_entry needs post and compose_entry the books and the VAT in every form.
  assert.deepEqual({ ...MINIMUM_CAPABILITIES_FOR_DYNAMIC }, { post_entry: ['post'], compose_entry: ['read_books', 'read_vat'] });
  const forms = {
    post_entry: [{}, { lines: [] }, { template: { standardId: 'x', asks: {} } }, { template: null }],
    compose_entry: [{ mode: 'expand' }, { bankTxnId: 'x' }, { template: { standardId: 'x', asks: {} } }, { template: null }],
  };
  for (const [name, minimum] of Object.entries(MINIMUM_CAPABILITIES_FOR_DYNAMIC)) {
    assert.equal(typeof CAPABILITY_FOR_ACTION[name], 'function', `${name} is input-keyed`);
    for (const input of forms[name]) {
      const asked = requiredCapabilitiesFor(name, input);
      for (const c of minimum) assert.ok(asked.includes(c), `${name} ${JSON.stringify(input)} asks ${asked.join(', ')}, not ${c}`);
    }
  }
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
