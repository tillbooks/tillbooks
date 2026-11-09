// A06, the VAT-on-transactions engine: computeLineTax + buildVatLines.
//
// This is the money path (Pattern P2, the rounding risk centre). Every property the spec §8 names
// is pinned here: net + tax == gross after the SINGLE round, round-once reproducibility, import
// takes the assessed tax verbatim, deductibility follows the method/kind, the supply-date rate
// governs a rate-change straddle and the frozen trace reproduces after the rate later changes, and
// Sigma debit == Sigma credit on every buildVatLines result.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLineTax, buildVatLines } from '../../dist/core/vat/index.js';
import { VAT_RATE_ERAS } from '../../dist/core/vat/rateEras.js';
import { setup } from './support.mjs';

/** Round half-away-from-zero, integer-exact, the reference the engine must match. */
function refRound(numer, denom) {
  const sign = numer < 0 ? -1 : 1;
  const a = Math.abs(numer);
  return sign * Math.floor((a + Math.trunc(denom / 2)) / denom);
}

/**
 * Seeded PRNG (mulberry32) so a failing property draw is REPRODUCIBLE from the seed in the test
 * name, never a one-off flake nobody can chase (§8, m3).
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- computeLineTax: the core per-line computation ---------------------------------------------

test('computeLineTax: output net at 8.1% is 81.00 tax, 1081.00 gross, one round', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST81' });
  assert.equal(r.ok, true);
  assert.equal(r.netMinor, 100000);
  assert.equal(r.taxMinor, 8100);
  assert.equal(r.grossMinor, 108100);
  assert.equal(r.kind, 'output');
  assert.equal(r.deductible, false);
  assert.equal(r.formLine, '303');
  assert.deepEqual(r.trace, { taxCode: 'UST81', taxBaseMinor: 100000, taxAmountMinor: 8100 });
});

test('computeLineTax: gross input back-computes the same net/tax (base is canonical)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = computeLineTax(ctx, { amountMinor: 108100, amountIsGross: true, taxCode: 'UST81' });
  assert.equal(r.netMinor, 100000);
  assert.equal(r.taxMinor, 8100);
  assert.equal(r.grossMinor, 108100);
});

test('computeLineTax: reduced (2.6%) and Beherbergung (3.8%) rates', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const red = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST26' });
  assert.equal(red.taxMinor, 2600);
  assert.equal(red.formLine, '313');
  const bev = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST38' });
  assert.equal(bev.taxMinor, 3800);
  assert.equal(bev.formLine, '343');
});

test('PROPERTY net + tax == gross after the single round, for random amounts and every rate (seed 1)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const rand = mulberry32(1);
  const codes = ['UST81', 'UST26', 'UST38'];
  for (let i = 0; i < 500; i += 1) {
    const amountMinor = 1 + Math.floor(rand() * 5_000_000);
    const taxCode = codes[i % codes.length];
    for (const amountIsGross of [false, true]) {
      const r = computeLineTax(ctx, { amountMinor, amountIsGross, taxCode });
      assert.equal(r.ok, true);
      assert.equal(r.netMinor + r.taxMinor, r.grossMinor, `net+tax==gross for ${taxCode} ${amountMinor} gross=${amountIsGross}`);
      assert.ok(Number.isInteger(r.netMinor) && Number.isInteger(r.taxMinor));
    }
  }
});

// B1, the PRIMARY money-preservation invariant: for gross input, `grossMinor` IS the entered amount
// (never a recomputed net+tax that drifts a Rappen), and the whole gross is split, net + tax == G.
// The old property was vacuous for gross input: it asserted net+tax==gross where gross was DEFINED
// as net+tax.
test('B1 PROPERTY gross input preserves the ENTERED gross: net + tax == the input amount (seed 2)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const rand = mulberry32(2);
  const codes = ['UST81', 'UST26', 'UST38'];
  for (let i = 0; i < 2000; i += 1) {
    const amountMinor = 1 + Math.floor(rand() * 5_000_000);
    const taxCode = codes[i % codes.length];
    const r = computeLineTax(ctx, { amountMinor, amountIsGross: true, taxCode });
    assert.equal(r.ok, true);
    assert.equal(r.grossMinor, amountMinor, `grossMinor is the entered amount for ${taxCode} ${amountMinor}`);
    assert.equal(r.netMinor + r.taxMinor, amountMinor, `net+tax preserves the gross for ${taxCode} ${amountMinor}`);
  }
});

test('B1: gross 1000.06 at 8.1% splits to net + tax == 1000.06 exactly (the critic drift case)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = computeLineTax(ctx, { amountMinor: 100006, amountIsGross: true, taxCode: 'UST81' });
  assert.equal(r.netMinor + r.taxMinor, 100006);
  assert.equal(r.grossMinor, 100006);
});

test('B1: gross 1.00 at 8.1% books net 93 + tax 7, gross stays 100 (was drifting to 101)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = computeLineTax(ctx, { amountMinor: 100, amountIsGross: true, taxCode: 'UST81' });
  assert.equal(r.taxMinor, 7);
  assert.equal(r.netMinor, 93);
  assert.equal(r.grossMinor, 100);
});

// Round-once reproducibility, per input mode. NET input: the tax re-derives from the stored base.
// GROSS input: the ONE round lands on the tax-from-gross, so the reproduction runs the same gross
// split on the preserved gross (base + tax), which must return the stored figures verbatim. (The
// stored base of a gross line may legitimately re-derive to tax±1 Rappen under the net formula:
// money preservation of the entered gross is the primary invariant, see applyVat.ts.)
test('PROPERTY round-once: recomputing by the input mode reproduces the stored tax (seed 3)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const rand = mulberry32(3);
  const codes = [['UST81', 810], ['UST26', 260], ['UST38', 380]];
  for (let i = 0; i < 500; i += 1) {
    const amountMinor = 1 + Math.floor(rand() * 5_000_000);
    const [taxCode, rateBp] = codes[i % codes.length];

    const net = computeLineTax(ctx, { amountMinor, amountIsGross: false, taxCode });
    assert.equal(refRound(net.trace.taxBaseMinor * rateBp, 10000), net.trace.taxAmountMinor, `net round-once for ${taxCode} ${amountMinor}`);

    const gross = computeLineTax(ctx, { amountMinor, amountIsGross: true, taxCode });
    const replay = computeLineTax(ctx, {
      amountMinor: gross.trace.taxBaseMinor + gross.trace.taxAmountMinor,
      amountIsGross: true,
      taxCode,
    });
    assert.equal(replay.trace.taxAmountMinor, gross.trace.taxAmountMinor, `gross round-once for ${taxCode} ${amountMinor}`);
    assert.equal(replay.trace.taxBaseMinor, gross.trace.taxBaseMinor, `gross base stable for ${taxCode} ${amountMinor}`);
  }
});

test('computeLineTax: a half-Rappen rounds AWAY from zero (commercial P2)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  // 123.45 * 8.1% = 9.99945 CHF -> 999.945 Rappen -> rounds to 1000 (away from zero).
  const r = computeLineTax(ctx, { amountMinor: 12345, amountIsGross: false, taxCode: 'UST81' });
  assert.equal(r.taxMinor, 1000);
  assert.equal(r.grossMinor, 13345);
});

test('computeLineTax: IMPORT takes the assessed tax verbatim, never rate-derived', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = computeLineTax(ctx, { amountMinor: 15500, amountIsGross: false, taxCode: 'IMPORT' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'import');
  assert.equal(r.taxMinor, 15500, 'the assessed amount is the tax, taken as given');
  assert.equal(r.deductible, true);
  assert.equal(r.trace.taxAmountMinor, 15500);
});

test('computeLineTax: Bezugsteuer (reverse charge) computes 8.1% and is deductible under effektiv', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = computeLineTax(ctx, { amountMinor: 200000, amountIsGross: false, taxCode: 'BEZUG' });
  assert.equal(r.kind, 'reverse_charge');
  assert.equal(r.taxMinor, 16200);
  assert.equal(r.deductible, true);
  assert.equal(r.formLine, '383');
});

test('computeLineTax: zero-rated (Export) and exempt (Ausgenommen) carry base, zero tax, no deduction', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const zero = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'EXPORT0' });
  assert.equal(zero.kind, 'zero');
  assert.equal(zero.taxMinor, 0);
  assert.equal(zero.netMinor, 100000);
  assert.equal(zero.formLine, '220');
  assert.equal(zero.deductible, false);
  const ex = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'AUSGENOMMEN' });
  assert.equal(ex.kind, 'exempt');
  assert.equal(ex.taxMinor, 0);
  assert.equal(ex.formLine, '230');
  assert.equal(ex.deductible, false);
});

test('PROPERTY deductibility is false under saldo for every kind (Art. 37)', () => {
  const { ctx } = setup({ method: 'saldo' });
  for (const taxCode of ['VST-M', 'VST-I', 'BEZUG', 'IMPORT']) {
    const r = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode });
    assert.equal(r.deductible, false, `${taxCode} is not separately deductible under saldo`);
  }
});

// M3: a malformed supply date must be a structured rejection, never silently treated as ABSENT.
// The old fallback quietly picked the CURRENT rate for '15.06.2023' (8.1% instead of 7.7%), the
// exact silent-coercion failure rateEras.ts documents as forbidden on the money path.
test('M3: a malformed supplyDate is a structured invalid_date error, never the current-rate fallback', () => {
  const { ctx } = setup({ method: 'effektiv' });
  for (const supplyDate of ['15.06.2023', '2023-13-01', '2023-06-31', 'gestern', 123]) {
    const r = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST81', supplyDate });
    assert.equal(r.ok, false, `must reject supplyDate ${String(supplyDate)}`);
    assert.equal(r.error, 'invalid_date');
  }
  // A full ISO timestamp names its day and stays accepted (toIsoDay semantics).
  const ts = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST81', supplyDate: '2023-06-15T10:00:00.000Z' });
  assert.equal(ts.ok, true);
  assert.equal(ts.taxMinor, 7700);
});

// m6: a pre-2018 supply date has NO published rate era (the documented rateEras gap). A rate-bearing
// code must surface that as a structured signal, never silently compute at the CURRENT rate (2016
// would book 8.1% where the statutory rate was 8.0%).
test('m6: a pre-2018 supply date on a rate-bearing code is rate_era_unknown, not the current rate', () => {
  const { ctx } = setup({ method: 'effektiv' });
  for (const taxCode of ['UST81', 'VST-M', 'BEZUG']) {
    const r = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode, supplyDate: '2016-06-15' });
    assert.equal(r.ok, false, `must reject pre-2018 date for ${taxCode}`);
    assert.equal(r.error, 'rate_era_unknown');
  }
  // Codes that never consult a rate era stay computable for any date: import (assessed, taken as
  // given) and the 0% kinds (zero/exempt).
  for (const taxCode of ['IMPORT', 'EXPORT0', 'AUSGENOMMEN']) {
    const r = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode, supplyDate: '2016-06-15' });
    assert.equal(r.ok, true, `${taxCode} needs no rate era`);
  }
});

// m2: the amount is integer Rappen by contract; in-process callers (A11/A17) bypass the MCP schema,
// so the engine itself must refuse a float or a numeric string instead of flowing it into the trace.
test('m2: a non-integer amountMinor is a structured invalid_amount error', () => {
  const { ctx } = setup({ method: 'effektiv' });
  for (const amountMinor of [1000.5, '1000', NaN, Infinity, 2 ** 53]) {
    const r = computeLineTax(ctx, { amountMinor, amountIsGross: false, taxCode: 'UST81' });
    assert.equal(r.ok, false, `must reject amountMinor ${String(amountMinor)}`);
    assert.equal(r.error, 'invalid_amount');
  }
});

test('computeLineTax: an unknown code is a structured error, not a crash', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = computeLineTax(ctx, { amountMinor: 100, amountIsGross: false, taxCode: 'NOPE' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown_tax_code');
});

// m1: a workspace with NO tax codes at all is not "a workspace where every code is unknown", it is
// an unconfigured workspace (P9). The engine must say needs_vat_config, the same code the GUI's
// banner-CTA branches on, so agent and human share one code path for the state.
test('m1: computeLineTax on an unconfigured workspace is needs_vat_config, not unknown_tax_code', () => {
  for (const opts of [{ registered: false }, { registered: true, seed: false }]) {
    const { ctx } = setup({ method: 'effektiv', ...opts });
    const r = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST81' });
    assert.equal(r.ok, false, `rejects for ${JSON.stringify(opts)}`);
    assert.equal(r.error, 'needs_vat_config', `P9 code for ${JSON.stringify(opts)}`);
  }
  // A no-VAT line stays computable even unconfigured: it consults no code.
  const { ctx } = setup({ method: 'effektiv', registered: false });
  const none = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: null });
  assert.equal(none.ok, true);
});

test('computeLineTax: a none/absent code is zero VAT with a null trace', () => {
  const { ctx } = setup({ method: 'effektiv' });
  for (const taxCode of [undefined, null, 'none']) {
    const r = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'none');
    assert.equal(r.taxMinor, 0);
    assert.equal(r.netMinor, 100000);
    assert.deepEqual(r.trace, { taxCode: null, taxBaseMinor: null, taxAmountMinor: null });
  }
});

test('PROPERTY rate-change straddle: the supply-date rate governs and the frozen trace reproduces', () => {
  const { ctx } = setup({ method: 'effektiv' });
  // UST81 is the Normalsatz code. The Normalsatz was 7.7% before 2024-01-01 and 8.1% from it. A
  // line whose supply date falls in the old era must compute 7.7%, and that stamped figure must
  // reproduce verbatim later (A07 reads the trace, never recomputes), even once the rate has moved.
  const old = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST81', supplyDate: '2023-06-15' });
  assert.equal(old.taxMinor, 7700, 'the 2023 supply date uses the 7.7% Normalsatz of its era');
  const current = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST81', supplyDate: '2024-06-15' });
  assert.equal(current.taxMinor, 8100, 'the 2024 supply date uses the 8.1% Normalsatz');
  // The frozen trace from the old period is stable: reading it back reproduces 77.00, not 81.00.
  assert.equal(old.trace.taxAmountMinor, 7700);
  assert.notEqual(old.trace.taxAmountMinor, current.trace.taxAmountMinor);
});

// M2: the Leistungsdatum governs the ESTV Ziffer VINTAGE too (spec §3): the trailing digit encodes
// the rate era (…2 = 2018-2023, …3 = from 2024), so a 2023 straddle reports on legacy 302/382, not
// on the current 303/383 the code stores. The period-stable lines (400/405/220/230) never shift.
test('M2: a 2023 supply date resolves the LEGACY Ziffer vintage (302/312/342/382), 2024+ the current', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const cases = [
    ['UST81', '302', '303'],
    ['UST26', '312', '313'],
    ['UST38', '342', '343'],
    ['BEZUG', '382', '383'],
  ];
  for (const [taxCode, legacy, current] of cases) {
    const old = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode, supplyDate: '2023-06-15' });
    assert.equal(old.formLine, legacy, `${taxCode} 2023 lands on the legacy Ziffer`);
    const cur = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode, supplyDate: '2024-06-15' });
    assert.equal(cur.formLine, current, `${taxCode} 2024 lands on the current Ziffer`);
    const none = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode });
    assert.equal(none.formLine, current, `${taxCode} without a supply date keeps the stored (current) Ziffer`);
  }
  // Period-stable lines never shift vintage.
  for (const [taxCode, stable] of [['VST-M', '400'], ['VST-I', '405'], ['EXPORT0', '220'], ['AUSGENOMMEN', '230'], ['IMPORT', '400']]) {
    const r = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode, supplyDate: '2023-06-15' });
    assert.equal(r.formLine, stable, `${taxCode} Ziffer is period-stable`);
  }
});

test('M2: the saldo output Ziffer follows the supply-date vintage too (323 -> 322 for 2023)', () => {
  const { ctx } = setup({ method: 'saldo' });
  const cur = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST81', supplyDate: '2024-06-15' });
  assert.equal(cur.formLine, '323');
  const old = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST81', supplyDate: '2023-06-15' });
  assert.equal(old.formLine, '322');
});

// M1: the promised 2028 rate change is "an added era ROW rather than any code edit". That promise
// held only while the stored rate happened to match the CURRENT era: the class lookup reverse-matched
// against the newest era alone, so appending 2028 (850bp) silently flipped every 2023 straddle from
// 7.7% to the stored 8.1%. The straddle test above never mutates the table, so only this one catches it.
test('M1: appending a future era row leaves historical straddles unchanged and prices the future era', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const appended = {
    effectiveFrom: '2028-01-01',
    normalBp: 850,
    reducedBp: 260,
    accommodationBp: 400,
    saldoLadderBp: [],
    source: 'TEST-ONLY appended era (popped in finally)',
  };
  VAT_RATE_ERAS.push(appended);
  try {
    const old = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST81', supplyDate: '2023-06-15' });
    assert.equal(old.taxMinor, 7700, 'the 2023 straddle stays 7.7% after the 2028 era is appended');
    const cur = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST81', supplyDate: '2024-06-15' });
    assert.equal(cur.taxMinor, 8100, 'the 2024 era stays 8.1%');
    const fut = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST81', supplyDate: '2028-06-15' });
    assert.equal(fut.taxMinor, 8500, 'the stored 810bp names the Normalsatz CLASS; the 2028 era prices it');
    const red = computeLineTax(ctx, { amountMinor: 100000, amountIsGross: false, taxCode: 'UST26', supplyDate: '2023-06-15' });
    assert.equal(red.taxMinor, 2500, 'the reduced class resolves per era too');
  } finally {
    assert.equal(VAT_RATE_ERAS.pop(), appended, 'the test-only era is removed again');
  }
});

test('computeLineTax: input VAT resolves the Normalsatz on the supply date (VST codes carry no rate)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const cur = computeLineTax(ctx, { amountMinor: 108100, amountIsGross: true, taxCode: 'VST-M', supplyDate: '2024-06-15' });
  assert.equal(cur.netMinor, 100000);
  assert.equal(cur.taxMinor, 8100);
  assert.equal(cur.deductible, true);
  const old = computeLineTax(ctx, { amountMinor: 107700, amountIsGross: true, taxCode: 'VST-M', supplyDate: '2023-06-15' });
  assert.equal(old.taxMinor, 7700, 'a 2023 supplier bill splits at 7.7%');
  assert.equal(old.netMinor, 100000);
});

// --- buildVatLines: the balanced expansion ready for postEntry ---------------------------------

/** Look up the seeded KMU account id by its number, for asserting the booked accounts. */
function acc(ctx, number) {
  return ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number).id;
}

