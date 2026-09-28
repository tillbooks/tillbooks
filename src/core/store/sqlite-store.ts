/**
 * The one persistence adapter (§I: the MIT core is the sole writer of local SQLite).
 *
 * There is a single adapter, backed by better-sqlite3. Tests construct it with `:memory:`, which
 * exercises the exact SQL path production uses, so there is no second in-memory implementation to
 * drift. It is synchronous, which is what an accounting core wants: a post is one atomic transaction,
 * not an interleaving of awaits.
 *
 * This class owns the connection, the schema, transactions, and the idempotency primitive
 * (§H-IDEMPOTENT). Per-aggregate SQL (the ledger, accounts, tax codes, ...) lives in each spec's
 * store module and runs against `db`; the money-path invariant that posted rows are never updated or
 * deleted (§H-AUDIT) is enforced there, in the ledger writer.
 */

import { closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';
import { SCHEMA_SQL, ADDITIVE_COLUMNS, ADDITIVE_INDEXES, SCHEMA_GENERATION } from './schema.js';
import { DATA_MIGRATIONS } from './migrations.js';
import {
  SchemaNewerThanRuntimeError,
  assertGenerationNotNewer,
  bookGenerationOf,
  newerGenerationRefusal,
} from './generation.js';
// Aliased on its own line so it never collides with a `node:fs` import list the top of this file grows.
import { existsSync as pathExists } from 'node:fs';

/**
 * How long a write waits for another connection's lock before giving up.
 *
 * D12 puts a SECOND writer on the file: the Studio holds the database open while `till mcp` runs in
 * an agent subprocess. better-sqlite3's default is to wait 5000ms, but the value is left implicit,
 * and an implicit value on the money path is a value nobody chose. Five seconds is far longer than
 * any transaction here (a post is one synchronous transaction over a handful of rows), so hitting it
 * means something is genuinely stuck rather than merely contended.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * Is this a lock-contention failure, as opposed to a real fault?
 *
 * It matters because the two want opposite responses: contention is worth retrying in a moment, and
 * a constraint violation or a type error is not. Both used to arrive at the caller as
 * `unexpected_error`, which told them nothing.
 */
export function isBusyError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

/**
 * THE DURABILITY CONTRACT: a commit the store acknowledges survives a power cut or an OS crash.
 *
 * Posted entries are append-only and immutable, and that promise is only as strong as the commit
 * that wrote them. A booking the user saw as posted must not be undone by the machine losing power a
 * second later. Three facts, re-measured on 2026-09-24 (better-sqlite3 13.0.3, SQLite 3.53.4, macOS):
 *
 *  1. In WAL mode, `synchronous = NORMAL` does not sync the WAL at commit at all, only around
 *     checkpoints. SQLite's own documentation: "A transaction committed in WAL mode with
 *     synchronous=NORMAL might roll back following a power loss or system crash." `FULL` adds one
 *     sync of the WAL per commit, and that sync is what makes a WAL commit durable.
 *  2. better-sqlite3 is compiled with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, and SQLite applies that
 *     default whenever a connection reads a database header that says WAL, unless the connection set
 *     `synchronous` itself (btree.c `setDefaultSyncFlag`). So until this function existed the ledger
 *     ran at NORMAL on every REOPEN, and even the session that created the file dropped to NORMAL
 *     after its first commit. Nothing any user ever posted was synced at commit.
 *  3. On macOS a plain fsync() hands the data to the drive but does not flush the drive's own write
 *     cache. Only `fcntl(F_FULLFSYNC)` does, and SQLite issues it only while `fullfsync` is ON.
 *     `checkpoint_fullfsync` covers checkpoints; with `fullfsync` ON it is already implied, and it is
 *     set anyway so that switching one off can never silently weaken the other. Elsewhere fsync
 *     already reaches the medium and both flags are no-ops, so they are set on darwin only.
 *
 * The level is EXTRA, not FULL, and in WAL mode the two are the same thing. EXTRA differs from FULL
 * in one place only: a rollback-journal commit also syncs the DIRECTORY after unlinking the journal
 * (pager.c `pager_end_transaction` passes `extraSync` to `sqlite3OsDelete`; nothing on the WAL path
 * reads it, and `fullSync`, which drives the WAL commit sync, is `level >= FULL` for both). Measured
 * on this SQLite: a WAL commit costs 2.84 ms at EXTRA and 2.85 ms at FULL. The difference matters only
 * if the switch to WAL ever fails to take (a filesystem without shared-memory support leaves the
 * journal at DELETE, silently): there FULL is "not necessarily durable across a power loss" in
 * SQLite's words, and EXTRA is. So EXTRA costs nothing where TILL normally runs and keeps the promise
 * where it might not.
 *
 * These are PER-CONNECTION settings, never stored in the file, so they must be applied on every open.
 * `SqliteStore` does it before any statement on a file-backed connection can commit, which covers
 * every store the engine opens. Code that opens a WRITABLE connection to a file with a raw
 * `new Database(...)` calls this on the very next statement. `test/core/store-durability.test.mjs`
 * holds that in place across src/, bin/, scripts/, ops/ and the dev bridge: a module outside a short
 * list may not load a SQLite driver at all (by any import form, `node:sqlite` included), and inside it
 * every writable open must be made durable that way or listed with its reason. One is listed today,
 * as a known gap rather than an exception: G04's backup snapshot, whose fix is not a pragma.
 *
 * A read-only connection cannot commit or checkpoint, so it has nothing to sync, and an in-memory
 * database has no disk to sync to: both are left exactly as the driver opened them.
 *
 * What it costs, measured on the owner's class of machine (Apple SSD): one WAL commit takes 0.05 ms
 * at NORMAL, 0.10 ms at FULL and 3.1 ms at FULL with F_FULLFSYNC. A verb is one transaction, so a
 * write pays about 3 ms: `post_entry` through `makeApiDeps` on a file went from 0.6 ms to 4.0 ms at
 * the median, and the whole Seeblick seed (`scripts/seed-demo-rich.mjs`) from 1.6 s to 4.2 s. That
 * is the price of the guarantee, and it is not negotiable on a ledger. The one place it would have
 * hurt is a statement-per-commit bulk load, which is why a brand-new file's schema is built as ONE
 * transaction (see the constructor).
 *
 * THE ONE RELAXATION, AND WHY IT CANNOT REACH PRODUCTION. The node suites open thousands of throwaway
 * file stores and commit to them statement by statement, and F_FULLFSYNC flushes the whole drive
 * cache, so it slows the most exactly when parallel sessions are gating at once. Measured on the 49
 * root suites that open file stores, four at a time: 126 s -> 148 s on a quiet box, 133 s -> 343 s
 * under parallel load. None of them can observe a power cut, so the harness
 * (`scripts/run-node-tests.mjs`) sets `TILL_TEST_NO_FULLFSYNC=1`, and that skips ONLY the two
 * F_FULLFSYNC flags (110 s, no slower than before): `synchronous` stays EXTRA, so the suites still run
 * the production sync level. The variable is honoured only inside a process the node:test runner
 * spawned (`NODE_TEST_CONTEXT` is set), so `till up`, `till serve`, `till mcp` and the CLI ignore it
 * even when it is exported by mistake. NEVER set it for anything but the test harness.
 */
export function applyDurableSync(db: Database.Database): void {
  if (db.memory || db.readonly) return;
  db.pragma('synchronous = EXTRA');
  if (process.platform === 'darwin' && !testHarnessSkipsFullfsync()) {
    db.pragma('fullfsync = ON');
    db.pragma('checkpoint_fullfsync = ON');
  }
}

/** The test-only switch described on `applyDurableSync`. Never for production. */
export const TEST_NO_FULLFSYNC_ENV = 'TILL_TEST_NO_FULLFSYNC';

/**
 * True only when the node:test runner spawned this process AND the harness asked to skip F_FULLFSYNC.
 * Read on every open (not cached), so a suite can clear the variable to assert production behaviour.
 *
 * An EMPTY `NODE_TEST_CONTEXT` counts as unset: the runner always writes a value (`child`,
 * `child-v8`), and an empty export is a shell accident, not a test. A process that a test itself
 * spawns (a `till up` under test, the Seeblick seed child) inherits both variables and so runs relaxed
 * too. That is accepted on purpose: it is still a test, and `synchronous` stays at the production
 * level, so only the drive-cache flush is skipped.
 */
function testHarnessSkipsFullfsync(): boolean {
  const runnerContext = process.env['NODE_TEST_CONTEXT'] ?? '';
  return process.env[TEST_NO_FULLFSYNC_ENV] === '1' && runnerContext !== '';
}

/** True for a database with no schema yet: a brand-new file (or one whose first build never committed). */
function hasEmptySchema(db: Database.Database): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get() as { n: number };
  return row.n === 0;
}

