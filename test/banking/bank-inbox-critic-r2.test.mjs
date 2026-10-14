// A39 critic round 2 (docs/critique/a39-bank-inbox-critic-r2.md), every probe that still applies to the
// lean spec ported as a regression test, grouped by the CLASS each fix closes. The adoption probes (q1,
// q9, the two-line entry) moved to bank-inbox-migration.test.mjs with L1; q2/q3 became the one-door rule
// (L2); the stale decision (q4 (c), q7) is refused at the reversal chokepoint (L3); q6 follows D139.
// Synthetic data only; every temp directory is removed.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  bookBankLine,
  ignoreBankLine,
  listBankInbox,
  applyQrMatch,
  overrideQrMatch,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  markBatchPaid,
  createBankAccount,
  bankReconciledForPeriod,
} from '../../dist/core/banking/index.js';
import { writeLineLink, BankAbort } from '../../dist/core/banking/bankLines.js';
import { frozenPmtInfId, frozenEndToEndId } from './frozen-refs-support.mjs';
import { postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import { reversePayment, PAYMENT_INTENTS } from '../../dist/core/payments/payment.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { assertClaimInvariantHolds, trackClaimInvariant, world, importLines, issueInvoice, postedBill, must, refused, rowCounts, balanceOf, MAIN_IBAN, SAVINGS_IBAN } from './bank-inbox-support.mjs';
import { legClaimViolations, multiActiveViolations } from './bank-inbox-invariants.mjs';

// Critic A39R2-4: the claim invariant is asserted after EVERY scenario of this suite.
afterEach(assertClaimInvariantHolds);

const lineOf = (ctx, id) => must(listBankInbox(ctx, { status: 'all' })).lines.find((l) => l.bankTxnId === id);
const summary = (ctx, bankAccountId) => must(listBankInbox(ctx, { bankAccountId })).summary[0];

// --- A39R2-1, the queue: one door per imported line (L2) -------------------------------------------------

test('A39R2-1 (the queue guard, mutation B8): a queue row out of step with its line can never settle it: use_bank_inbox', () => {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'b8' });
  const { lines } = importLines(t, { statementId: 'B8', entries: [{ ref: 'C', amountMinor: 108100, cd: 'CRDT' }] });
  must(bookBankLine(t.ctx, { bankTxnId: lines.C, target: { kind: 'accounts', legs: [{ accountId: t.acc('3400'), amountMinor: 108100 }] }, idempotencyKey: 'b' }));
  const credit = t.store.db.prepare('SELECT credit_id AS c FROM bank_txn WHERE id = ?').get(lines.C).c;
  // The queue row says open (a restore, a legacy state, a race): the LINE's state is what guards.
  t.store.db.prepare("UPDATE reconciliation_match SET status = 'open' WHERE id = ?").run(credit);
  const before = rowCounts(t.store, t.workspaceId);
  const res = refused(applyQrMatch(t.ctx, { creditId: credit, invoiceId: inv.id, mode: 'partial', confirmed: true, idempotencyKey: 'q' }), 'use_bank_inbox');
  // The queue refuses every imported credit whatever its row says (L2), naming the credit and its line.
  assert.equal(res.creditId, credit);
  assert.equal(res.bankTxnId, lines.C);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'nothing paid');
});

test('C6: an imported credit whose line does not resolve here is still known by its bank_txn_id, never treated as hand-typed', () => {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'ur' });
  const { lines } = importLines(t, { statementId: 'UR', entries: [{ ref: 'C', amountMinor: 108100, cd: 'CRDT' }] });
  const credit = t.store.db.prepare('SELECT credit_id AS c FROM bank_txn WHERE id = ?').get(lines.C).c;
  t.store.db.prepare('UPDATE bank_txn SET credit_id = NULL WHERE id = ?').run(lines.C);
  refused(applyQrMatch(t.ctx, { creditId: credit, invoiceId: inv.id, mode: 'partial', confirmed: true, idempotencyKey: 'q' }), 'use_bank_inbox');
  refused(overrideQrMatch(t.ctx, { creditId: credit, action: 'dismiss', idempotencyKey: 'o' }), 'use_bank_inbox');
  // The G15 queue leaves it out too (C2): it offers no verb that would refuse.
  const provider = t.store.db.prepare("SELECT COUNT(*) AS n FROM reconciliation_match WHERE workspace_id = ? AND status = 'open' AND bank_txn_id IS NULL").get(t.workspaceId).n;
  assert.equal(provider, 0);
});

