// @ts-check
/**
 * D178 point 13, `dashboard_series`: the Übersicht's chart series ARE the ledger's totals.
 *
 * Seeded through the real verbs only (A19 bank accounts and their opening, A02 `post_entry`,
 * `reverse_entry`), synthetic data throughout. What is measured:
 *  - money in and out per month, netted per journal entry: a transfer between two own Bankkonten is
 *    neither, the engine's own bank opening is not money that moved, a reversal is real movement;
 *  - Σ in − Σ out equals the bank accounts' Kontoblatt movement over the window (general_ledger),
 *    minus the opening posting, and equals an independent SQL sum over the same lines;
 *  - Σ top + other equals the Erfolgsrechnung's expense total (income_statement) and an independent SQL
 *    sum over every expense line;
 *  - the edges: an empty book answers zeros, never an error; invalid_range, range_too_long and a bad
 *    `top` are refused; a second workspace sees only its own zeros (§H-TENANT); nothing is written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { LEDGER_OPENING_KEY_PREFIX, SERIES_MAX_MONTHS } from '../../dist/core/dashboards/index.js';
import { OPENING_KEY_PREFIX } from '../../dist/core/ledger/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const FROM = '2026-01-01';
const TO = '2026-12-31';

/** @param {any} deps @param {string} workspaceId */
function caller(deps, workspaceId) {
  return (/** @type {string} */ name, /** @type {Record<string, unknown>} */ input = {}) =>
    /** @type {any} */ (getAction(name)).run(deps, { workspaceId, ...input });
}

/** @param {(n: string) => string} accId @param {string} date @param {string} key @param {[string, number, number][]} lines */
function entry(accId, date, key, lines) {
  return {
    date,
    description: `Testbuchung ${key}`,
    source: 'manual',
    idempotencyKey: key,
    lines: lines.map(([n, debit, credit]) => (debit > 0 ? { account: accId(n), debit } : { account: accId(n), credit })),
  };
}

function seeded() {
  const deps = freshDeps();
  const minted = mintWorkspace(deps, 'Diagramm GmbH', 'ser-ws');
  const workspaceId = /** @type {string} */ (minted.workspaceId);
  const accId = /** @type {(n: string) => string} */ (minted.accId);
  const call = caller(deps, workspaceId);
  call('create_account', { number: '9100', name: 'Eröffnungsbilanz', type: 'equity', idempotencyKey: 'ser-ob' });
  call('create_account', { number: '1021', name: 'Bank Sparkonto', type: 'asset', idempotencyKey: 'ser-1021' });
  const main = call('create_bank_account', { name: 'Hauptkonto', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'ser-b1' });
  assert.equal(main.ok, true, JSON.stringify(main));
  const savings = call('create_bank_account', { name: 'Sparkonto', iban: 'CH66 0076 2011 6238 5295 8', currency: 'CHF', ledgerAccountId: accId('1021'), idempotencyKey: 'ser-b2' });
  assert.equal(savings.ok, true, JSON.stringify(savings));
  const opening = call('set_bank_opening_balance', { bankAccountId: main.bankAccountId, amountMinor: 1000000, date: '2026-01-01', idempotencyKey: 'ser-open' });
  assert.equal(opening.ok, true, JSON.stringify(opening));

  const posts = [
    // January: material paid from the bank (out 12'000).
    entry(accId, '2026-01-15', 'ser-jan', [['6500', 12000, 0], ['1020', 0, 12000]]),
    // February: a sale received (in 30'000).
    entry(accId, '2026-02-03', 'ser-feb', [['1020', 30000, 0], ['3200', 0, 30000]]),
    // March: a transfer between the two own accounts (neither), and rent paid (out 20'000).
    entry(accId, '2026-03-01', 'ser-mar-tr', [['1021', 50000, 0], ['1020', 0, 50000]]),
    entry(accId, '2026-03-05', 'ser-mar-rent', [['6000', 20000, 0], ['1021', 0, 20000]]),
    // March: one entry that both pays from and receives into the banks: nets to out 4'000.
    entry(accId, '2026-03-20', 'ser-mar-mix', [['6500', 9000, 0], ['1021', 5000, 0], ['1020', 0, 9000], ['3200', 0, 5000]]),
    // May: an expense paid in cash (1000 is not a Bankkonto): no money in or out, but an expense.
    entry(accId, '2026-05-02', 'ser-may-cash', [['6500', 7000, 0], ['1000', 0, 7000]]),
  ];
  /** @type {Record<string, string>} */
  const ids = {};
  for (const p of posts) {
    const r = call('post_entry', p);
    assert.equal(r.ok, true, JSON.stringify(r));
    ids[p.idempotencyKey] = r.entryId;
  }
  // April: the January payment reversed (in 12'000: the reversal is real ledger movement).
  const rev = call('reverse_entry', { entryId: ids['ser-jan'], date: '2026-04-01', idempotencyKey: 'ser-rev' });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  return { deps, workspaceId, accId, call };
}

