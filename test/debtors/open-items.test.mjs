// A16 §8, the open-items read model: the OP-Liste, its aging buckets, and the one invariant that
// makes the whole capability worth having.
//
// THE RECONCILIATION IS THE POINT. Every other assertion here is a detail of presentation; the
// property that `baseTotalOpenMinor` equals the posted balance of account 1100 Debitoren as of the
// same date is what makes this a receivables ledger rather than a plausible-looking table. It is
// asserted from a query written in the test's own words (`receivablesBalance`), never through a
// helper shared with the code under test, so the two derivations agree only if they are both right.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listOpenItems,
  customerBalance,
  agingReport,
  setAgingBucketConfig,
} from '../../dist/core/debtors/index.js';
import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';

import {
  setup,
  secondWorkspace,
  addCustomer,
  issueInvoice,
  receivablesBalance,
  itemFor,
  GROSS_MINOR,
} from './support.mjs';

/**
 * Four invoices issued on four different days, one settled in full, one settled in part.
 *
 * The dates are spread on purpose: a fixture where everything happens on one day cannot tell a
 * point-in-time read model apart from a broken one, and cannot tell an aging bucket apart from a
 * constant.
 */
function fixture() {
  const t = setup();
  const c2 = addCustomer(t.ctx, 'Zweite Kundin GmbH', 'c-two');

  const inv1 = issueInvoice(t.at('2026-03-01T00:00:00.000Z'), {
    contactId: t.customerId,
    dueDate: '2026-03-31',
    key: 'inv1',
  });
  const inv2 = issueInvoice(t.at('2026-05-10T00:00:00.000Z'), {
    contactId: t.customerId,
    dueDate: '2026-06-09',
    key: 'inv2',
  });
  const inv3 = issueInvoice(t.at('2026-07-01T00:00:00.000Z'), {
    contactId: t.customerId,
    dueDate: '2026-07-31',
    key: 'inv3',
  });
  const inv4 = issueInvoice(t.at('2026-06-01T00:00:00.000Z'), {
    contactId: c2,
    dueDate: '2026-06-15',
    key: 'inv4',
  });

  // Settles inv1 outright, on a day after the point-in-time cut-off the tests below use.
  const full = recordPayment(t.at('2026-06-20T00:00:00.000Z'), {
    direction: 'incoming',
    date: '2026-06-20',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: inv1.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'pay-inv1',
  });
  assert.equal(full.ok, true, JSON.stringify(full));

  // Half of inv2, so a partly-paid item carries an exact remainder rather than a round one.
  const partial = recordPayment(t.at('2026-07-05T00:00:00.000Z'), {
    direction: 'incoming',
    date: '2026-07-05',
    amountMinor: 50000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: inv2.id, amountMinor: 50000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'pay-inv2-partial',
  });
  assert.equal(partial.ok, true, JSON.stringify(partial));

  return { t, c2, inv1, inv2, inv3, inv4 };
}

test('A16 §8a/§8b: open is gross minus what was allocated, and a settled invoice leaves the list', () => {
  const { t, inv1, inv2, inv3, inv4 } = fixture();

  const res = listOpenItems(t.ctx, {});
  assert.equal(res.ok, true, JSON.stringify(res));

  assert.equal(
    res.items.some((i) => i.documentId === inv1.id),
    false,
    'an invoice settled to the Rappen is not an open item',
  );

  const two = itemFor(res, inv2.number);
  assert.equal(two.grossMinor, GROSS_MINOR);
  assert.equal(two.paidMinor, 50000);
  assert.equal(two.openMinor, GROSS_MINOR - 50000);
  assert.equal(two.baseOpenMinor, GROSS_MINOR - 50000);

  const three = itemFor(res, inv3.number);
  assert.equal(three.paidMinor, 0);
  assert.equal(three.openMinor, GROSS_MINOR);

  const four = itemFor(res, inv4.number);
  assert.equal(four.openMinor, GROSS_MINOR);

  assert.equal(res.items.length, 3);
  assert.equal(res.totalOpenMinor, GROSS_MINOR * 2 + (GROSS_MINOR - 50000));
});

