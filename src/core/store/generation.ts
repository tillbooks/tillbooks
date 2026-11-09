/**
 * THE GENERATION GUARD: an older TILL never writes a book that a newer TILL wrote.
 *
 * `PRAGMA user_version` is the book's schema GENERATION (see `applyDataMigrations` in
 * `./sqlite-store.ts` and `./migrations.ts`), and `SCHEMA_GENERATION` is the generation THIS build
 * knows. A generation can change what an existing stored number MEANS (the §H-FX `rate_scaled`
 * widening is the first one that did), so a file above this build's generation holds rows this
 * build cannot read correctly. Opening such a book writable and carrying on is a silent money-path
 * corruption: the old code writes old-meaning numbers beside new-meaning ones, and nothing records
 * which is which. Until critic finding M3 the store open did exactly that, because the migration step
 * simply returned when `user_version >= SCHEMA_GENERATION`.
 *
 * The rule, with ONE comparison every path calls (`newerGenerationRefusal`):
 *
 *  - Every WRITABLE open of a book is refused when the book is newer than the build. Every writable
 *    open goes through `SqliteStore` (the driver allowlist in `test/core/store-durability.test.mjs`
 *    holds that in place), and the store checks right after the connection is made durable and
 *    BEFORE the WAL switch, the schema DDL, the additive ALTERs, the data migrations and any write.
 *    So `till up`, `till serve`, `till mcp`, the landscape builds and the seed scripts all refuse, and
 *    the refused book's main file and any -wal are left byte-for-byte as they were (on a quiet book
 *    the read-only look may leave an empty -wal and a -shm, which hold no data; critic R2-5). The one
 *    exception is a hot rollback journal, which only a writable connection may roll back: that open
 *    returns the main file to its last committed content, then reads the marker and refuses before
 *    anything else (critic R3-4).
 *  - A book that moves on UNDER an open store (a newer TILL migrates it while this older process
 *    still holds it: D12's second writer, the .mcpb extension beside a newer CLI) is refused from
 *    then on, by ONE mechanism rather than by call sites: the store's connection is a write
 *    chokepoint (`GuardedDatabase` in `./sqlite-store.ts`, critic R3-1). Every statement that writes
 *    runs inside a transaction whose marker was read, under the write lock when the store opened
 *    that transaction itself (`SqliteStore.tx` begins IMMEDIATE and reads the marker first), so an
 *    older build never writes a row into a newer book, whichever verb, helper or key-less path issued
 *    it. The registry reads the marker before every workspace verb (reads included) and every
 *    pre-workspace write, and again after it returns (critic R3-2), so a read that spans a newer
 *    TILL's migration is refused instead of answering with mixed data. A refusal raised after the call
 *    had already committed part of its work says so (`partial`, see `refusalFields`).
 *  - A `.tillbackup` whose SNAPSHOT file is newer is refused by `verify_backup`, which is also the
 *    pre-flight of `restore_backup`, before anything is created. G04's own exact-match rule on the
 *    manifest's `schemaVersion` (`incompatible_schema_version`, spec §0a.6) stays as it is and runs
 *    first; this closes the case of a manifest that disagrees with the file it describes.
 *
 * READ-ONLY OPENS, decided deliberately. A read-only connection cannot corrupt the book, but it CAN
 * misread a number whose meaning changed, so the default is refusal, and it is the default by
 * construction: the store has no read-only mode, so no store can be OPENED over a newer book, and a
 * book that moves on under an open store refuses every workspace verb from then on. The only
 * read-only connections are the raw driver opens inside the modules
 * the durability test allows, and each is explicit about why it may touch a newer file:
 *
 *  - landscape `copy.ts` `rawSchemaGeneration` reads ONLY the marker, to refuse a newer source
 *    (`source_schema_newer`) before a store is ever opened over it, and its `countWorkspaces` reads
 *    one row count for a copy plan;
 *  - G04's snapshot reads run behind the manifest's exact-match check and, with this guard, behind
 *    the snapshot's own marker;
 *  - the landscape gates read files THIS build has just built;
 *  - `ops/private-data-scan.mjs` fingerprints the owner's ledger as strings and interprets no amount.
 *
 * None of them interprets the money rows of a newer book. A new read-only reader that would must call
 * `newerGenerationRefusal` first.
 *
 * WHY THE CHOKEPOINT SITS ON THE CONNECTION AND NOT IN THE SCHEMA. Rounds 1 to 3 of the critique
 * each found writes that bypassed per-call-site checks, so the guard had to be one point every write
 * passes. The schema-level form of that was measured and rejected in round 1: per-connection TEMP
 * triggers (`BEFORE INSERT/UPDATE/DELETE ... WHEN (SELECT user_version FROM pragma_user_version) >
 * build ... RAISE(ABORT)` on every table) took a store open from 24 to 72 ms and a single-row insert
 * from 5.2 to 7.4 microseconds, needed re-installing whenever a table is created, and refused with
 * SQLITE_CONSTRAINT_TRIGGER instead of the typed error. The connection-level chokepoint costs a
 * `readonly` lookup per prepare, one flag check per write inside a transaction, and about 1.2
 * microseconds per write that was a bare autocommit (the BEGIN, the marker read and the COMMIT it now
 * runs in); its refusal is the typed error.
 *
 * This module loads no SQLite driver (the `Database` import is type-only), so the CLI and any
 * face can recognise the error without pulling in the native dependency.
 */

