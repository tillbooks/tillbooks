// The store runs NO ANALYZE and NO PRAGMA optimize, on any path, ever. The reasoning, with the
// measurements behind it, is on `SqliteStore.close()` in src/core/store/sqlite-store.ts.
//
// A decision recorded only in a comment is a decision that gets quietly reversed, so this suite
// asserts three things against SQLite itself:
//
//  1. The OUTCOME: a full store lifecycle leaves no `sqlite_stat1` behind. Adding an ANALYZE or a
//     `PRAGMA optimize` anywhere in the store turns this red.
//  2. The PREMISE the decision rests on, made falsifiable: ANALYZE is a WRITE, so under D12's second
//     writer it burns the whole busy timeout and then fails SQLITE_BUSY. If that ever stopped being
//     true, the decision would deserve re-opening, and this is the test that would say so.
//  3. The ALTERNATIVE that makes going without statistics affordable: SQLite's per-query levers
//     (`INDEXED BY`, `NOT INDEXED`) reach the same plans deterministically and without a lock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { SqliteStore, DEFAULT_BUSY_TIMEOUT_MS } from '../../dist/core/store/sqlite-store.js';

const AT = '2026-07-16T00:00:00.000Z';

function planOf(db, sql, ...params) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join('\n');
}

function hasStat1(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get().c > 0;
}

/** A small ledger, written the way a posting does: lines while draft, the flip to posted last. */
function seed(db, { entries = 300, workspaceId = 'ws_1' } = {}) {
  db.prepare('INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)').run(
    workspaceId,
    'Acme GmbH',
    'CHF',
    '01-01',
    AT,
  );
  const insAccount = db.prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 12; i++) {
    insAccount.run(`acc_${i}`, workspaceId, String(1000 + i * 10), `Konto ${i}`, i % 2 === 0 ? 'expense' : 'income');
  }
  const insEntry = db.prepare(
    `INSERT INTO journal_entry (id, workspace_id, date, ref, description, status, source, created_at)
     VALUES (?, ?, '2026-03-01', ?, ?, 'draft', 'manual', ?)`,
  );
  const insLine = db.prepare(
    `INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, currency, base_debit_minor, base_credit_minor)
     VALUES (?, ?, ?, ?, ?, 'CHF', ?, ?)`,
  );
  const flip = db.prepare("UPDATE journal_entry SET status = 'posted' WHERE id = ?");
  const entryIds = [];
  for (let e = 0; e < entries; e++) {
    const id = `ent_${String(e).padStart(5, '0')}`;
    entryIds.push(id);
    insEntry.run(id, workspaceId, `B-${e}`, `Buchung ${e}`, AT);
    insLine.run(`lin_${id}_0`, id, `acc_${e % 12}`, 3000, 0, 3000, 0);
    insLine.run(`lin_${id}_1`, id, `acc_${(e + 1) % 12}`, 0, 3000, 0, 3000);
    flip.run(id);
  }
  return { workspaceId, entryIds };
}

// --- 1. the outcome ------------------------------------------------------------------------------

test('a fresh in-memory store has no query-planner statistics, because nothing here ever collects them', () => {
  const store = new SqliteStore();
  seed(store.db, { entries: 20 });
  assert.equal(hasStat1(store.db), false, 'sqlite_stat1 must not exist: the store runs no ANALYZE and no PRAGMA optimize');
  store.close();
});

