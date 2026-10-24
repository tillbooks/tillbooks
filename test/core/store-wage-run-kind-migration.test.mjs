/**
 * Generation 14 (D173, owner Q12: `wage_journal_posts.run_kind`), the D170/D172 migration test set.
 *
 *  (a) a generation-10 book WITH live data, including wage journal postings, opened on this build runs
 *      11, 12, 13 and 14 IN THAT ORDER, ends at 14, every existing posting reads run_kind 'regular' and
 *      every other row is identical. Two variants:
 *        (a1) always on: the book is written by THIS build and regressed to generation 10 by hand;
 *        (a2) the REAL generation-10 runtime: set TILL_GEN10_DIST to the `dist/` of a build of
 *             `831e4822^` (git archive + tsc, as the critics did) and that runtime writes the book.
 *             Skipped when the variable is unset (CI has no second build); its run is recorded in D173.
 *  (b) a generation-13 book runs ONLY the generation-14 step;
 *  (c) a crash inside the generation-14 step leaves the book at 13, untouched; a retry succeeds;
 *  (d) a runtime older than the book refuses it before any DDL (the guard, on the file's bytes); with
 *      TILL_GEN13_DIST set (a build of a57fe670), the REAL generation-13 runtime is run against a
 *      generation-14 book and must refuse it with the file bytes unchanged;
 *  (e) the registration: d173 is generation 14, directly after d172 and last; the column is NOT NULL,
 *      defaults to 'regular' and CHECKs the four kinds, on a fresh book and on a migrated one alike.
 *
 * Every book here is SYNTHETIC by construction (invented companies, invented amounts), created from
 * scratch in a temp directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { DATA_MIGRATIONS, D167_INPUT_CODES } from '../../dist/core/store/migrations.js';
import { getAction } from '../../dist/api/registry.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

const AT = '2026-07-20T09:00:00.000Z';
const OLD_INDEX = "CREATE UNIQUE INDEX asset_transaction_one_disposal ON asset_transaction (workspace_id, asset_id) WHERE type = 'disposal'";
const WAGE_LINES = [
  { accountNumber: '5000', debitMinor: 500000, description: 'Bruttolohn' },
  { accountNumber: '5700', debitMinor: 50000, description: 'AG-Beiträge' },
  { accountNumber: '2260', creditMinor: 550000, description: 'Nettolohn' },
];

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
}
function rowCounts(db) {
  return Object.fromEntries(tables(db).map((name) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]));
}
/** A digest of every row of every table except the named columns of the named tables. */
function contentDigest(db, skip = {}) {
  const h = createHash('sha256');
  for (const name of tables(db)) {
    h.update(name);
    for (const row of db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()) {
      for (const col of skip[name] ?? []) delete row[col];
      h.update(JSON.stringify(row));
    }
  }
  return h.digest('hex');
}
const runKindColumn = (db) => db.pragma('table_info(wage_journal_posts)').find((c) => c.name === 'run_kind');
const postings = (db) => db.prepare('SELECT id, run_kind FROM wage_journal_posts ORDER BY rowid').all();

function inTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'till-gen14-'));
  try {
    return fn(join(dir, 'book.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write a live book through a runtime's own action registry: a workspace, an ordinary entry, a contact
 * with its own terms and two wage journal postings (two months). `mod` is that runtime's modules.
 */
function writeLiveBook(file, mod) {
  const store = new mod.SqliteStore({ location: file, clock: mod.fixedClock(AT) });
  const deps = { store, clock: mod.fixedClock(AT), ids: mod.sequenceIdGen(), actor: 'studio' };
  const call = (name, input) => {
    const res = mod.getAction(name).run(deps, input);
    assert.equal(res.ok, true, `${name}: ${JSON.stringify(res)}`);
    return res;
  };
  const { workspaceId } = call('create_workspace', { name: 'Talblick Werkstatt GmbH', idempotencyKey: 'ws' });
  call('create_contact', { workspaceId, partyRole: 'customer', name: 'Seeweg Handel AG', paymentTermsDays: 20, idempotencyKey: 'ct' });
  for (const [month, key] of [['2026-06-25', 'wj-6'], ['2026-07-25', 'wj-7']]) {
    const r = call('wage_journal_post', { workspaceId, lines: WAGE_LINES, entryDate: month, confirm: true, idempotencyKey: key });
    assert.ok(typeof r.wageJournalPostId === 'string', `a posting was recorded, not drafted: ${JSON.stringify(r)}`);
  }
  store.close();
  return workspaceId;
}

const THIS_BUILD = { SqliteStore, fixedClock, sequenceIdGen, getAction };

async function loadRuntime(dist) {
  const imp = (p) => import(pathToFileURL(join(dist, p)).href);
  const [s, c, i, r] = await Promise.all([
    imp('core/store/sqlite-store.js'), imp('core/clock.js'), imp('core/ids.js'), imp('api/registry.js'),
  ]);
  return { SqliteStore: s.SqliteStore, fixedClock: c.fixedClock, sequenceIdGen: i.sequenceIdGen, getAction: r.getAction };
}

/** Turn a book this build wrote back into what an older build left behind (generation 13 or 10). */
function regress(file, toGeneration) {
  const db = new Database(file);
  db.exec('ALTER TABLE wage_journal_posts DROP COLUMN run_kind');
  if (toGeneration <= 12) {
    db.exec('DROP TABLE IF EXISTS workspace_setting_change');
    db.exec('DROP TABLE IF EXISTS workspace_setting');
  }
  if (toGeneration <= 11) {
    db.exec('DROP TRIGGER IF EXISTS asset_transaction_one_live_disposal');
    db.exec(OLD_INDEX);
  }
  if (toGeneration <= 10) {
    db.prepare(`DELETE FROM tax_code WHERE code IN (${D167_INPUT_CODES.map(() => '?').join(',')})`).run(...D167_INPUT_CODES);
  }
  db.pragma(`user_version = ${toGeneration}`);
  db.close();
}

function observingSteps(fn, { crashAt } = {}) {
  const ran = [];
  const originals = DATA_MIGRATIONS.map((m) => m.apply);
  DATA_MIGRATIONS.forEach((m, i) => {
    m.apply = (db) => {
      ran.push(m.generation);
      originals[i](db);
      if (m.generation === crashAt) throw new Error(`simulated crash inside generation ${crashAt}`);
    };
  });
  try {
    return fn(ran);
  } finally {
    DATA_MIGRATIONS.forEach((m, i) => {
      m.apply = originals[i];
    });
  }
}

function assertColumnShape(db, what) {
  const col = runKindColumn(db);
  assert.ok(col, `${what}: run_kind exists`);
  assert.equal(col.notnull, 1, `${what}: NOT NULL`);
  assert.equal(col.dflt_value, "'regular'", `${what}: defaults to 'regular'`);
  // The CHECK bites: an unknown kind cannot be stored through any path (rolled back, nothing kept).
  const p = db.prepare('SELECT * FROM wage_journal_posts LIMIT 1').get();
  if (p !== undefined) {
    db.exec('SAVEPOINT chk');
    try {
      assert.throws(
        () => db.prepare("INSERT INTO wage_journal_posts (id, workspace_id, posted_entry_id, entry_date, line_count, actor, created_at, run_kind) VALUES ('wjp_chk', ?, ?, ?, 1, 'u', 'x', 'vacation')")
          .run(p.workspace_id, p.posted_entry_id, p.entry_date),
        /CHECK constraint failed/,
        `${what}: the CHECK refuses an unknown kind`,
      );
      for (const k of ['regular', 'bonus', 'thirteenth', 'correction']) {
        db.prepare("INSERT INTO wage_journal_posts (id, workspace_id, posted_entry_id, entry_date, line_count, actor, created_at, run_kind) VALUES (?, ?, ?, ?, 1, 'u', 'x', ?)")
          .run(`wjp_ok_${k}`, p.workspace_id, p.posted_entry_id, p.entry_date, k);
      }
    } finally {
      db.exec('ROLLBACK TO chk; RELEASE chk');
    }
  }
}

/** The (a) assertions, shared by the regressed and the real generation-10 book. */
function assertUpgradeFrom10(file) {
  const raw = new Database(file);
  assert.equal(raw.pragma('user_version', { simple: true }), 10, 'the book starts at generation 10');
  assert.equal(runKindColumn(raw), undefined, 'a generation-10 book has no run_kind');
  const before = rowCounts(raw);
  assert.equal(before.wage_journal_posts, 2, 'the book carries live wage journal postings');
  const digest = contentDigest(raw);
  const ids = raw.prepare('SELECT id FROM wage_journal_posts ORDER BY rowid').all().map((p) => p.id);
  raw.close();

  observingSteps((ran) => {
    const store = new SqliteStore({ location: file });
    assert.deepEqual(ran, Array.from({ length: SCHEMA_GENERATION - 10 }, (_, i) => 11 + i), 'exactly the steps above the book, in order, in one open (14 is d173; 15 is the D175 bank rules)');
    assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION, 'ends at the build generation');
    assert.deepEqual(postings(store.db), ids.map((id) => ({ id, run_kind: 'regular' })), 'every existing posting reads regular');
    assertColumnShape(store.db, 'migrated from 10');
    const after = rowCounts(store.db);
    for (const [t, n] of Object.entries(before)) {
      // D167 seeds its four input codes only into a workspace that already holds tax codes.
      const expected = t === 'tax_code' && n > 0 ? n + D167_INPUT_CODES.length : n;
      assert.equal(after[t], expected, `${t}: no row lost or invented`);
    }
    store.close();
  });
  // Every pre-existing row is byte-identical apart from the new column and the rows D167 adds.
  const db = new Database(file);
  db.exec('ALTER TABLE wage_journal_posts DROP COLUMN run_kind');
  db.prepare(`DELETE FROM tax_code WHERE code IN (${D167_INPUT_CODES.map(() => '?').join(',')})`).run(...D167_INPUT_CODES);
  const settingsEmpty = ['workspace_setting', 'workspace_setting_change'].every((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n === 0);
  assert.ok(settingsEmpty, 'no setting was invented');
  db.exec('DROP TABLE workspace_setting_change; DROP TABLE workspace_setting;');
  assert.equal(contentDigest(db), digest, 'all other rows identical');
  db.close();
}

test('(e) d173 is generation 14, directly after d172 and last; a fresh book has the column NOT NULL, default regular, CHECKed', () => {
  assert.ok(SCHEMA_GENERATION >= 14, 'D173 moved the build to 14; D175 (bank rules) to 15');
  const gens = DATA_MIGRATIONS.map((m) => m.generation);
  assert.deepEqual([...gens].sort((a, b) => a - b), gens, 'ascending');
  assert.equal(new Set(gens).size, gens.length, 'one step per generation');
  const d172 = DATA_MIGRATIONS.findIndex((m) => m.name.startsWith('d172-workspace-settings'));
  const d173 = DATA_MIGRATIONS.findIndex((m) => m.name.startsWith('d173-wage-run-kind'));
  assert.ok(d173 !== -1, 'the generation-14 step is registered');
  assert.equal(DATA_MIGRATIONS[d173].generation, 14);
  assert.equal(d173, d172 + 1, 'd173 directly follows d172');
  assert.equal(DATA_MIGRATIONS[d173 + 1]?.generation, 15, 'd175 (generation 15, the bank rules) follows d173');
  inTemp((file) => {
    writeLiveBook(file, THIS_BUILD);
    const db = new Database(file);
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    assertColumnShape(db, 'fresh book');
    assert.deepEqual(postings(db).map((p) => p.run_kind), ['regular', 'regular']);
    db.close();
  });
});

test('(a1) a live generation-10 book (regressed by hand) runs 11, 12, 13, 14 in order and ends at 14 with every posting regular', () => {
  inTemp((file) => {
    writeLiveBook(file, THIS_BUILD);
    regress(file, 10);
    assertUpgradeFrom10(file);
  });
});

test('(a2) a book written by the REAL generation-10 runtime upgrades in one open to 14', { skip: process.env.TILL_GEN10_DIST ? false : 'set TILL_GEN10_DIST to a build of 831e4822^ dist/' }, async () => {
  const gen10 = await loadRuntime(process.env.TILL_GEN10_DIST);
  const dir = mkdtempSync(join(tmpdir(), 'till-gen14-real-'));
  try {
    const file = join(dir, 'book.db');
    writeLiveBook(file, gen10);
    assertUpgradeFrom10(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(b) a live generation-13 book runs only the generation-14 step', () => {
  inTemp((file) => {
    writeLiveBook(file, THIS_BUILD);
    regress(file, 13);
    const raw = new Database(file);
    const before = rowCounts(raw);
    const digest = contentDigest(raw);
    raw.close();
    observingSteps((ran) => {
      const store = new SqliteStore({ location: file });
      assert.deepEqual(ran, Array.from({ length: SCHEMA_GENERATION - 13 }, (_, i) => 14 + i), 'd173 and only the steps after it ran');
      assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
      assert.deepEqual(rowCounts(store.db), before, 'no row count changed');
      assert.deepEqual(postings(store.db).map((p) => p.run_kind), ['regular', 'regular']);
      store.close();
    });
    const db = new Database(file);
    assert.equal(contentDigest(db, { wage_journal_posts: ['run_kind'] }), digest, 'every pre-existing row is identical');
    db.close();
  });
});

test('(c) a crash inside the generation-14 step leaves the book at 13, untouched; a retry succeeds', () => {
  inTemp((file) => {
    writeLiveBook(file, THIS_BUILD);
    regress(file, 13);
    const raw = new Database(file);
    const digest = contentDigest(raw);
    raw.close();
    observingSteps(
      (ran) => {
        assert.throws(() => new SqliteStore({ location: file }), /simulated crash inside generation 14/);
        assert.deepEqual(ran, [14], 'the crash happened inside d173');
      },
      { crashAt: 14 },
    );
    const after = new Database(file);
    assert.equal(after.pragma('user_version', { simple: true }), 13, 'the marker stayed at 13');
    assert.equal(runKindColumn(after), undefined, 'the ALTER rolled back with the step');
    assert.equal(contentDigest(after), digest, 'every row untouched');
    after.close();
    const store = new SqliteStore({ location: file });
    assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION, 'the retry lifts the book to the build generation');
    assertColumnShape(store.db, 'after retry');
    store.close();
  });
});

test('(d) a generation-13 runtime refuses a generation-14 book before any DDL: the file is byte for byte unchanged', async () => {
  const gen13 = process.env.TILL_GEN13_DIST ? await loadRuntime(process.env.TILL_GEN13_DIST) : null;
  inTemp((file) => {
    writeLiveBook(file, THIS_BUILD);
    if (gen13 !== null) {
      const bytes = sha(file);
      assert.throws(() => new gen13.SqliteStore({ location: file }), /newer|schema_newer_than_runtime/);
      assert.equal(sha(file), bytes, 'the REAL generation-13 runtime left the book unchanged');
    }
    // This build meeting a generation-15 book is the same comparison one step up.
    const db = new Database(file);
    db.pragma(`user_version = ${SCHEMA_GENERATION + 1}`);
    db.close();
    const bytes = sha(file);
    assert.throws(() => new SqliteStore({ location: file }), /newer|schema_newer_than_runtime/);
    assert.equal(sha(file), bytes, 'the refused book is unchanged');
  });
});
