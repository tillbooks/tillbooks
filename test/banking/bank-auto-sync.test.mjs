// D142, THE DAILY AUTOMATIC FETCH (A36 §12): the `till up` scheduler's second branch fetches each active
// EBICS connection once a Swiss day at its time (default 07:00), catches up at start, retries a bank that
// did not answer or was busy hourly up to three attempts, never retries a state a person must clear, and
// fires `bank_sync` through the registry as a live-checked seated actor (critic F1: the schedule's setter,
// else the owner seat; it stays on the G01 denylist). Every attempt is one
// appended row of `bank_auto_sync_run`.
//
// The clock is a mutable instant the suite moves; the bank is the synthetic in-process bank of
// `ebics-support.mjs`. All fixtures synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { syntheticIban, chain, container, mockBank, bankCode } from './ebics-support.mjs';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { makeContext } from '../../dist/core/context.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';
import { autoSyncNoActorReason, autoSyncSetterKind, connectBankChannel, defaultEbicsKeystore, isRetryableAutoOutcome, zurichInstant, zurichParts } from '../../dist/core/banking/ebics/index.js';
import { getAction } from '../../dist/api/registry.js';
import { createScheduler } from '../../dist/api/scheduler.js';
import { NOT_AUTOMATABLE } from '../../dist/core/automation/denylist.js';
import { seatFirstOwner, isProvisioned } from '../../dist/core/access/index.js';

const HOST = { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHAUT', partnerId: 'PARTNER88', userId: 'USER0088' };
// 05.10.2026 is a Monday in summer time: 07:00 in Zurich is 05:00 UTC.
const DAY = '2026-10-05';
const at = (hhmm, day = DAY) => zurichInstant(day, hhmm);

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

let n = 0;
function world({ keystore } = {}) {
  n += 1;
  const clock = { current: '2026-10-01T08:00:00.000Z', now() { return this.current; } };
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const base = { store, clock, ids };
  const workspaceId = must(createWorkspace(base, { name: 'Synthetische Auto GmbH' }), 'workspace').workspaceId;
  const bank = mockBank();
  const deps = { ...base, actor: 'studio', ebicsTransport: bank.port, ...(keystore !== undefined ? { ebicsKeystore: keystore } : {}) };
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ebicsTransport: bank.port });
  const ledger = store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1020'").get(workspaceId).id;
  const iban = syntheticIban(5000 + n);
  const accountId = must(createBankAccount(ctx, { name: 'Konto Auto', iban, ledgerAccountId: ledger, idempotencyKey: `ba-${n}` }), 'account').bankAccountId;
  const statements = chain({ iban, firstSeq: 1, firstDate: '2026-10-01', opening: 10000, days: [[{ minor: 500 }], [{ minor: -200 }], [{ minor: 900 }]] });
  must(importCamt(ctx, { bankAccountId: accountId, xml: statements[0].xml, idempotencyKey: `bridge-${n}` }), 'bridge');
  const c = must(connectBankChannel(ctx, { host: { ...HOST, partnerId: `PARTNER${80 + n}` }, routeBankAccountIds: [accountId], confirm: true, idempotencyKey: `c-${n}` }), 'connect');
  const fetched = must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true }), 'fetch');
  must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'confirm');
  const scheduler = createScheduler(deps, { listWorkspaceIds: () => [workspaceId], runDue: () => {}, now: () => new Date(clock.current) });
  return {
    clock,
    store,
    deps,
    bank,
    workspaceId,
    accountId,
    statements,
    connectionId: c.connectionId,
    scheduler,
    tickAt: async (instant) => {
      clock.current = instant;
      return scheduler.bankTickOnce();
    },
    runs: () => store.db.prepare('SELECT local_date, attempt, idempotency_key, outcome_ok, outcome_code, retryable FROM bank_auto_sync_run WHERE workspace_id = ? ORDER BY rowid').all(workspaceId),
    status: () => must(getAction('bank_channel_status').run(deps, { workspaceId }), 'status').channels[0],
    btd: () => bank.log.filter((l) => l.kind === 'BTD').length,
  };
}

