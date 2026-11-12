// D191 after critic r1: the refund-aware "stands" predicate (F1), the payment-only link that resolves its
// one invoice (F2), the interim double-count warning (point 8), and §H-TENANT on the three reads no test
// covered before (the payment allocation lookup, the chain walk, the payment-for-invoice check) plus the
// new payment-to-invoice lookup. Each tenant test was proven to bite by mutating `src/`, rebuilding and
// reverting (D191 in DECISIONS.md names the mutations).
//
// Every fixture here is SYNTHETIC by construction (an invented company, customer and amounts). The
// foreign rows are written raw because the API refuses a cross-workspace reference by construction:
// they model a corrupted or hostile row, which is exactly what a tenant filter must ignore.
import test from 'node:test';
import assert from 'node:assert/strict';

import { issueInvoice, secondWorkspace, GROSS_MINOR } from '../payments/support.mjs';
import { createCreditNote, issueCreditNote } from '../../dist/core/sales/index.js';
import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/payment.js';
import { assetDisposalPreview, assetLedgerGet } from '../../dist/core/assets/index.js';
import { world } from './proceeds-support.mjs';

const fullCredit = (w, ctx, invoiceId, key) => {
  const cn = createCreditNote(ctx, { fromInvoiceId: invoiceId, mode: 'full', idempotencyKey: `${key}-cn` });
  assert.equal(cn.ok, true, JSON.stringify(cn));
  assert.equal(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: `${key}-cn-issue` }).ok, true);
  return cn.document.id;
};

const foreignAllocation = (w, { workspaceId, paymentId, targetId, key }) =>
  w.store.db
    .prepare(
      `INSERT INTO payment_allocation (id, payment_id, workspace_id, target_kind, target_id, amount_minor,
         payment_amount_minor, base_amount_minor, created_at)
       VALUES (?, ?, ?, 'document', ?, ?, ?, ?, '2026-07-19T00:00:00.000Z')`,
    )
    .run(`palloc_foreign_${key}`, paymentId, workspaceId, targetId, GROSS_MINOR, GROSS_MINOR, GROSS_MINOR);

// 500.00 net at UST81 (8.1 %): 540.50 gross.
const HALF_GROSS = 54_050;

const disposalStands = (w, assetId) => assetLedgerGet(w.ctx, { assetId }).events.find((e) => e.type === 'disposal').proceedsDocumentStands;

test('F1: paid and credited in full but not paid back still stands, named by its payment, with a refund hint', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'r1a' });
  const paymentId = w.pay(w.ctx, { invoiceId: inv.id, customerId: w.customerId, bankId: w.acc('1020'), key: 'r1a-pay' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));

  const paid = w.reverse(assetId, d.transaction.id, {}, 'r1a-1');
  assert.equal(paid.error, 'proceeds_settled');
  assert.deepEqual(paid.paymentIds, [paymentId]);
  assert.equal(paid.invoiceStands, true);
  assert.match(paid.hint, /create_credit_note/);
  assert.match(paid.hint, /only if the receipt was booked in error/);

  const cnId = fullCredit(w, w.ctx, inv.id, 'r1a');
  const credited = w.reverse(assetId, d.transaction.id, {}, 'r1a-2');
  assert.equal(credited.error, 'proceeds_settled', 'the money is still held: the refund is owed, not paid');
  assert.equal(credited.invoiceStands, false);
  assert.match(credited.hint, /pay the refund out on the credit note/);

  // A part refund still leaves money in hand.
  const part = recordPayment(w.ctx, {
    direction: 'outgoing', date: '2026-07-17', amountMinor: 50_000, currency: 'CHF', bankAccountId: w.acc('1020'),
    counterpartyKind: 'customer', counterpartyId: w.customerId,
    allocations: [{ documentId: cnId, amountMinor: 50_000 }], intent: PAYMENT_INTENTS.record, idempotencyKey: 'r1a-part',
  });
  assert.equal(part.ok, true, JSON.stringify(part));
  assert.equal(w.reverse(assetId, d.transaction.id, {}, 'r1a-3').error, 'proceeds_settled');
  const rest = recordPayment(w.ctx, {
    direction: 'outgoing', date: '2026-07-18', amountMinor: GROSS_MINOR - 50_000, currency: 'CHF', bankAccountId: w.acc('1020'),
    counterpartyKind: 'customer', counterpartyId: w.customerId,
    allocations: [{ documentId: cnId, amountMinor: GROSS_MINOR - 50_000 }], intent: PAYMENT_INTENTS.record, idempotencyKey: 'r1a-rest',
  });
  assert.equal(rest.ok, true, JSON.stringify(rest));
  assert.equal(disposalStands(w, assetId), false);
  assert.equal(w.reverse(assetId, d.transaction.id, {}, 'r1a-4').ok, true);
});

