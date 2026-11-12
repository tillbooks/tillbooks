// D191, the disposal's proceeds document (H06 extension, owner decision Q4 of 15.10.2026):
// `asset_dispose` may link the sales invoice and/or the incoming payment the proceeds came with, and
// `asset_transaction_reverse` on that disposal refuses `proceeds_settled` while the linked document
// stands (the D168/D169 rule: undo the money act first). A single differing case passes
// `overrideProceedsCheck` with a required, audited reason. An unlinked disposal keeps D170's behaviour.
//
// Every fixture here is SYNTHETIC by construction (an invented company, customer and amounts).
//
// What must BITE (each was run against a mutation, see D191 in DECISIONS.md):
//  - the refusal while an invoice stands, and its release after cancel / full credit;
//  - a payment on the invoice keeps it standing; the payment-only link and its release by reverse_payment;
//  - the dispose-time validation (§H-TENANT, kind, standing, payment for that invoice, scrap);
//  - the override: reason required, recorded on the immutable correcting row and audited;
//  - a book whose invoice entry a raw Storno took out (chain-walk) reads as not standing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, issueInvoice, secondWorkspace, GROSS_MINOR } from '../payments/support.mjs';
import { transitionDocument, createCreditNote, issueCreditNote } from '../../dist/core/sales/index.js';
import { recordPayment, reversePayment, PAYMENT_INTENTS } from '../../dist/core/payments/payment.js';
import { reverseOwnedEntry, DOCUMENT_REVERSAL_OWNER } from '../../dist/core/ledger/reverseEntry.js';
import {
  createAssetCategory,
  createAsset,
  assetAcquire,
  assetDispose,
  assetDisposalPreview,
  assetLedgerGet,
  assetTransactionReverse,
} from '../../dist/core/assets/index.js';
import { pinBookProceeds } from './proceeds-support.mjs';

function world() {
  const t = setup();
  // D192: this suite drives D191's booking (the caller's proceeds), the book_proceeds mode.
  pinBookProceeds(t.ctx);
  const audits = [];
  const inner = t.ctx.audit;
  t.ctx.audit = { record: (e) => { audits.push(e); inner.record(e); } };
  let n = 0;
  const activeAsset = () => {
    n += 1;
    const cat = createAssetCategory(t.ctx, {
      code: `FZ-${n}`, name: 'Fahrzeuge', depreciationMethod: 'straight_line', usefulLifeMonths: 60,
      glAssetAccountId: t.acc('1500'), glAccumDeprAccountId: t.acc('1510'), glDeprExpenseAccountId: t.acc('6800'),
      idempotencyKey: `cat-${n}`,
    });
    assert.equal(cat.ok, true, JSON.stringify(cat));
    const a = createAsset(t.ctx, { categoryId: cat.category.id, name: `Lieferwagen ${n}`, acquisitionDate: '2026-01-10', acquisitionCostRappen: 2_000_000, idempotencyKey: `as-${n}` });
    assert.equal(a.ok, true, JSON.stringify(a));
    const acq = assetAcquire(t.ctx, { assetId: a.asset.id, date: '2026-01-10', acquisitionCostRappen: 2_000_000, creditAccountId: t.acc('1020'), idempotencyKey: `acq-${n}` });
    assert.equal(acq.ok, true, JSON.stringify(acq));
    return a.asset.id;
  };
  const dispose = (assetId, link = {}, proceedsRappen = GROSS_MINOR) =>
    assetDispose(t.ctx, {
      assetId, disposalDate: '2026-07-15', proceedsRappen, proceedsAccountId: t.acc('1100'), gainLossAccountId: t.acc('6900'),
      ...link, idempotencyKey: `disp-${assetId}-${JSON.stringify(link)}`,
    });
  const pay = (invoiceId, key) => {
    const p = recordPayment(t.ctx, {
      direction: 'incoming', date: '2026-07-16', amountMinor: GROSS_MINOR, currency: 'CHF', bankAccountId: t.acc('1020'),
      counterpartyKind: 'customer', counterpartyId: t.customerId,
      allocations: invoiceId ? [{ documentId: invoiceId, amountMinor: GROSS_MINOR }] : [],
      intent: PAYMENT_INTENTS.record, idempotencyKey: key,
    });
    assert.equal(p.ok, true, JSON.stringify(p));
    return p.paymentId;
  };
  const reverse = (assetId, transactionId, extra = {}, key = `rev-${transactionId}-${JSON.stringify(extra)}`) =>
    assetTransactionReverse(t.ctx, { assetId, transactionId, reason: 'Verkauf geplatzt', idempotencyKey: key, ...extra });
  const row = (id) => t.store.db.prepare('SELECT * FROM asset_transaction WHERE workspace_id = ? AND id = ?').get(t.workspaceId, id);
  const txns = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM asset_transaction WHERE workspace_id = ?').get(t.workspaceId).n;
  return { ...t, audits, activeAsset, dispose, pay, reverse, row, txns };
}

