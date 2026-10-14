// A39 MONEY-PATH INVARIANTS: append-only, idempotent on ROWS, §H-TENANT, and one active link per line.
//
// FOR THE NON-AUTHOR CRITIC (CLAUDE.md: the invariant tests are the one place self-review is not
// trusted). Every assertion below is on ROWS or on a raw database handle, never on a return value, and
// the "MUTATION" tests at the bottom commit each forbidden act directly in SQL, underneath the engine,
// and prove the SAME detector goes red, so none of the green assertions above them is vacuous. The
// detectors live in bank-inbox-invariants.mjs (one definition, two callers) and the ledger-level ones
// are the gate's own (test/api/invariants.mjs).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBankAccount,
  bookBankLine,
  ignoreBankLine,
  reopenBankLine,
  listBankInbox,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
} from '../../dist/core/banking/index.js';
import { frozenPmtInfId, frozenEndToEndId } from './frozen-refs-support.mjs';
import { postEntry } from '../../dist/core/ledger/index.js';
import { makeContext } from '../../dist/core/context.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { ok as okResult, err as errResult } from '../../dist/core/result.js';
import { postedRows, appendOnlyViolations, reversalViolations, tenantSnapshot, tenantViolations } from '../api/invariants.mjs';
import { legClaimViolations, linkRows, linkViolations, multiActiveViolations } from './bank-inbox-invariants.mjs';
import {
  assertClaimInvariantHolds,
  excuseClaimInvariant,
  world,
  importLines,
  postedBill,
  rowCounts,
  must,
  refused,
  issueInvoice,
  secondWorkspace,
  MAIN_IBAN,
  SAVINGS_IBAN,
} from './bank-inbox-support.mjs';

// Critic A39R2-4: the claim invariant is asserted after EVERY scenario of this suite.
afterEach(assertClaimInvariantHolds);

const GROSS = 108100;

/** A world with one line of every decision kind already taken, so every invariant has rows to guard. */
function busyWorld() {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'busy' });
  const e = must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'Hand', idempotencyKey: 'busy-e', lines: [{ account: t.acc('6500'), debit: 900 }, { account: t.acc('1020'), credit: 900 }] }));
  const { lines } = importLines(t, {
    statementId: 'BUSY',
    entries: [
      { ref: 'ACC', amountMinor: 700, cd: 'DBIT' },
      { ref: 'PAY', amountMinor: GROSS, cd: 'CRDT' },
      { ref: 'MAT', amountMinor: 900, cd: 'DBIT' },
      { ref: 'IGN', amountMinor: 55000, cd: 'CRDT' },
      { ref: 'RE', amountMinor: 400, cd: 'DBIT' },
    ],
  });
  must(bookBankLine(t.ctx, { bankTxnId: lines.ACC, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 700, taxCode: 'VST-M' }] }, idempotencyKey: 'acc' }));
  must(bookBankLine(t.ctx, { bankTxnId: lines.PAY, target: { kind: 'open_item', documentId: inv.id }, idempotencyKey: 'pay' }));
  must(bookBankLine(t.ctx, { bankTxnId: lines.MAT, target: { kind: 'existing_entry', entryId: e.entryId }, idempotencyKey: 'mat' }));
  must(ignoreBankLine(t.ctx, { bankTxnId: lines.IGN, reason: 'clearing_account', idempotencyKey: 'ign' }));
  must(bookBankLine(t.ctx, { bankTxnId: lines.RE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 400 }] }, idempotencyKey: 're-1' }));
  must(reopenBankLine(t.ctx, { bankTxnId: lines.RE, reason: 'falsch', idempotencyKey: 're-open' }));
  must(bookBankLine(t.ctx, { bankTxnId: lines.RE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 400 }] }, idempotencyKey: 're-2' }));
  return { t, inv, e, lines };
}

// ================================================================================================
// INVARIANT 1, APPEND-ONLY: posted entries are never edited; links are superseded, never deleted
// ================================================================================================

