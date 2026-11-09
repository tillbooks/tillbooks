// A05 resolveTax (P6), the R2 matrix: kind x method x timing. resolveTax is the SINGLE branch point
// for VAT method logic; this table pins the debit/credit effect, deductibility, saldo flag, and form
// line for every combination, so no later spec can silently re-derive it wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTax } from '../../dist/core/vat/index.js';
import { setup } from './support.mjs';

// Expected resolution per (kind -> code) under EFFEKTIV. Under SALDO the deltas are: deductible=false
// for every kind, and an output line reports on the Saldo Ziffer 323 (the first configured rate).
// Ziffern are the corrected 2024+ vintage (303/313/343/383), not the pre-2018 vintage (301/311/341/380).
const EFFEKTIV_EXPECTATIONS = [
  { code: 'UST81', kind: 'output', rateBp: 810, sign: 'credit', deductible: false, formLine: '303' },
  { code: 'UST26', kind: 'output', rateBp: 260, sign: 'credit', deductible: false, formLine: '313' },
  { code: 'UST38', kind: 'output', rateBp: 380, sign: 'credit', deductible: false, formLine: '343' },
  { code: 'VST-M', kind: 'input', rateBp: 0, sign: 'debit', deductible: true, formLine: '400' },
  { code: 'VST-I', kind: 'input', rateBp: 0, sign: 'debit', deductible: true, formLine: '405' },
  { code: 'EXPORT0', kind: 'zero', rateBp: 0, sign: 'none', deductible: false, formLine: '220' },
  { code: 'AUSGENOMMEN', kind: 'exempt', rateBp: 0, sign: 'none', deductible: false, formLine: '230' },
  { code: 'BEZUG', kind: 'reverse_charge', rateBp: 810, sign: 'both', deductible: true, formLine: '383' },
  { code: 'IMPORT', kind: 'import', rateBp: 0, sign: 'debit', deductible: true, formLine: '400' },
];

for (const timing of ['ist', 'soll']) {
  test(`resolveTax matrix: EFFEKTIV x ${timing}`, () => {
    const { ctx } = setup({ method: 'effektiv', timing });
    for (const e of EFFEKTIV_EXPECTATIONS) {
      const r = resolveTax(ctx, { taxCode: e.code });
      assert.equal(r.ok, true, `${e.code} resolves`);
      assert.equal(r.kind, e.kind, `${e.code} kind`);
      assert.equal(r.rateBp, e.rateBp, `${e.code} rate`);
      assert.equal(r.sign, e.sign, `${e.code} sign`);
      assert.equal(r.deductible, e.deductible, `${e.code} deductible under effektiv`);
      assert.equal(r.saldo, false, `${e.code} saldo flag`);
      assert.equal(r.formLine, e.formLine, `${e.code} form line`);
      assert.equal(r.timing, timing, `${e.code} carries the timing`);
      assert.equal(r.method, 'effektiv');
    }
  });

  test(`resolveTax matrix: SALDO x ${timing} (no input deduction, output on 323)`, () => {
    const { ctx } = setup({ method: 'saldo', timing });
    for (const e of EFFEKTIV_EXPECTATIONS) {
      const r = resolveTax(ctx, { taxCode: e.code });
      assert.equal(r.ok, true);
      assert.equal(r.kind, e.kind);
      assert.equal(r.saldo, true, `${e.code} saldo flag`);
      // Art. 37: under Saldo NOTHING is separately deductible, regardless of kind.
      assert.equal(r.deductible, false, `${e.code} is never separately deductible under saldo`);
      // An output line reports on the Saldo Ziffer of the first configured rate; others keep their line.
      const expectedFormLine = e.kind === 'output' ? '323' : e.formLine;
      assert.equal(r.formLine, expectedFormLine, `${e.code} form line under saldo`);
      assert.equal(r.timing, timing);
    }
  });
}

test('resolveTax: a null / none / absent code resolves to no VAT without a lookup', () => {
  const { ctx } = setup({ method: 'effektiv' });
  for (const taxCode of [null, undefined, 'none']) {
    const r = resolveTax(ctx, { taxCode });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'none');
    assert.equal(r.rateBp, 0);
    assert.equal(r.sign, 'none');
    assert.equal(r.deductible, false);
    assert.equal(r.formLine, null);
  }
});

test('resolveTax: an unknown code is a structured error, not a crash', () => {
  const { ctx } = setup({ method: 'effektiv' });
  const r = resolveTax(ctx, { taxCode: 'DOES_NOT_EXIST' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown_tax_code');
});

test('resolveTax: an ARCHIVED code still resolves (historical reads, H-VAT-TRACE)', () => {
  const { ctx, store, workspaceId } = setup({ method: 'effektiv' });
  store.db.prepare('UPDATE tax_code SET active = 0 WHERE workspace_id = ? AND code = ?').run(workspaceId, 'UST81');
  const r = resolveTax(ctx, { taxCode: 'UST81' });
  assert.equal(r.ok, true, 'an archived code still resolves for a historical return');
  assert.equal(r.rateBp, 810);
});
