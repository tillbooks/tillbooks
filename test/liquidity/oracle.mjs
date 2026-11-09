/**
 * A40, the ORACLE for the pay-date problem: a plain brute-force enumerator, deliberately in the TEST
 * tree and deliberately independent of `src/core/liquidity/optimise.ts`.
 *
 * It shares only the SIX clearing-day calendar with the engine (`isClearingDay`, `addClearingDays`,
 * `daysBetween`, themselves pinned by their own tests). Everything the optimiser reduces, it does not:
 * every bill may be paid on EVERY clearing day of the horizon, or deferred past it; the money is
 * re-derived here in BigInt; the floor is checked day by day as "paid so far <= max(0, balance - floor)";
 * the objective is lexicographic (the most worth, then the fewest days late). No bound, no dominance,
 * no exchange argument: only enumeration, pruned by the one fact that needs no proof (cash is never
 * negative, so a partial schedule that already breaks the floor cannot be completed).
 *
 * The problem definition it enumerates (spec §4.4):
 *  - a bill is DECIDED when it is due inside the horizon (paying on the first clearing day after the
 *    horizon would arrive after its due date) or its Skonto window closes inside the horizon (some
 *    clearing day in it still earns the Skonto and the first one after it does not);
 *  - paying on clearing day x arrives `lag` clearing days later; it earns the Skonto when it arrives by
 *    min(skontoUntil, dueDate), and costs OR 104 interest for every day it arrives after the due date;
 *  - deferring pays nothing inside the horizon and is worth minus the interest a payment on the first
 *    clearing day after the horizon would carry;
 *  - without consent (`allowLate: false`) a bill may only take the days (or the deferral) with the
 *    fewest days late it can have at all.
 */

import { isClearingDay, addClearingDays, daysBetween } from '../../dist/core/liquidity/index.js';

const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** round(num / den), half away from zero, in BigInt. */
function roundHalf(num, den) {
  const neg = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = (2n * a + b) / (2n * b);
  return Number(neg ? -q : q);
}
export const oracleSkonto = (amount, bp) => roundHalf(BigInt(amount) * BigInt(bp), 10_000n);
export const oracleInterest = (amount, bp, days) => (days <= 0 || bp <= 0 ? 0 : roundHalf(BigInt(amount) * BigInt(bp) * BigInt(days), 3_650_000n));

/** Every option of one bill: every clearing day of the horizon plus the deferral, or null if undecided. */
export function billOptions(inst, bill) {
  const { dates, lagDays: lag, lateInterestBp: bp } = inst;
  const end = dates[dates.length - 1];
  let after = plusDays(end, 1);
  while (!isClearingDay(after)) after = plusDays(after, 1);
  const arrivalAfter = addClearingDays(after, lag);
  const S = bill.skontoRateBp > 0 && bill.skontoUntil !== null ? (bill.skontoUntil < bill.dueDate ? bill.skontoUntil : bill.dueDate) : null;
  const K = S === null ? 0 : oracleSkonto(bill.openMinor, bill.skontoRateBp);
  const clearing = dates.filter(isClearingDay);
  const dueInside = arrivalAfter > bill.dueDate;
  const skontoClosesInside = K > 0 && clearing.some((x) => addClearingDays(x, lag) <= S) && !(arrivalAfter <= S);
  if (!dueInside && !skontoClosesInside) return null;
  const options = [];
  for (const x of clearing) {
    const arrival = addClearingDays(x, lag);
    const captured = S !== null && arrival <= S ? K : 0;
    const late = Math.max(0, daysBetween(bill.dueDate, arrival));
    options.push({ day: daysBetween(dates[0], x), date: x, cash: bill.openMinor - captured, value: captured - oracleInterest(bill.openMinor, bp, late), late });
  }
  const deferLate = Math.max(0, daysBetween(bill.dueDate, arrivalAfter));
  options.push({ day: null, date: null, cash: 0, value: -oracleInterest(bill.openMinor, bp, deferLate), late: deferLate });
  if (inst.allowLate === false) {
    const fewest = Math.min(...options.map((o) => o.late));
    return options.filter((o) => o.late === fewest);
  }
  return options;
}

/**
 * The lexicographic optimum over every schedule that keeps the floor, by enumeration. Returns the best
 * `{value, late}`, the fewest days late of ANY feasible schedule (`minLateAny`), the decided bill ids,
 * and `leaves` (the feasible schedules counted), or `{feasible: false}` when no schedule keeps the floor.
 */