test('[INVARIANT append-only] reopening and rebooking edits no posted row and deletes no link', () => {
  const { t, lines } = busyWorld();
  const posted = postedRows(t.store);
  const links = linkRows(t.store, t.workspaceId);
  // Undo everything that can be undone, then decide again.
  for (const ref of ['ACC', 'PAY', 'MAT', 'RE', 'IGN']) must(reopenBankLine(t.ctx, { bankTxnId: lines[ref], reason: `undo ${ref}`, idempotencyKey: `u-${ref}` }));
  must(bookBankLine(t.ctx, { bankTxnId: lines.ACC, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 700 }] }, idempotencyKey: 'acc-again' }));
  assert.deepEqual(appendOnlyViolations(posted, postedRows(t.store)), [], 'a posted entry was edited or deleted');
  assert.deepEqual(reversalViolations(t.store), [], 'every reversal exactly negates what it reverses');
  assert.deepEqual(linkViolations(links, linkRows(t.store, t.workspaceId)), [], 'a link was deleted or rewritten');
  assert.deepEqual(multiActiveViolations(t.store, t.workspaceId), []);
});

test('[INVARIANT append-only] a raw database handle cannot delete or rewrite a link or a decision', () => {
  const { t, lines } = busyWorld();
  const db = t.store.db;
  const link = db.prepare('SELECT id FROM bank_txn_link WHERE bank_txn_id = ? ORDER BY rowid LIMIT 1').get(lines.RE).id;
  const active = db.prepare("SELECT l.id FROM bank_txn_link l JOIN bank_line_decision d ON d.link_id = l.id WHERE l.bank_txn_id = ? AND d.superseded_at IS NULL").get(lines.ACC).id;
  assert.throws(() => db.prepare('DELETE FROM bank_txn_link WHERE id = ?').run(link), /never deleted/);
  assert.throws(() => db.prepare('UPDATE bank_txn_link SET target_id = ? WHERE id = ?').run('x', link), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM bank_line_decision WHERE link_id = ?').run(link), /never deleted/);
  assert.throws(() => db.prepare("UPDATE bank_line_decision SET state = 'matched' WHERE link_id = ?").run(active), /only the supersession stamp/);
  assert.throws(() => db.prepare('UPDATE bank_line_decision SET superseded_at = ? WHERE link_id = ?').run('2099-01-01', link), /only once/, 'a stamp cannot be rewritten');
  assert.throws(() => db.prepare('UPDATE bank_line_decision SET superseded_at = NULL WHERE link_id = ?').run(link), /only the supersession stamp/, 'a stamp cannot be taken back');
});

// ================================================================================================
// INVARIANT 2, ONE ACTIVE LINK PER LINE, at the storage layer (legacy links included)
// ================================================================================================

test('[INVARIANT one-active] a second live link on a line is refused by the database itself', () => {
  const { t, lines } = busyWorld();
  const db = t.store.db;
  const insert = (id, txn) =>
    db.prepare("INSERT INTO bank_txn_link (id, workspace_id, bank_txn_id, kind, target_id, created_by, created_at) VALUES (?, ?, ?, 'journal_entry', 'x', 'raw', '2026-07-20')").run(id, t.workspaceId, txn);
  assert.throws(() => insert('raw-1', lines.ACC), /already has an active link/);
  // Pre-A39 links are adopted ONCE by data migration generation 8 (spec L1), proven in
  // bank-inbox-migration.test.mjs; nothing adopts at store open or before a write any more.
  assert.deepEqual(multiActiveViolations(t.store, t.workspaceId), []);
});

// ================================================================================================
// INVARIANT 2b, AN ENTRY LEG BACKS AT MOST ONE ACTIVE LINE (critic A39-1/A39-2), at the storage layer
// ================================================================================================

/** busyWorld plus the two shapes the critic broke: an own-account transfer and a run paid by hand. */
function claimWorld() {
  const { t, lines, e } = busyWorld();
  const sav = must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1000'), idempotencyKey: 'cw-sav' })).bankAccountId;
  const main = importLines(t, { statementId: 'CW-MAIN', seqNb: '2', entries: [{ ref: 'OUT', amountMinor: 50000, cd: 'DBIT', iban: SAVINGS_IBAN, date: '2026-07-25' }] });
  const savings = importLines(t, { statementId: 'CW-SAV', iban: SAVINGS_IBAN, entries: [{ ref: 'IN', amountMinor: 50000, cd: 'CRDT', iban: MAIN_IBAN, date: '2026-07-25' }] }, { bankAccountId: sav });
  const out = must(listBankInbox(t.ctx, { status: 'open' })).lines.find((l) => l.bankTxnId === main.lines.OUT).proposal;
  must(bookBankLine(t.ctx, { bankTxnId: main.lines.OUT, target: out.target, idempotencyKey: 'cw-out' }));
  const inn = must(listBankInbox(t.ctx, { status: 'open' })).lines.find((l) => l.bankTxnId === savings.lines.IN).proposal;
  must(bookBankLine(t.ctx, { bankTxnId: savings.lines.IN, target: inn.target, idempotencyKey: 'cw-in' }));
  return { t, lines, e, sav, out: main.lines.OUT, inn: savings.lines.IN };
}

test('[INVARIANT one-leg-one-line] every decision claims its bank legs, and no leg backs two active lines', () => {
  const { t, lines, e, inn } = claimWorld();
  assert.deepEqual(legClaimViolations(t.store, t.workspaceId), []);
  // The ENGINE refuses a second line on a leg a live line holds, naming the holder, and moves nothing:
  // a twin of the matched line (same account, same amount) aimed at the entry the MAT line already backs.
  const { lines: twin } = importLines(t, { statementId: 'CW-TWIN', entries: [{ ref: 'TWIN', amountMinor: 900, cd: 'DBIT' }] });
  const beforeTwin = rowCounts(t.store, t.workspaceId);
  const twinTry = bookBankLine(t.ctx, { bankTxnId: twin.TWIN, target: { kind: 'existing_entry', entryId: e.entryId }, idempotencyKey: 'cw-twin' });
  assert.equal(twinTry.error, 'entry_already_linked', JSON.stringify(twinTry));
  assert.equal(twinTry.bankTxnId, lines.MAT, 'the refusal names the line that holds the leg');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), beforeTwin, 'the refused second claim moved the database');
  assert.deepEqual(legClaimViolations(t.store, t.workspaceId), []);
  // Undo and redo every kind: the invariant holds at every step, released claims included.
  for (const ref of ['ACC', 'PAY', 'MAT']) {
    must(reopenBankLine(t.ctx, { bankTxnId: lines[ref], reason: `undo ${ref}`, idempotencyKey: `leg-u-${ref}` }));
    assert.deepEqual(legClaimViolations(t.store, t.workspaceId), [], `after reopening ${ref}`);
  }
  must(reopenBankLine(t.ctx, { bankTxnId: inn, reason: 'undo transfer side', idempotencyKey: 'leg-u-in' }));
  assert.deepEqual(legClaimViolations(t.store, t.workspaceId), []);
  // The database itself refuses a second live claim on a leg, underneath the engine.
  const claim = t.store.db.prepare('SELECT * FROM bank_line_claim WHERE workspace_id = ? AND released_at IS NULL LIMIT 1').get(t.workspaceId);
  const other = t.store.db.prepare("SELECT l.id, l.bank_txn_id FROM bank_txn_link l JOIN bank_line_decision d ON d.link_id = l.id WHERE l.workspace_id = ? AND d.superseded_at IS NULL AND l.id <> ? LIMIT 1").get(t.workspaceId, claim.link_id);
  assert.throws(
    () =>
      t.store.db
        .prepare('INSERT INTO bank_line_claim (link_id, workspace_id, bank_txn_id, journal_line_id, entry_id, amount_minor) VALUES (?, ?, ?, ?, ?, ?)')
        .run(other.id, t.workspaceId, other.bank_txn_id, claim.journal_line_id, claim.entry_id, claim.amount_minor),
    /UNIQUE constraint failed/,
  );
  assert.throws(() => t.store.db.prepare('DELETE FROM bank_line_claim WHERE link_id = ?').run(claim.link_id), /never deleted/);
  assert.throws(() => t.store.db.prepare("UPDATE bank_line_claim SET journal_line_id = 'x' WHERE link_id = ?").run(claim.link_id), /only the release stamp/);
});

