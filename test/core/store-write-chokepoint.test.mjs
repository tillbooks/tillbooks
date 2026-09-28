/**
 * THE WRITE CHOKEPOINT (critic round 3, R3-1 to R3-4 and OUT-1): one point every write passes, instead
 * of a census of call sites.
 *
 * Three critic rounds on the generation guard each found writes that bypassed the per-call-site
 * protection (a key-less verb, a helper, a run log). `SqliteStore.db` is now a connection that runs
 * every statement SQLite reports as writing, issued outside a transaction, inside `SqliteStore.tx`
 * (IMMEDIATE, the marker read under the write lock). This suite asserts, against real files and a real
 * second process where it matters:
 *
 *   1. The mechanism: a writing statement (by `readonly`, not `reader`), a writing `exec` and a writing
 *      `pragma` are refused on a moved-on book with nothing written; reads are the driver's own; the
 *      store's own transactions and nesting are untouched; a transaction the store did not open is
 *      checked under the lock and rolled back whole, even when the caller swallows the refusal; a
 *      guarded bare write under D12's held lock waits for it, like the autocommit it replaced.
 *   2. The census, re-run with the idempotency key OMITTED wherever the schema allows it (critic probe
 *      q12): over every conformance scenario, not one write statement, `exec` or writing `pragma` runs
 *      outside a transaction.
 *   3. Key-less money writes racing a newer TILL's migration are refused and write nothing (q13), on
 *      the Studio door and on the agent door (q18).
 *   4. A read that straddles a migration is refused, not answered with mixed data (R3-2, q14).
 *   5. `delete_backup` waits for a held lock (R3-3, q15).
 *   6. A book with a hot rollback journal opens again, and a newer one is still refused with its
 *      marker kept (R3-4, q16).
 *   7. The audit chain cannot fork under a second writer (OUT-1, q19).
 *
 * Every book here is synthetic, created from scratch in a temp directory, and every temp directory is
 * removed. No git is run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { SCHEMA_NEWER_THAN_RUNTIME, SchemaNewerThanRuntimeError } from '../../dist/core/store/generation.js';
import { getAction } from '../../dist/api/registry.js';
import { makeApiDeps, callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { fixedClock, systemClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { ADAPTERS } from '../../dist/core/mail/adapters.js';
import { SCENARIOS, READ_SCENARIOS, fixture } from '../api/conformance-contract.mjs';
import { lockHolder } from '../support/lock-holder.mjs';
import { makeMaildirStore, rfc822, sampleMessages, tempStoreDir } from '../mail/fixtures.mjs';

const AT = '2026-09-25T00:00:00.000Z';
const NEWER = SCHEMA_GENERATION + 1;
const DRIVER = createRequire(import.meta.url).resolve('better-sqlite3');
const DIST = (rel) => fileURLToPath(new URL(`../../dist/${rel}`, import.meta.url));
const CELL = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(CELL, 0, 0, ms);

function tempDir(prefix = 'till-choke-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

/** The typed refusal, from a throw. */
function isRefusal(e) {
  return e instanceof SchemaNewerThanRuntimeError && e.code === SCHEMA_NEWER_THAN_RUNTIME && e.bookGeneration === NEWER;
}

/** A store over a real file with one table of its own, plus a second connection that plays the newer TILL. */
function fileWorld(dir) {
  const path = join(dir, 'book.db');
  const store = new SqliteStore({ location: path, clock: fixedClock(AT) });
  store.db.exec('CREATE TABLE IF NOT EXISTS probe_row (id INTEGER PRIMARY KEY, v INTEGER NOT NULL UNIQUE)');
  const other = new Database(path);
  const rows = () => other.prepare('SELECT COUNT(*) AS n FROM probe_row').get().n;
  return { path, store, other, rows };
}

// --- 1. the mechanism --------------------------------------------------------------------------------

test('a writing statement is guarded by what SQLite reports (readonly), and a read is the driver`s own object', () => {
  const store = new SqliteStore({ clock: fixedClock(AT) });
  try {
    store.db.exec('CREATE TABLE IF NOT EXISTS probe_row (id INTEGER PRIMARY KEY, v INTEGER NOT NULL UNIQUE)');
    const own = (stmt, name) => Object.prototype.hasOwnProperty.call(stmt, name);
    const insert = store.db.prepare('INSERT INTO probe_row (v) VALUES (?)');
    assert.equal(own(insert, 'run'), true, 'INSERT: run is guarded');
    const returning = store.db.prepare('INSERT INTO probe_row (v) VALUES (?) RETURNING id');
    assert.equal(returning.reader, true, 'premise: RETURNING makes a writer a reader, which is why `reader` is the wrong test');
    for (const m of ['run', 'get', 'all', 'iterate']) assert.equal(own(returning, m), true, `INSERT ... RETURNING: ${m} is guarded`);
    const select = store.db.prepare('SELECT v FROM probe_row');
    for (const m of ['run', 'get', 'all', 'iterate']) assert.equal(own(select, m), false, `SELECT: ${m} is the driver's own`);
    const connectionPragma = store.db.prepare('PRAGMA defer_foreign_keys = ON');
    assert.equal(connectionPragma.reader, false, 'premise: a connection pragma is a non-reader');
    assert.equal(own(connectionPragma, 'run'), false, 'but it writes nothing, so it is not guarded');

    // A guarded write still answers exactly what the driver answers.
    const result = insert.run(41);
    assert.equal(result.changes, 1);
    assert.equal(typeof result.lastInsertRowid, 'number');
    assert.equal(returning.get(42).id > 0, true);
    assert.deepEqual([...returning.iterate(43)].length, 1);
    assert.deepEqual(store.db.prepare('SELECT v FROM probe_row ORDER BY v').pluck().all(), [41, 42, 43]);
    // And a failing one fails the same way, leaving nothing.
    assert.throws(() => insert.run(41), (e) => e.code === 'SQLITE_CONSTRAINT_UNIQUE');
    assert.equal(store.db.inTransaction, false, 'the failed write left no transaction open');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM probe_row').get().n, 3);
  } finally {
    store.close();
  }
});

