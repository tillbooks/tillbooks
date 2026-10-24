/**
 * A02 §4b, the Belegnummer (D178 point 2): its two tables and its guards, kept beside the code that writes
 * them (`./entryNumber.ts`) and concatenated onto `SCHEMA_SQL` at the store, the pattern A14/A19/A40/D172
 * established.
 *
 * WHY A SIDE TABLE. A posted `journal_entry` row is sealed by `journal_entry_no_update_posted`
 * (`store/schema.ts`): nothing may update it, including a column added for a number. So the number lives in
 * `journal_entry_number`, one row per numbered entry, and that row is sealed the same way: no UPDATE, no
 * DELETE (GeBüV Art. 3: a change must not be possible without being detectable). The counter is NOT a new
 * table: it is A10's gap-free `document_number_seq` (D32, OR 957 ff.) with `type = 'journal'` and `year` =
 * the series key, guarded here so a `journal` counter never moves backwards and is never deleted. Sales rows
 * in the same table are untouched: every guard below is fenced to `type = 'journal'`.
 *
 * Every guard is a `RAISE(ABORT, ...)` body, the shape the landscape copy (`landscape/copy.ts`) and the
 * sandbox delete (`migration/testmandant.ts`) suspend by pattern, so neither needs a list edited.
 */

/** A second reader is allowed only when both rows are adopted pieces of the SAME old voucher. */
const NOT_THE_SAME_VOUCHER =
  "NOT (NEW.origin = 'adopted' AND o.origin = 'adopted' AND NEW.voucher_ref IS NOT NULL AND o.voucher_ref = NEW.voucher_ref)";

/**
 * The backstop trigger's two probes, exported so `test/ledger/entry-number-scale.test.mjs` pins the query
 * plan of exactly these texts (each must be a covering-index seek, never a workspace scan). Each names its
 * index with INDEXED BY: inside the trigger, where the NEW.* values are not bound parameters, SQLite chose a
 * plan that still walked the workspace's rows (measured: superlinear without it, linear with it).
 */
export const NUMBER_READER_PROBE = `SELECT 1 FROM journal_entry_number o INDEXED BY journal_entry_number_series_probe WHERE o.workspace_id = NEW.workspace_id AND o.series = NEW.series AND o.number = NEW.number AND ${NOT_THE_SAME_VOUCHER}`;
export const DISPLAY_READER_PROBE = `SELECT 1 FROM journal_entry_number o INDEXED BY journal_entry_number_display_probe WHERE o.workspace_id = NEW.workspace_id AND o.display = NEW.display AND ${NOT_THE_SAME_VOUCHER}`;

