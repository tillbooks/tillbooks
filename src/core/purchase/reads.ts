/**
 * A17's read models (Pattern P5): the Kreditoren list, one bill, and the ONE settlement derivation.
 *
 * This is the creditor mirror of A16's OP-Liste, and it is deliberately a mirror rather than a copy.
 * A16's shape is reused wholesale: the aging boundaries come from A16's own configuration row (one
 * workspace decides where the buckets cut, once, for both sides of the ledger), the bucket keys come
 * from A16's `bucketKeys`, and the reconciliation is reported the same way it is there.
 *
 * ## The invariant
 *
 *     baseTotalOpenMinor == the posted balance of account 2000 Kreditoren as of today
 *
 * `reconciled` is REPORTED on the list rather than assumed, computed from two genuinely independent
 * derivations: the open amounts come from `vendor_bill` and `payment_allocation`, the target comes from
 * `journal_line`. They agree only if they are both right, which is what makes the read model
 * self-policing as A18 and A20 land: any future movement on 2000 that A17 does not model shows up as
 * `reconciled:false` on a real workspace rather than as a silently wrong total.
 *
 * ## What is NOT modelled, and why it is stated rather than stubbed
 *
 *  - **A parked outgoing payment against a supplier.** A16 lists parked customer payments because they
 *    are part of what 1100 holds. The same is true of 2000, and A14 already carries the row: an
 *    outgoing payment with a supplier counterparty and an unallocated remainder. It is reported as
 *    `onAccountMinor` on the list total so the reconciliation holds, and it is NOT broken out as a row
 *    of its own, because a bill list whose rows are not bills would be a different capability's read.
 *  - **Purchase-side Skonto and creditor payment runs.** A14 refuses the first and A18 owns the
 *    second, so neither can move 2000 today.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString, optionalDate, optionalId } from '../ledger/inputGuards.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { ROLE_ACCOUNT_NUMBER } from '../payments/accounts.js';
import { agingBoundariesOf, bucketKeys } from '../debtors/index.js';
import { applySavedView } from '../customization/views.js';
import { resolveContactRef } from '../sales/contact.js';
import {
  VENDOR_BILL_STATUSES,
  VENDOR_BILL_SETTLEMENT_STATUSES,
  displayStatus,
  settlementStatusFor,
} from './enums.js';
import type { VendorBillSettlementStatus, VendorBillStatus } from './enums.js';

/** The reconciliation target (§3, fixed): Kontenrahmen KMU 2000 Kreditoren, from the one role map. */
const PAYABLE_ACCOUNT = ROLE_ACCOUNT_NUMBER.payable;

export interface VendorBillRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  bill_date: string;
  due_date: string | null;
  supply_date: string | null;
  vendor_reference: string | null;
  currency: string;
  amount_is_gross: number;
  net_minor: number;
  tax_code: string | null;
  tax_amount_minor: number;
  gross_minor: number;
  payable_minor: number;
  expense_account_id: string;
  cost_center_id: string | null;
  project_id: string | null;
  receipt_ref: string | null;
  status: VendorBillStatus;
  base_net_minor: number | null;
  base_tax_minor: number | null;
  base_gross_minor: number | null;
  base_payable_minor: number | null;
  fx_rate: string | null;
  entry_id: string | null;
  reversal_entry_id: string | null;
  void_reason: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: string;
  posted_at: string | null;
  /** G21: `native` or `migrated`. A migrated bill reaches `posted` with `entry_id` NULL, posting
   *  nothing; its `payable_minor` is part of what 2000 holds via A04's opening line. */
  origin: string;
}

/** One bill, §H-TENANT on the lookup. The ONE row reader every A17 verb shares. */
export function readVendorBillRow(ctx: WorkspaceContext, id: unknown): VendorBillRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM vendor_bill WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as VendorBillRow | undefined;
}

/**
 * What has been settled against ONE bill, in Rappen. The whole settlement derivation, in one place.
 *
 * §H-TENANT on BOTH sides of the join, exactly as A14's own `settledMinor` does it: the allocation
 * rows and the payments they belong to are each filtered to this workspace, so a foreign payment can
 * never reduce a local bill's open amount. Allocations of a REVERSED payment are excluded, which is
 * how a reversal re-opens the bill it settled without rewriting a single allocation row.
 */
