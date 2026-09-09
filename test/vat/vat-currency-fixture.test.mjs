/**
 * A11-G2: a EUR invoice carries TWO VAT figures, and neither of them is optional knowledge.
 *
 * The Studio's per-document VAT panel (`app/src/surfaces/Vat/VatSummary.tsx`) and the per-line
 * readout (`LineVatReadout.tsx`) called `formatMoney(...)` with no currency, and `formatMoney`
 * defaults to CHF. On a EUR document that put `Gebucht CHF 1'526.16` and `Total MWST CHF 121.50` on
 * one screen: the second figure is the EUR tax wearing a CHF label, so it is true in neither
 * currency, and it sits on an immutable posted record in the panel a person reads before filing.
 *
 * This file is the ledger half of the fix. It posts one real EUR invoice, reads every figure back
 * OUT of `journal_line` in SQLite, and pins `app/src/surfaces/Vat/vat-currency-eur.fixture.json`
 * to those rows. The app suite then renders that fixture instead of literals, so the number it
 * asserts is never displayed cannot quietly stop being the number the ledger holds.
 *
 * The property worth stating plainly, because it is the whole defect:
 *
 *   transaction VAT   EUR 121.50   (`journal_line.credit_minor` on 2200, and `tax_amount_minor`)
 *   base VAT          CHF 114.36   (`journal_line.base_credit_minor` on the same row)
 *
 * The base figure is NOT the transaction figure times the rate as a matter of definition: `applyFx`
 * rounds ONCE per side on the side total and allocates back over the lines by largest remainder
 * (src/core/ledger/postEntry.ts), so a client that multiplied would be inventing its own rounding
 * and would part company with the books on some invoice nobody was watching. The third test below
 * holds that property apart from the arithmetic that happens to agree on this particular invoice.
 *
 * The last test used to state a GAP rather than a guarantee, deliberately: no read model the Studio
 * could call carried the base VAT figure, because `get_document` grew `totalBaseMinor` / `fxRate` /
 * `baseCurrency` (the document TOTAL in francs) and never a base tax. It asserted that absence over
 * four candidate names so that the day the engine grew the field it would go red and hand the number
 * over rather than let it sit unused. That day arrived: `src/core/sales/document.ts` now derives
 * `baseTaxMinor` from the posted VAT rows, and the test asserts its presence and its value.
 *
 * The name is `baseTaxMinor` and not `taxBaseMinor`, which is the one detail in this file worth
 * reading twice. `journal_line.tax_base_minor` and `VatTrace.taxBaseMinor` already mean the taxable
 * NET, the Bemessungsgrundlage. Spending that identifier on the franc TAX would put two different
 * quantities behind one name, which is the same defect class this whole file exists to close.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { createDocument, issueInvoice } from '../../dist/core/sales/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { getAction } from '../../dist/api/registry.js';

const FIXTURE_PATH = new URL('../../app/src/surfaces/Vat/vat-currency-eur.fixture.json', import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

const AT = '2026-07-16T00:00:00.000Z';

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

/** Post the exact invoice the fixture describes: one EUR line at the fixture's net, taxed at 8.1%. */
function issueFixtureInvoice(ctx) {
  const rate = recordExchangeRate(ctx, {
    baseCurrency: fixture.currency,
    rate: fixture.fxRate,
    asOf: '2026-07-15',
    source: 'manual',
    method: 'daily',
    provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
    idempotencyKey: `fx-${fixture.currency}`,
  });
  assert.ok(rate.ok, JSON.stringify(rate));
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: fixture.currency,
    lines: [{ description: 'Beratung', unitPriceMinor: fixture.netMinor, taxCode: 'UST81' }],
  });
  assert.ok(doc.ok, JSON.stringify(doc));
  const issued = issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: 'i1' });
  assert.ok(issued.ok, JSON.stringify(issued));
  return doc.document.id;
}