// --- A39R2-6 + A39R2-8: the claim rules live in the one writer ----------------------------------------

test('A39R2-6 q4 (c) (L3): a leg a live decision holds is refused typed, never proposed, and its payment cannot be reversed around it', () => {
  const t = world();
  const bills = [60000, 40000].map((a, i) => postedBill(t, { grossMinor: a, seed: `c-${i}`, vendorName: `Lieferant ${i}` }));
  for (const [i, b] of bills.entries()) must(setCreditorBankProfile(t.ctx, { vendorId: b.vendorId, iban: SAVINGS_IBAN, idempotencyKey: `cbp-${i}` }));
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId: t.bankAccountId, itemIds: bills.map((b) => b.vendorBillId), executionDate: '2026-07-22', idempotencyKey: 'batch' }));
  must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: 'gen' }));
  must(markBatchPaid(t.ctx, { batchId: batch.batchId, confirmation: true, valueDate: '2026-07-22', idempotencyKey: 'hand' }));
  const pays = t.store.db.prepare('SELECT p.id, p.journal_entry_id AS e FROM payment_batch_item i JOIN payment p ON p.id = i.posted_payment_id WHERE i.batch_id = ? ORDER BY i.rowid').all(batch.batchId);
  const { lines } = importLines(t, { statementId: 'QC', entries: [
    { ref: 'RUN', amountMinor: 100000, cd: 'DBIT', date: '2026-07-22', pmtInfId: frozenPmtInfId(t, batch.batchId) },
    { ref: 'TWO', amountMinor: 40000, cd: 'DBIT', date: '2026-07-23' },
  ] });
  must(bookBankLine(t.ctx, { bankTxnId: lines.RUN, target: { kind: 'payment_batch', batchId: batch.batchId }, idempotencyKey: 'run' }));
  const rv = refused(reversePayment(t.ctx, { paymentId: pays[0].id, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'rv' }), 'owned_by');
  assert.equal(rv.verb, 'reopen_bank_line');
  assert.equal(rv.bankTxnId, lines.RUN, 'the refusal names the line that holds the payment');
  assert.equal(lineOf(t.ctx, lines.RUN).state, 'matched');
  const p = lineOf(t.ctx, lines.TWO).proposal;
  assert.notDeepEqual(p.target, { kind: 'existing_entry', entryId: pays[1].e }, 'a leg the storage would refuse is not offered');
  let res;
  assert.doesNotThrow(() => {
    res = bookBankLine(t.ctx, { bankTxnId: lines.TWO, target: { kind: 'existing_entry', entryId: pays[1].e }, idempotencyKey: 'two' });
  });
  refused(res, 'entry_already_linked');
  assert.equal(res.bankTxnId, lines.RUN, 'the refusal names the holder');
});

test('A39R2-8 q8 (ii): an entry recording one movement on two bank legs is matched as a whole, with no phantom difference', () => {
  const t = world();
  const e = must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'Zwei Einzahlungen', idempotencyKey: 'e', lines: [{ account: t.acc('1020'), debit: 30000 }, { account: t.acc('1020'), debit: 20000 }, { account: t.acc('3400'), credit: 50000 }] }));
  const { lines } = importLines(t, { statementId: 'S', entries: [{ ref: 'T', amountMinor: 50000, cd: 'CRDT', date: '2026-07-20' }] });
  const m = must(bookBankLine(t.ctx, { bankTxnId: lines.T, target: { kind: 'existing_entry', entryId: e.entryId }, idempotencyKey: 'm' }));
  assert.equal(m.differenceMinor, null);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_line_claim WHERE link_id = ?').get(m.linkId).n, 2, 'both legs claimed');
  const s = summary(t.ctx, t.bankAccountId);
  assert.equal(s.bankBalanceMinor, 50000);
  assert.equal(s.ledgerBalanceMinor, 50000);
  assert.equal(s.differenceMinor, 0);
});

