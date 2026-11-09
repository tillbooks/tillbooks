/**
 * G12, ONE PLAN OWNS A TESTMANDANT (owner decision 11.10.2026): the security defect this holds shut,
 * and the design that replaced three failed fixes.
 *
 * THE DEFECT. `discard_testmandant` hard-deletes the workspace `migration_plan.testmandant_workspace_id`
 * names. A restore of a backup as a new workspace KEPT that link, so a restored copy of the books
 * pointed at the ORIGINAL's sandbox, and discarding (or abandoning) from the copy deleted it; going
 * productive from the copy would have promoted it.
 *
 * THE DESIGN. One link, written only by the creating workspace, with no shared state possible by
 * construction: a restore CLEARS the link (a mid-trial plan back to planned, trial steps back to
 * mapped); env_copy re-points it at the Testmandant's copy and sweeps the rest; `owningPlan` settles
 * the legacy books that already share one (the single linker, else the creation receipt, else the
 * lowest workspace rowid), and a non-owner may only drop its own link.
 *
 * Every test below names the fix it proves; each was reverted once and seen to fail (see the commit).
 * Synthetic data only: invented names, no bank data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { makeContext } from '../../dist/core/context.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { abandonPlan, hardDeleteWorkspace } from '../../dist/core/migration/index.js';
import { err, ok } from '../../dist/core/result.js';
import { envCreate, envCopy } from '../../dist/core/landscape/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { fixture } from '../api/conformance-contract.mjs';

const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};
const refuse = (res, error, what) => {
  assert.equal(res.ok, false, `${what} should have refused: ${JSON.stringify(res)}`);
  assert.equal(res.error, error, `${what} wrong error: ${JSON.stringify(res)}`);
  return res;
};

const exists = (db, id) => db.prepare('SELECT 1 AS p FROM workspace WHERE id = ?').get(id) !== undefined;
const planOf = (db, workspaceId) =>
  db.prepare('SELECT id, status, testmandant_workspace_id AS link FROM migration_plan WHERE workspace_id = ? ORDER BY rowid').get(workspaceId);
const stepsOf = (db, planId) =>
  db.prepare('SELECT status, last_check_id AS checkId FROM migration_step WHERE plan_id = ? ORDER BY rowid').all(planId);
const approvalsOf = (db, planId) => db.prepare('SELECT COUNT(*) AS n FROM migration_approval WHERE plan_id = ?').get(planId).n;
/** Record an approval on every step of a plan, the row a human's sign-off on a check leaves. */
function approveSteps(db, planId) {
  for (const s of db.prepare('SELECT id, workspace_id FROM migration_step WHERE plan_id = ?').all(planId)) {
    db.prepare("INSERT INTO migration_approval (id, workspace_id, plan_id, step_id, check_hash, actor, created_at) VALUES (?, ?, ?, ?, 'chk_trial', 'studio', '2026-10-11T00:00:00.000Z')")
      .run(`appr_${s.id}`, s.workspace_id, planId, s.id);
  }
}
const deletionRows = (db, workspaceId) =>
  db
    .prepare("SELECT entity_kind, entity_id, action, actor FROM audit_log WHERE workspace_id = ? AND action LIKE 'testmandant_deleted_by_%' ORDER BY rowid")
    .all(workspaceId);

/**
 * The source books: a workspace, a plan scoped to opening balances from a balanced CSV, its
 * Testmandant (created through the verb, so the creation receipt exists), a real company profile on
 * the Testmandant, and a trial-load, so the plan is genuinely mid-trial (`trial`, a `trial_loaded` step).
 */
function world(seed = 'own') {
  const fx = fixture();
  fx.deps.actor = 'studio';
  const call = (name, input, workspaceId = fx.workspaceId, actor = 'studio') => getAction(name).run({ ...fx.deps, actor }, { workspaceId, ...input });
  const accounts = must(call('list_accounts', {}), 'list_accounts').accounts;
  const csv = `account,debitMinor,creditMinor\n${accounts[0].number},100000,0\n${accounts[1].number},0,100000\n`;
  const fileId = must(
    call('files_upload', { title: `Eröffnung ${seed}`, filename: `${seed}.csv`, mime: 'text/csv', contentBase64: Buffer.from(csv).toString('base64'), idempotencyKey: `${seed}-up` }),
    'files_upload',
  ).file.id;
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: `${seed}-plan` }), 'plan').planId;
  must(call('migration_discover_source', { fileIds: [fileId], planId }), 'discover');
  const stepId = must(
    call('migration_set_scope', { planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: `${seed}-scope` }),
    'scope',
  ).steps[0].stepId;
  const sandboxId = must(call('migration_create_testmandant', { planId, idempotencyKey: `${seed}-t` }), 'testmandant').workspaceId;
  must(call('update_company_profile', { workspaceId: sandboxId, legalForm: 'gmbh', uid: 'CHE-111.222.333' }), 'profile');
  const legalName = must(call('get_company_profile', { workspaceId: sandboxId }), 'get_profile').profile.name;
  must(call('migration_trial_load_step', { planId, stepId, idempotencyKey: `${seed}-trial` }), 'trial_load');
  const db = fx.deps.store.db;
  assert.equal(planOf(db, fx.workspaceId).status, 'trial', 'the precondition: the plan is mid-trial');
  assert.equal(stepsOf(db, planId)[0].status, 'trial_loaded', 'the precondition: a trial-loaded step');
  return { fx, db, call, planId, stepId, sandboxId, legalName };
}

