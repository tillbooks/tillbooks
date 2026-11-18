// A20 §13.1 (D205): one tabular reader for a bank's CSV and its Excel export. The same rows as CSV and as
// XLSX read into the same lines (identical keys and statement digests); a preamble, a date cell and the
// 1904 date system read right; float noise is unreadable, never rounded; an OLE, an ODS or a non-workbook
// zip is xls_unsupported; the limits are enforced while reading (an oversized member, one row over the cap).
//
// SYNTHETIC DATA ONLY: every row, reference, name and amount below is invented here (ZKB-shaped, never
// copied from an export); the IBAN is the published sample of bank-inbox-support.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { importCamt, statementGaps } from '../../dist/core/banking/index.js';
import { importBankStatement, bankCsvPreview, prevalidateImportBankStatement } from '../../dist/core/banking/statementImport.js';
import { csvStatementOf, readCsvTable, readMoneyCell } from '../../dist/core/banking/csvStatement.js';
import { presetFor } from '../../dist/core/banking/csvMapping.js';
import {
  readTable,
  readTextTable,
  readXlsxTable,
  readXlsxGrid,
  serialToIsoDate,
  shortestDecimal,
  formatKindOf,
  TABULAR_MAX_ROWS,
  XLSX_CELL_MAX_CHARS,
} from '../../dist/core/tabular/index.js';
import { writeZip } from '../migration/zipWrite.mjs';
import { unzip } from '../../dist/core/migration/adapters/zip.js';
import { assertClaimInvariantHolds, world, must, refused, camt, secondWorkspace } from './bank-inbox-support.mjs';
import { xlsxBook, b64, STYLE, serialOf, styleOfBuiltin } from './xlsx-support.mjs';

afterEach(assertClaimInvariantHolds);

let n = 0;
const key = () => `tab-${(n += 1)}`;

const HEADER = ['Date', 'Booking text', 'Curr', 'Amount details', 'ZKB reference', 'Reference number', 'Debit CHF', 'Credit CHF', 'Value date', 'Balance CHF', 'Payment purpose', 'Details'];
const MAPPING = presetFor(HEADER).mapping;
const q = (v) => `"${v}"`;
const dmy = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** The invented rows, oldest first, with their running balance from 0. */
const ROWS = (() => {
  const raw = [
    { date: '2026-03-02', text: 'Credit originator: Beispiel Holding AG', ref: 'Z900000000101', minor: 200000 },
    { date: '2026-03-05', text: 'Online purchase Debit card, PAPETERIE MUSTER', ref: 'L9000000AA00T001-1', minor: -3500 },
    { date: '2026-03-12', text: 'Debit Mobile Banking: Software Muster AG', ref: 'Z900000000102', minor: -43210, details: 'Software Muster AG, Teststrasse 1, 9999 Testdorf' },
    { date: '2026-03-18', text: 'Account maintenance', ref: 'L9000000AA00T002-1', minor: -500 },
    { date: '2026-03-23', text: 'Online purchase Debit card, KIOSK TESTPLATZ', ref: 'L9000000AA00T003-1', minor: -1240 },
    { date: '2026-03-25', text: 'Credit originator: Kunde Test GmbH', ref: 'Z900000000104', minor: 25000, purpose: 'Rechnung 2026-007' },
    { date: '2026-03-28', text: 'Online purchase Debit card, BUCHLADEN BEISPIEL', ref: 'L9000000AA00T005-1', minor: -2000 },
    { date: '2026-03-30', text: 'Fee for Debit Card', ref: 'L9000000AA00T006-1', minor: -300 },
  ];
  let bal = 0;
  return raw.map((r) => ({ ...r, balance: (bal += r.minor) }));
})();

/** The same number as the bank's CSV writes it (two decimals) and as a workbook stores it (shortest). */
const csvMoney = (minor) => (Math.abs(minor) / 100).toFixed(2);
const xlsxMoney = (minor) => Math.abs(minor) / 100;

/** The export as CSV: BOM, CRLF, `;`, every field quoted, the newest row first. */
function csvOf(rows = ROWS) {
  const lines = rows.map((r) =>
    [dmy(r.date), r.text, '', '', r.ref, '', r.minor < 0 ? csvMoney(r.minor) : '', r.minor > 0 ? csvMoney(r.minor) : '', dmy(r.date), (r.balance / 100).toFixed(2), r.purpose ?? '', r.details ?? ''].map(q).join(';'),
  );
  return `﻿${HEADER.map(q).join(';')}\r\n${[...lines].reverse().join('\r\n')}\r\n`;
}

