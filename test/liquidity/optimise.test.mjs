/**
 * A40's optimiser and calendar, pure (spec §4.4). No store: every instance is built by hand.
 *
 * THE CROSS-CHECK IS THE POINT. The optimiser restricts each bill to a small option set by two exchange
 * arguments (Skonto and on-time payments on the last day of their class, late payments on the first
 * late day or a capacity rise). `brute force` below enumerates EVERY clearing day of the horizon plus
 * deferral for every bill, checks the floor constraint in its SEMANTIC form (for every day s, the cash
 * paid by s is at most max(0, base_s - floor)), prices each choice with its own formulas, and asserts
 * the optimiser's objective equals the true optimum on seeded random instances. If either reduction
 * were wrong, some instance would show the brute force doing strictly better.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  optimisePaymentPlan,
  horizonDates,
  skontoMinor,
  interestMinor,
  isClearingDay,
  easterSunday,
  lastExecutionFor,
  addClearingDays,
  clearingDayOnOrAfter,
  daysBetween,
} from '../../dist/core/liquidity/index.js';
import { nearestRank, expectedDelay } from '../../dist/core/liquidity/delay.js';
import { nextClearingDay } from '../../dist/core/liquidity/calendar.js';

// --- calendar ------------------------------------------------------------------------------------

test('Easter and the SIC closing days are the SIX schedule', () => {
  assert.equal(easterSunday(2026), '2026-04-05');
  assert.equal(easterSunday(2027), '2027-03-28');
  assert.equal(easterSunday(2025), '2025-04-20');
  // 2026: Karfreitag 3.4., Ostermontag 6.4., 1.5., Auffahrt 14.5., Pfingstmontag 25.5. (SIX list).
  for (const d of ['2026-01-01', '2026-01-02', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25', '2026-12-25']) {
    assert.equal(isClearingDay(d), false, d);
  }
  // 2027 from the SIX "Schedule of clearing days 2027": Karfreitag 26.3., Ostermontag 29.3., Auffahrt 6.5., Pfingstmontag 17.5.
  for (const d of ['2027-03-26', '2027-03-29', '2027-05-06', '2027-05-17']) assert.equal(isClearingDay(d), false, d);
  // 24.12. and 31.12. are clearing days; weekends never are.
  assert.equal(isClearingDay('2026-12-24'), true);
  assert.equal(isClearingDay('2026-12-31'), true);
  assert.equal(isClearingDay('2026-07-18'), false);
  assert.equal(isClearingDay('2026-07-17'), true);
});

test('the last execution day that still arrives by a deadline steps back over weekends and the lag', () => {
  // 2026-08-02 is a Sunday; 1.8. a Saturday (and a closing day). Lag 0: Friday 31.7.; lag 1: Thursday 30.7.
  assert.equal(lastExecutionFor('2026-08-02', 0), '2026-07-31');
  assert.equal(lastExecutionFor('2026-08-02', 1), '2026-07-30');
  // Over Easter 2026: deadline Easter Monday 6.4. -> Thursday 2.4. at lag 0, Wednesday 1.4. at lag 1.
  assert.equal(lastExecutionFor('2026-04-06', 0), '2026-04-02');
  assert.equal(lastExecutionFor('2026-04-06', 1), '2026-04-01');
  assert.equal(addClearingDays('2026-04-02', 1), '2026-04-07');
});

// --- money arithmetic ----------------------------------------------------------------------------

test('Skonto and OR 104 interest are integer minor units, rounded half away from zero', () => {
  assert.equal(skontoMinor(108100, 200), 2162);
  assert.equal(skontoMinor(125, 200), 3); // 2.5 -> 3
  // CHF 10'000 at 5 % for 30 days = 41.0958... -> 41.10
  assert.equal(interestMinor(1_000_000, 500, 30), 4110);
  assert.equal(interestMinor(1_000_000, 500, 0), 0);
  // No precision loss at CHF 100 million over a year.
  assert.equal(interestMinor(10_000_000_000, 500, 365), 500_000_000);
});

// --- delay model ---------------------------------------------------------------------------------

test('the delay quantile is nearest-rank and conditional on how late the invoice already is', () => {
  assert.equal(nearestRank([5, 1, 3, 2, 4], 80), 4);
  assert.equal(nearestRank([5, 1, 3, 2, 4], 50), 3);
  const customer = [0, 2, 10, 30];
  // Nearest rank: q50 of four samples is the 2nd (2), q80 the 4th (30).
  assert.deepEqual(expectedDelay(customer, [], 50, -5), { ok: true, delayDays: 2, source: 'customer', samples: 4 });
  assert.deepEqual(expectedDelay(customer, [], 80, -5), { ok: true, delayDays: 30, source: 'customer', samples: 4 });
  // 5 days late already at q50: the survivors are 10 and 30, so the expected delay is 10, not 2.
  assert.deepEqual(expectedDelay(customer, [], 50, 5), { ok: true, delayDays: 10, source: 'customer', samples: 4 });
  // Later than every sample: excluded, never assumed paid.
  assert.equal(expectedDelay(customer, [], 80, 31).ok, false);
  assert.equal(expectedDelay(customer, [], 80, 31).reason, 'overdue_beyond_history');
  // Too little own history: the pool; too little pool: 0 when not yet due, excluded when overdue.
  assert.equal(expectedDelay([1], [3, 3, 3], 80, -1).source, 'pooled');
  assert.deepEqual(expectedDelay([], [], 80, -3), { ok: true, delayDays: 0, source: 'no_history', samples: 0 });
  assert.equal(expectedDelay([], [], 80, 2).reason, 'overdue_no_history');
});

// --- the optimiser on hand-built instances ---------------------------------------------------------

/** A flat base balance with optional day-indexed inflows (+) and outflows (-). */
function base(dates, opening, events = {}) {
  let run = opening;
  return dates.map((d) => {
    run += events[d] ?? 0;
    return run;
  });
}

