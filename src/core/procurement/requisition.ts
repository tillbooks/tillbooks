/**
 * I00, the REQUISITION engine: the controlled internal-demand document (Wave 14, cluster I root).
 *
 * A requisition captures what the company needs (a stock item or free-text line), how much, by when,
 * for which cost centre / project, and at what ESTIMATED cost, then routes it through a policy-driven
 * approval before any purchasing commitment, and finally converts approved quantities into a D02
 * purchase order with an immutable link back. It opens the procure-to-pay chain
 * (requisition -> PO -> goods receipt -> vendor bill); I01 (advanced PO) will consume the SAME
 * conversion contract this module exposes.
 *
 * NO MONEY PATH: nothing here posts a journal entry and nothing emits an outward artifact. Estimated
 * costs are operational estimates in integer Rappen; VAT and the ledger arise later on the vendor bill
 * (A17 -> A02). Quantity is integer milli-units (1000 = one whole unit). The approval trail and the
 * conversion links are INSERT-ONLY (§H-AUDIT). Every read and write is scoped to `ctx.workspaceId`
 * (§H-TENANT); every write takes an idempotency key (§H-IDEMPOTENT) and rides a commit-on-ok
 * transaction, so a REFUSED write leaves ZERO rows.
 *
 * Validation runs BEFORE any write and returns a structured `err` (P9). Inside a transaction a
 * returned `{ok:false}` would COMMIT the partial write, so every refusal THROWS `TxAbort` to roll back
 * (the C02/D03 bug class the D02 `runTx` wrapper was written to close).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { poUpsert, poSend } from '../purchase/purchaseOrders.js';
import type { PoUpsertInput, PoSendInput, PoLineInput } from '../purchase/purchaseOrders.js';
import { applySavedView } from '../customization/views.js';

// --- Controlled enums (§H-ENUM) ----------------------------------------------------------------

/** The requisition lifecycle. The single source of truth for both the verb guards and the surface. */
export const REQUISITION_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'partially_converted',
  'converted',
  'cancelled',
  'closed',
] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

/** Urgency affects policy routing and visual priority only (§4). */
export const REQUISITION_URGENCIES = ['normal', 'high', 'critical'] as const;
export type RequisitionUrgency = (typeof REQUISITION_URGENCIES)[number];

const URGENCY_SET: ReadonlySet<string> = new Set(REQUISITION_URGENCIES);

/** The A24 capability the writes gate on (the D02 precedent: a demand document is master-data-grade). */
const WRITE_CAP = 'manage_master_data';

/** MILLI is the quantity scale: 1000 milli-units make one whole PO/stock unit. */
const MILLI = 1000;

// --- Row shapes --------------------------------------------------------------------------------

interface RequisitionRow {
  id: string;
  workspace_id: string;
  number: string;
  status: RequisitionStatus;
  requester_id: string;
  needed_by: string;
  urgency: RequisitionUrgency;
  cost_center_id: string | null;
  project_id: string | null;
  description: string | null;
  currency: string;
  total_estimated_rappen: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  closed_at: string | null;
}

interface RequisitionLineRow {
  id: string;
  workspace_id: string;
  requisition_id: string;
  line_no: number;
  item_id: string | null;
  description: string;
  qty_milli: number;
  uom: string | null;
  estimated_unit_cost_rappen: number;
  estimated_total_rappen: number;
  preferred_supplier_id: string | null;
  converted_qty_milli: number;
}

interface ApprovalEventRow {
  id: string;
  requisition_id: string;
  task_id: string | null;
  actor_id: string | null;
  decision: string;
  comment: string | null;
  created_at: string;
}

interface ApprovalTaskRow {
  id: string;
  requisition_id: string;
  required_capability: string;
  status: string;
  step_no: number;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

interface ConversionRow {
  id: string;
  requisition_id: string;
  purchase_order_id: string;
  created_at: string;
}

// --- Mappers -----------------------------------------------------------------------------------

function mapRequisition(row: RequisitionRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    number: row.number,
    status: row.status,
    requesterId: row.requester_id,
    neededBy: row.needed_by,
    urgency: row.urgency,
    costCenterId: row.cost_center_id,
    projectId: row.project_id,
    description: row.description,
    currency: row.currency,
    totalEstimatedRappen: row.total_estimated_rappen,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    closedAt: row.closed_at,
  };
}

function mapLine(row: RequisitionLineRow) {
  return {
    id: row.id,
    lineNo: row.line_no,
    itemId: row.item_id,
    description: row.description,
    qtyMilli: row.qty_milli,
    uom: row.uom,
    estimatedUnitCostRappen: row.estimated_unit_cost_rappen,
    estimatedTotalRappen: row.estimated_total_rappen,
    preferredSupplierId: row.preferred_supplier_id,
    convertedQtyMilli: row.converted_qty_milli,
    openQtyMilli: row.qty_milli - row.converted_qty_milli,
  };
}