/** Every row of every table, so "nothing was written" is a measurement. @param {any} store */
function census(store) {
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  /** @type {Record<string, number>} */
  const out = {};
  for (const { name } of tables) out[name] = store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
  return out;
}

test('the A04 opening key the series excludes is the ledger module\'s own', () => {
  assert.equal(LEDGER_OPENING_KEY_PREFIX, OPENING_KEY_PREFIX);
});

test('money in and out per month, netted per entry: transfers are neither, the opening is not money that moved', () => {
  const { call } = seeded();
  const r = call('dashboard_series', { from: FROM, to: TO });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.months.length, 12);
  assert.equal(r.bankAccounts, 2);
  /** @type {Record<string, [number, number]>} */
  const byMonth = Object.fromEntries(r.months.map((/** @type {any} */ m) => [m.month, [m.inMinor, m.outMinor]]));
  assert.deepEqual(byMonth['2026-01'], [0, 12000]);
  assert.deepEqual(byMonth['2026-02'], [30000, 0]);
  assert.deepEqual(byMonth['2026-03'], [0, 24000], 'the transfer is neither, rent 20000 out, the mixed entry nets to 4000 out');
  assert.deepEqual(byMonth['2026-04'], [12000, 0], 'the reversal of the January payment is money back in');
  assert.deepEqual(byMonth['2026-05'], [0, 0], 'a cash payment is not a bank movement');
  assert.deepEqual(r.totals, { inMinor: 42000, outMinor: 36000 });
  assert.equal(r.months[0].from, '2026-01-01');
  assert.equal(r.months[11].to, '2026-12-31');
});

test('Σ in − Σ out equals the bank accounts\' Kontoblatt movement minus the opening, and an independent SQL sum', () => {
  const { deps, workspaceId, accId, call } = seeded();
  const r = call('dashboard_series', { from: FROM, to: TO });
  let kontoblatt = 0;
  for (const n of ['1020', '1021']) {
    const gl = call('general_ledger', { accountId: accId(n), periodStart: FROM, periodEnd: TO });
    assert.equal(gl.ok, true, JSON.stringify(gl));
    kontoblatt += gl.closingMinor - gl.openingMinor;
  }
  assert.equal(r.totals.inMinor - r.totals.outMinor, kontoblatt - 1000000, 'the Kontoblatt movement less the posted opening');
  const sql = /** @type {{ net: number }} */ (deps.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date BETWEEN ? AND ?
          AND l.account_id IN (?, ?) AND COALESCE(e.idempotency_key, '') NOT LIKE 'bank-opening:%'`,
    )
    .get(workspaceId, FROM, TO, accId('1020'), accId('1021')));
  assert.equal(r.totals.inMinor - r.totals.outMinor, sql.net);
});

test('Σ top + other equals the Erfolgsrechnung\'s expense total and an independent SQL sum', () => {
  const { deps, workspaceId, call } = seeded();
  const r = call('dashboard_series', { from: FROM, to: TO, top: 1 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.topExpenses.length, 1);
  assert.equal(r.topExpenses[0].number, '6000', 'rent 20000 is the largest: 6500 nets 12000 - 12000 + 9000 + 7000 = 16000');
  assert.equal(r.topExpenses[0].amountMinor, 20000);
  assert.equal(r.otherExpensesMinor, 16000);
  assert.equal(r.topExpenses[0].amountMinor + r.otherExpensesMinor, r.grossExpenseMinor);
  assert.equal(r.expenseReductionsMinor, 0);
  assert.equal(r.grossExpenseMinor + r.expenseReductionsMinor, r.expenseTotalMinor);

  const statement = call('income_statement', { periodStart: FROM, periodEnd: TO });
  let expenseLines = 0;
  for (const s of statement.sections) for (const l of s.lines) if (l.account.type === 'expense') expenseLines += -l.amountMinor;
  assert.equal(r.expenseTotalMinor, expenseLines);
  const sql = /** @type {{ net: number }} */ (deps.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.source != 'close' AND e.date BETWEEN ? AND ? AND a.type = 'expense'`,
    )
    .get(workspaceId, FROM, TO));
  assert.equal(r.expenseTotalMinor, sql.net);

  const all = call('dashboard_series', { from: FROM, to: TO });
  assert.deepEqual(all.topExpenses.map((/** @type {any} */ e) => e.number), ['6000', '6500']);
  assert.equal(all.otherExpensesMinor, 0);
});

