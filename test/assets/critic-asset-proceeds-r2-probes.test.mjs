// Critic r2 probes for D191 (branch claude/asset-proceeds-beta5 @ 8b38e8e48), written by a NON-author.
// Each "FINDING" test asserted the behaviour OBSERVED on the reviewed head; the author's fix flipped it
// to the fixed behaviour (FIXED below). The "HOLDS" tests confirm a property the brief asked
// about. Report: docs/critique/asset-proceeds-beta5-critic-r2.md.
//
// Every fixture here is SYNTHETIC by construction (an invented company, customer and amounts).
import test from 'node:test';
import assert from 'node:assert/strict';

import { issueInvoice, accountBalance, GROSS_MINOR } from '../payments/support.mjs';
import { createCreditNote, issueCreditNote } from '../../dist/core/sales/index.js';
import { recordPayment, reversePayment, PAYMENT_INTENTS } from '../../dist/core/payments/payment.js';
import { assetDispose, assetLedgerGet } from '../../dist/core/assets/index.js';
import { world } from './proceeds-support.mjs';

const ASSET_PRICE = 500_000; // the vehicle, sold for CHF 5'000.00 (no invoice for it)

const fullCreditAndRefund = (w, invoiceId, key) => {
  const cn = createCreditNote(w.ctx, { fromInvoiceId: invoiceId, mode: 'full', idempotencyKey: `${key}-cn` });
  assert.equal(cn.ok, true, JSON.stringify(cn));
  assert.equal(issueCreditNote(w.ctx, { creditNoteId: cn.document.id, idempotencyKey: `${key}-cn-issue` }).ok, true);
  const refund = recordPayment(w.ctx, {
    direction: 'outgoing', date: '2026-07-17', amountMinor: GROSS_MINOR, currency: 'CHF', bankAccountId: w.acc('1020'),
    counterpartyKind: 'customer', counterpartyId: w.customerId,
    allocations: [{ documentId: cn.document.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record, idempotencyKey: `${key}-refund`,
  });
  assert.equal(refund.ok, true, JSON.stringify(refund));
};

test('FIXED G1: one transfer pays a service invoice AND the vehicle; the payment stays the link, is warned partly unallocated, and unwinding the service does not release the vehicle\'s proceeds check', () => {
  const w = world();
  const service = issueInvoice(w.ctx, { contactId: w.customerId, key: 'g1' }); // CHF 1'081.00
  const transfer = recordPayment(w.ctx, {
    direction: 'incoming', date: '2026-07-16', amountMinor: GROSS_MINOR + ASSET_PRICE, currency: 'CHF', bankAccountId: w.acc('1020'),
    counterpartyKind: 'customer', counterpartyId: w.customerId,
    allocations: [{ documentId: service.id, amountMinor: GROSS_MINOR }], // the rest sits on account
    intent: PAYMENT_INTENTS.record, idempotencyKey: 'g1-transfer',
  });
  assert.equal(transfer.ok, true, JSON.stringify(transfer));
  const assetId = w.activeAsset();
  const d = assetDispose(w.ctx, {
    assetId, disposalDate: '2026-07-15', proceedsRappen: ASSET_PRICE, proceedsAccountId: w.acc('1020'), gainLossAccountId: w.acc('6900'),
    proceedsPaymentId: transfer.paymentId, idempotencyKey: 'g1-disp',
  });
  assert.equal(d.ok, true, JSON.stringify(d));
  // FIXED: the payment is not wholly on the service invoice, so the payment itself stays the link.
  assert.equal(w.row(d.transaction.id).source_document_type, 'payment');
  assert.equal(w.row(d.transaction.id).source_document_id, transfer.paymentId);
  assert.equal(d.proceedsDocument.invoiceFromPayment, false);
  const partly = d.warnings.find((x) => x.code === 'proceeds_payment_partly_unallocated');
  assert.ok(partly, JSON.stringify(d.warnings));
  assert.equal(partly.invoiceId, service.id);
  assert.equal(partly.unallocatedMinor, ASSET_PRICE);

  // The service (not the vehicle) is credited and refunded. The transfer, with the vehicle's 5'000 on it, stands.
  fullCreditAndRefund(w, service.id, 'g1');
  const pay = w.store.db.prepare('SELECT reversal_entry_id FROM payment WHERE id = ?').get(transfer.paymentId);
  assert.equal(pay.reversal_entry_id, null, 'the vehicle proceeds payment still stands');

  const r = w.reverse(assetId, d.transaction.id, {}, 'g1-rev');
  // FIXED: refused while the payment carrying the vehicle's proceeds stands.
  assert.equal(r.error, 'proceeds_settled', JSON.stringify(r));
  assert.equal(r.proceedsDocumentType, 'payment');
  assert.equal(r.proceedsDocumentId, transfer.paymentId);
});

test('FIXED G2: the interim double-count guard warns when the proceeds go to the bank, where an invoiced, paid sale books the receipt twice', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'g2' });
  const paymentId = w.pay(w.ctx, { invoiceId: inv.id, customerId: w.customerId, bankId: w.acc('1020'), key: 'g2-pay' });
  const bankBefore = accountBalance(w.store, w.workspaceId, '1020');
  const assetId = w.activeAsset();
  const bankAfterAcquire = accountBalance(w.store, w.workspaceId, '1020');
  // The natural Studio path: pick the payment ("the money arrived"), book the proceeds on the bank.
  const d = assetDispose(w.ctx, {
    assetId, disposalDate: '2026-07-15', proceedsRappen: GROSS_MINOR, proceedsAccountId: w.acc('1020'), gainLossAccountId: w.acc('6900'),
    proceedsPaymentId: paymentId, idempotencyKey: 'g2-disp',
  });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.proceedsDocument.invoiceFromPayment, true, 'resolved to the invoice');
  // One receipt of 1'081.00 from the buyer, but the bank now carries it twice: the payment and the disposal.
  assert.equal(accountBalance(w.store, w.workspaceId, '1020') - bankAfterAcquire, GROSS_MINOR);
  assert.ok(bankBefore > 0);
  // FIXED: the bank is not an account the invoice credited, so the double count is warned (never refused).
  assert.equal(d.warnings.some((x) => x.code === 'proceeds_double_counted'), true, JSON.stringify(d.warnings));
});

