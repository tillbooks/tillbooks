/**
 * G18 R3 (readiness honesty) + R4 (migration_close_plan).
 *
 * R3: readiness() no longer returns stubs. The per-item `owner` is derived from the step (du / ein
 * Agent / das System), every WAIVED G11 control is surfaced (so "bereit, mit N Ausnahmen" renders),
 * and `vat_period_straddled` warns (never blocks) when the Stichtag falls inside a VAT period.
 *
 * R4: migration_close_plan moves a plan live -> closed. Legal only from live; refuses naming the
 * first blocker while any step is non-terminal or any control is failed; denylisted from automation;
 * idempotent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { NOT_AUTOMATABLE } from '../../dist/core/automation/denylist.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};
const refuse = (res, error, what) => {
  assert.equal(res.ok, false, `${what} should have refused: ${JSON.stringify(res)}`);
  assert.equal(res.error, error, `${what} wrong error: ${JSON.stringify(res)}`);
  return res;
};

function world(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Quelle GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, wid: workspaceId, call };
}

function plan(call, seed, cutover = '2024-07-01') {
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: cutover, localePack: 'ch', idempotencyKey: `${seed}-plan` }), 'plan').planId;
  return planId;
}

const setStepState = (deps, planId, dataClass, state) =>
  deps.store.db.prepare('UPDATE migration_step SET status = ? WHERE plan_id = ? AND data_class = ?').run(state, planId, dataClass);
const setPlanState = (deps, planId, state) =>
  deps.store.db.prepare('UPDATE migration_plan SET status = ? WHERE id = ?').run(state, planId);

// --- R3: owner derivation -----------------------------------------------------------------------

test('R3: readiness derives a real per-item owner from the step, not a stub', () => {
  const { deps, call } = world('r3o');
  const planId = plan(call, 'r3o');
  // Two non-money classes and one money class in scope.
  must(call('migration_set_scope', { planId, classes: [
    { dataClass: 'contacts', include: true },
    { dataClass: 'items', include: true },
    { dataClass: 'opening_balances', include: true },
  ], idempotencyKey: 'r3o-scope' }), 'scope');

  // A mapped step is agent-advanceable; a committed step is the system's to verify; a money-path
  // step at `checked` waits on the human approval; a diverged step is a human reconciliation.
  setStepState(deps, planId, 'contacts', 'mapped');
  setStepState(deps, planId, 'items', 'committed');
  setStepState(deps, planId, 'opening_balances', 'checked');

  const r = must(call('migration_readiness', { planId }), 'readiness');
  const ownerOf = (dataClass) => r.blocking.find((b) => b.item === dataClass && b.step !== undefined)?.owner;
  assert.equal(ownerOf('contacts'), 'ein Agent', 'a mapped step is agent-advanceable');
  assert.equal(ownerOf('items'), 'das System', 'a committed step is the system to verify');
  assert.equal(ownerOf('opening_balances'), 'du', 'a money-path checked step waits on the human');

  // A diverged step is a human reconciliation.
  setStepState(deps, planId, 'contacts', 'diverged');
  const r2 = must(call('migration_readiness', { planId }), 'readiness diverged');
  assert.ok(r2.blocking.some((b) => b.item === 'contacts' && b.owner === 'du'), 'a diverged step is owned by du');
});

// --- R3: waivers surfaced -----------------------------------------------------------------------

test('R3: a waived control is surfaced and readyWithWaivers renders', () => {
  const { deps, call } = world('r3w');
  const planId = plan(call, 'r3w');
  const scope = must(call('migration_set_scope', { planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: 'r3w-scope' }), 'scope');
  const stepId = scope.steps[0].stepId;
  // Declare a total the empty import cannot match -> a FAILED control, then check to compute it.
  must(call('migration_declare_control_total', { planId, stepId, kind: 'trial_balance_matches_source', scope: '1100', declaredMinor: 500000, idempotencyKey: 'r3w-dec' }), 'declare');
  must(call('migration_check_step', { planId, stepId, idempotencyKey: 'r3w-chk' }), 'check');
  const control = deps.store.db.prepare("SELECT id FROM migration_control_total WHERE plan_id = ? AND status = 'failed' LIMIT 1").get(planId);
  assert.ok(control !== undefined, 'the declared control failed against the empty import');
  must(call('migration_waive_control', { controlId: control.id, reason: 'Altsystem-Rundung, vom Treuhänder geprüft', idempotencyKey: 'r3w-waive' }), 'waive');

  // Drive every step to a terminal state and put a backup on record, so ONLY the waiver stands
  // between the plan and plain-ready (opening_balances is money-path, so the backup leg applies).
  setStepState(deps, planId, 'opening_balances', 'verified');
  deps.store.db.prepare('UPDATE migration_plan SET backup_ref = ? WHERE id = ?').run('{"backupId":"bk_x","sha256":"deadbeef"}', planId);
  const r = must(call('migration_readiness', { planId }), 'readiness');
  assert.equal(r.waivers.length, 1, 'the waived control is surfaced');
  assert.equal(r.waivers[0].reason, 'Altsystem-Rundung, vom Treuhänder geprüft');
  assert.equal(r.ready, true, 'no blocker remains');
  assert.equal(r.readyWithWaivers, true, 'ready, but with an exception: never plain ready');
});

// --- R3: vat_period_straddled -------------------------------------------------------------------

function configureVat(call, wid, seed) {
  must(call('update_company_profile', { workspaceId: wid, uid: 'CHE-116.281.271' }), 'profile');
  must(call('vat_configure', { workspaceId: wid, method: 'effektiv', timing: 'soll', registered: true, asOf: '2023-01-01', vatNumber: 'CHE-116.281.271 MWST', idempotencyKey: `${seed}-cfg` }), 'vat');
}

test('R3: a Stichtag mid VAT period warns (never blocks) with both date ranges', () => {
  const { call, wid } = world('r3s');
  configureVat(call, wid, 'r3s');
  // 2024-08-15 falls inside 2024-Q3 (Jul-Sep) under the effektive quarterly method.
  const planId = plan(call, 'r3s', '2024-08-15');
  const r = must(call('migration_readiness', { planId }), 'readiness');
  const w = r.warnings.find((x) => x.item === 'vat_period_straddled');
  assert.ok(w !== undefined, 'the straddle is warned');
  assert.equal(w.period, '2024-Q3');
  assert.equal(w.oldSystemRange.from, '2024-07-01');
  assert.equal(w.oldSystemRange.to, '2024-08-14', 'the old system owns up to the day before the Stichtag');
  assert.equal(w.tillRange.from, '2024-08-15');
  assert.equal(w.tillRange.to, '2024-09-30');
});

test('R3: a Stichtag on a VAT period boundary does not straddle', () => {
  const { call, wid } = world('r3b');
  configureVat(call, wid, 'r3b');
  // 2024-07-01 is exactly the start of 2024-Q3: no straddle.
  const planId = plan(call, 'r3b', '2024-07-01');
  const r = must(call('migration_readiness', { planId }), 'readiness');
  assert.ok(!r.warnings.some((x) => x.item === 'vat_period_straddled'), 'a boundary Stichtag does not straddle');
});

// --- R4: migration_close_plan -------------------------------------------------------------------

test('R4: close is denylisted from automation', () => {
  assert.ok(NOT_AUTOMATABLE.has('migration_close_plan'), 'closing a plan is not an automation action');
});

test('R4: close is legal only from live', () => {
  const { deps, call } = world('r4a');
  const planId = plan(call, 'r4a');
  must(call('migration_set_scope', { planId, classes: [{ dataClass: 'contacts', include: true }], idempotencyKey: 'r4a-scope' }), 'scope');
  // planned, not live.
  refuse(call('migration_close_plan', { planId, confirmed: true, idempotencyKey: 'r4a-c1' }), 'plan_not_live', 'close a planned plan');
  setPlanState(deps, planId, 'live');
  setStepState(deps, planId, 'contacts', 'skipped');
  // Without a confirmation it refuses even from live.
  refuse(call('migration_close_plan', { planId, idempotencyKey: 'r4a-c2' }), 'needs_confirmation', 'close without confirm');
});

test('R4: close refuses while a step is non-terminal, naming it', () => {
  const { deps, call } = world('r4b');
  const planId = plan(call, 'r4b');
  must(call('migration_set_scope', { planId, classes: [{ dataClass: 'contacts', include: true }], idempotencyKey: 'r4b-scope' }), 'scope');
  setPlanState(deps, planId, 'live');
  setStepState(deps, planId, 'contacts', 'committed'); // committed is NOT terminal (verify/skip are)
  const res = refuse(call('migration_close_plan', { planId, confirmed: true, idempotencyKey: 'r4b-c' }), 'step_not_terminal', 'close with an open step');
  assert.equal(res.dataClass, 'contacts', 'the refusal names the blocking step');
  assert.equal(res.state, 'committed');
});

test('R4: close refuses on a failed control, naming it', () => {
  const { deps, call } = world('r4c');
  const planId = plan(call, 'r4c');
  const scope = must(call('migration_set_scope', { planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: 'r4c-scope' }), 'scope');
  const stepId = scope.steps[0].stepId;
  must(call('migration_declare_control_total', { planId, stepId, kind: 'trial_balance_matches_source', scope: '1100', declaredMinor: 500000, idempotencyKey: 'r4c-dec' }), 'declare');
  must(call('migration_check_step', { planId, stepId, idempotencyKey: 'r4c-chk' }), 'check');
  setPlanState(deps, planId, 'live');
  setStepState(deps, planId, 'opening_balances', 'verified'); // step terminal, but the control failed
  refuse(call('migration_close_plan', { planId, confirmed: true, idempotencyKey: 'r4c-c' }), 'control_failed', 'close with a failed control');
});

test('R4: close from live with all steps terminal succeeds and is idempotent', () => {
  const { deps, call } = world('r4d');
  const planId = plan(call, 'r4d');
  must(call('migration_set_scope', { planId, classes: [{ dataClass: 'contacts', include: true }], idempotencyKey: 'r4d-scope' }), 'scope');
  setPlanState(deps, planId, 'live');
  setStepState(deps, planId, 'contacts', 'verified');
  const closed = must(call('migration_close_plan', { planId, confirmed: true, idempotencyKey: 'r4d-c' }), 'close');
  assert.equal(closed.state, 'closed');
  assert.equal(deps.store.db.prepare('SELECT status FROM migration_plan WHERE id = ?').get(planId).status, 'closed');
  assert.ok(deps.store.db.prepare('SELECT closed_at FROM migration_plan WHERE id = ?').get(planId).closed_at !== null);
  // Idempotent replay on the same key returns the stored result.
  const again = must(call('migration_close_plan', { planId, confirmed: true, idempotencyKey: 'r4d-c' }), 'replay');
  assert.equal(again.state, 'closed');
  // A fresh key on an already-closed plan is a no-op, never an error.
  const noop = must(call('migration_close_plan', { planId, confirmed: true, idempotencyKey: 'r4d-c2' }), 'noop');
  assert.equal(noop.alreadyClosed, true);
});
