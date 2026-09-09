/**
 * I04, the THREE-WAY MATCH engine (Wave 14, cluster I). A first-class, pure, auditable elevation of
 * D02's minimal `matchBill` (`../purchase/threeWayMatch.ts`), implementing OP15.
 *
 * THE MONEY-PATH SEAM, decided before the code (spec §0 reconciliation + §4):
 *  - I04 gates PAYMENT but posts NOTHING. It writes NO journal_entry and NO stock_movement. Its only
 *    cross-document writes are `po_line.billed_qty` (the authoritative billed counter) and the I02
 *    `goods_receipt_doc_line.billed_qty` marking. Financial posting stays A17 -> A02 (asserted by
 *    absence in the tests).
 *  - IDEMPOTENT ON ROWS (§H-IDEMPOTENT). create / override run through `runTx` under `idempotencyKey`,
 *    so a replay returns the stored match and writes no second header/line and increments
 *    `billed_qty` exactly once.
 *  - APPEND-ONLY (§H-AUDIT). The header and lines are immutable (schema triggers). An overridden match
 *    is PERMANENT; a correction is a NEW `reversed` record, never an edit back to a clean match.
 *  - REVERSE restores `po_line.billed_qty` to the exact pre-match value and un-marks the receipt lines,
 *    and does not double-adjust (it decrements exactly the quantities the original recorded).
 *  - §H-TENANT on every read and write.
 *
 * The BILL contributes ONE base-net figure: an A17 vendor_bill has no line table (see `poShared.ts`),
 * so a match line is one row per PO line and the price/value leg is checked at the bill aggregate.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import {
  runTx,
  readPo,
  readPoLines,
  readBillRow,
  billBaseNetRappen,
} from '../purchase/poShared.js';
import type { PoLineRow } from '../purchase/poShared.js';

const READ_CAP = 'read_master_data';
const MATCH_CAP = 'purchasing.match';
const OVERRIDE_CAP = 'purchasing.match_override';

/** I04's active statuses: a match that blocks a bill from being freely re-matched. */
export type MatchStatus = 'matched' | 'partial' | 'overridden' | 'reversed';

/** The workspace match tolerances. Spec defaults (§4); a per-workspace setter is a named follow-up. */
export interface MatchTolerance {
  quantityPct: number;
  quantityAbs: number;
  pricePct: number;
  priceAbsRappen: number;
  valueAbsRappen: number;
  allowPartial: boolean;
  requireReceiptForStock: boolean;
}

export const DEFAULT_TOLERANCE: MatchTolerance = Object.freeze({
  quantityPct: 2.0,
  quantityAbs: 0,
  pricePct: 2.0,
  priceAbsRappen: 50,
  valueAbsRappen: 1000,
  allowPartial: true,
  requireReceiptForStock: true,
});

export type EvaluationStatus = 'matched' | 'partial' | 'variance' | 'nothing_received' | 'no_candidate_po';
export type LineStatus = 'matched' | 'variance' | 'partial';

export interface EvaluationLine {
  poLineId: string;
  itemId: string | null;
  description: string | null;
  orderedQty: number;
  receivedQty: number;
  alreadyBilledQty: number;
  openForBillingQty: number;
  billedNowQty: number;
  unitPricePoRappen: number;
  extendedPoRappen: number;
  qtyVariance: number;
  qtyVariancePct: number;
  receiptLineIds: string[];
  lineStatus: LineStatus;
}

export interface MatchEvaluation {
  billId: string;
  poId: string | null;
  supplierId: string;
  status: EvaluationStatus;
  billConvertible: boolean;
  lines: EvaluationLine[];
  totalExpectedRappen: number;
  totalBilledRappen: number;
  totalQty: number;
  priceVarianceRappen: number;
  priceVariancePct: number;
  valueVarianceRappen: number;
  tolerance: MatchTolerance;
}

export interface MatchThreeWayEvaluateInput {
  billId?: string;
  poId?: string;
  receiptIds?: string[];
  asOf?: string;
}

export interface MatchThreeWayCreateInput {
  billId?: string;
  poId?: string; // pin the candidate PO the evaluation was run against; else the supplier's oldest open PO
  evaluation?: unknown; // accepted for parity; the engine RE-COMPUTES and never trusts a client snapshot
  allowPartial?: boolean;
  idempotencyKey?: string;
}

export interface MatchThreeWayOverrideInput {
  billId?: string;
  poId?: string; // pin the candidate PO the evaluation was run against; else the supplier's oldest open PO
  evaluation?: unknown;
  reason?: string;
  idempotencyKey?: string;
}

