// A18 F4: discard_payment_batch, the recovery path that abandons a batch that must not be paid.
// These pin the guardrails the critic's F4 asked for: a draft discards freely, a generated batch
// demands confirmation, a paid batch cannot be discarded, discarding is idempotent on ROWS, and a
// discarded batch releases its bills back to payable without deleting any row (append-only).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup, PLAIN_IBAN, snapshot } from './support.mjs';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import {
  createBankAccount,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  getPaymentBatch,
  listPayableOpenItems,
  markBatchPaid,
  discardPaymentBatch,
} from '../../dist/core/banking/index.js';

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

let seq = 0;
function world(ctxSetup, seed) {
  const { ctx, acc } = ctxSetup;
  const bankAccountId = must(
    createBankAccount(ctx, { name: 'Kontokorrent', iban: PLAIN_IBAN, ledgerAccountId: acc('1020'), idempotencyKey: `bank-${seed}-${seq++}` }),
    'create_bank_account',
  ).bankAccountId;
  const vendor = must(createContact(ctx, { partyRole: 'vendor', name: `Lieferant ${seed}`, idempotencyKey: `v-${seed}-${seq++}` }), 'create_contact').contact.id;
  const bill = must(createVendorBill(ctx, { vendorId: vendor, billDate: '2026-03-01', amountMinor: 100000, expenseAccountId: acc('6500'), idempotencyKey: `bill-${seed}` }), 'create_vendor_bill').vendorBillId;
  must(postVendorBill(ctx, { vendorBillId: bill, idempotencyKey: `post-${seed}` }), 'post_vendor_bill');
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: `cbp-${seed}` }), 'set_creditor_bank_profile');
  const batch = must(createPaymentBatch(ctx, { bankAccountId, itemIds: [bill], executionDate: '2026-03-20', idempotencyKey: `batch-${seed}` }), 'create_payment_batch');
  return { ctx, bankAccountId, vendor, bill, batchId: batch.batchId };
}

test('A18 discard: a DRAFT batch discards with no confirmation and releases its bill', () => {
  const { ctx, bill, batchId } = world(setup(), 'd-draft');
  const res = must(discardPaymentBatch(ctx, { batchId, idempotencyKey: 'disc-1' }), 'discard');
  assert.equal(res.batch.status, 'discarded');
  const row = must(listPayableOpenItems(ctx, {}), 'list_payable').items.find((i) => i.billId === bill);
  assert.equal(row.alreadyBatchedInto, null, 'a discarded batch no longer holds its bill');
});

test('A18 discard: a GENERATED batch refuses to discard without confirmation, accepts it with', () => {
  const { ctx, batchId } = world(setup(), 'd-gen');
  must(generatePain001(ctx, { batchId, idempotencyKey: 'gen-1' }), 'generate');

  const refused = discardPaymentBatch(ctx, { batchId, idempotencyKey: 'disc-nogo' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'confirmation_required');

  const done = must(discardPaymentBatch(ctx, { batchId, confirmation: true, idempotencyKey: 'disc-go' }), 'discard confirmed');
  assert.equal(done.batch.status, 'discarded');
});

test('A18 discard: a PAID batch cannot be discarded (the money has moved)', () => {
  const { ctx, batchId } = world(setup(), 'd-paid');
  must(generatePain001(ctx, { batchId, idempotencyKey: 'gen-2' }), 'generate');
  must(markBatchPaid(ctx, { batchId, confirmation: true, valueDate: '2026-03-21', idempotencyKey: 'mbp-2' }), 'mark_batch_paid');

  const res = discardPaymentBatch(ctx, { batchId, confirmation: true, idempotencyKey: 'disc-paid' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'already_paid');
});

test('A18 discard: discarding is idempotent on ROWS, and re-discard under a NEW key is refused', () => {
  const s = setup();
  const { ctx, batchId } = world(s, 'd-idem');
  must(discardPaymentBatch(ctx, { batchId, idempotencyKey: 'disc-k' }), 'first discard');

  const before = snapshot(s.store);
  const replay = must(discardPaymentBatch(ctx, { batchId, idempotencyKey: 'disc-k' }), 'replay same key');
  assert.equal(replay.batch.status, 'discarded');
  assert.equal(snapshot(s.store), before, 'replaying the idempotency key must touch nothing');

  const again = discardPaymentBatch(ctx, { batchId, idempotencyKey: 'disc-k2' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_discarded');
});

test('A18 discard: is tenant-scoped, a cross-tenant batchId is not_found', () => {
  const clock = fixedClock('2026-07-19T00:00:00.000Z');
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const wsA = createWorkspace({ store, clock, ids }, { name: 'A GmbH' }).workspaceId;
  const wsB = createWorkspace({ store, clock, ids }, { name: 'B GmbH' }).workspaceId;
  const ctxA = makeContext(store, { workspaceId: wsA, actor: 'user_1', clock, ids });
  const ctxB = makeContext(store, { workspaceId: wsB, actor: 'user_1', clock, ids });
  const accFor = (ws) => (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, n).id;

  const { batchId } = world({ ctx: ctxA, acc: accFor(wsA) }, 'd-tenant');
  const res = discardPaymentBatch(ctxB, { batchId, idempotencyKey: 'disc-x' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
  // And the batch is untouched in its own tenant.
  assert.equal(must(getPaymentBatch(ctxA, { batchId }), 'get in A').batch.status, 'draft');
});
