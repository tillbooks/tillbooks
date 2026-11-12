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
import { rawReversedEvent, postingReversedRefusal } from './reversal.js';
import {
  resolveProceedsLink,
  bookProceedsWarnings,
  isInvoiceSaleAccount,
  saleLineOf,
  saleReductionsOf,
  entryDateOf,
  standingDisposalOnInvoice,
  saleAccountNetByDate,
  PROCEEDS_BOOKING_MODES,
  CROSS_YEAR_SALE_MODES,
} from './proceedsLink.js';
import type { ProceedsLink, ProceedsWarning, ProceedsBookingMode, CrossYearSaleMode } from './proceedsLink.js';
import { getSetting } from '../settings/settings.js';
import { fiscalYearOf } from '../ledger/periods.js';
import { firstDayAfter, postDisposalAbgrenzungWithin } from '../accruals/index.js';

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
  /** D192: the clearing line carries the invoice sale line's cost centre, so a cost-centre report nets. */
  cost_center_id: string | null;
}

/** D192 point 11: the Abgrenzung a disposal across a year end posts through A38, in the same transaction. */
interface AbgrenzungPlan {
  kind: 'accrued_income' | 'deferred_income';
  periodEnd: string;
  reversalDate: string;
  amountRappen: number;
  contraAccountId: string;
  contraAccountNumber: string;
  contraAccountName: string;
  costCenterId: string | null;
}

/** D172: a per-call value that differs from the workspace setting, with its audited reason. */
interface OverridePlan {
  setting: 'assets.proceeds_booking' | 'assets.cross_year_sale';
  value: string;
  reason: string;
  action: 'override_proceeds_booking' | 'override_cross_year_sale';
  stamp: string;
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
  /** D191: the optional proceeds document (null when none was named). */
  proceedsLink: ProceedsLink | null;
  /** D192: how a LINKED disposal books its proceeds (null when unlinked). */
  proceedsBooking: ProceedsBookingMode | null;
  /** D192: the proceeds line clears the invoice's sale line (derived, not the caller's). */
  clears: boolean;
  /** D192 point 11: the Abgrenzung across a year end, or null. */
  abgrenzung: AbgrenzungPlan | null;
  /** D172: the per-call overrides that changed something (an override that bypassed nothing is not one). */
  overrides: OverridePlan[];
  warnings: ProceedsWarning[];
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
  /** D191: the A10 sales invoice the proceeds were billed on (optional). */
  proceedsInvoiceId?: string | null;
  /** D191: the A14 incoming payment the proceeds arrived as (optional). */
  proceedsPaymentId?: string | null;
  /** D192: a per-call `assets.proceeds_booking` (D172); differing from the setting needs the reason. */
  proceedsBooking?: string;
  proceedsBookingReason?: string;
  /** D192: a per-call `assets.cross_year_sale` (D172); differing from the setting needs the reason. */
  crossYearSale?: string;
  crossYearSaleReason?: string;
}

/** The workspace's `fiscal_year_start` (`MM-DD`, A03's default `01-01`). §H-TENANT by the workspace id. */
function fiscalYearStart(ctx: WorkspaceContext): string {
  const row = ctx.store.db.prepare('SELECT fiscal_year_start FROM workspace WHERE id = ?').get(ctx.workspaceId) as
    | { fiscal_year_start: string | null }
    | undefined;
  return row?.fiscal_year_start ?? '01-01';
}

