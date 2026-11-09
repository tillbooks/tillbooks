// `journal_line` is the ledger's hottest table and carried NO explicit index at all: only the
// implicit primary key on `id`. Every read that filters by `entry_id` (which is every read model:
// `getEntry`, the four correlated subqueries in `listJournal`, the two in `DOCUMENT_SELECT`) and
// every check that filters by `account_id` or `cost_center_id` (the usage guards behind
// Archive-XOR-Delete, and the chart's `in_use` flag) was a FULL TABLE SCAN of the largest table in
// the file, on a table that grows without bound.
//
// Measured on a 10'000-entry / 30'000-line ledger before these indexes existed: `list_journal`
// took 29.3 SECONDS, `list_documents` 1.7 s, and `list_accounts` 51.9 ms. Afterwards: 27.8 ms,
// 55.3 ms and 0.06 ms.
//
// These tests assert against SQLite itself, not against a return value: what `sqlite_master` holds,
// what `EXPLAIN QUERY PLAN` says the real statements do, and what the rows read back through the
// index actually are. A test that only checked a query still returned the right answer would pass
// just as happily against a full scan, which is the defect.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_SQL, SCHEMA_GENERATION } from '../../dist/core/store/schema.js';

const AT = '2026-07-16T00:00:00.000Z';

/** The three indexes this suite exists to hold in place, with the column each one is for. */
const EXPECTED = [
  { name: 'journal_line_account', column: 'account_id' },
  { name: 'journal_line_cost_center', column: 'cost_center_id' },
  { name: 'journal_line_entry', column: 'entry_id' },
];

/** `EXPLAIN QUERY PLAN`'s output, flattened to one string so a plan can be asserted on as text. */
function planOf(db, sql, ...params) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join('\n');
}

/**
 * Seed a database with a ledger big enough for a plan to be worth reading: 400 entries of 3 lines
 * across 12 accounts and 4 cost centres, most of them posted.
 *
 * Written through raw SQL rather than `postEntry` on purpose: this suite is about the STORAGE layer,
 * and going through the verbs would make a plan assertion depend on A02's validation rules too. The
 * lines go down while the entry is still a draft and the flip to 'posted' is the last step, because
 * `journal_line_no_insert_posted` refuses a line under an already-posted entry. The fixture cannot
 * cheat its way past the trigger, which is the point of the trigger.
 */
function seed(db, workspaceId = 'ws_1') {
  db.prepare('INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)').run(
    workspaceId,
    'Acme GmbH',
    'CHF',
    '01-01',
    AT,
  );
  const accounts = [];
  const insAccount = db.prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 12; i++) {
    const id = `acc_${i}`;
    accounts.push(id);
    insAccount.run(id, workspaceId, String(1000 + i * 10), `Konto ${i}`, i % 2 === 0 ? 'expense' : 'asset');
  }
  const costCenters = [];
  const insCostCenter = db.prepare('INSERT INTO cost_center (id, workspace_id, code, name) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 4; i++) {
    const id = `cc_${i}`;
    costCenters.push(id);
    insCostCenter.run(id, workspaceId, `K${i}`, `Kostenstelle ${i}`);
  }

  const insEntry = db.prepare(
    `INSERT INTO journal_entry (id, workspace_id, date, ref, description, status, source, created_at)
     VALUES (?, ?, ?, ?, ?, 'draft', 'manual', ?)`,
  );
  const insLine = db.prepare(
    `INSERT INTO journal_line
       (id, entry_id, account_id, cost_center_id, debit_minor, credit_minor, currency,
        base_debit_minor, base_credit_minor, fx_rate, tax_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const flip = db.prepare("UPDATE journal_entry SET status = 'posted' WHERE id = ?");

  const entryIds = [];
  for (let e = 0; e < 400; e++) {
    const entryId = `ent_${String(e).padStart(4, '0')}`;
    entryIds.push(entryId);
    insEntry.run(entryId, workspaceId, `2026-0${1 + (e % 9)}-15`, `B-${e}`, `Buchung ${e}`, AT);
    const foreign = e % 8 === 0;
    for (let l = 0; l < 3; l++) {
      insLine.run(
        `lin_${String(e).padStart(4, '0')}_${l}`,
        entryId,
        // Only the first 6 accounts and the first 2 cost centres are ever posted to, so the
        // usage guards have UNUSED ones to answer about: that is the case a scan has to read the
        // whole table for, and the case the seeded Swiss chart is mostly made of.
        accounts[(e * 3 + l) % 6],
        l === 0 ? costCenters[e % 2] : null,
        l === 0 ? 3000 : 0,
        l === 0 ? 0 : 1500,
        foreign ? 'EUR' : 'CHF',
        l === 0 ? 3000 : 0,
        l === 0 ? 0 : 1500,
        foreign ? '0.941200000000' : null,
        e % 3 === 0 ? 'U81' : null,
      );
    }
    // 5% stay draft, which is what the FX subqueries' `status = 'posted'` fence is written against.
    if (e % 20 !== 0) flip.run(entryId);
  }
  return { workspaceId, accounts, costCenters, entryIds };
}

// --- what is actually stored ---------------------------------------------------------------------

test('journal_line carries an explicit index for every column the reads filter on', () => {
  const store = new SqliteStore();
  const indexes = store.db
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'journal_line' AND sql IS NOT NULL
        ORDER BY name`,
    )
    .all();

  assert.deepEqual(
    indexes.map((i) => i.name),
    EXPECTED.map((e) => e.name),
    'journal_line must carry exactly these explicit indexes, and no more: every extra one is paid for on the money path\'s hottest insert',
  );
  for (const { name, column } of EXPECTED) {
    const columns = store.db.pragma(`index_info(${name})`).map((c) => c.name);
    assert.deepEqual(columns, [column], `${name} must index ${column} and nothing else`);
  }
  store.close();
});

