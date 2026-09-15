/**
 * A38, Rückstellungen (OR Art. 960e Abs. 2 to 4): formed with a reason, released in parts, or
 * reversed. Never released by the calendar.
 *
 * Abs. 2 makes the provision a DUTY when past events make a future Mittelabfluss expected; Abs. 3
 * admits four more (regelmässig anfallende Garantieaufwendungen, Sanierungen von Sachanlagen,
 * Restrukturierungen, die Sicherung des dauernden Gedeihens); Abs. 4 says a no-longer-founded
 * provision NEED NOT be released. That is why this module has no auto-reversal: a provision is a
 * DRAFT (`provisionCreate`), then ONE posted entry (`provisionPost`, Dr expense / Cr provision), then
 * any number of partial or full releases (`provisionRelease`, Dr provision / Cr target), each its own
 * entry, or one reversal of the formation (`provisionReverse`, a `reverseEntry`) while no release
 * stands. The reason is on the row and on the audit chain, which is the record the tax office asks for.
 *
 * The OPEN BALANCE is derived, never stored: the formation amount minus every release whose entry
 * carries no reversal. A release is undone through A02 `reverse_entry` on its entry (the eighteen
 * verbs are the surface, and a second release-undo path would be a second posting path), so the
 * derivation reads the journal's `reverses_entry_id` and stays right whichever door the reversal came
 * through.
 *
 * Idempotency and atomicity follow `accrual.ts`: the key on the row, the throw as the only abort.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result, Err } from '../result.js';
import { requireString, requireDate, optionalText, optionalId, optionalDate } from '../ledger/inputGuards.js';
import { postEntry } from '../ledger/postEntry.js';
import { reverseOwnedEntry } from '../ledger/reverseEntry.js';
import { applySavedView } from '../customization/views.js';
import { baseCurrencyOf } from '../fx/rates.js';
import {
  LONG_TERM_PROVISION_ACCOUNT,
  PROVISION_REASONS,
  PROVISION_SOURCE,
  PROVISION_STATUSES,
  SHORT_TERM_PROVISION_ACCOUNT,
  SONSTIGE_MIN_DESCRIPTION,
  describeLines,
  findAccount,
  isPositiveMinor,
  isProvisionReason,
  provisionLinesOf,
  releaseLinesOf,
} from './lines.js';
import type { LineView, ProvisionReason, ProvisionStatus } from './lines.js';

class ProvisionAbort {
  constructor(public readonly result: Err) {}
}

function runGuarded<T extends Result>(body: () => T): T | Err {
  try {
    return body();
  } catch (e) {
    if (e instanceof ProvisionAbort) return e.result;
    throw e;
  }
}

const PROVISION_ENTITY_KIND = 'provision';

/**
 * The two owners of a `provision` entry in `OWNED_REVERSAL_SOURCES` (resolved by row there): the
 * formation belongs to `provision_reverse`, a release entry to `provision_release_reverse`. The raw
 * `reverse_entry` refuses both with `owned_by`, so the derivation below never sees a mirror it did
 * not make.
 */
const PROVISION_OWNER = 'provision_reverse';
const RELEASE_OWNER = 'provision_release_reverse';

interface ProvisionRow {
  id: string;
  reason: ProvisionReason;
  period_end: string;
  amount_minor: number;
  provision_account_id: string;
  expense_account_id: string;
  description: string;
  status: ProvisionStatus;
  entry_id: string | null;
  reversal_entry_id: string | null;
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
}

interface ReleaseRow {
  id: string;
  provision_id: string;
  release_date: string;
  amount_minor: number;
  target_account_id: string;
  entry_id: string;
  idempotency_key: string;
  created_by: string;
  created_at: string;
  /** The id of the entry that reversed this release's entry, when one exists (A02 `reverse_entry`). */
  reversed_by_entry_id: string | null;
}

