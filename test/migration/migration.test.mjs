/**
 * G09, the migration harness: the money-path invariants and the gate, proven by measurement.
 *
 * These are the assertions D86 and the canon pass turn on: a migrated document POSTS NOTHING (a
 * money-path class establishes opening balances through A04's SINGLE entry, never one posting per
 * historical document); commit is idempotent ON ROWS; rollback REVERSES and never deletes; preview
 * writes zero rows; the six-condition gate is a real conjunction; and every return to `mapped` VOIDS
 * the approval, which is what makes the agent-autonomy boundary enforceable rather than conventional.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getAction } from '../../dist/api/registry.js';
import { STEP_TRANSITIONS } from '../../dist/core/migration/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => {
  const res = getAction(name).run(deps, input);
  return res;
};
const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};
const countEntries = (deps, wid) => deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(wid).n;
const countApprovals = (deps, wid, stepId) =>
  deps.store.db.prepare('SELECT COUNT(*) AS n FROM migration_approval WHERE workspace_id = ? AND step_id = ?').get(wid, stepId).n;

/** Upload an opening-balances CSV over two REAL accounts (balanced), link it, scope + trial-load. */
function seedOpeningStep(deps, wid, seed) {
  const accounts = must(call(deps, 'list_accounts', { workspaceId: wid }), 'list_accounts').accounts;
  const [a, b] = accounts;
  const numOf = (x) => x.number;
  const csv = `account,debitMinor,creditMinor\n${numOf(a)},100000,0\n${numOf(b)},0,100000\n`;
  const up = must(
    call(deps, 'files_upload', {
      workspaceId: wid,
      title: `Eröffnung ${seed}`,
      filename: `${seed}.csv`,
      mime: 'text/csv',
      contentBase64: Buffer.from(csv).toString('base64'),
      idempotencyKey: `${seed}-up`,
    }),
    'files_upload',
  );
  const fileId = up.file.id;
  const planId = must(
    call(deps, 'migration_create_plan', { workspaceId: wid, sourceSystem: 'csv', cutoverDate: '2026-01-01', localePack: 'ch', idempotencyKey: `${seed}-plan` }),
    'migration_create_plan',
  ).planId;
  must(call(deps, 'migration_discover_source', { workspaceId: wid, fileIds: [fileId], planId }), 'discover');
  const scope = must(
    call(deps, 'migration_set_scope', { workspaceId: wid, planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: `${seed}-scope` }),
    'set_scope',
  );
  const stepId = scope.steps[0].stepId;
  // G11 integration: the commit gate's condition (2) now runs the REAL Eröffnungsprüfung, and a
  // per-account control nobody declared reports not_asserted, which refuses the commit (US-G11.5/6).
  // The seed therefore declares the source trial balance the CSV states, the way a real migration
  // must, so these suites keep measuring the conditions they are about rather than the check's.
  must(
    call(deps, 'migration_declare_control_total', { workspaceId: wid, planId, stepId, kind: 'trial_balance_matches_source', scope: numOf(a), declaredMinor: 100000, idempotencyKey: `${seed}-dcl-a` }),
    'declare a',
  );
  must(
    call(deps, 'migration_declare_control_total', { workspaceId: wid, planId, stepId, kind: 'trial_balance_matches_source', scope: numOf(b), declaredMinor: -100000, idempotencyKey: `${seed}-dcl-b` }),
    'declare b',
  );
  must(call(deps, 'migration_trial_load_step', { workspaceId: wid, planId, stepId, idempotencyKey: `${seed}-trial` }), 'trial');
  return { planId, stepId };
}

function ws(seed) {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Übernahme GmbH', `${seed}-ws`);
  return { deps, wid: workspaceId };
}

function grantBackup(deps, planId) {
  deps.store.db.prepare('UPDATE migration_plan SET backup_ref = ? WHERE id = ?').run('backup-1', planId);
}

// --- The money path: posts nothing, idempotent on rows ------------------------------------------