test('the cost-centre index is PARTIAL: most journal lines carry no cost centre, and an index over their NULLs is write cost bought for nothing', () => {
  const store = new SqliteStore();
  const { sql } = store.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'journal_line_cost_center'")
    .get();
  assert.match(sql, /WHERE\s+cost_center_id\s+IS\s+NOT\s+NULL/i);
  store.close();
});

// --- what the planner does with them --------------------------------------------------------------

test('every real statement that filters journal_line SEARCHes it, and none of them SCANs it', () => {
  const store = new SqliteStore();
  const { workspaceId, accounts, costCenters, entryIds } = seed(store.db);
  const db = store.db;

  // Each statement is copied VERBATIM from the module named beside it. A paraphrase would let the
  // real one drift into a scan while this suite went on passing.
  const statements = [
    {
      what: 'getEntry (src/core/ledger/reads.ts)',
      sql: 'SELECT * FROM journal_line WHERE entry_id = ? ORDER BY rowid',
      params: [entryIds[7]],
      index: 'journal_line_entry',
    },
    {
      what: 'listJournal account filter (src/core/ledger/reads.ts)',
      sql: 'SELECT id FROM journal_entry WHERE id IN (SELECT entry_id FROM journal_line WHERE account_id = ?)',
      params: [accounts[0]],
      index: 'journal_line_account',
    },
    {
      what: 'listJournal total_minor subquery (src/core/ledger/reads.ts)',
      sql: `SELECT journal_entry.*,
              (SELECT COALESCE(SUM(debit_minor), 0)
                 FROM journal_line
                WHERE journal_line.entry_id = journal_entry.id) AS total_minor
         FROM journal_entry WHERE workspace_id = ?`,
      params: [workspaceId],
      index: 'journal_line_entry',
    },
    {
      what: 'DOCUMENT_SELECT total_base_minor subquery (src/core/sales/document.ts)',
      sql: `SELECT d.id, (
              SELECT SUM(jl.base_debit_minor) FROM journal_line jl WHERE jl.entry_id = d.posted_entry_id
            ) AS total_base_minor FROM document d WHERE d.workspace_id = ?`,
      params: [workspaceId],
      index: 'journal_line_entry',
    },
    {
      what: 'listAccounts in_use (src/core/accounts/accounts.ts)',
      sql: `SELECT account.*, EXISTS(SELECT 1 FROM journal_line WHERE journal_line.account_id = account.id) AS in_use
              FROM account WHERE workspace_id = ?`,
      params: [workspaceId],
      index: 'journal_line_account',
    },
    {
      what: 'deleteAccount usage guard (src/core/accounts/accounts.ts)',
      sql: 'SELECT COUNT(*) AS c FROM journal_line WHERE account_id = ?',
      params: [accounts[11]],
      index: 'journal_line_account',
    },
    {
      what: 'listCostCenters in_use (src/core/accounts/costCenters.ts)',
      sql: `SELECT cost_center.*, EXISTS(SELECT 1 FROM journal_line WHERE journal_line.cost_center_id = cost_center.id) AS in_use
              FROM cost_center WHERE workspace_id = ?`,
      params: [workspaceId],
      index: 'journal_line_cost_center',
    },
    {
      what: 'deleteCostCenter usage guard (src/core/accounts/costCenters.ts)',
      sql: 'SELECT COUNT(*) AS c FROM journal_line WHERE cost_center_id = ?',
      params: [costCenters[3]],
      index: 'journal_line_cost_center',
    },
    {
      what: 'postEntry line read-back (src/core/ledger/postEntry.ts)',
      sql: 'SELECT account_id, debit_minor, credit_minor FROM journal_line WHERE entry_id = ?',
      params: [entryIds[3]],
      index: 'journal_line_entry',
    },
    {
      what: 'payment posting balance (src/core/payments/payment.ts)',
      sql: 'SELECT COALESCE(SUM(base_debit_minor),0) AS d, COUNT(*) AS n FROM journal_line WHERE entry_id = ?',
      params: [entryIds[9]],
      index: 'journal_line_entry',
    },
  ];

  for (const { what, sql, params, index } of statements) {
    const plan = planOf(db, sql, ...params);
    assert.match(plan, new RegExp(`SEARCH (journal_line|jl) USING (COVERING )?INDEX ${index}`), `${what}: expected a SEARCH via ${index}, got:\n${plan}`);
    assert.doesNotMatch(plan, /SCAN (journal_line|jl)\b/, `${what}: still scans journal_line:\n${plan}`);
  }
  store.close();
});

