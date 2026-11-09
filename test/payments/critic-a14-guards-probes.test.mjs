/**
 * ADOPTED AS A PERMANENT REGRESSION GATE. Originally the INDEPENDENT CRITIC PROBES for
 * `claude/a14-counterparty-guards` head a6099a5 (`docs/critique/a14-guards-critic.md`, branch
 * `claude/a14-guards-critic`, commit c108986, VERDICT: FAIL). The D80 increment tightens two
 * long-shipped A14 behaviours: X1 (`allocation_counterparty_mismatch`) and X2
 * (`allocation_direction_mismatch`, with a credit-note carve-out).
 *
 * A tightening breaks legitimate flows as easily as a loosening leaks money, so these probes attack
 * BOTH directions: the carve-out that X2 had to open, the precedence X2 was deliberately placed
 * after, the flows that must survive, and the shapes that can still reach the behaviour X1 refuses.
 *
 * THE ASSERTIONS ARE THE CRITIC'S, WITH FOUR FLIPPED. The critic's F2 finding was that X1 checked
 * only a CALLER-STATED counterparty, so omitting the field reached the exact cross-debtor settlement
 * the guard exists to refuse, and F3 (falling out of F2) was the same hole reached through the
 * credit-note carve-out. Both were fixed by checking every allocation row against the counterparty
 * IN FORCE (seeded by the caller, otherwise by the first row that supplies one) rather than only a
 * stated one. Four probes below encoded the MEASURED (defective) behaviour at head a6099a5 and are
 * flipped to the FIXED-behaviour polarity, each marked "FLIPPED (F2)" or "FLIPPED (F3)" in place,
 * pointing at the finding it closes. Every other probe is unchanged from the critic's own file and
 * still asserts exactly what it asserted at a6099a5.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordPayment, allocatePayment, previewPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { createCreditNote, issueCreditNote, transitionDocument } from '../../dist/core/sales/index.js';
import {
  setup,
  issueInvoice,
  accountBalance,
  counts,
  addCustomer,
  secondWorkspace,
  GROSS_MINOR,
} from './support.mjs';

function snapshot(t) {
  return {
    ...counts(t.store, t.workspaceId),
    receivable: accountBalance(t.store, t.workspaceId, '1100'),
    payable: accountBalance(t.store, t.workspaceId, '2000'),
  };
}

function docStatus(t, id) {
  return t.store.db
    .prepare('SELECT status FROM document WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, id).status;
}

/** An ISSUED credit note covering `invoiceId` in full. */
function issuedCreditNote(t, invoiceId, seed) {
  const created = createCreditNote(t.ctx, { fromInvoiceId: invoiceId, mode: 'full', idempotencyKey: `${seed}-cn` });
  assert.equal(created.ok, true, JSON.stringify(created));
  const issued = issueCreditNote(t.ctx, { creditNoteId: created.document.id, idempotencyKey: `${seed}-cn-i` });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return created.document.id;
}

// --- G1: the X1 guard now checks the counterparty IN FORCE, not only a stated one -------------------

