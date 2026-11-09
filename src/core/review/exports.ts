/**
 * A25 US-A25.4, the filing exports: `exportJournal`, `exportStatements`, `exportVat`.
 *
 * ALL THREE ARE PURE READS (P5) OVER FIGURES ANOTHER CAPABILITY ALREADY COMPUTED, and that is the
 * design rather than a shortcut. `exportStatements` DELEGATES to A08's own `exportStatement` (the
 * `export_statement` tool's engine verb), once per statement, so the filed artifact and the screen
 * cannot disagree; `exportVat` serialises A07's `computeVatReturn` lines verbatim (the eCH-0217
 * upload artifact itself is A07's `vat_export_ech0217`, not duplicated here); `exportJournal` reads
 * the posted rows exactly as the ledger holds them (OR Art. 958f: the export reproduces the books
 * faithfully). Nothing here recomputes, rounds, or converts: stored integer Rappen and stored
 * §H-VAT-TRACE/§H-FX values pass straight through, and the journal CSV is locale-neutral (integer
 * minor units, ISO dates) so a re-import round-trips (P11).
 *
 * Exports are idempotent by construction: same period + format, same bytes (no wall-clock timestamp
 * is ever embedded). An empty period is `ok` with a header-only file and `empty: true`, never a
 * failure (spec §2 states). Nothing is transmitted anywhere: e-filing is cloud-tier (OP4).
 *
 * D190 (09.11.2026): the journal and the statements also take a date RANGE (`from`/`to`) instead of a
 * period, and the journal takes filters (account, source). A range or a filter changes WHICH stored rows
 * are copied, never what a row says, and a file that is not a whole period or is filtered says so inside
 * itself (a `scope` record) and in its name, so an extract is never mistaken for the whole journal.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { exportStatement, EXPORT_FORMATS } from '../reports/index.js';
import { computeVatReturn, filingPeriodsOfYear, monthsOfVatPeriod, isMwstYear, MWST_FIRST_YEAR, stubsTouching } from '../vat/index.js';
import type { VatReturnLine } from '../vat/index.js';
import { parseReviewPeriod } from './shared.js';
import { requireDate } from '../ledger/inputGuards.js';
import { isJournalSource, journalSources } from '../ledger/postEntry.js';
import type { ReviewPeriod } from './shared.js';

/** CSV field escaping: RFC 4180, quote only when the value demands it. */
function csvField(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(fields: (string | number | null)[]): string {
  return fields.map(csvField).join(',');
}

function periodOf(input: { period?: unknown }): ReviewPeriod | Result {
  const period = parseReviewPeriod(input?.period);
  if (period === undefined) {
    return err('invalid_period', { period: input?.period, expected: 'YYYY-MM or YYYY' });
  }
  return period;
}

/**
 * The period of a VAT export: everything `periodOf` takes, plus the labels A07 names its reporting
 * periods with, `YYYY-Qn` (effektiv, quarterly) and `YYYY-Hn` (Saldo, half-yearly), MWSTG Art. 35
 * Abs. 1. A label resolves through A07's own `monthsOfVatPeriod`, the function `vat_periods` and
 * `vat_mark_filed` resolve it with, so a quarter is its three months and a half-year its six, first
 * day to last, and the export of a label `vat_periods` listed covers exactly that period.
 *
 * Every form must lie in the MWST era (`MWST_FIRST_YEAR`, 1995): there is no MWST return for 1994, and
 * a year below 1000 used to throw (critic L1). Any shape that does not resolve, whatever the reason, is
 * `invalid_period`; nothing here is cast past a failed parse.
 */
function vatPeriodOf(input: { period?: unknown }): ReviewPeriod | Result {
  const refuse = () =>
    err('invalid_period', {
      period: input?.period,
      expected: 'YYYY-MM, YYYY-Qn, YYYY-Hn or YYYY',
      earliestYear: MWST_FIRST_YEAR,
    });
  const raw = input?.period;
  if (typeof raw !== 'string' || !isMwstYear(raw.slice(0, 4))) return refuse();
  const plain = parseReviewPeriod(raw);
  if (plain !== undefined) return plain;
  const months = monthsOfVatPeriod(raw);
  if (months === null) return refuse();
  const first = parseReviewPeriod(months[0]);
  const last = parseReviewPeriod(months[months.length - 1]);
  if (first === undefined || last === undefined) return refuse();
  return { period: raw, start: first.start, end: last.end };
}

function isErr<T extends object>(value: T | Result): value is Result {
  return typeof (value as { ok?: unknown }).ok === 'boolean';
}

// --- D190: the period OR the range -------------------------------------------------------------

/**
 * What an export covers. `period` names the period when the dates are exactly one (a month `YYYY-MM` or
 * a calendar year `YYYY`), and is null for any other range; `ranged` is true exactly when it is null.
 */
interface ExportScope {
  period: string | null;
  start: string;
  end: string;
  ranged: boolean;
}

/** Absent means not sent: `undefined`, or a JSON `null` (an MCP client may send either). */
function given(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The period a range IS, when it is exactly one: a calendar month or a calendar year. Such a range answers
 * that period's own file, byte for byte, so the same books never come back as two different files under
 * one name, and "a whole month as from/to" and "the month as period" are the same export by construction.
 */
function periodOfRange(from: string, to: string): string | null {
  const year = from.slice(0, 4);
  if (from === `${year}-01-01` && to === `${year}-12-31`) return year;
  const month = from.slice(0, 7);
  if (from === `${month}-01` && to.slice(0, 7) === month) {
    const last = lastDayOfMonth(Number(year), Number(from.slice(5, 7)));
    if (to === `${month}-${String(last).padStart(2, '0')}`) return month;
  }
  return null;
}

/**
 * EXACTLY ONE of `period` or `from`+`to` (D190). Every other combination is a NAMED refusal, never a
 * silent default: both forms (`period_and_range_conflict`), neither (`period_or_range_required`), one bound
 * alone (`range_incomplete`, naming the missing one), a bound that is not a calendar date (`invalid_input`
 * with its `field`), and `from` after `to` (`range_inverted`). Both bounds are inclusive.
 */
function scopeOf(input: { period?: unknown; from?: unknown; to?: unknown }): ExportScope | Result {
  const hasPeriod = given(input?.period);
  const hasFrom = given(input?.from);
  const hasTo = given(input?.to);
  if (hasPeriod && (hasFrom || hasTo)) {
    return err('period_and_range_conflict', {
      period: input.period,
      ...(hasFrom ? { from: input.from } : {}),
      ...(hasTo ? { to: input.to } : {}),
      expected: 'period, or from and to, not both',
    });
  }
  if (hasPeriod) {
    const period = periodOf(input);
    if (isErr(period)) return period;
    return { period: period.period, start: period.start, end: period.end, ranged: false };
  }
  if (!hasFrom && !hasTo) {
    return err('period_or_range_required', { expected: "period ('YYYY-MM' or 'YYYY'), or from and to ('YYYY-MM-DD')" });
  }
  if (!hasFrom || !hasTo) return err('range_incomplete', { missing: hasFrom ? 'to' : 'from' });
  for (const field of ['from', 'to'] as const) {
    if (requireDate(input[field], field) !== null) {
      return err('invalid_input', { field, value: input[field], expected: 'YYYY-MM-DD' });
    }
  }
  const from = input.from as string;
  const to = input.to as string;
  if (from > to) return err('range_inverted', { from, to });
  const period = periodOfRange(from, to);
  return { period, start: from, end: to, ranged: period === null };
}

/** Whether a range starts on a month's first day and ends on a month's last day. */
function isWholeMonths(start: string, end: string): boolean {
  if (start.slice(8, 10) !== '01') return false;
  const last = lastDayOfMonth(Number(end.slice(0, 4)), Number(end.slice(5, 7)));
  return end.slice(8, 10) === String(last).padStart(2, '0');
}

/** A filter this export does not offer, refused by name rather than ignored (the schema admits extras). */
function unsupportedFilter(field: string, reason: string): Result {
  return err('unsupported_filter', { field, reason });
}

function csvArtifact(kind: string, filename: string, text: string, extra: Record<string, unknown>) {
  const buffer = Buffer.from(text, 'utf8');
  return {
    kind,
    format: 'csv',
    filename,
    mediaType: 'text/csv; charset=utf-8',
    byteLength: buffer.byteLength,
    base64: buffer.toString('base64'),
    ...extra,
  };
}

// --- The journal export --------------------------------------------------------------------------

interface JournalCsvRow {
  entry_id: string;
  date: string;
  ref: string | null;
  description: string | null;
  source: string;
  account_number: string;
  account_name: string;
  debit_minor: number;
  credit_minor: number;
  currency: string;
  base_debit_minor: number;
  base_credit_minor: number;
  fx_rate: string | null;
  tax_code: string | null;
  tax_base_minor: number | null;
  tax_amount_minor: number | null;
  supply_date: string | null;
}

const JOURNAL_HEADER = [
  'record_type',
  'entry_id',
  'date',
  'ref',
  'description',
  'source',
  'account_number',
  'account_name',
  'debit_minor',
  'credit_minor',
  'currency',
  'base_debit_minor',
  'base_credit_minor',
  'fx_rate',
  'tax_code',
  'tax_base_minor',
  'tax_amount_minor',
  'supply_date',
];

export interface ExportJournalInput {
  /** `YYYY-MM` or `YYYY`; the alternative to `from`/`to` (exactly one form, D190). */
  period?: string;
  /** Inclusive ISO first day of a range (D190). */
  from?: string;
  /** Inclusive ISO last day of a range (D190). */
  to?: string;
  /** An account id or account number: keeps every whole entry with a line on that account (D190). */
  account?: string;
  /** A `journal_entry.source` value (D190). */
  source?: string;
  /** Only `posted`: the file is the books, and a draft is not in them (D190). */
  status?: string;
  format?: string;
}

/** The narrowing filters of a journal export, resolved and checked (D190). */
interface JournalFilters {
  account: { id: string; number: string; name: string } | null;
  source: string | null;
}

const SOURCE_SHAPE = /^[a-z][a-z_]*$/;

/**
 * The journal filters (D190), the `list_journal` set minus what does not belong in a statutory file.
 *
 *  - `account` keeps every WHOLE entry that has a line on that account, `list_journal`'s own semantics.
 *    Whole entries, never single lines, so every entry in the file still balances and the footing still
 *    foots; the lines of one account alone are A08's Kontoblatt (`export_statement` kind `ledger`), a
 *    different artifact. It takes the account id `list_journal` takes, or the account NUMBER a person
 *    speaks, resolved INSIDE this workspace (§H-TENANT): another workspace's account is `unknown_account`,
 *    exactly like one that does not exist, so the refusal discloses nothing.
 *  - `source` is one `journal_entry.source` value.
 *  - `status` admits `posted` alone, and it narrows nothing: the file only ever copies posted rows,
 *    because a draft is not in the books (OR Art. 957a/958f), and a draft's base amounts carry no rate.
 *  - `number` (a Belegnummer) and `savedViewId` are refused by name: one Belegnummer is `get_entry`'s job,
 *    a plain integer matches across series, which is too loose for a statutory extract, and a saved view
 *    could carry a filter this file cannot honour. The schema admits extra fields, so ignoring them would
 *    hand back the full journal to a caller who believes it filtered.
 */
function journalFiltersOf(ctx: WorkspaceContext, input: Record<string, unknown>): JournalFilters | Result {
  if (given(input.number)) {
    return unsupportedFilter('number', 'one Belegnummer is get_entry; a journal export filters by account and source');
  }
  if (given(input.savedViewId)) {
    return unsupportedFilter('savedViewId', 'a saved journal view may carry a filter a journal export does not offer');
  }
  if (given(input.status) && input.status !== 'posted') {
    return err('unsupported_filter', {
      field: 'status',
      supported: ['posted'],
      reason: 'the journal export copies the books, and a draft is not in the books',
    });
  }
  let source: string | null = null;
  if (given(input.source)) {
    if (typeof input.source !== 'string' || !SOURCE_SHAPE.test(input.source)) {
      return err('invalid_input', { field: 'source', expected: 'a journal_entry.source value, for example invoice' });
    }
    // A typo must not answer an empty extract with ok:true (D190 critic nit 1): refuse it, naming the values.
    if (!isJournalSource(input.source)) return err('invalid_source', { source: input.source, allowed: journalSources() });
    source = input.source;
  }
  let account: JournalFilters['account'] = null;
  if (given(input.account)) {
    if (typeof input.account !== 'string' || input.account.trim() === '') {
      return err('invalid_input', { field: 'account', expected: 'an account id or account number' });
    }
    const wanted = input.account.trim();
    const matches = ctx.store.db
      .prepare(
        `SELECT id, number, name FROM account
          WHERE workspace_id = ? AND (id = ? OR number = ?)
          ORDER BY id`,
      )
      .all(ctx.workspaceId, wanted, wanted) as { id: string; number: string; name: string }[];
    const only = matches[0];
    if (only === undefined) return err('unknown_account', { account: wanted });
    if (matches.length > 1) {
      return err('ambiguous_account', { account: wanted, matches: matches.map((m) => m.number) });
    }
    account = { id: only.id, number: only.number, name: only.name };
  }
  return { account, source };
}

/** A filename-safe rendering of a free-text value (an account number is free text in A01). */
function fileSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Every posted line of the period or range, one CSV row per line, in date-then-entry order, plus a TOTAL
 * record so the file foots on its own. Amounts are the stored integer Rappen (minor units), both in the
 * line currency and in the workspace base currency, and the stored §H-FX rate and §H-VAT-TRACE values
 * ride along verbatim.
 *
 * D190: a file that is not a whole period, or is filtered, carries a `scope` record right after the
 * column header naming its dates and every active filter, its total record is labelled as the total of
 * the lines IN THIS FILE, and its name says `auszug` when filtered. A whole-period unfiltered file is
 * byte-identical to what this verb answered before D190.
 */
export function exportJournal(ctx: WorkspaceContext, input: ExportJournalInput): Result {
  const scope = scopeOf(input);
  if (isErr(scope)) return scope;
  const filters = journalFiltersOf(ctx, (input ?? {}) as unknown as Record<string, unknown>);
  if (isErr(filters)) return filters;
  const format = input.format ?? 'csv';
  if (format !== 'csv') return err('invalid_input', { field: 'format', supported: ['csv'] });

  const clauses = [`e.workspace_id = ?`, `e.status = 'posted'`, `e.date >= ?`, `e.date <= ?`];
  const params: string[] = [ctx.workspaceId, scope.start, scope.end];
  if (filters.source !== null) {
    clauses.push('e.source = ?');
    params.push(filters.source);
  }
  if (filters.account !== null) {
    // The account id was resolved inside this workspace above, and `e.workspace_id` fences the entries,
    // so the subquery can only ever name this workspace's lines (§H-TENANT).
    clauses.push('e.id IN (SELECT f.entry_id FROM journal_line f WHERE f.account_id = ?)');
    params.push(filters.account.id);
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT e.id AS entry_id, e.date, e.ref, e.description, e.source,
              a.number AS account_number, a.name AS account_name,
              l.debit_minor, l.credit_minor, l.currency,
              l.base_debit_minor, l.base_credit_minor, l.fx_rate,
              l.tax_code, l.tax_base_minor, l.tax_amount_minor, l.supply_date
         FROM journal_entry e
         JOIN journal_line l ON l.entry_id = e.id
         JOIN account a ON a.id = l.account_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY e.date ASC, e.id ASC, l.rowid ASC`,
    )
    .all(...params) as JournalCsvRow[];

  let baseDebitMinor = 0;
  let baseCreditMinor = 0;
  const entryIds = new Set<string>();
  const lines = rows.map((row) => {
    baseDebitMinor += row.base_debit_minor;
    baseCreditMinor += row.base_credit_minor;
    entryIds.add(row.entry_id);
    return csvLine([
      'line',
      row.entry_id,
      row.date,
      row.ref,
      row.description,
      row.source,
      row.account_number,
      row.account_name,
      row.debit_minor,
      row.credit_minor,
      row.currency,
      row.base_debit_minor,
      row.base_credit_minor,
      row.fx_rate,
      row.tax_code,
      row.tax_base_minor,
      row.tax_amount_minor,
      row.supply_date,
    ]);
  });

  const filtered = filters.account !== null || filters.source !== null;
  const scoped = scope.ranged || filtered;
  const scopeText = scoped ? describeScope(scope, filters) : null;
  const scopeRecord = scoped
    ? [
        csvLine([
          'scope',
          null,
          null,
          null,
          scopeText,
          filters.source,
          filters.account?.number ?? null,
          filters.account?.name ?? null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ]),
      ]
    : [];
  const total = csvLine([
    'total',
    null,
    null,
    null,
    // An unscoped file keeps its pre-D190 bytes; a scoped file says WHAT the footing adds up.
    scoped ? (filtered ? 'total of the lines in this file (a filtered extract)' : 'total of the lines in this file') : null,
    null,
    null,
    null,
    null,
    null,
    null,
    baseDebitMinor,
    baseCreditMinor,
    null,
    null,
    null,
    null,
    null,
  ]);
  const text = `${[csvLine(JOURNAL_HEADER), ...scopeRecord, ...lines, total].join('\n')}\n`;

  const filename = filtered
    ? `journal-auszug-${scope.start}-bis-${scope.end}` +
      (filters.account !== null ? `-konto-${fileSafe(filters.account.number)}` : '') +
      (filters.source !== null ? `-quelle-${filters.source}` : '') +
      '.csv'
    : `journal-${scope.start}-bis-${scope.end}.csv`;
  const empty = rows.length === 0;

  return ok({
    artifact: csvArtifact('journal', filename, text, {
      // The one check a journal export can make about itself: the books it copied foot. Whole entries
      // only (an account filter keeps every line of a matching entry), so a filtered file foots too.
      reconciles: baseDebitMinor === baseCreditMinor,
    }),
    period: scope.period,
    periodStart: scope.start,
    periodEnd: scope.end,
    // A whole-period, unfiltered export answers EXACTLY the pre-D190 payload: G22's checklist anchor
    // (`src/core/checklists/anchor.ts`) hashes this payload, so a new key on the plain answer would
    // read as moved books on every sign-off made before D190. The scope keys ride only where they say
    // something: on a range that is not a period, or on a filtered extract.
    ...(scoped
      ? {
          from: scope.start,
          to: scope.end,
          filtered,
          filters: {
            ...(filters.account !== null ? { account: filters.account } : {}),
            ...(filters.source !== null ? { source: filters.source } : {}),
          },
          scope: scopeText,
        }
      : {}),
    entryCount: entryIds.size,
    lineCount: rows.length,
    baseDebitMinor,
    baseCreditMinor,
    empty,
    ...(empty ? { notice: filtered ? 'empty_extract' : 'empty_period' } : {}),
  });
}

/**
 * The words of the `scope` record (D190): the dates, the period they are when they are one, and every
 * active filter, with "not the full journal" on a filtered file. Deterministic: the same scope always
 * reads the same, so the same input gives the same bytes.
 */
function describeScope(scope: ExportScope, filters: JournalFilters): string {
  const dates = `posted entries dated ${scope.start} to ${scope.end}` + (scope.period !== null ? ` (period ${scope.period})` : '');
  const active: string[] = [];
  if (filters.account !== null) active.push(`account ${filters.account.number}`);
  if (filters.source !== null) active.push(`source ${filters.source}`);
  return active.length > 0
    ? `${dates}; filtered extract: ${active.join(', ')}; not the full journal`
    : `${dates}; all accounts, all sources`;
}

// --- The statements export -----------------------------------------------------------------------

export interface ExportStatementsInput {
  /** `YYYY-MM` or `YYYY`; the alternative to `from`/`to` (exactly one form, D190). */
  period?: string;
  /** Inclusive ISO first day of the Erfolgsrechnung (D190). */
  from?: string;
  /** Inclusive ISO last day of the Erfolgsrechnung, and the Bilanz's Stichtag (D190). */
  to?: string;
  format?: string;
}

/**
 * The filing pair: the Bilanz as of the period end (or `to`) and the Erfolgsrechnung over the period (or
 * `from`..`to`), each rendered by A08's OWN `exportStatement` in the requested format (csv or pdf),
 * answered as one artifact per statement. A25 adds nothing to the figures; it only packages the pair, so
 * each file is byte-identical to `export_statement` for the same dates, and A08's masthead names them.
 *
 * D190: NO filter. A Bilanz over some accounts is not a Bilanz, so `account`, `source`, `status` and
 * `number` are refused by name rather than ignored. A range that does not run from a month's first day to
 * a month's last day answers `notice: 'range_not_whole_months'`: an Erfolgsrechnung cut mid-month may
 * miss the Abgrenzungen booked at the month end, and the person downloading it is told so.
 */
export function exportStatements(ctx: WorkspaceContext, input: ExportStatementsInput): Result {
  const scope = scopeOf(input);
  if (isErr(scope)) return scope;
  const raw = (input ?? {}) as unknown as Record<string, unknown>;
  for (const field of ['account', 'source', 'status', 'number', 'savedViewId']) {
    if (given(raw[field])) return unsupportedFilter(field, 'a filtered Bilanz is not a Bilanz: the statements are never filtered');
  }
  const format = input.format ?? 'pdf';
  if (!EXPORT_FORMATS.includes(format)) {
    return err('invalid_input', { field: 'format', supported: [...EXPORT_FORMATS] });
  }

  const balance = exportStatement(ctx, { kind: 'balance', format, asOf: scope.end });
  if (!balance.ok) return balance;
  const income = exportStatement(ctx, {
    kind: 'income',
    format,
    periodStart: scope.start,
    periodEnd: scope.end,
  });
  if (!income.ok) return income;

  return ok({
    period: scope.period,
    periodStart: scope.start,
    periodEnd: scope.end,
    // As on the journal: a period (or a range that IS one) answers the pre-D190 payload unchanged, which
    // G22's checklist anchor hashes; a range adds its dates and, when cut mid-month, the notice.
    ...(scope.ranged ? { from: scope.start, to: scope.end } : {}),
    artifacts: [balance.artifact, income.artifact],
    ...(isWholeMonths(scope.start, scope.end) ? {} : { notice: 'range_not_whole_months' }),
  });
}

// --- The MWST figures export ---------------------------------------------------------------------

export interface ExportVatInput {
  /** `YYYY-MM`, `YYYY-Qn`, `YYYY-Hn` or `YYYY` (see `vatPeriodOf`). */
  period: string;
  format?: string;
}

const VAT_HEADER = ['record_type', 'form_line', 'label', 'kind', 'rate_bp', 'base_minor', 'tax_minor'];

/**
 * A07's MWST-Abrechnung figures as a per-form-line CSV working paper: every Ziffer line exactly as
 * `computeVatReturn` answered it (stored trace values, never recomputed), plus the payable/credit
 * totals as their own records. The ESTV upload artifact stays A07's `vat_export_ech0217`; this file
 * is what a Treuhänder hands to the annual accounts beside it. A07's rejections (for example
 * `needs_vat_config`) pass through unchanged. The period is a month, a calendar year, or a VAT
 * period label (`2026-Q3`, `2026-H1`); a label names the file (`mwst-2026-Q3.csv`), the other two
 * keep their dated name (`mwst-2026-03-01-bis-2026-03-31.csv`).
 */
export function exportVat(ctx: WorkspaceContext, input: ExportVatInput): Result {
  // D190: no range. A MWST period is fixed by MWSTG Art. 35 (and the method's calendar), so a free range
  // would name a file like a return that no return covers. Refused by name, never ignored.
  const raw = (input ?? {}) as unknown as Record<string, unknown>;
  if (given(raw.from) || given(raw.to)) {
    return err('unsupported_range', {
      expected: 'period: YYYY-MM, YYYY-Qn, YYYY-Hn or YYYY',
      reason: 'MWST periods are fixed (MWSTG Art. 35); a range is offered on the journal and the statements only',
    });
  }
  const period = vatPeriodOf(input);
  if (isErr(period)) return period;
  const format = input.format ?? 'csv';
  if (format !== 'csv') return err('invalid_input', { field: 'format', supported: ['csv'] });

  const model = computeVatReturn(ctx, { periodStart: period.start, periodEnd: period.end });
  if (!model.ok) return model;

  const lines = (model.lines as VatReturnLine[]).map((line) =>
    csvLine(['line', line.code, line.label, line.kind, line.rateBp, line.baseMinor, line.taxMinor]),
  );
  const totals = [
    csvLine(['total', '500', 'Zu bezahlender Betrag', null, null, null, model.payableMinor as number]),
    csvLine(['total', '510', 'Guthaben der steuerpflichtigen Person', null, null, null, model.creditMinor as number]),
  ];
  const text = `${[csvLine(VAT_HEADER), ...lines, ...totals].join('\n')}\n`;
  const empty = model.empty === true;
  const isLabel = monthsOfVatPeriod(period.period) !== null;
  const filename = isLabel ? `mwst-${period.period}.csv` : `mwst-${period.start}-bis-${period.end}.csv`;

  // A LABEL GETS A FILING-PERIOD VERDICT (critic L2). The export stays ok:true for any label, because a
  // working paper over an effektiv filer's half-year is a legitimate aggregate, but a label that is not
  // one of that year's filing periods (as vat_periods lists them, by the method of that year) says so,
  // so a file named like a return is never mistaken for one. `vat_mark_filed` REFUSES such a label.
  // The meaning of the period outranks its emptiness for the single `notice`; `empty` still says that.
  // A month or a year is not a label and gets no verdict. `computeVatReturn` already refused a book
  // with no VAT method, and a label spanning two method eras (period_straddles_method_change), so one
  // method governs the label here: `filingMethod` is that method, the same as `artifact.method`
  // (critic L-R2-3, R3-M1). In a MWSTV Art. 81 Abs. 2 switch year the calendar comes from the eras, and
  // a label touching a stub the switch cut answers `switch_year_stub_not_modelled` (`vat_mark_filed`
  // refuses to seal it the same way).
  let verdict: Record<string, unknown> = {};
  if (isLabel) {
    const filing = filingPeriodsOfYear(ctx, period.period.slice(0, 4));
    if (!('needsConfig' in filing)) {
      const touching = stubsTouching(filing.stubs, period.period);
      verdict = filing.labels.includes(period.period)
        ? { filingPeriod: true }
        : {
            filingPeriod: false,
            notice: touching.length > 0 ? 'switch_year_stub_not_modelled' : 'not_a_filing_period',
            filingMethod: model.method,
            filingPeriods: filing.labels,
            ...(touching.length > 0 ? { stubs: touching } : {}),
          };
    }
  }

  return ok({
    artifact: csvArtifact('vat', filename, text, {
      method: model.method,
    }),
    period: period.period,
    periodStart: period.start,
    periodEnd: period.end,
    payableMinor: model.payableMinor,
    creditMinor: model.creditMinor,
    empty,
    ...(empty ? { notice: 'empty_period' } : {}),
    ...verdict,
  });
}
