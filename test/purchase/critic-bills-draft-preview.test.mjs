/**
 * Critic probe (cl-bills): the read-only DRAFT drawer claims to show "what Buchen will post".
 *
 * The drawer asked `vat_preview` with `supplyDate: billDate`, while `post_vendor_bill` prices the stored
 * row at `supply_date ?? bill_date`, so a draft created through the MCP verb with its own Leistungsdatum
 * across a rate change showed one split and booked another (critic M1). FLIPPED to assert the fix: the
 * drawer now asks at `bill.supplyDate ?? billDate` (BillEditor.tsx loadPreview), and that question's
 * answer is exactly what Buchen books. Synthetic by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { computeLineTax } from '../../dist/core/vat/index.js';
import { setup, addVendor, billInput, billRow } from './support.mjs';

test('a draft whose supplyDate predates the 2024 rate change: the drawer split IS what Buchen posts', () => {
  const t = setup();
  const vendor = addVendor(t.ctx);
  const draft = createVendorBill(t.ctx, billInput(t, vendor, {
    billDate: '2024-01-10',
    dueDate: '2024-02-09',
    supplyDate: '2023-12-15',
    idempotencyKey: 'agent-draft',
  }));
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const stored = billRow(t.store, t.workspaceId, draft.vendorBillId);
  // Exactly the question the read-only drawer now asks for this draft: its stored supply date.
  const shown = computeLineTax(t.ctx, {
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    supplyDate: stored.supply_date ?? stored.bill_date,
  });
  assert.equal(shown.ok, true, JSON.stringify(shown));
  // The question the drawer USED to ask (the bill date) prices at the new rate: a different figure.
  const old = computeLineTax(t.ctx, { amountMinor: 108100, amountIsGross: true, taxCode: 'VST-M', supplyDate: '2024-01-10' });
  assert.notEqual(old.taxMinor, shown.taxMinor, 'the case really crosses a rate change');
  const posted = postVendorBill(t.ctx, { vendorBillId: draft.vendorBillId, idempotencyKey: 'p' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const row = billRow(t.store, t.workspaceId, draft.vendorBillId);
  assert.equal(shown.taxMinor, row.tax_amount_minor, 'the drawer showed the MWST Buchen booked');
  assert.equal(shown.netMinor, row.net_minor);
  assert.equal(shown.grossMinor, row.gross_minor);
});