// --- Row readers (§H-TENANT: every read is scoped by workspace) --------------------------------

function readRequisition(ctx: WorkspaceContext, id: string): RequisitionRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM requisition WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as RequisitionRow | undefined;
}

function readLines(ctx: WorkspaceContext, requisitionId: string): RequisitionLineRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM requisition_line WHERE workspace_id = ? AND requisition_id = ? ORDER BY line_no')
    .all(ctx.workspaceId, requisitionId) as RequisitionLineRow[];
}

function readEvents(ctx: WorkspaceContext, requisitionId: string): ApprovalEventRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM requisition_approval_event WHERE workspace_id = ? AND requisition_id = ? ORDER BY created_at, id')
    .all(ctx.workspaceId, requisitionId) as ApprovalEventRow[];
}

function readOpenTasks(ctx: WorkspaceContext, requisitionId: string): ApprovalTaskRow[] {
  return ctx.store.db
    .prepare("SELECT * FROM requisition_approval_task WHERE workspace_id = ? AND requisition_id = ? AND status = 'open' ORDER BY step_no")
    .all(ctx.workspaceId, requisitionId) as ApprovalTaskRow[];
}

function readConversions(ctx: WorkspaceContext, requisitionId: string): ConversionRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM requisition_conversion WHERE workspace_id = ? AND requisition_id = ? ORDER BY created_at, id')
    .all(ctx.workspaceId, requisitionId) as ConversionRow[];
}

