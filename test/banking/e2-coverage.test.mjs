// D178 point 19, the E2 re-cut (orchestrator ruling round 3; docs/critique/bank-parity-e2-recut-review.md):
// COVERAGE DECIDES FIRST. A delivery that extends the balance chain (its opening is the stored closing at the
// chain's end AND it starts later, or the next sequence the same day) brings new lines; a delivery that does
// not is matched one to one on the movement key on the days the books already cover (flagged `same_movement`,
// or `covered_period_new_line`); outside the covered span coverage flags nothing. Line keys are never tied to
// their delivery. The six holes the critic found on paper are pinned here, each by its input, with the one
// chokepoint, the delivery-wide answer and the generation-18 upgrade.
//
// SYNTHETIC DATA ONLY: every statement, reference and amount is invented here; the IBAN is the published
// PostFinance sample.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { importCamt, listBankInbox, confirmCamtMatch, createEntryForTxn } from '../../dist/core/banking/index.js';
import { importBankStatement } from '../../dist/core/banking/statementImport.js';
import { bookBankLine } from '../../dist/core/banking/bankBooking.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { resolvePossibleDuplicate } from '../../dist/core/banking/duplicateDecision.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { DATA_MIGRATIONS } from '../../dist/core/store/migrations.js';
import { coverageOf, storedMovements } from '../../dist/core/banking/statementCoverage.js';
import { getAction } from '../../dist/api/registry.js';
import { runGoverned } from '../../dist/api/agent-gate.js';
import { world, must, camt, postedBill, MAIN_IBAN } from './bank-inbox-support.mjs';

let n = 0;
const key = () => `cov-${(n += 1)}`;
const chf = (minor) => (minor / 100).toFixed(2).replace('.', ',');

/** One MT940 message with explicit balances: `page` null writes an unpaged `:28C:`. */
function sta({ num, page = null, last = true, openDate, open, closeDate, close, body }) {
  return [
    ':20:COV',
    `:25:${MAIN_IBAN}`,
    `:28C:${page === null ? num : `${num}/${page}`}`,
    `${page === null || page === 1 ? ':60F:' : ':60M:'}C${openDate}CHF${chf(open)}`,
    ...body,
    `${last ? ':62F:' : ':62M:'}C${closeDate}CHF${chf(close)}`,
    '-',
  ].join('\n');
}
const line61 = (value, entry, mark, minor, ref = null) => `:61:${value}${entry ?? ''}${mark}${chf(minor)}NMSCNONREF${ref === null ? '' : `//${ref}`}`;

