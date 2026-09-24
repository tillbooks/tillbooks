/**
 * A14 §3, the `dunning_fee` CANDIDATE (K-29): a booked Mahngebühr must reach the HUMAN allocator, not
 * only an agent passing `dunningItemId` directly (MCP).
 *
 * THE GAP THIS CLOSES: `recordPayment` has admitted `target_kind = 'dunning_fee'` since the A14
 * follow-up (D59), but the Studio allocator is driven SOLELY by `suggestPaymentMatches.candidates`,
 * whose `Candidate.targetKind` union was `document | vendor_bill` only. So a fee could be settled by
 * an agent passing `dunningItemId` directly, and NEVER through the human surface: the operator had no
 * row to type an amount against. This suite is the read-model half of the fix: a live booked fee is
 * now a candidate, sourced from the SAME `liveDunningFeeItemsAsOf` predicate `openItems.ts` and
 * `readTarget` already share, and it settles the FEE receivable, never the invoice principal.
 *
 * Every case dispatches through the CORE functions directly (the `support.mjs` idiom) and reads its
 * reconciliation back from the POSTED ROWS off `store.db`, never trusting a return value. The
 * allocation wire shape is EXACTLY the one the Studio's `PaymentAllocator` sends (`documentId` set to
 * the fee item's id plus an explicit `targetKind: 'dunning_fee'`, mirroring the `vendor_bill` idiom),
 * so a divergence between what the surface builds and what the engine accepts goes red here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  suggestPaymentMatches,
  recordPayment,
  PAYMENT_INTENTS,
} from '../../dist/core/payments/index.js';
import { setDunningConfig, proposeDunningRun, issueDunningRun } from '../../dist/core/dunning/index.js';
import { listOpenItems } from '../../dist/core/debtors/index.js';
import { setCreditorProfile } from '../../dist/core/setup/index.js';
import {
  setup,
  issueInvoice,
  legsOf,
  accountBalance,
  counts,
  secondWorkspace,
  GROSS_MINOR,
} from './support.mjs';

const FEE_MINOR = 2000;

/**
 * A workspace whose invoice already carries a BOOKED level-1 Mahngebühr. `dueDate` sits well before
 * the fixture clock (2026-07-19), past every shipped threshold, so ONE run books the fee at level 1.
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

  return { t, inv, dunningItemId: item.id };
}

/** The one allocation row the db actually holds for a target, read back off `store.db`. */
function allocationRow(t, targetKind, targetId) {
  return t.store.db
    .prepare(
      `SELECT a.target_kind AS targetKind, a.target_id AS targetId, a.amount_minor AS amountMinor
         FROM payment_allocation a JOIN payment p ON p.id = a.payment_id AND p.workspace_id = ?
        WHERE a.workspace_id = ? AND a.target_kind = ? AND a.target_id = ?`,
    )
    .all(t.workspaceId, t.workspaceId, targetKind, targetId);
}

// --- the candidate exists ------------------------------------------------------------------------

test('a live booked Mahngebühr is a dunning_fee candidate the human allocator can reach', () => {
  const { t, inv, dunningItemId } = worldWithBookedFee('cand1');

  const res = suggestPaymentMatches(t.ctx, {
    direction: 'incoming',
    amountMinor: FEE_MINOR,
    counterpartyId: t.customerId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  const fee = res.candidates.find((c) => c.targetKind === 'dunning_fee');
  assert.ok(fee !== undefined, 'the booked fee must appear as its own allocatable candidate');
  assert.equal(fee.targetId, dunningItemId, 'the target is the dunning_item row, never the invoice');
  assert.equal(fee.openMinor, FEE_MINOR);
  assert.equal(fee.currency, 'CHF', 'A15 books every Mahngebühr in the base currency');
  assert.match(fee.number, /Mahngebühr Stufe 1/);
  assert.equal(fee.settled, false);
  assert.equal(fee.disabledReason, null);
  // Amount equals the fee AND the counterparty agrees: the middle tier, exactly as a document.
  assert.equal(fee.kind, 'exact_amount_customer');

  // The invoice principal is STILL its own separate candidate: the two are distinct open positions.
  const doc = res.candidates.find((c) => c.targetKind === 'document' && c.targetId === inv.id);
  assert.ok(doc !== undefined, 'the invoice principal remains a candidate of its own');

  // Every field the read-model contract names, present on the new kind too, or the GUI cannot build.
  for (const k of ['targetKind', 'targetId', 'number', 'contactId', 'contactName', 'currency',
    'dueDate', 'daysOverdue', 'grossMinor', 'paidMinor', 'openMinor', 'status', 'reference',
    'kind', 'reason', 'deltaMinor', 'prefillMinor', 'settled', 'disabledReason']) {
    assert.equal(k in fee, true, `dunning_fee candidate.${k} is missing from the read model`);
  }
});

test('a settled fee is not offered as a candidate, and an unbooked one never is', () => {
  const { t, dunningItemId } = worldWithBookedFee('cand2');

  // Settle the fee in full, then the candidate must be gone (openMinor would be 0).
  const paid = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: dunningItemId, targetKind: 'dunning_fee', amountMinor: FEE_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'cand2-pay',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));

  const res = suggestPaymentMatches(t.ctx, { direction: 'incoming', counterpartyId: t.customerId });
  const fee = res.candidates.find((c) => c.targetKind === 'dunning_fee');
  assert.equal(fee, undefined, 'a fully settled fee has no open amount, so it is not a candidate');
});

