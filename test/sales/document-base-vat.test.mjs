/**
 * A11 §H-FX / A07: the VAT figure a SWISS RETURN is filed in, on the read model at last.
 *
 * A foreign-currency invoice carries two true VAT figures and the ledger has always held both:
 *
 *   transaction VAT   EUR 121.50   (`journal_line.credit_minor` on 2200, and the 3200 row's trace)
 *   base VAT          CHF 114.36   (`journal_line.base_credit_minor` on that same 2200 row)
 *
 * An MWST-Abrechnung is filed in francs (MWSTV Art. 45: the conversion happens at the moment the tax
 * claim arises, and the books hold the result). Until this change the franc figure reached no verb at
 * all. `get_document` / `list_documents` / `issue_invoice` grew `totalBaseMinor`, `fxRate` and
 * `baseCurrency`, and every one of those is about the TOTAL: none is about the tax. So a person
 * reading the Studio's per-document VAT panel before filing could see the EUR tax and the franc
 * total, and nowhere the franc tax.
 *
 * `baseTaxMinor` closes that. It is DERIVED at read time from the posted rows, never stored beside
 * them, for the reason the rest of the FX group is derived: a persisted copy of a converted figure is
 * a second source of truth that can disagree with the books, and a read model that disagrees with the
 * books is worse than one that stays silent.
 *
 * ## Why every assertion here reads SQLite
 *
 * None of these tests compares the read model against a literal or against the return value of the
 * call that produced it. Each one reads the posted `journal_line` rows back out of the database and
 * demands the read model equal THOSE. `assert.equal(doc.baseTaxMinor, 11436)` would pass just as
 * green against a persisted copy that had since drifted, or against a client-side multiplication.
 *
 * ## Why it can NEVER be `taxMinor * fxRate`, with a witness
 *
 * `applyFx` rounds ONCE PER SIDE, on the side TOTAL, and allocates the result back over the lines by
 * largest remainder (src/core/ledger/postEntry.ts). A per-figure product is therefore a second
 * opinion about the ledger's rounding, and it is not merely theoretically free to disagree: the last
 * test below posts a real two-rate EUR invoice on which it DOES disagree, by one Rappen, at the
 * document level. The books say CHF 19.91 of MWST; the multiplication says CHF 19.92.
 *
 * ## The three arms, and the fourth this field adds
 *
 * The FX group has three states, not two, and `baseTaxMinor` has to be honest in all of them:
 *   - base-currency posted:      the key does not exist (the ledger converted nothing to disclose)
 *   - foreign, not yet posted:   `baseCurrency` is a string, every figure is null (no rate stamped)
 *   - foreign, posted:           real figures, parity included
 * and one more that `totalBaseMinor` never had to face: a foreign invoice that POSTED but charged no
 * VAT at all (a pure export under MWSTG Art. 23) writes no 2200 row whatsoever. That is a franc VAT
 * of ZERO, and it must not be reported as null, because null on this field means "nothing posted".
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
import { statesConversionBasis, postEntry } from '../../dist/core/ledger/postEntry.js';
import { ROLE_ACCOUNT_NUMBER } from '../../dist/core/payments/accounts.js';

const AT = '2026-07-16T00:00:00.000Z';

/** The output-VAT account, from the single enumeration point, never a literal '2200' typed here. */
const OUTPUT_VAT = ROLE_ACCOUNT_NUMBER.outputVat;

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Nomadik GmbH' }).workspaceId;
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
    .run(workspaceId, AT);
  return { ctx, store, workspaceId };
}

