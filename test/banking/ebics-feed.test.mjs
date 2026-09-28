// A36 §4.4, THE SUCCESSOR RULE (spec §8 row 1): which camt.053 an EBICS-fed Bankkonto takes, whichever
// door it came through. Rules 0 to 5 as a pure function, then through `importCamt` on a real EBICS-fed
// account (a channel activated by the real ceremony against an in-process bank), then the A36L-1 walk:
// a gap, a hand import, then a press the bank answers 090005 imports the waiting statements in order.
//
// Every fixture is SYNTHETIC by construction (`ebics-support.mjs`): invented IBANs over the unused
// clearing number 09999, invented amounts and ids. Money-path invariant tests are reviewed by a
// non-author (CLAUDE.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup } from './support.mjs';
import { syntheticIban, camt053, chain, container, mockBank, bankCode } from './ebics-support.mjs';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';
import { parseCamt } from '../../dist/core/banking/camt.js';
import { connectBankChannel, syncBankChannel, getBankChannelStatus, decideSuccessor } from '../../dist/core/banking/ebics/index.js';
import { makeContext } from '../../dist/core/context.js';

const HOST = { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHHST', partnerId: 'PARTNER77', userId: 'USER0077' };

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

function ctxWith(t, bank) {
  return makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'user_1',
    clock: t.clock,
    ids: t.ids,
    ...(bank !== undefined ? { ebicsTransport: bank.port } : {}),
  });
}

let seq = 0;
function account(t, n) {
  seq += 1;
  return must(
    createBankAccount(t.ctx, { name: `Konto ${n}`, iban: syntheticIban(n), ledgerAccountId: t.acc('1020'), idempotencyKey: `ba-${n}-${seq}` }),
    'create_bank_account',
  ).bankAccountId;
}

/** Run the real ceremony against the in-process bank: connect, fetch the bank keys, confirm the reviewed set. */
function activate(t, bank, bankAccountIds) {
  const ctx = ctxWith(t, bank);
  seq += 1;
  const c = must(connectBankChannel(ctx, { host: HOST, routeBankAccountIds: bankAccountIds, confirm: true, idempotencyKey: `conn-${seq}` }), 'connect');
  assert.equal(c.state, 'pending_bank_activation');
  const fetched = must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true }), 'fetch bank keys');
  const active = must(
    connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }),
    'confirm bank keys',
  );
  assert.equal(active.state, 'active');
  return c.connectionId;
}

function imp(t, bankAccountId, xml, key) {
  seq += 1;
  return importCamt(t.ctx, { bankAccountId, xml, idempotencyKey: key ?? `imp-${seq}` });
}

function statementRows(t, bankAccountId) {
  return t.store.db
    .prepare('SELECT electronic_seq_nb AS nb, from_date AS d, opening_balance_minor AS o, closing_balance_minor AS c FROM bank_statement WHERE workspace_id = ? AND bank_account_id = ? ORDER BY from_date, CAST(electronic_seq_nb AS INTEGER)')
    .all(t.workspaceId, bankAccountId);
}

function count(t, sql, ...params) {
  return t.store.db.prepare(sql).get(...params).n;
}

/** A fed account with the given chained statements already in the books (imported through the rule). */
function fedAccount(t, n, days, { firstSeq = 1, firstDate = '2026-10-01', opening = 100000 } = {}) {
  const id = account(t, n);
  const bank = mockBank();
  activate(t, bank, [id]);
  const statements = chain({ iban: syntheticIban(n), firstSeq, firstDate, opening, days });
  return { id, bank, statements, iban: syntheticIban(n) };
}

// --- the pure rule ---------------------------------------------------------------------------------

function facts(xml) {
  const p = parseCamt(xml);
  assert.equal(p.ok, true, JSON.stringify(p));
  return p.statement;
}

function bookRow(xml, id) {
  const s = facts(xml);
  return {
    id,
    message_type: s.messageType,
    electronic_seq_nb: s.electronicSeqNb,
    page_number: s.pageNumber,
    last_page_ind: s.lastPage ? 1 : 0,
    from_date: s.fromDate,
    to_date: s.toDate,
    opening_balance_minor: s.openingBalanceMinor,
    closing_balance_minor: s.closingBalanceMinor,
    balance_currency: s.balanceCurrency,
    txn_count: s.entries.length,
  };
}

