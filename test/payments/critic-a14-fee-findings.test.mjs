/**
 * THE NON-AUTHOR CRITIC'S ADVERSARIAL SUITE for the A14 `dunning_fee` allocation target, ADOPTED as
 * a permanent gate (D59: a wave closes with no critic FAIL outstanding). Originally written against
 * branch head `64bc4fa` on `claude/a14-fee-critic` (`docs/critique/a14-fee-critic.md`), renamed from
 * `.probe.mjs` to `.test.mjs` here so it runs inside `npm test` and the two defects it found cannot
 * come back silently.
 *
 * Refute-by-default: every assertion is about ROWS, the 1100 reconciliation, or a refusal code,
 * never about a return value on its own. The cases the author's own `dunning-fee-target.test.mjs`
 * already covers are NOT repeated; what is here is the ground it did not walk: the fee's own
 * lifecycle against the ledger, the regrouped side guard's new mixing surface, the cross-debtor and
 * cross-side pairings, and the composition with D78/D79.
 *
 * WHAT CHANGED TO MAKE THIS FILE PASS, AND WHAT DID NOT (every flip, as the remediation brief asked
 * for, including the flips that turned out not to be needed):
 *
 *  - **C1 fixed** in `readTarget`'s `dunning_fee` branch (`src/core/payments/payment.ts`): settleable
 *    now comes from ONE shared "is this fee live" predicate, `readLiveDunningFeeItem`
 *    (`src/core/dunning/reads.ts`), the same one `openItems.ts`'s `dunningFeesAsOf` already used, in
 *    place of `fee_booked = 1` alone. Evaluated as of TODAY (`ctx.clock.now()`), never the payment's
 *    own `date`: a document or a vendor bill is judged on its CURRENT status, never on the payment's
 *    own (possibly backdated) date, and this keeps a fee target on the same rule rather than
 *    inventing a second kind of date-scoping A14 has never had.
 *  - **C2 fixed** in `collectOpenItems` (`src/core/debtors/openItems.ts`): a settlement whose fee
 *    is no longer live now surfaces as its own NEGATIVE `on_account` row (`orphanedSettlements`,
 *    the mirror of the existing orphan-fee-row loop) instead of being dropped, so the cash a
 *    customer actually sent keeps its place in the reconciliation even after the fee's own booking
 *    entry is reversed out from under an already-settled claim.
 *  - **NO ASSERTION IN THIS FILE NEEDED ITS POLARITY FLIPPED.** The critic wrote every C1/C2 case
 *    (`P1`, `P2`, `C2b`, and the cases downstream of the same seam, `P11`, `P12`, `P16`) asserting
 *    the CORRECT, desired behaviour from the start (refute-by-default: assert what should be true,
 *    watch it fail), so fixing the engine was what needed to change, never the test. All 18 cases
 *    that are not `P3`/`P4`/`B3`/`B4` pass unmodified against the fix.
 *  - **`P3`, `P4`, `B3`, `B4` (X1/X2) are SKIPPED, not fixed, not deleted.** They encode two
 *    pre-existing A14-wide holes the critic found while attacking this target and explicitly did NOT
 *    charge to it (both reproduce identically on the untouched `document` path, proven by their own
 *    `B3`/`B4` baselines): a payment may settle a DIFFERENT customer's position (X1), and an
 *    OUTGOING payment "settles" a receivable while 1100 grows instead of shrinking (X2). The
 *    orchestrator booked X1/X2 as their own increment on 31.07.2026, explicitly not this branch's to
 *    fix, so these four stay adopted (visible, reasoned, re-enabled by that increment) rather than
 *    silently dropped, which is exactly what the critic's own report asked for: "re-pointed... or
 *    lifted out... before the rename: they are true statements about the engine today and will
 *    fail."
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recordPayment,
  allocatePayment,
  reversePayment,
  previewPayment,
  PAYMENT_INTENTS,
} from '../../dist/core/payments/index.js';
import { setDunningConfig, proposeDunningRun, issueDunningRun } from '../../dist/core/dunning/index.js';
import { listOpenItems } from '../../dist/core/debtors/index.js';
import { setCreditorProfile } from '../../dist/core/setup/index.js';
import { reverseEntry } from '../../dist/core/ledger/index.js';
import { transitionDocument, createCreditNote, issueCreditNote, createContact } from '../../dist/core/sales/index.js';
import { recordExpense } from '../../dist/core/purchase/index.js';
import { setup, issueInvoice, legsOf, accountBalance, counts, addCustomer, secondWorkspace, GROSS_MINOR } from './support.mjs';

const FEE_MINOR = 2000;

/**
 * X1/X2: two pre-existing A14-wide holes, neither caused nor fixed by the `dunning_fee` target
 * (each reproduces identically on the untouched `document` path; see the `B3`/`B4` baselines in
 * this same file). Booked by the orchestrator as their own increment on 31.07.2026. These four
 * cases stay adopted and SKIPPED, not deleted, so the gap is visible and reasoned rather than
 * silently dropped, and re-enabling them is the acceptance test for that future increment.
 */
