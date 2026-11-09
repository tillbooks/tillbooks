/**
 * D178 point 4 (spec A20 §11.4): ONE DOOR FOR EVERY STATEMENT FORMAT, and the CSV preview.
 *
 * `import_bank_statement` takes a file as text or as base64 bytes, detects its format (a camt XML, an
 * MT940, else a CSV) and imports every statement in it through the one insertion `importCamt` uses
 * (`insertStatement`), so each line is checked against its exact key AND the cross-format rule, and the
 * answer is the same for every format: imported, duplicates, refused, each skipped line with its stable
 * reason and a sentence, each refused statement with its code and reason.
 *
 *  - camt: every `<Stmt>` of the file (split as `import_camt_files` splits) goes through `importCamt`
 *    itself, in statement-number order, so the EBICS successor rule (A36 §4.4), the camt.054 refusal and
 *    every A20/A39 rule decide exactly as at `import_camt`;
 *  - MT940 (`mt940.ts`) and CSV (`csvStatement.ts`, through the account's saved mapping or the one
 *    handed in): the statement dedupe of A20 (same identity and content is `already_imported`, other
 *    content `statement_amended`), then one transaction per statement. An account fed over EBICS takes
 *    camt only: MT940 or CSV there refuses `bank_feed_account` (the feed is the truth, D139 item 6).
 *
 * Idempotent per call key: the key is scoped by the account, the payload's SHA-256 (the
 * `import_camt_files` convention) AND everything else that changes the answer (critic L5: the format, the
 * mapping, saveMapping, allowDuplicateEntries), so a reused key with another file or a corrected mapping is
 * a new question, never a replay of the stale answer; every statement is deduplicated on its own identity,
 * so dropping the same file again imports nothing twice.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { normalizeIban } from '../setup/iban.js';
import { parseCamt, splitCamt053, hashCamtStatement } from './camt.js';
import type { ParsedBankStatement } from './camt.js';
import { importCamt, insertStatement, existingStatementAnswer } from './camtReconcile.js';
import type { ImportSkippedEntry, NearCrossFormatDuplicate } from './camtReconcile.js';
import { comparePositions, dayEndPosition, isEbicsFedAccount } from './ebics/feed.js';
import type { FeedPosition } from './ebics/feed.js';
import { looksLikeMt940, parseMt940 } from './mt940.js';
import type { ParsedMt940Statement } from './mt940.js';
import { csvStatementOf, decodeStatementBytes, readCsvTable } from './csvStatement.js';
import type { CsvTable, DetectedCsvEncoding } from './csvStatement.js';
import { checkMappingAgainst, guessCsvMapping, presetFor, readCsvMapping, readStoredCsvMapping, writeCsvMapping } from './csvMapping.js';
import type { CsvMapping, CsvMissingField, CsvPresetId } from './csvMapping.js';
import {
  decideFillDuplicates,
  fillBalanceTieMode,
  fillDuplicateMode,
  fillFedAccountMode,
  fillRowsOf,
  fillStatementOf,
  feedEndOf,
  fillTargetsOf,
  planFillParts,
  readFillScope,
  tieFillParts,
} from './csvGapFill.js';
import type { CsvFillBalanceTieMode, CsvFillDuplicateMode, CsvFillScope, FillPart, FillProblem, FillTarget, FillTie } from './csvGapFill.js';
import { accountStatementGaps } from './statementGaps.js';
import type { PossibleDuplicate } from './statementDedupe.js';

/** The formats a caller may name (`auto` detects). */
export const STATEMENT_IMPORT_FORMATS = ['auto', 'camt', 'mt940', 'csv'] as const;
export type StatementImportFormat = (typeof STATEMENT_IMPORT_FORMATS)[number];

/** The largest file one call takes (a year of day-end statements, with room). */
export const STATEMENT_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

/** How much of a file format detection reads. */
const DETECT_HEAD_CHARS = 64 * 1024;

/** At most this many rows in a preview (the table the mapping step shows). */
export const CSV_PREVIEW_ROWS = 20;

/** One sentence per skip reason, for an agent reading the answer (the Studio renders its own words). */
export const SKIP_REASON_TEXT: Readonly<Record<string, string>> = {
  duplicate_entry: 'already in the books: the same bank reference or line was imported before',
  cross_format_duplicate: 'already in the books: the same movement came in through another file format',
  pending: 'an expected entry the bank has not booked yet',
  unreadable_amount: 'the amount could not be read',
  unreadable_date: 'the date could not be read',
  unsupported_status: 'the bank marked the entry neither booked nor pending',
  zero_amount: 'the amount is zero',
  currency_differs: 'the row is in another currency than the bank account',
  not_a_movement: 'the row has no booking date (a total, a carried balance or a note)',
};

const DUPLICATE_REASONS = new Set(['duplicate_entry', 'cross_format_duplicate']);

export interface StatementImportOutcome {
  /** The statement's place in the file, 1-based. */
  part: number;
  outcome: 'imported' | 'already_imported' | 'refused';
  statementId?: string;
  fromDate: string | null;
  toDate: string | null;
  txnCount: number;
  duplicates: number;
  refusedLines: number;
  warnings: string[];
  code?: string;
  reason?: string;
  nearDuplicates?: NearCrossFormatDuplicate[];
}

export type StatementImportSkip = ImportSkippedEntry & { part: number; message: string };

export type ImportBankStatementOk = {
  bankAccountId: string;
  format: 'camt053' | 'mt940' | 'csv';
  fileName: string | null;
  /** How the bytes were read (CSV and MT940 sent as bytes), else null. */
  encoding: DetectedCsvEncoding | null;
  statements: StatementImportOutcome[];
  /** Lines this call added. */
  imported: number;
  /** Lines already in the books (exact, or from another format), including whole statements imported before. */
  duplicates: number;
  /** Lines not imported for any other reason (unreadable, pending, another currency, ...). */
  refused: number;
  skipped: StatementImportSkip[];
  /** CSV: the mapping this call read the file with, and whether it was saved for the account. */
  mapping?: CsvMapping;
  mappingSaved: boolean;
  /** A20 §12: present for a gap fill (`fill`): every stretch, its proof and whether it closed. */
  fill?: CsvFillReport;
};

// --- A20 §12: the gap fill's answer ------------------------------------------------------------------

/** Where one stretch of a fill stands. */
export type CsvFillPartStatus = 'ready' | 'blocked' | 'not_in_file' | 'imported' | 'already_imported' | 'refused';

