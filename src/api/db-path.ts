/**
 * Where the ledger lives on disk: ONE answer, shared by every face of the engine (D12).
 *
 * Before this, the Studio's dev bridge hardcoded `app/.dev-data/till.db` while `till mcp` defaulted
 * to `:memory:`. The Studio and the agent were therefore not on one ledger, which quietly falsifies
 * the central product claim: the agent could post an entry the human could never see.
 *
 * The rule is now three rungs, most specific first, and every face (`till up`, `till mcp`, `till serve`)
 * resolves through this one function, so they still land on ONE file:
 *
 *   1. `TILL_DB_PATH`, when it is set: a launcher (TILL.app's `app.json` command, a private install's
 *      script, a test) PINS the book, and nothing below may override it;
 *   2. the ADOPTED book (D166 point 8, owner 14.10.2026): `<support dir>/book.json`, holding
 *      `{ "dbPath": "<absolute>" }`, written by the Studio's first-run door "Bestehende Datenbank
 *      übernehmen" (`book-adopt.ts`) so a person adopts an existing book without a terminal. It is read
 *      only when it is a plain file (never a symlink), owned by this user, writable by nobody else, and
 *      names an absolute path; anything else is ignored, never half-trusted. A recorded book that has
 *      gone (a moved file, an unmounted drive) is NOT replaced by the default (critic F1): the answer
 *      says it is unavailable and resolves to `:memory:`, so nothing is written anywhere until the
 *      person decides in the Studio (`resolveDbChoice`);
 *   3. `~/.till/till.db`.
 *
 * The default sits in the home directory rather than in the project, so it is the same file whatever
 * directory an agent subprocess happens to be spawned in, and so a checkout is never the place the
 * books live. `:memory:` is honoured verbatim for an ephemeral run.
 */

import { lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';

import { makeDirectoryDurably } from '../core/store/sqlite-store.js';

/** The in-memory location, spelled the way better-sqlite3 spells it. */
export const MEMORY_DB = ':memory:';

/** The default directory holding the ledger, when `TILL_DB_PATH` says nothing. */
export function defaultDbDir(home = homedir()): string {
  return join(home, '.till');
}

/** The default ledger file. */
export function defaultDbPath(home = homedir()): string {
  return join(defaultDbDir(home), 'till.db');
}

/** The adopted-book file, inside the support directory (D166 point 8). */
export const ADOPTED_BOOK_FILE = 'book.json';

/** Is `TILL_DB_PATH` set to something? A blank value counts as unset, as in `resolveDbPath`. */
export function isDbPathPinned(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.TILL_DB_PATH?.trim();
  return configured !== undefined && configured !== '';
}

/**
 * The book `<support dir>/book.json` RECORDS, whether or not that file is there right now, or null
 * when there is no record worth trusting: no file, a symlink, not a plain file, owned by someone
 * else, writable by group or world, not JSON, or a `dbPath` that is not an absolute path. Never throws.
 */
export function readAdoptedBookPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = join(resolveSupportDir(env), ADOPTED_BOOK_FILE);
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return null;
    // POSIX only: Windows reports synthetic mode bits and no owner; its ACLs are the user profile's.
    if (process.platform !== 'win32') {
      if ((st.mode & 0o022) !== 0) return null;
      const uid = process.getuid?.();
      if (uid !== undefined && st.uid !== uid) return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const dbPath = (parsed as { dbPath?: unknown } | null)?.dbPath;
    if (typeof dbPath !== 'string' || dbPath.trim() === '' || !isAbsolute(dbPath)) return null;
    return dbPath;
  } catch {
    return null;
  }
}

/** Why an adopted book cannot be opened: the file is gone, or it is there and the open failed. */
export type AdoptedBookUnavailableReason = 'missing' | 'unopenable';

/** An adopted book this process could not open. Reported to the Studio, never papered over. */
export interface AdoptedBookUnavailable {
  path: string;
  reason: AdoptedBookUnavailableReason;
}

/**
 * Which book this process should open, and WHY (critic F1 on D166 point 8). The adopted book is
 * never silently replaced: when `book.json` names a file that is not there, the answer says so
 * (`adoptedUnavailable`) and `path` is `:memory:`, so a face that does open something writes
 * nowhere. `till up` then shows the Studio's "not reachable" page; `till mcp` and `till serve` refuse.
 */
export interface DbChoice {
  path: string;
  source: 'env' | 'adopted' | 'default';
  adoptedUnavailable?: AdoptedBookUnavailable;
}