export interface MatchThreeWayReverseInput {
  matchId?: string;
  reason?: string;
  idempotencyKey?: string;
}

interface ReceiptConsume {
  id: string;
  take: number;
}

// --- Candidate resolution ----------------------------------------------------------------------

interface PoRowLite {
  id: string;
  supplier_contact_id: string;
  status: string;
}

/**
 * The PO this bill is matched against: the explicit `poId` when given, else the supplier's oldest
 * sent/received PO that still has open (received-not-billed) quantity. Deterministic (created_at, id).
 */
function resolveCandidatePo(ctx: WorkspaceContext, billSupplier: string, explicitPoId: string | undefined): PoRowLite | undefined {
  if (typeof explicitPoId === 'string' && explicitPoId.length > 0) {
    const po = readPo(ctx, explicitPoId);
    if (po === undefined) return undefined;
    return { id: po.id, supplier_contact_id: po.supplier_contact_id, status: po.status };
  }
  return ctx.store.db
    .prepare(
      `SELECT p.id, p.supplier_contact_id, p.status
         FROM purchase_order p
        WHERE p.workspace_id = ? AND p.supplier_contact_id = ? AND p.status IN ('sent', 'received')
          AND EXISTS (SELECT 1 FROM po_line l WHERE l.workspace_id = p.workspace_id AND l.po_id = p.id AND l.received_qty > l.billed_qty)
        ORDER BY p.created_at, p.id
        LIMIT 1`,
    )
    .get(ctx.workspaceId, billSupplier) as PoRowLite | undefined;
}

