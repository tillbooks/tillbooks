// THE DURABILITY CONTRACT, held in place: every WRITABLE, FILE-BACKED connection the engine opens
// commits with `synchronous = EXTRA` (identical to FULL in WAL mode, and still durable should the WAL
// switch ever not take) and, on macOS, with F_FULLFSYNC (`fullfsync` and `checkpoint_fullfsync` ON),
// on EVERY open; a brand-new ledger, and a new ledger directory, also get their directory entries
// synced. The reasoning and the measurements are on `applyDurableSync` in
// src/core/store/sqlite-store.ts.
//
// The case that matters most is the REOPEN of an existing ledger. SQLite applies better-sqlite3's
// compiled-in `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` whenever a connection reads a WAL header, unless the
// connection set `synchronous` itself. Before this suite existed that was every `till up`, `till serve`
// and `till mcp` session: WAL at NORMAL does not sync at commit, so a power cut could undo entries the
// user had already seen as posted.
//
// The node harness sets TILL_TEST_NO_FULLFSYNC=1 so the suites do not queue on the drive-cache flush.
// This file clears it first, because what it asserts IS the production configuration, and then proves
// the relaxation can never reach a process the test runner did not spawn.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, openSync, readSync, closeSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';

import Database from 'better-sqlite3';
import ts from 'typescript';

import { SqliteStore, applyDurableSync, TEST_NO_FULLFSYNC_ENV } from '../../dist/core/store/sqlite-store.js';
import { makeApiDeps } from '../../dist/api/mcp.js';
import { ensureDbPath } from '../../dist/api/db-path.js';
import { createWorkspace } from '../../dist/core/setup/workspace.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { createBackup, verifyBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { envCreate, envCopy } from '../../dist/core/landscape/index.js';

// Production configuration from here on (see the header).
delete process.env[TEST_NO_FULLFSYNC_ENV];

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DARWIN = process.platform === 'darwin';
const AT = '2026-09-24T00:00:00.000Z';
const clock = { now: () => AT };

function tempDir(prefix = 'till-durable-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function syncState(db) {
  return {
    journalMode: db.pragma('journal_mode', { simple: true }),
    synchronous: db.pragma('synchronous', { simple: true }),
    fullfsync: db.pragma('fullfsync', { simple: true }),
    checkpointFullfsync: db.pragma('checkpoint_fullfsync', { simple: true }),
  };
}

/** `PRAGMA synchronous` reports EXTRA as 3 (OFF 0, NORMAL 1, FULL 2, EXTRA 3). */
const EXTRA = 3;

/** The contract for one connection. The F_FULLFSYNC half only exists on macOS, so it is only asserted there. */
function assertDurable(state, label) {
  assert.equal(state.synchronous, EXTRA, `${label}: synchronous must be EXTRA (3), got ${state.synchronous}`);
  if (DARWIN) {
    assert.equal(state.fullfsync, 1, `${label}: fullfsync must be ON on macOS, or a commit stops in the drive cache`);
    assert.equal(state.checkpointFullfsync, 1, `${label}: checkpoint_fullfsync must be ON on macOS`);
  }
}

/** Bytes 18/19 of the header: 2/2 means the FILE says WAL, which is what triggers SQLite's WAL default. */
function headerSaysWal(path) {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(20);
    readSync(fd, header, 0, 20, 0);
    return header[18] === 2 && header[19] === 2;
  } finally {
    closeSync(fd);
  }
}

function seedWorkspace(store, name = 'Durabel AG') {
  const res = createWorkspace({ store, clock, ids: systemIdGen, actor: 'owner' }, { name });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.workspaceId;
}

// --- 1. the premise --------------------------------------------------------------------------------

