/**
 * The A14 STUDIO fixture-versus-engine drift guard.
 *
 * `test/payments/read-model-fixture.test.mjs` pins the engine's contract fixture. This one pins the
 * fixtures the Studio's own jsdom suites render, which is a different file set and a different
 * failure mode: an app test renders `app/src/surfaces/Payments/*.fixture.json` and can pass green
 * forever against a shape the engine stopped sending. That is this repo's signature failure, and it
 * has shipped five times (`inUse`, `vatCodes`, the profile wrapper, `address` vs `creditorAddress`,
 * `null` vs `undefined`): each time the fixture carried the same wrong keys as the consumer, so the
 * suite agreed with the bug.
 *
 * The rule here is the same as `test/sales/invoice-gui-fixture.test.mjs`: rebuild the world, call the
 * live engine, and compare KEYS and KINDS (null being its own kind, because `null` and `undefined`
 * are the pair that bit us). Values are deliberately NOT compared in general: ids and dates are the
 * fixture's business. The exceptions are the figures a GUI affordance is built on, which are
 * asserted exactly, because a remainder that drifts is money on screen that the ledger disagrees
 * with.
 *
 * It also pins the three INTENT TOKENS. The browser cannot import engine code, so
 * `app/src/surfaces/Payments/intent.ts` re-declares them as string literals; without this assertion a
 * rename in the engine would leave every Studio post rejected with `intent_required` at runtime and
 * every app test green.
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
import { listAccounts } from '../../dist/core/accounts/index.js';
import { setup, issueInvoice, addCustomer, GROSS_MINOR } from './support.mjs';

const DIR = new URL('../../app/src/surfaces/Payments/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'));

function keysOf(obj) {
  return Object.keys(obj).sort();
}
function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Compare keys, and the kind of every value, one level down into nested objects and array heads. */
function assertShape(fixture, live, where) {
  assert.deepEqual(keysOf(fixture), keysOf(live), `${where}: key drift`);
  for (const key of Object.keys(live)) {
    assert.equal(
      kindOf(fixture[key]),
      kindOf(live[key]),
      `${where}.${key}: kind drift (fixture ${kindOf(fixture[key])}, engine ${kindOf(live[key])})`,
    );
  }
}

/**
 * The exact world the Studio fixtures depict, rebuilt from the shipped seed.
 *
 * Two customers and three invoices, because the candidate list's whole job is ranking and a
 * one-invoice world cannot show a rank. One payment is posted with a deliberate over-payment, so the
 * Guthaben chip and its owner (P12b) have something real behind them.
 */
function world() {
  const t = setup();
  const second = addCustomer(t.ctx, 'Beispiel GmbH', 'c-beispiel');

  const paid = issueInvoice(t.ctx, { contactId: t.customerId, key: 'inv-paid', dueDate: '2026-08-18' });
  const open = issueInvoice(t.ctx, {
    contactId: second,
    netMinor: 50000,
    taxCode: 'none',
    key: 'inv-open',
    dueDate: '2026-08-02',
  });
  const third = issueInvoice(t.ctx, {
    contactId: t.customerId,
    netMinor: 25000,
    taxCode: 'none',
    key: 'inv-third',
    dueDate: '2026-07-10',
  });

  const recorded = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 110000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    reference: '210000000003139471430009017',
    allocations: [{ documentId: paid.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'cap-p1',
  });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));

  return { t, second, paid, open, third, recorded };
}

test('record-payment.fixture.json matches the live record_payment response', () => {
  const { recorded } = world();
  const fixture = read('record-payment.fixture.json');

  assertShape(fixture, recorded, 'record_payment');
  assertShape(fixture.documents[0], recorded.documents[0], 'record_payment.documents[0]');

  // The stale-view prevention (P42) depends on `documents[]` carrying the settled figures, so the
  // three that reconcile on screen are asserted as VALUES, not merely as kinds.
  assert.equal(fixture.documents[0].openMinor, recorded.documents[0].openMinor);
  assert.equal(fixture.documents[0].paidMinor, recorded.documents[0].paidMinor);
  assert.equal(fixture.documents[0].status, recorded.documents[0].status);
});

test('list-payments.fixture.json matches the live list_payments response', () => {
  const { t } = world();
  const live = listPayments(t.ctx, {});
  const fixture = read('list-payments.fixture.json');

  assertShape(fixture, live, 'list_payments');
  assertShape(fixture.payments[0], live.payments[0], 'list_payments.payments[0]');
  assertShape(fixture.payments[0].bankAccount, live.payments[0].bankAccount, 'list_payments.bankAccount');
  assertShape(
    fixture.payments[0].counterparty,
    live.payments[0].counterparty,
    'list_payments.counterparty',
  );
  assertShape(
    fixture.payments[0].allocations[0],
    live.payments[0].allocations[0],
    'list_payments.allocations[0]',
  );

  // The S1 row renders these four directly. `onAccountMinor` is the Guthaben chip's whole basis.
  assert.equal(fixture.payments[0].status, live.payments[0].status);
  assert.equal(fixture.payments[0].amountMinor, live.payments[0].amountMinor);
  assert.equal(fixture.payments[0].onAccountMinor, live.payments[0].onAccountMinor);
  assert.equal(fixture.payments[0].allocatedMinor, live.payments[0].allocatedMinor);
});