function recordRate(ctx, { currency = 'EUR', asOf = '2026-07-15', rate }) {
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

function makeInvoice(ctx, { currency, lines }) {
  const doc = createDocument(ctx, { type: 'invoice', contactId: 'ct_1', currency, lines });
  assert.ok(doc.ok, JSON.stringify(doc));
  return doc.document.id;
}

const oneLine = (unitPriceMinor = 150000, taxCode = 'UST81') => [
  { description: 'Beratung', unitPriceMinor, taxCode },
];

const readDoc = (ctx, workspaceId, documentId) => {
  const res = getAction('get_document').run(ctx, { workspaceId, documentId });
  assert.ok(res.ok, JSON.stringify(res));
  return res.document;
};

/**
 * What the LEDGER holds for this entry, straight out of SQLite. The only authority in this file.
 *
 * `vatBase` sums the VAT account's base credits net of its base debits, so a mirrored or reversing
 * leg subtracts rather than inflating the figure by its own absolute value.
 */
function ledgerFigures(store, entryId) {
  const rows = store.db
    .prepare(
      `SELECT a.number AS account, jl.currency, jl.debit_minor, jl.credit_minor,
              jl.base_debit_minor, jl.base_credit_minor, jl.fx_rate
         FROM journal_line jl JOIN account a ON a.id = jl.account_id
        WHERE jl.entry_id = ? ORDER BY jl.rowid`,
    )
    .all(entryId);
  assert.ok(rows.length > 0, `no posted rows for ${entryId}`);
  const vatRows = rows.filter((r) => r.account === OUTPUT_VAT);
  const rates = [...new Set(rows.map((r) => r.fx_rate))];
  assert.equal(rates.length, 1, 'every row of one entry converts on one basis');
  return {
    rows,
    vatRows,
    rate: rates[0],
    currency: rows[0].currency,
    vatBase: vatRows.reduce((s, r) => s + r.base_credit_minor - r.base_debit_minor, 0),
    vatTransaction: vatRows.reduce((s, r) => s + r.credit_minor - r.debit_minor, 0),
    baseDebitTotal: rows.reduce((s, r) => s + r.base_debit_minor, 0),
  };
}

/** Half away from zero, the repo's P2 rounding, so the naive product is computed the repo's own way. */
const roundHalfAwayFromZero = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));

test('a posted EUR invoice reports the FRANC VAT the ledger holds, not the EUR one', () => {
  const { ctx, store, workspaceId } = setup();
  recordRate(ctx, { rate: '0.9412' });
  const invoiceId = makeInvoice(ctx, { currency: 'EUR', lines: oneLine() });
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' }).ok);

  const doc = readDoc(ctx, workspaceId, invoiceId);
  const ledger = ledgerFigures(store, doc.postedEntryId);

  // The invariant: the read model's figure IS the posted rows' figure. Not close to it, equal to it.
  assert.equal(doc.baseTaxMinor, ledger.vatBase, 'the base VAT must equal the posted base credit on 2200');
  // And the transaction figure still is what it always was, so the two travel together and a reader
  // can name the currency of each without a second call.
  assert.equal(doc.taxMinor, ledger.vatTransaction, 'the transaction VAT is the posted credit on 2200');

  // They are DIFFERENT numbers, which is the whole reason the field had to exist: one label served
  // both, and it was true in neither currency.
  assert.notEqual(doc.baseTaxMinor, doc.taxMinor, 'EUR 121.50 is not CHF 121.50');
  assert.equal(doc.baseCurrency, 'CHF', 'the franc figure is denominated, never a bare number');
  assert.equal(doc.currency, 'EUR');
});

test('the base VAT is a SHARE of the base total, so the franc legs reconcile to the franc receivable', () => {
  const { ctx, store, workspaceId } = setup();
  recordRate(ctx, { rate: '0.9412' });
  const invoiceId = makeInvoice(ctx, { currency: 'EUR', lines: oneLine() });
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' }).ok);

  const doc = readDoc(ctx, workspaceId, invoiceId);
  const ledger = ledgerFigures(store, doc.postedEntryId);

  // §H-LEDGER holds in the base currency by construction (`allocateBase` spreads one rounded side
  // total over the lines), so the revenue base plus the VAT base IS the receivable base. Asserting
  // it here means a `baseTaxMinor` that drifted out of the entry's own allocation cannot pass.
  const nonVatBaseCredits = ledger.rows
    .filter((r) => r.account !== OUTPUT_VAT)
    .reduce((s, r) => s + r.base_credit_minor, 0);
  assert.equal(nonVatBaseCredits + doc.baseTaxMinor, ledger.baseDebitTotal, 'the base legs sum to the base total');
  assert.equal(doc.totalBaseMinor, ledger.baseDebitTotal, 'and that total is the one already reported');
});

