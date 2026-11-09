// Critic round 2 (non-author) probes for A20 §12, the CSV gap fill, against the r1 fixes at 88d0b61ed.
// A defect probe asserts the CORRECT behaviour and fails on the head as reviewed; a confirming probe passes.
// Report: docs/critique/csv-gap-fill-critic-r2.md.
//
// SYNTHETIC DATA ONLY: every row, reference, name and amount is invented here; the IBAN is the published
// sample of bank-inbox-support.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { importCamt } from '../../dist/core/banking/index.js';
import { importBankStatement } from '../../dist/core/banking/statementImport.js';
import { presetFor } from '../../dist/core/banking/csvMapping.js';
import { evaluateValidation } from '../../dist/core/checklists/validations.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { assertClaimInvariantHolds, world, must, camt } from '../banking/bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

let n = 0;
const key = () => `critic-r2-${(n += 1)}`;

const HEADER = ['Date', 'Booking text', 'Curr', 'Amount details', 'ZKB reference', 'Reference number', 'Debit CHF', 'Credit CHF', 'Value date', 'Balance CHF', 'Payment purpose', 'Details'];
const q = (v) => `"${v}"`;
const dmy = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const major = (minor) => (Math.abs(minor) / 100).toFixed(2);
const MAPPING = presetFor(HEADER).mapping;

function zkbCsv(rows, { start }) {
  let bal = start;
  const lines = rows.map((r) => {
    bal += r.minor;
    return [dmy(r.date), r.text, '', '', r.ref, '', r.minor < 0 ? major(r.minor) : '', r.minor > 0 ? major(r.minor) : '', dmy(r.valueDate ?? r.date), major(bal), '', ''].map(q).join(';');
  });
  return `﻿${HEADER.map(q).join(';')}\r\n${lines.reverse().join('\r\n')}\r\n`;
}

function camtDay({ id, seq, date, to, open, entries }) {
  let xml = camt({ statementId: id, seqNb: seq, from: date, to: to ?? date, openingMinor: open, entries });
  for (const e of entries) if (e.asr !== undefined) xml = xml.replace(`<NtryRef>${e.ref}</NtryRef>`, `<NtryRef>${e.ref}</NtryRef><AcctSvcrRef>${e.asr}</AcctSvcrRef>`);
  return xml;
}

const lines = (t, where, ...args) =>
  t.store.db
    .prepare(`SELECT t.id, s.message_type AS fmt, s.id AS sid FROM bank_txn t JOIN bank_statement s ON s.workspace_id = t.workspace_id AND s.id = t.statement_id WHERE t.workspace_id = ? AND ${where} ORDER BY t.rowid`)
    .all(t.workspaceId, ...args);

/**
 * A card purchase the CSV dates Saturday 14.03 and the camt.053 of Friday 20.03 books (value date 20.03,
 * the bank's reference without ZKB's "-1"). The days 16. to 19.03 hold no statement, so a range fill of
 * 10. to 15.03 has no statement adjacent after it.
 */
