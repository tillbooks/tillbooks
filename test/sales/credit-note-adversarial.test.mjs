/**
 * A13 CRITIC probes, round 1 (non-author critic, 2026-07-30), ADOPTED VERBATIM as the D74 rebuild's
 * acceptance suite (docs/specs/specs/A13-credit-notes.md, the rebuild header).
 *
 * Every test attacks a claim from the LEDGER and from the RETURN, never from a fixture. The
 * defect-pinning probes were flipped to the FIXED behaviour during the old branch's remediation and
 * are carried in that polarity (each says so inline); the rebuild passes all of them unmodified.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { seedTaxCodes, configureVat } from '../../dist/core/vat/index.js';
import { computeVatReturn, markVatPeriodFiled } from '../../dist/core/vat/abrechnung.js';
import {
  createDocument,
  issueInvoice,
  createCreditNote,
  issueCreditNote,
  transitionDocument,
  getDocument,
} from '../../dist/core/sales/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { listOpenItems, customerBalance } from '../../dist/core/debtors/index.js';
import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';

/** A clock the test can move, which is what every filed-period attack needs. */
function movableClock(start) {
  let at = start;
  return { now: () => at, set: (v) => { at = v; } };
}

function setup(start = '2026-07-16T00:00:00.000Z', overrides = {}) {
  const clock = movableClock(start);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Nomadik GmbH' }).workspaceId;
  // The REAL A03 period port, so a `vat_filed` hard lock actually reaches postEntry. The shipped
  // suite injects a stub instead, which is why it never exercised a real filing.
  const ctx = makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    ...ledgerPorts({ store, workspaceId, ids }),
    ...overrides,
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

function netCredit(ctx, number) {
  return ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.credit_minor - l.debit_minor), 0) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(ctx.workspaceId, number).net;
}

function baseBalance(ctx, number) {
  return ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(ctx.workspaceId, number).net;
}

function lineCount(ctx) {
  return ctx.store.db.prepare('SELECT COUNT(*) AS n FROM journal_line').get().n;
}

function issuedInvoice(ctx, lines, currency = 'CHF', extra = {}) {
  const doc = createDocument(ctx, { type: 'invoice', contactId: 'ct_1', currency, lines, ...extra });
  assert.ok(doc.ok, JSON.stringify(doc));
  const issued = issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: `inv-${doc.document.id}` });
  assert.ok(issued.ok, JSON.stringify(issued));
  return getDocument(ctx, { documentId: doc.document.id }).document;
}

/** The line for one Ziffer in a computed return, or undefined. */
function ziffer(ret, code) {
  return (ret.lines ?? []).find((b) => b.code === code);
}

// --- P1. THE FILED FIGURE ------------------------------------------------------------------------

test('P1a: a credit against a FILED quarter posts into the CURRENT quarter and leaves the filed figure untouched', () => {
  const { ctx, clock } = setup('2026-04-15T00:00:00.000Z');
  const invoice = issuedInvoice(ctx, [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  assert.equal(invoice.issueDate, '2026-04-15');

  const q2Before = computeVatReturn(ctx, { periodStart: '2026-04-01', periodEnd: '2026-06-30' });
  assert.ok(q2Before.ok, JSON.stringify(q2Before));
  assert.equal(ziffer(q2Before, '303').taxMinor, 8100);

  // File Q2. A03 hard-locks 2026-04/05/06 with reason vat_filed.
  const filed = markVatPeriodFiled(ctx, { period: '2026-Q2', idempotencyKey: 'file-q2' });
  assert.ok(filed.ok, JSON.stringify(filed));

  // Now credit it, from Q3.
  clock.set('2026-07-16T00:00:00.000Z');
  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'f-1' });
  assert.ok(cn.ok, JSON.stringify(cn));
  const issued = issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'f-1-issue' });
  assert.ok(issued.ok, JSON.stringify(issued));

  const entryDate = ctx.store.db
    .prepare('SELECT date FROM journal_entry WHERE id = ?')
    .get(getDocument(ctx, { documentId: cn.document.id }).document.postedEntryId).date;
  assert.equal(entryDate, '2026-07-16');

  // The filed quarter is bit-for-bit what was filed.
  const q2After = computeVatReturn(ctx, { periodStart: '2026-04-01', periodEnd: '2026-06-30' });
  assert.deepEqual(q2After.lines, q2Before.lines);
  assert.equal(q2After.payableMinor, q2Before.payableMinor);
  assert.equal(q2After.totalTaxDueMinor, 8100);

  // The current quarter carries the correction, negative, on the CURRENT Ziffer 303 (2026 supply).
  const q3 = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.ok(q3.ok, JSON.stringify(q3));
  const b303 = ziffer(q3, '303');
  assert.ok(b303, JSON.stringify(q3.lines));
  assert.equal(b303.baseMinor, -100000);
  assert.equal(b303.taxMinor, -8100);
  assert.equal(q3.totalTaxDueMinor, -8100);
  assert.equal(q3.creditMinor, 8100, 'the correction is a CREDIT on Ziffer 510');
  assert.equal(q3.reconciled, true, JSON.stringify(q3));
});

