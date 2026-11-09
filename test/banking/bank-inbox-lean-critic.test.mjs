// A39 lean, the code critic's findings (docs/critique/a39-lean-critic.md), each as a regression test
// that failed on 9afc2604 before its fix. The invariant suites stay in bank-inbox-invariants.test.mjs.
//
// SYNTHETIC DATA ONLY: every statement is spelled by hand in bank-inbox-support.mjs.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createBankAccount,
  listBankInbox,
  bookBankLine,
  reopenBankLine,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  markBatchPaid,
  confirmCamtMatch,
} from '../../dist/core/banking/index.js';
import { frozenPmtInfId, frozenEndToEndId } from './frozen-refs-support.mjs';
import { getAction } from '../../dist/api/registry.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { listPayments } from '../../dist/core/payments/index.js';
import { makeContext } from '../../dist/core/context.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { assertClaimInvariantHolds, world, importLines, postedBill, rowCounts, must, refused, issueInvoice, secondWorkspace, SAVINGS_IBAN, MAIN_IBAN } from './bank-inbox-support.mjs';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { retireSeededChecklistRules, runRows } from '../automation/support.mjs';
import { chainedOpening } from './e2-adapt.mjs';

afterEach(assertClaimInvariantHolds);

const lineOf = (inbox, id) => inbox.lines.find((l) => l.bankTxnId === id);

/** A generated A18 run of posted bills, one per amount, paid to the savings IBAN. */
function run(t, seed, amounts) {
  const bills = amounts.map((a, i) => postedBill(t, { grossMinor: a, seed: `${seed}-${i}`, vendorName: `Lieferant ${seed} ${i}` }));
  for (const [i, b] of bills.entries()) must(setCreditorBankProfile(t.ctx, { vendorId: b.vendorId, iban: SAVINGS_IBAN, idempotencyKey: `${seed}-cbp-${i}` }));
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId: t.bankAccountId, itemIds: bills.map((b) => b.vendorBillId), executionDate: '2026-07-22', idempotencyKey: `${seed}-batch` }));
  must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: `${seed}-gen` }));
  return { batchId: batch.batchId, bills };
}

/** The run's items in order, each with the entry of the payment A18 posted for it. */
function itemsOf(t, batchId) {
  return t.store.db
    .prepare(
      `SELECT i.id AS id, p.journal_entry_id AS entryId FROM payment_batch_item i
         LEFT JOIN payment p ON p.id = i.posted_payment_id WHERE i.batch_id = ? ORDER BY i.rowid`,
    )
    .all(batchId);
}

// --- H1: a run item is proven only by its OWN EndToEndId ----------------------------------------------

test('H1: two equal payments of a run marked paid by hand are each proposed `sure` on their OWN payment, and "Alle sicheren buchen" never books them crosswise', () => {
  const t = world();
  const r = run(t, 'h1', [25000, 25000]);
  must(markBatchPaid(t.ctx, { batchId: r.batchId, confirmation: true, valueDate: '2026-07-22', idempotencyKey: 'h1-paid' }));
  const items = itemsOf(t, r.batchId);
  assert.equal(items.length, 2);
  const pmt = frozenPmtInfId(t, r.batchId);
  // The bank lists item 1 FIRST: the nearest-dated tie would otherwise fall to item 0's payment.
  const { lines } = importLines(t, {
    statementId: 'H1',
    entries: [
      { ref: 'B', amountMinor: 25000, cd: 'DBIT', date: '2026-07-22', pmtInfId: pmt, e2e: frozenEndToEndId(t, items[1].id) },
      { ref: 'A', amountMinor: 25000, cd: 'DBIT', date: '2026-07-22', pmtInfId: pmt, e2e: frozenEndToEndId(t, items[0].id) },
    ],
  });
  const inbox = must(listBankInbox(t.ctx, { status: 'open' }));
  const own = { A: items[0].entryId, B: items[1].entryId };
  for (const ref of ['A', 'B']) {
    const p = lineOf(inbox, lines[ref]).proposal;
    assert.equal(p.certainty, 'sure', `${ref}: its own EndToEndId proves it`);
    assert.equal(p.target.kind, 'existing_entry');
    assert.equal(p.target.entryId, own[ref], `${ref}: proposed on its OWN item's payment, not a sibling's`);
  }
  // "Alle sicheren buchen": every sure line in inbox order, one book_bank_line each, from ONE read.
  for (const line of inbox.lines.filter((l) => l.proposal?.certainty === 'sure')) {
    must(bookBankLine(t.ctx, { bankTxnId: line.bankTxnId, target: line.proposal.target, idempotencyKey: `sure-${line.bankTxnId}` }));
  }
  const decided = must(listBankInbox(t.ctx, { status: 'matched' }));
  for (const ref of ['A', 'B']) assert.equal(lineOf(decided, lines[ref]).decision.entryId, own[ref], `${ref}: matched to its own payment`);
});