/** The same export as a workbook: a two-line preamble, date cells, number cells, the newest row first. */
function xlsxOf(rows = ROWS, opts = {}) {
  const dateCell = (iso) => ({ date: iso, s: opts.dateStyle ?? STYLE.dateCustom });
  const body = [...rows].reverse().map((r) => [
    dateCell(r.date),
    r.text,
    null,
    null,
    r.ref,
    null,
    r.minor < 0 ? { n: opts.noise === r.ref ? '432.1000000000001' : xlsxMoney(r.minor), s: STYLE.fixed2 } : null,
    r.minor > 0 ? { n: xlsxMoney(r.minor), s: STYLE.fixed2 } : null,
    dateCell(r.date),
    { n: r.balance / 100, s: STYLE.fixed2 },
    r.purpose ?? null,
    r.details ?? null,
  ]);
  const preamble = [['Kontoauszug'], [], ['Konto', { inline: 'Geschäftskonto Muster' }], []];
  return xlsxBook({ sheets: [{ name: 'Auszug', rows: [...preamble, HEADER, ...body] }, { name: 'Notizen', rows: [['Notiz'], ['frei']] }], date1904: opts.date1904 ?? false, deflate: true });
}

test('the reader: a workbook preamble is skipped like a CSV one; date cells are ISO dates; numbers their shortest decimal text', () => {
  const table = readXlsxTable(xlsxOf());
  assert.equal(table.container, 'xlsx');
  assert.deepEqual(table.sheets, ['Auszug', 'Notizen']);
  assert.equal(table.sheet, 'Auszug');
  assert.equal(table.headerRow, 5, 'the header is sheet row 5, below the preamble');
  assert.deepEqual(table.headers, HEADER);
  assert.equal(table.records.length, 8);
  assert.equal(table.lines[0], 6, 'a line number is the sheet row');
  assert.equal(table.records[0].Date, '2026-03-30');
  assert.equal(table.records[0]['Debit CHF'], '3');
  assert.equal(table.records[5]['Debit CHF'], '432.1');
  assert.equal(table.records[7]['Credit CHF'], '2000');
  assert.equal(table.records[2]['Credit CHF'], '250');
});

test('the same rows as CSV and as XLSX give identical keys and the same statement digest', () => {
  const fromCsv = csvStatementOf(readCsvTable({ text: csvOf() }), MAPPING, 'CHF');
  const fromXlsx = csvStatementOf(readXlsxTable(xlsxOf()), MAPPING, 'CHF');
  assert.equal(fromCsv.skipped.length, 0, JSON.stringify(fromCsv.skipped));
  assert.equal(fromXlsx.skipped.length, 0, JSON.stringify(fromXlsx.skipped));
  assert.deepEqual(fromXlsx.entries.map((e) => e.entryKey), fromCsv.entries.map((e) => e.entryKey));
  assert.equal(fromXlsx.statementId, fromCsv.statementId);
  assert.deepEqual(fromXlsx.entries.map((e) => [e.bookingDate, e.valueDate, e.amountMinor, e.creditDebit, e.counterpartyName]), fromCsv.entries.map((e) => [e.bookingDate, e.valueDate, e.amountMinor, e.creditDebit, e.counterpartyName]));
  assert.ok(fromXlsx.entries.every((e) => e.facts.container === 'xlsx' && e.facts.source === 'csv'), 'a workbook line says so; its source stays csv');
  assert.ok(fromCsv.entries.every((e) => e.facts.container === undefined));
});

test('a date cell in a built-in date style, a custom one and the 1904 system all read as the same day; a time style is no date', () => {
  for (const opts of [{ dateStyle: STYLE.date14 }, { dateStyle: STYLE.dateCustom }, { dateStyle: STYLE.dateCustom, date1904: true }]) {
    const table = readXlsxTable(xlsxOf(ROWS, opts));
    assert.equal(table.records[7].Date, '2026-03-02', JSON.stringify(opts));
  }
  assert.equal(serialToIsoDate(serialOf('2026-03-02'), false), '2026-03-02');
  assert.equal(serialToIsoDate(serialOf('2026-03-02', true), true), '2026-03-02');
  assert.equal(serialToIsoDate(60, false), null, '29.02.1900 never was');
  assert.equal(serialToIsoDate(59, false), '1900-02-28');
  assert.equal(serialToIsoDate(61, false), '1900-03-01');
  assert.equal(formatKindOf('dd\\.mm\\.yyyy'), 'date');
  assert.equal(formatKindOf('[$-807]d. mmmm yyyy'), 'date');
  assert.equal(formatKindOf('h:mm'), 'time');
  assert.equal(formatKindOf('[h]:mm'), 'time');
  assert.equal(formatKindOf('#,##0.00 "CHF"'), 'other');
  const timed = readXlsxTable(xlsxBook({ sheets: [{ name: 'S', rows: [['Datum', 'Zeit', 'Betrag'], [{ date: '2026-03-02' }, { n: '0.5', s: STYLE.time }, 1]] }] }));
  assert.deepEqual(timed.records[0], { Datum: '2026-03-02', Zeit: '0.5', Betrag: '1' });
});

test('float noise is unreadable_amount, never rounded; a shortest decimal is read as written', () => {
  assert.equal(shortestDecimal('0.30000000000000004'), '0.30000000000000004');
  assert.equal(shortestDecimal('1234.5'), '1234.5');
  assert.equal(shortestDecimal('-0'), '0');
  const stmt = csvStatementOf(readXlsxTable(xlsxOf(ROWS, { noise: 'Z900000000102' })), MAPPING, 'CHF');
  assert.deepEqual(stmt.skipped.map((s) => [s.reason, s.row]), [['unreadable_amount', 11]], 'sheet row 11 holds the noisy cell');
  assert.equal(stmt.entries.length, 7);
});