test('P1b: a credit CREATED before the filing and issued after still cannot reach the filed period', () => {
  const { ctx, clock } = setup('2026-04-15T00:00:00.000Z');
  const invoice = issuedInvoice(ctx, [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  // Draft made INSIDE the period that is about to be filed.
  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'pre-1' });
  assert.ok(cn.ok);
  assert.ok(markVatPeriodFiled(ctx, { period: '2026-Q2', idempotencyKey: 'file-q2' }).ok);

  clock.set('2026-07-20T00:00:00.000Z');
  assert.ok(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'pre-1-issue' }).ok);
  const e = ctx.store.db
    .prepare('SELECT date FROM journal_entry WHERE id = ?')
    .get(getDocument(ctx, { documentId: cn.document.id }).document.postedEntryId);
  assert.equal(e.date, '2026-07-20');
});

test('P1c: issuing while the CURRENT month is itself vat_filed-locked refuses, and consumes no number', () => {
  const { ctx, clock } = setup('2026-04-15T00:00:00.000Z');
  const invoice = issuedInvoice(ctx, [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  clock.set('2026-07-20T00:00:00.000Z');
  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'lk-1' });
  assert.ok(cn.ok);
  // Somebody files Q3 early (or the credit is attempted after the quarter was filed).
  assert.ok(markVatPeriodFiled(ctx, { period: '2026-Q3', idempotencyKey: 'file-q3' }).ok);

  const before = lineCount(ctx);
  const refused = issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'lk-1-issue' });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.error, 'period_locked');
  assert.equal(lineCount(ctx), before);
  const draft = getDocument(ctx, { documentId: cn.document.id }).document;
  assert.equal(draft.status, 'draft');
  assert.equal(draft.number, null);
});

// --- P2. RATE ERAS UNDER COMPOSITION --------------------------------------------------------------

test('P2a: a 7.7%-era supply credited in 2026 reverses at 7.7% on the LEGACY Ziffer 302, in the current return', () => {
  const { ctx } = setup('2026-07-16T00:00:00.000Z');
  const invoice = issuedInvoice(ctx, [
    { description: 'Altleistung 2023', unitPriceMinor: 100000, taxCode: 'UST81', supplyDate: '2023-11-01' },
  ]);
  // The invoice itself already prices at 7.7% and lands on 302 inside the 2026 return.
  assert.equal(invoice.taxMinor, 7700);
  const before = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(ziffer(before, '302').taxMinor, 7700);
  assert.equal(ziffer(before, '303'), undefined);

  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'era-1' });
  assert.ok(cn.ok);
  assert.ok(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'era-1-issue' }).ok);

  const after = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(ziffer(after, '302').taxMinor, 0);
  assert.equal(ziffer(after, '302').baseMinor, 0);
  assert.equal(ziffer(after, '303'), undefined, 'the correction must NOT leak onto the current-rate Ziffer');
  assert.equal(after.reconciled, true, JSON.stringify(after));
  assert.equal(netCredit(ctx, '2200'), 0);
});

test('P2b: a MIXED-era invoice partially credited line by line keeps each Ziffer on its own era', () => {
  const { ctx } = setup('2026-07-16T00:00:00.000Z');
  const invoice = issuedInvoice(ctx, [
    { description: 'Alt 2023', unitPriceMinor: 100000, taxCode: 'UST81', supplyDate: '2023-11-01' },
    { description: 'Neu 2026', unitPriceMinor: 200000, taxCode: 'UST81', supplyDate: '2026-06-01' },
  ]);
  assert.equal(invoice.taxMinor, 7700 + 16200);

  // Credit ONLY the legacy line.
  const cn = createCreditNote(ctx, {
    fromInvoiceId: invoice.id,
    mode: 'partial',
    lines: [{ position: 1 }],
    idempotencyKey: 'mix-1',
  });
  assert.ok(cn.ok, JSON.stringify(cn));
  assert.ok(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'mix-1-issue' }).ok);

  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(ziffer(ret, '302').taxMinor, 0, 'the legacy Ziffer nets to zero');
  assert.equal(ziffer(ret, '303').taxMinor, 16200, 'the current Ziffer is untouched');
  assert.equal(ret.reconciled, true, JSON.stringify(ret));
});