function sums(lines) {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    debit += l.debit ?? 0;
    credit += l.credit ?? 0;
  }
  return { debit, credit };
}

test('buildVatLines: output invoice books gross debtor / net revenue / output VAT, balanced', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '1100'),
    revenueOrExpenseAccount: acc(ctx, '3200'),
    amountMinor: 100000,
    amountIsGross: false,
    taxCode: 'UST81',
    direction: 'output',
  });
  const s = sums(lines);
  assert.equal(s.debit, s.credit, 'Sigma debit == Sigma credit');
  assert.equal(s.debit, 108100);
  // The debtor carries the gross, revenue the net with the frozen trace, 2200 the output VAT.
  const debtor = lines.find((l) => l.account === acc(ctx, '1100'));
  const revenue = lines.find((l) => l.account === acc(ctx, '3200'));
  const output = lines.find((l) => l.account === acc(ctx, '2200'));
  assert.equal(debtor.debit, 108100);
  assert.equal(revenue.credit, 100000);
  assert.equal(revenue.taxCode, 'UST81');
  assert.equal(revenue.taxBase, 100000);
  assert.equal(revenue.taxAmount, 8100);
  assert.equal(output.credit, 8100);
});

test('buildVatLines: input expense books net cost / input VAT (1170) / gross creditor, balanced', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '2000'),
    revenueOrExpenseAccount: acc(ctx, '4000'),
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    direction: 'input',
    supplyDate: '2024-06-15',
  });
  const s = sums(lines);
  assert.equal(s.debit, s.credit);
  assert.equal(s.credit, 108100);
  assert.equal(lines.find((l) => l.account === acc(ctx, '1170')).debit, 8100);
  assert.equal(lines.find((l) => l.account === acc(ctx, '4000')).debit, 100000);
  assert.equal(lines.find((l) => l.account === acc(ctx, '2000')).credit, 108100);
});

