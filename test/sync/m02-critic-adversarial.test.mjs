// M02 CRITIC adversarial probes (claude/m02-critic). NOT product code: these run only to REFUTE the
// contract's correctness. They attack workspace shapes the shipped fixture omits:
//   - multi-currency (two distinct foreign currencies in one book);
//   - a reversal of a reversal;
//   - a hard year-close (source='close') and its carry entry;
//   - an idempotent double-post (same idempotencyKey);
//   - a heavy shuffle fuzz over the reconstruct fold;
//   - the guards actually BITE (idempotency index, tenant fence) when removed.
// Every reconstruct must equal the engine's own computeTrialBalance to the Rappen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import { hardCloseYear } from '../../dist/core/ledger/yearClose.js';
import { computeTrialBalance } from '../../dist/core/reports/index.js';
import {
  SYNC_ERRORS,
  enableSyncPublish,
  disableSyncPublish,
  readSyncStream,
  reconstructFromStream,
} from '../../dist/core/sync/index.js';

const AT = '2026-07-16T00:00:00.000Z';

function world() {
  const store = new SqliteStore({ clock: fixedClock(AT) });
  const ids = sequenceIdGen();
  const mkWorkspace = (id) => {
    store.db
      .prepare('INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, id, 'CHF', '01-01', AT);
    const accounts = {};
    const acct = (number, nm, type) => {
      accounts[number] = `${id}_${number}`;
      store.db
        .prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)')
        .run(accounts[number], id, number, nm, type);
    };
    acct('1000', 'Kasse', 'asset');
    acct('1020', 'Bank', 'asset');
    acct('1021', 'Bank USD', 'asset');
    acct('6500', 'Büromaterial', 'expense');
    acct('3000', 'Dienstleistungsertrag', 'income');
    acct('4000', 'Materialaufwand', 'expense');
    // Year-close carry accounts (A01 guarantees these; typed equity).
    acct('2979', 'Jahresgewinn', 'equity');
    acct('2970', 'Gewinnvortrag', 'equity');
    const ctx = makeContext(store, { workspaceId: id, actor: `${id}_user`, clock: fixedClock(AT), ids });
    return { ctx, accounts };
  };
  return { store, mkWorkspace };
}

function drainStream(ctx) {
  const events = [];
  let cursor = { seq: 0 };
  for (;;) {
    const res = readSyncStream(ctx, { cursor, limit: 3 });
    assert.equal(res.ok, true, `stream read failed: ${JSON.stringify(res)}`);
    events.push(...res.events);
    if (!res.hasMore) break;
    cursor = { seq: res.cursor.seq, epoch: res.epoch };
  }
  return events;
}

function engineTB(ctx) {
  const tb = computeTrialBalance(ctx, { periodStart: '2000-01-01', periodEnd: '2099-12-31' });
  assert.equal(tb.ok, true);
  const byNumber = {};
  for (const row of tb.rows) byNumber[row.account.number] = row.closingMinor;
  return byNumber;
}