export function settledOnVendorBill(ctx: WorkspaceContext, vendorBillId: string, asOf?: string): number {
  // The UNBOUNDED read (no `asOf`) is the display semantics: what settles this bill today, which is
  // the posted payments and nothing else. The BOUNDED read is the reconciliation's, and it is a
  // SIGNED sum of EVENTS up to the Stichtag rather than of current statuses (A17-R3's principle on
  // the settlement leg, completed for A17-R6): each allocation counts +1 on the payment's own date
  // and -1 on its reversal's date, inside the window. So a payment dated inside the window still
  // counts while its reversal is dated after it (the ledger holds the debit and not yet the
  // credit), both inside nets to zero exactly as the status read did, and a FUTURE payment
  // reversed today contributes the reversal alone: a negative settled amount matching the 2000
  // credit the ledger already carries.
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(
                (CASE
                   WHEN ? IS NULL THEN (CASE WHEN p.status = 'posted' THEN 1 ELSE 0 END)
                   ELSE ((CASE WHEN p.date <= ? THEN 1 ELSE 0 END)
                         - (CASE WHEN rev.date IS NOT NULL AND rev.date <= ? THEN 1 ELSE 0 END))
                 END)
                * (a.amount_minor + a.skonto_minor + a.skonto_vat_minor + a.writeoff_minor)
              ), 0) AS total
         FROM payment_allocation a
         JOIN payment p ON p.id = a.payment_id AND p.workspace_id = ?
         LEFT JOIN journal_entry rev ON rev.id = p.reversal_entry_id AND rev.workspace_id = p.workspace_id
        WHERE a.workspace_id = ? AND a.target_kind = 'vendor_bill' AND a.target_id = ?`,
    )
    .get(asOf ?? null, asOf ?? null, asOf ?? null, ctx.workspaceId, ctx.workspaceId, vendorBillId) as {
    total: number;
  };
  return row.total;
}

/** Whole days between two ISO calendar dates, in UTC. The same arithmetic A16 uses. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

function bucketFor(daysOverdue: number, boundaries: readonly number[], keys: readonly string[]): string {
  for (const [i, boundary] of boundaries.entries()) {
    if (daysOverdue <= boundary) return keys[i] as string;
  }
  return keys[keys.length - 1] as string;
}

/** The posted balance of 2000 Kreditoren as of a date: the reconciliation target, from the ledger. */
export function payablesBalanceAsOf(ctx: WorkspaceContext, asOf: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS net
         FROM journal_line l
         JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted' AND e.date <= ?`,
    )
    .get(ctx.workspaceId, PAYABLE_ACCOUNT, asOf) as { net: number };
  return row.net;
}

/**
 * The unallocated remainder of every non-reversed outgoing payment whose entry MOVED 2000.
 *
 * Part of what 2000 holds: a payment made without naming a bill credits the bank and debits the
 * payable, leaving a debit balance on the creditor account that no bill accounts for. Reported so the
 * reconciliation can hold rather than fail on a legitimate state.
 *
 * KEYED ON THE LEG, NOT ON `counterparty_kind` (A17-C5). The leg side follows the allocation TARGET
 * (a vendor-bill target forces the payable side whatever kind the caller stated), so a payment
 * recorded with `counterpartyKind:'customer'` against a vendor bill parks its remainder on 2000 with
 * a `customer` label on the row. The reconciliation compares against the LEDGER, so its on-account
 * term has to read the same fact the ledger holds: the entry's own movement on the payable account.
 * Two rules for one fact is how a correct ledger gets reported as a mismatch.
 *
 * A SUM OF EVENTS, NOT OF STATUSES (A17-R6, the last instance of the R3 class). `p.status` flips
 * the instant a reversal is recorded, while the ledger keeps the payment's 2000 debit until the
 * reversal's own date, so admitting on status made a parked remainder vanish today when its
 * reversal is dated next month. Each payment contributes its remainder once per event inside the
 * window, signed: +1 for the payment on its own date, -1 for the reversal on its date. A payment
 * and reversal both inside the window net to zero (the old behaviour, kept), one inside and one
 * out contributes the half the ledger actually holds, and a future payment reversed TODAY
 * contributes the reversal alone: a negative remainder matching the 2000 credit already booked.
 */
