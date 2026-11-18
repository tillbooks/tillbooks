// A20 §13.3 (D205, design docs/planning/a20-13-neighbour-sum-design.md): a gap between two stored statements,
// filled from an export WITHOUT a balance column, proven by the neighbour sum. The design's eleven tests and
// the critic's adversarial probes A1 to A6, as regression tests.
//
// SYNTHETIC DATA ONLY: every row, reference, name and amount below is invented here; the IBAN is the
// published sample of bank-inbox-support.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { importCamt, statementGaps } from '../../dist/core/banking/index.js';
import { accountStatementGaps } from '../../dist/core/banking/statementGaps.js';
import { importBankStatement, bankCsvPreview } from '../../dist/core/banking/statementImport.js';
import { fillStatementOf } from '../../dist/core/banking/csvGapFill.js';
import { csvStatementOf, readCsvTable } from '../../dist/core/banking/csvStatement.js';
import { insertStatement } from '../../dist/core/banking/camtReconcile.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { assertClaimInvariantHolds, world, must, refused, camt, secondWorkspace } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

let n = 0;
const key = () => `nsum-${(n += 1)}`;

const dmy = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const money = (minor) => (minor / 100).toFixed(2);

/** No balance column: the date, a text, the bank's reference and one signed amount. */
const NOBAL = { columns: { bookingDate: 'Datum', text: 'Text', reference: 'Referenz', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.', referenceSuffix: 'strip_dash_number' };

/** An export, oldest row first: { date, text, ref, minor, cur?, bal? }. `balance` adds a Saldo column, `currency` a Währung one. */
function csvOf(rows, { balance = false, currency = false } = {}) {
  const head = ['Datum', 'Text', 'Referenz', 'Betrag', ...(balance ? ['Saldo'] : []), ...(currency ? ['Währung'] : [])];
  const body = rows.map((r) => [dmy(r.date), r.text ?? 'Zahlung', r.ref ?? '', money(r.minor), ...(balance ? [money(r.bal)] : []), ...(currency ? [r.cur ?? 'CHF'] : [])].join(';'));
  return `${head.join(';')}\n${body.join('\n')}\n`;
}

/** A camt.053 day with each entry's AcctSvcrRef. */
function camtDay({ id, seq, date, open, entries }) {
  let xml = camt({ statementId: id, seqNb: seq, from: date, to: date, openingMinor: open, entries: entries.map((e) => ({ ...e, date: e.date ?? date })) });
  for (const e of entries) if (e.asr !== undefined) xml = xml.replace(`<NtryRef>${e.ref}</NtryRef>`, `<NtryRef>${e.ref}</NtryRef><AcctSvcrRef>${e.asr}</AcctSvcrRef>`);
  return xml;
}

const P_CLOSE = 98760;
/**
 * The book: P = statement 50 on 23.03.2026 (opens 1'000.00, a card purchase of 12.40: closes 987.60), N =
 * statement 53 on 28.03.2026 (`nOpen`, a card purchase of 20.00 and whatever `nExtra` adds); 51 and 52 are
 * missing, so the gap is 24. to 27.03.
 */
function book({ nOpen = P_CLOSE + 25000, nExtra = [], pExtra = [], q = null } = {}) {
  const t = world();
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S50', seq: '50', date: '2026-03-23', open: 100000 + pExtra.reduce((s, e) => s + (e.cd === 'CRDT' ? -e.amountMinor : e.amountMinor), 0), entries: [{ ref: 'k50', asr: 'L9T003', amountMinor: 1240, cd: 'DBIT' }, ...pExtra] }), idempotencyKey: key() }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S53', seq: '53', date: '2026-03-28', open: nOpen, entries: [{ ref: 'k53', asr: 'L9T005', amountMinor: 2000, cd: 'DBIT' }, ...nExtra] }), idempotencyKey: key() }));
  if (q !== null) must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S56', seq: '56', date: '2026-04-02', open: q.open, entries: q.entries }), idempotencyKey: key() }));
  return t;
}

/** The export of the base book: 23.03 (in P), 25.03 (the missing day's credit), 28.03 (in N). */
const BASE = [
  { date: '2026-03-23', text: 'Kartenkauf Kiosk', ref: 'L9T003-1', minor: -1240 },
  { date: '2026-03-25', text: 'Gutschrift Kunde Test GmbH', ref: 'Z104', minor: 25000 },
  { date: '2026-03-28', text: 'Kartenkauf Buchladen', ref: 'L9T005-1', minor: -2000 },
];
const GAP = { from: '2026-03-24', to: '2026-03-27' };

