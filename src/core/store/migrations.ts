/**
 * Data migrations (M-3): the half of the migration mechanism that touches ROWS rather than columns.
 *
 * `ADDITIVE_COLUMNS` in `./schema.ts` widens a table's shape and is applied by `SqliteStore` on
 * open. It is enough for every change this schema had seen until now, because every one of them was
 * a new nullable column. It is not enough for a change that alters what an EXISTING stored number
 * MEANS, and the §H-FX rate-scale widening is exactly that: `exchange_rate.rate_scaled = 94120000`
 * meant a rate of 0.9412 at the old 1e8 scale and means 0.00009412 at the new 1e12 one.
 *
 * Leaving that to "no real ledgers exist yet" is not a plan, it is a bet on nobody having opened the
 * app. So the file carries a GENERATION in `PRAGMA user_version`, every database written before this
 * carries 0 because nothing ever set it, and each migration above the file's generation runs once.
 *
 * ## The two rules these migrations are written to
 *
 * **Idempotent, so a retry is free.** The whole run happens inside one transaction together with the
 * version bump, so a crash halfway leaves the OLD generation and the OLD rows and the next open
 * starts over. There is no state in which some rows are converted and the version says they all are.
 *
 * **Derive, never transform.** The rate migration recomputes `rate_scaled` from `rate` rather than
 * multiplying it by 10^4. `rate` is the canonical decimal STRING, the value the audit trail and
 * `journal_line.fx_rate` carry, and the authoritative one; `rate_scaled` is its cache for the money
 * math. Recomputing restores the invariant "the two agree at the current scale" without the code
 * needing to know which scale the row was written at, and running it twice is a no-op. A migration
 * that multiplied would be correct exactly once and silently wrong on every replay.
 *
 * A RENAME needs both halves at once, and generation 2 is the first: `ADDITIVE_COLUMNS` adds the new
 * column, this file carries the value over and retires the old column. The retirement is a DDL step
 * living in a data migration on purpose, because it is only correct AFTER the copy and the two have
 * to commit together.
 *
 * Posted ledger rows need no migration at all, and that is by design rather than by luck:
 * `journal_line.fx_rate` is the decimal string and `base_debit_minor`/`base_credit_minor` are Rappen.
 * Neither is expressed at the rate scale, so history says the same thing before and after.
 */

import type { Database } from 'better-sqlite3';

import { parseRate } from '../fx/rateMath.js';
import { NOT_AUTOMATABLE } from '../automation/denylist.js';
import { appendAuditLog } from '../ledger/auditLog.js';
import { topUpChartOfAccounts } from '../accounts/topUp.js';
import { systemIdGen } from '../ids.js';
import { DEFAULT_TAX_CODES } from '../vat/enums.js';
import { SETTINGS_SCHEMA_SQL } from '../settings/schema.js';
import { ENTRY_NUMBER_SCHEMA_SQL } from '../ledger/entryNumberSchema.js';
import { numberUnnumberedEntries, numberingConfigOf } from '../ledger/entryNumber.js';
import {
  batchHadFile,
  compactReference,
  isBlankName,
  isCompactMsgId,
  mintFrozenReference,
  referenceTakenIn,
} from '../banking/pain001Refs.js';
import type { SqliteStore } from './sqlite-store.js';

export interface DataMigration {
  /** The generation this migration LIFTS the file to. Applied when `user_version` is below it. */
  generation: number;
  name: string;
  apply: (db: Database) => void;
}

/**
 * Generation 1: make `exchange_rate.rate_scaled` agree with `exchange_rate.rate` at the current
 * `RATE_SCALE`.
 *
 * Written for the 1e8 to 1e12 widening (2026-07-25), but stated as the invariant rather than as that
 * one conversion, so it stays true if the scale ever moves again.
 */
function rescaleExchangeRates(db: Database): void {
  const rows = db.prepare('SELECT id, rate, rate_scaled FROM exchange_rate').all() as {
    id: string;
    rate: string;
    rate_scaled: number;
  }[];
  const update = db.prepare('UPDATE exchange_rate SET rate_scaled = ? WHERE id = ?');

  for (const row of rows) {
    const scaled = parseRate(row.rate);
    if (scaled === null) {
      // The canonical string is the authoritative value. If it cannot be parsed, this row's rate is
      // not knowable, and the alternative to failing loudly is opening the ledger and letting the
      // stale integer price the next posting. A refusal an operator can see beats wrong money.
      throw new Error(
        `exchange_rate ${row.id} holds a rate the engine cannot parse (${JSON.stringify(row.rate)}), ` +
          'so rate_scaled cannot be rebuilt from it: this database needs manual repair',
      );
    }
    if (BigInt(row.rate_scaled) !== scaled) update.run(scaled, row.id);
  }
}

/** Does `table` currently have a column called `column`? The self-detection every step here rests on. */
function hasColumn(db: Database, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);
}

/**
 * Generation 2: carry the creditor IBAN from `workspace.qr_iban` to `workspace.creditor_iban`.
 *
 * The column was named when it could hold only a QR-IBAN, because `setCreditorProfile` refused
 * anything else. M-2 lifted that: it takes any valid IBAN and `buildQrBill` derives the reference
 * type (QRR from a QR-IBAN, SCOR from a plain one). The name then said something false about the
 * contents, next to the honest `creditor_name` and `creditor_address`.
 *
 * ## Why this is not one `ALTER TABLE ... RENAME COLUMN`
 *
 * That statement is correct exactly once. Replay it and it throws `no such column`, and the store
 * re-runs every migration above the file's generation, which is precisely what a crash mid-run
 * leaves behind. The idempotent form of a rename in SQLite is three self-detecting steps:
 *
 *  1. ADD the new column. Done by `ADDITIVE_COLUMNS` in ./schema.ts before this runs, guarded by
 *     `PRAGMA table_info`, so a file that already has it is untouched.
 *  2. DERIVE the new value from the old column, and only where the new one is still unset. That is
 *     the file's standing rule: a second run reads its own output and changes nothing. It also means
 *     the migration can never overwrite an IBAN a later write already put there.
 *  3. DROP the old column, guarded by the same `PRAGMA table_info`.
 *
 * All three commit with the version bump in ONE transaction, so a crash anywhere leaves the old
 * generation, the old column and the old value, and the next open starts over.
 *
 * ## Why the old column is dropped rather than left as a tombstone
 *
 * Because it holds an IBAN. A row carrying two creditor IBANs is right only until the operator edits
 * one of them, and from then on the file says the money should go to two different bank accounts and
 * gives no way to tell which reading is current. That is a worse failure than the one the rename
 * fixes. The cost is that an OLDER engine build can no longer read the file (it would ask for
 * `qr_iban`); downgrading across a schema generation was never a supported move, and a loud
 * `no such column` on an old binary beats a silently stale payment instruction.
 */
function renameQrIbanToCreditorIban(db: Database): void {
  if (!hasColumn(db, 'workspace', 'qr_iban')) return;
  // `creditor_iban IS NULL` is what makes the copy a derivation rather than a transform: it reads
  // the destination first, so replaying it is a no-op instead of a fresh overwrite.
  db.exec('UPDATE workspace SET creditor_iban = qr_iban WHERE creditor_iban IS NULL');
  db.exec('ALTER TABLE workspace DROP COLUMN qr_iban');
}

/**
 * Generation 3: denominate stored DRAFT lines in their workspace's base currency.
 *
 * `saveDraft` wrote the literal `'CHF'` into `journal_line.currency` regardless of what the book was
 * kept in. Every draft line written in a non-CHF workspace before that fix therefore carries a
 * currency the money was never in, and unlike the rate-scale case the wrong value is not merely
 * internal: `list_journal` reports `currency` straight off the rows, so the Studio and any agent read
 * a franc label on money nobody entered in francs.
 *
 * ## Why a stored row has to be corrected rather than left to be re-saved
 *
 * Because the stale row does not just carry a wrong label, it triggers a DISCLOSURE that describes a
 * conversion nobody made. A02's `statesConversionBasis` asks about the currency and nothing else, so
 * a `CHF` row in a EUR book reads as FOREIGN, and the read model adds `baseCurrency` to the entry
 * while both figures stay null (the figures are fenced to `status = 'posted'`). The operator is shown
 * a foreign-currency draft, in the wrong currency, annotated with a base-currency disclosure for a
 * conversion that never happened, and it stays that way until somebody happens to re-save that draft.
 *
 * ## Derive, never transform
 *
 * The new value is not computed from the old one: it is READ from `workspace.base_currency`, the
 * authoritative statement of what the book is kept in. That is sound because the base currency is the
 * only thing a draft line can honestly be. Exactly two statements insert into `journal_line`:
 * `saveDraft`, whose input type has no currency at any level (`SaveDraftInput`, `LineInput`, and the
 * `save_draft` tool schema all lack one), and `writePostedEntry`, which flips the entry to `posted`
 * inside the same transaction. So no committed DRAFT line was ever written by anything but
 * `saveDraft`, and none of them could have meant anything but the base currency.
 *
 * The `currency <> base` guard makes the statement read its own output, so a second run matches no
 * rows. Being honest about its weight: this migration would be idempotent WITHOUT it too, because it
 * assigns a value derived from elsewhere rather than one computed from the column, so a replay would
 * write the same string back. The guard buys no correctness, only the absence of a pointless rewrite
 * of every draft line on every open, and no test here can tell the two apart. It is kept because
 * "read the destination first" is this file's standing rule and the next migration to be written
 * against this one as a model may well need it for real.
 *
 * ## The fence, and the independent one underneath it
 *
 * The update is fenced to `status = 'draft'`. Posted rows are append-only (§H-AUDIT) and, more to the
 * point, a posted line in a EUR book may LEGITIMATELY read `CHF`: that is an ordinary
 * foreign-currency posting, stamped with the rate that priced it. Rewriting those would destroy real
 * §H-FX history, which is the one thing worse than the label this migration fixes.
 *
 * The fence is not the only thing standing between this statement and posted money. The
 * `journal_line_no_update_posted` trigger aborts any update to a line whose entry is posted, at the
 * DB layer, independently of anything this file gets right. Belt and braces on the money path is the
 * house rule, and here the braces were installed long before the belt.
 */
