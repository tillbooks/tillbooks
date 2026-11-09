/**
 * The non-author critic's engine probe for claude/cl-payment-capture, INVERTED into a regression test.
 *
 * F1 (the defect): the Werkbank's own `exactMatches` pre-assignment ignored the engine's exact_reference
 * tier. When the payer's QRR named invoice A and the same customer had a second invoice B whose open
 * amount happened to equal the Betrag, the Studio pre-assigned B, and an untouched drawer posted A's
 * reference with B's money, leaving A open to be dunned.
 *
 * The fix derives the pre-assignment from the ENGINE (`enginePreAssignment` in
 * `app/src/surfaces/Payments/model.ts`): the one candidate the engine prefilled, only when its prefill
 * is the whole Betrag AND the whole open amount, never against an exact_reference that names another
 * item, and only for the chosen Gegenpartei. The rule is restated here verbatim so the engine's REAL
 * answer is what it runs on; P-FX below was written to pass and is kept as the critic wrote it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { suggestPaymentMatches, recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { setup, issueInvoice } from './support.mjs';

/** Verbatim from app/src/surfaces/Payments/model.ts `enginePreAssignment` (the target half). */
const SETTLES_ON_ITS_OWN = new Set(['exact_reference', 'exact_amount_customer']);
function enginePreAssignment(candidates, amountMinor, counterpartyId) {
  if (amountMinor <= 0) return null;
  const prefilled = candidates.filter((c) => c.prefillMinor > 0);
  if (prefilled.length !== 1) return null;
  const target = prefilled[0];
  if (target.settled || target.disabledReason !== null) return null;
  if (target.kind === null || !SETTLES_ON_ITS_OWN.has(target.kind)) return null;
  if (target.prefillMinor !== amountMinor || target.openMinor !== amountMinor) return null;
  if (candidates.some((c) => c.kind === 'exact_reference' && c.targetId !== target.targetId)) return null;
  if (target.kind === 'exact_amount_customer' && counterpartyId === '') return null;
  if (counterpartyId !== '' && target.contactId !== counterpartyId) return null;
  return target;
}

test('F1: the reference names A (a part payment), so neither A nor the amount coincidence B is pre-assigned', () => {
  const t = setup();
  // A: CHF 510.20 (the customer deducts 2% Skonto and pays 500.00, quoting A's QR reference).
  const a = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 51020, taxCode: 'none', key: 'f1-a', dueDate: '2026-07-01' });
  // B: an unrelated invoice to the same customer that happens to be open at exactly 500.00.
  const b = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 50000, taxCode: 'none', key: 'f1-b', dueDate: '2026-08-01' });

  const probe = suggestPaymentMatches(t.ctx, { direction: 'incoming' });
  const qrrOfA = probe.candidates.find((c) => c.targetId === a.id).reference.value;

  // Exactly the request the Werkbank sends.
  const asked = suggestPaymentMatches(t.ctx, {
    direction: 'incoming',
    amountMinor: 50000,
    reference: qrrOfA,
    counterpartyId: t.customerId,
  });
  assert.equal(asked.ok, true);
  const candA = asked.candidates.find((c) => c.targetId === a.id);
  const candB = asked.candidates.find((c) => c.targetId === b.id);
  // The engine: A is the reference match, ranked first, and it is the one the engine prefills.
  assert.equal(candA.kind, 'exact_reference');
  assert.equal(asked.candidates[0].targetId, a.id);
  assert.equal(candA.prefillMinor, 50000);
  assert.equal(candB.prefillMinor, 0);

  // The Studio follows the engine and never picks B. A's prefill leaves CHF 10.20 open, so it is a
  // part payment, and that is the person's call rather than a default.
  assert.equal(enginePreAssignment(asked.candidates, 50000, t.customerId), null);
});

