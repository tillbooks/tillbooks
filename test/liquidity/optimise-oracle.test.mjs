/**
 * A40 rebuild (30.09.2026): the optimiser against the ORACLE (`oracle.mjs`, a plain brute force over
 * every clearing day), on seeded random instances.
 *
 * The property: whenever the optimiser says `proven`, its worth AND its days late equal the oracle's
 * lexicographic optimum; every answer, proven or heuristic, re-prices line by line and keeps the floor
 * day by day under the oracle's own arithmetic; a heuristic answer states a finite bound the optimum
 * never exceeds and a lateness floor no schedule beats; an instance the oracle proves infeasible
 * without consent is refused, never answered.
 *
 * The instances are built to be hard where the round-3 critic found the defect: 3 to 8 bills, most of
 * them due on ONE day (clustered), Skonto windows before a single inflow, tight headroom (10 to 70 % of
 * the bills' total), both consent levels, lag 0 and 1, default interest 0, 500 and 2'000 bp, and
 * deliberate ties (a bill identical to the one before it). Every fixture is SYNTHETIC by construction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { optimisePaymentPlan, horizonDates } from '../../dist/core/liquidity/index.js';
import { bruteForce, auditAnswer, mulberry32, plusDays, singleMoveImprovements } from './oracle.mjs';

/** The horizon shrinks as the bill count grows, so the oracle's enumeration stays plain AND quick. */
const HORIZON = { 3: 24, 4: 18, 5: 14, 6: 11, 7: 9, 8: 8 };
const PER_SIZE = { 3: 150, 4: 150, 5: 120, 6: 90, 7: 50, 8: 50 };

function instance(rand, nb, n) {
  const T = HORIZON[nb];
  const asOf = ['2026-07-01', '2026-03-30', '2026-12-21', '2026-05-11'][n % 4]; // incl. Easter and Christmas
  const dates = horizonDates(asOf, T);
  const inflowAt = 2 + Math.floor(rand() * Math.max(1, Math.floor(T * 0.4)));
  const cluster = plusDays(asOf, inflowAt + 1 + Math.floor(rand() * 3));
  const bills = [];
  for (let i = 0; i < nb; i += 1) {
    const prev = bills[i - 1];
    if (prev !== undefined && rand() < 0.2) {
      bills.push({ ...prev, id: `b${i}` }); // a tie: the same bill twice
      continue;
    }
    const dueDate = rand() < 0.7 ? cluster : plusDays(asOf, rand() < 0.15 ? -2 : inflowAt + 1 + Math.floor(rand() * (T - inflowAt + 3)));
    const withSkonto = rand() < 0.8;
    bills.push({
      id: `b${i}`,
      openMinor: 10_000 + Math.round(rand() * 90_000),
      dueDate,
      skontoRateBp: withSkonto ? 100 + Math.floor(rand() * 300) : 0,
      skontoUntil: withSkonto ? plusDays(asOf, Math.floor(rand() * (inflowAt + 2))) : null,
    });
  }
  const total = bills.reduce((s, b) => s + b.openMinor, 0);
  const early = Math.round(total * (0.1 + rand() * 0.6));
  const floorMinor = 200_000;
  const inflowDay = plusDays(asOf, inflowAt);
  const baseBalance = dates.map((d) => floorMinor + early + (d >= inflowDay ? total : 0));
  return {
    dates,
    baseBalance,
    floorMinor,
    bills,
    lagDays: n % 3 === 0 ? 0 : 1,
    lateInterestBp: [500, 0, 2000][n % 3],
    allowLate: rand() < 0.5,
  };
}

