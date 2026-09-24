// M02, the §I sync/publish contract (till-sync/1): the invariant suite the critic gates on.
// No `// @ts-check`: this suite reads raw better-sqlite3 rows (`.get()`/`.all()` are typed `unknown`)
// and engine Result payloads (open shapes), the same reason `conformance.test.mjs` opts out. It is
// verified by node --test at runtime, not by the compiler.
//
// It proves, by measurement rather than by comment, the properties D106 and the spec §7/§8 name:
//   - append-only + gapless monotonic seq, under interleaved writers (the D12 pair);
//   - the transactional outbox commits with the fact or not at all (atomicity);
//   - facts only: no command kind exists anywhere on the wire;
//   - idempotent on ROWS: a re-publish / re-enable emits no duplicate;
//   - reconstruct-from-stream is LOSSLESS and ORDER-STABLE (rebuilds the trial balance to the Rappen);
//   - the inbound lane is CLOSED and the ledger has ONE writer (no sync path writes the books);
//   - §H-TENANT: the stream never crosses workspaces;
//   - epoch: a G04 restore re-mint refuses a stale cursor rather than replaying a fork;
//   - publishing default OFF: a fresh workspace publishes nothing and posting is byte-for-byte the same;
//   - no secret rides the stream.
//
// Everything runs offline against a fresh in-memory store.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import { computeTrialBalance } from '../../dist/core/reports/index.js';
import {
  CONTRACT_VERSION,
  STREAM_KINDS,
  ALL_STREAM_KINDS,
  FACT_FAMILIES,
  SYNC_ERRORS,
  isFactKind,
  enableSyncPublish,
  disableSyncPublish,
  remintEpoch,
  getSyncContract,
  readSyncStream,
  syncStreamStatus,
  readSyncArtifact,
  reconstructFromStream,
} from '../../dist/core/sync/index.js';

const AT = '2026-07-16T00:00:00.000Z';

/** A fresh store with one workspace and a small chart, plus a permissive context per workspace. */
function world() {
  const store = new SqliteStore({ clock: fixedClock(AT) });
  const ids = sequenceIdGen();
  const mkWorkspace = (id, name) => {
    store.db
      .prepare('INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, 'CHF', '01-01', AT);
    const accounts = {
      '1000': `${id}_kasse`,
      '1020': `${id}_bank`,
      '6500': `${id}_office`,
      '3000': `${id}_ertrag`,
    };
    const acct = (number, nm, type) =>
      store.db
        .prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)')
        .run(accounts[number], id, number, nm, type);
    acct('1000', 'Kasse', 'asset');
    acct('1020', 'Bank', 'asset');
    acct('6500', 'Büromaterial', 'expense');
    acct('3000', 'Dienstleistungsertrag', 'income');
    const ctx = makeContext(store, { workspaceId: id, actor: `${id}_user`, clock: fixedClock(AT), ids });
    return { ctx, accounts };
  };
  return { store, mkWorkspace };
}

/** A balanced CHF manual entry: debit 6500, credit 1000. */
function chfEntry(accounts, amount, key) {
  return {
    date: '2026-03-01',
    description: 'Büromaterial',
    source: 'manual',
    idempotencyKey: key,
    lines: [
      { account: accounts['6500'], debit: amount },
      { account: accounts['1000'], credit: amount },
    ],
  };
}

/** A balanced foreign-currency entry (EUR at an explicit rate), to exercise the §H-FX base trace. */
function eurEntry(accounts, amount, key) {
  return {
    date: '2026-03-02',
    description: 'EUR income',
    source: 'manual',
    idempotencyKey: key,
    currency: 'EUR',
    fxRate: '0.95',
    lines: [
      { account: accounts['1020'], debit: amount },
      { account: accounts['3000'], credit: amount },
    ],
  };
}

/** Read the whole stream (all events) for a workspace, following the cursor to the head. */
function drainStream(ctx) {
  /** @type {any[]} */
  const events = [];
  /** @type {{ seq: number, epoch?: string }} */
  let cursor = { seq: 0 };
  for (;;) {
    const res = /** @type {any} */ (readSyncStream(ctx, { cursor, limit: 2 }));
    assert.equal(res.ok, true, `stream read failed: ${JSON.stringify(res)}`);
    events.push(...res.events);
    if (!res.hasMore) break;
    cursor = { seq: res.cursor.seq, epoch: res.epoch };
  }
  return events;
}