/** Back the source up (the artifact a disaster recovery or a copy starts from). */
function backupOf(w, key = 'own-bkp') {
  return must(w.call('create_backup', { idempotencyKey: key }), 'create_backup').artifactRef;
}

/** Restore a backup beside the original, in the same book. */
function restoreBeside(w, artifactRef, name = 'Kopie GmbH', key = 'own-rst') {
  return must(
    getAction('restore_backup').run(w.fx.deps, { source: artifactRef, newWorkspaceName: name, confirmed: true, idempotencyKey: key }),
    'restore_backup',
  ).workspaceId;
}

/**
 * The LEGACY state a restore wrote before 11.10.2026: the copy's plan links the ORIGINAL's sandbox,
 * mid-trial. Rebuilt by hand from a real restore (which now clears it).
 */
function legacyCopy(w, name = 'Kopie GmbH', key = 'own-rst') {
  const copy = restoreBeside(w, backupOf(w, `${key}-bkp`), name, key);
  const copyPlan = planOf(w.db, copy);
  w.db.prepare("UPDATE migration_plan SET testmandant_workspace_id = ?, status = 'trial' WHERE id = ?").run(w.sandboxId, copyPlan.id);
  w.db.prepare("UPDATE migration_step SET status = 'checked', last_check_id = 'chk_trial' WHERE plan_id = ?").run(copyPlan.id);
  approveSteps(w.db, copyPlan.id);
  return { copy, copyPlanId: copyPlan.id };
}

// --- 1. Restore clears the link -----------------------------------------------------------------------

test('restore beside the original: the copy\'s link is NULL and its trial is reset; the copy cannot discard or promote the original\'s sandbox; the original still discards it', () => {
  const w = world('rb');
  w.db.prepare("UPDATE migration_step SET status = 'checked', last_check_id = 'chk_trial' WHERE id = ?").run(w.stepId);
  approveSteps(w.db, w.planId);
  const copy = restoreBeside(w, backupOf(w));
  const copyPlan = planOf(w.db, copy);
  assert.deepEqual([copyPlan.link, copyPlan.status], [null, 'planned'], 'cleared, and back to planned');
  assert.deepEqual(stepsOf(w.db, copyPlan.id), [{ status: 'mapped', checkId: null }], 'a checked step goes back to mapped, its check id cleared');
  assert.equal(approvalsOf(w.db, copyPlan.id), 0, 'and its approval is not carried (canon blocker 6)');
  assert.equal(approvalsOf(w.db, w.planId), 1, 'the original keeps its approval');
  // The trial-load recorded the sandbox in the step's counts; the copy keeps no trace of it (before the
  // fix this one value refused the whole restore beside the original as a foreign reference).
  const counts = JSON.parse(w.db.prepare('SELECT counts FROM migration_step WHERE plan_id = ?').get(copyPlan.id).counts);
  assert.equal(counts.trialTarget, null, 'the copied step names no trial target');
  assert.equal(JSON.parse(w.db.prepare('SELECT counts FROM migration_step WHERE id = ?').get(w.stepId).counts).trialTarget, w.sandboxId, 'the original step still does');
  assert.deepEqual([planOf(w.db, w.fx.workspaceId).link, planOf(w.db, w.fx.workspaceId).status], [w.sandboxId, 'trial'], 'the original is untouched');

  refuse(w.call('discard_testmandant', { planId: copyPlan.id, confirmed: true, idempotencyKey: 'rb-cd' }, copy), 'not_a_testmandant', 'discard from the copy');
  assert.equal(exists(w.db, w.sandboxId), true, 'the original sandbox survives the copy\'s discard');
  refuse(w.call('go_productive', { planId: copyPlan.id, confirmedName: w.legalName, idempotencyKey: 'rb-cg' }, copy), 'not_a_testmandant', 'promote from the copy');
  assert.equal(w.db.prepare('SELECT kind FROM workspace WHERE id = ?').get(w.sandboxId).kind, 'sandbox', 'nothing was promoted');

  const discarded = must(w.call('discard_testmandant', { planId: w.planId, confirmed: true, idempotencyKey: 'rb-od' }), 'discard in the original');
  assert.equal(discarded.discardedWorkspaceId, w.sandboxId);
  assert.equal(exists(w.db, w.sandboxId), false, 'the original\'s own discard still deletes it');
  w.fx.deps.store.close();
});

