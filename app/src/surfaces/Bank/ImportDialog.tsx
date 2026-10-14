/**
 * "Kontoauszug importieren" (A20 `import_camt`, the one statement door the inbox keeps).
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
  const key = useIdempotencyKey(['import_camt', accountId, file?.name ?? '', file?.xml.length ?? 0]);
  const manyKey = useIdempotencyKey(['import_camt_files', accountId, files.map((f) => [f.name, f.xml.length])]);

  const account = accounts.find((a) => a.id === accountId);
  const fileAccount = fileIban === null ? undefined : accounts.find((a) => a.iban.replace(/\s+/g, '').toUpperCase() === fileIban);
  const unregistered = fileIban !== null && fileAccount === undefined;

  const take = async (pickedFiles: File[]) => {
    const picked = pickedFiles[0];
    if (picked === undefined) return;
    setError(null);
    setRejected(false);
    setOutcomes(null);
    const read = await Promise.all(pickedFiles.map(async (f) => ({ name: f.name, xml: await f.text() })));
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

  const submit = async () => {
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

  return (
    <Modal
      open
      onClose={onClose}
      title={t('bankInbox.import.title')}
      closeLabel={t('bankInbox.panel.close')}
      footer={
        outcomes !== null ? (
          <button
            type="button"
            className="btn btn--primary bank-touch"
            onClick={() => {
              onImportedFiles?.(outcomes, accountId);
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
            <button type="button" className="btn btn--primary bank-touch" disabled={file === null || accountId === '' || busy || unregistered} onClick={() => void submit()}>
              {busy ? t('bankInbox.import.busy') : files.length > 1 ? t('bankInbox.import.commitMany', { count: files.length }) : t('bankInbox.import.commit')}
            </button>
          </>
        )
      }
    >
      <div className="bank-import">
        <p className="bank-mode__lead">{t('bankInbox.import.lead')}</p>
        <div className="bank-field">
          <span className="bank-field__label" id={`${baseId}-file-label`}>
            {t('bankInbox.import.file')}
          </span>
          <FileDrop
            multiple
            accept=".xml,text/xml,application/xml"
            label={t('bankInbox.import.choose')}
            prompt={t('bankInbox.import.drop')}
            hint={file === null ? t('bankInbox.import.hint') : files.map((f) => f.name).join(', ')}
            disabled={busy || outcomes !== null}
            onFiles={(picked) => void take(picked)}
            onReject={() => setRejected(true)}
          />
          {rejected && <p className="bank-mode__warn">{t('bankInbox.import.notXml')}</p>}
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
        </div>
        {error !== null && (
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