test('A39R2-4/6/8: the ONE writer refuses a leg off the line\'s account, a held leg, and legs that do not sum to the line, typed', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'W', entries: [{ ref: 'X', amountMinor: 500, cd: 'DBIT' }, { ref: 'Y', amountMinor: 500, cd: 'DBIT' }] });
  const e = must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'x', idempotencyKey: 'e', lines: [{ account: t.acc('6500'), debit: 400 }, { account: t.acc('1020'), credit: 400 }] }));
  const legOf = (number) => t.store.db.prepare('SELECT jl.id FROM journal_line jl JOIN account a ON a.id = jl.account_id WHERE jl.entry_id = ? AND a.number = ?').get(e.entryId, number).id;
  const attempt = (claims, extra = {}) => {
    try {
      t.store.tx(() => writeLineLink(t.ctx, { bankTxnId: lines.X, kind: 'journal_entry', targetId: e.entryId, state: 'matched', targetKind: 'existing_entry', entryId: e.entryId, claims, ...extra }));
      return { ok: true };
    } catch (err) {
      assert.ok(err instanceof BankAbort, `a typed refusal, not ${err}`);
      return err.result;
    }
  };
  assert.equal(attempt([legOf('6500')]).error, 'claim_off_account');
  assert.equal(attempt([legOf('1020')]).error, 'amount_mismatch', 'a -400 leg for a -500 line');
  assert.equal(attempt([legOf('1020')], { differenceMinor: -100, acceptDifference: true }).ok, true, 'the accepted difference explains it');
  assert.equal(attempt([legOf('1020')], { differenceMinor: -100, acceptDifference: true, bankTxnId: lines.Y }).error, 'entry_already_linked', 'X holds the leg now');
});

// --- A39R2-4: a run is funded only by its own Bankkonto's debit (L2: through book_bank_line) ------------

test('A39R2-4 q4 (b): a run is funded only by a debit of ITS Bankkonto for ITS total; nothing moves otherwise', () => {
  const t = world();
  const sav = must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1000'), idempotencyKey: 'sav' })).bankAccountId;
  const bills = [60000, 40000].map((a, i) => postedBill(t, { grossMinor: a, seed: `b-${i}`, vendorName: `Lieferant ${i}` }));
  for (const [i, b] of bills.entries()) must(setCreditorBankProfile(t.ctx, { vendorId: b.vendorId, iban: 'CH7200235123456789012', idempotencyKey: `cbp-${i}` }));
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId: t.bankAccountId, itemIds: bills.map((b) => b.vendorBillId), executionDate: '2026-07-22', idempotencyKey: 'batch' }));
  must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: 'gen' }));
  const other = importLines(t, { statementId: 'QB', iban: SAVINGS_IBAN, entries: [{ ref: 'X', amountMinor: 100000, cd: 'DBIT', date: '2026-07-22' }] }, { bankAccountId: sav });
  const main = importLines(t, { statementId: 'QM', entries: [{ ref: 'SHORT', amountMinor: 99999, cd: 'DBIT', date: '2026-07-22' }, { ref: 'RUN', amountMinor: 100000, cd: 'DBIT', date: '2026-07-22' }] });
  const run = { kind: 'payment_batch', batchId: batch.batchId };
  const before = rowCounts(t.store, t.workspaceId);
  refused(bookBankLine(t.ctx, { bankTxnId: other.lines.X, target: run, idempotencyKey: 'x' }), 'wrong_bank_account');
  const short = refused(bookBankLine(t.ctx, { bankTxnId: main.lines.SHORT, target: run, idempotencyKey: 's' }), 'amount_mismatch');
  assert.equal(short.batchTotalMinor, 100000, 'refused up front, naming the run total, before any payment is attempted');
  refused(markBatchPaid(t.ctx, { batchId: batch.batchId, confirmation: true, valueDate: '2026-07-22', idempotencyKey: 'mbp', bankTxnId: main.lines.RUN }), 'use_bank_inbox');
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'the refusals moved nothing');
  must(bookBankLine(t.ctx, { bankTxnId: main.lines.RUN, target: run, idempotencyKey: 'r' }));
  assert.equal(lineOf(t.ctx, main.lines.RUN).state, 'booked');
  assert.equal(lineOf(t.ctx, other.lines.X).state, 'open');
});

