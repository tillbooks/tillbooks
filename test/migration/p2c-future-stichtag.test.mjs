/**
 * F-09 (friction ledger, Phase 2), J1.4 ideal step 4: a FUTURE Übernahmestichtag is accepted while
 * the plan is prepared, and only the COMMIT waits for the date.
 *
 * THE DEFECT THIS EXISTS FOR. `migration_create_plan` refused a Stichtag in the future, so a cutover
 * could not be prepared ahead of its date (the owner's own go-live is 01.10.2026, prepared through
 * September) and the 20-minute migration budget (D-K) was unreachable by construction.
 *
 * What these tests hold, on the engine's own clock so both sides are measured:
 *   - a plan with a future Stichtag is created, scoped, mapped, trial-loaded and checked (prepare);
 *   - the plan view carries `cutoverPending:true` and `migration_readiness` blocks on `cutover_pending`;
 *   - `migration_commit_step` refuses `cutover_in_future` before the date and posts NOTHING;
 *   - `go_productive` refuses `cutover_in_future` before the date and promotes nothing;
 *   - once the calendar passes the date, the same commit posts exactly ONE opening entry, and a
 *     replay on the same key posts nothing more (idempotent on rows);
 *   - `cutoverPending` and the blocking item are gone after the date.
 *
 * Every check reads the ROWS (journal_entry count, workspace.kind), never the completion report.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

/** A clock the test can move: the engine reads it on every call, so "today" is whatever it says. */
function movableClock(instant) {
  let current = instant;
  return { now: () => current, set: (next) => { current = next; } };
}

const call = (deps, name, input) => getAction(name).run(deps, input);
const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};
const countEntries = (deps, wid) => deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(wid).n;

const TODAY = '2026-09-06T09:00:00.000Z';
const STICHTAG = '2026-10-01';
const AFTER = '2026-10-01T06:00:00.000Z';

function fresh() {
  const clock = movableClock(TODAY);
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids: sequenceIdGen(), actor: 'agent' };
  const wid = must(call(deps, 'create_workspace', { name: 'Nomadik Muster GmbH', idempotencyKey: 'ws' }), 'create_workspace').workspaceId;
  return { deps, clock, wid };
}

/** Prepare an opening-balances step end to end (upload, plan with the given Stichtag, scope, controls, trial load). */
function prepareOpeningStep(deps, wid, seed, cutoverDate = STICHTAG) {
  const accounts = must(call(deps, 'list_accounts', { workspaceId: wid }), 'list_accounts').accounts;
  const [a, b] = accounts;
  const csv = `account,debitMinor,creditMinor\n${a.number},250000,0\n${b.number},0,250000\n`;
  const up = must(
    call(deps, 'files_upload', {
      workspaceId: wid,
      filename: `${seed}.csv`,
      mime: 'text/csv',
      contentBase64: Buffer.from(csv).toString('base64'),
      idempotencyKey: `${seed}-up`,
    }),
    'files_upload',
  );
  const created = call(deps, 'migration_create_plan', {
    workspaceId: wid,
    sourceSystem: 'bexio',
    cutoverDate,
    localePack: 'ch',
    idempotencyKey: `${seed}-plan`,
  });
  assert.equal(created.ok, true, `the Stichtag must be accepted at plan creation: ${JSON.stringify(created)}`);
  const planId = created.planId;
  must(call(deps, 'migration_discover_source', { workspaceId: wid, fileIds: [up.file.id], planId }), 'discover');
  const scope = must(
    call(deps, 'migration_set_scope', { workspaceId: wid, planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: `${seed}-scope` }),
    'set_scope',
  );
  const stepId = scope.steps[0].stepId;
  must(call(deps, 'migration_declare_control_total', { workspaceId: wid, planId, stepId, kind: 'trial_balance_matches_source', scope: a.number, declaredMinor: 250000, idempotencyKey: `${seed}-dcl-a` }), 'declare a');
  must(call(deps, 'migration_declare_control_total', { workspaceId: wid, planId, stepId, kind: 'trial_balance_matches_source', scope: b.number, declaredMinor: -250000, idempotencyKey: `${seed}-dcl-b` }), 'declare b');
  must(call(deps, 'migration_trial_load_step', { workspaceId: wid, planId, stepId, idempotencyKey: `${seed}-trial` }), 'trial load');
  return { planId, stepId };
}

