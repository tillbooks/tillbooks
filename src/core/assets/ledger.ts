/**
 * H07, the fixed-asset LEDGER reads + the opening-balance write.
 *
 * H07 owns the permanent OP11 guarantee for fixed assets, and its READ half is here: the complete,
 * chronological ledger of every financial event on an asset with running cost / accumulated / net-book
 * balances (`assetLedgerGet`, US-H07.1), and the cross-asset event list with journal links
 * (`assetLedgerList`, US-H07.4). Both are DERIVED from the append-only `asset_transaction` sub-ledger
 * (`transactionSchema.ts`), which already carries EVERY financial event: H02 writes the acquisition /
 * additional-capitalisation rows, H04's run writes one `type='depreciation'` row per asset, H06 writes
 * the terminal `type='disposal'` row, and H07's own `asset_opening_balance` writes the one `type='opening'`
 * row. There is no second store and no cached total to diverge (§4 invariant 5); the running balance is
 * `Σ delta_cost_rappen` for cost, `Σ delta_accum_depr_rappen` for accumulated, and `cost − accumulated`
 * for NBV, taken in effective-date order. Every read is workspace-scoped (§H-TENANT): a foreign asset id
 * resolves to nothing, never to its rows.
 *
 * The one WRITE, `assetOpeningBalance` (US-H07.5), is the migration seam: it records the historical cost
 * and accumulated depreciation of an asset that already exists in the real world, so the identity
 * invariants hold from day one. IT IS THE MONEY PATH and follows H02's acquisition discipline exactly:
 *
 *  - It posts ONE balanced GL journal through A02 `postEntry` (the ONLY posting path, P3): Dr the asset
 *    cost account for `cost_rappen`, Cr the accumulated-depreciation account for `accumulated_depr_rappen`
 *    (only when > 0), and Cr the caller's `offset_account_id` equity account for the net book value
 *    (`cost − accumulated`). So the GL moves the SAME two control accounts the opening sub-ledger row
 *    moves, and the reconciliation (`reconciliation.ts`) is balanced for the opening period by
 *    construction. `postEntry` runs INSIDE this verb's transaction; a refusal at any step THROWS so the
 *    whole dual write rolls back (returning `{ok:false}` from inside `ctx.store.tx` would COMMIT the
 *    partial write, the acquisition.ts precedent).
 *  - APPEND-ONLY (§H-AUDIT): the posted journal is immutable (A02's triggers) and the `asset_transaction`
 *    row is immutable (its own triggers). A wrong opening is corrected by a reversing entry plus a
 *    compensating transaction, never a destructive edit.
 *  - IDEMPOTENT ON ROWS (§H-IDEMPOTENT): the whole dual write runs inside one `rememberIdempotent`, so a
 *    replay of the same key returns the original objects and posts EXACTLY ONE journal and writes EXACTLY
 *    ONE row.
 *  - PERIOD-LOCKED (§H-PERIOD): an opening dated in a hard-locked period is refused before anything is
 *    written.
 *
 * The opening journal carries `source='asset_acquisition'` (an opening balance capitalises a pre-existing
 * asset); the sub-ledger row's own `type='opening'` keeps it distinguishable, so no new §H-ENUM journal
 * source is minted for it.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { postEntry } from '../ledger/postEntry.js';
import { getEntry } from '../ledger/reads.js';

/** An ISO calendar date `YYYY-MM-DD`, the shape A02 dates already use. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The account types the opening-balance OFFSET (the net-book-value counter-entry) may carry: equity is
 * the ordinary case (an Eröffnungsbilanz / opening-equity account), a liability the occasional one. Never
 * an asset (that would be a second asset), and never income/expense (a P&L account is not an opening
 * position). Mirrors acquisition.ts's CREDIT_ACCOUNT_TYPES discipline; the engine is the gate. */
const OFFSET_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['equity', 'liability']);

/** The full set of §H-ENUM asset-transaction types, for the `assetLedgerList` `type` filter. A supplied
 * value outside this set is `invalid_input` rather than a silently-empty result. */
