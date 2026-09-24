/**
 * D78 (the A21 critic's O1): a fully-relieved invoice reaches the terminal `settled`.
 *
 * When payments PLUS issued credit notes cover an invoice exactly (the same netting A16's
 * `creditedOpenMinor` and A21's `principalMinor` derive), the invoice's status leaves
 * `partially_paid` for `settled`, so lists, dunning and matching stop treating it as active; and
 * it walks back out to `partially_paid` if a covering credit is cancelled while payments remain.
 * The ROW MODEL does not move: only the lifecycle column and its history trail do, and every
 * assertion here reads ROWS, never a verb's echo.
 *
 * The guarded edges around the new word are pinned too: a credit note ALONE never moves the
 * column (the A13 law), a terminal-by-credit invoice still refuses a further credit
 * (`over_credit`), A21 reads it as `already_paid`, the flip is idempotent on rows under a
 * replayed covering event, and §H-TENANT holds against a foreign covering credit.
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
import {
  recordPayment,
  previewPayment,
  reversePayment,
  buildQrrReference,
  PAYMENT_INTENTS,
} from '../../dist/core/payments/index.js';
// Deliberately NOT on the payments barrel: it is a status writer, and the P3 invariant pins the
// barrel to the verb surface. The engine reaches it the same way (document.ts imports the file).
import { refreshSettledByCredit } from '../../dist/core/payments/payment.js';
import { matchIncomingByQrr } from '../../dist/core/banking/index.js';
import { listOpenItems } from '../../dist/core/debtors/index.js';

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
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?")
    .run(workspaceId);
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', ?)`,
    )
    .run(workspaceId, start);
  return { ctx, store, workspaceId, clock };
}

const acc = (ctx, number) =>
  ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number).id;

/** The status ROW, not a view: the column this increment is allowed to move. */
const statusRow = (ctx, id) =>
  ctx.store.db
    .prepare('SELECT status FROM document WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id).status;

const historyTrail = (ctx, id) =>
  ctx.store.db
    .prepare(
      'SELECT to_status FROM document_status_history WHERE workspace_id = ? AND document_id = ? ORDER BY at, rowid',
    )
    .all(ctx.workspaceId, id)
    .map((r) => r.to_status);

function issuedInvoice(ctx, lines) {
  const doc = createDocument(ctx, { type: 'invoice', contactId: 'ct_1', currency: 'CHF', lines });
  assert.ok(doc.ok, JSON.stringify(doc));
  const issued = issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: `inv-${doc.document.id}` });
  assert.ok(issued.ok, JSON.stringify(issued));
  return getDocument(ctx, { documentId: doc.document.id }).document;
}

// Dated ON the clock's own day: A16's as-of read (asserted in S2) excludes later-dated payments.
function pay(ctx, invoiceId, amountMinor, key, date = '2026-07-16') {
  return recordPayment(ctx, {
    intent: PAYMENT_INTENTS.record, direction: 'incoming', date, amountMinor,
    currency: 'CHF', bankAccountId: acc(ctx, '1020'), counterpartyKind: 'customer',
    counterpartyId: 'ct_1', allocations: [{ documentId: invoiceId, amountMinor }],
    idempotencyKey: key,
  });
}

function issuedCredit(ctx, invoiceId, amountMinor, key) {
  const created = createCreditNote(ctx, {
    fromInvoiceId: invoiceId, mode: 'partial', amountMinor, idempotencyKey: key,
  });
  assert.ok(created.ok, JSON.stringify(created));
  const issued = issueCreditNote(ctx, { creditNoteId: created.document.id, idempotencyKey: `${key}-i` });
  return { issued, id: created.document.id };
}

// The one invoice shape every test below reuses: net 100000 at 8.1% -> gross 108100. A credit of
// net 40000 books gross 43240, so the payment that covers the rest exactly is 64860.
const LINE = [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }];

test('S1: full payment alone still settles, exactly as before', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, LINE);
  assert.ok(pay(ctx, invoice.id, 108100, 'p-full').ok);
  assert.equal(statusRow(ctx, invoice.id), 'settled');
});

test('S2: payment plus an issued credit covering EXACTLY is terminal, in the order payment-then-credit', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, LINE);
  assert.ok(pay(ctx, invoice.id, 64860, 'p-1').ok);
  assert.equal(statusRow(ctx, invoice.id), 'partially_paid');

  const cn = issuedCredit(ctx, invoice.id, 40000, 'cn-1');
  assert.ok(cn.issued.ok, JSON.stringify(cn.issued));
  assert.equal(statusRow(ctx, invoice.id), 'settled');
  // The trail records the walk: issued -> partially_paid -> settled, in the lifecycle column only.
  assert.deepEqual(historyTrail(ctx, invoice.id), ['draft', 'issued', 'partially_paid', 'settled']);

  // The open-items read agrees on WHY: the invoice row's open is exactly its credited offset.
  const items = listOpenItems(ctx, {});
  assert.ok(items.ok);
  const row = items.items.find((i) => i.documentId === invoice.id && i.direction === 'incoming');
  assert.equal(row.openMinor, 43240);
  assert.equal(row.creditedOpenMinor, 43240);
});