function lines(t) {
  return t.store.db
    .prepare(
      `SELECT t.id, t.amount_minor AS a, t.booking_date AS b, s.statement_id AS sid, s.coverage AS cov, p.reason AS why, p.existing_bank_txn_id AS dupOf
         FROM bank_txn t JOIN bank_statement s ON s.workspace_id = t.workspace_id AND s.id = t.statement_id
         LEFT JOIN bank_txn_possible_duplicate p ON p.workspace_id = t.workspace_id AND p.bank_txn_id = t.id
        WHERE t.workspace_id = ? ORDER BY t.rowid`,
    )
    .all(t.workspaceId);
}
const importText = (t, content, extra = {}) => must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content, idempotencyKey: key(), ...extra }), 'import');
const csvMapping = { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' };

test('hole 1: a same-day twin coffee in two CHAINED statements is a second coffee, and so is page 2 of an extending statement in its own file', () => {
  const t = world();
  importText(t, sta({ num: 41, openDate: '261004', open: 100000, closeDate: '261005', close: 99550, body: [line61('261005', '1005', 'D', 450), ':86:Kaffeebar Seeblick'] }));
  // Statement 42 the same day opens where 41 closed and carries the next number: it extends the chain.
  importText(t, sta({ num: 42, openDate: '261005', open: 99550, closeDate: '261005', close: 99100, body: [line61('261005', '1005', 'D', 450), ':86:Kaffeebar Seeblick'] }));
  // Statement 43, paged, its page 2 delivered in a second file.
  importText(t, sta({ num: 43, page: 1, last: false, openDate: '261005', open: 99100, closeDate: '261006', close: 98650, body: [line61('261006', '1006', 'D', 450), ':86:Kaffeebar Seeblick'] }));
  importText(t, sta({ num: 43, page: 2, openDate: '261006', open: 98650, closeDate: '261006', close: 98200, body: [line61('261006', '1006', 'D', 450), ':86:Kaffeebar Seeblick'] }));
  const all = lines(t);
  assert.equal(all.length, 4, 'four coffees');
  assert.ok(all.every((l) => l.why === null), `nothing flagged: ${JSON.stringify(all)}`);
  assert.deepEqual([...new Set(all.slice(1).map((l) => l.cov))], ['extends']);
});

test('hole 2: the same days delivered again through another channel (other numbering, other texts) are matched one to one and flagged same_movement, never new', () => {
  const t = world();
  importText(t, sta({ num: 41, openDate: '261004', open: 100000, closeDate: '261005', close: 99550, body: [line61('261005', '1005', 'D', 450), ':86:Kaffeebar Seeblick Karte 1234'] }));
  importText(t, sta({ num: 42, openDate: '261005', open: 99550, closeDate: '261006', close: 87550, body: [line61('261006', '1006', 'D', 12000), ':86:Druckerei Lindenhof Rechnung 2026-118'] }));
  // The e-banking export of both days: numbered 1, other texts, the same movements.
  const res = importText(
    t,
    sta({ num: 1, openDate: '261004', open: 100000, closeDate: '261006', close: 87550, body: [
      line61('261005', '1005', 'D', 450), ':86:KAFFEEBAR SEEBLICK WINTERTHUR',
      line61('261006', '1006', 'D', 12000), ':86:LINDENHOF DRUCKEREI AG',
    ] }),
  );
  const all = lines(t);
  const exported = all.filter((l) => l.sid === 'mt940:1:2026-10-06');
  assert.deepEqual(exported.map((l) => l.why), ['same_movement', 'same_movement']);
  assert.deepEqual(exported.map((l) => all.find((o) => o.id === l.dupOf)?.a), [450, 12000], 'each names its own stored line');
  assert.ok(res.statements[0].warnings.includes('overlap_same_movement'));
  // A CSV re-export of the same days, with the Valuta column mapped this time: matched again, never new.
  const csv = importText(t, 'Datum;Valuta;Text;Betrag\n05.10.2026;05.10.2026;Kaffeebar;-4.50\n06.10.2026;06.10.2026;Druckerei;-120.00\n', {
    mapping: { ...csvMapping, columns: { ...csvMapping.columns, valueDate: 'Valuta' } },
  });
  assert.ok(csv.statements[0].nearDuplicates.every((d) => d.reason === 'same_movement' || d.reason === 'same_date'));
  assert.equal(lines(t).filter((l) => l.why === null).length, 2, 'the two movements stay two in the books');
});

test('hole 3: a card line carries its purchase day as value date and no entry date: in an extending statement it is new, never flagged by that value date', () => {
  const t = world();
  importText(t, sta({ num: 41, openDate: '261004', open: 100000, closeDate: '261005', close: 99550, body: [line61('261005', '1005', 'D', 450), ':86:Kaffeebar'] }));
  const res = importText(t, sta({ num: 42, openDate: '261005', open: 99550, closeDate: '261006', close: 98320, body: [line61('261002', null, 'D', 1230), ':86:Karte Buchhandlung, Kauf 02.10.'] }));
  assert.deepEqual(res.statements[0].warnings, []);
  assert.ok(lines(t).every((l) => l.why === null));
});

test('hole 4: a late gap-filler (Oct 5 after Oct 1 and Oct 10) imports new, never flagged wholesale', () => {
  const t = world();
  const day = (id, seq, d, open, entries) => camt({ statementId: id, seqNb: seq, from: d, to: d, openingMinor: open, entries });
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: day('G-01', '1', '2026-10-01', 0, [{ ref: 'G1', amountMinor: 10000, cd: 'CRDT', date: '2026-10-01' }]), idempotencyKey: key() }));
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: day('G-10', '3', '2026-10-10', 15000, [{ ref: 'G3', amountMinor: 5000, cd: 'DBIT', date: '2026-10-10' }]), idempotencyKey: key() }));
  const late = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: day('G-05', '2', '2026-10-05', 10000, [{ ref: 'G2', amountMinor: 5000, cd: 'CRDT', date: '2026-10-05' }]), idempotencyKey: key() }));
  assert.equal(late.txnCount, 1);
  assert.ok(!late.warnings.includes('covered_period_new_line') && !late.warnings.includes('overlap_same_movement'), JSON.stringify(late.warnings));
  assert.ok(lines(t).every((l) => l.why === null));
});

