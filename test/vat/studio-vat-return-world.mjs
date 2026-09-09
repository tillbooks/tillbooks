/**
 * The worlds behind the A07 Studio fixtures in `app/src/surfaces/VatReturn/*.fixture.json`.
 *
 * Shared by the capture script (`capture-studio-vat-return.mjs`) and by the drift guard
 * (`studio-vat-return-fixture.test.mjs`), so every fixture is a RECORDING of a function here and
 * the guard replays exactly that function. Two copies of the world would let the recording and the
 * assertion drift apart, which is the whole failure the pairing exists to prevent. A08's
 * `studio-reports-world.mjs` and A16's `studio-open-items-world.mjs` are the worked examples this
 * one follows.
 *
 * WHY A RECORDING AND NOT A LITERAL, on this capability in particular. A07 shipped three
 * filing-grade defects to its critic, and every one of them came back `reconciled: true`: a
 * duplicated Ziffer, a merged rate vintage, and an inverted sign. A hand-typed fixture agrees with
 * whatever the Studio author believed while writing it, which on a tax form means the surface can
 * render a return that matches its own test and matches no ESTV form. So the fixtures are the
 * engine's own answers, compared VALUE for value, never keys and kinds.
 *
 * EIGHT WORLDS, because the surface's states cannot co-exist in one workspace. A workspace is
 * effektiv or saldo, timed soll or ist, registered or not, and each of those is a different screen:
 *
 *  - `liveEffektivSoll()`   the healthy Q2/2026 return. Two output rates plus Bezugsteuer plus two
 *    Vorsteuer lines, so a "multiply everything by the Normalsatz" mutation cannot land on the right
 *    number by luck. Reconciled, drift zero. Carries the period list and the chart the drill-down
 *    would read.
 *  - `liveDrift()`          the same book plus ONE manual journal entry straight onto 2200 with no
 *    tax code, which is the common real defect and the only way to record a NON-ZERO `driftMinor`.
 *    This is the warn state owner decision W2 is about, and it cannot be recorded from a clean book.
 *  - `liveEmpty()`          registered, configured, nothing posted. `empty: true` with the totals at
 *    zero, which is the difference between "no taxable activity" and "not set up".
 *  - `liveSaldo()`          a one-rate Saldo workspace. Ziffer 323 only, NO Vorsteuer block, and
 *    `reconciliation.applicable: false` with `reconciled: null`. The declared non-check in the
 *    design is rendered off exactly these three facts, so all three are recorded rather than assumed.
 *  - `liveSaldoSplit()`     two Saldosteuersätze. The `saldo_activity_split_required` REFUSAL, with
 *    the rates the engine names back. F11 is being built to close this; until it lands this is the
 *    screen an ordinary café gets, so it is a recorded payload and not a guess.
 *  - `liveIstRefusal()`     effektiv on IST timing. The engine refuses with `unsupported` /
 *    `ist_timing_not_implemented` rather than handing an Ist filer the Soll figures. The UX design
 *    predates this refusal and has no state for it (its rows 3.1 and 3.2 assume Ist computes), so
 *    the payload is recorded here and the surface renders it as a refusal.
 *  - `liveNeedsConfig()`    a workspace with no MWST configuration at all: `needs_vat_config`.
 *  - `liveFiled()`          the healthy book, filed. The `vat_periods` list with `filed: true` on
 *    Q2, and the return recomputed on the now-locked period, which is what the read-only banner
 *    claims and therefore what has to be true.
 *
 * ONE STATE NO WORLD HERE CAN PRODUCE, said out loud rather than faked: `permission_denied`. A24 is
 * a permissive stub, so no supported route reaches it from this file. It is an error CODE rather
 * than a payload shape, so the surface test drives it as a canned refusal and nothing is recorded.
 */

import assert from 'node:assert/strict';

