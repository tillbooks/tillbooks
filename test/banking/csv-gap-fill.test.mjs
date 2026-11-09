// A20 §12: filling a statement gap from the bank's own CSV export (the ZKB "Account statement" layout).
// Only the days no stored statement holds are taken; each stretch is proven by the CSV's running balance
// and tied to the statements on both sides; rows the books already hold are left out; a numbered gap a
// tied fill covers is closed; the balance line's feed start moves to the fill.
//
// SYNTHETIC DATA ONLY: every row, reference, name and amount below is invented here (ZKB-shaped, never
// copied from an export); the IBAN is the published PostFinance sample of bank-inbox-support.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { importCamt, listBankInbox, statementGaps } from '../../dist/core/banking/index.js';
import { importBankStatement, bankCsvPreview } from '../../dist/core/banking/statementImport.js';
import { guessCsvMapping, presetFor } from '../../dist/core/banking/csvMapping.js';
import { minusHeld } from '../../dist/core/banking/csvGapFill.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { assertClaimInvariantHolds, world, must, refused, camt, secondWorkspace } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

let n = 0;
const key = () => `fill-${(n += 1)}`;

const HEADER = ['Date', 'Booking text', 'Curr', 'Amount details', 'ZKB reference', 'Reference number', 'Debit CHF', 'Credit CHF', 'Value date', 'Balance CHF', 'Payment purpose', 'Details'];
const q = (v) => `"${v}"`;
const dmy = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const major = (minor) => (Math.abs(minor) / 100).toFixed(2);

/**
 * A ZKB-shaped export: BOM, CRLF, `;`, every field quoted, the NEWEST row first. `rows` are given oldest
 * first as { date, text, ref, minor (signed), balance?, details?, purpose? }; the running balance is
 * computed from `start` unless a row names its own (to model a broken chain).
 */
function zkbCsv(rows, { start }) {
  let bal = start;
  const lines = rows.map((r) => {
    bal += r.minor;
    const b = r.balance ?? bal;
    return [dmy(r.date), r.text, '', '', r.ref, '', r.minor < 0 ? major(r.minor) : '', r.minor > 0 ? major(r.minor) : '', dmy(r.valueDate ?? r.date), major(b), r.purpose ?? '', r.details ?? ''].map(q).join(';');
  });
  return `﻿${HEADER.map(q).join(';')}\r\n${lines.reverse().join('\r\n')}\r\n`;
}

/** A camt.053 day with AcctSvcrRef on each entry (the helper's NtryRef is kept as well). */
function camtDay({ id, seq, date, open, entries }) {
  let xml = camt({ statementId: id, seqNb: seq, from: date, to: date, openingMinor: open, entries });
  for (const e of entries) if (e.asr !== undefined) xml = xml.replace(`<NtryRef>${e.ref}</NtryRef>`, `<NtryRef>${e.ref}</NtryRef><AcctSvcrRef>${e.asr}</AcctSvcrRef>`);
  return xml;
}

/**
 * The invented book: the books' bank history ends on 05.03.2026 at CHF 1'965.00 (an opening and a card
 * purchase on 1020); the camt feed starts with statement 50 on 23.03.2026; statements 51 and 52 are
 * missing; statement 53 is 28.03.2026.
 */
const ROWS = [
  { date: '2026-03-02', text: 'Credit originator: Beispiel Holding AG', ref: 'Z900000000101', minor: 200000 },
  { date: '2026-03-05', text: 'Online purchase Debit card, PAPETERIE MUSTER', ref: 'L9000000AA00T001-1', minor: -3500 },
  { date: '2026-03-12', text: 'Debit Mobile Banking: Software Muster AG, Teststrasse 1, 9999 Testdorf', ref: 'Z900000000102', minor: -43210, details: 'Software Muster AG, Teststrasse 1, 9999 Testdorf, CH' },
  { date: '2026-03-18', text: 'Account maintenance', ref: 'L9000000AA00T002-1', minor: -500 },
  { date: '2026-03-23', text: 'Online purchase Debit card, KIOSK TESTPLATZ', ref: 'L9000000AA00T003-1', minor: -1240 },
  { date: '2026-03-25', text: 'Credit originator: Kunde Test GmbH', ref: 'Z900000000104', minor: 25000, purpose: 'Rechnung 2026-007' },
  { date: '2026-03-28', text: 'Online purchase Debit card, BUCHLADEN BEISPIEL', ref: 'L9000000AA00T005-1', minor: -2000 },
  { date: '2026-03-30', text: 'Fee for Debit Card', ref: 'L9000000AA00T006-1', minor: -300 },
];
const CSV = zkbCsv(ROWS, { start: 0 });