test('F2: a payment linked alone that spans several invoices is kept and warned about', () => {
  const w = world();
  const a = issueInvoice(w.ctx, { contactId: w.customerId, key: 'r2a', netMinor: 50_000 });
  const b = issueInvoice(w.ctx, { contactId: w.customerId, key: 'r2b', netMinor: 50_000 });
  const p = recordPayment(w.ctx, {
    direction: 'incoming', date: '2026-07-16', amountMinor: 2 * HALF_GROSS, currency: 'CHF', bankAccountId: w.acc('1020'),
    counterpartyKind: 'customer', counterpartyId: w.customerId,
    allocations: [{ documentId: a.id, amountMinor: HALF_GROSS }, { documentId: b.id, amountMinor: HALF_GROSS }],
    intent: PAYMENT_INTENTS.record, idempotencyKey: 'r2-pay',
  });
  assert.equal(p.ok, true, JSON.stringify(p));
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsPaymentId: p.paymentId });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(w.row(d.transaction.id).source_document_type, 'payment');
  const span = d.warnings.find((x) => x.code === 'proceeds_payment_spans_invoices');
  assert.ok(span, JSON.stringify(d.warnings));
  assert.deepEqual(span.invoiceIds, [a.id, b.id].sort());
});

test('point 8 (owner 09.11.2026, clear via the invoice): an invoice link warns proceeds_double_counted on any account the invoice did not credit (1100, the bank), not on one it credited; postings unchanged', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'r3' });
  const assetId = w.activeAsset();
  const base = { assetId, disposalDate: '2026-07-15', proceedsRappen: GROSS_MINOR, gainLossAccountId: w.acc('6900'), proceedsInvoiceId: inv.id };
  const onReceivable = assetDisposalPreview(w.ctx, { ...base, proceedsAccountId: w.acc('1100') });
  assert.equal(onReceivable.ok, true, JSON.stringify(onReceivable));
  assert.ok(onReceivable.preview.warnings.some((x) => x.code === 'proceeds_double_counted'));
  // Critic r2 G2: on the bank the paid sale books the receipt twice, so it warns too.
  const onBank = assetDisposalPreview(w.ctx, { ...base, proceedsAccountId: w.acc('1020') });
  assert.equal(onBank.ok, true, JSON.stringify(onBank));
  assert.ok(onBank.preview.warnings.some((x) => x.code === 'proceeds_double_counted'), JSON.stringify(onBank.preview.warnings));
  // D192 (N1): the VAT line no longer counts, so 2200 warns too.
  const onVat = assetDisposalPreview(w.ctx, { ...base, proceedsAccountId: w.acc('2200') });
  assert.equal(onVat.ok, true, JSON.stringify(onVat));
  assert.ok(onVat.preview.warnings.some((x) => x.code === 'proceeds_double_counted'), JSON.stringify(onVat.preview.warnings));
  // D192: the invoice's sale line account (3200, the manual clearing) is the one case that stays quiet,
  // up to the largest sale line on it (here the net, 1'000.00).
  const onCredited = assetDisposalPreview(w.ctx, { ...base, proceedsRappen: 100000, proceedsAccountId: w.acc('3200') });
  assert.equal(onCredited.ok, true, JSON.stringify(onCredited));
  assert.deepEqual(onCredited.preview.warnings.filter((x) => x.code === 'proceeds_double_counted' || x.code === 'proceeds_exceed_sale_line'), [], JSON.stringify(onCredited.preview.warnings));
  // The lines are the same with or without the warning: only the account the caller chose differs.
  assert.equal(onReceivable.preview.journal_lines.length, onBank.preview.journal_lines.length);
  assert.equal(onBank.preview.journal_lines.length, onCredited.preview.journal_lines.length);
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.ok(d.warnings.some((x) => x.code === 'proceeds_double_counted'), 'the result carries it too');
  // D192 (critic r1 F6): a payment-only Guthaben with proceeds on 1100, the account its entry credited, warns.
  const cash = w.pay(w.ctx, { customerId: w.customerId, bankId: w.acc('1020'), key: 'r3-cash' });
  const a2 = w.activeAsset();
  const d2 = w.dispose(a2, { proceedsPaymentId: cash });
  assert.equal(d2.ok, true, JSON.stringify(d2));
  assert.equal(d2.warnings.some((x) => x.code === 'proceeds_double_counted' && x.documentType === 'payment'), true, JSON.stringify(d2.warnings));
});

