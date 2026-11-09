// Critic D186 round 4 (non-author): free_cash's MWST term after A38's Saldierung moves a filed period to
// 2201. Synthetic by construction: invented amounts, the A38 suite's registry path.
import test from 'node:test';
import assert from 'node:assert/strict';

const { getAction } = await import('../../dist/api/registry.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');

const call = (deps, ws, name, input) => getAction(name).run(deps, { workspaceId: ws, ...input });
const ok = (r, l) => { assert.equal(r.ok, true, `${l}: ${JSON.stringify(r)}`); return r; };
const vatDue = (deps, ws) => ok(call(deps, ws, 'dashboard_tile', { tile: 'free_cash', from: '2026-07-01', to: '2026-07-31' }), 'tile').tile;

function q1World() {
  const deps = freshDeps();
  const { workspaceId: ws, accId } = mintWorkspace(deps);
  call(deps, ws, 'vat_seed_defaults', {});
  call(deps, ws, 'set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  ok(call(deps, ws, 'post_entry', { date: '2026-02-10', source: 'manual', description: 'Beratung', idempotencyKey: 'sale', lines: [
    { account: accId('1100'), debit: 108100 }, { account: accId('3200'), credit: 100000, taxCode: 'UST81' }, { account: accId('2200'), credit: 8100 },
  ] }), 'sale');
  return { deps, ws, accId };
}

test('critic D186-R4-1: a filed and SETTLED (A38) but unpaid Q1 MWST is still owed in July', () => {
  const { deps, ws } = q1World();
  const before = vatDue(deps, ws);
  ok(call(deps, ws, 'vat_mark_filed', { period: '2026-Q1', idempotencyKey: 'file' }), 'file');
  ok(call(deps, ws, 'vat_settlement_post', { period: '2026-Q1', idempotencyKey: 'settle' }), 'settle');
  const after = vatDue(deps, ws);
  console.log('R4-1', JSON.stringify({ before: before.detail, after: after.detail }));
  assert.equal(before.detail.vatDueMinor, 8100);
  assert.equal(after.detail.vatDueMinor, 8100, 'the Saldierung moves the debt to 2201, it does not pay it');
});

test('critic D186-R4-2: MWST paid to 2201 (the A38 suite\'s own booking) before the Saldierung is subtracted twice', () => {
  const { deps, ws, accId } = q1World();
  ok(call(deps, ws, 'create_bank_account', { name: 'Geschäftskonto', iban: 'CH9300762011623852957', currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' }), 'bank');
  const before = vatDue(deps, ws);
  ok(call(deps, ws, 'post_entry', { date: '2026-05-20', source: 'manual', description: 'MWST Q1 an ESTV', idempotencyKey: 'pay', lines: [
    { account: accId('2201'), debit: 8100 }, { account: accId('1020'), credit: 8100 },
  ] }), 'pay');
  const after = vatDue(deps, ws);
  console.log('R4-2', JSON.stringify({ before: [before.valueRappen, before.detail], after: [after.valueRappen, after.detail] }));
  assert.equal(after.valueRappen, before.valueRappen, 'paying a debt does not change free cash');
});