/** SQLite's own busy-handler schedule (main.c `sqliteDefaultBusyCallback`), then 100 ms steps. */
const WAL_SWITCH_BACKOFF_MS = [1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50, 100];
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/**
 * Switch a freshly opened connection to WAL, retrying on SQLITE_BUSY until the busy timeout runs out.
 *
 * The busy timeout does not cover this statement. The switch is a read-to-write upgrade inside one
 * statement (it reads the header, then rewrites it), and SQLite never runs the busy handler for a
 * connection that already holds a read lock: btree.c `sqlite3BtreeBeginTrans` only invokes it from
 * TRANS_NONE, because a reader waiting for a writer that waits for the reader would deadlock. So when
 * two processes open the same brand-new file at once (the Studio and `till mcp` on a first run), the
 * one that loses fails at once with SQLITE_BUSY while the other holds its write lock. Measured with
 * four processes creating one new ledger at the same instant: 5 of 44 opens failed that way before
 * durable commits and up to 12 of 44 after, because an F_FULLFSYNC keeps the winner's lock for ~9 ms
 * instead of ~0.4 ms; with this retry, 0 of 88. Retrying the whole statement, with no lock held
 * between attempts, is exactly what the handler may not do mid-statement, and it waits no longer
 * than the busy timeout would have.
 *
 * On a re-opened WAL file the switch is a no-op that takes no lock, so this loop only ever turns on
 * a brand-new file.
 */
function switchToWal(db: Database.Database, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (e) {
      const left = deadline - Date.now();
      if (!isBusyError(e) || left <= 0) throw e;
      // A synchronous wait, as SQLite's own handler does: the engine is synchronous end to end.
      Atomics.wait(SLEEP_CELL, 0, 0, Math.min(WAL_SWITCH_BACKOFF_MS[attempt] ?? 100, left));
    }
  }
}

/**
 * A directory that cannot be opened or synced for one of these reasons is skipped, the way SQLite
 * skips a directory it cannot open for its own journal syncs; anything else (EIO, ENOSPC) is a real
 * fault on the ledger's disk and is thrown.
 */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES']);

/**
 * Make a directory's ENTRIES durable: the names of the files and directories created in it.
 *
 * SQLite syncs file contents, and on creating a rollback journal or a WAL it also syncs their
 * directory, but it never does so for the main database file itself (os_unix.c `unixOpen` sets
 * `UNIXFILE_DIRSYNC` for journals and the WAL only). A new ledger whose directory entry is still in a
 * cache can vanish in a power cut together with everything committed into it. Called once per NEW
 * file (see the constructor) and per new directory (`makeDirectoryDurably`), so it is a one-off cost,
 * never a per-commit one.
 *
 * A plain fsync of the directory hands its metadata to the drive; on macOS the next F_FULLFSYNC,
 * which the store issues on the file's first commit, flushes the drive cache with it. Windows has no
 * directory sync (NTFS journals its metadata), so this is a no-op there.
 */
export function fsyncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number;
  try {
    fd = openSync(dir, 'r');
  } catch (e) {
    if (DIRECTORY_SYNC_UNSUPPORTED.has((e as { code?: string }).code ?? '')) return;
    throw e;
  }
  try {
    fsyncSync(fd);
  } catch (e) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has((e as { code?: string }).code ?? '')) throw e;
  } finally {
    closeSync(fd);
  }
}

/**
 * `mkdir -p` that leaves every directory it CREATED durable, by syncing each new directory's parent
 * (a new entry is durable once its parent directory is). `ensureDbPath` uses it for `~/.till`, so a
 * first `till up` cannot lose the directory the new ledger lives in. Creates nothing and syncs
 * nothing when the directory already exists.
 */
export function makeDirectoryDurably(dir: string): void {
  const target = resolve(dir);
  const first = mkdirSync(target, { recursive: true });
  if (first === undefined) return;
  const top = resolve(first);
  const created: string[] = [];
  for (let d = target; ; d = dirname(d)) {
    created.push(d);
    if (d === top || dirname(d) === d) break;
  }
  for (const d of created.reverse()) fsyncDirectory(dirname(d));
}

export interface SqliteStoreOptions {
  /** File path, or `:memory:` (the default) for an ephemeral test database. */
  location?: string;
  clock?: Clock;
  /** Milliseconds to wait for another writer's lock. Defaults to `DEFAULT_BUSY_TIMEOUT_MS`. */
  busyTimeoutMs?: number;
}

/**
 * Bring a database that has just had `SCHEMA_SQL` applied up to the FULL current schema: widen every
 * `ADDITIVE_COLUMNS` shape (idempotent, so a column already in the fresh CREATE is skipped), then
 * create the `ADDITIVE_INDEXES` over those columns. The order matters: an index over a column added
 * here must run after the column exists.
 *
 * This is exported (not just a store method) because more than the live store builds a database from
 * the schema. G04's backup snapshot (`core/data/portability.ts`) writes a fresh SQLite from
 * `SCHEMA_SQL` and copies one workspace's rows into it; a column that TILL ships only through
 * `ADDITIVE_COLUMNS` (e.g. G05's `document.rendered_template_id`) is absent from the base CREATE, so
 * a snapshot built from `SCHEMA_SQL` alone cannot receive that column's values and the copy throws
 * `table document has no column named rendered_template_id`. Sharing this one function is what keeps
 * the snapshot schema identical to the live schema instead of drifting the moment a new additive
 * column ships.
 *
 * Idempotent by construction: each ALTER runs only when `PRAGMA table_info` says the column is
 * missing, and a concurrent opener that added it first is caught by the `duplicate column name`
 * guard. Data migrations are deliberately NOT run here: a fresh database (or a snapshot copying rows
 * that already sit at the current generation) needs the schema SHAPE, never a value re-interpretation.
 */
