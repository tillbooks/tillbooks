/**
 * The Studio franc-VAT fixture, pinned to the LIVE engine (A11 M11, §H-FX, A07).
 *
 * `test/sales/studio-fx-document-fixture.test.mjs` already pins the three arms the FX group had when
 * the group was about the TOTAL: base-currency posted, foreign draft, foreign posted. `baseTaxMinor`
 * adds a fourth that `totalBaseMinor` never had to face, and it is a fourth ARM rather than a fourth
 * key, because it is a distinction of VALUE inside a shape that already existed:
 *
 *   1. base currency, posted:        no FX keys at all (nothing was converted to disclose)
 *   2. foreign, posted, with VAT:    every key real, and the two VAT figures are different numbers
 *   3. foreign, NOT posted (draft):  `baseCurrency` set, every figure null (no rate is stamped yet)
 *   4. foreign, posted, PURE EXPORT: every key real, and the franc VAT is ZERO
 *
 * Arm 4 is the one worth building a fixture for. A pure export under MWSTG Art. 23 books debtor and
 * revenue and writes no output-VAT row at all, so the engine's correlated subquery finds nothing to
 * sum. Nothing found is ZERO FRANCS OF VAT on an invoice that really posted, and null on this field
 * means nothing has posted. `postedEntryId` is what tells them apart. A Studio that collapsed them
 * would tell a filer that an invoice they issued last quarter has not reached the books.
 *
 * The two-rate arm exists for a different reason: it is the witness that the Studio must never
 * multiply. `applyFx` rounds ONCE on the side total and allocates back by largest remainder, so on
 * THIS document the ledger says CHF 19.91 of MWST and `round(taxMinor * fxRate)` says CHF 19.92. A
 * single-rate document would agree by luck, which is exactly how this class of defect hides, so the
 * Studio's mutation check needs a body on which the two genuinely disagree.
 *
 * Nothing here is asserted against a literal or against the return value of the call that produced
 * it. Every figure is read back out of SQLite (`journal_line`, joined to `account`, with the VAT
 * account resolved through `ROLE_ACCOUNT_NUMBER.outputVat` rather than a '2200' typed here) and the
 * fixture is required to equal THOSE rows. A fixture that quoted a stale number would otherwise keep
 * a whole jsdom suite green while the Studio printed a franc VAT the books never posted.
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
import { ROLE_ACCOUNT_NUMBER } from '../../dist/core/payments/accounts.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../../app/src/surfaces/Documents/document-fx.fixture.json', import.meta.url), 'utf8'),
);

const AT = '2026-07-16T00:00:00.000Z';
/** The output-VAT account, from the single enumeration point, never a literal typed in a test. */
const OUTPUT_VAT = ROLE_ACCOUNT_NUMBER.outputVat;
const FX_KEYS = ['totalBaseMinor', 'fxRate', 'baseCurrency', 'baseTaxMinor'];

/** Half away from zero, the repo's P2 rounding, so the naive product is computed the repo's own way. */
const roundHalfAwayFromZero = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));

function keysOf(obj) {
  return Object.keys(obj).sort();
}
function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
function assertShape(fixture, live, where) {
  assert.deepEqual(keysOf(fixture), keysOf(live), `${where}: key drift`);
  for (const key of Object.keys(live)) {
    assert.equal(kindOf(fixture[key]), kindOf(live[key]), `${where}.${key}: kind drift`);
  }
}

/** A workspace that can really issue an invoice, with EUR at the fixture's own rate. */
function liveWorld() {
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
  const rate = recordExchangeRate(ctx, {
    baseCurrency: 'EUR',
    rate: '0.9412',
    asOf: '2026-07-15',
    source: 'manual',
    method: 'daily',
    provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
    idempotencyKey: 'fx-EUR-0.9412',
  });
  assert.ok(rate.ok, JSON.stringify(rate));
  return { ctx, store, workspaceId };
}

function makeInvoice(ctx, lines) {
  const doc = createDocument(ctx, { type: 'invoice', contactId: 'ct_1', currency: 'EUR', lines });
  assert.ok(doc.ok, JSON.stringify(doc));
  return doc.document.id;
}

function readDoc(ctx, workspaceId, documentId) {
  const res = getAction('get_document').run(ctx, { workspaceId, documentId });
  assert.ok(res.ok, JSON.stringify(res));
  return res.document;
}