function book({ stmt53Open = 176550 } = {}) {
  const t = world();
  must(postEntry(t.ctx, { date: '2026-03-02', source: 'manual', description: 'Übernahme Bank', idempotencyKey: 'mig', lines: [{ account: t.acc('1020'), debit: 200000 }, { account: t.acc('3400'), credit: 200000 }] }));
  must(postEntry(t.ctx, { date: '2026-03-05', source: 'manual', description: 'Papeterie', idempotencyKey: 'pap', lines: [{ account: t.acc('6500'), debit: 3500 }, { account: t.acc('1020'), credit: 3500 }] }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S50', seq: '50', date: '2026-03-23', open: 152790, entries: [{ ref: 'k50', asr: 'L9000000AA00T003', amountMinor: 1240, cd: 'DBIT', date: '2026-03-23' }] }), idempotencyKey: key() }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S53', seq: '53', date: '2026-03-28', open: stmt53Open, entries: [{ ref: 'k53', asr: 'L9000000AA00T005', amountMinor: 2000, cd: 'DBIT', date: '2026-03-28' }] }), idempotencyKey: key() }));
  return t;
}

const MAPPING = presetFor(HEADER).mapping;
const fillIt = (t, fill, extra = {}) => importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, mapping: MAPPING, fill, idempotencyKey: key(), ...extra });
const csvLines = (t) =>
  t.store.db
    .prepare(
      `SELECT t.id, t.booking_date AS d, t.amount_minor AS a, t.credit_debit AS cd, t.entry_ref AS ref, s.message_type AS fmt, s.statement_id AS sid, f.source AS src
         FROM bank_txn t JOIN bank_statement s ON s.workspace_id = t.workspace_id AND s.id = t.statement_id
         LEFT JOIN bank_txn_fact f ON f.workspace_id = t.workspace_id AND f.bank_txn_id = t.id
        WHERE t.workspace_id = ? AND s.message_type = 'csv' ORDER BY t.booking_date`,
    )
    .all(t.workspaceId);

test('the ZKB export layout is recognised by its headers and read as a mapping; a near layout is not a preset', () => {
  const p = presetFor(HEADER);
  assert.equal(p.id, 'zkb_account_statement');
  assert.deepEqual(guessCsvMapping(HEADER, []), p.mapping, 'the guess is the preset');
  assert.equal(p.mapping.columns.balance, 'Balance CHF');
  assert.equal(p.mapping.columns.debit, 'Debit CHF');
  assert.equal(p.mapping.rowOrder, 'newest_first');
  assert.equal(presetFor(HEADER.filter((h) => h !== 'Balance CHF')), null, 'a file missing one column is no ZKB export');
  const t = book();
  const pv = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: CSV }));
  assert.equal(pv.preset, 'zkb_account_statement');
  assert.equal(pv.mappingSource, 'guessed');
  assert.equal(pv.delimiter, 'semicolon');
  assert.equal(pv.sample[0].amountMinor, -300, 'newest row first, debit read negative');
  assert.equal(pv.sample.find((r) => r.amountMinor === -43210).counterparty, 'Software Muster AG', 'the name before the first comma');
  assert.equal(pv.sample.find((r) => r.amountMinor === 25000).text, 'Rechnung 2026-007', 'the payment purpose is the remittance');
});

test('held days are cut out of a stretch: what remains are the days no statement holds', () => {
  assert.deepEqual(minusHeld({ from: '2026-03-01', to: '2026-03-31' }, [{ from: '2026-03-10', to: '2026-03-10' }, { from: '2026-03-20', to: '2026-03-22' }]), [
    { from: '2026-03-01', to: '2026-03-09' },
    { from: '2026-03-11', to: '2026-03-19' },
    { from: '2026-03-23', to: '2026-03-31' },
  ]);
  assert.deepEqual(minusHeld({ from: '2026-03-05', to: '2026-03-06' }, [{ from: '2026-03-01', to: '2026-03-31' }]), []);
});

