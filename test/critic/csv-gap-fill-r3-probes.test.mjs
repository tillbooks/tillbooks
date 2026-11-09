// Critic round 3 (non-author) probes for A20 §12, the CSV gap fill, against the r2 R1 fix at 1f45666ff:
// a duplicate restored to the import is flagged naming the stored line it matched. All probes confirm
// properties (they pass). Report: docs/critique/csv-gap-fill-critic-r3.md.
//
// SYNTHETIC DATA ONLY: every row, reference, name and amount is invented here; the IBAN is the published
// sample of bank-inbox-support.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { importCamt, listBankInbox, bookBankLine } from '../../dist/core/banking/index.js';
import { importBankStatement, bankCsvPreview } from '../../dist/core/banking/statementImport.js';
import { presetFor } from '../../dist/core/banking/csvMapping.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { assertClaimInvariantHolds, world, must, refused, camt } from '../banking/bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

let n = 0;
const key = () => `critic-r3-${(n += 1)}`;

const HEADER = ['Date', 'Booking text', 'Curr', 'Amount details', 'ZKB reference', 'Reference number', 'Debit CHF', 'Credit CHF', 'Value date', 'Balance CHF', 'Payment purpose', 'Details'];
const q = (v) => `"${v}"`;
const dmy = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const major = (minor) => (Math.abs(minor) / 100).toFixed(2);
const MAPPING = presetFor(HEADER).mapping;

function zkbCsv(rows, { start }) {
  let bal = start;
  const lines = rows.map((r) => {
    bal += r.minor;
    return [dmy(r.date), r.text, '', '', r.ref, '', r.minor < 0 ? major(r.minor) : '', r.minor > 0 ? major(r.minor) : '', dmy(r.date), major(bal), '', ''].map(q).join(';');
  });
  return `﻿${HEADER.map(q).join(';')}\r\n${lines.reverse().join('\r\n')}\r\n`;
}

function camtDay({ id, seq, date, open, entries }) {
  let xml = camt({ statementId: id, seqNb: seq, from: date, to: date, openingMinor: open, entries });
  for (const e of entries) if (e.asr !== undefined) xml = xml.replace(`<NtryRef>${e.ref}</NtryRef>`, `<NtryRef>${e.ref}</NtryRef><AcctSvcrRef>${e.asr}</AcctSvcrRef>`);
  return xml;
}

/** Statement 20 (20.03) books two card purchases the CSV dates 13. and 14.03; 16. to 19.03 hold no statement. */
function twoCards() {
  const t = world();
  must(postEntry(t.ctx, { date: '2026-03-01', source: 'manual', description: 'Eröffnung', idempotencyKey: 'op', lines: [{ account: t.acc('1020'), debit: 100000 }, { account: t.acc('3400'), credit: 100000 }] }));
  must(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camtDay({ id: 'S20', seq: '20', date: '2026-03-20', open: 100000, entries: [
        { ref: 'c1', asr: 'L9000000EE00T001', amountMinor: 4500, cd: 'DBIT', date: '2026-03-20' },
        { ref: 'c2', asr: 'L9000000EE00T002', amountMinor: 1200, cd: 'DBIT', date: '2026-03-20' },
      ] }),
      idempotencyKey: key(),
    }),
  );
  const csv = zkbCsv(
    [
      { date: '2026-03-09', text: 'Credit originator: Beispiel Holding AG', ref: 'Z900000000401', minor: 100 },
      { date: '2026-03-13', text: 'Online purchase Debit card, HOTEL BEISPIEL', ref: 'L9000000EE00T001-1', minor: -4500 },
      { date: '2026-03-14', text: 'Online purchase Debit card, BAHNHOF TEST', ref: 'L9000000EE00T002-1', minor: -1200 },
      { date: '2026-03-14', text: 'Credit originator: Kunde Test GmbH', ref: 'Z900000000402', minor: 3000 },
      { date: '2026-03-16', text: 'Fee', ref: 'L9000000EE00T003-1', minor: -100 },
    ],
    { start: 100000 },
  );
  return { t, csv, run: (k = key()) => importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content: csv, mapping: MAPPING, fill: { from: '2026-03-10', to: '2026-03-15' }, idempotencyKey: k }) };
}

