/**
 * Owner decisions P10 (cross-currency allocation), P9 (explicit intent) and P4 (the configurable
 * write-off threshold).
 *
 * The FX cases are the point of P10: an invoice is booked at the rate of its OWN day and settled at
 * the rate of the payment's day, and the gap between those two conversions is money that was really
 * won or lost. It is realised at settlement, so it is posted here rather than left for A22's
 * period-end revaluation to find.
 *
 * A14 uses the §H-FX store and never a rate mechanism of its own: `resolveFxRate` answers, and when
 * it cannot the payment is refused with `needs_fx_rate` instead of converted at a guess.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recordPayment,
  previewPayment,
  setWriteOffThreshold,
  PAYMENT_INTENTS,
} from '../../dist/core/payments/index.js';
import { setup, issueInvoice, seedRate, legsOf, accountBalance, counts } from './support.mjs';

/** A EUR invoice issued on 01.07 at 0.95, and the world moved on to 19.07. */
function eurWorld({ netMinor = 100000 } = {}) {
  const t = setup({ at: '2026-07-01T00:00:00.000Z' });
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-01' });
  const inv = issueInvoice(t.ctx, {
    contactId: t.customerId,
    netMinor,
    taxCode: 'none',
    currency: 'EUR',
    key: 'eur',
  });
  const later = t.at('2026-07-19T00:00:00.000Z');
  seedRate(later, { currency: 'EUR', rate: '0.97', asOf: '2026-07-19' });
  return { t, inv, later };
}

test('FX: a EUR invoice booked at 0.95 and paid at 0.97 posts the realised gain of CHF 20.00', () => {
  const { t, inv, later } = eurWorld();
  // The invoice put EUR 1'000.00 on the receivable, worth CHF 950.00 on the day it was issued.
  assert.equal(inv.currency, 'EUR');
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 95000);

  const res = recordPayment(later, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 100000,
    currency: 'EUR',
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 100000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-fx',
  });
  assert.equal(res.ok, true, JSON.stringify(res));

  const legs = legsOf(t.store, t.workspaceId, res.entryId);
  assert.deepEqual(
    legs.map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', 97000, 0], // EUR 1'000.00 arrived, worth CHF 970.00 on the payment date
      ['1100', 0, 95000], // the receivable clears at exactly the CHF it was booked at
      ['3806', 0, 2000], // the realised difference: CHF 20.00 gained on the exchange
    ],
  );
  // The receivable is FLAT. Without the difference leg it would carry a permanent CHF 20.00 stub
  // that no later payment could ever clear.
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 0);
  assert.equal(accountBalance(t.store, t.workspaceId, '3806'), -2000);
  // Operating, not financial result: what settled was a trade receivable. 6949 Währungsverluste is
  // A22's period-end revaluation of FINANCIAL positions and a trade settlement never reaches it.
  assert.equal(accountBalance(t.store, t.workspaceId, '6949'), 0);
  assert.equal(res.documents[0].openMinor, 0);
  assert.equal(res.documents[0].status, 'settled');
});

test('FX: the rate moving the other way posts a realised LOSS, debited to the same account', () => {
  const t = setup({ at: '2026-07-01T00:00:00.000Z' });
  seedRate(t.ctx, { currency: 'EUR', rate: '0.98', asOf: '2026-07-01' });
  const inv = issueInvoice(t.ctx, {
    contactId: t.customerId,
    netMinor: 100000,
    taxCode: 'none',
    currency: 'EUR',
    key: 'eurloss',
  });
  const later = t.at('2026-07-19T00:00:00.000Z');
  seedRate(later, { currency: 'EUR', rate: '0.94', asOf: '2026-07-19' });

  const res = recordPayment(later, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 100000,
    currency: 'EUR',
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 100000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-fxloss',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(
    legsOf(t.store, t.workspaceId, res.entryId).map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', 94000, 0],
      ['1100', 0, 98000],
      ['3806', 4000, 0],
    ],
  );
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 0);
});

test('FX: a PARTIAL foreign settlement takes its proportional share of the booked base', () => {
  const { t, inv, later } = eurWorld();
  const res = recordPayment(later, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 40000,
    currency: 'EUR',
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 40000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-fxpart',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(
    legsOf(t.store, t.workspaceId, res.entryId).map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', 38800, 0], // EUR 400.00 at 0.97
      ['1100', 0, 38000], // 40% of the CHF 950.00 the receivable was booked at
      ['3806', 0, 800],
    ],
  );
  // EUR 600.00 stays open on the invoice, and CHF 570.00 stays on the receivable: the two views
  // agree because the base share is proportional to the document-currency share.
  assert.equal(res.documents[0].openMinor, 60000);
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 57000);
});

