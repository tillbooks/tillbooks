// `DOCUMENT_SELECT` (src/core/sales/document.ts) carries a correlated SELF-JOIN on `document`: for
// every row it returns, it looks for the document that was converted OUT of it (GAP B's
// `target_document_id`). With no index on `source_document_id` that subquery was a full table scan
// of `document`, run once per output row, which makes `list_documents` QUADRATIC in document count.
//
// Measured, 10'000 entries / 30'000 lines, one process, arms interleaved (see the schema comment):
//
//   documents      500      1000      2000      4000
//   no index    17.0 ms   65.8 ms   248.2 ms  1524.8 ms
//   indexed      1.6 ms    3.1 ms     6.0 ms    20.6 ms
//
// These tests assert against SQLite: what `sqlite_master` holds, what `EXPLAIN QUERY PLAN` says the
// real statements do, and what rows come back through the index. A test that only checked
// `list_documents` still returned the right answer would pass just as happily against the scan,
// which is the whole defect.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_SQL, SCHEMA_GENERATION } from '../../dist/core/store/schema.js';

const AT = '2026-07-16T00:00:00.000Z';

// Copied VERBATIM from src/core/sales/document.ts. A paraphrase would let the real projection drift
// back into a scan while this suite went on passing.
const DOCUMENT_SELECT = `SELECT d.*, (
    SELECT t.id FROM document t
     WHERE t.workspace_id = d.workspace_id AND t.source_document_id = d.id
     ORDER BY t.created_at, t.rowid LIMIT 1
  ) AS target_document_id, (
    SELECT SUM(jl.base_debit_minor) FROM journal_line jl WHERE jl.entry_id = d.posted_entry_id
  ) AS total_base_minor, (
    SELECT jl.fx_rate FROM journal_line jl
     WHERE jl.entry_id = d.posted_entry_id AND jl.fx_rate IS NOT NULL LIMIT 1
  ) AS fx_rate
  FROM document d`;

const LIST_DOCUMENTS = `${DOCUMENT_SELECT} WHERE d.workspace_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`;
const GET_DOCUMENT = `${DOCUMENT_SELECT} WHERE d.workspace_id = ? AND d.id = ?`;
const CONVERT_TARGET = `${DOCUMENT_SELECT} WHERE d.workspace_id = ? AND d.source_document_id = ? AND d.type = ?`;

/** `EXPLAIN QUERY PLAN`'s output, flattened to one string so a plan can be asserted on as text. */
function planOf(db, sql, ...params) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join('\n');
}

/**
 * Seed 120 documents, every fourth of them converted out of an earlier one, plus the workspace,
 * contact and posted entry the projection's other two subqueries need.
 *
 * Written through raw SQL rather than the verbs on purpose: this suite is about the STORAGE layer,
 * and going through `saveDraft`/`convertDocument` would make a plan assertion depend on A10's state
 * machine too. The journal lines go down while the entry is a draft and the flip to 'posted' is the
 * last step, because `journal_line_no_insert_posted` refuses a line under an already-posted entry.
 */