export interface ProvisionView {
  readonly id: string;
  readonly reason: ProvisionReason;
  readonly periodEnd: string;
  readonly amountMinor: number;
  readonly provisionAccountId: string;
  readonly provisionAccountNumber: string;
  readonly expenseAccountId: string;
  readonly expenseAccountNumber: string;
  readonly expenseAccountName: string;
  readonly description: string;
  readonly status: ProvisionStatus;
  readonly entryId: string | null;
  readonly reversalEntryId: string | null;
  /** The formation amount minus every live release. Derived on every read. */
  readonly openBalanceMinor: number;
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

export interface ReleaseView {
  readonly id: string;
  readonly provisionId: string;
  readonly date: string;
  readonly amountMinor: number;
  readonly targetAccountId: string;
  readonly targetAccountNumber: string;
  readonly entryId: string;
  /** Set when the release was undone through `provision_release_reverse`; the release no longer counts. */
  readonly reversedByEntryId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

const COLUMNS =
  'id, reason, period_end, amount_minor, provision_account_id, expense_account_id, description, status, entry_id, reversal_entry_id, idempotency_key, post_idempotency_key, reverse_idempotency_key, created_by, created_at, posted_at, posted_by, reversed_at, reversed_by, reverse_reason, discarded_at, discard_reason';

function readRow(ctx: WorkspaceContext, provisionId: string): ProvisionRow | undefined {
  return ctx.store.db
    .prepare(`SELECT ${COLUMNS} FROM provision WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, provisionId) as ProvisionRow | undefined;
}

/** The releases of a provision, each with the reversal (if any) of its entry read off the journal. */
function releasesOf(ctx: WorkspaceContext, provisionId: string): ReleaseRow[] {
  return ctx.store.db
    .prepare(
      `SELECT r.id, r.provision_id, r.release_date, r.amount_minor, r.target_account_id, r.entry_id, r.idempotency_key,
              r.created_by, r.created_at,
              (SELECT e.id FROM journal_entry e WHERE e.workspace_id = r.workspace_id AND e.reverses_entry_id = r.entry_id AND e.status = 'posted' LIMIT 1) AS reversed_by_entry_id
         FROM provision_release r
        WHERE r.workspace_id = ? AND r.provision_id = ?
        ORDER BY r.release_date ASC, r.created_at ASC, r.id ASC`,
    )
    .all(ctx.workspaceId, provisionId) as ReleaseRow[];
}

function openBalanceOf(row: ProvisionRow, releases: readonly ReleaseRow[]): number {
  if (row.status === 'draft' || row.status === 'discarded' || row.status === 'reversed') return 0;
  const live = releases.filter((r) => r.reversed_by_entry_id === null).reduce((s, r) => s + r.amount_minor, 0);
  return row.amount_minor - live;
}

/**
 * The status a provision READS, derived from the rows rather than stored (critic finding, 2026-09-09).
 *
 * `released` is not a step the row takes, it is a fact about the balance: a posted provision whose
 * live releases add up to its amount. The first draft stored the flip (`UPDATE provision SET status =
 * 'released'` at zero) and the frozen-after-draft trigger forbade the way back, so undoing a full
 * release the A02 way (`reverse_entry` on the release entry) left a row that said `released` while
 * providing for the full amount, and the `released` filter listed a provision that still provides.
 * Deriving it here makes the status agree with `openBalanceMinor` by construction: a row that left
 * draft and has nothing open reads `released`, one with a balance reads `posted`, whichever word the
 * column carries (a file written before this fix may still carry `released`; it reads right too).
 */
function statusOf(row: ProvisionRow, releases: readonly ReleaseRow[]): ProvisionStatus {
  if (row.status !== 'posted' && row.status !== 'released') return row.status;
  return openBalanceOf(row, releases) === 0 ? 'released' : 'posted';
}

function viewOf(ctx: WorkspaceContext, row: ProvisionRow, releases: readonly ReleaseRow[]): ProvisionView {
  const accounts = ctx.store.db
    .prepare('SELECT id, number, name FROM account WHERE workspace_id = ? AND id IN (?, ?)')
    .all(ctx.workspaceId, row.provision_account_id, row.expense_account_id) as { id: string; number: string; name: string }[];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return {
    id: row.id,
    reason: row.reason,
    periodEnd: row.period_end,
    amountMinor: row.amount_minor,
    provisionAccountId: row.provision_account_id,
    provisionAccountNumber: byId.get(row.provision_account_id)?.number ?? '',
    expenseAccountId: row.expense_account_id,
    expenseAccountNumber: byId.get(row.expense_account_id)?.number ?? '',
    expenseAccountName: byId.get(row.expense_account_id)?.name ?? '',
    description: row.description,
    status: statusOf(row, releases),
    entryId: row.entry_id,
    reversalEntryId: row.reversal_entry_id,
    openBalanceMinor: openBalanceOf(row, releases),
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

function releaseViewOf(ctx: WorkspaceContext, r: ReleaseRow): ReleaseView {
  const target = ctx.store.db
    .prepare('SELECT number FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, r.target_account_id) as { number: string } | undefined;
  return {
    id: r.id,
    provisionId: r.provision_id,
    date: r.release_date,
    amountMinor: r.amount_minor,
    targetAccountId: r.target_account_id,
    targetAccountNumber: target?.number ?? '',
    entryId: r.entry_id,
    reversedByEntryId: r.reversed_by_entry_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function linesView(ctx: WorkspaceContext, row: ProvisionRow): LineView[] {
  return describeLines(
    ctx,
    provisionLinesOf({ amountMinor: row.amount_minor, provisionAccountId: row.provision_account_id, expenseAccountId: row.expense_account_id }),
    row.period_end,
  );
}

function draftAnswer(ctx: WorkspaceContext, row: ProvisionRow): { provision: ProvisionView; lines: LineView[]; baseCurrency: string } {
  return { provision: viewOf(ctx, row, releasesOf(ctx, row.id)), lines: linesView(ctx, row), baseCurrency: baseCurrencyOf(ctx) };
}

/** A provision account: 2330, 2600, or any liability the workspace numbers 23xx / 26xx. */
function isProvisionAccountNumber(number: string): boolean {
  return number.startsWith('23') || number.startsWith('26');
}

export interface ProvisionCreateInput {
  reason: string;
  periodEnd: string;
  amountMinor: number;
  /** Account NUMBER or id: 2330, 2600, or a liability numbered 23xx / 26xx. */
  provisionAccount: string;
  /** Account NUMBER or id of the P&L account the formation is charged to. */
  expenseAccount: string;
  description: string;
  idempotencyKey: string;
}

export function provisionCreate(ctx: WorkspaceContext, input: ProvisionCreateInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    requireDate(input.periodEnd, 'periodEnd') ??
    requireString(input.provisionAccount, 'provisionAccount') ??
    requireString(input.expenseAccount, 'expenseAccount') ??
    requireString(input.description, 'description');
  if (guard) return guard;

  if (!isProvisionReason(input.reason)) {
    return err('invalid_reason', { reason: input.reason, allowed: [...PROVISION_REASONS] });
  }
  if (input.reason === 'sonstige' && input.description.trim().length < SONSTIGE_MIN_DESCRIPTION) {
    return err('invalid_input', {
      field: 'description',
      reason: 'sonstige_needs_description',
      minLength: SONSTIGE_MIN_DESCRIPTION,
    });
  }
  if (!isPositiveMinor(input.amountMinor)) {
    return err('invalid_amount', { amountMinor: input.amountMinor, reason: 'a positive integer of minor units' });
  }

  const existing = ctx.store.db
    .prepare(`SELECT ${COLUMNS} FROM provision WHERE workspace_id = ? AND idempotency_key = ?`)
    .get(ctx.workspaceId, input.idempotencyKey) as ProvisionRow | undefined;
  if (existing !== undefined) return ok(draftAnswer(ctx, existing));

  const provisionAccount = findAccount(ctx, input.provisionAccount);
  if (provisionAccount === undefined) {
    if (input.provisionAccount === SHORT_TERM_PROVISION_ACCOUNT || input.provisionAccount === LONG_TERM_PROVISION_ACCOUNT) {
      return err('missing_account', { number: input.provisionAccount, reason: 'seed the provision account (A01) before forming a Rückstellung' });
    }
    return err('invalid_account', { account: input.provisionAccount, reason: 'provision_account' });
  }
  if (provisionAccount.type !== 'liability' || !isProvisionAccountNumber(provisionAccount.number)) {
    return err('invalid_account', { account: provisionAccount.number, type: provisionAccount.type, reason: 'provision_account' });
  }
  const expenseAccount = findAccount(ctx, input.expenseAccount);
  if (expenseAccount === undefined) {
    return err('invalid_account', { account: input.expenseAccount, reason: 'expense_not_found' });
  }
  if (expenseAccount.type !== 'income' && expenseAccount.type !== 'expense') {
    return err('invalid_account', { account: expenseAccount.number, type: expenseAccount.type, reason: 'expense_must_be_income_or_expense' });
  }
  if (provisionAccount.archived === 1 || expenseAccount.archived === 1) {
    return err('invalid_account', { account: provisionAccount.archived === 1 ? provisionAccount.number : expenseAccount.number, reason: 'archived' });
  }

  const id = ctx.ids.next('provision');
  const at = ctx.clock.now();
  ctx.store.tx(() => {
    ctx.store.db
      .prepare(
        `INSERT INTO provision (id, workspace_id, reason, period_end, amount_minor, provision_account_id, expense_account_id,
           description, status, idempotency_key, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, input.reason, input.periodEnd, input.amountMinor, provisionAccount.id, expenseAccount.id, input.description, input.idempotencyKey, ctx.actor, at, at);
    ctx.audit.record({ entityKind: 'provision', entityId: id, action: 'create', actor: ctx.actor, at });
  });
  const row = readRow(ctx, id);
  if (row === undefined) return err('not_found', { provisionId: id });
  return ok(draftAnswer(ctx, row));
}

export interface ProvisionIdInput {
  provisionId: string;
}

export function provisionGet(ctx: WorkspaceContext, input: ProvisionIdInput): Result {
  const capable = ctx.capabilities.assert('read_books');
  if (!capable.ok) return capable;
  const guard = requireString(input.provisionId, 'provisionId');
  if (guard) return guard;
  const row = readRow(ctx, input.provisionId);
  if (row === undefined) return err('not_found', { provisionId: input.provisionId });
  const releases = releasesOf(ctx, row.id);
  const provision = viewOf(ctx, row, releases);
  return ok({
    provision,
    lines: linesView(ctx, row),
    releases: releases.map((r) => releaseViewOf(ctx, r)),
    openBalanceMinor: provision.openBalanceMinor,
  });
}

export interface ProvisionListInput {
  periodEnd?: string;
  status?: string;
  reason?: string;
  savedViewId?: string;
}

export function provisionList(ctx: WorkspaceContext, input: ProvisionListInput = {}): Result {
  const capable = ctx.capabilities.assert('read_books');
  if (!capable.ok) return capable;
  const guard =
    optionalId(input.periodEnd, 'periodEnd') ??
    optionalId(input.status, 'status') ??
    optionalId(input.reason, 'reason') ??
    optionalId(input.savedViewId, 'savedViewId');
  if (guard) return guard;
  if (input.periodEnd !== undefined) {
    const dateGuard = requireDate(input.periodEnd, 'periodEnd');
    if (dateGuard) return dateGuard;
  }
  const viewed = applySavedView(ctx, PROVISION_ENTITY_KIND, input);
  if (!viewed.ok) return viewed;
  const filter = viewed.filter;
  if (filter.status !== undefined && !(PROVISION_STATUSES as readonly string[]).includes(filter.status)) {
    return err('invalid_input', { field: 'status', allowed: [...PROVISION_STATUSES] });
  }
  if (filter.reason !== undefined && !isProvisionReason(filter.reason)) {
    return err('invalid_reason', { reason: filter.reason, allowed: [...PROVISION_REASONS] });
  }

  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (filter.periodEnd !== undefined) {
    clauses.push('period_end = ?');
    params.push(filter.periodEnd);
  }
  // `posted` and `released` are one stored family told apart by the balance (`statusOf`), so the
  // SQL narrows to the family and the derived status decides; the other three are stored as read.
  const balanceStatus = filter.status === 'posted' || filter.status === 'released';
  if (filter.status !== undefined) {
    if (balanceStatus) {
      clauses.push("status IN ('posted', 'released')");
    } else {
      clauses.push('status = ?');
      params.push(filter.status);
    }
  }
  if (filter.reason !== undefined) {
    clauses.push('reason = ?');
    params.push(filter.reason);
  }
  const rows = ctx.store.db
    .prepare(`SELECT ${COLUMNS} FROM provision WHERE ${clauses.join(' AND ')} ORDER BY period_end DESC, created_at ASC, id ASC`)
    .all(...params) as ProvisionRow[];
  const provisions = rows
    .map((r) => viewOf(ctx, r, releasesOf(ctx, r.id)))
    .filter((p) => !balanceStatus || p.status === filter.status);
  const openTotalMinor = provisions.reduce((s, p) => s + p.openBalanceMinor, 0);
  return ok({ provisions, openTotalMinor, baseCurrency: baseCurrencyOf(ctx) });
}

export interface ProvisionDiscardInput {
  provisionId: string;
  reason?: string;
  idempotencyKey: string;
}

export function provisionDiscard(ctx: WorkspaceContext, input: ProvisionDiscardInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.provisionId, 'provisionId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalText(input.reason, 'reason');
  if (guard) return guard;
  const row = readRow(ctx, input.provisionId);
  if (row === undefined) return err('not_found', { provisionId: input.provisionId });
  if (row.status === 'discarded') {
    if (row.reverse_idempotency_key === input.idempotencyKey) return ok({ provision: viewOf(ctx, row, []) });
    return err('draft_discarded', { provisionId: row.id, discardedAt: row.discarded_at });
  }
  if (row.status !== 'draft') return err('already_posted', { provisionId: row.id, entryId: row.entry_id });
  const at = ctx.clock.now();
  ctx.store.tx(() => {
    ctx.store.db
      .prepare(
        `UPDATE provision SET status = 'discarded', discarded_at = ?, discard_reason = ?, reverse_idempotency_key = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(at, input.reason ?? null, input.idempotencyKey, at, ctx.workspaceId, row.id);
    ctx.audit.record({ entityKind: 'provision', entityId: row.id, action: 'discard', actor: ctx.actor, at });
  });
  const after = readRow(ctx, row.id) ?? row;
  return ok({ provision: viewOf(ctx, after, []) });
}

export interface ProvisionPostInput {
  provisionId: string;
  idempotencyKey: string;
}

/** Post the formation: ONE entry (Dr expense / Cr provision) dated `periodEnd`. No auto-reversal. */
export function provisionPost(ctx: WorkspaceContext, input: ProvisionPostInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard = requireString(input.provisionId, 'provisionId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const row = readRow(ctx, input.provisionId);
  if (row === undefined) return err('not_found', { provisionId: input.provisionId });
  if (row.status === 'discarded') return err('draft_discarded', { provisionId: row.id, discardedAt: row.discarded_at });
  if (row.status !== 'draft') {
    if (row.post_idempotency_key === input.idempotencyKey && row.entry_id !== null) {
      return ok({ provisionId: row.id, entryId: row.entry_id, provision: viewOf(ctx, row, releasesOf(ctx, row.id)) });
    }
    return err('already_posted', { provisionId: row.id, entryId: row.entry_id, postedAt: row.posted_at });
  }

  const lines = provisionLinesOf({ amountMinor: row.amount_minor, provisionAccountId: row.provision_account_id, expenseAccountId: row.expense_account_id });
  return runGuarded(() =>
    ctx.store.tx(() => {
      const posted = postEntry(ctx, {
        date: row.period_end,
        source: PROVISION_SOURCE,
        idempotencyKey: `provision:${row.id}`,
        description: `Rückstellung (${row.reason}): ${row.description}`,
        lines,
      });
      if (!posted.ok) throw new ProvisionAbort(err(posted.error, { ...posted, date: row.period_end }));
      const at = ctx.clock.now();
      ctx.store.db
        .prepare(
          `UPDATE provision SET status = 'posted', entry_id = ?, post_idempotency_key = ?, posted_at = ?, posted_by = ?, updated_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(posted.entryId, input.idempotencyKey, at, ctx.actor, at, ctx.workspaceId, row.id);
      ctx.audit.record({ entityKind: 'provision', entityId: row.id, action: 'post', actor: ctx.actor, at });
      const after = readRow(ctx, row.id) ?? row;
      return ok({ provisionId: row.id, entryId: posted.entryId, provision: viewOf(ctx, after, []) });
    }),
  );
}

export interface ProvisionReleaseInput {
  provisionId: string;
  date: string;
  amountMinor: number;
  /** Account NUMBER or id of the P&L account the release is credited to. */
  targetAccount: string;
  idempotencyKey: string;
}

/**
 * What a successful release sends back. Declared: `openBalanceMinor` is the figure the provisions
 * list renders after an Auflösung, and a caller that read `openBalance` (francs, or nothing) must be
 * refused at compile time rather than render `undefined`.
 */
export type ProvisionReleaseOk = {
  readonly releaseId: string;
  readonly provisionId: string;
  readonly entryId: string;
  /** What is still provided for after this release, in minor units. Zero means fully released. */
  readonly openBalanceMinor: number;
  readonly provision: ProvisionView;
};

/** Release part or all of a posted provision: Dr provision / Cr target, one entry. */
export function provisionRelease(ctx: WorkspaceContext, input: ProvisionReleaseInput): Result<ProvisionReleaseOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.provisionId, 'provisionId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    requireDate(input.date, 'date') ??
    requireString(input.targetAccount, 'targetAccount');
  if (guard) return guard;
  if (!isPositiveMinor(input.amountMinor)) {
    return err('invalid_amount', { amountMinor: input.amountMinor, reason: 'a positive integer of minor units' });
  }

