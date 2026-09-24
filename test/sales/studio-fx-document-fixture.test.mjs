/**
 * The Studio FX fixture-versus-engine drift guard (A11 M11, §H-FX).
 *
 * `app/src/surfaces/Documents/document-fx.fixture.json` is what the Studio's jsdom tests render in
 * place of a live `get_document` / `list_documents` response when the subject is the base-currency
 * disclosure. Same contract as `document-fixture.test.mjs` and `currency-picker-fixture.test.mjs`:
 * pin every arm to the REAL engine answer, keys and kinds, so a Studio test can never pass green
 * against a shape the engine does not send. This repo has shipped four Studio defects by assuming a
 * key the engine never sends, and the §H-FX group is unusually easy to assume wrong, because its
 * presence is CONDITIONAL and the condition is not the one a reader guesses.
 *
 * The condition is A02's `statesConversionBasis`, which asks about the CURRENCY and nothing else. So
 * there are three arms, not two, and the brief that commissioned this work predicted only two:
 *
 *   - base currency, posted:      none of the keys exist at all
 *   - foreign currency, DRAFT:    `baseCurrency` is a string while every figure is null
 *   - foreign currency, posted:   all of them carry values, parity (rate '1') included
 *
 * The draft arm is the one worth pinning hardest. A type or a guard built on "they all travel
 * together" reads a draft EUR invoice as though it stated a basis, and the Studio would then render
 * a base total of `null`. So this file asserts the arms are DISTINGUISHABLE, not merely present.
 *
 * The group is four keys wide now, not three: `baseTaxMinor` joined it when the franc VAT figure an
 * MWST-Abrechnung is actually filed on reached a verb. It is the one figure on this read model a
 * Swiss filer needs and could not previously get, and like the rest of the group it is derived from
 * the posted rows rather than stored, so a Studio panel never multiplies a rate out for itself.
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
// `baseTaxMinor` joined the group when the franc VAT figure an MWST-Abrechnung is filed on finally
// reached a verb. It travels with the other three, under the same `statesConversionBasis` gate, so
// the Studio branches once and gets all four or none.
const FX_KEYS = ['totalBaseMinor', 'fxRate', 'baseCurrency', 'baseTaxMinor'];

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

/** A workspace that can really issue an invoice, with EUR at 0.9412 and USD pegged at exactly 1. */
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
  for (const [currency, rate] of [
    ['EUR', '0.9412'],
    ['USD', '1'],
  ]) {
    const res = recordExchangeRate(ctx, {
      baseCurrency: currency,
      rate,
      asOf: '2026-07-15',
      source: 'manual',
      method: 'daily',
      provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
      idempotencyKey: `fx-${currency}-${rate}`,
    });
    assert.ok(res.ok, JSON.stringify(res));
  }
  return { ctx, store, workspaceId };
}

function makeInvoice(ctx, currency) {
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency,
    lines: [{ description: 'Beratung', quantityMilli: 10000, unitPriceMinor: 15000, taxCode: 'UST81' }],
  });
  assert.ok(doc.ok, JSON.stringify(doc));
  return doc.document.id;
}

function readDoc(ctx, workspaceId, documentId) {
  const res = getAction('get_document').run(ctx, { workspaceId, documentId });
  assert.ok(res.ok, JSON.stringify(res));
  return res.document;
}

/** Build all four documents the fixture depicts, in the fixture's own order. */
function world() {
  const { ctx, store, workspaceId } = liveWorld();
  const ids = {
    issuedForeign: makeInvoice(ctx, 'EUR'),
    issuedBase: makeInvoice(ctx, 'CHF'),
    issuedPegged: makeInvoice(ctx, 'USD'),
    draftForeign: makeInvoice(ctx, 'EUR'),
  };
  let n = 0;
  for (const key of ['issuedForeign', 'issuedBase', 'issuedPegged']) {
    const res = issueInvoice(ctx, { invoiceId: ids[key], idempotencyKey: `i${(n += 1)}` });
    assert.ok(res.ok, `${key} must issue: ${JSON.stringify(res)}`);
  }
  return { ctx, store, workspaceId, ids };
}

