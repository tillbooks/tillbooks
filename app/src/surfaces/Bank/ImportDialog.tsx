/**
 * "Kontoauszug importieren" (A20 `import_camt`, the one statement door the inbox keeps; D178: also MT940
 * and CSV through `import_bank_statement`).
 *
 * The file decides the account where it can: its IBAN (`<Acct><Id><IBAN>`) is read in the browser the
 * moment it is picked, a registered account is chosen for the person, and an IBAN registered nowhere
 * is named BEFORE the import with the one fix, "Bankkonto erfassen" (the walk's B2.2; the judge's
 * outcome 5). Every refusal the engine can give (another account's file, an archived account, a
 * camt.052 or camt.054, an amended statement) renders with what, why and the fix, the typed choice kept.
 *
 * Only the day-end camt.053 is a statement (spec L7): a camt.054 is refused, an export without a
 * sequence number or closing balance imports with the warning `not_day_end_statement`. There is no
 * "import again and admit" escape: an entry already present under the same identity is the same entry
 * (lean critic C13), and the import names how many it skipped.
 *
 * SEVERAL FILES (A36 §4.7, D150): the picker and the drop take more than one file. One file keeps the
 * `import_camt` path above, with its full refusal note. Several go to `import_camt_files`, which sorts
 * them by statement number and imports them through the same door; the dialog then lists one outcome
 * per statement (imported, already in the books, refused with the reason) in a live region and closes
 * on "Fertig".
 *
 * MT940 AND CSV (D178, spec A20 §11.7): a non-XML file goes to `import_bank_statement`, one file at a
 * time. An MT940 names its account in `:25:`, which preselects the Bankkonto. A CSV opens the mapping
 * step: the first rows as a table, one select per target field (required ones marked), the date format
 * and the decimal separator, and a blocking line that NAMES the missing column; the Bankkonto's saved
 * mapping (or TILL's guess from the headings) is preselected by `bank_csv_preview`, and the import saves
 * the mapping again for next time. The answer is shown before the dialog closes: new lines, lines already
 * in the books, lines not read and why, refused statements with their reason.
 *
 * The props are unchanged: `Bank.tsx` mounts the dialog and hears `onImported` (one statement) or
 * `onImportedFiles` (several) exactly as before.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useT } from '../../i18n';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';
import { FileDrop } from '../../components/FileDrop';
import '../../components/DataTable.css';
import type { BankAccountOption } from './model';
import { formatIban, ibanOfCamt } from './model';
import { RefusalNote } from './RefusalNote';
import type { NumberJump } from '../BankAccounts/channelWording';
import { outcomeText, parseFileOutcomes, type FileOutcome } from './importOutcomes';

export interface ImportResult {
  bankAccountId: string;
  statementId: string;
  duplicate: boolean;
  /** The lines THIS import added: they carry `statementId`. */
  txnCount: number;
  skipped: { reason: string }[];
  warnings: string[];
  /** A36C-1: the number jump the successor rule imported over, in the channel's shape. */
  jump?: NumberJump;
}

export interface ImportDialogProps {
  open: boolean;
  workspaceId: string;
  accounts: BankAccountOption[];
  /** A file handed over by a drop on the surface. */
  initialFile: File | null;
  /** D150: several files handed over by a drop on the surface (wins over `initialFile`). */
  initialFiles?: File[] | null;
  preferredAccountId: string | null;
  onClose: () => void;
  onImported: (result: ImportResult) => void;
  /** D150: several files went through `import_camt_files`; the outcomes, once the person closes. */
  onImportedFiles?: (outcomes: FileOutcome[], bankAccountId: string) => void;
}

/** D178: every file the picker offers and a drop may hand over. */
const ACCEPT = '.xml,text/xml,application/xml,.sta,.mt940,.txt,.csv,text/csv,text/plain';

type StatementKind = 'camt' | 'mt940' | 'csv';