import type Database from 'better-sqlite3';

import { SCHEMA_GENERATION } from './schema.js';

/**
 * The stable code of the refusal. It is the code M00, M02 and M03 already name for "a database file
 * newer than the runtime opening it", and the Studio's first-run door already renders it.
 */
export const SCHEMA_NEWER_THAN_RUNTIME = 'schema_newer_than_runtime';

/** What a refusal carries: the book's generation, the build's generation, and the file. */
export interface NewerGenerationDetail {
  readonly bookGeneration: number;
  readonly buildGeneration: number;
  readonly path: string;
}

/** The sentence a human reads (the CLI prints it verbatim). English, like every other CLI line. */
export function newerGenerationMessage(detail: NewerGenerationDetail): string {
  return (
    `This book was written by a newer TILL (generation ${detail.bookGeneration}). ` +
    `This TILL knows generation ${detail.buildGeneration}. Update TILL before opening it.\n` +
    `The book was not changed: ${detail.path}`
  );
}

/** The typed, catchable refusal a writable open throws. */
export class SchemaNewerThanRuntimeError extends Error {
  readonly code = SCHEMA_NEWER_THAN_RUNTIME;
  readonly bookGeneration: number;
  readonly buildGeneration: number;
  readonly path: string;

  constructor(detail: NewerGenerationDetail) {
    super(newerGenerationMessage(detail));
    this.name = 'SchemaNewerThanRuntimeError';
    this.bookGeneration = detail.bookGeneration;
    this.buildGeneration = detail.buildGeneration;
    this.path = detail.path;
  }
}

/**
 * The sentence for a refusal raised AFTER the call had already written to the book (critic R2-4): a
 * verb that commits in steps (a send recorded before and after the email, a draft settled after the
 * verb it approved) can meet the moved-on book at a later step. "The book was not changed" would then
 * be false, so this one says what is true instead.
 */
export function newerGenerationPartialMessage(detail: NewerGenerationDetail): string {
  return (
    `A newer TILL (generation ${detail.bookGeneration}) changed this book while this call ran. ` +
    `This TILL knows generation ${detail.buildGeneration}. Update TILL before you use the book again.\n` +
    `Part of this call was already saved before that; the rest was not written. ` +
    `Check what was saved before you repeat it: ${detail.path}`
  );
}

/**
 * The sentence for a call that COMPLETED and wrote, after which the registry found the book moved on
 * (critic R3-2: the marker is read again once the verb returns). Every write of the call is saved:
 * the write chokepoint refuses any write after the move, so a verb that returned normally wrote
 * nothing after it. What the call answered may already be stale, so it is not handed back.
 */
export function newerGenerationSavedMessage(detail: NewerGenerationDetail): string {
  return (
    `A newer TILL (generation ${detail.bookGeneration}) changed this book right after this call. ` +
    `This TILL knows generation ${detail.buildGeneration}. Update TILL before you use the book again.\n` +
    `This call was saved before that, but its answer may no longer match the book: ${detail.path}`
  );
}

/**
 * The P9 fields of a refusal, for a face that RETURNS it instead of throwing it (the registry's throw
 * guard, the A35 governed dispatch): the version pair, the file, the human sentence, and `partial`,
 * which is true when this call had already written to the book before the refusal (critic R2-4; the
 * registry measures it, see `guarded` in `src/api/registry.ts`). A partial refusal never carries the
 * "was not changed" sentence.
 *
 * `completed` (critic R4-1) is a FIELD, not only a sentence: every face (MCP, REST, the Studio) reads
 * the code and the flags, never the English `message`, so the Studio could tell "saved whole, then the
 * book moved on" from "saved in part" only if the engine says so in data. It is true when the call
 * returned normally before the refusal (the registry's check after the verb) and raised no refusal of
 * its own on the way; with `partial` it means the call was saved whole. A retry of such a call would
 * repeat it, so no face may invite one.
 */
export function refusalFields(e: SchemaNewerThanRuntimeError, partial = false, completed = false): Record<string, unknown> {
  return {
    bookGeneration: e.bookGeneration,
    buildGeneration: e.buildGeneration,
    path: e.path,
    partial,
    completed,
    message: partial ? (completed ? newerGenerationSavedMessage(e) : newerGenerationPartialMessage(e)) : e.message,
  };
}

/**
 * THE ONE COMPARISON. The refusal detail when `bookGeneration` is newer than this build, else null.
 * Equal is fine (the current generation), and older is fine too: it migrates forward on open.
 */
export function newerGenerationRefusal(bookGeneration: number, path: string): NewerGenerationDetail | null {
  return bookGeneration > SCHEMA_GENERATION ? { bookGeneration, buildGeneration: SCHEMA_GENERATION, path } : null;
}

/** The throwing form of the comparison, for an open that must not continue. */
export function assertGenerationNotNewer(bookGeneration: number, path: string): void {
  const refusal = newerGenerationRefusal(bookGeneration, path);
  if (refusal !== null) throw new SchemaNewerThanRuntimeError(refusal);
}

/**
 * The generation marker of an open connection: `PRAGMA user_version`, 0 on a file written before the
 * marker existed (and on a brand-new, empty file). A read, never a write.
 */
export function bookGenerationOf(db: Database.Database): number {
  const value = db.pragma('user_version', { simple: true });
  return typeof value === 'number' ? value : 0;
}
