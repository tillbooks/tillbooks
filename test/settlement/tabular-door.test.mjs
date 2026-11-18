// A43 §2 (D205), the table door: a CSV or XLSX export to ONE till-settlement/v1 document that flows unchanged
// through settlement_review and import_settlement, and the per-source table mapping.
// SYNTHETIC BY CONSTRUCTION: every fixture row, id, amount and text is invented (test/settlement/tabular-fixtures/).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { makeAuditPort } from '../../dist/core/ledger/auditLog.js';
import { settingsSet as setSetting } from '../../dist/core/settings/index.js';
import {
  settlementFromTable,
  setSettlementTableMapping,
  getSettlementTableMapping,
  settlementReview,
  importSettlement,
  setSettlementTemplate,
  prevalidateSetSettlementTableMapping,
  prevalidateImportSettlement,
  readTable,
  readTableMapping,
  tableToSettlement,
  TABLE_MAX_ROWS,
  TABLE_COLUMN_FIELDS,
} from '../../dist/core/settlement/index.js';
import { getAction } from '../../dist/api/registry.js';
import { secondWorkspace, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { writeXlsx, writeZip } from '../migration/zipWrite.mjs';
import { handleRest } from '../../dist/api/rest.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { settlementWorld, setTemplate, templateKinds, must, refused, rows, balanceOf, SYSTEM, PROCESSOR } from './support.mjs';

afterEach(assertClaimInvariantHolds);

const fixture = (name) => readFileSync(new URL(`./tabular-fixtures/${name}`, import.meta.url), 'utf8');
const SHOPIFY = fixture('shopify_payments_transactions.csv');
const STRIPE = fixture('stripe_balance_change_itemized.csv');
const GENERIC = fixture('generic.csv');
const src = { system: SYSTEM, processor: PROCESSOR };

/** A person's context with a real audit port, for the settings writes. */
function personCtx(t) {
  return makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: fixedClock('2026-10-05T08:00:00.000Z'), ids: t.ids, audit: makeAuditPort({ store: t.store, workspaceId: t.workspaceId, ids: t.ids }) });
}

const byId = (doc, id) => doc.events.find((e) => e.id === id);

/** A one-sheet workbook of inline strings (numbers as number cells), built in the test. */
function xlsxOf(lines, numericCols = []) {
  const col = (i) => String.fromCharCode(65 + i);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rowsXml = lines
    .map((cells, r) => `<row r="${r + 1}">${cells.map((c, i) => (r > 0 && numericCols.includes(i) && c !== '' ? `<c r="${col(i)}${r + 1}"><v>${c}</v></c>` : `<c r="${col(i)}${r + 1}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`)).join('')}</row>`)
    .join('');
  return Buffer.from(
    writeXlsx({
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
      'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Umsatz" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`,
    }),
  ).toString('base64');
}

const csvLines = (text) => text.trim().split('\n').map((l) => l.split(','));

// --- profiles and the reader ------------------------------------------------------------------------

test('Shopify payouts CSV: the named profile, composed ids (order, type, parsed time), a fee event per row, VAT split from the template', () => {
  const t = settlementWorld();
  setTemplate(t);
  const r = must(settlementFromTable(t.ctx, { ...src, content: SHOPIFY }));
  assert.equal(r.mappingSource, 'profile');
  assert.equal(r.profile.id, 'shopify_payments_transactions');
  assert.equal(r.profile.note, 'check on your own export');
  assert.match(r.profile.docsUrl, /^https:\/\/help\.shopify\.com\//);
  assert.equal(r.container, 'csv');
  assert.equal(r.rowCount, 6);
  assert.deepEqual(r.refusedRows, []);
  const doc = r.settlement;
  assert.equal(doc.schema, 'till-settlement/v1');
  assert.deepEqual(doc.events.map((e) => e.kind), ['sale', 'processing_fee', 'sale', 'processing_fee', 'sale', 'processing_fee', 'refund', 'other', 'bank_payout'], '6 rows + 3 non-zero fees');
  const sales = doc.events.filter((e) => e.kind === 'sale');
  assert.deepEqual(sales.map((e) => [e.amount, e.net, e.vat.amount, e.vat.code]), [
    ['108.10', '100.00', '8.10', 'UST81'],
    ['54.05', '50.00', '4.05', 'UST81'],
    ['54.05', '50.00', '4.05', 'UST81'],
  ]);
  // No transaction id is documented: the order, the type and the transaction time compose one (A43 §2, event identity).
  assert.deepEqual(sales.map((e) => JSON.parse(e.id)), [
    ['#9001', 'charge', '2026-07-03T10:15:00'],
    ['#9002', 'charge', '2026-07-04T14:02:11'],
    ['#9003', 'charge', '2026-07-04T14:02:11'],
  ]);
  assert.deepEqual(JSON.parse(doc.events.find((e) => e.kind === 'bank_payout').id), ['', 'payout', '2026-07-07T06:00:00'], 'a payout has no order: type and time still name it');
  // L1: a fee under the template's INPUT code carries no VAT unless the mapping says vat.fees from_template.
  const fee = byId(doc, `${sales[0].id}:fee`);
  assert.deepEqual([fee.kind, fee.amount, fee.net, fee.vat], ['processing_fee', '-3.24', '-3.24', null]);
  const withFees = must(settlementFromTable(t.ctx, { ...src, content: SHOPIFY, mapping: { ...r.mapping, vat: { mode: 'from_template', fees: 'from_template' } } }));
  const fee2 = byId(withFees.settlement, `${sales[0].id}:fee`);
  assert.deepEqual([fee2.net, fee2.vat.amount], ['-3.00', '-0.24']);
  const refund = doc.events.find((e) => e.kind === 'refund');
  assert.deepEqual([refund.amount, refund.net, refund.vat.amount], ['-21.62', '-20.00', '-1.62']);
  assert.equal(doc.events.find((e) => e.kind === 'bank_payout').amount, '-183.10');
  assert.equal(doc.events.find((e) => e.kind === 'other').vat, null, 'other is not booked with a code: no VAT object');
  assert.equal(r.totals.amountMinor, 0, 'the table states a balance change of 0.00: every Rappen paid out');
  assert.ok(doc.warnings.some((w) => /rounded once to the Rappen/.test(w)), 'the rounding is stated');
});

test('Stripe itemized balance change: the named profile, the balance transaction ids, lower-case currency read', () => {
  const t = settlementWorld();
  setTemplate(t);
  const r = must(settlementFromTable(t.ctx, { ...src, content: STRIPE }));
  assert.equal(r.mappingSource, 'profile');
  assert.equal(r.profile.id, 'stripe_balance_change_itemized');
  assert.match(r.profile.docsUrl, /^https:\/\/docs\.stripe\.com\//);
  const doc = r.settlement;
  assert.deepEqual(doc.events.map((e) => [e.id, e.kind, e.day, e.currency, e.amount]), [
    ['txn_inv0000000001', 'sale', '2026-08-03', 'CHF', '216.20'],
    ['txn_inv0000000001:fee', 'processing_fee', '2026-08-03', 'CHF', '-6.57'],
    ['txn_inv0000000002', 'sale', '2026-08-04', 'CHF', '108.10'],
    ['txn_inv0000000002:fee', 'processing_fee', '2026-08-04', 'CHF', '-3.44'],
    ['txn_inv0000000003', 'refund', '2026-08-10', 'CHF', '-21.62'],
    ['txn_inv0000000004', 'processing_fee', '2026-08-15', 'CHF', '-2.00'],
    ['txn_inv0000000005', 'reserve', '2026-08-20', 'CHF', '-10.00'],
  ]);
});

test('the generic profile: a preamble, ; and a decimal comma, dd.mm.yyyy, guessed from German headers', () => {
  const t = settlementWorld();
  setTemplate(t);
  const r = must(settlementFromTable(t.ctx, { ...src, content: GENERIC }));
  assert.equal(r.mappingSource, 'guessed');
  assert.equal(r.profile.id, 'generic');
  assert.deepEqual(r.mapping.columns, { id: 'Transaktions-ID', day: 'Datum', amount: 'Betrag', kind: 'Typ', fee: 'Gebühr', description: 'Beschreibung' });
  assert.equal(r.mapping.decimalSeparator, ',');
  assert.equal(r.mapping.dateFormat, 'dd.mm.yyyy');
  const doc = r.settlement;
  assert.deepEqual(doc.events.filter((e) => e.kind !== 'processing_fee').map((e) => [e.id, e.kind, e.day, e.amount]), [
    ['K-0001', 'sale', '2026-09-01', '12.50'],
    ['K-0002', 'sale', '2026-09-01', '7.80'],
    ['K-0003', 'refund', '2026-09-02', '-7.80'],
    ['K-0004', 'sale', '2026-09-03', '104.00'],
  ]);
});

test('the same rows as CSV and as XLSX give the same document', () => {
  const t = settlementWorld();
  setTemplate(t);
  const fromCsv = must(settlementFromTable(t.ctx, { ...src, content: STRIPE }));
  // Money as number cells, one of them in an exponent spelling of the same number: read through its shortest
  // decimal text (2.162E2 is 216.2).
  const lines = csvLines(STRIPE).map((cells, r) => (r === 1 ? cells.map((c, i) => (i === 4 ? '2.162E2' : c)) : cells));
  const fromXlsx = must(settlementFromTable(t.ctx, { ...src, contentBase64: xlsxOf(lines, [4, 5, 6]) }));
  assert.equal(fromXlsx.container, 'xlsx');
  assert.deepEqual(fromXlsx.sheets, ['Umsatz']);
  assert.deepEqual(fromXlsx.settlement.events, fromCsv.settlement.events);
  // Float noise (another number than 216.20) is unreadable, never rounded.
  const noisy = csvLines(STRIPE).map((cells, r) => (r === 1 ? cells.map((c, i) => (i === 4 ? '216.20000000000002' : c)) : cells));
  assert.deepEqual(must(settlementFromTable(t.ctx, { ...src, contentBase64: xlsxOf(noisy, [4, 5, 6]) })).refusedRows.map((x) => [x.row, x.code]), [[2, 'unreadable_amount']]);
});

test('an OLE workbook (a legacy .xls) refuses xls_unsupported; neither content nor bytes refuses invalid_input', () => {
  const t = settlementWorld();
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]).toString('base64');
  refused(settlementFromTable(t.ctx, { ...src, contentBase64: ole }), 'xls_unsupported');
  refused(settlementFromTable(t.ctx, { ...src }), 'invalid_input');
});

// The caps are enforced INSIDE the shared reader (`src/core/tabular/`, A20 §13.1): during inflation and in the
// row loop, so neither a small zip bomb nor a huge sheet reaches the door's conversion.
test('table door refuses an over-cap workbook', () => {
  // A synthetic bomb: 41 MiB of spaces deflate to a few KiB, well under the 10 MiB upload cap.
  const bomb = writeZip([
    { name: 'xl/workbook.xml', content: '<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/worksheets/sheet1.xml', content: Buffer.alloc(41 * 1024 * 1024, 0x20), deflate: true },
  ]);
  refused(readTable({ contentBase64: bomb.toString('base64') }), 'table_too_large');
  const lines = [['id', 'date', 'amount'], ...Array.from({ length: TABLE_MAX_ROWS + 1 }, (_, i) => [`r${i}`, '2026-07-01', '1.00'])];
  refused(readTable({ contentBase64: xlsxOf(lines) }), 'table_too_large');
});

test('one CSV row over the cap refuses table_too_large; the cap itself reads', () => {
  const head = 'id,date,amount';
  const row = (i) => `r${i},2026-07-01,1.00`;
  const atCap = [head, ...Array.from({ length: TABLE_MAX_ROWS }, (_, i) => row(i))].join('\n');
  assert.equal(readTable({ content: atCap }).records.length, TABLE_MAX_ROWS);
  refused(readTable({ content: `${atCap}\n${row(TABLE_MAX_ROWS)}` }), 'table_too_large');
});

test('rows: an unreadable amount, an unreadable day, another currency and a total line are refused with their row number', () => {
  const t = settlementWorld();
  setTemplate(t);
  const table = ['id,date,amount,currency', 'a1,2026-07-01,10.00,CHF', 'a2,2026-07-01,10.005,CHF', 'a3,31.31.2026,5.00,CHF', 'a4,2026-07-02,5.00,EUR', ',,15.00,'].join('\n');
  const r = must(settlementFromTable(t.ctx, { ...src, content: table }));
  assert.deepEqual(r.refusedRows.map((x) => [x.row, x.code]), [
    [3, 'unreadable_amount'],
    [4, 'unreadable_day'],
    [5, 'currency_mismatch'],
    [6, 'not_a_movement'],
  ]);
  assert.deepEqual(r.settlement.events.map((e) => e.id), ['a1']);
  assert.ok(r.settlement.warnings.includes('Table row 3 refused: unreadable_amount'));
});

test('a type the kindMap does not name becomes other and is named in the warnings: never a sale by accident', () => {
  const t = settlementWorld();
  setTemplate(t);
  const r = must(settlementFromTable(t.ctx, { ...src, content: 'id,date,amount,type\nb1,2026-07-01,10.00,charge\nb2,2026-07-01,9.00,gift_card' }));
  assert.deepEqual(r.settlement.events.map((e) => e.kind), ['sale', 'other']);
  assert.ok(r.settlement.warnings.some((w) => w.includes('"gift_card"')));
});

// --- end to end through review and import -------------------------------------------------------

test('US-A43.1: the Shopify table books through the template; table totals equal the booked totals; nothing books twice', () => {
  const t = settlementWorld();
  setTemplate(t);
  const before = rows(t.store, t.workspaceId);
  const r = must(settlementFromTable(t.ctx, { ...src, content: SHOPIFY }));
  assert.deepEqual(rows(t.store, t.workspaceId), before, 'settlement_from_table writes nothing');
  const review = must(settlementReview(t.ctx, { ...src, settlement: r.settlement, from: '2026-07-01', to: '2026-07-31' }));
  assert.equal(review.toBook, 7);
  const imp = must(importSettlement(t.ctx, { settlement: r.settlement, expectReviewSha256: review.reviewSha256, idempotencyKey: 'shop-1' }));
  assert.equal(imp.booked, 7);
  assert.equal(imp.refused, 0);
  assert.equal(imp.reconciliation.expectedClearingChangeMinor, r.totals.amountMinor, 'the import reads the balance change the table states');
  assert.equal(imp.reconciliation.unexplainedMinor, 0, 'every Rappen of the table is accounted for');
  // The same table again, under a new key: every event is already imported.
  const again = must(importSettlement(t.ctx, { settlement: must(settlementFromTable(t.ctx, { ...src, content: SHOPIFY })).settlement, idempotencyKey: 'shop-2' }));
  assert.equal(again.booked, 0);
  assert.equal(again.alreadyImported, 7);
  const after = rows(t.store, t.workspaceId);
  assert.equal(after.entries, before.entries + 7);
});

test('US-A43.3: two overlapping exports book every row once; changed money is event_amended', () => {
  const t = settlementWorld();
  setTemplate(t);
  const lines = SHOPIFY.trim().split('\n');
  const first = must(settlementFromTable(t.ctx, { ...src, content: lines.slice(0, 4).join('\n') }));
  must(importSettlement(t.ctx, { settlement: first.settlement, idempotencyKey: 'ov-1' }));
  const extra = '2026-07-08 12:00:00 +0200,charge,#9005,visa,online,pending,2026-07-10,2026-07-10,21.62,0.65,20.97';
  const second = must(settlementFromTable(t.ctx, { ...src, content: [lines[0], ...lines.slice(2), extra].join('\n') }));
  const imp = must(importSettlement(t.ctx, { settlement: second.settlement, idempotencyKey: 'ov-2' }));
  // New: the refund, the new sale and its fee (the adjustment waits for a person, the payout is skipped).
  assert.equal(imp.booked, 3);
  assert.equal(imp.alreadyImported, 4, 'the two overlapping sales and their fees');
  // With an id column (here a composed one), changed money on the same id is event_amended.
  // Another report under the same source: refused until the caller confirms the other id derivation (L2).
  refused(settlementFromTable(t.ctx, { ...src, content: STRIPE }), 'event_id_derivation_changed');
  const stripe = must(settlementFromTable(t.ctx, { ...src, content: STRIPE, confirmIdChange: true }));
  // L2: the import refuses a document minted under a derivation nobody saved; the person saves it, confirmed.
  refused(importSettlement(t.ctx, { settlement: stripe.settlement, idempotencyKey: 'ov-4x' }), 'event_id_derivation_changed');
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: stripe.mapping, headers: stripe.headers, confirmIdChange: true, idempotencyKey: 'ov-map' }));
  must(importSettlement(t.ctx, { settlement: stripe.settlement, idempotencyKey: 'ov-4' }));
  const restated = must(settlementFromTable(t.ctx, { ...src, content: STRIPE.replace('216.20,6.57,209.63', '216.25,6.57,209.68'), mapping: stripe.mapping }));
  const res = must(importSettlement(t.ctx, { settlement: restated.settlement, idempotencyKey: 'ov-5' }));
  assert.equal(res.events.find((e) => e.id === 'txn_inv0000000001').code, 'event_amended');
  assert.equal(res.booked, 0);
});