// ================================================================================================
// INVARIANT 3, IDEMPOTENT ON ROWS: the same key twice moves nothing; a second decision moves nothing
// ================================================================================================

test('[INVARIANT idempotent-on-rows] every A39 write, called twice with its key, moves the database once', () => {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'idem' });
  const bills = [postedBill(t, { grossMinor: 60000, seed: 'idem-a', vendorName: 'A AG' }), postedBill(t, { grossMinor: 40000, seed: 'idem-b', vendorName: 'B AG' })];
  for (const [i, b] of bills.entries()) must(setCreditorBankProfile(t.ctx, { vendorId: b.vendorId, iban: SAVINGS_IBAN, idempotencyKey: `cbp-${i}` }));
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId: t.bankAccountId, itemIds: bills.map((b) => b.vendorBillId), executionDate: '2026-07-22', idempotencyKey: 'batch' }));
  must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: 'gen' }));
  const e = must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'Hand', idempotencyKey: 'idem-e', lines: [{ account: t.acc('6500'), debit: 900 }, { account: t.acc('1020'), credit: 900 }] }));
  const { lines } = importLines(t, {
    statementId: 'IDEM',
    entries: [
      { ref: 'ACC', amountMinor: 1081, cd: 'DBIT' },
      { ref: 'PAY', amountMinor: GROSS, cd: 'CRDT' },
      { ref: 'RUN', amountMinor: 100000, cd: 'DBIT', pmtInfId: frozenPmtInfId(t, batch.batchId) },
      { ref: 'MAT', amountMinor: 900, cd: 'DBIT' },
      { ref: 'IGN', amountMinor: 300, cd: 'DBIT' },
    ],
  });
  const calls = [
    ['book accounts', () => bookBankLine(t.ctx, { bankTxnId: lines.ACC, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 1081, taxCode: 'VST-M' }] }, idempotencyKey: 'k-acc' })],
    ['book open_item', () => bookBankLine(t.ctx, { bankTxnId: lines.PAY, target: { kind: 'open_item', documentId: inv.id }, idempotencyKey: 'k-pay' })],
    ['book payment_batch', () => bookBankLine(t.ctx, { bankTxnId: lines.RUN, target: { kind: 'payment_batch', batchId: batch.batchId }, idempotencyKey: 'k-run' })],
    ['book existing_entry', () => bookBankLine(t.ctx, { bankTxnId: lines.MAT, target: { kind: 'existing_entry', entryId: e.entryId }, idempotencyKey: 'k-mat' })],
    ['ignore', () => ignoreBankLine(t.ctx, { bankTxnId: lines.IGN, reason: 'duplicate', idempotencyKey: 'k-ign' })],
    ['reopen an ignored line', () => reopenBankLine(t.ctx, { bankTxnId: lines.IGN, reason: 'zurück', idempotencyKey: 'k-unign' })],
    ['reopen a settlement', () => reopenBankLine(t.ctx, { bankTxnId: lines.PAY, reason: 'Test', idempotencyKey: 'k-re' })],
  ];
  for (const [label, call] of calls) {
    const first = call();
    assert.equal(first.ok, true, `${label}: ${JSON.stringify(first)}`);
    const between = rowCounts(t.store, t.workspaceId);
    const second = call();
    assert.deepEqual(second, first, `${label}: the replay answers the stored result`);
    assert.deepEqual(rowCounts(t.store, t.workspaceId), between, `${label}: the replay moved the database`);
  }
});

