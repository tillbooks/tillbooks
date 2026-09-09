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
 * `run_due_automations` NEVER THROWS PAST HERE. It always RETURNS a Result (P9), and the shared
 * dispatch's throw guard converts any escape into one, so a bad result on one workspace cannot stop
 * the tick reaching the next. The scheduler ignores the per-workspace Result on purpose: G01's own
 * run log is where a firing's outcome is read, not the tick's return value.
 */

import type { ApiDeps } from './registry.js';
import { getAction } from './registry.js';
import { setSchedulerStatus } from './runtime-state.js';

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

export interface Scheduler {
  /** Run exactly one tick now. Returns how many workspaces it drove `run_due_automations` for. */
  tickOnce(asOf?: string): number;
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

  function tickOnce(asOf?: string): number {
    const ids = listWorkspaceIds(deps);
    for (const id of ids) runDue(id, asOf);
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
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => tickOnce(), intervalMs);
      // Do not let the tick timer, on its own, hold the event loop open: the HTTP listener is what
      // keeps `till up` alive, and a lone timer should never turn a finished process into a zombie.
      timer.unref?.();
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
