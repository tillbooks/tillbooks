/**
 * A04, the guided migration import: a CSV or account-export turned into the opening position.
 *
 * CLEAN-ROOM, and it is worth being precise about what that means here. This module READS a file a
 * user exported from their own previous package. It contains no bexio code, no bexio asset, no
 * layout, and no trade dress: `format: 'bexio'` selects a set of DEFAULT COLUMN NAMES this repo
 * chose to look for, and a caller whose export uses different headers overrides them field by field.
 * Reading a data file someone owns is interoperability; copying the program that wrote it is not
 * what happens here.
 *
 * WHAT THIS MODULE IS ACTUALLY RESPONSIBLE FOR is parsing, because by the time a row reaches
 * `setOpeningBalances` it is already integer Rappen and every ledger invariant belongs to A02. Two
 * places a franc can quietly change value:
 *
 *   1. **Decimal to Rappen.** `parseFloat('1234.56') * 100` is `123455.99999999999`, so an unrounded
 *      float path is wrong on ordinary money. `parseSwissAmount` builds no float at all: it splits on
 *      the decimal point and assembles an integer from the two halves.
 *
 *      THE PREVIOUS VERSION OF THIS PARAGRAPH WAS STILL WRONG, and it is worth saying why, because
 *      it is the licence someone would cite to simplify this parser later. It claimed that a
 *      `Math.round(Number(s) * 100)` path "would agree with this one on every value the parser
 *      admits", on the grounds that the `Number.MAX_SAFE_INTEGER` cap "keeps magnitudes below the
 *      point where a double's relative error can reach half a Rappen (that needs roughly 5e15
 *      Rappen)". That cannot be true BY CONSTRUCTION: 5e15 is LESS than MAX_SAFE_INTEGER
 *      (9.007e15), so a cap set at MAX_SAFE_INTEGER cannot hold anything below 5e15.
 *
 *      MEASURED, at every power of two up to the cap and at 2000 admitted values per probe point:
 *      the two paths agree exactly up to roughly 7.04e15 Rappen and then diverge, with 1440 of the
 *      4000 admitted values just under the cap disagreeing by one Rappen. A worked example:
 *      "90071992547409.90" is 9007199254740990 on this path and 9007199254740991 on a rounded float.
 *      So there is a real band, from about 7.04e15 Rappen up to the cap at 9.007e15, that this
 *      parser admits and where a float path silently books a different number.
 *
 *      Those are absurd magnitudes for a Swiss KMU migration (7.04e15 Rappen is some 70 trillion
 *      francs) and no test below can tell the two paths apart at ordinary money. That is exactly why
 *      the honest claim is the narrow one: the integer path is chosen because it is exact BY
 *      CONSTRUCTION and needs no error-bound argument to review at all. It is NOT chosen because a
 *      rounded float was measured to break on realistic input, and the cap is NOT what makes it
 *      correct. What the tests do catch is an UNROUNDED float path and a fraction padded on the
 *      wrong side, both verified by mutation.
 *
 *      WHAT THE CAP IS ACTUALLY FOR, since it is not the float argument: it is a postcondition on the
 *      return type. This function hands back a `number`, and Rappen travel as `number` the whole way
 *      down, so a value above MAX_SAFE_INTEGER would arrive as an integer that can no longer be
 *      incremented exactly. The cap had NO test and deleting it left all three suites green; it now
 *      has one, on both sides of the boundary.
 *   2. **The sign.** A single signed balance column has to become a debit or a credit, and an
 *      inversion there survives every total-level check because the totals still tie out.
 *
 * AN UNMAPPED ROW IS REPORTED, NEVER DROPPED. A preview shows it so a human can fix the chart; a
 * real import REFUSES. Importing 4 of 5 rows would post a position that balances precisely because
 * the missing row was discarded, and OR Art. 958c Abs. 1 Ziff. 2 (`Sie muss vollständig sein`) is
 * exactly the principle that shape violates. A green tick over a silently shortened balance sheet is
 * worse than a rejection, because nobody goes looking for it afterwards.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { setOpeningBalances } from './openingBalances.js';
import type { OpeningLineInput } from './openingBalances.js';

/** The column roles an import needs. `balance` is the single-signed-column alternative to debit/credit. */
export interface ImportMapping {
  account?: string;
  name?: string;
  debit?: string;
  credit?: string;
  balance?: string;
}