test('A16 §8e: the grand total reconciles to account 1100 Debitoren, to the Rappen', () => {
  const { t } = fixture();

  const res = listOpenItems(t.ctx, {});
  const ledger = receivablesBalance(t.store, t.workspaceId, '2026-07-19');

  assert.equal(res.baseTotalOpenMinor, ledger);
  assert.equal(res.reconciled, true);
  assert.equal(res.receivablesBalanceMinor, ledger);
  // Not a tautology guard: the fixture must actually have receivables, or `0 === 0` would pass on a
  // read model that returned nothing at all.
  assert.ok(ledger > 0, 'the fixture must carry a real receivable balance');
});

test('A16 §8f: a past asOf ignores every payment and every invoice that came later', () => {
  const { t, inv1, inv2, inv3, inv4 } = fixture();

  const res = listOpenItems(t.ctx, { asOf: '2026-06-05' });
  assert.equal(res.ok, true, JSON.stringify(res));

  const one = itemFor(res, inv1.number);
  assert.ok(one, 'the invoice settled on 2026-06-20 is still an open item on 2026-06-05');
  assert.equal(one.openMinor, GROSS_MINOR, 'the 2026-06-20 settlement had not happened yet');

  const two = itemFor(res, inv2.number);
  assert.ok(two, 'the partly-paid invoice is still fully open on 2026-06-05');
  assert.equal(two.openMinor, GROSS_MINOR, 'the 2026-07-05 partial had not happened yet');

  assert.equal(
    res.items.some((i) => i.documentId === inv3.id),
    false,
    'an invoice issued on 2026-07-01 is not a receivable on 2026-06-05',
  );
  assert.ok(itemFor(res, inv4.number));

  assert.equal(res.totalOpenMinor, GROSS_MINOR * 3);
  assert.equal(res.baseTotalOpenMinor, receivablesBalance(t.store, t.workspaceId, '2026-06-05'));
  assert.equal(res.reconciled, true);
});

test('A16 §8d: daysOverdue and bucket follow the due date, and a not-yet-due item is neither', () => {
  const { t, inv2, inv3, inv4 } = fixture();

  const res = listOpenItems(t.ctx, {});

  const three = itemFor(res, inv3.number);
  assert.equal(three.daysOverdue, 0, 'due 2026-07-31 is not overdue on 2026-07-19');
  assert.equal(three.overdue, false);
  assert.equal(three.bucket, '0-30');

  const two = itemFor(res, inv2.number);
  assert.equal(two.daysOverdue, 40, '2026-06-09 to 2026-07-19');
  assert.equal(two.overdue, true);
  assert.equal(two.bucket, '31-60');

  const four = itemFor(res, inv4.number);
  assert.equal(four.daysOverdue, 34, '2026-06-15 to 2026-07-19');
  assert.equal(four.bucket, '31-60');

  // A15 is not built, so there is no dunning state to read and the level is 0 rather than invented.
  assert.equal(two.dunningLevel, 0);
});

test('A16 §8d: an item sitting exactly ON a boundary falls in the lower bucket, not the next one', () => {
  // The fixture above has ages 0, 34 and 40, none of which touches a boundary, so it cannot tell
  // `<= 30` apart from `< 30`. Mutating that comparison left every other case in this file green.
  // Four due dates land the ages exactly on 30, 60 and 90 and one day past 90, which is the whole
  // of the boundary behaviour: an inclusive upper edge, and nothing above the last boundary.
  const t = setup();
  const june = t.at('2026-01-05T00:00:00.000Z');
  const exact = [
    ['2026-06-19', 30, '0-30'],
    ['2026-05-20', 60, '31-60'],
    ['2026-04-20', 90, '61-90'],
    ['2026-04-19', 91, '90+'],
  ];
  const numbers = exact.map(([dueDate], i) => {
    const inv = issueInvoice(june, { contactId: t.customerId, dueDate, key: `edge-${i}` });
    return inv.number;
  });

  const res = listOpenItems(t.ctx, {});
  for (const [i, [dueDate, days, bucket]] of exact.entries()) {
    const item = itemFor(res, numbers[i]);
    assert.ok(item, `${dueDate} must be an open item`);
    assert.equal(item.daysOverdue, days, `${dueDate} is ${days} days overdue on 2026-07-19`);
    assert.equal(item.bucket, bucket, `${days} days overdue belongs in ${bucket}`);
  }
  assert.equal(
    Object.values(res.bucketTotals).reduce((n, v) => n + v, 0),
    res.totalOpenMinor,
  );
});

