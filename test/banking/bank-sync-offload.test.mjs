// D142, THE SYNC OFF THE MAIN THREAD (A36 §12): under `till up` the whole `bank_sync` runs in a worker
// thread on its own SQLite connection, so the server keeps answering while the bank wire waits, and one
// sync per connection holds across threads (`sync_in_progress`).
//
// The bank behind the worker is the synthetic in-process bank of `ebics-support.mjs`, loaded through the
// worker's ports seam (`fixtures/slow-bank-ports.mjs`); every download there BLOCKS its thread with
// `Atomics.wait`, the way the real synchronous wire does. Were the sync on the main thread, the requests
// this suite sends meanwhile would wait for the whole delay. All fixtures synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { syntheticIban, chain, container, mockBank } from './ebics-support.mjs';
import { makeApiDeps } from '../../dist/api/mcp.js';
import { createLocalHttpRouter } from '../../dist/api/local-http.js';
import { createBankActivationOffload, createBankSyncOffload, isSharableDbPath } from '../../dist/api/bank-sync-offload.js';
import { getAction } from '../../dist/api/registry.js';
import { runGovernedAsync } from '../../dist/api/agent-gate.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';
import { connectBankChannel, reclaimDeadSyncLeases } from '../../dist/core/banking/ebics/index.js';
import { startUp } from '../../dist/api/up.js';
import { makeContext } from '../../dist/core/context.js';
import { mintStudioKey, studioHeaders } from '../api/studio-key-support.mjs';