// A tiny deterministic PRNG so the shuffle fuzz is reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('CRITIC M02: multi-currency book (CHF + EUR + USD) reconstructs to the Rappen and is shuffle-invariant', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('mc');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en' }).ok, true);

  // CHF expense.
  assert.equal(postEntry(ctx, {
    date: '2026-03-01', description: 'chf', source: 'manual', idempotencyKey: 'c1',
    lines: [{ account: accounts['6500'], debit: 5000 }, { account: accounts['1000'], credit: 5000 }],
  }).ok, true);
  // EUR income at 0.95.
  assert.equal(postEntry(ctx, {
    date: '2026-03-02', description: 'eur', source: 'manual', idempotencyKey: 'e1', currency: 'EUR', fxRate: '0.95',
    lines: [{ account: accounts['1020'], debit: 10000 }, { account: accounts['3000'], credit: 10000 }],
  }).ok, true);
  // USD expense at 0.88 (a SECOND foreign currency: the fixture only ever used one).
  assert.equal(postEntry(ctx, {
    date: '2026-03-03', description: 'usd', source: 'manual', idempotencyKey: 'u1', currency: 'USD', fxRate: '0.88',
    lines: [{ account: accounts['4000'], debit: 7000 }, { account: accounts['1021'], credit: 7000 }],
  }).ok, true);
  // A second USD entry at a DIFFERENT rate: base amounts differ from the txn amounts by a distinct factor.
  assert.equal(postEntry(ctx, {
    date: '2026-03-04', description: 'usd2', source: 'manual', idempotencyKey: 'u2', currency: 'USD', fxRate: '0.91',
    lines: [{ account: accounts['1021'], debit: 3000 }, { account: accounts['3000'], credit: 3000 }],
  }).ok, true);

  const events = drainStream(ctx);
  const rebuilt = reconstructFromStream(events);
  assert.equal(rebuilt.everyFactBalanced, true);
  assert.equal(rebuilt.balancedOverall, true);
  assert.deepEqual(rebuilt.balancesByAccount, engineTB(ctx), 'multi-currency stream == engine trial balance');

  // Shuffle fuzz: 200 random legal orders all reconstruct identically.
  const rnd = mulberry32(12345);
  const ref = reconstructFromStream(events).balancesByAccount;
  for (let i = 0; i < 200; i += 1) {
    const s = reconstructFromStream(shuffle(events, rnd));
    assert.deepEqual(s.balancesByAccount, ref, `shuffle #${i} diverged`);
  }
});

test('CRITIC M02: a reversal of a reversal round-trips on the stream and reconstructs to the Rappen', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('rr');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en' }).ok, true);

  const p = postEntry(ctx, {
    date: '2026-04-01', description: 'orig', source: 'manual', idempotencyKey: 'p1', currency: 'EUR', fxRate: '0.95',
    lines: [{ account: accounts['1020'], debit: 8000 }, { account: accounts['3000'], credit: 8000 }],
  });
  assert.equal(p.ok, true);
  const r1 = reverseEntry(ctx, { entryId: p.entryId, idempotencyKey: 'r1' });
  assert.equal(r1.ok, true);
  // Reverse the REVERSAL: a reversal is itself a posted fact, so it can be reversed again.
  const r2 = reverseEntry(ctx, { entryId: r1.reversalId, idempotencyKey: 'r2' });
  assert.equal(r2.ok, true);

  const events = drainStream(ctx);
  assert.equal(events.length, 3, 'original + reversal + reversal-of-reversal all published');
  const rebuilt = reconstructFromStream(events);
  assert.equal(rebuilt.everyFactBalanced, true);
  // Net effect: original + rev = 0, then rev-of-rev reinstates the original once.
  assert.deepEqual(rebuilt.balancesByAccount, engineTB(ctx), 'reversal^2 stream == engine trial balance');
});

test('CRITIC M02: a hard year-close entry (source=close) rides the stream and reconstruct still matches', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('yc');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en' }).ok, true);

  // P&L activity inside 2026.
  assert.equal(postEntry(ctx, {
    date: '2026-05-01', description: 'rev', source: 'manual', idempotencyKey: 'y1',
    lines: [{ account: accounts['1000'], debit: 12000 }, { account: accounts['3000'], credit: 12000 }],
  }).ok, true);
  assert.equal(postEntry(ctx, {
    date: '2026-06-01', description: 'exp', source: 'manual', idempotencyKey: 'y2',
    lines: [{ account: accounts['6500'], debit: 4500 }, { account: accounts['1000'], credit: 4500 }],
  }).ok, true);

  const headBeforeClose = drainStream(ctx).length;
  const close = hardCloseYear(ctx, { year: 2026, idempotencyKey: 'close-2026' });
  assert.equal(close.ok, true, `year close failed: ${JSON.stringify(close)}`);

  const events = drainStream(ctx);
  assert.equal(events.length > headBeforeClose, true, 'the close entry was published to the stream');
  const closeEvents = events.filter((e) => e.payload && e.payload.source === 'close');
  assert.equal(closeEvents.length >= 1, true, 'a source=close fact appears on the stream');

  const rebuilt = reconstructFromStream(events);
  assert.equal(rebuilt.everyFactBalanced, true);
  assert.deepEqual(rebuilt.balancesByAccount, engineTB(ctx), 'post-close stream == engine trial balance');
});