function denominateDraftsInBaseCurrency(db: Database): void {
  // The workspace's base currency, reached from the line through its entry. Interpolated rather than
  // bound because it appears twice and PRAGMA-free SQL text is the only input here: there is no
  // caller-supplied value anywhere in this statement.
  const base = `(SELECT w.base_currency
                   FROM journal_entry e
                   JOIN workspace w ON w.id = e.workspace_id
                  WHERE e.id = journal_line.entry_id)`;
  db.exec(`
    UPDATE journal_line
       SET currency = ${base}
     WHERE entry_id IN (SELECT id FROM journal_entry WHERE status = 'draft')
       AND currency <> ${base}
  `);
}

/**
 * Generation 4: retire the `DEFAULT 'CHF'` on `journal_line.currency`.
 *
 * The default was load-bearing exactly once, when nothing supplied the column. Both statements that
 * insert a journal line now state the currency: `postEntry` takes it from `applyFx`, and `saveDraft`
 * from `baseCurrencyOf(ctx)` (that second one only since generation 3, where the hardcoded literal
 * made every draft in a EUR book claim francs). What the default can still do is absorb the NEXT
 * omission: a third insert path that forgets the column books a plausible franc line instead of
 * failing. On the money path a loud `NOT NULL` violation is worth far more than a wrong currency.
 *
 * ## Why this is a table rebuild, and what that costs
 *
 * SQLite has `ALTER TABLE ... ADD COLUMN`, `DROP COLUMN` and `RENAME`, and no `ALTER COLUMN`. A
 * column default can only be removed by building a new table, copying the rows, dropping the old one
 * and renaming, which is the procedure SQLite's own ALTER TABLE documentation prescribes.
 *
 * That is a genuinely dangerous operation HERE, and not because of the data. `journal_line` carries
 * the three triggers that make posted rows immutable at the DB layer (§H-AUDIT, risk R3), and a
 * rebuild that quietly failed to bring one back would leave a ledger that looks perfect and has
 * stopped refusing to be edited. That would be a far worse defect than the one this fixes. Four
 * things are done about it, in order of how much they carry:
 *
 *  1. **Nothing is hand-copied.** The new table's DDL is DERIVED from the file's own stored
 *     `sqlite_master` definition with one edit applied to it, and the triggers and indexes are
 *     replayed from the DDL captured off the same table moments earlier. A second hand-written copy
 *     of a trigger in this file is a copy that drifts from ./schema.ts and is never noticed; there
 *     is none. It also means a trigger or index a LATER spec adds to `journal_line` is carried
 *     across by this code without anybody remembering to update it.
 *  2. **The migration verifies its own output** before returning, and throws if the row count, the
 *     rowids, the trigger set or the foreign keys came out wrong. It runs inside the store's single
 *     migration transaction, so a throw rolls the whole rebuild back and leaves the OLD generation
 *     and the OLD table. The failure mode is a database that refuses to open, never one that opens
 *     with its immutability quietly removed.
 *  3. **The triggers are created LAST, after the copy.** They cannot be created on the new table
 *     first: `journal_line_no_insert_posted` would abort the copy of every posted line, which is the
 *     trigger correctly doing its job at the worst possible moment.
 *  4. **`CREATE TRIGGER IF NOT EXISTS` in SCHEMA_SQL runs on every open**, so even a trigger lost
 *     past all of the above comes back on the next open. Belt, braces, and a second pair of braces,
 *     which is the right ratio for the one guarantee the ledger cannot lose.
 *
 * ## Idempotent, like everything else here
 *
 * The first thing it does is read `PRAGMA table_info` and return if the default is already gone. A
 * replay after a crash, or a fresh database that was created from the current schema and never had
 * the default at all, does no work whatsoever. That is this file's "read the destination first" rule
 * applied to a SHAPE instead of a value.
 *
 * ## What deliberately does not change
 *
 * The rowids. `reads.ts` orders lines `BY rowid` and reads the FIRST row's currency and rate as the
 * entry's, so a rebuild that renumbered them could reorder an entry's lines and, on a mixed entry,
 * change what the journal says it is denominated in. The copy carries `rowid` across explicitly and
 * the verification asserts it, rather than relying on a copy in scan order happening to preserve it.
 *
 * And the other `DEFAULT 'CHF'` columns. `workspace.base_currency` is a real default: a Swiss
 * accounting app starting a new book in francs is a convenience with no wrong answer hidden behind
 * it, and `contact.default_currency` says in its own name what it is. Only a journal LINE's currency
 * is a per-row fact about money that actually moved, where there is no value that is right when the
 * writer failed to say one.
 */
