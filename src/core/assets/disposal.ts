/**
 * H06, the Asset Disposal engine: the TERMINAL financial event on a fixed asset. An asset leaves the
 * business through sale, scrap, donation, insurance write-off or plain retirement, and that moment is a
 * DUAL-LEDGER event (OP11 / §H-ASSET): the sub-ledger must move the item into a terminal state and the
 * General Ledger must clear the asset cost and the accumulated depreciation while recognising any
 * proceeds and the resulting book gain or loss.
 *
 * In ONE atomic database transaction `assetDispose`:
 *   (a) posts ONE balanced A02 journal (`source='asset_disposal'`) that debits accumulated
 *       depreciation, debits the proceeds account, recognises the book gain or loss on the correct
 *       side, and credits the asset cost account;
 *   (b) appends ONE immutable `asset_transaction` of type `disposal` to the EXISTING H02 sub-ledger
 *       table (H06 EXTENDS the writer, it does not own the DDL: H07 owns the table's reconciliation),
 *       naming the journal it posted; and
 *   (c) moves the asset to terminal status `disposed`, forcing `net_book_value_rappen` to 0 and
 *       stamping `disposed_at` / `disposal_proceeds_rappen`, so H03/H04's depreciation engine
 *       permanently excludes it (its `eligibleAssets` filters `status NOT IN ('disposed', ...)`).
 *
 * THIS IS THE MONEY PATH, so the invariants are asserted, not decorated:
 *
 *  - APPEND-ONLY (§H-AUDIT). The posted journal is immutable (A02's triggers) and the disposal
 *    `asset_transaction` row is immutable (its own BEFORE-UPDATE / BEFORE-DELETE triggers,
 *    `transactionSchema.ts`). A wrong disposal is corrected by a REVERSING A02 entry plus a
 *    compensating `asset_transaction`, never a destructive edit. There is no `un-dispose` verb (spec
 *    §3): the ordinary §H-AUDIT correction path is the only door.
 *  - IDEMPOTENT ON ROWS (§H-IDEMPOTENT). A replay of the same `idempotency_key` returns the original
 *    objects and posts EXACTLY ONE journal, appends EXACTLY ONE transaction row, and flips the status
 *    ONCE. The whole dual write runs inside one `rememberIdempotent`, so a replay short-circuits before
 *    `postEntry` is reached a second time (the acquisition.ts precedent).
 *  - ATOMIC. `postEntry` runs INSIDE this verb's transaction. A failure at any step THROWS
 *    `DisposalAbort`, which rolls the whole transaction back: a rejection leaves neither a journal, nor
 *    a transaction row, nor a mutated asset. Returning `{ok:false}` from inside `ctx.store.tx` would
 *    COMMIT the partial write, so we throw and unwrap.
 *  - PERIOD-LOCKED (§H-PERIOD). A disposal dated in a hard-locked period is refused with
 *    `period_locked` before anything is written. The preview is pure and does not check the lock: it
 *    is exactly the tool for seeing WHAT a disposal would post before finding out the period is sealed.
 *  - §H-TENANT on every read and write: a foreign `asset_id`, `proceeds_account_id`,
 *    `gain_loss_account_id` or `transaction_id` resolves to undefined, never to its row.
 *
 * Money is integer Rappen throughout; there is no floating-point arithmetic anywhere on the gain/loss
 * path. The gain/loss SIGN is the whole correctness question: G = proceeds - net book value, so
 * proceeds ABOVE NBV is a gain (credited) and proceeds BELOW NBV is a loss (debited), and the
 * deterministic line algorithm below balances by construction for every case.
 *
 * FILE OWNERSHIP: H06 owns this module and its tests. It APPENDS a `disposal` row to the H02
 * `asset_transaction` table (the acquisition.ts precedent: a writer of a table it does not own) and
 * UPDATEs the H01 `asset` master's own terminal columns (`status`, `disposed_at`,
 * `disposal_proceeds_rappen`, `net_book_value_rappen`), but never edits H01/H02/H04's engine files.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { postEntry } from '../ledger/postEntry.js';
import { getEntry } from '../ledger/reads.js';

/** An ISO calendar date `YYYY-MM-DD`, the shape A02 dates already use. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The statuses an asset may be disposed FROM: it must carry a posted acquisition (active), or have
 * run its life out (fully_depreciated). Every other status is refused with its own reason below. */
