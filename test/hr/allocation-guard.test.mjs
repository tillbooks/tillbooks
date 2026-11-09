// E02 x A16, D95 critic-FAIL regression: an employee-payable reimbursement parked on 2260 must NOT
// be allocatable against a 2000 vendor bill or a 1100 customer document.
//
// THE DEFECT (found by the non-author money-path critic). `reimburseClaim` records an outgoing
// supplier payment for the full amount with NO allocations, so its whole amount is an allocatable
// on-account parked credit, and `requireEmployeeContact` forces the employee onto a vendor/both
// contact. Before D95 an allocatable parked credit ALWAYS sat on a control account (2000 or 1100),
// so `entrySettlementSide` never returned null for one, and `allocatePayment`'s wrong-side guard
// `if (entrySide !== null && entrySide !== requiredSide)` was sound. D95 parks the credit on 2260,
// for which `entrySettlementSide` returns null, so the guard was SKIPPED and the 2260 credit could
// mark a 2000 bill settled in the sub-ledger while GL 2000 stayed fully open: the sub-ledger and the
// control account diverge. The fix refuses allocation when the entry settled no control account.
//
// This test BITES: on the pre-fix engine the vendor-bill allocation returns ok:true and the bill
// reports partly settled while 2000 is unchanged; on the fixed engine it is refused and both stay
// consistent.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createContact } from '../../dist/core/sales/index.js';
import { approveClaim, reimburseClaim } from '../../dist/core/hr/index.js';
import { allocatePayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { recordExpense, getVendorBill } from '../../dist/core/purchase/index.js';
import { setup, addEmployee, submittedClaim, accountBalance, vendorApBalance } from './support.mjs';
import { billInput } from '../purchase/support.mjs';
import { issueInvoice } from '../payments/support.mjs';

/** An approved+reimbursed claim; returns the reimburse payment id (parked on 2260) and the contact. */
function reimbursedClaim(t) {
  // A `both` contact so the SAME counterparty can carry a vendor bill AND a customer invoice.
  const contactId = createContact(t.ctx, { partyRole: 'both', name: 'Alex Muster', idempotencyKey: 'emp-c' }).contact.id;
  const { employeeId } = addEmployee(t.ctx, { contactId }, 'emp');
  const { claimId } = submittedClaim(t.ctx, employeeId, {}, 'clm'); // submitted by 'claimant', so t.ctx (user_1) may approve
  assert.equal(approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: 'ap' }).ok, true);
  const reimb = reimburseClaim(t.ctx, { claimId, bankAccountId: t.bankId, confirm: true, idempotencyKey: 'rb' });
  assert.equal(reimb.ok, true, JSON.stringify(reimb));
  assert.ok(reimb.paymentId, 'the reimburse recorded a payment');
  // The reimbursement cleared 2260 to zero and never touched 2000.
  assert.equal(vendorApBalance(t.store, t.workspaceId), 0, '2000 Kreditoren untouched by the reimbursement');
  return { paymentId: reimb.paymentId, contactId };
}

test('E02 D95: a 2260-parked reimbursement CANNOT be allocated to a vendor bill (GL 2000 stays open)', () => {
  const t = setup();
  const { paymentId, contactId } = reimbursedClaim(t);

  // A posted vendor bill for the SAME contact: Cr 2000 gross 108100, fully open.
  const bill = recordExpense(t.ctx, billInput(t, contactId, { idempotencyKey: 'bill' }));
  assert.equal(bill.ok, true, JSON.stringify(bill));
  const ap0 = vendorApBalance(t.store, t.workspaceId);
  assert.equal(ap0, 108100, 'the bill sits fully open on 2000');

  const alloc = allocatePayment(t.ctx, {
    paymentId,
    allocations: [{ targetKind: 'vendor_bill', targetId: bill.vendorBillId, amountMinor: 3000 }],
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'alloc-bill',
  });

  // Refused: the 2260 credit settled no control account, so nothing may be allocated against it.
  assert.equal(alloc.ok, false, JSON.stringify(alloc));
  assert.equal(alloc.error, 'allocation_target_side_mismatch');

  // The sub-ledger and the control account stay consistent: the bill is still fully open.
  const view = getVendorBill(t.ctx, { vendorBillId: bill.vendorBillId }).vendorBill;
  assert.equal(view.settlementStatus, 'unpaid', 'the bill is untouched');
  assert.equal(view.openMinor, 108100, 'nothing was settled against the bill');
  assert.equal(vendorApBalance(t.store, t.workspaceId), ap0, 'GL 2000 is unchanged');
});

test('E02 D95: a 2260-parked reimbursement CANNOT be allocated to a customer document (1100 untouched)', () => {
  const t = setup();
  const { paymentId, contactId } = reimbursedClaim(t);

  // A posted invoice for the SAME contact: Dr 1100 gross.
  const inv = issueInvoice(t.ctx, { contactId, key: 'inv' });
  const ar0 = accountBalance(t.store, t.workspaceId, '1100'); // credit - debit; a receivable is debit-heavy, so negative

  const alloc = allocatePayment(t.ctx, {
    paymentId,
    allocations: [{ targetKind: 'document', targetId: inv.id, amountMinor: 3000 }],
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'alloc-inv',
  });

  assert.equal(alloc.ok, false, JSON.stringify(alloc));
  assert.equal(alloc.error, 'allocation_target_side_mismatch');
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), ar0, 'GL 1100 is unchanged, nothing settled');
});