test('oracle: every proven answer equals the brute-force optimum in worth AND days late (3 to 8 bills, both consent levels)', (t) => {
  const rand = mulberry32(0xa40_0e);
  const tally = {};
  let proven = 0;
  let refused = 0;
  let floorBinding = 0;
  let withLate = 0;
  let ties = 0;
  for (const nb of [3, 4, 5, 6, 7, 8]) {
    tally[nb] = { consent: 0, noConsent: 0 };
    for (let n = 0; n < PER_SIZE[nb]; n += 1) {
      const inst = instance(rand, nb, n);
      const truth = bruteForce(inst);
      if (!truth.feasible) {
        // Without consent no schedule keeps the floor: the optimiser refuses rather than answering.
        assert.equal(inst.allowLate, false, `size ${nb} #${n}: with consent deferring every bill always fits`);
        assert.throws(() => optimisePaymentPlan(inst), /no admissible schedule/);
        refused += 1;
        continue;
      }
      const r = optimisePaymentPlan(inst);
      assert.deepEqual(auditAnswer(inst, r), [], `size ${nb} #${n}: the answer does not re-price or breaks the floor`);
      assert.ok(Number.isSafeInteger(r.upperBoundMinor) && r.upperBoundMinor >= truth.value, `size ${nb} #${n}: bound ${r.upperBoundMinor} vs ${truth.value}`);
      assert.equal(r.optimality, 'proven', `size ${nb} #${n}: small instances complete inside the budget`);
      assert.equal(r.objectiveMinor, truth.value, `size ${nb} #${n}: worth ${r.objectiveMinor}, the oracle's optimum ${truth.value}`);
      assert.equal(r.daysLateTotal, truth.late, `size ${nb} #${n}: days late ${r.daysLateTotal}, the oracle's ${truth.late}`);
      if (inst.allowLate === false) assert.equal(r.daysLateTotal, truth.minLateAny, 'without consent nobody is later than they must be');
      proven += 1;
      tally[nb][inst.allowLate ? 'consent' : 'noConsent'] += 1;
      if (r.lines.some((l) => l.reason === 'skonto_forgone_floor' || l.reason === 'late_floor' || l.reason === 'deferred_floor')) floorBinding += 1;
      if (r.daysLateTotal > 0) withLate += 1;
      if (inst.bills.some((b, i) => i > 0 && b.openMinor === inst.bills[i - 1].openMinor && b.dueDate === inst.bills[i - 1].dueDate)) ties += 1;
    }
  }
  // Non-vacuous: every size in both modes, a binding floor, late payments, ties and refusals all occur.
  for (const nb of Object.keys(tally)) {
    assert.ok(tally[nb].consent >= 10 && tally[nb].noConsent >= 10, `size ${nb}: ${JSON.stringify(tally[nb])}`);
  }
  assert.ok(proven >= 450, `only ${proven} instances compared`);
  assert.ok(floorBinding >= 150, `only ${floorBinding} instances had a binding floor`);
  assert.ok(withLate >= 40, `only ${withLate} instances paid a bill late`);
  assert.ok(ties >= 100, `only ${ties} instances carried a tie`);
  assert.ok(refused >= 20, `only ${refused} infeasible no-consent instances`);
  t.diagnostic(`compared ${proven} proven answers to the oracle (per size ${JSON.stringify(tally)}), refused ${refused} infeasible no-consent instances; binding floor ${floorBinding}, late ${withLate}, ties ${ties}`);
});

test('oracle: past the budget the answer is heuristic, never proven, with a finite bound and a lateness floor that hold', (t) => {
  const rand = mulberry32(0xb0_0d);
  let heuristic = 0;
  for (const nb of [4, 5, 6, 7]) {
    for (let n = 0; n < 40; n += 1) {
      const inst = instance(rand, nb, n);
      const truth = bruteForce(inst);
      if (!truth.feasible) continue;
      for (const nodeBudget of [1, 3]) {
        const r = optimisePaymentPlan({ ...inst, nodeBudget });
        assert.deepEqual(auditAnswer(inst, r), [], `size ${nb} #${n} budget ${nodeBudget}`);
        assert.ok(r.objectiveMinor <= truth.value, 'no answer beats the optimum');
        assert.ok(Number.isSafeInteger(r.upperBoundMinor), `a finite bound, not ${r.upperBoundMinor}`);
        assert.ok(r.upperBoundMinor >= truth.value, `size ${nb} #${n}: bound ${r.upperBoundMinor} under the optimum ${truth.value}`);
        if (r.optimality === 'proven') {
          assert.equal(r.objectiveMinor, truth.value);
          assert.equal(r.daysLateTotal, truth.late);
        } else {
          assert.equal(r.optimality, 'heuristic');
          assert.ok(r.lateDaysLowerBound <= truth.minLateAny, `size ${nb} #${n}: lateness floor ${r.lateDaysLowerBound} above ${truth.minLateAny}`);
          // R5-M3: a heuristic answer leaves no line that a move of its own could improve.
          assert.deepEqual(singleMoveImprovements(inst, r), [], `size ${nb} #${n} budget ${nodeBudget}`);
          heuristic += 1;
        }
      }
    }
  }
  assert.ok(heuristic >= 100, `only ${heuristic} heuristic answers exercised`);
  t.diagnostic(`${heuristic} heuristic answers checked against the oracle`);
});