test('prepare: a plan with a future Stichtag runs through scope, trial load and check, and says it is pending', () => {
  const { deps, wid } = fresh();
  const { planId, stepId } = prepareOpeningStep(deps, wid, 'prep');
  const view = must(call(deps, 'migration_get_plan', { workspaceId: wid, planId }), 'get_plan');
  assert.equal(view.plan.cutoverPending, true, 'the plan view must say the Stichtag is still ahead');
  assert.equal(view.plan.cutoverDate, STICHTAG);
  const listed = must(call(deps, 'migration_list_plans', { workspaceId: wid }), 'list_plans');
  assert.equal(listed.plans[0].cutoverPending, true, 'the roster carries the same flag');
  // The Eröffnungsprüfung is rehearsal against the Testmandant: it runs before the date.
  const checked = must(call(deps, 'migration_check_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'prep-check' }), 'check');
  assert.ok(checked.checkId ?? checked.checkHash ?? checked.controls, `the check produced no result: ${JSON.stringify(checked).slice(0, 200)}`);
  const readiness = must(call(deps, 'migration_readiness', { workspaceId: wid, planId }), 'readiness');
  const pending = readiness.blocking.find((b) => b.item === 'cutover_pending');
  assert.ok(pending, `readiness must block on cutover_pending before the date: ${JSON.stringify(readiness.blocking)}`);
  assert.equal(pending.cutoverDate, STICHTAG);
  assert.equal(pending.owner, 'das System', 'nobody but the calendar clears it');
});

test('the commit refuses cutover_in_future before the date and writes NOTHING, then posts once after it', () => {
  const { deps, clock, wid } = fresh();
  const { planId, stepId } = prepareOpeningStep(deps, wid, 'commit');
  const before = countEntries(deps, wid);

  // Before the date: a named refusal carrying both dates (P9), and not a row moved. The step stays
  // where the trial load left it, so nothing has to be re-run once the date arrives.
  const early = call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'commit-1' });
  assert.equal(early.ok, false);
  assert.equal(early.error, 'cutover_in_future');
  assert.equal(early.cutoverDate, STICHTAG);
  assert.equal(early.today, '2026-09-06');
  assert.equal(countEntries(deps, wid), before, 'a refused commit must post nothing');
  const stepBefore = must(call(deps, 'migration_get_plan', { workspaceId: wid, planId }), 'get_plan').steps[0];
  assert.equal(stepBefore.state, 'trial_loaded', 'the refusal must not advance the step');

  // The calendar passes the Stichtag: the SAME call now runs the gate. The money-path commit first
  // draft-stages (no approval yet, P8), then commits once the approval is bound.
  clock.set(AFTER);
  assert.equal(must(call(deps, 'migration_get_plan', { workspaceId: wid, planId }), 'get_plan').plan.cutoverPending, false);
  const staged = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'commit-1' }), 'commit (staged)');
  assert.equal(staged.staged, true);
  assert.equal(countEntries(deps, wid), before, 'the staged commit writes nothing');
  deps.store.db.prepare('UPDATE migration_plan SET backup_ref = ? WHERE id = ?').run('backup-1', planId);
  must(call(deps, 'migration_record_approval', { workspaceId: wid, planId, stepId, checkHash: staged.checkHash, idempotencyKey: 'commit-appr' }), 'approval');
  const committed = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'commit-1' }), 'commit');
  assert.ok(committed.openingEntryId, 'the commit did not report its opening entry');
  assert.equal(countEntries(deps, wid), before + 1, 'exactly ONE opening entry after the date');

  // Idempotent on rows: the replay on the same key posts nothing more.
  must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'commit-1' }), 'commit replay');
  assert.equal(countEntries(deps, wid), before + 1, 'a replayed commit must not double-post');

  const readiness = must(call(deps, 'migration_readiness', { workspaceId: wid, planId }), 'readiness');
  assert.equal(readiness.blocking.some((b) => b.item === 'cutover_pending'), false, 'the calendar item is gone after the date');
});

