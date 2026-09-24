// A11: the Swico S1 billing information (`StrdBkgInf`), against SIX IG v2.3 Annex D.
//
// Primary source, fetched 2026-07-25 from
// https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.3-en.pdf
//
// Table 30, field /32/ (VAT details):
//   "The VAT details refer to the invoiced amount, excluding any discount.
//    VAT details contain either: a single percentage that is to be applied to the whole invoiced
//    amount, or a list of the VAT amounts, defined by a percentage rate and a net amount; the colon
//    ':' is used as the separator. The net amount is the net price (excluding VAT) on which the VAT
//    is calculated. If a list is given, the total of the net amounts and the VAT calculated on them
//    must correspond to the amount in the QR Code."
//
// Table 31, Example 2 shows a ZERO-rate line inside the list, so zero-rated and untaxed positions
// belong IN the list, they are not skipped:
//   //S1/10/10104/11/180228/30/395856455/31/180226180227/32/3.7:400.19;7.7:553.39;0:14/40/0:30
//   "(400.19+14.81) + (553.39+42.61) + (14.00+0.00) = 1025.00"
//
// Table 29 (rules):
//   "Field content must not contain the characters '/' and '\'; these must be replaced by '\/' and
//    '\\' (escape)."
// Table 31, Example 4 shows it applied to an invoice number: /10/X.66711\/8824 is "X.66711/8824".
//
// Table 30, field /40/ and field /11/:
//   "The indication with a percentage rate equal to zero defines the default payment date of the
//    invoice (e.g. '0:30' for 30 days net)."
//   "Together with the field /40/0:n, a maturity date of the invoice can be calculated (payable
//    within n days after the voucher date)."
//
// The defects these tests were written against:
//  - MAJOR 1: `swicoVatRate` did `if (rateBp <= 0) continue`, so zero-rated and exempt positions
//    fell OUT of the /32/ figure. With one surviving positive rate it emitted the single-percentage
//    form, which Swico defines as applying to the WHOLE invoiced amount, so a mixed taxed/untaxed
//    invoice declared a VAT that was wrong by the untaxed amount's worth of tax.
//  - MINOR 2: `buildSwicoS1` never escaped "/" or "\".
//  - MINOR 3: /40/ was never emitted, so no eBill partner could derive the due date.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import {
  createDocument,
  issueInvoice,
  buildQrBill,
  buildSwicoS1,
  swicoEscape,
} from '../../dist/core/sales/index.js';

const AT = '2026-07-16T00:00:00.000Z';

