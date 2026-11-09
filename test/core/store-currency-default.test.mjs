// M-3 generation 4: `journal_line.currency` loses its `DEFAULT 'CHF'`.
//
// The default was load-bearing exactly once, when nothing supplied the column. Both statements that
// insert a journal line now state the currency explicitly: `postEntry` via `applyFx`, and `saveDraft`
// via `baseCurrencyOf(ctx)`. What the default does from here on is mask the NEXT omission. A third
// insert path that forgets the column would book a plausible franc line instead of failing, and on
// the money path a loud NOT NULL violation is worth far more than a wrong currency nobody notices.
//
// SQLite cannot drop a column default in place, so this is a table REBUILD, on the ledger's hottest
// table, under the three triggers that make posted rows immutable (§H-AUDIT). A rebuild that silently
// lost one of those would remove the guarantee the whole ledger rests on, which is a far worse
// outcome than the defect being fixed. So the assertions below are weighted accordingly: the row
// survival and the TRIGGER survival are the point, and the missing default is almost the footnote.
//
// Everything is asserted against rows and PRAGMAs read back out of SQLite, never against a return
// value, and the fixture is a REAL file on disk opened by a second connection.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_SQL, SCHEMA_GENERATION } from '../../dist/core/store/schema.js';

const AT = '2026-07-16T00:00:00.000Z';

/** The three DB-layer triggers that make a posted line immutable. Losing one is the failure mode. */
const LINE_TRIGGERS = ['journal_line_no_insert_posted', 'journal_line_no_update_posted', 'journal_line_no_delete_posted'];

/** The `CREATE TABLE ... journal_line (...)` block of a schema string. */
function journalLineBlock(schemaSql) {
  const block = /CREATE TABLE IF NOT EXISTS journal_line \([\s\S]*?\n\);/.exec(schemaSql);
  assert.ok(block, 'the schema string has no journal_line table block at all');
  return block[0];
}

/**
 * The schema as it stood BEFORE this generation: identical, except that `journal_line.currency`
 * carries the default again.
 *
 * Derived from the shipped schema rather than hand-copied, for the reason the fixtures in
 * ./store-migration.test.mjs are: a pasted copy claims to be the old schema and then drifts from it
 * in every other respect. The two assertions in the first test are what stop the derivation from
 * silently rewriting nothing.
 */
const PRE_DROP_SCHEMA = SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS journal_line \([\s\S]*?\n\);/, (block) =>
  block.replace(/^(\s*currency\s+TEXT NOT NULL),$/m, "$1 DEFAULT 'CHF',"),
);

/** The `dflt_value` SQLite reports for a column, straight off `PRAGMA table_info`. */
function columnDefault(db, table, column) {
  const col = db.prepare(`PRAGMA table_info(${table})`).all().find((c) => c.name === column);
  assert.ok(col, `${table}.${column} does not exist`);
  return col.dflt_value;
}

function triggerNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'journal_line' ORDER BY name")
    .all()
    .map((r) => r.name);
}

/** Every journal line on disk, in storage order, with the columns whose survival is being claimed. */
function linesOnDisk(db) {
  return db
    .prepare(
      `SELECT rowid AS rid, id, entry_id, account_id, debit_minor, credit_minor, currency,
              base_debit_minor, base_credit_minor, fx_rate, tax_code
         FROM journal_line ORDER BY rowid`,
    )
    .all();
}

/**
 * A REAL pre-generation-4 file: a EUR book with a posted foreign-currency entry and a draft.
 *
 * `user_version` is stamped at 3, which is what an engine one build old actually leaves behind. It
 * also ISOLATES this migration: at generation 0 the draft-currency migration would rewrite the very
 * `currency` values this suite claims survived, and a test that cannot tell which migration moved a
 * row proves nothing about either.
 *
 * One line is inserted WITHOUT naming `currency`, which is the whole point of the fixture: it only
 * succeeds because the old default is genuinely there, so it proves the file is really at the old
 * shape rather than a copy of the new one.
 */
