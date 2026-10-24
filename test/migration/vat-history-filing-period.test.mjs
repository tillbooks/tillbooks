/**
 * The migration vat_history step meets `not_a_filing_period` with a remedy (critic L-R2-2, 14.10.2026).
 *
 * The step seals the OLD system's filed periods through A07's `vat_mark_filed`. Since round 2 that verb
 * refuses a label that is not a filing period of the method governing that year. A migrated book that
 * is configured with TODAY's method and no dated history (one era, open from the start) therefore
 * refuses its old effektiv quarters when it files half-yearly under Saldo today. The refusal is right
 * (those years would also compute under the wrong method), but the step reported only the code. Each
 * failed row now carries the year's filing periods, the method, and the remedy: record the method
 * history with `vat_configure` and a dated `methodChange` first, then commit vat_history again.
 *
 * Synthetic workspaces in memory; no real data.
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

test('vat_history: an old effektiv quarter on a book that is Saldo today fails with the remedy, not just the code', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  deps.backupDir = mkdtempSync(join(tmpdir(), 'till-vh-fp-'));
  const { workspaceId } = mintWorkspace(deps, 'Übernahme GmbH', 'vhfp-ws');
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  must(call('vat_configure', { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 620 }], idempotencyKey: 'vhfp-cfg' }), 'configure');

  const csv = 'period\n2023-Q1\n2023-Q2\n';
  const fileId = must(call('files_upload', { title: 'MWST history', filename: 'vh.csv', mime: 'text/csv', contentBase64: Buffer.from(csv).toString('base64'), idempotencyKey: 'vhfp-up' }), 'upload').file.id;
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2024-01-01', localePack: 'ch', idempotencyKey: 'vhfp-plan' }), 'plan').planId;
  must(call('migration_discover_source', { fileIds: [fileId], planId }), 'discover');
  const scope = must(call('migration_set_scope', { planId, classes: [{ dataClass: 'vat_history', include: true }], idempotencyKey: 'vhfp-scope' }), 'scope');
  const stepId = scope.steps.find((s) => s.dataClass === 'vat_history').stepId;

  must(call('migration_trial_load_step', { planId, stepId, idempotencyKey: 'vhfp-trial' }), 'trial');
  const staged = must(call('migration_commit_step', { planId, stepId, idempotencyKey: 'vhfp-c1' }), 'staged');
  must(call('migration_record_approval', { planId, stepId, checkHash: staged.checkHash, idempotencyKey: 'vhfp-appr' }), 'approval');
  must(call('create_backup', { planId, idempotencyKey: 'vhfp-bk' }), 'backup');
  const committed = must(call('migration_commit_step', { planId, stepId, idempotencyKey: 'vhfp-c2' }), 'commit');

  assert.deepEqual(committed.created, [], 'nothing could be sealed');
  assert.equal(committed.failed.length, 2, JSON.stringify(committed));
  for (const f of committed.failed) {
    assert.equal(f.reason, 'not_a_filing_period', JSON.stringify(f));
    assert.equal(f.method, 'saldo');
    assert.deepEqual(f.filingPeriods, ['2023-H1', '2023-H2']);
    assert.match(f.hint, /vat_configure/, 'the remedy names the verb that records the history');
    assert.match(f.hint, /methodChange/, 'and the dated change it takes');
    assert.match(f.hint, /vat_history/, 'and says to commit this step again afterwards');
  }
  assert.ok(['2023-Q1', '2023-Q2'].every((p) => committed.failed.some((f) => f.period === p)), 'each failure names its period');
});