test('premise: a raw connection re-opening a WAL file lands at NORMAL with no F_FULLFSYNC, which is what the store overrides', () => {
  // If this ever starts failing, the driver's default moved. The store's explicit pragmas stay correct
  // either way, but the reasoning on `applyDurableSync` would then deserve a re-read.
  const dir = tempDir();
  try {
    const file = join(dir, 'raw.db');
    const first = new Database(file);
    first.pragma('journal_mode = WAL');
    first.exec('CREATE TABLE t (x INTEGER)');
    first.prepare('INSERT INTO t VALUES (1)').run();
    // The trap inside the trap: even the CREATING session has already dropped to NORMAL here, because
    // its first commit wrote a WAL header and the next transaction re-read it.
    assert.equal(first.pragma('synchronous', { simple: true }), 1, 'the creating session drops to NORMAL after its first commit');
    first.close();
    assert.equal(headerSaysWal(file), true);

    const reopened = new Database(file);
    const state = syncState(reopened);
    reopened.close();
    assert.equal(state.journalMode, 'wal');
    assert.equal(state.synchronous, 1, 'SQLITE_DEFAULT_WAL_SYNCHRONOUS=1 applies on reopen');
    assert.equal(state.fullfsync, 0, 'fullfsync defaults OFF');
    assert.equal(state.checkpointFullfsync, 0, 'checkpoint_fullfsync defaults OFF');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 2. the store, on every way it is opened -------------------------------------------------------

test('a REOPENED ledger file commits durably, and stays durable across its own commits', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'till.db');
    const creating = new SqliteStore({ location: file });
    assertDurable(syncState(creating.db), 'the creating session, before any write');
    seedWorkspace(creating);
    // The raw premise above drops to NORMAL right here; the store must not.
    assertDurable(syncState(creating.db), 'the creating session, after its first commits');
    creating.close();
    assert.equal(headerSaysWal(file), true, 'the file must really be WAL, or the reopen below proves nothing');

    const reopened = new SqliteStore({ location: file });
    const state = syncState(reopened.db);
    assert.equal(state.journalMode, 'wal');
    assertDurable(state, 'new SqliteStore({ location }) on an existing WAL file');
    seedWorkspace(reopened, 'Zweite GmbH');
    assertDurable(syncState(reopened.db), 'the reopened session, after a commit');
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, 2, 'both workspaces are on the file');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the production factory behind `till up`, `till serve` and `till mcp` opens durably, new file and reopen', () => {
  // All three entry points call makeApiDeps(ensureDbPath()) (bin/till.mjs -> up.ts / serve.ts / mcp.ts).
  const dir = tempDir();
  try {
    const file = join(dir, 'till.db');
    const created = makeApiDeps(file);
    assertDurable(syncState(created.store.db), 'makeApiDeps on a NEW file');
    seedWorkspace(created.store);
    created.store.close();

    const reopened = makeApiDeps(file);
    assertDurable(syncState(reopened.store.db), 'makeApiDeps on an EXISTING file (every later session)');
    reopened.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every WRITABLE file connection the engine opens and closes internally is durable (backup, restore, landscape)', () => {
  // These connections live and die inside the engine, so the pragmas are read at the moment each one
  // closes, through better-sqlite3's shared prototype. The engine is not modified to be observed.
  const dir = tempDir();
  const liveFile = join(dir, 'till.db');
  const seen = [];
  const originalClose = Database.prototype.close;
  Database.prototype.close = function recordingClose() {
    if (this.open) seen.push({ name: this.name, readonly: this.readonly, memory: this.memory, ...syncState(this) });
    return originalClose.call(this);
  };
  try {
    // G04: backup from, verify, and restore into a live file store.
    const live = new SqliteStore({ location: liveFile });
    const workspaceId = seedWorkspace(live);
    const deps = { store: live, clock, ids: systemIdGen, actor: 'owner', backupDir: join(dir, 'backups') };
    const backup = createBackup(deps, { workspaceId, idempotencyKey: 'durable-backup' });
    assert.equal(backup.ok, true, JSON.stringify(backup));
    assert.equal(verifyBackup(deps, { source: backup.artifactRef }).ok, true);
    const restored = restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Wiederhergestellt AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    live.close();

    // N00: a live-policy build, a seeded synthetic build, and an instance copy between them (the copy
    // opens a scratch source store, a building store, a snapshot, a restore and read-only gates).
    const landscape = {
      supportDir: join(dir, 'support'),
      environmentsRoot: join(dir, 'environments'),
      mainDbPath: liveFile,
      actor: 'owner',
      now: () => AT,
      seeders: {
        mitMandant: (path) => {
          const store = new SqliteStore({ location: path });
          seedWorkspace(store, 'Quelle AG');
          store.close();
        },
      },
      ids: systemIdGen,
      clock,
    };
    const target = envCreate(landscape, { name: 'ziel', policy: 'live', tierRank: 40, confirmed: true });
    assert.equal(target.ok, true, JSON.stringify(target));
    const source = envCreate(landscape, { name: 'quelle', policy: 'synthetic', seed: 'mitMandant', tierRank: 250, confirmed: true });
    assert.equal(source.ok, true, JSON.stringify(source));
    const copied = envCopy(landscape, { source: 'quelle', target: 'ziel', scope: 'instance', sanitize: 'raw', confirmed: true });
    assert.equal(copied.ok, true, JSON.stringify(copied));
  } finally {
    Database.prototype.close = originalClose;
    rmSync(dir, { recursive: true, force: true });
  }

  const onFile = seen.filter((c) => !c.memory);
  const writable = onFile.filter((c) => !c.readonly);
  // The G04 snapshot destination is the one raw writable open the guard below lists as a known gap.
  const snapshot = (c) => /[\\/]\.tmp-[^\\/]+[\\/]data\.sqlite$/.test(c.name);

  // Non-vacuity: the flows really went through every kind of connection this test is about.
  const kinds = {
    'the live store': writable.some((c) => c.name === liveFile),
    'a landscape build (.building)': writable.some((c) => c.name.endsWith('.building')),
    'the copy scratch source store': writable.some((c) => c.name.endsWith('source.db')),
    'the G04 snapshot destination': writable.some(snapshot),
    'a read-only open': onFile.some((c) => c.readonly),
  };
  for (const [kind, present] of Object.entries(kinds)) assert.equal(present, true, `the flows never opened ${kind}`);

  for (const c of writable.filter((w) => !snapshot(w))) {
    assertDurable(c, `writable connection on ${relative(tmpdir(), c.name)}`);
  }
});

// --- 3. what is deliberately left alone --------------------------------------------------------------

test('an in-memory store is untouched: exactly what the driver gives a raw :memory: connection', () => {
  const raw = new Database(':memory:');
  const driver = syncState(raw);
  raw.close();
  const store = new SqliteStore();
  const state = syncState(store.db);
  store.close();
  assert.deepEqual(state, driver);
  assert.equal(state.fullfsync, 0, 'there is no disk to flush');
});

test('applyDurableSync is a no-op on an in-memory and on a read-only connection', () => {
  const memory = new Database(':memory:');
  const before = syncState(memory);
  applyDurableSync(memory);
  assert.deepEqual(syncState(memory), before);
  memory.close();

  const dir = tempDir();
  try {
    const file = join(dir, 'till.db');
    new SqliteStore({ location: file }).close();
    const readonly = new Database(file, { readonly: true });
    const ro = syncState(readonly);
    applyDurableSync(readonly);
    assert.deepEqual(syncState(readonly), ro, 'a read-only connection cannot commit, so it has nothing to sync');
    readonly.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 4. the one-transaction build of a brand-new file ---------------------------------------------------

test('a brand-new file, built in one transaction, carries exactly the schema of the in-memory template', () => {
  const describe = (db) => ({
    objects: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all(),
    generation: db.pragma('user_version', { simple: true }),
  });
  const memory = new SqliteStore();
  const expected = describe(memory.db);
  memory.close();

  const dir = tempDir();
  try {
    const store = new SqliteStore({ location: join(dir, 'till.db') });
    const actual = describe(store.db);
    store.close();
    assert.ok(expected.objects.length > 100, 'the template must hold the real schema for the comparison to mean anything');
    assert.equal(actual.generation, expected.generation, 'the data migrations ran to the current generation');
    assert.deepEqual(actual.objects, expected.objects);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second process creating the same new ledger WAITS at the WAL switch instead of failing SQLITE_BUSY', async () => {
  // The first-run race between the Studio and `till mcp`, made deterministic: another process holds
  // the write lock of a brand-new file while this one opens it. The WAL switch is a read-to-write
  // upgrade, which SQLite's busy handler never waits on, so without `switchToWal`'s retry this open
  // throws SQLITE_BUSY at once. With it, the open waits for the lock and builds the ledger.
  const dir = tempDir();
  const file = join(dir, 'till.db');
  const holdMs = 1500;
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "import Database from 'better-sqlite3';",
        `const db = new Database(${JSON.stringify(file)});`,
        "db.exec('BEGIN IMMEDIATE');",
        "process.stdout.write('locked\\n');",
        `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});`,
        "db.exec('ROLLBACK');",
        'db.close();',
      ].join('\n'),
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.on('data', (chunk) => {
        if (String(chunk).includes('locked')) resolve(undefined);
      });
      holder.on('exit', (code) => reject(new Error(`the lock holder exited early (${code})`)));
    });
    // Non-vacuity: the other process really holds the write lock as this open starts.
    const probe = new Database(file, { timeout: 0 });
    assert.throws(() => probe.exec('BEGIN IMMEDIATE'), (e) => e.code === 'SQLITE_BUSY', 'the file must be write-locked by the other process');
    probe.close();

    const store = new SqliteStore({ location: file });
    const state = syncState(store.db);
    const objects = store.db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n;
    store.close();
    assert.equal(state.journalMode, 'wal');
    assertDurable(state, 'the store that waited for the lock');
    assert.ok(objects > 100, 'the waiting process built the full schema once the lock was free');
  } finally {
    holder.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 4b. directory entries: a new ledger and a new ledger directory are findable after a power cut ------

/**
 * Run `fn` and return the path of every directory (or file) it fsynced through node:fs, with the
 * size of `watch` at that moment. The store and `ensureDbPath` import `openSync`/`fsyncSync` from
 * node:fs as live ESM bindings, which `syncBuiltinESMExports` repoints at these wrappers; SQLite's
 * own syncs happen in native code and never show up here, so what is recorded is exactly the
 * engine's explicit directory syncs.
 */
function recordFsyncs(fn, watch) {
  const fs = createRequire(import.meta.url)('node:fs');
  const original = { openSync: fs.openSync, fsyncSync: fs.fsyncSync };
  const opened = new Map();
  const synced = [];
  fs.openSync = function recordingOpen(path, ...rest) {
    const fd = original.openSync.call(this, path, ...rest);
    opened.set(fd, String(path));
    return fd;
  };
  fs.fsyncSync = function recordingFsync(fd) {
    synced.push({ path: opened.get(fd) ?? `fd ${fd}`, watchedSize: watch !== undefined && existsSync(watch) ? statSync(watch).size : null });
    return original.fsyncSync.call(this, fd);
  };
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    Object.assign(fs, original);
    syncBuiltinESMExports();
  }
  return synced;
}

test('a brand-new ledger file gets its directory synced ONCE, before anything commits into it; a reopen syncs none', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'till.db');
    const onCreate = recordFsyncs(() => new SqliteStore({ location: file }).close(), file);
    assert.deepEqual(
      onCreate.map((s) => s.path),
      [dir],
      'SQLite never syncs the main database file`s directory entry, so the store must, exactly once',
    );
    assert.equal(onCreate[0]?.watchedSize, 0, 'the entry is synced before the first commit writes a byte into the file');

    const onReopen = recordFsyncs(() => new SqliteStore({ location: file }).close(), file);
    assert.deepEqual(onReopen, [], 'an existing ledger has a durable entry already: a reopen pays nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDbPath creates a missing ledger directory DURABLY (each new directory`s parent synced), and an existing one for free', () => {
  const root = tempDir();
  try {
    const path = join(root, 'home', '.till', 'till.db');
    const first = recordFsyncs(() => assert.equal(ensureDbPath({ TILL_DB_PATH: path }), path));
    assert.equal(existsSync(join(root, 'home', '.till')), true);
    assert.deepEqual(
      first.map((s) => s.path),
      [root, join(root, 'home')],
      'both new directories must be durable: `home` in root, then `.till` in home, outermost first',
    );
    const again = recordFsyncs(() => ensureDbPath({ TILL_DB_PATH: path }));
    assert.deepEqual(again, [], 'an existing directory is neither created nor synced again');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 5. the test-harness relaxation cannot reach production ---------------------------------------------

test('TILL_TEST_NO_FULLFSYNC is ignored outside the node:test runner, and never lowers synchronous', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'till.db');
    new SqliteStore({ location: file }).close();

    // A plain `node` process, the shape of `till up`: the variable is set, the runner context is not
    // (absent, and exported EMPTY, which a shell can do by accident).
    const probe = [
      `const { makeApiDeps } = await import(${JSON.stringify(join(ROOT, 'dist/api/mcp.js'))});`,
      `const { store } = makeApiDeps(${JSON.stringify(file)});`,
      `const p = (n) => store.db.pragma(n, { simple: true });`,
      `console.log(JSON.stringify({ synchronous: p('synchronous'), fullfsync: p('fullfsync'), checkpointFullfsync: p('checkpoint_fullfsync') }));`,
      `store.close();`,
    ].join('\n');
    for (const [label, context] of [['absent', undefined], ['empty', '']]) {
      const env = { ...process.env, [TEST_NO_FULLFSYNC_ENV]: '1' };
      if (context === undefined) delete env.NODE_TEST_CONTEXT;
      else env.NODE_TEST_CONTEXT = context;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { env, encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      const reported = JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '');
      assertDurable(reported, `a production process with TILL_TEST_NO_FULLFSYNC=1 and NODE_TEST_CONTEXT ${label}`);
    }

    // Inside this runner-spawned process the relaxation applies, and it drops ONLY the F_FULLFSYNC flags.
    process.env[TEST_NO_FULLFSYNC_ENV] = '1';
    try {
      const relaxed = new SqliteStore({ location: file });
      const state = syncState(relaxed.db);
      relaxed.close();
      assert.equal(state.synchronous, EXTRA, 'the relaxation must never lower synchronous');
      if ((process.env.NODE_TEST_CONTEXT ?? '') !== '') {
        assert.equal(state.fullfsync, 0, 'under the runner, with the variable set, F_FULLFSYNC is skipped');
        assert.equal(state.checkpointFullfsync, 0);
      } else {
        assertDurable(state, 'run outside the node:test runner');
      }
    } finally {
      delete process.env[TEST_NO_FULLFSYNC_ENV];
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 6. no future open can skip the choke point ----------------------------------------------------------

/**
 * WHERE THE GUARD LOOKS: everything that can open a ledger outside a test. The engine (src/), the CLI
 * (bin/), the repo tooling (scripts/, ops/) and the Studio's dev bridge (app/dev-api.ts).
 */
const SCAN_DIRS = ['src', 'bin', 'scripts', 'ops'];
const SCAN_FILES = ['app/dev-api.ts'];

/**
 * THE MODULES THAT MAY LOAD A SQLITE DRIVER AT ALL. A load is any runtime way in: a value import,
 * `import * as`, `import { default as ... }`, `require` or a `createRequire` require, a dynamic
 * `import()`, `import x = require()`, a re-export, and it counts for `better-sqlite3`, `node:sqlite` and
 * any other bare specifier naming sqlite. `import type` is erased and is not a load. A load anywhere
 * else fails outright, so a new way to the disk cannot land without a decision written down here.
 */
const DRIVER_MODULES = {
  'src/core/store/sqlite-store.ts': 'THE choke point: every store open is durable by construction',
  'src/core/data/portability.ts': 'G04: read-only snapshot reads, plus the snapshot destination in LISTED_OPENS',
  'src/core/landscape/operations.ts': 'N00: a read-only gate over a freshly built environment',
  'src/core/landscape/copy.ts': 'N00: read-only probes and gates over environment files',
  'ops/private-data-scan.mjs':
    'the private-data guard reads the owner\'s live ledger and TILL backups to fingerprint them: read-only opens only, never a write',
};

/**
 * Inside those modules, an open is fine without an entry when it is READ-ONLY (a literal
 * `{ readonly: true }`, node:sqlite's `{ readOnly: true }`, with no spread or computed key that could
 * switch it back), IN-MEMORY (`':memory:'`, `''` or no argument), or DURABLE (the very next statement
 * is `applyDurableSync(<the same target>)`). Every other open is listed here by file, function AND
 * exact call, and each entry must match exactly one open: a second open in a listed function, or the
 * listed call written twice, fails.
 */
const LISTED_OPENS = {
  'src/core/store/sqlite-store.ts#constructor': [
    {
      call: 'new Database(freshMemoryTemplate(), { timeout })',
      reason: 'deserializes the pre-built in-memory template Buffer: an anonymous in-memory database, no file',
    },
  ],
  'src/core/data/portability.ts#writeScopedSqlite': [
    {
      call: 'new Database(destPath)',
      reason:
        'KNOWN GAP, owned by G04. The backup snapshot is a throwaway file built in a temp dir and renamed into ' +
        'the .tillbackup bundle; it commits at FULL with a plain fsync, so on macOS a fresh backup can still ' +
        'sit in the drive cache. A pragma alone is the wrong fix: the copy commits once per row, and ' +
        'F_FULLFSYNC there measured 39 s instead of 2.1 s for the Seeblick ledger, while manifest.json and the ' +
        'rename stay unsynced anyway. The fix belongs to G04: build the snapshot in one transaction after ' +
        'applyDurableSync, fsync manifest.json and the directory, then rename.',
    },
  ],
};

const BETTER = 'better-sqlite3';
const NODE_SQLITE = 'node:sqlite';

/**
 * A module specifier that loads a SQLite driver: `node:sqlite`, or a package (optionally scoped, with
 * or without a deep path) whose NAME mentions sqlite: `better-sqlite3`, `better-sqlite3/lib/x.js`,
 * `sqlite3`, `@scope/sqlite`. Our own `./sqlite-store.js` is a path, not a package, and a SQL string
 * that mentions `sqlite_master` is not a package name at all.
 */
function isDriverSpecifier(spec) {
  if (spec === NODE_SQLITE) return true;
  const m = /^(@[a-z0-9][a-z0-9._~-]*\/)?([a-z0-9][a-z0-9._~-]*)(\/.*)?$/.exec(spec);
  return m !== null && /sqlite/.test(`${m[1] ?? ''}${m[2]}`);
}

/** What an import of `spec` yields: a constructor, a module to read the constructor from, or an unknown driver. */
function defaultValueOf(spec) {
  if (spec === BETTER) return { kind: 'ctor', driver: BETTER };
  if (spec === NODE_SQLITE) return { kind: 'module', prop: 'DatabaseSync', driver: NODE_SQLITE };
  return { kind: 'unknown' };
}

function namespaceValueOf(spec) {
  if (spec === BETTER) return { kind: 'module', prop: 'default', driver: BETTER };
  if (spec === NODE_SQLITE) return { kind: 'module', prop: 'DatabaseSync', driver: NODE_SQLITE };
  return { kind: 'unknown' };
}

/** The name of the function an open sits in: a declaration, a method, a constructor, or a function bound to a const. */
function enclosingFunctionName(node) {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name !== undefined) return n.name.getText();
    if (ts.isConstructorDeclaration(n)) return 'constructor';
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
      return n.parent.name.text;
    }
  }
  return '(module)';
}

/**
 * Read one source file the way the guard needs it: every driver LOAD, every OPEN (a `new` or a plain
 * call of a value that resolves to a driver constructor, through imports, requires, dynamic imports,
 * destructuring and aliases), and every place the driver itself ESCAPES the file (exported), where
 * the opens it enables could no longer be seen from here.
 */
function analyse(rel, text) {
  const kind = /\.(m|c)?ts$/.test(rel) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const bindings = new Map();
  const loads = [];
  const opens = [];
  const escapes = [];

  const unwrap = (e) => {
    let x = e;
    while (
      x !== undefined &&
      (ts.isParenthesizedExpression(x) ||
        ts.isAwaitExpression(x) ||
        ts.isAsExpression(x) ||
        ts.isNonNullExpression(x) ||
        ts.isSatisfiesExpression(x) ||
        ts.isTypeAssertionExpression(x))
    ) {
      x = x.expression;
    }
    return x;
  };
  // The names that act as `require` here: `require` itself, whatever `createRequire(...)` returned, and
  // any alias of either. Filled to a fixpoint below, before any load is read.
  const requireNames = new Set(['require']);
  // `require('x')`, `req('x')`, `createRequire(...)('x')`, `import('x')`: a real load, with a driver specifier.
  const loadOf = (e) => {
    const x = unwrap(e);
    if (x === undefined || !ts.isCallExpression(x) || x.arguments.length < 1) return null;
    const [arg] = x.arguments;
    if (arg === undefined || !ts.isStringLiteralLike(arg) || !isDriverSpecifier(arg.text)) return null;
    const callee = unwrap(x.expression);
    const dynamic = x.expression.kind === ts.SyntaxKind.ImportKeyword;
    // `process.getBuiltinModule('node:sqlite')` loads a builtin driver without any import or require.
    const builtinLoad = callee !== undefined && /(^|\.)getBuiltinModule$/.test(callee.getText(source));
    const requireLike = dynamic || builtinLoad || (callee !== undefined && (ts.isCallExpression(callee) || (ts.isIdentifier(callee) && requireNames.has(callee.text))));
    return requireLike ? { spec: arg.text, dynamic } : null;
  };
  const valueOf = (e) => {
    const x = unwrap(e);
    if (x === undefined) return null;
    if (ts.isIdentifier(x)) return bindings.get(x.text) ?? null;
    const load = loadOf(x);
    if (load !== null) return load.dynamic ? namespaceValueOf(load.spec) : defaultValueOf(load.spec);
    if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) {
      const name = ts.isPropertyAccessExpression(x)
        ? x.name.text
        : ts.isStringLiteralLike(x.argumentExpression)
          ? x.argumentExpression.text
          : null;
      const base = valueOf(x.expression);
      if (base?.kind === 'module' && name === base.prop) return { kind: 'ctor', driver: base.driver };
    }
    return null;
  };

  // 1. Static imports, import-equals and re-exports.
  for (const st of source.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteralLike(st.moduleSpecifier) && isDriverSpecifier(st.moduleSpecifier.text)) {
      const spec = st.moduleSpecifier.text;
      const clause = st.importClause;
      if (clause?.isTypeOnly) continue;
      loads.push({ line: lineOf(st), form: `import from '${spec}'` });
      if (clause === undefined) continue;
      if (clause.name !== undefined) bindings.set(clause.name.text, defaultValueOf(spec));
      const named = clause.namedBindings;
      if (named !== undefined && ts.isNamespaceImport(named)) bindings.set(named.name.text, namespaceValueOf(spec));
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          if (el.isTypeOnly) continue;
          const imported = (el.propertyName ?? el.name).text;
          if (spec === BETTER && imported === 'default') bindings.set(el.name.text, { kind: 'ctor', driver: BETTER });
          else if (spec === NODE_SQLITE && imported === 'DatabaseSync') bindings.set(el.name.text, { kind: 'ctor', driver: NODE_SQLITE });
          else if (spec !== BETTER && spec !== NODE_SQLITE) bindings.set(el.name.text, { kind: 'unknown' });
        }
      }
    }
    if (
      ts.isImportEqualsDeclaration(st) &&
      !st.isTypeOnly &&
      ts.isExternalModuleReference(st.moduleReference) &&
      ts.isStringLiteralLike(st.moduleReference.expression) &&
      isDriverSpecifier(st.moduleReference.expression.text)
    ) {
      const spec = st.moduleReference.expression.text;
      loads.push({ line: lineOf(st), form: `import = require('${spec}')` });
      bindings.set(st.name.text, defaultValueOf(spec));
    }
    if (
      ts.isExportDeclaration(st) &&
      !st.isTypeOnly &&
      st.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(st.moduleSpecifier) &&
      isDriverSpecifier(st.moduleSpecifier.text)
    ) {
      loads.push({ line: lineOf(st), form: `re-export from '${st.moduleSpecifier.text}'` });
      escapes.push({ line: lineOf(st), form: `re-exports '${st.moduleSpecifier.text}'` });
    }
  }

  // 2. Every binding a declaration or assignment makes; then who acts as `require`; then every
  //    require / createRequire / import() load.
  const declarations = [];
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) declarations.push({ name: node.name, init: node.initializer });
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      declarations.push({ name: node.left, init: node.right });
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  for (let changed = true; changed; ) {
    changed = false;
    for (const { name, init } of declarations) {
      if (!ts.isIdentifier(name) || requireNames.has(name.text)) continue;
      const x = unwrap(init);
      const makesRequire = x !== undefined && ts.isCallExpression(x) && /(^|\.)createRequire$/.test(x.expression.getText(source));
      const aliasesRequire = x !== undefined && ts.isIdentifier(x) && requireNames.has(x.text);
      if (makesRequire || aliasesRequire) {
        requireNames.add(name.text);
        changed = true;
      }
    }
  }
  const findLoads = (node) => {
    if (ts.isCallExpression(node)) {
      const load = loadOf(node);
      if (load !== null) loads.push({ line: lineOf(node), form: load.dynamic ? `import('${load.spec}')` : `require('${load.spec}')` });
    }
    ts.forEachChild(node, findLoads);
  };
  findLoads(source);
  // Aliases chain (`const D = Database; const E = D;`), so resolve to a fixpoint.
  for (let changed = true; changed; ) {
    changed = false;
    for (const { name, init } of declarations) {
      const value = valueOf(init);
      if (value === null) continue;
      if (ts.isIdentifier(name)) {
        if (!bindings.has(name.text)) {
          bindings.set(name.text, value);
          changed = true;
        }
      } else if (ts.isObjectBindingPattern(name) && value.kind === 'module') {
        for (const el of name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const prop = el.propertyName === undefined ? el.name.text : ts.isIdentifier(el.propertyName) || ts.isStringLiteralLike(el.propertyName) ? el.propertyName.text : null;
          if (prop === value.prop && !bindings.has(el.name.text)) {
            bindings.set(el.name.text, { kind: 'ctor', driver: value.driver });
            changed = true;
          }
        }
      }
    }
  }

  // 3. Opens, and the driver escaping the file.
  const readonlyByLiteral = (node, driver) => {
    const options = node.arguments?.[1];
    if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
    const key = driver === NODE_SQLITE ? 'readOnly' : 'readonly';
    let value = false;
    for (const p of options.properties) {
      if (ts.isSpreadAssignment(p)) return false; // a spread can switch it back off
      if (p.name !== undefined && ts.isComputedPropertyName(p.name)) return false; // unprovable
      const name = p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null;
      if (name === key) value = ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.TrueKeyword; // the last one wins
    }
    return value;
  };
  const inMemoryByLiteral = (node) => {
    const first = node.arguments?.[0];
    if (first === undefined) return true;
    return ts.isStringLiteralLike(first) && (first.text === ':memory:' || first.text === '');
  };
  const durableOnNextStatement = (node) => {
    const parent = node.parent;
    let target;
    let statement;
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
      target = parent.name.text;
      statement = parent.parent?.parent;
    } else if (ts.isBinaryExpression(parent) && parent.right === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      target = parent.left.getText(source);
      statement = parent.parent;
    }
    if (target === undefined || statement === undefined) return false;
    const siblings = statement.parent !== undefined && 'statements' in statement.parent ? statement.parent.statements : undefined;
    if (siblings === undefined) return false;
    const next = siblings[siblings.indexOf(statement) + 1];
    return (
      next !== undefined &&
      ts.isExpressionStatement(next) &&
      ts.isCallExpression(next.expression) &&
      ts.isIdentifier(next.expression.expression) &&
      next.expression.expression.text === 'applyDurableSync' &&
      next.expression.arguments.length === 1 &&
      next.expression.arguments[0]?.getText(source) === target
    );
  };
  const exported = (node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const visit = (node) => {
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const callee = valueOf(node.expression);
      if (callee?.kind === 'ctor') {
        opens.push({
          line: lineOf(node),
          fn: enclosingFunctionName(node),
          call: node.getText(source).replace(/\s+/g, ' '),
          readonly: readonlyByLiteral(node, callee.driver),
          memory: inMemoryByLiteral(node),
          durable: durableOnNextStatement(node),
        });
      }
    }
    // The driver leaving the file: `export { D }`, `export default D`, `export const E = D`, `module.exports = D`.
    if (ts.isExportSpecifier(node) && node.parent.parent.moduleSpecifier === undefined && !node.isTypeOnly) {
      if (bindings.has((node.propertyName ?? node.name).text)) escapes.push({ line: lineOf(node), form: `export { ${node.getText(source)} }` });
    }
    if (ts.isExportAssignment(node) && valueOf(node.expression) !== null) escapes.push({ line: lineOf(node), form: 'export default' });
    if (ts.isVariableStatement(node) && exported(node)) {
      for (const d of node.declarationList.declarations) {
        if (d.initializer !== undefined && valueOf(d.initializer) !== null) escapes.push({ line: lineOf(d), form: `export const ${d.name.getText(source)}` });
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && valueOf(node.right) !== null) {
      const left = node.left.getText(source);
      if (/^(module\.)?exports\b/.test(left)) escapes.push({ line: lineOf(node), form: `${left} = ...` });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { loads, opens, escapes };
}

/** Every file in scope, as a repo-relative path. */
function scanTargets() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|mts|cts|mjs|cjs|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(rel);
    }
  };
  for (const dir of SCAN_DIRS) walk(dir);
  for (const file of SCAN_FILES) if (existsSync(join(ROOT, file))) out.push(file);
  return out.sort();
}

