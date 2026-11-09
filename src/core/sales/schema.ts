/**
 * D00's tables, kept in the sales module (the pattern A14/A24/G00 established: a capability's DDL
 * sits beside the code that writes it, and concurrent branches do not all edit one long string in
 * `store/schema.ts`). The store concatenates this onto `SCHEMA_SQL`.
 *
 * D00 EXTENDS A09's `item` table with additive columns (`item_sku` .. `archived_at` are added through
 * `ADDITIVE_COLUMNS` in `store/schema.ts`, not here, because `item` is created in the core schema and
 * `CREATE TABLE IF NOT EXISTS` never widens an existing table). The three tables below are wholly new,
 * so `CREATE TABLE IF NOT EXISTS` both creates them on a fresh database and adds them to an existing
 * one at the next open, with no data migration (there is no stored number whose meaning changes).
 *
 * NO CHECK CONSTRAINT on `kind`, `unit` or `scope`, matching the §D0 convention: the enum lives at the
 * single §H-ENUM source (`itemEnums.ts`), validated at the verb boundary, so adding a unit is one edit
 * in one file with no migration. A CHECK here would be a second enumeration point, which §6b forbids.
 *
 * `price_list_item` is APPEND-ONLY price history keyed by `valid_from`: a new price for a
 * (price_list, item) is a new row, never an update of a past one, so `price_resolve` reads a stored
 * integer at any historical `at` (spec §4, P2/P5). Every table stamps `workspace_id` (§H-TENANT).
 */

export const SALES_SCHEMA_SQL = `
-- D00 US-D00.3: the two-level category tree. parent_id NULL = a root; a child's parent must itself be
-- a root (the two-level fence is enforced in the engine, not by a CHECK). Deleting a category still
-- referenced by an item is refused (category_in_use), so no ON DELETE CASCADE anywhere here.
CREATE TABLE IF NOT EXISTS item_category (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  name         TEXT NOT NULL,
  parent_id    TEXT REFERENCES item_category(id),
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

-- D00 US-D00.4: a price list, scoped to exactly one contact OR one segment (the XOR is checked by
-- the engine, not a CHECK: SQLite cannot express "exactly one of two columns is non-null" without a
-- CHECK that would become a second enumeration point for the scope). contact_id references C00's
-- contact; segment is a free string that C00 will constrain when its segment attribute lands.
CREATE TABLE IF NOT EXISTS price_list (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  name         TEXT NOT NULL,
  contact_id   TEXT REFERENCES contact(id),
  segment      TEXT,
  created_at   TEXT NOT NULL
);

-- D00 US-D00.4: append-only price history. One row per (price_list, item, valid_from). A later price
-- is a new row; a past row is never updated, so price_resolve at any as-of date selects the latest row with
-- valid_from <= at and reads a stored integer (no arithmetic, P2). price_minor is integer Rappen.
CREATE TABLE IF NOT EXISTS price_list_item (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  price_list_id TEXT NOT NULL REFERENCES price_list(id),
  item_id       TEXT NOT NULL REFERENCES item(id),
  price_minor   INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'CHF',
  valid_from    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- price_resolve reads the newest effective row per (price_list, item); this index makes that a b-tree
-- seek rather than a scan of the history. workspace_id first, matching the house §H-TENANT convention.
CREATE INDEX IF NOT EXISTS price_list_item_resolution
ON price_list_item (workspace_id, price_list_id, item_id, valid_from);
`;