function dropJournalLineCurrencyDefault(db: Database): void {
  const currency = (
    db.pragma('table_info(journal_line)') as { name: string; dflt_value: string | null }[]
  ).find((c) => c.name === 'currency');
  // Already the new shape (a fresh database, or a replay after a crash). Not an error, just nothing
  // to do: this is the "read the destination first" rule, asked of a column definition.
  if (currency === undefined || currency.dflt_value === null) return;

  // Enforcement is deferred to the commit rather than applied per statement, because the rebuild
  // passes through states no per-statement check should have an opinion about (two tables holding
  // the same lines, then briefly none). The pragma clears itself at COMMIT, and the explicit
  // `foreign_key_check` below turns what would surface as an opaque constraint failure at commit
  // time into a message that names the table.
  db.pragma('defer_foreign_keys = ON');

  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'journal_line'")
    .get() as { sql: string } | undefined;
  if (table === undefined) throw new Error('journal_line is missing: this database is not a TILL ledger');

  // Everything hanging off the table, captured as the DDL that created it. `sql IS NOT NULL` drops
  // the implicit PRIMARY KEY index, which SQLite recreates from the table definition itself and
  // which cannot be issued as a statement.
  const attached = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE tbl_name = 'journal_line' AND sql IS NOT NULL AND type IN ('index', 'trigger')
        ORDER BY type, name`,
    )
    .all() as { type: string; name: string; sql: string }[];
  const expectedTriggers = attached.filter((o) => o.type === 'trigger').map((o) => o.name);
  const columns = (db.pragma('table_info(journal_line)') as { name: string }[]).map((c) => c.name);
  const before = db.prepare('SELECT rowid AS rid, id, currency FROM journal_line ORDER BY rowid').all() as {
    rid: number;
    id: string;
    currency: string;
  }[];

  // The new definition, derived from the old one by two edits, each of which must actually fire. A
  // regex that matched nothing would otherwise produce a table that is either misnamed or still
  // defaulted, and the rebuild would go on to "succeed".
  const renamed = table.sql.replace(/^CREATE TABLE (IF NOT EXISTS\s+)?("?)journal_line\2/i, 'CREATE TABLE journal_line_rebuild');
  if (renamed === table.sql) throw new Error(`cannot parse the stored journal_line definition: ${table.sql}`);
  const rebuiltDdl = renamed.replace(/^(\s*currency\s+TEXT\s+NOT\s+NULL)\s+DEFAULT\s+'CHF'/im, '$1');
  if (rebuiltDdl === renamed) {
    throw new Error(`cannot find the currency DEFAULT to remove in the stored journal_line definition: ${table.sql}`);
  }

  const columnList = columns.join(', ');
  db.exec(rebuiltDdl);
  // `rowid` is copied EXPLICITLY. A plain column copy would renumber the rows, and while a scan in
  // rowid order happens to preserve their relative order, `reads.ts` reads an entry's currency and
  // rate off the FIRST row by rowid, which is too load-bearing to leave to a happens-to.
  db.exec(
    `INSERT INTO journal_line_rebuild (rowid, ${columnList}) SELECT rowid, ${columnList} FROM journal_line`,
  );
  // DROP TABLE's implicit delete fires no triggers, so journal_line_no_delete_posted does not stand
  // in the way here. It is the reason the old rows have to be gone before the rename, not deleted.
  db.exec('DROP TABLE journal_line');
  db.exec('ALTER TABLE journal_line_rebuild RENAME TO journal_line');
  // Last, and only now: with these in place the copy above would have aborted on the first posted
  // line. Replayed verbatim from what the table actually carried, so nothing can be forgotten.
  for (const object of attached) db.exec(object.sql);

  // --- The migration checks its own work. A throw here rolls the whole rebuild back. --------------
  const after = db.prepare('SELECT rowid AS rid, id, currency FROM journal_line ORDER BY rowid').all() as {
    rid: number;
    id: string;
    currency: string;
  }[];
  if (after.length !== before.length) {
    throw new Error(`the journal_line rebuild changed the row count (${before.length} to ${after.length})`);
  }
  for (const [i, row] of before.entries()) {
    const got = after[i] ?? { rid: -1, id: '(missing)', currency: '(missing)' };
    if (got.rid !== row.rid || got.id !== row.id || got.currency !== row.currency) {
      throw new Error(
        `the journal_line rebuild altered row ${row.id}: ` +
          `expected rowid ${row.rid} currency ${row.currency}, got rowid ${got.rid} currency ${got.currency}`,
      );
    }
  }
  const survivors = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'journal_line'")
        .all() as { name: string }[]
    ).map((t) => t.name),
  );
  const lost = expectedTriggers.filter((name) => !survivors.has(name));
  if (lost.length > 0) {
    // The one outcome worth refusing to open over: the ledger would look intact and would have
    // stopped enforcing that posted rows cannot be changed.
    throw new Error(`the journal_line rebuild lost immutability trigger(s): ${lost.join(', ')}`);
  }
  const stillDefaulted = (
    db.pragma('table_info(journal_line)') as { name: string; dflt_value: string | null }[]
  ).find((c) => c.name === 'currency');
  if (stillDefaulted === undefined || stillDefaulted.dflt_value !== null) {
    throw new Error('the journal_line rebuild did not remove the currency default');
  }
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(`the journal_line rebuild left ${violations.length} dangling foreign key reference(s)`);
  }
}

/**
 * Generation 5, F11: lift `vat_saldo_rate` into the approval history and RETIRE THE NAME.
 *
 * The table held CURRENT configuration and every reader was entitled to treat a row count as "how
 * many Saldosteuersätze this workspace has". Multi-rate Saldo needs the approval HISTORY, and the
 * previous attempt at this added validity columns while keeping the name. Two queries outside that
 * change went on counting rows as current state, and both produced a silent wrong answer rather than
 * a crash: one refused a lawful export for a workspace that had held exactly one rate its whole
 * life, the other reported no ESTV Ziffer at all on every preview.
 *
 * Dropping the name is therefore the migration's POINT, not its side effect. After this runs, a
 * query still naming `vat_saldo_rate` fails with `no such table` the first time it is exercised.
 *
 * The lifted rows open at '0001-01-01', deliberately. A pre-F11 file records no date for its rates
 * and inventing one would either orphan the periods before it (refusing correction returns the filer
 * still needs) or claim a start date the ESTV never granted. The sentinel says exactly what is
 * known: this approval governed everything up to whatever supersedes it, and nothing more precise
 * was ever recorded. The ESTV ladder check in `computeVatReturn` still refuses a rate that did not
 * exist for the reported period, so the sentinel does not become a licence to file 6.2% on a 2019
 * correction return.
 *
 * `workspace.vat_method` needs no lift at all: `vat_method_era` holds CLOSED historical eras only
 * and the workspace row remains the current method, so an un-migrated workspace already reads
 * correctly as "this method governed all of time", which for a file that never recorded a change is
 * exactly true.
 *
 * Idempotent, and it reads the destination first: a fresh database created from the generation-5
 * schema never had `vat_saldo_rate`, so the whole function is a no-op there.
 */
function liftSaldoRatesIntoGenerations(db: Database): void {
  const legacy = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vat_saldo_rate'")
    .get() as { name: string } | undefined;
  if (legacy === undefined) return;

  const rows = db
    .prepare('SELECT workspace_id, position, rate_bp, form_line FROM vat_saldo_rate ORDER BY workspace_id, position')
    .all() as { workspace_id: string; position: number; rate_bp: number; form_line: string | null }[];

  const workspaces = new Set(rows.map((r) => r.workspace_id));
  const now = new Date().toISOString();
  for (const workspaceId of workspaces) {
    db.prepare(
      `INSERT INTO vat_saldo_generation (workspace_id, valid_from, valid_to, created_at, created_by)
       VALUES (?, '0001-01-01', NULL, ?, NULL)
       ON CONFLICT (workspace_id, valid_from) DO NOTHING`,
    ).run(workspaceId, now);
  }
  for (const r of rows) {
    db.prepare(
      `INSERT INTO vat_saldo_generation_rate (workspace_id, valid_from, position, rate_bp, form_line)
       VALUES (?, '0001-01-01', ?, ?, ?)
       ON CONFLICT (workspace_id, valid_from, position) DO NOTHING`,
    ).run(r.workspace_id, r.position, r.rate_bp, r.form_line);
  }

  // The migration checks its own work before the transaction is allowed to commit. A rate that did
  // not survive the lift is a Saldosteuersatz a filed period was computed with, gone silently.
  //
  // ROW BY ROW, AND ON THE VALUE. This used to be `COUNT(*) < rows.length` over every workspace at
  // `'0001-01-01'`, and a count cannot see the failure it exists to catch. Both inserts above are
  // `ON CONFLICT DO NOTHING`, so a partially-applied earlier run leaves rows that satisfy the count
  // while suppressing the real insert underneath them: a pre-existing row at the same
  // (workspace, position) carrying a DIFFERENT `rate_bp` passed a check that only ever compared
  // totals, and the legacy rate was dropped on the floor with the table. Asserting that each legacy
  // rate is present at its own position with its own value is the invariant the comment claimed.
  const at = db.prepare(
    `SELECT rate_bp FROM vat_saldo_generation_rate
      WHERE workspace_id = ? AND valid_from = '0001-01-01' AND position = ?`,
  );
  const lost = rows.filter((r) => {
    const hit = at.get(r.workspace_id, r.position) as { rate_bp: number } | undefined;
    return hit === undefined || hit.rate_bp !== r.rate_bp;
  });
  if (lost.length > 0) {
    const first = lost[0] as { workspace_id: string; position: number; rate_bp: number };
    throw new Error(
      `the Saldo rate lift lost ${lost.length} of ${rows.length} approved rates, ` +
        `first: workspace ${first.workspace_id} position ${first.position} rate ${first.rate_bp}`,
    );
  }

  db.exec('DROP TABLE vat_saldo_rate');
}

/**
 * Generation 6: disable every stored automation rule whose action the denylist has since denied,
 * with an audit line each (F5-C1, the stored-rule half).
 *
 * WHY A MIGRATION AND NOT ONLY THE FIRE-TIME CHECK. The F5 retrofit grew `NOT_AUTOMATABLE` from 9
 * to 28 verbs, and every one of the additions was a legal, saveable rule action the day before: a
 * workspace can hold an enabled, human-approved rule naming `close_year` or `set_role`, written
 * through the public verb. The fire path now refuses such a rule on every occurrence, but that
 * shape is a rule failing forever at 03:00 with nobody told. Disabling it once, on the first open
 * after the upgrade, turns a permanent background failure into a visible state: the rule sits
 * disabled on the Automations surface, the audit chain says the system disabled it and when, and
 * re-enabling is refused: `update_automation_rule` validates the action on patch, and
 * `enable_automation_rule` checks the STORED action's denylist membership before flipping the flag
 * (the F5-R4 repair; the first version of this sentence claimed that check existed before it did,
 * which is the same false-safety pattern that kept F5-C1 invisible).
 *
 * THE AUDIT LINE GOES THROUGH `appendAuditLog`, never a raw INSERT, because the log is hash-chained
 * (§H-AUDIT) and a raw row would break the chain this product promises an auditor. The actor is
 * `system`: no person asked for this, and attributing it to one would be a lie in the one record
 * that must not carry any.
 *
 * Idempotent: the second run finds `enabled = 0` and selects nothing. Denylist GROWTH after this
 * generation is covered by the fire-time check (the rule fails visibly with
 * `action_not_automatable` in the Verlauf) rather than by minting a new generation per entry, which
 * would turn every denylist edit into a migration.
 */
function disableDeniedAutomationRules(db: Database): void {
  const placeholders = [...NOT_AUTOMATABLE].map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, workspace_id, action_tool FROM automation_rule
        WHERE enabled = 1 AND action_tool IN (${placeholders})
        ORDER BY workspace_id, id`,
    )
    .all(...NOT_AUTOMATABLE) as { id: string; workspace_id: string; action_tool: string }[];

  const now = new Date().toISOString();
  const disable = db.prepare('UPDATE automation_rule SET enabled = 0, updated_at = ? WHERE id = ?');
  for (const row of rows) {
    disable.run(now, row.id);
    appendAuditLog(
      // `appendAuditLog` reads exactly `store.db`; a migration holds the db and nothing else, and
      // importing the real store class here would be a runtime cycle (it imports this file).
      { store: { db } as SqliteStore, workspaceId: row.workspace_id, ids: systemIdGen },
      {
        entityKind: 'automation_rule',
        entityId: row.id,
        action: 'disable',
        actor: 'system',
        at: now,
      },
    );
  }
}

/** The seed accounts A38 added on 2026-09-09: the short-term provision, the MWST rounding income, the direct taxes. */
const A38_SEED_ACCOUNTS = ['2330', '3809', '8900'] as const;

/**
 * Generation 7 (A38): give every workspace the three seed accounts A38 added to the KMU chart.
 *
 * `seedChartOfAccounts` runs once, at `create_workspace`, so a book born before A38 never received
 * 2330, 3809 or 8900 and `tax_provision_preview` read `missingAccounts` on it forever (critic
 * finding). The top-up inserts by number only where no row exists (`INSERT ... WHERE NOT EXISTS`),
 * so a renamed, archived or re-typed account of the same number is left exactly as the book tuned
 * it, and a second run inserts nothing. Scoped to the three numbers on purpose: a seed account a
 * book deleted deliberately is not resurrected by an unrelated upgrade.
 */