const fillIt = (t, content, fill = GAP, extra = {}) => importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content, mapping: NOBAL, fill, idempotencyKey: key(), ...extra });
const fills = (t) =>
  t.store.db.prepare("SELECT id, from_date, to_date, opening_balance_minor AS o, closing_balance_minor AS c, fill_proof AS proof FROM bank_statement WHERE workspace_id = ? AND statement_id LIKE 'csvfill:%' ORDER BY from_date").all(t.workspaceId);
const lineSum = (t, statementRowId) =>
  t.store.db.prepare("SELECT COALESCE(SUM(CASE WHEN credit_debit = 'CRDT' THEN amount_minor ELSE -amount_minor END), 0) AS s FROM bank_txn WHERE workspace_id = ? AND statement_id = ?").get(t.workspaceId, statementRowId).s;
const txnCount = (t) => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).n;
const setting = (t, k, value) => must(settingsSet(t.ctx, { key: k, value, idempotencyKey: key(), reason: 'test' }));

// --- The design's eleven tests ------------------------------------------------------------------------------

test('1. an exact sum closes the gap: fill_proof neighbour_sum, filledProof set, opening + lines = closing; the preview says so first', () => {
  const t = book();
  const pv = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: csvOf(BASE), mapping: NOBAL, fill: GAP }));
  assert.deepEqual([pv.fill.parts[0].status, pv.fill.parts[0].proof], ['ready', 'neighbour_sum']);
  assert.deepEqual(pv.fill.parts[0].sum, { expectedMinor: 25000, actualMinor: 25000, differenceMinor: 0, heldBeforeMinor: 0, heldAfterMinor: 0 });
  assert.equal(pv.fill.proofMode, 'auto');
  const res = must(fillIt(t, csvOf(BASE)));
  assert.deepEqual(res.fill.parts.map((p) => [p.status, p.proof, p.closesTarget, p.closedGapIds.length]), [['imported', 'neighbour_sum', true, 1]]);
  const [f] = fills(t);
  assert.deepEqual([f.from_date, f.to_date, f.o, f.c, f.proof], ['2026-03-24', '2026-03-27', P_CLOSE, P_CLOSE + 25000, 'neighbour_sum']);
  assert.equal(f.o + lineSum(t, f.id), f.c, 'opening + lines = closing');
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 0, 'the gap leaves the list');
  const gap = accountStatementGaps(t.ctx, t.bankAccountId)[0];
  assert.deepEqual([gap.filledBy, gap.filledProof], [[f.id], 'neighbour_sum']);
});

test('2. five Rappen off: csv_fill_untied with the difference 5, nothing written', () => {
  const t = book();
  const before = txnCount(t);
  const rows = BASE.map((r) => (r.ref === 'Z104' ? { ...r, minor: 25005 } : r));
  const res = must(fillIt(t, csvOf(rows)));
  assert.deepEqual([res.statements[0].outcome, res.statements[0].code, res.imported], ['refused', 'csv_fill_untied', 0]);
  assert.deepEqual(res.fill.parts[0].problems, [{ code: 'untied', side: 'after', differenceMinor: 5 }]);
  assert.equal(res.fill.parts[0].sum.differenceMinor, 5);
  assert.match(res.statements[0].reason, /25005 Rappen.*25000 Rappen.*5 Rappen/);
  assert.equal(txnCount(t), before);
  assert.equal(fills(t).length, 0);
});

test('3. an export that starts inside the days is open_end before; one that ends inside them open_end after', () => {
  const t = book();
  const late = must(fillIt(t, csvOf(BASE.slice(1))));
  assert.deepEqual([late.statements[0].code, late.fill.parts[0].problems[0]], ['csv_fill_open_end', { code: 'open_end', side: 'before' }]);
  const early = must(fillIt(t, csvOf(BASE.slice(0, 2))));
  assert.deepEqual([early.statements[0].code, early.fill.parts[0].problems[0]], ['csv_fill_open_end', { code: 'open_end', side: 'after' }]);
  assert.equal(fills(t).length, 0);
});

test('4. a mapped balance column whose chain breaks refuses csv_fill_chain_broken, even when the rows sum to T', () => {
  const t = book();
  const rows = [
    { ...BASE[0], bal: P_CLOSE },
    { ...BASE[1], bal: P_CLOSE + 25000 + 100 },
    { ...BASE[2], bal: P_CLOSE + 25000 - 2000 },
  ];
  const res = must(fillIt(t, csvOf(rows, { balance: true }), GAP, { mapping: { ...NOBAL, columns: { ...NOBAL.columns, balance: 'Saldo' } } }));
  assert.equal(res.statements[0].code, 'csv_fill_chain_broken');
  assert.equal(res.fill.parts[0].proof, null);
  assert.equal(res.fill.parts[0].sum, null, 'never the sum');
  assert.equal(fills(t).length, 0);
});

