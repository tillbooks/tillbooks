/**
 * A36 §4.7 (D150), THE ONE HUMAN ACT THAT MAY CLOSE A STATEMENT GAP WITHOUT A STATEMENT: the
 * confirmation that nothing is missing, and its withdrawal.
 *
 * THE RULE (owner, 01.10.2026). Only a person, never an agent alone; only when the balances chain;
 * only while the gap is open in the book and no downloaded statement waits inside it; always with a
 * reason. Append-only (`bank_statement_gap_ack`, triggers refuse UPDATE and DELETE); the latest row
 * decides. Changes no statement and posts nothing; a statement found later still imports by rule 3.
 *
 * A module of its own (critic round 2 LOW 2) so it can read the EBICS channel's waiting statements
 * itself: the read model (`statementGaps.ts`) is imported BY the channel and so cannot import it back.
 * §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import { err, ok } from '../result.js';
import type { Result } from '../result.js';
import { isGovernedSeat } from '../access/capability.js';
import { pendingGapStatements } from './ebics/channel.js';
import { STATEMENT_GAP_ACK_ACTIONS, accountStatementGaps, confirmedPairs } from './statementGaps.js';
import type { PendingGapStatement, StatementGapWithState } from './statementGaps.js';

/** Hoisted, so the audit-vocabulary scraper reads the kind through the const it resolves. */
const STATEMENT_GAP_ENTITY_KIND = 'bank_statement_gap';

