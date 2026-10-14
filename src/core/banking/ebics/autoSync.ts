/**
 * D142, THE DAILY AUTOMATIC FETCH (A36 §12): when a connection is due, which attempt this is, what an
 * attempt left behind, and when the next one runs. Pure over the book and an injected instant; the
 * `till up` scheduler tick (`src/api/scheduler.ts`) is the only caller that ACTS on it, and it acts
 * through the registry's own `bank_sync`, never around it.
 *
 * WHY NOT A G01 RULE. `bank_sync` stays on the G01 denylist (D-A36.10's protection for stored rules
 * stands): a rule could fire it at any cadence, from any event, as its author. The daily fetch is one
 * explicit branch of the tick, run as `system`, with its own small rules written down here:
 *
 *  - DUE when the connection is active, its mode is `daily` (a connection that never set one is daily),
 *    the Swiss local time (Europe/Zurich) is at or after its `atTime` (default 07:00), and it has no
 *    successful fetch since `atTime` today. A fetch the owner pressed after `atTime` counts; one pressed
 *    at 05:00 does not, because ZKB may not have cut the day-end statement yet.
 *  - The tick at `till up` start is the catch-up: TILL closed at 07:00 fetches as soon as it runs.
 *  - AT MOST THREE ATTEMPTS a Swiss day. A bank that did not answer (`channel_unreachable`) or answered
 *    busy (`download_refused`, kind `busy`), a worker that failed and a busy book are retried an hour
 *    after the attempt ended. Every other refusal (a locked keystore, a pending activation, changed bank
 *    keys, a retired or blocked channel, no transport, a permission) needs a person and is not retried
 *    that day. A locked keystore is one of those (critic F3, D142): the sync worker rebuilds its
 *    keystore from the boot recipe, so a store locked at boot stays locked in every attempt until TILL
 *    is restarted with the passphrase; a retry could never succeed.
 *  - Each attempt carries the idempotency key `a36-auto-<connection>-<day>-<attempt>`, so a tick that
 *    fires twice for one attempt fetches once.
 *
 * Every attempt is one appended row of `bank_auto_sync_run`; nothing here updates or deletes one.
 */

import type { WorkspaceContext } from '../../context.js';
import type { Result } from '../../result.js';
import { capabilityFor, isGovernedSeat } from '../../access/capability.js';

/** The two modes (§H-ENUM, single point). */
export const AUTO_SYNC_MODES = ['daily', 'off'] as const;
export type AutoSyncMode = (typeof AUTO_SYNC_MODES)[number];

export const DEFAULT_AUTO_SYNC_AT = '07:00';
export const AUTO_SYNC_TIME_ZONE = 'Europe/Zurich';
export const AUTO_SYNC_MAX_ATTEMPTS = 3;
export const AUTO_SYNC_RETRY_MS = 60 * 60_000;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isAutoSyncMode(x: unknown): x is AutoSyncMode {
  return typeof x === 'string' && (AUTO_SYNC_MODES as readonly string[]).includes(x);
}

export function isAutoSyncTime(x: unknown): x is string {
  return typeof x === 'string' && HHMM.test(x);
}

// --- Swiss local time ------------------------------------------------------------------------------

const FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: AUTO_SYNC_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** The Swiss calendar day and wall-clock time of an instant. */
export function zurichParts(instant: string | number): { date: string; time: string } {
  const parts = FORMAT.formatToParts(new Date(instant));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

/** The UTC instant of a Swiss wall-clock time on a Swiss day (DST-correct, two offset passes). */
export function zurichInstant(date: string, time: string): string {
  const naive = Date.parse(`${date}T${time}:00.000Z`);
  let guess = naive;
  for (let i = 0; i < 2; i += 1) {
    const seen = zurichParts(guess);
    const seenMs = Date.parse(`${seen.date}T${seen.time}:00.000Z`);
    guess += naive - seenMs;
  }
  return new Date(guess).toISOString();
}

/** The next Swiss day. */
export function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// --- Settings, attempts, decision -----------------------------------------------------------------

export interface AutoSyncConnectionRow {
  id: string;
  state: string;
  last_sync_at: string | null;
  auto_sync_mode: string | null;
  auto_sync_at: string | null;
  /** Critic F1: who last set the schedule (NULL = never set). */
  auto_sync_actor: string | null;
}

/** The owner seat the automatic fetch falls back to (D13's Studio actor, seated by every provisioning). */
export const AUTO_SYNC_FALLBACK_ACTOR = 'studio';

/**
 * CRITIC F1: WHO the automatic fetch runs as. There is no automation identity (G01's rule): the attempt
 * runs as a real actor whose `pay` right A24 checks LIVE, at this attempt. First the actor who last set
 * the schedule, then the owner seat. A governed seat (the agent) never runs an unattended fetch: the
 * scheduler calls the verb directly, past the dial, so an agent actor here would bypass it. On an
 * unprovisioned book A24 grants every local actor, so the first candidate runs. Null means no seated
 * actor holds `pay`: a human-needed outcome (`auto_sync_no_actor`), never a guess.
 */
export function autoSyncActor(ctx: WorkspaceContext, conn: Pick<AutoSyncConnectionRow, 'auto_sync_actor'>): string | null {
  for (const actor of autoSyncTried(ctx, conn)) {
    if (capabilityFor(ctx.store, ctx.workspaceId, actor, 'pay')) return actor;
  }
  return null;
}

/**
 * Critic LB-1: the actors the automatic fetch actually TRIES, in order: the schedule's setter, then the
 * owner seat, each once, never a governed seat (an agent is skipped by design, see `autoSyncActor`).
 */
export function autoSyncTried(ctx: WorkspaceContext, conn: Pick<AutoSyncConnectionRow, 'auto_sync_actor'>): string[] {
  const candidates = [conn.auto_sync_actor, AUTO_SYNC_FALLBACK_ACTOR].filter((a): a is string => typeof a === 'string' && a.length > 0);
  return [...new Set(candidates)].filter((actor) => !isGovernedSeat(ctx.store, actor));
}

/**
 * Critic LB-1: who set the schedule, as far as the wording of `auto_sync_no_actor` needs it.
 * - `none`: nobody set it (`auto_sync_actor` NULL or empty); only the owner seat is tried.
 * - `owner`: the owner seat set it; only the owner seat is tried.
 * - `agent`: a governed seat set it; it is never tried, so the fetch runs as the owner seat alone.
 * - `person`: a seated person other than the owner seat set it; that person is tried, then the owner seat.
 */
export type AutoSyncSetterKind = 'none' | 'owner' | 'agent' | 'person';

export function autoSyncSetterKind(ctx: WorkspaceContext, conn: Pick<AutoSyncConnectionRow, 'auto_sync_actor'>): AutoSyncSetterKind {
  const setter = conn.auto_sync_actor;
  if (typeof setter !== 'string' || setter.length === 0) return 'none';
  if (setter === AUTO_SYNC_FALLBACK_ACTOR) return 'owner';
  return isGovernedSeat(ctx.store, setter) ? 'agent' : 'person';
}

/**
 * CRITIC R3-2 (D142), LB-1 (D143): the `auto_sync_no_actor` reason, true to the actors actually tried.
 * Only a `person` setter makes it two parties; every other kind tried the owner seat alone.
 */
export function autoSyncNoActorReason(setter: AutoSyncSetterKind): string {
  const remedy = 'restore pay to the owner seat, or set the schedule as a person who holds it';
  switch (setter) {
    case 'person':
      return 'neither the actor who set the schedule nor the owner seat (studio) holds pay; restore it to one of them, or set the schedule as someone who holds it';
    case 'agent':
      return `an agent set the schedule, and an agent never runs the unattended fetch, so it runs as the owner seat (studio), which does not hold pay; ${remedy}`;
    case 'owner':
      return `the owner seat (studio) set the schedule and the fetch runs as it, but it does not hold pay; ${remedy}`;
    case 'none':
      return 'nobody has set the schedule, so it runs as the owner seat (studio), which does not hold pay; restore pay to the owner seat, or set the schedule as someone who holds it';
  }
}

export interface AutoSyncSettings {
  mode: AutoSyncMode;
  atTime: string;
  /** False when the connection never set a mode: the owner's default (daily at 07:00) applies. */
  explicit: boolean;
}

export function autoSyncSettings(row: Pick<AutoSyncConnectionRow, 'auto_sync_mode' | 'auto_sync_at'>): AutoSyncSettings {
  return {
    mode: isAutoSyncMode(row.auto_sync_mode) ? row.auto_sync_mode : 'daily',
    atTime: isAutoSyncTime(row.auto_sync_at) ? row.auto_sync_at : DEFAULT_AUTO_SYNC_AT,
    explicit: row.auto_sync_mode !== null,
  };
}

interface AttemptRow {
  local_date: string;
  attempt: number;
  idempotency_key: string;
  started_at: string;
  finished_at: string;
  outcome_ok: number;
  outcome_code: string;
  retryable: number;
  run_as: string | null;
  detail: string | null;
}

/** One automatic attempt as the status and the band read it. */
export interface AutoSyncAttemptView {
  localDate: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  /** The download outcome on success (`downloaded`, `no_data`), else the refusal code. */
  code: string;
  retryable: boolean;
  /** Critic F1: the seated actor the attempt ran as, or null when none held `pay`. */
  runAs: string | null;
  detail: Record<string, unknown> | null;
}

function viewOf(row: AttemptRow): AutoSyncAttemptView {
  let detail: Record<string, unknown> | null = null;
  try {
    detail = row.detail === null ? null : (JSON.parse(row.detail) as Record<string, unknown>);
  } catch {
    detail = null;
  }
  return {
    localDate: row.local_date,
    attempt: row.attempt,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ok: row.outcome_ok === 1,
    code: row.outcome_code,
    retryable: row.retryable === 1,
    runAs: row.run_as,
    detail,
  };
}

function attemptsOn(ctx: WorkspaceContext, connectionId: string, localDate: string): AttemptRow[] {
  return ctx.store.db
    .prepare(
      `SELECT local_date, attempt, idempotency_key, started_at, finished_at, outcome_ok, outcome_code, retryable, run_as, detail
         FROM bank_auto_sync_run WHERE workspace_id = ? AND connection_id = ? AND local_date = ? ORDER BY attempt, rowid`,
    )
    .all(ctx.workspaceId, connectionId, localDate) as AttemptRow[];
}

function lastAttempt(ctx: WorkspaceContext, connectionId: string): AttemptRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT local_date, attempt, idempotency_key, started_at, finished_at, outcome_ok, outcome_code, retryable, run_as, detail
         FROM bank_auto_sync_run WHERE workspace_id = ? AND connection_id = ? ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, connectionId) as AttemptRow | undefined;
}

