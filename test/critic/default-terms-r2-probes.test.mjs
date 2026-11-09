/**
 * CRITIC PROBES, confirmation round (default-terms, D163 + owner pick "30 days for new"). Non-author.
 * Synthetic by construction: invented parties, amounts and dates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { updateCompanyProfile } from '../../dist/core/setup/index.js';
import { makeContext } from '../../dist/core/context.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const termsOf = (deps, ws) =>
  deps.store.db.prepare('SELECT default_payment_terms_days AS d FROM workspace WHERE id = ?').get(ws)?.d;

function run(deps, name, input) {
  const a = getAction(name);
  assert.ok(a, name);
  const r = a.run(deps, input);
  assert.equal(r.ok, true, `${name}: ${JSON.stringify(r).slice(0, 300)}`);
  return r;
}

test('R2-1: every creation verb presets 30 days; create_workspace honours an explicit value and null', () => {
  const deps = freshDeps();
  const plain = run(deps, 'create_workspace', { name: 'Plain AG', idempotencyKey: 'p' });
  assert.equal(termsOf(deps, plain.workspaceId), 30, 'create_workspace');
  const none = run(deps, 'create_workspace', { name: 'Keine AG', defaultPaymentTermsDays: null, idempotencyKey: 'n' });
  assert.equal(termsOf(deps, none.workspaceId), null, 'explicit null');
  const ten = run(deps, 'create_workspace', { name: 'Zehn AG', defaultPaymentTermsDays: 10, idempotencyKey: 't' });
  assert.equal(termsOf(deps, ten.workspaceId), 10, 'explicit 10');
  const bad = getAction('create_workspace').run(deps, { name: 'Lang AG', defaultPaymentTermsDays: 366, idempotencyKey: 'b' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_payment_terms_days');
  assert.equal(deps.store.db.prepare("SELECT count(*) n FROM workspace WHERE name = 'Lang AG'").get().n, 0, 'a refusal mints nothing');

  const oc = run(deps, 'onboard_client', { name: 'Mandant AG', legalForm: 'ag', vatMethod: 'effektiv', vatAccounting: 'soll', idempotencyKey: 'oc' });
  assert.equal(termsOf(deps, oc.workspaceId ?? oc.workspace?.id), 30, 'onboard_client');
  const bw = run(deps, 'bootstrap_workspace', { description: 'Einzelfirma in Zürich, Beratung, nicht MWST-pflichtig', idempotencyKey: 'bw' });
  assert.equal(termsOf(deps, bw.workspaceId ?? bw.workspace?.id), 30, 'bootstrap_workspace');
  const demo = run(deps, 'create_demo_workspace', { idempotencyKey: 'demo' });
  assert.equal(termsOf(deps, demo.workspaceId), 30, 'create_demo_workspace');

  const plan = run(deps, 'migration_create_plan', {
    workspaceId: plain.workspaceId,
    sourceSystem: 'csv',
    cutoverDate: '2020-01-01',
    localePack: 'ch',
    idempotencyKey: 'plan',
  });
  const tm = run(deps, 'migration_create_testmandant', { workspaceId: plain.workspaceId, planId: plan.planId, idempotencyKey: 'tm' });
  assert.equal(termsOf(deps, tm.workspaceId), 30, 'Testmandant');
  // A replay of create_workspace mints nothing new and keeps the first answer.
  const again = run(deps, 'create_workspace', { name: 'Plain AG', idempotencyKey: 'p' });
  assert.equal(again.workspaceId, plain.workspaceId);
});

test('R2-2: a restore carries the BACKUP value (null, 0, 14), never the 30-day preset', () => {
  for (const value of [null, 0, 14]) {
    const deps = freshDeps();
    deps.backupDir = mkdtempSync(join(tmpdir(), 'till-dt-r2-'));
    const { workspaceId } = mintWorkspace(deps, 'Quelle AG', `ws-${value}`);
    const ctx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids });
    assert.equal(updateCompanyProfile(ctx, { defaultPaymentTermsDays: value }).ok, true);
    const b = createBackup(deps, { workspaceId, idempotencyKey: `bk-${value}` });
    assert.equal(b.ok, true, JSON.stringify(b));
    const r = restoreBackup(deps, { source: b.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    assert.equal(termsOf(deps, r.workspaceId ?? r.restoredWorkspaceId), value, `restored value for ${value}`);
  }
});

test('R2-3: the registry type gate on create_workspace refuses a non-integer before the verb', () => {
  const deps = freshDeps();
  for (const bad of ['30', 30.5, true]) {
    const r = getAction('create_workspace').run(deps, { name: `X ${String(bad)}`, defaultPaymentTermsDays: bad, idempotencyKey: `x-${String(bad)}` });
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(deps.store.db.prepare("SELECT count(*) n FROM workspace WHERE name LIKE 'X %'").get().n, 0);
});
