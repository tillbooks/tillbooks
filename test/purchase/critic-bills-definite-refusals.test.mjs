/**
 * Critic probe (cl-bills round 3): the drawer's DEFINITE_REFUSALS list says a refusal stored nothing, so the
 * per-drawer capture key is reused for the corrected retry. For every listed code that record_expense and
 * create_vendor_bill can actually return, this proves: no bill row, no memo, and the SAME key then captures
 * the corrected bill exactly once (never a replay of a stale answer). Synthetic by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVendorBill, recordExpense } from '../../dist/core/purchase/index.js';
import { softCloseMonth } from '../../dist/core/ledger/index.js';
import { setup, addVendor, billInput } from './support.mjs';

const memo = (t, key) =>
  t.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency WHERE workspace_id = ? AND key LIKE ?').get(t.workspaceId, `%${key}%`).n;
const bills = (t) => t.store.db.prepare('SELECT COUNT(*) AS n FROM vendor_bill WHERE workspace_id = ?').get(t.workspaceId).n;

const CASES = [
  ['needs_account', (t, v) => ({ expenseAccountId: t.acc('3200') })],
  ['needs_input_tax_code', () => ({ taxCode: 'UST81' })],
  ['invalid_input', () => ({ amountMinor: 0 })],
  ['invalid_reference', () => ({ costCenterId: 'cc_nope' })],
  ['needs_vendor', () => ({ vendorId: 'ct_nope' })],
  ['needs_fx_rate', () => ({ currency: 'EUR' })],
];

for (const verb of [recordExpense, createVendorBill]) {
  for (const [code, bad] of CASES) {
    // A DRAFT needs no rate (it books nothing), so needs_fx_rate is a record_expense refusal only.
    if (verb === createVendorBill && code === 'needs_fx_rate') continue;
    test(`${verb.name}: ${code} stores nothing, and the same key captures the corrected bill once`, () => {
      const t = setup();
      const vendor = addVendor(t.ctx);
      const key = `drawer-${verb.name}-${code}`;
      const refused = verb(t.ctx, billInput(t, vendor, { idempotencyKey: key, ...bad(t, vendor) }));
      assert.equal(refused.ok, false, JSON.stringify(refused));
      if (refused.error !== code && !(code === 'needs_input_tax_code' && refused.error === 'unknown_tax_code')) {
        assert.fail(`expected ${code}, got ${JSON.stringify(refused)}`);
      }
      assert.equal(bills(t), 0);
      assert.equal(memo(t, key), 0);
      const corrected = verb(t.ctx, billInput(t, vendor, { idempotencyKey: key }));
      assert.equal(corrected.ok, true, JSON.stringify(corrected));
      assert.equal(bills(t), 1);
    });
  }
}

test('recordExpense: period_locked is refused AFTER the draft insert, rolled back with the memo, and the key is free', () => {
  const t = setup({ realPeriods: true });
  const vendor = addVendor(t.ctx);
  assert.equal(softCloseMonth(t.ctx, { period: '2026-07', idempotencyKey: 'close-07' }).ok, true);
  const refused = recordExpense(t.ctx, billInput(t, vendor, { idempotencyKey: 'drawer-lock' }));
  assert.equal(refused.error, 'period_locked', JSON.stringify(refused));
  assert.equal(bills(t), 0);
  assert.equal(memo(t, 'drawer-lock'), 0);
  const corrected = recordExpense(t.ctx, billInput(t, vendor, { idempotencyKey: 'drawer-lock', billDate: '2026-08-03', dueDate: '2026-09-02' }));
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  assert.equal(bills(t), 1);
});