const ASOF = '2026-07-16'; // Thursday

test('enough cash: every Skonto is captured on the last day that still earns it', () => {
  const dates = horizonDates(ASOF, 30);
  const r = optimisePaymentPlan({
    dates,
    baseBalance: base(dates, 10_000_000),
    floorMinor: 2_000_000,
    lagDays: 1,
    lateInterestBp: 500,
    bills: [
      { id: 'b1', openMinor: 108_100, dueDate: '2026-08-14', skontoRateBp: 200, skontoUntil: '2026-07-26' },
      { id: 'b2', openMinor: 500_000, dueDate: '2026-08-10', skontoRateBp: 0, skontoUntil: null },
    ],
  });
  assert.equal(r.optimality, 'proven');
  const b1 = r.lines.find((l) => l.billId === 'b1');
  const b2 = r.lines.find((l) => l.billId === 'b2');
  // Skonto until Sunday 26.7., lag 1: execute Thursday 23.7., arrive Friday 24.7.
  assert.equal(b1.option.date, '2026-07-23');
  assert.equal(b1.option.arrival, '2026-07-24');
  assert.equal(b1.option.skontoMinor, 2162);
  assert.equal(b1.option.cashMinor, 108_100 - 2162);
  assert.equal(b1.reason, 'skonto_captured');
  // No Skonto: paid on the last on-time day (due Monday 10.8., lag 1 -> Thursday 6.8.? Friday 7.8.).
  assert.equal(b2.option.date, lastExecutionFor('2026-08-10', 1));
  assert.equal(b2.reason, 'on_time_latest');
  assert.equal(r.objectiveMinor, 2162);
  assert.equal(r.baseBreach, null);
});

