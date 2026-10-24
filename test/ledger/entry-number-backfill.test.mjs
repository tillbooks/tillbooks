/**
 * A02 §4b.3 / §4b.4, the Belegnummer backfill (D178 point 2): a book whose posted entries have no number
 * yet, numbered ONCE by the generation-17 step, and the `journal_numbering_plan` read that inspects it.
 *
 *  (a) clean bexio refs: every migrated plain-integer ref is adopted, natives follow the highest in
 *      (date, created_at, rowid) order, a new post continues the run;
 *  (b) duplicates: a ref two migrated entries share is adopted by neither, both are numbered after the
 *      highest, the plan lists them;
 *  (c) non-numeric refs (`B-17`, `0042`, ` 7`, `7.0`, none): never adopted, numbered after the highest,
 *      listed by the plan;
 *  (d) mixed: the engine's own import postings (opening balance, bank opening, wage journal) and a native
 *      entry with an integer ref are NOT migrated, so their refs are never adopted;
 *  (e) an empty book: nothing numbered, no counter, the first post is 1;
 *  (f) re-run: the step a second time writes nothing;
 *  (g) the real generation-17 step on a generation-16 FILE book: numbered on open, every other row
 *      unchanged, idempotent on the next open; it honours a stored override (from_start);
 *  (h) the plan: a pure read whose would-assign list is exactly what the step then writes;
 *  (i) the restated engine key namespaces equal the constants they restate; the step is registered as
 *      generation 17 right after d176.
 *
 * Every book is SYNTHETIC: invented companies, refs and amounts, created from scratch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { setup } from './support.mjs';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { DATA_MIGRATIONS } from '../../dist/core/store/migrations.js';
import { ENTRY_NUMBER_SCHEMA_SQL } from '../../dist/core/ledger/entryNumberSchema.js';
import { ENGINE_IMPORT_KEY_PREFIXES } from '../../dist/core/ledger/entryNumber.js';
import { OPENING_KEY_PREFIX, postEntry, journalNumberingPlan } from '../../dist/core/ledger/index.js';
import { BANK_OPENING_KEY_PREFIX } from '../../dist/core/banking/bankAccounts.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

const G17 = DATA_MIGRATIONS.find((m) => m.generation === 17);

function must(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

/**
 * Post one balanced entry. `source` defaults to manual; a migrated entry is `source: 'import'` with the
 * old system's number in `ref`.
 */
function post(t, { date, key, source = 'manual', ref, amount = 1000 }) {
  return must(
    postEntry(t.ctx, {
      date,
      source,
      idempotencyKey: key,
      ...(ref === undefined ? {} : { ref }),
      lines: [
        { account: t.accounts['6500'], debit: amount },
        { account: t.accounts['1020'], credit: amount },
      ],
    }),
  ).entryId;
}

/**
 * Back to what this build's predecessor left: no number rows, no journal counters, no marker. The guards
 * are dropped for the wipe and re-created from their own DDL, exactly as a generation-16 book never had them.
 */
function unnumber(db) {
  for (const trig of ['journal_entry_number_no_delete', 'journal_number_seq_no_delete', 'journal_number_withheld_no_delete']) db.exec(`DROP TRIGGER IF EXISTS ${trig}`);
  db.exec("DELETE FROM journal_entry_number; DELETE FROM document_number_seq WHERE type = 'journal'; DELETE FROM journal_numbering_pending; DELETE FROM journal_number_withheld;");
  db.exec(ENTRY_NUMBER_SCHEMA_SQL);
}

const numbersOf = (db, workspaceId = 'ws_1') =>
  Object.fromEntries(
    db
      .prepare('SELECT entry_id, display, origin FROM journal_entry_number WHERE workspace_id = ?')
      .all(workspaceId)
      .map((r) => [r.entry_id, `${r.display}${r.origin === 'adopted' ? '*' : ''}`]),
  );

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
}
function everyRow(db) {
  return Object.fromEntries(tables(db).map((n) => [n, db.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all()]));
}