test('A16 §8: the list leads with the most overdue item, not the newest one', () => {
  const { t, inv2, inv3, inv4 } = fixture();

  const res = listOpenItems(t.ctx, {});
  assert.deepEqual(
    res.items.map((i) => i.number),
    [inv2.number, inv4.number, inv3.number],
    'oldest due date first: an OP-Liste exists to be worked from the top down',
  );
});

test('A16 §8c: bucket subtotals sum to the grand total, under the default boundaries and a custom set', () => {
  const { t } = fixture();

  const res = listOpenItems(t.ctx, {});
  assert.deepEqual(res.boundariesDays, [30, 60, 90]);
  assert.deepEqual(Object.keys(res.bucketTotals), ['0-30', '31-60', '61-90', '90+']);
  assert.equal(res.bucketTotals['0-30'], GROSS_MINOR);
  assert.equal(res.bucketTotals['31-60'], GROSS_MINOR + (GROSS_MINOR - 50000));
  assert.equal(res.bucketTotals['61-90'], 0);
  assert.equal(res.bucketTotals['90+'], 0);

  const sum = (r) => Object.values(r.bucketTotals).reduce((n, v) => n + v, 0);
  assert.equal(sum(res), res.totalOpenMinor);

  // Re-partitioning must never change the total: that is what makes the reconciliation hold for ANY
  // boundary configuration rather than only for the shipped default.
  const set = setAgingBucketConfig(t.ctx, { boundariesDays: [15, 45], idempotencyKey: 'bounds-1' });
  assert.equal(set.ok, true, JSON.stringify(set));

  const custom = listOpenItems(t.ctx, {});
  assert.deepEqual(Object.keys(custom.bucketTotals), ['0-15', '16-45', '45+']);
  assert.equal(custom.totalOpenMinor, res.totalOpenMinor);
  assert.equal(sum(custom), custom.totalOpenMinor);
  assert.equal(custom.baseTotalOpenMinor, res.baseTotalOpenMinor);
  assert.equal(custom.reconciled, true);
});

test('A16 §2: an empty workspace reconciles at zero rather than erroring (P9)', () => {
  const t = setup();

  const res = listOpenItems(t.ctx, {});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.items, []);
  assert.equal(res.totalOpenMinor, 0);
  assert.equal(res.reconciled, true, '0 == 0 is a held reconciliation, not an absent one');
  assert.deepEqual(res.bucketTotals, { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 });
});

test('A16 §8g: an over-payment is a negative open item and nets into the customer balance', () => {
  const t = setup();
  const inv = issueInvoice(t.at('2026-06-01T00:00:00.000Z'), {
    contactId: t.customerId,
    dueDate: '2026-06-15',
    key: 'inv-over',
  });

  const paid = recordPayment(t.at('2026-07-01T00:00:00.000Z'), {
    direction: 'incoming',
    date: '2026-07-01',
    amountMinor: GROSS_MINOR + 20000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'pay-over',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));

  const res = listOpenItems(t.ctx, {});
  const credit = res.items.find((i) => i.kind === 'on_account');
  assert.ok(credit, 'a parked Guthaben is an open item with a negative sign, never an invisible one');
  assert.equal(credit.openMinor, -20000);
  assert.equal(credit.baseOpenMinor, -20000);
  assert.equal(credit.customerId, t.customerId);
  assert.equal(credit.documentId, null);

  assert.equal(res.totalOpenMinor, -20000);
  assert.equal(res.baseTotalOpenMinor, receivablesBalance(t.store, t.workspaceId, '2026-07-19'));
  assert.equal(res.reconciled, true);

  const bal = customerBalance(t.ctx, { customerId: t.customerId });
  assert.equal(bal.ok, true, JSON.stringify(bal));
  assert.equal(bal.onAccountMinor, 20000);
  assert.equal(bal.totalOpenMinor, -20000);
});

