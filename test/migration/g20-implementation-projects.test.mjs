/**
 * G20, implementation projects: the project object, runbook instantiation, the parallel-run
 * reconciliation, the agent/human sign-off split and the roster. Offline, against fresh in-memory
 * stores. These are the spec §7/§8 invariant assertions.
 *
 * The load-bearing ones:
 *   - the passed CONJUNCTION: parallel.passed requires the deterministic check clean AND the bound
 *     human sign-off, and each leg mutated to false alone flips it;
 *   - human-only sign-offs refuse an agent, one test per kind;
 *   - a sign-off is voided when its bound evidence changes (a re-run check with a new hash);
 *   - append-only: no UPDATE/DELETE path for decisions/sign-offs/declarations (schema triggers bite);
 *   - zero-tolerance: a 1-Rappen difference fails, a figure without a declaration is not_asserted;
 *   - window alignment per method + the method-change sign-off gate;
 *   - the statutory deadline tasks land with dates; the prior-year Umsatzabstimmung resolves against a
 *     G13 archive query;
 *   - the roster is workspace-scoped (§H-TENANT probe over the six new tables);
 *   - project_close refuses on each open leg in isolation;
 *   - the property that differenceRappen == declared - computed and status follows the zero rule;
 *   - no posting path anywhere (static assertion), and B00 is not imported.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getAction } from '../../dist/api/registry.js';
import { SIGNOFF_KINDS, PHASES } from '../../dist/core/migration/index.js';
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

const FUTURE_CUTOVER = '2027-06-30';

/** A world with a workspace and a `call(name, input)` bound to it. `actor` defaults to studio (human). */
function world(seed, actor = 'studio') {
  const deps = freshDeps();
  deps.actor = actor;
  const { workspaceId } = mintWorkspace(deps, 'Mandat GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, wid: workspaceId, call };
}

function createProject(call, seed, extra = {}) {
  return must(
    call('implementation_project_create', {
      sourceSystem: 'bexio',
      cutoverDate: FUTURE_CUTOVER,
      mwstMethod: 'effektiv',
      idempotencyKey: `${seed}-proj`,
      ...extra,
    }),
    'create project',
  ).projectId;
}

// --- Project object + create refusals ------------------------------------------------------------

test('project_create: happy path, one open per workspace, past cutover refuses', () => {
  const { call } = world('create');
  const projectId = createProject(call, 'create');
  assert.equal(typeof projectId, 'string');

  // A second open project refuses.
  refuse(
    call('implementation_project_create', { sourceSystem: 'gaeld', cutoverDate: FUTURE_CUTOVER, mwstMethod: 'saldo', idempotencyKey: 'second' }),
    'project_already_open',
    'second open project',
  );

  // A cutover in the past refuses.
  const w2 = world('past');
  refuse(
    w2.call('implementation_project_create', { sourceSystem: 'bexio', cutoverDate: '2020-01-01', mwstMethod: 'effektiv', idempotencyKey: 'past' }),
    'cutover_in_past',
    'past cutover',
  );
});

test('project phase starts at discovery with the create action as next', () => {
  const { call } = world('phase');
  const projectId = createProject(call, 'phase');
  const got = must(call('implementation_project_get', { projectId }), 'get').project;
  assert.equal(got.status, 'discovery');
});

// --- Runbook instantiation + the canon -----------------------------------------------------------

test('runbook instantiation lands the canon: undeletable go/no-go + rollback, deadline dates', () => {
  const { call } = world('runbook');
  const projectId = createProject(call, 'runbook');
  const res = must(call('implementation_runbook_instantiate', { projectId, templateId: 'w3_cutover', idempotencyKey: 'inst' }), 'instantiate');
  const tasks = res.tasks;
  assert.ok(tasks.length > 10, 'canon has many tasks');

  // go/no-go and rollback are undeletable.
  const goNogo = tasks.find((t) => t.itemId === 'cutover_go_nogo');
  const rollback = tasks.find((t) => t.itemId === 'cutover_rollback_authority');
  assert.equal(goNogo.undeletable, true, 'go/no-go undeletable');
  assert.equal(rollback.undeletable, true, 'rollback undeletable');

  // The 180-day Umsatzabstimmung and 240-day Berichtigung have computed statutory dates (calendar
  // fiscal year end 2027-12-31 for a 2027 cutover -> +180 and +240).
  const uab = tasks.find((t) => t.itemId === 'deadline_umsatzabstimmung');
  const ber = tasks.find((t) => t.itemId === 'deadline_berichtigung');
  const prior = tasks.find((t) => t.itemId === 'deadline_prior_year_umsatzabstimmung');
  assert.equal(uab.dueDate, '2028-06-28', 'Umsatzabstimmung = FYE + 180');
  assert.equal(ber.dueDate, '2028-08-27', 'Berichtigung = FYE + 240');
  // The prior-year Umsatzabstimmung is dated off the PRIOR fiscal year end (2026-12-31 + 180).
  assert.equal(prior.dueDate, '2027-06-29', 'prior-year Umsatzabstimmung = prior FYE + 180');

  // The prior-year Umsatzabstimmung resolves its evidence against a G13 archive query.
  const full = must(call('implementation_project_get', { projectId }), 'get').tasks;
  const priorFull = full.find((t) => t.templateItemId === 'deadline_prior_year_umsatzabstimmung');
  assert.equal(priorFull.evidenceKind, 'archive_query', 'prior-year evidence is a G13 archive query');
  const source = full.find((t) => t.templateItemId === 'source_cancellation');
  assert.equal(source.evidenceKind, 'source_cancellation', 'source cancellation is a sign-off gate');
});

test('unknown runbook template refuses', () => {
  const { call } = world('badtpl');
  const projectId = createProject(call, 'badtpl');
  refuse(call('implementation_runbook_instantiate', { projectId, templateId: 'nope', idempotencyKey: 'x' }), 'unknown_runbook_template', 'bad template');
});

// --- Task prerequisites and evidence -------------------------------------------------------------

test('task completion: prerequisite_open and evidence_required refuse, naming what is missing', () => {
  const { call } = world('tasks');
  const projectId = createProject(call, 'tasks');
  must(call('implementation_runbook_instantiate', { projectId, templateId: 'w3_cutover', idempotencyKey: 'inst' }), 'instantiate');
  const tasks = must(call('implementation_project_get', { projectId }), 'get').tasks;

  // The mapping task requires evidence (mapping_approval) AND has a prerequisite (extraction_full).
  const mapping = tasks.find((t) => t.templateItemId === 'mapping_accounts');
  const done = call('implementation_task_set', { projectId, taskId: mapping.taskId, fields: { status: 'done' }, idempotencyKey: 't1' });
  // Its prerequisite is open, so it refuses on that first.
  refuse(done, 'prerequisite_open', 'complete with open prerequisite');

  // A fresh task with an evidence kind but no ref refuses evidence_required.
  const created = must(call('implementation_task_set', { projectId, fields: { phase: 'discovery', title: 'Beleg', ownerKind: 'human', evidenceKind: 'fileId' }, idempotencyKey: 'tc' }), 'create task');
  refuse(
    call('implementation_task_set', { projectId, taskId: created.task.taskId, fields: { status: 'done' }, idempotencyKey: 'tc-done' }),
    'evidence_required',
    'complete without evidence',
  );
});

test('not_applicable needs a reason', () => {
  const { call } = world('na');
  const projectId = createProject(call, 'na');
  const created = must(call('implementation_task_set', { projectId, fields: { phase: 'discovery', title: 'X', ownerKind: 'human' }, idempotencyKey: 'c' }), 'create');
  refuse(
    call('implementation_task_set', { projectId, taskId: created.task.taskId, fields: { status: 'not_applicable' }, idempotencyKey: 'na1' }),
    'not_applicable_needs_reason',
    'not_applicable without reason',
  );
  must(
    call('implementation_task_set', { projectId, taskId: created.task.taskId, fields: { status: 'not_applicable', reason: 'Kein Bankkonto beim Vorsystem' }, idempotencyKey: 'na2' }),
    'not_applicable with reason',
  );
});

// --- The agent/human sign-off split --------------------------------------------------------------

test('every human-only sign-off kind refuses an agent actor', () => {
  const { call } = world('agentsig', 'agent');
  const projectId = createProject(call, 'agentsig');
  for (const kind of SIGNOFF_KINDS) {
    refuse(
      call('implementation_signoff_record', { projectId, kind, evidenceRef: 'e', idempotencyKey: `sig-${kind}` }),
      'signoff_needs_human',
      `agent sign-off ${kind}`,
    );
  }
});

test('a human sign-off records; the system seat is refused too', () => {
  const { call } = world('humansig', 'studio');
  const projectId = createProject(call, 'humansig');
  must(call('implementation_signoff_record', { projectId, kind: 'conversion_date', evidenceRef: 'beleg', idempotencyKey: 's1' }), 'human sign-off');

  const sys = world('syssig', 'system');
  const p2 = createProject(sys.call, 'syssig');
  refuse(sys.call('implementation_signoff_record', { projectId: p2, kind: 'go_nogo', evidenceRef: 'e', idempotencyKey: 's2' }), 'signoff_needs_human', 'system sign-off');
});

// --- The passed conjunction (US-G20.5) -----------------------------------------------------------

test('parallel.passed requires the check clean AND the bound sign-off; each leg flips it', () => {
  const { call } = world('conj', 'studio');
  const projectId = createProject(call, 'conj');
  // Declare a figure that matches the empty book (declared 0), then check: clean.
  must(call('implementation_parallel_declare', { projectId, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 0 }], idempotencyKey: 'd1' }), 'declare');
  must(call('implementation_parallel_check', { projectId, period: '2027-Q2', idempotencyKey: 'c1' }), 'check');

  // Leg 1 present (clean), leg 2 absent (no sign-off) -> NOT passed.
  let got = must(call('implementation_project_get', { projectId }), 'get');
  assert.equal(got.parallel.checksClean, true, 'checks clean');
  assert.equal(got.parallel.signoffBound, false, 'no sign-off yet');
  assert.equal(got.parallel.passed, false, 'clean check alone is not passed');

  // Add the bound sign-off -> BOTH legs -> passed.
  must(call('implementation_signoff_record', { projectId, kind: 'parallel_run_close', evidenceRef: 'freigabe', idempotencyKey: 'sig' }), 'sign');
  got = must(call('implementation_project_get', { projectId }), 'get');
  assert.equal(got.parallel.passed, true, 'clean + sign-off is passed');

  // Now break leg 1: declare a mismatch (declared 100 vs computed 0) and re-check -> not clean, and
  // the sign-off is VOIDED because the evidence changed.
  must(call('implementation_parallel_declare', { projectId, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 100 }], idempotencyKey: 'd2' }), 'redeclare');
  must(call('implementation_parallel_check', { projectId, period: '2027-Q2', idempotencyKey: 'c2' }), 'recheck');
  got = must(call('implementation_project_get', { projectId }), 'get');
  assert.equal(got.parallel.checksClean, false, 'a 100-Rappen mismatch is not clean');
  assert.equal(got.parallel.passed, false, 'a failing check is not passed');
  const voided = got.signoffs.find((s) => s.kind === 'parallel_run_close');
  assert.equal(voided.voided, true, 'the bound sign-off was voided on evidence change');
});

