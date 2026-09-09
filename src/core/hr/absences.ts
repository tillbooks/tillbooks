/**
 * E02, absences (US-E02.2). Record vacation / sick / other, cancel by status flip, list self-scoped.
 *
 * Writes gate on `hr.manage`. The list gates on `hr.read` at the boundary and then SELF-SCOPES:
 * without `hr.manage` the caller receives only their own linked employee's rows, because sick leave
 * is health data (revDSG Art. 5 lit. c Ziff. 2) and a colleague's absence existing at all is itself
 * the sensitive fact. An overlapping absence is ACCEPTED with an `overlap:true` warning (real life
 * overlaps: a half-day sick during vacation), never silently merged.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString, requireDate, optionalText } from '../ledger/inputGuards.js';
import { applySavedView } from '../customization/views.js';
import { isAbsenceKind } from './enums.js';
import { holds, ownEmployeeId } from './reads.js';
import type { AbsenceRow } from './reads.js';

export interface AbsenceRecordInput {
  employeeId: string;
  kind: string;
  fromDate: string;
  toDate: string;
  notes?: string;
  idempotencyKey: string;
}

function employeeExists(ctx: WorkspaceContext, employeeId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT id FROM employee WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, employeeId) as { id: string } | undefined;
  return row !== undefined;
}

/** Does this range intersect an existing recorded absence for the same employee? */
function overlaps(ctx: WorkspaceContext, employeeId: string, from: string, to: string): boolean {
  const row = ctx.store.db
    .prepare(
      `SELECT 1 AS hit FROM absence
        WHERE workspace_id = ? AND employee_id = ? AND status = 'recorded'
          AND from_date <= ? AND to_date >= ?
        LIMIT 1`,
    )
    .get(ctx.workspaceId, employeeId, to, from) as { hit: number } | undefined;
  return row !== undefined;
}

export function recordAbsence(ctx: WorkspaceContext, input: AbsenceRecordInput): Result {
  const capable = ctx.capabilities.assert('hr.manage');
  if (!capable.ok) return capable;

  const guard =
    requireString(input.employeeId, 'employeeId') ??
    requireDate(input.fromDate, 'fromDate') ??
    requireDate(input.toDate, 'toDate') ??
    optionalText(input.notes, 'notes') ??
    requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!isAbsenceKind(input.kind)) return err('invalid_kind', { field: 'kind', value: input.kind });
  if (input.fromDate > input.toDate) return err('invalid_dates', { fromDate: input.fromDate, toDate: input.toDate });
  // §H-TENANT: an unknown or foreign employee gets the same answer.
  if (!employeeExists(ctx, input.employeeId)) return err('not_found', { employeeId: input.employeeId });

  const scopedKey = JSON.stringify(['hr_absence_record', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'hr_absence_record');
  if (replayed !== undefined) return replayed;
  const holder = ctx.store.db
    .prepare('SELECT id FROM absence WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, input.idempotencyKey) as { id: string } | undefined;
  if (holder !== undefined) {
    return err('idempotency_key_conflict', { idempotencyKey: input.idempotencyKey, absenceId: holder.id });
  }

  const overlap = overlaps(ctx, input.employeeId, input.fromDate, input.toDate);
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'hr_absence_record', () => {
    const id = ctx.ids.next('abs');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO absence (id, workspace_id, employee_id, kind, from_date, to_date, status, notes,
                              idempotency_key, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'recorded', ?, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, input.employeeId, input.kind, input.fromDate, input.toDate, input.notes ?? null, input.idempotencyKey, ctx.actor, now);
    ctx.audit.record({ entityKind: 'absence', entityId: id, action: 'create', actor: ctx.actor, at: now });
    return ok({ absenceId: id, overlap, absence: absenceEcho(readAbsence(ctx, id) as AbsenceRow) });
  });
}

export interface AbsenceCancelInput {
  absenceId: string;
  idempotencyKey: string;
}

function readAbsence(ctx: WorkspaceContext, id: string): AbsenceRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM absence WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as AbsenceRow | undefined;
}

function absenceEcho(row: AbsenceRow): Record<string, unknown> {
  return {
    id: row.id,
    employeeId: row.employee_id,
    kind: row.kind,
    fromDate: row.from_date,
    toDate: row.to_date,
    status: row.status,
    notes: row.notes,
  };
}

export function cancelAbsence(ctx: WorkspaceContext, input: AbsenceCancelInput): Result {
  const capable = ctx.capabilities.assert('hr.manage');
  if (!capable.ok) return capable;
  const guard = requireString(input.absenceId, 'absenceId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['hr_absence_cancel', input.absenceId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'hr_absence_cancel');
  if (replayed !== undefined) return replayed;

  const row = readAbsence(ctx, input.absenceId);
  if (row === undefined) return err('not_found', { absenceId: input.absenceId });
  if (row.status === 'cancelled') return ok({ absenceId: row.id, absence: absenceEcho(row) });

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'hr_absence_cancel', () => {
    const now = ctx.clock.now();
    ctx.store.db.prepare("UPDATE absence SET status = 'cancelled' WHERE workspace_id = ? AND id = ?").run(ctx.workspaceId, row.id);
    ctx.audit.record({ entityKind: 'absence', entityId: row.id, action: 'cancel', actor: ctx.actor, at: now });
    return ok({ absenceId: row.id, absence: absenceEcho({ ...row, status: 'cancelled' }) });
  });
}

export interface AbsenceListInput {
  employeeId?: string;
  from?: string;
  to?: string;
  savedViewId?: string;
}

export function listAbsences(ctx: WorkspaceContext, input: AbsenceListInput): Result {
  // The G00 saved-view seam merges a stored `absence` view's filters under the explicit ones. The
  // self-scoping filter is applied AFTER, so a view can only ever NARROW to the caller's own rows,
  // never widen (spec §5: self-scope binds before any view filter).
  const viewed = applySavedView(ctx, 'absence', {
    ...(input.employeeId !== undefined ? { employeeId: input.employeeId } : {}),
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
    ...(input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {}),
  });
  if (!viewed.ok) return viewed;
  const merged = viewed.filter as { employeeId?: string; from?: string; to?: string };

  const full = holds(ctx, 'hr.manage');
  let scopedEmployee: string | null | undefined;
  if (full) {
    scopedEmployee = merged.employeeId ?? undefined;
  } else {
    const own = ownEmployeeId(ctx);
    if (own === null) return ok({ absences: [], selfScoped: true });
    if (merged.employeeId !== undefined && merged.employeeId !== own) return ok({ absences: [], selfScoped: true });
    scopedEmployee = own;
  }

  const clauses: string[] = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (scopedEmployee !== undefined) {
    clauses.push('employee_id = ?');
    params.push(scopedEmployee);
  }
  if (typeof merged.from === 'string') {
    clauses.push('to_date >= ?');
    params.push(merged.from);
  }
  if (typeof merged.to === 'string') {
    clauses.push('from_date <= ?');
    params.push(merged.to);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM absence WHERE ${clauses.join(' AND ')} ORDER BY from_date DESC, id`)
    .all(...params) as AbsenceRow[];
  return ok({ absences: rows.map(absenceEcho), selfScoped: !full });
}