test('CRITIC M02: an idempotent double-post (same key) publishes exactly ONE fact', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('id');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en' }).ok, true);

  const mk = () => postEntry(ctx, {
    date: '2026-03-01', description: 'dup', source: 'manual', idempotencyKey: 'SAME',
    lines: [{ account: accounts['6500'], debit: 999 }, { account: accounts['1000'], credit: 999 }],
  });
  const a = mk();
  const b = mk(); // replayed via §H-IDEMPOTENT: must NOT create a second entry OR a second outbox row.
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const n = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE workspace_id = ?').get('id').n;
  assert.equal(n, 1, 'a double-post under one key appended exactly one envelope');
  const events = drainStream(ctx);
  assert.equal(events.length, 1);
  assert.deepEqual(reconstructFromStream(events).balancesByAccount, engineTB(ctx));
});

test('CRITIC M02 BITE: dropping the UNIQUE fact index lets a re-publish duplicate (guard bites)', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('bite');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en' }).ok, true);
  assert.equal(postEntry(ctx, {
    date: '2026-03-01', description: 'x', source: 'manual', idempotencyKey: 'k1',
    lines: [{ account: accounts['6500'], debit: 100 }, { account: accounts['1000'], credit: 100 }],
  }).ok, true);

  // With the index present, a manual re-insert of the SAME (workspace, kind, source_ref) is rejected.
  const dup = () => ctx.store.db
    .prepare(`INSERT INTO sync_outbox (workspace_id, seq, epoch, occurred_at, actor, kind, source_ref, payload_schema, artifact_sha256, produced_at)
              SELECT workspace_id, seq + 1000, epoch, occurred_at, actor, kind, source_ref, payload_schema, artifact_sha256, produced_at
                FROM sync_outbox WHERE workspace_id = 'bite' LIMIT 1`)
    .run();
  assert.throws(dup, /UNIQUE|constraint/i, 'the UNIQUE(workspace_id, kind, source_ref) index refuses a duplicate fact');

  // Remove the index: the same insert now DUPLICATES the fact, proving the guard was load-bearing.
  ctx.store.db.prepare('DROP INDEX sync_outbox_fact').run();
  dup();
  const n = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE workspace_id = ?').get('bite').n;
  assert.equal(n, 2, 'without the index the fact duplicated: the guard bites');
});

test('CRITIC M02 BITE: the stream read is tenant-fenced (removing the fence would leak)', () => {
  const { mkWorkspace } = world();
  const a = mkWorkspace('t1');
  const b = mkWorkspace('t2');
  assert.equal(enableSyncPublish(a.ctx, { idempotencyKey: 'en' }).ok, true);
  assert.equal(enableSyncPublish(b.ctx, { idempotencyKey: 'en' }).ok, true);
  assert.equal(postEntry(a.ctx, { date: '2026-03-01', source: 'manual', idempotencyKey: 'a1',
    lines: [{ account: a.accounts['6500'], debit: 111 }, { account: a.accounts['1000'], credit: 111 }] }).ok, true);
  assert.equal(postEntry(b.ctx, { date: '2026-03-01', source: 'manual', idempotencyKey: 'b1',
    lines: [{ account: b.accounts['6500'], debit: 222 }, { account: b.accounts['1000'], credit: 222 }] }).ok, true);

  // The verb only ever returns this tenant's rows.
  const aEvents = drainStream(a.ctx);
  for (const e of aEvents) assert.equal(e.workspaceId, 't1');
  // A raw cross-tenant SELECT would return the OTHER tenant's row: proves the fence in the verb is
  // what stops the leak, not the absence of other data on the file.
  const leaked = a.ctx.store.db
    .prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE workspace_id = ?')
    .get('t2').n;
  assert.equal(leaked, 1, 'the other tenant DOES have a row on the shared file; only the verb fence hides it');
});