/** The last day of fiscal year `label` (the year it starts in) for a `MM-DD` start. */
function lastDayOfFiscalYear(label: string, start: string): string {
  const next = new Date(`${Number(label) + 1}-${start}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

/**
 * D172: the effective value of a setting for this call. The workspace value, unless the call names
 * another, which then needs its reason (`reason_required`). Returns the refusal, or the mode with the
 * override it amounts to (null when the call agrees with the setting or names none).
 */
function effectiveMode<T extends string>(
  ctx: WorkspaceContext,
  key: OverridePlan['setting'],
  allowed: readonly T[],
  given: unknown,
  reason: unknown,
  field: string,
  action: OverridePlan['action'],
  stampLabel: string,
): Result | { mode: T; override: OverridePlan | null } {
  const setting = getSetting<T>(ctx, key);
  if (given === undefined || given === null) return { mode: setting, override: null };
  if (typeof given !== 'string' || !(allowed as readonly string[]).includes(given)) {
    return err('invalid_input', { field, allowed: [...allowed] });
  }
  if (given === setting) return { mode: setting, override: null };
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why.length === 0) {
    return err('reason_required', { field: `${field}Reason`, setting: key, settingValue: setting, value: given, hint: 'a value other than the workspace setting needs its reason; it is kept on the disposal and audited' });
  }
  return {
    mode: given as T,
    override: { setting: key, value: given, reason: why, action, stamp: `${stampLabel}: ${why}` },
  };
}

/** The refusal of a period lock on the Abgrenzung's leg, with the manual route (critic r3 C2). */
function abgrenzungLockRefusal(locked: Result, abgrenzung: AbgrenzungPlan, date: string): Result {
  const details = locked.ok ? {} : { ...locked };
  return err('period_locked', {
    ...details,
    leg: 'abgrenzung',
    date,
    abgrenzungKind: abgrenzung.kind,
    hint:
      `the Abgrenzung of this sale across the year end is dated ${date}, in a locked period. Reopen it (unlock_period) and dispose again. ` +
      `A period sealed by a VAT filing or the year close (hard_lock_sealed) cannot be reopened: dispose without the invoice link, ` +
      `the proceeds on a transit account, then book Dr ${abgrenzung.contraAccountNumber} / Cr that transit account in the open year`,
  });
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
  // D192 (critic r3 C1): a disposal is booked when the asset leaves, never ahead. A future date would let
  // the reverse (dated today, D170) land before the disposal itself, a wrong earlier year, and it would
  // stop depreciation for months the asset is still in use. No setting: no ahead-dated disposal is right.
  const today = ctx.clock.now().slice(0, 10);
  if (disposalDate > today) {
    return err('disposal_date_in_future', { disposalDate, today, hint: 'date the disposal on the day the asset leaves, at the latest today' });
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
  // D170: a disposal clears the register's cost from the GL; if a raw Storno already took a cost event
  // out of the GL (a book from before the undo verb), the disposal would clear cost that is not there.
  const rawReversed = rawReversedEvent(ctx, asset.id, ['acquisition', 'opening', 'additional_capitalisation']);
  if (rawReversed !== null) return postingReversedRefusal(asset.id, rawReversed);
  // D192 (code critic r1 R1): a reversed disposal stays booked on its own date and its mirror is dated
  // the day of the reverse (D170, OR 957a), so the asset is back on the books only from that day. A new
  // disposal dated before it would clear the asset a second time in that span (a year closing with the
  // cost cleared twice and the gain booked twice). The same kind of single check as the future date: at
  // the one place a disposal is born, inside the plan the write transaction rebuilds. No setting: no
  // disposal of an asset that was not on the books is correct.
  const reversedOn = (ctx.store.db
    .prepare("SELECT MAX(date) AS d FROM asset_transaction WHERE workspace_id = ? AND asset_id = ? AND type = 'disposal_reversal'")
    .get(ctx.workspaceId, asset.id) as { d: string | null } | undefined)?.d ?? null;
  if (reversedOn !== null && disposalDate < reversedOn) {
    return err('disposal_date_before_reversal', {
      disposalDate,
      reversedOn,
      hint: `the asset's earlier disposal was reversed on ${reversedOn}, so it is back on the books from that day; date this disposal on or after ${reversedOn}. When its invoice lies in an earlier financial year, the disposal posts the Abgrenzung into that year, so the sale still counts in the year it was invoiced`,
    });
  }

  // D192 + D172: the two settings this verb reads, each with its per-call override.
  const booking = effectiveMode<ProceedsBookingMode>(ctx, 'assets.proceeds_booking', PROCEEDS_BOOKING_MODES, input.proceedsBooking, input.proceedsBookingReason, 'proceedsBooking', 'override_proceeds_booking', 'Erlösbuchung übersteuert');
  if ('ok' in booking) return booking;
  const crossYear = effectiveMode<CrossYearSaleMode>(ctx, 'assets.cross_year_sale', CROSS_YEAR_SALE_MODES, input.crossYearSale, input.crossYearSaleReason, 'crossYearSale', 'override_cross_year_sale', 'Jahresabgrenzung übersteuert');
  if ('ok' in crossYear) return crossYear;

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

  // D191: the optional proceeds document, validated and resolved before any figure is computed.
  const link = resolveProceedsLink(
    ctx,
    { proceedsInvoiceId: input.proceedsInvoiceId, proceedsPaymentId: input.proceedsPaymentId },
    typeof input.counterpartyName === 'string' ? input.counterpartyName : null,
  );
  if (link !== null && 'ok' in link) return link;

  // D192 point 13 (critic G1): one standing disposal per invoice, in both modes. Checked before any
  // figure, so the year rule below never mistakes a second clearing for a year that is out of balance.
  if (link !== null && link.invoice !== null) {
    const other = standingDisposalOnInvoice(ctx, link.invoice.id);
    if (other !== null) {
      return err('invalid_proceeds_document', {
        field: link.invoiceFromPayment ? 'proceedsPaymentId' : 'proceedsInvoiceId',
        reason: 'invoice_already_cleared',
        proceedsInvoiceId: link.invoice.id,
        standingTransactionId: other.transactionId,
        standingAssetId: other.assetId,
        standingDate: other.date,
        hint: 'another disposal already carries this invoice; one invoice belongs to one asset sale (invoice per asset), or reverse that disposal first',
      });
    }
  }


  const overrides: OverridePlan[] = [];
  if (link !== null && booking.override !== null) overrides.push(booking.override);
  const clears = link !== null && booking.mode === 'clear_via_document';
  const warnings: ProceedsWarning[] = [...(link?.warnings ?? [])];

  let proceeds: number;
  let proceedsAcc: AccountRow | undefined;
  let clearingCostCenter: string | null = null;
  let abgrenzung: AbgrenzungPlan | null = null;

  if (clears) {
    // D192 point 1: a payment-only link that does not resolve to an invoice is refused (owner Q1).
    if (link.invoice === null) {
      return err('invalid_proceeds_document', {
        field: 'proceedsPaymentId',
        reason: 'proceeds_needs_invoice',
        proceedsPaymentId: link.paymentId,
        invoiceIds: link.paymentInvoiceIds,
        hint: 'issue the invoice for the sale, apply this payment to it (allocate_payment), then dispose against the invoice; the VAT stays on the invoice',
      });
    }
    const sale = saleLineOf(ctx, link.invoice);
    if ('ok' in sale) return sale;
    proceeds = sale.line.baseCreditMinor;
    proceedsAcc = readAccount(ctx, sale.line.accountId);
    if (proceedsAcc === undefined) return err('invalid_gl_accounts', { accountId: sale.line.accountId, reason: 'sale_line_account_missing' });
    clearingCostCenter = sale.line.costCenterId;
    // D192 point 4: the caller may echo the derived figures; a different one is never silently ignored.
    if (input.proceedsRappen !== undefined && input.proceedsRappen !== null && input.proceedsRappen !== proceeds) {
      return err('invalid_input', { field: 'proceedsRappen', reason: 'proceeds_from_document', givenProceedsRappen: input.proceedsRappen, derivedProceedsRappen: proceeds, hint: 'the proceeds come from the invoice; leave them out, or pass the derived figure' });
    }
    if (typeof input.proceedsAccountId === 'string' && input.proceedsAccountId.length > 0 && input.proceedsAccountId !== proceedsAcc.id) {
      return err('invalid_input', { field: 'proceedsAccountId', reason: 'proceeds_from_document', givenProceedsAccountId: input.proceedsAccountId, derivedProceedsAccountId: proceedsAcc.id, hint: 'the proceeds account comes from the invoice; leave it out, or pass the derived account' });
    }

    // D192 point 11, and code critic r2 S1: EACH YEAR RIGHT BY CONSTRUCTION. Everything this invoice's sale
    // has already put on its sale account (the invoice, every earlier disposal's clearing and mirror, the
    // Abgrenzungen they posted, their Rückbuchungen and Stornos) is summed per financial year, this
    // disposal's clearing is added, and the plan posts only the Abgrenzung that brings every year back to
    // zero. A first disposal across a year end needs one ((g) accrued_income, (h) deferred_income); a redo
    // after a reverse whose predecessor's Abgrenzung still stands in the earlier year needs none, so it
    // never books a second deferral there (S1); a redo in the invoice's own year after a cross-year one
    // needs none either. Anything else than one adjacent pair is refused years_not_adjacent.
    const start = fiscalYearStart(ctx);
    const fyDisposal = fiscalYearOf(disposalDate, start);
    const fyInvoice = fiscalYearOf(sale.entryDate, start);
    const byYear = new Map<string, number>();
    for (const row of saleAccountNetByDate(ctx, link.invoice, proceedsAcc.id)) {
      const fy = fiscalYearOf(row.date, start);
      byYear.set(fy, (byYear.get(fy) ?? 0) + row.net);
    }
    byYear.set(fyDisposal, (byYear.get(fyDisposal) ?? 0) + proceeds);
    const open = [...byYear.entries()].filter(([, v]) => v !== 0).sort(([a], [b]) => Number(a) - Number(b));
    if (open.length > 0) {
      const pair = open.length === 2 && Number(open[1]![0]) === Number(open[0]![0]) + 1 && open[0]![1] === -open[1]![1];
      if (!pair) {
        return err('years_not_adjacent', {
          disposalDate,
          invoiceDate: sale.entryDate,
          disposalYear: fyDisposal,
          invoiceYear: fyInvoice,
          openYears: open.map(([year, netMinor]) => ({ year, netMinor })),
          hint: 'one Abgrenzung spans one year end; book the proceeds yourself (proceedsBooking book_proceeds) with your own Abgrenzungen',
        });
      }
      const [earlier, earlierNet] = open[0]!;
      if (crossYear.override !== null) overrides.push(crossYear.override);
      if (crossYear.mode === 'refuse') {
        const suggested = reversedOn !== null && reversedOn > sale.entryDate ? reversedOn : sale.entryDate;
        return err('sale_in_other_financial_year', {
          disposalDate,
          invoiceDate: sale.entryDate,
          disposalYear: fyDisposal,
          invoiceYear: fyInvoice,
          suggestedDisposalDate: suggested,
          hint: 'date the disposal in the invoice\'s financial year, or let the disposal post the Abgrenzung (assets.cross_year_sale post_abgrenzung)',
        });
      }
      const periodEnd = lastDayOfFiscalYear(earlier, start);
      abgrenzung = {
        // The earlier year holds a DEBIT (handed over, invoiced later): Ertrag noch nicht fakturiert. A
        // CREDIT (invoiced, handed over later): Ertrag vorausfakturiert. Its amount is what is open.
        kind: earlierNet > 0 ? 'accrued_income' : 'deferred_income',
        periodEnd,
        reversalDate: firstDayAfter(periodEnd),
        amountRappen: Math.abs(earlierNet),
        contraAccountId: proceedsAcc.id,
        contraAccountNumber: proceedsAcc.number,
        contraAccountName: proceedsAcc.name,
        costCenterId: clearingCostCenter,
      };
    } else if (fyDisposal === fyInvoice && disposalDate.slice(0, 7) !== sale.entryDate.slice(0, 7)) {
      warnings.push({ code: 'sale_in_other_month', disposalDate, invoiceDate: sale.entryDate });
    }

    // D192 point 2: reductions are warned, never refused or adjusted.
    const reductions = saleReductionsOf(ctx, link.invoice.id);
    if (reductions.creditNotes.length > 0 || reductions.skontoMinor > 0 || reductions.writeOffMinor > 0) {
      warnings.push({ code: 'sale_reduced', currency: link.invoice.currency, ...reductions, hint: 'the disposal clears the full sale line; the reductions stay where they were booked, so the gain is stated before them' });
    }
  } else {
    const given = input.proceedsRappen;
    if (typeof given !== 'number' || !Number.isInteger(given) || given < 0) {
      return err('invalid_proceeds', { proceedsRappen: given });
    }
    proceeds = given;
    if (link !== null && proceeds <= 0) {
      return err('invalid_proceeds_document', {
        field: link.invoiceId !== null ? 'proceedsInvoiceId' : 'proceedsPaymentId',
        reason: 'no_proceeds',
        hint: 'a disposal without proceeds (a scrap) has no proceeds document',
      });
    }
    // The proceeds account is required and validated ONLY when proceeds are actually received: a scrap
    // (proceeds == 0) books no proceeds line, so demanding an unused bank account for it would be noise.
    if (proceeds > 0) {
      if (typeof input.proceedsAccountId !== 'string' || input.proceedsAccountId.length === 0) {
        return err('invalid_proceeds_account', { reason: 'missing' });
      }
      proceedsAcc = readAccount(ctx, input.proceedsAccountId);
      if (proceedsAcc === undefined) {
        return err('invalid_proceeds_account', { proceedsAccountId: input.proceedsAccountId, reason: 'not_found' });
      }
      // D192 point 7 (i): under book_proceeds an invoice link may book on the invoice's own sale account
      // (the manual clearing), although that is an income account.
      const manualClearing = isInvoiceSaleAccount(ctx, link, proceedsAcc.id);
      if (!PROCEEDS_ACCOUNT_TYPES.has(proceedsAcc.type) && !manualClearing) {
        return err('invalid_proceeds_account', {
          proceedsAccountId: input.proceedsAccountId,
          type: proceedsAcc.type,
          expected: [...PROCEEDS_ACCOUNT_TYPES],
        });
      }
      if (link !== null) {
        warnings.push(...bookProceedsWarnings(ctx, link, proceeds, proceedsAcc.id));
        // D192 point 11: the year rule binds the manual clearing; on a money account it warns.
        if (link.invoice !== null) {
          const invoiceDate = entryDateOf(ctx, link.invoice.posted_entry_id);
          const start = fiscalYearStart(ctx);
          if (invoiceDate !== null && fiscalYearOf(invoiceDate, start) !== fiscalYearOf(disposalDate, start)) {
            if (manualClearing) {
              return err('sale_in_other_financial_year', {
                disposalDate,
                invoiceDate,
                disposalYear: fiscalYearOf(disposalDate, start),
                invoiceYear: fiscalYearOf(invoiceDate, start),
                suggestedDisposalDate: invoiceDate,
                hint: 'a manual clearing nets only within one financial year: date the disposal in the invoice\'s year, or clear via the invoice (it posts the Abgrenzung)',
              });
            }
            warnings.push({ code: 'sale_in_other_financial_year', disposalDate, invoiceDate });
          }
        }
      }
    } else if (link !== null) {
      warnings.push(...bookProceedsWarnings(ctx, link, proceeds, null));
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

  const debit = (a: AccountRow, amount: number, costCenter: string | null = null): PlannedLine => ({
    account_id: a.id,
    account_number: a.number,
    account_name: a.name,
    debit_rappen: amount,
    credit_rappen: 0,
    side: 'debit',
    cost_center_id: costCenter,
  });
  const credit = (a: AccountRow, amount: number): PlannedLine => ({
    account_id: a.id,
    account_number: a.number,
    account_name: a.name,
    debit_rappen: 0,
    credit_rappen: amount,
    side: 'credit',
    cost_center_id: null,
  });

  // The deterministic algorithm (spec §4). Σ debit == Σ credit holds by construction: the identity
  // C + max(G,0) == A + P + max(-G,0) is what balances every case (gain, loss, exact, scrap,
  // zero-accumulated). Order: clear accumulated, recognise proceeds (D192: or clear the sale line),
  // recognise loss, clear cost, recognise gain, so the preview reads top-to-bottom as an accountant
  // would write it.
  const lines: PlannedLine[] = [];
  if (A > 0) lines.push(debit(accumAcc, A)); // 1. clear accumulated depreciation
  if (P > 0 && proceedsAcc !== undefined) lines.push(debit(proceedsAcc, P, clears ? clearingCostCenter : null)); // 2. proceeds or clearing
  if (G < 0) lines.push(debit(gainLossAcc, -G)); // 3. recognise loss
  lines.push(credit(assetAcc, C)); // 4. clear asset cost
  if (G > 0) lines.push(credit(gainLossAcc, G)); // 5. recognise gain

  const description = composeDescription(asset, input, overrides);

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
    proceedsLink: link,
    proceedsBooking: link === null ? null : booking.mode,
    clears,
    abgrenzung,
    overrides,
    warnings,
  };
}