  const row = readRow(ctx, input.provisionId);
  if (row === undefined) return err('not_found', { provisionId: input.provisionId });

  // §H-IDEMPOTENT: the same key replays the release it made, for as long as that release stands.
  const replay = ctx.store.db
    .prepare('SELECT id FROM provision_release WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, input.idempotencyKey) as { id: string } | undefined;
  if (replay !== undefined) {
    const releases = releasesOf(ctx, row.id);
    const mine = releases.find((r) => r.id === replay.id);
    if (mine !== undefined) {
      // A key names ONE release. Once that release is undone through `provision_release_reverse`,
      // replaying the key would answer ok with an entry the ledger has already reversed, booking
      // nothing while the caller reads a release that no longer counts. The key is spent: refuse by
      // name and send the caller to a fresh key, the shape `vat_settlement_post` uses for a spent
      // settlement key (critic finding, LOW, 2026-09-10).
      if (mine.reversed_by_entry_id !== null) {
        return err('already_reversed_key', {
          provisionId: row.id,
          releaseId: mine.id,
          entryId: mine.entry_id,
          reversalEntryId: mine.reversed_by_entry_id,
          idempotencyKey: input.idempotencyKey,
          remedy: 'the key names a release that was undone; release again under a NEW idempotencyKey',
        });
      }
      const provision = viewOf(ctx, row, releases);
      return ok<ProvisionReleaseOk>({ releaseId: mine.id, provisionId: row.id, entryId: mine.entry_id, openBalanceMinor: provision.openBalanceMinor, provision });
    }
    // The key names a release of ANOTHER provision: refuse it by name before the tx, where the
    // `UNIQUE (workspace_id, idempotency_key)` on the INSERT would otherwise have surfaced as
    // `unexpected_error` after the entry was already posted inside the transaction and rolled back.
    return err('invalid_input', { field: 'idempotencyKey', reason: 'key_bound_to_another_provision', provisionId: row.id });
  }

  if (row.status === 'draft') return err('not_posted', { provisionId: row.id, status: row.status });
  if (row.status === 'discarded') return err('draft_discarded', { provisionId: row.id, discardedAt: row.discarded_at });
  if (row.status === 'reversed') return err('already_reversed', { provisionId: row.id, reversalEntryId: row.reversal_entry_id });

  const target = findAccount(ctx, input.targetAccount);
  if (target === undefined) return err('invalid_account', { account: input.targetAccount, reason: 'target_not_found' });
  if (target.type !== 'income' && target.type !== 'expense') {
    return err('invalid_account', { account: target.number, type: target.type, reason: 'target_must_be_income_or_expense' });
  }
  if (target.archived === 1) return err('invalid_account', { account: target.number, reason: 'archived' });

  const before = releasesOf(ctx, row.id);
  const open = openBalanceOf(row, before);
  if (input.amountMinor > open) {
    return err('release_exceeds_balance', { provisionId: row.id, amountMinor: input.amountMinor, openBalanceMinor: open });
  }

  const releaseId = ctx.ids.next('provrel');
  const lines = releaseLinesOf({ amountMinor: input.amountMinor, provisionAccountId: row.provision_account_id, targetAccountId: target.id });
  return runGuarded(() =>
    ctx.store.tx(() => {
      const posted = postEntry(ctx, {
        date: input.date,
        source: PROVISION_SOURCE,
        idempotencyKey: `provision-release:${releaseId}`,
        description: `Auflösung Rückstellung (${row.reason}): ${row.description}`,
        ...(row.entry_id !== null ? { ref: row.entry_id } : {}),
        lines,
      });
      if (!posted.ok) throw new ProvisionAbort(err(posted.error, { ...posted, date: input.date }));
      const at = ctx.clock.now();
      ctx.store.db
        .prepare(
          `INSERT INTO provision_release (id, workspace_id, provision_id, release_date, amount_minor, target_account_id, entry_id, idempotency_key, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(releaseId, ctx.workspaceId, row.id, input.date, input.amountMinor, target.id, posted.entryId, input.idempotencyKey, ctx.actor, at);
      // No status flip at zero: `released` is derived on read from the live releases (`statusOf`),
      // so a release undone through `provision_release_reverse` reads `posted` again with its balance.
      ctx.audit.record({ entityKind: 'provision', entityId: row.id, action: 'release', actor: ctx.actor, at });
      const after = readRow(ctx, row.id) ?? row;
      const provision = viewOf(ctx, after, releasesOf(ctx, row.id));
      return ok<ProvisionReleaseOk>({ releaseId, provisionId: row.id, entryId: posted.entryId, openBalanceMinor: provision.openBalanceMinor, provision });
    }),
  );
}

export interface ProvisionReleaseReverseInput {
  releaseId: string;
  /** The reversal date; defaults to the release's own date (OR 957a: a correction in the period). */
  date?: string;
  reason?: string;
  idempotencyKey: string;
}

export type ProvisionReleaseReverseOk = {
  readonly releaseId: string;
  readonly provisionId: string;
  /** The mirror of the release entry, now posted. Stable across an idempotent retry of the same key. */
  readonly reversalEntryId: string;
  readonly openBalanceMinor: number;
  readonly provision: ProvisionView;
};

/**
 * Undo ONE release with a real reversing entry, the only door to a release's mirror (the raw
 * `reverse_entry` refuses `owned_by provision_release_reverse`). Nothing is stored for it: the
 * derivation (`releasesOf`) reads the mirror off the journal's `reverses_entry_id`, so the open
 * balance and the `posted` / `released` reading follow at once. Refuses `not_found` (§H-TENANT) and
 * `already_reversed`; the same key replays the mirror it made.
 */
export function provisionReleaseReverse(ctx: WorkspaceContext, input: ProvisionReleaseReverseInput): Result<ProvisionReleaseReverseOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.releaseId, 'releaseId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalDate(input.date, 'date') ??
    optionalText(input.reason, 'reason');
  if (guard) return guard;

  const link = ctx.store.db
    .prepare('SELECT provision_id FROM provision_release WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.releaseId) as { provision_id: string } | undefined;
  if (link === undefined) return err('not_found', { releaseId: input.releaseId });
  const row = readRow(ctx, link.provision_id);
  if (row === undefined) return err('not_found', { releaseId: input.releaseId });
  const release = releasesOf(ctx, row.id).find((r) => r.id === input.releaseId);
  if (release === undefined) return err('not_found', { releaseId: input.releaseId });
  const wasLive = release.reversed_by_entry_id === null;

  const date = input.date ?? release.release_date;
  const description =
    input.reason === undefined
      ? `Storno Auflösung Rückstellung (${row.reason}): ${row.description}`
      : `Storno Auflösung Rückstellung (${row.reason}): ${row.description} (${input.reason})`;
  return runGuarded(() =>
    ctx.store.tx(() => {
      // `reverseOwnedEntry` owns the idempotency of the mirror: the same key replays it, another key
      // on an already-mirrored release is `already_reversed`, named here with the release.
      const reversal = reverseOwnedEntry(ctx, { entryId: release.entry_id, date, idempotencyKey: input.idempotencyKey, description }, RELEASE_OWNER);
      if (!reversal.ok) {
        if (reversal.error === 'already_reversed') {
          throw new ProvisionAbort(err('already_reversed', { releaseId: release.id, provisionId: row.id, reversalEntryId: release.reversed_by_entry_id }));
        }
        throw new ProvisionAbort(err(reversal.error, { ...reversal, releaseId: release.id, date }));
      }
      if (wasLive) {
        ctx.audit.record({ entityKind: PROVISION_ENTITY_KIND, entityId: row.id, action: 'release_reverse', actor: ctx.actor, at: ctx.clock.now() });
      }
      const after = readRow(ctx, row.id) ?? row;
      const provision = viewOf(ctx, after, releasesOf(ctx, row.id));
      return ok<ProvisionReleaseReverseOk>({
        releaseId: release.id,
        provisionId: row.id,
        reversalEntryId: reversal.reversalId,
        openBalanceMinor: provision.openBalanceMinor,
        provision,
      });
    }),
  );
}

export interface ProvisionReverseInput {
  provisionId: string;
  /** The reversal date; defaults to `periodEnd`, the formation's own date (OR 957a: a correction in the period). */
  date?: string;
  reason?: string;
  idempotencyKey: string;
}

/** Reverse the formation entry (a `reverseEntry`), refused while any release stands. */
export function provisionReverse(ctx: WorkspaceContext, input: ProvisionReverseInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.provisionId, 'provisionId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalDate(input.date, 'date') ??
    optionalText(input.reason, 'reason');
  if (guard) return guard;
  const row = readRow(ctx, input.provisionId);
  if (row === undefined) return err('not_found', { provisionId: input.provisionId });
  if (row.status === 'draft' || row.status === 'discarded') return err('not_posted', { provisionId: row.id, status: row.status });
  if (row.status === 'reversed') {
    if (row.reverse_idempotency_key === input.idempotencyKey && row.reversal_entry_id !== null) {
      return ok({ provisionId: row.id, reversalEntryId: row.reversal_entry_id, provision: viewOf(ctx, row, []) });
    }
    return err('already_reversed', { provisionId: row.id, reversalEntryId: row.reversal_entry_id, reversedAt: row.reversed_at });
  }
  if (row.entry_id === null) return err('not_posted', { provisionId: row.id, status: row.status });
  const formationEntryId = row.entry_id;

  const live = releasesOf(ctx, row.id).filter((r) => r.reversed_by_entry_id === null);
  if (live.length > 0) {
    // Newest first: the order they have to be reversed in (the H04 `later_run_exists` shape).
    return err('release_blocked', {
      provisionId: row.id,
      releases: [...live].reverse().map((r) => ({ releaseId: r.id, entryId: r.entry_id, date: r.release_date, amountMinor: r.amount_minor })),
    });
  }

  const date = input.date ?? row.period_end;
  return runGuarded(() =>
    ctx.store.tx(() => {
      const reversal = reverseOwnedEntry(
        ctx,
        {
          entryId: formationEntryId,
          date,
          idempotencyKey: `provision-rev:${row.id}`,
          description: input.reason === undefined ? `Storno Rückstellung: ${row.description}` : `Storno Rückstellung: ${row.description} (${input.reason})`,
        },
        PROVISION_OWNER,
      );
      if (!reversal.ok) throw new ProvisionAbort(err(reversal.error, { ...reversal, date }));
      const at = ctx.clock.now();
      ctx.store.db
        .prepare(
          `UPDATE provision SET status = 'reversed', reversal_entry_id = ?, reverse_idempotency_key = ?, reversed_at = ?, reversed_by = ?, reverse_reason = ?, updated_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .run(reversal.reversalId, input.idempotencyKey, at, ctx.actor, input.reason ?? null, at, ctx.workspaceId, row.id);
      ctx.audit.record({ entityKind: 'provision', entityId: row.id, action: 'reverse', actor: ctx.actor, at });
      const after = readRow(ctx, row.id) ?? row;
      return ok({ provisionId: row.id, reversalEntryId: reversal.reversalId, provision: viewOf(ctx, after, []) });
    }),
  );
}
