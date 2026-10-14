/**
 * THE SCHEMA SHAPE of a book or a backup: every table and the names of its columns (spec G04 §0c
 * item 6, owner decision 30.09.2026).
 *
 * `PRAGMA user_version` (the GENERATION, `./generation.ts`) moves only when a change alters what a
 * stored value MEANS. A new table or an `ADDITIVE_COLUMNS` column changes the SHAPE and leaves the
 * generation where it was, on purpose: an older book opens under a newer TILL and simply gains the
 * column. The cost showed up in G04 (critic A31 R2-M1): a backup a newer TILL wrote passed an older
 * TILL's `verify_backup` (same generation), then died inside the restore with a raw
 * `SQLITE_ERROR table capture_fields has no column named qr_payload_id`; and an older TILL could not
 * back up a book a newer one had opened (`create_backup` threw the same error), because it built the
 * snapshot from its OWN `SCHEMA_SQL`.
 *
 * So the shape is now a fact a backup carries and a verify compares:
 *
 *  - `schemaShapeOf(db)` reads it from a live connection (sqlite_master + `PRAGMA table_info`), so it
 *    describes the file as it IS, whoever built it, and works on a backup made before this existed;
 *  - `schemaFingerprint` is its sha256, the short name a manifest and a listing show;
 *  - `shapeGap(have, need)` names what a target lacks for a source: every table and `table.column`
 *    `need` holds that `have` does not. An EMPTY gap means every value of the source has a place to
 *    land. Extra columns on the target are fine (a backup made before an additive column restores,
 *    the column taking its default); only a MISSING place is a refusal;
 *  - `copySchemaDdl(src, dest)` rebuilds a database's own DDL in another, so a snapshot carries the
 *    shape of the BOOK it copies rather than the shape this runtime's code would create;
 *  - `isTillTable(name)` / `tillTables(db)` are the ONE chokepoint for which tables are TILL's: every
 *    function here, and every enumeration the G04 portability engine makes, goes through them, so a
 *    tool's table inside the file (Litestream's `_litestream_*`) is never part of a shape, a snapshot
 *    or a restore.
 *
 * This module opens no connection (the `Database` import is type-only): every function takes one.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/** Table name to its column names, both sorted: the canonical, comparable form. */
export type SchemaShape = Readonly<Record<string, readonly string[]>>;

/** What a target is missing to hold a source: whole tables, and `table.column` for the rest. */
export interface ShapeGap {
  readonly tables: readonly string[];
  readonly columns: readonly string[];
}

/**
 * THE ONE PREDICATE for "is this table TILL's?" (owner's Mac, 13.10.2026). A SQLite file can hold
 * tables TILL never created, and a backup, an export, a verify or a restore that enumerates them
 * treats another program's bookkeeping as part of the book:
 *
 *  - SQLite's own `sqlite_*` objects (`sqlite_sequence`, ANALYZE's `sqlite_stat1`..`4`). The prefix is
 *    reserved by SQLite, matched case-insensitively as SQLite itself does.
 *  - External tools' tables, which by convention start with an underscore. Litestream, replicating
 *    the owner's real book, keeps `_litestream_seq` and `_litestream_lock` inside the file; a backup
 *    of that book named them in its shape, and every book WITHOUT Litestream refused to restore it
 *    (`schema_shape_newer`, unknownTables `["_litestream_lock","_litestream_seq"]`).
 *
 * WHY THE GENERAL LEADING-UNDERSCORE RULE and not `_litestream_` alone: no TILL table starts with an
 * underscore (asserted against the real schema by `test/data/backup-tool-tables.test.mjs`, so a TILL
 * table named `_something` reds that test instead of silently vanishing from every snapshot), and the
 * next replication or sync tool that leaves `_its_state` in the file is covered without another list
 * entry. Enumeration fails; this is the chokepoint.
 */
export function isTillTable(name: string): boolean {
  return !/^sqlite_/i.test(name) && !name.startsWith('_');
}