test('[INVARIANT idempotent-on-rows] a second connection confirming the same line at once moves nothing (spec §7.2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a39-two-conn-'));
  try {
    const location = join(dir, 'till.db');
    const t = world({ location });
    const { lines } = importLines(t, { statementId: 'TWO', entries: [{ ref: 'F', amountMinor: 500, cd: 'DBIT' }] });
    const other = new SqliteStore({ location, busyTimeoutMs: 20 });
    const otherCtx = makeContext(other, { workspaceId: t.workspaceId, actor: 'second-window', clock: t.clock, ids: t.ids });
    const target = (n) => ({ kind: 'accounts', legs: [{ accountId: t.acc(n), amountMinor: 500 }] });
    let raced;
    // Connection A holds its write transaction open while connection B confirms the same line.
    t.store.tx(() => {
      must(bookBankLine(t.ctx, { bankTxnId: lines.F, target: target('6500'), idempotencyKey: 'win-a' }));
      try {
        raced = bookBankLine(otherCtx, { bankTxnId: lines.F, target: target('6800'), idempotencyKey: 'win-b' });
      } catch (e) {
        raced = { ok: false, error: 'threw', detail: String(e) };
      }
    });
    assert.equal(raced.ok, false, `the second connection did not book: ${JSON.stringify(raced)}`);
    // Once A committed, B's retry reads the decided line and refuses on the row guard.
    refused(bookBankLine(otherCtx, { bankTxnId: lines.F, target: target('6800'), idempotencyKey: 'win-b' }), 'line_not_open');
    const live = t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_line_decision WHERE bank_txn_id = ? AND superseded_at IS NULL').get(lines.F).n;
    assert.equal(live, 1, 'one live decision');
    assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'camt'").get(t.workspaceId).n, 1, 'one entry');
    other.db.close();
    t.store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[INVARIANT idempotent-on-rows] a DIFFERENT key on a decided line refuses and moves nothing (the row guard, not the memo)', () => {
  const { t, lines, inv } = busyWorld();
  const before = rowCounts(t.store, t.workspaceId);
  const tries = [
    bookBankLine(t.ctx, { bankTxnId: lines.ACC, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 700 }] }, idempotencyKey: 'fresh-1' }),
    bookBankLine(t.ctx, { bankTxnId: lines.PAY, target: { kind: 'open_item', documentId: inv.id }, idempotencyKey: 'fresh-2' }),
    bookBankLine(t.ctx, { bankTxnId: lines.IGN, target: { kind: 'accounts', legs: [{ accountId: t.acc('3000'), amountMinor: 55000 }] }, idempotencyKey: 'fresh-3' }),
    ignoreBankLine(t.ctx, { bankTxnId: lines.MAT, reason: 'other', idempotencyKey: 'fresh-4' }),
  ];
  for (const r of tries) assert.equal(r.error, 'line_not_open', JSON.stringify(r));
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before);
});

