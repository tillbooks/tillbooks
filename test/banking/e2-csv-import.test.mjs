// D178 point 4 (spec A20 §11.3): a bank CSV, mapped once per Bankkonto and reused. The reader is G09's
// `parseGenericCsv`, unchanged; this suite pins what TILL adds before it (encoding, preamble, separator)
// and after it (Swiss amounts, dates, the mapping, the row reasons, the preview, the refusals that NAME
// the missing column), the mapping verbs, §H-TENANT on `bank_csv_mapping`, and the EBICS guard.
//
// SYNTHETIC DATA ONLY: fixtures/e2-csv-export.csv (invented texts and amounts; the IBAN is the published
// PostFinance sample) and files spelled in this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { importBankStatement, bankCsvPreview, detectStatementFormat } from '../../dist/core/banking/statementImport.js';
import { csvDate, csvSignedAmount, decodeStatementBytes, detectCsvLayout, readCsvTable } from '../../dist/core/banking/csvStatement.js';
import { getBankCsvMapping, setBankCsvMapping, guessCsvMapping } from '../../dist/core/banking/csvMapping.js';
import { world, must, refused, secondWorkspace } from './bank-inbox-support.mjs';
import { resolvePossibleDuplicate } from '../../dist/core/banking/duplicateDecision.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSV = readFileSync(join(HERE, 'fixtures', 'e2-csv-export.csv'), 'utf8');
const b64 = (s, enc = 'utf8') => Buffer.from(s, enc).toString('base64');
const count = (t, table) => t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(t.workspaceId).n;

const MAPPING = {
  columns: { bookingDate: 'Buchungsdatum', valueDate: 'Valuta', text: 'Buchungstext', debit: 'Belastung', credit: 'Gutschrift' },
  dateFormat: 'dd.mm.yyyy',
  decimalSeparator: '.',
};

test('decode: a UTF-8 BOM, strict UTF-8, and Windows-1252 when the bytes are not UTF-8', () => {
  assert.deepEqual(decodeStatementBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])), { text: 'A', encoding: 'utf-8-bom' });
  assert.deepEqual(decodeStatementBytes(new Uint8Array(Buffer.from('Gebühr', 'utf8'))), { text: 'Gebühr', encoding: 'utf-8' });
  assert.deepEqual(decodeStatementBytes(new Uint8Array(Buffer.from('Gebühr', 'latin1'))), { text: 'Gebühr', encoding: 'windows-1252' });
  assert.equal(decodeStatementBytes(new Uint8Array(Buffer.from('Gebühr', 'utf8')), 'windows-1252').encoding, 'windows-1252', 'a forced encoding wins');
});

test('layout: the header below a preamble, and the separator (;  ,  tab)', () => {
  assert.deepEqual(detectCsvLayout(CSV), { headerRow: 5, delimiter: 'semicolon' });
  assert.deepEqual(detectCsvLayout('Date,Description,Amount\n2026-09-02,"Coffee, beans",-4.50\n'), { headerRow: 1, delimiter: 'comma' });
  assert.deepEqual(detectCsvLayout('Datum\tText\tBetrag\n02.09.2026\tMiete\t-1500,00\n'), { headerRow: 1, delimiter: 'tab' });
  assert.deepEqual(detectCsvLayout(CSV, { headerRow: 5, delimiter: 'comma' }), { headerRow: 5, delimiter: 'comma' }, 'a forced layout is taken as given');
  const table = readCsvTable({ text: CSV });
  assert.deepEqual(table.headers, ['Buchungsdatum', 'Valuta', 'Buchungstext', 'Belastung', 'Gutschrift', 'Saldo']);
  assert.equal(table.records.length, 6);
  assert.deepEqual(table.lines, [6, 7, 8, 9, 10, 11], 'each record keeps its file line');
  assert.equal(table.records[0]['Buchungstext'].includes('; USD 60.78'), true, 'a quoted separator stays in its cell');
});