const DISPOSABLE_STATUSES: ReadonlySet<string> = new Set(['active', 'fully_depreciated']);

/** The account types the PROCEEDS may land on: a real money-side account (bank / receivable = asset,
 * or occasionally a liability), never an income/expense/equity account (spec §4). A scrap with zero
 * proceeds names no proceeds account at all, so the check runs only when proceeds are received. */
const PROCEEDS_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['asset', 'liability']);

/** The account types the book GAIN or LOSS may land on: an income or expense account (spec §4). */
const GAIN_LOSS_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['income', 'expense']);

interface AssetRow {
  id: string;
  workspace_id: string;
  number: string;
  name: string;
  status: string;
  acquisition_cost_rappen: number;
  accumulated_depr_rappen: number;
  net_book_value_rappen: number;
  gl_asset_account_id: string;
  gl_accum_depr_account_id: string;
}

interface AccountRow {
  id: string;
  number: string;
  name: string;
  type: string;
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

/** Map an `asset` row for the response. Snake to camel, kept local so H06 does not import H01's
 * internal mapper (file-ownership: H06 CONSUMES the asset, never edits H01's engine). */
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
    disposedAt: row.disposed_at,
    disposalProceedsRappen: row.disposal_proceeds_rappen,
  };
}

function readAsset(ctx: WorkspaceContext, id: string): AssetRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, workspace_id, number, name, status, acquisition_cost_rappen, accumulated_depr_rappen,
              net_book_value_rappen, gl_asset_account_id, gl_accum_depr_account_id
         FROM asset WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, id) as AssetRow | undefined;
}

/** An account IN THIS WORKSPACE, or undefined. Scoping by workspace is what makes §H-TENANT hold on
 * the account-type checks: a foreign account id resolves to undefined, never to its row. */
function readAccount(ctx: WorkspaceContext, id: string): AccountRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, number, name, type FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as AccountRow | undefined;
}

/**
 * A single journal line, carried in BOTH the shapes the two callers need: the human-readable preview
 * (account number + name + explicit side) AND the bare `{ account, debit/credit }` the posting path
 * hands to A02. Building them once here is what guarantees the previewed lines and the posted lines
 * are the same lines (the §8 round-trip tripwire): a preview that computed its own figures separately
 * is exactly how a preview and its posting come to disagree.
 */
interface PlannedLine {
  account_id: string;
  account_number: string;
  account_name: string;
  debit_rappen: number;
  credit_rappen: number;
  side: 'debit' | 'credit';
}

interface DisposalPlan {
  asset: AssetRow;
  disposalDate: string;
  acquisitionCostRappen: number;
  accumulatedDeprRappen: number;
  netBookValueRappen: number;
  proceedsRappen: number;
  gainLossRappen: number;
  proceedsAccountId: string | null;
  gainLossAccountId: string;
  lines: PlannedLine[];
  description: string;
}

export interface AssetDisposalInputBase {
  assetId?: string;
  disposalDate?: string;
  proceedsRappen?: number;
  proceedsAccountId?: string;
  gainLossAccountId?: string;
  reason?: string | null;
  counterpartyName?: string | null;
  notes?: string | null;
}

/**
 * The shared validation + deterministic journal construction for both the preview and the dispose.
 * Returns a rejection `Result` (the caller returns it verbatim) or the fully-computed `DisposalPlan`.
 * NO WRITE happens here and NO period lock is checked here: the period lock is a dispose-time gate, so
 * the preview stays a pure read that shows what a disposal WOULD post even for a locked period.
 */