test('the indexes return the SAME rows a scan would: an index that answers wrongly is worse than no index', () => {
  const store = new SqliteStore();
  const { accounts, costCenters, entryIds } = seed(store.db);
  const db = store.db;

  const viaIndex = db.prepare('SELECT id FROM journal_line WHERE entry_id = ? ORDER BY rowid').all(entryIds[42]);
  assert.deepEqual(
    viaIndex.map((r) => r.id),
    ['lin_0042_0', 'lin_0042_1', 'lin_0042_2'],
  );

  // `+account_id` defeats the index without changing the meaning of the query, so the two rowsets
  // below are the same question answered two ways. If they ever disagree, the index is lying.
  // The premise is asserted rather than assumed: unless one plan really does SEARCH and the other
  // really does SCAN, comparing them proves nothing at all.
  assert.match(planOf(db, 'SELECT id FROM journal_line WHERE account_id = ?', accounts[0]), /SEARCH journal_line USING (COVERING )?INDEX journal_line_account/);
  assert.match(planOf(db, 'SELECT id FROM journal_line WHERE +account_id = ?', accounts[0]), /SCAN journal_line/);
  const indexed = db.prepare('SELECT id FROM journal_line WHERE account_id = ? ORDER BY id').all(accounts[0]);
  const scanned = db.prepare('SELECT id FROM journal_line WHERE +account_id = ? ORDER BY id').all(accounts[0]);
  assert.ok(indexed.length > 0, 'the fixture must actually post to this account, or this proves nothing');
  assert.deepEqual(indexed, scanned);

  assert.match(planOf(db, 'SELECT id FROM journal_line WHERE cost_center_id = ?', costCenters[0]), /SEARCH journal_line USING (COVERING )?INDEX journal_line_cost_center/);
  assert.match(planOf(db, 'SELECT id FROM journal_line WHERE +cost_center_id = ?', costCenters[0]), /SCAN journal_line/);
  const ccIndexed = db.prepare('SELECT id FROM journal_line WHERE cost_center_id = ? ORDER BY id').all(costCenters[0]);
  const ccScanned = db.prepare('SELECT id FROM journal_line WHERE +cost_center_id = ? ORDER BY id').all(costCenters[0]);
  assert.ok(ccIndexed.length > 0, 'the fixture must actually post to this cost centre, or this proves nothing');
  assert.deepEqual(ccIndexed, ccScanned);

  // And the partial index must not swallow the rows it excludes: a line with no cost centre is
  // still a line, and `SELECT *` has to find it.
  const total = db.prepare('SELECT COUNT(*) AS c FROM journal_line').get().c;
  assert.equal(total, 1200, '400 entries of 3 lines');
  const withoutCc = db.prepare('SELECT COUNT(*) AS c FROM journal_line WHERE cost_center_id IS NULL').get().c;
  assert.equal(withoutCc, 800, 'two of every three lines carry no cost centre');
  store.close();
});

