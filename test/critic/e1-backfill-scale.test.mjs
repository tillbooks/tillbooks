/**
 * CRITIC PROBES (bank-parity E1, the Belegnummer, D178 point 2). Non-author. Synthetic by construction:
 * an invented two-account chart and generated refs on a temp-file book.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 * PROBE: the generation-17 backfill on a large book. 5'000 posted entries (3'000 migrated with
 * plain-integer refs, a handful of duplicates and non-numeric refs, 2'000 native), taken back to what a
 * generation-16 build left, then opened with this build. The time is reported as a diagnostic; the
 * assertions are the backfill's contract (every posted entry numbered once, adoption, order, idempotent).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

const N_MIGRATED = 3000;
const N_NATIVE = 2000;

test('[PROBE e1-scale] generation 17 numbers a 5000-entry generation-16 book once, in order, and fast', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'e1-scale-'));
  const file = join(dir, 'book.db');
  try {
    const AT = '2026-10-21T08:00:00.000Z';
    const store = new SqliteStore({ location: file, clock: fixedClock(AT) });
    store.db.prepare("INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES ('ws_s', 'Skala GmbH', 'CHF', '01-01', ?)").run(AT);
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES ('s_6500', 'ws_s', '6500', 'Büro', 'expense')").run();
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES ('s_1020', 'ws_s', '1020', 'Bank', 'asset')").run();
    const ctx = makeContext(store, { workspaceId: 'ws_s', actor: 'user_1', clock: fixedClock(AT), ids: sequenceIdGen() });
    const lines = [
      { account: 's_6500', debit: 1000 },
      { account: 's_1020', credit: 1000 },
    ];
    const day = (i) => {
      const d = new Date(Date.UTC(2024, 0, 1) + (i % 900) * 86400000);
      return d.toISOString().slice(0, 10);
    };
    const t0 = Date.now();
    store.tx(() => {
      for (let i = 1; i <= N_MIGRATED; i += 1) {
        // refs 1..3000, except: 10 pairs share a ref (duplicates), 10 carry a non-numeric ref.
        let ref = String(i);
        if (i % 300 === 0) ref = String(i - 1); // duplicates the previous one
        if (i % 300 === 7) ref = `B-${i}`;
        const r = postEntry(ctx, { date: day(i), source: 'import', ref, idempotencyKey: `m${i}`, lines });
        assert.equal(r.ok, true);
      }
      for (let i = 1; i <= N_NATIVE; i += 1) {
        const r = postEntry(ctx, { date: day(i * 7), source: 'manual', idempotencyKey: `n${i}`, lines });
        assert.equal(r.ok, true);
      }
    });
    const seedMs = Date.now() - t0;
    store.close();

    // Back to generation 16, the author's own recipe: no number table, no guards, no journal counter.
    const raw = new Database(file);
    for (const trig of [
      'journal_entry_number_no_update',
      'journal_entry_number_no_delete',
      'journal_entry_number_posted_only',
      'journal_number_seq_forward',
      'journal_number_seq_no_delete',
    ]) raw.exec(`DROP TRIGGER IF EXISTS ${trig}`);
    raw.exec('DROP TABLE journal_entry_number; DROP TABLE journal_numbering_pending;');
    raw.exec("DELETE FROM document_number_seq WHERE type = 'journal'");
    raw.pragma('user_version = 16');
    raw.close();

    const t1 = Date.now();
    const opened = new SqliteStore({ location: file });
    const openMs = Date.now() - t1;
    t.diagnostic(`seed ${N_MIGRATED + N_NATIVE} posts: ${seedMs} ms; generation-17 open (backfill): ${openMs} ms`);
    const db = opened.db;
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    const posted = db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = 'ws_s' AND status = 'posted'").get().n;
    const numbered = db.prepare("SELECT COUNT(*) AS n FROM journal_entry_number WHERE workspace_id = 'ws_s'").get().n;
    assert.equal(numbered, posted, 'every posted entry has exactly one number');
    const adopted = db.prepare("SELECT COUNT(*) AS n FROM journal_entry_number WHERE workspace_id = 'ws_s' AND origin = 'adopted'").get().n;
    // 3000 migrated - 10 non-numeric - 20 in duplicate pairs = 2970 adopted.
    assert.equal(adopted, N_MIGRATED - 10 - 20);
    const next = db.prepare("SELECT next_value FROM document_number_seq WHERE workspace_id = 'ws_s' AND type = 'journal' AND year = 'all'").get().next_value;
    // ADAPTED by the author for critic r3 confirmation L3C-1: the run starts above the highest CLAIMED old
    // number, adopted or withheld. The highest adopted ref is 2998; 2999 is claimed by entries 2999 and 3000
    // (withheld, read by nobody), so the 30 + 2000 assigned numbers follow 2999, never take it.
    assert.equal(next, 2999 + 1 + 30 + N_NATIVE, 'the run continues after the highest claimed for 2030 assigned');
    opened.close();

    const t2 = Date.now();
    const again = new SqliteStore({ location: file });
    t.diagnostic(`second open: ${Date.now() - t2} ms`);
    assert.equal(again.db.prepare("SELECT COUNT(*) AS n FROM journal_entry_number WHERE workspace_id = 'ws_s'").get().n, numbered);
    again.close();
    assert.ok(openMs < 60000, `the backfill took ${openMs} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
