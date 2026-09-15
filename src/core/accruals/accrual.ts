/**
 * A38, Abgrenzungen (OR Art. 958b Abs. 1): the accrual with its automatic reversal.
 *
 * ## The shape: a DRAFT, then a PAIR, then (maybe) a second pair
 *
 * An accrual is human-entered and has to survive across days and across the agent-proposes /
 * human-approves loop, so it is a persisted DRAFT (the H04 depreciation-run shape, design doc §7.7),
 * never a pure read: `accrualCreate` stores the row, `accrualGet` / `accrualList` render its lines
 * from the same `accrualLinesOf` the post uses, and `accrualPost` posts them. What the editor shows
 * IS what posts, because one function produces both.
 *
 * The post writes TWO entries in ONE transaction (the A22 `postFxRevaluation` precedent): A, the
 * accrual dated `periodEnd` (`source='accrual'`), and B = `reverseEntry(A)` dated the first day
 * after (`source='reversal'`, linked by `reverses_entry_id`). A locked next period rolls the whole
 * pair back: the books never carry an accrual without the Rückbuchung that backs it out, so 1300 and
 * 2300 read zero after the 1.1. without anyone remembering.
 *
 * A revert cannot call `reverseEntry(A)` again (A already carries B: `already_reversed`), so
 * `accrualReverse` posts the MIRROR PAIR: C, the mirror lines of A dated `periodEnd`
 * (`source='accrual'`, `ref = A`), and D = `reverseEntry(C)` dated the reversal date. Four entries,
 * each with exactly one reversal, every account netting to zero in both periods, nothing edited
 * (§H-AUDIT, design doc §7.8).
 *
 * ## Atomicity, the A22 lesson
 *
 * A better-sqlite3 `db.transaction(fn)()` commits unless `fn` THROWS. A plain `return err(...)` from
 * inside the tx would commit whatever was written before the failure (and memoise the failure under
 * the entry's idempotency key). `AccrualAbort` is the ONLY abort that rolls a half-written pair back.
 *
 * ## Idempotency, on the row and on the rows
 *
 * The create key is unique per workspace; the post and the Storno keep their own key on the row.
 * The same key replays the stored result and writes nothing; a different key on an already posted
 * accrual is `already_posted` (never a second pair). The conformance gate's double call proves it
 * against every row of every table, and `test/accruals/a38-accruals.test.mjs` counts the journal.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result, Err } from '../result.js';
import { requireString, requireDate, optionalText, optionalId } from '../ledger/inputGuards.js';
import { postEntry } from '../ledger/postEntry.js';
import type { LineInput } from '../ledger/postEntry.js';
import { reverseOwnedEntry } from '../ledger/reverseEntry.js';
import { applySavedView } from '../customization/views.js';
import { baseCurrencyOf } from '../fx/rates.js';
import {
  ACCRUAL_KINDS,
  ACCRUAL_KIND_RULES,
  ACCRUAL_SOURCE,
  ACCRUAL_STATUSES,
  accountByNumber,
  accrualLinesOf,
  describeLines,
  findAccount,
  firstDayAfter,
  isAccrualKind,
  isPositiveMinor,
  mirrorLinesOf,
} from './lines.js';
import type { AccrualKind, AccrualStatus, LineView } from './lines.js';

/**
 * The owner of every `accrual` entry and its mirrors in `OWNED_REVERSAL_SOURCES`. The token names the
 * verb an OUTSIDE caller must use (the raw `reverse_entry` answers `owned_by accrual_reverse`), so the
 * pair's own automatic Rückbuchung is minted under it as well: B and D exist only as halves of a pair.
 */
const ACCRUAL_OWNER = 'accrual_reverse';

/** The abort that rolls a half-written pair back. Thrown inside the tx, translated outside it. */
class AccrualAbort {
  constructor(public readonly result: Err) {}
}

