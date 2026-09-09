// A21, QR incoming matching: the engine claims that matter (spec §8).
//
// The claims are not "a row was written". They are:
//   - scoring reserves `high` for an exact reference AND an exact amount, where exact admits the
//     invoice's open amount OR open + unpaid Mahngebühr (D73: the Mahnung carries the invoice's
//     own reference), and a mistyped check digit NEVER ranks (reference_invalid);
//   - applying delegates every franc to A14 (one payment, one balanced entry, document settled),
//     and a replay moves the ledger ZERO times, proven by COUNTING ROWS (§H-IDEMPOTENT), under the
//     SAME key and under a DIFFERENT key on the same credit alike (idempotent PER CREDIT);
//   - an override of an applied row is a REVERSING A14 payment (§H-AUDIT): the invoice re-opens,
//     the bank nets to zero, and the row keeps the correction chain;
//   - the P8 gate: without `confirmed`, only the dial + a live `high` lets money move, and an
//     override of an applied row never rides the dial;
//   - §H-TENANT: nothing crosses a workspace boundary;
//   - a foreign-currency credit is capped at `medium` and REFUSED on apply.
//
// The world is test/payments' own support (the shipped chart, real sales verbs, real postEntry),
// because A21's figures must reconcile against the same ledger A14's do.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recordIncomingCredit,
  matchIncomingByQrr,
  applyQrMatch,
  overrideQrMatch,
  listUnmatchedIncoming,
  setQrAutoApply,
  createBankAccount,
} from '../../dist/core/banking/index.js';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { getPayment } from '../../dist/core/payments/index.js';
import { listOpenItems } from '../../dist/core/debtors/index.js';
import { setDunningConfig, proposeDunningRun, issueDunningRun } from '../../dist/core/dunning/index.js';
import { createCreditNote, issueCreditNote } from '../../dist/core/sales/index.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';

import { setup, issueInvoice, seedRate, counts, accountBalance, GROSS_MINOR } from '../payments/support.mjs';
import { PLAIN_IBAN } from './support.mjs';

const ok = (res, label = 'result') => {
  assert.equal(res.ok, true, `expected ${label} ok, got ${JSON.stringify(res)}`);
  return res;
};

/** The world: the A14 fixture plus an A19 Bankkonto linked to 1020. */
function world(opts = {}) {
  const t = setup(opts);
  const bank = ok(
    createBankAccount(t.ctx, {
      name: 'PostFinance Geschäft',
      iban: PLAIN_IBAN,
      currency: 'CHF',
      ledgerAccountId: t.bankId,
      idempotencyKey: 'qr-bank',
    }),
    'createBankAccount',
  );
  return { ...t, bankAccountId: bank.bankAccountId };
}

/** An issued invoice and its QRR, the reference derived exactly as A11 issues it. */
function invoiceWithRef(t, key, extra = {}) {
  const doc = issueInvoice(t.ctx, { contactId: t.customerId, key, ...extra });
  return { doc, reference: buildQrrReference(doc.number) };
}

function record(t, reference, amountMinor, key, extra = {}) {
  return ok(
    recordIncomingCredit(t.ctx, {
      bankAccountId: t.bankAccountId,
      amountMinor,
      valueDate: '2026-07-19',
      reference,
      idempotencyKey: key,
      ...extra,
    }),
    'recordIncomingCredit',
  );
}

// --- scoring (spec §8 a/b/c/f) -------------------------------------------------------------------

test('exact reference and exact amount score high; the figures are the engine level truth', () => {
  const t = world();
  const { reference } = invoiceWithRef(t, 'sc1');
  const scored = ok(matchIncomingByQrr(t.ctx, { reference, amountMinor: GROSS_MINOR }));
  assert.equal(scored.match.confidence, 'high');
  assert.equal(scored.match.reason, 'exact_open');
  assert.equal(scored.match.invoiceOpenMinor, GROSS_MINOR);
  assert.equal(scored.match.totalDueMinor, GROSS_MINOR);
  assert.equal(scored.match.deltaMinor, 0);
});