test('a base-currency invoice reports NO franc VAT field, because it converted nothing', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = makeInvoice(ctx, { currency: 'CHF', lines: oneLine() });
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' }).ok);

  const doc = readDoc(ctx, workspaceId, invoiceId);
  const ledger = ledgerFigures(store, doc.postedEntryId);

  // The predicate is A02's `statesConversionBasis`, imported rather than re-derived, and the
  // assertion is a BICONDITIONAL: the read model discloses a franc VAT if and only if the ledger
  // stamped a basis. "baseTaxMinor === undefined" alone would also pass an implementation that went
  // quiet on foreign documents too.
  assert.equal(ledger.rate, null, 'the ledger stamped no rate on a base-currency posting');
  assert.equal(
    doc.baseTaxMinor !== undefined,
    statesConversionBasis({ currency: doc.currency, baseCurrency: 'CHF' }),
    'the field appears iff the document states a conversion basis',
  );
  assert.equal(doc.baseTaxMinor, undefined, 'absent, not a null-shaped restatement of taxMinor');
  // The figure is not lost, it is simply not restated: in a CHF book the transaction VAT already IS
  // the franc VAT, and the ledger says so.
  assert.equal(doc.taxMinor, ledger.vatBase, 'the transaction VAT already is the base VAT');
});

test('a DRAFT foreign invoice reports a NULL franc VAT, because no rate has been stamped yet', () => {
  const { ctx, workspaceId } = setup();
  recordRate(ctx, { rate: '0.9412' });
  const invoiceId = makeInvoice(ctx, { currency: 'EUR', lines: oneLine() });

  const doc = readDoc(ctx, workspaceId, invoiceId);
  assert.equal(doc.postedEntryId, null, 'nothing is posted yet');
  // Reporting today's resolvable rate times today's tax would be the engine promising a franc figure
  // it has not fixed. A draft has no franc VAT even in principle.
  assert.equal(doc.baseTaxMinor, null, 'an unposted document has no franc VAT to report');
  assert.equal(doc.totalBaseMinor, null, 'and it never had a base total either');
  assert.equal(doc.baseCurrency, 'CHF', 'the LABEL is known from the start; only the figures are not');
});

test('a posted EUR invoice with NO VAT reports ZERO francs of VAT, which is not null', () => {
  const { ctx, store, workspaceId } = setup();
  recordRate(ctx, { rate: '0.9412' });
  // A pure export (MWSTG Art. 23, echt befreit) books debtor and revenue and NO 2200 row at all.
  const invoiceId = makeInvoice(ctx, { currency: 'EUR', lines: oneLine(150000, 'EXPORT0') });
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' }).ok);

  const doc = readDoc(ctx, workspaceId, invoiceId);
  const ledger = ledgerFigures(store, doc.postedEntryId);

  assert.equal(ledger.vatRows.length, 0, 'an exempt supply writes no VAT row to sum');
  // The distinction the whole arm exists for: "posted, and charged no VAT" is a franc VAT of zero.
  // Null on this field means "nothing has posted", and conflating the two would tell a filer that an
  // invoice they issued last quarter has not been booked.
  assert.equal(doc.baseTaxMinor, 0, 'an exempt posted invoice owes zero francs of VAT, not unknown');
  assert.notEqual(doc.baseTaxMinor, null, 'zero and unknown are different answers');
  assert.notEqual(doc.postedEntryId, null, 'and this one really did post');
});

