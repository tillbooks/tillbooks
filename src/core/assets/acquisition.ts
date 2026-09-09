/**
 * H02, the Asset Acquisition engine: the FIRST financial event on a fixed asset. It capitalises a
 * draft asset (H01) by writing, in ONE atomic database transaction, both a sub-ledger
 * `asset_transaction` row and the balanced General-Ledger journal entry it names (A02 `postEntry`),
 * so every Rappen that appears on the asset also appears on the correct GL control account (OP11 /
 * §H-ASSET). Without this dual write the register cannot reconcile to the GL and depreciation
 * (H03/H04) has no opening cost base.
 *
 * THIS IS THE MONEY PATH, so the invariants are not decoration:
 *
 *  - APPEND-ONLY (§H-AUDIT). The posted journal entry is immutable (A02's triggers) and the
 *    `asset_transaction` row is immutable (its own triggers, `transactionSchema.ts`). A correction is
 *    a reversing entry (A02 `reverseEntry`) plus a compensating transaction, never a destructive edit.
 *  - IDEMPOTENT ON ROWS (§H-IDEMPOTENT). A replay of the same `idempotency_key` returns the original
 *    objects and posts EXACTLY ONE journal entry and writes EXACTLY ONE transaction row. The whole
 *    dual write runs inside one `rememberIdempotent`, so the outer memo short-circuits a replay before
 *    `postEntry` is ever reached a second time.
 *  - ATOMIC. `postEntry` runs INSIDE this verb's transaction (the payment.ts precedent). A failure at
 *    any step THROWS `AcquisitionAbort`, which rolls the whole transaction back: a rejection leaves
 *    neither a journal entry, nor a transaction row, nor a mutated asset. Returning `{ok:false}` from
 *    inside `ctx.store.tx` would COMMIT the partial write, so we throw and unwrap.
 *  - PERIOD-LOCKED (§H-PERIOD). An acquisition dated in a hard-locked period is refused with
 *    `period_locked` before anything is written.
 *  - §H-TENANT on every read and write: a foreign `asset_id` or `credit_account_id` resolves to
 *    undefined, never to its row.
 *
 * Capitalising moves the asset out of `draft` (to `active`), which is exactly what trips H01's
 * financial-field lock: after a successful acquisition the asset's cost, date, depreciation trio and
 * three GL accounts can no longer change through `asset_update` (`financial_fields_locked`).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { postEntry } from '../ledger/postEntry.js';
import { getEntry } from '../ledger/reads.js';

/** An ISO calendar date `YYYY-MM-DD`, the shape A02 dates already use. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The `source` values a primary acquisition may carry (§H-ENUM, spec §4). */
const ACQUISITION_SOURCES: ReadonlySet<string> = new Set(['manual', 'vendor_bill', 'project', 'opening']);
/** Additional capitalisation is never an opening-balance seed, so `opening` is not admissible here. */
const CAPITALISATION_SOURCES: ReadonlySet<string> = new Set(['manual', 'vendor_bill', 'project']);

/** The account types A01 permits on the CREDIT side of a capitalisation: a real bank/creditor/equity
 * account, never a pure income or expense account (that would book cost to the wrong side). */
const CREDIT_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['asset', 'liability', 'equity']);

/** The two transaction types H02 owns. Both increase cost; neither touches accumulated depreciation. */
const H02_TYPES = ['acquisition', 'additional_capitalisation'] as const;
type AssetTransactionType = (typeof H02_TYPES)[number];

interface AssetRow {
  id: string;
  workspace_id: string;
  status: string;
  acquisition_date: string;
  acquisition_cost_rappen: number;
  residual_value_rappen: number;
  accumulated_depr_rappen: number;
  net_book_value_rappen: number;
  gl_asset_account_id: string;
}

interface AccountRow {
  id: string;
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

function readAsset(ctx: WorkspaceContext, id: string): AssetRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, workspace_id, status, acquisition_date, acquisition_cost_rappen, residual_value_rappen,
              accumulated_depr_rappen, net_book_value_rappen, gl_asset_account_id
         FROM asset WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, id) as AssetRow | undefined;
}

