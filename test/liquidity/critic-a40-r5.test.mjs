/**
 * A40 critic round 5 (non-author, 01.10.2026): probes against the round-4 remediation at 6f7d1318
 * (R4-M1 owner decision: MWST A07 cannot date is debited conservatively and shown; R4-M2 counted and
 * wall-clock budgets with a 48-late-day cap; R4-L1 the no-consent search before refusing; R4-L2 the
 * credit add-back capped at the open Vorsteuer).
 *
 * `[FINDING]` tests reproduce a defect and fail on the head until it is fixed; `[HOLDS]` tests pin a
 * property that was attacked and held. Every fixture is SYNTHETIC by construction: invented names,
 * the SIX sample IBAN, invented amounts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { optimisePaymentPlan, horizonDates, lastExecutionFor, clearingDayOnOrAfter } from '../../dist/core/liquidity/index.js';
import { critSolve, critAudit, dayAdd } from './critic-a40-r4-bruteforce.mjs';

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
  const post = (date, key, lines) => {
    const r = call('post_entry', { date, source: 'manual', idempotencyKey: key, lines });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  };
  return { deps, workspaceId, call, at, accId, post, bankAccountId: bank.bankAccountId };
}

/** A tagged sale of `tax` output tax at 8.1 %, paid by the customer on `paidOn` (or not at all). */
function sale(w, date, paidOn, tax, key) {
  const net = (tax / 81) * 1_000;
  w.post(date, `${key}-s`, [
    { account: w.accId('1100'), debit: net + tax },
    { account: w.accId('3200'), credit: net, taxCode: 'UST81', taxBase: net, taxAmount: tax },
    { account: w.accId('2200'), credit: tax },
  ]);
  if (paidOn !== null) {
    w.post(paidOn, `${key}-p`, [
      { account: w.accId('1020'), debit: net + tax },
      { account: w.accId('1100'), credit: net + tax },
    ]);
  }
}
/** A tagged purchase on credit (not paid): its Vorsteuer on 1170. */
function purchaseOnCredit(w, date, tax, key) {
  const net = (tax / 81) * 1_000;
  w.post(date, key, [
    { account: w.accId('6500'), debit: net, taxCode: 'VST-M', taxBase: net, taxAmount: tax },
    { account: w.accId('1170'), debit: tax },
    { account: w.accId('2000'), credit: net + tax },
  ]);
}
const toEstv = (w, date, amount, key) =>
  w.post(date, key, [
    { account: w.accId('2200'), debit: amount },
    { account: w.accId('1020'), credit: amount },
  ]);

const vatFlows = (f) => f.flows.filter((x) => x.kind === 'vat').map((x) => [x.date, x.amountMinor, x.ref, x.provenance]);

// =================================================================================================
// R5-M1: under Ist, the "conservative" claim nets Vorsteuer the ESTV does not yet allow
// =================================================================================================

test('[FINDING R5-M1] Ist: Vorsteuer on an UNPAID bill is netted against the quarter, so the "conservative" debit is half the tax the ESTV collects', () => {
  const w = book(depsAt('2026-07-16T08:00:00.000Z'), { timing: 'ist' });
  // Q2: a sale with CHF 8'100 MWST, paid by the customer in Q2; a supplier bill with CHF 4'050 Vorsteuer,
  // NOT paid. Under vereinnahmte Entgelte the Vorsteuer is deductible only once the bill is paid
  // (MWSTG Art. 40 Abs. 1 lit. b), so Q2 owes CHF 8'100 by 29.8. (Art. 86 Abs. 1).
  sale(w, '2026-05-10', '2026-05-20', 810_000, 'q2');
  purchaseOnCredit(w, '2026-06-10', 405_000, 'bill');
  const f = w.call('liquidity_forecast', { horizonDays: 90 });
  assert.equal(f.ok, true, JSON.stringify(f));
  const q2 = f.flows.filter((x) => x.kind === 'vat' && x.ref === '2026-Q2').reduce((s, x) => s - x.amountMinor, 0);
  assert.ok(
    q2 >= 810_000,
    `Q2 debited ${q2} (flows ${JSON.stringify(vatFlows(f))}); conservative line ${JSON.stringify(f.conservative)}: ` +
      'the line says "vorsichtshalber abgezogen" while it is CHF 4\'050 short',
  );
});