export function applyAdditiveSchema(db: Database.Database): void {
  for (const { table, column, ddl } of ADDITIVE_COLUMNS) {
    const existing = db.pragma(`table_info(${table})`) as { name: string }[];
    if (existing.some((c) => c.name === column)) continue;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    } catch (e) {
      // A concurrent opener may have added the column between the check and the ALTER. That exact
      // race is fine; anything else is a real fault and must surface.
      const message = e instanceof Error ? e.message : String(e);
      if (!message.includes('duplicate column name')) throw e;
    }
  }
  for (const { ddl } of ADDITIVE_INDEXES) {
    db.exec(ddl);
  }
}

/**
 * Apply the DATA migrations a database has not seen (M-3, see `./migrations.ts`).
 *
 * `applyAdditiveSchema` above widens a table's SHAPE, which was enough while every schema change was
 * a new nullable column. It cannot help when a change alters what an EXISTING stored number MEANS,
 * and the §H-FX rate-scale widening does exactly that: the same `rate_scaled` integer denotes a rate
 * four orders of magnitude different before and after. A ledger that reinterprets a stored number in
 * silence is worse than one that refuses to open.
 *
 * `PRAGMA user_version` is the generation marker. It is 0 on every database written before this,
 * because nothing ever set it, and 0 is precisely "written at the old rate scale". The migrations and
 * the version bump commit TOGETHER, so a crash mid-run leaves the old generation and the old rows and
 * the next open simply retries. There is no half-migrated state to reason about. On a fresh (empty)
 * database every migration is a no-op over empty tables and only the version bump takes effect.
 *
 * A generation ABOVE this build's is never passed over in silence (critic finding M3): it means a
 * newer TILL wrote the file, and carrying on would write rows whose meaning this build does not know.
 * The marker is read INSIDE the migration transaction and the migrations run from THAT value (critic
 * R1 F3): read outside it, a newer TILL could commit generation 8 between the read and the
 * transaction, and the bump below would then LOWER the marker to 7 over gen-8 rows. Inside it, the
 * read and the writes share one snapshot, and a newer commit after that snapshot makes the first
 * write fail with SQLITE_BUSY_SNAPSHOT instead. The bump only ever raises the marker: it runs only
 * when the value read is below this build's generation. On a store open this runs nested inside the
 * open's own schema transaction (see the constructor), whose first statement already read the marker.
 */
function applyDataMigrations(db: Database.Database): void {
  db.transaction(() => {
    const version = bookGenerationOf(db);
    assertGenerationNotNewer(version, db.name);
    if (version >= SCHEMA_GENERATION) return;
    for (const migration of DATA_MIGRATIONS) {
      if (migration.generation > version) migration.apply(db);
    }
    // Not a bound parameter: PRAGMA does not take one. SCHEMA_GENERATION is a module constant, so
    // there is no input here to interpolate.
    db.pragma(`user_version = ${SCHEMA_GENERATION}`);
  })();
}

/**
 * Build the FULL current schema into a freshly-opened database: the base CREATE (`SCHEMA_SQL`), the
 * additive widening, then the data migrations. Idempotent, because `SCHEMA_SQL` creates
 * `IF NOT EXISTS`, `applyAdditiveSchema` skips columns that already exist, and `applyDataMigrations`
 * is gated on `user_version`, so it is equally the right thing to run against a brand-new file and a
 * re-opened one. Shared by the file-backed path and the in-memory template below so both build the
 * IDENTICAL schema rather than two copies that can drift.
 */
function buildCurrentSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  applyAdditiveSchema(db);
  applyDataMigrations(db);
}

/**
 * A pre-migrated, empty `:memory:` database serialized to a Buffer ONCE per process, so every fresh
 * in-memory store is a cheap CLONE of it rather than a fresh schema build.
 *
 * Building the schema is ~600 ms of DDL (285 KB: 211 tables, 201 indexes, 75 triggers, plus 77
 * `ALTER TABLE`s); deserializing this template is ~0.2 ms. The node test gate builds THOUSANDS of
 * fresh in-memory stores (the MCP conformance suite alone constructs one per verb per rule, over 779
 * verbs), so re-running the build each time is what pushed the suite past its wall clock and made it
 * look like a hang. The template is built by the SAME `buildCurrentSchema` a live store runs, so a
 * cloned database is byte-for-byte what a freshly-built one would contain. Connection pragmas
 * (`foreign_keys`, `recursive_triggers`) are per-connection and are NOT part of the serialized image,
 * so the caller re-applies them on every clone.
 */
let memoryTemplate: Buffer | undefined;
function freshMemoryTemplate(): Buffer {
  if (memoryTemplate === undefined) {
    const seed = new Database(':memory:');
    seed.pragma('foreign_keys = ON');
    seed.pragma('recursive_triggers = ON');
    buildCurrentSchema(seed);
    memoryTemplate = seed.serialize();
    seed.close();
  }
  return memoryTemplate;
}

/**
 * Run `step` again while it fails with SQLITE_BUSY (any extended code, SQLITE_BUSY_SNAPSHOT included),
 * backing off on SQLite's own schedule until `timeoutMs` has passed; any other error, or a busy one
 * past the deadline, is thrown. For a re-open's schema transaction (see the constructor): it begins
 * DEFERRED and reads first, so a write it needs cannot wait on the busy handler (a reader is never
 * made to wait for a writer, which could deadlock) and fails at once instead. Retrying the WHOLE
 * transaction, with no lock held between attempts, waits no longer than the busy timeout would have.
 */
function retryWhileBusy<T>(step: () => T, timeoutMs: number): T {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return step();
    } catch (e) {
      const left = deadline - Date.now();
      if (!isBusyError(e) || left <= 0) throw e;
      Atomics.wait(SLEEP_CELL, 0, 0, Math.min(WAL_SWITCH_BACKOFF_MS[attempt] ?? 100, left));
    }
  }
}

