// A05 statutory corrections (docs/planning/statutory-verification.md, owner decisions 2026-07-16).
// Pins the ESTV Ziffer corrections, the corrected Saldosteuersatz ladder, and the two-slot -> N-rate
// Saldo model redesign (1.1.2025 law) against the official ESTV forms 0550/0553 + SR 641.202.62.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TAX_CODES,
  ESTV_SALDO_RATES_BP,
  configureVat,
  getVatConfig,
  resolveTax,
} from '../../dist/core/vat/index.js';
import { setup } from './support.mjs';

// --- Correction 1: ESTV Ziffern (the 2024+ rate era, trailing digit 3) ------------------------
test('DEFAULT_TAX_CODES carry the corrected 2024+ ESTV Ziffern (303/313/343/383), not the pre-2018 vintage', () => {
  const byCode = Object.fromEntries(DEFAULT_TAX_CODES.map((c) => [c.code, c.formLine]));
  assert.equal(byCode.UST81, '303', 'Normalsatz 8.1% output is 303 (was 301)');
  assert.equal(byCode.UST26, '313', 'Reduzierter Satz 2.6% output is 313 (was 311)');
  assert.equal(byCode.UST38, '343', 'Beherbergung 3.8% output is 343 (was 341)');
  assert.equal(byCode.BEZUG, '383', 'Bezugsteuer 8.1% is 383 (was 380)');
  // Period-stable lines are unchanged.
  assert.equal(byCode['VST-M'], '400', 'Vorsteuer Material/DL stays 400');
  assert.equal(byCode['VST-I'], '405', 'Vorsteuer Inv./uebr. BA stays 405');
  assert.equal(byCode.EXPORT0, '220', 'Export befreit stays 220');
  assert.equal(byCode.AUSGENOMMEN, '230', 'Ausgenommen stays 230');
});

// --- Correction 2: the Saldosteuersatz rate ladder (from 2024, SR 641.202.62) ------------------
test('ESTV_SALDO_RATES_BP is the corrected 2024 ladder {10,60,130,210,300,370,450,530,620,680}', () => {
  assert.deepEqual(
    [...ESTV_SALDO_RATES_BP].sort((a, b) => a - b),
    [10, 60, 130, 210, 300, 370, 450, 530, 620, 680],
  );
  // The stale hybrid values are gone.
  for (const stale of [350, 430, 510, 590, 650]) {
    assert.ok(!ESTV_SALDO_RATES_BP.has(stale), `stale rate ${stale} bp removed from the ladder`);
  }
});

// --- Correction 3: N-rate Saldo model (1.1.2025 law) ------------------------------------------
test('configureVat accepts ONE saldo rate and assigns it ESTV Ziffer 323', () => {
  const { ctx } = setup({ registered: false });
  const res = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'one',
    saldoRates: [{ rateBp: 620 }],
  });
  assert.equal(res.ok, true);
  const rates = getVatConfig(ctx).config.saldoRates;
  assert.equal(rates.length, 1);
  assert.deepEqual(rates[0], { position: 1, rateBp: 620, formLine: '323' });
});

test('configureVat accepts TWO saldo rates and assigns 323 / 333 in order', () => {
  const { ctx } = setup({ registered: false });
  const res = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'two',
    saldoRates: [{ rateBp: 620 }, { rateBp: 680 }],
  });
  assert.equal(res.ok, true);
  const rates = getVatConfig(ctx).config.saldoRates;
  assert.equal(rates.length, 2);
  assert.deepEqual(rates[0], { position: 1, rateBp: 620, formLine: '323' });
  assert.deepEqual(rates[1], { position: 2, rateBp: 680, formLine: '333' });
});

test('configureVat accepts THREE+ saldo rates; the 3rd stores with a null formLine (ESTV surfacing undefined)', () => {
  const { ctx } = setup({ registered: false });
  const res = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'three',
    saldoRates: [{ rateBp: 620 }, { rateBp: 680 }, { rateBp: 300 }],
  });
  assert.equal(res.ok, true, 'the old "at most two" cap is gone (1.1.2025 law)');
  const rates = getVatConfig(ctx).config.saldoRates;
  assert.equal(rates.length, 3);
  assert.deepEqual(rates[0], { position: 1, rateBp: 620, formLine: '323' });
  assert.deepEqual(rates[1], { position: 2, rateBp: 680, formLine: '333' });
  assert.deepEqual(rates[2], { position: 3, rateBp: 300, formLine: null },
    'a 3rd rate is stored, but its ESTV Ziffer is undefined so formLine is null (owner follow-up)');
});

test('configureVat rejects a saldo rate that is not on the ESTV ladder', () => {
  const { ctx } = setup({ registered: false });
  // 650 bp was on the STALE ladder, not the corrected one.
  const res = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'off',
    saldoRates: [{ rateBp: 650 }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_saldo_rate');
});

test('configureVat rejects duplicate saldo rates', () => {
  const { ctx } = setup({ registered: false });
  const res = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'dup',
    saldoRates: [{ rateBp: 620 }, { rateBp: 620 }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_saldo_rate');
});

test('configureVat is idempotent on its key with N saldo rates', () => {
  const { ctx } = setup({ registered: false });
  const a = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'idem',
    saldoRates: [{ rateBp: 620 }, { rateBp: 680 }],
  });
  const b = configureVat(ctx, {
    method: 'saldo', timing: 'soll', registered: true, idempotencyKey: 'idem',
    saldoRates: [{ rateBp: 620 }, { rateBp: 680 }],
  });
  assert.deepEqual(a.config, b.config);
});

test('resolveTax under saldo: the Ziffer follows the SUPPLY DAY regime, not the rate count', () => {
  const one = setup({ method: 'saldo', saldoRates: [{ rateBp: 620 }] });
  assert.equal(resolveTax(one.ctx, { taxCode: 'UST81' }).formLine, '323',
    'a single configured saldo rate reports output on 323');

  // TWO RATES ON A SUPPLY DAY FROM 01.01.2025. The Ziffer stopped depending on the rate when the
  // Beiblatt replaced the 2. Satz row (A07 §3.1a), so there is nothing ambiguous left to refuse: both
  // rates declare on 323 and the split the preview genuinely cannot decide is the RATE, not the box.
  const two = setup({ method: 'saldo', saldoRates: [{ rateBp: 620 }, { rateBp: 680 }] });
  const beiblatt = resolveTax(two.ctx, { taxCode: 'UST81', supplyDate: '2026-05-15' });
  assert.equal(beiblatt.formLine, '323', 'under the Beiblatt regime every approved rate shares Ziffer 323');
  assert.equal(beiblatt.saldo, true);

  // A PRE-2025 SUPPLY DAY still cannot be answered from the tax code alone, because there the Ziffer
  // really did vary by Tätigkeit (323 for the 1. Satz, 333 for the 2.) and the code carries no
  // activity. A07 assigns it at filing from the Ertragskonto.
  const legacy = resolveTax(two.ctx, { taxCode: 'UST81', supplyDate: '2024-05-15' });
  assert.equal(legacy.formLine, null, 'pre-2025 the split is by Tätigkeit and resolveTax cannot pick it');
  assert.equal(legacy.saldo, true);
});
