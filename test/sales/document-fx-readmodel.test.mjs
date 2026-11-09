/**
 * A10/A11 §H-FX: the document read model reports what the BOOKS hold, in the currency they hold it.
 *
 * `buildInvoicePosting` composed an FX summary at issue and documented it as "said out loud to the
 * caller". It was never said to anyone: A10's `transitionDocument` read `postedEntryId` off the
 * delegate's result and returned a fresh `documentView`, so the summary died on that line. The
 * transaction currency was on the read model; the francs the ledger actually posted were not,
 * reachable only through `get_entry`.
 *
 * The figures are DERIVED at read time from the posted entry's own rows, never persisted beside
 * them. That is the whole point, and it is what these tests hold up: a stored copy of a converted
 * total is a second source of truth that can disagree with the ledger, and a read model that
 * disagrees with the ledger is worse than one that stays silent. Deriving makes the disagreement
 * unrepresentable rather than merely unlikely.
 *
 * So the assertions below never compare the read model against a literal or against the return
 * value of the call that produced it. Every one of them reads the journal rows back out of SQLite
 * and demands the read model equal THOSE. A test that checked `totalBaseMinor === 101744` would
 * pass just as green against a persisted copy that had since drifted.
 *
 * The fields are present only when the document states a conversion basis, which is A02's
 * `statesConversionBasis` and not a second copy of it. The governing assertion is therefore a
 * biconditional, held in every arm: **the read model states a basis if and only if the ledger
 * stamped one.** That is the property. Asserting "fxRate === '0.9412'" on the EUR arm alone would
 * be describing the fix; the biconditional also fails an implementation that reports a basis on
 * every franc invoice, or that goes quiet on a pegged foreign one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { createDocument, issueInvoice } from '../../dist/core/sales/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { getAction } from '../../dist/api/registry.js';

const AT = '2026-07-16T00:00:00.000Z';

function setup({ at = AT } = {}) {
  const clock = fixedClock(at);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?")
    .run(workspaceId);
  setCreditorProfile(ctx, {
    creditorName: 'Nomadik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'billing@muster.example', 'CHF', 30, ?)`,
    )
    .run(workspaceId, at);
  return { ctx, store, workspaceId };
}

function recordRate(ctx, { currency = 'EUR', asOf, rate }) {
  const res = recordExchangeRate(ctx, {
    baseCurrency: currency,
    rate,
    asOf,
    source: 'manual',
    method: 'daily',
    provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
    idempotencyKey: `fx-${currency}-${asOf}-${rate}`,
  });
  assert.ok(res.ok, JSON.stringify(res));
}

function makeInvoice(ctx, { currency, unitPriceMinor = 100000, taxCode = 'UST81' }) {
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency,
    lines: [{ description: 'Beratung', unitPriceMinor, taxCode }],
  });
  assert.ok(doc.ok, JSON.stringify(doc));
  return doc.document.id;
}

const readDoc = (ctx, workspaceId, documentId) => {
  const res = getAction('get_document').run(ctx, { workspaceId, documentId });
  assert.ok(res.ok, JSON.stringify(res));
  return res.document;
};

/**
 * Does the READ MODEL state a conversion basis? The mirror of `statesConversionBasis`, asked of the
 * thing under test rather than of the rule, so the two can be compared instead of assumed equal.
 */
const readModelStatesBasis = (doc) => doc.fxRate !== undefined && doc.fxRate !== null;

/** What the LEDGER holds for this entry, straight out of SQLite. The only authority in this file. */
function ledgerFigures(store, entryId) {
  const rows = store.db
    .prepare('SELECT debit_minor, credit_minor, base_debit_minor, fx_rate, currency FROM journal_line WHERE entry_id = ? ORDER BY rowid')
    .all(entryId);
  assert.ok(rows.length >= 3, 'a VAT-bearing invoice posts at least three rows');
  const rates = [...new Set(rows.map((r) => r.fx_rate))];
  assert.equal(rates.length, 1, 'every row of one entry converts on one basis');
  return {
    baseDebitTotal: rows.reduce((sum, r) => sum + r.base_debit_minor, 0),
    debitTotal: rows.reduce((sum, r) => sum + r.debit_minor, 0),
    rate: rates[0],
  };
}