// --- A39R2-5 (owner decision): a stored rule never moves a bank ledger ------------------------------------

function ruleWorkspace(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Regel AG', `${seed}-ws`);
  trackClaimInvariant(deps.store, workspaceId);
  const c = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  must(c('vat_seed_defaults', {}), 'seed');
  must(c('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'vat');
  must(c('create_bank_account', { name: 'Konto', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'b' }), 'bank');
  const contact = must(c('create_contact', { partyRole: 'customer', name: 'Kunde AG', idempotencyKey: 'k' }), 'contact').contact.id;
  const ledger = (number) => deps.store.db.prepare(`SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ? AND l.account_id = ? AND e.status = 'posted'`).get(workspaceId, accId(number)).n;
  const issue = (key) => {
    const doc = must(c('create_document', { type: 'invoice', contactId: contact, lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }], idempotencyKey: `d-${key}` }), 'doc').document;
    must(c('issue_invoice', { invoiceId: doc.id, idempotencyKey: `i-${key}` }), 'issue');
    return doc;
  };
  const runs = () => deps.store.db.prepare('SELECT status, error_code, action_tool FROM automation_run WHERE workspace_id = ? ORDER BY rowid').all(workspaceId);
  return { deps, workspaceId, accId, c, ledger, issue, runs };
}

test('A39R2-5 q5: a rule may not record, allocate or reverse a payment, nor set a Bankkonto opening balance', () => {
  const w = ruleWorkspace('q5a');
  for (const tool of ['record_payment', 'allocate_payment', 'reverse_payment', 'set_bank_opening_balance']) {
    refused(w.c('create_automation_rule', { name: tool, trigger: { event: 'invoice.issued' }, action: { tool, inputTemplate: {} }, idempotencyKey: `r-${tool}` }), 'action_not_automatable', tool);
  }
  // The probe's exact rule, stored before the denial, is refused when it fires: no invoice is settled.
  const created = must(w.c('create_automation_rule', { name: 'vor A39R2-5', trigger: { event: 'invoice.issued' }, action: { tool: 'contacts_tag', inputTemplate: { contactId: 'x', segments: ['a'] } }, idempotencyKey: 'legacy' }));
  w.deps.store.db.prepare('UPDATE automation_rule SET action_tool = ?, action_input = ? WHERE workspace_id = ? AND id = ?').run('record_payment', JSON.stringify({
    direction: 'incoming', date: '2026-07-19', amountMinor: '{{result.document.totalMinor}}', currency: 'CHF', bankAccountId: w.accId('1020'),
    allocations: [{ documentId: '{{input.invoiceId}}', amountMinor: '{{result.document.totalMinor}}' }], intent: 'post_payment',
  }), w.workspaceId, created.rule.ruleId);
  const doc = w.issue('1');
  assert.deepEqual(w.runs().map((r) => [r.status, r.error_code]), [['failed', 'action_not_automatable']]);
  assert.equal(w.deps.store.db.prepare('SELECT status FROM document WHERE id = ?').get(doc.id).status, 'issued');
  assert.equal(w.ledger('1020'), 0, 'no money reached the bank ledger without a bank line');
});