test('amounts and dates: every Swiss shape, exact; unreadable is null, never rounded', () => {
  const cases = [
    ['-12.30', undefined, -1230],
    ['12.30-', undefined, -1230],
    ['(12.30)', undefined, -1230],
    ['+12.30', undefined, 1230],
    ["1'234.50", undefined, 123450],
    ['1’234.50', undefined, 123450],
    ['1 234,50', undefined, 123450],
    ['-1234,50', undefined, -123450],
    ['1.234,50', ',', 123450],
    ['CHF 49.88', undefined, 4988],
    ['12.345', '.', null],
    ['', undefined, null],
  ];
  for (const [raw, dec, want] of cases) assert.equal(csvSignedAmount(raw, dec), want, raw);
  assert.equal(csvDate('02.09.2026', 'dd.mm.yyyy'), '2026-09-02');
  assert.equal(csvDate('2.9.26', 'dd.mm.yy'), '2026-09-02');
  assert.equal(csvDate('2026-09-02', 'yyyy-mm-dd'), '2026-09-02');
  assert.equal(csvDate('02/09/2026', 'dd/mm/yyyy'), '2026-09-02');
  assert.equal(csvDate('31.02.2026', 'dd.mm.yyyy'), null, 'no 31 February');
  assert.equal(csvDate('2026-09-02', 'dd.mm.yyyy'), null, 'another format is unreadable, never guessed');
});

test('format detection: camt XML, MT940, else CSV', () => {
  assert.equal(detectStatementFormat('<?xml version="1.0"?><Document><BkToCstmrStmt><Stmt>'), 'camt');
  assert.equal(detectStatementFormat(':20:X\n:25:CH9300762011623852957\n:28C:1\n'), 'mt940');
  assert.equal(detectStatementFormat(CSV), 'csv');
});

test('the guess maps the header words and reads the date format and the decimal point', () => {
  const table = readCsvTable({ text: CSV });
  assert.deepEqual(guessCsvMapping(table.headers, table.records), MAPPING);
  const en = guessCsvMapping(['Date', 'Description', 'Amount', 'Currency'], [{ Date: '2026-09-02', Description: 'x', Amount: '-4,50', Currency: 'CHF' }]);
  assert.deepEqual(en, { columns: { bookingDate: 'Date', amount: 'Amount', currency: 'Currency', text: 'Description' }, dateFormat: 'yyyy-mm-dd', decimalSeparator: ',' });
});

test('preview: the first rows, the guessed mapping, nothing missing, each row as the import reads it', () => {
  const t = world();
  const p = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(`﻿${CSV}`) }));
  assert.equal(p.encoding, 'utf-8-bom');
  assert.equal(p.delimiter, 'semicolon');
  assert.equal(p.headerRow, 5);
  assert.equal(p.mappingSource, 'guessed');
  assert.deepEqual(p.mapping, MAPPING);
  assert.deepEqual(p.missing, []);
  assert.equal(p.blocking, null);
  assert.equal(p.rowCount, 6);
  assert.equal(p.rows[1][2], 'Velowerkstatt Alpenblick Annecy');
  assert.deepEqual(p.sample.map((s) => [s.row, s.amountMinor, s.error]), [
    [6, -4988, null],
    [7, -4023, null],
    [8, -12000, null],
    [9, 68835, null],
    [10, 1500, null],
    [11, null, 'not_a_movement'],
  ]);
  assert.equal(count(t, 'bank_txn'), 0, 'a preview writes nothing');
  // A mapping that lacks the booking date NAMES it.
  const lacking = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, mapping: { ...MAPPING, columns: { ...MAPPING.columns, bookingDate: undefined } } }));
  assert.deepEqual(lacking.missing, ['bookingDate']);
  assert.equal(lacking.blocking, 'map a column for the booking date');
  assert.deepEqual(lacking.sample, []);
});

