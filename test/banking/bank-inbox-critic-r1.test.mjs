// A39 critic round 1 (docs/critique/a39-bank-inbox-critic-r1.md), every probe that still applies to the
// lean spec ported as a regression test. Each test names its finding and its probe (`pN`) and asserts the
// CORRECTED behaviour on rows and figures, so a regression turns a specific test red. Probes of features
// the lean spec cut (the stale decision A39-7, the explained balance A39-8's terms, the per-line review
// signal A39-9, the agent-seat auto-apply A39-4 p8, bank rules) left with their features; A39-7 is now
// refused at the reversal chokepoint (bank-inbox-reversal-guard.test.mjs). Synthetic data only.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBankAccount,
  bookBankLine,
  listBankInbox,
  ignoreBankLine,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  markBatchPaid,
  bankReconciledForPeriod,
  applyQrMatch,
  recordIncomingCredit,
  setBankOpeningBalance,
  setQrAutoApply,
} from '../../dist/core/banking/index.js';
import { getAction } from '../../dist/api/registry.js';
import { runGoverned } from '../../dist/api/agent-gate.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { seedOpeningBalanceAccount } from './support.mjs';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { frozenPmtInfId, frozenEndToEndId } from './frozen-refs-support.mjs';
import { assertClaimInvariantHolds, trackClaimInvariant, world, camt, importLines, postedBill, issueInvoice, must, refused, balanceOf, rowCounts, MAIN_IBAN, SAVINGS_IBAN } from './bank-inbox-support.mjs';
import { legClaimViolations } from './bank-inbox-invariants.mjs';

// Critic A39R2-4: the claim invariant is asserted after EVERY scenario of this suite.
afterEach(assertClaimInvariantHolds);

const lineOf = (t, id, status = 'all') => must(listBankInbox(t.ctx, { status })).lines.find((l) => l.bankTxnId === id);
const summaryOf = (t, bankAccountId) => must(listBankInbox(t.ctx, { bankAccountId })).summary[0];

/** Two own accounts: the main one on 1020 and a savings account on 1000, each with its side of a transfer. */
function transferWorld() {
  const t = world();
  const sav = must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: SAVINGS_IBAN, currency: 'CHF', ledgerAccountId: t.acc('1000'), idempotencyKey: 'sav' })).bankAccountId;
  const a = importLines(t, { statementId: 'MAIN-1', entries: [{ ref: 'OUT', amountMinor: 50000, cd: 'DBIT', iban: SAVINGS_IBAN, name: 'Übertrag Sparkonto', date: '2026-07-25' }] });
  const b = importLines(t, { statementId: 'SAV-1', iban: SAVINGS_IBAN, entries: [{ ref: 'IN', amountMinor: 50000, cd: 'CRDT', iban: MAIN_IBAN, name: 'Übertrag Geschäftskonto', date: '2026-07-25' }] }, { bankAccountId: sav });
  return { t, sav, out: a.lines.OUT, inn: b.lines.IN };
}

// --- A39-1 (HIGH), probes p1 and p1b -------------------------------------------------------------

test('A39-1 p1: the second side of an own-account transfer MATCHES the booked transfer (check, D139), and never posts it twice', () => {
  const { t, sav, out, inn } = transferWorld();
  const first = lineOf(t, out, 'open').proposal;
  assert.equal(first.reasonCode, 'own_account_transfer');
  const booked = must(bookBankLine(t.ctx, { bankTxnId: out, target: first.target, idempotencyKey: 'm' }));

  // The savings line now sees the transfer already on the books; an own IBAN never makes it sure (D139).
  const second = lineOf(t, inn, 'open').proposal;
  assert.equal(second.target.kind, 'existing_entry', JSON.stringify(second));
  assert.equal(second.target.entryId, booked.entryId);
  assert.equal(second.certainty, 'check');
  assert.equal(second.reasonCode, 'own_account_transfer_booked');

  const before = rowCounts(t.store, t.workspaceId);
  const matched = must(bookBankLine(t.ctx, { bankTxnId: inn, target: second.target, idempotencyKey: 's' }));
  assert.equal(matched.state, 'matched');
  assert.equal(rowCounts(t.store, t.workspaceId).entries, before.entries, 'following the proposal posts nothing');
  assert.equal(balanceOf(t.store, t.workspaceId, '1020'), -50000, 'the main account moved once');
  assert.equal(balanceOf(t.store, t.workspaceId, '1000'), 50000, 'the savings account moved once');
  for (const id of [t.bankAccountId, sav]) assert.equal(summaryOf(t, id).differenceMinor, 0, `bank = books on ${id}`);
  assert.deepEqual(legClaimViolations(t.store, t.workspaceId), []);
});