test('hole 5: a midday CSV, then the day-end camt: the morning coffee is matched, the afternoon lunch is a new line, never flagged', () => {
  const t = world();
  importText(t, 'Datum;Text;Betrag\n04.10.2026;Miete;-1500.00\n05.10.2026;Kaffeebar;-4.50\n', { mapping: csvMapping });
  const dayEnd = must(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'MID-05', seqNb: '1', from: '2026-10-05', to: '2026-10-05', openingMinor: 0, entries: [
        { ref: 'M1', amountMinor: 450, cd: 'DBIT', date: '2026-10-05' },
        { ref: 'M2', amountMinor: 2350, cd: 'DBIT', date: '2026-10-05' },
      ] }),
      idempotencyKey: key(),
    }),
  );
  const all = lines(t);
  const coffee = all.find((l) => l.sid === 'MID-05' && l.a === 450);
  const lunch = all.find((l) => l.sid === 'MID-05' && l.a === 2350);
  assert.equal(coffee.why, 'same_movement');
  assert.equal(lunch.why, null, 'the afternoon is new on an edge day');
  assert.ok(!dayEnd.warnings.includes('covered_period_new_line'));
});

test('hole 6: a net-zero day delivered again (opening = closing) never extends by balance alone: its lines are matched and flagged', () => {
  const t = world();
  const netZero = (id, seq) => camt({ statementId: id, seqNb: seq, from: '2026-10-05', to: '2026-10-05', openingMinor: 50000, entries: [
    { ref: `${id}-IN`, amountMinor: 10000, cd: 'CRDT', date: '2026-10-05' },
    { ref: `${id}-OUT`, amountMinor: 10000, cd: 'DBIT', date: '2026-10-05' },
  ] });
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: netZero('NZ', '1'), idempotencyKey: key() }));
  // The same day again under another statement id, the same sequence: opening 500 = the stored closing 500.
  const again = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: netZero('NZ-AGAIN', '1'), idempotencyKey: key() }));
  assert.equal(again.txnCount, 2, 'imported, never dropped');
  assert.deepEqual(lines(t).filter((l) => l.sid === 'NZ-AGAIN').map((l) => l.why), ['same_movement', 'same_movement']);
  // The MT940 shape: Datalink 41 net zero, then an e-banking export of the same day numbered 1.
  const u = world();
  const body = [line61('261005', '1005', 'C', 10000), ':86:Kundin', line61('261005', '1005', 'D', 10000), ':86:Lieferant'];
  importText(u, sta({ num: 41, openDate: '261004', open: 50000, closeDate: '261005', close: 50000, body }));
  importText(u, sta({ num: 1, openDate: '261004', open: 50000, closeDate: '261005', close: 50000, body }));
  assert.deepEqual(lines(u).filter((l) => l.sid === 'mt940:1:2026-10-05').map((l) => l.why), ['same_movement', 'same_movement']);
});

