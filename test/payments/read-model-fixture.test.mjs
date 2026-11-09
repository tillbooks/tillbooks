/**
 * The A14 read-model fixture-versus-engine DRIFT GUARD.
 *
 * This project has shipped five defects from a consumer assuming a shape the engine never sent:
 * Accounts offered only Delete because `inUse` was never in the payload, three VAT consumers
 * rendered empty because they read a key `vat_codes` does not answer with, and each time a green
 * test suite proved nothing because the fixture carried the same wrong keys as the consumer.
 *
 * A14 is about to hand a read model to a GUI agent who has not seen this engine, and the payments
 * design states the rule that closes the class: **no affordance may be designed on a field that is
 * not in the read-model contract table.** So the contract is pinned here as a FIXTURE and the
 * fixture is pinned to the LIVE engine, keys and kinds, on both the write response and both read
 * models. If a field the GUI depends on is renamed, dropped, or changes shape, this goes red on the
 * engine side rather than silently on the surface side.
 *
 * `test/fixtures/payment-read-model.fixture.json` is therefore not a convenience: it is the
 * buildable contract, and it is the file the GUI agent should read first.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  recordPayment,
  previewPayment,
  suggestPaymentMatches,
  getPayment,
  listPayments,
  PAYMENT_INTENTS,
} from '../../dist/core/payments/index.js';
import { setup, issueInvoice, GROSS_MINOR } from './support.mjs';

const FIXTURE_PATH = new URL('../fixtures/payment-read-model.fixture.json', import.meta.url);

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function keysOf(obj) {
  return Object.keys(obj).sort();
}

/** Compare an object's keys AND the kind of every value, recursing one level into nested objects. */
function assertShape(live, fixture, where) {
  assert.deepEqual(keysOf(fixture), keysOf(live), `${where}: key drift`);
  for (const key of Object.keys(live)) {
    assert.equal(
      kindOf(fixture[key]),
      kindOf(live[key]),
      `${where}.${key}: kind drift (fixture ${kindOf(fixture[key])}, engine ${kindOf(live[key])})`,
    );
  }
}

/** The one world every part of the fixture is captured from. */
function world() {
  const t = setup();
  const paid = issueInvoice(t.ctx, { contactId: t.customerId, key: 'fx-paid' });
  const open = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 50000, taxCode: 'none', key: 'fx-open' });
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 110000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    reference: '210000000003139471430009017',
    allocations: [{ documentId: paid.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'fx-p1',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return { t, paid, open, res };
}

test('the read-model fixture matches the live record_payment response, keys and kinds', () => {
  const { res } = world();
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  assertShape(res, fixture.recordPayment, 'record_payment');
  // `documents[]` IS the stale-view prevention the design leans on: the surface that posted renders
  // this payload instead of re-fetching, so a missing field here is a control that cannot update.
  assert.equal(kindOf(res.documents), 'array');
  assertShape(res.documents[0], fixture.recordPayment.documents[0], 'record_payment.documents[0]');
});

test('the read-model fixture matches the live preview_payment response, keys and kinds', () => {
  const { t, paid } = world();
  const live = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 108000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: paid.id, amountMinor: 108000 }],
  });
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')).previewPayment;
  assertShape(live, fixture, 'preview_payment');
  assertShape(live.rows[0], fixture.rows[0], 'preview_payment.rows[0]');
  assertShape(live.legs[0], fixture.legs[0], 'preview_payment.legs[0]');
  assertShape(live.reference, fixture.reference, 'preview_payment.reference');
  assertShape(live.bankAccount, fixture.bankAccount, 'preview_payment.bankAccount');
});

test('the read-model fixture matches the live suggest_payment_matches response, keys and kinds', () => {
  const { t } = world();
  const live = suggestPaymentMatches(t.ctx, { amountMinor: 50000, counterpartyId: t.customerId });
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')).suggestPaymentMatches;
  assertShape(live, fixture, 'suggest_payment_matches');
  assertShape(live.reference, fixture.reference, 'suggest_payment_matches.reference');
  assertShape(live.candidates[0], fixture.candidates[0], 'suggest_payment_matches.candidates[0]');
});

