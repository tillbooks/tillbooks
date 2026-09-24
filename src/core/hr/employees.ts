/**
 * E02, employees (US-E02.1). Add or edit a person, record their `employment_pct`, and gate the AHV
 * number behind `hr.sensitive` at write AND at read (AHVG Art. 50e, revDSG Art. 6).
 *
 * WHO MAY DO WHAT. `hr.manage` gates every write; writing `ahv_nr` additionally requires
 * `hr.sensitive`, so a bookkeeper with `hr.manage` can maintain the roster but never touch the AHV
 * number. Reads gate on `hr.read` at the boundary and mask the AHV unless the caller passed
 * `includeSensitive` and holds `hr.sensitive`. `ahv_nr` is optional (data minimisation): it is only
 * captured for the external payroll hand-off (A34), never invented here.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString, optionalDate, optionalText, optionalId } from '../ledger/inputGuards.js';
import { applySavedView } from '../customization/views.js';
import { readEmployeeRow, employeeEcho, holds } from './reads.js';
import type { EmployeeRow } from './reads.js';

export interface EmployeeInput {
  id?: string;
  contactId?: string | null;
  actorRef?: string | null;
  firstName?: string;
  lastName?: string;
  ahvNr?: string | null;
  employmentPct?: number;
  startsOn?: string;
  endsOn?: string | null;
}

export interface EmployeeUpsertInput {
  employee: EmployeeInput;
  idempotencyKey: string;
}

function validPct(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 100;
}

/** §H-TENANT: a contact named as a link must belong to THIS workspace, else the link is refused. */
function contactExists(ctx: WorkspaceContext, contactId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT id FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId) as { id: string } | undefined;
  return row !== undefined;
}

