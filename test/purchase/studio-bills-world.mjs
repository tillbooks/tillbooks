/**
 * The worlds behind the A17 Studio fixtures in `app/src/surfaces/Bills/*.fixture.json`.
 *
 * Shared by the capture script (`capture-studio-bills.mjs`) and by the drift guard
 * (`studio-bills-fixture.test.mjs`), exactly the pairing A16 established: the fixtures are a
 * RECORDING of these functions and the guard replays the same functions, so the recording and the
 * assertion cannot drift apart. Values are asserted, never keys-and-kinds: eight hand-typed account
 * names in three earlier Studio suites were wrong against the shipped chart while every kind
 * matched, and a keys-and-kinds guard called that green.
 *
 * Two list worlds, because the surface's hardest state cannot occur in a healthy workspace:
 *
 *  - `liveBills()`  the healthy register. Six bills across every word the row can show: a draft, a
 *    posted not-yet-due, two overdue in different buckets, a partly paid, a paid-in-full and a
 *    void. Reconciles to 2000.
 *  - `liveMismatch()` one entry posted straight onto 2000 that belongs to no bill and no payment,
 *    the most common real cause of `reconciled:false`. The band renders against this recording.
 *
 * Plus the editor's preview: `livePreview()` is `vat_preview`'s own answer (the verb IS
 * `computeLineTax`, see `registry.ts`) for the canonical gross 1'081.00 at VST-M.
 */

import assert from 'node:assert/strict';

import { postEntry } from '../../dist/core/ledger/index.js';
import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { computeLineTax } from '../../dist/core/vat/index.js';
import {
  createVendorBill,
  recordExpense,
  voidVendorBill,
  listVendorBills,
} from '../../dist/core/purchase/index.js';

import { setup, addVendor, billInput, GROSS_MINOR } from './support.mjs';

/** The day every capture reads AS OF. Fixed, so a fixture is not a function of the wall clock. */
export const AS_OF = '2026-07-19';

const day = (date) => `${date}T00:00:00.000Z`;

/**
 * The shared spine: one workspace, two vendors, six bills, every one through A17's own verbs.
 *
 * Every posted bill is a genuine movement on 2000, which is what makes `reconciled` mean anything.
 * Due dates are chosen against AS_OF so the overdue pair lands in two different aging buckets.
 */
