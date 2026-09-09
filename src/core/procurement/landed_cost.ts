/**
 * I03, LANDED COST ALLOCATION (Wave 14, cluster I, MONEY PATH): the first-class voucher that collects
 * freight, duty, insurance and handling and capitalises them onto the inventory that incurred them, so
 * OR 960's acquisition-cost figure is complete and the composition of an item's unit cost is provable
 * from primary documents.
 *
 * WHAT THIS FILE MAY AND MAY NOT DO (the I02 / A01 precedent):
 *  - It NEVER writes `stock_movement` itself. Every cost change goes through J02's `inventoryMove` with
 *    the new value-only `landed_cost` type (qty 0, a signed `cost_amount_minor`, a `ref_movement_id`
 *    naming the receipt movement it adjusts). On-hand SUM(qty) is therefore UNCHANGED by a confirm.
 *  - It NEVER posts a journal except through A02 `postEntry`. Confirm posts ONE balanced entry
 *    (Dr inventory control, Cr landed-cost clearing / accrued costs); reverse posts its exact mirror
 *    via `source='reversal'`. No other GL path exists here (P3, §H-LEDGER).
 *
 * THE MONEY-PATH INVARIANTS THIS FILE HOLDS (asserted in `test/procurement/landed-cost.test.mjs`):
 *  (a) IDEMPOTENT ON ROWS. `allocate_confirm` and `reverse` ride `runTx`, so a replay under the same
 *      key returns the stored result and writes NOTHING: no second movement, no second journal.
 *      Independently of the key, the voucher's status machine refuses a second confirm
 *      (`invalid_transition`), so a caller who forgets the key still cannot double-post.
 *  (b) APPEND-ONLY where it counts. The confirm's movements and journal are immutable by their own J02
 *      / A02 triggers. A correction is a REVERSE (compensating negative-cost movements + a reversing
 *      journal), never an edit; the original voucher, movements and journal stay permanently linked.
 *  (c) THE SEAM WORKS END TO END. The sum of the per-target `landed_cost` movement amounts equals the
 *      voucher total, equals the balanced A02 entry, and equals the rise J03 reports in the affected
 *      items' valuation. Confirm reads the entry back and refuses (`posting_verification_failed`) if
 *      it is not the balanced entry it asked for, the A01 acquisition precedent.
 *  (d) §H-PERIOD against the voucher's effective date. Confirm and reverse assert that period is open
 *      before any write, so a sealed year cannot be back-charged.
 *  (e) §H-TENANT on every read and write, including the receipt lines, the movements and the accounts.
 *  (f) ATOMICITY. `runTx` COMMITS-ON-OK: a rejection anywhere (including one J02 or A02 returns several
 *      lines in) THROWS and rolls the whole confirm back. A partially posted allocation is impossible.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { runTx } from '../purchase/poShared.js';
import { inventoryMove } from '../inventory/movement.js';
import { itemBookValueMinor } from '../inventory/valuationPolicy.js';
import { postEntry } from '../ledger/postEntry.js';
import { getEntry } from '../ledger/reads.js';
import { allocate, isAllocationMethod, isComponentType } from './landedCostAllocator.js';
import type { AllocationMethod, AllocatorTarget, AllocationPreview } from './landedCostAllocator.js';

const WRITE_CAP = 'procurement.landed_cost';
const READ_CAP = 'read_master_data';
const SOURCE_DOC_TYPE = 'landed_cost_voucher';

// --- rows and wire shapes ----------------------------------------------------------------------

interface VoucherRow {
  id: string;
  workspace_id: string;
  number: string;
  status: string;
  is_estimated: number;
  currency: string;
  fx_rate: string | null;
  total_cost_minor: number;
  allocation_method: string;
  source_bill_ids: string | null;
  inventory_account_id: string;
  clearing_account_id: string;
  variance_account_id: string | null;
  variance_policy: string | null;
  capitalized_minor: number | null;
  variance_minor: number | null;
  effective_date: string;
  journal_entry_id: string | null;
  reverse_journal_entry_id: string | null;
  notes: string | null;
  created_at: string;
  created_by: string | null;
  allocated_at: string | null;
  allocated_by: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
  reverse_reason: string | null;
  idempotency_key: string | null;
}

interface LineRow {
  id: string;
  voucher_id: string;
  component_type: string;
  description: string | null;
  amount_minor: number;
  amount_base_minor: number;
  vendor_id: string | null;
  tax_code_id: string | null;
}

interface TargetRow {
  id: string;
  voucher_id: string;
  goods_receipt_line_id: string;
  item_id: string;
  original_movement_id: string;
  location_id: string;
  base_qty: number;
  base_value_minor: number;
  weight_milli: number | null;
  volume_milli: number | null;
  allocated_minor: number;
  unit_impact_minor: number;
  movement_id: string | null;
  reversal_movement_id: string | null;
}

const VOUCHER_COLUMNS = `id, workspace_id, number, status, is_estimated, currency, fx_rate,
  total_cost_minor, allocation_method, source_bill_ids, inventory_account_id, clearing_account_id,
  variance_account_id, variance_policy, capitalized_minor, variance_minor,
  effective_date, journal_entry_id, reverse_journal_entry_id, notes, created_at, created_by,
  allocated_at, allocated_by, reversed_at, reversed_by, reverse_reason, idempotency_key`;

// I03 variance policy (§2 US-I03.6 §H-ENUM), validated at the verb boundary. `expense_excess` (the
// default) writes the non-capitalizable share to the variance account; `strict` refuses a confirm that
// would leave a remainder, forcing the operator to allocate before any stock is issued. The spec also
// names `absorb_remaining`, which is NOT offered here: making the remaining units carry the issued
// units' share would require J03 to fold a cost it deliberately scales by remaining/original, a
// money-path change outside this capability (see the reconcile note). It is refused at create, never
// silently mistreated as one of the two that are honoured.
const VARIANCE_POLICIES: ReadonlySet<string> = new Set(['expense_excess', 'strict']);
const DEFAULT_VARIANCE_POLICY = 'expense_excess';

function readVoucher(ctx: WorkspaceContext, id: string): VoucherRow | undefined {
  return ctx.store.db
    .prepare(`SELECT ${VOUCHER_COLUMNS} FROM landed_cost_voucher WHERE workspace_id = ? AND id = ?`)
    .get(ctx.workspaceId, id) as VoucherRow | undefined;
}

function readLines(ctx: WorkspaceContext, voucherId: string): LineRow[] {
  return ctx.store.db
    .prepare(
      `SELECT id, voucher_id, component_type, description, amount_minor, amount_base_minor, vendor_id,
              tax_code_id FROM landed_cost_line WHERE workspace_id = ? AND voucher_id = ? ORDER BY created_at, id`,
    )
    .all(ctx.workspaceId, voucherId) as LineRow[];
}

function readTargets(ctx: WorkspaceContext, voucherId: string): TargetRow[] {
  return ctx.store.db
    .prepare(
      `SELECT id, voucher_id, goods_receipt_line_id, item_id, original_movement_id, location_id,
              base_qty, base_value_minor, weight_milli, volume_milli, allocated_minor, unit_impact_minor,
              movement_id, reversal_movement_id
         FROM landed_cost_target WHERE workspace_id = ? AND voucher_id = ? ORDER BY created_at, id`,
    )
    .all(ctx.workspaceId, voucherId) as TargetRow[];
}

function mapVoucher(v: VoucherRow, lines: LineRow[], targets: TargetRow[]): Record<string, unknown> {
  return {
    id: v.id,
    number: v.number,
    status: v.status,
    isEstimated: v.is_estimated === 1,
    currency: v.currency,
    fxRate: v.fx_rate,
    totalCostMinor: v.total_cost_minor,
    allocationMethod: v.allocation_method,
    sourceBillIds: v.source_bill_ids === null ? [] : (JSON.parse(v.source_bill_ids) as string[]),
    inventoryAccountId: v.inventory_account_id,
    clearingAccountId: v.clearing_account_id,
    varianceAccountId: v.variance_account_id,
    variancePolicy: v.variance_policy ?? DEFAULT_VARIANCE_POLICY,
    capitalizedMinor: v.capitalized_minor,
    varianceMinor: v.variance_minor,
    effectiveDate: v.effective_date,
    journalEntryId: v.journal_entry_id,
    reverseJournalEntryId: v.reverse_journal_entry_id,
    notes: v.notes,
    createdAt: v.created_at,
    createdBy: v.created_by,
    allocatedAt: v.allocated_at,
    allocatedBy: v.allocated_by,
    reversedAt: v.reversed_at,
    reversedBy: v.reversed_by,
    reverseReason: v.reverse_reason,
    lines: lines.map((l) => ({
      id: l.id,
      componentType: l.component_type,
      description: l.description,
      amountMinor: l.amount_minor,
      amountBaseMinor: l.amount_base_minor,
      vendorId: l.vendor_id,
      taxCodeId: l.tax_code_id,
    })),
    targets: targets.map((t) => ({
      id: t.id,
      goodsReceiptLineId: t.goods_receipt_line_id,
      itemId: t.item_id,
      originalMovementId: t.original_movement_id,
      locationId: t.location_id,
      baseQty: t.base_qty,
      baseValueMinor: t.base_value_minor,
      weightMilli: t.weight_milli,
      volumeMilli: t.volume_milli,
      allocatedMinor: t.allocated_minor,
      unitImpactMinor: t.unit_impact_minor,
      movementId: t.movement_id,
      reversalMovementId: t.reversal_movement_id,
    })),
  };
}

function voucherPayload(ctx: WorkspaceContext, id: string): Record<string, unknown> {
  const v = readVoucher(ctx, id) as VoucherRow;
  return { voucher: mapVoucher(v, readLines(ctx, id), readTargets(ctx, id)) };
}

// --- helpers -----------------------------------------------------------------------------------

function nextNumber(ctx: WorkspaceContext): string {
  const year = ctx.clock.now().slice(0, 4);
  const prefix = `LC-${year}-`;
  const row = ctx.store.db
    .prepare('SELECT number FROM landed_cost_voucher WHERE workspace_id = ? AND number LIKE ? ORDER BY number DESC LIMIT 1')
    .get(ctx.workspaceId, `${prefix}%`) as { number: string } | undefined;
  const last = row === undefined ? 0 : Number.parseInt(row.number.slice(prefix.length), 10);
  return `${prefix}${String(last + 1).padStart(4, '0')}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function accountExists(ctx: WorkspaceContext, accountId: string): boolean {
  return (
    ctx.store.db
      .prepare('SELECT id FROM account WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, accountId) !== undefined
  );
}

/**
 * Convert a cost-line amount into workspace base currency. A base-currency voucher (no rate) is the
 * amount itself, verbatim. A foreign voucher multiplies by the FROZEN rate on the voucher, once, so a
 * later rate move never re-prices a filed cost (§H-FX). The rate is a decimal string parsed to an
 * exact fraction, so no float decides a Rappen.
 */
