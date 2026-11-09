/**
 * A40 critic round 4 (non-author, 30.09.2026): probes against the partial rebuild (D147) at c47b4e81.
 *
 * Part 1, the optimiser, against the critic's OWN brute force (`critic-a40-r4-bruteforce.mjs`), on
 * instance families the author's oracle suite does not generate: SEVERAL capacity rises and dips (a
 * random walk of inflows and outflows, so the late candidates on capacity rises matter), overdue bills,
 * lag 0 to 2, tiny amounts where interest rounds to zero (lateness decides), zero headroom, a floor
 * exactly at the base, Skonto-only bills due past the horizon, ties, and 9 to 14 bills on short horizons
 * (near the exact budget). `[HOLDS]` tests are properties that must stay green; `[FINDING]` tests
 * reproduce a defect and fail on the head until it is fixed.
 *
 * Every fixture is SYNTHETIC by construction: invented bills, invented balances.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { optimisePaymentPlan, horizonDates } from '../../dist/core/liquidity/index.js';
import { critSolve, critAudit, rng, dayAdd } from './critic-a40-r4-bruteforce.mjs';

const ASOFS = ['2026-07-01', '2026-03-30', '2026-12-21', '2026-05-11', '2026-08-28', '2026-04-02'];

/** A family of instances with several capacity rises and dips. */
function walkInstance(r, nb, T, n, opts = {}) {
  const asOf = ASOFS[n % ASOFS.length];
  const dates = horizonDates(asOf, T);
  const tiny = opts.tiny ?? r() < 0.25;
  const unit = tiny ? 1 : 1_000;
  const bills = [];
  for (let i = 0; i < nb; i += 1) {
    const prev = bills[i - 1];
    if (prev !== undefined && r() < 0.15) {
      bills.push({ ...prev, id: `x${i}` });
      continue;
    }
    const dueOff = r() < 0.15 ? -1 - Math.floor(r() * 4) : Math.floor(r() * (T + 4));
    const withSkonto = r() < 0.7;
    const skOff = withSkonto ? Math.floor(r() * (dueOff + 3)) - 1 : 0;
    bills.push({
      id: `x${i}`,
      openMinor: unit * (5 + Math.floor(r() * 60)) + (tiny ? Math.floor(r() * 50) : 0),
      dueDate: dayAdd(asOf, dueOff),
      skontoRateBp: withSkonto ? [100, 150, 200, 250, 300, 1000][Math.floor(r() * 6)] : 0,
      skontoUntil: withSkonto ? dayAdd(asOf, Math.min(skOff, dueOff + 2)) : null,
    });
  }
  const total = bills.reduce((s, b) => s + b.openMinor, 0);
  const floorMinor = opts.floor ?? [0, 50_000, -20_000][n % 3];
  // A random walk: several inflows, some outflows, sometimes a dip below the floor.
  let bal = floorMinor + Math.round(total * (opts.zero ? 0 : 0.05 + r() * 0.4));
  const baseBalance = [];
  for (let t = 0; t < T; t += 1) {
    const u = r();
    if (u < 0.3) bal += Math.round(total * (0.1 + r() * 0.4));
    else if (u < 0.42 && !opts.noDip) bal -= Math.round(total * r() * 0.25);
    baseBalance.push(bal);
  }
  if (opts.zero) baseBalance[Math.floor(T / 2)] = floorMinor; // headroom exactly zero somewhere
  return {
    dates,
    baseBalance,
    floorMinor,
    bills,
    lagDays: n % 3,
    lateInterestBp: tiny ? [500, 2000][n % 2] : [0, 500, 2000][n % 3],
    allowLate: opts.allowLate ?? r() < 0.5,
  };
}

function runOne(inst, tally, label, limit) {
  const truth = critSolve(inst, limit);
  let res;
  try {
    res = optimisePaymentPlan(inst);
  } catch (e) {
    if (inst.allowLate === false && !truth.feasible) {
      tally.refusedInfeasible += 1;
      return;
    }
    throw new Error(`${label}: optimiser threw on a feasible instance: ${e.message}\n${JSON.stringify(inst)}`);
  }
  assert.ok(truth.feasible, `${label}: optimiser answered an infeasible instance\n${JSON.stringify(inst)}`);
  const problems = critAudit(inst, res);
  assert.deepEqual(problems, [], `${label}: ${problems.join('; ')}\n${JSON.stringify(inst)}`);
  tally.maxNodes = Math.max(tally.maxNodes ?? 0, res.nodesExplored);
  if (res.optimality === 'proven') {
    tally.proven += 1;
    if (res.objectiveMinor !== truth.value || res.daysLateTotal !== truth.late) {
      tally.wrong.push({ label, got: [res.objectiveMinor, res.daysLateTotal], opt: [truth.value, truth.late], inst });
    }
  } else {
    tally.heuristic += 1;
    assert.ok(res.upperBoundMinor >= truth.value, `${label}: heuristic bound ${res.upperBoundMinor} below the optimum ${truth.value}`);
    assert.ok(res.lateDaysLowerBound <= truth.minLateAny, `${label}: lateness floor ${res.lateDaysLowerBound} above a feasible ${truth.minLateAny}`);
  }
  if (inst.allowLate === false && truth.feasible && !truth.onTimeKeepsFloor) tally.precheckRefusesFeasible += 1;
  if (inst.allowLate === false && truth.onTimeKeepsFloor && !truth.feasible) tally.precheckPassesInfeasible += 1;
}

const newTally = () => ({ proven: 0, heuristic: 0, refusedInfeasible: 0, wrong: [], precheckRefusesFeasible: 0, precheckPassesInfeasible: 0 });