test('S3: the other order too: the credit first, then the payment that covers the remainder', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, LINE);
  assert.ok(issuedCredit(ctx, invoice.id, 40000, 'cn-2').issued.ok);
  // A credit ALONE never moves the lifecycle column (the A13 law).
  assert.equal(statusRow(ctx, invoice.id), 'issued');

  // The preview promises what the write will derive (D78 reaches the planner too).
  const preview = previewPayment(ctx, {
    direction: 'incoming', date: '2026-07-17', amountMinor: 64860, currency: 'CHF',
    bankAccountId: acc(ctx, '1020'), counterpartyKind: 'customer', counterpartyId: 'ct_1',
    allocations: [{ documentId: invoice.id, amountMinor: 64860 }],
  });
  assert.ok(preview.ok, JSON.stringify(preview));
  assert.equal(preview.rows[0].resultingStatus, 'settled');

  assert.ok(pay(ctx, invoice.id, 64860, 'p-2').ok);
  assert.equal(statusRow(ctx, invoice.id), 'settled');
});

test('S4: cancelling the covering credit re-opens the invoice to partially_paid', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, LINE);
  assert.ok(pay(ctx, invoice.id, 64860, 'p-3').ok);
  const cn = issuedCredit(ctx, invoice.id, 40000, 'cn-3');
  assert.ok(cn.issued.ok);
  assert.equal(statusRow(ctx, invoice.id), 'settled');

  const cancelled = transitionDocument(ctx, { documentId: cn.id, to: 'cancelled' });
  assert.ok(cancelled.ok, JSON.stringify(cancelled));
  assert.equal(statusRow(ctx, invoice.id), 'partially_paid');
  assert.deepEqual(historyTrail(ctx, invoice.id), ['draft', 'issued', 'partially_paid', 'settled', 'partially_paid']);

  // And unwinding the payment as well walks the column all the way home.
  const paymentId = ctx.store.db
    .prepare("SELECT id FROM payment WHERE workspace_id = ? AND status = 'posted'")
    .get(ctx.workspaceId, ).id;
  assert.ok(reversePayment(ctx, { paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'rev-1' }).ok);
  assert.equal(statusRow(ctx, invoice.id), 'issued');
});

test('S5: a partial credit only, payments outstanding, stays open: no terminal word early', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, LINE);
  assert.ok(pay(ctx, invoice.id, 10000, 'p-4').ok);
  assert.ok(issuedCredit(ctx, invoice.id, 40000, 'cn-4').issued.ok);
  // 10000 paid + 43240 credited < 108100: partially paid it stays.
  assert.equal(statusRow(ctx, invoice.id), 'partially_paid');
});

test('S6: an invoice terminal by credit still refuses a further credit (over_credit)', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, LINE);
  assert.ok(pay(ctx, invoice.id, 8100, 'p-5').ok);
  // The FULL credit exhausts the invoice's creditable gross while a payment is on it, so the
  // cover alone relieves everything still open: terminal.
  const created = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'cn-5' });
  assert.ok(created.ok);
  assert.ok(issueCreditNote(ctx, { creditNoteId: created.document.id, idempotencyKey: 'cn-5-i' }).ok);
  assert.equal(statusRow(ctx, invoice.id), 'settled');

  // A further credit finds nothing creditable: the amount arm refuses at create, the full arm at
  // issue with over_credit. Both existing guards, untouched by the new terminal word.
  const overAmount = createCreditNote(ctx, {
    fromInvoiceId: invoice.id, mode: 'partial', amountMinor: 1, idempotencyKey: 'cn-6',
  });
  assert.equal(overAmount.ok, false);
  assert.equal(overAmount.error, 'invalid_input');
  assert.equal(overAmount.remainingNetMinor, 0);

  const overFull = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'cn-7' });
  assert.ok(overFull.ok, JSON.stringify(overFull));
  const refused = issueCreditNote(ctx, { creditNoteId: overFull.document.id, idempotencyKey: 'cn-7-i' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'over_credit');
});