test('restore into an empty book (disaster recovery): the plan goes back to planned, trial steps to mapped, and the tenant fence passes', () => {
  const w = world('dr');
  const artifact = backupOf(w);
  const dir = mkdtempSync(join(tmpdir(), 'tm-dr-'));
  const empty = { store: new SqliteStore({ clock: fixedClock('2026-10-11T00:00:00.000Z') }), clock: fixedClock('2026-10-11T00:00:00.000Z'), ids: systemIdGen, actor: 'studio', backupDir: dir };
  try {
    const restored = must(getAction('restore_backup').run(empty, { source: artifact, newWorkspaceName: 'Wiederhergestellt AG', confirmed: true, idempotencyKey: 'dr-rst' }), 'restore into an empty book');
    const plan = planOf(empty.store.db, restored.workspaceId);
    assert.deepEqual([plan.link, plan.status], [null, 'planned']);
    assert.deepEqual(stepsOf(empty.store.db, plan.id).map((s) => s.status), ['mapped']);
    assert.equal(empty.store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, 1, 'no sandbox appears out of nowhere');
  } finally {
    empty.store.close();
    rmSync(dir, { recursive: true, force: true });
    w.fx.deps.store.close();
  }
});

test('a legacy backup that carries a link (every backup written before the fix does) restores with the link cleared; live, closed and abandoned plans keep their status', () => {
  for (const status of ['trial', 'live', 'closed', 'abandoned']) {
    const w = world(`lb${status}`);
    w.db.prepare('UPDATE migration_plan SET status = ? WHERE id = ?').run(status, w.planId);
    const artifact = backupOf(w);
    // The fixture really carries the link: read the backup's own snapshot.
    const snap = new Database(join(artifact, 'data.sqlite'), { readonly: true });
    const carried = snap.prepare('SELECT testmandant_workspace_id AS link, status FROM migration_plan').get();
    snap.close();
    assert.deepEqual([carried.link, carried.status], [w.sandboxId, status], 'the backup carries the link');
    const copy = restoreBeside(w, artifact);
    const plan = planOf(w.db, copy);
    assert.equal(plan.link, null, `${status}: the restored link is cleared`);
    assert.equal(plan.status, status === 'trial' ? 'planned' : status, `${status}: only a mid-trial plan moves`);
    w.fx.deps.store.close();
  }
});

// --- 2. Legacy in-book shared state: owningPlan --------------------------------------------------------

test('legacy shared state: the copy\'s discard only unlinks (no deletion), and the original\'s go_productive passes', () => {
  const w = world('ls');
  const { copy, copyPlanId } = legacyCopy(w);
  const res = must(w.call('discard_testmandant', { planId: copyPlanId, confirmed: true, idempotencyKey: 'ls-cd' }, copy), 'discard from the copy');
  assert.deepEqual([res.unlinkedOnly, res.discardedWorkspaceId], [true, null]);
  assert.equal(exists(w.db, w.sandboxId), true, 'the original sandbox survives');
  assert.deepEqual([planOf(w.db, copy).link, planOf(w.db, copy).status], [null, 'planned'], 'the copy drops its link and its trial');
  assert.deepEqual(stepsOf(w.db, copyPlanId).map((x) => x.status), ['mapped']);
  assert.equal(approvalsOf(w.db, copyPlanId), 0, 'the steps returned to mapped lose their approvals (canon blocker 6)');
  assert.deepEqual(deletionRows(w.db, copy), [], 'no deletion is recorded where none happened');
  assert.equal(planOf(w.db, w.fx.workspaceId).link, w.sandboxId, 'the original keeps its link');
  must(w.call('go_productive', { planId: w.planId, confirmedName: w.legalName, idempotencyKey: 'ls-go' }), 'the original promotes');
  assert.equal(w.db.prepare('SELECT kind FROM workspace WHERE id = ?').get(w.sandboxId).kind, 'live');
  w.fx.deps.store.close();
});

test('legacy shared state: the copy\'s go_productive is refused testmandant_not_owned and writes nothing, while it still links', () => {
  const w = world('lg');
  const { copy, copyPlanId } = legacyCopy(w);
  const before = w.db.prepare('SELECT total_changes() AS n').get().n;
  refuse(w.call('go_productive', { planId: copyPlanId, confirmedName: w.legalName, idempotencyKey: 'lg-cg' }, copy), 'testmandant_not_owned', 'promote from the copy');
  assert.equal(w.db.prepare('SELECT total_changes() AS n').get().n, before, 'not one row written');
  assert.equal(w.db.prepare('SELECT kind FROM workspace WHERE id = ?').get(w.sandboxId).kind, 'sandbox');
  w.fx.deps.store.close();
});

test('legacy shared state with the receipt deleted: the lowest workspace rowid owns, so the copy still only unlinks and the original still promotes', () => {
  const w = world('lr');
  const { copy, copyPlanId } = legacyCopy(w);
  const removed = w.db.prepare("DELETE FROM idempotency WHERE verb = 'migration_create_testmandant'").run().changes;
  assert.ok(removed > 0, 'the precondition: the receipt existed and is gone');
  assert.equal(must(w.call('discard_testmandant', { planId: copyPlanId, confirmed: true, idempotencyKey: 'lr-cd' }, copy), 'copy discard').unlinkedOnly, true);
  assert.equal(exists(w.db, w.sandboxId), true);
  must(w.call('go_productive', { planId: w.planId, confirmedName: w.legalName, idempotencyKey: 'lr-go' }), 'the original promotes');
  w.fx.deps.store.close();
});