test('get-payment.fixture.json matches the live get_payment response', () => {
  const { t, recorded } = world();
  const live = getPayment(t.ctx, { paymentId: recorded.paymentId });
  const fixture = read('get-payment.fixture.json');

  assertShape(fixture, live, 'get_payment');
  assertShape(fixture.payment, live.payment, 'get_payment.payment');
  assertShape(fixture.payment.allocations[0], live.payment.allocations[0], 'get_payment.allocations[0]');

  // S3 links the journal entry by id, which closes A10-G17's generic-/journal-link defect class.
  assert.equal(typeof live.payment.journalEntryId, 'string');
});

test('suggest-matches.fixture.json matches the live suggest_payment_matches response', () => {
  const { t, second } = world();
  const live = suggestPaymentMatches(t.ctx, {
    amountMinor: 50000,
    direction: 'incoming',
    counterpartyId: second,
  });
  const fixture = read('suggest-matches.fixture.json');

  assertShape(fixture, live, 'suggest_payment_matches');
  assertShape(fixture.candidates[0], live.candidates[0], 'suggest_payment_matches.candidates[0]');

  // S4 renders the tier as a WORD and the count line as two separate numbers. A candidate that fits
  // no tier must carry a null `kind`, or the confidence vocabulary starts lying (§3.2).
  assert.equal(fixture.candidates[0].kind, live.candidates[0].kind);
  assert.equal(fixture.openItemCount, live.openItemCount);
  assert.equal(fixture.referenceMatchCount, live.referenceMatchCount);
  assert.equal(fixture.writeOffThresholdMinor, live.writeOffThresholdMinor);
  // P4's default, asserted as a value: the one-click Ausbuchung offer hangs off it.
  assert.equal(live.writeOffThresholdMinor, 100);
});

test('preview-payment.fixture.json matches the live preview_payment response', () => {
  const { t, second, open } = world();
  const live = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-20',
    amountMinor: 50000,
    bankAccountId: t.bankId,
    counterpartyId: second,
    allocations: [{ documentId: open.id, amountMinor: 50000 }],
  });
  const fixture = read('preview-payment.fixture.json');

  assertShape(fixture, live, 'preview_payment');
  assertShape(fixture.rows[0], live.rows[0], 'preview_payment.rows[0]');
  assertShape(fixture.legs[0], live.legs[0], 'preview_payment.legs[0]');

  // §4 rule 3: the remainder bar renders the ENGINE's figure, never `amount - sum(inputs)` computed
  // in JavaScript. If these two ever disagree, the surface is doing money math it must not do.
  assert.equal(fixture.remainderMinor, live.remainderMinor);
  assert.equal(fixture.allocatedMinor, live.allocatedMinor);
  assert.equal(fixture.rows[0].resultingOpenMinor, live.rows[0].resultingOpenMinor);
  assert.equal(fixture.rows[0].resultingStatus, live.rows[0].resultingStatus);
  // A postable plan carries a null blocker: this is the fixture the "confirm enabled" test needs.
  assert.equal(live.error, null);
  assert.equal(live.balanced, true);
});

test('preview-remainder.fixture.json is a live plan with an UNSPENT remainder', () => {
  const { t, second } = world();
  const live = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-20',
    amountMinor: 108100,
    bankAccountId: t.bankId,
    counterpartyId: second,
    allocations: [],
  });
  const fixture = read('preview-remainder.fixture.json');

  assertShape(fixture, live, 'preview_payment(remainder)');

  // This is the fixture the Guthaben field is rendered against, so the remainder is asserted as a
  // VALUE: the field is filled with `remainderMinor` and the assertion on screen is that figure.
  assert.equal(live.remainderMinor, 108100);
  assert.equal(fixture.remainderMinor, live.remainderMinor);
  // A postable plan. The credit is what the engine DERIVES, which is exactly why the Studio's
  // stated `onAccountMinor` is a cross-check and never a directive, and why the control that writes
  // it produced no visible change until the field existed to hold it.
  assert.equal(live.onAccountMinor, live.remainderMinor);
  assert.equal(live.error, null);

  // The engine is INDIFFERENT to the stated figure when it agrees: parking the remainder changed
  // nothing on the response, which is precisely why the control produced no visible change.
  const stated = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-20',
    amountMinor: 108100,
    bankAccountId: t.bankId,
    counterpartyId: second,
    onAccountMinor: 108100,
    allocations: [],
  });
  assert.deepEqual(stated, live, 'a stated credit equal to the derived one changes nothing at all');
});

