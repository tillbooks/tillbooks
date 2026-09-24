/**
 * G12, the Testmandant: the invariants the spec §7 turns on, proven by measurement.
 *
 * The claims worth the most here, and the money-path ones a non-author must confirm bite:
 *  - CONTINUITY (the no-copy promise): going productive changes ONE workspace attribute, stamps
 *    promoted_at, and writes ONE A03 audit row; every other byte in the Testmandant is unchanged.
 *    Proven by mutation: a snapshot of every T-scoped row before and after is identical.
 *  - THE GATE IS A CONJUNCTION: five legs, each failing in isolation with its own named error.
 *  - PROVENANCE BEATS THE FLAG: a sandbox holding one demo-seeded row refuses even on a clean check.
 *  - THE TYPE-TO-CONFIRM IS ENGINE-CHECKED: a wrong legal name refuses on the registry path itself.
 *  - PROMOTE-TWICE IS IDEMPOTENT: a second promotion is a no-op, never a double-promote or a 2nd row.
 *  - DISCARD CANNOT REACH A LIVE WORKSPACE: it refuses off `sandbox`, and its delete is scoped to the
 *    trial's own workspace_id, so a live tenant's ledger rows survive by construction.
 *  - THE ENUM ADMITS NO FOURTH VALUE; `demo` has no transition; the two-workspace diff needs both
 *    memberships; §H-IDEMPOTENT on all three writes; §H-TENANT throughout.
 *
 * MONEY-PATH NOTE (CLAUDE.md): promotion is the least-reversible act in the product. These are
 * invariant tests on that act. Drafted by the capability author; the non-author critic on this
 * capability must confirm they bite before the branch lands.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/index.js';
import { WORKSPACE_KINDS, isWorkspaceKind, workspaceKindsAreExactlyThree } from '../../dist/core/migration/index.js';
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

/** A world with a `call` bound to a chosen actor (default studio, a human; 'agent' for P8). */
function world(seed, actor = 'studio') {
  const deps = freshDeps();
  deps.actor = actor;
  const { workspaceId } = mintWorkspace(deps, 'Quelle GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, wid: workspaceId, call };
}

function makePlan(call, seed) {
  return must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: `${seed}-plan` }), 'plan').planId;
}

/** A Testmandant with a real, complete company profile (so only the leg under test can fail). */
function promotable(call, seed) {
  const planId = makePlan(call, seed);
  const t = must(call('migration_create_testmandant', { planId, idempotencyKey: `${seed}-t` }), 'create_t');
  must(call('update_company_profile', { workspaceId: t.workspaceId, legalForm: 'gmbh', uid: `CHE-100.200.30${seed.length % 10}` }), 'profile');
  const name = must(call('get_company_profile', { workspaceId: t.workspaceId }), 'get_profile').profile.name;
  return { planId, tId: t.workspaceId, name };
}

const kindOf = (deps, id) => deps.store.db.prepare('SELECT kind FROM workspace WHERE id = ?').get(id)?.kind;

// --- The enum -----------------------------------------------------------------------------------

test('the workspace-kind enum admits exactly three values and no fourth', () => {
  assert.deepEqual([...WORKSPACE_KINDS], ['demo', 'sandbox', 'live']);
  assert.equal(workspaceKindsAreExactlyThree(), true);
  assert.equal(isWorkspaceKind('sandbox'), true);
  assert.equal(isWorkspaceKind('sandbox_live'), false);
  assert.equal(isWorkspaceKind('archived'), false);
  assert.equal(isWorkspaceKind(undefined), false);
});

// --- createTestmandant --------------------------------------------------------------------------

