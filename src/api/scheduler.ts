/**
 * M00's local scheduler tick (US-M00.4): the process that supplies G01 with a clock while `till up`
 * runs.
 *
 * WHAT THIS OWNS, AND THE LINE IT DOES NOT CROSS. It owns the TICK, nothing else. Every cadence
 * semantic, every occurrence key, every retry record belongs to G01. A tick enumerates the live
 * workspaces and calls the EXISTING `run_due_automations` verb for each, through the SAME shared
 * dispatch every other caller uses (`getAction(...).run`), so it inherits G01's denylist, the P8
 * approval dial, the A24 capability gate and G01's once-per-occurrence idempotency for free. There is
 * deliberately no second cadence store and no M00-private retry loop: a second one would fork
 * ownership of "what is due" away from G01, which is exactly the bug this design refuses to write.
 *
 * THE ACTOR IS `system`. A tick is unattended, so it runs as `system` rather than as a human or the
 * agent seat. In the common single-user workspace (unprovisioned membership) A24 passes every actor,
 * so the tick fires normally. Once a workspace is provisioned by inviting a colleague, `system` is
 * not a member and `run_due_automations` returns `permission_denied`, recorded on the G01 run: the
 * honest degradation the spec names, never a silent skip. `system` is not a seated actor, and nothing
 * here seats one.
 *
 * THE ONE SECOND BRANCH: THE DAILY BANK FETCH (D142, A36 §12). Beside `run_due_automations` the tick
 * runs the automatic statement fetch, and it is a branch of its own on purpose, NOT a G01 rule:
 * `bank_sync` stays on the G01 denylist, so no stored rule can fire it at a cadence or from an event.
 * The rules for WHEN live in `core/banking/ebics/autoSync.ts` (daily at the connection's Swiss time,
 * the first tick after `till up` starts is the catch-up, three attempts a day, an hourly retry only for
 * a bank that did not answer or was busy); this file only walks the workspaces and calls the registry's
 * own `bank_sync` as a real seated actor whose `pay` right is checked live (critic F1: the schedule's
 * setter, else the owner seat, never a governed seat; see `autoSyncActor`), awaited through `runAsync` so the fetch runs in the sync worker and the
 * tick never blocks the process. Each attempt is appended to `bank_auto_sync_run`. A fetch another
 * caller is running (`sync_in_progress`) is not an attempt: the next tick decides again.
 *
 * THE ACTIVATION CHECK (D143, A36 §12.1). The same branch also checks, once a Swiss day, each connection
 * whose activation is in progress (`ini_sent`, `pending_bank_activation`): an HPB-only probe through the
 * engine's `checkBankActivation`, NOT a verb and NOT a G01 rule, so `bank_channel_connect` stays human
 * only and on the denylist. The probe never pins, confirms, resends a leg or changes trust; it runs as
 * the same live-checked seated actor as the fetch. The rules for when live in `activationCheck.ts`.
 *
 * `run_due_automations` NEVER THROWS PAST HERE. It always RETURNS a Result (P9), and the shared
 * dispatch's throw guard converts any escape into one, so a bad result on one workspace cannot stop
 * the tick reaching the next. The scheduler ignores the per-workspace Result on purpose: G01's own
 * run log is where a firing's outcome is read, not the tick's return value.
 */

import type { ApiDeps } from './registry.js';
import { getAction } from './registry.js';
import { setSchedulerStatus } from './runtime-state.js';
import { makeContext } from '../core/context.js';
import { err } from '../core/result.js';
import type { Result } from '../core/result.js';
import type { ActivationCheckReport } from '../core/banking/ebics/index.js';
import {
  activationCheckConnections,
  activationCheckDecision,
  autoSyncActor,
  autoSyncConnections,
  autoSyncNoActorReason,
  autoSyncSetterKind,
  autoSyncTried,
  checkBankActivation,
  recordUnknownActivationAttempt,
  autoSyncDecision,
  isRetryableAutoOutcome,
  recordAutoSyncAttempt,
} from '../core/banking/ebics/index.js';

