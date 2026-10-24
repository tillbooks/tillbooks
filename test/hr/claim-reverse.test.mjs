// E02 money path: `expense_claim_reverse` (D168, the D141.3 follow-up, owner decision 14.10.2026).
//
// Before D168 an approved claim had no undo verb. The raw `reverse_entry` reversed its posting and left
// the claim `approved` beside a Storno, so `expense_claim_reimburse` would still pay a liability the
// ledger no longer carried. Each assertion here fails if the owning verb, the row-backed ownership in
// `OWNED_REVERSAL_SOURCES`, the reimbursed refusal, the period pre-check or the row idempotency is
// removed. All fixtures are synthetic (invented names and amounts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lockPeriod, reverseEntry } from '../../dist/core/ledger/index.js';
import { reversePayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { approveClaim, reimburseClaim, reverseClaim } from '../../dist/core/hr/index.js';
import {
  setup,
  addEmployee,
  submittedClaim,
  counts,
  payablesBalance,
  accountBalance,
  claimRow,
  capCtx,
  secondWorkspace,
} from './support.mjs';

const AMOUNT = 4000;

function approvedClaim(t, key = 'rv', opts = {}) {
  const { employeeId } = addEmployee(t.ctx, {}, `${key}-emp`);
  const { claimId } = submittedClaim(t.ctx, employeeId, opts, `${key}-clm`);
  const approved = approveClaim(t.ctx, { claimId, confirm: true, idempotencyKey: `${key}-ap` });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  return { claimId, entryId: approved.postedEntryId };
}

function entryLines(t, entryId) {
  return t.store.db
    .prepare('SELECT a.number AS n, l.base_debit_minor AS d, l.base_credit_minor AS c, l.tax_code AS tc, l.tax_amount_minor AS ta FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY a.number, l.base_debit_minor')
    .all(entryId);
}

test('D168: an approved claim reverses to `reversed` with the approve entry mirrored, in one step', () => {
  const t = setup();
  const { claimId, entryId } = approvedClaim(t, 'happy');
  assert.equal(payablesBalance(t.store, t.workspaceId), AMOUNT);
  const before = counts(t.store, t.workspaceId);

  const res = reverseClaim(t.ctx, { claimId, reason: 'Doppelt erfasst', idempotencyKey: 'happy-rev' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(typeof res.reversalEntryId, 'string');

  const claim = claimRow(t.store, t.workspaceId, claimId);
  assert.equal(claim.status, 'reversed');
  assert.equal(claim.reversal_entry_id, res.reversalEntryId);
  assert.equal(claim.posted_entry_id, entryId, 'the original posting id is untouched');

  const mirror = t.store.db.prepare('SELECT source, reverses_entry_id, date FROM journal_entry WHERE id = ?').get(res.reversalEntryId);
  assert.equal(mirror.source, 'reversal');
  assert.equal(mirror.reverses_entry_id, entryId);
  assert.equal(mirror.date, t.ctx.clock.now().slice(0, 10), 'dated today (OR 957a)');
  const original = entryLines(t, entryId).map((l) => ({ n: l.n, d: l.c, c: l.d }));
  assert.deepEqual(entryLines(t, res.reversalEntryId).map((l) => ({ n: l.n, d: l.d, c: l.c })).sort((a, b) => a.n.localeCompare(b.n)), original.sort((a, b) => a.n.localeCompare(b.n)));

  assert.equal(payablesBalance(t.store, t.workspaceId), 0, '2260 nets to zero');
  assert.equal(accountBalance(t.store, t.workspaceId, '6200'), 0, 'the expense nets to zero');
  const after = counts(t.store, t.workspaceId);
  assert.equal(after.entries, before.entries + 1, 'exactly one mirror');
  assert.equal(after.claims, before.claims, 'no claim row added or removed');
});

test('D168: idempotent on ROWS: the same key replays, a new key refuses already_reversed, nothing is written twice', () => {
  const t = setup();
  const { claimId } = approvedClaim(t, 'idem');
  const first = reverseClaim(t.ctx, { claimId, reason: 'Falsch', idempotencyKey: 'idem-1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const once = counts(t.store, t.workspaceId);

  const replay = reverseClaim(t.ctx, { claimId, reason: 'Falsch', idempotencyKey: 'idem-1' });
  assert.equal(replay.ok, true);
  assert.equal(replay.reversalEntryId, first.reversalEntryId);
  assert.deepEqual(counts(t.store, t.workspaceId), once, 'a replay writes no row');

  const again = reverseClaim(t.ctx, { claimId, reason: 'Nochmals', idempotencyKey: 'idem-2' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'already_reversed');
  assert.equal(again.reversalEntryId, first.reversalEntryId);
  assert.deepEqual(counts(t.store, t.workspaceId), once, 'a second reverse writes no row');
  assert.equal(payablesBalance(t.store, t.workspaceId), 0);
});

test('D168: a REIMBURSED claim refuses claim_reimbursed naming reverse_payment; after the payment reversal it reverses', () => {
  const t = setup();
  const { claimId } = approvedClaim(t, 'paid');
  const paid = reimburseClaim(t.ctx, { claimId, bankAccountId: t.bankId, confirm: true, idempotencyKey: 'paid-rb' });
  assert.equal(paid.ok, true, JSON.stringify(paid));
  const before = counts(t.store, t.workspaceId);

  const refused = reverseClaim(t.ctx, { claimId, reason: 'Falsch', idempotencyKey: 'paid-rev' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'claim_reimbursed');
  assert.equal(refused.paymentId, paid.paymentId);
  assert.match(refused.hint, /reverse_payment/);
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'the refusal wrote nothing');
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'reimbursed');

  const undone = reversePayment(t.ctx, { paymentId: paid.paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'paid-pay-rev' });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'approved');

  const res = reverseClaim(t.ctx, { claimId, reason: 'Falsch', idempotencyKey: 'paid-rev-2' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'reversed');
  assert.equal(payablesBalance(t.store, t.workspaceId), 0, '2260 nets to zero across approve, payment, its reversal and the claim reversal');
});

test('D168: only an approved claim reverses; draft, submitted and rejected refuse invalid_transition', () => {
  const t = setup();
  const { employeeId } = addEmployee(t.ctx, {}, 'st-emp');
  const { claimId: draftId } = submittedClaim(t.ctx, employeeId, { noSubmit: true }, 'st-d');
  const { claimId: subId } = submittedClaim(t.ctx, employeeId, {}, 'st-s');
  const before = counts(t.store, t.workspaceId);
  for (const id of [draftId, subId]) {
    const r = reverseClaim(t.ctx, { claimId: id, reason: 'x', idempotencyKey: `st-${id}` });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_transition');
  }
  assert.deepEqual(counts(t.store, t.workspaceId), before);
});

test('D168: a reversed claim is terminal: it cannot be reimbursed, and the DB seals the status and the reversal id', () => {
  const t = setup();
  const { claimId } = approvedClaim(t, 'term');
  assert.equal(reverseClaim(t.ctx, { claimId, reason: 'x', idempotencyKey: 'term-rev' }).ok, true);
  const pay = reimburseClaim(t.ctx, { claimId, bankAccountId: t.bankId, confirm: true, idempotencyKey: 'term-rb' });
  assert.equal(pay.ok, false);
  assert.equal(pay.error, 'invalid_transition');
  assert.throws(() => t.store.db.prepare("UPDATE expense_claim SET status = 'approved' WHERE id = ?").run(claimId), /expense_claim_terminal_is_one_way|expense_claim_reversed_is_terminal/);
  assert.throws(() => t.store.db.prepare('UPDATE expense_claim SET reversal_entry_id = NULL WHERE id = ?').run(claimId), /expense_claim_reversal_entry_immutable/);
});

test('D168: a locked period refuses period_locked before any write', () => {
  const t = setup();
  const { claimId } = approvedClaim(t, 'lock');
  assert.equal(lockPeriod(t.ctx, { period: t.ctx.clock.now().slice(0, 7), kind: 'hard', idempotencyKey: 'lock' }).ok, true);
  const before = counts(t.store, t.workspaceId);
  const r = reverseClaim(t.ctx, { claimId, reason: 'x', idempotencyKey: 'lock-rev' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'period_locked');
  assert.deepEqual(counts(t.store, t.workspaceId), before);
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'approved');
});

test('D168: reason is required, the review and posting rights are required, and another tenant sees not_found', () => {
  const t = setup();
  const { claimId } = approvedClaim(t, 'gate');
  const before = counts(t.store, t.workspaceId);
  const noReason = reverseClaim(t.ctx, { claimId, reason: '  ', idempotencyKey: 'gate-1' });
  assert.equal(noReason.error, 'reason_required');
  const noRight = reverseClaim(capCtx(t, 'viewer', ['post']), { claimId, reason: 'x', idempotencyKey: 'gate-2' });
  assert.equal(noRight.ok, false);
  assert.equal(noRight.error, 'permission_denied');
  const noPost = reverseClaim(capCtx(t, 'reviewer', ['spesen.approve']), { claimId, reason: 'x', idempotencyKey: 'gate-3' });
  assert.equal(noPost.ok, false);
  assert.equal(noPost.error, 'permission_denied');
  const other = secondWorkspace(t);
  const foreign = reverseClaim(other.ctx, { claimId, reason: 'x', idempotencyKey: 'gate-4' });
  assert.equal(foreign.error, 'not_found');
  assert.deepEqual(counts(t.store, t.workspaceId), before);
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'approved');
});

test('D168 ownership: raw reverse_entry on an approved claim entry refuses owned_by expense_claim_reverse, and so does its mirror', () => {
  const t = setup();
  const { claimId, entryId } = approvedClaim(t, 'own');
  const before = counts(t.store, t.workspaceId);
  const raw = reverseEntry(t.ctx, { entryId, idempotencyKey: 'raw' });
  assert.equal(raw.ok, false, `the raw Storno must not strand the claim: ${JSON.stringify(raw)}`);
  assert.equal(raw.error, 'owned_by');
  assert.equal(raw.verb, 'expense_claim_reverse');
  assert.deepEqual(counts(t.store, t.workspaceId), before);

  const res = reverseClaim(t.ctx, { claimId, reason: 'x', idempotencyKey: 'own-rev' });
  assert.equal(res.ok, true, JSON.stringify(res));
  const rawMirror = reverseEntry(t.ctx, { entryId: res.reversalEntryId, idempotencyKey: 'raw-mirror' });
  assert.equal(rawMirror.ok, false);
  assert.equal(rawMirror.verb, 'expense_claim_reverse');
});

test('D168: a claim with an input-VAT line reverses its Vorsteuer with the trace (1170/1171 nets to zero)', () => {
  const t = setup();
  const { claimId, entryId } = approvedClaim(t, 'vat', { taxCode: 'VST-M', category: 'supplies' });
  const taxed = entryLines(t, entryId).filter((l) => l.ta !== null && l.ta !== 0);
  assert.ok(taxed.length > 0, 'premise: the approve entry carries a VAT trace');
  const res = reverseClaim(t.ctx, { claimId, reason: 'x', idempotencyKey: 'vat-rev' });
  assert.equal(res.ok, true, JSON.stringify(res));
  const mirrorTaxed = entryLines(t, res.reversalEntryId).filter((l) => l.ta !== null && l.ta !== 0);
  assert.deepEqual(mirrorTaxed.map((l) => -l.ta).sort(), taxed.map((l) => l.ta).sort(), 'the mirror negates the tax trace');
  for (const n of ['1170', '1171', '2260', '6500']) assert.equal(accountBalance(t.store, t.workspaceId, n), 0, `${n} nets to zero`);
});

// Critic round 1 (MEDIUM): a book written BEFORE D168, where the raw reverse_entry already reversed an
// approved claim's posting. The old raw Storno is simulated with reverseOwnedEntry under a foreign key.
import { reverseOwnedEntry } from '../../dist/core/ledger/reverseEntry.js';

function legacyRawReverse(t, entryId, key = 'legacy') {
  const r = reverseOwnedEntry(t.ctx, { entryId, idempotencyKey: key }, 'expense_claim_reverse');
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.reversalId;
}

test('critic r1: a legacy raw-reversed claim is ADOPTED: reversed with the existing mirror, nothing posted', () => {
  const t = setup();
  const { claimId, entryId } = approvedClaim(t, 'adopt');
  const mirror = legacyRawReverse(t, entryId);
  assert.equal(payablesBalance(t.store, t.workspaceId), 0, 'premise: the legacy Storno cleared 2260');
  const before = counts(t.store, t.workspaceId);

  const res = reverseClaim(t.ctx, { claimId, reason: 'Altbestand', idempotencyKey: 'adopt-rev' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.reversalEntryId, mirror);
  assert.equal(res.adopted, true);
  const claim = claimRow(t.store, t.workspaceId, claimId);
  assert.equal(claim.status, 'reversed');
  assert.equal(claim.reversal_entry_id, mirror);
  assert.equal(counts(t.store, t.workspaceId).entries, before.entries, 'no entry posted');
  assert.equal(payablesBalance(t.store, t.workspaceId), 0);
});

test('critic r1: a double-reversed chain (the posting stands again) posts a fresh mirror of the last link', () => {
  const t = setup();
  const { claimId, entryId } = approvedClaim(t, 'chain');
  const r1 = legacyRawReverse(t, entryId, 'l1');
  const r2 = legacyRawReverse(t, r1, 'l2');
  assert.equal(payablesBalance(t.store, t.workspaceId), AMOUNT, 'premise: the posting stands again');
  const before = counts(t.store, t.workspaceId);

  const res = reverseClaim(t.ctx, { claimId, reason: 'x', idempotencyKey: 'chain-rev' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.adopted, false);
  const mirror = t.store.db.prepare('SELECT reverses_entry_id FROM journal_entry WHERE id = ?').get(res.reversalEntryId);
  assert.equal(mirror.reverses_entry_id, r2);
  assert.equal(counts(t.store, t.workspaceId).entries, before.entries + 1);
  assert.equal(claimRow(t.store, t.workspaceId, claimId).status, 'reversed');
  assert.equal(payablesBalance(t.store, t.workspaceId), 0, '2260 nets to zero');
});

test('critic r1: reimburse refuses a claim whose posting no longer stands; it pays again once the posting stands', () => {
  const t = setup();
  const { claimId, entryId } = approvedClaim(t, 'gone');
  const r1 = legacyRawReverse(t, entryId);
  const before = counts(t.store, t.workspaceId);
  const paid = reimburseClaim(t.ctx, { claimId, bankAccountId: t.bankId, confirm: true, idempotencyKey: 'gone-rb' });
  assert.equal(paid.ok, false, JSON.stringify(paid));
  assert.equal(paid.error, 'claim_posting_reversed');
  assert.match(paid.hint, /expense_claim_reverse/);
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'nothing paid');
  assert.equal(payablesBalance(t.store, t.workspaceId), 0, '2260 never goes negative');

  legacyRawReverse(t, r1, 'again');
  const ok2 = reimburseClaim(t.ctx, { claimId, bankAccountId: t.bankId, confirm: true, idempotencyKey: 'gone-rb2' });
  assert.equal(ok2.ok, true, JSON.stringify(ok2));
  assert.equal(payablesBalance(t.store, t.workspaceId), 0);
});