test('an invoice-linked disposal is stored on the row and its reverse is refused while the invoice stands, then goes once it is cancelled', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'i1' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(d.proceedsDocument, { type: 'invoice', id: inv.id, invoiceId: inv.id, paymentId: null, invoiceFromPayment: false });
  const stored = w.row(d.transaction.id);
  assert.equal(stored.source_document_type, 'invoice');
  assert.equal(stored.source_document_id, inv.id);

  const before = w.txns();
  const refused = w.reverse(assetId, d.transaction.id);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'proceeds_settled', JSON.stringify(refused));
  assert.equal(refused.proceedsDocumentType, 'invoice');
  assert.equal(refused.proceedsDocumentId, inv.id);
  assert.equal(w.txns(), before, 'the refusal wrote nothing');
  const ledger = assetLedgerGet(w.ctx, { assetId });
  assert.equal(ledger.events.find((e) => e.type === 'disposal').proceedsDocumentStands, true);

  const cancelled = transitionDocument(w.ctx, { documentId: inv.id, to: 'cancelled', idempotencyKey: 'i1-cancel' });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  const r = w.reverse(assetId, d.transaction.id, {}, 'rev-after-cancel');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.proceedsCheckOverridden, false);
  assert.equal(assetLedgerGet(w.ctx, { assetId }).events.find((e) => e.type === 'disposal').proceedsDocumentStands, false);
});