const ASSET_TRANSACTION_TYPES: ReadonlySet<string> = new Set([
  'acquisition',
  'additional_capitalisation',
  'opening',
  'depreciation',
  'disposal',
  'revaluation',
  'adjustment',
]);

interface AssetRow {
  id: string;
  workspace_id: string;
  number: string;
  name: string;
  status: string;
  acquisition_date: string;
  acquisition_cost_rappen: number;
  residual_value_rappen: number;
  accumulated_depr_rappen: number;
  net_book_value_rappen: number;
  gl_asset_account_id: string;
  gl_accum_depr_account_id: string;
}

interface TransactionRow {
  id: string;
  workspace_id: string;
  asset_id: string;
  type: string;
  date: string;
  delta_cost_rappen: number;
  delta_accum_depr_rappen: number;
  proceeds_rappen: number | null;
  gain_loss_rappen: number | null;
  journal_entry_id: string;
  source_document_type: string | null;
  source_document_id: string | null;
  description: string | null;
  created_at: string;
  created_by: string | null;
  idempotency_key: string | null;
}

/** A ledger EVENT: one sub-ledger row plus the running balances AFTER it. The camelCase boundary the
 * Studio and the MCP layer read. */
interface LedgerEvent {
  id: string;
  assetId: string;
  type: string;
  date: string;
  deltaCostRappen: number;
  deltaAccumDeprRappen: number;
  proceedsRappen: number | null;
  gainLossRappen: number | null;
  journalEntryId: string;
  sourceDocumentType: string | null;
  sourceDocumentId: string | null;
  description: string | null;
  createdAt: string;
  createdBy: string | null;
  /** Running cost / accumulated depreciation / net book value AFTER this event (Rappen). */
  costAfterRappen: number;
  accumulatedDeprAfterRappen: number;
  netBookValueAfterRappen: number;
}

function readAsset(ctx: WorkspaceContext, id: string): AssetRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, workspace_id, number, name, status, acquisition_date, acquisition_cost_rappen,
              residual_value_rappen, accumulated_depr_rappen, net_book_value_rappen,
              gl_asset_account_id, gl_accum_depr_account_id
         FROM asset WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, id) as AssetRow | undefined;
}