function runGuarded<T extends Result>(body: () => T): T | Err {
  try {
    return body();
  } catch (e) {
    if (e instanceof AccrualAbort) return e.result;
    throw e;
  }
}

/** The G00 saved-view entity kind the list verb resolves views against. */
const ACCRUAL_ENTITY_KIND = 'accrual';

interface AccrualRow {
  id: string;
  workspace_id: string;
  kind: AccrualKind;
  period_end: string;
  reversal_date: string;
  amount_minor: number;
  balance_account_id: string;
  contra_account_id: string;
  cost_center_id: string | null;
  description: string;
  source_ref: string | null;
  status: AccrualStatus;
  entry_id: string | null;
  reversal_entry_id: string | null;
  storno_entry_id: string | null;
  storno_reversal_entry_id: string | null;
  idempotency_key: string;
  post_idempotency_key: string | null;
  reverse_idempotency_key: string | null;
  created_by: string;
  created_at: string;
  posted_at: string | null;
  posted_by: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
  reverse_reason: string | null;
  discarded_at: string | null;
  discard_reason: string | null;
  updated_at: string;
}

/** The accrual as every verb returns it. Camel-cased, ISO dates, integer minor units (P11). */
export interface AccrualView {
  readonly id: string;
  readonly kind: AccrualKind;
  readonly periodEnd: string;
  readonly reversalDate: string;
  readonly amountMinor: number;
  readonly balanceAccountId: string;
  readonly balanceAccountNumber: string;
  readonly contraAccountId: string;
  readonly contraAccountNumber: string;
  readonly contraAccountName: string;
  readonly costCenterId: string | null;
  readonly description: string;
  readonly sourceRef: string | null;
  readonly status: AccrualStatus;
  readonly entryId: string | null;
  readonly reversalEntryId: string | null;
  readonly stornoEntryId: string | null;
  readonly stornoReversalEntryId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly postedAt: string | null;
  readonly postedBy: string | null;
  readonly reversedAt: string | null;
  readonly reversedBy: string | null;
  readonly reverseReason: string | null;
  readonly discardedAt: string | null;
  readonly discardReason: string | null;
}

const COLUMNS =
  'id, workspace_id, kind, period_end, reversal_date, amount_minor, balance_account_id, contra_account_id, cost_center_id, description, source_ref, status, entry_id, reversal_entry_id, storno_entry_id, storno_reversal_entry_id, idempotency_key, post_idempotency_key, reverse_idempotency_key, created_by, created_at, posted_at, posted_by, reversed_at, reversed_by, reverse_reason, discarded_at, discard_reason, updated_at';