// --- A43 §2, event identity (the re-cut after two critic FAILs): ids only, composed when needed ---------------

/** A till export: a day, a time, a text and an amount. It has no id column of its own: one is composed. */
const TILL = (rows) => ['Datum;Zeit;Text;Betrag', ...rows].join('\n');
const TILL_MAPPING = { columns: { id: ['Datum', 'Zeit', 'Text'], day: 'Datum', description: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: ',' };
const TILL_NOID = { columns: { day: 'Datum', description: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: ',' };
const TILL_HEADERS = ['Datum', 'Zeit', 'Text', 'Betrag'];

/** The clearing account's balance and the number of entries: what a re-import must never move. */
const books = (t) => ({ entries: rows(t.store, t.workspaceId).entries, clearing: balanceOf(t.store, t.workspaceId, '1095') });

test('an id-less mapping refuses id_column_missing, naming candidate columns and carrying what the mapping step needs', () => {
  const t = settlementWorld();
  const r = refused(settlementFromTable(t.ctx, { ...src, content: TILL(['01.07.2026;09:00;Kaffee;4,50']), mapping: TILL_NOID }), 'id_column_missing');
  assert.deepEqual(r.candidates, ['Datum', 'Text']);
  assert.deepEqual(r.headers, TILL_HEADERS);
  assert.equal(r.rows.length, 1);
  assert.match(r.reason, /compose an id/);
  assert.equal(r.guessedMapping.columns.day, 'Datum');
  // A guessed mapping without an id refuses the same way, and so does a save.
  assert.equal(refused(settlementFromTable(t.ctx, { ...src, content: TILL(['01.07.2026;09:00;Kaffee;4,50']) }), 'id_column_missing').mappingSource, 'guessed');
  refused(setSettlementTableMapping(t.ctx, { ...src, mapping: TILL_NOID, headers: TILL_HEADERS, idempotencyKey: 'noid' }), 'id_column_missing');
});

test('round 1 probe: two files with an equal 29.00 on the same day are refused id-less, and both book under composed ids', () => {
  const t = settlementWorld();
  setTemplate(t);
  refused(settlementFromTable(t.ctx, { ...src, content: TILL(['10.07.2026;09:00;Kaffee;29,00']), mapping: TILL_NOID }), 'id_column_missing');
  const a = must(settlementFromTable(t.ctx, { ...src, content: TILL(['10.07.2026;09:00;Kaffee;29,00']), mapping: TILL_MAPPING }));
  const b = must(settlementFromTable(t.ctx, { ...src, content: TILL(['10.07.2026;16:30;Kaffee;29,00']), mapping: TILL_MAPPING }));
  assert.notEqual(a.settlement.events[0].id, b.settlement.events[0].id);
  must(importSettlement(t.ctx, { settlement: a.settlement, idempotencyKey: 'r1-a' }));
  assert.deepEqual(must(settlementFromTable(t.ctx, { ...src, content: TILL(['10.07.2026;16:30;Kaffee;29,00']), mapping: TILL_MAPPING })).sameAsBooked, []);
  const rb = must(importSettlement(t.ctx, { settlement: b.settlement, idempotencyKey: 'r1-b' }));
  assert.equal(rb.booked, 1, 'the second equal sale books');
  // Shopify: two equal charges of one day in two payout files, other orders.
  const head = SHOPIFY.split('\n')[0];
  const shop = { system: 'shop', processor: 'payments' };
  must(setSettlementTemplate(t.ctx, { ...shop, clearingAccountId: t.acc('1095'), kinds: templateKinds(t), idempotencyKey: 'tpl-shop' }));
  const sa = must(settlementFromTable(t.ctx, { ...shop, content: [head, '2026-07-10 09:00:00 +0200,charge,#9101,visa,online,paid,2026-07-12,2026-07-12,29.00,0.87,28.13'].join('\n') }));
  const sb = must(settlementFromTable(t.ctx, { ...shop, content: [head, '2026-07-10 16:30:00 +0200,charge,#9102,visa,online,paid,2026-07-13,2026-07-13,29.00,0.87,28.13'].join('\n') }));
  assert.equal(must(importSettlement(t.ctx, { settlement: sa.settlement, idempotencyKey: 'r1-sa' })).booked + must(importSettlement(t.ctx, { settlement: sb.settlement, idempotencyKey: 'r1-sb' })).booked, 4);
});

test('round 2 probe: a newest-first re-export of a day with a new 30.00: the 30.00 books, nothing doubles, nothing is lost', () => {
  const t = settlementWorld();
  setTemplate(t);
  const a = must(settlementFromTable(t.ctx, { ...src, content: TILL(['01.09.2026;08:10;Gipfeli;12,50', '01.09.2026;09:20;Brot;7,80']), mapping: TILL_MAPPING }));
  must(importSettlement(t.ctx, { settlement: a.settlement, idempotencyKey: 'r2-a' }));
  const before = books(t);
  const b = must(settlementFromTable(t.ctx, { ...src, content: TILL(['01.09.2026;17:45;Torte;30,00', '01.09.2026;09:20;Brot;7,80', '01.09.2026;08:10;Gipfeli;12,50']), mapping: TILL_MAPPING }));
  assert.deepEqual(b.sameAsBooked.map((x) => x.row), [3, 4]);
  assert.deepEqual(b.sameIdOtherFigures, []);
  const res = must(importSettlement(t.ctx, { settlement: b.settlement, idempotencyKey: 'r2-b' }));
  assert.equal(res.booked, 1);
  assert.equal(res.alreadyImported, 2);
  assert.equal(res.refused, 0);
  const after = books(t);
  assert.equal(after.entries, before.entries + 1);
  assert.equal(after.clearing, before.clearing + 3000, 'exactly the new 30.00 moves the clearing account');
  // The same re-export again: nothing moves.
  must(importSettlement(t.ctx, { settlement: must(settlementFromTable(t.ctx, { ...src, content: TILL(['01.09.2026;17:45;Torte;30,00', '01.09.2026;09:20;Brot;7,80', '01.09.2026;08:10;Gipfeli;12,50']), mapping: TILL_MAPPING })).settlement, idempotencyKey: 'r2-c' }));
  assert.deepEqual(books(t), after);
});

test('a restated amount under its id: same id, other figures; the import refuses event_amended and the booked figure stands', () => {
  const t = settlementWorld();
  setTemplate(t);
  const before = must(settlementFromTable(t.ctx, { ...src, content: TILL(['03.07.2026;10:15;Torte;108,10']), mapping: TILL_MAPPING }));
  must(importSettlement(t.ctx, { settlement: before.settlement, idempotencyKey: 'rs-1' }));
  const held = books(t);
  const after = must(settlementFromTable(t.ctx, { ...src, content: TILL(['03.07.2026;10:15;Torte;108,15']), mapping: TILL_MAPPING }));
  assert.equal(after.settlement.events[0].id, before.settlement.events[0].id);
  assert.deepEqual(after.sameIdOtherFigures, [{ eventId: before.settlement.events[0].id, row: 2 }]);
  assert.deepEqual(after.sameAsBooked, []);
  assert.ok(after.settlement.warnings.some((w) => /other figures/.test(w)));
  const res = must(importSettlement(t.ctx, { settlement: after.settlement, idempotencyKey: 'rs-2' }));
  assert.equal(res.events[0].code, 'event_amended');
  assert.deepEqual(books(t), held);
});

test('the same rows from CSV and from XLSX (a serial date, a numeric document number) compose the same ids', () => {
  const t = settlementWorld();
  const mapping = { columns: { id: ['Datum', 'Beleg'], day: 'Datum', documentNumber: 'Beleg', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' };
  const csv = must(settlementFromTable(t.ctx, { ...src, content: 'Datum;Beleg;Betrag\n01.09.2026;9001;12.50\n02.09.2026;9002;7.80', mapping }));
  // 46266 is 2026-09-01 in the 1900 system; the document numbers are number cells.
  const x = xlsxOf([['Datum', 'Beleg', 'Betrag'], ['46266', '9001', '12.50'], ['46267', '9002', '7.80']], [0, 1, 2]);
  const xlsx = must(settlementFromTable(t.ctx, { ...src, contentBase64: x, mapping }));
  assert.deepEqual(csv.settlement.events.map((e) => e.id), ['["2026-09-01","9001"]', '["2026-09-02","9002"]']);
  assert.deepEqual(xlsx.settlement.events.map((e) => e.id), csv.settlement.events.map((e) => e.id));
});

test('id_not_unique: an id that repeats within one file refuses every row carrying it; the others book', () => {
  const t = settlementWorld();
  setTemplate(t);
  const r = must(settlementFromTable(t.ctx, { ...src, content: TILL(['01.09.2026;08:10;Gipfeli;2,50', '01.09.2026;08:10;Gipfeli;2,50', '01.09.2026;08:11;Gipfeli;2,50']), mapping: TILL_MAPPING }));
  assert.deepEqual(r.refusedRows.map((x) => [x.row, x.code]), [
    [2, 'id_not_unique'],
    [3, 'id_not_unique'],
  ]);
  assert.equal(r.settlement.events.length, 1);
  assert.equal(r.totals.amountMinor, 250, 'the totals are what stays in the document');
  assert.deepEqual(r.rows[0].parsed, { code: 'id_not_unique' });
  assert.equal(must(importSettlement(t.ctx, { settlement: r.settlement, idempotencyKey: 'nu' })).booked, 1);
});

test('kindMap corrected between imports: the ids are unchanged, so the import answers event_amended, never a second booking', () => {
  const t = settlementWorld();
  setTemplate(t);
  const content = 'ID;Datum;Typ;Betrag\nK-1;03.07.2026;Verkauf;54,05';
  const base = { columns: { id: 'ID', day: 'Datum', kind: 'Typ', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: ',' };
  const asSale = must(settlementFromTable(t.ctx, { ...src, content, mapping: { ...base, kindMap: { Verkauf: 'sale' } } }));
  must(importSettlement(t.ctx, { settlement: asSale.settlement, idempotencyKey: 'km-1' }));
  const held = books(t);
  const asRefund = must(settlementFromTable(t.ctx, { ...src, content, mapping: { ...base, kindMap: { Verkauf: 'refund' } } }));
  assert.equal(asRefund.settlement.events[0].id, asSale.settlement.events[0].id);
  const res = must(importSettlement(t.ctx, { settlement: asRefund.settlement, idempotencyKey: 'km-2' }));
  assert.equal(res.events[0].code, 'event_amended');
  assert.deepEqual(books(t), held);
});

test('[INVARIANT] the entry count and the clearing balance are unchanged after any re-import of a booked table', () => {
  const t = settlementWorld();
  setTemplate(t);
  must(importSettlement(t.ctx, { settlement: must(settlementFromTable(t.ctx, { ...src, content: SHOPIFY })).settlement, idempotencyKey: 'inv-0' }));
  const held = books(t);
  const lines = SHOPIFY.trim().split('\n');
  for (const [k, content] of [SHOPIFY, [lines[0], ...lines.slice(1).reverse()].join('\n'), [lines[0], lines[3], lines[1]].join('\n')].entries()) {
    must(importSettlement(t.ctx, { settlement: must(settlementFromTable(t.ctx, { ...src, content })).settlement, idempotencyKey: `inv-${k + 1}` }));
    assert.deepEqual(books(t), held, `re-import ${k + 1}`);
  }
});

test('a composed id with every part blank refuses missing_id; one blank part still names the row', () => {
  const t = settlementWorld();
  const mapping = { columns: { id: ['Order', 'Type'], day: 'Date', amount: 'Amount' } };
  const r = must(settlementFromTable(t.ctx, { ...src, content: 'Order,Type,Date,Amount\n#1,charge,2026-07-01,1.00\n,,2026-07-01,2.00\n,payout,2026-07-01,-3.00', mapping }));
  assert.deepEqual(r.settlement.events.map((e) => e.id), ['["#1","charge"]', '["","payout"]']);
  assert.deepEqual(r.refusedRows.map((x) => [x.row, x.code]), [[3, 'missing_id']]);
});

test('a composed id is injective: ("a|b", "c") and ("a", "b|c") are two events; a pipe, a colon or a quote in a cell stays inside its part', () => {
  const t = settlementWorld();
  setTemplate(t);
  const mapping = { columns: { id: ['A', 'B'], day: 'Date', amount: 'Amount' } };
  const r = must(settlementFromTable(t.ctx, { ...src, content: 'A;B;Date;Amount\na|b;c;2026-07-01;1.00\na;b|c;2026-07-01;2.00\nx:1;"y""z";2026-07-01;3.00', mapping }));
  const ids = r.settlement.events.map((e) => e.id);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(ids.map((id) => JSON.parse(id)), [['a|b', 'c'], ['a', 'b|c'], ['x:1', 'y"z']]);
  assert.equal(must(importSettlement(t.ctx, { settlement: r.settlement, idempotencyKey: 'inj' })).booked, 3, 'no collision: every row books');
});

// --- re-critic round 3: the id spec is the chokepoint, so every mapping field is either id-neutral or guarded ---

test('round 3 probe: the id [nr, date] under dd/mm/yyyy; saving mm/dd/yyyy needs a confirm, and a given one is refused', () => {
  const t = settlementWorld();
  setTemplate(t);
  const content = 'nr,date,amount\nA1,03/04/2026,12.50';
  const dmy = { columns: { id: ['nr', 'date'], day: 'date', amount: 'amount' }, dateFormat: 'dd/mm/yyyy' };
  const mdy = { ...dmy, dateFormat: 'mm/dd/yyyy' };
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: dmy, headers: ['nr', 'date', 'amount'], idempotencyKey: 'r3-0' }));
  const first = must(settlementFromTable(t.ctx, { ...src, content }));
  assert.equal(first.settlement.events[0].id, '["A1","2026-04-03"]');
  must(importSettlement(t.ctx, { settlement: first.settlement, idempotencyKey: 'r3-i' }));
  const held = books(t);
  const save = refused(setSettlementTableMapping(t.ctx, { ...src, mapping: mdy, headers: ['nr', 'date', 'amount'], idempotencyKey: 'r3-1' }), 'event_id_derivation_changed');
  assert.deepEqual(save.changed, ['id_recipe']);
  refused(settlementFromTable(t.ctx, { ...src, content, mapping: mdy }), 'event_id_derivation_changed');
  assert.deepEqual(books(t), held, 'the clearing account still holds the one 12.50');
});

test('round 3 walk: every mapping field, changed alone on a source with booked events, keeps the ids byte-identical or is refused', () => {
  const content = 'nr,date,amount,fee,text,type,who,doc,payout,cur,vat,net,rate\nÄ1,03/04/2026,12.50,0.30,Torte,sale,Ida,R-1,P-1,CHF,0.94,11.56,8.1\nA2,04/04/2026,7.80,0.20,Brot,sale,Max,R-2,P-1,CHF,0.58,7.22,8.1';
  const bytes = Buffer.from(content, 'utf8').toString('base64');
  const headers = ['nr', 'date', 'amount', 'fee', 'text', 'type', 'who', 'doc', 'payout', 'cur', 'vat', 'net', 'rate'];
  const base = {
    columns: { id: ['nr', 'date', 'amount'], day: 'date', amount: 'amount', fee: 'fee', description: 'text', kind: 'type', counterparty: 'who', documentNumber: 'doc', payoutId: 'payout', currency: 'cur', vat: 'vat', net: 'net', vatRate: 'rate' },
    kindMap: { sale: 'sale' },
    kindDefault: { positive: 'sale', negative: 'refund' },
    vat: { mode: 'from_template', fees: 'none' },
    dateFormat: 'dd/mm/yyyy',
    decimalSeparator: '.',
    feeSign: 'deducted',
    amountSign: 'as_stated',
  };
  const withCols = (patch) => ({ ...base, columns: { ...base.columns, ...patch } });
  const without = (field) => {
    const columns = { ...base.columns };
    delete columns[field];
    return { ...base, columns };
  };
  /** One variant per field (a column re-pointed or dropped, a value changed), each changing that field ALONE. */
  const variants = {
    'columns.id': [withCols({ id: ['nr', 'date'] }), withCols({ id: ['date', 'nr', 'amount'] }), withCols({ id: 'nr' })],
    'columns.day': [withCols({ day: 'text' })],
    'columns.amount': [withCols({ amount: 'net' })],
    'columns.kind': [without('kind')],
    'columns.net': [without('net')],
    'columns.vat': [without('vat')],
    'columns.vatRate': [without('vatRate')],
    'columns.fee': [without('fee'), withCols({ fee: 'vat' })],
    'columns.counterparty': [without('counterparty')],
    'columns.description': [without('description')],
    'columns.documentNumber': [without('documentNumber')],
    'columns.payoutId': [without('payoutId')],
    'columns.currency': [without('currency')],
    kindMap: [{ ...base, kindMap: { sale: 'refund' } }],
    kindDefault: [{ ...base, kindDefault: { positive: 'other', negative: 'other' } }],
    'vat.mode': [{ ...base, vat: { mode: 'stated', fees: 'none' } }, { ...base, vat: { mode: 'none', fees: 'none' } }],
    'vat.fees': [{ ...base, vat: { mode: 'from_template', fees: 'from_template' } }],
    dateFormat: [{ ...base, dateFormat: 'mm/dd/yyyy' }],
    decimalSeparator: [{ ...base, decimalSeparator: ',' }],
    feeSign: [{ ...base, feeSign: 'signed' }],
    amountSign: [{ ...base, amountSign: 'by_kind' }],
    idDayPrecision: [{ ...base, idDayPrecision: 'second' }],
    // D206: the whole-day flag. With an id column it changes no id; with the payout id mapped it refuses.
    wholeDays: [{ ...base, wholeDays: true }, { ...without('payoutId'), wholeDays: true }],
    delimiter: [{ ...base, delimiter: 'semicolon' }],
    encoding: [{ ...base, encoding: 'windows-1252' }],
    headerRow: [{ ...base, headerRow: 2 }],
  };
  // The walk covers EVERY field the mapping has: a new field without a variant fails here first.
  const stored = must(settlementFromTable(settlementWorld().ctx, { ...src, contentBase64: bytes, mapping: base })).mapping;
  const fields = [
    ...Object.keys(stored).filter((k) => !['columns', 'vat', 'idScheme'].includes(k)),
    ...TABLE_COLUMN_FIELDS.map((f) => `columns.${f}`),
    ...Object.keys(stored.vat).map((k) => `vat.${k}`),
    'delimiter',
    'encoding',
    'headerRow',
  ];
  for (const f of new Set(fields)) assert.ok(variants[f] !== undefined, `the walk has no variant for the mapping field ${f}`);

  for (const [field, list] of Object.entries(variants)) {
    for (const [k, variant] of list.entries()) {
      const t = settlementWorld();
      setTemplate(t);
      must(setSettlementTableMapping(t.ctx, { ...src, mapping: base, headers, idempotencyKey: 'w-0' }));
      const booked = must(settlementFromTable(t.ctx, { ...src, contentBase64: bytes }));
      must(importSettlement(t.ctx, { settlement: booked.settlement, idempotencyKey: 'w-i' }));
      const before = booked.settlement.events.map((e) => e.id);
      const label = `${field} #${k}`;
      const read = settlementFromTable(t.ctx, { ...src, contentBase64: bytes, mapping: variant, confirmIdChange: true });
      const after = read.ok === true ? read.settlement.events.map((e) => e.id) : null;
      // An id the booked table never minted, for the same rows, is what can book the same money twice. Fewer events
      // (a fee column dropped) mint nothing new.
      const fresh = after === null ? [] : after.filter((id) => !before.includes(id));
      const save = setSettlementTableMapping(t.ctx, { ...src, mapping: variant, headers, idempotencyKey: `w-${field}-${k}` });
      if (fresh.length > 0) {
        assert.equal(save.ok, false, `${label}: the ids change (${JSON.stringify(after)}) but the save went through`);
        assert.equal(save.error, 'event_id_derivation_changed', `${label}: ${JSON.stringify(save)}`);
        assert.equal(settlementFromTable(t.ctx, { ...src, contentBase64: bytes, mapping: variant }).error, 'event_id_derivation_changed', `${label}: a given mapping with other ids is refused`);
      }
      if (save.ok === true) {
        // Whatever was saved, booking the same table again books nothing twice.
        const again = settlementFromTable(t.ctx, { ...src, contentBase64: bytes });
        if (again.ok === true) {
          const held = books(t);
          must(importSettlement(t.ctx, { settlement: again.settlement, idempotencyKey: `w-again-${field}-${k}` }));
          const now = books(t);
          assert.equal(now.entries, held.entries, `${label}: the same table booked again after an unconfirmed save`);
        }
      }
    }
  }
});

test('L1: two partial refunds of one order on one day, at different times, book separately under idDayPrecision second', () => {
  const t = settlementWorld();
  setTemplate(t);
  const head = SHOPIFY.split('\n')[0];
  const content = [
    head,
    '2026-07-05 09:30:00 +0200,refund,#9001,visa,online,paid,2026-07-07,2026-07-07,-10.81,0.00,-10.81',
    '2026-07-05 16:45:30 +0200,refund,#9001,visa,online,paid,2026-07-07,2026-07-07,-10.81,0.00,-10.81',
  ].join('\n');
  const r = must(settlementFromTable(t.ctx, { ...src, content }));
  assert.equal(r.mapping.idDayPrecision, 'second');
  assert.deepEqual(r.settlement.events.map((e) => JSON.parse(e.id)), [
    ['#9001', 'refund', '2026-07-05T09:30:00'],
    ['#9001', 'refund', '2026-07-05T16:45:30'],
  ]);
  assert.equal(must(importSettlement(t.ctx, { settlement: r.settlement, idempotencyKey: 'pr' })).booked, 2);
  // By the day alone the two are one id: refused id_not_unique, loud, never one swallowed.
  const byDay = must(settlementFromTable(t.ctx, { system: 'x', processor: 'y', content, mapping: { ...r.mapping, idDayPrecision: 'day' } }));
  assert.deepEqual(byDay.refusedRows.map((x) => x.code), ['id_not_unique', 'id_not_unique']);
});

test('L1: the same rows from CSV and from XLSX (a serial with a time fraction, a text time) compose the same second-precision ids', () => {
  const t = settlementWorld();
  const mapping = { columns: { id: ['Beleg', 'Zeit'], day: 'Zeit', amount: 'Betrag' }, dateFormat: 'yyyy-mm-dd', idDayPrecision: 'second' };
  const csv = must(settlementFromTable(t.ctx, { ...src, content: 'Beleg;Zeit;Betrag\nK-1;2026-09-01 10:15:00;12.50\nK-2;2026-09-01T16:30:05Z;7.80', mapping }));
  assert.deepEqual(csv.settlement.events.map((e) => JSON.parse(e.id)), [
    ['K-1', '2026-09-01T10:15:00'],
    ['K-2', '2026-09-01T16:30:05'],
  ]);
  // 46266 is 2026-09-01; 10:15:00 is 0.42708333... of a day, rounded to the second. The second row is a text cell.
  const serial = String(46266 + (10 * 3600 + 15 * 60) / 86400);
  // The serial row as a number cell, the text row as text: the kinds the reader answers per cell.
  const t2 = tableToSettlement(t.ctx, {
    container: 'xlsx',
    headers: ['Beleg', 'Zeit', 'Betrag'],
    records: [
      { Beleg: 'K-1', Zeit: serial, Betrag: '12.5' },
      { Beleg: 'K-2', Zeit: '2026-09-01T16:30:05Z', Betrag: '7.8' },
    ],
    rowNumbers: [2, 3],
    sheets: ['Umsatz'],
    sheet: 'Umsatz',
    kinds: [
      { Beleg: 'text', Zeit: 'number', Betrag: 'number' },
      { Beleg: 'text', Zeit: 'text', Betrag: 'number' },
    ],
    warnings: [],
  }, readTableMapping(mapping), src, null);
  assert.deepEqual(t2.document.events.map((e) => e.id), csv.settlement.events.map((e) => e.id));
  // A workbook DATE cell carries no time: under second it refuses id_time_unknown, never an id without the time.
  const dated = tableToSettlement(t.ctx, {
    container: 'xlsx',
    headers: ['Beleg', 'Zeit', 'Betrag'],
    records: [{ Beleg: 'K-1', Zeit: '2026-09-01', Betrag: '12.5' }],
    rowNumbers: [2],
    sheets: ['Umsatz'],
    sheet: 'Umsatz',
    kinds: [{ Beleg: 'text', Zeit: 'date', Betrag: 'number' }],
    warnings: [],
  }, readTableMapping(mapping), src, null);
  assert.deepEqual(dated.refusedRows.map((r) => r.code), ['id_time_unknown']);
});

test('L2: only a person confirms an id change on the read, and an import never books under a derivation nobody saved', () => {
  const t = settlementWorld();
  setTemplate(t);
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: TILL_MAPPING, headers: TILL_HEADERS, idempotencyKey: 'l2-0' }));
  must(importSettlement(t.ctx, { settlement: must(settlementFromTable(t.ctx, { ...src, content: TILL(['03.07.2026;10:15;Torte;108,10']) })).settlement, idempotencyKey: 'l2-i' }));
  const agent = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: fixedClock('2026-10-05T08:00:00.000Z'), ids: t.ids });
  const read = { ...src, content: TILL(['03.07.2026;10:15;Torte;108,10']), mapping: TILL_OTHER_ID, confirmIdChange: true };
  refused(settlementFromTable(agent, read), 'person_decides');
  // A person reads it confirmed, but has not saved the mapping: the import (and an agent's Vorschlag of it) refuses.
  const doc = must(settlementFromTable(t.ctx, read)).settlement;
  const held = books(t);
  refused(importSettlement(t.ctx, { settlement: doc, idempotencyKey: 'l2-x' }), 'event_id_derivation_changed');
  assert.equal(prevalidateImportSettlement(agent, { settlement: doc, idempotencyKey: 'l2-ag' })?.error, 'event_id_derivation_changed', 'an agent draft never hides an id change');
  assert.deepEqual(books(t), held);
  // Saved with the person's confirmation, the new derivation is the source's: the import books under it.
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: TILL_OTHER_ID, headers: TILL_HEADERS, confirmIdChange: true, idempotencyKey: 'l2-1' }));
  must(importSettlement(t.ctx, { settlement: doc, idempotencyKey: 'l2-ok' }));
  // A plain JSON file (no table recipe) is never held by this check.
  must(importSettlement(t.ctx, { settlement: { schema: 'till-settlement/v1', source: { system: SYSTEM, processor: PROCESSOR }, events: [] }, idempotencyKey: 'l2-json' }));
});