test('on a moved-on book every way to write outside a transaction is refused and writes nothing', () => {
  const dir = tempDir();
  const w = fileWorld(dir);
  try {
    const insert = w.store.db.prepare('INSERT INTO probe_row (v) VALUES (?)');
    const returning = w.store.db.prepare('INSERT INTO probe_row (v) VALUES (?) RETURNING id');
    w.other.pragma(`user_version = ${NEWER}`);
    const before = w.rows();
    assert.throws(() => insert.run(1), isRefusal, 'run');
    assert.throws(() => returning.get(2), isRefusal, 'get of INSERT ... RETURNING');
    assert.throws(() => returning.all(3), isRefusal, 'all of INSERT ... RETURNING');
    assert.throws(() => returning.iterate(4), isRefusal, 'iterate of INSERT ... RETURNING');
    assert.throws(() => w.store.db.exec('INSERT INTO probe_row (v) VALUES (5)'), isRefusal, 'exec of one statement');
    assert.throws(
      () => w.store.db.exec('INSERT INTO probe_row (v) VALUES (6); INSERT INTO probe_row (v) VALUES (7)'),
      isRefusal,
      'exec of several statements',
    );
    assert.throws(() => w.store.db.exec('CREATE TABLE newer_would_not_have (x)'), isRefusal, 'DDL through exec');
    assert.throws(() => w.store.db.pragma('user_version = 3'), isRefusal, 'a pragma that would LOWER the marker');
    assert.equal(w.rows(), before, 'no row was written');
    assert.equal(w.other.pragma('user_version', { simple: true }), NEWER, 'the marker was never lowered');
    assert.equal(w.other.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'newer_would_not_have'").get().n, 0);
    // Reads and read-only exec and pragma are not writes: they pass (the registry refuses verbs above them).
    assert.equal(w.store.db.prepare('SELECT COUNT(*) AS n FROM probe_row').get().n, before);
    w.store.db.exec('SELECT 1');
    assert.equal(w.store.db.pragma('user_version', { simple: true }), NEWER);
    // The two housekeeping pragmas SQLite calls writing change no row and cannot run inside a
    // transaction at all; they pass through (a checkpoint inside one failed with SQLITE_LOCKED).
    assert.equal(w.store.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(w.store.db.pragma('wal_checkpoint(TRUNCATE)')[0].busy, 0);
    w.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(w.store.db.inTransaction, false);
  } finally {
    w.store.close();
    w.other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inside the store`s own transactions nothing is wrapped twice, and nesting runs as savepoints', () => {
  const dir = tempDir();
  const w = fileWorld(dir);
  try {
    const insert = w.store.db.prepare('INSERT INTO probe_row (v) VALUES (?)');
    const result = w.store.tx(() => {
      insert.run(1);
      w.store.tx(() => insert.run(2));
      assert.throws(() => w.store.tx(() => {
        insert.run(3);
        throw new Error('inner failure');
      }), /inner failure/);
      w.store.db.exec('INSERT INTO probe_row (v) VALUES (4)');
      return w.store.rememberIdempotent('_system', 'k1', 'synthetic_verb', () => {
        insert.run(5);
        return { ok: true };
      });
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(w.other.prepare('SELECT v FROM probe_row ORDER BY v').pluck().all(), [1, 2, 4, 5], 'the inner rollback undid only its savepoint');
    assert.equal(w.store.db.inTransaction, false);
    // snapshotTx is the store's own too: a write inside it is covered by its first-statement read.
    w.store.snapshotTx(() => insert.run(6));
    assert.equal(w.rows(), 5);
  } finally {
    w.store.close();
    w.other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a transaction the store did not open is checked under the lock, and rolled back whole even when the refusal is swallowed', () => {
  const dir = tempDir();
  const w = fileWorld(dir);
  try {
    const insert = w.store.db.prepare('INSERT INTO probe_row (v) VALUES (?)');
    // A raw transaction on a current book works as it always did.
    w.store.db.transaction(() => {
      insert.run(1);
      insert.run(2);
    })();
    assert.equal(w.rows(), 2);

    w.other.pragma(`user_version = ${NEWER}`);
    // A raw `db.transaction` never read the marker itself: its first write is checked right after it.
    assert.throws(() => w.store.db.transaction(() => insert.run(3))(), isRefusal, 'raw db.transaction');
    // A caller that swallows the refusal cannot commit what came before it: the store rolled back.
    assert.throws(
      () =>
        w.store.db.transaction(() => {
          try {
            insert.run(4);
          } catch {
            // swallowed on purpose
          }
          return 'carried on';
        })(),
      (e) => e.code === 'SQLITE_ERROR' && /no transaction is active/.test(e.message),
      'the commit after a swallowed refusal finds nothing to commit',
    );
    // A transaction begun by hand (`exec('BEGIN')`) is the same case.
    w.store.db.exec('BEGIN');
    assert.throws(() => insert.run(5), isRefusal, 'exec(BEGIN), then a write');
    assert.equal(w.store.db.inTransaction, false, 'the store rolled the hand-made transaction back');
    // A multi-statement exec that tries to open its own transaction fails loudly instead of slipping past.
    assert.throws(() => w.store.db.exec('BEGIN; INSERT INTO probe_row (v) VALUES (6); COMMIT;'), (e) => isRefusal(e) || /within a transaction/.test(e.message));
    assert.equal(w.rows(), 2, 'nothing after the book moved on was written');
    assert.equal(w.other.pragma('user_version', { simple: true }), NEWER);
  } finally {
    w.store.close();
    w.other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D12: a guarded bare write meets another process`s held lock and WAITS for it, like the autocommit it replaced', async () => {
  const dir = tempDir();
  const w = fileWorld(dir);
  try {
    const holder = await lockHolder(w.path, { holdMs: 300 });
    assert.equal(holder.take(), true, 'premise: the other process holds the write lock');
    const t0 = performance.now();
    w.store.db.prepare('INSERT INTO probe_row (v) VALUES (?)').run(1);
    const waited = performance.now() - t0;
    await holder.done;
    assert.ok(waited >= 150, `the write waited for the lock (${Math.round(waited)} ms)`);
    assert.equal(w.rows(), 1);
  } finally {
    w.store.close();
    w.other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 2. the census, key-less (critic probe q12) ------------------------------------------------------

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

test('the key-less census: over every conformance scenario, not one write runs outside a transaction (q12)', () => {
  const probe = new Database(':memory:');
  const statementProto = Object.getPrototypeOf(probe.prepare('SELECT 1'));
  probe.close();
  const dbProto = Database.prototype;
  const originals = {
    run: statementProto.run,
    get: statementProto.get,
    all: statementProto.all,
    iterate: statementProto.iterate,
    exec: dbProto.exec,
    pragma: dbProto.pragma,
  };
  let current = null;
  const bare = new Map();
  const note = (source) => {
    const set = bare.get(current.name) ?? new Set();
    set.add(source.replace(/\s+/g, ' ').trim().slice(0, 160));
    bare.set(current.name, set);
  };
  for (const m of ['run', 'get', 'all', 'iterate']) {
    statementProto[m] = function (...params) {
      if (current !== null && this.database === current.db && !this.readonly && !this.database.inTransaction && !TRANSACTION_CONTROL.test(this.source)) {
        note(this.source);
      }
      return originals[m].apply(this, params);
    };
  }
  // What SQLite says about a string: one read-only statement, or anything else (several count as a write).
  const writesSql = (db, sql) => {
    try {
      return !Database.prototype.prepare.call(db, sql).readonly;
    } catch {
      return true;
    }
  };
  dbProto.exec = function (source) {
    if (current !== null && this === current.db && !this.inTransaction && !TRANSACTION_CONTROL.test(source) && writesSql(this, source)) {
      note(`exec: ${source}`);
    }
    return originals.exec.call(this, source);
  };
  dbProto.pragma = function (source, options) {
    if (current !== null && this === current.db && !this.inTransaction && writesSql(this, `PRAGMA ${source}`)) note(`pragma: ${source}`);
    return originals.pragma.call(this, source, options);
  };
  let keyless = 0;
  const outcomes = [];
  // Every temp directory a scenario makes (support, backup, mail and payment roots) lands under one
  // parent this test removes: `os.tmpdir()` reads TMPDIR on every call.
  const tmpParent = tempDir('till-choke-census-');
  const savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = tmpParent;
  try {
    for (const [scenarios, kind] of [[SCENARIOS, 'write'], [READ_SCENARIOS, 'read']]) {
      for (const [name, scenario] of Object.entries(scenarios)) {
        const action = getAction(name);
        if (action === undefined) continue;
        const fx = fixture();
        try {
          let input = scenario(fx);
          const required = action.inputSchema?.required ?? [];
          if (input && typeof input === 'object' && 'idempotencyKey' in input && !required.includes('idempotencyKey')) {
            input = { ...input };
            delete input.idempotencyKey;
            keyless += 1;
          }
          current = { name, db: fx.deps.store.db };
          const r = action.run(fx.deps, input);
          outcomes.push({ name, kind, ok: r.ok === true, error: r.ok ? undefined : r.error });
        } finally {
          current = null;
          fx.deps.store.close();
        }
      }
    }
  } finally {
    Object.assign(statementProto, { run: originals.run, get: originals.get, all: originals.all, iterate: originals.iterate });
    dbProto.exec = originals.exec;
    dbProto.pragma = originals.pragma;
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    rmSync(tmpParent, { recursive: true, force: true });
  }
  assert.ok(keyless >= 100, `premise: the key was omitted from many write scenarios (${keyless})`);
  const writes = outcomes.filter((o) => o.kind === 'write');
  const failed = writes.filter((o) => !o.ok);
  assert.deepEqual(failed, [], 'premise: every write scenario still succeeds without its optional key, so the census saw real writes');
  assert.ok(writes.length >= 400, `premise: the census covered the write surface (${writes.length} scenarios)`);
  const found = Object.fromEntries([...bare].map(([k, v]) => [k, [...v]]));
  assert.deepEqual(found, {}, 'no write statement, exec or writing pragma ran outside a transaction');
});

// --- 3. key-less money writes racing a newer TILL (critic probes q13, q18) ----------------------------

/**
 * A NEWER TILL (another process) begins its migration exactly when this build prepares the statement
 * matching `pattern`, then changes what `column` means (x100) and bumps the marker, in one transaction.
 * Returns whether it got the write lock at that moment (it did: a key-less write holds no transaction
 * when it prepares), and a `finish` that waits for it and restores `prepare`.
 */
async function newerTillAt(store, path, pattern, table, column) {
  const holder = await lockHolder(path, {
    holdMs: 200,
    inTransaction: `db.prepare('UPDATE ${table} SET ${column} = ${column} * 100 WHERE ${column} IS NOT NULL').run(); db.pragma('user_version = ${NEWER}');`,
  });
  let took = null;
  const prepare = store.db.prepare;
  store.db.prepare = function (sql) {
    if (took === null && pattern.test(sql)) took = holder.take(1500);
    return prepare.call(this, sql);
  };
  return {
    took: () => took,
    finish: async () => {
      store.db.prepare = prepare;
      await holder.done;
    },
  };
}

function readBook(path, sql, ...params) {
  const ro = new Database(path, { readonly: true });
  try {
    return { generation: ro.pragma('user_version', { simple: true }), row: ro.prepare(sql).get(...params) };
  } finally {
    ro.close();
  }
}

const KEYLESS_MONEY = [
  {
    verb: 'vat_code_upsert',
    setup: (call) => {
      assert.equal(call('vat_configure', { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'vc' }).ok, true);
      return { code: 'UST81X', kind: 'output', rateBp: 810, formLine: '303', label: 'Normalsatz' };
    },
    pattern: /INSERT INTO tax_code/,
    table: 'tax_code',
    column: 'rate_bp',
    where: "code = 'UST81X'",
  },
  {
    verb: 'create_item',
    setup: () => ({ name: 'Beratung Q13', defaultUnitPriceMinor: 15000 }),
    pattern: /INSERT INTO item\b/,
    table: 'item',
    column: 'default_unit_price_minor',
    where: "name = 'Beratung Q13'",
  },
  {
    verb: 'time_log',
    setup: (call) => {
      const c = call('create_contact', { partyRole: 'customer', name: 'Zeit AG', idempotencyKey: 'c' });
      const p = call('project_create', { name: 'Zeit', contactId: c.contact.id, idempotencyKey: 'p' });
      assert.equal(call('rate_card_upsert', { scope: 'default', rateMinor: 18000, validFrom: '2026-01-01', idempotencyKey: 'rc' }).ok, true);
      return { userId: 'user-g', projectId: p.project.id, startedAt: '2026-07-10T09:00:00.000Z', minutes: 60, notes: 'q13' };
    },
    pattern: /INSERT INTO time_entry/,
    table: 'time_entry',
    column: 'rate_minor',
    where: "notes = 'q13'",
  },
];

for (const c of KEYLESS_MONEY) {
  test(`q13: a key-less ${c.verb} racing a newer TILL's migration is refused and writes nothing`, async () => {
    const dir = tempDir();
    const path = join(dir, 'book.db');
    const store = new SqliteStore({ location: path });
    try {
      const deps = { store, clock: systemClock, ids: systemIdGen, actor: 'studio' };
      const workspaceId = getAction('create_workspace').run(deps, { name: 'Satz Beispiel AG', idempotencyKey: 'ws' }).workspaceId;
      const call = (verb, input) => getAction(verb).run(deps, { workspaceId, ...input });
      const input = c.setup(call);
      assert.equal('idempotencyKey' in input, false, 'premise: the call carries no key');
      const newer = await newerTillAt(store, path, c.pattern, c.table, c.column);
      const res = call(c.verb, input);
      await newer.finish();
      assert.equal(newer.took(), true, 'premise: the newer TILL took the lock mid-verb (a key-less write holds no transaction)');
      assert.equal(res.ok, false, JSON.stringify(res));
      assert.equal(res.error, SCHEMA_NEWER_THAN_RUNTIME);
      assert.equal(res.partial, false, 'nothing of this call reached the book');
      const book = readBook(path, `SELECT COUNT(*) AS n FROM ${c.table} WHERE ${c.where}`);
      assert.equal(book.generation, NEWER, 'premise: the newer TILL migrated the book');
      assert.equal(book.row.n, 0, 'no old-meaning row landed in the newer book');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('q18: the agent door takes a key-less create_item; racing a newer TILL it is refused, with no row and no trace row', async () => {
  const dir = tempDir();
  const path = join(dir, 'book.db');
  const { deps, store } = makeApiDeps(path);
  try {
    const tool = (verb, input) => JSON.parse(callTool(deps, verb, input).content[0].text);
    const ws = tool('create_workspace', { name: 'Agent AG', idempotencyKey: 'ws' });
    assert.equal(ws.ok, true, JSON.stringify(ws));
    const quiet = tool('create_item', { workspaceId: ws.workspaceId, name: 'Beratung ruhig', defaultUnitPriceMinor: 15000 });
    assert.equal(quiet.ok, true, `premise: the agent door accepts a key-less money write: ${JSON.stringify(quiet)}`);
    const calls = () => readBook(path, 'SELECT COUNT(*) AS n FROM agent_call').row.n;
    const callsBefore = calls();
    const newer = await newerTillAt(store, path, /INSERT INTO item\b/, 'item', 'default_unit_price_minor');
    const res = tool('create_item', { workspaceId: ws.workspaceId, name: 'Beratung Q18', defaultUnitPriceMinor: 15000 });
    await newer.finish();
    assert.equal(newer.took(), true, 'premise: the newer TILL took the lock mid-verb');
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, SCHEMA_NEWER_THAN_RUNTIME);
    const book = readBook(path, "SELECT COUNT(*) AS n FROM item WHERE name = 'Beratung Q18'");
    assert.equal(book.generation, NEWER);
    assert.equal(book.row.n, 0, 'no item row');
    assert.equal(calls(), callsBefore, 'no agent trace row either');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 4. a read that straddles a migration (R3-2, critic probe q14) -----------------------------------

test('R3-2: a read verb in flight when a newer TILL migrates is refused, never answered with mixed data (q14)', () => {
  const dir = tempDir();
  const path = join(dir, 'book.db');
  const store = new SqliteStore({ location: path });
  try {
    const d = { store, clock: systemClock, ids: systemIdGen, actor: 'studio' };
    const workspaceId = getAction('create_workspace').run(d, { name: 'Lese Beispiel AG', idempotencyKey: 'ws' }).workspaceId;
    const c = getAction('create_contact').run(d, { workspaceId, partyRole: 'customer', name: 'Kunde AG', idempotencyKey: 'c' });
    const doc = getAction('create_document').run(d, {
      workspaceId, type: 'invoice', contactId: c.contact.id, currency: 'CHF',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000 }], idempotencyKey: 'doc',
    });
    assert.equal(doc.ok, true, JSON.stringify(doc));
    const read = () => getAction('get_document').run(d, { workspaceId, documentId: doc.document.id });

    const quiet = read();
    assert.equal(quiet.ok, true);
    assert.equal(quiet.document.totalMinor, 100000);
    assert.deepEqual(quiet.lines.map((l) => l.unitPriceMinor), [100000]);

    // The newer TILL migrates between the verb's header read and its line read.
    const migrate = () => {
      const r = spawnSync(process.execPath, ['-e', `
        const Database = require(${JSON.stringify(DRIVER)});
        const db = new Database(${JSON.stringify(path)}, { timeout: 5000 });
        db.transaction(() => {
          db.prepare('UPDATE document SET subtotal_minor = subtotal_minor * 100, tax_minor = tax_minor * 100, total_minor = total_minor * 100').run();
          db.prepare('UPDATE document_line SET unit_price_minor = unit_price_minor * 100, line_total_minor = line_total_minor * 100').run();
          db.pragma('user_version = ${NEWER}');
        }).immediate();
        db.close();`], { stdio: 'inherit' });
      assert.equal(r.status, 0, 'premise: the newer TILL migrated');
    };
    let fired = false;
    const prepare = store.db.prepare;
    store.db.prepare = function (sql) {
      if (!fired && /FROM document_line/.test(sql)) {
        fired = true;
        migrate();
      }
      return prepare.call(this, sql);
    };
    const spanning = read();
    store.db.prepare = prepare;
    assert.equal(fired, true, 'premise: the migration ran mid-read');
    assert.equal(spanning.ok, false, `mixed data must not be answered as ok: ${JSON.stringify(spanning).slice(0, 300)}`);
    assert.equal(spanning.error, SCHEMA_NEWER_THAN_RUNTIME);
    assert.equal(spanning.partial, false, 'a read changed nothing');
    assert.equal(spanning.bookGeneration, NEWER);
    assert.equal(spanning.document, undefined, 'no document is returned');
    assert.equal(spanning.lines, undefined, 'and no lines');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A newer TILL that migrates at the first marker read OUTSIDE a transaction after the call has
 * written: for a verb that writes in one go, that is the registry's check once the verb has returned.
 */
function newerTillAfterFirstWrite(store, other) {
  const start = store.changeCount();
  const check = store.assertGenerationKnown.bind(store);
  store.assertGenerationKnown = () => {
    if (!store.db.inTransaction && store.changeCount() > start) other.pragma(`user_version = ${NEWER}`);
    return check();
  };
  return () => delete store.assertGenerationKnown;
}

// The three faces a caller meets: the registry itself (the Studio's REST twin calls it), REST and MCP.
const FACES = {
  registry: (deps, verb, input) => getAction(verb).run(deps, input),
  rest: (deps, verb, input) => handleRest(verb, input, deps).body,
  mcp: (deps, verb, input) => JSON.parse(callTool(deps, verb, input).content[0].text),
};

for (const [face, call] of Object.entries(FACES)) {
  test(`R3-2 / R4-1 (${face}): a write that completed before the book moved on says it was saved, as the \`completed\` field`, () => {
    const dir = tempDir();
    const path = join(dir, 'book.db');
    const store = new SqliteStore({ location: path });
    const other = new Database(path);
    try {
      const d = { store, clock: systemClock, ids: systemIdGen, actor: 'studio' };
      const workspaceId = getAction('create_workspace').run(d, { name: 'Gespeichert AG', idempotencyKey: 'ws' }).workspaceId;
      const restore = newerTillAfterFirstWrite(store, other);
      const res = call(d, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Gespeichert Kunde AG', idempotencyKey: 'c1' });
      restore();
      assert.equal(res.ok, false);
      assert.equal(res.error, SCHEMA_NEWER_THAN_RUNTIME);
      assert.equal(res.partial, true, 'the call wrote');
      assert.equal(res.completed, true, 'and it completed: every face gets this as data, not only in the English sentence');
      assert.match(res.message, /This call was saved before that/);
      assert.doesNotMatch(res.message, /not changed|the rest was not written/);
      assert.equal(other.prepare("SELECT COUNT(*) AS n FROM contact WHERE name = 'Gespeichert Kunde AG'").get().n, 1, 'and it was: the contact is in the book');
    } finally {
      store.close();
      other.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('R4-1: a refusal before anything was written carries completed:false and the not-changed sentence, on every face', () => {
  const dir = tempDir();
  const path = join(dir, 'book.db');
  const store = new SqliteStore({ location: path });
  const other = new Database(path);
  try {
    const d = { store, clock: systemClock, ids: systemIdGen, actor: 'studio' };
    const workspaceId = getAction('create_workspace').run(d, { name: 'Vorher AG', idempotencyKey: 'ws' }).workspaceId;
    other.pragma(`user_version = ${NEWER}`);
    for (const call of Object.values(FACES)) {
      const res = call(d, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Nie AG', idempotencyKey: 'c2' });
      assert.equal(res.error, SCHEMA_NEWER_THAN_RUNTIME);
      assert.equal(res.partial, false);
      assert.equal(res.completed, false);
      assert.match(res.message, /The book was not changed/);
    }
  } finally {
    store.close();
    other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A Studio world on a real file, the clock on the fixture day the recurring and automation ticks use. */
function tickWorld(dir) {
  const path = join(dir, 'book.db');
  const clock = fixedClock('2026-07-16T09:00:00.000Z');
  const store = new SqliteStore({ location: path, clock });
  const other = new Database(path);
  const deps = { store, clock, ids: systemIdGen, actor: 'studio' };
  const workspaceId = getAction('create_workspace').run(deps, { name: 'Tick Beispiel AG', idempotencyKey: 'ws' }).workspaceId;
  const call = (verb, input) => {
    const r = getAction(verb).run(deps, { workspaceId, ...input });
    assert.equal(r.ok, true, `${verb}: ${JSON.stringify(r).slice(0, 300)}`);
    return r;
  };
  return { path, store, other, deps, workspaceId, call };
}

test('R4-2: run_due_recurring that swallowed a refusal after its first invoice says PART was saved, never the whole call (critic probe)', () => {
  const dir = tempDir();
  const w = tickWorld(dir);
  try {
    const c = w.call('create_contact', { partyRole: 'customer', name: 'Tick Serie AG', idempotencyKey: 'c' });
    for (const k of ['a', 'b', 'c']) {
      w.call('create_recurring_schedule', {
        contactId: c.contact.id, lines: [{ description: `Beratung ${k}`, unitPriceMinor: 200000 }], interval: 'monthly',
        anchorDate: '2026-07-16', idempotencyKey: `rs-${k}`,
      });
    }
    const documentsBefore = w.other.prepare('SELECT COUNT(*) AS n FROM document').get().n;
    // The newer TILL migrates at the first marker read outside a transaction once this tick has
    // written, i.e. after the first invoice committed: the tick refuses the rest item by item, and
    // answers ok with per-item failures, as it does for any failure.
    const refusalsBefore = w.store.refusalCount();
    const restore = newerTillAfterFirstWrite(w.store, w.other);
    const res = getAction('run_due_recurring').run(w.deps, { workspaceId: w.workspaceId, asOf: '2026-07-16T09:00:00.000Z' });
    restore();
    assert.ok(w.store.refusalCount() > refusalsBefore + 1, 'premise: the tick met and swallowed refusals before the registry`s own check');
    assert.equal(w.other.prepare('SELECT COUNT(*) AS n FROM document').get().n, documentsBefore + 1, 'premise: ONE invoice of three was saved');
    assert.equal(res.ok, false);
    assert.equal(res.error, SCHEMA_NEWER_THAN_RUNTIME);
    assert.equal(res.partial, true);
    assert.equal(res.completed, false, 'the tick did not finish its work, so it is not reported as saved whole');
    assert.match(res.message, /Part of this call was already saved/);
    assert.doesNotMatch(res.message, /This call was saved before that/);
  } finally {
    w.store.close();
    w.other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A regression guard, NOT the proof of the R4-2 counter: this tick settles its run after the fired
// action, the settle meets the moved-on book and throws out of the tick, so the answer comes from the
// registry's throw path (never `completed`) with or without the counter. The proof that bites is the
// next test, where the refusal IS swallowed and the verb answers ok.
test('R4-2 (throw path): run_due_automations whose fired action is refused mid-tick is never reported as saved whole', () => {
  const dir = tempDir();
  const w = tickWorld(dir);
  try {
    const created = w.call('create_automation_rule', {
      name: 'Täglich ein Artikel', trigger: { event: 'schedule.daily' },
      action: { tool: 'create_item', inputTemplate: { name: 'Täglich', defaultUnitPriceMinor: 0 } }, idempotencyKey: 'rda-create',
    });
    w.call('enable_automation_rule', { ruleId: created.rule.ruleId });
    const restore = newerTillAfterFirstWrite(w.store, w.other);
    const res = getAction('run_due_automations').run(w.deps, { workspaceId: w.workspaceId, asOf: '2026-07-16T09:00:00.000Z' });
    restore();
    assert.equal(w.other.pragma('user_version', { simple: true }), NEWER, 'premise: the book moved on mid-tick');
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, SCHEMA_NEWER_THAN_RUNTIME);
    assert.equal(res.partial, true, 'the run row was claimed before the move');
    assert.equal(res.completed, false);
    assert.equal(w.other.prepare("SELECT COUNT(*) AS n FROM item WHERE name = 'Täglich'").get().n, 0, 'the fired action wrote nothing into the newer book');
  } finally {
    w.store.close();
    w.other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The swallowed path that bites (fails with `completed = outcome.ok`, i.e. without the counter): the
// G01 dispatch after a write verb swallows every error (an automation must never fail the business
// event it reacts to), so a refusal raised while the verb's own rule fires leaves the verb answering
// ok. The verb itself was saved whole, but what it set in motion was not: the run was claimed and
// never settled, and the rule's action wrote nothing. So the call is reported as saved in part, and
// its sentence asks the person to check before repeating, never "saved, do not repeat" (which would
// hide the lost reaction) and never "not changed" (which would hide the saved contact).
test('R4-2: a write whose automation reaction is refused after the write committed is reported as saved in part, never whole', () => {
  const dir = tempDir();
  const w = tickWorld(dir);
  try {
    const created = w.call('create_automation_rule', {
      name: 'Neuer Kunde, neuer Artikel', trigger: { event: 'contact.created' },
      action: { tool: 'create_item', inputTemplate: { name: 'Reaktion', defaultUnitPriceMinor: 0 } }, idempotencyKey: 'react-create',
    });
    w.call('enable_automation_rule', { ruleId: created.rule.ruleId });
    const restore = newerTillAfterFirstWrite(w.store, w.other);
    const res = getAction('create_contact').run(w.deps, {
      workspaceId: w.workspaceId, partyRole: 'customer', name: 'Ausgelöst AG', idempotencyKey: 'react-contact',
    });
    restore();
    assert.equal(w.other.pragma('user_version', { simple: true }), NEWER, 'premise: the book moved on during the call');
    assert.equal(w.other.prepare("SELECT COUNT(*) AS n FROM contact WHERE name = 'Ausgelöst AG'").get().n, 1, 'premise: the verb committed');
    assert.equal(w.other.prepare("SELECT COUNT(*) AS n FROM item WHERE name = 'Reaktion'").get().n, 0, 'premise: the reaction wrote nothing');
    assert.equal(w.other.prepare("SELECT COUNT(*) AS n FROM automation_run WHERE status = 'running'").get().n, 1, 'premise: the run was claimed, never settled');
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, SCHEMA_NEWER_THAN_RUNTIME);
    assert.equal(res.partial, true);
    assert.equal(res.completed, false, 'a refusal raised during the call, even one the dispatch swallowed, means it did not complete');
    assert.match(res.message, /Part of this call was already saved/);
  } finally {
    w.store.close();
    w.other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- R4-3: mail_reindex reads the mail client's files before it takes the write lock ------------------

test('R4-3: mail_reindex walks the mail store BEFORE it takes the write lock, and a replay does not walk again', () => {
  const dir = tempDir();
  const w = tickWorld(dir);
  const root = tempStoreDir();
  const adapter = ADAPTERS.thunderbird;
  const walk = adapter.walk;
  const during = [];
  try {
    makeMaildirStore(root, sampleMessages());
    const account = w.call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'r43-c' });
    // What the other process (D12's second writer) meets while the walk runs: can it take the write
    // lock at once? A zero busy timeout answers without waiting.
    adapter.walk = (storePath) => {
      const probe = new Database(w.path, { timeout: 0 });
      try {
        probe.exec('BEGIN IMMEDIATE');
        probe.exec('ROLLBACK');
        during.push('free');
      } catch (e) {
        during.push(e.code ?? String(e));
      } finally {
        probe.close();
      }
      return walk.call(adapter, storePath);
    };
    const first = w.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'r43-r' });
    assert.equal(first.indexed, 4, 'the walk still feeds the index');
    assert.deepEqual(during, ['free'], 'the write lock was free while the mail store was read');
    const replay = w.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'r43-r' });
    assert.deepEqual(replay, first, 'the replay answers the stored result');
    assert.equal(during.length, 1, 'and does not walk the mail store again');
    const keyless = w.call('mail_reindex', { accountId: account.accountId });
    assert.equal(keyless.indexed, 4);
    assert.deepEqual(during, ['free', 'free'], 'the key-less path walks outside the lock too');
  } finally {
    adapter.walk = walk;
    w.store.close();
    w.other.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// --- R5-2: a reindex whose walk went stale while another process reindexed ----------------------------

test('R5-2: a reindex whose walk went stale under another process`s reindex walks again under the lock, and keeps what the other indexed', () => {
  const dir = tempDir();
  const w = tickWorld(dir);
  const root = tempStoreDir();
  const adapter = ADAPTERS.thunderbird;
  const walk = adapter.walk;
  // D12's second process: its own connection to the same book, its own deps.
  const other = new SqliteStore({ location: w.path, clock: fixedClock('2026-07-16T09:00:00.000Z') });
  const otherDeps = { store: other, clock: fixedClock('2026-07-16T09:00:00.000Z'), ids: systemIdGen, actor: 'studio' };
  const count = (sql, ...params) => w.other.prepare(sql).get(...params).n;
  try {
    makeMaildirStore(root, sampleMessages());
    const account = w.call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'r52-c' });
    assert.equal(w.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'r52-0' }).indexed, 4);
    let walks = 0;
    let interleaved = false;
    adapter.walk = (storePath) => {
      walks += 1;
      const snapshot = walk.call(adapter, storePath);
      if (!interleaved) {
        interleaved = true;
        // After this walk read the store: a new message X lands, the other process reindexes it and
        // drafts a reply on its new thread (the critic's r5-reindex-toctou interleaving).
        writeFileSync(join(root, 'INBOX', 'cur', '2000.fixture:2,S'), rfc822({
          from: 'Klient Muster <klient@example.org>', to: 'praxis@example.ch', subject: 'Neue Anfrage',
          messageId: 'r52-x@example.org', date: 'Thu, 16 Jul 2026 08:00:00 +0200', body: 'Guten Tag, eine neue Frage.',
        }));
        const b = getAction('mail_reindex').run(otherDeps, { workspaceId: w.workspaceId, accountId: account.accountId, idempotencyKey: 'r52-b' });
        assert.equal(b.indexed, 5, `premise: the other process indexed X: ${JSON.stringify(b)}`);
        const threadId = w.other.prepare("SELECT thread_id AS id FROM mail_message WHERE message_id = 'r52-x@example.org'").get().id;
        const drafted = getAction('mail_draft_write').run(otherDeps, { workspaceId: w.workspaceId, threadId, body: 'Gerne.', idempotencyKey: 'r52-d' });
        assert.equal(drafted.ok, true, `premise: the other process drafted on X's thread: ${JSON.stringify(drafted)}`);
      }
      return snapshot;
    };
    const a = w.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'r52-a' });
    assert.equal(count("SELECT COUNT(*) AS n FROM mail_message WHERE message_id = 'r52-x@example.org'"), 1, 'X stays indexed');
    assert.equal(count('SELECT COUNT(*) AS n FROM mail_draft'), 1, 'the draft on X`s thread survives');
    assert.equal(a.removed, 0, 'nothing anybody deleted is reported removed');
    assert.equal(a.indexed, 5);
    assert.equal(walks, 3, 'this reindex walked twice (the second under the lock), the other once');
  } finally {
    adapter.walk = walk;
    other.close();
    w.store.close();
    w.other.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 5. delete_backup waits for the lock (R3-3, critic probe q15) ------------------------------------

test('R3-3: delete_backup under another process`s held lock waits and then deletes, row and bundle (q15)', async () => {
  const dir = tempDir();
  const path = join(dir, 'book.db');
  const store = new SqliteStore({ location: path });
  try {
    const d = { store, clock: systemClock, ids: systemIdGen, actor: 'studio', backupDir: join(dir, 'bk') };
    const workspaceId = getAction('create_workspace').run(d, { name: 'Sicherung AG', idempotencyKey: 'ws' }).workspaceId;
    const b = getAction('create_backup').run(d, { workspaceId, idempotencyKey: 'b1' });
    assert.equal(b.ok, true, JSON.stringify(b));
    const backupId = b.backupId ?? b.backup?.id;
    const ref = store.db.prepare('SELECT storage_ref FROM backups WHERE id = ?').get(backupId).storage_ref;
    assert.equal(existsSync(ref), true, 'premise: the bundle is on disk');
    const holder = await lockHolder(path, { holdMs: 300 });
    assert.equal(holder.take(), true, 'premise: the other process holds the write lock');
    const t0 = performance.now();
    const r = getAction('delete_backup').run(d, { workspaceId, backupId, idempotencyKey: 'del1' });
    const waited = performance.now() - t0;
    await holder.done;
    assert.equal(r.ok, true, `waited for the lock instead of store_busy: ${JSON.stringify(r)}`);
    assert.ok(waited >= 150, `it waited (${Math.round(waited)} ms)`);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM backups WHERE id = ?').get(backupId).n, 0, 'row deleted');
    assert.equal(existsSync(ref), false, 'bundle deleted');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 6. a hot rollback journal (R3-4, critic probe q16) ------------------------------------------------

/** A current-schema book at `generation`, switched back to rollback-journal mode (a pre-WAL file). */
function rollbackJournalBook(path, generation) {
  new SqliteStore({ location: path }).close();
  const raw = new Database(path);
  raw.pragma('journal_mode = DELETE');
  if (generation !== SCHEMA_GENERATION) raw.pragma(`user_version = ${generation}`);
  raw.close();
}

/** A writer that dies mid-transaction after spilling pages into the main file: the -journal stays, hot. */
function crashMidTransaction(path) {
  const r = spawnSync(process.execPath, ['-e', `
    const Database = require(${JSON.stringify(DRIVER)});
    const db = new Database(${JSON.stringify(path)});
    db.pragma('cache_size = 1');
    db.exec('BEGIN');
    db.prepare("UPDATE workspace SET name = name").run();
    db.exec("CREATE TABLE junk (x BLOB)");
    const ins = db.prepare('INSERT INTO junk VALUES (randomblob(4096))');
    for (let i = 0; i < 2000; i++) ins.run();
    process.kill(process.pid, 'SIGKILL');`], { stdio: 'inherit' });
  assert.equal(r.signal, 'SIGKILL', 'premise: the writer died mid-transaction');
  assert.equal(existsSync(`${path}-journal`), true, 'premise: a hot journal is left behind');
}

test('R3-4: a book with a hot rollback journal opens again, rolled back to its last commit (q16)', () => {
  const dir = tempDir();
  const path = join(dir, 'book.db');
  try {
    rollbackJournalBook(path, SCHEMA_GENERATION);
    crashMidTransaction(path);
    const store = new SqliteStore({ location: path });
    try {
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'junk'").get().n, 0, 'the dead transaction was rolled back');
      store.db.prepare('INSERT INTO idempotency (workspace_id, key, verb, result_json, created_at) VALUES (?, ?, ?, ?, ?)').run('_system', 'k', 'v', '{}', AT);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-4: a NEWER book with a hot rollback journal is still refused: rolled back to its last commit, marker kept, nothing written', () => {
  const dir = tempDir();
  const path = join(dir, 'book.db');
  try {
    rollbackJournalBook(path, NEWER);
    const committed = sha(path);
    crashMidTransaction(path);
    assert.notEqual(sha(path), committed, 'premise: the dead writer spilled into the main file');
    assert.throws(() => new SqliteStore({ location: path }), isRefusal);
    assert.equal(sha(path), committed, 'the main file is exactly its last committed content: the rollback and nothing else');
    const ro = new Database(path, { readonly: true });
    try {
      assert.equal(ro.pragma('user_version', { simple: true }), NEWER, 'the marker was never lowered');
      assert.equal(ro.pragma('journal_mode', { simple: true }), 'delete', 'no WAL switch ran');
    } finally {
      ro.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 7. the audit chain under a second writer (OUT-1, critic probe q19) ----------------------------------

test('OUT-1: a key-less audited write interleaved with another process`s audited post keeps the chain verified (q19)', async () => {
  const dir = tempDir();
  const path = join(dir, 'book.db');
  const trigger = join(dir, 'go');
  const done = join(dir, 'done');
  const store = new SqliteStore({ location: path });
  try {
    const d = { store, clock: systemClock, ids: systemIdGen, actor: 'studio' };
    const workspaceId = getAction('create_workspace').run(d, { name: 'Kette AG', idempotencyKey: 'ws' }).workspaceId;
    const acc = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
    const before = getAction('get_audit_log').run(d, { workspaceId });
    assert.equal(before.chainVerified, true);
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      const { getAction } = await import(${JSON.stringify(DIST('api/registry.js'))});
      const { SqliteStore } = await import(${JSON.stringify(DIST('core/store/sqlite-store.js'))});
      const { systemIdGen } = await import(${JSON.stringify(DIST('core/ids.js'))});
      const { systemClock } = await import(${JSON.stringify(DIST('core/clock.js'))});
      const store = new SqliteStore({ location: ${JSON.stringify(path)} });
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const end = Date.now() + 20000;
      while (!fs.existsSync(${JSON.stringify(trigger)}) && Date.now() < end) sleep(1);
      const r = getAction('post_entry').run({ store, clock: systemClock, ids: systemIdGen, actor: 'studio' }, {
        workspaceId: ${JSON.stringify(workspaceId)}, date: '2026-03-01', description: 'Zweiter Prozess', source: 'import', idempotencyKey: 'ag-1',
        lines: [{ account: ${JSON.stringify(acc('6500'))}, debit: 100 }, { account: ${JSON.stringify(acc('1000'))}, credit: 100 }] });
      store.close();
      fs.writeFileSync(${JSON.stringify(done)}, r.ok ? 'ok' : r.error);`], { stdio: 'inherit' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    // The other process posts exactly when this one is between reading the audit head and inserting its
    // row. Outside a transaction it gets in and the two rows chain off one head; inside one it has to
    // wait for this append's commit, so this side waits a bounded while and carries on.
    let fired = false;
    let otherPostedMidAppend = false;
    const prepare = store.db.prepare;
    store.db.prepare = function (sql) {
      if (!fired && /INSERT INTO audit_log/.test(sql)) {
        fired = true;
        writeFileSync(trigger, '1');
        const end = Date.now() + 1500;
        while (!existsSync(done) && Date.now() < end) sleep(1);
        otherPostedMidAppend = existsSync(done);
      }
      return prepare.call(this, sql);
    };
    const r = getAction('create_bank_account').run(d, {
      workspaceId, name: 'Hausbank', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: acc('1020'),
    });
    store.db.prepare = prepare;
    await exited;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fired, true, 'premise: the append was reached');
    assert.equal(readFileSync(done, 'utf8'), 'ok', 'the other process posted');
    const after = getAction('get_audit_log').run(d, { workspaceId });
    assert.equal(after.rows.length, before.rows.length + 2, 'both appends are in the chain');
    assert.equal(after.chainVerified, true, 'the hash chain did not fork');
    assert.equal(otherPostedMidAppend, false, 'because the other process could not append inside this append');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