const csvLines = (t) =>
  t.store.db
    .prepare("SELECT t.id, t.amount_minor AS a FROM bank_txn t JOIN bank_statement s ON s.workspace_id = t.workspace_id AND s.id = t.statement_id WHERE t.workspace_id = ? AND s.message_type = 'csv' ORDER BY t.rowid")
    .all(t.workspaceId);

test('C1: every restored row is flagged naming the stored line it matched; the genuinely new row is not', () => {
  const { t, run } = twoCards();
  const res = must(run());
  assert.equal(res.fill.parts[0].status, 'imported');
  const camtIds = new Map(t.store.db.prepare("SELECT t.amount_minor AS a, t.id FROM bank_txn t JOIN bank_statement s ON s.id = t.statement_id AND s.workspace_id = t.workspace_id WHERE t.workspace_id = ? AND s.message_type = 'camt053'").all(t.workspaceId).map((r) => [r.a, r.id]));
  const flags = new Map(t.store.db.prepare('SELECT bank_txn_id AS id, existing_bank_txn_id AS ex, reason FROM bank_txn_possible_duplicate WHERE workspace_id = ?').all(t.workspaceId).map((r) => [r.id, r]));
  for (const l of csvLines(t)) {
    const f = flags.get(l.id);
    if (l.a === 4500 || l.a === 1200) {
      assert.equal(f?.ex, camtIds.get(l.a), `CSV line ${l.a} names its camt twin`);
      assert.equal(f.reason, 'shared_reference');
    } else assert.equal(f, undefined, `the new line ${l.a} carries no flag`);
  }
});

test('C2: the flag reaches the inbox (needsDuplicateDecision) and blocks booking (duplicate_decision_pending)', () => {
  const { t, run } = twoCards();
  must(run());
  const line = csvLines(t).find((l) => l.a === 4500);
  const inbox = must(listBankInbox(t.ctx, { bankAccountId: t.bankAccountId, bankTxnId: line.id, status: 'all' }));
  const row = inbox.lines.find((x) => x.bankTxnId === line.id);
  assert.equal(row.needsDuplicateDecision, true);
  assert.notEqual(row.proposal?.certainty, 'sure');
  refused(bookBankLine(t.ctx, { bankTxnId: line.id, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 4500 }] }, idempotencyKey: key() }), 'duplicate_decision_pending');
});

test('C3: replay and a second call stay consistent: the same key answers the same; a new key finds the days held', () => {
  const { t, run } = twoCards();
  const k = key();
  const a = must(run(k));
  assert.deepEqual(run(k), a);
  const b = must(run());
  assert.equal(b.imported, 0);
  assert.equal(csvLines(t).length, 3);
  const flagged = t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_possible_duplicate WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(flagged, 2, 'no flag written twice, none lost');
});

test('C4: the other insertStatement callers are unchanged: a plain camt with no overlap carries no flag', () => {
  const t = world();
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'P1', seq: '1', date: '2026-05-04', open: 0, entries: [{ ref: 'p', asr: 'L9000000FF00T001', amountMinor: 700, cd: 'CRDT', date: '2026-05-04' }] }), idempotencyKey: key() }));
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_possible_duplicate WHERE workspace_id = ?').get(t.workspaceId).n, 0);
});

test('C5 (documents LOW): the preview counts a restored row as new (alreadyInBooks 0, inBooks null), though the import will flag it', () => {
  const { t } = twoCards();
  const { csv } = twoCards();
  const pv = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: csv, mapping: MAPPING, fill: { from: '2026-03-10', to: '2026-03-15' } }));
  const part = pv.fill.parts[0];
  assert.equal(part.status, 'ready');
  assert.equal(part.alreadyInBooks, 0);
  assert.ok(part.lines.filter((l) => l.amountMinor === -4500 || l.amountMinor === -1200).every((l) => l.inBooks === null), 'the plan does not name the twin it will flag');
});
