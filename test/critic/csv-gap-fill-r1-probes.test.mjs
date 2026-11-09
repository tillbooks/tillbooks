// Critic round 1 (non-author) probes for A20 §12, the CSV gap fill (branch claude/csv-gap-fill).
// A probe that demonstrates a defect asserts the CORRECT behaviour and therefore FAILS on the branch as
// reviewed; a probe that confirms a property passes. Report: docs/critique/csv-gap-fill-critic-r1.md.
//
// SYNTHETIC DATA ONLY: every row, reference, name and amount below is invented here; the IBAN is the
// published sample of bank-inbox-support.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { importCamt, statementGaps } from '../../dist/core/banking/index.js';
import { importBankStatement, bankCsvPreview, prevalidateImportBankStatement } from '../../dist/core/banking/statementImport.js';
import { presetFor } from '../../dist/core/banking/csvMapping.js';
import { evaluateValidation } from '../../dist/core/checklists/validations.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { assertClaimInvariantHolds, world, must, refused, camt } from '../banking/bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

let n = 0;
const key = () => `critic-fill-${(n += 1)}`;

// --- The ZKB-shaped fixture (same shape as test/banking/csv-gap-fill.test.mjs, invented rows) ----------

const HEADER = ['Date', 'Booking text', 'Curr', 'Amount details', 'ZKB reference', 'Reference number', 'Debit CHF', 'Credit CHF', 'Value date', 'Balance CHF', 'Payment purpose', 'Details'];
const q = (v) => `"${v}"`;
const dmy = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const major = (minor) => (Math.abs(minor) / 100).toFixed(2);

function zkbCsv(rows, { start }) {
  let bal = start;
  const lines = rows.map((r) => {
    bal += r.minor;
    const b = r.balance ?? bal;
    return [dmy(r.date), r.text, '', '', r.ref, '', r.minor < 0 ? major(r.minor) : '', r.minor > 0 ? major(r.minor) : '', dmy(r.valueDate ?? r.date), major(b), r.purpose ?? '', r.details ?? ''].map(q).join(';');
  });
  return `﻿${HEADER.map(q).join(';')}\r\n${lines.reverse().join('\r\n')}\r\n`;
}

function camtDay({ id, seq, date, to, open, entries }) {
  let xml = camt({ statementId: id, seqNb: seq, from: date, to: to ?? date, openingMinor: open, entries });
  for (const e of entries) if (e.asr !== undefined) xml = xml.replace(`<NtryRef>${e.ref}</NtryRef>`, `<NtryRef>${e.ref}</NtryRef><AcctSvcrRef>${e.asr}</AcctSvcrRef>`);
  return xml;
}

const MAPPING = presetFor(HEADER).mapping;

const ROWS = [
  { date: '2026-03-02', text: 'Credit originator: Beispiel Holding AG', ref: 'Z900000000101', minor: 200000 },
  { date: '2026-03-05', text: 'Online purchase Debit card, PAPETERIE MUSTER', ref: 'L9000000AA00T001-1', minor: -3500 },
  { date: '2026-03-12', text: 'Debit Mobile Banking: Software Muster AG', ref: 'Z900000000102', minor: -43210, details: 'Software Muster AG, Teststrasse 1, 9999 Testdorf, CH' },
  { date: '2026-03-18', text: 'Account maintenance', ref: 'L9000000AA00T002-1', minor: -500 },
  { date: '2026-03-23', text: 'Online purchase Debit card, KIOSK TESTPLATZ', ref: 'L9000000AA00T003-1', minor: -1240 },
  { date: '2026-03-25', text: 'Credit originator: Kunde Test GmbH', ref: 'Z900000000104', minor: 25000, details: 'Kunde Test GmbH, Testweg 2, 9999 Testdorf' },
  { date: '2026-03-28', text: 'Online purchase Debit card, BUCHLADEN BEISPIEL', ref: 'L9000000AA00T005-1', minor: -2000 },
  { date: '2026-03-29', text: 'Online purchase Debit card, VELO BEISPIEL', ref: 'L9000000AA00T007-1', minor: -700 },
  { date: '2026-03-30', text: 'Fee for Debit Card', ref: 'L9000000AA00T006-1', minor: -300 },
  { date: '2026-03-31', text: 'Credit originator: Kunde Zwei AG', ref: 'Z900000000105', minor: 10000 },
];
const CSV = zkbCsv(ROWS, { start: 0 });