/** One CSV row of a stretch, as the preview lists it. */
export interface CsvFillLine {
  row: number;
  date: string;
  /** Signed: + money in, - money out. */
  amountMinor: number;
  currency: string;
  text: string | null;
  counterparty: string | null;
  reference: string | null;
  /** The bank's balance after the row, as the CSV states it. */
  balanceMinor: number | null;
  /** The stored line the books already hold for it (`skip_proven`), or null: the fill writes it. */
  inBooks: { bankTxnId: string; by: 'reference' | 'movement' } | null;
  /** Critic r3 C5: a line the fill writes FLAGGED as a possible duplicate of this stored line (it waits for the person). */
  mayBe: { bankTxnId: string; by: 'reference' | 'movement' } | null;
}

export interface CsvFillPartReport {
  /** The `statements[]` part this stretch wrote (1-based), or null when it wrote none. */
  part: number | null;
  status: CsvFillPartStatus;
  /** What the stretch was asked to cover (a gap, the before-feed hole, the named range) and its days. */
  kind: FillTarget['kind'];
  gapId: string | null;
  targetFrom: string;
  targetTo: string;
  /** The days the CSV proves. */
  from: string;
  to: string;
  /** Rows of the CSV on those days; the ones the books already hold; the ones written. */
  rows: number;
  alreadyInBooks: number;
  /** Critic r3 C5: written lines flagged as possible duplicates of a stored line (they wait for the person). */
  flagged: number;
  imported: number;
  /** The bank's balance at the start and the end, as the CSV states it. */
  csvOpeningMinor: number | null;
  csvClosingMinor: number | null;
  /** The fill statement's own balances: the CSV's, moved by rows the books hold in a statement before or after the days. */
  openingMinor: number | null;
  closingMinor: number | null;
  /** The two neighbours in the books, and how the CSV's balances stand against them. */
  before: FillTie;
  after: FillTie;
  problems: { code: FillProblem; row?: number; side?: 'before' | 'after'; differenceMinor?: number }[];
  /** The stretch ties both neighbouring statements and covers every day asked for. */
  closesTarget: boolean;
  /** After the import: the numbered gaps this stretch closed (`statementGaps` no longer lists them). */
  closedGapIds: string[];
  statementId: string | null;
  /** At most `FILL_LINES_SHOWN` rows, in time order. */
  lines: CsvFillLine[];
}

export interface CsvFillReport {
  scope: CsvFillScope['kind'];
  range: { from: string; to: string } | null;
  /** The settings this answer was decided under (D172). */
  balanceTie: CsvFillBalanceTieMode;
  duplicates: CsvFillDuplicateMode;
  /** The order the file's rows stood in. */
  rowOrder: 'newest_first' | 'oldest_first';
  /** Readable rows in the file; rows on no stretch (days the books hold, or outside the gaps). */
  rowsInFile: number;
  rowsOutside: number;
  parts: CsvFillPartReport[];
}

/** The rows one stretch lists in an answer. */
export const FILL_LINES_SHOWN = 50;

/** The problems that keep a stretch out of the books under `bank.csv_fill_balance_tie` = `required`. */
const BLOCKING_PROBLEMS: ReadonlySet<FillProblem> = new Set(['no_balance_column', 'chain_broken', 'untied', 'open_end']);

/** The refusal code and sentence of a blocked stretch: its first problem. */
function fillRefusalOf(part: FillPart): { code: string; reason: string } {
  const p = part.problems.find((x) => BLOCKING_PROBLEMS.has(x.code));
  switch (p?.code) {
    case 'no_balance_column':
      return { code: 'csv_fill_needs_balance', reason: 'the mapping names no balance column, so nothing proves these days are complete: map the running balance (Saldo)' };
    case 'chain_broken':
      return { code: 'csv_fill_chain_broken', reason: `the running balance does not add up at row ${p.row ?? '?'} (a row missing or unreadable, or the rows out of order): nothing of these days was imported` };
    case 'untied': {
      const tie = p.side === 'before' ? part.before : part.after;
      const which = tie.kind === 'statement' ? `the statement of ${tie.date}` : 'the books';
      return {
        code: 'csv_fill_untied',
        reason: `the CSV's balance ${p.side === 'before' ? 'at the start' : 'at the end'} differs from ${which} by ${p.differenceMinor ?? 0} Rappen: nothing of these days was imported`,
      };
    }
    case 'open_end':
      return { code: 'csv_fill_open_end', reason: `the export ends on ${part.to}, inside the days asked for, so their end is not stated: export a few days more, or end the range a day earlier` };
    default:
      return { code: 'refused', reason: 'not imported' };
  }
}

function fillLinesOf(part: FillPart): CsvFillLine[] {
  const inBooks = new Map(part.duplicates.map((d) => [d.row, d]));
  const mayBe = new Map(part.restored.map((d) => [d.row, d]));
  return part.rows.slice(0, FILL_LINES_SHOWN).map((r) => {
    const d = inBooks.get(r.row);
    const m = mayBe.get(r.row);
    return {
      row: r.row,
      date: r.date,
      amountMinor: r.signedMinor,
      currency: r.entry.currency,
      text: r.entry.facts?.bankText ?? r.entry.remittanceText,
      counterparty: r.entry.counterpartyName,
      reference: r.entry.entryRef,
      balanceMinor: r.balanceMinor,
      inBooks: d === undefined ? null : { bankTxnId: d.existingBankTxnId, by: d.by },
      mayBe: m === undefined ? null : { bankTxnId: m.existingBankTxnId, by: m.by },
    };
  });
}

function partReportOf(part: FillPart, status: CsvFillPartStatus, extra: { part?: number | null; imported?: number; statementId?: string | null; closedGapIds?: string[] } = {}): CsvFillPartReport {
  return {
    part: extra.part ?? null,
    status,
    kind: part.target.kind,
    gapId: part.target.gapId ?? null,
    targetFrom: part.target.from,
    targetTo: part.target.to,
    from: part.from,
    to: part.to,
    rows: part.rows.length,
    alreadyInBooks: part.duplicates.length,
    flagged: part.restored.length,
    imported: extra.imported ?? 0,
    csvOpeningMinor: part.csvOpeningMinor,
    csvClosingMinor: part.csvClosingMinor,
    openingMinor: part.openingMinor,
    closingMinor: part.closingMinor,
    before: part.before,
    after: part.after,
    problems: part.problems,
    closesTarget: part.closesTarget,
    closedGapIds: extra.closedGapIds ?? [],
    statementId: extra.statementId ?? null,
    lines: fillLinesOf(part),
  };
}