test('H1: a line with the run PmtInfId but NO EndToEndId is never `sure` on one of two equal payments of that run', () => {
  const t = world();
  const r = run(t, 'h1b', [25000, 25000]);
  must(markBatchPaid(t.ctx, { batchId: r.batchId, confirmation: true, valueDate: '2026-07-22', idempotencyKey: 'h1b-paid' }));
  const { lines } = importLines(t, {
    statementId: 'H1B',
    entries: [{ ref: 'X', amountMinor: 25000, cd: 'DBIT', date: '2026-07-22', pmtInfId: frozenPmtInfId(t, r.batchId) }],
  });
  const p = lineOf(must(listBankInbox(t.ctx, { status: 'open' })), lines.X).proposal;
  assert.notEqual(p.certainty, 'sure', 'the PmtInfId proves the run, not which of its equal payments');
});

test('H1: a run of ONE payment of the amount is still proven by the PmtInfId alone', () => {
  const t = world();
  const r = run(t, 'h1c', [25000, 13000]);
  must(markBatchPaid(t.ctx, { batchId: r.batchId, confirmation: true, valueDate: '2026-07-22', idempotencyKey: 'h1c-paid' }));
  const items = itemsOf(t, r.batchId);
  const { lines } = importLines(t, {
    statementId: 'H1C',
    entries: [{ ref: 'X', amountMinor: 25000, cd: 'DBIT', date: '2026-07-22', pmtInfId: frozenPmtInfId(t, r.batchId) }],
  });
  const p = lineOf(must(listBankInbox(t.ctx, { status: 'open' })), lines.X).proposal;
  assert.equal(p.certainty, 'sure');
  assert.equal(p.target.entryId, items[0].entryId);
});

// --- H3: the D139 fire-time guard on every door a stored rule fires through --------------------------

/** A workspace with a Bankkonto on 1020 and two stored rules: one posting onto 1020, one elsewhere. */
function firingWorkspace(seed, event) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Regel AG', `${seed}-ws`);
  retireSeededChecklistRules(deps, workspaceId);
  const c = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  must(c('create_bank_account', { name: 'Konto', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'b' }), 'bank');
  const post = (account) => ({ date: '2026-07-15', source: 'manual', description: 'automatisch', lines: [{ account: accId('6500'), debit: 100 }, { account: accId(account), credit: 100 }] });
  const rule = (name, account) =>
    must(c('create_automation_rule', { name, trigger: { event }, action: { tool: 'post_entry', inputTemplate: post(account) }, idempotencyKey: `r-${name}` }), name).rule.ruleId;
  const bankRule = rule('Bank belasten', '1020');
  const plainRule = rule('Umbuchen', '6800');
  const ledger = (number) =>
    deps.store.db
      .prepare(`SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ? AND l.account_id = ? AND e.status = 'posted'`)
      .get(workspaceId, accId(number)).n;
  return { deps, workspaceId, c, ledger, bankRule, plainRule };
}

test('H3: a SCHEDULE rule posting onto the Bankkonto ledger, fired by run_due_automations, is refused bank_ledger_leg and rolled back; the other schedule rule fires', () => {
  const w = firingWorkspace('h3-tick', 'schedule.daily');
  const ticked = must(w.c('run_due_automations', { asOf: '2026-07-15T09:00:00.000Z' }), 'tick');
  assert.equal(ticked.occurrences, 2);
  const runs = runRows(w.deps, w.workspaceId);
  assert.deepEqual(
    runs.map((r) => [r.rule_id === w.bankRule ? 'bank' : 'plain', r.status, r.error_code]).sort(),
    [['bank', 'failed', 'action_not_automatable'], ['plain', 'ok', null]],
  );
  assert.equal(w.ledger('1020'), 0, 'no money reached the bank ledger without a bank line');
  assert.equal(w.ledger('6800'), -100, 'the plain schedule posting fired');
});

