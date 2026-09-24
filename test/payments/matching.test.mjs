/**
 * A14 §3, the candidate read model behind BOTH faces (US-A14.6).
 *
 * The rows here are the design's P27 to P34, and the load-bearing ones are the refusals: a mistyped
 * reference must never become a confident amount-only match, a tie must show as a tie, and a
 * candidate that fits no tier must be described by nothing at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  suggestPaymentMatches,
  recordPayment,
  buildQrrReference,
  buildScorReference,
  PAYMENT_INTENTS,
} from '../../dist/core/payments/index.js';
import { setup, addCustomer, issueInvoice, seedRate, GROSS_MINOR } from './support.mjs';

// --- P27, P33, the reference settles a match on its own -----------------------------------------

test('P27: a valid QRR pins its invoice with the reason "reference matches" and prefills it', () => {
  const t = setup();
  const other = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 50000, taxCode: 'none', key: 'q1' });
  const target = issueInvoice(t.ctx, { contactId: t.customerId, key: 'q2' });
  const qrr = buildQrrReference(target.number);

  const res = suggestPaymentMatches(t.ctx, { amountMinor: GROSS_MINOR, reference: qrr });
  assert.equal(res.ok, true);
  assert.equal(res.reference.kind, 'qrr');
  assert.equal(res.reference.status, 'matched');
  assert.equal(res.openItemCount, 2);
  assert.equal(res.referenceMatchCount, 1);

  const top = res.candidates[0];
  assert.equal(top.targetId, target.id);
  assert.equal(top.kind, 'exact_reference');
  assert.equal(top.prefillMinor, GROSS_MINOR);
  // The second candidate fits no tier, so it carries NO reason word. Calling a CHF 500.00 open item
  // "amount close" against a CHF 1'081.00 payment would make the whole vocabulary lie.
  const second = res.candidates.find((c) => c.targetId === other.id);
  assert.equal(second.kind, null);
  assert.equal(second.reason, null);
});

test('P33: a SCOR reference is recognised as its own regime and matches the same way', () => {
  const t = setup();
  const target = issueInvoice(t.ctx, { contactId: t.customerId, key: 's1' });
  const scor = buildScorReference(target.number);
  const res = suggestPaymentMatches(t.ctx, { amountMinor: GROSS_MINOR, reference: scor });
  assert.equal(res.reference.kind, 'scor');
  assert.equal(res.reference.status, 'matched');
  assert.equal(res.candidates[0].targetId, target.id);
  assert.equal(res.candidates[0].kind, 'exact_reference');
});

// --- P29, the single most dangerous failure mode --------------------------------------------------

test('P29: a mistyped QRR is reported as a typo and NEVER degrades into an amount-only match', () => {
  const t = setup();
  const target = issueInvoice(t.ctx, { contactId: t.customerId, key: 'typo' });
  const good = buildQrrReference(target.number);
  const bad = good.slice(0, 26) + String((Number(good[26]) + 1) % 10);

  const res = suggestPaymentMatches(t.ctx, {
    amountMinor: GROSS_MINOR,
    reference: bad,
    counterpartyId: t.customerId,
  });
  assert.equal(res.reference.kind, 'qrr');
  assert.equal(res.reference.valid, false);
  assert.equal(res.reference.error, 'reference_check_digit');
  assert.equal(res.reference.status, 'reference_check_digit');
  assert.equal(res.referenceMatchCount, 0);

  // The invoice IS still listed, and it may still be allocated to. What it must not do is claim the
  // reference matched: the ranking falls back to the amount, and the surface says which check
  // failed instead of quietly presenting a confident-looking match.
  const row = res.candidates.find((c) => c.targetId === target.id);
  assert.notEqual(row, undefined);
  assert.notEqual(row.kind, 'exact_reference');
  assert.equal(row.kind, 'exact_amount_customer');
});

// --- P28, P30, a well-formed reference that leads nowhere ----------------------------------------

test('P28: a valid reference belonging to no open item says exactly that, and blames nothing', () => {
  const t = setup();
  issueInvoice(t.ctx, { contactId: t.customerId, key: 'u1' });
  const res = suggestPaymentMatches(t.ctx, { reference: buildQrrReference('R-2099-9999') });
  assert.equal(res.reference.valid, true);
  assert.equal(res.reference.status, 'reference_unknown');
  assert.equal(res.referenceMatchCount, 0);
  // The reference is kept for the record, and the open items are still listed to allocate against.
  assert.equal(res.reference.value.length, 27);
  assert.equal(res.openItemCount, 1);
});

test('P30: a reference naming an ALREADY settled invoice shows it, disabled, rather than hiding it', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'paid' });
  assert.equal(
    recordPayment(t.ctx, {
      direction: 'incoming',
      date: '2026-07-19',
      amountMinor: GROSS_MINOR,
      bankAccountId: t.bankId,
      allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: 'p-paid',
    }).ok,
    true,
  );

  const res = suggestPaymentMatches(t.ctx, {
    amountMinor: GROSS_MINOR,
    reference: buildQrrReference(inv.number),
  });
  const row = res.candidates.find((c) => c.targetId === inv.id);
  // Visible and linkable, because "you already booked this" is the answer the user needs.
  assert.notEqual(row, undefined);
  assert.equal(row.settled, true);
  assert.equal(row.disabledReason, 'settled');
  assert.equal(row.kind, null);
  assert.equal(row.openMinor, 0);
  assert.equal(res.openItemCount, 0);
});

// --- P31, the NON regime: rank, never settle ------------------------------------------------------

test('P31: with no reference, one exact amount plus customer prefills and two tied prefill nothing', () => {
  const t = setup();
  const only = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 100000, taxCode: 'none', key: 'n1' });
  const single = suggestPaymentMatches(t.ctx, { amountMinor: 100000, counterpartyId: t.customerId });
  assert.equal(single.candidates[0].targetId, only.id);
  assert.equal(single.candidates[0].kind, 'exact_amount_customer');
  assert.equal(single.candidates[0].prefillMinor, 100000);

  // A second invoice for the same customer at the same amount is a genuine tie, and ambiguity is
  // shown as ambiguity: nothing is prefilled, because guessing is the one thing this must not do.
  issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 100000, taxCode: 'none', key: 'n2' });
  const tied = suggestPaymentMatches(t.ctx, { amountMinor: 100000, counterpartyId: t.customerId });
  assert.equal(tied.candidates.filter((c) => c.kind === 'exact_amount_customer').length, 2);
  assert.deepEqual(
    tied.candidates.map((c) => c.prefillMinor),
    [0, 0],
  );
});

test('P31: a payer name never RAISES a tier, because the debtor is whoever actually paid', () => {
  // The SIX guidelines are explicit that the debtor on a bank credit need not be the invoice
  // recipient, so an agreeing counterparty may order rows inside a tier and may never lift one.
  const t = setup();
  const otherCustomer = addCustomer(t.ctx, 'Beispiel GmbH', 'c-other');
  const mine = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 100000, taxCode: 'none', key: 'w1' });
  const theirs = issueInvoice(t.ctx, { contactId: otherCustomer, netMinor: 100000, taxCode: 'none', key: 'w2' });

  const res = suggestPaymentMatches(t.ctx, { amountMinor: 100000, counterpartyId: t.customerId });
  const a = res.candidates.find((c) => c.targetId === mine.id);
  const b = res.candidates.find((c) => c.targetId === theirs.id);
  assert.equal(a.kind, 'exact_amount_customer');
  // Same amount, different customer: a lower tier, never the same one.
  assert.equal(b.kind, 'amount_tolerance');
  assert.equal(b.deltaMinor, 0);
});

test('tolerance: a near miss is ranked and its difference is stated, in Rappen', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 100000, taxCode: 'none', key: 'tol' });
  const res = suggestPaymentMatches(t.ctx, { amountMinor: 99950, counterpartyId: t.customerId });
  const row = res.candidates.find((c) => c.targetId === inv.id);
  assert.equal(row.kind, 'amount_tolerance');
  assert.equal(row.deltaMinor, 50);
  // A tolerance row never prefills: it is a suggestion, not a decision.
  assert.equal(row.prefillMinor, 0);

  // Beyond the threshold it fits no tier at all and is described by nothing.
  const far = suggestPaymentMatches(t.ctx, { amountMinor: 50000, counterpartyId: t.customerId });
  assert.equal(far.candidates.find((c) => c.targetId === inv.id).kind, null);
});

// --- P32, the two empty states --------------------------------------------------------------------

test('P32: "no open items at all" and "none match" are DIFFERENT answers in the read model', () => {
  const t = setup();
  const nothing = suggestPaymentMatches(t.ctx, { amountMinor: 100000 });
  assert.equal(nothing.openItemCount, 0);
  assert.equal(nothing.candidates.length, 0);

  issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 700, taxCode: 'none', key: 'e1' });
  const noMatch = suggestPaymentMatches(t.ctx, { amountMinor: 100000 });
  // Open items exist, they are listed and allocatable, and none of them fits a tier. That is a
  // different sentence for the surface than "you have nothing open".
  assert.equal(noMatch.openItemCount, 1);
  assert.equal(noMatch.candidates.length, 1);
  assert.equal(noMatch.candidates[0].kind, null);
});

// --- P45, the cross-currency candidate ------------------------------------------------------------

test('a candidate in another currency is listed, disabled, with both currencies named', () => {
  const t = setup();
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-19' });
  const eur = issueInvoice(t.ctx, {
    contactId: t.customerId,
    netMinor: 100000,
    taxCode: 'none',
    currency: 'EUR',
    key: 'eurc',
  });
  const res = suggestPaymentMatches(t.ctx, { amountMinor: 100000, currency: 'CHF' });
  const row = res.candidates.find((c) => c.targetId === eur.id);
  assert.equal(row.currency, 'EUR');
  assert.equal(row.disabledReason, 'currency_mismatch');
  assert.equal(row.kind, null);
});

// --- Ordering and the read-model fields the GUI depends on ----------------------------------------

test('within a tier, rows sort oldest due date first, and every contract field is present', () => {
  const t = setup();
  const later = issueInvoice(t.ctx, {
    contactId: t.customerId,
    netMinor: 100000,
    taxCode: 'none',
    dueDate: '2026-09-30',
    key: 'o2',
  });
  const sooner = issueInvoice(t.ctx, {
    contactId: t.customerId,
    netMinor: 100000,
    taxCode: 'none',
    dueDate: '2026-08-01',
    key: 'o1',
  });
  const res = suggestPaymentMatches(t.ctx, { amountMinor: 100000, counterpartyId: t.customerId });
  assert.deepEqual(
    res.candidates.map((c) => c.targetId),
    [sooner.id, later.id],
  );

  // Every field the design's read-model contract names an affordance on. A missing one here is not a
  // cosmetic gap, it is a control the GUI agent cannot build.
  for (const key of [
    'targetKind',
    'targetId',
    'number',
    'contactId',
    'contactName',
    'currency',
    'dueDate',
    'daysOverdue',
    'grossMinor',
    'paidMinor',
    'openMinor',
    'status',
    'reference',
    'kind',
    'reason',
    'deltaMinor',
    'prefillMinor',
    'settled',
    'disabledReason',
  ]) {
    assert.equal(key in res.candidates[0], true, `candidate.${key} is missing from the read model`);
  }
  assert.equal(res.candidates[0].number, sooner.number);
  assert.equal(res.candidates[0].contactName, 'Muster AG');
  assert.equal(res.candidates[0].daysOverdue, 0);
});

test('an outgoing payment never sees customer invoices among its candidates', () => {
  const t = setup();
  issueInvoice(t.ctx, { contactId: t.customerId, key: 'dir' });
  assert.equal(suggestPaymentMatches(t.ctx, { direction: 'incoming' }).candidates.length, 1);
  assert.equal(suggestPaymentMatches(t.ctx, { direction: 'outgoing' }).candidates.length, 0);
  assert.equal(suggestPaymentMatches(t.ctx, { direction: 'sideways' }).error, 'invalid_input');
});

test('free text is a ranking hint that never produces a reference reason', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 100000, taxCode: 'none', key: 'ft' });
  const res = suggestPaymentMatches(t.ctx, {
    amountMinor: 100000,
    reference: `Rechnung ${inv.number}`,
    counterpartyId: t.customerId,
  });
  assert.equal(res.reference.kind, 'free_text');
  // No error and no status: free text is not a broken reference.
  assert.equal(res.reference.error, null);
  assert.equal(res.reference.status, null);
  assert.equal(res.candidates[0].kind, 'exact_amount_customer');
});
