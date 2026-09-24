// A14: the posting accounts a settlement uses must agree with the SIDE of the books it clears.
//
// `buildLegs` builds every entry as if it were incoming and mirrors it wholesale for an outgoing
// one. That mirror flips debit and credit, which is correct, but it cannot flip an ACCOUNT: a leg
// resolved to the sales-side account stays on the sales-side account no matter which way the money
// moved. So the roles that differ by side have to be chosen before the mirror, not after it.
//
// REWRITTEN FOR A17-R1 (30.07.2026), and the change is worth reading before the tests. This file
// used to reach the supplier branch through the ONLY door that existed before A17: a customer
// DOCUMENT settled under `counterpartyKind: 'supplier'`, which its own comments called a stopgap
// ("A17 owns vendor bills and has not landed"). The re-critic proved that door is itself the R1
// defect: it clears a document against 2000 Kreditoren while 1100 still carries it, so the engine
// now REFUSES it (`allocation_target_side_mismatch`), and these tests could not keep exercising a
// shape the money path rejects by design. The supplier branch is now driven the honest way, through
// REAL vendor bills (A17), and where the old assertions pinned an entry that can no longer exist
// (a purchase-side Skonto: refused, MWSTG Art. 41 Abs. 2) the test now pins the REFUSAL plus the
// side-choice rule read from the role map. Every property that was asserted before, the side of the
// reduction, the code-driven VAT account, the operating FX account, is still asserted; what changed
// is the vehicle that reaches the branch.
//
// ONE HONEST WEAKENING, flagged by the round-3 critic and recorded here rather than papered over:
// the old "VAT correction follows the TAX CODE" test compared the VAT account across the customer
// and supplier BRANCHES of buildLegs on one document. With the cross-labelled run refused, its two
// posting runs (stated vs derived customer label) exercise the SAME branch, so a mutation that
// re-routed the VAT account per side would not turn that comparison red. The cross-side half of
// the invariant is carried structurally instead: `vatRoleFor(kind, formLine, deductible)` takes no
// side or counterparty parameter at all, and the "every seeded tax code routes its correction"
// test below drives that signature over the whole code set, so a side-dependent VAT account cannot
// be expressed without changing a signature this file pins.
//
// Everything below is asserted on the POSTED journal rows read back out of SQLite, joined to the
// chart so the assertions can talk about what an account IS (its type, its label) instead of only
// what it is numbered. A return value would prove what the engine believed it wrote.
//
// PROVENANCE of the numbers (Schweizer Kontenrahmen KMU, Sterchi/Mattle/Helbling), verified
// 2026-07-25 against the full Masterkontenrahmen and two independent reproductions:
//   38  Erlösminderungen ......... 3800 Skonti, 3805 Verluste Forderungen, 3806 Kursdifferenzen
//   49  Einkaufspreisminderungen . 4900 Skonti, 4906 Kursdifferenzen
//   69  Finanzaufwand und Finanzertrag ... 6949 Währungsverluste (gain twin 6999)

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordPayment, PAYMENT_INTENTS, ROLE_ACCOUNT_NUMBER, vatRoleFor } from '../../dist/core/payments/index.js';
import { recordExpense } from '../../dist/core/purchase/index.js';
import { KMU_CORE_SEED } from '../../dist/core/accounts/index.js';
import { DEFAULT_TAX_CODES } from '../../dist/core/vat/index.js';
import { setup, issueInvoice, seedRate, accountBalance } from './support.mjs';
import { addVendor } from '../purchase/support.mjs';

const seededByNumber = Object.fromEntries(KMU_CORE_SEED.map((a) => [a.number, a]));

/**
 * The posted rows of one entry, joined to the chart. `type` and `name` are what let the assertions
 * below describe the PROPERTY a leg must have rather than the number this fix happens to pick.
 */
function legsOf(store, workspaceId, entryId) {
  return store.db
    .prepare(
      `SELECT a.number AS number, a.name AS name, a.type AS type,
              l.debit_minor AS debit, l.credit_minor AS credit, l.tax_code AS taxCode
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? AND a.workspace_id = ?
        ORDER BY a.number`,
    )
    .all(entryId, workspaceId);
}