test('HOLDS: a resolved (invoiceFromPayment) dispose replays the original after its invoice moved, writing nothing', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'h1' });
  const paymentId = w.pay(w.ctx, { invoiceId: inv.id, customerId: w.customerId, bankId: w.acc('1020'), key: 'h1-pay' });
  const assetId = w.activeAsset();
  const first = w.dispose(assetId, { proceedsPaymentId: paymentId }, undefined, 'h1-disp');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.proceedsDocument.invoiceFromPayment, true);
  assert.equal(reversePayment(w.ctx, { paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'h1-rv' }).ok, true);
  const before = w.rows();
  const again = w.dispose(assetId, { proceedsPaymentId: paymentId }, undefined, 'h1-disp');
  assert.deepEqual(again, first);
  assert.deepEqual(w.rows(), before);
});

test('HOLDS: a payment whose only allocation is on a FOREIGN invoice (raw row) is kept as the payment, no foreign id leaks', () => {
  const w = world();
  const onAccount = w.pay(w.ctx, { customerId: w.customerId, bankId: w.acc('1020'), key: 'h2-pay' });
  // A raw, hostile allocation in THIS workspace naming an id that only exists in another workspace.
  const otherInv = 'doc_foreign_only_h2';
  w.store.db
    .prepare(
      `INSERT INTO payment_allocation (id, payment_id, workspace_id, target_kind, target_id, amount_minor, payment_amount_minor, base_amount_minor, created_at)
       VALUES ('palloc_h2', ?, ?, 'document', ?, 1, 1, 1, '2026-07-19T00:00:00.000Z')`,
    )
    .run(onAccount, w.workspaceId, otherInv);
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsPaymentId: onAccount });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(w.row(d.transaction.id).source_document_type, 'payment');
  assert.equal(JSON.stringify(d).includes(otherInv), false);
});

