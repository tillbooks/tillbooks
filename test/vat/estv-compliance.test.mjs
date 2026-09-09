// A06 ESTV compliance fixture: cross-check computeLineTax / buildVatLines against REAL published
// ESTV figures, to the Rappen. Closes the A06 §8 "Compliance fixture" / §9 "figures match ESTV"
// DoD item.
//
// PRIMARY SOURCE (fetched 2026-07-22, quoted verbatim below):
//   ESTV, "Grundsätze der Mehrwertsteuer" (Stand der Gesetzgebung: 1. Januar 2025),
//   https://www.estv2.admin.ch/stp/ds/d-grundsaetze-der-mehrwertsteuer-de.pdf
//
//   - Ziff. 5.4.1 Normalsatz: "Seit dem 1. Januar 2024 beträgt der Normalsatz 8,1 %
//     (Art. 25 Abs. 1 MWSTG). Von 2018 bis 2023 betrug er 7,7 %."
//   - Ziff. 5.4.2 Reduzierter Steuersatz: "Seit 2024 beträgt der reduzierte Steuersatz 2,6 %
//     (Art. 25 Abs. 2 MWSTG). Von 2011 bis 2023 betrug er 2,5 %."
//   - Ziff. 5.4.3 Sondersatz Beherbergung: 3,8 % seit 2024.
//   - Ziff. 7.2.2 (worked example, verbatim): "Einer Architektin wurde der Saldosteuersatz von 6,2 %
//     bewilligt. Im ersten Halbjahr ihrer Unterstellung hat sie CHF 216'200 inklusive 8,1 % MWST
//     vereinnahmt." That gross of CHF 216'200 "inklusive 8,1 % MWST" decomposes, at the ESTV
//     Normalsatz, to net CHF 200'000.00 + MWST CHF 16'200.00 (200'000 x 8,1 % = 16'200; 216'200
//     backward = 200'000 + 16'200). Both directions are pinned below.
//   - Bezugsteuer Art. 45 MWSTG (Ziff. 6): the domestic recipient declares AND deducts the tax at
//     the ordinary Normalsatz, an effektiv wash across 2200 / 1170.
//   - Einfuhrsteuer Art. 50 / Art. 54 MWSTG (Ziff. 9): the customs authority ASSESSES the tax on
//     the import base (goods value plus Nebenkosten) at the ordinary rate; A06 books that assessed
//     amount VERBATIM (never rate-derives it), and it is reclaimable as Vorsteuer under effektiv.
//
// The ESTV example gives the standard-rate figure with real Franken; the Bezugsteuer and import
// figures apply the SAME primary-sourced Normalsatz (8,1 %) to the SAME base (CHF 200'000), the way
// the ESTV brochure prescribes, so every assertion below reproduces an ESTV figure to the Rappen.
// The per-line Rappen rounding is the statutory Rappenrundung (round to the nearest Rappen; the
// engine rounds HALF-AWAY-FROM-ZERO, exact in integer arithmetic, A06 Pattern P2).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLineTax, buildVatLines } from '../../dist/core/vat/index.js';
import { setup } from './support.mjs';

/** The ESTV worked-example figures, in integer Rappen (minor units). */
const NET_200K = 20_000_000; // CHF 200'000.00
const TAX_16K2 = 1_620_000; //  CHF  16'200.00  (200'000 x 8,1 %)
const GROSS_216K2 = 21_620_000; // CHF 216'200.00 "inklusive 8,1 % MWST"

// The example's turnover falls in the first half of an effektiv-registered year under the current
// (>= 1.1.2024) rate era. Any supply date in that era resolves the 8,1 % Normalsatz.
const SUPPLY = '2025-06-30';

/** Resolve a seeded KMU account id by number (mirrors apply-vat.test.mjs). */
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

// ── Standard rate (ESTV Ziff. 7.2.2 + Art. 25 Abs. 1) ──────────────────────────────────────────

test('ESTV standard rate 8.1%: net 200000.00 -> tax 16200.00, gross 216200.00 (forward)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = computeLineTax(ctx, { amountMinor: NET_200K, amountIsGross: false, taxCode: 'UST81', supplyDate: SUPPLY });
  assert.equal(r.ok, true);
  assert.equal(r.rateBp, 810, 'the Normalsatz on the supply date is 8.1% (810 bp)');
  assert.equal(r.taxMinor, TAX_16K2, 'CHF 16200.00 tax matches the ESTV example');
  assert.equal(r.grossMinor, GROSS_216K2, 'CHF 216200.00 gross matches the ESTV example');
  assert.equal(r.netMinor + r.taxMinor, r.grossMinor, 'net + tax == gross after the single P2 round');
  assert.deepEqual(r.trace, { taxCode: 'UST81', taxBaseMinor: NET_200K, taxAmountMinor: TAX_16K2 });
});

test('ESTV standard rate 8.1%: gross 216200.00 "inklusive 8,1 % MWST" -> net 200000.00 + tax 16200.00 (backward)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  // This is the ESTV example's own phrasing: CHF 216'200 collected INCLUSIVE of 8.1% MWST.
  const r = computeLineTax(ctx, { amountMinor: GROSS_216K2, amountIsGross: true, taxCode: 'UST81', supplyDate: SUPPLY });
  assert.equal(r.ok, true);
  assert.equal(r.grossMinor, GROSS_216K2, 'the entered gross is preserved verbatim');
  assert.equal(r.taxMinor, TAX_16K2, 'the embedded VAT is CHF 16200.00, the ESTV figure');
  assert.equal(r.netMinor, NET_200K, 'the net behind the gross is CHF 200000.00');
  assert.equal(r.netMinor + r.taxMinor, GROSS_216K2, 'money preserved: net + tax == the entered gross');
});