function cardWorld() {
  const t = world();
  must(postEntry(t.ctx, { date: '2026-03-01', source: 'manual', description: 'Eröffnung', idempotencyKey: 'op', lines: [{ account: t.acc('1020'), debit: 100000 }, { account: t.acc('3400'), credit: 100000 }] }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S20', seq: '20', date: '2026-03-20', open: 100000, entries: [{ ref: 'c', asr: 'L9000000CC00T001', amountMinor: 4500, cd: 'DBIT', date: '2026-03-20' }] }), idempotencyKey: key() }));
  const csv = zkbCsv(
    [
      { date: '2026-03-09', text: 'Credit originator: Beispiel Holding AG', ref: 'Z900000000301', minor: 100 },
      { date: '2026-03-14', text: 'Online purchase Debit card, HOTEL BEISPIEL', ref: 'L9000000CC00T001-1', minor: -4500 },
      { date: '2026-03-16', text: 'Fee', ref: 'L9000000CC00T002-1', minor: -100 },
    ],
    { start: 100000 },
  );
  return { t, csv };
}

// =========================================================================================================
// DEFECT PROBES
// =========================================================================================================

test('R1 (HIGH, double count): a duplicate the r1-F3 restore puts back into the import is NOT flagged when its twin is more than 3 days away', () => {
  const { t, csv } = cardWorld();
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: csv, mapping: MAPPING, fill: { from: '2026-03-10', to: '2026-03-15' }, idempotencyKey: key() }));
  const part = res.fill.parts[0];
  const held = lines(t, "t.amount_minor = 4500 AND t.credit_debit = 'DBIT'");
  const fillLine = held.find((l) => l.fmt === 'csv');
  const flagged = fillLine === undefined ? 0 : t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_possible_duplicate WHERE workspace_id = ? AND bank_txn_id = ?').get(t.workspaceId, fillLine.id).n;
  assert.ok(
    held.length === 1 || flagged > 0,
    `the purchase is held ${held.length} times (${held.map((l) => l.fmt).join(', ')}), the CSV copy flagged ${flagged} time(s); part ${part.status}, alreadyInBooks ${part.alreadyInBooks}`,
  );
});

// =========================================================================================================
// CONFIRMING PROBES
// =========================================================================================================

test('C1: the restore keeps the fill statement internally consistent (opening + lines = closing)', () => {
  const { t, csv } = cardWorld();
  must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: csv, mapping: MAPPING, fill: { from: '2026-03-10', to: '2026-03-15' }, idempotencyKey: key() }));
  const fills = t.store.db.prepare("SELECT id, opening_balance_minor AS o, closing_balance_minor AS c FROM bank_statement WHERE workspace_id = ? AND statement_id LIKE 'csvfill:%'").all(t.workspaceId);
  assert.equal(fills.length, 1);
  for (const f of fills) {
    const net = t.store.db.prepare("SELECT COALESCE(SUM(CASE WHEN credit_debit = 'CRDT' THEN amount_minor ELSE -amount_minor END), 0) AS s FROM bank_txn WHERE workspace_id = ? AND statement_id = ?").get(t.workspaceId, f.id).s;
    assert.equal(f.o + net, f.c);
  }
});

test('C2: with the statement adjacent after the stretch, the same duplicate is still left out and the tie accounts for it', () => {
  const { t } = cardWorld();
  // A fill of 10. to 19.03 is adjacent to statement 20: the duplicate stands, the closing is moved by it.
  const csv2 = zkbCsv(
    [
      { date: '2026-03-09', text: 'Credit originator: Beispiel Holding AG', ref: 'Z900000000301', minor: 100 },
      { date: '2026-03-14', text: 'Online purchase Debit card, HOTEL BEISPIEL', ref: 'L9000000CC00T001-1', minor: -4500 },
      { date: '2026-03-16', text: 'Fee', ref: 'L9000000CC00T002-1', minor: -100 },
      { date: '2026-03-20', text: 'Fee', ref: 'L9000000CC00T003-1', minor: -1 },
    ],
    { start: 100000 },
  );
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: csv2, mapping: MAPPING, fill: { from: '2026-03-10', to: '2026-03-19' }, idempotencyKey: key() }));
  const part = res.fill.parts[0];
  assert.equal(part.alreadyInBooks, 1, JSON.stringify(part.problems));
  assert.equal(part.after.kind, 'statement');
  assert.equal(part.after.differenceMinor, 0);
  assert.equal(lines(t, "t.amount_minor = 4500 AND t.credit_debit = 'DBIT'").length, 1);
});

