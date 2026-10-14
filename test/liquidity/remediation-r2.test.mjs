/**
 * A40 critic ROUND 2 remediation (docs/critique/a40-payment-timing-critique-r2.md on
 * origin/critic/a40-payment-timing-r2): the author's own adversarial proofs, one block per finding.
 * Synthetic books only: invented names, the SIX sample IBANs, invented amounts and dates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { bruteForce } from './oracle.mjs';
import {
  optimisePaymentPlan,
  horizonDates,
  isClearingDay,
  lastExecutionFor,
  addClearingDays,
  skontoMinor,
  interestMinor,
  daysBetween,
} from '../../dist/core/liquidity/index.js';

const IBAN_A = 'CH93 0076 2011 6238 5295 7';
const IBAN_B = 'CH56 0483 5012 3456 7800 9';

function depsAt(iso = '2026-07-16T08:00:00.000Z') {
  const store = new SqliteStore({ clock: fixedClock(iso) });
  return { store, clock: fixedClock(iso), ids: sequenceIdGen(), actor: 'studio' };
}

function book(deps = depsAt(), capitalMinor = 5_000_000) {
  const res = getAction('create_workspace').run(deps, { name: 'Beispiel Atelier GmbH', idempotencyKey: 'ws' });
  const workspaceId = res.workspaceId;
  const accId = (n) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  const call = (n, i = {}) => getAction(n).run(deps, { workspaceId, ...i });
  call('vat_seed_defaults', {});
  call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const bank = call('create_bank_account', { name: 'Kontokorrent', iban: IBAN_A, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' });
  call('post_entry', {
    date: '2026-07-01',
    source: 'manual',
    idempotencyKey: 'capital',
    lines: [
      { account: accId('1020'), debit: capitalMinor },
      { account: accId('2800'), credit: capitalMinor },
    ],
  });
  const vendor = (vname, key) => call('create_contact', { partyRole: 'vendor', name: vname, idempotencyKey: key }).contact.id;
  const bill = (vendorId, billDate, dueDate, amountMinor, key) => {
    const r = call('record_expense', {
      vendorId,
      billDate,
      dueDate,
      amountMinor,
      amountIsGross: true,
      currency: 'CHF',
      taxCode: 'VST-M',
      expenseAccountId: accId('6500'),
      vendorReference: `RE-${key}`,
      idempotencyKey: key,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.vendorBillId;
  };
  return { deps, workspaceId, accId, call, bankAccountId: bank.bankAccountId, vendor, bill };
}

// =================================================================================================
// R2-H1: the suggested floor is one at which every bill is paid on time, and the plan keeps that promise
// =================================================================================================

test('R2-H1: when even an empty floor overdraws the account, no floor is suggested and only consent goes on', () => {
  const w = book();
  const v = w.vendor('Maschinenbau AG', 'v1');
  w.bill(v, '2026-07-10', '2026-07-24', 3_000_000, 'b1');
  w.bill(v, '2026-07-10', '2026-08-07', 3_000_000, 'b2');
  const refused = w.call('liquidity_plan_propose', { floorMinor: 0, idempotencyKey: 'p' });
  assert.equal(refused.error, 'floor_breached_by_schedule');
  assert.equal(refused.balanceMinor, 5_000_000 - 6_000_000);
  assert.equal(refused.suggestedFloorMinor, null);
  assert.equal(refused.overdraws, true);
  const accepted = w.call('liquidity_plan_propose', { floorMinor: 0, acceptLatePayments: true, idempotencyKey: 'a' });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.ok(accepted.plan.lines.some((l) => l.daysLate > 0), 'with consent, the bill that does not fit is late');
  for (const l of accepted.plan.lines) assert.ok(l.reason !== 'on_time_latest' || l.daysLate === 0);
});

test('R2-H1: without consent the plan never trades a late bill for a Skonto; with consent it may', () => {
  const w = book();
  const vA = w.vendor('Miete AG', 'va');
  const vS = w.vendor('Skonto Lieferant AG', 'vs');
  const billA = w.bill(vA, '2026-07-08', '2026-07-22', 1_000_000, 'a');
  const billS = w.bill(vS, '2026-07-10', '2026-08-20', 1_000_000, 's');
  // 10 % Skonto on S if it arrives by 20.7.: CHF 1'000, worth far more than a week of OR 104 interest on A.
  assert.equal(w.call('liquidity_skonto_set', { vendorBillId: billS, rateBp: 1000, untilDate: '2026-07-20', idempotencyKey: 'sk' }).ok, true);
  // CHF 20'000 arrives on 30.7.; at a CHF 40'000 floor the on-time schedule (A on 21.7., S on 19.8.) just fits.
  w.call('liquidity_flow_set', { label: 'Kundenanzahlung', direction: 'in', amountMinor: 2_000_000, currency: 'CHF', firstDate: '2026-07-30', recurrence: 'once', idempotencyKey: 'in' });
  const strict = w.call('liquidity_plan_propose', { floorMinor: 4_000_000, idempotencyKey: 'strict' });
  assert.equal(strict.ok, true, JSON.stringify(strict));
  const a = strict.plan.lines.find((l) => l.vendorBillId === billA);
  const sk = strict.plan.lines.find((l) => l.vendorBillId === billS);
  assert.equal(a.daysLate, 0);
  assert.equal(a.reason, 'on_time_latest');
  assert.equal(a.payDate, lastExecutionFor('2026-07-22', 1));
  assert.equal(sk.reason, 'skonto_forgone_floor');
  assert.equal(sk.daysLate, 0);
  // The same books WITH consent: the Skonto is worth the delay, and the plan says why A is late.
  const traded = w.call('liquidity_plan_propose', { floorMinor: 4_000_000, acceptLatePayments: true, idempotencyKey: 'traded' });
  assert.equal(traded.plan.lines.find((l) => l.vendorBillId === billS).reason, 'skonto_captured');
  const lateA = traded.plan.lines.find((l) => l.vendorBillId === billA);
  assert.ok(lateA.daysLate > 0);
  assert.equal(lateA.reason, 'late_floor');
});

// --- the no-consent mode against an independent brute force ---------------------------------------

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const plus = (d, n) => new Date(Date.parse(`${d}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

test('R2-H1: the no-consent mode is the best Skonto among schedules that make no bill late (brute force, 250 instances)', () => {
  const rand = mulberry32(0x2a2);
  let skontoSeen = 0;
  for (let n = 0; n < 250; n += 1) {
    const asOf = ['2026-07-16', '2026-03-30', '2026-12-21'][n % 3];
    const T = 10 + Math.floor(rand() * 9);
    const dates = horizonDates(asOf, T);
    const lag = Math.floor(rand() * 2);
    const bills = [];
    const nb = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < nb; i += 1) {
      const due = plus(asOf, Math.floor(rand() * (T + 6)) - 4);
      const sk = rand() < 0.6;
      bills.push({ id: `b${i}`, openMinor: 10_000 + Math.round(rand() * 200_000), dueDate: due, skontoRateBp: sk ? 100 + Math.floor(rand() * 800) : 0, skontoUntil: sk ? plus(due, -Math.floor(rand() * 10)) : null });
    }
    const ev = {};
    for (let k = 0; k < 3; k += 1) ev[dates[Math.floor(rand() * T)]] = Math.round(rand() * 300_000);
    let run = 200_000 + Math.round(rand() * 400_000);
    const baseBalance = dates.map((d) => (run += ev[d] ?? 0));
    const clearing = dates.filter(isClearingDay);
    const first = clearing[0];
    const end = dates[T - 1];
    // The on-time schedule, independently: its low is the highest floor that lets it through.
    const onTimePaid = new Array(T).fill(0);
    for (const b of bills) {
      const last = lastExecutionFor(b.dueDate, lag);
      const day = last < first ? first : last;
      if (day > end) continue;
      onTimePaid[daysBetween(asOf, day)] += b.openMinor;
    }
    let cum = 0;
    let low = Number.POSITIVE_INFINITY;
    baseBalance.forEach((c, t) => {
      cum += onTimePaid[t];
      low = Math.min(low, c - cum);
    });
    if (low < 0) continue;
    const floorMinor = Math.floor(rand() * (low + 1));
    const r = optimisePaymentPlan({ dates, baseBalance, floorMinor, bills, lagDays: lag, lateInterestBp: 500, allowLate: false });
    // Every line: never late unless the bill was overdue before today (then the first clearing day).
    for (const l of r.lines) {
      const b = bills.find((x) => x.id === l.billId);
      const last = lastExecutionFor(b.dueDate, lag);
      if (last >= first) assert.equal(l.option.daysLate, 0, `instance ${n}: ${l.billId} made late without consent`);
      else assert.equal(l.option.date, first, `instance ${n}: an overdue bill waited`);
    }
    // The brute force over every non-late clearing day (overdue bills: the first day only).
    const opts = r.lines.map((l) => {
      const b = bills.find((x) => x.id === l.billId);
      const last = lastExecutionFor(b.dueDate, lag);
      const until = b.skontoRateBp > 0 && b.skontoUntil !== null ? (b.skontoUntil < b.dueDate ? b.skontoUntil : b.dueDate) : null;
      const K = until === null ? 0 : skontoMinor(b.openMinor, b.skontoRateBp);
      const days = last < first ? [first] : clearing.filter((x) => addClearingDays(x, lag) <= b.dueDate);
      const o = days.map((x) => {
        const arr = addClearingDays(x, lag);
        const cap = until !== null && arr <= until ? K : 0;
        const late = Math.max(0, daysBetween(b.dueDate, arr));
        return { day: daysBetween(asOf, x), cash: b.openMinor - cap, value: cap - interestMinor(b.openMinor, 500, late) };
      });
      if (last > end) o.push({ day: null, cash: 0, value: 0 });
      return o;
    });
    const head = baseBalance.map((c) => Math.max(0, c - floorMinor));
    let best = Number.NEGATIVE_INFINITY;
    const paid = new Array(T).fill(0);
    const rec = (i, value) => {
      if (i === opts.length) {
        let c = 0;
        for (let t = 0; t < T; t += 1) {
          c += paid[t];
          if (c > head[t]) return;
        }
        best = Math.max(best, value);
        return;
      }
      for (const o of opts[i]) {
        if (o.day !== null) paid[o.day] += o.cash;
        rec(i + 1, value + o.value);
        if (o.day !== null) paid[o.day] -= o.cash;
      }
    };
    rec(0, 0);
    assert.equal(r.objectiveMinor, best, `instance ${n}: no-consent optimum ${r.objectiveMinor}, brute force ${best}`);
    if (r.skontoCapturedMinor > 0) skontoSeen += 1;
  }
  assert.ok(skontoSeen >= 20, `only ${skontoSeen} instances captured a Skonto`);
});

// =================================================================================================
// R2-M1, as REBUILT (30.09.2026): what a period owes is A07's return, never an untagged posting; the
// ledger's open liability caps it (a payment clears it); what no period explains is named
// =================================================================================================

const vatOf = (f) => f.flows.filter((x) => x.kind === 'vat').map((x) => [x.date, x.amountMinor, x.ref, x.provenance]);
const untaggedVat = (w, date, amountMinor, key) => {
  const r = w.call('post_entry', {
    date,
    source: 'manual',
    idempotencyKey: key,
    lines:
      amountMinor > 0
        ? [
            { account: w.accId('1020'), debit: amountMinor },
            { account: w.accId('2200'), credit: amountMinor },
          ]
        : [
            { account: w.accId('2200'), debit: -amountMinor },
            { account: w.accId('1020'), credit: -amountMinor },
          ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
};
/** A TAGGED sale: base on 3200 with UST81, its tax on 2200 (base 1'000 per CHF 81 of tax). */
const taggedSale = (w, date, taxMinor, key) => {
  const baseMinor = (taxMinor / 81) * 1_000;
  const r = w.call('post_entry', {
    date,
    source: 'manual',
    idempotencyKey: key,
    lines: [
      { account: w.accId('1100'), debit: baseMinor + taxMinor },
      { account: w.accId('3200'), credit: baseMinor, taxCode: 'UST81', taxBase: baseMinor, taxAmount: taxMinor },
      { account: w.accId('2200'), credit: taxMinor },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
};

test('R4-M1 (owner decision 01.10.2026): an untagged raise on 2200 no return explains is debited conservatively with the period it was booked in, and said', () => {
  const w = book();
  untaggedVat(w, '2026-07-01', 400_000, 'ob');
  const f = w.call('liquidity_forecast', { horizonDays: 180 });
  // Booked on 1.7. (Q3, due 29.11.): debited by that due date, never dropped and never "today".
  assert.deepEqual(vatOf(f), [[lastExecutionFor('2026-11-29', 1), -400_000, '2026-Q3', 'posted_to_date+scheduled+vat_unattributed']]);
  assert.deepEqual(
    f.conservative.map((c) => [c.reason, c.ref, c.amountMinor, c.date, c.dueDate]),
    [['vat_unattributed', '2026-Q3', 400_000, lastExecutionFor('2026-11-29', 1), '2026-11-29']],
  );
  assert.deepEqual(f.excluded.filter((e) => e.kind === 'vat'), []);
});

test('R2-M1 rebuilt: a return past its due date and still on the books is overdue today; the ESTV payment clears it', () => {
  const w = book();
  // Q1/2026 was due on 30.5.2026: its tax (a tagged sale in March) still on the books on 16.7. IS overdue.
  taggedSale(w, '2026-03-31', 81_000, 'q1');
  const f = w.call('liquidity_forecast', { horizonDays: 60 });
  assert.deepEqual(vatOf(f), [['2026-07-16', -81_000, '2026-Q1', 'vat_overdue']]);
  // Paid to the ESTV on 10.7. (an untagged entry that lowers the liability): nothing is overdue, and the
  // payment is not mistaken for anything else either.
  untaggedVat(w, '2026-07-10', -81_000, 'paid');
  const g = w.call('liquidity_forecast', { horizonDays: 180 });
  assert.deepEqual(vatOf(g), []);
  assert.deepEqual(g.excluded.filter((e) => e.kind === 'vat'), []);
});

test('R2-M1 rebuilt: a partly paid past-due period stays overdue by the unpaid part only, Q3 keeps its own tax', () => {
  const w = book(depsAt('2026-09-01T08:00:00.000Z'));
  taggedSale(w, '2026-05-10', 81_000, 'q2'); // Q2, due 29.8.2026: past due on 1.9.
  untaggedVat(w, '2026-08-20', -50_000, 'part'); // part-payment, dated in Q3
  taggedSale(w, '2026-07-15', 16_200, 'q3'); // Q3, due 29.11.
  const f = w.call('liquidity_forecast', { horizonDays: 120 });
  assert.deepEqual(vatOf(f), [
    ['2026-09-01', -31_000, '2026-Q2', 'vat_overdue'],
    [lastExecutionFor('2026-11-29', 1), -16_200, '2026-Q3', 'posted_to_date+scheduled'],
  ]);
});

test('R4-M1 (owner decision 01.10.2026): under Ist A07 refuses the return, so the tax booked in the period is debited with it, conservatively, and said', () => {
  const w = book();
  // Vereinnahmte Entgelte: A07 refuses every return (ist timing is not implemented). The tax of an
  // invoice issued today (Q3) is owed with Q3 at the earliest (under Ist with the period it is PAID in).
  assert.equal(w.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'ist' }).ok, true);
  const cust = w.call('create_contact', { partyRole: 'customer', name: 'Kunde AG', idempotencyKey: 'c' }).contact.id;
  const doc = w.call('create_document', { type: 'invoice', contactId: cust, currency: 'CHF', dueDate: '2026-08-15', lines: [{ description: 'Beratung', unitPriceMinor: 1_000_000, taxCode: 'UST81' }], idempotencyKey: 'd' });
  assert.equal(w.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'i' }).ok, true);
  const f = w.call('liquidity_forecast', { horizonDays: 180 });
  assert.deepEqual(vatOf(f), [[lastExecutionFor('2026-11-29', 1), -81_000, '2026-Q3', 'posted_to_date+scheduled+vat_return_refused']]);
  assert.deepEqual(
    f.conservative.map((c) => [c.reason, c.ref, c.amountMinor, c.refusal]),
    [['vat_return_refused', '2026-Q3', 81_000, 'unsupported']],
  );
  // A refused period with nothing booked stays named with A07's code; nothing is debited on day 0.
  assert.ok(f.excluded.some((e) => e.kind === 'vat' && e.reason === 'unsupported' && e.ref === '2026-Q2'));
  assert.ok(!f.excluded.some((e) => e.reason === 'vat_unattributed'));
  // With a horizon that ends before 29.11. it is named with its amount, never dropped.
  const short = w.call('liquidity_forecast', { horizonDays: 60 });
  assert.deepEqual(vatOf(short), []);
  assert.deepEqual(
    short.excluded.filter((e) => e.reason === 'vat_due_beyond_horizon').map((e) => [e.ref, e.amountMinor]),
    [['2026-Q3', 81_000]],
  );
});

