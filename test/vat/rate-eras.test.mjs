// A05 date-versioned VAT rate table.
//
// The Swiss VAT rates are not stable, so a bare `NORMAL_RATE_BP = 810` silently mis-computes every
// correction return for a pre-2024 period. The rates are resolved from the DATE of the period being
// reported, never from "now".
//
// Statutory sources (verified 2026-07-19, primary only):
//  - MWSTG SR 641.20 Art. 25, fedlex version in force 1.1.2023: 7.7 / 2.5 / 3.7.
//  - MWSTG SR 641.20 Art. 25, fedlex version in force 1.1.2024: 8.1 / 2.6 / 3.8.
//  - SR 641.202.62 in force 1.1.2018: ladder 0.1/0.6/1.2/2.0/2.8/3.5/4.3/5.1/5.9/6.5.
//  - SR 641.202.62 (AS 2023 18) in force 1.1.2024: ladder 0.1/0.6/1.3/2.1/3.0/3.7/4.5/5.3/6.2/6.8.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VAT_RATE_ERAS,
  EARLIEST_RATE_ERA_FROM,
  CURRENT_RATE_ERA_FROM,
  vatRatesOn,
  saldoLadderOn,
  normalRateBpOn,
  currentVatRates,
  NORMAL_RATE_BP,
  ESTV_SALDO_RATES_BP,
  configureVat,
  getVatConfig,
  upsertTaxCode,
  deactivateTaxCode,
  resolveTax,
} from '../../dist/core/vat/index.js';
import { setup } from './support.mjs';

// --- The table itself -------------------------------------------------------------------------

test('VAT_RATE_ERAS is ordered ascending by effectiveFrom with no duplicate era', () => {
  assert.ok(VAT_RATE_ERAS.length >= 2, 'at minimum the 2018 and the 2024 era');
  const froms = VAT_RATE_ERAS.map((e) => e.effectiveFrom);
  assert.deepEqual(froms, [...froms].sort(), 'eras are stored in ascending effective-from order');
  assert.equal(new Set(froms).size, froms.length, 'no two eras share an effective-from date');
  assert.equal(EARLIEST_RATE_ERA_FROM, froms[0]);
  assert.equal(CURRENT_RATE_ERA_FROM, froms[froms.length - 1]);
});

test('the 2018 era carries the VERIFIED 7.7 / 2.5 / 3.7 as integer basis points', () => {
  const era = VAT_RATE_ERAS.find((e) => e.effectiveFrom === '2018-01-01');
  assert.ok(era, 'the 2018-01-01 era is present');
  assert.equal(era.normalBp, 770);
  assert.equal(era.reducedBp, 250);
  assert.equal(era.accommodationBp, 370);
  for (const bp of [era.normalBp, era.reducedBp, era.accommodationBp]) {
    assert.equal(Number.isInteger(bp), true, 'rates are integer basis points, never floats');
  }
});

test('the 2024 era carries the VERIFIED 8.1 / 2.6 / 3.8 as integer basis points', () => {
  const era = VAT_RATE_ERAS.find((e) => e.effectiveFrom === '2024-01-01');
  assert.ok(era, 'the 2024-01-01 era is present');
  assert.equal(era.normalBp, 810);
  assert.equal(era.reducedBp, 260);
  assert.equal(era.accommodationBp, 380);
});

test('every era cites its statutory source', () => {
  for (const era of VAT_RATE_ERAS) {
    assert.equal(typeof era.source, 'string');
    assert.ok(era.source.length > 0, `era ${era.effectiveFrom} names its source`);
  }
});

// --- Boundary semantics: effective-from INCLUSIVE, era runs to the next era EXCLUSIVE ----------

test('vatRatesOn boundary: 2023-12-31 resolves to the OLD era and 2024-01-01 to the NEW one', () => {
  const before = vatRatesOn('2023-12-31');
  assert.equal(before.effectiveFrom, '2018-01-01');
  assert.equal(before.normalBp, 770, 'the last day of 2023 is still 7.7%');

  const on = vatRatesOn('2024-01-01');
  assert.equal(on.effectiveFrom, '2024-01-01');
  assert.equal(on.normalBp, 810, 'effective-from is INCLUSIVE, so 1.1.2024 is already 8.1%');
});

test('vatRatesOn: the earliest era boundary is inclusive in both directions', () => {
  assert.equal(vatRatesOn('2018-01-01').effectiveFrom, '2018-01-01', 'the first day of the era is in it');
  assert.equal(vatRatesOn('2017-12-31'), null, 'the day before it is outside every published era');
});

test('vatRatesOn: a mid-era date resolves to the era that opened before it', () => {
  assert.equal(vatRatesOn('2020-06-15').normalBp, 770);
  assert.equal(vatRatesOn('2026-07-19').normalBp, 810);
  assert.equal(vatRatesOn('2099-01-01').effectiveFrom, CURRENT_RATE_ERA_FROM,
    'the newest era runs open-ended until a later era is added as DATA');
});

