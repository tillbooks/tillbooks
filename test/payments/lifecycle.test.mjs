/**
 * The rest of a payment's life: the Ist-timing paid-portion VAT (US-A14.5), allocating a parked
 * Guthaben later (US-A14.3/P13), and correcting a payment by reversal (US-A14.8).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recordPayment,
  allocatePayment,
  reversePayment,
  previewPayment,
  getPayment,
  listPayments,
  PAYMENT_INTENTS,
} from '../../dist/core/payments/index.js';
import {
  setup,
  issueInvoice,
  legsOf,
  accountBalance,
  counts,
  GROSS_MINOR,
  NET_MINOR,
  TAX_MINOR,
} from './support.mjs';

// --- US-A14.5, the Ist paid-portion VAT ---------------------------------------------------------

test('Ist: half of a gross 1081.00 is 540.50, and it stamps base 500.00 with tax 40.50', () => {
  // The spec's own worked example said the half of 1'081.00 was 540.00, which is the arithmetic
  // this fixture corrects: half of 1'081.00 is 540.50, and only 540.50 splits into a base of
  // exactly 500.00 and a tax of exactly 40.50.
  const t = setup({ timing: 'ist' });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'ist' });
  assert.equal(inv.subtotalMinor, NET_MINOR);
  assert.equal(inv.taxMinor, TAX_MINOR);
  assert.equal(inv.totalMinor, GROSS_MINOR);

  const half = GROSS_MINOR / 2;
  assert.equal(half, 54050);

  const preview = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: half,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: half }],
  });
  assert.deepEqual(preview.istVat, { baseMinor: 50000, taxMinor: 4050, recognizedAt: '2026-07-19' });

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: half,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: half }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-ist',
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  // The stamp is on the ALLOCATION, which is what A07's Ist branch reads, and base + tax is exactly
  // the cash received: nothing is lost between the two figures.
  const alloc = getPayment(t.ctx, { paymentId: res.paymentId }).payment.allocations[0];
  assert.equal(alloc.taxBaseMinor, 50000);
  assert.equal(alloc.taxAmountMinor, 4050);
  assert.equal(alloc.recognizedAt, '2026-07-19');
  assert.equal(alloc.taxBaseMinor + alloc.taxAmountMinor, half);
  // Exactly half of the invoice's own VAT, so the unpaid half stays out of the return until it is paid.
  assert.equal(alloc.taxAmountMinor * 2, TAX_MINOR);
});

test('Soll: no Ist stamp exists at all, because VAT was recognised at issue', () => {
  const t = setup({ timing: 'soll' });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'soll' });
  const preview = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 54050,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 54050 }],
  });
  // Absent, not zero: a soll workspace has no irrelevant VAT field to render.
  assert.equal(preview.istVat, null);

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 54050,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 54050 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-soll',
  });
  const alloc = getPayment(t.ctx, { paymentId: res.paymentId }).payment.allocations[0];
  assert.equal(alloc.taxBaseMinor, null);
  assert.equal(alloc.taxAmountMinor, null);
  assert.equal(alloc.recognizedAt, null);
});

test('Ist: the paid-portion VAT over several partial payments sums to the invoice VAT exactly', () => {
  const t = setup({ timing: 'ist' });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'istsum' });
  const parts = [30000, 30000, 48100];
  let total = 0;
  for (const [i, part] of parts.entries()) {
    const res = recordPayment(t.ctx, {
      direction: 'incoming',
      date: '2026-07-19',
      amountMinor: part,
      bankAccountId: t.bankId,
      allocations: [{ documentId: inv.id, amountMinor: part }],
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: `p-istsum-${i}`,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    total += getPayment(t.ctx, { paymentId: res.paymentId }).payment.allocations[0].taxAmountMinor;
  }
  // Rounded once per allocation and summed, which is the ESTV per-rate treatment: the parts add up
  // to the whole with nothing lost and nothing invented.
  assert.equal(total, TAX_MINOR);
});

// --- US-A14.3 / P13, allocating a parked Guthaben later -----------------------------------------

test('Guthaben: a parked credit is allocated later with NO ledger effect and no second entry', () => {
  const t = setup();
  const first = issueInvoice(t.ctx, { contactId: t.customerId, key: 'gh1' });
  const later = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 50000, taxCode: 'none', key: 'gh2' });

  const paid = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 130000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: first.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-gh',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.equal(paid.onAccountMinor, 21900);

  const before = counts(t.store, t.workspaceId);
  const allocated = allocatePayment(t.ctx, {
    paymentId: paid.paymentId,
    allocations: [{ documentId: later.id, amountMinor: 21900 }],
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'a-gh',
  });
  assert.equal(allocated.ok, true, JSON.stringify(allocated));
  assert.equal(allocated.onAccountMinor, 0);
  assert.equal(allocated.entryId, paid.entryId);

  const after = counts(t.store, t.workspaceId);
  // ONE new allocation row, and not one new journal row: the money was already booked against the
  // receivable when it arrived, so allocating it records WHICH open item it settles, nothing more.
  assert.equal(after.allocations - before.allocations, 1);
  assert.equal(after.entries, before.entries);
  assert.equal(after.lines, before.lines);

  assert.equal(allocated.documents[0].openMinor, 28100);
  assert.equal(allocated.documents[0].status, 'partially_paid');
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 28100);
});

test('Guthaben: allocating more than is parked is refused, and Skonto belongs to record_payment', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 50000, taxCode: 'none', key: 'gh3' });
  const paid = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 10000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-gh3',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));

  const tooMuch = allocatePayment(t.ctx, {
    paymentId: paid.paymentId,
    allocations: [{ documentId: inv.id, amountMinor: 20000 }],
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'a-gh3',
  });
  assert.equal(tooMuch.ok, false);
  assert.equal(tooMuch.error, 'allocation_mismatch');

  const withSkonto = allocatePayment(t.ctx, {
    paymentId: paid.paymentId,
    allocations: [{ documentId: inv.id, amountMinor: 9000, skontoMinor: 1000 }],
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'a-gh4',
  });
  assert.equal(withSkonto.ok, false);
  assert.equal(withSkonto.error, 'unsupported');
  assert.equal(withSkonto.reason, 'skonto_and_write_off_belong_to_record_payment');
});

test('Guthaben: a payment with nothing parked has nothing to allocate', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'gh5' });
  const paid = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-gh5',
  });
  const res = allocatePayment(t.ctx, {
    paymentId: paid.paymentId,
    allocations: [{ documentId: inv.id, amountMinor: 1 }],
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'a-gh5',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'nothing_to_allocate');
});

// --- US-A14.8, reversal --------------------------------------------------------------------------

test('reversal: the pair nets to zero on every account and the invoice returns to its exact open', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'rev' });
  const paid = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 105938,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 105938, skontoMinor: 2000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-rev',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 0);

  const reversed = reversePayment(t.ctx, {
    paymentId: paid.paymentId,
    date: '2026-07-20',
    intent: PAYMENT_INTENTS.reverse,
    idempotencyKey: 'r-rev',
  });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));

  // Every account the payment touched is back where it was, and the invoice is fully open again.
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), GROSS_MINOR);
  assert.equal(accountBalance(t.store, t.workspaceId, '1020'), 0);
  assert.equal(accountBalance(t.store, t.workspaceId, '3800'), 0);
  assert.equal(accountBalance(t.store, t.workspaceId, '2200'), -TAX_MINOR);
  assert.equal(reversed.documents[0].openMinor, GROSS_MINOR);
  assert.equal(reversed.documents[0].status, 'issued');

  // The reversal is a NEW entry that mirrors the original; neither is deleted or edited.
  const original = legsOf(t.store, t.workspaceId, paid.entryId);
  const mirror = legsOf(t.store, t.workspaceId, reversed.reversalEntryId);
  assert.equal(original.length, mirror.length);
  for (const l of original) {
    const m = mirror.find((x) => x.number === l.number);
    assert.equal(m.debit, l.credit, `${l.number} debit/credit did not mirror`);
    assert.equal(m.credit, l.debit, `${l.number} debit/credit did not mirror`);
  }

  const view = getPayment(t.ctx, { paymentId: paid.paymentId }).payment;
  assert.equal(view.status, 'reversed');
  assert.equal(view.reversalEntryId, reversed.reversalEntryId);
  assert.equal(view.reversedAt, '2026-07-20');
  // The cross-link both ways: the payment names its reversal, and its own entry is untouched.
  assert.equal(view.journalEntryId, paid.entryId);
});

test('reversal: a second reverse is rejected and the allocations are never rewritten', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'rev2' });
  const paid = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-rev2',
  });
  const before = counts(t.store, t.workspaceId);
  assert.equal(
    reversePayment(t.ctx, { paymentId: paid.paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'r-a' }).ok,
    true,
  );
  const second = reversePayment(t.ctx, {
    paymentId: paid.paymentId,
    intent: PAYMENT_INTENTS.reverse,
    idempotencyKey: 'r-b',
  });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'already_reversed');
  // The allocation row still exists, untouched; it simply stops counting.
  assert.equal(counts(t.store, t.workspaceId).allocations, before.allocations);
});

test('reversal: after a reversal the same invoice can be settled again, cleanly', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'rev3' });
  const wrong = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 50000,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 50000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-rev3a',
  });
  assert.equal(
    reversePayment(t.ctx, { paymentId: wrong.paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'r-c' }).ok,
    true,
  );
  const right = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-rev3b',
  });
  assert.equal(right.ok, true, JSON.stringify(right));
  assert.equal(right.documents[0].openMinor, 0);
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 0);
  // Three payments' worth of history survives on disk: two payments, one of them reversed.
  assert.equal(listPayments(t.ctx, {}).payments.length, 2);
  assert.equal(listPayments(t.ctx, { status: 'reversed' }).payments.length, 1);
});

test('reversal: a locked reversal date refuses and changes nothing', () => {
  const t = setup({ realPeriods: true });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'rev4' });
  const paid = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-rev4',
  });
  t.store.db
    .prepare('INSERT INTO period_lock (workspace_id, period, kind, locked_at) VALUES (?, ?, ?, ?)')
    .run(t.workspaceId, '2026-08', 'soft', '2026-08-01T00:00:00.000Z');

  const res = reversePayment(t.ctx, {
    paymentId: paid.paymentId,
    date: '2026-08-05',
    intent: PAYMENT_INTENTS.reverse,
    idempotencyKey: 'r-d',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked');
  assert.equal(getPayment(t.ctx, { paymentId: paid.paymentId }).payment.status, 'posted');
});