test('M02: publishing is OFF by default, and a fresh workspace publishes nothing', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('ws_a', 'A');
  const contract = getSyncContract(ctx, {});
  assert.equal(contract.ok, true);
  assert.equal(contract.publishing, false);
  assert.equal(contract.versions.includes(CONTRACT_VERSION), true);

  // Posting with publishing OFF leaves the outbox empty: the trigger's WHEN clause is false.
  const posted = postEntry(ctx, chfEntry(accounts, 5000, 'k1'));
  assert.equal(posted.ok, true);
  const rows = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE workspace_id = ?').get('ws_a');
  assert.equal(rows.n, 0);

  // The stream itself is REFUSED, not merely empty, when publishing is off.
  const read = readSyncStream(ctx, {});
  assert.equal(read.ok, false);
  assert.equal(read.error, SYNC_ERRORS.PUBLISHING_DISABLED);
});

test('M02: enabling backfills existing history, then the trigger appends future posts (gapless, monotonic)', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('ws_b', 'B');

  // Two entries posted BEFORE enabling: they must appear once publishing turns on (backfill).
  assert.equal(postEntry(ctx, chfEntry(accounts, 1000, 'b1')).ok, true);
  assert.equal(postEntry(ctx, chfEntry(accounts, 2000, 'b2')).ok, true);

  const en = enableSyncPublish(ctx, { idempotencyKey: 'en-1' });
  assert.equal(en.ok, true);
  assert.equal(en.publishing, true);
  assert.equal(en.headSeq, 2, 'both pre-existing posts were backfilled');

  // Two entries posted AFTER enabling: the trigger appends them at the tail.
  assert.equal(postEntry(ctx, chfEntry(accounts, 3000, 'b3')).ok, true);
  assert.equal(postEntry(ctx, chfEntry(accounts, 4000, 'b4')).ok, true);

  const seqs = ctx.store.db
    .prepare('SELECT seq FROM sync_outbox WHERE workspace_id = ? ORDER BY seq')
    .all('ws_b')
    .map((r) => r.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4], 'seq is gapless and monotonic across backfill + trigger');

  // Every published fact is a journal.posted fact, nothing else.
  const kinds = new Set(
    ctx.store.db.prepare('SELECT DISTINCT kind FROM sync_outbox WHERE workspace_id = ?').all('ws_b').map((r) => r.kind),
  );
  assert.deepEqual([...kinds], [STREAM_KINDS.JOURNAL_POSTED]);
});

test('M02: seq stays gapless under two interleaved writers on one file (the D12 pair)', () => {
  const { store, mkWorkspace } = world();
  const { accounts } = mkWorkspace('ws_c', 'C');
  // Two contexts, same store, same workspace: the D12 "second writer" shape. They share ONE id
  // generator, exactly as two real writers on one file draw non-colliding ids from `systemIdGen`.
  const sharedIds = sequenceIdGen();
  const w1 = makeContext(store, { workspaceId: 'ws_c', actor: 'a1', clock: fixedClock(AT), ids: sharedIds });
  const w2 = makeContext(store, { workspaceId: 'ws_c', actor: 'a2', clock: fixedClock(AT), ids: sharedIds });
  assert.equal(enableSyncPublish(w1, { idempotencyKey: 'en' }).ok, true);

  // Alternate the two writers. Each post's flip fires the trigger, which assigns MAX(seq)+1 inside
  // the fact's own transaction, so no interleaving can open a gap.
  for (let i = 0; i < 6; i += 1) {
    const w = i % 2 === 0 ? w1 : w2;
    assert.equal(postEntry(w, chfEntry(accounts, 100 + i, `w-${i}`)).ok, true);
  }
  const seqs = store.db.prepare('SELECT seq FROM sync_outbox WHERE workspace_id = ? ORDER BY seq').all('ws_c').map((r) => r.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
});

test('M02: the outbox row and the business fact commit together (atomicity)', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('ws_d', 'D');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en' }).ok, true);

  const before = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE workspace_id = ?').get('ws_d').n;
  // A REJECTED post (unbalanced) must leave no outbox row: the fact never committed, so neither did
  // its envelope. There is no dual-write to lose.
  const bad = postEntry(ctx, {
    date: '2026-03-01',
    source: 'manual',
    idempotencyKey: 'bad',
    lines: [
      { account: accounts['6500'], debit: 500 },
      { account: accounts['1000'], credit: 400 },
    ],
  });
  assert.equal(bad.ok, false);
  const afterBad = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE workspace_id = ?').get('ws_d').n;
  assert.equal(afterBad, before, 'a rejected post appended no envelope');

  // A GOOD post commits exactly one envelope with the fact.
  assert.equal(postEntry(ctx, chfEntry(accounts, 700, 'ok')).ok, true);
  const afterGood = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE workspace_id = ?').get('ws_d').n;
  assert.equal(afterGood, before + 1, 'a committed post appended exactly one envelope');
});