test('a line break inside a cell is a space; rich-text runs join; entities and the OOXML escape decode', () => {
  const zip = writeZip([
    { name: 'xl/workbook.xml', content: '<workbook xmlns:r="r"><sheets><sheet name="A &amp; B" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', content: '<sst><si><r><t>Muster</t></r><r><t xml:space="preserve"> AG</t></r><rPh><t>X</t></rPh></si><si><t>Zeile 1&#10;Zeile 2_x000D_</t></si></sst>' },
    {
      name: 'xl/worksheets/sheet1.xml',
      content: '<x:worksheet xmlns:x="m"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Name</x:t></x:is></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>Text</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2" t="s"><x:v>0</x:v></x:c><x:c t="s"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>',
    },
  ]);
  const table = readXlsxTable(zip);
  assert.deepEqual(table.sheets, ['A & B']);
  assert.deepEqual(table.records, [{ Name: 'Muster AG', Text: 'Zeile 1 Zeile 2' }], 'a namespace prefix, an implied cell position and a line break all read');
});

test('a legacy .xls (OLE), an ODS and a zip without a workbook are xls_unsupported, at the reader and at both verbs', () => {
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0]);
  const ods = writeZip([{ name: 'mimetype', content: 'application/vnd.oasis.opendocument.spreadsheet' }, { name: 'content.xml', content: '<office:document-content/>' }]);
  const other = writeZip([{ name: 'readme.txt', content: 'hello' }]);
  for (const [bytes, kind] of [[ole, 'ole'], [ods, 'ods'], [other, 'not_workbook']]) {
    const r = readTable({ bytes });
    assert.equal(r.ok, false);
    assert.deepEqual([r.code, r.kind], ['xls_unsupported', kind]);
  }
  const t = world();
  for (const bytes of [ole, ods, other]) {
    const imp = refused(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(bytes), mapping: MAPPING, idempotencyKey: key() }), 'xls_unsupported');
    assert.match(imp.reason, /xlsx|CSV/);
    refused(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(bytes) }), 'xls_unsupported');
  }
  assert.equal(refused(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: 'Datum;Betrag\n', format: 'xlsx' }), 'invalid_input').field, 'contentBase64', 'a workbook is sent as bytes');
});

test('the preview reads a workbook found from its bytes, answers every sheet, and takes another one by name', () => {
  const t = world();
  const pv = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(xlsxOf()) }));
  assert.deepEqual([pv.container, pv.sheets, pv.sheet, pv.encoding, pv.preset, pv.headerRow], ['xlsx', ['Auszug', 'Notizen'], 'Auszug', null, 'zkb_account_statement', 5]);
  assert.equal(pv.sample[0].amountMinor, -300);
  assert.equal(pv.sample[0].bookingDate, '2026-03-30', 'the date cell reads under the preset date format');
  const notes = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(xlsxOf()), sheet: 'Notizen' }));
  assert.deepEqual([notes.sheet, notes.headers], ['Notizen', ['Notiz']]);
  const missing = refused(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(xlsxOf()), sheet: 'Gibt es nicht' }), 'invalid_input');
  assert.deepEqual([missing.field, missing.allowed], ['sheet', ['Auszug', 'Notizen']]);
  const csv = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: csvOf() }));
  assert.equal(csv.container, 'csv');
  assert.equal(csv.sheets, undefined);
});

test('an XLSX import stays in the CSV family: message_type csv, each line container xlsx; the same file again is already_imported', () => {
  const t = world();
  const first = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(xlsxOf()), mapping: MAPPING, idempotencyKey: key() }));
  assert.deepEqual([first.format, first.container, first.sheet, first.imported, first.encoding], ['csv', 'xlsx', 'Auszug', 8, null]);
  const rows = t.store.db
    .prepare('SELECT s.message_type AS mt, f.source AS src, f.container AS c FROM bank_txn t JOIN bank_statement s ON s.id = t.statement_id JOIN bank_txn_fact f ON f.bank_txn_id = t.id WHERE t.workspace_id = ?')
    .all(t.workspaceId);
  assert.equal(rows.length, 8);
  assert.ok(rows.every((r) => r.mt === 'csv' && r.src === 'csv' && r.c === 'xlsx'));
  const again = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(xlsxOf()), mapping: MAPPING, idempotencyKey: key() }));
  assert.deepEqual([again.imported, again.statements[0].outcome], [0, 'already_imported']);
  // The same rows as CSV are the same statement (the same digest): already in the books too.
  const asCsv = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: csvOf(), mapping: MAPPING, idempotencyKey: key() }));
  assert.deepEqual([asCsv.imported, asCsv.statements[0].outcome], [0, 'already_imported']);
});