import { makeContext } from '../../dist/core/context.js';
import { postEntry, ledgerPorts } from '../../dist/core/ledger/index.js';
import { buildVatLines } from '../../dist/core/vat/index.js';
import { computeVatReturn, listVatPeriods, markVatPeriodFiled } from '../../dist/core/vat/index.js';
import { listAccounts } from '../../dist/core/accounts/index.js';
import { setup } from './support.mjs';

/** Q2/2026, the period every effektiv world reports. Inclusive ISO days, as the verb takes them. */
export const Q2 = { periodStart: '2026-04-01', periodEnd: '2026-06-30' };
/** H1/2026, the Saldo cadence's first period. */
export const H1 = { periodStart: '2026-01-01', periodEnd: '2026-06-30' };
export const YEAR = '2026';

/**
 * The workspace seen through the REAL A03 ports.
 *
 * `setup()` wires the permissive `allPeriodsOpen` stub, through which a sealed period still accepts
 * a post. Every world that files a period needs the enforcing context, and the ones that do not
 * still use it, because it is the context a shipped surface actually runs against.
 */
function enforcing({ store, workspaceId, clock, ids }) {
  return makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    ...ledgerPorts({ store, workspaceId, ids }),
  });
}

function acc(ctx, number) {
  return ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number).id;
}

let key = 0;
function nextKey(tag) {
  key += 1;
  return `a07-gui-${tag}-${key}`;
}

/** One taxable supply, posted through the A06 builder so the A02 gate stamps the trace. */
function sale(ctx, { net, taxCode, date = '2026-05-15' }) {
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '1100'),
    revenueOrExpenseAccount: acc(ctx, '3200'),
    amountMinor: net,
    amountIsGross: false,
    taxCode,
    direction: 'output',
    supplyDate: date,
  });
  const r = postEntry(ctx, { date, source: 'manual', idempotencyKey: nextKey('sale'), lines });
  assert.equal(r.ok, true, `sale post failed: ${JSON.stringify(r)}`);
  return r;
}

/** One deductible purchase (Vorsteuer). `VST-M` reports on 400, `VST-I` on 405. */
function purchase(ctx, { net, taxCode = 'VST-M', date = '2026-05-20' }) {
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '1000'),
    revenueOrExpenseAccount: acc(ctx, '4000'),
    amountMinor: net,
    amountIsGross: false,
    taxCode,
    direction: 'input',
    supplyDate: date,
  });
  const r = postEntry(ctx, { date, source: 'manual', idempotencyKey: nextKey('purchase'), lines });
  assert.equal(r.ok, true, `purchase post failed: ${JSON.stringify(r)}`);
  return r;
}

/** One Bezugsteuer acquisition (Art. 45): owed on 383 AND deducted with the Vorsteuer on 400. */
function bezug(ctx, { net, date = '2026-05-22' }) {
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '2000'),
    revenueOrExpenseAccount: acc(ctx, '4000'),
    amountMinor: net,
    amountIsGross: false,
    taxCode: 'BEZUG',
    direction: 'input',
    supplyDate: date,
  });
  const r = postEntry(ctx, { date, source: 'manual', idempotencyKey: nextKey('bezug'), lines });
  assert.equal(r.ok, true, `bezug post failed: ${JSON.stringify(r)}`);
  return r;
}

/**
 * The book every effektiv world starts from: two output rates, Bezugsteuer, and two Vorsteuer
 * Ziffern. Deliberately more than one of everything, because a one-rate, one-Ziffer book agrees
 * with a wrong formula by luck.
 */
function seedEffektivBook(ctx) {
  sale(ctx, { net: 4_400_000, taxCode: 'UST81' }); //     Normalsatz, Ziffer 303
  sale(ctx, { net: 220_000, taxCode: 'UST26' }); //       Reduzierter Satz, Ziffer 313
  sale(ctx, { net: 200_000, taxCode: 'EXPORT0' }); //      Befreit, Ziffer 220, no tax
  purchase(ctx, { net: 2_100_000, taxCode: 'VST-M' }); // Ziffer 400
  purchase(ctx, { net: 400_000, taxCode: 'VST-I' }); //   Ziffer 405
  bezug(ctx, { net: 100_000 }); //                        Ziffer 383 owed, deducted on 400
}