test('A39R2-5: a post_entry rule is refused AT FIRE TIME when its resolved lines touch a Bankkonto ledger, and still fires elsewhere', () => {
  const w = ruleWorkspace('q5b');
  must(w.c('create_automation_rule', {
    name: 'Bank belasten',
    trigger: { event: 'invoice.issued' },
    action: { tool: 'post_entry', inputTemplate: { date: '2026-07-20', source: 'manual', description: 'automatisch', lines: [{ account: w.accId('6500'), debit: 100 }, { account: w.accId('1020'), credit: 100 }] } },
    idempotencyKey: 'bank',
  }));
  must(w.c('create_automation_rule', {
    name: 'Umbuchen',
    trigger: { event: 'invoice.issued' },
    action: { tool: 'post_entry', inputTemplate: { date: '2026-07-20', source: 'manual', description: 'automatisch', lines: [{ account: w.accId('6500'), debit: 100 }, { account: w.accId('6800'), credit: 100 }] } },
    idempotencyKey: 'plain',
  }));
  w.issue('2');
  const runs = w.runs();
  assert.deepEqual(runs.map((r) => [r.status, r.error_code]).sort(), [['failed', 'action_not_automatable'], ['ok', null]]);
  assert.equal(w.ledger('1020'), 0, 'the bank-ledger firing was rolled back');
  assert.equal(w.ledger('6800'), -100, 'the plain posting fired (the G01 showcase stands)');
});

// --- A39R2-7, replaced by D139: coverage starts at the first statement ------------------------------

test('D139 (replacing A39R2-7): postings on the linked ledger before the first statement do not fail the earlier quarter', () => {
  const t = world();
  const sav = must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1000'), idempotencyKey: 'sav' })).bankAccountId;
  must(postEntry(t.ctx, { date: '2026-02-10', source: 'manual', description: 'Miete Februar ab Bank', idempotencyKey: 'q1', lines: [{ account: t.acc('6000'), debit: 250000 }, { account: t.acc('1020'), credit: 250000 }] }));
  must(postEntry(t.ctx, { date: '2026-02-12', source: 'manual', description: 'Kundenzahlung', idempotencyKey: 'q1b', lines: [{ account: t.acc('1020'), debit: 500000 }, { account: t.acc('3400'), credit: 500000 }] }));
  importLines(t, { statementId: 'M7', from: '2026-07-01', to: '2026-07-31', openingMinor: 250000, entries: [{ ref: 'F', amountMinor: 100, cd: 'DBIT', date: '2026-07-10' }] });
  importLines(t, { statementId: 'S8', iban: SAVINGS_IBAN, from: '2026-08-01', to: '2026-09-30', openingMinor: 0, entries: [{ ref: 'I', amountMinor: 700, cd: 'CRDT', date: '2026-08-10' }] }, { bankAccountId: sav });
  const q1 = bankReconciledForPeriod(t.ctx, '2026-01-01', '2026-03-31');
  assert.deepEqual(q1.accounts.map((a) => a.status), ['not_started', 'not_started'], 'Q1 ends before either first statement');
  assert.equal(q1.passed, true);
  const q3 = bankReconciledForPeriod(t.ctx, '2026-07-01', '2026-09-30');
  const main = q3.accounts.find((a) => a.bankAccountId === t.bankAccountId);
  assert.equal(main.status, 'not_covered', 'July does not reach the Q3 end');
  assert.equal(main.action, 'import_camt');
  assert.equal(q3.accounts.find((a) => a.bankAccountId === sav).status, 'open_lines');
});

// --- A39R2-2: an own-account transfer in bulk -------------------------------------------------------------