test('preview of the gaps: the before-feed hole and the numbered gap, each proven by the running balance and tied on both sides; nothing written', () => {
  const t = book();
  const before = t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).n;
  const pv = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, mapping: MAPPING, fill: {} }));
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).n, before, 'a preview writes nothing');
  const [hole, gap] = pv.fill.parts;
  assert.equal(pv.fill.parts.length, 2);
  assert.deepEqual([hole.kind, hole.from, hole.to, hole.status], ['before_feed', '2026-03-06', '2026-03-22', 'ready']);
  assert.deepEqual(hole.lines.map((l) => l.amountMinor), [-43210, -500]);
  assert.equal(hole.openingMinor, 196500);
  assert.equal(hole.closingMinor, 152790);
  assert.deepEqual({ kind: hole.before.kind, ledgerMinor: hole.before.ledgerMinor, differenceMinor: hole.before.differenceMinor }, { kind: 'books', ledgerMinor: 196500, differenceMinor: 0 });
  assert.deepEqual({ kind: hole.after.kind, number: hole.after.number, differenceMinor: hole.after.differenceMinor }, { kind: 'statement', number: 50, differenceMinor: 0 });
  assert.equal(hole.closesTarget, true);
  assert.deepEqual([gap.kind, gap.from, gap.to, gap.status, gap.rows], ['gap', '2026-03-24', '2026-03-27', 'ready', 1]);
  assert.equal(gap.before.number, 50);
  assert.equal(gap.after.number, 53);
  assert.equal(gap.closesTarget, true);
  assert.equal(pv.fill.rowsInFile, 8);
  assert.equal(pv.fill.rowsOutside, 5, 'the rows on held days and outside every gap');
});

test('the fill writes each stretch as a CSV statement with its balances, the lines open and marked as from a CSV, the gap closed and the feed start moved', () => {
  const t = book();
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 1, 'statements 51 and 52 are missing');
  const startBefore = must(listBankInbox(t.ctx, { bankAccountId: t.bankAccountId })).summary[0].start;
  assert.deepEqual([startBefore.date, startBefore.gapMinor], ['2026-03-23', 152790 - 196500]);

  const res = must(fillIt(t, {}), 'fill');
  assert.equal(res.imported, 3);
  assert.deepEqual(res.statements.map((s) => s.outcome), ['imported', 'imported']);
  assert.deepEqual(res.fill.parts.map((p) => p.status), ['imported', 'imported']);
  assert.deepEqual(res.fill.parts[1].closedGapIds.length, 1, 'the numbered gap is closed');
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 0, 'the gap card has nothing left to show');

  const stmts = t.store.db.prepare("SELECT statement_id, from_date, to_date, opening_balance_minor AS o, closing_balance_minor AS c, txn_count FROM bank_statement WHERE workspace_id = ? AND message_type = 'csv' ORDER BY from_date").all(t.workspaceId);
  assert.deepEqual(stmts.map((s) => [s.from_date, s.to_date, s.o, s.c, s.txn_count]), [
    ['2026-03-06', '2026-03-22', 196500, 152790, 2],
    ['2026-03-24', '2026-03-27', 151550, 176550, 1],
  ]);
  assert.ok(stmts.every((s) => s.statement_id.startsWith('csvfill:')));

  const lines = csvLines(t);
  assert.deepEqual(lines.map((l) => [l.d, l.cd, l.a]), [['2026-03-12', 'DBIT', 43210], ['2026-03-18', 'DBIT', 500], ['2026-03-25', 'CRDT', 25000]]);
  assert.ok(lines.every((l) => l.src === 'csv'), 'provenance: every line is a CSV line');
  const inbox = must(listBankInbox(t.ctx, { bankAccountId: t.bankAccountId, status: 'all' }));
  for (const l of lines) {
    const row = inbox.lines.find((x) => x.bankTxnId === l.id);
    assert.equal(row.state, 'open', 'the fill books nothing');
    assert.equal(row.facts.source, 'csv');
  }
  const s = must(listBankInbox(t.ctx, { bankAccountId: t.bankAccountId })).summary[0];
  assert.deepEqual([s.start.date, s.start.bankMinor, s.start.gapMinor], ['2026-03-06', 196500, 0], 'the feed now starts where the books end, and they agree');
});

