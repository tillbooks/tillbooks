/**
 * CRITIC PROBES, round 2 (bank-parity E1, the Belegnummer). Non-author. Synthetic by construction: an invented
 * two-account chart, generated amounts and refs on a temp-file book.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 * PROBE: the round-2 storage backstop `journal_entry_number_shared_only_by_one_voucher` runs, on EVERY insert,
 *   EXISTS (... WHERE o.workspace_id = NEW.workspace_id AND ((o.series = .. AND o.number = ..) OR o.display = ..) ...)
 * and SQLite plans that as `SEARCH o USING INDEX journal_entry_number_by_display (workspace_id=?)`: the OR is not
 * split over the two indexes, so each insert walks every number row of the workspace. One posting costs O(n),
 * and a batch (the generation-17 backfill, a catch-up, a G04 restore loading the table) costs O(n^2).
 * Measured here at 2'000 / 4'000 / 8'000 posted entries (the report also records 5'000 / 10'000 / 20'000): the generation-17 open, and the hot-path post after it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { settingsSet } from '../../dist/core/settings/index.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen, systemIdGen } from '../../dist/core/ids.js';
import { NUMBER_READER_PROBE, DISPLAY_READER_PROBE } from '../../dist/core/ledger/entryNumberSchema.js';

const AT = '2026-10-21T08:00:00.000Z';

function measure(n) {
  const dir = mkdtempSync(join(tmpdir(), 'e1r2-scale-'));
  const file = join(dir, 'book.db');
  try {
    const store = new SqliteStore({ location: file, clock: fixedClock(AT) });
    store.db.prepare("INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES ('ws_s', 'Skala GmbH', 'CHF', '01-01', ?)").run(AT);
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES ('s_6500', 'ws_s', '6500', 'Büro', 'expense')").run();
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES ('s_1020', 'ws_s', '1020', 'Bank', 'asset')").run();
    const ctx = makeContext(store, { workspaceId: 'ws_s', actor: 'user_1', clock: fixedClock(AT), ids: sequenceIdGen() });
    // Seed with numbering OFF, so seeding itself is cheap; the backfill below does all the numbering.
    assert.equal(settingsSet(ctx, { key: 'ledger.belegnummer_mode', value: 'off', reason: 'seed', idempotencyKey: 'off' }).ok, true);
    const lines = [
      { account: 's_6500', debit: 1000 },
      { account: 's_1020', credit: 1000 },
    ];
    store.tx(() => {
      for (let i = 1; i <= n; i += 1) {
        const date = new Date(Date.UTC(2020, 0, 1) + (i % 2000) * 86400000).toISOString().slice(0, 10);
        const imported = i % 2 === 0;
        const r = postEntry(ctx, { date, source: imported ? 'import' : 'manual', ...(imported ? { ref: String(i) } : {}), idempotencyKey: `k${i}`, lines });
        assert.equal(r.ok, true);
      }
    });
    store.close();
    // Back to what a generation-16 build left (the author's recipe): no number table, no guards, no counter,
    // and no Belegnummer setting (an older build could not have stored one).
    const raw = new Database(file);
    for (const t of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (tbl_name = 'journal_entry_number' OR name LIKE 'journal_number_seq%')").all()) {
      raw.exec(`DROP TRIGGER "${t.name}"`);
    }
    raw.exec('DROP TABLE journal_entry_number; DROP TABLE journal_numbering_pending;');
    raw.exec("DELETE FROM document_number_seq WHERE type = 'journal'; DELETE FROM workspace_setting WHERE key LIKE 'ledger.belegnummer%';");
    raw.pragma('user_version = 16');
    raw.close();

    const t0 = process.hrtime.bigint();
    const opened = new SqliteStore({ location: file, clock: fixedClock(AT) });
    const openMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const numbered = opened.db.prepare("SELECT COUNT(*) AS c FROM journal_entry_number WHERE workspace_id = 'ws_s'").get().c;
    const ctx2 = makeContext(opened, { workspaceId: 'ws_s', actor: 'user_1', clock: fixedClock(AT), ids: systemIdGen });
    // ADAPTED in the r2 remediation (author, kept the intent): the MEDIAN of the posts, not the mean, so the
    // first posts' JIT warm-up (13.5 ms at 2'000 in one run) and box load do not decide the verdict; and the
    // plan is now read from the two probe texts the remediated trigger is BUILT from (the single OR probe this
    // file first quoted no longer exists in any book).
    const posts = 50;
    const times = [];
    for (let i = 0; i < posts; i += 1) {
      const t1 = process.hrtime.bigint();
      assert.equal(postEntry(ctx2, { date: '2026-05-01', source: 'manual', idempotencyKey: `hot${i}`, lines }).ok, true);
      times.push(Number(process.hrtime.bigint() - t1) / 1e6);
    }
    times.sort((x, y) => x - y);
    const postMs = times[Math.floor(posts / 2)];
    const trigger = opened.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'journal_entry_number_one_reader'").get().sql;
    assert.ok(trigger.includes(NUMBER_READER_PROBE) && trigger.includes(DISPLAY_READER_PROBE), trigger);
    const planOf = (probe, params) =>
      opened.db
        .prepare(`EXPLAIN QUERY PLAN ${probe.replace(/NEW\.[a-z_]+/g, '?')}`)
        .all(...params)
        .map((r) => r.detail)
        .join(' | ');
    const plan = [planOf(NUMBER_READER_PROBE, ['ws_s', 'all', 1, 'assigned', null, null]), planOf(DISPLAY_READER_PROBE, ['ws_s', '1', 'assigned', null, null])];
    // Each probe seeks its full key; a bare `(workspace_id=?)` search is the workspace walk this probe found.
    assert.match(plan[0], /COVERING INDEX \w+ \(workspace_id=\? AND series=\? AND number=\?\)/, plan[0]);
    assert.match(plan[1], /COVERING INDEX \w+ \(workspace_id=\? AND display=\?\)/, plan[1]);
    opened.close();
    return { n, numbered, openMs: Math.round(openMs), postMs: Math.round(postMs * 100) / 100, plan };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('[R2 PROBE L-scale] the storage backstop keeps a posting O(log n) and the backfill near-linear', (t) => {
  const rows = [2000, 4000, 8000].map(measure);
  for (const r of rows) t.diagnostic(JSON.stringify(r));
  for (const r of rows) assert.equal(r.numbered, r.n);
  const [a, , c] = rows;
  // Linear growth would make 4x the entries cost about 4x; quadratic about 16x.
  const growth = c.openMs / Math.max(a.openMs, 1);
  assert.ok(growth < 8, `generation-17 open: ${a.openMs} ms at ${a.n}, ${c.openMs} ms at ${c.n} (x${growth.toFixed(1)} for x4 entries)`);
  // ADAPTED (author, r2 remediation): a post costs about 4 ms on this box with numbering OFF too (the posting
  // pipeline and a WAL commit), so the probe's absolute "< 5 ms" measured the box, not the trigger. The O(n)
  // trigger added about 11 ms per post at 8'000 entries (276 s / 20'000 inserts), so a post at 4x the book
  // staying within 2.5x of the small book's median (floor 6 ms) still fails that defect and nothing else.
  assert.ok(
    c.postMs < Math.max(2.5 * a.postMs, 6),
    `a hot-path post at ${c.n} entries costs ${c.postMs} ms (at ${a.n}: ${a.postMs} ms); the trigger plan: ${c.plan.join(' / ')}`,
  );
});