test('pure rule: every rule 0 to 5 answers as §4.4 says, with numbers compared as integers', () => {
  const iban = syntheticIban(1);
  const days = chain({ iban, firstSeq: 8, firstDate: '2026-10-08', opening: 5000, days: [[{ minor: 100 }], [{ minor: -50 }], [{ minor: 25 }]] });
  const [s8, s9, s10] = days;
  const book = [bookRow(s8.xml, 'r8'), bookRow(s10.xml, 'r10')];
  // Rule 3: 9 fills the hole between 8 and 10 ("9" sorts after "10" as text; as integers it is between).
  assert.deepEqual(
    (({ verdict, rule }) => ({ verdict, rule }))(decideSuccessor(facts(s9.xml), book)),
    { verdict: 'import', rule: 'hole_filler' },
  );
  // Rule 1: the same position with the same balances is already there, whatever the ids say.
  const copy = camt053({ iban, seq: 10, date: s10.date, opening: s10.opening, entries: [{ minor: 25 }], msgId: 'OTHERMSG', stmtId: 'OTHERSTMT', copy: true });
  const r1 = decideSuccessor(facts(copy), book);
  assert.equal(r1.verdict, 'already_imported');
  assert.equal(r1.statementRowId, 'r10');
  // Rule 5: the same position with other balances is an overlap, FINAL.
  const other = camt053({ iban, seq: 10, date: s10.date, opening: s10.opening, entries: [{ minor: 999 }] });
  const r5 = decideSuccessor(facts(other), book);
  assert.deepEqual([r5.verdict, r5.code, r5.final], ['refused', 'overlap_refused', true]);
  // Rule 2: the successor of 10.
  const s11 = camt053({ iban, seq: 11, date: '2026-10-11', opening: s10.closing, entries: [] });
  assert.equal(decideSuccessor(facts(s11), book).rule, 'successor');
  // Rule 4: above the newest but not chained.
  const g = decideSuccessor(facts(camt053({ iban, seq: 11, date: '2026-10-11', opening: s10.closing + 1 })), book);
  assert.deepEqual([g.code, g.final, g.details.differenceMinor, g.details.against.number], ['gap_refused', false, 1, 10]);
  // Rule 5, older than the first: pending and quiet.
  const b = decideSuccessor(facts(camt053({ iban, seq: 3, date: '2026-10-03', opening: 1 })), book);
  assert.deepEqual([b.code, b.final], ['before_feed_start', false]);
  // Rule 0: no number, no CLBD, a split page.
  assert.equal(decideSuccessor(facts(camt053({ iban, seq: null, date: '2026-10-11', opening: s10.closing })), book).code, 'not_day_end_statement');
  assert.equal(decideSuccessor(facts(camt053({ iban, seq: 11, date: '2026-10-11', opening: s10.closing, noClosing: true })), book).code, 'not_day_end_statement');
  const split = camt053({ iban, seq: 11, date: '2026-10-11', opening: s10.closing, page: { number: 1, last: false } });
  assert.equal(decideSuccessor(facts(split), book).code, 'unsupported_multipage_statement');
  // An empty book is the feed start.
  assert.equal(decideSuccessor(facts(s9.xml), []).rule, 'feed_start');
});

test('parser: GrpHdr/MsgPgntn is read (ZKB puts the page there), and an INTM balance marks a split page', () => {
  const iban = syntheticIban(2);
  const page2 = facts(camt053({ iban, seq: 4, date: '2026-10-04', opening: 100, page: { number: 2, last: true } }));
  assert.deepEqual([page2.pageNumber, page2.lastPage, page2.splitPage], [2, true, true]);
  const page1 = facts(camt053({ iban, seq: 4, date: '2026-10-04', opening: 100, page: { number: 1, last: false } }));
  assert.deepEqual([page1.pageNumber, page1.lastPage, page1.splitPage, page1.closingBalanceMinor], [1, false, true, null]);
  const single = facts(camt053({ iban, seq: 4, date: '2026-10-04', opening: 100, page: { number: 1, last: true } }));
  assert.deepEqual([single.pageNumber, single.lastPage, single.splitPage], [1, true, false]);
  // Stmt/StmtPgntn still wins where a bank fills it (the page number stays part of A20's identity).
  const stmtPaged = facts(camt053({ iban, seq: 4, date: '2026-10-04', opening: 100, stmtPage: { number: 3, last: true } }));
  assert.deepEqual([stmtPaged.pageNumber, stmtPaged.splitPage], [3, true]);
});