/** The I02 receipt lines a match may bill for one PO line, oldest first (spec §3, best-effort provenance). */
function openReceiptLines(ctx: WorkspaceContext, poLineId: string): { id: string; openQty: number }[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT l.id AS id, (l.qty - l.billed_qty) AS open_qty
         FROM goods_receipt_doc_line l
         JOIN goods_receipt_doc d ON d.id = l.gr_id AND d.workspace_id = l.workspace_id
        WHERE l.workspace_id = ? AND d.status = 'posted'
          AND l.recognised_at IS NOT NULL AND l.reversal_trail_line_id IS NULL
          AND l.billed_qty < l.qty AND l.po_line_id = ?
        ORDER BY d.received_at, d.number, l.line_no, l.id`,
    )
    .all(ctx.workspaceId, poLineId) as { id: string; open_qty: number }[];
  return rows.map((r) => ({ id: r.id, openQty: r.open_qty }));
}

/** Consume `qty` across a PO line's open receipt lines, FIFO. Returns the (id, take) pairs to mark. */
function planReceiptConsumption(ctx: WorkspaceContext, poLineId: string, qty: number): ReceiptConsume[] {
  const plan: ReceiptConsume[] = [];
  let remaining = qty;
  for (const rl of openReceiptLines(ctx, poLineId)) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, rl.openQty);
    if (take > 0) {
      plan.push({ id: rl.id, take });
      remaining -= take;
    }
  }
  return plan;
}

// --- The pure evaluation -----------------------------------------------------------------------

function insideTolerance(variance: number, base: number, absTol: number, pctTol: number): boolean {
  if (Math.abs(variance) <= absTol) return true;
  if (base > 0 && (Math.abs(variance) / base) * 100 <= pctTol) return true;
  return false;
}

function evaluateLine(ctx: WorkspaceContext, line: PoLineRow, tol: MatchTolerance): EvaluationLine {
  const orderedQty = line.qty;
  const receivedQty = line.received_qty;
  const alreadyBilledQty = line.billed_qty;
  const openForBillingQty = Math.max(0, receivedQty - alreadyBilledQty);
  const billedNowQty = openForBillingQty;
  const unitPricePoRappen = line.unit_price_base_rappen;
  const extendedPoRappen = billedNowQty * unitPricePoRappen;
  const qtyVariance = receivedQty - orderedQty;
  const qtyVariancePct = orderedQty > 0 ? (Math.abs(qtyVariance) / orderedQty) * 100 : 0;
  const overReceipt = Math.max(0, receivedQty - orderedQty);
  const overInside = overReceipt === 0 || insideTolerance(overReceipt, orderedQty, tol.quantityAbs, tol.quantityPct);

  let lineStatus: LineStatus;
  if (receivedQty === 0) lineStatus = 'variance';
  else if (receivedQty < orderedQty) lineStatus = 'partial';
  else if (!overInside) lineStatus = 'variance';
  else lineStatus = 'matched';

  const receiptLineIds = billedNowQty > 0 ? planReceiptConsumption(ctx, line.id, billedNowQty).map((p) => p.id) : [];

  return {
    poLineId: line.id,
    itemId: line.item_id,
    description: line.description,
    orderedQty,
    receivedQty,
    alreadyBilledQty,
    openForBillingQty,
    billedNowQty,
    unitPricePoRappen,
    extendedPoRappen,
    qtyVariance,
    qtyVariancePct,
    receiptLineIds,
    lineStatus,
  };
}

/** The pure calculator: reads only, never writes. Deterministic integer arithmetic. */
export function computeEvaluation(ctx: WorkspaceContext, billId: string, poIdInput: string | undefined, tol: MatchTolerance): MatchEvaluation | 'bill_not_found' {
  const bill = readBillRow(ctx, billId);
  if (bill === undefined) return 'bill_not_found';

  const candidate = resolveCandidatePo(ctx, bill.contact_id, poIdInput);
  const base: Omit<MatchEvaluation, 'status' | 'lines' | 'totalExpectedRappen' | 'totalBilledRappen' | 'totalQty' | 'priceVarianceRappen' | 'priceVariancePct' | 'valueVarianceRappen'> = {
    billId: bill.id,
    poId: candidate?.id ?? null,
    supplierId: bill.contact_id,
    billConvertible: billBaseNetRappen(bill) !== null,
    tolerance: tol,
  };

  if (candidate === undefined || candidate.supplier_contact_id !== bill.contact_id || !(candidate.status === 'sent' || candidate.status === 'received')) {
    return { ...base, poId: candidate?.id ?? null, status: 'no_candidate_po', lines: [], totalExpectedRappen: 0, totalBilledRappen: 0, totalQty: 0, priceVarianceRappen: 0, priceVariancePct: 0, valueVarianceRappen: 0 };
  }

  const lines = readPoLines(ctx, candidate.id).map((l) => evaluateLine(ctx, l, tol));
  const totalExpectedRappen = lines.reduce((s, l) => s + l.extendedPoRappen, 0);
  const totalQty = lines.reduce((s, l) => s + l.billedNowQty, 0);
  const openTotal = lines.reduce((s, l) => s + l.openForBillingQty, 0);
  const billBase = billBaseNetRappen(bill);
  const totalBilledRappen = billBase ?? 0;
  const valueVarianceRappen = billBase === null ? 0 : billBase - totalExpectedRappen;
  const priceVariancePct = totalExpectedRappen > 0 ? (Math.abs(valueVarianceRappen) / totalExpectedRappen) * 100 : 0;

  let status: EvaluationStatus;
  if (openTotal === 0) {
    status = 'nothing_received';
  } else if (billBase === null) {
    status = 'variance';
  } else {
    const valueInside =
      insideTolerance(valueVarianceRappen, totalExpectedRappen, tol.valueAbsRappen, tol.pricePct) ||
      Math.abs(valueVarianceRappen) <= tol.priceAbsRappen;
    if (!valueInside) {
      status = 'variance';
    } else {
      const fullyDelivered = lines.every((l) => l.receivedQty >= l.orderedQty);
      status = fullyDelivered ? 'matched' : tol.allowPartial ? 'partial' : 'variance';
    }
  }

  return {
    ...base,
    status,
    lines,
    totalExpectedRappen,
    totalBilledRappen,
    totalQty,
    priceVarianceRappen: valueVarianceRappen,
    priceVariancePct,
    valueVarianceRappen,
  };
}

// --- Verb 1: evaluate (pure, read) -------------------------------------------------------------

export function matchThreeWayEvaluate(ctx: WorkspaceContext, input: MatchThreeWayEvaluateInput): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;
  if (typeof input.billId !== 'string' || input.billId.length === 0) return err('invalid_input', { field: 'billId' });

  const evaluation = computeEvaluation(ctx, input.billId, input.poId, DEFAULT_TOLERANCE);
  if (evaluation === 'bill_not_found') return err('not_found', { billId: input.billId });
  return ok({ evaluation });
}

// --- Persistence helpers -----------------------------------------------------------------------

interface ActiveMatchRow {
  id: string;
  status: string;
}

function activeMatchForBill(ctx: WorkspaceContext, billId: string): ActiveMatchRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT id, status FROM three_way_match
        WHERE workspace_id = ? AND bill_id = ? AND status IN ('matched','partial','overridden') AND reversing_match_id IS NULL
        LIMIT 1`,
    )
    .get(ctx.workspaceId, billId) as ActiveMatchRow | undefined;
}