/** The plan of a fill over one file: the stretches, their proof and their duplicates. Reads, writes nothing. */
function planFill(ctx: WorkspaceContext, account: AccountRow, table: CsvTable, mapping: CsvMapping, scope: CsvFillScope): { parts: FillPart[]; report: Omit<CsvFillReport, 'parts'> } {
  const rows = fillRowsOf(table, mapping, account.currency);
  const gaps = scope.kind === 'gaps' ? accountStatementGaps(ctx, account.id).filter((g) => !g.confirmed && g.filledBy === undefined) : [];
  const targets = fillTargetsOf(ctx, account, scope, gaps, isEbicsFedAccount(ctx, account.id) ? feedEndOf(ctx, account.id) : undefined);
  const parts = planFillParts(rows, targets);
  const duplicates = fillDuplicateMode(ctx);
  if (duplicates === 'skip_proven') decideFillDuplicates(ctx, account.id, mapping, parts);
  tieFillParts(ctx, account, parts);
  const placed = parts.reduce((n, p) => n + p.rows.length, 0);
  return {
    parts,
    report: {
      scope: scope.kind,
      range: scope.kind === 'range' ? { from: scope.from, to: scope.to } : null,
      balanceTie: fillBalanceTieMode(ctx),
      duplicates,
      rowOrder: rows.order,
      rowsInFile: rows.rows.length,
      rowsOutside: rows.rows.length - placed,
    },
  };
}

/** A stretch's status before anything is written. */
function plannedStatus(ctx: WorkspaceContext, account: AccountRow, part: FillPart, tieMode: CsvFillBalanceTieMode, mappingDigest: string): { status: CsvFillPartStatus; statementId: string | null } {
  if (part.problems.some((p) => p.code === 'not_in_file')) return { status: 'not_in_file', statementId: null };
  if (tieMode === 'required' && part.problems.some((p) => BLOCKING_PROBLEMS.has(p.code))) return { status: 'blocked', statementId: null };
  const stmt = fillStatementOf(part, account.currency, mappingDigest, tieMode);
  const answered = existingStatementAnswer(ctx, account.id, stmt, hashCamtStatement(stmt));
  if (answered !== null && answered.ok) return { status: 'already_imported', statementId: answered.statementId };
  return { status: 'ready', statementId: null };
}

/** The mapping's identity inside a fill statement's id: the same days read another way are another statement. */
function mappingDigestOf(mapping: CsvMapping): string {
  return sha256(canonicalJson(mapping)).slice(0, 16);
}

/**
 * A20 §12: write a fill. Every stretch that may be written goes through the one insertion as its own CSV
 * statement (in ONE transaction for the whole file); a blocked stretch is answered `refused` with its
 * reason, a stretch the file does not reach is named and skipped.
 */
function importCsvFill(
  ctx: WorkspaceContext,
  account: AccountRow,
  table: CsvTable,
  mapping: CsvMapping,
  scope: CsvFillScope,
): { outcomes: StatementImportOutcome[]; skips: StatementImportSkip[]; report: CsvFillReport } {
  const { parts, report } = planFill(ctx, account, table, mapping, scope);
  const tieMode = report.balanceTie;
  const digest = mappingDigestOf(mapping);
  const outcomes: StatementImportOutcome[] = [];
  const skips: StatementImportSkip[] = [];
  const written: { part: FillPart; outcome: StatementImportOutcome }[] = [];
  const reports: (CsvFillPartReport | { pending: FillPart })[] = [];
  ctx.store.tx(() => {
    for (const part of parts) {
      if (part.problems.some((p) => p.code === 'not_in_file')) {
        reports.push(partReportOf(part, 'not_in_file'));
        continue;
      }
      const n = outcomes.length + 1;
      if (tieMode === 'required' && part.problems.some((p) => BLOCKING_PROBLEMS.has(p.code))) {
        const why = fillRefusalOf(part);
        outcomes.push({ part: n, outcome: 'refused', fromDate: part.from, toDate: part.to, txnCount: 0, duplicates: 0, refusedLines: part.rows.length, warnings: [], code: why.code, reason: why.reason });
        reports.push(partReportOf(part, 'refused', { part: n }));
        continue;
      }
      const warnings = [...new Set(part.problems.filter((p) => BLOCKING_PROBLEMS.has(p.code)).map((p) => fillRefusalOf({ ...part, problems: [p] }).code))];
      const stmt = fillStatementOf(part, account.currency, digest, tieMode);
      // Critic r2 R1: a row the books seem to hold, imported because no tied neighbour proves it, is FLAGGED
      // naming the line it matched, so it waits for the person and is never counted twice silently.
      const forced = new Map<number, PossibleDuplicate[]>();
      for (const d of part.restored) {
        const entry = part.rows.find((r) => r.row === d.row)?.entry;
        const at = entry === undefined ? -1 : stmt.entries.indexOf(entry);
        if (at >= 0) forced.set(at, [{ bankTxnId: d.existingBankTxnId, reason: d.by === 'reference' ? 'shared_reference' : 'same_date' }]);
      }
      const one = importOneStatement(ctx, account, stmt, n, false, warnings, forced);
      const outcome = { ...one.outcome, duplicates: one.outcome.duplicates + part.duplicates.length };
      outcomes.push(outcome);
      skips.push(...one.skips);
      for (const d of part.duplicates) {
        skips.push({ entryRef: part.rows.find((r) => r.row === d.row)?.entry.entryRef ?? null, reason: 'duplicate_entry', existingBankTxnId: d.existingBankTxnId, row: d.row, part: n, message: SKIP_REASON_TEXT['duplicate_entry'] as string });
      }
      written.push({ part, outcome });
      reports.push({ pending: part });
    }
  });
  // What the books say now: which numbered gaps each written stretch closed.
  const gapsNow = accountStatementGaps(ctx, account.id);
  const byPart = new Map(written.map((w) => [w.part, w.outcome]));
  const final = reports.map((r) => {
    if (!('pending' in r)) return r;
    const outcome = byPart.get(r.pending) as StatementImportOutcome;
    const rowId = outcome.statementId ?? null;
    const closedGapIds = rowId === null ? [] : gapsNow.filter((g) => g.filledBy?.includes(rowId) === true).map((g) => g.gapId);
    return partReportOf(r.pending, outcome.outcome === 'already_imported' ? 'already_imported' : 'imported', { part: outcome.part, imported: outcome.txnCount, statementId: rowId, closedGapIds });
  });
  return { outcomes, skips, report: { ...report, parts: final } };
}

export interface ImportBankStatementInput {
  bankAccountId?: unknown;
  content?: unknown;
  contentBase64?: unknown;
  fileName?: unknown;
  format?: unknown;
  mapping?: unknown;
  saveMapping?: unknown;
  allowDuplicateEntries?: unknown;
  /** A20 §12: fill statement gaps from a CSV: `{}` for the gaps TILL knows, `{ from, to }` for one range. */
  fill?: unknown;
  idempotencyKey?: unknown;
}

interface Payload {
  bytes: Uint8Array | null;
  text: string;
  encoding: DetectedCsvEncoding | null;
  digest: string;
}