test('a gap filled from an XLSX: the gap closes; the same fill again, from the workbook or the CSV, writes nothing; §H-TENANT holds', () => {
  const t = world();
  const other = secondWorkspace(t);
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'S50', seqNb: '50', from: '2026-03-23', to: '2026-03-23', openingMinor: 152790, entries: [{ ref: 'k50', amountMinor: 1240, cd: 'DBIT', date: '2026-03-23' }] }), idempotencyKey: key() }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'S53', seqNb: '53', from: '2026-03-28', to: '2026-03-28', openingMinor: 176550, entries: [{ ref: 'k53', amountMinor: 2000, cd: 'DBIT', date: '2026-03-28' }] }), idempotencyKey: key() }));
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 1);
  const fill = { from: '2026-03-24', to: '2026-03-27' };
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(xlsxOf()), mapping: MAPPING, fill, idempotencyKey: key() }));
  assert.deepEqual(res.fill.parts.map((p) => [p.status, p.rows, p.closesTarget, p.closedGapIds.length]), [['imported', 1, true, 1]]);
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 0);
  const again = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(xlsxOf()), mapping: MAPPING, fill, idempotencyKey: key() }));
  assert.equal(again.imported, 0);
  const fromCsv = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: csvOf(), mapping: MAPPING, fill, idempotencyKey: key() }));
  assert.equal(fromCsv.imported, 0);
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ? AND message_type = 'csv'").get(other.workspaceId).n, 0);
  refused(importBankStatement(other.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(xlsxOf()), mapping: MAPPING, idempotencyKey: key() }), 'needs_bank_account');
});

test('limits are enforced while reading: a member that inflates past the ceiling is too_large, never expanded whole', () => {
  const big = xlsxBook({ sheets: [{ name: 'S', rows: [['Datum', 'Betrag'], ['2026-03-02', 1]] }], deflate: true, pad: 2 * 1024 * 1024 });
  const r = readXlsxTable(big, { maxInflatedBytes: 1024 * 1024 });
  assert.equal(r.ok, false);
  assert.deepEqual([r.code, r.limit], ['too_large', 1024 * 1024]);
  assert.equal(readXlsxGrid(big, { maxInflatedBytes: 1024 * 1024 }).kind, 'too_large');
  // A member whose header understates its size: zlib's own overrun (ERR_BUFFER_TOO_LARGE) is the ceiling too.
  const lying = Buffer.from(big);
  for (let i = lying.length - 22; i >= 0; i -= 1) {
    if (lying.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLen = lying.readUInt16LE(i + 28);
    if (lying.subarray(i + 46, i + 46 + nameLen).toString() === 'xl/worksheets/sheet1.xml') lying.writeUInt32LE(10, i + 24);
  }
  assert.equal(readXlsxTable(lying, { maxInflatedBytes: 1024 * 1024 }).code, 'too_large');
  // The limit holds for a delimited file as well: its own bytes.
  assert.deepEqual([readTable({ text: 'Datum;Betrag\n02.03.2026;1.00\n' }, { maxInflatedBytes: 10 }).code], ['too_large']);
  // Through the verb, at the real ceiling (40 MiB inflated from a file of a few dozen KiB).
  const bomb = xlsxBook({ sheets: [{ name: 'S', rows: [['Datum', 'Betrag']] }], deflate: true, pad: 41 * 1024 * 1024 });
  assert.ok(bomb.length < 1024 * 1024, 'the compressed file is small');
  const t = world();
  refused(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(bomb) }), 'table_too_large');
});

test('limits are enforced while reading: one row over the cap refuses, in a CSV and in a workbook', () => {
  const csv = (rows) => `Datum;Betrag\n${Array.from({ length: rows }, (_, i) => `02.03.2026;${i + 1}.00`).join('\n')}\n`;
  assert.equal(readTextTable({ text: csv(3) }, { maxRows: 3 }).overCap, undefined, 'exactly the cap reads');
  assert.equal(readTextTable({ text: csv(4) }, { maxRows: 3 }).overCap, true);
  assert.equal(readTextTable({ text: csv(4) }, { maxRows: 3 }).records.length, 3, 'reading stopped at the cap');
  assert.deepEqual([readTable({ text: csv(4) }, { maxRows: 3 }).code, readTable({ text: csv(4) }, { maxRows: 3 }).limit], ['too_many_rows', 3]);
  const book = (rows) => xlsxBook({ sheets: [{ name: 'S', rows: [['Datum', 'Betrag'], ...Array.from({ length: rows }, (_, i) => ['02.03.2026', i + 1])] }] });
  assert.equal(readXlsxTable(book(3), { maxRows: 3 }).records.length, 3);
  assert.equal(readXlsxTable(book(4), { maxRows: 3 }).code, 'too_many_rows');
  // Every break counts once, `\r` alone too: a classic Mac export one row over the cap is refused.
  const crOnly = (rows) => `Datum;Betrag\r${Array.from({ length: rows }, (_, i) => `02.03.2026;${i + 1}.00`).join('\r')}\r`;
  assert.equal(readTable({ text: crOnly(3) }, { maxRows: 3 }).records.length, 3);
  assert.equal(readTable({ text: crOnly(4) }, { maxRows: 3 }).code, 'too_many_rows');
  assert.equal(readTable({ text: crOnly(2).replace(/\r/g, '\r\n') }, { maxRows: 2 }).records.length, 2, 'a CRLF is one break, not two');
  const t = world();
  const over = refused(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: csv(TABULAR_MAX_ROWS + 1) }), 'table_too_many_rows');
  assert.equal(over.maxRows, TABULAR_MAX_ROWS);
  const overCr = refused(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: crOnly(TABULAR_MAX_ROWS + 1) }), 'table_too_many_rows');
  assert.equal(overCr.maxRows, TABULAR_MAX_ROWS);
});