/** The output-VAT legs of one posted entry, straight out of SQLite. The only authority in this file. */
function ledgerVat(store, entryId) {
  const rows = store.db
    .prepare(
      `SELECT jl.debit_minor, jl.credit_minor, jl.base_debit_minor, jl.base_credit_minor
         FROM journal_line jl JOIN account a ON a.id = jl.account_id
        WHERE jl.entry_id = ? AND a.number = ?`,
    )
    .all(entryId, OUTPUT_VAT);
  return {
    rows,
    // Net of debits, so a reversing or mirrored leg subtracts rather than inflating the figure.
    base: rows.reduce((sum, r) => sum + r.base_credit_minor - r.base_debit_minor, 0),
    transaction: rows.reduce((sum, r) => sum + r.credit_minor - r.debit_minor, 0),
  };
}

/** The two arms this file adds to the Studio fixture, both posted, both EUR. */
function world() {
  const { ctx, store, workspaceId } = liveWorld();
  const ids = {
    // A pure export under MWSTG Art. 23: echt befreit, so no output-VAT row is written at all.
    issuedExport: makeInvoice(ctx, [{ description: 'Ausfuhr', unitPriceMinor: 150000, taxCode: 'EXPORT0' }]),
    // Two rates on one document, which is what makes the ledger allocation and a per-figure product
    // disagree. EUR 199.00 at 8.1% beside EUR 194.00 at 2.6%.
    issuedTwoRate: makeInvoice(ctx, [
      { description: 'Beratung', unitPriceMinor: 19900, taxCode: 'UST81' },
      { description: 'Buch', unitPriceMinor: 19400, taxCode: 'UST26' },
    ]),
  };
  let n = 0;
  for (const key of Object.keys(ids)) {
    const res = issueInvoice(ctx, { invoiceId: ids[key], idempotencyKey: `i${(n += 1)}` });
    assert.ok(res.ok, `${key} must issue: ${JSON.stringify(res)}`);
  }
  return { ctx, store, workspaceId, ids };
}

test('both new Studio fixture arms match the live get_document, keys and kinds', () => {
  const { ctx, workspaceId, ids } = world();
  for (const arm of Object.keys(ids)) {
    assert.notEqual(FIXTURE[arm], undefined, `the Studio fixture is missing the ${arm} arm`);
    assertShape(FIXTURE[arm], readDoc(ctx, workspaceId, ids[arm]), `get_document(${arm})`);
  }
});

test('the PURE EXPORT arm is zero francs of VAT on a posted invoice, never null', () => {
  const { ctx, store, workspaceId, ids } = world();
  const doc = readDoc(ctx, workspaceId, ids.issuedExport);
  const vat = ledgerVat(store, doc.postedEntryId);

  assert.equal(vat.rows.length, 0, 'an echt befreite Ausfuhr writes no output-VAT row to sum');
  assert.notEqual(doc.postedEntryId, null, 'and yet this invoice really did post');
  assert.equal(doc.baseTaxMinor, vat.base, 'the read model reports the ledger, which sums to zero');
  assert.equal(doc.baseTaxMinor, 0);

  // The fixture the Studio renders has to depict that distinction, not flatten it. `0` and `null`
  // are one keystroke apart in JSON and a whole quarter apart to a filer.
  assert.equal(FIXTURE.issuedExport.baseTaxMinor, 0, 'the fixture must say zero, not null');
  assert.notEqual(FIXTURE.issuedExport.baseTaxMinor, null);
  assert.equal(kindOf(FIXTURE.issuedExport.baseTaxMinor), 'number');
  assert.notEqual(FIXTURE.issuedExport.postedEntryId, null, 'and must depict it as posted');
  // The rest of the group is real on this arm, so the Studio still shows what the books hold.
  assert.equal(FIXTURE.issuedExport.totalBaseMinor, doc.totalBaseMinor);
  assert.equal(FIXTURE.issuedExport.fxRate, doc.fxRate);
  assert.equal(FIXTURE.issuedExport.taxMinor, 0, 'no VAT was charged in EUR either');
});

test('the PURE EXPORT arm is distinguishable from the DRAFT arm, which is the point of both', () => {
  // Same currency, same shape, opposite meaning. The draft has stamped no rate, so every figure is
  // null; the export posted, so every figure is real and the franc VAT is a real zero.
  assert.equal(FIXTURE.draftForeign.postedEntryId, null);
  assert.equal(FIXTURE.draftForeign.baseTaxMinor, null, 'nothing posted means unknown');
  assert.notEqual(FIXTURE.issuedExport.postedEntryId, null);
  assert.equal(FIXTURE.issuedExport.baseTaxMinor, 0, 'posted with no VAT means zero');
  assert.equal(FIXTURE.draftForeign.currency, FIXTURE.issuedExport.currency, 'the currency cannot tell them apart');
});

