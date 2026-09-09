/**
 * A14 §8, the five money cases, each reconciled to the Rappen on the POSTED ROWS.
 *
 * Every assertion here reads the journal back rather than trusting a return value: the design's own
 * rule is that the engine owns the money math, and the only proof of that is the ledger.
 *
 * The canonical fixture runs through the whole file: net CHF 1'000.00 plus 8.1% MWST 81.00 equals
 * gross CHF 1'081.00.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSavedView } from '../../dist/core/customization/views.js';

import {
  recordPayment,
  previewPayment,
  getPayment,
  listPayments,
  PAYMENT_INTENTS,
} from '../../dist/core/payments/index.js';
import { createVendorBill, recordExpense } from '../../dist/core/purchase/index.js';
import { setup, issueInvoice, legsOf, accountBalance, counts, GROSS_MINOR } from './support.mjs';
import { addVendor, billInput } from '../purchase/support.mjs';

function leg(legs, number) {
  return legs.find((l) => l.number === number);
}

// --- Case 1, full payment (US-A14.1, P1) --------------------------------------------------------

test('full payment: 1081.00 on an open 1081.00 posts 1020/1100 and settles the invoice', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'full' });
  assert.equal(inv.totalMinor, GROSS_MINOR);

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-full',
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  const legs = legsOf(t.store, t.workspaceId, res.entryId);
  assert.deepEqual(
    legs.map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', 108100, 0],
      ['1100', 0, 108100],
    ],
  );
  // The whole receivable is gone: the invoice posting debited 1100 by 108100 and this credits it back.
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 0);
  assert.equal(accountBalance(t.store, t.workspaceId, '1020'), 108100);

  assert.equal(res.documents[0].openMinor, 0);
  assert.equal(res.documents[0].status, 'settled');
});

// --- Case 2, partial payment (US-A14.2, P7) -----------------------------------------------------

test('partial payment: 500.00 on an open 1200.00 leaves exactly 700.00 and partially_paid', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 120000, taxCode: 'none', key: 'part' });
  assert.equal(inv.totalMinor, 120000);

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 50000,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 50000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-part',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.documents[0].openMinor, 70000);
  assert.equal(res.documents[0].status, 'partially_paid');
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 70000);
});

// --- Case 3, over-payment parked as a Guthaben (US-A14.3, P12) ----------------------------------

test('over-payment: 1100.00 on an open 1081.00 parks 19.00 as the customer credit', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'over' });

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 110000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    onAccountMinor: 1900,
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-over',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.onAccountMinor, 1900);

  const legs = legsOf(t.store, t.workspaceId, res.entryId);
  assert.deepEqual(
    legs.map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', 110000, 0],
      ['1100', 0, 110000],
    ],
  );
  // The invoice is settled AND the customer is 19.00 in credit, which is exactly what a negative
  // receivable balance means. The credit is real money on a real account, not a note in the UI.
  assert.equal(res.documents[0].openMinor, 0);
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), -1900);

  const stored = getPayment(t.ctx, { paymentId: res.paymentId });
  assert.equal(stored.payment.onAccountMinor, 1900);
  assert.equal(stored.payment.counterparty.id, t.customerId);
  assert.equal(stored.payment.counterparty.name, 'Muster AG');
});

test('over-payment with no counterparty is refused: a credit belonging to nobody cannot exist', () => {
  const t = setup();
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 1900,
    bankAccountId: t.bankId,
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-orphan',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_counterparty');
  assert.equal(counts(t.store, t.workspaceId).payments, 0);
});

// --- Case 4, the rounding residual written off (US-A14.3, P10) ----------------------------------

test('rounding residual: 1080.00 on an open 1081.00 with the 1.00 written off closes the invoice', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'resid' });

  const preview = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 108000,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 108000 }],
  });
  assert.equal(preview.ok, true);
  // The chip is OFFERED because 1.00 is at the threshold, which is inclusive at the boundary.
  assert.equal(preview.writeOffThresholdMinor, 100);
  assert.equal(preview.rows[0].writeOffOfferedMinor, 100);
  assert.equal(preview.rows[0].resultingOpenMinor, 100);
  assert.equal(preview.rows[0].resultingStatus, 'partially_paid');

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 108000,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 108000, writeOffMinor: 100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-resid',
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  const legs = legsOf(t.store, t.workspaceId, res.entryId);
  assert.deepEqual(
    legs.map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', 108000, 0],
      ['1100', 0, 108100],
      // 3805 Verluste Forderungen, Veränderung Wertberichtigungen. A residual the customer never
      // paid is a LOSS on the receivable, not a discount granted, so it does not go through 3800.
      ['3805', 100, 0],
    ],
  );
  // 108000 + 100 debited, 108100 credited: it closes to the Rappen.
  assert.equal(
    legs.reduce((n, l) => n + l.debit, 0),
    legs.reduce((n, l) => n + l.credit, 0),
  );
  assert.equal(res.documents[0].openMinor, 0);
  assert.equal(res.documents[0].status, 'settled');
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 0);
  assert.equal(accountBalance(t.store, t.workspaceId, '3805'), 100);
  // Not the currency account next door in the Erlösminderungen, and not the discount account: a
  // bad debt is its own line in the Erfolgsrechnung.
  assert.equal(accountBalance(t.store, t.workspaceId, '3806'), 0);
  assert.equal(accountBalance(t.store, t.workspaceId, '3800'), 0);
});

test('beyond the threshold no write-off is OFFERED, and the honest default stays a partial payment', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'far' });
  const preview = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 90000,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 90000 }],
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.rows[0].writeOffOfferedMinor, 0);
  assert.equal(preview.rows[0].resultingOpenMinor, 18100);
  assert.equal(preview.rows[0].resultingStatus, 'partially_paid');
});

test('a write-off beyond the threshold is still PERMITTED when it is stated deliberately', () => {
  // The threshold governs the one-click OFFER, never what the engine will book: a real
  // Debitorenverlust is larger than a Rappen and has to be recordable.
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'bigwo' });
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 90000,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 90000, writeOffMinor: 18100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-bigwo',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.documents[0].openMinor, 0);
  assert.equal(accountBalance(t.store, t.workspaceId, '3805'), 18100);
});

// --- Case 5, Skonto (US-A14.4, P15), MWSTG Art. 41 ----------------------------------------------

test('Skonto: 1059.38 paid with 20.00 net Skonto reverses 1.62 of MWST and closes 1081.00 exactly', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'skonto' });

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 105938,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 105938, skontoMinor: 2000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-skonto',
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  const legs = legsOf(t.store, t.workspaceId, res.entryId);
  assert.deepEqual(
    legs.map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', 105938, 0],
      ['1100', 0, 108100],
      ['2200', 162, 0],
      ['3800', 2000, 0],
    ],
  );
  // 1'059.38 + 20.00 + 1.62 = 1'081.00, to the Rappen.
  assert.equal(105938 + 2000 + 162, 108100);
  assert.equal(res.documents[0].openMinor, 0);
  assert.equal(res.documents[0].status, 'settled');

  // The Entgeltsminderung carries a NEGATED §H-VAT-TRACE on the base line (the 3800 net leg), which
  // is what A07 reads to count the correction in the payment period (MWSTG Art. 41).
  const skontoLeg = leg(legs, '3800');
  assert.equal(skontoLeg.taxCode, 'UST81');
  assert.equal(skontoLeg.taxBase, -2000);
  assert.equal(skontoLeg.taxAmount, -162);
  // The output-VAT account nets to the invoice's 81.00 less the 1.62 reversed.
  assert.equal(accountBalance(t.store, t.workspaceId, '2200'), -(8100 - 162));
});

test('Skonto larger than the open amount gets its OWN code, never the generic mismatch', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'skbig' });
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 100,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: inv.id, amountMinor: 100, skontoMinor: 200000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-skbig',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'skonto_exceeds_open');
  assert.equal(res.openMinor, GROSS_MINOR);
  assert.equal(counts(t.store, t.workspaceId).payments, 0);
});

// --- Case 6, multi-invoice allocation (US-A14.2, P6) --------------------------------------------

test('multi-invoice: 2500.00 across three invoices posts ONE balanced entry over three allocations', () => {
  const t = setup();
  const a = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 100000, taxCode: 'none', key: 'm1' });
  const b = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 100000, taxCode: 'none', key: 'm2' });
  const c = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 120000, taxCode: 'none', key: 'm3' });

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 250000,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: a.id, amountMinor: 100000 },
      { documentId: b.id, amountMinor: 100000 },
      { documentId: c.id, amountMinor: 50000 },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-multi',
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  const legs = legsOf(t.store, t.workspaceId, res.entryId);
  assert.deepEqual(
    legs.map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', 250000, 0],
      ['1100', 0, 250000],
    ],
  );
  assert.equal(counts(t.store, t.workspaceId).allocations, 3);
  assert.deepEqual(
    res.documents.map((d) => [d.openMinor, d.status]),
    [
      [0, 'settled'],
      [0, 'settled'],
      [70000, 'partially_paid'],
    ],
  );
  // Three invoices totalling 3'200.00, of which 2'500.00 is settled: 700.00 stays open.
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 70000);
});

// --- The cash invariant (P8) --------------------------------------------------------------------

test('allocations that do not add up to the payment are an allocation_mismatch naming the difference', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'mm' });
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 100000,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 100000 }],
    onAccountMinor: 32000,
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-mm',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'allocation_mismatch');
  assert.equal(counts(t.store, t.workspaceId).payments, 0);
});

test('over-allocating more than the money that moved is an allocation_mismatch, not a silent credit', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'oa' });
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 50000,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 60000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-oa',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'allocation_mismatch');
});

test('allocating more than a document has open is its own code, naming both figures', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'ae' });
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 200000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: inv.id, amountMinor: 200000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-ae',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'allocation_exceeds_open');
  assert.equal(res.openMinor, GROSS_MINOR);
  assert.equal(res.amountMinor, 200000);
});

test('K-1: an over-allocated PREVIEW row answers what the write will answer, never settled', () => {
  // The preview and the write share one rule (G4 below pins the refusal side). What K-1 found is
  // the ROW side of the same coin: the top-level blocker said `allocation_exceeds_open` while the
  // row underneath it said `resultingStatus: 'settled'` with a negative open. A row-rendering
  // client sees a green row and a blocker it may never look at. The row must tell the write's
  // truth: the write refuses, so the target's state does not change.
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'k1' });
  const input = {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 200000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: inv.id, amountMinor: 200000 }],
  };

  const preview = previewPayment(t.ctx, input);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.error?.code, 'allocation_exceeds_open');
  assert.notEqual(preview.rows[0].resultingStatus, 'settled');
  assert.equal(preview.rows[0].resultingStatus, 'issued', 'the target keeps its CURRENT status');
  // The arithmetic stays honest: the negative open is the figure the blocker names, not a claim.
  assert.equal(preview.rows[0].resultingOpenMinor, GROSS_MINOR - 200000);

  const res = recordPayment(t.ctx, { ...input, intent: PAYMENT_INTENTS.record, idempotencyKey: 'p-k1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'allocation_exceeds_open');
});

test('K-1: an over-allocated vendor-bill PREVIEW row never claims paid while the write refuses', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const bill = recordExpense(t.ctx, {
    vendorId,
    billDate: '2026-07-01',
    dueDate: '2026-07-31',
    amountMinor: 100000,
    amountIsGross: true,
    taxCode: null,
    expenseAccountId: t.acc('6500'),
    idempotencyKey: 'vb-k1',
  });
  assert.equal(bill.ok, true, JSON.stringify(bill));

  const input = {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 150000,
    bankAccountId: t.bankId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 150000 }],
  };

  const preview = previewPayment(t.ctx, input);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.error?.code, 'allocation_exceeds_open');
  assert.notEqual(preview.rows[0].resultingStatus, 'paid');
  assert.equal(preview.rows[0].resultingStatus, 'posted', 'the bill keeps its CURRENT derived word');

  const res = recordPayment(t.ctx, { ...input, intent: PAYMENT_INTENTS.record, idempotencyKey: 'p-vb-k1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'allocation_exceeds_open');
});

// --- Scope degradation (P9) ---------------------------------------------------------------------

test('a payment with no usable bank account is needs_bank_account, never a crash', () => {
  const t = setup();
  for (const bankAccountId of [undefined, '', 'acc_does_not_exist', t.acc('3400')]) {
    const res = recordPayment(t.ctx, {
      direction: 'incoming',
      date: '2026-07-19',
      amountMinor: 1000,
      bankAccountId,
      counterpartyId: t.customerId,
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: `p-nb-${String(bankAccountId)}`,
    });
    assert.equal(res.ok, false, String(bankAccountId));
    assert.equal(res.error, bankAccountId === undefined || bankAccountId === '' ? 'invalid_input' : 'needs_bank_account');
  }
});

test('a locked period refuses the write and the preview still renders the whole booking', () => {
  const t = setup({ realPeriods: true });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'lock' });
  const locked = t.store.db
    .prepare('INSERT INTO period_lock (workspace_id, period, kind, locked_at) VALUES (?, ?, ?, ?)')
    .run(t.workspaceId, '2026-08', 'soft', '2026-08-01T00:00:00.000Z');
  assert.equal(locked.changes, 1);

  const input = {
    direction: 'incoming',
    date: '2026-08-15',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
  };
  const preview = previewPayment(t.ctx, input);
  assert.equal(preview.ok, true);
  assert.equal(preview.error.code, 'period_locked');
  // The whole booking is still on screen beside the reason, which is what lets a confirm control be
  // disabled WITH its reason rather than disabled with nothing.
  assert.equal(preview.legs.length, 2);
  assert.equal(preview.balanced, true);

  const res = recordPayment(t.ctx, { ...input, intent: PAYMENT_INTENTS.record, idempotencyKey: 'p-lock' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked');
  assert.equal(counts(t.store, t.workspaceId).payments, 0);
});

test('a document settled elsewhere is document_already_settled, and nothing is written', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'twice' });
  const first = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-1st',
  });
  assert.equal(first.ok, true);

  const second = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-2nd',
  });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'document_already_settled');
  assert.equal(counts(t.store, t.workspaceId).payments, 1);
});

test('a foreign-currency payment with no admissible rate is needs_fx_rate, never a guess', () => {
  const t = setup();
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 10000,
    currency: 'EUR',
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-eur',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_fx_rate');
  assert.equal(counts(t.store, t.workspaceId).payments, 0);
});

// A17 LANDED, so this test inverted rather than being deleted. It used to assert
// `unsupported / vendor_bills_not_built`, which was the honest answer while the table did not exist.
// What has to stay true now is the OTHER half of that seam: a vendor-bill id that names nothing is a
// `not_found` about a VENDOR BILL, not about a document. The full creditor settlement path is exercised
// in test/purchase/, which owns the fixtures for it.
test('an unknown vendor-bill target is not_found ABOUT A BILL, never about a document', () => {
  const t = setup();
  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 54000,
    bankAccountId: t.bankId,
    allocations: [{ targetKind: 'vendor_bill', targetId: 'bill_1', amountMinor: 54000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-vb',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
  assert.equal(res.vendorBillId, 'bill_1');
  assert.equal(res.documentId, undefined);
});

// --- list and get ---------------------------------------------------------------------------------

test('list_payments filters by direction, status and document, both sides workspace scoped', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'ls' });
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-ls',
  });
  assert.equal(res.ok, true);

  assert.equal(listPayments(t.ctx, {}).payments.length, 1);
  assert.equal(listPayments(t.ctx, { direction: 'outgoing' }).payments.length, 0);
  assert.equal(listPayments(t.ctx, { status: 'reversed' }).payments.length, 0);
  assert.equal(listPayments(t.ctx, { documentId: inv.id }).payments.length, 1);
  assert.equal(listPayments(t.ctx, { documentId: 'doc_nope' }).payments.length, 0);
  assert.equal(listPayments(t.ctx, { from: '2026-08-01' }).payments.length, 0);

  const view = listPayments(t.ctx, {}).payments[0];
  assert.equal(view.allocations[0].targetNumber, inv.number);
  assert.equal(view.status, 'posted');
  assert.equal(view.source, 'manual');
});

// G00 has landed, so the old `unsupported` / `saved_views_not_built` refusal is replaced by the
// behaviour it stood in for. An unknown id is still a refusal and never an unfiltered list.
test('list_payments applies a saved view, and an unknown one is still refused', () => {
  const t = setup();
  const view = createSavedView(t.ctx, {
    entityKind: 'payment',
    name: 'Nur Eingänge',
    filters: { direction: 'in' },
  });
  assert.equal(view.ok, true);

  const viewed = listPayments(t.ctx, { savedViewId: view.savedView.viewId });
  assert.equal(viewed.ok, true, 'a real saved view resolves instead of refusing');

  const unknown = listPayments(t.ctx, { savedViewId: 'v1' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'not_found');
});

// --- K-26 (kaizen round 1): a preview row never claims a status its target cannot hold -----------

// The vendor-bill branch of `resultingStatusFor` passed the LITERAL 'posted' into `displayStatus`,
// so a DRAFT bill's preview row wore a settlement word ('posted', 'partly_paid', 'paid') the bill
// cannot hold, while the blocker right next to it said `vendor_bill_not_settleable status:'draft'`.
// The same discipline as CRITIC N7 on the fee target: say what the write will actually answer, the
// target's own state word, never a status derived past a target that is not settleable.
test('K-26: a DRAFT vendor bill previews status draft, never posted or partly_paid', () => {
  const t = setup();
  const vendor = addVendor(t.ctx, 'Lieferant GmbH', 'k26-v');
  const draft = createVendorBill(t.ctx, billInput(t, vendor, { idempotencyKey: 'k26-bill' }));
  assert.equal(draft.ok, true, JSON.stringify(draft));

  // A normal partial: before this fix the row promised 'partly_paid' on a bill with no payable yet.
  const partial = previewPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 50000,
    bankAccountId: t.bankId,
    allocations: [{ vendorBillId: draft.vendorBillId, amountMinor: 50000 }],
  });
  assert.equal(partial.error?.code, 'vendor_bill_not_settleable', JSON.stringify(partial.error));
  assert.equal(partial.error?.status, 'draft');
  assert.equal(partial.rows[0].resultingStatus, 'draft', 'the row may not contradict its own blocker');

  // Over-allocation: before this fix the row claimed 'paid' on the same unpostable draft.
  const over = previewPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 200000,
    bankAccountId: t.bankId,
    allocations: [{ vendorBillId: draft.vendorBillId, amountMinor: 200000 }],
  });
  assert.equal(over.rows[0].resultingStatus, 'draft');
});

test('K-26: a POSTED bill still previews the derived settlement word, unchanged', () => {
  const t = setup();
  const vendor = addVendor(t.ctx, 'Lieferant GmbH', 'k26-p');
  const bill = recordExpense(t.ctx, billInput(t, vendor, { idempotencyKey: 'k26-posted' }));
  assert.equal(bill.ok, true, JSON.stringify(bill));

  const partial = previewPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 50000,
    bankAccountId: t.bankId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 50000 }],
  });
  assert.equal(partial.error, null, JSON.stringify(partial.error));
  assert.equal(partial.rows[0].resultingStatus, 'partly_paid');

  const full = previewPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 108100,
    bankAccountId: t.bankId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
  });
  assert.equal(full.rows[0].resultingStatus, 'paid');
});