test('legacy shared state where the copy is OLDER by rowid: the creation receipt decides, not the rowid', () => {
  const w = world('lo');
  // A workspace minted BEFORE the original (lower rowid) whose plan was hand-linked to the sandbox.
  const older = w.db.prepare('SELECT MIN(rowid) AS r FROM workspace').get().r;
  const intruder = must(getAction('create_workspace').run(w.fx.deps, { name: 'Ältere AG', idempotencyKey: 'lo-ws' }), 'ws').workspaceId;
  // Move the intruder below the original in rowid order, the shape the rowid rule would get wrong.
  w.db.prepare('UPDATE workspace SET rowid = ? WHERE id = ?').run(older - 1, intruder);
  const intruderPlan = must(
    getAction('migration_create_plan').run(w.fx.deps, { workspaceId: intruder, sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: 'lo-plan' }),
    'plan',
  ).planId;
  w.db.prepare("UPDATE migration_plan SET testmandant_workspace_id = ?, status = 'trial' WHERE id = ?").run(w.sandboxId, intruderPlan);
  refuse(w.call('go_productive', { planId: intruderPlan, confirmedName: w.legalName, idempotencyKey: 'lo-ig' }, intruder), 'testmandant_not_owned', 'the older non-owner promotes');
  assert.equal(must(w.call('discard_testmandant', { planId: intruderPlan, confirmed: true, idempotencyKey: 'lo-id' }, intruder), 'intruder discard').unlinkedOnly, true);
  assert.equal(exists(w.db, w.sandboxId), true);
  must(w.call('go_productive', { planId: w.planId, confirmedName: w.legalName, idempotencyKey: 'lo-go' }), 'the receipt holder promotes');
  w.fx.deps.store.close();
});

test('legacy shared state with an ARCHIVED copy: the owner is not blocked, and its discard deletes the sandbox', () => {
  const w = world('la');
  const { copy } = legacyCopy(w);
  must(w.call('archive_workspace', { archived: true, idempotencyKey: 'la-arch' }, copy), 'archive the copy');
  refuse(w.call('discard_testmandant', { planId: planOf(w.db, copy).id, confirmed: true, idempotencyKey: 'la-cd' }, copy), 'workspace_archived', 'the archived copy writes nothing');
  must(w.call('discard_testmandant', { planId: w.planId, confirmed: true, idempotencyKey: 'la-od' }), 'the owner discards');
  assert.equal(exists(w.db, w.sandboxId), false);
  assert.equal(planOf(w.db, copy).link, w.sandboxId, 'the archived copy\'s dangling link is left as it was (archived books do not move)');
  w.fx.deps.store.close();
});

test('legacy shared state with a DR copy in active use (committed steps): the copy only unlinks, and the original still promotes', () => {
  const w = world('ld');
  const { copy, copyPlanId } = legacyCopy(w);
  // The copy is the one in use after the incident: its plan has moved on to live with a committed step.
  w.db.prepare("UPDATE migration_plan SET status = 'live' WHERE id = ?").run(copyPlanId);
  w.db.prepare("UPDATE migration_step SET status = 'committed' WHERE plan_id = ?").run(copyPlanId);
  const res = must(w.call('discard_testmandant', { planId: copyPlanId, confirmed: true, idempotencyKey: 'ld-cd' }, copy), 'copy discard');
  assert.equal(res.unlinkedOnly, true);
  assert.equal(exists(w.db, w.sandboxId), true);
  must(w.call('go_productive', { planId: w.planId, confirmedName: w.legalName, idempotencyKey: 'ld-go' }), 'the original promotes');
  w.fx.deps.store.close();
});

test('legacy shared state after the ORIGINAL is lost: the surviving copy is the single linker and owns the sandbox', () => {
  const w = world('ll');
  const { copy, copyPlanId } = legacyCopy(w);
  const ctx = makeContext(w.fx.deps.store, { workspaceId: w.fx.workspaceId, actor: 'studio', clock: w.fx.deps.clock, ids: w.fx.deps.ids });
  w.fx.deps.store.tx(() => hardDeleteWorkspace(ctx, w.fx.workspaceId));
  assert.equal(exists(w.db, w.fx.workspaceId), false, 'the precondition: the original is gone');
  must(w.call('discard_testmandant', { planId: copyPlanId, confirmed: true, idempotencyKey: 'll-cd' }, copy), 'the copy discards');
  assert.equal(exists(w.db, w.sandboxId), false, 'the copy, now the owner, deleted it');
  assert.deepEqual(deletionRows(w.db, copy).map((r) => r.action), ['testmandant_deleted_by_discard']);
  w.fx.deps.store.close();
});

// --- 3. Discard: gone, terminal plans, archived owner ----------------------------------------------