test('an expense account with a credit balance is a reduction, never a part of the ring, and nothing is dropped', () => {
  const { call, accId } = seeded();
  // A stock increase booked against material (credit 4000) and a refund credited to 6000 in December.
  const posted = call('post_entry', entry(accId, '2026-12-01', 'ser-dec-stock', [['1200', 50000, 0], ['4000', 0, 50000]]));
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const r = call('dashboard_series', { from: FROM, to: TO });
  assert.equal(r.expenseReductionsMinor, -50000);
  assert.equal(r.grossExpenseMinor, 36000);
  assert.equal(r.expenseTotalMinor, -14000);
  assert.ok(r.topExpenses.every((/** @type {any} */ e) => e.amountMinor > 0));
  assert.equal(r.topExpenses.reduce((/** @type {number} */ n, /** @type {any} */ e) => n + e.amountMinor, 0) + r.otherExpensesMinor, r.grossExpenseMinor);
  const statement = call('income_statement', { periodStart: FROM, periodEnd: TO });
  let expenseLines = 0;
  for (const s of statement.sections) for (const l of s.lines) if (l.account.type === 'expense') expenseLines += -l.amountMinor;
  assert.equal(r.grossExpenseMinor + r.expenseReductionsMinor, expenseLines);
});

test('a range is clipped to its months; edges are refused with named codes', () => {
  const { call } = seeded();
  const q = call('dashboard_series', { from: '2026-02-15', to: '2026-03-10' });
  assert.equal(q.ok, true, JSON.stringify(q));
  assert.deepEqual(q.months.map((/** @type {any} */ m) => [m.month, m.from, m.to]), [['2026-02', '2026-02-15', '2026-02-28'], ['2026-03', '2026-03-01', '2026-03-10']]);
  assert.deepEqual([q.months[0].inMinor, q.months[1].outMinor], [0, 20000], 'the February sale on the 3rd lies before the range');
  assert.equal(call('dashboard_series', { from: TO, to: FROM }).error, 'invalid_range');
  const months = SERIES_MAX_MONTHS + 1;
  assert.equal(call('dashboard_series', { from: '2020-01-01', to: `${2020 + Math.floor(months / 12)}-${String((months % 12) + 1).padStart(2, '0')}-01` }).error, 'range_too_long');
  assert.equal(call('dashboard_series', { from: '2021-01-01', to: '2025-12-31' }).ok, true, 'exactly 60 months is allowed');
  assert.equal(call('dashboard_series', { from: FROM, to: TO, top: 0 }).error, 'invalid_input');
  assert.equal(call('dashboard_series', { from: '2026-1-1', to: TO }).error, 'invalid_input');
});

test('an empty book answers zeros, a neighbour sees only its own zeros, and nothing is written', () => {
  const { deps, call } = seeded();
  const other = mintWorkspace(deps, 'Nachbar AG', 'ser-ws2');
  const neighbour = caller(deps, /** @type {string} */ (other.workspaceId))('dashboard_series', { from: FROM, to: TO });
  assert.equal(neighbour.ok, true, JSON.stringify(neighbour));
  assert.equal(neighbour.bankAccounts, 0);
  assert.deepEqual(neighbour.totals, { inMinor: 0, outMinor: 0 });
  assert.deepEqual(neighbour.topExpenses, []);
  assert.equal(neighbour.expenseTotalMinor, 0);

  const before = census(deps.store);
  call('dashboard_series', { from: FROM, to: TO });
  call('dashboard_series', { from: FROM, to: TO, top: 3 });
  assert.deepEqual(census(deps.store), before);
});
