/**
 * Adopt an existing TILL book, without a terminal (D166 point 8, owner 14.10.2026).
 *
 * The first-run door "Bestehende Datenbank übernehmen" used to print `TILL_DB_PATH=... till up` for the
 * person to type into a terminal. The owner's rule: a person clicks the TILL icon and everything just
 * works, and nobody is sent to a terminal. So the door now names the file (TILL.app hands it a native
 * file picker, a browser a path field), and the host:
 *
 *   1. PROBES the file read-only (`probeBook`): it must exist, be a plain file this user may read and
 *      write, open as SQLite, carry the TILL tables (`workspace`, `account`, `journal_entry`) with every
 *      column each generation guarantees, and have a generation this runtime knows. The probe never
 *      writes, never migrates, never creates a file;
 *   2. records it as the ADOPTED book in `<support dir>/book.json` (owner-only, temp file and rename,
 *      the same writer as the Studio key), which `resolveDbChoice` reads on the next start, so every
 *      face (`till up`, `till mcp`) lands on the one ledger (D12);
 *   3. and the caller restarts the host (the Studio door, `studio-door.ts`).
 *
 * `forgetBook` undoes it ("Vergessen und neu beginnen" on the Studio's "not reachable" page): it removes
 * `book.json` only, failing closed, so the next start opens the default book.
 *
 * THE BOOK ITSELF IS NEVER COPIED, MOVED OR WRITTEN HERE. A path is deployment state, not tenant data,
 * so this is host configuration with no MCP verb: no agent can repoint the person's books. A host whose
 * launcher PINS the book (`TILL_DB_PATH` set, e.g. a private install's script) refuses with
 * `book_path_pinned`: the Studio must not override what the launcher decided.
 */