function readRow(ctx: WorkspaceContext, accrualId: string): AccrualRow | undefined {
  return ctx.store.db
    .prepare(`SELECT ${COLUMNS} FROM accrual WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, accrualId) as AccrualRow | undefined;
}

function viewOf(ctx: WorkspaceContext, row: AccrualRow): AccrualView {
  const numbers = ctx.store.db
    .prepare('SELECT id, number, name FROM account WHERE workspace_id = ? AND id IN (?, ?)')
    .all(ctx.workspaceId, row.balance_account_id, row.contra_account_id) as { id: string; number: string; name: string }[];
  const byId = new Map(numbers.map((a) => [a.id, a]));
  return {
    id: row.id,
    kind: row.kind,
    periodEnd: row.period_end,
    reversalDate: row.reversal_date,
    amountMinor: row.amount_minor,
    balanceAccountId: row.balance_account_id,
    balanceAccountNumber: byId.get(row.balance_account_id)?.number ?? '',
    contraAccountId: row.contra_account_id,
    contraAccountNumber: byId.get(row.contra_account_id)?.number ?? '',
    contraAccountName: byId.get(row.contra_account_id)?.name ?? '',
    costCenterId: row.cost_center_id,
    description: row.description,
    sourceRef: row.source_ref,
    status: row.status,
    entryId: row.entry_id,
    reversalEntryId: row.reversal_entry_id,
    stornoEntryId: row.storno_entry_id,
    stornoReversalEntryId: row.storno_reversal_entry_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    postedAt: row.posted_at,
    postedBy: row.posted_by,
    reversedAt: row.reversed_at,
    reversedBy: row.reversed_by,
    reverseReason: row.reverse_reason,
    discardedAt: row.discarded_at,
    discardReason: row.discard_reason,
  };
}

function linesOfRow(row: AccrualRow): LineInput[] {
  return accrualLinesOf({
    kind: row.kind,
    amountMinor: row.amount_minor,
    balanceAccountId: row.balance_account_id,
    contraAccountId: row.contra_account_id,
    costCenterId: row.cost_center_id,
  });
}

/**
 * The draft's full answer: the row, its lines dated `periodEnd`, the reversal lines dated the day
 * after, and the base currency every figure is denominated in (named on the answer that carries the
 * numbers, so no surface holds a second read open to label them: the A03 year-close precedent).
 */
function draftAnswer(ctx: WorkspaceContext, row: AccrualRow): { accrual: AccrualView; lines: LineView[]; reversalLines: LineView[]; baseCurrency: string } {
  const lines = linesOfRow(row);
  return {
    accrual: viewOf(ctx, row),
    lines: describeLines(ctx, lines, row.period_end),
    reversalLines: describeLines(ctx, mirrorLinesOf(lines), row.reversal_date),
    baseCurrency: baseCurrencyOf(ctx),
  };
}

export interface AccrualCreateInput {
  kind: string;
  periodEnd: string;
  amountMinor: number;
  /** Account NUMBER or id of the P&L account (income for the income kinds, expense for the expense kinds). */
  contraAccount: string;
  description: string;
  sourceRef?: string;
  costCenterId?: string;
  /** Base currency only in v1 (§H-FX): anything else is `invalid_currency`. */
  currency?: string;
  idempotencyKey: string;
}

/**
 * Describe an Abgrenzung and store it as a DRAFT. Nothing is written to the journal; the answer
 * carries the lines the post will write, from the same function.
 */
export function accrualCreate(ctx: WorkspaceContext, input: AccrualCreateInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;

  const guard =
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    requireDate(input.periodEnd, 'periodEnd') ??
    requireString(input.contraAccount, 'contraAccount') ??
    requireString(input.description, 'description') ??
    optionalText(input.sourceRef, 'sourceRef') ??
    optionalId(input.costCenterId, 'costCenterId') ??
    optionalId(input.currency, 'currency');
  if (guard) return guard;

  if (!isAccrualKind(input.kind)) {
    return err('invalid_kind', { kind: input.kind, allowed: [...ACCRUAL_KINDS] });
  }
  if (!isPositiveMinor(input.amountMinor)) {
    return err('invalid_amount', { amountMinor: input.amountMinor, reason: 'a positive integer of minor units' });
  }
  const base = baseCurrencyOf(ctx);
  if (input.currency !== undefined && input.currency !== base) {
    return err('invalid_currency', { currency: input.currency, baseCurrency: base, reason: 'an accrual is a base-currency posting' });
  }

  // §H-IDEMPOTENT: the same create key replays the draft it made, whatever state it is in now.
  const existing = ctx.store.db
    .prepare(`SELECT ${COLUMNS} FROM accrual WHERE workspace_id = ? AND idempotency_key = ?`)
    .get(ctx.workspaceId, input.idempotencyKey) as AccrualRow | undefined;
  if (existing !== undefined) return ok(draftAnswer(ctx, existing));

  const rule = ACCRUAL_KIND_RULES[input.kind];
  const contra = findAccount(ctx, input.contraAccount);
  if (contra === undefined) {
    return err('invalid_account', { account: input.contraAccount, reason: 'contra_not_found' });
  }
  if (contra.type !== 'income' && contra.type !== 'expense') {
    return err('invalid_account', { account: contra.number, type: contra.type, reason: 'contra_must_be_income_or_expense' });
  }
  if (contra.type !== rule.contraType) {
    return err('invalid_account', {
      account: contra.number,
      type: contra.type,
      kind: input.kind,
      expected: rule.contraType,
      reason: 'kind_account_type_mismatch',
    });
  }
  if (contra.archived === 1) {
    return err('invalid_account', { account: contra.number, reason: 'archived' });
  }
  const balance = accountByNumber(ctx, rule.balanceAccountNumber);
  if (balance === undefined) {
    return err('missing_account', { number: rule.balanceAccountNumber, reason: 'seed the statutory Rechnungsabgrenzung account (A01) before accruing' });
  }
  if (input.costCenterId !== undefined) {
    const cc = ctx.store.db
      .prepare('SELECT id FROM cost_center WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, input.costCenterId) as { id: string } | undefined;
    if (cc === undefined) return err('not_found', { costCenterId: input.costCenterId });
  }

  const id = ctx.ids.next('accrual');
  const at = ctx.clock.now();
  const reversalDate = firstDayAfter(input.periodEnd);
  ctx.store.tx(() => {
    ctx.store.db
      .prepare(
        `INSERT INTO accrual (id, workspace_id, kind, period_end, reversal_date, amount_minor, balance_account_id,
           contra_account_id, cost_center_id, description, source_ref, status, idempotency_key, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.kind,
        input.periodEnd,
        reversalDate,
        input.amountMinor,
        balance.id,
        contra.id,
        input.costCenterId ?? null,
        input.description,
        input.sourceRef ?? null,
        input.idempotencyKey,
        ctx.actor,
        at,
        at,
      );
    ctx.audit.record({ entityKind: 'accrual', entityId: id, action: 'create', actor: ctx.actor, at });
  });
  const row = readRow(ctx, id);
  if (row === undefined) return err('not_found', { accrualId: id });
  return ok(draftAnswer(ctx, row));
}

