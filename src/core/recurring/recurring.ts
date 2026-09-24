/**
 * A12, recurring invoices (Serienrechnungen): the schedule store and the tick.
 *
 * REBUILT UNDER D72 (spec §4b). The tick NEVER writes a document row and NEVER posts: it INVOKES the
 * registered `create_document` / `issue_invoice` through the shared action dispatch (the
 * `ActionInvoker`, G01's fire-path shape), as the schedule's AUTHOR, so numbering, posting, the A24
 * gate and the idempotency memo are the same code a hand-made invoice uses. What this module owns is
 * WHEN, WHETHER-TO-ISSUE, and the triangle protocol between three corners it does not all control:
 *
 *  1. the invoked verbs' idempotency memos (keys `recurring:<sid>:<period>` and
 *     `recurring_issue:<sid>:<period>`), which remember a document id FOREVER;
 *  2. this module's own run log, whose partial UNIQUE index is the row that makes a period settle
 *     at most once;
 *  3. the generated document's A10 lifecycle, in which a human may patch, hand-issue, or cancel
 *     (= hard-delete) the waiting draft at any time.
 *
 * The first build died twice on that seam (F5, F6). The rebuild's law, invariant I2: THE MEMO'S
 * ANSWER IS A FACT ABOUT THE PAST, NEVER A TEMPLATE FOR THE PRESENT. After every memoised create the
 * tick verifies the returned id against the store and lets the document's FATE settle the period:
 * gone means `discarded`-and-advance (the human discarded the period; F6's outage is
 * unrepresentable because no run row is ever written for a document that is not in the store at
 * that statement); issued (by anyone, ever) means `issued`-and-advance (F5's stranding and C14's
 * crash replay are one rule); still a draft means the occurrence continues its ordinary course.
 *
 * Invariant I3, containment: every schedule is guarded so a poisoned one reports `failed` in its own
 * results row while its siblings still bill, and a settle insert refused by the partial index is
 * read as "settled elsewhere" and CONVERGES by advancing, never by throwing.
 *
 * THE DUE-DATE LAW (C1b -> R1 -> R1b -> F4, one rule at three moments, spec §4b): the due date is
 * clock day + dueDays, stamped at draft creation and recorded as `due_stamped`; at A12's own issue
 * of an AGED draft it is re-asserted from the issue day ONLY when the draft still carries the
 * machine stamp, so a date a human negotiated on the waiting draft survives; and it never derives
 * from the caller's `asOf`, which is the catch-up cursor and nothing else.
 *
 * THE SUPPLY-DATE LAW (C1/C2/C9): every generated line carries its occurrence's own period as the
 * Leistungsdatum, stamped by the tick, which is the single writer of that field. The template
 * whitelist strips a smuggled `supplyDate` at store (create, patch and snapshot alike), and the
 * stamp is applied by CONSTRUCTION over whitelisted keys, so even a poisoned `lines_json` cannot
 * outvote it. ESTV: massgebend ist der Zeitpunkt der Leistungserbringung, so a catch-up bills each
 * period at ITS OWN VAT era.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { ActionInvoker } from '../automation/fire.js';
import { applySavedView } from '../customization/views.js';
import {
  CATCH_UP_CAP,
  isRecurringInterval,
  type RecurringInterval,
  type RunOutcome,
} from './enums.js';
import {
  addDays,
  dayOf,
  firstOccurrenceOnOrAfter,
  isIsoDate,
  nextOccurrenceAfter,
} from './dates.js';

// --- Row and input shapes ----------------------------------------------------------------------

interface ScheduleRow {
  id: string;
  workspace_id: string;
  name: string | null;
  contact_id: string;
  lines_json: string;
  currency: string | null;
  notes: string | null;
  due_days: number | null;
  interval: string;
  custom_days: number | null;
  anchor_date: string;
  next_run_date: string;
  end_date: string | null;
  max_occurrences: number | null;
  occurrences_done: number;
  auto_issue: number;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Present only on the list and get reads (correlated subqueries). */
  last_outcome?: string | null;
  last_error?: string | null;
  contact_name?: string | null;
}

/**
 * A template position. The WHITELIST is this interface: `normalizeTemplateLines` copies exactly
 * these keys and nothing else, so a `supplyDate` (or anything else the permissive boundary let
 * through) never reaches `lines_json` (critic probes C9, R2). The Leistungsdatum is an
 * occurrence-specific fact, never part of a reusable template; the tick stamps it per period.
 */
export interface RecurringLineInput {
  itemId?: string | null;
  description?: string | null;
  quantityMilli?: number;
  unitPriceMinor: number;
  taxCode?: string | null;
}

export interface CreateRecurringScheduleInput {
  name?: string;
  contactId?: string;
  lines?: RecurringLineInput[];
  templateDocumentId?: string;
  currency?: string;
  notes?: string;
  dueDays?: number;
  interval: string;
  customDays?: number;
  anchorDate: string;
  endDate?: string;
  maxOccurrences?: number;
  autoIssue?: boolean;
  idempotencyKey?: string;
}