const CREDITOR = {
  creditorName: 'Nomadik GmbH',
  address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
  qrIban: 'CH4431999123000889012',
};

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll', mwst_no = 'CHE-102.673.386 MWST' WHERE id = ?")
    .run(workspaceId);
  setCreditorProfile(ctx, CREDITOR);
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'billing@muster.example', 'CHF', 30, ?)`,
    )
    .run(workspaceId, AT);
  return { ctx, store, workspaceId, contactId: 'ct_1' };
}

/** Issue an invoice from `[minorAmount, taxCode]` pairs and return its QR payload elements. */
function issued(ctx, lines, patch = {}) {
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'CHF',
    lines: lines.map(([unitPriceMinor, taxCode], i) => ({ description: `Pos ${i + 1}`, unitPriceMinor, taxCode })),
    ...patch,
  });
  assert.ok(doc.ok, JSON.stringify(doc));
  const res = issueInvoice(ctx, { invoiceId: doc.document.id });
  assert.ok(res.ok, JSON.stringify(res));
  return doc.document.id;
}

/** The `Amt` element and the `StrdBkgInf` element, straight off the emitted payload. */
function payloadParts(ctx, invoiceId) {
  const qr = buildQrBill(ctx, invoiceId);
  assert.ok(qr.ok, JSON.stringify(qr));
  const els = qr.qr.swissQrPayload.split('\r\n');
  return { amt: els[18], strdBkgInf: els[31] ?? null, elements: els };
}

/** Parse the /32/ tag out of a Swico S1 string, or null when the tag is absent. */
function vatTag(strdBkgInf) {
  if (strdBkgInf === null) return null;
  const m = /\/32\/([^/]*)(?:\/|$)/.exec(strdBkgInf);
  return m === null ? null : m[1];
}

/**
 * The Table 30 reconciliation, computed the way a RECIPIENT would.
 *
 *  - List form: sum the stated net amounts, add the VAT each stated rate implies on its stated net,
 *    and require the total to equal the QR `Amt`. Also require the derived VAT to equal the VAT the
 *    books actually posted, so a list that happens to total right with the wrong split still fails.
 *  - Single-percentage form: the rate applies to the WHOLE invoiced amount, so the recipient splits
 *    `Amt` at that rate. The VAT that falls out must be the VAT the books posted.
 *
 * Integer Rappen throughout: exact, never a float comparison.
 */
function reconcile(vat32, amt, actualTaxMinor) {
  const amtMinor = Math.round(Number(amt) * 100);
  if (vat32 === null) return { ok: null, amtMinor, derivedTaxMinor: null, declaredMinor: null };
  if (!vat32.includes(':')) {
    const rateBp = Math.round(Number(vat32) * 100);
    const netMinor = Math.round((amtMinor * 10000) / (10000 + rateBp));
    const derivedTaxMinor = amtMinor - netMinor;
    return { ok: derivedTaxMinor === actualTaxMinor, amtMinor, derivedTaxMinor, declaredMinor: amtMinor };
  }
  let declaredMinor = 0;
  let derivedTaxMinor = 0;
  for (const pair of vat32.split(';')) {
    const [rate, net] = pair.split(':');
    const rateBp = Math.round(Number(rate) * 100);
    const netMinor = Math.round(Number(net) * 100);
    const vatMinor = Math.round((netMinor * rateBp) / 10000);
    declaredMinor += netMinor + vatMinor;
    derivedTaxMinor += vatMinor;
  }
  return {
    ok: declaredMinor === amtMinor && derivedTaxMinor === actualTaxMinor,
    amtMinor,
    derivedTaxMinor,
    declaredMinor,
  };
}

// --- MAJOR 1: the /32/ tag must reconcile to the QR Amt, for EVERY invoice shape ----------------

const SHAPES = [
  ['single positive rate', [[100000, 'UST81']]],
  ['two positive rates', [[100000, 'UST81'], [4550, 'UST26']]],
  ['taxed + zero-rated export', [[100000, 'UST81'], [50000, 'EXPORT0']]],
  ['taxed + exempt', [[100000, 'UST81'], [30000, 'AUSGENOMMEN']]],
  ['the critic mixed case', [[50000, 'EXPORT0'], [30000, 'AUSGENOMMEN'], [100000, 'UST81']]],
  ['two rates + a zero-rated line', [[100000, 'UST81'], [4550, 'UST26'], [50000, 'EXPORT0']]],
  ['only zero-rated', [[50000, 'EXPORT0']]],
  ['only exempt', [[30000, 'AUSGENOMMEN']]],
  ['no tax code at all', [[100000, null]]],
  ['half-Rappen rounding', [[1005, 'UST81'], [1005, 'UST26']]],
  ['many small lines at mixed rates', [[333, 'UST81'], [777, 'UST26'], [111, 'EXPORT0'], [999, 'UST81']]],
];

for (const [label, lines] of SHAPES) {
  test(`MAJOR 1: /32/ reconciles to the QR Amt to the Rappen (${label})`, () => {
    const { ctx, store } = setup();
    const id = issued(ctx, lines);
    const { amt, strdBkgInf } = payloadParts(ctx, id);
    const posted = store.db.prepare('SELECT tax_minor, total_minor FROM document WHERE id = ?').get(id);
    const tag = vatTag(strdBkgInf);
    assert.notEqual(tag, null, `every one of these shapes is statable: ${strdBkgInf}`);
    const r = reconcile(tag, amt, posted.tax_minor);
    assert.equal(
      r.ok,
      true,
      `/32/${tag} declares ${r.declaredMinor} (VAT ${r.derivedTaxMinor}) against Amt ${r.amtMinor} / posted VAT ${posted.tax_minor}`,
    );
    assert.equal(r.amtMinor, posted.total_minor, 'the Amt is the posted gross (B-1 still holds)');
  });
}

test('MAJOR 1: the critic case declares the true VAT, not 8.1% of the whole invoice', () => {
  const ctxStore = setup();
  const { ctx } = ctxStore;
  // EXPORT0 500.00 + AUSGENOMMEN 300.00 + UST81 1000.00 -> Amt 1881.00, true VAT 81.00.
  // The old single-percentage `/32/8.1` implied 8.1% of 1881.00 = 140.94.
  const { store } = ctxStore;
  const id = issued(ctx, [[50000, 'EXPORT0'], [30000, 'AUSGENOMMEN'], [100000, 'UST81']]);
  const { amt, strdBkgInf } = payloadParts(ctx, id);
  assert.equal(amt, '1881.00');
  const tag = vatTag(strdBkgInf);
  assert.notEqual(tag, '8.1', 'the single-percentage form is a lie once untaxed positions exist');
  assert.match(tag, /:/, 'a mixed invoice needs the list form');
  // Every position appears, zero-rated ones included (IG Example 2 puts `0:14` in the list).
  const nets = Object.fromEntries(tag.split(';').map((p) => p.split(':')));
  assert.equal(nets['8.1'], '1000.00');
  assert.equal(nets['0'], '800.00', 'the zero-rated and exempt nets are pooled at rate 0');
  const posted = store.db.prepare('SELECT tax_minor FROM document WHERE id = ?').get(id);
  assert.equal(posted.tax_minor, 8100, 'the true VAT is CHF 81.00, not 8.1% of 1881.00');
  assert.equal(reconcile(tag, amt, posted.tax_minor).ok, true);
});

test('MAJOR 1: an all-one-positive-rate invoice may still use the idiomatic single-percentage form', () => {
  const { ctx } = setup();
  const id = issued(ctx, [[100000, 'UST81']]);
  const { amt, strdBkgInf } = payloadParts(ctx, id);
  assert.equal(amt, '1081.00');
  assert.equal(vatTag(strdBkgInf), '8.1', 'IG Example 1 shape: one rate, whole invoice');
});

test('MAJOR 1: a wholly untaxed invoice states rate 0 over its whole net', () => {
  const { ctx } = setup();
  const id = issued(ctx, [[50000, 'EXPORT0']]);
  const { amt, strdBkgInf } = payloadParts(ctx, id);
  assert.equal(amt, '500.00');
  assert.equal(vatTag(strdBkgInf), '0');
});

// --- MINOR 2: Table 29 escaping ------------------------------------------------------------------

test('MINOR 2: buildSwicoS1 escapes "/" and "\\" in field content (IG Table 29 / Example 4)', () => {
  const s1 = buildSwicoS1({ invoiceNumber: 'X.66711/8824', invoiceDate: '2020-07-12' });
  assert.match(s1, /\/10\/X\.66711\\\/8824\//, 'the IG Example 4 form: /10/X.66711\\/8824');
  // A Swico parser splits on unescaped "/", so the tag must survive the round trip.
  const tag10 = /\/10\/((?:\\.|[^/])*)/.exec(s1)[1];
  assert.equal(swicoEscape('X.66711/8824'), tag10);
  assert.equal(swicoEscape('a\\b'), 'a\\\\b');
  assert.equal(swicoEscape('R-2026-0001'), 'R-2026-0001', 'a clean value is untouched');
});

test('MINOR 2: a D32-shaped number with slashes cannot forge a tag boundary', () => {
  const s1 = buildSwicoS1({ invoiceNumber: 'R/2026/0001', invoiceDate: '2026-07-16' });
  assert.equal(s1.startsWith('//S1/10/R\\/2026\\/0001/11/'), true, s1);
  assert.equal(/\/11\//.test(s1.slice(8)), true, 'the real /11/ tag is still the next boundary');
});

// --- MINOR 3: the /40/ payment condition -------------------------------------------------------

test('MINOR 3: /40/ carries the default payment date derived from due_date (Table 30)', () => {
  const { ctx, store } = setup();
  const id = issued(ctx, [[100000, 'UST81']], { dueDate: '2026-08-15' });
  const row = store.db.prepare('SELECT issue_date, due_date FROM document WHERE id = ?').get(id);
  assert.equal(row.due_date, '2026-08-15');
  const { strdBkgInf } = payloadParts(ctx, id);
  // 2026-07-16 -> 2026-08-15 is 30 days.
  assert.match(strdBkgInf, /\/40\/0:30$/, strdBkgInf);
});

test('MINOR 3: no due date means no /40/ tag (an absent tag beats an invented condition)', () => {
  const { ctx } = setup();
  const id = issued(ctx, [[100000, 'UST81']]);
  const { strdBkgInf } = payloadParts(ctx, id);
  assert.equal(/\/40\//.test(strdBkgInf), false, strdBkgInf);
});

test('MINOR 3: a due date on or before the issue date emits no /40/ rather than a negative term', () => {
  const { ctx } = setup();
  const id = issued(ctx, [[100000, 'UST81']], { dueDate: '2026-07-10' });
  const { strdBkgInf } = payloadParts(ctx, id);
  assert.equal(/\/40\//.test(strdBkgInf), false, strdBkgInf);
});

// --- The budget the /32/ list and the /40/ tag both spend ---------------------------------------

test('the worst realistic Swiss invoice still fits the 140-char AddInf budget (Ustrd + StrdBkgInf)', () => {
  const { ctx } = setup();
  // All four Swiss rate buckets (8.1 normal, 3.8 Beherbergung, 2.6 reduced, 0 export) at amounts
  // near the IG's own ceiling, plus a due date so /40/ is emitted too. This is the largest
  // StrdBkgInf the /32/ list can produce in practice: if a future change (a longer D32 number mask,
  // another rate) pushes it over, this test says so instead of a refused payment part in the field.
  const id = issued(
    ctx,
    [[99999999, 'UST81'], [88888888, 'UST26'], [77777777, 'UST38'], [66666666, 'EXPORT0']],
    { dueDate: '2026-08-15' },
  );
  const { elements, strdBkgInf } = payloadParts(ctx, id);
  const ustrd = elements[29];
  assert.ok(strdBkgInf !== null, 'the tag must still be emitted at this size');
  assert.ok(
    ustrd.length + strdBkgInf.length <= 140,
    `AddInf is ${ustrd.length + strdBkgInf.length} chars: Ustrd ${JSON.stringify(ustrd)} + StrdBkgInf ${strdBkgInf}`,
  );
  assert.equal(strdBkgInf.length <= 140, true, 'StrdBkgInf alone also caps at 140');
});

test('MINOR 3: the /nn/ tags stay in ascending order with /40/ present (IG Table 29 rule)', () => {
  const { ctx } = setup();
  const id = issued(ctx, [[100000, 'UST81'], [4550, 'UST26']], { dueDate: '2026-08-15' });
  const { strdBkgInf } = payloadParts(ctx, id);
  const tags = [...strdBkgInf.matchAll(/\/(\d{2})\//g)].map((m) => Number(m[1]));
  assert.deepEqual(tags, [...tags].sort((a, b) => a - b), strdBkgInf);
  assert.equal(new Set(tags).size, tags.length, 'each tag appears exactly once');
});