test('parallel.passed: a sign-off bound over a DIRTY check is still not passed (the check-clean leg bites alone)', () => {
  const { call } = world('conjdirty', 'studio');
  const projectId = createProject(call, 'conjdirty');
  // Declare a mismatch (declared 100 vs computed 0) and check: dirty.
  must(call('implementation_parallel_declare', { projectId, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 100 }], idempotencyKey: 'd1' }), 'declare');
  must(call('implementation_parallel_check', { projectId, period: '2027-Q2', idempotencyKey: 'c1' }), 'check');
  // Record the sign-off NOW, so it binds to the CURRENT (dirty) evidence hash: it is live and bound
  // while the check is not clean. This isolates the check-clean leg from the sign-off leg (the
  // earlier conjunction test could not, because dirtying the check ALSO voids the prior sign-off).
  must(call('implementation_signoff_record', { projectId, kind: 'parallel_run_close', evidenceRef: 'freigabe', idempotencyKey: 'sig' }), 'sign over dirty');
  const got = must(call('implementation_project_get', { projectId }), 'get');
  assert.equal(got.parallel.checksClean, false, 'the check is dirty');
  assert.equal(got.parallel.signoffBound, true, 'the sign-off is bound to the current (dirty) evidence');
  assert.equal(got.parallel.passed, false, 'a bound sign-off over a dirty check is NOT passed (check-clean leg)');
});