function seed(db, workspaceId = 'ws_1') {
  db.prepare('INSERT INTO workspace (id, name, base_currency, fiscal_year_start, created_at) VALUES (?, ?, ?, ?, ?)').run(
    workspaceId,
    'Acme GmbH',
    'CHF',
    '01-01',
    AT,
  );
  db.prepare('INSERT INTO account (id, workspace_id, number, name, type) VALUES (?, ?, ?, ?, ?)').run(
    'acc_1100',
    workspaceId,
    '1100',
    'Forderungen',
    'asset',
  );
  db.prepare('INSERT INTO contact (id, workspace_id, party_role, name, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'con_1',
    workspaceId,
    'customer',
    'Kundin AG',
    AT,
  );

  const insEntry = db.prepare(
    `INSERT INTO journal_entry (id, workspace_id, date, ref, description, status, source, created_at)
     VALUES (?, ?, '2026-03-01', ?, ?, 'draft', 'invoice', ?)`,
  );
  const insLine = db.prepare(
    `INSERT INTO journal_line
       (id, entry_id, account_id, debit_minor, credit_minor, currency, base_debit_minor, base_credit_minor, fx_rate)
     VALUES (?, ?, 'acc_1100', ?, ?, ?, ?, ?, ?)`,
  );
  const flip = db.prepare("UPDATE journal_entry SET status = 'posted' WHERE id = ?");
  const entryIds = [];
  for (let e = 0; e < 30; e++) {
    const entryId = `ent_${String(e).padStart(4, '0')}`;
    entryIds.push(entryId);
    insEntry.run(entryId, workspaceId, `R-${e}`, `Rechnung ${e}`, AT);
    const foreign = e % 3 === 0;
    insLine.run(`lin_${entryId}_0`, entryId, 10810, 0, foreign ? 'EUR' : 'CHF', 10810, 0, foreign ? '0.941200000000' : null);
    insLine.run(`lin_${entryId}_1`, entryId, 0, 10810, foreign ? 'EUR' : 'CHF', 0, 10810, foreign ? '0.941200000000' : null);
    flip.run(entryId);
  }

  const insDoc = db.prepare(
    `INSERT INTO document
       (id, workspace_id, type, number, status, contact_id, currency, source_document_id, posted_entry_id,
        subtotal_minor, tax_minor, total_minor, issue_date, due_date, notes, created_at)
     VALUES (?, ?, ?, ?, ?, 'con_1', ?, ?, ?, 10000, 810, 10810, '2026-03-01', '2026-03-31', NULL, ?)`,
  );
  const TYPES = ['invoice', 'quote', 'order', 'credit_note'];
  const documentIds = [];
  const convertedPairs = [];
  for (let d = 0; d < 120; d++) {
    const id = `doc_${String(d).padStart(4, '0')}`;
    documentIds.push(id);
    // Every fourth document was converted out of one created earlier: the source is the quote, the
    // target the invoice made from it. That is the direction the self-join reads.
    const source = d > 4 && d % 4 === 0 ? `doc_${String(d - 3).padStart(4, '0')}` : null;
    if (source !== null) convertedPairs.push({ source, target: id });
    insDoc.run(
      id,
      workspaceId,
      TYPES[d % 4],
      `2026-${String(d).padStart(4, '0')}`,
      d % 5 === 0 ? 'draft' : 'issued',
      d % 9 === 0 ? 'EUR' : 'CHF',
      source,
      d % 5 === 0 ? null : entryIds[d % entryIds.length],
      `2026-01-01T00:00:${String(d % 60).padStart(2, '0')}.${String(d % 1000).padStart(3, '0')}Z`,
    );
  }
  return { workspaceId, documentIds, convertedPairs, entryIds };
}

// --- what is actually stored ---------------------------------------------------------------------

