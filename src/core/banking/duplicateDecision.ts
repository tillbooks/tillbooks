/**
 * D178 point 19 (owner, 21.10.2026; spec A20 §11.4): `resolve_possible_duplicate`, the person's answer to a
 * line flagged as a possible duplicate (a line another delivery or another format may already have brought
 * in, or a new line on days the books already hold a statement for).
 *
 *  - `duplicate` ("Duplikat"): the line IS a movement already in the books. It is ignored with the existing
 *    reason `duplicate` (`ignore_bank_line`, so the line leaves the inbox and every count, and
 *    `reopen_bank_line` brings it back; reopened, it needs a decision again). The ignore is written FIRST,
 *    then the answer.
 *  - `distinct` ("Kein Duplikat"): the line is its own movement and a normal line again: proposed, counted,
 *    bookable like any other.
 *
 * ONE LINE: `{ bankTxnId, decision, otherBankTxnId?, note? }`. ONE DELIVERY AT ONCE (the round 3 re-cut, so
 * `ask` stays usable when a whole month is imported again): `{ statementId, scope: 'one_to_one_matches',
 * decision: 'duplicate' }` answers every open line of that delivery (`statementId` is the `bank_statement`
 * id an import answers) that waits for its answer and was matched one to one on its movement
 * (`same_movement`): each line gets its own ignore and its own answer row.
 *
 * Every answer is recorded append-only (who, when, the line judged against); the latest is in force. A
 * re-import never touches it. Governed like `ignore_bank_line` (the `post` dial): an agent may propose an
 * answer, a person approves it.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { requireString, optionalText, optionalId } from '../ledger/inputGuards.js';
import { readBankTxn, lineStateOf } from './bankLines.js';
import { ignoreBankLine } from './bankBooking.js';
import { DUPLICATE_DECISIONS, DUPLICATE_PENDING_SQL, readDuplicateCandidatesMap, readPossibleDuplicateMap } from './statementDedupe.js';
import type { DuplicateDecision } from './statementDedupe.js';

/** The bulk scopes (closed, §H-ENUM): every one-to-one movement match of one delivery. */
export const DUPLICATE_DECISION_SCOPES = ['one_to_one_matches'] as const;

export interface ResolvePossibleDuplicateInput {
  /** One line. */
  bankTxnId?: string;
  /** Or one delivery (with `scope`): the `bank_statement` id an import answered. */
  statementId?: string;
  scope?: string;
  decision?: string;
  /** The candidate the person judged the line against (one of its `possibleDuplicates`), optional. */
  otherBankTxnId?: string;
  note?: string;
  idempotencyKey?: string;
}

export type ResolvePossibleDuplicateOk = {
  bankTxnId: string;
  decision: DuplicateDecision;
  otherBankTxnId: string | null;
  /** The line's state after the answer: `ignored` for a duplicate, `open` for a distinct line. */
  state: 'ignored' | 'open';
  /** The ignore's decision link (a duplicate), else null. */
  linkId: string | null;
  decidedBy: string;
  decidedAt: string;
};

/** The answer to one delivery at once: each line decided, with the line it is a duplicate of. */
export type ResolveDeliveryDuplicatesOk = {
  statementId: string;
  scope: 'one_to_one_matches';
  decision: 'duplicate';
  decided: { bankTxnId: string; otherBankTxnId: string | null; linkId: string | null }[];
  count: number;
  decidedBy: string;
  decidedAt: string;
};

const MAX_NOTE = 500;

/** Carries a refusal out of the memoised transaction, so it rolls back and is never memoised. */
class DecisionAbort extends Error {
  constructor(readonly result: Err) {
    super('duplicate-decision-abort');
  }
}

type Screened =
  | { kind: 'one'; bankTxnId: string; decision: DuplicateDecision; other: string | null }
  | { kind: 'delivery'; statementId: string; lines: { bankTxnId: string; other: string | null }[] };