/** Books end 05.03 at 196500; camt 50 (23.03) and 53 (28.03) stored, 51 and 52 missing. */
function book({ s53Entries } = {}) {
  const t = world();
  must(postEntry(t.ctx, { date: '2026-03-02', source: 'manual', description: 'Übernahme Bank', idempotencyKey: 'mig', lines: [{ account: t.acc('1020'), debit: 200000 }, { account: t.acc('3400'), credit: 200000 }] }));
  must(postEntry(t.ctx, { date: '2026-03-05', source: 'manual', description: 'Papeterie', idempotencyKey: 'pap', lines: [{ account: t.acc('6500'), debit: 3500 }, { account: t.acc('1020'), credit: 3500 }] }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S50', seq: '50', date: '2026-03-23', open: 152790, entries: [{ ref: 'k50', asr: 'L9000000AA00T003', amountMinor: 1240, cd: 'DBIT', date: '2026-03-23' }] }), idempotencyKey: key() }));
  must(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camtDay({ id: 'S53', seq: '53', date: '2026-03-28', open: 176550, entries: s53Entries ?? [{ ref: 'k53', asr: 'L9000000AA00T005', amountMinor: 2000, cd: 'DBIT', date: '2026-03-28' }] }),
      idempotencyKey: key(),
    }),
  );
  return t;
}

function feedIt(t) {
  const now = t.ctx.clock.now();
  t.store.db
    .prepare("INSERT INTO ebics_connection (id, workspace_id, host_url, host_id, partner_id, user_id_ebics, state, activated_at, created_at, updated_at) VALUES ('ebc_c', ?, 'https://bank.invalid', 'HOSTC', 'PARTNERC', 'USERC', 'active', ?, ?, ?)")
    .run(t.workspaceId, now, now, now);
  t.store.db.prepare("INSERT INTO ebics_connection_account (id, workspace_id, connection_id, bank_account_id, created_at) VALUES ('eca_c', ?, 'ebc_c', ?, ?)").run(t.workspaceId, t.bankAccountId, now);
}

const fillIt = (t, fill, extra = {}) => importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, mapping: MAPPING, fill, idempotencyKey: key(), ...extra });

const linesOf = (t, where = '1 = 1', ...args) =>
  t.store.db
    .prepare(
      `SELECT t.id, t.booking_date AS d, t.amount_minor AS a, t.credit_debit AS cd, s.message_type AS fmt, s.statement_id AS sid
         FROM bank_txn t JOIN bank_statement s ON s.workspace_id = t.workspace_id AND s.id = t.statement_id
        WHERE t.workspace_id = ? AND ${where} ORDER BY t.booking_date, t.rowid`,
    )
    .all(t.workspaceId, ...args);

// =========================================================================================================
// DEFECT PROBES (fail on the branch as reviewed)
// =========================================================================================================

test('F1 (HIGH, guard bypass D139 item 6): an EBICS-fed account must not take a CSV for days AFTER the newest feed statement (days the feed has not delivered YET)', () => {
  const t = book();
  feedIt(t);
  // The newest feed statement is 53 (28.03). 29. and 30.03 are days the feed WILL deliver: not "never delivered".
  const res = fillIt(t, { from: '2026-03-29', to: '2026-03-30' });
  const wrote = linesOf(t, "s.message_type = 'csv'");
  assert.equal(wrote.length, 0, `the fill wrote ${wrote.length} CSV line(s) on days after the newest feed statement: ${JSON.stringify(res.ok ? res.fill.parts.map((p) => [p.from, p.to, p.status]) : res)}`);
});

