// F3, the money path: a merged customer's balance and aging bucket SPLIT across the tombstone.
//
// The critic's figures, which these tests reproduce: after `merge(dup -> survivor)`,
// `customer_balance(survivor)` reported 108100 while `customer_balance(dup)` reported -41900, when the
// consolidated position is 66200, and `aging_report().byCustomer` returned TWO rows, one of them under
// the retired duplicate's old name. So the operator dunned the survivor for the full invoice while the
// customer's credit sat under an id `list_contacts` deliberately hides.
//
// The A14 freeze on `payment.counterparty_id` is genuine (`payment_no_money_update`), so NOT
// re-pointing was forced and correct. The defect was that the chain walk had been added to two of
// eight readers. These tests hold the ONE shared read-side resolver, over the A14 fixture rather than
// over invented rows: an open amount written straight into a table reconciles against nothing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeContacts, getContact } from '../../dist/core/sales/index.js';
import { recordPayment, previewPayment, getPayment, listPayments, allocatePayment } from '../../dist/core/payments/index.js';
import { listOpenItems, customerBalance, agingReport } from '../../dist/core/debtors/index.js';
import { setup, addCustomer, issueInvoice, GROSS_MINOR } from '../payments/support.mjs';

/** The over-payment in the critic's reproduction: 150'000 against a 108'100 invoice parks 41'900. */
const OVERPAYMENT_MINOR = 150000;
const PARKED_MINOR = OVERPAYMENT_MINOR - GROSS_MINOR;
/** The consolidated position: one open invoice minus one parked credit. */
const CONSOLIDATED_MINOR = GROSS_MINOR - PARKED_MINOR;

/**
 * The exact world the critic measured: a duplicate holding a parked over-payment, a survivor holding
 * an open invoice, and a merge between them. The payment is recorded BEFORE the merge, because that is
 * the only way its frozen `counterparty_id` can end up naming a row that later becomes a tombstone.
 */
function splitWorld() {
  const t = setup();
  const dupId = addCustomer(t.ctx, 'Alte Firma AG', 'dup');
  const survivorId = t.customerId; // 'Muster AG'

  // The duplicate's paid invoice, over-paid so 41'900 parks as a Guthaben on the duplicate.
  const paidInvoice = issueInvoice(t.ctx, { contactId: dupId, key: 'inv-dup' });
  const payment = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: OVERPAYMENT_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: dupId,
    allocations: [{ documentId: paidInvoice.id, amountMinor: GROSS_MINOR }],
    onAccountMinor: PARKED_MINOR,
    intent: 'post_payment',
    idempotencyKey: 'pay-dup',
  });
  assert.equal(payment.ok, true, JSON.stringify(payment));

  // The survivor's open invoice.
  const openInvoice = issueInvoice(t.ctx, { contactId: survivorId, key: 'inv-surv', dueDate: '2026-08-18' });

  const merged = mergeContacts(t.ctx, { sourceId: dupId, targetId: survivorId, idempotencyKey: 'merge' });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  return { ...t, dupId, survivorId, paymentId: payment.paymentId, openInvoice, paidInvoice };
}

test('F3: the merged customer has ONE consolidated balance, not two halves', () => {
  const w = splitWorld();

  const survivor = customerBalance(w.ctx, { customerId: w.survivorId });
  assert.equal(survivor.ok, true);
  assert.equal(
    survivor.baseTotalOpenMinor,
    CONSOLIDATED_MINOR,
    'the survivor must carry the open invoice NET of the credit that arrived under the duplicate',
  );
  assert.equal(survivor.onAccountMinor, PARKED_MINOR);
  assert.equal(survivor.mergedFrom, null);

  // Asking with the RETIRED id answers the same consolidated position and says it was redirected,
  // exactly as `get_contact` does. Before the fix this reported -41900: the credit alone.
  const viaTombstone = customerBalance(w.ctx, { customerId: w.dupId });
  assert.equal(viaTombstone.customerId, w.survivorId);
  assert.equal(viaTombstone.mergedFrom, w.dupId);
  assert.equal(viaTombstone.baseTotalOpenMinor, CONSOLIDATED_MINOR);
  assert.deepEqual(viaTombstone.items, survivor.items);
  // And the redirect agrees with the one `get_contact` performs, so the two reads cannot disagree.
  assert.equal(getContact(w.ctx, { contactId: w.dupId }).contact.id, viaTombstone.customerId);
});

