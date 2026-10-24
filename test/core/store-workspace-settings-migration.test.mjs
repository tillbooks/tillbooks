/**
 * Generation 13 (D172, the workspace settings registry), the D170 migration test set applied to it.
 *
 *  (a) a real-shape generation-10 book WITH live data (ordinary entries, a contact with its own terms, a
 *      bank statement and a bank standard, assets with a posted depreciation run and a disposal) opened on
 *      this build runs 11, 12, 13 (and every later step) IN THAT ORDER, ends at the build generation with
 *      every row intact and the two settings
 *      tables present;
 *  (b) a generation-12 book with live data runs the generation-13 step and nothing below it;
 *  (c) a crash inside the generation-13 step leaves the book at 12, byte for byte untouched, and a retry
 *      succeeds;
 *  (d) a runtime that knows only an older generation refuses a newer book before any DDL (the guard,
 *      asserted on the file's bytes; the real generation-12 runtime built from 576c82d9 was run against a
 *      generation-13 book by hand and refused it, recorded in D172);
 *  (e) the registration: d172 is generation 13, registered directly after d170, so dropping the step or
 *      swapping it out of order fails here.
 *
 * Step ORDER is observed by wrapping each registered step's `apply` in this process (the store imports
 * the same `DATA_MIGRATIONS` objects), because the schema pass creates the settings tables on every open
 * BEFORE any data step, so table presence alone cannot show which steps ran.
 *
 * Since generation 14 (D173, `wage_journal_posts.run_kind`) the build runs one step further; these
 * tests keep asserting the generation-13 step itself and expect 14 to follow it
 * (`store-wage-run-kind-migration.test.mjs` owns generation 14).
 *
 * Every book here is SYNTHETIC by construction (invented companies, invented amounts, published sample
 * IBANs), created from scratch in a temp directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { DATA_MIGRATIONS, D167_INPUT_CODES } from '../../dist/core/store/migrations.js';
import { newerGenerationRefusal } from '../../dist/core/store/generation.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { setBankStandard } from '../../dist/core/banking/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import {
  createAssetCategory,
  createAsset,
  assetAcquire,
  assetDepreciationRunCreate,
  assetDepreciationRunPost,
  assetDispose,
} from '../../dist/core/assets/index.js';
import { world, importLines, must, excuseClaimInvariant, TELCO_IBAN } from '../banking/bank-inbox-support.mjs';

const SETTINGS_OBJECTS = ['workspace_setting', 'workspace_setting_change', 'workspace_setting_change_no_update', 'workspace_setting_change_no_delete'];
const OLD_INDEX = "CREATE UNIQUE INDEX asset_transaction_one_disposal ON asset_transaction (workspace_id, asset_id) WHERE type = 'disposal'";

const settingsObjects = (db) =>
  db.prepare(`SELECT name FROM sqlite_master WHERE name IN (${SETTINGS_OBJECTS.map(() => '?').join(',')}) ORDER BY name`).all(...SETTINGS_OBJECTS).map((r) => r.name);

/** Every user table's row count, so "no data lost" covers the whole book, not a chosen few tables. */
function rowCounts(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]));
}