test('a fill again finds nothing more: its days are held now, and the same call replays its answer', () => {
  const t = book();
  must(fillIt(t, {}));
  const again = must(fillIt(t, {}));
  assert.equal(again.imported, 0);
  assert.equal(again.fill.parts.length, 0, 'no day is left without a statement');
  // A named range is the person's choice: the days no statement holds are 01. to 05.03 (the export starts
  // on 02.03, so that is where its proof starts) and 29. to 31.03 (the export ends on 30.03: refused).
  const k = key();
  const ranged = must(fillIt(t, { from: '2026-03-01', to: '2026-03-31' }, { idempotencyKey: k }));
  assert.deepEqual(ranged.fill.parts.map((p) => [p.targetFrom, p.from, p.to, p.status]), [
    ['2026-03-01', '2026-03-02', '2026-03-05', 'imported'],
    ['2026-03-29', '2026-03-29', '2026-03-30', 'refused'],
  ]);
  assert.equal(ranged.fill.parts[0].before.kind, 'none', 'nothing before the export to tie to');
  assert.equal(ranged.fill.parts[0].closesTarget, false, '01.03 is not proven');
  assert.deepEqual(fillIt(t, { from: '2026-03-01', to: '2026-03-31' }, { idempotencyKey: k }), ranged, 'the same call replays');
  assert.equal(must(fillIt(t, { from: '2026-03-01', to: '2026-03-31' })).imported, 0, 'a new call finds those days held');
  assert.equal(csvLines(t).length, 5);
});

test('a named range takes only its days, minus the held ones; the export ending inside the range is refused open_end', () => {
  const t = book();
  const res = must(fillIt(t, { from: '2026-03-10', to: '2026-03-15' }));
  assert.deepEqual(res.fill.parts.map((p) => [p.kind, p.from, p.to, p.status, p.rows]), [['range', '2026-03-10', '2026-03-15', 'imported', 1]]);
  assert.equal(res.fill.parts[0].closesTarget, true, 'the CSV states both ends of the range');
  // 29.03 to 31.03: the export's last row is 30.03, so the end of those days is not stated.
  const open = must(fillIt(t, { from: '2026-03-29', to: '2026-03-31' }));
  assert.deepEqual(open.fill.parts.map((p) => [p.status, p.problems[0]?.code]), [['refused', 'open_end']]);
  assert.equal(open.statements[0].code, 'csv_fill_open_end');
  assert.equal(csvLines(t).length, 1, 'only the 12.03 line came in');
});

test('a stretch the statements contradict is refused csv_fill_untied, the other stretch still fills; under warn it imports and the gap stays open', () => {
  const t = book({ stmt53Open: 180000 });
  const res = must(fillIt(t, {}));
  const [hole, gap] = res.fill.parts;
  assert.equal(hole.status, 'imported');
  assert.equal(gap.status, 'refused');
  assert.deepEqual(gap.problems, [{ code: 'untied', side: 'after', differenceMinor: 176550 - 180000 }]);
  assert.equal(res.statements[1].code, 'csv_fill_untied');
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 1, 'the gap stays open');

  const w = book({ stmt53Open: 180000 });
  must(settingsSet(w.ctx, { key: 'bank.csv_fill_balance_tie', value: 'warn', idempotencyKey: 'warn', reason: 'test' }));
  const warned = must(fillIt(w, {}));
  assert.deepEqual(warned.fill.parts.map((p) => p.status), ['imported', 'imported']);
  assert.ok(warned.statements[1].warnings.includes('csv_fill_untied'));
  assert.equal(statementGaps(w.ctx, { bankAccountId: w.bankAccountId }).length, 1, 'an untied fill never closes a gap');
});

