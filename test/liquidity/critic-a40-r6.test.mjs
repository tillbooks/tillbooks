/**
 * A40 critic round 6 (non-author, 01.10.2026): probes against the round-5 remediation at 10d4b78b (the
 * owner's blunt MWST rule: output tax only, never Vorsteuer, one output-tax cap for every claim; the
 * feasible greedy fallback and single-move fixpoint; the clock in the preparation; the wording when the
 * scheduled flows alone overdraw).
 *
 * `[FINDING]` tests reproduce a defect and fail on the head until it is fixed; `[HOLDS]` tests pin a
 * property that was attacked and held. Every fixture is SYNTHETIC by construction: invented names, the
 * SIX sample IBAN, invented amounts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { optimisePaymentPlan, horizonDates, lastExecutionFor, clearingDayOnOrAfter } from '../../dist/core/liquidity/index.js';
import { dayAdd } from './critic-a40-r4-bruteforce.mjs';

const IBAN = 'CH93 0076 2011 6238 5295 7';

function depsAt(iso) {
  return { store: new SqliteStore({ clock: fixedClock(iso) }), clock: fixedClock(iso), ids: sequenceIdGen(), actor: 'studio' };
}

function book(deps, { saldo = false, timing = 'soll' } = {}) {
  const res = getAction('create_workspace').run(deps, { name: 'Beispiel Werkstatt GmbH', idempotencyKey: 'ws' });
  assert.equal(res.ok, true, JSON.stringify(res));
  const workspaceId = res.workspaceId;
  const at = (d) => (n, i = {}) => getAction(n).run(d, { workspaceId, ...i });
  const call = at(deps);
  const accId = (n) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  call('vat_seed_defaults', {});
  const cfg = saldo
    ? call('vat_configure', { method: 'saldo', timing, registered: true, saldoRates: [{ rateBp: 620, formLine: '322' }], idempotencyKey: 'cfg' })
    : call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: timing });
  assert.equal(cfg.ok, true, JSON.stringify(cfg));
  const bank = call('create_bank_account', { name: 'Kontokorrent', iban: IBAN, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  const postAt = (d) => (date, key, lines) => {
    const r = at(d)('post_entry', { date, source: 'manual', idempotencyKey: key, lines });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  };
  return { deps, workspaceId, call, at, accId, post: postAt(deps), postAt, bankAccountId: bank.bankAccountId };
}

const saleLines = (w, tax) => {
  const net = (tax / 81) * 1_000;
  return [
    { account: w.accId('1100'), debit: net + tax },
    { account: w.accId('3200'), credit: net, taxCode: 'UST81', taxBase: net, taxAmount: tax },
    { account: w.accId('2200'), credit: tax },
  ];
};
const buyLines = (w, tax) => {
  const net = (tax / 81) * 1_000;
  return [
    { account: w.accId('6500'), debit: net, taxCode: 'VST-M', taxBase: net, taxAmount: tax },
    { account: w.accId('1170'), debit: tax },
    { account: w.accId('2000'), credit: net + tax },
  ];
};
const vatFlows = (f) => f.flows.filter((x) => x.kind === 'vat').map((x) => [x.date, x.amountMinor, x.ref, x.provenance]);
const lines = (f) => f.conservative.map((c) => [c.reason, c.ref, c.amountMinor]);

// =================================================================================================
// R6-L1: the stated residual. A book that pays the NET tax straight from 2200 (no A38 settlement, no
// 1170 clearing) has every paid quarter's Vorsteuer part debited again TODAY, labelled `vat_overdue`,
// with no conservative line
// =================================================================================================

test('[FINDING R6-L1] paying the net tax straight from 2200: a paid quarter is debited again today as "vat_overdue", and no line says it is a conservative assumption', () => {
  const w = book(depsAt('2026-09-15T08:00:00.000Z'));
  w.post('2026-01-02', 'capital', [
    { account: w.accId('1020'), debit: 50_000_000 },
    { account: w.accId('2800'), credit: 50_000_000 },
  ]);
  for (const [i, booked, paid] of [
    [1, '2026-02-10', '2026-05-20'],
    [2, '2026-05-10', '2026-08-20'],
  ]) {
    w.post(booked, `s${i}`, saleLines(w, 810_000));
    w.post(booked, `b${i}`, buyLines(w, 405_000));
    // The ESTV is paid the return's figure, CHF 4'050, booked on 2200; 1170 is cleared only at year end.
    w.post(paid, `p${i}`, [
      { account: w.accId('2200'), debit: 405_000 },
      { account: w.accId('1020'), credit: 405_000 },
    ]);
  }
  const f = w.call('liquidity_forecast', { horizonDays: 60 });
  assert.equal(f.ok, true, JSON.stringify(f));
  const phantom = vatFlows(f).filter((x) => x[2] === '2026-Q1' || x[2] === '2026-Q2');
  // Either nothing is debited for the paid quarters, or what is debited is said as conservative.
  assert.ok(
    phantom.length === 0 || f.conservative.some((c) => c.ref === '2026-Q1' || c.ref === '2026-Q2'),
    `debited again: ${JSON.stringify(phantom)}; conservative lines ${JSON.stringify(lines(f))}`,
  );
});

// =================================================================================================
// Held
// =================================================================================================

test('[HOLDS] the common manual close (Vorsteuer cleared against 2200, then the net paid): a paid quarter is never debited again', () => {
  const w = book(depsAt('2026-09-15T08:00:00.000Z'));
  w.post('2026-05-10', 'q2s', saleLines(w, 810_000));
  w.post('2026-05-12', 'q2b', buyLines(w, 405_000));
  w.post('2026-08-25', 'verr', [
    { account: w.accId('2200'), debit: 405_000 },
    { account: w.accId('1170'), credit: 405_000 },
  ]);
  w.post('2026-08-25', 'pay', [
    { account: w.accId('2200'), debit: 405_000 },
    { account: w.accId('1020'), credit: 405_000 },
  ]);
  w.post('2026-09-02', 'q3s', saleLines(w, 162_000));
  const f = w.call('liquidity_forecast', { horizonDays: 60 });
  assert.deepEqual(vatFlows(f), []);
  assert.deepEqual(lines(f), []);
});

test('[HOLDS] A38-settled, unpaid Q2 next to an unpaid Q1 in arrears: the whole liability is still debited (Q1 as a conservative line)', () => {
  const mar = depsAt('2026-02-10T08:00:00.000Z');
  const w = book(mar);
  w.post('2026-02-10', 'q1', saleLines(w, 243_000));
  w.post('2026-05-10', 'q2s', saleLines(w, 810_000));
  w.post('2026-05-12', 'q2b', buyLines(w, 405_000));
  const aug = { ...mar, clock: fixedClock('2026-08-20T08:00:00.000Z') };
  assert.equal(w.at(aug)('vat_mark_filed', { period: '2026-Q2', idempotencyKey: 'f2' }).ok, true);
  const s = w.at(aug)('vat_settlement_post', { period: '2026-Q2', idempotencyKey: 's2' });
  assert.equal(s.ok, true, JSON.stringify(s));
  const f = w.at(aug)('liquidity_forecast', { horizonDays: 30 });
  const total = f.flows.filter((x) => x.kind === 'vat').reduce((sum, x) => sum - x.amountMinor, 0);
  assert.equal(total, 243_000 + 405_000, JSON.stringify(vatFlows(f)));
  assert.deepEqual(lines(f), [['vat_unattributed', null, 243_000]]);
});

test('[HOLDS] Saldo with Ist: an invoice booked at 8.1 % is debited at its booked tax (above the Saldo figure), as a conservative line', () => {
  const may = depsAt('2026-05-12T08:00:00.000Z');
  const w = book(may, { saldo: true, timing: 'ist' });
  const cust = w.call('create_contact', { partyRole: 'customer', name: 'Kunde AG', idempotencyKey: 'c' }).contact.id;
  const doc = w.call('create_document', { type: 'invoice', contactId: cust, currency: 'CHF', dueDate: '2026-05-30', lines: [{ description: 'Beratung', unitPriceMinor: 1_000_000, taxCode: 'UST81' }], idempotencyKey: 'd' });
  assert.equal(w.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'i' }).ok, true);
  const f = w.at({ ...may, clock: fixedClock('2026-07-10T08:00:00.000Z') })('liquidity_forecast', { horizonDays: 60 });
  assert.deepEqual(vatFlows(f).map((x) => [x[0], x[1], x[2]]), [['2026-08-27', -81_000, '2026-H1']]);
  assert.deepEqual(lines(f), [['vat_return_refused', '2026-H1', 81_000]]);
});

test('[HOLDS] the scheduled flows alone overdraw: the refusal names that and never says late payments would help', () => {
  const w = book(depsAt('2026-07-06T08:00:00.000Z'));
  w.post('2026-07-01', 'capital', [
    { account: w.accId('1020'), debit: 1_000_000 },
    { account: w.accId('2800'), credit: 1_000_000 },
  ]);
  assert.equal(
    w.call('liquidity_flow_set', { label: 'Miete', direction: 'out', amountMinor: 2_000_000, currency: 'CHF', firstDate: '2026-07-20', recurrence: 'once', bankAccountId: w.bankAccountId, idempotencyKey: 'rent' }).ok,
    true,
  );
  const p = w.call('liquidity_plan_propose', { floorMinor: 0, idempotencyKey: 'p' });
  assert.equal(p.error, 'floor_breached_by_schedule');
  assert.deepEqual(p.scheduleAloneOverdraws, { date: '2026-07-20', balanceMinor: -1_000_000 });
  assert.doesNotMatch(p.hint, /acceptLatePayments/);
});

/** Every bill due on ONE day, a rise every day, a 366-day horizon: the adversarial shape for R5-M3. */
function oneDayBook(n, T, allowLate) {
  let s = 777;
  const r = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const asOf = '2026-07-01';
  const dates = horizonDates(asOf, T);
  const bills = [];
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const A = 50_000 + Math.floor(r() * 500_000);
    total += A;
    bills.push({ id: `d${String(i).padStart(5, '0')}`, openMinor: A, dueDate: dayAdd(asOf, 5), skontoRateBp: i % 2 ? 200 : 0, skontoUntil: i % 2 ? dayAdd(asOf, 2) : null });
  }
  const floorMinor = 1_000_000;
  const baseBalance = [];
  let bal = floorMinor + total * 0.05;
  for (let t = 0; t < T; t += 1) {
    bal += ((total * (allowLate ? 0.6 : 3)) / T) * (0.5 + r());
    baseBalance.push(Math.round(bal));
  }
  return { dates, baseBalance, floorMinor, bills, lagDays: 1, lateInterestBp: 500, allowLate };
}