test('a link to a workspace that no longer exists is cleared: {alreadyGone:true}, nothing deleted', () => {
  const w = world('gn');
  w.db.prepare("UPDATE migration_plan SET testmandant_workspace_id = 'ws_nirgendwo' WHERE id = ?").run(w.planId);
  approveSteps(w.db, w.planId);
  const res = must(w.call('discard_testmandant', { planId: w.planId, idempotencyKey: 'gn-d' }), 'discard a gone link');
  assert.deepEqual([res.alreadyGone, res.discardedWorkspaceId], [true, null]);
  assert.deepEqual([planOf(w.db, w.fx.workspaceId).link, planOf(w.db, w.fx.workspaceId).status], [null, 'planned']);
  assert.deepEqual(stepsOf(w.db, w.planId).map((x) => x.status), ['mapped']);
  assert.equal(approvalsOf(w.db, w.planId), 0, 'the reset step loses its approval');
  assert.equal(exists(w.db, w.sandboxId), true, 'the real sandbox is not touched');
  w.fx.deps.store.close();
});

test('discard on an abandoned plan deletes the sandbox and the plan STAYS abandoned (it never revives to planned)', () => {
  for (const status of ['abandoned', 'closed']) {
    const w = world(`ab${status}`);
    w.db.prepare('UPDATE migration_plan SET status = ? WHERE id = ?').run(status, w.planId);
    must(w.call('discard_testmandant', { planId: w.planId, confirmed: true, idempotencyKey: 'ab-d' }), `discard on a ${status} plan`);
    assert.equal(exists(w.db, w.sandboxId), false);
    assert.equal(planOf(w.db, w.fx.workspaceId).status, status, `the plan stays ${status}`);
    assert.equal(stepsOf(w.db, w.planId)[0].status, 'trial_loaded', 'its steps stay as they stood');
    w.fx.deps.store.close();
  }
});

test('an archived owner: discard is refused, and succeeds after unarchive', () => {
  const w = world('ao');
  must(w.call('archive_workspace', { archived: true, idempotencyKey: 'ao-a' }), 'archive');
  refuse(w.call('discard_testmandant', { planId: w.planId, confirmed: true, idempotencyKey: 'ao-d' }), 'workspace_archived', 'discard while archived');
  assert.equal(exists(w.db, w.sandboxId), true);
  must(w.call('archive_workspace', { archived: false, idempotencyKey: 'ao-u' }), 'unarchive');
  must(w.call('discard_testmandant', { planId: w.planId, confirmed: true, idempotencyKey: 'ao-d2' }), 'discard after unarchive');
  assert.equal(exists(w.db, w.sandboxId), false);
  w.fx.deps.store.close();
});

// --- 4. Abandon deletes, through the one guarded path ------------------------------------------------

test('abandon as the owner deletes the sandbox, says so, and writes an audit row in the source; a replay is idempotent', () => {
  const w = world('ad');
  const first = must(w.call('migration_abandon_plan', { planId: w.planId, confirmed: true, idempotencyKey: 'ad-1' }), 'abandon');
  assert.equal(first.testmandantDiscarded, true);
  assert.equal(exists(w.db, w.sandboxId), false);
  assert.deepEqual([planOf(w.db, w.fx.workspaceId).status, planOf(w.db, w.fx.workspaceId).link], ['abandoned', null]);
  assert.deepEqual(deletionRows(w.db, w.fx.workspaceId), [
    { entity_kind: 'migration_plan', entity_id: w.planId, action: 'testmandant_deleted_by_abandon', actor: 'studio' },
  ]);
  const replay = must(w.call('migration_abandon_plan', { planId: w.planId, confirmed: true, idempotencyKey: 'ad-1' }), 'replay');
  assert.deepEqual(replay, first, 'the replay returns the stored result');
  assert.equal(deletionRows(w.db, w.fx.workspaceId).length, 1, 'and records no second deletion');
  w.fx.deps.store.close();
});

test('abandon as a NON-owner (a legacy copy) deletes nothing and drops only its own link', () => {
  const w = world('an');
  const { copy, copyPlanId } = legacyCopy(w);
  const res = must(w.call('migration_abandon_plan', { planId: copyPlanId, confirmed: true, idempotencyKey: 'an-1' }, copy), 'abandon in the copy');
  assert.equal(res.testmandantDiscarded, false);
  assert.equal(exists(w.db, w.sandboxId), true, 'the original\'s sandbox survives');
  assert.deepEqual([planOf(w.db, copy).status, planOf(w.db, copy).link], ['abandoned', null]);
  assert.equal(planOf(w.db, w.fx.workspaceId).link, w.sandboxId, 'the original keeps its link');
  must(w.call('go_productive', { planId: w.planId, confirmedName: w.legalName, idempotencyKey: 'an-go' }), 'the original promotes');
  w.fx.deps.store.close();
});

