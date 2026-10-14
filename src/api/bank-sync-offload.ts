/**
 * D142, THE HOST'S OFF-THREAD RUNNER FOR `bank_sync`: what `till up` wires into `ApiDeps.bankSyncRunner`.
 *
 * Each call starts one `worker_threads` worker (`bank-sync-worker.ts`) with the book's path, the
 * caller's identity and the live-wire recipe, and resolves with the verb's own Result when the worker
 * posts it. The main thread never blocks: the MCP and REST doors await the promise
 * (`runGovernedAsync`), and every other request is served meanwhile.
 *
 * ONE SYNC PER CONNECTION is not decided here. The verb takes a lease on its connection row before the
 * download (`sync_in_progress`), in whichever thread runs it, so a second call is refused the same way
 * whether it came from this process, the scheduler tick or an MCP agent process beside it.
 *
 * A worker that dies without an answer (an out-of-memory kill, a native crash) resolves as
 * `sync_worker_failed` (retryable), never as a hang, and the host clears the lease that job took, by
 * its holder (critic F2). A worker that runs past `timeoutMs` is terminated and, once it is gone
 * (critic R2-3b), cleared the same way. A worker whose termination does not finish within
 * `terminateGraceMs` (stuck in a native call that cannot be interrupted) is settled
 * `sync_worker_failed` anyway (critic R3-1), so neither the press nor the scheduler's tick waits forever.
 * A process killed mid-sync is cleared at the next `till up` boot (`reclaimDeadSyncLeases`).
 */

import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

import { err } from '../core/result.js';
import type { Result } from '../core/result.js';
import type { ActionInput, ApiDeps } from './registry.js';
import type { EbicsRuntimeRecipe } from './host-runtime.js';
import type { BankSyncJob, BankSyncReply, BankWorkerKind } from './bank-sync-worker.js';
import { processSyncLeaseHolder, releaseSyncLeaseOf } from '../core/banking/ebics/index.js';

/** A sync that takes longer than this is abandoned: well above the wire's worst case of a few minutes. */
export const DEFAULT_SYNC_WORKER_TIMEOUT_MS = 10 * 60_000;

/**
 * Critic R3-1: how long the host waits for a worker it asked to stop before it settles the job anyway.
 * A thread parked in a native call that cannot be interrupted only exits when that call returns; this
 * is the backstop for one that never does.
 */
export const DEFAULT_TERMINATE_GRACE_MS = 5_000;

export interface BankSyncOffloadOptions {
  /** The book the worker opens. Must be a file: an in-memory book cannot be shared with a thread. */
  dbPath: string;
  /** The live wire's recipe from `resolveEbicsRuntime`; absent means no transport in the worker either. */
  recipe?: EbicsRuntimeRecipe;
  /** A module exporting `resolveWorkerPorts(options)`, used instead of the recipe (the suites). */
  portsModule?: string;
  portsOptions?: unknown;
  timeoutMs?: number;
  /** Critic R3-1: how long a requested termination may take before the job is settled anyway. */
  terminateGraceMs?: number;
  /**
   * How the worker is started; defaults to a `worker_threads` Worker. A seam for the suite that proves
   * the host clears a lease only after the worker is gone (critic R2-3b), with a stand-in whose
   * termination takes a moment.
   */
  createWorker?: (url: URL, options: { workerData: BankSyncJob }) => BankSyncWorkerLike;
  /** D143 critic F1: what the worker runs; `bank_sync` unless named. */
  kind?: BankWorkerKind;
}