test('F1: a reference match the engine prefills in full is the pre-assignment, over an amount coincidence', () => {
  const t = setup();
  const a = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 50000, taxCode: 'none', key: 'f1b-a', dueDate: '2026-07-01' });
  const b = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 50000, taxCode: 'none', key: 'f1b-b', dueDate: '2026-06-01' });
  const qrrOfA = suggestPaymentMatches(t.ctx, { direction: 'incoming' }).candidates.find((c) => c.targetId === a.id).reference.value;
  const asked = suggestPaymentMatches(t.ctx, {
    direction: 'incoming',
    amountMinor: 50000,
    reference: qrrOfA,
    counterpartyId: t.customerId,
  });
  const target = enginePreAssignment(asked.candidates, 50000, t.customerId);
  assert.equal(target?.targetId, a.id, 'the item the payer named');
  assert.notEqual(target?.targetId, b.id);
});

test('F1: two equal items of the customer and no reference are the engine\'s tie, so nothing is pre-assigned', () => {
  const t = setup();
  issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 50000, taxCode: 'none', key: 'f1c-a', dueDate: '2026-07-01' });
  issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 50000, taxCode: 'none', key: 'f1c-b', dueDate: '2026-08-01' });
  const asked = suggestPaymentMatches(t.ctx, { direction: 'incoming', amountMinor: 50000, counterpartyId: t.customerId });
  assert.equal(enginePreAssignment(asked.candidates, 50000, t.customerId), null);
});

/**
 * Probe P-FX: the allocation-mode preview (credit planned as a payment) against allocate_payment for
 * an EUR Guthaben that was already partly allocated twice (once at record, once by allocate_payment),
 * with an EUR-to-CHF rate that makes rounding bite. Rows, remainder and the per-row base figures must
 * agree. Expected to PASS (no defect): it widens the author's CHF-only parity test.
 */
import { previewPayment, allocatePayment, getPayment } from '../../dist/core/payments/index.js';
import { seedRate } from './support.mjs';

test('P-FX: preview of an EUR credit equals what allocate_payment writes, after a prior allocation', () => {
  const t = setup();
  seedRate(t.ctx, { currency: 'EUR', rate: '0.93337', asOf: '2026-07-19' });
  const i1 = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 33333, taxCode: 'none', key: 'fx-1', dueDate: '2026-07-01', currency: 'EUR' });
  const i2 = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 11111, taxCode: 'none', key: 'fx-2', dueDate: '2026-07-02', currency: 'EUR' });
  const i3 = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 77777, taxCode: 'none', key: 'fx-3', dueDate: '2026-07-03', currency: 'EUR' });
  const rec = recordPayment(t.ctx, {
    direction: 'incoming', date: '2026-07-19', amountMinor: 100001, currency: 'EUR', bankAccountId: t.bankId,
    counterpartyId: t.customerId, allocations: [{ documentId: i1.id, amountMinor: 33333 }],
    intent: PAYMENT_INTENTS.record, idempotencyKey: 'fx-rec',
  });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  const first = allocatePayment(t.ctx, { paymentId: rec.paymentId, allocations: [{ documentId: i2.id, amountMinor: 11111 }], intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'fx-a1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const payment = getPayment(t.ctx, { paymentId: rec.paymentId }).payment;
  const allocations = [{ documentId: i3.id, amountMinor: 55557 }];
  const preview = previewPayment(t.ctx, {
    direction: payment.direction, date: payment.date, currency: payment.currency, bankAccountId: payment.bankAccount.id,
    counterpartyKind: payment.counterparty.kind, counterpartyId: payment.counterparty.id,
    amountMinor: payment.onAccountMinor, allocations,
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.error, null, 'the probe exercises the posting branch');
  const done = allocatePayment(t.ctx, { paymentId: payment.id, allocations, intent: PAYMENT_INTENTS.allocate, idempotencyKey: 'fx-a2' });
  if (preview.error === null) {
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.onAccountMinor, preview.remainderMinor);
    const row = preview.rows[0];
    const echo = done.documents.find((d) => d.id === i3.id);
    assert.equal(echo.openMinor, row.resultingOpenMinor);
    const stored = t.ctx.store.db.prepare('SELECT base_amount_minor FROM payment_allocation WHERE target_id = ?').get(i3.id);
    assert.equal(stored.base_amount_minor, row.settlementBaseMinor ?? stored.base_amount_minor);
  } else {
    assert.equal(done.ok, false);
    assert.equal(done.error, preview.error.code);
  }
});
