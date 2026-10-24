/**
 * A02 §4b.1, the Belegnummer at scale (critic r2 M2-2).
 *
 * The storage backstop `journal_entry_number_one_reader` runs on EVERY number insert. Round 2 wrote its
 * condition as one EXISTS with "(series AND number) OR display", which SQLite planned as a scan of every
 * number row of the workspace: a posting cost O(n), and the generation-17 backfill, a catch-up and a restore
 * cost O(n^2) (the critic measured 276 s for 20'000 entries). The condition is now two probes, each a covering
 * index seek. This suite holds that:
 *  1. the query plan of EXACTLY the two probe texts the trigger is built from is a covering-index search on
 *     the probe index, never a scan;
 *  2. the generation-17 open of a 20'000-entry book takes well under 5 s, and grows near-linearly;
 *  3. a hot-path post costs about the same on a 20'000-entry book as on a 1'000-entry one.
 *
 * Every book is SYNTHETIC: generated dates, amounts and refs on a temp-file book. The measured numbers are
 * printed as test diagnostics (`node --test` shows them) so a report can quote them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, loadavg, cpus } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { NUMBER_READER_PROBE, DISPLAY_READER_PROBE } from '../../dist/core/ledger/entryNumberSchema.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';

const AT = '2026-10-21T08:00:00.000Z';

/** A probe text as a plain query: every NEW.<column> becomes a bound parameter. */
function asQuery(probe) {
  return probe.replace(/NEW\.[a-z_]+/g, '?');
}

test('the backstop trigger is two covering-index seeks, never a workspace scan (the plan is pinned)', () => {
  const store = new SqliteStore({ clock: fixedClock(AT) });
  try {
    const plan = (probe, params) =>
      store.db
        .prepare(`EXPLAIN QUERY PLAN ${asQuery(probe)}`)
        .all(...params)
        .map((r) => r.detail);
    const byNumber = plan(NUMBER_READER_PROBE, ['ws', 'all', 1, 'adopted', 'v', 'v']);
    const byDisplay = plan(DISPLAY_READER_PROBE, ['ws', '1', 'adopted', 'v', 'v']);
    assert.deepEqual(byNumber, ['SEARCH o USING COVERING INDEX journal_entry_number_series_probe (workspace_id=? AND series=? AND number=?)']);
    assert.deepEqual(byDisplay, ['SEARCH o USING COVERING INDEX journal_entry_number_display_probe (workspace_id=? AND display=?)']);
    // And the trigger in the book is built from exactly these two texts.
    const sql = store.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'journal_entry_number_one_reader'").get().sql;
    assert.ok(sql.includes(NUMBER_READER_PROBE) && sql.includes(DISPLAY_READER_PROBE), sql);
    // The retired single-probe trigger is gone.
    assert.equal(
      store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'journal_entry_number_shared_only_by_one_voucher'").get(),
      undefined,
    );
  } finally {
    store.close();
  }
});

/**
 * A generation-16 file book holding `n` posted entries (half of them migrated with a plain-integer ref, a
 * handful in a split bexio voucher), opened by this build: the generation-17 step numbers them all. Returns
 * the open's wall time and the mean hot-path post time after it.
 */