export interface AccrualIdInput {
  accrualId: string;
}

/** One accrual with its lines, reversal lines and the journal entries it has produced so far. */
export function accrualGet(ctx: WorkspaceContext, input: AccrualIdInput): Result {
  const capable = ctx.capabilities.assert('read_books');
  if (!capable.ok) return capable;
  const guard = requireString(input.accrualId, 'accrualId');
  if (guard) return guard;
  const row = readRow(ctx, input.accrualId);
  if (row === undefined) return err('not_found', { accrualId: input.accrualId });
  return ok({ ...draftAnswer(ctx, row), entries: entriesOf(row) });
}

/** The journal entries an accrual points at, in the order they were minted, each with its role. */
function entriesOf(row: AccrualRow): { role: 'accrual' | 'reversal' | 'storno' | 'storno_reversal'; entryId: string; date: string }[] {
  const out: { role: 'accrual' | 'reversal' | 'storno' | 'storno_reversal'; entryId: string; date: string }[] = [];
  if (row.entry_id !== null) out.push({ role: 'accrual', entryId: row.entry_id, date: row.period_end });
  if (row.reversal_entry_id !== null) out.push({ role: 'reversal', entryId: row.reversal_entry_id, date: row.reversal_date });
  if (row.storno_entry_id !== null) out.push({ role: 'storno', entryId: row.storno_entry_id, date: row.period_end });
  if (row.storno_reversal_entry_id !== null) out.push({ role: 'storno_reversal', entryId: row.storno_reversal_entry_id, date: row.reversal_date });
  return out;
}

export interface AccrualListInput {
  periodEnd?: string;
  status?: string;
  kind?: string;
  savedViewId?: string;
}

/**
 * List accruals, newest period first. `totalMinor` sums the live ones (draft and posted): what the
 * period carries or is about to carry, never the reversed or discarded.
 */