test('a broken running balance (a row missing from the export) refuses csv_fill_chain_broken and writes nothing of those days', () => {
  const t = book();
  // The 18.03 row is missing from this export: the balance jumps by its CHF 5.00.
  const broken = zkbCsv(ROWS.filter((r) => r.date !== '2026-03-18').map((r) => (r.date >= '2026-03-23' ? { ...r, balance: undefined } : r)), { start: 0 });
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: broken, mapping: MAPPING, fill: {}, idempotencyKey: key() }));
  const hole = res.fill.parts.find((p) => p.kind === 'before_feed');
  assert.equal(hole.status, 'refused');
  assert.equal(hole.problems[0].code, 'untied', 'the CSV itself chains, but no longer meets statement 50');
  const gapless = zkbCsv(ROWS.map((r, i) => (i === 4 ? { ...r, balance: 999 } : r)), { start: 0 });
  const res2 = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: gapless, mapping: MAPPING, fill: {}, idempotencyKey: key() }));
  assert.ok(res2.fill.parts.some((p) => p.problems.some((x) => x.code === 'chain_broken')), JSON.stringify(res2.fill.parts.map((p) => p.problems)));
  assert.equal(csvLines(t).filter((l) => l.d >= '2026-03-24').length, 0);
});

test('rows the books already hold are left out: the bank reference with the same money (ZKB -1 suffix), on another date; the tie accounts for it', () => {
  const t = world();
  must(postEntry(t.ctx, { date: '2026-04-01', source: 'manual', description: 'Übernahme Bank', idempotencyKey: 'mig', lines: [{ account: t.acc('1020'), debit: 100000 }, { account: t.acc('3400'), credit: 100000 }] }));
  // Friday 03.04 and Monday 06.04 are in the books; the card purchase the CSV dates Saturday 04.04 is in
  // Monday's camt.053 (booked 06.04), with the reference without ZKB's "-1".
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S10', seq: '10', date: '2026-04-03', open: 100000, entries: [{ ref: 'a', asr: 'L9000000AA00T010', amountMinor: 1000, cd: 'DBIT', date: '2026-04-03' }] }), idempotencyKey: key() }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S12', seq: '12', date: '2026-04-06', open: 99000, entries: [{ ref: 'b', asr: 'L9000000AA00T011', amountMinor: 450, cd: 'DBIT', date: '2026-04-06', valueDate: '2026-04-04' }] }), idempotencyKey: key() }));
  const csv = zkbCsv(
    [
      { date: '2026-04-03', text: 'Fee', ref: 'L9000000AA00T010-1', minor: -1000 },
      { date: '2026-04-04', text: 'Online purchase Debit card, KAFFEE TEST', ref: 'L9000000AA00T011-1', minor: -450 },
      { date: '2026-04-07', text: 'Fee', ref: 'L9000000AA00T012-1', minor: -100 },
    ],
    { start: 100000 },
  );
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: csv, mapping: MAPPING, fill: {}, idempotencyKey: key() }));
  const gap = res.fill.parts.find((p) => p.kind === 'gap');
  assert.deepEqual([gap.kind, gap.from, gap.to], ['gap', '2026-04-04', '2026-04-05']);
  assert.equal(res.fill.parts.find((p) => p.kind === 'before_feed').status, 'not_in_file', 'the export starts after the books end');
  assert.equal(gap.alreadyInBooks, 1);
  assert.equal(gap.imported, 0);
  assert.equal(gap.lines[0].inBooks.by, 'reference');
  assert.equal(gap.csvClosingMinor, 98550);
  assert.equal(gap.closingMinor, 99000, "the CSV's balance without the row Monday's statement holds");
  assert.equal(gap.status, 'imported', 'a zero-line fill: the days are proven empty');
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 0, 'statement 11 is accounted for by the CSV');
  assert.ok(res.skipped.some((s) => s.reason === 'duplicate_entry' && s.existingBankTxnId !== undefined));

  // Under ask the row is imported, and the CSV's own balance no longer meets Monday's statement.
  const u = world();
  must(postEntry(u.ctx, { date: '2026-04-01', source: 'manual', description: 'Übernahme Bank', idempotencyKey: 'mig', lines: [{ account: u.acc('1020'), debit: 100000 }, { account: u.acc('3400'), credit: 100000 }] }));
  must(importCamt(u.ctx, { bankAccountId: u.bankAccountId, xml: camtDay({ id: 'S10', seq: '10', date: '2026-04-03', open: 100000, entries: [{ ref: 'a', asr: 'L9000000AA00T010', amountMinor: 1000, cd: 'DBIT', date: '2026-04-03' }] }), idempotencyKey: key() }));
  must(importCamt(u.ctx, { bankAccountId: u.bankAccountId, xml: camtDay({ id: 'S12', seq: '12', date: '2026-04-06', open: 99000, entries: [{ ref: 'b', asr: 'L9000000AA00T011', amountMinor: 450, cd: 'DBIT', date: '2026-04-06', valueDate: '2026-04-04' }] }), idempotencyKey: key() }));
  must(settingsSet(u.ctx, { key: 'bank.csv_fill_duplicates', value: 'ask', idempotencyKey: 'ask', reason: 'test' }));
  const asked = must(importBankStatement(u.ctx, { bankAccountId: u.bankAccountId, content: csv, mapping: MAPPING, fill: {}, idempotencyKey: key() }));
  const askedGap = asked.fill.parts.find((p) => p.kind === 'gap');
  assert.equal(askedGap.status, 'refused');
  assert.equal(askedGap.problems[0].code, 'untied');
});