test('R4-M1: the proposal itself carries the conservative lines and the excluded flows its floor proof leaned on', () => {
  const w = book();
  untaggedVat(w, '2026-07-01', 400_000, 'ob');
  const p = w.call('liquidity_plan_propose', { floorMinor: 0, horizonDays: 180, idempotencyKey: 'p' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual(p.plan.conservative.map((c) => [c.reason, c.ref, c.amountMinor]), [['vat_unattributed', '2026-Q3', 400_000]]);
  assert.ok(Array.isArray(p.plan.excluded));
  const got = w.call('liquidity_plan_get', { planId: p.planId });
  assert.deepEqual(got.plan.conservative, p.plan.conservative);
  const listed = w.call('liquidity_plan_list', {});
  assert.deepEqual(listed.plans[0].conservative, p.plan.conservative);
});

// =================================================================================================
// R2-M2: a forecast solved on chosen accounts counts each flow where it lands, and says what it cannot place
// =================================================================================================

const QR_IBAN_SAMPLE = 'CH44 3199 9123 0008 8901 2'; // the SIX QR-IBAN sample: registered on no account here

function twoAccounts(w) {
  const acc = w.call('create_account', { number: '1021', name: 'Bank Zahlungskonto', type: 'asset', idempotencyKey: 'acc2' });
  assert.equal(acc.ok, true, JSON.stringify(acc));
  const b = w.call('create_bank_account', { name: 'Zahlungskonto', iban: IBAN_B, currency: 'CHF', ledgerAccountId: w.accId('1021'), idempotencyKey: 'bank2' });
  assert.equal(b.ok, true, JSON.stringify(b));
  return b.bankAccountId;
}

function invoice(w, dueDate, unitPriceMinor, key) {
  const cust = w.call('create_contact', { partyRole: 'customer', name: `Kunde ${key} AG`, idempotencyKey: `c-${key}` }).contact.id;
  const doc = w.call('create_document', {
    type: 'invoice',
    contactId: cust,
    currency: 'CHF',
    dueDate,
    lines: [{ description: 'Beratung', unitPriceMinor, taxCode: 'UST81' }],
    idempotencyKey: `d-${key}`,
  });
  assert.equal(w.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: `i-${key}` }).ok, true);
  return doc.document.id;
}