test('round 4, L1: a UTF-8 id read under a forced windows-1252: saving utf-8 back needs a confirm, nothing books twice', () => {
  const t = settlementWorld();
  setTemplate(t);
  const bytes = Buffer.from('Kunde,Datum,Betrag\nMüller,2026-07-01,12.50', 'utf8').toString('base64');
  const latin = { columns: { id: ['Kunde', 'Datum'], day: 'Datum', amount: 'Betrag' }, encoding: 'windows-1252' };
  const utf8 = { ...latin, encoding: 'utf-8' };
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: latin, headers: ['Kunde', 'Datum', 'Betrag'], idempotencyKey: 'enc-0' }));
  const first = must(settlementFromTable(t.ctx, { ...src, contentBase64: bytes }));
  assert.equal(JSON.parse(first.settlement.events[0].id)[0], 'MÃ¼ller');
  must(importSettlement(t.ctx, { settlement: first.settlement, idempotencyKey: 'enc-i' }));
  const held = books(t);
  refused(setSettlementTableMapping(t.ctx, { ...src, mapping: utf8, headers: ['Kunde', 'Datum', 'Betrag'], idempotencyKey: 'enc-1' }), 'event_id_derivation_changed');
  refused(settlementFromTable(t.ctx, { ...src, contentBase64: bytes, mapping: utf8 }), 'event_id_derivation_changed');
  assert.deepEqual(books(t), held);
});