/** The default tick interval: one minute. */
export const DEFAULT_TICK_MS = 60_000;
/** The tightest tick the scheduler will run: 30 seconds. Faster buys nothing and only churns the WAL. */
export const MIN_TICK_MS = 30_000;
/** The slowest: 15 minutes. Beyond this a "daily" rule can slip a whole day past its due instant. */
export const MAX_TICK_MS = 15 * 60_000;

/** Clamp a requested interval into the supported band, falling back to the default for a bad value. */
export function clampTickMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_TICK_MS;
  return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, Math.trunc(requested)));
}

/** Read `TILL_TICK_MS` into a clamped interval; blank or unparseable falls back to the default. */
export function resolveTickMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TILL_TICK_MS?.trim();
  if (raw === undefined || raw === '' || !/^\d+$/.test(raw)) return DEFAULT_TICK_MS;
  return clampTickMs(Number(raw));
}

/** What one automatic fetch attempt did (D142), for the tick's caller and the suites. */
export type BankAutoSyncReport =
  | { workspaceId: string; connectionId: string; attempt: number; idempotencyKey: string; ok: boolean; code: string; retryable: boolean }
  | { workspaceId: string; connectionId: string; skipped: 'sync_in_progress' }
  | { workspaceId: string; connectionId: string; activationCheck: ActivationCheckReport };

export interface Scheduler {
  /** Run exactly one tick now. Returns how many workspaces it drove `run_due_automations` for. */
  tickOnce(asOf?: string): number;
  /**
   * D142: run the daily bank fetch branch once, awaited (the tick starts it without waiting; one runs
   * at a time). Resolves with what each due connection's attempt did.
   */
  bankTickOnce(): Promise<BankAutoSyncReport[]>;
  /** Arm the interval timer (unref'd, so it never keeps the process alive on its own). */
  start(): void;
  /** Disarm the timer and mark the scheduler off. Idempotent. */
  stop(): void;
}

export interface SchedulerOptions {
  /** The tick interval in milliseconds, already resolved. Defaults to `DEFAULT_TICK_MS`. */
  intervalMs?: number;
  /**
   * Enumerate the workspaces to tick. Defaults to every non-archived workspace in the store. Injected
   * for tests. A tick never touches an archived workspace: its books are read-only (A23).
   */
  listWorkspaceIds?: (deps: ApiDeps) => string[];
  /**
   * Drive one workspace's due cadences. Defaults to the shared-dispatch call as actor `system`.
   * Injected for tests so a suite can assert the tick reached the verb without a full G01 fixture.
   */
  runDue?: (workspaceId: string, asOf?: string) => void;
  /** The clock, injected so a test controls `lastTickAt`/`nextTickAt`. Defaults to the wall clock. */
  now?: () => Date;
  /** D142: turn the daily bank fetch branch off (a suite that only drives G01). Defaults to on. */
  bankAutoSync?: boolean;
}

