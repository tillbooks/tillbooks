/**
 * K-30 (owner decision "write 'trial'"): the plan `trial` state must be REACHABLE.
 *
 * Before this fix `PLAN_STATES` declared `trial` and the machine documented `planned -> trial -> live`,
 * but no writer ever set it: the first trial-load advanced the STEP to `trial_loaded` and left the PLAN
 * at `planned`, so `trial` was a dead state (K-23 was a Studio-side workaround for exactly that gap).
 * These assertions bite on current `develop` (the status stays `planned`, and `planPhase`/`PLAN_PHASE`
 * do not exist) and pass once the first trial-load writes `trial`, idempotently, and every plan state
 * has an exhaustive display mapping (`abandoned` -> null, no fall-through).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { PLAN_STATES, PLAN_PHASE } from '../../dist/core/migration/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);
const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};
const planStatus = (deps, planId) => deps.store.db.prepare('SELECT status FROM migration_plan WHERE id = ?').get(planId).status;

function ws(seed) {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Übernahme GmbH', `${seed}-ws`);
  return { deps, wid: workspaceId };
}

/** Create a plan, upload a balanced opening CSV, discover, scope opening_balances. Stops at `planned`. */
function seedScopedPlan(deps, wid, seed) {
  const accounts = must(call(deps, 'list_accounts', { workspaceId: wid }), 'list_accounts').accounts;
  const [a, b] = accounts;
  const csv = `account,debitMinor,creditMinor\n${a.number},100000,0\n${b.number},0,100000\n`;
  const fileId = must(
    call(deps, 'files_upload', {
      workspaceId: wid,
      title: `Eröffnung ${seed}`,
      filename: `${seed}.csv`,
      mime: 'text/csv',
      contentBase64: Buffer.from(csv).toString('base64'),
      idempotencyKey: `${seed}-up`,
    }),
    'files_upload',
  ).file.id;
  const planId = must(
    call(deps, 'migration_create_plan', { workspaceId: wid, sourceSystem: 'csv', cutoverDate: '2026-01-01', localePack: 'ch', idempotencyKey: `${seed}-plan` }),
    'create_plan',
  ).planId;
  must(call(deps, 'migration_discover_source', { workspaceId: wid, fileIds: [fileId], planId }), 'discover');
  const stepId = must(
    call(deps, 'migration_set_scope', { workspaceId: wid, planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: `${seed}-scope` }),
    'set_scope',
  ).steps[0].stepId;
  return { planId, stepId };
}

test('K-30: the first trial-load writes the plan `trial` state (it was dead before)', () => {
  const { deps, wid } = ws('write-trial');
  const { planId, stepId } = seedScopedPlan(deps, wid, 'wt');

  // A scoped plan sits at `planned`, and NOTHING has written `trial` yet.
  assert.equal(planStatus(deps, planId), 'planned', 'a freshly scoped plan must be at `planned`');

  must(call(deps, 'migration_trial_load_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'wt-trial' }), 'trial_load');

  // The persisted status is now `trial`: the state PLAN_STATES declares is reachable.
  assert.equal(planStatus(deps, planId), 'trial', 'the first trial-load must persist the plan `trial` state');
});

test('K-30: re-running the trial-load is idempotent, the `trial` status does not thrash', () => {
  const { deps, wid } = ws('idem-trial');
  const { planId, stepId } = seedScopedPlan(deps, wid, 'it');

  // Same key: an idempotent replay.
  must(call(deps, 'migration_trial_load_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'it-trial' }), 'trial_load');
  assert.equal(planStatus(deps, planId), 'trial', 'after the first trial-load the plan is `trial`');
  must(call(deps, 'migration_trial_load_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'it-trial' }), 'trial_load-replay');
  assert.equal(planStatus(deps, planId), 'trial', 'an idempotent replay must not change the plan status');

  // A fresh key re-runs the trial-load from `trial_loaded` (a legal transition); the status stays `trial`.
  must(call(deps, 'migration_trial_load_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'it-trial-2' }), 'trial_load-rerun');
  assert.equal(planStatus(deps, planId), 'trial', 're-running the trial-load must keep the plan at `trial`, never thrash it');
});

test('K-30: getPlan reports `trial` and its `planPhase`, with no state falling through', () => {
  const { deps, wid } = ws('getplan-trial');
  const { planId, stepId } = seedScopedPlan(deps, wid, 'gp');
  must(call(deps, 'migration_trial_load_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'gp-trial' }), 'trial_load');

  const view = must(call(deps, 'migration_get_plan', { workspaceId: wid, planId }), 'get_plan');
  assert.equal(view.plan.state, 'trial', 'getPlan must surface the persisted `trial` state');
  assert.equal(view.plan.planPhase, 'trial', 'getPlan must place a `trial` plan at the `trial` journey phase');
  assert.ok(view.journey.includes(view.plan.planPhase), 'planPhase must name a real journey phase');
});

test('K-30: PLAN_PHASE is exhaustive over PLAN_STATES; `trial` maps and `abandoned` maps to null', () => {
  // Exhaustive: every declared plan state has its own display mapping, so none falls through a default.
  for (const state of PLAN_STATES) {
    assert.ok(Object.prototype.hasOwnProperty.call(PLAN_PHASE, state), `PLAN_PHASE is missing a mapping for \`${state}\``);
  }
  assert.equal(PLAN_PHASE.trial, 'trial', '`trial` must map to the Probelauf journey phase');
  assert.equal(PLAN_PHASE.abandoned, null, '`abandoned` is off the journey and must map to null, never a default phase');
});

test('K-30: an abandoned plan reports planPhase null (no fabricated journey position)', () => {
  const { deps, wid } = ws('abandon-phase');
  const { planId } = seedScopedPlan(deps, wid, 'ap');
  must(call(deps, 'migration_abandon_plan', { workspaceId: wid, planId, confirmed: true, idempotencyKey: 'ap-abandon' }), 'abandon');

  assert.equal(planStatus(deps, planId), 'abandoned', 'the plan must be `abandoned`');
  const view = must(call(deps, 'migration_get_plan', { workspaceId: wid, planId }), 'get_plan');
  assert.equal(view.plan.state, 'abandoned', 'getPlan must surface the `abandoned` state');
  assert.equal(view.plan.planPhase, null, 'an abandoned plan must have no journey phase, never fall through to a default');
});