const ofKind = (f, kind) => f.flows.filter((x) => x.kind === kind);
const elsewhere = (f) => f.excluded.filter((e) => e.reason === 'other_account').map((e) => [e.kind, e.ref, e.amountMinor]);

test('R2-M2: customer receipts count only on the account whose IBAN the QR-bill carries', () => {
  const w = book();
  const payId = twoAccounts(w);
  assert.equal(w.call('set_creditor_profile', { creditorName: 'Beispiel Handels GmbH', iban: IBAN_A }).ok, true);
  const docId = invoice(w, '2026-08-14', 2_000_000, 'a');
  const onPay = w.call('liquidity_forecast', { bankAccountIds: [payId] });
  assert.deepEqual(ofKind(onPay, 'receivable'), []);
  assert.deepEqual(elsewhere(onPay), [['receivable', docId, 2_162_000]], 'named, never silently dropped');
  const onMain = w.call('liquidity_forecast', { bankAccountIds: [w.bankAccountId] });
  assert.deepEqual(ofKind(onMain, 'receivable').map((x) => [x.amountMinor, x.provenance.includes('account_unknown')]), [[2_162_000, false]]);
  assert.deepEqual(elsewhere(onMain), []);
  // Pooled over both accounts: counted once, nothing to place.
  const pooled = w.call('liquidity_forecast', {});
  assert.equal(ofKind(pooled, 'receivable').length, 1);
  assert.equal(pooled.assumptions.accountUnknown.count, 0);
});