test('round 4, L3: a text id part that a workbook holds as a number cell is warned', () => {
  const t = settlementWorld();
  const mapping = readTableMapping({ columns: { id: ['Beleg', 'Datum'], day: 'Datum', amount: 'Betrag' } });
  const conv = tableToSettlement(t.ctx, {
    container: 'xlsx',
    headers: ['Beleg', 'Datum', 'Betrag'],
    records: [{ Beleg: '123', Datum: '2026-07-01', Betrag: '1.5' }],
    rowNumbers: [2],
    sheets: ['Umsatz'],
    sheet: 'Umsatz',
    kinds: [{ Beleg: 'number', Datum: 'date', Betrag: 'number' }],
    warnings: [],
  }, mapping, src, null);
  assert.deepEqual(conv.idTextAsNumber, ['Beleg']);
  assert.ok(conv.warnings.some((w) => /Excel turned the id column "Beleg" into a number/.test(w)));
  const asText = tableToSettlement(t.ctx, {
    container: 'xlsx',
    headers: ['Beleg', 'Datum', 'Betrag'],
    records: [{ Beleg: '00123', Datum: '2026-07-01', Betrag: '1.5' }],
    rowNumbers: [2],
    sheets: ['Umsatz'],
    sheet: 'Umsatz',
    kinds: [{ Beleg: 'text', Datum: 'date', Betrag: 'number' }],
    warnings: [],
  }, mapping, src, null);
  assert.deepEqual(asText.idTextAsNumber, []);
});