/** The CSV target fields, in the order the mapping step lists them (the engine's `CSV_TARGET_FIELDS`). */
const CSV_FIELDS = [
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
] as const;
type CsvField = (typeof CSV_FIELDS)[number];
const CSV_DATE_FORMATS = ['dd.mm.yyyy', 'dd.mm.yy', 'yyyy-mm-dd', 'dd/mm/yyyy'] as const;
/** The amount group: one signed column, or debit and/or credit. */
const AMOUNT_FIELDS: readonly CsvField[] = ['amount', 'debit', 'credit'];

interface CsvMappingDraft {
  columns: Partial<Record<CsvField, string>>;
  dateFormat: string;
  decimalSeparator?: '.' | ',';
  headerRow?: number;
  delimiter?: string;
  encoding?: string;
}

interface CsvPreview {
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
}

/** The separators a person can pick when the detection chose wrong (critic M3). */
const CSV_DELIMITER_CHOICES = ['semicolon', 'comma', 'tab'] as const;
/** The rows a person can name as the one with the column names. */
const CSV_HEADER_ROW_CHOICES = Array.from({ length: 30 }, (_, i) => i + 1);

interface OtherFile {
  name: string;
  kind: 'mt940' | 'csv';
  base64: string;
}

interface StatementOutcome {
  part: number;
  outcome: 'imported' | 'already_imported' | 'refused';
  statementId?: string;
  fromDate: string | null;
  txnCount: number;
  warnings: string[];
  code?: string;
  reason?: string;
}

interface StatementSummary {
  statements: StatementOutcome[];
  imported: number;
  duplicates: number;
  refused: number;
  skipped: { part: number; reason: string; row?: number }[];
}

/** At most this many skipped lines are listed one by one; the rest are counted. */
const SKIPS_SHOWN = 8;

/** camt by `.xml` or a leading `<`, MT940 by `.sta`/`.mt940` or its `:20:`/`:25:`/`:61:` lines, else CSV. */
export function statementKindOf(name: string, text: string): StatementKind {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xml')) return 'camt';
  if (lower.endsWith('.sta') || lower.endsWith('.mt940')) return 'mt940';
  if (lower.endsWith('.csv')) return 'csv';
  const head = text.slice(0, 65536).replace(/^﻿/, '').trimStart();
  if (head.startsWith('<')) return 'camt';
  let trn = false;
  let body = false;
  for (const raw of head.split('\n', 200)) {
    const at = raw.indexOf('{4:');
    const line = (at === -1 ? raw : raw.slice(at + 3)).trimStart();
    if (line.startsWith(':20:')) trn = true;
    if (line.startsWith(':25:') || line.startsWith(':61:')) body = true;
  }
  return trn && body ? 'mt940' : 'csv';
}

/** The IBAN an MT940 names in `:25:`, or null (string operations only). */
function ibanOfMt940(text: string): string | null {
  for (const raw of text.slice(0, 65536).split('\n', 200)) {
    const at = raw.indexOf(':25:');
    if (at === -1) continue;
    const value = raw.slice(at + 4).replace(/\s+/g, '').toUpperCase();
    const slash = value.lastIndexOf('/');
    const candidate = slash === -1 ? value : value.slice(slash + 1);
    return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(candidate) ? candidate : null;
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function fileBytes(file: File, text: string): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new TextEncoder().encode(text);
}

/** What a CSV mapping lacks against the file's headings, as the dialog names it. */
function mappingGaps(mapping: CsvMappingDraft, headers: readonly string[]): { missing: ('bookingDate' | 'amount')[]; unknown: string[] } {
  const missing: ('bookingDate' | 'amount')[] = [];
  if (mapping.columns.bookingDate === undefined) missing.push('bookingDate');
  if (AMOUNT_FIELDS.every((f) => mapping.columns[f] === undefined)) missing.push('amount');
  const unknown = [...new Set(Object.values(mapping.columns).filter((h): h is string => h !== undefined && !headers.includes(h)))];
  return { missing, unknown };
}

function readPreview(body: unknown): CsvPreview | null {
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
  };
}