const X1_X2_SKIP =
  'X1/X2 (pre-existing A14-wide gap, not this branch\'s): booked as its own increment, see docs/critique/a14-fee-critic.md §4';

function world(key, opts = {}) {
  const t = setup(opts);
  const creditor = setCreditorProfile(t.ctx, {
    creditorName: 'Muster Grafik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  assert.equal(creditor.ok, true, JSON.stringify(creditor));
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, dueDate: '2026-06-01', key });
  const cfg = setDunningConfig(t.ctx, {
    levels: [
      { level: 1, daysOverdue: 10, feeMinor: FEE_MINOR, bookFee: true, feeIncomeAccountId: t.acc('3200') },
      { level: 2, daysOverdue: 20, feeMinor: 0 },
      { level: 3, daysOverdue: 30, feeMinor: 0 },
    ],
    idempotencyKey: `${key}-cfg`,
  });
  assert.equal(cfg.ok, true, JSON.stringify(cfg));
  const proposed = proposeDunningRun(t.ctx, { idempotencyKey: `${key}-propose` });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const issued = issueDunningRun(t.ctx, { runId: proposed.runId, confirmed: true, idempotencyKey: `${key}-issue` });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  const item = issued.items.find((i) => i.documentId === inv.id);
  assert.ok(item !== undefined && item.feeBooked === true, JSON.stringify(issued.items));
  const feeEntryId = t.store.db
    .prepare('SELECT fee_entry_id FROM dunning_run WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, proposed.runId).fee_entry_id;
  assert.ok(typeof feeEntryId === 'string', 'the run must carry a fee entry');
  return { t, inv, feeId: item.id, runId: proposed.runId, feeEntryId };
}

function open(t, asOf) {
  const r = listOpenItems(t.ctx, asOf === undefined ? {} : { asOf });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

/** The one invariant that matters: the OP-Liste's workspace base total equals the 1100 ledger. */
function assertReconciles(t, label) {
  const o = open(t);
  assert.equal(
    o.reconciled,
    true,
    `${label}: OP-Liste ${o.workspaceBaseTotalOpenMinor} vs 1100 ${accountBalance(t.store, t.workspaceId, '1100')} ` +
      `(difference ${o.reconciliationDifferenceMinor})`,
  );
  return o;
}

// --- P1: a fee whose own entry has been REVERSED is still offered as settleable -------------------

test('P1: a fee whose fee ENTRY was reversed must not still be settleable', () => {
  const { t, feeId, feeEntryId } = world('p1');
  assertReconciles(t, 'p1 before');

  // A15's own stated remedy for a residual fee: reverse the fee entry. 1100 gives the fee back.
  const rev = reverseEntry(t.ctx, { entryId: feeEntryId, date: '2026-07-18', idempotencyKey: 'p1-rev' });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  const afterReversal = assertReconciles(t, 'p1 after fee reversal');
  assert.equal(
    afterReversal.items.reduce((n, i) => n + i.dunningFeeMinor, 0),
    0,
    'the OP-Liste must no longer carry the reversed fee',
  );
  const ledgerBefore = accountBalance(t.store, t.workspaceId, '1100');

  // THE CLAIM: there is nothing left on 1100 to settle, so a payment naming this fee must refuse.
  const pay = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId: feeId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p1-pay',
  });
  assert.equal(
    accountBalance(t.store, t.workspaceId, '1100'),
    ledgerBefore - (pay.ok ? FEE_MINOR : 0),
    'sanity: what the posting did to 1100',
  );
  assert.equal(pay.ok, false, `a reversed fee was settled again: ${JSON.stringify(pay)}`);
  assertReconciles(t, 'p1 after the refused payment');
});