function supplierOnAccountMinor(ctx: WorkspaceContext, asOf: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(
                ((CASE WHEN p.date <= ? THEN 1 ELSE 0 END)
                 - (CASE WHEN rev.date IS NOT NULL AND rev.date <= ? THEN 1 ELSE 0 END))
                * (p.base_amount_minor
                   - COALESCE((SELECT SUM(a.base_amount_minor) FROM payment_allocation a
                                WHERE a.workspace_id = p.workspace_id AND a.payment_id = p.id), 0))
              ), 0) AS total
         FROM payment p
         LEFT JOIN journal_entry rev ON rev.id = p.reversal_entry_id AND rev.workspace_id = p.workspace_id
        WHERE p.workspace_id = ? AND p.direction = 'outgoing'
          AND EXISTS (SELECT 1 FROM journal_line l
                        JOIN account acc ON acc.id = l.account_id
                       WHERE l.entry_id = p.journal_entry_id
                         AND acc.workspace_id = p.workspace_id AND acc.number = ?)`,
    )
    .get(asOf, asOf, ctx.workspaceId, PAYABLE_ACCOUNT) as { total: number };
  return row.total;
}

export interface VendorBillView {
  id: string;
  vendorId: string;
  vendorName: string | null;
  billDate: string;
  dueDate: string | null;
  supplyDate: string | null;
  vendorReference: string | null;
  currency: string;
  amountIsGross: boolean;
  netMinor: number;
  taxCode: string | null;
  taxAmountMinor: number;
  grossMinor: number;
  payableMinor: number;
  paidMinor: number;
  openMinor: number;
  baseNetMinor: number | null;
  baseTaxMinor: number | null;
  baseGrossMinor: number | null;
  basePayableMinor: number | null;
  baseOpenMinor: number | null;
  fxRate: string | null;
  expenseAccountId: string;
  expenseAccountNumber: string | null;
  expenseAccountName: string | null;
  costCenterId: string | null;
  projectId: string | null;
  receiptRef: string | null;
  status: VendorBillStatus;
  settlementStatus: VendorBillSettlementStatus;
  /** The one word a screen shows, folded in the ENGINE so both faces read the same status. */
  displayStatus: string;
  entryId: string | null;
  reversalEntryId: string | null;
  voidReason: string | null;
  daysOverdue: number;
  overdue: boolean;
  bucket: string;
  createdAt: string;
  postedAt: string | null;
}

/** Map one row to the read model, deriving the settlement half from A14's allocations. */
function mapBill(
  ctx: WorkspaceContext,
  row: VendorBillRow,
  asOf: string,
  boundaries: readonly number[],
  keys: readonly string[],
): VendorBillView {
  const paidMinor = row.status === 'posted' ? settledOnVendorBill(ctx, row.id) : 0;
  const settlement = row.status === 'posted' ? settlementStatusFor(row.payable_minor, paidMinor) : 'unpaid';
  const openMinor = row.status === 'posted' ? row.payable_minor - paidMinor : 0;
  // A merge re-points `vendor_bill.contact_id`, so this is normally the identity. It goes through the
  // resolver anyway, for A16's stated reason: the FK re-point list is a list somebody has to remember
  // to extend, and a read model that resolves is correct whether or not that list is complete.
  const party = resolveContactRef(ctx, row.contact_id);
  const account = ctx.store.db
    .prepare('SELECT number, name FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, row.expense_account_id) as { number: string; name: string } | undefined;
  const daysOverdue =
    row.due_date === null || openMinor <= 0 ? 0 : Math.max(0, daysBetween(row.due_date, asOf));
  // The base open amount takes the settled share off the BOOKED base, proportionally, the same rule
  // A14 books a settlement with and A16 reports one with. Identity for a base-currency bill.
  const basePayable = row.base_payable_minor;
  const baseOpenMinor =
    basePayable === null || row.status !== 'posted'
      ? null
      : row.payable_minor === 0
        ? 0
        : basePayable - Math.round((basePayable * paidMinor) / row.payable_minor);

  return {
    id: row.id,
    vendorId: party?.id ?? row.contact_id,
    vendorName: party?.name ?? null,
    billDate: row.bill_date,
    dueDate: row.due_date,
    supplyDate: row.supply_date,
    vendorReference: row.vendor_reference,
    currency: row.currency,
    amountIsGross: row.amount_is_gross === 1,
    netMinor: row.net_minor,
    taxCode: row.tax_code,
    taxAmountMinor: row.tax_amount_minor,
    grossMinor: row.gross_minor,
    payableMinor: row.payable_minor,
    paidMinor,
    openMinor,
    baseNetMinor: row.base_net_minor,
    baseTaxMinor: row.base_tax_minor,
    baseGrossMinor: row.base_gross_minor,
    basePayableMinor: row.base_payable_minor,
    baseOpenMinor,
    fxRate: row.fx_rate,
    expenseAccountId: row.expense_account_id,
    expenseAccountNumber: account?.number ?? null,
    expenseAccountName: account?.name ?? null,
    costCenterId: row.cost_center_id,
    projectId: row.project_id,
    receiptRef: row.receipt_ref,
    status: row.status,
    settlementStatus: settlement,
    displayStatus: displayStatus(row.status, settlement),
    entryId: row.entry_id,
    reversalEntryId: row.reversal_entry_id,
    voidReason: row.void_reason,
    daysOverdue,
    overdue: daysOverdue > 0,
    bucket: bucketFor(daysOverdue, boundaries, keys),
    createdAt: row.created_at,
    postedAt: row.posted_at,
  };
}

/** The read model a write echoes back, so a surface renders THIS instead of re-fetching (D-stale). */
export function vendorBillEcho(ctx: WorkspaceContext, id: string): VendorBillView | null {
  const row = readVendorBillRow(ctx, id);
  if (row === undefined) return null;
  const asOf = ctx.clock.now().slice(0, 10);
  const boundaries = agingBoundariesOf(ctx);
  return mapBill(ctx, row, asOf, boundaries, bucketKeys(boundaries));
}

export interface ListVendorBillsInput {
  status?: string;
  settlementStatus?: string;
  vendorId?: string;
  from?: string;
  to?: string;
  savedViewId?: string;
}

/** The ceiling this list loads to, mirroring A14/A10's posture: load all, flag truncation. */
export const VENDOR_BILL_LIST_CEILING = 1000;

/**
 * The Kreditoren list: every bill, its open amount, its aging bucket, and the tie-back to 2000.
 *
 * `settlementStatus` is a DERIVED filter and is therefore applied after the derivation rather than in
 * SQL. That is the honest place for it: filtering on a column that does not exist would be the whole
 * defect this design avoids, and the ceiling above bounds the set the filter runs over.
 */
export function listVendorBills(ctx: WorkspaceContext, input: ListVendorBillsInput = {}): Result {
  const guard =
    optionalId(input.vendorId, 'vendorId') ?? optionalDate(input.from, 'from') ?? optionalDate(input.to, 'to');
  if (guard) return guard;
  if (input.status !== undefined && !(VENDOR_BILL_STATUSES as readonly string[]).includes(input.status)) {
    return err('invalid_input', { field: 'status', allowed: [...VENDOR_BILL_STATUSES] });
  }
  if (
    input.settlementStatus !== undefined &&
    !(VENDOR_BILL_SETTLEMENT_STATUSES as readonly string[]).includes(input.settlementStatus)
  ) {
    return err('invalid_input', {
      field: 'settlementStatus',
      allowed: [...VENDOR_BILL_SETTLEMENT_STATUSES],
    });
  }

  // G00's saved-view seam: the same one-line resolution `list_documents` and `list_payments` use, and
  // it is one line because G00 knows nothing about vendor bills.
  const viewed = applySavedView(ctx, 'vendor_bill', input);
  if (!viewed.ok) return viewed;
  const filter = viewed.filter;

  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.vendorId !== undefined) {
    clauses.push('contact_id = ?');
    params.push(filter.vendorId);
  }
  if (filter.from !== undefined) {
    clauses.push('bill_date >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('bill_date <= ?');
    params.push(filter.to);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM vendor_bill WHERE ${clauses.join(' AND ')} ORDER BY bill_date DESC, rowid DESC LIMIT ?`,
    )
    .all(...params, VENDOR_BILL_LIST_CEILING + 1) as VendorBillRow[];
  const truncated = rows.length > VENDOR_BILL_LIST_CEILING;
  const asOf = ctx.clock.now().slice(0, 10);
  const boundaries = agingBoundariesOf(ctx);
  const keys = bucketKeys(boundaries);

  let bills = (truncated ? rows.slice(0, VENDOR_BILL_LIST_CEILING) : rows).map((r) =>
    mapBill(ctx, r, asOf, boundaries, keys),
  );
  if (filter.settlementStatus !== undefined) {
    bills = bills.filter((b) => b.status === 'posted' && b.settlementStatus === filter.settlementStatus);
  }

  const baseCurrency = baseCurrencyOf(ctx);
  const openBills = bills.filter((b) => b.status === 'posted' && b.openMinor > 0);
  const baseTotalOpenMinor = openBills.reduce((n, b) => n + (b.baseOpenMinor ?? 0), 0);
  const bucketTotals: Record<string, number> = {};
  for (const key of keys) bucketTotals[key] = 0;
  for (const b of openBills) bucketTotals[b.bucket] = (bucketTotals[b.bucket] ?? 0) + (b.baseOpenMinor ?? 0);

  // The reconciliation, and it is only meaningful over the WHOLE workspace: a filtered list totals a
  // subset, and comparing a subset to the ledger would report a false mismatch on every filter. So the
  // unfiltered total is computed separately and `filtered` says which figure the mark is about, the
  // same shape A16 landed after its own finding.
  //
  // COMPUTED SEPARATELY ON THE UNFILTERED PATH TOO (A17-C4, D64): both sides of the difference are
  // bounded by the same `asOf`. `payablesBalanceAsOf` stops at the Stichtag, so the open total it is
  // compared against must stop there as well; reusing the displayed `baseTotalOpenMinor` (which
  // counts every date, because the LIST shows every bill) made one correctly posted bill dated next
  // month report `reconciled:false` with nothing wrong. A future-dated bill stays visible as a row
  // and in the header total, is invisible to today's reconciliation on both sides, and joins it the
  // day its date arrives.
  const filtered =
    filter.status !== undefined ||
    filter.settlementStatus !== undefined ||
    filter.vendorId !== undefined ||
    filter.from !== undefined ||
    filter.to !== undefined;
  const workspaceOpen = workspaceBaseOpenMinor(ctx, asOf);
  const onAccountMinor = supplierOnAccountMinor(ctx, asOf);
  const payablesBalanceMinor = payablesBalanceAsOf(ctx, asOf);
  const differenceMinor = workspaceOpen - onAccountMinor - payablesBalanceMinor;

  return ok({
    asOf,
    bills,
    truncated,
    total: bills.length,
    ceiling: VENDOR_BILL_LIST_CEILING,
    baseCurrency,
    boundariesDays: [...boundaries],
    bucketKeys: keys,
    bucketTotals,
    baseTotalOpenMinor,
    workspaceBaseTotalOpenMinor: workspaceOpen,
    onAccountMinor,
    payablesBalanceMinor,
    reconciled: differenceMinor === 0,
    reconciliationDifferenceMinor: differenceMinor,
    filtered,
  });
}