test('A39-1 p1: each side claims ONLY its own leg; the other leg of the entry is refused to a line that already holds one', () => {
  const { t, out, inn } = transferWorld();
  const booked = must(bookBankLine(t.ctx, { bankTxnId: out, target: { kind: 'accounts', legs: [{ accountId: t.acc('1000'), amountMinor: 50000 }] }, idempotencyKey: 'm' }));
  const claims = t.store.db.prepare('SELECT bank_txn_id AS txn, a.number AS account FROM bank_line_claim c JOIN journal_line jl ON jl.id = c.journal_line_id JOIN account a ON a.id = jl.account_id WHERE c.workspace_id = ?').all(t.workspaceId);
  assert.deepEqual(claims, [{ txn: out, account: '1020' }], 'the main line claims the 1020 leg only');
  must(bookBankLine(t.ctx, { bankTxnId: inn, target: { kind: 'existing_entry', entryId: booked.entryId }, idempotencyKey: 's' }));
  // A third line on the main account cannot take the 1020 leg the first one holds.
  const { lines } = importLines(t, { statementId: 'MAIN-2', seqNb: '2', entries: [{ ref: 'DUP', amountMinor: 50000, cd: 'DBIT', date: '2026-07-25' }] });
  refused(bookBankLine(t.ctx, { bankTxnId: lines.DUP, target: { kind: 'existing_entry', entryId: booked.entryId }, idempotencyKey: 'd' }), 'entry_already_linked');
});

test('A39-1 rung (c): a transfer booked outside the rung-(a) window is proposed as a MATCH, never as a second transfer', () => {
  const { t, inn } = transferWorld();
  // The main side left weeks earlier than the savings statement reports it arriving.
  const main = importLines(t, { statementId: 'MAIN-0', seqNb: '0', entries: [{ ref: 'EARLY', amountMinor: 50000, cd: 'DBIT', iban: SAVINGS_IBAN, date: '2026-07-05' }] });
  const early = importLines(t, { statementId: 'SAV-2', iban: SAVINGS_IBAN, seqNb: '2', entries: [{ ref: 'LATE', amountMinor: 50000, cd: 'CRDT', iban: MAIN_IBAN, date: '2026-07-30' }] }, { bankAccountId: lineOf(t, inn).bankAccountId, key: 'imp-late' });
  const booked = must(bookBankLine(t.ctx, { bankTxnId: main.lines.EARLY, target: { kind: 'accounts', legs: [{ accountId: t.acc('1000'), amountMinor: 50000 }] }, idempotencyKey: 'm' }));
  // Booking the savings side as a SECOND transfer is refused by the engine itself (critic A39R2-2).
  const again = refused(bookBankLine(t.ctx, { bankTxnId: inn, target: { kind: 'accounts', legs: [{ accountId: t.acc('1020'), amountMinor: 50000 }] }, idempotencyKey: 'other' }), 'transfer_already_booked');
  assert.equal(again.entryId, booked.entryId);
  // The LATE credit (25 days from the transfer entry) must not be offered a fresh transfer while the
  // entry's savings leg is unclaimed.
  const p = lineOf(t, early.lines.LATE, 'open').proposal;
  assert.equal(p.target.kind, 'existing_entry', JSON.stringify(p));
  assert.equal(p.target.entryId, booked.entryId);
  assert.equal(p.reasonCode, 'own_account_transfer_booked');
  assert.equal(p.certainty, 'check');
});

