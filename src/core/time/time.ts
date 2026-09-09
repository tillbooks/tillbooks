/**
 * B01, time tracking: timers, timesheets and the submit/approve/lock lifecycle over `time_entry`.
 *
 * NO POSTING PATH EXISTS HERE, structurally (P3): time is pre-financial. Nothing in this directory
 * imports `postEntry` or `recordPayment`, and `test/time/no-money-path.test.mjs` greps that this
 * sentence stays true. The entry's money is a SNAPSHOT of the resolved rate (OP1), never a booked
 * figure; B02 turns approved time into invoice lines and is the only writer of `billed`.
 *
 * Columns are snake_case, the verb surface is camelCase, and the two meet only in `mapTimeEntry`.
 * Every query stamps `workspace_id` (§H-TENANT); every write takes an idempotencyKey and keeps all
 * state-dependent work inside the `run` closure (§H-IDEMPOTENT, the B00 `setProjectStatus` shape).
 * The status machine is the §H-ENUM chain `open→submitted→approved→locked→billed` (`enums.ts`);
 * `time_update`/`time_delete` stop at approval, and B01's own verbs advance no further than
 * `locked`.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { applySavedView } from '../customization/views.js';
import { readProject } from '../projects/projects.js';
import { EDITABLE_TIME_STATUSES, isTimeStatus, TIME_STATUSES } from './enums.js';
import type { TimeStatus } from './enums.js';
import { findRate } from './rates.js';
import type { ResolvedRate } from './rates.js';

export interface TimeEntryRow {
  id: string;
  workspace_id: string;
  user_id: string;
  project_id: string;
  phase_id: string | null;
  started_at: string;
  ended_at: string | null;
  minutes: number | null;
  billable: number;
  notes: string | null;
  status: string;
  rate_minor: number;
  rate_currency: string;
  rate_scope: string;
  rate_card_id: string;
  cost_rate_minor: number | null;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
}

export function mapTimeEntry(row: TimeEntryRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    projectId: row.project_id,
    phaseId: row.phase_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    minutes: row.minutes,
    billable: row.billable === 1,
    notes: row.notes,
    status: row.status,
    rateMinor: row.rate_minor,
    rateCurrency: row.rate_currency,
    rateScope: row.rate_scope,
    rateCardId: row.rate_card_id,
    costRateMinor: row.cost_rate_minor,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    lockedAt: row.locked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readTimeEntry(ctx: WorkspaceContext, entryId: string): TimeEntryRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM time_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, entryId) as TimeEntryRow | undefined;
}

/** An ISO instant or day, stored as given; ordering works because ISO-8601 sorts lexically. */
function isInstantOrDay(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 10) return false;
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  return !Number.isNaN(Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value));
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The spec's manual-entry bound: a day has 1440 minutes and zero work is not an entry. */
function isValidMinutes(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 1440;
}

/**
 * The capture-time snapshot (OP1): resolve through the project's client so a client card wins over
 * a project card, and refuse to mint an entry with no defined rate (US-B01.5: never a silent 0).
 */
function snapshotRate(
  ctx: WorkspaceContext,
  project: { id: string; contact_id: string },
  userId: string,
  atDay: string,
): ResolvedRate | null {
  return findRate(ctx, { userId, projectId: project.id, contactId: project.contact_id }, atDay);
}

/** A phase must exist, in this tenant, on THIS project: a cross-project phase is a filing error. */
function phaseBelongs(ctx: WorkspaceContext, phaseId: string, projectId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT id FROM project_phase WHERE workspace_id = ? AND id = ? AND project_id = ?')
    .get(ctx.workspaceId, phaseId, projectId) as { id: string } | undefined;
  return row !== undefined;
}

export interface TimeStartInput {
  userId?: string;
  projectId?: string;
  phaseId?: string;
  notes?: string;
  billable?: boolean;
  idempotencyKey?: string;
}

