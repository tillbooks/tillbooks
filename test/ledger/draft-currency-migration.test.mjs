// @ts-check
// M-3 generation 3: stored DRAFT lines are denominated in their workspace base currency.
//
// `saveDraft` stamped the literal 'CHF' on every draft line whatever the book was kept in. Fixing the
// write path leaves the already-written rows wrong, and those rows are not merely mislabelled: a
// 'CHF' row in a EUR book reads as FOREIGN to `statesConversionBasis`, so `list_journal` annotates
// the draft with a `baseCurrency` disclosure for a conversion that never happened, and keeps doing so
// until somebody re-saves that draft.
//
// This suite builds a REAL database file at the previous generation, reopens it through the store,
// and asserts against the rows. The load-bearing assertion is the FENCE: a POSTED line reading 'CHF'
// in a EUR book is an ordinary foreign-currency posting, and the migration must not touch its §H-FX
// history.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_SQL, SCHEMA_GENERATION } from '../../dist/core/store/schema.js';

const AT = '2026-07-16T00:00:00.000Z';
const DRAFT_ENTRY = 'entry_draft';
const POSTED_ENTRY = 'entry_posted';

/**
 * A real file holding a EUR-based book with two entries, written at generation 2:
 *
 *  - a DRAFT whose line says 'CHF', which is what `saveDraft` used to write everywhere;
 *  - a POSTED entry whose line also says 'CHF', with a rate stamped on it. Same literal, entirely
 *    different meaning: this one is a genuine foreign-currency posting in a EUR book, and it is the
 *    row that proves the migration is fenced rather than merely correct on the rows it aimed at.
 */
function makeStaleFile() {
  const dir = mkdtempSync(join(tmpdir(), 'till-draft-currency-'));
  const file = join(dir, 'till.db');
  const db = new Database(file);
  db.exec(SCHEMA_SQL);

  db.prepare(
    'INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('ws_eur', 'Nomadik GmbH', 'EUR', '01-01', AT);
  db.prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)').run(
    'acc_buero',
    'ws_eur',
    '6500',
    'Büromaterial',
    'expense',
  );

  const entry = db.prepare(
    `INSERT INTO journal_entry
       (id, workspace_id, date, ref, description, status, idempotency_key, source, created_by, created_at)
     VALUES (?, 'ws_eur', '2026-03-01', ?, ?, ?, ?, 'manual', 'user_1', ?)`,
  );
  const line = db.prepare(
    `INSERT INTO journal_line
       (id, entry_id, account_id, debit_minor, credit_minor, currency,
        base_debit_minor, base_credit_minor, fx_rate)
     VALUES (?, ?, 'acc_buero', ?, 0, ?, ?, 0, ?)`,
  );

  entry.run(DRAFT_ENTRY, 'B-100', 'Entwurf', 'draft', 'k-draft', AT);
  // The stale shape exactly as `saveDraft` wrote it: a literal CHF, base amounts a plain COPY of the
  // transaction amounts, and no rate behind that copy.
  line.run('line_draft', DRAFT_ENTRY, 4200, 'CHF', 4200, null);

  // Built the way `writePostedEntry` builds one, and not by choice: `journal_line_no_insert_posted`
  // refuses a line under an already-posted entry, so the rows go down while the entry is still a
  // draft and the flip to 'posted' is the last step. Worth knowing that the fixture cannot cheat its
  // way to a posted row, because it is the same trigger that guards the migration below.
  entry.run(POSTED_ENTRY, 'B-101', 'Beratung', 'draft', 'k-posted', AT);
  // A real CHF posting in a EUR book: 4200 Rappen converted at 1.05 into 4410 EUR-cents.
  line.run('line_posted', POSTED_ENTRY, 4200, 'CHF', 4410, '1.050000000000');
  db.prepare("UPDATE journal_entry SET status = 'posted' WHERE id = ?").run(POSTED_ENTRY);

  db.pragma('user_version = 2');
  db.close();
  return { dir, file };
}

const linesOf = (db) =>
  Object.fromEntries(
    db
      .prepare('SELECT id, currency, base_debit_minor, fx_rate FROM journal_line')
      .all()
      .map((r) => [r.id, r]),
  );

test('generation 3 denominates a stored draft line in the book base currency', () => {
  const { dir, file } = makeStaleFile();
  try {
    const store = new SqliteStore({ location: file });
    const rows = linesOf(store.db);

    assert.equal(rows.line_draft.currency, 'EUR', 'the draft is denominated in what the book is kept in');
    // Untouched: the copy was never wrong. Only the label was, and there is still no rate behind it.
    assert.equal(rows.line_draft.base_debit_minor, 4200);
    assert.equal(rows.line_draft.fx_rate, null);

    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the migration is fenced to drafts: a POSTED foreign line keeps its currency and its rate', () => {
  const { dir, file } = makeStaleFile();
  try {
    const store = new SqliteStore({ location: file });
    const rows = linesOf(store.db);

    // The whole reason the fence exists. This row is not stale, it is a foreign-currency posting, and
    // rewriting its currency would destroy the §H-FX trace that says what actually happened.
    assert.equal(rows.line_posted.currency, 'CHF', 'a posted foreign line is history, not a stale label');
    assert.equal(rows.line_posted.fx_rate, '1.050000000000', 'and it keeps the rate that priced it');
    assert.equal(rows.line_posted.base_debit_minor, 4410, 'and the converted figure it was booked at');

    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file is lifted to the current generation and a replay changes nothing', () => {
  const { dir, file } = makeStaleFile();
  try {
    const first = new SqliteStore({ location: file });
    assert.equal(first.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    const after = linesOf(first.db);
    // This suite once passed here against an EMPTY database, because the store was opened with the
    // wrong option name and quietly fell back to ':memory:'. Two empty objects are deepEqual, so the
    // replay assertion below held while testing nothing at all. Naming the rows makes that
    // impossible: a vacuous run now fails on this line instead of passing on the next one.
    assert.deepEqual(Object.keys(after).sort(), ['line_draft', 'line_posted']);
    first.db.close();

    // Reopening runs the version check again. "Derive, never transform" means the second pass reads
    // its own output: the `currency <> base` guard makes it a no-op rather than a fresh rewrite.
    const second = new SqliteStore({ location: file });
    assert.deepEqual(linesOf(second.db), after, 'a replay is a no-op');
    assert.equal(second.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    second.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a draft already in the base currency is left alone, so the guard is a guard', () => {
  const { dir, file } = makeStaleFile();
  try {
    // Make the draft correct BEFORE the store ever opens the file: the migration must then find
    // nothing to do rather than churn the row.
    const pre = new Database(file);
    pre.prepare('UPDATE journal_line SET currency = ? WHERE id = ?').run('EUR', 'line_draft');
    pre.close();

    const store = new SqliteStore({ location: file });
    const rows = linesOf(store.db);
    assert.equal(rows.line_draft.currency, 'EUR');
    assert.equal(rows.line_posted.currency, 'CHF');
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