// ================================================================================================
// INVARIANT 4, §H-TENANT: another workspace can neither see nor move these lines
// ================================================================================================

test('[INVARIANT tenant] a second workspace aimed at the first one\'s ids is refused and moves nothing', () => {
  const { t, lines, e } = busyWorld();
  const b = secondWorkspace(t);
  const before = tenantSnapshot(t.store, t.workspaceId);
  const attempts = {
    book: bookBankLine(b.ctx, { bankTxnId: lines.MAT, target: { kind: 'accounts', legs: [{ accountId: b.acc('6500'), amountMinor: 900 }] }, idempotencyKey: 'x1' }),
    ignore: ignoreBankLine(b.ctx, { bankTxnId: lines.MAT, reason: 'other', idempotencyKey: 'x2' }),
    reopen: reopenBankLine(b.ctx, { bankTxnId: lines.ACC, reason: 'x', idempotencyKey: 'x4' }),
    reopenIgnored: reopenBankLine(b.ctx, { bankTxnId: lines.IGN, reason: 'x', idempotencyKey: 'x5' }),
    inboxOfAccount: listBankInbox(b.ctx, { bankAccountId: t.bankAccountId }),
  };
  for (const [what, r] of Object.entries(attempts)) assert.equal(r.error, 'not_found', `${what}: ${JSON.stringify(r)}`);
  assert.equal(must(listBankInbox(b.ctx, { status: 'all' })).total, 0, 'the other tenant sees none of these lines');
  // Its own line cannot claim this tenant's entry either.
  const bBank = must(createBankAccount(b.ctx, { name: 'Fremdkonto', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: b.acc('1020'), idempotencyKey: 'b-bank' })).bankAccountId;
  const { lines: theirs } = importLines(t, { statementId: 'B-1', entries: [{ ref: 'X', amountMinor: 900, cd: 'DBIT' }] }, { ctx: b.ctx, bankAccountId: bBank, key: 'b-imp' });
  refused(bookBankLine(b.ctx, { bankTxnId: theirs.X, target: { kind: 'existing_entry', entryId: e.entryId }, idempotencyKey: 'x7' }), 'not_found');
  assert.deepEqual(tenantViolations(before, tenantSnapshot(t.store, t.workspaceId), 'A39 verbs'), []);
});

