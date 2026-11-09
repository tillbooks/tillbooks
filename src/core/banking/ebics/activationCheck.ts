/**
 * D143, THE DAILY ACTIVATION CHECK (A36 §12.1): which connections are checked, when the next check is
 * due, what a check left behind, and whether the bank is ready for the human key review. Pure over the
 * book and an injected instant; the one function that ACTS is `checkBankActivation` in `channel.ts`,
 * called only from the explicit `till up` scheduler branch (`src/api/scheduler.ts`), never by a rule.
 *
 * THE RULES, written down here once:
 *  - CHECKED only while an activation is in progress: `ini_sent` or `pending_bank_activation`. Active,
 *    retired, blocked, changed-key and keys-generated connections are never probed, and neither is one
 *    whose automatic mode is `off` (a person who turned automatic bank contact off gets none).
 *  - NOT CHECKED once the bank is ready for review (`bankReady`): the next move is the human compare.
 *  - DUE from the connection's `atTime` (default 07:00, Europe/Zurich), the D142 tick at start being the
 *    catch-up. ONE probe a Swiss day; a TRANSIENT failure (the bank did not answer, the answer was lost)
 *    is retried an hour after it, AT MOST TWICE. The bank's own not-yet answer (a code), a locked or
 *    unavailable keystore, no wire and no seated actor end the day.
 *
 * `bankReady` IS DERIVED, NEVER STORED: an activation in progress whose latest HPB in the append-only
 * order log answered `ok`, whether the probe fetched it or a human did. A stored flag could drift from the
 * order log; this cannot. Every check is one appended row of `ebics_activation_check`; nothing here
 * updates or deletes one. §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../../context.js';
import { AUTO_SYNC_RETRY_MS, autoSyncSettings, nextDay, zurichInstant, zurichParts } from './autoSync.js';
import { defaultEbicsKeystore } from './keystore.js';

/** The states an activation check runs in (§H-ENUM, single point). */
export const ACTIVATION_CHECK_STATES = ['ini_sent', 'pending_bank_activation'] as const;
/** One probe a day plus at most two retries after a transient failure. */
export const ACTIVATION_CHECK_MAX_ATTEMPTS = 3;

/** The outcomes a check is recorded under (§H-ENUM, single point). */
export const ACTIVATION_CHECK_OUTCOMES = [
  // Critic F7: the mark written BEFORE the probe. An attempt whose only row is `started` counts as an
  // attempt whose outcome nobody knows (like a lost answer): retried an hour later, within the day's cap.
  'started',
  'bank_ready',
  'not_activated',
  'channel_unreachable',
  'keystore_locked',
  'keystore_unavailable',
  'needs_bank_transport',
  'auto_sync_no_actor',
  // Critic R3-3: the worker that should have asked the bank failed in THIS process (or answered nothing),
  // so the bank was never asked. Recorded by the main thread only; `bank_code` says why.
  'worker_failed',
] as const;
export type ActivationCheckOutcome = (typeof ACTIVATION_CHECK_OUTCOMES)[number];

/** The order log's `related_kind` for an HPB the probe sent (a human's HPB carries none). */
export const ACTIVATION_CHECK_RELATED_KIND = 'activation_check';

export interface ActivationCheckConnectionRow {
  id: string;
  state: string;
  auto_sync_mode: string | null;
  auto_sync_at: string | null;
  auto_sync_actor: string | null;
}

export function isActivationInProgress(state: string): boolean {
  return (ACTIVATION_CHECK_STATES as readonly string[]).includes(state);
}

/** The connections of the workspace whose activation is in progress, with what the tick needs. */
export function activationCheckConnections(ctx: WorkspaceContext): ActivationCheckConnectionRow[] {
  return ctx.store.db
    .prepare(
      `SELECT id, state, auto_sync_mode, auto_sync_at, auto_sync_actor FROM ebics_connection
        WHERE workspace_id = ? AND state IN ('ini_sent', 'pending_bank_activation') ORDER BY created_at, rowid`,
    )
    .all(ctx.workspaceId) as ActivationCheckConnectionRow[];
}

