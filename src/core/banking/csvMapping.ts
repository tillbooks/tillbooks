/**
 * D178 point 4 (spec A20 §11.3): the CSV COLUMN MAPPING of one Bankkonto, mapped once and reused.
 *
 * No Swiss bank publishes its CSV export layout (searched 21.10.2026; only third-party parsers describe
 * them), so no preset ships: a preset would be a guess. A mapping names, BY HEADER TEXT, the column of
 * each target field; a re-export with reordered columns still maps, and a file whose headers no longer
 * carry a mapped column is refused naming the column (`csv_mapping_invalid`), never read by position.
 *
 * Saved per Bankkonto in `bank_csv_mapping` (one live row per account, §H-TENANT, each change in the
 * audit log). `guessCsvMapping` proposes a first mapping from the header words (de, en, fr) and sample
 * values; the person confirms it in the Studio, or an agent passes its own.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';

/** The target fields a column can be mapped to (§H-ENUM, single point; mirrored by the Studio). */
export const CSV_TARGET_FIELDS = [
  'bookingDate',
  'valueDate',
  'amount',
  'debit',
  'credit',
  'currency',
  'text',
  'counterparty',
  'counterpartyIban',
  'reference',
  'instructedAmount',
  'instructedCurrency',
  'rate',
  'fee',
] as const;
export type CsvTargetField = (typeof CSV_TARGET_FIELDS)[number];

/** The date formats a mapping may name (§H-ENUM, single point). */
export const CSV_DATE_FORMATS = ['dd.mm.yyyy', 'dd.mm.yy', 'yyyy-mm-dd', 'dd/mm/yyyy'] as const;
export type CsvDateFormat = (typeof CSV_DATE_FORMATS)[number];

/** The separators, by the names G09's reader uses (`parseGenericCsv`). */
export const CSV_DELIMITERS = ['semicolon', 'comma', 'tab'] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

/** The encodings a mapping may force (auto-detection otherwise: BOM, strict UTF-8, else Windows-1252). */
export const CSV_ENCODINGS = ['utf-8', 'windows-1252'] as const;
export type CsvEncoding = (typeof CSV_ENCODINGS)[number];

/** The "missing" names a refusal or a preview reports: `amount` stands for "amount, or debit/credit". */
export type CsvMissingField = 'bookingDate' | 'amount';

export interface CsvMapping {
  /** Target field -> the header text of its column. */
  columns: Partial<Record<CsvTargetField, string>>;
  dateFormat: CsvDateFormat;
  /** The decimal separator when the file says it (the other one is then a thousands separator). */
  decimalSeparator?: '.' | ',';
  /** The 1-based line of the header row (a bank export may carry a preamble above it). */
  headerRow?: number;
  delimiter?: CsvDelimiter;
  encoding?: CsvEncoding;
}

/** A mapping read from input or storage, checked for shape (never for the file: `checkMappingAgainst`). */
export function readCsvMapping(raw: unknown): Result<{ mapping: CsvMapping }> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return err('invalid_input', { field: 'mapping', reason: 'an object { columns, dateFormat, ... }' });
  const m = raw as Record<string, unknown>;
  const cols = m['columns'];
  if (cols === null || typeof cols !== 'object' || Array.isArray(cols)) return err('invalid_input', { field: 'mapping.columns', reason: 'an object of target field to header text' });
  const columns: Partial<Record<CsvTargetField, string>> = {};
  for (const [key, value] of Object.entries(cols as Record<string, unknown>)) {
    if (!(CSV_TARGET_FIELDS as readonly string[]).includes(key)) {
      return err('invalid_input', { field: `mapping.columns.${key}`, allowed: [...CSV_TARGET_FIELDS] });
    }
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string' || value.length > 200) return err('invalid_input', { field: `mapping.columns.${key}`, reason: 'the header text of a column' });
    columns[key as CsvTargetField] = value;
  }
  const dateFormat = m['dateFormat'];
  if (typeof dateFormat !== 'string' || !(CSV_DATE_FORMATS as readonly string[]).includes(dateFormat)) {
    return err('invalid_input', { field: 'mapping.dateFormat', allowed: [...CSV_DATE_FORMATS] });
  }
  const mapping: CsvMapping = { columns, dateFormat: dateFormat as CsvDateFormat };
  const dec = m['decimalSeparator'];
  if (dec !== undefined && dec !== null) {
    if (dec !== '.' && dec !== ',') return err('invalid_input', { field: 'mapping.decimalSeparator', allowed: ['.', ','] });
    mapping.decimalSeparator = dec;
  }
  const headerRow = m['headerRow'];
  if (headerRow !== undefined && headerRow !== null) {
    if (!Number.isSafeInteger(headerRow) || (headerRow as number) < 1 || (headerRow as number) > 200) return err('invalid_input', { field: 'mapping.headerRow', reason: 'a line number from 1 to 200' });
    mapping.headerRow = headerRow as number;
  }
  const delimiter = m['delimiter'];
  if (delimiter !== undefined && delimiter !== null) {
    if (typeof delimiter !== 'string' || !(CSV_DELIMITERS as readonly string[]).includes(delimiter)) return err('invalid_input', { field: 'mapping.delimiter', allowed: [...CSV_DELIMITERS] });
    mapping.delimiter = delimiter as CsvDelimiter;
  }
  const encoding = m['encoding'];
  if (encoding !== undefined && encoding !== null) {
    if (typeof encoding !== 'string' || !(CSV_ENCODINGS as readonly string[]).includes(encoding)) return err('invalid_input', { field: 'mapping.encoding', allowed: [...CSV_ENCODINGS] });
    mapping.encoding = encoding as CsvEncoding;
  }
  return ok({ mapping });
}