test('buildVatLines: VST-I books the input VAT to 1171 (Investitionen), not 1170', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '2000'),
    revenueOrExpenseAccount: acc(ctx, '4000'),
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-I',
    direction: 'input',
    supplyDate: '2024-06-15',
  });
  assert.equal(lines.find((l) => l.account === acc(ctx, '1171')).debit, 8100);
  assert.equal(lines.some((l) => l.account === acc(ctx, '1170')), false);
});

test('buildVatLines: a fully-deductible Bezugsteuer nets to zero across 2200 and 1170', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '2000'),
    revenueOrExpenseAccount: acc(ctx, '4000'),
    amountMinor: 200000,
    amountIsGross: false,
    taxCode: 'BEZUG',
    direction: 'input',
  });
  const s = sums(lines);
  assert.equal(s.debit, s.credit, 'Sigma debit == Sigma credit');
  const output = lines.find((l) => l.account === acc(ctx, '2200'));
  const input = lines.find((l) => l.account === acc(ctx, '1170'));
  assert.equal(output.credit, 16200);
  assert.equal(input.debit, 16200, 'the deduction leg cancels the owed leg to zero');
});

test('buildVatLines: import books the assessed Vorsteuer against the counter, balanced', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '1020'),
    revenueOrExpenseAccount: acc(ctx, '4000'),
    amountMinor: 15500,
    amountIsGross: false,
    taxCode: 'IMPORT',
    direction: 'input',
  });
  const s = sums(lines);
  assert.equal(s.debit, s.credit);
  assert.equal(lines.find((l) => l.account === acc(ctx, '1170')).debit, 15500);
  assert.equal(lines.find((l) => l.account === acc(ctx, '1020')).credit, 15500);
});

