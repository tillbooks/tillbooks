/**
 * D170, the asset register's undo verb: `asset_transaction_reverse` takes back ONE financial event on an
 * asset (an acquisition, an additional capitalisation, an opening balance or a disposal) as a pair, in
 * ONE transaction: the faithful A02 mirror of the event's journal entry (`reverseOwnedEntry` under the
 * owner token, so the raw `reverse_entry` refuses the entry and its mirror) AND a compensating
 * `asset_transaction` row with the negated deltas, so the register and the GL stay reconciled (OP11).
 * Nothing is edited or deleted: the original row and entry stay, the correction sits beside them.
 *
 * WHAT EACH REVERSAL DOES TO THE ASSET
 *  - acquisition / opening (the BASELINE): the asset is closed, `archived` with NBV 0. The partial unique
 *    index `asset_transaction_one_acquisition` (and `_one_opening`) forbids a second primary event on the
 *    same record, so the corrected purchase is a fresh asset (the D168 rule: the correction of the
 *    business fact is a new record). Refused while the asset is disposed (`asset_disposed`: reverse the
 *    disposal first), while a capitalisation on it stands (`capitalisation_stands`) and while a posted
 *    depreciation run covers it (`depreciation_posted`: `asset_depreciation_run_reverse`, newest first).
 *  - additional capitalisation: cost and NBV fall by the amount; the status stays. Refused while the asset
 *    is disposed and while a posted run of the capitalisation's period or later covers it (that run
 *    charged depreciation on the raised base).
 *  - disposal: the asset returns to `active` (or `fully_depreciated` when its book value sits at the
 *    residual), `disposed_at` and the proceeds are cleared, NBV is cost minus accumulated again. The
 *    disposal row carries no link to a proceeds invoice or payment (H06 books the proceeds account
 *    directly), so there is nothing to check; D170 records the open question.
 *
 * DATE: today (OR 957a: correct in the open period), the `reverse_entry` convention; a sealed today is
 * `period_locked`, pre-checked before anything is written.
 *
 * A BOOK WRITTEN BEFORE D170 (the D168 critic lesson): the raw `reverse_entry` could take the event's
 * entry out while the register kept it. The chain of POSTED mirrors from the entry decides. ODD: the
 * entry is gone, so the verb ADOPTS the standing mirror (`adopted: true`, nothing posted) and writes the
 * compensating row dated at that mirror, which closes the drift the raw Storno opened. EVEN and non-empty:
 * the entry stands again, and A02 reverses an entry once, so the mirror is posted against the chain's
 * last link (its owner walk ends at this verb). The forward acts that rely on a standing baseline
 * (capitalisation, disposal, depreciation) refuse `asset_posting_reversed` on such a book until it is
 * closed here (`rawReversedEvent`).
 *
 * IDEMPOTENT ON ROWS: the same key replays the memo; a new key on a reversed row answers
 * `already_reversed` naming the compensating row; the mirror's key is derived from the row and the link,
 * so two keys never mint two mirrors, and `asset_transaction_one_reversal` is the race guard underneath.
 * §H-TENANT on every read and write.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { reverseOwnedEntry, ASSET_TRANSACTION_REVERSAL_OWNER } from '../ledger/reverseEntry.js';

/** The four event types this verb takes back. Depreciation has its own run reverse (H04). */
export const REVERSIBLE_ASSET_TRANSACTION_TYPES = ['acquisition', 'additional_capitalisation', 'opening', 'disposal'] as const;
type ReversibleType = (typeof REVERSIBLE_ASSET_TRANSACTION_TYPES)[number];

/** The compensating row's `source_document_type`: the row it corrects is its source. */
export const REVERSAL_SOURCE_DOCUMENT_TYPE = 'asset_transaction';

interface TxnRow {
  id: string;
  asset_id: string;
  type: string;
  date: string;
  delta_cost_rappen: number;
  delta_accum_depr_rappen: number;
  journal_entry_id: string;
}

interface AssetRow {
  id: string;
  number: string;
  name: string;
  status: string;
  acquisition_cost_rappen: number;
  residual_value_rappen: number;
  accumulated_depr_rappen: number;
  net_book_value_rappen: number;
}

