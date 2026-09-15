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
];