/**
 * THE READ-ONLY FIRST LOOK (critic R1 F4): refuse a newer book before any WRITABLE connection to it
 * exists.
 *
 * Read on a writable connection, the refusal was not free: closing the LAST connection to a WAL book
 * checkpoints the WAL into the main file and deletes it. When a newer TILL crashed with its commits
 * still in the -wal (the marker bump among them), the refused open rewrote the main file (its header
 * went from 7 to 8) and deleted the -wal, so "the book was not changed" was false. A read-only
 * connection reads through the WAL (the marker it sees is the committed one, crash residue included)
 * but can never checkpoint, so it leaves the main file and the -wal exactly as they were.
 *
 * On a QUIET book (no -wal on disk) the read-only look creates an empty -wal and a -shm, and a refused
 * open LEAVES them. They hold no data: the -wal is empty and the -shm is the WAL's index, which any
 * later opener rebuilds. Removing them would take a writable connection closing as the last one, and
 * that close checkpoints whatever the -wal holds at that moment. Round 1 did exactly that when no -wal
 * existed before the look, and a newer TILL that created the -wal, committed its generation and
 * crashed between that check and the look had its commit folded into the main file and its -wal
 * deleted (critic R2-5, probe q6 d). Every tidy decided by a check made earlier has that window, so
 * the refusal opens nothing writable at all: the main file and any -wal stay byte-for-byte as they
 * were, with the one exception below.
 *
 * WHEN THE LOOK CANNOT BE TAKEN (critic R3-4). A read-only connection cannot read a book whose
 * reading needs a write first. The case that happens: a book in rollback-journal mode (a pre-WAL file,
 * or one an outside tool switched back) whose writer died mid-transaction leaves a HOT journal, and
 * SQLite must roll it back before anyone may read; only a writable connection may, so the look fails
 * with SQLITE_READONLY_ROLLBACK. Refusing to open would strand a book develop opens fine, so on any
 * SQLITE_READONLY_* failure (ROLLBACK, RECOVERY, CANTINIT, CANTLOCK, DIRECTORY: each means "a
 * read-only connection may not do what reading needs") the look steps aside and the writable open
 * goes ahead. Its FIRST statement reads the marker (see the constructor); that read rolls the journal
 * back, restoring the last committed content as every opener, a newer TILL included, has to, and then
 * refuses a newer book before the WAL switch, any DDL or any write. So in that one case a refused
 * open does change the main file: it returns it to its last committed state, and nothing more.
 */
function refuseNewerBookBeforeOpening(location: string): void {
  // A brand-new book (the store is about to create it) has nothing to read and nothing to refuse.
  if (!pathExists(location)) return;
  let generation: number;
  try {
    const probe = new Database(location, { readonly: true, fileMustExist: true });
    try {
      generation = bookGenerationOf(probe);
    } finally {
      probe.close();
    }
  } catch (e) {
    if (cannotLookReadOnly(e)) return;
    throw e;
  }
  const refusal = newerGenerationRefusal(generation, location);
  if (refusal !== null) throw new SchemaNewerThanRuntimeError(refusal);
}

/** A read-only connection may not do what reading this book needs first (see above). */
function cannotLookReadOnly(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_READONLY');
}

/**
 * A statement that starts, ends or marks a transaction. `BEGIN IMMEDIATE` reports as writing (it takes
 * the write lock), and run inside a transaction it would fail, so `exec` passes these through as they
 * are; the writes that follow them are guarded one by one (see `GuardedDatabase`).
 */
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/**
 * The two pragmas SQLite reports as writing that are file housekeeping, not content: `wal_checkpoint`
 * copies committed pages from the WAL into the main file, and `journal_mode` reads or switches the
 * journal (the open sets WAL). Neither changes a row, and neither works inside a transaction (a
 * checkpoint there fails with SQLITE_LOCKED, a switch into or out of WAL is refused), so the
 * chokepoint passes them through as they are, from `pragma` and from `exec` alike.
 */
const HOUSEKEEPING_PRAGMA = /^\s*(wal_checkpoint|journal_mode)\b/i;

/** What the chokepoint needs from its store, and nothing more. */
interface WriteGuard {
  /** Run `write` as the store's own transaction: IMMEDIATE, the marker read first (`SqliteStore.tx`). */
  tx<T>(write: () => T): T;
  /**
   * Called after a write inside a transaction that is already open. A no-op in a transaction the
   * store opened itself (its marker read covers the write); in any other, reads the marker and, on a
   * newer book, rolls the transaction back and throws.
   */
  afterWriteInOpenTransaction(): void;
}

type AnyStatement = Database.Statement<unknown[], unknown>;
type StatementMethod = 'run' | 'get' | 'all' | 'iterate';

/**
 * The driver's own method, looked up on the statement prototype at CALL time rather than captured
 * once at load, so the chokepoint always delegates to exactly what the driver (or an instrumenting
 * probe that wraps the prototype) provides.
 */
function driverMethod(statement: AnyStatement, name: StatementMethod): (...params: unknown[]) => unknown {
  return (Object.getPrototypeOf(statement) as Record<StatementMethod, (...params: unknown[]) => unknown>)[name];
}

function connectionOf(statement: AnyStatement): GuardedDatabase {
  return statement.database as unknown as GuardedDatabase;
}

function guardedRun(this: AnyStatement, ...params: unknown[]): unknown {
  return connectionOf(this).guardedWrite(() => driverMethod(this, 'run').apply(this, params));
}

function guardedGet(this: AnyStatement, ...params: unknown[]): unknown {
  return connectionOf(this).guardedWrite(() => driverMethod(this, 'get').apply(this, params));
}

function guardedAll(this: AnyStatement, ...params: unknown[]): unknown {
  return connectionOf(this).guardedWrite(() => driverMethod(this, 'all').apply(this, params));
}

/** A writing iterator (`INSERT ... RETURNING`) is drained inside the guard, so the write is whole. */
function guardedIterate(this: AnyStatement, ...params: unknown[]): unknown {
  const rows = connectionOf(this).guardedWrite(() => [...(driverMethod(this, 'iterate').apply(this, params) as Iterable<unknown>)]);
  return rows[Symbol.iterator]();
}

/**
 * THE WRITE CHOKEPOINT (critic R3-1): every statement that writes, issued on the store's connection,
 * runs inside a transaction whose snapshot has had its generation marker read.
 *
 * Three rounds of critique found the same class of defect each time: a write some call site issued as
 * a bare autocommit statement, which no marker check saw (a key-less verb, a helper, a run log). Each
 * round wrapped the call sites it was shown, and the next round found more, because the next verb is
 * the next call site. So the guard now sits where every engine write passes, the connection itself:
 * `SqliteStore.db` is this class, and
 *
 *  - `prepare` hands back the driver's own statement, except that a statement SQLite reports as
 *    WRITING (`readonly === false`, from `sqlite3_stmt_readonly`) has its `run` routed through
 *    `guardedWrite`, and, when it also returns rows (`INSERT ... RETURNING`), its `get`, `all` and
 *    `iterate`. Not `reader`: that says whether a statement RETURNS rows, so `INSERT ... RETURNING` is
 *    a reader that writes and `PRAGMA foreign_keys = OFF` a non-reader that does not (measured on
 *    this driver). SQLite reports SELECT, BEGIN, COMMIT, SAVEPOINT, RELEASE and the connection
 *    pragmas as read-only, and INSERT, UPDATE, DELETE, every DDL and a pragma that writes the file
 *    (`user_version = n`) as writing.
 *  - `exec` is a write unless its SQL is ONE statement SQLite reports as read-only, or one
 *    transaction-control statement. A string of several statements is a write, conservatively: run
 *    inside the guard, a `BEGIN` among them fails loudly instead of slipping past.
 *  - `pragma` is routed the same way when SQLite reports the pragma as writing (`user_version = n`),
 *    except the two that are file housekeeping and cannot run inside a transaction at all
 *    (`wal_checkpoint`, `journal_mode`: see `HOUSEKEEPING_PRAGMA`).
 *
 * `guardedWrite` then does one of three things:
 *
 *  1. OUTSIDE a transaction, the write runs inside `SqliteStore.tx`: BEGIN IMMEDIATE, the marker read
 *     under the write lock, the statement, COMMIT. Still one commit per statement, so a verb that
 *     committed step by step still does, and under D12 the BEGIN waits for the other process's lock
 *     exactly as the autocommit it replaces did. What changed is that no step can land in a book a
 *     newer TILL migrated: the read under the lock refuses first, and nothing is written.
 *  2. INSIDE a transaction the store opened (`tx`, `snapshotTx`, both of which read the marker as
 *     their first statement), the statement runs as it is. Nothing is wrapped twice, so nesting cannot
 *     deadlock, and the verbs that were already one transaction pay one flag check per write.
 *  3. INSIDE a transaction the store did NOT open (a raw `db.transaction`, an `exec('BEGIN')`), the
 *     statement runs and then the marker is read. After a write the connection holds the write lock on
 *     the newest snapshot, so that read is authoritative; on a newer book the store rolls the whole
 *     transaction back itself, so a caller that catches the error cannot commit it, and throws.
 *
 * WHY ONE READ PER TRANSACTION COVERS EVERY WRITE IN IT. A transaction reads one snapshot for its
 * whole life, and a write can only land on the newest one: in WAL mode, a connection whose snapshot
 * is older than another's commit fails its first write with SQLITE_BUSY_SNAPSHOT; in rollback-journal
 * mode, no other connection can commit while this one holds its shared lock. So the marker read
 * anywhere in a transaction describes the book every write of that transaction lands in.
 *
 * Reads are untouched: a read-only statement is the driver's own object with nothing added, and
 * pays only the one `readonly` lookup at prepare. The verb-level READ guarantee lives one level up:
 * the registry reads the marker before a workspace verb and again after it (critic R3-2).
 *
 * What stays outside, deliberately: the open's schema build, which runs before the guard is switched
 * on, inside one transaction whose first statement reads the marker (see the constructor); the two
 * housekeeping pragmas above; and other connections to other files (a backup snapshot, a landscape
 * build's read-only look), which `test/core/store-durability.test.mjs` confines to a short list of
 * modules.
 */
