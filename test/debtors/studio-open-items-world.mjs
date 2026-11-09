/**
 * The worlds behind the A16 Studio fixtures in `app/src/surfaces/OpenItems/*.fixture.json`.
 *
 * Shared by the capture script (`capture-studio-open-items.mjs`) and by the drift guard
 * (`studio-open-items-fixture.test.mjs`), so the fixtures are a RECORDING of these functions and the
 * guard replays exactly the same functions. Two copies of the world would let the recording and the
 * assertion drift apart, which is the failure the whole pairing exists to prevent.
 *
 * WHY A RECORDING AND NOT A LITERAL. Eight hand-written account names in three Studio suites were
 * wrong against the shipped chart while every KIND matched, so a keys-and-kinds comparison passed
 * 6/6 green over a fixture that disagreed with the product. The guard therefore asserts VALUES.
 *
 * Three worlds, because three of the surface's states cannot occur in one workspace at once:
 *
 *  - `liveOpenItems()`  the healthy single-currency register. Five invoices across every default
 *    bucket, one settled outright (so a paid invoice is provably ABSENT), one part-paid, one
 *    over-paid (which parks a Guthaben with a NEGATIVE open), and one refund paid out and never
 *    matched (which parks a positive `outgoing` row). Reconciles.
 *  - `liveMixedCurrency()` the same shape plus a EUR invoice, so `currencies.length > 1` and the
 *    tiles have to withhold their amounts (§5.2). This is the ONLY way to record that state: a
 *    single-currency workspace can never produce it.
 *  - `liveMismatch()` one entry posted straight to 1100 that belongs to no invoice and no payment,
 *    which is the most common real cause of `reconciled: false` and the first line of D-S5's own
 *    checklist. A healthy workspace never reaches this state, so the band would otherwise be
 *    rendered against a payload nobody had ever seen.
 *
 * ONE STATE NO WORLD HERE CAN PRODUCE, said out loud rather than faked. `OpenItem.customerId` and
 * `customerName` are both nullable, and the design's D24 renders "Ohne Kunde" for them, but NO
 * shipped write verb can put such a row on the list today: `transitionDocument` refuses to issue an
 * invoice with no contact (`needs_customer`), and `recordPayment` refuses to park money that belongs
 * to nobody (`needs_counterparty`, `payment.ts:890-893`). Seeding it would have meant writing a
 * document row by hand, which is exactly the invented-fixture failure this file exists to avoid. The
 * surface still renders the null defensively and the null branch is unit-tested on the helper
 * instead, where the claim can be made honestly.
 */

import assert from 'node:assert/strict';

import { postEntry } from '../../dist/core/ledger/index.js';
import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import {
  listOpenItems,
  agingReport,
  customerBalance,
  getAgingBucketConfig,
} from '../../dist/core/debtors/index.js';

import { setup, addCustomer, issueInvoice, seedRate, GROSS_MINOR } from '../payments/support.mjs';

/** The day every capture reads AS OF. Fixed, so a fixture is not a function of the wall clock. */
export const AS_OF = '2026-07-19';

/** The five due dates, chosen so the default boundaries [30, 60, 90] each hold at least one item. */
export const DUE_DATES = {
  settled: '2026-06-10',
  notYetDue: '2026-07-25',
  bucket1: '2026-06-30',
  bucket2: '2026-05-25',
  bucket3: '2026-04-20',
  bucket4: '2026-03-01',
};

const day = (date) => `${date}T00:00:00.000Z`;

/**
 * The shared spine: a workspace, two customers, and six invoices issued on the days they are dated.
 *
 * Every invoice goes through A11's real poster, so each one is a genuine movement on 1100 rather
 * than a row written into a table. That is what makes `reconciled` mean anything at all here.
 */
