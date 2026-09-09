// A05 configureVat / seedTaxCodes / upsert / deactivate / setAccountTaxDefault / reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  seedTaxCodes,
  configureVat,
  getVatConfig,
  listTaxCodes,
  upsertTaxCode,
  deactivateTaxCode,
  reactivateTaxCode,
  setAccountTaxDefault,
} from '../../dist/core/vat/index.js';
import { setup } from './support.mjs';

test('seedTaxCodes is idempotent: a second seed adds nothing, no duplicates', () => {
  const { ctx } = setup({ registered: true, seed: false });
  const first = seedTaxCodes(ctx);
  assert.equal(first.ok, true);
  assert.equal(first.seeded.length, 9);
  const second = seedTaxCodes(ctx);
  assert.equal(second.seeded.length, 0, 'nothing new on re-seed');
  assert.equal(listTaxCodes(ctx).taxCodes.length, 9);
});

test('configureVat writes method/timing/registration and reflects it in getVatConfig', () => {
  const { ctx } = setup({ registered: false });
  const res = configureVat(ctx, { method: 'effektiv', timing: 'soll', registered: true, vatNumber: 'CHE-123.456.789 MWST', idempotencyKey: 'c1' });
  assert.equal(res.ok, true);
  assert.equal(res.config.method, 'effektiv');
  assert.equal(res.config.timing, 'soll');
  assert.equal(res.config.registered, true);
  assert.equal(res.config.vatNumber, 'CHE-123.456.789 MWST');
  // Enabling MWST with no codes seeds the default set.
  assert.equal(getVatConfig(ctx).ok, true);
  assert.equal(listTaxCodes(ctx).taxCodes.length, 9);
});

test('configureVat rejects a malformed vatNumber', () => {
  const { ctx } = setup({ registered: false });
  const res = configureVat(ctx, { method: 'effektiv', timing: 'soll', registered: true, vatNumber: 'CHE-123456789', idempotencyKey: 'c1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_vat_number');
});

test('configureVat rejects an off-ladder rate and an out-of-bound rate (N-rate model, no two-rate cap)', () => {
  const { ctx } = setup({ registered: false });
  // 1.1.2025 law: more than two Saldosteuersätze are allowed, so three valid rates are accepted.
  const three = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'c0',
    saldoRates: [{ rateBp: 620 }, { rateBp: 680 }, { rateBp: 300 }],
  });
  assert.equal(three.ok, true, 'the old "at most two" cap is gone');

  const offLadder = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'c1',
    saldoRates: [{ rateBp: 650 }],
  });
  assert.equal(offLadder.error, 'invalid_saldo_rate', 'a rate not on the ESTV ladder is rejected');

  const tooHigh = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'c2',
    saldoRates: [{ rateBp: 900 }],
  });
  assert.equal(tooHigh.error, 'invalid_saldo_rate', 'a rate above the 8.1% Normalsatz is rejected');
});

test('configureVat persists the saldo rates with their ESTV Ziffern (323/333 by position)', () => {
  const { ctx } = setup({ registered: false });
  configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'c1',
    saldoRates: [{ rateBp: 620 }, { rateBp: 680 }],
  });
  const cfg = getVatConfig(ctx).config;
  assert.equal(cfg.saldoRates.length, 2);
  assert.deepEqual(cfg.saldoRates[0], { position: 1, rateBp: 620, formLine: '323' });
  assert.deepEqual(cfg.saldoRates[1], { position: 2, rateBp: 680, formLine: '333' });
});

test('configureVat is idempotent on its key', () => {
  const { ctx } = setup({ registered: false });
  const a = configureVat(ctx, { method: 'effektiv', timing: 'ist', registered: true, idempotencyKey: 'same' });
  const b = configureVat(ctx, { method: 'effektiv', timing: 'ist', registered: true, idempotencyKey: 'same' });
  assert.deepEqual(a.config, b.config);
});

test('upsertTaxCode adds a new code and edits an existing one', () => {
  const { ctx } = setup({ registered: true });
  const add = upsertTaxCode(ctx, { code: 'UST77', kind: 'output', rateBp: 770, formLine: '301', label: 'Legacy 7.7%', idempotencyKey: 'u1' });
  assert.equal(add.ok, true);
  const codes = listTaxCodes(ctx, { includeArchived: true }).taxCodes;
  assert.ok(codes.find((c) => c.code === 'UST77' && c.rateBp === 770));

  const edit = upsertTaxCode(ctx, { code: 'UST77', kind: 'output', rateBp: 770, formLine: '302', label: 'Legacy 7.7% (edited)', idempotencyKey: 'u2' });
  assert.equal(edit.ok, true);
  assert.equal(listTaxCodes(ctx, { includeArchived: true }).taxCodes.find((c) => c.code === 'UST77').formLine, '302');
});

