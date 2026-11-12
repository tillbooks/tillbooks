// Critic r3 probes for D191 (branch claude/asset-proceeds-beta5 @ f3be88461), written by a NON-author.
// "NOTE" tests assert the behaviour OBSERVED on the reviewed head (a follow-up, not a FAIL); "HOLDS" tests
// confirm a property the brief asked about. Report: docs/critique/asset-proceeds-beta5-critic-r3.md.
//
// Every fixture here is SYNTHETIC by construction (an invented company, customer and amounts).
import test from 'node:test';
import assert from 'node:assert/strict';

import { issueInvoice, accountBalance, seedRate, GROSS_MINOR } from '../payments/support.mjs';
import { recordPayment, reversePayment, PAYMENT_INTENTS } from '../../dist/core/payments/payment.js';
import { assetDispose, assetDisposalPreview } from '../../dist/core/assets/index.js';
import { world } from './proceeds-support.mjs';

const preview = (w, assetId, extra) =>
  assetDisposalPreview(w.ctx, { assetId, disposalDate: '2026-07-15', proceedsRappen: GROSS_MINOR, gainLossAccountId: w.acc('6900'), ...extra });
const codes = (r) => r.preview.warnings.map((x) => x.code);

// D192 closed both notes. The world pins `book_proceeds` (the D191 booking these probes drive); the default
// `clear_via_document` is proven in disposal-clear-via-document.test.mjs.
test('FIXED N1 (D192): proceeds booked on 2200 (the invoice VAT line) now warn proceeds_double_counted: tax lines never count', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'n1' });
  const assetId = w.activeAsset();
  const onVat = preview(w, assetId, { proceedsAccountId: w.acc('2200'), proceedsInvoiceId: inv.id });
  assert.equal(onVat.ok, true, JSON.stringify(onVat));
  assert.equal(codes(onVat).includes('proceeds_double_counted'), true);
});

test('FIXED N2 (D192): a payment-linked cash sale with proceeds on the bank now warns proceeds_double_counted (a warning, the posting is the caller\'s)', () => {
  const w = world();
  const cash = recordPayment(w.ctx, {
    direction: 'incoming', date: '2026-07-16', amountMinor: GROSS_MINOR, currency: 'CHF', bankAccountId: w.acc('1020'),
    counterpartyKind: 'customer', counterpartyId: w.customerId, allocations: [], intent: PAYMENT_INTENTS.record, idempotencyKey: 'n2-cash',
  });
  assert.equal(cash.ok, true, JSON.stringify(cash));
  const assetId = w.activeAsset();
  const bankBefore = accountBalance(w.store, w.workspaceId, '1020');
  const d = assetDispose(w.ctx, {
    assetId, disposalDate: '2026-07-15', proceedsRappen: GROSS_MINOR, proceedsAccountId: w.acc('1020'), gainLossAccountId: w.acc('6900'),
    proceedsPaymentId: cash.paymentId, idempotencyKey: 'n2-disp',
  });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(accountBalance(w.store, w.workspaceId, '1020') - bankBefore, GROSS_MINOR, 'book_proceeds books what the caller asked');
  assert.ok(d.warnings.some((x) => x.code === 'proceeds_double_counted' && x.documentType === 'payment'), JSON.stringify(d.warnings));
});

test('HOLDS: a 1-Rappen remainder on account keeps the payment as the link and warns', () => {
  const w = world();
  const a1 = w.activeAsset();
  const inv2 = issueInvoice(w.ctx, { contactId: w.customerId, key: 'h1b' });
  const over = recordPayment(w.ctx, {
    direction: 'incoming', date: '2026-07-16', amountMinor: GROSS_MINOR + 1, currency: 'CHF', bankAccountId: w.acc('1020'),
    counterpartyKind: 'customer', counterpartyId: w.customerId,
    allocations: [{ documentId: inv2.id, amountMinor: GROSS_MINOR }], intent: PAYMENT_INTENTS.record, idempotencyKey: 'h1-over',
  });
  assert.equal(over.ok, true, JSON.stringify(over));
  const p2 = preview(w, a1, { proceedsAccountId: w.acc('1100'), proceedsPaymentId: over.paymentId });
  assert.equal(p2.ok, true, JSON.stringify(p2));
  assert.equal(p2.preview.proceeds_document.type, 'payment', 'a 1-Rappen remainder keeps the payment');
  assert.ok(codes(p2).includes('proceeds_payment_partly_unallocated'));
});

test('HOLDS: an FX payment wholly on an FX invoice resolves, and its reversal leaves the open invoice refusing', () => {
  const w = world();
  seedRate(w.ctx, { currency: 'EUR', rate: '0.94', asOf: '2026-07-19', key: 'h2-rate' });
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'h2', currency: 'EUR' });
  const total = inv.totalMinor ?? GROSS_MINOR;
  const p = recordPayment(w.ctx, {
    direction: 'incoming', date: '2026-07-19', amountMinor: total, currency: 'EUR', bankAccountId: w.acc('1020'),
    counterpartyKind: 'customer', counterpartyId: w.customerId,
    allocations: [{ documentId: inv.id, amountMinor: total }], intent: PAYMENT_INTENTS.record, idempotencyKey: 'h2-pay',
  });
  assert.equal(p.ok, true, JSON.stringify(p));
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsPaymentId: p.paymentId });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.proceedsDocument.invoiceFromPayment, true);
  assert.equal(reversePayment(w.ctx, { paymentId: p.paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'h2-rv' }).ok, true);
  assert.equal(w.reverse(assetId, d.transaction.id, {}, 'h2-rev').error, 'proceeds_settled');
});

test('HOLDS: a payment on account at dispose and allocated to an invoice afterwards stays the link and keeps refusing', () => {
  const w = world();
  const cash = w.pay(w.ctx, { customerId: w.customerId, bankId: w.acc('1020'), key: 'h3-cash' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsPaymentId: cash });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(w.row(d.transaction.id).source_document_type, 'payment');
  assert.equal(w.reverse(assetId, d.transaction.id, {}, 'h3-rev').error, 'proceeds_settled');
});