test('import: a CSV without a mapping is refused with the guess; with one it imports, saves the mapping, and the next file reuses it', () => {
  const t = world();
  const first = refused(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, idempotencyKey: 'c0' }), 'csv_mapping_required');
  assert.deepEqual(first.guessedMapping, MAPPING);
  assert.deepEqual(first.missing, []);
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, fileName: 'export.csv', mapping: MAPPING, idempotencyKey: 'c1' }));
  assert.equal(res.format, 'csv');
  assert.equal(res.imported, 5);
  assert.equal(res.refused, 1);
  assert.deepEqual(res.skipped.map((s) => [s.reason, s.row]), [['not_a_movement', 11]]);
  assert.equal(res.mappingSaved, true);
  assert.deepEqual(must(getBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId })).mapping, MAPPING);
  // The card text's FX facts come through the text fallback on the CSV text too.
  const card = t.store.db.prepare("SELECT f.* FROM bank_txn_fact f JOIN bank_txn t ON t.id = f.bank_txn_id WHERE t.workspace_id = ? AND t.amount_minor = 4988").get(t.workspaceId);
  assert.equal(card.source, 'csv');
  assert.equal(card.fx_effective_rate, '0.820665');
  assert.equal(card.fee_minor, 62);
  assert.equal(card.fee_included, 1);
  // The next export of the same account: no mapping handed in, the saved one is used, nothing twice.
  const next = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, idempotencyKey: 'c2' }));
  assert.equal(next.mappingSaved, false);
  assert.deepEqual(next.statements.map((s) => s.outcome), ['already_imported']);
  assert.equal(count(t, 'bank_txn'), 5);
  // A re-export with the columns in another order and a different text column (other bytes, so another
  // delivery): D178 re-cut, a CSV never extends the chain, so every row on the days the first export covers
  // is matched one to one on the movement key, imported FLAGGED, and answered at once by the bulk decision.
  const reordered = 'Valuta;Belastung;Gutschrift;Buchungsdatum;Mitteilung\n' +
    CSV.split('\n').slice(5, 10).map((l) => {
      const c = l.match(/("[^"]*"|[^;]*)(;|$)/g).map((x) => x.replace(/;$/, ''));
      return [c[1], c[3], c[4], c[0], 'anders'].join(';');
    }).join('\n');
  const remap = { columns: { bookingDate: 'Buchungsdatum', valueDate: 'Valuta', text: 'Mitteilung', debit: 'Belastung', credit: 'Gutschrift' }, dateFormat: 'dd.mm.yyyy' };
  const again = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: reordered, mapping: remap, idempotencyKey: 'c3' }));
  assert.equal(again.imported, 5, 'imported, never dropped silently');
  assert.deepEqual(again.statements[0].nearDuplicates.map((d) => d.reason), Array(5).fill('same_movement'), 'every row matched one to one');
  const bulk = must(resolvePossibleDuplicate(t.ctx, { statementId: again.statements[0].statementId, scope: 'one_to_one_matches', decision: 'duplicate', idempotencyKey: 'c3-bulk' }));
  assert.equal(bulk.count, 5);
  const standing = t.store.db.prepare("SELECT COUNT(*) AS n FROM bank_txn t WHERE t.workspace_id = ? AND NOT EXISTS (SELECT 1 FROM bank_line_decision d WHERE d.bank_txn_id = t.id AND d.state = 'ignored' AND d.superseded_at IS NULL)").get(t.workspaceId).n;
  assert.equal(standing, 5, 'the re-export, answered, adds nothing to the books');
});

test('refusal: a saved mapping whose column the file no longer carries NAMES it', () => {
  const t = world();
  must(setBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId, mapping: MAPPING, idempotencyKey: 'm' }));
  const renamed = CSV.replace('Buchungsdatum;', 'Datum der Buchung;');
  const res = refused(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: renamed, idempotencyKey: 'r' }), 'csv_mapping_invalid');
  assert.deepEqual(res.unknownColumns, ['Buchungsdatum']);
  assert.equal(res.reason, 'the file has no column "Buchungsdatum"');
  const noAmount = refused(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, mapping: { columns: { bookingDate: 'Buchungsdatum' }, dateFormat: 'dd.mm.yyyy' }, idempotencyKey: 'r2' }), 'csv_mapping_invalid');
  assert.deepEqual(noAmount.missing, ['amount']);
  assert.equal(count(t, 'bank_txn'), 0);
});

test('one signed amount column, a comma decimal, tab separated, Windows-1252: rows read exactly; bad rows are skipped by line', () => {
  const t = world();
  const file = [
    'Datum\tText\tBetrag\tWährung',
    '01.10.2026\tMiete Büro Oktober\t-1\'500,00\tCHF',
    '01.10.2026\tZins\t0,35\tCHF',
    '02.10.2026\tFremdwährung\t-12,00\tEUR',
    '02.10.2026\tNichts\t0,00\tCHF',
    '32.10.2026\tKaputt\t-1,00\tCHF',
    '03.10.2026\tUnlesbar\tabc\tCHF',
  ].join('\r\n');
  const mapping = { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag', currency: 'Währung' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: ',' };
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, contentBase64: b64(file, 'latin1'), mapping, idempotencyKey: 'w' }));
  assert.equal(res.encoding, 'windows-1252');
  assert.equal(res.imported, 2);
  assert.deepEqual(res.skipped.map((s) => [s.row, s.reason]), [[4, 'currency_differs'], [5, 'zero_amount'], [6, 'unreadable_date'], [7, 'unreadable_amount']]);
  const rows = t.store.db.prepare('SELECT t.amount_minor AS a, t.credit_debit AS cd, d.remittance_text AS x FROM bank_txn t JOIN bank_txn_detail d ON d.bank_txn_id = t.id WHERE t.workspace_id = ? ORDER BY t.rowid').all(t.workspaceId);
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { a: 150000, cd: 'DBIT', x: 'Miete Büro Oktober' },
    { a: 35, cd: 'CRDT', x: 'Zins' },
  ]);
});