/** Classify one open for the report. */
function openVerdict(o) {
  if (o.readonly) return 'read-only';
  if (o.memory) return 'in-memory';
  if (o.durable) return 'durable';
  return 'writable';
}

test('the guard`s analysis sees every way to open a database, and reads read-only, in-memory and durable correctly', () => {
  // Proven on synthetic sources every run, so a guard that silently stopped seeing a form fails here.
  const cases = [
    ['a default import', `import Database from 'better-sqlite3';\nexport function f(p) { return new Database(p); }`, 'writable'],
    ['a call without new', `import Database from 'better-sqlite3';\nexport const f = (p) => Database(p);`, 'writable'],
    ['a namespace import', `import * as D from 'better-sqlite3';\nexport const f = (p) => new D.default(p);`, 'writable'],
    ['import { default as D }', `import { default as D } from 'better-sqlite3';\nexport const f = (p) => new D(p);`, 'writable'],
    ['an alias of an alias', `import Database from 'better-sqlite3';\nconst D = Database;\nconst E = D;\nexport const f = (p) => new E(p);`, 'writable'],
    ['process.getBuiltinModule', `const S = process.getBuiltinModule('node:sqlite');\nexport const f = (p) => new S.DatabaseSync(p);`, 'writable'],
    ['createRequire', `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst D = require('better-sqlite3');\nexport const f = (p) => new D(p);`, 'writable'],
    ['createRequire under another name', `import module from 'node:module';\nconst req = module.createRequire(import.meta.url);\nconst load = req;\nexport const f = (p) => new (load('better-sqlite3'))(p);`, 'writable'],
    ['a deep import of the driver', `import Database from 'better-sqlite3/lib/database.js';\nexport const f = (p) => Database;`, 'none'],
    ['require inline', `export const f = (p) => new (require('better-sqlite3'))(p);`, 'writable'],
    ['a dynamic import, destructured', `export async function f(p) {\n  const { default: D } = await import('better-sqlite3');\n  return new D(p);\n}`, 'writable'],
    ['a dynamic import, inline', `export async function f(p) { return new (await import('better-sqlite3')).default(p); }`, 'writable'],
    ['node:sqlite DatabaseSync', `import { DatabaseSync } from 'node:sqlite';\nexport const f = (p) => new DatabaseSync(p);`, 'writable'],
    ['node:sqlite through a namespace', `import * as sqlite from 'node:sqlite';\nexport const f = (p) => new sqlite.DatabaseSync(p);`, 'writable'],
    ['node:sqlite with better-sqlite3`s spelling', `import { DatabaseSync } from 'node:sqlite';\nexport const f = (p) => new DatabaseSync(p, { readonly: true });`, 'writable'],
    ['readonly switched back by a spread', `import Database from 'better-sqlite3';\nconst w = { readonly: false };\nexport const f = (p) => new Database(p, { readonly: true, ...w });`, 'writable'],
    ['readonly overridden later', `import Database from 'better-sqlite3';\nexport const f = (p) => new Database(p, { readonly: true, readonly: false });`, 'writable'],
    ['durable, but not on the NEXT statement', `import Database from 'better-sqlite3';\nexport function f(p) {\n  const db = new Database(p);\n  db.pragma('x');\n  applyDurableSync(db);\n}`, 'writable'],
    ['read-only (control)', `import Database from 'better-sqlite3';\nexport const f = (p) => new Database(p, { readonly: true });`, 'read-only'],
    ['node:sqlite read-only (control)', `import { DatabaseSync } from 'node:sqlite';\nexport const f = (p) => new DatabaseSync(p, { readOnly: true });`, 'read-only'],
    ['in-memory (control)', `import Database from 'better-sqlite3';\nexport const f = () => new Database(':memory:');`, 'in-memory'],
    ['durable on the next statement (control)', `import Database from 'better-sqlite3';\nexport function f(p) {\n  const db = new Database(p);\n  applyDurableSync(db);\n  return db;\n}`, 'durable'],
  ];
  for (const [label, text, expected] of cases) {
    const { loads, opens } = analyse('synthetic.mjs', text);
    assert.ok(loads.length >= 1, `${label}: the driver load must be seen`);
    if (expected === 'none') {
      // A driver the analysis cannot read opens from is still a LOAD, which the module gate refuses.
      assert.equal(opens.length, 0, `${label}: no open is readable here, the module gate is what catches it`);
      continue;
    }
    assert.equal(opens.length, 1, `${label}: exactly one open must be seen, saw ${opens.length}`);
    assert.equal(openVerdict(opens[0]), expected, `${label}: read as ${openVerdict(opens[0])}, expected ${expected}`);
  }
  // And what is NOT a load: SQL that mentions sqlite_master, our own store module, a path helper.
  for (const text of [
    `export const f = (db) => db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table');`,
    `export const f = (DIST) => import(DIST('core/store/sqlite-store.js'));`,
    `export const f = (e) => e.code === 'SQLITE_BUSY' || String(e).includes('SQLITE_CONSTRAINT');`,
  ]) {
    assert.deepEqual(analyse('synthetic.mjs', text).loads, [], `not a driver load: ${text}`);
  }
  const escapes = [
    `import Database from 'better-sqlite3';\nexport { Database as Driver };`,
    `import Database from 'better-sqlite3';\nexport default Database;`,
    `import Database from 'better-sqlite3';\nexport const Driver = Database;`,
    `module.exports = require('better-sqlite3');`,
    `export { default } from 'better-sqlite3';`,
  ];
  for (const text of escapes) assert.equal(analyse('synthetic.mjs', text).escapes.length, 1, `must see the driver escape in: ${text}`);
  assert.deepEqual(analyse('synthetic.ts', `import type Database from 'better-sqlite3';\nexport type Db = Database.Database;`).loads, [], 'a type-only import is not a load');
  assert.deepEqual(analyse('synthetic.ts', `import { SqliteStore } from '../store/sqlite-store.js';`).loads, [], 'our own sqlite-store module is not a driver');
});