// =================================================================================================
// R5-M2: Saldo + Ist: every refused past period is debited TODAY in full, paid or not, and with
// consent that phantom stops every payment in the horizon
// =================================================================================================

test('[FINDING R5-M2] Saldo with Ist: periods already paid to the ESTV are debited again today, the proposal refuses, and with consent it defers a bill that fits', () => {
  const aug25 = depsAt('2025-08-10T08:00:00.000Z');
  const w = book(aug25, { saldo: true, timing: 'ist' });
  w.post('2025-08-11', 'capital', [
    { account: w.accId('1020'), debit: 3_000_000 },
    { account: w.accId('2800'), credit: 3_000_000 },
  ]);
  sale(w, '2025-08-12', '2025-08-20', 810_000, 'h2');
  toEstv(w, '2026-02-27', 810_000, 'pay-h2'); // 2025-H2, due 1.3.2026: paid
  sale(w, '2026-03-12', '2026-03-20', 810_000, 'h1');
  toEstv(w, '2026-08-25', 810_000, 'pay-h1'); // 2026-H1, due 29.8.2026: paid
  // The bank now holds CHF 230'000; nothing is owed to the ESTV (2200 is back to zero).
  const sep = { ...aug25, clock: fixedClock('2026-09-10T08:00:00.000Z') };
  const call = w.at(sep);
  const v = call('create_contact', { partyRole: 'vendor', name: 'Muster Papier AG', idempotencyKey: 'v' }).contact.id;
  const bill = call('record_expense', {
    vendorId: v,
    billDate: '2026-09-01',
    dueDate: '2026-09-30',
    amountMinor: 500_000,
    amountIsGross: true,
    currency: 'CHF',
    taxCode: 'none',
    expenseAccountId: w.accId('6500'),
    vendorReference: 'RE-9',
    idempotencyKey: 'b',
  });
  const f = call('liquidity_forecast', { horizonDays: 60 });
  assert.equal(f.ok, true, JSON.stringify(f));
  const strict = call('liquidity_plan_propose', { floorMinor: 22_000_000, idempotencyKey: 'p' });
  const withConsent = call('liquidity_plan_propose', { floorMinor: 22_000_000, acceptLatePayments: true, idempotencyKey: 'c' });
  assert.deepEqual(
    vatFlows(f),
    [],
    `phantom MWST today: ${JSON.stringify(vatFlows(f))}; default proposal: ${strict.ok ? 'ok' : strict.error}; ` +
      `with consent the bill (${bill.ok ? 'recorded' : JSON.stringify(bill)}) is ${JSON.stringify(withConsent.plan?.lines?.map((l) => [l.option, l.reason, l.daysLate]))}`,
  );
});

// =================================================================================================
// R5-M3: past the wall clock before the first leaf, the consent baseline is "defer every bill", and
// the polish gets no time: every bill late for nothing
// =================================================================================================

function crowdedBook(n, T, allowLate, inflowShare = 0.6) {
  let s = 12345;
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
    const due = dayAdd(asOf, Math.floor(r() * T * 0.6) - 5);
    const sk = r() < 0.5;
    bills.push({ id: `b${String(i).padStart(5, '0')}`, openMinor: A, dueDate: due, skontoRateBp: sk ? 200 : 0, skontoUntil: sk ? dayAdd(due, -20) : null });
  }
  const floorMinor = 1_000_000;
  const baseBalance = [];
  let bal = floorMinor + total * 0.1;
  for (let t = 0; t < T; t += 1) {
    bal += ((total * inflowShare) / T) * (0.5 + r());
    baseBalance.push(Math.round(bal));
  }
  return { dates, baseBalance, floorMinor, bills, lagDays: 1, lateInterestBp: 500, allowLate };
}