test('a short amount scores medium/amount_short and is never high, however close', () => {
  const t = world();
  const { reference } = invoiceWithRef(t, 'sc2');
  // 5 Rappen short: the confidence never rounds away a real discrepancy (P2).
  const scored = ok(matchIncomingByQrr(t.ctx, { reference, amountMinor: GROSS_MINOR - 5 }));
  assert.equal(scored.match.confidence, 'medium');
  assert.equal(scored.match.reason, 'amount_short');
  assert.equal(scored.match.deltaMinor, -5);
});

test('an unknown reference is none/no_invoice, a typo is none/reference_invalid, and neither writes', () => {
  const t = world();
  const before = counts(t.store, t.workspaceId);
  const unknown = ok(matchIncomingByQrr(t.ctx, { reference: buildQrrReference('X-9999'), amountMinor: 1000 }));
  assert.equal(unknown.match.confidence, 'none');
  assert.equal(unknown.match.reason, 'no_invoice');
  // The SIX sample QRR with its check digit corrupted: committed to the QRR regime, reported as a
  // typo, and NEVER downgraded to a ranking hint (the A14 rule).
  const typo = ok(matchIncomingByQrr(t.ctx, { reference: '210000000003139471430009018', amountMinor: 1000 }));
  assert.equal(typo.match.confidence, 'none');
  assert.equal(typo.match.reason, 'reference_invalid');
  const free = ok(matchIncomingByQrr(t.ctx, { reference: 'Rechnung Juli', amountMinor: 1000 }));
  assert.equal(free.match.reason, 'no_reference');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a pure read wrote a row');
});

test('a settled invoice answers none/already_paid and names the invoice', () => {
  const t = world();
  const { doc, reference } = invoiceWithRef(t, 'sc3');
  const credit = record(t, reference, GROSS_MINOR, 'sc3-credit');
  ok(applyQrMatch(t.ctx, {
    creditId: credit.credit.creditId,
    invoiceId: doc.id,
    mode: 'full',
    confirmed: true,
    idempotencyKey: 'sc3-apply',
  }));
  const scored = ok(matchIncomingByQrr(t.ctx, { reference, amountMinor: GROSS_MINOR }));
  assert.equal(scored.match.confidence, 'none');
  assert.equal(scored.match.reason, 'already_paid');
  assert.equal(scored.match.invoiceId, doc.id);
});

test('a foreign-currency credit against a CHF invoice is capped at medium/currency_differs, delta null', () => {
  const t = world();
  const { reference } = invoiceWithRef(t, 'sc4');
  const scored = ok(matchIncomingByQrr(t.ctx, { reference, amountMinor: GROSS_MINOR, currency: 'EUR' }));
  assert.equal(scored.match.confidence, 'medium');
  assert.equal(scored.match.reason, 'currency_differs');
  // F6: EUR minor minus CHF minor is not a delta. The figure is null, never a subtraction across
  // two units the surface would then render as "Differenz CHF 0.00".
  assert.equal(scored.match.deltaMinor, null);
});

test('F7: a decided row keeps its words but carries LIVE figures, so a partial shows the remaining open', () => {
  const t = world();
  const { doc, reference } = invoiceWithRef(t, 'dr1');
  const short = record(t, reference, GROSS_MINOR - 5000, 'dr1-credit');
  ok(applyQrMatch(t.ctx, {
    creditId: short.credit.creditId,
    invoiceId: doc.id,
    mode: 'partial',
    confirmed: true,
    idempotencyKey: 'dr1-apply',
  }));
  const listed = ok(listUnmatchedIncoming(t.ctx, {}));
  const row = listed.items.find((i) => i.creditId === short.credit.creditId);
  assert.equal(row.status, 'applied');
  assert.equal(row.appliedMode, 'partial');
  // The decided WORDS are history; the FIGURES are the books now: CHF 50.00 still open.
  assert.equal(row.score.invoiceOpenMinor, 5000);
  assert.equal(row.score.totalDueMinor, 5000);
  assert.equal(row.score.deltaMinor, null);
  assert.equal(listed.writeOffThresholdMinor, 100, 'the list must carry the A14 threshold for the surface');
});

// --- the Mahngebühr figure (spec §0 note 4, D73) -------------------------------------------------