test('H3: retry_automation_run re-sends a stuck bank-ledger firing through the same guard: refused bank_ledger_leg, 1020 stays 0', () => {
  const w = firingWorkspace('h3-retry', 'contact.created');
  must(w.c('create_contact', { partyRole: 'customer', name: 'Auslöser AG', idempotencyKey: 'k' }), 'contact');
  assert.equal(w.ledger('1020'), 0);
  const row = w.deps.store.db.prepare('SELECT id FROM automation_run WHERE workspace_id = ? AND rule_id = ?').get(w.workspaceId, w.bankRule);
  // The stuck state a process death between the claim and the settle leaves, the one retry accepts.
  w.deps.store.db.prepare("UPDATE automation_run SET status = 'running', error_code = NULL, finished_at = NULL WHERE id = ?").run(row.id);
  // The retry settles the run with the guard's refusal as its code (G01 records the target's code verbatim).
  const retried = must(w.c('retry_automation_run', { runId: row.id }), 'retry');
  assert.deepEqual([retried.status, retried.errorCode], ['failed', 'action_not_automatable']);
  assert.equal(w.ledger('1020'), 0, 'the retry posted onto the bank ledger');
  assert.equal(w.deps.store.db.prepare('SELECT status FROM automation_run WHERE id = ?').get(row.id).status, 'failed');
});

// --- M1: confirm_match { allocations[] } respects C8 ---------------------------------------------------

test('M1: confirm_match allocations refuse already_batched for a bill in a live run, naming the run, and move nothing', () => {
  const t = world();
  const r = run(t, 'm1', [60000, 40000]);
  const { lines } = importLines(t, { statementId: 'M1', entries: [{ ref: 'D', amountMinor: 60000, cd: 'DBIT' }] });
  const before = rowCounts(t.store, t.workspaceId);
  const res = refused(
    confirmCamtMatch(t.ctx, { bankTxnId: lines.D, allocations: [{ vendorBillId: r.bills[0].vendorBillId, amountMinor: 60000 }], idempotencyKey: 'm1' }),
    'already_batched',
  );
  assert.equal(res.batchId, r.batchId);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'the refused split moved the database');
  // Re-critic L6: the same bill named by `targetId` instead of `vendorBillId` refuses the same way.
  const byTarget = refused(
    confirmCamtMatch(t.ctx, { bankTxnId: lines.D, allocations: [{ targetId: r.bills[0].vendorBillId, amountMinor: 60000 }], idempotencyKey: 'm1-target' }),
    'already_batched',
  );
  assert.equal(byTarget.batchId, r.batchId);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'the refused split by targetId moved the database');
  // The run can still be booked from its own debit afterwards.
  // D178 point 19 (re-cut): the next statement opens where the last one closed, as a bank's do.
  const { lines: runLine } = importLines(t, { statementId: 'M1R', seqNb: '2', openingMinor: chainedOpening(t), entries: [{ ref: 'RUN', amountMinor: 100000, cd: 'DBIT', pmtInfId: frozenPmtInfId(t, r.batchId) }] });
  assert.equal(must(bookBankLine(t.ctx, { bankTxnId: runLine.RUN, target: { kind: 'payment_batch', batchId: r.batchId }, idempotencyKey: 'm1-run' })).state, 'booked');
});

// --- M2 (and L1): reopen decides what to reverse from the line AS ITS TRANSACTION MEETS IT --------------