/** JSON with every object's keys sorted, so two spellings of one mapping scope one question. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The replay scope of one call (critic L5): the account, the key, the file, and every input that changes the answer. */
function importScopeKey(accountId: string, input: ImportBankStatementInput, digest: string): string {
  const asked = sha256(
    canonicalJson({
      format: input.format ?? 'auto',
      mapping: input.mapping ?? null,
      saveMapping: input.saveMapping ?? true,
      allowDuplicateEntries: input.allowDuplicateEntries ?? false,
      fill: input.fill ?? null,
    }),
  );
  return JSON.stringify(['import_bank_statement', accountId, input.idempotencyKey, digest, asked]);
}

/** A refusal, told apart from any value that carries no `ok` field. */
function isErr<T>(x: T | Err): x is Err {
  return (x as { ok?: unknown }).ok === false;
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The file as text (and bytes when sent as base64), or the refusal naming the field. */
function readPayload(input: { content?: unknown; contentBase64?: unknown }): Payload | Err {
  const hasText = typeof input.content === 'string' && input.content.length > 0;
  const hasBytes = typeof input.contentBase64 === 'string' && input.contentBase64.length > 0;
  if (hasText === hasBytes) {
    return err('invalid_input', { field: 'content', reason: 'exactly one of content (text) or contentBase64 (the file bytes)' });
  }
  if (hasText) {
    const text = input.content as string;
    if (Buffer.byteLength(text, 'utf8') > STATEMENT_IMPORT_MAX_BYTES) return err('invalid_input', { field: 'content', reason: `at most ${STATEMENT_IMPORT_MAX_BYTES} bytes` });
    return { bytes: null, text: text.replace(/^﻿/, ''), encoding: null, digest: sha256(text) };
  }
  const b64 = (input.contentBase64 as string).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return err('invalid_input', { field: 'contentBase64', reason: 'base64 of the file bytes' });
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  if (bytes.length === 0) return err('invalid_input', { field: 'contentBase64', reason: 'an empty file' });
  if (bytes.length > STATEMENT_IMPORT_MAX_BYTES) return err('invalid_input', { field: 'contentBase64', reason: `at most ${STATEMENT_IMPORT_MAX_BYTES} bytes` });
  const decoded = decodeStatementBytes(bytes);
  return { bytes, text: decoded.text, encoding: decoded.encoding, digest: sha256(bytes) };
}

/** camt (an XML with a camt Stmt/Ntfctn/Rpt), MT940 (`:20:` and `:25:`/`:61:`), else CSV. */
export function detectStatementFormat(text: string): 'camt' | 'mt940' | 'csv' {
  // Only the head of the file is looked at, and every repetition is bounded: no file can make it slow.
  const head = text.slice(0, DETECT_HEAD_CHARS).replace(/^﻿/, '').trimStart();
  if (head.startsWith('<') && /<(?:[A-Za-z_][\w.-]{0,40}:)?(?:Stmt|Ntfctn|Rpt|BkToCstmr)[\s>]/.test(head)) return 'camt';
  if (looksLikeMt940(head)) return 'mt940';
  return 'csv';
}

interface AccountRow {
  id: string;
  iban: string;
  currency: string;
  archived: number;
  name: string;
  ledger_account_id: string;
}

function readAccount(ctx: WorkspaceContext, bankAccountId: unknown): AccountRow | Err {
  if (typeof bankAccountId !== 'string' || bankAccountId.length === 0) return err('invalid_input', { field: 'bankAccountId' });
  const account = ctx.store.db
    .prepare('SELECT id, iban, currency, archived, name, ledger_account_id FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, bankAccountId) as AccountRow | undefined;
  return account ?? err('needs_bank_account', { bankAccountId });
}

/** The skips of one statement, each with its part and sentence; and the duplicate / refused counts. */
function skipsOf(part: number, skipped: readonly ImportSkippedEntry[]): { skips: StatementImportSkip[]; duplicates: number; refused: number } {
  const skips = skipped.map((s) => ({ ...s, part, message: SKIP_REASON_TEXT[s.reason] ?? s.reason }));
  const duplicates = skipped.filter((s) => DUPLICATE_REASONS.has(s.reason)).length;
  return { skips, duplicates, refused: skipped.length - duplicates };
}

/** A refusal's code and reason, as an outcome row reads them. */
function refusalOf(res: Result): { code: string; reason?: string } {
  const r = res as unknown as Record<string, unknown>;
  const code = typeof r['error'] === 'string' ? (r['error'] as string) : 'refused';
  const reason = typeof r['reason'] === 'string' ? (r['reason'] as string) : undefined;
  return reason !== undefined ? { code, reason } : { code };
}

/**
 * MT940 and CSV: the A20 statement dedupe, then ONE transaction for the statement and its lines through
 * the one insertion (exact key plus the cross-format rule).
 */
function importOneStatement(
  ctx: WorkspaceContext,
  account: AccountRow,
  stmt: ParsedBankStatement,
  part: number,
  allowDuplicateEntries: boolean,
  warnings: string[],
  forced: ReadonlyMap<number, readonly PossibleDuplicate[]> = new Map(),
): { outcome: StatementImportOutcome; skips: StatementImportSkip[] } {
  const base = { part, fromDate: stmt.fromDate, toDate: stmt.toDate };
  const hash = hashCamtStatement(stmt);
  const answered = existingStatementAnswer(ctx, account.id, stmt, hash);
  if (answered !== null) {
    if (!answered.ok) {
      return { outcome: { ...base, outcome: 'refused', txnCount: 0, duplicates: 0, refusedLines: 0, warnings: [], ...refusalOf(answered) }, skips: [] };
    }
    return {
      outcome: { ...base, outcome: 'already_imported', statementId: answered.statementId, txnCount: 0, duplicates: stmt.entries.length, refusedLines: 0, warnings: [] },
      skips: [],
    };
  }
  const inserted = ctx.store.tx(() => insertStatement(ctx, account, stmt, hash, allowDuplicateEntries, warnings, forced));
  const s = skipsOf(part, inserted.skipped);
  return {
    outcome: {
      ...base,
      outcome: 'imported',
      statementId: inserted.statementId,
      txnCount: inserted.txnCount,
      duplicates: s.duplicates,
      refusedLines: s.refused,
      warnings: inserted.warnings,
      ...(inserted.nearDuplicates !== undefined ? { nearDuplicates: inserted.nearDuplicates } : {}),
    },
    skips: s.skips,
  };
}

/**
 * The account check of ONE MT940 statement (A20 §11.2): an IBAN in `:25:` must be the Bankkonto's; an
 * account number that is the IBAN's account part verifies it; anything else is unverified (a bank's own
 * account formatting is not a published standard this engine can check). `mt940AccountPlan` decides the
 * file as a whole.
 */
function mt940AccountCheck(accountIban: string, field: string, fileIban: string | null): 'ok' | 'unverified' | { fileAccount: string } {
  const own = normalizeIban(accountIban);
  if (fileIban !== null) return normalizeIban(fileIban) === own ? 'ok' : { fileAccount: fileIban };
  const digits = field.split('/').pop()?.replace(/[^0-9]/g, '') ?? '';
  if (digits.length >= 8 && own.replace(/[^0-9]/g, '').endsWith(digits)) return 'ok';
  return 'unverified';
}

/** A `:25:` value as one account identity: the bank's own spelling, without spaces and case. */
function accountIdentityOf(field: string): string {
  return field.replace(/\s+/g, '').toUpperCase();
}

type Mt940AccountVerdict = { kind: 'ok' } | { kind: 'unverified' } | { kind: 'mismatch'; fileAccount: string; reason: string };

/**
 * Critic M2: the account check of a whole MT940 FILE. A Datalink file appends several MT940s, and a bank
 * like ZKB writes `:25:` as its own account number, so one unverified statement may belong to another
 * account of the same customer. Never imported on a warning:
 *  - a statement whose `:25:` is another IBAN, or differs from a statement of the file that VERIFIED as
 *    this Bankkonto's, is refused `account_mismatch`;
 *  - with nothing verified, a file whose statements name DIFFERENT accounts is refused as a whole
 *    (`mt940_several_accounts`, naming them): which one is this Bankkonto's is not knowable here;
 *  - one account named throughout and unverified imports with `account_unverified`, as before.
 */
function mt940AccountPlan(accountIban: string, statements: readonly ParsedMt940Statement[]): Mt940AccountVerdict[] | Err {
  const own = normalizeIban(accountIban);
  const first = statements.map((stmt) => mt940AccountCheck(accountIban, stmt.accountField, stmt.iban));
  const verified = new Set(statements.filter((_, i) => first[i] === 'ok').map((stmt) => accountIdentityOf(stmt.accountField)));
  if (verified.size === 0) {
    const named = [...new Set(statements.filter((_, i) => first[i] === 'unverified').map((stmt) => stmt.accountField.trim()))];
    if (new Set(named.map(accountIdentityOf)).size > 1) {
      return err('mt940_several_accounts', {
        accounts: named,
        reason: `the file holds statements of ${named.length} different accounts (${named.join(', ')}) and none of them is recognisably this Bankkonto (${own}): import each account's statements onto its own Bankkonto`,
      });
    }
  }
  return statements.map((stmt, i) => {
    const check = first[i] as ReturnType<typeof mt940AccountCheck>;
    if (typeof check === 'object') {
      return { kind: 'mismatch', fileAccount: check.fileAccount, reason: `the statement is for ${check.fileAccount}, not for this Bankkonto (${own})` };
    }
    if (check === 'unverified' && verified.size > 0 && !verified.has(accountIdentityOf(stmt.accountField))) {
      const fileAccount = stmt.accountField.trim();
      return {
        kind: 'mismatch',
        fileAccount,
        reason: `the statement is for account ${fileAccount}, another account than the one of this Bankkonto (${own}) the same file names`,
      };
    }
    return { kind: check };
  });
}

/** camt through `importCamt` itself, statement by statement in number order (the `import_camt_files` order). */
function importCamtFile(
  ctx: WorkspaceContext,
  account: AccountRow,
  xml: string,
  allowDuplicateEntries: boolean,
): { outcomes: StatementImportOutcome[]; skips: StatementImportSkip[] } | Err {
  const split = splitCamt053(xml);
  if (!split.ok) return split as Err;
  const pending = split.parts.map((part, i) => {
    const parsed = parseCamt(part);
    const statement = parsed.ok ? parsed.statement : null;
    return {
      xml: part,
      order: i,
      position: statement === null ? null : dayEndPosition(statement),
      fromDate: statement?.fromDate ?? null,
      toDate: statement?.toDate ?? null,
      entries: statement?.entries.length ?? 0,
    };
  });
  pending.sort((a, b) => {
    const pa: FeedPosition | null = a.position;
    const pb: FeedPosition | null = b.position;
    if (pa !== null && pb !== null) return comparePositions(pa, pb) || a.order - b.order;
    if (pa !== null) return -1;
    if (pb !== null) return 1;
    return a.order - b.order;
  });
  const outcomes: StatementImportOutcome[] = [];
  const skips: StatementImportSkip[] = [];
  for (const p of pending) {
    const part = p.order + 1;
    const res = importCamt(ctx, {
      bankAccountId: account.id,
      xml: p.xml,
      allowDuplicateEntries,
      idempotencyKey: `stmt-file:${account.id}:${sha256(p.xml)}`,
    });
    const base = { part, fromDate: p.fromDate, toDate: p.toDate };
    if (!res.ok) {
      outcomes.push({ ...base, outcome: 'refused', txnCount: 0, duplicates: 0, refusedLines: 0, warnings: [], ...refusalOf(res) });
      continue;
    }
    if (res.duplicate) {
      outcomes.push({ ...base, outcome: 'already_imported', statementId: res.statementId, txnCount: 0, duplicates: p.entries, refusedLines: 0, warnings: res.warnings });
      continue;
    }
    const s = skipsOf(part, res.skipped);
    skips.push(...s.skips);
    outcomes.push({
      ...base,
      outcome: 'imported',
      statementId: res.statementId,
      txnCount: res.txnCount,
      duplicates: s.duplicates,
      refusedLines: s.refused,
      warnings: res.warnings,
      ...(res.nearDuplicates !== undefined ? { nearDuplicates: res.nearDuplicates } : {}),
    });
  }
  return { outcomes, skips };
}

/** The mapping a CSV is read with: the one handed in, else the account's saved one. */
function mappingFor(ctx: WorkspaceContext, accountId: string, raw: unknown): { mapping: CsvMapping; given: boolean } | null | Err {
  if (raw !== undefined && raw !== null) {
    const read = readCsvMapping(raw);
    if (!read.ok) return read as Err;
    return { mapping: read.mapping, given: true };
  }
  const stored = readStoredCsvMapping(ctx, accountId);
  return stored === null ? null : { mapping: stored.mapping, given: false };
}

function tableOf(payload: Payload, mapping: Pick<CsvMapping, 'headerRow' | 'delimiter' | 'encoding'> | null): CsvTable {
  const opts = {
    ...(mapping?.headerRow !== undefined ? { headerRow: mapping.headerRow } : {}),
    ...(mapping?.delimiter !== undefined ? { delimiter: mapping.delimiter } : {}),
    ...(mapping?.encoding !== undefined ? { encoding: mapping.encoding } : {}),
  };
  return payload.bytes !== null ? readCsvTable({ bytes: payload.bytes }, opts) : readCsvTable({ text: payload.text }, opts);
}

/** A20 §12: the `fill` input, read: null when absent, the scope, or the refusal (a fill reads a CSV only). */
function fillOf(input: { fill?: unknown }, format: 'camt' | 'mt940' | 'csv'): CsvFillScope | null | Err {
  if (input.fill === undefined || input.fill === null || input.fill === false) return null;
  const read = readFillScope(input.fill);
  if ('field' in read) return err('invalid_input', { field: read.field, reason: read.reason });
  if (format !== 'csv') return err('invalid_input', { field: 'fill', reason: `a gap fill reads a bank CSV export; this file is ${format === 'camt' ? 'a camt' : 'an MT940'}: import it without fill` });
  return read.scope;
}

/**
 * D139 item 6: an account fed over EBICS takes camt only. A20 §12: a gap FILL is the one exception, for the
 * days the feed never delivered, unless `bank.csv_fill_fed_accounts` is `refuse`.
 */
function feedRefusal(ctx: WorkspaceContext, account: AccountRow, format: 'camt' | 'mt940' | 'csv', fill: CsvFillScope | null): Err | null {
  if (format === 'camt' || !isEbicsFedAccount(ctx, account.id)) return null;
  if (fill !== null && fillFedAccountMode(ctx) === 'allow') return null;
  return err('bank_feed_account', {
    bankAccountId: account.id,
    name: account.name,
    format,
    reason:
      fill !== null
        ? 'this Bankkonto is fed over EBICS and the setting bank.csv_fill_fed_accounts is refuse: its statements come from the bank feed only'
        : format === 'csv'
          ? 'this Bankkonto is fed over EBICS: its statements come from the bank feed as camt.053; a CSV export fills only the days the feed never delivered (import it with fill)'
          : 'this Bankkonto is fed over EBICS: its statements come from the bank feed as camt.053, so an MT940 or CSV is not imported here',
  });
}

/**
 * `import_bank_statement` (A20 §11.4): detect, parse, and import every statement of one file onto one
 * Bankkonto. Needs `pay`, the right `import_camt` asserts. Books nothing: every new line waits in the
 * bank inbox.
 */
export function importBankStatement(ctx: WorkspaceContext, input: ImportBankStatementInput): Result<ImportBankStatementOk> {
  const capable = ctx.capabilities.assert('pay');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) return err('invalid_input', { field: 'idempotencyKey' });
  if (input.format !== undefined && (typeof input.format !== 'string' || !(STATEMENT_IMPORT_FORMATS as readonly string[]).includes(input.format))) {
    return err('invalid_input', { field: 'format', allowed: [...STATEMENT_IMPORT_FORMATS] });
  }
  for (const flag of ['saveMapping', 'allowDuplicateEntries'] as const) {
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean') return err('invalid_input', { field: flag });
  }
  if (input.fileName !== undefined && (typeof input.fileName !== 'string' || input.fileName.length > 255)) return err('invalid_input', { field: 'fileName' });
  const account = readAccount(ctx, input.bankAccountId);
  if (isErr(account)) return account;
  if (account.archived === 1) return err('bank_account_archived', { bankAccountId: account.id, name: account.name });
  const payload = readPayload(input);
  if (isErr(payload)) return payload;

  const scopedKey = importScopeKey(account.id, input, payload.digest);
  const replayed = ctx.store.recallIdempotent<Result<ImportBankStatementOk>>(ctx.workspaceId, scopedKey, 'import_bank_statement');
  if (replayed !== undefined) return replayed;

  const named = (input.format ?? 'auto') as StatementImportFormat;
  const format = named === 'auto' ? detectStatementFormat(payload.text) : named;
  const allowDuplicateEntries = input.allowDuplicateEntries === true;
  const fileName = typeof input.fileName === 'string' ? input.fileName : null;
  const fill = fillOf(input, format);
  if (fill !== null && isErr(fill)) return fill;
  const fed = feedRefusal(ctx, account, format, fill);
  if (fed !== null) return fed;

  let outcomes: StatementImportOutcome[] = [];
  let skips: StatementImportSkip[] = [];
  let mappingUsed: CsvMapping | undefined;
  let mappingSaved = false;
  let fillReport: CsvFillReport | undefined;
  let reportFormat: ImportBankStatementOk['format'];

  if (format === 'camt') {
    reportFormat = 'camt053';
    const done = importCamtFile(ctx, account, payload.text, allowDuplicateEntries);
    if (isErr(done)) return done;
    outcomes = done.outcomes;
    skips = done.skips;
  } else if (format === 'mt940') {
    reportFormat = 'mt940';
    const parsed = parseMt940(payload.text);
    if (!parsed.ok) return parsed as Err;
    const plan = mt940AccountPlan(account.iban, parsed.statements);
    if (isErr(plan)) return plan;
    // Every statement in file order: a page's keys read nothing but the page (critic R2-3), so the order
    // the pages come in decides nothing.
    const order = parsed.statements.map((stmt, i) => ({ stmt, i }));
    const answered: { i: number; outcome: StatementImportOutcome; skips: StatementImportSkip[] }[] = [];
    for (const { stmt: parsedStmt, i } of order) {
      const part = i + 1;
      const push = (outcome: StatementImportOutcome, partSkips: StatementImportSkip[] = []): void => {
        answered.push({ i, outcome, skips: partSkips });
      };
      const stmt = parsedStmt;
      const check = plan[i] as Mt940AccountVerdict;
      if (check.kind === 'mismatch') {
        push({
          part,
          outcome: 'refused',
          fromDate: stmt.fromDate,
          toDate: stmt.toDate,
          txnCount: 0,
          duplicates: 0,
          refusedLines: 0,
          warnings: [],
          code: 'account_mismatch',
          reason: check.reason,
        });
        continue;
      }
      const warnings = check.kind === 'unverified' ? ['account_unverified'] : [];
      if (stmt.balanceCurrency !== null && stmt.balanceCurrency !== account.currency) {
        push({
          part,
          outcome: 'refused',
          fromDate: stmt.fromDate,
          toDate: stmt.toDate,
          txnCount: 0,
          duplicates: 0,
          refusedLines: 0,
          warnings: [],
          code: 'currency_mismatch',
          reason: `the statement is in ${stmt.balanceCurrency}, the Bankkonto in ${account.currency}`,
        });
        continue;
      }
      const one = importOneStatement(ctx, account, stmt, part, allowDuplicateEntries, warnings);
      push(one.outcome, one.skips);
    }
    answered.sort((x, y) => x.i - y.i);
    for (const a of answered) {
      outcomes.push(a.outcome);
      skips.push(...a.skips);
    }
  } else {
    reportFormat = 'csv';
    const resolved = mappingFor(ctx, account.id, input.mapping);
    if (resolved !== null && isErr(resolved)) return resolved;
    const table = tableOf(payload, resolved?.mapping ?? null);
    if (resolved === null) {
      const guessed = guessCsvMapping(table.headers, table.records);
      return err('csv_mapping_required', {
        bankAccountId: account.id,
        headers: table.headers,
        guessedMapping: guessed,
        missing: checkMappingAgainst(guessed, table.headers).missing,
        reason: 'this Bankkonto has no saved CSV mapping: preview the file (bank_csv_preview) and import it with a mapping',
      });
    }
    const check = checkMappingAgainst(resolved.mapping, table.headers);
    if (check.missing.length > 0 || check.unknownColumns.length > 0) {
      return err('csv_mapping_invalid', {
        bankAccountId: account.id,
        missing: check.missing,
        unknownColumns: check.unknownColumns,
        headers: table.headers,
        reason: missingSentence(check.missing, check.unknownColumns),
      });
    }
    mappingUsed = resolved.mapping;
    if (fill !== null) {
      // A20 §12: only the days no statement holds, each stretch proven by the running balance.
      if (fillBalanceTieMode(ctx) === 'required' && resolved.mapping.columns.balance === undefined) {
        return err('csv_fill_needs_balance', {
          bankAccountId: account.id,
          headers: table.headers,
          reason: 'a gap fill is proven by the bank\'s running balance: map the balance column (Saldo), or set bank.csv_fill_balance_tie to warn',
        });
      }
      const done = importCsvFill(ctx, account, table, resolved.mapping, fill);
      outcomes = done.outcomes;
      skips = done.skips;
      fillReport = done.report;
    } else {
      const stmt = csvStatementOf(table, resolved.mapping, account.currency);
      const one = importOneStatement(ctx, account, stmt, 1, allowDuplicateEntries, []);
      outcomes.push(one.outcome);
      skips.push(...one.skips);
    }
    if (resolved.given && input.saveMapping !== false) {
      ctx.store.tx(() => writeCsvMapping(ctx, account.id, resolved.mapping));
      mappingSaved = true;
    }
  }

  const body: ImportBankStatementOk = {
    bankAccountId: account.id,
    format: reportFormat,
    fileName,
    encoding: payload.encoding,
    statements: outcomes,
    imported: outcomes.reduce((n, o) => n + o.txnCount, 0),
    duplicates: outcomes.reduce((n, o) => n + o.duplicates, 0),
    refused: outcomes.reduce((n, o) => n + o.refusedLines, 0),
    skipped: skips,
    ...(mappingUsed !== undefined ? { mapping: mappingUsed } : {}),
    mappingSaved,
    ...(fillReport !== undefined ? { fill: fillReport } : {}),
  };
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'import_bank_statement', () => ok<ImportBankStatementOk>(body));
}