test('a multi-sheet workbook: the sheet whose rows are counted is the sheet whose rows are returned', () => {
  const rows = (k) => [['Datum', 'Betrag'], ...Array.from({ length: k }, (_, i) => ['02.03.2026', i + 1])];
  const book = xlsxBook({ sheets: [{ name: 'Kurz', rows: rows(2) }, { name: 'Lang', rows: rows(5) }] });
  assert.equal(readXlsxTable(book, { maxRows: 3 }).records.length, 2, 'the first sheet is read and counted');
  assert.equal(readXlsxTable(book, { maxRows: 3, sheet: 'Lang' }).code, 'too_many_rows', 'the named sheet is the one counted');
  assert.equal(readXlsxTable(book, { maxRows: 5, sheet: 'Lang' }).records.length, 5);
  assert.deepEqual(readXlsxTable(book, { maxRows: 5, sheet: 'Lang' }).sheets, ['Kurz', 'Lang']);
});

test('a corrupt member refuses the whole workbook (never a partial read); G18 keeps reading what it needs', () => {
  const good = xlsxBook({ sheets: [{ name: 'S', rows: [['Datum', 'Betrag'], ['02.03.2026', 1]] }], deflate: true });
  // Graft a member whose deflate stream is garbage onto the workbook: rebuild with a broken extra member.
  const broken = writeZip([
    ...['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml'].map((name) => ({ name, content: readXlsxPart(good, name), deflate: true })),
    { name: 'xl/media/image1.png', content: 'x'.repeat(4000), deflate: true },
  ]);
  const at = broken.indexOf(Buffer.from('xl/media/image1.png'));
  broken[at + 19] = 0xff; // BFINAL 1, BTYPE 11: a reserved block type, so the stream is unreadable
  const r = readXlsxTable(broken);
  assert.equal(r.ok, false);
  assert.deepEqual([r.code, r.kind], ['xls_unsupported', 'corrupt']);
  assert.equal(readXlsxGrid(broken, { strictMembers: false }).sheet, 'S', 'the lenient G18 read still finds its sheet');
});

/** One part of a workbook, inflated (the test's own read, through the shipped zip reader). */
function readXlsxPart(bytes, name) {
  return Buffer.from(unzip(bytes).members.find((m) => m.name === name).bytes);
}

/** A workbook from one raw sheet XML body (`<sheetData>` content) and shared strings, for the amplification probes. */
function rawBook(sheetData, shared = []) {
  return writeZip([
    { name: 'xl/workbook.xml', content: '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>', deflate: true },
    { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>', deflate: true },
    { name: 'xl/sharedStrings.xml', content: `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`, deflate: true },
    { name: 'xl/worksheets/sheet1.xml', content: `<worksheet><sheetData>${sheetData}</sheetData></worksheet>`, deflate: true },
  ]);
}

test('no amplification after inflation: one shared string referenced a million times stops at the text budget', () => {
  const row = '<c t="s"><v>0</v></c>'.repeat(500);
  const header = '<row r="1"><c r="A1" t="inlineStr"><is><t>Datum</t></is></c><c r="B1" t="inlineStr"><is><t>Betrag</t></is></c></row>';
  const book = rawBook(`${header}${Array.from({ length: 2000 }, (_, i) => `<row r="${i + 2}">${row}</row>`).join('')}`, ['x'.repeat(1000)]);
  const started = Date.now();
  const r = readXlsxTable(book);
  assert.deepEqual([r.ok, r.code], [false, 'too_large']);
  assert.ok(Date.now() - started < 20_000, 'refused without writing the whole text');
});

test('no amplification after inflation: one cell on the last sheet row is refused, never a million empty lines', () => {
  const r = readXlsxTable(rawBook('<row r="1"><c r="A1" t="inlineStr"><is><t>Datum</t></is></c></row><row r="1048576"><c r="A1048576"><v>1</v></c></row>'));
  assert.deepEqual([r.ok, r.code, r.limit], [false, 'too_many_rows', TABULAR_MAX_ROWS]);
});

test('no amplification after inflation: one cell in column XFD is refused, never sixteen thousand empty columns per row', () => {
  const r = readXlsxTable(rawBook('<row r="1"><c r="A1" t="inlineStr"><is><t>Datum</t></is></c><c r="XFD1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>'));
  assert.deepEqual([r.ok, r.code], [false, 'too_large']);
});

test('an oversized cell is cut at the cell limit before it is copied, and the cut is said', () => {
  const sheet =
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Datum</t></is></c><c r="B1" t="inlineStr"><is><t>Text</t></is></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>02.03.2026</t></is></c><c r="B2" t="s"><v>0</v></c></row>';
  const r = readXlsxTable(rawBook(sheet, ['Z'.repeat(5000)]));
  assert.equal(r.records[0].Text.length, XLSX_CELL_MAX_CHARS);
  assert.ok(r.warnings.some((w) => w.includes(String(XLSX_CELL_MAX_CHARS))));
});

// --- Critic round 1, H1 and M3: the cell kind travels, the separator is checked, money cells read once ------------

const SIGNED = { columns: { bookingDate: 'Datum', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: ',' };
const amountsOf = (t) =>
  t.store.db
    .prepare('SELECT credit_debit AS cd, amount_minor AS a FROM bank_txn WHERE workspace_id = ? ORDER BY rowid')
    .all(t.workspaceId)
    .map((r) => (r.cd === 'CRDT' ? r.a : -r.a));
const prevalidate = (t, content) => prevalidateImportBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content, mapping: SIGNED, idempotencyKey: key() });