function insertMatchHeader(
  ctx: WorkspaceContext,
  row: {
    id: string;
    billId: string;
    poId: string;
    status: MatchStatus;
    evaluation: MatchEvaluation;
    reason: string | null;
    overriddenBy: string | null;
    overriddenAt: string | null;
    originalMatchId: string | null;
    idempotencyKey: string | undefined;
  },
): void {
  const now = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO three_way_match
         (id, workspace_id, bill_id, po_id, status, evaluation_snapshot, total_billed_rappen, total_expected_rappen,
          total_qty, price_variance_rappen, value_variance_rappen, reason, overridden_by, overridden_at,
          reversed_by, reversed_at, reversing_match_id, original_match_id, idempotency_key, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      ctx.workspaceId,
      row.billId,
      row.poId,
      row.status,
      JSON.stringify(row.evaluation),
      row.evaluation.totalBilledRappen,
      row.evaluation.totalExpectedRappen,
      row.evaluation.totalQty,
      row.evaluation.priceVarianceRappen,
      row.evaluation.valueVarianceRappen,
      row.reason,
      row.overriddenBy,
      row.overriddenAt,
      row.originalMatchId,
      row.idempotencyKey ?? null,
      ctx.actor,
      now,
      now,
    );
}

/** Insert the per-PO-line rows, increment po_line.billed_qty, and mark the I02 receipt lines. */
function writeMatchLinesAndConsume(ctx: WorkspaceContext, matchId: string, evaluation: MatchEvaluation): void {
  const now = ctx.clock.now();
  for (const line of evaluation.lines) {
    if (line.billedNowQty <= 0) continue;
    const plan = planReceiptConsumption(ctx, line.poLineId, line.billedNowQty);
    const consumedIds = plan.map((p) => p.id);
    ctx.store.db
      .prepare(
        `INSERT INTO three_way_match_line
           (id, workspace_id, match_id, po_line_id, item_id, description, ordered_qty, received_qty,
            already_billed_qty, billed_qty, unit_price_po_rappen, extended_po_rappen, qty_variance,
            receipt_line_ids, line_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.ids.next('twmatchln'),
        ctx.workspaceId,
        matchId,
        line.poLineId,
        line.itemId,
        line.description,
        line.orderedQty,
        line.receivedQty,
        line.alreadyBilledQty,
        line.billedNowQty,
        line.unitPricePoRappen,
        line.extendedPoRappen,
        line.qtyVariance,
        JSON.stringify(consumedIds),
        line.lineStatus,
        now,
      );
    // The authoritative billed counter (spec tripwire: SUM(match_line.billed_qty) == increase here).
    ctx.store.db
      .prepare('UPDATE po_line SET billed_qty = billed_qty + ? WHERE workspace_id = ? AND id = ?')
      .run(line.billedNowQty, ctx.workspaceId, line.poLineId);
    // Best-effort I02 receipt-line marking (no-op when receipts arrived via the D02 path).
    for (const c of plan) {
      ctx.store.db
        .prepare('UPDATE goods_receipt_doc_line SET billed_qty = billed_qty + ? WHERE workspace_id = ? AND id = ?')
        .run(c.take, ctx.workspaceId, c.id);
    }
  }
}

/** Shared create/override body. `mode` decides which statuses are acceptable and the capability set. */
function persistMatch(
  ctx: WorkspaceContext,
  mode: 'create' | 'override',
  billId: string | undefined,
  poIdInput: string | undefined,
  reason: string | undefined,
  allowPartialInput: boolean | undefined,
  idempotencyKey: string | undefined,
): Result {
  if (typeof billId !== 'string' || billId.length === 0) return err('invalid_input', { field: 'billId' });

  const bill = readBillRow(ctx, billId);
  if (bill === undefined) return err('not_found', { billId });

  // The at-most-one-active-match guard fires FIRST, before candidate resolution: a bill whose PO is
  // now fully billed (open qty 0) would otherwise report no_candidate_po and hide the real reason.
  const existing = activeMatchForBill(ctx, billId);
  if (existing !== undefined) return err('match_already_exists', { billId, matchId: existing.id });

  const tol: MatchTolerance =
    allowPartialInput === undefined ? DEFAULT_TOLERANCE : { ...DEFAULT_TOLERANCE, allowPartial: allowPartialInput };
  // Honour an explicit poId so create/override match against the SAME PO the evaluation was pinned to;
  // otherwise fall back to the supplier's oldest open PO (the auto-discovery the read verbs use).
  const pinnedPoId = typeof poIdInput === 'string' && poIdInput.length > 0 ? poIdInput : undefined;
  const evaluation = computeEvaluation(ctx, billId, pinnedPoId, tol);
  if (evaluation === 'bill_not_found') return err('not_found', { billId });

  if (evaluation.poId === null || evaluation.status === 'no_candidate_po') return err('no_candidate_po', { billId });
  if (!evaluation.billConvertible) return err('bill_not_convertible', { billId, reason: 'foreign_currency_unposted' });
  if (evaluation.status === 'nothing_received') return err('nothing_received', { billId, poId: evaluation.poId });

  if (mode === 'create') {
    const acceptable = evaluation.status === 'matched' || (evaluation.status === 'partial' && tol.allowPartial);
    if (!acceptable) return err('out_of_tolerance', { billId, poId: evaluation.poId, status: evaluation.status, priceVarianceRappen: evaluation.valueVarianceRappen });
  }

  const status: MatchStatus = mode === 'override' ? 'overridden' : evaluation.status === 'partial' ? 'partial' : 'matched';
  const poId = evaluation.poId;

  const run = (): Result => {
    const matchId = ctx.ids.next('twmatch');
    insertMatchHeader(ctx, {
      id: matchId,
      billId,
      poId,
      status,
      evaluation,
      reason: mode === 'override' ? (reason ?? null) : null,
      overriddenBy: mode === 'override' ? ctx.actor : null,
      overriddenAt: mode === 'override' ? ctx.clock.now() : null,
      originalMatchId: null,
      idempotencyKey,
    });
    writeMatchLinesAndConsume(ctx, matchId, evaluation);
    return ok({
      match: {
        id: matchId,
        billId,
        poId,
        status,
        totalBilledRappen: evaluation.totalBilledRappen,
        totalExpectedRappen: evaluation.totalExpectedRappen,
        totalQty: evaluation.totalQty,
        valueVarianceRappen: evaluation.valueVarianceRappen,
        ...(mode === 'override' ? { reason } : {}),
      },
    });
  };

  return runTx(ctx, mode === 'override' ? 'match_three_way_override' : 'match_three_way_create', idempotencyKey, run);
}

// --- Verb 2: create ----------------------------------------------------------------------------

export function matchThreeWayCreate(ctx: WorkspaceContext, input: MatchThreeWayCreateInput): Result {
  const capable = ctx.capabilities.assert(MATCH_CAP);
  if (!capable.ok) return capable;
  const key = input.idempotencyKey;
  if (typeof key === 'string' && key.length > 0) {
    const prior = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'match_three_way_create');
    if (prior !== undefined) return prior;
  }
  return persistMatch(ctx, 'create', input.billId, input.poId, undefined, input.allowPartial, input.idempotencyKey);
}

// --- Verb 3: override --------------------------------------------------------------------------

export function matchThreeWayOverride(ctx: WorkspaceContext, input: MatchThreeWayOverrideInput): Result {
  // Override is a stronger money-authority judgment: both the base match right AND the override right.
  const capable = ctx.capabilities.assert(MATCH_CAP);
  if (!capable.ok) return capable;
  const canOverride = ctx.capabilities.assert(OVERRIDE_CAP);
  if (!canOverride.ok) return canOverride;

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 5) return err('reason_required', { billId: input.billId });

  const key = input.idempotencyKey;
  if (typeof key === 'string' && key.length > 0) {
    const prior = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'match_three_way_override');
    if (prior !== undefined) return prior;
  }
  return persistMatch(ctx, 'override', input.billId, input.poId, reason, undefined, input.idempotencyKey);
}

// --- Verb 4: reverse ---------------------------------------------------------------------------

interface MatchHeaderRow {
  id: string;
  bill_id: string;
  po_id: string;
  status: string;
  evaluation_snapshot: string;
  total_billed_rappen: number;
  total_expected_rappen: number;
  total_qty: number;
  price_variance_rappen: number;
  value_variance_rappen: number;
  reversing_match_id: string | null;
}

function readMatchHeader(ctx: WorkspaceContext, matchId: unknown): MatchHeaderRow | undefined {
  if (typeof matchId !== 'string' || matchId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM three_way_match WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, matchId) as MatchHeaderRow | undefined;
}

interface MatchLineRow {
  id: string;
  po_line_id: string;
  billed_qty: number;
  receipt_line_ids: string;
}

export function matchThreeWayReverse(ctx: WorkspaceContext, input: MatchThreeWayReverseInput): Result {
  // Reversing a permanent record is a money-authority correction, gated like override.
  const capable = ctx.capabilities.assert(OVERRIDE_CAP);
  if (!capable.ok) return capable;

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 5) return err('reason_required', { matchId: input.matchId });

  const key = input.idempotencyKey;
  if (typeof key === 'string' && key.length > 0) {
    const prior = ctx.store.recallIdempotent<Result>(ctx.workspaceId, key, 'match_three_way_reverse');
    if (prior !== undefined) return prior;
  }

  const original = readMatchHeader(ctx, input.matchId);
  if (original === undefined) return err('not_found', { matchId: input.matchId });
  if (original.status !== 'matched' && original.status !== 'overridden' && original.status !== 'partial') {
    return err('match_not_reversible', { matchId: original.id, status: original.status });
  }
  if (original.reversing_match_id !== null) return err('match_not_reversible', { matchId: original.id, reason: 'already_reversed' });

  const run = (): Result => {
    const lines = ctx.store.db
      .prepare('SELECT id, po_line_id, billed_qty, receipt_line_ids FROM three_way_match_line WHERE workspace_id = ? AND match_id = ?')
      .all(ctx.workspaceId, original.id) as MatchLineRow[];

    // Restore the exact pre-match billed_qty and un-mark the receipt lines. MAX(0, ...) is defensive;
    // the amounts came straight from what this match recorded, so it never over-decrements.
    for (const l of lines) {
      ctx.store.db
        .prepare('UPDATE po_line SET billed_qty = MAX(0, billed_qty - ?) WHERE workspace_id = ? AND id = ?')
        .run(l.billed_qty, ctx.workspaceId, l.po_line_id);
      let receiptIds: string[] = [];
      try {
        const parsed = JSON.parse(l.receipt_line_ids) as unknown;
        if (Array.isArray(parsed)) receiptIds = parsed.filter((x): x is string => typeof x === 'string');
      } catch {
        receiptIds = [];
      }
      // The receipt lines this match consumed carried its billed_qty; restore them in the same FIFO
      // order by decrementing what remains marked. The recorded line billed_qty is the total consumed.
      let remaining = l.billed_qty;
      for (const rid of receiptIds) {
        if (remaining <= 0) break;
        const row = ctx.store.db
          .prepare('SELECT billed_qty FROM goods_receipt_doc_line WHERE workspace_id = ? AND id = ?')
          .get(ctx.workspaceId, rid) as { billed_qty: number } | undefined;
        if (row === undefined) continue;
        const back = Math.min(remaining, row.billed_qty);
        ctx.store.db
          .prepare('UPDATE goods_receipt_doc_line SET billed_qty = MAX(0, billed_qty - ?) WHERE workspace_id = ? AND id = ?')
          .run(back, ctx.workspaceId, rid);
        remaining -= back;
      }
    }

    const reversingId = ctx.ids.next('twmatch');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO three_way_match
           (id, workspace_id, bill_id, po_id, status, evaluation_snapshot, total_billed_rappen, total_expected_rappen,
            total_qty, price_variance_rappen, value_variance_rappen, reason, overridden_by, overridden_at,
            reversed_by, reversed_at, reversing_match_id, original_match_id, idempotency_key, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'reversed', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        reversingId,
        ctx.workspaceId,
        original.bill_id,
        original.po_id,
        original.evaluation_snapshot,
        -original.total_billed_rappen,
        -original.total_expected_rappen,
        -original.total_qty,
        -original.price_variance_rappen,
        -original.value_variance_rappen,
        reason,
        ctx.actor,
        now,
        original.id,
        key ?? null,
        ctx.actor,
        now,
        now,
      );

    // The ONE permitted mutation of the original: the NULL -> value reverse-link (the trigger allows it).
    ctx.store.db
      .prepare('UPDATE three_way_match SET reversing_match_id = ?, reversed_by = ?, reversed_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(reversingId, ctx.actor, now, now, ctx.workspaceId, original.id);

    return ok({
      original: { id: original.id, status: original.status, reversingMatchId: reversingId },
      reversing: { id: reversingId, originalMatchId: original.id, status: 'reversed', reason },
    });
  };

  return runTx(ctx, 'match_three_way_reverse', input.idempotencyKey, run);
}

// --- Verbs 5-8: reads --------------------------------------------------------------------------

function mapLineOut(l: MatchLineRow & { item_id: string | null; description: string | null; ordered_qty: number; received_qty: number; already_billed_qty: number; unit_price_po_rappen: number; extended_po_rappen: number; qty_variance: number; line_status: string }): Record<string, unknown> {
  let receiptLineIds: string[] = [];
  try {
    const parsed = JSON.parse(l.receipt_line_ids) as unknown;
    if (Array.isArray(parsed)) receiptLineIds = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    receiptLineIds = [];
  }
  return {
    id: l.id,
    poLineId: l.po_line_id,
    itemId: l.item_id,
    description: l.description,
    orderedQty: l.ordered_qty,
    receivedQty: l.received_qty,
    alreadyBilledQty: l.already_billed_qty,
    billedQty: l.billed_qty,
    unitPricePoRappen: l.unit_price_po_rappen,
    extendedPoRappen: l.extended_po_rappen,
    qtyVariance: l.qty_variance,
    receiptLineIds,
    lineStatus: l.line_status,
  };
}

function mapHeaderOut(h: Record<string, unknown>): Record<string, unknown> {
  return {
    id: h.id,
    billId: h.bill_id,
    poId: h.po_id,
    status: h.status,
    totalBilledRappen: h.total_billed_rappen,
    totalExpectedRappen: h.total_expected_rappen,
    totalQty: h.total_qty,
    priceVarianceRappen: h.price_variance_rappen,
    valueVarianceRappen: h.value_variance_rappen,
    reason: h.reason ?? null,
    overriddenBy: h.overridden_by ?? null,
    overriddenAt: h.overridden_at ?? null,
    reversedBy: h.reversed_by ?? null,
    reversedAt: h.reversed_at ?? null,
    reversingMatchId: h.reversing_match_id ?? null,
    originalMatchId: h.original_match_id ?? null,
    createdBy: h.created_by ?? null,
    createdAt: h.created_at,
  };
}

export interface MatchThreeWayGetInput {
  matchId?: string;
}

export function matchThreeWayGet(ctx: WorkspaceContext, input: MatchThreeWayGetInput): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;
  const header = readMatchHeader(ctx, input.matchId);
  if (header === undefined) return err('not_found', { matchId: input.matchId });
  const lines = ctx.store.db
    .prepare('SELECT * FROM three_way_match_line WHERE workspace_id = ? AND match_id = ? ORDER BY created_at, id')
    .all(ctx.workspaceId, header.id) as (MatchLineRow & Record<string, never>)[];
  let snapshot: unknown = null;
  try {
    snapshot = JSON.parse(header.evaluation_snapshot);
  } catch {
    snapshot = null;
  }
  return ok({
    match: mapHeaderOut(header as unknown as Record<string, unknown>),
    lines: lines.map((l) => mapLineOut(l as never)),
    evaluationSnapshot: snapshot,
  });
}

export interface MatchThreeWayListInput {
  billId?: string;
  poId?: string;
  status?: string | string[];
  from?: string;
  to?: string;
}

export function matchThreeWayList(ctx: WorkspaceContext, input: MatchThreeWayListInput): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;
  const clauses: string[] = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.billId === 'string' && input.billId.length > 0) {
    clauses.push('bill_id = ?');
    params.push(input.billId);
  }
  if (typeof input.poId === 'string' && input.poId.length > 0) {
    clauses.push('po_id = ?');
    params.push(input.poId);
  }
  const statuses = Array.isArray(input.status) ? input.status : typeof input.status === 'string' ? [input.status] : [];
  const validStatuses = statuses.filter((s) => typeof s === 'string' && s.length > 0);
  if (validStatuses.length > 0) {
    clauses.push(`status IN (${validStatuses.map(() => '?').join(', ')})`);
    params.push(...validStatuses);
  }
  if (typeof input.from === 'string' && input.from.length > 0) {
    clauses.push('created_at >= ?');
    params.push(input.from);
  }
  if (typeof input.to === 'string' && input.to.length > 0) {
    clauses.push('created_at <= ?');
    params.push(input.to);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM three_way_match WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`)
    .all(...params) as Record<string, unknown>[];
  return ok({ matches: rows.map(mapHeaderOut) });
}

export interface MatchThreeWayExceptionsInput {
  supplierId?: string;
  olderThanDays?: number;
}

/**
 * The open exception list (spec US-I04.4): posted, unmatched bills whose current evaluation is
 * `variance` or `nothing_received`. Computed live (variance evaluations are never persisted), bounded
 * to posted bills that have a supplier PO candidate.
 */
export function matchThreeWayExceptions(ctx: WorkspaceContext, input: MatchThreeWayExceptionsInput): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;

  // Draft AND posted bills are matchable (a CHF draft has a base-net figure); only a voided bill is
  // excluded. The convertibility + variance/nothing_received filter below narrows to true exceptions.
  const clauses: string[] = ['b.workspace_id = ?', "b.status IN ('draft', 'posted')"];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof input.supplierId === 'string' && input.supplierId.length > 0) {
    clauses.push('b.contact_id = ?');
    params.push(input.supplierId);
  }
  const bills = ctx.store.db
    .prepare(
      `SELECT b.id AS id, b.contact_id AS contact_id, b.bill_date AS bill_date
         FROM vendor_bill b
        WHERE ${clauses.join(' AND ')}
          AND NOT EXISTS (
            SELECT 1 FROM three_way_match m
             WHERE m.workspace_id = b.workspace_id AND m.bill_id = b.id
               AND m.status IN ('matched','partial','overridden') AND m.reversing_match_id IS NULL)
        ORDER BY b.bill_date, b.id`,
    )
    .all(...params) as { id: string; contact_id: string; bill_date: string }[];

  const nowMs = Date.parse(ctx.clock.now());
  const olderThan = typeof input.olderThanDays === 'number' && input.olderThanDays > 0 ? input.olderThanDays : undefined;

  const exceptions: Record<string, unknown>[] = [];
  for (const b of bills) {
    const evaluation = computeEvaluation(ctx, b.id, undefined, DEFAULT_TOLERANCE);
    if (evaluation === 'bill_not_found') continue;
    if (!evaluation.billConvertible) continue;
    if (evaluation.status !== 'variance' && evaluation.status !== 'nothing_received') continue;
    const billMs = Date.parse(b.bill_date);
    const ageDays = Number.isNaN(billMs) || Number.isNaN(nowMs) ? 0 : Math.max(0, Math.floor((nowMs - billMs) / 86400000));
    if (olderThan !== undefined && ageDays < olderThan) continue;
    exceptions.push({
      billId: b.id,
      poId: evaluation.poId,
      supplierId: b.contact_id,
      status: evaluation.status,
      valueVarianceRappen: evaluation.valueVarianceRappen,
      amountAtRiskRappen: Math.abs(evaluation.valueVarianceRappen),
      totalBilledRappen: evaluation.totalBilledRappen,
      ageDays,
    });
  }
  return ok({ exceptions });
}