test('abandon after a commit without commit_migration is refused before any write: the sandbox and the plan are untouched', () => {
  const w = world('ac');
  w.db.prepare("UPDATE migration_step SET status = 'committed' WHERE plan_id = ?").run(w.planId);
  const ctx = (capabilities) =>
    makeContext(w.fx.deps.store, {
      workspaceId: w.fx.workspaceId,
      actor: 'studio',
      clock: w.fx.deps.clock,
      ids: w.fx.deps.ids,
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...ledgerPorts({ store: w.fx.deps.store, workspaceId: w.fx.workspaceId, ids: w.fx.deps.ids }),
    });
  const denyCommit = { assert: (c) => (c === 'commit_migration' ? err('permission_denied', { capability: c }) : ok({})) };
  const before = w.db.prepare('SELECT total_changes() AS n').get().n;
  const denied = abandonPlan(ctx(denyCommit), { planId: w.planId, confirmed: true, idempotencyKey: 'ac-1' });
  assert.deepEqual([denied.ok, denied.error], [false, 'permission_denied']);
  assert.equal(w.db.prepare('SELECT total_changes() AS n').get().n, before, 'not one row written');
  assert.equal(exists(w.db, w.sandboxId), true, 'the sandbox survives the refusal');
  must(abandonPlan(ctx(undefined), { planId: w.planId, confirmed: true, idempotencyKey: 'ac-1' }), 'granted');
  assert.equal(exists(w.db, w.sandboxId), false);
  w.fx.deps.store.close();
});

test('the agent seat drafts an abandon under erase (it deletes), and nothing is deleted until a person approves', () => {
  const w = world('ag');
  const drafted = handleRest('migration_abandon_plan', { workspaceId: w.fx.workspaceId, planId: w.planId, confirmed: true, idempotencyKey: 'ag-1' }, { ...w.fx.deps, actor: 'agent' }).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(drafted.dialCapability, 'erase');
  assert.equal(exists(w.db, w.sandboxId), true, 'the proposal deletes nothing');
  assert.equal(planOf(w.db, w.fx.workspaceId).status, 'trial');
  w.fx.deps.store.close();
});

test('every Testmandant deletion leaves an audit row in the SOURCE: discard alike, the chain verifies, and a backup taken afterwards restores', () => {
  const w = world('au');
  must(w.call('discard_testmandant', { planId: w.planId, confirmed: true, idempotencyKey: 'au-d' }), 'discard');
  assert.deepEqual(deletionRows(w.db, w.fx.workspaceId), [
    { entity_kind: 'migration_plan', entity_id: w.planId, action: 'testmandant_deleted_by_discard', actor: 'studio' },
  ]);
  assert.equal(must(w.call('get_audit_log', {}), 'get_audit_log').chainVerified, true);
  // The row names no foreign workspace id, so the source's backups still restore.
  restoreBeside(w, backupOf(w, 'au-bkp'), 'Danach GmbH', 'au-rst');
  w.fx.deps.store.close();
});

// --- 5. The orphan exit ----------------------------------------------------------------------------

test('the orphan exit: a sandbox no plan links is discarded by naming it; a linked one and a live one refuse', () => {
  const w = world('or');
  const orphan = (workspaceId, input) => getAction('discard_orphan_testmandant').run({ ...w.fx.deps, actor: 'studio' }, { workspaceId, ...input });
  refuse(orphan(w.sandboxId, { confirmed: true, idempotencyKey: 'or-1' }), 'testmandant_linked', 'a sandbox a plan still links');
  refuse(orphan(w.fx.workspaceId, { confirmed: true, idempotencyKey: 'or-2' }), 'not_a_testmandant', 'the live source itself');
  w.db.prepare('UPDATE migration_plan SET testmandant_workspace_id = NULL WHERE id = ?').run(w.planId);
  refuse(orphan(w.sandboxId, { idempotencyKey: 'or-3' }), 'needs_confirmation', 'unconfirmed');
  const drafted = handleRest('discard_orphan_testmandant', { workspaceId: w.sandboxId, confirmed: true, idempotencyKey: 'or-ag' }, { ...w.fx.deps, actor: 'agent' }).body;
  assert.deepEqual([drafted.drafted, drafted.dialCapability], [true, 'erase'], JSON.stringify(drafted));
  assert.equal(exists(w.db, w.sandboxId), true, 'the agent only proposes');
  const res = must(orphan(w.sandboxId, { confirmed: true, idempotencyKey: 'or-4' }), 'orphan discard');
  assert.equal(res.discardedWorkspaceId, w.sandboxId);
  assert.equal(exists(w.db, w.sandboxId), false);
  assert.equal(exists(w.db, w.fx.workspaceId), true, 'the source books are untouched');
  // A retry of the completed discard replays it, although the workspace is gone (critic finding 1a).
  assert.deepEqual(orphan(w.sandboxId, { confirmed: true, idempotencyKey: 'or-4' }), res, 'the retry replays');
  w.fx.deps.store.close();
});