export function accrualList(ctx: WorkspaceContext, input: AccrualListInput = {}): Result {
  const capable = ctx.capabilities.assert('read_books');
  if (!capable.ok) return capable;
  const guard =
    optionalId(input.periodEnd, 'periodEnd') ??
    optionalId(input.status, 'status') ??
    optionalId(input.kind, 'kind') ??
    optionalId(input.savedViewId, 'savedViewId');
  if (guard) return guard;
  if (input.periodEnd !== undefined) {
    const dateGuard = requireDate(input.periodEnd, 'periodEnd');
    if (dateGuard) return dateGuard;
  }

  // The G00 saved-view seam: a view's stored filters sit underneath anything named explicitly.
  const viewed = applySavedView(ctx, ACCRUAL_ENTITY_KIND, input);
  if (!viewed.ok) return viewed;
  const filter = viewed.filter;

  if (filter.status !== undefined && !(ACCRUAL_STATUSES as readonly string[]).includes(filter.status)) {
    return err('invalid_input', { field: 'status', allowed: [...ACCRUAL_STATUSES] });
  }
  if (filter.kind !== undefined && !isAccrualKind(filter.kind)) {
    return err('invalid_kind', { kind: filter.kind, allowed: [...ACCRUAL_KINDS] });
  }

  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (filter.periodEnd !== undefined) {
    clauses.push('period_end = ?');
    params.push(filter.periodEnd);
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.kind !== undefined) {
    clauses.push('kind = ?');
    params.push(filter.kind);
  }
  const rows = ctx.store.db
    .prepare(`SELECT ${COLUMNS} FROM accrual WHERE ${clauses.join(' AND ')} ORDER BY period_end DESC, created_at ASC, id ASC`)
    .all(...params) as AccrualRow[];

  const accruals = rows.map((r) => viewOf(ctx, r));
  const totalMinor = rows.filter((r) => r.status === 'draft' || r.status === 'posted').reduce((s, r) => s + r.amount_minor, 0);
  return ok({ accruals, totalMinor, baseCurrency: baseCurrencyOf(ctx) });
}

export interface AccrualDiscardInput {
  accrualId: string;
  reason?: string;
  idempotencyKey: string;
}

