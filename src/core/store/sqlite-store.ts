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

import Database from 'better-sqlite3';

import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';
import { SCHEMA_SQL, ADDITIVE_COLUMNS, ADDITIVE_INDEXES, SCHEMA_GENERATION } from './schema.js';
import { DATA_MIGRATIONS } from './migrations.js';

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
    this.db = new Database(location, { timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS });
    this.db.pragma('foreign_keys = ON');
    // Without this, SQLite's REPLACE conflict resolution deletes the conflicting row WITHOUT firing
    // the BEFORE DELETE trigger, so `INSERT OR REPLACE` would route around posted-row immutability.
    // With it on, REPLACE's implicit delete fires journal_entry_no_delete_posted and aborts.
    this.db.pragma('recursive_triggers = ON');
    if (location !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.exec(SCHEMA_SQL);
    // Widen the shape and add the indexes over the widened columns, exactly as `applyAdditiveSchema`
    // (module scope below) does for any freshly-built database, so the store, an `:memory:` test DB
    // and G04's backup snapshot all run the IDENTICAL schema rather than only the base CREATE path.
    applyAdditiveSchema(this.db);
    this.applyDataMigrations();
  }

  /**
   * Apply the DATA migrations this file has not seen (M-3, see `./migrations.ts`).
   *
   * `applyAdditiveMigrations` above widens a table's SHAPE, which was enough while every schema
   * change was a new nullable column. It cannot help when a change alters what an EXISTING stored
   * number MEANS, and the §H-FX rate-scale widening does exactly that: the same `rate_scaled` integer
   * denotes a rate four orders of magnitude different before and after. A ledger that reinterprets a
   * stored number in silence is worse than one that refuses to open.
   *
   * `PRAGMA user_version` is the generation marker. It is 0 on every database written before this,
   * because nothing ever set it, and 0 is precisely "written at the old rate scale". The migrations
   * and the version bump commit TOGETHER, so a crash mid-run leaves the old generation and the old
   * rows and the next open simply retries. There is no half-migrated state to reason about.
   */
  private applyDataMigrations(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version >= SCHEMA_GENERATION) return;

    this.db.transaction(() => {
      for (const migration of DATA_MIGRATIONS) {
        if (migration.generation > version) migration.apply(this.db);
      }
      // Not a bound parameter: PRAGMA does not take one. SCHEMA_GENERATION is a module constant, so
      // there is no input here to interpolate.
      this.db.pragma(`user_version = ${SCHEMA_GENERATION}`);
    })();
  }

  /** Run `fn` in a single transaction: all of its writes commit together, or none do. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
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
