/**
 * CRITIC PROBES, round 2 (bank-parity E1, the Belegnummer). Non-author. Synthetic by construction.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 * PROBE: round 2 changed the SHAPE of `journal_entry_number` (a `voucher_ref` column, the table-level
 * `UNIQUE (workspace_id, series, number)` replaced by partial unique indexes) under the SAME schema generation
 * 17, and `ENTRY_NUMBER_SCHEMA_SQL` is `CREATE TABLE IF NOT EXISTS`. A book a round-1 build already opened
 * (generation 17, the round-1 table, for example the owner's dry-run copy D178 point 18 names) therefore keeps
 * the round-1 table when this build opens it, and every posting then has to write a column that is not there.
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

/** The table exactly as the round-1 build (`83961055`) created it. */
const ROUND1_TABLE = `
CREATE TABLE journal_entry_number (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  entry_id     TEXT NOT NULL UNIQUE REFERENCES journal_entry(id),
  series       TEXT NOT NULL,
  number       INTEGER NOT NULL CHECK (number >= 1),
  display      TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('assigned', 'adopted')),
  assigned_at  TEXT NOT NULL,
  UNIQUE (workspace_id, series, number)
);
CREATE INDEX journal_entry_number_display ON journal_entry_number (workspace_id, display);`;

test('[R2 PROBE L-shape] a generation-17 book with the round-1 number table still posts under this build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e1r2-shape-'));
  const file = join(dir, 'book.db');
  try {
    const AT = '2026-10-21T08:00:00.000Z';
    const store = new SqliteStore({ location: file, clock: fixedClock(AT) });
    store.db.prepare("INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES ('ws_r', 'Runde GmbH', 'CHF', '01-01', ?)").run(AT);
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES ('r_6500', 'ws_r', '6500', 'Büro', 'expense')").run();
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES ('r_1020', 'ws_r', '1020', 'Bank', 'asset')").run();
    store.close();

    // What a round-1 build left at generation 17: its own table (empty here), none of round 2's indexes.
    const raw = new Database(file);
    for (const t of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'journal_entry_number'").all()) {
      raw.exec(`DROP TRIGGER "${t.name}"`);
    }
    raw.exec('DROP TABLE journal_entry_number;');
    raw.exec(ROUND1_TABLE);
    // This build writes generation 18 (D178 point 19, E2): its additions are taken back, so the file is what a
    // generation-17 build left, and the generation-18 step runs on open as it would on a real book.
    for (const trig of ['bank_line_decision_duplicate_pending', 'bank_txn_duplicate_decision_no_update', 'bank_txn_duplicate_decision_no_delete']) raw.exec(`DROP TRIGGER IF EXISTS ${trig}`);
    raw.exec('DROP INDEX IF EXISTS bank_txn_movement');
    raw.exec('ALTER TABLE bank_statement DROP COLUMN coverage');
    raw.pragma('user_version = 17');
    assert.equal(raw.pragma('user_version', { simple: true }), 17);
    raw.close();

    const opened = new SqliteStore({ location: file, clock: fixedClock(AT) });
    assert.equal(opened.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    const cols = opened.db.prepare("SELECT name FROM pragma_table_info('journal_entry_number')").all().map((r) => r.name);
    const ctx = makeContext(opened, { workspaceId: 'ws_r', actor: 'user_1', clock: fixedClock(AT), ids: sequenceIdGen() });
    let res;
    try {
      res = postEntry(ctx, { date: '2026-03-01', source: 'manual', idempotencyKey: 'p1', lines: [
        { account: 'r_6500', debit: 1000 },
        { account: 'r_1020', credit: 1000 },
      ] });
    } catch (e) {
      res = { ok: false, thrown: String(e && e.message) };
    }
    opened.close();
    assert.ok(cols.includes('voucher_ref'), `the table this build writes lacks voucher_ref (columns: ${cols.join(', ')}); a post answered ${JSON.stringify(res)}`);
    assert.equal(res.ok, true, JSON.stringify(res));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