test('coverage: a line on a fully covered day that matches nothing is flagged covered_period_new_line; outside the span nothing is', () => {
  const t = world();
  importText(t, sta({ num: 41, openDate: '261004', open: 100000, closeDate: '261005', close: 99550, body: [line61('261005', '1005', 'D', 450), ':86:Kaffeebar'] }));
  // An unchained export of Oct 5 and Oct 6: Oct 5 is covered by 41 (with its balances), Oct 6 is not.
  const res = importText(t, sta({ num: 7, openDate: '261004', open: 70000, closeDate: '261006', close: 66700, body: [
    line61('261005', '1005', 'D', 450), ':86:Kaffeebar',
    line61('261005', '1005', 'D', 2850), ':86:Unbekannt',
    line61('261006', '1006', 'D', 450), ':86:Kaffeebar',
  ] }));
  const exported = lines(t).filter((l) => l.sid === 'mt940:7:2026-10-06');
  assert.deepEqual(exported.map((l) => [l.a, l.why, l.dupOf === null]), [[450, 'same_movement', false], [2850, 'covered_period_new_line', true], [450, null, true]]);
  assert.ok(res.statements[0].warnings.includes('covered_period_new_line'));
  const waiting = must(listBankInbox(t.ctx, { bankTxnId: exported[1].id, status: 'all' })).lines[0];
  assert.equal(waiting.needsDuplicateDecision, true);
  assert.deepEqual(waiting.possibleDuplicateOf, { bankTxnId: null, reason: 'covered_period_new_line' });
  assert.deepEqual(waiting.possibleDuplicates, []);
});

test('the chokepoint: every booking path refuses a flagged line readably, and the trigger refuses any active non-ignore decision behind them', () => {
  const t = world();
  const { vendorBillId } = postedBill(t, { grossMinor: 50000, seed: 'cov-chk' });
  importText(t, 'Datum;Text;Betrag\n05.10.2026;Druckerei;-500.00\n05.10.2026;Druckerei;-500.00\n', { mapping: csvMapping });
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'CHK', from: '2026-10-05', to: '2026-10-05', entries: [{ ref: 'K1', amountMinor: 50000, cd: 'DBIT', date: '2026-10-05', name: 'Druckerei Lindenhof AG' }] }), idempotencyKey: key() }));
  const flagged = lines(t).find((l) => l.sid === 'CHK').id;
  const rule = must(setBankStandard(t.ctx, { bankTxnId: flagged, accountId: t.acc('6500'), taxCode: null, idempotencyKey: key() })).standard;
  const refusals = [
    bookBankLine(t.ctx, { bankTxnId: flagged, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 50000 }] }, idempotencyKey: key() }),
    bookBankLine(t.ctx, { bankTxnId: flagged, target: { kind: 'open_item', documentId: vendorBillId }, idempotencyKey: key() }),
    bookBankLine(t.ctx, { bankTxnId: flagged, target: { kind: 'payment_batch', batchId: 'pbat_none' }, idempotencyKey: key() }),
    bookBankLine(t.ctx, { bankTxnId: flagged, target: { kind: 'rule', standardId: rule.id, asks: {} }, idempotencyKey: key() }),
    createEntryForTxn(t.ctx, { bankTxnId: flagged, contraAccountId: t.acc('6500'), idempotencyKey: key() }),
    confirmCamtMatch(t.ctx, { bankTxnId: flagged, vendorBillId, idempotencyKey: key() }),
    confirmCamtMatch(t.ctx, { bankTxnId: flagged, allocations: [{ vendorBillId, amountMinor: 50000 }], idempotencyKey: key() }),
  ];
  for (const r of refusals) assert.equal(r.error, 'duplicate_decision_pending', JSON.stringify(r));
  // The second line: whatever path forgets, the table refuses an active decision other than an ignore.
  const db = t.store.db;
  const writeDecision = (state, targetKind) => {
    const link = `btlk_cov_${key()}`;
    db.prepare('INSERT INTO bank_txn_link (id, workspace_id, bank_txn_id, kind, target_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(link, t.workspaceId, flagged, 'entry', 'x', 'test', '2026-10-21T00:00:00Z');
    db.prepare(
      'INSERT INTO bank_line_decision (link_id, workspace_id, bank_txn_id, state, target_kind, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(link, t.workspaceId, flagged, state, targetKind, 'test', '2026-10-21T00:00:00Z');
  };
  for (const [state, kind] of [['booked', 'accounts'], ['booked', 'open_item'], ['booked', 'payment_batch'], ['matched', 'existing_entry']]) {
    assert.throws(() => db.transaction(() => writeDecision(state, kind))(), /duplicate_decision_pending/, `${state}/${kind}`);
  }
  // An ignore passes (the duplicate answer writes its ignore first).
  assert.doesNotThrow(() => db.transaction(() => writeDecision('ignored', 'ignore'))());
});