class GuardedDatabase extends Database {
  /** Switched on by `SqliteStore` once its open has finished; until then every call is the driver's. */
  writeGuard: WriteGuard | undefined = undefined;

  override prepare<BindParameters extends unknown[] | {} = unknown[], Result = unknown>(
    source: string,
  ): Database.Statement<BindParameters, Result> {
    const statement = super.prepare<BindParameters, Result>(source);
    // The guard decides at CALL time whether it is on, so a statement prepared during the open and
    // run after it is guarded too.
    if (!statement.readonly) {
      const own = statement as unknown as Record<StatementMethod, unknown>;
      own.run = guardedRun;
      if (statement.reader) {
        own.get = guardedGet;
        own.all = guardedAll;
        own.iterate = guardedIterate;
      }
    }
    return statement;
  }

  override exec(source: string): this {
    if (this.writeGuard === undefined || !this.execWrites(source)) return super.exec(source);
    this.guardedWrite(() => super.exec(source));
    return this;
  }

  override pragma(source: string, options?: Database.PragmaOptions): unknown {
    if (this.writeGuard === undefined || HOUSEKEEPING_PRAGMA.test(source) || super.prepare(`PRAGMA ${source}`).readonly) {
      return super.pragma(source, options);
    }
    return this.guardedWrite(() => super.pragma(source, options));
  }

  /** The three cases in the note above. */
  guardedWrite<T>(write: () => T): T {
    const guard = this.writeGuard;
    if (guard === undefined) return write();
    if (!this.inTransaction) return guard.tx(write);
    const result = write();
    guard.afterWriteInOpenTransaction();
    return result;
  }

  /** Does this `exec` string write? SQLite answers for one statement; several count as a write. */
  private execWrites(source: string): boolean {
    let statement: AnyStatement;
    try {
      statement = super.prepare(source);
    } catch {
      // Several statements (the driver prepares one at a time) or one that does not compile: treated
      // as a write. Run inside the guard, a compile error surfaces exactly as it would have.
      return true;
    }
    if (statement.readonly || TRANSACTION_CONTROL.test(source)) return false;
    const pragma = /^\s*PRAGMA\s+(.*)$/is.exec(source);
    return pragma === null || !HOUSEKEEPING_PRAGMA.test(pragma[1] ?? '');
  }
}

/**
 * Run one step of a file-backed open, and close the connection before rethrowing if it fails, so a
 * refused or failed open never leaves a live writable handle on the book. The caller never receives
 * a store from a constructor that threw, so nothing else could ever close it. A close that itself
 * fails is swallowed: the step's error is the one worth reporting.
 */
function closingOnFailure(db: Database.Database, step: () => void): void {
  try {
    step();
  } catch (e) {
    try {
      db.close();
    } catch {
      // Already failing; see above.
    }
    throw e;
  }
}

export class SqliteStore {
  readonly db: Database.Database;
  private readonly clock: Clock;
  private readonly location: string;