export const ENTRY_NUMBER_SCHEMA_SQL = `
-- One Belegnummer per posted entry. series is 'all' for the continuous run (continue_migrated, from_start) or
-- the fiscal-year label ('2026') under per_fiscal_year. display is the string a person reads, fixed at
-- assignment (the prefix and the form in force then). origin says whether the number was ADOPTED from a
-- migrated entry's ref (the old voucher's number), or ASSIGNED by TILL from the counter. voucher_ref names
-- the old voucher an adopted number belongs to when several entries may share it (one bexio voucher migrated
-- as several entries: its whole ref); it is NULL on an assigned number and on a plain-integer adoption.
CREATE TABLE IF NOT EXISTS journal_entry_number (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  entry_id     TEXT NOT NULL UNIQUE REFERENCES journal_entry(id),
  series       TEXT NOT NULL,
  number       INTEGER NOT NULL CHECK (number >= 1),
  display      TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('assigned', 'adopted')),
  voucher_ref  TEXT CHECK (voucher_ref IS NULL OR origin = 'adopted'),
  assigned_at  TEXT NOT NULL
);

-- An ASSIGNED number and its display name ONE entry (critic r1 L1). The one-reader trigger in
-- ENTRY_NUMBER_ADDITIVE_DDL enforces that for every row (an assigned row may meet no other reader at all),
-- so no separate partial unique index is kept: each index is a B-tree every insert maintains, and the
-- backfill of a large book pays for each one (critic r2 M2-2).
-- The voucher_ref probe indexes and the one-reader backstop trigger live in ENTRY_NUMBER_ADDITIVE_DDL
-- (below), run after the additive columns, so a table that predates voucher_ref gets the column first.

-- Append-only, like the entry it numbers.
CREATE TRIGGER IF NOT EXISTS journal_entry_number_no_update
BEFORE UPDATE ON journal_entry_number
BEGIN
  SELECT RAISE(ABORT, 'entry_number_immutable');
END;

CREATE TRIGGER IF NOT EXISTS journal_entry_number_no_delete
BEFORE DELETE ON journal_entry_number
BEGIN
  SELECT RAISE(ABORT, 'entry_number_immutable');
END;

-- A draft gets no number, and a number never names another workspace's entry (§H-TENANT at the storage
-- layer). Both subqueries are NULL when the entry row is not there yet, which is exactly a G04 restore
-- loading this table before journal_entry (deferred foreign keys hold the reference at COMMIT).
CREATE TRIGGER IF NOT EXISTS journal_entry_number_posted_only
BEFORE INSERT ON journal_entry_number
WHEN COALESCE((SELECT status <> 'posted' OR workspace_id <> NEW.workspace_id FROM journal_entry WHERE id = NEW.entry_id), 0)
BEGIN
  SELECT RAISE(ABORT, 'entry_number_not_posted');
END;

-- The journal counter only ever moves forward and is never removed: a number handed out is never handed
-- out again. Fenced to type 'journal', so A10's own rows behave exactly as before.
CREATE TRIGGER IF NOT EXISTS journal_number_seq_forward
BEFORE UPDATE ON document_number_seq
WHEN OLD.type = 'journal'
  AND (NEW.next_value < OLD.next_value OR NEW.type <> OLD.type OR NEW.year <> OLD.year
       OR NEW.workspace_id <> OLD.workspace_id)
BEGIN
  SELECT RAISE(ABORT, 'entry_number_counter_backwards');
END;

CREATE TRIGGER IF NOT EXISTS journal_number_seq_no_delete
BEFORE DELETE ON document_number_seq
WHEN OLD.type = 'journal'
BEGIN
  SELECT RAISE(ABORT, 'entry_number_counter_backwards');
END;

-- The catch-up marker: a posting made while ledger.belegnummer_mode = off writes it (once), and the next
-- numbered posting numbers every posted entry still without a number and clears it. One primary-key read
-- per post instead of a scan of the ledger (journal_entry carries no workspace index).
CREATE TABLE IF NOT EXISTS journal_numbering_pending (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
  since        TEXT NOT NULL
);

-- The old voucher numbers WITHHELD in a series (critic r3 L3-2): a free number some migrated entry claimed
-- but could not adopt (two different vouchers claimed it, a plain integer twice, or another voucher reads
-- its display). Rule b never hands such a number to a later claimant,
-- so a conflict is not settled by whoever is imported next. One primary-key read per claim, never a scan of
-- the refs. A new table, so every book gains it on open; books numbered by a pre-release build before it
-- existed hold no rows for their earlier conflicts (dry-run copies, taken again).
CREATE TABLE IF NOT EXISTS journal_number_withheld (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  series       TEXT NOT NULL,
  number       INTEGER NOT NULL CHECK (number >= 1),
  withheld_at  TEXT NOT NULL,
  PRIMARY KEY (workspace_id, series, number)
);

-- Append-only, like the numbers themselves (critic r3 confirmation): releasing a withheld number would
-- re-open a "no guessing" decision without a trace, so nothing may update or delete a row. The engine only
-- ever INSERTs here (INSERT OR IGNORE, inside the posting or catch-up transaction). The landscape copy and the
-- Testmandant delete suspend these guards by their RAISE(ABORT) pattern, like every other numbering guard.
CREATE TRIGGER IF NOT EXISTS journal_number_withheld_no_update
BEFORE UPDATE ON journal_number_withheld
BEGIN
  SELECT RAISE(ABORT, 'entry_number_immutable');
END;

CREATE TRIGGER IF NOT EXISTS journal_number_withheld_no_delete
BEFORE DELETE ON journal_number_withheld
BEGIN
  SELECT RAISE(ABORT, 'entry_number_immutable');
END;
`;