test('tieout.passed requires the check clean AND the bound tieout sign-off; each leg flips it', () => {
  const { call } = world('conjtieout', 'studio');
  const projectId = createProject(call, 'conjtieout');
  // Clean check (declared 0 == computed 0 over an empty book).
  must(call('implementation_parallel_declare', { projectId, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 0 }], idempotencyKey: 'd1' }), 'declare');
  must(call('implementation_parallel_check', { projectId, period: '2027-Q2', idempotencyKey: 'c1' }), 'check');

  // Leg 1 present (clean), leg 2 absent (no tieout sign-off) -> NOT passed (the sign-off leg bites).
  let got = must(call('implementation_project_get', { projectId }), 'get');
  assert.equal(got.tieout.checksClean, true, 'checks clean');
  assert.equal(got.tieout.signoffBound, false, 'no tieout sign-off yet');
  assert.equal(got.tieout.passed, false, 'a clean check alone is not a passed tie-out');

  // Add the bound tieout sign-off -> BOTH legs -> passed.
  must(call('implementation_signoff_record', { projectId, kind: 'tieout', evidenceRef: 'freigabe', idempotencyKey: 'sig' }), 'sign');
  got = must(call('implementation_project_get', { projectId }), 'get');
  assert.equal(got.tieout.passed, true, 'clean + tieout sign-off is a passed tie-out');

  // Break leg 1 ALONE: re-declare a mismatch and re-check (dirty, voiding the prior sign-off), THEN
  // record a fresh tieout sign-off bound to the dirty evidence. Sign-off bound, check dirty.
  must(call('implementation_parallel_declare', { projectId, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 100 }], idempotencyKey: 'd2' }), 'redeclare');
  must(call('implementation_parallel_check', { projectId, period: '2027-Q2', idempotencyKey: 'c2' }), 'recheck');
  must(call('implementation_signoff_record', { projectId, kind: 'tieout', evidenceRef: 'freigabe2', idempotencyKey: 'sig2' }), 'resign over dirty');
  got = must(call('implementation_project_get', { projectId }), 'get');
  assert.equal(got.tieout.checksClean, false, 'the check is dirty');
  assert.equal(got.tieout.signoffBound, true, 'the fresh tieout sign-off is bound to the current (dirty) evidence');
  assert.equal(got.tieout.passed, false, 'a bound tieout sign-off over a dirty check is NOT passed (check-clean leg)');
});