// --- the Skonto and its VAT correction follow the subledger, not the sales side -----------------

/**
 * The canonical Skonto fixture from `record.test.mjs`: gross 1'081.00, of which 1'059.38 is paid
 * and 20.00 is a net Skonto that reverses 1.62 of MWST.
 *
 * `counterpartyKind` may be stated or left for the engine to derive. What it may NOT do since
 * A17-R1 is contradict the target: `'supplier'` beside a document allocation is refused before
 * anything posts, which retired this helper's old second job of sneaking onto the supplier branch.
 */
function settleWithSkonto(t, { key, counterpartyKind }) {
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key });
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 105938,
    bankAccountId: t.bankId,
    ...(counterpartyKind !== undefined ? { counterpartyKind } : {}),
    allocations: [{ documentId: inv.id, amountMinor: 105938, skontoMinor: 2000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: `p-${key}`,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return legsOf(t.store, t.workspaceId, res.entryId);
}

/** One posted vendor bill (A17), the honest vehicle onto the supplier branch of `buildLegs`. */
function postVendorBillFor(t, ctx, vendorId, { key, currency, amountMinor = 100000, billDate }) {
  const res = recordExpense(ctx, {
    vendorId,
    billDate,
    dueDate: billDate,
    amountMinor,
    amountIsGross: true,
    taxCode: null,
    expenseAccountId: t.acc('6500'),
    ...(currency !== undefined ? { currency } : {}),
    idempotencyKey: `vb-${key}`,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
}

/** Split an entry into the roles a settlement plays, keyed on structure rather than on numbers. */
function partsOf(legs, { bankNumber }) {
  const bank = legs.find((l) => l.number === bankNumber);
  const rest = legs.filter((l) => l !== bank);
  // The counter leg is the subledger position being cleared, and it is the only leg on the credit
  // side of an incoming settlement: cash, the reduction and its VAT correction are all debits.
  const counter = rest.find((l) => l.credit > 0);
  // The reduction leg carries the §H-VAT-TRACE, because the trace rides the line whose booked
  // amount IS the tax base. The one leg left over is therefore the VAT correction itself.
  const reduction = rest.find((l) => l.taxCode !== null);
  const vat = rest.find((l) => l !== counter && l !== reduction);
  assert.ok(bank && counter && reduction && vat, `unexpected entry shape: ${JSON.stringify(legs)}`);
  return { bank, counter, reduction, vat };
}

test('a Skonto reduces the side of the books its settlement actually clears', () => {
  // THE INVARIANT. A discount reduces the same side of the Erfolgsrechnung as the subledger
  // position it settles against:
  //
  //   clearing a RECEIVABLE: the CUSTOMER took the discount, so it reduces REVENUE.
  //   clearing a PAYABLE:    the BUSINESS took it, so it reduces COST.
  //
  // Crossing them is not a naming slip: a purchase discount booked through revenue inflates
  // turnover and expenses in the same entry, and both statements come out wrong.
  //
  // REWRITTEN FOR A17-R1: the supplier half used to be driven end to end through a customer
  // document labelled `supplier`, and that vehicle is the R1 defect, now refused. A REAL
  // purchase-side Skonto is refused too (Art. 41 Abs. 2, until the Vorsteuer-correction leg
  // exists), so there is no lawful entry left for the old assertions to run against: the payable
  // half of the invariant is pinned as (a) both refusals, engine-side, and (b) the side-choice
  // RULE itself, read from the role map against the shipped chart, which is exactly the fact
  // `buildLegs` resolves the account from.
  const t = setup();
  const customer = partsOf(settleWithSkonto(t, { key: 'sk-cust', counterpartyKind: 'customer' }), {
    bankNumber: '1020',
  });
  assert.equal(customer.counter.type, 'asset', 'the customer settlement clears a receivable');
  assert.equal(customer.reduction.type, 'income', 'a discount a customer took reduces REVENUE');
  assert.equal(customer.reduction.debit, 2000, 'the net Skonto, verbatim');
  assert.equal(customer.vat.debit, 162, 'the 8.1% on a 20.00 Skonto, reversed');
  for (const l of [customer.reduction, customer.vat]) {
    assert.ok(seededByNumber[l.number], `${l.number} is part of the shipped core seed`);
  }

  // (a) The old vehicle is refused: a supplier label may not outvote a document target (A17-R1).
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'sk-supp-door' });
  const door = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 105938,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    allocations: [{ documentId: inv.id, amountMinor: 105938, skontoMinor: 2000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-sk-supp-door',
  });
  assert.equal(door.ok, false);
  assert.equal(door.error, 'allocation_target_side_mismatch');

  // (a') And a real purchase-side Skonto, on a real vendor bill, is refused with its own reason.
  const vendorId = addVendor(t.ctx, 'Lieferant GmbH', 'sk-vendor');
  const bill = postVendorBillFor(t, t.ctx, vendorId, { key: 'sk-bill', billDate: '2026-07-10' });
  const purchaseSkonto = recordPayment(t.ctx, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 98000,
    bankAccountId: t.bankId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 98000, skontoMinor: 2000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-sk-bill',
  });
  assert.equal(purchaseSkonto.ok, false);
  assert.equal(purchaseSkonto.reason, 'skonto_only_on_incoming_invoice_payments');

  // (b) The side-choice rule, pinned on the same facts `buildLegs` resolves from: the two Skonto
  // roles differ by side, land in the two mirrored chart blocks, and carry the right types.
  assert.notEqual(ROLE_ACCOUNT_NUMBER.salesSkonto, ROLE_ACCOUNT_NUMBER.purchaseSkonto);
  assert.equal(customer.reduction.number, ROLE_ACCOUNT_NUMBER.salesSkonto);
  assert.equal(seededByNumber[ROLE_ACCOUNT_NUMBER.salesSkonto].type, 'income');
  assert.equal(seededByNumber[ROLE_ACCOUNT_NUMBER.purchaseSkonto].type, 'expense');
});

