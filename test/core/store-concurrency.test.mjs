// D12 put a second writer on the file: the Studio holds the database open while `till mcp` runs in
// an agent subprocess. These pin the three things that changes: a lock is WAITED for rather than
// failing instantly, a lock that does time out is a NAMED error rather than a shrug, and the WAL is
// checkpointed on a clean close instead of growing without bound.
//
// "Waited for" is asserted against a REAL second process holding the lock, not by reading the
// `busy_timeout` pragma: the pragma stayed at 5000 ms through a round in which every transaction
// began DEFERRED and read the generation marker first, and a transaction that has read never waits
// for the write lock, so 97 of 124 Studio posts failed at once against a second posting process
// (critic R2-1). The two D12 tests below are ports of that critic's probes q1 and q2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { SqliteStore, DEFAULT_BUSY_TIMEOUT_MS, isBusyError } from '../../dist/core/store/sqlite-store.js';
import { getAction } from '../../dist/api/registry.js';
import { KMU_CORE_SEED } from '../../dist/core/accounts/index.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { mintWorkspace, manualPost } from '../api/support.mjs';
import { lockHolder } from '../support/lock-holder.mjs';

function tempDb(name = 'till.db') {
  return join(mkdtempSync(join(tmpdir(), 'till-store-')), name);
}

test('a store waits for a held lock instead of failing instantly', () => {
  const store = new SqliteStore({ location: ':memory:' });
  const [{ timeout }] = store.db.pragma('busy_timeout');
  assert.equal(timeout, DEFAULT_BUSY_TIMEOUT_MS);
  assert.ok(DEFAULT_BUSY_TIMEOUT_MS > 0, 'a zero timeout is the no-waiting default this replaces');
  store.close();
});

test('the busy timeout is configurable, for a caller that wants to fail faster', () => {
  const store = new SqliteStore({ location: ':memory:', busyTimeoutMs: 250 });
  const [{ timeout }] = store.db.pragma('busy_timeout');
  assert.equal(timeout, 250);
  store.close();
});

test('isBusyError recognises a lock contention error and nothing else', () => {
  assert.equal(isBusyError(Object.assign(new Error('db locked'), { code: 'SQLITE_BUSY' })), true);
  assert.equal(isBusyError(Object.assign(new Error('locked'), { code: 'SQLITE_BUSY_SNAPSHOT' })), true);
  assert.equal(isBusyError(Object.assign(new Error('nope'), { code: 'SQLITE_CONSTRAINT' })), false);
  assert.equal(isBusyError(new Error('plain')), false);
  assert.equal(isBusyError('not an error'), false);
});