test('one delivery at once: resolve_possible_duplicate { statementId, one_to_one_matches, duplicate } answers each matched line, not the new ones', () => {
  const t = world();
  importText(t, sta({ num: 41, openDate: '261004', open: 100000, closeDate: '261005', close: 98750, body: [line61('261005', '1005', 'D', 450), ':86:Kaffee', line61('261005', '1005', 'D', 800), ':86:Parkhaus'] }));
  const res = importText(t, sta({ num: 1, openDate: '261004', open: 100000, closeDate: '261005', close: 96000, body: [line61('261005', '1005', 'D', 450), ':86:KAFFEE', line61('261005', '1005', 'D', 800), ':86:PARKHAUS', line61('261005', '1005', 'D', 2750), ':86:Neu'] }));
  const statementId = res.statements[0].statementId;
  const k = key();
  const bulk = must(resolvePossibleDuplicate(t.ctx, { statementId, scope: 'one_to_one_matches', decision: 'duplicate', idempotencyKey: k }), 'bulk');
  assert.equal(bulk.count, 2);
  const exported = lines(t).filter((l) => l.sid === 'mt940:1:2026-10-05');
  const state = (id) => must(listBankInbox(t.ctx, { bankTxnId: id, status: 'all' })).lines[0];
  assert.deepEqual(exported.map((l) => [l.a, state(l.id).state]), [[450, 'ignored'], [800, 'ignored'], [2750, 'open']]);
  assert.equal(state(exported[2].id).needsDuplicateDecision, true, 'the new line is decided one by one');
  const rows = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_duplicate_decision WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(rows(), 2, 'one answer row per line');
  must(resolvePossibleDuplicate(t.ctx, { statementId, scope: 'one_to_one_matches', decision: 'duplicate', idempotencyKey: k }), 'replay');
  assert.equal(rows(), 2, 'idempotent');
  assert.equal(resolvePossibleDuplicate(t.ctx, { statementId, scope: 'one_to_one_matches', decision: 'distinct', idempotencyKey: key() }).error, 'invalid_input');
  assert.equal(resolvePossibleDuplicate(t.ctx, { statementId, scope: 'everything', decision: 'duplicate', idempotencyKey: key() }).error, 'invalid_input');
  assert.equal(resolvePossibleDuplicate(t.ctx, { statementId: 'bstmt_nope', scope: 'one_to_one_matches', decision: 'duplicate', idempotencyKey: key() }).error, 'not_found');
});

