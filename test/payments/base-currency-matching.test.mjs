// A14 matching in a book that is not kept in francs.
//
// `suggestPaymentMatches` compares each open document's currency against the currency the payer
// paid in, and when the caller does not name one it falls back to the currency the BOOK is kept in.
// A franc hardcoded anywhere on that path is not a cosmetic slip: a candidate whose currency does
// not match is returned `disabledReason: 'currency_mismatch'`, so every open invoice in a EUR book
// would come back un-matchable, and the operator would be told their own invoices are in the wrong
// currency.
//
// The first case here is also the user-facing shape of the `createDocument` defect: before the fix a
// EUR book could not ISSUE an invoice at all without naming a currency, because the document row
// said CHF and A11 then asked §H-FX for a CHF/EUR rate that no one has any reason to have recorded.

import test from 'node:test';
import assert from 'node:assert/strict';

import { suggestPaymentMatches } from '../../dist/core/payments/index.js';
import { setup, issueInvoice, GROSS_MINOR } from './support.mjs';

test('a EUR book issues EUR invoices without being asked for a CHF rate it has no use for', () => {
  const t = setup({ baseCurrency: 'EUR' });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'eur-1' });
  assert.equal(
    t.store.db.prepare('SELECT currency FROM document WHERE id = ?').get(inv.id).currency,
    'EUR',
    'the issued row, read back out of SQLite',
  );
  // A base-currency posting stores NO rate. That is the same predicate the ledger uses, seen from
  // the document side: had the row said CHF, these lines would carry a rate for a conversion the
  // book never made.
  const rates = t.store.db
    .prepare('SELECT DISTINCT currency, fx_rate FROM journal_line WHERE entry_id = ?')
    .all(inv.posted_entry_id ?? inv.postedEntryId);
  assert.deepEqual(rates, [{ currency: 'EUR', fx_rate: null }], 'EUR lines, no rate stamped');
  t.store.close();
});

test('an open EUR invoice in a EUR book is matchable: the comparison follows the book, not the franc', () => {
  const t = setup({ baseCurrency: 'EUR' });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'eur-2' });

  // No `currency` on the input: this is exactly the call whose fallback is under test.
  const res = suggestPaymentMatches(t.ctx, { amountMinor: GROSS_MINOR, counterpartyId: t.customerId });
  assert.equal(res.ok, true, JSON.stringify(res));
  const candidate = res.candidates.find((c) => c.targetId === inv.id);
  assert.ok(candidate, 'the open invoice is a candidate at all');
  assert.equal(
    candidate.disabledReason,
    null,
    'a EUR invoice in a EUR book is not a currency mismatch, whatever Switzerland uses',
  );
  assert.equal(candidate.kind, 'exact_amount_customer');
  t.store.close();
});

test('a payment in a THIRD currency is still a mismatch, so the comparison has not simply been switched off', () => {
  const t = setup({ baseCurrency: 'EUR' });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'eur-3' });
  const res = suggestPaymentMatches(t.ctx, {
    amountMinor: GROSS_MINOR,
    counterpartyId: t.customerId,
    currency: 'USD',
  });
  const candidate = res.candidates.find((c) => c.targetId === inv.id);
  assert.equal(candidate.disabledReason, 'currency_mismatch');
  assert.equal(candidate.kind, null, 'a mismatched currency never reaches a tier');
  t.store.close();
});

test('a CHF book is unchanged: an unnamed payment currency still matches its CHF invoices', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'chf-1' });
  const res = suggestPaymentMatches(t.ctx, { amountMinor: GROSS_MINOR, counterpartyId: t.customerId });
  const candidate = res.candidates.find((c) => c.targetId === inv.id);
  assert.equal(candidate.disabledReason, null);
  assert.equal(candidate.kind, 'exact_amount_customer');
  t.store.close();
});
