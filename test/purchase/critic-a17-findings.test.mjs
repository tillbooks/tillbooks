/**
 * THE CRITIC'S ADVERSARIAL SUITE for A17, now the permanent regression gate.
 *
 * Written by the non-author critic against branch head 9bd0670, where all seven FAILED; each
 * failure is a finding in `docs/critique/a17-critic.md`. Renamed from `.probe.mjs` to `.test.mjs`
 * by the remediation round once the findings were fixed, exactly as the critic's own header asked,
 * so `npm test` now runs it and the seven defects cannot come back silently.
 *
 * THE ASSERTIONS ARE THE CRITIC'S, UNTOUCHED. The remediation changed exactly one thing in this
 * file besides this header: the F2 comment cited MWSTG Art. 41 Abs. 1 for the input-side
 * correction, which is finding C6's own swap (Abs. 1 adjusts the Umsatzsteuerschuld, Abs. 2 the
 * Vorsteuerabzug, verified against SR 641.20 on fedlex). The comment now cites Abs. 2; the
 * assertion under it is unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, addVendor, billInput } from './support.mjs';
import { legsOf, accountBalance, addCustomer, issueInvoice } from '../payments/support.mjs';
import { recordExpense, listVendorBills, getVendorBill, voidVendorBill } from '../../dist/core/purchase/index.js';
import { recordPayment, allocatePayment, reversePayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { listOpenItems } from '../../dist/core/debtors/index.js';

// --- F1 -------------------------------------------------------------------------------------------

test('F1: a payment whose entry cleared 1100 may NOT be allocated to a vendor bill', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const custId = addCustomer(t.ctx, 'Kunde AG', 'f1-cust');
  const bill = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'f1-bill' }));
  assert.equal(bill.ok, true);

  // A parked OUTGOING payment against a CUSTOMER: the entry debits 1100 Debitoren, not 2000.
  const pay = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-05',
    amountMinor: 108100,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: custId,
    allocations: [],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'f1-pay',
  });
  assert.equal(pay.ok, true);
  const legs = legsOf(t.store, t.workspaceId, pay.entryId);
  assert.ok(
    legs.some((l) => l.number === '1100' && l.debit === 108100),
    `the fixture must park the money on 1100: ${JSON.stringify(legs)}`,
  );

  const alloc = allocatePayment(t.ctx, {
    paymentId: pay.paymentId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'f1-alloc',
  });

  // THE CLAIM: settling a payable out of a payment that cleared a receivable is not a settlement.
  assert.equal(
    alloc.ok,
    false,
    'a payable was settled out of an entry that debited 1100 Debitoren: 2000 Kreditoren never moved',
  );
  const after = getVendorBill(t.ctx, { vendorBillId: bill.vendorBillId }).vendorBill;
  assert.equal(after.displayStatus, 'posted', 'the bill reports paid while 2000 still carries it');
  assert.equal(after.openMinor, 108100);
  assert.equal(accountBalance(t.store, t.workspaceId, '2000'), -108100);
});

test('F1b: a payment whose entry cleared 2000 may NOT be allocated to a customer invoice', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx, 'Beides GmbH', 'f1b-v', 'both');
  const bill = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'f1b-bill' }));
  const inv = issueInvoice(t.ctx, { contactId: vendorId, key: 'f1b-inv' });
  const pay = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-05',
    amountMinor: 200000,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'f1b-pay',
  });
  assert.equal(pay.ok, true);

  const alloc = allocatePayment(t.ctx, {
    paymentId: pay.paymentId,
    allocations: [{ documentId: inv.id, amountMinor: 91900 }],
    intent: PAYMENT_INTENTS.allocate,
    idempotencyKey: 'f1b-alloc',
  });
  assert.equal(alloc.ok, false, 'an invoice was settled out of an entry that debited 2000 Kreditoren');
});

// --- F2 -------------------------------------------------------------------------------------------

test('F2: a write-off against a vendor bill is refused, exactly as purchase-side Skonto is', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const bill = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'f2-bill' }));
  const pay = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-05',
    amountMinor: 108050,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108050, writeOffMinor: 50 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'f2-pay',
  });

  // An Entgeltsminderung on the purchase side corrects INPUT tax (MWSTG Art. 41 Abs. 2), which is the
  // stated reason `skontoMinor` is refused here. Until that correction exists the write-off must be
  // refused too, and it must never book to 3805 (a RECEIVABLE-loss account).
  if (pay.ok) {
    const legs = legsOf(t.store, t.workspaceId, pay.entryId);
    assert.ok(
      !legs.some((l) => l.number === '3805'),
      `a supplier waiver was credited to 3805 Verluste aus Forderungen: ${JSON.stringify(legs)}`,
    );
  }
  assert.equal(pay.ok, false, 'a purchase-side write-off posted with no Vorsteuerkorrektur');
});

// --- F3 -------------------------------------------------------------------------------------------

test('F3: 1100 Debitoren is refused as the cost side of a vendor bill', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const custId = addCustomer(t.ctx, 'Kunde AG', 'f3-cust');
  issueInvoice(t.ctx, { contactId: custId, key: 'f3-inv' });
  const before = listOpenItems(t.ctx, {});
  assert.equal(before.reconciled, true);

  const r = recordExpense(t.ctx, billInput(t, vendorId, { expenseAccountId: t.acc('1100'), idempotencyKey: 'f3' }));
  const after = listOpenItems(t.ctx, {});
  assert.equal(
    after.reconciled,
    true,
    `A16's OP-Liste stopped reconciling (${after.reconciliationDifferenceMinor}) because a purchase debited 1100`,
  );
  assert.equal(r.ok, false, 'a supplier bill was booked onto the receivable account');
});

test('F3b: 1020 Bank and 1000 Kasse are refused as the cost side of a vendor bill', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const bank = recordExpense(t.ctx, billInput(t, vendorId, { expenseAccountId: t.acc('1020'), idempotencyKey: 'f3b-b' }));
  assert.equal(accountBalance(t.store, t.workspaceId, '1020'), 0, 'the bank balance moved with no cash movement');
  assert.equal(bank.ok, false, 'a supplier bill was booked onto the bank account');
});

// --- F4 -------------------------------------------------------------------------------------------

test('F4: a bill dated after today does not make the Kreditoren list report a false mismatch', () => {
  const t = setup(); // the fixture clock is 2026-07-19
  const vendorId = addVendor(t.ctx);
  const r = recordExpense(
    t.ctx,
    billInput(t, vendorId, {
      billDate: '2026-08-01',
      supplyDate: '2026-08-01',
      dueDate: '2026-08-31',
      idempotencyKey: 'f4',
    }),
  );
  assert.equal(r.ok, true);
  const l = listVendorBills(t.ctx, {});
  assert.equal(
    l.reconciled,
    true,
    `reconciled:false with a difference of ${l.reconciliationDifferenceMinor} on a workspace with one ` +
      'correctly posted bill: the open total counts every date, the 2000 balance stops at today',
  );
});

// --- F5 -------------------------------------------------------------------------------------------

test('F5: the on-account term follows the LEG, not the caller-supplied counterparty kind', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx, 'Beides GmbH', 'f5-v', 'both');
  const bill = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'f5-bill' }));
  const pay = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-05',
    amountMinor: 200000,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: vendorId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'f5-pay',
  });
  assert.equal(pay.ok, true);
  // The entry is right: the vendor-bill target forced the payable side, so 2000 was debited 200'000.
  assert.ok(legsOf(t.store, t.workspaceId, pay.entryId).some((l) => l.number === '2000' && l.debit === 200000));
  const l = listVendorBills(t.ctx, {});
  assert.equal(
    l.reconciled,
    true,
    `reconciled:false (${l.reconciliationDifferenceMinor}) on a correct ledger: the parked 91'900 sits ` +
      'as a debit on 2000 but `supplierOnAccountMinor` filters on counterparty_kind and cannot see it',
  );
});

// --- ROUND 2 (the re-critic's findings, added by the remediation as its regression pins) ----------
//
// R1 and R3 below are the re-critic's two FAIL findings, pinned with the same posture as F1..F5:
// every assertion is about rows and reconciliations, never about a return value alone. R1 covers
// BOTH verb paths (record and allocate: the allocate mirrors are F1/F1b above) and BOTH pairings on
// the record path: the label-versus-target contradiction refuses, and the target-wins pairing that
// F5 pins as lawful stays lawful. R3 covers all four of the re-critic's measured Stichtag cases.

test('R1: record_payment refuses a supplier label beside a customer document, on every alias shape', () => {
  const t = setup();
  const custId = addCustomer(t.ctx, 'Kunde AG', 'r1-cust');
  const inv = issueInvoice(t.ctx, { contactId: custId, key: 'r1-inv' });
  const before = listOpenItems(t.ctx, {});
  assert.equal(before.reconciled, true);

  const attempt = (allocations, key) =>
    recordPayment(t.ctx, {
      direction: 'outgoing',
      date: '2026-07-19',
      amountMinor: 108100,
      bankAccountId: t.bankId,
      counterpartyKind: 'supplier',
      counterpartyId: custId,
      allocations,
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: key,
    });

  const shapes = [
    [{ documentId: inv.id, amountMinor: 108100 }],
    [{ targetId: inv.id, targetKind: 'document', amountMinor: 108100 }],
  ];
  for (const [i, allocations] of shapes.entries()) {
    const res = attempt(allocations, `r1-${i}`);
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, 'allocation_target_side_mismatch');
  }

  // Nothing moved: no payment row, no entry, the invoice fully open on 1100, both sides reconciled.
  assert.equal(
    t.store.db.prepare('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?').get(t.workspaceId).n,
    0,
  );
  assert.equal(accountBalance(t.store, t.workspaceId, '2000'), 0);
  const after = listOpenItems(t.ctx, {});
  assert.equal(after.reconciled, true, JSON.stringify(after));
  assert.equal(after.items.find((x) => x.documentId === inv.id).openMinor, 108100);
  assert.equal(listVendorBills(t.ctx, {}).reconciled, true);
});

test('R1 mirror: a vendor-bill target still WINS over a customer label, exactly as F5 pins', () => {
  // The asymmetry is the design, restated as a test so a symmetric "fix" cannot land quietly: the
  // vendor-bill target FORCES the payable side (the derived label resolves a `both` vendor to
  // `customer`, which is why the target must win), so this pairing books a correct entry and is
  // ACCEPTED. Only a label that would drag a document onto the wrong side refuses.
  const t = setup();
  const vendorId = addVendor(t.ctx, 'Beides GmbH', 'r1m-v', 'both');
  const bill = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'r1m-bill' }));
  const pay = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 108100,
    bankAccountId: t.bankId,
    counterpartyKind: 'customer',
    counterpartyId: vendorId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'r1m-pay',
  });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  assert.ok(legsOf(t.store, t.workspaceId, pay.entryId).some((l) => l.number === '2000' && l.debit === 108100));
  assert.equal(getVendorBill(t.ctx, { vendorBillId: bill.vendorBillId }).vendorBill.settlementStatus, 'paid');
  assert.equal(listVendorBills(t.ctx, {}).reconciled, true);
});

test('R3a: a future-dated bill voided TODAY reconciles today AND on the bill\'s own date', () => {
  const t = setup(); // the fixture clock is 2026-07-19
  const vendorId = addVendor(t.ctx);
  const bill = recordExpense(
    t.ctx,
    billInput(t, vendorId, { billDate: '2026-08-01', supplyDate: '2026-08-01', dueDate: '2026-08-31', idempotencyKey: 'r3a' }),
  );
  assert.equal(bill.ok, true);
  const voided = voidVendorBill(t.ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: 'r3a-void' });
  assert.equal(voided.ok, true, JSON.stringify(voided));

  // Today: the ledger holds ONLY the reversal (the purchase entry is dated next month), and the
  // event-based open total holds the same single event, so the two agree.
  const today = listVendorBills(t.ctx, {});
  assert.equal(today.reconciled, true, JSON.stringify(today));
  assert.equal(today.reconciliationDifferenceMinor, 0);

  // And on 2026-08-15 both events are inside the window on both sides: still reconciled.
  const later = listVendorBills(t.at('2026-08-15T00:00:00.000Z'), {});
  assert.equal(later.reconciled, true, JSON.stringify(later));
});

test('R3b: a current bill voided with a FUTURE date stays open today, and reconciles', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const bill = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'r3b' }));
  const voided = voidVendorBill(t.ctx, {
    vendorBillId: bill.vendorBillId,
    date: '2026-09-01',
    idempotencyKey: 'r3b-void',
  });
  assert.equal(voided.ok, true, JSON.stringify(voided));

  // Today: the purchase entry is on the ledger and the reversal is not yet, so the bill counts as
  // OPEN in the reconciliation whatever its status column says.
  const today = listVendorBills(t.ctx, {});
  assert.equal(today.reconciled, true, JSON.stringify(today));
  assert.equal(today.reconciliationDifferenceMinor, 0);

  // After the reversal's date both sides drop it: still reconciled, and the total is back to zero.
  const later = listVendorBills(t.at('2026-09-15T00:00:00.000Z'), {});
  assert.equal(later.reconciled, true, JSON.stringify(later));
  assert.equal(later.workspaceBaseTotalOpenMinor, 0);
});

test('R3c: the control, a current bill voided today, still reconciles', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const bill = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'r3c' }));
  const voided = voidVendorBill(t.ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: 'r3c-void' });
  assert.equal(voided.ok, true);
  const l = listVendorBills(t.ctx, {});
  assert.equal(l.reconciled, true, JSON.stringify(l));
  assert.equal(l.workspaceBaseTotalOpenMinor, 0);
});

test('R3d: the round-1 case survives round 2: a future-dated bill, NOT voided, reconciles (F4)', () => {
  // F4 above asserts this already; restated beside the void cases so the four Stichtag worlds sit
  // in one place and a regression in any one of them names the exact world that broke.
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const r = recordExpense(
    t.ctx,
    billInput(t, vendorId, { billDate: '2026-08-01', supplyDate: '2026-08-01', dueDate: '2026-08-31', idempotencyKey: 'r3d' }),
  );
  assert.equal(r.ok, true);
  assert.equal(listVendorBills(t.ctx, {}).reconciled, true);
  const later = listVendorBills(t.at('2026-08-15T00:00:00.000Z'), {});
  assert.equal(later.reconciled, true);
  assert.equal(later.workspaceBaseTotalOpenMinor, 108100);
});

test('R3e: a settlement reversed with a FUTURE date still counts as settled today (the payment mirror)', () => {
  // The R3 principle applied to the settlement leg, pinned by the remediation: the ledger as of
  // today holds the payment's debit on 2000 and not yet the reversal's credit, so the bounded
  // settled amount must count the payment even though its status already says `reversed`.
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const bill = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'r3e' }));
  const pay = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-10',
    amountMinor: 108100,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'r3e-pay',
  });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  const reversed = reversePayment(t.ctx, {
    paymentId: pay.paymentId,
    date: '2026-09-01',
    intent: PAYMENT_INTENTS.reverse,
    idempotencyKey: 'r3e-rev',
  });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));

  const today = listVendorBills(t.ctx, {});
  assert.equal(today.reconciled, true, JSON.stringify(today));
  // After the reversal's date the bill is open again on both sides: still reconciled.
  const later = listVendorBills(t.at('2026-09-15T00:00:00.000Z'), {});
  assert.equal(later.reconciled, true, JSON.stringify(later));
  assert.equal(later.workspaceBaseTotalOpenMinor, 108100);
});

test('R5: the cash leg refuses the role-map and claims accounts, by number', () => {
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const bill = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'r5' }));
  // 2000 is a liability and fails the TYPE check first; the assets in the set fall to the number
  // check, which is the guard this test exists for (the same split C3's own account test records).
  const expected = {
    1100: 'reserved_account',
    1170: 'reserved_account',
    1109: 'reserved_account',
    1176: 'reserved_account',
    2000: 'not_an_asset_account',
  };
  for (const [number, reason] of Object.entries(expected)) {
    const res = recordPayment(t.ctx, {
      direction: 'outgoing',
      date: '2026-07-19',
      amountMinor: 108100,
      bankAccountId: t.acc(number),
      allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: `r5-${number}`,
    });
    assert.equal(res.ok, false, number);
    assert.equal(res.error, 'needs_bank_account', number);
    assert.equal(res.reason, reason, number);
  }
  // And the two MONEY accounts of C3's block stay what this resolver exists for.
  const cash = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 108100,
    bankAccountId: t.acc('1000'),
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'r5-kasse',
  });
  assert.equal(cash.ok, true, JSON.stringify(cash));
});

// --- ROUND 3 (R6: the on-account term joins the event sum) ----------------------------------------

test('R6a: a parked supplier remainder reversed with a FUTURE date still counts today', () => {
  // The last incomplete instance of the R3 class: `p.status` flips the instant the reversal is
  // recorded, the ledger keeps the 2000 debit until the reversal's own date. The parked 200'000
  // must stay in the on-account term until that date arrives.
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const pay = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-10',
    amountMinor: 200000,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    allocations: [],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'r6a-pay',
  });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  const reversed = reversePayment(t.ctx, {
    paymentId: pay.paymentId,
    date: '2026-09-01',
    intent: PAYMENT_INTENTS.reverse,
    idempotencyKey: 'r6a-rev',
  });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));

  const today = listVendorBills(t.ctx, {});
  assert.equal(today.onAccountMinor, 200000, JSON.stringify(today));
  assert.equal(today.reconciled, true);
  assert.equal(today.reconciliationDifferenceMinor, 0);

  // Past the reversal's date both events are inside the window and net to zero on both sides.
  const later = listVendorBills(t.at('2026-09-15T00:00:00.000Z'), {});
  assert.equal(later.onAccountMinor, 0);
  assert.equal(later.reconciled, true, JSON.stringify(later));
});

test('R6b: a bill payment with a parked remainder, reversed future-dated, reconciles today', () => {
  // The mixed case: 108'100 settles the bill and 91'900 parks, then the whole payment is reversed
  // with a September date. As of today the ledger still holds the full 200'000 debit on 2000, so
  // BOTH the settled share and the parked remainder must still count.
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const bill = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'r6b-bill' }));
  const pay = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-10',
    amountMinor: 200000,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'r6b-pay',
  });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  const reversed = reversePayment(t.ctx, {
    paymentId: pay.paymentId,
    date: '2026-09-01',
    intent: PAYMENT_INTENTS.reverse,
    idempotencyKey: 'r6b-rev',
  });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));

  const today = listVendorBills(t.ctx, {});
  assert.equal(today.onAccountMinor, 91900, JSON.stringify(today));
  assert.equal(today.reconciled, true);

  // After the reversal's date the bill is open again and the remainder is gone, on both sides.
  const later = listVendorBills(t.at('2026-09-15T00:00:00.000Z'), {});
  assert.equal(later.onAccountMinor, 0);
  assert.equal(later.workspaceBaseTotalOpenMinor, 108100);
  assert.equal(later.reconciled, true, JSON.stringify(later));
});

test('R6c: a FUTURE-dated parked payment reversed today contributes the reversal alone', () => {
  // The inverse window: the payment's entry is dated September, its reversal today. The ledger as
  // of today holds only the reversal's 2000 credit, so the on-account term must contribute the
  // NEGATIVE remainder that matches it, exactly as the R3 event sum does for a void.
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const pay = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-09-01',
    amountMinor: 200000,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    allocations: [],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'r6c-pay',
  });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  const reversed = reversePayment(t.ctx, {
    paymentId: pay.paymentId,
    date: '2026-07-19',
    intent: PAYMENT_INTENTS.reverse,
    idempotencyKey: 'r6c-rev',
  });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));

  const today = listVendorBills(t.ctx, {});
  assert.equal(today.onAccountMinor, -200000, JSON.stringify(today));
  assert.equal(today.reconciled, true);

  // Past the payment's own date both events are inside the window: net zero, still reconciled.
  const later = listVendorBills(t.at('2026-09-15T00:00:00.000Z'), {});
  assert.equal(later.onAccountMinor, 0);
  assert.equal(later.reconciled, true, JSON.stringify(later));
});

test('R6d: a FUTURE-dated bill payment reversed today: the settlement leg\'s own inverse window', () => {
  // A17-R8's gap, closed: R6c parks with allocations:[] and therefore never drives
  // `settledOnVendorBill`'s signed factor, so a mutation reverting ONLY that expression to the
  // binary form left all three R6 pins green while the world broke. This is the critic's case (d),
  // asserted on every figure of the signed world at once so the same mutation has nowhere to hide:
  // as of today the ledger holds the bill's credit (108'100) plus the reversal's credit (200'000),
  // 308'100 on 2000; the settled sum contributes the reversal alone (-108'100), so the bill counts
  // 216'200 open; the on-account term contributes the reversed remainder alone (-91'900); and the
  // three net to zero.
  const t = setup();
  const vendorId = addVendor(t.ctx);
  const bill = recordExpense(t.ctx, billInput(t, vendorId, { idempotencyKey: 'r6d-bill' }));
  const pay = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-09-01',
    amountMinor: 200000,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendorId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'r6d-pay',
  });
  assert.equal(pay.ok, true, JSON.stringify(pay));
  const reversed = reversePayment(t.ctx, {
    paymentId: pay.paymentId,
    date: '2026-07-19',
    intent: PAYMENT_INTENTS.reverse,
    idempotencyKey: 'r6d-rev',
  });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));

  const today = listVendorBills(t.ctx, {});
  assert.equal(today.workspaceBaseTotalOpenMinor, 216200, JSON.stringify(today));
  assert.equal(today.onAccountMinor, -91900);
  assert.equal(today.payablesBalanceMinor, 308100);
  assert.equal(today.reconciliationDifferenceMinor, 0);
  assert.equal(today.reconciled, true);

  // Past the payment's own date every event is inside the window on both sides: the bill is simply
  // open again (the reversal undid its settlement) and the parked remainder is gone.
  const later = listVendorBills(t.at('2026-09-15T00:00:00.000Z'), {});
  assert.equal(later.workspaceBaseTotalOpenMinor, 108100, JSON.stringify(later));
  assert.equal(later.onAccountMinor, 0);
  assert.equal(later.reconciled, true);
});
