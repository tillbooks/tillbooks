/**
 * G18 R5: the three re-scoped classes commit through their OWNING verbs (P3), never a second writer.
 *
 *  - vat_history   -> A07 vat_mark_filed (which posts NOTHING): each historical period is sealed.
 *  - documents     -> E00 files_link: each source file is linked to the plan as a retained Beleg.
 *  - bank_statements -> A20 import_camt (which posts no journal): delegated, target resolved by IBAN.
 *
 * The three also flip firstScope true, so PHASE4 A3 (scope) and B5 (commit) are executable. The
 * money-path arm (vat_history) runs behind the full six-leg gate and delegates entirely to A07.
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

function world(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  deps.backupDir = mkdtempSync(join(tmpdir(), `till-g18r5-${seed}-`));
  const { workspaceId } = mintWorkspace(deps, 'Übernahme GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, wid: workspaceId, call };
}

function uploadCsv(call, seed, csv, mime = 'text/csv', filename = `${seed}.csv`) {
  return must(call('files_upload', { title: `Import ${seed}`, filename, mime, contentBase64: Buffer.from(csv).toString('base64'), idempotencyKey: `${seed}-up` }), 'files_upload').file.id;
}

// --- firstScope: the three classes are scopeable (PHASE4 A3) -------------------------------------

test('R5: vat_history, documents and bank_statements are in first scope and get steps', () => {
  const { call } = world('r5fs');
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2024-01-01', localePack: 'ch', idempotencyKey: 'r5fs-plan' }), 'plan').planId;
  const scope = must(call('migration_set_scope', { planId, classes: [
    { dataClass: 'vat_history', include: true },
    { dataClass: 'documents', include: true },
    { dataClass: 'bank_statements', include: true },
  ], idempotencyKey: 'r5fs-scope' }), 'scope');
  const scoped = new Set(scope.steps.map((s) => s.dataClass));
  assert.ok(scoped.has('vat_history'), 'vat_history gets a step');
  assert.ok(scoped.has('documents'), 'documents gets a step');
  assert.ok(scoped.has('bank_statements'), 'bank_statements gets a step');
  assert.equal(scope.unavailable.length, 0, 'none of the three is reported unavailable now');
});

// --- vat_history money-path commit through A07 --------------------------------------------------

/** Drive a money-path step through the full six-leg gate to committed. */
function commitMoneyPath(call, planId, stepId, seed) {
  must(call('migration_trial_load_step', { planId, stepId, idempotencyKey: `${seed}-trial` }), 'trial');
  // First commit attempt: money-path, no approval yet -> the P8 staged shape carrying the checkHash.
  const staged = must(call('migration_commit_step', { planId, stepId, idempotencyKey: `${seed}-c1` }), 'staged commit');
  assert.equal(staged.staged, true, `expected the staged shape: ${JSON.stringify(staged)}`);
  must(call('migration_record_approval', { planId, stepId, checkHash: staged.checkHash, idempotencyKey: `${seed}-appr` }), 'approval');
  // The backup on record (R1): create_backup linked to the plan (plan is `live`? no, `planned`/`trial`).
  must(call('create_backup', { planId, idempotencyKey: `${seed}-bk` }), 'backup');
  return must(call('migration_commit_step', { planId, stepId, idempotencyKey: `${seed}-c2` }), 'commit');
}