test('the VAT correction follows the TAX CODE, not the counterparty', () => {
  // THE INVARIANT, and it is the one this file got wrong on the first pass. A VAT correction is not
  // A14's to place. The code on the corrected line already records whether the business CHARGED
  // that tax or RECLAIMED it, A05 routes a code to its account by exactly that fact, and A02's
  // post-boundary gate recomputes the expected movement from the same code. Choosing the account
  // from a counterparty label instead produces an entry that cannot post at all.
  //
  // REWRITTEN FOR A17-R1: the old second run settled the SAME document under a `supplier` label to
  // show the VAT account did not move with the counterparty. That labelling is now refused outright
  // (the label may not outvote the target), which enforces this invariant one step earlier: the
  // counterparty CANNOT reroute the correction, because a label that disagrees with the target no
  // longer produces an entry at all. What remains measurable is that a stated and an engine-derived
  // customer label produce the identical correction, and that the old cross-labelling refuses.
  const t = setup();
  const stated = partsOf(settleWithSkonto(t, { key: 'vat-cust', counterpartyKind: 'customer' }), {
    bankNumber: '1020',
  });
  const derived = partsOf(settleWithSkonto(t, { key: 'vat-derived' }), { bankNumber: '1020' });

  assert.equal(stated.reduction.taxCode, derived.reduction.taxCode, 'same code on the traced line');
  assert.equal(stated.vat.number, derived.vat.number, 'one tax code, one VAT account');
  assert.equal(stated.vat.type, 'liability', 'an output code reverses tax the business owes the ESTV');
  assert.equal(stated.vat.debit, 162, 'the 8.1% on a 20.00 Skonto, reversed');
  assert.equal(derived.vat.debit, 162);

  // The cross-labelled run that used to sit here is refused before any leg is built (A17-R1).
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'vat-supp' });
  const crossed = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 105938,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    allocations: [{ documentId: inv.id, amountMinor: 105938, skontoMinor: 2000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-vat-supp',
  });
  assert.equal(crossed.ok, false);
  assert.equal(crossed.error, 'allocation_target_side_mismatch');
});

