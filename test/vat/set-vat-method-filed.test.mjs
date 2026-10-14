/**
 * D160.5, defect 3: `set_vat_method` reached around `vat_configure`'s filed-period guards.
 *
 * `vat_configure` refuses a method or timing change that is not dated (`vat_method_change_undated`)
 * once any MWST period is filed: `workspace.vat_method` is the answer for every day no method era
 * covers, so flipping it reinterprets every past period, filed ones included. `set_vat_method` (the A00
 * onboarding verb) wrote the same two columns with no guard at all. REPRODUCED here before the fix: a
 * Saldo café files 2026-H1 at a payable of 83'107 Rappen, `set_vat_method` flips it to effektiv, and
 * the filed half-year recomputes to 100'440 under a method it was never filed under.
 *
 * The fix routes `set_vat_method` through the SAME guard `vat_configure` runs (one exported function,
 * one refusal code): with a filed period, a change of method or timing is refused and names the dated
 * route (`vat_configure` with `methodChange`). Before anything is filed it still sets the method freely
 * (onboarding), and restating the current values stays a no-op success.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);
const H1 = { periodStart: '2026-01-01', periodEnd: '2026-06-30' };

/** A one-rate Saldo café with H1 turnover (the saldo-filed-period fixture, trimmed to what this needs). */
function cafe(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Café Methode GmbH', `${seed}-ws`);
  const cfg = call(deps, 'vat_configure', {
    workspaceId,
    method: 'saldo',
    timing: 'soll',
    registered: true,
    asOf: '2026-01-01',
    vatNumber: 'CHE-116.281.271 MWST',
    saldoRates: [{ rateBp: 620 }],
    saldoActivities: [{ activityId: 'restauration', name: 'Restauration', activityCode: '00123', rateBp: 620, accounts: ['3200'] }],
    idempotencyKey: `${seed}-cfg`,
  });
  assert.equal(cfg.ok, true, `vat_configure failed: ${JSON.stringify(cfg)}`);
  const preview = call(deps, 'vat_preview', { workspaceId, amountMinor: 1240000, amountIsGross: false, taxCode: 'UST81', supplyDate: '2026-05-15' });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const posted = call(deps, 'post_entry', {
    workspaceId,
    date: '2026-05-15',
    source: 'manual',
    idempotencyKey: `${seed}-sale`,
    lines: [
      { account: accId('1100'), debit: preview.grossMinor },
      { account: accId('3200'), credit: 1240000, taxCode: 'UST81', supplyDate: '2026-05-15' },
      { account: accId('2200'), credit: preview.taxMinor },
    ],
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  return { deps, workspaceId };
}

function methodRow(deps, workspaceId) {
  return deps.store.db.prepare('SELECT vat_method, vat_accounting FROM workspace WHERE id = ?').get(workspaceId);
}

test('set_vat_method cannot flip the method under a filed period: the filed return keeps its figure', () => {
  const { deps, workspaceId } = cafe('svm-method');
  const filedReturn = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(filedReturn.ok, true, JSON.stringify(filedReturn));
  assert.equal(filedReturn.method, 'saldo');
  assert.equal(call(deps, 'vat_mark_filed', { workspaceId, period: '2026-H1', idempotencyKey: 'svm-method-file' }).ok, true);

  const flipped = call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' });
  assert.equal(flipped.ok, false, `set_vat_method rewrote the method under a filed period: ${JSON.stringify(flipped)}`);
  assert.equal(flipped.error, 'vat_method_change_undated', 'the same refusal code vat_configure answers');
  assert.deepEqual(flipped.changed, ['method']);
  assert.deepEqual(flipped.filedMonths, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
  assert.equal(flipped.firstUnfiledFrom, '2026-07-01');
  assert.match(flipped.hint, /vat_configure/, 'the refusal names the dated route');
  assert.match(flipped.hint, /methodChange/);

  assert.deepEqual(methodRow(deps, workspaceId), { vat_method: 'saldo', vat_accounting: 'soll' }, 'nothing was written');
  const again = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.method, 'saldo');
  assert.equal(again.payableMinor, filedReturn.payableMinor, 'the filed payable moved');
  assert.deepEqual(again.lines, filedReturn.lines);
});

test('set_vat_method cannot move the timing (soll to ist) under a filed period either', () => {
  const { deps, workspaceId } = cafe('svm-timing');
  assert.equal(call(deps, 'vat_mark_filed', { workspaceId, period: '2026-H1', idempotencyKey: 'svm-timing-file' }).ok, true);
  const r = call(deps, 'set_vat_method', { workspaceId, vatMethod: 'saldo', vatAccounting: 'ist' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.error, 'vat_method_change_undated');
  assert.deepEqual(r.changed, ['timing']);
  assert.deepEqual(methodRow(deps, workspaceId), { vat_method: 'saldo', vat_accounting: 'soll' });
});

test('set_vat_method restating the current method under a filed period is still a success', () => {
  const { deps, workspaceId } = cafe('svm-same');
  assert.equal(call(deps, 'vat_mark_filed', { workspaceId, period: '2026-H1', idempotencyKey: 'svm-same-file' }).ok, true);
  const r = call(deps, 'set_vat_method', { workspaceId, vatMethod: 'saldo', vatAccounting: 'soll' });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('before anything is filed, set_vat_method still sets the method (onboarding is unchanged)', () => {
  const { deps, workspaceId } = cafe('svm-open');
  const r = call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'ist' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(methodRow(deps, workspaceId), { vat_method: 'effektiv', vat_accounting: 'ist' });
});

test('the dated route the refusal names works: vat_configure with methodChange from the first unfiled day', () => {
  const { deps, workspaceId } = cafe('svm-dated');
  const filedReturn = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(call(deps, 'vat_mark_filed', { workspaceId, period: '2026-H1', idempotencyKey: 'svm-dated-file' }).ok, true);
  const refused = call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' });
  assert.equal(refused.error, 'vat_method_change_undated');
  // MWSTG Art. 37 Abs. 4 puts a method change at the start of a Steuerperiode: 2027-01-01 here.
  const dated = call(deps, 'vat_configure', {
    workspaceId,
    method: 'effektiv',
    timing: 'soll',
    registered: true,
    asOf: '2027-01-01',
    methodChange: { validFrom: '2027-01-01' },
    idempotencyKey: 'svm-dated-cfg',
  });
  assert.equal(dated.ok, true, JSON.stringify(dated));
  const again = call(deps, 'vat_return', { workspaceId, ...H1 });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.payableMinor, filedReturn.payableMinor, 'the dated change left the filed half-year as filed');
});