function planDisposal(ctx: WorkspaceContext, input: AssetDisposalInputBase): Result | DisposalPlan {
  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    return err('invalid_input', { field: 'assetId' });
  }
  const asset = readAsset(ctx, input.assetId);
  if (asset === undefined) return err('not_found', { assetId: input.assetId });

  const disposalDate = typeof input.disposalDate === 'string' ? input.disposalDate.trim() : '';
  if (disposalDate.length === 0 || !ISO_DATE.test(disposalDate)) {
    return err('invalid_input', { field: 'disposalDate' });
  }

  // Terminal / not-yet-acquired states are refused with the reason that applies, so the caller learns
  // WHY a disposal is impossible rather than a generic rejection. A disposed asset is the idempotency
  // partner of the second-dispose race (US-H06.7): first wins, second sees asset_already_disposed.
  if (asset.status === 'disposed') return err('asset_already_disposed', { assetId: asset.id });
  if (asset.status === 'archived') return err('asset_archived', { assetId: asset.id });
  if (!DISPOSABLE_STATUSES.has(asset.status)) {
    // draft (or any pre-acquisition state): there is no cost basis to clear yet.
    return err('asset_not_acquired', { assetId: asset.id, status: asset.status });
  }

  const proceeds = input.proceedsRappen;
  if (typeof proceeds !== 'number' || !Number.isInteger(proceeds) || proceeds < 0) {
    return err('invalid_proceeds', { proceedsRappen: proceeds });
  }

  // The gain/loss account is validated ALWAYS: income or expense (spec §4). Most disposals realise a
  // gain or a loss, so requiring it up front is honest even in the rare G == 0 case where its line is
  // omitted; the account still has to be a real, correctly-typed workspace account.
  if (typeof input.gainLossAccountId !== 'string' || input.gainLossAccountId.length === 0) {
    return err('invalid_gain_loss_account', { reason: 'missing' });
  }
  const gainLossAcc = readAccount(ctx, input.gainLossAccountId);
  if (gainLossAcc === undefined) {
    return err('invalid_gain_loss_account', { gainLossAccountId: input.gainLossAccountId, reason: 'not_found' });
  }
  if (!GAIN_LOSS_ACCOUNT_TYPES.has(gainLossAcc.type)) {
    return err('invalid_gain_loss_account', {
      gainLossAccountId: input.gainLossAccountId,
      type: gainLossAcc.type,
      expected: [...GAIN_LOSS_ACCOUNT_TYPES],
    });
  }

  // The proceeds account is required and validated ONLY when proceeds are actually received: a scrap
  // (proceeds == 0) books no proceeds line, so demanding an unused bank account for it would be noise.
  let proceedsAcc: AccountRow | undefined;
  if (proceeds > 0) {
    if (typeof input.proceedsAccountId !== 'string' || input.proceedsAccountId.length === 0) {
      return err('invalid_proceeds_account', { reason: 'missing' });
    }
    proceedsAcc = readAccount(ctx, input.proceedsAccountId);
    if (proceedsAcc === undefined) {
      return err('invalid_proceeds_account', { proceedsAccountId: input.proceedsAccountId, reason: 'not_found' });
    }
    if (!PROCEEDS_ACCOUNT_TYPES.has(proceedsAcc.type)) {
      return err('invalid_proceeds_account', {
        proceedsAccountId: input.proceedsAccountId,
        type: proceedsAcc.type,
        expected: [...PROCEEDS_ACCOUNT_TYPES],
      });
    }
  }

  const C = asset.acquisition_cost_rappen; // cost basis to clear (credit the asset account)
  const A = asset.accumulated_depr_rappen; // accumulated depreciation to clear (debit the contra)
  const NBV = C - A; // the net book value leaving the books
  const P = proceeds;
  const G = P - NBV; // signed: +gain / -loss / 0

  // The asset cost account and the accumulated-depreciation contra come from the asset itself, so a
  // disposal always clears the exact accounts the acquisition and depreciation posted against (OP11).
  const assetAcc = readAccount(ctx, asset.gl_asset_account_id);
  const accumAcc = readAccount(ctx, asset.gl_accum_depr_account_id);
  // These are the asset's own validated GL accounts (H01 checked their types at creation), so an
  // absence here is a corrupt master, not user input: fail structured rather than post a half journal.
  if (assetAcc === undefined || accumAcc === undefined) {
    return err('invalid_gl_accounts', { assetId: asset.id });
  }

  const debit = (a: AccountRow, amount: number): PlannedLine => ({
    account_id: a.id,
    account_number: a.number,
    account_name: a.name,
    debit_rappen: amount,
    credit_rappen: 0,
    side: 'debit',
  });
  const credit = (a: AccountRow, amount: number): PlannedLine => ({
    account_id: a.id,
    account_number: a.number,
    account_name: a.name,
    debit_rappen: 0,
    credit_rappen: amount,
    side: 'credit',
  });

  // The deterministic algorithm (spec §4). Σ debit == Σ credit holds by construction: since
  // A + P = NBV + P - ... , the identity C + max(G,0) == A + P + max(-G,0) is what balances every case
  // (gain, loss, exact, scrap, zero-accumulated). Order: clear accumulated, recognise proceeds,
  // recognise loss, clear cost, recognise gain, so the preview reads top-to-bottom as an accountant
  // would write it.
  const lines: PlannedLine[] = [];
  if (A > 0) lines.push(debit(accumAcc, A)); // 1. clear accumulated depreciation
  if (P > 0 && proceedsAcc !== undefined) lines.push(debit(proceedsAcc, P)); // 2. recognise proceeds
  if (G < 0) lines.push(debit(gainLossAcc, -G)); // 3. recognise loss
  lines.push(credit(assetAcc, C)); // 4. clear asset cost
  if (G > 0) lines.push(credit(gainLossAcc, G)); // 5. recognise gain

  const description = composeDescription(asset, input);

  return {
    asset,
    disposalDate,
    acquisitionCostRappen: C,
    accumulatedDeprRappen: A,
    netBookValueRappen: NBV,
    proceedsRappen: P,
    gainLossRappen: G,
    proceedsAccountId: proceedsAcc?.id ?? null,
    gainLossAccountId: gainLossAcc.id,
    lines,
    description,
  };
}