test('F3: aging_report().byCustomer returns ONE row, and never the retired name', () => {
  const w = splitWorld();
  const report = agingReport(w.ctx, {});
  assert.equal(report.ok, true);
  assert.equal(report.byCustomer.length, 1, JSON.stringify(report.byCustomer));
  assert.equal(report.byCustomer[0].customerId, w.survivorId);
  assert.equal(report.byCustomer[0].customerName, 'Muster AG');
  assert.equal(report.byCustomer[0].baseTotalOpenMinor, CONSOLIDATED_MINOR);
  // Two open items (the invoice and the parked credit) filed under one party.
  assert.equal(report.byCustomer[0].openItemCount, 2);
  assert.ok(
    !report.byCustomer.some((c) => c.customerName === 'Alte Firma AG'),
    'a row under an id list_contacts hides is a row nobody can act on',
  );
});

test('F3: the OP-Liste files every item under the survivor, and still reconciles to 1100', () => {
  const w = splitWorld();
  const all = listOpenItems(w.ctx, {});
  assert.equal(all.ok, true);
  assert.deepEqual([...new Set(all.items.map((i) => i.customerId))], [w.survivorId]);
  assert.equal(all.reconciled, true, JSON.stringify({ diff: all.reconciliationDifferenceMinor }));

  // Filtering by the retired id returns the survivor's items rather than nothing at all.
  const filtered = listOpenItems(w.ctx, { customerId: w.dupId });
  assert.equal(filtered.items.length, all.items.length);
  // `reconciled` still describes the WORKSPACE, which the filter must not change (A16's own rule).
  assert.equal(filtered.reconciled, true);
});

test('F3: get_payment and list_payments report the SURVIVOR, on a frozen counterparty column', () => {
  const w = splitWorld();
  // The stored column is untouched: A14's immutability trigger is intact and nothing re-pointed it.
  const stored = w.store.db
    .prepare('SELECT counterparty_id FROM payment WHERE workspace_id = ? AND id = ?')
    .get(w.workspaceId, w.paymentId);
  assert.equal(stored.counterparty_id, w.dupId, 'the append-only fact must stay exactly as posted');

  const one = getPayment(w.ctx, { paymentId: w.paymentId });
  assert.equal(one.payment.counterparty.id, w.survivorId);
  assert.equal(one.payment.counterparty.name, 'Muster AG');

  const listed = listPayments(w.ctx, {});
  const row = listed.payments.find((p) => p.id === w.paymentId);
  assert.equal(row.counterparty.id, w.survivorId);
  assert.equal(row.counterparty.name, 'Muster AG');
});

test('F3: a parked credit whose counterparty was merged is still allocatable', () => {
  const w = splitWorld();
  // The replan RESOLVES rather than refusing, or this credit could never be applied to anything.
  const allocated = allocatePayment(w.ctx, {
    paymentId: w.paymentId,
    allocations: [{ documentId: w.openInvoice.id, amountMinor: PARKED_MINOR }],
    intent: 'allocate_payment',
    idempotencyKey: 'alloc-1',
  });
  assert.equal(allocated.ok, true, JSON.stringify(allocated));
  assert.equal(allocated.onAccountMinor, 0);
  // The receivable moved by exactly the credit, and the books still tie to 1100.
  const after = listOpenItems(w.ctx, {});
  assert.equal(after.baseTotalOpenMinor, CONSOLIDATED_MINOR);
  assert.equal(after.reconciled, true);
});

test('F3: a NEW payment is refused a tombstone counterparty, in preview and in record alike', () => {
  const w = splitWorld();
  const shape = {
    direction: 'incoming',
    date: '2026-07-20',
    amountMinor: 5000,
    bankAccountId: w.bankId,
    counterpartyId: w.dupId,
    onAccountMinor: 5000,
  };

  // Refused rather than silently redirected: A14 freezes the column the instant the payment posts, so
  // a reference written now can never be corrected. The survivor is named so a retry is one call away.
  const preview = previewPayment(w.ctx, shape);
  assert.equal(preview.ok, false);
  assert.equal(preview.error, 'counterparty_merged');
  assert.equal(preview.survivorId, w.survivorId);

  const recorded = recordPayment(w.ctx, { ...shape, intent: 'post_payment', idempotencyKey: 'pay-tomb' });
  assert.equal(recorded.ok, false);
  assert.equal(recorded.error, 'counterparty_merged');
  // The preview and the record agree, which is the property that stops a surface promising a booking
  // the engine then declines.
  assert.equal(recorded.survivorId, preview.survivorId);
  // And nothing was written.
  assert.equal(
    w.store.db.prepare('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?').get(w.workspaceId).n,
    1,
  );
});

test('F3: the same payment against the SURVIVOR is accepted, so the guard is not a wall', () => {
  const w = splitWorld();
  const recorded = recordPayment(w.ctx, {
    direction: 'incoming',
    date: '2026-07-20',
    amountMinor: 5000,
    bankAccountId: w.bankId,
    counterpartyId: w.survivorId,
    onAccountMinor: 5000,
    intent: 'post_payment',
    idempotencyKey: 'pay-live',
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(listOpenItems(w.ctx, {}).reconciled, true);
});