test('the floor binds: the more valuable Skonto wins and the other is forgone for the floor', () => {
  const dates = horizonDates(ASOF, 30);
  // CHF 30'000 opening, floor 20'000: CHF 10'000 of room until a CHF 50'000 inflow on 5.8.
  const r = optimisePaymentPlan({
    dates,
    baseBalance: base(dates, 3_000_000, { '2026-08-05': 5_000_000 }),
    floorMinor: 2_000_000,
    lagDays: 0,
    lateInterestBp: 500,
    bills: [
      { id: 'small', openMinor: 600_000, dueDate: '2026-08-14', skontoRateBp: 200, skontoUntil: '2026-07-24' },
      { id: 'large', openMinor: 900_000, dueDate: '2026-08-14', skontoRateBp: 300, skontoUntil: '2026-07-24' },
    ],
  });
  assert.equal(r.optimality, 'proven');
  const large = r.lines.find((l) => l.billId === 'large');
  const small = r.lines.find((l) => l.billId === 'small');
  assert.equal(large.reason, 'skonto_captured');
  assert.equal(large.option.skontoMinor, 27_000);
  assert.equal(small.reason, 'skonto_forgone_floor');
  assert.equal(small.detail.bestAlternative.fitsAlone, false);
  assert.equal(r.objectiveMinor, 27_000);
  for (const b of r.balances) assert.ok(b >= 2_000_000, `balance ${b} under the floor`);
});

test('a bill the floor cannot carry on time is paid late on the day cash arrives, with OR 104 interest', () => {
  const dates = horizonDates(ASOF, 30);
  const r = optimisePaymentPlan({
    dates,
    baseBalance: base(dates, 1_000_000, { '2026-07-28': 2_000_000 }),
    floorMinor: 1_000_000,
    lagDays: 0,
    lateInterestBp: 500,
    bills: [{ id: 'rent', openMinor: 1_500_000, dueDate: '2026-07-20', skontoRateBp: 0, skontoUntil: null }],
  });
  const rent = r.lines[0];
  assert.equal(rent.reason, 'late_floor');
  assert.equal(rent.option.date, '2026-07-28');
  assert.equal(rent.option.daysLate, 8);
  assert.equal(rent.option.interestMinor, interestMinor(1_500_000, 500, 8));
  assert.equal(r.objectiveMinor, -rent.option.interestMinor);
});

test('when the scheduled flows alone dip under the floor, the dip is reported and nothing is paid before it', () => {
  const dates = horizonDates(ASOF, 21);
  const r = optimisePaymentPlan({
    dates,
    baseBalance: base(dates, 2_500_000, { '2026-07-24': -1_000_000, '2026-07-31': 3_000_000 }),
    floorMinor: 2_000_000,
    lagDays: 0,
    lateInterestBp: 500,
    bills: [{ id: 'b', openMinor: 100_000, dueDate: '2026-07-22', skontoRateBp: 0, skontoUntil: null }],
  });
  assert.deepEqual(r.baseBreach, { date: '2026-07-24', balanceMinor: 1_500_000 });
  const b = r.lines[0];
  assert.ok(b.option.date >= '2026-07-31', `paid ${b.option.date}, before the base low point`);
  assert.equal(b.reason, 'late_floor');
});

test('a bill never affordable in the horizon is deferred with the interest it accrues to the horizon end', () => {
  const dates = horizonDates(ASOF, 14);
  const r = optimisePaymentPlan({
    dates,
    baseBalance: base(dates, 1_000_000),
    floorMinor: 1_000_000,
    lagDays: 0,
    lateInterestBp: 500,
    bills: [{ id: 'b', openMinor: 500_000, dueDate: '2026-07-20', skontoRateBp: 0, skontoUntil: null }],
  });
  assert.equal(r.lines[0].reason, 'deferred_floor');
  assert.equal(r.lines[0].option.date, null);
  assert.ok(r.lines[0].option.interestMinor > 0);
});

test('bills with neither a Skonto window nor a due date in the horizon are not decided', () => {
  const dates = horizonDates(ASOF, 14);
  const r = optimisePaymentPlan({
    dates,
    baseBalance: base(dates, 1_000_000),
    floorMinor: 0,
    lagDays: 0,
    lateInterestBp: 500,
    bills: [{ id: 'later', openMinor: 1000, dueDate: '2026-12-31', skontoRateBp: 0, skontoUntil: null }],
  });
  assert.deepEqual(r.beyondHorizon, ['later']);
  assert.equal(r.lines.length, 0);
});