test('a SQLITE_BUSY escaping a verb is a NAMED, retryable rejection, not unexpected_error', () => {
  // A store stub whose very first query throws the way a locked database does. It goes through the
  // real ctxAction guard, which is the code path that used to flatten this to `unexpected_error`:
  // a caller could not tell "try again in a moment" from "something is broken".
  const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  const deps = {
    store: {
      db: {
        prepare() {
          throw busy;
        },
      },
    },
    clock: { now: () => '2026-07-20T00:00:00.000Z' },
    ids: { next: () => 'x' },
    actor: 'studio',
  };

  const res = getAction('list_accounts').run(deps, { workspaceId: 'ws_1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'store_busy', 'lock contention must be its own error code');
  assert.equal(res.retryable, true, 'the caller needs to know this one is worth retrying');
  assert.equal(res.action, 'list_accounts');
});

test('a non-busy throw is still unexpected_error, so the new code stays meaningful', () => {
  const deps = {
    store: {
      db: {
        prepare() {
          throw new TypeError('something genuinely broken');
        },
      },
    },
    clock: { now: () => '2026-07-20T00:00:00.000Z' },
    ids: { next: () => 'x' },
    actor: 'studio',
  };

  const res = getAction('list_accounts').run(deps, { workspaceId: 'ws_1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unexpected_error');
});

test('a clean close checkpoints the WAL, so till.db-wal does not grow without bound', () => {
  const path = tempDb();
  const store = new SqliteStore({ location: path });
  // A real id supply. Until 2026-09-10 this generator answered `acc_1` to every call, and the birth
  // seed's `INSERT OR IGNORE` swallowed the primary-key collision on every seed row after the first:
  // the workspace was born with ONE account of the whole chart and reported ok. A38's top-up
  // (`src/core/accounts/topUp.ts`) refuses the collision instead, which is what exposed the fixture.
  let n = 0;
  const res = getAction('create_workspace').run(
    { store, clock: { now: () => '2026-07-20T00:00:00.000Z' }, ids: { next: (p) => `${p}_${++n}` }, actor: 'agent' },
    { name: 'WAL GmbH', idempotencyKey: 'w' },
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  const { c } = store.db.prepare('SELECT COUNT(*) AS c FROM account').get();
  assert.equal(c, KMU_CORE_SEED.length, 'the workspace is born with the WHOLE chart, never a silently half-seeded one');

  const wal = `${path}-wal`;
  assert.ok(existsSync(wal) && statSync(wal).size > 0, 'the write should have gone through the WAL first');

  store.close();

  // TRUNCATE leaves the file at zero bytes (or removes it): either way, no unbounded growth.
  assert.ok(!existsSync(wal) || statSync(wal).size === 0, 'the WAL must be checkpointed on a clean close');
  assert.ok(statSync(path).size > 0, 'and the pages must have landed in the main database');
});

test('checkpoint is safe to call explicitly, and on an in-memory database', () => {
  const store = new SqliteStore({ location: ':memory:' });
  assert.doesNotThrow(() => store.checkpoint());
  store.close();
  // Closing twice must not throw either: shutdown paths run more than once.
  assert.doesNotThrow(() => store.close());
});

/** A Studio-seat world over a real file: one workspace, real ids (two processes mint rows). */
function studioWorld(name) {
  const path = tempDb();
  const store = new SqliteStore({ location: path, clock: fixedClock('2026-09-25T00:00:00.000Z') });
  const deps = { store, clock: fixedClock('2026-09-25T00:00:00.000Z'), ids: systemIdGen, actor: 'studio' };
  const { workspaceId, accId } = mintWorkspace(deps, name);
  return { path, store, deps, workspaceId, accId };
}

test('D12: a post waits out another process holding the write lock, then commits (critic R2 q1)', async () => {
  const w = studioWorld('Warten Beispiel AG');
  try {
    const holder = await lockHolder(w.path, { holdMs: 300 });
    assert.equal(holder.take(), true, 'premise: the second process holds the write lock');
    const started = performance.now();
    const res = getAction('post_entry').run(w.deps, { workspaceId: w.workspaceId, ...manualPost(w.accId, 'd12-wait', 1500) });
    const waited = performance.now() - started;
    await holder.done;
    assert.equal(res.ok, true, `the post must wait for the lock and land, not fail at once: ${JSON.stringify(res)}`);
    assert.ok(waited >= 150, `it waited for the other process (${Math.round(waited)} ms), so the lock really was held`);
    const { n } = w.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(w.workspaceId);
    assert.equal(n, 1, 'exactly one entry landed');
  } finally {
    w.store.close();
  }
});

test('D12: a Studio posting beside a second process that posts continuously never answers store_busy (critic R2 q2)', async () => {
  const w = studioWorld('Last Beispiel AG');
  const seconds = 2;
  try {
    const url = (rel) => JSON.stringify(new URL(rel, import.meta.url).href);
    // The other TILL: the same build in its own process, posting as fast as it can for `seconds`.
    const other = `
      (async () => {
        const { getAction } = await import(${url('../../dist/api/registry.js')});
        const { SqliteStore } = await import(${url('../../dist/core/store/sqlite-store.js')});
        const { systemIdGen } = await import(${url('../../dist/core/ids.js')});
        const { systemClock } = await import(${url('../../dist/core/clock.js')});
        const store = new SqliteStore({ location: ${JSON.stringify(w.path)} });
        const deps = { store, clock: systemClock, ids: systemIdGen, actor: 'studio' };
        require('node:fs').writeSync(1, 'ready\\n');
        const end = Date.now() + ${seconds * 1000};
        const tally = {};
        for (let i = 0; Date.now() < end; i += 1) {
          const r = getAction('post_entry').run(deps, {
            workspaceId: ${JSON.stringify(w.workspaceId)}, date: '2026-03-01', description: 'Import ' + i, source: 'import',
            idempotencyKey: 'other-' + i,
            lines: [{ account: ${JSON.stringify(w.accId('6500'))}, debit: 100 }, { account: ${JSON.stringify(w.accId('1000'))}, credit: 100 }],
          });
          const k = r.ok ? 'ok' : r.error;
          tally[k] = (tally[k] ?? 0) + 1;
        }
        store.close();
        require('node:fs').writeSync(1, JSON.stringify(tally) + '\\n');
      })();`;
    const child = spawn(process.execPath, ['-e', other], { stdio: ['ignore', 'pipe', 'inherit'] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    assert.equal((await lines.next()).value, 'ready');

    const tally = {};
    const end = Date.now() + seconds * 1000 - 200;
    for (let i = 0; Date.now() < end; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const r = getAction('post_entry').run(w.deps, { workspaceId: w.workspaceId, ...manualPost(w.accId, `studio-${i}`, 50) });
      const k = r.ok ? 'ok' : r.error;
      tally[k] = (tally[k] ?? 0) + 1;
    }
    const otherTally = JSON.parse((await lines.next()).value);

    assert.deepEqual(Object.keys(tally), ['ok'], `every Studio post waited and landed: ${JSON.stringify(tally)}`);
    assert.deepEqual(Object.keys(otherTally), ['ok'], `every post of the other process landed: ${JSON.stringify(otherTally)}`);
    assert.ok(tally.ok > 0 && otherTally.ok > 0, 'premise: both sides really posted');
    const { n } = w.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(w.workspaceId);
    assert.equal(n, tally.ok + otherTally.ok, 'every ok is exactly one entry, on both sides');
  } finally {
    w.store.close();
  }
});

test('D12, the agent seat: a draft waits out the other process, and past the busy timeout answers store_busy on both faces (critic R2-2)', async () => {
  const path = tempDb();
  // The `till mcp` seat (actor agent), on a store that gives up after 150 ms so the timeout is
  // reachable in a test; the first half raises it back to the production default.
  const store = new SqliteStore({ location: path, busyTimeoutMs: 150 });
  const deps = { store, clock: fixedClock('2026-09-25T00:00:00.000Z'), ids: systemIdGen, actor: 'agent' };
  const tool = (name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
  const rows = () =>
    store.db
      .prepare('SELECT (SELECT COUNT(*) FROM agent_action) AS drafts, (SELECT COUNT(*) FROM agent_call) AS calls, (SELECT COUNT(*) FROM journal_entry) AS entries')
      .get();
  try {
    const ws = tool('create_workspace', { name: 'Agentin Beispiel AG', idempotencyKey: 'ws' });
    assert.equal(ws.ok, true, JSON.stringify(ws));
    const accId = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws.workspaceId, n).id;
    const post = (key) => ({ workspaceId: ws.workspaceId, ...manualPost(accId, key, 700) });

    // Within the production timeout: the draft waits for the lock and is queued (critic q1: develop
    // drafted after 383 ms; round 1 threw SQLITE_BUSY in 1 ms).
    store.db.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    let holder = await lockHolder(path, { holdMs: 300 });
    assert.equal(holder.take(), true, 'premise: the other process holds the write lock');
    let before = rows();
    const drafted = tool('post_entry', post('agent-wait'));
    await holder.done;
    assert.equal(drafted.ok, true, `the draft waits and lands: ${JSON.stringify(drafted)}`);
    assert.equal(drafted.drafted, true, 'premise: the default dial drafts an agent post');
    assert.equal(rows().drafts, before.drafts + 1, 'the Vorschlag was queued');
    assert.equal(rows().calls, before.calls + 1, 'and the call was traced');

    // Past the busy timeout: the SAME retryable store_busy a verb answers, as a Result on both faces,
    // never a thrown SQLITE_BUSY (a JSON-RPC internal error on MCP, a bare 500 on REST).
    store.db.pragma('busy_timeout = 150');
    holder = await lockHolder(path, { holdMs: 1500 });
    assert.equal(holder.take(), true);
    before = rows();
    let mcp;
    assert.doesNotThrow(() => {
      mcp = tool('post_entry', post('agent-busy-mcp'));
    }, 'callTool must answer, not throw');
    let rest;
    assert.doesNotThrow(() => {
      rest = handleRest('post_entry', post('agent-busy-rest'), deps);
    }, 'handleRest must answer, not throw');
    await holder.done;
    assert.equal(mcp.ok, false);
    assert.equal(mcp.error, 'store_busy', JSON.stringify(mcp));
    assert.equal(mcp.retryable, true);
    assert.equal(mcp.action, 'post_entry');
    assert.equal(rest.status, 422, 'a named rejection, not a server error');
    assert.equal(rest.body.error, 'store_busy');
    assert.equal(rest.body.retryable, true);
    assert.deepEqual(rows(), before, 'nothing was queued, traced or posted');
  } finally {
    store.close();
  }
});

/**
 * Have the other process take the write lock just BEFORE the one transaction whose body matches
 * `pattern` begins (critic probe q3, moved from the statement to its transaction: under an IMMEDIATE
 * begin the statement is prepared after the lock is already this process's). The body is matched by
 * its source text, which names the table it writes.
 */
function lockBeforeTx(store, holder, pattern) {
  const original = store.tx.bind(store);
  let armed = true;
  let took = false;
  store.tx = (fn) => {
    if (armed && pattern.test(String(fn))) {
      armed = false;
      took = holder.take();
    }
    return original(fn);
  };
  return {
    fired: () => !armed && took,
    restore: () => delete store.tx,
  };
}

/** A rule on contact.created that creates an item, then one create_contact with the lock taken before `pattern`'s tx. */
async function automationUnderLock(label, pattern) {
  const w = studioWorld(`Regel Beispiel AG ${label}`);
  try {
    const rule = getAction('create_automation_rule').run(w.deps, {
      workspaceId: w.workspaceId,
      name: 'Neuer Kunde: Artikel anlegen',
      trigger: { event: 'contact.created' },
      action: { tool: 'create_item', inputTemplate: { name: 'Onboarding {{result.contact.id}}', defaultUnitPriceMinor: 0 } },
      idempotencyKey: 'rule',
    });
    assert.equal(rule.ok, true, JSON.stringify(rule));
    const holder = await lockHolder(w.path, { holdMs: 300 });
    const hook = lockBeforeTx(w.store, holder, pattern);
    const created = getAction('create_contact').run(w.deps, {
      workspaceId: w.workspaceId, partyRole: 'customer', name: 'Kundin AG', idempotencyKey: 'c1',
    });
    hook.restore();
    await holder.done;
    assert.equal(hook.fired(), true, `premise: the other process held the lock as ${label} began`);
    assert.equal(created.ok, true, JSON.stringify(created));
    const runs = w.store.db.prepare('SELECT status, error_code FROM automation_run WHERE workspace_id = ?').all(w.workspaceId);
    assert.deepEqual(runs, [{ status: 'ok', error_code: null }], `${label}: the run was claimed and settled ok, not lost or stuck at running`);
    const items = w.store.db.prepare("SELECT COUNT(*) AS n FROM item WHERE workspace_id = ? AND name LIKE 'Onboarding %'").get(w.workspaceId).n;
    assert.equal(items, 1, `${label}: the rule fired once`);
  } finally {
    w.store.close();
  }
}

// Critic R2-3 (probe q3): round 1 moved this bookkeeping into `tx`, and under contention it failed at
// once and was swallowed into diagnostics: the automation silently never fired, or stayed `running`
// although its action ran, and the agent's trace row was lost. Each now waits for the lock.
test('D12: the automation claim waits for the lock, so the rule fires and its run is recorded (critic R2-3)', async () => {
  await automationUnderLock('the claim', /INSERT INTO automation_run/);
});

test('D12: the automation settle waits for the lock, so the run is not left at running (critic R2-3)', async () => {
  await automationUnderLock('the settle', /UPDATE automation_run\s+SET status/);
});

test('D12: the A35 trace row waits for the lock and is recorded (critic R2-3)', async () => {
  const path = tempDb();
  const store = new SqliteStore({ location: path });
  const deps = { store, clock: fixedClock('2026-09-25T00:00:00.000Z'), ids: systemIdGen, actor: 'agent' };
  const tool = (name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
  try {
    const ws = tool('create_workspace', { name: 'Spur Beispiel AG', idempotencyKey: 'ws' });
    assert.equal(ws.ok, true, JSON.stringify(ws));
    const calls = () => store.db.prepare('SELECT COUNT(*) AS n FROM agent_call').get().n;
    const before = calls();
    const holder = await lockHolder(path, { holdMs: 300 });
    const hook = lockBeforeTx(store, holder, /recordAgentCall/);
    const read = tool('list_accounts', { workspaceId: ws.workspaceId });
    hook.restore();
    await holder.done;
    assert.equal(hook.fired(), true, 'premise: the other process held the lock as the trace write began');
    assert.equal(read.ok, true);
    assert.equal(calls(), before + 1, 'the trace row was recorded after waiting, not dropped into diagnostics');
  } finally {
    store.close();
  }
});

/**
 * accept_invite's three writes (the user's binding, the membership's and the invite's `accepted_at`),
 * as seen from a fresh, unseated local actor. Critic R2 q7 flagged it: as bare autocommits, a lock
 * wait that timed out on the last write left the membership active and the invite pending, and the
 * retry was refused `actor_already_member`, so the invite was never marked accepted.
 */
function inviteWorld(busyTimeoutMs) {
  const w = studioWorld('Einladung Beispiel AG');
  if (busyTimeoutMs !== undefined) w.store.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  const invited = getAction('invite_member').run(w.deps, {
    workspaceId: w.workspaceId, email: 'mueller@treuhand-beispiel.ch', role: 'bookkeeper', idempotencyKey: 'inv',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));
  const accepter = { ...w.deps, actor: 'treuhand:mueller' };
  const accept = () => getAction('accept_invite').run(accepter, { token: invited.token });
  const state = () =>
    w.store.db
      .prepare(
        `SELECT u.actor_id AS boundTo, m.accepted_at AS memberAccepted, i.accepted_at AS inviteAccepted
           FROM invite i JOIN user u ON u.email = i.email
           JOIN workspace_member m ON m.user_id = u.id AND m.workspace_id = i.workspace_id
          WHERE i.token = ?`,
      )
      .get(invited.token);
  return { ...w, accept, state };
}

test('D12: accept_invite runs in ONE transaction: another process can no longer take the lock between its writes', async () => {
  const w = inviteWorld(150);
  try {
    // The other TILL asks for the write lock exactly when accept_invite reaches its LAST write, and
    // would hold it far past this store's 150 ms busy timeout. As bare autocommits it got the lock
    // there, the last UPDATE timed out, and the first two writes stayed committed. In one transaction
    // the verb already holds the lock at that point, so the other process has to wait for its commit.
    const holder = await lockHolder(w.path, { holdMs: 1500 });
    const prepare = w.store.db.prepare;
    let took = null;
    w.store.db.prepare = function (sql) {
      if (took === null && /UPDATE invite SET accepted_at/.test(sql)) took = holder.take(500);
      return prepare.call(this, sql);
    };
    const res = w.accept();
    delete w.store.db.prepare;
    await holder.done;
    assert.equal(took, false, 'the other process could not take the lock between the writes');
    assert.equal(res.ok, true, JSON.stringify(res));
    const s = w.state();
    assert.equal(s.boundTo, 'treuhand:mueller');
    assert.notEqual(s.memberAccepted, null);
    assert.notEqual(s.inviteAccepted, null, 'the invite is marked accepted with the membership');
  } finally {
    w.store.close();
  }
});

test('D12: a lock wait that times out on accept_invite\'s last write leaves no partial membership, and the retry completes', () => {
  const w = inviteWorld();
  try {
    // What the driver throws when a lock wait runs out on that statement (critic q7 injects the same):
    // SQLITE_BUSY from the invite's UPDATE, after the user's binding and the membership were written.
    const prepare = w.store.db.prepare;
    let armed = true;
    w.store.db.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (armed && /UPDATE invite SET accepted_at/.test(sql)) {
        armed = false;
        return {
          run: () => {
            throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
          },
        };
      }
      return statement;
    };
    const first = w.accept();
    delete w.store.db.prepare;
    assert.equal(armed, false, 'premise: the busy failure hit the last write');
    assert.equal(first.ok, false);
    assert.equal(first.error, 'store_busy', JSON.stringify(first));
    assert.equal(first.retryable, true);
    assert.deepEqual(
      { ...w.state() },
      { boundTo: null, memberAccepted: null, inviteAccepted: null },
      'nothing of the accept stayed: no bound user, no active membership without its accepted invite',
    );

    const retry = w.accept();
    assert.equal(retry.ok, true, `the retry the banner asks for completes: ${JSON.stringify(retry)}`);
    const s = w.state();
    assert.equal(s.boundTo, 'treuhand:mueller');
    assert.notEqual(s.memberAccepted, null, 'the membership is active');
    assert.notEqual(s.inviteAccepted, null, 'and the invite is marked accepted');
  } finally {
    w.store.close();
  }
});
