/**
 * M00's scheduler: the tick that supplies G01 with a clock while `till up` runs.
 *
 * The two claims that matter. FIRST, the tick drives `run_due_automations` once per LIVE workspace
 * and never touches an archived one (its books are read-only). SECOND, it owns no cadence logic: a
 * schedule rule fired across two ticks at the same instant posts ONCE, because idempotency is G01's
 * and the tick only re-drives the same verb. Counted on `journal_entry`, never on the return value,
 * for the reason `test/automation/idempotency-on-rows.test.mjs` sets out: a replayed receipt says
 * nothing about what the body did.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { createScheduler, clampTickMs, resolveTickMs, DEFAULT_TICK_MS, MIN_TICK_MS, MAX_TICK_MS } from '../../dist/api/scheduler.js';
import { resetDeliveryRuntime, getDeliveryRuntime } from '../../dist/api/runtime-state.js';
import { freshDeps, mintWorkspace } from './support.mjs';
import { defineRule, postTemplate, retireSeededChecklistRules } from '../automation/support.mjs';

const ENTRIES = 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?';
const RUNS = 'SELECT COUNT(*) AS n FROM automation_run WHERE workspace_id = ?';
const count = (deps, sql, id) => deps.store.db.prepare(sql).get(id).n;

test('clampTickMs holds the interval inside 30s..15min and defaults a bad value', () => {
  assert.equal(clampTickMs(60_000), 60_000);
  assert.equal(clampTickMs(1_000), MIN_TICK_MS);
  assert.equal(clampTickMs(60 * 60_000), MAX_TICK_MS);
  assert.equal(clampTickMs(undefined), DEFAULT_TICK_MS);
  assert.equal(clampTickMs(Number.NaN), DEFAULT_TICK_MS);
});

test('resolveTickMs reads TILL_TICK_MS, clamped, and falls back on blank/garbage', () => {
  assert.equal(resolveTickMs({ TILL_TICK_MS: '120000' }), 120_000);
  assert.equal(resolveTickMs({ TILL_TICK_MS: '5' }), MIN_TICK_MS);
  assert.equal(resolveTickMs({ TILL_TICK_MS: '  ' }), DEFAULT_TICK_MS);
  assert.equal(resolveTickMs({ TILL_TICK_MS: 'soon' }), DEFAULT_TICK_MS);
  assert.equal(resolveTickMs({}), DEFAULT_TICK_MS);
});

test('a tick drives run_due_automations for every LIVE workspace and skips the archived one', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Alpha GmbH', 'sch-a').workspaceId;
  const b = mintWorkspace(deps, 'Beta GmbH', 'sch-b').workspaceId;
  const c = mintWorkspace(deps, 'Gamma GmbH', 'sch-c').workspaceId;
  // Archive Gamma: an archived workspace is read-only and must never be ticked.
  assert.equal(getAction('archive_workspace').run(deps, { workspaceId: c }).ok, true);

  const seen = [];
  const scheduler = createScheduler(deps, { runDue: (workspaceId) => seen.push(workspaceId) });
  const n = scheduler.tickOnce();

  assert.equal(n, 2, 'the tick drove exactly the two live workspaces');
  assert.deepEqual([...seen].sort(), [a, b].sort());
  assert.ok(!seen.includes(c), 'the archived workspace was ticked');
});

test('a tick as `system` fires a due schedule rule ONCE across repeated ticks at the same instant', () => {
  // The workspace is unprovisioned, so the `system` actor passes A24 (isProvisioned -> allow), which
  // is exactly the common single-user case the tick serves.
  const deps = freshDeps();
  // Author as `studio`: a rule the agent seat creates lands DISABLED and would never fire.
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Automat GmbH', 'sch-fire');
  // G22 (D129) seeds two enabled `schedule.daily` `checklist_start` rules per workspace; retire them so
  // the run count names only the rule under test (their own idempotency is proven in g22-autostart).
  retireSeededChecklistRules(deps, workspaceId);
  // A daily schedule rule created by the studio actor lands ENABLED (only the agent seat lands disabled).
  defineRule(
    deps,
    workspaceId,
    { name: 'Täglich', event: 'schedule.daily', tool: 'post_entry', template: postTemplate(accId) },
    'sch-fire-rule',
  );

  const scheduler = createScheduler(deps, { now: () => new Date('2026-07-16T00:00:00.000Z') });
  // The deps clock is fixed, so both ticks compute the SAME occurrence: the second is a no-op.
  scheduler.tickOnce();
  scheduler.tickOnce();
  scheduler.tickOnce();

  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'the schedule fired more than once for one occurrence');
  assert.equal(count(deps, RUNS, workspaceId), 1, 'a second run row was written for the same occurrence');
});

test('start()/stop() flip the scheduler line in delivery runtime and the timer never blocks exit', () => {
  resetDeliveryRuntime();
  const deps = freshDeps();
  const scheduler = createScheduler(deps, { intervalMs: 60_000, listWorkspaceIds: () => [], now: () => new Date('2026-07-16T00:00:00.000Z') });

  scheduler.start();
  const armed = getDeliveryRuntime().scheduler;
  assert.equal(armed.enabled, true);
  assert.equal(armed.nextTickAt, '2026-07-16T00:01:00.000Z');

  scheduler.tickOnce();
  assert.equal(getDeliveryRuntime().scheduler.lastTickAt, '2026-07-16T00:00:00.000Z');

  scheduler.stop();
  assert.equal(getDeliveryRuntime().scheduler.enabled, false);
  resetDeliveryRuntime();
});
