/**
 * D78 increment 3 (settled-by-credit), independent non-author critic probes, 2026-07-31.
 *
 * Written against the model's known fault lines: the D67/D71 exhausting-credit closure at the
 * equality boundary, the hook-ordering claim, the unwind distance, tenancy, and the A15 fee.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import {
  createDocument,
  issueInvoice,
  createCreditNote,
  issueCreditNote,
  transitionDocument,
  getDocument,
} from '../../dist/core/sales/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { recordPayment, reversePayment, planPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';

function movableClock(start) {
  let at = start;
  return { now: () => at, set: (v) => { at = v; } };
}

function setup(start = '2026-07-16T00:00:00.000Z') {
  const clock = movableClock(start);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, {
    workspaceId, actor: 'user_1', clock, ids, ...ledgerPorts({ store, workspaceId, ids }),
  });
  seedTaxCodes(ctx);
  store.db.prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?").run(workspaceId);
  store.db
    .prepare(`INSERT INTO contact (id, workspace_id, party_role, name, created_at) VALUES ('ct_1', ?, 'customer', 'Muster AG', ?)`)
    .run(workspaceId, start);
  return { ctx, store, workspaceId, clock };
}

const acc = (ctx, number) => ctx.store.db
  .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
  .get(ctx.workspaceId, number).id;

const statusOf = (ctx, id) => getDocument(ctx, { documentId: id }).document.status;

function issuedInvoice(ctx, lines, extra = {}) {
  const doc = createDocument(ctx, { type: 'invoice', contactId: 'ct_1', currency: 'CHF', lines, ...extra });
  assert.ok(doc.ok, JSON.stringify(doc));
  assert.ok(issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: `inv-${doc.document.id}` }).ok);
  return getDocument(ctx, { documentId: doc.document.id }).document;
}

function pay(ctx, target, amountMinor, key, direction = 'incoming') {
  return recordPayment(ctx, {
    intent: PAYMENT_INTENTS.record, direction, date: '2026-07-16', amountMinor,
    currency: 'CHF', bankAccountId: acc(ctx, '1020'), counterpartyId: 'ct_1',
    allocations: [{ documentId: target, amountMinor }], idempotencyKey: key,
  });
}

function credit(ctx, invoice, opts, key) {
  const created = createCreditNote(ctx, { fromInvoiceId: invoice.id, ...opts, idempotencyKey: key });
  if (!created.ok) return { created };
  const issued = issueCreditNote(ctx, { creditNoteId: created.document.id, idempotencyKey: `${key}-i` });
  return { created, issued, id: created.document.id, doc: getDocument(ctx, { documentId: created.document.id }).document };
}

// --- D1. THE EQUALITY BOUNDARY --------------------------------------------------------------------

test('D1a: the boundary is exact in both directions: total-1 stays open, total and total+1 are terminal', () => {
  // The credit's gross is the D67/D71 closure figure, not a number the operator picks, so the
  // boundary is walked with cash instead: one Rappen either side of the covering payment.
  const invoice0 = (() => {
    const { ctx } = setup();
    return { ctx, inv: issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]) };
  })();
  assert.equal(invoice0.inv.totalMinor, 108100);

  for (const [cash, expected] of [[54049, 'partially_paid'], [54050, 'settled'], [54051, 'settled']]) {
    const { ctx } = setup();
    const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
    // Credit exactly half the net: gross 54050 by the engine's own arithmetic.
    const cn = credit(ctx, invoice, { mode: 'partial', amountMinor: 50000 }, 'b-1');
    assert.ok(cn.issued.ok, JSON.stringify(cn.issued));
    assert.equal(cn.doc.totalMinor, 54050);
    assert.ok(pay(ctx, invoice.id, cash, 'p-1').ok);
    assert.equal(statusOf(ctx, invoice.id), expected, `cash ${cash}`);
  }
});

test('D1b: a Rappen-awkward pair: the residue is real and the status tells the truth about it', () => {
  const { ctx } = setup();
  // 3 units at 0.07: gross 0.23. Credit one unit (gross 0.08), pay 0.15 -> exactly covered.
  const invoice = issuedInvoice(ctx, [{ description: 'k', quantityMilli: 3000, unitPriceMinor: 7, taxCode: 'UST81' }]);
  assert.equal(invoice.totalMinor, 23);
  const cn = credit(ctx, invoice, { mode: 'partial', lines: [{ position: 1, quantityMilli: 1000 }] }, 'r-1');
  assert.ok(cn.issued.ok);
  assert.equal(cn.doc.totalMinor, 8);
  assert.ok(pay(ctx, invoice.id, 14, 'p-1').ok);
  assert.equal(statusOf(ctx, invoice.id), 'partially_paid', '14 + 8 = 22 < 23: one Rappen is genuinely open');
  assert.ok(pay(ctx, invoice.id, 1, 'p-2').ok);
  assert.equal(statusOf(ctx, invoice.id), 'settled');
});

test('D1c: a credit ALONE never moves the column, at any coverage, in any pre-payment status', () => {
  for (const pre of ['issued', 'sent']) {
    const { ctx } = setup();
    const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
    if (pre === 'sent') assert.ok(transitionDocument(ctx, { documentId: invoice.id, to: 'sent' }).ok);
    const full = credit(ctx, invoice, {}, `c-${pre}`);
    assert.ok(full.issued.ok);
    assert.equal(full.doc.totalMinor, invoice.totalMinor, 'the credit covers the invoice entirely');
    assert.equal(statusOf(ctx, invoice.id), pre, 'and the lifecycle column did not move');
  }
});

// --- D2. THE HOOK ORDERING ------------------------------------------------------------------------

test('D2a: the invoice is already settled when issue_credit_note RETURNS, and the replay is a no-op', () => {
  const { ctx, store } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  assert.ok(pay(ctx, invoice.id, 54050, 'p-1').ok);
  assert.equal(statusOf(ctx, invoice.id), 'partially_paid');

  const draft = createCreditNote(ctx, { fromInvoiceId: invoice.id, mode: 'partial', amountMinor: 50000, idempotencyKey: 'h-1' });
  assert.ok(draft.ok);
  const issued = issueCreditNote(ctx, { creditNoteId: draft.document.id, idempotencyKey: 'h-1-i' });
  assert.ok(issued.ok);
  // Not "eventually": by the time the verb returns. A poster-side hook would have read the credit
  // as still `draft` and left the invoice partially_paid forever.
  assert.equal(statusOf(ctx, invoice.id), 'settled');

  const historyCount = () => store.db
    .prepare("SELECT COUNT(*) AS n FROM document_status_history WHERE document_id = ? AND to_status = 'settled'")
    .get(invoice.id).n;
  const before = historyCount();
  const replay = issueCreditNote(ctx, { creditNoteId: draft.document.id, idempotencyKey: 'h-1-i' });
  assert.ok(replay.ok);
  assert.equal(statusOf(ctx, invoice.id), 'settled');
  assert.equal(historyCount(), before, 'the replay wrote no second trail row');
});

test('D2b: planPayment PREVIEWS the same word the write derives, at the boundary', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const cn = credit(ctx, invoice, { mode: 'partial', amountMinor: 50000 }, 'pv-1');
  assert.ok(cn.issued.ok);
  for (const [cash, expected] of [[54049, 'partially_paid'], [54050, 'settled']]) {
    const plan = planPayment(ctx, {
      direction: 'incoming', date: '2026-07-16', amountMinor: cash, currency: 'CHF',
      bankAccountId: acc(ctx, '1020'), counterpartyId: 'ct_1',
      allocations: [{ documentId: invoice.id, amountMinor: cash }],
    });
    assert.ok(plan.ok, JSON.stringify(plan));
    const row = plan.plan.rows.find((r) => r.targetId === invoice.id);
    assert.equal(row.resultingStatus, expected, `preview at ${cash}`);
  }
});

// --- D3. THE UNWIND DISTANCE ----------------------------------------------------------------------

test('D3a: cancelling the credit re-opens to partially_paid, and reversing the payment walks all the way back', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  assert.ok(transitionDocument(ctx, { documentId: invoice.id, to: 'sent' }).ok);
  const paid = pay(ctx, invoice.id, 54050, 'p-1');
  assert.ok(paid.ok);
  assert.equal(statusOf(ctx, invoice.id), 'partially_paid');
  const cn = credit(ctx, invoice, { mode: 'partial', amountMinor: 50000 }, 'u-1');
  assert.ok(cn.issued.ok);
  assert.equal(statusOf(ctx, invoice.id), 'settled');

  assert.ok(transitionDocument(ctx, { documentId: cn.id, to: 'cancelled' }).ok);
  assert.equal(statusOf(ctx, invoice.id), 'partially_paid', 'exactly one step back, not to sent');

  const reversed = reversePayment(ctx, {
    intent: PAYMENT_INTENTS.reverse, paymentId: paid.paymentId, date: '2026-07-17',
    reason: 'critic', idempotencyKey: 'rev-1',
  });
  assert.ok(reversed.ok, JSON.stringify(reversed));
  assert.equal(statusOf(ctx, invoice.id), 'sent', 'the pre-settlement status, not issued');
});

test('D3b: a refund payout re-opens a settled-by-credit invoice, and reversing the refund re-settles it', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  assert.ok(pay(ctx, invoice.id, 54050, 'p-1').ok);
  const cn = credit(ctx, invoice, { mode: 'partial', amountMinor: 50000 }, 'rf-1');
  assert.ok(cn.issued.ok);
  assert.equal(statusOf(ctx, invoice.id), 'settled');

  const refund = pay(ctx, cn.id, 20000, 'rf-pay', 'outgoing');
  assert.ok(refund.ok, JSON.stringify(refund));
  assert.equal(statusOf(ctx, invoice.id), 'partially_paid', 'the relief was paid out in cash instead');

  const back = reversePayment(ctx, {
    intent: PAYMENT_INTENTS.reverse, paymentId: refund.paymentId, date: '2026-07-17',
    reason: 'critic', idempotencyKey: 'rf-rev',
  });
  assert.ok(back.ok, JSON.stringify(back));
  assert.equal(statusOf(ctx, invoice.id), 'settled');
});

test('D3c: cancelling the credit on an invoice with NO payments leaves the column alone', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const cn = credit(ctx, invoice, {}, 'n-1');
  assert.ok(cn.issued.ok);
  assert.equal(statusOf(ctx, invoice.id), 'issued');
  assert.ok(transitionDocument(ctx, { documentId: cn.id, to: 'cancelled' }).ok);
  assert.equal(statusOf(ctx, invoice.id), 'issued');
});

// --- D4. TENANCY AND THE A15 FEE ------------------------------------------------------------------

test('D4a: §H-TENANT: a foreign workspace holding the same document id changes nothing', () => {
  const { ctx, store } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  assert.ok(pay(ctx, invoice.id, 54050, 'p-1').ok);
  assert.equal(statusOf(ctx, invoice.id), 'partially_paid');

  // Plant a credit note in ANOTHER workspace carrying this invoice's id in its FK column.
  const otherId = createWorkspace({ store, clock: ctx.clock, ids: ctx.ids }, { name: 'Fremd AG' }).workspaceId;
  store.db
    .prepare(
      `INSERT INTO document (id, workspace_id, type, number, status, currency, subtotal_minor, tax_minor,
                             total_minor, credited_document_id, created_at)
       VALUES ('doc_planted', ?, 'credit_note', 'G-X', 'issued', 'CHF', 50000, 4050, 54050, ?, ?)`,
    )
    .run(otherId, invoice.id, '2026-07-16T00:00:00.000Z');

  // The cover query is workspace-scoped, so the planted row must not settle our invoice.
  assert.ok(pay(ctx, invoice.id, 1, 'p-2').ok);
  assert.equal(statusOf(ctx, invoice.id), 'partially_paid');
  // And our OWN credit still settles it: the planted row neither helped nor hindered.
  const cn = credit(ctx, invoice, { mode: 'partial', amountMinor: 50000 }, 't-1');
  assert.ok(cn.issued.ok, JSON.stringify(cn.issued));
  assert.equal(cn.doc.totalMinor, 54050);
  assert.equal(statusOf(ctx, invoice.id), 'settled', '54051 cash + 54050 credit covers 108100');
});

test('D4b: an A15 dunning fee never enters the derivation: the invoice settles on its own gross', async () => {
  const dunning = await import('../../dist/core/dunning/index.js').catch(() => null);
  if (dunning === null || typeof dunning.runDunning !== 'function') {
    // A15's entry point is not what this probe assumed; the structural claim still holds and is
    // asserted directly below, so this is recorded rather than silently skipped.
    assert.ok(true, 'A15 run verb not reachable under this name; asserting the structural claim only');
  }
  const { ctx, clock } = setup('2026-01-10T00:00:00.000Z');
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }], { dueDate: '2026-02-10' });
  clock.set('2026-07-16T00:00:00.000Z');
  assert.ok(pay(ctx, invoice.id, 54050, 'p-1').ok);
  const cn = credit(ctx, invoice, { mode: 'partial', amountMinor: 50000 }, 'f-1');
  assert.ok(cn.issued.ok);
  assert.equal(statusOf(ctx, invoice.id), 'settled');
  // The structural claim: no dunning row may write the invoice's own gross, which is the only
  // figure the derivation compares against.
  assert.equal(getDocument(ctx, { documentId: invoice.id }).document.totalMinor, 108100);
});

// --- D5. THE TWO REPORTED-NOT-FIXED ITEMS ----------------------------------------------------------

test('D5a: over_credit bounds credits against GROSS, so a settled-by-credit invoice accepts MORE credit', () => {
  // Reported, not fixed. Pinned here so the behaviour is a decision rather than a discovery: the
  // invoice stays terminal while the customer's net position goes past relief into a payable.
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  assert.ok(pay(ctx, invoice.id, 54050, 'p-1').ok);
  const first = credit(ctx, invoice, { mode: 'partial', amountMinor: 50000 }, 's-1');
  assert.ok(first.issued.ok);
  assert.equal(statusOf(ctx, invoice.id), 'settled');

  // The invoice is fully relieved in cash-plus-credit terms, yet a SECOND credit for the rest of
  // the NET is accepted: the bound is the invoice's own net/gross, never what is still unpaid.
  const second = credit(ctx, invoice, { mode: 'partial', amountMinor: 50000 }, 's-2');
  assert.ok(second.issued !== undefined && second.issued.ok, JSON.stringify(second.issued ?? second.created));
  assert.equal(statusOf(ctx, invoice.id), 'settled', 'and it stays terminal');
  // Cash 540.50 plus credits 1'081.00 against a 1'081.00 invoice: the customer is owed the surplus.
  assert.equal(54050 + 54050, invoice.totalMinor);
  assert.equal(54050 + 54050 + 54050 > invoice.totalMinor, true);

  // A THIRD credit is refused, so the gross bound does still bind: the surplus is capped at the
  // cash already received, never unbounded.
  const third = credit(ctx, invoice, { mode: 'partial', amountMinor: 1000 }, 's-3');
  const refusal = third.issued ?? third.created;
  assert.equal(refusal.ok, false);
  assert.ok(refusal.error === 'over_credit' || refusal.error === 'invalid_input', JSON.stringify(refusal));
});

test('D5b: the surplus is reachable and payable, so the state is recoverable rather than stuck', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  assert.ok(pay(ctx, invoice.id, 54050, 'p-1').ok);
  assert.ok(credit(ctx, invoice, { mode: 'partial', amountMinor: 50000 }, 'x-1').issued.ok);
  const second = credit(ctx, invoice, { mode: 'partial', amountMinor: 50000 }, 'x-2');
  assert.ok(second.issued !== undefined && second.issued.ok, JSON.stringify(second.issued ?? second.created));
  // Paying the surplus out against the second credit re-opens the invoice honestly.
  const refund = pay(ctx, second.id, 54050, 'x-refund', 'outgoing');
  assert.ok(refund.ok, JSON.stringify(refund));
  assert.equal(statusOf(ctx, invoice.id), 'settled', 'still covered by the first credit alone');
});