// --- through importCamt on an EBICS-fed account --------------------------------------------------

test('feed start, successor, copy under another Stmt/Id, overlap: each answer, and only rules 2 and 3 write', () => {
  const t = setup();
  const { id, statements, iban } = fedAccount(t, 10, [[{ minor: 1000 }], [{ minor: -300 }]]);
  const [d1, d2] = statements;
  const a = must(imp(t, id, d1.xml), 'feed start');
  assert.equal(a.feed.rule, 'feed_start');
  const b = must(imp(t, id, d2.xml), 'successor');
  assert.equal(b.feed.rule, 'successor');
  assert.deepEqual(b.feed.position, { year: 2026, number: 2 });

  // A re-created copy (DUPL, new message id, same number, same balances): a quiet no-op.
  const before = { s: count(t, 'SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ?', t.workspaceId), l: count(t, 'SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?', t.workspaceId) };
  const copy = camt053({ iban, seq: 2, date: d2.date, opening: d2.opening, entries: [{ minor: -300 }], msgId: 'RECREATED', stmtId: 'RECREATED-S', copy: true });
  const c = must(imp(t, id, copy), 'copy');
  assert.equal(c.duplicate, true);
  assert.equal(c.feed.rule, 'already_imported');
  assert.equal(c.statementId, b.statementId);
  // The overlap: statement 2 with other balances. Refused, nothing written.
  const overlap = imp(t, id, camt053({ iban, seq: 2, date: d2.date, opening: d2.opening, entries: [{ minor: -301 }] }));
  assert.equal(overlap.ok, false);
  assert.equal(overlap.error, 'overlap_refused');
  assert.equal(overlap.against.number, 2);
  const after = { s: count(t, 'SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ?', t.workspaceId), l: count(t, 'SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?', t.workspaceId) };
  assert.deepEqual(after, before, 'a copy and an overlap write no row');
});

test('a number jump whose balances chain imports with statement_number_jump naming the skipped numbers', () => {
  const t = setup();
  const { id, iban } = fedAccount(t, 11, []);
  must(imp(t, id, camt053({ iban, seq: 3, date: '2026-10-03', opening: 5000, entries: [{ minor: 10 }] })), 'first');
  const jumped = must(imp(t, id, camt053({ iban, seq: 6, date: '2026-10-06', opening: 5010, entries: [{ minor: 5 }] })), 'jump');
  assert.ok(jumped.warnings.includes('statement_number_jump'));
  assert.deepEqual(jumped.feed.jump.skipped, [{ year: 2026, from: 4, to: 5 }]);
  assert.equal(jumped.feed.jump.after.number, 3);
});

test('a later statement that does not open on the newest closing balance is a gap: named, nothing written', () => {
  const t = setup();
  const { id, statements } = fedAccount(t, 12, [[{ minor: 100 }], [{ minor: 200 }], [{ minor: 300 }], [{ minor: 400 }], [{ minor: 500 }]]);
  const [s1, , , , s5] = statements;
  must(imp(t, id, s1.xml), 's1');
  const gap = imp(t, id, s5.xml);
  assert.equal(gap.ok, false);
  assert.equal(gap.error, 'gap_refused');
  assert.equal(gap.against.number, 1);
  assert.equal(gap.differenceMinor, 200 + 300 + 400, 'the difference is what the missing days moved');
  assert.equal(statementRows(t, id).length, 1);
});

