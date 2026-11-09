// A11: a historic-era tax code on a line with no Leistungsdatum is ambiguous, and says so.
//
// A11 prices each position with `buildVatLines(..., supplyDate: line.supply_date ?? null)`, which
// falls back to the code's STORED rate. A02 then re-prices the same line inside `reconcileAndStampVat`
// with `line.supplyDate ?? input.date`, which resolves the rate from the ENTRY DATE's era. For every
// seeded code the two agree (the stored rate IS the current era's rate) and nothing shows. For a
// workspace-defined historic code they disagree, and the invoice was refused with:
//
//   {"account":"2200","expectedMinor":8100,"bookedMinor":7700,"error":"vat_trace_unreconciled"}
//
// That fails CLOSED, which is right: nothing wrong reaches the payload. But it names an account and
// two Rappen figures, and says nothing about the cause (a code whose era is not the entry's era) or
// the fix (give the position its Leistungsdatum). An operator reading it has no way forward.
//
// The behaviour asserted here is deliberately NOT "price it at 7.7% anyway" and NOT "price it at
// 8.1% anyway". Both silently resolve an ambiguity the operator alone can settle: 7.7% ignores the
// entry date the engine's own F2 rule says governs, and 8.1% overrides the rate the operator picked
// the code FOR. The refusal stands; only its legibility changes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes, configureVat, upsertTaxCode, computeLineTax } from '../../dist/core/vat/index.js';
import { createDocument, issueInvoice } from '../../dist/core/sales/index.js';

const AT = '2026-07-16T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  configureVat(ctx, { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'cfg-1' });
  setCreditorProfile(ctx, {
    creditorName: 'Nomadik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'b@m.example', 'CHF', 30, ?)`,
    )
    .run(workspaceId, AT);
  return { ctx, store, workspaceId };
}

/** The 7.7% Normalsatz that ran until 2023-12-31: a legitimate historic Swiss rate, not a fiction. */
function addHistoricCode(ctx) {
  const res = upsertTaxCode(ctx, {
    code: 'UST77',
    kind: 'output',
    rateBp: 770,
    formLine: '302',
    label: 'MWST 7.7% (bis 2023)',
    idempotencyKey: 'tc-77',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
}

let lastInvoiceId = null;
const issue = (ctx, lines) => {
  lastInvoiceId = createDocument(ctx, { type: 'invoice', contactId: 'ct_1', currency: 'CHF', lines }).document.id;
  return issueInvoice(ctx, { invoiceId: lastInvoiceId });
};

test('the two pricing calls really do disagree for a historic code with no supply date', () => {
  // The premise, stated on the engine rather than inferred: this is why the invoice was refused.
  const { ctx } = setup();
  addHistoricCode(ctx);
  const asA11Prices = computeLineTax(ctx, {
    amountMinor: 100000,
    amountIsGross: false,
    taxCode: 'UST77',
    supplyDate: null,
  });
  const asA02Reprices = computeLineTax(ctx, {
    amountMinor: 100000,
    amountIsGross: false,
    taxCode: 'UST77',
    supplyDate: '2026-07-16',
  });
  assert.equal(asA11Prices.rateBp, 770, 'A11 falls back to the stored rate');
  assert.equal(asA02Reprices.rateBp, 810, "A02 resolves the entry date's era rate");
});

test('a historic code with NO Leistungsdatum is refused, naming the code and the fix', () => {
  const { ctx, store, workspaceId } = setup();
  addHistoricCode(ctx);
  const res = issue(ctx, [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST77' }]);

  assert.equal(res.ok, false, `an ambiguous rate must not be resolved silently: ${JSON.stringify(res)}`);
  assert.equal(res.error, 'needs_supply_date', JSON.stringify(res));
  assert.equal(res.position, 1, 'the POSITION the operator typed');
  assert.equal(res.taxCode, 'UST77');
  assert.equal(res.codeRateBp, 770, "the code's own rate");
  assert.equal(res.entryDateRateBp, 810, "the rate the entry date's era would impose");
  assert.match(res.reason, /Leistungsdatum|supply date/i, `the fix must be named: ${JSON.stringify(res)}`);
  // No internal account id, and no bare Rappen figures standing in for an explanation.
  assert.equal(/acc_/.test(JSON.stringify(res)), false);

  // Still fails CLOSED, exactly as before: nothing half-written, no number consumed.
  const row = store.db.prepare('SELECT status, number, posted_entry_id FROM document WHERE id = ?').get(lastInvoiceId);
  assert.equal(row.status, 'draft');
  assert.equal(row.number, null);
  assert.equal(row.posted_entry_id, null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get().n, 0);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM document_number_seq WHERE workspace_id = ?').get(workspaceId).n,
    0,
  );
});

test('the SAME historic code WITH its Leistungsdatum issues normally, at the historic rate', () => {
  // The workspace is not blocked from using a historic code: it is asked for the one fact that
  // settles which era applies. This is the path the refusal above points the operator at.
  const { ctx, store } = setup();
  addHistoricCode(ctx);
  const res = issue(ctx, [
    { description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST77', supplyDate: '2023-06-15' },
  ]);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.document.taxMinor, 7700, 'and it books 7.7%, the rate that era really carried');
  assert.equal(res.document.totalMinor, 107700);

  const entryId = store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(res.document.id).p;
  const vat = store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_credit_minor),0) AS c FROM journal_line l
       JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? AND a.number = '2200'`,
    )
    .get(entryId).c;
  assert.equal(vat, 7700, 'the posted output VAT is the historic rate, not the current one');
});

test('the seeded current-era codes are untouched: no new refusal on the ordinary path', () => {
  const { ctx } = setup();
  addHistoricCode(ctx);
  for (const taxCode of ['UST81', 'UST38', 'UST26']) {
    const res = issue(ctx, [{ description: 'Beratung', unitPriceMinor: 100000, taxCode }]);
    assert.equal(res.ok, true, `${taxCode} must still issue with no supply date: ${JSON.stringify(res)}`);
  }
});

test('a mixed invoice names the OFFENDING position, not the first one', () => {
  const { ctx } = setup();
  addHistoricCode(ctx);
  const res = issue(ctx, [
    { description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' },
    { description: 'Altlast', unitPriceMinor: 50000, taxCode: 'UST77' },
  ]);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'needs_supply_date');
  assert.equal(res.position, 2, 'the second position is the ambiguous one');
});