test('M2: a reopen whose snapshot went stale (another window reopened and rebooked the line) refuses and moves nothing; the rebooking stands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a39-m2-'));
  try {
    const location = join(dir, 'till.db');
    const t = world({ location });
    const hand = must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'Hand 900', idempotencyKey: 'hand', lines: [{ account: t.acc('6500'), debit: 900 }, { account: t.acc('1020'), credit: 900 }] }));
    const { lines } = importLines(t, { statementId: 'M2', entries: [{ ref: 'X', amountMinor: 900, cd: 'DBIT' }] });
    must(bookBankLine(t.ctx, { bankTxnId: lines.X, target: { kind: 'existing_entry', entryId: hand.entryId }, idempotencyKey: 'match' }));
    const other = new SqliteStore({ location, busyTimeoutMs: 2000 });
    const otherCtx = makeContext(other, { workspaceId: t.workspaceId, actor: 'second-window', clock: t.clock, ids: t.ids });
    // Window B reads X (matched) before its transaction; window A reopens X and rebooks it to 6900 in the
    // gap, exactly where B would wait for the write lock.
    const remember = other.rememberIdempotent.bind(other);
    other.rememberIdempotent = (...args) => {
      other.rememberIdempotent = remember;
      must(reopenBankLine(t.ctx, { bankTxnId: lines.X, reason: 'falsch abgeglichen', idempotencyKey: 'a-reopen' }));
      must(bookBankLine(t.ctx, { bankTxnId: lines.X, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 900 }] }, idempotencyKey: 'a-rebook' }));
      before = rowCounts(t.store, t.workspaceId);
      return remember(...args);
    };
    let before;
    const late = reopenBankLine(otherCtx, { bankTxnId: lines.X, reason: 'aus dem zweiten Fenster', idempotencyKey: 'b-reopen' });
    assert.equal(late.ok, false, `the stale reopen answered ${JSON.stringify(late)}`);
    assert.equal(late.error, 'line_not_open');
    assert.equal(late.state, 'booked', 'the refusal names the line as it is now');
    const after = rowCounts(t.store, t.workspaceId);
    assert.equal(after.entries, before.entries, 'the stale reopen posted nothing');
    assert.equal(after.decisions, before.decisions, 'and superseded nothing');
    const now = must(listBankInbox(t.ctx, { status: 'all' })).lines.find((l) => l.bankTxnId === lines.X);
    assert.equal(now.state, 'booked', 'the rebooking of window A stands with its decision');
    other.db.close();
    t.store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L1 (lean critic): the losing one of two reopens of one booked line answers alreadyOpen, never already_reversed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a39-l1-'));
  try {
    const location = join(dir, 'till.db');
    const t = world({ location });
    const { lines } = importLines(t, { statementId: 'L1R', entries: [{ ref: 'X', amountMinor: 500, cd: 'DBIT' }] });
    must(bookBankLine(t.ctx, { bankTxnId: lines.X, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 500 }] }, idempotencyKey: 'book' }));
    const other = new SqliteStore({ location, busyTimeoutMs: 2000 });
    const otherCtx = makeContext(other, { workspaceId: t.workspaceId, actor: 'second-window', clock: t.clock, ids: t.ids });
    const remember = other.rememberIdempotent.bind(other);
    other.rememberIdempotent = (...args) => {
      other.rememberIdempotent = remember;
      must(reopenBankLine(t.ctx, { bankTxnId: lines.X, reason: 'erstes Fenster', idempotencyKey: 'a' }));
      before = rowCounts(t.store, t.workspaceId);
      return remember(...args);
    };
    let before;
    const late = must(reopenBankLine(otherCtx, { bankTxnId: lines.X, reason: 'zweites Fenster', idempotencyKey: 'b' }));
    assert.equal(late.alreadyOpen, true);
    assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'the second reopen moved nothing');
    other.db.close();
    t.store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- M3: a payment a bank line holds says so on its own read -----------------------------------------

test('M3: list_payments names the bank line that holds a payment (the Studio offers that line, never a raw Storno), and forgets it once the line is reopened', () => {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'm3' });
  const { lines } = importLines(t, { statementId: 'M3', entries: [{ ref: 'C', amountMinor: 108100, cd: 'CRDT' }] });
  const booked = must(bookBankLine(t.ctx, { bankTxnId: lines.C, target: { kind: 'open_item', documentId: inv.id }, idempotencyKey: 'm3' }));
  const held = must(listPayments(t.ctx, {})).payments.find((p) => p.id === booked.paymentId);
  assert.equal(held.bankLineId, lines.C);
  must(reopenBankLine(t.ctx, { bankTxnId: lines.C, reason: 'falsche Rechnung', idempotencyKey: 'm3-re' }));
  const after = must(listPayments(t.ctx, {})).payments.find((p) => p.id === booked.paymentId);
  assert.equal(after.status, 'reversed');
  assert.equal(after.bankLineId, null);
});

// --- M4: one line by its id, whatever page it sits on ---------------------------------------------------