test('a stated Guthaben that no longer matches the plan is a BLOCKER, so the field has to be visible', () => {
  const { t, second, open } = world();

  // Park the whole 1081.00, then allocate 500.00 of it. The stated credit is now stale and the
  // engine refuses to post on it. Before this fix that figure lived in a state variable nothing
  // rendered, so an operator saw a disabled confirm blaming a shortfall they could neither see nor
  // clear. A control whose only effect is invisible is worse than no control.
  const stale = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-20',
    amountMinor: 108100,
    bankAccountId: t.bankId,
    counterpartyId: second,
    onAccountMinor: 108100,
    allocations: [{ documentId: open.id, amountMinor: 50000 }],
  });

  assert.notEqual(stale.error, null);
  assert.equal(stale.error.code, 'allocation_mismatch');
  assert.equal(stale.error.statedOnAccountMinor, 108100);
  assert.equal(stale.error.derivedOnAccountMinor, 58100);
});

test('preview-blocked.fixture.json carries a real engine BLOCKER, not an invented one', () => {
  const { t, third } = world();
  const live = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-20',
    amountMinor: 90000,
    bankAccountId: t.bankId,
    counterpartyId: t.customerId,
    allocations: [{ documentId: third.id, amountMinor: 90000 }],
  });
  const fixture = read('preview-blocked.fixture.json');

  assertShape(fixture, live, 'preview_payment(blocked)');

  // The blocker is what disables the confirm control WITH a visible reason (D15/C3). The plan still
  // renders: that is the whole distinction between a blocker and a rejection, and the surface shows
  // the figures either way.
  assert.notEqual(live.error, null, 'the over-allocated preview must carry a blocker');
  assert.equal(fixture.error.code, live.error.code);
  assert.equal(typeof live.error.code, 'string');
  assert.ok(Array.isArray(live.rows) && live.rows.length > 0, 'a blocked plan still renders its rows');
});

test('needs-fx-rate.fixture.json is the live REFUSAL, with the fields the recovery state renders', () => {
  const { t, second } = world();
  const live = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-20',
    amountMinor: 50000,
    currency: 'EUR',
    bankAccountId: t.bankId,
    counterpartyId: second,
    allocations: [],
  });
  const fixture = read('needs-fx-rate.fixture.json');

  assertShape(fixture, live, 'preview_payment(needs_fx_rate)');

  // P10: with no admissible rate the payment is REFUSED rather than converted at a guess, and this
  // is a rejection of the whole call, NOT a `blocker` on a rendered plan. The Studio's recovery
  // state names the pair and the date, so both fields have to survive.
  assert.equal(live.ok, false);
  assert.equal(live.error, 'needs_fx_rate');
  assert.equal(live.currency, 'EUR');
  assert.equal(live.baseCurrency, 'CHF');
  assert.equal(live.date, '2026-07-20');
  assert.equal(fixture.currency, live.currency);
  assert.equal(fixture.baseCurrency, live.baseCurrency);
});

test('list-accounts.fixture.json matches the live list_accounts response', () => {
  const { t } = world();
  const live = listAccounts(t.ctx, {});
  const fixture = read('list-accounts.fixture.json');

  assertShape(fixture, live, 'list_accounts');
  assertShape(fixture.accounts[0], live.accounts[0], 'list_accounts.accounts[0]');

  // THE SIXTH MEMBER OF THE FAMILY, pinned. S9's picker renders `${number} ${name}` and rendered
  // "1000 undefined" for a release, because it was typed against the payments read model's
  // `BankAccountRef` (`{id, number, label}`) while `list_accounts` is A01's read and answers `name`.
  // The Studio suite stayed green because its hand-written fixture set BOTH keys. So the two
  // assertions that matter are: the engine sends `name`, and the engine does NOT send `label`.
  assert.equal(typeof live.accounts[0].name, 'string');
  assert.ok(live.accounts[0].name.length > 0, 'an account name reaches the picker, so it cannot be empty');
  assert.equal(
    'label' in live.accounts[0],
    false,
    'list_accounts answers `name`: anything reading `label` here renders undefined on screen',
  );

  // The two rows the picker's `/^10[0-2]/` filter actually offers, asserted as VALUES, because the
  // option text on screen is exactly `${number} ${name}` of these rows.
  const banklike = live.accounts.filter((account) => /^10[0-2]/.test(account.number));
  assert.deepEqual(
    banklike.map((account) => `${account.number} ${account.name}`),
    fixture.accounts
      .filter((account) => /^10[0-2]/.test(account.number))
      .map((account) => `${account.number} ${account.name}`),
  );
});

test('the Studio re-declares the engine intent tokens exactly (P9)', () => {
  // `app/src/surfaces/Payments/intent.ts` cannot import the engine (better-sqlite3 is native and
  // Node-only), so the tokens are re-declared as literals. A rename in the engine without this
  // assertion means every Studio post is rejected `intent_required` while every app test stays green.
  const source = readFileSync(new URL('intent.ts', DIR), 'utf8');
  for (const [verb, token] of Object.entries(PAYMENT_INTENTS)) {
    assert.match(
      source,
      new RegExp(`${verb}:\\s*'${token}'`),
      `the Studio's intent map must carry ${verb}: '${token}' exactly as the engine declares it`,
    );
  }
});