test('R2-M2: when no account carries the creditor IBAN, receipts count on the chosen account and the forecast says so', () => {
  for (const creditorIban of [null, QR_IBAN_SAMPLE]) {
    const w = book();
    const payId = twoAccounts(w);
    if (creditorIban !== null) assert.equal(w.call('set_creditor_profile', { creditorName: 'Beispiel Handels GmbH', iban: creditorIban }).ok, true);
    invoice(w, '2026-08-14', 2_000_000, 'b');
    const f = w.call('liquidity_forecast', { bankAccountIds: [payId] });
    const r = ofKind(f, 'receivable');
    assert.equal(r.length, 1, String(creditorIban));
    assert.ok(r[0].provenance.endsWith('+account_unknown'), r[0].provenance);
    assert.deepEqual(f.assumptions.accountUnknown, { count: 1, inMinor: 2_162_000, outMinor: 0, kinds: ['receivable'] });
  }
});

test('R2-M2: a live payment run moves its own debit account only', () => {
  const w = book();
  const payId = twoAccounts(w);
  const v = w.vendor('Hosting AG', 'v1');
  assert.equal(w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN_A, idempotencyKey: 'cbp' }).ok, true);
  const bill = w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b1');
  const batch = w.call('create_payment_batch', { bankAccountId: payId, itemIds: [bill], executionDate: '2026-08-03', idempotencyKey: 'run' });
  assert.equal(batch.ok, true, JSON.stringify(batch));
  const onMain = w.call('liquidity_forecast', { bankAccountIds: [w.bankAccountId] });
  assert.deepEqual(ofKind(onMain, 'payment_run'), []);
  assert.deepEqual(elsewhere(onMain), [['payment_run', bill, 500_000]]);
  assert.deepEqual(ofKind(onMain, 'payable'), [], 'a bill in a live run is no candidate either');
  const onPay = w.call('liquidity_forecast', { bankAccountIds: [payId] });
  assert.deepEqual(ofKind(onPay, 'payment_run').map((x) => [x.date, x.amountMinor, x.provenance.includes('account_unknown')]), [['2026-08-03', -500_000, false]]);
  assert.equal(onPay.assumptions.accountUnknown.count, 0);
});

