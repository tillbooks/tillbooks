// D206 (A43 §2, "Whole-day mode"): a turnover table WITHOUT an id, booked day by day under the setting
// settlement.table_event_id column_else_day and a mapping a person confirmed lists whole days. The paper critic's
// list, every one of them, plus the invariants (to be reviewed by a non-author).
// SYNTHETIC BY CONSTRUCTION: every row, amount, text and day below is invented for these tests.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { makeAuditPort } from '../../dist/core/ledger/auditLog.js';
import { lockPeriod, unlockPeriod } from '../../dist/core/ledger/periods.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import {
  settlementFromTable,
  setSettlementTableMapping,
  importSettlement,
  setSettlementEventIgnored,
  setSettlementTemplate,
  settlementReview,
  prevalidateSetSettlementTableMapping,
  prevalidateImportSettlement,
} from '../../dist/core/settlement/index.js';
import { APPROVAL_CONFIRMS_FIELD, APPROVAL_CONFIRM_NOT_SET } from '../../dist/core/agent/index.js';
import { secondWorkspace, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { writeXlsx } from '../migration/zipWrite.mjs';
import { settlementWorld, setTemplate, must, refused, rows, balanceOf, SYSTEM, PROCESSOR } from './support.mjs';

afterEach(assertClaimInvariantHolds);

const NOW = '2026-10-05T08:00:00.000Z';
const src = { system: SYSTEM, processor: PROCESSOR };

/** A person's context with a real audit port (settings and the audited answers need one). */
function personCtx(t, at = NOW) {
  return makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: fixedClock(at), ids: t.ids, audit: makeAuditPort({ store: t.store, workspaceId: t.workspaceId, ids: t.ids }) });
}
const agentCtx = (t) => makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: fixedClock(NOW), ids: t.ids });

const setting = (t, key, value) => must(settingsSet(t.pctx, { key, value, reason: 'Testfall (erfunden)', idempotencyKey: `set-${key}-${value}-${Math.random()}` }));

/** A till's export: a day, a text, a type and an amount, and no id of its own. */
const HEADERS = ['Datum', 'Text', 'Typ', 'Betrag'];
const TILL = (lines) => [HEADERS.join(';'), ...lines].join('\n');
const DAY_MAPPING = {
  columns: { day: 'Datum', description: 'Text', kind: 'Typ', amount: 'Betrag' },
  kindMap: { verkauf: 'sale', 'rückerstattung': 'refund' },
  dateFormat: 'dd.mm.yyyy',
  decimalSeparator: ',',
  wholeDays: true,
};

/** The whole-day world: today 05.10.2026, a template, the mode on, the edges included unless a test says otherwise. */
function dayWorld({ edges = 'include', realPeriods = false, save = true } = {}) {
  const t = settlementWorld({ at: NOW, realPeriods });
  t.pctx = personCtx(t);
  setTemplate(t);
  setting(t, 'settlement.table_event_id', 'column_else_day');
  if (edges !== 'ask') setting(t, 'settlement.table_edge_days', edges);
  if (save) must(setSettlementTableMapping(t.pctx, { ...src, mapping: DAY_MAPPING, headers: HEADERS, idempotencyKey: 'day-map' }));
  return t;
}

let keys = 0;
const read = (t, lines, extra = {}, ctx = t.pctx) => settlementFromTable(ctx, { ...src, content: TILL(lines), ...extra });
const book = (t, doc, ctx = t.pctx) => must(importSettlement(ctx, { settlement: doc, idempotencyKey: `imp-${(keys += 1)}` }));
const books = (t) => ({ entries: rows(t.store, t.workspaceId).entries, clearing: balanceOf(t.store, t.workspaceId, '1095') });
const dayOf = (r, day) => r.days.find((d) => d.day === day);
const ids = (doc) => doc.events.map((e) => e.id);

// Days: September 2026, well before today (05.10.2026).
const D1 = ['01.09.2026;Gipfeli;Verkauf;12,50', '01.09.2026;Brot;Verkauf;7,80'];
const D2 = ['02.09.2026;Torte;Verkauf;30,00'];
const D3 = ['03.09.2026;Kaffee;Verkauf;4,50', '03.09.2026;Kaffee;Verkauf;4,50'];

// --- the id ----------------------------------------------------------------------------------------------

test('day ids: day:<day>#<n>, n from the parsed values (amount, fee, type, file order), never the file order alone', () => {
  const t = dayWorld();
  const a = must(read(t, [...D1, ...D2, ...D3]));
  assert.equal(a.dayMode, true);
  assert.deepEqual(ids(a.settlement), ['day:2026-09-01#2', 'day:2026-09-01#1', 'day:2026-09-02#1', 'day:2026-09-03#1', 'day:2026-09-03#2']);
  // The same rows newest-first: every row keeps its id (7.80 is #1 of its day, 12.50 #2).
  const b = must(read(t, [...D3, ...D2, ...D1].reverse()));
  const byAmount = (doc) => Object.fromEntries(doc.events.map((e) => [e.id, e.amount]));
  assert.deepEqual(byAmount(b.settlement), byAmount(a.settlement));
  // Two equal rows of one day are two events, never one swallowed: no id_not_unique in the whole-day mode.
  assert.deepEqual(a.refusedRows, []);
});

test('a fee column: the fee is its own event <day id>:fee, and the fee is part of the sort key', () => {
  const t = dayWorld({ save: false });
  const headers = ['Datum', 'Betrag', 'Gebühr'];
  const mapping = { columns: { day: 'Datum', amount: 'Betrag', fee: 'Gebühr' }, dateFormat: 'dd.mm.yyyy', wholeDays: true };
  must(setSettlementTableMapping(t.pctx, { ...src, mapping, headers, idempotencyKey: 'fee-map' }));
  const r = must(settlementFromTable(t.pctx, { ...src, content: 'Datum;Betrag;Gebühr\n01.09.2026;10.00;0.40\n01.09.2026;10.00;0.30' }));
  assert.deepEqual(r.settlement.events.map((e) => [e.id, e.kind, e.amount]), [
    ['day:2026-09-01#2', 'sale', '10.00'],
    ['day:2026-09-01#2:fee', 'processing_fee', '-0.40'],
    ['day:2026-09-01#1', 'sale', '10.00'],
    ['day:2026-09-01#1:fee', 'processing_fee', '-0.30'],
  ]);
  assert.equal(book(t, r.settlement).booked, 4);
});

// 2. CSV and XLSX ---------------------------------------------------------------------------------------

/** A one-sheet workbook of inline strings, numbers as number cells. */
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