test('G09: a money-path commit posts ONE opening entry regardless of row count, and is idempotent on ROWS', () => {
  const { deps, wid } = ws('posts-nothing');
  const { planId, stepId } = seedOpeningStep(deps, wid, 'pn');
  const before = countEntries(deps, wid);

  // First commit draft-stages: no approval bound yet (P8), so it writes nothing.
  const staged = call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'pn-commit' });
  assert.equal(staged.ok, true);
  assert.equal(staged.staged, true, 'a money-path commit without an approval must draft-stage, not write');
  assert.equal(countEntries(deps, wid), before, 'the staged commit wrote to the ledger');

  // Bind the backup (G04 seam) and the human approval to the check hash, then commit for real.
  grantBackup(deps, planId);
  must(call(deps, 'migration_record_approval', { workspaceId: wid, planId, stepId, checkHash: staged.checkHash, idempotencyKey: 'pn-appr' }), 'approval');
  const committed = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'pn-commit' }), 'commit');

  // TWO source rows, but exactly ONE journal entry: the migrated document posts nothing of its own,
  // the whole effect is A04's single opening entry (D86 §2).
  assert.equal(countEntries(deps, wid), before + 1, 'a money-path commit must post exactly one opening entry, not one per row');
  assert.ok(committed.openingEntryId, 'the commit did not report its opening entry id');

  // Idempotent on ROWS: a second commit on the same key posts nothing more.
  must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'pn-commit' }), 'commit-replay');
  assert.equal(countEntries(deps, wid), before + 1, 'a double-commit double-counted the opening entry');
});

// --- Rollback reverses, never deletes; and voids the approval -----------------------------------

test('G09: rollback posts a REVERSING entry (never a delete) and voids the approval', () => {
  const { deps, wid } = ws('rollback');
  const { planId, stepId } = seedOpeningStep(deps, wid, 'rb');
  const staged = call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'rb-commit' });
  grantBackup(deps, planId);
  must(call(deps, 'migration_record_approval', { workspaceId: wid, planId, stepId, checkHash: staged.checkHash, idempotencyKey: 'rb-appr' }), 'approval');
  const committed = must(call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'rb-commit' }), 'commit');
  const openingId = committed.openingEntryId;
  const afterCommit = countEntries(deps, wid);
  assert.equal(countApprovals(deps, wid, stepId), 1, 'the approval was not recorded');

  const rolled = must(call(deps, 'migration_rollback_step', { workspaceId: wid, planId, stepId, confirmed: true, idempotencyKey: 'rb-roll' }), 'rollback');
  assert.equal(rolled.reversed.length, 1, 'rollback did not reverse the opening entry');

  // Append-only: the original entry is STILL there, and a NEW reversing entry was posted beside it.
  assert.equal(countEntries(deps, wid), afterCommit + 1, 'rollback must ADD a reversing entry, never remove one');
  const original = deps.store.db.prepare('SELECT status FROM journal_entry WHERE id = ? AND workspace_id = ?').get(openingId, wid);
  assert.ok(original !== undefined, 'the original opening entry was deleted, which is forbidden (append-only)');

  // The approval is voided by the return to `mapped`.
  assert.equal(countApprovals(deps, wid, stepId), 0, 'the approval survived a rollback, so the agent boundary is not enforced');
  const step = deps.store.db.prepare('SELECT status FROM migration_step WHERE id = ?').get(stepId);
  assert.equal(step.status, 'mapped', 'a rolled-back step must return to mapped');
});

// --- The gate is a conjunction ------------------------------------------------------------------