test('vatRatesOn returns null before the earliest published era (a documented gap, never a guess)', () => {
  assert.equal(vatRatesOn('2011-01-01'), null, 'pre-2018 rates are not in the table, so no rate is invented');
  assert.equal(normalRateBpOn('2011-01-01'), null);
  assert.equal(saldoLadderOn('2011-01-01'), null);
});

test('vatRatesOn accepts a full ISO timestamp and rejects a malformed date', () => {
  assert.equal(vatRatesOn('2023-12-31T23:59:59.999Z').normalBp, 770);
  assert.equal(vatRatesOn('2024-01-01T00:00:00.000Z').normalBp, 810);
  for (const bad of ['', '2024', '01.01.2024', 'yesterday', null, undefined, 20240101]) {
    assert.throws(() => vatRatesOn(bad), /invalid_date/, `${String(bad)} is rejected, not silently coerced`);
  }
});

// --- NORMAL_RATE_BP derives from the table -----------------------------------------------------

test('NORMAL_RATE_BP derives from the current era in the table, not an independent literal', () => {
  assert.equal(NORMAL_RATE_BP, currentVatRates().normalBp);
  assert.equal(NORMAL_RATE_BP, vatRatesOn(CURRENT_RATE_ERA_FROM).normalBp);
  assert.equal(NORMAL_RATE_BP, 810, 'and today that value is still 8.1%');
});

test('normalRateBpOn resolves the Normalsatz per period, not per "now"', () => {
  assert.equal(normalRateBpOn('2019-04-30'), 770);
  assert.equal(normalRateBpOn('2023-12-31'), 770);
  assert.equal(normalRateBpOn('2024-01-01'), 810);
});

// --- The Saldosteuersatz ladder is era-dependent too -------------------------------------------

test('saldoLadderOn: the 2024 ladder is {10,60,130,210,300,370,450,530,620,680}', () => {
  assert.deepEqual(
    [...saldoLadderOn('2024-01-01')].sort((a, b) => a - b),
    [10, 60, 130, 210, 300, 370, 450, 530, 620, 680],
  );
});

test('saldoLadderOn: the 2018-2023 ladder is the VERIFIED pre-rebase ladder and DIFFERS from 2024', () => {
  assert.deepEqual(
    [...saldoLadderOn('2023-12-31')].sort((a, b) => a - b),
    [10, 60, 120, 200, 280, 350, 430, 510, 590, 650],
    'SR 641.202.62 in force 1.1.2018: 0.1/0.6/1.2/2.0/2.8/3.5/4.3/5.1/5.9/6.5',
  );
  assert.ok(saldoLadderOn('2023-12-31').has(650), '6.5% existed before the septennial rebase');
  assert.ok(!saldoLadderOn('2024-01-01').has(650), 'and is gone from the 2024 ladder');
  assert.ok(saldoLadderOn('2024-01-01').has(680), '6.8% is a 2024-era rung');
  assert.ok(!saldoLadderOn('2023-12-31').has(680), 'and did not exist before 2024');
});

test('ESTV_SALDO_RATES_BP stays the 2024 ladder and is the CURRENT era ladder, hard allow-list', () => {
  assert.deepEqual(
    [...ESTV_SALDO_RATES_BP].sort((a, b) => a - b),
    [10, 60, 130, 210, 300, 370, 450, 530, 620, 680],
  );
  assert.deepEqual(
    [...ESTV_SALDO_RATES_BP].sort((a, b) => a - b),
    [...saldoLadderOn(CURRENT_RATE_ERA_FROM)].sort((a, b) => a - b),
    'the legacy export is now a view onto the current era, not a second source of truth',
  );
});

// --- Future eras are DATA, and no unenacted era is live ----------------------------------------

test('a future era is a DATA addition: the same lookup code resolves an appended era', () => {
  // Proves requirement 1 without shipping unenacted law: the resolver is fed the table, so a new
  // era is one row, not a code change. This hypothetical row lives only inside this test.
  const hypothetical = [
    ...VAT_RATE_ERAS,
    { effectiveFrom: '2028-01-01', normalBp: 850, reducedBp: 260, accommodationBp: 380, saldoLadderBp: [10], source: 'HYPOTHETICAL, not law' },
  ];
  const resolve = (date) => [...hypothetical].reverse().find((e) => e.effectiveFrom <= date) ?? null;
  assert.equal(resolve('2027-12-31').normalBp, 810);
  assert.equal(resolve('2028-01-01').normalBp, 850);
});