test('2. the same day from CSV and from XLSX (a serial date, a numeric document number) gives identical ids', () => {
  const t = dayWorld({ save: false });
  const headers = ['Datum', 'Beleg', 'Betrag'];
  const mapping = { columns: { day: 'Datum', documentNumber: 'Beleg', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', wholeDays: true };
  must(setSettlementTableMapping(t.pctx, { ...src, mapping, headers, idempotencyKey: 'x-map' }));
  const csv = must(settlementFromTable(t.pctx, { ...src, content: 'Datum;Beleg;Betrag\n01.09.2026;9001;12.50\n01.09.2026;9002;7.80\n02.09.2026;9003;5.00' }));
  // 46266 is 2026-09-01 in the 1900 system; the money and the document numbers are number cells.
  const xlsx = must(settlementFromTable(t.pctx, { ...src, contentBase64: xlsxOf([headers, ['46266', '9001', '12.5'], ['46266', '9002', '7.8'], ['46267', '9003', '5']], [0, 1, 2]) }));
  assert.deepEqual(ids(csv.settlement), ['day:2026-09-01#2', 'day:2026-09-01#1', 'day:2026-09-02#1']);
  assert.deepEqual(xlsx.settlement.events.map((e) => [e.id, e.amount]), csv.settlement.events.map((e) => [e.id, e.amount]));
  // Booked from the CSV, the workbook books nothing again.
  book(t, csv.settlement);
  const held = books(t);
  const again = must(settlementFromTable(t.pctx, { ...src, contentBase64: xlsxOf([headers, ['46266', '9001', '12.5'], ['46266', '9002', '7.8'], ['46267', '9003', '5']], [0, 1, 2]) }));
  assert.deepEqual(again.days.map((d) => d.status), ['passed', 'passed']);
  assert.equal(book(t, again.settlement).alreadyImported, 3);
  assert.deepEqual(books(t), held);
});

// 1. the round-1 and round-2 probes ------------------------------------------------------------------------

test('1a. round 1 probe: a payout report (payout id mapped) is never whole days: day_mode_payout_mapped on save and on read', () => {
  const t = dayWorld({ save: false });
  const headers = ['Datum', 'Betrag', 'Auszahlung'];
  const mapping = { columns: { day: 'Datum', amount: 'Betrag', payoutId: 'Auszahlung' }, dateFormat: 'dd.mm.yyyy', wholeDays: true };
  refused(setSettlementTableMapping(t.pctx, { ...src, mapping, headers, idempotencyKey: 'po-map' }), 'day_mode_payout_mapped');
  refused(settlementFromTable(t.pctx, { ...src, content: 'Datum;Betrag;Auszahlung\n10.07.2026;29.00;po_1', mapping }), 'day_mode_payout_mapped');
});

test('1b. round 1 probe, the stated residual: one day split over two files is never whole; the second answers same as booked, never silent, never a double', () => {
  const t = dayWorld();
  book(t, must(read(t, ['10.07.2026;Kaffee;Verkauf;29,00'])).settlement);
  const held = books(t);
  const second = must(read(t, ['10.07.2026;Kaffee;Verkauf;29,00']));
  assert.equal(dayOf(second, '2026-07-10').status, 'passed');
  assert.deepEqual(second.sameAsBooked.map((s) => s.row), [2], 'shown on the mapping step and in the review');
  assert.equal(book(t, second.settlement).booked, 0);
  assert.deepEqual(books(t), held);
});

test('1c. round 2 probe: a newest-first re-export of a day with a new 30.00 answers day_differs; nothing doubles, the day is shown with both sides', () => {
  const t = dayWorld();
  book(t, must(read(t, ['01.09.2026;Gipfeli;Verkauf;12,50', '01.09.2026;Brot;Verkauf;7,80'])).settlement);
  const held = books(t);
  const r = must(read(t, ['01.09.2026;Torte;Verkauf;30,00', '01.09.2026;Brot;Verkauf;7,80', '01.09.2026;Gipfeli;Verkauf;12,50']));
  assert.deepEqual(dayOf(r, '2026-09-01'), { day: '2026-09-01', status: 'differs', edge: null, rows: [2, 3, 4], file: { events: 3, amountMinor: 5030 }, books: { events: 2, amountMinor: 2030 } });
  assert.deepEqual(r.refusedRows.map((x) => [x.row, x.code]), [[2, 'day_differs'], [3, 'day_differs'], [4, 'day_differs']]);
  assert.deepEqual(r.settlement.events, [], 'nothing of the day reaches the import');
  assert.equal(r.totals.amountMinor, 0);
  assert.deepEqual(r.totals.table, { events: 3, amountMinor: 5030, feeMinor: 0 }, 'F9: the table total is stated apart');
  assert.ok(r.warnings.some((w) => /differs from the books \(booked 20\.30 in 2 events, the file 50\.30 in 3\)/.test(w)));
  book(t, r.settlement);
  assert.deepEqual(books(t), held);
});

// 3. held and new days in one file ---------------------------------------------------------------------------

test('3. a file spanning held and new days: only the new days book', () => {
  const t = dayWorld();
  book(t, must(read(t, [...D1, ...D2])).settlement);
  const held = books(t);
  const r = must(read(t, [...D2, ...D3, '04.09.2026;Brot;Verkauf;7,80']));
  assert.deepEqual(r.days.map((d) => [d.day, d.status]), [
    ['2026-09-02', 'passed'],
    ['2026-09-03', 'new'],
    ['2026-09-04', 'new'],
  ]);
  const res = book(t, r.settlement);
  assert.equal(res.booked, 3, 'the two 4.50 of 03.09 and the 7.80 of 04.09');
  assert.equal(res.alreadyImported, 1, 'the 30.00 of 02.09');
  assert.equal(books(t).entries, held.entries + 3);
  assert.equal(books(t).clearing, held.clearing + 450 + 450 + 780);
});

// 4. retry after a locked period ---------------------------------------------------------------------------

test('4. retry after a locked-period refusal books exactly the straggler', () => {
  const t = dayWorld({ realPeriods: true });
  must(lockPeriod(t.ctx, { period: '2026-06', kind: 'soft', reason: 'Juni abgeschlossen (erfunden)', idempotencyKey: 'lock-06' }));
  const lines = ['30.06.2026;Torte;Verkauf;30,00', '01.07.2026;Brot;Verkauf;7,80'];
  // t.ctx carries the real period ports (the lock); the person's context of the other tests does not.
  const first = book(t, must(read(t, lines)).settlement, t.ctx);
  assert.deepEqual(first.events.map((e) => [e.id, e.outcome, e.code ?? null]), [
    ['day:2026-06-30#1', 'refused', 'period_locked'],
    ['day:2026-07-01#1', 'booked', null],
  ]);
  const held = books(t);
  must(unlockPeriod(t.ctx, { period: '2026-06', idempotencyKey: 'unlock-06' }));
  const again = must(read(t, lines));
  assert.deepEqual(again.days.map((d) => d.status), ['passed', 'passed'], 'a held day of exactly its whole-day events is handed through');
  const res = book(t, again.settlement, t.ctx);
  assert.deepEqual(res.events.map((e) => [e.id, e.outcome]), [
    ['day:2026-06-30#1', 'booked'],
    ['day:2026-07-01#1', 'already_imported'],
  ]);
  assert.equal(books(t).entries, held.entries + 1);
  assert.equal(books(t).clearing, held.clearing + 3000);
});

// 5. an A42 ignore on a held day ---------------------------------------------------------------------------

test('5. an A42 ignore on a held day: no day_differs, the outcome stays ignored', () => {
  const t = dayWorld();
  must(setSettlementEventIgnored(t.pctx, { ...src, eventId: 'day:2026-09-01#1', ignored: true, reason: 'Probe (erfunden)', idempotencyKey: 'ign-1' }));
  const first = book(t, must(read(t, D1)).settlement);
  assert.deepEqual(first.events.map((e) => [e.id, e.outcome, e.reason ?? null]), [
    ['day:2026-09-01#2', 'booked', null],
    ['day:2026-09-01#1', 'skipped', 'ignored'],
  ]);
  const held = books(t);
  const again = must(read(t, D1));
  assert.equal(dayOf(again, '2026-09-01').status, 'passed');
  const res = book(t, again.settlement);
  assert.deepEqual(res.events.map((e) => [e.id, e.outcome, e.reason ?? e.code ?? null]), [
    ['day:2026-09-01#2', 'already_imported', null],
    ['day:2026-09-01#1', 'skipped', 'ignored'],
  ]);
  assert.deepEqual(books(t), held);
});

// 6. TOCTOU -------------------------------------------------------------------------------------------------

test('6. two previews of one new day, then both imports: the second refuses day_differs inside the import', () => {
  const t = dayWorld();
  const a = must(read(t, D1));
  const b = must(read(t, [...D1, '01.09.2026;Torte;Verkauf;30,00']));
  assert.equal(dayOf(a, '2026-09-01').status, 'new');
  assert.equal(dayOf(b, '2026-09-01').status, 'new');
  assert.equal(book(t, a.settlement).booked, 2);
  const held = books(t);
  const res = book(t, b.settlement);
  assert.deepEqual(res.events.map((e) => [e.outcome, e.code]), [
    ['refused', 'day_differs'],
    ['refused', 'day_differs'],
    ['refused', 'day_differs'],
  ], 'no already_imported, no event_amended: the whole day refuses');
  assert.deepEqual(books(t), held);
  // The refused day is not recorded as observed: the books still hold the first two, so the first file passes.
  const c = must(read(t, D1));
  assert.equal(dayOf(c, '2026-09-01').status, 'passed');
  // Two previews of the SAME day book it once: the second is already imported.
  assert.equal(book(t, c.settlement).alreadyImported, 2);
  assert.deepEqual(books(t), held);
});

// 7. a day held through the JSON door ------------------------------------------------------------------------

const jsonDoc = (events) => ({ schema: 'till-settlement/v1', source: { system: SYSTEM, processor: PROCESSOR }, events });
const sale = (id, day, amount, net, vat) => ({ id, kind: 'sale', day, currency: 'CHF', amount, net, vat: { amount: vat } });

test('7. a day held through the JSON door: its table rows never reach the import, equal or not; zero new entries', () => {
  const t = dayWorld();
  book(t, jsonDoc([sale('json-1', '2026-09-01', '12.50', '11.56', '0.94'), sale('json-2', '2026-09-01', '7.80', '7.22', '0.58')]));
  const held = books(t);
  const equal = must(read(t, D1));
  assert.equal(dayOf(equal, '2026-09-01').status, 'in_books');
  assert.deepEqual(equal.settlement.events, []);
  assert.deepEqual(equal.sameAsBooked.map((s) => s.row), [2, 3], 'every row of a day in the books is the same as booked');
  const other = must(read(t, ['01.09.2026;Gipfeli;Verkauf;12,50']));
  assert.equal(dayOf(other, '2026-09-01').status, 'differs');
  book(t, equal.settlement);
  book(t, other.settlement);
  assert.deepEqual(books(t), held);
});

test('7b. F4 through another door: a table read while the day was new, booked after a JSON file booked it, refuses day_differs', () => {
  const t = dayWorld();
  const table = must(read(t, D1));
  book(t, jsonDoc([sale('json-1', '2026-09-01', '12.50', '11.56', '0.94'), sale('json-2', '2026-09-01', '7.80', '7.22', '0.58')]));
  const held = books(t);
  const res = book(t, table.settlement);
  assert.deepEqual(res.events.map((e) => e.code), ['day_differs', 'day_differs']);
  assert.deepEqual(books(t), held);
});

// 8. an unreadable row ---------------------------------------------------------------------------------------

test('8. an unreadable row: day_incomplete for its day; the next good file books the day whole; an unreadable day refuses the file', () => {
  const t = dayWorld();
  const r = must(read(t, ['01.09.2026;Gipfeli;Verkauf;12,50', '01.09.2026;Brot;Verkauf;7,8x', ...D2]));
  assert.deepEqual(r.refusedRows.map((x) => [x.row, x.code]), [
    [2, 'day_incomplete'],
    [3, 'unreadable_amount'],
  ]);
  assert.deepEqual(r.days.map((d) => [d.day, d.status]), [
    ['2026-09-01', 'incomplete'],
    ['2026-09-02', 'new'],
  ]);
  assert.deepEqual(ids(r.settlement), ['day:2026-09-02#1']);
  book(t, r.settlement);
  const good = must(read(t, [...D1, ...D2]));
  assert.equal(dayOf(good, '2026-09-01').status, 'new', 'nothing of the incomplete day was recorded');
  const res = book(t, good.settlement);
  assert.equal(res.booked, 2);
  assert.equal(res.alreadyImported, 1);
  // Another currency stays excluded and leaves the day whole.
  const t2 = dayWorld();
  must(setSettlementTableMapping(t2.pctx, { ...src, mapping: { ...DAY_MAPPING, columns: { ...DAY_MAPPING.columns, currency: 'Typ' }, kindMap: {} }, headers: HEADERS, idempotencyKey: 'cur', confirmIdChange: true }));
  const cur = must(read(t2, ['05.09.2026;Gipfeli;EUR;12,50', '05.09.2026;Brot;CHF;7,80']));
  assert.deepEqual(cur.refusedRows.map((x) => x.code), ['currency_mismatch']);
  assert.equal(dayOf(cur, '2026-09-05').status, 'new');
  // A row whose day cannot be read could belong to any day: the whole file refuses.
  const bad = refused(read(t, ['01.09.2026;Gipfeli;Verkauf;12,50', '31.09.2026;Brot;Verkauf;7,80']), 'unreadable_day');
  assert.deepEqual(bad.rowNumbers, [3]);
  assert.equal(bad.mapping.wholeDays, true, 'the mapping so far, so the mapping step can fix the date format');
});

// 9. a kindMap correction ------------------------------------------------------------------------------------

test('9. a kindMap correction keeps the ids: the held day passes through and the import answers event_amended', () => {
  const t = dayWorld();
  const lines = ['01.09.2026;Gutschein;Geschenk;20,00', ...D1];
  const first = must(read(t, lines));
  assert.equal(first.settlement.events.find((e) => e.amount === '20.00').kind, 'other');
  book(t, first.settlement);
  const held = books(t);
  must(setSettlementTableMapping(t.pctx, { ...src, mapping: { ...DAY_MAPPING, kindMap: { ...DAY_MAPPING.kindMap, geschenk: 'refund' } }, headers: HEADERS, idempotencyKey: 'km-2' }));
  const corrected = must(read(t, lines));
  assert.deepEqual(ids(corrected.settlement), ids(first.settlement));
  assert.equal(dayOf(corrected, '2026-09-01').status, 'passed');
  const res = book(t, corrected.settlement);
  // The 20.00 was left to a person (kind other): it books now as the corrected kind; the booked ones stay.
  assert.deepEqual(res.events.map((e) => e.outcome), ['booked', 'already_imported', 'already_imported']);
  assert.equal(books(t).entries, held.entries + 1);
  // A kind correction of a BOOKED row: same id, the import refuses event_amended, nothing books twice.
  must(setSettlementTableMapping(t.pctx, { ...src, mapping: { ...DAY_MAPPING, kindMap: { verkauf: 'refund', geschenk: 'refund' } }, headers: HEADERS, idempotencyKey: 'km-3' }));
  const after = books(t);
  const amended = book(t, must(read(t, lines)).settlement);
  assert.ok(amended.events.filter((e) => e.amountMinor !== 2000 && e.amountMinor !== -2000).every((e) => e.code === 'event_amended'));
  assert.deepEqual(books(t), after);
});

// 10. edge days ----------------------------------------------------------------------------------------------

const edgeAudits = (t) => t.store.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND action = 'confirm_edge_day'").get(t.workspaceId).n;

test('10. edge days under ask: the import withholds the first and last day unless ITS call carries a person\'s answer, then books them and audits it', () => {
  const t = dayWorld({ edges: 'ask' });
  const lines = [...D1, ...D2, ...D3];
  const r = must(read(t, lines));
  assert.deepEqual(r.edgeDays, { mode: 'ask', first: '2026-09-01', last: '2026-09-03', confirmed: [] });
  assert.deepEqual(r.days.map((d) => [d.day, d.status, d.edge]), [
    ['2026-09-01', 'edge_unconfirmed', 'first'],
    ['2026-09-02', 'new', null],
    ['2026-09-03', 'edge_unconfirmed', 'last'],
  ]);
  assert.equal(r.settlement.events.length, 5, 'the door keeps the edges in the document: the import decides them');
  // Without the call's answer the import books only the inner day.
  const first = book(t, r.settlement);
  assert.deepEqual(first.events.map((e) => [e.day, e.outcome, e.code ?? null]), [
    ['2026-09-01', 'refused', 'edge_day_unconfirmed'],
    ['2026-09-01', 'refused', 'edge_day_unconfirmed'],
    ['2026-09-02', 'booked', null],
    ['2026-09-03', 'refused', 'edge_day_unconfirmed'],
    ['2026-09-03', 'refused', 'edge_day_unconfirmed'],
  ]);
  assert.equal(edgeAudits(t), 0);
  // The review previews the answer exactly as the import will do it.
  const confirmEdgeDays = ['2026-09-01', '2026-09-03'];
  const review = must(settlementReview(t.pctx, { settlement: r.settlement, from: '2026-07-01', to: '2026-09-30', confirmEdgeDays }));
  assert.equal(review.toBook, 4);
  // The person's answer in the call: the edges book (their events were never recorded, so they are still new).
  const held = books(t);
  const answered = must(importSettlement(t.pctx, { settlement: r.settlement, confirmEdgeDays, expectReviewSha256: review.reviewSha256, idempotencyKey: 'edge-ok' }));
  assert.equal(answered.booked, 4);
  assert.equal(answered.alreadyImported, 1);
  assert.equal(books(t).entries, held.entries + 4);
  assert.equal(edgeAudits(t), 2, 'one confirm_edge_day per day the answer let in');
});

test('10a. security review: a document that claims its edge days are complete is not believed; an agent seat\'s answer is refused or drafted, and books no edge day', () => {
  const t = dayWorld({ edges: 'ask' });
  const r = must(read(t, [...D1, ...D2, ...D3]));
  // A hand-edited document claiming a person confirmed the edges (any refs field): the import reads the call only.
  const forged = { ...r.settlement, events: r.settlement.events.map((e) => ({ ...e, refs: { ...e.refs, tableEdgeDay: 'complete', confirmEdgeDays: ['2026-09-01', '2026-09-03'] } })) };
  const res = book(t, forged);
  assert.deepEqual(res.events.filter((e) => e.outcome === 'booked').map((e) => e.day), ['2026-09-02']);
  assert.equal(edgeAudits(t), 0);
  // An agent seat sending the answer: refused when it executes, while the draft check lets it through (a Vorschlag
  // whose card shows the days; the approving person replays it as their own answer).
  const agent = agentCtx(t);
  const input = { settlement: r.settlement, confirmEdgeDays: ['2026-09-01', '2026-09-03'], idempotencyKey: 'agent-edge' };
  assert.equal(prevalidateImportSettlement(agent, input), undefined);
  const held = books(t);
  refused(importSettlement(agent, input), 'person_decides');
  assert.deepEqual(books(t), held);
  assert.equal(edgeAudits(t), 0);
  // The approval never adds the answer (APPROVAL_CONFIRM_NOT_SET), and the door refuses no preview of it.
  assert.equal(APPROVAL_CONFIRMS_FIELD['import_settlement'], undefined);
  assert.match(APPROVAL_CONFIRM_NOT_SET['import_settlement'], /confirmEdgeDays and fileDays are never set by the approval/);
});

test('10b. edge days under include and exclude; a day of today or later never imports, at the door or in the import', () => {
  const lines = [...D1, ...D2, ...D3];
  const inc = dayWorld({ edges: 'include' });
  const ri = must(read(inc, lines));
  assert.deepEqual(ri.days.map((d) => d.status), ['new', 'new', 'new']);
  assert.equal(book(inc, ri.settlement).booked, 5);
  const exc = dayWorld({ edges: 'exclude' });
  const ex = must(read(exc, lines, { confirmEdgeDays: ['2026-09-01', '2026-09-03'] }));
  assert.deepEqual(ex.days.map((d) => d.status), ['edge_excluded', 'new', 'edge_excluded'], 'exclude ignores an answer');
  const exRes = must(importSettlement(exc.pctx, { settlement: ex.settlement, confirmEdgeDays: ['2026-09-01', '2026-09-03'], idempotencyKey: 'exc' }));
  assert.deepEqual(exRes.events.map((e) => e.code ?? e.outcome), ['edge_day_excluded', 'edge_day_excluded', 'booked', 'edge_day_excluded', 'edge_day_excluded']);
  assert.equal(edgeAudits(exc), 0);
  // Today is 05.10.2026.
  const today = must(read(inc, ['04.10.2026;Brot;Verkauf;7,80', '05.10.2026;Brot;Verkauf;7,80', '06.10.2026;Brot;Verkauf;7,80']));
  assert.deepEqual(today.days.map((d) => [d.day, d.status]), [
    ['2026-10-04', 'new'],
    ['2026-10-05', 'not_over'],
    ['2026-10-06', 'not_over'],
  ]);
  assert.deepEqual(ids(today.settlement), ['day:2026-10-04#1']);
  // The import checks it too: the 04.10 document booked by a clock that still reads 04.10 refuses day_not_over.
  const early = personCtx(inc, '2026-10-04T08:00:00.000Z');
  const res = book(inc, today.settlement, early);
  assert.deepEqual(res.events.map((e) => e.code), ['day_not_over']);
});

// 11 and 12. the guards ----------------------------------------------------------------------------------------

test('12. the default column still refuses an id-less table, with or without wholeDays; id_not_unique stands', () => {
  const t = settlementWorld({ at: NOW });
  t.pctx = personCtx(t);
  setTemplate(t);
  const r = refused(read(t, D1, { mapping: DAY_MAPPING }), 'id_column_missing');
  assert.equal(r.dayModeAvailable, false);
  refused(setSettlementTableMapping(t.pctx, { ...src, mapping: DAY_MAPPING, headers: HEADERS, idempotencyKey: 'def' }), 'id_column_missing');
  setting(t, 'settlement.table_event_id', 'column_else_day');
  // The mode on, but the mapping does not say whole days: still refused, and the refusal says the mode is there.
  const { wholeDays: _w, ...noFlag } = DAY_MAPPING;
  assert.equal(refused(read(t, D1, { mapping: noFlag }), 'id_column_missing').dayModeAvailable, true);
  // An id column wins over the flag: duplicates still refuse id_not_unique.
  const withId = { ...DAY_MAPPING, columns: { ...DAY_MAPPING.columns, id: ['Datum', 'Text'] } };
  const dup = must(read(t, ['01.09.2026;Brot;Verkauf;7,80', '01.09.2026;Brot;Verkauf;7,80'], { mapping: withId }));
  assert.equal(dup.dayMode, false);
  assert.deepEqual(dup.refusedRows.map((x) => x.code), ['id_not_unique', 'id_not_unique']);
});

test('12b. the import books whole-day events only from a whole-day mapping a person saved, under the setting', () => {
  const t = dayWorld();
  const doc = must(read(t, D1)).settlement;
  setting(t, 'settlement.table_event_id', 'column');
  assert.equal(refused(importSettlement(t.pctx, { settlement: doc, idempotencyKey: 'off' }), 'day_mode_unconfirmed').cause, 'setting');
  setting(t, 'settlement.table_event_id', 'column_else_day');
  // A hand-written document with day ids and no recipe is refused whole too.
  const forged = jsonDoc([sale('day:2026-09-01#1', '2026-09-01', '7.80', '7.22', '0.58')]);
  assert.equal(refused(importSettlement(t.pctx, { settlement: forged, idempotencyKey: 'forged' }), 'day_mode_unconfirmed').cause, 'recipe');
  // A given (unsaved) whole-day mapping previews, but its events do not book until a person saves it.
  const t2 = dayWorld({ save: false });
  const preview = must(read(t2, D1, { mapping: DAY_MAPPING }));
  assert.equal(preview.dayMode, true);
  assert.equal(refused(importSettlement(t2.pctx, { settlement: preview.settlement, idempotencyKey: 'unsaved' }), 'day_mode_unconfirmed').cause, 'mapping');
});

test('a governed seat proposes the whole-day flag; a person confirms it, audited', () => {
  const t = dayWorld({ save: false });
  const agent = agentCtx(t);
  const input = { ...src, mapping: DAY_MAPPING, headers: HEADERS, idempotencyKey: 'ag-wd' };
  assert.equal(prevalidateSetSettlementTableMapping(agent, input), undefined, 'the draft check lets the proposal through');
  refused(setSettlementTableMapping(agent, input), 'person_decides');
  must(setSettlementTableMapping(t.pctx, { ...input, idempotencyKey: 'p-wd' }));
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND action = 'confirm_whole_days'").get(t.workspaceId).n, 1);
  // A save that keeps the flag is no new confirmation.
  must(setSettlementTableMapping(t.pctx, { ...input, mapping: { ...DAY_MAPPING, amountSign: 'by_kind' }, idempotencyKey: 'p-wd-2' }));
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND action = 'confirm_whole_days'").get(t.workspaceId).n, 1);
});

test('F7: after a confirmed change from whole days to an id column, the days held by whole-day ids stay gated', () => {
  const t = dayWorld();
  book(t, must(read(t, D1)).settlement);
  const held = books(t);
  const withId = { ...DAY_MAPPING, wholeDays: false, columns: { ...DAY_MAPPING.columns, id: ['Datum', 'Text'] } };
  refused(setSettlementTableMapping(t.pctx, { ...src, mapping: withId, headers: HEADERS, idempotencyKey: 'to-id' }), 'event_id_derivation_changed');
  must(setSettlementTableMapping(t.pctx, { ...src, mapping: withId, headers: HEADERS, confirmIdChange: true, idempotencyKey: 'to-id-ok' }));
  const r = must(read(t, [...D1, ...D2]));
  assert.equal(r.dayMode, false);
  assert.deepEqual(r.days.map((d) => [d.day, d.status]), [['2026-09-01', 'in_books']]);
  assert.deepEqual(r.settlement.events.map((e) => e.day), ['2026-09-02'], 'only the day the books do not hold');
  const res = book(t, r.settlement);
  assert.equal(res.booked, 1);
  assert.equal(books(t).entries, held.entries + 1);
});

// 13. invariants (to be reviewed by a non-author) ----------------------------------------------------------------

test('[INVARIANT] the entry count and the clearing balance are unchanged after any re-import of a whole-day table', () => {
  const t = dayWorld();
  const lines = [...D1, ...D2, ...D3];
  book(t, must(read(t, lines)).settlement);
  const held = books(t);
  const variants = [
    lines,
    [...lines].reverse(),
    [...D3, ...D1],
    [...D1, '01.09.2026;Torte;Verkauf;30,00'],
    ['01.09.2026;Gipfeli;Verkauf;12,50'],
    [...D2, '02.09.2026;Gipfeli;Verkauf;12,50'],
  ];
  for (const [k, v] of variants.entries()) {
    const r = must(read(t, v));
    book(t, r.settlement);
    assert.deepEqual(books(t), held, `re-import ${k}`);
    // The review (the import rolled back) changes nothing either.
    must(settlementReview(t.pctx, { settlement: r.settlement, from: '2026-07-01', to: '2026-09-30' }));
    assert.deepEqual(books(t), held, `review ${k}`);
  }
});

test('[INVARIANT tenant] a second workspace\'s held days never gate the first', () => {
  const t = dayWorld();
  const b = secondWorkspace(t);
  const bctx = makeContext(t.store, { workspaceId: b.workspaceId, actor: 'user_2', clock: fixedClock(NOW), ids: t.ids });
  must(setSettlementTemplate(bctx, { ...src, clearingAccountId: b.acc('1020'), kinds: { sale: { action: 'book', accountId: b.acc('3400'), taxCode: 'UST81' } }, idempotencyKey: 'tpl-b' }));
  must(importSettlement(bctx, { settlement: jsonDoc([sale('json-1', '2026-09-01', '12.50', '11.56', '0.94')]), idempotencyKey: 'b-json' }));
  const r = must(read(t, D1));
  assert.equal(dayOf(r, '2026-09-01').status, 'new');
  assert.equal(book(t, r.settlement).booked, 2);
  // And the first workspace's whole-day events never gate the second.
  const bday = t.store.db.prepare("SELECT COUNT(*) AS n FROM settlement_feed_event WHERE workspace_id = ? AND event_id LIKE 'day:%'").get(b.workspaceId).n;
  assert.equal(bday, 0);
});

// 14. offset timestamps -----------------------------------------------------------------------------------------

test('14. offset timestamps: a re-export in another zone lands every row on the same company day; nothing doubles', () => {
  const t = dayWorld({ save: false });
  const headers = ['Zeit', 'Betrag'];
  const mapping = { columns: { day: 'Zeit', amount: 'Betrag' }, dateFormat: 'yyyy-mm-dd', wholeDays: true };
  must(setSettlementTableMapping(t.pctx, { ...src, mapping, headers, idempotencyKey: 'tz-map' }));
  const local = 'Zeit;Betrag\n2026-09-01 10:00:00 +0200;12.50\n2026-09-02 00:30:00 +0200;7.80\n2026-09-02 15:00:00 +0200;5.00';
  const r = must(settlementFromTable(t.pctx, { ...src, content: local }));
  assert.deepEqual(r.settlement.events.map((e) => e.day), ['2026-09-01', '2026-09-02', '2026-09-02'], 'the company day (Europe/Zurich) of each instant');
  book(t, r.settlement);
  const held = books(t);
  const utc = 'Zeit;Betrag\n2026-09-01 08:00:00 +0000;12.50\n2026-09-01 22:30:00 +0000;7.80\n2026-09-02 13:00:00 +0000;5.00';
  const again = must(settlementFromTable(t.pctx, { ...src, content: utc }));
  assert.deepEqual(again.days.map((d) => [d.day, d.status]), [
    ['2026-09-01', 'passed'],
    ['2026-09-02', 'passed'],
  ]);
  assert.equal(book(t, again.settlement).alreadyImported, 3);
  assert.deepEqual(books(t), held);
});

test('14a. critic r1 H1 repro: a +0000 file then a +0200 re-export with new days: the 7.80 never books twice', () => {
  const t = dayWorld({ save: false });
  const headers = ['Zeit', 'Betrag'];
  const mapping = { columns: { day: 'Zeit', amount: 'Betrag' }, dateFormat: 'yyyy-mm-dd', wholeDays: true };
  must(setSettlementTableMapping(t.pctx, { ...src, mapping, headers, idempotencyKey: 'h1-map' }));
  book(t, must(settlementFromTable(t.pctx, { ...src, content: 'Zeit;Betrag\n2026-09-01 08:00 +0000;12.50\n2026-09-01 22:30 +0000;7.80' })).settlement);
  const held = books(t);
  const file2 = 'Zeit;Betrag\n2026-09-01 10:00 +0200;12.50\n2026-09-02 00:30 +0200;7.80\n2026-09-02 15:00 +0200;5.00\n2026-09-03 09:00 +0200;1.00';
  const r = must(settlementFromTable(t.pctx, { ...src, content: file2 }));
  // 22:30 UTC on 01.09 is 00:30 on 02.09 in Zurich: the 7.80 sits on 02.09 in both files.
  assert.deepEqual(r.days.map((d) => [d.day, d.status]), [
    ['2026-09-01', 'passed'],
    ['2026-09-02', 'differs'],
    ['2026-09-03', 'new'],
  ]);
  book(t, r.settlement);
  // Only the 1.00 of the new day books; 02.09 (7.80 held, 5.00 new) is the person's to book by hand.
  assert.equal(books(t).entries, held.entries + 1);
  assert.equal(books(t).clearing - held.clearing, 100);
});

test('14b. a Z or UTC time is one instant: 23:30Z on 01.09 is 02.09 in Zurich', () => {
  const t = dayWorld({ save: false });
  const mapping = { columns: { day: 'Zeit', amount: 'Betrag' }, dateFormat: 'yyyy-mm-dd', wholeDays: true };
  must(setSettlementTableMapping(t.pctx, { ...src, mapping, headers: ['Zeit', 'Betrag'], idempotencyKey: 'z-map' }));
  const r = must(settlementFromTable(t.pctx, { ...src, content: 'Zeit;Betrag\n2026-09-01T23:30:00Z;9.00\n2026-09-03 23:30 UTC;4.00\n2026-09-04 12:00;2.00' }));
  assert.deepEqual(r.settlement.events.map((e) => [e.id.slice(0, 14), e.day]), [
    ['day:2026-09-02', '2026-09-02'],
    ['day:2026-09-04', '2026-09-04'],
    ['day:2026-09-04', '2026-09-04'],
  ], 'a cell without a zone keeps its written day');
});

test('14c. no zone: a row a re-export moved across midnight books nothing on either day, at the door and inside the import', () => {
  const t = dayWorld({ save: false });
  const mapping = { columns: { day: 'Zeit', amount: 'Betrag' }, dateFormat: 'yyyy-mm-dd', wholeDays: true };
  must(setSettlementTableMapping(t.pctx, { ...src, mapping, headers: ['Zeit', 'Betrag'], idempotencyKey: 'nz-map' }));
  const file2 = 'Zeit;Betrag\n2026-09-01 10:00;12.50\n2026-09-02 00:30;7.80\n2026-09-02 15:00;5.00';
  // Read while both days are new (a preview kept open), then the first export is booked.
  const early = must(settlementFromTable(t.pctx, { ...src, content: file2 }));
  book(t, must(settlementFromTable(t.pctx, { ...src, content: 'Zeit;Betrag\n2026-09-01 10:00;12.50\n2026-09-01 23:30;7.80' })).settlement);
  const held = books(t);
  const r = must(settlementFromTable(t.pctx, { ...src, content: file2 }));
  assert.deepEqual(r.days.map((d) => [d.day, d.status, d.movedFrom ?? null]), [
    ['2026-09-01', 'differs', null],
    ['2026-09-02', 'differs', '2026-09-01'],
  ]);
  assert.ok(r.settlement.warnings.some((w) => w.includes('moved across midnight')));
  book(t, r.settlement);
  assert.deepEqual(books(t), held, 'the door left both days out');
  // THE CHOKEPOINT: the early document still holds both days; the import refuses them itself.
  const res = book(t, early.settlement);
  assert.deepEqual(res.events.map((e) => [e.day, e.code ?? e.outcome]), [
    ['2026-09-01', 'day_differs'],
    ['2026-09-02', 'day_differs'],
    ['2026-09-02', 'day_differs'],
  ]);
  assert.deepEqual(books(t), held);
});

test('14d. an ordinary overlapping export never stalls: a new day next to a differing day books when no amount moved', () => {
  const t = dayWorld();
  book(t, must(read(t, D1)).settlement);
  const held = books(t);
  const r = must(read(t, [...D1, '01.09.2026;Zopf;Verkauf;3,00', ...D2]));
  assert.deepEqual(r.days.map((d) => [d.day, d.status]), [
    ['2026-09-01', 'differs'],
    ['2026-09-02', 'new'],
  ]);
  book(t, r.settlement);
  assert.equal(books(t).entries, held.entries + 1, 'the 30.00 of 02.09 books');
});

test('10c. critic r1 M2: a file reviewed by quarter keeps the FILE\'s edges (fileDays): a mid-file day at the quarter end is no edge', () => {
  const t = dayWorld({ edges: 'exclude' });
  const lines = ['28.09.2026;A;Verkauf;1,00', '30.09.2026;B;Verkauf;2,00', '01.10.2026;C;Verkauf;3,00', '03.10.2026;D;Verkauf;4,00'];
  const r = must(read(t, lines));
  assert.deepEqual([r.edgeDays.first, r.edgeDays.last], ['2026-09-28', '2026-10-03']);
  const fileDays = { first: r.edgeDays.first, last: r.edgeDays.last };
  const part = (from, to) => ({ ...r.settlement, events: r.settlement.events.filter((e) => e.day >= from && e.day <= to) });
  const q3 = must(importSettlement(t.pctx, { settlement: part('2026-07-01', '2026-09-30'), fileDays, idempotencyKey: 'q3' }));
  assert.deepEqual(q3.events.map((e) => [e.day, e.code ?? e.outcome]), [
    ['2026-09-28', 'edge_day_excluded'],
    ['2026-09-30', 'booked'],
  ]);
  const q4 = must(importSettlement(t.pctx, { settlement: part('2026-10-01', '2026-12-31'), fileDays, idempotencyKey: 'q4' }));
  assert.deepEqual(q4.events.map((e) => [e.day, e.code ?? e.outcome]), [
    ['2026-10-01', 'booked'],
    ['2026-10-03', 'edge_day_excluded'],
  ]);
  // The review agrees with the import, and under ask it asks only about the file's own edges.
  const asked = dayWorld({ edges: 'ask' });
  const ra = must(read(asked, lines));
  const rv = must(settlementReview(asked.pctx, { settlement: { ...ra.settlement, events: ra.settlement.events.filter((e) => e.day <= '2026-09-30') }, from: '2026-07-01', to: '2026-09-30', fileDays: { first: ra.edgeDays.first, last: ra.edgeDays.last } }));
  assert.deepEqual(rv.rows.filter((x) => x.code === 'edge_day_unconfirmed').map((x) => x.day), ['2026-09-28']);
});

test('10d. fileDays is a person\'s input that must cover the document: an agent seat is refused, a narrower range is invalid', () => {
  const t = dayWorld({ edges: 'exclude' });
  const r = must(read(t, [...D1, ...D2]));
  refused(importSettlement(t.pctx, { settlement: r.settlement, fileDays: { first: '2026-09-02', last: '2026-09-02' }, idempotencyKey: 'narrow' }), 'invalid_input');
  refused(importSettlement(t.pctx, { settlement: r.settlement, fileDays: { first: '2026-09-03', last: '2026-09-01' }, idempotencyKey: 'backwards' }), 'invalid_input');
  refused(importSettlement(agentCtx(t), { settlement: r.settlement, fileDays: { first: '2026-08-01', last: '2026-09-30' }, idempotencyKey: 'agent-wide' }), 'person_decides');
});

test('F7 inside the import (critic r1 L2): an id-column event on a day held by whole-day ids refuses day_differs', () => {
  const t = dayWorld();
  book(t, must(read(t, D1)).settlement);
  const held = books(t);
  const withId = { ...DAY_MAPPING, wholeDays: false, columns: { ...DAY_MAPPING.columns, id: ['Datum', 'Text'] } };
  must(setSettlementTableMapping(t.pctx, { ...src, mapping: withId, headers: HEADERS, confirmIdChange: true, idempotencyKey: 'to-id-l2' }));
  const r = must(read(t, D2));
  // The person's own copy of the door's document, its one event moved onto the held day (a hand-edited file).
  const doc = { ...r.settlement, events: r.settlement.events.map((e) => ({ ...e, id: `${e.id}-x`, day: '2026-09-01' })) };
  const res = book(t, doc);
  assert.deepEqual(res.events.map((e) => e.code ?? e.outcome), ['day_differs']);
  assert.deepEqual(books(t), held);
});

test('critic r1 L4: the confirm_edge_day audit row names its day', () => {
  const t = dayWorld({ edges: 'ask' });
  const r = must(read(t, [...D1, ...D2]));
  must(importSettlement(t.pctx, { settlement: r.settlement, confirmEdgeDays: ['2026-09-01', '2026-09-02'], idempotencyKey: 'edge-named' }));
  const named = t.store.db.prepare("SELECT entity_id FROM audit_log WHERE workspace_id = ? AND action = 'confirm_edge_day' ORDER BY entity_id").all(t.workspaceId).map((x) => x.entity_id.split('#')[1]);
  assert.deepEqual(named, ['2026-09-01', '2026-09-02']);
});

// --- critic r2 -----------------------------------------------------------------------------------------------

/** A zone-less till export by time: the r2 world (the mapping saved, the edge mode as given). */
function zonelessWorld(edges) {
  // The first export books whole under include; then the edge rule of the test applies to the re-export.
  const t = dayWorld({ edges: 'include', save: false });
  const mapping = { columns: { day: 'Zeit', amount: 'Betrag' }, dateFormat: 'yyyy-mm-dd', wholeDays: true };
  must(setSettlementTableMapping(t.pctx, { ...src, mapping, headers: ['Zeit', 'Betrag'], idempotencyKey: `r2-map-${edges}` }));
  book(t, must(settlementFromTable(t.pctx, { ...src, content: 'Zeit;Betrag\n2026-08-31 09:00:00;3.00\n2026-09-01 08:00:00;12.50\n2026-09-01 22:30:00;7.80' })).settlement);
  if (edges !== 'include') setting(t, 'settlement.table_edge_days', edges);
  return t;
}
/** Exported in another zone from 02.09: the 7.80 of 01.09 22:30 now reads 02.09 00:30, and 01.09 is not in the file. */
const MOVED_START = 'Zeit;Betrag\n2026-09-02 00:30:00;7.80\n2026-09-02 15:00:00;5.00\n2026-09-03 09:00:00;1.00';

test('r2 M-A: a zone-less re-export that STARTS on the day a row moved onto asks a person, naming the amount, even under include', () => {
  const t = zonelessWorld('include');
  const held = books(t);
  const r = must(settlementFromTable(t.pctx, { ...src, content: MOVED_START }));
  assert.deepEqual(r.days.map((d) => [d.day, d.status, d.nearHeld ?? null]), [
    ['2026-09-02', 'edge_unconfirmed', { day: '2026-09-01', amountsMinor: [780] }],
    ['2026-09-03', 'new', null],
  ]);
  assert.ok(r.settlement.warnings.some((w) => w.includes('Day 2026-09-02 shares 7.80 with 2026-09-01')));
  // THE CHOKEPOINT: the door's document still carries 02.09; the import refuses it itself, without an answer.
  const res = book(t, r.settlement);
  assert.deepEqual(res.events.map((e) => [e.day, e.code ?? e.outcome]), [
    ['2026-09-02', 'edge_day_unconfirmed'],
    ['2026-09-02', 'edge_day_unconfirmed'],
    ['2026-09-03', 'booked'],
  ]);
  assert.equal(books(t).clearing - held.clearing, 100, 'only the 1.00 of 03.09');
  // THE ACCEPTED RESIDUAL (owner, 18.11.2026): a person who confirms the day books it, the moved 7.80 included.
  const after = books(t);
  must(importSettlement(t.pctx, { settlement: r.settlement, confirmEdgeDays: ['2026-09-02'], idempotencyKey: 'r2-confirm' }));
  assert.equal(books(t).clearing - after.clearing, 1280, 'the residual A43 §2 states: the person\'s answer books the day whole');
  const audited = t.store.db.prepare("SELECT entity_id FROM audit_log WHERE workspace_id = ? AND action = 'confirm_edge_day'").all(t.workspaceId).map((x) => x.entity_id.split('#')[1]);
  assert.deepEqual(audited, ['2026-09-02'], 'the answer that let it in is audited, under include too');
});

test('r2 M-A: under ask the question names the amount; under exclude the day stays out; no shared amount never asks under include', () => {
  const asked = zonelessWorld('ask');
  const ra = must(settlementFromTable(asked.pctx, { ...src, content: MOVED_START }));
  assert.deepEqual(dayOf(ra, '2026-09-02').nearHeld, { day: '2026-09-01', amountsMinor: [780] });
  const excluded = zonelessWorld('exclude');
  const rx = must(settlementFromTable(excluded.pctx, { ...src, content: MOVED_START }));
  assert.equal(dayOf(rx, '2026-09-02').status, 'edge_excluded');
  // An ordinary next export (nothing shared with the held 01.09) books its edges under include, never stalls.
  const plain = zonelessWorld('include');
  const before = books(plain);
  const rp = must(settlementFromTable(plain.pctx, { ...src, content: 'Zeit;Betrag\n2026-09-02 15:00:00;5.00\n2026-09-03 09:00:00;1.00' }));
  assert.deepEqual(rp.days.map((d) => [d.day, d.status, d.nearHeld ?? null]), [
    ['2026-09-02', 'new', null],
    ['2026-09-03', 'new', null],
  ]);
  book(plain, rp.settlement);
  assert.equal(books(plain).clearing - before.clearing, 600);
});

test('r2 M-B: a fileDays wider than the document takes its edges off, and each such day is audited file_days_inner', () => {
  const t = dayWorld({ edges: 'exclude' });
  const r = must(read(t, [...D1, ...D2, ...D3]));
  const wide = { first: '2026-08-01', last: '2026-09-30' };
  const res = must(importSettlement(t.pctx, { settlement: r.settlement, fileDays: wide, idempotencyKey: 'wide-x' }));
  assert.equal(res.booked, 5, 'the person said the file runs wider: no edge of the document is an edge');
  const inner = (w) => w.store.db.prepare("SELECT entity_id FROM audit_log WHERE workspace_id = ? AND action = 'file_days_inner' ORDER BY entity_id").all(w.workspaceId).map((x) => x.entity_id.split('#')[1]);
  assert.deepEqual(inner(t), ['2026-09-01', '2026-09-03']);
  // Under ask: no answer, no confirm_edge_day, and the same two days audited.
  const a = dayWorld({ edges: 'ask' });
  const ra = must(read(a, [...D1, ...D2, ...D3]));
  must(importSettlement(a.pctx, { settlement: ra.settlement, fileDays: wide, idempotencyKey: 'wide-a' }));
  assert.deepEqual(inner(a), ['2026-09-01', '2026-09-03']);
  assert.equal(edgeAudits(a), 0);
  // The Studio's own fileDays (the door's edges) moves nothing: no row.
  const s = dayWorld({ edges: 'exclude' });
  const rs = must(read(s, [...D1, ...D2, ...D3]));
  must(importSettlement(s.pctx, { settlement: rs.settlement, fileDays: { first: rs.edgeDays.first, last: rs.edgeDays.last }, idempotencyKey: 'own' }));
  assert.deepEqual(inner(s), []);
  // The approval never adds it either.
  assert.match(APPROVAL_CONFIRM_NOT_SET['import_settlement'], /fileDays/);
});

test('r2 L-B: text after the time that is no known zone makes the day unreadable; AM/PM is read as a 12-hour time', () => {
  const t = dayWorld({ save: false });
  const mapping = { columns: { day: 'Zeit', amount: 'Betrag' }, dateFormat: 'yyyy-mm-dd', wholeDays: true };
  must(setSettlementTableMapping(t.pctx, { ...src, mapping, headers: ['Zeit', 'Betrag'], idempotencyKey: 'lb-map' }));
  for (const cell of ['2026-09-01 22:30:00 CEST', '2026-09-01 22:30 GMT+2', '2026-09-01 22:30 +2', '2026-09-01 22:30 +02:0', '2026-09-01 22:30:00 +0000 (UTC)', '2026-09-01 13:30 PM']) {
    refused(settlementFromTable(t.pctx, { ...src, content: `Zeit;Betrag\n${cell};9.00` }), 'unreadable_day');
  }
  const r = must(settlementFromTable(t.pctx, { ...src, content: 'Zeit;Betrag\n2026-09-01 10:30 PM +0000;9.00\n2026-09-03 11:30 PM;4.00\n2026-09-04 12:15 AM +0200;2.00' }));
  assert.deepEqual(r.settlement.events.map((e) => e.day), ['2026-09-02', '2026-09-03', '2026-09-04'], '22:30 UTC is 00:30 in Zurich; a time without a zone keeps its day');
});

// --- critic r3 -----------------------------------------------------------------------------------------------

test('r3 H-1: a held day the re-export has no row for differs, so its late sale moved onto the next day never books twice', () => {
  const t = dayWorld({ save: false });
  const mapping = { columns: { day: 'Zeit', amount: 'Betrag' }, dateFormat: 'yyyy-mm-dd', wholeDays: true };
  must(setSettlementTableMapping(t.pctx, { ...src, mapping, headers: ['Zeit', 'Betrag'], idempotencyKey: 'r3-map' }));
  const file2 = 'Zeit;Betrag\n2026-08-31 11:00:00;3.00\n2026-09-02 00:30:00;7.80\n2026-09-02 14:00:00;4.00\n2026-09-03 11:00:00;1.00';
  // Read while nothing is held (a preview kept open), then the first export (01.09 holds one late sale) is booked.
  const early = must(settlementFromTable(t.pctx, { ...src, content: file2 }));
  book(t, must(settlementFromTable(t.pctx, { ...src, content: 'Zeit;Betrag\n2026-08-31 09:00:00;3.00\n2026-09-01 22:30:00;7.80' })).settlement);
  const held = books(t);
  const r = must(settlementFromTable(t.pctx, { ...src, content: file2 }));
  assert.deepEqual(r.days.map((d) => [d.day, d.status, d.rows.length, d.movedFrom ?? null]), [
    ['2026-08-31', 'passed', 1, null],
    ['2026-09-01', 'differs', 0, null],
    ['2026-09-02', 'differs', 2, '2026-09-01'],
    ['2026-09-03', 'new', 1, null],
  ]);
  assert.ok(r.settlement.warnings.some((w) => w.includes('lists no row for it')));
  book(t, r.settlement);
  assert.equal(books(t).clearing - held.clearing, 100, 'only the 1.00 of 03.09; the 02.09 is the person\'s to book by hand');
  // THE CHOKEPOINT: the early document still holds 02.09; the import finds the silent 01.09 itself.
  const res = book(t, early.settlement);
  assert.deepEqual(res.events.filter((e) => e.day === '2026-09-02').map((e) => e.code ?? e.outcome), ['day_differs', 'day_differs']);
  assert.equal(books(t).clearing - held.clearing, 100);
});

test('r3: a held day silent in the file stalls only a neighbour carrying one of its amounts; fees never make an edge ask', () => {
  const t = dayWorld();
  book(t, must(read(t, D2)).settlement);
  const held = books(t);
  // 02.09 (30.00) is held; the file lists 01.09 and 03.09 only: 02.09 differs, the neighbours carry no 30.00 and book.
  const r = must(read(t, [...D1, ...D3]));
  assert.deepEqual(r.days.map((d) => [d.day, d.status]), [
    ['2026-09-01', 'new'],
    ['2026-09-02', 'differs'],
    ['2026-09-03', 'new'],
  ]);
  book(t, r.settlement);
  assert.equal(books(t).entries, held.entries + 4);
  // A flat fee shared with the held neighbour is no reason to ask under include.
  const f = dayWorld({ save: false });
  const fm = { columns: { day: 'Datum', amount: 'Betrag', fee: 'Gebühr' }, dateFormat: 'dd.mm.yyyy', wholeDays: true };
  must(setSettlementTableMapping(f.pctx, { ...src, mapping: fm, headers: ['Datum', 'Betrag', 'Gebühr'], idempotencyKey: 'r3-fee' }));
  book(f, must(settlementFromTable(f.pctx, { ...src, content: 'Datum;Betrag;Gebühr\n01.09.2026;10.00;0.30' })).settlement);
  const rf = must(settlementFromTable(f.pctx, { ...src, content: 'Datum;Betrag;Gebühr\n02.09.2026;20.00;0.30' }));
  assert.deepEqual(rf.days.map((d) => [d.day, d.status, d.nearHeld ?? null]), [['2026-09-02', 'new', null]]);
});

test('r3 L-2: comma milliseconds and "Uhr" read as times without a zone', () => {
  const t = dayWorld({ save: false });
  const mapping = { columns: { day: 'Zeit', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', wholeDays: true };
  must(setSettlementTableMapping(t.pctx, { ...src, mapping, headers: ['Zeit', 'Betrag'], idempotencyKey: 'r3-uhr' }));
  const r = must(settlementFromTable(t.pctx, { ...src, content: 'Zeit;Betrag\n01.09.2026 22:30:00,000;9.00\n02.09.2026 22:30 Uhr;4.00\n03.09.2026 22:30:00,5 +0000;2.00' }));
  assert.deepEqual(r.settlement.events.map((e) => e.day), ['2026-09-01', '2026-09-02', '2026-09-04']);
});

// --- critic r4 -----------------------------------------------------------------------------------------------

/** The critic's r4 world: one fresh export with the same late price on 01.09 and 02.09, booked whole. */
function chainWorld(edges) {
  const t = dayWorld({ save: false });
  const mapping = { columns: { day: 'Zeit', amount: 'Betrag' }, dateFormat: 'yyyy-mm-dd', wholeDays: true };
  must(setSettlementTableMapping(t.pctx, { ...src, mapping, headers: ['Zeit', 'Betrag'], idempotencyKey: `r4-map-${edges}` }));
  book(t, must(settlementFromTable(t.pctx, { ...src, content: 'Zeit;Betrag\n2026-09-01 09:00:00;3.00\n2026-09-01 22:30:00;7.80\n2026-09-02 22:45:00;7.80' })).settlement);
  if (edges !== 'include') setting(t, 'settlement.table_edge_days', edges);
  return t;
}

test('r4 H-1: the same late price on two days, shifted one way: the interior day carrying the moved amount asks, never books silently', () => {
  for (const edges of ['include', 'ask']) {
    const t = chainWorld(edges);
    const held = books(t);
    const file2 = 'Zeit;Betrag\n2026-09-01 11:00:00;3.00\n2026-09-02 00:30:00;7.80\n2026-09-03 00:45:00;7.80\n2026-09-03 13:00:00;1.00\n2026-09-04 11:00:00;2.00';
    const r = must(settlementFromTable(t.pctx, { ...src, content: file2 }));
    const status = Object.fromEntries(r.days.map((d) => [d.day, [d.status, d.nearHeld ?? null]]));
    assert.deepEqual(status['2026-09-01'], ['differs', null], edges);
    assert.deepEqual(status['2026-09-02'], ['passed', null], edges);
    assert.deepEqual(status['2026-09-03'], ['edge_unconfirmed', { day: '2026-09-02', amountsMinor: [780] }], `${edges}: an interior day asks too`);
    // THE CHOKEPOINT: the import asks the same, whatever the document says.
    const res = book(t, r.settlement);
    assert.deepEqual(res.events.filter((e) => e.day === '2026-09-03').map((e) => e.code ?? e.outcome), ['edge_day_unconfirmed', 'edge_day_unconfirmed'], edges);
    assert.equal(books(t).clearing - held.clearing, edges === 'include' ? 200 : 0, `${edges}: only the 2.00 of 04.09 (an edge under ask waits too); the 7.80 never doubles`);
  }
});

test('r4: a chain that starts outside the file (the first day passes) still asks on the next day', () => {
  const t = chainWorld('include');
  const r = must(settlementFromTable(t.pctx, { ...src, content: 'Zeit;Betrag\n2026-09-02 00:30:00;7.80\n2026-09-03 00:45:00;7.80\n2026-09-03 13:00:00;1.00' }));
  assert.deepEqual(r.days.map((d) => [d.day, d.status]), [
    ['2026-09-02', 'passed'],
    ['2026-09-03', 'edge_unconfirmed'],
  ]);
});
