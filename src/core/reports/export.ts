/**
 * A08 US-A08.6, `exportStatement`: the local PDF/CSV artifact for any of the four statements.
 *
 * The OSS core stops HERE (Pattern OP4). This produces a file and hands it back; e-filing,
 * publishing, or any transmission of it off-device is cloud-tier and owner-gated, and nothing in
 * this module opens a socket.
 *
 * ## One computation, two renderings
 *
 * The model is computed ONCE, by the same four verbs the GUI and the MCP tools call, and both
 * renderers read that object. There is no second aggregation path, so the artifact cannot disagree
 * with the figures on screen: the spec calls that "no recomputation divergence" and it is the whole
 * reason this file takes a model rather than a query.
 *
 * ## The CSV is locale-neutral on purpose (P11)
 *
 * Integer Rappen, ISO dates, `LF` line endings, no byte-order mark, no thousands separator and no
 * currency symbol. `CHF 1'234.55` and `31.12.2026` are PRESENTATION, and a re-import that had to
 * parse them back would have to guess a locale. The currency is named once in the response instead
 * of being glued to every figure.
 *
 * Each row leads with a `record_type` column, so the totals ride in the file (the spec requires the
 * artifact to carry the same reconciliation totals as the screen) without a preamble that would
 * break a plain CSV reader. `total` and `subtotal` rows are skippable by a re-importer with a
 * single predicate, which a trailing unlabelled sum is not.
 *
 * ## The PDF is minimal and says so
 *
 * Courier text on as many landscape A4 pages as the statement needs, assembled by hand the way A11's
 * invoice renderer does. Courier rather than Helvetica because the columns are laid out by padding
 * and a proportional face would ragged them, and `/WinAnsiEncoding` so the umlauts in
 * "Umlaufvermögen" and "Übriger betrieblicher Aufwand" actually appear rather than dropping to a
 * blank glyph.
 *
 * Every row a statement produces is PLACED ON A PAGE, and `buildMinimalPdf` explains at length why
 * that sentence had to be written down: a Bilanz whose heading and Aktiven were drawn above the
 * paper still contained the words, still passed a test that searched the bytes for them, and was
 * handed to a reader as a document that totalled a section it never listed. The masthead repeats on
 * every page and every page carries "Seite k von n", so a missing page is visible rather than
 * indistinguishable from a short book.
 *
 * It is a print/file artifact and it is NOT claimed to be PDF/A conformant: nothing here verifies a
 * profile, so nothing here asserts one (the same honesty A11 applies to `pdfaProfile: null`).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';
import {
  computeTrialBalance,
  computeBalanceSheet,
  computeIncomeStatement,
  computeGeneralLedger,
  STATEMENT_KINDS,
} from './statements.js';

/** The two artifact formats (§H-ENUM), single-sourced so a third cannot appear by typo. */
export const EXPORT_FORMATS: readonly string[] = ['csv', 'pdf'];

/**
 * The Bilanz's coverage limit, printed on the artifact itself.
 *
 * ## Why a caveat belongs on the FILE even where it might not belong on the screen
 *
 * `sections.ts` records that `BILANZ_SECTIONS` models the seven first-level groupings of OR
 * Art. 959a and NOT the 24 sub-positions Abs. 1 and Abs. 2 require "einzeln und in der vorgegebenen
 * Reihenfolge". On the shipped Kontenrahmen KMU the account order reproduces the statutory sequence
 * by coincidence; on a renamed or renumbered chart it does not, and no reconciliation flag can see
 * the difference, because the statement still foots.
 *
 * A Bilanz PDF carries the statutory German headings, the subtotals and "Abstimmung: erfüllt". That
 * is the strongest implicit conformance claim the capability makes anywhere, and it is made to the
 * one reader who cannot ask a follow-up question: the file leaves the building and the screen does
 * not. A bank or a Treuhänder reading page 2 of a printout has no tool description, no `HelpHint`
 * and no operator to hand.
 *
 * The argument AGAINST was taken seriously and lost. A caveat on a document that looks legal does
 * invite a reader to distrust figures that are correct to the Rappen, and every figure here is. But
 * the cost of the note is a reader who checks; the cost of silence is a reader who files. The file
 * already discloses its other limit honestly (`pdfaProfile: null`) and that disclosure reaches only
 * the API caller, never the page. This one had to reach the page.
 *
 * SCOPED TO THE BILANZ, deliberately. The Erfolgsrechnung has no equivalent gap (OR Art. 959b Abs. 2
 * is a flat list of eleven and all eleven are modelled), and the Saldenbilanz and the Kontoblatt are
 * working papers that claim no statutory structure at all. Stamping all four would be noise on three
 * documents in order to disclose a limit that belongs to one, and a caveat that appears everywhere is
 * a caveat nobody reads.
 *
 * It rides in the MASTHEAD, so `buildMinimalPdf` repeats it on every page. A caveat on page 1 of a
 * document whose pages get separated is a caveat that can be detached from the figures it qualifies,
 * which is the same defect class as the pagination bug that file's docblock describes.
 */