test('A39R2-2 q10 (D139): no side of a transfer is sure; booking every proposal of ONE inbox read books it once', () => {
  const t = world();
  const sav = must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1000'), idempotencyKey: 'sav' })).bankAccountId;
  importLines(t, { statementId: 'MAIN-1', entries: [{ ref: 'OUT', amountMinor: 50000, cd: 'DBIT', iban: SAVINGS_IBAN, date: '2026-07-25' }] });
  importLines(t, { statementId: 'SAV-1', iban: SAVINGS_IBAN, entries: [{ ref: 'IN', amountMinor: 50000, cd: 'CRDT', iban: MAIN_IBAN, date: '2026-07-25' }] }, { bankAccountId: sav });
  const page = must(listBankInbox(t.ctx, { status: 'open' })).lines;
  const sure = page.filter((l) => l.proposal?.certainty === 'sure');
  assert.equal(sure.length, 0, `no transfer side is sure, so "Alle sicheren buchen" books none: ${JSON.stringify(page.map((l) => [l.amountMinor, l.proposal.certainty]))}`);
  // Book EVERY proposal of that one read (what "Alle sicheren buchen" or an agent at auto does), sure or not.
  for (const l of page) bookBankLine(t.ctx, { bankTxnId: l.bankTxnId, target: l.proposal.target, idempotencyKey: `bulk-${l.bankTxnId}` });
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), -50000, 'the main account moved once');
  assert.equal(balanceOf(t.store, t.workspaceId, '1000'), 50000, 'the savings account moved once');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(t.workspaceId).n, 1);
  // The second side, re-read, matches the booked transfer (check: a person confirms it).
  const second = must(listBankInbox(t.ctx, { status: 'open' })).lines[0];
  assert.equal(second.proposal.target.kind, 'existing_entry');
  assert.equal(second.proposal.certainty, 'check');
  must(bookBankLine(t.ctx, { bankTxnId: second.bankTxnId, target: second.proposal.target, idempotencyKey: 'second' }));
  for (const id of [t.bankAccountId, sav]) assert.equal(summary(t.ctx, id).differenceMinor, 0);
  assert.deepEqual(legClaimViolations(t.store, t.workspaceId), []);
});

// --- A39R2-3: a Storno of a Storno (reversal chains), now refused at the chokepoint (L3) ----------------

test('A39R2-3 q7 (i) (L3): the Storno of a booked line\'s entry refuses owned_by; the line stays booked and the books balance', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'S7', entries: [{ ref: 'F', amountMinor: 700, cd: 'DBIT', date: '2026-07-10' }] });
  const b = must(bookBankLine(t.ctx, { bankTxnId: lines.F, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 700 }] }, idempotencyKey: 'f' }));
  const r = refused(reverseEntry(t.ctx, { entryId: b.entryId, idempotencyKey: 'r1' }), 'owned_by');
  assert.equal(r.verb, 'reopen_bank_line');
  assert.equal(lineOf(t.ctx, lines.F).state, 'booked');
  const s = summary(t.ctx, t.bankAccountId);
  assert.equal(s.ledgerBalanceMinor, -700);
  assert.equal(s.differenceMinor, 0);
});

test('A39R2-3 q7 (ii) (C16b): a hand entry no line backs, Stornoed twice, keeps the books right; its line is ignored booked_elsewhere', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'S8', entries: [{ ref: 'G', amountMinor: 700, cd: 'DBIT', date: '2026-07-10' }] });
  const e = must(postEntry(t.ctx, { date: '2026-07-10', source: 'manual', description: 'Gebühr', idempotencyKey: 'e', lines: [{ account: t.acc('6900'), debit: 700 }, { account: t.acc('1020'), credit: 700 }] }));
  const r1 = must(reverseEntry(t.ctx, { entryId: e.entryId, idempotencyKey: 'r1' }));
  must(reverseEntry(t.ctx, { entryId: r1.reversalId, idempotencyKey: 'r2' }));
  // No entry of the chain can back the line any more (a reversed entry, and reversals), so it is ignored.
  refused(bookBankLine(t.ctx, { bankTxnId: lines.G, target: { kind: 'existing_entry', entryId: e.entryId }, idempotencyKey: 'm' }), 'entry_reversed');
  must(ignoreBankLine(t.ctx, { bankTxnId: lines.G, reason: 'booked_elsewhere', idempotencyKey: 'i' }));
  const s = summary(t.ctx, t.bankAccountId);
  assert.equal(s.ledgerBalanceMinor, -700, 'the chain nets to the one movement');
  assert.equal(s.differenceMinor, 0);
});
