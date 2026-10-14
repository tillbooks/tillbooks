/**
 * A40 rebuild (30.09.2026): the MWST chokepoint (`src/core/liquidity/vat.ts`), case by case.
 *
 * What a period owes is A07's return (tagged lines only); when it is owed is MWSTG Art. 86 Abs. 1
 * (60 days after the period end, ESTV counts receipt); the opening position A04 carried is attributed
 * to the earliest period started before the opening and not yet due on it; under the effektive Methode
 * the ledger's open liability caps what is debited, newest claim first (OR 87 Abs. 1). The round-3
 * critic's probes (R3-M1, R3-L1) live in `critic-a40-r3.test.mjs`; these pin the rest of the contract.
 *
 * Every fixture is SYNTHETIC by construction: invented names, the SIX sample IBAN, invented amounts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { OPENING_KEY_PREFIX } from '../../dist/core/ledger/openingBalances.js';
import { lastExecutionFor, OPENING_ENTRY_KEY_PREFIX, vatObligations } from '../../dist/core/liquidity/index.js';

const IBAN = 'CH93 0076 2011 6238 5295 7';

function depsAt(iso) {
  return { store: new SqliteStore({ clock: fixedClock(iso) }), clock: fixedClock(iso), ids: sequenceIdGen(), actor: 'studio' };
}

function book(deps, name = 'Beispiel Schreinerei GmbH', key = 'ws') {
  const res = getAction('create_workspace').run(deps, { name, idempotencyKey: key });
  assert.equal(res.ok, true, JSON.stringify(res));
  const workspaceId = res.workspaceId;
  const call = (n, i = {}) => getAction(n).run(deps, { workspaceId, ...i });
  const accId = (n) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  call('vat_seed_defaults', {});
  call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const bank = call('create_bank_account', { name: 'Kontokorrent', iban: IBAN, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  return { deps, workspaceId, call, accId };
}

const vatOf = (f) => f.flows.filter((x) => x.kind === 'vat').map((x) => [x.date, x.amountMinor, x.ref, x.provenance]);
const vatExcluded = (f) => f.excluded.filter((e) => e.kind === 'vat').map((e) => [e.reason, e.ref, e.amountMinor]);

function opening(w, asOf, vatMinor, key = 'ob') {
  const r = w.call('set_opening_balances', {
    ...(asOf === null ? {} : { asOf }),
    idempotencyKey: key,
    lines: [
      { account: '1020', debitMinor: 5_000_000 },
      { account: '2200', creditMinor: vatMinor },
      { account: '2800', creditMinor: 5_000_000 - vatMinor },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

function post(w, date, key, lines) {
  const r = w.call('post_entry', { date, source: 'manual', idempotencyKey: key, lines });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

/** A tagged sale: base on 3200 with UST81 and its tax on 2200 (base CHF 1'000 per CHF 81 of tax). */
const sale = (w, date, taxMinor, key) =>
  post(w, date, key, [
    { account: w.accId('1100'), debit: (taxMinor / 81) * 1_000 + taxMinor },
    { account: w.accId('3200'), credit: (taxMinor / 81) * 1_000, taxCode: 'UST81', taxBase: (taxMinor / 81) * 1_000, taxAmount: taxMinor },
    { account: w.accId('2200'), credit: taxMinor },
  ]);
/** A tagged purchase: its Vorsteuer on 1170. */
const purchase = (w, date, taxMinor, key) =>
  post(w, date, key, [
    { account: w.accId('6500'), debit: (taxMinor / 81) * 1_000, taxCode: 'VST-M', taxBase: (taxMinor / 81) * 1_000, taxAmount: taxMinor },
    { account: w.accId('1170'), debit: taxMinor },
    { account: w.accId('1020'), credit: (taxMinor / 81) * 1_000 + taxMinor },
  ]);
const paidToEstv = (w, date, amountMinor, key) =>
  post(w, date, key, [
    { account: w.accId('2200'), debit: amountMinor },
    { account: w.accId('1020'), credit: amountMinor },
  ]);

test('the opening-entry key the chokepoint reads is A04\'s own', () => {
  assert.equal(OPENING_ENTRY_KEY_PREFIX, OPENING_KEY_PREFIX);
});

test('a year-start opening carries the Q4 tax: debited by the Q4 due date with its provenance, the amount whole', () => {
  const w = book(depsAt('2026-02-10T08:00:00.000Z'));
  opening(w, null, 800_000);
  const f = w.call('liquidity_forecast', {});
  // Q4/2025 ends 31.12.2025, due 1.3.2026 (a Sunday): with one day of lag the debit leaves on 26.2.
  assert.deepEqual(vatOf(f), [[lastExecutionFor('2026-03-01', 1), -800_000, '2025-Q4', 'period_complete+opening_balance']]);
  assert.deepEqual(vatExcluded(f), []);
});