function lateForNothing(inst, res) {
  const T = inst.dates.length;
  const idx = new Map(inst.dates.map((d, i) => [d, i]));
  const paid = new Array(T).fill(0);
  for (const l of res.lines) if (l.option.date !== null) paid[idx.get(l.option.date)] += l.option.cashMinor;
  const ok = (p) => {
    let c = 0;
    for (let t = 0; t < T; t += 1) {
      c += p[t];
      if (c > Math.max(0, inst.baseBalance[t] - inst.floorMinor)) return false;
    }
    return true;
  };
  const first = clearingDayOnOrAfter(inst.dates[0]);
  let count = 0;
  for (const l of res.lines) {
    if (l.option.daysLate === 0) continue;
    const b = inst.bills.find((x) => x.id === l.billId);
    const on = lastExecutionFor(b.dueDate, inst.lagDays);
    if (on < first || !idx.has(on)) continue;
    const p = paid.slice();
    if (l.option.date !== null) p[idx.get(l.option.date)] -= l.option.cashMinor;
    p[idx.get(on)] += b.openMinor;
    if (ok(p)) count += 1;
  }
  return count;
}

test('[HOLDS] adversarial R5-M3 shape (1500 bills due on one day, a rise every day, 366 days, consent): no bill late for nothing, time bounded', (t) => {
  const inst = oneDayBook(1500, 366, true);
  const t0 = performance.now();
  const res = optimisePaymentPlan(inst);
  const ms = Math.round(performance.now() - t0);
  t.diagnostic(`${ms} ms, ${res.optimality}, ${res.lines.filter((l) => l.option.kind === 'defer').length} deferred`);
  assert.equal(lateForNothing(inst, res), 0);
  assert.ok(res.upperBoundMinor >= res.objectiveMinor);
  assert.ok(ms < 8_000, `${ms} ms`);
});