test('F1b (consequence): after such a fill the feed delivers statement 54 for those days, and each movement stands TWICE in the bank lines', () => {
  const t = book();
  feedIt(t);
  const res = must(fillIt(t, { from: '2026-03-29', to: '2026-03-30' }));
  // Fixed (author, r1 F1): the fill stops at the newest feed statement, so it takes nothing here; the
  // feed's statement 54 then brings each movement once.
  assert.equal(res.imported, 0, 'the fill never reaches past the newest feed statement');
  must(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camtDay({
        id: 'S54',
        seq: '54',
        date: '2026-03-29',
        to: '2026-03-30',
        open: 174550,
        entries: [
          { ref: 'k54a', asr: 'L9000000AA00T007', amountMinor: 700, cd: 'DBIT', date: '2026-03-29' },
          { ref: 'k54b', asr: 'L9000000AA00T006', amountMinor: 300, cd: 'DBIT', date: '2026-03-30' },
        ],
      }),
      idempotencyKey: key(),
    }),
    'the feed statement 54',
  );
  const fee = linesOf(t, "t.amount_minor = 300 AND t.credit_debit = 'DBIT' AND t.booking_date = '2026-03-30'");
  const flagged = t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_possible_duplicate WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(fee.length, 1, `the 30.03 fee is held ${fee.length} times (${fee.map((l) => l.fmt).join(', ')}); lines flagged as possible duplicates: ${flagged}`);
});

test('F2 (MEDIUM, statutory checklist Q7): bank_balance_matches reads a fill that spans the period end at its LAST day, not at the period end', () => {
  const t = world();
  must(postEntry(t.ctx, { date: '2026-02-01', source: 'manual', description: 'Eröffnung', idempotencyKey: 'op', lines: [{ account: t.acc('1020'), debit: 100000 }, { account: t.acc('3400'), credit: 100000 }] }));
  must(postEntry(t.ctx, { date: '2026-02-20', source: 'manual', description: 'Spesen', idempotencyKey: 'e1', lines: [{ account: t.acc('6500'), debit: 1000 }, { account: t.acc('1020'), credit: 1000 }] }));
  // The person booked the 25.02 payment from the paper receipt: on 28.02 the books and the bank agree (97000).
  must(postEntry(t.ctx, { date: '2026-02-25', source: 'manual', description: 'Material', idempotencyKey: 'e2', lines: [{ account: t.acc('6500'), debit: 2000 }, { account: t.acc('1020'), credit: 2000 }] }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S10', seq: '10', date: '2026-02-20', open: 100000, entries: [{ ref: 'a', asr: 'L9000000BB00T001', amountMinor: 1000, cd: 'DBIT', date: '2026-02-20' }] }), idempotencyKey: key() }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S14', seq: '14', date: '2026-03-10', open: 94000, entries: [{ ref: 'b', asr: 'L9000000BB00T004', amountMinor: 500, cd: 'DBIT', date: '2026-03-10' }] }), idempotencyKey: key() }));
  const csv = zkbCsv(
    [
      { date: '2026-02-20', text: 'Fee', ref: 'L9000000BB00T001-1', minor: -1000 },
      { date: '2026-02-25', text: 'Online purchase Debit card, MATERIAL TEST', ref: 'L9000000BB00T002-1', minor: -2000 },
      { date: '2026-03-03', text: 'Online purchase Debit card, WERKZEUG TEST', ref: 'L9000000BB00T003-1', minor: -3000 },
      { date: '2026-03-10', text: 'Fee', ref: 'L9000000BB00T004-1', minor: -500 },
    ],
    { start: 100000 },
  );
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: csv, mapping: MAPPING, fill: {}, idempotencyKey: key() }));
  const gap = res.fill.parts.find((p) => p.kind === 'gap');
  assert.deepEqual([gap.status, gap.from, gap.to, gap.closingMinor], ['imported', '2026-02-21', '2026-03-09', 94000], 'precondition: one tied fill over the month end');
  const v = evaluateValidation(t.ctx, 'bank_balance_matches', { label: '2026-02', periodStart: '2026-02-01', periodEnd: '2026-02-28' });
  const row = v.figures?.accounts?.[0];
  assert.equal(row?.statementMinor, 97000, `Q7 compares the bank's ${row?.statementMinor} (the fill's close on ${row?.statementTo}) with the books on 28.02 (${row?.ledgerMinor}): status ${v.status}`);
});