/**
 * D158/D162 (A20 §11.4): the import's own validation with nothing written, run by the transport seam for
 * a dial-governed seat BEFORE it drafts, so an import the verb would refuse never queues as a Vorschlag.
 * One rule is the seat's alone: an agent's CSV import must carry its MAPPING in the payload. The saved
 * mapping decides how every amount and sign is read, and a person could change it between the agent's
 * proposal and the approval; with the mapping in the payload, what the person approves is what runs (the
 * pin's `payload` reason holds by construction). The refusal hands the saved mapping back to embed.
 * Undefined when the import would run, or would replay its key.
 */
export function prevalidateImportBankStatement(ctx: WorkspaceContext, input: ImportBankStatementInput): Result | undefined {
  const capable = ctx.capabilities.assert('pay');
  if (!capable.ok) return capable;
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) return err('invalid_input', { field: 'idempotencyKey' });
  if (input.format !== undefined && (typeof input.format !== 'string' || !(STATEMENT_IMPORT_FORMATS as readonly string[]).includes(input.format))) {
    return err('invalid_input', { field: 'format', allowed: [...STATEMENT_IMPORT_FORMATS] });
  }
  for (const flag of ['saveMapping', 'allowDuplicateEntries'] as const) {
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean') return err('invalid_input', { field: flag });
  }
  const account = readAccount(ctx, input.bankAccountId);
  if (isErr(account)) return account;
  if (account.archived === 1) return err('bank_account_archived', { bankAccountId: account.id, name: account.name });
  const payload = readPayload(input);
  if (isErr(payload)) return payload;
  const scopedKey = importScopeKey(account.id, input, payload.digest);
  if (ctx.store.recallIdempotent(ctx.workspaceId, scopedKey, 'import_bank_statement') !== undefined) return undefined;
  const named = (input.format ?? 'auto') as StatementImportFormat;
  const format = named === 'auto' ? detectStatementFormat(payload.text) : named;
  const fill = fillOf(input, format);
  if (fill !== null && isErr(fill)) return fill;
  const fed = feedRefusal(ctx, account, format, fill);
  if (fed !== null) return fed;
  if (format === 'camt') {
    const split = splitCamt053(payload.text);
    if (!split.ok) return split;
    const first = parseCamt(split.parts[0]);
    return first.ok ? undefined : first;
  }
  if (format === 'mt940') {
    const parsed = parseMt940(payload.text);
    if (!parsed.ok) return parsed;
    const plan = mt940AccountPlan(account.iban, parsed.statements);
    return isErr(plan) ? plan : undefined;
  }
  if (input.mapping === undefined || input.mapping === null) {
    const table = tableOf(payload, null);
    return err('csv_mapping_required', {
      bankAccountId: account.id,
      headers: table.headers,
      savedMapping: readStoredCsvMapping(ctx, account.id)?.mapping ?? null,
      guessedMapping: guessCsvMapping(table.headers, table.records),
      reason: "an agent's CSV import carries its mapping in the payload, so the approval runs exactly the mapping the person saw: pass savedMapping (or your own) as mapping",
    });
  }
  const read = readCsvMapping(input.mapping);
  if (!read.ok) return read;
  const table = tableOf(payload, read.mapping);
  const check = checkMappingAgainst(read.mapping, table.headers);
  if (check.missing.length > 0 || check.unknownColumns.length > 0) {
    return err('csv_mapping_invalid', {
      bankAccountId: account.id,
      missing: check.missing,
      unknownColumns: check.unknownColumns,
      headers: table.headers,
      reason: missingSentence(check.missing, check.unknownColumns),
    });
  }
  if (fill !== null && fillBalanceTieMode(ctx) === 'required' && read.mapping.columns.balance === undefined) {
    return err('csv_fill_needs_balance', { bankAccountId: account.id, headers: table.headers });
  }
  return undefined;
}

