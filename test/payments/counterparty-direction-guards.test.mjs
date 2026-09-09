/**
 * D80: X1 and X2, the two A14-wide money-path defects the A14 fee-target critic found and proved on
 * the untouched DOCUMENT path. Findings X1/X2, baselines B3/B4, live in
 * `docs/critique/a14-fee-critic.md` and `test/payments/critic-a14-fee-findings.probe.mjs` on branch
 * `claude/a14-fee-critic`, commit 259bb7e; NEITHER file is present on this branch, so the citation is
 * by branch and sha rather than by path. Both defects predate that branch: they reproduce with no
 * dunning fee involved at all, which is why they are booked as their own increment rather than folded
 * into the fee target.
 *
 * X1: `planPayment` only ever DERIVED a counterparty from a target when the caller left it null; it
 * never checked one the caller actually STATED, so a payment naming customer A could allocate
 * against customer B's invoice.
 *
 * X2: an OUTGOING payment could "settle" an ordinary receivable while 1100 Debitoren GREW instead of
 * shrinking (`buildLegs` flips every leg for `outgoing`, so the credit that would normally reduce
 * 1100 becomes a debit). The direction and the target's own side must agree.
 *
 * Both are fixed as REFUSALS, in the idiom of the A17 critic's R1 (`allocation_target_side_mismatch`):
 * named codes, nothing written, the mismatch stated rather than silently trusted or silently dropped.
 *
 * REMEDIATED once already: the non-author guards critic (`docs/critique/a14-guards-critic.md`,
 * branch `claude/a14-guards-critic`, commit c108986) returned FAIL on the first delivery (head
 * a6099a5) for two real findings, F1 and F2 (F3 fell out of F2's fix):
 *
 *  - F1: the `allocate_payment` conformance fixture was never corrected, so the COMMITTED head left
 *    `npm test` red even though a later, uncommitted local edit made it read green. Fixed in a
 *    separate commit (`test/api/conformance-contract.mjs`); see that commit's message.
 *  - F2/F3: the X1 guard above compared a target only against a counterparty the CALLER had stated,
 *    so omitting `counterpartyId` reached the exact cross-debtor settlement it was meant to refuse,
 *    and its own hint ("drop counterpartyId") named the bypass. Fixed by checking every row against
 *    the counterparty IN FORCE (seeded by the caller, otherwise by the first row that supplies one),
 *    which also closes F3 (two different debtors' credit notes cashed out in one outgoing entry)
 *    without a separate check. The critic's own 17 probes are adopted verbatim in
 *    `test/payments/critic-a14-guards-probes.test.mjs`, with four flipped to fixed-behaviour polarity
 *    and each flip documented in place.
 *
 * This file also pins the THREE legitimate flows that were checked before tightening either guard:
 * a refund payout against a covering credit note (X2's necessary carve-out, A13/S10), on-account
 * parking with no target at all (unaffected by construction: both guards live inside the allocation
 * loop), and a counterparty that is a MERGED contact (C00's tombstone must not read as a mismatch).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordPayment, allocatePayment, previewPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { createCreditNote, issueCreditNote, mergeContacts } from '../../dist/core/sales/index.js';
import { recordExpense } from '../../dist/core/purchase/index.js';
import { setup, issueInvoice, legsOf, accountBalance, counts, addCustomer, secondWorkspace, GROSS_MINOR } from './support.mjs';
import { addVendor, billInput } from '../purchase/support.mjs';

/** Row counts across every table an A14 write can touch, restated so a refusal's "nothing written" claim is on ROWS. */
function snapshot(t) {
  const c = counts(t.store, t.workspaceId);
  return { ...c, receivable: accountBalance(t.store, t.workspaceId, '1100'), payable: accountBalance(t.store, t.workspaceId, '2000') };
}

// --- X1: the cross-debtor mix ----------------------------------------------------------------------