test('CRITIC M02: publishing OFF leaves posting byte-for-byte identical (trial balance unchanged)', () => {
  // Two identical books, one publishing, one not: the trial balance must be identical.
  const off = world();
  const offWs = off.mkWorkspace('off');
  const on = world();
  const onWs = on.mkWorkspace('on');
  assert.equal(enableSyncPublish(onWs.ctx, { idempotencyKey: 'en' }).ok, true);

  for (const [ws, tag] of [[offWs, 'off'], [onWs, 'on']]) {
    assert.equal(postEntry(ws.ctx, { date: '2026-03-01', source: 'manual', idempotencyKey: `${tag}1`,
      lines: [{ account: ws.accounts['6500'], debit: 4200 }, { account: ws.accounts['1000'], credit: 4200 }] }).ok, true);
    assert.equal(postEntry(ws.ctx, { date: '2026-03-02', source: 'manual', idempotencyKey: `${tag}2`, currency: 'EUR', fxRate: '0.95',
      lines: [{ account: ws.accounts['1020'], debit: 6000 }, { account: ws.accounts['3000'], credit: 6000 }] }).ok, true);
  }
  // The publishing book's outbox is non-empty; the non-publishing one has no outbox row at all.
  assert.equal(off.store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE workspace_id='off'").get().n, 0);
  assert.equal(on.store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE workspace_id='on'").get().n, 2);

  // Same trial balance keyed by number: the trigger changed no posting result.
  const offTB = engineTB(offWs.ctx);
  const onTB = engineTB(onWs.ctx);
  const strip = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k.replace(/^.._/, ''), v]));
  assert.deepEqual(strip(offTB), strip(onTB), 'the publish trigger did not alter any posting result');

  // And the publishing book reconstructs to its own trial balance.
  const events = drainStream(onWs.ctx);
  assert.deepEqual(reconstructFromStream(events).balancesByAccount, onTB);
});

test('CRITIC M02: disable then re-enable resumes the SAME stream (epoch kept, no gap, no dup)', () => {
  const { mkWorkspace } = world();
  const { ctx, accounts } = mkWorkspace('re');
  assert.equal(enableSyncPublish(ctx, { idempotencyKey: 'en1' }).ok, true);
  const first = readSyncStream(ctx, { cursor: { seq: 0 } });
  const epoch0 = first.epoch;
  assert.equal(postEntry(ctx, { date: '2026-03-01', source: 'manual', idempotencyKey: 'q1',
    lines: [{ account: accounts['6500'], debit: 100 }, { account: accounts['1000'], credit: 100 }] }).ok, true);

  // Post while OFF: nothing should be captured for that window (the trigger's WHEN is false).
  assert.equal(disableSyncPublish(ctx, { idempotencyKey: 'dis' }).ok, true);
  assert.equal(postEntry(ctx, { date: '2026-03-02', source: 'manual', idempotencyKey: 'q2',
    lines: [{ account: accounts['6500'], debit: 200 }, { account: accounts['1000'], credit: 200 }] }).ok, true);

  const en2 = enableSyncPublish(ctx, { idempotencyKey: 'en2' });
  assert.equal(en2.ok, true);
  assert.equal(en2.epoch, epoch0, 're-enable keeps the same epoch');

  const events = drainStream(ctx);
  // The backfill at re-enable catches the q2 post that happened while OFF: the stream is COMPLETE.
  const rebuilt = reconstructFromStream(events);
  assert.deepEqual(rebuilt.balancesByAccount, engineTB(ctx),
    'a post made while publishing was OFF is recovered by the enable-time backfill');
  const seqs = ctx.store.db.prepare('SELECT seq FROM sync_outbox WHERE workspace_id = ? ORDER BY seq').all('re').map((r) => r.seq);
  assert.deepEqual(seqs, [1, 2], 'gapless across the off window');
});