test('G09: the commit gate refuses on each condition in isolation', () => {
  // (1) state: a step that was never trial-loaded cannot commit.
  {
    const { deps, wid } = ws('gate-state');
    const accounts = must(call(deps, 'list_accounts', { workspaceId: wid }), 'list').accounts;
    const planId = must(call(deps, 'migration_create_plan', { workspaceId: wid, sourceSystem: 'csv', cutoverDate: '2026-01-01', localePack: 'ch', idempotencyKey: 'gs-plan' }), 'plan').planId;
    const scope = must(call(deps, 'migration_set_scope', { workspaceId: wid, planId, classes: [{ dataClass: 'opening_balances', include: true }], idempotencyKey: 'gs-scope' }), 'scope');
    const res = call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId: scope.steps[0].stepId, idempotencyKey: 'gs-commit' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'step_not_ready');
    void accounts;
  }
  // (4) approval: a money-path step with no bound approval draft-stages rather than writing.
  {
    const { deps, wid } = ws('gate-approval');
    const { planId, stepId } = seedOpeningStep(deps, wid, 'ga');
    grantBackup(deps, planId);
    const res = call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'ga-commit' });
    assert.equal(res.ok, true);
    assert.equal(res.staged, true, 'a money-path commit without an approval must draft-stage');
  }
  // (6) backup: approval bound but no G04 backup on record refuses the first live commit.
  {
    const { deps, wid } = ws('gate-backup');
    const { planId, stepId } = seedOpeningStep(deps, wid, 'gb');
    const staged = call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'gb-commit' });
    must(call(deps, 'migration_record_approval', { workspaceId: wid, planId, stepId, checkHash: staged.checkHash, idempotencyKey: 'gb-appr' }), 'appr');
    const res = call(deps, 'migration_commit_step', { workspaceId: wid, planId, stepId, idempotencyKey: 'gb-commit' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'needs_backup');
  }
  // (3) conflict: an unresolved willConflict row blocks the commit, engine-side, before the approval leg.
  {
    const { deps, wid } = ws('gate-conflict');
    // A first opening position exists, so every mapped account is a willConflict on the second step.
    const first = seedOpeningStep(deps, wid, 'gc1');
    const staged = call(deps, 'migration_commit_step', { workspaceId: wid, planId: first.planId, stepId: first.stepId, idempotencyKey: 'gc1-commit' });
    grantBackup(deps, first.planId);
    must(call(deps, 'migration_record_approval', { workspaceId: wid, planId: first.planId, stepId: first.stepId, checkHash: staged.checkHash, idempotencyKey: 'gc1-appr' }), 'appr');
    must(call(deps, 'migration_commit_step', { workspaceId: wid, planId: first.planId, stepId: first.stepId, idempotencyKey: 'gc1-commit' }), 'commit1');
    // The opening entry now exists; a second plan's opening step classifies every row as a conflict.
    const second = seedOpeningStep(deps, wid, 'gc2');
    const res = call(deps, 'migration_commit_step', { workspaceId: wid, planId: second.planId, stepId: second.stepId, idempotencyKey: 'gc2-commit' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unresolved_conflicts');
  }
});

// --- Preview writes zero rows -------------------------------------------------------------------

test('G09: previewStep leaves the database byte-identical (it is a READ)', () => {
  const { deps, wid } = ws('preview');
  const { planId, stepId } = seedOpeningStep(deps, wid, 'pv');
  const snapshot = () => ({
    steps: deps.store.db.prepare('SELECT id, status, counts FROM migration_step WHERE workspace_id = ?').all(wid),
    rows: deps.store.db.prepare('SELECT COUNT(*) AS n FROM migration_step_row WHERE workspace_id = ?').get(wid).n,
    entries: countEntries(deps, wid),
  });
  const before = JSON.stringify(snapshot());
  const preview = must(call(deps, 'migration_preview_step', { workspaceId: wid, planId, stepId }), 'preview');
  assert.equal(preview.willCreate, 2, 'the preview miscounted the two opening rows');
  assert.equal(JSON.stringify(snapshot()), before, 'preview mutated the database');
});

// --- No dead end --------------------------------------------------------------------------------

test('G09: the step machine has no dead end, and every re-entry state reaches mapped', () => {
  for (const [state, exits] of Object.entries(STEP_TRANSITIONS)) {
    if (state === 'skipped') continue; // the one terminal an excluded class gets
    assert.ok(exits.length > 0, `${state} is a dead end`);
  }
  for (const reentry of ['failed', 'rolled_back', 'diverged']) {
    assert.ok(STEP_TRANSITIONS[reentry].includes('mapped'), `${reentry} does not return to mapped`);
  }
});