test('M02: re-enabling and replays are idempotent on ROWS (no duplicate fact)', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('ws_e', 'E');
  assert.equal(postEntry(ctx, chfEntry(accounts, 1000, 'e1')).ok, true);
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en-1' }).ok, true);
  assert.equal(postEntry(ctx, chfEntry(accounts, 2000, 'e2')).ok, true);

  const headBefore = ctx.store.db.prepare('SELECT MAX(seq) AS h FROM sync_outbox WHERE workspace_id = ?').get('ws_e').h;
  // Disable, then re-enable with a DIFFERENT key: the backfill runs again but every already-published
  // fact is skipped by the UNIQUE (workspace_id, kind, source_ref) index. No duplicate, no new seq.
  assert.equal(disableSyncPublish(ctx, { idempotencyKey: 'dis-1' }).ok, true);
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en-2' }).ok, true);
  const headAfter = ctx.store.db.prepare('SELECT MAX(seq) AS h FROM sync_outbox WHERE workspace_id = ?').get('ws_e').h;
  assert.equal(headAfter, headBefore, 're-enabling published no duplicate');

  // Every (kind, source_ref) appears exactly once.
  const dupes = ctx.store.db
    .prepare('SELECT kind, source_ref, COUNT(*) AS n FROM sync_outbox WHERE workspace_id = ? GROUP BY kind, source_ref HAVING n > 1')
    .all('ws_e');
  assert.deepEqual(dupes, []);
});

test('M02: reconstruct-from-stream is LOSSLESS (rebuilds the trial balance to the Rappen)', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('ws_f', 'F');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en' }).ok, true);

  // A quarter of mixed activity: CHF, a foreign-currency entry (exercises the §H-FX base trace), and
  // a reversal (which is just another posted fact on the stream).
  assert.equal(postEntry(ctx, chfEntry(accounts, 5000, 'f1')).ok, true);
  assert.equal(postEntry(ctx, chfEntry(accounts, 1250, 'f2')).ok, true);
  const eur = postEntry(ctx, eurEntry(accounts, 10000, 'f3'));
  assert.equal(eur.ok, true);
  assert.equal(reverseEntry(ctx, { entryId: eur.entryId, idempotencyKey: 'f3-rev' }).ok, true);

  const events = drainStream(ctx);
  assert.equal(events.length, 4, 'four posted facts (three posts + one reversal)');

  const rebuilt = reconstructFromStream(events);
  assert.equal(rebuilt.everyFactBalanced, true, 'every published fact balances in base currency');
  assert.equal(rebuilt.balancedOverall, true);
  assert.equal(rebuilt.baseCurrency, 'CHF');

  // The engine's own Saldenbilanz over the whole period, keyed by account number.
  const tb = /** @type {any} */ (computeTrialBalance(ctx, { periodStart: '2000-01-01', periodEnd: '2099-12-31' }));
  assert.equal(tb.ok, true);
  /** @type {Record<string, number>} */
  const engineByNumber = {};
  for (const row of tb.rows) engineByNumber[row.account.number] = row.closingMinor;

  assert.deepEqual(
    rebuilt.balancesByAccount,
    engineByNumber,
    'the stream rebuilds the exact trial balance the ledger holds',
  );
});