// --- P2: reversing the fee entry AFTER it has been settled ----------------------------------------

test('P2: a fee entry reversed AFTER its settlement leaves the OP-Liste reconciled', () => {
  const { t, feeId, feeEntryId } = world('p2');
  const pay = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-17',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId: feeId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p2-pay',
  });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  assertReconciles(t, 'p2 after the fee settled');

  // A15 §4's stated remedy, applied to a fee the customer has already PAID. Whatever the engine
  // decides here, the OP-Liste must not silently stop tying to 1100.
  const rev = reverseEntry(t.ctx, { entryId: feeEntryId, date: '2026-07-18', idempotencyKey: 'p2-rev' });
  if (rev.ok) assertReconciles(t, 'p2 after reversing a SETTLED fee');
  else assert.equal(rev.ok, false, `refused, which is also an answer: ${JSON.stringify(rev)}`);
});

// --- P3: the cross-debtor mix --------------------------------------------------------------------

test('P3 (PRE-EXISTING, see B3): one payment settles customer A\'s invoice and customer B\'s Mahngebühr', { skip: X1_X2_SKIP }, () => {
  const { t, inv, feeId } = world('p3');
  const other = addCustomer(t.ctx, 'Fremde AG', 'p3-other');
  const otherInv = issueInvoice(t.ctx, { contactId: other, key: 'p3-other-inv' });

  const pay = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR + FEE_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: other,
    // The OTHER customer's invoice, plus the FIRST customer's fee.
    allocations: [
      { documentId: otherInv.id, amountMinor: GROSS_MINOR },
      { dunningItemId: feeId, amountMinor: FEE_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p3-pay',
  });
  assert.equal(pay.ok, false, `one payment settled two different debtors' positions: ${JSON.stringify(pay)}`);
  assert.ok(inv.id.length > 0);
});

// --- P4: an OUTGOING payment naming a fee ---------------------------------------------------------

test('P4 (PRE-EXISTING, see B4): an outgoing payment naming a dunning fee moves 1100 the wrong way', { skip: X1_X2_SKIP }, () => {
  const { t, feeId } = world('p4');
  const before = accountBalance(t.store, t.workspaceId, '1100');
  const pay = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId: feeId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p4-pay',
  });
  if (pay.ok) {
    const legs = legsOf(t.store, t.workspaceId, pay.entryId);
    const after = accountBalance(t.store, t.workspaceId, '1100');
    assert.equal(
      after,
      before,
      `an outgoing "settlement" of a fee moved 1100 the WRONG way (${before} -> ${after}): ${JSON.stringify(legs)}`,
    );
  }
  assertReconciles(t, 'p4 after an outgoing fee allocation');
});

// --- P5 / P6 / P7: the regrouped side guard's NEW surface -----------------------------------------