/**
 * D150: the latest automatic attempt of a connection and how many attempts its Swiss day already
 * holds, so `bank_fetch_failed` can tell a failure that will be retried from one that waits for a person.
 */
export function latestAutoAttempt(ctx: WorkspaceContext, connectionId: string): { attempt: AutoSyncAttemptView; attemptsThatDay: number } | null {
  const last = lastAttempt(ctx, connectionId);
  if (last === undefined) return null;
  return { attempt: viewOf(last), attemptsThatDay: attemptsOn(ctx, connectionId, last.local_date).length };
}

export type AutoSyncDecision =
  | { due: true; localDate: string; attempt: number; idempotencyKey: string }
  | { due: false; reason: 'off' | 'not_active' | 'before_time' | 'fetched_today' | 'attempts_exhausted' | 'needs_person' | 'retry_later'; nextAt: string | null };

/** The idempotency key of one automatic attempt (A36 §12). */
export function autoSyncKey(connectionId: string, localDate: string, attempt: number): string {
  return `a36-auto-${connectionId}-${localDate}-${attempt}`;
}

/**
 * Is the connection due for an automatic fetch at `now`? The one rule the tick and the read models
 * share, so the band's "next run" is the moment the tick will really act.
 */
export function autoSyncDecision(ctx: WorkspaceContext, conn: AutoSyncConnectionRow, now: string): AutoSyncDecision {
  const settings = autoSyncSettings(conn);
  if (settings.mode === 'off') return { due: false, reason: 'off', nextAt: null };
  if (conn.state !== 'active') return { due: false, reason: 'not_active', nextAt: null };
  const local = zurichParts(now);
  const todayAt = zurichInstant(local.date, settings.atTime);
  const tomorrowAt = zurichInstant(nextDay(local.date), settings.atTime);
  if (now < todayAt) return { due: false, reason: 'before_time', nextAt: todayAt };
  if (conn.last_sync_at !== null && conn.last_sync_at >= todayAt) return { due: false, reason: 'fetched_today', nextAt: tomorrowAt };
  const today = attemptsOn(ctx, conn.id, local.date);
  const last = today[today.length - 1];
  if (last !== undefined && last.outcome_ok === 1) return { due: false, reason: 'fetched_today', nextAt: tomorrowAt };
  if (today.length >= AUTO_SYNC_MAX_ATTEMPTS) return { due: false, reason: 'attempts_exhausted', nextAt: tomorrowAt };
  if (last !== undefined && last.retryable !== 1) return { due: false, reason: 'needs_person', nextAt: tomorrowAt };
  if (last !== undefined) {
    const retryAt = new Date(Date.parse(last.finished_at) + AUTO_SYNC_RETRY_MS).toISOString();
    if (now < retryAt) return { due: false, reason: 'retry_later', nextAt: retryAt };
  }
  const attempt = today.length + 1;
  return { due: true, localDate: local.date, attempt, idempotencyKey: autoSyncKey(conn.id, local.date, attempt) };
}