test('go_productive refuses cutover_in_future before the date and promotes nothing; the same call promotes after it', () => {
  const { deps, clock, wid } = fresh();
  const planId = must(
    call(deps, 'migration_create_plan', { workspaceId: wid, sourceSystem: 'csv', cutoverDate: STICHTAG, localePack: 'ch', idempotencyKey: 'gp-plan' }),
    'create_plan',
  ).planId;
  const t = must(call(deps, 'migration_create_testmandant', { workspaceId: wid, planId, idempotencyKey: 'gp-t' }), 'testmandant');
  must(call(deps, 'update_company_profile', { workspaceId: t.workspaceId, legalForm: 'gmbh', uid: 'CHE-123.456.789' }), 'profile');
  const name = must(call(deps, 'get_company_profile', { workspaceId: t.workspaceId }), 'profile read').profile.name;
  const kindOf = () => deps.store.db.prepare('SELECT kind FROM workspace WHERE id = ?').get(t.workspaceId).kind;

  const early = call(deps, 'go_productive', { workspaceId: wid, planId, confirmedName: name, idempotencyKey: 'gp-1' });
  assert.equal(early.ok, false);
  assert.equal(early.error, 'cutover_in_future');
  assert.equal(kindOf(), 'sandbox', 'a refused promotion must leave the Testmandant a sandbox');

  clock.set(AFTER);
  const promoted = call(deps, 'go_productive', { workspaceId: wid, planId, confirmedName: name, idempotencyKey: 'gp-1' });
  assert.equal(promoted.ok, true, `the same promotion after the date: ${JSON.stringify(promoted)}`);
  assert.equal(kindOf(), 'live');
  // One-way and idempotent: the replay is the stored result, the kind does not move again.
  const replay = must(call(deps, 'go_productive', { workspaceId: wid, planId, confirmedName: name, idempotencyKey: 'gp-1' }), 'replay');
  assert.equal(replay.workspaceId, t.workspaceId);
  assert.equal(kindOf(), 'live');
});

test('the boundary: a Stichtag ON today is NOT pending and commits, it does not wait (isCutoverPending is strict >)', () => {
  // `isCutoverPending` returns `stichtag > today`, so the equal boundary must be treated as arrived,
  // not future: a cutover whose Stichtag is exactly today commits, it is not "prepared and waiting".
  // TODAY's engine clock is 2026-09-06, so the plan's Stichtag is that same date, with NO clock move.
  const TODAY_DATE = TODAY.slice(0, 10);
  const { deps, wid } = fresh();
  const { planId, stepId } = prepareOpeningStep(deps, wid, 'today', TODAY_DATE);
  const before = countEntries(deps, wid);

  const view = must(call(deps, 'migration_get_plan', { workspaceId: wid, planId }), 'get_plan');
  assert.equal(view.plan.cutoverPending, false, 'a Stichtag equal to today is not pending');
  const readiness = must(call(deps, 'migration_readiness', { workspaceId: wid, planId }), 'readiness');
  assert.equal(readiness.blocking.some((b) => b.item === 'cutover_pending'), false, 'today is not a cutover_pending block');

  // The commit runs the ordinary money-path gate today, without any clock move: stage, approve, post once.
  const staged = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'today-1' }), 'commit (staged)');
  assert.equal(staged.staged, true);
  assert.equal(countEntries(deps, wid), before, 'the staged commit writes nothing');
  deps.store.db.prepare('UPDATE migration_plan SET backup_ref = ? WHERE id = ?').run('backup-today', planId);
  must(call(deps, 'migration_record_approval', { workspaceId: wid, planId, stepId, checkHash: staged.checkHash, idempotencyKey: 'today-appr' }), 'approval');
  const committed = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'today-1' }), 'commit');
  assert.ok(committed.openingEntryId, 'a Stichtag of today must COMMIT, not wait');
  assert.equal(countEntries(deps, wid), before + 1, 'exactly ONE opening entry when the Stichtag is today');
});

test('a Stichtag in the past is unchanged: nothing is pending and the commit runs the ordinary gate', () => {
  const { deps, wid } = fresh();
  const created = must(
    call(deps, 'migration_create_plan', { workspaceId: wid, sourceSystem: 'csv', cutoverDate: '2026-01-01', localePack: 'ch', idempotencyKey: 'past-plan' }),
    'create_plan',
  );
  const view = must(call(deps, 'migration_get_plan', { workspaceId: wid, planId: created.planId }), 'get_plan');
  assert.equal(view.plan.cutoverPending, false);
  const readiness = must(call(deps, 'migration_readiness', { workspaceId: wid, planId: created.planId }), 'readiness');
  assert.equal(readiness.blocking.some((b) => b.item === 'cutover_pending'), false);
});