test('F3 (MEDIUM, dropped movement): a range stretch with no adjacent statement drops a real movement whose reference and money recur a month earlier, silently', () => {
  // A plain bank layout (not the preset): the reference column carries the payment's reference, which a
  // standing order repeats every month.
  const header = ['Datum', 'Text', 'Referenz', 'Betrag', 'Saldo'];
  const mapping = { columns: { bookingDate: 'Datum', text: 'Text', reference: 'Referenz', amount: 'Betrag', balance: 'Saldo' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.', delimiter: 'semicolon', rowOrder: 'oldest_first' };
  const file = (rows, start) => {
    let bal = start;
    return `${header.join(';')}\n${rows.map((r) => { bal += r.minor; return [dmy(r.date), r.text, r.ref, (r.minor / 100).toFixed(2), (bal / 100).toFixed(2)].join(';'); }).join('\n')}\n`;
  };
  const t = world();
  must(postEntry(t.ctx, { date: '2026-02-01', source: 'manual', description: 'Eröffnung', idempotencyKey: 'op', lines: [{ account: t.acc('1020'), debit: 500000 }, { account: t.acc('3400'), credit: 500000 }] }));
  // February came in as an ordinary CSV import (no fill): the rent with its standing reference.
  must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: file([
    { date: '2026-02-05', text: 'Dauerauftrag Muster Immobilien', ref: 'RF18000000000000000042', minor: -150000 },
    { date: '2026-02-14', text: 'Kiosk Testplatz', ref: 'X0000000201', minor: -2000 },
  ], 500000), mapping, idempotencyKey: key() }), 'February, plain');
  // March as a fill of a named range: March's rent carries the same standing reference and the same money.
  const march = file([
    { date: '2026-02-27', text: 'Post Test', ref: 'X0000000202', minor: -1000 },
    { date: '2026-03-05', text: 'Dauerauftrag Muster Immobilien', ref: 'RF18000000000000000042', minor: -150000 },
    { date: '2026-03-12', text: 'Kiosk Testplatz', ref: 'X0000000301', minor: -2500 },
    { date: '2026-03-21', text: 'Gutschrift Kunde Test', ref: 'X0000000302', minor: 50000 },
  ], 348000);
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: march, mapping, fill: { from: '2026-03-01', to: '2026-03-20' }, idempotencyKey: key() }));
  const part = res.fill.parts[0];
  const rent = linesOf(t, "t.amount_minor = 150000 AND t.booking_date = '2026-03-05'");
  assert.equal(rent.length, 1, `March's rent was left out as "already in the books" (part ${part.status}, alreadyInBooks ${part.alreadyInBooks}, before ${part.before.kind}, after ${part.after.kind})`);
});

test('F4 (LOW, over-match): strip_dash_number strips the STORED side too, so two different stored references collapse into one', () => {
  // A stored fill line L...T050-1 and a later CSV row L...T050-2 (ZKB writes "another number" for a fee)
  // are two references; the camt side carries no suffix, so only the CSV side ever needs stripping.
  const t = book();
  must(fillIt(t, {}), 'the gaps first');
  const later = zkbCsv(
    [
      { date: '2026-04-01', text: 'Credit originator: Beispiel Holding AG', ref: 'Z900000000201', minor: 1000 },
      { date: '2026-04-02', text: 'Fee for Debit Card', ref: 'L9000000AA00T002-2', minor: -500 },
      { date: '2026-04-03', text: 'Credit originator: Beispiel Holding AG', ref: 'Z900000000202', minor: 1000 },
    ],
    { start: 183550 },
  );
  // 18.03 "Account maintenance" L9000000AA00T002-1, CHF 5.00, is in the books (the before-feed fill).
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: later, mapping: MAPPING, fill: { from: '2026-04-02', to: '2026-04-02' }, idempotencyKey: key() }));
  const p = res.fill.parts[0];
  assert.equal(p.alreadyInBooks, 0, `the 02.04 fee (another reference) was matched to ${JSON.stringify(p.lines.map((l) => l.inBooks))}`);
});

// =========================================================================================================
// CONFIRMING PROBES (pass): properties the author asserted or that I attacked without finding a defect
// =========================================================================================================

test('C1: a false "already in the books" match inside a numbered gap is caught by the tie (refused, nothing written)', () => {
  // Statement 53 holds a SECOND credit of Kunde Test GmbH, valued 25.03 but booked 28.03: the same date,
  // money and words as the CSV's 25.03 credit, yet another movement (53's opening already holds the first).
  const t = book({
    s53Entries: [
      { ref: 'k53', asr: 'L9000000AA00T005', amountMinor: 2000, cd: 'DBIT', date: '2026-03-28' },
      { ref: 'k53b', asr: 'Z900000000199', amountMinor: 25000, cd: 'CRDT', date: '2026-03-28', valueDate: '2026-03-25', name: 'Kunde Test GmbH' },
    ],
  });
  const res = must(fillIt(t, {}));
  const gap = res.fill.parts.find((p) => p.kind === 'gap');
  assert.equal(gap.alreadyInBooks, 1, 'precondition: the matcher took the 28.03 credit for the 25.03 row');
  assert.equal(gap.status, 'refused');
  assert.equal(gap.problems[0].code, 'untied');
  assert.equal(linesOf(t, "s.message_type = 'csv' AND t.booking_date BETWEEN '2026-03-24' AND '2026-03-27'").length, 0);
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 1, 'the gap stays open');
});