/** The VAT row of a posted entry, straight out of SQLite. The only authority in this file. */
function vatRow(store, entryId, accountNumber) {
  const row = store.db
    .prepare(
      `SELECT jl.debit_minor, jl.credit_minor, jl.base_debit_minor, jl.base_credit_minor, jl.currency,
              jl.fx_rate, jl.tax_amount_minor, jl.tax_base_minor
         FROM journal_line jl JOIN account a ON a.id = jl.account_id
        WHERE jl.entry_id = ? AND a.number = ?`,
    )
    .get(entryId, accountNumber);
  assert.ok(row !== undefined, `no posted row on account ${accountNumber} for ${entryId}`);
  return row;
}

const readDoc = (ctx, workspaceId, documentId) => {
  const res = getAction('get_document').run(ctx, { workspaceId, documentId });
  assert.ok(res.ok, JSON.stringify(res));
  return res.document;
};

test('the EUR VAT fixture is the LEDGER: transaction tax and base tax, both read off the posted row', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = issueFixtureInvoice(ctx);
  const doc = readDoc(ctx, workspaceId, invoiceId);
  const vat = vatRow(store, doc.postedEntryId, fixture.vatAccount);

  // The two figures side by side, each equal to the column that holds it. Not close, equal.
  assert.equal(fixture.transactionTaxMinor, vat.credit_minor, 'the transaction VAT is the posted credit');
  assert.equal(fixture.baseTaxMinor, vat.base_credit_minor, 'the base VAT is the posted base credit');
  assert.equal(fixture.currency, vat.currency, 'the VAT row is denominated in the transaction currency');
  assert.equal(fixture.fxRate, vat.fx_rate, 'the rate is the one stamped on the posted rows');

  // And they are DIFFERENT numbers, which is the entire defect: one label cannot serve both.
  assert.notEqual(fixture.transactionTaxMinor, fixture.baseTaxMinor, 'EUR 121.50 is not CHF 121.50');
});

test('the trace the Studio previews is the TRANSACTION figure, not the francs the books hold', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = issueFixtureInvoice(ctx);
  const doc = readDoc(ctx, workspaceId, invoiceId);

  // §H-VAT-TRACE sits on the revenue row, in the transaction currency, deliberately (postEntry.ts).
  const revenue = vatRow(store, doc.postedEntryId, '3200');
  assert.equal(revenue.tax_amount_minor, fixture.transactionTaxMinor);
  assert.equal(revenue.tax_base_minor, fixture.netMinor);
  assert.equal(revenue.currency, fixture.currency);

  // `vat_preview` is what the Studio's summary and readout actually consume, and it answers in the
  // same currency as the amount it was handed. So every figure those two components render is a
  // transaction-currency figure, and the only honest label for them is the document's currency.
  const preview = getAction('vat_preview').run(ctx, {
    workspaceId,
    amountMinor: fixture.netMinor,
    amountIsGross: false,
    taxCode: 'UST81',
    supplyDate: doc.issueDate,
  });
  assert.ok(preview.ok, JSON.stringify(preview));
  assert.equal(preview.taxMinor, fixture.transactionTaxMinor, 'the preview answers in the amount currency');
  assert.equal(preview.grossMinor, fixture.transactionTotalMinor);
  assert.notEqual(preview.taxMinor, fixture.baseTaxMinor, 'the preview never returns the franc figure');
});