/** Retire a draft. Never a DELETE: the row stays, `discarded`, with its reason. */
export function accrualDiscard(ctx: WorkspaceContext, input: AccrualDiscardInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.accrualId, 'accrualId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalText(input.reason, 'reason');
  if (guard) return guard;

  const row = readRow(ctx, input.accrualId);
  if (row === undefined) return err('not_found', { accrualId: input.accrualId });
  if (row.status === 'discarded') {
    // The discard key is kept in the reverse slot: a discarded draft never posts or reverses.
    if (row.reverse_idempotency_key === input.idempotencyKey) return ok({ accrual: viewOf(ctx, row) });
    return err('draft_discarded', { accrualId: row.id, discardedAt: row.discarded_at });
  }
  if (row.status !== 'draft') return err('already_posted', { accrualId: row.id, entryId: row.entry_id });

  const at = ctx.clock.now();
  ctx.store.tx(() => {
    ctx.store.db
      .prepare(
        `UPDATE accrual SET status = 'discarded', discarded_at = ?, discard_reason = ?, reverse_idempotency_key = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(at, input.reason ?? null, input.idempotencyKey, at, ctx.workspaceId, row.id);
    ctx.audit.record({ entityKind: 'accrual', entityId: row.id, action: 'discard', actor: ctx.actor, at });
  });
  const after = readRow(ctx, row.id);
  return ok({ accrual: after === undefined ? viewOf(ctx, row) : viewOf(ctx, after) });
}

export interface AccrualPostInput {
  accrualId: string;
  idempotencyKey: string;
}

/**
 * What a successful post sends back. Declared (see `src/core/result.ts`): the Studio reads
 * `reversalEntryId` and the checklist row binds `entryId`, and a rename of either must be a compile
 * error at the call site rather than an `undefined` in a row.
 */
export type AccrualPostOk = {
  readonly accrualId: string;
  /** Entry A, the accrual dated `periodEnd`. */
  readonly entryId: string;
  /** Entry B, the automatic Rückbuchung dated the first day after. */
  readonly reversalEntryId: string;
  readonly reversalDate: string;
  readonly accrual: AccrualView;
};

/**
 * Post the pair, atomically. A refused second leg (the reversal date locked) rolls the first back,
 * so the books never carry an accrual without its reversal.
 */
export function accrualPost(ctx: WorkspaceContext, input: AccrualPostInput): Result<AccrualPostOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard = requireString(input.accrualId, 'accrualId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const row = readRow(ctx, input.accrualId);
  if (row === undefined) return err('not_found', { accrualId: input.accrualId });
  if (row.status === 'discarded') return err('draft_discarded', { accrualId: row.id, discardedAt: row.discarded_at });
  if (row.status !== 'draft') {
    if (row.post_idempotency_key === input.idempotencyKey && row.entry_id !== null && row.reversal_entry_id !== null) {
      return ok<AccrualPostOk>({
        accrualId: row.id,
        entryId: row.entry_id,
        reversalEntryId: row.reversal_entry_id,
        reversalDate: row.reversal_date,
        accrual: viewOf(ctx, row),
      });
    }
    return err('already_posted', { accrualId: row.id, entryId: row.entry_id, postedAt: row.posted_at });
  }

  const lines = linesOfRow(row);
  return runGuarded(() =>
    ctx.store.tx(() => {
      const posted = postEntry(ctx, {
        date: row.period_end,
        source: ACCRUAL_SOURCE,
        idempotencyKey: `accrual:${row.id}`,
        description: row.description,
        ...(row.source_ref !== null ? { ref: row.source_ref } : {}),
        lines,
      });
      // The throw is the ONLY abort that rolls the tx back (a `return` would COMMIT the partial
      // writes and memoise the failure under the entry key).
      if (!posted.ok) throw new AccrualAbort(err(posted.error, { ...posted, date: row.period_end, leg: 'accrual' }));

      const reversal = reverseOwnedEntry(
        ctx,
        {
          entryId: posted.entryId,
          date: row.reversal_date,
          idempotencyKey: `accrual-rev:${row.id}`,
          description: `Rückbuchung: ${row.description}`,
        },
        ACCRUAL_OWNER,
      );
      // A reversal blocked by a locked next period rolls the accrual entry back TOO.
      if (!reversal.ok) throw new AccrualAbort(err(reversal.error, { ...reversal, date: row.reversal_date, leg: 'reversal' }));

      const at = ctx.clock.now();
      ctx.store.db
        .prepare(
          `UPDATE accrual SET status = 'posted', entry_id = ?, reversal_entry_id = ?, post_idempotency_key = ?,
             posted_at = ?, posted_by = ?, updated_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(posted.entryId, reversal.reversalId, input.idempotencyKey, at, ctx.actor, at, ctx.workspaceId, row.id);
      ctx.audit.record({ entityKind: 'accrual', entityId: row.id, action: 'post', actor: ctx.actor, at });

      const after = readRow(ctx, row.id);
      if (after === undefined) throw new AccrualAbort(err('not_found', { accrualId: row.id }));
      return ok<AccrualPostOk>({
        accrualId: row.id,
        entryId: posted.entryId,
        reversalEntryId: reversal.reversalId,
        reversalDate: row.reversal_date,
        accrual: viewOf(ctx, after),
      });
    }),
  );
}

export interface AccrualReverseInput {
  accrualId: string;
  reason?: string;
  idempotencyKey: string;
}