test('X1: a payment stated for customer A refuses to settle customer B\'s invoice', () => {
  const t = setup();
  const a = t.customerId;
  const b = addCustomer(t.ctx, 'Fremde AG', 'x1-b');
  const invB = issueInvoice(t.ctx, { contactId: b, key: 'x1-inv-b' });
  const before = snapshot(t);

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: a,
    allocations: [{ documentId: invB.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'x1-pay',
  });
  assert.equal(res.ok, false, `a payment stated for A settled B's invoice: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'allocation_counterparty_mismatch');
  assert.equal(res.effectiveCounterpartyId, a);
  assert.equal(res.targetContactId, b);
  assert.deepEqual(snapshot(t), before, 'nothing may be written on a refused counterparty mismatch');

  // The preview refuses identically: a Studio confirm dialog cannot promise a booking record_payment
  // then declines (the same discipline `counterparty_merged` and every other P7 refusal follows).
  const preview = previewPayment(t.ctx, {
    direction: 'incoming', date: '2026-07-19', amountMinor: GROSS_MINOR, bankAccountId: t.bankId,
    counterpartyKind: 'customer', counterpartyId: a,
    allocations: [{ documentId: invB.id, amountMinor: GROSS_MINOR }],
  });
  assert.equal(preview.ok, false);
  assert.equal(preview.error, 'allocation_counterparty_mismatch');
});

test('X1: FLIPPED (A14/A20 seam). X1 does NOT fire on the PAYABLE side: a vendor-bill settlement is not misallocation', () => {
  // At head 89b1557 this test asserted X1 refused "symmetrically" on a vendor-bill target, and it was
  // the AUTHOR's extrapolation of the guard to the payable side, not a critic finding: the guards
  // critic's F1/F2 and the recritic's R6 are all cross-DEBTOR cases (invoice A vs invoice B, 1100
  // Debitoren), and the critic's own 17 probes (critic-a14-guards-probes.test.mjs) are every one
  // receivable-side. The symmetry is false. On the PAYABLE side one A18 pain.001 creditor batch
  // executes as a SINGLE bank debit that legitimately settles MANY vendors' bills at once, and A20's
  // confirmCamtMatch splits that debit per bill (US-A20.5, test/banking/camt-reconciliation.test.mjs).
  // "One counterparty" is meaningless there: the batch has no single vendor, and confirmCamtMatch
  // states none, deriving one from the first row. X1 scoped to rowSide === 'receivable' leaves every
  // receivable refusal above unweakened while unblocking the creditor batch. So a payment settling a
  // vendor bill SUCCEEDS whatever the stated `counterpartyId` label reads: all vendor-bill rows book
  // to the one 2000 Kreditoren counter account, so buildLegs resolves a single coherent entry.
  const t = setup();
  const vendorA = addVendor(t.ctx, 'Lieferant A', 'x1v-a');
  const vendorB = addVendor(t.ctx, 'Lieferant B', 'x1v-b');
  const billB = recordExpense(t.ctx, billInput(t, vendorB, { idempotencyKey: 'x1v-bill' }));
  assert.equal(billB.ok, true, JSON.stringify(billB));

  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 108100,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorA,
    allocations: [{ vendorBillId: billB.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'x1v-pay',
  });
  assert.equal(res.ok, true, `a lawful vendor-bill settlement was refused: ${JSON.stringify(res)}`);
  const settled = res.vendorBills.find((b) => b.id === billB.vendorBillId);
  assert.ok(settled !== undefined, `the settled bill is reported: ${JSON.stringify(res)}`);
  assert.equal(settled.openMinor, 0, 'the vendor bill is fully settled');
  // The mirror of the receivable refusal above: recordExpense posts the bill (credits 2000 Kreditoren
  // by the gross), the settlement debits it back, so 2000 nets to zero: the bill is closed, not parked.
  assert.equal(accountBalance(t.store, t.workspaceId, '2000'), 0, '2000 Kreditoren nets to zero once the posted bill is settled');
});

test('X1: FLIPPED (A14/A20 seam). ONE outgoing debit settles TWO different vendors bills, each its own share (US-A20.5 shape)', () => {
  // The positive pin on the seam: the creditor batch X1 must not block. Two bills, two DIFFERENT
  // vendors, one outgoing payment, no stated counterparty (as confirmCamtMatch drives it). Before the
  // seam this refused with allocation_counterparty_mismatch on the second vendor's bill; it now
  // settles both, and the money path stays balanced (nothing on-account, both bills closed).
  const t = setup();
  const vendorA = addVendor(t.ctx, 'Lieferant A', 'x1b-a');
  const vendorB = addVendor(t.ctx, 'Lieferant B', 'x1b-b');
  const billA = recordExpense(t.ctx, billInput(t, vendorA, { amountMinor: 60000, idempotencyKey: 'x1b-bill-a' }));
  const billB = recordExpense(t.ctx, billInput(t, vendorB, { amountMinor: 48100, idempotencyKey: 'x1b-bill-b' }));
  assert.equal(billA.ok, true, JSON.stringify(billA));
  assert.equal(billB.ok, true, JSON.stringify(billB));

  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 108100,
    bankAccountId: t.bankId,
    allocations: [
      { vendorBillId: billA.vendorBillId, amountMinor: 60000 },
      { vendorBillId: billB.vendorBillId, amountMinor: 48100 },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'x1b-pay',
  });
  assert.equal(res.ok, true, `a two-vendor creditor batch was refused: ${JSON.stringify(res)}`);
  assert.equal(res.onAccountMinor, 0, 'the batch consumes the whole debit, nothing parks on-account');
  const closed = (id) => res.vendorBills.find((b) => b.id === id);
  assert.equal(closed(billA.vendorBillId).openMinor, 0, 'vendor A bill fully settled');
  assert.equal(closed(billB.vendorBillId).openMinor, 0, 'vendor B bill fully settled');
});

// --- X2: direction versus the target's own side -----------------------------------------------------

test('X2: an outgoing payment refuses to settle an ordinary invoice (1100 must not grow)', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'x2-inv' });
  const before = snapshot(t);

  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'x2-pay',
  });
  assert.equal(res.ok, false, `an outgoing payment "settled" a receivable: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'allocation_direction_mismatch');
  assert.equal(res.expectedDirection, 'incoming');
  assert.deepEqual(snapshot(t), before, 'nothing may be written, and 1100 must not move at all');
});