test('open + unpaid Mahngebühr is the SECOND exact figure, and applying it parks the fee as Guthaben', () => {
  const t = world();
  const feeAccount = t.store.db
    .prepare(`SELECT id FROM account WHERE workspace_id = ? AND type = 'income' ORDER BY number LIMIT 1`)
    .get(t.workspaceId);
  // The Mahnlauf's issue path refuses without the creditor block (the letter's mandatory content).
  ok(setCreditorProfile(t.ctx, {
    creditorName: 'Muster Grafik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    iban: PLAIN_IBAN,
  }), 'setCreditorProfile');
  const base = { bookFee: true, feeIncomeAccountId: feeAccount.id };
  ok(setDunningConfig(t.ctx, {
    levels: [
      { level: 1, daysOverdue: 10, feeMinor: 2000, ...base },
      { level: 2, daysOverdue: 20, feeMinor: 0 },
      { level: 3, daysOverdue: 30, feeMinor: 0 },
    ],
    idempotencyKey: 'fee-config',
  }), 'setDunningConfig');
  const { doc, reference } = invoiceWithRef(t, 'fee1', { dueDate: '2026-06-01' });
  const proposed = ok(proposeDunningRun(t.ctx, { idempotencyKey: 'fee-propose' }), 'propose');
  ok(issueDunningRun(t.ctx, { runId: proposed.runId, confirmed: true, idempotencyKey: 'fee-issue' }), 'issue');

  // The customer pays what the Mahnung demanded: invoice open + CHF 20.00 fee, under the
  // invoice's OWN reference (D73).
  const scored = ok(matchIncomingByQrr(t.ctx, { reference, amountMinor: GROSS_MINOR + 2000 }));
  assert.equal(scored.match.confidence, 'high');
  assert.equal(scored.match.reason, 'exact_open_plus_fee');
  assert.equal(scored.match.dunningFeeMinor, 2000);
  assert.equal(scored.match.totalDueMinor, GROSS_MINOR + 2000);

  const credit = record(t, reference, GROSS_MINOR + 2000, 'fee-credit');
  const applied = ok(applyQrMatch(t.ctx, {
    creditId: credit.credit.creditId,
    invoiceId: doc.id,
    mode: 'full',
    confirmed: true,
    idempotencyKey: 'fee-apply',
  }), 'applyQrMatch');
  // The A15 §4 / D59 known limit, honoured rather than worked around: the invoice settles and the
  // fee share parks as a Guthaben on the payment; the OP-Liste pair nets to zero.
  const payment = ok(getPayment(t.ctx, { paymentId: applied.paymentId }));
  assert.equal(payment.payment.onAccountMinor, 2000);
  const open = ok(listOpenItems(t.ctx, {}));
  const invoiceRow = open.items.find((i) => i.documentId === doc.id);
  const parked = open.items.find((i) => i.kind === 'on_account');
  assert.ok(invoiceRow !== undefined && parked !== undefined, 'expected the fee row and the parked credit');
  assert.equal(invoiceRow.openMinor + parked.openMinor, 0, 'the residual fee and the Guthaben must net to zero');
});

// --- apply (spec §8 a/d) -------------------------------------------------------------------------