test('(a) clean bexio refs: adopted as they are, natives after the highest in date order, a new post continues', () => {
  const t = setup();
  // Migrated in a shuffled order: the adoption reads the ref, not the posting order.
  const m3 = post(t, { date: '2026-01-20', key: 'm3', source: 'import', ref: '3' });
  const m1 = post(t, { date: '2026-01-05', key: 'm1', source: 'import', ref: '1' });
  const m2 = post(t, { date: '2026-01-10', key: 'm2', source: 'import', ref: '2' });
  const nMar = post(t, { date: '2026-03-01', key: 'n-mar' });
  const nJan = post(t, { date: '2026-01-02', key: 'n-jan' });
  const m4 = post(t, { date: '2026-02-01', key: 'm4', source: 'import', ref: '4' });
  unnumber(t.store.db);

  G17.apply(t.store.db);
  assert.deepEqual(numbersOf(t.store.db), {
    [m1]: '1*',
    [m2]: '2*',
    [m3]: '3*',
    [m4]: '4*',
    [nJan]: '5', // a native dated BEFORE the migrated ones still follows the highest adopted number
    [nMar]: '6',
  });
  const next = post(t, { date: '2025-12-31', key: 'new' });
  assert.equal(numbersOf(t.store.db)[next], '7');

  const plan = must(journalNumberingPlan(t.ctx));
  assert.equal(plan.migrated.entries, 4);
  assert.equal(plan.migrated.plainIntegerRefs, 4);
  assert.equal(plan.migrated.highestMigratedNumber, 4);
  assert.deepEqual(plan.migrated.duplicates, []);
  assert.deepEqual(plan.migrated.nonNumeric, []);
  assert.deepEqual(plan.counts, { posted: 7, numbered: 7, unnumbered: 0, adopted: 4 });
  assert.deepEqual(plan.series, [{ series: 'all', nextNumber: 8, highest: 7, numbered: 7 }]);
  assert.deepEqual(plan.wouldAssign, []);
});

test('(b) duplicates: a shared ref is adopted by neither, both follow the highest, the plan lists them', () => {
  const t = setup();
  const one = post(t, { date: '2026-01-01', key: 'one', source: 'import', ref: '1' });
  const twoA = post(t, { date: '2026-01-02', key: 'two-a', source: 'import', ref: '2' });
  const twoB = post(t, { date: '2026-01-03', key: 'two-b', source: 'import', ref: '2' });
  const three = post(t, { date: '2026-01-04', key: 'three', source: 'import', ref: '3' });
  // A native booking, so the backfill's batch is not imports alone (rule a would keep those waiting).
  const native = post(t, { date: '2026-12-31', key: 'native' });
  unnumber(t.store.db);

  const dry = must(journalNumberingPlan(t.ctx));
  assert.deepEqual(dry.migrated.duplicates, [{ ref: 2, reason: 'conflict', entryIds: [twoA, twoB], keptBy: null }]);
  assert.equal(dry.migrated.duplicatesTotal, 1);

  G17.apply(t.store.db);
  assert.deepEqual(numbersOf(t.store.db), { [one]: '1*', [three]: '3*', [twoA]: '4', [twoB]: '5', [native]: '6' });
  // Their original refs are untouched.
  assert.deepEqual(
    t.store.db.prepare('SELECT ref FROM journal_entry WHERE id IN (?, ?) ORDER BY date').all(twoA, twoB).map((r) => r.ref),
    ['2', '2'],
  );
});

test('(c) non-numeric refs are never adopted: numbered after the highest, kept in ref, listed by the plan', () => {
  const t = setup();
  const nine = post(t, { date: '2026-01-09', key: 'nine', source: 'import', ref: '9' });
  const odd = [
    post(t, { date: '2026-01-01', key: 'b17', source: 'import', ref: 'B-17' }),
    post(t, { date: '2026-01-02', key: 'lead', source: 'import', ref: '0042' }),
    post(t, { date: '2026-01-03', key: 'space', source: 'import', ref: ' 7' }),
    post(t, { date: '2026-01-04', key: 'dec', source: 'import', ref: '7.0' }),
    post(t, { date: '2026-01-05', key: 'none', source: 'import' }),
  ];
  const native = post(t, { date: '2026-12-31', key: 'native' });
  unnumber(t.store.db);
  const plan = must(journalNumberingPlan(t.ctx));
  assert.deepEqual(
    plan.migrated.nonNumeric.map((x) => x.ref),
    ['B-17', '0042', ' 7', '7.0', null],
  );
  assert.equal(plan.migrated.highestMigratedNumber, 9);

  G17.apply(t.store.db);
  const numbers = numbersOf(t.store.db);
  assert.equal(numbers[nine], '9*');
  assert.deepEqual(odd.map((id) => numbers[id]), ['10', '11', '12', '13', '14']);
  assert.equal(numbers[native], '15');
});