test('C2: every fill statement written holds opening + its lines = closing, and a closed gap chains from the earlier close to the later open', () => {
  const t = book();
  must(fillIt(t, {}));
  const fills = t.store.db.prepare("SELECT id, from_date, to_date, opening_balance_minor AS o, closing_balance_minor AS c FROM bank_statement WHERE workspace_id = ? AND statement_id LIKE 'csvfill:%' ORDER BY from_date").all(t.workspaceId);
  assert.ok(fills.length >= 2);
  for (const f of fills) {
    const net = t.store.db.prepare("SELECT COALESCE(SUM(CASE WHEN credit_debit = 'CRDT' THEN amount_minor ELSE -amount_minor END), 0) AS s FROM bank_txn WHERE workspace_id = ? AND statement_id = ?").get(t.workspaceId, f.id).s;
    assert.equal(f.o + net, f.c, `${f.from_date}..${f.to_date}`);
  }
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 0);
});

test('C3: an unreadable amount inside a stretch breaks the running balance: refused csv_fill_chain_broken, nothing of those days written', () => {
  const t = book();
  const bad = CSV.replace('"432.10"', '"n/a"');
  assert.notEqual(bad, CSV);
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: bad, mapping: MAPPING, fill: {}, idempotencyKey: key() }));
  const hole = res.fill.parts.find((p) => p.kind === 'before_feed');
  assert.equal(hole.status, 'refused');
  assert.equal(hole.problems[0].code, 'chain_broken');
  assert.equal(linesOf(t, "s.message_type = 'csv' AND t.booking_date < '2026-03-23'").length, 0);
});

test('C4: append-only: a fill updates and deletes no row that existed before it (statements, lines, journal)', () => {
  const t = book();
  const snap = () => ({
    s: t.store.db.prepare('SELECT * FROM bank_statement WHERE workspace_id = ? ORDER BY id').all(t.workspaceId),
    l: t.store.db.prepare('SELECT * FROM bank_txn WHERE workspace_id = ? ORDER BY id').all(t.workspaceId),
    j: t.store.db.prepare('SELECT * FROM journal_entry WHERE workspace_id = ? ORDER BY id').all(t.workspaceId),
  });
  const before = snap();
  must(fillIt(t, {}));
  const after = snap();
  for (const k of ['s', 'l', 'j']) {
    const now = new Map(after[k].map((r) => [r.id, JSON.stringify(r)]));
    for (const r of before[k]) assert.equal(now.get(r.id), JSON.stringify(r), `${k} ${r.id} changed or vanished`);
  }
});

test('C5: the agent draft path agrees with the run path on an EBICS account (fill passes, plain CSV refuses bank_feed_account)', () => {
  const t = book();
  feedIt(t);
  assert.equal(prevalidateImportBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, mapping: MAPPING, fill: {}, idempotencyKey: key() }), undefined);
  refused(prevalidateImportBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, mapping: MAPPING, idempotencyKey: key() }), 'bank_feed_account');
  const noBal = { ...MAPPING, columns: { ...MAPPING.columns } };
  delete noBal.columns.balance;
  refused(prevalidateImportBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, mapping: noBal, fill: {}, idempotencyKey: key() }), 'csv_fill_needs_balance');
});

test('C6: idempotency: the same key with another fill scope is another question (no stale replay); a preview writes nothing', () => {
  const t = book();
  const k = key();
  const a = must(fillIt(t, { from: '2026-03-10', to: '2026-03-15' }, { idempotencyKey: k }));
  const b = must(fillIt(t, {}, { idempotencyKey: k }));
  assert.equal(a.fill.scope, 'range');
  assert.equal(b.fill.scope, 'gaps');
  const count = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).n;
  const c = count();
  must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: CSV, mapping: MAPPING, fill: { from: '2026-03-01', to: '2026-03-31' } }));
  assert.equal(count(), c);
});
