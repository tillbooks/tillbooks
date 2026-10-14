/**
 * CRITIC ROUND 7 (confirmation 3) PROBES on cl-periods: the year close's read-back guard
 * (`year_close_unverified`) must not refuse a LEGITIMATE close. Each test builds a book a real company
 * can reach through the wire and asserts the close succeeds, sweeps every P&L account to zero and seals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { getAction } = await import('../../dist/api/registry.js');
const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
const { fixedClock } = await import('../../dist/core/clock.js');
const { sequenceIdGen } = await import('../../dist/core/ids.js');

let seq = 0;
const key = (tag) => `r7-${tag}-${(seq += 1)}`;

function world({ fyStart } = {}) {
  const at = '2027-09-15T09:00:00.000Z';
  const store = new SqliteStore({ clock: fixedClock(at) });
  const deps = { store, clock: fixedClock(at), ids: sequenceIdGen(), actor: 'studio' };
  const res = getAction('create_workspace').run(deps, { name: 'R7 GmbH', idempotencyKey: key('ws') });
  assert.equal(res.ok, true, JSON.stringify(res));
  const ws = res.workspaceId;
  if (fyStart !== undefined) store.db.prepare('UPDATE workspace SET fiscal_year_start = ? WHERE id = ?').run(fyStart, ws);
  const call = (name, input) => getAction(name).run(deps, { workspaceId: ws, ...input });
  const acc = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, n).id;
  const post = (date, lines, extra = {}) => {
    const r = call('post_entry', { date, source: 'manual', description: 'probe', idempotencyKey: key('p'), lines, ...extra });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  };
  return { deps, store, ws, call, acc, post };
}

function plNet(w, start, end) {
  return w.store.db.prepare(
    `SELECT a.number AS n, SUM(l.base_debit_minor - l.base_credit_minor) AS net
       FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
      WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ? AND a.type IN ('income','expense')
      GROUP BY a.id HAVING net != 0`).all(w.ws, start, end);
}

function closeOk(w, year, start, end) {
  const cy = w.call('close_year', { year, idempotencyKey: key('cy') });
  assert.equal(cy.ok, true, JSON.stringify(cy));
  assert.deepEqual(plNet(w, start, end), []);
  const lock = w.store.db.prepare('SELECT kind, reason FROM period_lock WHERE workspace_id = ? AND period = ?').get(w.ws, year);
  assert.deepEqual({ ...lock }, { kind: 'hard', reason: 'year_close' });
  return cy;
}

test('R7: a multi-currency P&L (EUR at odd rates, rounding per line) closes', () => {
  const w = world();
  for (const [i, rate] of ['0.9412', '0.93333', '1.07777'].entries()) {
    w.post(`2026-0${i + 2}-15`, [{ account: w.acc('6500'), debit: 33333 + i }, { account: w.acc('1020'), credit: 33333 + i }], { currency: 'EUR', fxRate: rate });
    w.post(`2026-0${i + 2}-16`, [{ account: w.acc('1020'), debit: 77777 + i }, { account: w.acc('3200'), credit: 77777 + i }], { currency: 'EUR', fxRate: rate });
  }
  closeOk(w, '2026', '2026-01-01', '2026-12-31');
});

test('R7: a non-calendar fiscal year (07-01) closes over entries on both sides of the calendar year', () => {
  const w = world({ fyStart: '07-01' });
  w.post('2026-07-01', [{ account: w.acc('6500'), debit: 1000 }, { account: w.acc('1000'), credit: 1000 }]);
  w.post('2026-12-31', [{ account: w.acc('1000'), debit: 9000 }, { account: w.acc('3200'), credit: 9000 }]);
  w.post('2027-06-30', [{ account: w.acc('6500'), debit: 500 }, { account: w.acc('1000'), credit: 500 }]);
  // Outside FY 2026 on both sides, and must stay untouched.
  w.post('2026-06-30', [{ account: w.acc('6500'), debit: 7 }, { account: w.acc('1000'), credit: 7 }]);
  w.post('2027-07-01', [{ account: w.acc('6500'), debit: 11 }, { account: w.acc('1000'), credit: 11 }]);
  closeOk(w, '2026', '2026-07-01', '2027-06-30');
});

test('R7: reversed entries, a draft, a manual 2979 posting and a P&L account netting to zero close', () => {
  const w = world();
  const p = w.post('2026-03-01', [{ account: w.acc('6500'), debit: 4000 }, { account: w.acc('1000'), credit: 4000 }]);
  const rev = w.call('reverse_entry', { entryId: p.entryId, date: '2026-03-02', idempotencyKey: key('rev') });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  w.post('2026-04-01', [{ account: w.acc('6500'), debit: 300 }, { account: w.acc('1000'), credit: 300 }]);
  w.post('2026-04-02', [{ account: w.acc('1000'), debit: 300 }, { account: w.acc('6500'), credit: 300 }]);
  const draft = w.call('save_draft', { date: '2026-05-01', source: 'manual', idempotencyKey: key('d'), lines: [{ account: w.acc('6500'), debit: 50 }, { account: w.acc('1000'), credit: 50 }] });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  w.post('2026-06-01', [{ account: w.acc('2979'), debit: 1234 }, { account: w.acc('1000'), credit: 1234 }]);
  w.post('2026-07-01', [{ account: w.acc('1000'), debit: 99999 }, { account: w.acc('3200'), credit: 99999 }]);
  closeOk(w, '2026', '2026-01-01', '2026-12-31');
});

test('R7: two consecutive years close in order, the second over the first one\'s 2970 carry', () => {
  const w = world();
  w.post('2025-05-01', [{ account: w.acc('1000'), debit: 5000 }, { account: w.acc('3200'), credit: 5000 }]);
  w.post('2026-05-01', [{ account: w.acc('6500'), debit: 8000 }, { account: w.acc('1000'), credit: 8000 }]);
  closeOk(w, '2025', '2025-01-01', '2025-12-31');
  closeOk(w, '2026', '2026-01-01', '2026-12-31');
});

test('R7: a year with no P&L at all (only balance-sheet movement) closes', () => {
  const w = world();
  w.post('2026-05-01', [{ account: w.acc('1020'), debit: 5000 }, { account: w.acc('1000'), credit: 5000 }]);
  closeOk(w, '2026', '2026-01-01', '2026-12-31');
});

test('R7: a P&L posting that lands between the sweep read and the close transaction refuses the seal, nothing moves', () => {
  const w = world();
  w.post('2026-05-01', [{ account: w.acc('6500'), debit: 8000 }, { account: w.acc('1000'), credit: 8000 }]);
  // Simulate the D12 second writer committing after hardCloseYear computed its sweep and before its
  // transaction opens: the first close_year rememberIdempotent call posts a P&L entry first.
  const original = w.store.rememberIdempotent.bind(w.store);
  let fired = false;
  w.store.rememberIdempotent = (ws, k, verb, compute) => {
    if (verb === 'close_year' && !fired) {
      fired = true;
      w.post('2026-06-01', [{ account: w.acc('6500'), debit: 222 }, { account: w.acc('1000'), credit: 222 }]);
    }
    return original(ws, k, verb, compute);
  };
  const cy = w.call('close_year', { year: '2026', idempotencyKey: key('cy') });
  assert.equal(fired, true);
  assert.equal(cy.ok, false, JSON.stringify(cy));
  assert.equal(cy.error, 'year_close_unverified');
  assert.equal(w.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'close'").get(w.ws).n, 0);
  assert.equal(w.store.db.prepare('SELECT COUNT(*) AS n FROM period_lock WHERE workspace_id = ? AND period = ?').get(w.ws, '2026').n, 0);
  // And a retry, with the late entry now visible to the sweep, closes cleanly.
  w.store.rememberIdempotent = original;
  closeOk(w, '2026', '2026-01-01', '2026-12-31');
});
