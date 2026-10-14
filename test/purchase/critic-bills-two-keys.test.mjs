/**
 * Critic probe (cl-bills): a draft save whose answer was lost, then Buchen.
 *
 * The Studio drawer on develop 8ddafb92 sent ONE key for "Als Entwurf speichern" and "Buchen"; a round of
 * the branch sent two (`draftKey`, `recordKey`), and a lost draft save followed by Buchen then left TWO
 * bills (critic H1). The fix restores the ONE capture key. FLIPPED to assert the fix: this drives the
 * engine with the payload shape the drawer now sends (one key for both verbs) and counts the bills, both
 * ways round. Synthetic by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVendorBill, recordExpense, postVendorBill } from '../../dist/core/purchase/index.js';
import { setup, addVendor, billInput, payablesBalance, billCounts } from './support.mjs';

function bills(t) {
  return t.store.db.prepare('SELECT id, status FROM vendor_bill WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId);
}

test('develop (one key): a lost draft save then Buchen is refused, so ONE bill exists', () => {
  const t = setup();
  const vendor = addVendor(t.ctx);
  const fields = billInput(t, vendor, { idempotencyKey: 'capture-K' });
  const draft = createVendorBill(t.ctx, fields); // landed, answer lost
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const buchen = recordExpense(t.ctx, fields);
  assert.equal(buchen.ok, false);
  assert.equal(buchen.error, 'idempotency_key_conflict');
  assert.equal(buchen.vendorBillId, draft.vendorBillId, 'the refusal names the draft');
  assert.equal(bills(t).length, 1);
});

test('the fix (one capture key): a lost draft save then Buchen leaves ONE bill, and 2000 is booked once when the draft is posted', () => {
  const t = setup();
  const vendor = addVendor(t.ctx);
  const fields = billInput(t, vendor, { idempotencyKey: 'capture-K' });
  const before = payablesBalance(t.store, t.workspaceId);
  const draft = createVendorBill(t.ctx, fields); // landed, answer lost
  assert.equal(draft.ok, true, JSON.stringify(draft));
  // Buchen under the SAME capture key, exactly as the drawer sends it.
  const buchen = recordExpense(t.ctx, fields);
  assert.equal(buchen.ok, false);
  assert.equal(buchen.error, 'idempotency_key_conflict');
  assert.equal(buchen.vendorBillId, draft.vendorBillId, 'the refusal names the draft the drawer opens');
  assert.deepEqual(bills(t).map((b) => b.status), ['draft']);
  // From the opened draft, Buchen posts THAT bill by id: the invoice is booked exactly once.
  const posted = postVendorBill(t.ctx, { vendorBillId: draft.vendorBillId, idempotencyKey: 'post-draft' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.deepEqual(bills(t).map((b) => b.status), ['posted']);
  assert.equal(payablesBalance(t.store, t.workspaceId) - before, 108100, 'one paper bill, booked once');
  assert.equal(billCounts(t.store, t.workspaceId).bills, 1);
});

test('the fix, mirrored: a lost Buchen then Entwurf under the one capture key leaves ONE bill', () => {
  const t = setup();
  const vendor = addVendor(t.ctx);
  const fields = billInput(t, vendor, { idempotencyKey: 'capture-M' });
  const buchen = recordExpense(t.ctx, fields); // landed, answer lost
  assert.equal(buchen.ok, true, JSON.stringify(buchen));
  const draft = createVendorBill(t.ctx, fields);
  assert.equal(draft.ok, false);
  assert.equal(draft.error, 'idempotency_key_conflict');
  assert.equal(draft.vendorBillId, buchen.vendorBillId, 'the refusal names the posted bill the drawer opens');
  assert.deepEqual(bills(t).map((b) => b.status), ['posted']);
  // And a retry of the same Buchen replays: still one bill.
  assert.equal(recordExpense(t.ctx, fields).vendorBillId, buchen.vendorBillId);
  assert.equal(billCounts(t.store, t.workspaceId).bills, 1);
});

test('round 2 L-b: one key per drawer, a lost draft save then an EDITED Buchen is refused naming the draft: ONE bill', () => {
  const t = setup();
  const vendor = addVendor(t.ctx);
  const draft = createVendorBill(t.ctx, billInput(t, vendor, { idempotencyKey: 'drawer-K' })); // landed, answer lost
  assert.equal(draft.ok, true, JSON.stringify(draft));
  // The person corrects the amount, then Buchen, under the drawer's one key.
  const edited = recordExpense(t.ctx, billInput(t, vendor, { idempotencyKey: 'drawer-K', amountMinor: 99000 }));
  assert.equal(edited.ok, false);
  assert.equal(edited.error, 'idempotency_key_conflict');
  assert.equal(edited.vendorBillId, draft.vendorBillId);
  assert.equal(bills(t).length, 1);
});

test('round 2 L-b: a DEFINITE refusal stores nothing, so the same drawer key serves the corrected retry', () => {
  const t = setup();
  const vendor = addVendor(t.ctx);
  const refused = recordExpense(t.ctx, billInput(t, vendor, { idempotencyKey: 'drawer-R', expenseAccountId: t.acc('2000') }));
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'needs_account');
  assert.equal(bills(t).length, 0);
  const corrected = recordExpense(t.ctx, billInput(t, vendor, { idempotencyKey: 'drawer-R' }));
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  assert.equal(bills(t).length, 1);
});