test('X2: an incoming payment refuses to settle a vendor bill (2000 must not grow)', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx, 'Lieferant GmbH', 'x2v');
  const bill = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'x2v-bill' }));
  assert.equal(bill.ok, true, JSON.stringify(bill));
  const before = snapshot(t);

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 108100,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'x2v-pay',
  });
  assert.equal(res.ok, false, `an incoming payment "settled" a payable: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'allocation_direction_mismatch');
  assert.equal(res.expectedDirection, 'outgoing');
  assert.deepEqual(snapshot(t), before);
});

// --- Legitimate flow 1: the refund payout against a covering credit note (A13/S10) ------------------

test('legitimate: a refund payout against a covering credit note still settles outgoing', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'refund-inv' });
  const created = createCreditNote(t.ctx, { fromInvoiceId: inv.id, mode: 'full', idempotencyKey: 'refund-cn' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const issued = issueCreditNote(t.ctx, { creditNoteId: created.document.id, idempotencyKey: 'refund-cn-i' });
  assert.equal(issued.ok, true, JSON.stringify(issued));

  const receivableAfterCredit = accountBalance(t.store, t.workspaceId, '1100');
  assert.equal(receivableAfterCredit, 0, 'the credit note already relieved the receivable at issuance');

  const refund = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: t.customerId,
    allocations: [{ documentId: created.document.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'refund-pay',
  });
  assert.equal(refund.ok, true, `X2 must not break the refund payout carve-out: ${JSON.stringify(refund)}`);
  // Cashing the credit out re-opens the receivable it had covered: exactly the S10 shape.
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), GROSS_MINOR);
});

test('legitimate: an incoming payment against a credit note has no ledger meaning and is refused', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'refund-inv-2' });
  const created = createCreditNote(t.ctx, { fromInvoiceId: inv.id, mode: 'full', idempotencyKey: 'refund-cn-2' });
  const issued = issueCreditNote(t.ctx, { creditNoteId: created.document.id, idempotencyKey: 'refund-cn-2-i' });
  assert.equal(issued.ok, true, JSON.stringify(issued));

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: t.customerId,
    allocations: [{ documentId: created.document.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'refund-pay-2',
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'allocation_direction_mismatch');
  assert.equal(res.expectedDirection, 'outgoing');
});

// --- Legitimate flow 2: on-account parking with no target, in either direction ----------------------

test('legitimate: an on-account credit with NO allocations posts in either direction, both guards untouched', () => {
  const t = setup();
  const other = addCustomer(t.ctx, 'Andere AG', 'onacct-other');

  const incoming = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 50000,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: t.customerId,
    allocations: [],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'onacct-in',
  });
  assert.equal(incoming.ok, true, JSON.stringify(incoming));

  // A REFUND parked against a DIFFERENT customer with no allocation yet: the exact fixture the A17
  // critic's F1 pins as legitimate (outgoing, on-account, no target at all).
  const outgoing = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 30000,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: other,
    allocations: [],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'onacct-out',
  });
  assert.equal(outgoing.ok, true, JSON.stringify(outgoing));
});

// --- Legitimate flow 3: a merged contact must not read as a counterparty mismatch (C00) -------------

test('legitimate: a merge tombstone on a vendor bill is not read as a counterparty mismatch (X1)', () => {
  const t = setup();
  const vendorOld = addVendor(t.ctx, 'Alt-Lieferant GmbH', 'merge-old');
  const vendorNew = addVendor(t.ctx, 'Neu-Lieferant GmbH', 'merge-new');
  // The bill posts against the OLD (pre-merge) vendor id. `vendor_bill.contact_id` is not one of
  // C00's re-point FKs (MERGE_REPOINT_FKS in `contactMerge.ts` lists `document`, `contact_activity`
  // and `contact` only), so this row keeps pointing at the tombstone after the merge below.
  const bill = recordExpense(t.ctx, billInput(t, vendorOld, { idempotencyKey: 'merge-bill' }));
  assert.equal(bill.ok, true, JSON.stringify(bill));

  const merged = mergeContacts(t.ctx, { sourceId: vendorOld, targetId: vendorNew, idempotencyKey: 'merge-1' });
  assert.equal(merged.ok, true, JSON.stringify(merged));

  // The caller states the SURVIVOR: a new payment naturally reads the vendor's current identity.
  const pay = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 108100,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorNew,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'merge-pay',
  });
  assert.equal(pay.ok, true, `a merge tombstone was read as a counterparty mismatch: ${JSON.stringify(pay)}`);
  assert.ok(legsOf(t.store, t.workspaceId, pay.entryId).some((l) => l.number === '2000' && l.debit === 108100));
});

// --- Mixed-call atomicity: one bad leg writes NEITHER leg --------------------------------------------

test('atomicity: X1 on the SECOND leg of a mixed call writes neither leg', () => {
  const t = setup();
  const a = t.customerId;
  const b = addCustomer(t.ctx, 'Fremde AG', 'mix-x1-b');
  const invA = issueInvoice(t.ctx, { contactId: a, key: 'mix-x1-a' });
  const invB = issueInvoice(t.ctx, { contactId: b, key: 'mix-x1-b' });
  const before = snapshot(t);

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR * 2,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: a,
    allocations: [
      { documentId: invA.id, amountMinor: GROSS_MINOR },
      { documentId: invB.id, amountMinor: GROSS_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'mix-x1-pay',
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'allocation_counterparty_mismatch');
  assert.deepEqual(snapshot(t), before, 'the GOOD leg (A\'s own invoice) must not post either');
});

test('atomicity: X2 on the SECOND leg of a mixed direction call writes neither leg', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'mix-x2-inv' });
  const created = createCreditNote(t.ctx, { fromInvoiceId: inv.id, mode: 'full', idempotencyKey: 'mix-x2-cn' });
  const issued = issueCreditNote(t.ctx, { creditNoteId: created.document.id, idempotencyKey: 'mix-x2-cn-i' });
  assert.equal(issued.ok, true, JSON.stringify(issued));

  // A second, ORDINARY invoice for the same customer, mixed into the same outgoing call as the
  // credit note refund: the credit note leg alone would be lawful, the invoice leg never is.
  const inv2 = issueInvoice(t.ctx, { contactId: t.customerId, key: 'mix-x2-inv2' });
  const before = snapshot(t);

  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR * 2,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: t.customerId,
    allocations: [
      { documentId: created.document.id, amountMinor: GROSS_MINOR },
      { documentId: inv2.id, amountMinor: GROSS_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'mix-x2-pay',
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'allocation_direction_mismatch');
  assert.deepEqual(snapshot(t), before, 'the refund-payout leg must not post either');
});

// --- Replay: a refusal is never memoised --------------------------------------------------------------

test('replay: an X1 refusal is never memoised, and the SAME key succeeds once the input is fixed', () => {
  const t = setup();
  const a = t.customerId;
  const b = addCustomer(t.ctx, 'Fremde AG', 'replay-b');
  const invB = issueInvoice(t.ctx, { contactId: b, key: 'replay-inv-b' });

  const bad = () =>
    recordPayment(t.ctx, {
      direction: 'incoming',
      date: '2026-07-19',
      amountMinor: GROSS_MINOR,
      bankAccountId: t.bankId,
      counterpartyKind: 'customer',
      counterpartyId: a,
      allocations: [{ documentId: invB.id, amountMinor: GROSS_MINOR }],
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: 'replay-key',
    });

  const first = bad();
  const second = bad();
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.deepEqual(first, second, 'two identical refused calls must answer identically, not diverge on a stale memo');
  assert.equal(counts(t.store, t.workspaceId).payments, 0, 'a refusal must never consume the idempotency key');

  // The SAME key, now naming B's own invoice: if the refusal had been memoised this would replay
  // the ORIGINAL rejection instead of posting.
  const fixed = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: b,
    allocations: [{ documentId: invB.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'replay-key',
  });
  assert.equal(fixed.ok, true, `the earlier refusal was memoised and blocked a corrected retry: ${JSON.stringify(fixed)}`);
  assert.equal(counts(t.store, t.workspaceId).payments, 1);
});

// --- §H-TENANT ------------------------------------------------------------------------------------

test('§H-TENANT: a counterparty id from another workspace is refused, never matched into a local target', () => {
  const t = setup();
  // A second workspace INSIDE THE SAME DATABASE (`secondWorkspace`, sharing `t.deps.ids`): the only
  // shape in which this claim means anything, per the file's own docblock. Two independent `setup()`
  // calls each start their own id sequence from scratch and would mint the SAME id twice, which
  // proves nothing about scoping and once silently passed this test for the wrong reason.
  const other = secondWorkspace(t);
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'tenant-inv' });

  // `other.customerId` names a real, live contact, just not in THIS workspace.
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: other.customerId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'tenant-pay',
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'invalid_reference', 'a foreign counterparty id must be refused, not silently matched');
});

test('§H-TENANT: the direction guard reads only THIS workspace\'s own vendor bill', () => {
  const t = setup();
  const other = secondWorkspace(t);
  const vendorId = addVendor(t.ctx, 'Lieferant GmbH', 'tenant-v');
  const otherVendorId = addVendor(other.ctx, 'Fremder Lieferant GmbH', 'tenant-v-2');
  const bill = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'tenant-bill' }));
  const otherBill = recordExpense(other.ctx, billInput(other, otherVendorId, { idempotencyKey: 'tenant-bill-2' }));
  assert.equal(bill.ok, true, JSON.stringify(bill));
  assert.equal(otherBill.ok, true, JSON.stringify(otherBill));

  // A same-shaped, correctly-directed payment in EACH workspace succeeds independently: the guard's
  // own reads (`readTarget`, `resolveContactRef`) stay scoped to `ctx.workspaceId` throughout.
  const here = recordPayment(t.ctx, {
    direction: 'outgoing', date: '2026-07-19', amountMinor: 108100, bankAccountId: t.bankId,
    counterpartyKind: 'supplier', counterpartyId: vendorId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.record, idempotencyKey: 'tenant-pay-here',
  });
  const there = recordPayment(other.ctx, {
    direction: 'outgoing', date: '2026-07-19', amountMinor: 108100, bankAccountId: other.bankId,
    counterpartyKind: 'supplier', counterpartyId: otherVendorId,
    allocations: [{ vendorBillId: otherBill.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.record, idempotencyKey: 'tenant-pay-there',
  });
  assert.equal(here.ok, true, JSON.stringify(here));
  assert.equal(there.ok, true, JSON.stringify(there));

  // And a bill id that only exists in the OTHER workspace is `not_found` here, never resolved.
  const cross = recordPayment(t.ctx, {
    direction: 'outgoing', date: '2026-07-19', amountMinor: 108100, bankAccountId: t.bankId,
    counterpartyKind: 'supplier', counterpartyId: vendorId,
    allocations: [{ vendorBillId: otherBill.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.record, idempotencyKey: 'tenant-pay-cross',
  });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, 'not_found');
});

// --- allocatePayment: the same two guards apply on the replan path too -----------------------------

test('allocatePayment: X2 refuses an allocate-time direction mismatch exactly as record-time does', () => {
  const t = setup();
  const other = addCustomer(t.ctx, 'Andere AG', 'alloc-x2-other');
  // Parked OUTGOING, no target yet: F1's own shape, still lawful (on-account, no rows, X2 never runs).
  const parked = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: other,
    allocations: [],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'alloc-x2-park',
  });
  assert.equal(parked.ok, true, JSON.stringify(parked));

  // Later, allocate that parked OUTGOING credit against an ORDINARY invoice: X2 must refuse it on
  // the replan path exactly as it refuses at record time, because `allocatePayment` re-plans through
  // the same `planPayment`.
  const inv = issueInvoice(t.ctx, { contactId: other, key: 'alloc-x2-inv' });
  const alloc = allocatePayment(t.ctx, {
    paymentId: parked.paymentId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'alloc-x2-alloc',
  });
  assert.equal(alloc.ok, false, JSON.stringify(alloc));
  assert.equal(alloc.error, 'allocation_direction_mismatch');
});