test('deactivateTaxCode archives (never deletes); the code drops from the active list but is kept', () => {
  const { ctx, store, workspaceId } = setup({ registered: true });
  const res = deactivateTaxCode(ctx, { code: 'UST38' });
  assert.equal(res.ok, true);
  assert.ok(!listTaxCodes(ctx).taxCodes.find((c) => c.code === 'UST38'), 'archived code is gone from the active list');
  assert.ok(listTaxCodes(ctx, { includeArchived: true }).taxCodes.find((c) => c.code === 'UST38'), 'but the row is preserved');
  const stillThere = store.db.prepare('SELECT active FROM tax_code WHERE workspace_id = ? AND code = ?').get(workspaceId, 'UST38');
  assert.equal(stillThere.active, 0);
});

test('reactivateTaxCode brings an archived code back onto the active list (the mirror of deactivate)', () => {
  const { ctx, store, workspaceId } = setup({ registered: true });
  deactivateTaxCode(ctx, { code: 'UST38' });
  assert.ok(!listTaxCodes(ctx).taxCodes.find((c) => c.code === 'UST38'), 'precondition: archived');

  const res = reactivateTaxCode(ctx, { code: 'UST38' });
  assert.equal(res.ok, true);
  assert.ok(listTaxCodes(ctx).taxCodes.find((c) => c.code === 'UST38'), 'the code is back on the active list');
  const flag = store.db.prepare('SELECT active FROM tax_code WHERE workspace_id = ? AND code = ?').get(workspaceId, 'UST38');
  assert.equal(flag.active, 1);
});

test('reactivateTaxCode is idempotent (already-active stays active) and not_found on an absent code', () => {
  const { ctx } = setup({ registered: true });
  // UST38 is seeded active; reactivating it again is a no-op that still returns ok.
  const again = reactivateTaxCode(ctx, { code: 'UST38' });
  assert.equal(again.ok, true);
  assert.equal(listTaxCodes(ctx).taxCodes.filter((c) => c.code === 'UST38').length, 1, 'no duplicate row');

  const missing = reactivateTaxCode(ctx, { code: 'NOPE' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'not_found');
});

test('reactivateTaxCode is H-TENANT isolated: a co-tenant cannot un-archive another workspace code', () => {
  // Two workspaces in the SAME database (shared store + ids), per the support docstring: a fresh
  // setup() would be two independent DBs, a trap that passes even with the workspace filter deleted.
  const a = setup({ registered: true });
  const b = setup({ registered: true, store: a.store, ids: a.ids });
  a.store.db.prepare('UPDATE tax_code SET active = 0 WHERE workspace_id = ? AND code = ?').run(a.workspaceId, 'UST38');

  // Workspace b reactivating UST38 must touch only its own row.
  const res = reactivateTaxCode(b.ctx, { code: 'UST38' });
  assert.equal(res.ok, true);
  const aFlag = a.store.db.prepare('SELECT active FROM tax_code WHERE workspace_id = ? AND code = ?').get(a.workspaceId, 'UST38');
  assert.equal(aFlag.active, 0, "another workspace's archived code stays archived");
});

test('setAccountTaxDefault writes and clears an account default, validating the code', () => {
  const { ctx, store, workspaceId } = setup({ registered: true });
  const acc = store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, '3200');
  const set = setAccountTaxDefault(ctx, { accountId: acc.id, taxCode: 'UST81' });
  assert.equal(set.ok, true);
  assert.equal(store.db.prepare('SELECT vat_code_default AS d FROM account WHERE id = ?').get(acc.id).d, 'UST81');

  const bad = setAccountTaxDefault(ctx, { accountId: acc.id, taxCode: 'NOPE' });
  assert.equal(bad.error, 'unknown_tax_code');

  const clear = setAccountTaxDefault(ctx, { accountId: acc.id, taxCode: null });
  assert.equal(clear.ok, true);
  assert.equal(store.db.prepare('SELECT vat_code_default AS d FROM account WHERE id = ?').get(acc.id).d, null);
});

test('tax-code write verbs are gated by needs_vat_registration before MWST is enabled', () => {
  const { ctx, store, workspaceId } = setup({ registered: false });
  const acc = store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, '3200');
  assert.equal(upsertTaxCode(ctx, { code: 'X', kind: 'output', rateBp: 100, formLine: '301', idempotencyKey: 'u' }).error, 'needs_vat_registration');
  assert.equal(deactivateTaxCode(ctx, { code: 'UST81' }).error, 'needs_vat_registration');
  assert.equal(setAccountTaxDefault(ctx, { accountId: acc.id, taxCode: null }).error, 'needs_vat_registration');
});

test('A05 tripwire: the vat surface exposes no delete verb (codes archive, never delete)', async () => {
  const vat = await import('../../dist/core/vat/index.js');
  for (const name of Object.keys(vat).filter((k) => typeof vat[k] === 'function')) {
    assert.ok(!/delete|remove|drop/i.test(name), `vat surface must expose no delete verb, found: ${name}`);
  }
});