/**
 * The column a book opened by a pre-release round-1 build lacks (critic r2 L2-1): `ENTRY_NUMBER_SCHEMA_SQL` is
 * `CREATE TABLE IF NOT EXISTS`, so a table that already exists keeps its shape. `store/schema.ts` lists these
 * in `ADDITIVE_COLUMNS`, which adds a missing column idempotently on every open, before the additive DDL
 * below that names it (the probe indexes and the one-reader trigger). The rule this holds: a change to the
 * number table's shape ships as an additive column, never only in the CREATE, because books at generation 17
 * already exist (`test/critic/e1r2-round1-shape.test.mjs` opens one).
 *
 * What the column cannot fix, stated: a round-1 table also carries a table-level UNIQUE (workspace_id,
 * series, number), which SQLite cannot drop without rebuilding the table. On such a book every posting and
 * the catch-up work, but a split bexio voucher cannot SHARE its number (`share`, §4b.3): that one insert fails
 * loudly with a constraint error and its transaction rolls back, nothing is written half. Only pre-release
 * dry-run copies opened by a round-1 build of this branch have that shape; they are to be discarded and the
 * copy taken again, never upgraded in place.
 */
export const ENTRY_NUMBER_ADDITIVE_COLUMNS: readonly { table: string; column: string; ddl: string }[] = [
  { table: 'journal_entry_number', column: 'voucher_ref', ddl: "voucher_ref TEXT CHECK (voucher_ref IS NULL OR origin = 'adopted')" },
];

/**
 * The DDL that names `voucher_ref`, run AFTER the additive columns (`store/schema.ts` lists it in
 * `ADDITIVE_INDEXES`), so a table that predates the column gets the column first and the indexes and the
 * trigger over it second. Idempotent: every statement is IF [NOT] EXISTS.
 */
export const ENTRY_NUMBER_ADDITIVE_DDL: readonly { name: string; ddl: string }[] = [
  {
    // The lookups, and the two probes of the backstop trigger below: a series' numbers, and the Beleg-Nr.
    // filter by what a person typed. Both carry origin and voucher_ref, so each probe is answered from the
    // index alone (a COVERING index seek, O(log n) per insert; pinned by entry-number-scale.test.mjs).
    name: 'journal_entry_number_series_probe',
    ddl: `CREATE INDEX IF NOT EXISTS journal_entry_number_series_probe
          ON journal_entry_number (workspace_id, series, number, origin, voucher_ref)`,
  },
  {
    name: 'journal_entry_number_display_probe',
    ddl: `CREATE INDEX IF NOT EXISTS journal_entry_number_display_probe
          ON journal_entry_number (workspace_id, display, origin, voucher_ref)`,
  },
  {
    // The round-2 single-probe trigger (critic r2 M2-2: its "(series AND number) OR display" condition was
    // planned as a scan of every number row of the workspace, so a posting cost O(n) and the backfill, a
    // catch-up and a restore cost O(n^2); 20'000 entries took 276 s). Retired by name; a no-op on every book
    // that never had it.
    name: 'journal_entry_number_shared_only_by_one_voucher (retired)',
    ddl: 'DROP TRIGGER IF EXISTS journal_entry_number_shared_only_by_one_voucher',
  },
  {
    // The round-1 display index and the round-2 lookup and partial unique indexes, superseded by the two
    // probe indexes above and by the one-reader trigger. Dropped so a book a pre-release build opened
    // converges on the indexes a fresh book has, and no insert keeps paying for B-trees nothing reads.
    // No-ops elsewhere.
    name: 'journal_entry_number pre-release indexes (retired)',
    ddl: `DROP INDEX IF EXISTS journal_entry_number_display;
          DROP INDEX IF EXISTS journal_entry_number_by_series;
          DROP INDEX IF EXISTS journal_entry_number_by_display;
          DROP INDEX IF EXISTS journal_entry_number_assigned_unique;
          DROP INDEX IF EXISTS journal_entry_number_assigned_display_unique`,
  },
  {
    // A number, and a display, may be read by several entries ONLY when they are adopted pieces of the same
    // old voucher (owner, 21.10.2026: one bexio voucher migrated as several entries shares its number).
    // Anything else is taken: an assigned number never meets another row, and two different vouchers never
    // share one. The planner never writes such a row; this is the storage backstop, failing a posting
    // loudly. TWO probes, never one OR: each is one covering-index seek.
    name: 'journal_entry_number_one_reader',
    ddl: `CREATE TRIGGER IF NOT EXISTS journal_entry_number_one_reader
          BEFORE INSERT ON journal_entry_number
          WHEN EXISTS (${NUMBER_READER_PROBE}) OR EXISTS (${DISPLAY_READER_PROBE})
          BEGIN
            SELECT RAISE(ABORT, 'entry_number_taken');
          END`,
  },
];