function makeOldFile({ stampGeneration = 3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'till-currency-default-'));
  const file = join(dir, 'till.db');
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(PRE_DROP_SCHEMA);

  db.prepare(
    'INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('ws_eur', 'Nomadik GmbH', 'EUR', '01-01', AT);
  for (const [id, number, name, type] of [
    ['acc_bank', '1020', 'Bank', 'asset'],
    ['acc_buero', '6500', 'Büromaterial', 'expense'],
  ]) {
    db.prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)').run(
      id,
      'ws_eur',
      number,
      name,
      type,
    );
  }

  const entry = db.prepare(
    `INSERT INTO journal_entry (id, workspace_id, date, description, status, source, created_by, created_at)
     VALUES (?, 'ws_eur', ?, ?, 'draft', 'manual', 'user_1', ?)`,
  );
  const withCurrency = db.prepare(
    `INSERT INTO journal_line
       (id, entry_id, account_id, debit_minor, credit_minor, currency, base_debit_minor, base_credit_minor, fx_rate, tax_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Deliberately omits `currency`, which the old DEFAULT fills in. This statement is the fixture's
  // proof of age: against the new schema it violates NOT NULL and cannot run at all.
  const withoutCurrency = db.prepare(
    `INSERT INTO journal_line
       (id, entry_id, account_id, debit_minor, credit_minor, base_debit_minor, base_credit_minor)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  // A genuine foreign-currency posting in a EUR book: CHF 100.00 bought at 1.0623, booked as EUR.
  entry.run('entry_posted', '2026-03-01', 'Büromaterial in Franken', AT);
  withCurrency.run('line_p1', 'entry_posted', 'acc_buero', 10000, 0, 'CHF', 10623, 0, '1.0623', 'VST');
  withCurrency.run('line_p2', 'entry_posted', 'acc_bank', 0, 10000, 'CHF', 0, 10623, '1.0623', null);
  // The line that leans on the default. It belongs to the POSTED entry on purpose: the generation-3
  // migration is fenced to drafts, so this row's 'CHF' stays 'CHF' even on a full replay from 0, and
  // the survival claim below stays attributable to the rebuild alone.
  withoutCurrency.run('line_p3', 'entry_posted', 'acc_bank', 0, 0, 0, 0);
  // Lines go in while the entry is still 'draft' and the entry flips last, exactly as postEntry does:
  // journal_line_no_insert_posted would abort the other order, which is the trigger doing its job.
  db.prepare("UPDATE journal_entry SET status = 'posted' WHERE id = 'entry_posted'").run();

  entry.run('entry_draft', '2026-04-01', 'Entwurf', AT);
  withCurrency.run('line_d1', 'entry_draft', 'acc_buero', 5000, 0, 'EUR', 5000, 0, null, null);
  withCurrency.run('line_d2', 'entry_draft', 'acc_bank', 0, 5000, 'EUR', 0, 5000, null, null);

  db.pragma(`user_version = ${stampGeneration}`);
  const before = linesOnDisk(db);
  const oldDefault = columnDefault(db, 'journal_line', 'currency');
  db.close();
  return { dir, file, before, oldDefault };
}

test('M-3 (gen 4): the fixture really is the OLD shape, and the shipped schema really is the new one', () => {
  assert.equal(
    /currency\s+TEXT NOT NULL DEFAULT 'CHF'/.test(journalLineBlock(SCHEMA_SQL)),
    false,
    'the shipped schema still defaults journal_line.currency, so the whole point of this generation is unshipped',
  );
  assert.equal(
    /currency\s+TEXT NOT NULL DEFAULT 'CHF'/.test(journalLineBlock(PRE_DROP_SCHEMA)),
    true,
    'the derived old schema did NOT get the default back, so the fixture below is not an old file and every assertion against it is vacuous',
  );
  // The derivation must touch journal_line and nothing else: the other DEFAULT 'CHF' columns
  // (workspace.base_currency, contact.default_currency, item.currency, document.currency) are real
  // defaults with no wrong answer hiding behind them, and this generation does not touch them.
  assert.equal(
    PRE_DROP_SCHEMA.replace(journalLineBlock(PRE_DROP_SCHEMA), journalLineBlock(SCHEMA_SQL)),
    SCHEMA_SQL,
    'the derivation changed something outside the journal_line block',
  );
  assert.ok(SCHEMA_GENERATION >= 4, `SCHEMA_GENERATION is ${SCHEMA_GENERATION}: the rebuild will never run`);
});

