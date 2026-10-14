// D143, THE DAILY ACTIVATION CHECK (A36 §12.1): while an activation is in progress (`ini_sent`,
// `pending_bank_activation`) the `till up` scheduler asks the bank for its keys once a Swiss day (HPB
// only), retries a transient failure hourly at most twice, and records whether the bank is ready for the
// human key review. It never pins, never activates, never resends a leg, runs as a live-checked seated
// actor, and every query is fenced to its workspace. `attention_summary` surfaces a ready bank.
//
// The clock is a mutable instant the suite moves; the bank is the synthetic in-process bank of
// `ebics-support.mjs`. All fixtures synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { syntheticIban, mockBank, bankCode } from './ebics-support.mjs';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { makeContext } from '../../dist/core/context.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createBankAccount } from '../../dist/core/banking/index.js';
import {
  bankShortName,
  checkBankActivation,
  connectBankChannel,
  defaultEbicsKeystore,
  disconnectBankChannel,
  recordUnknownActivationAttempt,
  zurichInstant,
} from '../../dist/core/banking/ebics/index.js';
import { getAction } from '../../dist/api/registry.js';
import { createScheduler } from '../../dist/api/scheduler.js';
import { NOT_AUTOMATABLE } from '../../dist/core/automation/denylist.js';
import { seatFirstOwner, isProvisioned } from '../../dist/core/access/index.js';

// 05.10.2026 is a Monday in summer time: 07:00 in Zurich is 05:00 UTC.
const DAY = '2026-10-05';
const NEXT = '2026-10-06';
const at = (hhmm, day = DAY) => zurichInstant(day, hhmm);

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

let n = 0;

/**
 * One book with one EBICS connection brought to `state`: `pending_bank_activation` (both legs confirmed),
 * `ini_sent` (the HIA answer was lost), `active` (fetched and confirmed), `retired`, `blocked`, or a
 * pending one whose automatic mode is `off`.
 */