test('(d) mixed: engine import postings and a native integer ref are not migrated; only real migrated refs are adopted', () => {
  const t = setup();
  const opening = post(t, { date: '2026-01-01', key: `${OPENING_KEY_PREFIX}:x`, source: 'import', ref: '500' });
  const bankOpening = post(t, { date: '2026-01-01', key: `${BANK_OPENING_KEY_PREFIX}:acc:y`, source: 'import', ref: '600' });
  const wage = post(t, { date: '2026-01-31', key: 'wage-2026-01:wjp', source: 'import', ref: '700' });
  t.store.db
    .prepare(
      "INSERT INTO wage_journal_posts (id, workspace_id, posted_entry_id, entry_date, line_count, actor, created_at) VALUES ('wjp_1', 'ws_1', ?, '2026-01-31', 2, 'user_1', 'x')",
    )
    .run(wage);
  const manual = post(t, { date: '2026-01-15', key: 'manual', ref: '800' });
  const m5 = post(t, { date: '2026-01-10', key: 'm5', source: 'import', ref: '5' });
  const m6 = post(t, { date: '2026-01-11', key: 'm6', source: 'import', ref: '6' });
  const dupA = post(t, { date: '2026-01-12', key: 'dup-a', source: 'import', ref: '8' });
  const dupB = post(t, { date: '2026-01-13', key: 'dup-b', source: 'import', ref: '8' });
  const word = post(t, { date: '2026-01-14', key: 'word', source: 'import', ref: 'Kasse' });
  unnumber(t.store.db);

  const plan = must(journalNumberingPlan(t.ctx));
  assert.equal(plan.migrated.entries, 5, 'the opening, the bank opening and the wage journal are TILL postings');
  assert.equal(plan.migrated.highestMigratedNumber, 8);

  G17.apply(t.store.db);
  assert.deepEqual(numbersOf(t.store.db), {
    [m5]: '5*',
    [m6]: '6*',
    // After the highest CLAIMED old number (8, contested and so withheld; critic r3 confirmation L3C-1), in
    // (date, created_at, rowid) order; created_at ties on the fixed clock.
    [opening]: plan.wouldAssign.find((a) => a.entryId === opening).display,
    [bankOpening]: plan.wouldAssign.find((a) => a.entryId === bankOpening).display,
    [dupA]: '11',
    [dupB]: '12',
    [word]: '13',
    [manual]: '14',
    [wage]: '15',
  });
  assert.deepEqual(
    new Set([numbersOf(t.store.db)[opening], numbersOf(t.store.db)[bankOpening]]),
    new Set(['9', '10']),
    'the two 1 January engine openings take 9 and 10: the withheld 8 lies below the run, read by nobody',
  );
});

test('(e) an empty book: the step numbers nothing and starts no counter; the first post is 1', () => {
  const t = setup();
  const before = everyRow(t.store.db);
  G17.apply(t.store.db);
  assert.deepEqual(everyRow(t.store.db), before);
  const plan = must(journalNumberingPlan(t.ctx));
  assert.deepEqual(plan.counts, { posted: 0, numbered: 0, unnumbered: 0, adopted: 0 });
  assert.deepEqual(plan.series, []);
  const first = post(t, { date: '2026-01-01', key: 'first' });
  assert.equal(numbersOf(t.store.db)[first], '1');
});

test('(f) re-run: the step a second time writes nothing', () => {
  const t = setup();
  post(t, { date: '2026-01-01', key: 'm1', source: 'import', ref: '1' });
  post(t, { date: '2026-01-02', key: 'n1' });
  unnumber(t.store.db);
  G17.apply(t.store.db);
  const once = everyRow(t.store.db);
  G17.apply(t.store.db);
  assert.deepEqual(everyRow(t.store.db), once);
});

