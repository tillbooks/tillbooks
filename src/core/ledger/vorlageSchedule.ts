/**
 * N04 (D183), Dauerbuchungen: a Vorlage that books itself on a schedule (rent, leasing, a management fee).
 *
 * A schedule hangs on a Vorlage SERIES: the first version of the Vorlage (a `bank_standard` row of scope
 * `manual`), found by following N03's `replaces_id` chain back. It follows the Vorlage through every edit and
 * reads the LIVE version when it runs (found by following the chain forward); a chain that ends in a cleared
 * version ends the schedule. At most one active schedule per series.
 *
 * WHEN. Every month, quarter or year, on the anchor day (31 is the month's last day, A12's arithmetic: every
 * due date derives from the anchor, so February takes the 28th or 29th and March is the 31st again), from the
 * start date, until the optional end date, in Swiss days (Europe/Zurich). On each due date the step creates
 * ONE run for the PERIOD the due date falls in (`YYYY-MM`, `YYYY-Qn`, `YYYY`), unique per (workspace, series,
 * period) across every schedule ever set on the series, written in the same transaction as its posting or its
 * Vorschlag; the key is `schedule:<series>:<period>` (a reserved prefix). A new or re-set schedule starts at
 * the first period that STARTS after the END of the series' latest run period, so moving the day or changing
 * the cadence never books a period twice (period keys of different cadences never collide, so the rule is
 * applied in dates).
 *
 * HOW. `propose` (the default) drafts a Vorschlag of `post_entry { template }` dated the due date, as
 * `system` (approvable by any person with the right), and `post` posts it as the person who set the schedule:
 *   - only a PERSON sets `post` (a governed seat is refused `human_only`);
 *   - that person's `post` right is checked LIVE at each run; gone, the run is proposed and says why;
 *   - a newer Vorlage version than the one the person confirmed runs as `propose` until they set it again
 *     (asked amounts are keyed by leg index, so an edit must never post unattended);
 *   - catching up, every missed due date is created once, never skipped, and in `post` mode every one older
 *     than the current due date is PROPOSED, not posted.
 * A locked period, or a Vorlage that no longer books with these amounts, is recorded as skipped, with a
 * Pendenz. A Vorschlag that went stale before approval (the Vorlage changed) is re-proposed on the next tick
 * from the live version. Nothing here edits a posted entry.
 *
 * §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { isGovernedSeat } from '../access/capability.js';
import { enqueueDraftedAction } from '../agent/draftedActions.js';
import { composeTemplate, parseTemplate } from '../banking/bankTemplates.js';
import { readLiveRule, readRuleRow } from '../banking/bankStandards.js';
import { zurichParts } from '../banking/ebics/autoSync.js';
import { isIsoDate, occurrenceAt } from '../recurring/dates.js';
import { requireString } from './inputGuards.js';
import { getSetting } from '../settings/index.js';

// --- Vocabulary ------------------------------------------------------------------------------------------

export const SCHEDULE_EVERY = ['month', 'quarter', 'year'] as const;
export type ScheduleEvery = (typeof SCHEDULE_EVERY)[number];
export const SCHEDULE_MODES = ['propose', 'post'] as const;
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];

/** The reserved idempotency-key prefix of a schedule run (`RESERVED_IDEMPOTENCY_KEY_PREFIXES`). */
export const SCHEDULE_KEY_PREFIX = 'schedule:';

/** The key one period of a series posts (or its Vorschlag replays) under. */
export function scheduleRunKey(seriesId: string, period: string): string {
  return `${SCHEDULE_KEY_PREFIX}${seriesId}:${period}`;
}

/** Why a run did not post as `post` (proposed instead), or was skipped. Stable codes. */
export const SCHEDULE_RUN_REASONS = ['catch_up', 'no_post_right', 'vorlage_changed', 'vorlage_cleared', 'period_locked'] as const;

/** The actor a proposed run is drafted as. */
export const SCHEDULE_SYSTEM_ACTOR = 'system';

/** At most this many periods per schedule per tick; the rest follow on the next tick, never skipped. */
export const SCHEDULE_CATCH_UP_CAP = 24;

const INTERVAL: Record<ScheduleEvery, 'monthly' | 'quarterly' | 'yearly'> = { month: 'monthly', quarter: 'quarterly', year: 'yearly' };

// --- Dates and periods ------------------------------------------------------------------------------------

/** The period a due date falls in: `YYYY-MM`, `YYYY-Qn` or `YYYY`. */
export function periodOf(date: string, every: ScheduleEvery): string {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  if (every === 'month') return date.slice(0, 7);
  if (every === 'quarter') return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  return year;
}