/**
 * What a mapping lacks against a file's headers: the required targets it leaves unmapped
 * (`bookingDate`; `amount` meaning "amount, or debit and/or credit") and the mapped header texts the
 * file does not carry. Both empty means the mapping reads the file.
 */
export function checkMappingAgainst(mapping: CsvMapping, headers: readonly string[]): { missing: CsvMissingField[]; unknownColumns: string[] } {
  const missing: CsvMissingField[] = [];
  if (mapping.columns.bookingDate === undefined) missing.push('bookingDate');
  if (mapping.columns.amount === undefined && mapping.columns.debit === undefined && mapping.columns.credit === undefined) missing.push('amount');
  const have = new Set(headers);
  const unknownColumns = [...new Set(Object.values(mapping.columns).filter((h): h is string => h !== undefined && !have.has(h)))];
  return { missing, unknownColumns };
}

// --- The first guess ---------------------------------------------------------------------------------

/** Header words per target, de/en/fr, in the order a header is tried against the targets. */
const GUESS: readonly { field: CsvTargetField; re: RegExp }[] = [
  { field: 'valueDate', re: /valuta|value\s*date|wertstellung|date\s+de\s+valeur/i },
  { field: 'bookingDate', re: /^(buchungs?datum|buchungstag|datum|date|booking\s*date|transaction\s*date|abschlussdatum|date\s+de\s+comptabilisation|date\s+comptable)$/i },
  { field: 'debit', re: /belastung|^soll$|debit|lastschrift|ausgang|d(é|e)bit|abfluss/i },
  { field: 'credit', re: /gutschrift|^haben$|credit|eingang|cr(é|e)dit|zufluss/i },
  { field: 'instructedAmount', re: /original\s*betrag|fremdw(ä|ae)hrungs?betrag|original\s*amount|montant\s+original/i },
  { field: 'instructedCurrency', re: /original\s*w(ä|ae)hrung|original\s*currency|devise\s+originale/i },
  { field: 'fee', re: /geb(ü|ue)hr|spesen|kommission|\bfee\b|frais/i },
  { field: 'rate', re: /\bkurs\b|wechselkurs|exchange\s*rate|\brate\b|\bcours\b|\btaux\b/i },
  { field: 'amount', re: /^(betrag|amount|montant|summe)(\s*\(?[a-z]{3}\)?)?$|betrag/i },
  { field: 'currency', re: /^(w(ä|ae)hrung|currency|devise|whg\.?)$/i },
  { field: 'counterpartyIban', re: /iban|kontonummer|account\s*number/i },
  { field: 'counterparty', re: /empf(ä|ae)nger|auftraggeber|beg(ü|ue)nstigte|gegenpartei|counterparty|payee|payer|b(é|e)n(é|e)ficiaire|^name$/i },
  { field: 'reference', re: /referenz|reference|r(é|e)f(é|e)rence|^ref\.?$/i },
  { field: 'text', re: /buchungstext|beschreibung|^text$|description|verwendungszweck|avisierungstext|mitteilung|libell(é|e)|details|zahlungsgrund/i },
];

