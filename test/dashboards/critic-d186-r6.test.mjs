// Critic D186 round 6 (non-author): free_cash's MWST term across a method change, a reversed settlement
// and a January view. Synthetic by construction: invented names and amounts, the registry path.
import test from 'node:test';
import assert from 'node:assert/strict';

const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
const { fixedClock } = await import('../../dist/core/clock.js');
const { sequenceIdGen } = await import('../../dist/core/ids.js');
const { getAction } = await import('../../dist/api/registry.js');

const ok = (r, l) => { assert.equal(r.ok, true, `${l}: ${JSON.stringify(r)}`); return r; };

function world(at, method) {
  const deps = { store: new SqliteStore({ clock: fixedClock(at) }), clock: fixedClock(at), ids: sequenceIdGen(), actor: 'studio' };
  const { workspaceId } = ok(getAction('create_workspace').run(deps, { name: 'Wechsel AG', idempotencyKey: 'ws' }), 'ws');
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  call('vat_seed_defaults', {});
  ok(call('vat_configure', { method, timing: 'soll', registered: true, idempotencyKey: 'cfg', ...(method === 'saldo' ? { saldoRates: [{ rateBp: 620 }] } : {}) }), 'cfg');
  const acc = (n) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  const sale = (date, key) => ok(call('post_entry', { date, source: 'manual', description: 'Beratung', idempotencyKey: key, lines: [
    { account: acc('1100'), debit: 108100 }, { account: acc('3200'), credit: 100000, taxCode: 'UST81' }, { account: acc('2200'), credit: 8100 },
  ] }), key);
  const vatDue = () => ok(call('dashboard_tile', { tile: 'free_cash', from: '2027-01-01', to: '2027-01-31' }), 'tile').tile.detail.vatDueMinor;
  return { call, acc, sale, vatDue };
}

test('critic D186-R6-1: effektiv 2026 then Saldo from 2027: a settled, unpaid Q4 2026 on 2201 is counted twice', () => {
  const w = world('2027-01-20T00:00:00.000Z', 'effektiv');
  w.sale('2026-11-10', 'q4');
  ok(w.call('vat_mark_filed', { period: '2026-Q4', idempotencyKey: 'file' }), 'file');
  ok(w.call('vat_settlement_post', { period: '2026-Q4', idempotencyKey: 'settle' }), 'settle');
  const change = w.call('vat_configure', { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 620 }], methodChange: { validFrom: '2027-01-01' }, idempotencyKey: 'to-saldo' });
  console.log('R6-1 change', change.ok, change.error ?? '');
  ok(change, 'method change');
  const due = w.vatDue();
  console.log('R6-1 vatDue', due);
  assert.equal(due, 8100, 'Q4 2026 owes 81.00 once');
});

test('critic D186-R6-2: a reversed Saldo settlement counts the return again, and 2201 nets to zero', () => {
  const w = world('2026-07-20T00:00:00.000Z', 'saldo');
  w.sale('2026-03-10', 'h1');
  ok(w.call('vat_mark_filed', { period: '2026-H1', idempotencyKey: 'file' }), 'file');
  const s = ok(w.call('vat_settlement_post', { period: '2026-H1', idempotencyKey: 'settle' }), 'settle');
  const settledDue = ok(w.call('dashboard_tile', { tile: 'free_cash', from: '2026-07-01', to: '2026-07-31' }), 't').tile.detail.vatDueMinor;
  const rev = w.call('vat_settlement_reverse', { settlementId: s.settlementId, reason: 'Test', idempotencyKey: 'rev' });
  console.log('R6-2 reverse', rev.ok, rev.error ?? '');
  ok(rev, 'reverse');
  const after = ok(w.call('dashboard_tile', { tile: 'free_cash', from: '2026-07-01', to: '2026-07-31' }), 't').tile.detail.vatDueMinor;
  console.log('R6-2', settledDue, after);
  assert.equal(settledDue, 6702);
  assert.equal(after, 6702);
});

test('critic D186-R6-3: January: last year\'s settled AND paid Saldo periods owe nothing', () => {
  const w = world('2027-01-20T00:00:00.000Z', 'saldo');
  w.sale('2026-03-10', 'h1');
  w.sale('2026-09-10', 'h2');
  for (const p of ['2026-H1', '2026-H2']) {
    ok(w.call('vat_mark_filed', { period: p, idempotencyKey: `f-${p}` }), 'file');
    const s = ok(w.call('vat_settlement_post', { period: p, idempotencyKey: `s-${p}` }), 'settle');
    const owed = s.lines.filter((l) => l.accountNumber === '2201').reduce((n, l) => n + l.creditMinor - l.debitMinor, 0);
    ok(w.call('post_entry', { date: '2027-01-10', source: 'manual', idempotencyKey: `pay-${p}`, lines: [{ account: w.acc('2201'), debit: owed }, { account: w.acc('1020'), credit: owed }] }), 'pay');
  }
  assert.equal(w.vatDue(), 0);
});

// R6-4 is the STATED residual (booksFreeCash comment): pinned as behaviour so a change to it is a decision.
test('critic D186-R6-4 (stated residual, safe direction): Saldo paid to 2201 BEFORE the settlement counts until A38 settles', () => {
  const w = world('2026-07-20T00:00:00.000Z', 'saldo');
  w.sale('2026-03-10', 'h1');
  ok(w.call('post_entry', { date: '2026-07-15', source: 'manual', idempotencyKey: 'pay', lines: [{ account: w.acc('2201'), debit: 6702 }, { account: w.acc('1020'), credit: 6702 }] }), 'pay');
  const due = ok(w.call('dashboard_tile', { tile: 'free_cash', from: '2026-07-01', to: '2026-07-31' }), 't').tile.detail.vatDueMinor;
  // Free cash is too LOW meanwhile (never too high): the unsettled return still counts, the payment is out.
  assert.equal(due, 6702, 'the stated residual: the unsettled Saldo return counts until the settlement');
});