  constructor(options: SqliteStoreOptions = {}) {
    const location = options.location ?? ':memory:';
    this.location = location;
    this.clock = options.clock ?? systemClock;
    // The timeout is passed EXPLICITLY rather than inherited from the driver's default: with two
    // writers on one file, how long a write waits for a lock is a decision, not an implementation
    // detail. Without it a contended write fails immediately with SQLITE_BUSY.
    const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

    if (location === ':memory:') {
      // Fast path: clone the pre-migrated in-memory template (see `freshMemoryTemplate`) instead of
      // rebuilding 285 KB of schema DDL on every construction. `new Database(buffer)` deserializes an
      // INDEPENDENT in-memory database, so writes to it never touch the template or another clone.
      // The build path below (SCHEMA_SQL + additive + data migrations) is the one the template itself
      // ran, so this database is byte-for-byte what that path produces. Only the per-connection
      // pragmas remain to set, because they are not part of the serialized image.
      this.db = new GuardedDatabase(freshMemoryTemplate(), { timeout });
      this.db.pragma('foreign_keys = ON');
      // Without this, SQLite's REPLACE conflict resolution deletes the conflicting row WITHOUT firing
      // the BEFORE DELETE trigger, so `INSERT OR REPLACE` would route around posted-row immutability.
      // With it on, REPLACE's implicit delete fires journal_entry_no_delete_posted and aborts.
      this.db.pragma('recursive_triggers = ON');
      this.switchOnWriteGuard();
      return;
    }

    // The read-only first look (critic R1 F4), before any writable connection to the book exists.
    refuseNewerBookBeforeOpening(location);
    this.db = new GuardedDatabase(location, { timeout });
    // Durable commits FIRST, before any statement on this connection can commit: the WAL switch below
    // is itself a commit on a new file, and a re-opened file may run data migrations over real rows.
    // See `applyDurableSync` for why this is not optional on a ledger.
    applyDurableSync(this.db);
    // THE GENERATION GUARD (`./generation.ts`, critic finding M3), again on the writable connection,
    // before ANYTHING else touches the file: the WAL switch, the schema DDL, the additive ALTERs, the
    // data migrations and every write all come after it. The read-only look above already refused a
    // book that was newer when this open began; this catches one that became newer in between, and
    // the schema transaction below reads the marker once more as its first statement. The
    // durable-sync pragmas above are per-connection and write nothing.
    closingOnFailure(this.db, () => assertGenerationNotNewer(bookGenerationOf(this.db), location));
    // A brand-new file (the open above created it, empty): make its directory entry durable before
    // anything commits into it, so the first durable commit's F_FULLFSYNC flushes that entry too.
    // SQLite never syncs the main database file's directory (see `fsyncDirectory`). One-off per file.
    const brandNew = hasEmptySchema(this.db);
    // `this.db.memory` also covers the driver's anonymous temp database (location ''): nothing to sync.
    if (brandNew && !this.db.memory) fsyncDirectory(dirname(resolve(location)));
    this.db.pragma('foreign_keys = ON');
    // See the note above: recursive triggers keep REPLACE's implicit delete on the immutability path.
    this.db.pragma('recursive_triggers = ON');
    // Retried on SQLITE_BUSY: on a brand-new file this is the one statement the busy timeout does not
    // cover (see `switchToWal`).
    switchToWal(this.db, timeout);
    // Build (or, on a re-opened file, idempotently top up) the schema: base CREATE, the additive
    // widening, then the data migrations, exactly as the `:memory:` template above did.
    //
    // ONE TRANSACTION WHOSE FIRST STATEMENT READS THE MARKER (critic R1 F3). Checked on its own and
    // then built statement by statement, the whole schema pass (about 5 ms) was a window in which a
    // newer TILL could commit, and this build then ran its DDL over the newer book (re-creating an
    // index the newer schema had dropped) before any later check refused. Inside one transaction the
    // marker read pins the snapshot the DDL runs against: a newer commit after it makes this build's
    // first write fail with SQLITE_BUSY_SNAPSHOT, and nothing it wrote lands.
    const build = (): void => {
      assertGenerationNotNewer(bookGenerationOf(this.db), location);
      buildCurrentSchema(this.db);
    };
    if (brandNew) {
      // A BRAND-NEW file builds its schema as ONE transaction. Run statement by statement, the build
      // is several hundred autocommits, and with durable commits each of them
      // pays an F_FULLFSYNC: measured 2.1 s to create a store, against 0.18 s before durability. As
      // one transaction it is a single durable commit, and a crash mid-build leaves no half-built
      // schema behind.
      //
      // Two processes creating the same file at once first meet at the WAL switch above, which
      // retries until the other has let go. Here they meet again, and this time the busy timeout
      // does cover it: BEGIN IMMEDIATE asks for the write lock before this connection holds any lock,
      // which is the one case SQLite's busy handler waits on. So the second queues until the first
      // has committed, then finds the finished schema, and every statement in its build is a no-op.
      //
      // A re-open runs the same build in a DEFERRED transaction. On an up-to-date file every
      // statement is a no-op that writes nothing, so opening still never takes the write lock and the
      // COMMIT is a read transaction ending; an upgrade's additive ALTERs now share ONE durable commit.
      // A busy failure (a concurrent opener upgrading the same file, or a newer commit after the
      // snapshot) retries the whole transaction up to the busy timeout, and the retry reads the
      // marker again first.
      closingOnFailure(this.db, () => this.db.transaction(build).immediate());
    } else {
      closingOnFailure(this.db, () => retryWhileBusy(() => this.db.transaction(build)(), timeout));
    }
    // And once more after the build committed: a newer TILL that committed after the snapshot above
    // changed nothing this build wrote (it wrote nothing it could not), but the open must not hand
    // back a store over a book that is now newer. Refused here, the caller never holds it.
    closingOnFailure(this.db, () => this.assertGenerationKnown());
    this.switchOnWriteGuard();
  }

  /**
   * THE WRITE CHOKEPOINT goes live (see `GuardedDatabase`): from here on, a writing statement on this
   * connection outside a transaction runs inside `tx`, and one inside a transaction the store did not
   * open is checked under the lock. The closures look `tx` up at call time, so a caller that wraps
   * `store.tx` sees the chokepoint's transactions too.
   */
  private switchOnWriteGuard(): void {
    (this.db as GuardedDatabase).writeGuard = {
      tx: <T>(write: () => T): T => this.tx(write),
      afterWriteInOpenTransaction: () => this.afterWriteInOpenTransaction(),
    };
  }

  /**
   * How many of the store's OWN transactions (`tx`, `snapshotTx`) are running on the stack. Each read
   * the marker as its first statement, so while one is open every write in the transaction is covered
   * (see "why one read per transaction" on `GuardedDatabase`).
   */
  private ownTransactions = 0;

  /**
   * The one transaction function every `tx` and `snapshotTx` runs through, built once per connection.
   * better-sqlite3 builds its wrapper functions on every `db.transaction(fn)` call; taking the body as
   * an argument instead keeps a guarded bare write close to the autocommit it replaces (measured on
   * `:memory:`: 12.5 microseconds per statement with a new transaction function per call, 3.2 with
   * this one, 1.4 for the bare autocommit).
   */
  private transactionRunner: Database.Transaction<(body: () => unknown) => unknown> | undefined;

  private runner(): Database.Transaction<(body: () => unknown) => unknown> {
    this.transactionRunner ??= this.db.transaction((body: () => unknown): unknown => {
      this.assertGenerationKnown();
      this.ownTransactions += 1;
      try {
        return body();
      } finally {
        this.ownTransactions -= 1;
      }
    });
    return this.transactionRunner;
  }

  /**
   * Case 3 of the chokepoint: a write just ran inside a transaction that is already open. In one of
   * the store's own it is covered already. In any other (a raw `db.transaction`, an `exec('BEGIN')`)
   * the write has just taken the write lock on the newest snapshot, so this read is authoritative; on a
   * newer book the whole transaction is rolled back HERE, before the error leaves, so a caller that
   * catches it has nothing left to commit.
   */
  private afterWriteInOpenTransaction(): void {
    if (this.ownTransactions > 0 || !this.db.inTransaction) return;
    const refusal = newerGenerationRefusal(this.readGeneration(), this.location);
    if (refusal === null) return;
    Database.prototype.exec.call(this.db, 'ROLLBACK');
    this.refusals += 1;
    throw new SchemaNewerThanRuntimeError(refusal);
  }

  /**
   * How many generation refusals this store has raised since it opened (critic R4-2), counted BEFORE
   * each throw, so a refusal a caller catches and swallows is still counted. A verb that turns per-item
   * failures into an ok answer (`run_due_recurring`, `run_due_automations`) can return normally after
   * the book moved on and part of its work was refused; the registry reads this before and after a
   * verb, and says a call was saved WHOLE only when none was raised in between.
   */
  private refusals = 0;

  refusalCount(): number {
    return this.refusals;
  }