test('P5: a stated `supplier` beside a dunning fee refuses, exactly as beside a document (R1)', () => {
  const { t, feeId } = world('p5');
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: t.customerId,
    allocations: [{ dunningItemId: feeId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p5-pay',
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'allocation_target_side_mismatch');
  assert.equal(res.targetKind, 'dunning_fee');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?').get(t.workspaceId).n, 0);
  assertReconciles(t, 'p5');
});

test('P6: a payment whose entry cleared 2000 may NOT be allocated to a dunning fee', () => {
  const { t, feeId } = world('p6');
  // A parked OUTGOING supplier payment: the entry debits 2000 Kreditoren.
  const supplier = addCustomer(t.ctx, 'Lieferant AG', 'p6-sup');
  const pay = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-05',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: supplier,
    allocations: [],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p6-pay',
  });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  assert.ok(legsOf(t.store, t.workspaceId, pay.entryId).some((l) => l.number === '2000' && l.debit === FEE_MINOR));

  const alloc = allocatePayment(t.ctx, {
    paymentId: pay.paymentId,
    allocations: [{ dunningItemId: feeId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'p6-alloc',
  });
  assert.equal(alloc.ok, false, `a receivable-side fee was settled out of a 2000 entry: ${JSON.stringify(alloc)}`);
  assert.equal(alloc.error, 'allocation_target_side_mismatch');
  assertReconciles(t, 'p6');
});

test('P7: a vendor bill and a dunning fee in ONE payment is still refused', () => {
  const { t, feeId } = world('p7');
  const vendor = createContact(t.ctx, { partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: 'p7-v' }).contact.id;
  const bill = recordExpense(t.ctx, {
    vendorId: vendor,
    billDate: '2026-07-01',
    dueDate: '2026-07-31',
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: t.acc('6500'),
    idempotencyKey: 'p7-bill',
  });
  assert.equal(bill.ok, true, JSON.stringify(bill));
  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 108100 + FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [
      { vendorBillId: bill.vendorBillId, amountMinor: 108100 },
      { dunningItemId: feeId, amountMinor: FEE_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p7-pay',
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'mixed_allocation_targets');
  // The refusal writes ZERO rows: the mixed-target guard runs before anything posts. The counterparty
  // guard would also have refused (a payable and a receivable have different debtors), so the reorder
  // that lets `mixed_allocation_targets` win never opened a write path this row-count would miss.
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?').get(t.workspaceId).n, 0);
  assertReconciles(t, 'p7');
});

// --- P8: the half-valid mixed call ----------------------------------------------------------------

test('P8: a mixed call whose FEE leg over-allocates writes neither leg', () => {
  const { t, inv, feeId } = world('p8');
  const before = counts(t.store, t.workspaceId);
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR + FEE_MINOR + 500,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: inv.id, amountMinor: GROSS_MINOR },
      { dunningItemId: feeId, amountMinor: FEE_MINOR + 500 },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p8-pay',
  });
  assert.equal(res.ok, false, `the fee leg exceeded its open amount and the call still posted: ${JSON.stringify(res)}`);
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a refused mixed call wrote rows');
  assertReconciles(t, 'p8');
});

test('P8b: a mixed call whose FEE leg names an unknown id writes neither leg', () => {
  const { t, inv } = world('p8b');
  const before = counts(t.store, t.workspaceId);
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR + FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: inv.id, amountMinor: GROSS_MINOR },
      { dunningItemId: 'no-such-fee', amountMinor: FEE_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p8b-pay',
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'not_found');
  assert.equal(res.dunningItemId, 'no-such-fee', 'the refusal must name the FEE field, not documentId');
  assert.deepEqual(counts(t.store, t.workspaceId), before);
});

// --- P9 / P10: double- and over-allocation of one fee ---------------------------------------------

test('P9: the same fee may not be settled twice across two payments', () => {
  const { t, feeId } = world('p9');
  const first = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId: feeId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p9-a',
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId: feeId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p9-b',
  });
  assert.equal(second.ok, false, `a fee was settled twice: ${JSON.stringify(second)}`);
  assertReconciles(t, 'p9');
});

test('P10: a single over-allocation of a fee is refused and nothing posts', () => {
  const { t, feeId } = world('p10');
  const before = counts(t.store, t.workspaceId);
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR * 2,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId: feeId, amountMinor: FEE_MINOR * 2 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p10-pay',
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.deepEqual(counts(t.store, t.workspaceId), before);
  assertReconciles(t, 'p10');
});

// --- P11: the orphan fee (the invoice cancelled under a settled fee) -------------------------------

test('P11: an invoice cancelled under a SETTLED fee keeps the OP-Liste tied to 1100', () => {
  const { t, inv, feeId } = world('p11');
  const pay = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-17',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId: feeId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p11-pay',
  });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  assertReconciles(t, 'p11 fee settled');

  const cancelled = transitionDocument(t.ctx, { documentId: inv.id, to: 'cancelled', idempotencyKey: 'p11-cancel' });
  if (cancelled.ok) {
    const o = assertReconciles(t, 'p11 after the invoice was cancelled');
    const feeRows = o.items.filter((i) => i.dunningFeeMinor !== 0);
    assert.equal(
      feeRows.reduce((n, i) => n + i.dunningFeeMinor, 0),
      0,
      `the SETTLED fee reappeared as an orphan claim after the invoice was cancelled: ${JSON.stringify(feeRows)}`,
    );
  }
});