test('every arm of the Studio FX fixture matches the live get_document, keys and kinds', () => {
  const { ctx, workspaceId, ids } = world();
  for (const arm of Object.keys(ids)) {
    assertShape(FIXTURE[arm], readDoc(ctx, workspaceId, ids[arm]), `get_document(${arm})`);
  }
});

test('the three arms are DISTINGUISHABLE by the FX keys, which is what the Studio branches on', () => {
  const { ctx, workspaceId, ids } = world();
  const has = (doc, key) => Object.prototype.hasOwnProperty.call(doc, key);

  // Arm 1: base currency. The group is absent entirely, so a Studio guard that reads
  // `doc.baseCurrency` gets undefined and must render nothing at all.
  const base = readDoc(ctx, workspaceId, ids.issuedBase);
  for (const key of FX_KEYS) {
    assert.equal(has(base, key), false, `a base-currency document must not carry ${key}`);
    assert.equal(has(FIXTURE.issuedBase, key), false, `the issuedBase fixture must not carry ${key} either`);
  }

  // Arm 2: foreign DRAFT. `baseCurrency` is a string, both figures are null. The whole reason the
  // Studio cannot type this group as "all three or none": here it is two-of-three, from the engine.
  const draft = readDoc(ctx, workspaceId, ids.draftForeign);
  assert.equal(kindOf(draft.baseCurrency), 'string', 'the ledger currency is known before anything posts');
  assert.equal(draft.totalBaseMinor, null, 'no rate is stamped until the invoice issues');
  assert.equal(draft.fxRate, null);
  assert.equal(draft.baseTaxMinor, null, 'and no franc VAT either: a draft has none even in principle');
  assert.equal(FIXTURE.draftForeign.baseCurrency, draft.baseCurrency);
  assert.equal(FIXTURE.draftForeign.totalBaseMinor, null, 'the fixture must depict the draft arm honestly');
  assert.equal(FIXTURE.draftForeign.fxRate, null);
  assert.equal(FIXTURE.draftForeign.baseTaxMinor, null);

  // Arm 3: posted foreign. All three carry values, and the base total is a CONVERTED figure rather
  // than a copy of the transaction total under another name.
  const foreign = readDoc(ctx, workspaceId, ids.issuedForeign);
  assert.equal(kindOf(foreign.totalBaseMinor), 'number');
  assert.equal(kindOf(foreign.fxRate), 'string', 'the rate stays a string: a number here has already lost precision');
  assert.notEqual(foreign.totalBaseMinor, foreign.totalMinor, 'EUR at 0.9412 is not the same number of francs');
  assert.equal(kindOf(foreign.baseTaxMinor), 'number', 'the franc VAT is a figure on a posted foreign document');
  assert.notEqual(foreign.baseTaxMinor, foreign.taxMinor, 'the EUR VAT and the franc VAT are different numbers');
  assert.equal(FIXTURE.issuedForeign.totalBaseMinor, foreign.totalBaseMinor, 'the fixture base total drifted');
  assert.equal(FIXTURE.issuedForeign.fxRate, foreign.fxRate, 'the fixture rate string drifted');
  assert.equal(FIXTURE.issuedForeign.totalMinor, foreign.totalMinor, 'the fixture transaction total drifted');
  assert.equal(FIXTURE.issuedForeign.baseTaxMinor, foreign.baseTaxMinor, 'the fixture franc VAT drifted');

  // Arm 3 at parity: the two totals coincide, which is exactly why the RATE has to be stated
  // separately. A Studio panel that only compared the numbers could not tell this apart from arm 1.
  const pegged = readDoc(ctx, workspaceId, ids.issuedPegged);
  assert.equal(pegged.fxRate, '1', 'A02 stamps the basis even at parity');
  assert.equal(pegged.totalBaseMinor, pegged.totalMinor, 'at parity the figures coincide');
  assert.equal(FIXTURE.issuedPegged.fxRate, pegged.fxRate);
  assert.equal(FIXTURE.issuedPegged.totalBaseMinor, pegged.totalBaseMinor);
  assert.equal(pegged.baseTaxMinor, pegged.taxMinor, 'at parity the two VAT figures coincide too');
  assert.equal(FIXTURE.issuedPegged.baseTaxMinor, pegged.baseTaxMinor);
  assert.equal(has(pegged, 'baseCurrency'), true, 'and it is still denominated');
});