test('a FULL file lifecycle (open, write, close, reopen, close) leaves no sqlite_stat1 behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-stats-'));
  const file = join(dir, 'till.db');
  try {
    // `location`, not `file`: the wrong option name silently opens `:memory:` and proves nothing,
    // which is why the assertions below check for real rows rather than merely for an absence.
    const first = new SqliteStore({ location: file });
    const { workspaceId, entryIds } = seed(first.db);
    assert.equal(hasStat1(first.db), false, 'no statistics after the writes');
    first.close();

    const second = new SqliteStore({ location: file });
    // The database really is the seeded one on disk, so "no sqlite_stat1" is a fact about THIS
    // database rather than about an empty in-memory one.
    assert.equal(
      second.db.prepare('SELECT name FROM workspace WHERE id = ?').get(workspaceId).name,
      'Acme GmbH',
      'the reopened file must hold the seeded workspace, or this test is looking at :memory:',
    );
    assert.equal(second.db.prepare('SELECT COUNT(*) AS c FROM journal_line').get().c, 600, '300 entries of 2 lines');
    assert.equal(hasStat1(second.db), false, 'reopening must not collect statistics either');

    // And the close path specifically: `close()` checkpoints, and a `PRAGMA optimize` added beside
    // that checkpoint is exactly the change this test exists to catch.
    second.db.prepare('SELECT COUNT(*) AS c FROM journal_line WHERE entry_id = ?').get(entryIds[3]);
    second.close();

    const third = new Database(file, { readonly: true });
    assert.equal(
      third.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get().c,
      0,
      'close() must not run ANALYZE or PRAGMA optimize',
    );
    third.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 2. the premise ------------------------------------------------------------------------------

test('ANALYZE is a WRITE: under D12 second writer it burns the whole busy timeout and then fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-stats-busy-'));
  const file = join(dir, 'till.db');
  try {
    const store = new SqliteStore({ location: file, busyTimeoutMs: 250 });
    seed(store.db, { entries: 50 });
    store.close();

    // Two connections on one file: exactly the D12 shape, where the Studio holds the database open
    // while `till mcp` runs in an agent subprocess.
    const analyzer = new SqliteStore({ location: file, busyTimeoutMs: 250 });
    const otherWriter = new Database(file, { timeout: 250 });
    otherWriter.exec('BEGIN IMMEDIATE');
    try {
      const started = Date.now();
      let code = null;
      try {
        analyzer.db.exec('ANALYZE');
      } catch (e) {
        code = e.code;
      }
      const waited = Date.now() - started;
      assert.equal(code, 'SQLITE_BUSY', 'ANALYZE must be refused while another connection holds the write lock');
      assert.ok(waited >= 200, `and it must WAIT the busy timeout first, not fail fast: waited ${waited} ms`);
      assert.equal(hasStat1(analyzer.db), false, 'the refused ANALYZE must leave nothing behind');

      // At the store's real default that wait is five seconds, on a close path, where the caller is
      // expecting a clean exit. The constant is asserted so the comment's arithmetic stays honest.
      assert.equal(DEFAULT_BUSY_TIMEOUT_MS, 5000);
    } finally {
      otherWriter.exec('ROLLBACK');
      otherWriter.close();
      analyzer.close();
    }

    // A concurrent READER is not the problem: WAL lets that through. So the hazard is specifically
    // the second WRITER D12 introduces, which is the reason this is a TILL decision and not a
    // general "SQLite apps should ANALYZE" question.
    const a = new SqliteStore({ location: file, busyTimeoutMs: 250 });
    const reader = new Database(file);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS c FROM journal_line').get();
    try {
      a.db.exec('ANALYZE');
      assert.ok(hasStat1(a.db), 'against a mere reader, ANALYZE succeeds');
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
      a.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('statistics go STALE and nothing re-derives them: a snapshot keeps describing a ledger that no longer exists', () => {
  const store = new SqliteStore();
  seed(store.db, { entries: 100 });
  store.db.exec('ANALYZE');
  const early = store.db
    .prepare("SELECT stat FROM sqlite_stat1 WHERE tbl = 'journal_line' AND idx = 'journal_line_entry'")
    .get().stat;
  assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM journal_line').get().c, 200);

  // Grow the ledger tenfold without re-analyzing, which is what a one-off ANALYZE leaves behind on a
  // book that keeps being posted to.
  const insEntry = store.db.prepare(
    `INSERT INTO journal_entry (id, workspace_id, date, ref, description, status, source, created_at)
     VALUES (?, 'ws_1', '2026-04-01', ?, ?, 'draft', 'manual', ?)`,
  );
  const insLine = store.db.prepare(
    `INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, currency, base_debit_minor, base_credit_minor)
     VALUES (?, ?, ?, ?, ?, 'CHF', ?, ?)`,
  );
  const flip = store.db.prepare("UPDATE journal_entry SET status = 'posted' WHERE id = ?");
  store.tx(() => {
    for (let e = 0; e < 900; e++) {
      const id = `entg_${e}`;
      insEntry.run(id, `G-${e}`, `Buchung ${e}`, AT);
      insLine.run(`ling_${id}_0`, id, `acc_${e % 12}`, 3000, 0, 3000, 0);
      insLine.run(`ling_${id}_1`, id, `acc_${(e + 1) % 12}`, 0, 3000, 0, 3000);
      flip.run(id);
    }
  });

  assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM journal_line').get().c, 2000, 'the ledger really did grow tenfold');
  const later = store.db
    .prepare("SELECT stat FROM sqlite_stat1 WHERE tbl = 'journal_line' AND idx = 'journal_line_entry'")
    .get().stat;
  assert.equal(later, early, 'and the statistics still describe the ledger as it was 1800 lines ago');
  assert.equal(early.split(' ')[0], '200', 'the stored row count is the OLD one, off by an order of magnitude');
  store.close();
});

// --- 3. the alternative --------------------------------------------------------------------------

test('the per-query levers reach the good plan WITHOUT statistics, deterministically and without a lock', () => {
  const store = new SqliteStore();
  const { entryIds } = seed(store.db, { entries: 400 });
  const db = store.db;

  // issueInvoice's receivable read-back. Both `entry_id` and `account_id` are indexed and neither
  // predicate is more obviously selective to a planner with no statistics, so it picks
  // journal_line_account, where journal_line_entry is three lines per entry. `INDEXED BY` settles
  // it. Measured on 10'000 entries / 30'000 lines: 193.5 us as-is, 7.2 us with the hint, and
  // 11.8 us with a full ANALYZE. The hint BEATS the statistics, which is the point.
  const asIs = `SELECT COALESCE(SUM(debit_minor), 0) AS txn, COALESCE(SUM(base_debit_minor), 0) AS base
                  FROM journal_line WHERE entry_id = ? AND account_id = ?`;
  const hinted = asIs.replace('FROM journal_line WHERE', 'FROM journal_line INDEXED BY journal_line_entry WHERE');
  assert.match(
    planOf(db, asIs, entryIds[3], 'acc_3'),
    /SEARCH journal_line USING INDEX journal_line_account/,
    'the premise: with no statistics the bare statement picks the account index',
  );
  assert.match(
    planOf(db, hinted, entryIds[3], 'acc_3'),
    /SEARCH journal_line USING INDEX journal_line_entry/,
    'INDEXED BY must move it to the entry index',
  );
  // Same question, same answer. A hint that changed the result would be a bug, not an optimisation.
  const bare = db.prepare(asIs).get(entryIds[3], 'acc_3');
  assert.deepEqual(db.prepare(hinted).get(entryIds[3], 'acc_3'), bare);
  assert.equal(bare.txn, 3000, 'and the fixture must actually have a debit there, or this proves nothing');

  // close_year's P&L sweep. With no statistics the planner drives the whole join off
  // journal_line_account as a full index scan plus a row fetch each, where even a plain table scan is
  // cheaper, and `NOT INDEXED` restores that scan.
  //
  // BOTH forms below are CONTROL ARMS, not the shipped statement, and neither is the fix. What ships
  // pins the join ORDER instead (`FROM journal_entry e CROSS JOIN journal_line l INDEXED BY
  // journal_line_entry`), which is worth more than the scan because the date fence then rejects an
  // entry BEFORE its lines are fetched: measured interleaved on 10'000 entries / 30'000 lines with
  // three years of history, 13.73 ms as-is, 8.63 ms with `NOT INDEXED`, 3.29 ms as shipped. The
  // shipped form is asserted against the COMPILED module in test/ledger/year-close-query-plan.test.mjs
  // and is deliberately not paraphrased a second time here, where the subject is the planner's
  // statistics-free behaviour rather than A03's statement.
  const sweep = `SELECT l.account_id AS account_id, SUM(l.base_debit_minor - l.base_credit_minor) AS net
                   FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
                   JOIN account a ON a.id = l.account_id
                  WHERE e.workspace_id = ? AND e.status = 'posted' AND e.source != 'close'
                    AND e.date >= ? AND e.date <= ? AND a.type IN ('income', 'expense')
                  GROUP BY l.account_id HAVING net != 0`;
  const sweepScanned = sweep.replace('FROM journal_line l JOIN', 'FROM journal_line l NOT INDEXED JOIN');
  assert.match(planOf(db, sweep, 'ws_1', '2026-01-01', '2026-12-31').split('\n')[0], /^SCAN l USING INDEX journal_line_account$/);
  assert.equal(planOf(db, sweepScanned, 'ws_1', '2026-01-01', '2026-12-31').split('\n')[0], 'SCAN l');
  const sweepRows = db.prepare(sweep).all('ws_1', '2026-01-01', '2026-12-31');
  assert.ok(sweepRows.length > 0, 'the fixture must actually have P&L movement, or this proves nothing');
  assert.deepEqual(db.prepare(sweepScanned).all('ws_1', '2026-01-01', '2026-12-31'), sweepRows);
  store.close();
});