test('createTestmandant composes createWorkspace, stamps sandbox, and is idempotent per plan', () => {
  const { deps, call } = world('crt');
  const planId = makePlan(call, 'crt');
  const first = must(call('migration_create_testmandant', { planId, idempotencyKey: 'crt-1' }), 'first');
  assert.equal(first.created, true);
  assert.equal(kindOf(deps, first.workspaceId), 'sandbox');
  // A fresh, real workspace: it was born with A01's chart (composed, never a second mint path).
  const accounts = deps.store.db.prepare('SELECT COUNT(*) AS n FROM account WHERE workspace_id = ?').get(first.workspaceId).n;
  assert.ok(accounts > 0, 'the Testmandant is a full workspace with a seeded chart');
  // A second create for the same plan (a DIFFERENT key) returns the existing one, never a second ws.
  const second = must(call('migration_create_testmandant', { planId, idempotencyKey: 'crt-2' }), 'second');
  assert.equal(second.workspaceId, first.workspaceId);
  assert.equal(second.created, false);
  const total = deps.store.db.prepare("SELECT COUNT(*) AS n FROM workspace WHERE kind = 'sandbox'").get().n;
  assert.equal(total, 1, 'exactly one Testmandant was ever minted');
});

test('createTestmandant refuses a plan that is already live', () => {
  const { deps, call } = world('cal');
  const planId = makePlan(call, 'cal');
  deps.store.db.prepare("UPDATE migration_plan SET status = 'live' WHERE id = ?").run(planId);
  refuse(call('migration_create_testmandant', { planId, idempotencyKey: 'cal-1' }), 'plan_already_live', 'create on live plan');
});

// --- Continuity: the no-copy promise ------------------------------------------------------------

/** Every row that lives under a workspace, canonicalised, EXCEPT the two mutable columns and the audit log. */
function snapshotWorkspace(deps, id) {
  const tables = deps.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const dump = {};
  for (const { name } of tables) {
    // The A03 audit mechanism is the one thing the promotion is ALLOWED to move: `audit_log` gains the
    // single go_productive row, and `audit_head` is that chain's head (its row_count and hash follow).
    if (name === 'audit_log' || name === 'audit_head') continue;
    const cols = deps.store.db.pragma(`table_info(${name})`);
    if (!cols.some((c) => c.name === 'workspace_id')) continue;
    dump[name] = deps.store.db.prepare(`SELECT * FROM ${name} WHERE workspace_id = ? ORDER BY rowid`).all(id);
  }
  return JSON.stringify(dump);
}

test('goProductive copies nothing: every byte is unchanged but kind, promoted_at and one audit row', () => {
  const { deps, call } = world('con');
  const { planId, tId, name } = promotable(call, 'con');
  const before = snapshotWorkspace(deps, tId);
  const auditBefore = deps.store.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ?').get(tId).n;
  const wsBefore = deps.store.db.prepare('SELECT * FROM workspace WHERE id = ?').get(tId);

  const promoted = must(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'con-1' }), 'promote');
  assert.equal(promoted.workspaceId, tId);

  const after = snapshotWorkspace(deps, tId);
  assert.equal(after, before, 'no workspace_id-scoped row changed across going productive');
  const auditAfter = deps.store.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ?').get(tId).n;
  assert.equal(auditAfter, auditBefore + 1, 'exactly one A03 audit row was added');
  const wsAfter = deps.store.db.prepare('SELECT * FROM workspace WHERE id = ?').get(tId);
  // The workspace row itself differs in EXACTLY kind and promoted_at, nothing else.
  assert.equal(wsAfter.kind, 'live');
  assert.ok(wsAfter.promoted_at !== null);
  for (const key of Object.keys(wsAfter)) {
    if (key === 'kind' || key === 'promoted_at') continue;
    assert.deepEqual(wsAfter[key], wsBefore[key], `column ${key} must be unchanged by promotion`);
  }
});

// --- The gate is a conjunction: five legs, each in isolation ------------------------------------