test('a foreign currency pegged at exactly 1 still reports its franc VAT, because it converted', () => {
  const { ctx, store, workspaceId } = setup();
  // Parity is a rate, not the absence of one (§H-FX, docs/specs/03-fx-foundation.md section 13).
  recordRate(ctx, { currency: 'USD', rate: '1' });
  const invoiceId = makeInvoice(ctx, { currency: 'USD', lines: oneLine() });
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' }).ok);

  const doc = readDoc(ctx, workspaceId, invoiceId);
  const ledger = ledgerFigures(store, doc.postedEntryId);

  assert.equal(ledger.rate, '1', 'A02 stamps the basis even at parity');
  assert.equal(doc.baseTaxMinor, ledger.vatBase);
  // At parity the two VAT figures coincide, which is exactly why the disclosure has to be present:
  // the numbers alone cannot tell a reader that a conversion happened.
  assert.equal(doc.baseTaxMinor, doc.taxMinor);
  assert.equal(doc.fxRate, '1');
});

test('the read model keeps the LEDGER franc VAT after the rate store moves under it', () => {
  const { ctx, store, workspaceId } = setup();
  recordRate(ctx, { asOf: '2026-07-15', rate: '0.9412' });
  const invoiceId = makeInvoice(ctx, { currency: 'EUR', lines: oneLine() });
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' }).ok);

  const before = readDoc(ctx, workspaceId, invoiceId);
  const ledgerBefore = ledgerFigures(store, before.postedEntryId);

  // A rate recorded AFTER the invoice was issued and valid ON the invoice date, which is what
  // importing a BAZG feed does. An implementation that re-resolved the rate at read time, or that
  // recomputed the franc VAT from a freshly resolved rate, would now report a figure never posted.
  recordRate(ctx, { asOf: '2026-07-16', rate: '0.5000' });

  const after = readDoc(ctx, workspaceId, invoiceId);
  const ledgerAfter = ledgerFigures(store, after.postedEntryId);
  assert.equal(ledgerAfter.vatBase, ledgerBefore.vatBase, 'the posted rows are immutable');
  assert.equal(after.baseTaxMinor, ledgerAfter.vatBase, 'the read model followed the ledger, not the rate store');
  assert.equal(after.baseTaxMinor, before.baseTaxMinor, 'a filed figure does not move when a rate lands late');
});

test('list_documents carries the franc VAT too (MCP-first, not a GUI-only field)', () => {
  const { ctx, store, workspaceId } = setup();
  recordRate(ctx, { rate: '0.9412' });
  const invoiceId = makeInvoice(ctx, { currency: 'EUR', lines: oneLine() });
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' }).ok);

  const listed = getAction('list_documents').run(ctx, { workspaceId, type: 'invoice' });
  assert.ok(listed.ok, JSON.stringify(listed));
  const row = listed.documents.find((d) => d.id === invoiceId);
  assert.notEqual(row, undefined, 'the invoice is in the list');

  const ledger = ledgerFigures(store, row.postedEntryId);
  assert.equal(row.baseTaxMinor, ledger.vatBase, 'the list reports the ledger franc VAT');
  assert.equal(
    row.baseTaxMinor,
    readDoc(ctx, workspaceId, invoiceId).baseTaxMinor,
    'the list and the single read must not disagree about the same document',
  );
});