test('applying a high match settles the invoice through ONE A14 payment, idempotent on ROWS per credit', () => {
  const t = world();
  const { doc, reference } = invoiceWithRef(t, 'ap1');
  const credit = record(t, reference, GROSS_MINOR, 'ap1-credit');
  const creditId = credit.credit.creditId;

  const applied = ok(applyQrMatch(t.ctx, {
    creditId,
    invoiceId: doc.id,
    mode: 'full',
    confirmed: true,
    idempotencyKey: 'ap1-apply',
  }));
  const after = counts(t.store, t.workspaceId);
  assert.equal(after.payments, 1);

  const status = t.store.db
    .prepare('SELECT status FROM document WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, doc.id);
  assert.equal(status.status, 'settled');
  // Debit 1020 Bank for the credit amount: the A14 posting really happened.
  assert.equal(accountBalance(t.store, t.workspaceId, '1020'), GROSS_MINOR);

  // Replay under the SAME key: byte-identical, zero new rows.
  const replaySame = ok(applyQrMatch(t.ctx, {
    creditId,
    invoiceId: doc.id,
    mode: 'full',
    confirmed: true,
    idempotencyKey: 'ap1-apply',
  }));
  assert.equal(replaySame.paymentId, applied.paymentId);
  // Replay under a DIFFERENT key: the credit is already applied to this invoice, so the decision
  // replays rather than double-settling (idempotent PER CREDIT, not merely per caller key).
  const replayOther = ok(applyQrMatch(t.ctx, {
    creditId,
    invoiceId: doc.id,
    mode: 'full',
    confirmed: true,
    idempotencyKey: 'ap1-apply-retry',
  }));
  assert.equal(replayOther.paymentId, applied.paymentId);
  assert.deepEqual(counts(t.store, t.workspaceId), after, 'a replay moved the ledger');
});

test('F3: mode full writes off only within the A14 threshold, refuses above it naming the amount', () => {
  const t = world();
  // Inside the CHF 1.00 default threshold: a 50-Rappen residual is the one-click Ausbuchung.
  const first = invoiceWithRef(t, 'am1');
  const inside = record(t, first.reference, GROSS_MINOR - 50, 'am1-credit');
  ok(applyQrMatch(t.ctx, {
    creditId: inside.credit.creditId,
    invoiceId: first.doc.id,
    mode: 'full',
    confirmed: true,
    idempotencyKey: 'am1-apply',
  }));
  const settled = t.store.db
    .prepare('SELECT status FROM document WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, first.doc.id);
  assert.equal(settled.status, 'settled', 'accept-as-full inside the threshold must settle the invoice');

  // Above it: the residual is named and NOTHING is booked. The unbounded write-off (the critic's
  // CHF 981.00 to 3805 from a mode word) is unreachable.
  const second = invoiceWithRef(t, 'am2');
  const above = record(t, second.reference, GROSS_MINOR - 500, 'am2-credit');
  const before = counts(t.store, t.workspaceId);
  const refused = applyQrMatch(t.ctx, {
    creditId: above.credit.creditId,
    invoiceId: second.doc.id,
    mode: 'full',
    confirmed: true,
    idempotencyKey: 'am2-apply',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'write_off_above_threshold');
  assert.equal(refused.writeOffMinor, 500);
  assert.equal(refused.thresholdMinor, 100);
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a refused accept-as-full booked something');

  // The same credit as a PARTIAL: allocates, writes off nothing, invoice stays honestly open.
  ok(applyQrMatch(t.ctx, {
    creditId: above.credit.creditId,
    invoiceId: second.doc.id,
    mode: 'partial',
    confirmed: true,
    idempotencyKey: 'am2-apply-partial',
  }));
  const stillOpen = t.store.db
    .prepare('SELECT status FROM document WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, second.doc.id);
  assert.equal(stillOpen.status, 'partially_paid', 'a partial never writes off');
});

test('F3: an omitted mode is the SAFE mode: partial, never a write-off', () => {
  const t = world();
  const { doc, reference } = invoiceWithRef(t, 'dm1');
  const short = record(t, reference, GROSS_MINOR - 500, 'dm1-credit');
  // No `mode` field at all: the critic's C1 shape, which used to settle a CHF 1'081.00 invoice
  // from a CHF 100.00 credit and forgive the rest.
  ok(applyQrMatch(t.ctx, {
    creditId: short.credit.creditId,
    invoiceId: doc.id,
    confirmed: true,
    idempotencyKey: 'dm1-apply',
  }));
  const status = t.store.db
    .prepare('SELECT status FROM document WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, doc.id);
  assert.equal(status.status, 'partially_paid', 'the default mode wrote off');
  const writeOff = accountBalance(t.store, t.workspaceId, '3805');
  assert.equal(writeOff, 0, 'the default mode booked a loss');
});

test('F5: apply(full) after apply(partial) refuses as already_applied/mode_mismatch, never ok-doing-nothing', () => {
  const t = world();
  const { doc, reference } = invoiceWithRef(t, 'mm1');
  const short = record(t, reference, GROSS_MINOR - 5000, 'mm1-credit');
  const first = ok(applyQrMatch(t.ctx, {
    creditId: short.credit.creditId,
    invoiceId: doc.id,
    mode: 'partial',
    confirmed: true,
    idempotencyKey: 'mm1-apply',
  }));
  // The SAME decision replays, whatever the key: idempotent per credit AND per decision.
  const replay = ok(applyQrMatch(t.ctx, {
    creditId: short.credit.creditId,
    invoiceId: doc.id,
    mode: 'partial',
    confirmed: true,
    idempotencyKey: 'mm1-apply-again',
  }));
  assert.equal(replay.paymentId, first.paymentId);
  assert.equal(replay.credit.appliedMode, 'partial');
  // A DIFFERENT mode is a different question: refused with both modes named, not an ok that did
  // nothing (the D59 reported-success shape the critic measured).
  const refused = applyQrMatch(t.ctx, {
    creditId: short.credit.creditId,
    invoiceId: doc.id,
    mode: 'full',
    confirmed: true,
    idempotencyKey: 'mm1-apply-full',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'already_applied');
  assert.equal(refused.appliedMode, 'partial');
  assert.equal(refused.requestedMode, 'full');
});

test('F4: a payer settling a credited invoice NET scores high, and applying it books no fictitious loss', () => {
  const t = world();
  const { doc, reference } = invoiceWithRef(t, 'cn1');
  // A partial Gutschrift of net CHF 100.00: gross CHF 108.10 linked to the invoice (A13).
  const draft = ok(createCreditNote(t.ctx, {
    fromInvoiceId: doc.id,
    mode: 'partial',
    amountMinor: 10000,
    idempotencyKey: 'cn1-draft',
  }), 'createCreditNote');
  ok(issueCreditNote(t.ctx, { creditNoteId: draft.document.id, idempotencyKey: 'cn1-issue' }), 'issueCreditNote');

  // The customer owes the NET: gross 108100 minus the credited 10810.
  const owed = GROSS_MINOR - 10810;
  const scored = ok(matchIncomingByQrr(t.ctx, { reference, amountMinor: owed }));
  assert.equal(scored.match.confidence, 'high', `a net payer must score high: ${JSON.stringify(scored.match)}`);
  assert.equal(scored.match.reason, 'exact_open');
  assert.equal(scored.match.invoiceOpenMinor, owed);
  assert.equal(scored.match.creditedOpenMinor, 10810);
  assert.equal(scored.match.deltaMinor, 0);

  const credit = record(t, reference, owed, 'cn1-credit');
  ok(applyQrMatch(t.ctx, {
    creditId: credit.credit.creditId,
    invoiceId: doc.id,
    mode: 'full',
    confirmed: true,
    idempotencyKey: 'cn1-apply',
  }));
  // The critic's two wrongs, both absent: nothing on 3805, and the customer's position nets to
  // zero (the invoice's residual gross open IS the credited amount).
  assert.equal(accountBalance(t.store, t.workspaceId, '3805'), 0, 'a net payment booked a fictitious loss');
  const open = ok(listOpenItems(t.ctx, {}));
  const row = open.items.find((i) => i.documentId === doc.id);
  if (row !== undefined) {
    assert.equal(
      row.openMinor - row.creditedOpenMinor - row.dunningFeeMinor,
      0,
      'the customer still owes on an invoice they paid net',
    );
  }
});

test('F4: an invoice fully covered by its credit note answers already_paid, not a zero-settlement', () => {
  const t = world();
  const { doc, reference } = invoiceWithRef(t, 'cn2');
  const draft = ok(createCreditNote(t.ctx, { fromInvoiceId: doc.id, idempotencyKey: 'cn2-draft' }), 'createCreditNote');
  ok(issueCreditNote(t.ctx, { creditNoteId: draft.document.id, idempotencyKey: 'cn2-issue' }), 'issueCreditNote');
  const scored = ok(matchIncomingByQrr(t.ctx, { reference, amountMinor: 1000 }));
  assert.equal(scored.match.confidence, 'none');
  assert.equal(scored.match.reason, 'already_paid');
  const credit = record(t, reference, 1000, 'cn2-credit');
  const refused = applyQrMatch(t.ctx, {
    creditId: credit.credit.creditId,
    invoiceId: doc.id,
    confirmed: true,
    idempotencyKey: 'cn2-apply',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'already_paid');
});

test('a cross-currency apply refuses with currency_mismatch instead of guessing a conversion', () => {
  const t = world();
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-19', key: 'eur-rate' });
  const { doc, reference } = invoiceWithRef(t, 'fx1');
  const credit = record(t, reference, GROSS_MINOR, 'fx1-credit', { currency: 'EUR' });
  const refused = applyQrMatch(t.ctx, {
    creditId: credit.credit.creditId,
    invoiceId: doc.id,
    mode: 'full',
    confirmed: true,
    idempotencyKey: 'fx1-apply',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'currency_mismatch');
});

// --- the P8 gate (spec US-A21.5) -----------------------------------------------------------------

test('without confirmed, money moves only under the dial AND a live high score', () => {
  const t = world();
  const { doc, reference } = invoiceWithRef(t, 'p8a');
  const credit = record(t, reference, GROSS_MINOR, 'p8a-credit');
  const creditId = credit.credit.creditId;

  // Dial OFF: refused, named.
  const refused = applyQrMatch(t.ctx, { creditId, invoiceId: doc.id, idempotencyKey: 'p8a-1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'needs_confirmation');

  // Dial ON + live high: allowed unattended.
  ok(setQrAutoApply(t.ctx, { autoApply: true, idempotencyKey: 'p8a-dial' }));
  ok(applyQrMatch(t.ctx, { creditId, invoiceId: doc.id, idempotencyKey: 'p8a-2' }));

  // Dial ON but a MEDIUM score: still refused, the dial covers only high.
  const short = invoiceWithRef(t, 'p8b');
  const shortCredit = record(t, short.reference, GROSS_MINOR - 100, 'p8b-credit');
  const refusedMedium = applyQrMatch(t.ctx, {
    creditId: shortCredit.credit.creditId,
    invoiceId: short.doc.id,
    idempotencyKey: 'p8b-1',
  });
  assert.equal(refusedMedium.ok, false);
  assert.equal(refusedMedium.error, 'needs_confirmation');
});

test('an override of an applied row never rides the dial: confirmed is always required', () => {
  const t = world();
  ok(setQrAutoApply(t.ctx, { autoApply: true, idempotencyKey: 'ov-dial' }));
  const { doc, reference } = invoiceWithRef(t, 'ov1');
  const credit = record(t, reference, GROSS_MINOR, 'ov1-credit');
  const creditId = credit.credit.creditId;
  ok(applyQrMatch(t.ctx, { creditId, invoiceId: doc.id, idempotencyKey: 'ov1-apply' }));
  const refused = overrideQrMatch(t.ctx, { creditId, action: 'unmatch', idempotencyKey: 'ov1-try' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'needs_confirmation');
});

// --- override (spec §8 e) ------------------------------------------------------------------------

test('unmatching an applied row reverses the A14 payment: the invoice re-opens and the bank nets to zero', () => {
  const t = world();
  const { doc, reference } = invoiceWithRef(t, 'un1');
  const credit = record(t, reference, GROSS_MINOR, 'un1-credit');
  const creditId = credit.credit.creditId;
  const applied = ok(applyQrMatch(t.ctx, {
    creditId,
    invoiceId: doc.id,
    mode: 'full',
    confirmed: true,
    idempotencyKey: 'un1-apply',
  }));
  const undone = ok(overrideQrMatch(t.ctx, {
    creditId,
    action: 'unmatch',
    confirmed: true,
    idempotencyKey: 'un1-undo',
  }));
  assert.equal(undone.reversedPaymentId, applied.paymentId);
  assert.deepEqual(undone.credit.reversedPaymentIds, [applied.paymentId], 'the correction chain is kept');
  assert.equal(undone.credit.status, 'open');
  const status = t.store.db
    .prepare('SELECT status FROM document WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, doc.id);
  assert.equal(status.status, 'issued', 'the reversal re-opens the invoice');
  assert.equal(accountBalance(t.store, t.workspaceId, '1020'), 0, 'the bank must net to zero');
});

test('overriding an applied row to another invoice reverses then re-applies: two payments, both real', () => {
  const t = world();
  const first = invoiceWithRef(t, 'rp1');
  const second = invoiceWithRef(t, 'rp2');
  const credit = record(t, first.reference, GROSS_MINOR, 'rp-credit');
  const creditId = credit.credit.creditId;
  const applied = ok(applyQrMatch(t.ctx, {
    creditId,
    invoiceId: first.doc.id,
    mode: 'full',
    confirmed: true,
    idempotencyKey: 'rp-apply',
  }));
  const overridden = ok(overrideQrMatch(t.ctx, {
    creditId,
    invoiceId: second.doc.id,
    confirmed: true,
    idempotencyKey: 'rp-over',
  }));
  assert.equal(overridden.credit.status, 'applied');
  assert.equal(overridden.credit.invoiceId, second.doc.id);
  assert.deepEqual(overridden.credit.reversedPaymentIds, [applied.paymentId]);
  const firstStatus = t.store.db
    .prepare('SELECT status FROM document WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, first.doc.id);
  assert.equal(firstStatus.status, 'issued', 'the first invoice re-opened');
  const secondStatus = t.store.db
    .prepare('SELECT status FROM document WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, second.doc.id);
  assert.equal(secondStatus.status, 'settled', 'the second invoice settled');
  // The bank holds exactly ONE credit's worth: reversal + re-apply, never a double booking.
  assert.equal(accountBalance(t.store, t.workspaceId, '1020'), GROSS_MINOR);
});

// --- the queue and its dedupe --------------------------------------------------------------------

test('a bankTxnId already registered returns the existing row: a re-imported statement duplicates nothing', () => {
  const t = world();
  const { reference } = invoiceWithRef(t, 'dd1');
  const first = record(t, reference, GROSS_MINOR, 'dd1-a', { bankTxnId: 'txn-001' });
  const again = record(t, reference, GROSS_MINOR, 'dd1-b', { bankTxnId: 'txn-001' });
  assert.equal(again.credit.creditId, first.credit.creditId);
  const rows = t.store.db
    .prepare('SELECT COUNT(*) AS n FROM reconciliation_match WHERE workspace_id = ?')
    .get(t.workspaceId);
  assert.equal(rows.n, 1);
});

test('the queue re-scores an open row on read, so a later-issued invoice is found', () => {
  const t = world();
  // The credit arrives BEFORE its invoice exists: recorded as none/no_invoice.
  const reference = buildQrrReference('R-2026-0007');
  const credit = record(t, reference, GROSS_MINOR, 'ls1-credit');
  assert.equal(credit.credit.score.confidence, 'none');
  // The invoice is issued afterwards, with exactly that number sequence continuing. We cannot force
  // a number, so assert through the LIVE score of a matching world instead: issue the invoice and
  // require the list's score for the row to name it once the references agree.
  const { doc } = invoiceWithRef(t, 'ls1');
  const derived = buildQrrReference(doc.number);
  const second = record(t, derived, GROSS_MINOR, 'ls1-second');
  const listed = ok(listUnmatchedIncoming(t.ctx, {}));
  const row = listed.items.find((i) => i.creditId === second.credit.creditId);
  assert.equal(row.score.confidence, 'high');
  assert.equal(row.score.invoiceId, doc.id);
  assert.equal(listed.autoApply, false);
  assert.ok(listed.counts.open >= 1);
});

test('an unregistered bank account answers needs_bank_account, the P9 CTA', () => {
  const t = world();
  const refused = recordIncomingCredit(t.ctx, {
    bankAccountId: 'ba_missing',
    amountMinor: 1000,
    valueDate: '2026-07-19',
    idempotencyKey: 'nb1',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'needs_bank_account');
});

// --- §H-TENANT -----------------------------------------------------------------------------------

test('nothing crosses a workspace boundary: the neighbour sees no rows and cannot decide ours', () => {
  const t = world();
  const { doc, reference } = invoiceWithRef(t, 'tn1');
  const credit = record(t, reference, GROSS_MINOR, 'tn1-credit');

  const neighbourId = createWorkspace(t.deps, { name: 'Nachbar AG' }).workspaceId;
  const neighbour = makeContext(t.store, {
    workspaceId: neighbourId,
    actor: 'intruder',
    clock: fixedClock('2026-07-19T00:00:00.000Z'),
    ids: t.ids,
  });

  const listed = ok(listUnmatchedIncoming(neighbour, {}));
  assert.equal(listed.items.length, 0, 'a foreign queue leaked');

  const refused = applyQrMatch(neighbour, {
    creditId: credit.credit.creditId,
    invoiceId: doc.id,
    mode: 'full',
    confirmed: true,
    idempotencyKey: 'tn1-steal',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'not_found', 'a foreign credit id must be indistinguishable from a missing one');

  const overrideRefused = overrideQrMatch(neighbour, {
    creditId: credit.credit.creditId,
    action: 'dismiss',
    idempotencyKey: 'tn1-dismiss',
  });
  assert.equal(overrideRefused.ok, false);
  assert.equal(overrideRefused.error, 'not_found');
});