test('A39-1 p1b: ignoring the second side as booked_elsewhere leaves NO difference on either account', () => {
  const { t, sav, out, inn } = transferWorld();
  must(bookBankLine(t.ctx, { bankTxnId: out, target: { kind: 'accounts', legs: [{ accountId: t.acc('1000'), amountMinor: 50000 }] }, idempotencyKey: 'm' }));
  must(ignoreBankLine(t.ctx, { bankTxnId: inn, reason: 'booked_elsewhere', idempotencyKey: 'i' }));
  const st = summaryOf(t, sav);
  assert.equal(st.bankBalanceMinor, 50000);
  assert.equal(st.ledgerBalanceMinor, 50000, 'the transfer entry\'s savings leg is on the books');
  assert.equal(st.openSumMinor, 0);
  assert.equal(st.differenceMinor, 0);
});

// --- A39-2 (MEDIUM), probe p2 --------------------------------------------------------------------

test('A39-2 p2: a run paid by hand whose payment already backs another line is refused, and not proposed', () => {
  const t = world();
  const bills = [60000, 40000].map((a, i) => postedBill(t, { grossMinor: a, seed: `b-${i}`, vendorName: `Lieferant ${i}` }));
  for (const [i, b] of bills.entries()) must(setCreditorBankProfile(t.ctx, { vendorId: b.vendorId, iban: SAVINGS_IBAN, idempotencyKey: `cbp-${i}` }));
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId: t.bankAccountId, itemIds: bills.map((b) => b.vendorBillId), executionDate: '2026-07-22', idempotencyKey: 'batch' }));
  must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: 'gen' }));
  must(markBatchPaid(t.ctx, { batchId: batch.batchId, confirmation: true, valueDate: '2026-07-22', idempotencyKey: 'by-hand' }));
  const pay = t.store.db.prepare('SELECT p.journal_entry_id AS e FROM payment_batch_item i JOIN payment p ON p.id = i.posted_payment_id WHERE i.batch_id = ? ORDER BY i.rowid').all(batch.batchId);
  const { lines } = importLines(t, { statementId: 'S', openingMinor: 200000, entries: [
    { ref: 'ONE', amountMinor: 60000, cd: 'DBIT', date: '2026-07-22' },
    { ref: 'RUN', amountMinor: 100000, cd: 'DBIT', date: '2026-07-22', pmtInfId: frozenPmtInfId(t, batch.batchId) },
  ] });
  must(bookBankLine(t.ctx, { bankTxnId: lines.ONE, target: { kind: 'existing_entry', entryId: pay[0].e }, idempotencyKey: 'one' }));
  const p = lineOf(t, lines.RUN, 'open').proposal;
  assert.notEqual(p.reasonCode, 'payment_batch_reference', `the run is no longer this line's to take: ${JSON.stringify(p)}`);
  const before = rowCounts(t.store, t.workspaceId);
  const r = refused(bookBankLine(t.ctx, { bankTxnId: lines.RUN, target: { kind: 'payment_batch', batchId: batch.batchId }, idempotencyKey: 'run' }), 'batch_already_linked');
  assert.equal(r.bankTxnId, lines.ONE, 'the refusal names the line holding the payment');
  assert.equal(r.entryId, pay[0].e);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'the refusal moved nothing');
  assert.deepEqual(legClaimViolations(t.store, t.workspaceId), []);
});

// --- A39-5 (MEDIUM), probe p6: CLBD is a BOOKED balance ------------------------------------------

