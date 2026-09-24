/**
 * A14's `dunning_fee` allocation target: the increment recorded in A15's spec §4 per D59 and in
 * `openItems.ts`'s docblock.
 *
 * THE GAP THIS CLOSES: before this target existed, a payment covering an invoice PLUS its booked
 * Mahngebühr could only name the invoice. The pair netted to zero (A16's `baseTotalOpenMinor == 1100`
 * still reconciled), but the fee's own open item could never be CLEARED by a payment, only parked as
 * an unrelated on-account Guthaben. `dunningItemId` (implying `targetKind: 'dunning_fee'`) names the
 * FEE, a `dunning_item` row, not the invoice it rides, so one `record_payment` call may settle both
 * in one posting.
 *
 * Every case here dispatches through the CORE functions directly (the `test/payments/support.mjs`
 * idiom the rest of A14's suite uses), and every reconciliation is read back from the POSTED ROWS
 * or from A16's own reconciliation flag, never trusted off a return value.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recordPayment,
  allocatePayment,
  reversePayment,
  previewPayment,
  getPayment,
  PAYMENT_INTENTS,
} from '../../dist/core/payments/index.js';
import { setDunningConfig, proposeDunningRun, issueDunningRun } from '../../dist/core/dunning/index.js';
import { listOpenItems } from '../../dist/core/debtors/index.js';
import { setCreditorProfile } from '../../dist/core/setup/index.js';
import { lockPeriod, reverseEntry } from '../../dist/core/ledger/index.js';
import { setup, issueInvoice, legsOf, accountBalance, counts, secondWorkspace, GROSS_MINOR } from './support.mjs';

const FEE_MINOR = 2000;

/**
 * A workspace whose invoice already carries a BOOKED level-1 Mahngebühr: the world every case below
 * settles against. `dueDate` sits well before the fixture clock (2026-07-19), past every one of the
 * three shipped thresholds, so ONE run books the fee at level 1 deterministically.
 */
function worldWithBookedFee(key) {
  const t = setup();
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
  const issued = issueDunningRun(t.ctx, {
    runId: proposed.runId,
    confirmed: true,
    idempotencyKey: `${key}-issue`,
  });
  assert.equal(issued.ok, true, JSON.stringify(issued));

  const item = issued.items.find((i) => i.documentId === inv.id);
  assert.ok(item !== undefined, 'the issued run must carry the invoice item');
  assert.equal(item.feeBooked, true, 'the fee must be booked for these cases to mean anything');
  assert.equal(item.feeMinor, FEE_MINOR);

  return { t, inv, dunningItemId: item.id, run: issued };
}

function openItemsOf(t, asOf) {
  const open = listOpenItems(t.ctx, asOf === undefined ? {} : { asOf });
  assert.equal(open.ok, true, JSON.stringify(open));
  assert.equal(open.reconciled, true, `A16 must reconcile: ${JSON.stringify(open)}`);
  return open;
}

// --- invoice + fee in ONE payment ----------------------------------------------------------------

test('invoice + fee, one payment: both close and 1100 reconciles exactly', () => {
  const { t, inv, dunningItemId } = worldWithBookedFee('ifee1');
  const totalMinor = GROSS_MINOR + FEE_MINOR;

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: totalMinor,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: inv.id, amountMinor: GROSS_MINOR },
      { dunningItemId, amountMinor: FEE_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'ifee1-pay',
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  // ONE balanced entry, ONE 1100 credit combining the invoice and the fee: exactly what "one
  // payment settles invoice-then-fee" means at the ledger. Both rows are receivable-side, so
  // `buildLegs` resolves a single counter leg rather than two.
  const legs = legsOf(t.store, t.workspaceId, res.entryId);
  assert.deepEqual(
    legs.map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', totalMinor, 0],
      ['1100', 0, totalMinor],
    ],
  );
  assert.equal(
    accountBalance(t.store, t.workspaceId, '1100'),
    0,
    'the fee entry debited 1100 and this payment credits it back, both legs',
  );

  assert.equal(res.documents[0].openMinor, 0);
  assert.equal(res.documents[0].status, 'settled');

  const open = openItemsOf(t);
  const item = open.items.find((i) => i.documentId === inv.id);
  assert.equal(item, undefined, 'the invoice AND its fee are both fully settled: no open row remains');
  assert.equal(open.baseTotalOpenMinor, 0);

  // get_payment's allocation view resolves a real, human-recognisable label for the fee row (the
  // SAME idiom a document or a vendor bill gets), never a blank `targetNumber`.
  const detail = getPayment(t.ctx, { paymentId: res.paymentId });
  assert.equal(detail.ok, true);
  const feeAlloc = detail.payment.allocations.find((a) => a.targetKind === 'dunning_fee');
  assert.ok(feeAlloc !== undefined);
  assert.equal(feeAlloc.targetId, dunningItemId);
  assert.match(feeAlloc.targetNumber, /Mahngebühr Stufe 1/);
});