const PORTS = new URL('./fixtures/slow-bank-ports.mjs', import.meta.url).href;
const HOST = { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHOFF', partnerId: 'PARTNER77', userId: 'USER0077' };

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

/** A file-backed book with one active EBICS channel routed to one account, the first statement bridged. */
function fileWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'till-d141-'));
  const dbPath = join(dir, 'book.db');
  const { deps, store } = makeApiDeps(dbPath);
  const workspaceId = must(createWorkspace(deps, { name: 'Synthetische Offload GmbH' }), 'workspace').workspaceId;
  const bank = mockBank();
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock: deps.clock, ids: deps.ids, ebicsTransport: bank.port });
  const ledger = store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1020'").get(workspaceId).id;
  const iban = syntheticIban(4141);
  const accountId = must(createBankAccount(ctx, { name: 'Konto Offload', iban, ledgerAccountId: ledger, idempotencyKey: 'ba-off' }), 'account').bankAccountId;
  const statements = chain({ iban, firstSeq: 1, firstDate: '2026-09-01', opening: 50000, days: [[{ minor: 1200 }], [{ minor: -300 }]] });
  must(importCamt(ctx, { bankAccountId: accountId, xml: statements[0].xml, idempotencyKey: 'bridge-1' }), 'bridge');
  const c = must(connectBankChannel(ctx, { host: HOST, routeBankAccountIds: [accountId], confirm: true, idempotencyKey: 'c-off' }), 'connect');
  const fetched = must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true }), 'fetch');
  must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'confirm');
  return {
    dir,
    dbPath,
    deps,
    store,
    workspaceId,
    accountId,
    connectionId: c.connectionId,
    next: container([statements[1].xml]).toString('base64'),
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withServer(deps, body) {
  // The REST twins are the Studio's door: this suite calls them as the Studio, with the host's key.
  const studioKey = mintStudioKey();
  const router = createLocalHttpRouter(deps, { rest: true, studioKey });
  const http = createServer((req, res) => {
    void router.handle(req, res).then((handled) => {
      if (handled) return;
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  try {
    await body((action, input) =>
      fetch(`http://127.0.0.1:${port}/api/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...studioHeaders(studioKey) },
        body: JSON.stringify(input),
      }).then((r) => r.json()),
    );
  } finally {
    await router.closeAll();
    await new Promise((resolve) => http.close(resolve));
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The thread a stand-in worker pretends to be. A real `worker_threads` Worker is a REF'D handle: while
 * its thread runs it keeps the host's event loop alive, and that is what lets the runner's timeout fire
 * (that timer is unref'd, `src/api/bank-sync-offload.ts`, so it never holds `till up` open by itself).
 * A stand-in passed through the `createWorker` seam holds no handle of its own, so without this the
 * job's only pending timer is unref'd and the loop drains before the timeout fires. Node 22's node:test
 * then cancels the test and every one after it ("Promise resolution is still pending but the event loop
 * has already resolved"); Node 24+ keeps the loop alive for a pending test and hid the gap.
 *
 * `start()` when the stand-in is spawned, `gone()` when its thread would have exited (idempotent). A
 * stand-in that never exits is let go by the test's `finally`, as the process ending would.
 */
function standInThread() {
  let handle;
  return {
    start() {
      handle ??= setInterval(() => {}, 60_000);
    },
    gone() {
      clearInterval(handle);
    },
  };
}

test('an in-memory book is never offloaded: a thread cannot open it', () => {
  assert.equal(isSharableDbPath(undefined), false);
  assert.equal(isSharableDbPath(':memory:'), false);
  assert.equal(isSharableDbPath('/tmp/x/book.db'), true);
});

test('D142: the server answers while the sync waits on the bank, and the sync still imports the statement', async () => {
  const w = fileWorld();
  try {
    const gate = new SharedArrayBuffer(4);
    const open = () => {
      const cell = new Int32Array(gate);
      Atomics.store(cell, 0, 1);
      Atomics.notify(cell, 0);
    };
    const deps = {
      ...w.deps,
      actor: 'studio',
      bankSyncRunner: createBankSyncOffload({ dbPath: w.dbPath, portsModule: PORTS, portsOptions: { gate, containersBase64: [w.next] } }),
    };
    await withServer(deps, async (post) => {
      let finishedAt = null;
      const sync = post('bank_sync', { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'press-1' }).then((r) => {
        finishedAt = Date.now();
        return r;
      });
      try {
        // Wait until the worker holds the lease (it opens the book and takes it before the download).
        let status;
        for (let i = 0; i < 600; i += 1) {
          await delay(50);
          status = await post('bank_channel_status', { workspaceId: w.workspaceId });
          if (status.channels?.[0]?.syncInProgress === true) break;
        }
        assert.equal(status.ok, true, JSON.stringify(status));
        assert.equal(status.channels[0].syncInProgress, true, 'the status names the running sync, answered while the wire blocks');
        assert.equal(typeof status.channels[0].syncStartedAt, 'string');
        assert.equal(finishedAt, null, 'the sync is still waiting on the bank');
        // A second press meanwhile is refused, never joined.
        const second = await post('bank_sync', { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'press-2' });
        assert.equal(second.ok, false, JSON.stringify(second));
        assert.equal(second.error, 'sync_in_progress');
        assert.equal(second.connectionId, w.connectionId);
        assert.equal(finishedAt, null, 'the first sync is still waiting after the refusal');
      } finally {
        open();
      }
      const result = await sync;
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.download.outcome, 'downloaded');
      assert.equal(result.download.newMembers, 1);
      const n = w.store.db.prepare('SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ? AND bank_account_id = ?').get(w.workspaceId, w.accountId).n;
      assert.equal(n, 2, 'the worker imported the successor into the SAME book the main thread reads');
      const after = await post('bank_channel_status', { workspaceId: w.workspaceId });
      assert.equal(after.channels[0].syncInProgress, false, 'the lease is released when the sync ends');
      assert.equal(after.channels[0].syncStartedAt, null);
    });
  } finally {
    w.cleanup();
  }
});

test('D142: the awaiting door is the verb itself: without a runner it runs in process, same answer', async () => {
  const w = fileWorld();
  try {
    const action = getAction('bank_sync');
    // No transport wired in process: the honest degrade, identical through run and runAsync.
    const viaRun = action.run({ ...w.deps, actor: 'studio' }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'k-run' });
    const viaAsync = await runGovernedAsync({ ...w.deps, actor: 'studio' }, action, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'k-async' });
    assert.equal(viaRun.ok, true);
    assert.equal(viaRun.reason, 'needs_bank_transport');
    assert.deepEqual({ ...viaAsync }, { ...viaRun });
  } finally {
    w.cleanup();
  }
});

test('D142: a worker that cannot build its wire answers sync_worker_failed, never an offline success', async () => {
  const w = fileWorld();
  try {
    const runner = createBankSyncOffload({ dbPath: w.dbPath, portsModule: new URL('./fixtures/does-not-exist.mjs', import.meta.url).href });
    const result = await runner({ ...w.deps, actor: 'studio' }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'k-bad' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'sync_worker_failed');
    assert.equal(result.stage, 'wire');
  } finally {
    w.cleanup();
  }
});

test('D142: a stale lease (a process that died mid-sync) is taken over; a live one is refused', () => {
  const w = fileWorld();
  try {
    const action = getAction('bank_sync');
    const now = Date.now();
    const live = new Date(now - 60_000).toISOString();
    const stale = new Date(now - 16 * 60_000).toISOString();
    const setLease = (v) => w.store.db.prepare('UPDATE ebics_connection SET sync_started_at = ? WHERE id = ?').run(v, w.connectionId);
    const bank = mockBank();
    const deps = { ...w.deps, actor: 'studio', ebicsTransport: bank.port };
    setLease(live);
    const refused = action.run(deps, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'lease-1' });
    assert.equal(refused.error, 'sync_in_progress');
    assert.equal(refused.syncStartedAt, live);
    assert.equal(bank.log.filter((l) => l.kind === 'BTD').length, 0, 'nothing reached the bank');
    setLease(stale);
    const taken = action.run(deps, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'lease-2' });
    assert.equal(taken.ok, true, JSON.stringify(taken));
    assert.equal(taken.download.outcome, 'no_data');
    assert.equal(w.store.db.prepare('SELECT sync_started_at AS s FROM ebics_connection WHERE id = ?').get(w.connectionId).s, null);
  } finally {
    w.cleanup();
  }
});

test('D142: the worker builds the live wire through the TILL_EBICS_RUNTIME seam from the host recipe', async () => {
  const w = fileWorld();
  try {
    const recipe = {
      specifier: new URL('../api/fixtures/fake-ebics-wire.mjs', import.meta.url).href,
      keystorePath: join(w.dir, 'ebics-keystore.json'),
      passphrase: 'synthetic passphrase for a throwaway keystore',
    };
    const runner = createBankSyncOffload({ dbPath: w.dbPath, recipe });
    const result = await runner({ ...w.deps, actor: 'studio' }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'k-recipe' });
    // The stand-in wire answers nothing a bank would, so the sync refuses; what matters is that the
    // worker BUILT the wire (a build failure is sync_worker_failed, stage wire) and reached the verb.
    assert.notEqual(result.error, 'sync_worker_failed', JSON.stringify(result));
    assert.equal(result.error === 'needs_bank_transport' || result.reason === 'needs_bank_transport', false, 'a wire was wired');

    const broken = createBankSyncOffload({ dbPath: w.dbPath, recipe: { ...recipe, specifier: new URL('./fixtures/slow-bank-ports.mjs', import.meta.url).href } });
    const refused = await broken({ ...w.deps, actor: 'studio' }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'k-broken' });
    assert.deepEqual([refused.error, refused.stage], ['sync_worker_failed', 'wire'], 'a module that is no wire is loud, never an offline success');
  } finally {
    w.cleanup();
  }
});

// --- Critic F2 (MEDIUM): a sync that ends abnormally never leaves a lease saying a fetch is running --------

const leaseOf = (w) => w.store.db.prepare('SELECT sync_started_at AS s, sync_lease_owner AS o FROM ebics_connection WHERE id = ?').get(w.connectionId);
const openGate = (gate) => {
  const cell = new Int32Array(gate);
  Atomics.store(cell, 0, 1);
  Atomics.notify(cell, 0);
};

test('F2: a worker the host gives up on (timeout) releases its lease; the next press is not refused', async () => {
  const w = fileWorld();
  const gate = new SharedArrayBuffer(4);
  try {
    const runner = createBankSyncOffload({ dbPath: w.dbPath, portsModule: PORTS, portsOptions: { gate, containersBase64: [w.next] }, timeoutMs: 2500 });
    const first = await runner({ ...w.deps, actor: 'studio' }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'to-1' });
    assert.deepEqual([first.error, first.stage], ['sync_worker_failed', 'timeout']);
    assert.equal(first.retryable, true, 'a timeout is not a state a person must clear');
    assert.deepEqual(leaseOf(w), { s: null, o: null }, 'the host cleared exactly its job\'s lease');
    const status = must(getAction('bank_channel_status').run({ ...w.deps, actor: 'studio' }, { workspaceId: w.workspaceId }), 'status');
    assert.equal(status.channels[0].syncInProgress, false);
    const bank = mockBank();
    const again = getAction('bank_sync').run({ ...w.deps, actor: 'studio', ebicsTransport: bank.port }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'to-2' });
    assert.notEqual(again.error, 'sync_in_progress', JSON.stringify(again));
  } finally {
    openGate(gate);
    w.cleanup();
  }
});

test('F2: a worker that dies mid-sync releases its lease (exit without an answer)', async () => {
  const w = fileWorld();
  try {
    const runner = createBankSyncOffload({ dbPath: w.dbPath, portsModule: PORTS, portsOptions: { crash: true } });
    const result = await runner({ ...w.deps, actor: 'studio' }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'crash-1' });
    assert.deepEqual([result.error, result.stage], ['sync_worker_failed', 'exit']);
    assert.deepEqual(leaseOf(w), { s: null, o: null });
  } finally {
    w.cleanup();
  }
});

test('F2: the lease names its holder, and a refused second press says when it started and when it frees itself', () => {
  const w = fileWorld();
  try {
    const started = new Date(Date.now() - 60_000).toISOString();
    w.store.db.prepare('UPDATE ebics_connection SET sync_started_at = ?, sync_lease_owner = ? WHERE id = ?').run(started, 'pid:1:boot:other', w.connectionId);
    const refused = getAction('bank_sync').run({ ...w.deps, actor: 'studio', ebicsTransport: mockBank().port }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'ref-1' });
    assert.equal(refused.error, 'sync_in_progress');
    assert.equal(refused.syncStartedAt, started);
    assert.equal(refused.freesAt, new Date(Date.parse(started) + 15 * 60_000).toISOString());
    assert.doesNotMatch(refused.reason, /its answer arrives/, 'no promise of an answer that may never come');
  } finally {
    w.cleanup();
  }
});

test('F2: at boot, a lease whose holder process is dead is taken over; a live foreign holder keeps it', () => {
  const w = fileWorld();
  try {
    const set = (owner) => w.store.db.prepare('UPDATE ebics_connection SET sync_started_at = ?, sync_lease_owner = ? WHERE id = ?').run(new Date().toISOString(), owner, w.connectionId);
    set('pid:4242:boot:gone:job:1');
    assert.equal(reclaimDeadSyncLeases(w.store, (pid) => pid !== 4242), 1);
    assert.deepEqual(leaseOf(w), { s: null, o: null });
    set('pid:777:boot:alive');
    assert.equal(reclaimDeadSyncLeases(w.store, () => true), 0);
    assert.equal(leaseOf(w).o, 'pid:777:boot:alive', 'another live process (an MCP agent) keeps its lease');
    // Our own pid under another boot is a previous process that got the same pid back.
    set(`pid:${process.pid}:boot:an-earlier-boot`);
    assert.equal(reclaimDeadSyncLeases(w.store, () => true), 1);
    assert.equal(leaseOf(w).o, null);
  } finally {
    w.cleanup();
  }
});

test('F2: a process killed mid-sync, then `till up` restarted on the same book, frees the lease at boot', async () => {
  const w = fileWorld();
  const supportDir = mkdtempSync(join(tmpdir(), 'till-d141-up-'));
  try {
    // The dead process: a real pid that has exited, holding the lease it never released.
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    w.store.db.prepare("UPDATE ebics_connection SET sync_started_at = ?, sync_lease_owner = ?, auto_sync_mode = 'off' WHERE id = ?").run(new Date().toISOString(), `pid:${dead}:boot:killed:job:1`, w.connectionId);
    const up = await startUp({ dbPath: w.dbPath, host: '127.0.0.1', port: 0, supportDir, studioDir: null, open: false });
    assert.equal(up.started, true);
    try {
      assert.deepEqual(leaseOf(w), { s: null, o: null }, 'the restart took the dead holder\'s lease over');
    } finally {
      await up.close();
    }
  } finally {
    rmSync(supportDir, { recursive: true, force: true });
    w.cleanup();
  }
});

test('critic R2-3b: on a timeout the host clears the lease only AFTER the worker is gone, so a lease taken in that window is cleared too', async () => {
  const w = fileWorld();
  const thread = standInThread();
  try {
    // A stand-in worker that never answers, and whose termination takes a moment during which it takes
    // its job's lease: the window the critic named (a worker that takes its lease as the host gives up).
    const createWorker = (_url, { workerData }) => {
      const handlers = {};
      thread.start();
      return {
        once(event, fn) {
          handlers[event] = fn;
          return this;
        },
        terminate() {
          return new Promise((resolveTerminate) => {
            setTimeout(() => {
              w.store.db
                .prepare('UPDATE ebics_connection SET sync_started_at = ?, sync_lease_owner = ? WHERE id = ?')
                .run(new Date().toISOString(), workerData.leaseHolder, w.connectionId);
              thread.gone();
              resolveTerminate(1);
              handlers.exit?.(1);
            }, 30);
          });
        },
      };
    };
    const runner = createBankSyncOffload({ dbPath: w.dbPath, timeoutMs: 50, createWorker });
    const result = await runner({ ...w.deps, actor: 'studio' }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'r23b' });
    assert.deepEqual([result.error, result.stage], ['sync_worker_failed', 'timeout']);
    // Let any termination still under way finish before looking: a lease cleared too early would be back.
    await delay(100);
    assert.deepEqual(leaseOf(w), { s: null, o: null }, 'the lease the worker took while terminating is cleared');
  } finally {
    thread.gone();
    w.cleanup();
  }
});

// --- Critic R3-1 (LOW): a worker whose termination never finishes cannot hang the press or the tick ------

/**
 * A stand-in worker that takes its job's lease the moment it starts (bank_sync only), never answers, and
 * whose `terminate()` never resolves: a thread parked in a native call that cannot be interrupted. It
 * holds the loop like that thread would, until the test's `finally` lets it go.
 */
function wedgedWorker(w, spawned, thread) {
  return (_url, { workerData }) => {
    spawned.push(workerData);
    thread.start();
    if (workerData.kind === 'bank_sync') {
      w.store.db
        .prepare('UPDATE ebics_connection SET sync_started_at = ?, sync_lease_owner = ? WHERE id = ?')
        .run(new Date().toISOString(), workerData.leaseHolder, w.connectionId);
    }
    return {
      once() {
        return this;
      },
      terminate: () => new Promise(() => {}),
    };
  };
}

/** The runner's answer, or 'hung' when none came by `ms`: a hang fails the test instead of stalling it. */
const within = (promise, ms) => Promise.race([promise, delay(ms).then(() => 'hung')]);

for (const kind of ['bank_sync', 'activation_check']) {
  test(`critic R3-1: a worker (${kind}) whose terminate() never resolves settles sync_worker_failed within the grace period`, async () => {
    const w = fileWorld();
    // Never gone: the thread is parked for good, so only the test's end lets it go.
    const thread = standInThread();
    try {
      const spawned = [];
      const timeoutMs = 40;
      const terminateGraceMs = 300;
      const make = kind === 'bank_sync' ? createBankSyncOffload : createBankActivationOffload;
      const runner = make({ dbPath: w.dbPath, timeoutMs, terminateGraceMs, createWorker: wedgedWorker(w, spawned, thread) });
      const started = Date.now();
      const pending = runner({ ...w.deps, actor: 'studio' }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: `r31-${kind}` });
      assert.equal(spawned[0].kind, kind);

      // Halfway through the grace period the job is still open, and a lease it took is still held:
      // nothing is cleared while the worker may yet be running (critic R2-3b).
      assert.equal(await within(pending, timeoutMs + terminateGraceMs / 2), 'hung', 'settled before the grace period ended');
      if (kind === 'bank_sync') assert.equal(leaseOf(w).o, spawned[0].leaseHolder, 'the lease is not cleared before the grace period ends');

      const result = await within(pending, 5000);
      assert.notEqual(result, 'hung', 'the press never settled: abandon() waited on terminate() with no backstop');
      const elapsed = Date.now() - started;
      assert.deepEqual([result.error, result.stage, result.action], ['sync_worker_failed', 'timeout', kind]);
      assert.equal(result.retryable, true, 'a wedged worker is retried like any failed worker');
      assert.equal(result.terminated, false, 'the answer says the worker was not confirmed gone');
      assert.ok(elapsed < timeoutMs + terminateGraceMs + 2000, `settled within the grace period (took ${elapsed} ms)`);
      assert.deepEqual(leaseOf(w), { s: null, o: null }, 'the lease is released when the grace period ends');
    } finally {
      thread.gone();
      w.cleanup();
    }
  });
}

// --- Critic LA-1 / LA-2 (D143 landing review): the lease is released strictly by holder -------------------
//
// R3-1 made the holder fence load-bearing: `void gone.then(releaseLease)` fires whenever a wedged worker
// finally exits, and by then another job may hold the connection's lease. These cases stamp a FOREIGN
// holder (as a second job or an MCP agent process would) and prove that neither the release at the grace
// nor the late one clears it, and that the late release is what frees the job's own lease when the one
// at the grace failed on the write lock.

const stampLease = (w, holder) =>
  w.store.db
    .prepare('UPDATE ebics_connection SET sync_started_at = ?, sync_lease_owner = ? WHERE id = ?')
    .run(new Date().toISOString(), holder, w.connectionId);

/**
 * A stand-in worker that never answers and whose `terminate()` stays pending until the test calls
 * `finish()`: the wedged worker of R3-1, but one the test can let go of. With `takeLease`, it takes its
 * job's lease the moment it starts. Its thread holds the loop from spawn until `finish()` (the exit);
 * `letGo()` drops that hold without an exit, for the test's `finally`.
 */
function controllableWorker(w, { takeLease }) {
  const spawned = [];
  const thread = standInThread();
  let finish = () => {};
  const gone = new Promise((resolveGone) => {
    finish = () => {
      thread.gone();
      resolveGone(1);
    };
  });
  const createWorker = (_url, { workerData }) => {
    spawned.push(workerData);
    thread.start();
    if (takeLease) stampLease(w, workerData.leaseHolder);
    return {
      once() {
        return this;
      },
      terminate: () => gone,
    };
  };
  return { createWorker, spawned, finish: () => finish(), letGo: () => thread.gone() };
}

const FOREIGN = 'pid:9191:boot:another-job:job:foreign';

test('critic LA-1: the late release after a wedged worker exits leaves a lease another job took', async () => {
  const w = fileWorld();
  const wedged = controllableWorker(w, { takeLease: true });
  try {
    const runner = createBankSyncOffload({ dbPath: w.dbPath, timeoutMs: 30, terminateGraceMs: 150, createWorker: wedged.createWorker });
    const result = await within(runner({ ...w.deps, actor: 'studio' }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'la1-late' }), 5000);
    assert.notEqual(result, 'hung');
    assert.deepEqual([result.error, result.terminated], ['sync_worker_failed', false]);
    assert.deepEqual(leaseOf(w), { s: null, o: null }, "the job's own lease is cleared at the grace");

    // A second job takes the free lease, as it may once the grace has cleared the first one's.
    stampLease(w, FOREIGN);
    // Now the wedged worker finally exits, and the late `gone.then(releaseLease)` runs.
    wedged.finish();
    await delay(50);
    assert.equal(leaseOf(w).o, FOREIGN, 'the late release cleared a lease the second job holds (holder fence lost)');
    assert.notEqual(leaseOf(w).s, null);
  } finally {
    wedged.letGo();
    w.cleanup();
  }
});

test('critic LA-1: the release at the grace, and the late one, leave a lease another holder took', async () => {
  const w = fileWorld();
  // The wedged worker never reached its lease (parked before it, in the key unlock or the wire), while
  // another process (an MCP agent beside till up) holds the connection's lease.
  const wedged = controllableWorker(w, { takeLease: false });
  try {
    stampLease(w, FOREIGN);
    const runner = createBankSyncOffload({ dbPath: w.dbPath, timeoutMs: 30, terminateGraceMs: 150, createWorker: wedged.createWorker });
    const result = await within(runner({ ...w.deps, actor: 'studio' }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'la1-grace' }), 5000);
    assert.notEqual(result, 'hung');
    assert.deepEqual([result.error, result.terminated], ['sync_worker_failed', false]);
    assert.equal(leaseOf(w).o, FOREIGN, 'the release at the grace cleared a lease another holder took');
    wedged.finish();
    await delay(50);
    assert.equal(leaseOf(w).o, FOREIGN, 'the late release cleared a lease another holder took');
  } finally {
    wedged.letGo();
    w.cleanup();
  }
});

test("critic LA-2: when the release at the grace fails on the write lock, the late release frees the job's lease", async () => {
  const w = fileWorld();
  // The wedged worker's own connection, parked inside its persist transaction: it holds the write lock.
  const parked = new Database(w.dbPath);
  const wedged = controllableWorker(w, { takeLease: true });
  try {
    // The host's release waits this long for the lock before it fails (5 s by default, A36 §12).
    w.store.db.pragma('busy_timeout = 100');
    const failures = [];
    const deps = { ...w.deps, actor: 'studio', diagnostics: { record: (event) => failures.push(event) } };
    const runner = createBankSyncOffload({ dbPath: w.dbPath, timeoutMs: 30, terminateGraceMs: 150, createWorker: wedged.createWorker });
    const pending = runner(deps, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'la2' });
    const holder = wedged.spawned[0].leaseHolder;
    parked.prepare('BEGIN IMMEDIATE').run();

    const result = await within(pending, 5000);
    assert.notEqual(result, 'hung');
    assert.deepEqual([result.error, result.terminated], ['sync_worker_failed', false]);
    assert.deepEqual(
      failures.map((f) => f.code),
      ['sync_lease_release_failed'],
      'the release at the grace hit the write lock',
    );
    assert.equal(leaseOf(w).o, holder, 'the write-lock case keeps the lease: SQLite serialises it');

    // The worker's thread finally dies: its transaction rolls back, the lock is free, and it is gone.
    parked.prepare('ROLLBACK').run();
    wedged.finish();
    await delay(50);
    assert.deepEqual(leaseOf(w), { s: null, o: null }, "the late release did not free the job's lease (it would wait for the 15-minute expiry)");
  } finally {
    wedged.letGo();
    if (parked.inTransaction) parked.prepare('ROLLBACK').run();
    parked.close();
    w.cleanup();
  }
});
