/**
 * The allocation-mode Werkbank previews a parked Guthaben by planning the CREDIT as a payment
 * (brief B7, the D59 follow-up): `preview_payment` with `amountMinor = onAccountMinor` and the
 * payment's own direction, date, currency, Konto and Gegenpartei. `allocate_payment` replans the
 * WHOLE payment with `existingAllocatedMinor = amount - credit`. The Studio's confirm is only as honest
 * as the claim that those two plans agree, so this pins it against the live engine: the same rows, the
 * same Guthaben left, and the same refusal code when the plan is blocked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { recordPayment, previewPayment, allocatePayment, getPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { setup, issueInvoice, GROSS_MINOR } from './support.mjs';

/** A CHF 1'100.00 payment against a CHF 1'081.00 invoice: CHF 19.00 parked as a Guthaben. */
function parked() {
  const t = setup();
  const paid = issueInvoice(t.ctx, { contactId: t.customerId, key: 'par-paid', dueDate: '2026-08-18' });
  const open = issueInvoice(t.ctx, {
    contactId: t.customerId,
    netMinor: 25000,
    taxCode: 'none',
    key: 'par-open',
    dueDate: '2026-07-10',
  });
  const recorded = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 110000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: paid.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'par-record',
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  const payment = getPayment(t.ctx, { paymentId: recorded.paymentId }).payment;
  assert.equal(payment.onAccountMinor, 1900);
  return { t, open, payment };
}

/** Exactly the request the Werkbank builds in allocation mode (`PaymentAllocator.runPreview`). */
function previewOfCredit(t, payment, allocations) {
  return previewPayment(t.ctx, {
    direction: payment.direction,
    date: payment.date,
    currency: payment.currency,
    bankAccountId: payment.bankAccount.id,
    counterpartyKind: payment.counterparty.kind,
    counterpartyId: payment.counterparty.id,
    amountMinor: payment.onAccountMinor,
    allocations,
  });
}

test('the preview of the credit plans what allocate_payment then writes', () => {
  const { t, open, payment } = parked();
  const allocations = [{ documentId: open.id, amountMinor: 1900 }];

  const preview = previewOfCredit(t, payment, allocations);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.error, null);
  assert.equal(preview.allocatedMinor, 1900);
  assert.equal(preview.remainderMinor, 0);

  const allocated = allocatePayment(t.ctx, {
    paymentId: payment.id,
    allocations,
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'par-allocate',
  });
  assert.equal(allocated.ok, true, JSON.stringify(allocated));
  // The Guthaben the preview said would be left is the Guthaben that is left.
  assert.equal(allocated.onAccountMinor, preview.onAccountMinor);

  const row = preview.rows.find((r) => r.targetId === open.id);
  const echo = allocated.documents.find((d) => d.id === open.id);
  assert.equal(echo.openMinor, row.resultingOpenMinor);
  assert.equal(echo.paidMinor, row.paidMinor + row.paymentAmountMinor);
});

test('an over-allocation is blocked in the preview with the code allocate_payment refuses with', () => {
  const { t, open, payment } = parked();
  const allocations = [{ documentId: open.id, amountMinor: 2000 }];

  const preview = previewOfCredit(t, payment, allocations);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.notEqual(preview.error, null);

  const refused = allocatePayment(t.ctx, {
    paymentId: payment.id,
    allocations,
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'par-over',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, preview.error.code);
});