const MISSING_TEXT: Readonly<Record<CsvMissingField, string>> = {
  bookingDate: 'the booking date',
  amount: 'the amount (or the debit and credit columns)',
};

/** The sentence that NAMES what a mapping lacks. */
export function missingSentence(missing: readonly CsvMissingField[], unknownColumns: readonly string[]): string {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`map a column for ${missing.map((m) => MISSING_TEXT[m]).join(' and ')}`);
  if (unknownColumns.length > 0) parts.push(`the file has no column ${unknownColumns.map((c) => `"${c}"`).join(', ')}`);
  return parts.join('; ');
}

// --- bank_csv_preview ----------------------------------------------------------------------------------

export interface CsvPreviewSampleRow {
  /** The row's line in the file (1-based). */
  row: number;
  bookingDate: string | null;
  valueDate: string | null;
  /** Signed: + money in, - money out; null when the row is skipped. */
  amountMinor: number | null;
  currency: string | null;
  text: string | null;
  counterparty: string | null;
  /** The skip reason when the row would not import, else null. */
  error: string | null;
}

export type BankCsvPreviewOk = {
  bankAccountId: string;
  encoding: DetectedCsvEncoding | null;
  delimiter: string;
  headerRow: number;
  headers: string[];
  /** The first rows, cells in header order. */
  rows: string[][];
  rowCount: number;
  /** The mapping the preview read the file with: the one handed in, else the saved one, else the guess. */
  mapping: CsvMapping;
  mappingSource: 'given' | 'saved' | 'guessed';
  guessedMapping: CsvMapping;
  /** Required targets the mapping leaves unmapped (`amount` meaning amount or debit/credit). */
  missing: CsvMissingField[];
  /** Mapped header texts the file does not carry. */
  unknownColumns: string[];
  /** The sentence that names what is missing, or null when the mapping reads the file. */
  blocking: string | null;
  sample: CsvPreviewSampleRow[];
  /** A20 §12: the preset whose every column the file carries (offered as the guess), or null. */
  preset: CsvPresetId | null;
  /** A20 §12: the Bankkonto is fed over EBICS (a CSV goes in only as a gap fill). */
  fedAccount: boolean;
  /** A20 §12: with `fill`, what a fill would write, stretch by stretch (statuses `ready`, `blocked`, `not_in_file`, `already_imported`). */
  fill?: CsvFillReport;
};