test('no not-yet-enacted era is present in the live table (the 29.11.2026 referendum is not law)', () => {
  for (const era of VAT_RATE_ERAS) {
    assert.ok(era.effectiveFrom <= '2026-07-19',
      `era ${era.effectiveFrom} is in the future: unenacted rates must never be live data`);
    assert.notEqual(era.normalBp, 850, 'the proposed 8.5% Normalsatz is a scenario, not statute');
  }
});

// --- configureVat validates against the ladder IN FORCE FOR THE PERIOD --------------------------

test('configureVat with asOf in the 2018 era accepts the OLD ladder rate 650 bp', () => {
  const { ctx } = setup({ registered: false });
  const res = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'old-era',
    asOf: '2023-06-30', saldoRates: [{ rateBp: 650 }],
  });
  assert.equal(res.ok, true, '6.5% was a lawful Saldosteuersatz in a 2023 period');
  assert.equal(getVatConfig(ctx).config.saldoRates[0].rateBp, 650);
});

test('configureVat with asOf in the 2018 era REJECTS a 2024-only ladder rate (680 bp)', () => {
  const { ctx } = setup({ registered: false });
  const res = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'anachronism',
    asOf: '2023-06-30', saldoRates: [{ rateBp: 680 }],
  });
  assert.equal(res.ok, false, '6.8% did not exist before the 2024 rebase');
  assert.equal(res.error, 'invalid_saldo_rate');
});

test('configureVat boundary: 650 bp passes on 2023-12-31 and fails on 2024-01-01', () => {
  const before = setup({ registered: false });
  assert.equal(configureVat(before.ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'b1',
    asOf: '2023-12-31', saldoRates: [{ rateBp: 650 }],
  }).ok, true);

  const on = setup({ registered: false });
  assert.equal(configureVat(on.ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'b2',
    asOf: '2024-01-01', saldoRates: [{ rateBp: 650 }],
  }).ok, false, 'effective-from is inclusive, so 1.1.2024 is already on the new ladder');
});

test('configureVat with no asOf defaults to the CURRENT era ladder (back-compatible)', () => {
  const { ctx } = setup({ registered: false });
  assert.equal(configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'now-ok',
    saldoRates: [{ rateBp: 680 }],
  }).ok, true);

  const stale = setup({ registered: false });
  assert.equal(configureVat(stale.ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'now-stale',
    saldoRates: [{ rateBp: 650 }],
  }).ok, false, 'without a period date the current era governs, and 6.5% is off it');
});

test('configureVat rejects a saldo rate above the Normalsatz IN FORCE for that period', () => {
  const { ctx } = setup({ registered: false });
  const res = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'ceiling',
    asOf: '2019-03-31', saldoRates: [{ rateBp: 800 }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_saldo_rate');
  assert.match(String(res.reason), /Normalsatz/, '8.0% exceeded the 7.7% Normalsatz of a 2019 period');
  assert.equal(res.normalRateBp, 770, 'the ceiling reported is the period one, not today 810');
});

test('configureVat rejects a malformed asOf rather than silently falling back to today', () => {
  const { ctx } = setup({ registered: false });
  const res = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'bad-date',
    asOf: '31.12.2023', saldoRates: [{ rateBp: 620 }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_input');
});

// --- Requirement 3: old rates stay DECLARABLE INDEFINITELY -------------------------------------

test('configureVat with asOf before the earliest published era does NOT reject a historical rate', () => {
  const { ctx } = setup({ registered: false });
  const res = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'ancient',
    asOf: '2015-06-30', saldoRates: [{ rateBp: 640 }],
  });
  assert.equal(res.ok, true,
    'no published ladder for that date means the allow-list cannot be enforced, so it is not enforced');
  assert.equal(getVatConfig(ctx).config.saldoRates[0].rateBp, 640);
});

test('upsertTaxCode still accepts a historical 7.7% code on the old Ziffer 302 (correction returns)', () => {
  const { ctx } = setup({});
  const res = upsertTaxCode(ctx, { code: 'UST77', kind: 'output', rateBp: 770, formLine: '302', label: 'Umsatzsteuer 7.7% (Normalsatz bis 2023)' });
  assert.equal(res.ok, true, 'nothing in the code path rejects a historical rate');
  const r = resolveTax(ctx, { taxCode: 'UST77' });
  assert.equal(r.ok, true);
  assert.equal(r.rateBp, 770);
  assert.equal(r.formLine, '302');
});

test('an ARCHIVED historical-rate code still resolves, so an old period stays declarable forever', () => {
  const { ctx } = setup({});
  upsertTaxCode(ctx, { code: 'UST25', kind: 'output', rateBp: 250, formLine: '312' });
  assert.equal(deactivateTaxCode(ctx, { code: 'UST25' }).ok, true);
  const r = resolveTax(ctx, { taxCode: 'UST25' });
  assert.equal(r.ok, true, 'archived, never deleted');
  assert.equal(r.rateBp, 250);
});