function toBaseMinor(amountMinor: number, fxRate: string | null): number | undefined {
  if (fxRate === null) return amountMinor;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(fxRate.trim());
  if (m === null) return undefined;
  const whole = m[1] as string;
  const frac = m[2] ?? '';
  const scale = 10n ** BigInt(frac.length);
  const rateScaled = BigInt(whole) * scale + (frac === '' ? 0n : BigInt(frac));
  // commercial rounding of amount x rate, half away from zero, exact bigint.
  const num = BigInt(amountMinor) * rateScaled;
  const rounded = (2n * (num < 0n ? -num : num) + scale) / (2n * scale);
  return Number(num < 0n ? -rounded : rounded);
}

// --- voucher_create ----------------------------------------------------------------------------

export interface VoucherCreateInput {
  costLines?: Array<{
    componentType?: string;
    description?: string;
    amountMinor?: number;
    vendorId?: string;
    taxCodeId?: string;
  }>;
  targetGrLineIds?: string[];
  inventoryAccountId?: string;
  clearingAccountId?: string;
  varianceAccountId?: string;
  variancePolicy?: string;
  allocationMethod?: string;
  isEstimated?: boolean;
  currency?: string;
  fxRate?: string;
  sourceBillIds?: string[];
  effectiveDate?: string;
  notes?: string;
  idempotencyKey?: string;
}