/** Late or deferred-late lines whose own on-time day fits with every other line where it is. */
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
  const out = [];
  for (const l of res.lines) {
    if (l.option.daysLate === 0) continue;
    const b = inst.bills.find((x) => x.id === l.billId);
    const on = lastExecutionFor(b.dueDate, inst.lagDays);
    if (on < first || !idx.has(on)) continue;
    const p = paid.slice();
    if (l.option.date !== null) p[idx.get(l.option.date)] -= l.option.cashMinor;
    p[idx.get(on)] += b.openMinor;
    if (ok(p)) out.push(`${l.billId}:${l.reason}`);
  }
  return out;
}

test('[FINDING R5-M3] 800 bills over 180 days with consent: the wall clock ends the search before its first leaf and the answer defers EVERY bill, most of them late for nothing', (t) => {
  const inst = crowdedBook(800, 180, true);
  const t0 = performance.now();
  const res = optimisePaymentPlan(inst);
  const ms = Math.round(performance.now() - t0);
  const wasted = lateForNothing(inst, res);
  const deferred = res.lines.filter((l) => l.option.kind === 'defer').length;
  const reasons = [...new Set(wasted.map((x) => x.split(':')[1]))];
  t.diagnostic(`${ms} ms, ${res.optimality}, ${res.nodesExplored} nodes, ${deferred} of ${res.lines.length} deferred, ${wasted.length} late for nothing (reasons ${reasons})`);
  // The round-4 head (no wall clock, uncounted polish) answered this in 235 s with 219 deferred and none
  // late for nothing. Owner rule since round 1 (critic H1): a bill is never late for nothing.
  assert.equal(wasted.length, 0, `${wasted.length} bills late although their on-time day fits; reasons ${reasons}`);
});

test('[FINDING R5-M3] 2000 bills over 180 days: the 2.5 s backstop does not bound the time (the option preparation and the hull run before any check)', (t) => {
  const inst = crowdedBook(2000, 180, true);
  const t0 = performance.now();
  const res = optimisePaymentPlan(inst);
  const ms = Math.round(performance.now() - t0);
  t.diagnostic(`${ms} ms, ${res.optimality}, ${res.nodesExplored} nodes`);
  assert.ok(ms < 5_000, `held the thread for ${ms} ms against a 2'500 ms backstop`);
});

// =================================================================================================
// R5-L1: without consent the late-day cap marks an EXACT search heuristic, with a gap of zero
// =================================================================================================

test('[FINDING R5-L1] without consent the 48-late-day cap labels a complete search "heuristic" with a zero gap ("nicht als optimal nachgewiesen ... höchstens CHF 0.00 mehr")', () => {
  const inst = crowdedBook(300, 180, false, 3);
  const res = optimisePaymentPlan(inst);
  // No late option is admissible without consent except an overdue bill's first late day, which the cap
  // always keeps: the cap removes nothing the search could use.
  assert.ok(
    res.optimality === 'proven' || res.upperBoundMinor > res.objectiveMinor,
    `optimality ${res.optimality}, objective ${res.objectiveMinor}, upper bound ${res.upperBoundMinor}, nodes ${res.nodesExplored}`,
  );
});

// =================================================================================================
// R5-L2: R4-L2 is closed only when 1170 holds nothing else
// =================================================================================================

test('[FINDING R5-L2] a refunded Vorsteuer credit plus ordinary Vorsteuer of the running quarter: the paid Q2 is debited again as "vat_overdue", and not as a conservative line', () => {
  const w = book(depsAt('2026-09-15T08:00:00.000Z'));
  w.post('2026-01-02', 'capital', [
    { account: w.accId('1020'), debit: 50_000_000 },
    { account: w.accId('2800'), credit: 50_000_000 },
  ]);
  purchaseOnCredit(w, '2026-02-10', 405_000, 'q1'); // Q1: a Vorsteuerüberschuss of CHF 4'050 ...
  w.post('2026-06-15', 'refund', [
    { account: w.accId('1020'), debit: 405_000 },
    { account: w.accId('1170'), credit: 405_000 },
  ]); // ... refunded on 15.6.
  sale(w, '2026-05-10', '2026-05-20', 810_000, 'q2');
  toEstv(w, '2026-08-25', 810_000, 'q2-estv'); // Q2 paid before its due date
  sale(w, '2026-09-02', null, 162_000, 'q3'); // Q3 so far: CHF 1'620 output, CHF 810 Vorsteuer
  purchaseOnCredit(w, '2026-09-05', 81_000, 'q3-bill');
  const f = w.call('liquidity_forecast', { horizonDays: 60 });
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.deepEqual(vatFlows(f).filter((x) => x[2] === '2026-Q2'), [], `Q2 was paid; conservative lines ${JSON.stringify(f.conservative)}`);
});