test('Swiss time: 07:00 is 05:00 UTC in summer and 06:00 UTC in winter; the day is the Swiss day', () => {
  assert.equal(zurichInstant('2026-10-24', '07:00'), '2026-10-24T05:00:00.000Z');
  assert.equal(zurichInstant('2026-10-26', '07:00'), '2026-10-26T06:00:00.000Z');
  assert.deepEqual(zurichParts('2026-10-04T22:30:00.000Z'), { date: '2026-10-05', time: '00:30' });
});

test('bank_sync stays on the G01 denylist: the daily fetch is a scheduler branch, not a rule', () => {
  assert.equal(NOT_AUTOMATABLE.has('bank_sync'), true);
});

test('before 07:00 nothing runs; at 07:02 the first attempt fetches once, keyed a36-auto-<conn>-<day>-1', async () => {
  const w = world();
  w.bank.offer(container([w.statements[1].xml]));
  assert.deepEqual(await w.tickAt(at('06:59')), []);
  assert.equal(w.btd(), 0, 'nothing reached the bank before the time');
  assert.equal(w.status().autoSync.nextAt, at('07:00'), 'the status names today 07:00');
  const reports = await w.tickAt(at('07:02'));
  assert.equal(reports.length, 1);
  assert.deepEqual(
    { ok: reports[0].ok, code: reports[0].code, attempt: reports[0].attempt, key: reports[0].idempotencyKey },
    { ok: true, code: 'downloaded', attempt: 1, key: `a36-auto-${w.connectionId}-${DAY}-1` },
  );
  assert.equal(w.store.db.prepare('SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ?').get(w.workspaceId).n, 2, 'the statement landed');
  assert.deepEqual(await w.tickAt(at('07:30')), [], 'a later tick the same day does nothing');
  assert.deepEqual(await w.tickAt(at('23:59')), []);
  assert.equal(w.btd(), 1, 'one fetch that day');
  const s = w.status();
  assert.equal(s.autoSync.mode, 'daily');
  assert.equal(s.autoSync.explicit, false, 'the owner default, never set');
  assert.equal(s.autoSync.lastAuto.code, 'downloaded');
  assert.equal(s.autoSync.lastAuto.ok, true);
  assert.equal(s.autoSync.nextAt, at('07:00', '2026-10-06'), 'next run: tomorrow 07:00');
  assert.equal(w.runs().length, 1, 'one appended attempt row');
});

test('catch-up: TILL closed at 07:00 fetches at the first tick after it starts', async () => {
  const w = world();
  const reports = await w.tickAt(at('15:40'));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].code, 'no_data', 'the bank had nothing new: still a completed fetch');
  assert.deepEqual(await w.tickAt(at('16:41')), [], 'a completed fetch ends the day');
});

test('start() runs the catch-up at once, without waiting a tick', async () => {
  const w = world();
  w.clock.current = at('10:00');
  w.scheduler.start();
  try {
    for (let i = 0; i < 50 && w.runs().length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(w.runs().length, 1, 'the catch-up attempt ran at start');
  } finally {
    w.scheduler.stop();
  }
});

test('a fetch the owner pressed after 07:00 counts for the day; one pressed at 05:00 does not', async () => {
  const w = world();
  const press = (key) => getAction('bank_sync').run(w.deps, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: key });
  w.clock.current = at('05:00');
  must(press('early'), 'early press');
  assert.equal((await w.tickAt(at('07:01'))).length, 1, 'the 05:00 press did not count');
  const w2 = world();
  w2.clock.current = at('07:30');
  must(getAction('bank_sync').run(w2.deps, { workspaceId: w2.workspaceId, connectionId: w2.connectionId, idempotencyKey: 'late' }), 'late press');
  assert.deepEqual(await w2.tickAt(at('08:00')), [], 'the 07:30 press counted');
});