test('(h) the plan is a pure read, and its would-assign list is exactly what the step then writes', () => {
  const t = setup();
  const ids = [
    post(t, { date: '2026-02-01', key: 'a', source: 'import', ref: '40' }),
    post(t, { date: '2026-01-01', key: 'b' }),
    post(t, { date: '2026-03-01', key: 'c', source: 'import', ref: 'X' }),
  ];
  unnumber(t.store.db);
  const before = everyRow(t.store.db);
  const plan = must(journalNumberingPlan(t.ctx));
  assert.deepEqual(everyRow(t.store.db), before, 'the plan wrote nothing');
  assert.equal(plan.counts.unnumbered, 3);
  assert.equal(plan.wouldAssignTotal, 3);
  G17.apply(t.store.db);
  const written = t.store.db
    .prepare('SELECT entry_id AS entryId, series, number, display, origin FROM journal_entry_number ORDER BY number')
    .all();
  assert.deepEqual(
    written,
    [...plan.wouldAssign].map(({ entryId, series, number, display, origin }) => ({ entryId, series, number, display, origin })).sort((x, y) => x.number - y.number),
  );
  assert.deepEqual(written.map((w) => w.entryId), [ids[0], ids[1], ids[2]]);
});

test('(g) the real generation-17 step: a generation-16 file book opens numbered, every other row unchanged, and idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-gen17-'));
  const file = join(dir, 'book.db');
  try {
    const AT = '2026-10-21T08:00:00.000Z';
    const store = new SqliteStore({ location: file, clock: fixedClock(AT) });
    for (const [id, name] of [['ws_a', 'Alpha GmbH'], ['ws_z', 'Zeta AG']]) {
      store.db.prepare("INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, 'CHF', '01-01', ?)").run(id, name, AT);
      store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, '6500', 'Büro', 'expense')").run(`${id}_6500`, id);
      store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, '1020', 'Bank', 'asset')").run(`${id}_1020`, id);
    }
    const ids = sequenceIdGen();
    const ctxOf = (ws) => makeContext(store, { workspaceId: ws, actor: 'user_1', clock: fixedClock(AT), ids });
    const book = (ws, date, key, source, ref) =>
      must(
        postEntry(ctxOf(ws), {
          date,
          source,
          idempotencyKey: key,
          ...(ref === undefined ? {} : { ref }),
          lines: [
            { account: `${ws}_6500`, debit: 1250 },
            { account: `${ws}_1020`, credit: 1250 },
          ],
        }),
      ).entryId;
    const a1 = book('ws_a', '2026-01-03', 'a1', 'import', '101');
    const a2 = book('ws_a', '2026-01-04', 'a2', 'import', '102');
    const a3 = book('ws_a', '2026-02-01', 'a3', 'manual');
    const z1 = book('ws_z', '2026-01-03', 'z1', 'manual', '55');
    // Zeta had chosen from_start at 100 before the upgrade (a stored D172 override the step must honour).
    store.db
      .prepare("INSERT INTO workspace_setting (workspace_id, key, value_json, updated_at, updated_by) VALUES ('ws_z', 'ledger.belegnummer_mode', '\"from_start\"', ?, 'user_1')")
      .run(AT);
    store.db
      .prepare("INSERT INTO workspace_setting (workspace_id, key, value_json, updated_at, updated_by) VALUES ('ws_z', 'ledger.belegnummer_start', '100', ?, 'user_1')")
      .run(AT);
    store.close();

    // Back to generation 16: neither table, none of the guards, no journal counter.
    const raw = new Database(file);
    for (const trig of [
      'journal_entry_number_no_update',
      'journal_entry_number_no_delete',
      'journal_entry_number_posted_only',
      'journal_number_seq_forward',
      'journal_number_seq_no_delete',
    ]) {
      raw.exec(`DROP TRIGGER IF EXISTS ${trig}`);
    }
    raw.exec('DROP TABLE journal_entry_number; DROP TABLE journal_numbering_pending; DROP TABLE journal_number_withheld;');
    raw.exec("DELETE FROM document_number_seq WHERE type = 'journal'");
    raw.pragma('user_version = 16');
    const before = everyRow(raw);
    raw.close();

    const opened = new SqliteStore({ location: file });
    const db = opened.db;
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    assert.deepEqual(numbersOf(db, 'ws_a'), { [a1]: '101*', [a2]: '102*', [a3]: '103' });
    assert.deepEqual(numbersOf(db, 'ws_z'), { [z1]: '100' }, 'from_start honoured; a manual ref is never adopted');
    const after = everyRow(db);
    for (const name of Object.keys(before)) {
      if (name === 'document_number_seq') continue;
      assert.deepEqual(after[name], before[name], `table ${name} unchanged`);
    }
    assert.deepEqual(
      after.document_number_seq.filter((r) => r.type === 'journal'),
      [
        { workspace_id: 'ws_a', type: 'journal', year: 'all', next_value: 104 },
        { workspace_id: 'ws_z', type: 'journal', year: 'all', next_value: 101 },
      ],
    );
    // The upgrade brings journal_number_withheld WITH its append-only guards (critic r3 confirmation).
    assert.deepEqual(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'journal_number_withheld' ORDER BY name")
        .all()
        .map((r) => r.name),
      ['journal_number_withheld_no_delete', 'journal_number_withheld_no_update'],
    );
    opened.close();

    const again = new SqliteStore({ location: file });
    assert.deepEqual(everyRow(again.db), after, 'the next open changes nothing');
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(j) rule a at the upgrade: a book holding only import postings keeps them waiting; its first other booking starts the run', () => {
  const t = setup();
  const ob = post(t, { date: '2026-01-01', key: `${OPENING_KEY_PREFIX}:x`, source: 'import' });
  const m7 = post(t, { date: '2026-01-07', key: 'm7', source: 'import', ref: '7' });
  unnumber(t.store.db);
  G17.apply(t.store.db);
  assert.deepEqual(numbersOf(t.store.db), {}, 'imports alone do not start the continuous run');
  assert.ok(t.store.db.prepare("SELECT 1 FROM journal_numbering_pending WHERE workspace_id = 'ws_1'").get(), 'the catch-up is owed');
  const n = post(t, { date: '2026-02-01', key: 'n' });
  assert.deepEqual(numbersOf(t.store.db), { [m7]: '7*', [ob]: '8', [n]: '9' });
});