export const BILANZ_COVERAGE_NOTE =
  'Hinweis: Gliederung nach Kontenplan. Die Einzelpositionen von OR Art. 959a Abs. 1 und 2 sind nicht abgebildet.';

/** The de-CH title each statement prints under, and the slug its filename is built from. */
const KIND_META: Readonly<Record<string, { title: string; slug: string }>> = {
  trial: { title: 'Saldenbilanz', slug: 'saldenbilanz' },
  balance: { title: 'Bilanz', slug: 'bilanz' },
  income: { title: 'Erfolgsrechnung', slug: 'erfolgsrechnung' },
  ledger: { title: 'Kontoblatt', slug: 'kontoblatt' },
};

export interface ExportStatementInput {
  kind: string;
  format: string;
  periodStart?: string;
  periodEnd?: string;
  asOf?: string;
  accountId?: string;
  compareTo?: unknown;
  groupBy?: string;
}

/** Compute the model the artifact renders, through the SAME verb every other face calls. */
function modelFor(ctx: WorkspaceContext, input: ExportStatementInput): Result {
  switch (input.kind) {
    case 'trial':
      return computeTrialBalance(ctx, input as never);
    case 'balance':
      return computeBalanceSheet(ctx, input as never);
    case 'income':
      return computeIncomeStatement(ctx, input as never);
    default:
      return computeGeneralLedger(ctx, input as never);
  }
}

export function exportStatement(ctx: WorkspaceContext, input: ExportStatementInput): Result {
  const guard = requireString(input.kind, 'kind') ?? requireString(input.format, 'format');
  if (guard) return guard;
  if (!STATEMENT_KINDS.includes(input.kind)) {
    return err('invalid_input', { field: 'kind', supported: STATEMENT_KINDS });
  }
  if (!EXPORT_FORMATS.includes(input.format)) {
    return err('invalid_input', { field: 'format', supported: EXPORT_FORMATS });
  }

  // A rejected model is the caller's answer, unchanged. Rendering an artifact for a report that
  // could not be computed would put a file in someone's hands with nothing behind it.
  const model = modelFor(ctx, input);
  if (!model.ok) return model;

  const meta = KIND_META[input.kind] ?? { title: input.kind, slug: input.kind };
  const text = input.format === 'csv' ? renderCsv(input.kind, model) : renderPdf(input.kind, meta.title, model);
  // latin1 for the PDF because the byte stream IS latin1 (WinAnsi); utf8 for the CSV because a CSV
  // is text and a consumer reads it as UTF-8.
  const encoding = input.format === 'pdf' ? 'latin1' : 'utf8';
  const buffer = Buffer.from(text, encoding);

  return ok({
    artifact: {
      kind: input.kind,
      format: input.format,
      filename: `${meta.slug}-${filenameSuffix(model)}.${input.format}`,
      mediaType: input.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
      byteLength: buffer.byteLength,
      base64: buffer.toString('base64'),
      // Carried onto the artifact so a file handed to an accountant states the same verdict the
      // screen did. `undefined` for a model that reports none rather than a fabricated `true`.
      reconciles: model.reconciles,
      // Not asserted, so not claimed. A32-OI1 (PDF/A-3b) is deferred, exactly as on the invoice.
      ...(input.format === 'pdf' ? { pdfaProfile: null } : {}),
    },
  });
}