/** The journal / transaction description: the operator's reason, or an auto sentence, plus the optional
 * counterparty, free notes and (D172) each override's stamp folded in (the table has no dedicated
 * columns for them, spec §4). Joined with '; ' rather than a dash, because the house style bans em/en
 * dashes as separators. */
function composeDescription(asset: AssetRow, input: AssetDisposalInputBase, overrides: OverridePlan[] = []): string {
  const parts: string[] = [];
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  parts.push(reason.length > 0 ? reason : `Abgang Anlage ${asset.number} ${asset.name}`);
  const counterparty = typeof input.counterpartyName === 'string' ? input.counterpartyName.trim() : '';
  if (counterparty.length > 0) parts.push(`Gegenpartei: ${counterparty}`);
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (notes.length > 0) parts.push(notes);
  for (const o of overrides) parts.push(o.stamp);
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

/** D192 point 11: the Abgrenzung's two entries as the preview shows them (A at periodEnd, B the next day). */
function abgrenzungPayload(ctx: WorkspaceContext, a: AbgrenzungPlan | null) {
  if (a === null) return null;
  const balanceNumber = a.kind === 'accrued_income' ? '1300' : '2300';
  const balance = ctx.store.db
    .prepare('SELECT id, number, name FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, balanceNumber) as { id: string; number: string; name: string } | undefined;
  const side = (debit: boolean, acc: { id: string; number: string; name: string }) => ({
    account_id: acc.id,
    account_number: acc.number,
    account_name: acc.name,
    debit_rappen: debit ? a.amountRappen : 0,
    credit_rappen: debit ? 0 : a.amountRappen,
    side: debit ? ('debit' as const) : ('credit' as const),
  });
  const contra = { id: a.contraAccountId, number: a.contraAccountNumber, name: a.contraAccountName };
  const bal = balance ?? { id: '', number: balanceNumber, name: '' };
  // accrued_income: Dr 1300 / Cr the sale account; deferred_income: Dr the sale account / Cr 2300.
  const entryLines = a.kind === 'accrued_income' ? [side(true, bal), side(false, contra)] : [side(true, contra), side(false, bal)];
  const reversalLines = entryLines.map((l) => ({
    ...l,
    debit_rappen: l.credit_rappen,
    credit_rappen: l.debit_rappen,
    side: l.side === 'debit' ? ('credit' as const) : ('debit' as const),
  }));
  return {
    kind: a.kind,
    period_end: a.periodEnd,
    reversal_date: a.reversalDate,
    amount_rappen: a.amountRappen,
    lines: entryLines,
    reversal_lines: reversalLines,
  };
}

function previewPayload(ctx: WorkspaceContext, plan: DisposalPlan) {
  // D192: the preview stays a pure read, but says before the click that the Abgrenzung's leg is locked.
  const warnings = [...plan.warnings];
  if (plan.abgrenzung !== null) {
    for (const date of [plan.abgrenzung.periodEnd, plan.abgrenzung.reversalDate]) {
      const open = ctx.periods.assertOpen(date);
      if (!open.ok) {
        warnings.push({ code: 'abgrenzung_period_locked', date, period: (open as { period?: unknown }).period ?? null });
        break;
      }
    }
  }
  const proceedsAccount = plan.proceedsAccountId === null ? null : readAccount(ctx, plan.proceedsAccountId) ?? null;
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
    proceeds_document: proceedsDocumentPayload(plan.proceedsLink),
    // D192: how the proceeds are booked, and from where (derived when the disposal clears the invoice).
    proceeds_booking: plan.proceedsBooking,
    proceeds_from_document: plan.clears,
    proceeds_account: proceedsAccount === null ? null : { id: proceedsAccount.id, number: proceedsAccount.number, name: proceedsAccount.name },
    abgrenzung: abgrenzungPayload(ctx, plan.abgrenzung),
    warnings,
  };
}

/** D191: what the caller is shown about the link; null means none was named (no proceeds check). */
function proceedsDocumentPayload(link: ProceedsLink | null) {
  if (link === null) return null;
  return { type: link.storedType, id: link.storedId, invoiceId: link.invoiceId, paymentId: link.paymentId, invoiceFromPayment: link.invoiceFromPayment };
}

export type AssetDisposalPreviewInput = AssetDisposalInputBase;

export function assetDisposalPreview(ctx: WorkspaceContext, input: AssetDisposalPreviewInput): Result {
  const plan = planDisposal(ctx, input);
  if ('ok' in plan) return plan; // a rejection Result
  return ok({ preview: previewPayload(ctx, plan) });
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

/** §H-PERIOD for every date the disposal writes: its own, and (D192) the Abgrenzung's two legs. */
function periodsOpen(ctx: WorkspaceContext, plan: DisposalPlan): Result {
  const own = ctx.periods.assertOpen(plan.disposalDate);
  if (!own.ok) return own;
  if (plan.abgrenzung !== null) {
    for (const date of [plan.abgrenzung.periodEnd, plan.abgrenzung.reversalDate]) {
      const open = ctx.periods.assertOpen(date);
      if (!open.ok) return abgrenzungLockRefusal(open, plan.abgrenzung, date);
    }
  }
  return ok();
}

export function assetDispose(ctx: WorkspaceContext, input: AssetDisposeInput): Result {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  // Replay a completed disposal BEFORE any state-dependent guard (§H-IDEMPOTENT), so a retry returns
  // the original objects instead of tripping asset_already_disposed on the disposal it itself wrote.
  // A replay reads no setting, no invoice and no Abgrenzung (D192 point 10).
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_dispose');
  if (replayed !== undefined) return replayed;

  // The friendly pre-check: the plan and its periods, out of the transaction.
  const precheck = planDisposal(ctx, input);
  if ('ok' in precheck) return precheck; // a rejection Result
  const periodOpen = periodsOpen(ctx, precheck);
  if (!periodOpen.ok) return periodOpen;

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey as string, 'asset_dispose', () => {
      // D192 (D12): the plan is rebuilt INSIDE the write transaction, so the settings, the invoice's sale
      // line, its reductions, the year and the one-disposal-per-invoice rule are read where the write
      // happens. A change between the pre-check and here is honoured, never a stale plan posted.
      const plan = planDisposal(ctx, input);
      if ('ok' in plan) throw new DisposalAbort(plan);
      const periodsNow = periodsOpen(ctx, plan);
      if (!periodsNow.ok) throw new DisposalAbort(periodsNow);

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
            ? { account: l.account_id, debit: l.debit_rappen, ...(l.cost_center_id !== null ? { costCenter: l.cost_center_id } : {}) }
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
      // before the one-live-disposal trigger would (the trigger, D170, is the ultimate DB
      // guarantee underneath). NBV is forced to 0 (the asset has left the books), while acquisition cost
      // and accumulated depreciation are LEFT at their pre-disposal values for historical reporting
      // (spec §4). From here H03/H04 permanently exclude it (status filter).
      const moved = ctx.store.db
        .prepare(
          `UPDATE asset SET status = 'disposed', disposed_at = ?, disposal_proceeds_rappen = ?,
                  net_book_value_rappen = 0, updated_at = ?
             WHERE workspace_id = ? AND id = ? AND status IN ('active', 'fully_depreciated')`,
        )
        .run(plan.disposalDate, plan.proceedsRappen, now, ctx.workspaceId, plan.asset.id);
      if (moved.changes === 0) {
        throw new DisposalAbort(err('asset_already_disposed', { assetId: plan.asset.id }));
      }

      // The append-only sub-ledger event. A disposal clears the asset: `delta_cost_rappen` is the
      // negative of the full cost basis and `delta_accum_depr_rappen` the negative of the accumulated,
      // so summed over the asset's whole history both convenience totals return to zero (OP11). The
      // `asset_transaction_one_live_disposal` trigger rejects a second live disposal row structurally
      // (D170), and `asset_transaction_one_live_invoice_disposal` a second standing disposal of one
      // invoice (D192 point 13).
      ctx.store.db
        .prepare(
          `INSERT INTO asset_transaction (
             id, workspace_id, asset_id, type, date, delta_cost_rappen, delta_accum_depr_rappen,
             proceeds_rappen, gain_loss_rappen, journal_entry_id, source_document_type,
             source_document_id, description, created_at, created_by, idempotency_key
           ) VALUES (?, ?, ?, 'disposal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          // D191: the proceeds document rides the row's existing source-document link (no schema change).
          plan.proceedsLink?.storedType ?? null,
          plan.proceedsLink?.storedId ?? null,
          plan.description,
          now,
          ctx.actor,
          input.idempotencyKey,
        );

      // §H-AUDIT: the sub-ledger event is recorded in the trail as well as in the journal (which A02
      // already audited under `entry`). D192: a disposal that clears its invoice records it, the fact
      // `asset_ledger_get` reads `proceedsBooking` from; each override is its own audited act.
      ctx.audit.record({ entityKind: 'asset_transaction', entityId: txnId, action: 'post', actor: ctx.actor, at: now });
      if (plan.clears) {
        ctx.audit.record({ entityKind: 'asset_transaction', entityId: txnId, action: 'proceeds_cleared', actor: ctx.actor, at: now });
      }
      for (const o of plan.overrides) {
        ctx.audit.record({ entityKind: 'asset_transaction', entityId: txnId, action: o.action, actor: ctx.actor, at: now });
      }

      // D192 point 11 (owner option b): the Abgrenzung of a sale across the year end, through A38's own
      // create and post bodies, in THIS transaction. A refusal (a locked leg) rolls everything back.
      let abgrenzung: { accrualId: string; entryId: string; reversalEntryId: string; kind: string; periodEnd: string; reversalDate: string } | null = null;
      if (plan.abgrenzung !== null) {
        const a = plan.abgrenzung;
        const postedA = postDisposalAbgrenzungWithin(ctx, {
          kind: a.kind,
          periodEnd: a.periodEnd,
          amountMinor: a.amountRappen,
          contraAccountId: a.contraAccountId,
          costCenterId: a.costCenterId,
          description: `Abgrenzung Abgang Anlage ${plan.asset.number} ${plan.asset.name}`.slice(0, 200),
          disposalTransactionId: txnId,
        });
        if (!postedA.ok) {
          throw new DisposalAbort(postedA.error === 'period_locked' ? abgrenzungLockRefusal(postedA, a, String(postedA.date ?? a.periodEnd)) : postedA);
        }
        abgrenzung = { accrualId: postedA.accrualId, entryId: postedA.entryId, reversalEntryId: postedA.reversalEntryId, kind: a.kind, periodEnd: a.periodEnd, reversalDate: a.reversalDate };
      }

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
        proceedsDocument: proceedsDocumentPayload(plan.proceedsLink),
        proceedsBooking: plan.proceedsBooking,
        proceedsFromDocument: plan.clears,
        abgrenzung,
        overridden: plan.overrides.map((o) => o.setting),
        warnings: plan.warnings,
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