test('round 4, L4: id_time_unknown names the way out', () => {
  const t = settlementWorld();
  const conv = tableToSettlement(t.ctx, {
    container: 'xlsx',
    headers: ['Beleg', 'Zeit', 'Betrag'],
    records: [{ Beleg: 'K-1', Zeit: '2026-09-01', Betrag: '12.5' }],
    rowNumbers: [2],
    sheets: ['Umsatz'],
    sheet: 'Umsatz',
    kinds: [{ Beleg: 'text', Zeit: 'date', Betrag: 'number' }],
    warnings: [],
  }, readTableMapping({ columns: { id: ['Beleg', 'Zeit'], day: 'Zeit', amount: 'Betrag' }, idDayPrecision: 'second' }), src, null);
  assert.match(conv.refusedRows[0].reason, /export the table as CSV, or format the column as text in Excel/);
});

// --- A43 §2, event identity (critic M1): the derivation is frozen once it booked ------------------------

const TILL_OTHER_ID = { ...TILL_MAPPING, columns: { ...TILL_MAPPING.columns, id: ['Datum', 'Zeit'] } };

test('M1: after events are booked, a changed id recipe or header set refuses event_id_derivation_changed; the confirmed change is audited', () => {
  const t = settlementWorld();
  setTemplate(t);
  const p = personCtx(t);
  const table = TILL(['03.07.2026;10:15;Torte;108,10']);
  // Before anything is booked a mapping changes freely.
  must(setSettlementTableMapping(p, { ...src, mapping: TILL_MAPPING, headers: TILL_HEADERS, idempotencyKey: 'd-0' }));
  must(setSettlementTableMapping(p, { ...src, mapping: TILL_OTHER_ID, headers: TILL_HEADERS, idempotencyKey: 'd-1' }));
  must(setSettlementTableMapping(p, { ...src, mapping: TILL_MAPPING, headers: TILL_HEADERS, idempotencyKey: 'd-2' }));
  must(importSettlement(p, { settlement: must(settlementFromTable(p, { ...src, content: table })).settlement, idempotencyKey: 'd-imp' }));
  // A field outside the id recipe still changes freely.
  must(setSettlementTableMapping(p, { ...src, mapping: { ...TILL_MAPPING, amountSign: 'by_kind' }, headers: TILL_HEADERS, idempotencyKey: 'd-3' }));
  const recipe = refused(setSettlementTableMapping(p, { ...src, mapping: TILL_OTHER_ID, headers: TILL_HEADERS, idempotencyKey: 'd-4' }), 'event_id_derivation_changed');
  assert.deepEqual(recipe.changed, ['id_recipe']);
  assert.equal(recipe.bookedEvents, 1);
  // The day column moved: another recipe too (the day part is the parsed day of THAT column).
  refused(setSettlementTableMapping(p, { ...src, mapping: { ...TILL_MAPPING, columns: { ...TILL_MAPPING.columns, day: 'Zeit' } }, headers: TILL_HEADERS, idempotencyKey: 'd-5' }), 'event_id_derivation_changed');
  const hd = refused(setSettlementTableMapping(p, { ...src, mapping: TILL_MAPPING, headers: [...TILL_HEADERS, 'Kasse'], idempotencyKey: 'd-6' }), 'event_id_derivation_changed');
  assert.deepEqual(hd.changed, ['headers']);
  assert.equal(prevalidateSetSettlementTableMapping(p, { ...src, mapping: TILL_MAPPING, headers: [...TILL_HEADERS, 'Kasse'], idempotencyKey: 'd-7' })?.error, 'event_id_derivation_changed');
  const ok1 = must(setSettlementTableMapping(p, { ...src, mapping: TILL_OTHER_ID, headers: TILL_HEADERS, confirmIdChange: true, reason: 'Zeit genügt', idempotencyKey: 'd-8' }));
  assert.equal(ok1.changed, true);
  const last = t.store.db.prepare('SELECT new_json FROM settlement_table_mapping_change WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 1').get(t.workspaceId);
  assert.deepEqual(JSON.parse(last.new_json).idChangeConfirmed, ['id_recipe']);
  assert.equal(JSON.parse(last.new_json).reason, 'Zeit genügt');
  const audit = t.store.db.prepare("SELECT action FROM audit_log WHERE workspace_id = ? AND entity_kind = 'settlement_table_mapping' ORDER BY rowid").all(t.workspaceId).map((r) => r.action);
  assert.equal(audit.filter((a) => a === 'confirm_id_change').length, 1);
});