test('M4: list_bank_inbox { bankTxnId, status: all } answers exactly that line, in any state, beyond the first page', () => {
  const t = world();
  const entries = Array.from({ length: 5 }, (_, i) => ({ ref: `L${i}`, amountMinor: 100 + i, cd: 'DBIT', date: `2026-07-${String(10 + i).padStart(2, '0')}` }));
  const { lines } = importLines(t, { statementId: 'M4', entries });
  must(bookBankLine(t.ctx, { bankTxnId: lines.L0, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 100 }] }, idempotencyKey: 'm4' }));
  // The oldest line is beyond a page of 2, and it is booked.
  assert.equal(must(listBankInbox(t.ctx, { status: 'all', limit: 2 })).lines.some((l) => l.bankTxnId === lines.L0), false);
  const one = must(listBankInbox(t.ctx, { status: 'all', bankTxnId: lines.L0 }));
  assert.deepEqual([one.total, one.lines.map((l) => [l.bankTxnId, l.state])], [1, [[lines.L0, 'booked']]]);
  assert.equal(must(listBankInbox(t.ctx, { status: 'all', bankTxnId: 'btxn_nope' })).total, 0);
});

// --- M5: a run line whose amount differs offers no target that can only refuse ---------------------------

test('M5: a run debit that differs from its total, or an item line that differs from its item, carries NO target (nothing to "Buchen" that always refuses)', () => {
  const t = world();
  const r = run(t, 'm5', [60000, 40000]);
  const items = itemsOf(t, r.batchId);
  const pmt = frozenPmtInfId(t, r.batchId);
  const { lines } = importLines(t, {
    statementId: 'M5',
    entries: [
      { ref: 'TOT', amountMinor: 60500, cd: 'DBIT', pmtInfId: pmt },
      { ref: 'ITM', amountMinor: 40100, cd: 'DBIT', e2e: frozenEndToEndId(t, items[1].id) },
    ],
  });
  const inbox = must(listBankInbox(t.ctx, { status: 'open' }));
  const tot = lineOf(inbox, lines.TOT).proposal;
  assert.deepEqual([tot.reasonCode, tot.certainty, tot.target], ['payment_batch_total_differs', 'check', null]);
  assert.equal(tot.reasonParams.batchId, r.batchId, 'the reason still names the run');
  const itm = lineOf(inbox, lines.ITM).proposal;
  assert.deepEqual([itm.reasonCode, itm.certainty, itm.target], ['payment_batch_item_amount_differs', 'check', null]);
});

// --- M6: an own-account transfer whose sides book in different months ----------------------------------

test('M6: side two of an own-account transfer booked by side one in ANOTHER month refuses transfer_crosses_period, naming both dates, and moves nothing; the same month matches', () => {
  const t = world();
  const sav = must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1000'), idempotencyKey: 'm6-sav' })).bankAccountId;
  const main = importLines(t, { statementId: 'M6-MAIN', entries: [{ ref: 'OUT', amountMinor: 200000, cd: 'DBIT', iban: SAVINGS_IBAN, date: '2026-07-31' }, { ref: 'OUT2', amountMinor: 30000, cd: 'DBIT', iban: SAVINGS_IBAN, date: '2026-07-28' }] });
  const savings = importLines(t, { statementId: 'M6-SAV', iban: SAVINGS_IBAN, entries: [{ ref: 'IN', amountMinor: 200000, cd: 'CRDT', iban: MAIN_IBAN, date: '2026-08-03' }, { ref: 'IN2', amountMinor: 30000, cd: 'CRDT', iban: MAIN_IBAN, date: '2026-07-29' }] }, { bankAccountId: sav });
  for (const ref of ['OUT', 'OUT2']) {
    const p = lineOf(must(listBankInbox(t.ctx, { status: 'open' })), main.lines[ref]).proposal;
    must(bookBankLine(t.ctx, { bankTxnId: main.lines[ref], target: p.target, idempotencyKey: `m6-${ref}` }));
  }
  const inbox = must(listBankInbox(t.ctx, { status: 'open' }));
  const p = lineOf(inbox, savings.lines.IN).proposal;
  // Re-critic L3: the proposal names side one's entry but offers nothing to book, since the match refuses.
  assert.deepEqual([p.reasonCode, p.certainty, p.target, p.reasonParams.crossesMonth], ['own_account_transfer_booked', 'check', null, true]);
  const before = rowCounts(t.store, t.workspaceId);
  const res = refused(bookBankLine(t.ctx, { bankTxnId: savings.lines.IN, target: { kind: 'existing_entry', entryId: p.reasonParams.entryId }, idempotencyKey: 'm6-in' }), 'transfer_crosses_period');
  assert.deepEqual([res.entryDate, res.lineDate, res.otherBankTxnId], ['2026-07-31', '2026-08-03', main.lines.OUT]);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'the refused match moved the database');
  // The same transfer inside one month matches as before.
  const p2 = lineOf(inbox, savings.lines.IN2).proposal;
  assert.equal(must(bookBankLine(t.ctx, { bankTxnId: savings.lines.IN2, target: p2.target, idempotencyKey: 'm6-in2' })).state, 'matched');
});