test('A39-5 p6: a line booked on the statement\'s last day and valued the next counts in that statement and that quarter', () => {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'vd' });
  const { lines } = importLines(t, { statementId: 'VD', from: '2026-09-01', to: '2026-09-30', entries: [
    { ref: 'PAY', amountMinor: 108100, cd: 'CRDT', date: '2026-09-30', valueDate: '2026-10-01' },
    { ref: 'FEE', amountMinor: 500, cd: 'DBIT', date: '2026-09-30', valueDate: '2026-10-01' },
  ] });
  const open = summaryOf(t, t.bankAccountId);
  assert.equal(open.openCount, 2, 'both lines are open AS OF the statement date');
  assert.equal(open.openSumMinor, 107600);
  assert.equal(open.differenceMinor, 0, 'the open lines are the whole gap');
  assert.equal(bankReconciledForPeriod(t.ctx, '2026-07-01', '2026-09-30').openLines, 2, 'G22 counts them in Q3');

  const paid = must(bookBankLine(t.ctx, { bankTxnId: lines.PAY, target: { kind: 'open_item', documentId: inv.id }, idempotencyKey: 'p' }));
  must(bookBankLine(t.ctx, { bankTxnId: lines.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 500 }] }, idempotencyKey: 'f' }));
  const date = t.store.db.prepare('SELECT date FROM payment WHERE id = ?').get(paid.paymentId).date;
  assert.equal(date, '2026-09-30', 'the settlement is dated on the booking date by default');
  const booked = summaryOf(t, t.bankAccountId);
  assert.equal(booked.ledgerBalanceMinor, 107600);
  assert.equal(booked.differenceMinor, 0);
  const q3 = bankReconciledForPeriod(t.ctx, '2026-07-01', '2026-09-30');
  assert.equal(q3.passed, true, JSON.stringify(q3));
  assert.equal(q3.openLines, 0);
});

// --- A39-6 (MEDIUM), probe p12 --------------------------------------------------------------------

test('A39-6 p12: remainder write_off is bounded by the SAME one-click threshold as A21, and refuses above it moving nothing', () => {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'wo' });
  const inv2 = issueInvoice(t.ctx, { contactId: t.customerId, key: 'wo2' });
  const { lines } = importLines(t, { statementId: 'WO', entries: [
    { ref: 'ONE', amountMinor: 100, cd: 'CRDT', qrr: buildQrrReference(inv.number) },
    { ref: 'NEAR', amountMinor: 108000, cd: 'CRDT' },
  ] });
  const before = rowCounts(t.store, t.workspaceId);
  const r = refused(bookBankLine(t.ctx, { bankTxnId: lines.ONE, target: { kind: 'open_item', documentId: inv.id, remainder: 'write_off' }, idempotencyKey: 'w' }), 'write_off_above_threshold');
  assert.equal(r.writeOffMinor, 108000);
  assert.equal(r.thresholdMinor, 100);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'the refusal moved nothing');
  assert.equal(balanceOf(t.store, t.workspaceId, '3805'), 0);
  // The same act through the A21 queue (a hand-typed credit, L2) refuses with the same threshold.
  const typed = must(recordIncomingCredit(t.ctx, { bankAccountId: t.bankAccountId, amountMinor: 100, valueDate: '2026-07-20', reference: buildQrrReference(inv2.number), idempotencyKey: 'typed' }));
  const a = applyQrMatch(t.ctx, { creditId: typed.credit.creditId, invoiceId: inv2.id, mode: 'full', confirmed: true, idempotencyKey: 'q' });
  assert.equal(a.error, 'write_off_above_threshold');
  assert.equal(a.thresholdMinor, r.thresholdMinor);
  // At the threshold it books: CHF 1.00 short is forgiven in one click.
  const near = must(bookBankLine(t.ctx, { bankTxnId: lines.NEAR, target: { kind: 'open_item', documentId: inv.id, remainder: 'write_off' }, idempotencyKey: 'n' }));
  assert.deepEqual(near.remainder, { kind: 'written_off', amountMinor: 100, documentOpenMinor: 0, feeOpenMinor: 0 });
});

// --- A39-8 (MEDIUM), probe p16 --------------------------------------------------------------------

test('A39-8 p16 (L4): a before_start line whose money is in the opening balance leaves no difference', () => {
  const t = world();
  seedOpeningBalanceAccount(t.ctx);
  must(setBankOpeningBalance(t.ctx, { bankAccountId: t.bankAccountId, amountMinor: 10000, currency: 'CHF', date: '2026-07-10', idempotencyKey: 'ob' }));
  const { lines } = importLines(t, { statementId: 'BS', from: '2026-07-01', to: '2026-07-31', openingMinor: 0, entries: [
    { ref: 'OLD', amountMinor: 10000, cd: 'CRDT', date: '2026-07-05' },
    { ref: 'FEE', amountMinor: 500, cd: 'DBIT', date: '2026-07-20' },
  ] });
  must(ignoreBankLine(t.ctx, { bankTxnId: lines.OLD, reason: 'before_start', idempotencyKey: 'i' }));
  must(bookBankLine(t.ctx, { bankTxnId: lines.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 500 }] }, idempotencyKey: 'f' }));
  const b = summaryOf(t, t.bankAccountId);
  assert.equal(b.bankBalanceMinor, 9500);
  assert.equal(b.ledgerBalanceMinor, 9500);
  assert.equal(b.differenceMinor, 0);
});