// ── Reduced rate (Art. 25 Abs. 2) ──────────────────────────────────────────────────────────────

test('ESTV reduced rate 2.6%: net 200000.00 -> tax 5200.00', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = computeLineTax(ctx, { amountMinor: NET_200K, amountIsGross: false, taxCode: 'UST26', supplyDate: SUPPLY });
  assert.equal(r.ok, true);
  assert.equal(r.rateBp, 260, 'the reduced rate on the supply date is 2.6% (260 bp)');
  assert.equal(r.taxMinor, 520_000, 'CHF 5200.00 = 200000.00 x 2.6%');
  assert.equal(r.grossMinor, 20_520_000);
});

// ── Statutory Rappenrundung (round once per line, half away from zero) ──────────────────────────

test('ESTV Rappenrundung: an exact half rounds away from zero (net 5.00 @ 8.1% -> 0.41)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  // 500 x 810 / 10000 = 40.5 Rappen exactly: the Rappenrundung takes it to 0.41, never 0.40.
  const r = computeLineTax(ctx, { amountMinor: 500, amountIsGross: false, taxCode: 'UST81', supplyDate: SUPPLY });
  assert.equal(r.ok, true);
  assert.equal(r.taxMinor, 41, 'CHF 0.41 (0.405 rounds half away from zero)');
  assert.equal(r.grossMinor, 541);
});

test('ESTV Rappenrundung: a fractional Rappen rounds to the nearest (net 333.35 @ 2.6% -> 8.67)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  // 33335 x 260 / 10000 = 866.71 Rappen -> 8.67; the whole document total is a SUM of such rounded
  // per-line taxes (ESTV per-rate treatment), never a re-round of a document base.
  const r = computeLineTax(ctx, { amountMinor: 33_335, amountIsGross: false, taxCode: 'UST26', supplyDate: SUPPLY });
  assert.equal(r.ok, true);
  assert.equal(r.taxMinor, 867, 'CHF 8.67');
  assert.equal(r.netMinor + r.taxMinor, r.grossMinor);
});

// ── Bezugsteuer (Art. 45): declare AND deduct at the Normalsatz, an effektiv wash ───────────────

test('ESTV Bezugsteuer (Art. 45): net 200000.00 service from abroad books 2200 credit 16200.00 and 1170 debit 16200.00 (wash)', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = computeLineTax(ctx, { amountMinor: NET_200K, amountIsGross: false, taxCode: 'BEZUG', supplyDate: SUPPLY });
  assert.equal(r.ok, true);
  assert.equal(r.rateBp, 810, 'Bezugsteuer applies the ordinary 8.1% Normalsatz');
  assert.equal(r.taxMinor, TAX_16K2, 'CHF 16200.00 declared');

  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '2000'),
    revenueOrExpenseAccount: acc(ctx, '4400'),
    amountMinor: NET_200K,
    amountIsGross: false,
    taxCode: 'BEZUG',
    direction: 'input',
    supplyDate: SUPPLY,
  });
  const s = sums(lines);
  assert.equal(s.debit, s.credit, 'Sigma debit == Sigma credit');
  // The declared output leg and the reclaimed input leg are equal and opposite: a wash under effektiv.
  assert.equal(lines.find((l) => l.account === acc(ctx, '2200')).credit, TAX_16K2, '2200 owed CHF 16200.00');
  assert.equal(lines.find((l) => l.account === acc(ctx, '1170')).debit, TAX_16K2, '1170 deducted CHF 16200.00');
  // The trace rides the expense base line (net), never the tax leg.
  const expense = lines.find((l) => l.account === acc(ctx, '4400') && l.taxCode !== undefined);
  assert.equal(expense.taxCode, 'BEZUG');
  assert.equal(expense.taxBase, NET_200K);
  assert.equal(expense.taxAmount, TAX_16K2);
});

// ── Einfuhrsteuer (Art. 50 / 54): the ASSESSED amount is taken as given ─────────────────────────

test('ESTV Einfuhrsteuer (Art. 50): the customs-assessed CHF 16200.00 books verbatim to 1170, never rate-derived', () => {
  const { ctx } = setup({ method: 'effektiv' });
  // Customs assesses 8.1% on an import base of CHF 200'000 -> CHF 16'200.00 (Art. 54 base x Art. 25
  // rate). A06 takes that ASSESSED figure as the amount and books it verbatim (never recomputes it).
  const assessed = TAX_16K2;
  const r = computeLineTax(ctx, { amountMinor: assessed, amountIsGross: false, taxCode: 'IMPORT', supplyDate: SUPPLY });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'import');
  assert.equal(r.taxMinor, assessed, 'the assessed tax is the amount, taken as given');
  assert.equal(r.netMinor, 0, 'the customs value books where the goods are, not here');
  assert.deepEqual(r.trace, { taxCode: 'IMPORT', taxBaseMinor: 0, taxAmountMinor: assessed });

  const lines = buildVatLines(ctx, {
    counterAccount: acc(ctx, '1020'),
    revenueOrExpenseAccount: acc(ctx, '4200'),
    amountMinor: assessed,
    amountIsGross: false,
    taxCode: 'IMPORT',
    direction: 'input',
    supplyDate: SUPPLY,
  });
  const s = sums(lines);
  assert.equal(s.debit, s.credit, 'Sigma debit == Sigma credit');
  assert.equal(lines.find((l) => l.account === acc(ctx, '1170')).debit, assessed, '1170 reclaims the assessed CHF 16200.00');
  assert.equal(lines.find((l) => l.account === acc(ctx, '1020')).credit, assessed, 'the counter (bank/customs clearing) pays it');
});