test('an EBICS-fed account takes a fill (the days the feed never delivered) but no plain CSV; the setting refuse keeps it camt only', () => {
  const t = book();
  const now = t.ctx.clock.now();
  t.store.db
    .prepare("INSERT INTO ebics_connection (id, workspace_id, host_url, host_id, partner_id, user_id_ebics, state, activated_at, created_at, updated_at) VALUES ('ebc_f', ?, 'https://bank.invalid', 'HOSTF', 'PARTNERF', 'USERF', 'active', ?, ?, ?)")
    .run(t.workspaceId, now, now, now);
  t.store.db.prepare("INSERT INTO ebics_connection_account (id, workspace_id, connection_id, bank_account_id, created_at) VALUES ('eca_f', ?, 'ebc_f', ?, ?)").run(t.workspaceId, t.bankAccountId, now);
  refused(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, mapping: MAPPING, idempotencyKey: key() }), 'bank_feed_account');
  const pv = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: CSV }));
  assert.equal(pv.fedAccount, true);
  must(settingsSet(t.ctx, { key: 'bank.csv_fill_fed_accounts', value: 'refuse', idempotencyKey: 'refuse', reason: 'test' }));
  refused(fillIt(t, {}), 'bank_feed_account');
  must(settingsSet(t.ctx, { key: 'bank.csv_fill_fed_accounts', value: 'allow', idempotencyKey: 'allow', reason: 'test' }));
  assert.equal(must(fillIt(t, {})).imported, 3);
});

test('refusals: a fill without a balance column, a fill on a camt file, a malformed range', () => {
  const t = book();
  const noBalance = { ...MAPPING, columns: { ...MAPPING.columns } };
  delete noBalance.columns.balance;
  refused(fillIt(t, {}, { mapping: noBalance }), 'csv_fill_needs_balance');
  refused(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: camtDay({ id: 'X', seq: '99', date: '2026-05-01', open: 0, entries: [] }), fill: {}, idempotencyKey: key() }), 'invalid_input');
  for (const fill of [{ from: '2026-03-01' }, { from: '2026-03-31', to: '2026-03-01' }, { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-03-01', to: '2026-03-02', extra: 1 }]) {
    const r = fillIt(t, fill);
    assert.equal(r.ok, false, JSON.stringify(fill));
    assert.equal(r.error, 'invalid_input');
  }
  assert.equal(csvLines(t).length, 0);
});

test('§H-TENANT: a fill reads and writes only its own workspace', () => {
  const t = book();
  const other = secondWorkspace(t);
  must(fillIt(t, {}));
  const theirs = t.store.db.prepare("SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ? AND message_type = 'csv'").get(other.workspaceId).n;
  assert.equal(theirs, 0);
});