test('S7: A21 reads the terminal-by-credit invoice as already_paid', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, LINE);
  assert.ok(pay(ctx, invoice.id, 64860, 'p-6').ok);
  assert.ok(issuedCredit(ctx, invoice.id, 40000, 'cn-8').issued.ok);
  assert.equal(statusRow(ctx, invoice.id), 'settled');

  const match = matchIncomingByQrr(ctx, {
    reference: buildQrrReference(invoice.number),
    amountMinor: 43240,
  });
  assert.ok(match.ok, JSON.stringify(match));
  assert.equal(match.match.confidence, 'none');
  assert.equal(match.match.reason, 'already_paid');
  assert.equal(match.match.invoiceId, invoice.id);
});

test('S8: the covering event replayed on its key changes NO row: idempotent on rows', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, LINE);
  assert.ok(pay(ctx, invoice.id, 64860, 'p-7').ok);
  const created = createCreditNote(ctx, {
    fromInvoiceId: invoice.id, mode: 'partial', amountMinor: 40000, idempotencyKey: 'cn-9',
  });
  assert.ok(created.ok);
  assert.ok(issueCreditNote(ctx, { creditNoteId: created.document.id, idempotencyKey: 'cn-9-i' }).ok);
  assert.equal(statusRow(ctx, invoice.id), 'settled');

  const rowCounts = () => ({
    entries: ctx.store.db
      .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'credit_note'")
      .get(ctx.workspaceId).n,
    history: historyTrail(ctx, invoice.id),
    payments: ctx.store.db
      .prepare('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?')
      .get(ctx.workspaceId).n,
  });
  const before = rowCounts();
  assert.deepEqual(before.history, ['draft', 'issued', 'partially_paid', 'settled']);

  // Replay BOTH covering events on their original keys: the issue and the payment.
  assert.ok(issueCreditNote(ctx, { creditNoteId: created.document.id, idempotencyKey: 'cn-9-i' }).ok);
  assert.ok(pay(ctx, invoice.id, 64860, 'p-7').ok);
  assert.deepEqual(rowCounts(), before);
  assert.equal(statusRow(ctx, invoice.id), 'settled');
});

test('S9: §H-TENANT: a foreign workspace credit covering the same id moves nothing here', () => {
  const { ctx, store, clock, workspaceId } = setup();
  const invoice = issuedInvoice(ctx, LINE);
  assert.ok(pay(ctx, invoice.id, 64860, 'p-8').ok);
  assert.equal(statusRow(ctx, invoice.id), 'partially_paid');

  // A second tenant on the same database plants an issued credit note whose FK names OUR invoice
  // (the FK is on the id alone, so SQL admits the row). The cover derivation must never see it.
  const ws2 = createWorkspace({ store, clock, ids: ctx.ids }, { name: 'Fremde AG' }).workspaceId;
  store.db
    .prepare(
      `INSERT INTO document (id, workspace_id, type, status, currency, total_minor, subtotal_minor,
                             tax_minor, credited_document_id, created_at)
       VALUES ('doc_foreign_cn', ?, 'credit_note', 'issued', 'CHF', 43240, 40000, 3240, ?, ?)`,
    )
    .run(ws2, invoice.id, clock.now());

  refreshSettledByCredit(ctx, invoice.id);
  assert.equal(statusRow(ctx, invoice.id), 'partially_paid');

  // And the genuine local credit still settles it, foreign noise present.
  assert.ok(issuedCredit(ctx, invoice.id, 40000, 'cn-10').issued.ok);
  assert.equal(statusRow(ctx, invoice.id), 'settled');
  assert.equal(workspaceId === ws2, false);
});

test('S10: a refund payout against the covering credit re-opens the invoice at the allocation choke point', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, LINE);
  assert.ok(pay(ctx, invoice.id, 64860, 'p-9').ok);
  const cn = issuedCredit(ctx, invoice.id, 40000, 'cn-11');
  assert.ok(cn.issued.ok);
  assert.equal(statusRow(ctx, invoice.id), 'settled');

  // The relief is paid out in cash instead of offsetting the invoice: the credit's open offset
  // shrinks to zero, so what the customer still owes on the invoice is chaseable again.
  const refund = recordPayment(ctx, {
    intent: PAYMENT_INTENTS.record, direction: 'outgoing', date: '2026-07-18', amountMinor: 43240,
    currency: 'CHF', bankAccountId: acc(ctx, '1020'), counterpartyKind: 'customer',
    counterpartyId: 'ct_1', allocations: [{ documentId: cn.id, amountMinor: 43240 }],
    idempotencyKey: 'refund-1',
  });
  assert.ok(refund.ok, JSON.stringify(refund));
  assert.equal(statusRow(ctx, invoice.id), 'partially_paid');
});