export interface MatchStatusForBillInput {
  billId?: string;
}

/**
 * The read-only payment gate A18 / the mark-paid UI consult. `can_pay` is true only when an active
 * match exists (matched | partial | overridden); an unmatched bill is not payable through the gate
 * (I04's default policy). It writes nothing.
 */
export function matchStatusForBill(ctx: WorkspaceContext, input: MatchStatusForBillInput): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;
  if (typeof input.billId !== 'string' || input.billId.length === 0) return err('invalid_input', { field: 'billId' });
  const bill = readBillRow(ctx, input.billId);
  if (bill === undefined) return err('not_found', { billId: input.billId });

  const active = ctx.store.db
    .prepare(
      `SELECT id, status, po_id FROM three_way_match
        WHERE workspace_id = ? AND bill_id = ? AND status IN ('matched','partial','overridden') AND reversing_match_id IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, input.billId) as { id: string; status: string; po_id: string } | undefined;

  if (active === undefined) {
    // Has this bill ever been matched-then-reversed? Report `reversed` so the UI can distinguish it.
    const reversed = ctx.store.db
      .prepare("SELECT 1 FROM three_way_match WHERE workspace_id = ? AND bill_id = ? AND status = 'reversed' LIMIT 1")
      .get(ctx.workspaceId, input.billId);
    return ok({ status: reversed !== undefined ? 'reversed' : 'unmatched', canPay: false, openQtyTotal: 0 });
  }

  const openRow = ctx.store.db
    .prepare('SELECT COALESCE(SUM(MAX(0, received_qty - billed_qty)), 0) AS open_total FROM po_line WHERE workspace_id = ? AND po_id = ?')
    .get(ctx.workspaceId, active.po_id) as { open_total: number };

  return ok({
    status: active.status,
    matchId: active.id,
    canPay: true,
    openQtyTotal: openRow.open_total,
  });
}