test('A39-8 (L4): a duplicate the bank counted once leaves no difference; a booked_elsewhere line shows until its entry is found', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'DU', openingMinor: 0, closingMinor: -1500, entries: [
    { ref: 'A', amountMinor: 1000, cd: 'DBIT' },
    { ref: 'A2', amountMinor: 1000, cd: 'DBIT' },
    { ref: 'B', amountMinor: 500, cd: 'DBIT' },
  ] });
  must(bookBankLine(t.ctx, { bankTxnId: lines.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 1000 }] }, idempotencyKey: 'a' }));
  must(ignoreBankLine(t.ctx, { bankTxnId: lines.A2, reason: 'duplicate', idempotencyKey: 'd' }));
  must(ignoreBankLine(t.ctx, { bankTxnId: lines.B, reason: 'booked_elsewhere', idempotencyKey: 'b' }));
  const s = summaryOf(t, t.bankAccountId);
  assert.equal(s.differenceMinor, -500, 'the booked_elsewhere line is still owed an entry');
});

// --- A39-3 (HIGH), probe p7, and A39-4 (HIGH), probes p8 and p9: ONE rule for unattended money --------

function apiWorkspace(seed) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Regel AG', `${seed}-ws`);
  trackClaimInvariant(deps.store, workspaceId);
  const c = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  must(c('vat_seed_defaults', {}), 'seed');
  must(c('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' }), 'vat');
  const bankAccountId = must(c('create_bank_account', { name: 'Konto', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: accId('1020'), idempotencyKey: 'b' }), 'bank').bankAccountId;
  return { deps, workspaceId, accId, c, bankAccountId };
}

const journalCount = (deps, workspaceId) => deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;

test('A39-3 p7: a rule naming create_entry_for_txn or confirm_match is refused at save, and a stored one at fire time; nothing books', () => {
  const w = apiWorkspace('p7');
  for (const tool of ['create_entry_for_txn', 'confirm_match', 'book_bank_line']) {
    const r = w.c('create_automation_rule', {
      name: `Autopilot ${tool}`,
      trigger: { event: 'bank_txn.needs_review' },
      action: { tool, inputTemplate: { bankTxnId: '{{input.bankTxnId}}', contraAccountId: w.accId('3400'), taxCode: 'UST81' } },
      idempotencyKey: `r-${tool}`,
    });
    refused(r, 'action_not_automatable', tool);
  }
  // A rule stored BEFORE the denial (aimed at the wrapper underneath the save path) is refused when it fires.
  const created = must(w.c('create_automation_rule', { name: 'aus der Zeit vor A39-3', trigger: { event: 'bank_txn.needs_review' }, action: { tool: 'contacts_tag', inputTemplate: { contactId: 'x', segments: ['a'] } }, idempotencyKey: 'legacy' }));
  w.deps.store.db
    .prepare('UPDATE automation_rule SET action_tool = ?, action_input = ? WHERE workspace_id = ? AND id = ?')
    .run('create_entry_for_txn', JSON.stringify({ bankTxnId: '{{input.bankTxnId}}', contraAccountId: w.accId('3400'), taxCode: 'UST81' }), w.workspaceId, created.rule.ruleId);
  must(w.c('import_camt', { bankAccountId: w.bankAccountId, xml: camt({ statementId: 'G1', entries: [{ ref: 'IN1', amountMinor: 10810, cd: 'CRDT', name: 'Unbekannt' }, { ref: 'OUT1', amountMinor: 5000, cd: 'DBIT', name: 'Irgendwer' }] }), idempotencyKey: 'imp' }));
  // The import fires no per-line event any more (spec §4.6 CUT); review_bank_txn signals a line by hand.
  for (const r of w.deps.store.db.prepare('SELECT id FROM bank_txn WHERE workspace_id = ?').all(w.workspaceId)) {
    must(w.c('review_bank_txn', { bankTxnId: r.id, idempotencyKey: `rv-${r.id}` }));
  }
  const runs = w.deps.store.db.prepare('SELECT status, error_code FROM automation_run WHERE workspace_id = ?').all(w.workspaceId);
  assert.ok(runs.length > 0, 'the review event fired');
  for (const r of runs) assert.deepEqual([r.status, r.error_code], ['failed', 'action_not_automatable']);
  assert.equal(journalCount(w.deps, w.workspaceId), 0, 'no line was booked unattended');
  const states = must(w.c('list_bank_inbox', { status: 'all' })).lines.map((l) => l.state);
  assert.deepEqual(states, ['open', 'open']);
});