test('M1: a saved mapping of an older id scheme meets event_id_derivation_changed while events are booked, on read and on save', () => {
  const t = settlementWorld();
  setTemplate(t);
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: TILL_MAPPING, headers: TILL_HEADERS, idempotencyKey: 'v-0' }));
  must(importSettlement(t.ctx, { settlement: must(settlementFromTable(t.ctx, { ...src, content: TILL(['03.07.2026;10:15;Torte;108,10']) })).settlement, idempotencyKey: 'v-imp' }));
  // As if this mapping had been saved by a TILL that derived ids by scheme 2 (the signature build).
  const row = t.store.db.prepare('SELECT id, mapping_json FROM settlement_table_mapping WHERE workspace_id = ?').get(t.workspaceId);
  t.store.db.prepare('UPDATE settlement_table_mapping SET mapping_json = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.mapping_json), idScheme: 2 }), row.id);
  const read = refused(settlementFromTable(t.ctx, { ...src, content: TILL(['03.07.2026;10:15;Torte;108,10']) }), 'event_id_derivation_changed');
  assert.deepEqual(read.changed, ['id_scheme']);
  const save = refused(setSettlementTableMapping(t.ctx, { ...src, mapping: TILL_MAPPING, headers: TILL_HEADERS, idempotencyKey: 'v-1' }), 'event_id_derivation_changed');
  assert.deepEqual(save.changed, ['id_recipe']);
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: TILL_MAPPING, headers: TILL_HEADERS, confirmIdChange: true, idempotencyKey: 'v-2' }));
  assert.equal(must(settlementFromTable(t.ctx, { ...src, content: TILL(['03.07.2026;10:15;Torte;108,10']) })).mapping.idScheme, 5);
});

test('M2: a given mapping is always compared with the saved one: savedHeadersDiffer, idRecipeDiffers, bookedEvents', () => {
  const t = settlementWorld();
  setTemplate(t);
  const first = must(settlementFromTable(t.ctx, { ...src, content: SHOPIFY }));
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: first.mapping, headers: first.headers, idempotencyKey: 'g-0' }));
  must(importSettlement(t.ctx, { settlement: first.settlement, idempotencyKey: 'g-imp' }));
  const stripeGuess = must(settlementFromTable(t.ctx, { system: 'x', processor: 'y', content: STRIPE })).mapping;
  // L2: a given mapping that derives ids otherwise than the saved one is refused while events are booked.
  const refusal = refused(settlementFromTable(t.ctx, { ...src, content: STRIPE, mapping: stripeGuess }), 'event_id_derivation_changed');
  assert.equal(refusal.bookedEvents, 7);
  const given = must(settlementFromTable(t.ctx, { ...src, content: STRIPE, mapping: stripeGuess, confirmIdChange: true }));
  assert.equal(given.mappingSource, 'given');
  assert.equal(given.savedMapping, true);
  assert.ok(given.savedHeadersDiffer.missing.includes('Transaction Date'));
  assert.ok(given.savedHeadersDiffer.added.includes('balance_transaction_id'));
  assert.equal(given.idRecipeDiffers, true);
  assert.equal(given.bookedEvents, 7);
  // The same report with its saved mapping given back: nothing differs.
  const same = must(settlementFromTable(t.ctx, { ...src, content: SHOPIFY, mapping: first.mapping }));
  assert.equal(same.savedHeadersDiffer, null);
  assert.equal(same.idRecipeDiffers, false);
  // Saving the other report's mapping through the verb needs the override.
  refused(setSettlementTableMapping(t.ctx, { ...src, mapping: stripeGuess, headers: given.headers, idempotencyKey: 'g-1' }), 'event_id_derivation_changed');
});

test('re-cut round 2, L1: a governed seat never executes a confirmed id change itself; it proposes, a person confirms', () => {
  const t = settlementWorld();
  setTemplate(t);
  const headers = TILL_HEADERS;
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: TILL_MAPPING, headers, idempotencyKey: 'l1-0' }));
  must(importSettlement(t.ctx, { settlement: must(settlementFromTable(t.ctx, { ...src, content: TILL(['03.07.2026;10:15;Torte;108,10']) })).settlement, idempotencyKey: 'l1-imp' }));
  const agent = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: fixedClock('2026-10-05T08:00:00.000Z'), ids: t.ids });
  const changed = { ...src, mapping: TILL_OTHER_ID, headers, confirmIdChange: true, idempotencyKey: 'l1-a' };
  // The draft check lets the proposal through (the gate drafts a Vorschlag) ...
  assert.equal(prevalidateSetSettlementTableMapping(agent, changed), undefined);
  // ... but a governed seat executing it is refused, and nothing changed.
  refused(setSettlementTableMapping(agent, changed), 'person_decides');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM settlement_table_mapping_change WHERE workspace_id = ?').get(t.workspaceId).n, 1);
  // A mapping save that changes no id derivation stays open to the agent.
  must(setSettlementTableMapping(agent, { ...src, mapping: { ...TILL_MAPPING, amountSign: 'by_kind' }, headers, idempotencyKey: 'l1-b' }));
  // The person confirms.
  must(setSettlementTableMapping(t.ctx, { ...changed, idempotencyKey: 'l1-p' }));
});

test('re-cut round 2, L3: events booked through a profile with no mapping saved: the first save and a given mapping are checked against their recipe', () => {
  const t = settlementWorld();
  setTemplate(t);
  const imported = must(settlementFromTable(t.ctx, { ...src, content: GENERIC }));
  assert.equal(imported.mappingSource, 'guessed');
  must(importSettlement(t.ctx, { settlement: imported.settlement, idempotencyKey: 'l3-imp' }));
  // Every booked table event keeps the hash of the recipe that minted its id.
  const kept = t.store.db.prepare("SELECT DISTINCT json_extract(refs_json, '$.tableIdRecipe') AS r FROM settlement_event WHERE workspace_id = ?").all(t.workspaceId);
  assert.equal(kept.length, 1);
  // A first save with another id recipe refuses; the same recipe saves.
  const other = { ...imported.mapping, columns: { ...imported.mapping.columns, id: ['Datum', 'Transaktions-ID'] } };
  refused(setSettlementTableMapping(t.ctx, { ...src, mapping: other, headers: imported.headers, idempotencyKey: 'l3-0' }), 'event_id_derivation_changed');
  refused(settlementFromTable(t.ctx, { ...src, content: GENERIC, mapping: other }), 'event_id_derivation_changed');
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: imported.mapping, headers: imported.headers, idempotencyKey: 'l3-1' }));
  // Read again through the saved mapping: the same ids, already booked.
  const again = must(importSettlement(t.ctx, { settlement: must(settlementFromTable(t.ctx, { ...src, content: GENERIC })).settlement, idempotencyKey: 'l3-imp2' }));
  assert.equal(again.booked, 0);
});

test('M1: a source that also has a settlement feed is warned about the second id space', () => {
  const t = settlementWorld();
  t.store.db
    .prepare("INSERT INTO settlement_source (id, workspace_id, source_system, source_processor, base_url, from_date, token_ref, updated_by, updated_at) VALUES ('stlsrc_t', ?, 'kurswerk', 'zahlfix', 'https://kurswerk.example', '2026-01-01', NULL, 'user_1', '2026-10-05T08:00:00.000Z')")
    .run(t.workspaceId);
  const r = must(settlementFromTable(t.ctx, { ...src, content: STRIPE }));
  assert.equal(r.feedSaved, true);
  assert.ok(r.settlement.warnings.some((w) => /also has a settlement feed/.test(w)));
  assert.equal(must(settlementFromTable(t.ctx, { system: 'other', processor: 'source', content: STRIPE })).feedSaved, false);
});

// --- critic M3: tests that bite (each names the mutation it catches) -------------------------------------