test('a bank that does not answer is retried hourly, three attempts a day, then tomorrow', async () => {
  const w = world();
  const unreachable = { ok: false, reason: 'network', detail: 'synthetic: the host did not answer' };
  for (let i = 0; i < 3; i += 1) w.bank.nextDownload(unreachable);
  const first = await w.tickAt(at('07:02'));
  assert.deepEqual([first[0].ok, first[0].code, first[0].retryable], [false, 'channel_unreachable', true]);
  assert.deepEqual(await w.tickAt(at('07:40')), [], 'not before an hour has passed');
  assert.equal(w.status().autoSync.nextAt, new Date(Date.parse(at('07:02')) + 3_600_000).toISOString());
  assert.equal((await w.tickAt(at('08:03')))[0].attempt, 2);
  assert.equal((await w.tickAt(at('09:04')))[0].attempt, 3);
  assert.deepEqual(await w.tickAt(at('10:05')), [], 'three attempts, then no more today');
  assert.equal(w.status().autoSync.nextAt, at('07:00', '2026-10-06'));
  assert.deepEqual(w.runs().map((r) => r.idempotency_key), [1, 2, 3].map((k) => `a36-auto-${w.connectionId}-${DAY}-${k}`));
  const next = await w.tickAt(at('07:01', '2026-10-06'));
  assert.deepEqual([next[0].ok, next[0].attempt], [true, 1], 'a new day starts at attempt 1');
});

test('a busy bank is retried; a refusal a person must clear is not', async () => {
  const w = world();
  w.bank.nextDownload(bankCode('091119'));
  const busy = await w.tickAt(at('07:02'));
  assert.deepEqual([busy[0].code, busy[0].retryable], ['download_refused', true]);
  w.bank.nextDownload(bankCode('090003'));
  const denied = await w.tickAt(at('08:05'));
  assert.deepEqual([denied[0].code, denied[0].retryable], ['download_refused', false]);
  assert.deepEqual(await w.tickAt(at('09:10')), [], 'a not-granted download waits for a person');
  assert.equal(w.btd(), 2);
});

test('critic F3: a locked keystore is never retried automatically, persistent or not (D142)', async () => {
  // The worker rebuilds its keystore from the boot recipe, so a store locked at boot is locked in every
  // attempt: a retry cannot succeed, and D142 lists a locked keystore among the states a person clears.
  const locked = (persistent) => ({ ...defaultEbicsKeystore, persistent, kind: persistent ? 'file' : 'memory', state: () => 'locked' });
  for (const persistent of [false, true]) {
    const w = world({ keystore: locked(persistent) });
    const a = await w.tickAt(at('07:02'));
    assert.deepEqual([a[0].code, a[0].retryable], ['keystore_locked', false], `persistent=${persistent}`);
    assert.deepEqual(await w.tickAt(at('08:05')), [], `persistent=${persistent}: no second attempt that day`);
  }
  assert.equal(isRetryableAutoOutcome({ ok: false, error: 'keystore_locked' }), false);
});

test('set_bank_sync_schedule: off stops the fetch, a time moves it, a ruleId is still refused', async () => {
  const w = world();
  const schedule = (input, key) => getAction('set_bank_sync_schedule').run(w.deps, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: key, ...input });
  assert.equal(schedule({ ruleId: 'rule_x' }, 's0').error, 'sync_schedule_parked');
  assert.equal(schedule({ mode: 'weekly' }, 's1').error, 'invalid_input');
  assert.equal(schedule({ atTime: '7:00' }, 's2').error, 'invalid_input');
  const off = must(schedule({ mode: 'off' }, 's3'), 'off');
  assert.deepEqual(off.autoSync, { mode: 'off', atTime: '07:00', explicit: true });
  assert.deepEqual(await w.tickAt(at('09:00')), [], 'off: nothing runs');
  assert.equal(w.status().autoSync.nextAt, null);
  const moved = must(schedule({ mode: 'daily', atTime: '09:15' }, 's4'), 'daily 09:15');
  assert.deepEqual(moved.autoSync, { mode: 'daily', atTime: '09:15', explicit: true });
  assert.deepEqual(await w.tickAt(at('09:10')), [], 'before the new time');
  assert.equal((await w.tickAt(at('09:16'))).length, 1);
  // The time alone keeps the mode.
  must(schedule({ atTime: '06:30' }, 's5'), 'time only');
  assert.equal(w.status().autoSync.mode, 'daily');
  assert.equal(w.status().autoSync.atTime, '06:30');
});

