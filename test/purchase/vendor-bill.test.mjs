/**
 * A17, the vendor-bill engine: lifecycle, figures, and every refusal the surface routes around.
 *
 * THE FIGURES ARE COMPARED AGAINST A06, NEVER AGAINST HAND ARITHMETIC. Rule 1 of the module under
 * test is "A17 computes no VAT", and the only proof of that worth having is the one the module
 * header itself asks for: the stored trace equals `computeLineTax`'s answer for the same input.
 * A hand-written 8100 would agree with a bug that hard-coded 8.1%.
 *
 * THE POSTING IS RECONCILED TO THE LEDGER BY NUMBER. `legsOf` reads the journal straight off
 * `journal_line` joined by account NUMBER, sharing nothing with the code under test, so
 * "debit 6500, debit 1170, credit 2000" is a fact about the books and not an echo of the planner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createVendorBill,
  recordExpense,
  postVendorBill,
  attachReceipt,
  voidVendorBill,
  listVendorBills,
  getVendorBill,
  VENDOR_BILL_TAX_KINDS,
} from '../../dist/core/purchase/index.js';
import { computeLineTax } from '../../dist/core/vat/index.js';
import { configureVat } from '../../dist/core/vat/index.js';
import { softCloseMonth } from '../../dist/core/ledger/index.js';
import { recordPayment, reversePayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import {
  setup,
  addVendor,
  billInput,
  billRow,
  legsOf,
  payablesBalance,
  seedRate,
  BILL_DATE,
  GROSS_MINOR,
  NET_MINOR,
  TAX_MINOR,
} from './support.mjs';

// --- draft ----------------------------------------------------------------------------------------

test('create_vendor_bill writes a draft with A06 figures and books NOTHING', (tc) => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const res = createVendorBill(t.ctx, billInput(t, vendorId, { idempotencyKey: 'draft-1' }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.vendorBill.status, 'draft');
  assert.equal(res.vendorBill.displayStatus, 'draft');
  assert.equal(res.vendorBill.entryId, null);

  // The stored split is A06's answer for exactly this input, value for value.
  const computed = computeLineTax(t.ctx, {
    amountMinor: GROSS_MINOR,
    amountIsGross: true,
    taxCode: 'VST-M',
    supplyDate: BILL_DATE,
  });
  assert.equal(computed.ok, true);
  assert.equal(res.vendorBill.netMinor, computed.netMinor);
  assert.equal(res.vendorBill.taxAmountMinor, computed.taxMinor);
  assert.equal(res.vendorBill.grossMinor, computed.grossMinor);
  // And the canonical arithmetic holds, stated once so a broken A06 cannot silently agree with itself.
  assert.equal(res.vendorBill.netMinor, NET_MINOR);
  assert.equal(res.vendorBill.taxAmountMinor, TAX_MINOR);

  // A draft has no ledger effect: 2000 is untouched and the journal is empty.
  assert.equal(payablesBalance(t.store, t.workspaceId), 0);
  assert.equal(
    t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(t.workspaceId).n,
    0,
  );
  tc.diagnostic('draft carries figures but no entry');
});

test('the due date defaults to the vendor payment terms from the bill date', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  t.store.db
    .prepare('UPDATE contact SET payment_terms_days = 30 WHERE workspace_id = ? AND id = ?')
    .run(t.workspaceId, vendorId);
  const res = createVendorBill(
    t.ctx,
    billInput(t, vendorId, { idempotencyKey: 'terms-1', dueDate: undefined }),
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.vendorBill.dueDate, '2026-07-31');
});

// --- post -----------------------------------------------------------------------------------------

test('post_vendor_bill books debit 6500 net, debit 1170 Vorsteuer, credit 2000 gross', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const created = createVendorBill(t.ctx, billInput(t, vendorId, { idempotencyKey: 'post-1' }));
  assert.equal(created.ok, true);
  const posted = postVendorBill(t.ctx, { vendorBillId: created.vendorBillId, idempotencyKey: 'post-1-go' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(posted.vorsteuerDeductible, true);
  assert.equal(posted.vendorBill.status, 'posted');
  assert.equal(posted.vendorBill.settlementStatus, 'unpaid');
  assert.equal(posted.vendorBill.openMinor, GROSS_MINOR);

  const legs = legsOf(t.store, t.workspaceId, posted.entryId);
  assert.deepEqual(
    legs.map((l) => ({ number: l.number, debit: l.debit, credit: l.credit })),
    [
      { number: '1170', debit: TAX_MINOR, credit: 0 },
      { number: '2000', debit: 0, credit: GROSS_MINOR },
      { number: '6500', debit: NET_MINOR, credit: 0 },
    ],
  );
  // The reconciliation invariant, from the ledger side and from the read model, agreeing.
  assert.equal(payablesBalance(t.store, t.workspaceId), GROSS_MINOR);
  const list = listVendorBills(t.ctx);
  assert.equal(list.ok, true);
  assert.equal(list.reconciled, true, JSON.stringify(list));
  assert.equal(list.baseTotalOpenMinor, GROSS_MINOR);
  assert.equal(list.payablesBalanceMinor, GROSS_MINOR);
});

test('record_expense in one call posts EXACTLY what create + post posts', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const twoStep = createVendorBill(t.ctx, billInput(t, vendorId, { idempotencyKey: 'pair-create' }));
  const twoStepPosted = postVendorBill(t.ctx, { vendorBillId: twoStep.vendorBillId, idempotencyKey: 'pair-post' });
  const oneShot = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'one-shot' }));
  assert.equal(twoStepPosted.ok, true);
  assert.equal(oneShot.ok, true, JSON.stringify(oneShot));

  const strip = (legs) => legs.map((l) => ({ number: l.number, debit: l.debit, credit: l.credit }));
  assert.deepEqual(
    strip(legsOf(t.store, t.workspaceId, oneShot.entryId)),
    strip(legsOf(t.store, t.workspaceId, twoStepPosted.entryId)),
  );
  const a = billRow(t.store, t.workspaceId, twoStep.vendorBillId);
  const b = billRow(t.store, t.workspaceId, oneShot.vendorBillId);
  for (const col of ['net_minor', 'tax_amount_minor', 'gross_minor', 'payable_minor', 'base_payable_minor', 'status']) {
    assert.equal(b[col], a[col], col);
  }
});

test('under Saldo the expense books GROSS, nothing lands on 1170, and the result says why', () => {
  const t = setup();
  // Move the workspace to the Saldo method through A05's own verb, never by writing config rows.
  // 620 bp (6.2%) is on the SR 641.202.62 ladder in force since 1.1.2024 (`rateEras.ts` holds the
  // verified ladder; the pre-2024 590 is deliberately NOT on it).
  const vat = configureVat(t.ctx, {
    method: 'saldo',
    timing: 'ist',
    registered: true,
    saldoRates: [{ rateBp: 620 }],
    idempotencyKey: 'vat-saldo',
  });
  assert.equal(vat.ok, true, JSON.stringify(vat));
  const vendorId = addVendor(t.ctx);
  const res = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'saldo-1' }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.vorsteuerDeductible, false);
  assert.equal(res.vorsteuerReason, 'saldo_method');

  const legs = legsOf(t.store, t.workspaceId, res.entryId);
  assert.deepEqual(
    legs.map((l) => ({ number: l.number, debit: l.debit, credit: l.credit })),
    [
      { number: '2000', debit: 0, credit: GROSS_MINOR },
      { number: '6500', debit: GROSS_MINOR, credit: 0 },
    ],
  );
  assert.equal(res.vendorBill.baseTaxMinor, 0);
});

// --- refusals the surface routes around -----------------------------------------------------------

test('a customer-only contact is refused with needs_vendor and the party_role reason', () => {
  const t = setup();
  const res = createVendorBill(t.ctx, billInput(t, t.customerId, { idempotencyKey: 'role-1' }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_vendor');
  assert.equal(res.reason, 'party_role');
});

test('an output code on a purchase is refused with needs_input_tax_code, naming the kinds', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const res = createVendorBill(t.ctx, billInput(t, vendorId, { idempotencyKey: 'side-1', taxCode: 'UST81' }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_input_tax_code');
  assert.deepEqual(res.allowedKinds, [...VENDOR_BILL_TAX_KINDS]);
});

test('the four engine-booked accounts are refused as the cost side', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  // 1170/1171 are ASSET accounts, so only the reserved-number check can catch them; 2000/2200 are
  // liabilities and fail the type check first. Either way, every one of the four is refused.
  const expected = {
    1170: 'reserved_account',
    1171: 'reserved_account',
    2000: 'not_an_expense_or_asset_account',
    2200: 'not_an_expense_or_asset_account',
  };
  for (const [number, reason] of Object.entries(expected)) {
    const res = createVendorBill(
      t.ctx,
      billInput(t, vendorId, { idempotencyKey: `res-${number}`, expenseAccountId: t.acc(number) }),
    );
    assert.equal(res.ok, false, number);
    assert.equal(res.error, 'needs_account', number);
    assert.equal(res.reason, reason, number);
  }
});

test('a revenue account is refused: a purchase is a cost or an asset, never turnover', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const res = createVendorBill(
    t.ctx,
    billInput(t, vendorId, { idempotencyKey: 'rev-1', expenseAccountId: t.acc('3200') }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_account');
  assert.equal(res.reason, 'not_an_expense_or_asset_account');
});

test('posting into a locked period is refused, and the draft survives to be posted later', () => {
  const t = setup({ realPeriods: true });
  const vendorId = addVendor(t.ctx);
  const created = createVendorBill(t.ctx, billInput(t, vendorId, { idempotencyKey: 'lock-1' }));
  assert.equal(created.ok, true);
  const closed = softCloseMonth(t.ctx, { period: '2026-07', idempotencyKey: 'close-07' });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const posted = postVendorBill(t.ctx, { vendorBillId: created.vendorBillId, idempotencyKey: 'lock-1-go' });
  assert.equal(posted.ok, false);
  assert.equal(posted.error, 'period_locked');
  assert.equal(billRow(t.store, t.workspaceId, created.vendorBillId).status, 'draft');
});

test('a foreign-currency bill with no admissible rate is refused with needs_fx_rate', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const res = recordExpense(
    t.ctx,
    billInput(t, vendorId, { idempotencyKey: 'fx-none', currency: 'EUR' }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_fx_rate');
});

test('a foreign-currency bill converts at the BILL date rate and stores the base figures', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: BILL_DATE });
  const res = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'fx-1', currency: 'EUR' }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.vendorBill.fxRate, '0.95');
  // The base figures are read off the posted entry, and the ledger balances in base currency.
  assert.equal(res.vendorBill.basePayableMinor, payablesBalance(t.store, t.workspaceId));
  assert.equal(res.vendorBill.baseGrossMinor, res.vendorBill.baseNetMinor + res.vendorBill.baseTaxMinor);
});

// --- void and receipt -----------------------------------------------------------------------------

test('void of a posted bill posts the faithful reversal and 2000 returns to zero', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const posted = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'void-1' }));
  assert.equal(posted.ok, true);
  assert.equal(payablesBalance(t.store, t.workspaceId), GROSS_MINOR);

  const voided = voidVendorBill(t.ctx, {
    vendorBillId: posted.vendorBillId,
    reason: 'Doppelt erfasst',
    date: '2026-07-05',
    idempotencyKey: 'void-1-go',
  });
  assert.equal(voided.ok, true, JSON.stringify(voided));
  assert.equal(payablesBalance(t.store, t.workspaceId), 0);
  const row = billRow(t.store, t.workspaceId, posted.vendorBillId);
  assert.equal(row.status, 'void');
  assert.equal(row.void_reason, 'Doppelt erfasst');
  assert.notEqual(row.reversal_entry_id, null);
  // The original entry still stands: append-only means the correction is a SECOND entry.
  assert.equal(
    t.store.db.prepare('SELECT status FROM journal_entry WHERE id = ?').get(posted.entryId).status,
    'posted',
  );
});

test('void of a settled bill is refused with already_settled until the payment is reversed', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const posted = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'settle-1' }));
  const paid = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-10',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    allocations: [{ targetKind: 'vendor_bill', targetId: posted.vendorBillId, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'settle-1-pay',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));

  const refused = voidVendorBill(t.ctx, { vendorBillId: posted.vendorBillId, idempotencyKey: 'settle-1-void' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'already_settled');
  assert.equal(refused.settledMinor, GROSS_MINOR);

  // Reverse the payment (A14's verb, the rejection's own hint) and the void goes through.
  const reversed = reversePayment(t.ctx, {
    paymentId: paid.paymentId,
    intent: PAYMENT_INTENTS.reverse,
    idempotencyKey: 'settle-1-unpay',
  });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));
  const voided = voidVendorBill(t.ctx, { vendorBillId: posted.vendorBillId, idempotencyKey: 'settle-1-void2' });
  assert.equal(voided.ok, true, JSON.stringify(voided));
});

test('settlement drives the derived status: unpaid, partly_paid, then paid', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const posted = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'part-1' }));
  const half = GROSS_MINOR / 2;

  const first = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-10',
    amountMinor: half,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    allocations: [{ targetKind: 'vendor_bill', targetId: posted.vendorBillId, amountMinor: half }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'part-1-a',
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  let bill = getVendorBill(t.ctx, { vendorBillId: posted.vendorBillId }).vendorBill;
  assert.equal(bill.settlementStatus, 'partly_paid');
  assert.equal(bill.displayStatus, 'partly_paid');
  assert.equal(bill.openMinor, GROSS_MINOR - half);

  const second = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-11',
    amountMinor: half,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    allocations: [{ targetKind: 'vendor_bill', targetId: posted.vendorBillId, amountMinor: half }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'part-1-b',
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  bill = getVendorBill(t.ctx, { vendorBillId: posted.vendorBillId }).vendorBill;
  assert.equal(bill.settlementStatus, 'paid');
  assert.equal(bill.openMinor, 0);
  // And the list agrees with the ledger: everything settled, 2000 clear, reconciliation green.
  const list = listVendorBills(t.ctx);
  assert.equal(list.baseTotalOpenMinor, 0);
  assert.equal(list.reconciled, true, JSON.stringify(list));
});

test('attach_receipt moves exactly one column on a posted bill, and the trigger holds the rest', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const posted = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'rcpt-1' }));
  const before = billRow(t.store, t.workspaceId, posted.vendorBillId);

  const attached = attachReceipt(t.ctx, {
    vendorBillId: posted.vendorBillId,
    receiptRef: 'beleg/2026/kreditor-0042.pdf',
    idempotencyKey: 'rcpt-1-go',
  });
  assert.equal(attached.ok, true, JSON.stringify(attached));
  const after = billRow(t.store, t.workspaceId, posted.vendorBillId);
  assert.equal(after.receipt_ref, 'beleg/2026/kreditor-0042.pdf');
  for (const [col, value] of Object.entries(before)) {
    if (col !== 'receipt_ref') assert.deepEqual(after[col], value, col);
  }

  // The DB trigger, not politeness, is what freezes a posted bill's accounting columns.
  assert.throws(
    () =>
      t.store.db
        .prepare('UPDATE vendor_bill SET gross_minor = 1 WHERE workspace_id = ? AND id = ?')
        .run(t.workspaceId, posted.vendorBillId),
    /vendor_bill_immutable/,
  );
});