test('[INVARIANT tenant] learned suggestions never cross workspaces (critic M7: the history index is a read that could leak)', () => {
  const t = world();
  const booked = importLines(t, { statementId: 'H-A', entries: [{ ref: 'TEL', amountMinor: 8990, cd: 'DBIT', name: 'Swisscom (Schweiz) AG' }] });
  must(bookBankLine(t.ctx, { bankTxnId: booked.lines.TEL, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 8990, taxCode: 'VST-M' }] }, idempotencyKey: 'a' }));
  // Positive control: in the SAME workspace the next Swisscom line is proposed from history, so the
  // assertion below is not vacuous.
  const again = importLines(t, { statementId: 'H-A2', seqNb: '2', entries: [{ ref: 'TEL2', amountMinor: 9120, cd: 'DBIT', name: 'Swisscom (Schweiz) AG' }] });
  const own = must(listBankInbox(t.ctx, { status: 'open' })).lines.find((l) => l.bankTxnId === again.lines.TEL2).proposal;
  assert.equal(own.reasonCode, 'history');
  assert.equal(own.target.legs[0].accountId, t.acc('6500'));
  // Another workspace with the same counterparty learns nothing from the first one's bookings.
  const b = secondWorkspace(t);
  const bBank = must(createBankAccount(b.ctx, { name: 'Konto B', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: b.acc('1020'), idempotencyKey: 'b-bank' })).bankAccountId;
  const theirs = importLines(t, { statementId: 'H-B', entries: [{ ref: 'TEL', amountMinor: 8990, cd: 'DBIT', name: 'Swisscom (Schweiz) AG' }] }, { ctx: b.ctx, bankAccountId: bBank, key: 'b-imp' });
  const foreign = must(listBankInbox(b.ctx, { status: 'open' })).lines.find((l) => l.bankTxnId === theirs.lines.TEL).proposal;
  assert.notEqual(foreign.reasonCode, 'history', `a learned suggestion crossed workspaces: ${JSON.stringify(foreign)}`);
  assert.equal(foreign.certainty, 'open');
});

// ================================================================================================
// A24: booking a line is `post`; settling an open item or a run additionally needs `pay`
// ================================================================================================

test('A24: a role with post but not pay books a line to accounts, and cannot settle an open item', () => {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'cap' });
  const { lines } = importLines(t, { statementId: 'CAP', entries: [{ ref: 'F', amountMinor: 500, cd: 'DBIT' }, { ref: 'P', amountMinor: GROSS, cd: 'CRDT' }] });
  const treuhand = makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'treuhand',
    clock: t.clock,
    ids: t.ids,
    capabilities: { assert: (c) => (c === 'pay' ? errResult('permission_denied', { capability: c }) : okResult()) },
  });
  must(bookBankLine(treuhand, { bankTxnId: lines.F, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 500 }] }, idempotencyKey: 'f' }));
  refused(bookBankLine(treuhand, { bankTxnId: lines.P, target: { kind: 'open_item', documentId: inv.id }, idempotencyKey: 'p' }), 'permission_denied');
  must(bookBankLine(t.ctx, { bankTxnId: lines.P, target: { kind: 'open_item', documentId: inv.id }, idempotencyKey: 'p2' }));
  refused(reopenBankLine(treuhand, { bankTxnId: lines.P, reason: 'x', idempotencyKey: 'r' }), 'permission_denied', 'reversing a payment needs pay');
  must(reopenBankLine(treuhand, { bankTxnId: lines.F, reason: 'x', idempotencyKey: 'r2' }), 'reversing an entry needs post only');
});

// ================================================================================================
// MUTATION PROOFS: each forbidden act committed in SQL, and the SAME detector going red
// ================================================================================================