test('5. a Saturday row held in N by its -1 reference is skipped and the gap closes; all rows held: a zero-line fill closes', () => {
  // The bank books the card purchase of Friday 27.03 on N (28.03): the export dates it 27.03.
  const t = book({ nOpen: P_CLOSE + 25000, nExtra: [{ ref: 'k53b', asr: 'L9T009', amountMinor: 700, cd: 'DBIT' }] });
  const rows = [BASE[0], BASE[1], { date: '2026-03-27', text: 'Kartenkauf Bäckerei', ref: 'L9T009-1', minor: -700 }, BASE[2]];
  const res = must(fillIt(t, csvOf(rows)));
  const part = res.fill.parts[0];
  assert.deepEqual([part.status, part.alreadyInBooks, part.closesTarget], ['imported', 1, true]);
  assert.equal(part.sum.heldAfterMinor, -700);
  assert.equal(res.imported, 1);
  // Every row of the missing days held: the fill writes no line and still closes the gap.
  const u = book({ nOpen: P_CLOSE, nExtra: [{ ref: 'k53b', asr: 'L9T009', amountMinor: 700, cd: 'DBIT' }] });
  const zero = must(fillIt(u, csvOf([BASE[0], { date: '2026-03-27', text: 'Kartenkauf Bäckerei', ref: 'L9T009-1', minor: -700 }, BASE[2]])));
  assert.deepEqual([zero.fill.parts[0].status, zero.imported, zero.fill.parts[0].closesTarget, zero.fill.parts[0].closedGapIds.length], ['imported', 0, true, 1]);
  assert.equal(statementGaps(u.ctx, { bankAccountId: u.bankAccountId }).length, 0);
});

test('6. the before-feed hole without a balance is csv_fill_needs_balance, while the numbered gap in the same call fills', () => {
  const t = book();
  must(postEntry(t.ctx, { date: '2026-03-05', source: 'manual', description: 'Übernahme Bank', idempotencyKey: key(), lines: [{ account: t.acc('1020'), debit: 101240 }, { account: t.acc('3400'), credit: 101240 }] }));
  const rows = [{ date: '2026-03-05', text: 'Übernahme', ref: 'Z100', minor: 101240 }, { date: '2026-03-12', text: 'Gebühr', ref: 'Z101', minor: -1240 }, ...BASE];
  const res = must(fillIt(t, csvOf(rows), {}));
  const byKind = Object.fromEntries(res.fill.parts.map((p) => [p.kind, p]));
  assert.deepEqual([byKind.before_feed.status, byKind.before_feed.problems[0]], ['refused', { code: 'no_balance_column', side: 'before' }]);
  assert.equal(res.statements.find((s) => s.fromDate === '2026-03-06').code, 'csv_fill_needs_balance');
  assert.deepEqual([byKind.gap.status, byKind.gap.proof, byKind.gap.closesTarget], ['imported', 'neighbour_sum', true]);
});

test('7. a range over two gaps and a tail: both gaps close, the tail is csv_fill_needs_balance', () => {
  const t = book({ q: { open: P_CLOSE + 25000 - 2000 + 1000, entries: [{ ref: 'k56', asr: 'L9T007', amountMinor: 300, cd: 'DBIT' }] } });
  const rows = [
    ...BASE,
    { date: '2026-03-30', text: 'Gutschrift Muster AG', ref: 'Z105', minor: 1000 },
    { date: '2026-04-02', text: 'Gebühr', ref: 'L9T007-1', minor: -300 },
    { date: '2026-04-04', text: 'Kartenkauf', ref: 'Z106', minor: -100 },
    { date: '2026-04-06', text: 'Gutschrift', ref: 'Z107', minor: 50 },
  ];
  const res = must(fillIt(t, csvOf(rows), { from: '2026-03-24', to: '2026-04-05' }));
  assert.deepEqual(res.fill.parts.map((p) => [p.from, p.to, p.status, p.closesTarget]), [
    ['2026-03-24', '2026-03-27', 'imported', true],
    ['2026-03-29', '2026-04-01', 'imported', true],
    ['2026-04-03', '2026-04-05', 'refused', false],
  ]);
  assert.deepEqual(res.fill.parts[2].problems[0], { code: 'no_balance_column', side: 'after' });
  assert.equal(res.statements[2].code, 'csv_fill_needs_balance');
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 0);
});