// --- Zero-tolerance + three-status honesty -------------------------------------------------------

test('zero tolerance: a 1-Rappen difference fails; no declaration is not_asserted', () => {
  const { call } = world('zero', 'studio');
  const projectId = createProject(call, 'zero');
  must(call('implementation_parallel_declare', { projectId, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 1 }], idempotencyKey: 'd' }), 'declare');
  const checked = must(call('implementation_parallel_check', { projectId, period: '2027-Q2', idempotencyKey: 'c' }), 'check');
  const fig = checked.figures[0];
  assert.equal(fig.computedRappen, 0, 'empty book computes 0');
  assert.equal(fig.differenceRappen, 1, 'difference is declared - computed');
  assert.equal(fig.status, 'failed', '1 Rappen fails');

  // A period with no declaration is not_asserted, never green.
  const status = must(call('implementation_parallel_status', { projectId }), 'status');
  assert.equal(status.overall, 'failed', 'the failing period drives overall');

  const w2 = world('nodecl', 'studio');
  const p2 = createProject(w2.call, 'nodecl');
  const s2 = must(w2.call('implementation_parallel_status', { projectId: p2 }), 'status');
  assert.equal(s2.overall, 'not_asserted', 'no declaration is not_asserted, never green');
});

test('property: differenceRappen == declared - computed and status follows the zero rule', () => {
  const { call } = world('prop', 'studio');
  const projectId = createProject(call, 'prop');
  // Over the empty book every computed figure is 0, so difference == declared and status is passed
  // iff declared is 0. Randomised integer declarations.
  // trial_balance over the empty book computes 0 deterministically, so the property is exact.
  for (let i = 0; i < 40; i += 1) {
    const declaredRappen = Math.floor((Math.random() - 0.5) * 2_000_000);
    must(call('implementation_parallel_declare', { projectId, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen }], idempotencyKey: `d-${i}` }), 'declare');
    const checked = must(call('implementation_parallel_check', { projectId, period: '2027-Q2', idempotencyKey: `c-${i}` }), 'check');
    const fig = checked.figures[0];
    assert.equal(fig.computedRappen, 0, 'empty book computes 0');
    assert.equal(fig.differenceRappen, declaredRappen - fig.computedRappen, 'exact subtraction');
    assert.equal(fig.status, fig.differenceRappen === 0 ? 'passed' : 'failed', 'zero rule');
  }
});