// =================================================================================================
// Held
// =================================================================================================

test('[HOLDS] Ist (effektiv): a period paid before its due date is not debited twice; an opening position is debited by its period\'s due date and shown', () => {
  const a = book(depsAt('2026-08-27T08:00:00.000Z'), { timing: 'ist' });
  sale(a, '2026-05-10', '2026-05-20', 810_000, 'q2');
  toEstv(a, '2026-08-25', 810_000, 'pay');
  const fa = a.call('liquidity_forecast', { horizonDays: 90 });
  assert.deepEqual(vatFlows(fa), []);
  assert.deepEqual(fa.conservative, []);

  const b = book(depsAt('2026-02-10T08:00:00.000Z'), { timing: 'ist' });
  const ob = b.call('set_opening_balances', {
    idempotencyKey: 'ob',
    lines: [
      { account: '1020', debitMinor: 5_000_000 },
      { account: '2200', creditMinor: 800_000 },
      { account: '2800', creditMinor: 4_200_000 },
    ],
  });
  assert.equal(ob.ok, true, JSON.stringify(ob));
  const fb = b.call('liquidity_forecast', {});
  assert.deepEqual(vatFlows(fb).map((x) => [x[0], x[1], x[2]]), [[lastExecutionFor('2026-03-01', 1), -800_000, '2025-Q4']]);
  assert.equal(fb.conservative.length, 1);
  assert.equal(fb.conservative[0].reason, 'vat_return_refused');
  assert.equal(fb.conservative[0].amountMinor, 800_000);
  const p = b.call('liquidity_plan_propose', { floorMinor: 0, idempotencyKey: 'p' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual(p.plan.conservative, fb.conservative, 'the proposal carries the same line');
});

test('[HOLDS] near the 48-late-day cap (3 bills, one rise every clearing day, consent): a capped answer is heuristic, its bounds hold against the critic brute force, and uncapped answers stay exact', (t) => {
  let capped = 0;
  let proven = 0;
  for (let n = 0; n < 24; n += 1) {
    const asOf = ['2026-07-01', '2026-03-02', '2026-09-14'][n % 3];
    const T = 70 + (n % 4) * 8; // 50 to 70 clearing days: around the cap
    const dates = horizonDates(asOf, T);
    const floorMinor = 0;
    // A rise on every day, so every clearing day after a due date is a late candidate.
    const baseBalance = dates.map((_, i) => 20_000 + i * (300 + (n % 5) * 50));
    const bills = [0, 1, 2].map((i) => ({
      id: `c${i}`,
      openMinor: 15_000 + ((n * 7 + i * 13) % 9) * 2_000,
      dueDate: dayAdd(asOf, i),
      skontoRateBp: i === 2 ? 300 : 0,
      skontoUntil: i === 2 ? asOf : null,
    }));
    const inst = { dates, baseBalance, floorMinor, bills, lagDays: n % 2, lateInterestBp: [500, 2000][n % 2], allowLate: true };
    const res = optimisePaymentPlan(inst);
    const truth = critSolve(inst, 20_000_000);
    assert.deepEqual(critAudit(inst, res), []);
    if (res.optimality === 'proven') {
      proven += 1;
      assert.equal(res.objectiveMinor, truth.value);
      assert.equal(res.daysLateTotal, truth.late);
    } else {
      capped += 1;
      assert.ok(res.upperBoundMinor >= truth.value, `bound ${res.upperBoundMinor} under the optimum ${truth.value}`);
      assert.ok(res.lateDaysLowerBound <= truth.minLateAny);
    }
  }
  t.diagnostic(`capped/heuristic ${capped}, proven ${proven}`);
  assert.ok(capped > 0, 'some instances do hit the cap');
});
