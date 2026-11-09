// A14 payable-account override (D95, added for E02 employee-payable, 2026-08-05).
//
// `recordPayment` may settle the PAYABLE side against a liability account OTHER than 2000 Kreditoren
// when the caller passes `payableAccountId`. It exists so an E02 expense-claim reimbursement clears
// the dedicated employee-payable account (2260) instead of commingling with vendor AP, and it is
// deliberately narrow. These assertions are what make it narrow: each one fails if its guard is
// removed, and the DEFAULT (no override) case proves no shipped payment shape changed.
//
//   - honoured for an on-account SUPPLIER settlement: the counter leg lands on the named account
//   - the override touches ONLY the payable counter leg; 2000 Kreditoren is never involved
//   - refused when the account is not a liability (never cash, never a receivable)
//   - refused on the receivable side (a customer settlement can never divert to a payable account)
//   - refused alongside an allocation: a vendor bill fixes 2000 through its own row, so an override
//     there could silently disagree with the position it clears. This is the guard that protects AP.
//   - a missing/archived account is a structured refusal, not a throw
//   - DEFAULT (no override): a supplier on-account payment still books 2000, byte-for-byte as before

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { recordExpense } from '../../dist/core/purchase/index.js';
import { setup, addVendor, billInput, legsOf, accountBalance, GROSS_MINOR } from '../purchase/support.mjs';

const AMOUNT = 5000; // CHF 50.00, no allocation: a pure on-account settlement

function legOn(store, workspaceId, entryId, number) {
  return legsOf(store, workspaceId, entryId).find((l) => l.number === number);
}

test('A14 override: an on-account SUPPLIER payment clears the named liability account, not 2000', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-10',
    amountMinor: AMOUNT,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    payableAccountId: t.acc('2260'),
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'ov-happy',
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  // The payable leg (a Dr on an outgoing settlement) is on 2260, and there is NO leg on 2000.
  const on2260 = legOn(t.store, t.workspaceId, res.entryId, '2260');
  assert.ok(on2260, 'the counter leg is on the employee-payable account 2260');
  assert.equal(on2260.debit, AMOUNT, 'the whole settlement debits 2260');
  assert.equal(legOn(t.store, t.workspaceId, res.entryId, '2000'), undefined, 'no leg on 2000 Kreditoren');
  assert.equal(legOn(t.store, t.workspaceId, res.entryId, '1020').credit, AMOUNT, 'the bank is credited');
  assert.equal(accountBalance(t.store, t.workspaceId, '2000'), 0, 'vendor AP is untouched');
});

test('A14 override: DEFAULT (no override) still books 2000 Kreditoren, unchanged', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-10',
    amountMinor: AMOUNT,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'ov-default',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(legOn(t.store, t.workspaceId, res.entryId, '2000').debit, AMOUNT, 'the default counter is 2000');
  assert.equal(legOn(t.store, t.workspaceId, res.entryId, '2260'), undefined, 'no leg on 2260 without an override');
});

test('A14 override: a NON-LIABILITY payable account is refused (never cash, never a receivable)', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-10',
    amountMinor: AMOUNT,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    payableAccountId: t.acc('1020'), // Bankkonto, an asset
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'ov-asset',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_input');
  assert.equal(res.reason, 'not_a_liability');
});

test('A14 override: refused on the RECEIVABLE side (a customer settlement cannot divert to a payable)', () => {
  const t = setup();
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-10',
    amountMinor: AMOUNT,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: t.customerId,
    payableAccountId: t.acc('2260'),
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'ov-recv',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_input');
  assert.equal(res.reason, 'not_a_payable_settlement');
});

test('A14 override: refused ALONGSIDE a vendor-bill allocation (AP protection)', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const posted = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'ov-bill' }));
  assert.ok(posted.ok, JSON.stringify(posted));

  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-10',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    payableAccountId: t.acc('2260'),
    allocations: [{ targetKind: 'vendor_bill', targetId: posted.vendorBillId, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'ov-bill-pay',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_input');
  assert.equal(res.reason, 'override_with_allocation');
  // The bill's payable is still fully on 2000, untouched by the refused override.
  assert.equal(accountBalance(t.store, t.workspaceId, '2000'), -GROSS_MINOR, '2000 still carries the open bill');
});

test('A14 override: a missing payable account is a structured refusal, not a throw', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-10',
    amountMinor: AMOUNT,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    payableAccountId: 'no-such-account',
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'ov-missing',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_account');
});
