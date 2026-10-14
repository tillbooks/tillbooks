/**
 * D142, THE SYNC WORKER: one `bank_sync` call, run in a `worker_threads` worker on its own SQLite
 * connection, so the `till up` process keeps answering while the bank wire waits.
 *
 * WHY THE WHOLE VERB RUNS HERE. The blocking wait lives in the private wire (`Atomics.wait` on a
 * synchronous HTTP bridge, up to 60 s per request), and its contract is synchronous. Moving the verb,
 * not the wire, keeps both repositories' contracts unchanged: the worker runs the SAME registry action
 * (`getAction('bank_sync').run`), with every gate that implies (tenant, A24 capability, archive, the
 * generation guard, idempotency, the connection's sync lease, the G01 event emit), and posts back the
 * verb's own Result. The main thread only awaits it.
 *
 * ONE JOB PER WORKER. The worker opens the book, builds the live wire from the host's recipe (the same
 * `buildEbicsPorts` the boot path uses, so the keystore is re-read and a key created after boot is
 * seen), runs one call, closes the book and exits. A sync is a daily or on-demand event; the start-up
 * cost buys a worker that can never carry state from one sync into the next.
 *
 * The ports can instead come from a module the host names (`portsModule`, exporting
 * `resolveWorkerPorts(options)`), the same shape of seam as `TILL_EBICS_RUNTIME`: the suites use it to
 * put a slow, synthetic bank behind the worker without the private wire.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { SqliteStore } from '../core/store/sqlite-store.js';
import { systemClock } from '../core/clock.js';
import { systemIdGen } from '../core/ids.js';
import { err } from '../core/result.js';
import type { Result } from '../core/result.js';
import { getAction, type ApiDeps, type ActionInput } from './registry.js';
import { buildEbicsPorts, type EbicsRuntimeRecipe, type HostEbicsPorts } from './host-runtime.js';
import { checkBankActivation, setSyncLeaseHolder } from '../core/banking/ebics/index.js';
import { makeContext } from '../core/context.js';
import { ok } from '../core/result.js';
import { makeDiagnosticsPort } from './support-actions.js';

/**
 * What the worker runs: the `bank_sync` verb (D142), or the scheduler's daily activation check (D143
 * critic F1: an HPB-only probe, `checkBankActivation`, which is an engine call and not a verb).
 */
export type BankWorkerKind = 'bank_sync' | 'activation_check';

/** What the host hands the worker (structured-cloned; no function, no live object crosses). */
export interface BankSyncJob {
  /** Absent means `bank_sync` (the D142 job). */
  kind?: BankWorkerKind;
  dbPath: string;
  input: ActionInput;
  /** The calling session's identity, re-seated here so A24 and the audit trail name the same actor. */
  actor: string;
  subject?: string;
  identitySource?: string;
  /** Build the live wire as the boot path did. Absent: no transport (the honest degrade). */
  recipe?: EbicsRuntimeRecipe;
  /** Or: a module exporting `resolveWorkerPorts(options)`, for a host that supplies its own ports. */
  portsModule?: string;
  portsOptions?: unknown;
  /** Critic F2: the holder the sync lease is stamped with, so the host can clear exactly this job's. */
  leaseHolder?: string;
}

/** What the worker posts back: the verb's Result, always (a failure becomes one, never a throw). */
export interface BankSyncReply {
  result: Result;
}

async function resolvePorts(job: BankSyncJob): Promise<Pick<HostEbicsPorts, 'ebicsTransport' | 'ebicsKeystore'>> {
  if (job.portsModule !== undefined) {
    const mod = (await import(job.portsModule)) as { resolveWorkerPorts?: (options: unknown) => unknown };
    if (typeof mod.resolveWorkerPorts !== 'function') {
      throw new Error(`the ports module "${job.portsModule}" does not export resolveWorkerPorts`);
    }
    return (await mod.resolveWorkerPorts(job.portsOptions)) as Pick<HostEbicsPorts, 'ebicsTransport' | 'ebicsKeystore'>;
  }
  if (job.recipe !== undefined) return buildEbicsPorts(job.recipe);
  return {};
}

/**
 * D143 critic F1: the activation check, run here so its HPB (which the live wire answers only after
 * parking its thread for up to 60 s) never blocks the `till up` process. Answers `ok({report})`, the
 * report null when the connection was not due after all (the function re-reads its own decision).
 */
function runActivationCheck(store: SqliteStore, job: BankSyncJob, ports: Pick<HostEbicsPorts, 'ebicsTransport' | 'ebicsKeystore'>): Result {
  const workspaceId = typeof job.input.workspaceId === 'string' ? job.input.workspaceId : '';
  const connectionId = typeof job.input.connectionId === 'string' ? job.input.connectionId : '';
  const now = typeof job.input.now === 'string' ? job.input.now : undefined;
  const ctx = makeContext(store, {
    workspaceId,
    actor: job.actor,
    clock: systemClock,
    ids: systemIdGen,
    ...(ports.ebicsTransport !== undefined ? { ebicsTransport: ports.ebicsTransport } : {}),
    ...(ports.ebicsKeystore !== undefined ? { ebicsKeystore: ports.ebicsKeystore } : {}),
  });
  const report = checkBankActivation(ctx, { connectionId, ...(now !== undefined ? { now } : {}) });
  return ok({ report });
}

export async function runBankSyncJob(job: BankSyncJob): Promise<Result> {
  const kind: BankWorkerKind = job.kind ?? 'bank_sync';
  const action = getAction('bank_sync');
  if (kind === 'bank_sync' && action === undefined) return err('unknown_action', { action: 'bank_sync' });
  if (job.leaseHolder !== undefined) setSyncLeaseHolder(job.leaseHolder);
  let ports: Pick<HostEbicsPorts, 'ebicsTransport' | 'ebicsKeystore'>;
  try {
    ports = await resolvePorts(job);
  } catch (e) {
    // A live wire the owner asked for that cannot be built is loud, never an offline success.
    return err('sync_worker_failed', { action: kind, stage: 'wire', message: e instanceof Error ? e.message : String(e) });
  }
  const store = new SqliteStore({ location: job.dbPath });
  try {
    if (kind === 'activation_check') return runActivationCheck(store, job, ports);
    if (action === undefined) return err('unknown_action', { action: 'bank_sync' });
    const deps: ApiDeps = {
      store,
      clock: systemClock,
      ids: systemIdGen,
      actor: job.actor,
      diagnostics: makeDiagnosticsPort(),
      ...(job.subject !== undefined ? { subject: job.subject } : {}),
      ...(job.identitySource !== undefined ? { identitySource: job.identitySource as ApiDeps['identitySource'] } : {}),
      ...(ports.ebicsTransport !== undefined ? { ebicsTransport: ports.ebicsTransport } : {}),
      ...(ports.ebicsKeystore !== undefined ? { ebicsKeystore: ports.ebicsKeystore } : {}),
    };
    // `run`, never `runAsync`: this IS the off-thread run, and `deps` carries no runner.
    return action.run(deps, job.input);
  } finally {
    store.close();
  }
}

if (parentPort !== null && workerData !== null && typeof workerData === 'object' && 'dbPath' in (workerData as object)) {
  const port = parentPort;
  void runBankSyncJob(workerData as BankSyncJob)
    .then((result) => port.postMessage({ result } satisfies BankSyncReply))
    .catch((e: unknown) =>
      port.postMessage({
        result: err('sync_worker_failed', { action: 'bank_sync', stage: 'run', message: e instanceof Error ? e.message : String(e) }),
      } satisfies BankSyncReply),
    );
}