test('M02: reconstruct is ORDER-STABLE (folding a shuffled stream yields the same balances)', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('ws_g', 'G');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en' }).ok, true);
  for (let i = 0; i < 5; i += 1) assert.equal(postEntry(ctx, chfEntry(accounts, 100 * (i + 1), `g${i}`)).ok, true);

  const events = drainStream(ctx);
  const inOrder = reconstructFromStream(events);
  const shuffled = reconstructFromStream([...events].reverse());
  assert.deepEqual(shuffled.balancesByAccount, inOrder.balancesByAccount);
});

test('M02: the stream is FACTS ONLY (no command kind exists anywhere)', () => {
  // Every declared kind is a member of a FACT family, past tense; none is a command.
  for (const kind of ALL_STREAM_KINDS) {
    assert.equal(isFactKind(kind), true, `${kind} must be a fact kind`);
    assert.equal(FACT_FAMILIES.includes(kind.split('.')[0] ?? ''), true);
  }
  // Command-shaped kinds are refused, so nothing a consumer could send back is ever an instruction.
  for (const command of ['journal.post', 'payment.record', 'command.run', 'do.post', 'ledger.write']) {
    assert.equal(isFactKind(command), false, `${command} must not be a fact kind`);
  }
  // reconstruct refuses a non-fact kind outright (there is no command to apply).
  const commandEvent = /** @type {any} */ ({
    contractVersion: CONTRACT_VERSION,
    workspaceId: 'x',
    seq: 1,
    epoch: 'e',
    occurredAt: AT,
    actor: 'a',
    kind: 'journal.post',
    payloadSchema: 'x',
    payload: {},
  });
  assert.throws(() => reconstructFromStream([commandEvent]));
});

test('M02: §H-TENANT: the stream never crosses workspaces', () => {
  const { mkWorkspace } = world();
  const a = mkWorkspace('ws_h1', 'H1');
  const b = mkWorkspace('ws_h2', 'H2');
  assert.equal(enableSyncPublish(a.ctx, { idempotencyKey: 'en' }).ok, true);
  assert.equal(enableSyncPublish(b.ctx, { idempotencyKey: 'en' }).ok, true);
  assert.equal(postEntry(a.ctx, chfEntry(a.accounts, 111, 'a1')).ok, true);
  assert.equal(postEntry(b.ctx, chfEntry(b.accounts, 222, 'b1')).ok, true);
  assert.equal(postEntry(b.ctx, chfEntry(b.accounts, 333, 'b2')).ok, true);

  const aEvents = drainStream(a.ctx);
  const bEvents = drainStream(b.ctx);
  assert.equal(aEvents.length, 1);
  assert.equal(bEvents.length, 2);
  for (const e of aEvents) assert.equal(e.workspaceId, 'ws_h1');
  for (const e of bEvents) assert.equal(e.workspaceId, 'ws_h2');
  // Each workspace's seq numbering is independent and starts at 1.
  assert.deepEqual(aEvents.map((e) => e.seq), [1]);
  assert.deepEqual(bEvents.map((e) => e.seq), [1, 2]);
});

test('M02: a G04 restore re-mint refuses a stale cursor (cursor_reset_required)', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('ws_i', 'I');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en' }).ok, true);
  assert.equal(postEntry(ctx, chfEntry(accounts, 500, 'i1')).ok, true);

  const first = readSyncStream(ctx, { cursor: { seq: 0 } });
  assert.equal(first.ok, true);
  const oldEpoch = first.epoch;

  // Simulate a restore: re-mint the epoch. A cursor carrying the OLD epoch now reads a forked history.
  const remint = remintEpoch(ctx);
  assert.equal(remint.ok, true);
  assert.equal(remint.reminted, true);
  assert.notEqual(remint.epoch, oldEpoch);

  const stale = readSyncStream(ctx, { cursor: { seq: 1, epoch: oldEpoch } });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, SYNC_ERRORS.CURSOR_RESET_REQUIRED);
  assert.equal(stale.epoch, remint.epoch, 'the refusal carries the NEW epoch to reset to');
});