test('every seeded tax code routes its correction to the account its ESTV form line implies', () => {
  // The input-side branch cannot be driven end to end yet: no document can carry an input code
  // until A17 builds vendor bills (A11 posts an invoice through the output path, and A02 rejects an
  // input code on it). So the routing rule is asserted directly, and against the SEEDED codes
  // rather than literals invented here, so it stays true as the code set grows.
  //
  // The rule is A05's: output tax is a LIABILITY the business owes the ESTV; deductible input tax
  // is an ASSET it may reclaim, split across Ziffer 400 and Ziffer 405 exactly as the MWST-
  // Abrechnung splits it. Anything that corrects across more than one leg is refused, not guessed.
  for (const c of DEFAULT_TAX_CODES) {
    const role = vatRoleFor(c.kind, c.formLine, c.kind === 'input');
    if (c.kind === 'output') {
      assert.equal(role, 'outputVat', `${c.code} is an output code`);
      assert.equal(seededByNumber[ROLE_ACCOUNT_NUMBER[role]].type, 'liability', `${c.code} owes the ESTV`);
    } else if (c.kind === 'input') {
      assert.ok(role, `${c.code} is a deductible input code and must route somewhere`);
      const account = seededByNumber[ROLE_ACCOUNT_NUMBER[role]];
      assert.equal(account.type, 'asset', `${c.code} is reclaimable from the ESTV`);
      assert.equal(
        account.number,
        c.formLine === '405' ? '1171' : '1170',
        `${c.code} reports on ESTV Ziffer ${c.formLine} and must correct the account that carries it`,
      );
    } else {
      assert.equal(role, null, `${c.code} (${c.kind}) corrects across more than one leg, so A14 refuses it`);
    }
  }

  // A non-deductible input code folds the tax into the cost rather than splitting it out, so there
  // is no single VAT leg to correct and the answer is a refusal, not 1170.
  assert.equal(vatRoleFor('input', '400', false), null);
});