test('consecutive holes between two statements fill in order, the last one closing on its neighbour', () => {
  const t = setup();
  const { id, statements, iban } = fedAccount(t, 13, [[{ minor: 100 }], [{ minor: 200 }], [{ minor: 300 }], [{ minor: 400 }]]);
  const [s1, s2, s3, s4] = statements;
  must(imp(t, id, s1.xml), 's1');
  // Statement 4 arrives with a number jump whose balance chains to 1 only if 2 and 3 were empty: build
  // the book the way it happens, a bridged 4 imported by hand BEFORE activation is impossible here, so
  // a 4 that chains to 1 (a day without bookings in between would chain) proves the order logic on 2, 3.
  const s4chained = camt053({ iban, seq: 4, date: s4.date, opening: s1.closing, entries: [{ minor: 1 }] });
  const j = must(imp(t, id, s4chained), 'jump to 4');
  assert.deepEqual(j.feed.jump.skipped, [{ year: 2026, from: 2, to: 3 }]);
  // A 3 first cannot fill (its lower neighbour 1 does not close on its opening): gap, nothing written.
  const early3 = imp(t, id, camt053({ iban, seq: 3, date: s3.date, opening: s1.closing + 200, entries: [{ minor: -200 }] }));
  assert.equal(early3.error, 'gap_refused');
  // 2 opens on 1's CLBD; 4 is not adjacent to 2, so only the lower side binds: imported.
  const h2 = must(imp(t, id, camt053({ iban, seq: 2, date: s2.date, opening: s1.closing, entries: [{ minor: 200 }] })), 'hole 2');
  assert.equal(h2.feed.rule, 'hole_filler');
  // 3 opens on 2's CLBD and must close on 4's OPBD (adjacent): a wrong close is a gap, the right one fills.
  const wrong3 = imp(t, id, camt053({ iban, seq: 3, date: s3.date, opening: s1.closing + 200, entries: [{ minor: 7 }] }));
  assert.equal(wrong3.error, 'gap_refused');
  assert.equal(wrong3.reason, 'does_not_close_on_next');
  const h3 = must(imp(t, id, camt053({ iban, seq: 3, date: s3.date, opening: s1.closing + 200, entries: [{ minor: -200 }] })), 'hole 3');
  assert.equal(h3.feed.rule, 'hole_filler');
  assert.deepEqual(statementRows(t, id).map((r) => r.nb), ['1', '2', '3', '4']);
});

test('before_feed_start is pending and quiet; not_day_end_statement and a split page are refused on a fed account', () => {
  const t = setup();
  const { id, iban } = fedAccount(t, 14, []);
  must(imp(t, id, camt053({ iban, seq: 5, date: '2026-10-05', opening: 700, entries: [{ minor: 1 }] })), 'first');
  const early = imp(t, id, camt053({ iban, seq: 2, date: '2026-10-02', opening: 100 }));
  assert.equal(early.error, 'before_feed_start');
  const noNumber = imp(t, id, camt053({ iban, seq: null, date: '2026-10-06', opening: 701 }));
  assert.equal(noNumber.error, 'not_day_end_statement', 'A39 warning becomes a refusal on an EBICS-fed account');
  const page1 = imp(t, id, camt053({ iban, seq: 6, date: '2026-10-06', opening: 701, entries: [{ minor: 1 }, { minor: 2 }], page: { number: 1, last: false } }));
  assert.equal(page1.error, 'unsupported_multipage_statement');
  const page2 = imp(t, id, camt053({ iban, seq: 6, date: '2026-10-06', opening: 702, entries: [{ minor: 2 }], page: { number: 2, last: true } }));
  assert.equal(page2.error, 'unsupported_multipage_statement');
});

test('a year turn with ToDtTm at the next midnight: the year comes from FrDtTm and number 1 follows', () => {
  const t = setup();
  const { id, iban } = fedAccount(t, 15, []);
  const dec31 = camt053({ iban, seq: 250, date: '2026-12-31', opening: 900, entries: [{ minor: 100 }], toNextMidnight: true });
  const a = must(imp(t, id, dec31), '31.12');
  assert.deepEqual(a.feed.position, { year: 2026, number: 250 }, 'ToDtTm 2027-01-01T00:00 does not move it into 2027');
  const jan1 = must(imp(t, id, camt053({ iban, seq: 1, date: '2027-01-01', opening: 1000, entries: [{ minor: 5 }] })), '01.01');
  assert.equal(jan1.feed.rule, 'successor');
  assert.equal(jan1.feed.jump, undefined, 'number 1 after a year turn is the next statement, not a jump');
});

test('a refusal is never memoised: the same key imports once the book lets it', () => {
  const t = setup();
  const { id, statements } = fedAccount(t, 16, [[{ minor: 10 }], [{ minor: 20 }], [{ minor: 30 }]]);
  const [s1, s2, s3] = statements;
  must(imp(t, id, s1.xml), 's1');
  const idem = () => count(t, "SELECT COUNT(*) AS n FROM idempotency WHERE workspace_id = ? AND verb = 'import_camt'", t.workspaceId);
  const before = idem();
  const refused = imp(t, id, s3.xml, 'the-fixed-key');
  assert.equal(refused.error, 'gap_refused');
  assert.equal(idem(), before, 'a refusal leaves no idempotency row');
  must(imp(t, id, s2.xml), 's2');
  const again = must(imp(t, id, s3.xml, 'the-fixed-key'), 'the same key, now admitted');
  assert.equal(again.feed.rule, 'successor');
  assert.equal(idem(), before + 2);
});