  /**
   * Run `fn` in a single transaction: all of its writes commit together, or none do.
   *
   * THE LIVE GENERATION GUARD (`./generation.ts`, critic finding M3). The open-time check cannot see
   * a book that moves on AFTER this store opened it: a newer TILL opening the same file (D12 puts a
   * second process on it, and the .mcpb extension and the CLI can be different releases) migrates it
   * to a generation this build does not know, and this long-lived store would go on writing
   * old-meaning rows into it. So the transaction's FIRST statement reads the marker and throws
   * `schema_newer_than_runtime` when the book is newer, before `fn` runs: `fn` never reads, writes
   * or acts outside the database on a book this build does not know. `rememberIdempotent` runs
   * through here, so every idempotent verb is covered with it.
   *
   * IMMEDIATE, BECAUSE D12 PUTS A SECOND WRITER ON THE FILE (critic R2-1). The outermost transaction
   * asks for the write lock in its BEGIN, before this connection holds any lock, and that is the one
   * request SQLite's busy handler waits on (btree.c `sqlite3BtreeBeginTrans` invokes it only from
   * TRANS_NONE). So a transaction that meets the other process's write lock WAITS for it, up to the
   * busy timeout, and then runs. Three things follow from holding the lock from the start:
   *
   *  - The marker read is AUTHORITATIVE: no other connection can commit between it and this
   *    transaction's COMMIT, a newer TILL's migration included. That is why there is no second read
   *    before commit; it would read the same value under the same lock (critic R2 B8 measured it as
   *    dead code).
   *  - SQLITE_BUSY_SNAPSHOT cannot happen: the snapshot is the newest one, taken under the lock.
   *  - It costs the lock for the whole of `fn`, reads included. A census over every conformance write
   *    scenario found no outermost `tx` that writes nothing (critic R2 q8), and the network and email
   *    steps of the verbs that have them run outside their transactions by design, so the lock is
   *    held for local work only.
   *
   * Round 1 began these DEFERRED with the marker as the first read. That pinned the snapshot, but a
   * deferred transaction that has read can never wait for the write lock (a reader waiting on a
   * writer is the deadlock the busy handler refuses to risk), so every write under D12 contention
   * failed at once as `store_busy`: measured 97 of 124 Studio posts against a second posting process,
   * where develop failed none. Do not go back to DEFERRED here.
   *
   * Nested `tx` calls run as savepoints inside the outermost transaction (better-sqlite3 switches to
   * SAVEPOINT whenever a transaction is open, whatever variant is asked for) and read the marker
   * again under the same lock, which costs 0.3 microseconds and can only agree.
   *
   * EVERY WRITE REACHES HERE, not only the verbs that ask for a transaction (critic R3-1). A writing
   * statement issued outside a transaction is run inside `tx` by the connection itself (THE WRITE
   * CHOKEPOINT, on `GuardedDatabase`), so a key-less verb, a helper or a run log that writes one
   * statement at a time is guarded exactly like a verb that wraps its work in one transaction. The
   * call sites that still wrap several writes in one `tx` (`set_bank_opening_balance`, `update_item`,
   * `stock_move`, `stock_stocktake_count`, `accept_invite`, the audit append) do it for ATOMICITY:
   * those writes commit together, and their checks read the same snapshot. The generation guarantee
   * no longer depends on any call site, and no census of bare writes is needed to keep it true.
   */
  tx<T>(fn: () => T): T {
    return this.runner().immediate(fn) as T;
  }

  /**
   * `tx` for a LONG READ that ends in a small write: `create_backup` and `export_workspace`, and
   * nothing else. It begins DEFERRED, so the read (2 to 12 s on a loaded box, critic R2 q4) holds no
   * write lock and the D12 second writer keeps posting meanwhile. Its first statement reads the
   * marker exactly as `tx` does, which pins the snapshot the whole read runs on to a generation this
   * build knows.
   *
   * The price is the one `tx` refuses to pay on every verb: a deferred transaction that has read
   * cannot wait for the write lock. When the other process commits during the read, or holds the lock
   * at the moment of the final write, that write fails at once with SQLITE_BUSY_SNAPSHOT or
   * SQLITE_BUSY and the registry answers the retryable `store_busy`; the caller removes what it
   * published (see `withKey` in `../data/portability.ts`). A newer TILL's commit after the pin lands
   * the same way, and the retry meets the marker read and is refused by name. Taking the write lock
   * for the whole read instead would make every write of the other process wait out the backup, and
   * fail once it ran past the busy timeout.
   */
  snapshotTx<T>(fn: () => T): T {
    return this.runner().deferred(fn) as T;
  }

  /** The marker read, prepared once per connection. */
  private generationRead: Database.Statement | undefined;

  /** `total_changes()`, prepared once per connection. */
  private changesRead: Database.Statement | undefined;

  /**
   * How many rows this connection has inserted, updated or deleted since it opened (SQLite's
   * `total_changes()`; it never touches the file, so it cannot be busy). The registry reads it before
   * and after a verb to tell a refusal that follows nothing from one that follows a commit (critic
   * R2-4): only the first may say the book was not changed. It over-counts, never under-counts: rows a
   * rolled-back statement changed are counted too, so a refusal is at worst called partial when
   * nothing it changed survived.
   */
  changeCount(): number {
    this.changesRead ??= this.db.prepare('SELECT total_changes()').pluck();
    return this.changesRead.get() as number;
  }

  /**
   * Throw `schema_newer_than_runtime` when the book has moved on to a generation newer than this
   * build since this store opened it. One prepared read of `PRAGMA user_version`, measured at about
   * 0.3 microseconds. `tx` and `snapshotTx` call it as their first statement; the registry and the
   * A35 seam call it before a verb runs.
   */
  assertGenerationKnown(): void {
    const refusal = newerGenerationRefusal(this.readGeneration(), this.location);
    if (refusal === null) return;
    this.refusals += 1;
    throw new SchemaNewerThanRuntimeError(refusal);
  }

  private readGeneration(): number {
    this.generationRead ??= this.db.prepare('PRAGMA user_version').pluck();
    return this.generationRead.get() as number;
  }