export interface UpdateRecurringSchedulePatch {
  name?: string | null;
  contactId?: string;
  lines?: RecurringLineInput[];
  currency?: string | null;
  notes?: string | null;
  dueDays?: number | null;
  interval?: string;
  customDays?: number | null;
  anchorDate?: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
  autoIssue?: boolean;
}

// --- Mapping -----------------------------------------------------------------------------------

/**
 * The stored template, read DEFENSIVELY (critic X1c): no A12 verb can write an unparseable
 * `lines_json` (the whitelist stores through `JSON.stringify` on create, patch and snapshot alike),
 * but a corrupted row must cost its own schedule an empty template, never the whole workspace's
 * list read. The tick deliberately does NOT use this: there a corrupt template must FAIL the
 * occurrence (visibly, as a failed run row), not bill an empty invoice.
 */
function readTemplateLines(json: string): RecurringLineInput[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as RecurringLineInput[]) : [];
  } catch {
    return [];
  }
}

function mapSchedule(row: ScheduleRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    contactId: row.contact_id,
    lines: readTemplateLines(row.lines_json),
    currency: row.currency,
    notes: row.notes,
    dueDays: row.due_days,
    interval: row.interval,
    customDays: row.custom_days,
    anchorDate: row.anchor_date,
    nextRunDate: row.next_run_date,
    endDate: row.end_date,
    maxOccurrences: row.max_occurrences,
    occurrencesDone: row.occurrences_done,
    autoIssue: row.auto_issue === 1,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // The C5 repair, kept: a permanently failing schedule must be visible on the LIST a person
    // actually watches, not only in the detail history. Null (never absent) when the schedule has
    // not run, so a client can tell "never ran" from "not asked".
    ...(row.last_outcome !== undefined
      ? { lastOutcome: row.last_outcome ?? null, lastError: row.last_error ?? null }
      : {}),
    // Resolved for the list and detail reads so a client renders the customer without a second
    // request; null when the contact was since anonymised or removed.
    ...(row.contact_name !== undefined ? { contactName: row.contact_name ?? null } : {}),
  };
}

function readSchedule(ctx: WorkspaceContext, id: string): ScheduleRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM recurring_schedule WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as ScheduleRow | undefined;
}

// --- Template validation (the whitelist) -------------------------------------------------------

type NormalizedLines = { ok: true; lines: RecurringLineInput[] } | { ok: false; result: Result };

/**
 * Validate raw positions and copy them through the whitelist. Everything not on
 * `RecurringLineInput` is DROPPED, silently and deliberately: the boundary schema is permissive
 * (`additionalProperties: true` repo-wide), so stripping at store is the layer that holds.
 */
function normalizeTemplateLines(raw: unknown): NormalizedLines {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, result: err('needs_positions') };
  }
  const lines: RecurringLineInput[] = [];
  for (const [index, entry] of raw.entries()) {
    const position = index + 1;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, result: err('invalid_input', { field: 'lines', position }) };
    }
    const line = entry as Record<string, unknown>;
    if (!Number.isInteger(line.unitPriceMinor) || (line.unitPriceMinor as number) < 0) {
      return { ok: false, result: err('invalid_input', { field: 'unitPriceMinor', position }) };
    }
    if (line.quantityMilli !== undefined && line.quantityMilli !== null) {
      if (!Number.isInteger(line.quantityMilli) || (line.quantityMilli as number) <= 0) {
        return { ok: false, result: err('invalid_input', { field: 'quantityMilli', position }) };
      }
    }
    for (const field of ['itemId', 'description', 'taxCode'] as const) {
      if (line[field] !== undefined && line[field] !== null && typeof line[field] !== 'string') {
        return { ok: false, result: err('invalid_input', { field, position }) };
      }
    }
    const normalized: RecurringLineInput = { unitPriceMinor: line.unitPriceMinor as number };
    if (typeof line.itemId === 'string') normalized.itemId = line.itemId;
    if (typeof line.description === 'string') normalized.description = line.description;
    if (typeof line.quantityMilli === 'number') normalized.quantityMilli = line.quantityMilli;
    if (typeof line.taxCode === 'string') normalized.taxCode = line.taxCode;
    lines.push(normalized);
  }
  return { ok: true, lines };
}

