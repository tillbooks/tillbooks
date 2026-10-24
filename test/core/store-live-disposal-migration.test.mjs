/**
 * Generations 11 and 12, in order (D167 then D170, renumbered at the undo integration).
 *
 * D167 took generation 11 on develop first (`d167-input-codes`, the reduced-rate input codes). D170's
 * index-to-trigger change (`d170-live-disposal`) is therefore generation 12, registered AFTER it. The
 * owner's real book sits at generation 10 and goes 10 -> 11 -> 12 in ONE open of this build.
 *
 *  (a) a generation-10 book WITH live data (assets incl. a disposal, a posted depreciation run,
 *      ordinary entries, a bank statement and a bank standard) runs BOTH steps, in order, loses no row,
 *      seeds the four VST codes once, ends with the trigger present, the old index gone, marker 12;
 *  (b) a generation-11 book (seed already applied, old index present, no trigger) gets d170 and
 *      NOTHING else re-applied (a seed re-run would show as a code a person deleted coming back);
 *  (c) a generation-11 book with live assets and a disposal migrates without loss, and the disposal
 *      can then be reversed and the asset disposed again (the trigger, not the index, is live);
 *  (d) the generation guard refuses a book one newer than this build.
 *
 * Mutation evidence (integration of 15.10.2026, mutating `dist/core/store/migrations.js`): removing
 * the generation-12 step fails the registration test (first test), and so does swapping the two steps.
 * Neither mutation changes the outcome of (a) to (c), and that is by design, not a blind spot: the
 * schema pass (`transactionSchema.ts`) drops the old index and creates the trigger on EVERY open,
 * before any data step, and `applyDataMigrations` runs every step above the book's marker, so the two
 * steps are independent and the d170 step is the belt to that brace. What (a) to (c) pin is the
 * observable contract: one open, marker 12, seed once, trigger present, index gone, no row lost.
 *
 * Every book here is SYNTHETIC by construction (invented companies, invented amounts, published
 * sample IBANs), created from scratch in a temp directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { DATA_MIGRATIONS, D167_INPUT_CODES } from '../../dist/core/store/migrations.js';
import { newerGenerationRefusal } from '../../dist/core/store/generation.js';
import { postEntry, ledgerPorts } from '../../dist/core/ledger/index.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { setBankStandard } from '../../dist/core/banking/index.js';
import {
  createAssetCategory,
  createAsset,
  assetAcquire,
  assetDepreciationRunCreate,
  assetDepreciationRunPost,
  assetDispose,
  assetTransactionReverse,
  assetReconciliationReport,
} from '../../dist/core/assets/index.js';
import { world, importLines, must, excuseClaimInvariant, TELCO_IBAN } from '../banking/bank-inbox-support.mjs';

const idx = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'asset_transaction_one_disposal'").get();
const trg = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'asset_transaction_one_live_disposal'").get();
const OLD_INDEX = "CREATE UNIQUE INDEX asset_transaction_one_disposal ON asset_transaction (workspace_id, asset_id) WHERE type = 'disposal'";

/** Every user table's row count, so "no data lost" covers the whole book, not a chosen few tables. */
function rowCounts(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]));
}

const vstCodes = (db, ws) =>
  db.prepare(`SELECT code FROM tax_code WHERE workspace_id = ? AND code IN (${D167_INPUT_CODES.map(() => '?').join(',')}) ORDER BY code`).all(ws, ...D167_INPUT_CODES).map((r) => r.code);