/** The active EBICS connections of the workspace, with what the tick needs. */
export function autoSyncConnections(ctx: WorkspaceContext): AutoSyncConnectionRow[] {
  return ctx.store.db
    .prepare(
      `SELECT id, state, last_sync_at, auto_sync_mode, auto_sync_at, auto_sync_actor FROM ebics_connection
        WHERE workspace_id = ? AND state = 'active' ORDER BY created_at, rowid`,
    )
    .all(ctx.workspaceId) as AutoSyncConnectionRow[];
}

/**
 * Whether an attempt that answered `result` is retried later today: a bank that did not answer or was
 * busy, a failed worker, a refusal marked retryable. Never a locked keystore (critic F3, D142).
 */
export function isRetryableAutoOutcome(result: Result): boolean {
  if (result.ok) return false;
  if (result.error === 'channel_unreachable') return true;
  // Critic F2: the host's worker failed (timeout, crash) or the book was busy: nothing a person clears.
  if (result.error === 'sync_worker_failed') return true;
  if (result.retryable === true && result.error !== 'sync_in_progress') return true;
  if (result.error === 'download_refused' && result.kind === 'busy') return true;
  return false;
}

/**
 * Did the attempt FETCH? An ok answer that names `needs_bank_transport` reached no bank (no wire is
 * wired in this process): it is recorded as not fetched, and, like every non-retryable outcome, it is
 * not tried again that day.
 */
function fetched(result: Result): boolean {
  return result.ok && result.reason !== 'needs_bank_transport';
}

/** The code an attempt is recorded under: the download outcome on success, the refusal code otherwise. */
function outcomeCode(result: Result): string {
  if (!result.ok) return typeof result.error === 'string' ? result.error : 'unexpected_error';
  const download = result.download as { outcome?: unknown } | undefined;
  if (download !== undefined && typeof download.outcome === 'string') return download.outcome;
  if (typeof result.reason === 'string') return result.reason;
  return 'ok';
}