test('an invoice credited in full no longer stands; a partial credit still does', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'i2' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  const part = createCreditNote(w.ctx, { fromInvoiceId: inv.id, mode: 'partial', amountMinor: 10_000, idempotencyKey: 'cn-part' });
  assert.equal(part.ok, true, JSON.stringify(part));
  assert.equal(issueCreditNote(w.ctx, { creditNoteId: part.document.id, idempotencyKey: 'cn-part-issue' }).ok, true);
  assert.equal(w.reverse(assetId, d.transaction.id, {}, 'k1').error, 'proceeds_settled');
  const rest = createCreditNote(w.ctx, { fromInvoiceId: inv.id, mode: 'partial', amountMinor: 90_000, idempotencyKey: 'cn-rest' });
  assert.equal(rest.ok, true, JSON.stringify(rest));
  assert.equal(issueCreditNote(w.ctx, { creditNoteId: rest.document.id, idempotencyKey: 'cn-rest-issue' }).ok, true);
  const r = w.reverse(assetId, d.transaction.id, {}, 'k2');
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('a payment on the linked invoice keeps it standing and is named; the payment-only link is released by reverse_payment', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'i3' });
  const paymentId = w.pay(inv.id, 'p3');
  const a1 = w.activeAsset();
  const d1 = w.dispose(a1, { proceedsInvoiceId: inv.id, proceedsPaymentId: paymentId });
  assert.equal(d1.ok, true, JSON.stringify(d1));
  assert.equal(w.row(d1.transaction.id).source_document_type, 'invoice', 'with both, the invoice is stored');
  const refused = w.reverse(a1, d1.transaction.id);
  assert.equal(refused.error, 'proceeds_settled');
  assert.deepEqual(refused.paymentIds, [paymentId]);
  assert.match(refused.hint, /reverse_payment/);
  // Credited in full, the invoice itself no longer stands, but the payment on it does: still refused.
  const cn = createCreditNote(w.ctx, { fromInvoiceId: inv.id, mode: 'full', idempotencyKey: 'cn-paid' });
  assert.equal(cn.ok, true, JSON.stringify(cn));
  assert.equal(issueCreditNote(w.ctx, { creditNoteId: cn.document.id, idempotencyKey: 'cn-paid-issue' }).ok, true);
  assert.equal(w.reverse(a1, d1.transaction.id, {}, 'k-paid-credited').error, 'proceeds_settled', 'the payment keeps it standing');
  assert.equal(reversePayment(w.ctx, { paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'rv-p3' }).ok, true);
  assert.equal(w.reverse(a1, d1.transaction.id, {}, 'k-paid-released').ok, true, 'payment reversed, invoice credited: released');

  // Payment only: a cash sale with no invoice.
  const cash = w.pay(null, 'p3-cash');
  const a2 = w.activeAsset();
  const d2 = w.dispose(a2, { proceedsPaymentId: cash });
  assert.equal(d2.ok, true, JSON.stringify(d2));
  assert.equal(w.row(d2.transaction.id).source_document_type, 'payment');
  assert.equal(w.reverse(a2, d2.transaction.id, {}, 'k-cash-1').error, 'proceeds_settled');
  assert.equal(reversePayment(w.ctx, { paymentId: cash, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'rv-cash' }).ok, true);
  const r = w.reverse(a2, d2.transaction.id, {}, 'k-cash-2');
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('dispose-time validation: foreign, wrong kind, not standing, a payment for another invoice and a scrap are refused, writing nothing', () => {
  const w = world();
  const other = secondWorkspace(w);
  const foreign = issueInvoice(other.ctx, { contactId: other.customerId, key: 'f1' });
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'i4' });
  const inv2 = issueInvoice(w.ctx, { contactId: w.customerId, key: 'i4b' });
  const paidOther = w.pay(inv2.id, 'p4');
  const cancelled = issueInvoice(w.ctx, { contactId: w.customerId, key: 'i4c' });
  assert.equal(transitionDocument(w.ctx, { documentId: cancelled.id, to: 'cancelled', idempotencyKey: 'i4c-x' }).ok, true);
  const assetId = w.activeAsset();
  const before = w.txns();
  const cases = [
    [{ proceedsInvoiceId: foreign.id }, 'not_found'],
    [{ proceedsInvoiceId: 'doc_nope' }, 'not_found'],
    [{ proceedsInvoiceId: cancelled.id }, 'not_standing'],
    [{ proceedsPaymentId: 'pay_nope' }, 'not_found'],
    [{ proceedsInvoiceId: inv.id, proceedsPaymentId: paidOther }, 'payment_not_for_invoice'],
  ];
  for (const [link, reason] of cases) {
    const r = w.dispose(assetId, link);
    assert.equal(r.error, 'invalid_proceeds_document', JSON.stringify([link, r]));
    assert.equal(r.reason, reason, JSON.stringify([link, r]));
  }
  const scrap = w.dispose(assetId, { proceedsInvoiceId: inv.id }, 0);
  assert.equal(scrap.reason, 'no_proceeds');
  // The preview shares the plan.
  const prev = assetDisposalPreview(w.ctx, { assetId, disposalDate: '2026-07-15', proceedsRappen: GROSS_MINOR, proceedsAccountId: w.acc('1100'), gainLossAccountId: w.acc('6900'), proceedsInvoiceId: foreign.id });
  assert.equal(prev.error, 'invalid_proceeds_document');
  assert.equal(w.txns(), before, 'no refusal wrote a row');
});

