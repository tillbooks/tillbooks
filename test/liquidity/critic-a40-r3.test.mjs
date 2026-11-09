/**
 * A40 payment timing, critic ROUND 3 (docs/critique/a40-payment-timing-critic-r3.md): the non-author
 * critic's probes of the round-2 remediation at head 7c0c8bb7.
 *
 * `[FINDING R3-xx]` fails on that head and names a defect; `[HOLDS]` passes there and pins a property
 * the critic attacked and could not break.
 *
 * Every fixture is SYNTHETIC by construction: invented company names, the SIX sample IBANs, invented
 * amounts and invented dates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import {
  optimisePaymentPlan,
  horizonDates,
  isClearingDay,
  lastExecutionFor,
  addClearingDays,
  daysBetween,
  skontoMinor,
} from '../../dist/core/liquidity/index.js';

const IBAN_A = 'CH93 0076 2011 6238 5295 7';

function depsAt(iso) {
  const store = new SqliteStore({ clock: fixedClock(iso) });
  return { store, clock: fixedClock(iso), ids: sequenceIdGen(), actor: 'studio' };
}

/** VAT configured (effektiv), a Kontokorrent on 1020, no postings yet. */
function emptyBook(deps, name = 'Beispiel Handels GmbH') {
  const res = getAction('create_workspace').run(deps, { name, idempotencyKey: 'ws' });
  assert.equal(res.ok, true, JSON.stringify(res));
  const workspaceId = res.workspaceId;
  const accId = (n) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  const call = (n, i = {}) => getAction(n).run(deps, { workspaceId, ...i });
  call('vat_seed_defaults', {});
  call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const bank = call('create_bank_account', { name: 'Kontokorrent', iban: IBAN_A, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'bank' });
  assert.equal(bank.ok, true, JSON.stringify(bank));
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
// R3-H1: the no-consent mode (the DEFAULT, acceptLatePayments false) is not searched: its LP bound is
// NaN, so the incumbent (greedy + local search) is returned as `proven`
// =================================================================================================

/**
 * Three bills due 30.7., Skonto until 10.7. Before an inflow on 20.7. the headroom over the floor is
 * CHF 100.00: it takes the big bill's Skonto (cash 98.00) OR both small ones (48.50 each), never the big
 * one with a small one. Two small Skonti (3.00) beat the big one (2.00). No bill is ever late.
 */
function knapsackInstance() {
  const dates = horizonDates('2026-07-01', 40);
  const floorMinor = 1_000_000;
  const baseBalance = dates.map((d) => floorMinor + 10_000 + (d >= '2026-07-20' ? 20_000 : 0));
  const bills = [
    { id: 'big', openMinor: 10_000, dueDate: '2026-07-30', skontoRateBp: 200, skontoUntil: '2026-07-10' },
    { id: 's1', openMinor: 5_000, dueDate: '2026-07-30', skontoRateBp: 300, skontoUntil: '2026-07-10' },
    { id: 's2', openMinor: 5_000, dueDate: '2026-07-30', skontoRateBp: 300, skontoUntil: '2026-07-10' },
  ];
  return { dates, baseBalance, floorMinor, bills, lagDays: 0, lateInterestBp: 500 };
}

test('[FINDING R3-H1] pure: the no-consent optimum is the best no-late schedule, not the local-search incumbent labelled proven', () => {
  const inst = knapsackInstance();
  const consent = optimisePaymentPlan({ ...inst, allowLate: true });
  // Control: the full problem finds CHF 3.00 with NO bill late, so that schedule is inside the
  // no-consent option set too.
  assert.equal(consent.objectiveMinor, 300);
  assert.equal(consent.daysLateTotal, 0);
  const strict = optimisePaymentPlan({ ...inst, allowLate: false });
  assert.equal(strict.daysLateTotal, 0);
  assert.equal(
    strict.objectiveMinor,
    300,
    `no-consent mode answered ${strict.objectiveMinor} as '${strict.optimality}' after ${strict.nodesExplored} nodes; ` +
      `the no-late optimum is 300 (upperBoundMinor claimed ${strict.upperBoundMinor})`,
  );
});

test('[FINDING R3-H1] registry: the default proposal (no acceptLatePayments) claims proven and misses a Skonto no late bill stands in the way of', () => {
  const w = emptyBook(depsAt('2026-07-01T08:00:00.000Z'));
  w.call('post_entry', {
    date: '2026-07-01',
    source: 'manual',
    idempotencyKey: 'capital',
    lines: [
      { account: w.accId('1020'), debit: 5_000_000 },
      { account: w.accId('2800'), credit: 5_000_000 },
    ],
  });
  // CHF 20'000 in on 20.7. (a planned flow on this account).
  const inflow = w.call('liquidity_flow_set', {
    label: 'Anzahlung Projekt',
    direction: 'in',
    amountMinor: 2_000_000,
    currency: 'CHF',
    firstDate: '2026-07-20',
    recurrence: 'once',
    bankAccountId: w.bankAccountId,
    idempotencyKey: 'in',
  });
  assert.equal(inflow.ok, true, JSON.stringify(inflow));
  const v = w.vendor('Muster Lieferungen AG', 'v1');
  const big = w.bill(v, '2026-06-30', '2026-07-30', 1_000_000, 'big');
  const s1 = w.bill(v, '2026-06-30', '2026-07-30', 500_000, 's1');
  const s2 = w.bill(v, '2026-06-30', '2026-07-30', 500_000, 's2');
  for (const [id, bp, key] of [[big, 200, 'k1'], [s1, 300, 'k2'], [s2, 300, 'k3']]) {
    const r = w.call('liquidity_skonto_set', { vendorBillId: id, rateBp: bp, untilDate: '2026-07-10', idempotencyKey: key });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  // Headroom before 20.7.: CHF 10'000 over a CHF 40'000 floor.
  const withConsent = w.call('liquidity_plan_propose', { floorMinor: 4_000_000, acceptLatePayments: true, bankAccountIds: [w.bankAccountId], idempotencyKey: 'c' });
  assert.equal(withConsent.ok, true, JSON.stringify(withConsent));
  assert.equal(withConsent.plan.daysLateTotal, 0, 'control: the better schedule makes no bill late');
  assert.equal(withConsent.plan.skontoCapturedMinor, 30_000);
  const strict = w.call('liquidity_plan_propose', { floorMinor: 4_000_000, bankAccountIds: [w.bankAccountId], idempotencyKey: 's' });
  assert.equal(strict.ok, true, JSON.stringify(strict));
  assert.equal(
    strict.plan.skontoCapturedMinor,
    30_000,
    `the default proposal captures ${strict.plan.skontoCapturedMinor} and says optimality '${strict.plan.optimality}' ` +
      `(Studio: "Bester Vorschlag für diesen Mindestbestand (nachgewiesen)") after ${strict.plan.nodesExplored} nodes`,
  );
});

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

test('[FINDING R3-H1] brute force: every no-consent answer labelled proven is optimal (3 to 5 bills, clustered due dates)', () => {
  const rand = mulberry32(0x5eed3);
  let checked = 0;
  let controls = 0;
  const wrong = [];
  for (let n = 0; n < 400 && checked < 150; n += 1) {
    const asOf = ['2026-07-01', '2026-03-02', '2026-11-02'][n % 3];
    const T = 21;
    const dates = horizonDates(asOf, T);
    const lag = n % 2;
    const clearing = dates.filter(isClearingDay);
    const first = clearing[0];
    const end = dates[T - 1];
    const dueA = plus(asOf, 14 + Math.floor(rand() * 4));
    const nb = 3 + Math.floor(rand() * 3);
    const bills = [];
    for (let i = 0; i < nb; i += 1) {
      const due = rand() < 0.7 ? dueA : plus(asOf, 14 + Math.floor(rand() * 4));
      bills.push({
        id: `b${i}`,
        openMinor: 20_000 + Math.round(rand() * 80_000),
        dueDate: due,
        skontoRateBp: 100 + Math.floor(rand() * 300),
        skontoUntil: plus(asOf, 4 + Math.floor(rand() * 5)),
      });
    }
    // Tight headroom early, an inflow of every bill's amount on day 10: the on-time schedule always fits.
    const total = bills.reduce((s, b) => s + b.openMinor, 0);
    const early = Math.round(total * (0.25 + rand() * 0.4));
    const floorMinor = 500_000;
    const baseBalance = dates.map((d) => floorMinor + early + (d >= plus(asOf, 10) ? total : 0));
    const r = optimisePaymentPlan({ dates, baseBalance, floorMinor, bills, lagDays: lag, lateInterestBp: 500, allowLate: false });
    if (r.optimality !== 'proven') continue;
    checked += 1;
    // Brute force over every clearing day that makes no bill late.
    const opts = bills.map((b) => {
      const until = b.skontoUntil < b.dueDate ? b.skontoUntil : b.dueDate;
      const K = skontoMinor(b.openMinor, b.skontoRateBp);
      const days = clearing.filter((x) => addClearingDays(x, lag) <= b.dueDate);
      return days.map((x) => {
        const arr = addClearingDays(x, lag);
        const cap = arr <= until ? K : 0;
        return { day: daysBetween(asOf, x), cash: b.openMinor - cap, value: cap };
      });
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
        if (value > best) best = value;
        return;
      }
      for (const o of opts[i]) {
        paid[o.day] += o.cash;
        rec(i + 1, value + o.value);
        paid[o.day] -= o.cash;
      }
    };
    rec(0, 0);
    // Control, against the author's own full-problem search: it may only do better (it may also make
    // a bill late), and where its proven answer makes no bill late it IS the no-late optimum.
    const full = optimisePaymentPlan({ dates, baseBalance, floorMinor, bills, lagDays: lag, lateInterestBp: 500, allowLate: true });
    assert.ok(best <= full.objectiveMinor, `instance ${n}: the brute force beats the full problem`);
    if (full.optimality === 'proven' && full.daysLateTotal === 0) {
      assert.equal(best, full.objectiveMinor, `instance ${n}: brute force disagrees with the full problem's no-late optimum`);
      controls += 1;
    }
    if (r.objectiveMinor !== best) wrong.push({ n, proposed: r.objectiveMinor, optimum: best, nodes: r.nodesExplored });
  }
  assert.ok(controls >= 50, `only ${controls} control instances`);
  assert.ok(checked >= 100, `only ${checked} proven instances`);
  assert.deepEqual(wrong.slice(0, 3), [], `${wrong.length} of ${checked} 'proven' no-consent answers are not optimal`);
});

// =================================================================================================
// R3-M1: the R2-M1 attribution dates an opening balance's MWST liability with the NEXT period
// =================================================================================================

test('[FINDING R3-M1] a year-start opening balance on 2200 (the Q4 tax, due 1.3.) is not moved to Q1 (due 30.5.) or out of the horizon', () => {
  const w = emptyBook(depsAt('2026-02-10T08:00:00.000Z'));
  // The adoption path: set_opening_balances at the fiscal-year start (its default asOf). The open
  // Q4/2025 tax of CHF 8'000 arrives on 2200 with no tax code, as every opening position does.
  const ob = w.call('set_opening_balances', {
    idempotencyKey: 'ob',
    lines: [
      { account: '1020', debitMinor: 5_000_000 },
      { account: '2200', creditMinor: 800_000 },
      { account: '2800', creditMinor: 4_200_000 },
    ],
  });
  assert.equal(ob.ok, true, JSON.stringify(ob));
  const f = w.call('liquidity_forecast', {});
  assert.equal(f.ok, true, JSON.stringify(f));
  const vat = f.flows.filter((x) => x.kind === 'vat').map((x) => [x.date, x.amountMinor, x.ref, x.provenance]);
  // Q4/2025 ends 31.12.2025 and is due 60 days later, 1.3.2026 (a Sunday): the ESTV debit lands by 27.2.
  const byDue = vat.filter(([date, amount]) => date <= '2026-03-02' && amount <= -800_000);
  assert.ok(
    byDue.length === 1,
    `the Q4 liability on the opening balance is forecast as ${JSON.stringify(vat)} ` +
      `(excluded: ${JSON.stringify(f.excluded.filter((e) => e.kind === 'vat'))}), not by its due date`,
  );
});

test('[FINDING R3-M1] a mid-year cutover (opening on 1.7. with the Q2 tax) forecasts that tax by 29.8., not 29.11.', () => {
  const w = emptyBook(depsAt('2026-07-16T08:00:00.000Z'));
  const ob = w.call('set_opening_balances', {
    asOf: '2026-07-01',
    idempotencyKey: 'ob',
    lines: [
      { account: '1020', debitMinor: 5_000_000 },
      { account: '2200', creditMinor: 600_000 },
      { account: '2800', creditMinor: 4_400_000 },
    ],
  });
  assert.equal(ob.ok, true, JSON.stringify(ob));
  const f = w.call('liquidity_forecast', { horizonDays: 180 });
  assert.equal(f.ok, true, JSON.stringify(f));
  const vat = f.flows.filter((x) => x.kind === 'vat').map((x) => [x.date, x.amountMinor, x.ref, x.provenance]);
  const byQ2Due = vat.filter(([date, amount]) => date <= '2026-08-31' && amount <= -600_000);
  assert.ok(byQ2Due.length === 1, `the Q2 liability carried on the 1.7. opening is forecast as ${JSON.stringify(vat)}`);
});

// =================================================================================================
// R3-L1: the effektiv attribution never looks at what already left the books (the conservative direction)
// =================================================================================================

test('[FINDING R3-L1] an untagged MWST correction that was reversed is not still debited with its period', () => {
  const w = emptyBook(depsAt('2026-07-16T08:00:00.000Z'));
  w.call('post_entry', { date: '2026-07-01', source: 'manual', idempotencyKey: 'cap', lines: [{ account: w.accId('1020'), debit: 5_000_000 }, { account: w.accId('2800'), credit: 5_000_000 }] });
  const wrong = w.call('post_entry', { date: '2026-07-02', source: 'manual', description: 'Korrektur MWST (falsch)', idempotencyKey: 'x', lines: [{ account: w.accId('1020'), debit: 400_000 }, { account: w.accId('2200'), credit: 400_000 }] });
  assert.equal(wrong.ok, true, JSON.stringify(wrong));
  const rev = w.call('reverse_entry', { entryId: wrong.entryId, idempotencyKey: 'rx' });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  const f = w.call('liquidity_forecast', { horizonDays: 180 });
  const vat = f.flows.filter((x) => x.kind === 'vat').map((x) => [x.date, x.amountMinor, x.ref, x.provenance]);
  assert.deepEqual(vat, [], 'the ledger owes nothing on 2200, yet the reversed correction is still forecast');
});

test('[FINDING R3-L1] Q2 tax already paid to the ESTV before its due date is not debited a second time on the due date', () => {
  const w = emptyBook(depsAt('2026-08-12T08:00:00.000Z'));
  w.call('post_entry', { date: '2026-04-01', source: 'manual', idempotencyKey: 'cap', lines: [{ account: w.accId('1020'), debit: 5_000_000 }, { account: w.accId('2800'), credit: 5_000_000 }] });
  const sale = w.call('post_entry', {
    date: '2026-05-15',
    source: 'manual',
    idempotencyKey: 'sale',
    lines: [
      { account: w.accId('1020'), debit: 1_081_000 },
      { account: w.accId('3200'), credit: 1_000_000, taxCode: 'UST81', taxBase: 1_000_000, taxAmount: 81_000 },
      { account: w.accId('2200'), credit: 81_000 },
    ],
  });
  assert.equal(sale.ok, true, JSON.stringify(sale));
  const paid = w.call('post_entry', { date: '2026-08-10', source: 'manual', description: 'ESTV MWST Q2', idempotencyKey: 'estv', lines: [{ account: w.accId('2200'), debit: 81_000 }, { account: w.accId('1020'), credit: 81_000 }] });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  const f = w.call('liquidity_forecast', { horizonDays: 60 });
  const vat = f.flows.filter((x) => x.kind === 'vat').map((x) => [x.date, x.amountMinor, x.ref, x.provenance]);
  assert.deepEqual(vat, [], 'the bank balance already carries the ESTV payment, and the forecast debits Q2 again');
});