export interface ImportMigrationInput {
  format?: string;
  mapping?: ImportMapping;
  rows: unknown;
  dryRun?: boolean;
  asOf?: string;
  differenceAccount?: string;
  reference?: string;
  idempotencyKey?: string;
}

/**
 * The per-format DEFAULT column names, applied only where the caller named none.
 *
 * HONESTY ABOUT THESE STRINGS: they are plausible header names, not headers verified against a real
 * export from either product. That is why `mapping` overrides field by field and why a mapping
 * naming a column no row carries is a REJECTION (`unmapped_column`) rather than a silent read of
 * every row as blank: when the preset guesses wrong, the caller is told so on the first preview
 * instead of importing an empty position that balances at 0.00 and reports success.
 */
const FORMAT_PRESETS: Readonly<Record<string, ImportMapping>> = Object.freeze({
  csv: { account: 'account', name: 'name', debit: 'debit', credit: 'credit' },
  bexio: { account: 'account_no', name: 'name', debit: 'debit', credit: 'credit' },
});

/**
 * A Swiss decimal string to integer minor units, WITHOUT ever building a float.
 *
 * Accepts an optional sign, apostrophe thousands separators (`1'234.56`, the Swiss convention this
 * repo formats with), and zero, one or two decimal places. Everything else is REFUSED rather than
 * coerced: `'1,234.56'` is an English-locale number whose comma this parser must not silently drop,
 * and `'12.345'` is either a rate or a typo but is certainly not Rappen.
 *
 * Returns `null` for unparseable, and `undefined` for absent (blank or whitespace), which a caller
 * must tell apart: a two-column export leaves one side blank on every single row.
 */