test('P2c: crediting a 7.7% invoice by APPORTIONED AMOUNT keeps the era (the amountMinor branch pins supply dates too)', () => {
  const { ctx } = setup('2026-07-16T00:00:00.000Z');
  const invoice = issuedInvoice(ctx, [
    { description: 'Alt 2023', unitPriceMinor: 100000, taxCode: 'UST81', supplyDate: '2023-11-01' },
  ]);
  const cn = createCreditNote(ctx, {
    fromInvoiceId: invoice.id,
    mode: 'partial',
    amountMinor: 50000,
    idempotencyKey: 'era-amt',
  });
  assert.ok(cn.ok);
  const rows = ctx.store.db
    .prepare('SELECT supply_date FROM document_line WHERE document_id = ?')
    .all(cn.document.id);
  assert.deepEqual(rows.map((r) => r.supply_date), ['2023-11-01']);
  assert.ok(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'era-amt-issue' }).ok);
  const after = getDocument(ctx, { documentId: cn.document.id }).document;
  assert.equal(after.taxMinor, 3850); // 7.7% of 500.00, NOT 8.1%
});

// --- P3. OVER-CREDIT UNDER COMPOSITION ------------------------------------------------------------

test('P3a: crediting an invoice unit by unit closes it in full: the exhausting credit books the residual VAT (D67, FIXED)', () => {
  // POLARITY FLIPPED at remediation: this test used to pin the measured DEFECT (the third unit
  // refused `over_credit` and CHF 0.07 stranded on a fully returned sale). D67: the credit that
  // exhausts the invoice's remaining net derives its VAT as the invoice's total VAT minus prior
  // credits' VAT, so the pair always closes; the accepted cost is that the last credit's VAT (0.00)
  // differs by a Rappen from what its own line computes (0.01).
  const { ctx } = setup();
  // 3 units at 0.07: line net 0.21, VAT 8.1% = 0.017 -> 0.02, gross 0.23.
  const invoice = issuedInvoice(ctx, [
    { description: 'Kleinteil', quantityMilli: 3000, unitPriceMinor: 7, taxCode: 'UST81' },
  ]);
  assert.equal(invoice.subtotalMinor, 21);
  assert.equal(invoice.taxMinor, 2);
  assert.equal(invoice.totalMinor, 23);

  const creditOne = (n) => {
    const cn = createCreditNote(ctx, {
      fromInvoiceId: invoice.id,
      mode: 'partial',
      lines: [{ position: 1, quantityMilli: 1000 }],
      idempotencyKey: `r-${n}`,
    });
    assert.ok(cn.ok, JSON.stringify(cn));
    const issued = issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: `r-${n}-issue` });
    return { issued, id: cn.document.id };
  };
  assert.ok(creditOne(1).issued.ok);
  assert.ok(creditOne(2).issued.ok);
  const third = creditOne(3);
  assert.ok(third.issued.ok, JSON.stringify(third.issued));

  // The exhausting credit booked the residual: net 0.07, VAT 0.00, gross 0.07.
  const thirdDoc = getDocument(ctx, { documentId: third.id }).document;
  assert.equal(thirdDoc.subtotalMinor, 7);
  assert.equal(thirdDoc.taxMinor, 0);
  assert.equal(thirdDoc.totalMinor, 7);

  // And the pair closes to zero on every money-bearing account, from the ledger.
  assert.equal(baseBalance(ctx, '1100'), 0);
  assert.equal(netCredit(ctx, '3200'), 0);
  assert.equal(netCredit(ctx, '2200'), 0);
  // Across the three credits the VAT sums to exactly the invoice's: 0.01 + 0.01 + 0.00 = 0.02.
  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.ok(ret.ok, JSON.stringify(ret));
  assert.equal(ziffer(ret, '303').taxMinor, 0);
  assert.equal(ziffer(ret, '303').baseMinor, 0);
  assert.equal(ret.reconciled, true, JSON.stringify(ret));
});