/** The longest header and sample cell the guess reads; longer ones are skipped, never matched. */
const GUESS_HEADER_MAX = 200;
const GUESS_CELL_MAX = 64;

/** The date format of sample values, or null when they disagree with every format. */
export function guessDateFormat(samples: readonly string[]): CsvDateFormat | null {
  const values = samples.filter((s) => s.length <= GUESS_CELL_MAX).map((s) => s.trim()).filter((s) => s !== '');
  if (values.length === 0) return null;
  const all = (re: RegExp) => values.every((v) => re.test(v));
  if (all(/^\d{4}-\d{2}-\d{2}/)) return 'yyyy-mm-dd';
  if (all(/^\d{1,2}\.\d{1,2}\.\d{4}$/)) return 'dd.mm.yyyy';
  if (all(/^\d{1,2}\.\d{1,2}\.\d{2}$/)) return 'dd.mm.yy';
  if (all(/^\d{1,2}\/\d{1,2}\/\d{4}$/)) return 'dd/mm/yyyy';
  return null;
}

/** The decimal separator sample amounts show, or undefined when they do not say. */
export function guessDecimalSeparator(samples: readonly string[]): '.' | ',' | undefined {
  let dot = 0;
  let comma = 0;
  for (const raw of samples) {
    if (raw.length > GUESS_CELL_MAX) continue;
    const v = raw.trim().replace(/[’' ]/g, '');
    if (/,\d{1,2}-?$/.test(v)) comma += 1;
    else if (/\.\d{1,2}-?$/.test(v)) dot += 1;
  }
  if (comma > 0 && dot === 0) return ',';
  if (dot > 0 && comma === 0) return '.';
  return undefined;
}

/** A first mapping from the header words and the first rows: the person confirms or changes it. */
export function guessCsvMapping(headers: readonly string[], rows: readonly Readonly<Record<string, string>>[]): CsvMapping {
  const columns: Partial<Record<CsvTargetField, string>> = {};
  const used = new Set<string>();
  for (const { field, re } of GUESS) {
    if (columns[field] !== undefined) continue;
    // A header longer than any real column name is never matched (and never fed to a pattern).
    const hit = headers.find((h) => !used.has(h) && h.length <= GUESS_HEADER_MAX && re.test(h.trim()));
    if (hit !== undefined) {
      columns[field] = hit;
      used.add(hit);
    }
  }
  // A lone date column that is not the value date is the booking date.
  if (columns.bookingDate === undefined) {
    const date = headers.find((h) => !used.has(h) && h.length <= GUESS_HEADER_MAX && /datum|date/i.test(h));
    if (date !== undefined) {
      columns.bookingDate = date;
      used.add(date);
    }
  }
  // Debit AND credit columns win over a lone "Betrag"; a lone amount column wins over neither.
  if (columns.amount !== undefined && (columns.debit !== undefined || columns.credit !== undefined)) delete columns.amount;
  const sample = (h: string | undefined): string[] => (h === undefined ? [] : rows.slice(0, 50).map((r) => r[h] ?? ''));
  const dateFormat = guessDateFormat(sample(columns.bookingDate)) ?? 'dd.mm.yyyy';
  const amounts = [...sample(columns.amount), ...sample(columns.debit), ...sample(columns.credit)];
  const decimalSeparator = guessDecimalSeparator(amounts);
  return { columns, dateFormat, ...(decimalSeparator !== undefined ? { decimalSeparator } : {}) };
}

// --- Storage -------------------------------------------------------------------------------------------

interface MappingRow {
  id: string;
  mapping_json: string;
  updated_by: string | null;
  updated_at: string;
}

export interface StoredCsvMapping {
  bankAccountId: string;
  mapping: CsvMapping;
  updatedBy: string | null;
  updatedAt: string;
}

/** The saved mapping of one Bankkonto, or null (§H-TENANT). A stored row this build cannot read is null. */
export function readStoredCsvMapping(ctx: WorkspaceContext, bankAccountId: string): StoredCsvMapping | null {
  const row = ctx.store.db
    .prepare('SELECT id, mapping_json, updated_by, updated_at FROM bank_csv_mapping WHERE workspace_id = ? AND bank_account_id = ?')
    .get(ctx.workspaceId, bankAccountId) as MappingRow | undefined;
  if (row === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.mapping_json);
  } catch {
    return null;
  }
  const read = readCsvMapping(parsed);
  return read.ok ? { bankAccountId, mapping: read.mapping, updatedBy: row.updated_by, updatedAt: row.updated_at } : null;
}

/** Write (insert or replace) one account's mapping inside the caller's transaction, with an audit row. */
export function writeCsvMapping(ctx: WorkspaceContext, bankAccountId: string, mapping: CsvMapping): StoredCsvMapping {
  const now = ctx.clock.now();
  const json = JSON.stringify(mapping);
  const existing = ctx.store.db
    .prepare('SELECT id FROM bank_csv_mapping WHERE workspace_id = ? AND bank_account_id = ?')
    .get(ctx.workspaceId, bankAccountId) as { id: string } | undefined;
  let id: string;
  if (existing === undefined) {
    id = ctx.ids.next('bcsvmap');
    ctx.store.db
      .prepare('INSERT INTO bank_csv_mapping (id, workspace_id, bank_account_id, mapping_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ctx.workspaceId, bankAccountId, json, ctx.actor, now);
  } else {
    id = existing.id;
    ctx.store.db
      .prepare('UPDATE bank_csv_mapping SET mapping_json = ?, updated_by = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(json, ctx.actor, now, ctx.workspaceId, id);
  }
  // The mapping is a setting OF the Bankkonto: recorded as an update of it, in the audit vocabulary the
  // Studio already speaks (`bank_account` / `update`), so no new kind is minted for one row.
  ctx.audit.record({ entityKind: 'bank_account', entityId: bankAccountId, action: 'update', actor: ctx.actor, at: now });
  return { bankAccountId, mapping, updatedBy: ctx.actor, updatedAt: now };
}

function readAccount(ctx: WorkspaceContext, bankAccountId: unknown): { id: string } | Err {
  if (typeof bankAccountId !== 'string' || bankAccountId.length === 0) return err('invalid_input', { field: 'bankAccountId' });
  const account = ctx.store.db
    .prepare('SELECT id FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, bankAccountId) as { id: string } | undefined;
  return account ?? err('needs_bank_account', { bankAccountId });
}

export type GetBankCsvMappingOk = { bankAccountId: string; mapping: CsvMapping | null; updatedBy: string | null; updatedAt: string | null };

/** `get_bank_csv_mapping`: the saved mapping of one Bankkonto, or `mapping: null`. A pure read. */
export function getBankCsvMapping(ctx: WorkspaceContext, input: { bankAccountId?: unknown }): Result<GetBankCsvMappingOk> {
  const account = readAccount(ctx, input.bankAccountId);
  if ((account as { ok?: unknown }).ok === false) return account as Err;
  const accountId = (account as { id: string }).id;
  const stored = readStoredCsvMapping(ctx, accountId);
  return ok<GetBankCsvMappingOk>({
    bankAccountId: accountId,
    mapping: stored?.mapping ?? null,
    updatedBy: stored?.updatedBy ?? null,
    updatedAt: stored?.updatedAt ?? null,
  });
}

export type SetBankCsvMappingOk = { bankAccountId: string; mapping: CsvMapping };

/**
 * `set_bank_csv_mapping`: save one Bankkonto's mapping (the shape is checked; the file is checked at
 * preview and import). Needs `pay`, the right that imports statements. Idempotent per key.
 */
export function setBankCsvMapping(
  ctx: WorkspaceContext,
  input: { bankAccountId?: unknown; mapping?: unknown; idempotencyKey?: unknown },
): Result<SetBankCsvMappingOk> {
  const capable = ctx.capabilities.assert('pay');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) return err('invalid_input', { field: 'idempotencyKey' });
  const account = readAccount(ctx, input.bankAccountId);
  if ((account as { ok?: unknown }).ok === false) return account as Err;
  const accountId = (account as { id: string }).id;
  const read = readCsvMapping(input.mapping);
  if (!read.ok) return read;
  const mapping = read.mapping;
  const scopedKey = JSON.stringify(['set_bank_csv_mapping', accountId, input.idempotencyKey]);
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'set_bank_csv_mapping', () => {
    const saved = writeCsvMapping(ctx, accountId, mapping);
    return ok<SetBankCsvMappingOk>({ bankAccountId: saved.bankAccountId, mapping: saved.mapping });
  });
}