test('an issued foreign-currency invoice reports the base total the LEDGER posted, and its rate', () => {
  const { ctx, store, workspaceId } = setup();
  recordRate(ctx, { asOf: '2026-07-15', rate: '0.9412' });
  const invoiceId = makeInvoice(ctx, { currency: 'EUR' });
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' }).ok);

  const doc = readDoc(ctx, workspaceId, invoiceId);
  const ledger = ledgerFigures(store, doc.postedEntryId);

  // The invariant: the read model's figures ARE the posted rows' figures. Not close to them, not
  // recomputable from them, equal to them.
  assert.equal(doc.totalBaseMinor, ledger.baseDebitTotal, 'the base total must equal the posted base debits');
  assert.equal(doc.fxRate, ledger.rate, 'the rate must be the rate stamped on the posted rows');
  assert.equal(doc.totalMinor, ledger.debitTotal, 'the transaction total must equal the posted debits');

  // A converted figure, not a copy of the transaction total under a different name. Without this a
  // fix that set totalBaseMinor = totalMinor would satisfy every assertion above for a CHF book.
  assert.notEqual(doc.totalBaseMinor, doc.totalMinor, 'EUR 1081.00 at 0.9412 is not CHF 1081.00');
  assert.equal(doc.baseCurrency, 'CHF', 'the base total is denominated, never a bare number');
  assert.equal(doc.currency, 'EUR');
  assert.equal(readModelStatesBasis(doc), ledger.rate !== null, 'the read model states a basis iff the ledger did');
});

test('the read model keeps the LEDGER rate after the rate store moves under it (no re-resolution)', () => {
  const { ctx, store, workspaceId } = setup();
  recordRate(ctx, { asOf: '2026-07-15', rate: '0.9412' });
  const invoiceId = makeInvoice(ctx, { currency: 'EUR' });
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' }).ok);

  const before = readDoc(ctx, workspaceId, invoiceId);
  const ledger = ledgerFigures(store, before.postedEntryId);

  // A rate recorded AFTER the invoice was issued, valid ON the invoice date, so it now wins any
  // resolution for that date. This is not exotic: it is what importing a BAZG feed does. An
  // implementation that re-resolved the rate at read time, or that recomputed the base total from
  // a freshly resolved rate, would now report a figure the books never posted.
  recordRate(ctx, { asOf: '2026-07-16', rate: '0.5000' });

  const after = readDoc(ctx, workspaceId, invoiceId);
  const ledgerAfter = ledgerFigures(store, after.postedEntryId);
  assert.equal(ledgerAfter.rate, ledger.rate, 'the posted rows are immutable: the ledger did not move');
  assert.equal(after.fxRate, ledgerAfter.rate, 'the read model followed the ledger, not the rate store');
  assert.equal(after.totalBaseMinor, ledgerAfter.baseDebitTotal, 'the base total followed the ledger too');
  assert.notEqual(after.fxRate, '0.5000', 'the newer rate must not reprice a posted invoice');
});

test('a base-currency invoice states NO basis, because the ledger converted nothing', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = makeInvoice(ctx, { currency: 'CHF' });
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' }).ok);

  const doc = readDoc(ctx, workspaceId, invoiceId);
  const ledger = ledgerFigures(store, doc.postedEntryId);

  // `statesConversionBasis` is the ONE predicate (src/core/ledger/postEntry.ts) and this read model
  // obeys it rather than carrying a second copy of the rule. A CHF posting in a CHF book converted
  // nothing, so the ledger stamps no rate and the read model states no basis.
  assert.equal(ledger.rate, null, 'the ledger stamped no rate on a base-currency posting');
  assert.equal(readModelStatesBasis(doc), false, 'the read model must not invent a basis the ledger declined to state');

  // Absent, not null-shaped. A franc invoice reporting `totalBaseMinor` equal to `totalMinor` and a
  // `baseCurrency` equal to its own currency is pure noise on every ordinary document, and it is the
  // same mistake as stamping a literal rate of 1 on every franc row: the arithmetic survives, the
  // disclosure stops meaning anything. The informative case is the foreign one, and only that one.
  assert.equal(doc.totalBaseMinor, undefined, 'a base-currency document reports no separate base total');
  assert.equal(doc.fxRate, undefined);
  assert.equal(doc.baseCurrency, undefined);
  // The figure is not lost, it is simply not restated: in a CHF book the transaction total already
  // IS what the books hold, and the ledger agrees.
  assert.equal(doc.totalMinor, ledger.baseDebitTotal, 'the transaction total already is the base total');
});