/** The journal / transaction description: the operator's reason, or an auto sentence, plus the optional
 * counterparty and free notes folded in (the table has no dedicated columns for them, spec §4). Joined
 * with '; ' rather than a dash, because the house style bans em/en dashes as separators. */
function composeDescription(asset: AssetRow, input: AssetDisposalInputBase): string {
  const parts: string[] = [];
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  parts.push(reason.length > 0 ? reason : `Abgang Anlage ${asset.number} ${asset.name}`);
  const counterparty = typeof input.counterpartyName === 'string' ? input.counterpartyName.trim() : '';
  if (counterparty.length > 0) parts.push(`Gegenpartei: ${counterparty}`);
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (notes.length > 0) parts.push(notes);
  return parts.join('; ').slice(0, 500);
}

/** The response half of a plan's line: what a caller (agent or GUI) reads to render the proposed entry. */
function previewLine(l: PlannedLine) {
  return {
    account_id: l.account_id,
    account_number: l.account_number,
    account_name: l.account_name,
    debit_rappen: l.debit_rappen,
    credit_rappen: l.credit_rappen,
    side: l.side,
  };
}

function previewPayload(plan: DisposalPlan) {
  return {
    asset_id: plan.asset.id,
    disposal_date: plan.disposalDate,
    acquisition_cost_rappen: plan.acquisitionCostRappen,
    accumulated_depr_rappen: plan.accumulatedDeprRappen,
    net_book_value_rappen: plan.netBookValueRappen,
    proceeds_rappen: plan.proceedsRappen,
    gain_loss_rappen: plan.gainLossRappen,
    journal_lines: plan.lines.map(previewLine),
    resulting_status: 'disposed' as const,
  };
}