function lastDayOf(year: number, month1: number): string {
  const day = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The first and last day of a period key. */
export function periodBounds(period: string): { start: string; end: string } {
  const year = Number(period.slice(0, 4));
  const quarter = /^\d{4}-Q([1-4])$/.exec(period);
  if (quarter !== null) {
    const first = (Number(quarter[1]) - 1) * 3 + 1;
    return { start: `${period.slice(0, 4)}-${String(first).padStart(2, '0')}-01`, end: lastDayOf(year, first + 2) };
  }
  if (/^\d{4}-\d{2}$/.test(period)) return { start: `${period}-01`, end: lastDayOf(year, Number(period.slice(5, 7))) };
  return { start: `${period}-01-01`, end: `${period}-12-31` };
}

/** The anchor the series of due dates derives from: the start's month, on the anchor day (clamped per month). */
function anchorOf(startDate: string, anchorDay: number): string {
  return `${startDate.slice(0, 7)}-${String(anchorDay).padStart(2, '0')}`;
}

/** The longest walk a series takes (200 years of months): bounded, never a spin. */
const MAX_STEPS = 2400;

/**
 * Every due date of a schedule on or after its start, up to `until` (inclusive) and its end date. A12's
 * `occurrenceAt` from the anchor, so the month end returns to the 31st after a short month.
 */
export function dueDates(s: { every: ScheduleEvery; anchorDay: number; startDate: string; endDate: string | null }, until: string): string[] {
  const anchor = anchorOf(s.startDate, s.anchorDay);
  const out: string[] = [];
  for (let n = 0; n < MAX_STEPS; n += 1) {
    const d = occurrenceAt(anchor, INTERVAL[s.every], null, n);
    if (d < s.startDate) continue;
    if (d > until || (s.endDate !== null && d > s.endDate)) break;
    out.push(d);
  }
  return out;
}

/** The first due date strictly after `after`, or null (past the end date or the walk's bound). */
export function nextDueDate(s: { every: ScheduleEvery; anchorDay: number; startDate: string; endDate: string | null }, after: string): string | null {
  const anchor = anchorOf(s.startDate, s.anchorDay);
  for (let n = 0; n < MAX_STEPS; n += 1) {
    const d = occurrenceAt(anchor, INTERVAL[s.every], null, n);
    if (d < s.startDate || d <= after) continue;
    return s.endDate !== null && d > s.endDate ? null : d;
  }
  return null;
}

/** Today in Switzerland. */
function swissToday(ctx: WorkspaceContext): string {
  return zurichParts(ctx.clock.now()).date;
}

// --- The Vorlage series -----------------------------------------------------------------------------------

/** The first version of the Vorlage `versionId` belongs to (its series id), following `replaces_id` back. */
export function seriesOf(ctx: WorkspaceContext, versionId: string): string | null {
  const step = ctx.store.db.prepare('SELECT replaces_id AS r FROM bank_standard WHERE workspace_id = ? AND id = ?');
  const seen = new Set<string>();
  let at: string = versionId;
  let found: string | null = null;
  for (;;) {
    const row = step.get(ctx.workspaceId, at) as { r: string | null } | undefined;
    if (row === undefined) return found;
    found = at;
    seen.add(at);
    if (row.r === null || seen.has(row.r)) return found;
    at = row.r;
  }
}

/**
 * The LIVE version of a series, following `replaces_id` forward (the newest row that replaced the current
 * one, until a row that is not superseded); null when the chain ends in a version that was cleared.
 */
export function liveHeadOf(ctx: WorkspaceContext, seriesId: string): string | null {
  const state = ctx.store.db.prepare('SELECT superseded_at AS s FROM bank_standard WHERE workspace_id = ? AND id = ?');
  const next = ctx.store.db.prepare('SELECT id FROM bank_standard WHERE workspace_id = ? AND replaces_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1');
  const seen = new Set<string>();
  let at = seriesId;
  while (!seen.has(at)) {
    seen.add(at);
    const row = state.get(ctx.workspaceId, at) as { s: string | null } | undefined;
    if (row === undefined) return null;
    if (row.s === null) return at;
    const successor = next.get(ctx.workspaceId, at) as { id: string } | undefined;
    if (successor === undefined) return null;
    at = successor.id;
  }
  return null;
}

// --- Rows ------------------------------------------------------------------------------------------------

interface ScheduleRow {
  id: string;
  workspace_id: string;
  series_id: string;
  every: ScheduleEvery;
  anchor_day: number;
  start_date: string;
  end_date: string | null;
  mode: ScheduleMode;
  asks_json: string;
  post_version_id: string | null;
  set_by: string;
  set_at: string;
  status: 'active' | 'ended';
  ended_at: string | null;
  ended_by: string | null;
  end_reason: string | null;
}

interface RunRow {
  id: string;
  series_id: string;
  period: string;
  due_date: string;
  schedule_id: string;
  outcome: 'posted' | 'proposed' | 'skipped';
  entry_id: string | null;
  action_id: string | null;
  version_id: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function shapeOf(s: ScheduleRow): { every: ScheduleEvery; anchorDay: number; startDate: string; endDate: string | null } {
  return { every: s.every, anchorDay: s.anchor_day, startDate: s.start_date, endDate: s.end_date };
}

/** The end of the series' latest run period, or null when the series never ran. */
function latestRunEnd(ctx: WorkspaceContext, seriesId: string): string | null {
  const rows = ctx.store.db.prepare('SELECT period FROM vorlage_schedule_run WHERE workspace_id = ? AND series_id = ?').all(ctx.workspaceId, seriesId) as { period: string }[];
  let latest: string | null = null;
  for (const r of rows) {
    const end = periodBounds(r.period).end;
    if (latest === null || end > latest) latest = end;
  }
  return latest;
}

/** The due dates the schedule still owes, in order: up to today, in periods after the series' latest run. */
function owedDueDates(ctx: WorkspaceContext, s: ScheduleRow, today: string): string[] {
  let latest = latestRunEnd(ctx, s.series_id);
  const out: string[] = [];
  for (const d of dueDates(shapeOf(s), today)) {
    const bounds = periodBounds(periodOf(d, s.every));
    if (latest !== null && bounds.start <= latest) continue;
    out.push(d);
    latest = bounds.end;
  }
  return out;
}

/** The next due date the schedule would run, from today (owed ones first), or null. */
function nextRunOf(ctx: WorkspaceContext, s: ScheduleRow): string | null {
  if (s.status !== 'active') return null;
  const today = swissToday(ctx);
  const owed = owedDueDates(ctx, s, today);
  if (owed.length > 0) return owed[0] as string;
  const latest = latestRunEnd(ctx, s.series_id);
  for (let after = today; ; ) {
    const d = nextDueDate(shapeOf(s), after);
    if (d === null) return null;
    if (latest === null || periodBounds(periodOf(d, s.every)).start > latest) return d;
    after = d;
  }
}

/** A schedule as every read answers it. */
export interface VorlageScheduleView {
  scheduleId: string;
  seriesId: string;
  /** The live Vorlage version now, or null once the series was cleared. */
  liveVersionId: string | null;
  label: string | null;
  every: ScheduleEvery;
  anchorDay: number;
  start: string;
  end: string | null;
  mode: ScheduleMode;
  /** What the next run will do: `post` only while the confirmed version is the live one. */
  effectiveMode: ScheduleMode;
  asks: Record<string, number>;
  setBy: string;
  setAt: string;
  status: 'active' | 'ended';
  endReason: string | null;
  nextRun: string | null;
}

function scheduleView(ctx: WorkspaceContext, s: ScheduleRow): VorlageScheduleView {
  const live = liveHeadOf(ctx, s.series_id);
  const label = live === null ? (readRuleRow(ctx, s.series_id)?.label ?? null) : (readRuleRow(ctx, live)?.label ?? null);
  let asks: Record<string, number> = {};
  try {
    asks = JSON.parse(s.asks_json) as Record<string, number>;
  } catch {
    asks = {};
  }
  return {
    scheduleId: s.id,
    seriesId: s.series_id,
    liveVersionId: live,
    label,
    every: s.every,
    anchorDay: s.anchor_day,
    start: s.start_date,
    end: s.end_date,
    mode: s.mode,
    effectiveMode: s.mode === 'post' && s.post_version_id !== null && s.post_version_id === live ? 'post' : 'propose',
    asks,
    setBy: s.set_by,
    setAt: s.set_at,
    status: s.status,
    endReason: s.end_reason,
    nextRun: nextRunOf(ctx, s),
  };
}

function activeScheduleOf(ctx: WorkspaceContext, seriesId: string): ScheduleRow | undefined {
  return ctx.store.db.prepare("SELECT * FROM vorlage_schedule WHERE workspace_id = ? AND series_id = ? AND status = 'active'").get(ctx.workspaceId, seriesId) as
    | ScheduleRow
    | undefined;
}

function endSchedule(ctx: WorkspaceContext, scheduleId: string, reason: string): boolean {
  const at = ctx.clock.now();
  const changed = ctx.store.db
    .prepare("UPDATE vorlage_schedule SET status = 'ended', ended_at = ?, ended_by = ?, end_reason = ? WHERE workspace_id = ? AND id = ? AND status = 'active'")
    .run(at, ctx.actor, reason, ctx.workspaceId, scheduleId).changes;
  if (changed === 1) ctx.audit.record({ entityKind: 'vorlage_schedule', entityId: scheduleId, action: 'close', actor: ctx.actor, at });
  return changed === 1;
}

// --- set_vorlage_schedule ---------------------------------------------------------------------------------

export interface SetVorlageScheduleInput {
  vorlageId?: unknown;
  every?: unknown;
  anchorDay?: unknown;
  start?: unknown;
  end?: unknown;
  mode?: unknown;
  asks?: unknown;
  idempotencyKey?: unknown;
}

export type SetVorlageScheduleOk = { schedule: VorlageScheduleView; replacedScheduleId: string | null };

/** Mode `post` is a person's act: a governed seat is refused, under every dial, as a call and a proposal. */
export function schedulePostHumanOnly(ctx: WorkspaceContext, input: { mode?: unknown }): Err | undefined {
  if (input.mode !== 'post' || !isGovernedSeat(ctx.store, ctx.actor)) return undefined;
  return err('human_only', { field: 'mode', reason: 'only a person lets a Vorlage post by itself; an agent may set a schedule that proposes' }) as Err;
}

/** The shape checks of a schedule input, without reading the book. */
function scheduleShapeRefusal(input: SetVorlageScheduleInput): Err | undefined {
  const guard = requireString(input.vorlageId, 'vorlageId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (typeof input.every !== 'string' || !(SCHEDULE_EVERY as readonly string[]).includes(input.every)) return err('invalid_input', { field: 'every', allowed: [...SCHEDULE_EVERY] });
  if (!Number.isInteger(input.anchorDay) || (input.anchorDay as number) < 1 || (input.anchorDay as number) > 31) return err('invalid_input', { field: 'anchorDay', reason: 'a day of the month, 1 to 31 (31 is the last day)' });
  if (!isIsoDate(input.start)) return err('invalid_input', { field: 'start', reason: 'an ISO date YYYY-MM-DD' });
  if (input.end !== undefined && input.end !== null) {
    if (!isIsoDate(input.end)) return err('invalid_input', { field: 'end', reason: 'an ISO date YYYY-MM-DD' });
    if ((input.end as string) < (input.start as string)) return err('invalid_input', { field: 'end', reason: 'the end is before the start' });
  }
  const mode = input.mode ?? 'propose';
  if (typeof mode !== 'string' || !(SCHEDULE_MODES as readonly string[]).includes(mode)) return err('invalid_input', { field: 'mode', allowed: [...SCHEDULE_MODES] });
  const parsed = parseTemplate({ standardId: input.vorlageId, asks: input.asks ?? {} });
  if ('error' in parsed) return parsed.error;
  return undefined;
}

/**
 * Set the schedule of a Vorlage (`vorlageId`: its LIVE version). Replaces the series' active schedule in the
 * same transaction (one live schedule per series). The asked amounts are checked now: the Vorlage must book
 * with them on the start date (`ask_missing`, `rest_is_zero`, ... as `post_entry` answers them). `post`
 * records the version the person confirmed.
 */
export function setVorlageSchedule(ctx: WorkspaceContext, input: SetVorlageScheduleInput): Result<SetVorlageScheduleOk> {
  const human = schedulePostHumanOnly(ctx, input);
  if (human !== undefined) return human;
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const shape = scheduleShapeRefusal(input);
  if (shape !== undefined) return shape;
  const vorlageId = input.vorlageId as string;
  const scopedKey = JSON.stringify(['set_vorlage_schedule', vorlageId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<SetVorlageScheduleOk>>(ctx.workspaceId, scopedKey, 'set_vorlage_schedule');
  if (replayed !== undefined) return replayed;
  const vorlage = readLiveRule(ctx, vorlageId);
  if (vorlage === undefined) return err('rule_not_found', { standardId: vorlageId, reason: 'no live Vorlage of this workspace has this id (an older version, another workspace\'s, or removed)' });
  if (vorlage.scope !== 'manual') return err('wrong_scope', { standardId: vorlageId, scope: vorlage.scope, reason: 'a schedule runs a Vorlage; a bank rule books bank lines' });
  const asks = (parseTemplate({ standardId: vorlageId, asks: input.asks ?? {} }) as { template: { asks: Record<string, number> } }).template.asks;
  const composed = composeTemplate(ctx, { date: input.start as string, template: { standardId: vorlageId, asks } });
  if (!composed.ok) return composed;
  if (!composed.verdict.ok) return composed.verdict as Err;
  const seriesId = seriesOf(ctx, vorlageId) ?? vorlageId;
  const mode = (input.mode ?? 'propose') as ScheduleMode;
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'set_vorlage_schedule', () => {
    const previous = activeScheduleOf(ctx, seriesId);
    if (previous !== undefined) endSchedule(ctx, previous.id, 'replaced');
    const id = ctx.ids.next('vsched');
    const at = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO vorlage_schedule (id, workspace_id, series_id, every, anchor_day, start_date, end_date, mode, asks_json, post_version_id, set_by, set_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(
        id,
        ctx.workspaceId,
        seriesId,
        input.every as string,
        input.anchorDay as number,
        input.start as string,
        (input.end as string | null | undefined) ?? null,
        mode,
        JSON.stringify(asks),
        mode === 'post' ? vorlageId : null,
        ctx.actor,
        at,
      );
    ctx.audit.record({ entityKind: 'vorlage_schedule', entityId: id, action: 'create', actor: ctx.actor, at });
    const row = ctx.store.db.prepare('SELECT * FROM vorlage_schedule WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) as ScheduleRow;
    return ok<SetVorlageScheduleOk>({ schedule: scheduleView(ctx, row), replacedScheduleId: previous?.id ?? null });
  });
}

// --- clear_vorlage_schedule -------------------------------------------------------------------------------

/** End one schedule. Its runs stay; nothing posted is touched. An ended schedule answers `alreadyEnded`. */
export function clearVorlageSchedule(ctx: WorkspaceContext, input: { scheduleId?: unknown; idempotencyKey?: unknown }): Result<{ schedule: VorlageScheduleView; alreadyEnded: boolean }> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard = requireString(input.scheduleId, 'scheduleId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const scopedKey = JSON.stringify(['clear_vorlage_schedule', input.scheduleId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<{ schedule: VorlageScheduleView; alreadyEnded: boolean }>>(ctx.workspaceId, scopedKey, 'clear_vorlage_schedule');
  if (replayed !== undefined) return replayed;
  const row = ctx.store.db.prepare('SELECT * FROM vorlage_schedule WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, input.scheduleId) as ScheduleRow | undefined;
  if (row === undefined) return err('not_found', { scheduleId: input.scheduleId });
  if (row.status !== 'active') return ok({ schedule: scheduleView(ctx, row), alreadyEnded: true });
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'clear_vorlage_schedule', () => {
    endSchedule(ctx, row.id, 'cleared');
    const after = ctx.store.db.prepare('SELECT * FROM vorlage_schedule WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, row.id) as ScheduleRow;
    return ok({ schedule: scheduleView(ctx, after), alreadyEnded: false });
  });
}

// --- vorlage_schedules ------------------------------------------------------------------------------------

/** One run as the reads answer it. */
export interface VorlageScheduleRunView {
  runId: string;
  period: string;
  dueDate: string;
  scheduleId: string;
  outcome: 'posted' | 'proposed' | 'skipped';
  entryId: string | null;
  actionId: string | null;
  /** A proposed run's Vorschlag now: pending, executed, rejected or stale. */
  actionStatus: string | null;
  versionId: string | null;
  reason: string | null;
  seen: boolean;
}

export type VorlageSchedulesOk = { schedules: (VorlageScheduleView & { runs: VorlageScheduleRunView[] })[] };

/** `vorlage_schedules`: every schedule (of one Vorlage's series, or all), newest first, with its runs. Read-only. */
export function listVorlageSchedules(ctx: WorkspaceContext, input: { vorlageId?: unknown } = {}): Result<VorlageSchedulesOk> {
  let seriesId: string | null = null;
  if (input.vorlageId !== undefined && input.vorlageId !== null) {
    if (typeof input.vorlageId !== 'string' || input.vorlageId.length === 0) return err('invalid_input', { field: 'vorlageId' });
    if (readRuleRow(ctx, input.vorlageId) === undefined) return err('rule_not_found', { standardId: input.vorlageId });
    seriesId = seriesOf(ctx, input.vorlageId);
  }
  const rows = (
    seriesId === null
      ? ctx.store.db.prepare('SELECT * FROM vorlage_schedule WHERE workspace_id = ? ORDER BY set_at DESC, rowid DESC').all(ctx.workspaceId)
      : ctx.store.db.prepare('SELECT * FROM vorlage_schedule WHERE workspace_id = ? AND series_id = ? ORDER BY set_at DESC, rowid DESC').all(ctx.workspaceId, seriesId)
  ) as ScheduleRow[];
  const runsOf = ctx.store.db.prepare(
    `SELECT r.*, a.status AS action_status,
            EXISTS (SELECT 1 FROM autopilot_seen s WHERE s.workspace_id = r.workspace_id AND s.kind = 'schedule_run' AND s.ref = r.id) AS seen
       FROM vorlage_schedule_run r LEFT JOIN agent_action a ON a.workspace_id = r.workspace_id AND a.id = r.action_id
      WHERE r.workspace_id = ? AND r.schedule_id = ? ORDER BY r.due_date DESC, r.rowid DESC`,
  );
  return ok<VorlageSchedulesOk>({
    schedules: rows.map((s) => ({
      ...scheduleView(ctx, s),
      runs: (runsOf.all(ctx.workspaceId, s.id) as (RunRow & { action_status: string | null; seen: number })[]).map((r) => ({
        runId: r.id,
        period: r.period,
        dueDate: r.due_date,
        scheduleId: r.schedule_id,
        outcome: r.outcome,
        entryId: r.entry_id,
        actionId: r.action_id,
        actionStatus: r.action_status,
        versionId: r.version_id,
        reason: r.reason,
        seen: r.seen === 1,
      })),
    })),
  });
}

/**
 * The runs Pendenzen notes (kind `note`): skipped ones, and proposed ones that were meant to post (the right
 * was gone, the Vorlage changed), nobody marked seen, newest first, within the last `days` days.
 */
export function scheduleRunNotes(ctx: WorkspaceContext, days = 120): { runId: string; seriesId: string; label: string | null; period: string; dueDate: string; outcome: string; reason: string; actionId: string | null }[] {
  const from = new Date(Date.parse(`${swissToday(ctx)}T12:00:00.000Z`) - days * 86_400_000).toISOString().slice(0, 10);
  const rows = ctx.store.db
    .prepare(
      `SELECT r.id, r.series_id, r.period, r.due_date, r.outcome, r.reason, r.action_id FROM vorlage_schedule_run r
        WHERE r.workspace_id = ? AND r.due_date >= ?
          AND (r.outcome = 'skipped' OR r.reason IN ('no_post_right', 'vorlage_changed', 'vorlage_cleared'))
          AND NOT EXISTS (SELECT 1 FROM autopilot_seen s WHERE s.workspace_id = r.workspace_id AND s.kind = 'schedule_run' AND s.ref = r.id)
        ORDER BY r.due_date DESC, r.rowid DESC`,
    )
    .all(ctx.workspaceId, from) as { id: string; series_id: string; period: string; due_date: string; outcome: string; reason: string; action_id: string | null }[];
  return rows.map((r) => {
    const live = liveHeadOf(ctx, r.series_id);
    return {
      runId: r.id,
      seriesId: r.series_id,
      label: readRuleRow(ctx, live ?? r.series_id)?.label ?? null,
      period: r.period,
      dueDate: r.due_date,
      outcome: r.outcome,
      reason: r.reason,
      actionId: r.action_id,
    };
  });
}

// --- The step ---------------------------------------------------------------------------------------------

/** What the scheduler hands the step: the registry's own `post_entry`, and a seat's live `post` right. */
export interface DauerbuchungenPorts {
  /** Post through the shared dispatch's `post_entry` as `actor` (A24 checked against them, live). */
  post(actor: string, input: Record<string, unknown>): Result;
  /** Does `actor` hold `post` in this workspace now? */
  holdsPost(actor: string): boolean;
}

export interface DauerbuchungenReport {
  runs: { scheduleId: string; period: string; dueDate: string; outcome: 'posted' | 'proposed' | 'skipped'; reason: string | null }[];
  reproposed: { runId: string; actionId: string }[];
  ended: { scheduleId: string; reason: string }[];
}

class PostRefused {
  constructor(readonly result: Result) {}
}

function insertRun(
  ctx: WorkspaceContext,
  s: ScheduleRow,
  run: { period: string; dueDate: string; outcome: 'posted' | 'proposed' | 'skipped'; entryId?: string | null; actionId?: string | null; versionId?: string | null; reason?: string | null },
): string {
  const id = ctx.ids.next('vsrun');
  const at = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO vorlage_schedule_run (id, workspace_id, series_id, period, due_date, schedule_id, outcome, entry_id, action_id, version_id, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ctx.workspaceId, s.series_id, run.period, run.dueDate, s.id, run.outcome, run.entryId ?? null, run.actionId ?? null, run.versionId ?? null, run.reason ?? null, at, at);
  return id;
}

/** The text of a scheduled entry: the Vorlage's name and its period. */
function entryText(label: string | null, period: string): string {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  const when = quarter !== null ? `Q${quarter[2]} ${quarter[1]}` : /^\d{4}-\d{2}$/.test(period) ? `${period.slice(5, 7)}.${period.slice(0, 4)}` : period;
  return `${(label ?? '').trim() || 'Dauerbuchung'} ${when}`;
}

/** Draft the Vorschlag of one period as `system`: `post_entry { template }` dated the due date. */
function proposeRun(ctx: WorkspaceContext, s: ScheduleRow, version: string, dueDate: string, period: string, asks: Record<string, number>): string | null {
  const label = readRuleRow(ctx, version)?.label ?? null;
  const key = scheduleRunKey(s.series_id, period);
  const payload: Record<string, unknown> = {
    workspaceId: ctx.workspaceId,
    date: dueDate,
    source: 'manual',
    description: entryText(label, period),
    template: { standardId: version, asks },
    idempotencyKey: key,
  };
  const drafted = enqueueDraftedAction({ ...ctx, actor: SCHEDULE_SYSTEM_ACTOR }, { actionTool: 'post_entry', payload, dialCapability: null, idempotencyKey: key });
  return drafted.ok ? String(drafted['actionId']) : null;
}

/**
 * A proposed run whose Vorschlag went stale before anyone approved it (the Vorlage changed, or it was voided)
 * is proposed again from the live version, under the same key, and the run is re-pointed at it. A rejected
 * one stays rejected (a person said no); one whose act committed or whose key is spent ran and stays.
 */
function reproposeStale(ctx: WorkspaceContext, s: ScheduleRow, live: string | null, report: DauerbuchungenReport): void {
  const runs = ctx.store.db
    .prepare("SELECT * FROM vorlage_schedule_run WHERE workspace_id = ? AND series_id = ? AND outcome = 'proposed'")
    .all(ctx.workspaceId, s.series_id) as RunRow[];
  for (const r of runs) {
    const action = ctx.store.db
      .prepare('SELECT status, committed_at, payload_json FROM agent_action WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, r.action_id) as { status: string; committed_at: string | null; payload_json: string } | undefined;
    if (action === undefined || action.committed_at !== null) continue;
    if (action.status !== 'pending' && action.status !== 'stale') continue;
    const key = scheduleRunKey(s.series_id, r.period);
    if (ctx.store.recallIdempotent(ctx.workspaceId, key, 'post_entry') !== undefined) continue;
    let version: unknown;
    try {
      version = (JSON.parse(action.payload_json) as { template?: { standardId?: unknown } }).template?.standardId;
    } catch {
      version = undefined;
    }
    if (action.status === 'pending' && version === live) continue;
    let asks: Record<string, number> = {};
    try {
      asks = (JSON.parse(action.payload_json) as { template?: { asks?: Record<string, number> } }).template?.asks ?? {};
    } catch {
      asks = {};
    }
    ctx.store.tx(() => {
      ctx.store.db
        .prepare("UPDATE agent_action SET status = 'stale', resolved_at = ?, resolved_by = ? WHERE workspace_id = ? AND id = ? AND status = 'pending' AND committed_at IS NULL")
        .run(ctx.clock.now(), SCHEDULE_SYSTEM_ACTOR, ctx.workspaceId, r.action_id);
      if (live === null) {
        if (r.reason !== 'vorlage_cleared') {
          ctx.store.db
            .prepare("UPDATE vorlage_schedule_run SET reason = 'vorlage_cleared', updated_at = ? WHERE workspace_id = ? AND id = ?")
            .run(ctx.clock.now(), ctx.workspaceId, r.id);
        }
        return;
      }
      const actionId = proposeRun(ctx, s, live, r.due_date, r.period, asks);
      if (actionId === null) return;
      ctx.store.db
        .prepare('UPDATE vorlage_schedule_run SET action_id = ?, version_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(actionId, live, ctx.clock.now(), ctx.workspaceId, r.id);
      report.reproposed.push({ runId: r.id, actionId });
    });
  }
}

/** One schedule's share of the tick. */
function runSchedule(ctx: WorkspaceContext, ports: DauerbuchungenPorts, s: ScheduleRow, today: string, report: DauerbuchungenReport): void {
  const live = liveHeadOf(ctx, s.series_id);
  reproposeStale(ctx, s, live, report);
  const all = dueDates(shapeOf(s), today);
  const current = all[all.length - 1] ?? null;
  // Critic N04 F5: a schedule an agent set never has more than `rules.vorlage_agent_open_max` Vorschläge
  // waiting; the rest follow once a person decided them, in order, none skipped.
  let cap = SCHEDULE_CATCH_UP_CAP;
  if (isGovernedSeat(ctx.store, s.set_by)) {
    const waiting = ctx.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM vorlage_schedule_run r JOIN agent_action a ON a.workspace_id = r.workspace_id AND a.id = r.action_id
          WHERE r.workspace_id = ? AND r.series_id = ? AND r.outcome = 'proposed' AND a.status = 'pending'`,
      )
      .get(ctx.workspaceId, s.series_id) as { n: number };
    cap = Math.max(0, Math.min(cap, getSetting<number>(ctx, 'rules.vorlage_agent_open_max') - waiting.n));
  }
  const owed = owedDueDates(ctx, s, today).slice(0, cap);
  let asks: Record<string, number> = {};
  try {
    asks = JSON.parse(s.asks_json) as Record<string, number>;
  } catch {
    asks = {};
  }
  for (const dueDate of owed) {
    const period = periodOf(dueDate, s.every);
    const record = (run: { outcome: 'posted' | 'proposed' | 'skipped'; entryId?: string | null; actionId?: string | null; versionId?: string | null; reason?: string | null }): void => {
      report.runs.push({ scheduleId: s.id, period, dueDate, outcome: run.outcome, reason: run.reason ?? null });
    };
    if (live === null) {
      // The Vorlage was cleared: the run is skipped with a Pendenz, and the schedule ends.
      ctx.store.tx(() => {
        insertRun(ctx, s, { period, dueDate, outcome: 'skipped', reason: 'vorlage_cleared' });
        endSchedule({ ...ctx, actor: SCHEDULE_SYSTEM_ACTOR }, s.id, 'vorlage_cleared');
      });
      record({ outcome: 'skipped', reason: 'vorlage_cleared' });
      report.ended.push({ scheduleId: s.id, reason: 'vorlage_cleared' });
      return;
    }
    const open = ctx.periods.assertOpen(dueDate);
    if (!open.ok) {
      ctx.store.tx(() => insertRun(ctx, s, { period, dueDate, outcome: 'skipped', versionId: live, reason: 'period_locked' }));
      record({ outcome: 'skipped', reason: 'period_locked' });
      continue;
    }
    const composed = composeTemplate(ctx, { date: dueDate, template: { standardId: live, asks } });
    const verdict: Result = !composed.ok ? composed : composed.verdict;
    if (!verdict.ok) {
      const reason = String(verdict.error);
      ctx.store.tx(() => insertRun(ctx, s, { period, dueDate, outcome: 'skipped', versionId: live, reason }));
      record({ outcome: 'skipped', reason });
      continue;
    }
    let mode: ScheduleMode = s.mode;
    let why: string | null = null;
    if (mode === 'post') {
      if (s.post_version_id !== live) [mode, why] = ['propose', 'vorlage_changed'];
      else if (current !== null && dueDate < current) [mode, why] = ['propose', 'catch_up'];
      else if (isGovernedSeat(ctx.store, s.set_by) || !ports.holdsPost(s.set_by)) [mode, why] = ['propose', 'no_post_right'];
    }
    const key = scheduleRunKey(s.series_id, period);
    if (mode === 'post') {
      const label = readRuleRow(ctx, live)?.label ?? null;
      try {
        ctx.store.tx(() => {
          const res = ports.post(s.set_by, {
            workspaceId: ctx.workspaceId,
            date: dueDate,
            source: 'manual',
            description: entryText(label, period),
            template: { standardId: live, asks },
            idempotencyKey: key,
          });
          if (!res.ok) throw new PostRefused(res);
          insertRun(ctx, s, { period, dueDate, outcome: 'posted', entryId: String(res['entryId']), versionId: live });
        });
        record({ outcome: 'posted' });
      } catch (e) {
        if (!(e instanceof PostRefused)) throw e;
        const reason = e.result.ok ? 'unexpected' : String(e.result.error);
        ctx.store.tx(() => insertRun(ctx, s, { period, dueDate, outcome: 'skipped', versionId: live, reason }));
        record({ outcome: 'skipped', reason });
      }
      continue;
    }
    ctx.store.tx(() => {
      const actionId = proposeRun(ctx, s, live, dueDate, period, asks);
      if (actionId === null) throw new Error(`vorlage schedule ${s.id}: the Vorschlag for ${period} could not be drafted`);
      insertRun(ctx, s, { period, dueDate, outcome: 'proposed', actionId, versionId: live, reason: why });
    });
    record({ outcome: 'proposed', reason: why });
  }
}

/**
 * THE STEP, once per tick per workspace. `ctx` is a wired context acting as `system`; a direct posting runs
 * through `ports.post` as the person who set the schedule. Each period is its own transaction. One poisoned
 * schedule never stops another (its failure is the caller's diagnostics entry, and the next tick decides).
 */
export function runDauerbuchungenStep(ctx: WorkspaceContext, ports: DauerbuchungenPorts, onError?: (scheduleId: string, e: unknown) => void): DauerbuchungenReport {
  const report: DauerbuchungenReport = { runs: [], reproposed: [], ended: [] };
  const today = swissToday(ctx);
  const schedules = ctx.store.db
    .prepare("SELECT * FROM vorlage_schedule WHERE workspace_id = ? AND status = 'active' ORDER BY set_at, rowid")
    .all(ctx.workspaceId) as ScheduleRow[];
  for (const s of schedules) {
    try {
      runSchedule(ctx, ports, s, today, report);
    } catch (e) {
      onError?.(s.id, e);
    }
  }
  return report;
}
