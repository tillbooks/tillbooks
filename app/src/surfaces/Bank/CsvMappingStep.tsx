/**
 * A20 §11.7 and §13.2 (D205): THE ONE MAPPING STEP of a bank's tabular export (a CSV, or the same export as
 * an Excel workbook), used by "Kontoauszug importieren" (`ImportDialog`) and by "Lücke schliessen"
 * (`GapRepairDialog`), so the two never read the same file differently.
 *
 * `useCsvPreview` asks the engine (`bank_csv_preview`) for the file's layout, its first rows and the mapping
 * it would use (the Bankkonto's saved one, a known export layout, or the guess from the headings), and
 * re-reads the file when the person picks another separator, header row or worksheet. `CsvMappingStep`
 * shows the first rows as a table, one shared `Select` per target field (the required ones marked), the date
 * format and the decimal separator, and a blocking line that NAMES the missing column. Every figure is the
 * engine's.
 *
 * WHAT THE ENGINE READ (A20 §13.1, critic round 1, M3): beside the raw cells of every sample row stand the date and
 * the SIGNED amount the engine parsed under the current mapping (read again whenever the mapping changes), so a
 * wrong decimal separator (a factor of a hundred) or swapped debit and credit columns (every sign flipped) is seen
 * before the import; a separator the file's text amounts contradict blocks, naming the row.
 */
import { useEffect, useState } from 'react';

import { isErr, type Err } from '../../lib/client';
import type { TillClient } from '../../lib/client';
import { useT, formatDate, formatMoney } from '../../i18n';
import { Select } from '../../components/Select';
import '../../components/DataTable.css';

/** The CSV target fields, in the order the mapping step lists them (the engine's `CSV_TARGET_FIELDS`). */
export const CSV_FIELDS = [
  'bookingDate',
  'valueDate',
  'amount',
  'debit',
  'credit',
  'text',
  'counterparty',
  'counterpartyIban',
  'reference',
  'currency',
  'instructedAmount',
  'instructedCurrency',
  'rate',
  'fee',
  'balance',
  'purpose',
] as const;
export type CsvField = (typeof CSV_FIELDS)[number];
const CSV_DATE_FORMATS = ['dd.mm.yyyy', 'dd.mm.yy', 'yyyy-mm-dd', 'dd/mm/yyyy'] as const;
/** The amount group: one signed column, or debit and/or credit. */
export const AMOUNT_FIELDS: readonly CsvField[] = ['amount', 'debit', 'credit'];

export interface CsvMappingDraft {
  columns: Partial<Record<CsvField, string>>;
  dateFormat: string;
  decimalSeparator?: '.' | ',';
  headerRow?: number;
  delimiter?: string;
  encoding?: string;
  /** A20 §12: carried as the engine gave them (a preset sets them); not edited here. */
  rowOrder?: string;
  referenceSuffix?: string;
  counterpartyCut?: string;
}

export interface CsvPreview {
  headers: string[];
  rows: string[][];
  rowCount: number;
  mapping: CsvMappingDraft;
  mappingSource: 'given' | 'saved' | 'guessed';
  /** The layout the file was read with (detected, or the one asked for). */
  delimiter: string;
  headerRow: number;
  /** TILL's guess from the headings under that layout. */
  guessedMapping: CsvMappingDraft | null;
  /** A20 §12: the known export layout the headings are (`zkb_account_statement`), or null. */
  preset: string | null;
  /** A20 §12: the Bankkonto is fed over EBICS (a CSV goes in only as a gap fill). */
  fedAccount: boolean;
  /** A20 §13.1: a workbook, and its worksheets. */
  container: 'csv' | 'xlsx';
  sheets: string[];
  sheet: string | null;
  /** What the engine read under the preview's mapping. */
  parsed: CsvParsed;
}

/** One sample row as the engine read it (`bank_csv_preview` `sample`). */
export interface CsvSampleRow {
  row: number;
  bookingDate: string | null;
  amountMinor: number | null;
  error: string | null;
}

/** What the engine read under ONE mapping: the sample, each raw row's file line, and a separator contradiction. */
export interface CsvParsed {
  /** The mapping these figures belong to (JSON), so a stale reading is never shown as the current one. */
  mappingKey: string;
  lines: number[];
  sample: CsvSampleRow[];
  separatorMismatch: { row: number; column: string } | null;
}