test('leg 1 (check_not_clean): a failed control refuses promotion', () => {
  const { call } = world('gl1');
  const { planId, name } = promotable(call, 'gl1');
  // Scope an opening-balances step and declare a total the (empty) import cannot match -> a FAILED
  // control the final re-check widens in. The gate must refuse naming the controls.
  const scope = must(call('migration_set_scope', { planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: 'gl1-scope' }), 'scope');
  const stepId = scope.steps[0].stepId;
  must(call('migration_declare_control_total', { planId, stepId, kind: 'trial_balance_matches_source', scope: '1100', declaredMinor: 500000, idempotencyKey: 'gl1-dec' }), 'declare');
  const res = refuse(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'gl1-go' }), 'check_not_clean', 'go with a failing control');
  assert.ok(res.controls.length > 0, 'the refusal names the offending controls');
});

test('leg 2 (sandbox_contains_demo_rows): provenance beats the flag', () => {
  const { deps, call } = world('gl2');
  const { planId, tId, name } = promotable(call, 'gl2');
  // A clean check (no steps), but ONE demo-seeded posting in the Testmandant. The enum says sandbox;
  // provenance says otherwise, and provenance wins.
  deps.store.db
    .prepare("INSERT INTO journal_entry (id, workspace_id, date, status, source, created_at) VALUES ('je_demo', ?, '2020-01-01', 'posted', 'demo_seed', '2020-01-01')")
    .run(tId);
  const res = refuse(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'gl2-go' }), 'sandbox_contains_demo_rows', 'go with a demo row');
  assert.equal(res.row.id, 'je_demo');
  assert.equal(kindOf(deps, tId), 'sandbox', 'a refused promotion leaves the kind untouched');
});

test('leg 3 (needs_company_profile): a placeholder profile refuses', () => {
  const { call } = world('gl3');
  // A bare Testmandant: created but its profile never configured (no legal form, no UID).
  const planId = makePlan(call, 'gl3');
  const t = must(call('migration_create_testmandant', { planId, idempotencyKey: 'gl3-t' }), 'create_t');
  const name = must(call('get_company_profile', { workspaceId: t.workspaceId }), 'p').profile.name;
  const res = refuse(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'gl3-go' }), 'needs_company_profile', 'go with placeholder profile');
  assert.ok(res.missing.includes('legalForm') && res.missing.includes('uid'));
});

test('leg 4 (live_workspace_exists): a live workspace of the same UID refuses', () => {
  const { deps, call } = world('gl4');
  const { planId, tId, name } = promotable(call, 'gl4');
  // Another LIVE workspace already holds this UID: promotion offers the run-against-live path instead.
  const uid = deps.store.db.prepare('SELECT uid FROM workspace WHERE id = ?').get(tId).uid;
  const other = must(call('create_workspace', { workspaceId: undefined, name: 'Zwilling GmbH', idempotencyKey: 'gl4-other' }), 'other');
  deps.store.db.prepare("UPDATE workspace SET uid = ?, kind = 'live' WHERE id = ?").run(uid, other.workspaceId);
  refuse(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'gl4-go' }), 'live_workspace_exists', 'go with a UID clash');
});

test('leg 5 (the capability gate): go_productive requires promote_workspace AND commit_migration', () => {
  const caps = requiredCapabilitiesFor('go_productive', {});
  assert.ok(caps.includes('promote_workspace'), 'promote_workspace is required');
  assert.ok(caps.includes('commit_migration'), 'commit_migration is required');
});

// --- The type-to-confirm, engine-checked --------------------------------------------------------

test('the type-to-confirm is engine-checked: a wrong legal name refuses on the registry path', () => {
  const { call } = world('ttc');
  const { planId, name } = promotable(call, 'ttc');
  refuse(call('go_productive', { planId, confirmedName: `${name} X`, idempotencyKey: 'ttc-bad' }), 'confirm_name_mismatch', 'wrong name');
  // The exact legal name proceeds.
  must(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'ttc-ok' }), 'right name');
});