export function timeStart(ctx: WorkspaceContext, input: TimeStartInput): Result {
  if (typeof input.userId !== 'string' || input.userId.length === 0) return err('invalid_input', { field: 'userId' });
  if (typeof input.projectId !== 'string' || input.projectId.length === 0) {
    return err('invalid_input', { field: 'projectId' });
  }
  if (input.billable !== undefined && typeof input.billable !== 'boolean') {
    return err('invalid_input', { field: 'billable' });
  }

  const run = (): Result => {
    const project = readProject(ctx, input.projectId as string);
    if (project === undefined) return err('project_not_found', { projectId: input.projectId });
    if (input.phaseId !== undefined && !phaseBelongs(ctx, input.phaseId, project.id)) {
      return err('phase_not_found', { phaseId: input.phaseId, projectId: project.id });
    }

    // ONE running timer per user (US-B01.1): a running row is `ended_at IS NULL`.
    const running = ctx.store.db
      .prepare('SELECT id FROM time_entry WHERE workspace_id = ? AND user_id = ? AND ended_at IS NULL LIMIT 1')
      .get(ctx.workspaceId, input.userId) as { id: string } | undefined;
    if (running !== undefined) return err('timer_already_running', { entryId: running.id });

    const now = ctx.clock.now();
    const rate = snapshotRate(ctx, project, input.userId as string, now.slice(0, 10));
    if (rate === null) return err('no_rate_defined', { at: now.slice(0, 10) });

    const id = ctx.ids.next('time_entry');
    ctx.store.db
      .prepare(
        `INSERT INTO time_entry (
           id, workspace_id, user_id, project_id, phase_id, started_at, ended_at, minutes, billable,
           notes, status, rate_minor, rate_currency, rate_scope, rate_card_id, cost_rate_minor, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.userId,
        project.id,
        input.phaseId ?? null,
        now,
        input.billable === false ? 0 : 1,
        input.notes ?? null,
        rate.rateMinor,
        rate.currency,
        rate.sourceScope,
        rate.rateCardId,
        rate.costRateMinor,
        now,
        now,
      );
    return ok({ entry: mapTimeEntry(readTimeEntry(ctx, id) as TimeEntryRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'time_start', run);
  }
  return run();
}

export function timeStop(ctx: WorkspaceContext, input: { entryId?: string; idempotencyKey?: string }): Result {
  if (typeof input.entryId !== 'string' || input.entryId.length === 0) return err('invalid_input', { field: 'entryId' });

  const run = (): Result => {
    const entry = readTimeEntry(ctx, input.entryId as string);
    if (entry === undefined) return err('entry_not_found', { entryId: input.entryId });
    if (entry.ended_at !== null) return err('timer_not_running', { entryId: entry.id });

    const now = ctx.clock.now();
    // The full elapsed interval, midnight crossings included (US-B01.1 boundary); a sub-minute
    // stop records 1, because a captured moment of work is not zero work.
    const elapsedMs = Date.parse(now) - Date.parse(entry.started_at);
    if (Number.isNaN(elapsedMs) || elapsedMs < 0) return err('invalid_input', { field: 'entryId', reason: 'clock_before_start' });
    const minutes = Math.max(1, Math.round(elapsedMs / 60000));

    ctx.store.db
      .prepare('UPDATE time_entry SET ended_at = ?, minutes = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(now, minutes, now, ctx.workspaceId, entry.id);
    return ok({ entry: mapTimeEntry(readTimeEntry(ctx, entry.id) as TimeEntryRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'time_stop', run);
  }
  return run();
}

export interface TimeLogInput {
  userId?: string;
  projectId?: string;
  phaseId?: string;
  startedAt?: string;
  minutes?: number;
  billable?: boolean;
  notes?: string;
  idempotencyKey?: string;
}

export function timeLog(ctx: WorkspaceContext, input: TimeLogInput): Result {
  if (typeof input.userId !== 'string' || input.userId.length === 0) return err('invalid_input', { field: 'userId' });
  if (typeof input.projectId !== 'string' || input.projectId.length === 0) {
    return err('invalid_input', { field: 'projectId' });
  }
  if (!isInstantOrDay(input.startedAt)) return err('invalid_input', { field: 'startedAt' });
  if (!isValidMinutes(input.minutes)) return err('invalid_minutes', { minutes: input.minutes });
  if (input.billable !== undefined && typeof input.billable !== 'boolean') {
    return err('invalid_input', { field: 'billable' });
  }
  const startedAt = input.startedAt;
  const minutes = input.minutes;

  const run = (): Result => {
    const project = readProject(ctx, input.projectId as string);
    if (project === undefined) return err('project_not_found', { projectId: input.projectId });
    if (input.phaseId !== undefined && !phaseBelongs(ctx, input.phaseId, project.id)) {
      return err('phase_not_found', { phaseId: input.phaseId, projectId: project.id });
    }

    // The snapshot resolves at the entry's OWN day, so back-logged work prices at the rate that
    // governed when it happened, not at today's (OP1).
    const rate = snapshotRate(ctx, project, input.userId as string, startedAt.slice(0, 10));
    if (rate === null) return err('no_rate_defined', { at: startedAt.slice(0, 10) });

    const endedAt = new Date(
      Date.parse(startedAt.length === 10 ? `${startedAt}T00:00:00Z` : startedAt) + minutes * 60000,
    ).toISOString();
    const id = ctx.ids.next('time_entry');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO time_entry (
           id, workspace_id, user_id, project_id, phase_id, started_at, ended_at, minutes, billable,
           notes, status, rate_minor, rate_currency, rate_scope, rate_card_id, cost_rate_minor, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.userId,
        project.id,
        input.phaseId ?? null,
        startedAt,
        endedAt,
        minutes,
        input.billable === false ? 0 : 1,
        input.notes ?? null,
        rate.rateMinor,
        rate.currency,
        rate.sourceScope,
        rate.rateCardId,
        rate.costRateMinor,
        now,
        now,
      );
    return ok({ entry: mapTimeEntry(readTimeEntry(ctx, id) as TimeEntryRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'time_log', run);
  }
  return run();
}

export interface TimeEntryPatch {
  minutes?: number;
  billable?: boolean;
  notes?: string | null;
  startedAt?: string;
  projectId?: string;
  phaseId?: string | null;
}

export function timeUpdate(
  ctx: WorkspaceContext,
  input: { entryId?: string; patch?: TimeEntryPatch; idempotencyKey?: string },
): Result {
  if (typeof input.entryId !== 'string' || input.entryId.length === 0) return err('invalid_input', { field: 'entryId' });

  const run = (): Result => {
    const entry = readTimeEntry(ctx, input.entryId as string);
    if (entry === undefined) return err('entry_not_found', { entryId: input.entryId });
    if (!(EDITABLE_TIME_STATUSES as readonly string[]).includes(entry.status)) {
      return err('entry_locked', { entryId: entry.id, status: entry.status });
    }
    if (entry.ended_at === null) return err('timer_still_running', { entryId: entry.id });

    const patch = input.patch ?? {};
    if (patch.minutes !== undefined && !isValidMinutes(patch.minutes)) {
      return err('invalid_minutes', { minutes: patch.minutes });
    }
    if (patch.billable !== undefined && typeof patch.billable !== 'boolean') {
      return err('invalid_input', { field: 'billable' });
    }
    if (patch.startedAt !== undefined && !isInstantOrDay(patch.startedAt)) {
      return err('invalid_input', { field: 'startedAt' });
    }

    let projectId = entry.project_id;
    let rateMinor = entry.rate_minor;
    let rateCurrency = entry.rate_currency;
    let rateScope = entry.rate_scope;
    let rateCardId = entry.rate_card_id;
    let costRateMinor = entry.cost_rate_minor;
    const startedAt = patch.startedAt ?? entry.started_at;

    if (patch.projectId !== undefined && patch.projectId !== entry.project_id) {
      const project = readProject(ctx, patch.projectId);
      if (project === undefined) return err('project_not_found', { projectId: patch.projectId });
      projectId = project.id;
      // Re-pointing an entry at another project re-resolves the snapshot at the entry's own capture
      // day: an explicit user act, not a silent reprice (spec §4, reconciled). The snapshot rule
      // that stays absolute is "a later CARD edit never moves a captured rate".
      const rate = snapshotRate(ctx, project, entry.user_id, startedAt.slice(0, 10));
      if (rate === null) return err('no_rate_defined', { at: startedAt.slice(0, 10) });
      rateMinor = rate.rateMinor;
      rateCurrency = rate.currency;
      rateScope = rate.sourceScope;
      rateCardId = rate.rateCardId;
      costRateMinor = rate.costRateMinor;
    }

    const phaseId = patch.phaseId !== undefined ? patch.phaseId : entry.phase_id;
    if (phaseId !== null && (patch.phaseId !== undefined || projectId !== entry.project_id)) {
      if (!phaseBelongs(ctx, phaseId, projectId)) return err('phase_not_found', { phaseId, projectId });
    }

    const minutes = patch.minutes ?? (entry.minutes as number);
    const endedAt = new Date(
      Date.parse(startedAt.length === 10 ? `${startedAt}T00:00:00Z` : startedAt) + minutes * 60000,
    ).toISOString();

    ctx.store.db
      .prepare(
        `UPDATE time_entry SET
           project_id = ?, phase_id = ?, started_at = ?, ended_at = ?, minutes = ?, billable = ?,
           notes = ?, rate_minor = ?, rate_currency = ?, rate_scope = ?, rate_card_id = ?, cost_rate_minor = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        projectId,
        phaseId,
        startedAt,
        endedAt,
        minutes,
        (patch.billable !== undefined ? patch.billable : entry.billable === 1) ? 1 : 0,
        patch.notes !== undefined ? patch.notes : entry.notes,
        rateMinor,
        rateCurrency,
        rateScope,
        rateCardId,
        costRateMinor,
        ctx.clock.now(),
        ctx.workspaceId,
        entry.id,
      );
    return ok({ entry: mapTimeEntry(readTimeEntry(ctx, entry.id) as TimeEntryRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'time_update', run);
  }
  return run();
}

export function timeDelete(ctx: WorkspaceContext, input: { entryId?: string; idempotencyKey?: string }): Result {
  if (typeof input.entryId !== 'string' || input.entryId.length === 0) return err('invalid_input', { field: 'entryId' });

  const run = (): Result => {
    const entry = readTimeEntry(ctx, input.entryId as string);
    if (entry === undefined) return err('entry_not_found', { entryId: input.entryId });
    if (!(EDITABLE_TIME_STATUSES as readonly string[]).includes(entry.status)) {
      return err('entry_locked', { entryId: entry.id, status: entry.status });
    }
    ctx.store.db.prepare('DELETE FROM time_entry WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, entry.id);
    return ok({ entryId: entry.id, deleted: true });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'time_delete', run);
  }
  return run();
}

/** The rows of one period ('YYYY-MM'), optionally cut to one project, in one status. */
function periodRows(
  ctx: WorkspaceContext,
  period: string,
  projectId: string | undefined,
  status: TimeStatus,
): TimeEntryRow[] {
  const clauses = ['workspace_id = ?', 'status = ?', "substr(started_at, 1, 7) = ?"];
  const params: string[] = [ctx.workspaceId, status, period];
  if (projectId !== undefined) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  return ctx.store.db
    .prepare(`SELECT * FROM time_entry WHERE ${clauses.join(' AND ')} ORDER BY started_at, id`)
    .all(...params) as TimeEntryRow[];
}

export interface TimePeriodInput {
  period?: string;
  projectId?: string;
  idempotencyKey?: string;
}

export function timeSubmit(ctx: WorkspaceContext, input: TimePeriodInput): Result {
  if (typeof input.period !== 'string' || !PERIOD_RE.test(input.period)) {
    return err('invalid_input', { field: 'period', expected: 'YYYY-MM' });
  }
  const period = input.period;

  const run = (): Result => {
    if (input.projectId !== undefined && readProject(ctx, input.projectId) === undefined) {
      return err('project_not_found', { projectId: input.projectId });
    }
    const rows = periodRows(ctx, period, input.projectId, 'open').filter((r) => r.ended_at !== null);
    if (rows.length === 0) return err('nothing_to_submit', { period });

    const now = ctx.clock.now();
    return ctx.store.tx(() => {
      for (const row of rows) {
        ctx.store.db
          .prepare("UPDATE time_entry SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
          .run(now, now, ctx.workspaceId, row.id);
      }
      return ok({ period, submittedCount: rows.length, entryIds: rows.map((r) => r.id) });
    });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'time_submit', run);
  }
  return run();
}

export function timeApprove(ctx: WorkspaceContext, input: { entryIds?: unknown; idempotencyKey?: string }): Result {
  if (!Array.isArray(input.entryIds) || input.entryIds.length === 0 || input.entryIds.some((e) => typeof e !== 'string' || e.length === 0)) {
    return err('invalid_input', { field: 'entryIds' });
  }
  const entryIds = [...new Set(input.entryIds as string[])];

  const run = (): Result => {
    const rows: TimeEntryRow[] = [];
    for (const entryId of entryIds) {
      const row = readTimeEntry(ctx, entryId);
      if (row === undefined) return err('entry_not_found', { entryId });
      if (row.status !== 'submitted') return err('invalid_transition', { entryId, from: row.status, to: 'approved' });
      rows.push(row);
    }
    const now = ctx.clock.now();
    return ctx.store.tx(() => {
      for (const row of rows) {
        ctx.store.db
          .prepare("UPDATE time_entry SET status = 'approved', approved_at = ?, approved_by = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
          .run(now, ctx.actor, now, ctx.workspaceId, row.id);
      }
      // `approvalRef` is the automation occurrence key (G01 resolves ONE string id per firing):
      // deterministic over the approved SET, so a replay is the same occurrence.
      return ok({
        approvedEntryIds: rows.map((r) => r.id),
        approvedCount: rows.length,
        approvalRef: [...rows.map((r) => r.id)].sort().join('+'),
      });
    });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'time_approve', run);
  }
  return run();
}

export function timeLock(ctx: WorkspaceContext, input: TimePeriodInput): Result {
  if (typeof input.period !== 'string' || !PERIOD_RE.test(input.period)) {
    return err('invalid_input', { field: 'period', expected: 'YYYY-MM' });
  }
  const period = input.period;

  const run = (): Result => {
    if (input.projectId !== undefined && readProject(ctx, input.projectId) === undefined) {
      return err('project_not_found', { projectId: input.projectId });
    }
    const rows = periodRows(ctx, period, input.projectId, 'approved');
    if (rows.length === 0) return err('nothing_to_lock', { period });

    const now = ctx.clock.now();
    return ctx.store.tx(() => {
      for (const row of rows) {
        ctx.store.db
          .prepare("UPDATE time_entry SET status = 'locked', locked_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
          .run(now, now, ctx.workspaceId, row.id);
      }
      return ok({ period, lockedCount: rows.length, entryIds: rows.map((r) => r.id) });
    });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'time_lock', run);
  }
  return run();
}

export interface TimeListFilter {
  projectId?: string;
  userId?: string;
  status?: string;
  billable?: boolean;
  unbilled?: boolean;
  from?: string;
  to?: string;
  savedViewId?: string;
}

/** Round-once (P2): one entry's derived value in its snapshot currency, computed at read only. */
export function entryValueMinor(minutes: number, rateMinor: number): number {
  return Math.round((minutes * rateMinor) / 60);
}

export function timeList(ctx: WorkspaceContext, filter: TimeListFilter = {}): Result {
  // The G00 seam, one unconditional call (the `listProjects` shape): stored filters merge UNDER the
  // caller's explicit ones, so an explicit filter always wins.
  const viewed = applySavedView(ctx, 'time_entry', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;

  if (filter.status !== undefined && !isTimeStatus(filter.status)) {
    return err('invalid_status', { status: filter.status, known: TIME_STATUSES });
  }
  if (filter.projectId !== undefined && readProject(ctx, filter.projectId) === undefined) {
    return err('project_not_found', { projectId: filter.projectId });
  }

  const clauses = ['workspace_id = ?'];
  const params: (string | number)[] = [ctx.workspaceId];
  if (filter.projectId !== undefined) {
    clauses.push('project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.userId !== undefined) {
    clauses.push('user_id = ?');
    params.push(filter.userId);
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.billable !== undefined) {
    clauses.push('billable = ?');
    params.push(filter.billable ? 1 : 0);
  }
  if (filter.unbilled === true) {
    clauses.push("status != 'billed'");
  }
  if (filter.from !== undefined) {
    clauses.push('started_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('started_at < ?');
    params.push(filter.to);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM time_entry WHERE ${clauses.join(' AND ')} ORDER BY started_at DESC, id DESC`)
    .all(...params) as TimeEntryRow[];

  let totalMinutes = 0;
  let billableMinor = 0;
  for (const row of rows) {
    if (row.minutes !== null) {
      totalMinutes += row.minutes;
      if (row.billable === 1) billableMinor += entryValueMinor(row.minutes, row.rate_minor);
    }
  }
  return ok({ entries: rows.map(mapTimeEntry), totalMinutes, billableMinor });
}