/** An account IN THIS WORKSPACE, or undefined (§H-TENANT: a foreign id resolves to undefined). */
function readAccount(ctx: WorkspaceContext, id: string): { id: string; type: string } | undefined {
  return ctx.store.db
    .prepare('SELECT id, type FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as { id: string; type: string } | undefined;
}

/**
 * Fold a chronologically-ordered run of sub-ledger rows into ledger events with running balances. The
 * order (effective date, then insertion order, then id) is the same the sub-ledger reads already use,
 * so the running NBV is the book value AS AT each event. Money never leaves integer Rappen.
 */
function foldEvents(rows: TransactionRow[]): LedgerEvent[] {
  let cost = 0;
  let accum = 0;
  const events: LedgerEvent[] = [];
  for (const row of rows) {
    cost += row.delta_cost_rappen;
    accum += row.delta_accum_depr_rappen;
    events.push({
      id: row.id,
      assetId: row.asset_id,
      type: row.type,
      date: row.date,
      deltaCostRappen: row.delta_cost_rappen,
      deltaAccumDeprRappen: row.delta_accum_depr_rappen,
      proceedsRappen: row.proceeds_rappen,
      gainLossRappen: row.gain_loss_rappen,
      journalEntryId: row.journal_entry_id,
      sourceDocumentType: row.source_document_type,
      sourceDocumentId: row.source_document_id,
      description: row.description,
      createdAt: row.created_at,
      createdBy: row.created_by,
      costAfterRappen: cost,
      accumulatedDeprAfterRappen: accum,
      netBookValueAfterRappen: cost - accum,
    });
  }
  return events;
}

/**
 * US-H07.1: the complete chronological ledger for ONE asset, every event with a running balance and its
 * GL journal link. A disposed asset keeps its full history (the disposal row zeroes the running totals
 * but nothing is purged). §H-TENANT: a foreign asset id is `not_found`.
 */
export function assetLedgerGet(ctx: WorkspaceContext, input: { assetId?: string }): Result {
  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    return err('invalid_input', { field: 'assetId' });
  }
  const asset = readAsset(ctx, input.assetId);
  if (asset === undefined) return err('not_found', { assetId: input.assetId });

  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM asset_transaction
        WHERE workspace_id = ? AND asset_id = ?
        ORDER BY date, created_at, id`,
    )
    .all(ctx.workspaceId, input.assetId) as TransactionRow[];
  const events = foldEvents(rows);

  return ok({
    asset: {
      id: asset.id,
      number: asset.number,
      name: asset.name,
      status: asset.status,
      acquisitionDate: asset.acquisition_date,
      acquisitionCostRappen: asset.acquisition_cost_rappen,
      accumulatedDeprRappen: asset.accumulated_depr_rappen,
      netBookValueRappen: asset.net_book_value_rappen,
      glAssetAccountId: asset.gl_asset_account_id,
      glAccumDeprAccountId: asset.gl_accum_depr_account_id,
    },
    events,
    total: events.length,
  });
}

export interface AssetLedgerListInput {
  assetId?: string;
  type?: string | string[];
  fromDate?: string;
  toDate?: string;
  journalEntryId?: string;
  limit?: number;
  offset?: number;
}

/**
 * US-H07.4: the cross-asset event list, filtered by asset, type(s), a date window and/or a journal id,
 * with simple limit/offset pagination. Every row is workspace-scoped (§H-TENANT). Unlike `assetLedgerGet`
 * this is a flat list, so the running balance is NOT attached (it is only meaningful within one asset's
 * ordered history); callers that need the running NBV open the per-asset ledger.
 */
export function assetLedgerList(ctx: WorkspaceContext, input: AssetLedgerListInput): Result {
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];

  if (input.assetId !== undefined) {
    if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
      return err('invalid_input', { field: 'assetId' });
    }
    clauses.push('asset_id = ?');
    params.push(input.assetId);
  }

  if (input.type !== undefined) {
    const types = Array.isArray(input.type) ? input.type : [input.type];
    for (const t of types) {
      if (typeof t !== 'string' || !ASSET_TRANSACTION_TYPES.has(t)) {
        return err('invalid_input', { field: 'type', allowed: [...ASSET_TRANSACTION_TYPES] });
      }
    }
    if (types.length > 0) {
      clauses.push(`type IN (${types.map(() => '?').join(', ')})`);
      params.push(...types);
    }
  }

  if (input.fromDate !== undefined) {
    if (typeof input.fromDate !== 'string' || !ISO_DATE.test(input.fromDate)) {
      return err('invalid_input', { field: 'fromDate' });
    }
    clauses.push('date >= ?');
    params.push(input.fromDate);
  }
  if (input.toDate !== undefined) {
    if (typeof input.toDate !== 'string' || !ISO_DATE.test(input.toDate)) {
      return err('invalid_input', { field: 'toDate' });
    }
    clauses.push('date <= ?');
    params.push(input.toDate);
  }
  if (input.journalEntryId !== undefined) {
    if (typeof input.journalEntryId !== 'string' || input.journalEntryId.length === 0) {
      return err('invalid_input', { field: 'journalEntryId' });
    }
    clauses.push('journal_entry_id = ?');
    params.push(input.journalEntryId);
  }

  const where = clauses.join(' AND ');
  const total = (
    ctx.store.db
      .prepare(`SELECT COUNT(*) AS n FROM asset_transaction WHERE ${where}`)
      .get(...params) as { n: number }
  ).n;

  // Pagination: a non-negative integer limit (default 100, capped 500) and offset (default 0). A bad
  // value is a defect the caller must see, never a silently clamped page.
  let limit = 100;
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 0) return err('invalid_input', { field: 'limit' });
    limit = Math.min(input.limit, 500);
  }
  let offset = 0;
  if (input.offset !== undefined) {
    if (!Number.isInteger(input.offset) || input.offset < 0) return err('invalid_input', { field: 'offset' });
    offset = input.offset;
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM asset_transaction WHERE ${where} ORDER BY date DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as TransactionRow[];

  const items = rows.map((row) => ({
    id: row.id,
    assetId: row.asset_id,
    type: row.type,
    date: row.date,
    deltaCostRappen: row.delta_cost_rappen,
    deltaAccumDeprRappen: row.delta_accum_depr_rappen,
    proceedsRappen: row.proceeds_rappen,
    gainLossRappen: row.gain_loss_rappen,
    journalEntryId: row.journal_entry_id,
    sourceDocumentType: row.source_document_type,
    sourceDocumentId: row.source_document_id,
    description: row.description,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }));

  return ok({ items, total });
}

/** Abort the write transaction with a structured cause, so nothing is committed or memoised on a
 * rejection discovered after the transaction opened (the acquisition.ts `AcquisitionAbort` shape). */
class OpeningAbort {
  constructor(public readonly result: Result) {}
}

function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof OpeningAbort) return e.result;
    throw e;
  }
}

/** Does any acquisition OR opening event already exist for this asset? Either one means the asset has a
 * financial baseline already; a second seeding would double the cost. */
function financialEventExists(ctx: WorkspaceContext, assetId: string): 'acquisition' | 'opening' | null {
  const row = ctx.store.db
    .prepare(
      "SELECT type FROM asset_transaction WHERE workspace_id = ? AND asset_id = ? AND type IN ('acquisition', 'opening') LIMIT 1",
    )
    .get(ctx.workspaceId, assetId) as { type: string } | undefined;
  if (row === undefined) return null;
  return row.type === 'opening' ? 'opening' : 'acquisition';
}

function mapAssetFull(row: Record<string, unknown>) {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    categoryId: row.category_id,
    status: row.status,
    acquisitionDate: row.acquisition_date,
    acquisitionCostRappen: row.acquisition_cost_rappen,
    residualValueRappen: row.residual_value_rappen,
    usefulLifeMonths: row.useful_life_months,
    depreciationMethod: row.depreciation_method,
    glAssetAccountId: row.gl_asset_account_id,
    glAccumDeprAccountId: row.gl_accum_depr_account_id,
    glDeprExpenseAccountId: row.gl_depr_expense_account_id,
    accumulatedDeprRappen: row.accumulated_depr_rappen,
    netBookValueRappen: row.net_book_value_rappen,
  };
}

function mapTransaction(row: TransactionRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    assetId: row.asset_id,
    type: row.type,
    date: row.date,
    deltaCostRappen: row.delta_cost_rappen,
    deltaAccumDeprRappen: row.delta_accum_depr_rappen,
    proceedsRappen: row.proceeds_rappen,
    gainLossRappen: row.gain_loss_rappen,
    journalEntryId: row.journal_entry_id,
    sourceDocumentType: row.source_document_type,
    sourceDocumentId: row.source_document_id,
    description: row.description,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export interface AssetOpeningBalanceInput {
  assetId?: string;
  date?: string;
  costRappen?: number;
  accumulatedDeprRappen?: number;
  offsetAccountId?: string | null;
  description?: string | null;
  idempotencyKey?: string;
}

/**
 * US-H07.5: seed an asset's opening cost + accumulated depreciation as one balanced GL entry plus one
 * append-only `type='opening'` sub-ledger row, so the identity invariants and the recon report hold from
 * the opening period. See the module header for the full money-path discipline.
 */
export function assetOpeningBalance(ctx: WorkspaceContext, input: AssetOpeningBalanceInput): Result {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  // Replay a completed opening BEFORE any state-dependent guard (§H-IDEMPOTENT), so a retry returns the
  // original objects instead of tripping `already_opened` on the event it itself wrote.
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_opening_balance');
  if (replayed !== undefined) return replayed;

  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    return err('invalid_input', { field: 'assetId' });
  }
  const asset = readAsset(ctx, input.assetId);
  if (asset === undefined) return err('not_found', { assetId: input.assetId });

  const date = typeof input.date === 'string' ? input.date.trim() : '';
  if (date.length === 0 || !ISO_DATE.test(date)) return err('invalid_input', { field: 'date' });

  const cost = input.costRappen;
  if (typeof cost !== 'number' || !Number.isInteger(cost) || cost <= 0) {
    return err('invalid_input', { field: 'costRappen' });
  }
  const accum = input.accumulatedDeprRappen ?? 0;
  if (typeof accum !== 'number' || !Number.isInteger(accum) || accum < 0 || accum > cost) {
    return err('invalid_input', { field: 'accumulatedDeprRappen', reason: 'must be an integer in 0..cost' });
  }

  // An opening seeds a draft asset that has no financial event yet. A disposed / archived asset, or one
  // already acquired or opened, is refused (a second seeding would double the cost basis).
  if (asset.status === 'disposed' || asset.status === 'archived') {
    return err('asset_not_acquirable', { assetId: input.assetId, status: asset.status });
  }
  const existing = financialEventExists(ctx, asset.id);
  if (existing === 'opening') return err('already_opened', { assetId: input.assetId });
  if (existing === 'acquisition' || asset.status === 'fully_depreciated') {
    return err('already_acquired', { assetId: input.assetId });
  }

  // The net book value carried to the offset (equity/opening) account. When cost === accumulated the
  // asset is fully depreciated at opening and no offset line is needed; otherwise the offset account is
  // required, and must be a real account in this workspace (§H-TENANT).
  const nbv = cost - accum;
  let offsetAccountId: string | null = null;
  if (nbv > 0) {
    if (typeof input.offsetAccountId !== 'string' || input.offsetAccountId.length === 0) {
      return err('invalid_offset_account', { reason: 'required when cost exceeds accumulated depreciation' });
    }
    const off = readAccount(ctx, input.offsetAccountId);
    if (off === undefined) {
      return err('invalid_offset_account', { offsetAccountId: input.offsetAccountId, reason: 'not_found' });
    }
    // The offset carries the net book value on the CREDIT side of an opening entry: an equity/opening
    // account (the ordinary case) or a liability, never a P&L account. It must NOT be the asset's own
    // cost or accumulated-depreciation control account: crediting a control account here would move the
    // GL against the sub-ledger and make the recon drift, which is exactly the "balanced by construction"
    // guarantee this verb owes (the recon would catch it, but a caller must not be able to author drift).
    if (!OFFSET_ACCOUNT_TYPES.has(off.type)) {
      return err('invalid_offset_account', { offsetAccountId: input.offsetAccountId, type: off.type, expected: [...OFFSET_ACCOUNT_TYPES] });
    }
    if (input.offsetAccountId === asset.gl_asset_account_id || input.offsetAccountId === asset.gl_accum_depr_account_id) {
      return err('invalid_offset_account', { offsetAccountId: input.offsetAccountId, reason: 'is_a_control_account' });
    }
    offsetAccountId = input.offsetAccountId;
  }

  const description =
    typeof input.description === 'string' && input.description.trim() !== '' ? input.description.trim() : null;

  // §H-PERIOD, checked BEFORE the write opens so a locked date rejects with nothing half-done.
  const periodOpen = ctx.periods.assertOpen(date);
  if (!periodOpen.ok) return periodOpen;

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'asset_opening_balance', () => {
      const txnId = ctx.ids.next('atxn');

      // The balanced opening entry: Dr asset cost, Cr accumulated depreciation (when > 0), Cr the offset
      // for the net book value. `postEntry` runs INSIDE this transaction; on any refusal we THROW so the
      // whole dual write rolls back. The key is scoped to THIS transaction id, unguessable, so it can
      // never collide with a raw post_entry key.
      const lines: { account: string; debit?: number; credit?: number }[] = [
        { account: asset.gl_asset_account_id, debit: cost },
      ];
      if (accum > 0) lines.push({ account: asset.gl_accum_depr_account_id, credit: accum });
      if (nbv > 0 && offsetAccountId !== null) lines.push({ account: offsetAccountId, credit: nbv });

      const posted = postEntry(ctx, {
        date,
        source: 'asset_acquisition',
        description: description ?? `Eröffnungsbilanz Anlage ${asset.number}`,
        idempotencyKey: JSON.stringify(['asset_opening_entry', txnId]),
        lines,
      });
      if (!posted.ok) throw new OpeningAbort(posted);
      const entryId = posted.entryId;

      // Trust nothing, including our own posting path: read the entry back and assert it is a posted,
      // balanced entry that debits the asset account by the cost and credits the accumulated account by
      // the accumulated. This is the check that makes "the opening reconciles" bite.
      const check = getEntry(ctx, { entryId });
      if (!check.ok) throw new OpeningAbort(check);
      const entryLines = check.lines;
      const debit = entryLines.reduce((s, l) => s + l.debit, 0);
      const credit = entryLines.reduce((s, l) => s + l.credit, 0);
      const drCost = entryLines.find((l) => l.account === asset.gl_asset_account_id && l.debit === cost);
      const crAccum =
        accum === 0 || entryLines.some((l) => l.account === asset.gl_accum_depr_account_id && l.credit === accum);
      if (debit !== credit || debit !== cost || drCost === undefined || !crAccum) {
        throw new OpeningAbort(
          err('posting_verification_failed', { entryId, reason: 'entry_is_not_the_planned_opening' }),
        );
      }

      const now = ctx.clock.now();

      // Move the asset out of draft and set its baseline, GUARDED on the still-draft status. This UPDATE
      // is the IN-TRANSACTION race check: its WHERE re-reads the CURRENT committed status, so a second
      // concurrent writer (D12: Studio + a `till mcp` subprocess on one SQLite file) that read a null
      // baseline OUT of transaction before the first writer committed now touches 0 rows and aborts
      // cleanly with already_opened. It runs BEFORE the opening INSERT, so it fires first, even before the
      // `asset_transaction_one_opening` unique index would (that index is the ultimate DB guarantee
      // underneath). It also catches a concurrent ACQUISITION that moved the asset to active with no
      // opening row, which the unique index alone would miss. The early financialEventExists read stays as
      // the friendly fast path; this is the last line of defence, in-transaction and DB-enforced, not an
      // out-of-tx read. It trips H01's financial-field lock exactly as a primary acquisition does.
      const moved = ctx.store.db
        .prepare(
          `UPDATE asset SET status = 'active', acquisition_date = ?, acquisition_cost_rappen = ?,
                  accumulated_depr_rappen = ?, net_book_value_rappen = ?, updated_at = ?
             WHERE workspace_id = ? AND id = ? AND status = 'draft'`,
        )
        .run(date, cost, accum, nbv, now, ctx.workspaceId, asset.id);
      // Zero rows means the asset is no longer a draft baseline candidate (a concurrent writer opened or
      // acquired it first, or it moved to a terminal state between the early read and here). Throw so the
      // whole dual write rolls back and nothing is committed or memoised, surfacing the same already_opened
      // the early financialEventExists check gives the loser of the race.
      if (moved.changes === 0) {
        throw new OpeningAbort(err('already_opened', { assetId: asset.id }));
      }

      ctx.store.db
        .prepare(
          `INSERT INTO asset_transaction (
             id, workspace_id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen,
             proceeds_rappen, gain_loss_rappen, journal_entry_id, source_document_type,
             source_document_id, description, created_at, created_by, idempotency_key
           ) VALUES (?, ?, ?, 'opening', ?, ?, ?, NULL, NULL, ?, 'opening', NULL, ?, ?, ?, ?)`,
        )
        .run(
          txnId,
          ctx.workspaceId,
          asset.id,
          date,
          cost,
          accum,
          entryId,
          description,
          now,
          ctx.actor,
          input.idempotencyKey,
        );

      ctx.audit.record({
        entityKind: 'asset_transaction',
        entityId: txnId,
        action: 'post',
        actor: ctx.actor,
        at: now,
      });

      const txnRow = ctx.store.db
        .prepare('SELECT * FROM asset_transaction WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, txnId) as TransactionRow;
      const assetAfter = ctx.store.db
        .prepare('SELECT * FROM asset WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, asset.id) as Record<string, unknown>;

      return ok({
        asset: mapAssetFull(assetAfter),
        transaction: mapTransaction(txnRow),
        journalEntry: { ...check.entry, lines: entryLines },
      });
    }),
  );
}