test('H1: a "," mapping over XLSX NUMBER cells reads them point-decimal (never CHF 123\'456.00 for -1234.56)', () => {
  const t = world();
  const book = xlsxBook({ sheets: [{ name: 'S', rows: [['Datum', 'Betrag'], ['02.03.2026', -1234.56], ['03.03.2026', 99.5], ['04.03.2026', 12]] }] });
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(book), mapping: SIGNED, idempotencyKey: key() }));
  assert.equal(res.imported, 3);
  assert.deepEqual(amountsOf(t), [-123456, 9950, 1200]);
  const table = readXlsxTable(book);
  assert.deepEqual(table.kinds.map((k) => k.Betrag), ['number', 'number', 'number']);
  assert.deepEqual(table.kinds.map((k) => k.Datum), ['text', 'text', 'text']);
});

test('H1: a "," mapping over XLSX TEXT cells holding "1.234,56" reads them with the mapping\'s separator', () => {
  const t = world();
  const book = xlsxBook({ sheets: [{ name: 'S', rows: [['Datum', 'Betrag'], ['02.03.2026', '1.234,56'], ['03.03.2026', '-99,50']] }] });
  must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(book), mapping: SIGNED, idempotencyKey: key() }));
  assert.deepEqual(amountsOf(t), [123456, -9950]);
});

test('M3: a separator the text amounts contradict refuses csv_mapping_separator_mismatch naming the row; the preview blocks and names it', () => {
  const t = world();
  const csv = 'Datum;Betrag\n02.03.2026;-12.50\n03.03.2026;8.00\n';
  const r = refused(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: csv, mapping: SIGNED, idempotencyKey: key() }), 'csv_mapping_separator_mismatch');
  assert.deepEqual([r.row, r.column], [2, 'Betrag']);
  const dot = { ...SIGNED, decimalSeparator: '.' };
  const commaCsv = 'Datum;Betrag\n02.03.2026;1234\n03.03.2026;-12,50\n';
  assert.equal(refused(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: commaCsv, mapping: dot, idempotencyKey: key() }), 'csv_mapping_separator_mismatch').row, 3);
  const pv = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: csv, mapping: SIGNED }));
  assert.deepEqual(pv.separatorMismatch, { row: 2, column: 'Betrag' });
  assert.match(pv.blocking, /row 2, column "Betrag"/);
  assert.deepEqual(pv.lines, [2, 3], 'each raw row names its file line, so the sample meets it');
  assert.equal(refused(prevalidate(t, csv), 'csv_mapping_separator_mismatch').row, 2, 'the agent draft path refuses the same');
  // A cell readable either way is no contradiction.
  must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: 'Datum;Betrag\n02.03.2026;1.234\n', mapping: SIGNED, idempotencyKey: key() }));
});

test('readMoneyCell: the one money-cell parser names the code it stripped; a number cell is point-decimal and names none', () => {
  assert.deepEqual(readMoneyCell('EUR 50.00', { decimal: '.' }), { minor: 5000, currency: 'EUR' });
  assert.deepEqual(readMoneyCell('50.00 EUR', { decimal: '.' }), { minor: 5000, currency: 'EUR' });
  assert.deepEqual(readMoneyCell('CHF -12.30', { decimal: '.' }), { minor: -1230, currency: 'CHF' });
  assert.deepEqual(readMoneyCell('(12.30) USD', { decimal: '.' }), { minor: -1230, currency: 'USD' });
  assert.deepEqual(readMoneyCell('-1234.56', { decimal: ',', kind: 'number' }), { minor: -123456 });
  assert.deepEqual(readMoneyCell('1.234,56', { decimal: ',', kind: 'text' }), { minor: 123456 });
  assert.equal(readMoneyCell('EUR 5.00 USD', { decimal: '.' }), null, 'two codes are unreadable');
  assert.equal(readMoneyCell('0.30000000000000004', { kind: 'number' }), null, 'float noise is unreadable, never rounded');
});

test('an amount cell that names another currency is skipped currency_differs, never read as the account\'s money', () => {
  const t = world();
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: 'Datum;Betrag\n02.03.2026;EUR 50.00\n03.03.2026;CHF -12.30\n', mapping: { ...SIGNED, decimalSeparator: '.' }, idempotencyKey: key() }));
  assert.deepEqual(res.skipped.map((s) => [s.reason, s.row]), [['currency_differs', 2]]);
  assert.deepEqual(amountsOf(t), [-1230]);
});