test('past the node budget the answer is heuristic (never proven), feasible, and states a valid upper bound', () => {
  const dates = horizonDates(ASOF, 20);
  const bills = [];
  for (let i = 0; i < 12; i += 1) {
    bills.push({ id: `b${String(i).padStart(2, '0')}`, openMinor: 100_000 + i * 7_919, dueDate: '2026-08-04', skontoRateBp: 150 + i * 10, skontoUntil: '2026-07-24' });
  }
  const input = { dates, baseBalance: base(dates, 1_000_000), floorMinor: 500_000, lagDays: 0, lateInterestBp: 500, bills };
  const bounded = optimisePaymentPlan({ ...input, nodeBudget: 3 });
  const exact = optimisePaymentPlan(input);
  assert.equal(bounded.optimality, 'heuristic');
  assert.ok(Number.isSafeInteger(bounded.upperBoundMinor), 'the bound is a finite integer');
  assert.equal(exact.optimality, 'proven');
  assert.ok(bounded.upperBoundMinor >= exact.objectiveMinor, 'the bound must bound the true optimum');
  assert.ok(bounded.objectiveMinor <= exact.objectiveMinor);
  for (const b of bounded.balances) assert.ok(b >= 500_000);
});

// --- the brute-force cross-check ------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The true optimum by exhaustive enumeration, written without the optimiser's code. */
function bruteForce({ dates, baseBalance, floorMinor, bills, lagDays, lateInterestBp }) {
  const end = dates[dates.length - 1];
  const clearing = dates.filter(isClearingDay);
  const first = clearing[0];
  const afterExec = nextClearingDay(end);
  const idx = (d) => daysBetween(dates[0], d);
  const decided = bills.filter((b) => {
    const until = b.skontoRateBp > 0 && b.skontoUntil !== null ? (b.skontoUntil < b.dueDate ? b.skontoUntil : b.dueDate) : null;
    const k = until === null ? 0 : Math.round((b.openMinor * b.skontoRateBp) / 10_000);
    const le = until === null ? null : lastExecutionFor(until, lagDays);
    return (le !== null && k > 0 && first !== undefined && le >= first && le <= end) || lastExecutionFor(b.dueDate, lagDays) <= end;
  });
  const options = decided.map((b) => {
    const until = b.skontoRateBp > 0 && b.skontoUntil !== null ? (b.skontoUntil < b.dueDate ? b.skontoUntil : b.dueDate) : null;
    const K = skontoMinor(b.openMinor, b.skontoRateBp);
    const opts = clearing.map((x) => {
      const arrival = addClearingDays(x, lagDays);
      const captured = until !== null && arrival <= until ? K : 0;
      const late = Math.max(0, daysBetween(b.dueDate, arrival));
      return { day: idx(x), cash: b.openMinor - captured, value: captured - interestMinor(b.openMinor, lateInterestBp, late) };
    });
    const dueIn = lastExecutionFor(b.dueDate, lagDays) <= end;
    const deferArrival = addClearingDays(afterExec, lagDays);
    const deferLate = dueIn ? Math.max(1, daysBetween(b.dueDate, deferArrival)) : 0;
    opts.push({ day: null, cash: 0, value: -interestMinor(b.openMinor, lateInterestBp, deferLate) });
    return opts;
  });
  const headroom = baseBalance.map((c) => Math.max(0, c - floorMinor));
  let best = Number.NEGATIVE_INFINITY;
  const paid = new Array(dates.length).fill(0);
  const rec = (i, value) => {
    if (i === options.length) {
      let cum = 0;
      for (let s = 0; s < dates.length; s += 1) {
        cum += paid[s];
        if (cum > headroom[s]) return;
      }
      if (value > best) best = value;
      return;
    }
    for (const o of options[i]) {
      if (o.day !== null) paid[o.day] += o.cash;
      rec(i + 1, value + o.value);
      if (o.day !== null) paid[o.day] -= o.cash;
    }
  };
  rec(0, 0);
  return best;
}