test('MUTATION: without the no-delete trigger a link can vanish, and linkViolations catches it', () => {
  const { t, lines } = busyWorld();
  const links = linkRows(t.store, t.workspaceId);
  assert.deepEqual(linkViolations(links, linkRows(t.store, t.workspaceId)), [], 'clean before the mutation');
  t.store.db.exec('DROP TRIGGER bank_txn_link_no_delete');
  t.store.db.exec('DROP TRIGGER bank_line_decision_no_delete');
  t.store.db.exec('DROP TRIGGER bank_line_claim_no_delete');
  const victim = t.store.db.prepare('SELECT id FROM bank_txn_link WHERE bank_txn_id = ? ORDER BY rowid LIMIT 1').get(lines.RE).id;
  t.store.db.prepare('DELETE FROM bank_line_claim WHERE link_id = ?').run(victim);
  t.store.db.prepare('DELETE FROM bank_line_decision WHERE link_id = ?').run(victim);
  t.store.db.prepare('DELETE FROM bank_txn_link WHERE id = ?').run(victim);
  const found = linkViolations(links, linkRows(t.store, t.workspaceId));
  assert.equal(found.length, 1);
  assert.match(found[0], /DELETED link/);
  excuseClaimInvariant(); // the rows were broken on purpose
});

test('MUTATION: without the supersede-only trigger a decision can be rewritten, and linkViolations catches it', () => {
  const { t, lines } = busyWorld();
  const links = linkRows(t.store, t.workspaceId);
  t.store.db.exec('DROP TRIGGER bank_line_decision_supersede_only');
  const active = t.store.db.prepare("SELECT l.id FROM bank_txn_link l JOIN bank_line_decision d ON d.link_id = l.id WHERE l.bank_txn_id = ? AND d.superseded_at IS NULL").get(lines.MAT).id;
  t.store.db.prepare("UPDATE bank_line_decision SET state = 'booked' WHERE link_id = ?").run(active);
  const superseded = t.store.db.prepare("SELECT l.id FROM bank_txn_link l JOIN bank_line_decision d ON d.link_id = l.id WHERE l.bank_txn_id = ? AND d.superseded_at IS NOT NULL").get(lines.RE).id;
  t.store.db.prepare("UPDATE bank_line_decision SET superseded_at = '2099-01-01' WHERE link_id = ?").run(superseded);
  const found = linkViolations(links, linkRows(t.store, t.workspaceId));
  assert.ok(found.some((v) => /MUTATED link/.test(v)), JSON.stringify(found));
  assert.ok(found.some((v) => /RE-STAMPED link/.test(v)), JSON.stringify(found));
  excuseClaimInvariant(); // the rows were broken on purpose
});

test('MUTATION: without the one-active trigger AND the partial index, a line gets two live links, and multiActiveViolations catches it', () => {
  const { t, lines } = busyWorld();
  const insertLink = () =>
    t.store.db.prepare("INSERT INTO bank_txn_link (id, workspace_id, bank_txn_id, kind, target_id, created_by, created_at) VALUES ('mut-2', ?, ?, 'journal_entry', 'x', 'raw', '2026-07-20')").run(t.workspaceId, lines.ACC);
  const insertDecision = () =>
    t.store.db.prepare("INSERT INTO bank_line_decision (link_id, workspace_id, bank_txn_id, state, target_kind, created_at) VALUES ('mut-2', ?, ?, 'booked', 'accounts', '2026-07-20')").run(t.workspaceId, lines.ACC);
  t.store.db.exec('DROP TRIGGER bank_txn_link_one_active');
  insertLink();
  // With the trigger gone the partial unique index is still the second line of defence.
  assert.throws(insertDecision, /UNIQUE constraint failed/);
  t.store.db.exec('DROP INDEX bank_line_decision_one_active');
  insertDecision();
  const found = multiActiveViolations(t.store, t.workspaceId);
  assert.equal(found.length, 1);
  assert.match(found[0], /2 active links/);
  excuseClaimInvariant(); // the rows were broken on purpose
});