/** What a band needs to word an attempt, and nothing that could carry bank data. */
function outcomeDetail(result: Result): Record<string, unknown> | null {
  const detail: Record<string, unknown> = {};
  if (result.ok) {
    const download = result.download as { newMembers?: unknown } | undefined;
    if (download !== undefined && typeof download.newMembers === 'number') detail.newMembers = download.newMembers;
    const statements = Array.isArray(result.statements) ? (result.statements as { outcome?: unknown; code?: unknown }[]) : [];
    detail.imported = statements.filter((s) => s.outcome === 'imported' || s.code === 'imported').length;
    if (typeof result.pendingStatements === 'number') detail.pendingStatements = result.pendingStatements;
  } else {
    if (typeof result.kind === 'string') detail.kind = result.kind;
    // A36 §4.7 (D150): the bank's raw EBICS return code of a refused download (090003, 091119, ...), so
    // the band, the panel and the attention item can name the bank's reason, not only its class. The
    // wire's own reason for a bank that did not answer (`transport_error`, ...) is kept the same way.
    // Both are short codes, never bank data.
    if (typeof result.code === 'string' && /^[0-9A-Za-z_]{1,40}$/.test(result.code)) detail.code = result.code;
    if (result.error === 'channel_unreachable' && typeof result.reason === 'string' && /^[0-9A-Za-z_]{1,60}$/.test(result.reason)) {
      detail.bankReason = result.reason;
    }
    if (typeof result.state === 'string') detail.state = result.state;
    // Critic LB-1: `auto_sync_no_actor` records the actors it actually tried.
    if (Array.isArray(result.tried)) detail.tried = result.tried;
  }
  return Object.keys(detail).length === 0 ? null : detail;
}

/** Append one attempt row (in a transaction). Never updates an earlier one. */
export function recordAutoSyncAttempt(
  ctx: WorkspaceContext,
  input: { connectionId: string; localDate: string; attempt: number; idempotencyKey: string; startedAt: string; finishedAt: string; result: Result; retryable: boolean; runAs: string | null },
): void {
  const detail = outcomeDetail(input.result);
  ctx.store.tx(() =>
    ctx.store.db
      .prepare(
        `INSERT INTO bank_auto_sync_run
           (id, workspace_id, connection_id, local_date, attempt, idempotency_key, started_at, finished_at, outcome_ok, outcome_code, retryable, run_as, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.ids.next('bas'),
        ctx.workspaceId,
        input.connectionId,
        input.localDate,
        input.attempt,
        input.idempotencyKey,
        input.startedAt,
        input.finishedAt,
        fetched(input.result) ? 1 : 0,
        outcomeCode(input.result),
        input.retryable ? 1 : 0,
        input.runAs,
        detail === null ? null : JSON.stringify(detail),
      ),
  );
}

/** The automatic fetch as the status and the band show it. */
export interface AutoSyncStatus {
  mode: AutoSyncMode;
  atTime: string;
  explicit: boolean;
  /** The last automatic attempt, on any day, or null before the first. */
  lastAuto: AutoSyncAttemptView | null;
  /** When the scheduler will next try (null when the mode is off or the channel is not active). */
  nextAt: string | null;
  attemptsToday: number;
  /** Critic F1: who the next automatic attempt would run as, checked now (null: no seated actor holds pay). */
  runsAs: string | null;
  /**
   * Critic R3-2, narrowed by LB-1: true only when a setter distinct from the owner seat is actually
   * tried (a `person` setter). False when nobody set the schedule, when the owner seat set it, and when
   * an agent set it (a governed seat is never tried). Kept for older readers; `scheduleSetter` says which.
   */
  setterKnown: boolean;
  /** Critic LB-1: who set the schedule (`AutoSyncSetterKind`). The band words `auto_sync_no_actor` by it. */
  scheduleSetter: AutoSyncSetterKind;
}

export function autoSyncStatus(ctx: WorkspaceContext, conn: AutoSyncConnectionRow, now: string): AutoSyncStatus {
  const settings = autoSyncSettings(conn);
  const decision = autoSyncDecision(ctx, conn, now);
  const last = lastAttempt(ctx, conn.id);
  const setter = autoSyncSetterKind(ctx, conn);
  return {
    mode: settings.mode,
    atTime: settings.atTime,
    explicit: settings.explicit,
    lastAuto: last === undefined ? null : viewOf(last),
    nextAt: decision.due ? now : decision.nextAt,
    attemptsToday: attemptsOn(ctx, conn.id, zurichParts(now).date).length,
    runsAs: autoSyncActor(ctx, conn),
    setterKnown: setter === 'person',
    scheduleSetter: setter,
  };
}