/** §H-TENANT: the schedule's customer must exist in THIS workspace. */
function contactExists(ctx: WorkspaceContext, contactId: string): boolean {
  return (
    ctx.store.db
      .prepare('SELECT id FROM contact WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, contactId) !== undefined
  );
}

// --- Cadence validation ------------------------------------------------------------------------

interface CadenceFields {
  interval: RecurringInterval;
  customDays: number | null;
  anchorDate: string;
  endDate: string | null;
  dueDays: number | null;
  maxOccurrences: number | null;
}

/** Validate the cadence and bound fields as ONE effective set, so create and patch share one rule. */
function validateCadence(fields: {
  interval: unknown;
  customDays: unknown;
  anchorDate: unknown;
  endDate: unknown;
  dueDays: unknown;
  maxOccurrences: unknown;
}): { ok: true; cadence: CadenceFields } | { ok: false; result: Result } {
  if (!isRecurringInterval(fields.interval)) {
    return { ok: false, result: err('invalid_input', { field: 'interval' }) };
  }
  let customDays: number | null = null;
  if (fields.interval === 'custom') {
    if (!Number.isInteger(fields.customDays) || (fields.customDays as number) < 1) {
      return { ok: false, result: err('invalid_input', { field: 'customDays' }) };
    }
    customDays = fields.customDays as number;
  }
  if (!isIsoDate(fields.anchorDate)) {
    return { ok: false, result: err('invalid_input', { field: 'anchorDate' }) };
  }
  let endDate: string | null = null;
  if (fields.endDate !== undefined && fields.endDate !== null) {
    if (!isIsoDate(fields.endDate)) {
      return { ok: false, result: err('invalid_input', { field: 'endDate' }) };
    }
    // The C4 repair: an end date before the anchor is an impossible series, refused at create AND
    // on the patched pair, never accepted silently.
    if (fields.endDate < fields.anchorDate) {
      return {
        ok: false,
        result: err('end_before_anchor', { anchorDate: fields.anchorDate, endDate: fields.endDate }),
      };
    }
    endDate = fields.endDate;
  }
  let dueDays: number | null = null;
  if (fields.dueDays !== undefined && fields.dueDays !== null) {
    if (!Number.isInteger(fields.dueDays) || (fields.dueDays as number) < 0) {
      return { ok: false, result: err('invalid_input', { field: 'dueDays' }) };
    }
    dueDays = fields.dueDays as number;
  }
  let maxOccurrences: number | null = null;
  if (fields.maxOccurrences !== undefined && fields.maxOccurrences !== null) {
    if (!Number.isInteger(fields.maxOccurrences) || (fields.maxOccurrences as number) < 1) {
      return { ok: false, result: err('invalid_input', { field: 'maxOccurrences' }) };
    }
    maxOccurrences = fields.maxOccurrences as number;
  }
  return {
    ok: true,
    cadence: {
      interval: fields.interval,
      customDays,
      anchorDate: fields.anchorDate,
      endDate,
      dueDays,
      maxOccurrences,
    },
  };
}

// --- createRecurringSchedule -------------------------------------------------------------------

export function createRecurringSchedule(
  ctx: WorkspaceContext,
  input: CreateRecurringScheduleInput,
): Result {
  const cadence = validateCadence({
    interval: input.interval,
    customDays: input.customDays,
    anchorDate: input.anchorDate,
    endDate: input.endDate,
    dueDays: input.dueDays,
    maxOccurrences: input.maxOccurrences,
  });
  if (!cadence.ok) return cadence.result;

  // Resolve the template: inline fields, or a SNAPSHOT of an existing A10 document. The snapshot is
  // taken NOW and never referenced again: a later edit of that document cannot retarget the
  // schedule, and A12 holds no live link into a table A10 owns (US-A12.1).
  let contactId: string | null = typeof input.contactId === 'string' ? input.contactId : null;
  let rawLines: unknown = input.lines;
  let currency: string | null = typeof input.currency === 'string' ? input.currency : null;
  let notes: string | null = typeof input.notes === 'string' ? input.notes : null;

  if (typeof input.templateDocumentId === 'string') {
    // §H-TENANT: a foreign and a nonexistent template document earn the SAME rejection, so an id
    // can never be probed across tenants (critic probe C12).
    const doc = ctx.store.db
      .prepare('SELECT id, contact_id, currency, notes FROM document WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, input.templateDocumentId) as
      | { id: string; contact_id: string | null; currency: string; notes: string | null }
      | undefined;
    if (doc === undefined) return err('not_found', { templateDocumentId: input.templateDocumentId });
    contactId = contactId ?? doc.contact_id;
    currency = currency ?? doc.currency;
    notes = notes ?? doc.notes;
    if (rawLines === undefined) {
      // The snapshot copies the whitelist keys ONLY. A real document line may carry a
      // `supply_date`; the template must not (critic probe R2: three invoices for three service
      // months must never claim one frozen Leistungsdatum).
      rawLines = (
        ctx.store.db
          .prepare(
            'SELECT item_id, description, quantity_milli, unit_price_minor, tax_code FROM document_line WHERE document_id = ? ORDER BY position',
          )
          .all(doc.id) as {
          item_id: string | null;
          description: string | null;
          quantity_milli: number;
          unit_price_minor: number;
          tax_code: string | null;
        }[]
      ).map((l) => ({
        ...(l.item_id !== null ? { itemId: l.item_id } : {}),
        ...(l.description !== null ? { description: l.description } : {}),
        quantityMilli: l.quantity_milli,
        unitPriceMinor: l.unit_price_minor,
        ...(l.tax_code !== null ? { taxCode: l.tax_code } : {}),
      }));
    }
  }

  if (contactId === null || !contactExists(ctx, contactId)) return err('needs_customer');
  const normalized = normalizeTemplateLines(rawLines);
  if (!normalized.ok) return normalized.result;
  const resolvedContactId = contactId;

  const run = (): Result => {
    const id = ctx.ids.next('rsched');
    const at = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO recurring_schedule
           (id, workspace_id, name, contact_id, lines_json, currency, notes, due_days, interval,
            custom_days, anchor_date, next_run_date, end_date, max_occurrences, occurrences_done,
            auto_issue, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        typeof input.name === 'string' ? input.name : null,
        resolvedContactId,
        JSON.stringify(normalized.lines),
        currency,
        notes,
        cadence.cadence.dueDays,
        cadence.cadence.interval,
        cadence.cadence.customDays,
        cadence.cadence.anchorDate,
        // The cursor starts AT the anchor: occurrence 0 is the anchor itself.
        cadence.cadence.anchorDate,
        cadence.cadence.endDate,
        cadence.cadence.maxOccurrences,
        input.autoIssue === true ? 1 : 0,
        ctx.actor,
        at,
        at,
      );
    return ok({ schedule: mapSchedule(readSchedule(ctx, id) as ScheduleRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'create_recurring_schedule', run);
  }
  return ctx.store.tx(run);
}

// --- updateRecurringSchedule -------------------------------------------------------------------

export function updateRecurringSchedule(
  ctx: WorkspaceContext,
  input: { scheduleId: string; patch: UpdateRecurringSchedulePatch },
): Result {
  const row = readSchedule(ctx, input.scheduleId);
  if (row === undefined) return err('not_found', { scheduleId: input.scheduleId });
  if (row.status === 'ended') return err('schedule_ended', { scheduleId: input.scheduleId });
  const patch = input.patch ?? {};

  // Validate the EFFECTIVE cadence: the patched fields merged over the stored ones, so
  // `end_before_anchor` is refused on the pair as it will exist, not only on the fields named
  // (critic probes C4, R8).
  const cadence = validateCadence({
    interval: patch.interval !== undefined ? patch.interval : row.interval,
    customDays: patch.customDays !== undefined ? patch.customDays : row.custom_days,
    anchorDate: patch.anchorDate !== undefined ? patch.anchorDate : row.anchor_date,
    endDate: patch.endDate !== undefined ? patch.endDate : row.end_date,
    dueDays: patch.dueDays !== undefined ? patch.dueDays : row.due_days,
    maxOccurrences: patch.maxOccurrences !== undefined ? patch.maxOccurrences : row.max_occurrences,
  });
  if (!cadence.ok) return cadence.result;

  if (patch.contactId !== undefined) {
    if (typeof patch.contactId !== 'string' || !contactExists(ctx, patch.contactId)) {
      return err('needs_customer');
    }
  }
  let linesJson: string | undefined;
  if (patch.lines !== undefined) {
    const normalized = normalizeTemplateLines(patch.lines);
    if (!normalized.ok) return normalized.result;
    linesJson = JSON.stringify(normalized.lines);
  }

  // A cadence change restarts the series from the new anchor at the next occurrence on or after
  // TODAY (the injected clock, never the caller's word). Settled periods stay settled: the run log
  // and the memos remember them whatever the cursor does.
  const cadenceChanged =
    patch.interval !== undefined || patch.customDays !== undefined || patch.anchorDate !== undefined;
  let nextRunDate = row.next_run_date;
  if (cadenceChanged) {
    const today = dayOf(ctx.clock.now());
    const next = firstOccurrenceOnOrAfter(
      cadence.cadence.anchorDate,
      cadence.cadence.interval,
      cadence.cadence.customDays,
      today,
    );
    // The bounded walk came back empty (R9's shape: a custom cadence anchored centuries back). The
    // anchor is what is unreachable, so the refusal names it, and nothing has been written.
    if (next === undefined) return err('invalid_input', { field: 'anchorDate' });
    nextRunDate = next;
  }

  return ctx.store.tx(() => {
    ctx.store.db
      .prepare(
        `UPDATE recurring_schedule
            SET name = ?, contact_id = ?, lines_json = ?, currency = ?, notes = ?, due_days = ?,
                interval = ?, custom_days = ?, anchor_date = ?, next_run_date = ?, end_date = ?,
                max_occurrences = ?, auto_issue = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        patch.name !== undefined ? patch.name : row.name,
        patch.contactId !== undefined ? patch.contactId : row.contact_id,
        linesJson !== undefined ? linesJson : row.lines_json,
        patch.currency !== undefined ? patch.currency : row.currency,
        patch.notes !== undefined ? patch.notes : row.notes,
        cadence.cadence.dueDays,
        cadence.cadence.interval,
        cadence.cadence.customDays,
        cadence.cadence.anchorDate,
        nextRunDate,
        cadence.cadence.endDate,
        cadence.cadence.maxOccurrences,
        patch.autoIssue !== undefined ? (patch.autoIssue === true ? 1 : 0) : row.auto_issue,
        ctx.clock.now(),
        ctx.workspaceId,
        input.scheduleId,
      );
    return ok({ schedule: mapSchedule(readSchedule(ctx, input.scheduleId) as ScheduleRow) });
  });
}

// --- The three lifecycle verbs (absolute state; automatable per D66) ---------------------------

function setStatus(ctx: WorkspaceContext, scheduleId: string, status: 'active' | 'paused' | 'ended'): Result {
  const row = readSchedule(ctx, scheduleId);
  if (row === undefined) return err('not_found', { scheduleId });
  // `ended` is terminal: pause and resume refuse; a replayed end settles to the same answer.
  if (row.status === 'ended' && status !== 'ended') return err('schedule_ended', { scheduleId });
  if (row.status !== status) {
    ctx.store.db
      .prepare('UPDATE recurring_schedule SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(status, ctx.clock.now(), ctx.workspaceId, scheduleId);
  }
  return ok({ schedule: mapSchedule(readSchedule(ctx, scheduleId) as ScheduleRow) });
}

export function pauseRecurringSchedule(ctx: WorkspaceContext, input: { scheduleId: string }): Result {
  return setStatus(ctx, input.scheduleId, 'paused');
}

export function resumeRecurringSchedule(ctx: WorkspaceContext, input: { scheduleId: string }): Result {
  // Resuming restores exactly what a person configured: it cannot retarget the template or flip
  // autoIssue, which is why D66 keeps it automatable. Periods missed while paused are generated by
  // the next tick (each separately idempotent, bounded per tick), and D66 states that accepted cost.
  return setStatus(ctx, input.scheduleId, 'active');
}

export function endRecurringSchedule(ctx: WorkspaceContext, input: { scheduleId: string }): Result {
  return setStatus(ctx, input.scheduleId, 'ended');
}

// --- Reads -------------------------------------------------------------------------------------

/** The correlated last-run pair (C5): per schedule AND per workspace, so nothing bleeds (R7). */
const LAST_RUN_SELECT = `
  (SELECT r.outcome FROM recurring_run_log r
    WHERE r.workspace_id = s.workspace_id AND r.schedule_id = s.id
    ORDER BY r.ran_at DESC, r.rowid DESC LIMIT 1) AS last_outcome,
  (SELECT r.error FROM recurring_run_log r
    WHERE r.workspace_id = s.workspace_id AND r.schedule_id = s.id
    ORDER BY r.ran_at DESC, r.rowid DESC LIMIT 1) AS last_error,
  (SELECT c.name FROM contact c
    WHERE c.workspace_id = s.workspace_id AND c.id = s.contact_id) AS contact_name`;

export function listRecurringSchedules(
  ctx: WorkspaceContext,
  filter: { status?: string; contactId?: string; savedViewId?: string } = {},
): Result {
  const viewed = applySavedView(ctx, 'recurring_schedule', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter as typeof filter;
  const clauses = ['s.workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.status !== undefined) {
    clauses.push('s.status = ?');
    params.push(filter.status);
  }
  if (filter.contactId !== undefined) {
    clauses.push('s.contact_id = ?');
    params.push(filter.contactId);
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT s.*, ${LAST_RUN_SELECT} FROM recurring_schedule s
        WHERE ${clauses.join(' AND ')} ORDER BY s.created_at DESC, s.rowid DESC`,
    )
    .all(...params) as ScheduleRow[];
  return ok({ schedules: rows.map(mapSchedule) });
}

export function getRecurringSchedule(ctx: WorkspaceContext, input: { scheduleId: string }): Result {
  const row = ctx.store.db
    .prepare(
      `SELECT s.*, ${LAST_RUN_SELECT} FROM recurring_schedule s WHERE s.workspace_id = ? AND s.id = ?`,
    )
    .get(ctx.workspaceId, input.scheduleId) as ScheduleRow | undefined;
  if (row === undefined) return err('not_found', { scheduleId: input.scheduleId });
  // The run log IS the provenance: A10's table carries no recurring column, and the generated
  // documents are found from here, never the other way round. The document join is LEFT and
  // tenant-scoped: a cancelled draft's period survives with a null pointer (C3).
  const runs = ctx.store.db
    .prepare(
      `SELECT r.id, r.period_key, r.document_id, r.outcome, r.error, r.ran_at,
              d.number AS document_number, d.status AS document_status
         FROM recurring_run_log r
         LEFT JOIN document d ON d.id = r.document_id AND d.workspace_id = r.workspace_id
        WHERE r.workspace_id = ? AND r.schedule_id = ?
        ORDER BY r.ran_at DESC, r.rowid DESC`,
    )
    .all(ctx.workspaceId, input.scheduleId) as {
    id: string;
    period_key: string;
    document_id: string | null;
    outcome: string;
    error: string | null;
    ran_at: string;
    document_number: string | null;
    document_status: string | null;
  }[];
  return ok({
    schedule: mapSchedule(row),
    runs: runs.map((r) => ({
      id: r.id,
      periodKey: r.period_key,
      documentId: r.document_id,
      outcome: r.outcome,
      error: r.error,
      ranAt: r.ran_at,
      documentNumber: r.document_number,
      documentStatus: r.document_status,
    })),
  });
}

// --- The tick ----------------------------------------------------------------------------------

interface OccurrenceResult {
  scheduleId: string;
  periodKey: string;
  outcome: RunOutcome;
  documentId?: string;
  error?: string;
}

type OccurrenceStep =
  | { kind: 'settle'; outcome: 'drafted' | 'issued' | 'discarded'; documentId: string | null; dueStamped: string | null; generatedDocument: boolean }
  | { kind: 'open'; outcome: 'skipped_locked' | 'failed'; documentId: string | null; error: string | null };

function insertRunRow(
  ctx: WorkspaceContext,
  row: ScheduleRow,
  period: string,
  outcome: RunOutcome,
  documentId: string | null,
  error: string | null,
  dueStamped: string | null,
): void {
  ctx.store.db
    .prepare(
      `INSERT INTO recurring_run_log
         (id, workspace_id, schedule_id, period_key, document_id, outcome, error, due_stamped, ran_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.ids.next('rrun'), ctx.workspaceId, row.id, period, documentId, outcome, error, dueStamped, ctx.clock.now());
}

/** The settled half of the partial index refused the insert: this period settled elsewhere. */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  const message = e instanceof Error ? e.message : '';
  return (
    (typeof code === 'string' && code === 'SQLITE_CONSTRAINT_UNIQUE') ||
    message.includes('UNIQUE constraint failed')
  );
}

/** Advance the cursor past `period`, ending the schedule at its bounds. Mutates `row` to match. */
function advancePast(ctx: WorkspaceContext, row: ScheduleRow, period: string): void {
  const next = nextOccurrenceAfter(
    row.anchor_date,
    row.interval as RecurringInterval,
    row.custom_days,
    period,
  );
  const done = row.occurrences_done + 1;
  let status = row.status;
  const nextRun = next ?? period;
  if (next === undefined) {
    // Pathological (the 100'000-step bound): a series whose next occurrence cannot be computed is
    // ended rather than looped over forever. Reaching this needs a custom cadence and centuries.
    status = 'ended';
  } else {
    if (row.end_date !== null && next > row.end_date) status = 'ended';
    if (row.max_occurrences !== null && done >= row.max_occurrences) status = 'ended';
  }
  ctx.store.db
    .prepare(
      'UPDATE recurring_schedule SET next_run_date = ?, occurrences_done = ?, status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
    )
    .run(nextRun, done, status, ctx.clock.now(), row.workspace_id, row.id);
  row.next_run_date = nextRun;
  row.occurrences_done = done;
  row.status = status;
}

/** End a schedule whose bound excludes the CURRENT pending occurrence: no advance, no run row. */
function endAtBound(ctx: WorkspaceContext, row: ScheduleRow): void {
  ctx.store.db
    .prepare("UPDATE recurring_schedule SET status = 'ended', updated_at = ? WHERE workspace_id = ? AND id = ?")
    .run(ctx.clock.now(), row.workspace_id, row.id);
  row.status = 'ended';
}

/**
 * Settle one period and advance the cursor, in one transaction. A settle refused by the partial
 * UNIQUE index means the period already settled elsewhere (a crash-rewound cursor meeting its own
 * history): the tick CONVERGES by advancing without a second row (spec §4b, I3).
 */
function settleAndAdvance(
  ctx: WorkspaceContext,
  row: ScheduleRow,
  period: string,
  step: Extract<OccurrenceStep, { kind: 'settle' }>,
): void {
  try {
    ctx.store.tx(() => {
      insertRunRow(ctx, row, period, step.outcome, step.documentId, null, step.dueStamped);
      advancePast(ctx, row, period);
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    ctx.store.tx(() => advancePast(ctx, row, period));
  }
}

/** The invoked `create_document`'s answer, read defensively: both faces return the documentView. */
function documentIdOf(created: Result): string | undefined {
  const doc = (created as { document?: { id?: unknown } }).document;
  return doc !== undefined && typeof doc.id === 'string' ? doc.id : undefined;
}

/**
 * The due date A12 last stamped on this document, for the conditional re-assert (F4): the recorded
 * `due_stamped` of the latest run row for this (schedule, period, document), with the crash-window
 * fallback of re-deriving it from the document's own creation day.
 */
function stampedDueDate(
  ctx: WorkspaceContext,
  row: ScheduleRow,
  period: string,
  doc: { due_date: string | null; created_at: string },
): string | null {
  if (row.due_days === null) return null;
  const recorded = ctx.store.db
    .prepare(
      `SELECT due_stamped FROM recurring_run_log
        WHERE schedule_id = ? AND period_key = ? AND due_stamped IS NOT NULL
        ORDER BY ran_at DESC, rowid DESC LIMIT 1`,
    )
    .get(row.id, period) as { due_stamped: string | null } | undefined;
  if (recorded !== undefined && recorded.due_stamped !== null) return recorded.due_stamped;
  return addDays(dayOf(doc.created_at), row.due_days);
}

/**
 * One occurrence, one period. Invokes the registered verbs as the schedule's AUTHOR, verifies every
 * memoised answer against the store (invariant I2), and reports either a SETTLE (the caller writes
 * the row and advances, atomically) or an OPEN observation (written here; the caller stops this
 * schedule for this tick).
 */
function runOccurrence(
  ctx: WorkspaceContext,
  invoke: ActionInvoker,
  row: ScheduleRow,
  period: string,
  today: string,
): OccurrenceStep {
  const author = row.created_by;
  const templateLines = normalizeTemplateLines(JSON.parse(row.lines_json));
  // Defence in depth (R2b): even a lines_json poisoned behind the whitelist's back is re-filtered
  // here, and the stamp is then ADDED to whitelisted keys, so the period always wins.
  const lines = (templateLines.ok ? templateLines.lines : []).map((l) => ({
    ...l,
    // THE SUPPLY-DATE LAW (C1/C2): the occurrence's own period is the Leistungsdatum, per line,
    // stamped by the tick, which is that field's single writer. This is what makes a catch-up bill
    // each period at ITS OWN VAT era, and what answers A11's era-ambiguity refusal before it fires.
    supplyDate: period,
  }));
  if (lines.length === 0) {
    insertRunRow(ctx, row, period, 'failed', null, 'needs_positions', null);
    return { kind: 'open', outcome: 'failed', documentId: null, error: 'needs_positions' };
  }
  // THE DUE-DATE LAW, moment one: clock day + dueDays. Never the asOf cursor (R1/F1/F7).
  const dueStamped = row.due_days !== null ? addDays(today, row.due_days) : null;

  const created = invoke(
    'create_document',
    {
      workspaceId: ctx.workspaceId,
      type: 'invoice',
      contactId: row.contact_id,
      lines,
      ...(row.currency !== null ? { currency: row.currency } : {}),
      ...(dueStamped !== null ? { dueDate: dueStamped } : {}),
      ...(row.notes !== null ? { notes: row.notes } : {}),
      idempotencyKey: `recurring:${row.id}:${period}`,
    },
    author,
  );
  if (!created.ok) {
    insertRunRow(ctx, row, period, 'failed', null, created.error, dueStamped);
    return { kind: 'open', outcome: 'failed', documentId: null, error: created.error };
  }
  const documentId = documentIdOf(created);
  if (documentId === undefined) {
    insertRunRow(ctx, row, period, 'failed', null, 'unexpected_result_shape', dueStamped);
    return { kind: 'open', outcome: 'failed', documentId: null, error: 'unexpected_result_shape' };
  }

  // INVARIANT I2: the memo's answer is a fact about the past. Verify the document's PRESENT fate
  // before writing anything that references it. The engine is synchronous, so nothing can move it
  // between this read and the run-log write.
  const doc = ctx.store.db
    .prepare('SELECT id, status, due_date, created_at FROM document WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, documentId) as
    | { id: string; status: string; due_date: string | null; created_at: string }
    | undefined;

  if (doc === undefined) {
    // A human cancelled the waiting draft (A10 hard-deletes a cancelled draft). Discarding the
    // artefact IS discarding the period: settle `discarded` and advance, and the sibling schedules
    // never notice (the F6 repair). Nothing is re-billed unattended.
    return { kind: 'settle', outcome: 'discarded', documentId: null, dueStamped, generatedDocument: false };
  }
  if (doc.status !== 'draft') {
    // Issued: by a human hand-issuing the waiting draft (F5), or by a crash replay whose settle row
    // was lost (C14/F2). One rule for both: the period IS billed; settle `issued` and advance. A
    // post-issue cancel also lands here on purpose: the billing happened and its reversal is a
    // human's correction in A10's history, which a re-bill would undo.
    return { kind: 'settle', outcome: 'issued', documentId, dueStamped, generatedDocument: true };
  }

  if (row.auto_issue !== 1) {
    // Review mode (the P8 default): the draft is the product. Drafting is not the financial event,
    // so this settles even inside a locked period.
    return { kind: 'settle', outcome: 'drafted', documentId, dueStamped, generatedDocument: true };
  }

  // THE DUE-DATE LAW, moment two: an AGED draft is re-asserted from the issue day ONLY while it
  // still carries the machine stamp; a date a human negotiated on the waiting draft differs from
  // the stamp and is KEPT (the F4 repair). The refusal of the draft-only patch is deliberately
  // ignored: the one refusal it can produce here is "not a draft", and the F3 probe pins that
  // `update_document` and `issue_invoice` resolve to the same capability, so the swallow can never
  // hide a rights failure.
  if (row.due_days !== null && dueStamped !== null && doc.due_date !== dueStamped) {
    const stamped = stampedDueDate(ctx, row, period, doc);
    if (doc.due_date === stamped) {
      invoke(
        'update_document',
        { workspaceId: ctx.workspaceId, documentId, patch: { dueDate: dueStamped } },
        author,
      );
    }
  }

  const issued = invoke(
    'issue_invoice',
    {
      workspaceId: ctx.workspaceId,
      invoiceId: documentId,
      idempotencyKey: `recurring_issue:${row.id}:${period}`,
    },
    author,
  );
  if (!issued.ok) {
    if (issued.error === 'period_locked') {
      // §H-PERIOD: the draft is kept (unnumbered, no ledger effect), the observation is recorded,
      // and the cursor does NOT advance past the lock: the period is retried once the lock lifts.
      insertRunRow(ctx, row, period, 'skipped_locked', documentId, null, dueStamped);
      return { kind: 'open', outcome: 'skipped_locked', documentId, error: null };
    }
    insertRunRow(ctx, row, period, 'failed', documentId, issued.error, dueStamped);
    return { kind: 'open', outcome: 'failed', documentId, error: issued.error };
  }
  return { kind: 'settle', outcome: 'issued', documentId, dueStamped, generatedDocument: true };
}

/** One schedule's share of the tick. Returns how many documents it generated. */
function tickSchedule(
  ctx: WorkspaceContext,
  invoke: ActionInvoker,
  schedule: ScheduleRow,
  asOfDay: string,
  today: string,
  results: OccurrenceResult[],
): number {
  const row = { ...schedule };
  let generated = 0;
  let settles = 0;
  while (settles < CATCH_UP_CAP) {
    const period = row.next_run_date;
    // The cursor governs HOW FAR the catch-up reaches, and only that (R1/F1).
    if (period > asOfDay) break;
    // The C4 repair: the bound excludes the CURRENT occurrence too, not only the advance. Ending
    // here writes no run row: the log records occurrences, never the absence of one (R8).
    if (row.end_date !== null && period > row.end_date) {
      endAtBound(ctx, row);
      break;
    }
    if (row.max_occurrences !== null && row.occurrences_done >= row.max_occurrences) {
      endAtBound(ctx, row);
      break;
    }
    const step = runOccurrence(ctx, invoke, row, period, today);
    if (step.kind === 'settle') {
      settleAndAdvance(ctx, row, period, step);
      results.push({
        scheduleId: row.id,
        periodKey: period,
        outcome: step.outcome,
        ...(step.documentId !== null ? { documentId: step.documentId } : {}),
      });
      settles += 1;
      if (step.generatedDocument) generated += 1;
      if (row.status !== 'active') break;
    } else {
      results.push({
        scheduleId: row.id,
        periodKey: period,
        outcome: step.outcome,
        ...(step.documentId !== null ? { documentId: step.documentId } : {}),
        ...(step.error !== null ? { error: step.error } : {}),
      });
      // An open observation freezes THIS schedule's cursor for this tick, and nothing else (I3).
      break;
    }
  }
  return generated;
}

/**
 * `runDueRecurring`: settle every due period of every active schedule at `asOf`.
 *
 * SELF-KEYED (the `run_due_automations` exemption): every occurrence derives its own key from
 * `(scheduleId, periodKey)` for the verbs it invokes, and the partial UNIQUE index refuses a second
 * settle of the same period, so a replayed tick produces nothing twice no matter what the caller
 * passes. An idempotencyKey would key the TICK, which is not the thing that must not repeat.
 */
export function runDueRecurring(
  ctx: WorkspaceContext,
  invoke: ActionInvoker,
  input: { asOf?: string } = {},
): Result {
  const now = ctx.clock.now();
  const today = dayOf(now);
  const asOfRaw = typeof input.asOf === 'string' && input.asOf.length > 0 ? input.asOf : now;
  const asOfDay = dayOf(asOfRaw);
  if (!isIsoDate(asOfDay)) return err('invalid_input', { field: 'asOf' });
  // The injected clock decides what is due, never the caller (the G01 tick's rule): a past asOf is
  // legal (catch up only this far), a future one is refused rather than silently clamped.
  if (asOfDay > today) return err('as_of_in_future', { asOf: asOfRaw, now });

  const schedules = ctx.store.db
    .prepare(
      `SELECT * FROM recurring_schedule
        WHERE workspace_id = ? AND status = 'active' AND next_run_date <= ?
        ORDER BY created_at, rowid`,
    )
    .all(ctx.workspaceId, asOfDay) as ScheduleRow[];

  const results: OccurrenceResult[] = [];
  let generated = 0;
  for (const schedule of schedules) {
    // INVARIANT I3: one poisoned schedule never stops a sibling or the verb. Anything thrown inside
    // becomes that schedule's own failed observation, and the loop keeps going.
    try {
      generated += tickSchedule(ctx, invoke, schedule, asOfDay, today, results);
    } catch (e) {
      // The throw path reports like every handled refusal does (critic X1b): a STABLE code, never
      // the exception's own message (`schema.ts`: "never a stack trace"), and a failed run row, so
      // the C5 list signal shows the poison instead of the last good outcome. The cursor is re-read
      // because the throw may have landed after earlier periods settled in this same tick.
      void e;
      const cursor = ctx.store.db
        .prepare('SELECT next_run_date FROM recurring_schedule WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, schedule.id) as { next_run_date: string } | undefined;
      const period = cursor?.next_run_date ?? schedule.next_run_date;
      try {
        insertRunRow(ctx, schedule, period, 'failed', null, 'unexpected_error', null);
      } catch {
        // Even the observation failing must not take the sibling schedules with it (I3): the
        // results row below still carries the fact.
      }
      results.push({
        scheduleId: schedule.id,
        periodKey: period,
        outcome: 'failed',
        error: 'unexpected_error',
      });
    }
  }
  return ok({ asOf: asOfDay, generated, results });
}