test('an account that is not EBICS-fed keeps A20 and A39 behaviour: no rule, not_day_end_statement stays a warning', () => {
  const t = setup();
  const id = account(t, 17);
  const iban = syntheticIban(17);
  must(imp(t, id, camt053({ iban, seq: 9, date: '2026-10-09', opening: 1 })), 'any first');
  const gapButUnfed = must(imp(t, id, camt053({ iban, seq: 30, date: '2026-10-30', opening: 999 })), 'an unchained later statement');
  assert.equal(gapButUnfed.feed, undefined);
  const warned = must(imp(t, id, camt053({ iban, seq: null, date: '2026-10-31', opening: 5 })), 'unnumbered');
  assert.deepEqual(warned.warnings, ['not_day_end_statement']);
});

// --- the A36L-1 walk: the hand door and the EBICS door answer alike -------------------------------

test('A36L-1: a gap waits, the owner fills it by hand, a press answered 090005 imports the waiting statements in order', () => {
  const t = setup();
  const id = account(t, 20);
  const iban = syntheticIban(20);
  const days = chain({ iban, firstSeq: 1, firstDate: '2026-10-01', opening: 20000, days: [[{ minor: 1 }], [{ minor: 2 }], [{ minor: 3 }], [{ minor: 4 }], [{ minor: 5 }], [{ minor: 6 }]] });
  // The bridge: statements 1 to 3 imported by hand before the channel went live (no rule yet).
  for (const d of days.slice(0, 3)) must(imp(t, id, d.xml), `bridged ${d.seq}`);
  const bank = mockBank();
  const connectionId = activate(t, bank, [id]);
  const ctx = ctxWith(t, bank);

  // ZKB delivers 5 and 6 (4 was taken by an eBanking pickup): both wait, the receipt still goes out.
  bank.offer(container([days[4].xml, days[5].xml]));
  const first = syncBankChannel(ctx, { connectionId, idempotencyKey: 'press-1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.statements.map((s) => [s.position.number, s.outcome]), [[5, 'gap_refused'], [6, 'gap_refused']]);
  assert.equal(first.receipt, 'positive', 'the bytes are durable, so ZKB may forget them');
  // The status names each waiting statement and the one it does not chain to.
  const status = must(getBankChannelStatus(ctx, {}), 'status').channels[0];
  assert.deepEqual(status.pendingStatements.map((p) => [p.statement.number, p.code, p.details?.against?.number]), [[5, 'gap_refused', 3], [6, 'gap_refused', 3]]);

  // The same statement through the hand door answers exactly as the EBICS door did.
  assert.equal(imp(t, id, days[4].xml).error, 'gap_refused');
  // The owner imports 4 from eBanking by hand: the successor of 3.
  assert.equal(must(imp(t, id, days[3].xml), 'hand 4').feed.rule, 'successor');

  // The next press: ZKB has nothing new (090005), and the waiting 5 and 6 import from their bytes, in order.
  const second = syncBankChannel(ctx, { connectionId, idempotencyKey: 'press-2' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.download.outcome, 'no_data');
  assert.deepEqual(second.statements.map((s) => [s.position.number, s.outcome]), [[5, 'imported'], [6, 'imported']]);
  assert.deepEqual(statementRows(t, id).map((r) => r.nb), ['1', '2', '3', '4', '5', '6']);
  // A third press finds nothing to do: final outcomes are never processed again.
  const third = must(syncBankChannel(ctx, { connectionId, idempotencyKey: 'press-3' }), 'press 3');
  assert.deepEqual(third.statements, []);
  assert.equal(must(getBankChannelStatus(ctx, {}), 'status').channels[0].pendingStatements.length, 0);
  // Exactly one receipt, positive, for the one transaction.
  assert.deepEqual(bank.receipts.map((r) => r.receiptCode), [0]);
  void bankCode;
});