test('8. running_balance_only: a fill without a balance column is refused for the whole file, at draft and at run', () => {
  const t = book();
  setting(t, 'bank.csv_fill_proof', 'running_balance_only');
  refused(fillIt(t, csvOf(BASE)), 'csv_fill_needs_balance');
  assert.equal(fills(t).length, 0);
});

test('9. the same call replays; a new key plans no part; a running-balance digest is unchanged and only a sum fill gains its line', () => {
  const t = book();
  const k = key();
  const first = must(fillIt(t, csvOf(BASE), GAP, { idempotencyKey: k }));
  assert.deepEqual(fillIt(t, csvOf(BASE), GAP, { idempotencyKey: k }), first, 'the same key replays the answer');
  const again = must(fillIt(t, csvOf(BASE)));
  assert.deepEqual([again.imported, again.fill.parts.length], [0, 0], 'the days are held now: nothing is planned');
  // The digest formula of §12, written out: a running-balance part's id is exactly that; a sum part adds one line.
  const entry = { entryKey: 'csv:2026-03-25|CRDT|25000|CHF#0', bookingDate: '2026-03-25', creditDebit: 'CRDT', amountMinor: 25000, currency: 'CHF', entryRef: 'Z104', remittanceText: 'x' };
  const part = { from: '2026-03-24', to: '2026-03-27', openingMinor: 100, closingMinor: 25100, entries: [entry], problems: [], path: 'running_balance' };
  const lines = ['2026-03-24', '2026-03-27', 100, 25100, 'mdig', [entry.entryKey, entry.bookingDate, entry.creditDebit, entry.amountMinor, entry.currency, entry.entryRef, entry.remittanceText].join('\u001f')];
  const digest = (ls) => `csvfill:${createHash('sha256').update(ls.join('\n'), 'utf8').digest('hex').slice(0, 24)}`;
  assert.equal(fillStatementOf(part, 'CHF', 'mdig', 'required').statementId, digest(lines));
  assert.equal(fillStatementOf({ ...part, path: 'neighbour_sum' }, 'CHF', 'mdig', 'required').statementId, digest([...lines, 'proof:neighbour_sum']));
});

test('10. §H-TENANT across two workspaces; append-only: no earlier statement row changes', () => {
  const t = book();
  const other = secondWorkspace(t);
  const snapshot = () => t.store.db.prepare("SELECT * FROM bank_statement WHERE workspace_id = ? AND statement_id NOT LIKE 'csvfill:%' ORDER BY id").all(t.workspaceId);
  const before = snapshot();
  must(fillIt(t, csvOf(BASE)));
  assert.deepEqual(snapshot(), before, 'P and N are untouched');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ?').get(other.workspaceId).n, 0);
  refused(importBankStatement(other.ctx, { bankAccountId: t.bankAccountId, content: csvOf(BASE), mapping: NOBAL, fill: GAP, idempotencyKey: key() }), 'needs_bank_account');
  refused(bankCsvPreview(other.ctx, { bankAccountId: t.bankAccountId, content: csvOf(BASE), mapping: NOBAL, fill: GAP }), 'needs_bank_account');
});

test('11. a row in another currency anywhere in the file is csv_fill_unreadable_row, naming it', () => {
  const t = book();
  const rows = [{ date: '2026-03-20', text: 'Fremdwährung', ref: 'Z099', minor: -500, cur: 'EUR' }, ...BASE];
  const res = must(fillIt(t, csvOf(rows, { currency: true }), GAP, { mapping: { ...NOBAL, columns: { ...NOBAL.columns, currency: 'Währung' } } }));
  assert.equal(res.statements[0].code, 'csv_fill_unreadable_row');
  assert.deepEqual(res.fill.parts[0].problems, [{ code: 'unreadable_row', row: 2 }]);
  assert.equal(fills(t).length, 0);
});

// --- The critic's adversarial probes, as regression tests ---------------------------------------------------

test('A1: warn never closes a gap: five Rappen off under warn stores NULL balances and NULL fill_proof; the gap stays open', () => {
  const t = book();
  setting(t, 'bank.csv_fill_balance_tie', 'warn');
  const res = must(fillIt(t, csvOf(BASE.map((r) => (r.ref === 'Z104' ? { ...r, minor: 25005 } : r)))));
  assert.deepEqual([res.statements[0].outcome, res.statements[0].warnings], ['imported', ['csv_fill_untied']]);
  const [f] = fills(t);
  assert.deepEqual([f.o, f.c, f.proof], [null, null, null]);
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 1, 'the gap is still open');
});

