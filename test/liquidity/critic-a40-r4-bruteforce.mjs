/**
 * A40 critic round 4: the critic's OWN brute force for the pay-date problem, written from the spec
 * (§4.4) without reading the author's oracle's code paths. It shares only the SIX clearing-day
 * calendar with the engine (`isClearingDay`, `addClearingDays`).
 *
 * Differences from the author's oracle, on purpose:
 *  - the floor is checked as "nothing paid yet, OR the balance after payments is at or above the floor"
 *    per day (an equivalent restatement of `paid <= max(0, C - floor)`, derived independently);
 *  - dates are handled by an own day counter (`dayIndex`), money by an own BigInt rounding;
 *  - the search memoises on the exact state (bill index, cumulative cash per clearing day), which is
 *    exact (the same state has the same completions) and lets it reach 10 to 14 bills;
 *  - it also reports the fewest days late of ANY feasible schedule (worth ignored), and whether the
 *    on-time schedule (plan.ts's pre-check) keeps the floor.
 *
 * Every instance is SYNTHETIC by construction.
 */

import { isClearingDay, addClearingDays } from '../../dist/core/liquidity/index.js';

const DAY = 86_400_000;
const toMs = (d) => Date.parse(`${d}T00:00:00.000Z`);
export const dayAdd = (d, n) => new Date(toMs(d) + n * DAY).toISOString().slice(0, 10);
const dayIndex = (from, to) => Math.round((toMs(to) - toMs(from)) / DAY);

/** round(n / d) half away from zero, BigInt in, Number out. */
function roundAway(n, d) {
  const neg = (n < 0n) !== (d < 0n);
  const a = n < 0n ? -n : n;
  const b = d < 0n ? -d : d;
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  return Number(neg ? -q : q);
}
export const critSkonto = (amount, bp) => roundAway(BigInt(amount) * BigInt(bp), 10_000n);
export const critInterest = (amount, bp, days) => (days > 0 && bp > 0 ? roundAway(BigInt(amount) * BigInt(bp) * BigInt(days), 3_650_000n) : 0);

/** All choices for one bill, or null when the bill is not decided inside the horizon. */
export function critChoices(inst, bill) {
  const { dates, lagDays, lateInterestBp } = inst;
  const first = dates[0];
  const last = dates[dates.length - 1];
  const clearing = dates.filter((d) => isClearingDay(d));
  let firstAfter = dayAdd(last, 1);
  while (!isClearingDay(firstAfter)) firstAfter = dayAdd(firstAfter, 1);
  const hasSkonto = bill.skontoRateBp > 0 && bill.skontoUntil !== null;
  const skontoDeadline = hasSkonto ? (bill.skontoUntil <= bill.dueDate ? bill.skontoUntil : bill.dueDate) : null;
  const skonto = hasSkonto ? critSkonto(bill.openMinor, bill.skontoRateBp) : 0;
  const price = (execDate) => {
    const arrival = addClearingDays(execDate, lagDays);
    const earns = skonto > 0 && arrival <= skontoDeadline;
    const late = Math.max(0, dayIndex(bill.dueDate, arrival));
    const interest = critInterest(bill.openMinor, lateInterestBp, late);
    return { earns, late, interest, cash: bill.openMinor - (earns ? skonto : 0), value: (earns ? skonto : 0) - interest };
  };
  const after = price(firstAfter);
  const dueInside = after.late > 0;
  const skontoClosesInside = skonto > 0 && !after.earns && clearing.some((d) => price(d).earns);
  if (!dueInside && !skontoClosesInside) return null;
  const out = clearing.map((d) => ({ date: d, day: dayIndex(first, d), ...price(d) }));
  out.push({ date: null, day: null, earns: false, late: after.late, interest: after.interest, cash: 0, value: -after.interest });
  if (inst.allowLate === false) {
    const fewest = Math.min(...out.map((o) => o.late));
    return out.filter((o) => o.late === fewest);
  }
  return out;
}

/** Is (v1, l1) lexicographically better than (v2, l2): more worth, then fewer days late? */
const lexBetter = (v1, l1, v2, l2) => v1 > v2 || (v1 === v2 && l1 < l2);

/**
 * The exact lexicographic optimum. Returns {feasible, value, late, minLateAny, onTimeKeepsFloor}.
 * `limit` caps the visited states (throws when exceeded, so a test never silently answers partially).
 */