// --- L12: a supplier bill is `sure` only on a real reference -----------------------------------------------

test('L12: a supplier bill is sure only when its whole reference (6+ characters) stands in the line; a short or partial one is check', () => {
  const t = world();
  const bills = [
    postedBill(t, { grossMinor: 11100, seed: 'l12a', vendorName: 'Kurz AG', vendorReference: 'R12' }),
    postedBill(t, { grossMinor: 22200, seed: 'l12b', vendorName: 'Teil AG', vendorReference: 'RE-2026-04' }),
    postedBill(t, { grossMinor: 33300, seed: 'l12c', vendorName: 'Ganz AG', vendorReference: 'RE-2026-0412' }),
  ];
  const { lines } = importLines(t, {
    statementId: 'L12',
    entries: [
      { ref: 'SHORT', amountMinor: 11100, cd: 'DBIT', ustrd: 'Rechnung R12 Juli' },
      { ref: 'PART', amountMinor: 22200, cd: 'DBIT', ustrd: 'Rechnung RE-2026-0412' },
      { ref: 'WHOLE', amountMinor: 33300, cd: 'DBIT', ustrd: 'Rechnung RE-2026-0412' },
    ],
  });
  const inbox = must(listBankInbox(t.ctx, { status: 'open' }));
  const at = (ref) => lineOf(inbox, lines[ref]).proposal;
  assert.equal(at('WHOLE').target.documentId, bills[2].vendorBillId);
  assert.equal(at('WHOLE').certainty, 'sure');
  for (const ref of ['SHORT', 'PART']) assert.notEqual(at(ref).certainty, 'sure', `${ref}: a short or partial reference proves nothing`);
});

// --- L2: §H-TENANT on the proposal context's own-account read ---------------------------------------------