test('A2: an equal-amount swap across the boundary is csv_fill_boundary_mismatch, nothing written', () => {
  // The export dates a 4.50 row on 23.03 that P does not hold; N holds a 4.50 line without a reference that
  // the export dates in the gap. The sum alone would agree.
  const t = book({ nOpen: P_CLOSE + 25000 - 450, nExtra: [{ ref: 'k53c', amountMinor: 450, cd: 'DBIT' }] });
  const rows = [BASE[0], { date: '2026-03-23', text: 'Kiosk', minor: -450 }, BASE[1], { date: '2026-03-26', text: 'Kiosk', minor: -450 }, BASE[2]];
  const before = txnCount(t);
  const res = must(fillIt(t, csvOf(rows)));
  assert.equal(res.statements[0].code, 'csv_fill_boundary_mismatch');
  assert.deepEqual(res.fill.parts[0].boundary.map((b) => [b.side, b.day, b.exportOnlyRows.length, b.booksOnlyTxnIds.length]), [
    ['before', '2026-03-23', 1, 0],
    ['after', '2026-03-28', 0, 1],
  ]);
  assert.equal(txnCount(t), before);
});

test('A3: a fill whose stored lines do not sum to its balances never closes a gap (guard 6, read side)', () => {
  const t = book();
  // A fill row as a skipped entry would leave it: balances that tie both ends, but no line inside.
  t.store.db
    .prepare(
      `INSERT INTO bank_statement (id, workspace_id, bank_account_id, message_type, statement_id, electronic_seq_nb, page_number, last_page_ind, content_hash, from_date, to_date, opening_balance_minor, closing_balance_minor, balance_currency, txn_count, imported_by, imported_at, fill_proof, fill_held_minor)
       VALUES ('bst_probe', ?, ?, 'csv', 'csvfill:probe', NULL, 1, 1, 'h', '2026-03-24', '2026-03-27', ?, ?, 'CHF', 0, 'probe', '2026-11-15T00:00:00Z', 'neighbour_sum', 0)`,
    )
    .run(t.workspaceId, t.bankAccountId, P_CLOSE, P_CLOSE + 25000);
  assert.equal(accountStatementGaps(t.ctx, t.bankAccountId)[0].filledBy, undefined, 'its lines sum to 0, not 250.00: no fill');
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 1);
});

test('re-critic L1: a fill written before guard 6 (fill_held_minor NULL) keeps its rule, its balances alone', () => {
  const t = book();
  t.store.db
    .prepare(
      `INSERT INTO bank_statement (id, workspace_id, bank_account_id, message_type, statement_id, electronic_seq_nb, page_number, last_page_ind, content_hash, from_date, to_date, opening_balance_minor, closing_balance_minor, balance_currency, txn_count, imported_by, imported_at)
       VALUES ('bst_legacy', ?, ?, 'csv', 'csvfill:legacy', NULL, 1, 1, 'h', '2026-03-24', '2026-03-27', ?, ?, 'CHF', 0, 'probe', '2026-11-09T00:00:00Z')`,
    )
    .run(t.workspaceId, t.bankAccountId, P_CLOSE, P_CLOSE + 25000);
  assert.deepEqual(accountStatementGaps(t.ctx, t.bankAccountId)[0].filledBy, ['bst_legacy'], 'a legacy fill with an absorbed line is not reopened');
  assert.equal(accountStatementGaps(t.ctx, t.bankAccountId)[0].filledProof, 'running_balance');
});