// --- fee-only payment -----------------------------------------------------------------------------

test('fee-only payment: the Mahngebühr clears while the invoice stays fully open', () => {
  const { t, inv, dunningItemId } = worldWithBookedFee('feeonly');

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'feeonly-pay',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), GROSS_MINOR, 'only the invoice principal remains on 1100');

  // Critic C3: a fee-only payment must not answer `documents:[] vendorBills:[]`, indistinguishable
  // from settling nothing at all. This capability has no Studio surface, so the response itself is
  // the whole feedback channel.
  assert.deepEqual(res.documents, []);
  assert.deepEqual(res.vendorBills, []);
  assert.equal(res.dunningFees.length, 1);
  assert.equal(res.dunningFees[0].id, dunningItemId);
  assert.match(res.dunningFees[0].number, /Mahngebühr Stufe 1/);
  assert.equal(res.dunningFees[0].feeMinor, FEE_MINOR);
  assert.equal(res.dunningFees[0].paidMinor, FEE_MINOR);
  assert.equal(res.dunningFees[0].openMinor, 0);

  const open = openItemsOf(t);
  const item = open.items.find((i) => i.documentId === inv.id);
  assert.ok(item !== undefined, 'the invoice is still open');
  assert.equal(item.openMinor, GROSS_MINOR, 'the fee is gone from the open amount, the principal is not');
  assert.equal(item.dunningFeeMinor, 0, 'the settled fee no longer rides the row at all');
  assert.equal(open.baseTotalOpenMinor, GROSS_MINOR);
});

// --- partial fee ------------------------------------------------------------------------------------

test('partial fee: a part payment leaves exactly the remainder folded into the open item', () => {
  const { t, inv, dunningItemId } = worldWithBookedFee('partfee');
  const partMinor = 750;

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: partMinor,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId, amountMinor: partMinor }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'partfee-pay',
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  const open = openItemsOf(t);
  const item = open.items.find((i) => i.documentId === inv.id);
  assert.equal(item.dunningFeeMinor, FEE_MINOR - partMinor);
  assert.equal(item.openMinor, GROSS_MINOR + (FEE_MINOR - partMinor));

  // A16's own honest failure mode: a residual pure-fee amount is not itself dunnable (A15 critic
  // C3/C4). This is the invariant the residual fee's remedy relies on, and it must survive the
  // fee becoming partially settled rather than only ever fully settled or fully open.
  assert.ok(item.openMinor - item.dunningFeeMinor > 0, 'the invoice principal keeps the row chaseable');

  // A second part payment finishes clearing the fee.
  const rest = FEE_MINOR - partMinor;
  const res2 = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-20',
    amountMinor: rest,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId, amountMinor: rest }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'partfee-pay-2',
  });
  assert.equal(res2.ok, true, JSON.stringify(res2));

  // D64's point-in-time discipline holds for the new target too: read as of the FIRST payment's own
  // date, the second (later) settlement has not happened yet.
  const stillPartial = openItemsOf(t, '2026-07-19').items.find((i) => i.documentId === inv.id);
  assert.equal(stillPartial.dunningFeeMinor, FEE_MINOR - partMinor);

  const after = openItemsOf(t, '2026-07-20').items.find((i) => i.documentId === inv.id);
  assert.equal(after.dunningFeeMinor, 0);
  assert.equal(after.openMinor, GROSS_MINOR);
});

// --- a parked Guthaben allocated LATER against the fee ----------------------------------------------