function isMissing(path: string): boolean {
  try {
    return !statSync(path).isFile();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Gone (or a path through something that is no longer a directory). Any other stat failure
    // (a permission) leaves the file to the open, which then reports it as unopenable.
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/** `TILL_DB_PATH`, else the adopted book (or the honest report that it is unavailable), else the default. */
export function resolveDbChoice(env: NodeJS.ProcessEnv = process.env): DbChoice {
  if (isDbPathPinned(env)) return { path: (env.TILL_DB_PATH as string).trim(), source: 'env' };
  const adopted = readAdoptedBookPath(env);
  if (adopted === null) return { path: defaultDbPath(), source: 'default' };
  if (isMissing(adopted)) return { path: MEMORY_DB, source: 'adopted', adoptedUnavailable: { path: adopted, reason: 'missing' } };
  return { path: adopted, source: 'adopted' };
}

/**
 * The path this process should open: `TILL_DB_PATH`, else the adopted book, else `~/.till/till.db`.
 * A blank or whitespace-only `TILL_DB_PATH` is treated as unset, because an empty environment
 * variable is a misconfiguration, not a request for a file named ''. An adopted book that is missing
 * resolves to `:memory:`, never to the default (see `resolveDbChoice`).
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDbChoice(env).path;
}

/**
 * `resolveDbChoice`, plus the directory of the chosen file made durably (as `ensureDbPath` does). Not
 * for an unavailable adopted book: its path is `:memory:`, so nothing is created anywhere.
 */
export function ensureDbChoice(env: NodeJS.ProcessEnv = process.env): DbChoice {
  const choice = resolveDbChoice(env);
  if (choice.path !== MEMORY_DB) makeDirectoryDurably(dirname(choice.path));
  return choice;
}

/** The one sentence a terminal face prints when it refuses to start without the adopted book. */
export function adoptedUnavailableRefusal(face: string, unavailable: AdoptedBookUnavailable): string {
  const what = unavailable.reason === 'missing' ? 'is not reachable (the file is not there)' : 'cannot be opened';
  return `${face}: the TILL book you adopted ${what}: ${unavailable.path}. Nothing was opened or created. Open TILL to fix it: it shows what to do.`;
}

/**
 * Resolve the path AND make sure its directory exists, so opening it cannot fail on a fresh machine.
 * Returns the path, so a caller can hand it straight to the store.
 *
 * A directory created here (on a first run, `~/.till`) is created DURABLY: its parent is synced, so a
 * power cut cannot take the new directory, and the ledger the store then creates inside it, back out
 * of existence. The store syncs the ledger's own directory entry when it creates the file.
 */
export function ensureDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const path = resolveDbPath(env);
  if (path !== MEMORY_DB) makeDirectoryDurably(dirname(path));
  return path;
}

/**
 * G08's directory. Honours `TILL_SUPPORT_DIR` the way `resolveDbPath` honours `TILL_DB_PATH`.
 *
 * The env var exists so a test run can never write into the developer's real `~/.till/`. A suite
 * that builds its own `ApiDeps` and forgets to inject `supportDir` would otherwise land feedback
 * artifacts in a real home directory, which is both untidy and a bad look for the one capability
 * whose whole claim is that it keeps to itself.
 */
export function resolveSupportDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TILL_SUPPORT_DIR?.trim();
  return configured === undefined || configured === '' ? defaultDbDir() : configured;
}

/**
 * G04's backup directory: where `.tillbackup` / `.tillexport` artifact bundles are written.
 *
 * Three rungs, most specific first: `TILL_BACKUP_DIR` names the directory outright; otherwise a set
 * `TILL_SUPPORT_DIR` puts the artefacts UNDER it (`<support>/backups`); otherwise `~/.till/backups`.
 *
 * The middle rung is F-06 (2026-09-05). Before it, a harness run that isolated everything else
 * under its own support dir still wrote every backup and export into the developer's real
 * `~/.till/backups` (the J7 measurement left bundles there), and a served instance that mounts its
 * support dir on a volume would have kept its backups OFF that volume. The support dir is the one
 * directory an operator already points at machine state (G08's diagnostics, the `till up` lock), so
 * the artefacts follow it; the default for a plain local install does not move.
 */
export function resolveBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TILL_BACKUP_DIR?.trim();
  if (configured !== undefined && configured !== '') return configured;
  const support = env.TILL_SUPPORT_DIR?.trim();
  if (support !== undefined && support !== '') return join(support, 'backups');
  return join(defaultDbDir(), 'backups');
}