// --- Finding F13, the direction a parked row is in ---------------------------------------------
//
// `collectOpenItems` builds an `on_account` row for EVERY unallocated payment attached to a
// customer, in both directions, and their signs are opposite: incoming money parked on account
// reduces the receivable, outgoing money parked against a customer (a refund awaiting its credit
// note) increases it. A surface that labels every parked row "Guthaben" therefore says the opposite
// of the fact for half of them, and until this field existed the only way to tell them apart was to
// read the sign, which is exact and fragile.

test('A16 F13: an OUTGOING payment to a customer is a parked row, positive, and says so', () => {
  const t = setup();
  issueInvoice(t.at('2026-06-01T00:00:00.000Z'), {
    contactId: t.customerId,
    dueDate: '2026-06-15',
    key: 'inv-refund',
  });

  // A refund paid out and not yet matched to anything. No allocation, so the whole amount parks.
  const refund = recordPayment(t.at('2026-07-02T00:00:00.000Z'), {
    direction: 'outgoing',
    date: '2026-07-02',
    amountMinor: 15000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'refund-1',
  });
  assert.equal(refund.ok, true, JSON.stringify(refund));

  const res = listOpenItems(t.ctx, {});
  const parked = res.items.find((i) => i.kind === 'on_account');
  assert.ok(parked, 'an outgoing payment against a customer is an open item too');
  assert.equal(parked.direction, 'outgoing', 'the row states its direction rather than implying it');
  assert.equal(parked.openMinor, 15000, 'and it is POSITIVE: money paid out increases the receivable');
  assert.equal(parked.baseOpenMinor, 15000);

  // The invoice row is the other direction, so the field is not a constant dressed up as data.
  const doc = res.items.find((i) => i.kind === 'document');
  assert.equal(doc.direction, 'incoming', 'a receivable is a claim to cash coming IN');

  // The ledger still agrees, which is what makes the row a receivable rather than a presentation
  // artefact: 1100 carries the refund and the reconciliation says so.
  assert.equal(res.baseTotalOpenMinor, receivablesBalance(t.store, t.workspaceId, '2026-07-19'));
  assert.equal(res.reconciled, true);
});

test('A16 F13: both parked directions co-exist, and direction never restates the sign', () => {
  const t = setup();
  const c2 = addCustomer(t.ctx, 'Zweite Kundin GmbH', 'c-two-f13');
  const inv = issueInvoice(t.at('2026-06-01T00:00:00.000Z'), {
    contactId: t.customerId,
    dueDate: '2026-06-15',
    key: 'inv-both',
  });

  // An over-payment: incoming, parks NEGATIVE.
  const over = recordPayment(t.at('2026-07-01T00:00:00.000Z'), {
    direction: 'incoming',
    date: '2026-07-01',
    amountMinor: GROSS_MINOR + 20000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'pay-over-f13',
  });
  assert.equal(over.ok, true, JSON.stringify(over));

  // A refund to the OTHER customer: outgoing, parks POSITIVE.
  const refund = recordPayment(t.at('2026-07-02T00:00:00.000Z'), {
    direction: 'outgoing',
    date: '2026-07-02',
    amountMinor: 20000,
    bankAccountId: t.bankId,
    counterpartyId: c2,
    allocations: [],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'refund-2',
  });
  assert.equal(refund.ok, true, JSON.stringify(refund));

  const parked = listOpenItems(t.ctx, {}).items.filter((i) => i.kind === 'on_account');
  assert.equal(parked.length, 2);
  assert.deepEqual(
    parked.map((i) => [i.direction, i.openMinor]).sort(),
    [
      ['incoming', -20000],
      ['outgoing', 20000],
    ],
    'the two parked rows are equal and opposite: a total alone cannot tell them apart',
  );
  // The two cancel to zero across the workspace, which is exactly the state in which reading the
  // direction off an aggregate is impossible and reading it off the row still works.
  assert.equal(
    parked.reduce((n, i) => n + i.openMinor, 0),
    0,
  );

  // A16 §6b fixes `direction` to A14's own enum: never a third value, never null on any row.
  for (const item of listOpenItems(t.ctx, {}).items) {
    assert.ok(
      item.direction === 'incoming' || item.direction === 'outgoing',
      `every row carries a direction, got ${JSON.stringify(item.direction)}`,
    );
  }
});