test('two genuinely identical rows in one file are two movements; a re-import of the file is none; a longer export matches two and brings the third as new', () => {
  const t = world();
  const file = 'Datum;Text;Betrag\n05.10.2026;Kaffee;-4.50\n05.10.2026;Kaffee;-4.50\n';
  const mapping = { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' };
  assert.equal(must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: file, mapping, idempotencyKey: 'twin' })).imported, 2);
  assert.equal(must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: file, idempotencyKey: 'twin2' })).imported, 0);
  const third = file + '05.10.2026;Kaffee;-4.50\n';
  // D178 re-cut: the longer export overlaps the stored day; two coffees match one to one (flagged, asked),
  // the third has no stored partner on that (edge) day and is new, unflagged.
  const longer = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: third, idempotencyKey: 'twin3' }));
  assert.equal(longer.imported, 3);
  assert.deepEqual(longer.statements[0].nearDuplicates.map((d) => d.reason), ['same_movement', 'same_movement']);
  must(resolvePossibleDuplicate(t.ctx, { statementId: longer.statements[0].statementId, scope: 'one_to_one_matches', decision: 'duplicate', idempotencyKey: 'twin3-bulk' }));
  const standing = t.store.db.prepare("SELECT COUNT(*) AS n FROM bank_txn t WHERE t.workspace_id = ? AND NOT EXISTS (SELECT 1 FROM bank_line_decision d WHERE d.bank_txn_id = t.id AND d.state = 'ignored' AND d.superseded_at IS NULL)").get(t.workspaceId).n;
  assert.equal(standing, 3, 'three coffees that day, each once');
});

test('critic H1 (D178 re-cut): mapping the Valuta column never counts a row twice silently; a mapping that MOVES the booking date out of the covered span moves the movement', () => {
  const t = world();
  const file = 'Buchungsdatum;Valuta;Text;Betrag\n05.10.2026;02.10.2026;Kaffeebar Seeblick;-4.50\n06.10.2026;06.10.2026;Kundin Ammann;350.00\n';
  const bare = { columns: { bookingDate: 'Buchungsdatum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' };
  assert.equal(must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: file, mapping: bare, idempotencyKey: 'h1-a' })).imported, 2);
  const keys = t.store.db.prepare('SELECT entry_key FROM bank_txn WHERE workspace_id = ? ORDER BY entry_key').all(t.workspaceId).map((r) => r.entry_key);
  assert.deepEqual(keys, ['csv:2026-10-05|DBIT|450|CHF#0', 'csv:2026-10-06|CRDT|35000|CHF#0']);
  // The Valuta column mapped: the same movements.
  const withValuta = { ...bare, columns: { ...bare.columns, valueDate: 'Valuta' } };
  const again = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: file, mapping: withValuta, idempotencyKey: 'h1-b' }));
  // The movement key has no optional column in it: both rows match their stored line one to one, flagged.
  assert.equal(again.imported, 2);
  assert.deepEqual(again.statements[0].nearDuplicates.map((d) => d.reason), ['same_movement', 'same_movement']);
  must(resolvePossibleDuplicate(t.ctx, { statementId: again.statements[0].statementId, scope: 'one_to_one_matches', decision: 'duplicate', idempotencyKey: 'h1-bulk' }));
  // The booking date read from ANOTHER column: the 06.10 credit is still on the covered day and matched;
  // the coffee now claims 02.10, a day no stored statement covers, so it is a movement on 02.10 (the
  // binding rule: outside the covered span coverage flags nothing, and point 19 compares across formats only).
  const fromValuta = { ...bare, columns: { ...bare.columns, bookingDate: 'Valuta' } };
  const moved = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: file, mapping: fromValuta, idempotencyKey: 'h1-c' }));
  assert.equal(moved.imported, 2);
  assert.deepEqual(moved.statements[0].nearDuplicates.map((d) => d.reason), ['same_movement']);
  assert.ok(moved.statements[0].warnings.includes('overlap_same_movement'));
});