// =================================================================================================
// Through the registry, per currency: CHF and EUR books, each checked against the oracle separately.
// =================================================================================================

const IBAN_CHF = 'CH93 0076 2011 6238 5295 7';
const IBAN_EUR = 'CH56 0483 5012 3456 7800 9';

function book(asOfIso) {
  const deps = { store: new SqliteStore({ clock: fixedClock(asOfIso) }), clock: fixedClock(asOfIso), ids: sequenceIdGen(), actor: 'studio' };
  const ws = getAction('create_workspace').run(deps, { name: 'Beispiel Werkstatt GmbH', idempotencyKey: 'ws' });
  assert.equal(ws.ok, true, JSON.stringify(ws));
  const workspaceId = ws.workspaceId;
  const call = (name, input = {}) => getAction(name).run(deps, { workspaceId, ...input });
  const accId = (n) => deps.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  call('vat_seed_defaults', {});
  call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  return { deps, call, accId };
}

function registryCase(currency, seed, allowLate) {
  const rand = mulberry32(seed);
  const asOf = '2026-07-06';
  const w = book(`${asOf}T08:00:00.000Z`);
  const iban = currency === 'CHF' ? IBAN_CHF : IBAN_EUR;
  const bank = w.call('create_bank_account', { name: `Konto ${currency}`, iban, currency, ledgerAccountId: w.accId('1020'), idempotencyKey: `bank-${currency}` });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  const nb = 3 + Math.floor(rand() * 3);
  const total = [];
  const specs = [];
  for (let i = 0; i < nb; i += 1) {
    const due = plusDays(asOf, 6 + Math.floor(rand() * 3));
    const amount = 100_000 + Math.round(rand() * 400_000);
    specs.push({ due, amount, rateBp: rand() < 0.8 ? 100 + Math.floor(rand() * 250) : 0, until: plusDays(asOf, 1 + Math.floor(rand() * 3)) });
    total.push(amount);
  }
  const sum = total.reduce((s, x) => s + x, 0);
  const early = Math.round(sum * (0.2 + rand() * 0.5));
  const floorMinor = 1_000_000;
  // Opening: floor plus the early headroom; an inflow of every bill's amount on day 4.
  if (currency === 'EUR') {
    const fx = w.call('record_exchange_rate', { baseCurrency: 'EUR', rate: '0.95', asOf: plusDays(asOf, -6), idempotencyKey: 'fx' });
    assert.equal(fx.ok, true, JSON.stringify(fx));
  }
  const cap = w.call('post_entry', {
    date: asOf,
    source: 'manual',
    idempotencyKey: 'cap',
    ...(currency === 'EUR' ? { currency: 'EUR' } : {}),
    lines: [{ account: w.accId('1020'), debit: floorMinor + early }, { account: w.accId('2800'), credit: floorMinor + early }],
  });
  assert.equal(cap.ok, true, JSON.stringify(cap));
  const inflow = w.call('liquidity_flow_set', { label: 'Anzahlung', direction: 'in', amountMinor: sum, currency, firstDate: plusDays(asOf, 4), recurrence: 'once', bankAccountId: bank.bankAccountId, idempotencyKey: 'in' });
  assert.equal(inflow.ok, true, JSON.stringify(inflow));
  const vendor = w.call('create_contact', { partyRole: 'vendor', name: 'Muster Metall AG', idempotencyKey: 'v' }).contact.id;
  const bills = specs.map((s, i) => {
    const r = w.call('record_expense', {
      vendorId: vendor,
      billDate: plusDays(asOf, -5),
      dueDate: s.due,
      amountMinor: s.amount,
      amountIsGross: true,
      currency,
      ...(currency === 'CHF' ? { taxCode: 'VST-M' } : {}),
      expenseAccountId: w.accId('6500'),
      vendorReference: `RE-${i}`,
      idempotencyKey: `bill-${i}`,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (s.rateBp > 0) {
      const t = w.call('liquidity_skonto_set', { vendorBillId: r.vendorBillId, rateBp: s.rateBp, untilDate: s.until, idempotencyKey: `sk-${i}` });
      assert.equal(t.ok, true, JSON.stringify(t));
    }
    return { id: r.vendorBillId, openMinor: s.amount, dueDate: s.due, skontoRateBp: s.rateBp, skontoUntil: s.rateBp > 0 ? s.until : null };
  });
  const params = { currency, horizonDays: 14, bankAccountIds: [bank.bankAccountId] };
  const f = w.call('liquidity_forecast', params);
  assert.equal(f.ok, true, JSON.stringify(f));
  // The base the optimiser sees: every flow except the undecided bills' default dates.
  const byDay = new Map();
  for (const x of f.flows) if (x.kind !== 'payable') byDay.set(x.date, (byDay.get(x.date) ?? 0) + x.amountMinor);
  let run = f.openingBalanceMinor;
  const dates = f.days.map((d) => d.date);
  const baseBalance = dates.map((d) => (run += byDay.get(d) ?? 0));
  const inst = { dates, baseBalance, floorMinor, bills, lagDays: 1, lateInterestBp: 500, allowLate };
  const p = w.call('liquidity_plan_propose', { ...params, floorMinor, acceptLatePayments: allowLate, idempotencyKey: 'p' });
  return { inst, p };
}

for (const currency of ['CHF', 'EUR']) {
  test(`oracle through liquidity_plan_propose, ${currency} books on their own: proven plans are the optimum`, (t) => {
    let compared = 0;
    for (let s = 0; s < 12; s += 1) {
      const allowLate = s % 2 === 0;
      const { inst, p } = registryCase(currency, 0x40_00 + s * 17 + (currency === 'EUR' ? 5 : 0), allowLate);
      const truth = bruteForce(inst);
      if (!p.ok) {
        // Only the owner decision may stop a proposal here: without consent, the on-time schedule breaks the floor.
        assert.equal(p.error, 'floor_breached_by_schedule', JSON.stringify(p));
        assert.equal(allowLate, false);
        continue;
      }
      assert.equal(p.plan.currency, currency);
      assert.equal(p.plan.optimality, 'proven', `${currency} #${s}`);
      assert.ok(truth.feasible, `${currency} #${s}: the oracle finds no schedule the plan says exists`);
      assert.equal(p.plan.objectiveMinor, truth.value, `${currency} #${s}: plan ${p.plan.objectiveMinor} vs oracle ${truth.value}`);
      assert.equal(p.plan.daysLateTotal, truth.late, `${currency} #${s}`);
      compared += 1;
    }
    assert.ok(compared >= 8, `only ${compared} ${currency} plans compared`);
    t.diagnostic(`${compared} ${currency} plans compared to the oracle`);
  });
}

// =================================================================================================
// R4-M2: the late candidates are capped per bill; when the cap bites the answer is heuristic and its
// bound holds for the FULL problem (checked against the oracle, which never caps)
// =================================================================================================

test('R4-M2: past MAX_LATE_CANDIDATES the answer is heuristic, never proven, and its bound holds for the uncapped problem', () => {
  const asOf = '2026-07-01';
  const dates = horizonDates(asOf, 120);
  // Capacity rises on EVERY day: every clearing day after the due dates is a late candidate.
  const baseBalance = dates.map((_, t) => 100_000 + t * 9_000);
  const bills = [
    { id: 'a', openMinor: 600_000, dueDate: '2026-07-03', skontoRateBp: 0, skontoUntil: null },
    { id: 'b', openMinor: 450_000, dueDate: '2026-07-06', skontoRateBp: 0, skontoUntil: null },
  ];
  const inst = { dates, baseBalance, floorMinor: 100_000, bills, lagDays: 1, lateInterestBp: 500, allowLate: true };
  const truth = bruteForce(inst);
  assert.equal(truth.feasible, true);
  const r = optimisePaymentPlan(inst);
  assert.deepEqual(auditAnswer(inst, r), []);
  assert.equal(r.optimality, 'heuristic', 'a capped option set is no longer exact');
  assert.ok(Number.isSafeInteger(r.upperBoundMinor) && r.upperBoundMinor >= truth.value, `bound ${r.upperBoundMinor} vs ${truth.value}`);
  assert.ok(r.objectiveMinor <= truth.value);
  assert.ok(r.lateDaysLowerBound <= truth.minLateAny, `lateness floor ${r.lateDaysLowerBound} vs ${truth.minLateAny}`);
});