test('a period due after the horizon is NAMED with its amount, never silently dropped', () => {
  const w = book(depsAt('2026-02-10T08:00:00.000Z'));
  opening(w, null, 800_000);
  const f = w.call('liquidity_forecast', { horizonDays: 14 }); // ends 23.2., before the 1.3. due date
  assert.deepEqual(vatOf(f), []);
  assert.deepEqual(vatExcluded(f), [['vat_due_beyond_horizon', '2025-Q4', 800_000]]);
});

test('a cutover INSIDE a period attributes the opening to the earliest period not yet due (Q1, due 30.5.), not to Q2', () => {
  const w = book(depsAt('2026-05-20T08:00:00.000Z'));
  opening(w, '2026-05-15', 600_000);
  const f = w.call('liquidity_forecast', { horizonDays: 60 });
  assert.deepEqual(vatOf(f), [[lastExecutionFor('2026-05-30', 1), -600_000, '2026-Q1', 'period_complete+opening_balance']]);
});

test('an opening paid to the ESTV before its due date is not debited again; a part payment leaves the rest', () => {
  const w = book(depsAt('2026-02-25T08:00:00.000Z'));
  opening(w, null, 800_000);
  paidToEstv(w, '2026-02-20', 300_000, 'part');
  assert.deepEqual(vatOf(w.call('liquidity_forecast', {})), [[lastExecutionFor('2026-03-01', 1), -500_000, '2025-Q4', 'period_complete+opening_balance']]);
  paidToEstv(w, '2026-02-24', 500_000, 'rest');
  const g = w.call('liquidity_forecast', {});
  assert.deepEqual(vatOf(g), []);
  assert.deepEqual(vatExcluded(g), []);
});

test('an opening reversed and imported again counts once, at the replacement\'s figure', () => {
  const w = book(depsAt('2026-02-10T08:00:00.000Z'));
  const first = opening(w, null, 800_000, 'ob1');
  const rev = w.call('reverse_entry', { entryId: first.entryId, idempotencyKey: 'rev' });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  opening(w, null, 700_000, 'ob2');
  assert.deepEqual(vatOf(w.call('liquidity_forecast', {})), [[lastExecutionFor('2026-03-01', 1), -700_000, '2025-Q4', 'period_complete+opening_balance']]);
});

test('a reversed TAGGED sale nets out in the return: nothing is debited', () => {
  const w = book(depsAt('2026-07-16T08:00:00.000Z'));
  const s = sale(w, '2026-07-02', 81_000, 's');
  assert.equal(w.call('reverse_entry', { entryId: s.entryId, idempotencyKey: 'rs' }).ok, true);
  const f = w.call('liquidity_forecast', { horizonDays: 180 });
  assert.deepEqual(vatOf(f), []);
  assert.deepEqual(vatExcluded(f), []);
});

test('Vorsteuer never lowers the cap: a running quarter\'s unrefunded surplus does not shrink the previous quarter\'s debit', () => {
  const w = book(depsAt('2026-07-16T08:00:00.000Z'));
  sale(w, '2026-05-10', 81_000, 'q2');
  purchase(w, '2026-07-05', 16_200, 'q3'); // Q3 so far: a credit of CHF 162, not refunded
  const f = w.call('liquidity_forecast', { horizonDays: 60 });
  // The ESTV collects Q2 in full on 29.8. and refunds Q3 separately: CHF 810, never 648 (the owner's rule
  // errs conservative; the cap is what 2200/2201 still owe, never reduced by unsettled Vorsteuer).
  assert.deepEqual(vatOf(f), [[lastExecutionFor('2026-08-29', 1), -81_000, '2026-Q2', 'period_complete']]);
});

test('a paid period is never debited twice: paid in full, and paid net after A38\'s settlement', () => {
  // Paid in full from 2200 before its due date.
  const a = book(depsAt('2026-08-27T08:00:00.000Z'));
  sale(a, '2026-05-10', 81_000, 'q2');
  paidToEstv(a, '2026-08-25', 81_000, 'paid');
  assert.deepEqual(vatOf(a.call('liquidity_forecast', { horizonDays: 90 })), []);

  // With Vorsteuer: Q2 owes CHF 810 - 162 = 648. Filed, settled by A38 (2200 and 1170 onto 2201), paid net from 2201.
  const b = book(depsAt('2026-08-27T08:00:00.000Z'));
  sale(b, '2026-05-10', 81_000, 'q2s');
  purchase(b, '2026-05-20', 16_200, 'q2p');
  const due = b.call('liquidity_forecast', { horizonDays: 90 });
  assert.deepEqual(vatOf(due), [['2026-08-27', -64_800, '2026-Q2', 'period_complete']], 'before payment: the net figure');
  assert.equal(b.call('vat_mark_filed', { period: '2026-Q2', idempotencyKey: 'filed' }).ok, true);
  const settled = b.call('vat_settlement_post', { period: '2026-Q2', idempotencyKey: 'settle' });
  assert.equal(settled.ok, true, JSON.stringify(settled));
  post(b, '2026-08-25', 'pay-net', [
    { account: b.accId('2201'), debit: 64_800 },
    { account: b.accId('1020'), credit: 64_800 },
  ]);
  const after = b.call('liquidity_forecast', { horizonDays: 90 });
  assert.deepEqual(vatOf(after), []);
  assert.deepEqual(after.conservative, []);
});