test('brute force: the reduced option set loses nothing, on 300 seeded random instances', () => {
  const rand = mulberry32(0xa40);
  const start = ['2026-07-16', '2026-03-30', '2026-12-21', '2027-05-03'];
  let checked = 0;
  let floorBinding = 0;
  for (let n = 0; n < 300; n += 1) {
    const asOf = start[n % start.length];
    const T = 10 + Math.floor(rand() * 8);
    const dates = horizonDates(asOf, T);
    const events = {};
    for (let k = 0; k < 3; k += 1) {
      const d = dates[Math.floor(rand() * T)];
      events[d] = (events[d] ?? 0) + Math.round((rand() - 0.35) * 300_000);
    }
    const baseBalance = base(dates, Math.round(rand() * 400_000), events);
    const floorMinor = Math.round(rand() * 150_000);
    const nb = 1 + Math.floor(rand() * 4);
    const bills = [];
    for (let i = 0; i < nb; i += 1) {
      const due = addDays(asOf, Math.floor(rand() * (T + 6)) - 4);
      const withSkonto = rand() < 0.6;
      bills.push({
        id: `b${i}`,
        openMinor: 10_000 + Math.round(rand() * 200_000),
        dueDate: due,
        skontoRateBp: withSkonto ? 100 + Math.floor(rand() * 300) : 0,
        skontoUntil: withSkonto ? addDays(due, -Math.floor(rand() * 10)) : null,
      });
    }
    const lagDays = Math.floor(rand() * 2);
    const input = { dates, baseBalance, floorMinor, bills, lagDays, lateInterestBp: 500 };
    const truth = bruteForce(input);
    const reduced = optimisePaymentPlan(input);
    assert.equal(reduced.optimality, 'proven');
    assert.equal(reduced.objectiveMinor, truth, `instance ${n}: reduced ${reduced.objectiveMinor} vs brute force ${truth}`);
    // The proposal itself honours the floor in its semantic form.
    let cum = 0;
    const paidOn = new Array(T).fill(0);
    for (const l of reduced.lines) if (l.option.date !== null) paidOn[daysBetween(asOf, l.option.date)] += l.option.cashMinor;
    for (let s = 0; s < T; s += 1) {
      cum += paidOn[s];
      assert.ok(cum <= Math.max(0, baseBalance[s] - floorMinor), `instance ${n}: day ${s} breaks the floor`);
    }
    if (reduced.lines.some((l) => l.reason === 'skonto_forgone_floor' || l.reason === 'late_floor' || l.reason === 'deferred_floor')) floorBinding += 1;
    checked += 1;
  }
  assert.equal(checked, 300);
  // Non-vacuous: a real share of the instances had the floor actually decide something.
  assert.ok(floorBinding >= 30, `only ${floorBinding} instances had a binding floor`);
});