test('A16 F13: the direction rides customerBalance and the aging report, not just the list', () => {
  const t = setup();
  const refund = recordPayment(t.at('2026-07-02T00:00:00.000Z'), {
    direction: 'outgoing',
    date: '2026-07-02',
    amountMinor: 15000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'refund-3',
  });
  assert.equal(refund.ok, true, JSON.stringify(refund));

  const bal = customerBalance(t.ctx, { customerId: t.customerId });
  assert.equal(bal.items.length, 1);
  assert.equal(bal.items[0].direction, 'outgoing');
  // `onAccountMinor` is reported POSITIVE for a Guthaben, so this one comes out NEGATIVE. That is
  // correct and it is why the field alone cannot be labelled "Guthaben": the direction on the row is
  // what tells a caller which of the two it is holding.
  assert.equal(bal.onAccountMinor, -15000);

  const rep = agingReport(t.ctx, {});
  assert.equal(rep.byCustomer.length, 1);
  assert.equal(rep.byCustomer[0].totalOpenMinor, 15000);
});

test('A16 US-A16.3: a customer balance rolls up only that customer, with the oldest overdue age', () => {
  const { t, c2 } = fixture();

  const mine = customerBalance(t.ctx, { customerId: t.customerId });
  assert.equal(mine.ok, true, JSON.stringify(mine));
  assert.equal(mine.totalOpenMinor, GROSS_MINOR + (GROSS_MINOR - 50000));
  assert.equal(mine.oldestOverdueDays, 40);
  assert.equal(mine.onAccountMinor, 0);
  assert.equal(mine.bucketTotals['31-60'], GROSS_MINOR - 50000);
  assert.equal(mine.bucketTotals['0-30'], GROSS_MINOR);

  const theirs = customerBalance(t.ctx, { customerId: c2 });
  assert.equal(theirs.totalOpenMinor, GROSS_MINOR);
  assert.equal(theirs.oldestOverdueDays, 34);

  assert.equal(
    mine.totalOpenMinor + theirs.totalOpenMinor,
    listOpenItems(t.ctx, {}).totalOpenMinor,
    'the per-customer roll-ups partition the same total the list reports',
  );
});

test('A16 US-A16.2: the aging report aggregates the same numbers the list itemises', () => {
  const { t, c2 } = fixture();

  const list = listOpenItems(t.ctx, {});
  const rep = agingReport(t.ctx, {});
  assert.equal(rep.ok, true, JSON.stringify(rep));

  assert.deepEqual(rep.byBucket, list.bucketTotals);
  assert.equal(rep.totalOpenMinor, list.totalOpenMinor);
  assert.equal(rep.reconciled, true);

  const byId = Object.fromEntries(rep.byCustomer.map((c) => [c.customerId, c]));
  assert.equal(byId[t.customerId].totalOpenMinor, GROSS_MINOR + (GROSS_MINOR - 50000));
  assert.equal(byId[c2].totalOpenMinor, GROSS_MINOR);
  assert.equal(byId[c2].customerName, 'Zweite Kundin GmbH');
  assert.equal(
    rep.byCustomer.reduce((n, c) => n + c.totalOpenMinor, 0),
    list.totalOpenMinor,
  );
});