function readSummary(body: unknown): StatementSummary {
  const b = (body ?? {}) as Record<string, unknown>;
  const statements = Array.isArray(b.statements)
    ? (b.statements as Record<string, unknown>[])
        .filter((s) => s !== null && typeof s === 'object' && (s.outcome === 'imported' || s.outcome === 'already_imported' || s.outcome === 'refused'))
        .map((s) => ({
          part: typeof s.part === 'number' ? s.part : 1,
          outcome: s.outcome as StatementOutcome['outcome'],
          ...(typeof s.statementId === 'string' ? { statementId: s.statementId } : {}),
          fromDate: typeof s.fromDate === 'string' ? s.fromDate : null,
          txnCount: typeof s.txnCount === 'number' ? s.txnCount : 0,
          warnings: Array.isArray(s.warnings) ? (s.warnings as unknown[]).filter((w): w is string => typeof w === 'string') : [],
          ...(typeof s.code === 'string' ? { code: s.code } : {}),
          ...(typeof s.reason === 'string' ? { reason: s.reason } : {}),
        }))
    : [];
  const skipped = Array.isArray(b.skipped)
    ? (b.skipped as Record<string, unknown>[])
        .filter((s) => s !== null && typeof s === 'object' && typeof s.reason === 'string')
        .map((s) => ({ part: typeof s.part === 'number' ? s.part : 1, reason: s.reason as string, ...(typeof s.row === 'number' ? { row: s.row } : {}) }))
    : [];
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  return { statements, imported: num(b.imported), duplicates: num(b.duplicates), refused: num(b.refused), skipped };
}

const KNOWN_SKIPS = new Set(['duplicate_entry', 'cross_format_duplicate', 'pending', 'unreadable_amount', 'unreadable_date', 'unsupported_status', 'zero_amount', 'currency_differs', 'not_a_movement']);
const KNOWN_WARNINGS = new Set(['account_unverified', 'possible_cross_format_duplicate', 'overlap_same_movement', 'covered_period_new_line', 'not_day_end_statement']);
const KNOWN_REFUSALS = new Set(['account_mismatch', 'currency_mismatch', 'schema_invalid', 'statement_amended']);

export function ImportDialog(props: ImportDialogProps) {
  if (!props.open) return null;
  return <ImportDialogBody {...props} />;
}