test('the stated upper bound is valid: never below the exact optimum, on 200 seeded instances', () => {
  const rand = mulberry32(0xb0d);
  let heuristicSeen = 0;
  for (let n = 0; n < 200; n += 1) {
    const asOf = '2026-07-16';
    const T = 20 + Math.floor(rand() * 20);
    const dates = horizonDates(asOf, T);
    const events = {};
    for (let k = 0; k < 4; k += 1) {
      const d = dates[Math.floor(rand() * T)];
      events[d] = (events[d] ?? 0) + Math.round(rand() * 400_000);
    }
    const baseBalance = base(dates, Math.round(rand() * 300_000), events);
    const bills = [];
    const nb = 3 + Math.floor(rand() * 5);
    for (let i = 0; i < nb; i += 1) {
      const due = addDays(asOf, Math.floor(rand() * (T + 4)) - 3);
      const withSkonto = rand() < 0.6;
      bills.push({
        id: `b${i}`,
        openMinor: 20_000 + Math.round(rand() * 250_000),
        dueDate: due,
        skontoRateBp: withSkonto ? 100 + Math.floor(rand() * 300) : 0,
        skontoUntil: withSkonto ? addDays(due, -Math.floor(rand() * 15)) : null,
      });
    }
    const input = { dates, baseBalance, floorMinor: Math.round(rand() * 100_000), bills, lagDays: 1, lateInterestBp: 500 };
    const exact = optimisePaymentPlan({ ...input, nodeBudget: 10_000_000 });
    assert.equal(exact.optimality, 'proven', `instance ${n}`);
    const cut = optimisePaymentPlan({ ...input, nodeBudget: 1 });
    assert.ok(cut.objectiveMinor <= exact.objectiveMinor, `instance ${n}: an incumbent above the optimum`);
    assert.ok(cut.upperBoundMinor >= exact.objectiveMinor, `instance ${n}: bound ${cut.upperBoundMinor} under the optimum ${exact.objectiveMinor}`);
    if (cut.optimality === 'proven') assert.equal(cut.objectiveMinor, exact.objectiveMinor, `instance ${n}`);
    else {
      heuristicSeen += 1;
      assert.equal(cut.optimality, 'heuristic');
    }
  }
  assert.ok(heuristicSeen >= 10, `only ${heuristicSeen} instances exercised the heuristic path`);
});

test('a larger tight instance stays fast, feasible and honest about its gap', () => {
  const rand = mulberry32(0x5ca1e);
  const dates = horizonDates(ASOF, 90);
  let run = 1_000_000;
  const baseBalance = dates.map((_, i) => {
    if (i % 14 === 7) run += 600_000;
    return run;
  });
  const bills = [];
  for (let i = 0; i < 60; i += 1) {
    const due = addDays(ASOF, Math.floor(rand() * 80) - 5);
    const sk = rand() < 0.5;
    bills.push({ id: `b${String(i).padStart(3, '0')}`, openMinor: 20_000 + Math.round(rand() * 400_000), dueDate: due, skontoRateBp: sk ? 200 : 0, skontoUntil: sk ? addDays(due, -20) : null });
  }
  const started = Date.now();
  const r = optimisePaymentPlan({ dates, baseBalance, floorMinor: 500_000, bills, lagDays: 1, lateInterestBp: 500 });
  assert.ok(Date.now() - started < 20_000, 'the node and work budgets bound the time');
  assert.ok(r.upperBoundMinor >= r.objectiveMinor);
  let cum = 0;
  const paidOn = new Array(90).fill(0);
  for (const l of r.lines) if (l.option.date !== null) paidOn[daysBetween(ASOF, l.option.date)] += l.option.cashMinor;
  for (let s = 0; s < 90; s += 1) {
    cum += paidOn[s];
    assert.ok(cum <= Math.max(0, baseBalance[s] - 500_000), `day ${s} breaks the floor`);
  }
});

function addDays(d, n) {
  return new Date(Date.parse(`${d}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

test('the optimiser is deterministic: the same instance answers the same schedule', () => {
  const dates = horizonDates(ASOF, 30);
  const input = {
    dates,
    baseBalance: base(dates, 3_000_000, { '2026-08-05': 5_000_000 }),
    floorMinor: 2_000_000,
    lagDays: 1,
    lateInterestBp: 500,
    bills: [
      { id: 'a', openMinor: 600_000, dueDate: '2026-08-14', skontoRateBp: 200, skontoUntil: '2026-07-24' },
      { id: 'b', openMinor: 600_000, dueDate: '2026-08-14', skontoRateBp: 200, skontoUntil: '2026-07-24' },
    ],
  };
  assert.deepEqual(optimisePaymentPlan(input), optimisePaymentPlan(input));
  assert.equal(clearingDayOnOrAfter('2026-07-18'), '2026-07-20');
});
