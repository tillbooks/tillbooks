/**
 * G18 R1 + R2: the two money-path cutover-gap remediations, proven by measurement.
 *
 * R1, the backup dead gate. `migration_plan.backup_ref` finally has a writer: `create_backup` with a
 * `planId` links the backup to the plan, but ONLY when the plan has reached `planned` and lives in
 * this workspace. The assertions below bite in BOTH directions (a pre-`planned` backup does not
 * satisfy the leg) and on the tenant fence (a planId in another workspace refuses).
 *
 * R2, the go-live VAT freeze. At promotion every VAT period WHOLLY before the Übernahmestichtag is
 * marked filed (A07) and hard-locked (A03), delegated entirely to those verbs, inside the promotion
 * transaction. The Stichtag's own period stays UNSEALED (the opening entry lives there). The freeze
 * is idempotent and a no-op when no VAT method is configured.
 *
 * MONEY-PATH NOTE (CLAUDE.md): promotion is the least-reversible act in the product and the freeze
 * touches a filed statutory figure. Drafted by the capability author; the non-author critic must
 * confirm these bite before the branch lands.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
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

function world(seed, actor = 'studio') {
  const deps = freshDeps();
  deps.actor = actor;
  // Each world gets its own backup directory so artifact ids never collide across tests on disk.
  deps.backupDir = mkdtempSync(join(tmpdir(), `till-g18-${seed}-`));
  const { workspaceId } = mintWorkspace(deps, 'Quelle GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, wid: workspaceId, call };
}

/** A plan that has reached `planned` (one included money-path class scoped). */
function plannedPlan(call, seed) {
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: `${seed}-plan` }), 'plan').planId;
  must(call('migration_set_scope', { planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: `${seed}-scope` }), 'scope');
  return planId;
}

const planStatus = (deps, planId) => deps.store.db.prepare('SELECT status FROM migration_plan WHERE id = ?').get(planId)?.status;
const backupRef = (deps, planId) => deps.store.db.prepare('SELECT backup_ref FROM migration_plan WHERE id = ?').get(planId)?.backup_ref;

// --- R1: the backup link ------------------------------------------------------------------------

test('R1: create_backup with a planId writes backup_ref and satisfies the readiness backup leg', () => {
  const { deps, call } = world('r1a');
  const planId = plannedPlan(call, 'r1a');
  assert.equal(planStatus(deps, planId), 'planned');
  assert.equal(backupRef(deps, planId), null, 'no backup_ref before the linked backup');

  // Before the backup: a money-path plan blocks readiness on backup_required.
  const before = must(call('migration_readiness', { planId }), 'readiness before');
  assert.equal(before.backupOnRecord, false);
  assert.ok(before.blocking.some((b) => b.item === 'backup_required'), 'backup is a blocking item before the backup');

  const backup = must(call('create_backup', { planId, idempotencyKey: 'r1a-bk' }), 'create_backup');
  assert.equal(backup.planLink.linked, true, `the backup linked to the plan: ${JSON.stringify(backup.planLink)}`);

  const ref = JSON.parse(backupRef(deps, planId));
  assert.equal(ref.backupId, backup.backupId, 'backup_ref names the backup');
  assert.ok(typeof ref.sha256 === 'string' && ref.sha256.length > 0, 'backup_ref carries the sha256');

  const after = must(call('migration_readiness', { planId }), 'readiness after');
  assert.equal(after.backupOnRecord, true, 'the backup is now on record');
  assert.ok(!after.blocking.some((b) => b.item === 'backup_required'), 'backup no longer blocks');
});

test('R1: a backup taken while the plan is still draft does NOT satisfy the leg', () => {
  const { deps, call } = world('r1b');
  // A draft plan: created but never scoped, so status stays `draft`.
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2020-01-01', localePack: 'ch', idempotencyKey: 'r1b-plan' }), 'plan').planId;
  assert.equal(planStatus(deps, planId), 'draft');

  const backup = must(call('create_backup', { planId, idempotencyKey: 'r1b-bk' }), 'create_backup');
  assert.equal(backup.planLink.linked, false, 'a draft plan does not accept the link');
  assert.equal(backup.planLink.reason, 'plan_not_planned');
  assert.equal(backupRef(deps, planId), null, 'backup_ref stays null for a draft-time backup');
});

test('R1 (§H-TENANT): a planId in ANOTHER workspace refuses and writes no backup', () => {
  const a = world('r1c-a');
  const b = world('r1c-b');
  const otherPlanId = plannedPlan(b.call, 'r1c-b');

  // Workspace A tries to back up against workspace B's plan: refused, and no backup file is minted.
  refuse(a.call('create_backup', { planId: otherPlanId, idempotencyKey: 'r1c-x' }), 'not_found', 'cross-workspace backup link');
  const backupsInA = a.deps.store.db.prepare('SELECT COUNT(*) AS n FROM backups WHERE workspace_id = ?').get(a.wid).n;
  assert.equal(backupsInA, 0, 'the refused call minted no backup row in A');
  // B's plan is untouched (its backup_ref is still null).
  assert.equal(backupRef(b.deps, otherPlanId), null, "the other workspace's plan is untouched");
});

test('R1: linking is idempotent per key (a replay mints no second backup)', () => {
  const { deps, call } = world('r1d');
  const planId = plannedPlan(call, 'r1d');
  const first = must(call('create_backup', { planId, idempotencyKey: 'r1d-bk' }), 'first');
  const second = must(call('create_backup', { planId, idempotencyKey: 'r1d-bk' }), 'replay');
  assert.equal(second.backupId, first.backupId, 'the replay returns the first backup');
  const count = deps.store.db.prepare('SELECT COUNT(*) AS n FROM backups').get().n;
  assert.equal(count, 1, 'exactly one backup row exists after the replay');
});