test('a different amount or counterparty is stored and warned about, not refused', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'i5' });
  const assetId = w.activeAsset();
  const prev = assetDisposalPreview(w.ctx, { assetId, disposalDate: '2026-07-15', proceedsRappen: 100_000, proceedsAccountId: w.acc('1100'), gainLossAccountId: w.acc('6900'), counterpartyName: 'Jemand Anderes', proceedsInvoiceId: inv.id });
  assert.equal(prev.ok, true, JSON.stringify(prev));
  // The fixture books the proceeds on 1100, so the interim double-count guard (point 8) warns as well.
  assert.deepEqual(prev.preview.warnings.map((x) => x.code).sort(), ['counterparty_differs', 'proceeds_amount_differs', 'proceeds_double_counted']);
  assert.equal(prev.preview.proceeds_document.id, inv.id);
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id }, 100_000);
  assert.equal(d.ok, true, JSON.stringify(d));
  const amount = d.warnings.find((x) => x.code === 'proceeds_amount_differs');
  assert.ok(amount, JSON.stringify(d.warnings));
  assert.equal(amount.documentAmountMinor, GROSS_MINOR);
});

test('the override: a reason is required, the bypass is written on the correcting row and the mirror, and audited', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'i6' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  const before = w.txns();
  const noReason = w.reverse(assetId, d.transaction.id, { overrideProceedsCheck: true }, 'o1');
  assert.equal(noReason.error, 'reason_required');
  assert.equal(noReason.field, 'overrideReason');
  assert.equal(w.reverse(assetId, d.transaction.id, { overrideProceedsCheck: true, overrideReason: '   ' }, 'o2').error, 'reason_required');
  assert.equal(w.reverse(assetId, d.transaction.id, { overrideProceedsCheck: 'yes', overrideReason: 'x' }, 'o3').error, 'invalid_input');
  assert.equal(w.txns(), before);

  const r = w.reverse(assetId, d.transaction.id, { overrideProceedsCheck: true, overrideReason: 'Rechnung wird separat gutgeschrieben' }, 'o4');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.proceedsCheckOverridden, true);
  assert.match(w.row(r.reversalTransactionId).description, /Erlösprüfung übersteuert: Rechnung wird separat gutgeschrieben/);
  const mirror = w.store.db.prepare('SELECT description FROM journal_entry WHERE workspace_id = ? AND id = ?').get(w.workspaceId, r.reversalEntryId);
  assert.match(mirror.description, /Erlösprüfung übersteuert/);
  assert.ok(w.audits.some((e) => e.action === 'override_proceeds_check' && e.entityId === d.transaction.id), 'the override is audited');
});

test('an override that bypassed nothing is not recorded as one; an unlinked disposal reverses exactly as under D170', () => {
  const w = world();
  const assetId = w.activeAsset();
  const d = w.dispose(assetId);
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.proceedsDocument, null);
  assert.equal(w.row(d.transaction.id).source_document_type, null);
  assert.equal(assetLedgerGet(w.ctx, { assetId }).events.find((e) => e.type === 'disposal').proceedsDocumentStands, null);
  const r = w.reverse(assetId, d.transaction.id, { overrideProceedsCheck: true, overrideReason: 'unnötig' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.proceedsCheckOverridden, false);
  assert.doesNotMatch(w.row(r.reversalTransactionId).description, /übersteuert/);
  assert.equal(w.audits.some((e) => e.action === 'override_proceeds_check'), false);
});

test('a legacy book: an invoice whose entry a raw Storno took out (odd chain) no longer stands', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'i8' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(w.reverse(assetId, d.transaction.id, {}, 'l1').error, 'proceeds_settled');
  // Simulate the pre-ownership raw Storno: the entry is mirrored while the document row stays issued.
  const posted = w.store.db.prepare('SELECT posted_entry_id AS e FROM document WHERE id = ?').get(inv.id).e;
  const raw = reverseOwnedEntry(w.ctx, { entryId: posted, date: '2026-07-18', idempotencyKey: 'legacy-raw' }, DOCUMENT_REVERSAL_OWNER);
  assert.equal(raw.ok, true, JSON.stringify(raw));
  assert.equal(w.store.db.prepare('SELECT status FROM document WHERE id = ?').get(inv.id).status, 'issued');
  const r = w.reverse(assetId, d.transaction.id, {}, 'l2');
  assert.equal(r.ok, true, JSON.stringify(r));
});