test('re-critic L2: the insertion records every entry it skips on a fill as held, with its sign (absorbed and exact repeat)', () => {
  // A CSV-family fill is never absorbed (statementDedupe.ts: only camt and MT940 lines carry a bank reference into
  // the cross-format rule), so the branch is driven with an MT940-family fill statement: one entry carries N's bank
  // reference on N's booking day (absorbed under auto_strong), one repeats N's bank-reference key (an exact repeat).
  const t = book({ nExtra: [{ ref: 'k53f', asr: 'L9T009', amountMinor: 700, cd: 'DBIT', date: '2026-03-26' }] });
  setting(t, 'bank.cross_format_duplicates', 'auto_strong');
  const parsed = csvStatementOf(readCsvTable({ text: csvOf([BASE[1], { date: '2026-03-26', text: 'Kartenkauf', ref: 'L9T009', minor: -700 }]) }), NOBAL, 'CHF');
  const card = parsed.entries.find((e) => e.amountMinor === 700);
  card.facts = { ...card.facts, source: 'mt940', refs: { ...card.facts.refs, accountServicerRef: 'L9T009' } };
  const repeat = { ...card, entryKey: 'asr:L9T005', entryRef: 'L9T005', amountMinor: 2000, bookingDate: '2026-03-28', valueDate: '2026-03-28', facts: { ...card.facts, refs: { ...card.facts.refs, accountServicerRef: null } } };
  const stmt = { ...parsed, messageType: 'mt940', statementId: 'csvfill:absorb', entries: [...parsed.entries, repeat], fromDate: '2026-03-24', toDate: '2026-03-27', openingBalanceMinor: P_CLOSE, closingBalanceMinor: P_CLOSE + 22300, balanceCurrency: 'CHF', fill: { proof: 'neighbour_sum' } };
  const res = t.store.tx(() => insertStatement(t.ctx, { id: t.bankAccountId }, stmt, 'h-absorb', false, []));
  assert.deepEqual(res.skipped.map((s) => s.reason).sort(), ['cross_format_duplicate', 'duplicate_entry']);
  const row = t.store.db.prepare("SELECT id, fill_held_minor AS h, fill_proof AS p FROM bank_statement WHERE workspace_id = ? AND statement_id = 'csvfill:absorb'").get(t.workspaceId);
  assert.deepEqual([row.h, row.p], [-2700, 'neighbour_sum'], 'both skipped debits are held, with their sign');
  assert.equal(lineSum(t, row.id) + row.h, 22300, 'stored lines plus held money are the fill\'s own movement');
  // A statement that is no fill records nothing held.
  assert.equal(t.store.db.prepare("SELECT fill_held_minor AS h FROM bank_statement WHERE workspace_id = ? AND statement_id = 'S50'").get(t.workspaceId).h, null);
});

test('A4: a debits-only export while N\'s first day holds a credit is csv_fill_boundary_mismatch', () => {
  const t = book({ nOpen: P_CLOSE - 300, nExtra: [{ ref: 'k53d', amountMinor: 5000, cd: 'CRDT' }] });
  const rows = [BASE[0], { date: '2026-03-26', text: 'Gebühr', ref: 'Z108', minor: -300 }, BASE[2]];
  const res = must(fillIt(t, csvOf(rows)));
  assert.equal(res.statements[0].code, 'csv_fill_boundary_mismatch');
  assert.deepEqual(res.fill.parts[0].boundary.map((b) => [b.side, b.booksOnlyTxnIds.length]), [['after', 1]]);
});

test('A5: a false duplicate (a recurring reference held in N) is left out, the sum falls short: csv_fill_untied', () => {
  const t = book({ nOpen: P_CLOSE + 25000 - 9900, nExtra: [{ ref: 'k53e', asr: 'DAUER', amountMinor: 9900, cd: 'DBIT' }] });
  const rows = [BASE[0], BASE[1], { date: '2026-03-26', text: 'Dauerauftrag Miete', ref: 'DAUER-1', minor: -9900 }, BASE[2]];
  const res = must(fillIt(t, csvOf(rows)));
  assert.equal(res.statements[0].code, 'csv_fill_untied');
  assert.equal(res.fill.parts[0].sum.differenceMinor, 9900);
  assert.equal(res.fill.parts[0].alreadyInBooks, 1);
  assert.equal(fills(t).length, 0);
});

test('A6: a weak neighbour (P is a warn fill with NULL balances) fails guard 1: csv_fill_needs_balance', () => {
  // S50 on 20.03, S53 on 28.03; a warn fill of 21. to 23.03, five Rappen off, stands without balances.
  const t = world();
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S50', seq: '50', date: '2026-03-20', open: 100000, entries: [{ ref: 'k50', asr: 'L9T001', amountMinor: 1000, cd: 'DBIT' }] }), idempotencyKey: key() }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S53', seq: '53', date: '2026-03-28', open: 99000 - 1240 + 25000, entries: [{ ref: 'k53', asr: 'L9T005', amountMinor: 2000, cd: 'DBIT' }] }), idempotencyKey: key() }));
  setting(t, 'bank.csv_fill_balance_tie', 'warn');
  const rows = [{ date: '2026-03-20', text: 'Gebühr', ref: 'L9T001-1', minor: -1000 }, { date: '2026-03-23', text: 'Kartenkauf Kiosk', ref: 'Z200', minor: -1245 }, BASE[1], BASE[2]];
  const weak = must(fillIt(t, csvOf(rows), { from: '2026-03-21', to: '2026-03-23' }));
  assert.equal(weak.fill.parts[0].status, 'imported');
  assert.deepEqual(fills(t).map((f) => [f.o, f.c, f.proof]), [[null, null, null]]);
  setting(t, 'bank.csv_fill_balance_tie', 'required');
  const next = must(fillIt(t, csvOf(rows)));
  assert.deepEqual([next.statements[0].code, next.fill.parts[0].problems[0]], ['csv_fill_needs_balance', { code: 'no_balance_column', side: 'before' }]);
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 1);
});