test('§H-TENANT, the payment allocation lookup: a foreign payment allocated to this invoice does not keep it standing', () => {
  const w = world();
  const other = secondWorkspace(w);
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 't1' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  fullCredit(w, w.ctx, inv.id, 't1');
  const foreignInv = issueInvoice(other.ctx, { contactId: other.customerId, key: 't1-f' });
  const foreignPay = w.pay(other.ctx, { invoiceId: foreignInv.id, customerId: other.customerId, bankId: other.bankId, key: 't1-fp' });
  foreignAllocation(w, { workspaceId: other.workspaceId, paymentId: foreignPay, targetId: inv.id, key: 't1' });
  assert.equal(disposalStands(w, assetId), false, 'credited in full, unpaid here: the foreign payment is invisible');
  assert.equal(w.reverse(assetId, d.transaction.id, {}, 't1-rev').ok, true);
});

test('§H-TENANT, the chain walk: a foreign posted mirror naming this invoice entry does not take the invoice out', () => {
  const w = world();
  const other = secondWorkspace(w);
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 't2' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  const posted = w.store.db.prepare('SELECT posted_entry_id AS e FROM document WHERE id = ?').get(inv.id).e;
  w.store.db
    .prepare(
      `INSERT INTO journal_entry (id, workspace_id, date, description, status, reverses_entry_id, source, created_at)
       VALUES ('je_foreign_mirror_t2', ?, '2026-07-18', 'fremd', 'posted', ?, 'manual', '2026-07-19T00:00:00.000Z')`,
    )
    .run(other.workspaceId, posted);
  assert.equal(disposalStands(w, assetId), true);
  assert.equal(w.reverse(assetId, d.transaction.id, {}, 't2-rev').error, 'proceeds_settled');
});

test('§H-TENANT, the payment-for-invoice check: a foreign allocation row cannot make this payment settle this invoice', () => {
  const w = world();
  const other = secondWorkspace(w);
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 't3' });
  const onAccount = w.pay(w.ctx, { customerId: w.customerId, bankId: w.acc('1020'), key: 't3-pay' });
  foreignAllocation(w, { workspaceId: other.workspaceId, paymentId: onAccount, targetId: inv.id, key: 't3' });
  const assetId = w.activeAsset();
  const r = w.dispose(assetId, { proceedsInvoiceId: inv.id, proceedsPaymentId: onAccount });
  assert.equal(r.error, 'invalid_proceeds_document', JSON.stringify(r));
  assert.equal(r.reason, 'payment_not_for_invoice');
});

test('§H-TENANT, the payment-to-invoice lookup (F2): a foreign allocation row does not add an invoice to this payment', () => {
  const w = world();
  const other = secondWorkspace(w);
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 't4' });
  const paymentId = w.pay(w.ctx, { invoiceId: inv.id, customerId: w.customerId, bankId: w.acc('1020'), key: 't4-pay' });
  const foreignInv = issueInvoice(other.ctx, { contactId: other.customerId, key: 't4-f' });
  foreignAllocation(w, { workspaceId: other.workspaceId, paymentId, targetId: foreignInv.id, key: 't4' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsPaymentId: paymentId });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(w.row(d.transaction.id).source_document_type, 'invoice', 'one local invoice: it is linked');
  assert.equal(w.row(d.transaction.id).source_document_id, inv.id);
  assert.equal(d.warnings.some((x) => x.code === 'proceeds_payment_spans_invoices'), false);
});

test('§H-TENANT, the document join of the payment picture (G1): a local allocation row naming a foreign invoice id is not an invoice here', () => {
  const w = world();
  const other = secondWorkspace(w);
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 't5' });
  const paymentId = w.pay(w.ctx, { invoiceId: inv.id, customerId: w.customerId, bankId: w.acc('1020'), key: 't5-pay' });
  const foreignInv = issueInvoice(other.ctx, { contactId: other.customerId, key: 't5-f' });
  // A hostile row in THIS workspace, on this payment, naming the other workspace's invoice, consuming nothing.
  w.store.db
    .prepare(
      `INSERT INTO payment_allocation (id, payment_id, workspace_id, target_kind, target_id, amount_minor,
         payment_amount_minor, base_amount_minor, created_at)
       VALUES ('palloc_local_t5', ?, ?, 'document', ?, 0, 0, 0, '2026-07-19T00:00:00.000Z')`,
    )
    .run(paymentId, w.workspaceId, foreignInv.id);
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsPaymentId: paymentId });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.warnings.some((x) => x.code === 'proceeds_payment_spans_invoices'), false, JSON.stringify(d.warnings));
  assert.equal(JSON.stringify(d).includes(foreignInv.id), false, 'the foreign invoice id never leaks');
  const partly = d.warnings.find((x) => x.code === 'proceeds_payment_partly_unallocated');
  assert.ok(partly, 'the unknown target keeps the payment as the link');
  assert.equal(partly.otherTargets, true);
  assert.equal(w.row(d.transaction.id).source_document_type, 'payment');
});