// --- P12: D78/D79 composition ---------------------------------------------------------------------

test('P12: an invoice relieved by payment PLUS credit, carrying a fee, still reconciles', () => {
  const { t, inv, feeId } = world('p12');
  // Half the invoice in cash, plus the whole fee, in one payment.
  const pay = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-17',
    amountMinor: 54050 + FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: inv.id, amountMinor: 54050 },
      { dunningItemId: feeId, amountMinor: FEE_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p12-pay',
  });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  assertReconciles(t, 'p12 half paid, fee settled');

  // The rest as a credit note against the same invoice (D79: bounds against the supply).
  const created = createCreditNote(t.ctx, { fromInvoiceId: inv.id, idempotencyKey: 'p12-cn' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const issued = issueCreditNote(t.ctx, { creditNoteId: created.document.id, idempotencyKey: 'p12-cn-issue' });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  const o = assertReconciles(t, 'p12 after the credit');
  const row = o.items.find((i) => i.documentId === inv.id && i.direction === 'incoming');
  assert.ok(row === undefined || row.dunningFeeMinor === 0, `the settled fee is still counted: ${JSON.stringify(row)}`);
});

// --- P13: a write-off against a Mahngebühr ---------------------------------------------------------

test('P13: a write-off offered on a fee row is one the engine will actually accept', () => {
  const { t, feeId } = world('p13');
  const preview = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR - 100,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId: feeId, amountMinor: FEE_MINOR - 100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p13-preview',
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const offered = preview.rows[0].writeOffOfferedMinor;
  if (offered > 0) {
    const res = recordPayment(t.ctx, {
      direction: 'incoming',
      date: '2026-07-19',
      amountMinor: FEE_MINOR - 100,
      bankAccountId: t.bankId,
      allocations: [{ dunningItemId: feeId, amountMinor: FEE_MINOR - 100, writeOffMinor: offered }],
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: 'p13-pay',
    });
    assert.equal(res.ok, true, `the preview offered a write-off the record refused: ${JSON.stringify(res)}`);
    assertReconciles(t, 'p13 after a written-off fee');
  }
});

// --- P14: §H-TENANT on the new netting read --------------------------------------------------------

test('P14: a second tenant\'s fee settlement never nets against this tenant\'s fee', () => {
  const { t, feeId } = world('p14');
  const second = secondWorkspace(t);
  // The neighbour tries to settle OUR fee id out of its own workspace.
  const res = recordPayment(second.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: second.bankId,
    allocations: [{ dunningItemId: feeId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p14-pay',
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'not_found');
  const o = assertReconciles(t, 'p14');
  assert.equal(o.items.reduce((n, i) => n + i.dunningFeeMinor, 0), FEE_MINOR, 'our fee must still be open');
});

// --- P15: an explicit targetKind with no alias field ----------------------------------------------

test('P15: `targetKind: dunning_fee` with a raw targetId behaves exactly as the alias does', () => {
  const { t, feeId } = world('p15');
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ targetKind: 'dunning_fee', targetId: feeId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p15-pay',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const o = assertReconciles(t, 'p15');
  assert.equal(o.items.reduce((n, i) => n + i.dunningFeeMinor, 0), 0);
});

test('P15b: a documentId passed with targetKind dunning_fee is refused, not silently resolved', () => {
  const { t, inv } = world('p15b');
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, targetKind: 'dunning_fee', amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p15b-pay',
  });
  assert.equal(res.ok, false, `an invoice id was accepted as a fee target: ${JSON.stringify(res)}`);
});

// --- P16: reversal of the mixed payment, asserted on the ledger AND the list ------------------------