test('R5: vat_history seals each historical period through A07 and posts no journal entry', () => {
  const { deps, call, wid } = world('r5vh');
  const fileId = uploadCsv(call, 'r5vh', 'period\n2023-Q1\n2023-Q2\n2023-Q3\n');
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2024-01-01', localePack: 'ch', idempotencyKey: 'r5vh-plan' }), 'plan').planId;
  must(call('migration_discover_source', { fileIds: [fileId], planId }), 'discover');
  const scope = must(call('migration_set_scope', { planId, classes: [{ dataClass: 'vat_history', include: true }], idempotencyKey: 'r5vh-scope' }), 'scope');
  const stepId = scope.steps.find((s) => s.dataClass === 'vat_history').stepId;

  const journalBefore = deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(wid).n;
  const committed = commitMoneyPath(call, planId, stepId, 'r5vh');
  assert.deepEqual([...committed.created].sort(), ['2023-Q1', '2023-Q2', '2023-Q3'], 'every period was filed');

  // A07 posts NOTHING: no journal entry was minted by the vat_history commit.
  const journalAfter = deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(wid).n;
  assert.equal(journalAfter, journalBefore, 'vat_history opened no posting path');

  // Each period is now hard-locked with the vat_filed reason, via A03, in this workspace.
  const sealed = new Set(deps.store.db.prepare("SELECT period FROM period_lock WHERE workspace_id = ? AND reason = 'vat_filed'").all(wid).map((r) => r.period));
  for (const m of ['2023-01', '2023-06', '2023-09']) assert.ok(sealed.has(m), `${m} sealed by the filing`);

  // Idempotent on ROWS: a same-key replay of the commit writes no second lock.
  const before = deps.store.db.prepare("SELECT COUNT(*) AS n FROM period_lock WHERE workspace_id = ?").get(wid).n;
  must(call('migration_commit_step', { planId, stepId, idempotencyKey: 'r5vh-c2' }), 'replay');
  const after = deps.store.db.prepare("SELECT COUNT(*) AS n FROM period_lock WHERE workspace_id = ?").get(wid).n;
  assert.equal(after, before, 'a replay minted no second lock');
});

// --- documents commit through E00 files_link ----------------------------------------------------

test('R5: documents links each source file to the plan through E00 files_link', () => {
  const { deps, call } = world('r5doc');
  // A CSV file stands in for a document blob here (discovery links CSV files as source files); the
  // arm links whatever source files the documents step carries, delegating to files_link.
  const fileId = uploadCsv(call, 'r5doc', 'a,b\n1,2\n');
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2024-01-01', localePack: 'ch', idempotencyKey: 'r5doc-plan' }), 'plan').planId;
  must(call('migration_discover_source', { fileIds: [fileId], planId }), 'discover');
  // The generic adapter does not classify blobs as `documents` (that is the US-G18.3 zip/adapter
  // path, not built): simulate that classification so the arm's delegation to files_link is exercised.
  deps.store.db.prepare("UPDATE migration_source_file SET data_classes = '[\"documents\"]' WHERE plan_id = ?").run(planId);
  const scope = must(call('migration_set_scope', { planId, classes: [{ dataClass: 'documents', include: true }], idempotencyKey: 'r5doc-scope' }), 'scope');
  const stepId = scope.steps.find((s) => s.dataClass === 'documents').stepId;
  must(call('migration_trial_load_step', { planId, stepId, idempotencyKey: 'r5doc-trial' }), 'trial');
  const committed = must(call('migration_commit_step', { planId, stepId, idempotencyKey: 'r5doc-commit' }), 'commit');
  assert.ok(committed.created.length >= 1, `at least one file linked: ${JSON.stringify(committed)}`);

  // The link is real: the stored file now carries the migration_plan entity link (E00 files_link).
  const links = deps.store.db.prepare("SELECT COUNT(*) AS n FROM stored_file WHERE entity_kind = 'migration_plan' AND entity_id = ?").get(planId).n;
  assert.ok(links >= 1, 'the source file is linked to the plan');
});

// --- bank_statements delegates to A20 (no journal, target by IBAN) -------------------------------

test('R5: bank_statements delegates to import_camt and fails honestly when no account matches', () => {
  const { call } = world('r5bs');
  // A camt-shaped file with no registered bank account: the arm resolves nothing and fails honestly,
  // never guessing a target or opening a posting path.
  const fileId = uploadCsv(call, 'r5bs', '<Document><BkToCstmrStmt></BkToCstmrStmt></Document>', 'application/xml', 'stmt.xml');
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2024-01-01', localePack: 'ch', idempotencyKey: 'r5bs-plan' }), 'plan').planId;
  must(call('migration_discover_source', { fileIds: [fileId], planId }), 'discover');
  const scope = must(call('migration_set_scope', { planId, classes: [{ dataClass: 'bank_statements', include: true }], idempotencyKey: 'r5bs-scope' }), 'scope');
  const stepId = scope.steps.find((s) => s.dataClass === 'bank_statements').stepId;
  const committed = commitMoneyPath(call, planId, stepId, 'r5bs');
  // With no registered account (and an unparseable camt), the file fails rather than importing.
  assert.ok(committed.failed.length >= 1 || committed.created.length === 0, `no phantom import: ${JSON.stringify(committed)}`);
});