function seedInvoices() {
  const t = setup();
  const second = addCustomer(t.ctx, 'Beispiel GmbH', 'c2');

  const invoice = (key, contactId, dueDate, issuedOn, extra = {}) =>
    issueInvoice(t.at(day(issuedOn)), { contactId, dueDate, key, ...extra });

  const settled = invoice('inv-settled', t.customerId, DUE_DATES.settled, '2026-05-11');
  const notYetDue = invoice('inv-fresh', t.customerId, DUE_DATES.notYetDue, '2026-06-25');
  const bucket1 = invoice('inv-b1', t.customerId, DUE_DATES.bucket1, '2026-05-31');
  const bucket2 = invoice('inv-b2', second, DUE_DATES.bucket2, '2026-04-25');
  const bucket3 = invoice('inv-b3', second, DUE_DATES.bucket3, '2026-03-21');
  const bucket4 = invoice('inv-b4', t.customerId, DUE_DATES.bucket4, '2026-01-30');

  // Settled outright, so the list can be asserted to hold NO fully-paid invoice (D1's acceptance).
  const full = recordPayment(t.at(day('2026-06-08')), {
    direction: 'incoming',
    date: '2026-06-08',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: settled.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'pay-settled',
  });
  assert.equal(full.ok, true, JSON.stringify(full));

  // Half of one invoice, so a partly-paid row carries an exact remainder rather than a round one.
  const partial = recordPayment(t.at(day('2026-07-05')), {
    direction: 'incoming',
    date: '2026-07-05',
    amountMinor: 50000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: bucket1.id, amountMinor: 50000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'pay-partial',
  });
  assert.equal(partial.ok, true, JSON.stringify(partial));

  // Money paid in beyond what it was matched to: the remainder parks on account and lands as a
  // NEGATIVE open item, which is the Guthaben chip and the reason a bucket subtotal can come out
  // negative (INV-3's whole argument). The oldest invoice is deliberately left PART paid rather than
  // settled, so the last bucket keeps a row and the tile group is exercised at full width.
  const over = recordPayment(t.at(day('2026-06-12')), {
    direction: 'incoming',
    date: '2026-06-12',
    amountMinor: 95000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: bucket4.id, amountMinor: 60000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'pay-over',
  });
  assert.equal(over.ok, true, JSON.stringify(over));

  return { t, second, settled, notYetDue, bucket1, bucket2, bucket3, bucket4 };
}

/**
 * A refund paid out to a customer and matched to nothing, which is the `outgoing` parked row.
 *
 * Recorded separately from `seedInvoices` because it is the one seeding step that can legitimately
 * fail on a future A14: if outgoing money against a customer ever stops being recordable, this
 * throws here rather than quietly capturing a fixture with the row missing and letting the surface
 * ship a chip nothing ever exercised.
 */
function seedRefund(t) {
  const refund = recordPayment(t.at(day('2026-06-18')), {
    direction: 'outgoing',
    date: '2026-06-18',
    amountMinor: 12000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'pay-refund',
  });
  assert.equal(refund.ok, true, JSON.stringify(refund));
  return refund;
}

/** The healthy single-currency world: `list_open_items`, `aging_report`, `customer_balance`, config. */
export function liveOpenItems() {
  const world = seedInvoices();
  seedRefund(world.t);
  const ctx = world.t.at(day(AS_OF));

  const items = listOpenItems(ctx, { asOf: AS_OF });
  assert.equal(items.ok, true, JSON.stringify(items));
  assert.equal(items.reconciled, true, 'the healthy world must tie to 1100, or D-S5 is the default');
  assert.equal(items.currencies.length, 1, 'the healthy world is single-currency by construction');

  const aging = agingReport(ctx, { asOf: AS_OF });
  assert.equal(aging.ok, true, JSON.stringify(aging));

  const balance = customerBalance(ctx, { customerId: world.t.customerId, asOf: AS_OF });
  assert.equal(balance.ok, true, JSON.stringify(balance));

  const config = getAgingBucketConfig(ctx);
  assert.equal(config.ok, true, JSON.stringify(config));

  return { items, aging, balance, config, customerId: world.t.customerId };
}

/** The mixed-currency world, which is the only one that can produce the withheld-amount tiles. */
export function liveMixedCurrency() {
  const world = seedInvoices();
  const eurDay = world.t.at(day('2026-05-05'));
  seedRate(eurDay, { currency: 'EUR', rate: '0.9412', asOf: '2026-05-05', key: 'rate-eur' });
  issueInvoice(eurDay, {
    contactId: world.second,
    dueDate: DUE_DATES.bucket2,
    currency: 'EUR',
    key: 'inv-eur',
  });

  const items = listOpenItems(world.t.at(day(AS_OF)), { asOf: AS_OF });
  assert.equal(items.ok, true, JSON.stringify(items));
  assert.ok(items.currencies.length > 1, 'the mixed world must hold more than one currency');
  return items;
}

/**
 * The mismatch world: one entry booked straight onto 1100 against 3000, belonging to nothing.
 *
 * This is D-S5's first checklist line made real. The amount is deliberately small and odd so the
 * rendered difference is unmistakably the one this entry caused.
 */
export function liveMismatch() {
  const world = seedInvoices();
  seedRefund(world.t);
  const ctx = world.t.at(day('2026-07-10'));

  const stray = postEntry(ctx, {
    date: '2026-07-10',
    description: 'Direkte Buchung auf 1100',
    ref: 'MANUELL-1',
    source: 'manual',
    idempotencyKey: 'stray-1100',
    lines: [
      { account: world.t.acc('1100'), debit: 1250 },
      { account: world.t.acc('3000'), credit: 1250 },
    ],
  });
  assert.equal(stray.ok, true, JSON.stringify(stray));

  const items = listOpenItems(world.t.at(day(AS_OF)), { asOf: AS_OF });
  assert.equal(items.ok, true, JSON.stringify(items));
  assert.equal(items.reconciled, false, 'the mismatch world must NOT reconcile, or D-S5 never renders');
  assert.notEqual(items.reconciliationDifferenceMinor, 0);
  return items;
}