/** `2026-01-01-bis-2026-03-31` or `per-2026-03-31`: ISO throughout, never a de-CH display date. */
function filenameSuffix(model: Result): string {
  const period = model.period as { start: string; end: string } | undefined;
  if (period !== undefined) return `${period.start}-bis-${period.end}`;
  return `per-${String(model.asOf ?? '')}`;
}

// --- CSV -----------------------------------------------------------------------------------------

/**
 * A leading character a spreadsheet reads as the start of a FORMULA rather than as data.
 *
 * `=`, `+`, `-` and `@` open a formula in Excel, LibreOffice Calc, Google Sheets and Numbers; a
 * leading tab or carriage return can be stripped by the importer and expose the character behind it.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** A field that is simply an integer, which is what every `_minor` column holds. */
const PLAIN_INTEGER = /^-?\d+$/;

/**
 * One CSV field: quoted when it has to be, and DEFUSED when a spreadsheet would execute it.
 *
 * ## RFC 4180 was the only thing this did, and it is not the whole job
 *
 * Account names, refs and descriptions are free text that A01 and A02 accept verbatim. A row whose
 * description is `=cmd|' /C calc'!A0` used to be written out unquoted and unaltered, and opening
 * that file in Excel runs it. That is CSV injection (CWE-1236), and an accounting export is a
 * high-value carrier for it: the file is produced by the bookkeeping system and mailed to a
 * Treuhänder, who has every reason to trust it and open it in a spreadsheet.
 *
 * The mitigation is the standard one, a leading apostrophe, which every spreadsheet reads as "the
 * rest of this cell is literal text". The field is quoted at the same time so the prefix is
 * unambiguous to a re-importer rather than looking like part of the value.
 *
 * ## Why the integer test is not optional
 *
 * `-` is a formula lead AND the sign of every negative figure in the file. Prefixing on a bare `-`
 * would rewrite `-685000` as `'-685000` and turn the money columns into strings: the naive fix
 * breaks re-import on the single most common value in the export. So a field that is a plain integer
 * is left exactly as it is, and it cannot be a formula, because no formula is a bare integer.
 * `-1+1`, `+5` and `-A1` are not plain integers and are all defused.
 */