function unwrap(result, what) {
  assert.equal(result.ok, true, `${what} refused: ${JSON.stringify(result)}`);
  return result;
}

function refusal(result, code) {
  assert.equal(result.ok, false, `expected ${code}, got a success: ${JSON.stringify(result)}`);
  assert.equal(result.error, code, `expected ${code}, got ${result.error}`);
  return result;
}

/** The healthy quarterly return, its period list, and the chart the drill-down reads. */
export function liveEffektivSoll() {
  const world = setup({ method: 'effektiv', timing: 'soll' });
  const ctx = enforcing(world);
  seedEffektivBook(ctx);

  const ret = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  assert.equal(ret.reconciled, true, 'the healthy book must reconcile, or the fixture is not healthy');
  assert.equal(ret.reconciliation.driftMinor, 0);
  assert.equal(ret.empty, false);
  // Load-bearing: the recording has to carry more than one output Ziffer and more than one input
  // Ziffer, or the form-line table is rendered against a payload that cannot exercise it.
  const codes = ret.lines.map((l) => l.code);
  for (const code of ['200', '220', '299', '303', '313', '383', '400', '405']) {
    assert.ok(codes.includes(code), `the healthy recording is missing Ziffer ${code}`);
  }

  return {
    return: ret,
    periods: unwrap(listVatPeriods(ctx, { year: YEAR }), 'vat_periods'),
    accounts: unwrap(listAccounts(ctx, {}), 'list_accounts'),
  };
}

/**
 * The same book with one manual posting straight onto 2200 and no tax code.
 *
 * This is the defect the bridge exists to surface, and it is the ONLY way to record a non-zero
 * `driftMinor` from a book that is otherwise correct: every tagged posting moves 2200 and a Ziffer
 * together by construction, so a clean book cannot drift.
 */
export function liveDrift() {
  const world = setup({ method: 'effektiv', timing: 'soll' });
  const ctx = enforcing(world);
  seedEffektivBook(ctx);

  // The Q1 VAT payment to the ESTV, booked inside Q2 and carrying no tax code: it moves 2200
  // without moving any Ziffer, which is precisely the shape the bridge cannot attribute.
  const r = postEntry(ctx, {
    date: '2026-06-30',
    source: 'manual',
    idempotencyKey: nextKey('untagged-2200'),
    lines: [
      { account: acc(ctx, '2200'), debit: 14_850 },
      { account: acc(ctx, '1020'), credit: 14_850 },
    ],
  });
  assert.equal(r.ok, true, `untagged 2200 post failed: ${JSON.stringify(r)}`);

  const ret = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  assert.equal(ret.reconciled, false, 'the drift world must NOT reconcile, or it records nothing');
  assert.notEqual(ret.reconciliation.driftMinor, 0);
  return ret;
}

/** Registered and configured, nothing posted. The zero return the ESTV still expects. */
export function liveEmpty() {
  const world = setup({ method: 'effektiv', timing: 'soll' });
  const ctx = enforcing(world);
  const ret = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  assert.equal(ret.empty, true, 'the empty world must report empty, or the empty state is untested');
  assert.equal(ret.lines.every((l) => l.taxMinor === 0), true);
  return { return: ret, periods: unwrap(listVatPeriods(ctx, { year: YEAR }), 'vat_periods') };
}

