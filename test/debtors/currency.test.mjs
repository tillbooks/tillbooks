// A16 §4 money correctness (P2 / §H-FX): a foreign open item is reported in ITS currency and in the
// base currency the receivable was BOOKED at.
//
// TWO currencies at TWO rates, one below 1 and one above it, and neither equal to the base. A single
// foreign fixture can agree with a wrong conversion by luck: swap a multiply for a divide, or drop
// the conversion entirely, and one rate can still land on a number that looks plausible. Two rates
// pulling in opposite directions cannot both survive the same mistake.
//
// A16 NEVER revalues. The base figure is the one the ledger holds from the invoice date, which is
// why the assertions below are pinned to the booked amounts and not to any rate in force today
// (period-end revaluation is A22's, per §3 out-of-scope).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listOpenItems,
  customerBalance,
  agingReport,
  setAgingBucketConfig,
} from '../../dist/core/debtors/index.js';
import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';

import { setup, seedRate, issueInvoice, receivablesBalance, itemFor, GROSS_MINOR } from './support.mjs';

const ok = (res) => {
  assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res)}`);
  return res;
};

/** EUR below the franc, GBP above it. Gross 1'081.00 converts to 1'026.95 and 1'243.15. */
const EUR_BASE_MINOR = 102695;
const GBP_BASE_MINOR = 124315;

function fxFixture() {
  const t = setup();
  const june = t.at('2026-06-01T00:00:00.000Z');
  seedRate(june, { currency: 'EUR', rate: '0.95', asOf: '2026-06-01', key: 'eur-jun' });
  seedRate(june, { currency: 'GBP', rate: '1.15', asOf: '2026-06-01', key: 'gbp-jun' });

  const eur = issueInvoice(june, {
    contactId: t.customerId,
    currency: 'EUR',
    dueDate: '2026-06-15',
    key: 'inv-eur',
  });
  const gbp = issueInvoice(june, {
    contactId: t.customerId,
    currency: 'GBP',
    dueDate: '2026-06-20',
    key: 'inv-gbp',
  });
  const chf = issueInvoice(june, { contactId: t.customerId, dueDate: '2026-06-25', key: 'inv-chf' });
  return { t, eur, gbp, chf };
}

test('A16 §4: a foreign item reports its own currency and the base value it was booked at', () => {
  const { t, eur, gbp, chf } = fxFixture();

  const res = listOpenItems(t.ctx, {});
  assert.equal(res.ok, true, JSON.stringify(res));

  const e = itemFor(res, eur.number);
  assert.equal(e.currency, 'EUR');
  assert.equal(e.openMinor, GROSS_MINOR, 'the face amount stays in the currency it was billed in');
  assert.equal(e.baseOpenMinor, EUR_BASE_MINOR);

  const g = itemFor(res, gbp.number);
  assert.equal(g.currency, 'GBP');
  assert.equal(g.openMinor, GROSS_MINOR);
  assert.equal(g.baseOpenMinor, GBP_BASE_MINOR);

  const c = itemFor(res, chf.number);
  assert.equal(c.currency, 'CHF');
  assert.equal(c.baseOpenMinor, GROSS_MINOR, 'a base-currency item converts by the identity');

  // Three items with the SAME face amount and three different base values: the conversion is doing
  // real work, and the two foreign ones move in opposite directions from the franc.
  assert.ok(e.baseOpenMinor < GROSS_MINOR && g.baseOpenMinor > GROSS_MINOR);

  assert.equal(res.totalOpenMinor, GROSS_MINOR * 3, 'the face total is currency-blind and says so');
  assert.equal(res.baseTotalOpenMinor, EUR_BASE_MINOR + GBP_BASE_MINOR + GROSS_MINOR);
  assert.equal(res.baseTotalOpenMinor, receivablesBalance(t.store, t.workspaceId, '2026-07-19'));
  assert.equal(res.reconciled, true);
  assert.deepEqual([...res.currencies].sort(), ['CHF', 'EUR', 'GBP']);
});

test('A16 §4: a partial settlement releases the booked base proportionally, not at today rate', () => {
  const { t, eur } = fxFixture();
  const july = t.at('2026-07-05T00:00:00.000Z');
  // A DIFFERENT rate on the payment date. If A16 revalued, this rate would move the open base and
  // the reconciliation to 1100 would break, which is precisely the mistake this case exists to catch.
  seedRate(july, { currency: 'EUR', rate: '1.05', asOf: '2026-07-05', key: 'eur-jul' });

  const paid = recordPayment(july, {
    direction: 'incoming',
    date: '2026-07-05',
    amountMinor: 50000,
    currency: 'EUR',
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: eur.id, amountMinor: 50000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'pay-eur-partial',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));

  const res = listOpenItems(t.ctx, {});
  const e = itemFor(res, eur.number);
  assert.equal(e.openMinor, GROSS_MINOR - 50000);
  assert.equal(e.baseOpenMinor, EUR_BASE_MINOR - 47500, 'released at 0.95, the rate it was booked at');

  assert.equal(res.baseTotalOpenMinor, receivablesBalance(t.store, t.workspaceId, '2026-07-19'));
  assert.equal(res.reconciled, true);
});

// --- Finding F11, base-currency bucket subtotals -----------------------------------------------
//
// `bucketTotals` sums the FACE amount, so in a workspace holding francs, euros and pounds it adds
// three currencies together. The result is not an amount in any currency: it is a number with no
// unit, and rendering it with a `CHF` prefix beside a header total that IS base currency fabricates
// a figure. `baseBucketTotals` is the twin that reduces over `baseOpenMinor`, the per-item base
// figure this read model has computed since it shipped. Nothing new is derived here: what was
// missing was the exposure.

test('A16 F11: baseBucketTotals re-partitions the BASE total, bucket by bucket', () => {
  const { t } = fxFixture();
  const res = listOpenItems(t.ctx, {});

  // Due 15.06, 20.06 and 25.06 read at 19.07: 34, 29 and 24 days overdue, so the EUR invoice is
  // alone in `31-60` and the GBP and CHF ones share `0-30`. A one-bucket fixture could not tell a
  // per-bucket reduction apart from a copy of the grand total.
  assert.deepEqual(res.bucketTotals, {
    '0-30': GROSS_MINOR * 2,
    '31-60': GROSS_MINOR,
    '61-90': 0,
    '90+': 0,
  });
  assert.deepEqual(res.baseBucketTotals, {
    '0-30': GBP_BASE_MINOR + GROSS_MINOR,
    '31-60': EUR_BASE_MINOR,
    '61-90': 0,
    '90+': 0,
  });

  // The two disagree in BOTH directions on the two occupied buckets, which is the whole point: a
  // twin that had accidentally been wired to `openMinor` would be equal to `bucketTotals` here.
  assert.ok(res.baseBucketTotals['31-60'] < res.bucketTotals['31-60'], 'the EUR bucket is worth less in francs');
  assert.ok(res.baseBucketTotals['0-30'] > res.bucketTotals['0-30'], 'the GBP bucket is worth more');

  // And it partitions the figure the header actually renders, exactly.
  assert.equal(
    Object.values(res.baseBucketTotals).reduce((n, v) => n + v, 0),
    res.baseTotalOpenMinor,
  );
  assert.equal(res.baseTotalOpenMinor, receivablesBalance(t.store, t.workspaceId, '2026-07-19'));

  // The keys are the CONFIGURED keys, never a fixed four: the twin is built from the same key set.
  assert.deepEqual(Object.keys(res.baseBucketTotals), Object.keys(res.bucketTotals));
});

test('A16 F11: the base twin follows the filter and the reconfigured boundaries', () => {
  const { t } = fxFixture();

  // Filtered to one currency, face and base are the same partition of the same money.
  const gbp = listOpenItems(t.ctx, { currency: 'GBP' });
  assert.deepEqual(gbp.bucketTotals, { '0-30': GROSS_MINOR, '31-60': 0, '61-90': 0, '90+': 0 });
  assert.deepEqual(gbp.baseBucketTotals, { '0-30': GBP_BASE_MINOR, '31-60': 0, '61-90': 0, '90+': 0 });
  assert.equal(
    Object.values(gbp.baseBucketTotals).reduce((n, v) => n + v, 0),
    gbp.baseTotalOpenMinor,
  );

  // Two boundaries instead of three: three tiles, and the twin has three keys too. A twin hardcoded
  // at four would break on the first workspace that exercises §6b.
  //
  // The boundaries are chosen so that TWO rows sit exactly ON an edge: read at 19.07 the three
  // invoices are 24, 29 and 34 days overdue, and the cuts are 24 and 29. The upper edge is
  // INCLUSIVE, so the CHF row belongs to `0-24` and the GBP row to `25-29`; a `<=` mutated to `<`
  // pushes both of them one bucket up and this assertion reddens. A fixture whose rows all sat
  // between the edges would sleep through that.
  ok(setAgingBucketConfig(t.ctx, { boundariesDays: [24, 29], idempotencyKey: 'f11-bounds' }));
  const re = listOpenItems(t.ctx, {});
  assert.deepEqual(Object.keys(re.baseBucketTotals), ['0-24', '25-29', '29+']);
  assert.deepEqual(re.baseBucketTotals, {
    '0-24': GROSS_MINOR,
    '25-29': GBP_BASE_MINOR,
    '29+': EUR_BASE_MINOR,
  });
  assert.equal(
    Object.values(re.baseBucketTotals).reduce((n, v) => n + v, 0),
    re.baseTotalOpenMinor,
    're-partitioning cannot change the total, whatever the boundaries are',
  );
});

test('A16 F11: customerBalance and agingReport carry the base twin too', () => {
  const { t } = fxFixture();

  const bal = customerBalance(t.ctx, { customerId: t.customerId });
  assert.deepEqual(bal.baseBucketTotals, {
    '0-30': GBP_BASE_MINOR + GROSS_MINOR,
    '31-60': EUR_BASE_MINOR,
    '61-90': 0,
    '90+': 0,
  });
  assert.equal(
    Object.values(bal.baseBucketTotals).reduce((n, v) => n + v, 0),
    bal.baseTotalOpenMinor,
  );

  const rep = agingReport(t.ctx, {});
  // `byBucket` was the face sum while `baseTotalOpenMinor` right beside it was base, so the report
  // disagreed with its own total in any mixed workspace. `baseByBucket` is the figure that ties.
  assert.deepEqual(rep.byBucket, { '0-30': GROSS_MINOR * 2, '31-60': GROSS_MINOR, '61-90': 0, '90+': 0 });
  assert.deepEqual(rep.baseByBucket, {
    '0-30': GBP_BASE_MINOR + GROSS_MINOR,
    '31-60': EUR_BASE_MINOR,
    '61-90': 0,
    '90+': 0,
  });
  assert.equal(
    Object.values(rep.baseByBucket).reduce((n, v) => n + v, 0),
    rep.baseTotalOpenMinor,
  );
  assert.notDeepEqual(rep.byBucket, rep.baseByBucket, 'the two are genuinely different sums here');

  assert.equal(rep.byCustomer.length, 1);
  assert.deepEqual(rep.byCustomer[0].baseBucketTotals, rep.baseByBucket);
  assert.equal(
    Object.values(rep.byCustomer[0].baseBucketTotals).reduce((n, v) => n + v, 0),
    rep.byCustomer[0].baseTotalOpenMinor,
  );
});

test('A16 F11: a NEGATIVE bucket survives the base twin, sign and all', () => {
  // A16's first bucket can go negative: a parked Guthaben is filed into `keys[0]` with a negative
  // open, and a workspace holding more credit than fresh invoices has a negative first tile. The
  // twin must carry that through rather than clamping or taking an absolute value, so this pins the
  // sign on both sides of a foreign-currency conversion.
  const t = setup();
  const june = t.at('2026-06-01T00:00:00.000Z');
  seedRate(june, { currency: 'EUR', rate: '0.95', asOf: '2026-06-01', key: 'eur-neg' });
  // The same rate again on the payment date. §H-FX refuses to price a July posting off a June rate
  // (`needs_fx_rate`, max age 7 days), and holding the rate flat keeps the parked remainder's base
  // value arithmetically pinnable: EUR 400.00 at 0.95 is CHF 380.00, and nothing else could produce it.
  seedRate(t.at('2026-07-01T00:00:00.000Z'), {
    currency: 'EUR',
    rate: '0.95',
    asOf: '2026-07-01',
    key: 'eur-neg-jul',
  });
  const eur = issueInvoice(june, {
    contactId: t.customerId,
    currency: 'EUR',
    dueDate: '2026-07-31',
    key: 'inv-eur-neg',
  });

  const over = recordPayment(t.at('2026-07-01T00:00:00.000Z'), {
    direction: 'incoming',
    date: '2026-07-01',
    currency: 'EUR',
    amountMinor: GROSS_MINOR + 40000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: eur.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'pay-eur-over',
  });
  assert.equal(over.ok, true, JSON.stringify(over));

  const res = listOpenItems(t.ctx, {});
  assert.equal(res.bucketTotals['0-30'], -40000, 'the face remainder is EUR 400.00 of parked credit');
  assert.equal(res.baseBucketTotals['0-30'], -38000, 'EUR 400.00 at 0.95, and still negative');
  assert.ok(res.baseBucketTotals['0-30'] < 0, 'a negative bucket is never clamped or absolute-valued');
  assert.equal(
    Object.values(res.baseBucketTotals).reduce((n, v) => n + v, 0),
    res.baseTotalOpenMinor,
  );
  assert.equal(res.baseTotalOpenMinor, receivablesBalance(t.store, t.workspaceId, '2026-07-19'));
  assert.equal(res.reconciled, true);
});

test('A16 §4: a customer balance sums base values, never a mixed-currency face total', () => {
  const { t } = fxFixture();

  const bal = customerBalance(t.ctx, { customerId: t.customerId });
  assert.equal(bal.ok, true, JSON.stringify(bal));
  assert.equal(bal.baseTotalOpenMinor, EUR_BASE_MINOR + GBP_BASE_MINOR + GROSS_MINOR);
  assert.deepEqual([...bal.currencies].sort(), ['CHF', 'EUR', 'GBP']);
});
