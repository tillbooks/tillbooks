/**
 * A25's client-side read models: the review coverage list and the three filing exports.
 *
 * Every engine payload here is parsed defensively (the wire type is the open `Result`, so a field is
 * `unknown` until this file names it), exactly as `VatReturn/model.ts` parses `vat_return`. Nothing
 * is recomputed: the amount column is JOINED from `list_journal`'s own `total`/`baseTotal` by entry
 * id, so A25 touches no engine read to put a figure beside a review row.
 */

/** A row of the review list: one posted entry with its current review state and its amount. */
export interface ReviewEntry {
  entryId: string;
  date: string;
  ref: string | null;
  description: string | null;
  source: string;
  status: 'open' | 'flagged' | 'approved';
  reviewer: string | null;
  lastEventAt: string | null;
  commentCount: number;
  flagCount: number;
  /** Base-currency minor units, joined from `list_journal`. Null when the join found no amount. */
  amountMinor: number | null;
}

export interface ReviewStatus {
  period: string;
  periodStart: string;
  periodEnd: string;
  total: number;
  approved: number;
  flagged: number;
  open: number;
  entries: ReviewEntry[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function statusOf(value: unknown): ReviewEntry['status'] {
  return value === 'approved' || value === 'flagged' ? value : 'open';
}

/**
 * The base-currency amount of each entry, keyed by id, read out of `list_journal`.
 *
 * `total` is the transaction figure; `baseTotal` is what the books hold, present only on a foreign
 * entry. For a base-currency entry `total` already IS the base figure, so the amount is
 * `baseTotal ?? total`: the one figure that is always in the workspace's own currency.
 */
export function amountsByEntryId(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const record = asRecord(body);
  const entries = record?.entries;
  if (!Array.isArray(entries)) return out;
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (entry === null) continue;
    const id = str(entry.id);
    if (id === null) continue;
    const base = num(entry.baseTotal);
    const total = num(entry.total);
    const minor = base ?? total;
    if (minor !== null) out.set(id, minor);
  }
  return out;
}

/** Parse `review_status`, joining each entry's amount from the `list_journal` map. Null on a shape miss. */
export function parseReviewStatus(body: unknown, amounts: Map<string, number>): ReviewStatus | null {
  const record = asRecord(body);
  if (record === null) return null;
  const period = str(record.period);
  const periodStart = str(record.periodStart);
  const periodEnd = str(record.periodEnd);
  const rawEntries = record.entries;
  if (period === null || periodStart === null || periodEnd === null || !Array.isArray(rawEntries)) {
    return null;
  }
  const entries: ReviewEntry[] = [];
  for (const raw of rawEntries) {
    const entry = asRecord(raw);
    if (entry === null) continue;
    const entryId = str(entry.entryId);
    const date = str(entry.date);
    if (entryId === null || date === null) continue;
    entries.push({
      entryId,
      date,
      ref: str(entry.ref),
      description: str(entry.description),
      source: str(entry.source) ?? '',
      status: statusOf(entry.status),
      reviewer: str(entry.reviewer),
      lastEventAt: str(entry.lastEventAt),
      commentCount: num(entry.commentCount) ?? 0,
      flagCount: num(entry.flagCount) ?? 0,
      amountMinor: amounts.get(entryId) ?? null,
    });
  }
  const approved = entries.filter((e) => e.status === 'approved').length;
  const flagged = entries.filter((e) => e.status === 'flagged').length;
  const open = entries.filter((e) => e.status === 'open').length;
  return {
    period,
    periodStart,
    periodEnd,
    total: entries.length,
    approved,
    flagged,
    open,
    entries,
  };
}

// --- exports ------------------------------------------------------------------------------------

/** One engine artifact (journal / a statement / MWST): base64 bytes under an engine-chosen name. */
export interface ExportArtifact {
  filename: string;
  mediaType: string;
  base64: string;
}

function parseArtifact(value: unknown): ExportArtifact | null {
  const record = asRecord(value);
  if (record === null) return null;
  const filename = str(record.filename);
  const mediaType = str(record.mediaType);
  const base64 = str(record.base64);
  if (filename === null || mediaType === null || base64 === null) return null;
  return { filename, mediaType, base64 };
}

/**
 * The outcome of one export call: the artifacts to save, and whether the period was empty (a NOTICE,
 * not a failure: an empty period exports a header-only file, spec §2).
 */
export interface ExportResult {
  artifacts: ExportArtifact[];
  empty: boolean;
  /**
   * The engine's notice, or null: `empty_period`, `empty_extract` (a filtered journal with no match,
   * D190) or `range_not_whole_months` (statements cut mid-month, D190).
   */
  notice: string | null;
}

/** Parse a single-artifact export (`export_journal`, `export_vat`). Null on a shape miss. */
export function parseSingleArtifact(body: unknown): ExportResult | null {
  const record = asRecord(body);
  if (record === null) return null;
  const artifact = parseArtifact(record.artifact);
  if (artifact === null) return null;
  return { artifacts: [artifact], empty: record.empty === true, notice: str(record.notice) };
}

/** Parse the statements pair (`export_statements`): one artifact per statement. Null on a shape miss. */
export function parseArtifactPair(body: unknown): ExportResult | null {
  const record = asRecord(body);
  if (record === null) return null;
  const list = record.artifacts;
  if (!Array.isArray(list)) return null;
  const artifacts: ExportArtifact[] = [];
  for (const raw of list) {
    const artifact = parseArtifact(raw);
    if (artifact === null) return null;
    artifacts.push(artifact);
  }
  if (artifacts.length === 0) return null;
  return { artifacts, empty: record.empty === true, notice: str(record.notice) };
}

/** Decode the engine's base64 artifact into a Blob the browser saves under the engine's own name. */
export function artifactBlob(artifact: ExportArtifact): Blob {
  const binary = atob(artifact.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: artifact.mediaType });
}