test('[HOLDS] critic brute force: every proven answer is the lexicographic optimum (walk family: several rises and dips, 3 to 8 bills, both consent levels, lag 0 to 2)', (t) => {
  const r = rng(0x4a40_0004);
  const tally = newTally();
  const HORIZON = { 3: 21, 4: 16, 5: 13, 6: 11, 7: 10, 8: 9 };
  for (const nb of [3, 4, 5, 6, 7, 8]) {
    for (let n = 0; n < 120; n += 1) runOne(walkInstance(r, nb, HORIZON[nb], n, { noDip: n % 2 === 0 }), tally, `walk nb=${nb} n=${n}`);
  }
  t.diagnostic(JSON.stringify({ ...tally, wrong: tally.wrong.length }));
  assert.deepEqual(tally.wrong.map((w) => [w.label, w.got, w.opt]), []);
  assert.ok(tally.proven > 300, `enough proven answers compared (${tally.proven})`);
  assert.equal(tally.precheckPassesInfeasible, 0, 'the plan pre-check never lets an infeasible no-consent instance reach the optimiser');
});

test('[HOLDS] critic brute force: zero headroom, floor at the base, tiny amounts where interest rounds to zero', (t) => {
  const r = rng(0x0a40_0005);
  const tally = newTally();
  for (let n = 0; n < 300; n += 1) {
    const nb = 3 + (n % 5);
    runOne(walkInstance(r, nb, [18, 14, 12, 11, 10][n % 5], n, { zero: true, tiny: n % 2 === 0 }), tally, `zero n=${n}`);
  }
  t.diagnostic(JSON.stringify({ ...tally, wrong: tally.wrong.length }));
  assert.deepEqual(tally.wrong.map((w) => [w.label, w.got, w.opt]), []);
});

// Opt-in: this family alone runs about 10 minutes (671 s measured at load 38), which exceeds the
// node suite's 900 s wall clock in the gate. The 3 to 8 bill families above stay in every run.
// Run it with TILL_SLOW_TESTS=1 before touching optimise.ts.
test('[HOLDS] critic brute force: 9 to 14 bills on short horizons, near the exact budget', { skip: process.env.TILL_SLOW_TESTS === '1' ? false : 'slow (about 10 min): set TILL_SLOW_TESTS=1' }, (t) => {
  const r = rng(0x0a40_0006);
  const tally = newTally();
  for (let n = 0; n < 80; n += 1) {
    const nb = 9 + (n % 6);
    runOne(walkInstance(r, nb, 7 + (n % 2), n, { noDip: true, allowLate: n % 4 !== 0 }), tally, `big n=${n}`, 40_000_000);
  }
  t.diagnostic(JSON.stringify({ ...tally, wrong: tally.wrong.length }));
  assert.deepEqual(tally.wrong.map((w) => [w.label, w.got, w.opt]), []);
});

test('[HOLDS] a forced budget cut is heuristic, never proven, and its bounds hold against the critic brute force', (t) => {
  const r = rng(0x0a40_0007);
  let cut = 0;
  let worse = 0;
  for (let n = 0; n < 200; n += 1) {
    const inst = { ...walkInstance(r, 6, 11, n, { allowLate: true }), nodeBudget: 1 + (n % 7) };
    const truth = critSolve(inst);
    const res = optimisePaymentPlan(inst);
    assert.deepEqual(critAudit(inst, res), []);
    if (res.optimality === 'heuristic') {
      cut += 1;
      if (res.objectiveMinor < truth.value || (res.objectiveMinor === truth.value && res.daysLateTotal > truth.late)) worse += 1;
      assert.ok(res.upperBoundMinor >= truth.value);
      assert.ok(res.lateDaysLowerBound <= truth.minLateAny);
    } else {
      assert.equal(res.objectiveMinor, truth.value);
      assert.equal(res.daysLateTotal, truth.late);
    }
  }
  t.diagnostic(`budget-cut answers: ${cut}, of them strictly worse than the brute force: ${worse}`);
  assert.ok(cut > 50);
  // Negative control: the brute force DOES tell a sub-optimal schedule from the optimum.
  assert.ok(worse > 0, 'the critic brute force discriminates (some budget-cut answers are strictly worse)');
});

// =================================================================================================
// R4-M2: the work budget is counted, but the polish and the per-option checks are not: wall time is
// unbounded on the consent path (the path the floor-breach question leads to)
// =================================================================================================

/** n open bills, a T-day horizon, receipts every day, tight headroom (seeded, synthetic). */
function crowdedBook(n, T) {
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
    bal += ((total * 0.6) / T) * (0.5 + r());
    baseBalance.push(Math.round(bal));
  }
  return { dates, baseBalance, floorMinor, bills, lagDays: 1, lateInterestBp: 500, allowLate: true };
}

test('[FINDING R4-M2] a 300-bill book over 180 days with consent blocks the process for tens of seconds: the counted budget does not bound the time', (t) => {
  const inst = crowdedBook(300, 180);
  const t0 = performance.now();
  const res = optimisePaymentPlan(inst);
  const ms = Math.round(performance.now() - t0);
  t.diagnostic(`${ms} ms, ${res.optimality}, ${res.nodesExplored} nodes`);
  assert.equal(res.optimality, 'heuristic');
  // Measured on the head: about 48 s (400 bills: 26 s at 180 days; 800 bills: 37 s at 90 days, 235 s at
  // 180). The spec measures 30 to 120 bills at 0.4 to 1.1 s. The CPU profile puts the time in the
  // uncounted polish (`opt`, `apply`, `fits`, `better`: the pair scan is O(n^2 x options^2 x points))
  // and the O(options^2) dominance filter, none of which the work budget counts.
  assert.ok(ms < 10_000, `the proposal held the (single-threaded) server for ${ms} ms`);
});
