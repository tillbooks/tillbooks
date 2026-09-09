/**
 * A02 read models (Pattern P5): `getEntry` and `listJournal`. Pure computed reads, no write twin.
 * This is the one place journal rows cross the persistence boundary, so it is where snake_case DB
 * columns become the camelCase interface.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString, optionalText } from './inputGuards.js';
import { statesConversionBasis } from './postEntry.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { applySavedView } from '../customization/views.js';

interface EntryRow {
  id: string;
  workspace_id: string;
  date: string;
  ref: string | null;
  description: string | null;
  status: string;
  reverses_entry_id: string | null;
  idempotency_key: string | null;
  source: string;
  created_by: string | null;
  created_at: string;
}

interface LineRow {
  id: string;
  entry_id: string;
  account_id: string;
  cost_center_id: string | null;
  debit_minor: number;
  credit_minor: number;
  currency: string;
  base_debit_minor: number;
  base_credit_minor: number;
  fx_rate: string | null;
  tax_code: string | null;
  tax_base_minor: number | null;
  tax_amount_minor: number | null;
}

/**
 * The entry HEADER as every read model publishes it: the one place snake_case becomes camelCase.
 *
 * Named rather than inferred because `GetEntryOk` and `ListJournalOk` below are what the Studio and
 * the MCP layer read, and a payload built out of anonymous inferred shapes is a payload nobody can
 * name in a signature. The declaration is what makes a renamed column a compile error at the reader
 * instead of an `undefined` on screen.
 */
export type JournalEntryView = {
  readonly id: string;
  readonly workspaceId: string;
  readonly date: string;
  readonly ref: string | null;
  readonly description: string | null;
  readonly status: string;
  readonly reversesEntryId: string | null;
  readonly idempotencyKey: string | null;
  readonly source: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
};

/** One journal line as `get_entry` publishes it, with BOTH money pairs denominated (see `mapLine`). */
export type JournalLineView = {
  readonly id: string;
  readonly entryId: string;
  readonly account: string;
  readonly costCenter: string | null;
  readonly debit: number;
  readonly credit: number;
  readonly currency: string;
  readonly baseDebit: number;
  readonly baseCredit: number;
  readonly baseCurrency: string;
  readonly fxRate: string | null;
  readonly taxCode: string | null;
  readonly taxBase: number | null;
  readonly taxAmount: number | null;
};

/**
 * One row of the journal list: the header, its computed total, and the §H-FX group when the entry
 * states a conversion basis.
 *
 * The three FX fields are OPTIONAL rather than nullable, which is the same distinction `PostEntryOk`
 * draws and for the same reason: "absent" is what a caller actually observes on a base-currency
 * entry, and `mapJournalEntry` omits the group rather than nulling it. `baseTotal` and `fxRate` are
 * additionally NULLABLE inside that group, because a foreign entry that has not posted yet has the
 * label and neither figure (the SQL fences both to `status = 'posted'`).
 */
export type JournalListEntry = JournalEntryView & {
  readonly total: number;
  readonly currency: string | null;
  readonly baseTotal?: number | null;
  readonly fxRate?: string | null;
  readonly baseCurrency?: string;
};