/** Hand the bytes to the browser under the engine's own filename (the A08/A07 export precedent). */
export function saveArtifact(artifact: ExportArtifact): void {
  const url = URL.createObjectURL(artifactBlob(artifact));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = artifact.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// --- the period control -------------------------------------------------------------------------

export type Granularity = 'month' | 'year';

/** The period string the engine parses: `YYYY-MM` for a month, `YYYY` for a calendar year. */
export function periodValue(granularity: Granularity, month: string, year: string): string {
  return granularity === 'month' ? month : year;
}

/** Today's month as `YYYY-MM`, the sensible default a Treuhänder opens the current books on. */
export function currentMonth(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Today's year as `YYYY`. */
export function currentYear(now: Date = new Date()): string {
  return String(now.getFullYear());
}

// --- D190: the export range, the MWST period, the journal source filter ------------------------

/** An inclusive ISO date range, `YYYY-MM-DD` both ends. */
export interface DateRange {
  from: string;
  to: string;
}

/** The quick picks that fill the range; `custom` is any other range (no pick shows as chosen). */
export type RangeShape = 'month' | 'quarter' | 'year' | 'custom';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date `YYYY-MM-DD` (rejects `2026-02-30`). */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The months `first..last` (1-based, inclusive) of `year` as a range. */
function monthsRange(year: number, first: number, last: number): DateRange {
  return { from: `${year}-${pad(first)}-01`, to: `${year}-${pad(last)}-${pad(lastDay(year, last))}` };
}

/** The whole month, quarter or year that contains `anchor` (an ISO date). */
export function rangeOfShape(shape: Exclude<RangeShape, 'custom'>, anchor: string): DateRange {
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  if (shape === 'year') return monthsRange(year, 1, 12);
  if (shape === 'quarter') {
    const first = Math.floor((month - 1) / 3) * 3 + 1;
    return monthsRange(year, first, first + 2);
  }
  return monthsRange(year, month, month);
}

/** Which quick pick a range is exactly, or `custom`. */
export function shapeOfRange(range: DateRange): RangeShape {
  if (!isIsoDate(range.from) || !isIsoDate(range.to)) return 'custom';
  for (const shape of ['month', 'quarter', 'year'] as const) {
    const whole = rangeOfShape(shape, range.from);
    if (whole.from === range.from && whole.to === range.to) return shape;
  }
  return 'custom';
}

/** Today as `YYYY-MM-DD`, in the viewer's own calendar (not UTC). */
export function isoToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The range a deep link opens on (F-07 and D190): `?period=YYYY-MM` is that month, `?period=YYYY` that
 * year; anything else (or nothing) is the current month.
 */
export function rangeFromLink(period: string | null, now: Date = new Date()): DateRange {
  if (period !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return rangeOfShape('month', `${period}-01`);
  if (period !== null && /^\d{4}$/.test(period)) return rangeOfShape('year', `${period}-01-01`);
  return rangeOfShape('month', isoToday(now));
}

/** The MWST period kinds `export_vat` takes (its labels stay fixed, D190: no range for MWST). */
export type VatGranularity = 'quarter' | 'half' | 'month' | 'year';

/** The parts of a MWST period the picker holds. */
export interface VatPeriodParts {
  year: string;
  quarter: string;
  half: string;
  month: string;
}

/** The label `export_vat` parses: `YYYY-Qn`, `YYYY-Hn`, `YYYY-MM` or `YYYY`. */
export function vatPeriodValue(granularity: VatGranularity, parts: VatPeriodParts): string {
  if (granularity === 'quarter') return `${parts.year}-${parts.quarter}`;
  if (granularity === 'half') return `${parts.year}-${parts.half}`;
  if (granularity === 'month') return parts.month;
  return parts.year;
}

/** The quarter (`Q1`..`Q4`) of a `YYYY-MM` month. */
export function quarterOf(month: string): string {
  return `Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`;
}

/** The half-year (`H1`, `H2`) of a `YYYY-MM` month. */
export function halfOf(month: string): string {
  return Number(month.slice(5, 7)) <= 6 ? 'H1' : 'H2';
}

/**
 * The journal "Quelle" values the export filter offers: a MIRROR of `VALID_SOURCES` in
 * `src/core/ledger/postEntry.ts`, in its order (the Journal surface keeps the same mirror). Kept in step
 * by `test/review/export-source-mirror.test.mjs`. Each value has a `journal.source.<value>` label.
 */
export const EXPORT_SOURCES = [
  'manual',
  'invoice',
  'payment',
  'import',
  'agent',
  'reversal',
  'close',
  'fx',
  'purchase',
  'dunning',
  'credit_note',
  'camt',
  'stock',
  'landed_cost',
  'expense_claim',
  'asset_acquisition',
  'asset_depreciation',
  'asset_disposal',
  'inventory_valuation',
  'accrual',
  'provision',
  'vat_settlement',
] as const;