function measure(n) {
  const dir = mkdtempSync(join(tmpdir(), 'e1-scale-'));
  const file = join(dir, 'book.db');
  try {
    const store = new SqliteStore({ location: file, clock: fixedClock(AT) });
    store.db.prepare("INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES ('ws_s', 'Skala GmbH', 'CHF', '01-01', ?)").run(AT);
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES ('s_6500', 'ws_s', '6500', 'Büro', 'expense')").run();
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES ('s_1020', 'ws_s', '1020', 'Bank', 'asset')").run();
    const insert = store.db.prepare(
      "INSERT INTO journal_entry (id, workspace_id, date, ref, status, idempotency_key, source, created_at) VALUES (?, 'ws_s', ?, ?, 'posted', ?, ?, ?)",
    );
    store.tx(() => {
      for (let i = 1; i <= n; i += 1) {
        const date = new Date(Date.UTC(2016, 0, 1) + (i % 3650) * 86400000).toISOString().slice(0, 10);
        const imported = i % 2 === 0;
        // Every 1000th migrated entry is one piece of a split bexio voucher (three pieces share a ref).
        const ref = !imported ? null : i % 1000 === 0 ? `Bank Buchung 9 (${900000 + Math.floor(i / 3000)})` : String(i);
        insert.run(`e${i}`, date, ref, `k${i}`, imported ? 'import' : 'manual', AT);
      }
    });
    store.close();
    // Back to what a generation-16 build left: no number table, no guards, no counter.
    const raw = new Database(file);
    for (const t of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (tbl_name = 'journal_entry_number' OR name LIKE 'journal_number_seq%')").all()) {
      raw.exec(`DROP TRIGGER "${t.name}"`);
    }
    raw.exec('DROP TABLE journal_entry_number; DROP TABLE journal_numbering_pending; DROP TABLE journal_number_withheld;');
    raw.exec("DELETE FROM document_number_seq WHERE type = 'journal'");
    raw.pragma('user_version = 16');
    raw.close();

    const t0 = process.hrtime.bigint();
    const opened = new SqliteStore({ location: file, clock: fixedClock(AT) });
    const openMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(opened.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    const numbered = opened.db.prepare("SELECT COUNT(*) AS c FROM journal_entry_number WHERE workspace_id = 'ws_s'").get().c;
    const ctx = makeContext(opened, { workspaceId: 'ws_s', actor: 'user_1', clock: fixedClock(AT), ids: systemIdGen });
    const lines = [
      { account: 's_6500', debit: 1000 },
      { account: 's_1020', credit: 1000 },
    ];
    const posts = 60;
    const times = [];
    for (let i = 0; i < posts; i += 1) {
      const t1 = process.hrtime.bigint();
      assert.equal(postEntry(ctx, { date: '2026-05-01', source: 'manual', idempotencyKey: `hot${i}`, lines }).ok, true);
      times.push(Number(process.hrtime.bigint() - t1) / 1e6);
    }
    times.sort((a, b) => a - b);
    const postMs = times[Math.floor(times.length / 2)];
    opened.close();
    return { n, numbered, openMs: Math.round(openMs), postMs: Math.round(postMs * 100) / 100 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('generation 17 on a 20000-entry book opens well under 5 s, grows near-linearly, and a post stays about constant', (t) => {
  const rows = [1000, 5000, 20000].map(measure);
  for (const r of rows) t.diagnostic(JSON.stringify(r));
  for (const r of rows) assert.equal(r.numbered, r.n, 'every entry was numbered by the backfill');
  const [small, mid, big] = rows;
  // 5 s on a quiet box (measured about 1.2 s). A box running other gates is slower by about its run queue
  // per core, so the budget stretches by that factor, never below 5 s: even 4x it stays two orders of
  // magnitude under the 276 s the quadratic trigger took, so the defect this guards against still fails.
  const crowding = Math.max(1, loadavg()[0] / cpus().length);
  const budget = Math.round(5000 * crowding);
  t.diagnostic(`budget ${budget} ms (load ${loadavg()[0].toFixed(1)} on ${cpus().length} cores)`);
  assert.ok(big.openMs < budget, `generation-17 open at ${big.n} entries: ${big.openMs} ms (budget ${budget} ms)`);
  // Linear growth makes 4x the entries cost about 4x; quadratic about 16x. Allow generous noise.
  const growth = big.openMs / Math.max(mid.openMs, 1);
  assert.ok(growth < 8, `x${growth.toFixed(1)} for x4 entries (${mid.openMs} ms at ${mid.n}, ${big.openMs} ms at ${big.n})`);
  // A hot-path post: index seeks only, so 20x the book costs about the same (median of 60 posts).
  assert.ok(big.postMs < Math.max(4 * small.postMs, 5), `a post costs ${big.postMs} ms at ${big.n} entries, ${small.postMs} ms at ${small.n}`);
});