test('a DEBIT to the VAT account subtracts, so a reversed supply cannot read as VAT owed', () => {
  const { ctx, store, workspaceId } = setup();
  recordRate(ctx, { rate: '0.9412' });

  // The shape A13's credit note will post: revenue DEBITED (which flips the trace sign), the
  // receivable credited, and the output VAT DEBITED back out of 2200. This is a REAL entry through
  // the real `postEntry` path, VAT gate and FX allocation included, not hand-written rows: A02
  // accepts it because `reconcileAndStampVat` recomputes the expected 2200 movement from the codes
  // and this one reconciles. CHF 114.36 comes back OUT of the VAT account.
  const acc = (n) =>
    store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  const posted = postEntry(ctx, {
    date: '2026-07-16',
    source: 'manual',
    description: 'Gutschrift',
    idempotencyKey: 'cn1',
    currency: 'EUR',
    fxRate: '0.9412',
    lines: [
      { account: acc('3200'), debit: 150000, taxCode: 'UST81' },
      { account: acc(OUTPUT_VAT), debit: 12150 },
      { account: acc('1100'), credit: 162150 },
    ],
  });
  assert.ok(posted.ok, JSON.stringify(posted));

  // The one synthetic step, and it is named rather than hidden: A13's credit-note poster is not
  // written yet, so nothing in the engine will hang a document off this entry for us. `posted_entry_id`
  // is the only link, and pointing it at a genuinely posted reversing entry is what lets the SQL be
  // exercised now instead of shipping as defensive code nobody has ever run. The alternative was to
  // sum credits alone, which on THIS entry answers zero: a document that took CHF 114.36 back out of
  // the VAT account, reported as having moved no VAT at all.
  const invoiceId = makeInvoice(ctx, { currency: 'EUR', lines: oneLine() });
  store.db
    .prepare("UPDATE document SET status = 'issued', posted_entry_id = ? WHERE workspace_id = ? AND id = ?")
    .run(posted.entryId, workspaceId, invoiceId);

  const doc = readDoc(ctx, workspaceId, invoiceId);
  const ledger = ledgerFigures(store, doc.postedEntryId);
  assert.equal(ledger.vatRows.length, 1, 'one VAT row, and it is a DEBIT');
  assert.equal(ledger.vatRows[0].base_credit_minor, 0, 'nothing was credited to the VAT account');
  assert.ok(ledger.vatRows[0].base_debit_minor > 0, 'francs came back out of it');

  assert.equal(doc.baseTaxMinor, ledger.vatBase, 'the read model reports the NET movement');
  assert.equal(doc.baseTaxMinor, -ledger.vatRows[0].base_debit_minor, 'and that movement is negative');
  assert.ok(doc.baseTaxMinor < 0, 'VAT taken back out is not VAT owed');
});

test('the franc VAT is the LEDGER allocation, and a client multiplying would be one Rappen wrong', () => {
  const { ctx, store, workspaceId } = setup();
  recordRate(ctx, { rate: '0.9412' });
  // A real two-rate invoice: CHF-equivalent EUR 199.00 at 8.1% and EUR 194.00 at 2.6%. `applyFx`
  // rounds ONCE on the credit-side TOTAL and allocates back by largest remainder, so the VAT legs
  // are shares of one rounded number rather than two independently rounded products. On THESE
  // amounts the two methods part company at the document level, by one Rappen.
  const invoiceId = makeInvoice(ctx, {
    currency: 'EUR',
    lines: [
      { description: 'Beratung', unitPriceMinor: 19900, taxCode: 'UST81' },
      { description: 'Buch', unitPriceMinor: 19400, taxCode: 'UST26' },
    ],
  });
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'i1' }).ok);

  const doc = readDoc(ctx, workspaceId, invoiceId);
  const ledger = ledgerFigures(store, doc.postedEntryId);
  assert.equal(ledger.vatRows.length, 2, 'a two-rate invoice books one VAT leg per rate');

  // The read model reports the LEDGER's figure.
  assert.equal(doc.baseTaxMinor, ledger.vatBase);

  // The multiplication a client could do for itself, computed with the repo's own P2 rounding so the
  // comparison is fair, and it is WRONG here. This is the witness that makes "derive it, never
  // multiply it" a fact about this invoice rather than a preference.
  const naive = roundHalfAwayFromZero(doc.taxMinor * Number(doc.fxRate));
  assert.notEqual(
    doc.baseTaxMinor,
    naive,
    'the ledger allocation and the per-figure product must differ on this invoice, or the test proves nothing',
  );
  assert.equal(Math.abs(doc.baseTaxMinor - naive), 1, 'and they differ by exactly one Rappen');
});
