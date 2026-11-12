// Critic r1 probes for D191 (branch claude/asset-proceeds-beta5 @ 63b10af4d), written by a NON-author.
// Each "FINDING" test asserted the behaviour OBSERVED on the reviewed head; the author's fix flipped its
// final assertion to the fixed behaviour (FIXED below). The "HOLDS" tests confirm a property the brief asked
// about. Report: docs/critique/asset-proceeds-beta5-critic-r1.md.
//
// Every fixture here is SYNTHETIC by construction (an invented company, customer and amounts).
import test from 'node:test';
import assert from 'node:assert/strict';

import { issueInvoice, accountBalance, seedRate, GROSS_MINOR } from '../payments/support.mjs';
import { createCreditNote, issueCreditNote } from '../../dist/core/sales/index.js';
import { recordPayment, reversePayment, PAYMENT_INTENTS } from '../../dist/core/payments/payment.js';
import { reverseOwnedEntry, DOCUMENT_REVERSAL_OWNER } from '../../dist/core/ledger/reverseEntry.js';
import { assetLedgerGet } from '../../dist/core/assets/index.js';
import { world } from './proceeds-support.mjs';

const balanceOf = (w, number) => accountBalance(w.store, w.workspaceId, number);

const fullCredit = (w, invoiceId, key) => {
  const cn = createCreditNote(w.ctx, { fromInvoiceId: invoiceId, mode: 'full', idempotencyKey: `${key}-cn` });
  assert.equal(cn.ok, true, JSON.stringify(cn));
  const issued = issueCreditNote(w.ctx, { creditNoteId: cn.document.id, idempotencyKey: `${key}-cn-issue` });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return cn.document.id;
};

test('FIXED F1: a paid sale undone the standard way (full Gutschrift + refund payout) no longer stands, and no hint sends it to reverse_payment', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'f1' });
  const paymentId = w.pay(w.ctx, { invoiceId: inv.id, customerId: w.customerId, bankId: w.acc('1020'), key: 'f1-pay' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id, proceedsPaymentId: paymentId });
  assert.equal(d.ok, true, JSON.stringify(d));

  // Unwind the sale: full credit note, then the money goes back to the buyer.
  const cnId = fullCredit(w, inv.id, 'f1');
  const refund = recordPayment(w.ctx, {
    direction: 'outgoing', date: '2026-07-17', amountMinor: GROSS_MINOR, currency: 'CHF', bankAccountId: w.acc('1020'),
    counterpartyKind: 'customer', counterpartyId: w.customerId,
    allocations: [{ documentId: cnId, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record, idempotencyKey: 'f1-refund',
  });
  assert.equal(refund.ok, true, JSON.stringify(refund));

  // The customer side is fully closed: the receivable nets to what the disposal itself booked on 1100
  // (the invoice and its credit cancel, the payment and the refund cancel).
  const disposalOn1100 = GROSS_MINOR; // H06 booked the proceeds on 1100 too (the open VAT note)
  assert.equal(balanceOf(w, '1100'), disposalOn1100, 'invoice, credit, payment and refund net to zero on 1100');

  assert.equal(assetLedgerGet(w.ctx, { assetId }).events.find((e) => e.type === 'disposal').proceedsDocumentStands, false);
  const r = w.reverse(assetId, d.transaction.id, {}, 'f1-rev');
  // FIXED: the refund nets the payment, the credit note takes out the invoice: nothing stands.
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.proceedsCheckOverridden, false);
});

test('FIXED F2: a payment-only link whose payment settles one invoice links that invoice, so after reverse_payment the open invoice still refuses', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'f2' });
  const paymentId = w.pay(w.ctx, { invoiceId: inv.id, customerId: w.customerId, bankId: w.acc('1020'), key: 'f2-pay' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsPaymentId: paymentId });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(w.row(d.transaction.id).source_document_type, 'invoice', 'the one invoice the payment settles is stored');
  assert.equal(w.row(d.transaction.id).source_document_id, inv.id);
  assert.equal(d.proceedsDocument.invoiceFromPayment, true);
  assert.equal(d.proceedsDocument.paymentId, paymentId);

  assert.equal(reversePayment(w.ctx, { paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'f2-rv' }).ok, true);
  const invNow = w.store.db.prepare('SELECT status FROM document WHERE workspace_id = ? AND id = ?').get(w.workspaceId, inv.id);
  assert.equal(invNow.status, 'issued', 'the invoice is open again: the buyer still owes the proceeds');

  const r = w.reverse(assetId, d.transaction.id, {}, 'f2-rev');
  // FIXED: the invoice that billed the proceeds stands again, so the reverse refuses.
  assert.equal(r.error, 'proceeds_settled', JSON.stringify(r));
  assert.equal(r.proceedsDocumentId, inv.id);
  assert.deepEqual(r.paymentIds, []);
});