/** Every non-archived workspace id, the default population a tick drives. */
function liveWorkspaceIds(deps: ApiDeps): string[] {
  const rows = deps.store.db
    .prepare('SELECT id FROM workspace WHERE archived = 0')
    .all() as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Build a scheduler over `deps`. Nothing ticks until `start()` (or a manual `tickOnce()`), so
 * constructing one is free and a caller that only wants `tickOnce` in a test pays for no timer.
 */
export function createScheduler(deps: ApiDeps, opts: SchedulerOptions = {}): Scheduler {
  const intervalMs = clampTickMs(opts.intervalMs);
  const listWorkspaceIds = opts.listWorkspaceIds ?? liveWorkspaceIds;
  const now = opts.now ?? (() => new Date());
  const runDue =
    opts.runDue ??
    ((workspaceId: string, asOf?: string) => {
      const action = getAction('run_due_automations');
      if (action === undefined) return;
      // As `system`, through the shared dispatch: same gate, same denylist, same idempotency.
      action.run({ ...deps, actor: 'system' }, { workspaceId, ...(asOf === undefined ? {} : { asOf }) });
    });

  let timer: ReturnType<typeof setInterval> | undefined;
  let bankTick: Promise<BankAutoSyncReport[]> | undefined;

  async function bankTickOnce(): Promise<BankAutoSyncReport[]> {
    const reports: BankAutoSyncReport[] = [];
    // D143 critic F1: yield a macrotask first, so nothing below ever runs inside the caller's stack
    // (`start()`, `tickOnce()`): the tick is armed, the caller returns, then the branch runs.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const action = getAction('bank_sync');
    if (action === undefined) return reports;
    for (const workspaceId of listWorkspaceIds(deps)) {
      const ctx = makeContext(deps.store, { workspaceId, actor: 'system', clock: deps.clock, ids: deps.ids });
      for (const conn of autoSyncConnections(ctx)) {
        const startedAt = now().toISOString();
        const decision = autoSyncDecision(ctx, conn, startedAt);
        if (!decision.due) continue;
        const input = { workspaceId, connectionId: conn.id, idempotencyKey: decision.idempotencyKey };
        // Critic F1: a real seated actor, its `pay` right checked live now; never an automation identity.
        const runAs = autoSyncActor(ctx, conn);
        let result: Result;
        if (runAs === null) {
          result = err('auto_sync_no_actor', {
            connectionId: conn.id,
            // Critic R2-2: say what was tried, the schedule's setter and the owner seat, nothing more.
            // Critic R3-2 (D142): a schedule nobody ever set has no setter, so only the owner seat was tried.
            // Critic LB-1 (D143): nor was an agent setter (a governed seat is skipped), so say who WAS tried.
            tried: autoSyncTried(ctx, conn),
            reason: autoSyncNoActorReason(autoSyncSetterKind(ctx, conn)),
          });
        } else {
          const seated: ApiDeps = { ...deps, actor: runAs };
          try {
            result = action.runAsync !== undefined ? await action.runAsync(seated, input) : action.run(seated, input);
          } catch (e) {
            result = err('unexpected_error', { action: 'bank_sync', message: e instanceof Error ? e.message : String(e) });
          }
        }
        if (!result.ok && result.error === 'sync_in_progress') {
          reports.push({ workspaceId, connectionId: conn.id, skipped: 'sync_in_progress' });
          continue;
        }
        const retryable = isRetryableAutoOutcome(result);
        try {
          recordAutoSyncAttempt(ctx, {
            connectionId: conn.id,
            localDate: decision.localDate,
            attempt: decision.attempt,
            idempotencyKey: decision.idempotencyKey,
            startedAt,
            finishedAt: now().toISOString(),
            result,
            retryable,
            runAs,
          });
        } catch (e) {
          // The attempt row is bookkeeping about the fetch, never the fetch: a failure to append it is a
          // diagnostics entry, and the next tick decides again (the idempotency key keeps it to one fetch).
          deps.diagnostics?.record({ kind: 'verb_error', at: new Date().toISOString(), code: 'bank_auto_sync_record_failed', action: 'bank_sync', error: e });
        }
        reports.push({
          workspaceId,
          connectionId: conn.id,
          attempt: decision.attempt,
          idempotencyKey: decision.idempotencyKey,
          ok: result.ok,
          code: result.ok ? String((result.download as { outcome?: unknown } | undefined)?.outcome ?? result.reason ?? 'ok') : String(result.error),
          retryable,
        });
      }
      // D143: the daily activation check. Its own context carries the host's wire and keystore (the
      // probe is an engine call, not a registry verb, so nothing else would hand them over).
      const probeCtx = makeContext(deps.store, {
        workspaceId,
        actor: 'system',
        clock: deps.clock,
        ids: deps.ids,
        ...(deps.ebicsTransport !== undefined ? { ebicsTransport: deps.ebicsTransport } : {}),
        ...(deps.ebicsKeystore !== undefined ? { ebicsKeystore: deps.ebicsKeystore } : {}),
      });
      for (const conn of activationCheckConnections(probeCtx)) {
        const at = now().toISOString();
        const decision = activationCheckDecision(probeCtx, conn, at);
        if (!decision.due) continue;
        try {
          // D143 critic F1: under `till up` the probe runs in the worker (its HPB may park a thread for up
          // to 60 s); only a host without a runner (the suites, an in-memory book) runs it in process.
          let checked: ActivationCheckReport | null;
          if (deps.bankActivationRunner !== undefined) {
            const answer = await deps.bankActivationRunner({ ...deps, actor: 'system' }, { workspaceId, connectionId: conn.id, now: at });
            checked = answer.ok ? ((answer.report as ActivationCheckReport | null | undefined) ?? null) : null;
            if (!answer.ok) {
              deps.diagnostics?.record({ kind: 'verb_error', at: new Date().toISOString(), code: 'bank_activation_check_failed', action: 'bank_activation_check', error: new Error(String(answer.error)) });
            }
            // Critic R2-1: a worker that failed, or answered nothing, while the attempt is STILL due here, left
            // no count; the main thread records the attempt itself, so the hourly retry and the daily cap hold
            // for worker runs as they do for HPBs. A worker that did its attempt made it not due any more.
            if (checked === null && activationCheckDecision(probeCtx, conn, at).due) {
              const reason = answer.ok ? 'worker_no_report' : String(answer.error);
              recordUnknownActivationAttempt(probeCtx, { connectionId: conn.id, localDate: decision.localDate, attempt: decision.attempt, checkedAt: at, reason });
            }
            if (!answer.ok) continue;
          } else {
            checked = checkBankActivation(probeCtx, { connectionId: conn.id, now: at });
          }
          if (checked !== null) reports.push({ workspaceId, connectionId: conn.id, activationCheck: checked });
        } catch (e) {
          // A check is bookkeeping about the bank, never the books: a failure is a diagnostics entry, and
          // the next tick decides again.
          deps.diagnostics?.record({ kind: 'verb_error', at: new Date().toISOString(), code: 'bank_activation_check_failed', action: 'bank_activation_check', error: e });
        }
      }
    }
    return reports;
  }

  function startBankTick(): void {
    if (opts.bankAutoSync === false || bankTick !== undefined) return;
    bankTick = bankTickOnce()
      .catch(() => [] as BankAutoSyncReport[])
      .finally(() => {
        bankTick = undefined;
      });
  }

  function tickOnce(asOf?: string): number {
    const ids = listWorkspaceIds(deps);
    for (const id of ids) runDue(id, asOf);
    // D142: the daily bank fetch, started and not awaited: it runs in the sync worker while the tick
    // returns, and a fetch still running when the next tick fires is not started twice.
    startBankTick();
    const at = now();
    setSchedulerStatus({
      enabled: timer !== undefined,
      lastTickAt: at.toISOString(),
      nextTickAt: new Date(at.getTime() + intervalMs).toISOString(),
    });
    return ids.length;
  }

  return {
    tickOnce,
    bankTickOnce,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => tickOnce(), intervalMs);
      // Do not let the tick timer, on its own, hold the event loop open: the HTTP listener is what
      // keeps `till up` alive, and a lone timer should never turn a finished process into a zombie.
      timer.unref?.();
      // D142: the catch-up. The daily bank fetch is decided once at start, so TILL closed at 07:00
      // fetches as soon as `till up` runs, not a tick later. G01's cadences keep their first tick.
      startBankTick();
      const at = now();
      setSchedulerStatus({
        enabled: true,
        lastTickAt: null,
        nextTickAt: new Date(at.getTime() + intervalMs).toISOString(),
      });
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      setSchedulerStatus({ enabled: false, lastTickAt: null, nextTickAt: null });
    },
  };
}