export interface ConfirmStatementGapInput {
  bankAccountId?: unknown;
  afterStatementId?: unknown;
  beforeStatementId?: unknown;
  reason?: unknown;
  confirmed?: unknown;
  idempotencyKey?: unknown;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** The input checks both verbs share; null when the input is usable. */
function guardAck(ctx: WorkspaceContext, input: ConfirmStatementGapInput): Result | null {
  const capable = ctx.capabilities.assert('pay');
  if (!capable.ok) return capable;
  for (const field of ['bankAccountId', 'afterStatementId', 'beforeStatementId', 'idempotencyKey'] as const) {
    if (!nonEmpty(input[field])) return err('invalid_input', { field });
  }
  if (!nonEmpty(input.reason)) return err('invalid_input', { field: 'reason', reason: 'say why nothing is missing (or why the confirmation is withdrawn)' });
  // Never an agent alone: an agent seat proposes (A35 drafts the call), a person approves, and the
  // approval runs the verb as that person.
  if (isGovernedSeat(ctx.store, ctx.actor)) {
    return err('human_only', { reason: 'a person confirms a statement gap; an agent may only propose it' });
  }
  if (input.confirmed !== true) {
    return err('needs_confirmation', { reason: 'a person at the button confirms this: pass confirmed=true' });
  }
  const account = ctx.store.db
    .prepare('SELECT id FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.bankAccountId) as { id: string } | undefined;
  if (account === undefined) return err('not_found', { bankAccountId: input.bankAccountId });
  return null;
}

function findGap(ctx: WorkspaceContext, input: ConfirmStatementGapInput, pending: readonly PendingGapStatement[]): StatementGapWithState | undefined {
  return accountStatementGaps(ctx, input.bankAccountId as string, pending).find(
    (g) => g.source === 'book' && g.after.statementRowId === input.afterStatementId && g.before.statementRowId === input.beforeStatementId,
  );
}

function appendAck(
  ctx: WorkspaceContext,
  input: ConfirmStatementGapInput,
  action: (typeof STATEMENT_GAP_ACK_ACTIONS)[number],
  gap: StatementGapWithState,
): string {
  const id = ctx.ids.next('bsga');
  const now = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO bank_statement_gap_ack
         (id, workspace_id, bank_account_id, after_statement_id, before_statement_id, action, reason, difference_minor, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.workspaceId,
      input.bankAccountId,
      input.afterStatementId,
      input.beforeStatementId,
      action,
      (input.reason as string).trim(),
      gap.differenceMinor,
      ctx.actor,
      now,
    );
  ctx.audit.record({ entityKind: STATEMENT_GAP_ENTITY_KIND, entityId: gap.gapId, action, actor: ctx.actor, at: now });
  return id;
}

function gapView(gap: StatementGapWithState): Record<string, unknown> {
  return {
    gapId: gap.gapId,
    bankAccountId: gap.bankAccountId,
    after: { number: gap.after.number, year: gap.after.year, fromDate: gap.after.fromDate },
    before: { number: gap.before.number, year: gap.before.year, fromDate: gap.before.fromDate },
    missing: gap.missing,
  };
}

/**
 * `confirm_statement_gap`: a person says nothing is missing in a gap whose balances chain. Refuses an
 * unchained gap (`gap_not_chained`, naming the amount), a gap that is not open in the book any more
 * (`gap_not_found`: it was filled, or the ids name no neighbouring pair), and an agent seat
 * (`human_only`). Idempotent per key, and a gap already confirmed answers `alreadyConfirmed` without a
 * second row. Appends one `bank_statement_gap_ack` row and its audit entry; changes no statement.
 *
 * The channel's downloaded statements refused as `gap_refused` are read HERE (critic H1, and round 2
 * LOW 2: no caller can forget them): a gap with such a statement inside is refused
 * `gap_has_waiting_statement`, because that statement proves money the books do not explain.
 */
export function confirmStatementGap(ctx: WorkspaceContext, input: ConfirmStatementGapInput): Result {
  const bad = guardAck(ctx, input);
  if (bad !== null) return bad;
  const scopedKey = JSON.stringify(['confirm_statement_gap', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'confirm_statement_gap');
  if (replayed !== undefined) return replayed;

  const gap = findGap(ctx, input, pendingGapStatements(ctx));
  if (gap === undefined) {
    return err('gap_not_found', {
      bankAccountId: input.bankAccountId,
      afterStatementId: input.afterStatementId,
      beforeStatementId: input.beforeStatementId,
      reason: 'no open gap between these two statements: it was filled, or they are not neighbours in the book',
    });
  }
  if (gap.refused.length > 0) {
    return err('gap_has_waiting_statement', {
      ...gapView(gap),
      waiting: gap.refused.map((r) => ({ number: r.number, year: r.year, fromDate: r.fromDate, differenceMinor: r.differenceMinor })),
      reason: 'a downloaded statement inside this gap does not chain: it proves money the books do not explain, so the gap cannot be confirmed; import the missing statements',
    });
  }
  if (!gap.chains) {
    return err('gap_not_chained', {
      ...gapView(gap),
      differenceMinor: gap.differenceMinor,
      currency: gap.currency,
      reason: 'the missing statements carry money that is not in the books yet: import them, a gap with an unexplained amount cannot be confirmed',
    });
  }
  if (gap.confirmed) return ok({ ...gapView(gap), confirmed: true, alreadyConfirmed: true });
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'confirm_statement_gap', () => {
    const ackId = appendAck(ctx, input, 'confirm', gap);
    return ok({ ...gapView(gap), confirmed: true, ackId });
  });
}

/**
 * `revoke_statement_gap_confirmation`: withdraw a confirmation, so the gap is an attention item again.
 * Appends a `revoke` row (the confirm row stays); a gap that is not confirmed answers `notConfirmed`
 * without a row. Idempotent per key; a person only.
 */
export function revokeStatementGapConfirmation(ctx: WorkspaceContext, input: ConfirmStatementGapInput): Result {
  const bad = guardAck(ctx, input);
  if (bad !== null) return bad;
  const scopedKey = JSON.stringify(['revoke_statement_gap_confirmation', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'revoke_statement_gap_confirmation');
  if (replayed !== undefined) return replayed;
  const gap = findGap(ctx, input, pendingGapStatements(ctx));
  if (gap === undefined) {
    return err('gap_not_found', {
      bankAccountId: input.bankAccountId,
      afterStatementId: input.afterStatementId,
      beforeStatementId: input.beforeStatementId,
      reason: 'no gap between these two statements in the book any more',
    });
  }
  // Critic round 2 LOW 1: the withdrawal acts on the LATEST ack row, whatever waits in the gap now: a
  // confirmation a refused statement made void must still be withdrawable, or it would hide the gap
  // again once that statement is gone (a retired channel).
  if (!confirmedPairs(ctx, input.bankAccountId as string).has(gap.gapId)) return ok({ ...gapView(gap), confirmed: false, notConfirmed: true });
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'revoke_statement_gap_confirmation', () => {
    const ackId = appendAck(ctx, input, 'revoke', gap);
    return ok({ ...gapView(gap), confirmed: false, ackId });
  });
}