function seedA38Accounts(db: Database): void {
  const workspaces = db.prepare('SELECT id FROM workspace ORDER BY created_at, id').all() as { id: string }[];
  for (const ws of workspaces) {
    topUpChartOfAccounts(db, ws.id, systemIdGen, { numbers: A38_SEED_ACCOUNTS });
  }
}

/**
 * Generation 8 (A39, the bank inbox, spec L1): adopt every pre-A39 bank-line decision ONCE into A39's
 * decision and claim rows, then disable the stored rules naming a verb A39 newly denies.
 *
 * Before A39 a bank line was decided in three partial models: an A20 `bank_txn_link` row (a settlement, a
 * batch, a link to an entry) that could never be undone, an A21 queue row (`applied` or `dismissed`) with
 * no link at all, and nothing for a debit. A39 reads ONE model: a line is `open` without a live
 * `bank_line_decision`, else that decision's state, and a booked or matched decision holds its bank legs
 * in `bank_line_claim`. This generation turns every legacy fact into that model, once, in four idempotent
 * statements (each touches only rows not yet adopted):
 *
 *   1. An A21 credit decided before A39 (applied with a payment, or dismissed) whose line has no link at
 *      all gets its link. The line is found through `bank_txn.credit_id`, a DECLARED reference, never
 *      through `reconciliation_match.bank_txn_id`.
 *   2. Every link without a decision gets its decision, from what it names, resolved INSIDE its own
 *      workspace (§H-TENANT). A target that does not resolve there (`legacy_target_unresolved`) or that
 *      is already reversed (`legacy_target_reversed`: a Storno of the entry, a reversed payment, a reversed
 *      item payment of the run) is adopted SUPERSEDED: its line reads open and is decided again, never
 *      trusted on money that is gone.
 *   3. Every adopted live booked or matched decision claims its bank legs, oldest first; a leg another
 *      live decision already holds is skipped (pre-A39 data could link one entry to two lines).
 *   4. An adopted decision that could claim no leg is superseded (`legacy_no_claimable_leg`).
 *
 * The same generation re-runs `disableDeniedAutomationRules`, because A39 added the three inbox verbs and
 * the payment verbs (`record_payment`, `allocate_payment`, `reverse_payment`, ...) to `NOT_AUTOMATABLE`: a
 * stored rule naming one is disabled with an audit line instead of failing at every fire.
 *
 * Nothing of this runs at store open or before a write any more (the lean spec's L1): the store runs it
 * with the version bump in one transaction, and the generation guard keeps an older build off the book.
 */
function adoptPreA39BankDecisions(db: Database): void {
  // A20's "one link per line, ever" index would refuse the supersession history A39 keeps. It is dropped
  // here, in the generation's transaction, and never at store open: the banking DDL an up-to-date book
  // runs at every open must write nothing (the open takes no write lock, the generation guard's F3).
  db.exec('DROP INDEX IF EXISTS bank_txn_link_one_per_txn');
  const now = new Date().toISOString();
  const resolved = "(l.kind = 'ignored' OR je.id IS NOT NULL OR pe.id IS NOT NULL OR b.id IS NOT NULL)";
  const reversedEntry = (e: string): string =>
    `EXISTS (SELECT 1 FROM journal_entry rv WHERE rv.workspace_id = l.workspace_id AND rv.reverses_entry_id = ${e} AND rv.status = 'posted')`;
  const reversed = `(
      (l.kind = 'journal_entry' AND je.id IS NOT NULL AND ${reversedEntry('je.id')})
   OR (l.kind = 'payment' AND pe.id IS NOT NULL AND (p.status = 'reversed' OR ${reversedEntry('pe.id')}))
   OR (l.kind = 'payment_batch' AND b.id IS NOT NULL AND EXISTS (
         SELECT 1 FROM payment_batch_item bi JOIN payment bp ON bp.workspace_id = bi.workspace_id AND bp.id = bi.posted_payment_id
          WHERE bi.workspace_id = l.workspace_id AND bi.batch_id = b.id AND bp.status = 'reversed')))`;
  const live = `(${resolved} AND NOT ${reversed})`;
  db.prepare(
    `INSERT OR IGNORE INTO bank_txn_link (id, workspace_id, bank_txn_id, kind, target_id, created_by, created_at)
     SELECT 'btlk-a39-' || m.id, t.workspace_id, t.id,
            CASE m.status WHEN 'applied' THEN 'payment' ELSE 'ignored' END,
            CASE m.status WHEN 'applied' THEN m.payment_id ELSE 'other' END,
            COALESCE(m.decided_by, m.created_by), COALESCE(m.decided_at, m.created_at)
       FROM reconciliation_match m
       JOIN bank_txn t ON t.workspace_id = m.workspace_id AND t.credit_id = m.id
      WHERE (m.status = 'dismissed' OR (m.status = 'applied' AND m.payment_id IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM bank_txn_link x WHERE x.workspace_id = t.workspace_id AND x.bank_txn_id = t.id)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO bank_line_decision
       (link_id, workspace_id, bank_txn_id, state, target_kind, entry_id, payment_id, journal_line_id,
        ignore_reason, note, remainder_mode, remainder_minor, accept_difference, difference_minor,
        created_by, created_at, superseded_at, superseded_by, supersede_reason)
     SELECT l.id, l.workspace_id, l.bank_txn_id,
            CASE l.kind WHEN 'ignored' THEN 'ignored'
                        WHEN 'journal_entry' THEN (CASE WHEN je.source = 'camt' THEN 'booked' ELSE 'matched' END)
                        ELSE 'booked' END,
            'legacy',
            CASE l.kind WHEN 'journal_entry' THEN je.id WHEN 'payment' THEN pe.id ELSE NULL END,
            p.id,
            NULL,
            CASE WHEN l.kind = 'ignored' THEN 'other' ELSE NULL END,
            CASE WHEN l.kind = 'ignored' AND l.id LIKE 'btlk-a39-%' THEN 'qr_dismissed' ELSE NULL END,
            NULL, NULL, 0, NULL, l.created_by, l.created_at,
            CASE WHEN ${live} THEN NULL ELSE @now END,
            CASE WHEN ${live} THEN NULL ELSE 'system' END,
            CASE WHEN NOT ${resolved} THEN 'legacy_target_unresolved' WHEN ${reversed} THEN 'legacy_target_reversed' ELSE NULL END
       FROM bank_txn_link l
       JOIN bank_txn t ON t.workspace_id = l.workspace_id AND t.id = l.bank_txn_id
       LEFT JOIN journal_entry je ON l.kind = 'journal_entry' AND je.workspace_id = l.workspace_id AND je.id = l.target_id AND je.status = 'posted'
       LEFT JOIN payment p ON l.kind = 'payment' AND p.workspace_id = l.workspace_id AND p.id = l.target_id
       LEFT JOIN journal_entry pe ON pe.workspace_id = l.workspace_id AND pe.id = p.journal_entry_id AND pe.status = 'posted'
       LEFT JOIN payment_batch b ON l.kind = 'payment_batch' AND b.workspace_id = l.workspace_id AND b.id = l.target_id
      WHERE NOT EXISTS (SELECT 1 FROM bank_line_decision d WHERE d.link_id = l.id)
      ORDER BY l.created_at, l.rowid`,
  ).run({ now });
  db.prepare(
    `INSERT OR IGNORE INTO bank_line_claim (link_id, workspace_id, bank_txn_id, journal_line_id, entry_id, amount_minor, released_at)
     SELECT d.link_id, d.workspace_id, d.bank_txn_id, jl.id, jl.entry_id, jl.debit_minor - jl.credit_minor, NULL
       FROM bank_line_decision d
       JOIN bank_txn t ON t.workspace_id = d.workspace_id AND t.id = d.bank_txn_id
       JOIN bank_account ba ON ba.workspace_id = t.workspace_id AND ba.id = t.bank_account_id
       JOIN (SELECT d2.link_id AS link_id, d2.entry_id AS entry_id FROM bank_line_decision d2
              WHERE d2.target_kind = 'legacy' AND d2.entry_id IS NOT NULL
             UNION ALL
             SELECT d3.link_id, p3.journal_entry_id FROM bank_line_decision d3
               JOIN bank_txn_link l3 ON l3.id = d3.link_id AND l3.kind = 'payment_batch'
               JOIN payment_batch_item i3 ON i3.workspace_id = d3.workspace_id AND i3.batch_id = l3.target_id
               JOIN payment p3 ON p3.workspace_id = d3.workspace_id AND p3.id = i3.posted_payment_id
              WHERE d3.target_kind = 'legacy' AND p3.journal_entry_id IS NOT NULL) src ON src.link_id = d.link_id
       JOIN journal_entry e ON e.workspace_id = d.workspace_id AND e.id = src.entry_id AND e.status = 'posted'
       JOIN journal_line jl ON jl.entry_id = e.id AND jl.account_id = ba.ledger_account_id
      WHERE d.target_kind = 'legacy' AND d.superseded_at IS NULL AND d.state IN ('booked', 'matched')
        AND NOT EXISTS (SELECT 1 FROM bank_line_claim c WHERE c.link_id = d.link_id)
      ORDER BY d.created_at, d.link_id, jl.rowid`,
  ).run();
  db.prepare(
    `UPDATE bank_line_decision
        SET superseded_at = @now, superseded_by = 'system', supersede_reason = 'legacy_no_claimable_leg'
      WHERE target_kind = 'legacy' AND superseded_at IS NULL AND state IN ('booked', 'matched')
        AND NOT EXISTS (SELECT 1 FROM bank_line_claim c WHERE c.link_id = bank_line_decision.link_id)`,
  ).run({ now });
  disableDeniedAutomationRules(db);
}