test('buildVatLines: under saldo an input expense books GROSS to the cost account, no 1170 split', () => {
  const { ctx } = setup({ method: 'saldo' });
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '2000'),
    revenueOrExpenseAccount: acc(ctx, '4000'),
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    direction: 'input',
    supplyDate: '2024-06-15',
  });
  const s = sums(lines);
  assert.equal(s.debit, s.credit);
  assert.equal(lines.find((l) => l.account === acc(ctx, '4000')).debit, 108100, 'gross to the cost account');
  assert.equal(lines.some((l) => l.account === acc(ctx, '1170')), false, 'no input-VAT split under saldo');
});

// M4 reachability + m5: the non-deductible Bezugsteuer branch (the tax becomes a REAL COST on the
// expense account, US-A06.3) is reachable under saldo and books balanced. (The effektiv-with-exempt-
// activity case needs a data model concept A06 does not own; logged in the spec §3, see M4.)
test('M4/m5: non-deductible Bezugsteuer (saldo) books the tax as a real cost, no 1170 leg, balanced', () => {
  const { ctx } = setup({ method: 'saldo' });
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '2000'),
    revenueOrExpenseAccount: acc(ctx, '4000'),
    amountMinor: 200000,
    amountIsGross: false,
    taxCode: 'BEZUG',
    direction: 'input',
  });
  const s = sums(lines);
  assert.equal(s.debit, s.credit, 'Sigma debit == Sigma credit');
  const output = lines.find((l) => l.account === acc(ctx, '2200'));
  assert.equal(output.credit, 16200, 'the owed leg books regardless of deductibility');
  assert.equal(lines.some((l) => l.account === acc(ctx, '1170')), false, 'no deduction leg under saldo');
  const expenseDebits = lines.filter((l) => l.account === acc(ctx, '4000')).reduce((t, l) => t + (l.debit ?? 0), 0);
  assert.equal(expenseDebits, 216200, 'net + the non-deductible tax both land on the expense (a real cost)');
});