test('an agent caller is P8 draft-staged and never promotes without the confirmation', () => {
  const { deps, call } = world('p8', 'agent');
  const { planId, tId, name } = promotable(call, 'p8');
  const staged = must(call('go_productive', { planId, confirmedName: 'nope', idempotencyKey: 'p8-1' }), 'staged');
  assert.equal(staged.staged, true, 'an agent without the exact name is staged, not promoted');
  assert.equal(kindOf(deps, tId), 'sandbox', 'staging promotes nothing');
  // The recorded human confirmation (the exact legal name) lets it through.
  must(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'p8-2' }), 'agent with name');
  assert.equal(kindOf(deps, tId), 'live');
});

// --- Idempotency and the one-way transition -----------------------------------------------------

test('promote-twice is idempotent: a second promotion is a no-op, never a double-promote', () => {
  const { deps, call } = world('idm');
  const { planId, tId, name } = promotable(call, 'idm');
  must(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'idm-1' }), 'first');
  const auditAfterFirst = deps.store.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ?').get(tId).n;
  // A brand-new key on the already-live workspace: no-op, not a second promotion.
  const again = must(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'idm-2' }), 'again');
  assert.equal(again.alreadyLive, true);
  const auditAfterSecond = deps.store.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ?').get(tId).n;
  assert.equal(auditAfterSecond, auditAfterFirst, 'no second audit row: the transition happens once');
});

test('demo never promotes and demo never discards through this family', () => {
  const { deps, call } = world('dmo');
  const { planId, tId, name } = promotable(call, 'dmo');
  deps.store.db.prepare("UPDATE workspace SET kind = 'demo' WHERE id = ?").run(tId);
  refuse(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'dmo-go' }), 'not_a_testmandant', 'promote a demo');
  refuse(call('discard_testmandant', { planId, confirmed: true, idempotencyKey: 'dmo-dis' }), 'not_a_testmandant', 'discard a demo');
});

// --- discard: the structural fence and the plan reset -------------------------------------------

test('discard_testmandant refuses after promotion, because the kind moved to live', () => {
  const { call } = world('dpr');
  const { planId, name } = promotable(call, 'dpr');
  must(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'dpr-go' }), 'promote');
  refuse(call('discard_testmandant', { planId, confirmed: true, idempotencyKey: 'dpr-dis' }), 'not_a_testmandant', 'discard after promotion');
});

test('discard_testmandant CANNOT reach a live workspace: its ledger rows survive by construction', () => {
  const { deps, call } = world('liv');
  // A real LIVE workspace with a posted opening entry, standing beside the trial.
  const live = must(call('create_workspace', { workspaceId: undefined, name: 'Echte AG', idempotencyKey: 'liv-live' }), 'live');
  deps.store.db
    .prepare("INSERT INTO journal_entry (id, workspace_id, date, status, source, created_at) VALUES ('je_live', ?, '2020-01-01', 'posted', 'manual', '2020-01-01')")
    .run(live.workspaceId);
  const planId = makePlan(call, 'liv');
  must(call('migration_create_testmandant', { planId, idempotencyKey: 'liv-t' }), 'create_t');
  must(call('discard_testmandant', { planId, confirmed: true, idempotencyKey: 'liv-dis' }), 'discard');
  // The live workspace and its ledger row are untouched: discard only ever names the sandbox's id.
  const stillThere = deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE id = 'je_live'").get().n;
  assert.equal(stillThere, 1, 'the live ledger row survives the discard');
  assert.equal(kindOf(deps, live.workspaceId), 'live', 'the live workspace itself survives');
});