test('MUTATION: the memo alone is not what keeps a replay from booking twice; losing BOTH guards is caught on rows', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'MEMO', entries: [{ ref: 'F', amountMinor: 500, cd: 'DBIT' }] });
  const call = () => bookBankLine(t.ctx, { bankTxnId: lines.F, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 500 }] }, idempotencyKey: 'k' });
  must(call());
  const once = rowCounts(t.store, t.workspaceId);
  // Mutation 1: lose the memo. The LINE-STATE guard still refuses: rows do not move.
  t.store.db.prepare("DELETE FROM idempotency WHERE workspace_id = ? AND verb = 'book_bank_line'").run(t.workspaceId);
  assert.equal(call().error, 'line_not_open');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), once, 'without the memo the row guard still held');
  // Mutation 2: ALSO lose the link (stamp it superseded underneath the engine). Now a replay books
  // again, and the row-count detector every idempotency assertion above uses goes red, so those
  // assertions measure the real thing.
  t.store.db.prepare("UPDATE bank_line_decision SET superseded_at = '2026-07-21', superseded_by = 'raw', supersede_reason = 'mutation' WHERE bank_txn_id = ? AND superseded_at IS NULL").run(lines.F);
  t.store.db.prepare("DELETE FROM idempotency WHERE workspace_id = ? AND verb = 'book_bank_line'").run(t.workspaceId);
  must(call());
  const twice = rowCounts(t.store, t.workspaceId);
  assert.equal(twice.entries, once.entries + 1, 'with both guards gone the ledger moved twice: the detector sees it');
  excuseClaimInvariant(); // the rows were broken on purpose
});

test('MUTATION: a write reaching across tenants is caught by the tenant detector the A39 test uses', () => {
  const { t, lines } = busyWorld();
  const before = tenantSnapshot(t.store, t.workspaceId);
  // The act no A39 verb performs, done in SQL: a second tenant's call rewriting this tenant's decision.
  t.store.db.exec('DROP TRIGGER bank_line_decision_supersede_only');
  t.store.db.prepare("UPDATE bank_line_decision SET note = 'fremd' WHERE bank_txn_id = ?").run(lines.IGN);
  assert.equal(tenantViolations(before, tenantSnapshot(t.store, t.workspaceId), 'mutation').length, 1);
  excuseClaimInvariant(); // the rows were broken on purpose
});

test('MUTATION: without the partial unique claim index a leg can back two lines, and legClaimViolations catches it', () => {
  const { t, out, inn } = claimWorld();
  assert.deepEqual(legClaimViolations(t.store, t.workspaceId), [], 'clean before the mutation');
  t.store.db.exec('DROP INDEX bank_line_claim_one_active');
  // The critic's A39-1 in one row: the savings line claims the MAIN account's leg of the transfer too.
  const mainLeg = t.store.db.prepare('SELECT * FROM bank_line_claim WHERE bank_txn_id = ? AND released_at IS NULL').get(out);
  const savLink = t.store.db.prepare('SELECT link_id FROM bank_line_claim WHERE bank_txn_id = ? AND released_at IS NULL').get(inn).link_id;
  t.store.db
    .prepare('INSERT INTO bank_line_claim (link_id, workspace_id, bank_txn_id, journal_line_id, entry_id, amount_minor) VALUES (?, ?, ?, ?, ?, ?)')
    .run(savLink, t.workspaceId, inn, mainLeg.journal_line_id, mainLeg.entry_id, mainLeg.amount_minor);
  const found = legClaimViolations(t.store, t.workspaceId);
  assert.ok(found.some((v) => /backs 2 active lines/.test(v)), JSON.stringify(found));
  assert.ok(found.some((v) => /not on its line's Bankkonto ledger account/.test(v)), JSON.stringify(found));
  excuseClaimInvariant(); // the rows were broken on purpose
});

test('MUTATION: a booked decision that claims nothing, or a claim outliving its decision, is caught', () => {
  const { t, lines } = busyWorld();
  t.store.db.exec('DROP TRIGGER bank_line_claim_no_delete');
  t.store.db.prepare('DELETE FROM bank_line_claim WHERE bank_txn_id = ?').run(lines.ACC);
  t.store.db.exec('DROP TRIGGER bank_line_claim_release');
  const pay = t.store.db.prepare("SELECT link_id FROM bank_line_decision WHERE bank_txn_id = ? AND superseded_at IS NULL").get(lines.PAY).link_id;
  t.store.db.prepare("UPDATE bank_line_decision SET superseded_at = '2026-07-30', superseded_by = 'raw', supersede_reason = 'mutation' WHERE link_id = ?").run(pay);
  const found = legClaimViolations(t.store, t.workspaceId);
  assert.ok(found.some((v) => /claims no leg/.test(v)), JSON.stringify(found));
  assert.ok(found.some((v) => /outlived its superseded decision/.test(v)), JSON.stringify(found));
  excuseClaimInvariant(); // the rows were broken on purpose
});