test('a fetch someone else is running is not an attempt: the next tick decides again', async () => {
  const w = world();
  w.store.db.prepare('UPDATE ebics_connection SET sync_started_at = ? WHERE id = ?').run(at('07:00'), w.connectionId);
  const reports = await w.tickAt(at('07:02'));
  assert.deepEqual(reports, [{ workspaceId: w.workspaceId, connectionId: w.connectionId, skipped: 'sync_in_progress' }]);
  assert.equal(w.runs().length, 0, 'no attempt row');
  w.store.db.prepare('UPDATE ebics_connection SET sync_started_at = NULL WHERE id = ?').run(w.connectionId);
  assert.equal((await w.tickAt(at('07:03')))[0].attempt, 1);
});

test('no wire in this process: the attempt is recorded as not fetched and is not repeated that day', async () => {
  const w = world();
  delete w.deps.ebicsTransport;
  const reports = await w.tickAt(at('07:05'));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].code, 'needs_bank_transport');
  assert.equal(reports[0].retryable, false);
  const row = w.runs()[0];
  assert.deepEqual([row.outcome_ok, row.outcome_code], [0, 'needs_bank_transport']);
  assert.equal(w.status().autoSync.lastAuto.ok, false);
  assert.deepEqual(await w.tickAt(at('09:10')), [], 'a person has to wire the bank first');
});

// --- Critic F1 (HIGH): the automatic fetch on a PROVISIONED book runs as a real seated actor ----------------

/** Provision the book the way onboard_client or a first invite does: `actor` and the D13 seats become owners. */
function provision(w, actor = 'user_1') {
  must({ ok: seatFirstOwner(makeContext(w.store, { workspaceId: w.workspaceId, actor, clock: w.clock, ids: w.deps.ids })) !== undefined }, 'seat');
  assert.equal(isProvisioned(w.store, w.workspaceId), true);
}

/** Set a member's role straight on the row (the suite needs a demotion the last-owner rail would refuse). */
function demote(w, actor, role = 'viewer') {
  w.store.db
    .prepare('UPDATE workspace_member SET role = ? WHERE workspace_id = ? AND user_id = (SELECT id FROM user WHERE actor_id = ?)')
    .run(role, w.workspaceId, actor);
}

const runAs = (w) => w.store.db.prepare('SELECT run_as FROM bank_auto_sync_run WHERE workspace_id = ? ORDER BY rowid').all(w.workspaceId).map((r) => r.run_as);

test('F1: on a provisioned book the automatic fetch runs as the seated owner, not as a refused `system`', async () => {
  const w = world();
  provision(w);
  w.bank.offer(container([w.statements[1].xml]));
  const reports = await w.tickAt(at('07:02'));
  assert.equal(reports.length, 1);
  assert.deepEqual([reports[0].ok, reports[0].code], [true, 'downloaded'], JSON.stringify(reports));
  assert.deepEqual(runAs(w), ['studio'], 'a connection that never set its schedule runs as the owner seat');
});

test('F1: the actor who set the schedule is who the fetch runs as, checked live; a lost right falls back to the owner seat', async () => {
  const w = world();
  provision(w, 'bookkeeper');
  const set = (actor, key, input) => getAction('set_bank_sync_schedule').run({ ...w.deps, actor }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: key, ...input });
  must(set('bookkeeper', 'set-1', { mode: 'daily', atTime: '07:00' }), 'bookkeeper sets the schedule');
  assert.equal(w.status().autoSync.runsAs, 'bookkeeper');
  assert.deepEqual((await w.tickAt(at('07:02')))[0].ok, true);
  demote(w, 'bookkeeper');
  assert.deepEqual((await w.tickAt(at('07:02', '2026-10-06')))[0].ok, true, 'the bookkeeper lost `pay`: the owner seat runs it');
  assert.deepEqual(runAs(w), ['bookkeeper', 'studio']);
});

test('F1: with no seated actor holding `pay` the attempt is a human-needed outcome in words, never retried that day', async () => {
  const w = world();
  provision(w, 'bookkeeper');
  demote(w, 'bookkeeper');
  demote(w, 'studio');
  // The agent seat is an owner too, but a governed seat never runs an unattended fetch.
  const reports = await w.tickAt(at('07:02'));
  assert.deepEqual([reports[0].ok, reports[0].code, reports[0].retryable], [false, 'auto_sync_no_actor', false]);
  assert.equal(w.btd(), 0, 'nothing reached the bank');
  assert.equal(w.status().autoSync.lastAuto.code, 'auto_sync_no_actor');
  assert.deepEqual(await w.tickAt(at('09:10')), [], 'a person has to restore the right first');
});