/**
 * `bank_csv_preview` (A20 §11.3): read a CSV the way the import would, writing nothing: the encoding,
 * separator and header row, the first rows, the mapping (handed in, saved, or guessed) with what it
 * lacks, and the first rows as the import would read them, each with its error.
 */
export function bankCsvPreview(ctx: WorkspaceContext, input: { bankAccountId?: unknown; content?: unknown; contentBase64?: unknown; mapping?: unknown; fill?: unknown }): Result<BankCsvPreviewOk> {
  const account = readAccount(ctx, input.bankAccountId);
  if (isErr(account)) return account;
  const payload = readPayload(input);
  if (isErr(payload)) return payload;
  const fill = fillOf(input, 'csv');
  if (fill !== null && isErr(fill)) return fill;
  const resolved = mappingFor(ctx, account.id, input.mapping);
  if (resolved !== null && isErr(resolved)) return resolved;
  const table = tableOf(payload, resolved?.mapping ?? null);
  const guessed = guessCsvMapping(table.headers, table.records);
  const mapping = resolved?.mapping ?? guessed;
  const source: BankCsvPreviewOk['mappingSource'] = resolved === null ? 'guessed' : resolved.given ? 'given' : 'saved';
  const check = checkMappingAgainst(mapping, table.headers);
  const head: CsvTable = { ...table, records: table.records.slice(0, CSV_PREVIEW_ROWS), lines: table.lines.slice(0, CSV_PREVIEW_ROWS) };
  const sample: CsvPreviewSampleRow[] = [];
  if (check.missing.length === 0 && check.unknownColumns.length === 0) {
    const stmt = csvStatementOf(head, mapping, account.currency);
    const byLine = new Map<number, CsvPreviewSampleRow>();
    // Entries keep file order: their lines are the lines of the rows that were not skipped.
    const skippedLines = new Set(stmt.skipped.map((s) => s.row));
    const importedLines = head.lines.filter((l) => !skippedLines.has(l));
    stmt.entries.forEach((e, i) => {
      const row = importedLines[i] ?? 0;
      byLine.set(row, {
        row,
        bookingDate: e.bookingDate,
        valueDate: e.valueDate,
        amountMinor: e.creditDebit === 'CRDT' ? e.amountMinor : -e.amountMinor,
        currency: e.currency,
        text: e.remittanceText,
        counterparty: e.counterpartyName,
        error: null,
      });
    });
    for (const s of stmt.skipped) {
      const row = s.row ?? 0;
      byLine.set(row, { row, bookingDate: null, valueDate: null, amountMinor: null, currency: null, text: null, counterparty: null, error: s.reason });
    }
    sample.push(...[...byLine.values()].sort((a, b) => a.row - b.row));
  }
  return ok<BankCsvPreviewOk>({
    bankAccountId: account.id,
    encoding: payload.encoding,
    delimiter: table.delimiter,
    headerRow: table.headerRow,
    headers: table.headers,
    rows: head.records.map((r) => table.headers.map((h) => r[h] ?? '')),
    rowCount: table.records.length,
    mapping,
    mappingSource: source,
    guessedMapping: guessed,
    missing: check.missing,
    unknownColumns: check.unknownColumns,
    blocking: check.missing.length > 0 || check.unknownColumns.length > 0 ? missingSentence(check.missing, check.unknownColumns) : null,
    sample,
    preset: presetFor(table.headers)?.id ?? null,
    fedAccount: isEbicsFedAccount(ctx, account.id),
    ...(fill !== null && check.missing.length === 0 && check.unknownColumns.length === 0 ? { fill: previewFill(ctx, account, table, mapping, fill) } : {}),
  });
}

/** A20 §12: what a fill of this file would write, nothing written. */
function previewFill(ctx: WorkspaceContext, account: AccountRow, table: CsvTable, mapping: CsvMapping, scope: CsvFillScope): CsvFillReport {
  const { parts, report } = planFill(ctx, account, table, mapping, scope);
  const digest = mappingDigestOf(mapping);
  let n = 0;
  return {
    ...report,
    parts: parts.map((part) => {
      const planned = plannedStatus(ctx, account, part, report.balanceTie, digest);
      const at = planned.status === 'not_in_file' ? null : (n += 1);
      return partReportOf(part, planned.status, { part: at, imported: planned.status === 'ready' ? part.entries.length : 0, statementId: planned.statementId });
    }),
  };
}