test('discard_testmandant hard-deletes the trial and resets the plan, keeping the maps and controls', () => {
  const { deps, call } = world('drs');
  const planId = makePlan(call, 'drs');
  const scope = must(call('migration_set_scope', { planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: 'drs-scope' }), 'scope');
  const stepId = scope.steps[0].stepId;
  must(call('migration_declare_control_total', { planId, stepId, kind: 'trial_balance_matches_source', scope: '1100', declaredMinor: 100, idempotencyKey: 'drs-dec' }), 'declare');
  const t = must(call('migration_create_testmandant', { planId, idempotencyKey: 'drs-t' }), 'create_t');
  must(call('discard_testmandant', { planId, confirmed: true, idempotencyKey: 'drs-dis' }), 'discard');
  // The trial workspace and every row under it are gone.
  const gone = deps.store.db.prepare('SELECT COUNT(*) AS n FROM workspace WHERE id = ?').get(t.workspaceId).n;
  assert.equal(gone, 0, 'the Testmandant workspace is hard-deleted');
  const accountsGone = deps.store.db.prepare('SELECT COUNT(*) AS n FROM account WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(accountsGone, 0, 'every row under it is gone');
  // The plan survives, reset to planned with its link cleared; the step is back to mapped; the
  // declared control (the operator's work) is kept.
  const plan = deps.store.db.prepare('SELECT status, testmandant_workspace_id FROM migration_plan WHERE id = ?').get(planId);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.testmandant_workspace_id, null);
  const step = deps.store.db.prepare('SELECT status FROM migration_step WHERE id = ?').get(stepId);
  assert.equal(step.status, 'mapped');
  const controls = deps.store.db.prepare('SELECT COUNT(*) AS n FROM migration_control_total WHERE plan_id = ?').get(planId).n;
  assert.ok(controls > 0, 'the declared control totals survive the discard');
});

test('discard needs a confirmation', () => {
  const { call } = world('dcf');
  const planId = makePlan(call, 'dcf');
  must(call('migration_create_testmandant', { planId, idempotencyKey: 'dcf-t' }), 'create_t');
  refuse(call('discard_testmandant', { planId, confirmed: false, idempotencyKey: 'dcf-dis' }), 'needs_confirmation', 'discard without confirm');
});

// --- The two-workspace diff and its membership fence -------------------------------------------

test('the diff is a two-workspace read that demands membership of BOTH sides', () => {
  const { deps, call } = world('dif');
  const { planId, tId } = promotable(call, 'dif');
  const uid = deps.store.db.prepare('SELECT uid FROM workspace WHERE id = ?').get(tId).uid;
  // A live workspace of the same UID, PROVISIONED to a different actor, so the caller ('studio') is a
  // member of the sandbox (unprovisioned = everyone's) but NOT of the live side.
  const other = must(call('create_workspace', { workspaceId: undefined, name: 'Fremd GmbH', idempotencyKey: 'dif-o' }), 'other');
  deps.store.db.prepare("UPDATE workspace SET uid = ?, kind = 'live' WHERE id = ?").run(uid, other.workspaceId);
  deps.store.db.prepare("INSERT INTO user (id, actor_id, created_at) VALUES ('u_other', 'someone_else', '2020-01-01')").run();
  deps.store.db
    .prepare("INSERT INTO workspace_member (id, workspace_id, user_id, role, invited_at, accepted_at, created_by) VALUES ('m_other', ?, 'u_other', 'owner', '2020-01-01', '2020-01-01', 'someone_else')")
    .run(other.workspaceId);
  refuse(call('migration_diff_testmandant_to_live', { planId }), 'forbidden', 'diff without both memberships');
});

test('the diff returns {live:null} when no live workspace shares the UID', () => {
  const { call } = world('dnl');
  const { planId } = promotable(call, 'dnl');
  const res = must(call('migration_diff_testmandant_to_live', { planId }), 'diff');
  assert.equal(res.live, null);
});

// --- getTestmandant and the seam ----------------------------------------------------------------

test('getTestmandant reports the workspace, and an absent one returns {none:true}', () => {
  const { call } = world('get');
  const planId = makePlan(call, 'get');
  assert.equal(must(call('migration_get_testmandant', { planId }), 'none').none, true);
  const t = must(call('migration_create_testmandant', { planId, idempotencyKey: 'get-t' }), 'create_t');
  const got = must(call('migration_get_testmandant', { planId }), 'got');
  assert.equal(got.workspaceId, t.workspaceId);
  assert.equal(got.kind, 'sandbox');
});