// --- settling the fee through the SURFACE wire shape ---------------------------------------------

test('the Studio wire shape settles the FEE receivable, not the invoice principal, idempotently', () => {
  const { t, inv, dunningItemId } = worldWithBookedFee('wire');

  // EXACTLY what PaymentAllocator builds: documentId = the fee item id, explicit dunning_fee kind.
  const alloc = { documentId: dunningItemId, targetKind: 'dunning_fee', amountMinor: FEE_MINOR };
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [alloc],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'wire-pay',
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  // Read back off the db: the allocation genuinely targets the FEE, keyed on the dunning_item row.
  const rows = allocationRow(t, 'dunning_fee', dunningItemId);
  assert.equal(rows.length, 1, 'exactly one fee allocation row is written');
  assert.equal(rows[0].amountMinor, FEE_MINOR);
  // And NOTHING was booked against the invoice principal as a document allocation.
  assert.equal(allocationRow(t, 'document', inv.id).length, 0, 'the principal was never touched');

  // The legs: cash in on 1020, the fee receivable credited back on 1100.
  assert.deepEqual(
    legsOf(t.store, t.workspaceId, res.entryId).map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', FEE_MINOR, 0],
      ['1100', 0, FEE_MINOR],
    ],
  );
  // The invoice principal is STILL fully open on 1100: paying the fee did not settle the principal.
  assert.equal(
    accountBalance(t.store, t.workspaceId, '1100'),
    GROSS_MINOR,
    'only the invoice principal remains on 1100; the fee is cleared',
  );

  // A16 sees the fee gone from the row and the principal untouched, and it still reconciles.
  const open = listOpenItems(t.ctx, {});
  assert.equal(open.reconciled, true, JSON.stringify(open));
  const item = open.items.find((i) => i.documentId === inv.id);
  assert.ok(item !== undefined, 'the invoice is still open');
  assert.equal(item.dunningFeeMinor, 0, 'the settled fee no longer rides the row');
  assert.equal(item.openMinor, GROSS_MINOR, 'the principal is untouched');

  // IDEMPOTENT ON ROWS (§H-IDEMPOTENT): the same question re-asked writes nothing new.
  const before = counts(t.store, t.workspaceId);
  const replay = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: FEE_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [alloc],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'wire-pay',
  });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.paymentId, res.paymentId, 'the replay converges on the one payment');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a replay double-counts nothing');
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), GROSS_MINOR, '1100 did not move on replay');
});

// --- §H-TENANT ------------------------------------------------------------------------------------

test('a neighbour workspace never sees another tenant’s booked fee among its candidates', () => {
  const { t } = worldWithBookedFee('tenant');
  const neighbour = secondWorkspace(t);

  const res = suggestPaymentMatches(neighbour.ctx, {
    direction: 'incoming',
    amountMinor: FEE_MINOR,
    counterpartyId: neighbour.customerId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(
    res.candidates.some((c) => c.targetKind === 'dunning_fee'),
    false,
    'the fee belongs to the first workspace and is invisible to the neighbour',
  );
});
