// Regression tests for the A05 defects found by the independent Fable 5 review. Each pins one fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { upsertTaxCode, configureVat, resolveTax } from '../../dist/core/vat/index.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { setup } from './support.mjs';

// H1: a code referenced by a posted line has its resolution frozen; only its label may change.
test('H1: upsertTaxCode refuses to change kind/rate/formLine of a code a posted line references', () => {
  const { ctx, store, workspaceId } = setup({ method: 'effektiv' });
  // Post a line that references UST81 so the code is now historically load-bearing.
  const acc = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  const posted = postEntry(ctx, {
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'p1',
    // A B2-reconciled booking: the tagged revenue line's 81 land on 2200 (the post-boundary gate
    // rejects a tagged entry whose VAT-account movements do not match the canonical tax).
    lines: [
      { account: acc('1020'), debit: 1081 },
      { account: acc('3200'), credit: 1000, taxCode: 'UST81', taxBase: 1000, taxAmount: 81 },
      { account: acc('2200'), credit: 81 },
    ],
  });
  assert.equal(posted.ok, true);

  // Changing the rate/kind is refused (a rate change is a new code + archive-the-old, US-A05.4).
  const changed = upsertTaxCode(ctx, { code: 'UST81', kind: 'input', rateBp: 770, formLine: '302', idempotencyKey: 'u1' });
  assert.equal(changed.ok, false);
  assert.equal(changed.error, 'referenced_code_immutable');

  // The historical resolution is intact.
  const r = resolveTax(ctx, { taxCode: 'UST81' });
  assert.equal(r.kind, 'output');
  assert.equal(r.rateBp, 810);
  assert.equal(r.sign, 'credit');

  // Editing only the label is still allowed (formLine 303 is UST81's seeded ESTV Ziffer, unchanged here).
  const relabel = upsertTaxCode(ctx, { code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Neu benannt', idempotencyKey: 'u2' });
  assert.equal(relabel.ok, true);
});

// H2: the Saldo output Ziffer comes from the workspace's first configured rate. Whether two rates are
// ambiguous is a question about the SUPPLY DAY's form, not about the rate count (A07 §3.1a).
test('H2: saldo output form line follows the first configured rate, and ambiguity is regime-scoped', () => {
  const oneRate = setup({ method: 'saldo', saldoRates: [{ rateBp: 680 }] });
  assert.equal(resolveTax(oneRate.ctx, { taxCode: 'UST81' }).formLine, '323', 'a single configured rate reports on 323');

  const twoRates = setup({ method: 'saldo', saldoRates: [{ rateBp: 620 }, { rateBp: 680 }] });
  // From 01.01.2025 the 2. Satz row does not exist, so both rates report on 323 and there is no
  // ambiguity to report. Before it, the Ziffer varied by Tätigkeit and the tax code cannot pick one.
  assert.equal(
    resolveTax(twoRates.ctx, { taxCode: 'UST81', supplyDate: '2026-05-15' }).formLine,
    '323',
    'Beiblatt regime: every approved rate declares on 323',
  );
  assert.equal(
    resolveTax(twoRates.ctx, { taxCode: 'UST81', supplyDate: '2024-05-15' }).formLine,
    null,
    'pre-2025: the split is by activity, resolveTax cannot pick from the code alone',
  );
  assert.equal(resolveTax(twoRates.ctx, { taxCode: 'UST81' }).saldo, true);
});

// M1: reverse_charge is owed-but-not-deductible under saldo (sign must not promise a reclaimable leg).
test('M1: reverse_charge sign is credit (owed only) under saldo, both under effektiv', () => {
  const eff = setup({ method: 'effektiv' });
  const rEff = resolveTax(eff.ctx, { taxCode: 'BEZUG' });
  assert.equal(rEff.sign, 'both');
  assert.equal(rEff.deductible, true);

  const sal = setup({ method: 'saldo', saldoRates: [{ rateBp: 620 }] });
  const rSal = resolveTax(sal.ctx, { taxCode: 'BEZUG' });
  assert.equal(rSal.sign, 'credit', 'no reclaimable leg under saldo, so sign must not be "both"');
  assert.equal(rSal.deductible, false);
});

// M2: saldo rates cannot be persisted under a non-saldo method.
test('M2: configureVat rejects saldo rates under method effektiv or none', () => {
  const { ctx } = setup({ registered: false });
  const eff = configureVat(ctx, { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'c1', saldoRates: [{ rateBp: 620 }] });
  assert.equal(eff.error, 'invalid_saldo_rate');
  const none = configureVat(ctx, { method: 'none', timing: 'soll', registered: true, idempotencyKey: 'c2', saldoRates: [{ rateBp: 620 }] });
  assert.equal(none.error, 'invalid_saldo_rate');
});

// L1 / L2: a fat-finger rate is bounded, and the reserved 'none' code name is refused.
test('L1/L2: upsertTaxCode bounds the rate and reserves the "none" code name', () => {
  const { ctx } = setup({ method: 'effektiv' });
  assert.equal(upsertTaxCode(ctx, { code: 'X', kind: 'output', rateBp: 99999, formLine: '301', idempotencyKey: 'u1' }).error, 'invalid_rate');
  assert.equal(upsertTaxCode(ctx, { code: 'none', kind: 'none', rateBp: 0, formLine: '000', idempotencyKey: 'u2' }).error, 'reserved_code');
});
