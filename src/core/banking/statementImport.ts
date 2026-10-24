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
import { checkMappingAgainst, guessCsvMapping, readCsvMapping, readStoredCsvMapping, writeCsvMapping } from './csvMapping.js';
import type { CsvMapping, CsvMissingField } from './csvMapping.js';

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
};

export interface ImportBankStatementInput {
  bankAccountId?: unknown;
  content?: unknown;
  contentBase64?: unknown;
  fileName?: unknown;
  format?: unknown;
  mapping?: unknown;
  saveMapping?: unknown;
  allowDuplicateEntries?: unknown;
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
}

function readAccount(ctx: WorkspaceContext, bankAccountId: unknown): AccountRow | Err {
  if (typeof bankAccountId !== 'string' || bankAccountId.length === 0) return err('invalid_input', { field: 'bankAccountId' });
  const account = ctx.store.db
    .prepare('SELECT id, iban, currency, archived, name FROM bank_account WHERE workspace_id = ? AND id = ?')
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
  const inserted = ctx.store.tx(() => insertStatement(ctx, account, stmt, hash, allowDuplicateEntries, warnings));
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
  if (format !== 'camt' && isEbicsFedAccount(ctx, account.id)) {
    return err('bank_feed_account', {
      bankAccountId: account.id,
      name: account.name,
      format,
      reason: 'this Bankkonto is fed over EBICS: its statements come from the bank feed as camt.053, so an MT940 or CSV is not imported here',
    });
  }

  let outcomes: StatementImportOutcome[] = [];
  let skips: StatementImportSkip[] = [];
  let mappingUsed: CsvMapping | undefined;
  let mappingSaved = false;
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
    const stmt = csvStatementOf(table, resolved.mapping, account.currency);
    const one = importOneStatement(ctx, account, stmt, 1, allowDuplicateEntries, []);
    outcomes.push(one.outcome);
    skips.push(...one.skips);
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
  if (format !== 'camt' && isEbicsFedAccount(ctx, account.id)) {
    return err('bank_feed_account', { bankAccountId: account.id, name: account.name, format });
  }
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
};

/**
 * `bank_csv_preview` (A20 §11.3): read a CSV the way the import would, writing nothing: the encoding,
 * separator and header row, the first rows, the mapping (handed in, saved, or guessed) with what it
 * lacks, and the first rows as the import would read them, each with its error.
 */
export function bankCsvPreview(ctx: WorkspaceContext, input: { bankAccountId?: unknown; content?: unknown; contentBase64?: unknown; mapping?: unknown }): Result<BankCsvPreviewOk> {
  const account = readAccount(ctx, input.bankAccountId);
  if (isErr(account)) return account;
  const payload = readPayload(input);
  if (isErr(payload)) return payload;
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
  });
}