// --- Window alignment per method + method-change gate --------------------------------------------

test('effektiv aligns to quarter, saldo to semester; the wrong granularity refuses', () => {
  const eff = world('eff', 'studio');
  const pe = createProject(eff.call, 'eff', { mwstMethod: 'effektiv' });
  must(eff.call('implementation_parallel_declare', { projectId: pe, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 0 }], idempotencyKey: 'e' }), 'effektiv quarter ok');
  refuse(
    eff.call('implementation_parallel_declare', { projectId: pe, period: '2027-H1', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 0 }], idempotencyKey: 'e2' }),
    'period_outside_window',
    'effektiv rejects a semester',
  );

  const sal = world('sal', 'studio');
  const ps = createProject(sal.call, 'sal', { mwstMethod: 'saldo' });
  must(sal.call('implementation_parallel_declare', { projectId: ps, period: '2027-H1', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 0 }], idempotencyKey: 's' }), 'saldo semester ok');
  refuse(
    sal.call('implementation_parallel_declare', { projectId: ps, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 0 }], idempotencyKey: 's2' }),
    'period_outside_window',
    'saldo rejects a quarter',
  );
});

test('a cutover combined with a method change refuses without the mwst_method sign-off', () => {
  const { call } = world('mc', 'studio');
  const projectId = createProject(call, 'mc', { methodChange: true });
  refuse(
    call('implementation_parallel_declare', { projectId, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 0 }], idempotencyKey: 'd' }),
    'method_change_needs_signoff',
    'declare before method sign-off',
  );
  // After the mwst_method sign-off, the declaration proceeds.
  must(call('implementation_signoff_record', { projectId, kind: 'mwst_method', evidenceRef: 'estv-wechsel', idempotencyKey: 'sig' }), 'method sign-off');
  must(call('implementation_parallel_declare', { projectId, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 0 }], idempotencyKey: 'd2' }), 'declare after sign-off');
});

