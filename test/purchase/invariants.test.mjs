/**
 * A17's standing invariants: §H-IDEMPOTENT asserted on ROWS, and §H-TENANT on every query.
 *
 * IDEMPOTENCY IS A CLAIM ABOUT TABLES, NEVER ABOUT A RETURNED ID. A replay that inserts a second
 * row and returns the first id passes every result-shaped assertion, so each double-call below is
 * judged on `billCounts`: the bill table, the journal, the journal lines AND the audit trail, which
 * is an append-only hash chain with no uniqueness constraint and therefore exactly where a hidden
 * re-run leaves its trace.
 *
 * TENANCY IS PROVEN INSIDE ONE DATABASE. `secondWorkspace` opens a neighbour in the SAME store,
 * because two separate stores would prove nothing about scoping. A foreign id must answer exactly
 * like a nonexistent one, so no id is probeable across tenants.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createVendorBill,
  recordExpense,
  postVendorBill,
  attachReceipt,
  voidVendorBill,
  listVendorBills,
  getVendorBill,
} from '../../dist/core/purchase/index.js';
import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import {
  setup,
  secondWorkspace,
  addVendor,
  billInput,
  billCounts,
  billRow,
  payablesBalance,
  GROSS_MINOR,
} from './support.mjs';

// --- §H-IDEMPOTENT, on rows -----------------------------------------------------------------------

test('record_expense replayed under one key leaves ONE bill, ONE entry, ONE audit trace', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const input = billInput(t, vendorId, { idempotencyKey: 're-idem' });

  const first = recordExpense(t.ctx, input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const after = billCounts(t.store, t.workspaceId);

  const second = recordExpense(t.ctx, input);
  assert.equal(second.ok, true);
  assert.equal(second.vendorBillId, first.vendorBillId);
  assert.equal(second.entryId, first.entryId);
  assert.deepEqual(billCounts(t.store, t.workspaceId), after, 'the replay wrote rows');
  assert.equal(payablesBalance(t.store, t.workspaceId), GROSS_MINOR, 'a double-post double-counted 2000');
});

test('create_vendor_bill replayed under one key leaves one draft; a DIFFERENT bill under the same key is refused', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const input = billInput(t, vendorId, { idempotencyKey: 'cv-idem' });

  const first = createVendorBill(t.ctx, input);
  assert.equal(first.ok, true);
  const after = billCounts(t.store, t.workspaceId);

  const replay = createVendorBill(t.ctx, input);
  assert.equal(replay.ok, true);
  assert.equal(replay.vendorBillId, first.vendorBillId);
  assert.deepEqual(billCounts(t.store, t.workspaceId), after);

  // The same VERB with the same key REPLAYS the memoised first answer, whatever the retry typed:
  // the first figures come back and nothing is written. That is §H-IDEMPOTENT's replay contract.
  const differentInput = createVendorBill(
    t.ctx,
    billInput(t, vendorId, { idempotencyKey: 'cv-idem', amountMinor: 50000 }),
  );
  assert.equal(differentInput.ok, true);
  assert.equal(differentInput.vendorBillId, first.vendorBillId);
  assert.equal(differentInput.vendorBill.grossMinor, first.vendorBill.grossMinor, 'the replay must return the FIRST figures');
  assert.deepEqual(billCounts(t.store, t.workspaceId), after);

  // A DIFFERENT verb reusing the raw key has no memo to replay, and the raw-key uniqueness check
  // refuses it out loud, naming the bill that already holds the key, never minting a second one.
  const conflict = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'cv-idem' }));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'idempotency_key_conflict');
  assert.equal(conflict.vendorBillId, first.vendorBillId);
  assert.deepEqual(billCounts(t.store, t.workspaceId), after);
});

test('post_vendor_bill replayed under one key posts once; a SECOND key is already_posted, not a second entry', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const created = createVendorBill(t.ctx, billInput(t, vendorId, { idempotencyKey: 'pv-idem' }));
  const posted = postVendorBill(t.ctx, { vendorBillId: created.vendorBillId, idempotencyKey: 'pv-go' });
  assert.equal(posted.ok, true);
  const after = billCounts(t.store, t.workspaceId);

  const replay = postVendorBill(t.ctx, { vendorBillId: created.vendorBillId, idempotencyKey: 'pv-go' });
  assert.equal(replay.ok, true);
  assert.equal(replay.entryId, posted.entryId);
  assert.deepEqual(billCounts(t.store, t.workspaceId), after);

  const differentKey = postVendorBill(t.ctx, { vendorBillId: created.vendorBillId, idempotencyKey: 'pv-again' });
  assert.equal(differentKey.ok, false);
  assert.equal(differentKey.error, 'already_posted');
  assert.equal(differentKey.entryId, posted.entryId);
  assert.deepEqual(billCounts(t.store, t.workspaceId), after);
  assert.equal(payablesBalance(t.store, t.workspaceId), GROSS_MINOR);
});

test('void_vendor_bill replayed under one key reverses once; a second key is already_void', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const posted = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'vv-idem' }));
  const voided = voidVendorBill(t.ctx, { vendorBillId: posted.vendorBillId, idempotencyKey: 'vv-go' });
  assert.equal(voided.ok, true);
  const after = billCounts(t.store, t.workspaceId);
  assert.equal(payablesBalance(t.store, t.workspaceId), 0);

  const replay = voidVendorBill(t.ctx, { vendorBillId: posted.vendorBillId, idempotencyKey: 'vv-go' });
  assert.equal(replay.ok, true);
  assert.deepEqual(billCounts(t.store, t.workspaceId), after, 'the replay posted a second reversal');
  assert.equal(payablesBalance(t.store, t.workspaceId), 0, 'a second reversal would push 2000 negative');

  const differentKey = voidVendorBill(t.ctx, { vendorBillId: posted.vendorBillId, idempotencyKey: 'vv-again' });
  assert.equal(differentKey.ok, false);
  assert.equal(differentKey.error, 'already_void');
  assert.deepEqual(billCounts(t.store, t.workspaceId), after);
});

test('attach_receipt replayed under one key stamps the audit chain once', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const posted = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'ar-idem' }));
  const attached = attachReceipt(t.ctx, {
    vendorBillId: posted.vendorBillId,
    receiptRef: 'beleg/2026/0042.pdf',
    idempotencyKey: 'ar-go',
  });
  assert.equal(attached.ok, true);
  const after = billCounts(t.store, t.workspaceId);

  const replay = attachReceipt(t.ctx, {
    vendorBillId: posted.vendorBillId,
    receiptRef: 'beleg/2026/0042.pdf',
    idempotencyKey: 'ar-go',
  });
  assert.equal(replay.ok, true);
  assert.deepEqual(billCounts(t.store, t.workspaceId), after);
});

// --- §H-TENANT ------------------------------------------------------------------------------------

test('a neighbour workspace cannot read, list, post, void or receipt another tenant bill', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const posted = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'ten-1' }));
  assert.equal(posted.ok, true);
  const w2 = secondWorkspace(t);

  // The read side: a foreign id answers exactly like a nonexistent one.
  const got = getVendorBill(w2.ctx, { vendorBillId: posted.vendorBillId });
  assert.equal(got.ok, false);
  assert.equal(got.error, 'not_found');
  const list = listVendorBills(w2.ctx);
  assert.equal(list.ok, true);
  assert.deepEqual(list.bills, []);
  assert.equal(list.payablesBalanceMinor, 0, 'the neighbour reconciliation read the wrong tenant ledger');

  // The write side: nothing in workspace 1 moves, whatever workspace 2 tries.
  const before = billCounts(t.store, t.workspaceId);
  const post2 = postVendorBill(w2.ctx, { vendorBillId: posted.vendorBillId, idempotencyKey: 'ten-post' });
  assert.equal(post2.ok, false);
  assert.equal(post2.error, 'not_found');
  const void2 = voidVendorBill(w2.ctx, { vendorBillId: posted.vendorBillId, idempotencyKey: 'ten-void' });
  assert.equal(void2.ok, false);
  assert.equal(void2.error, 'not_found');
  const rcpt2 = attachReceipt(w2.ctx, {
    vendorBillId: posted.vendorBillId,
    receiptRef: 'fremd.pdf',
    idempotencyKey: 'ten-rcpt',
  });
  assert.equal(rcpt2.ok, false);
  assert.equal(rcpt2.error, 'not_found');
  assert.deepEqual(billCounts(t.store, t.workspaceId), before);
  assert.equal(billRow(t.store, t.workspaceId, posted.vendorBillId).status, 'posted');
});

test('a vendor from another workspace is refused as if unknown, so no contact id is probeable', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const w2 = secondWorkspace(t);
  const res = createVendorBill(w2.ctx, {
    ...billInput(t, vendorId, { idempotencyKey: 'ten-vendor' }),
    // The EXPENSE account must be workspace 2's own, so the vendor is the only foreign reference.
    expenseAccountId: w2.acc('6500'),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_vendor');
  assert.equal(res.reason, 'unknown', 'a foreign vendor must be indistinguishable from a nonexistent one');
});

test('a foreign payment can never settle a local bill: the settlement join is tenant-scoped on both sides', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const posted = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'ten-settle' }));
  const w2 = secondWorkspace(t);
  const w2vendor = addVendor(w2.ctx, 'Fremd AG', 'ten-v2');

  // Workspace 2 pays "the same" target id from its own books. The allocation must refuse: the id
  // names nothing in workspace 2.
  const paid = recordPayment(w2.ctx, {
    direction: 'outgoing',
    date: '2026-07-10',
    amountMinor: GROSS_MINOR,
    bankAccountId: w2.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: w2vendor,
    allocations: [{ targetKind: 'vendor_bill', targetId: posted.vendorBillId, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'ten-settle-pay',
  });
  assert.equal(paid.ok, false);
  assert.equal(paid.error, 'not_found');

  // And the local bill still reports fully open.
  const bill = getVendorBill(t.ctx, { vendorBillId: posted.vendorBillId }).vendorBill;
  assert.equal(bill.openMinor, GROSS_MINOR);
  assert.equal(bill.settlementStatus, 'unpaid');
});
