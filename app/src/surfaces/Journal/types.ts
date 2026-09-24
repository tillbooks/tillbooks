/**
 * Shapes for the A02 journal surface, mirroring the engine read models (`src/core/ledger/reads.ts`)
 * and the picker reads (`list_accounts`, `vat_codes`, `list_cost_centers`). Re-declared, never
 * imported, so the browser bundle never touches engine code (same discipline as `lib/client.ts`).
 */

/**
 * §H-FX on a journal-list row: what the BOOKS hold, beside what the transaction was.
 *
 * Three shapes, and all three are real. The engine gates the group on A02's
 * `statesConversionBasis` (`src/core/ledger/reads.ts`, `mapJournalEntry`), which asks only whether
 * the entry's currency differs from the workspace base currency. So:
 *
 *  1. An entry already in the base currency states no basis: none of the three keys are sent.
 *     Restating a franc total as a franc "base total" is noise on the overwhelming majority of
 *     entries, and it is the same mistake as stamping a literal rate of 1 on every franc row.
 *  2. A foreign entry that has not posted knows the currency the books will convert INTO, but no
 *     rate has been stamped, so `baseCurrency` arrives while both figures are null. A type saying
 *     "all three or none" would be a lie about it, and would render a base total of `null`.
 *  3. A posted foreign entry carries all three, including at a rate of exactly 1, because parity is
 *     a stated basis and not the absence of one.
 *
 * The union makes the pairing structural rather than conventional: `baseTotal` and `fxRate` are both
 * figures the POSTING stamped, so there is no arm in which one exists without the other, and none in
 * which either exists without the currency that denominates it. `listedBaseTotal` in `./money` is the
 * runtime half of the same guarantee, because the wire is JSON and a type is only a promise.
 *
 * The names are `list_journal`'s own and deliberately NOT `list_documents`'s `totalBaseMinor`: the
 * journal read model pairs `total` with `baseTotal` the way it pairs `debit` with `baseDebit`. Both
 * are optional on both read models, so a mis-copied name is `undefined` at runtime with no type
 * error. `test/ledger/journal-list-fx-fixture.test.mjs` fails on either.
 */
export type JournalEntryFx =
  | { baseCurrency?: undefined; baseTotal?: undefined; fxRate?: undefined }
  | { baseCurrency: string; baseTotal: null; fxRate: null }
  | { baseCurrency: string; baseTotal: number; fxRate: string };

/** A journal-entry header as returned by `list_journal` and inside `get_entry`. */
export type JournalEntry = {
  id: string;
  date: string;
  ref: string | null;
  description: string | null;
  status: string;
  source: string;
  reversesEntryId: string | null;
  /**
   * Who posted or drafted the entry, and when, from the entry HEADER (`reads.ts`, `mapEntry` sends
   * `createdBy`/`createdAt` on both `get_entry` and `list_journal`). C3 reads these for the quiet
   * provenance line on the entry detail. `createdBy` is null when the read did not name a seat (an
   * imported or system row); both are optional on this TYPE for a client-composed row that never
   * reached the engine. Never fabricated: the line is skipped when `createdAt` is absent.
   */
  createdBy?: string | null;
  createdAt?: string | null;
  /**
   * Entry total in minor units, the SUM of the debit legs (`reads.ts`, `total_minor`). It is the
   * TRANSACTION amount, so on a foreign-currency entry it is not Rappen. `currency` beside it is
   * what makes it a figure rather than a bare integer.
   */
  total?: number | null;
  /**
   * The currency `total` is denominated in, derived by the engine from the entry's own lines.
   *
   * NULLABLE, and that is not a formality: a currency is a property of the ROWS, so an entry with no
   * lines has none and the engine reports null rather than guessing the base currency. Rendering
   * money for such a row would put a denominated zero on screen that nobody entered. Absent on a
   * client-composed row that has never been near the engine.
   */
  currency?: string | null;
} & JournalEntryFx;

/**
 * A posted or draft line as returned inside `get_entry`. Amounts are integer minor units.
 *
 * §H-FX put three facts on every row and the client has to keep them apart. `debit`/`credit` are
 * what the TRANSACTION was, denominated in `currency`. `baseDebit`/`baseCredit` are what the BOOKS
 * hold, always in the workspace base currency. `fxRate` is what turned one into the other, and it is
 * null for a base-currency line on purpose: a rate of 1 is not FX, and stamping one would make every
 * CHF row look converted. Rendering `debit` with a hardcoded CHF, which is what this surface did,
 * puts a EUR figure on screen under a CHF label: the wrong number and the wrong unit at once.
 */
export interface EntryLine {
  id?: string;
  entryId?: string;
  account: string;
  costCenter?: string | null;
  debit?: number | null;
  credit?: number | null;
  /** The transaction currency of this line. Absent on a client-composed draft line. */
  currency?: string | null;
  baseDebit?: number | null;
  baseCredit?: number | null;
  /**
   * The currency `baseDebit` / `baseCredit` are denominated in: what the BOOKS hold.
   *
   * Sent unconditionally by `get_entry` (`reads.ts`, `mapLine`), on a base-currency line too,
   * because the figure it names is always there. Optional on this TYPE only for a client-composed
   * row that has never been near the engine. Reading it here rather than reaching for
   * `get_company_profile` is the point: the label now arrives in the same response as the number,
   * so the two cannot come apart, which is exactly how a posted EUR-base entry once read
   * "is CHF 860.00 in the books".
   */
  baseCurrency?: string | null;
  /** The canonical decimal rate as a STRING (never a float), or null for a base-currency line. */
  fxRate?: string | null;
  taxCode?: string | null;
  taxBase?: number | null;
  taxAmount?: number | null;
}

/** A chart-of-accounts row for the per-line account picker (`list_accounts`). */
export interface Account {
  id: string;
  number: string;
  name: string;
}

/** A tax code for the per-line tax picker (`vat_codes`), the full engine `listTaxCodes` row. */
export interface TaxCode {
  code: string;
  kind: string;
  rateBp: number;
  formLine: string | null;
  label: string;
  active: boolean;
}

/** A cost centre for the per-line cost-centre picker (`list_cost_centers`). */
export interface CostCenter {
  id: string;
  code: string;
  name: string;
}

/** How the drawer is opened: composing new, editing a draft, or viewing a posted entry. */
export type DrawerMode = 'create' | 'edit' | 'view';