export function critSolve(inst, limit = 5_000_000) {
  const { dates, baseBalance, floorMinor, bills } = inst;
  const T = dates.length;
  const decided = [];
  for (const b of bills) {
    const c = critChoices(inst, b);
    if (c !== null) decided.push({ bill: b, choices: c });
  }
  const n = decided.length;
  // Per-day feasibility of a cumulative payment vector.
  const ok = (paidByDay) => {
    let cum = 0;
    for (let t = 0; t < T; t += 1) {
      cum += paidByDay[t];
      if (cum !== 0 && baseBalance[t] - cum < floorMinor) return false;
    }
    return true;
  };
  const paid = new Array(T).fill(0);
  // Remaining best value and best late per suffix (both over the bill's choices alone).
  const sufV = new Array(n + 1).fill(0);
  const sufL = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    sufV[i] = sufV[i + 1] + Math.max(...decided[i].choices.map((c) => c.value));
    sufL[i] = sufL[i + 1] + Math.min(...decided[i].choices.map((c) => c.late));
  }
  let best = null;
  let visited = 0;
  const key = (i) => `${i}|${paid.join(',')}`;
  // Pass 1, the lexicographic optimum. Memo per exact state: the best (value, late) prefix that reached
  // it (a lexicographically worse prefix into the same state has the same completions, so it loses).
  // Bound: a prefix plus every remaining bill's best value (and fewest days late) that cannot beat
  // the incumbent is cut; that bound needs no proof (each bill contributes at most its best).
  const memo = new Map();
  const rec = (i, v, l) => {
    visited += 1;
    if (visited > limit) throw new Error('critSolve: state limit exceeded');
    if (best !== null && !lexBetter(v + sufV[i], l + sufL[i], best.value, best.late)) return;
    if (i === n) {
      best = { value: v, late: l };
      return;
    }
    const k = key(i);
    const seen = memo.get(k);
    if (seen !== undefined && !lexBetter(v, l, seen.v, seen.l)) return;
    memo.set(k, { v, l });
    for (const c of decided[i].choices) {
      if (c.day !== null && c.cash > 0) paid[c.day] += c.cash;
      if (ok(paid)) rec(i + 1, v + c.value, l + c.late);
      if (c.day !== null && c.cash > 0) paid[c.day] -= c.cash;
    }
  };
  rec(0, 0, 0);
  // Pass 2, the fewest days late of ANY feasible schedule (worth ignored), same memo idea.
  // Seeded with the optimum's own lateness (a feasible schedule), so only fewer days late are searched.
  let minLateAny = best === null ? Infinity : best.late;
  const memo2 = new Map();
  const byLate = decided.map((d) => [...d.choices].sort((a, b) => a.late - b.late));
  const rec2 = (i, l) => {
    visited += 1;
    if (visited > limit) throw new Error('critSolve: state limit exceeded');
    if (l + sufL[i] >= minLateAny) return;
    if (i === n) {
      minLateAny = l;
      return;
    }
    const k = key(i);
    const seen = memo2.get(k);
    if (seen !== undefined && l >= seen) return;
    memo2.set(k, l);
    for (const c of byLate[i]) {
      if (c.day !== null && c.cash > 0) paid[c.day] += c.cash;
      if (ok(paid)) rec2(i + 1, l + c.late);
      if (c.day !== null && c.cash > 0) paid[c.day] -= c.cash;
    }
  };
  rec2(0, 0);
  // plan.ts's pre-check, restated: every decided bill on its latest zero-extra-lateness day.
  const onTime = new Array(T).fill(0);
  for (const d of decided) {
    const fewest = Math.min(...d.choices.map((c) => c.late));
    const withFewest = d.choices.filter((c) => c.late === fewest);
    // the latest such day; the deferral (no cash) counts as the latest of all
    const pick = withFewest.find((c) => c.day === null) ?? withFewest[withFewest.length - 1];
    // on the latest day a Skonto-class choice is not preferred: plan.ts pays the full amount on time
    const fullAmountOnDay = pick.day === null ? null : { day: pick.day, cash: d.bill.openMinor };
    if (fullAmountOnDay !== null) onTime[fullAmountOnDay.day] += fullAmountOnDay.cash;
  }
  const onTimeKeepsFloor = (() => {
    let cum = 0;
    for (let t = 0; t < T; t += 1) {
      cum += onTime[t];
      if (baseBalance[t] - cum < floorMinor) return false;
    }
    return true;
  })();
  if (best === null) return { feasible: false, decided: decided.map((d) => d.bill.id), onTimeKeepsFloor, visited };
  return { feasible: true, value: best.value, late: best.late, minLateAny, decided: decided.map((d) => d.bill.id), onTimeKeepsFloor, visited };
}

/** Re-price and re-check an optimiser answer with the critic's own arithmetic. */
export function critAudit(inst, res) {
  const problems = [];
  const T = inst.dates.length;
  const paid = new Array(T).fill(0);
  let value = 0;
  let late = 0;
  const byId = new Map(inst.bills.map((b) => [b.id, b]));
  for (const line of res.lines) {
    const choices = critChoices({ ...inst, allowLate: true }, byId.get(line.billId));
    if (choices === null) {
      problems.push(`${line.billId} decided outside the problem`);
      continue;
    }
    const c = choices.find((x) => x.date === line.option.date);
    if (c === undefined) {
      problems.push(`${line.billId} on a non-clearing day ${line.option.date}`);
      continue;
    }
    if (inst.allowLate === false) {
      const allowed = critChoices(inst, byId.get(line.billId));
      if (!allowed.some((x) => x.date === c.date)) problems.push(`${line.billId} late without consent (${c.date})`);
    }
    if (c.cash !== line.option.cashMinor || c.value !== line.option.valueMinor || c.late !== line.option.daysLate) {
      problems.push(`${line.billId} priced ${JSON.stringify(line.option)} vs critic ${JSON.stringify(c)}`);
    }
    if (c.day !== null) paid[c.day] += c.cash;
    value += c.value;
    late += c.late;
  }
  let cum = 0;
  for (let t = 0; t < T; t += 1) {
    cum += paid[t];
    if (cum !== 0 && inst.baseBalance[t] - cum < inst.floorMinor) problems.push(`floor broken on ${inst.dates[t]}`);
  }
  if (value !== res.objectiveMinor) problems.push(`objective ${res.objectiveMinor} vs lines ${value}`);
  if (late !== res.daysLateTotal) problems.push(`daysLateTotal ${res.daysLateTotal} vs lines ${late}`);
  return problems;
}

/** xorshift32, seeded. */
export function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}