function isReversible(type: string): type is ReversibleType {
  return (REVERSIBLE_ASSET_TRANSACTION_TYPES as readonly string[]).includes(type);
}

function readTxn(ctx: WorkspaceContext, id: string): TxnRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen, journal_entry_id
         FROM asset_transaction WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, id) as TxnRow | undefined;
}

function readAsset(ctx: WorkspaceContext, id: string): AssetRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, number, name, status, acquisition_cost_rappen, residual_value_rappen,
              accumulated_depr_rappen, net_book_value_rappen
         FROM asset WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, id) as AssetRow | undefined;
}

/** The compensating row that took `transactionId` back, or undefined. */
export function reversalRowOf(ctx: WorkspaceContext, transactionId: string): { id: string; journal_entry_id: string } | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, journal_entry_id FROM asset_transaction
        WHERE workspace_id = ? AND source_document_type = ? AND source_document_id = ? LIMIT 1`,
    )
    .get(ctx.workspaceId, REVERSAL_SOURCE_DOCUMENT_TYPE, transactionId) as { id: string; journal_entry_id: string } | undefined;
}

/**
 * Walk the chain of POSTED mirrors from an event's entry: E, its reversal R1, R1's reversal R2, ... An
 * ODD chain means the posting is gone and `last` is the mirror that took it out; an EVEN chain (0
 * included) means it stands and `last` is the newest link in E's direction. §H-TENANT on every hop; the
 * bound is a guard, the chain is short by construction.
 */
export function postingChain(ctx: WorkspaceContext, entryId: string): { links: number; last: string } {
  let last = entryId;
  let links = 0;
  for (let hops = 0; hops < 16; hops += 1) {
    const next = ctx.store.db
      .prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ? AND status = 'posted' ORDER BY rowid LIMIT 1")
      .get(ctx.workspaceId, last) as { id: string } | undefined;
    if (next === undefined) break;
    last = next.id;
    links += 1;
  }
  return { links, last };
}

/**
 * The first event of `types` on the asset whose entry a RAW Storno took out while the register kept it
 * (an odd chain and no compensating row), or null. A book written before D170 can carry one; the forward
 * acts that rely on the event refuse `asset_posting_reversed` until `asset_transaction_reverse` adopts it.
 */
export function rawReversedEvent(
  ctx: WorkspaceContext,
  assetId: string,
  types: readonly string[],
): { transactionId: string; type: string; reversalEntryId: string } | null {
  const rows = ctx.store.db
    .prepare(
      `SELECT t.id, t.type, t.journal_entry_id FROM asset_transaction t
        WHERE t.workspace_id = ? AND t.asset_id = ? AND t.type IN (${types.map(() => '?').join(', ')})
          AND NOT EXISTS (SELECT 1 FROM asset_transaction r WHERE r.workspace_id = t.workspace_id
                            AND r.source_document_type = ? AND r.source_document_id = t.id)
        ORDER BY t.date, t.created_at, t.id`,
    )
    .all(ctx.workspaceId, assetId, ...types, REVERSAL_SOURCE_DOCUMENT_TYPE) as { id: string; type: string; journal_entry_id: string }[];
  for (const row of rows) {
    const chain = postingChain(ctx, row.journal_entry_id);
    if (chain.links % 2 === 1) return { transactionId: row.id, type: row.type, reversalEntryId: chain.last };
  }
  return null;
}

/** The structured refusal the forward acts answer on such a book, one shape for all three. */
export function postingReversedRefusal(assetId: string, found: { transactionId: string; type: string; reversalEntryId: string }): Result {
  return err('asset_posting_reversed', {
    assetId,
    transactionId: found.transactionId,
    type: found.type,
    reversalEntryId: found.reversalEntryId,
    hint: 'this event\'s posting was reversed in the journal while the register kept it: close it with asset_transaction_reverse (it adopts the existing reversal), then continue',
  });
}

/** Posted (not reversed) depreciation runs covering the asset, optionally only from `fromPeriod` on. */
function postedRunsCovering(ctx: WorkspaceContext, assetId: string, fromPeriod: string | null): string[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT DISTINCT r.id AS id, r.period AS period FROM asset_depreciation_run r
         JOIN asset_depreciation_line l ON l.run_id = r.id AND l.workspace_id = r.workspace_id
        WHERE r.workspace_id = ? AND l.asset_id = ? AND r.status = 'posted'
          ${fromPeriod !== null ? 'AND r.period >= ?' : ''}
        ORDER BY r.period DESC, r.id`,
    )
    .all(...(fromPeriod !== null ? [ctx.workspaceId, assetId, fromPeriod] : [ctx.workspaceId, assetId])) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Additional capitalisations on the asset that no compensating row took back. */