// m5: the saldo OUTPUT booking via buildVatLines (§8): the customer still sees the normal rate
// booked to 2200 (Art. 37 changes settlement, not invoicing).
test('m5: saldo output books gross debtor / net revenue / 2200 at the normal rate, balanced', () => {
  const { ctx } = setup({ method: 'saldo' });
  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '1100'),
    revenueOrExpenseAccount: acc(ctx, '3200'),
    amountMinor: 100000,
    amountIsGross: false,
    taxCode: 'UST81',
    direction: 'output',
  });
  const s = sums(lines);
  assert.equal(s.debit, s.credit);
  assert.equal(lines.find((l) => l.account === acc(ctx, '1100')).debit, 108100);
  assert.equal(lines.find((l) => l.account === acc(ctx, '3200')).credit, 100000);
  assert.equal(lines.find((l) => l.account === acc(ctx, '2200')).credit, 8100);
});

// m7: Bezugsteuer and Einfuhrsteuer are input-side bookings by construction; a caller passing
// direction 'output' is a defect at the call site and must fail loudly, not book the same lines.
test('m7: buildVatLines rejects a mis-called direction for reverse_charge and import', () => {
  const { ctx } = setup({ method: 'effektiv' });
  for (const taxCode of ['BEZUG', 'IMPORT']) {
    assert.throws(
      () =>
        buildVatLines(ctx, {
          counterAccount: acc(ctx, '2000'),
          revenueOrExpenseAccount: acc(ctx, '4000'),
          amountMinor: 100000,
          amountIsGross: false,
          taxCode,
          direction: 'output',
        }),
      /invalid_direction/,
      `${taxCode} with direction output must throw`,
    );
  }
});

test('PROPERTY every buildVatLines result balances, for random amounts and every taxable kind (seed 4)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const rand = mulberry32(4);
  const cases = [
    { taxCode: 'UST81', direction: 'output', counter: '1100', main: '3200' },
    { taxCode: 'UST26', direction: 'output', counter: '1100', main: '3200' },
    { taxCode: 'VST-M', direction: 'input', counter: '2000', main: '4000' },
    { taxCode: 'BEZUG', direction: 'input', counter: '2000', main: '4000' },
  ];
  for (let i = 0; i < 400; i += 1) {
    const c = cases[i % cases.length];
    const amountMinor = 1 + Math.floor(rand() * 5_000_000);
    const lines = buildVatLines(ctx, {
      counterAccount: acc(ctx, c.counter),
      revenueOrExpenseAccount: acc(ctx, c.main),
      amountMinor,
      amountIsGross: i % 2 === 0,
      taxCode: c.taxCode,
      direction: c.direction,
    });
    const s = sums(lines);
    assert.equal(s.debit, s.credit, `balanced for ${c.taxCode} ${amountMinor}`);
  }
});