/** The latest HPB order-log row of a connection (any origin), or undefined before the first. */
function latestHpb(ctx: WorkspaceContext, connectionId: string): { status: string; occurred_at: string } | undefined {
  return ctx.store.db
    .prepare(
      `SELECT status, occurred_at FROM ebics_order_log
        WHERE workspace_id = ? AND connection_id = ? AND order_type = 'HPB' ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, connectionId) as { status: string; occurred_at: string } | undefined;
}

/**
 * Is the bank ready for the human key review? Only while an activation is in progress, and only when the
 * latest HPB answered `ok`. A later failed HPB (a human's press that did not get through) makes it false
 * again, and the daily check resumes: the order log is the truth, in both directions.
 */
export function bankReadyForReview(ctx: WorkspaceContext, conn: Pick<ActivationCheckConnectionRow, 'id' | 'state'>): boolean {
  if (!isActivationInProgress(conn.state)) return false;
  return latestHpb(ctx, conn.id)?.status === 'ok';
}

interface CheckRow {
  local_date: string;
  attempt: number;
  checked_at: string;
  outcome_code: string;
  retryable: number;
}

/**
 * The day's ATTEMPTS, one per attempt number: its final row when one landed, else its `started` mark
 * (critic F7: an outcome that could not be written still counts, as a retryable unknown).
 */
function checksOn(ctx: WorkspaceContext, connectionId: string, localDate: string): CheckRow[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT local_date, attempt, checked_at, outcome_code, retryable FROM ebics_activation_check
        WHERE workspace_id = ? AND connection_id = ? AND local_date = ? ORDER BY attempt, rowid`,
    )
    .all(ctx.workspaceId, connectionId, localDate) as CheckRow[];
  const byAttempt = new Map<number, CheckRow>();
  for (const row of rows) {
    const seen = byAttempt.get(row.attempt);
    if (seen === undefined || row.outcome_code !== 'started') byAttempt.set(row.attempt, row);
  }
  return [...byAttempt.values()].sort((a, b) => a.attempt - b.attempt);
}