function field(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (FORMULA_LEAD.test(text) && !PLAIN_INTEGER.test(text)) {
    return `"'${text.replace(/"/g, '""')}"`;
  }
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(cells: readonly unknown[]): string {
  return cells.map(field).join(',');
}

function renderCsv(kind: string, model: Result): string {
  const lines = kind === 'trial'
    ? trialCsv(model)
    : kind === 'balance'
      ? balanceCsv(model)
      : kind === 'income'
        ? incomeCsv(model)
        : ledgerCsv(model);
  // A trailing newline, so appending or concatenating never welds two records together.
  return `${lines.join('\n')}\n`;
}

interface TrialRow {
  account: { number: string; name: string; type: string };
  kmuClass: string;
  openingMinor: number;
  debitMinor: number;
  creditMinor: number;
  closingMinor: number;
  compareClosingMinor?: number;
  deltaMinor?: number;
}

function trialCsv(model: Result): string[] {
  const rows = model.rows as TrialRow[];
  const compared = rows.some((row) => row.compareClosingMinor !== undefined);
  const head = [
    'record_type',
    'account_number',
    'account_name',
    'account_type',
    'kmu_class',
    'opening_minor',
    'debit_minor',
    'credit_minor',
    'closing_minor',
    ...(compared ? ['compare_closing_minor', 'delta_minor'] : []),
  ];
  const totals = model.totals as { openingMinor: number; debitMinor: number; creditMinor: number; closingMinor: number };
  return [
    csvLine(head),
    ...rows.map((row) =>
      csvLine([
        'row',
        row.account.number,
        row.account.name,
        row.account.type,
        row.kmuClass,
        row.openingMinor,
        row.debitMinor,
        row.creditMinor,
        row.closingMinor,
        ...(compared ? [row.compareClosingMinor ?? 0, row.deltaMinor ?? 0] : []),
      ]),
    ),
    csvLine([
      'total',
      '',
      '',
      '',
      '',
      totals.openingMinor,
      totals.debitMinor,
      totals.creditMinor,
      totals.closingMinor,
      ...(compared ? ['', ''] : []),
    ]),
  ];
}

interface BalanceLine {
  key: string;
  account: { number: string; name: string } | null;
  balanceMinor: number;
}
interface BalanceSection {
  key: string;
  side: string;
  lines: BalanceLine[];
  subtotalMinor: number;
}

function balanceCsv(model: Result): string[] {
  const sections = model.sections as BalanceSection[];
  const out = [
    csvLine(['record_type', 'section_key', 'side', 'line_key', 'account_number', 'account_name', 'amount_minor']),
  ];
  for (const section of sections) {
    for (const line of section.lines) {
      out.push(
        csvLine([
          'line',
          section.key,
          section.side,
          line.key,
          line.account?.number ?? '',
          line.account?.name ?? '',
          line.balanceMinor,
        ]),
      );
    }
    out.push(csvLine(['subtotal', section.key, section.side, '', '', '', section.subtotalMinor]));
  }
  out.push(csvLine(['total', 'aktiven', 'aktiven', '', '', '', model.aktivenMinor]));
  out.push(csvLine(['total', 'passiven', 'passiven', '', '', '', model.passivenMinor]));
  return out;
}

interface IncomeLine {
  key: string;
  account: { number: string; name: string } | null;
  amountMinor: number;
}
interface IncomeSection {
  key: string;
  nature: string;
  lines: IncomeLine[];
  subtotalMinor: number;
}

function incomeCsv(model: Result): string[] {
  const sections = model.sections as IncomeSection[];
  const out = [
    csvLine(['record_type', 'section_key', 'nature', 'line_key', 'account_number', 'account_name', 'amount_minor']),
  ];
  for (const section of sections) {
    for (const line of section.lines) {
      out.push(
        csvLine([
          'line',
          section.key,
          section.nature,
          line.key,
          line.account?.number ?? '',
          line.account?.name ?? '',
          line.amountMinor,
        ]),
      );
    }
    out.push(csvLine(['subtotal', section.key, section.nature, '', '', '', section.subtotalMinor]));
  }
  out.push(csvLine(['result', 'reingewinn', '', '', '', '', model.reingewinnMinor]));
  return out;
}

interface LedgerLine {
  date: string;
  entryId: string;
  ref: string | null;
  description: string | null;
  source: string;
  debitMinor: number;
  creditMinor: number;
  runningMinor: number;
}

function ledgerCsv(model: Result): string[] {
  const lines = model.lines as LedgerLine[];
  const account = model.account as { number: string };
  const out = [
    csvLine([
      'record_type',
      'date',
      'entry_id',
      'ref',
      'description',
      'source',
      'debit_minor',
      'credit_minor',
      'running_minor',
    ]),
    csvLine(['opening', '', '', '', '', '', '', '', model.openingMinor]),
  ];
  for (const line of lines) {
    out.push(
      csvLine([
        'line',
        line.date,
        line.entryId,
        line.ref,
        line.description,
        line.source,
        line.debitMinor,
        line.creditMinor,
        line.runningMinor,
      ]),
    );
  }
  out.push(csvLine(['closing', '', '', '', '', '', '', '', model.closingMinor]));
  // The account this Kontoblatt belongs to, so a file on its own is not anonymous.
  out.push(csvLine(['account', account.number, '', '', '', '', '', '', '']));
  return out;
}

// --- PDF -----------------------------------------------------------------------------------------

/** Rappen as a plain decimal, right-alignable, no separator and no symbol: `-1234.55`. */
function money(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Pad or truncate to a fixed width, so a fixed-pitch layout survives a long account name. */
function cell(text: string, width: number, align: 'left' | 'right' = 'left'): string {
  const clipped = text.length > width ? `${text.slice(0, width - 1)}.` : text;
  return align === 'right' ? clipped.padStart(width) : clipped.padEnd(width);
}

/** Escape a PDF literal string, and fold anything outside WinAnsi to `?` rather than corrupting it. */
function pdfText(text: string): string {
  return [...text]
    .map((ch) => (ch.charCodeAt(0) <= 0xff ? ch : '?'))
    .join('')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * The heading over the Erfolgsrechnung's closing figure: the ENACTED wording, resolved by sign.
 *
 * Two defects met on this one line and the fix for both is the same string.
 *
 * **It was not the statute's wording.** OR Art. 959b Abs. 2 Ziff. 11 (SR 220, read off the Fedlex
 * filestore consolidation in force) enacts `Jahresgewinn oder Jahresverlust`. This line printed
 * `Reingewinn oder Reinverlust`, which is the conventional Treuhand wording. That mattered more than
 * a synonym usually does, because `OR_ARTICLE_COVERAGE` in `sections.ts` scores this Absatz 11 of 11
 * and that score is what licenses `income_statement`'s conformance claim. A coverage ledger counting
 * a position as modelled while the filed artifact heads it with a different name is the same class
 * of defect the ledger was built to catch: prose and figures agreeing with nobody checking. The
 * SAME figure already prints as `Jahresgewinn oder Jahresverlust` on the Bilanz, at Abs. 2 Ziff. 3
 * lit. g, out of this very function. One number carried two names across the two statements of one
 * Jahresrechnung.
 *
 * **It printed both outcomes on a statement that had resolved to one.** UX finding F14, against
 * the A08 design's rule that the file and the screen cannot disagree. A Gewinn and a Verlust are
 * different words, and a heading joining them by `oder` says neither: the reader gets the sign off
 * the figure and the heading contributes nothing. So the word follows the sign.
 *
 * The two are NOT in conflict, which is the part worth writing down. What Abs. 2 prescribes is that
 * the position be shown "je einzeln und in der vorgegebenen Reihenfolge"; the `oder` is the
 * legislator enumerating the two outcomes a result can have, not a heading to be transcribed onto a
 * book that has had one of them. `Jahresgewinn` and `Jahresverlust` are both the enacted wording,
 * each with the branch the book did not take dropped.
 *
 * Exactly zero keeps the enacted form verbatim. A book that broke even made neither a Gewinn nor a
 * Verlust, and picking one would be the heading claiming something the figure does not support. It
 * is the one case where `oder` is a statement of fact rather than an unresolved choice.
 */
function erfolgsrechnungResultLabel(reingewinnMinor: number): string {
  if (reingewinnMinor > 0) return 'Jahresgewinn';
  if (reingewinnMinor < 0) return 'Jahresverlust';
  return 'Jahresgewinn oder Jahresverlust';
}

function renderPdf(kind: string, title: string, model: Result): string {
  // The masthead: what this document is, for which period, in which currency. It REPEATS on every
  // page (see `buildMinimalPdf`), because a page 2 that opens on a bare row of figures is a page a
  // Treuhänder cannot identify if it is separated from page 1.
  const head: string[] = [title];
  const period = model.period as { start: string; end: string } | undefined;
  head.push(period !== undefined ? `Periode ${period.start} bis ${period.end}` : `Stichtag ${String(model.asOf ?? '')}`);
  head.push(`Währung ${String(model.baseCurrency ?? '')}`);
  // The Bilanz's coverage limit travels WITH the document, on every page, because the masthead
  // repeats. See `BILANZ_COVERAGE_NOTE` for why the file gets a caveat that the screen's operator
  // could have asked about, and why the other three statements do not.
  if (kind === 'balance') head.push(BILANZ_COVERAGE_NOTE);
  head.push('');

  const rows: string[] = [];

  if (kind === 'trial') {
    head.push(`${cell('Konto', 8)}${cell('Bezeichnung', 34)}${cell('Eröffnung', 14, 'right')}${cell('Soll', 14, 'right')}${cell('Haben', 14, 'right')}${cell('Saldo', 14, 'right')}`);
    for (const row of model.rows as TrialRow[]) {
      rows.push(
        `${cell(row.account.number, 8)}${cell(row.account.name, 34)}${cell(money(row.openingMinor), 14, 'right')}${cell(money(row.debitMinor), 14, 'right')}${cell(money(row.creditMinor), 14, 'right')}${cell(money(row.closingMinor), 14, 'right')}`,
      );
    }
    const t = model.totals as { openingMinor: number; debitMinor: number; creditMinor: number; closingMinor: number };
    rows.push('');
    rows.push(
      `${cell('', 8)}${cell('Total', 34)}${cell(money(t.openingMinor), 14, 'right')}${cell(money(t.debitMinor), 14, 'right')}${cell(money(t.creditMinor), 14, 'right')}${cell(money(t.closingMinor), 14, 'right')}`,
    );
  } else if (kind === 'balance') {
    for (const section of model.sections as (BalanceSection & { labels: { de: string } })[]) {
      rows.push(section.labels.de);
      for (const line of section.lines) {
        // A computed equity position carries STATUTORY labels (OR Art. 959a Abs. 2 Ziff. 3 lit. f and
        // lit. g) and `account: null`. Falling back to `line.key` printed the internal identifiers
        // `ergebnisvortrag` and `jahresergebnis` on a signable Bilanz, which is not a position name
        // the article knows. The key is the last resort and now only reachable if a line ever ships
        // without labels at all.
        const label =
          line.account === null
            ? ((line as { labels?: { de?: string } }).labels?.de ?? line.key)
            : `${line.account.number} ${line.account.name}`;
        rows.push(`  ${cell(label, 60)}${cell(money(line.balanceMinor), 16, 'right')}`);
      }
      rows.push(`  ${cell('Zwischentotal', 60)}${cell(money(section.subtotalMinor), 16, 'right')}`);
      rows.push('');
    }
    rows.push(`${cell('Total Aktiven', 62)}${cell(money(model.aktivenMinor as number), 16, 'right')}`);
    rows.push(`${cell('Total Passiven', 62)}${cell(money(model.passivenMinor as number), 16, 'right')}`);
  } else if (kind === 'income') {
    for (const section of model.sections as (IncomeSection & { labels: { de: string } })[]) {
      rows.push(`${cell(section.labels.de, 62)}${cell(money(section.subtotalMinor), 16, 'right')}`);
      for (const line of section.lines) {
        rows.push(`  ${cell(`${line.account?.number ?? line.key} ${line.account?.name ?? ''}`, 60)}${cell(money(line.amountMinor), 16, 'right')}`);
      }
    }
    rows.push('');
    rows.push(`${cell(erfolgsrechnungResultLabel(model.reingewinnMinor as number), 62)}${cell(money(model.reingewinnMinor as number), 16, 'right')}`);
  } else {
    const account = model.account as { number: string; name: string };
    head.push(`Konto ${account.number} ${account.name}`);
    head.push('');
    head.push(`${cell('Datum', 12)}${cell('Beleg', 14)}${cell('Text', 34)}${cell('Soll', 12, 'right')}${cell('Haben', 12, 'right')}${cell('Saldo', 14, 'right')}`);
    rows.push(`${cell('', 12)}${cell('', 14)}${cell('Eröffnungssaldo', 34)}${cell('', 12)}${cell('', 12)}${cell(money(model.openingMinor as number), 14, 'right')}`);
    for (const line of model.lines as LedgerLine[]) {
      rows.push(
        `${cell(line.date, 12)}${cell(line.ref ?? '', 14)}${cell(line.description ?? '', 34)}${cell(money(line.debitMinor), 12, 'right')}${cell(money(line.creditMinor), 12, 'right')}${cell(money(line.runningMinor), 14, 'right')}`,
      );
    }
    rows.push(`${cell('', 12)}${cell('', 14)}${cell('Schlusssaldo', 34)}${cell('', 12)}${cell('', 12)}${cell(money(model.closingMinor as number), 14, 'right')}`);
  }

  rows.push('');
  rows.push(
    model.reconciles === true
      ? 'Abstimmung: erfüllt'
      : model.reconciles === false
        ? 'Abstimmung: NICHT erfüllt'
        : 'Abstimmung: nicht ausgewiesen',
  );
  return buildMinimalPdf(head, rows);
}

/**
 * The page geometry, in PDF user space units (1/72 inch), stated ONCE.
 *
 * These were three scattered literals and they contradicted each other: the MediaBox said landscape
 * A4 (height 595) while the first baseline was written at y=800, a portrait-page number copied from
 * `sales/invoice.ts`, whose MediaBox really is `[0 0 595 842]`. PDF user space has its origin at the
 * BOTTOM-LEFT, so y=800 on a 595-high page is 205 units ABOVE the paper. Every row from the title
 * down to row 18 was placed off the top edge and simply never rendered: a Bilanz whose exported PDF
 * opened mid-way through the Passiven, printed "Total Aktiven" for a list of Aktiven it did not
 * show, and stamped "Abstimmung: erfüllt" under it.
 *
 * That is why the page height and the first baseline are now DERIVED from one another rather than
 * written down twice. `test/reports/export.test.mjs` asserts the derivation from the rendered bytes,
 * against the MediaBox the same file declares, so the two cannot drift apart again.
 */
const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = 30;
const FONT_SIZE = 8;
const LEADING = 11;
/** The first row's baseline: a full font size below the top margin, so the ascenders clear the edge. */
const FIRST_BASELINE = PAGE_HEIGHT - MARGIN - FONT_SIZE;
/** The lowest baseline a body row may take, leaving the running foot its own band. */
const BODY_FLOOR = MARGIN + 14;
/** The running foot ("Seite k von n"), inside the bottom margin. */
const FOOTER_BASELINE = 24;
/** How many rows fit between the two, inclusive. */
const ROWS_PER_PAGE = Math.floor((FIRST_BASELINE - BODY_FLOOR) / LEADING) + 1;

/** One `BT ... ET` text-showing block at an absolute position. */
function textAt(x: number, y: number, text: string): string {
  return `BT /F1 ${FONT_SIZE} Tf 1 0 0 1 ${x} ${y} Tm (${pdfText(text)}) Tj ET`;
}

/**
 * A minimal, valid PDF from a repeating masthead and a list of body rows, in Courier so the
 * fixed-width layout above lines up.
 *
 * ## It PAGINATES, and that is not a nicety
 *
 * The previous version emitted one page and placed every row on it at a descending y. Only a y
 * inside the MediaBox renders, so a statement longer than the page did not merely overflow: the
 * surplus rows were written into the content stream, counted by anything that searched the file for
 * them, and drawn nowhere. A 60-account Saldenbilanz produced a PDF that CONTAINED all 60 accounts
 * and SHOWED 54. Silent truncation and a silent late start are the same defect with opposite signs,
 * and a signable document may do neither: the reader has no way to tell a short book from a lost
 * page. So the rows are split across as many pages as they need, the masthead repeats, and every
 * page states its own number and the total.
 *
 * ## Still a second copy of A11's assembler, deliberately, and now MORE so
 *
 * The core ships no PDF dependency, and one added for a report would be a dependency on the money
 * path's print surface. `sales/invoice.ts` keeps its own copy. Extracting a shared helper was
 * reconsidered here and REJECTED on the evidence: the two callers have diverged further, not less.
 * This one paginates a list of text rows over N pages in Courier with `/WinAnsiEncoding` (the
 * umlauts in "Umlaufvermögen" are not optional); A11's draws a single page in Helvetica with vector
 * QR graphics and a `%SwissQR:` payload comment. A shared function would be the union of both
 * signatures, would live across a capability boundary A11 owns, and would put a report's layout
 * change one edit away from the invoice a customer receives. Two honest copies beat one helper that
 * serves neither.
 */
function buildMinimalPdf(head: readonly string[], rows: readonly string[]): string {
  // The masthead eats into every page's row budget, so a pathological head cannot leave zero rows.
  const bodyPerPage = Math.max(1, ROWS_PER_PAGE - head.length);
  const pages: string[][] = [];
  for (let i = 0; i < rows.length; i += bodyPerPage) pages.push(rows.slice(i, i + bodyPerPage));
  // A statement with no body rows at all is still one page: the masthead and the reconciliation line
  // are the answer, and a zero-page PDF is not a document.
  if (pages.length === 0) pages.push([]);

  const contents = pages.map((page, index) => {
    const lines = [...head, ...page].map((row, i) => textAt(MARGIN, FIRST_BASELINE - i * LEADING, row));
    lines.push(textAt(MARGIN, FOOTER_BASELINE, `Seite ${index + 1} von ${pages.length}`));
    return lines.join('\n');
  });

  // Objects 1..3 are fixed; each page then takes a Page and a Contents, in that order.
  const pageObjectId = (index: number) => 4 + index * 2;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObjectId(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
  ];
  contents.forEach((content, index) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObjectId(index) + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return pdf;
}