/** A one-rate Saldo workspace: Ziffer 323 only, no Vorsteuer, and the check declared inapplicable. */
export function liveSaldo() {
  const world = setup({ method: 'saldo', timing: 'soll', saldoRates: [{ rateBp: 620 }] });
  const ctx = enforcing(world);
  sale(ctx, { net: 4_400_000, taxCode: 'UST81', date: '2026-03-15' });
  sale(ctx, { net: 220_000, taxCode: 'UST26', date: '2026-05-15' });

  const ret = unwrap(computeVatReturn(ctx, H1), 'vat_return');
  // The three facts the declared non-check is rendered from. Recorded, not assumed.
  assert.equal(ret.method, 'saldo');
  assert.equal(ret.reconciled, null, 'saldo must report reconciled: null, never false');
  assert.equal(ret.reconciliation.applicable, false, 'saldo must report the check inapplicable');
  const codes = ret.lines.map((l) => l.code);
  assert.ok(codes.includes('323'), 'the one-rate saldo recording must carry Ziffer 323');
  assert.ok(!codes.includes('333'), 'a one-rate workspace must NOT carry the second-rate Ziffer');
  assert.equal(ret.totalInputTaxMinor, 0, 'saldo deducts no Vorsteuer (Art. 37)');

  return { return: ret, periods: unwrap(listVatPeriods(ctx, { year: YEAR }), 'vat_periods') };
}

/**
 * Two Saldosteuersätze: the refusal an ordinary two-rate small business gets today.
 *
 * F11 is being built to close this. Until it lands, this payload IS the screen for a café with food
 * and drink, so the surface renders it legibly rather than as a generic error.
 */
export function liveSaldoSplit() {
  const world = setup({
    method: 'saldo',
    timing: 'soll',
    saldoRates: [{ rateBp: 620 }, { rateBp: 530 }],
  });
  const ctx = enforcing(world);
  sale(ctx, { net: 4_400_000, taxCode: 'UST81', date: '2026-03-15' });
  const r = refusal(computeVatReturn(ctx, H1), 'saldo_activity_split_required');
  assert.equal(Array.isArray(r.rates), true, 'the refusal must name the configured rates');
  assert.equal(r.rates.length, 2);
  return r;
}

/**
 * Effektiv on IST timing: `unsupported`, because the engine will not hand an Ist filer Soll figures.
 *
 * NOT IN THE UX DESIGN. The slice's rows 3.1 and 3.2 assume an Ist return computes, and it does not:
 * `abrechnung.ts` refuses before reading a single row. Recording it is what makes the surface's
 * fourth refusal a real state instead of a crash.
 */
export function liveIstRefusal() {
  const world = setup({ method: 'effektiv', timing: 'ist' });
  const ctx = enforcing(world);
  const r = refusal(computeVatReturn(ctx, Q2), 'unsupported');
  assert.equal(r.reason, 'ist_timing_not_implemented');
  return r;
}

/** No MWST configuration at all. */
export function liveNeedsConfig() {
  const world = setup({ registered: false });
  const ctx = enforcing(world);
  return {
    return: refusal(computeVatReturn(ctx, Q2), 'needs_vat_config'),
    periods: refusal(listVatPeriods(ctx, { year: YEAR }), 'needs_vat_config'),
  };
}

/**
 * The healthy book, filed.
 *
 * The banner claims the figures are RECOMPUTED and are not a stored copy, so the recording proves
 * exactly that: the return still computes on a hard-locked period and comes back identical.
 */
export function liveFiled() {
  const world = setup({ method: 'effektiv', timing: 'soll' });
  const ctx = enforcing(world);
  seedEffektivBook(ctx);

  const before = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  const filing = unwrap(markVatPeriodFiled(ctx, { period: '2026-Q2', idempotencyKey: 'a07-gui-file' }), 'vat_mark_filed');
  const periods = unwrap(listVatPeriods(ctx, { year: YEAR }), 'vat_periods');
  const after = unwrap(computeVatReturn(ctx, Q2), 'vat_return');

  const q2 = periods.periods.find((p) => p.label === '2026-Q2');
  assert.equal(q2.filed, true, 'the filed world must report Q2 filed');
  assert.equal(
    JSON.stringify(after),
    JSON.stringify(before),
    'a filed period must recompute identically, which is what the banner tells the operator',
  );

  return { filing, periods, return: after };
}