test('A39-4 p9: a rule naming record_incoming_credit is refused, so no stored template can claim money arrived', () => {
  const w = apiWorkspace('p9');
  must(w.c('set_qr_auto_apply', { autoApply: true, idempotencyKey: 'aa' }), 'auto-apply on');
  const r = w.c('create_automation_rule', {
    name: 'Gutschrift erfassen',
    trigger: { event: 'contact.created' },
    action: { tool: 'record_incoming_credit', inputTemplate: { bankAccountId: w.bankAccountId, amountMinor: 108100, currency: 'CHF', valueDate: '2026-07-16', reference: 'x' } },
    idempotencyKey: 'rule',
  });
  refused(r, 'action_not_automatable');
  for (const tool of ['import_camt', 'set_write_off_threshold']) {
    refused(w.c('create_automation_rule', { name: tool, trigger: { event: 'contact.created' }, action: { tool, inputTemplate: {} }, idempotencyKey: `r-${tool}` }), 'action_not_automatable', tool);
  }
});

test('A39-4 p8 (L2): the agent importing with the QR dial on settles nothing and drafts nothing; the line waits in the inbox', () => {
  const t = world();
  const agent = { store: t.store, clock: t.clock, ids: t.ids, actor: 'agent' };
  const g = (name, input) => runGoverned(agent, getAction(name), { workspaceId: t.workspaceId, ...input });
  must(setQrAutoApply(t.ctx, { autoApply: true, idempotencyKey: 'aa' }));
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'ag' });
  const xml = camt({ statementId: 'AG-1', entries: [{ ref: 'Q', amountMinor: 108100, cd: 'CRDT', qrr: buildQrrReference(inv.number) }] });
  // D161: the agent's import is itself governed under pay, so at the default ask it is a Vorschlag that
  // imports nothing. With pay GRANTED (a person's act), the import runs, and it still settles nothing
  // and drafts no apply: the stronger form of the claim, since a granted pay would let an apply run.
  const proposed = must(g('import_camt', { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'agent-imp-ask' }), 'the agent proposes the import');
  assert.equal(proposed.drafted, true, JSON.stringify(proposed));
  assert.equal(proposed.dialCapability, 'pay');
  must(getAction('set_agent_dial').run({ store: t.store, clock: t.clock, ids: t.ids, actor: 'studio' }, { workspaceId: t.workspaceId, capability: 'pay', level: 'auto', idempotencyKey: 'grant-pay' }), 'a person grants pay');
  const before = rowCounts(t.store, t.workspaceId);
  const imported = must(g('import_camt', { bankAccountId: t.bankAccountId, xml, idempotencyKey: 'agent-imp' }), 'the agent may import');
  assert.equal(imported.drafted, undefined, 'pay granted: the import runs');
  const after = rowCounts(t.store, t.workspaceId);
  assert.equal(after.payments, before.payments, 'no settlement at import');
  assert.equal(after.drafts, before.drafts, 'no apply drafted either');
  assert.equal(t.store.db.prepare('SELECT status FROM document WHERE id = ?').get(inv.id).status, 'issued');
  assert.equal(must(listBankInbox(t.ctx, {})).lines[0].proposal.certainty, 'sure', 'the line waits with its proposal');
});