/**
 * The DDL generation 9 adds once every row is frozen: one UNIQUE index per reference column, scoped to
 * the workspace, and one trigger per table that refuses to change or clear a reference once it is set.
 * Exported so a test can name exactly what the generation owns. Not in `SCHEMA_SQL` or
 * `ADDITIVE_INDEXES`, because both run BEFORE the data migrations on an older file, and a UNIQUE index
 * over `msg_id` (a column that predates generation 9 and was never checked for duplicates) or a freeze
 * trigger ahead of the backfill would make the book unopenable or block the backfill itself.
 */
export const FROZEN_REFERENCE_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS payment_batch_msg_id_ref_unique ON payment_batch (workspace_id, msg_id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_batch_pmt_inf_id_ref_unique ON payment_batch (workspace_id, pmt_inf_id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_batch_item_instr_id_ref_unique ON payment_batch_item (workspace_id, instr_id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_batch_item_end_to_end_id_ref_unique ON payment_batch_item (workspace_id, end_to_end_id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_batch_item_seq_ref_unique ON payment_batch_item (workspace_id, batch_id, seq);

CREATE TRIGGER IF NOT EXISTS payment_batch_refs_frozen
BEFORE UPDATE OF msg_id, pmt_inf_id, debtor_name, debtor_iban, generated_at, ctrl_sum_minor, nb_of_txs ON payment_batch
WHEN (OLD.generated_at IS NOT NULL AND NEW.generated_at IS NOT OLD.generated_at)
  OR (OLD.ctrl_sum_minor IS NOT NULL AND NEW.ctrl_sum_minor IS NOT OLD.ctrl_sum_minor)
  OR (OLD.nb_of_txs IS NOT NULL AND NEW.nb_of_txs IS NOT OLD.nb_of_txs)
  OR (OLD.msg_id IS NOT NULL AND NEW.msg_id IS NOT OLD.msg_id)
  OR (OLD.pmt_inf_id IS NOT NULL AND NEW.pmt_inf_id IS NOT OLD.pmt_inf_id)
  OR (OLD.debtor_name IS NOT NULL AND NEW.debtor_name IS NOT OLD.debtor_name)
  OR (OLD.debtor_iban IS NOT NULL AND NEW.debtor_iban IS NOT OLD.debtor_iban)
BEGIN
  SELECT RAISE(ABORT, 'payment_batch_refs_frozen');
END;

CREATE TRIGGER IF NOT EXISTS payment_batch_item_refs_frozen
BEFORE UPDATE OF batch_id, instr_id, end_to_end_id, seq, creditor_name ON payment_batch_item
WHEN NEW.batch_id IS NOT OLD.batch_id
  OR (OLD.instr_id IS NOT NULL AND NEW.instr_id IS NOT OLD.instr_id)
  OR (OLD.end_to_end_id IS NOT NULL AND NEW.end_to_end_id IS NOT OLD.end_to_end_id)
  OR (OLD.seq IS NOT NULL AND NEW.seq IS NOT OLD.seq)
  OR (OLD.creditor_name IS NOT NULL AND NEW.creditor_name IS NOT OLD.creditor_name
      AND NOT (NEW.creditor_name IS NULL AND EXISTS (
        SELECT 1 FROM payment_batch b WHERE b.workspace_id = OLD.workspace_id AND b.id = OLD.batch_id
           AND b.status = 'discarded' AND b.generated_at IS NULL)))
BEGIN
  SELECT RAISE(ABORT, 'payment_batch_item_refs_frozen');
END;
`;

/**
 * The creditor-IBAN half of the item lock (owner R2-5: an erasure may blank it, to '', only on a batch
 * discarded as a draft). A separate trigger, created only where `payment_batch_item.creditor_iban`
 * exists: every real book has it (A18 was born with it), but the M-3 rename fixture derives an "old"
 * schema by renaming EVERY `creditor_iban` in `SCHEMA_SQL`, this column included, and a trigger naming
 * a column the table lacks would make the whole generation fail on that shape.
 */
export const FROZEN_CREDITOR_IBAN_DDL = `
CREATE TRIGGER IF NOT EXISTS payment_batch_item_iban_frozen
BEFORE UPDATE OF creditor_iban ON payment_batch_item
WHEN NEW.creditor_iban IS NOT OLD.creditor_iban
 AND NOT (NEW.creditor_iban = '' AND EXISTS (
   SELECT 1 FROM payment_batch b WHERE b.workspace_id = OLD.workspace_id AND b.id = OLD.batch_id
      AND b.status = 'discarded' AND b.generated_at IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'payment_batch_item_refs_frozen');
END;
`;

/**
 * Generation 9 (A18, 30.09.2026): FREEZE the four pain.001 references on every batch and item written
 * before they were stored, then add the UNIQUE indexes and the freeze triggers over them.
 *
 * Until now `buildPain001Xml` re-derived MsgId/PmtInfId/InstrId/EndToEndId from the row's database id
 * on every render (`compactReference`), and a G04 restore or an `env_copy` re-mints every id, so the
 * same batch regenerated in a restored book carried a NEW MsgId that the bank's duplicate check (SIX
 * IG SPS 2025 §3.8) could not recognise. From this generation on, `createPaymentBatch` stamps the four
 * values at creation and the XML is built only from them.
 *
 * WHAT A ROW IS FROZEN AT is the value its XML already carried, so a batch already sent keeps what the
 * bank saw ("derive, never transform"), with the one exception stated under ONE LIMIT below:
 *  - InstrId, EndToEndId, PmtInfId: `compactReference` of the row's CURRENT id, exactly what the
 *    renderer produced until now.
 *  - MsgId: the stored `msg_id` when it has the compact shape (`isCompactMsgId`). On an untouched book
 *    that IS `compactReference('M', id)`, written at generation. On a book a develop-era restore
 *    produced it is the MsgId of the ORIGINAL id (restore copied the column verbatim while it re-minted
 *    the id), which is precisely the value the bank deduplicates on; the batch's PmtInfId then follows
 *    the same original id (`P` + the same core). A NULL (a draft) or a pre-F2 `PB-<id>` value (over 35
 *    characters for every production id, so never accepted by a bank) takes the id-derived value.
 *
 * TWO LIMITS, and neither can be repaired, because the value the bank saw is gone from the book.
 *
 * (C3, critic r1) On a book a develop-era restore produced, the
 * ORIGINAL item ids no longer exist anywhere, so InstrId/EndToEndId are frozen from the RE-MINTED item
 * ids. They are then NOT the values the bank and the creditors saw for that run. MsgId is kept (and
 * PmtInfId follows it), so the bank's duplicate check still catches a re-upload and nothing is paid
 * twice; but a camt.053 line of such a run that names only an item's EndToEndId will not match its item,
 * and those lines are booked by hand (the run total still matches on the PmtInfId). Every book that
 * was never restored before generation 9 is frozen exactly.
 *
 * (R3-3, critic r3) The debtor IBAN is frozen from the account's CURRENT IBAN. Before generation 9
 * `update_bank_account` allowed an IBAN change on an account with payment batches (when it had no
 * opening balance), so on a book whose account IBAN changed AFTER a file was sent, the snapshot is an
 * IBAN that file never carried, and a regenerated file differs from the sent one in DbtrAcct/DbtrAgt.
 * MsgId and every other reference are frozen as sent, so the bank's duplicate check still holds at the
 * bank that received it; a re-upload at a DIFFERENT bank is what the frozen IBAN prevents from here on.
 *
 * UNIQUE PER WORKSPACE, AND KEPT VALUES WIN. Rows that keep a stored MsgId are frozen first, so a
 * derived value can never push a transmitted MsgId aside; any collision (only reachable through
 * non-uuid test ids or a restored copy of a batch) is disambiguated by `mintFrozenReference`, which is
 * the same rule `createPaymentBatch` uses and is what makes the UNIQUE indexes below safe to create.
 *
 * THE ONE ADMITTED CHANGE (owner decision, 01.10.2026, critic r2 R2-5): the item trigger also locks the
 * creditor snapshot (name and IBAN), except that a C00 erasure may CLEAR it (name to NULL, IBAN to '')
 * on an item of a batch discarded as a draft (`discarded` with no `generated_at`, so no file ever existed).
 * Any other change, and any clearing on a batch that produced a file, is refused. The exception is
 * judged on the batch the item BELONGS to (`OLD.batch_id`), and an item never changes batch (critic r3
 * R3-1): otherwise one statement could move a sent item into a discarded draft and clear it.
 *
 * THE DEBTOR IBAN is frozen with them (critic r2 R2-1): `payment_batch.debtor_iban` (and so the DbtrAgt
 * clearing number derived from it), read from the debtor bank account row as the renderer did.
 *
 * THE DEBTOR NAME is frozen with them (critic r1 C2): `payment_batch.debtor_name`, the InitgPty/Dbtr
 * name, read by the renderer's rule. A restore under another workspace name changed it before.
 *
 * THE CREDITOR NAME is frozen with them (owner decision D148): `payment_batch_item.creditor_name`, the
 * Cdtr/Nm, snapshotted like `creditor_iban` and read by the renderer's rule (merge tombstone followed).
 * A vendor rename, or a C00 erasure of the vendor, changed the bytes of a sent file before.
 *
 * THE ITEM ORDER is frozen with them (critic r1 C2): `payment_batch_item.seq`, each item's position in
 * its batch, is filled from the rowid order the renderer used until now. Row order is not something a
 * G04 backup and restore preserve, so a batch rendered by rowid came back from a restore with its
 * CdtTrfTxInf elements in another order: the same references, a different file and payload hash.
 *
 * IDEMPOTENT: only rows with a missing reference are touched, and a row is filled in one statement, so
 * a second run finds nothing to do; the DDL is `IF NOT EXISTS`. It runs inside the generation's
 * transaction like every step here, so a crash leaves generation 8 and the rows as they were.
 */
function freezePain001References(db: Database): void {
  // Pass G (critic r3 R3-2): stamp `generated_at` on every batch that produced a file. Today that is
  // proven by the status (generated or paid) or, for a discarded batch, by the control sum generation
  // wrote in the same statement as the flip. The time is the batch's earliest recorded `update` in the
  // audit log (the generation's own row, since generation is the first update a batch can have), else
  // its creation time; the stamp's job is the FACT that a file existed, the time is best effort.
  db.prepare(
    `UPDATE payment_batch
        SET generated_at = COALESCE(
              (SELECT MIN(l.at) FROM audit_log l
                WHERE l.workspace_id = payment_batch.workspace_id AND l.entity_kind = 'payment_batch'
                  AND l.entity_id = payment_batch.id AND l.action = 'update'),
              payment_batch.cre_dt_tm)
      WHERE generated_at IS NULL
        AND (status IN ('generated', 'paid') OR (status = 'discarded' AND ctrl_sum_minor IS NOT NULL))`,
  ).run();

  // Pass 0: a stored msg_id that is not a compact MsgId was never carried by a file the bank accepted;
  // clear it on the unfrozen rows so the remaining non-NULL values are exactly the ones to keep.
  const unfrozen = db
    .prepare('SELECT id, workspace_id, msg_id FROM payment_batch WHERE pmt_inf_id IS NULL')
    .all() as { id: string; workspace_id: string; msg_id: string | null }[];
  const clearMsg = db.prepare('UPDATE payment_batch SET msg_id = NULL WHERE workspace_id = ? AND id = ?');
  for (const row of unfrozen) if (row.msg_id !== null && !isCompactMsgId(row.msg_id)) clearMsg.run(row.workspace_id, row.id);

  // Pass 1: every unfrozen batch, rows that keep a stored MsgId first, then by insertion order.
  const batches = db
    .prepare('SELECT id, workspace_id, msg_id FROM payment_batch WHERE pmt_inf_id IS NULL ORDER BY (msg_id IS NULL), rowid')
    .all() as { id: string; workspace_id: string; msg_id: string | null }[];
  const setBatch = db.prepare('UPDATE payment_batch SET msg_id = ?, pmt_inf_id = ? WHERE workspace_id = ? AND id = ?');
  for (const b of batches) {
    const kept = isCompactMsgId(b.msg_id) ? b.msg_id : null;
    const msgId = mintFrozenReference(
      kept ?? compactReference('M', b.id),
      referenceTakenIn(db, b.workspace_id, { table: 'payment_batch', column: 'msg_id' }, b.id),
    );
    const pmtInfId = mintFrozenReference(
      kept !== null ? `P${kept.slice(1)}` : compactReference('P', b.id),
      referenceTakenIn(db, b.workspace_id, { table: 'payment_batch', column: 'pmt_inf_id' }, b.id),
    );
    setBatch.run(msgId, pmtInfId, b.workspace_id, b.id);
  }

  // Pass 2: every unfrozen item, by insertion order.
  const items = db
    .prepare('SELECT id, workspace_id FROM payment_batch_item WHERE instr_id IS NULL OR end_to_end_id IS NULL ORDER BY rowid')
    .all() as { id: string; workspace_id: string }[];
  const setItem = db.prepare('UPDATE payment_batch_item SET instr_id = ?, end_to_end_id = ? WHERE workspace_id = ? AND id = ?');
  for (const it of items) {
    const instrId = mintFrozenReference(
      compactReference('I', it.id),
      referenceTakenIn(db, it.workspace_id, { table: 'payment_batch_item', column: 'instr_id' }, it.id),
    );
    const endToEndId = mintFrozenReference(
      compactReference('E', it.id),
      referenceTakenIn(db, it.workspace_id, { table: 'payment_batch_item', column: 'end_to_end_id' }, it.id),
    );
    setItem.run(instrId, endToEndId, it.workspace_id, it.id);
  }

  // Pass 3a (critic r1 C2): the debtor name, by the renderer's own rule until now (`debtorNameOf` in
  // pain001.ts: the profile's creditor name, else the workspace name).
  db.prepare(
    `UPDATE payment_batch
        SET debtor_name = (SELECT COALESCE(w.creditor_name, w.name, 'TILL') FROM workspace w WHERE w.id = payment_batch.workspace_id)
      WHERE debtor_name IS NULL`,
  ).run();
  // Critic r2 R2-1: the debtor IBAN, from the debtor bank account row the renderer read until now.
  db.prepare(
    `UPDATE payment_batch
        SET debtor_iban = (SELECT a.iban FROM bank_account a
                            WHERE a.workspace_id = payment_batch.workspace_id AND a.id = payment_batch.bank_account_id)
      WHERE debtor_iban IS NULL`,
  ).run();

  // Pass 3c (D148): every item's creditor name, by the renderer's own rule until now (`resolveContactRef`
  // in sales/contact.ts): the vendor contact with a merge tombstone followed to its survivor (a bounded
  // walk, a seen-set against a hand-edited cycle), its name, else the vendor id itself.
  //
  // A vendor with no resolvable contact: the renderer then printed the vendor's database id. For a batch
  // already GENERATED (or paid, or discarded after generation) that id IS what the file carried, and the
  // bank holds that file under its MsgId, so the snapshot keeps it: byte-identity with what was sent
  // outranks tidiness (and G04 lists the column as a natural key, so a restore never rewrites it). For a
  // DRAFT nothing was ever sent, so no id is written: the name stays NULL and generation refuses
  // `creditor_name_missing`, which is what creating that batch today would answer.
  const unnamed = db
    .prepare(
      `SELECT i.id AS id, i.workspace_id AS workspace_id, i.vendor_id AS vendor_id, b.status AS status,
              b.generated_at AS generated_at
         FROM payment_batch_item i JOIN payment_batch b ON b.workspace_id = i.workspace_id AND b.id = i.batch_id
        WHERE i.creditor_name IS NULL`,
    )
    .all() as { id: string; workspace_id: string; vendor_id: string; status: string; generated_at: string | null }[];
  const contactOf = db.prepare('SELECT id, name, merged_into_id FROM contact WHERE workspace_id = ? AND id = ?');
  const setName = db.prepare('UPDATE payment_batch_item SET creditor_name = ? WHERE workspace_id = ? AND id = ?');
  for (const it of unnamed) {
    type ContactLink = { id: string; name: string | null; merged_into_id: string | null };
    let row = contactOf.get(it.workspace_id, it.vendor_id) as ContactLink | undefined;
    const seen = new Set<string>(row === undefined ? [] : [row.id]);
    while (row !== undefined && row.merged_into_id !== null) {
      const next = contactOf.get(it.workspace_id, row.merged_into_id) as ContactLink | undefined;
      if (next === undefined || seen.has(next.id)) break;
      seen.add(next.id);
      row = next;
    }
    // With a file: exactly what the renderer printed (`name ?? vendor_id`, a blank name included).
    // Without one: only a name the creation rule accepts (`isBlankName`, critic r2 R2-2), else NULL.
    const name = batchHadFile(it.generated_at)
      ? (row?.name ?? it.vendor_id)
      : isBlankName(row?.name) ? null : (row?.name as string);
    if (name !== null) setName.run(name, it.workspace_id, it.id);
  }

  // Pass 3b (critic r1 C2): every item's position in its batch, frozen at the order the renderer used
  // until now (rowid within the batch), continuing after any position the batch already holds.
  const unplaced = db
    .prepare('SELECT id, workspace_id, batch_id FROM payment_batch_item WHERE seq IS NULL ORDER BY workspace_id, batch_id, rowid')
    .all() as { id: string; workspace_id: string; batch_id: string }[];
  const lastSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM payment_batch_item WHERE workspace_id = ? AND batch_id = ?');
  const setSeq = db.prepare('UPDATE payment_batch_item SET seq = ? WHERE workspace_id = ? AND id = ?');
  for (const it of unplaced) {
    const next = (lastSeq.get(it.workspace_id, it.batch_id) as { n: number }).n + 1;
    setSeq.run(next, it.workspace_id, it.id);
  }

  db.exec(FROZEN_REFERENCE_DDL);
  if (hasColumn(db, 'payment_batch_item', 'creditor_iban')) db.exec(FROZEN_CREDITOR_IBAN_DDL);
}

/**
 * Generation 10 (D163, owner pick 04.10.2026: workspace default terms): make
 * `contact.payment_terms_days` NULLABLE and turn every stored 0 into NULL, once.
 *
 * Until now the column was `NOT NULL DEFAULT 0` and `createContact` wrote 0 whenever no terms were
 * given, so 0 meant two things: "this contact has no terms of its own" (almost every row) and "this
 * contact pays immediately" (a deliberate choice). D163 separates them: NULL is "none of its own, the
 * workspace default applies", 0 is "due immediately" (`core/setup/paymentTerms.ts`). The stored rows
 * cannot say which of the two a 0 was, and the overwhelming majority were the create default, so every
 * 0 becomes NULL. A contact somebody deliberately set to 0 therefore takes the workspace default after
 * this runs; while no workspace default is set that is the same date (the document date), and setting
 * the contact's terms to 0 again restores "due immediately" for good.
 *
 * ## Why add, copy, drop, rename rather than a table rebuild
 *
 * SQLite has no `ALTER COLUMN`, so a NOT NULL cannot be lifted in place. The full rebuild generation 4
 * performs on `journal_line` is not needed here: `contact` carries no trigger and no index over this
 * column, and nothing references the column itself (other tables reference `contact(id)`, which this
 * leaves untouched). So the column is REPLACED: a nullable twin is added, the values are derived into
 * it, the old column is dropped and the twin takes its name. The rows, their rowids and every foreign
 * key into `contact` stay exactly where they are; only the column's position in `SELECT *` moves to
 * the end, and every reader maps it by name.
 *
 * Self-detecting like every step in this file: a column that is already nullable (a fresh database
 * built from the current `SCHEMA_SQL`) is the new shape, and the function does nothing. All four
 * statements commit with the version bump in the store's one migration transaction, and the function
 * checks its own output before returning, so a throw leaves the old generation and the old column.
 */
/**
 * Generation 12 (D170): a disposal can be taken back by `asset_transaction_reverse`, and a partial unique
 * index cannot see the correcting row, so `asset_transaction_one_disposal` would refuse every later, real
 * disposal of that asset. Drop it here; the schema pass (`transactionSchema.ts`) drops it too on every
 * open and creates `asset_transaction_one_live_disposal`, the trigger that counts live disposals only.
 * Idempotent, and a no-op on a file without the table.
 */
function liveDisposalGuard(db: Database): void {
  db.exec('DROP INDEX IF EXISTS asset_transaction_one_disposal');
}

function nullableContactPaymentTerms(db: Database): void {
  const column = (db.pragma('table_info(contact)') as { name: string; notnull: number }[]).find(
    (c) => c.name === 'payment_terms_days',
  );
  // No contact table column at all is not a TILL ledger this build wrote; nullable is the new shape.
  if (column === undefined || column.notnull === 0) return;

  const before = db.prepare('SELECT id, payment_terms_days AS days FROM contact ORDER BY rowid').all() as {
    id: string;
    days: number;
  }[];

  const twin = 'payment_terms_days_d163';
  if (!hasColumn(db, 'contact', twin)) db.exec(`ALTER TABLE contact ADD COLUMN ${twin} INTEGER`);
  db.exec(`UPDATE contact SET ${twin} = NULLIF(payment_terms_days, 0)`);
  db.exec('ALTER TABLE contact DROP COLUMN payment_terms_days');
  db.exec(`ALTER TABLE contact RENAME COLUMN ${twin} TO payment_terms_days`);

  // --- The migration checks its own work. A throw here rolls the whole step back. -----------------
  const after = (db.pragma('table_info(contact)') as { name: string; notnull: number }[]).find(
    (c) => c.name === 'payment_terms_days',
  );
  if (after === undefined || after.notnull !== 0) {
    throw new Error('the contact.payment_terms_days migration did not leave a nullable column');
  }
  const rows = db.prepare('SELECT id, payment_terms_days AS days FROM contact ORDER BY rowid').all() as {
    id: string;
    days: number | null;
  }[];
  if (rows.length !== before.length) {
    throw new Error(`the contact.payment_terms_days migration changed the row count (${before.length} to ${rows.length})`);
  }
  for (const [i, row] of before.entries()) {
    const got = rows[i];
    const expected = row.days === 0 ? null : row.days;
    if (got === undefined || got.id !== row.id || got.days !== expected) {
      throw new Error(
        `the contact.payment_terms_days migration altered contact ${row.id}: expected ${String(expected)}, got ${String(got?.days)}`,
      );
    }
  }
}

/** The input codes D167 added to `DEFAULT_TAX_CODES` (A39 §13.3), the ones generation 11 tops up. */
export const D167_INPUT_CODES: readonly string[] = ['VST-M26', 'VST-M38', 'VST-I26', 'VST-I38'];

/**
 * Generation 11 (D167, 14.10.2026, A39 §13.3): give every workspace that already holds tax codes the four
 * reduced-rate input codes `VST-M26` and `VST-M38` (Ziffer 400) and `VST-I26` and `VST-I38` (Ziffer 405,
 * D167-4), exactly as `seedTaxCodes` writes them from `DEFAULT_TAX_CODES`.
 *
 * A workspace with NO codes is left alone: it has not enabled MWST, and `configureVat` seeds the full
 * default set (these two included) when it does. A workspace that already has a code of either name keeps
 * its own row untouched (`INSERT OR IGNORE` on `UNIQUE (workspace_id, code)`), so a replay, or a book a
 * person already gave the code, changes nothing. Row-level only, no DDL.
 */
function seedD167InputCodes(db: Database): void {
  const codes = DEFAULT_TAX_CODES.filter((c) => D167_INPUT_CODES.includes(c.code));
  if (codes.length !== D167_INPUT_CODES.length) throw new Error('generation 11: DEFAULT_TAX_CODES lacks a D167 input code');
  const workspaces = db
    .prepare('SELECT DISTINCT workspace_id AS id FROM tax_code ORDER BY workspace_id')
    .all() as { id: string }[];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO tax_code (id, workspace_id, code, kind, rate_bp, esa_form_line, label, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  for (const ws of workspaces) {
    for (const c of codes) insert.run(systemIdGen.next('tax'), ws.id, c.code, c.kind, c.rateBp, c.formLine, c.label);
  }
}

/**
 * Generation 13 (D172, 15.10.2026): the workspace settings registry's two tables. The schema pass already
 * creates them on every open (`SETTINGS_SCHEMA_SQL`, IF NOT EXISTS); this step runs the same DDL so the
 * generation's own step is self-sufficient, and then checks its work: both tables present. No row is read or written: a book that never touched a
 * setting holds nothing here, and every setting reads its registry default. Idempotent.
 */
function workspaceSettingsTables(db: Database): void {
  db.exec(SETTINGS_SCHEMA_SQL);
  // One-table probes (the table-enumeration chokepoint admits exactly this shape).
  const probe = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
  for (const needed of ['workspace_setting', 'workspace_setting_change']) {
    if (probe.get(needed) === undefined) throw new Error(`generation 13: ${needed} is missing after the settings DDL`);
  }
}

/** D173 (owner Q12): the column the generation-14 step adds, exported for the migration test set. */
export const D173_RUN_KIND_DDL =
  "ALTER TABLE wage_journal_posts ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'regular' CHECK (run_kind IN ('regular','bonus','thirteenth','correction'))";

/**
 * Generation 14 (D173, owner Q12, 15.10.2026): `wage_journal_posts.run_kind`. Every existing posting
 * reads 'regular' through the column default, which is exactly how the month guard counted it before.
 * The schema pass ran first, but `CREATE TABLE IF NOT EXISTS` does not add a column to an existing
 * table, so the ALTER is this step's job; a book that already has the column (born on this build) is
 * left as it is.
 */
function wageRunKind(db: Database): void {
  // One-table probe (the table-enumeration chokepoint admits exactly this shape).
  const probe = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
  if (probe.get('wage_journal_posts') === undefined) throw new Error('generation 14: wage_journal_posts is missing');
  if (!hasColumn(db, 'wage_journal_posts', 'run_kind')) db.exec(D173_RUN_KIND_DDL);
  if (!hasColumn(db, 'wage_journal_posts', 'run_kind')) throw new Error('generation 14: run_kind is missing after the ALTER');
}

/**
 * Generation 15 (D175, 15.10.2026): Buchungsregeln. DDL only, no row is read or rewritten. The four recipe
 * columns on `bank_standard` and the widened one-live index `bank_standard_one_live_rule` are created by the
 * shape pass before any data step (ADDITIVE_COLUMNS, ADDITIVE_INDEXES); this step retires D167's narrower
 * index, which would refuse a counterparty's second live rule (one with a match text beside the text-less
 * one), and then checks its work: the four columns and the new index present, the old index gone.
 * Idempotent.
 */
function bankRuleRecipes(db: Database): void {
  db.exec('DROP INDEX IF EXISTS bank_standard_one_live');
  const columns = new Set((db.pragma('table_info(bank_standard)') as { name: string }[]).map((c) => c.name));
  for (const needed of ['label', 'match_text', 'legs_json', 'via_account_id']) {
    if (!columns.has(needed)) throw new Error(`generation 15: bank_standard.${needed} is missing after the shape pass`);
  }
  // The table's own index list (a PRAGMA, not a catalogue enumeration: the table chokepoint's rule).
  const indexes = new Set((db.pragma('index_list(bank_standard)') as { name: string }[]).map((i) => i.name));
  if (!indexes.has('bank_standard_one_live_rule')) throw new Error('generation 15: the index bank_standard_one_live_rule is missing');
  if (indexes.has('bank_standard_one_live')) throw new Error('generation 15: the D167 index bank_standard_one_live is still present');
  // Critic D175-C5: the decision row names the rule a line was booked by.
  const decision = new Set((db.pragma('table_info(bank_line_decision)') as { name: string }[]).map((c) => c.name));
  if (!decision.has('rule_id')) throw new Error('generation 15: bank_line_decision.rule_id is missing after the shape pass');
}

/**
 * Generation 16 (D176, 15.10.2026): manual Vorlagen, the "Nicht buchen" outcome and the follow-up. DDL only,
 * no row is read or rewritten: the five columns on `bank_standard` arrive through the shape pass
 * (ADDITIVE_COLUMNS) with defaults that read every existing row as the bank rule with legs it was, and the
 * trigger `bank_standard_outcome_frozen` rides the banking DDL. A manual Vorlage is keyed
 * `vorlage:<folded label>`, so "one live Vorlage per label" is the generation-15 one-live index; this step
 * checks its work through the table's own pragmas (never a catalogue enumeration): the five columns
 * present, and the one-live index present, because the Vorlage keying relies on it. Idempotent.
 */
function bankVorlagen(db: Database): void {
  const columns = new Set((db.pragma('table_info(bank_standard)') as { name: string }[]).map((c) => c.name));
  for (const needed of ['scope', 'outcome', 'ignore_reason', 'ignore_note', 'follow_up_standard_id']) {
    if (!columns.has(needed)) throw new Error(`generation 16: bank_standard.${needed} is missing after the shape pass`);
  }
  const indexes = new Set((db.pragma('index_list(bank_standard)') as { name: string }[]).map((i) => i.name));
  if (!indexes.has('bank_standard_one_live_rule')) throw new Error('generation 16: the index bank_standard_one_live_rule is missing');
}

/**
 * Generation 17 (D178 point 2, the Belegnummer, A02 §4b.4): number every posted entry of every workspace
 * that has no number yet, through the SAME catch-up the posting chokepoint runs
 * (`numberUnnumberedEntries`, `core/ledger/entryNumber.ts`), under the settings in force in that workspace
 * (an override row if one exists, else the registry default `continue_migrated`, which adopts a migrated
 * entry's plain-integer ref and numbers every other entry after the highest, in (date, created_at, rowid)
 * order).
 *
 * Why a generation and not a lazy start at the first post: the numbers are there the moment the upgraded
 * book opens, and an older build is refused the book (it would post entries without a number and without
 * the catch-up marker). Idempotent: an entry that has a number is never numbered again, so a second run, or
 * a run after a crash (the whole step commits with the version bump), writes nothing. The tables ride the
 * schema pass; the step re-creates them (IF NOT EXISTS) and checks they are there first.
 */
function belegnummerBackfill(db: Database): void {
  db.exec(ENTRY_NUMBER_SCHEMA_SQL);
  // One-table probes (the table-enumeration chokepoint admits exactly this shape).
  const probe = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
  for (const needed of ['journal_entry_number', 'journal_numbering_pending', 'journal_number_withheld']) {
    if (probe.get(needed) === undefined) throw new Error(`generation 17: ${needed} is missing after the numbering DDL`);
  }
  const at = new Date().toISOString();
  const workspaces = db.prepare('SELECT id FROM workspace ORDER BY id').all() as { id: string }[];
  for (const ws of workspaces) {
    const scope = { db, workspaceId: ws.id, at, ids: systemIdGen };
    // Rule a (A02 §4b.3) holds inside the catch-up: a book holding only migration postings (imports and the
    // reversals correcting them) keeps them waiting for its first native booking.
    numberUnnumberedEntries(scope, numberingConfigOf(scope));
  }
}

/**
 * Generation 18 (D178 point 19, the E2 re-cut, A20 §11.4). The tables, the append-only and chokepoint
 * triggers and the movement-key index arrive with the base schema (IF NOT EXISTS) and `coverage` with the
 * shape pass; this step checks they did, and backfills the one stored fact coverage reads that history may
 * lack: a statement's PERIOD. A camt without `FrToDt` stored no `from_date`/`to_date`; its period is its
 * lines' first and last date (booking, else value). The movement key needs no backfill: it is an expression
 * over each line's own columns (booking date, else value date; direction; amount; currency), indexed, so
 * every stored line already has it. No line, answer or decision is rewritten.
 */
function possibleDuplicateCoverage(db: Database): void {
  // One-table (one-trigger) probes: the table-enumeration chokepoint admits exactly this shape.
  const probe = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
  for (const needed of ['bank_txn_possible_duplicate', 'bank_txn_duplicate_candidate', 'bank_txn_duplicate_decision']) {
    if (probe.get(needed) === undefined) throw new Error(`generation 18: the table ${needed} is missing after the base schema`);
  }
  const triggerProbe = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?");
  for (const needed of ['bank_line_decision_duplicate_pending', 'bank_txn_duplicate_decision_no_update', 'bank_txn_duplicate_decision_no_delete']) {
    if (triggerProbe.get(needed) === undefined) throw new Error(`generation 18: the trigger ${needed} is missing after the base schema`);
  }
  const columns = new Set((db.pragma('table_info(bank_statement)') as { name: string }[]).map((c) => c.name));
  if (!columns.has('coverage')) throw new Error('generation 18: bank_statement.coverage is missing after the shape pass');
  db.exec(`
    UPDATE bank_statement
       SET from_date = (SELECT MIN(COALESCE(t.booking_date, t.value_date)) FROM bank_txn t WHERE t.workspace_id = bank_statement.workspace_id AND t.statement_id = bank_statement.id)
     WHERE from_date IS NULL;
    UPDATE bank_statement
       SET to_date = (SELECT MAX(COALESCE(t.booking_date, t.value_date)) FROM bank_txn t WHERE t.workspace_id = bank_statement.workspace_id AND t.statement_id = bank_statement.id)
     WHERE to_date IS NULL;
  `);
}

export const DATA_MIGRATIONS: readonly DataMigration[] = [
  {
    generation: 1,
    name: 'fx-rate-scale: rebuild exchange_rate.rate_scaled from the canonical rate string',
    apply: rescaleExchangeRates,
  },
  {
    generation: 2,
    name: 'creditor-iban: carry workspace.qr_iban into workspace.creditor_iban and retire the old name',
    apply: renameQrIbanToCreditorIban,
  },
  {
    generation: 3,
    name: 'draft-base-currency: denominate stored draft lines in their workspace base currency',
    apply: denominateDraftsInBaseCurrency,
  },
  {
    generation: 4,
    name: 'journal-line-currency: rebuild journal_line without the CHF default, triggers and rowids intact',
    apply: dropJournalLineCurrencyDefault,
  },
  {
    generation: 5,
    name: 'saldo-generations: lift vat_saldo_rate into the approval history and drop the old name',
    apply: liftSaldoRatesIntoGenerations,
  },
  {
    generation: 6,
    name: 'denylist-rules: disable stored automation rules whose action is no longer automatable',
    apply: disableDeniedAutomationRules,
  },
  {
    generation: 7,
    name: 'a38-seed-accounts: add 2330, 3809 and 8900 to every workspace born before A38 seeded them',
    apply: seedA38Accounts,
  },
  {
    generation: 8,
    name: 'a39-bank-inbox: adopt pre-A39 bank-line decisions once and disable rules on newly denied verbs',
    apply: adoptPreA39BankDecisions,
  },
  {
    generation: 9,
    name: 'a18-frozen-references: freeze MsgId/PmtInfId/InstrId/EndToEndId at the values the XML carried, then index and lock them',
    apply: freezePain001References,
  },
  {
    generation: 10,
    name: 'd163-contact-terms: make contact.payment_terms_days nullable and read every stored 0 as no terms of its own',
    apply: nullableContactPaymentTerms,
  },
  {
    generation: 11,
    name: 'd167-input-codes: give every workspace holding tax codes the reduced-rate input codes VST-M26, VST-M38, VST-I26 and VST-I38',
    apply: seedD167InputCodes,
  },
  {
    generation: 12,
    name: 'd170-live-disposal: drop the one-disposal unique index; the live-disposal trigger in the schema replaces it',
    apply: liveDisposalGuard,
  },
  {
    generation: 13,
    name: 'd172-workspace-settings: create workspace_setting and the append-only workspace_setting_change history',
    apply: workspaceSettingsTables,
  },
  {
    generation: 14,
    name: 'd173-wage-run-kind: add wage_journal_posts.run_kind (regular, bonus, thirteenth, correction); every existing posting reads regular',
    apply: wageRunKind,
  },
  {
    generation: 15,
    name: 'd175-bank-rules: retire the D167 one-live index on bank_standard; the recipe columns and the text-aware index ride the shape pass',
    apply: bankRuleRecipes,
  },
  {
    generation: 16,
    name: 'd176-bank-vorlagen: bank_standard gains scope, outcome, the ignore reason and note and the follow-up Vorlage; every existing row reads as before',
    apply: bankVorlagen,
  },
  {
    generation: 17,
    name: 'd178-belegnummer: number every posted entry that has none (continue_migrated adopts a migrated plain-integer ref); a second run writes nothing',
    apply: belegnummerBackfill,
  },
  {
    generation: 18,
    name: 'd178-possible-duplicates: the duplicate tables, answers append-only, the chokepoint trigger on bank_line_decision, the movement-key index; every statement keeps a period',
    apply: possibleDuplicateCoverage,
  },
];