export function landedCostVoucherCreate(ctx: WorkspaceContext, input: VoucherCreateInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;

  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  // §H-IDEMPOTENT: replay a completed create BEFORE any state-dependent guard, so retrying the exact
  // same call returns the original voucher instead of `already_allocated` (the target it created on
  // the first call is now allocated to it). The postEntry / recordAssignment ordering precedent.
  const replay = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'landed_cost_voucher_create');
  if (replay !== undefined) return replay;
  if (!Array.isArray(input.costLines) || input.costLines.length === 0) {
    return err('invalid_input', { field: 'costLines' });
  }
  if (!Array.isArray(input.targetGrLineIds) || input.targetGrLineIds.length === 0) {
    return err('nothing_to_allocate', {});
  }
  if (typeof input.inventoryAccountId !== 'string' || !accountExists(ctx, input.inventoryAccountId)) {
    return err('invalid_reference', { field: 'inventoryAccountId' });
  }
  if (typeof input.clearingAccountId !== 'string' || !accountExists(ctx, input.clearingAccountId)) {
    return err('invalid_reference', { field: 'clearingAccountId' });
  }
  // §H-ENUM on the variance policy, and the variance account (if supplied) must exist. The account is
  // OPTIONAL at create: a voucher confirmed while the whole receipt is still on hand has no remainder
  // and needs none. It becomes REQUIRED at confirm only if a remainder actually arises.
  const variancePolicy = input.variancePolicy ?? DEFAULT_VARIANCE_POLICY;
  if (!VARIANCE_POLICIES.has(variancePolicy)) return err('invalid_input', { field: 'variancePolicy', value: input.variancePolicy });
  if (input.varianceAccountId !== undefined && (typeof input.varianceAccountId !== 'string' || !accountExists(ctx, input.varianceAccountId))) {
    return err('invalid_reference', { field: 'varianceAccountId' });
  }
  const varianceAccountId = input.varianceAccountId ?? null;
  const method = input.allocationMethod ?? 'by_value';
  if (!isAllocationMethod(method)) return err('invalid_input', { field: 'allocationMethod' });
  const currency = typeof input.currency === 'string' && input.currency.length > 0 ? input.currency : 'CHF';
  const fxRate = typeof input.fxRate === 'string' && input.fxRate.length > 0 ? input.fxRate : null;
  const effectiveDate = (input.effectiveDate ?? ctx.clock.now().slice(0, 10)).slice(0, 10);
  if (!DATE_RE.test(effectiveDate)) return err('invalid_input', { field: 'effectiveDate' });

  // Validate and total the cost components.
  const lines: Array<{ componentType: string; description: string | null; amountMinor: number; amountBaseMinor: number; vendorId: string | null; taxCodeId: string | null }> = [];
  let totalBase = 0;
  for (const raw of input.costLines) {
    if (!isComponentType(raw.componentType)) return err('invalid_input', { field: 'componentType' });
    if (typeof raw.amountMinor !== 'number' || !Number.isInteger(raw.amountMinor) || raw.amountMinor <= 0) {
      return err('invalid_amount', { field: 'amountMinor' });
    }
    if (raw.vendorId !== undefined) {
      const vendor = ctx.store.db
        .prepare('SELECT id FROM contact WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, raw.vendorId);
      if (vendor === undefined) return err('invalid_reference', { field: 'vendorId', vendorId: raw.vendorId });
    }
    const base = toBaseMinor(raw.amountMinor, fxRate);
    if (base === undefined) return err('invalid_input', { field: 'fxRate' });
    totalBase += base;
    lines.push({
      componentType: raw.componentType,
      description: typeof raw.description === 'string' ? raw.description : null,
      amountMinor: raw.amountMinor,
      amountBaseMinor: base,
      vendorId: raw.vendorId ?? null,
      taxCodeId: raw.taxCodeId ?? null,
    });
  }
  if (totalBase <= 0) return err('invalid_amount', { reason: 'zero_total' });

  // Resolve the targets: each grLine must be a RECOGNISED line (a J02 movement was minted) on a
  // posted, non-reversed receipt, and not already allocated under a live voucher.
  const targets: Array<{ grLineId: string; itemId: string; movementId: string; locationId: string; qty: number; valueMinor: number }> = [];
  for (const grLineId of input.targetGrLineIds) {
    if (typeof grLineId !== 'string' || grLineId.length === 0) return err('invalid_input', { field: 'targetGrLineIds' });
    const line = ctx.store.db
      .prepare(
        `SELECT l.id AS id, l.item_id AS item_id, l.qty AS qty, l.unit_cost_rappen AS unit_cost, l.location_id AS location_id,
                l.movement_id AS movement_id, d.status AS status
           FROM goods_receipt_doc_line l JOIN goods_receipt_doc d ON d.id = l.gr_id AND d.workspace_id = l.workspace_id
          WHERE l.workspace_id = ? AND l.id = ?`,
      )
      .get(ctx.workspaceId, grLineId) as
      | { id: string; item_id: string | null; qty: number; unit_cost: number; location_id: string | null; movement_id: string | null; status: string }
      | undefined;
    if (line === undefined) return err('invalid_reference', { goodsReceiptLineId: grLineId });
    if (line.status !== 'posted') return err('invalid_reference', { goodsReceiptLineId: grLineId, reason: 'receipt_not_posted' });
    if (line.movement_id === null || line.item_id === null || line.location_id === null) {
      return err('invalid_reference', { goodsReceiptLineId: grLineId, reason: 'line_not_recognised' });
    }
    const existing = ctx.store.db
      .prepare(
        `SELECT t.id FROM landed_cost_target t JOIN landed_cost_voucher v ON v.id = t.voucher_id AND v.workspace_id = t.workspace_id
          WHERE t.workspace_id = ? AND t.goods_receipt_line_id = ? AND v.status != 'reversed'`,
      )
      .get(ctx.workspaceId, grLineId);
    if (existing !== undefined) return err('already_allocated', { goodsReceiptLineId: grLineId });
    targets.push({
      grLineId,
      itemId: line.item_id,
      movementId: line.movement_id,
      locationId: line.location_id,
      qty: line.qty,
      valueMinor: line.qty * line.unit_cost,
    });
  }

  return runTx(ctx, 'landed_cost_voucher_create', input.idempotencyKey, () => {
    const voucherId = ctx.ids.next('lcv');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO landed_cost_voucher
           (id, workspace_id, number, status, is_estimated, currency, fx_rate, total_cost_minor,
            allocation_method, source_bill_ids, inventory_account_id, clearing_account_id,
            variance_account_id, variance_policy, effective_date,
            notes, created_at, created_by, idempotency_key)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        voucherId,
        ctx.workspaceId,
        nextNumber(ctx),
        input.isEstimated === true ? 1 : 0,
        currency,
        fxRate,
        totalBase,
        method,
        Array.isArray(input.sourceBillIds) && input.sourceBillIds.length > 0 ? JSON.stringify(input.sourceBillIds) : null,
        input.inventoryAccountId,
        input.clearingAccountId,
        varianceAccountId,
        variancePolicy,
        effectiveDate,
        typeof input.notes === 'string' ? input.notes : null,
        now,
        ctx.actor,
        input.idempotencyKey,
      );
    for (const l of lines) {
      ctx.store.db
        .prepare(
          `INSERT INTO landed_cost_line (id, workspace_id, voucher_id, component_type, description,
             amount_minor, amount_base_minor, vendor_id, tax_code_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ctx.ids.next('lcl'), ctx.workspaceId, voucherId, l.componentType, l.description, l.amountMinor, l.amountBaseMinor, l.vendorId, l.taxCodeId, now);
    }
    for (const t of targets) {
      ctx.store.db
        .prepare(
          `INSERT INTO landed_cost_target (id, workspace_id, voucher_id, goods_receipt_line_id, item_id,
             original_movement_id, location_id, base_qty, base_value_minor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ctx.ids.next('lct'), ctx.workspaceId, voucherId, t.grLineId, t.itemId, t.movementId, t.locationId, t.qty, t.valueMinor, now);
    }
    ctx.audit.record({ entityKind: SOURCE_DOC_TYPE, entityId: voucherId, action: 'create', actor: ctx.actor, at: now });
    return ok(voucherPayload(ctx, voucherId));
  });
}