test('critic R3-2: auto_sync_no_actor is worded for a schedule nobody set apart from one a person set', async () => {
  // Never set: no setter was tried, only the owner seat, and the reason names only it.
  const unset = world();
  provision(unset, 'bookkeeper');
  demote(unset, 'studio');
  assert.equal((await unset.tickAt(at('07:02')))[0].code, 'auto_sync_no_actor');
  assert.equal(unset.status().autoSync.setterKnown, false, 'nobody set the schedule');
  const neverSet = autoSyncNoActorReason('none');
  assert.match(neverSet, /^nobody has set the schedule/);
  assert.doesNotMatch(neverSet, /actor who set the schedule/, 'no setter is named where there is none');
  assert.match(neverSet, /owner seat \(studio\)/);

  // Set by a person who then lost the right: both were tried, and the reason names both.
  const set = world();
  provision(set, 'bookkeeper');
  must(getAction('set_bank_sync_schedule').run({ ...set.deps, actor: 'bookkeeper' }, { workspaceId: set.workspaceId, connectionId: set.connectionId, idempotencyKey: 'r32-set', mode: 'daily' }), 'schedule');
  demote(set, 'bookkeeper');
  demote(set, 'studio');
  assert.equal((await set.tickAt(at('07:02')))[0].code, 'auto_sync_no_actor');
  assert.equal(set.status().autoSync.setterKnown, true, 'the bookkeeper set it');
  assert.match(autoSyncNoActorReason('person'), /^neither the actor who set the schedule nor the owner seat \(studio\)/);
  const setCtx = makeContext(set.store, { workspaceId: set.workspaceId, actor: 'system', clock: set.clock, ids: set.deps.ids });
  assert.equal(autoSyncSetterKind(setCtx, { auto_sync_actor: '' }), 'none', 'an empty setter is no setter');
  assert.equal(set.status().autoSync.scheduleSetter, 'person');
  assert.deepEqual(set.status().autoSync.lastAuto.detail?.tried, ['bookkeeper', 'studio'], 'both were tried');
  assert.equal(unset.status().autoSync.scheduleSetter, 'none');
  assert.deepEqual(unset.status().autoSync.lastAuto.detail?.tried, ['studio'], 'only the owner seat was tried');
});

test('critic LB-1: a schedule an agent set is worded by who was tried: the owner seat alone, never "the person who set it"', async () => {
  const w = world();
  provision(w);
  must(getAction('set_bank_sync_schedule').run({ ...w.deps, actor: 'agent' }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'lb1-agent', mode: 'daily' }), 'agent sets');
  demote(w, 'studio');
  const reports = await w.tickAt(at('07:02'));
  assert.equal(reports[0].code, 'auto_sync_no_actor');
  const auto = w.status().autoSync;
  assert.equal(auto.scheduleSetter, 'agent', 'an agent set it');
  assert.equal(auto.setterKnown, false, 'an agent setter is never tried, so it is no setter the fetch knows');
  assert.deepEqual(auto.lastAuto.detail?.tried, ['studio'], 'the agent was skipped by design; only the owner seat was tried');
  const reason = autoSyncNoActorReason('agent');
  assert.match(reason, /an agent set the schedule/);
  assert.match(reason, /runs as the owner seat \(studio\), which does not hold pay/);
  assert.doesNotMatch(reason, /neither the actor who set the schedule/, 'no two-party sentence for one tried actor');

  // The owner seat as the setter is a single party too (critic LB-1, related LOW).
  const owner = world();
  provision(owner);
  must(getAction('set_bank_sync_schedule').run({ ...owner.deps, actor: 'studio' }, { workspaceId: owner.workspaceId, connectionId: owner.connectionId, idempotencyKey: 'lb1-owner', mode: 'daily' }), 'owner sets');
  demote(owner, 'studio');
  assert.equal((await owner.tickAt(at('07:02')))[0].code, 'auto_sync_no_actor');
  assert.equal(owner.status().autoSync.scheduleSetter, 'owner');
  assert.equal(owner.status().autoSync.setterKnown, false);
  assert.deepEqual(owner.status().autoSync.lastAuto.detail?.tried, ['studio']);
  assert.doesNotMatch(autoSyncNoActorReason('owner'), /neither|nobody/);
  assert.match(autoSyncNoActorReason('owner'), /owner seat \(studio\)/);
});