// --- Critic round 1 -------------------------------------------------------------------------------------------

test('M1: under warn an export ending inside the gap writes NOTHING, and a later full export still fills the gap', () => {
  const t = world();
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S50', seq: '50', date: '2026-03-10', open: 100000, entries: [{ ref: 'k50', asr: 'L9T003', amountMinor: 1240, cd: 'DBIT' }] }), idempotencyKey: key() }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camtDay({ id: 'S53', seq: '53', date: '2026-03-28', open: P_CLOSE + 24500, entries: [{ ref: 'k53', asr: 'L9T005', amountMinor: 2000, cd: 'DBIT' }] }), idempotencyKey: key() }));
  setting(t, 'bank.csv_fill_balance_tie', 'warn');
  const gap = { from: '2026-03-11', to: '2026-03-27' };
  const head = [
    { date: '2026-03-10', text: 'Kartenkauf Kiosk', ref: 'L9T003-1', minor: -1240 },
    { date: '2026-03-12', text: 'Gutschrift Kunde Test GmbH', ref: 'Z104', minor: 25000 },
    { date: '2026-03-13', text: 'Gebühr', ref: 'Z105', minor: -100 },
  ];
  const short = must(fillIt(t, csvOf(head), gap));
  assert.deepEqual([short.statements[0].outcome, short.statements[0].code, short.fill.parts[0].problems[0]], ['refused', 'csv_fill_open_end', { code: 'open_end', side: 'after' }]);
  assert.equal(fills(t).length, 0, 'no statement holds the days, under warn too');
  const pv = must(bankCsvPreview(t.ctx, { bankAccountId: t.bankAccountId, content: csvOf(head), mapping: NOBAL, fill: gap }));
  assert.equal(pv.fill.parts[0].status, 'blocked');
  const full = must(fillIt(t, csvOf([...head, { date: '2026-03-20', text: 'Kartenkauf', ref: 'Z106', minor: -400 }, { date: '2026-03-28', text: 'Kartenkauf Buchladen', ref: 'L9T005-1', minor: -2000 }]), gap));
  assert.deepEqual([full.fill.parts[0].status, full.fill.parts[0].proof, full.fill.parts[0].closesTarget], ['imported', 'neighbour_sum', true]);
  assert.equal(statementGaps(t.ctx, { bankAccountId: t.bankAccountId }).length, 0);
});

/** A statement row written straight into the books (a probe: a page, an undated delivery, a second neighbour). */
function rawStatement(t, { id, type = 'mt940', from, to, open = null, close = null, page = 1, last = 1 }) {
  t.store.db
    .prepare(
      `INSERT INTO bank_statement (id, workspace_id, bank_account_id, message_type, statement_id, electronic_seq_nb, page_number, last_page_ind, content_hash, from_date, to_date, opening_balance_minor, closing_balance_minor, balance_currency, txn_count, imported_by, imported_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'h', ?, ?, ?, ?, 'CHF', 0, 'probe', '2026-11-15T00:00:00Z')`,
    )
    .run(id, t.workspaceId, t.bankAccountId, type, `probe:${id}`, page, last, from, to, open, close);
}

test('guard 5, every unreadable kind: an unreadable date, an unreadable amount, and (L1) a dateless row with an amount', () => {
  for (const [label, extra, row] of [
    ['unreadable date', { date: '2026-03-20', text: 'Gebühr', ref: 'Z090', minor: -500 }, (csv) => csv.replace('20.03.2026', '32.03.2026')],
    ['unreadable amount', { date: '2026-03-20', text: 'Gebühr', ref: 'Z091', minor: -500 }, (csv) => csv.replace('-5.00', 'fünf')],
    ['dateless amount', { date: '2026-03-20', text: 'Total', ref: 'Z092', minor: -500 }, (csv) => csv.replace('20.03.2026;Total', ';Total')],
  ]) {
    const t = book();
    const res = must(fillIt(t, row(csvOf([extra, ...BASE]))));
    assert.equal(res.statements[0].code, 'csv_fill_unreadable_row', label);
    assert.deepEqual(res.fill.parts[0].problems, [{ code: 'unreadable_row', row: 2 }], label);
  }
});