// --- allocate_preview (pure) -------------------------------------------------------------------

function buildAllocatorTargets(targets: TargetRow[]): AllocatorTarget[] {
  return targets.map((t) => ({
    id: t.id,
    itemId: t.item_id,
    originalMovementId: t.original_movement_id,
    baseValueMinor: t.base_value_minor,
    baseQty: t.base_qty,
    weightMilli: t.weight_milli,
    volumeMilli: t.volume_milli,
  }));
}

function runAllocation(v: VoucherRow, targets: TargetRow[], method: AllocationMethod, manualShares: Record<string, number> | undefined): AllocationPreview | { error: string } {
  const input = manualShares === undefined
    ? { totalCostMinor: v.total_cost_minor, method }
    : { totalCostMinor: v.total_cost_minor, method, manualShares };
  return allocate(input, buildAllocatorTargets(targets));
}

export interface AllocatePreviewInput {
  voucherId?: string;
  method?: string;
  manualShares?: Record<string, number>;
}

export function landedCostAllocatePreview(ctx: WorkspaceContext, input: AllocatePreviewInput): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;
  if (typeof input.voucherId !== 'string' || input.voucherId.length === 0) return err('invalid_input', { field: 'voucherId' });
  const v = readVoucher(ctx, input.voucherId);
  if (v === undefined) return err('not_found', { voucherId: input.voucherId });

  const method = input.method ?? v.allocation_method;
  if (!isAllocationMethod(method)) return err('invalid_input', { field: 'method' });
  const targets = readTargets(ctx, v.id);
  const preview = runAllocation(v, targets, method, input.manualShares);
  if ('error' in preview) return err(preview.error, { voucherId: v.id, method });
  return ok({ voucherId: v.id, ...preview });
}