/** The number table's shape: its columns, its named indexes and its triggers. */
function numberTableShape(db) {
  const names = (sql) => db.prepare(sql).all().map((r) => r.name);
  return {
    columns: db
      .prepare("SELECT name, type FROM pragma_table_info('journal_entry_number') ORDER BY name")
      .all()
      .map((r) => `${r.name} ${r.type}`),
    indexes: names(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'journal_entry_number' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
    ),
    triggers: names("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'journal_entry_number' ORDER BY name"),
  };
}

test('(k) a generation-17 book with a pre-release number table converges on the fresh shape when this build opens it (critic r2 L2-1)', () => {
  const AT = '2026-10-21T08:00:00.000Z';
  const fresh = new SqliteStore({ clock: fixedClock(AT) });
  const want = numberTableShape(fresh.db);
  fresh.close();
  assert.ok(want.columns.includes('voucher_ref TEXT'), 'premise: the fresh table carries voucher_ref');

  const dir = mkdtempSync(join(tmpdir(), 'e1-shape-'));
  const file = join(dir, 'book.db');
  try {
    const store = new SqliteStore({ location: file, clock: fixedClock(AT) });
    store.db.prepare("INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES ('ws_k', 'Kopie AG', 'CHF', '01-01', ?)").run(AT);
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES ('k_6500', 'ws_k', '6500', 'Büro', 'expense')").run();
    store.db.prepare("INSERT INTO account (id, workspace_id, number, name, type) VALUES ('k_1020', 'ws_k', '1020', 'Bank', 'asset')").run();
    store.close();
    // A pre-release build's table at generation 17: round 1's columns and table-level unique, round 1's
    // display index and round 2's lookup indexes and single-probe trigger.
    const raw = new Database(file);
    for (const t of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'journal_entry_number'").all()) {
      raw.exec(`DROP TRIGGER "${t.name}"`);
    }
    raw.exec(`DROP TABLE journal_entry_number;
      CREATE TABLE journal_entry_number (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id),
        entry_id TEXT NOT NULL UNIQUE REFERENCES journal_entry(id), series TEXT NOT NULL,
        number INTEGER NOT NULL CHECK (number >= 1), display TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('assigned', 'adopted')), assigned_at TEXT NOT NULL,
        UNIQUE (workspace_id, series, number));
      CREATE INDEX journal_entry_number_display ON journal_entry_number (workspace_id, display);
      CREATE INDEX journal_entry_number_by_series ON journal_entry_number (workspace_id, series, number);
      CREATE TRIGGER journal_entry_number_shared_only_by_one_voucher BEFORE INSERT ON journal_entry_number
        WHEN EXISTS (SELECT 1 FROM journal_entry_number o WHERE o.workspace_id = NEW.workspace_id AND o.display = NEW.display)
        BEGIN SELECT RAISE(ABORT, 'entry_number_taken'); END;`);
    // This build writes generation 18 (D178 point 19, E2): its additions are taken back, so the file is what a
    // generation-17 build left, and the generation-18 step runs on open as it would on a real book.
    for (const trig of ['bank_line_decision_duplicate_pending', 'bank_txn_duplicate_decision_no_update', 'bank_txn_duplicate_decision_no_delete']) raw.exec(`DROP TRIGGER IF EXISTS ${trig}`);
    raw.exec('DROP INDEX IF EXISTS bank_txn_movement');
    raw.exec('ALTER TABLE bank_statement DROP COLUMN coverage');
    raw.pragma('user_version = 17');
    assert.equal(raw.pragma('user_version', { simple: true }), 17);
    raw.close();

    const opened = new SqliteStore({ location: file, clock: fixedClock(AT) });
    try {
      assert.deepEqual(numberTableShape(opened.db), want, 'columns, indexes and triggers converge on the fresh shape');
      const ctx = makeContext(opened, { workspaceId: 'ws_k', actor: 'user_1', clock: fixedClock(AT), ids: sequenceIdGen() });
      const lines = [
        { account: 'k_6500', debit: 1000 },
        { account: 'k_1020', credit: 1000 },
      ];
      // The pieces of one split bexio voucher wait (rule a); the first native booking would make them share.
      for (const [k, amount] of [['s1', 1001], ['s2', 1002]]) {
        const piece = [
          { account: 'k_6500', debit: amount },
          { account: 'k_1020', credit: amount },
        ];
        must(postEntry(ctx, { date: '2026-01-04', source: 'import', ref: 'Bank Buchung 1 (77)', idempotencyKey: k, lines: piece }));
      }
      // The stated limit: round 1's table-level unique cannot be dropped in place, so the share fails LOUDLY
      // and the whole posting rolls back. Such a copy is discarded and taken again, never upgraded.
      let res;
      try {
        res = postEntry(ctx, { date: '2026-02-01', source: 'manual', idempotencyKey: 'native', lines });
      } catch (e) {
        res = { ok: false, thrown: String(e?.message) };
      }
      assert.equal(res.ok, false, JSON.stringify(res));
      assert.match(JSON.stringify(res), /UNIQUE constraint failed/);
      assert.equal(opened.db.prepare("SELECT COUNT(*) AS c FROM journal_entry WHERE idempotency_key = 'native'").get().c, 0);
      assert.equal(opened.db.prepare('SELECT COUNT(*) AS c FROM journal_entry_number').get().c, 0, 'nothing half written');
    } finally {
      opened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(l) a contested TOP old number lies below the run: posted and backfilled alike, the run starts above every claimed number (critic r3 confirmation L3C-1)', () => {
  const t = setup();
  const v7 = post(t, { date: '2026-01-02', key: 'v7', source: 'import', ref: 'Manuelle Buchung 1 (7)', amount: 701 });
  const a9 = post(t, { date: '2026-01-03', key: 'a9', source: 'import', ref: 'Manuelle Buchung 2 (9)', amount: 901 });
  const b9 = post(t, { date: '2026-01-04', key: 'b9', source: 'import', ref: 'Bank Buchung 3 (9)', amount: 902 });
  const native = post(t, { date: '2026-02-01', key: 'native' });
  const want = { [v7]: '7*', [a9]: '10', [b9]: '11', [native]: '12' };
  assert.deepEqual(numbersOf(t.store.db), want, 'two different vouchers claim 9, the highest: 9 is withheld and the run starts at 10');
  // The generation-17 backfill over the same book decides the same.
  unnumber(t.store.db);
  G17.apply(t.store.db);
  assert.deepEqual(numbersOf(t.store.db), want);
});

test('(i) the restated engine key namespaces equal their constants; the step is generation 17 right after d176', () => {
  assert.deepEqual([...ENGINE_IMPORT_KEY_PREFIXES].sort(), [OPENING_KEY_PREFIX, BANK_OPENING_KEY_PREFIX].sort());
  assert.ok(G17 !== undefined, 'a generation-17 step exists');
  assert.ok(G17.name.startsWith('d178-belegnummer'));
  const at = DATA_MIGRATIONS.indexOf(G17);
  assert.equal(DATA_MIGRATIONS[at - 1]?.generation, 16);
  assert.ok(SCHEMA_GENERATION >= 17);
});