test('R2-M2: a planned flow counts on the account it names; one naming none is counted and stated', () => {
  const w = book();
  const payId = twoAccounts(w);
  const set = (i) => w.call('liquidity_flow_set', { direction: 'out', currency: 'CHF', ...i });
  assert.equal(set({ label: 'Miete', amountMinor: 300_000, firstDate: '2026-08-01', recurrence: 'monthly', bankAccountId: w.bankAccountId, idempotencyKey: 'rent' }).ok, true);
  const loan = set({ label: 'Darlehen', amountMinor: 100_000, firstDate: '2026-08-10', recurrence: 'once', idempotencyKey: 'loan' });
  assert.equal(loan.ok, true);
  assert.equal(loan.flow.bankAccountId, null);
  const onPay = w.call('liquidity_forecast', { bankAccountIds: [payId], horizonDays: 90 });
  assert.deepEqual(ofKind(onPay, 'planned').map((x) => [x.label, x.amountMinor, x.provenance]), [['Darlehen', -100_000, 'planned+account_unknown']]);
  assert.deepEqual(onPay.excluded.filter((e) => e.kind === 'planned').map((e) => e.reason), ['other_account']);
  assert.deepEqual(onPay.assumptions.accountUnknown, { count: 1, inMinor: 0, outMinor: 100_000, kinds: ['planned'] });
  const onMain = w.call('liquidity_forecast', { bankAccountIds: [w.bankAccountId], horizonDays: 90 });
  assert.deepEqual(ofKind(onMain, 'planned').map((x) => x.provenance).sort(), ['planned', 'planned', 'planned', 'planned+account_unknown']);
  // The account is this workspace's, open, and in the flow's currency; otherwise refused.
  assert.equal(set({ label: 'X', amountMinor: 1, firstDate: '2026-08-10', recurrence: 'once', bankAccountId: 'ba_nope', idempotencyKey: 'x1' }).error, 'not_found');
  const eur = set({ label: 'X', amountMinor: 1, currency: 'EUR', firstDate: '2026-08-10', recurrence: 'once', bankAccountId: payId, idempotencyKey: 'x2' });
  assert.equal(eur.error, 'invalid_input');
  assert.equal(eur.field, 'bankAccountId');
  const ws2 = getAction('create_workspace').run(w.deps, { name: 'Andere Firma GmbH', idempotencyKey: 'ws2' }).workspaceId;
  const led2 = w.deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws2, '1020').id;
  const foreign = getAction('create_bank_account').run(w.deps, { workspaceId: ws2, name: 'Fremd', iban: IBAN_B, currency: 'CHF', ledgerAccountId: led2, idempotencyKey: 'fb' });
  assert.equal(foreign.ok, true, JSON.stringify(foreign));
  assert.equal(set({ label: 'X', amountMinor: 1, firstDate: '2026-08-10', recurrence: 'once', bankAccountId: foreign.bankAccountId, idempotencyKey: 'x3' }).error, 'not_found', '§H-TENANT');
});