test('M-3 (gen 4): the rebuild keeps every row, every value, and the storage order', () => {
  const { dir, file, before, oldDefault } = makeOldFile();
  try {
    assert.equal(oldDefault, "'CHF'", 'the fixture file was written without the old default in place');
    assert.equal(before.length, 5, 'the fixture wrote five lines');
    assert.equal(
      before.find((l) => l.id === 'line_p3').currency,
      'CHF',
      'the line that named no currency did not pick the old default up, so the fixture is not the old shape',
    );

    const store = new SqliteStore({ location: file });
    try {
      const after = linesOnDisk(store.db);
      // deepEqual on two empty arrays is the classic vacuous pass, so the shape is pinned first.
      assert.equal(after.length, 5, 'a row was lost in the rebuild');
      assert.deepEqual(
        after.map((l) => l.id),
        ['line_p1', 'line_p2', 'line_p3', 'line_d1', 'line_d2'],
        'the rows are not the ones the fixture wrote',
      );
      assert.deepEqual(
        after,
        before,
        'the rebuild changed a stored value: every column, every rowid and the storage order must survive verbatim, because reads.ts orders lines BY ROWID and takes the first row as the entry currency',
      );
      assert.deepEqual(
        after.map((l) => l.currency),
        ['CHF', 'CHF', 'CHF', 'EUR', 'EUR'],
        'the currencies are not what the fixture stored',
      );
      assert.equal(after[0].fx_rate, '1.0623', 'the §H-FX rate that priced the posting survived');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M-3 (gen 4): the immutability triggers survive the rebuild and still REFUSE posted writes', () => {
  const { dir, file } = makeOldFile();
  try {
    const store = new SqliteStore({ location: file });
    try {
      assert.deepEqual(triggerNames(store.db), [...LINE_TRIGGERS].sort(), 'a journal_line trigger was lost');

      // Names in sqlite_master are not the guarantee. FIRING is.
      assert.throws(
        () => store.db.prepare("UPDATE journal_line SET debit_minor = 1 WHERE id = 'line_p1'").run(),
        /posted_immutable/,
        'a posted line became updatable: the rebuild destroyed §H-AUDIT',
      );
      assert.throws(
        () => store.db.prepare("UPDATE journal_line SET currency = 'USD' WHERE id = 'line_p2'").run(),
        /posted_immutable/,
        'a posted line currency became rewritable',
      );
      assert.throws(
        () => store.db.prepare("DELETE FROM journal_line WHERE id = 'line_p1'").run(),
        /posted_immutable/,
        'a posted line became deletable',
      );
      assert.throws(
        () =>
          store.db
            .prepare(
              `INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, currency, base_debit_minor, base_credit_minor)
               VALUES ('line_smuggled', 'entry_posted', 'acc_bank', 1, 0, 'CHF', 1, 0)`,
            )
            .run(),
        /posted_immutable/,
        'a line could be added to a posted entry',
      );

      // The entry-level triggers live on journal_entry and were never dropped, but the rebuild's
      // DROP TABLE ran next to them, so they are checked too rather than assumed.
      assert.throws(
        () => store.db.prepare("UPDATE journal_entry SET description = 'x' WHERE id = 'entry_posted'").run(),
        /posted_immutable/,
        'a posted entry became updatable',
      );
      assert.throws(
        () => store.db.prepare("DELETE FROM journal_entry WHERE id = 'entry_posted'").run(),
        /posted_immutable/,
        'a posted entry became deletable',
      );

      // And the triggers are not merely refusing everything: a DRAFT line is still writable, which is
      // what makes the four refusals above evidence of a fence rather than of a broken table.
      store.db.prepare("UPDATE journal_line SET debit_minor = 5500 WHERE id = 'line_d1'").run();
      assert.equal(
        store.db.prepare("SELECT debit_minor AS d FROM journal_line WHERE id = 'line_d1'").get().d,
        5500,
        'a draft line stopped being writable, so the rebuilt table is not usable',
      );

      assert.deepEqual(
        store.db.prepare('PRAGMA foreign_key_check').all(),
        [],
        'the rebuilt table left a dangling foreign key',
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M-3 (gen 4): the default is gone, so an insert that omits the currency now FAILS', () => {
  const { dir, file } = makeOldFile();
  try {
    const store = new SqliteStore({ location: file });
    try {
      assert.equal(
        columnDefault(store.db, 'journal_line', 'currency'),
        null,
        'journal_line.currency still carries a default after the rebuild',
      );
      assert.equal(
        store.db.pragma('user_version', { simple: true }),
        SCHEMA_GENERATION,
        'the generation was not bumped, so the rebuild will run again on every open',
      );

      // The whole reason for the generation: a future writer that forgets the column must be told,
      // not quietly given francs. Written against a DRAFT entry so the immutability triggers are out
      // of the way and NOT NULL is unambiguously the thing that refuses.
      assert.throws(
        () =>
          store.db
            .prepare(
              `INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, base_debit_minor, base_credit_minor)
               VALUES ('line_silent', 'entry_draft', 'acc_bank', 100, 0, 100, 0)`,
            )
            .run(),
        /NOT NULL constraint failed: journal_line\.currency/,
        'a line with no currency was accepted: it is now silently booked in francs',
      );
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS n FROM journal_line WHERE id = 'line_silent'").get().n,
        0,
        'the refused line reached the table anyway',
      );

      // Naming the currency still works, which is what every real writer does.
      store.db
        .prepare(
          `INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, currency, base_debit_minor, base_credit_minor)
           VALUES ('line_named', 'entry_draft', 'acc_bank', 100, 0, 'USD', 92, 0)`,
        )
        .run();
      assert.equal(
        store.db.prepare("SELECT currency AS c FROM journal_line WHERE id = 'line_named'").get().c,
        'USD',
        'a line that names its currency no longer stores it',
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M-3 (gen 4): a fresh database has no default either, and refuses a line without a currency', () => {
  // What this can and cannot prove, established by mutating the schema and watching which tests
  // moved: putting `DEFAULT 'CHF'` back into SCHEMA_SQL leaves this test GREEN, because a fresh
  // store execs the schema and then runs the migrations, and generation 4 strips the default right
  // back off. So this pins the END STATE of a newly created file, which is worth pinning on its own
  // and is the shape the running engine actually has. The claim that the SHIPPED SCHEMA is already
  // correct, without leaning on a migration to fix it every single open, is the first test above,
  // and that is the one that goes red on the schema mutation.
  const store = new SqliteStore();
  try {
    assert.equal(columnDefault(store.db, 'journal_line', 'currency'), null, 'a fresh journal_line still defaults');
    assert.deepEqual(triggerNames(store.db), [...LINE_TRIGGERS].sort());
    store.db
      .prepare(
        'INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('ws_1', 'Nomadik GmbH', 'CHF', '01-01', AT);
    store.db
      .prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)')
      .run('acc_1', 'ws_1', '1020', 'Bank', 'asset');
    store.db
      .prepare(
        `INSERT INTO journal_entry (id, workspace_id, date, description, status, source, created_at)
         VALUES ('je_1', 'ws_1', '2026-05-01', 'Entwurf', 'draft', 'manual', ?)`,
      )
      .run(AT);
    assert.throws(
      () =>
        store.db
          .prepare(
            `INSERT INTO journal_line (id, entry_id, account_id, debit_minor, credit_minor, base_debit_minor, base_credit_minor)
             VALUES ('jl_1', 'je_1', 'acc_1', 100, 0, 100, 0)`,
          )
          .run(),
      /NOT NULL constraint failed: journal_line\.currency/,
    );
  } finally {
    store.close();
  }
});

test('M-3 (gen 4): replaying the rebuild from generation 0 is a no-op, not a second rebuild', () => {
  // The migrations commit in one transaction with the version bump, so a crash mid-run leaves the OLD
  // generation and the next open re-runs everything. Forcing the version back to 0 IS that crash.
  const { dir, file, before } = makeOldFile();
  try {
    const first = new SqliteStore({ location: file });
    const migrated = linesOnDisk(first.db);
    first.close();

    const crashed = new Database(file);
    crashed.pragma('user_version = 0');
    crashed.close();

    const again = new SqliteStore({ location: file });
    try {
      assert.equal(linesOnDisk(again.db).length, 5, 'the replay lost a row');
      assert.deepEqual(linesOnDisk(again.db), migrated, 'the replay changed a stored value');
      assert.deepEqual(linesOnDisk(again.db), before, 'and the two runs together still lost nothing');
      assert.equal(columnDefault(again.db, 'journal_line', 'currency'), null, 'the replay resurrected the default');
      // These two are a regression net, NOT the proof that the triggers survive, and the difference
      // was measured rather than assumed: with the trigger replay deleted from the migration, this
      // test stayed green while the trigger test above went red. The reason is the fourth guard,
      // `CREATE TRIGGER IF NOT EXISTS` in SCHEMA_SQL, which runs before the migrations on EVERY open
      // and quietly puts back anything the previous open lost. That is exactly the belt it was meant
      // to be, and it also means a second open can never be the place trigger survival is tested.
      assert.deepEqual(triggerNames(again.db), [...LINE_TRIGGERS].sort(), 'the replay lost a trigger');
      assert.throws(
        () => again.db.prepare("UPDATE journal_line SET debit_minor = 1 WHERE id = 'line_p1'").run(),
        /posted_immutable/,
        'the replay left posted rows mutable',
      );
      assert.equal(again.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    } finally {
      again.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M-3 (gen 4): an ANCIENT file at generation 0 migrates through the whole chain intact', () => {
  // The isolated fixture above stamps generation 3 so this migration can be judged alone. A real old
  // file is at 0 and runs all four in one transaction, and the one that could collide is generation 3
  // (it rewrites DRAFT line currencies). Here it has real work to do: the drafts say 'CHF' in a EUR
  // book, so this asserts the two migrations compose rather than fight.
  const { dir, file } = makeOldFile({ stampGeneration: 0 });
  try {
    const seed = new Database(file);
    seed.pragma('foreign_keys = ON');
    seed.prepare("UPDATE journal_line SET currency = 'CHF' WHERE entry_id = 'entry_draft'").run();
    seed.pragma('user_version = 0');
    seed.close();

    const store = new SqliteStore({ location: file });
    try {
      const rows = Object.fromEntries(linesOnDisk(store.db).map((l) => [l.id, l]));
      assert.equal(Object.keys(rows).length, 5, 'a row was lost migrating from generation 0');
      assert.equal(rows.line_d1.currency, 'EUR', 'generation 3 did not redenominate the drafts');
      assert.equal(rows.line_d2.currency, 'EUR', 'generation 3 did not redenominate the drafts');
      assert.equal(rows.line_p1.currency, 'CHF', 'generation 3 rewrote a POSTED line: real §H-FX history is gone');
      assert.equal(rows.line_p1.fx_rate, '1.0623', 'the posted rate survived the full chain');
      assert.equal(columnDefault(store.db, 'journal_line', 'currency'), null, 'generation 4 did not run');
      assert.deepEqual(triggerNames(store.db), [...LINE_TRIGGERS].sort());
      assert.throws(
        () => store.db.prepare("DELETE FROM journal_line WHERE id = 'line_p2'").run(),
        /posted_immutable/,
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