function world(state = 'pending_bank_activation', { store: shared, keystore } = {}) {
  n += 1;
  const clock = shared?.clock ?? { current: '2026-10-01T08:00:00.000Z', now() { return this.current; } };
  const ids = shared?.ids ?? sequenceIdGen();
  const store = shared?.store ?? new SqliteStore({ clock });
  const base = { store, clock, ids };
  const workspaceId = must(createWorkspace(base, { name: `Synthetische Freischaltung ${n} GmbH` }), 'workspace').workspaceId;
  const bank = mockBank();
  const deps = { ...base, actor: 'studio', ebicsTransport: bank.port, ...(keystore !== undefined ? { ebicsKeystore: keystore } : {}) };
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ebicsTransport: bank.port });
  const ledger = store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1020'").get(workspaceId).id;
  const accountId = must(createBankAccount(ctx, { name: 'Konto Freischaltung', iban: syntheticIban(7000 + n), ledgerAccountId: ledger, idempotencyKey: `ba-${n}` }), 'account').bankAccountId;
  if (state === 'ini_sent') bank.nextLeg('HIA', { ok: false, reason: 'network', detail: 'synthetic: the HIA answer was lost' });
  const host = { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHACT', partnerId: `PARTNER${100 + n}`, userId: `USER${1000 + n}` };
  const connected = connectBankChannel(ctx, { host, routeBankAccountIds: [accountId], confirm: true, idempotencyKey: `c-${n}` });
  const connectionId = connected.connectionId;
  assert.ok(typeof connectionId === 'string', JSON.stringify(connected));
  if (state === 'active') {
    const fetched = must(connectBankChannel(ctx, { connectionId, confirm: true }), 'fetch');
    must(connectBankChannel(ctx, { connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'confirm');
  }
  if (state === 'retired' || state === 'blocked') {
    must(disconnectBankChannel(ctx, { connectionId, mode: state === 'retired' ? 'retire' : 'block', confirm: true, idempotencyKey: `d-${n}` }), state);
  }
  if (state === 'off') {
    must(getAction('set_bank_sync_schedule').run(deps, { workspaceId, connectionId, mode: 'off', idempotencyKey: `off-${n}` }), 'off');
  }
  const expected = state === 'off' ? 'pending_bank_activation' : state;
  const row = () => store.db.prepare('SELECT state, bank_key_hashes, activated_at FROM ebics_connection WHERE workspace_id = ? AND id = ?').get(workspaceId, connectionId);
  assert.equal(row().state, expected, 'the world is in the state asked for');
  const scheduler = createScheduler(deps, { listWorkspaceIds: () => [workspaceId], runDue: () => {}, now: () => new Date(clock.current) });
  const checks = (kind) => bank.log.filter((l) => l.kind === kind).length;
  return {
    clock,
    store,
    ids,
    deps,
    bank,
    ctx,
    workspaceId,
    connectionId,
    scheduler,
    row,
    hpbs: () => checks('HPB'),
    legs: () => checks('INI') + checks('HIA'),
    tickAt: async (instant) => {
      clock.current = instant;
      return (await scheduler.bankTickOnce()).filter((r) => r.activationCheck !== undefined).map((r) => r.activationCheck);
    },
    rows: () =>
      store.db
        .prepare("SELECT local_date, attempt, outcome_code, retryable, run_as, bank_code FROM ebics_activation_check WHERE workspace_id = ? AND connection_id = ? AND outcome_code != 'started' ORDER BY rowid")
        .all(workspaceId, connectionId),
    status: () => must(getAction('bank_channel_status').run(deps, { workspaceId }), 'status').channels.find((c) => c.connectionId === connectionId),
    attention: () => must(getAction('attention_summary').run(deps, { workspaceId }), 'attention'),
  };
}

const notYet = () => bankCode('091002', 'technical');

// --- who is checked ----------------------------------------------------------------------------------

test('only pending_bank_activation and ini_sent are probed; active, retired, blocked and off are not', async () => {
  for (const state of ['pending_bank_activation', 'ini_sent']) {
    const w = world(state);
    w.bank.nextHpb(notYet());
    const before = w.hpbs();
    const reports = await w.tickAt(at('07:02'));
    assert.equal(reports.length, 1, `${state}: one check`);
    assert.equal(w.hpbs() - before, 1, `${state}: one HPB reached the bank`);
    assert.equal(w.status().activation.checking, true, `${state}: checking`);
  }
  for (const state of ['active', 'retired', 'blocked', 'off']) {
    const w = world(state);
    // The latest HPB failed (a rotation check that did not get through, as `compareBankKeys` logs one),
    // so "the bank is ready" cannot be what keeps these connections unprobed: the state gate must.
    w.store.db
      .prepare(
        `INSERT INTO ebics_order_log (id, workspace_id, connection_id, order_ref, direction, order_type, status, bank_reason, occurred_at)
         VALUES (?, ?, ?, 'HPB', 'download', 'HPB', 'failed', 'network', ?)`,
      )
      .run(`ebord_fail_${state}`, w.workspaceId, w.connectionId, at('06:00'));
    const before = w.hpbs();
    assert.deepEqual(await w.tickAt(at('07:02')), [], `${state}: no check`);
    assert.deepEqual(await w.tickAt(at('15:00')), [], `${state}: no check later either`);
    assert.equal(w.hpbs() - before, 0, `${state}: no HPB reached the bank`);
    assert.equal(w.rows().length, 0, `${state}: no check row`);
    const activation = w.status().activation;
    assert.equal(activation.checking, false, `${state}: not checking`);
    assert.equal(activation.nextCheckAt, null, `${state}: no next check`);
  }
});

test('nothing before the connection time; the first tick after it is the check (the catch-up included)', async () => {
  const w = world();
  w.bank.nextHpb(notYet());
  assert.deepEqual(await w.tickAt(at('06:59')), []);
  assert.equal(w.hpbs(), 0);
  assert.equal(w.status().activation.nextCheckAt, at('07:00'), 'the status names today 07:00');
  const late = await w.tickAt(at('15:40'));
  assert.equal(late.length, 1, 'TILL closed at 07:00 checks at the first tick after');
});

// --- what a check does, and never does -----------------------------------------------------------------

test('the bank not activated yet: the check time is recorded and the next check is tomorrow', async () => {
  const w = world();
  w.bank.nextHpb(notYet());
  const [r] = await w.tickAt(at('07:02'));
  assert.deepEqual([r.outcome, r.retryable, r.bankCode, r.attempt], ['not_activated', false, '091002', 1]);
  const s = w.status();
  assert.equal(s.activation.bankReady, false);
  assert.equal(s.activation.lastOutcome, 'not_activated');
  assert.equal(s.activation.lastCheckAt, at('07:02'));
  assert.equal(s.activation.nextCheckAt, at('07:00', NEXT));
  assert.equal(s.state, 'pending_bank_activation');
});

test('HPB 000000: the bank is ready for review, and still nothing is pinned or activated', async () => {
  const w = world();
  const [r] = await w.tickAt(at('07:02'));
  assert.deepEqual([r.outcome, r.retryable], ['bank_ready', false]);
  const row = w.row();
  assert.equal(row.state, 'pending_bank_activation', 'never active');
  assert.equal(row.bank_key_hashes, null, 'no pin');
  assert.equal(row.activated_at, null);
  const s = w.status();
  assert.deepEqual(
    { bankReady: s.activation.bankReady, checking: s.activation.checking, next: s.activation.nextCheckAt },
    { bankReady: true, checking: false, next: null },
  );
  const hpbRow = w.store.db.prepare("SELECT status, related_kind FROM ebics_order_log WHERE workspace_id = ? AND connection_id = ? AND order_type = 'HPB'").get(w.workspaceId, w.connectionId);
  assert.deepEqual(hpbRow, { status: 'ok', related_kind: 'activation_check' }, 'the HPB is in the order log, marked as the probe');
  // The band reads the same facts off the bank_inbox tile, per channel.
  const band = must(getAction('dashboard_tile').run(w.deps, { workspaceId: w.workspaceId, tile: 'bank_inbox', from: DAY, to: DAY }), 'tile').tile;
  const bandChannel = band.channels.find((c) => c.connectionId === w.connectionId);
  assert.equal(bandChannel.bankName, 'SYNTHACT');
  assert.equal(bandChannel.activation.bankReady, true);
  assert.deepEqual(await w.tickAt(at('07:02', NEXT)), [], 'a ready bank is not probed again: the next move is the person');
  assert.equal(w.hpbs(), 1);
  // The human compare still works exactly as before, and it is the only way into active.
  const fetched = must(connectBankChannel(w.ctx, { connectionId: w.connectionId, confirm: true }), 'human fetch');
  must(connectBankChannel(w.ctx, { connectionId: w.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'human confirm');
  assert.equal(w.row().state, 'active');
  assert.equal(w.status().activation.bankReady, false, 'active is not an activation in progress');
});

test('from ini_sent: HPB 000000 moves only to pending_bank_activation, and no leg is resent', async () => {
  const w = world('ini_sent');
  const legsBefore = w.legs();
  const [r] = await w.tickAt(at('07:02'));
  assert.equal(r.outcome, 'bank_ready');
  assert.equal(w.legs(), legsBefore, 'no INI or HIA went out');
  assert.equal(w.row().state, 'pending_bank_activation');
  assert.equal(w.row().bank_key_hashes, null);
  assert.equal(w.status().activation.bankReady, true);
});

test('a probe never resends a leg, whatever the bank answers', async () => {
  const w = world('ini_sent');
  const legsBefore = w.legs();
  for (let i = 0; i < 3; i += 1) w.bank.nextHpb({ ok: false, reason: 'transport_error', detail: 'synthetic: no answer' });
  await w.tickAt(at('07:02'));
  await w.tickAt(at('08:03'));
  await w.tickAt(at('09:04'));
  w.bank.nextHpb(notYet());
  await w.tickAt(at('07:02', NEXT));
  assert.equal(w.rows().length, 4);
  assert.equal(w.legs(), legsBefore, 'four checks, zero legs');
  assert.equal(w.row().state, 'ini_sent', 'a failed probe moves nothing');
});

// --- the caps -----------------------------------------------------------------------------------------

test('one probe a day: a second tick the same day does nothing, the next day checks again at attempt 1', async () => {
  const w = world();
  w.bank.nextHpb(notYet());
  w.bank.nextHpb(notYet());
  assert.equal((await w.tickAt(at('07:02'))).length, 1);
  assert.deepEqual(await w.tickAt(at('08:30')), []);
  assert.deepEqual(await w.tickAt(at('23:59')), []);
  assert.equal(w.hpbs(), 1, 'one HPB that day');
  const [next] = await w.tickAt(at('07:01', NEXT));
  assert.deepEqual([next.localDate, next.attempt], [NEXT, 1]);
});

test('a transient failure is retried hourly, at most twice, then tomorrow', async () => {
  const w = world();
  for (let i = 0; i < 3; i += 1) w.bank.nextHpb({ ok: false, reason: 'transport_error', detail: 'synthetic: the host did not answer' });
  const [first] = await w.tickAt(at('07:02'));
  assert.deepEqual([first.outcome, first.retryable, first.attempt], ['channel_unreachable', true, 1]);
  assert.deepEqual(await w.tickAt(at('07:40')), [], 'not before an hour');
  assert.equal(w.status().activation.nextCheckAt, new Date(Date.parse(at('07:02')) + 3_600_000).toISOString());
  assert.equal((await w.tickAt(at('08:03')))[0].attempt, 2);
  assert.equal((await w.tickAt(at('09:04')))[0].attempt, 3);
  assert.deepEqual(await w.tickAt(at('10:05')), [], 'three a day, no more');
  assert.deepEqual(await w.tickAt(at('18:00')), []);
  assert.equal(w.hpbs(), 3);
  assert.equal(w.status().activation.nextCheckAt, at('07:00', NEXT));
  assert.equal((await w.tickAt(at('07:01', NEXT)))[0].attempt, 1, 'a new day starts at attempt 1');
});

test('critic F3: a keystore unlocked after a locked check makes the connection due again that day', async () => {
  let state = 'locked';
  const w = world('pending_bank_activation', { keystore: { ...defaultEbicsKeystore, state: () => state } });
  const [locked] = await w.tickAt(at('07:02'));
  assert.deepEqual([locked.outcome, locked.retryable], ['keystore_locked', false]);
  assert.deepEqual(await w.tickAt(at('07:10')), [], 'still locked: no second check');
  state = 'unlocked'; // the owner restarted TILL with the passphrase, as the card asked
  assert.equal(w.status().activation.nextCheckAt, w.clock.current, 'the status names the catch-up: due now');
  const [after] = await w.tickAt(at('07:11'));
  assert.deepEqual([after.outcome, after.attempt], ['bank_ready', 2], 'the catch-up check runs at once');
  assert.equal(w.hpbs(), 1);
});

test('critic F9: lastCheckAt counts only checks the bank answered; a failed attempt is lastAttemptAt', async () => {
  const w = world();
  w.bank.nextHpb({ ok: false, reason: 'transport_error', detail: 'synthetic: no answer' });
  await w.tickAt(at('07:02'));
  let a = w.status().activation;
  assert.equal(a.lastCheckAt, null, 'the bank never answered: nothing was checked');
  assert.equal(a.lastAttemptAt, at('07:02'));
  w.bank.nextHpb(notYet());
  await w.tickAt(at('08:03'));
  a = w.status().activation;
  assert.equal(a.lastCheckAt, at('08:03'), 'the bank answered with its code: that is a check');
  assert.equal(a.lastAttemptAt, at('08:03'));
  const locked = world('pending_bank_activation', { keystore: { ...defaultEbicsKeystore, state: () => 'locked' } });
  await locked.tickAt(at('07:02'));
  assert.equal(locked.status().activation.lastCheckAt, null, 'a locked store asked nobody');
});

test('critic F7: a check row that cannot be written after the HPB never lets the probe loop', async () => {
  const w = world();
  // Every FINAL check row fails to land (a full disk, a busy book): only the pre-probe mark gets in.
  w.store.db.exec(`CREATE TRIGGER synthetic_no_final BEFORE INSERT ON ebics_activation_check
    WHEN NEW.outcome_code != 'started' BEGIN SELECT RAISE(ABORT, 'synthetic: the check row cannot be written'); END;`);
  for (let i = 0; i < 40; i += 1) w.bank.nextHpb({ ok: false, reason: 'transport_error', detail: 'synthetic: no answer' });
  for (let minute = 2; minute < 24 * 60 - 7 * 60; minute += 10) {
    const hh = String(7 + Math.floor(minute / 60)).padStart(2, '0');
    const mm = String(minute % 60).padStart(2, '0');
    await w.tickAt(at(`${hh}:${mm}`));
  }
  assert.ok(w.hpbs() <= 3, `at most three HPBs that day, not one per tick (got ${w.hpbs()})`);
  assert.ok(w.hpbs() >= 1, 'the probe did run');
});

test('critic F8 (M11): checkBankActivation re-reads its own decision, so a double call checks once', async () => {
  const w = world();
  w.bank.nextHpb(notYet());
  w.clock.current = at('07:02');
  const first = checkBankActivation(w.ctx, { connectionId: w.connectionId, now: at('07:02') });
  assert.equal(first?.outcome, 'not_activated');
  const second = checkBankActivation(w.ctx, { connectionId: w.connectionId, now: at('07:03') });
  assert.equal(second, null, 'not due: the function says so itself');
  const early = world();
  assert.equal(checkBankActivation(early.ctx, { connectionId: early.connectionId, now: at('06:00') }), null, 'before the time: nothing');
  assert.equal(w.hpbs() + early.hpbs(), 1, 'one HPB in all');
});

test('critic R2-2: a missing wire or a broken keystore, fixed at restart, lets the same day catch up', async () => {
  const wireless = world();
  delete wireless.deps.ebicsTransport;
  const [none] = await wireless.tickAt(at('07:02'));
  assert.deepEqual([none.outcome, none.retryable], ['needs_bank_transport', false]);
  assert.deepEqual(await wireless.tickAt(at('07:10')), [], 'still no wire: the day stays ended');
  wireless.deps.ebicsTransport = wireless.bank.port; // restarted with the wire configured
  const [caught] = await wireless.tickAt(at('07:11'));
  assert.deepEqual([caught.attempt, caught.outcome], [2, 'bank_ready'], 'the catch-up check runs at once');

  let state = 'unavailable';
  const broken = world('pending_bank_activation', { keystore: { ...defaultEbicsKeystore, state: () => state } });
  const [gone] = await broken.tickAt(at('07:02'));
  assert.deepEqual([gone.outcome, gone.retryable], ['keystore_unavailable', false]);
  assert.deepEqual(await broken.tickAt(at('07:10')), [], 'still broken: the day stays ended');
  state = 'ready'; // restarted with the keystore file restored
  const [back] = await broken.tickAt(at('07:11'));
  assert.deepEqual([back.attempt, back.outcome], [2, 'bank_ready']);
});

test('critic R3-2 (§H-TENANT): another workspace row never stops the main thread counting a failed worker', () => {
  const a = world();
  const b = world('pending_bank_activation', { store: { store: a.store, clock: a.clock, ids: a.ids } });
  // A row planted under workspace B naming A's connection, day and attempt, with a landed outcome.
  a.store.db
    .prepare(
      `INSERT INTO ebics_activation_check (id, workspace_id, connection_id, local_date, attempt, checked_at, outcome_code, retryable, run_as, bank_code)
       VALUES ('eact_planted', ?, ?, ?, 1, ?, 'not_activated', 0, 'studio', '091002')`,
    )
    .run(b.workspaceId, a.connectionId, DAY, at('07:01'));
  const wrote = recordUnknownActivationAttempt(a.ctx, { connectionId: a.connectionId, localDate: DAY, attempt: 1, checkedAt: at('07:02'), reason: 'sync_worker_failed' });
  assert.equal(wrote, true, "B's row is not A's outcome: A's attempt is still counted");
  const rows = a.store.db
    .prepare('SELECT attempt, outcome_code, bank_code FROM ebics_activation_check WHERE workspace_id = ? AND connection_id = ?')
    .all(a.workspaceId, a.connectionId);
  assert.equal(rows.length, 1, 'exactly one row landed in A');
  assert.equal(rows[0].attempt, 1);
  assert.equal(rows[0].bank_code, 'sync_worker_failed');
});

test('critic R3-1: a worker answering no report is counted only when nothing else settled its attempt', async () => {
  const outcomeRows = (w) =>
    w.store.db
      .prepare("SELECT attempt, outcome_code, bank_code FROM ebics_activation_check WHERE workspace_id = ? AND connection_id = ? AND outcome_code != 'started' ORDER BY rowid")
      .all(w.workspaceId, w.connectionId);
  const withRunner = (w, runner) =>
    createScheduler({ ...w.deps, bankActivationRunner: runner }, { listWorkspaceIds: () => [w.workspaceId], runDue: () => {}, now: () => new Date(w.clock.current) });

  // (a) Meanwhile a human fetched the keys: the bank is ready, the attempt is no longer due, and the
  // main thread's still-due re-check (R1) is the only thing that keeps it from writing a row.
  const ready = world();
  ready.clock.current = at('07:02');
  const s1 = withRunner(ready, async () => {
    ready.store.db
      .prepare(
        `INSERT INTO ebics_order_log (id, workspace_id, connection_id, order_ref, direction, order_type, status, occurred_at)
         VALUES ('ebord_human', ?, ?, 'HPB', 'download', 'HPB', 'ok', ?)`,
      )
      .run(ready.workspaceId, ready.connectionId, at('07:02'));
    return { ok: true, report: null };
  });
  await s1.bankTickOnce();
  assert.deepEqual(outcomeRows(ready), [], 'the bank became ready: nothing to count');

  // (b) The worker DID land an outcome for attempt 1 (no wire in its process), yet answered no report;
  // the main thread has a wire, so the attempt reads due again (R2-2). The landed-outcome check (R6) is
  // the only thing that keeps attempt 1 from a second outcome row.
  const landed = world();
  landed.clock.current = at('07:02');
  const s2 = withRunner(landed, async (_deps, input) => {
    const wireless = makeContext(landed.store, { workspaceId: landed.workspaceId, actor: 'system', clock: landed.clock, ids: landed.ids });
    checkBankActivation(wireless, { connectionId: input.connectionId, now: input.now });
    return { ok: true, report: null };
  });
  await s2.bankTickOnce();
  assert.deepEqual(outcomeRows(landed), [{ attempt: 1, outcome_code: 'needs_bank_transport', bank_code: null }], 'one outcome for attempt 1');
});

test('critic R2-3: the unlock catch-up stays inside the daily cap of three', async () => {
  let state = 'ready';
  const w = world('pending_bank_activation', { keystore: { ...defaultEbicsKeystore, state: () => state } });
  w.bank.nextHpb({ ok: false, reason: 'transport_error', detail: 'synthetic: no answer' });
  w.bank.nextHpb({ ok: false, reason: 'transport_error', detail: 'synthetic: no answer' });
  assert.equal((await w.tickAt(at('07:02')))[0].attempt, 1);
  assert.equal((await w.tickAt(at('08:03')))[0].attempt, 2);
  state = 'locked';
  const [third] = await w.tickAt(at('09:04'));
  assert.deepEqual([third.attempt, third.outcome], [3, 'keystore_locked']);
  state = 'unlocked';
  assert.deepEqual(await w.tickAt(at('09:05')), [], 'unlocked, but three attempts already: no fourth today');
  assert.deepEqual(await w.tickAt(at('15:00')), []);
  assert.equal(w.hpbs(), 2);
  assert.equal((await w.tickAt(at('07:01', NEXT)))[0].attempt, 1, 'tomorrow starts again');
});

test("critic F5/F6: the wire's transient reasons are retried, an unusable answer is not", async () => {
  // A lost answer: the port throws, which callPort reports as answer_lost (the wire's own shape).
  const lost = world();
  const real = lost.bank.port.fetchBankKeys;
  lost.bank.port.fetchBankKeys = () => {
    throw new Error('synthetic: the answer was lost');
  };
  const [a] = await lost.tickAt(at('07:02'));
  assert.deepEqual([a.outcome, a.retryable, a.bankCode], ['channel_unreachable', true, 'answer_lost']);
  lost.bank.port.fetchBankKeys = real;
  lost.bank.nextHpb(notYet());
  assert.equal((await lost.tickAt(at('08:03')))[0].attempt, 2, 'a lost answer is retried an hour later');
  // An answer nobody can use (the wire's protocol_error) and its pre-wire refusals end the day.
  for (const reason of ['protocol_error', 'certificate_missing', 'keystore_unavailable', 'invalid_request', 'internal_error', 'untrusted_response']) {
    const w = world();
    w.bank.nextHpb({ ok: false, reason, detail: 'synthetic' });
    const [r] = await w.tickAt(at('07:02'));
    assert.deepEqual([r.outcome, r.retryable], ['channel_unreachable', false], reason);
    assert.deepEqual(await w.tickAt(at('08:03')), [], `${reason}: not retried that day`);
  }
});

test('a bank code, a locked keystore and no wire end the day: none is retried', async () => {
  const w = world();
  w.bank.nextHpb(notYet());
  await w.tickAt(at('07:02'));
  assert.deepEqual(await w.tickAt(at('08:03')), [], 'the bank answered: no retry');
  const locked = world('pending_bank_activation', { keystore: { ...defaultEbicsKeystore, state: () => 'locked' } });
  const [l] = await locked.tickAt(at('07:02'));
  assert.deepEqual([l.outcome, l.retryable], ['keystore_locked', false]);
  assert.equal(locked.hpbs(), 0, 'a locked store sends nothing');
  assert.deepEqual(await locked.tickAt(at('08:03')), []);
  const wireless = world();
  delete wireless.deps.ebicsTransport;
  const [x] = await wireless.tickAt(at('07:02'));
  assert.deepEqual([x.outcome, x.retryable], ['needs_bank_transport', false]);
  assert.deepEqual(await wireless.tickAt(at('08:03')), []);
});

// --- the seated actor ------------------------------------------------------------------------------------

function provision(w, actor = 'user_1') {
  must({ ok: seatFirstOwner(makeContext(w.store, { workspaceId: w.workspaceId, actor, clock: w.clock, ids: w.ids })) !== undefined }, 'seat');
  assert.equal(isProvisioned(w.store, w.workspaceId), true);
}

function demote(w, actor, role = 'viewer') {
  w.store.db
    .prepare('UPDATE workspace_member SET role = ? WHERE workspace_id = ? AND user_id = (SELECT id FROM user WHERE actor_id = ?)')
    .run(role, w.workspaceId, actor);
}

test('the probe runs as a seated actor holding pay, checked live; with none, nothing reaches the bank', async () => {
  const w = world();
  provision(w, 'bookkeeper');
  w.bank.nextHpb(notYet());
  const [owner] = await w.tickAt(at('07:02'));
  assert.equal(owner.runAs, 'studio', 'a connection that never set its schedule runs as the owner seat');
  demote(w, 'bookkeeper');
  demote(w, 'studio');
  // The agent seat is an owner too, but a governed seat never runs an unattended probe.
  const [none] = await w.tickAt(at('07:02', NEXT));
  assert.deepEqual([none.outcome, none.runAs, none.retryable], ['auto_sync_no_actor', null, false]);
  assert.equal(w.hpbs(), 1, 'only the first day reached the bank');
  assert.deepEqual(w.rows().map((r) => r.run_as), ['studio', null]);
});

test('a governed seat that set the schedule never runs the probe; the owner seat does', async () => {
  const w = world();
  provision(w);
  must(getAction('set_bank_sync_schedule').run({ ...w.deps, actor: 'agent' }, { workspaceId: w.workspaceId, connectionId: w.connectionId, idempotencyKey: 'ag-1', mode: 'daily' }), 'agent row');
  w.bank.nextHpb(notYet());
  const [r] = await w.tickAt(at('07:02'));
  assert.equal(r.runAs, 'studio');
});

test('the probe is not a verb and not automatable: bank_channel_connect stays human only on the denylist', () => {
  assert.equal(getAction('check_bank_activation'), undefined);
  assert.equal(NOT_AUTOMATABLE.has('bank_channel_connect'), true);
});

// --- agents see it -----------------------------------------------------------------------------------------

test('attention_summary names a ready bank, and only a ready bank', async () => {
  const w = world();
  const queue = () => w.attention().queues.find((q) => q.queueId === 'bank_keys_review');
  assert.equal(queue(), undefined, 'no activation check yet: no item');
  w.bank.nextHpb(notYet());
  await w.tickAt(at('07:02'));
  assert.equal(queue(), undefined, 'not activated yet: no item');
  await w.tickAt(at('07:02', NEXT));
  const q = queue();
  assert.equal(q?.count, 1, 'the bank answered: one item');
  const item = w.attention().top.find((i) => i.queueId === 'bank_keys_review');
  assert.equal(item.deepLink.route, '/bank-accounts');
  assert.equal(item.entityId, w.connectionId);
  assert.equal(item.titleKey, 'attention.item.bankKeysReview.title');
  assert.equal(item.titleParams.bank, 'SYNTHACT', 'an unknown host is named by its host ID');
  assert.ok(item.decisionOptions.every((o) => o.verb === null), 'the row only opens the compare, it never confirms');
  // Once the person confirmed, the item is gone.
  const fetched = must(connectBankChannel(w.ctx, { connectionId: w.connectionId, confirm: true }), 'human fetch');
  must(connectBankChannel(w.ctx, { connectionId: w.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'human confirm');
  assert.equal(queue(), undefined, 'active: no item');
});

test('critic F10: the ready item reaches only someone who may act on it (pay), not a read-only member', async () => {
  const w = world();
  provision(w, 'bookkeeper');
  await w.tickAt(at('07:02'));
  const queueFor = (actor) =>
    must(getAction('attention_summary').run({ ...w.deps, actor }, { workspaceId: w.workspaceId }), `attention as ${actor}`).queues.find((q) => q.queueId === 'bank_keys_review');
  assert.equal(queueFor('bookkeeper')?.count, 1, 'an owner who may pay sees it');
  demote(w, 'bookkeeper', 'viewer');
  assert.equal(queueFor('bookkeeper'), undefined, 'a viewer, who could not confirm the keys, does not');
});

test('the status and the verb descriptions tell an agent the compare belongs to a person', () => {
  const status = getAction('bank_channel_status');
  assert.match(status.summary ?? status.description ?? '', /bankReady/);
  assert.match(status.summary ?? status.description ?? '', /human/i);
});

test('bankShortName: the BIC bank code at the start of the host ID, else a host URL label, else the host ID', () => {
  assert.equal(bankShortName({ hostId: 'ZKBKCHZZ', hostUrl: 'https://ebics.example/ebicsweb' }), 'ZKB');
  assert.equal(bankShortName({ hostId: 'SYNTH', hostUrl: 'https://ebics.zkb.ch/ebicsweb' }), 'ZKB');
  assert.equal(bankShortName({ hostId: 'SYNTH', hostUrl: 'https://ebics.postfinance.ch/x' }), 'PostFinance');
  assert.equal(bankShortName({ hostId: 'SYNTHHST', hostUrl: 'not a url' }), 'SYNTHHST');
});

// --- §H-TENANT ---------------------------------------------------------------------------------------------

test('every new query is fenced to its workspace: another workspace rows never decide or ready this one', async () => {
  const a = world();
  const b = world('pending_bank_activation', { store: { store: a.store, clock: a.clock, ids: a.ids } });
  // Forged rows under workspace B that name A's connection: a check that "ended the day" and an HPB ok.
  a.store.db
    .prepare(
      `INSERT INTO ebics_activation_check (id, workspace_id, connection_id, local_date, attempt, checked_at, outcome_code, retryable, run_as, bank_code)
       VALUES ('eact_forged', ?, ?, ?, 1, ?, 'not_activated', 0, 'studio', '091002')`,
    )
    .run(b.workspaceId, a.connectionId, DAY, at('07:00'));
  a.store.db
    .prepare(
      `INSERT INTO ebics_order_log (id, workspace_id, connection_id, order_ref, direction, order_type, status, occurred_at)
       VALUES ('ebord_forged', ?, ?, 'HPB', 'download', 'HPB', 'ok', ?)`,
    )
    .run(b.workspaceId, a.connectionId, at('07:00'));
  assert.equal(a.status().activation.bankReady, false, "B's HPB row does not make A ready");
  assert.equal(a.status().activation.lastOutcome, null, "B's check row is not A's last outcome");
  assert.equal(a.attention().queues.find((q) => q.queueId === 'bank_keys_review'), undefined, "A's hub shows nothing");
  a.bank.nextHpb(notYet());
  const reports = await a.tickAt(at('07:02'));
  assert.equal(reports.length, 1, "B's check row does not end A's day");
  assert.equal(reports[0].attempt, 1, "B's row does not count as A's attempt");
  // A direct call for B's connection from A's context finds nothing.
  assert.equal(checkBankActivation(a.ctx, { connectionId: b.connectionId, now: at('08:00') }), null);
  assert.equal(b.rows().length, 0, 'nothing was written for B');
});
