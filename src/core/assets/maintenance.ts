/**
 * H08, the SIMPLE MAINTENANCE LOG engine: an append-oriented, workspace-scoped log of completed (or
 * cancelled) maintenance events attached to a fixed asset (H01), with optional descriptive cost
 * capture. Create / limited update / soft-cancel / get / list.
 *
 * NON-POSTING BY DESIGN (spec §1/§4). A maintenance entry records what was done, when, by whom and at
 * what cost, but it NEVER posts to the General Ledger. The captured cost is metadata for later TCO
 * reporting (H09), not a journal: this module imports neither `postEntry` nor any A02 verb, and the
 * `asset_maintenance_log` table has no `journal_entry_id` column, so no call path can create one. Money
 * is integer Rappen only (never a float), exactly like every financial figure, and moves zero Rappen.
 *
 * §H-TENANT on every read and write: a foreign asset or log id resolves to undefined, never to its row,
 * so a cross-workspace read is a `not_found` and a cross-workspace write is impossible. Validation runs
 * BEFORE any write and returns a structured `err` (P9); only the write itself is wrapped in
 * `rememberIdempotent`, so a rejected create writes nothing and a replay of the same idempotency key
 * returns the original result and adds no rows (§H-IDEMPOTENT, idempotent on ROWS).
 *
 * APPEND-ORIENTED, NOT A DESTRUCTIVE EDIT. A `completed` entry may be descriptively corrected while it
 * is recent, and soft-cancelled to `cancelled` with a reason if it was entered in error (spec
 * §2/US-H08.5). After the workspace soft-edit window (default 90 days from created_at) only cancel is
 * allowed; a descriptive update is refused with `log_locked` (spec §4/§6). A row is never hard-deleted
 * (the DB trigger enforces it), so the OR 957/958 history can never lose an entry.
 *
 * FILE OWNERSHIP: H08 owns this module and `maintenanceSchema.ts`. It READS the H01 `asset` table (to
 * check existence, workspace and status) but never writes it: a maintenance log changes nothing on the
 * asset master.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';

/** An ISO calendar date `YYYY-MM-DD`, the shape the asset dates already use. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** §H-ENUM: the registered maintenance types (spec §4 data model). */
export const MAINTENANCE_TYPES = [
  'corrective',
  'preventive',
  'inspection',
  'calibration',
  'upgrade',
  'other',
] as const;
const MAINTENANCE_TYPE_SET: ReadonlySet<string> = new Set(MAINTENANCE_TYPES);

/** The asset statuses a NEW log entry is allowed on. `archived` is refused (history stays readable). */
const LOGGABLE_ASSET_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'active',
  'fully_depreciated',
  'disposed',
]);

const MAX_TITLE_LEN = 200;

/** How long after creation a descriptive update stays allowed. After this only cancel is permitted. */
const SOFT_EDIT_WINDOW_DAYS = 90;
/** The far-future guard on log_date: a date more than this many days ahead is a typo, not a plan. */
const MAX_FUTURE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface MaintenanceRow {
  id: string;
  workspace_id: string;
  asset_id: string;
  log_date: string;
  maintenance_type: string;
  title: string;
  description: string | null;
  performed_by_user_id: string | null;
  external_party: string | null;
  cost_rappen: number | null;
  parts_cost_rappen: number | null;
  labour_cost_rappen: number | null;
  external_reference: string | null;
  linked_document_id: string | null;
  status: string;
  cancel_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  idempotency_key: string | null;
}

function mapLog(row: MaintenanceRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    assetId: row.asset_id,
    logDate: row.log_date,
    maintenanceType: row.maintenance_type,
    title: row.title,
    description: row.description,
    performedByUserId: row.performed_by_user_id,
    externalParty: row.external_party,
    costRappen: row.cost_rappen,
    partsCostRappen: row.parts_cost_rappen,
    labourCostRappen: row.labour_cost_rappen,
    externalReference: row.external_reference,
    linkedDocumentId: row.linked_document_id,
    status: row.status,
    cancelReason: row.cancel_reason,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

function readLog(ctx: WorkspaceContext, id: string): MaintenanceRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM asset_maintenance_log WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as MaintenanceRow | undefined;
}

interface AssetStatusRow {
  id: string;
  status: string;
}

function readAsset(ctx: WorkspaceContext, id: string): AssetStatusRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, status FROM asset WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as AssetStatusRow | undefined;
}