test('allocate_payment: a parked credit is allocated to the fee later, with no second entry', () => {
  const { t, dunningItemId } = worldWithBookedFee('allocfee');

  // Parked ON ACCOUNT: no allocations at all, so the whole amount sits as a Guthaben.
  const parked = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'allocfee-park',
  });
  assert.equal(parked.ok, true, JSON.stringify(parked));
  assert.equal(parked.onAccountMinor, FEE_MINOR);

  const before = counts(t.store, t.workspaceId);
  const allocated = allocatePayment(t.ctx, {
    paymentId: parked.paymentId,
    allocations: [{ dunningItemId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'allocfee-alloc',
  });
  assert.equal(allocated.ok, true, JSON.stringify(allocated));
  assert.equal(allocated.onAccountMinor, 0);
  // NO ledger effect: the cash already landed when the payment posted (P3, one posting path).
  const after = counts(t.store, t.workspaceId);
  assert.equal(after.entries, before.entries, 'allocating a parked credit posts NOTHING');
  assert.equal(after.allocations, before.allocations + 1);
});

// --- replay idempotent, on ROWS -------------------------------------------------------------------

test('idempotency: the same invoice+fee key twice moves the ledger ONCE, proven by row counts', () => {
  const { t, inv, dunningItemId } = worldWithBookedFee('idem');
  const input = {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR + FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: inv.id, amountMinor: GROSS_MINOR },
      { dunningItemId, amountMinor: FEE_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'idem-pay',
  };

  const first = recordPayment(t.ctx, input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const between = counts(t.store, t.workspaceId);

  const second = recordPayment(t.ctx, input);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second, first, 'a replay answers with the identical result, not a fresh one');
  assert.deepEqual(counts(t.store, t.workspaceId), between, 'a replay writes NOTHING new: same payment, allocation, entry and line counts');
});

// --- reversal walks the fee allocation back --------------------------------------------------------

test('reversal: unwinds invoice AND fee together, and the open items return exactly', () => {
  const { t, inv, dunningItemId } = worldWithBookedFee('revfee');
  const totalMinor = GROSS_MINOR + FEE_MINOR;

  const paid = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: totalMinor,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: inv.id, amountMinor: GROSS_MINOR },
      { dunningItemId, amountMinor: FEE_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'revfee-pay',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  assert.equal(openItemsOf(t).items.find((i) => i.documentId === inv.id), undefined);

  const reversed = reversePayment(t.ctx, {
    paymentId: paid.paymentId,
    date: '2026-07-21',
    intent: PAYMENT_INTENTS.reverse,
    idempotencyKey: 'revfee-rev',
  });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));

  // Nothing was rewritten: the allocation rows still exist, they simply stop counting because the
  // payment they belong to is no longer posted. The open item comes back at exactly its pre-payment
  // shape, invoice principal AND fee both, derived rather than restored. Read as of the REVERSAL's
  // own date (D64): the reversal is dated after the original payment, so that is the day it took
  // effect.
  const open = openItemsOf(t, '2026-07-21');
  const item = open.items.find((i) => i.documentId === inv.id);
  assert.equal(item.openMinor, totalMinor);
  assert.equal(item.dunningFeeMinor, FEE_MINOR);
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), totalMinor);

  // A second reversal of the same payment is refused, exactly as any A14 reversal refuses.
  const again = reversePayment(t.ctx, {
    paymentId: paid.paymentId,
    intent: PAYMENT_INTENTS.reverse,
    idempotencyKey: 'revfee-rev-2',
  });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_reversed');
});

// --- §H-TENANT --------------------------------------------------------------------------------------

test('H-TENANT: a foreign workspace cannot allocate against, or see, another tenant\'s fee', () => {
  const { t, dunningItemId } = worldWithBookedFee('tenant');
  const other = secondWorkspace(t);

  const res = recordPayment(other.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: other.bankId,
    allocations: [{ dunningItemId, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'tenant-pay',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
  assert.equal(res.dunningItemId, dunningItemId);

  // The foreign workspace's own open-items read is untouched and still reconciles on its own.
  const open = listOpenItems(other.ctx, {});
  assert.equal(open.ok, true);
  assert.equal(open.reconciled, true);
  assert.equal(open.items.length, 0);
});

// --- the settlement-side guard extends naturally ---------------------------------------------------

test('side guard: a dunning fee groups with the document, and still refuses a vendor bill in the same payment', () => {
  const { t, inv, dunningItemId } = worldWithBookedFee('side1');

  // document + dunning_fee, both receivable-side: this is the whole point and must be PERMITTED.
  const mixedReceivable = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR + FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: inv.id, amountMinor: GROSS_MINOR },
      { dunningItemId, amountMinor: FEE_MINOR },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'side1-ok',
  });
  assert.equal(mixedReceivable.ok, true, JSON.stringify(mixedReceivable));

  // A `supplier`-labelled payment beside a receivable-side row (the fee) is refused exactly as it
  // already was for a plain document, generalised rather than reworded.
  const supplierMismatch = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 500,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    allocations: [{ dunningItemId, amountMinor: 500 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'side1-supplier',
  });
  assert.equal(supplierMismatch.ok, false);
  assert.equal(supplierMismatch.error, 'allocation_target_side_mismatch');
});