/** Every table of a connection but SQLite's own, TILL's and foreign, sorted by name. */
function fileTables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name)
    .filter((name) => !/^sqlite_/i.test(name));
}

/**
 * The tables of a connection that are TILL's (`isTillTable`), sorted by name. Every enumeration a
 * backup, an export, a verify or a restore makes goes through this, never through a `sqlite_master`
 * query of its own.
 */
export function tillTables(db: Database.Database): string[] {
  return fileTables(db).filter(isTillTable);
}

/**
 * The shape of the database behind `db`, read from the file itself: TILL's tables only. With
 * `includeForeignTables` it describes the whole FILE, a tool's tables included: the shape a backup
 * taken before `isTillTable` existed computed its fingerprint over (see `fingerprintMatches`).
 */
export function schemaShapeOf(db: Database.Database, opts: { includeForeignTables?: boolean } = {}): SchemaShape {
  const shape: Record<string, readonly string[]> = {};
  for (const table of opts.includeForeignTables === true ? fileTables(db) : tillTables(db)) {
    shape[table] = (db.pragma(`table_info("${table}")`) as { name: string }[]).map((c) => c.name).sort();
  }
  return shape;
}

/** The sha256 of a shape's canonical JSON (tables and columns sorted). */
export function schemaFingerprint(shape: SchemaShape): string {
  const canonical = Object.keys(shape)
    .sort()
    .map((t) => [t, [...(shape[t] ?? [])].sort()]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Does a manifest's recorded fingerprint describe the snapshot file behind `snap`? A backup written
 * since `isTillTable` records the fingerprint of TILL's shape; one written BEFORE it from a book a tool
 * such as Litestream shared recorded the fingerprint of the whole file, the tool's tables included.
 * Both honestly describe the same file, so both are accepted: refusing the second would turn every
 * backup the owner already took into `backup_corrupt`. Any other value is still a mismatch.
 */
export function fingerprintMatches(recorded: string, snap: Database.Database): boolean {
  if (recorded === schemaFingerprint(schemaShapeOf(snap))) return true;
  return recorded === schemaFingerprint(schemaShapeOf(snap, { includeForeignTables: true }));
}

/**
 * Every table and column `need` holds that `have` lacks (empty when `have` can hold all of `need`).
 * Only TILL's tables can be needed: a shape recorded before `isTillTable` (a legacy manifest a listing
 * reads) may still name a tool's table, and that is never a gap.
 */
export function shapeGap(have: SchemaShape, need: SchemaShape): ShapeGap {
  const tables: string[] = [];
  const columns: string[] = [];
  for (const table of Object.keys(need).filter(isTillTable).sort()) {
    const present = have[table];
    if (present === undefined) {
      tables.push(table);
      continue;
    }
    const known = new Set(present);
    for (const column of need[table] ?? []) if (!known.has(column)) columns.push(`${table}.${column}`);
  }
  return { tables, columns };
}

/** True when a gap names nothing. */
export function isEmptyGap(gap: ShapeGap): boolean {
  return gap.tables.length === 0 && gap.columns.length === 0;
}

/**
 * Rebuild `src`'s own DDL in `dest` (an empty database): its tables, then its indexes, then its
 * triggers and views, each from the statement SQLite recorded in `sqlite_master` (which already
 * carries every `ALTER TABLE ... ADD COLUMN` the file went through). Automatic indexes (no SQL) come
 * back by themselves with their UNIQUE constraint. Only TILL's objects travel: one whose own name or
 * owning table (`tbl_name`) is not a TILL table (`isTillTable`: SQLite's `sqlite_*`, a tool's
 * `_litestream_*`) is skipped, with every index and trigger hanging off such a table.
 */
export function copySchemaDdl(src: Database.Database, dest: Database.Database): void {
  const objects = src
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE sql IS NOT NULL
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, rowid`,
    )
    .all() as { type: string; name: string; tbl_name: string; sql: string }[];
  for (const o of objects) {
    if (!isTillTable(o.name) || !isTillTable(o.tbl_name)) continue;
    dest.exec(o.sql);
  }
}