// --- A39-10 (LOW): G22 per account starts at its books and judges coverage to the period end --------

test('A39-10: a period before the account\'s first statement is not_started (not a failure); a statement ending mid-period is not_covered', () => {
  const t = world();
  importLines(t, { statementId: 'JUL', from: '2026-07-01', to: '2026-07-31', openingMinor: 0, closingMinor: 0, entries: [] });
  const q1 = bankReconciledForPeriod(t.ctx, '2026-01-01', '2026-03-31');
  assert.equal(q1.accounts[0].status, 'not_started');
  assert.equal(q1.passed, true, 'nothing to reconcile before the account\'s books begin');
  const q3 = bankReconciledForPeriod(t.ctx, '2026-07-01', '2026-09-30');
  assert.equal(q3.accounts[0].status, 'not_covered', 'July does not vouch for August and September');
  assert.equal(q3.accounts[0].statementDate, '2026-07-31');
  assert.equal(q3.passed, false);
  // July alone is judged and reconciled.
  const jul = bankReconciledForPeriod(t.ctx, '2026-07-01', '2026-07-31');
  assert.equal(jul.accounts[0].status, 'reconciled');
  assert.equal(jul.accounts[0].judgedAt, '2026-07-31');
});

test('D139: an opening balance does NOT start statement coverage; a period before the first statement is not_started', () => {
  const t = world();
  seedOpeningBalanceAccount(t.ctx);
  must(setBankOpeningBalance(t.ctx, { bankAccountId: t.bankAccountId, amountMinor: 10000, currency: 'CHF', date: '2026-01-01', idempotencyKey: 'ob' }));
  importLines(t, { statementId: 'JUL', from: '2026-07-01', to: '2026-09-30', openingMinor: 10000, closingMinor: 10000, entries: [] });
  const q1 = bankReconciledForPeriod(t.ctx, '2026-01-01', '2026-03-31').accounts[0];
  assert.equal(q1.status, 'not_started', 'coverage starts at the first statement, whatever the ledger holds earlier (D139)');
  assert.equal(bankReconciledForPeriod(t.ctx, '2025-10-01', '2025-12-31').accounts[0].status, 'not_started');
  assert.equal(bankReconciledForPeriod(t.ctx, '2026-07-01', '2026-09-30').accounts[0].status, 'reconciled');
});

test('A39-10: the balance AT the period end comes from the covering statement, less what it books later; an empty gap is proven by the next opening', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'SPAN', from: '2026-09-01', to: '2026-10-15', openingMinor: 0, entries: [
    { ref: 'SEP', amountMinor: 1000, cd: 'DBIT', date: '2026-09-20' },
    { ref: 'OCT', amountMinor: 400, cd: 'DBIT', date: '2026-10-05' },
  ] });
  must(bookBankLine(t.ctx, { bankTxnId: lines.SEP, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 1000 }] }, idempotencyKey: 's' }));
  const q3 = bankReconciledForPeriod(t.ctx, '2026-07-01', '2026-09-30');
  assert.equal(q3.accounts[0].bankBalanceMinor, -1000, 'the October line is after the period end');
  assert.equal(q3.accounts[0].status, 'reconciled', JSON.stringify(q3.accounts[0]));
  assert.equal(q3.openLines, 0, 'the October line belongs to Q4');

  // A gap between two statements with no booking in it (the next opens where the last closed).
  const u = world();
  importLines(u, { statementId: 'A', from: '2026-06-01', to: '2026-06-26', openingMinor: 0, closingMinor: 0, entries: [] });
  importLines(u, { statementId: 'B', seqNb: '2', from: '2026-07-01', to: '2026-07-31', openingMinor: 0, closingMinor: 0, entries: [] });
  assert.equal(bankReconciledForPeriod(u.ctx, '2026-06-01', '2026-06-30').accounts[0].status, 'reconciled', 'the weekend gap is proven empty');
});

// --- A39-11 (LOW, decided), probe p13: control accounts ---------------------------------------------