/** The calendar date (YYYY-MM-DD) `days` after `nowIso`, for the far-future guard. */
function dateOffsetFrom(nowIso: string, days: number): string {
  const base = new Date(nowIso);
  const shifted = new Date(base.getTime() + days * MS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/** Whole days elapsed between an earlier ISO instant and `nowIso` (for the soft-edit window). */
function daysBetween(earlierIso: string, nowIso: string): number {
  return (new Date(nowIso).getTime() - new Date(earlierIso).getTime()) / MS_PER_DAY;
}

/**
 * A cost field is either absent (undefined/null → stored NULL) or a non-negative safe integer number of
 * Rappen. Anything else (a float, a negative, a string, NaN) is `invalid_cost`. Returns the normalised
 * value or the error token.
 */
type CostCheck = { ok: true; value: number | null } | { ok: false };
function checkCost(raw: unknown): CostCheck {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return { ok: false };
  return { ok: true, value: raw };
}

export interface CreateMaintenanceLogInput {
  assetId?: string;
  logDate?: string;
  maintenanceType?: string;
  title?: string;
  description?: string | null;
  performedByUserId?: string | null;
  externalParty?: string | null;
  costRappen?: number | null;
  partsCostRappen?: number | null;
  labourCostRappen?: number | null;
  externalReference?: string | null;
  linkedDocumentId?: string | null;
  notes?: string | null;
  idempotencyKey?: string;
}

export function assetMaintenanceLogCreate(ctx: WorkspaceContext, input: CreateMaintenanceLogInput): Result {
  // Replay a completed create BEFORE any state-dependent guard (§H-IDEMPOTENT), the H00/H05 order.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_maintenance_log_create');
    if (replayed !== undefined) return replayed;
  }

  const assetId = typeof input.assetId === 'string' ? input.assetId : '';
  if (assetId.length === 0) return err('invalid_input', { field: 'assetId' });
  const asset = readAsset(ctx, assetId);
  // A foreign or missing asset is not_found (§H-TENANT), never a leak of another workspace's row.
  if (asset === undefined) return err('not_found', { assetId });
  // History stays readable on an archived asset, but a NEW entry is blocked (spec §2/US-H08.2).
  if (asset.status === 'archived') return err('asset_archived', { assetId });
  if (!LOGGABLE_ASSET_STATUSES.has(asset.status)) return err('asset_archived', { assetId, status: asset.status });

  const logDate = typeof input.logDate === 'string' ? input.logDate.trim() : '';
  if (logDate.length === 0) return err('missing_log_date', {});
  if (!ISO_DATE.test(logDate)) return err('invalid_input', { field: 'logDate' });
  // A date more than 30 days in the future is a typo, not a plan (spec §2/US-H08.2).
  if (logDate > dateOffsetFrom(ctx.clock.now(), MAX_FUTURE_DAYS)) return err('log_date_too_far', { logDate });

  const maintenanceType = typeof input.maintenanceType === 'string' ? input.maintenanceType : '';
  if (!MAINTENANCE_TYPE_SET.has(maintenanceType)) return err('invalid_maintenance_type', { maintenanceType });

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length === 0 || title.length > MAX_TITLE_LEN) return err('invalid_input', { field: 'title' });

  const cost = checkCost(input.costRappen);
  const parts = checkCost(input.partsCostRappen);
  const labour = checkCost(input.labourCostRappen);
  if (!cost.ok) return err('invalid_cost', { field: 'costRappen' });
  if (!parts.ok) return err('invalid_cost', { field: 'partsCostRappen' });
  if (!labour.ok) return err('invalid_cost', { field: 'labourCostRappen' });

  // Parts + labour consistency (spec §4): when both splits are present, a supplied total must equal
  // their sum; when no total is supplied, the engine derives it from the splits.
  let total = cost.value;
  if (parts.value !== null && labour.value !== null) {
    const sum = parts.value + labour.value;
    if (total !== null && total !== sum) return err('invalid_cost', { field: 'costRappen', expected: sum });
    total = sum;
  }

  const description = normaliseText(input.description);
  const externalParty = normaliseText(input.externalParty);
  const externalReference = normaliseText(input.externalReference);
  const notes = normaliseText(input.notes);
  const performedByUserId = normaliseText(input.performedByUserId);
  const linkedDocumentId = normaliseText(input.linkedDocumentId);

  const run = (): Result => {
    const id = ctx.ids.next('amlog');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO asset_maintenance_log (
           id, workspace_id, asset_id, log_date, maintenance_type, title, description,
           performed_by_user_id, external_party, cost_rappen, parts_cost_rappen, labour_cost_rappen,
           external_reference, linked_document_id, status, cancel_reason, notes,
           created_at, updated_at, created_by, idempotency_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        asset.id,
        logDate,
        maintenanceType,
        title,
        description,
        performedByUserId,
        externalParty,
        total,
        parts.value,
        labour.value,
        externalReference,
        linkedDocumentId,
        notes,
        now,
        now,
        ctx.actor,
        input.idempotencyKey ?? null,
      );
    ctx.audit.record({
      entityKind: 'asset_maintenance_log',
      entityId: id,
      action: 'create',
      actor: ctx.actor,
      at: now,
    });
    return ok({ log: mapLog(readLog(ctx, id) as MaintenanceRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_maintenance_log_create', run);
  }
  return run();
}

export interface UpdateMaintenanceLogInput {
  id?: string;
  patch?: {
    title?: string;
    description?: string | null;
    costRappen?: number | null;
    partsCostRappen?: number | null;
    labourCostRappen?: number | null;
    externalReference?: string | null;
    notes?: string | null;
  };
  idempotencyKey?: string;
}

export function assetMaintenanceLogUpdate(ctx: WorkspaceContext, input: UpdateMaintenanceLogInput): Result {
  if (typeof input.id !== 'string' || input.id.length === 0) return err('invalid_input', { field: 'id' });
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_maintenance_log_update');
    if (replayed !== undefined) return replayed;
  }

  const current = readLog(ctx, input.id);
  if (current === undefined) return err('not_found', { id: input.id });
  // A cancelled entry is closed: it is corrected by a fresh entry, not re-edited (spec §2/US-H08.5).
  if (current.status === 'cancelled') return err('log_cancelled', { id: current.id });
  // Soft-edit window: after it, the historical record is protected and only cancel is allowed.
  if (daysBetween(current.created_at, ctx.clock.now()) > SOFT_EDIT_WINDOW_DAYS) {
    return err('log_locked', { id: current.id });
  }

  const patch = input.patch ?? {};

  const title = patch.title !== undefined ? String(patch.title).trim() : current.title;
  if (title.length === 0 || title.length > MAX_TITLE_LEN) return err('invalid_input', { field: 'title' });

  // Costs: undefined leaves the stored value; null/anything else runs the same non-negativity guard.
  const nextCost = patch.costRappen !== undefined ? checkCost(patch.costRappen) : { ok: true as const, value: current.cost_rappen };
  const nextParts = patch.partsCostRappen !== undefined ? checkCost(patch.partsCostRappen) : { ok: true as const, value: current.parts_cost_rappen };
  const nextLabour = patch.labourCostRappen !== undefined ? checkCost(patch.labourCostRappen) : { ok: true as const, value: current.labour_cost_rappen };
  if (!nextCost.ok) return err('invalid_cost', { field: 'costRappen' });
  if (!nextParts.ok) return err('invalid_cost', { field: 'partsCostRappen' });
  if (!nextLabour.ok) return err('invalid_cost', { field: 'labourCostRappen' });

  let total = nextCost.value;
  if (nextParts.value !== null && nextLabour.value !== null) {
    const sum = nextParts.value + nextLabour.value;
    if (total !== null && total !== sum) return err('invalid_cost', { field: 'costRappen', expected: sum });
    total = sum;
  }

  const description = patch.description !== undefined ? normaliseText(patch.description) : current.description;
  const externalReference = patch.externalReference !== undefined ? normaliseText(patch.externalReference) : current.external_reference;
  const notes = patch.notes !== undefined ? normaliseText(patch.notes) : current.notes;

  const run = (): Result => {
    ctx.store.db
      .prepare(
        `UPDATE asset_maintenance_log
            SET title = ?, description = ?, cost_rappen = ?, parts_cost_rappen = ?, labour_cost_rappen = ?,
                external_reference = ?, notes = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        title,
        description,
        total,
        nextParts.value,
        nextLabour.value,
        externalReference,
        notes,
        ctx.clock.now(),
        ctx.workspaceId,
        current.id,
      );
    ctx.audit.record({
      entityKind: 'asset_maintenance_log',
      entityId: current.id,
      action: 'update',
      actor: ctx.actor,
      at: ctx.clock.now(),
    });
    return ok({ log: mapLog(readLog(ctx, current.id) as MaintenanceRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_maintenance_log_update', run);
  }
  return run();
}

export interface CancelMaintenanceLogInput {
  id?: string;
  reason?: string;
  idempotencyKey?: string;
}

export function assetMaintenanceLogCancel(ctx: WorkspaceContext, input: CancelMaintenanceLogInput): Result {
  if (typeof input.id !== 'string' || input.id.length === 0) return err('invalid_input', { field: 'id' });
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'asset_maintenance_log_cancel');
    if (replayed !== undefined) return replayed;
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length === 0) return err('invalid_input', { field: 'reason' });

  const current = readLog(ctx, input.id);
  if (current === undefined) return err('not_found', { id: input.id });

  const run = (): Result => {
    const row = readLog(ctx, input.id as string) as MaintenanceRow;
    // Cancelling an already-cancelled entry is a no-op (idempotent, spec §7 tripwire): the first
    // reason stands and no second write lands.
    if (row.status === 'cancelled') return ok({ log: mapLog(row) });
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        "UPDATE asset_maintenance_log SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
      )
      .run(reason, now, ctx.workspaceId, row.id);
    ctx.audit.record({
      entityKind: 'asset_maintenance_log',
      entityId: row.id,
      action: 'cancel',
      actor: ctx.actor,
      at: now,
    });
    return ok({ log: mapLog(readLog(ctx, row.id) as MaintenanceRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'asset_maintenance_log_cancel', run);
  }
  return run();
}

export function assetMaintenanceLogGet(ctx: WorkspaceContext, input: { id?: string }): Result {
  if (typeof input.id !== 'string' || input.id.length === 0) return err('invalid_input', { field: 'id' });
  const row = readLog(ctx, input.id);
  if (row === undefined) return err('not_found', { id: input.id });
  return ok({ log: mapLog(row) });
}

export interface ListMaintenanceLogInput {
  assetId?: string;
  maintenanceType?: string;
  status?: 'completed' | 'cancelled' | 'any';
  fromDate?: string;
  toDate?: string;
  hasCost?: boolean;
  performedByUserId?: string;
  search?: string;
  /** G00 saved-view seam: accepted so a saved view can carry the maintenance list's filters. */
  savedViewId?: string;
}

export function assetMaintenanceLogList(ctx: WorkspaceContext, input: ListMaintenanceLogInput = {}): Result {
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];

  if (typeof input.assetId === 'string' && input.assetId.length > 0) {
    clauses.push('asset_id = ?');
    params.push(input.assetId);
  }
  if (typeof input.maintenanceType === 'string' && input.maintenanceType.length > 0) {
    clauses.push('maintenance_type = ?');
    params.push(input.maintenanceType);
  }
  // Default is completed only; 'any' includes cancelled, 'cancelled' filters to cancelled.
  const status = input.status ?? 'completed';
  if (status === 'completed' || status === 'cancelled') {
    clauses.push('status = ?');
    params.push(status);
  }
  if (typeof input.fromDate === 'string' && ISO_DATE.test(input.fromDate)) {
    clauses.push('log_date >= ?');
    params.push(input.fromDate);
  }
  if (typeof input.toDate === 'string' && ISO_DATE.test(input.toDate)) {
    clauses.push('log_date <= ?');
    params.push(input.toDate);
  }
  if (input.hasCost === true) clauses.push('cost_rappen IS NOT NULL');
  else if (input.hasCost === false) clauses.push('cost_rappen IS NULL');
  if (typeof input.performedByUserId === 'string' && input.performedByUserId.length > 0) {
    clauses.push('performed_by_user_id = ?');
    params.push(input.performedByUserId);
  }
  if (typeof input.search === 'string' && input.search.trim().length > 0) {
    clauses.push('(lower(title) LIKE ? OR lower(description) LIKE ? OR lower(external_party) LIKE ? OR lower(external_reference) LIKE ?)');
    const like = `%${input.search.trim().toLowerCase()}%`;
    params.push(like, like, like, like);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM asset_maintenance_log WHERE ${clauses.join(' AND ')} ORDER BY log_date DESC, created_at DESC, id DESC`,
    )
    .all(...params) as MaintenanceRow[];

  // The completed-cost roll-up (spec §2/US-H08.1, §7 tripwire): the SUM of cost_rappen over the
  // COMPLETED entries in the returned set, so the header total never counts a cancelled or null cost.
  const totalCostRappen = rows.reduce(
    (acc, r) => acc + (r.status === 'completed' && r.cost_rappen !== null ? r.cost_rappen : 0),
    0,
  );

  return ok({ items: rows.map(mapLog), total: rows.length, totalCostRappen });
}

/** Empty string collapses to null (a cleared optional), an id/text trims through, absent stays null. */
function normaliseText(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s.length === 0 ? null : s;
}