test('the fixture base total is the LEDGER base total, so the Studio never has to multiply a rate out', () => {
  const { ctx, store, workspaceId, ids } = world();
  const doc = readDoc(ctx, workspaceId, ids.issuedForeign);
  const rows = store.db
    .prepare('SELECT base_debit_minor, debit_minor, fx_rate FROM journal_line WHERE entry_id = ?')
    .all(doc.postedEntryId);
  const ledgerBase = rows.reduce((sum, r) => sum + r.base_debit_minor, 0);
  const ledgerTxn = rows.reduce((sum, r) => sum + r.debit_minor, 0);

  // The point of the whole exercise: the figure the Studio prints came off the posted rows. If the
  // fixture and the ledger ever disagree, the fixture is what a Studio test would keep believing.
  assert.equal(FIXTURE.issuedForeign.totalBaseMinor, ledgerBase, 'the fixture must quote the posted base debits');
  assert.equal(FIXTURE.issuedForeign.totalMinor, ledgerTxn, 'and the posted transaction debits');
  assert.equal(doc.totalBaseMinor, ledgerBase);
});

test('the fixture franc VAT is the LEDGER franc VAT, off the posted VAT rows', () => {
  const { ctx, store, workspaceId, ids } = world();
  const doc = readDoc(ctx, workspaceId, ids.issuedForeign);
  const vat = store.db
    .prepare(
      `SELECT jl.credit_minor, jl.base_credit_minor
         FROM journal_line jl JOIN account a ON a.id = jl.account_id
        WHERE jl.entry_id = ? AND a.number = ?`,
    )
    .all(doc.postedEntryId, ROLE_ACCOUNT_NUMBER.outputVat);
  assert.ok(vat.length > 0, 'a taxable invoice books at least one output-VAT row');

  const ledgerBaseVat = vat.reduce((sum, r) => sum + r.base_credit_minor, 0);
  const ledgerTxnVat = vat.reduce((sum, r) => sum + r.credit_minor, 0);

  // The reason this fixture exists at all: the Studio renders these numbers, and a Studio test that
  // believed a stale one would pass green while a filer read a franc VAT the books never posted.
  assert.equal(FIXTURE.issuedForeign.baseTaxMinor, ledgerBaseVat, 'the fixture must quote the posted base credit');
  assert.equal(FIXTURE.issuedForeign.taxMinor, ledgerTxnVat, 'and the posted transaction credit');
  assert.equal(doc.baseTaxMinor, ledgerBaseVat);
  assert.notEqual(ledgerBaseVat, ledgerTxnVat, 'EUR 121.50 is not CHF 121.50, which is the whole point');
});

test('no arm of the fixture carries fxRateAsOf, because the ledger has no such column to report', () => {
  const { ctx, workspaceId, ids } = world();
  for (const arm of Object.keys(ids)) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(FIXTURE[arm], 'fxRateAsOf'),
      false,
      `${arm}: a validity date in the fixture would license the Studio to display a guess`,
    );
    assert.equal(readDoc(ctx, workspaceId, ids[arm]).fxRateAsOf, undefined, `${arm}: the engine sends none either`);
  }
});

test('list_documents carries the same FX group as get_document, so the LIST can name its currencies', () => {
  const { ctx, workspaceId, ids } = world();
  const listed = getAction('list_documents').run(ctx, { workspaceId, type: 'invoice' });
  assert.ok(listed.ok, JSON.stringify(listed));

  for (const arm of Object.keys(ids)) {
    const row = listed.documents.find((d) => d.id === ids[arm]);
    assert.notEqual(row, undefined, `${arm} is missing from the list`);
    // The list row and the single read must not disagree about the same document, or the Studio
    // would show one figure in the list and another on the detail for the same invoice.
    assertShape(FIXTURE[arm], row, `list_documents(${arm})`);
    const single = readDoc(ctx, workspaceId, ids[arm]);
    for (const key of FX_KEYS) {
      assert.equal(row[key], single[key], `${arm}.${key}: the list and the detail disagree`);
    }
  }
});