test('FX: a CROSS-currency settlement states the cash consumed as well as the amount settled', () => {
  // A EUR payment settling a CHF invoice. The conversion the payer's bank applied happened outside
  // these books, so the engine will not invent it: the caller states both figures.
  const t = setup();
  seedRate(t.ctx, { currency: 'EUR', rate: '0.97', asOf: '2026-07-19' });
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 97000, taxCode: 'none', key: 'chf' });

  const missing = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 100000,
    currency: 'EUR',
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 97000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-x1',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'needs_payment_amount');
  assert.equal(counts(t.store, t.workspaceId).payments, 0);

  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 100000,
    currency: 'EUR',
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 97000, paymentAmountMinor: 100000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-x2',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(
    legsOf(t.store, t.workspaceId, res.entryId).map((l) => [l.number, l.debit, l.credit]),
    [
      ['1020', 97000, 0],
      ['1100', 0, 97000],
    ],
  );
  assert.equal(res.documents[0].openMinor, 0);
  assert.equal(accountBalance(t.store, t.workspaceId, '1100'), 0);
});

test('FX: a same-currency allocation may not disagree with itself about how much cash it used', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 100000, taxCode: 'none', key: 'same' });
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 100000,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 100000, paymentAmountMinor: 90000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-dis',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_input');
  assert.equal(res.reason, 'same_currency_amounts_must_agree');
});

test('FX: the preview reports the rate, its provenance and the realised difference before the click', () => {
  const { t, inv, later } = eurWorld();
  const preview = previewPayment(later, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 100000,
    currency: 'EUR',
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 100000 }],
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.fx.rate, '0.97');
  assert.equal(preview.fx.rateAsOf, '2026-07-19');
  assert.equal(preview.fx.rateSource, 'manual');
  assert.equal(preview.fx.baseAmountMinor, 97000);
  assert.equal(preview.fx.realisedDiffMinor, 2000);
  assert.equal(preview.balanced, true);
});

test('FX: a CHF payment in a CHF workspace carries no FX block and no difference leg at all', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: 100000, taxCode: 'none', key: 'plain' });
  const preview = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 100000,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 100000 }],
  });
  assert.equal(preview.fx, null);
  assert.equal(preview.legs.length, 2);
});

// --- P9, the explicit intent -------------------------------------------------------------------

test('intent: every A14 write refuses without its own exact token, and a preview never has one', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'intent' });
  const body = {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 108100,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 108100 }],
    idempotencyKey: 'p-int',
  };

  // Absent, wrong type, a truthy boolean, and ANOTHER verb's token are all refused: a caller cannot
  // arrive at a posting by reusing an intent it happened to have.
  for (const intent of [undefined, true, 'yes', PAYMENT_INTENTS.reverse, PAYMENT_INTENTS.allocate]) {
    const res = recordPayment(t.ctx, { ...body, ...(intent === undefined ? {} : { intent }) });
    assert.equal(res.ok, false, String(intent));
    assert.equal(res.error, 'intent_required', String(intent));
    assert.equal(res.expected, PAYMENT_INTENTS.record);
  }
  assert.equal(counts(t.store, t.workspaceId).payments, 0);

  // The preview is a read: it takes no intent, it writes nothing, and it can never become a post.
  const preview = previewPayment(t.ctx, { ...body, intent: PAYMENT_INTENTS.record });
  assert.equal(preview.ok, true);
  assert.equal(counts(t.store, t.workspaceId).payments, 0);

  const posted = recordPayment(t.ctx, { ...body, intent: PAYMENT_INTENTS.record });
  assert.equal(posted.ok, true, JSON.stringify(posted));
});

// --- P4, the configurable threshold -------------------------------------------------------------

test('threshold: the default is CHF 1.00 and a workspace may configure its own', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'thr' });
  const previewWith = () =>
    previewPayment(t.ctx, {
      direction: 'incoming',
      date: '2026-07-19',
      amountMinor: 107850,
      bankAccountId: t.bankId,
      allocations: [{ documentId: inv.id, amountMinor: 107850 }],
    });

  // A residual of 2.50 is beyond the CHF 1.00 default, so no one-click offer appears.
  assert.equal(previewWith().writeOffThresholdMinor, 100);
  assert.equal(previewWith().rows[0].writeOffOfferedMinor, 0);

  const set = setWriteOffThreshold(t.ctx, { thresholdMinor: 250, idempotencyKey: 'thr-1' });
  assert.equal(set.ok, true);
  assert.equal(previewWith().writeOffThresholdMinor, 250);
  // Inclusive at the boundary: 2.50 against a threshold of 2.50 is offered.
  assert.equal(previewWith().rows[0].writeOffOfferedMinor, 250);

  assert.equal(setWriteOffThreshold(t.ctx, { thresholdMinor: -1, idempotencyKey: 'thr-2' }).ok, false);
});