test('the delivery-wide answer runs under the same dial: an agent drafts it, nothing is decided until a person approves', () => {
  const t = world();
  importText(t, sta({ num: 41, openDate: '261004', open: 100000, closeDate: '261005', close: 98750, body: [line61('261005', '1005', 'D', 450), ':86:Kaffee', line61('261005', '1005', 'D', 800), ':86:Parkhaus'] }));
  const res = importText(t, sta({ num: 1, openDate: '261004', open: 100000, closeDate: '261005', close: 98750, body: [line61('261005', '1005', 'D', 450), ':86:KAFFEE', line61('261005', '1005', 'D', 800), ':86:PARKHAUS'] }));
  const deps = (actor) => ({ store: t.store, clock: t.clock, ids: t.ids, actor });
  const rows = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_duplicate_decision WHERE workspace_id = ?').get(t.workspaceId).n;
  const drafted = must(
    runGoverned(deps('agent'), getAction('resolve_possible_duplicate'), { workspaceId: t.workspaceId, statementId: res.statements[0].statementId, scope: 'one_to_one_matches', decision: 'duplicate', idempotencyKey: key() }),
    'draft',
  );
  assert.ok(typeof drafted.actionId === 'string', JSON.stringify(drafted));
  assert.equal(rows(), 0, 'a draft decides nothing');
  must(getAction('approve_drafted_action').run(deps('studio'), { workspaceId: t.workspaceId, actionId: drafted.actionId }), 'approve');
  assert.equal(rows(), 2, 'the approval answers both one-to-one matches');
});

test('generation 18 opens a generation-17 book: the triggers and the movement index arrive, a statement without dates gets its period, history is matched not flagged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2-gen18-'));
  const file = join(dir, 'book.db');
  try {
    assert.ok(SCHEMA_GENERATION >= 18, 'this build writes generation 18 or later');
    assert.ok(DATA_MIGRATIONS.some((m) => m.generation === 18 && m.name.startsWith('d178-possible-duplicates')));
    const t = world({ location: file });
    must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'OLD', from: '2026-10-05', to: '2026-10-05', entries: [{ ref: 'O1', amountMinor: 450, cd: 'DBIT', date: '2026-10-05' }] }), idempotencyKey: 'old' }));
    const workspaceId = t.workspaceId;
    const bankAccountId = t.bankAccountId;
    t.store.close();
    // Back to what an older build left: none of the generation-18 triggers, no movement index, no period.
    const raw = new Database(file);
    for (const trig of ['bank_line_decision_duplicate_pending', 'bank_txn_duplicate_decision_no_update', 'bank_txn_duplicate_decision_no_delete']) raw.exec(`DROP TRIGGER ${trig}`);
    raw.exec('DROP INDEX bank_txn_movement');
    raw.exec('ALTER TABLE bank_statement DROP COLUMN coverage');
    raw.exec("UPDATE bank_statement SET from_date = NULL, to_date = NULL");
    raw.pragma('user_version = 17');
    raw.close();

    const store = new SqliteStore({ location: file });
    const db = store.db;
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    for (const trig of ['bank_line_decision_duplicate_pending', 'bank_txn_duplicate_decision_no_update', 'bank_txn_duplicate_decision_no_delete']) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trig), trig);
    }
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'bank_txn_movement'").get());
    assert.deepEqual(db.prepare("SELECT from_date, to_date FROM bank_statement WHERE workspace_id = ?").get(workspaceId), { from_date: '2026-10-05', to_date: '2026-10-05' });
    // The stored history now covers its day, and its line answers its movement key: a re-import of that day
    // under another statement id is matched one to one, never covered_period_new_line.
    const ctx = { store, workspaceId };
    const answer = coverageOf(ctx, bankAccountId, { statementId: 'AGAIN', electronicSeqNb: '9', pageNumber: 1, openingMinor: null, openingBalanceMinor: null, balanceCurrency: 'CHF', fromDate: '2026-10-05', toDate: '2026-10-05', entries: [] }, 'none', { from: '2026-10-05', to: '2026-10-05' });
    assert.equal(answer.coverage, 'checked');
    assert.ok(answer.span.full.has('2026-10-05'), 'the upgraded history covers its day');
    const byKey = storedMovements(ctx, bankAccountId, ['2026-10-05|DBIT|450|CHF'], { from: '2026-10-05', to: '2026-10-05' });
    assert.equal(byKey.get('2026-10-05|DBIT|450|CHF')?.length, 1, 'the stored line has its movement key');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