test('a supplier settlement never touches a revenue account', () => {
  // The narrowest reading of the defect, and the one a Treuhänder would spot first: an entry that
  // clears a PAYABLE has no business moving anything in the revenue block. If it does, the same
  // entry has inflated turnover and expenses at once, and both statements are wrong.
  //
  // REWRITTEN FOR A17-R1: driven through a REAL vendor bill now (the old supplier-labelled document
  // is refused), in EUR across a rate move, so the entry carries a genuine difference leg and the
  // assertion covers more than the trivial two-line settlement.
  const t = setup({ at: '2026-07-01T00:00:00.000Z' });
  const vendorId = addVendor(t.ctx, 'Lieferant GmbH', 'rev-vendor');
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-01' });
  const bill = postVendorBillFor(t, t.ctx, vendorId, { key: 'rev-bill', currency: 'EUR', billDate: '2026-07-01' });

  const late = t.at('2026-07-19T00:00:00.000Z');
  seedRate(late, { currency: 'EUR', rate: '0.97', asOf: '2026-07-19' });
  const res = recordPayment(late, {
    direction: 'outgoing',
    date: '2026-07-19',
    amountMinor: 100000,
    currency: 'EUR',
    bankAccountId: t.bankId,
    allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 100000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-rev-bill',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const legs = legsOf(t.store, t.workspaceId, res.entryId);
  assert.ok(legs.some((l) => l.number === '2000'), 'the settlement really cleared the payable');
  assert.ok(legs.length > 2, 'the rate moved, so a difference leg is present');
  const revenue = legs.filter((l) => l.type === 'income');
  assert.deepEqual(revenue, [], `a purchase settlement moved a revenue account: ${JSON.stringify(revenue)}`);
});

// --- the realised difference on a trade settlement is OPERATING, and nets in one account --------

/**
 * One EUR 1'000.00 invoice booked at each of two rates, then each settled on a day the rate has
 * moved again: one settles into a GAIN, the other into a LOSS, in the same workspace.
 */
function twoSettlementsAcrossOppositeRateMoves(t, { counterpartyKind }) {
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-01' });
  const gainInv = issueInvoice(t.ctx, {
    contactId: t.customerId,
    netMinor: 100000,
    taxCode: 'none',
    currency: 'EUR',
    key: `fx-gain-${counterpartyKind}`,
  });

  const mid = t.at('2026-07-19T00:00:00.000Z');
  seedRate(mid, { currency: 'EUR', rate: '0.97', asOf: '2026-07-19' });
  const lossInv = issueInvoice(mid, {
    contactId: t.customerId,
    netMinor: 100000,
    taxCode: 'none',
    currency: 'EUR',
    key: `fx-loss-${counterpartyKind}`,
  });

  const pay = (ctx, inv, date, key) => {
    const res = recordPayment(ctx, {
      direction: 'incoming',
      date,
      amountMinor: 100000,
      currency: 'EUR',
      bankAccountId: t.bankId,
      counterpartyKind,
      allocations: [{ documentId: inv.id, amountMinor: 100000 }],
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: key,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    return legsOf(t.store, t.workspaceId, res.entryId);
  };

  // Booked at 0.95, settled at 0.97: more base arrived than the position carried, so a GAIN.
  const gainLegs = pay(mid, gainInv, '2026-07-19', `p-fx-gain-${counterpartyKind}`);

  const late = t.at('2026-07-25T00:00:00.000Z');
  seedRate(late, { currency: 'EUR', rate: '0.93', asOf: '2026-07-25' });
  // Booked at 0.97, settled at 0.93: less base arrived than the position carried, so a LOSS.
  const lossLegs = pay(late, lossInv, '2026-07-25', `p-fx-loss-${counterpartyKind}`);

  // Both figures are computed HERE from the four rates, never read off the engine, so a wrong plug
  // cannot agree with them by construction.
  const gainMinor = Math.round(100000 * 0.97) - Math.round(100000 * 0.95); // 2'000 Rappen gained
  const lossMinor = Math.round(100000 * 0.97) - Math.round(100000 * 0.93); // 4'000 Rappen lost
  return { gainLegs, lossLegs, gainMinor, lossMinor };
}

/** The one leg of an entry that is neither the bank nor the subledger position it cleared. */
function differenceLeg(legs) {
  const rest = legs.filter((l) => !['1020', '1100', '2000'].includes(l.number));
  assert.equal(rest.length, 1, `exactly one difference leg, got ${JSON.stringify(legs)}`);
  return rest[0];
}

test('a realised gain and a realised loss net in ONE account, and it is an operating one', () => {
  // THE INVARIANT, in four parts. A14 settles trade receivables and payables. The difference
  // between the rate a position was booked at and the rate it settled at is realised the moment it
  // settles, and it is OPERATING activity, not a financial result.
  //
  //   1. the gain is a CREDIT and the loss a DEBIT on the SAME account, so the two net
  //   2. that account's net movement is exactly the algebraic sum of the two rate moves
  //   3. the account can hold BOTH signs honestly: its label does not name one direction, because
  //      an account called "losses" carrying a credit balance is a lie a reader cannot see through
  //   4. the financial-result currency account is UNTOUCHED. Revaluing a financial position at
  //      period end is A22's job and a genuinely different event; a trade settlement must not
  //      quietly land in the same place.
  const t = setup({ at: '2026-07-01T00:00:00.000Z' });
  const { gainLegs, lossLegs, gainMinor, lossMinor } = twoSettlementsAcrossOppositeRateMoves(t, {
    counterpartyKind: 'customer',
  });

  const gain = differenceLeg(gainLegs);
  const loss = differenceLeg(lossLegs);

  // 1. one account, both directions.
  assert.equal(gain.number, loss.number, 'a gain and a loss land in the same account');
  assert.equal(gain.credit, gainMinor, 'the gain is credited, at the rate move on the settled amount');
  assert.equal(gain.debit, 0);
  assert.equal(loss.debit, lossMinor, 'the loss is debited, at the rate move on the settled amount');
  assert.equal(loss.credit, 0);

  // 2. and they NET, which is the whole point of putting them in one place.
  assert.equal(
    accountBalance(t.store, t.workspaceId, gain.number),
    lossMinor - gainMinor,
    'the two rate moves net against each other in the one account',
  );

  // 3. an account that must carry both signs may not be named for one of them.
  assert.doesNotMatch(
    gain.name,
    /verlust|gewinn/i,
    `${gain.number} "${gain.name}" is named for one direction but has to hold both`,
  );

  // 4. operating, not financial result. A trade settlement leaves the Finanzaufwand alone.
  assert.equal(gain.type, 'income', 'a customer-side difference is an Erlösminderung, an operating line');
  assert.equal(
    accountBalance(t.store, t.workspaceId, '6949'),
    0,
    '6949 Währungsverluste is A22\'s period-end revaluation account, not A14\'s settlement account',
  );

  // Both entries still balance to the Rappen, which the plug is what guarantees.
  for (const legs of [gainLegs, lossLegs]) {
    assert.equal(
      legs.reduce((n, l) => n + l.debit, 0),
      legs.reduce((n, l) => n + l.credit, 0),
    );
  }
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 0, 'both receivables are fully released');
  assert.ok(seededByNumber[gain.number], `${gain.number} is part of the shipped core seed`);
});

test('the realised difference follows the subledger side, exactly as the Skonto does', () => {
  // Same event, other side of the books. A difference realised on clearing a PAYABLE is a purchase
  // price adjustment, not a revenue adjustment: the position that moved was a cost, so the
  // correction belongs in the expense block. The two sides must not share one account, for the
  // same reason 3800 and 4900 do not.
  //
  // REWRITTEN FOR A17-R1: driven through two REAL EUR vendor bills (the old supplier-labelled
  // documents are refused). Booked at 0.95 and paid at 0.97 the business pays MORE base than the
  // payable carried, a loss; booked at 0.97 and paid at 0.93 it pays LESS, a gain. Both figures
  // are computed HERE from the rates, never read off the engine, exactly as the customer test
  // computes its own.
  const t = setup({ at: '2026-07-01T00:00:00.000Z' });
  const vendorId = addVendor(t.ctx, 'Lieferant GmbH', 'fx-vendor');
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-01' });
  const lossBill = postVendorBillFor(t, t.ctx, vendorId, { key: 'fx-loss', currency: 'EUR', billDate: '2026-07-01' });

  const mid = t.at('2026-07-19T00:00:00.000Z');
  seedRate(mid, { currency: 'EUR', rate: '0.97', asOf: '2026-07-19' });
  const gainBill = postVendorBillFor(t, mid, vendorId, { key: 'fx-gain', currency: 'EUR', billDate: '2026-07-19' });

  const pay = (ctx, vendorBillId, date, key) => {
    const res = recordPayment(ctx, {
      direction: 'outgoing',
      date,
      amountMinor: 100000,
      currency: 'EUR',
      bankAccountId: t.bankId,
      allocations: [{ vendorBillId, amountMinor: 100000 }],
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: key,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    return legsOf(t.store, t.workspaceId, res.entryId);
  };

  // Booked at 0.95, paid at 0.97: paying MORE base than the payable carried, a LOSS, debited.
  const lossLegs = pay(mid, lossBill.vendorBillId, '2026-07-19', 'p-fx-loss');
  const late = t.at('2026-07-25T00:00:00.000Z');
  seedRate(late, { currency: 'EUR', rate: '0.93', asOf: '2026-07-25' });
  // Booked at 0.97, paid at 0.93: paying LESS base than the payable carried, a GAIN, credited.
  const gainLegs = pay(late, gainBill.vendorBillId, '2026-07-25', 'p-fx-gain');

  const lossMinor = Math.round(100000 * 0.97) - Math.round(100000 * 0.95); // 2'000 Rappen lost
  const gainMinor = Math.round(100000 * 0.97) - Math.round(100000 * 0.93); // 4'000 Rappen gained

  const gain = differenceLeg(gainLegs);
  const loss = differenceLeg(lossLegs);

  assert.equal(gain.number, loss.number, 'one account holds both directions on this side too');
  assert.equal(gain.type, 'expense', 'a supplier-side difference is an Einkaufspreisminderung');
  assert.doesNotMatch(gain.name, /verlust|gewinn/i);
  assert.equal(accountBalance(t.store, t.workspaceId, '6949'), 0, 'still not the financial-result account');
  assert.ok(seededByNumber[gain.number], `${gain.number} is part of the shipped core seed`);

  // The mirror flips the SIGN, never the meaning: on a payable, paying less base than the position
  // carried is still the favourable direction, so it is still the credit.
  assert.equal(gain.credit, gainMinor);
  assert.equal(loss.debit, lossMinor);
  assert.equal(
    accountBalance(t.store, t.workspaceId, gain.number),
    lossMinor - gainMinor,
    'the two rate moves net against each other',
  );
});