test('M02: cursor guards: beyond head is invalid_cursor; disable refuses reads but keeps the rows', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('ws_j', 'J');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en' }).ok, true);
  assert.equal(postEntry(ctx, chfEntry(accounts, 500, 'j1')).ok, true);

  const beyond = readSyncStream(ctx, { cursor: { seq: 99 } });
  assert.equal(beyond.ok, false);
  assert.equal(beyond.error, SYNC_ERRORS.INVALID_CURSOR);

  // Disable: reads are refused, but the published rows REMAIN (append-only, for audit).
  const rowsBefore = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE workspace_id = ?').get('ws_j').n;
  assert.equal(disableSyncPublish(ctx, { idempotencyKey: 'dis' }).ok, true);
  const refused = readSyncStream(ctx, { cursor: { seq: 0 } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, SYNC_ERRORS.PUBLISHING_DISABLED);
  const rowsAfter = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE workspace_id = ?').get('ws_j').n;
  assert.equal(rowsAfter, rowsBefore, 'disable deletes nothing');
});

test('M02: an unknown contract major is refused, never best-effort parsed', () => {
  const { mkWorkspace } = world();
  const { ctx } = mkWorkspace('ws_k', 'K');
  const bad = getSyncContract(ctx, { contractVersion: 'till-sync/9' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, SYNC_ERRORS.UNSUPPORTED_CONTRACT);
  assert.equal(getSyncContract(ctx, { contractVersion: CONTRACT_VERSION }).ok, true);
});

test('M02: sync_stream_status reports head, epoch and consumer lag over metadata only', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('ws_l', 'L');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en' }).ok, true);
  for (let i = 0; i < 3; i += 1) assert.equal(postEntry(ctx, chfEntry(accounts, 100, `l${i}`)).ok, true);
  const status = syncStreamStatus(ctx, { cursor: { seq: 1 } });
  assert.equal(status.ok, true);
  assert.equal(status.publishing, true);
  assert.equal(status.headSeq, 3);
  assert.equal(status.lag, 2, 'lag = head - cursor.seq');
});

test('M02: a hash that is not a published handle is artifact_not_found (this build produces no artifacts)', () => {
  const { mkWorkspace } = world();
  const { ctx } = mkWorkspace('ws_m', 'M');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en' }).ok, true);
  const res = readSyncArtifact(ctx, { sha256: 'deadbeef' });
  assert.equal(res.ok, false);
  assert.equal(res.error, SYNC_ERRORS.ARTIFACT_NOT_FOUND);
});

test('M02: no secret rides the stream (the journal payload carries only ledger facts)', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('ws_n', 'N');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en' }).ok, true);
  assert.equal(postEntry(ctx, eurEntry(accounts, 4200, 'n1')).ok, true);
  const [event] = drainStream(ctx);
  const blob = JSON.stringify(event).toLowerCase();
  for (const secret of ['password', 'secret', 'token', 'apikey', 'api_key', 'private_key', 'passphrase', 'credential']) {
    assert.equal(blob.includes(secret), false, `the stream must not carry a ${secret}`);
  }
  // The §H-FX triple rides every line: transaction amount, base amount, and the rate that links them.
  const line = event.payload.lines[0];
  assert.equal(Number.isInteger(line.baseDebitMinor + line.baseCreditMinor), true);
  assert.equal(line.currency, 'EUR');
  assert.equal(line.fxRate, '0.95');
});

test('M02: ONE writer: the sync module contains no INSERT/UPDATE into the ledger or money tables', () => {
  // The one-writer invariant, held structurally: nothing in the contract half writes the books. The
  // outbox is fed ONLY by the schema trigger and the enable-time backfill (into sync_outbox itself);
  // no sync source file issues a write against journal_entry, journal_line, payment or account.
  const files = ['contract.ts', 'schema.ts', 'outbox.ts', 'stream.ts', 'reconstruct.ts', 'index.ts'];
  const forbidden = /\b(INSERT\s+INTO|UPDATE)\s+(journal_entry|journal_line|payment|account|vat_return|idempotency)\b/i;
  for (const f of files) {
    const src = readFileSync(new URL(`../../src/core/sync/${f}`, import.meta.url), 'utf8');
    // The trigger in schema.ts inserts into sync_outbox only; assert it never targets a ledger table.
    assert.equal(forbidden.test(src), false, `src/core/sync/${f} must not write a ledger/money table`);
  }
});