/** What a successful Storno sends back: the ids of the MIRROR pair, never A or B. Declared. */
export type AccrualReverseOk = {
  readonly accrualId: string;
  /** Entry C, the mirror of A dated `periodEnd`. */
  readonly stornoEntryId: string;
  /** Entry D, the reversal of C dated the reversal date. */
  readonly stornoReversalEntryId: string;
  readonly accrual: AccrualView;
};

/**
 * Revert a posted accrual without editing history: the mirror pair C + D, in one transaction. After
 * it, every account nets to zero in both periods and each of the four entries carries exactly one
 * reversal.
 */
export function accrualReverse(ctx: WorkspaceContext, input: AccrualReverseInput): Result<AccrualReverseOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.accrualId, 'accrualId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalText(input.reason, 'reason');
  if (guard) return guard;

  const row = readRow(ctx, input.accrualId);
  if (row === undefined) return err('not_found', { accrualId: input.accrualId });
  if (row.status === 'draft' || row.status === 'discarded') return err('not_posted', { accrualId: row.id, status: row.status });
  if (row.status === 'reversed') {
    if (row.reverse_idempotency_key === input.idempotencyKey && row.storno_entry_id !== null && row.storno_reversal_entry_id !== null) {
      return ok<AccrualReverseOk>({
        accrualId: row.id,
        stornoEntryId: row.storno_entry_id,
        stornoReversalEntryId: row.storno_reversal_entry_id,
        accrual: viewOf(ctx, row),
      });
    }
    return err('already_reversed', { accrualId: row.id, stornoEntryId: row.storno_entry_id, reversedAt: row.reversed_at });
  }
  if (row.entry_id === null) return err('not_posted', { accrualId: row.id, status: row.status });
  const originalEntryId = row.entry_id;

  const stornoLines = mirrorLinesOf(linesOfRow(row));
  const description = input.reason === undefined ? `Storno: ${row.description}` : `Storno: ${row.description} (${input.reason})`;
  return runGuarded(() =>
    ctx.store.tx(() => {
      const storno = postEntry(ctx, {
        date: row.period_end,
        source: ACCRUAL_SOURCE,
        idempotencyKey: `accrual-storno:${row.id}`,
        description,
        // The journal carries no storno column; `ref` names the entry this one mirrors.
        ref: originalEntryId,
        lines: stornoLines,
      });
      if (!storno.ok) throw new AccrualAbort(err(storno.error, { ...storno, date: row.period_end, leg: 'storno' }));

      const stornoReversal = reverseOwnedEntry(
        ctx,
        {
          entryId: storno.entryId,
          date: row.reversal_date,
          idempotencyKey: `accrual-storno-rev:${row.id}`,
          description: `Rückbuchung: ${description}`,
        },
        ACCRUAL_OWNER,
      );
      if (!stornoReversal.ok) {
        throw new AccrualAbort(err(stornoReversal.error, { ...stornoReversal, date: row.reversal_date, leg: 'storno_reversal' }));
      }

      const at = ctx.clock.now();
      ctx.store.db
        .prepare(
          `UPDATE accrual SET status = 'reversed', storno_entry_id = ?, storno_reversal_entry_id = ?, reverse_idempotency_key = ?,
             reversed_at = ?, reversed_by = ?, reverse_reason = ?, updated_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(
          storno.entryId,
          stornoReversal.reversalId,
          input.idempotencyKey,
          at,
          ctx.actor,
          input.reason ?? null,
          at,
          ctx.workspaceId,
          row.id,
        );
      ctx.audit.record({ entityKind: 'accrual', entityId: row.id, action: 'reverse', actor: ctx.actor, at });

      const after = readRow(ctx, row.id);
      if (after === undefined) throw new AccrualAbort(err('not_found', { accrualId: row.id }));
      return ok<AccrualReverseOk>({
        accrualId: row.id,
        stornoEntryId: storno.entryId,
        stornoReversalEntryId: stornoReversal.reversalId,
        accrual: viewOf(ctx, after),
      });
    }),
  );
}