test('F1: a governed seat that set the schedule never runs the unattended fetch; the owner seat does', async () => {
  const w = world();
  provision(w);
  must(getAction('set_bank_sync_schedule').run({ ...w.deps, actor: 'agent' }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'ag-1', mode: 'daily' }), 'agent row');
  assert.equal(w.status().autoSync.runsAs, 'studio');
  assert.equal((await w.tickAt(at('07:02')))[0].ok, true);
  assert.deepEqual(runAs(w), ['studio']);
});

test('F2: a worker that failed and a busy book are retried; neither is a state a person must clear', () => {
  assert.equal(isRetryableAutoOutcome({ ok: false, error: 'sync_worker_failed', stage: 'timeout', retryable: true }), true);
  assert.equal(isRetryableAutoOutcome({ ok: false, error: 'sync_worker_failed', stage: 'exit' }), true);
  assert.equal(isRetryableAutoOutcome({ ok: false, error: 'store_busy', retryable: true, partial: false }), true);
  assert.equal(isRetryableAutoOutcome({ ok: false, error: 'pending_bank_activation' }), false);
  assert.equal(isRetryableAutoOutcome({ ok: false, error: 'bank_keys_changed' }), false);
});

// --- A36 §4.7 (D150): the bank's own reason is kept on the attempt row -------------------------------

test('D150: a refused download keeps the bank code on the attempt; the retry rules are unchanged', async () => {
  const w = world();
  const detail = () => w.store.db.prepare('SELECT detail FROM bank_auto_sync_run WHERE workspace_id = ? ORDER BY rowid').all(w.workspaceId).map((r) => JSON.parse(r.detail));
  w.bank.nextDownload(bankCode('091119'));
  const busy = await w.tickAt(at('07:02'));
  assert.deepEqual([busy[0].code, busy[0].retryable], ['download_refused', true], 'busy is still retried');
  w.bank.nextDownload(bankCode('090003'));
  const denied = await w.tickAt(at('08:05'));
  assert.deepEqual([denied[0].code, denied[0].retryable], ['download_refused', false], 'not granted still waits for a person');
  assert.deepEqual(await w.tickAt(at('09:10')), [], 'and is not retried that day');
  assert.deepEqual(detail().map((d) => [d.kind, d.code]), [['busy', '091119'], ['not_granted', '090003']]);
  // The status (and so the band) reads the code off the last attempt.
  assert.equal(w.status().autoSync.lastAuto.detail.code, '090003');
});

test('D150: a bank that did not answer keeps the wire reason; three attempts a day, then the next day starts at 1', async () => {
  const w = world();
  for (let i = 0; i < 3; i += 1) w.bank.nextDownload({ ok: false, reason: 'network', detail: 'synthetic: the host did not answer' });
  assert.equal((await w.tickAt(at('07:02')))[0].attempt, 1);
  assert.equal((await w.tickAt(at('08:03')))[0].attempt, 2);
  assert.equal((await w.tickAt(at('09:04')))[0].attempt, 3);
  assert.deepEqual(await w.tickAt(at('10:05')), [], 'exhausted for the day');
  const stored = w.store.db.prepare('SELECT detail FROM bank_auto_sync_run WHERE workspace_id = ? ORDER BY rowid').all(w.workspaceId).map((r) => JSON.parse(r.detail));
  assert.deepEqual(stored.map((d) => d.bankReason), ['network', 'network', 'network']);
  // The start tick of the next day is the catch-up, as before.
  const next = await w.tickAt(at('11:30', '2026-10-06'));
  assert.deepEqual([next[0].ok, next[0].attempt], [true, 1]);
});