test('L2 [tenant]: another workspace\'s Bankkonto never makes a line here an own-account transfer', () => {
  const t = world();
  const b = secondWorkspace(t);
  must(createBankAccount(b.ctx, { name: 'Fremdes Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: b.acc('1000'), idempotencyKey: 'l2-b' }));
  const { lines } = importLines(t, { statementId: 'L2', entries: [{ ref: 'X', amountMinor: 50000, cd: 'DBIT', iban: SAVINGS_IBAN }] });
  const p = lineOf(must(listBankInbox(t.ctx, { status: 'open' })), lines.X).proposal;
  assert.notEqual(p.reasonCode, 'own_account_transfer', 'a foreign tenant\'s IBAN made this a transfer');
  assert.notEqual(p.target?.kind, 'accounts');
});

// --- L3: a released leg is claimed again -----------------------------------------------------------------

test('L3: reopen then re-match the SAME leg: a matched line, a paid run\'s line, and side two of a transfer', () => {
  const t = world();
  const hand = must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'Hand 900', idempotencyKey: 'l3-hand', lines: [{ account: t.acc('6500'), debit: 900 }, { account: t.acc('1020'), credit: 900 }] }));
  const r = run(t, 'l3', [60000, 40000]);
  must(markBatchPaid(t.ctx, { batchId: r.batchId, confirmation: true, valueDate: '2026-07-22', idempotencyKey: 'l3-paid' }));
  const sav = must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1000'), idempotencyKey: 'l3-sav' })).bankAccountId;
  const main = importLines(t, {
    statementId: 'L3',
    entries: [
      { ref: 'M', amountMinor: 900, cd: 'DBIT' },
      { ref: 'RUN', amountMinor: 100000, cd: 'DBIT', date: '2026-07-22', pmtInfId: frozenPmtInfId(t, r.batchId) },
      { ref: 'OUT', amountMinor: 50000, cd: 'DBIT', iban: SAVINGS_IBAN, date: '2026-07-25' },
    ],
  });
  const savings = importLines(t, { statementId: 'L3-SAV', iban: SAVINGS_IBAN, entries: [{ ref: 'IN', amountMinor: 50000, cd: 'CRDT', iban: MAIN_IBAN, date: '2026-07-25' }] }, { bankAccountId: sav });
  const target = (id) => lineOf(must(listBankInbox(t.ctx, { status: 'open' })), id).proposal.target;
  must(bookBankLine(t.ctx, { bankTxnId: main.lines.M, target: { kind: 'existing_entry', entryId: hand.entryId }, idempotencyKey: 'l3-m' }));
  must(bookBankLine(t.ctx, { bankTxnId: main.lines.RUN, target: { kind: 'payment_batch', batchId: r.batchId }, idempotencyKey: 'l3-run' }));
  must(bookBankLine(t.ctx, { bankTxnId: main.lines.OUT, target: target(main.lines.OUT), idempotencyKey: 'l3-out' }));
  must(bookBankLine(t.ctx, { bankTxnId: savings.lines.IN, target: target(savings.lines.IN), idempotencyKey: 'l3-in' }));
  for (const [id, key, again] of [
    [main.lines.M, 'm', { kind: 'existing_entry', entryId: hand.entryId }],
    [main.lines.RUN, 'run', { kind: 'payment_batch', batchId: r.batchId }],
    [savings.lines.IN, 'in', null],
  ]) {
    must(reopenBankLine(t.ctx, { bankTxnId: id, reason: 'nochmals', idempotencyKey: `l3-re-${key}` }));
    const redo = must(bookBankLine(t.ctx, { bankTxnId: id, target: again ?? target(id), idempotencyKey: `l3-again-${key}` }));
    assert.equal(redo.state, 'matched', `${key}: the released leg is matched again`);
  }
});


// --- Re-critic L4, L5: pins for guards that are right today ------------------------------------------------

test('re-critic L4: a hand entry matched across a month end is NOT a transfer and still matches (only own-account transfers refuse)', () => {
  const t = world();
  const hand = must(postEntry(t.ctx, { date: '2026-07-31', source: 'manual', description: 'Miete Juli', idempotencyKey: 'l4-hand', lines: [{ account: t.acc('6500'), debit: 150000 }, { account: t.acc('1020'), credit: 150000 }] }));
  const { lines } = importLines(t, { statementId: 'RL4', entries: [{ ref: 'X', amountMinor: 150000, cd: 'DBIT', date: '2026-08-03' }] });
  assert.equal(must(bookBankLine(t.ctx, { bankTxnId: lines.X, target: { kind: 'existing_entry', entryId: hand.entryId }, idempotencyKey: 'l4' })).state, 'matched');
});

test('re-critic L5: a line whose EndToEndId names a run item that is no candidate never proves a sibling by the run PmtInfId', () => {
  const t = world();
  const r = run(t, 'rl5', [25000, 25000]);
  must(markBatchPaid(t.ctx, { batchId: r.batchId, confirmation: true, valueDate: '2026-07-22', idempotencyKey: 'rl5-paid' }));
  const items = itemsOf(t, r.batchId);
  const pmt = frozenPmtInfId(t, r.batchId);
  const { lines } = importLines(t, {
    statementId: 'RL5',
    entries: [
      { ref: 'A', amountMinor: 25000, cd: 'DBIT', date: '2026-07-22', pmtInfId: pmt, e2e: frozenEndToEndId(t, items[0].id) },
      { ref: 'A2', amountMinor: 25000, cd: 'DBIT', date: '2026-07-22', pmtInfId: pmt, e2e: frozenEndToEndId(t, items[0].id) },
    ],
  });
  // Line A takes item 0's payment; A2 names item 0 too, so its only candidate is item 1's payment.
  must(bookBankLine(t.ctx, { bankTxnId: lines.A, target: { kind: 'existing_entry', entryId: items[0].entryId }, idempotencyKey: 'rl5-a' }));
  const p = lineOf(must(listBankInbox(t.ctx, { status: 'open' })), lines.A2).proposal;
  assert.equal(p.target?.entryId, items[1].entryId);
  assert.notEqual(p.certainty, 'sure', 'the line names another payment: the sibling is not proven');
});
