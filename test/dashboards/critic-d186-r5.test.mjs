// Critic D186 round 5 (non-author): a Saldo period's uncapped claim stays in free_cash after it is PAID.
// Synthetic by construction: invented names and amounts, the registry path of free-cash-books.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

const { getAction } = await import('../../dist/api/registry.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');

const ok = (r, l) => { assert.equal(r.ok, true, `${l}: ${JSON.stringify(r)}`); return r; };

function saldoWorld() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Saldo Beispiel GmbH', 'ws-saldo');
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  call('vat_seed_defaults', {});
  ok(call('vat_configure', { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 620 }], idempotencyKey: 'cfg' }), 'saldo');
  ok(call('create_bank_account', { name: 'Geschäftskonto', iban: 'CH9300762011623852957', currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' }), 'bank');
  ok(call('post_entry', { date: '2026-01-02', source: 'manual', idempotencyKey: 'cap', lines: [{ account: accId('1020'), debit: 1000000 }, { account: accId('2800'), credit: 1000000 }] }), 'capital');
  // An H1 sale (Saldo: half-year periods), tagged like the A38 suite's sales.
  ok(call('post_entry', { date: '2026-03-10', source: 'manual', description: 'Beratung', idempotencyKey: 'sale', lines: [
    { account: accId('1100'), debit: 108100 }, { account: accId('3200'), credit: 100000, taxCode: 'UST81' }, { account: accId('2200'), credit: 8100 },
  ] }), 'sale');
  const free = () => ok(call('dashboard_tile', { tile: 'free_cash', from: '2026-07-01', to: '2026-07-31' }), 'tile').tile;
  return { call, accId, free };
}

test('critic D186-R5-1: paying a Saldo period through A38 (file, settle, pay 2201) leaves its claim in free_cash', () => {
  const { call, accId, free } = saldoWorld();
  const before = free();
  ok(call('vat_mark_filed', { period: '2026-H1', idempotencyKey: 'file' }), 'file');
  const s = ok(call('vat_settlement_post', { period: '2026-H1', idempotencyKey: 'settle' }), 'settle');
  const owed = s.lines.filter((l) => l.accountNumber === '2201').reduce((n, l) => n + l.creditMinor - l.debitMinor, 0);
  ok(call('post_entry', { date: '2026-07-10', source: 'manual', description: 'MWST 2026-H1 an ESTV', idempotencyKey: 'pay', lines: [{ account: accId('2201'), debit: owed }, { account: accId('1020'), credit: owed }] }), 'pay');
  const after = free();
  console.log('R5-1', JSON.stringify({ owed, before: [before.valueRappen, before.detail], after: [after.valueRappen, after.detail] }));
  assert.equal(after.valueRappen, before.valueRappen, 'paying the ESTV does not change free cash');
  assert.equal(after.detail.vatDueMinor, 0, 'a paid period owes nothing');
});
