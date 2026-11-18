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
 * A GAP FILL (A20 §12, `CsvFillStep`): a CSV can also fill only the days the books miss (the gaps TILL
 * knows, or one range), each stretch proven by the bank's running balance and shown before the import with
 * whether it meets the statements on both sides. On an account fed over EBICS this is the only way a CSV
 * goes in. A ZKB export is recognised by its headings (`preset`) and arrives mapped.
 *
 * The props are unchanged: `Bank.tsx` mounts the dialog and hears `onImported` (one statement) or
 * `onImportedFiles` (several) exactly as before.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useT } from '../../i18n';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';
import { FileDrop } from '../../components/FileDrop';
import type { BankAccountOption } from './model';
import { formatIban, ibanOfCamt } from './model';
import { RefusalNote } from './RefusalNote';
import type { NumberJump } from '../BankAccounts/channelWording';
import { outcomeText, parseFileOutcomes, type FileOutcome } from './importOutcomes';
import { CsvFillStep, problemSentence, readFillView, stretchName, type CsvFillMode, type CsvFillView } from './CsvFillStep';
import { CsvMappingStep, bytesToBase64, fileBytesOf, sniffBytes, useCsvPreview, useMappingBlocking, type CsvMappingDraft, type TabularFile } from './CsvMappingStep';

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
const ACCEPT = '.xml,text/xml,application/xml,.sta,.mt940,.txt,.csv,text/csv,text/plain,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';

type StatementKind = 'camt' | 'mt940' | 'csv' | 'xlsx';


interface OtherFile {
  name: string;
  /** A20 §13.1: `xlsx` is an Excel export, read like a CSV (`format: 'xlsx'`). */
  kind: 'mt940' | 'csv' | 'xlsx';
  base64: string;
}

/** A CSV or an Excel export: the two the mapping step reads. */
const isTabular = (kind: OtherFile['kind'] | undefined): kind is 'csv' | 'xlsx' => kind === 'csv' || kind === 'xlsx';

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
  /** A20 §12: the fill's stretches, when the import was a fill. */
  fill: CsvFillView | null;
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
  return { fill: readFillView(b.fill), statements, imported: num(b.imported), duplicates: num(b.duplicates), refused: num(b.refused), skipped };
}