// --- existing files ------------------------------------------------------------------------------

test('an EXISTING file at the current generation gains the indexes on reopen, WITHOUT a migration generation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-jl-index-'));
  const file = join(dir, 'till.db');
  try {
    // A file exactly as the store writes one today, then stripped of the indexes: this is what every
    // `~/.till/till.db` on disk looks like right now.
    const raw = new Database(file);
    raw.pragma('foreign_keys = ON');
    raw.exec(SCHEMA_SQL);
    const { accounts, entryIds } = seed(raw);
    for (const { name } of EXPECTED) raw.exec(`DROP INDEX IF EXISTS ${name}`);
    raw.pragma(`user_version = ${SCHEMA_GENERATION}`);
    const before = raw
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND tbl_name = 'journal_line' AND sql IS NOT NULL")
      .get().c;
    assert.equal(before, 0, 'the fixture must start WITHOUT the indexes, or it proves nothing');

    // The claim "no data migration is needed" made falsifiable: SCHEMA_SQL on its own, replayed by a
    // bare connection with no migration machinery anywhere near it, both CREATES and POPULATES the
    // indexes over rows that were already on disk. If this ever stopped being true, an additive
    // index really would need a generation, and this is the assertion that would say so.
    raw.exec(SCHEMA_SQL);
    assert.deepEqual(
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'journal_line' AND sql IS NOT NULL ORDER BY name")
        .all()
        .map((r) => r.name),
      EXPECTED.map((e) => e.name),
      'SCHEMA_SQL alone must create the indexes on a file that predates them',
    );
    assert.match(
      planOf(raw, 'SELECT id FROM journal_line WHERE entry_id = ?', entryIds[1]),
      /SEARCH journal_line USING (COVERING )?INDEX journal_line_entry/,
    );
    assert.deepEqual(
      raw.prepare('SELECT id FROM journal_line WHERE entry_id = ? ORDER BY rowid').all(entryIds[1]).map((r) => r.id),
      ['lin_0001_0', 'lin_0001_1', 'lin_0001_2'],
      'and must POPULATE it: an index that is present but empty would hand back nothing',
    );
    for (const { name } of EXPECTED) raw.exec(`DROP INDEX IF EXISTS ${name}`);
    raw.close();

    const store = new SqliteStore({ location: file });
    // `CREATE INDEX IF NOT EXISTS` in SCHEMA_SQL runs on every open and BUILDS the index over the
    // rows already there. That is the whole reason an additive index needs no data migration: there
    // is nothing per-row to derive, so a generation whose `apply` did nothing would be a lie in the
    // version history.
    assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION, 'an additive index must not bump the schema generation');
    const names = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'journal_line' AND sql IS NOT NULL ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.deepEqual(names, EXPECTED.map((e) => e.name));

    // Present is not the same as POPULATED. Read through it and check the rows that were already on
    // disk before the index existed come back.
    const plan = planOf(store.db, 'SELECT id FROM journal_line WHERE entry_id = ?', entryIds[11]);
    assert.match(plan, /SEARCH journal_line USING (COVERING )?INDEX journal_line_entry/, plan);
    assert.deepEqual(
      store.db.prepare('SELECT id FROM journal_line WHERE entry_id = ? ORDER BY rowid').all(entryIds[11]).map((r) => r.id),
      ['lin_0011_0', 'lin_0011_1', 'lin_0011_2'],
    );
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS c FROM journal_line WHERE account_id = ?').get(accounts[0]).c,
      store.db.prepare('SELECT COUNT(*) AS c FROM journal_line WHERE +account_id = ?').get(accounts[0]).c,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the generation-4 table REBUILD carries the new indexes across, and the immutability triggers survive it IN THE SAME OPEN', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-jl-rebuild-'));
  const file = join(dir, 'till.db');
  try {
    // A pre-generation-4 file: `journal_line.currency` still carries `DEFAULT 'CHF'`, so opening it
    // triggers `dropJournalLineCurrencyDefault`, which DROPS and rebuilds the table and replays
    // whatever `sqlite_master` said was hanging off it. SCHEMA_SQL runs FIRST on that same open, so
    // it creates the new indexes on the OLD table and the rebuild has to carry them over.
    const raw = new Database(file);
    raw.pragma('foreign_keys = ON');
    const oldShape = SCHEMA_SQL.replace(/^(\s*currency\s+TEXT\s+NOT\s+NULL),$/im, "$1 DEFAULT 'CHF',");
    assert.notEqual(oldShape, SCHEMA_SQL, 'the fixture edit must actually fire, or the old shape is never built');
    raw.exec(oldShape);
    const defaulted = raw.pragma('table_info(journal_line)').find((c) => c.name === 'currency');
    assert.equal(defaulted.dflt_value, "'CHF'", 'the fixture must actually be the OLD shape, or the rebuild never runs');
    const { accounts, entryIds } = seed(raw);
    for (const { name } of EXPECTED) raw.exec(`DROP INDEX IF EXISTS ${name}`);
    raw.pragma('user_version = 3');
    raw.close();

    const store = new SqliteStore({ location: file });
    assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION, 'the rebuild must have run');
    assert.equal(
      store.db.pragma('table_info(journal_line)').find((c) => c.name === 'currency').dflt_value,
      null,
      'the rebuild must have removed the default',
    );
    assert.deepEqual(
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'journal_line' AND sql IS NOT NULL ORDER BY name")
        .all()
        .map((r) => r.name),
      EXPECTED.map((e) => e.name),
      'the rebuild replays what sqlite_master held: the new indexes have to come back with the triggers',
    );
    assert.match(
      planOf(store.db, 'SELECT id FROM journal_line WHERE entry_id = ?', entryIds[5]),
      /SEARCH journal_line USING (COVERING )?INDEX journal_line_entry/,
    );

    // The triggers, EXERCISED rather than counted, and on THIS open. `CREATE TRIGGER IF NOT EXISTS`
    // in SCHEMA_SQL runs before migrations, so a second open would silently restore any trigger the
    // rebuild dropped and a reopening test could not fail. This is the only open where the answer
    // is real.
    const postedEntry = entryIds[5];
    assert.equal(store.db.prepare('SELECT status FROM journal_entry WHERE id = ?').get(postedEntry).status, 'posted');
    const lineId = store.db.prepare('SELECT id FROM journal_line WHERE entry_id = ? ORDER BY rowid LIMIT 1').get(postedEntry).id;

    assert.throws(
      () => store.db.prepare('UPDATE journal_line SET debit_minor = 999 WHERE id = ?').run(lineId),
      /posted_immutable/,
      'journal_line_no_update_posted',
    );
    assert.throws(
      () => store.db.prepare('DELETE FROM journal_line WHERE id = ?').run(lineId),
      /posted_immutable/,
      'journal_line_no_delete_posted',
    );
    assert.throws(
      () =>
        store.db
          .prepare(
            `INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, currency, base_debit_minor, base_credit_minor)
             VALUES ('lin_tamper', ?, ?, 100, 0, 'CHF', 100, 0)`,
          )
          .run(postedEntry, accounts[0]),
      /posted_immutable/,
      'journal_line_no_insert_posted',
    );

    // The refusals were real refusals, not swallowed errors: the rows are untouched.
    assert.equal(store.db.prepare('SELECT debit_minor FROM journal_line WHERE id = ?').get(lineId).debit_minor, 3000);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM journal_line WHERE entry_id = ?').get(postedEntry).c, 3);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