function mapEntry(row: EntryRow): JournalEntryView {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    date: row.date,
    ref: row.ref,
    description: row.description,
    status: row.status,
    reversesEntryId: row.reverses_entry_id,
    idempotencyKey: row.idempotency_key,
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * A journal-list row: the entry header, its computed total, and the §H-FX trace its own lines carry.
 *
 * All four computed columns are DERIVED from `journal_line` at read time and none is persisted
 * beside the header, the same discipline A10's `DOCUMENT_SELECT` follows. A stored copy of a
 * converted total is a second source of truth that can disagree with the ledger, and deriving makes
 * that disagreement unrepresentable rather than merely unlikely.
 */
interface JournalListRow extends EntryRow {
  total_minor: number;
  currency: string | null;
  base_total_minor: number | null;
  fx_rate: string | null;
}

/**
 * A journal-list entry: the header fields, `total`, and what that total is DENOMINATED IN.
 *
 * `total` is the entry's amount in integer minor units, the SUM of its debit legs. For a balanced
 * entry the debit-leg sum equals the credit-leg sum, so summing the debit legs is the entry's
 * magnitude. A header with no lines totals 0.
 *
 * ## Why `currency` is here at all
 *
 * `total` is the TRANSACTION amount, so on a EUR entry it is not Rappen. Sending it as a bare
 * integer left every client with two options and no third: hardcode a currency, which puts a EUR
 * figure on screen under a CHF label, or fire a `get_entry` per row and convert. Both are the client
 * inventing money, and the Studio journal list carried a written KNOWN GAP rather than pick one.
 * The label belongs beside the number, so it is UNCONDITIONAL: a base-currency entry gets it too.
 *
 * `null` when the entry has no lines. A currency is a property of the ROWS, and an empty draft has
 * none; reporting the base currency there would be the engine making exactly the guess the Studio
 * was refusing to make. A denominated zero is a claim about a zero nobody entered.
 *
 * One currency per entry is a FACT, not an average. `writePostedEntry` stamps one `fx.currency` and
 * one rate on every row it writes, from a single per-ENTRY `currency` input (a per-line currency is
 * not part of `LineInput`); promotion deletes and rewrites the whole line set; `saveDraft` writes one
 * literal for all its rows; and nothing else inserts into `journal_line`. So the first row speaks for
 * the entry, and `test/ledger/journal-list-fx.test.mjs` holds that up over every entry it writes.
 *
 * ## Why the FX group is conditional, and on WHAT
 *
 * `baseTotal` / `fxRate` / `baseCurrency` appear only when the entry states a conversion basis. That
 * predicate is A02's `statesConversionBasis`, imported rather than re-derived, because two copies of
 * this rule is precisely how the pegged case desynchronised before (§H-FX,
 * docs/specs/03-fx-foundation.md section 13). It asks about the CURRENCY and nothing else: a foreign
 * entry states its basis even at a rate of exactly 1, and a base-currency entry states none, because
 * `total` already IS what the books hold and restating it under an identical `baseCurrency` would be
 * noise on the overwhelming majority of entries.
 *
 * The one asymmetry worth naming, and it is the same one `mapDocument` carries: the LABEL is known
 * from the entry's rows, while the FIGURES exist only once something has posted. `saveDraft` writes
 * `base_debit_minor` as a literal copy of `debit_minor` with no rate behind it, so the SQL fences
 * both figures to `status = 'posted'`: summing a draft's copy and calling it a base total would
 * report a conversion that never happened. A foreign entry that has not posted therefore reports
 * `baseCurrency` with both figures null, which is a real arm and not a transitional one.
 *
 * `fxRateAsOf` is deliberately absent, as on the document read model: `journal_line` keeps the rate
 * STRING and the base amounts, and no `rate_as_of` column exists on either journal table. Reporting
 * one would mean re-resolving it from the mutable `exchange_rate` store at read time, and a rate
 * imported later would hand back a validity date that never priced this entry.
 *
 * The names follow this file rather than `list_documents`: `total` pairs with `baseTotal` the way
 * `debit` pairs with `baseDebit` in `mapLine` two functions down. `list_documents` says
 * `totalBaseMinor` because its transaction figure is `totalMinor`. Both are internally consistent;
 * neither should be "fixed" into the other without renaming its partner too.
 */
function mapJournalEntry(row: JournalListRow, baseCurrency: string): JournalListEntry {
  const currency = row.currency;
  return {
    ...mapEntry(row),
    total: row.total_minor,
    currency,
    ...(currency !== null && statesConversionBasis({ currency, baseCurrency })
      ? {
          baseTotal: row.base_total_minor ?? null,
          fxRate: row.fx_rate ?? null,
          baseCurrency,
        }
      : {}),
  };
}

/**
 * One journal line, with BOTH of its money pairs denominated.
 *
 * `currency` names `debit` / `credit`, the TRANSACTION amounts. `baseCurrency` names `baseDebit` /
 * `baseCredit`, what the BOOKS hold. Sending the second pair without its label is what this
 * function used to do, and it is the same defect class `mapJournalEntry` was written to end: a
 * response carrying a figure whose unit is not in the response leaves a client two options and no
 * third, hardcode a currency or fire a second verb, and both are the client inventing money. The
 * Studio's Journal drawer took the first and printed "USD 1'000.00 at rate 0.86 is CHF 860.00 in
 * the books" on an immutable EUR-base record.
 *
 * UNCONDITIONAL, unlike `mapJournalEntry`'s FX group, and the asymmetry is not an inconsistency.
 * `list_journal` omits `baseTotal` / `fxRate` / `baseCurrency` on a base-currency entry because
 * those three figures are genuinely absent there and restating an identical total under an
 * identical code would be noise on nearly every entry. Here `baseDebit` and `baseCredit` are
 * ALWAYS on the line, posted or draft, foreign or not, so a label for them is always owed;
 * conditioning it would hand a bare integer to a client on exactly the entries it is most likely
 * to render without checking.
 *
 * `baseCurrencyOf` is the only honest source and it is a fact rather than today's setting for
 * anything posted: `needs_empty_ledger` in `updateWorkspace` locks `workspace.base_currency` the
 * moment a line exists, so for a posted entry it is provably the currency the ledger converted
 * into. A DRAFT's `base_debit_minor` is a literal copy of `debit_minor` rather than a conversion,
 * which is why `mapJournalEntry` fences the journal-list FIGURES to `status = 'posted'`; the label
 * needs no such fence, because `saveDraft` writes `baseCurrencyOf(ctx)` as the row currency too, so
 * on a draft the copy and its label are the same money.
 */
function mapLine(row: LineRow, baseCurrency: string): JournalLineView {
  return {
    id: row.id,
    entryId: row.entry_id,
    account: row.account_id,
    costCenter: row.cost_center_id,
    debit: row.debit_minor,
    credit: row.credit_minor,
    currency: row.currency,
    baseDebit: row.base_debit_minor,
    baseCredit: row.base_credit_minor,
    baseCurrency,
    fxRate: row.fx_rate,
    taxCode: row.tax_code,
    taxBase: row.tax_base_minor,
    taxAmount: row.tax_amount_minor,
  };
}

/**
 * What `get_entry` sends back: the header and its lines, both named types.
 *
 * The Studio's Journal drawer is the surface that rendered "1000 undefined" in a live browser with
 * its unit test green, which is what an open `Result` buys: `result.entry` and `result.lines` were
 * `unknown`, so every field the drawer read off them was answered by an index signature rather than
 * by the engine. Declared, a field this payload does not carry is TS2339 at the drawer.
 */
export type GetEntryOk = {
  readonly entry: JournalEntryView;
  readonly lines: readonly JournalLineView[];
};

export function getEntry(ctx: WorkspaceContext, input: { entryId: string }): Result<GetEntryOk> {
  const guard = requireString(input.entryId, 'entryId');
  if (guard) return guard;

  const row = ctx.store.db
    .prepare('SELECT * FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.entryId) as EntryRow | undefined;
  if (row === undefined) {
    return err('not_found', { entryId: input.entryId });
  }
  const lines = ctx.store.db
    .prepare('SELECT * FROM journal_line WHERE entry_id = ? ORDER BY rowid')
    .all(input.entryId) as LineRow[];
  // Read ONCE for the whole entry, as `listJournal` does for the whole list: the base currency is a
  // workspace fact, not a per-row one. The label rides the LINE because the figure it denominates
  // does; an entry with no lines therefore states no base currency at all, which is the same answer
  // `list_journal` gives an empty entry and for the same reason. Denominating a zero nobody entered
  // would be the engine making exactly the guess the label exists to stop.
  const baseCurrency = baseCurrencyOf(ctx);
  return ok({ entry: mapEntry(row), lines: lines.map((line) => mapLine(line, baseCurrency)) });
}

export interface JournalFilter {
  from?: string;
  to?: string;
  account?: string;
  source?: string;
  status?: string;
  savedViewId?: string;
}

/** What `list_journal` sends back: the matching entries, newest first. */
export type ListJournalOk = {
  readonly entries: readonly JournalListEntry[];
};

export function listJournal(ctx: WorkspaceContext, filter: JournalFilter = {}): Result<ListJournalOk> {
  // The G00 seam, one unconditional call, exactly as `listDocuments` makes it (F5 retrofit: the
  // `journal_entry` kind could store views that no verb applied).
  const viewed = applySavedView(ctx, 'journal_entry', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;
  const guard =
    optionalText(filter.from, 'from') ??
    optionalText(filter.to, 'to') ??
    optionalText(filter.account, 'account') ??
    optionalText(filter.source, 'source') ??
    optionalText(filter.status, 'status');
  if (guard) return guard;

  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.from !== undefined) {
    clauses.push('date >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('date <= ?');
    params.push(filter.to);
  }
  if (filter.source !== undefined) {
    clauses.push('source = ?');
    params.push(filter.source);
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.account !== undefined) {
    clauses.push('id IN (SELECT entry_id FROM journal_line WHERE account_id = ?)');
    params.push(filter.account);
  }
  // §H-FX, derived per row and never persisted (see `mapJournalEntry`):
  //  - `currency` off the entry's first line, which speaks for all of them because one write stamps
  //    one currency on the whole entry. NULL when the entry has no lines.
  //  - `base_total_minor` and `fx_rate` only from POSTED rows. A draft's `base_debit_minor` is a
  //    literal copy of `debit_minor` written with no rate behind it, so summing it would report a
  //    conversion that never happened; the correlated `journal_entry.status` fence makes the
  //    subquery match nothing and hand back NULL instead.
  //  - the rate is taken off the rows rather than re-resolved, for the same reason A10 does it: a
  //    rate imported after the fact would otherwise reprice an entry that is already in the books.
  const rows = ctx.store.db
    .prepare(
      `SELECT journal_entry.*,
              (SELECT COALESCE(SUM(debit_minor), 0)
                 FROM journal_line
                WHERE journal_line.entry_id = journal_entry.id) AS total_minor,
              (SELECT currency
                 FROM journal_line
                WHERE journal_line.entry_id = journal_entry.id
                ORDER BY rowid LIMIT 1) AS currency,
              (SELECT SUM(base_debit_minor)
                 FROM journal_line
                WHERE journal_line.entry_id = journal_entry.id
                  AND journal_entry.status = 'posted') AS base_total_minor,
              (SELECT fx_rate
                 FROM journal_line
                WHERE journal_line.entry_id = journal_entry.id
                  AND journal_entry.status = 'posted'
                  AND fx_rate IS NOT NULL
                ORDER BY rowid LIMIT 1) AS fx_rate
         FROM journal_entry
        WHERE ${clauses.join(' AND ')}
        ORDER BY date DESC, created_at DESC, id DESC`,
    )
    .all(...params) as JournalListRow[];
  // Read ONCE for the whole list, not per row: the base currency is a workspace fact, and it is
  // locked the moment anything posts (`needs_empty_ledger` in updateWorkspace), so for a posted
  // entry it is provably the currency the ledger converted into and not merely today's setting.
  const baseCurrency = baseCurrencyOf(ctx);
  return ok({ entries: rows.map((row) => mapJournalEntry(row, baseCurrency)) });
}