test('the chokepoint states its figures per period (return, opening, claim, open)', () => {
  const w = book(depsAt('2026-07-16T08:00:00.000Z'));
  opening(w, '2026-07-01', 600_000);
  sale(w, '2026-07-10', 16_200, 'q3');
  const ctx = { store: w.deps.store, clock: w.deps.clock, ids: w.deps.ids, workspaceId: w.workspaceId, actor: 'studio' };
  const ob = vatObligations(ctx, '2026-07-16', '2026-10-13');
  assert.equal(ob.configured, true);
  const pick = (label) => {
    const p = ob.periods.find((x) => x.label === label);
    return [p.returnMinor, p.openingMinor, p.claimMinor, p.openMinor, p.dueDate];
  };
  assert.deepEqual(pick('2026-Q2'), [0, 600_000, 600_000, 600_000, '2026-08-29']);
  assert.deepEqual(pick('2026-Q3'), [16_200, 0, 16_200, 16_200, '2026-11-29']);
  assert.equal(ob.unattributedMinor, 0);
});

test('§H-TENANT: another workspace\'s opening, returns and liability never reach this forecast', () => {
  const deps = depsAt('2026-02-10T08:00:00.000Z');
  const a = book(deps, 'Beispiel Bäckerei AG', 'wsa');
  const b = book(deps, 'Beispiel Velowerkstatt GmbH', 'wsb');
  opening(b, null, 900_000);
  sale(b, '2026-01-20', 81_000, 'sb');
  const f = a.call('liquidity_forecast', {});
  assert.deepEqual(vatOf(f), []);
  assert.deepEqual(vatExcluded(f), []);
  assert.equal(vatOf(b.call('liquidity_forecast', {})).length, 1);
});

test('R4-M1: liability booked before the window (no period to date it by) is debited today, conservatively, and said', () => {
  const w = book(depsAt('2026-07-16T08:00:00.000Z'));
  // An untagged raise in 2024: the window reaches back to 1.1.2025 only.
  post(w, '2024-11-20', 'old', [
    { account: w.accId('1020'), debit: 120_000 },
    { account: w.accId('2200'), credit: 120_000 },
  ]);
  const f = w.call('liquidity_forecast', { horizonDays: 30 });
  assert.deepEqual(vatOf(f), [['2026-07-16', -120_000, null, 'vat_unattributed']]);
  assert.deepEqual(f.conservative.map((c) => [c.reason, c.ref, c.amountMinor, c.date]), [['vat_unattributed', null, 120_000, '2026-07-16']]);
});

test('R6-L1: a quarter paid NET from 2200 with its Vorsteuer still on 1170 keeps the safe-direction debit and says why', () => {
  const w = book(depsAt('2026-09-15T08:00:00.000Z'));
  sale(w, '2026-05-10', 81_000, 'q2s');
  purchase(w, '2026-05-20', 40_500, 'q2p');
  paidToEstv(w, '2026-08-20', 40_500, 'q2-net'); // the return's figure, booked on 2200; 1170 left standing
  const f = w.call('liquidity_forecast', { horizonDays: 60 });
  assert.deepEqual(vatOf(f).filter((x) => x[2] === '2026-Q2'), [['2026-09-15', -40_500, '2026-Q2', 'vat_overdue']]);
  assert.deepEqual(
    f.conservative.map((c) => [c.reason, c.ref, c.amountMinor, c.date]),
    [['vat_input_not_settled', '2026-Q2', 40_500, '2026-09-15']],
  );
  // Settling the Vorsteuer against 2200 (the ordinary close) makes the amount and the line go away.
  post(w, '2026-09-14', 'close', [
    { account: w.accId('2200'), debit: 40_500 },
    { account: w.accId('1170'), credit: 40_500 },
  ]);
  const g = w.call('liquidity_forecast', { horizonDays: 60 });
  assert.deepEqual(vatOf(g).filter((x) => x[2] === '2026-Q2'), []);
  assert.deepEqual(g.conservative, []);
});