test('A16 §5: the list filters by customer and by currency without changing any item', () => {
  const { t, c2, inv4 } = fixture();

  const filtered = listOpenItems(t.ctx, { customerId: c2 });
  assert.deepEqual(
    filtered.items.map((i) => i.number),
    [inv4.number],
  );
  assert.equal(filtered.totalOpenMinor, GROSS_MINOR);
  // The reconciliation flag describes the WORKSPACE, so a filtered view must not claim the ledger
  // disagrees just because the caller asked a narrower question.
  assert.equal(filtered.filtered, true);
  assert.equal(filtered.reconciled, true);

  const chf = listOpenItems(t.ctx, { currency: 'CHF' });
  assert.equal(chf.items.length, 3);
  const eur = listOpenItems(t.ctx, { currency: 'EUR' });
  assert.deepEqual(eur.items, []);
});

test('A16 §7 §H-TENANT: a second workspace in the same database is invisible from the first', () => {
  const { t } = fixture();
  const other = secondWorkspace(t, 'Nachbar AG');

  const theirInvoice = issueInvoice(other.ctx, {
    contactId: other.customerId,
    dueDate: '2026-06-01',
    key: 'inv-other',
  });

  // A parked credit in the OTHER workspace. Without this the tenant claim is decorative: a foreign
  // invoice is already unreachable through the document query, but a foreign PAYMENT with an
  // unallocated remainder is a receivable row with no document behind it, and it would land on this
  // workspace's list if the payment query were not scoped. Dropping that scope leaves every other
  // case in this file green.
  const theirOverpayment = recordPayment(other.ctx, {
    direction: 'incoming',
    date: '2026-07-02',
    amountMinor: GROSS_MINOR + 30000,
    bankAccountId: other.bankId,
    counterpartyId: other.customerId,
    allocations: [{ documentId: theirInvoice.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'pay-other-over',
  });
  assert.equal(theirOverpayment.ok, true, JSON.stringify(theirOverpayment));

  const mine = listOpenItems(t.ctx, {});
  assert.equal(
    mine.items.some((i) => i.kind === 'on_account'),
    false,
    "a neighbour's Guthaben is not this workspace's receivable",
  );
  assert.equal(mine.items.length, 3);
  assert.equal(
    mine.items.some((i) => i.documentId === theirInvoice.id),
    false,
  );
  assert.equal(mine.totalOpenMinor, GROSS_MINOR * 2 + (GROSS_MINOR - 50000));
  assert.equal(mine.baseTotalOpenMinor, receivablesBalance(t.store, t.workspaceId, '2026-07-19'));

  // The neighbour sees their own credit and nothing of ours, and their books reconcile too: the
  // invariant is a property of each workspace, never of the file they happen to share.
  const theirs = listOpenItems(other.ctx, {});
  assert.deepEqual(
    theirs.items.map((i) => i.kind),
    ['on_account'],
    'their invoice is settled, so all that remains is their parked credit',
  );
  assert.equal(theirs.items[0].openMinor, -30000);
  assert.equal(theirs.baseTotalOpenMinor, receivablesBalance(t.store, other.workspaceId, '2026-07-19'));
  assert.equal(theirs.reconciled, true);

  // Probing a foreign customer id must read as an empty balance, never as their figures.
  const probe = customerBalance(t.ctx, { customerId: other.customerId });
  assert.equal(probe.ok, true);
  assert.equal(probe.totalOpenMinor, 0);
});

test('A16 §5: a nonexistent customer is an empty balance, and a malformed asOf is invalid_input', () => {
  const { t } = fixture();

  const missing = customerBalance(t.ctx, { customerId: 'contact_does_not_exist' });
  assert.equal(missing.ok, true);
  assert.equal(missing.totalOpenMinor, 0);

  const bad = listOpenItems(t.ctx, { asOf: '19.07.2026' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_input');
  assert.equal(bad.field, 'asOf');
});