/** An account IN THIS WORKSPACE, or undefined. Scoping by workspace is what makes §H-TENANT hold on
 * the credit-account type check: a foreign account id resolves to undefined, never to its row. */
function readAccount(ctx: WorkspaceContext, id: string): AccountRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, type FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as AccountRow | undefined;
}

/** Does a primary financial BASELINE already exist for this asset, either a normal `acquisition` (the
 * friendly half of the DB `asset_transaction_one_acquisition` partial unique index) OR an H07 `opening`
 * balance? Both seat the cost base and move the asset out of `draft`, so both must block a second primary
 * acquisition and both must satisfy `additional_capitalisation`'s precondition. Checking only `acquisition`
 * left a hole: an opened asset (active, one `opening` row, no `acquisition` row) passed the acquire guard
 * and could be capitalised a second time, double-booking cost with a still-green reconciliation. */
function baselineExists(ctx: WorkspaceContext, assetId: string): boolean {
  const row = ctx.store.db
    .prepare(
      "SELECT id FROM asset_transaction WHERE workspace_id = ? AND asset_id = ? AND type IN ('acquisition', 'opening') LIMIT 1",
    )
    .get(ctx.workspaceId, assetId) as { id: string } | undefined;
  return row !== undefined;
}

/**
 * Resolve a supplied `source_document_id` to a real workspace record, or report it missing.
 *
 * A cost event may point at what triggered it: a vendor bill (A17), a project (B00), or a sales /
 * purchase document (A10). The link is optional, but a SUPPLIED id that resolves to nothing is a
 * defect the caller must see (`source_document_not_found`), never a silently dropped reference. Every
 * probe is workspace-scoped (§H-TENANT), so a foreign id is "not found" here, never a leak.
 */
function sourceDocumentExists(ctx: WorkspaceContext, id: string): boolean {
  for (const table of ['vendor_bill', 'project', 'document'] as const) {
    const row = ctx.store.db
      .prepare(`SELECT id FROM ${table} WHERE workspace_id = ? AND id = ? LIMIT 1`)
      .get(ctx.workspaceId, id) as { id: string } | undefined;
    if (row !== undefined) return true;
  }
  return false;
}

/** Abort the write transaction with a structured cause, so nothing is committed or memoised on a
 * rejection discovered after the transaction opened (the payment.ts `PaymentAbort` shape). */
class AcquisitionAbort {
  constructor(public readonly result: Result) {}
}

function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof AcquisitionAbort) return e.result;
    throw e;
  }
}

/** The shared validation + dual-write for both `assetAcquire` and `assetAddCapitalisation`: they
 * differ only in the status rule, the admissible sources, and whether a residual override is honoured.
 * Everything money-path (the balanced post, the atomic transaction, the immutable row) is identical. */
interface CapitalisationPlan {
  scope: 'asset_acquire' | 'asset_add_capitalisation';
  type: AssetTransactionType;
  amountRappen: number;
  creditAccountId: string;
  costCenterId: string | null;
  sourceDocumentType: string;
  sourceDocumentId: string | null;
  description: string | null;
  /** Applied only by a primary acquisition; undefined leaves the asset's residual untouched. */
  residualValueRappen?: number;
}