test('the parallel-run window may span multiple filing periods (D112)', () => {
  const { call } = world('multi', 'studio');
  const projectId = createProject(call, 'multi');
  for (const period of ['2027-Q1', '2027-Q2', '2027-Q3']) {
    must(call('implementation_parallel_declare', { projectId, period, figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 0 }], idempotencyKey: `d-${period}` }), `declare ${period}`);
    must(call('implementation_parallel_check', { projectId, period, idempotencyKey: `c-${period}` }), `check ${period}`);
  }
  const status = must(call('implementation_parallel_status', { projectId }), 'status');
  assert.equal(status.periods.length, 3, 'three filing periods in one window');
  assert.equal(status.overall, 'passed', 'all three periods pass');
});

// --- Append-only triggers ------------------------------------------------------------------------

test('append-only: decisions, sign-offs and declarations refuse a mutating UPDATE and any DELETE', () => {
  const { call, deps, wid } = world('append', 'studio');
  const projectId = createProject(call, 'append');
  const decId = must(call('implementation_decision_record', { projectId, title: 'T', decision: 'D', idempotencyKey: 'dec' }), 'decision').decisionId;
  const sigId = must(call('implementation_signoff_record', { projectId, kind: 'conversion_date', evidenceRef: 'e', idempotencyKey: 'sig' }), 'sign').signoffId;
  must(call('implementation_parallel_declare', { projectId, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 0 }], idempotencyKey: 'decl' }), 'declare');
  const declId = deps.store.db.prepare('SELECT id FROM parallel_run_declaration WHERE workspace_id = ?').get(wid).id;

  assert.throws(() => deps.store.db.prepare('UPDATE implementation_decision SET title = ? WHERE id = ?').run('x', decId), /decision_append_only/, 'decision UPDATE');
  assert.throws(() => deps.store.db.prepare('DELETE FROM implementation_decision WHERE id = ?').run(decId), /decision_append_only/, 'decision DELETE');
  assert.throws(() => deps.store.db.prepare('UPDATE implementation_signoff SET kind = ? WHERE id = ?').run('go_nogo', sigId), /signoff_append_only/, 'signoff kind UPDATE');
  assert.throws(() => deps.store.db.prepare('DELETE FROM implementation_signoff WHERE id = ?').run(sigId), /signoff_append_only/, 'signoff DELETE');
  assert.throws(() => deps.store.db.prepare('UPDATE parallel_run_declaration SET figures = ? WHERE id = ?').run('[]', declId), /declaration_append_only/, 'declaration figures UPDATE');
  assert.throws(() => deps.store.db.prepare('DELETE FROM parallel_run_declaration WHERE id = ?').run(declId), /declaration_append_only/, 'declaration DELETE');

  // The ALLOWED transitions still work: voiding a sign-off (voided_at NULL -> value), and superseding
  // a declaration (superseded_by NULL -> value).
  deps.store.db.prepare('UPDATE implementation_signoff SET voided_at = ?, void_reason = ? WHERE id = ?').run('2027-01-01', 'r', sigId);
  const decl2 = must(call('implementation_parallel_declare', { projectId, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 5 }], idempotencyKey: 'decl2' }), 'redeclare');
  const superseded = deps.store.db.prepare('SELECT superseded_by FROM parallel_run_declaration WHERE id = ?').get(declId).superseded_by;
  assert.equal(superseded, decl2.declarationId, 'the prior declaration was superseded by reference, both retained');
});

// --- Roster + §H-TENANT --------------------------------------------------------------------------

