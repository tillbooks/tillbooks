/**
 * D161.2: a plugin's call is never a person's call.
 *
 * The defect: `runPluginToolCall` dispatches a plugin's tool call AS the member who installed the
 * plugin (so A24 binds it to that member's rights). Every human-only check reads the actor
 * (`isGovernedSeat`, `actorIsHuman`), and the installer is a person, so plugin code passed them all:
 * it could record a G20 sign-off, confirm a statement gap, set the agent dial, approve a drafted
 * action, and record a G09 migration approval, each as if the installer had clicked the button.
 *
 * The rule: while the bridge runs a plugin's call, the plugin's actor is a GOVERNED seat (the same
 * one rule the agent seat reads), so every human-only check refuses it. And because the bridge has
 * no approval card, a call the dial would hold for a person (a migration approval is one) is refused
 * `needs_a_person` before dispatch. The scope ends with the call: the installer acting in person
 * is a person again.
 *
 * Synthetic data only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { runPluginToolCall } from '../../dist/core/plugins/index.js';
import { withinPluginCall } from '../../dist/core/plugins/callScope.js';
import { isGovernedSeat } from '../../dist/core/access/capability.js';
import { actorIsHuman } from '../../dist/core/migration/project.js';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';

/** The shared dispatch an external agent's calls run through, as `asActor` (the production shape). */
const invokerFor = (deps) => (tool, input, asActor) => getAction(tool).run({ ...deps, actor: asActor }, input);

/** Run `tool` through the plugin bridge, granted, as the human installer `studio`. */
function viaPlugin(fx, tool, input) {
  return runPluginToolCall(invokerFor(fx.deps), {
    grantedScopes: [`mcp_tool:${tool}`],
    pluginActor: 'studio',
    tool,
    input,
  });
}

test('a plugin cannot record a G20 sign-off (implementation_signoff_record is human-only)', () => {
  const fx = fixture();
  const input = SCENARIOS.implementation_signoff_record(fx);
  const res = viaPlugin(fx, 'implementation_signoff_record', input);
  assert.equal(res.ok, false, `the plugin signed off as the installer: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'signoff_needs_human');
  assert.equal(fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM implementation_signoff').get().n, 0);
  // The installer, in person, still can.
  assert.equal(getAction('implementation_signoff_record').run({ ...fx.deps, actor: 'studio' }, input).ok, true);
  fx.deps.store.close();
});

test('a plugin cannot confirm a statement gap (human_only)', () => {
  const fx = fixture();
  const input = SCENARIOS.confirm_statement_gap(fx);
  const res = viaPlugin(fx, 'confirm_statement_gap', input);
  assert.equal(res.ok, false, `the plugin confirmed a gap as the installer: ${JSON.stringify(res)}`);
  // The dial holds it for a person (pay), so the bridge refuses it before dispatch; and the engine's
  // own human-only check refuses the plugin's actor too, whatever invoker a host wires.
  assert.equal(res.reason, 'needs_a_person');
  const inScope = withinPluginCall('studio', () => getAction('confirm_statement_gap').run({ ...fx.deps, actor: 'studio' }, input));
  assert.equal(inScope.error, 'human_only', JSON.stringify(inScope));
  assert.equal(getAction('confirm_statement_gap').run({ ...fx.deps, actor: 'studio' }, input).ok, true, 'the installer in person still confirms');
  fx.deps.store.close();
});

test('a plugin cannot set the agent dial or approve a drafted action (the governor stays with a person)', () => {
  const fx = fixture();
  const dial = SCENARIOS.set_agent_dial(fx);
  const res = viaPlugin(fx, 'set_agent_dial', dial);
  assert.equal(res.ok, false, `the plugin set the dial as the installer: ${JSON.stringify(res)}`);
  fx.deps.store.close();

  const fx2 = fixture();
  const approve = SCENARIOS.approve_drafted_action(fx2);
  const res2 = viaPlugin(fx2, 'approve_drafted_action', approve);
  assert.equal(res2.ok, false, `the plugin approved a drafted action as the installer: ${JSON.stringify(res2)}`);
  assert.equal(fx2.deps.store.db.prepare("SELECT status FROM agent_action WHERE id = ?").get(approve.actionId).status, 'pending');
  fx2.deps.store.close();
});

test('a plugin cannot record a G09 migration approval (a call the dial holds for a person)', () => {
  const fx = fixture();
  fx.deps.actor = 'studio';
  const input = SCENARIOS.migration_record_approval(fx);
  const approvals = () => fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM migration_approval WHERE workspace_id = ?').get(fx.workspaceId).n;
  const before = approvals();
  const res = viaPlugin(fx, 'migration_record_approval', input);
  assert.equal(res.ok, false, `the plugin approved a migration step as the installer: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'capability_forbidden');
  assert.equal(res.reason, 'needs_a_person');
  assert.equal(approvals(), before, 'an approval row was written');
  fx.deps.store.close();
});

test('the plugin scope covers the call and ends with it, even when the invoker throws', () => {
  const fx = fixture();
  const store = fx.deps.store;
  assert.equal(isGovernedSeat(store, 'studio'), false, 'premise: the installer is a person');
  let inside;
  const res = runPluginToolCall(
    () => {
      inside = { governed: isGovernedSeat(store, 'studio'), human: actorIsHuman(store, 'studio'), other: isGovernedSeat(store, 'member:someone') };
      return { ok: true };
    },
    { grantedScopes: ['mcp_tool:list_invoices'], pluginActor: 'studio', tool: 'list_invoices', input: {} },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(inside, { governed: true, human: false, other: false });
  assert.equal(isGovernedSeat(store, 'studio'), false, 'the scope leaked past the call');
  assert.throws(() =>
    runPluginToolCall(
      () => {
        throw new Error('boom');
      },
      { grantedScopes: ['mcp_tool:list_invoices'], pluginActor: 'studio', tool: 'list_invoices', input: {} },
    ),
  );
  assert.equal(actorIsHuman(store, 'studio'), true, 'the scope leaked past a throwing call');
  store.close();
});