test('P3b: a CANCELLED credit note stops consuming creditable amount, and the ledger agrees', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const first = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'cc-1' });
  assert.ok(issueCreditNote(ctx, { creditNoteId: first.document.id, idempotencyKey: 'cc-1-issue' }).ok);
  assert.equal(baseBalance(ctx, '1100'), 0);

  // A second full credit is refused while the first stands.
  const blocked = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'cc-2' });
  assert.ok(blocked.ok);
  const refused = issueCreditNote(ctx, { creditNoteId: blocked.document.id, idempotencyKey: 'cc-2-issue' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'over_credit');

  // Cancel the first: its entry is reversed, 1100 carries the invoice again, and the SAME draft now issues.
  assert.ok(transitionDocument(ctx, { documentId: first.document.id, to: 'cancelled' }).ok);
  assert.equal(baseBalance(ctx, '1100'), invoice.totalMinor);
  const now = issueCreditNote(ctx, { creditNoteId: blocked.document.id, idempotencyKey: 'cc-2-issue-b' });
  assert.ok(now.ok, JSON.stringify(now));
  assert.equal(baseBalance(ctx, '1100'), 0);
  assert.equal(netCredit(ctx, '3200'), 0);
  assert.equal(netCredit(ctx, '2200'), 0);
});

test('P3c: an invoice an ISSUED credit note relieved refuses cancellation, and nothing moves (F1, FIXED)', () => {
  // POLARITY FLIPPED at remediation: this test used to pin the measured DEFECT (the four calls that
  // reversed one sale twice and filed a CHF -81.00 VAT refund with `reconciled: true`). The fix
  // guards the transition edge: `has_credit_notes` names the credit notes, no row moves, and the
  // correct order (cancel the credit note FIRST, then the invoice) still works and nets to zero.
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'ic-1' });
  assert.ok(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'ic-1-issue' }).ok);
  assert.equal(baseBalance(ctx, '1100'), 0);
  const cnNumber = getDocument(ctx, { documentId: cn.document.id }).document.number;

  const linesBefore = lineCount(ctx);
  const refused = transitionDocument(ctx, { documentId: invoice.id, to: 'cancelled' });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.error, 'has_credit_notes');
  assert.deepEqual(refused.creditNotes, [{ id: cn.document.id, number: cnNumber }]);

  // Nothing moved: no Storno posted, the invoice still stands, the pair still nets to zero.
  assert.equal(lineCount(ctx), linesBefore);
  assert.equal(getDocument(ctx, { documentId: invoice.id }).document.status, 'issued');
  assert.equal(baseBalance(ctx, '1100'), 0);
  assert.equal(netCredit(ctx, '3200'), 0);
  assert.equal(netCredit(ctx, '2200'), 0);
  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.ok(ret.ok, JSON.stringify(ret));
  assert.equal(ziffer(ret, '303').taxMinor, 0);
  assert.equal(ret.totalTaxDueMinor, 0);

  // The refusal is not memoised and the ORDER the message names still works: cancel the credit
  // note first (its own entry reverses, the invoice re-opens), then the invoice cancels cleanly.
  assert.ok(transitionDocument(ctx, { documentId: cn.document.id, to: 'cancelled' }).ok);
  assert.equal(baseBalance(ctx, '1100'), invoice.totalMinor);
  const cancelled = transitionDocument(ctx, { documentId: invoice.id, to: 'cancelled' });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(baseBalance(ctx, '1100'), 0);
  assert.equal(netCredit(ctx, '3200'), 0);
  assert.equal(netCredit(ctx, '2200'), 0);
  const after = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(after.totalTaxDueMinor, 0);
});

test('P3e: for contrast, cancelling a PARTIALLY PAID invoice breaks the A16 reconciliation loudly', () => {
  // The pre-existing analogue of P3c. It mattered because A16 CATCHES this one (`reconciled:
  // false`) while the credit-note twin explained its wrong balance away, which is why the twin is
  // now guarded at the transition (F1) instead of left to the reconciliation.
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const bank = ctx.store.db
    .prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1020'")
    .get(ctx.workspaceId).id;
  assert.ok(
    recordPayment(ctx, {
      intent: PAYMENT_INTENTS.record, direction: 'incoming', date: '2026-07-16',
      amountMinor: 50000, currency: 'CHF', bankAccountId: bank, counterpartyId: 'ct_1',
      allocations: [{ documentId: invoice.id, amountMinor: 50000 }], idempotencyKey: 'pp-1',
    }).ok,
  );
  assert.ok(transitionDocument(ctx, { documentId: invoice.id, to: 'cancelled' }).ok);
  const list = listOpenItems(ctx, {});
  assert.equal(list.reconciled, false, 'A16 flags this one; the credit-note twin is guarded at the edge instead');
});