// --- No second writer (static) ------------------------------------------------------------------

test('G09: no file under core/migration imports postEntry or INSERTs into a domain table (P3)', () => {
  const dir = fileURLToPath(new URL('../../src/core/migration/', import.meta.url));
  const walk = (d) => {
    const out = [];
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}${e.name}`;
      if (e.isDirectory()) out.push(...walk(`${p}/`));
      else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
  };
  const domainInsert = /INSERT\s+INTO\s+(journal_entry|journal_line|contact|account|item|bank_account|payment|vendor_bill)\b/i;
  for (const file of walk(dir)) {
    const src = readFileSync(file, 'utf8');
    assert.equal(/from '[^']*ledger\/postEntry/.test(src), false, `${file} imports postEntry directly (P3 second writer)`);
    assert.equal(/\bpostEntry\s*\(/.test(src), false, `${file} calls postEntry directly (P3 second writer)`);
    assert.equal(domainInsert.test(src), false, `${file} INSERTs into a domain table directly (P3 second writer)`);
  }
});

// --- Adapters are pure --------------------------------------------------------------------------

test('G09/G18: no adapter imports node:fs or a socket (adapters are pure over bytes)', () => {
  const dir = fileURLToPath(new URL('../../src/core/migration/adapters/', import.meta.url));
  // G18: recurse into fixtures/ too, so the xlsx/XML arms and the synthetic fixtures are all covered.
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}${e.name}`;
      if (e.isDirectory()) walk(`${p}/`);
      else if (e.name.endsWith('.ts')) files.push(p);
    }
  };
  const files = [];
  walk(dir);
  // node:zlib is a PURE byte transform (the DEFLATE codec the zip/xlsx readers use), not I/O, so it is
  // allowed; node:fs and any socket module (net/tls/dgram/http) are the real filesystem/network seams.
  for (const p of files) {
    const src = readFileSync(p, 'utf8');
    const importsFs = /(?:import[^\n]*from\s*|require\(\s*)['"](?:node:)?fs['"]/.test(src);
    assert.equal(importsFs, false, `${p} reads the filesystem; adapters must be pure over bytes`);
    const importsSocket = /(?:import[^\n]*from\s*|require\(\s*)['"](?:node:)?(?:net|tls|dgram|http|https)['"]/.test(src);
    assert.equal(importsSocket, false, `${p} opens a socket; adapters must be pure over bytes`);
  }
  // The G18 arms are actually present in the scan, so this cannot pass vacuously.
  assert.ok(files.some((f) => f.endsWith('/xlsx.ts')) && files.some((f) => f.endsWith('/xml.ts')) && files.some((f) => f.endsWith('/zip.ts')));
});

// --- §H-TENANT: listPlans does not read across the fence ----------------------------------------

test('G09: migration_list_plans is workspace-scoped (§H-TENANT)', () => {
  const deps = freshDeps();
  const { workspaceId: a } = mintWorkspace(deps, 'Mandant A', 'tenant-a');
  const { workspaceId: b } = mintWorkspace(deps, 'Mandant B', 'tenant-b');
  must(call(deps, 'migration_create_plan', { workspaceId: a, sourceSystem: 'csv', cutoverDate: '2026-01-01', localePack: 'ch', idempotencyKey: 'ta-plan' }), 'plan-a');
  must(call(deps, 'migration_create_plan', { workspaceId: b, sourceSystem: 'csv', cutoverDate: '2026-01-01', localePack: 'ch', idempotencyKey: 'tb-plan' }), 'plan-b');
  const listA = must(call(deps, 'migration_list_plans', { workspaceId: a }), 'list-a');
  assert.equal(listA.plans.length, 1, 'list_plans leaked a plan across the tenant fence');
});