test('the base VAT is an ALLOCATION over the entry, not a per-line product the client could redo', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = issueFixtureInvoice(ctx);
  const doc = readDoc(ctx, workspaceId, invoiceId);

  const rows = store.db
    .prepare('SELECT base_debit_minor, base_credit_minor FROM journal_line WHERE entry_id = ?')
    .all(doc.postedEntryId);
  const baseDebits = rows.reduce((s, r) => s + r.base_debit_minor, 0);
  const baseCredits = rows.reduce((s, r) => s + r.base_credit_minor, 0);

  // §H-FX rounds ONCE on the side total and spreads the result back over the lines by largest
  // remainder, so the per-line base figures are shares of one rounded total and §H-LEDGER holds in
  // base currency by construction. A client multiplying a line by the rate would be choosing its own
  // rounding, which is why the rule is that the client never does money.
  assert.equal(baseDebits, baseCredits, 'the entry balances in the base currency, by construction');
  assert.equal(baseDebits, fixture.baseTotalMinor, 'the fixture base total is the posted base total');
  assert.equal(doc.totalBaseMinor, fixture.baseTotalMinor, 'and the read model reports that same total');
  assert.equal(doc.totalMinor, fixture.transactionTotalMinor);
  assert.equal(doc.baseCurrency, fixture.baseCurrency);

  // The base VAT is a share of `baseTotalMinor`, so the two base figures add to it exactly. This is
  // the invariant a per-line multiplication is not required to satisfy.
  const revenueBase = vatRow(store, doc.postedEntryId, '3200').base_credit_minor;
  assert.equal(revenueBase + fixture.baseTaxMinor, fixture.baseTotalMinor, 'the base legs sum to the base total');
});

test('the read model NOW sends the base-currency VAT figure (the gap, closed)', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = issueFixtureInvoice(ctx);
  const doc = readDoc(ctx, workspaceId, invoiceId);

  // What the FX group carries about the TOTAL: the francs, the rate, the base currency.
  assert.equal(typeof doc.totalBaseMinor, 'number');
  assert.equal(typeof doc.fxRate, 'string');
  assert.equal(typeof doc.baseCurrency, 'string');

  // And, since `src/core/sales/document.ts` grew `base_tax_minor`, what it carries about the TAX.
  // This assertion is the successor of an absence: the test used to loop over four candidate names
  // and demand every one be `undefined`, precisely so that the day the engine grew the field it
  // would fail loudly and hand the Studio the number instead of leaving it unused. It failed, on
  // `baseTaxMinor`, and this is what it was pointing at.
  assert.equal(typeof doc.baseTaxMinor, 'number', 'the franc VAT reaches a verb at last');
  assert.equal(doc.baseTaxMinor, fixture.baseTaxMinor, 'and it is the fixture figure, CHF 114.36');

  // Pinned to the LEDGER, not to the fixture alone: the same posted row the first test reads. A
  // fixture agreeing with a read model that had drifted from the books would be two wrongs agreeing.
  const vat = vatRow(store, doc.postedEntryId, fixture.vatAccount);
  assert.equal(doc.baseTaxMinor, vat.base_credit_minor, 'the read model reports the posted base credit');

  // `taxMinor` is still the TRANSACTION figure, which was the original trap: a franc-shaped name on
  // a EUR number. It equals the posted EUR credit, and the franc figure now sits beside it under a
  // name that says which is which, so a caller never has to guess and never has to multiply.
  assert.equal(doc.taxMinor, fixture.transactionTaxMinor);
  assert.equal(doc.taxMinor, vat.credit_minor);
  assert.notEqual(doc.taxMinor, doc.baseTaxMinor, 'EUR 121.50 is not CHF 114.36');

  // The three names the engine deliberately does NOT use. `taxBaseMinor` is the dangerous one and it
  // is not a style quibble: `journal_line.tax_base_minor` and `VatTrace.taxBaseMinor` already mean
  // the taxable NET (the Bemessungsgrundlage, EUR 1500.00 here), so spending that name on the franc
  // TAX would put two different quantities behind one identifier, in a codebase whose current defect
  // class is exactly a figure wearing the wrong label.
  for (const notUsed of ['taxBaseMinor', 'taxMinorBase', 'totalTaxBaseMinor']) {
    assert.equal(doc[notUsed], undefined, `${notUsed} must not become a second name for baseTaxMinor`);
  }
});
