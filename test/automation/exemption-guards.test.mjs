/**
 * The two load-time guards the G01 remediation added, tested for TEETH rather than for silence.
 *
 * WHY A PASSING IMPORT IS NOT A PASSING TEST, which is the whole reason this file exists. Both guards
 * run at module load in `src/api/registry.ts`, so the fact that the suite imports at all proves the
 * tree is currently clean. It proves nothing whatever about the guard: a predicate that was inverted,
 * a shape table whose entries all returned `undefined`, or an invoker list that arrived empty would
 * every one of them import perfectly and catch nothing, for ever, silently. That is the exact failure
 * mode `assertActionInvokersAreGated` was written to prevent in the first place (a hand-kept list
 * drifting), and a guard is entitled to no more trust than the thing it guards.
 *
 * So every assertion below feeds the guard something it MUST reject and checks that it does. The
 * inputs are derived from the live registry and then mutated in exactly one fact, so a test cannot
 * pass by describing a world the engine does not produce.
 *
 * WHY THIS LIVES UNDER `test/automation/`. Both guards exist because of G01. The invoker rule was
 * written after `run_due_automations` spent eleven days exempt while holding an `ActionInvoker`, and
 * the shape vocabulary was written after two exemptions (`run_due_automations` and
 * `create_saved_view`) turned out to carry prose that was simply false. The rule is A24's and the
 * defect was G01's, and the defect is what a regression test is for.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS } from '../../dist/api/registry.js';
import {
  CAPABILITY_FOR_ACTION,
  assertActionInvokersAreGated,
  assertEveryActionIsGated,
  isUngated,
} from '../../dist/core/access/index.js';

/** The registry's own facts, in the shape the gate check consumes. Derived, never restated. */
const gatedActions = () =>
  ACTIONS.map((a) => ({
    name: a.name,
    kind: a.kind,
    reachesTheGate: a.inputSchema.required.includes('workspaceId'),
  }));

/** Every verb currently carrying an exemption, whatever its shape. */
const ungatedNames = () =>
  Object.keys(CAPABILITY_FOR_ACTION).filter((name) => isUngated(CAPABILITY_FOR_ACTION[name]));

test('GUARD: the live tree passes both checks, which is the baseline and not the claim', () => {
  // Stated explicitly so the rest of the file is unambiguous: this is the only assertion here that a
  // broken guard would also satisfy. Everything below is the opposite direction.
  assert.doesNotThrow(() => assertEveryActionIsGated(gatedActions()));
  assert.doesNotThrow(() => assertActionInvokersAreGated([]));
});

test('GUARD: assertActionInvokersAreGated REJECTS every exemption in the registry', () => {
  // The teeth. An invoking verb can cause any other verb to run as a different actor, so its own gate
  // is the only thing between a caller and every capability every rule author holds. Whatever shape
  // the author picked, the shape is wrong. Driven over every exemption the tree actually holds, so a
  // sixth shape added later is covered without editing this file.
  const exempt = ungatedNames();
  assert.ok(exempt.length > 0, 'no verb is exempt at all, so this assertion is vacuous');

  for (const name of exempt) {
    assert.throws(
      () => assertActionInvokersAreGated([name]),
      /capability-laundering/,
      `${name} is exempt, and the invoker guard let it through as an invoking verb`,
    );
  }
});

test('GUARD: assertActionInvokersAreGated rejects a name the registry does not gate at all', () => {
  // An unknown name resolves to `undefined` rather than to an exemption, and that must fail the same
  // way: a firing verb whose capability declaration was simply forgotten is the likelier accident.
  assert.throws(() => assertActionInvokersAreGated(['gibt_es_nicht']), /capability-laundering/);
});

test('GUARD: assertActionInvokersAreGated ACCEPTS the gated verbs, so it is not simply throwing', () => {
  // The other direction. A guard that rejected everything would satisfy every assertion above and
  // would have to be disabled by whoever hit it next.
  const gated = Object.keys(CAPABILITY_FOR_ACTION).filter((name) => !isUngated(CAPABILITY_FOR_ACTION[name]));
  assert.ok(gated.length > 0);
  assert.doesNotThrow(() => assertActionInvokersAreGated(gated));

  // And G01's own firing verbs specifically, which are the two the rule was written for. They are
  // named here rather than derived because the derivation lives inside `automationActions()` as a
  // byproduct of construction and is deliberately not exported: naming them is the compromise, and if
  // one is ever un-gated this assertion fails before the load-time guard is even reached.
  for (const name of ['run_due_automations', 'retry_automation_run']) {
    const rule = CAPABILITY_FOR_ACTION[name];
    assert.notEqual(rule, undefined, `${name} is not in the capability map at all`);
    assert.equal(isUngated(rule), false, `${name} holds an ActionInvoker and must never be exempt`);
    assert.equal(rule, 'manage_automations');
  }
});

test('GUARD: the shape check rejects an exemption the registry contradicts', () => {
  // `SHAPE_REQUIRES` is the only check in the file that looks at an exemption's CONTENT, and it is
  // the answer to "nothing measures an ungated reason against anything". Fed the real action list
  // with exactly ONE fact mutated, so the rejection can only be about the shape.
  const stopButton = CAPABILITY_FOR_ACTION.disable_automation_rule;
  assert.equal(isUngated(stopButton), true, 'the stop button is no longer the prevents_only example');
  assert.equal(stopButton.shape, 'prevents_only');

  // `prevents_only` promises the verb is a WRITE: a read prevents nothing. Call it a read and the
  // guard must say so.
  const asRead = gatedActions().map((a) =>
    a.name === 'disable_automation_rule' ? { ...a, kind: 'read' } : a,
  );
  assert.throws(
    () => assertEveryActionIsGated(asRead),
    /claims 'prevents_only'/,
    'a prevents_only exemption on a READ was accepted',
  );
});

test('GUARD: the shape check rejects an asserted_in_engine verb that never reaches a ctx', () => {
  // The other mutation, on the other shape G00 relies on. `asserted_in_engine` promises there IS a
  // `ctx.capabilities` for the engine to assert on, so a pre-workspace verb claiming it is claiming
  // an assertion that can never run.
  const view = CAPABILITY_FOR_ACTION.update_saved_view;
  assert.equal(isUngated(view), true);
  assert.equal(view.shape, 'asserted_in_engine');

  const preWorkspace = gatedActions().map((a) =>
    a.name === 'update_saved_view' ? { ...a, reachesTheGate: false } : a,
  );
  assert.throws(
    () => assertEveryActionIsGated(preWorkspace),
    /claims 'asserted_in_engine'/,
    'an asserted_in_engine exemption on a pre-workspace verb was accepted',
  );
});

test('GUARD: every exemption in the tree carries a shape from the closed set, and a real reason', () => {
  // The vocabulary is only worth anything if it is closed. A free-text reason is prose and prose is
  // not checkable, which is how two false exemptions read plausibly for eleven days.
  const SHAPES = new Set([
    'pre_workspace',
    'self_scoped_read',
    'machine_scope',
    'asserted_in_engine',
    'prevents_only',
  ]);
  for (const name of ungatedNames()) {
    const rule = CAPABILITY_FOR_ACTION[name];
    assert.ok(SHAPES.has(rule.shape), `${name} claims the shape '${rule.shape}', which is not in the closed set`);
    assert.equal(typeof rule.reason, 'string', `${name} carries no reason`);
    assert.ok(rule.reason.length > 20, `${name} carries a reason too short to be one`);
  }
});