test('M2: every element scan is linear: 200\'000 unclosed openers of each tag are refused corrupt in well under a second', () => {
  const N = 200_000;
  const header = '<row r="1"><c r="A1" t="inlineStr"><is><t>Datum</t></is></c></row>';
  const cases = {
    row: [`<sheetData>${'<row r="2">'.repeat(N)}</sheetData>`],
    rowNoGt: [`<sheetData>${header}${'<row'.repeat(N)}</sheetData>`],
    c: [`<sheetData><row r="1">${'<c r="A1">'.repeat(N)}</row></sheetData>`],
    v: [`<sheetData><row r="1"><c r="A1">${'<v>'.repeat(N)}</c></row></sheetData>`],
    is: [`<sheetData><row r="1"><c r="A1" t="inlineStr">${'<is>'.repeat(N)}</c></row></sheetData>`],
    t: [`<sheetData><row r="1"><c r="A1" t="inlineStr"><is>${'<t>'.repeat(N)}</is></c></row></sheetData>`],
    sheetData: ['<sheetData>'.repeat(N)],
    si: [`<sheetData>${header}</sheetData>`, `<sst>${'<si>'.repeat(N)}</sst>`],
    rPh: [`<sheetData>${header}</sheetData>`, `<sst><si><t>x</t>${'<rPh>'.repeat(N)}</si></sst>`],
  };
  for (const [tag, [sheet, sst]] of Object.entries(cases)) {
    const zip = writeZip([
      { name: 'xl/workbook.xml', content: '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>', deflate: true },
      { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>', deflate: true },
      { name: 'xl/sharedStrings.xml', content: sst ?? '<sst/>', deflate: true },
      { name: 'xl/worksheets/sheet1.xml', content: `<worksheet>${sheet}</worksheet>`, deflate: true },
    ]);
    const started = performance.now();
    const r = readXlsxTable(zip);
    const ms = performance.now() - started;
    if (tag !== 'rowNoGt') assert.equal(r.ok, false, tag);
    assert.ok(ms < 1000, `${tag}: ${Math.round(ms)} ms`);
  }
  for (const [tag, part] of [['sheet', `<workbook xmlns:r="r"><sheets>${'<sheet name="S"'.repeat(N)}</sheets></workbook>`], ['Relationship', null], ['numFmt', null], ['xf', null]]) {
    const rels = tag === 'Relationship' ? `<Relationships>${'<Relationship Id="rId1"'.repeat(N)}</Relationships>` : '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
    const styles = tag === 'numFmt' ? `<styleSheet><numFmts>${'<numFmt numFmtId="1"'.repeat(N)}</numFmts></styleSheet>` : tag === 'xf' ? `<styleSheet><cellXfs>${'<xf numFmtId="1">'.repeat(N)}</cellXfs></styleSheet>` : '<styleSheet/>';
    const zip = writeZip([
      { name: 'xl/workbook.xml', content: part ?? '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>', deflate: true },
      { name: 'xl/_rels/workbook.xml.rels', content: rels, deflate: true },
      { name: 'xl/styles.xml', content: styles, deflate: true },
      { name: 'xl/worksheets/sheet1.xml', content: `<worksheet><sheetData>${'<row r="1"><c r="A1"><v>1</v></c></row>'}</sheetData></worksheet>`, deflate: true },
    ]);
    const started = performance.now();
    readXlsxGrid(zip);
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${tag}: ${Math.round(ms)} ms`);
  }
});

test('L3 and the built-in formats: the dates are 14 to 17 and 22, the times 18 to 21 and 45 to 47; a literal word is no date token', () => {
  const day = '2026-03-02';
  const rows = [['Datum', 'Wert'], ...[14, 15, 16, 17, 22].map((id) => [`d${id}`, { date: day, s: id === 14 ? STYLE.date14 : styleOfBuiltin(id) }]), ...[18, 19, 20, 21, 45, 46, 47].map((id) => [`t${id}`, { n: '0.5', s: id === 20 ? STYLE.time : styleOfBuiltin(id) }])];
  const table = readXlsxTable(xlsxBook({ sheets: [{ name: 'S', rows }] }));
  const by = Object.fromEntries(table.records.map((r) => [r.Datum, r.Wert]));
  for (const id of [14, 15, 16, 17, 22]) assert.equal(by[`d${id}`], day, `built-in ${id} is a date`);
  for (const id of [18, 19, 20, 21, 45, 46, 47]) assert.equal(by[`t${id}`], '0.5', `built-in ${id} is a time, kept a number`);
  assert.equal(formatKindOf('#,##0.00 USD'), 'other');
  assert.equal(formatKindOf('"CHF" #,##0.00'), 'other');
  assert.equal(formatKindOf('0.00E+00'), 'other');
  assert.equal(formatKindOf('General'), 'other');
  assert.equal(formatKindOf('h:mm AM/PM'), 'time');
  assert.equal(formatKindOf('dd.mm.yyyy'), 'date');
  assert.equal(formatKindOf('mmm yy'), 'date');
});

test('kinds come from the SAME row loop as the records: a line break in a text cell and a preamble never shift them', () => {
  const book = xlsxBook({
    sheets: [
      {
        name: 'S',
        rows: [
          ['Kontoauszug'],
          [],
          ['Datum', 'Text', 'Betrag'],
          ['02.03.2026', 'Zeile eins\nZeile zwei', -1234.56],
          ['03.03.2026', '99,50', 99.5],
          [],
          ['04.03.2026', 'Ende\r\nnoch eine Zeile', 12],
        ],
      },
    ],
  });
  const table = readXlsxTable(book);
  assert.equal(table.kinds.length, table.records.length);
  assert.deepEqual(table.records.map((r) => r.Text), ['Zeile eins Zeile zwei', '99,50', 'Ende noch eine Zeile']);
  assert.deepEqual(table.kinds.map((k) => [k.Datum, k.Text, k.Betrag]), [
    ['text', 'text', 'number'],
    ['text', 'text', 'number'],
    ['text', 'text', 'number'],
  ]);
  assert.deepEqual(table.lines, [4, 5, 7], 'the sheet rows, the empty one skipped');
});

test('fail closed: a workbook cell with no kind is unreadable_amount, never read with the mapping\'s separator', () => {
  const table = readXlsxTable(xlsxBook({ sheets: [{ name: 'S', rows: [['Datum', 'Betrag'], ['02.03.2026', -1234.56], ['03.03.2026', 12]] }] }));
  const broken = { ...table, kinds: [{ Datum: 'text' }, ...table.kinds.slice(1)] };
  const stmt = csvStatementOf(broken, SIGNED, 'CHF');
  assert.deepEqual(stmt.skipped.map((s) => [s.reason, s.row]), [['unreadable_amount', 2]]);
  assert.equal(stmt.entries.length, 1);
  const none = { ...table, kinds: undefined };
  assert.equal(csvStatementOf(none, SIGNED, 'CHF').entries.length, 0, 'a workbook without kinds reads no amount at all');
});

test('WP2 critic M2: a thousands mark stands only between three-digit groups, under either decimal mark, in CSV and XLSX text', () => {
  assert.equal(readMoneyCell('12.50', { decimal: ',' }), null, '12.50 under , is never 1250.00');
  assert.equal(readMoneyCell('1.2345', { decimal: ',' }), null);
  assert.equal(readMoneyCell('0.123', { decimal: ',' }), null, 'a leading zero group is no thousands group (critic r3 LOW)');
  assert.equal(readMoneyCell('0,123.00', { decimal: '.' }), null);
  assert.deepEqual(readMoneyCell('0,50', { decimal: ',' }), { minor: 50 });
  assert.deepEqual(readMoneyCell('1.234,50', { decimal: ',' }), { minor: 123450 });
  assert.deepEqual(readMoneyCell('1.234', { decimal: ',' }), { minor: 123400 });
  assert.deepEqual(readMoneyCell('12.345.678,90', { decimal: ',' }), { minor: 1234567890 });
  assert.equal(readMoneyCell('12,50', { decimal: '.' }), null);
  assert.deepEqual(readMoneyCell('1,234.50', { decimal: '.' }), { minor: 123450 });
  assert.equal(readMoneyCell('1,23,456.00', { decimal: '.' }), null, 'a group of two is no thousands group');
  // Through the import: the separator check and the parser agree (a movement row refuses the file; a cell that
  // reads either way is read).
  const t = world();
  refused(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: 'Datum;Betrag\n02.03.2026;12.50\n', mapping: SIGNED, idempotencyKey: key() }), 'csv_mapping_separator_mismatch');
  const book = xlsxBook({ sheets: [{ name: 'S', rows: [['Datum', 'Betrag'], ['02.03.2026', '1.234,50'], ['03.03.2026', '1.2345'], ['04.03.2026', '1.234']] }] });
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(book), mapping: SIGNED, idempotencyKey: key() }));
  assert.deepEqual(res.skipped.map((s) => [s.reason, s.row]), [['unreadable_amount', 3]]);
  assert.deepEqual(amountsOf(t), [123450, 123400]);
});

test('WP2 critic L4: a cell the sheet does not hold has NO kind (absent), never a default text', () => {
  const table = readXlsxTable(xlsxBook({ sheets: [{ name: 'S', rows: [['Datum', 'Text', 'Betrag'], ['02.03.2026', null, 12], ['03.03.2026', 'x', null]] }] }));
  assert.equal(table.kinds[0].Text, undefined);
  assert.equal(table.kinds[0].Betrag, 'number');
  assert.equal(table.kinds[1].Betrag, undefined);
  assert.equal('Betrag' in table.kinds[1], false);
});

test('re-critic L3: the separator check reads movement rows only; a dateless footer never refuses the file', () => {
  const t = world();
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: 'Datum;Text;Betrag\n02.03.2026;Miete;-12,50\n;Total;12.50\n', mapping: { ...SIGNED, columns: { ...SIGNED.columns, text: 'Text' } }, idempotencyKey: key() }));
  assert.equal(res.imported, 1);
  assert.deepEqual(amountsOf(t), [-1250]);
});