export function bruteForce(inst) {
  const { dates, baseBalance, floorMinor, bills } = inst;
  const T = dates.length;
  const head = baseBalance.map((c) => Math.max(0, c - floorMinor));
  const decided = [];
  const opts = [];
  for (const b of bills) {
    const o = billOptions(inst, b);
    if (o === null) continue;
    decided.push(b.id);
    opts.push(o);
  }
  const cum = new Array(T).fill(0);
  let best = null;
  let minLateAny = Number.POSITIVE_INFINITY;
  let leaves = 0;
  const rec = (i, value, late) => {
    if (i === opts.length) {
      leaves += 1;
      if (late < minLateAny) minLateAny = late;
      if (best === null || value > best.value || (value === best.value && late < best.late)) best = { value, late };
      return;
    }
    for (const o of opts[i]) {
      if (o.day === null || o.cash === 0) {
        rec(i + 1, value + o.value, late + o.late);
        continue;
      }
      let ok = true;
      for (let t = o.day; t < T; t += 1) {
        cum[t] += o.cash;
        if (cum[t] > head[t]) ok = false;
      }
      if (ok) rec(i + 1, value + o.value, late + o.late);
      for (let t = o.day; t < T; t += 1) cum[t] -= o.cash;
    }
  };
  rec(0, 0, 0);
  if (best === null) return { feasible: false, decided };
  return { feasible: true, value: best.value, late: best.late, minLateAny, decided, leaves };
}

/**
 * Check an optimiser answer INDEPENDENTLY: every line re-priced from its date, the decided set matching,
 * and the floor kept on every day. Returns a list of problems (empty when the answer is sound).
 */
export function auditAnswer(inst, res) {
  const problems = [];
  const byId = new Map(inst.bills.map((b) => [b.id, b]));
  const T = inst.dates.length;
  const head = inst.baseBalance.map((c) => Math.max(0, c - inst.floorMinor));
  const paid = new Array(T).fill(0);
  let value = 0;
  let late = 0;
  for (const l of res.lines) {
    const b = byId.get(l.billId);
    const all = billOptions({ ...inst, allowLate: true }, b);
    const allowed = billOptions(inst, b);
    if (all === null) {
      problems.push(`${l.billId}: decided but outside the problem`);
      continue;
    }
    const o = all.find((x) => x.date === l.option.date);
    if (o === undefined) {
      problems.push(`${l.billId}: ${l.option.date} is not a clearing day of the horizon`);
      continue;
    }
    if (!allowed.some((x) => x.date === o.date)) problems.push(`${l.billId}: ${l.option.date} is not admissible without consent`);
    if (o.cash !== l.option.cashMinor || o.value !== l.option.valueMinor || o.late !== l.option.daysLate) {
      problems.push(`${l.billId}: priced ${JSON.stringify(l.option)}, the oracle says ${JSON.stringify(o)}`);
    }
    if (o.day !== null) paid[o.day] += o.cash;
    value += o.value;
    late += o.late;
  }
  let c = 0;
  for (let t = 0; t < T; t += 1) {
    c += paid[t];
    if (c > head[t]) problems.push(`floor broken on ${inst.dates[t]}: paid ${c} > headroom ${head[t]}`);
  }
  if (value !== res.objectiveMinor) problems.push(`objective ${res.objectiveMinor} but the lines sum to ${value}`);
  if (late !== res.daysLateTotal) problems.push(`daysLateTotal ${res.daysLateTotal} but the lines sum to ${late}`);
  const decided = [...res.lines.map((l) => l.billId)].sort();
  const expected = inst.bills.filter((b) => billOptions({ ...inst, allowLate: true }, b) !== null).map((b) => b.id).sort();
  if (JSON.stringify(decided) !== JSON.stringify(expected)) problems.push(`decided ${decided} but the problem decides ${expected}`);
  return problems;
}

/** A seeded PRNG (mulberry32), so every instance is reproducible from its seed. */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { plusDays };

/**
 * Lines that one move of their OWN could improve (more worth, or as much with fewer days late) while
 * every other line stays where it is: a heuristic answer must have none (critic R5-M3: never late, or
 * deferred, for nothing). Checked over EVERY clearing day of the oracle, not the optimiser's options.
 */
export function singleMoveImprovements(inst, res) {
  const T = inst.dates.length;
  const head = inst.baseBalance.map((c) => Math.max(0, c - inst.floorMinor));
  const idx = new Map(inst.dates.map((d, i) => [d, i]));
  const paid = new Array(T).fill(0);
  for (const l of res.lines) if (l.option.date !== null) paid[idx.get(l.option.date)] += l.option.cashMinor;
  const fits = (p) => {
    let c = 0;
    for (let t = 0; t < T; t += 1) {
      c += p[t];
      if (c > head[t]) return false;
    }
    return true;
  };
  const out = [];
  for (const l of res.lines) {
    const b = inst.bills.find((x) => x.id === l.billId);
    const opts = billOptions(inst, b) ?? [];
    for (const o of opts) {
      const better = o.value > l.option.valueMinor || (o.value === l.option.valueMinor && o.late < l.option.daysLate);
      if (!better) continue;
      const p = paid.slice();
      if (l.option.date !== null) p[idx.get(l.option.date)] -= l.option.cashMinor;
      if (o.day !== null) p[o.day] += o.cash;
      if (fits(p)) {
        out.push(`${l.billId}: ${l.option.date ?? 'defer'} -> ${o.date ?? 'defer'}`);
        break;
      }
    }
  }
  return out;
}