test('FIXED F3 (legacy only): a credit note whose own entry a raw Storno took out no longer counts as cover, so the invoice still stands', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'f3' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  const cnId = fullCredit(w, inv.id, 'f3');
  const cnEntry = w.store.db.prepare('SELECT posted_entry_id AS e FROM document WHERE id = ?').get(cnId).e;
  const raw = reverseOwnedEntry(w.ctx, { entryId: cnEntry, date: '2026-07-18', idempotencyKey: 'f3-raw' }, DOCUMENT_REVERSAL_OWNER);
  assert.equal(raw.ok, true, JSON.stringify(raw));
  assert.equal(w.store.db.prepare('SELECT status FROM document WHERE id = ?').get(cnId).status, 'issued');
  // FIXED: the credit is out of the GL, so the invoice's receivable stands again and so does the check.
  assert.equal(assetLedgerGet(w.ctx, { assetId }).events.find((e) => e.type === 'disposal').proceedsDocumentStands, true);
  assert.equal(w.reverse(assetId, d.transaction.id, {}, 'f3-rev').error, 'proceeds_settled');
});

test('HOLDS: an idempotent replay of an overriding reverse never re-reads the setting (refuse -> off, replay identical)', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'h1' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  const extra = { overrideProceedsCheck: true, overrideReason: 'Rückabwicklung' };
  const r1 = w.reverse(assetId, d.transaction.id, extra, 'h1-rev');
  assert.equal(r1.proceedsCheckOverridden, true, JSON.stringify(r1));
  w.setCheck(w.ctx, 'off', 'h1-off');
  const before = w.rows();
  const r2 = w.reverse(assetId, d.transaction.id, extra, 'h1-rev');
  assert.deepEqual(r2, r1);
  assert.deepEqual(w.rows(), before);
});

test('HOLDS: the document moving between the friendly check and the transaction: an override that ends up bypassing nothing is not recorded', () => {
  const w = world();
  const paymentId = w.pay(w.ctx, { customerId: w.customerId, bankId: w.acc('1020'), key: 'h2-pay' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsPaymentId: paymentId });
  assert.equal(d.ok, true, JSON.stringify(d));
  const store = w.store;
  const realTx = store.tx;
  store.tx = function (fn) {
    store.tx = realTx;
    assert.equal(reversePayment(w.ctx, { paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'h2-rv' }).ok, true);
    return realTx.call(store, fn);
  };
  let r;
  try {
    r = w.reverse(assetId, d.transaction.id, { overrideProceedsCheck: true, overrideReason: 'Test' }, 'h2-rev');
  } finally {
    store.tx = realTx;
  }
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.proceedsCheckOverridden, false);
  assert.equal(w.audits.filter((e) => e.action === 'override_proceeds_check').length, 0);
  assert.doesNotMatch(w.row(r.reversalTransactionId).description, /übersteuert/);
});

test('HOLDS: a payment raised again after a reversal: a NEW payment on the linked invoice keeps it standing', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'h3' });
  const p1 = w.pay(w.ctx, { invoiceId: inv.id, customerId: w.customerId, bankId: w.acc('1020'), key: 'h3-p1' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id, proceedsPaymentId: p1 });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(reversePayment(w.ctx, { paymentId: p1, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'h3-rv' }).ok, true);
  const p2 = w.pay(w.ctx, { invoiceId: inv.id, customerId: w.customerId, bankId: w.acc('1020'), key: 'h3-p2' });
  const r = w.reverse(assetId, d.transaction.id, {}, 'h3-rev');
  assert.equal(r.error, 'proceeds_settled', JSON.stringify(r));
  assert.deepEqual(r.paymentIds, [p2]);
});

test('HOLDS: an FX invoice links with a currency warning, stands while open, and a full credit in its own currency releases it', () => {
  const w = world();
  seedRate(w.ctx, { currency: 'EUR', rate: '0.94', asOf: '2026-07-19', key: 'h4-rate' });
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'h4', currency: 'EUR' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  // The fixture books the proceeds on 1100, so the interim double-count guard (D191 point 8) warns too.
  assert.deepEqual(d.warnings.map((x) => x.code), ['proceeds_currency_differs', 'proceeds_double_counted']);
  assert.equal(w.reverse(assetId, d.transaction.id, {}, 'h4-r1').error, 'proceeds_settled');
  fullCredit(w, inv.id, 'h4');
  assert.equal(w.reverse(assetId, d.transaction.id, {}, 'h4-r2').ok, true);
});