// --- R2: the go-live VAT freeze -----------------------------------------------------------------

/** A promotable Testmandant with a real profile and (optionally) a configured VAT method. */
function promotableTestmandant(call, seed, { vat } = {}) {
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2024-07-01', localePack: 'ch', idempotencyKey: `${seed}-plan` }), 'plan').planId;
  const t = must(call('migration_create_testmandant', { planId, idempotencyKey: `${seed}-t` }), 'create_t');
  const tId = t.workspaceId;
  must(call('update_company_profile', { workspaceId: tId, legalForm: 'gmbh', uid: 'CHE-116.281.271', mwstNo: 'CHE-116.281.271 MWST' }), 'profile');
  if (vat) {
    must(call('vat_configure', {
      workspaceId: tId,
      method: 'effektiv',
      timing: 'soll',
      registered: true,
      asOf: '2023-01-01',
      vatNumber: 'CHE-116.281.271 MWST',
      idempotencyKey: `${seed}-cfg`,
    }), 'vat_configure');
  }
  const name = must(call('get_company_profile', { workspaceId: tId }), 'get_profile').profile.name;
  return { planId, tId, name };
}

const vatFiledMonths = (deps, wid) =>
  new Set(deps.store.db.prepare("SELECT period FROM period_lock WHERE workspace_id = ? AND kind = 'hard' AND reason = 'vat_filed'").all(wid).map((r) => r.period));

test('R2: promotion freezes every VAT period wholly before the Stichtag and leaves the Stichtag period unsealed', () => {
  const { deps, call } = world('r2a');
  const { planId, tId, name } = promotableTestmandant(call, 'r2a', { vat: true });

  const promoted = must(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'r2a-go' }), 'promote');
  assert.ok(Array.isArray(promoted.frozenPeriods), 'the result reports the frozen periods');

  // Stichtag 2024-07-01, effektiv method -> quarters. Wholly before July 2024: all of 2023 and
  // 2024-Q1 (Jan-Mar) + 2024-Q2 (Apr-Jun). NOT 2024-Q3 (Jul-Sep), which contains the Stichtag month.
  const frozen = new Set(promoted.frozenPeriods);
  for (const label of ['2023-Q1', '2023-Q2', '2023-Q3', '2023-Q4', '2024-Q1', '2024-Q2']) {
    assert.ok(frozen.has(label), `${label} is wholly before the Stichtag and must be frozen`);
  }
  assert.ok(!frozen.has('2024-Q3'), '2024-Q3 contains the Stichtag month and must NOT be frozen');
  assert.ok(!frozen.has('2024-Q4'), '2024-Q4 is after the Stichtag and must NOT be frozen');

  // The freeze sealed the months via A03 hard locks with the vat_filed reason, in the LIVE books.
  const sealed = vatFiledMonths(deps, tId);
  assert.ok(sealed.has('2024-06'), 'June 2024 (in a period wholly before the Stichtag) is sealed');
  assert.ok(!sealed.has('2024-07'), 'the Stichtag month July 2024 is NOT sealed (the opening entry lives there)');
  assert.ok(!sealed.has('2024-08'), 'a month after the Stichtag is not sealed');

  // A07 is the writer: the sealed periods report `filed:true` through vat_periods.
  const periods2024 = must(call('vat_periods', { workspaceId: tId, year: '2024' }), 'periods 2024').periods;
  const q2 = periods2024.find((p) => p.label === '2024-Q2');
  const q3 = periods2024.find((p) => p.label === '2024-Q3');
  assert.equal(q2.filed, true, '2024-Q2 reads filed after the freeze');
  assert.equal(q3.filed, false, '2024-Q3 (the Stichtag quarter) reads NOT filed');
});

test('R2: the freeze is idempotent: a second promotion adds no second lock', () => {
  const { deps, call } = world('r2b');
  const { planId, tId, name } = promotableTestmandant(call, 'r2b', { vat: true });
  must(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'r2b-go' }), 'promote');
  const after1 = deps.store.db.prepare("SELECT COUNT(*) AS n FROM period_lock WHERE workspace_id = ? AND reason = 'vat_filed'").get(tId).n;
  assert.ok(after1 > 0, 'the first promotion sealed some months');
  // A second promotion (a fresh key) hits the already-live no-op path and seals nothing further.
  const again = must(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'r2b-go2' }), 're-promote');
  assert.equal(again.alreadyLive, true, 'the second promotion is an already-live no-op');
  const after2 = deps.store.db.prepare("SELECT COUNT(*) AS n FROM period_lock WHERE workspace_id = ? AND reason = 'vat_filed'").get(tId).n;
  assert.equal(after2, after1, 'no second lock row was minted');
});

test('R2: a workspace with no VAT method configured freezes nothing (clean no-op)', () => {
  const { deps, call } = world('r2c');
  const { planId, tId, name } = promotableTestmandant(call, 'r2c', { vat: false });
  const promoted = must(call('go_productive', { planId, confirmedName: name, idempotencyKey: 'r2c-go' }), 'promote');
  assert.deepEqual(promoted.frozenPeriods, [], 'no VAT method -> no periods frozen');
  const sealed = vatFiledMonths(deps, tId);
  assert.equal(sealed.size, 0, 'no vat_filed locks were written');
});