test('the TWO-RATE arm quotes the ledger allocation, and a client multiplying would be a Rappen wrong', () => {
  const { ctx, store, workspaceId, ids } = world();
  const doc = readDoc(ctx, workspaceId, ids.issuedTwoRate);
  const vat = ledgerVat(store, doc.postedEntryId);

  assert.equal(vat.rows.length, 2, 'a two-rate invoice books one VAT leg per rate');
  assert.equal(doc.baseTaxMinor, vat.base, 'the read model reports the posted base credits');
  assert.equal(doc.taxMinor, vat.transaction, 'and the posted transaction credits');

  // The fixture must quote the LEDGER, because the Studio's jsdom tests render the fixture and
  // nothing else. A stale number here is a green suite over a wrong screen.
  assert.equal(FIXTURE.issuedTwoRate.baseTaxMinor, vat.base, 'the fixture franc VAT drifted from the ledger');
  assert.equal(FIXTURE.issuedTwoRate.taxMinor, vat.transaction, 'the fixture transaction VAT drifted');
  assert.equal(FIXTURE.issuedTwoRate.fxRate, doc.fxRate);
  assert.equal(FIXTURE.issuedTwoRate.totalBaseMinor, doc.totalBaseMinor);

  // The witness. Computed with the repo's own rounding so the comparison is fair to the shortcut,
  // and the shortcut is still wrong. Without this the Studio's mutation check could pass on a
  // single-rate body by coincidence and prove nothing at all.
  const naive = roundHalfAwayFromZero(FIXTURE.issuedTwoRate.taxMinor * Number(FIXTURE.issuedTwoRate.fxRate));
  assert.notEqual(
    FIXTURE.issuedTwoRate.baseTaxMinor,
    naive,
    'this arm must be one on which the ledger and the product disagree, or it is not a witness',
  );
  assert.equal(Math.abs(FIXTURE.issuedTwoRate.baseTaxMinor - naive), 1, 'and they differ by exactly one Rappen');
});

test('every fixture arm carries the franc VAT in the shape the Studio branches on', () => {
  const has = (doc, key) => Object.prototype.hasOwnProperty.call(doc, key);

  // Arm 1: base currency. The whole group is absent, so a Studio guard reads undefined and renders
  // nothing at all rather than a franc figure beside an identical franc figure.
  for (const key of FX_KEYS) assert.equal(has(FIXTURE.issuedBase, key), false, `issuedBase must not carry ${key}`);

  // Arms 2 and 4: posted foreign. All four keys, and `baseTaxMinor` is a number in both, which is
  // why the Studio can branch ONCE on the group instead of asking a second question about the tax.
  for (const arm of ['issuedForeign', 'issuedPegged', 'issuedExport', 'issuedTwoRate']) {
    for (const key of FX_KEYS) assert.equal(has(FIXTURE[arm], key), true, `${arm} must carry ${key}`);
    assert.equal(kindOf(FIXTURE[arm].baseTaxMinor), 'number', `${arm}: the franc VAT is a figure`);
    assert.equal(kindOf(FIXTURE[arm].totalBaseMinor), 'number');
    assert.equal(kindOf(FIXTURE[arm].fxRate), 'string', 'the rate stays a string: a number has lost precision');
  }

  // Arm 3: foreign draft. Two of four, from the engine, which is why the group cannot be typed as
  // "all of them or none".
  assert.equal(kindOf(FIXTURE.draftForeign.baseCurrency), 'string');
  for (const key of ['totalBaseMinor', 'fxRate', 'baseTaxMinor']) {
    assert.equal(FIXTURE.draftForeign[key], null, `draftForeign.${key} must be null, not absent and not zero`);
    assert.equal(has(FIXTURE.draftForeign, key), true, `draftForeign must still carry ${key}`);
  }
});

test('list_documents carries the franc VAT on the new arms too, so the list cannot disagree', () => {
  const { ctx, workspaceId, ids } = world();
  const listed = getAction('list_documents').run(ctx, { workspaceId, type: 'invoice' });
  assert.ok(listed.ok, JSON.stringify(listed));

  for (const arm of Object.keys(ids)) {
    const row = listed.documents.find((d) => d.id === ids[arm]);
    assert.notEqual(row, undefined, `${arm} is missing from the list`);
    assertShape(FIXTURE[arm], row, `list_documents(${arm})`);
    const single = readDoc(ctx, workspaceId, ids[arm]);
    for (const key of FX_KEYS) {
      assert.equal(row[key], single[key], `${arm}.${key}: the list and the detail disagree`);
    }
  }
});