export type AssetDisposalPreviewInput = AssetDisposalInputBase;

export function assetDisposalPreview(ctx: WorkspaceContext, input: AssetDisposalPreviewInput): Result {
  const plan = planDisposal(ctx, input);
  if ('ok' in plan) return plan; // a rejection Result
  return ok({ preview: previewPayload(plan) });
}

/** Abort the write transaction with a structured cause, so nothing is committed or memoised on a
 * rejection discovered after the transaction opened (the acquisition.ts `AcquisitionAbort` shape). */
class DisposalAbort {
  constructor(public readonly result: Result) {}
}

function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof DisposalAbort) return e.result;
    throw e;
  }
}

export interface AssetDisposeInput extends AssetDisposalInputBase {
  idempotencyKey?: string;
}

export function assetDispose(ctx: WorkspaceContext, input: AssetDisposeInput): Result {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  // Replay a completed disposal BEFORE any state-dependent guard (§H-IDEMPOTENT), so a retry returns
  // the original objects instead of tripping asset_already_disposed on the disposal it itself wrote.
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_dispose');
  if (replayed !== undefined) return replayed;

  const plan = planDisposal(ctx, input);
  if ('ok' in plan) return plan; // a rejection Result

  // §H-PERIOD, checked BEFORE the write opens so a locked date rejects with nothing half-done.
  const periodOpen = ctx.periods.assertOpen(plan.disposalDate);
  if (!periodOpen.ok) return periodOpen;

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'asset_dispose', () => {
      const txnId = ctx.ids.next('atxn');

      // The GL effect: the balanced disposal journal. `postEntry` runs INSIDE this transaction; on any
      // refusal we THROW so the whole dual write rolls back (returning {ok:false} here would COMMIT the
      // partial write). The entry's key is scoped to THIS transaction id, minted here and unguessable,
      // so it can never collide with a raw post_entry key.
      const posted = postEntry(ctx, {
        date: plan.disposalDate,
        source: 'asset_disposal',
        description: plan.description,
        idempotencyKey: JSON.stringify(['asset_disposal_entry', txnId]),
        lines: plan.lines.map((l) =>
          l.side === 'debit'
            ? { account: l.account_id, debit: l.debit_rappen }
            : { account: l.account_id, credit: l.credit_rappen },
        ),
      });
      if (!posted.ok) throw new DisposalAbort(posted);
      const entryId = posted.entryId;

      // Trust nothing, including our own posting path: read the entry back and assert it is a posted,
      // BALANCED entry whose debit total equals the cleared cost plus any gain (spec §4's balance
      // identity). This is the check that turns "the post is balanced" from a happy-path property into
      // one that bites.
      const check = getEntry(ctx, { entryId });
      if (!check.ok) throw new DisposalAbort(check);
      const debitTotal = check.lines.reduce((s, l) => s + l.debit, 0);
      const creditTotal = check.lines.reduce((s, l) => s + l.credit, 0);
      const expectedTotal = plan.acquisitionCostRappen + Math.max(plan.gainLossRappen, 0);
      if (debitTotal !== creditTotal || debitTotal !== expectedTotal) {
        throw new DisposalAbort(
          err('posting_verification_failed', { entryId, reason: 'entry_is_not_the_planned_disposal' }),
        );
      }

      const now = ctx.clock.now();

      // Move the asset to its terminal state, GUARDED on the still-disposable status. This UPDATE is the
      // IN-TRANSACTION race check (§119 / US-H06.7): its WHERE re-reads the CURRENT committed status, so
      // a second concurrent writer (D12: Studio + a `till mcp` subprocess on one SQLite file) that read
      // `active` OUT of transaction before the first writer committed now touches 0 rows and aborts
      // cleanly with asset_already_disposed. It runs BEFORE the disposal INSERT, so it fires first, even
      // before the `asset_transaction_one_disposal` unique index would (the index is the ultimate DB
      // guarantee underneath). The early planDisposal status read stays as the friendly fast path; this
      // is the last line of defence, in-transaction and DB-enforced, not an out-of-tx read. NBV is
      // forced to 0 (the asset has left the books), while acquisition cost and accumulated depreciation
      // are LEFT at their pre-disposal values for historical reporting (spec §4). From here H03/H04
      // permanently exclude it (status filter).
      const moved = ctx.store.db
        .prepare(
          `UPDATE asset SET status = 'disposed', disposed_at = ?, disposal_proceeds_rappen = ?,
                  net_book_value_rappen = 0, updated_at = ?
             WHERE workspace_id = ? AND id = ? AND status IN ('active', 'fully_depreciated')`,
        )
        .run(plan.disposalDate, plan.proceedsRappen, now, ctx.workspaceId, plan.asset.id);
      // Zero rows means the asset is no longer disposable (a concurrent writer disposed it first, or it
      // moved to a terminal state between the early read and here). Throw so the whole dual write rolls
      // back and nothing is committed or memoised, surfacing the same asset_already_disposed the early
      // planDisposal check gives the loser of the race.
      if (moved.changes === 0) {
        throw new DisposalAbort(err('asset_already_disposed', { assetId: plan.asset.id }));
      }

      // The append-only sub-ledger event. A disposal clears the asset: `delta_cost_rappen` is the
      // negative of the full cost basis and `delta_accum_depr_rappen` the negative of the accumulated,
      // so summed over the asset's whole history both convenience totals return to zero (OP11). The
      // signed gain/loss and the proceeds ride the row so H07's reconciliation can read them. The
      // `asset_transaction_one_disposal` partial unique index rejects a second disposal row structurally.
      ctx.store.db
        .prepare(
          `INSERT INTO asset_transaction (
             id, workspace_id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen,
             proceeds_rappen, gain_loss_rappen, journal_entry_id, source_document_type,
             source_document_id, description, created_at, created_by, idempotency_key
           ) VALUES (?, ?, ?, 'disposal', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(
          txnId,
          ctx.workspaceId,
          plan.asset.id,
          plan.disposalDate,
          -plan.acquisitionCostRappen,
          -plan.accumulatedDeprRappen,
          plan.proceedsRappen,
          plan.gainLossRappen,
          entryId,
          plan.description,
          now,
          ctx.actor,
          input.idempotencyKey,
        );

      // §H-AUDIT: the sub-ledger event is recorded in the trail as well as in the journal (which A02
      // already audited under `entry`).
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
        .get(ctx.workspaceId, plan.asset.id) as Record<string, unknown>;

      return ok({
        asset: mapAssetFull(assetAfter),
        transaction: mapTransaction(txnRow),
        journalEntry: { ...check.entry, lines: check.lines },
        gainLossRappen: plan.gainLossRappen,
      });
    }),
  );
}

export function assetDisposalGet(ctx: WorkspaceContext, input: { transactionId?: string }): Result {
  if (typeof input.transactionId !== 'string' || input.transactionId.length === 0) {
    return err('invalid_input', { field: 'transactionId' });
  }
  // A disposal-only read: the id must name a `disposal` row in THIS workspace (§H-TENANT). A foreign id,
  // or an id that names an acquisition / depreciation row, is `not_found` rather than a leak of the
  // wrong event through the disposal verb.
  const row = ctx.store.db
    .prepare("SELECT * FROM asset_transaction WHERE workspace_id = ? AND id = ? AND type = 'disposal'")
    .get(ctx.workspaceId, input.transactionId) as TransactionRow | undefined;
  if (row === undefined) return err('not_found', { transactionId: input.transactionId });

  const entry = getEntry(ctx, { entryId: row.journal_entry_id });
  const journalEntry = entry.ok ? { ...entry.entry, lines: entry.lines } : null;
  return ok({ transaction: mapTransaction(row), journalEntry });
}