test('M3 bites "stated VAT is split wrong": the vat column gives net = amount - vat, the net column vat = amount - net, and both book', () => {
  const t = settlementWorld();
  setTemplate(t);
  const content = 'ID;Datum;Betrag;MWST;Netto\nS1;03.07.2026;108,10;8,10;\nS2;04.07.2026;54,05;;50,00\nS3;05.07.2026;-21,62;-1,62;';
  const r = must(settlementFromTable(t.ctx, { ...src, content, mapping: { columns: { id: 'ID', day: 'Datum', amount: 'Betrag', vat: 'MWST', net: 'Netto' }, vat: { mode: 'stated' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: ',', kindDefault: { positive: 'sale', negative: 'refund' } } }));
  assert.deepEqual(r.settlement.events.map((e) => [e.id, e.kind, e.amount, e.net, e.vat.amount]), [
    ['S1', 'sale', '108.10', '100.00', '8.10'],
    ['S2', 'sale', '54.05', '50.00', '4.05'],
    ['S3', 'refund', '-21.62', '-20.00', '-1.62'],
  ]);
  assert.equal(must(importSettlement(t.ctx, { settlement: r.settlement, idempotencyKey: 'st' })).booked, 3);
});

test('M3 bites "amountSign by_kind is ignored": a POSITIVE refund cell becomes money out, its VAT negative too', () => {
  const t = settlementWorld();
  setTemplate(t);
  const content = 'ID;Typ;Datum;Betrag\nR1;Rückerstattung;03.07.2026;21,62\nS1;Verkauf;03.07.2026;54,05';
  const mapping = { columns: { id: 'ID', kind: 'Typ', day: 'Datum', amount: 'Betrag' }, kindMap: { Rückerstattung: 'refund', Verkauf: 'sale' }, amountSign: 'by_kind', dateFormat: 'dd.mm.yyyy', decimalSeparator: ',' };
  const r = must(settlementFromTable(t.ctx, { ...src, content, mapping }));
  assert.deepEqual(r.settlement.events.map((e) => [e.id, e.amount, e.net, e.vat.amount]), [
    ['R1', '-21.62', '-20.00', '-1.62'],
    ['S1', '54.05', '50.00', '4.05'],
  ]);
  const asStated = must(settlementFromTable(t.ctx, { ...src, content, mapping: { ...mapping, amountSign: 'as_stated' } }));
  assert.equal(asStated.settlement.events[0].amount, '21.62', 'the default reads the sign as written');
});

test('M3 bites "feeSign is ignored or inverted": signed takes the cell as the balance effect, deducted negates it', () => {
  const t = settlementWorld();
  const content = 'ID;Datum;Betrag;Gebühr\nA;03.07.2026;10,00;-0,30\nB;03.07.2026;-10,00;0,30';
  const mapping = { columns: { id: 'ID', day: 'Datum', amount: 'Betrag', fee: 'Gebühr' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: ',', vat: { mode: 'none' } };
  const signed = must(settlementFromTable(t.ctx, { ...src, content, mapping: { ...mapping, feeSign: 'signed' } }));
  assert.deepEqual(signed.settlement.events.filter((e) => e.kind === 'processing_fee').map((e) => [e.id, e.amount]), [
    ['A:fee', '-0.30'],
    ['B:fee', '0.30'],
  ]);
  const deducted = must(settlementFromTable(t.ctx, { ...src, content, mapping: { ...mapping, feeSign: 'deducted' } }));
  assert.deepEqual(deducted.settlement.events.filter((e) => e.kind === 'processing_fee').map((e) => e.amount), ['0.30', '-0.30']);
});

test('M3 bites "only a missing column mismatches": a table with one ADDED column refuses table_mapping_mismatch', () => {
  const t = settlementWorld();
  const first = must(settlementFromTable(t.ctx, { ...src, content: STRIPE }));
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: first.mapping, headers: first.headers, idempotencyKey: 'add-0' }));
  const lines = STRIPE.trim().split('\n');
  const wider = [`${lines[0]},customer_email`, ...lines.slice(1).map((l) => `${l},`)].join('\n');
  const r = refused(settlementFromTable(t.ctx, { ...src, content: wider }), 'table_mapping_mismatch');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.added, ['customer_email']);
});