test('P3d: kind guards: a credit note, a quote and an unknown id are all refused as sources', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'kg-1' });
  assert.ok(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'kg-1-issue' }).ok);

  const onCredit = createCreditNote(ctx, { fromInvoiceId: cn.document.id, idempotencyKey: 'kg-2' });
  assert.equal(onCredit.ok, false);
  assert.equal(onCredit.error, 'invoice_not_creditable');
  assert.equal(onCredit.reason, 'not_an_invoice');

  const quote = createDocument(ctx, {
    type: 'quote',
    contactId: 'ct_1',
    lines: [{ description: 'q', unitPriceMinor: 1000, taxCode: 'UST81' }],
  });
  assert.ok(quote.ok);
  assert.ok(transitionDocument(ctx, { documentId: quote.document.id, to: 'issued' }).ok);
  const onQuote = createCreditNote(ctx, { fromInvoiceId: quote.document.id, idempotencyKey: 'kg-3' });
  assert.equal(onQuote.ok, false);
  assert.equal(onQuote.error, 'invoice_not_creditable');

  const ghost = createCreditNote(ctx, { fromInvoiceId: 'doc_nope', idempotencyKey: 'kg-4' });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.error, 'not_found');
});

// --- P4. FX ---------------------------------------------------------------------------------------

