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
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { exportStatement, EXPORT_FORMATS } from '../reports/index.js';
import { computeVatReturn } from '../vat/index.js';
import type { VatReturnLine } from '../vat/index.js';
import { parseReviewPeriod } from './shared.js';
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

function isErr(value: ReviewPeriod | Result): value is Result {
  return typeof (value as { ok?: unknown }).ok === 'boolean';
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
  period: string;
  format?: string;
}

/**
 * Every posted line of the period, one CSV row per line, in date-then-entry order, plus a TOTAL
 * record so the file foots on its own. Amounts are the stored integer Rappen (minor units), both in
 * the line currency and in the workspace base currency, and the stored §H-FX rate and §H-VAT-TRACE
 * values ride along verbatim.
 */
export function exportJournal(ctx: WorkspaceContext, input: ExportJournalInput): Result {
  const period = periodOf(input);
  if (isErr(period)) return period;
  const format = input.format ?? 'csv';
  if (format !== 'csv') return err('invalid_input', { field: 'format', supported: ['csv'] });

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
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date >= ? AND e.date <= ?
        ORDER BY e.date ASC, e.id ASC, l.rowid ASC`,
    )
    .all(ctx.workspaceId, period.start, period.end) as JournalCsvRow[];

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

  const total = csvLine([
    'total',
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
    baseDebitMinor,
    baseCreditMinor,
    null,
    null,
    null,
    null,
    null,
  ]);
  const text = `${[csvLine(JOURNAL_HEADER), ...lines, total].join('\n')}\n`;

  return ok({
    artifact: csvArtifact('journal', `journal-${period.start}-bis-${period.end}.csv`, text, {
      // The one check a journal export can make about itself: the books it copied foot.
      reconciles: baseDebitMinor === baseCreditMinor,
    }),
    period: period.period,
    periodStart: period.start,
    periodEnd: period.end,
    entryCount: entryIds.size,
    lineCount: rows.length,
    baseDebitMinor,
    baseCreditMinor,
    empty: rows.length === 0,
    ...(rows.length === 0 ? { notice: 'empty_period' } : {}),
  });
}

// --- The statements export -----------------------------------------------------------------------

export interface ExportStatementsInput {
  period: string;
  format?: string;
}

/**
 * The filing pair: the Bilanz as of the period end and the Erfolgsrechnung over the period, each
 * rendered by A08's OWN `exportStatement` in the requested format (csv or pdf), answered as one
 * artifact per statement. A25 adds nothing to the figures; it only packages the pair.
 */
export function exportStatements(ctx: WorkspaceContext, input: ExportStatementsInput): Result {
  const period = periodOf(input);
  if (isErr(period)) return period;
  const format = input.format ?? 'pdf';
  if (!EXPORT_FORMATS.includes(format)) {
    return err('invalid_input', { field: 'format', supported: [...EXPORT_FORMATS] });
  }

  const balance = exportStatement(ctx, { kind: 'balance', format, asOf: period.end });
  if (!balance.ok) return balance;
  const income = exportStatement(ctx, {
    kind: 'income',
    format,
    periodStart: period.start,
    periodEnd: period.end,
  });
  if (!income.ok) return income;

  return ok({
    period: period.period,
    periodStart: period.start,
    periodEnd: period.end,
    artifacts: [balance.artifact, income.artifact],
  });
}

// --- The MWST figures export ---------------------------------------------------------------------

export interface ExportVatInput {
  period: string;
  format?: string;
}

const VAT_HEADER = ['record_type', 'form_line', 'label', 'kind', 'rate_bp', 'base_minor', 'tax_minor'];

/**
 * A07's MWST-Abrechnung figures as a per-form-line CSV working paper: every Ziffer line exactly as
 * `computeVatReturn` answered it (stored trace values, never recomputed), plus the payable/credit
 * totals as their own records. The ESTV upload artifact stays A07's `vat_export_ech0217`; this file
 * is what a Treuhänder hands to the annual accounts beside it. A07's rejections (for example
 * `needs_vat_config`) pass through unchanged.
 */
export function exportVat(ctx: WorkspaceContext, input: ExportVatInput): Result {
  const period = periodOf(input);
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

  return ok({
    artifact: csvArtifact('vat', `mwst-${period.start}-bis-${period.end}.csv`, text, {
      method: model.method,
    }),
    period: period.period,
    periodStart: period.start,
    periodEnd: period.end,
    payableMinor: model.payableMinor,
    creditMinor: model.creditMinor,
    empty,
    ...(empty ? { notice: 'empty_period' } : {}),
  });
}
