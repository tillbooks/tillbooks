// A36 §4.7 (D150), THE CONFIRMATION THAT A STATEMENT GAP HOLDS NOTHING. The owner's rule, asserted:
// only a person (never an agent seat), only a gap whose balances chain, only while it is open in the
// book, always with a reason; append-only and revocable; idempotent; fenced by workspace. A statement
// found later still imports (rule 3), whatever was confirmed.
//
// Synthetic fixtures only (`ebics-support.mjs`). Money-path invariant tests are reviewed by a
// non-author (CLAUDE.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup, withoutCapability } from './support.mjs';
import { syntheticIban, camt053 } from './ebics-support.mjs';
import {
  createBankAccount,
  statementGaps,
  confirmStatementGap,
  revokeStatementGapConfirmation,
} from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { makeContext } from '../../dist/core/context.js';
import { DIAL_CAPABILITY_FOR_ACTION } from '../../dist/core/agent/dialMap.js';
import { NOT_AUTOMATABLE } from '../../dist/core/automation/denylist.js';

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

let seq = 0;
function account(t, n) {
  seq += 1;
  return must(
    createBankAccount(t.ctx, { name: `Konto ${n}`, iban: syntheticIban(n), ledgerAccountId: t.acc('1020'), idempotencyKey: `ba-${n}-${seq}` }),
    'create_bank_account',
  ).bankAccountId;
}

function imp(t, bankAccountId, xml) {
  seq += 1;
  return must(importCamt(t.ctx, { bankAccountId, xml, idempotencyKey: `imp-${seq}` }), 'import');
}

/** Statements 1 and 4 in the books; `drift` moves 4's opening off 1's close (an unchained gap). */
function gapBook(t, n, drift = 0) {
  const id = account(t, n);
  const iban = syntheticIban(n);
  const s1 = imp(t, id, camt053({ iban, seq: 1, date: '2026-06-01', opening: 40000, entries: [{ minor: 1000 }] }));
  const s4 = imp(t, id, camt053({ iban, seq: 4, date: '2026-06-04', opening: 41000 + drift }));
  return { id, iban, input: { bankAccountId: id, afterStatementId: s1.statementId, beforeStatementId: s4.statementId } };
}