test('C3: on an EBICS account a range straddling the feed end is cut at it: the gap days fill, the later days do not', () => {
  const t = world();
  must(postEntry(t.ctx, { date: '2026-03-01', source: 'manual', description: 'Eröffnung', idempotencyKey: 'op', lines: [{ account: t.acc('1020'), debit: 100000 }, { account: t.acc('3400'), credit: 100000 }] }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S5', seq: '5', date: '2026-03-05', open: 100000, entries: [{ ref: 'a', asr: 'L9000000DD00T001', amountMinor: 100, cd: 'DBIT', date: '2026-03-05' }] }), idempotencyKey: key() }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S8', seq: '8', date: '2026-03-10', open: 99700, entries: [{ ref: 'b', asr: 'L9000000DD00T003', amountMinor: 100, cd: 'DBIT', date: '2026-03-10' }] }), idempotencyKey: key() }));
  const now = t.ctx.clock.now();
  t.store.db.prepare("INSERT INTO ebics_connection (id, workspace_id, host_url, host_id, partner_id, user_id_ebics, state, activated_at, created_at, updated_at) VALUES ('ebc_r2', ?, 'https://bank.invalid', 'HOSTR', 'PARTNERR', 'USERR', 'active', ?, ?, ?)").run(t.workspaceId, now, now, now);
  t.store.db.prepare("INSERT INTO ebics_connection_account (id, workspace_id, connection_id, bank_account_id, created_at) VALUES ('eca_r2', ?, 'ebc_r2', ?, ?)").run(t.workspaceId, t.bankAccountId, now);
  const csv = zkbCsv(
    [
      { date: '2026-03-05', text: 'Fee', ref: 'L9000000DD00T001-1', minor: -100 },
      { date: '2026-03-07', text: 'Fee', ref: 'L9000000DD00T002-1', minor: -200 },
      { date: '2026-03-10', text: 'Fee', ref: 'L9000000DD00T003-1', minor: -100 },
      { date: '2026-03-12', text: 'Fee', ref: 'L9000000DD00T004-1', minor: -300 },
      { date: '2026-03-14', text: 'Fee', ref: 'L9000000DD00T005-1', minor: -50 },
    ],
    { start: 100000 },
  );
  const res = must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: csv, mapping: MAPPING, fill: { from: '2026-03-06', to: '2026-03-13' }, idempotencyKey: key() }));
  assert.deepEqual(res.fill.parts.map((p) => [p.from, p.to, p.status]), [['2026-03-06', '2026-03-09', 'imported']]);
  assert.equal(lines(t, "s.message_type = 'csv' AND t.booking_date > '2026-03-10'").length, 0);
});

test('C4: Q7 on a multi-day camt.053 over the period end reads the balance at the end; on a statement ending at the period end nothing changes', () => {
  const t = world();
  must(postEntry(t.ctx, { date: '2026-03-01', source: 'manual', description: 'Eröffnung', idempotencyKey: 'op', lines: [{ account: t.acc('1020'), debit: 100000 }, { account: t.acc('3400'), credit: 100000 }] }));
  must(postEntry(t.ctx, { date: '2026-03-30', source: 'manual', description: 'Spesen', idempotencyKey: 'e', lines: [{ account: t.acc('6500'), debit: 1000 }, { account: t.acc('1020'), credit: 1000 }] }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'M1', seq: '1', date: '2026-03-28', to: '2026-04-03', open: 100000, entries: [
    { ref: 'x', amountMinor: 1000, cd: 'DBIT', date: '2026-03-30' },
    { ref: 'y', amountMinor: 7000, cd: 'DBIT', date: '2026-04-02' },
  ] }), idempotencyKey: key() }));
  const v = evaluateValidation(t.ctx, 'bank_balance_matches', { label: '2026-03', periodStart: '2026-03-01', periodEnd: '2026-03-31' });
  assert.equal(v.figures.accounts[0].statementMinor, 99000);
  assert.equal(v.figures.accounts[0].differenceMinor, 0);
  const w = evaluateValidation(t.ctx, 'bank_balance_matches', { label: '2026-04', periodStart: '2026-04-01', periodEnd: '2026-04-03' });
  assert.equal(w.figures.accounts[0].statementMinor, 92000);
});