function verb(
  ctx: WorkspaceContext,
  assetId: string,
  date: string,
  idempotencyKey: string,
  asset: AssetRow,
  plan: CapitalisationPlan,
): Result {
  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, idempotencyKey, plan.scope, () => {
      const txnId = ctx.ids.next('atxn');

      // The GL effect (both primary and additional): Dr the asset account, Cr the chosen account, for
      // the capitalised amount. `postEntry` runs INSIDE this transaction; on any refusal we THROW so
      // the whole dual write rolls back (returning {ok:false} here would COMMIT the partial write).
      // The entry's key is scoped to THIS transaction id, minted here and unguessable, so it can never
      // collide with a raw post_entry key.
      const posted = postEntry(ctx, {
        date,
        source: 'asset_acquisition',
        description: plan.description ?? `Aktivierung ${plan.type === 'acquisition' ? 'Anschaffung' : 'Zusatz'}`,
        idempotencyKey: JSON.stringify(['asset_acquisition_entry', txnId]),
        lines: [
          {
            account: asset.gl_asset_account_id,
            debit: plan.amountRappen,
            ...(plan.costCenterId !== null ? { costCenter: plan.costCenterId } : {}),
          },
          {
            account: plan.creditAccountId,
            credit: plan.amountRappen,
            ...(plan.costCenterId !== null ? { costCenter: plan.costCenterId } : {}),
          },
        ],
      });
      if (!posted.ok) throw new AcquisitionAbort(posted);
      const entryId = posted.entryId;

      // Trust nothing, including our own posting path: read the entry back and assert it is a posted,
      // balanced `asset_acquisition` entry on the amount and accounts we asked for. This is the check
      // that turns "the post is balanced" from a happy-path property into one that bites.
      const check = getEntry(ctx, { entryId });
      if (!check.ok) throw new AcquisitionAbort(check);
      const lines = check.lines;
      const debit = lines.reduce((s, l) => s + l.debit, 0);
      const credit = lines.reduce((s, l) => s + l.credit, 0);
      const drAsset = lines.find((l) => l.account === asset.gl_asset_account_id && l.debit === plan.amountRappen);
      const crAccount = lines.find((l) => l.account === plan.creditAccountId && l.credit === plan.amountRappen);
      if (debit !== credit || debit !== plan.amountRappen || drAsset === undefined || crAccount === undefined) {
        throw new AcquisitionAbort(
          err('posting_verification_failed', { entryId, reason: 'entry_is_not_the_planned_acquisition' }),
        );
      }

      const now = ctx.clock.now();
      ctx.store.db
        .prepare(
          `INSERT INTO asset_transaction (
             id, workspace_id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen,
             proceeds_rappen, gain_loss_rappen, journal_entry_id, source_document_type,
             source_document_id, description, created_at, created_by, idempotency_key
           ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          txnId,
          ctx.workspaceId,
          assetId,
          plan.type,
          date,
          plan.amountRappen,
          entryId,
          plan.sourceDocumentType,
          plan.sourceDocumentId,
          plan.description,
          now,
          ctx.actor,
          idempotencyKey,
        );

      // Maintain the asset's convenience columns and, for a primary acquisition, its status and
      // baseline. Cost and NBV rise by the capitalised amount (accumulated depreciation is untouched);
      // a primary acquisition also confirms the date, applies a residual override if supplied, and
      // moves the asset to `active`, which is what trips H01's financial-field lock from here on.
      const newCost = asset.acquisition_cost_rappen + plan.amountRappen;
      const residual = plan.residualValueRappen !== undefined ? plan.residualValueRappen : asset.residual_value_rappen;
      const newNbv = newCost - asset.accumulated_depr_rappen;
      if (plan.type === 'acquisition') {
        ctx.store.db
          .prepare(
            `UPDATE asset SET status = 'active', acquisition_date = ?, acquisition_cost_rappen = ?,
                    residual_value_rappen = ?, net_book_value_rappen = ?, updated_at = ?
               WHERE workspace_id = ? AND id = ?`,
          )
          .run(date, plan.amountRappen, residual, plan.amountRappen - asset.accumulated_depr_rappen, now, ctx.workspaceId, assetId);
      } else {
        ctx.store.db
          .prepare(
            `UPDATE asset SET acquisition_cost_rappen = ?, net_book_value_rappen = ?, updated_at = ?
               WHERE workspace_id = ? AND id = ?`,
          )
          .run(newCost, newNbv, now, ctx.workspaceId, assetId);
      }

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
        .get(ctx.workspaceId, assetId) as Record<string, unknown>;

      return ok({
        asset: mapAssetFull(assetAfter),
        transaction: mapTransaction(txnRow),
        journalEntry: { ...check.entry, lines },
      });
    }),
  );
}

/** Map an `asset` row for the response. Snake to camel, the `master.ts` boundary shape, kept local so
 * H02 does not import H01's internal mapper (file-ownership: H02 CONSUMES the asset, never edits it). */
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

export interface AssetAcquireInput {
  assetId?: string;
  date?: string;
  acquisitionCostRappen?: number;
  creditAccountId?: string;
  residualValueRappen?: number | null;
  costCenterId?: string | null;
  source?: string;
  sourceDocumentId?: string | null;
  description?: string | null;
  idempotencyKey?: string;
}

export function assetAcquire(ctx: WorkspaceContext, input: AssetAcquireInput): Result {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  // Replay a completed acquisition BEFORE any state-dependent guard (§H-IDEMPOTENT), so a retry
  // returns the original objects instead of tripping `already_acquired` on the event it itself wrote.
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_acquire');
  if (replayed !== undefined) return replayed;

  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    return err('invalid_input', { field: 'assetId' });
  }
  const asset = readAsset(ctx, input.assetId);
  if (asset === undefined) return err('not_found', { assetId: input.assetId });

  const date = typeof input.date === 'string' ? input.date.trim() : '';
  if (date.length === 0 || !ISO_DATE.test(date)) return err('invalid_input', { field: 'date' });

  const cost = input.acquisitionCostRappen;
  if (typeof cost !== 'number' || !Number.isInteger(cost) || cost <= 0) {
    return err('invalid_cost', { acquisitionCostRappen: cost });
  }

  // Status rule: disposed / archived can never acquire; a second primary acquisition is refused.
  if (asset.status === 'disposed' || asset.status === 'archived') {
    return err('asset_not_acquirable', { assetId: input.assetId, status: asset.status });
  }
  if (baselineExists(ctx, asset.id) || asset.status === 'fully_depreciated') {
    return err('already_acquired', { assetId: input.assetId });
  }

  const source = typeof input.source === 'string' && input.source.length > 0 ? input.source : 'manual';
  if (!ACQUISITION_SOURCES.has(source)) {
    return err('invalid_input', { field: 'source', allowed: [...ACQUISITION_SOURCES] });
  }

  const creditErr = validateCreditAccount(ctx, input.creditAccountId);
  if (creditErr !== undefined) return creditErr;

  let residual: number | undefined;
  if (input.residualValueRappen !== undefined && input.residualValueRappen !== null) {
    const r = input.residualValueRappen;
    if (!Number.isInteger(r) || r < 0 || r > cost) return err('invalid_residual', { residualValueRappen: r, cost });
    residual = r;
  }

  const sourceDocErr = validateSourceDocument(ctx, input.sourceDocumentId);
  if (sourceDocErr !== undefined) return sourceDocErr;

  // §H-PERIOD, checked BEFORE the write opens so a locked date rejects with nothing half-done.
  const periodOpen = ctx.periods.assertOpen(date);
  if (!periodOpen.ok) return periodOpen;

  return verb(ctx, asset.id, date, input.idempotencyKey, asset, {
    scope: 'asset_acquire',
    type: 'acquisition',
    amountRappen: cost,
    creditAccountId: input.creditAccountId as string,
    costCenterId: typeof input.costCenterId === 'string' && input.costCenterId.length > 0 ? input.costCenterId : null,
    sourceDocumentType: source,
    sourceDocumentId:
      typeof input.sourceDocumentId === 'string' && input.sourceDocumentId.length > 0 ? input.sourceDocumentId : null,
    description: typeof input.description === 'string' && input.description.trim() !== '' ? input.description.trim() : null,
    ...(residual !== undefined ? { residualValueRappen: residual } : {}),
  });
}

export interface AssetAddCapitalisationInput {
  assetId?: string;
  date?: string;
  amountRappen?: number;
  creditAccountId?: string;
  costCenterId?: string | null;
  source?: string;
  sourceDocumentId?: string | null;
  description?: string | null;
  idempotencyKey?: string;
}

export function assetAddCapitalisation(ctx: WorkspaceContext, input: AssetAddCapitalisationInput): Result {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_add_capitalisation');
  if (replayed !== undefined) return replayed;

  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    return err('invalid_input', { field: 'assetId' });
  }
  const asset = readAsset(ctx, input.assetId);
  if (asset === undefined) return err('not_found', { assetId: input.assetId });

  const date = typeof input.date === 'string' ? input.date.trim() : '';
  if (date.length === 0 || !ISO_DATE.test(date)) return err('invalid_input', { field: 'date' });

  const amount = input.amountRappen;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return err('invalid_cost', { amountRappen: amount });
  }

  // Additional capitalisation requires a live, already-acquired asset: not disposed / archived, and a
  // primary acquisition must already exist (otherwise the primary flow is the right one).
  if (asset.status === 'disposed' || asset.status === 'archived') {
    return err('asset_not_acquirable', { assetId: input.assetId, status: asset.status });
  }
  if (!baselineExists(ctx, asset.id)) {
    return err('not_acquired', { assetId: input.assetId, reason: 'record the primary acquisition or opening balance first' });
  }

  const source = typeof input.source === 'string' && input.source.length > 0 ? input.source : 'manual';
  if (!CAPITALISATION_SOURCES.has(source)) {
    return err('invalid_input', { field: 'source', allowed: [...CAPITALISATION_SOURCES] });
  }

  const creditErr = validateCreditAccount(ctx, input.creditAccountId);
  if (creditErr !== undefined) return creditErr;

  const sourceDocErr = validateSourceDocument(ctx, input.sourceDocumentId);
  if (sourceDocErr !== undefined) return sourceDocErr;

  const periodOpen = ctx.periods.assertOpen(date);
  if (!periodOpen.ok) return periodOpen;

  return verb(ctx, asset.id, date, input.idempotencyKey, asset, {
    scope: 'asset_add_capitalisation',
    type: 'additional_capitalisation',
    amountRappen: amount,
    creditAccountId: input.creditAccountId as string,
    costCenterId: typeof input.costCenterId === 'string' && input.costCenterId.length > 0 ? input.costCenterId : null,
    sourceDocumentType: source,
    sourceDocumentId:
      typeof input.sourceDocumentId === 'string' && input.sourceDocumentId.length > 0 ? input.sourceDocumentId : null,
    description: typeof input.description === 'string' && input.description.trim() !== '' ? input.description.trim() : null,
  });
}

/** Shared: the credit account must exist in this workspace and be a plausible credit-side type. */
function validateCreditAccount(ctx: WorkspaceContext, creditAccountId: string | undefined): Result | undefined {
  if (typeof creditAccountId !== 'string' || creditAccountId.length === 0) {
    return err('invalid_credit_account', { reason: 'missing' });
  }
  const acc = readAccount(ctx, creditAccountId);
  if (acc === undefined) return err('invalid_credit_account', { creditAccountId, reason: 'not_found' });
  if (!CREDIT_ACCOUNT_TYPES.has(acc.type)) {
    return err('credit_account_wrong_type', { creditAccountId, type: acc.type, expected: [...CREDIT_ACCOUNT_TYPES] });
  }
  return undefined;
}

/** Shared: a supplied source-document id must resolve to a real workspace record. */
function validateSourceDocument(ctx: WorkspaceContext, sourceDocumentId: string | null | undefined): Result | undefined {
  if (typeof sourceDocumentId === 'string' && sourceDocumentId.length > 0 && !sourceDocumentExists(ctx, sourceDocumentId)) {
    return err('source_document_not_found', { sourceDocumentId });
  }
  return undefined;
}

export function assetTransactionList(
  ctx: WorkspaceContext,
  input: { assetId?: string; type?: string },
): Result {
  if (typeof input.assetId !== 'string' || input.assetId.length === 0) {
    return err('invalid_input', { field: 'assetId' });
  }
  const clauses = ['workspace_id = ?', 'asset_id = ?'];
  const params: unknown[] = [ctx.workspaceId, input.assetId];
  if (typeof input.type === 'string' && input.type.length > 0) {
    clauses.push('type = ?');
    params.push(input.type);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM asset_transaction WHERE ${clauses.join(' AND ')} ORDER BY date, created_at, id`)
    .all(...params) as TransactionRow[];
  return ok({ transactions: rows.map(mapTransaction), total: rows.length });
}

export function assetTransactionGet(ctx: WorkspaceContext, input: { id?: string }): Result {
  if (typeof input.id !== 'string' || input.id.length === 0) {
    return err('invalid_input', { field: 'id' });
  }
  const row = ctx.store.db
    .prepare('SELECT * FROM asset_transaction WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.id) as TransactionRow | undefined;
  if (row === undefined) return err('not_found', { id: input.id });
  return ok({ transaction: mapTransaction(row) });
}