test('the read-model fixture matches the live get_payment and list_payments responses', () => {
  const { t, res } = world();
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const live = getPayment(t.ctx, { paymentId: res.paymentId });
  assertShape(live, fixture.getPayment, 'get_payment');
  assertShape(live.payment, fixture.getPayment.payment, 'get_payment.payment');
  assertShape(live.payment.allocations[0], fixture.getPayment.payment.allocations[0], 'get_payment.allocations[0]');
  assertShape(live.payment.bankAccount, fixture.getPayment.payment.bankAccount, 'get_payment.bankAccount');
  assertShape(live.payment.counterparty, fixture.getPayment.payment.counterparty, 'get_payment.counterparty');

  const list = listPayments(t.ctx, {});
  assertShape(list, fixture.listPayments, 'list_payments');
  assertShape(list.payments[0], fixture.listPayments.payments[0], 'list_payments.payments[0]');
});

test('every field the design contract table names an affordance on is actually sent', () => {
  // The contract table's own rule, enforced rather than trusted: each entry below is a control the
  // GUI cannot build without the field, so a rename here is a broken surface there.
  const { t, res, paid } = world();
  const preview = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 108000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: paid.id, amountMinor: 108000 }],
  });
  const suggest = suggestPaymentMatches(t.ctx, { amountMinor: 50000, counterpartyId: t.customerId });
  const payment = getPayment(t.ctx, { paymentId: res.paymentId }).payment;

  const required = [
    // the remainder bar, "danach offen", the pre-post status word
    ['preview.remainderMinor', preview.remainderMinor],
    ['preview.rows[].resultingOpenMinor', preview.rows[0].resultingOpenMinor],
    ['preview.rows[].resultingStatus', preview.rows[0].resultingStatus],
    ['preview.rows[].openMinor', preview.rows[0].openMinor],
    ['preview.rows[].writeOffOfferedMinor', preview.rows[0].writeOffOfferedMinor],
    // the disclosed booking, with numbers AND labels
    ['preview.legs[].accountNumber', preview.legs[0].accountNumber],
    ['preview.legs[].accountLabel', preview.legs[0].accountLabel],
    ['preview.legs[].debitMinor', preview.legs[0].debitMinor],
    ['preview.writeOffThresholdMinor', preview.writeOffThresholdMinor],
    // the candidate list: the confidence words, the difference, the due-date ordering
    ['candidate.kind', suggest.candidates[0].kind],
    ['candidate.deltaMinor', suggest.candidates[0].deltaMinor],
    ['candidate.dueDate', suggest.candidates[0].dueDate],
    ['candidate.daysOverdue', suggest.candidates[0].daysOverdue],
    ['candidate.currency', suggest.candidates[0].currency],
    ['candidate.openMinor', suggest.candidates[0].openMinor],
    ['candidate.grossMinor', suggest.candidates[0].grossMinor],
    ['candidate.paidMinor', suggest.candidates[0].paidMinor],
    ['candidate.prefillMinor', suggest.candidates[0].prefillMinor],
    // the Gegenpartei column, the Guthaben chip, the journal deep link, the status chip
    ['payment.counterparty.name', payment.counterparty.name],
    ['payment.onAccountMinor', payment.onAccountMinor],
    ['payment.journalEntryId', payment.journalEntryId],
    ['payment.status', payment.status],
    ['payment.direction', payment.direction],
    ['payment.source', payment.source],
    ['payment.allocations[].targetNumber', payment.allocations[0].targetNumber],
    // the write response, on which the whole stale-view prevention rests
    ['record.documents[].openMinor', res.documents[0].openMinor],
    ['record.documents[].paidMinor', res.documents[0].paidMinor],
    ['record.documents[].number', res.documents[0].number],
    ['record.documents[].status', res.documents[0].status],
    ['record.entryId', res.entryId],
    ['record.onAccountMinor', res.onAccountMinor],
  ];
  for (const [name, value] of required) {
    assert.notEqual(value, undefined, `${name} is missing: the affordance it feeds cannot be built`);
  }
  // These two are legitimately null in this world and their PRESENCE is what matters, because a
  // consumer branches on null vs a value: absent would be indistinguishable from "no FX at all".
  assert.equal('fx' in preview, true);
  assert.equal('istVat' in preview, true);
  assert.equal('error' in preview, true);
  assert.equal('reversalEntryId' in payment, true);
  assert.equal('reversedAt' in payment, true);
});