test('A39-11 p13: a hand-typed accounts leg on 1100 or 2000 books, with a warning', () => {
  const t = world();
  const { lines } = importLines(t, { statementId: 'CT', entries: [{ ref: 'A', amountMinor: 5000, cd: 'CRDT' }, { ref: 'B', amountMinor: 5000, cd: 'DBIT' }] });
  const booked = must(bookBankLine(t.ctx, { bankTxnId: lines.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('1100'), amountMinor: 5000 }] }, idempotencyKey: 'a' }));
  assert.deepEqual(booked.warnings, ['control_account_leg']);
  const plain = must(bookBankLine(t.ctx, { bankTxnId: lines.B, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 5000 }] }, idempotencyKey: 'b' }));
  assert.deepEqual(plain.warnings, []);
});

test('A39-11: history never pre-fills a control-account booking', () => {
  const t = world();
  const first = importLines(t, { statementId: 'H1', entries: [{ ref: 'X', amountMinor: 700, cd: 'CRDT', name: 'Kunde Muster AG' }] });
  must(bookBankLine(t.ctx, { bankTxnId: first.lines.X, target: { kind: 'accounts', legs: [{ accountId: t.acc('1100'), amountMinor: 700 }] }, idempotencyKey: 'x' }));
  const next = importLines(t, { statementId: 'H2', seqNb: '2', entries: [{ ref: 'Y', amountMinor: 800, cd: 'CRDT', name: 'Kunde Muster AG' }] });
  assert.notEqual(lineOf(t, next.lines.Y, 'open').proposal.reasonCode, 'history');
});

// --- A39-12 (LOW, decided): acceptDifference matches the direction and states its reason ------------

test('A39-12: acceptDifference needs a reason, refuses the opposite direction, and stays visible in the balance', () => {
  const t = world();
  const out = must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'Zahlung', idempotencyKey: 'o', lines: [{ account: t.acc('6500'), debit: 2400 }, { account: t.acc('1020'), credit: 2400 }] }));
  const inn = must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'Eingang', idempotencyKey: 'i', lines: [{ account: t.acc('1020'), debit: 99999 }, { account: t.acc('3000'), credit: 99999 }] }));
  const { lines } = importLines(t, { statementId: 'AD', entries: [{ ref: 'D', amountMinor: 2500, cd: 'DBIT' }] });
  const before = rowCounts(t.store, t.workspaceId);
  refused(bookBankLine(t.ctx, { bankTxnId: lines.D, target: { kind: 'existing_entry', entryId: out.entryId, acceptDifference: true }, idempotencyKey: 'no-reason' }), 'invalid_input');
  refused(bookBankLine(t.ctx, { bankTxnId: lines.D, target: { kind: 'existing_entry', entryId: out.entryId, acceptDifference: true, differenceReason: '   ' }, idempotencyKey: 'blank' }), 'invalid_input');
  // Money OUT cannot be matched to an entry that brought money IN, whatever the difference.
  const dir = refused(bookBankLine(t.ctx, { bankTxnId: lines.D, target: { kind: 'existing_entry', entryId: inn.entryId, acceptDifference: true, differenceReason: 'egal' }, idempotencyKey: 'dir' }), 'direction_mismatch');
  assert.equal(dir.lineAmountMinor, -2500);
  assert.equal(dir.entryAmountMinor, 99999);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before, 'the refusals moved nothing');
  // Same direction, any amount (owner: flexibility), with the reason recorded.
  const ok = must(bookBankLine(t.ctx, { bankTxnId: lines.D, target: { kind: 'existing_entry', entryId: out.entryId, acceptDifference: true, differenceReason: 'Spesen im Betrag' }, idempotencyKey: 'ok' }));
  assert.equal(ok.differenceMinor, -100);
  assert.equal(lineOf(t, lines.D).decision.note, 'Spesen im Betrag');
  const s = summaryOf(t, t.bankAccountId);
  // L4: the accepted CHF -1.00 stays a difference, and so does the CHF 999.99 entry no line backs.
  assert.equal(s.differenceMinor, -100 - 99999, 'the books really differ from the bank by the accepted amount and the unbacked entry');
});