test('document carries an index on the self-join column, and A13\'s credited-lookup index, and ONLY those', () => {
  const store = new SqliteStore();
  const indexes = store.db
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'document' AND sql IS NOT NULL
        ORDER BY name`,
    )
    .all();

  assert.deepEqual(
    indexes.map((i) => i.name),
    // A13 added `document_credited` (the same partial shape as document_source, for the over-credit
    // guard, the invoice-cancel guard, the creditedDocumentId list filter and A16's netting). The
    // pinned list stays exact: every extra index is paid for on saveDraft, so a third one must be
    // argued for here.
    ['document_credited', 'document_source'],
    'document must carry exactly these two explicit indexes: every extra one is paid for on saveDraft',
  );
  assert.deepEqual(
    store.db.pragma('index_info(document_credited)').map((c) => c.name),
    ['workspace_id', 'credited_document_id'],
    'workspace_id leads (§H-TENANT), matching document_source',
  );
  assert.deepEqual(
    store.db.pragma('index_info(document_source)').map((c) => c.name),
    ['workspace_id', 'source_document_id'],
    'workspace_id leads (§H-TENANT, matching exchange_rate_resolution); the orders measured identical on reads and on writes',
  );
  store.close();
});

test('the index is PARTIAL: most documents were converted out of nothing, and indexing their NULLs is write cost bought for rows no query asks about', () => {
  const store = new SqliteStore();
  const { sql } = store.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'document_source'")
    .get();
  assert.match(sql, /WHERE\s+source_document_id\s+IS\s+NOT\s+NULL/i);
  store.close();
});

// --- what the planner does with it ----------------------------------------------------------------

test('every statement that follows source_document_id SEARCHes document, and none of them SCANs t', () => {
  const store = new SqliteStore();
  const { workspaceId, documentIds, convertedPairs } = seed(store.db);
  const db = store.db;

  const statements = [
    { what: 'listDocuments (src/core/sales/document.ts:926)', sql: LIST_DOCUMENTS, params: [workspaceId, 1000] },
    { what: 'getDocument (src/core/sales/document.ts:370)', sql: GET_DOCUMENT, params: [workspaceId, documentIds[7]] },
    {
      what: 'convert-target lookup (src/core/sales/document.ts:809)',
      sql: CONVERT_TARGET,
      params: [workspaceId, convertedPairs[0].source, 'invoice'],
    },
  ];

  for (const { what, sql, params } of statements) {
    const plan = planOf(db, sql, ...params);
    assert.match(
      plan,
      /SEARCH t USING (COVERING )?INDEX document_source/,
      `${what}: the GAP B self-join must SEARCH via document_source, got:\n${plan}`,
    );
    assert.doesNotMatch(plan, /SCAN t\b/, `${what}: still scans document for the target link:\n${plan}`);
  }

  // The convert-target lookup's OUTER query gains the index too: `source_document_id = ?` implies
  // IS NOT NULL, so a partial index is admissible for it.
  const convertPlan = planOf(db, CONVERT_TARGET, workspaceId, convertedPairs[0].source, 'invoice');
  assert.match(convertPlan, /SEARCH d USING INDEX document_source \(workspace_id=\? AND source_document_id=\?\)/, convertPlan);
  store.close();
});

test('being PARTIAL is what keeps listDocuments off the index for its tenant-only predicate, and that is the point rather than a side effect', () => {
  const store = new SqliteStore();
  const { workspaceId } = seed(store.db);
  const db = store.db;

  // TILL is one SQLite file per workspace, so `workspace_id` holds exactly ONE distinct value and
  // buys no selectivity at all. With no statistics the planner does not know that: given an
  // UNCONDITIONAL (workspace_id, source_document_id) index it drives the outer query off it, which
  // is a b-tree walk plus a row fetch to return every row a plain scan already returned. Measured,
  // that cost 3.089 ms against the partial form's 2.913 ms on 1000 documents.
  //
  // The partial index cannot be chosen there, because `WHERE d.workspace_id = ?` does not imply
  // `source_document_id IS NOT NULL`. So the outer plan is right BY CONSTRUCTION rather than by the
  // planner happening to guess well, which is the same failure mode that regressed close_year.
  const outer = planOf(db, LIST_DOCUMENTS, workspaceId, 1000).split('\n')[0];
  assert.equal(outer, 'SCAN d', `listDocuments must still scan the outer table, got: ${outer}`);

  // The premise, asserted rather than assumed: an unconditional index on the same columns really
  // does get picked for that predicate. Without this, the line above proves nothing about WHY.
  db.exec('CREATE INDEX document_source_unconditional ON document (workspace_id, source_document_id)');
  const withUnconditional = planOf(db, LIST_DOCUMENTS, workspaceId, 1000).split('\n')[0];
  assert.match(
    withUnconditional,
    /SEARCH d USING INDEX document_source_unconditional \(workspace_id=\?\)/,
    `the unconditional form must be the one that captures the outer query, got: ${withUnconditional}`,
  );
  store.close();
});

test('the index returns the SAME rows a scan would: an index that answers wrongly is worse than no index', () => {
  const store = new SqliteStore();
  const { workspaceId, convertedPairs } = seed(store.db);
  const db = store.db;

  // The same question asked two ways, so that a disagreement means the index is lying.
  //
  // `NOT INDEXED` rather than the usual `+column` trick, and the difference is worth recording:
  // unary `+` suppresses the use of an index ON THAT TERM, but SQLite still reads
  // `+source_document_id = ?` as implying `source_document_id IS NOT NULL`, so the PARTIAL index
  // stays admissible and the planner just seeks on `workspace_id` instead. The de-optimised arm
  // silently went on using the very index it was meant to avoid. `NOT INDEXED` bars the table's
  // indexes outright, which is the only form that actually produces the scan here.
  //
  // The premise is asserted, not assumed: unless one plan really SEARCHes and the other really
  // SCANs, comparing them proves nothing at all.
  const indexedSql = 'SELECT id FROM document WHERE workspace_id = ? AND source_document_id = ? ORDER BY id';
  const scannedSql = 'SELECT id FROM document NOT INDEXED WHERE workspace_id = ? AND source_document_id = ? ORDER BY id';
  assert.match(planOf(db, indexedSql, workspaceId, convertedPairs[0].source), /SEARCH document USING (COVERING )?INDEX document_source/);
  assert.match(planOf(db, scannedSql, workspaceId, convertedPairs[0].source), /SCAN document/);

  const indexed = db.prepare(indexedSql).all(workspaceId, convertedPairs[0].source);
  const scanned = db.prepare(scannedSql).all(workspaceId, convertedPairs[0].source);
  assert.ok(indexed.length > 0, 'the fixture must actually convert a document, or this proves nothing');
  assert.deepEqual(indexed, scanned);

  // And the whole projection, through the index, agrees with the fixture's own link table.
  const rows = db.prepare(LIST_DOCUMENTS).all(workspaceId, 1000);
  assert.equal(rows.length, 120, 'the fixture must return every seeded document');
  const linked = new Map(rows.filter((r) => r.target_document_id !== null).map((r) => [r.id, r.target_document_id]));
  assert.equal(linked.size, convertedPairs.length, 'every converted pair must surface as a target_document_id');
  assert.ok(convertedPairs.length >= 25, 'and there must be a meaningful number of them');
  for (const { source, target } of convertedPairs) {
    assert.equal(linked.get(source), target, `${source} must report ${target} as its conversion target`);
  }

  // The partial index must not swallow the rows it excludes: a document converted out of nothing is
  // still a document, and it must come back with a null target rather than not at all.
  const unconverted = db.prepare('SELECT COUNT(*) AS c FROM document WHERE source_document_id IS NULL').get().c;
  assert.equal(unconverted, 120 - convertedPairs.length);
  assert.equal(rows.length - linked.size, unconverted);
  store.close();
});

// --- existing files -------------------------------------------------------------------------------

test('an EXISTING file at the current generation gains the index on reopen, WITHOUT a migration generation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'till-doc-index-'));
  const file = join(dir, 'till.db');
  try {
    // A file exactly as the store writes one today, then stripped of the index: this is what every
    // `~/.till/till.db` on disk looks like right now.
    const raw = new Database(file);
    raw.pragma('foreign_keys = ON');
    raw.exec(SCHEMA_SQL);
    const { workspaceId, convertedPairs, entryIds } = seed(raw);
    raw.exec('DROP INDEX IF EXISTS document_source');
    raw.pragma(`user_version = ${SCHEMA_GENERATION}`);
    assert.equal(
      raw
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND tbl_name = 'document' AND sql IS NOT NULL")
        .get().c,
      0,
      'the fixture must start WITHOUT the index, or it proves nothing',
    );
    raw.close();

    const store = new SqliteStore({ location: file });
    // `CREATE INDEX IF NOT EXISTS` is not `CREATE TABLE IF NOT EXISTS`: on a file that lacks the
    // index it BUILDS it over the rows already on disk. That is why an additive index needs no data
    // migration, and a generation whose `apply` did nothing would be a lie in the version history.
    assert.equal(
      store.db.pragma('user_version', { simple: true }),
      SCHEMA_GENERATION,
      'an additive index must not bump the schema generation',
    );
    assert.deepEqual(
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'document' AND sql IS NOT NULL ORDER BY name")
        .all()
        .map((r) => r.name),
      // document_credited arrives on the same reopen, through ADDITIVE_INDEXES (its column is
      // additive, so it cannot live in SCHEMA_SQL).
      ['document_credited', 'document_source'],
    );

    // Present is not the same as POPULATED. Read through it and check the rows that were already on
    // disk before the index existed come back.
    const plan = planOf(store.db, LIST_DOCUMENTS, workspaceId, 1000);
    assert.match(plan, /SEARCH t USING (COVERING )?INDEX document_source/, plan);
    assert.doesNotMatch(plan, /SCAN t\b/, plan);
    const rows = store.db.prepare(LIST_DOCUMENTS).all(workspaceId, 1000);
    const linked = new Map(rows.filter((r) => r.target_document_id !== null).map((r) => [r.id, r.target_document_id]));
    assert.equal(linked.size, convertedPairs.length, 'the rebuilt index must find the pre-existing links, not an empty set');
    for (const { source, target } of convertedPairs) assert.equal(linked.get(source), target);

    // journal_line's immutability triggers, EXERCISED on THIS open rather than counted. Adding an
    // index to SCHEMA_SQL edits the same string the triggers live in, and `CREATE TRIGGER IF NOT
    // EXISTS` runs on every open, so a reopening test would silently restore a dropped trigger and
    // could not fail. This is the only open where the answer is real.
    const postedEntry = entryIds[3];
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
             VALUES ('lin_tamper', ?, 'acc_1100', 100, 0, 'CHF', 100, 0)`,
          )
          .run(postedEntry),
      /posted_immutable/,
      'journal_line_no_insert_posted',
    );

    // The refusals were real refusals, not swallowed errors: the rows are untouched.
    assert.equal(store.db.prepare('SELECT debit_minor FROM journal_line WHERE id = ?').get(lineId).debit_minor, 10810);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM journal_line WHERE entry_id = ?').get(postedEntry).c, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