/** The part of a `Worker` the runner uses. */
export interface BankSyncWorkerLike {
  once(event: 'message', listener: (reply: BankSyncReply) => void): unknown;
  once(event: 'error', listener: (e: Error) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export type BankSyncRunner = (deps: ApiDeps, input: ActionInput) => Promise<Result>;

/** True for a location a worker thread can open as the same book. */
export function isSharableDbPath(dbPath: string | undefined): dbPath is string {
  return typeof dbPath === 'string' && dbPath.length > 0 && dbPath !== ':memory:' && !dbPath.startsWith('file::memory:');
}

export function createBankSyncOffload(opts: BankSyncOffloadOptions): BankSyncRunner {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SYNC_WORKER_TIMEOUT_MS;
  const terminateGraceMs = opts.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  return (deps, input) =>
    new Promise<Result>((resolve) => {
      // Critic F2: this job's lease holder, so an abnormal end clears exactly the lease it took.
      const leaseHolder = `${processSyncLeaseHolder()}:job:${randomUUID()}`;
      const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : '';
      const kind: BankWorkerKind = opts.kind ?? 'bank_sync';
      const job: BankSyncJob = {
        kind,
        leaseHolder,
        dbPath: opts.dbPath,
        input,
        actor: deps.actor,
        ...(deps.subject !== undefined ? { subject: deps.subject } : {}),
        ...(deps.identitySource !== undefined ? { identitySource: deps.identitySource } : {}),
        ...(opts.recipe !== undefined ? { recipe: opts.recipe } : {}),
        ...(opts.portsModule !== undefined ? { portsModule: opts.portsModule } : {}),
        ...(opts.portsOptions !== undefined ? { portsOptions: opts.portsOptions } : {}),
      };
      let settled = false;
      const settle = (result: Result): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      let ending = false;
      /** Clear the lease this job may hold, by its holder only (a lease another sync took is left alone). */
      const releaseLease = (): void => {
        try {
          if (workspaceId !== '') releaseSyncLeaseOf(deps.store, workspaceId, leaseHolder);
        } catch (e) {
          deps.diagnostics?.record({ kind: 'verb_error', at: new Date().toISOString(), code: 'sync_lease_release_failed', action: kind, error: e });
        }
      };
      /**
       * An end without the verb's answer: stop the worker, and only once it is GONE clear the lease the
       * job may hold, then say the job failed. Critic R2-3b: clearing first left a window in which a
       * worker still starting could take its lease after the clear, and keep it until the expiry.
       * `terminate` is skipped when the worker already exited on its own. If the worker's own answer
       * arrives while it is being stopped, that answer wins (its lease was released by the verb).
       *
       * Critic R3-1: the wait for `terminate` has a backstop. A worker parked in a native call that
       * cannot be interrupted would keep `terminate` pending forever, and with it the press and the
       * scheduler's single bank tick. After `terminateGraceMs` the job is settled `sync_worker_failed`
       * (retryable, `terminated: false`) and the lease is cleared then (A36 §12): once termination is
       * requested the worker commits nothing and sends no receipt (measured, D143 landing review), and a
       * late answer is ignored (the job is settled). A worker parked inside its write transaction holds
       * the write lock, so that clear fails and the lease stays (SQLite serialises it). Should the
       * worker still exit later, its lease is cleared once more, by holder, never a lease another job
       * took.
       */
      const abandon = async (detail: Record<string, unknown>, stop: boolean): Promise<void> => {
        if (settled || ending) return;
        ending = true;
        clearTimeout(timer);
        let terminated = true;
        if (stop) {
          const gone = worker.terminate().then(
            () => true,
            // A worker that is already gone cannot be terminated; there is nothing left to stop.
            () => true,
          );
          let grace: ReturnType<typeof setTimeout> | undefined;
          const graceOver = new Promise<false>((resolveGrace) => {
            grace = setTimeout(() => resolveGrace(false), terminateGraceMs);
          });
          terminated = await Promise.race([gone, graceOver]);
          clearTimeout(grace);
          if (!terminated) void gone.then(releaseLease);
        }
        if (settled) return;
        releaseLease();
        settle(err('sync_worker_failed', { action: kind, retryable: true, ...detail, ...(terminated ? {} : { terminated: false, terminateGraceMs }) }));
      };
      const spawn = opts.createWorker ?? ((url: URL, options: { workerData: BankSyncJob }): BankSyncWorkerLike => new Worker(url, options));
      const worker = spawn(new URL('./bank-sync-worker.js', import.meta.url), { workerData: job });
      const timer = setTimeout(() => void abandon({ stage: 'timeout', timeoutMs }, true), timeoutMs);
      timer.unref?.();
      worker.once('message', (reply: BankSyncReply) => {
        settle(reply.result);
        void worker.terminate();
      });
      worker.once('error', (e: Error) => void abandon({ stage: 'worker', message: e.message }, true));
      worker.once('exit', (code: number) => void abandon({ stage: 'exit', exitCode: code }, false));
    });
}

/**
 * D143 critic F1: the same runner for the scheduler's daily activation check. The probe's HPB runs in
 * the worker on its own connection to the book, so neither `scheduler.start()` nor a tick waits on the
 * wire. It takes no sync lease; the job's holder is unique, so the abnormal-end clear is a no-op.
 */
export function createBankActivationOffload(opts: Omit<BankSyncOffloadOptions, 'kind'>): BankSyncRunner {
  return createBankSyncOffload({ ...opts, kind: 'activation_check' });
}