test('P16: reversing a mixed payment restores the fee to the OP-Liste and 1100 together', () => {
  const { t, inv, feeId } = world('p16');
  const pay = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-17',
    amountMinor: GROSS_MINOR + FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: inv.id, amountMinor: GROSS_MINOR },
      { dunningItemId: feeId, amountMinor: FEE_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p16-pay',
  });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  assert.equal(open(t).workspaceBaseTotalOpenMinor, 0);

  // Reversed with a FUTURE date: today the ledger still holds the settlement, so the list must too.
  const rev = reversePayment(t.ctx, {
    paymentId: pay.paymentId,
    date: '2026-09-01',
    intent: PAYMENT_INTENTS.reverse,
    idempotencyKey: 'p16-rev',
  });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  const today = assertReconciles(t, 'p16 today (reversal dated September)');
  assert.equal(today.workspaceBaseTotalOpenMinor, 0, JSON.stringify(today));

  const later = listOpenItems(t.ctx, { asOf: '2026-09-15' });
  assert.equal(later.ok, true, JSON.stringify(later));
  assert.equal(later.reconciled, true, JSON.stringify(later));
  assert.equal(later.workspaceBaseTotalOpenMinor, GROSS_MINOR + FEE_MINOR, 'the fee must come back with the invoice');
});

// --- BASELINES: which of the failures above are NEW, and which predate this branch? ----------------
//
// Every case below exercises ONLY the pre-existing `document` path, which this diff does not touch.
// A baseline that behaves the same way as its P-numbered twin means the twin is pre-existing; a
// baseline that behaves correctly means the twin is a defect this branch introduced.

test('B3: the cross-debtor pairing on the DOCUMENT path alone (the P3 baseline)', { skip: X1_X2_SKIP }, () => {
  const t = setup();
  const a = t.customerId;
  const b = addCustomer(t.ctx, 'Fremde AG', 'b3-b');
  const invB = issueInvoice(t.ctx, { contactId: b, key: 'b3-inv' });
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: a,
    allocations: [{ documentId: invB.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'b3-pay',
  });
  assert.equal(res.ok, false, `PRE-EXISTING: a payment from A settles B's invoice: ${JSON.stringify(res)}`);
});

test('B4: an OUTGOING payment against an ordinary invoice (the P4 baseline)', { skip: X1_X2_SKIP }, () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'b4-inv' });
  const before = accountBalance(t.store, t.workspaceId, '1100');
  const res = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'b4-pay',
  });
  const after = accountBalance(t.store, t.workspaceId, '1100');
  assert.equal(res.ok, false, `PRE-EXISTING: an outgoing payment "settles" an invoice, 1100 ${before} -> ${after}`);
});

test('B2: the pre-branch route: park the fee cash, then reverse the fee entry (the P2 baseline)', () => {
  const { t, feeEntryId } = world('b2');
  // Exactly what a caller had to do BEFORE this target existed: the cash parks as an on-account
  // Guthaben because the fee could not be named.
  const pay = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-17',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: t.customerId,
    allocations: [],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'b2-pay',
  });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  assertReconciles(t, 'b2 parked');
  const rev = reverseEntry(t.ctx, { entryId: feeEntryId, date: '2026-07-18', idempotencyKey: 'b2-rev' });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  assertReconciles(t, 'b2 after reversing the fee with the cash PARKED');
});

// --- C2 variants: the as-of window of the same netting hole ----------------------------------------

test('C2b: a fee entry reversed with a FUTURE date, after settlement, breaks the later window', () => {
  const { t, feeId, feeEntryId } = world('c2b');
  const pay = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId: feeId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'c2b-pay',
  });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  const rev = reverseEntry(t.ctx, { entryId: feeEntryId, date: '2026-09-01', idempotencyKey: 'c2b-rev' });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  // Today the reversal is not yet on the ledger: this window is fine.
  assertReconciles(t, 'c2b today');
  // Past the reversal's own date the settlement's 1100 credit has no home in the read model.
  const later = listOpenItems(t.ctx, { asOf: '2026-09-15' });
  assert.equal(later.ok, true, JSON.stringify(later));
  assert.equal(
    later.reconciled,
    true,
    `the OP-Liste stopped tying to 1100 after the reversal's date: difference ${later.reconciliationDifferenceMinor}`,
  );
});