test('R2-M2: MWST names no account, so on a chosen account it is counted and tagged; pooled it is not', () => {
  const w = book();
  const payId = twoAccounts(w);
  taggedSale(w, '2026-07-01', 81_000, 'q3');
  const f = w.call('liquidity_forecast', { bankAccountIds: [payId], horizonDays: 180 });
  assert.deepEqual(vatOf(f).map((x) => x[3]), ['posted_to_date+scheduled+account_unknown']);
  assert.deepEqual(f.assumptions.accountUnknown.kinds, ['vat']);
  const pooled = w.call('liquidity_forecast', { horizonDays: 180 });
  assert.deepEqual(vatOf(pooled).map((x) => x[3]), ['posted_to_date+scheduled']);
});

test('R2-M2: a plan solved on the paying account does not lean on receipts that land on the other one', () => {
  const w = book();
  const payId = twoAccounts(w);
  assert.equal(w.call('set_creditor_profile', { creditorName: 'Beispiel Handels GmbH', iban: IBAN_A }).ok, true);
  const fund = w.call('post_entry', {
    date: '2026-07-01',
    source: 'manual',
    idempotencyKey: 'fund',
    lines: [
      { account: w.accId('1021'), debit: 1_000_000 },
      { account: w.accId('2800'), credit: 1_000_000 },
    ],
  });
  assert.equal(fund.ok, true, JSON.stringify(fund));
  const v = w.vendor('Baustoff AG', 'v');
  w.bill(v, '2026-07-10', '2026-08-14', 1_500_000, 'b');
  invoice(w, '2026-07-31', 2_000_000, 'c'); // CHF 21'620, paid to the Kontokorrent
  const p = w.call('liquidity_plan_propose', { floorMinor: 0, bankAccountIds: [payId], idempotencyKey: 'p' });
  assert.equal(p.error, 'floor_breached_by_schedule', JSON.stringify(p));
  assert.equal(p.overdraws, true);
  assert.equal(p.balanceMinor, 1_000_000 - 1_500_000);
});

// =================================================================================================
// R2-L1: a run drafted through A40 publishes A18's own payment_batch.created payload
// =================================================================================================

test('R2-L1: a rule on every field of A18\'s own payload (input and result.batch) fires for a drafted run', () => {
  const w = book();
  const v = w.vendor('Hosting AG', 'v1');
  assert.equal(w.call('set_creditor_bank_profile', { vendorId: v, iban: IBAN_A, idempotencyKey: 'cbp' }).ok, true);
  const bill = w.bill(v, '2026-07-06', '2026-08-05', 500_000, 'b1');
  const p = w.call('liquidity_plan_propose', { floorMinor: 1_000_000, bankAccountIds: [w.bankAccountId], idempotencyKey: 'p' });
  const execDate = p.plan.lines[0].payDate;
  const rule = w.call('create_automation_rule', {
    name: 'Zahlungslauf mit Rechnung',
    trigger: { event: 'payment_batch.created' },
    condition: {
      all: [
        { field: 'input.executionDate', op: 'eq', value: execDate },
        { field: 'input.bankAccountId', op: 'eq', value: w.bankAccountId },
        { field: 'input.itemIds', op: 'contains', value: bill },
        { field: 'input.idempotencyKey', op: 'exists' },
        { field: 'result.batchId', op: 'exists' },
        { field: 'result.batch.status', op: 'eq', value: 'draft' },
        { field: 'result.batch.executionDate', op: 'eq', value: execDate },
        { field: 'result.batch.bankAccountId', op: 'eq', value: w.bankAccountId },
      ],
    },
    action: { tool: 'contacts_tag', inputTemplate: { contactId: v, segments: ['zahlungslauf'] } },
    idempotencyKey: 'rule',
  });
  assert.equal(rule.ok, true, JSON.stringify(rule));
  const d = w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd' });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(d.batches.map((b) => [b.itemIds, b.batchIdempotencyKey]), [[[bill], `d:${execDate}`]]);
  const runs = () => w.deps.store.db.prepare('SELECT status FROM automation_run WHERE workspace_id = ? ORDER BY rowid').all(w.workspaceId).map((r) => r.status);
  assert.deepEqual(runs(), ['ok']);
  // A replay of the drafting call publishes nothing twice.
  assert.equal(w.call('liquidity_plan_draft_batches', { planId: p.planId, bankAccountId: w.bankAccountId, idempotencyKey: 'd' }).ok, true);
  assert.deepEqual(runs(), ['ok']);
});