function readParsed(b: Record<string, unknown>, mapping: unknown): CsvParsed {
  const sample = Array.isArray(b.sample)
    ? (b.sample as Record<string, unknown>[])
        .filter((r) => r !== null && typeof r === 'object' && typeof r.row === 'number')
        .map((r) => ({
          row: r.row as number,
          bookingDate: typeof r.bookingDate === 'string' ? r.bookingDate : null,
          amountMinor: typeof r.amountMinor === 'number' ? r.amountMinor : null,
          error: typeof r.error === 'string' ? r.error : null,
        }))
    : [];
  const m = b.separatorMismatch as { row?: unknown; column?: unknown } | null | undefined;
  return {
    mappingKey: JSON.stringify(mapping ?? null),
    lines: Array.isArray(b.lines) ? (b.lines as unknown[]).filter((l): l is number => typeof l === 'number') : [],
    sample,
    separatorMismatch: m !== null && m !== undefined && typeof m.row === 'number' && typeof m.column === 'string' ? { row: m.row, column: m.column } : null,
  };
}

/** A bank's tabular export as the dialogs hold it: its bytes, and what its content says it is. */
export interface TabularFile {
  name: string;
  /** `xlsx` for a zip or an OLE file (the engine refuses an OLE as xls_unsupported), else `csv`. */
  format: 'csv' | 'xlsx';
  base64: string;
}

/** The separators a person can pick when the detection chose wrong (critic M3). */
const CSV_DELIMITER_CHOICES = ['semicolon', 'comma', 'tab'] as const;
/** The rows a person can name as the one with the column names. */
const CSV_HEADER_ROW_CHOICES = Array.from({ length: 30 }, (_, i) => i + 1);

/** The presets the step names (the engine's `CSV_PRESET_IDS`). */
const KNOWN_PRESETS = new Set(['zkb_account_statement']);