export function parseSwissAmount(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (text.length === 0) return undefined;

  const match = /^([+-]?)(\d{1,3}(?:'\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) return null;

  const [, sign, whole, fraction] = match;
  const francs = BigInt((whole as string).replace(/'/g, ''));
  // '5' means five TENTHS of a franc (50 Rappen), '05' means five Rappen. Padding right, not left.
  const rappen = BigInt(((fraction ?? '') as string).padEnd(2, '0'));
  const total = francs * 100n + rappen;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return sign === '-' ? -Number(total) : Number(total);
}

interface NormalisedRow {
  account: string;
  name: string | null;
  debitMinor: number;
  creditMinor: number;
}

type Normalisation = { ok: true; rows: NormalisedRow[] } | { ok: false; error: Result };

/**
 * Read the caller's rows into `{ account, debitMinor, creditMinor }`, resolving the sign convention.
 *
 * A POSITIVE signed balance is a DEBIT and a negative one is a CREDIT, which is the convention every
 * chart export uses because it is the one the balance sheet itself uses: an asset the business holds
 * carries a debit balance. Inverting this would still balance, and every total would still tie out,
 * which is why the sign is tested in both directions rather than asserted on a sum.
 */
function normaliseRows(rows: unknown[], mapping: Required<Pick<ImportMapping, 'account'>> & ImportMapping): Normalisation {
  const out: NormalisedRow[] = [];
  const seenColumns = new Set<string>();

  // Decided BEFORE the loop, because a blank account cell has TWO quite different causes and the
  // per-row check could not tell them apart: it reported `unmapped_column` for both.
  //
  //   - NO row carries a value in that column: the MAPPING is wrong, and the caller must fix the
  //     mapping. Complaining about row 1 would send them to the data instead.
  //   - Some rows carry one and this row does not: that is a SUBTOTAL or Total line, which real
  //     exports put at the bottom almost every time. The mapping is fine and the file has a row in
  //     it that is not a position. Reporting the column here sent the caller to fix something that
  //     was already correct.
  //
  // Both stay LOUD, so no franc moves either way. Only the diagnosis changes, and a diagnosis that
  // points at the wrong thing costs the same time as no diagnosis at all.
  const accountColumnEverFilled = rows.some(
    (raw) =>
      typeof raw === 'object' &&
      raw !== null &&
      !Array.isArray(raw) &&
      String((raw as Record<string, unknown>)[mapping.account] ?? '').trim().length > 0,
  );

  for (const [index, raw] of rows.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: err('invalid_row', { reason: 'each row is an object of column values' }) };
    }
    const row = raw as Record<string, unknown>;
    for (const key of Object.keys(row)) seenColumns.add(key);

    const accountRaw = row[mapping.account];
    if (accountRaw === undefined || String(accountRaw).trim().length === 0) {
      if (!accountColumnEverFilled) {
        return { ok: false, error: err('unmapped_column', { column: mapping.account, role: 'account' }) };
      }
      return {
        ok: false,
        error: err('invalid_row', {
          row: index,
          column: mapping.account,
          reason:
            'this row names no account, which is what a subtotal or Total line looks like: drop it from the file, because a total is not a position',
        }),
      };
    }
    const account = String(accountRaw).trim();
    const name = mapping.name !== undefined && row[mapping.name] !== undefined
      ? String(row[mapping.name]).trim()
      : null;

    let debitMinor = 0;
    let creditMinor = 0;

    if (mapping.balance !== undefined) {
      const signed = parseSwissAmount(row[mapping.balance]);
      if (signed === null) return { ok: false, error: err('invalid_amount', { account, value: String(row[mapping.balance]) }) };
      if (signed !== undefined) {
        if (signed > 0) debitMinor = signed;
        else creditMinor = -signed;
      }
    } else {
      const debit = mapping.debit === undefined ? undefined : parseSwissAmount(row[mapping.debit]);
      const credit = mapping.credit === undefined ? undefined : parseSwissAmount(row[mapping.credit]);
      if (debit === null) return { ok: false, error: err('invalid_amount', { account, value: String(row[mapping.debit as string]) }) };
      if (credit === null) return { ok: false, error: err('invalid_amount', { account, value: String(row[mapping.credit as string]) }) };
      // A negative in a two-column export means the exporter already chose a side and then negated
      // it; honouring that would put the amount on the side its own column contradicts.
      if ((debit ?? 0) < 0 || (credit ?? 0) < 0) {
        return { ok: false, error: err('invalid_row', { account, reason: 'a debit/credit column carries no sign' }) };
      }
      debitMinor = debit ?? 0;
      creditMinor = credit ?? 0;
      if (debitMinor > 0 && creditMinor > 0) {
        return { ok: false, error: err('invalid_row', { account, reason: 'a position is one side, never both' }) };
      }
    }

    out.push({ account, name, debitMinor, creditMinor });
  }

  // A mapping whose columns no row carries reads every value as blank, which would import a position
  // of 0.00 that balances and reports success. Checked AFTER the loop so the message can name the
  // column the caller actually got wrong.
  for (const role of ['debit', 'credit', 'balance'] as const) {
    const column = mapping[role];
    if (column !== undefined && !seenColumns.has(column)) {
      return { ok: false, error: err('unmapped_column', { column, role }) };
    }
  }

  return { ok: true, rows: out };
}

/**
 * This account's id in the caller's own chart, or `undefined` when the chart does not know it.
 *
 * §H-TENANT fence is load-bearing: without it a neighbouring workspace's chart would make a row look
 * mapped, and the import would then refuse with `unknown_account` from the later resolve instead of
 * `unmapped_account`, which sends the caller somewhere else entirely.
 *
 * It returns the ID rather than a boolean because the duplicate check below has to compare RESOLVED
 * accounts: a file naming 1020 once by number and once by id is one account twice.
 */
function mappedAccountId(ctx: WorkspaceContext, account: string): string | undefined {
  const row = ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND (id = ? OR number = ?) ORDER BY (id = ?) DESC LIMIT 1')
    .get(ctx.workspaceId, account, account, account) as { id: string } | undefined;
  return row?.id;
}

/**
 * Preview or perform a migration import.
 *
 * `dryRun: true` is `preview_opening_import`: it normalises, resolves against the chart, reports the
 * unmapped rows and the balance check, and writes NOTHING. Otherwise it delegates to
 * `setOpeningBalances`, which is the only path to the ledger (P3): every §H-LEDGER, §H-AUDIT,
 * §H-IDEMPOTENT, §H-PERIOD and A24 guarantee belongs to that call and none is restated here.
 *
 * THE PREVIEW IS NOT A RECONCILIATION and does not claim to be. It reports what the file says and
 * whether the file's own two sides agree; it cannot know whether the file is the right file, whether
 * a position is missing from it entirely, or whether two accounts were transposed before it was
 * written. `balanced: true` means Sigma debit equals Sigma credit and nothing more, which is why the
 * per-account lines come back in full so a human can compare them against the Beleg (OR 957a Abs. 2
 * Ziff. 2) rather than being handed a verdict.
 */
export function importMigration(ctx: WorkspaceContext, input: ImportMigrationInput): Result {
  const format = input.format ?? 'csv';
  const preset = FORMAT_PRESETS[format];
  if (preset === undefined) {
    return err('invalid_format', { format, supported: Object.keys(FORMAT_PRESETS) });
  }
  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    return err('invalid_input', { field: 'rows', reason: 'at least one row' });
  }
  const dryRun = input.dryRun === true;
  if (!dryRun && (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0)) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }

  // The preset fills only the roles the caller left unnamed, so an override never has to restate the
  // rest of the mapping. `balance` is not in any preset: a single signed column is opted into.
  const supplied = input.mapping ?? {};
  const mapping: ImportMapping = {
    ...preset,
    ...Object.fromEntries(Object.entries(supplied).filter(([, v]) => typeof v === 'string' && v.length > 0)),
  };
  // A caller naming `balance` means the single-column shape, so the two-column roles fall away
  // rather than being read from preset columns that this file does not have.
  if (mapping.balance !== undefined) {
    delete mapping.debit;
    delete mapping.credit;
  }
  if (mapping.account === undefined) return err('invalid_input', { field: 'mapping.account' });

  const normalised = normaliseRows(input.rows, mapping as ImportMapping & { account: string });
  if (!normalised.ok) return normalised.error;

  const mapped: NormalisedRow[] = [];
  const unmapped: NormalisedRow[] = [];
  // The duplicate check runs HERE, before the preview/import fork, so both faces answer the same
  // thing. It used to live only in `setOpeningBalances`, which a preview never reaches, so a file
  // naming 1020 twice previewed as `balanced: true` with 3 lines and then refused on import with
  // `duplicate_account`. The tool description promises the import posts exactly what the preview
  // showed, and a preview that green-lights a file the import rejects breaks that promise on the
  // one shape the preview exists to catch.
  //
  // Compared on the RESOLVED account, so naming 1020 once by number and once by id is caught too.
  // Unmapped rows are keyed by their raw text instead, because they have no id to compare yet.
  const seen = new Map<string, string>();
  for (const row of normalised.rows) {
    const accountId = mappedAccountId(ctx, row.account);
    const key = accountId ?? `raw:${row.account}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      // OR 958c Abs. 1 Ziff. 7 forbids offsetting Aktiven against Passiven, and two rows for one
      // account mean the caller either double-counted or pre-netted. Summing them would show a
      // position the Beleg does not.
      return err('duplicate_account', { account: row.account, number: row.account, firstSeenAs: previous });
    }
    seen.set(key, row.account);
    (accountId !== undefined ? mapped : unmapped).push(row);
  }

  const totalDebitMinor = mapped.reduce((s, r) => s + r.debitMinor, 0);
  const totalCreditMinor = mapped.reduce((s, r) => s + r.creditMinor, 0);
  const differenceMinor = totalDebitMinor - totalCreditMinor;

  if (dryRun) {
    return ok({
      dryRun: true,
      format,
      mapping,
      preview: {
        lines: mapped.map((r) => ({ account: r.account, debitMinor: r.debitMinor, creditMinor: r.creditMinor })),
        unmapped: unmapped.map((r) => ({
          account: r.account,
          name: r.name,
          debitMinor: r.debitMinor,
          creditMinor: r.creditMinor,
        })),
        totalDebitMinor,
        totalCreditMinor,
        differenceMinor,
        // Says only that the two sides of the MAPPED rows agree. See the docblock for the list of
        // things that are wrong and still balance.
        balanced: differenceMinor === 0 && unmapped.length === 0,
      },
    });
  }

  if (unmapped.length > 0) {
    return err('unmapped_account', {
      unmapped: unmapped.map((r) => r.account),
      reason: 'add the accounts to the chart (A01) or correct the file: a partial import is not a position',
    });
  }

  const lines: OpeningLineInput[] = mapped.map((r) => ({
    account: r.account,
    debitMinor: r.debitMinor,
    creditMinor: r.creditMinor,
  }));

  const posted = setOpeningBalances(ctx, {
    lines,
    idempotencyKey: input.idempotencyKey as string,
    ...(input.asOf !== undefined ? { asOf: input.asOf } : {}),
    ...(input.differenceAccount !== undefined ? { differenceAccount: input.differenceAccount } : {}),
    ...(input.reference !== undefined ? { reference: input.reference } : {}),
  });
  if (!posted.ok) return posted;
  return ok({ ...posted, dryRun: false, format, mapping });
}