test('G1: FLIPPED (F2). With NO counterpartyId stated, one payment now REFUSES to settle TWO different customers', () => {
  // At a6099a5 this was 'G1: with NO counterpartyId stated, one payment still settles TWO different
  // customers (X1 unguarded)', and it asserted `ok: true`. `statedCounterpartyId` was captured before
  // the loop and stayed null when the caller left the field out, so the guard had nothing to compare
  // against and the first row's derived contact won by default with no check on the second row. The
  // fix checks every row against the counterparty IN FORCE: null for row 0 (nothing to compare, so it
  // sets the counterparty in force same as before), then row 1's contact against row 0's, refused.
  const t = setup();
  const a = t.customerId;
  const b = addCustomer(t.ctx, 'Fremde AG', 'g1-b');
  const invA = issueInvoice(t.ctx, { contactId: a, key: 'g1-a' });
  const invB = issueInvoice(t.ctx, { contactId: b, key: 'g1-b-inv' });
  const before = snapshot(t);

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR * 2,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: invA.id, amountMinor: GROSS_MINOR },
      { documentId: invB.id, amountMinor: GROSS_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g1-pay',
  });
  assert.equal(res.ok, false, `FIXED: the unstated shape must now refuse too: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'allocation_counterparty_mismatch');
  assert.equal(res.effectiveCounterpartyId, a, 'row 0 (A\'s own invoice) set the counterparty in force');
  assert.equal(res.targetContactId, b);
  assert.deepEqual(snapshot(t), before, 'nothing written on the refused cross-debtor mix');
  assert.notEqual(docStatus(t, invB.id), 'settled', "B's invoice must not settle under a payment filed for A");
});

test("G1: FLIPPED (F2). The refusal's hint no longer names a bypass, and following it (omitting counterpartyId) is refused too", () => {
  // At a6099a5 this was "G1: the refusal's own hint reproduces the refusal's own defect, verbatim":
  // the reason string read "...drop counterpartyId and let each target choose its own, or record
  // separate payments", and doing exactly that (the SAME allocation with `counterpartyId` removed)
  // succeeded. The fix rewrote the hint to name only the real remedy, and the guard now checks the
  // counterparty in force regardless of whether the caller stated one, so the bypass is closed too.
  const t = setup();
  const a = t.customerId;
  const b = addCustomer(t.ctx, 'Fremde AG', 'g1h-b');
  const invB = issueInvoice(t.ctx, { contactId: b, key: 'g1h-b-inv' });

  const refused = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: a,
    allocations: [{ documentId: invB.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g1h-1',
  });
  assert.equal(refused.error, 'allocation_counterparty_mismatch');
  assert.doesNotMatch(
    refused.reason,
    /drop counterpartyId/,
    'the hint must never again name the bypass it once spelled out',
  );
  assert.match(refused.reason, /record separate payments/, 'the hint must name the one real remedy');

  // The old "fix": drop counterpartyId, change nothing else. This single row STILL has nothing else
  // to disagree with (it is the only allocation), so it is lawful on its own and must succeed: X1 was
  // never about refusing an unstated counterparty, only about a MISMATCHED one.
  const followed = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: invB.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g1h-2',
  });
  assert.equal(followed.ok, true, `a single-row allocation with no stated counterparty is lawful: ${JSON.stringify(followed)}`);

  // What the bypass actually needed (a SECOND row for a different debtor) is what the fix closes:
  // pinned directly here rather than only inferred, since the single-row case above still succeeds.
  const invA = issueInvoice(t.ctx, { contactId: a, key: 'g1h-a-inv' });
  const stillReached = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR * 2,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: invA.id, amountMinor: GROSS_MINOR },
      { documentId: invB.id, amountMinor: GROSS_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g1h-3',
  });
  assert.equal(stillReached.ok, false, `the two-debtor shape the hint used to open is now refused: ${JSON.stringify(stillReached)}`);
  assert.equal(stillReached.error, 'allocation_counterparty_mismatch');
});

test("G1: FLIPPED (F2). The on-account remainder is never parked under the wrong customer: the cross-debtor call is refused before any row parks", () => {
  // At a6099a5 this was "G1: an on-account remainder is parked under the FIRST row's contact, funded
  // partly by the second": a 500.00 remainder on a two-debtor payment parked under A although B's
  // cash funded part of it, which is the "credit belonging to nobody" shape P12b guards, one identity
  // along. The fix refuses the whole call before the remainder is ever computed: nothing parks.
  const t = setup();
  const a = t.customerId;
  const b = addCustomer(t.ctx, 'Fremde AG', 'g1r-b');
  const invA = issueInvoice(t.ctx, { contactId: a, key: 'g1r-a' });
  const invB = issueInvoice(t.ctx, { contactId: b, key: 'g1r-b-inv' });
  const before = snapshot(t);

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR * 2 + 50000,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: invA.id, amountMinor: GROSS_MINOR },
      { documentId: invB.id, amountMinor: GROSS_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g1r-pay',
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'allocation_counterparty_mismatch');
  assert.deepEqual(snapshot(t), before, 'no payment, no allocation, and no Guthaben parks under anyone');
});

// --- G2: what the credit-note carve-out actually admits ---------------------------------------------

test('G2: the carve-out is keyed on doc.type ALONE, and a single-debtor payout still works unstated', () => {
  const t = setup();
  const a = t.customerId;
  const b = addCustomer(t.ctx, 'Fremde AG', 'g2-b');
  const invB = issueInvoice(t.ctx, { contactId: b, key: 'g2-b-inv' });
  const cnB = issuedCreditNote(t, invB.id, 'g2');

  // Stated counterparty A: X1 catches it (the in-loop guard runs first).
  const stated = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: a,
    allocations: [{ documentId: cnB, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g2-stated',
  });
  assert.equal(stated.error, 'allocation_counterparty_mismatch');

  // Unstated, ONE row: still lawful. The carve-out verifies the document TYPE, not the payee; the
  // payee question is X1's, and with only one row there is nothing for X1 to disagree with.
  const unstated = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: cnB, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g2-unstated',
  });
  assert.equal(unstated.ok, true, JSON.stringify(unstated));
});

test("G2: FLIPPED (F3). ONE outgoing payout may NO LONGER refund TWO different debtors' credit notes in one entry", () => {
  // At a6099a5 this was "G2: ONE outgoing payout may refund TWO different debtors' credit notes in
  // one entry" and asserted `ok: true`: both rows were credit notes so X2 was satisfied row by row,
  // and X1 never fired because nothing was stated. Fixing F2 (the in-force counterparty check) closes
  // this with no separate change: row 0 (A's credit note) sets the counterparty in force, row 1 (B's)
  // is checked against it and refused, exactly as it would be for two ordinary invoices.
  const t = setup();
  const a = t.customerId;
  const b = addCustomer(t.ctx, 'Fremde AG', 'g2m-b');
  const invA = issueInvoice(t.ctx, { contactId: a, key: 'g2m-a' });
  const invB = issueInvoice(t.ctx, { contactId: b, key: 'g2m-b-inv' });
  const cnA = issuedCreditNote(t, invA.id, 'g2m-a');
  const cnB = issuedCreditNote(t, invB.id, 'g2m-b');
  const before = snapshot(t);

  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR * 2,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: cnA, amountMinor: GROSS_MINOR },
      { documentId: cnB, amountMinor: GROSS_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g2m-pay',
  });
  assert.equal(res.ok, false, `FIXED: one bank debit must not refund two unrelated customers: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'allocation_counterparty_mismatch');
  assert.deepEqual(snapshot(t), before, 'neither refund leg may post');
});