function ImportDialogBody({ workspaceId, accounts, initialFile, initialFiles, preferredAccountId, onClose, onImported, onImportedFiles }: ImportDialogProps) {
  const t = useT();
  const client = useClient();
  const baseId = useId();
  const [accountId, setAccountId] = useState<string>(preferredAccountId ?? (accounts.length === 1 ? (accounts[0]?.id ?? '') : ''));
  const [file, setFile] = useState<{ name: string; xml: string } | null>(null);
  // D150: every picked file; `file` is the first, which decides the account by its IBAN.
  const [files, setFiles] = useState<{ name: string; xml: string }[]>([]);
  const [outcomes, setOutcomes] = useState<FileOutcome[] | null>(null);
  const [fileIban, setFileIban] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const [rejected, setRejected] = useState(false);
  // D178: an MT940 or CSV file, its CSV preview and mapping, the one-at-a-time note, and the answer.
  const [other, setOther] = useState<OtherFile | null>(null);
  const [oneAtATime, setOneAtATime] = useState(false);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [mapping, setMapping] = useState<CsvMappingDraft | null>(null);
  // Critic M3: the separator and header row a person asked for when the detection chose wrong.
  const [layout, setLayout] = useState<{ delimiter?: string; headerRow?: number } | null>(null);
  const layoutKey = layout === null ? '' : JSON.stringify(layout);
  const [summary, setSummary] = useState<StatementSummary | null>(null);
  const key = useIdempotencyKey(['import_camt', accountId, file?.name ?? '', file?.xml.length ?? 0]);
  const manyKey = useIdempotencyKey(['import_camt_files', accountId, files.map((f) => [f.name, f.xml.length])]);
  const otherKey = useIdempotencyKey(['import_bank_statement', accountId, other?.name ?? '', other?.base64.length ?? 0, JSON.stringify(mapping)]);

  const account = accounts.find((a) => a.id === accountId);
  const fileAccount = fileIban === null ? undefined : accounts.find((a) => a.iban.replace(/\s+/g, '').toUpperCase() === fileIban);
  const unregistered = fileIban !== null && fileAccount === undefined;

  const take = async (pickedFiles: File[]) => {
    const picked = pickedFiles[0];
    if (picked === undefined) return;
    setError(null);
    setRejected(false);
    setOutcomes(null);
    setSummary(null);
    setPreview(null);
    setMapping(null);
    setLayout(null);
    setOneAtATime(false);
    const firstText = await picked.text();
    const kind = statementKindOf(picked.name, firstText);
    if (kind !== 'camt') {
      // D178: MT940 and CSV, one file at a time through `import_bank_statement`.
      setFile(null);
      setFiles([]);
      setOneAtATime(pickedFiles.length > 1);
      const iban = kind === 'mt940' ? ibanOfMt940(firstText) : null;
      setFileIban(iban);
      if (iban !== null) {
        const match = accounts.find((a) => a.iban.replace(/\s+/g, '').toUpperCase() === iban);
        if (match !== undefined) setAccountId(match.id);
      }
      setOther({ name: picked.name, kind, base64: bytesToBase64(await fileBytes(picked, firstText)) });
      return;
    }
    setOther(null);
    const read = await Promise.all(pickedFiles.map(async (f, i) => ({ name: f.name, xml: i === 0 ? firstText : await f.text() })));
    const xml = read[0]?.xml ?? '';
    const iban = ibanOfCamt(xml);
    setFile({ name: picked.name, xml });
    setFiles(read);
    setFileIban(iban);
    const match = iban === null ? undefined : accounts.find((a) => a.iban.replace(/\s+/g, '').toUpperCase() === iban);
    if (match !== undefined) setAccountId(match.id);
  };

  // A file dropped on the surface arrives once, when the dialog opens.
  const took = useRef(false);
  useEffect(() => {
    const handed = initialFiles !== undefined && initialFiles !== null && initialFiles.length > 0 ? initialFiles : initialFile !== null ? [initialFile] : [];
    if (took.current || handed.length === 0) return;
    took.current = true;
    void take(handed);
    // Once per mount, by design: the dialog body mounts per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // D178: a CSV is previewed for the chosen Bankkonto, so its saved mapping (or the guess) preselects.
  useEffect(() => {
    if (other === null || other.kind !== 'csv' || accountId === '') return;
    let live = true;
    setPreviewBusy(true);
    setError(null);
    // A layout the person asked for is read with an empty mapping, so the headings it reveals are guessed afresh.
    const asked = layoutKey === '' ? null : (JSON.parse(layoutKey) as { delimiter?: string; headerRow?: number });
    const input: Record<string, unknown> = { workspaceId, bankAccountId: accountId, contentBase64: other.base64 };
    if (asked !== null) input.mapping = { columns: {}, dateFormat: 'dd.mm.yyyy', ...asked };
    void client.call('bank_csv_preview', input).then((response) => {
      if (!live) return;
      setPreviewBusy(false);
      if (isErr(response.body)) {
        setError(response.body);
        return;
      }
      const read = readPreview(response.body);
      setPreview(read);
      if (read === null) setMapping(null);
      else if (asked === null) setMapping(read.mapping);
      else setMapping({ ...(read.guessedMapping ?? read.mapping), ...asked });
    });
    return () => {
      live = false;
    };
  }, [other, accountId, workspaceId, client, layoutKey]);

  const gaps = preview !== null && mapping !== null ? mappingGaps(mapping, preview.headers) : null;
  const blocking = gaps === null ? [] : [...gaps.missing.map((m) => t(`bankInbox.import.csv.missing.${m}`)), ...gaps.unknown.map((column) => t('bankInbox.import.csv.unknown', { column }))];

  const submitOther = async () => {
    if (other === null || accountId === '' || busy) return;
    if (other.kind === 'csv' && (mapping === null || blocking.length > 0)) return;
    setBusy(true);
    setError(null);
    const response = await client.call('import_bank_statement', {
      workspaceId,
      bankAccountId: accountId,
      contentBase64: other.base64,
      fileName: other.name,
      format: other.kind,
      ...(other.kind === 'csv' && mapping !== null ? { mapping, saveMapping: true } : {}),
      idempotencyKey: otherKey,
    });
    setBusy(false);
    if (isErr(response.body)) {
      setError(response.body);
      return;
    }
    setSummary(readSummary(response.body));
  };

  const submit = async () => {
    if (other !== null) {
      await submitOther();
      return;
    }
    if (file === null || accountId === '' || busy) return;
    setBusy(true);
    setError(null);
    if (files.length > 1) {
      // D150: several files, one ordered pass in the engine, one outcome per statement here.
      const many = await client.call('import_camt_files', { workspaceId, bankAccountId: accountId, files, idempotencyKey: manyKey });
      setBusy(false);
      if (isErr(many.body)) {
        setError(many.body);
        return;
      }
      setOutcomes(parseFileOutcomes(many.body));
      return;
    }
    const response = await client.call('import_camt', { workspaceId, bankAccountId: accountId, xml: file.xml, idempotencyKey: key });
    setBusy(false);
    if (isErr(response.body)) {
      setError(response.body);
      return;
    }
    const body = response.body as Record<string, unknown>;
    const skipped = Array.isArray(body.skipped) ? (body.skipped as { reason?: unknown }[]).map((s) => ({ reason: typeof s.reason === 'string' ? s.reason : 'unknown' })) : [];
    const result: ImportResult = {
      bankAccountId: accountId,
      statementId: typeof body.statementId === 'string' ? body.statementId : '',
      duplicate: body.duplicate === true,
      txnCount: typeof body.txnCount === 'number' ? body.txnCount : 0,
      skipped,
      warnings: Array.isArray(body.warnings) ? (body.warnings as unknown[]).filter((w): w is string => typeof w === 'string') : [],
      ...jumpOfImport(body.feed),
    };
    onImported(result);
    onClose();
  };

  /** D178: hand the answer to the inbox the way it already hears an import, then close. */
  const finishSummary = () => {
    if (summary === null) return;
    const [only] = summary.statements;
    if (summary.statements.length === 1 && only !== undefined && only.outcome !== 'refused') {
      onImported({
        bankAccountId: accountId,
        statementId: only.statementId ?? '',
        duplicate: only.outcome === 'already_imported',
        txnCount: only.txnCount,
        skipped: summary.skipped.map((s) => ({ reason: s.reason })),
        warnings: only.warnings,
      });
    } else {
      onImportedFiles?.(
        summary.statements.map((s) => ({
          file: other?.name ?? '',
          number: s.part,
          fromDate: s.fromDate,
          outcome: s.outcome,
          txnCount: s.txnCount,
          ...(s.code !== undefined ? { code: s.code } : {}),
          ...(s.reason !== undefined ? { reason: s.reason } : {}),
        })),
        accountId,
      );
    }
    onClose();
  };

  const finished = outcomes !== null || summary !== null;
  const otherNotReady = other !== null && other.kind === 'csv' && (previewBusy || preview === null || mapping === null || blocking.length > 0);
  const canCommit = (file !== null || other !== null) && accountId !== '' && !busy && !unregistered && !otherNotReady;
  const setColumn = (field: CsvField, header: string) => {
    if (mapping === null) return;
    const columns = { ...mapping.columns };
    if (header === '') delete columns[field];
    else columns[field] = header;
    setMapping({ ...mapping, columns });
  };
  const columnOptions = [{ value: '', label: t('bankInbox.import.csv.none') }, ...(preview?.headers ?? []).map((h) => ({ value: h, label: h }))];
  const refusalText = (code: string | undefined) =>
    code !== undefined && KNOWN_REFUSALS.has(code) ? t(`bankInbox.import.result.refused.${code}`) : t('bankInbox.import.result.refused.other', { code: code ?? '' });
  const skipText = (reason: string) => (KNOWN_SKIPS.has(reason) ? t(`bankInbox.import.result.skip.${reason}`) : reason);
  const errorCode = error?.error;
  const errorDetail = (error ?? {}) as Record<string, unknown>;
  const notReadSkips = summary === null ? [] : summary.skipped.filter((s) => s.reason !== 'duplicate_entry' && s.reason !== 'cross_format_duplicate');
  const summaryWarnings = summary === null ? [] : [...new Set(summary.statements.flatMap((s) => s.warnings))].filter((w) => KNOWN_WARNINGS.has(w));

  return (
    <Modal
      open
      onClose={onClose}
      title={t('bankInbox.import.title')}
      closeLabel={t('bankInbox.panel.close')}
      footer={
        finished ? (
          <button
            type="button"
            className="btn btn--primary bank-touch"
            onClick={() => {
              if (summary !== null) {
                finishSummary();
                return;
              }
              if (outcomes !== null) onImportedFiles?.(outcomes, accountId);
              onClose();
            }}
          >
            {t('bankInbox.import.done')}
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--ghost bank-touch" onClick={onClose}>
              {t('bankInbox.panel.cancel')}
            </button>
            <button type="button" className="btn btn--primary bank-touch" disabled={!canCommit} onClick={() => void submit()}>
              {busy ? t('bankInbox.import.busy') : other === null && files.length > 1 ? t('bankInbox.import.commitMany', { count: files.length }) : t('bankInbox.import.commit')}
            </button>
          </>
        )
      }
    >
      <div className="bank-import" aria-busy={busy || previewBusy}>
        <p className="bank-mode__lead">{t('bankInbox.import.leadAny')}</p>
        <div className="bank-field">
          <span className="bank-field__label" id={`${baseId}-file-label`}>
            {t('bankInbox.import.file')}
          </span>
          <FileDrop
            multiple
            accept={ACCEPT}
            label={t('bankInbox.import.choose')}
            prompt={t('bankInbox.import.dropAny')}
            hint={other !== null ? other.name : file === null ? t('bankInbox.import.hintAny') : files.map((f) => f.name).join(', ')}
            disabled={busy || finished}
            onFiles={(picked) => void take(picked)}
            onReject={() => setRejected(true)}
          />
          {rejected && <p className="bank-mode__warn">{t('bankInbox.import.notStatement')}</p>}
          {other !== null && <p className="bank-import__match">{t('bankInbox.import.detected', { format: t(`bankInbox.import.formats.${other.kind}`) })}</p>}
          {oneAtATime && other !== null && <p className="bank-mode__warn">{t('bankInbox.import.oneAtATime', { name: other.name })}</p>}
        </div>
        <label className="bank-field" htmlFor={`${baseId}-account`}>
          <span className="bank-field__label">{t('bankInbox.import.account')}</span>
          {accounts.length === 1 && account !== undefined ? (
            <span className="bank-import__account" id={`${baseId}-account`}>
              {account.name}
              <span className="bank-import__iban t-num">{formatIban(account.iban)}</span>
            </span>
          ) : (
            <Select
              id={`${baseId}-account`}
              value={accountId}
              onChange={setAccountId}
              ariaLabel={t('bankInbox.import.account')}
              placeholder={t('bankInbox.import.accountPick')}
              disabled={finished}
              options={accounts.map((a) => ({ value: a.id, label: `${a.name} · ${formatIban(a.iban)}` }))}
            />
          )}
        </label>
        {fileIban !== null && fileAccount !== undefined && (
          <p className="bank-import__match">{t('bankInbox.import.fileMatches', { name: fileAccount.name, iban: formatIban(fileIban) })}</p>
        )}
        {unregistered && (
          <div className="bank-refusal" role="alert">
            <div className="bank-refusal__content">
              <p className="bank-refusal__title">{t('bankInbox.error.ibanUnregistered.title', { iban: formatIban(fileIban) })}</p>
              <p className="bank-refusal__body">{t('bankInbox.error.ibanUnregistered.body', { iban: formatIban(fileIban) })}</p>
              <Link className="btn btn--secondary bank-refusal__action" to="/bank-accounts?new=1">
                {t('bankInbox.error.createBankAccount')}
              </Link>
            </div>
          </div>
        )}
        {other?.kind === 'csv' && !finished && (
          <section className="bank-field" aria-labelledby={`${baseId}-csv-title`}>
            <h3 className="bank-field__label" id={`${baseId}-csv-title`}>
              {t('bankInbox.import.csv.title')}
            </h3>
            {accountId === '' ? (
              <p className="bank-mode__lead">{t('bankInbox.import.csv.pickAccount')}</p>
            ) : previewBusy ? (
              <p className="bank-mode__lead" role="status">
                {t('bankInbox.import.reading')}
              </p>
            ) : preview !== null && mapping !== null ? (
              <>
                <p className="bank-mode__lead">{t('bankInbox.import.csv.lead')}</p>
                <p className="bank-import__match">{t(preview.mappingSource === 'saved' ? 'bankInbox.import.csv.saved' : 'bankInbox.import.csv.guessed')}</p>
                <label className="bank-field" htmlFor={`${baseId}-delimiter`}>
                  <span className="bank-field__label">{t('bankInbox.import.csv.delimiter')}</span>
                  <Select
                    id={`${baseId}-delimiter`}
                    value={mapping.delimiter ?? preview.delimiter}
                    onChange={(v) => {
                      setMapping({ ...mapping, delimiter: v });
                      // Another separator re-reads the file; its header row is detected again.
                      setLayout({ delimiter: v });
                    }}
                    ariaLabel={t('bankInbox.import.csv.delimiter')}
                    options={CSV_DELIMITER_CHOICES.map((d) => ({ value: d, label: t(`bankInbox.import.csv.delimiterChoice.${d}`) }))}
                  />
                </label>
                <label className="bank-field" htmlFor={`${baseId}-header-row`}>
                  <span className="bank-field__label">{t('bankInbox.import.csv.headerRow')}</span>
                  <Select
                    id={`${baseId}-header-row`}
                    value={String(mapping.headerRow ?? preview.headerRow)}
                    onChange={(v) => {
                      const headerRow = Number(v);
                      setMapping({ ...mapping, headerRow, delimiter: mapping.delimiter ?? preview.delimiter });
                      setLayout({ delimiter: mapping.delimiter ?? preview.delimiter, headerRow });
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
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.slice(0, 6).map((row, i) => (
                        <tr key={i}>
                          {preview.headers.map((h, j) => (
                            <td key={h}>{row[j] ?? ''}</td>
                          ))}
                        </tr>
                      ))}
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
                    onChange={(v) => setMapping({ ...mapping, dateFormat: v })}
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
                      setMapping(next);
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
            ) : null}
          </section>
        )}
        <div className="bank-import__outcomes" aria-live="polite" role="status">
          {outcomes !== null && (
            <ul className="gap-repair__list">
              {outcomes.map((o, i) => (
                <li key={`${o.file}-${o.number ?? 'x'}-${i}`} className={`gap-repair__result is-${o.outcome}`}>
                  {outcomeText(t, o, account?.currency ?? 'CHF')}
                </li>
              ))}
            </ul>
          )}
          {summary !== null && (
            <>
              <p className="bank-import__match">
                {t('bankInbox.import.result.counts', { imported: summary.imported, duplicates: summary.duplicates, refused: summary.refused })}
              </p>
              <ul className="gap-repair__list">
                {summary.statements
                  .filter((s) => s.outcome === 'refused')
                  .map((s) => (
                    <li key={`refused-${s.part}`} className="gap-repair__result is-refused">
                      {t('bankInbox.import.result.statementRefused', { part: s.part, why: refusalText(s.code) })}
                    </li>
                  ))}
                {notReadSkips.slice(0, SKIPS_SHOWN).map((s, i) => (
                  <li key={`skip-${s.part}-${s.row ?? i}`} className="gap-repair__result is-refused">
                    {s.row !== undefined ? t('bankInbox.import.result.skipRow', { row: s.row, why: skipText(s.reason) }) : t('bankInbox.import.result.skipLine', { why: skipText(s.reason) })}
                  </li>
                ))}
                {notReadSkips.length > SKIPS_SHOWN && (
                  <li className="gap-repair__result is-refused">{t('bankInbox.import.result.more', { count: notReadSkips.length - SKIPS_SHOWN })}</li>
                )}
                {summaryWarnings.map((w) => (
                  <li key={`warn-${w}`} className="gap-repair__result is-already_imported">
                    {t(`bankInbox.import.result.warning.${w}`)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        {error !== null && errorCode === 'bank_feed_account' && (
          <div className="bank-refusal" role="alert">
            <div className="bank-refusal__content">
              <p className="bank-refusal__body">{t('bankInbox.import.refusal.bankFeed')}</p>
            </div>
          </div>
        )}
        {error !== null && errorCode === 'mt940_several_accounts' && (
          <div className="bank-refusal" role="alert">
            <div className="bank-refusal__content">
              <p className="bank-refusal__body">
                {t('bankInbox.import.refusal.severalAccounts', {
                  accounts: (Array.isArray(errorDetail.accounts) ? (errorDetail.accounts as string[]) : []).join(', '),
                })}
              </p>
            </div>
          </div>
        )}
        {error !== null && (errorCode === 'csv_mapping_invalid' || errorCode === 'csv_mapping_required') && (
          <div className="bank-refusal" role="alert">
            <div className="bank-refusal__content">
              <p className="bank-refusal__title">{t('bankInbox.import.refusal.mapping')}</p>
              {(Array.isArray(errorDetail.missing) ? (errorDetail.missing as string[]) : []).map((m) => (
                <p key={m} className="bank-refusal__body">
                  {m === 'bookingDate' || m === 'amount' ? t(`bankInbox.import.csv.missing.${m}`) : m}
                </p>
              ))}
              {(Array.isArray(errorDetail.unknownColumns) ? (errorDetail.unknownColumns as string[]) : []).map((column) => (
                <p key={column} className="bank-refusal__body">
                  {t('bankInbox.import.csv.unknown', { column })}
                </p>
              ))}
            </div>
          </div>
        )}
        {error !== null &&
          errorCode !== 'bank_feed_account' &&
          errorCode !== 'mt940_several_accounts' &&
          errorCode !== 'csv_mapping_invalid' &&
          errorCode !== 'csv_mapping_required' && (
          <RefusalNote
            error={error}
            context={{ currency: account?.currency ?? 'CHF', ...(account !== undefined ? { accountName: account.name } : {}) }}
            onAction={(action) => {
              if (action.kind === 'import-for') {
                setAccountId(action.bankAccountId);
                setError(null);
              }
            }}
          />
        )}
      </div>
    </Modal>
  );
}

/** The `feed.jump` of an `import_camt` answer (A36 §4.4 rule 2), in the channel's `NumberJump` shape. */
function jumpOfImport(feed: unknown): { jump?: NumberJump } {
  if (feed === null || typeof feed !== 'object') return {};
  const f = feed as { position?: { number?: unknown; year?: unknown }; jump?: { after?: { number?: unknown; year?: unknown }; skipped?: unknown } };
  const after = f.jump?.after;
  const position = f.position;
  if (after === undefined || position === undefined || !Array.isArray(f.jump?.skipped)) return {};
  if (typeof after.number !== 'number' || typeof after.year !== 'number' || typeof position.number !== 'number' || typeof position.year !== 'number') return {};
  return {
    jump: {
      after: { number: after.number, year: after.year },
      statement: { number: position.number, year: position.year },
      skipped: f.jump?.skipped as NumberJump['skipped'],
    },
  };
}