function standingCapitalisations(ctx: WorkspaceContext, assetId: string): string[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT t.id FROM asset_transaction t
        WHERE t.workspace_id = ? AND t.asset_id = ? AND t.type = 'additional_capitalisation'
          AND NOT EXISTS (SELECT 1 FROM asset_transaction r WHERE r.workspace_id = t.workspace_id
                            AND r.source_document_type = ? AND r.source_document_id = t.id)
        ORDER BY t.date, t.created_at, t.id`,
    )
    .all(ctx.workspaceId, assetId, REVERSAL_SOURCE_DOCUMENT_TYPE) as { id: string }[];
  return rows.map((r) => r.id);
}

function disposalOf(ctx: WorkspaceContext, assetId: string): string | null {
  const row = ctx.store.db
    .prepare(
      `SELECT t.id FROM asset_transaction t WHERE t.workspace_id = ? AND t.asset_id = ? AND t.type = 'disposal'
          AND NOT EXISTS (SELECT 1 FROM asset_transaction r WHERE r.workspace_id = t.workspace_id
                            AND r.source_document_type = ? AND r.source_document_id = t.id)
        LIMIT 1`,
    )
    .get(ctx.workspaceId, assetId, REVERSAL_SOURCE_DOCUMENT_TYPE) as { id: string } | undefined;
  return row?.id ?? null;
}

const LABEL: Readonly<Record<ReversibleType, string>> = {
  acquisition: 'Anschaffung',
  additional_capitalisation: 'Zusatzaktivierung',
  opening: 'Eröffnungsbilanz',
  disposal: 'Abgang',
};

function mapAsset(row: Record<string, unknown>) {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    status: row.status,
    acquisitionCostRappen: row.acquisition_cost_rappen,
    residualValueRappen: row.residual_value_rappen,
    accumulatedDeprRappen: row.accumulated_depr_rappen,
    netBookValueRappen: row.net_book_value_rappen,
    disposedAt: row.disposed_at,
    disposalProceedsRappen: row.disposal_proceeds_rappen,
  };
}

class ReverseAbort {
  constructor(public readonly result: Result) {}
}

export interface AssetTransactionReverseInput {
  assetId?: string;
  transactionId?: string;
  reason?: string;
  idempotencyKey?: string;
}

/** The pre-checks per type; a refusal Result, or null when the event may be taken back. Writes nothing. */
function refusalFor(ctx: WorkspaceContext, asset: AssetRow, txn: TxnRow & { type: ReversibleType }): Result | null {
  if (txn.type === 'disposal') {
    if (asset.status !== 'disposed') return err('invalid_transition', { assetId: asset.id, transactionId: txn.id, status: asset.status });
    return null;
  }
  if (asset.status === 'disposed') {
    return err('asset_disposed', {
      assetId: asset.id,
      transactionId: txn.id,
      disposalTransactionId: disposalOf(ctx, asset.id),
      hint: 'the asset was disposed, which cleared this cost too: reverse the disposal first (asset_transaction_reverse on the disposal), then this event',
    });
  }
  if (asset.status !== 'active' && asset.status !== 'fully_depreciated') {
    return err('invalid_transition', { assetId: asset.id, transactionId: txn.id, status: asset.status });
  }
  if (txn.type === 'additional_capitalisation') {
    const runs = postedRunsCovering(ctx, asset.id, txn.date.slice(0, 7));
    if (runs.length > 0) {
      return err('depreciation_posted', {
        assetId: asset.id,
        transactionId: txn.id,
        runIds: runs,
        hint: 'a posted depreciation run of this period or later charged depreciation on the raised cost: reverse those runs first (asset_depreciation_run_reverse, newest first), then this capitalisation, then run depreciation again',
      });
    }
    if (asset.acquisition_cost_rappen - txn.delta_cost_rappen - asset.accumulated_depr_rappen < 0) {
      return err('invalid_transition', { assetId: asset.id, transactionId: txn.id, reason: 'book_value_would_go_negative' });
    }
    return null;
  }
  // acquisition / opening: the baseline. Everything built on it goes first.
  const caps = standingCapitalisations(ctx, asset.id);
  if (caps.length > 0) {
    return err('capitalisation_stands', {
      assetId: asset.id,
      transactionId: txn.id,
      capitalisationIds: caps,
      hint: 'additional cost was capitalised on this asset: reverse those capitalisations first (asset_transaction_reverse), then the baseline',
    });
  }
  const runs = postedRunsCovering(ctx, asset.id, null);
  if (runs.length > 0) {
    return err('depreciation_posted', {
      assetId: asset.id,
      transactionId: txn.id,
      runIds: runs,
      hint: 'posted depreciation runs charged this asset: reverse them first (asset_depreciation_run_reverse, newest first), then the baseline',
    });
  }
  return null;
}

export function assetTransactionReverse(ctx: WorkspaceContext, input: AssetTransactionReverseInput): Result {
  const posting = ctx.capabilities.assert('post');
  if (!posting.ok) return posting;
  for (const field of ['assetId', 'transactionId', 'idempotencyKey'] as const) {
    const v = input[field];
    if (typeof v !== 'string' || v.length === 0) return err('invalid_input', { field });
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) return err('reason_required', { field: 'reason' });
  const reason = input.reason.trim().slice(0, 200);
  const assetId = input.assetId as string;
  const transactionId = input.transactionId as string;

  const scopedKey = JSON.stringify(['asset_transaction_reverse', transactionId, input.idempotencyKey as string]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'asset_transaction_reverse');
  if (replayed !== undefined) return replayed;

  const txn = readTxn(ctx, transactionId);
  // §H-TENANT, and the pair must agree: a row of another asset answers exactly as an unknown one.
  if (txn === undefined || txn.asset_id !== assetId) return err('not_found', { assetId, transactionId });
  if (!isReversible(txn.type)) {
    return err('not_reversible', {
      transactionId,
      type: txn.type,
      hint: txn.type === 'depreciation'
        ? 'a depreciation row is taken back with its run: asset_depreciation_run_reverse'
        : 'a correcting row is not reversed itself: book the event again',
    });
  }
  const existing = reversalRowOf(ctx, transactionId);
  if (existing !== undefined) {
    return err('already_reversed', { assetId, transactionId, reversalTransactionId: existing.id, reversalEntryId: existing.journal_entry_id });
  }
  const asset = readAsset(ctx, assetId);
  if (asset === undefined) return err('not_found', { assetId });
  const typed = txn as TxnRow & { type: ReversibleType };
  const refused = refusalFor(ctx, asset, typed);
  if (refused !== null) return refused;

  const date = ctx.clock.now().slice(0, 10);
  // §H-PERIOD: pre-checked BEFORE the tx, a structured refusal with nothing written.
  const periodOpen = ctx.periods.assertOpen(date);
  if (!periodOpen.ok) return periodOpen;

  try {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'asset_transaction_reverse', () => {
      // Re-read inside the write lock: the friendly checks above ran outside it (D12).
      if (reversalRowOf(ctx, transactionId) !== undefined) {
        throw new ReverseAbort(err('already_reversed', { assetId, transactionId }));
      }
      const chain = postingChain(ctx, typed.journal_entry_id);
      const adopted = chain.links % 2 === 1;
      let reversalEntryId: string;
      let rowDate = date;
      if (adopted) {
        reversalEntryId = chain.last;
        const mirror = ctx.store.db
          .prepare('SELECT date FROM journal_entry WHERE workspace_id = ? AND id = ?')
          .get(ctx.workspaceId, chain.last) as { date: string };
        // Dated with the GL's own correction, so the register agrees with the GL at every cut-off.
        rowDate = mirror.date;
      } else {
        const reversed = reverseOwnedEntry(
          ctx,
          {
            entryId: chain.last,
            date,
            description: `Storno ${LABEL[typed.type]} Anlage ${asset.number}: ${reason}`,
            // One mirror per row and link, whatever key the caller used: the identity is the event.
            idempotencyKey: JSON.stringify(['asset_transaction_reversal', typed.id, chain.last]),
          },
          ASSET_TRANSACTION_REVERSAL_OWNER,
        );
        if (!reversed.ok) throw new ReverseAbort(reversed);
        reversalEntryId = reversed.reversalId;
      }

      const now = ctx.clock.now();
      const fresh = readAsset(ctx, assetId) as AssetRow;
      let moved: { changes: number | bigint };
      if (typed.type === 'disposal') {
        const nbv = fresh.acquisition_cost_rappen - fresh.accumulated_depr_rappen;
        const status = fresh.accumulated_depr_rappen > 0 && nbv <= fresh.residual_value_rappen ? 'fully_depreciated' : 'active';
        moved = ctx.store.db
          .prepare(
            `UPDATE asset SET status = ?, disposed_at = NULL, disposal_proceeds_rappen = NULL,
                    net_book_value_rappen = ?, updated_at = ?
              WHERE workspace_id = ? AND id = ? AND status = 'disposed'`,
          )
          .run(status, nbv, now, ctx.workspaceId, assetId);
      } else if (typed.type === 'additional_capitalisation') {
        moved = ctx.store.db
          .prepare(
            `UPDATE asset SET acquisition_cost_rappen = acquisition_cost_rappen - ?,
                    net_book_value_rappen = net_book_value_rappen - ?, updated_at = ?
              WHERE workspace_id = ? AND id = ? AND status IN ('active', 'fully_depreciated')
                AND acquisition_cost_rappen = ?`,
          )
          .run(typed.delta_cost_rappen, typed.delta_cost_rappen, now, ctx.workspaceId, assetId, fresh.acquisition_cost_rappen);
      } else {
        // The baseline: the asset is closed. Cost and accumulated stay for history (the disposal rule).
        moved = ctx.store.db
          .prepare(
            `UPDATE asset SET status = 'archived', net_book_value_rappen = 0, updated_at = ?
              WHERE workspace_id = ? AND id = ? AND status IN ('active', 'fully_depreciated')`,
          )
          .run(now, ctx.workspaceId, assetId);
      }
      if (Number(moved.changes) !== 1) {
        throw new ReverseAbort(err('invalid_transition', { assetId, transactionId, reason: 'asset_moved' }));
      }

      const reversalTxnId = ctx.ids.next('atxn');
      ctx.store.db
        .prepare(
          `INSERT INTO asset_transaction (
             id, workspace_id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen,
             proceeds_rappen, gain_loss_rappen, journal_entry_id, source_document_type,
             source_document_id, description, created_at, created_by, idempotency_key
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reversalTxnId,
          ctx.workspaceId,
          assetId,
          `${typed.type}_reversal`,
          rowDate,
          -typed.delta_cost_rappen,
          -typed.delta_accum_depr_rappen,
          reversalEntryId,
          REVERSAL_SOURCE_DOCUMENT_TYPE,
          typed.id,
          `Storno ${LABEL[typed.type]}: ${reason}`,
          now,
          ctx.actor,
          `${typed.id}:reverse`,
        );
      ctx.audit.record({ entityKind: 'asset_transaction', entityId: typed.id, action: 'reverse', actor: ctx.actor, at: now });

      const after = ctx.store.db
        .prepare('SELECT * FROM asset WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, assetId) as Record<string, unknown>;
      return ok({
        assetId,
        transactionId: typed.id,
        type: typed.type,
        reversalTransactionId: reversalTxnId,
        reversalEntryId,
        postedEntryId: typed.journal_entry_id,
        adopted,
        reason,
        asset: mapAsset(after),
      });
    });
  } catch (e) {
    if (e instanceof ReverseAbort) return e.result;
    throw e;
  }
}