test('a foreign currency pegged at exactly 1 still reports its rate, because it converted', () => {
  const { ctx, store, workspaceId } = setup();
  // Parity is a rate, not the absence of one (§H-FX, docs/specs/03-fx-foundation.md section 13).
  recordRate(ctx, { currency: 'EUR', asOf: '2026-07-15', rate: '1' });
  const invoiceId = makeInvoice(ctx, { currency: 'EUR' });
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' }).ok);

  const doc = readDoc(ctx, workspaceId, invoiceId);
  const ledger = ledgerFigures(store, doc.postedEntryId);

  assert.equal(ledger.rate, '1', 'A02 stamps the basis even at parity');
  assert.equal(doc.fxRate, '1', 'a EUR row reading NULL is indistinguishable from a franc row');
  assert.equal(readModelStatesBasis(doc), ledger.rate !== null, 'parity is a basis, not the absence of one');
  assert.equal(doc.baseCurrency, 'CHF', 'the reader cannot tell a conversion happened from the numbers alone');
  // At parity the two totals coincide, which is exactly why the rate has to be stated separately:
  // the numbers alone cannot tell a reader that a conversion happened.
  assert.equal(doc.totalBaseMinor, ledger.baseDebitTotal);
  assert.equal(doc.totalBaseMinor, doc.totalMinor);
});

test('a DRAFT has no base total, because no rate has been stamped yet', () => {
  const { ctx, workspaceId } = setup();
  recordRate(ctx, { asOf: '2026-07-15', rate: '0.9412' });
  const invoiceId = makeInvoice(ctx, { currency: 'EUR' });

  const doc = readDoc(ctx, workspaceId, invoiceId);
  assert.equal(doc.postedEntryId, null, 'nothing is posted yet');
  // Reporting today's resolvable rate here would be the engine promising a price it has not fixed.
  // The rate a draft will post at is not decided until it issues.
  assert.equal(doc.totalBaseMinor, null, 'an unposted document has no base total to report');
  assert.equal(doc.fxRate, null, 'an unposted document has no stamped rate');
});

test('list_documents carries the same base figures as get_document (MCP-first, not GUI-only)', () => {
  const { ctx, store, workspaceId } = setup();
  recordRate(ctx, { asOf: '2026-07-15', rate: '0.9412' });
  const invoiceId = makeInvoice(ctx, { currency: 'EUR' });
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' }).ok);

  const listed = getAction('list_documents').run(ctx, { workspaceId, type: 'invoice' });
  assert.ok(listed.ok, JSON.stringify(listed));
  const row = listed.documents.find((d) => d.id === invoiceId);
  assert.notEqual(row, undefined, 'the invoice is in the list');

  const ledger = ledgerFigures(store, row.postedEntryId);
  // The Journal list renders a EUR total under a CHF label because `list_journal` sends no currency
  // context beside its number. The document list must not repeat that: whoever renders a total here
  // can name the currency it is in without a second call.
  assert.equal(row.totalBaseMinor, ledger.baseDebitTotal, 'the list reports the ledger base total');
  assert.equal(row.fxRate, ledger.rate, 'the list reports the ledger rate');
  assert.equal(row.baseCurrency, 'CHF');
  assert.deepEqual(
    { t: row.totalBaseMinor, r: row.fxRate, b: row.baseCurrency },
    { t: readDoc(ctx, workspaceId, invoiceId).totalBaseMinor, r: readDoc(ctx, workspaceId, invoiceId).fxRate, b: 'CHF' },
    'the list and the single read must not disagree about the same document',
  );
});