test('roster is workspace-scoped metadata; no verb crosses the fence over the six tables', () => {
  const a = world('tenant-a', 'studio');
  const projectA = createProject(a.call, 'tenant-a');
  must(a.call('implementation_runbook_instantiate', { projectId: projectA, templateId: 'w3_cutover', idempotencyKey: 'i' }), 'inst');
  must(a.call('implementation_decision_record', { projectId: projectA, title: 'T', decision: 'D', idempotencyKey: 'dec' }), 'dec');
  must(a.call('implementation_signoff_record', { projectId: projectA, kind: 'conversion_date', evidenceRef: 'e', idempotencyKey: 'sig' }), 'sig');
  must(a.call('implementation_parallel_declare', { projectId: projectA, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 0 }], idempotencyKey: 'd' }), 'decl');

  // A second workspace on the same store cannot read A's project or its rows.
  const b = mintWorkspace(a.deps, 'Andere GmbH', 'tenant-b-ws').workspaceId;
  const bcall = (name, input) => getAction(name).run(a.deps, { workspaceId: b, ...input });
  refuse(bcall('implementation_project_get', { projectId: projectA }), 'not_found', 'cross-workspace project_get');
  refuse(bcall('implementation_parallel_status', { projectId: projectA }), 'not_found', 'cross-workspace parallel_status');

  // B's roster is empty; A's roster shows exactly one metadata row for its own project.
  assert.equal(must(bcall('implementation_project_list', {}), 'B list').projects.length, 0, 'B sees no projects');
  const roster = must(a.call('implementation_project_list', {}), 'A list').projects;
  assert.equal(roster.length, 1, 'A sees one project');
  assert.equal(roster[0].projectId, projectA);
  assert.ok('phase' in roster[0] && 'daysToCutover' in roster[0], 'roster row is metadata');
});

// --- Close gating ---------------------------------------------------------------------------------

test('project_close refuses on each open leg in isolation, and closes when all are met', () => {
  const { call, deps, wid } = world('close', 'studio');
  const projectId = createProject(call, 'close');

  // Not live yet.
  refuse(call('implementation_project_close', { projectId, confirmed: true, idempotencyKey: 'x1' }), 'project_not_live', 'close before live');

  // Force live; still missing the closing sign-offs.
  deps.store.db.prepare("UPDATE implementation_project SET status = 'live' WHERE id = ? AND workspace_id = ?").run(projectId, wid);
  refuse(call('implementation_project_close', { projectId, confirmed: true, idempotencyKey: 'x2' }), 'parallel_run_not_closed', 'close without parallel_run_close');

  must(call('implementation_signoff_record', { projectId, kind: 'parallel_run_close', evidenceRef: 'e', idempotencyKey: 'sig1' }), 'sign close');
  refuse(call('implementation_project_close', { projectId, confirmed: true, idempotencyKey: 'x3' }), 'source_not_cancelled', 'close without source_cancellation');

  must(call('implementation_signoff_record', { projectId, kind: 'source_cancellation', evidenceRef: 'e', idempotencyKey: 'sig2' }), 'sign source');
  // Confirmation still required.
  refuse(call('implementation_project_close', { projectId, confirmed: false, idempotencyKey: 'x4' }), 'confirmation_required', 'close without confirm');
  const closed = must(call('implementation_project_close', { projectId, confirmed: true, idempotencyKey: 'x5' }), 'close');
  assert.equal(closed.ok, true);
  assert.equal(must(call('implementation_project_get', { projectId }), 'get').project.status, 'closed', 'phase is closed');
});

// --- No posting path + B00 not forked (static assertions) ----------------------------------------

test('the implementation engine posts nothing and does not import B00', () => {
  const projectSrc = readFileSync(fileURLToPath(new URL('../../src/core/migration/project.ts', import.meta.url)), 'utf8');
  const parallelSrc = readFileSync(fileURLToPath(new URL('../../src/core/migration/parallelRun.ts', import.meta.url)), 'utf8');
  for (const [name, src] of [['project.ts', projectSrc], ['parallelRun.ts', parallelSrc]]) {
    assert.equal(/postEntry|reverseEntry/.test(src), false, `${name} reaches no posting path`);
    assert.equal(/core\/projects\//.test(src), false, `${name} does not import B00 projects`);
  }
});

test('the phase and sign-off enums are single-sourced and complete', () => {
  assert.deepEqual([...PHASES], ['discovery', 'extraction', 'mapping', 'rehearsal', 'cutover', 'parallel_run', 'live', 'closed']);
  assert.equal(SIGNOFF_KINDS.length, 9, 'nine fixed sign-off kinds');
});