/**
 * Every bill's base open amount in the workspace AS OF the Stichtag: the reconciliation's own,
 * unfiltered total, derived from EVENTS rather than from the row's current status.
 *
 * The ledger side (`payablesBalanceAsOf`) is a sum of entries dated up to `asOf`, so this side must
 * be the sum of the SAME events (A17-C4 and A17-R3, D64). Three reach 2000, and each is admitted by
 * its own date:
 *
 *   + the posting        (the bill's entry, dated `bill_date`)   -> + base payable
 *   - the settlements    (payments, each on its own date)        -> - the settled base share
 *   - the reversal       (the void's entry, on the VOID's date)  -> - base payable
 *
 * Reading `status` instead of the reversal's date was A17-R3: a bill left this total the instant it
 * flipped to `void` while its reversing entry reached the bounded balance only on its own date, so
 * an ordinary correction (post a bill dated next month, notice, void it today) fabricated a
 * mismatch in both directions. The event sum makes each side a statement about the same window: a
 * void dated after `asOf` leaves the bill open TODAY, and a today-dated void of a future bill
 * contributes the reversal alone (a negative open, matching the debit the ledger already holds).
 */
function workspaceBaseOpenMinor(ctx: WorkspaceContext, asOf: string): number {
  // G21: a migrated bill has `entry_id` NULL (it posts nothing), so the `entry_id IS NOT NULL`
  // filter would exclude it and `ap_control` would report the whole migrated position as a
  // reconciliation gap forever. Migrated bills join this sum through `origin = 'migrated'`; their
  // membership is decided by `bill_date` and `status` (a migrated bill is voided by status, never by
  // a reversal, so it carries no `reversal_entry_id`), the way A04's opening 2000 line and the
  // migrated detail were always meant to tie out.
  const rows = ctx.store.db
    .prepare(
      `SELECT vb.*, re.date AS reversal_date
         FROM vendor_bill vb
         LEFT JOIN journal_entry re ON re.id = vb.reversal_entry_id AND re.workspace_id = vb.workspace_id
        WHERE vb.workspace_id = ? AND (vb.entry_id IS NOT NULL OR vb.origin = 'migrated')`,
    )
    .all(ctx.workspaceId) as (VendorBillRow & { reversal_date: string | null })[];
  let total = 0;
  for (const row of rows) {
    const basePayable = row.base_payable_minor;
    if (basePayable === null || row.payable_minor === 0) continue;
    // A migrated bill that was cancelled (voided) posts nothing and carries no reversal, so it simply
    // stops being open the moment its status is 'void'. A native voided bill nets to zero through the
    // reversal-date arithmetic below instead.
    if (row.origin === 'migrated' && row.status === 'void') continue;
    let open = 0;
    if (row.bill_date <= asOf) {
      const paidMinor = settledOnVendorBill(ctx, row.id, asOf);
      // The same proportional rule `mapBill` applies: the settled share comes off the BOOKED base.
      open += basePayable - Math.round((basePayable * paidMinor) / row.payable_minor);
    }
    if (row.reversal_date !== null && row.reversal_date <= asOf) {
      open -= basePayable;
    }
    total += open;
  }
  return total;
}

