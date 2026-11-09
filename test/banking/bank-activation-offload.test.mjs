// D143 critic F1: the daily activation check never blocks the `till up` process on the wire. Under
// `till up` the probe runs in the D142 worker (`createBankActivationOffload`), and `scheduler.start()`
// never runs a probe inside its own call stack. The critic's method: a slow synthetic bank whose HPB parks
// its thread with `Atomics.wait` (the live wire's shape), and a timer armed before `start()` that must fire
// on time. All fixtures synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syntheticIban, mockBank } from './ebics-support.mjs';
import { makeApiDeps } from '../../dist/api/mcp.js';
import { createBankActivationOffload } from '../../dist/api/bank-sync-offload.js';
import { createScheduler } from '../../dist/api/scheduler.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { connectBankChannel, zurichInstant } from '../../dist/core/banking/ebics/index.js';
import { makeContext } from '../../dist/core/context.js';

const PORTS = new URL('./fixtures/slow-bank-ports.mjs', import.meta.url).href;
// Critic R3-4: a loaded box delays a free event loop by hundreds of ms, so the bound for the timer is 2 s;
// the synthetic HPB blocks 4 s, so a probe on the main thread (the finding: 5 s) still shows as late.
const SLOW_MS = 4000;
const TIMER_BOUND_MS = 2000;
const NOW = zurichInstant('2026-10-05', '07:05');

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

/** A file-backed book with one connection waiting for the bank (both legs confirmed). */
function pendingWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'till-d143-'));
  const dbPath = join(dir, 'book.db');
  const { deps, store } = makeApiDeps(dbPath);
  const workspaceId = must(createWorkspace(deps, { name: 'Synthetische Freischaltung Offload GmbH' }), 'workspace').workspaceId;
  const bank = mockBank();
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock: deps.clock, ids: deps.ids, ebicsTransport: bank.port });
  const ledger = store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1020'").get(workspaceId).id;
  const accountId = must(createBankAccount(ctx, { name: 'Konto Offload', iban: syntheticIban(4343), ledgerAccountId: ledger, idempotencyKey: 'ba-act' }), 'account').bankAccountId;
  const host = { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHOFA', partnerId: 'PARTNER43', userId: 'USER0043' };
  const c = must(connectBankChannel(ctx, { host, routeBankAccountIds: [accountId], confirm: true, idempotencyKey: 'c-act' }), 'connect');
  assert.equal(c.state, 'pending_bank_activation');
  return {
    deps,
    store,
    dbPath,
    workspaceId,
    connectionId: c.connectionId,
    rows: () => store.db.prepare("SELECT outcome_code, retryable FROM ebics_activation_check WHERE workspace_id = ? AND outcome_code != 'started' ORDER BY rowid").all(workspaceId),
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitFor(pred, ms = 20_000) {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('F1: start() returns at once and the event loop stays free while the probe waits on a slow bank', async () => {
  const w = pendingWorld();
  const scheduler = createScheduler(
    {
      ...w.deps,
      actor: 'studio',
      bankActivationRunner: createBankActivationOffload({ dbPath: w.dbPath, portsModule: PORTS, portsOptions: { hpbDelayMs: SLOW_MS } }),
    },
    { runDue: () => {}, now: () => new Date(NOW) },
  );
  try {
    const t0 = Date.now();
    let timerAt = null;
    setTimeout(() => {
      timerAt = Date.now() - t0;
    }, 10);
    scheduler.start();
    const startReturned = Date.now() - t0;
    assert.ok(startReturned < 200, `start() returned after ${startReturned} ms`);
    await waitFor(() => timerAt !== null, 5_000);
    assert.ok(timerAt < TIMER_BOUND_MS, `a 10 ms timer armed before start() fired at ${timerAt} ms`);
    // The probe really ran, in the worker, and recorded its outcome in the shared book.
    await waitFor(() => w.rows().length === 1);
    assert.deepEqual(w.rows()[0], { outcome_code: 'bank_ready', retryable: 0 });
    assert.ok(Date.now() - t0 >= SLOW_MS - 50, 'the slow HPB was really waited for, off the main thread');
  } finally {
    scheduler.stop();
    w.cleanup();
  }
});

test('F1: without a runner the probe still never runs inside start()', async () => {
  const w = pendingWorld();
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const bank = mockBank();
  const slow = {
    ...bank.port,
    fetchBankKeys(req) {
      Atomics.wait(cell, 0, 0, 400);
      return bank.port.fetchBankKeys(req);
    },
  };
  const scheduler = createScheduler({ ...w.deps, actor: 'studio', ebicsTransport: slow }, { runDue: () => {}, now: () => new Date(NOW) });
  try {
    const t0 = Date.now();
    scheduler.start();
    const startReturned = Date.now() - t0;
    assert.ok(startReturned < 200, `start() returned after ${startReturned} ms`);
    await waitFor(() => w.rows().length === 1);
  } finally {
    scheduler.stop();
    w.cleanup();
  }
});

test('critic R2-1: a worker that fails before its started mark is counted, so it runs at most once an hour and three times a day', async () => {
  const w = pendingWorld();
  let workerFailures = 0;
  const start = Date.parse(zurichInstant('2026-10-05', '07:01'));
  let clock = new Date(start).toISOString();
  const scheduler = createScheduler(
    {
      ...w.deps,
      actor: 'studio',
      diagnostics: {
        record(entry) {
          if (entry.code === 'bank_activation_check_failed') workerFailures += 1;
        },
      },
      // The worker cannot even build its ports: the module it is told to load does not exist.
      bankActivationRunner: createBankActivationOffload({ dbPath: w.dbPath, portsModule: new URL('./fixtures/does-not-exist.mjs', import.meta.url).href }),
    },
    { runDue: () => {}, now: () => new Date(clock) },
  );
  const checkRows = () =>
    w.store.db
      .prepare("SELECT attempt, outcome_code, retryable, bank_code FROM ebics_activation_check WHERE workspace_id = ? AND outcome_code != 'started' ORDER BY rowid")
      .all(w.workspaceId);
  try {
    // Ten ticks, one minute apart: one worker run, one counted attempt.
    for (let i = 0; i < 10; i += 1) {
      clock = new Date(start + i * 60_000).toISOString();
      await scheduler.bankTickOnce();
    }
    assert.equal(workerFailures, 1, 'one worker run in ten minutes, not one per tick');
    assert.deepEqual(checkRows(), [{ attempt: 1, outcome_code: 'worker_failed', retryable: 1, bank_code: 'sync_worker_failed' }]);
    // The rest of the day, a tick every ten minutes: at most three runs, an hour apart.
    for (let minute = 10; minute < 16 * 60; minute += 10) {
      clock = new Date(start + minute * 60_000).toISOString();
      await scheduler.bankTickOnce();
    }
    assert.equal(workerFailures, 3, 'three worker runs that day');
    assert.deepEqual(
      checkRows().map((r) => r.attempt),
      [1, 2, 3],
    );
  } finally {
    scheduler.stop();
    w.cleanup();
  }
});