/** A20 §13.2: what a file IS, read off its first bytes, never its name. */
export function sniffBytes(bytes: Uint8Array): 'xlsx' | 'xml' | 'text' | 'binary' {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'xlsx';
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'xlsx';
  // A NUL byte in the head is no text table (a PDF, an image): it is not sent anywhere.
  for (let k = 0; k < bytes.length && k < 512; k += 1) if (bytes[k] === 0) return 'binary';
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && i < 512 && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i += 1;
  return bytes[i] === 0x3c ? 'xml' : 'text';
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A picked file's bytes (a test double without `arrayBuffer` falls back to its text). */
export async function fileBytesOf(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new TextEncoder().encode(await file.text());
}

/** What a CSV mapping lacks against the file's headings, as the step names it. */
export function mappingGaps(mapping: CsvMappingDraft, headers: readonly string[]): { missing: ('bookingDate' | 'amount')[]; unknown: string[] } {
  const missing: ('bookingDate' | 'amount')[] = [];
  if (mapping.columns.bookingDate === undefined) missing.push('bookingDate');
  if (AMOUNT_FIELDS.every((f) => mapping.columns[f] === undefined)) missing.push('amount');
  const unknown = [...new Set(Object.values(mapping.columns).filter((h): h is string => h !== undefined && !headers.includes(h)))];
  return { missing, unknown };
}

export function readPreview(body: unknown): CsvPreview | null {
  const b = body as Partial<CsvPreview> | null;
  if (b === null || typeof b !== 'object' || !Array.isArray(b.headers) || !Array.isArray(b.rows) || b.mapping === undefined) return null;
  const m = b.mapping as CsvMappingDraft;
  const g = b.guessedMapping as CsvMappingDraft | null | undefined;
  return {
    headers: b.headers.filter((h): h is string => typeof h === 'string'),
    rows: b.rows as string[][],
    rowCount: typeof b.rowCount === 'number' ? b.rowCount : b.rows.length,
    mapping: { ...m, columns: { ...(m.columns ?? {}) } },
    mappingSource: b.mappingSource === 'given' || b.mappingSource === 'saved' ? b.mappingSource : 'guessed',
    delimiter: typeof b.delimiter === 'string' ? b.delimiter : 'semicolon',
    headerRow: typeof b.headerRow === 'number' ? b.headerRow : 1,
    guessedMapping: g !== null && g !== undefined && typeof g === 'object' ? { ...g, columns: { ...(g.columns ?? {}) } } : null,
    preset: typeof b.preset === 'string' ? b.preset : null,
    fedAccount: b.fedAccount === true,
    container: b.container === 'xlsx' ? 'xlsx' : 'csv',
    sheets: Array.isArray(b.sheets) ? b.sheets.filter((s): s is string => typeof s === 'string') : [],
    sheet: typeof b.sheet === 'string' ? b.sheet : null,
    parsed: readParsed(b as Record<string, unknown>, { ...m, columns: { ...(m.columns ?? {}) } }),
  };
}

/** The layout a person asked for: another separator or header row, or (a workbook) another worksheet. */
export interface CsvLayoutAsk {
  delimiter?: string;
  headerRow?: number;
}

/**
 * The engine's preview of one file for one Bankkonto, read again when the layout or the worksheet changes.
 * A layout the person asked for is read with an empty mapping, so the headings it reveals are guessed afresh.
 */
export function useCsvPreview(args: {
  client: TillClient;
  workspaceId: string;
  accountId: string;
  file: TabularFile | null;
  onError: (error: Err) => void;
  onPreview?: (preview: CsvPreview) => void;
}) {
  const { client, workspaceId, accountId, file, onError, onPreview } = args;
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [mapping, setMapping] = useState<CsvMappingDraft | null>(null);
  // Critic M3: the separator and header row a person asked for when the detection chose wrong.
  const [layout, setLayout] = useState<CsvLayoutAsk | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const layoutKey = layout === null ? '' : JSON.stringify(layout);

  // A new file starts from the detection again.
  useEffect(() => {
    setPreview(null);
    setMapping(null);
    setLayout(null);
    setSheet(null);
  }, [file]);

  useEffect(() => {
    if (file === null || accountId === '') return;
    let live = true;
    setPreviewBusy(true);
    const asked = layoutKey === '' ? null : (JSON.parse(layoutKey) as CsvLayoutAsk);
    const input: Record<string, unknown> = { workspaceId, bankAccountId: accountId, contentBase64: file.base64, format: file.format };
    if (sheet !== null) input.sheet = sheet;
    if (asked !== null) input.mapping = { columns: {}, dateFormat: 'dd.mm.yyyy', ...asked };
    void client.call('bank_csv_preview', input).then((response) => {
      if (!live) return;
      setPreviewBusy(false);
      if (isErr(response.body)) {
        onError(response.body);
        return;
      }
      const read = readPreview(response.body);
      setPreview(read);
      if (read !== null) onPreview?.(read);
      if (read === null) setMapping(null);
      else if (asked === null) setMapping(read.mapping);
      else setMapping({ ...(read.guessedMapping ?? read.mapping), ...asked });
    });
    return () => {
      live = false;
    };
    // `onError` and `onPreview` are callbacks of the dialog; the read depends on the file, account and layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, accountId, workspaceId, client, layoutKey, sheet]);

  // M3: what the engine reads under the CURRENT mapping, read again whenever the person changes it.
  const [parsed, setParsed] = useState<CsvParsed | null>(null);
  const mappingKey = JSON.stringify(mapping);
  useEffect(() => {
    setParsed(null);
    if (file === null || accountId === '' || preview === null || mapping === null) return;
    if (mappingKey === preview.parsed.mappingKey) return;
    if (mappingGaps(mapping, preview.headers).missing.length > 0) return;
    let live = true;
    const input: Record<string, unknown> = { workspaceId, bankAccountId: accountId, contentBase64: file.base64, format: file.format, mapping: JSON.parse(mappingKey) as unknown };
    if (sheet !== null) input.sheet = sheet;
    void client.call('bank_csv_preview', input).then((response) => {
      if (!live || isErr(response.body)) return;
      setParsed(readParsed(response.body as Record<string, unknown>, JSON.parse(mappingKey) as unknown));
    });
    return () => {
      live = false;
    };
    // The reading follows the file, the account, the worksheet and the mapping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, accountId, workspaceId, client, sheet, mappingKey, preview]);
  const current = preview !== null && preview.parsed.mappingKey === mappingKey ? preview.parsed : parsed !== null && parsed.mappingKey === mappingKey ? parsed : null;

  return { preview, previewBusy, mapping, setMapping, setLayout, sheet, setSheet, parsed: current };
}

export interface CsvMappingStepProps {
  baseId: string;
  preview: CsvPreview;
  mapping: CsvMappingDraft;
  onMapping: (mapping: CsvMappingDraft) => void;
  onLayout: (layout: CsvLayoutAsk) => void;
  /** A workbook: the worksheet to read (null: the first). */
  onSheet: (sheet: string) => void;
  /** What the engine read under the current mapping, or null while it is read. */
  parsed: CsvParsed | null;
  /** The Bankkonto's currency, for the parsed amounts. */
  currency?: string;
}

/**
 * The blocking lines of a mapping: one per missing required target and per mapped column the file lacks, and
 * (M3) the separator the file's text amounts contradict.
 */
export function useMappingBlocking(preview: CsvPreview | null, mapping: CsvMappingDraft | null, parsed: CsvParsed | null = null): { gaps: ReturnType<typeof mappingGaps> | null; blocking: string[] } {
  const t = useT();
  const gaps = preview !== null && mapping !== null ? mappingGaps(mapping, preview.headers) : null;
  const blocking =
    gaps === null
      ? []
      : [
          ...gaps.missing.map((m) => t(`bankInbox.import.csv.missing.${m}`)),
          ...gaps.unknown.map((column) => t('bankInbox.import.csv.unknown', { column })),
          ...(parsed?.separatorMismatch !== null && parsed?.separatorMismatch !== undefined ? [t('bankInbox.import.csv.separatorMismatch', { row: parsed.separatorMismatch.row, column: parsed.separatorMismatch.column })] : []),
        ];
  return { gaps, blocking };
}

export function CsvMappingStep({ baseId, preview, mapping, onMapping, onLayout, onSheet, parsed, currency = 'CHF' }: CsvMappingStepProps) {
  const t = useT();
  const { gaps, blocking } = useMappingBlocking(preview, mapping, parsed);
  const sampleOf = (i: number): CsvSampleRow | undefined => {
    const line = parsed?.lines[i];
    return line === undefined ? undefined : parsed?.sample.find((r) => r.row === line);
  };
  const setColumn = (field: CsvField, header: string) => {
    const columns = { ...mapping.columns };
    if (header === '') delete columns[field];
    else columns[field] = header;
    onMapping({ ...mapping, columns });
  };
  const columnOptions = [{ value: '', label: t('bankInbox.import.csv.none') }, ...preview.headers.map((h) => ({ value: h, label: h }))];
  const xlsx = preview.container === 'xlsx';
  return (
    <>
      <p className="bank-mode__lead">{t('bankInbox.import.csv.lead')}</p>
      <p className="bank-import__match">
        {preview.mappingSource === 'guessed' && preview.preset !== null && KNOWN_PRESETS.has(preview.preset)
          ? t(`bankInbox.import.csv.preset.${preview.preset}`)
          : t(preview.mappingSource === 'saved' ? 'bankInbox.import.csv.saved' : 'bankInbox.import.csv.guessed')}
      </p>
      {xlsx && preview.sheets.length > 1 && (
        <label className="bank-field" htmlFor={`${baseId}-sheet`}>
          <span className="bank-field__label">{t('bankInbox.import.csv.sheet')}</span>
          <Select
            id={`${baseId}-sheet`}
            value={preview.sheet ?? preview.sheets[0] ?? ''}
            onChange={onSheet}
            ariaLabel={t('bankInbox.import.csv.sheet')}
            options={preview.sheets.map((s) => ({ value: s, label: s }))}
          />
        </label>
      )}
      {!xlsx && (
        <label className="bank-field" htmlFor={`${baseId}-delimiter`}>
          <span className="bank-field__label">{t('bankInbox.import.csv.delimiter')}</span>
          <Select
            id={`${baseId}-delimiter`}
            value={mapping.delimiter ?? preview.delimiter}
            onChange={(v) => {
              onMapping({ ...mapping, delimiter: v });
              // Another separator re-reads the file; its header row is detected again.
              onLayout({ delimiter: v });
            }}
            ariaLabel={t('bankInbox.import.csv.delimiter')}
            options={CSV_DELIMITER_CHOICES.map((d) => ({ value: d, label: t(`bankInbox.import.csv.delimiterChoice.${d}`) }))}
          />
        </label>
      )}
      <label className="bank-field" htmlFor={`${baseId}-header-row`}>
        <span className="bank-field__label">{t('bankInbox.import.csv.headerRow')}</span>
        <Select
          id={`${baseId}-header-row`}
          value={String(mapping.headerRow ?? preview.headerRow)}
          onChange={(v) => {
            const headerRow = Number(v);
            if (xlsx) {
              onMapping({ ...mapping, headerRow });
              onLayout({ headerRow });
              return;
            }
            onMapping({ ...mapping, headerRow, delimiter: mapping.delimiter ?? preview.delimiter });
            onLayout({ delimiter: mapping.delimiter ?? preview.delimiter, headerRow });
          }}
          ariaLabel={t('bankInbox.import.csv.headerRow')}
          options={CSV_HEADER_ROW_CHOICES.map((n) => ({ value: String(n), label: t('bankInbox.import.csv.headerRowN', { n }) }))}
        />
      </label>
      <div className="data-table-frame" style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <caption className="visually-hidden">{t('bankInbox.import.csv.preview')}</caption>
          <thead>
            <tr>
              {preview.headers.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
              <th scope="col" className="bank-import__parsed">
                {t('bankInbox.import.csv.parsedDate')}
              </th>
              <th scope="col" className="bank-import__parsed">
                {t('bankInbox.import.csv.parsedAmount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.slice(0, 6).map((row, i) => {
              const read = sampleOf(i);
              return (
                <tr key={i}>
                  {preview.headers.map((h, j) => (
                    <td key={h}>{row[j] ?? ''}</td>
                  ))}
                  <td className="bank-import__parsed t-num">{read?.bookingDate !== null && read?.bookingDate !== undefined ? formatDate(read.bookingDate) : ''}</td>
                  <td className="bank-import__parsed t-num" title={read?.error !== null && read?.error !== undefined ? t(`bankInbox.import.result.skip.${read.error}`) : undefined}>
                    {read === undefined ? '' : read.amountMinor !== null ? formatMoney(read.amountMinor, currency, { signed: true }) : t('bankInbox.import.csv.unread')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="bank-import__match">{t('bankInbox.import.csv.rows', { count: preview.rowCount })}</p>
      <p className="bank-mode__lead">{t('bankInbox.import.csv.amountRule')}</p>
      {CSV_FIELDS.map((field) => {
        const required = field === 'bookingDate' || AMOUNT_FIELDS.includes(field);
        const label = `${t(`bankInbox.import.csv.field.${field}`)}${required ? ` (${t('bankInbox.import.csv.required')})` : ''}`;
        return (
          <label key={field} className="bank-field" htmlFor={`${baseId}-col-${field}`}>
            <span className="bank-field__label">{label}</span>
            <Select
              id={`${baseId}-col-${field}`}
              value={mapping.columns[field] ?? ''}
              onChange={(v) => setColumn(field, v)}
              ariaLabel={label}
              required={field === 'bookingDate'}
              invalid={(field === 'bookingDate' && gaps?.missing.includes('bookingDate') === true) || (AMOUNT_FIELDS.includes(field) && gaps?.missing.includes('amount') === true)}
              options={columnOptions}
            />
          </label>
        );
      })}
      <label className="bank-field" htmlFor={`${baseId}-date-format`}>
        <span className="bank-field__label">{t('bankInbox.import.csv.dateFormat')}</span>
        <Select
          id={`${baseId}-date-format`}
          value={mapping.dateFormat}
          onChange={(v) => onMapping({ ...mapping, dateFormat: v })}
          ariaLabel={t('bankInbox.import.csv.dateFormat')}
          options={CSV_DATE_FORMATS.map((f) => ({ value: f, label: f }))}
        />
      </label>
      <label className="bank-field" htmlFor={`${baseId}-decimal`}>
        <span className="bank-field__label">{t('bankInbox.import.csv.decimal')}</span>
        <Select
          id={`${baseId}-decimal`}
          value={mapping.decimalSeparator ?? ''}
          onChange={(v) => {
            const next: CsvMappingDraft = { ...mapping };
            if (v === '.' || v === ',') next.decimalSeparator = v;
            else delete next.decimalSeparator;
            onMapping(next);
          }}
          ariaLabel={t('bankInbox.import.csv.decimal')}
          options={[
            { value: '', label: t('bankInbox.import.csv.decimalAuto') },
            { value: '.', label: t('bankInbox.import.csv.decimalDot') },
            { value: ',', label: t('bankInbox.import.csv.decimalComma') },
          ]}
        />
      </label>
      {blocking.length > 0 && (
        <div className="bank-mode__warn" role="alert">
          {blocking.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </>
  );
}