test('no raw writable open, by any import form, in src/ bin/ scripts/ ops/ or the dev bridge, can skip the durability choke point', (t) => {
  const problems = [];
  const listedHits = new Map();
  const loadingModules = new Set();
  const verdicts = { 'read-only': 0, 'in-memory': 0, durable: 0, writable: 0 };
  let opensSeen = 0;
  for (const rel of scanTargets()) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    if (!/sqlite/i.test(text)) continue;
    const { loads, opens, escapes } = analyse(rel, text);
    opensSeen += opens.length;
    if (loads.length > 0) loadingModules.add(rel);
    if (loads.length > 0 && !(rel in DRIVER_MODULES)) {
      for (const l of loads) {
        problems.push(`${rel}:${l.line} loads a SQLite driver (${l.form}): open through SqliteStore, or add the module to DRIVER_MODULES with its reason`);
      }
    }
    for (const e of escapes) problems.push(`${rel}:${e.line} lets the driver leave the file (${e.form}), where its opens can no longer be checked`);
    for (const o of opens) {
      verdicts[openVerdict(o)] += 1;
      if (openVerdict(o) !== 'writable') continue;
      const key = `${rel}#${o.fn}`;
      const listed = (LISTED_OPENS[key] ?? []).some((entry) => entry.call === o.call);
      if (!listed) {
        problems.push(
          `${rel}:${o.line} \`${o.call}\` in ${o.fn}() is a WRITABLE open: make it durable on the next statement ` +
            '(applyDurableSync), open through SqliteStore, or list it in LISTED_OPENS with its reason',
        );
        continue;
      }
      listedHits.set(`${key} ${o.call}`, (listedHits.get(`${key} ${o.call}`) ?? 0) + 1);
    }
  }
  for (const [key, entries] of Object.entries(LISTED_OPENS)) {
    for (const entry of entries) {
      const n = listedHits.get(`${key} ${entry.call}`) ?? 0;
      if (n !== 1) problems.push(`LISTED_OPENS ${key} \`${entry.call}\` matched ${n} opens: it must match exactly one`);
    }
  }
  for (const rel of Object.keys(DRIVER_MODULES)) {
    if (!loadingModules.has(rel)) problems.push(`DRIVER_MODULES lists ${rel}, which no longer loads a driver: remove the stale entry`);
  }

  t.diagnostic(
    `driver loads in ${loadingModules.size} module(s); ${opensSeen} opens: ${verdicts['read-only']} read-only, ` +
      `${verdicts['in-memory']} in-memory, ${verdicts.durable} durable, ${verdicts.writable} listed`,
  );
  assert.ok(opensSeen >= 5, `the scan must see the engine's real opens (saw ${opensSeen}), or it proves nothing`);
  assert.deepEqual(problems, []);
});