test('M3 bites "a governed seat saves directly": an agent seat`s set_settlement_table_mapping is drafted; nothing is saved until a person approves', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const person = { ...deps, actor: 'studio' };
  const agent = { ...deps, actor: 'agent' };
  const saved = () => deps.store.db.prepare('SELECT COUNT(*) AS n FROM settlement_table_mapping WHERE workspace_id = ?').get(workspaceId).n;
  const input = { workspaceId, system: 'laden', processor: 'kasse', mapping: { columns: { id: 'Beleg', day: 'Datum', amount: 'Betrag' } }, headers: ['Beleg', 'Datum', 'Betrag'], idempotencyKey: 'ag-map' };
  const drafted = handleRest('set_settlement_table_mapping', input, agent).body;
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  assert.equal(drafted.dialCapability, 'post');
  assert.equal(saved(), 0, 'the proposal saves nothing');
  const approved = getAction('approve_drafted_action').run(person, { workspaceId, actionId: drafted.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(saved(), 1);
  deps.store.close();
});

// --- LOW findings ------------------------------------------------------------------------------------

test('L2: the sales and refunds that carry no VAT are counted in the warnings', () => {
  const t = settlementWorld();
  const r = must(settlementFromTable(t.ctx, { ...src, content: STRIPE }));
  assert.ok(r.settlement.warnings.includes('3 sales and refunds carry no VAT (their kind is booked without a tax code, no template is saved, or the mapping says none)'));
});

// L3: "EUR 50.00" in a CHF workspace refuses `currency_mismatch` on every money column the door reads, from the
// shared money-cell parser's own answer (WP1).
for (const [column, header, line, mapping] of [
  ['amount', 'amount', 'a,2026-07-01,EUR 50.00', { columns: { id: 'id', day: 'date', amount: 'amount' } }],
  ['fee', 'fee', 'a,2026-07-01,60.00,EUR 50.00', { columns: { id: 'id', day: 'date', amount: 'amount', fee: 'fee' } }],
  ['vat', 'vat', 'a,2026-07-01,54.05,EUR 50.00', { columns: { id: 'id', day: 'date', amount: 'amount', vat: 'vat' }, vat: { mode: 'stated' } }],
  ['net', 'net', 'a,2026-07-01,54.05,EUR 50.00', { columns: { id: 'id', day: 'date', amount: 'amount', net: 'net' }, vat: { mode: 'stated' } }],
]) {
  test(`L3: EUR 50.00 in the ${column} column of a CHF workspace refuses currency_mismatch`, () => {
    const t = settlementWorld();
    const head = column === 'amount' ? 'id,date,amount' : `id,date,amount,${header}`;
    const r = must(settlementFromTable(t.ctx, { ...src, content: `${head}\n${line}`, mapping }));
    assert.deepEqual(r.refusedRows.map((x) => x.code), ['currency_mismatch']);
    assert.deepEqual(r.settlement.events, []);
  });
}

test('L4 and L6: every distinct type cell is answered beyond the preview, and each preview row says what it was read as', () => {
  const t = settlementWorld();
  const rows = Array.from({ length: 30 }, (_, i) => `r${i},2026-07-01,1.00,${i < 25 ? 'charge' : 'late_type'}`);
  const r = must(settlementFromTable(t.ctx, { ...src, content: ['id,date,amount,type', ...rows, 'bad,2026-07-01,x,charge'].join('\n') }));
  assert.deepEqual(r.typeCells, ['charge', 'late_type']);
  assert.deepEqual(r.rows[0].parsed, { id: 'r0', day: '2026-07-01', kind: 'sale', amountMinor: 100 });
  const short = must(settlementFromTable(t.ctx, { ...src, content: 'id,date,amount\nok,01.07.2026,1.00' , mapping: { columns: { id: 'id', day: 'date', amount: 'amount' } } }));
  assert.deepEqual(short.rows[0].parsed, { code: 'unreadable_day' }, 'a day in another format is shown refused, not silently misread');
});

test('XLSX number cells are read point-decimal whatever the mapping says (a mapping with a decimal comma)', () => {
  const t = settlementWorld();
  const lines = [['id', 'date', 'amount'], ['a', '2026-07-01', '-1234.56']];
  const r = must(settlementFromTable(t.ctx, { ...src, contentBase64: xlsxOf(lines, [2]), mapping: { columns: { id: 'id', day: 'date', amount: 'amount' }, decimalSeparator: ',' } }));
  assert.equal(r.settlement.events[0].amount, '-1234.56');
});

/** A workbook table as the reader answers it, with the cell kinds given (or withheld) by the test. */
const workbookTable = (records, kinds) => ({
  container: 'xlsx',
  headers: ['id', 'date', 'amount'],
  records,
  rowNumbers: records.map((_, i) => i + 2),
  sheets: ['Umsatz'],
  sheet: 'Umsatz',
  kinds,
  warnings: [],
});
const COMMA = readTableMapping({ columns: { id: 'id', day: 'date', amount: 'amount' }, decimalSeparator: ',' });
const rowsOf = [
  { id: 'a', date: '2026-07-01', amount: '1234.56' },
  { id: 'b', date: '2026-07-01', amount: '12.30' },
];
const K = { id: 'text', date: 'date', amount: 'number' };

test('fail-closed: an XLSX row whose cell kinds are missing is refused unreadable_amount, never read by the decimal comma', () => {
  const t = settlementWorld();
  const known = tableToSettlement(t.ctx, workbookTable(rowsOf, [K, K]), COMMA, src, null);
  assert.deepEqual(known.document.events.map((e) => e.amount), ['1234.56', '12.30'], 'number cells, point-decimal');
  const noKinds = tableToSettlement(t.ctx, workbookTable(rowsOf, null), COMMA, src, null);
  assert.deepEqual(noKinds.refusedRows.map((r) => [r.row, r.code]), [
    [2, 'unreadable_amount'],
    [3, 'unreadable_amount'],
  ]);
  const holed = tableToSettlement(t.ctx, workbookTable(rowsOf, [K, { id: 'text', date: 'date' }]), COMMA, src, null);
  assert.deepEqual(holed.refusedRows.map((r) => [r.row, r.code]), [[3, 'unreadable_amount']], 'a cell without a kind is unreadable');
  assert.deepEqual(holed.document.events.map((e) => e.amount), ['1234.56']);
});

test('fail-closed: a kinds list one row short is trusted for no row: every row refuses rather than misreading', () => {
  const t = settlementWorld();
  const short = tableToSettlement(t.ctx, workbookTable(rowsOf, [K]), COMMA, src, null);
  assert.deepEqual(short.document.events, []);
  assert.deepEqual(short.refusedRows.map((r) => r.code), ['unreadable_amount', 'unreadable_amount']);
  // A text cell the reader positively named text follows the mapping's decimal comma.
  const text = tableToSettlement(t.ctx, workbookTable([{ id: 'c', date: '2026-07-01', amount: '1234,56' }], [{ ...K, amount: 'text' }]), COMMA, src, null);
  assert.equal(text.document.events[0].amount, '1234.56');
});

test('XLSX TEXT cells with a decimal comma follow the mapping, while a NUMBER cell stays point-decimal', () => {
  const t = settlementWorld();
  const lines = [['id', 'date', 'amount'], ['a', '2026-07-01', '1234,56']];
  const r = must(settlementFromTable(t.ctx, { ...src, contentBase64: xlsxOf(lines), mapping: { columns: { id: 'id', day: 'date', amount: 'amount' }, decimalSeparator: ',' } }));
  assert.equal(r.settlement.events[0].amount, '1234.56');
});

/** mulberry32: a small seeded PRNG, so every failure names its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test('US-A43.2 property: random gross amounts at 2.6, 3.8 and 8.1 % never refuse vat_not_exact, across the 2024 rate change', () => {
  const SEEDS = Number(process.env.TILL_A43_FUZZ_SEEDS ?? 12);
  const codes = [
    { code: 'UST26', bp: { '2023': 250, '2024': 260 } },
    { code: 'UST38', bp: { '2023': 370, '2024': 380 } },
    { code: 'UST81', bp: { '2023': 770, '2024': 810 } },
  ];
  const days = ['2023-12-28', '2023-12-31', '2024-01-01', '2024-01-05'];
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const t = settlementWorld();
    const next = rng(seed);
    for (const c of codes) {
      const system = `prop-${c.code.toLowerCase()}`;
      must(setSettlementTemplate(t.ctx, {
        system,
        processor: 'kasse',
        clearingAccountId: t.acc('1095'),
        kinds: { sale: { action: 'book', accountId: t.acc('3400'), taxCode: c.code }, refund: { action: 'book', accountId: t.acc('3400'), taxCode: c.code } },
        idempotencyKey: `tpl-${system}`,
      }));
      const lines = ['id,date,amount'];
      for (let i = 0; i < 25; i += 1) {
        const minor = 1 + Math.floor(next() * 500_000);
        const signed = next() < 0.2 ? -minor : minor;
        lines.push(`${system}-${seed}-${i},${days[Math.floor(next() * days.length)]},${(signed / 100).toFixed(2)}`);
      }
      const r = must(settlementFromTable(t.ctx, { system, processor: 'kasse', content: lines.join('\n'), mapping: { columns: { id: 'id', day: 'date', amount: 'amount' } } }));
      assert.equal(r.refusedRows.length, 0, `seed ${seed} ${c.code}`);
      for (const e of r.settlement.events) {
        const gross = Math.round(Number(e.amount) * 100);
        const vat = Math.round(Number(e.vat.amount) * 100);
        const net = Math.round(Number(e.net) * 100);
        assert.equal(net + vat, gross, `seed ${seed} ${e.id}: amount = net + vat`);
        const bp = c.bp[e.day.slice(0, 4)];
        assert.ok(Math.abs(Math.abs(vat) - (Math.abs(gross) * bp) / (10_000 + bp)) <= 0.5, `seed ${seed} ${e.id}: the rate of the event's day (${bp} bp)`);
      }
      const imp = must(importSettlement(t.ctx, { settlement: r.settlement, idempotencyKey: `imp-${system}-${seed}` }));
      const notExact = imp.events.filter((e) => e.code === 'vat_not_exact');
      assert.deepEqual(notExact, [], `seed ${seed} ${c.code}: never vat_not_exact`);
      assert.equal(imp.booked, 25, `seed ${seed} ${c.code}: every event books`);
    }
  }
});

// --- the stored mapping --------------------------------------------------------------------------

test('a saved mapping is used for the next table; other headers refuse table_mapping_mismatch with a guess to start over', () => {
  const t = settlementWorld();
  setTemplate(t);
  const first = must(settlementFromTable(t.ctx, { ...src, content: SHOPIFY }));
  const saved = must(setSettlementTableMapping(t.ctx, { ...src, mapping: first.mapping, headers: first.headers, idempotencyKey: 'm1' }));
  assert.equal(saved.changed, true);
  const second = must(settlementFromTable(t.ctx, { ...src, content: SHOPIFY }));
  assert.equal(second.mappingSource, 'saved');
  assert.deepEqual(second.settlement.events, first.settlement.events);
  const other = refused(settlementFromTable(t.ctx, { ...src, content: STRIPE }), 'table_mapping_mismatch');
  assert.ok(other.missing.includes('Transaction Date'));
  assert.ok(other.added.includes('balance_transaction_id'));
  assert.equal(other.guessedMapping.columns.id, 'balance_transaction_id', 'the named profile of the new file is offered');
  // A given mapping naming a column the file lacks refuses the same way.
  refused(settlementFromTable(t.ctx, { ...src, content: STRIPE, mapping: first.mapping }), 'table_mapping_mismatch');
  // A given mapping that fits is the caller's choice.
  assert.equal(must(settlementFromTable(t.ctx, { ...src, content: STRIPE, mapping: other.guessedMapping })).mappingSource, 'given');
});

test('the mapping history is append-only: a no-op save writes nothing, a change keeps old and new, the rows refuse edits', () => {
  const t = settlementWorld();
  const first = must(settlementFromTable(t.ctx, { ...src, content: SHOPIFY }));
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: first.mapping, headers: first.headers, idempotencyKey: 'h1' }));
  const same = must(setSettlementTableMapping(t.ctx, { ...src, mapping: first.mapping, headers: first.headers, idempotencyKey: 'h2' }));
  assert.equal(same.changed, false);
  const replay = must(setSettlementTableMapping(t.ctx, { ...src, mapping: { ...first.mapping, amountSign: 'as_stated' }, headers: first.headers, idempotencyKey: 'h1' }));
  assert.equal(replay.changed, true, 'a replay of the first key answers the first report');
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: { ...first.mapping, amountSign: 'as_stated' }, headers: first.headers, idempotencyKey: 'h3' }));
  const changes = t.store.db.prepare('SELECT old_json, new_json FROM settlement_table_mapping_change WHERE workspace_id = ? ORDER BY at, id').all(t.workspaceId);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].old_json, null);
  assert.equal(JSON.parse(changes[1].old_json).mapping.amountSign, 'by_kind');
  assert.equal(JSON.parse(changes[1].new_json).mapping.amountSign, 'as_stated');
  assert.throws(() => t.store.db.prepare('UPDATE settlement_table_mapping_change SET actor = ?').run('x'), /append-only/);
  assert.throws(() => t.store.db.prepare('DELETE FROM settlement_table_mapping_change').run(), /append-only/);
});

test('a mapping exports as a till-import-profile/v1 file and imports back; another format refuses', () => {
  const t = settlementWorld();
  const first = must(settlementFromTable(t.ctx, { ...src, content: GENERIC }));
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: first.mapping, headers: first.headers, idempotencyKey: 'p1' }));
  const got = must(getSettlementTableMapping(t.ctx, src));
  const profile = got.mappings[0].profile;
  assert.equal(profile.schema, 'till-import-profile/v1');
  assert.equal(profile.kind, 'settlement_table');
  assert.deepEqual(profile.match.headers, first.headers);
  assert.ok(got.profiles.some((p) => p.id === 'shopify_payments_transactions'));
  const b = secondWorkspace(t);
  must(setSettlementTableMapping(b.ctx, { ...src, profile, idempotencyKey: 'p2' }));
  const there = must(settlementFromTable(b.ctx, { ...src, content: GENERIC }));
  assert.equal(there.mappingSource, 'saved');
  assert.deepEqual(there.mapping, first.mapping);
  refused(setSettlementTableMapping(b.ctx, { ...src, profile: { ...profile, schema: 'other/v9' }, idempotencyKey: 'p3' }), 'unsupported_schema');
});

test('[INVARIANT tenant] a table mapping is per workspace: the other workspace neither sees nor uses it', () => {
  const t = settlementWorld();
  const first = must(settlementFromTable(t.ctx, { ...src, content: SHOPIFY }));
  must(setSettlementTableMapping(t.ctx, { ...src, mapping: { ...first.mapping, feeSign: 'signed' }, headers: first.headers, idempotencyKey: 'ten' }));
  const b = secondWorkspace(t);
  assert.deepEqual(must(getSettlementTableMapping(b.ctx, {})).mappings, []);
  assert.deepEqual(must(getSettlementTableMapping(b.ctx, src)).mappings, []);
  assert.equal(must(settlementFromTable(b.ctx, { ...src, content: SHOPIFY })).mappingSource, 'profile');
  assert.equal(must(getSettlementTableMapping(t.ctx, {})).mappings.length, 1);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM settlement_table_mapping_change WHERE workspace_id = ?').get(b.workspaceId).n, 0);
});

test('without a template, from_template computes no VAT and says so; the review then refuses settlement_template_missing', () => {
  const t = settlementWorld();
  const r = must(settlementFromTable(t.ctx, { ...src, content: STRIPE }));
  assert.equal(r.templateSaved, false);
  assert.ok(r.settlement.events.every((e) => e.vat === null));
  assert.ok(r.settlement.warnings.some((w) => /no template is saved/.test(w)));
  refused(settlementReview(t.ctx, { ...src, settlement: r.settlement }), 'settlement_template_missing');
});

test('the verbs through the registry: the read is a read, the save is gated on post', () => {
  const t = settlementWorld();
  assert.equal(getAction('settlement_from_table').kind, 'read');
  assert.equal(getAction('get_settlement_table_mapping').kind, 'read');
  assert.equal(getAction('set_settlement_table_mapping').kind, 'write');
  const res = getAction('settlement_from_table').run(t.deps, { workspaceId: t.workspaceId, ...src, content: SHOPIFY });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(templateKinds({ acc: t.acc }).sale);
});