const KNOWN_SKIPS = new Set(['duplicate_entry', 'cross_format_duplicate', 'pending', 'unreadable_amount', 'unreadable_date', 'unsupported_status', 'zero_amount', 'currency_differs', 'not_a_movement']);
const KNOWN_WARNINGS = new Set([
  'account_unverified',
  'possible_cross_format_duplicate',
  'overlap_same_movement',
  'covered_period_new_line',
  'not_day_end_statement',
  'csv_fill_untied',
  'csv_fill_chain_broken',
  'csv_fill_open_end',
  'csv_fill_needs_balance',
  'csv_fill_unreadable_row',
  'csv_fill_boundary_mismatch',
]);
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
  const [summary, setSummary] = useState<StatementSummary | null>(null);
  // A20 §12: how much of a CSV to take, the range for `range`, and the engine's plan for the fill.
  const [fillMode, setFillMode] = useState<CsvFillMode>('all');
  const [fillRange, setFillRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [fillPlan, setFillPlan] = useState<CsvFillView | null>(null);
  const [fillBusy, setFillBusy] = useState(false);
  const fill = fillMode === 'gaps' ? {} : fillMode === 'range' && fillRange.from !== '' && fillRange.to !== '' && fillRange.from <= fillRange.to ? { from: fillRange.from, to: fillRange.to } : null;
  const fillKey = fillMode === 'all' ? '' : JSON.stringify(fill);
  const key = useIdempotencyKey(['import_camt', accountId, file?.name ?? '', file?.xml.length ?? 0]);
  const manyKey = useIdempotencyKey(['import_camt_files', accountId, files.map((f) => [f.name, f.xml.length])]);
  // A20 §13.2: the one mapping step, shared with the gap dialog.
  const tabular: TabularFile | null = useMemo(() => (other !== null && isTabular(other.kind) ? { name: other.name, format: other.kind, base64: other.base64 } : null), [other]);
  const { preview, previewBusy, mapping, setMapping, setLayout, sheet, setSheet, parsed } = useCsvPreview({
    client,
    workspaceId,
    accountId,
    file: tabular,
    onError: setError,
    // An account fed over EBICS takes a CSV only as a gap fill: that is the one choice offered.
    onPreview: (read) => {
      if (read.fedAccount) setFillMode((m) => (m === 'all' ? 'gaps' : m));
    },
  });
  const otherKey = useIdempotencyKey(['import_bank_statement', accountId, other?.name ?? '', other?.base64.length ?? 0, JSON.stringify(mapping), fillMode, fillKey, sheet ?? '']);

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
    setOneAtATime(false);
    const firstText = await picked.text();
    const firstBytes = await fileBytesOf(picked);
    // A20 §13.2: a workbook is told by its bytes, never its name.
    const kind: StatementKind = sniffBytes(firstBytes) === 'xlsx' ? 'xlsx' : statementKindOf(picked.name, firstText);
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
      setOther({ name: picked.name, kind, base64: bytesToBase64(firstBytes) });
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


  const { blocking } = useMappingBlocking(preview, mapping, parsed);
  const hasBalance = mapping?.columns.balance !== undefined;
  const mappingKey = JSON.stringify(mapping);

  // A20 §12: the engine's plan for the fill, read again whenever the mapping, the mode or the range changes.
  useEffect(() => {
    if (other === null || !isTabular(other.kind) || accountId === '' || fillMode === 'all' || mappingKey === 'null' || blocking.length > 0) {
      setFillPlan(null);
      return;
    }
    if (fillKey === 'null') {
      setFillPlan(null);
      return;
    }
    let live = true;
    setFillBusy(true);
    void client
      .call('bank_csv_preview', {
        workspaceId,
        bankAccountId: accountId,
        contentBase64: other.base64,
        format: other.kind,
        ...(sheet !== null ? { sheet } : {}),
        mapping: JSON.parse(mappingKey) as CsvMappingDraft,
        fill: JSON.parse(fillKey) as Record<string, string>,
      })
      .then((response) => {
        if (!live) return;
        setFillBusy(false);
        if (isErr(response.body)) {
          setError(response.body);
          setFillPlan(null);
          return;
        }
        setFillPlan(readFillView((response.body as { fill?: unknown }).fill));
      });
    return () => {
      live = false;
    };
    // `blocking` follows from the mapping; its length is read, not its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [other, accountId, workspaceId, client, fillMode, fillKey, mappingKey, hasBalance, blocking.length, sheet]);

  const submitOther = async () => {
    if (other === null || accountId === '' || busy) return;
    if (isTabular(other.kind) && (mapping === null || blocking.length > 0)) return;
    setBusy(true);
    setError(null);
    const response = await client.call('import_bank_statement', {
      workspaceId,
      bankAccountId: accountId,
      contentBase64: other.base64,
      fileName: other.name,
      format: other.kind,
      ...(isTabular(other.kind) && mapping !== null ? { mapping, saveMapping: true } : {}),
      ...(other.kind === 'xlsx' && sheet !== null ? { sheet } : {}),
      ...(isTabular(other.kind) && fillMode !== 'all' && fill !== null ? { fill } : {}),
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
  // A20 §13.3: without a balance column the engine's plan decides per stretch (the neighbour sum), so the plan is read either way.
  const fillReady = fillMode === 'all' || (!fillBusy && fillPlan !== null && fillPlan.parts.some((p) => p.status === 'ready'));
  const otherNotReady = other !== null && isTabular(other.kind) && (previewBusy || preview === null || mapping === null || blocking.length > 0 || !fillReady);
  const canCommit = (file !== null || other !== null) && accountId !== '' && !busy && !unregistered && !otherNotReady;
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
              {busy
                ? t('bankInbox.import.busy')
                : other === null && files.length > 1
                  ? t('bankInbox.import.commitMany', { count: files.length })
                  : isTabular(other?.kind) && fillMode !== 'all'
                    ? t(fillMode === 'gaps' ? 'bankInbox.import.fill.commit' : 'bankInbox.import.fill.commitRange')
                    : t('bankInbox.import.commit')}
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
        {isTabular(other?.kind) && !finished && (
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
              <CsvMappingStep
                baseId={baseId}
                preview={preview}
                mapping={mapping}
                onMapping={setMapping}
                onLayout={setLayout}
                onSheet={setSheet}
                parsed={parsed}
                currency={account?.currency ?? 'CHF'}
              />
            ) : null}
          </section>
        )}
        {isTabular(other?.kind) && !finished && preview !== null && mapping !== null && blocking.length === 0 && (
          <CsvFillStep
            mode={fillMode}
            onMode={setFillMode}
            range={fillRange}
            onRange={setFillRange}
            fedAccount={preview.fedAccount}
            hasBalance={hasBalance}
            plan={fillPlan}
            planBusy={fillBusy}
            currency={account?.currency ?? 'CHF'}
            disabled={busy}
          />
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
                {summary.fill?.parts
                  .filter((p) => p.status !== 'not_in_file')
                  .map((p) => (
                    <li key={`fill-${p.from}-${p.to}`} className={`gap-repair__result is-${p.status === 'refused' ? 'refused' : p.status === 'already_imported' ? 'already_imported' : 'imported'}`}>
                      {p.status === 'refused'
                        ? t('bankInbox.import.fill.result.refused', { range: stretchName(t, p), why: problemSentence(t, p, account?.currency ?? 'CHF') ?? '' })
                        : p.status === 'already_imported'
                          ? t('bankInbox.import.fill.result.already', { range: stretchName(t, p) })
                          : t(p.closesTarget ? 'bankInbox.import.fill.result.closed' : 'bankInbox.import.fill.result.imported', { range: stretchName(t, p) })}
                    </li>
                  ))}
                {summary.statements
                  .filter((s) => s.outcome === 'refused' && summary.fill === null)
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
        {error !== null && errorCode === 'csv_fill_needs_balance' && (
          <div className="bank-refusal" role="alert">
            <div className="bank-refusal__content">
              <p className="bank-refusal__body">{t('bankInbox.import.refusal.fillNeedsBalance')}</p>
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
          errorCode !== 'csv_fill_needs_balance' &&
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