function lastCheck(ctx: WorkspaceContext, connectionId: string): CheckRow | undefined {
  return ctx.store.db
    .prepare(
      `SELECT local_date, attempt, checked_at, outcome_code, retryable FROM ebics_activation_check
        WHERE workspace_id = ? AND connection_id = ? AND outcome_code != 'started' ORDER BY checked_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, connectionId) as CheckRow | undefined;
}

/**
 * Critic F3 / R2-2: is the cause a check ended the day on gone now? Only the causes a restart fixes are
 * named; every other outcome (the bank's own answer, an unusable answer, no seated actor) keeps the day
 * ended, so this can only ever ADD a check that the day's cap still bounds.
 */
function restartCauseGone(ctx: WorkspaceContext, outcome: string): boolean {
  const ks = (ctx.ebicsKeystore ?? defaultEbicsKeystore).state?.();
  if (outcome === 'keystore_locked') return ks !== 'locked';
  if (outcome === 'keystore_unavailable') return ks !== 'unavailable' && ks !== 'locked';
  if (outcome === 'needs_bank_transport') return ctx.ebicsTransport !== undefined;
  return false;
}

export type ActivationCheckDecision =
  | { due: true; localDate: string; attempt: number }
  | {
      due: false;
      reason: 'not_in_activation' | 'bank_ready' | 'off' | 'before_time' | 'checked_today' | 'attempts_exhausted' | 'retry_later';
      nextAt: string | null;
    };

/** Is the connection due for an activation check at `now`? The one rule the tick and the status share. */
export function activationCheckDecision(ctx: WorkspaceContext, conn: ActivationCheckConnectionRow, now: string): ActivationCheckDecision {
  if (!isActivationInProgress(conn.state)) return { due: false, reason: 'not_in_activation', nextAt: null };
  if (bankReadyForReview(ctx, conn)) return { due: false, reason: 'bank_ready', nextAt: null };
  const settings = autoSyncSettings(conn);
  if (settings.mode === 'off') return { due: false, reason: 'off', nextAt: null };
  const local = zurichParts(now);
  const todayAt = zurichInstant(local.date, settings.atTime);
  const tomorrowAt = zurichInstant(nextDay(local.date), settings.atTime);
  if (now < todayAt) return { due: false, reason: 'before_time', nextAt: todayAt };
  const today = checksOn(ctx, conn.id, local.date);
  const last = today[today.length - 1];
  // Critic F3 and R2-2: a check that ended the day on a condition a restart fixes (a locked keystore, a
  // missing or broken keystore file, no bank wire in the process) ends it only while that condition HOLDS.
  // Once TILL is restarted with it fixed (the one act the lamp asks for) the catch-up check runs at once,
  // within the day's cap: the D142 stale-lock rule, applied to every such cause.
  const fixedSince = last !== undefined && restartCauseGone(ctx, last.outcome_code);
  if (fixedSince && today.length < ACTIVATION_CHECK_MAX_ATTEMPTS) return { due: true, localDate: local.date, attempt: today.length + 1 };
  if (last !== undefined && last.retryable !== 1) return { due: false, reason: 'checked_today', nextAt: tomorrowAt };
  if (today.length >= ACTIVATION_CHECK_MAX_ATTEMPTS) return { due: false, reason: 'attempts_exhausted', nextAt: tomorrowAt };
  if (last !== undefined) {
    const retryAt = new Date(Date.parse(last.checked_at) + AUTO_SYNC_RETRY_MS).toISOString();
    if (now < retryAt) return { due: false, reason: 'retry_later', nextAt: retryAt };
  }
  return { due: true, localDate: local.date, attempt: today.length + 1 };
}

/** Append one check row. Never updates an earlier one. */
export function recordActivationCheck(
  ctx: WorkspaceContext,
  input: {
    connectionId: string;
    localDate: string;
    attempt: number;
    checkedAt: string;
    outcome: ActivationCheckOutcome;
    retryable: boolean;
    runAs: string | null;
    bankCode: string | null;
  },
): void {
  ctx.store.db
    .prepare(
      `INSERT INTO ebics_activation_check
         (id, workspace_id, connection_id, local_date, attempt, checked_at, outcome_code, retryable, run_as, bank_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.ids.next('eact'),
      ctx.workspaceId,
      input.connectionId,
      input.localDate,
      input.attempt,
      input.checkedAt,
      input.outcome,
      input.retryable ? 1 : 0,
      input.runAs,
      input.bankCode,
    );
}

/**
 * Critic R2-1 (D143): the attempt the MAIN thread computed, recorded by the main thread when the worker
 * that should have run it left nothing (it failed before its `started` mark: a wire module that no longer
 * loads, a keystore file that cannot be opened, a spawn failure). One retryable `worker_failed` row (critic
 * R3-3: never `channel_unreachable`, the bank was not asked) with `bank_code` naming why
 * (`sync_worker_failed`, or `worker_no_report`), exactly as D142 counts a failed sync worker, so the
 * hourly retry and the daily cap of three apply to worker runs too. Written only when no outcome row for
 * that attempt exists; a `started` mark the worker did write folds into it (`checksOn`). Returns whether it
 * wrote.
 */
export function recordUnknownActivationAttempt(
  ctx: WorkspaceContext,
  input: { connectionId: string; localDate: string; attempt: number; checkedAt: string; reason: string },
): boolean {
  const landed = ctx.store.db
    .prepare(
      `SELECT 1 AS present FROM ebics_activation_check
        WHERE workspace_id = ? AND connection_id = ? AND local_date = ? AND attempt = ? AND outcome_code != 'started' LIMIT 1`,
    )
    .get(ctx.workspaceId, input.connectionId, input.localDate, input.attempt) as { present: number } | undefined;
  if (landed !== undefined) return false;
  ctx.store.tx(() => {
    recordActivationCheck(ctx, {
      connectionId: input.connectionId,
      localDate: input.localDate,
      attempt: input.attempt,
      checkedAt: input.checkedAt,
      outcome: 'worker_failed',
      retryable: true,
      runAs: null,
      bankCode: input.reason,
    });
    return { ok: true as const };
  });
  return true;
}

/** The activation check as `bank_channel_status` and the band show it. */
export interface ActivationStatus {
  /** True while the scheduler checks this connection daily (an activation in progress, not ready, not off). */
  checking: boolean;
  /**
   * Critic F9: the last time the BANK ANSWERED an HPB (its keys, or its own return code such as 091002),
   * the probe's or a human's; null when no HPB ever got through. A locked store or a lost answer is no check.
   */
  lastCheckAt: string | null;
  /** The last automatic attempt, whatever came of it (null before the first). */
  lastAttemptAt: string | null;
  /** When the scheduler checks next (null when it does not check). */
  nextCheckAt: string | null;
  /** The bank answered HPB: a person compares the keys with the bank's sheet and confirms. */
  bankReady: boolean;
  /** The last check's outcome code (`ACTIVATION_CHECK_OUTCOMES`), or null before the first. */
  lastOutcome: string | null;
}

export function activationStatus(ctx: WorkspaceContext, conn: ActivationCheckConnectionRow, now: string): ActivationStatus {
  const bankReady = bankReadyForReview(ctx, conn);
  const decision = activationCheckDecision(ctx, conn, now);
  const check = lastCheck(ctx, conn.id);
  const answered = ctx.store.db
    .prepare(
      `SELECT occurred_at, status, bank_reason FROM ebics_order_log
        WHERE workspace_id = ? AND connection_id = ? AND order_type = 'HPB' ORDER BY occurred_at DESC, rowid DESC`,
    )
    .all(ctx.workspaceId, conn.id) as { occurred_at: string; status: string; bank_reason: string | null }[];
  // The bank answered when it sent its keys (ok) or its own EBICS return code (six numerals).
  const lastAnswer = answered.find((r) => r.status === 'ok' || /^[0-9]{6}$/.test(r.bank_reason ?? ''));
  const checking = isActivationInProgress(conn.state) && !bankReady && autoSyncSettings(conn).mode !== 'off';
  return {
    checking,
    lastCheckAt: lastAnswer?.occurred_at ?? null,
    lastAttemptAt: check?.checked_at ?? null,
    nextCheckAt: !checking ? null : decision.due ? now : decision.nextAt,
    bankReady,
    lastOutcome: check?.outcome_code ?? null,
  };
}