test('G2: an outgoing payment mixing a credit note with an ordinary invoice IS refused', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'g2x-inv' });
  const other = issueInvoice(t.ctx, { contactId: t.customerId, key: 'g2x-other' });
  const cn = issuedCreditNote(t, inv.id, 'g2x');
  const before = snapshot(t);

  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR * 2,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [
      { documentId: cn, amountMinor: GROSS_MINOR },
      { documentId: other.id, amountMinor: GROSS_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g2x-pay',
  });
  assert.equal(res.ok, false, `the invoice leg must not ride the credit note's exemption: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'allocation_direction_mismatch');
  assert.equal(res.expectedDirection, 'incoming');
  assert.deepEqual(snapshot(t), before, 'nothing written on the mixed refusal');
});

test('G2: a DRAFT credit note cannot be cashed out (not settleable, blocked before the carve-out pays)', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'g2d-inv' });
  const created = createCreditNote(t.ctx, { fromInvoiceId: inv.id, mode: 'full', idempotencyKey: 'g2d-cn' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const before = snapshot(t);

  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: created.document.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g2d-pay',
  });
  assert.equal(res.ok, false, `a draft credit note was cashed out: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'document_already_settled');
  assert.deepEqual(snapshot(t), before);
});

test('G2: a CANCELLED credit note cannot be cashed out either', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'g2c-inv' });
  const cn = issuedCreditNote(t, inv.id, 'g2c');
  const cancelled = transitionDocument(t.ctx, { documentId: cn, to: 'cancelled', idempotencyKey: 'g2c-cancel' });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  const before = snapshot(t);

  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: cn, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g2c-pay',
  });
  assert.equal(res.ok, false, `a cancelled credit note was cashed out: ${JSON.stringify(res)}`);
  assert.deepEqual(snapshot(t), before);
});

test('G2: the refund payout walks the credited invoice back out of `settled_by_credit` (D78 holds under X2)', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'g2s-inv' });
  const cn = issuedCreditNote(t, inv.id, 'g2s');
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 0);

  const refund = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: cn, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g2s-refund',
  });
  assert.equal(refund.ok, true, JSON.stringify(refund));
  // The receivable is live again, and the invoice must NOT still read as relieved by a credit that
  // has been cashed out: an invoice reported settled beside a live 1100 is the shape D78 exists to
  // prevent, and the carve-out would sanction it if `refreshSettledByCredit` were not re-run here.
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), GROSS_MINOR);
  assert.notEqual(docStatus(t, inv.id), 'settled', 'a cashed-out credit must not leave the invoice settled');
});

test('G2: §H-TENANT, a foreign credit note is not reachable by the carve-out', () => {
  const t = setup();
  const other = secondWorkspace(t);
  const foreignInv = issueInvoice(other.ctx, { contactId: other.customerId, key: 'g2t-inv' });
  const foreignCn = issuedCreditNote({ ...t, ctx: other.ctx }, foreignInv.id, 'g2t');
  const before = snapshot(t);

  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: foreignCn, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g2t-pay',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
  assert.deepEqual(snapshot(t), before);
});

// --- G3: precedence, the ordering X2 was deliberately placed behind ---------------------------------