test('P4a: many partial EUR credits sum, in BASE, to exactly the invoice, at the ORIGINAL rate', () => {
  const { ctx } = setup();
  assert.ok(
    recordExchangeRate(ctx, {
      baseCurrency: 'EUR', rate: '0.9200', asOf: '2026-07-15', source: 'manual',
      method: 'daily', provenance: 'T', idempotencyKey: 'fx1',
    }).ok,
  );
  const invoice = issuedInvoice(
    ctx,
    [{ description: 'Stunden', quantityMilli: 3000, unitPriceMinor: 3333, taxCode: 'UST81' }],
    'EUR',
  );
  const invoiceBase = baseBalance(ctx, '1100');
  assert.ok(invoiceBase > 0);

  // The store moves after the invoice posted.
  assert.ok(
    recordExchangeRate(ctx, {
      baseCurrency: 'EUR', rate: '0.9400', asOf: '2026-07-16', source: 'manual',
      method: 'daily', provenance: 'T', idempotencyKey: 'fx2',
    }).ok,
  );

  for (const n of [1, 2, 3]) {
    const cn = createCreditNote(ctx, {
      fromInvoiceId: invoice.id, mode: 'partial',
      lines: [{ position: 1, quantityMilli: 1000 }], idempotencyKey: `fxp-${n}`,
    });
    assert.ok(cn.ok, JSON.stringify(cn));
    const r = issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: `fxp-${n}-issue` });
    assert.ok(r.ok, JSON.stringify(r));
    const rates = ctx.store.db
      .prepare('SELECT DISTINCT fx_rate FROM journal_line WHERE entry_id = ?')
      .all(getDocument(ctx, { documentId: cn.document.id }).document.postedEntryId);
    assert.deepEqual(rates.map((x) => x.fx_rate), ['0.92'], 'the ORIGINAL rate, never today\'s');
  }
  // TRANSACTION currency is Rappen-exact: EUR 1100, 2200 and 3200 all net to zero.
  const txn1100 = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE a.workspace_id = ? AND a.number = '1100'`,
    )
    .get(ctx.workspaceId).net;
  assert.equal(txn1100, 0);
  assert.equal(netCredit(ctx, '2200'), 0);
  assert.equal(netCredit(ctx, '3200'), 0);

  // POLARITY FLIPPED at remediation (F2, FIXED): each partial now states a proportional slice of
  // the invoice's BOOKED base per account (the A16 baseShare rule), so the three partials sum, in
  // base currency, to exactly the invoice's single once-rounded conversion: 1100, 2200 and 3200
  // all close to zero and no Rappen is stranded. (The measured defect was -1 / -1 / +2.)
  assert.equal(baseBalance(ctx, '1100'), 0);
  assert.equal(baseBalance(ctx, '2200'), 0);
  assert.equal(baseBalance(ctx, '3200'), 0);

  // And the RETURN no longer argues with itself: Ziffer 303 nets to zero on BOTH signable figures.
  // (The measured defect declared base -0.02 with tax +0.01 against it, arithmetically impossible
  // at 8.1% and exactly the pathology abrechnung.ts's own docblock calls fatal.)
  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.ok(ret.ok, JSON.stringify(ret));
  const b303 = ziffer(ret, '303');
  assert.equal(b303.baseMinor, 0);
  assert.equal(b303.taxMinor, 0);
  assert.equal(ret.reconciled, true, JSON.stringify(ret));
});

// --- P5. THE A16 NETTING --------------------------------------------------------------------------

test('P5a: a payment arriving AFTER a partial credit does not double-count the credit', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const cn = createCreditNote(ctx, {
    fromInvoiceId: invoice.id, mode: 'partial', amountMinor: 40000, idempotencyKey: 'np-1',
  });
  assert.ok(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'np-1-issue' }).ok);
  const cnDoc = getDocument(ctx, { documentId: cn.document.id }).document;

  // The customer pays the NET of invoice minus credit.
  const due = invoice.totalMinor - cnDoc.totalMinor;
  const paid = recordPayment(ctx, {
    intent: PAYMENT_INTENTS.record,
    direction: 'incoming',
    date: '2026-07-16',
    amountMinor: due,
    currency: 'CHF',
    bankAccountId: ctx.store.db
      .prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1020'")
      .get(ctx.workspaceId).id,
    counterpartyId: 'ct_1',
    allocations: [{ documentId: invoice.id, amountMinor: due }],
    idempotencyKey: 'pay-1',
  });
  assert.ok(paid.ok, JSON.stringify(paid));

  const list = listOpenItems(ctx, {});
  assert.ok(list.ok, JSON.stringify(list));
  assert.equal(list.reconciled, true, JSON.stringify(list));
  // No double count: the customer paid the net, so 1100 is flat and the OP-Liste nets to zero. The
  // invoice row still carries the credited gross as open and the credit row cancels it exactly.
  assert.equal(baseBalance(ctx, '1100'), 0);
  assert.equal(list.baseTotalOpenMinor, 0);
  const inv = list.items.find((i) => i.documentId === invoice.id);
  const crd = list.items.find((i) => i.documentId === cnDoc.id);
  assert.ok(inv && crd, JSON.stringify(list.items));
  assert.equal(inv.openMinor, cnDoc.totalMinor);
  assert.equal(crd.openMinor, -cnDoc.totalMinor);
  const bal = customerBalance(ctx, { customerId: 'ct_1' });
  assert.ok(bal.ok, JSON.stringify(bal));
  assert.equal(bal.baseTotalOpenMinor, 0);
});

test('P5b: the as-of read excludes a credit note issued after the cut-off (D64)', () => {
  const { ctx, clock } = setup('2026-05-10T00:00:00.000Z');
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  clock.set('2026-07-16T00:00:00.000Z');
  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'ao-1' });
  assert.ok(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'ao-1-issue' }).ok);

  const before = listOpenItems(ctx, { asOf: '2026-06-30' });
  assert.ok(before.ok, JSON.stringify(before));
  assert.equal(before.reconciled, true, JSON.stringify(before));
  assert.equal(before.baseTotalOpenMinor, invoice.totalMinor);
  assert.equal(before.items.filter((i) => i.documentId === cn.document.id).length, 0);

  const after = listOpenItems(ctx, { asOf: '2026-07-31' });
  assert.ok(after.ok);
  assert.equal(after.baseTotalOpenMinor, 0);
  assert.equal(after.reconciled, true, JSON.stringify(after));
});

test('P5c: an overdue invoice with a credit note reports its NET in its own bucket (D68, FIXED)', () => {
  // POLARITY FLIPPED at remediation: this test used to pin the measured GAP (the 90+ bucket carried
  // the invoice GROSS while the 90% credit sat in 0-30, overstating the overdue exposure A15 will
  // dun from). D68: the invoice's bucket carries its remaining open amount after linked credits,
  // and a linked credit stops appearing as its own bucket entry. The ROW model is unchanged: the
  // rows still show the un-netted claim and its offset, which document carries what.
  const { ctx, clock } = setup('2026-01-10T00:00:00.000Z');
  const invoice = issuedInvoice(
    ctx,
    [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }],
    'CHF',
    { dueDate: '2026-02-10' },
  );
  clock.set('2026-07-16T00:00:00.000Z');
  const cn = createCreditNote(ctx, {
    fromInvoiceId: invoice.id, mode: 'partial', amountMinor: 90000, idempotencyKey: 'ov-1',
  });
  assert.ok(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'ov-1-issue' }).ok);
  const cnDoc = getDocument(ctx, { documentId: cn.document.id }).document;

  const list = listOpenItems(ctx, {});
  const inv = list.items.find((i) => i.documentId === invoice.id);
  const crd = list.items.find((i) => i.documentId === cnDoc.id);
  assert.ok(inv && crd);
  // The rows are unchanged: the un-netted claim, its negative offset, and who is overdue.
  assert.equal(inv.openMinor, invoice.totalMinor);
  assert.equal(inv.overdue, true);
  assert.equal(crd.overdue, false);
  // The credit files into the bucket of the claim it offsets, so the per-bucket totals are NET.
  assert.equal(crd.bucket, '90+');
  assert.equal(list.baseBucketTotals['90+'], invoice.totalMinor - cnDoc.totalMinor);
  assert.equal(list.baseBucketTotals['0-30'], 0);
  assert.equal(list.reconciled, true, JSON.stringify(list));
});

test('P5d: §H-TENANT on the widened A16 query: a foreign workspace sees none of it', () => {
  const { ctx, store } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'tn-1' });
  assert.ok(issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'tn-1-issue' }).ok);

  const otherId = createWorkspace({ store, clock: ctx.clock, ids: ctx.ids }, { name: 'Fremd AG' }).workspaceId;
  const other = makeContext(store, { workspaceId: otherId, actor: 'u2', clock: ctx.clock, ids: ctx.ids });
  const list = listOpenItems(other, {});
  assert.ok(list.ok, JSON.stringify(list));
  assert.equal(list.items.length, 0);
  assert.equal(list.baseTotalOpenMinor, 0);
});

// --- P6. SALDO ------------------------------------------------------------------------------------

test('P6a: under Saldo the credit reduces the declared turnover and claims no input VAT', () => {
  const { ctx } = setup();
  const cfg = configureVat(ctx, {
    method: 'saldo',
    timing: 'soll',
    registered: true,
    saldoRates: [{ rateBp: 620, formLine: '322' }],
    idempotencyKey: 'saldo-cfg',
  });
  assert.ok(cfg.ok, JSON.stringify(cfg));

  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const before = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-12-31' });
  assert.ok(before.ok, JSON.stringify(before));

  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'sal-1' });
  assert.ok(cn.ok, JSON.stringify(cn));
  const issued = issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'sal-1-issue' });
  assert.ok(issued.ok, JSON.stringify(issued));

  const after = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-12-31' });
  assert.ok(after.ok, JSON.stringify(after));
  assert.equal(after.reconciled, null, 'saldo: the 2200 drift check is not applicable (Art. 37)');
  // Every declared figure nets to zero: the turnover base and the Saldo tax alike.
  for (const b of after.lines ?? []) {
    assert.equal(b.baseMinor, 0, `Ziffer ${b.code}: ${JSON.stringify(b)}`);
    assert.equal(b.taxMinor, 0, `Ziffer ${b.code}: ${JSON.stringify(b)}`);
  }
  assert.equal(after.payableMinor, 0, JSON.stringify(after));
  assert.equal(netCredit(ctx, '2200'), 0);
  assert.equal(netCredit(ctx, '3200'), 0);
  assert.equal(baseBalance(ctx, '1100'), 0);
  // And nothing was booked to Vorsteuer, which Art. 37 forbids under Saldo.
  assert.equal(baseBalance(ctx, '1170'), 0);
});

// --- P7. NUMBERING AND IDEMPOTENCY ---------------------------------------------------------------

test('P7a: a refused issue consumes no number, and the NEXT successful issue takes the number that was free', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const first = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'nm-1' });
  assert.ok(issueCreditNote(ctx, { creditNoteId: first.document.id, idempotencyKey: 'nm-1-issue' }).ok);
  assert.equal(getDocument(ctx, { documentId: first.document.id }).document.number, 'G-2026-0001');

  // A refusal (over_credit) between two good issues.
  const doomed = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'nm-2' });
  const refused = issueCreditNote(ctx, { creditNoteId: doomed.document.id, idempotencyKey: 'nm-2-issue' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'over_credit');

  const invoice2 = issuedInvoice(ctx, [{ description: 'y', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const third = createCreditNote(ctx, { fromInvoiceId: invoice2.id, idempotencyKey: 'nm-3' });
  assert.ok(issueCreditNote(ctx, { creditNoteId: third.document.id, idempotencyKey: 'nm-3-issue' }).ok);
  assert.equal(
    getDocument(ctx, { documentId: third.document.id }).document.number,
    'G-2026-0002',
    'gap-free: the refusal must not have burned 0002',
  );
});

test('P7b: replaying the idempotency key of a REFUSED issue does not memoise the refusal', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const a = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'rp-a' });
  assert.ok(issueCreditNote(ctx, { creditNoteId: a.document.id, idempotencyKey: 'rp-issue-a' }).ok);
  const b = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'rp-b' });
  const refused = issueCreditNote(ctx, { creditNoteId: b.document.id, idempotencyKey: 'rp-issue-b' });
  assert.equal(refused.ok, false);
  // Free the amount, then retry with the SAME key: it must now succeed rather than replay the no.
  assert.ok(transitionDocument(ctx, { documentId: a.document.id, to: 'cancelled' }).ok);
  const retry = issueCreditNote(ctx, { creditNoteId: b.document.id, idempotencyKey: 'rp-issue-b' });
  assert.ok(retry.ok, JSON.stringify(retry));
});

test('P7c: a create refusal is not memoised against its key either', () => {
  const { ctx } = setup();
  const draft = createDocument(ctx, {
    type: 'invoice', contactId: 'ct_1',
    lines: [{ description: 'x', unitPriceMinor: 1000, taxCode: 'UST81' }],
  });
  const refused = createCreateAttempt(ctx, draft.document.id, 'cr-1');
  assert.equal(refused.ok, false);
  assert.ok(issueInvoice(ctx, { invoiceId: draft.document.id, idempotencyKey: 'inv-x' }).ok);
  const now = createCreateAttempt(ctx, draft.document.id, 'cr-1');
  assert.ok(now.ok, JSON.stringify(now));
});

function createCreateAttempt(ctx, invoiceId, key) {
  return createCreditNote(ctx, { fromInvoiceId: invoiceId, idempotencyKey: key });
}

// --- P8. THE METHOD BOUNDARY ---------------------------------------------------------------------

test('P8a: a workspace that switched Saldo -> effektiv credits an old supply under the OLD method', () => {
  const { ctx, clock } = setup('2026-11-20T00:00:00.000Z');
  assert.ok(
    configureVat(ctx, {
      method: 'saldo', timing: 'soll', registered: true,
      saldoRates: [{ rateBp: 620, formLine: '322' }], idempotencyKey: 'm-saldo',
    }).ok,
  );
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const invoiceMethodLines = ctx.store.db
    .prepare('SELECT tax_base_minor, tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ? AND tax_code IS NOT NULL')
    .all(invoice.postedEntryId);

  // The method changes at the start of the next Steuerperiode (Art. 37 Abs. 4).
  const changed = configureVat(ctx, {
    method: 'effektiv', timing: 'soll', registered: true,
    methodChange: { validFrom: '2027-01-01' }, idempotencyKey: 'm-eff',
  });
  assert.ok(changed.ok, JSON.stringify(changed));

  clock.set('2027-02-10T00:00:00.000Z');
  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'mb-1' });
  assert.ok(cn.ok, JSON.stringify(cn));
  const issued = issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'mb-1-issue' });
  assert.ok(issued.ok, JSON.stringify(issued));

  // The credit priced under the method that governed the SUPPLY, because the supply date is pinned.
  const cnDoc = getDocument(ctx, { documentId: cn.document.id }).document;
  const cnLines = ctx.store.db
    .prepare('SELECT tax_base_minor, tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ? AND tax_code IS NOT NULL')
    .all(cnDoc.postedEntryId);
  assert.equal(cnLines.length, invoiceMethodLines.length);
  assert.equal(cnLines[0].tax_base_minor, -invoiceMethodLines[0].tax_base_minor);
  assert.equal(cnLines[0].tax_amount_minor, -invoiceMethodLines[0].tax_amount_minor);
  // The invoice's own line carries no supply date (a same-day booking: the entry date governs); the
  // credit pins it EXPLICITLY to the invoice's issue date, which is what makes the two price alike
  // even though they post in different method eras.
  assert.equal(invoiceMethodLines[0].supply_date, null);
  assert.equal(cnLines[0].supply_date, invoice.issueDate);
  assert.equal(netCredit(ctx, '2200'), 0);
  assert.equal(baseBalance(ctx, '1100'), 0);
});