  /**
   * §H-IDEMPOTENT. Runs `compute` once for a given `(workspaceId, key)` and stores its result; a
   * later call with the same key skips `compute` and replays the stored result. The compute and the
   * bookkeeping row commit together, so a crash mid-write leaves neither.
   */
  /**
   * The stored result for a completed `(workspaceId, verb, key)`, or undefined. Lets a verb replay a
   * prior success before running state-dependent guards (so retrying a completed op never rejects).
   */
  recallIdempotent<T>(workspaceId: string, key: string, verb: string): T | undefined {
    const row = this.db
      .prepare('SELECT result_json FROM idempotency WHERE workspace_id = ? AND verb = ? AND key = ?')
      .get(workspaceId, verb, key) as { result_json: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.result_json) as T);
  }

  rememberIdempotent<T>(workspaceId: string, key: string, verb: string, compute: () => T): T {
    const existing = this.recallIdempotent<T>(workspaceId, key, verb);
    if (existing !== undefined) {
      return existing;
    }
    return this.tx(() => {
      const result = compute();
      this.db
        .prepare(
          'INSERT INTO idempotency (workspace_id, key, verb, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(workspaceId, key, verb, JSON.stringify(result), this.clock.now());
      return result;
    });
  }

  /**
   * Fold the write-ahead log back into the main database and truncate it.
   *
   * WAL mode writes go to `till.db-wal` first and only migrate on a checkpoint. Nothing here ever
   * checkpointed, so the sidecar grew without bound: 2 MB of WAL against a 4 KB database. TRUNCATE
   * (rather than PASSIVE) is what actually shrinks the file. It is a no-op on an in-memory database
   * and on a database another connection is actively reading, so it is always safe to call.
   */
  checkpoint(): void {
    if (this.location === ':memory:') return;
    try {
      // A housekeeping pragma: the write chokepoint passes it through (see `HOUSEKEEPING_PRAGMA`).
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // A checkpoint that loses a race with another connection is not a failure worth propagating:
      // the data is committed either way, and the next clean close will fold it in.
    }
  }

  /**
   * Checkpoint and close. Safe to call more than once, because shutdown paths run twice.
   *
   * There is deliberately no `PRAGMA optimize` here, and no `ANALYZE` anywhere in this class. That
   * is the obvious thing to add beside a checkpoint, SQLite's own documentation recommends it as a
   * close-time idiom, and it is the wrong call for TILL. The reasoning is below so the next reader
   * does not have to re-derive it; `test/core/store-statistics.test.mjs` holds it in place.
   *
   * WHAT STATISTICS WOULD BUY, measured interleaved on 10'000 entries / 30'000 lines / 1'000
   * documents (four arms in one process, batches alternated, median round):
   *
   *   close_year P&L sweep        54.5 ms -> 19.3 ms   once a fiscal year
   *   issueInvoice receivable    0.195 ms -> 0.012 ms  once per invoice issue
   *   taxCodes posted-ref guard   0.91 ms ->  3.74 ms  WORSE, on a rare admin verb
   *   newestFxPosting             1.80 ms ->  3.69 ms  WORSE, on a rare admin verb
   *   listJournal                 6.35 ms ->  6.39 ms  unchanged
   *   listDocuments               2.86 ms ->  2.84 ms  unchanged
   *   listAccounts in_use        0.035 ms -> 0.041 ms  unchanged
   *   getEntry lines             0.011 ms -> 0.011 ms  unchanged
   *   post an entry + 3 lines    0.0146 ms -> 0.0145 ms  unchanged
   *
   * So: nothing a user can perceive moves in either direction. Every read that actually runs often
   * is unchanged, the write path is unchanged, and the two real relative wins are worth 35 ms a YEAR
   * and 0.18 ms an invoice. Two statements get meaningfully worse. On this evidence the benefit is
   * indistinguishable from zero, which means any cost at all decides it.
   *
   * WHAT IT WOULD COST, and this is the part specific to TILL rather than to SQLite in general:
   *
   *  * ANALYZE is a WRITE (it populates sqlite_stat1), and D12 puts a SECOND writer on the file: the
   *    Studio holds the database open while `till mcp` runs in an agent subprocess. Measured, with
   *    the other connection inside a write transaction, ANALYZE waited 5410 ms and then threw
   *    SQLITE_BUSY. On close(). That is a five-second hang and an exception on a path whose entire
   *    job is to exit cleanly, bought for a benefit of zero. `PRAGMA optimize` behaves identically,
   *    because it IS ANALYZE.
   *  * Dropping the busy timeout to 0 avoids the hang (measured: fails in under 1 ms) but not the
   *    problem: the statistics then exist or do not depending on who held the lock at shutdown, so
   *    the planner's behaviour stops being reproducible between runs. Non-deterministic plans on a
   *    ledger are worse than uniformly pessimistic ones.
   *  * Statistics also go STALE, and nothing re-derives them. Measured: analyzed at 200 lines, the
   *    stored row count still read 200 after the ledger grew to 2000. A stale statistic is worse
   *    than none, because the planner trusts it. So "ANALYZE once at setup" is not a way out either.
   *  * And an already-open connection does not re-plan when another process writes statistics, so in
   *    the very deployment that makes the lock dangerous, the benefit does not even arrive promptly.
   *
   * WHAT WE DO INSTEAD, where a plan genuinely needs correcting: SQLite's per-query levers, which
   * take no lock, never go stale, and are visible in the statement they affect. For the receivable
   * read-back this is measurably BETTER than statistics, not merely cheaper: 193.5 us as-is,
   * 11.8 us with a full ANALYZE, 7.2 us with `INDEXED BY journal_line_entry`. Both statements that
   * needed a lever have one, and both live outside this module:
   *
   *   src/core/sales/invoice.ts     receivable read-back:
   *     `FROM journal_line INDEXED BY journal_line_entry`
   *   src/core/ledger/yearClose.ts  P&L sweep, a join-ORDER fix rather than an index choice:
   *     `FROM journal_entry e CROSS JOIN journal_line l INDEXED BY journal_line_entry ON l.entry_id = e.id`
   *
   * The sweep is worth reading closely, because an earlier revision of this note recommended
   * `FROM journal_line l NOT INDEXED` there and that advice was wrong enough to undo the fix. Both
   * levers answer the same question (the planner has no statistics, so it does not know the
   * selective fence lives on journal_entry: one workspace, one year, posted, not a close), but they
   * answer it with different ambition. `NOT INDEXED` only restores the plain table scan the sweep
   * had before the indexes existed, and a scan still reads every line of every year. Pinning the
   * join ORDER instead makes journal_entry the outer loop, so the date fence throws rows away BEFORE
   * their lines are ever fetched. Re-measured for this note, interleaved: separate seeded databases
   * in one process exercised in a rotating round, 10'000 entries / 30'000 lines, 21 scored rounds,
   * median round, all four arms asserted to return identical rows.
   *
   *                          3 years of history   single year   in memory, 3 years
   *   as-is                        13.73 ms         16.54 ms         13.45 ms
   *   NOT INDEXED             8.63 ms  1.59x   13.70 ms  1.21x    8.55 ms  1.57x
   *   as shipped              3.29 ms  4.17x    9.99 ms  1.66x    3.28 ms  4.10x
   *   as-is after ANALYZE     3.34 ms  4.11x   10.09 ms  1.64x    3.35 ms  4.01x
   *
   * So the shipped form reaches exactly what a full ANALYZE would buy, without taking the lock, and
   * `NOT INDEXED` leaves more than half the win on the table in every shape measured. A file-backed
   * and an in-memory database land within a few percent of each other, because 30'000 lines are
   * resident either way, so a test suite on `:memory:` is a fair place to observe this.
   *
   * AND THE FACT THAT EXPLAINS WHY THE NUMBER MOVES: the sweep's gain scales with how much of the
   * book lies OUTSIDE the year being closed, because that is exactly the population the join order
   * decides whether to touch. Holding the book constant at 10'000 entries and varying only how many
   * fiscal years they spread over (same harness, 15 scored rounds):
   *
   *   share of the book outside the closed year    0%     50%    67%    80%    90%
   *   as-is                                     16.29  14.56  14.17  13.33  12.90 ms
   *   as shipped                                 9.88   5.39   3.46   2.77   1.73 ms
   *   gain                                       1.65x  2.70x  4.10x  4.81x  7.45x
   *
   * A single-year fixture therefore HIDES most of this, which is a trap for the next person who
   * measures: a book with no history is the one shape where the fix looks marginal, and it is also
   * the one shape nobody ever closes a year on. Seed prior years, or the number is not about TILL.
   *
   * This decision would deserve re-opening if any of these changed: a frequently-run statement began
   * to depend on the planner's cardinality guess, D12's second writer went away, or SQLite grew a
   * way to collect statistics without taking the write lock.
   */
  close(): void {
    if (!this.db.open) return;
    this.checkpoint();
    this.db.close();
  }
}