/** The checks the verb makes before it writes, shared with its pre-draft screen. */
function screen(ctx: WorkspaceContext, input: ResolvePossibleDuplicateInput): Err | Screened {
  const guard =
    requireString(input.decision, 'decision') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalId(input.bankTxnId, 'bankTxnId') ??
    optionalId(input.statementId, 'statementId') ??
    optionalText(input.scope, 'scope') ??
    optionalId(input.otherBankTxnId, 'otherBankTxnId') ??
    optionalText(input.note, 'note');
  if (guard) return guard;
  if (!(DUPLICATE_DECISIONS as readonly string[]).includes(input.decision as string)) {
    return err('invalid_input', { field: 'decision', allowed: [...DUPLICATE_DECISIONS] });
  }
  if (typeof input.note === 'string' && input.note.length > MAX_NOTE) return err('invalid_input', { field: 'note', maxLength: MAX_NOTE });
  if ((input.bankTxnId === undefined) === (input.statementId === undefined)) {
    return err('invalid_input', { field: 'bankTxnId', reason: 'name exactly one: bankTxnId (one line) or statementId with scope (one delivery)' });
  }
  if (input.statementId !== undefined) return screenDelivery(ctx, input);

  const row = readBankTxn(ctx, input.bankTxnId as string);
  if (row === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
  if (!readPossibleDuplicateMap(ctx, [row.id]).has(row.id)) {
    return err('not_flagged', { bankTxnId: row.id, reason: 'nothing names this line as a possible duplicate: book or ignore it as usual' });
  }
  const state = lineStateOf(ctx, row).state;
  if (state !== 'open') {
    return err('line_not_open', { bankTxnId: row.id, state, reason: `the line is ${state}; reopen it first to decide again` });
  }
  const other = input.otherBankTxnId ?? null;
  if (other !== null) {
    const candidates = readDuplicateCandidatesMap(ctx, [row.id]).get(row.id) ?? [];
    if (!candidates.some((c) => c.bankTxnId === other)) {
      return err('invalid_input', { field: 'otherBankTxnId', reason: 'not one of the lines this line is named against', allowed: candidates.map((c) => c.bankTxnId) });
    }
  }
  return { kind: 'one', bankTxnId: row.id, decision: input.decision as DuplicateDecision, other };
}

/** One delivery: its open lines waiting for their answer that coverage matched one to one. §H-TENANT. */
function screenDelivery(ctx: WorkspaceContext, input: ResolvePossibleDuplicateInput): Err | Screened {
  if (input.scope === undefined || !(DUPLICATE_DECISION_SCOPES as readonly string[]).includes(input.scope)) {
    return err('invalid_input', { field: 'scope', allowed: [...DUPLICATE_DECISION_SCOPES] });
  }
  if (input.decision !== 'duplicate') {
    return err('invalid_input', { field: 'decision', reason: 'one delivery at once answers duplicate only: a distinct line is decided one by one', allowed: ['duplicate'] });
  }
  if (input.otherBankTxnId !== undefined) return err('invalid_input', { field: 'otherBankTxnId', reason: 'one delivery at once names each line’s own match' });
  const statement = ctx.store.db
    .prepare('SELECT id FROM bank_statement WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.statementId) as { id: string } | undefined;
  if (statement === undefined) return err('not_found', { statementId: input.statementId });
  const rows = ctx.store.db
    .prepare(
      `SELECT t.id, pd.existing_bank_txn_id AS other FROM bank_txn t
         JOIN bank_txn_possible_duplicate pd ON pd.workspace_id = t.workspace_id AND pd.bank_txn_id = t.id
        WHERE t.workspace_id = ? AND t.statement_id = ? AND pd.reason = 'same_movement' AND ${DUPLICATE_PENDING_SQL('t')}
        ORDER BY t.rowid`,
    )
    .all(ctx.workspaceId, statement.id) as { id: string; other: string | null }[];
  const lines = rows.filter((r) => {
    const row = readBankTxn(ctx, r.id);
    return row !== undefined && lineStateOf(ctx, row).state === 'open';
  });
  return { kind: 'delivery', statementId: statement.id, lines: lines.map((r) => ({ bankTxnId: r.id, other: r.other })) };
}

function writeAnswer(ctx: WorkspaceContext, bankTxnId: string, decision: DuplicateDecision, other: string | null, note: string | null, now: string): void {
  ctx.store.db
    .prepare(
      `INSERT INTO bank_txn_duplicate_decision (id, workspace_id, bank_txn_id, decision, other_bank_txn_id, note, decided_by, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.ids.next('bdup'), ctx.workspaceId, bankTxnId, decision, other, note, ctx.actor, now);
  ctx.audit.record({ entityKind: 'bank_txn', entityId: bankTxnId, action: 'update', actor: ctx.actor, at: now });
}

/** The ignore a duplicate answer writes FIRST (the trigger on bank_line_decision admits an ignore). */
function ignoreAsDuplicate(ctx: WorkspaceContext, bankTxnId: string, note: string | null, key: string): string | null {
  const ignored = ignoreBankLine(ctx, {
    bankTxnId,
    reason: 'duplicate',
    ...(note !== null ? { note } : {}),
    idempotencyKey: `resolve-duplicate:${bankTxnId}:${key}`,
  });
  if (!ignored.ok) throw new DecisionAbort(ignored as Err);
  return ignored.linkId;
}

function scopedKeyOf(input: ResolvePossibleDuplicateInput): string {
  return JSON.stringify([
    'resolve_possible_duplicate',
    input.bankTxnId ?? null,
    input.statementId ?? null,
    input.scope ?? null,
    input.idempotencyKey,
    input.decision ?? null,
    input.otherBankTxnId ?? null,
  ]);
}

/**
 * `resolve_possible_duplicate`: answer one flagged line, or every one-to-one match of one delivery as
 * duplicates. Needs `post` (the capability `ignore_bank_line` asserts). Idempotent per key.
 */
export function resolvePossibleDuplicate(
  ctx: WorkspaceContext,
  input: ResolvePossibleDuplicateInput,
): Result<ResolvePossibleDuplicateOk | ResolveDeliveryDuplicatesOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const keyGuard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (keyGuard) return keyGuard;
  const scopedKey = scopedKeyOf(input);
  const replayed = ctx.store.recallIdempotent<Result<ResolvePossibleDuplicateOk | ResolveDeliveryDuplicatesOk>>(ctx.workspaceId, scopedKey, 'resolve_possible_duplicate');
  if (replayed !== undefined) return replayed;
  const screened = screen(ctx, input);
  if ('ok' in screened) return screened;
  const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note : null;
  const key = input.idempotencyKey as string;
  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'resolve_possible_duplicate', () => {
      const now = ctx.clock.now();
      if (screened.kind === 'delivery') {
        const decided = screened.lines.map((l) => {
          const linkId = ignoreAsDuplicate(ctx, l.bankTxnId, note, key);
          writeAnswer(ctx, l.bankTxnId, 'duplicate', l.other, note, now);
          return { bankTxnId: l.bankTxnId, otherBankTxnId: l.other, linkId };
        });
        return ok<ResolveDeliveryDuplicatesOk>({
          statementId: screened.statementId,
          scope: 'one_to_one_matches',
          decision: 'duplicate',
          decided,
          count: decided.length,
          decidedBy: ctx.actor,
          decidedAt: now,
        });
      }
      const linkId = screened.decision === 'duplicate' ? ignoreAsDuplicate(ctx, screened.bankTxnId, note, key) : null;
      writeAnswer(ctx, screened.bankTxnId, screened.decision, screened.other, note, now);
      return ok<ResolvePossibleDuplicateOk>({
        bankTxnId: screened.bankTxnId,
        decision: screened.decision,
        otherBankTxnId: screened.other,
        state: screened.decision === 'duplicate' ? 'ignored' : 'open',
        linkId,
        decidedBy: ctx.actor,
        decidedAt: now,
      });
    });
  } catch (e) {
    if (e instanceof DecisionAbort) return e.result;
    throw e;
  }
}

/**
 * The verb's own validation with NOTHING written (`ActionDef.prevalidate`): a governed seat's answer is
 * refused here, before it is drafted, with the very refusal a direct call would answer. A same-key replay
 * answers undefined.
 */
export function prevalidateResolvePossibleDuplicate(ctx: WorkspaceContext, input: ResolvePossibleDuplicateInput): Err | undefined {
  const keyGuard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (keyGuard) return keyGuard;
  if (ctx.store.recallIdempotent(ctx.workspaceId, scopedKeyOf(input), 'resolve_possible_duplicate') !== undefined) return undefined;
  const screened = screen(ctx, input);
  return 'ok' in screened ? screened : undefined;
}