import { accessSync, constants as fsConstants, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import Database from 'better-sqlite3';

import { ADDITIVE_COLUMNS, SCHEMA_GENERATION, SCHEMA_SQL } from '../core/store/schema.js';
import { ADOPTED_BOOK_FILE, isDbPathPinned, MEMORY_DB, type AdoptedBookUnavailable, type DbChoice } from './db-path.js';
import { writeOwnerOnlyFile } from './studio-key-store.js';

/** The tables a file must carry to be a TILL book. */
export const TILL_BOOK_TABLES = ['workspace', 'account', 'journal_entry'] as const;

const CONSTRAINT_WORDS = new Set(['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'CONSTRAINT']);

/**
 * The columns of `table` that EVERY book this runtime can open carries (critic F2): the columns of its
 * base `CREATE TABLE` in `SCHEMA_SQL`, minus every column `ADDITIVE_COLUMNS` adds on open (those came
 * later, so an older book may lack them until it is opened). Nothing else adds a column to these
 * tables, so a book without one of the rest could not be opened anyway. Derived from the schema itself,
 * so it cannot drift from it; `user_version` cannot be the check, because 0 is a legitimate old book.
 */
export function guaranteedColumns(table: string): readonly string[] {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(SCHEMA_SQL);
  if (match === null) throw new Error(`book-adopt: no base CREATE TABLE for ${table} in SCHEMA_SQL`);
  const additive = new Set(ADDITIVE_COLUMNS.filter((c) => c.table === table).map((c) => c.column));
  const columns: string[] = [];
  for (const raw of (match[1] as string).split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('--')) continue;
    const name = /^([A-Za-z_][A-Za-z0-9_]*)\s/.exec(line)?.[1];
    if (name === undefined || CONSTRAINT_WORDS.has(name.toUpperCase())) continue;
    if (!additive.has(name)) columns.push(name);
  }
  if (columns.length === 0) throw new Error(`book-adopt: no guaranteed columns derived for ${table}`);
  return columns;
}

/** Every table a TILL book must carry, with the columns every generation of it guarantees. */
export const TILL_BOOK_REQUIRED_COLUMNS: Readonly<Record<(typeof TILL_BOOK_TABLES)[number], readonly string[]>> = {
  workspace: guaranteedColumns('workspace'),
  account: guaranteedColumns('account'),
  journal_entry: guaranteedColumns('journal_entry'),
};

/** Why a file cannot be adopted. Each code has its own sentence in the Studio, in both locales. */
export type AdoptRefusal =
  | 'book_path_pinned'
  | 'book_path_not_absolute'
  | 'book_not_found'
  | 'book_unreadable'
  | 'not_a_till_database'
  | 'schema_newer_than_runtime'
  | 'book_already_open'
  | 'book_not_saved';

export type ProbeResult =
  | { ok: true; dbPath: string; generation: number }
  | { ok: false; error: 'book_not_found' | 'book_unreadable' | 'not_a_till_database' | 'schema_newer_than_runtime' };

export type AdoptResult = { ok: true; dbPath: string } | { ok: false; error: AdoptRefusal };

/**
 * Is `path` a TILL book this runtime can open? Read-only: the file is opened with `readonly` and
 * `fileMustExist`, so nothing is created, migrated or written. It must carry the TILL tables with
 * every column each generation guarantees (a foreign SQLite with lookalike table names is refused,
 * critic F2), and a generation this runtime knows. `dbPath` is the real path (symlinks resolved),
 * which is what gets recorded. Never throws.
 */
export function probeBook(path: string): ProbeResult {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, error: 'book_not_found' };
  }
  try {
    if (!statSync(real).isFile()) return { ok: false, error: 'not_a_till_database' };
  } catch {
    return { ok: false, error: 'book_not_found' };
  }
  // A file this user may not read and write (a permission, a read-only volume) cannot be a book TILL
  // keeps: say so instead of calling it "not a TILL book".
  try {
    accessSync(real, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    return { ok: false, error: 'book_unreadable' };
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(real, { readonly: true, fileMustExist: true });
    for (const table of TILL_BOOK_TABLES) {
      const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      if (present.size === 0) return { ok: false, error: 'not_a_till_database' };
      for (const column of TILL_BOOK_REQUIRED_COLUMNS[table]) {
        if (!present.has(column)) return { ok: false, error: 'not_a_till_database' };
      }
    }
    const version = db.pragma('user_version', { simple: true });
    const generation = typeof version === 'number' ? version : 0;
    if (generation > SCHEMA_GENERATION) return { ok: false, error: 'schema_newer_than_runtime' };
    return { ok: true, dbPath: real, generation };
  } catch {
    // Not SQLite, encrypted, truncated, locked in a way a read cannot pass: not a book we can take.
    return { ok: false, error: 'not_a_till_database' };
  } finally {
    try {
      db?.close();
    } catch {
      // a read-only handle has nothing to flush
    }
  }
}

export interface AdoptOptions {
  /** The host's environment: a set `TILL_DB_PATH` pins the book. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The book the host has open right now, so adopting it again is named instead of restarting. */
  openPath?: string | undefined;
}

function realOrNull(path: string | undefined): string | null {
  if (path === undefined || path === '' || path === MEMORY_DB) return null;
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Record `path` as the book this support directory opens from the next start on. Refuses (and writes
 * nothing) unless the file is a TILL book this runtime can open and differs from the open one.
 */
export function adoptBook(supportDir: string, path: unknown, opts: AdoptOptions = {}): AdoptResult {
  if (isDbPathPinned(opts.env ?? process.env)) return { ok: false, error: 'book_path_pinned' };
  if (typeof path !== 'string' || path.trim() === '' || !isAbsolute(path.trim())) {
    return { ok: false, error: 'book_path_not_absolute' };
  }
  const probe = probeBook(path.trim());
  if (!probe.ok) return probe;
  if (probe.dbPath === realOrNull(opts.openPath)) return { ok: false, error: 'book_already_open' };
  const saved = writeOwnerOnlyFile(join(supportDir, ADOPTED_BOOK_FILE), `${JSON.stringify({ dbPath: probe.dbPath }, null, 2)}\n`);
  return saved ? { ok: true, dbPath: probe.dbPath } : { ok: false, error: 'book_not_saved' };
}

/**
 * THE ONE GATE every face runs on an adopted book before any writable open (critic L-b): the choice
 * already knows the file is missing, or the read-only probe refuses it now (gone, unreadable, read-only,
 * no longer a TILL book, a newer generation). `till up` then runs on its stand-in; `till mcp` and
 * `till serve` refuse with `adoptedUnavailableRefusal`. Null when the book may be opened (or the choice
 * did not come from `book.json` at all). Never writes.
 */
export function adoptedChoiceUnavailable(choice: DbChoice): AdoptedBookUnavailable | null {
  if (choice.adoptedUnavailable !== undefined) return choice.adoptedUnavailable;
  if (choice.source !== 'adopted') return null;
  const probe = probeBook(choice.path);
  if (probe.ok) return null;
  return { path: choice.path, reason: probe.error === 'book_not_found' ? 'missing' : 'unopenable' };
}

export type ForgetResult = { ok: true } | { ok: false; error: 'book_path_pinned' | 'book_not_forgotten' };

/**
 * "Vergessen und neu beginnen": forget the adopted book, so the next start opens the default book.
 * Only `book.json` goes; the book file itself is never touched. FAIL CLOSED: a `book.json` that
 * cannot be removed answers `book_not_forgotten`, and the caller must not restart (it would come back
 * on the same unavailable book). An absent `book.json` is already forgotten.
 */
export function forgetBook(supportDir: string, opts: { env?: NodeJS.ProcessEnv } = {}): ForgetResult {
  if (isDbPathPinned(opts.env ?? process.env)) return { ok: false, error: 'book_path_pinned' };
  const file = join(supportDir, ADOPTED_BOOK_FILE);
  try {
    rmSync(file, { force: true });
  } catch {
    return { ok: false, error: 'book_not_forgotten' };
  }
  try {
    statSync(file);
    return { ok: false, error: 'book_not_forgotten' }; // still there: the removal did not take
  } catch {
    return { ok: true };
  }
}