// --- a fee a period lock skipped is not settleable, honestly ---------------------------------------

test('an unbooked fee (fee_booked=0) is dunning_fee_not_settleable, never not_found', () => {
  const t = setup({ realPeriods: true });
  setCreditorProfile(t.ctx, {
    creditorName: 'Muster Grafik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, dueDate: '2026-06-01', key: 'skip' });
  setDunningConfig(t.ctx, {
    levels: [
      { level: 1, daysOverdue: 10, feeMinor: FEE_MINOR, bookFee: true, feeIncomeAccountId: t.acc('3200') },
      { level: 2, daysOverdue: 20, feeMinor: 0 },
      { level: 3, daysOverdue: 30, feeMinor: 0 },
    ],
    idempotencyKey: 'skip-cfg',
  });
  // Lock the period BEFORE the run posts, exactly the way C8's own probe does it (§H-PERIOD skips
  // the fee, not the run).
  const locked = lockPeriod(t.ctx, { period: '2026-07', kind: 'hard', idempotencyKey: 'skip-lock' });
  assert.equal(locked.ok, true, JSON.stringify(locked));

  const proposed = proposeDunningRun(t.ctx, { idempotencyKey: 'skip-propose' });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const issued = issueDunningRun(t.ctx, { runId: proposed.runId, confirmed: true, idempotencyKey: 'skip-issue' });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  assert.equal(issued.feeSkippedReason, 'period_locked');
  const item = issued.items.find((i) => i.documentId === inv.id);
  assert.equal(item.feeBooked, false);

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId: item.id, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'skip-pay',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'dunning_fee_not_settleable');
});

// --- N7: a refused fee's own PREVIEW must say what the write will actually answer ------------------

test('N7: previewing a reversed fee reports its OWN state, never a derived "settled"', () => {
  const t = setup();
  setCreditorProfile(t.ctx, {
    creditorName: 'Muster Grafik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, dueDate: '2026-06-01', key: 'n7' });
  setDunningConfig(t.ctx, {
    levels: [
      { level: 1, daysOverdue: 10, feeMinor: FEE_MINOR, bookFee: true, feeIncomeAccountId: t.acc('3200') },
      { level: 2, daysOverdue: 20, feeMinor: 0 },
      { level: 3, daysOverdue: 30, feeMinor: 0 },
    ],
    idempotencyKey: 'n7-cfg',
  });
  const proposed = proposeDunningRun(t.ctx, { idempotencyKey: 'n7-propose' });
  const issued = issueDunningRun(t.ctx, { runId: proposed.runId, confirmed: true, idempotencyKey: 'n7-issue' });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  const item = issued.items.find((i) => i.documentId === inv.id);
  const feeEntryId = t.store.db
    .prepare('SELECT fee_entry_id FROM dunning_run WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, proposed.runId).fee_entry_id;

  // The fee is booked and never paid: reverse its OWN booking entry outright (A15 §4's remedy for
  // a fee nobody is going to collect).
  const rev = reverseEntry(t.ctx, { entryId: feeEntryId, date: '2026-07-19', idempotencyKey: 'n7-rev' });
  assert.equal(rev.ok, true, JSON.stringify(rev));

  const preview = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId: item.id, amountMinor: FEE_MINOR }],
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  // Before N7: `resultingOpenMinor` went negative against the zeroed-out `totalMinor` and the
  // generic rule reported `settled`, promising a booking the write then refused outright.
  assert.equal(preview.error.code, 'dunning_fee_not_settleable', JSON.stringify(preview));
  assert.equal(preview.rows[0].resultingStatus, 'reversed', JSON.stringify(preview.rows[0]));
  assert.notEqual(preview.rows[0].resultingStatus, 'settled');

  // The write answers exactly what the preview promised: a refusal, nothing posted.
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId: item.id, amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'n7-pay',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'dunning_fee_not_settleable');
});

// --- N5: two booked fees on ONE invoice must never net against each other --------------------------

test('N5: two fees on one invoice are netted per item: a live fee and an orphaned one never merge', () => {
  const t = setup();
  setCreditorProfile(t.ctx, {
    creditorName: 'Muster Grafik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, dueDate: '2026-06-01', key: 'n5' });
  const LEVEL1_FEE = 2000;
  const LEVEL2_FEE = 3000;
  const cfg = setDunningConfig(t.ctx, {
    levels: [
      { level: 1, daysOverdue: 10, feeMinor: LEVEL1_FEE, bookFee: true, feeIncomeAccountId: t.acc('3200') },
      { level: 2, daysOverdue: 20, feeMinor: LEVEL2_FEE, bookFee: true, feeIncomeAccountId: t.acc('3200') },
      { level: 3, daysOverdue: 30, feeMinor: 0 },
    ],
    idempotencyKey: 'n5-cfg',
  });
  assert.equal(cfg.ok, true, JSON.stringify(cfg));

  // Level 1, at the fixture clock: booked, LIVE, and never touched again for the rest of this test.
  const proposed1 = proposeDunningRun(t.ctx, { idempotencyKey: 'n5-propose-1' });
  assert.equal(proposed1.ok, true, JSON.stringify(proposed1));
  const issued1 = issueDunningRun(t.ctx, { runId: proposed1.runId, confirmed: true, idempotencyKey: 'n5-issue-1' });
  assert.equal(issued1.ok, true, JSON.stringify(issued1));
  const level1Item = issued1.items.find((i) => i.documentId === inv.id);
  assert.equal(level1Item.level, 1);
  assert.equal(level1Item.feeBooked, true);

  // Level 2, weeks later: a SECOND booked fee on the SAME invoice, A15's normal escalation, never
  // an edge case (D59: this increment names the `dunning_item`, not the invoice, precisely because
  // two fees on one invoice is ordinary).
  const later = t.at('2026-08-15');
  const proposed2 = proposeDunningRun(later, { idempotencyKey: 'n5-propose-2' });
  assert.equal(proposed2.ok, true, JSON.stringify(proposed2));
  const issued2 = issueDunningRun(later, { runId: proposed2.runId, confirmed: true, idempotencyKey: 'n5-issue-2' });
  assert.equal(issued2.ok, true, JSON.stringify(issued2));
  const level2Item = issued2.items.find((i) => i.documentId === inv.id);
  assert.equal(level2Item.level, 2);
  assert.equal(level2Item.feeBooked, true);

  // Settle level 2's fee in full, then reverse ITS OWN booking entry: level 1's fee is never named
  // by either call and stays exactly as booked.
  const paid2 = recordPayment(later, {
    direction: 'incoming',
    date: '2026-08-15',
    amountMinor: LEVEL2_FEE,
    bankAccountId: t.bankId,
    allocations: [{ dunningItemId: level2Item.id, amountMinor: LEVEL2_FEE }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'n5-pay-2',
  });
  assert.equal(paid2.ok, true, JSON.stringify(paid2));
  const feeEntryId2 = t.store.db
    .prepare('SELECT fee_entry_id FROM dunning_run WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, proposed2.runId).fee_entry_id;
  const rev2 = reverseEntry(later, { entryId: feeEntryId2, date: '2026-08-16', idempotencyKey: 'n5-rev-2' });
  assert.equal(rev2.ok, true, JSON.stringify(rev2));

  const asOfLater = t.at('2026-08-16');
  const open = listOpenItems(asOfLater, {});
  assert.equal(open.ok, true, JSON.stringify(open));
  assert.equal(open.reconciled, true, JSON.stringify(open));

  // THE N5 ASSERTION: level 1's own 2000 is untouched, reported in FULL, never netted against
  // level 2's unrelated 3000. Before the fix this read `dunningFeeMinor: 0`.
  const invoiceRow = open.items.find((i) => i.documentId === inv.id);
  assert.ok(invoiceRow !== undefined);
  assert.equal(invoiceRow.dunningFeeMinor, LEVEL1_FEE, 'the live level-1 fee must report its OWN figure');

  // The orphaned level-2 settlement is its OWN row, self-describing (N6) and naming its OWN level,
  // never blended with level 1's.
  const orphanRows = open.items.filter((i) => i.kind === 'on_account' && i.openMinor < 0);
  assert.equal(orphanRows.length, 1, JSON.stringify(orphanRows));
  assert.equal(orphanRows[0].openMinor, -LEVEL2_FEE);
  assert.equal(orphanRows[0].documentId, inv.id);
  assert.match(orphanRows[0].number, /Mahngebühr Stufe 2/);
});