// --- allocate_confirm --------------------------------------------------------------------------

export interface AllocateConfirmInput {
  voucherId?: string;
  method?: string;
  manualShares?: Record<string, number>;
  effectiveDate?: string;
  idempotencyKey?: string;
}

export function landedCostAllocateConfirm(ctx: WorkspaceContext, input: AllocateConfirmInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;
  if (typeof input.voucherId !== 'string' || input.voucherId.length === 0) return err('invalid_input', { field: 'voucherId' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }

  return runTx(ctx, 'landed_cost_allocate_confirm', input.idempotencyKey, () => {
    const v = readVoucher(ctx, input.voucherId as string);
    if (v === undefined) return err('not_found', { voucherId: input.voucherId });
    if (v.status !== 'draft') return err('invalid_transition', { voucherId: v.id, status: v.status });

    const method = input.method ?? v.allocation_method;
    if (!isAllocationMethod(method)) return err('invalid_input', { field: 'method' });
    const effectiveDate = (input.effectiveDate ?? v.effective_date).slice(0, 10);
    if (!DATE_RE.test(effectiveDate)) return err('invalid_input', { field: 'effectiveDate' });
    // §H-PERIOD against the date the cost lands, before any write.
    const periodOpen = ctx.periods.assertOpen(effectiveDate);
    if (!periodOpen.ok) return periodOpen;

    const targets = readTargets(ctx, v.id);
    const preview = runAllocation(v, targets, method, input.manualShares);
    if ('error' in preview) return err(preview.error, { voucherId: v.id, method });
    if (preview.residualMinor !== 0) return err('allocation_residual', { residualMinor: preview.residualMinor });

    const targetById = new Map(targets.map((t) => [t.id, t]));
    // The distinct items this voucher touches, and their book value BEFORE any cost movement is
    // written, read through J03 (`itemBookValueMinor`). The confirm capitalises exactly the rise J03
    // reports for these items and expenses the rest, so the GL inventory move equals the sub-ledger
    // change by construction (OP11) instead of by a second, driftable calculation.
    const affectedItems = new Set<string>();
    for (const line of preview.lines) {
      if (line.allocatedMinor === 0) continue;
      affectedItems.add((targetById.get(line.targetId) as TargetRow).item_id);
    }
    const bookBefore = new Map<string, number>();
    for (const itemId of affectedItems) bookBefore.set(itemId, itemBookValueMinor(ctx, itemId));

    let posted = 0;
    // 1) Per target: a J02 landed_cost movement carrying its allocated cost, bound to the original
    // receipt movement so J03 folds it onto that exact layer.
    for (const line of preview.lines) {
      if (line.allocatedMinor === 0) continue;
      const t = targetById.get(line.targetId) as TargetRow;
      const moved = inventoryMove(ctx, {
        itemId: t.item_id,
        locationId: t.location_id,
        qty: 0,
        movementType: 'landed_cost',
        costAmountMinor: line.allocatedMinor,
        refMovementId: t.original_movement_id,
        effectiveDate,
        sourceDocumentType: SOURCE_DOC_TYPE,
        sourceDocumentId: v.id,
        description: `Landed cost ${v.number}`,
        idempotencyKey: `${v.id}:conf:${t.id}`,
      });
      if (!moved.ok) return moved;
      const movementId = (moved.movement as { id: string }).id;
      ctx.store.db
        .prepare(
          `UPDATE landed_cost_target SET allocated_minor = ?, unit_impact_minor = ?, movement_id = ?
             WHERE workspace_id = ? AND id = ?`,
        )
        .run(line.allocatedMinor, line.unitImpactMinor, movementId, ctx.workspaceId, t.id);
      posted += line.allocatedMinor;
    }
    if (posted !== v.total_cost_minor) return err('allocation_residual', { residualMinor: v.total_cost_minor - posted });

    // 2) THE SPLIT (the money-path correction). The CAPITALIZABLE share is exactly what J03 now
    // carries for these items: the on-hand fraction for weighted-average and FIFO (a partially issued
    // receipt keeps only remaining/original on the balance sheet), and ZERO for a standard-cost item
    // (its landed cost is purchase-price variance, never inventory). It is read back from the SAME J03
    // path, so `Dr inventory-control` can never exceed or fall short of the sub-ledger change. The
    // REMAINDER (already-issued units, and a standard-cost item's whole landed cost) is what J03 does
    // NOT carry: capitalising it would overstate the Bilanzwert (OR 960) and break OP11.
    let capitalized = 0;
    for (const itemId of affectedItems) {
      capitalized += itemBookValueMinor(ctx, itemId) - (bookBefore.get(itemId) as number);
    }
    // Adding a positive landed cost can only raise an item's value (weighted-average / FIFO) or leave
    // it flat (standard cost), and it can never raise it by more than was posted. The clamp is a guard
    // against a pathological rounding artefact; in every normal case `capitalized` is the exact J03
    // delta and neither bound bites, so GL and the sub-ledger stay equal to the Rappen.
    if (capitalized < 0) capitalized = 0;
    if (capitalized > posted) capitalized = posted;
    const variance = posted - capitalized;

    // The variance policy governs the remainder. `strict` refuses to leave one at all; `expense_excess`
    // routes it to the variance account, which must exist once a remainder is real.
    const variancePolicy = v.variance_policy ?? DEFAULT_VARIANCE_POLICY;
    if (variance > 0) {
      if (variancePolicy === 'strict') {
        return err('landed_cost_variance_not_permitted', { capitalizedMinor: capitalized, varianceMinor: variance });
      }
      if (v.variance_account_id === null) return err('variance_account_required', { varianceMinor: variance });
    }

    // 3) ONE balanced A02 entry: Dr inventory control (the capitalizable share), Dr variance/COGS (the
    // remainder), Cr landed-cost clearing / accrued costs (the whole posted total). Lines with a zero
    // amount are omitted so the entry the reversal must mirror has exactly the lines it needs and no
    // empty ones (a fully on-hand receipt has no variance line; a standard-cost item has no inventory
    // line).
    const journalLines: Array<{ account: string; debit?: number; credit?: number }> = [];
    if (capitalized > 0) journalLines.push({ account: v.inventory_account_id, debit: capitalized });
    if (variance > 0) journalLines.push({ account: v.variance_account_id as string, debit: variance });
    journalLines.push({ account: v.clearing_account_id, credit: posted });
    const journal = postEntry(ctx, {
      date: effectiveDate,
      source: 'landed_cost',
      description: `Landed cost ${v.number}`,
      idempotencyKey: `${v.id}:conf:journal`,
      lines: journalLines,
    });
    if (!journal.ok) return journal;
    const journalEntryId = journal.entryId;

    // 4) Trust nothing, including our own posting path: read the entry back and assert it is the
    // balanced split it asked for, on the accounts and amounts asked for (the A01 precedent). The
    // inventory debit MUST equal the capitalizable share (== the J03 rise), never the raw total.
    const check = getEntry(ctx, { entryId: journalEntryId });
    if (!check.ok) return check;
    const debit = check.lines.reduce((s, l) => s + l.debit, 0);
    const credit = check.lines.reduce((s, l) => s + l.credit, 0);
    const invOk = capitalized === 0 || check.lines.some((l) => l.account === v.inventory_account_id && l.debit === capitalized);
    const varOk = variance === 0 || check.lines.some((l) => l.account === v.variance_account_id && l.debit === variance);
    const clrOk = check.lines.some((l) => l.account === v.clearing_account_id && l.credit === posted);
    if (debit !== credit || debit !== posted || !invOk || !varOk || !clrOk) {
      return err('posting_verification_failed', { entryId: journalEntryId });
    }

    const now = ctx.clock.now();
    // Persist the exact split the confirm posted (and the policy it resolved), so the reverse mirrors
    // THIS entry rather than recomputing a figure that any issue between confirm and reverse would have
    // moved. A reversal must negate the original line for line, not re-derive it.
    ctx.store.db
      .prepare(
        `UPDATE landed_cost_voucher SET status = 'allocated', allocation_method = ?, journal_entry_id = ?,
           variance_policy = ?, capitalized_minor = ?, variance_minor = ?,
           effective_date = ?, allocated_at = ?, allocated_by = ? WHERE workspace_id = ? AND id = ?`,
      )
      .run(method, journalEntryId, variancePolicy, capitalized, variance, effectiveDate, now, ctx.actor, ctx.workspaceId, v.id);
    ctx.audit.record({ entityKind: SOURCE_DOC_TYPE, entityId: v.id, action: 'post', actor: ctx.actor, at: now });

    return ok({ ...voucherPayload(ctx, v.id), journalEntryId, allocation: preview });
  });
}

// --- reverse -----------------------------------------------------------------------------------

export interface ReverseInput {
  voucherId?: string;
  reason?: string;
  idempotencyKey?: string;
}

export function landedCostReverse(ctx: WorkspaceContext, input: ReverseInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;
  if (typeof input.voucherId !== 'string' || input.voucherId.length === 0) return err('invalid_input', { field: 'voucherId' });
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) return err('invalid_input', { field: 'reason' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const reason = input.reason.trim();

  return runTx(ctx, 'landed_cost_reverse', input.idempotencyKey, () => {
    const v = readVoucher(ctx, input.voucherId as string);
    if (v === undefined) return err('not_found', { voucherId: input.voucherId });
    if (v.status !== 'allocated') return err('invalid_transition', { voucherId: v.id, status: v.status });
    if (v.journal_entry_id === null) return err('invalid_transition', { voucherId: v.id, reason: 'no_journal' });

    const effectiveDate = v.effective_date;
    const periodOpen = ctx.periods.assertOpen(effectiveDate);
    if (!periodOpen.ok) return periodOpen;

    const targets = readTargets(ctx, v.id);
    let reversed = 0;
    // 1) A compensating landed_cost movement per target: same referenced receipt layer, NEGATED cost,
    // so J03 nets the layer's landed cost straight back to zero.
    for (const t of targets) {
      if (t.allocated_minor === 0 || t.movement_id === null) continue;
      const moved = inventoryMove(ctx, {
        itemId: t.item_id,
        locationId: t.location_id,
        qty: 0,
        movementType: 'landed_cost',
        costAmountMinor: -t.allocated_minor,
        refMovementId: t.original_movement_id,
        effectiveDate,
        sourceDocumentType: SOURCE_DOC_TYPE,
        sourceDocumentId: v.id,
        description: `Landed cost reversal ${v.number}`,
        idempotencyKey: `${v.id}:rev:${t.id}`,
      });
      if (!moved.ok) return moved;
      const movementId = (moved.movement as { id: string }).id;
      ctx.store.db
        .prepare('UPDATE landed_cost_target SET reversal_movement_id = ? WHERE workspace_id = ? AND id = ?')
        .run(movementId, ctx.workspaceId, t.id);
      reversed += t.allocated_minor;
    }

    // 2) The reversing A02 entry: the EXACT mirror of the confirm entry (source='reversal' enforces
    // the per-line negation), so the GL nets flat. It negates the SAME split the confirm posted, read
    // from the stored `capitalized_minor` / `variance_minor`: the confirm's `Dr inventory` becomes
    // `Cr inventory`, its `Dr variance` becomes `Cr variance`, and the whole total returns to clearing
    // on the debit. A line the confirm omitted (zero capitalizable, or zero variance) is omitted here
    // too, so the mirror matches line for line.
    const capitalized = v.capitalized_minor ?? reversed;
    const variance = v.variance_minor ?? 0;
    const reverseLines: Array<{ account: string; debit?: number; credit?: number }> = [];
    if (capitalized > 0) reverseLines.push({ account: v.inventory_account_id, credit: capitalized });
    if (variance > 0) reverseLines.push({ account: v.variance_account_id as string, credit: variance });
    reverseLines.push({ account: v.clearing_account_id, debit: capitalized + variance });
    const journal = postEntry(ctx, {
      date: effectiveDate,
      source: 'reversal',
      reversesEntryId: v.journal_entry_id,
      description: `Landed cost reversal ${v.number}: ${reason}`,
      idempotencyKey: `${v.id}:rev:journal`,
      lines: reverseLines,
    });
    if (!journal.ok) return journal;

    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `UPDATE landed_cost_voucher SET status = 'reversed', reverse_journal_entry_id = ?, reversed_at = ?,
           reversed_by = ?, reverse_reason = ? WHERE workspace_id = ? AND id = ?`,
      )
      .run(journal.entryId, now, ctx.actor, reason, ctx.workspaceId, v.id);
    ctx.audit.record({ entityKind: SOURCE_DOC_TYPE, entityId: v.id, action: 'reverse', actor: ctx.actor, at: now });

    return ok({ ...voucherPayload(ctx, v.id), reverseJournalEntryId: journal.entryId });
  });
}

// --- list + get --------------------------------------------------------------------------------

export interface ListInput {
  status?: string | string[];
  itemId?: string;
  fromDate?: string;
  toDate?: string;
}

export function landedCostList(ctx: WorkspaceContext, input: ListInput = {}): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;

  const clauses = ['v.workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  const statusRaw = input.status;
  const statuses = Array.isArray(statusRaw) ? statusRaw : typeof statusRaw === 'string' && statusRaw.length > 0 ? [statusRaw] : [];
  const validStatuses = statuses.filter((s) => s === 'draft' || s === 'allocated' || s === 'reversed');
  if (validStatuses.length > 0) {
    clauses.push(`v.status IN (${validStatuses.map(() => '?').join(', ')})`);
    params.push(...validStatuses);
  }
  if (typeof input.fromDate === 'string' && input.fromDate.length > 0) {
    clauses.push('v.effective_date >= ?');
    params.push(input.fromDate.slice(0, 10));
  }
  if (typeof input.toDate === 'string' && input.toDate.length > 0) {
    clauses.push('v.effective_date <= ?');
    params.push(input.toDate.slice(0, 10));
  }
  let join = '';
  if (typeof input.itemId === 'string' && input.itemId.length > 0) {
    join = 'JOIN landed_cost_target t ON t.voucher_id = v.id AND t.workspace_id = v.workspace_id';
    clauses.push('t.item_id = ?');
    params.push(input.itemId);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT DISTINCT ${VOUCHER_COLUMNS.split(',').map((c) => `v.${c.trim()}`).join(', ')}
         FROM landed_cost_voucher v ${join} WHERE ${clauses.join(' AND ')}
        ORDER BY v.effective_date DESC, v.number DESC`,
    )
    .all(...params) as VoucherRow[];

  return ok({
    items: rows.map((v) => ({
      id: v.id,
      number: v.number,
      status: v.status,
      isEstimated: v.is_estimated === 1,
      currency: v.currency,
      totalCostMinor: v.total_cost_minor,
      allocationMethod: v.allocation_method,
      effectiveDate: v.effective_date,
      journalEntryId: v.journal_entry_id,
    })),
    total: rows.length,
  });
}

export function landedCostGet(ctx: WorkspaceContext, input: { voucherId?: string }): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;
  if (typeof input.voucherId !== 'string' || input.voucherId.length === 0) return err('invalid_input', { field: 'voucherId' });
  const v = readVoucher(ctx, input.voucherId);
  if (v === undefined) return err('not_found', { voucherId: input.voucherId });
  return ok(voucherPayload(ctx, v.id));
}