function seedBills() {
  const t = setup();
  const vendor = addVendor(t.ctx, 'Lieferant GmbH', 'v1');
  const second = addVendor(t.ctx, 'Werkstoff AG', 'v2', 'both');

  const at = (iso) => t.at(day(iso));

  // A draft awaiting review (the P8 agent path leaves exactly this row behind).
  const draft = createVendorBill(at('2026-07-12'), {
    ...billInput(t, vendor, { idempotencyKey: 'fx-draft' }),
    billDate: '2026-07-12',
    dueDate: '2026-08-11',
    vendorReference: 'LG-2026-0107',
  });
  assert.equal(draft.ok, true, JSON.stringify(draft));

  // Posted, not yet due at AS_OF.
  const fresh = recordExpense(at('2026-07-10'), {
    ...billInput(t, vendor, { idempotencyKey: 'fx-fresh' }),
    billDate: '2026-07-10',
    dueDate: '2026-07-25',
    vendorReference: 'LG-2026-0093',
  });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));

  // Overdue 19 days at AS_OF: the first bucket.
  const b1 = recordExpense(at('2026-06-01'), {
    ...billInput(t, second, { idempotencyKey: 'fx-b1' }),
    billDate: '2026-06-01',
    dueDate: '2026-06-30',
    vendorReference: 'WA-4471',
  });
  assert.equal(b1.ok, true, JSON.stringify(b1));

  // Overdue far beyond the last boundary at AS_OF: the 90+ bucket.
  const b4 = recordExpense(at('2026-03-02'), {
    ...billInput(t, second, { idempotencyKey: 'fx-b4' }),
    billDate: '2026-03-02',
    dueDate: '2026-03-31',
    vendorReference: 'WA-3108',
  });
  assert.equal(b4.ok, true, JSON.stringify(b4));

  // Partly paid: half settled, so the remainder is an exact figure rather than a round one.
  const part = recordExpense(at('2026-05-20'), {
    ...billInput(t, vendor, { idempotencyKey: 'fx-part' }),
    billDate: '2026-05-20',
    dueDate: '2026-06-19',
    vendorReference: 'LG-2026-0055',
  });
  assert.equal(part.ok, true, JSON.stringify(part));
  const half = recordPayment(at('2026-06-25'), {
    direction: 'outgoing',
    date: '2026-06-25',
    amountMinor: GROSS_MINOR / 2,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendor,
    allocations: [{ targetKind: 'vendor_bill', targetId: part.vendorBillId, amountMinor: GROSS_MINOR / 2 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'fx-part-pay',
  });
  assert.equal(half.ok, true, JSON.stringify(half));

  // Paid in full: STAYS on the list (a payables register shows its history), displayed as `paid`.
  const paid = recordExpense(at('2026-04-14'), {
    ...billInput(t, vendor, { idempotencyKey: 'fx-paid' }),
    billDate: '2026-04-14',
    dueDate: '2026-05-14',
    vendorReference: 'LG-2026-0031',
  });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  const full = recordPayment(at('2026-05-10'), {
    direction: 'outgoing',
    date: '2026-05-10',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    counterpartyKind: 'supplier',
    counterpartyId: vendor,
    allocations: [{ targetKind: 'vendor_bill', targetId: paid.vendorBillId, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'fx-paid-pay',
  });
  assert.equal(full.ok, true, JSON.stringify(full));

  // Voided: captured wrongly and reversed the only way an append-only ledger permits.
  const wrong = recordExpense(at('2026-06-15'), {
    ...billInput(t, second, { idempotencyKey: 'fx-void' }),
    billDate: '2026-06-15',
    dueDate: '2026-07-15',
    vendorReference: 'WA-4519',
  });
  assert.equal(wrong.ok, true, JSON.stringify(wrong));
  const voided = voidVendorBill(at('2026-06-16'), {
    vendorBillId: wrong.vendorBillId,
    reason: 'Doppelt erfasst',
    date: '2026-06-16',
    idempotencyKey: 'fx-void-go',
  });
  assert.equal(voided.ok, true, JSON.stringify(voided));

  return { t, vendor, second };
}

/** The healthy world: the Kreditoren list at AS_OF, reconciled, every display word present. */
export function liveBills() {
  const world = seedBills();
  const list = listVendorBills(world.t.at(day(AS_OF)));
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.reconciled, true, 'the healthy world must tie to 2000, or the band is the default');
  const words = new Set(list.bills.map((b) => b.displayStatus));
  for (const word of ['draft', 'posted', 'partly_paid', 'paid', 'void']) {
    assert.ok(words.has(word), `the recording shows no ${word} row, so that word is untested`);
  }
  return { list, vendorId: world.vendor };
}

/** The mismatch world: one manual entry straight onto 2000, belonging to nothing. */
export function liveMismatch() {
  const world = seedBills();
  const ctx = world.t.at(day('2026-07-10'));
  const stray = postEntry(ctx, {
    date: '2026-07-10',
    description: 'Direkte Buchung auf 2000',
    ref: 'MANUELL-1',
    source: 'manual',
    idempotencyKey: 'stray-2000',
    lines: [
      { account: world.t.acc('6500'), debit: 1250 },
      { account: world.t.acc('2000'), credit: 1250 },
    ],
  });
  assert.equal(stray.ok, true, JSON.stringify(stray));

  const list = listVendorBills(world.t.at(day(AS_OF)));
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.reconciled, false, 'the mismatch world must NOT reconcile, or the band never renders');
  assert.notEqual(list.reconciliationDifferenceMinor, 0);
  return list;
}

/** `vat_preview`'s own answer for the canonical bill, which IS `computeLineTax` (registry.ts). */
export function livePreview() {
  const t = setup();
  const preview = computeLineTax(t.ctx, {
    amountMinor: GROSS_MINOR,
    amountIsGross: true,
    taxCode: 'VST-M',
    supplyDate: '2026-07-12',
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.deductible, true);
  return preview;
}