/** A live book on disk: VAT, a bank statement, a standard, an ordinary entry, two assets, a run, a disposal. */
function liveBook(file) {
  const t = world({ location: file, realPeriods: true });
  const { ctx, acc } = t;
  must(postEntry(ctx, { date: '2026-07-02', source: 'manual', description: 'Büromaterial bar', idempotencyKey: 'je-1', lines: [{ account: acc('6500'), debit: 4500 }, { account: acc('1000'), credit: 4500 }] }), 'postEntry');
  const lines = importLines(t, { statementId: 'BS-G12', entries: [{ ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' }] }).lines;
  must(setBankStandard(ctx, { bankTxnId: lines.TEL, accountId: acc('6500'), taxCode: null, idempotencyKey: 'std-1' }), 'setBankStandard');
  const cat = must(createAssetCategory(ctx, {
    code: 'MASCH', name: 'Maschinen', depreciationMethod: 'straight_line', usefulLifeMonths: 12,
    glAssetAccountId: acc('1500'), glAccumDeprAccountId: acc('1510'), glDeprExpenseAccountId: acc('6800'), idempotencyKey: 'cat',
  }), 'category');
  const assets = [];
  for (const n of [1, 2]) {
    const a = must(createAsset(ctx, { categoryId: cat.category.id, name: `Drehbank ${n}`, acquisitionDate: '2026-01-10', acquisitionCostRappen: 1_200_000, idempotencyKey: `as-${n}` }), 'asset');
    must(assetAcquire(ctx, { assetId: a.asset.id, date: '2026-01-10', acquisitionCostRappen: 1_200_000, creditAccountId: acc('1020'), idempotencyKey: `acq-${n}` }), 'acquire');
    assets.push(a.asset.id);
  }
  const run = must(assetDepreciationRunCreate(ctx, { period: '2026-02', assetIds: assets, idempotencyKey: 'dr' }), 'run');
  must(assetDepreciationRunPost(ctx, { runId: run.run.id, idempotencyKey: 'dp' }), 'run post');
  const disposal = must(assetDispose(ctx, { assetId: assets[1], disposalDate: '2026-07-15', proceedsRappen: 1_000_000, proceedsAccountId: acc('1020'), gainLossAccountId: acc('6900'), idempotencyKey: 'disp' }), 'dispose');
  return { t, assets, disposalTxnId: disposal.transaction.id };
}

/** Turn a closed book file back into what an older build left behind. */
function regress(file, { toGeneration, dropSeed }) {
  const db = new Database(file);
  db.exec('DROP TRIGGER IF EXISTS asset_transaction_one_live_disposal');
  db.exec(OLD_INDEX);
  if (dropSeed) db.prepare(`DELETE FROM tax_code WHERE code IN (${D167_INPUT_CODES.map(() => '?').join(',')})`).run(...D167_INPUT_CODES);
  db.pragma(`user_version = ${toGeneration}`);
  db.close();
}

function inTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'till-gen12-'));
  try {
    return fn(join(dir, 'book.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// D172 (15.10.2026) added generation 13 after these two; this suite pins 11 and 12 and their order, and
// reads the build generation from SCHEMA_GENERATION (`store-workspace-settings-migration.test.mjs` pins 13).
test('d167 is generation 11 and d170 is generation 12, registered in that order; a fresh book is at the build generation', () => {
  assert.ok(SCHEMA_GENERATION >= 12);
  const gens = DATA_MIGRATIONS.map((m) => m.generation);
  assert.deepEqual([...gens].sort((a, b) => a - b), gens, 'steps are registered in ascending generation');
  const d167 = DATA_MIGRATIONS.findIndex((m) => m.name.startsWith('d167-input-codes'));
  const d170 = DATA_MIGRATIONS.findIndex((m) => m.name.startsWith('d170-live-disposal'));
  assert.equal(DATA_MIGRATIONS[d167].generation, 11);
  assert.equal(DATA_MIGRATIONS[d170].generation, 12);
  assert.ok(d167 < d170, 'd167 runs before d170');
  assert.equal(gens.at(-1), SCHEMA_GENERATION, 'the last step lifts the book to the build generation');
  inTemp((file) => {
    new SqliteStore({ location: file }).close();
    const db = new Database(file);
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_GENERATION, 'a fresh book is at the build generation');
    assert.ok(trg(db));
    assert.equal(idx(db), undefined);
    db.close();
  });
});

test('(a) a live generation-10 book runs the d167 seed, then d170, in one open, and loses nothing', () => {
  excuseClaimInvariant();
  inTemp((file) => {
    const { t } = liveBook(file);
    const ws = t.workspaceId;
    t.store.close();
    regress(file, { toGeneration: 10, dropSeed: true });

    const raw = new Database(file);
    const before = rowCounts(raw);
    assert.deepEqual(vstCodes(raw, ws), [], 'the reconstructed generation-10 book lacks the D167 codes');
    assert.ok(before.asset_transaction >= 5 && before.bank_standard === 1 && before.bank_txn >= 1, JSON.stringify(before));
    // Observe the order the steps run in: a temp trigger is per connection, so watch from SQLite itself.
    raw.exec('CREATE TABLE migration_probe (seq INTEGER PRIMARY KEY, what TEXT NOT NULL, index_present INTEGER NOT NULL)');
    raw.exec(`CREATE TRIGGER probe_seed AFTER INSERT ON tax_code WHEN NEW.code = 'VST-M26'
      BEGIN INSERT INTO migration_probe (what, index_present) VALUES ('seed',
        (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'asset_transaction_one_disposal')); END`);
    raw.close();

    const store = new SqliteStore({ location: file });
    const db = store.db;
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_GENERATION, 'ends at the build generation');
    const probe = db.prepare('SELECT what, index_present AS indexPresent FROM migration_probe ORDER BY seq').all();
    assert.deepEqual(probe.map((p) => ({ ...p })), [{ what: 'seed', indexPresent: 0 }], 'the generation-11 seed ran exactly once (the schema pass drops the old index on open, before any data step)');
    assert.equal(idx(db), undefined, 'the old one-disposal index is gone');
    assert.ok(trg(db), 'the live-disposal trigger is present');
    assert.deepEqual(vstCodes(db, ws), [...D167_INPUT_CODES].sort(), 'the four VST codes are seeded, once each');
    const after = rowCounts(db);
    for (const [table, n] of Object.entries(before)) {
      const expected = table === 'tax_code' ? n + D167_INPUT_CODES.length : n;
      assert.equal(after[table], expected, `${table}: no row lost or invented`);
    }
    store.close();
  });
});

test('(b) a generation-11 book gets d170 and nothing else: the seed is not re-applied', () => {
  excuseClaimInvariant();
  inTemp((file) => {
    const { t } = liveBook(file);
    const ws = t.workspaceId;
    t.store.close();
    regress(file, { toGeneration: 11, dropSeed: false });
    // A person deleted one seeded code after generation 11 ran. A re-run of the seed would bring it back.
    const raw = new Database(file);
    raw.prepare("DELETE FROM tax_code WHERE workspace_id = ? AND code = 'VST-I38'").run(ws);
    const before = rowCounts(raw);
    raw.close();

    const store = new SqliteStore({ location: file });
    assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    assert.equal(idx(store.db), undefined);
    assert.ok(trg(store.db));
    assert.deepEqual(vstCodes(store.db, ws), ['VST-I26', 'VST-M26', 'VST-M38'], 'generation 11 did not run again');
    assert.deepEqual(rowCounts(store.db), before, 'no row changed in count');
    store.close();
  });
});

test('(c) a generation-11 book with live assets and a disposal migrates without loss and can re-dispose', () => {
  excuseClaimInvariant();
  inTemp((file) => {
    const { t, assets, disposalTxnId } = liveBook(file);
    const ws = t.workspaceId;
    const snapshot = (db) => db.prepare('SELECT * FROM asset_transaction WHERE workspace_id = ? ORDER BY id').all(ws);
    const assetRows = (db) => db.prepare('SELECT * FROM asset WHERE workspace_id = ? ORDER BY id').all(ws);
    t.store.close();
    regress(file, { toGeneration: 11, dropSeed: false });
    const raw = new Database(file);
    const txBefore = snapshot(raw);
    const assetBefore = assetRows(raw);
    raw.close();

    const clock = fixedClock('2026-08-16T00:00:00.000Z');
    const seq = sequenceIdGen();
    const ids = { next: (p) => `${seq.next(p)}_g12` };
    const store = new SqliteStore({ clock, location: file });
    assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
    assert.equal(idx(store.db), undefined);
    assert.ok(trg(store.db));
    assert.deepEqual(snapshot(store.db), txBefore, 'every asset transaction survives unchanged');
    assert.deepEqual(assetRows(store.db), assetBefore, 'every asset survives unchanged');
    // The trigger, not the index, now guards disposals: reverse the disposal, then dispose again.
    const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock, ids, ...ledgerPorts({ store, workspaceId: ws, ids }) });
    const acc = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, n).id;
    must(assetTransactionReverse(ctx, { assetId: assets[1], transactionId: disposalTxnId, reason: 'Verkauf storniert', idempotencyKey: 'rev-disp' }), 'reverse disposal');
    must(assetDispose(ctx, { assetId: assets[1], disposalDate: '2026-08-10', proceedsRappen: 900_000, proceedsAccountId: acc('1020'), gainLossAccountId: acc('6900'), idempotencyKey: 'disp-2' }), 'dispose again');
    const r = must(assetReconciliationReport(ctx, { asOf: '2026-12-31' }), 'reconciliation');
    assert.equal(r.summary.status, 'balanced', JSON.stringify(r.accounts));
    store.close();
  });
});

test('(d) the generation guard refuses a book one newer than this build', () => {
  assert.equal(newerGenerationRefusal(SCHEMA_GENERATION, '/b'), null, 'the current generation opens');
  assert.deepEqual(newerGenerationRefusal(SCHEMA_GENERATION + 1, '/b'), { bookGeneration: SCHEMA_GENERATION + 1, buildGeneration: SCHEMA_GENERATION, path: '/b' });
  inTemp((file) => {
    new SqliteStore({ location: file }).close();
    const db = new Database(file);
    db.pragma(`user_version = ${SCHEMA_GENERATION + 1}`);
    db.close();
    assert.throws(() => new SqliteStore({ location: file }), /newer|schema_newer_than_runtime/);
  });
});