test('critic L5: the same key with a corrected mapping is a new question; the same mapping spelled in another key order replays', () => {
  const t = world();
  const file = 'Datum;Text;Betrag\n05.10.2026;Kaffeebar Seeblick;-4.50\n06.10.2026;Kundin Ammann;350.00\n';
  const wrong = { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'yyyy-mm-dd' };
  const first = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: file, mapping: wrong, idempotencyKey: 'l5' }));
  assert.equal(first.imported, 0);
  assert.deepEqual(first.skipped.map((s) => s.reason), ['unreadable_date', 'unreadable_date']);
  const fixed = { dateFormat: 'dd.mm.yyyy', columns: { amount: 'Betrag', text: 'Text', bookingDate: 'Datum' } };
  const second = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: file, mapping: fixed, idempotencyKey: 'l5' }));
  assert.equal(second.imported, 2, 'the corrected mapping is read, not the stale answer replayed');
  const reordered = { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy' };
  assert.deepEqual(must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: file, mapping: reordered, idempotencyKey: 'l5' })), second, 'one mapping, one question');
  const admitted = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: file, mapping: reordered, allowDuplicateEntries: true, idempotencyKey: 'l5' }));
  assert.notDeepEqual(admitted, second, 'allowDuplicateEntries asks another question');
  assert.equal(count(t, 'bank_txn'), 2, 'the same statement again is already imported');
});

test('the mapping verbs: shape checks, unknown account, §H-TENANT, idempotent save', () => {
  const t = world();
  refused(setBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId, mapping: { columns: { nope: 'x' }, dateFormat: 'dd.mm.yyyy' }, idempotencyKey: 'a' }), 'invalid_input');
  refused(setBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId, mapping: { columns: {}, dateFormat: 'mm-dd' }, idempotencyKey: 'b' }), 'invalid_input');
  refused(setBankCsvMapping(t.ctx, { bankAccountId: 'bacc_nowhere', mapping: MAPPING, idempotencyKey: 'c' }), 'needs_bank_account');
  assert.equal(must(getBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId })).mapping, null);
  must(setBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId, mapping: MAPPING, idempotencyKey: 'd' }));
  must(setBankCsvMapping(t.ctx, { bankAccountId: t.bankAccountId, mapping: MAPPING, idempotencyKey: 'd' }));
  assert.equal(count(t, 'bank_csv_mapping'), 1, 'one live row per account');
  const other = secondWorkspace(t);
  refused(getBankCsvMapping(other.ctx, { bankAccountId: t.bankAccountId }), 'needs_bank_account', "another workspace cannot read this account's mapping");
  refused(importBankStatement(other.ctx, { bankAccountId: t.bankAccountId, content: CSV, idempotencyKey: 'x' }), 'needs_bank_account');
});

test('an EBICS-fed Bankkonto takes camt only: MT940 and CSV refuse bank_feed_account', () => {
  const t = world();
  const now = '2026-10-01T00:00:00.000Z';
  t.store.db
    .prepare("INSERT INTO ebics_connection (id, workspace_id, host_url, host_id, partner_id, user_id_ebics, state, activated_at, created_at, updated_at) VALUES ('ebc_e2', ?, 'https://bank.invalid', 'HOSTE2', 'PARTNERE2', 'USERE2', 'active', ?, ?, ?)")
    .run(t.workspaceId, now, now, now);
  t.store.db
    .prepare("INSERT INTO ebics_connection_account (id, workspace_id, connection_id, bank_account_id, created_at) VALUES ('eca_e2', ?, 'ebc_e2', ?, ?)")
    .run(t.workspaceId, t.bankAccountId, now);
  const res = refused(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, mapping: MAPPING, idempotencyKey: 'e' }), 'bank_feed_account');
  assert.equal(res.format, 'csv');
  refused(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: ':20:X\n:25:CH9300762011623852957\n:28C:1\n:60F:C261001CHF1,00\n:62F:C261001CHF1,00', idempotencyKey: 'f' }), 'bank_feed_account');
  assert.equal(count(t, 'bank_txn'), 0);
});