test('guard 1 (mutation): two statements ending on the day before the gap with different closings are no neighbour', () => {
  const t = book();
  rawStatement(t, { id: 'bst_probe2', from: '2026-03-23', to: '2026-03-23', open: 100000, close: 50000 });
  const res = must(fillIt(t, csvOf(BASE)));
  assert.deepEqual([res.statements[0].code, res.fill.parts[0].problems[0]], ['csv_fill_needs_balance', { code: 'no_balance_column', side: 'before' }]);
});

test('guard 1 (mutation): only a statement\'s LAST page closes it; an earlier page ending that day is no second neighbour', () => {
  const t = book();
  rawStatement(t, { id: 'bst_probe3', from: '2026-03-23', to: '2026-03-23', open: 100000, close: 12345, page: 1, last: 0 });
  const res = must(fillIt(t, csvOf(BASE)));
  assert.deepEqual([res.fill.parts[0].status, res.fill.parts[0].proof, res.fill.parts[0].closesTarget], ['imported', 'neighbour_sum', true]);
});

test('inside duplicates (mutation): a row the books hold in an undated statement is imported, flagged, and counts in the sum', () => {
  const t = book({ nOpen: P_CLOSE + 25000 - 800 });
  rawStatement(t, { id: 'bst_undated', type: 'csv', from: null, to: null });
  t.store.db
    .prepare(
      `INSERT INTO bank_txn (id, workspace_id, bank_account_id, statement_id, entry_key, entry_ref, amount_minor, currency, credit_debit, booking_date, value_date, classification, created_at)
       VALUES ('btxn_probe', ?, ?, 'bst_undated', 'asr:L9T008', 'L9T008', 800, 'CHF', 'DBIT', '2026-03-26', '2026-03-26', 'outgoing_debit', '2026-11-15T00:00:00Z')`,
    )
    .run(t.workspaceId, t.bankAccountId);
  const rows = [BASE[0], BASE[1], { date: '2026-03-26', text: 'Kartenkauf', ref: 'L9T008-1', minor: -800 }, BASE[2]];
  const res = must(fillIt(t, csvOf(rows)));
  const part = res.fill.parts[0];
  assert.deepEqual([part.status, part.alreadyInBooks, part.flagged, part.closesTarget], ['imported', 0, 1, true]);
  assert.equal(part.sum.actualMinor, 24200);
});

test('L5: the proof is written by the INSERT (an update of fill_proof is refused here, and the fill still stores it)', () => {
  const t = book();
  t.store.db.exec("CREATE TEMP TRIGGER probe_no_proof_update BEFORE UPDATE OF fill_proof ON bank_statement BEGIN SELECT RAISE(ABORT, 'fill_proof updated'); END;");
  must(fillIt(t, csvOf(BASE)));
  assert.deepEqual(fills(t).map((f) => f.proof), ['neighbour_sum']);
  t.store.db.exec('DROP TRIGGER probe_no_proof_update');
});

test('L2: guard 6 counts a line the insertion skipped as already held (fill_held_minor); without it the fill is no fill', () => {
  const t = book();
  rawStatement(t, { id: 'bst_held', type: 'csv', from: '2026-03-24', to: '2026-03-27', open: P_CLOSE, close: P_CLOSE + 25000 });
  t.store.db.prepare("UPDATE bank_statement SET statement_id = 'csvfill:held', fill_proof = 'neighbour_sum', fill_held_minor = 0 WHERE id = 'bst_held'").run();
  assert.equal(accountStatementGaps(t.ctx, t.bankAccountId)[0].filledBy, undefined, 'no line, nothing held: not a fill');
  t.store.db.prepare("UPDATE bank_statement SET fill_held_minor = 25000 WHERE id = 'bst_held'").run();
  assert.deepEqual(accountStatementGaps(t.ctx, t.bankAccountId)[0].filledBy, ['bst_held'], 'the held money counts');
  // A real fill records what it held: zero when nothing was skipped.
  const u = book();
  must(fillIt(u, csvOf(BASE)));
  assert.equal(u.store.db.prepare("SELECT fill_held_minor AS h FROM bank_statement WHERE workspace_id = ? AND statement_id LIKE 'csvfill:%'").get(u.workspaceId).h, 0);
});