/** A digest of every row of every table, so (c) can say "untouched" about content, not only counts. */
function contentDigest(db) {
  const h = createHash('sha256');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name } of tables) {
    h.update(name);
    for (const row of db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()) h.update(JSON.stringify(row));
  }
  return h.digest('hex');
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** A live book on disk: an entry, a contact with terms, a bank statement and standard, assets, a run, a disposal. */
function liveBook(file) {
  const t = world({ location: file, realPeriods: true });
  const { ctx, acc } = t;
  must(postEntry(ctx, { date: '2026-07-02', source: 'manual', description: 'Büromaterial bar', idempotencyKey: 'je-1', lines: [{ account: acc('6500'), debit: 4500 }, { account: acc('1000'), credit: 4500 }] }), 'postEntry');
  must(createContact(ctx, { partyRole: 'customer', name: 'Bergsicht Beratung AG', paymentTermsDays: 20, idempotencyKey: 'ct-1' }), 'contact');
  const lines = importLines(t, { statementId: 'BS-G13', entries: [{ ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' }] }).lines;
  must(setBankStandard(ctx, { bankTxnId: lines.TEL, accountId: acc('6500'), taxCode: null, idempotencyKey: 'std-1' }), 'setBankStandard');
  const cat = must(createAssetCategory(ctx, {
    code: 'MASCH', name: 'Maschinen', depreciationMethod: 'straight_line', usefulLifeMonths: 12,
    glAssetAccountId: acc('1500'), glAccumDeprAccountId: acc('1510'), glDeprExpenseAccountId: acc('6800'), idempotencyKey: 'cat',
  }), 'category');
  const assets = [];
  for (const n of [1, 2]) {
    const a = must(createAsset(ctx, { categoryId: cat.category.id, name: `Fräse ${n}`, acquisitionDate: '2026-01-10', acquisitionCostRappen: 900_000, idempotencyKey: `as-${n}` }), 'asset');
    must(assetAcquire(ctx, { assetId: a.asset.id, date: '2026-01-10', acquisitionCostRappen: 900_000, creditAccountId: acc('1020'), idempotencyKey: `acq-${n}` }), 'acquire');
    assets.push(a.asset.id);
  }
  const run = must(assetDepreciationRunCreate(ctx, { period: '2026-02', assetIds: assets, idempotencyKey: 'dr' }), 'run');
  must(assetDepreciationRunPost(ctx, { runId: run.run.id, idempotencyKey: 'dp' }), 'run post');
  must(assetDispose(ctx, { assetId: assets[1], disposalDate: '2026-07-15', proceedsRappen: 700_000, proceedsAccountId: acc('1020'), gainLossAccountId: acc('6900'), idempotencyKey: 'disp' }), 'dispose');
  return t;
}

/**
 * Undo generation 15's shape (D175) on an open connection: the recipe columns, their trigger and the
 * text-aware index go, the D167 one-live index comes back. Used to regress a book and to compare a book
 * upgraded past 13 with its pre-upgrade bytes.
 */
function stripBankRules(db) {
  db.exec('DROP INDEX IF EXISTS bank_standard_one_live_rule');
  db.exec('DROP TRIGGER IF EXISTS bank_standard_recipe_frozen');
  db.exec('DROP TRIGGER IF EXISTS bank_line_decision_rule_frozen');
  if (db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('bank_line_decision', 'rule_id') !== undefined) db.exec('ALTER TABLE bank_line_decision DROP COLUMN rule_id');
  for (const col of ['label', 'match_text', 'legs_json', 'via_account_id']) {
    if (db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('bank_standard', col) !== undefined) db.exec(`ALTER TABLE bank_standard DROP COLUMN ${col}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS bank_standard_one_live ON bank_standard (workspace_id, counterparty_key, direction) WHERE superseded_at IS NULL');
}

/**
 * Turn a closed book file back into what an older build left behind. Generation 14 lacks the D175
 * recipe shape; generation 12 also lacks the settings tables; generation 10 also has the old
 * one-disposal index, no live-disposal trigger and none of the D167 input codes.
 */
function regress(file, toGeneration) {
  const db = new Database(file);
  stripBankRules(db);
  db.exec('ALTER TABLE wage_journal_posts DROP COLUMN run_kind');
  db.exec('DROP TABLE IF EXISTS workspace_setting_change');
  db.exec('DROP TABLE IF EXISTS workspace_setting');
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

function inTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'till-gen13-'));
  try {
    return fn(join(dir, 'book.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `fn` with every registered step's `apply` wrapped to record its generation; restores them after. */
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

/** Every generation from `from` up to this build's, in order: the steps a book at `from - 1` runs. */
const stepsFrom = (from) => Array.from({ length: SCHEMA_GENERATION - from + 1 }, (_, i) => from + i);

test('(e) this build writes a generation of at least 13; d172 is generation 13, registered directly after d170', () => {
  // D173 (wage run kind) moved the build to generation 14, D175 (bank rules) to 15; the newest generation's own suite pins the exact number.
  assert.ok(SCHEMA_GENERATION >= 13);
  const gens = DATA_MIGRATIONS.map((m) => m.generation);
  assert.deepEqual([...gens].sort((a, b) => a - b), gens, 'steps are registered in ascending generation');
  assert.equal(new Set(gens).size, gens.length, 'one step per generation');
  const d170 = DATA_MIGRATIONS.findIndex((m) => m.name.startsWith('d170-live-disposal'));
  const d172 = DATA_MIGRATIONS.findIndex((m) => m.name.startsWith('d172-workspace-settings'));
  assert.ok(d172 !== -1, 'the generation-13 step is registered');
  assert.equal(DATA_MIGRATIONS[d172].generation, 13);
  assert.equal(d172, d170 + 1, 'd172 directly follows d170');
  assert.equal(DATA_MIGRATIONS[d172 + 1]?.generation, 14, 'd173 (generation 14) follows d172');
  assert.equal(gens.at(-1), SCHEMA_GENERATION, 'the last step lifts the book to the build generation');
  inTemp((file) => {
    new SqliteStore({ location: file }).close();
    const db = new Database(file);
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_GENERATION, 'a fresh book is at the build generation');
    assert.deepEqual(settingsObjects(db), [...SETTINGS_OBJECTS].sort());
    db.close();
  });
});

test('(a) a live generation-10 book runs 11, 12, 13 and every later step in order in one open, and loses nothing', () => {
  excuseClaimInvariant();
  inTemp((file) => {
    const t = liveBook(file);
    const ws = t.workspaceId;
    t.store.close();
    regress(file, 10);

    const raw = new Database(file);
    const before = rowCounts(raw);
    assert.deepEqual(settingsObjects(raw), [], 'the reconstructed generation-10 book has no settings tables');
    assert.ok(before.asset_transaction >= 5 && before.bank_standard === 1 && before.contact >= 1 && before.journal_entry >= 4, JSON.stringify(before));
    const terms = raw.prepare('SELECT payment_terms_days AS d FROM contact WHERE workspace_id = ? AND name = ?').get(ws, 'Bergsicht Beratung AG').d;
    raw.close();

    observingSteps((ran) => {
      const store = new SqliteStore({ location: file });
      const db = store.db;
      assert.deepEqual(ran, stepsFrom(11), 'exactly the steps above the book, in order');
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_GENERATION, 'ends at the build generation');
      assert.deepEqual(settingsObjects(db), [...SETTINGS_OBJECTS].sort(), 'both tables and both triggers are present');
      const after = rowCounts(db);
      for (const [table, n] of Object.entries(before)) {
        const expected = table === 'tax_code' ? n + D167_INPUT_CODES.length : n;
        assert.equal(after[table], expected, `${table}: no row lost or invented`);
      }
      assert.equal(after.workspace_setting, 0, 'no setting is invented: every key reads its default');
      assert.equal(after.workspace_setting_change, 0);
      assert.equal(db.prepare('SELECT payment_terms_days AS d FROM contact WHERE workspace_id = ? AND name = ?').get(ws, 'Bergsicht Beratung AG').d, terms, 'a contact keeps its own terms');
      store.close();
    });
  });
});

test('(b) a live generation-12 book runs the generation-13 step and nothing below it', () => {
  excuseClaimInvariant();
  inTemp((file) => {
    const t = liveBook(file);
    t.store.close();
    regress(file, 12);
    const raw = new Database(file);
    const before = rowCounts(raw);
    const digest = contentDigest(raw);
    raw.close();

    observingSteps((ran) => {
      const store = new SqliteStore({ location: file });
      assert.deepEqual(ran, stepsFrom(13), 'd172 and the steps after it ran, nothing below');
      assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
      assert.deepEqual(settingsObjects(store.db), [...SETTINGS_OBJECTS].sort());
      const after = rowCounts(store.db);
      delete after.workspace_setting;
      delete after.workspace_setting_change;
      assert.deepEqual(after, before, 'no row changed in count');
      store.close();
    });
    const reopened = new Database(file);
    reopened.exec('DROP TABLE workspace_setting_change; DROP TABLE workspace_setting; ALTER TABLE wage_journal_posts DROP COLUMN run_kind;');
    stripBankRules(reopened);
    assert.equal(contentDigest(reopened), digest, 'every pre-existing row is byte-identical after the upgrade');
    reopened.close();
  });
});

test('(c) a crash inside the generation-13 step leaves the book at 12, untouched; a retry succeeds', () => {
  excuseClaimInvariant();
  inTemp((file) => {
    const t = liveBook(file);
    t.store.close();
    regress(file, 12);
    const raw = new Database(file);
    const digest = contentDigest(raw);
    raw.close();

    observingSteps(
      (ran) => {
        assert.throws(() => new SqliteStore({ location: file }), /simulated crash inside generation 13/);
        assert.deepEqual(ran, [13], 'the crash happened inside d172');
      },
      { crashAt: 13 },
    );
    const after = new Database(file);
    assert.equal(after.pragma('user_version', { simple: true }), 12, 'the marker stayed at 12');
    assert.deepEqual(settingsObjects(after), [], 'the schema pass rolled back with the step: no settings table');
    assert.equal(contentDigest(after), digest, 'every row is untouched');
    after.close();

    const store = new SqliteStore({ location: file });
    assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION, 'the retry lifts the book to the build generation');
    assert.deepEqual(settingsObjects(store.db), [...SETTINGS_OBJECTS].sort());
    store.close();
  });
});

test('(d) a runtime older than the book refuses it before any DDL: the file is byte for byte unchanged', () => {
  // The guard compares the book's marker with the BUILD generation; a generation-12 runtime meeting a
  // generation-13 book is this build meeting a generation-14 one, the same comparison one step up.
  assert.equal(newerGenerationRefusal(SCHEMA_GENERATION, '/b'), null, 'the current generation opens');
  assert.deepEqual(newerGenerationRefusal(SCHEMA_GENERATION + 1, '/b'), { bookGeneration: SCHEMA_GENERATION + 1, buildGeneration: SCHEMA_GENERATION, path: '/b' });
  inTemp((file) => {
    new SqliteStore({ location: file }).close();
    const db = new Database(file);
    db.exec('DROP TABLE workspace_setting_change');
    db.pragma(`user_version = ${SCHEMA_GENERATION + 1}`);
    db.close();
    const bytes = sha(file);
    assert.throws(() => new SqliteStore({ location: file }), /newer|schema_newer_than_runtime/);
    assert.equal(sha(file), bytes, 'the refused book is unchanged (no DDL ran: the dropped table was not re-created)');
    const check = new Database(file, { readonly: true });
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'workspace_setting_change'").get().n, 0);
    check.close();
  });
});