function acks(t) {
  return t.store.db.prepare('SELECT * FROM bank_statement_gap_ack WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId);
}

test('a chained gap is confirmed by a person with a reason: one row, the gap leaves the read model, a replay adds nothing', () => {
  // The real ledger ports, so the A03 audit chain records the act.
  const t = setup({ realPeriods: true });
  const g = gapBook(t, 41);
  assert.equal(statementGaps(t.ctx).length, 1);
  const confirmed = must(confirmStatementGap(t.ctx, { ...g.input, reason: 'Tage ohne Buchung', confirmed: true, idempotencyKey: 'c-1' }), 'confirm');
  assert.equal(confirmed.confirmed, true);
  assert.deepEqual(confirmed.missing, [{ year: 2026, from: 2, to: 3 }]);
  assert.deepEqual(statementGaps(t.ctx), [], 'a confirmed gap is not open any more');
  const rows = acks(t);
  assert.deepEqual(rows.map((r) => [r.action, r.reason, r.difference_minor, r.actor]), [['confirm', 'Tage ohne Buchung', 0, 'user_1']]);

  // The same key replays the first answer; a new key on a confirmed gap writes no second row.
  assert.deepEqual(confirmStatementGap(t.ctx, { ...g.input, reason: 'Tage ohne Buchung', confirmed: true, idempotencyKey: 'c-1' }), confirmed);
  const again = must(confirmStatementGap(t.ctx, { ...g.input, reason: 'nochmals', confirmed: true, idempotencyKey: 'c-2' }), 'again');
  assert.equal(again.alreadyConfirmed, true);
  assert.equal(acks(t).length, 1);
  // The audit chain names the act.
  const audit = t.store.db.prepare("SELECT action FROM audit_log WHERE workspace_id = ? AND entity_kind = 'bank_statement_gap'").all(t.workspaceId);
  assert.deepEqual(audit.map((a) => a.action), ['confirm']);
});

test('an unchained gap can never be confirmed away, and nothing is written', () => {
  const t = setup();
  const g = gapBook(t, 42, 500);
  const refused = confirmStatementGap(t.ctx, { ...g.input, reason: 'sollte stimmen', confirmed: true, idempotencyKey: 'u-1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'gap_not_chained');
  assert.equal(refused.differenceMinor, 500);
  assert.equal(acks(t).length, 0);
  assert.equal(statementGaps(t.ctx).length, 1, 'the gap stays an item');
  // The refusal is not memoised: the same key is still refused for the same reason.
  assert.equal(confirmStatementGap(t.ctx, { ...g.input, reason: 'sollte stimmen', confirmed: true, idempotencyKey: 'u-1' }).error, 'gap_not_chained');
});

test('never an agent alone: a governed seat is refused, the dial governs it, no rule fires it', () => {
  const t = setup();
  const g = gapBook(t, 43);
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  const res = confirmStatementGap(agentCtx, { ...g.input, reason: 'leer', confirmed: true, idempotencyKey: 'a-1' });
  assert.equal(res.error, 'human_only');
  assert.equal(revokeStatementGapConfirmation(agentCtx, { ...g.input, reason: 'leer', confirmed: true, idempotencyKey: 'a-2' }).error, 'human_only');
  assert.equal(acks(t).length, 0);
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.confirm_statement_gap, 'pay');
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.revoke_statement_gap_confirmation, 'pay');
  assert.ok(NOT_AUTOMATABLE.has('confirm_statement_gap') && NOT_AUTOMATABLE.has('revoke_statement_gap_confirmation'));
});

test('the person at the button confirms, with a reason, holding pay', () => {
  const t = setup();
  const g = gapBook(t, 44);
  assert.equal(confirmStatementGap(t.ctx, { ...g.input, reason: 'leer', idempotencyKey: 'n-1' }).error, 'needs_confirmation');
  assert.equal(confirmStatementGap(t.ctx, { ...g.input, reason: '   ', confirmed: true, idempotencyKey: 'n-2' }).error, 'invalid_input');
  assert.equal(confirmStatementGap(withoutCapability(t, 'pay'), { ...g.input, reason: 'leer', confirmed: true, idempotencyKey: 'n-3' }).error, 'permission_denied');
  assert.equal(acks(t).length, 0);
});

test('append-only and revocable: a withdrawal adds a row beside the confirmation, and the gap waits again', () => {
  const t = setup();
  const g = gapBook(t, 45);
  must(confirmStatementGap(t.ctx, { ...g.input, reason: 'leer', confirmed: true, idempotencyKey: 'r-1' }), 'confirm');
  const before = acks(t);
  const revoked = must(revokeStatementGapConfirmation(t.ctx, { ...g.input, reason: 'Buchung gefunden', confirmed: true, idempotencyKey: 'r-2' }), 'revoke');
  assert.equal(revoked.confirmed, false);
  const after = acks(t);
  assert.deepEqual(after.slice(0, 1), before, 'the confirm row is untouched');
  assert.deepEqual(after.map((r) => r.action), ['confirm', 'revoke']);
  assert.equal(statementGaps(t.ctx).length, 1, 'the gap is open again');
  // Revoking an unconfirmed gap writes nothing; confirming again is a third row.
  assert.equal(must(revokeStatementGapConfirmation(t.ctx, { ...g.input, reason: 'x', confirmed: true, idempotencyKey: 'r-3' }), 'noop').notConfirmed, true);
  must(confirmStatementGap(t.ctx, { ...g.input, reason: 'doch leer', confirmed: true, idempotencyKey: 'r-4' }), 'reconfirm');
  assert.deepEqual(acks(t).map((r) => r.action), ['confirm', 'revoke', 'confirm']);
});

test('a statement found later still imports into a confirmed gap, and a filled gap cannot be confirmed', () => {
  const t = setup();
  const g = gapBook(t, 46);
  must(confirmStatementGap(t.ctx, { ...g.input, reason: 'leer', confirmed: true, idempotencyKey: 'f-1' }), 'confirm');
  // Statement 2 turns up after all: it imports (the confirmation hides the item, it admits nothing).
  imp(t, g.id, camt053({ iban: g.iban, seq: 2, date: '2026-06-02', opening: 41000 }));
  const gaps = statementGaps(t.ctx);
  assert.deepEqual(gaps.map((x) => [x.after.number, x.before.number]), [[2, 4]], 'the new neighbours 2 and 4 are a new, unconfirmed gap');
  // The old pair (1, 4) is no longer a gap in the book.
  assert.equal(confirmStatementGap(t.ctx, { ...g.input, reason: 'x', confirmed: true, idempotencyKey: 'f-2' }).error, 'gap_not_found');
});

test('§H-TENANT: another workspace can neither see nor confirm the gap', () => {
  const t = setup();
  const g = gapBook(t, 47);
  const other = createWorkspace(t.deps, { name: 'Fremde Synthetik AG' }).workspaceId;
  const otherCtx = makeContext(t.store, { workspaceId: other, actor: 'user_1', clock: t.clock, ids: t.ids });
  assert.equal(confirmStatementGap(otherCtx, { ...g.input, reason: 'leer', confirmed: true, idempotencyKey: 'x-1' }).error, 'not_found');
  assert.equal(acks(t).length, 0);
  assert.equal(statementGaps(t.ctx).length, 1);
});