/** One bill in full, with the payments that settled it. */
export function getVendorBill(ctx: WorkspaceContext, input: { vendorBillId: string }): Result {
  const guard = requireString(input.vendorBillId, 'vendorBillId');
  if (guard) return guard;
  const row = readVendorBillRow(ctx, input.vendorBillId);
  if (row === undefined) return err('not_found', { vendorBillId: input.vendorBillId });
  const asOf = ctx.clock.now().slice(0, 10);
  const boundaries = agingBoundariesOf(ctx);
  const bill = mapBill(ctx, row, asOf, boundaries, bucketKeys(boundaries));

  const payments = ctx.store.db
    .prepare(
      `SELECT p.id, p.date, p.direction, p.status, p.currency, a.amount_minor, a.payment_amount_minor
         FROM payment_allocation a
         JOIN payment p ON p.id = a.payment_id AND p.workspace_id = ?
        WHERE a.workspace_id = ? AND a.target_kind = 'vendor_bill' AND a.target_id = ?
        ORDER BY p.date, p.rowid`,
    )
    .all(ctx.workspaceId, ctx.workspaceId, row.id) as {
    id: string;
    date: string;
    direction: string;
    status: string;
    currency: string;
    amount_minor: number;
    payment_amount_minor: number;
  }[];

  return ok({
    vendorBill: bill,
    payments: payments.map((p) => ({
      id: p.id,
      date: p.date,
      direction: p.direction,
      status: p.status,
      currency: p.currency,
      amountMinor: p.amount_minor,
      paymentAmountMinor: p.payment_amount_minor,
    })),
  });
}