function itemExists(ctx: WorkspaceContext, id: string): boolean {
  return (
    ctx.store.db.prepare('SELECT id FROM item WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) !== undefined
  );
}

function contactExists(ctx: WorkspaceContext, id: string): boolean {
  return (
    ctx.store.db.prepare('SELECT id FROM contact WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) !==
    undefined
  );
}

function costCenterExists(ctx: WorkspaceContext, id: string): boolean {
  return (
    ctx.store.db.prepare('SELECT id FROM cost_center WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) !==
    undefined
  );
}

function projectExists(ctx: WorkspaceContext, id: string): boolean {
  return (
    ctx.store.db.prepare('SELECT id FROM project WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) !==
    undefined
  );
}

// --- Commit-on-ok transaction wrapper ----------------------------------------------------------

/**
 * Carry a structured `err` out of a transaction by THROWING it, so the store rolls the write back.
 * `db.transaction(fn)` only rolls back when `fn` THROWS: a `run` that writes then RETURNS `{ok:false}`
 * would COMMIT the partial write while reporting failure (the C02/D03 bug class). Local to the module,
 * the D02 `poShared.runTx` shape.
 */
class TxAbort extends Error {
  constructor(readonly result: Result) {
    super('tx_abort');
  }
}

function runTx(ctx: WorkspaceContext, verb: string, idempotencyKey: string | undefined, run: () => Result): Result {
  const guarded = (): Result => {
    const r = run();
    if (!r.ok) throw new TxAbort(r);
    return r;
  };
  try {
    return typeof idempotencyKey === 'string' && idempotencyKey.length > 0
      ? ctx.store.rememberIdempotent(ctx.workspaceId, idempotencyKey, verb, guarded)
      : ctx.store.tx(guarded);
  } catch (e) {
    if (e instanceof TxAbort) return e.result;
    throw e;
  }
}

// --- Numbering ---------------------------------------------------------------------------------

/** A gap-free per-year requisition series (the A10 numbering shape): REQ-YYYY-NNNN. */
function nextNumber(ctx: WorkspaceContext): string {
  const year = ctx.clock.now().slice(0, 4);
  const prefix = `REQ-${year}-`;
  const row = ctx.store.db
    .prepare("SELECT number FROM requisition WHERE workspace_id = ? AND number LIKE ? ORDER BY number DESC LIMIT 1")
    .get(ctx.workspaceId, `${prefix}%`) as { number: string } | undefined;
  const last = row === undefined ? 0 : Number.parseInt(row.number.slice(prefix.length), 10);
  return `${prefix}${String(last + 1).padStart(4, '0')}`;
}

// --- The approval policy evaluator (PURE, §7 invariant 7) ---------------------------------------

/**
 * The policy OP17 will generalise. Until OP17's data-driven engine lands, the rule is deterministic
 * and side-effect free: a requisition whose estimated total is ZERO carries no financial commitment
 * and auto-approves; any positive estimate requires one approval step. Same context always yields the
 * same decision, which is the property §7 invariant 7 and the pure-function tests pin.
 */
export function evaluateApprovalPolicy(context: { amountRappen: number }): {
  decision: 'auto_approve' | 'require_approval';
  steps: { requiredCapability: string }[];
} {
  if (context.amountRappen <= 0) return { decision: 'auto_approve', steps: [] };
  return { decision: 'require_approval', steps: [{ requiredCapability: WRITE_CAP }] };
}

// --- Detail assembly ---------------------------------------------------------------------------

function requisitionDetail(ctx: WorkspaceContext, id: string) {
  const row = readRequisition(ctx, id) as RequisitionRow;
  const conversions = readConversions(ctx, id).map((c) => {
    const cls = ctx.store.db
      .prepare('SELECT requisition_line_id, qty_milli FROM requisition_conversion_line WHERE workspace_id = ? AND conversion_id = ?')
      .all(ctx.workspaceId, c.id) as { requisition_line_id: string; qty_milli: number }[];
    return {
      id: c.id,
      purchaseOrderId: c.purchase_order_id,
      createdAt: c.created_at,
      lines: cls.map((l) => ({ requisitionLineId: l.requisition_line_id, qtyMilli: l.qty_milli })),
    };
  });
  return {
    ...mapRequisition(row),
    lines: readLines(ctx, id).map(mapLine),
    approvalEvents: readEvents(ctx, id).map((e) => ({
      id: e.id,
      taskId: e.task_id,
      actorId: e.actor_id,
      decision: e.decision,
      comment: e.comment,
      createdAt: e.created_at,
    })),
    openTasks: readOpenTasks(ctx, id).map((t) => ({
      id: t.id,
      requiredCapability: t.required_capability,
      stepNo: t.step_no,
      createdAt: t.created_at,
    })),
    conversions,
  };
}

// --- Line resolution (validation + exact integer estimated totals) -----------------------------

interface ResolvedLine {
  itemId: string | null;
  description: string;
  qtyMilli: number;
  uom: string | null;
  estimatedUnitCostRappen: number;
  estimatedTotalRappen: number;
  preferredSupplierId: string | null;
}

interface LineInput {
  itemId?: string | null;
  description?: string | null;
  qtyMilli?: number;
  uom?: string | null;
  estimatedUnitCostRappen?: number;
  preferredSupplierId?: string | null;
}

function resolveLines(ctx: WorkspaceContext, lines: LineInput[]): Result | { resolved: ResolvedLine[] } {
  if (!Array.isArray(lines) || lines.length === 0) return err('invalid_line', { reason: 'no_lines' });
  const resolved: ResolvedLine[] = [];
  for (const line of lines) {
    let itemId: string | null = null;
    if (line.itemId !== undefined && line.itemId !== null && line.itemId !== '') {
      if (!itemExists(ctx, line.itemId)) return err('invalid_reference', { itemId: line.itemId });
      itemId = line.itemId;
    }
    const description = typeof line.description === 'string' ? line.description.trim() : '';
    // A free-text line (no item) MUST carry its own description; an item line may inherit none here
    // but still needs a label, so description is required in both cases.
    if (description.length === 0) {
      return itemId === null ? err('description_required', {}) : err('invalid_line', { reason: 'description' });
    }
    if (typeof line.qtyMilli !== 'number' || !Number.isInteger(line.qtyMilli) || line.qtyMilli <= 0) {
      return err('invalid_qty', { qtyMilli: line.qtyMilli });
    }
    const unit = line.estimatedUnitCostRappen ?? 0;
    if (!Number.isInteger(unit) || unit < 0) return err('invalid_amount', { estimatedUnitCostRappen: unit });
    if (line.preferredSupplierId !== undefined && line.preferredSupplierId !== null && line.preferredSupplierId !== '') {
      if (!contactExists(ctx, line.preferredSupplierId)) {
        return err('invalid_reference', { preferredSupplierId: line.preferredSupplierId });
      }
    }
    resolved.push({
      itemId,
      description,
      qtyMilli: line.qtyMilli,
      uom: typeof line.uom === 'string' && line.uom.length > 0 ? line.uom : null,
      estimatedUnitCostRappen: unit,
      // Exact integer arithmetic (§4): trunc(qty_milli * unit / 1000), never a float.
      estimatedTotalRappen: Math.trunc((line.qtyMilli * unit) / MILLI),
      preferredSupplierId:
        line.preferredSupplierId !== undefined && line.preferredSupplierId !== null && line.preferredSupplierId !== ''
          ? line.preferredSupplierId
          : null,
    });
  }
  return { resolved };
}

// --- requisition_upsert (create or edit a DRAFT) -----------------------------------------------

export interface RequisitionUpsertInput {
  id?: string;
  requesterId?: string;
  neededBy?: string;
  urgency?: string;
  costCenterId?: string | null;
  projectId?: string | null;
  description?: string | null;
  currency?: string;
  lines?: LineInput[];
  idempotencyKey?: string;
}

export function requisitionUpsert(ctx: WorkspaceContext, input: RequisitionUpsertInput): Result {
  const isUpdate = typeof input.id === 'string' && input.id.length > 0;

  const run = (): Result => {
    const now = ctx.clock.now();
    let existing: RequisitionRow | undefined;
    if (isUpdate) {
      existing = readRequisition(ctx, input.id as string);
      if (existing === undefined) return err('not_found', { requisitionId: input.id });
      // Only a draft is editable; a submitted or terminal document changes through the lifecycle verbs.
      if (existing.status !== 'draft') return err('invalid_transition', { requisitionId: input.id, status: existing.status });
    }

    const requesterId =
      typeof input.requesterId === 'string' && input.requesterId.length > 0
        ? input.requesterId
        : existing
          ? existing.requester_id
          : (ctx.actor ?? 'unknown');
    const neededBy = typeof input.neededBy === 'string' && input.neededBy.length > 0 ? input.neededBy : existing?.needed_by;
    if (typeof neededBy !== 'string' || neededBy.length === 0) return err('invalid_input', { field: 'neededBy' });

    const urgency = input.urgency ?? existing?.urgency ?? 'normal';
    if (!URGENCY_SET.has(urgency)) return err('invalid_urgency', { urgency, allowed: [...REQUISITION_URGENCIES] });

    const currency = input.currency ?? existing?.currency ?? 'CHF';

    const costCenterId = input.costCenterId !== undefined ? input.costCenterId : existing?.cost_center_id ?? null;
    if (costCenterId !== null && costCenterId !== '' && !costCenterExists(ctx, costCenterId)) {
      return err('invalid_reference', { costCenterId });
    }
    const projectId = input.projectId !== undefined ? input.projectId : existing?.project_id ?? null;
    if (projectId !== null && projectId !== '' && !projectExists(ctx, projectId)) {
      return err('invalid_reference', { projectId });
    }

    const lineResult = resolveLines(ctx, input.lines ?? []);
    if ('ok' in lineResult) return lineResult;
    const resolved = lineResult.resolved;
    const totalEstimated = resolved.reduce((sum, l) => sum + l.estimatedTotalRappen, 0);

    const description = input.description !== undefined ? input.description : existing?.description ?? null;

    let id: string;
    if (isUpdate) {
      id = input.id as string;
      ctx.store.db
        .prepare(
          `UPDATE requisition SET requester_id = ?, needed_by = ?, urgency = ?, cost_center_id = ?, project_id = ?,
             description = ?, currency = ?, total_estimated_rappen = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
        )
        .run(
          requesterId,
          neededBy,
          urgency,
          costCenterId === '' ? null : costCenterId,
          projectId === '' ? null : projectId,
          description,
          currency,
          totalEstimated,
          now,
          ctx.workspaceId,
          id,
        );
      // Draft lines are fully replaced on every edit; a draft has no downstream references (§H-AUDIT
      // starts at submit), so a rewrite is honest here.
      ctx.store.db.prepare('DELETE FROM requisition_line WHERE workspace_id = ? AND requisition_id = ?').run(ctx.workspaceId, id);
    } else {
      id = ctx.ids.next('requisition');
      ctx.store.db
        .prepare(
          `INSERT INTO requisition (id, workspace_id, number, status, requester_id, needed_by, urgency, cost_center_id,
             project_id, description, currency, total_estimated_rappen, created_at, created_by, updated_at)
           VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          ctx.workspaceId,
          nextNumber(ctx),
          requesterId,
          neededBy,
          urgency,
          costCenterId === '' ? null : costCenterId,
          projectId === '' ? null : projectId,
          description,
          currency,
          totalEstimated,
          now,
          ctx.actor ?? null,
          now,
        );
    }

    resolved.forEach((l, i) => {
      ctx.store.db
        .prepare(
          `INSERT INTO requisition_line (id, workspace_id, requisition_id, line_no, item_id, description, qty_milli, uom,
             estimated_unit_cost_rappen, estimated_total_rappen, preferred_supplier_id, converted_qty_milli)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          ctx.ids.next('reqline'),
          ctx.workspaceId,
          id,
          i + 1,
          l.itemId,
          l.description,
          l.qtyMilli,
          l.uom,
          l.estimatedUnitCostRappen,
          l.estimatedTotalRappen,
          l.preferredSupplierId,
        );
    });

    return ok({ requisition: requisitionDetail(ctx, id) });
  };

  return runTx(ctx, 'requisition_upsert', input.idempotencyKey, run);
}

// --- requisition_submit (evaluate policy -> pending_approval or auto-approved) ------------------

export interface RequisitionSimpleInput {
  requisitionId?: string;
  idempotencyKey?: string;
}

function writeEvent(
  ctx: WorkspaceContext,
  requisitionId: string,
  decision: string,
  opts: { taskId?: string | null; comment?: string | null } = {},
): void {
  ctx.store.db
    .prepare(
      `INSERT INTO requisition_approval_event (id, workspace_id, requisition_id, task_id, actor_id, decision, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.ids.next('reqevent'),
      ctx.workspaceId,
      requisitionId,
      opts.taskId ?? null,
      ctx.actor ?? null,
      decision,
      opts.comment ?? null,
      ctx.clock.now(),
    );
}

export function requisitionSubmit(ctx: WorkspaceContext, input: RequisitionSimpleInput): Result {
  const run = (): Result => {
    const req = readRequisition(ctx, input.requisitionId as string);
    if (req === undefined) return err('not_found', { requisitionId: input.requisitionId });
    if (req.status !== 'draft') return err('invalid_transition', { requisitionId: req.id, from: req.status, to: 'pending_approval' });
    if (readLines(ctx, req.id).length === 0) return err('invalid_line', { reason: 'no_lines' });

    const now = ctx.clock.now();
    writeEvent(ctx, req.id, 'submitted');
    const policy = evaluateApprovalPolicy({ amountRappen: req.total_estimated_rappen });
    if (policy.decision === 'auto_approve') {
      writeEvent(ctx, req.id, 'auto_approved');
      ctx.store.db
        .prepare("UPDATE requisition SET status = 'approved', submitted_at = ?, approved_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(now, now, now, ctx.workspaceId, req.id);
    } else {
      policy.steps.forEach((step, i) => {
        ctx.store.db
          .prepare(
            `INSERT INTO requisition_approval_task (id, workspace_id, requisition_id, required_capability, status, step_no, created_at)
             VALUES (?, ?, ?, ?, 'open', ?, ?)`,
          )
          .run(ctx.ids.next('reqtask'), ctx.workspaceId, req.id, step.requiredCapability, i + 1, now);
      });
      ctx.store.db
        .prepare("UPDATE requisition SET status = 'pending_approval', submitted_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(now, now, ctx.workspaceId, req.id);
    }
    return ok({ requisition: requisitionDetail(ctx, req.id) });
  };
  return runTx(ctx, 'requisition_submit', input.idempotencyKey, run);
}

// --- requisition_approve / reject / return -----------------------------------------------------

export interface RequisitionDecisionInput {
  requisitionId?: string;
  taskId?: string;
  comment?: string | null;
  reason?: string;
  idempotencyKey?: string;
}

function completeTask(ctx: WorkspaceContext, taskId: string): void {
  ctx.store.db
    .prepare("UPDATE requisition_approval_task SET status = 'completed', decided_at = ?, decided_by = ? WHERE workspace_id = ? AND id = ?")
    .run(ctx.clock.now(), ctx.actor ?? null, ctx.workspaceId, taskId);
}

function cancelOpenTasks(ctx: WorkspaceContext, requisitionId: string): void {
  ctx.store.db
    .prepare("UPDATE requisition_approval_task SET status = 'cancelled', decided_at = ? WHERE workspace_id = ? AND requisition_id = ? AND status = 'open'")
    .run(ctx.clock.now(), ctx.workspaceId, requisitionId);
}

export function requisitionApprove(ctx: WorkspaceContext, input: RequisitionDecisionInput): Result {
  const run = (): Result => {
    const req = readRequisition(ctx, input.requisitionId as string);
    if (req === undefined) return err('not_found', { requisitionId: input.requisitionId });
    if (req.status !== 'pending_approval') return err('invalid_transition', { requisitionId: req.id, from: req.status });
    const open = readOpenTasks(ctx, req.id);
    if (open.length === 0) return err('invalid_transition', { requisitionId: req.id, reason: 'no_open_task' });

    // Pick the named task or, when the actor names none, the first open step.
    const task = typeof input.taskId === 'string' && input.taskId.length > 0 ? open.find((t) => t.id === input.taskId) : open[0];
    if (task === undefined) return err('not_found', { taskId: input.taskId });

    const now = ctx.clock.now();
    completeTask(ctx, task.id);
    writeEvent(ctx, req.id, 'approved', { taskId: task.id, comment: input.comment ?? null });
    // Approved once every required step is satisfied (single-step policy: this completes it).
    if (readOpenTasks(ctx, req.id).length === 0) {
      ctx.store.db
        .prepare("UPDATE requisition SET status = 'approved', approved_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(now, now, ctx.workspaceId, req.id);
    } else {
      ctx.store.db.prepare('UPDATE requisition SET updated_at = ? WHERE workspace_id = ? AND id = ?').run(now, ctx.workspaceId, req.id);
    }
    return ok({ requisition: requisitionDetail(ctx, req.id) });
  };
  return runTx(ctx, 'requisition_approve', input.idempotencyKey, run);
}

export function requisitionReject(ctx: WorkspaceContext, input: RequisitionDecisionInput): Result {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  const run = (): Result => {
    if (reason.length === 0) return err('reason_required', {});
    const req = readRequisition(ctx, input.requisitionId as string);
    if (req === undefined) return err('not_found', { requisitionId: input.requisitionId });
    if (req.status !== 'pending_approval') return err('invalid_transition', { requisitionId: req.id, from: req.status });
    const now = ctx.clock.now();
    cancelOpenTasks(ctx, req.id);
    writeEvent(ctx, req.id, 'rejected', { comment: reason });
    ctx.store.db
      .prepare("UPDATE requisition SET status = 'rejected', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, ctx.workspaceId, req.id);
    return ok({ requisition: requisitionDetail(ctx, req.id) });
  };
  return runTx(ctx, 'requisition_reject', input.idempotencyKey, run);
}

export function requisitionReturn(ctx: WorkspaceContext, input: RequisitionDecisionInput): Result {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  const run = (): Result => {
    if (reason.length === 0) return err('reason_required', {});
    const req = readRequisition(ctx, input.requisitionId as string);
    if (req === undefined) return err('not_found', { requisitionId: input.requisitionId });
    if (req.status !== 'pending_approval') return err('invalid_transition', { requisitionId: req.id, from: req.status });
    const now = ctx.clock.now();
    cancelOpenTasks(ctx, req.id);
    writeEvent(ctx, req.id, 'returned', { comment: reason });
    // Return sends the document back to draft: the requester edits and re-submits, a fresh cycle
    // begins, and the prior events stay queryable (§H-AUDIT).
    ctx.store.db
      .prepare("UPDATE requisition SET status = 'draft', submitted_at = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, ctx.workspaceId, req.id);
    return ok({ requisition: requisitionDetail(ctx, req.id) });
  };
  return runTx(ctx, 'requisition_return', input.idempotencyKey, run);
}

// --- requisition_convert_to_po -----------------------------------------------------------------

export interface RequisitionConvertInput {
  requisitionId?: string;
  lines?: { lineId?: string; qtyMilli?: number }[];
  supplierContactId?: string | null;
  createAs?: string;
  idempotencyKey?: string;
}

export function requisitionConvertToPo(ctx: WorkspaceContext, input: RequisitionConvertInput): Result {
  const run = (): Result => {
    const req = readRequisition(ctx, input.requisitionId as string);
    if (req === undefined) return err('not_found', { requisitionId: input.requisitionId });
    if (req.status !== 'approved' && req.status !== 'partially_converted') {
      return err('invalid_transition', { requisitionId: req.id, from: req.status });
    }
    const createAs = input.createAs === 'sent' ? 'sent' : 'draft';
    const requested = Array.isArray(input.lines) ? input.lines : [];
    if (requested.length === 0) return err('invalid_line', { reason: 'no_lines' });

    const lines = readLines(ctx, req.id);
    const byId = new Map(lines.map((l) => [l.id, l]));

    // Validate every requested line against its open quantity BEFORE any write.
    const plan: { line: RequisitionLineRow; qtyMilli: number }[] = [];
    for (const r of requested) {
      const line = typeof r.lineId === 'string' ? byId.get(r.lineId) : undefined;
      if (line === undefined) return err('not_found', { lineId: r.lineId });
      const qtyMilli = r.qtyMilli;
      if (typeof qtyMilli !== 'number' || !Number.isInteger(qtyMilli) || qtyMilli <= 0 || qtyMilli % MILLI !== 0) {
        // A PO orders WHOLE units, so a converted quantity must be a positive whole-unit multiple.
        return err('invalid_qty', { lineId: r.lineId, qtyMilli });
      }
      const open = line.qty_milli - line.converted_qty_milli;
      if (qtyMilli > open) return err('over_conversion', { lineId: line.id, openQtyMilli: open, requestedQtyMilli: qtyMilli });
      plan.push({ line, qtyMilli });
    }

    // Resolve the supplier: the override wins; otherwise the shared preferred supplier of the selected
    // lines. A PO is per-supplier, so a mixed selection with no override is refused.
    let supplier = typeof input.supplierContactId === 'string' && input.supplierContactId.length > 0 ? input.supplierContactId : null;
    if (supplier === null) {
      const suppliers = new Set(plan.map((p) => p.line.preferred_supplier_id).filter((s): s is string => s !== null));
      if (suppliers.size === 1) supplier = [...suppliers][0] ?? null;
    }
    if (supplier === null) return err('missing_supplier', { requisitionId: req.id });
    if (!contactExists(ctx, supplier)) return err('invalid_reference', { supplierContactId: supplier });

    // Build the D02 PO through its OWN contract (poUpsert), so the purchasing pipeline owns the PO and
    // I01 can later swap in the advanced-PO contract behind the same call site. Whole-unit qty.
    const poLines: PoLineInput[] = plan.map((p) => {
      const base: PoLineInput = {
        description: p.line.description,
        qty: p.qtyMilli / MILLI,
        unitPriceRappen: p.line.estimated_unit_cost_rappen,
      };
      // Only set itemId when the requisition line names one (exactOptionalPropertyTypes: never pass
      // an explicit `undefined`); a free-text line becomes a free-text PO line.
      if (p.line.item_id !== null) base.itemId = p.line.item_id;
      return base;
    });
    const poInput: PoUpsertInput = {
      supplierContactId: supplier,
      currency: req.currency,
      lines: poLines,
      note: `Aus Anforderung ${req.number}`,
      // I01 provenance: a first-class requisition -> PO link (drill-back both ways), beside the human
      // note. The `requisition_conversion` row below still records the per-line conversion; this is the
      // header-level origin so the PO alone answers "where did this come from?".
      sourceDocumentType: 'requisition',
      sourceDocumentId: req.id,
    };
    if (input.idempotencyKey) poInput.idempotencyKey = `${input.idempotencyKey}:po`;
    const poResult = poUpsert(ctx, poInput);
    if (!poResult.ok) return poResult;
    const purchaseOrderId = (poResult as unknown as { poId: string }).poId;

    if (createAs === 'sent') {
      const sendInput: PoSendInput = { poId: purchaseOrderId };
      if (input.idempotencyKey) sendInput.idempotencyKey = `${input.idempotencyKey}:send`;
      const sent = poSend(ctx, sendInput);
      if (!sent.ok) return sent;
    }

    const now = ctx.clock.now();
    const conversionId = ctx.ids.next('reqconv');
    ctx.store.db
      .prepare(
        `INSERT INTO requisition_conversion (id, workspace_id, requisition_id, purchase_order_id, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(conversionId, ctx.workspaceId, req.id, purchaseOrderId, now, ctx.actor ?? null);
    for (const p of plan) {
      ctx.store.db
        .prepare(
          `INSERT INTO requisition_conversion_line (id, workspace_id, conversion_id, requisition_line_id, qty_milli)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(ctx.ids.next('reqconvline'), ctx.workspaceId, conversionId, p.line.id, p.qtyMilli);
      ctx.store.db
        .prepare('UPDATE requisition_line SET converted_qty_milli = converted_qty_milli + ? WHERE workspace_id = ? AND id = ?')
        .run(p.qtyMilli, ctx.workspaceId, p.line.id);
    }

    // Recompute status from the OPEN quantity across ALL lines.
    const fresh = readLines(ctx, req.id);
    const anyOpen = fresh.some((l) => l.qty_milli - l.converted_qty_milli > 0);
    const status = anyOpen ? 'partially_converted' : 'converted';
    ctx.store.db
      .prepare('UPDATE requisition SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(status, now, ctx.workspaceId, req.id);

    return ok({ requisition: requisitionDetail(ctx, req.id), purchaseOrderId, conversionId });
  };
  return runTx(ctx, 'requisition_convert_to_po', input.idempotencyKey, run);
}

// --- requisition_cancel / close ----------------------------------------------------------------

export interface RequisitionCancelInput {
  requisitionId?: string;
  reason?: string | null;
  idempotencyKey?: string;
}

export function requisitionCancel(ctx: WorkspaceContext, input: RequisitionCancelInput): Result {
  const run = (): Result => {
    const req = readRequisition(ctx, input.requisitionId as string);
    if (req === undefined) return err('not_found', { requisitionId: input.requisitionId });
    // A document that already has a conversion must be CLOSED, never cancelled (§2 US-I00.5), and this
    // is checked BEFORE the status guard so a partially_converted document reports the specific
    // has_conversions rather than the generic invalid_transition.
    if (readConversions(ctx, req.id).length > 0) return err('has_conversions', { requisitionId: req.id });
    if (req.status !== 'draft' && req.status !== 'pending_approval' && req.status !== 'approved') {
      return err('invalid_transition', { requisitionId: req.id, from: req.status });
    }
    const now = ctx.clock.now();
    cancelOpenTasks(ctx, req.id);
    ctx.store.db
      .prepare("UPDATE requisition SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, now, ctx.workspaceId, req.id);
    return ok({ requisition: requisitionDetail(ctx, req.id) });
  };
  return runTx(ctx, 'requisition_cancel', input.idempotencyKey, run);
}

export function requisitionClose(ctx: WorkspaceContext, input: RequisitionSimpleInput): Result {
  const run = (): Result => {
    const req = readRequisition(ctx, input.requisitionId as string);
    if (req === undefined) return err('not_found', { requisitionId: input.requisitionId });
    if (req.status !== 'converted' && req.status !== 'partially_converted') {
      return err('invalid_transition', { requisitionId: req.id, from: req.status });
    }
    const now = ctx.clock.now();
    ctx.store.db
      .prepare("UPDATE requisition SET status = 'closed', closed_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, now, ctx.workspaceId, req.id);
    return ok({ requisition: requisitionDetail(ctx, req.id) });
  };
  return runTx(ctx, 'requisition_close', input.idempotencyKey, run);
}

// --- Reads -------------------------------------------------------------------------------------

export function requisitionGet(ctx: WorkspaceContext, input: { requisitionId?: string }): Result {
  if (typeof input.requisitionId !== 'string' || input.requisitionId.length === 0) {
    return err('invalid_input', { field: 'requisitionId' });
  }
  const row = readRequisition(ctx, input.requisitionId);
  if (row === undefined) return err('not_found', { requisitionId: input.requisitionId });
  return ok({ requisition: requisitionDetail(ctx, input.requisitionId) });
}

export interface RequisitionListInput {
  status?: string | string[];
  requesterId?: string;
  projectId?: string;
  costCenterId?: string;
  neededByFrom?: string;
  neededByTo?: string;
  q?: string;
  savedViewId?: string;
}

export function requisitionList(ctx: WorkspaceContext, input: RequisitionListInput = {}): Result {
  // A `requisition` saved view (G00) merges its stored filters UNDERNEATH any filter named explicitly
  // here, the poList precedent.
  const viewed = applySavedView(ctx, 'requisition', {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.requesterId !== undefined ? { requesterId: input.requesterId } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.costCenterId !== undefined ? { costCenterId: input.costCenterId } : {}),
    ...(input.neededByFrom !== undefined ? { neededByFrom: input.neededByFrom } : {}),
    ...(input.neededByTo !== undefined ? { neededByTo: input.neededByTo } : {}),
    ...(input.q !== undefined ? { q: input.q } : {}),
    ...(input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {}),
  });
  if (!viewed.ok) return viewed;
  const f = viewed.filter as RequisitionListInput;

  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  const statuses = Array.isArray(f.status) ? f.status : typeof f.status === 'string' && f.status.length > 0 ? [f.status] : [];
  if (statuses.length > 0) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (typeof f.requesterId === 'string' && f.requesterId.length > 0) {
    clauses.push('requester_id = ?');
    params.push(f.requesterId);
  }
  if (typeof f.projectId === 'string' && f.projectId.length > 0) {
    clauses.push('project_id = ?');
    params.push(f.projectId);
  }
  if (typeof f.costCenterId === 'string' && f.costCenterId.length > 0) {
    clauses.push('cost_center_id = ?');
    params.push(f.costCenterId);
  }
  if (typeof f.neededByFrom === 'string' && f.neededByFrom.length > 0) {
    clauses.push('needed_by >= ?');
    params.push(f.neededByFrom);
  }
  if (typeof f.neededByTo === 'string' && f.neededByTo.length > 0) {
    clauses.push('needed_by <= ?');
    params.push(f.neededByTo);
  }
  if (typeof f.q === 'string' && f.q.trim().length > 0) {
    clauses.push('(lower(number) LIKE ? OR lower(description) LIKE ?)');
    const like = `%${f.q.trim().toLowerCase()}%`;
    params.push(like, like);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM requisition WHERE ${clauses.join(' AND ')} ORDER BY number DESC`)
    .all(...params) as RequisitionRow[];
  return ok({ requisitions: rows.map(mapRequisition) });
}

export function requisitionMyPendingApprovals(ctx: WorkspaceContext, _input: { savedViewId?: string } = {}): Result {
  // The open approval tasks the workspace still owes a decision on, joined to their requisition header
  // so the inbox renders without a second round-trip. Capability-scoped rather than user-assigned
  // until OP17's role/user routing lands: any holder of the task's required capability may act.
  const rows = ctx.store.db
    .prepare(
      `SELECT t.id AS task_id, t.requisition_id, t.required_capability, t.step_no, t.created_at,
              r.number, r.status, r.requester_id, r.needed_by, r.urgency, r.total_estimated_rappen, r.currency
       FROM requisition_approval_task t
       JOIN requisition r ON r.workspace_id = t.workspace_id AND r.id = t.requisition_id
       WHERE t.workspace_id = ? AND t.status = 'open'
       ORDER BY r.needed_by, t.created_at`,
    )
    .all(ctx.workspaceId) as Record<string, unknown>[];
  return ok({
    tasks: rows.map((r) => ({
      taskId: r.task_id,
      requisitionId: r.requisition_id,
      requiredCapability: r.required_capability,
      stepNo: r.step_no,
      number: r.number,
      status: r.status,
      requesterId: r.requester_id,
      neededBy: r.needed_by,
      urgency: r.urgency,
      totalEstimatedRappen: r.total_estimated_rappen,
      currency: r.currency,
    })),
  });
}