test('the orphan exit\'s memo is scoped per workspace: a second orphan discarded with the SAME key is deleted, not answered with the first one\'s result', () => {
  const w = world('oc');
  const orphan = (workspaceId, input) => getAction('discard_orphan_testmandant').run({ ...w.fx.deps, actor: 'studio' }, { workspaceId, ...input });
  // A second plan and sandbox, both orphaned.
  const plan2 = must(w.call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: 'oc-plan2' }), 'plan2').planId;
  const sandbox2 = must(w.call('migration_create_testmandant', { planId: plan2, idempotencyKey: 'oc-t2' }), 't2').workspaceId;
  w.db.prepare('UPDATE migration_plan SET testmandant_workspace_id = NULL').run();
  const first = must(orphan(w.sandboxId, { confirmed: true, idempotencyKey: 'same-key' }), 'first orphan');
  const second = must(orphan(sandbox2, { confirmed: true, idempotencyKey: 'same-key' }), 'second orphan');
  assert.equal(first.discardedWorkspaceId, w.sandboxId);
  assert.equal(second.discardedWorkspaceId, sandbox2, 'its own result, not the first tenant\'s');
  assert.equal(exists(w.db, sandbox2), false, 'and its own sandbox is really gone');
  // A workspace that does not exist and was never discarded under this key is refused, not replayed.
  refuse(orphan('ws_nie', { confirmed: true, idempotencyKey: 'same-key' }), 'workspace_not_found', 'an unknown workspace');
  w.fx.deps.store.close();
});

test('discard_testmandant needs its planId again: the orphan form moved to its own verb', () => {
  const w = world('np');
  refuse(w.call('discard_testmandant', { confirmed: true, idempotencyKey: 'np-1' }, w.sandboxId), 'invalid_input', 'no planId');
  assert.equal(exists(w.db, w.sandboxId), true);
  w.fx.deps.store.close();
});

// --- 6. env_copy re-points, then sweeps --------------------------------------------------------------

const AT = '2026-10-11T00:00:00.000Z';

/** A source environment: a workspace, a plan, and its Testmandant, created through the real verbs. */
function migrationSeeder(path) {
  const store = new SqliteStore({ location: path });
  try {
    const deps = { store, clock: fixedClock(AT), ids: systemIdGen, actor: 'seed' };
    const parent = must(getAction('create_workspace').run(deps, { name: 'Quelle AG', idempotencyKey: 'seed-ws' }), 'seed ws').workspaceId;
    const planId = must(
      getAction('migration_create_plan').run(deps, { workspaceId: parent, sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: 'seed-plan' }),
      'seed plan',
    ).planId;
    must(getAction('migration_create_testmandant').run(deps, { workspaceId: parent, planId, idempotencyKey: 'seed-t' }), 'seed testmandant');
    must(
      getAction('migration_set_scope').run(deps, { workspaceId: parent, planId, classes: [{ dataClass: 'contacts', include: true }], idempotencyKey: 'seed-scope' }),
      'seed scope',
    );
    // Mid-trial with a checked, approved step, so the sweep's trial reset is visible.
    store.db.prepare("UPDATE migration_plan SET status = 'trial' WHERE id = ?").run(planId);
    store.db.prepare("UPDATE migration_step SET status = 'checked', last_check_id = 'chk_trial' WHERE plan_id = ?").run(planId);
    approveSteps(store.db, planId);
  } finally {
    store.close();
  }
}

function landscape() {
  const dir = mkdtempSync(join(tmpdir(), 'tm-envcopy-'));
  const deps = {
    supportDir: dir,
    environmentsRoot: join(dir, 'environments'),
    mainDbPath: join(dir, 'main', 'till.db'),
    actor: 'owner',
    now: () => AT,
    seeders: { migration: migrationSeeder, minimal: (p) => new SqliteStore({ location: p }).close() },
    ids: systemIdGen,
    clock: fixedClock(AT),
  };
  must(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'migration', tierRank: 250, confirmed: true }), 'source env');
  must(envCreate(deps, { name: 'dst', policy: 'synthetic', seed: 'minimal', tierRank: 40, confirmed: true }), 'target env');
  const srcPath = join(dir, 'environments', 'src', 'till.db');
  const dstPath = join(dir, 'environments', 'dst', 'till.db');
  const read = (path, fn) => {
    const s = new SqliteStore({ location: path });
    try {
      return fn(s);
    } finally {
      s.close();
    }
  };
  const src = read(srcPath, (s) => ({
    parent: s.db.prepare("SELECT id FROM workspace WHERE kind = 'live'").get().id,
    sandbox: s.db.prepare("SELECT id FROM workspace WHERE kind = 'sandbox'").get().id,
    plan: s.db.prepare('SELECT id, testmandant_workspace_id AS link FROM migration_plan').get(),
  }));
  assert.equal(src.plan.link, src.sandbox, 'the precondition: the source plan links its sandbox');
  return { dir, deps, srcPath, dstPath, read, src };
}

test('env_copy instance: the copied plan points at the COPIED sandbox, and a discard in the target leaves the source untouched', () => {
  const l = landscape();
  try {
    must(envCopy(l.deps, { source: 'src', target: 'dst', scope: 'instance', sanitize: 'raw', confirmed: true }), 'instance copy');
    l.read(l.dstPath, (s) => {
      const parent = s.db.prepare("SELECT id FROM workspace WHERE kind = 'live'").get().id;
      const sandbox = s.db.prepare("SELECT id FROM workspace WHERE kind = 'sandbox'").get().id;
      const plan = planOf(s.db, parent);
      assert.deepEqual([plan.link, plan.status], [sandbox, 'trial'], 'the copied plan names the copied sandbox, still mid-trial');
      assert.equal(approvalsOf(s.db, plan.id), 1, 'its approval travels with the trial it belongs to');
      assert.notEqual(sandbox, l.src.sandbox);
      const deps = { store: s, clock: fixedClock(AT), ids: systemIdGen, actor: 'studio' };
      must(getAction('discard_testmandant').run(deps, { workspaceId: parent, planId: plan.id, confirmed: true, idempotencyKey: 'ec-d' }), 'target discard');
      assert.equal(exists(s.db, sandbox), false, 'the target\'s sandbox is gone');
    });
    l.read(l.srcPath, (s) => {
      assert.equal(exists(s.db, l.src.sandbox), true, 'the source sandbox survives');
      assert.equal(planOf(s.db, l.src.parent).link, l.src.sandbox);
    });
  } finally {
    rmSync(l.dir, { recursive: true, force: true });
  }
});