test('G3: a stated `supplier` beside a document keeps A17-R1\'s own code, not X2\'s', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'g3-inv' });

  // Both wrong at once: the label says supplier (R1) AND the direction is outgoing (X2). R1 runs
  // first by construction, and its sentence is the more actionable of the two here.
  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g3-pay',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'allocation_target_side_mismatch', 'X2 must not steal R1\'s precedence');
});

test('G3: a mixed receivable/payable call keeps `mixed_allocation_targets`, not X2', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'g3m-inv' });

  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: inv.id, amountMinor: 1000 },
      { vendorBillId: 'no_such_bill', amountMinor: 1000 },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g3m-pay',
  });
  // `not_found` on the bill comes first (in-loop), which is fine: what matters is that neither the
  // mixed guard nor X2 is bypassed by the other.
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
});

test('G3: X1 and X2 wrong together on ONE row reports X1 (the in-loop guard), and writes nothing', () => {
  const t = setup();
  const a = t.customerId;
  const b = addCustomer(t.ctx, 'Fremde AG', 'g3b-b');
  const invB = issueInvoice(t.ctx, { contactId: b, key: 'g3b-inv' });
  const before = snapshot(t);

  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: a,
    allocations: [{ documentId: invB.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g3b-pay',
  });
  assert.equal(res.error, 'allocation_counterparty_mismatch');
  assert.deepEqual(snapshot(t), before);
});

// --- G4: the flows that must survive ---------------------------------------------------------------

test('G4: allocate_payment against the SAME customer\'s second invoice still works', () => {
  const t = setup();
  const first = issueInvoice(t.ctx, { contactId: t.customerId, key: 'g4-1' });
  const second = issueInvoice(t.ctx, { contactId: t.customerId, key: 'g4-2' });
  const paid = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 130000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: first.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g4-seed',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));

  const allocated = allocatePayment(t.ctx, {
    paymentId: paid.paymentId,
    allocations: [{ documentId: second.id, amountMinor: 21900 }],
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'g4-alloc',
  });
  assert.equal(allocated.ok, true, `the one-customer allocate must survive X1: ${JSON.stringify(allocated)}`);
});

test('G4: allocate_payment against ANOTHER customer\'s invoice is now refused (the conformance fixture\'s exact shape)', () => {
  const t = setup();
  const a = t.customerId;
  const b = addCustomer(t.ctx, 'Zahler AG II', 'g4x-b');
  const first = issueInvoice(t.ctx, { contactId: a, key: 'g4x-1' });
  const second = issueInvoice(t.ctx, { contactId: b, key: 'g4x-2' });
  const paid = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 130000,
    bankAccountId: t.bankId,
    counterpartyId: a,
    allocations: [{ documentId: first.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g4x-seed',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));

  const allocated = allocatePayment(t.ctx, {
    paymentId: paid.paymentId,
    allocations: [{ documentId: second.id, amountMinor: 21900 }],
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'g4x-alloc',
  });
  // This was the shape `test/api/conformance-contract.mjs:802`'s `allocate_payment` scenario used to
  // reproduce by accident (F1): two invoices seeded through `issuedInvoice(fx, 'ap1'|'ap2')`, two
  // SEPARATE contacts both named "Zahler AG". The fixture now points its second invoice at the first
  // contact instead; this probe keeps the cross-customer shape itself pinned as a refusal.
  assert.equal(allocated.ok, false, JSON.stringify(allocated));
  assert.equal(allocated.error, 'allocation_counterparty_mismatch');
});

test('G4: previewPayment refuses identically to recordPayment on both new codes', () => {
  const t = setup();
  const b = addCustomer(t.ctx, 'Fremde AG', 'g4p-b');
  const invB = issueInvoice(t.ctx, { contactId: b, key: 'g4p-b-inv' });
  const invA = issueInvoice(t.ctx, { contactId: t.customerId, key: 'g4p-a-inv' });

  const p1 = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: invB.id, amountMinor: GROSS_MINOR }],
  });
  assert.equal(p1.error, 'allocation_counterparty_mismatch');

  const p2 = previewPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: invA.id, amountMinor: GROSS_MINOR }],
  });
  assert.equal(p2.error, 'allocation_direction_mismatch');
});

test('G4: neither refusal is memoised, and the corrected input succeeds under the SAME key', () => {
  const t = setup();
  const invA = issueInvoice(t.ctx, { contactId: t.customerId, key: 'g4k-a' });

  const refused = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: invA.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g4k-1',
  });
  assert.equal(refused.error, 'allocation_direction_mismatch');

  const fixed = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: invA.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'g4k-1',
  });
  assert.equal(fixed.ok, true, `the refusal was memoised: ${JSON.stringify(fixed)}`);
});