export function upsertEmployee(ctx: WorkspaceContext, input: EmployeeUpsertInput): Result {
  const capable = ctx.capabilities.assert('hr.manage');
  if (!capable.ok) return capable;

  const guard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const emp = input.employee ?? {};

  // The AHV write gate is checked BEFORE any write (tx-atomicity): naming an AHV number without
  // `hr.sensitive` is refused outright, never written-then-rejected.
  const writingAhv = emp.ahvNr !== undefined && emp.ahvNr !== null && emp.ahvNr !== '';
  if (writingAhv) {
    const sensitive = ctx.capabilities.assert('hr.sensitive');
    if (!sensitive.ok) return err('forbidden', { field: 'ahvNr', capability: 'hr.sensitive' });
  }

  const existing = emp.id !== undefined ? readEmployeeRow(ctx, emp.id) : undefined;
  if (emp.id !== undefined && existing === undefined) {
    return err('not_found', { employeeId: emp.id });
  }

  const firstName = emp.firstName ?? existing?.first_name;
  const lastName = emp.lastName ?? existing?.last_name;
  const pct = emp.employmentPct ?? existing?.employment_pct;
  const startsOn = emp.startsOn ?? existing?.starts_on;
  const endsOn = emp.endsOn !== undefined ? emp.endsOn : (existing?.ends_on ?? null);

  const shapeGuard =
    requireString(firstName, 'firstName') ??
    requireString(lastName, 'lastName') ??
    requireString(startsOn, 'startsOn') ??
    optionalDate(startsOn, 'startsOn') ??
    optionalDate(endsOn ?? undefined, 'endsOn') ??
    optionalText(emp.actorRef ?? undefined, 'actorRef') ??
    optionalId(emp.contactId ?? undefined, 'contactId');
  if (shapeGuard) return shapeGuard;
  if (!validPct(pct)) return err('invalid_pct', { field: 'employmentPct', value: pct });
  if (endsOn !== null && typeof endsOn === 'string' && (startsOn as string) > endsOn) {
    return err('invalid_dates', { startsOn, endsOn });
  }
  if (emp.contactId !== undefined && emp.contactId !== null && !contactExists(ctx, emp.contactId)) {
    return err('invalid_reference', { field: 'contactId' });
  }

  const scopedKey = JSON.stringify(['hr_employee_upsert', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'hr_employee_upsert');
  if (replayed !== undefined) return replayed;

  // A create must not reuse a key that already minted a DIFFERENT employee (the A17 holder check).
  if (existing === undefined) {
    const holder = ctx.store.db
      .prepare('SELECT id FROM employee WHERE workspace_id = ? AND idempotency_key = ?')
      .get(ctx.workspaceId, input.idempotencyKey) as { id: string } | undefined;
    if (holder !== undefined) {
      return err('idempotency_key_conflict', { idempotencyKey: input.idempotencyKey, employeeId: holder.id });
    }
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'hr_employee_upsert', () => {
    const now = ctx.clock.now();
    if (existing === undefined) {
      const id = ctx.ids.next('emp');
      ctx.store.db
        .prepare(
          `INSERT INTO employee
             (id, workspace_id, contact_id, actor_ref, first_name, last_name, ahv_nr, employment_pct,
              starts_on, ends_on, archived, idempotency_key, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          id,
          ctx.workspaceId,
          emp.contactId ?? null,
          emp.actorRef ?? null,
          firstName,
          lastName,
          writingAhv ? emp.ahvNr : null,
          pct,
          startsOn,
          endsOn,
          input.idempotencyKey,
          ctx.actor,
          now,
          now,
        );
      ctx.audit.record({ entityKind: 'employee', entityId: id, action: 'create', actor: ctx.actor, at: now });
      return ok({ employeeId: id, employee: employeeEcho(readEmployeeRow(ctx, id) as EmployeeRow, writingAhv) });
    }

    // An update never clears the AHV number implicitly: it is written only when the caller supplied a
    // non-empty one under `hr.sensitive`, and otherwise the stored value is kept verbatim.
    ctx.store.db
      .prepare(
        `UPDATE employee
            SET contact_id = ?, actor_ref = ?, first_name = ?, last_name = ?, ahv_nr = ?,
                employment_pct = ?, starts_on = ?, ends_on = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        emp.contactId !== undefined ? emp.contactId : existing.contact_id,
        emp.actorRef !== undefined ? emp.actorRef : existing.actor_ref,
        firstName,
        lastName,
        writingAhv ? emp.ahvNr : existing.ahv_nr,
        pct,
        startsOn,
        endsOn,
        now,
        ctx.workspaceId,
        existing.id,
      );
    ctx.audit.record({ entityKind: 'employee', entityId: existing.id, action: 'update', actor: ctx.actor, at: now });
    return ok({ employeeId: existing.id, employee: employeeEcho(readEmployeeRow(ctx, existing.id) as EmployeeRow, writingAhv) });
  });
}

export interface EmployeeGetInput {
  employeeId: string;
  includeSensitive?: boolean;
}

/** The AHV number is revealed only when the caller ASKS for it and HOLDS `hr.sensitive`. */
function revealAhv(ctx: WorkspaceContext, includeSensitive: boolean | undefined): boolean {
  return includeSensitive === true && holds(ctx, 'hr.sensitive');
}

export function getEmployee(ctx: WorkspaceContext, input: EmployeeGetInput): Result {
  const guard = requireString(input.employeeId, 'employeeId');
  if (guard) return guard;
  const row = readEmployeeRow(ctx, input.employeeId);
  if (row === undefined) return err('not_found', { employeeId: input.employeeId });
  return ok({ employee: employeeEcho(row, revealAhv(ctx, input.includeSensitive)) });
}

export interface EmployeeListInput {
  includeSensitive?: boolean;
  includeArchived?: boolean;
  savedViewId?: string;
}

export function listEmployees(ctx: WorkspaceContext, input: EmployeeListInput): Result {
  // The G00 saved-view seam (OP10): a stored `employee` view (e.g. "Aktive Mitarbeitende") merges its
  // filters UNDERNEATH any named explicitly here. It never touches the AHV gate: masking is by
  // capability, not by view.
  const viewed = applySavedView(ctx, 'employee', {
    ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
    ...(input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {}),
  });
  if (!viewed.ok) return viewed;
  const f = viewed.filter as { includeArchived?: boolean };
  const reveal = revealAhv(ctx, input.includeSensitive);
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM employee WHERE workspace_id = ?
        ${f.includeArchived ? '' : 'AND archived = 0'}
        ORDER BY last_name, first_name`,
    )
    .all(ctx.workspaceId) as EmployeeRow[];
  return ok({ employees: rows.map((r) => employeeEcho(r, reveal)) });
}