test('env_copy of the parent mandate alone: the copied plan\'s link is swept to NULL (it would name the source instance)', () => {
  const l = landscape();
  try {
    must(envCopy(l.deps, { source: 'src', target: 'dst', scope: `mandate:${l.src.parent}`, sanitize: 'raw', confirmed: true }), 'parent-only copy');
    l.read(l.dstPath, (s) => {
      const plans = s.db.prepare('SELECT id, status, testmandant_workspace_id AS link FROM migration_plan').all();
      assert.deepEqual(plans.map((p) => [p.status, p.link]), [['planned', null]]);
      assert.deepEqual(stepsOf(s.db, plans[0].id).map((x) => x.status), ['mapped']);
      assert.equal(approvalsOf(s.db, plans[0].id), 0, 'the swept step loses its approval');
      assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM workspace WHERE kind = 'sandbox'").get().n, 0);
    });
  } finally {
    rmSync(l.dir, { recursive: true, force: true });
  }
});

test('env_copy of the sandbox mandate alone: it lands as an orphan no plan links, and the orphan exit discards it', () => {
  const l = landscape();
  try {
    must(envCopy(l.deps, { source: 'src', target: 'dst', scope: `mandate:${l.src.sandbox}`, sanitize: 'raw', confirmed: true }), 'sandbox-only copy');
    l.read(l.dstPath, (s) => {
      const sandbox = s.db.prepare("SELECT id FROM workspace WHERE kind = 'sandbox'").get().id;
      assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM migration_plan WHERE testmandant_workspace_id = ?').get(sandbox).n, 0, 'no plan links it');
      const deps = { store: s, clock: fixedClock(AT), ids: systemIdGen, actor: 'studio' };
      must(getAction('discard_orphan_testmandant').run(deps, { workspaceId: sandbox, confirmed: true, idempotencyKey: 'eo-d' }), 'orphan discard');
      assert.equal(exists(s.db, sandbox), false);
    });
    l.read(l.srcPath, (s) => assert.equal(exists(s.db, l.src.sandbox), true, 'the source sandbox survives'));
  } finally {
    rmSync(l.dir, { recursive: true, force: true });
  }
});

test('env_copy of LEGACY shared books, mandate by mandate in an adverse order: only the owner\'s link travels, so no copy-of-copy can own the target sandbox', () => {
  const l = landscape();
  try {
    // Make the source legacy: a second workspace whose plan was hand-linked to the sandbox (a copy
    // restored before the fix). It has no creation receipt.
    const copyWs = l.read(l.srcPath, (s) => {
      const deps = { store: s, clock: fixedClock(AT), ids: systemIdGen, actor: 'seed' };
      const ws = must(getAction('create_workspace').run(deps, { name: 'Kopie AG', idempotencyKey: 'lg-ws' }), 'copy ws').workspaceId;
      const planId = must(
        getAction('migration_create_plan').run(deps, { workspaceId: ws, sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: 'lg-plan' }),
        'copy plan',
      ).planId;
      s.db.prepare("UPDATE migration_plan SET testmandant_workspace_id = ?, status = 'trial' WHERE id = ?").run(l.src.sandbox, planId);
      return ws;
    });
    // The sandbox first, then the COPY, then the original: the copy lands with the lower rowid.
    for (const ws of [l.src.sandbox, copyWs, l.src.parent]) {
      must(envCopy(l.deps, { source: 'src', target: 'dst', scope: `mandate:${ws}`, sanitize: 'raw', confirmed: true }), `mandate copy ${ws}`);
    }
    l.read(l.dstPath, (s) => {
      const sandbox = s.db.prepare("SELECT id FROM workspace WHERE kind = 'sandbox'").get().id;
      const byName = (name) => planOf(s.db, s.db.prepare('SELECT id FROM workspace WHERE name = ?').get(name).id);
      assert.equal(byName('Kopie AG').link, null, 'the legacy copy\'s link did not travel');
      assert.equal(byName('Kopie AG').status, 'planned');
      assert.equal(byName('Quelle AG').link, sandbox, 'the owner\'s link was re-pointed at the copied sandbox');
    });
    l.read(l.srcPath, (s) => assert.equal(planOf(s.db, copyWs).link, l.src.sandbox, 'the source itself is never changed'));
  } finally {
    rmSync(l.dir, { recursive: true, force: true });
  }
});