// =================================================================================================
// R2-L2: under the Saldosteuersatz a filed, overdue period is named with its figure
// =================================================================================================

test('R2-L2: a FILED Saldo period past its due date is named with the figure its return states; an unfiled one stays overdue', () => {
  const may = depsAt('2026-05-12T08:00:00.000Z');
  const workspaceId = getAction('create_workspace').run(may, { name: 'Saldo Atelier GmbH', idempotencyKey: 'ws' }).workspaceId;
  const run = (deps, n, i = {}) => getAction(n).run(deps, { workspaceId, ...i });
  const accId = (n) => may.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  run(may, 'vat_seed_defaults');
  const cfg = run(may, 'vat_configure', { method: 'saldo', timing: 'soll', registered: true, saldoRates: [{ rateBp: 620, formLine: '322' }], idempotencyKey: 'cfg' });
  assert.equal(cfg.ok, true, JSON.stringify(cfg));
  assert.equal(run(may, 'create_bank_account', { name: 'Kontokorrent', iban: IBAN_A, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' }).ok, true);
  const cust = run(may, 'create_contact', { partyRole: 'customer', name: 'Kunde AG', idempotencyKey: 'c' }).contact.id;
  const doc = run(may, 'create_document', { type: 'invoice', contactId: cust, currency: 'CHF', dueDate: '2026-06-11', lines: [{ description: 'Beratung', unitPriceMinor: 1_000_000, taxCode: 'UST81' }], idempotencyKey: 'd' });
  assert.equal(run(may, 'issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'i' }).ok, true);

  // 10.9.2026: H1 was due on 29.8.
  const sep = { ...may, clock: fixedClock('2026-09-10T08:00:00.000Z') };
  const ret = run(sep, 'vat_return', { periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  assert.equal(ret.ok, true, JSON.stringify(ret));
  const owed = ret.payableMinor - ret.creditMinor;
  assert.ok(owed > 0, `the H1 Saldo tax is positive: ${owed}`);
  const h1 = (f) => f.excluded.filter((e) => e.kind === 'vat' && e.ref === '2026-H1').map((e) => [e.reason, e.amountMinor]);
  const before = run(sep, 'liquidity_forecast', {});
  assert.equal(before.ok, true, JSON.stringify(before));
  assert.deepEqual(h1(before), [['vat_period_overdue', null]]);
  const filed = run(sep, 'vat_mark_filed', { period: '2026-H1', idempotencyKey: 'filed' });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  const after = run(sep, 'liquidity_forecast', {});
  assert.deepEqual(h1(after), [['vat_period_filed_payment_unknown', owed]], 'named with its figure, never silently assumed paid');
  assert.deepEqual(vatOf(after), [], 'and never debited as a guess');
});

// =================================================================================================
// R2-L4: the lateness tie-break is pinned, and a heuristic plan states its lateness gap
// =================================================================================================

/** Monday 20.7.2026, lag 0, no interest: every schedule is worth CHF 0, so only lateness decides. */
function tieInstance(bills) {
  const asOf = '2026-07-20';
  const dates = horizonDates(asOf, 14);
  // Capacity 100 through Sunday 26.7., 200 from Monday 27.7.
  const baseBalance = dates.map((d) => (d < '2026-07-27' ? 100 : 200));
  return { dates, baseBalance, floorMinor: 0, lagDays: 0, lateInterestBp: 0, bills };
}
const due20 = (id, openMinor) => ({ id, openMinor, dueDate: '2026-07-20', skontoRateBp: 0, skontoUntil: null });

test('R2-L4: with worth tied, the search keeps the schedule with fewer days late where no single or pair move can reach it', () => {
  // Search order is the id: `a` (100) goes first, so the greedy start is a on time, b and c late (14
  // days). No single move fits and no pair swap gains a day (a late + b on time still leaves c late);
  // only the three-bill move a late, b and c on time (7 days) is better. A `better` that compares worth
  // only never takes it.
  const r = optimisePaymentPlan(tieInstance([due20('a', 100), due20('b', 50), due20('c', 50)]));
  assert.equal(r.optimality, 'proven');
  assert.equal(r.objectiveMinor, 0);
  assert.deepEqual(
    r.lines.map((l) => [l.billId, l.option.date, l.option.daysLate]).sort(),
    [
      ['a', '2026-07-27', 7],
      ['b', '2026-07-20', 0],
      ['c', '2026-07-20', 0],
    ],
  );
  assert.equal(r.daysLateTotal, 7);
  assert.equal(r.lateDaysLowerBound, 7, 'proven: the floor is the total');
});

test('R2-L4: a heuristic plan states a lateness floor no schedule can beat, and the plan carries the gap', () => {
  // `d` (150) cannot be on time even alone (capacity 100 until 27.7.): every schedule has it 7 days late.
  const bills = [due20('a', 100), due20('b', 50), due20('c', 50), due20('d', 150)];
  const full = optimisePaymentPlan(tieInstance(bills));
  const cut = optimisePaymentPlan({ ...tieInstance(bills), nodeBudget: 1 });
  assert.equal(cut.optimality, 'heuristic');
  assert.ok(cut.lateDaysLowerBound >= 7, `the forced lateness of d is in the floor: ${cut.lateDaysLowerBound}`);
  assert.ok(cut.lateDaysLowerBound <= full.daysLateTotal, 'the floor is never above the true optimum');
  assert.ok(cut.lateDaysLowerBound <= cut.daysLateTotal);
  assert.equal(full.lateDaysLowerBound, full.daysLateTotal);
});

test('R2-L4: the lateness floor is valid against the oracle (300 heuristic instances)', () => {
  const rand = mulberry32(0x14);
  let nontrivial = 0;
  for (let n = 0; n < 300; n += 1) {
    const asOf = ['2026-07-20', '2026-12-21'][n % 2];
    const T = 10 + Math.floor(rand() * 6);
    const dates = horizonDates(asOf, T);
    const lag = Math.floor(rand() * 2);
    const bills = [];
    for (let i = 0; i < 2 + Math.floor(rand() * 3); i += 1) {
      const dueDate = plus(asOf, Math.floor(rand() * (T + 4)) - 3);
      const sk = rand() < 0.4;
      bills.push({ id: `b${i}`, openMinor: 20_000 + Math.round(rand() * 150_000), dueDate, skontoRateBp: sk ? 200 : 0, skontoUntil: sk ? plus(dueDate, -3) : null });
    }
    let run = 50_000 + Math.round(rand() * 150_000);
    const bumps = {};
    for (let k = 0; k < 2; k += 1) bumps[dates[Math.floor(rand() * T)]] = Math.round(rand() * 250_000);
    const baseBalance = dates.map((d) => (run += bumps[d] ?? 0));
    const input = { dates, baseBalance, floorMinor: 0, lagDays: lag, lateInterestBp: [0, 500][n % 2], bills };
    const exact = optimisePaymentPlan(input);
    const cut = optimisePaymentPlan({ ...input, nodeBudget: 1 });
    // Every feasible schedule has at least the floor's days late: checked against the oracle's fewest.
    const truth = bruteForce(input);
    assert.ok(cut.lateDaysLowerBound <= truth.minLateAny, `instance ${n}: floor ${cut.lateDaysLowerBound} above the fewest days late of any schedule, ${truth.minLateAny}`);
    assert.ok(cut.lateDaysLowerBound <= exact.daysLateTotal, `instance ${n}: floor ${cut.lateDaysLowerBound} above optimum ${exact.daysLateTotal}`);
    assert.ok(cut.lateDaysLowerBound <= cut.daysLateTotal, `instance ${n}`);
    if (exact.optimality === 'proven') assert.equal(exact.lateDaysLowerBound, exact.daysLateTotal, `instance ${n}`);
    if (cut.lateDaysLowerBound > 0) nontrivial += 1;
  }
  assert.ok(nontrivial >= 10, `only ${nontrivial} instances had a non-zero floor`);
});

test('R2-L4: a stored plan states its days late and the gap, and the lower bound is frozen', () => {
  const w = book();
  const v = w.vendor('Maschinenbau AG', 'v1');
  w.bill(v, '2026-07-01', '2026-07-24', 4_900_000, 'b1');
  w.bill(v, '2026-07-01', '2026-07-24', 200_000, 'b2');
  const p = w.call('liquidity_plan_propose', { floorMinor: 0, acceptLatePayments: true, idempotencyKey: 'p' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.plan.daysLateTotal, p.plan.lines.reduce((s, l) => s + l.daysLate, 0));
  assert.equal(p.plan.lateGapDays, p.plan.daysLateTotal - p.plan.lateDaysLowerBound);
  assert.equal(p.plan.optimality, 'proven');
  assert.equal(p.plan.lateGapDays, 0);
  assert.throws(
    () => w.deps.store.db.prepare('UPDATE payment_plan SET late_days_lower_bound = 0 WHERE id = ?').run(p.planId),
    /append-only/,
  );
});

test('R5 wording: when the scheduled flows ALONE overdraw, the refusal says so and never that late payments would help', () => {
  const w = book();
  const v = w.vendor('Muster Druck AG', 'v-s');
  w.bill(v, '2026-07-01', '2026-07-24', 100_000, 'b-s');
  // CHF 50'000 on the bank; CHF 60'000 rent-like outflow on 20.7.: under 0 with no bill paid at all.
  const out = w.call('liquidity_flow_set', { label: 'Investition', direction: 'out', amountMinor: 6_000_000, currency: 'CHF', firstDate: '2026-07-20', recurrence: 'once', idempotencyKey: 'big-out' });
  assert.equal(out.ok, true, JSON.stringify(out));
  const p = w.call('liquidity_plan_propose', { floorMinor: 0, idempotencyKey: 'p-s' });
  assert.equal(p.error, 'floor_breached_by_schedule', JSON.stringify(p));
  assert.equal(p.overdraws, true);
  assert.deepEqual(p.scheduleAloneOverdraws, { date: '2026-07-20', balanceMinor: -1_000_000 });
  assert.doesNotMatch(p.hint, /acceptLatePayments/);
});
