/**
 * "Ignorieren": take the line out of the inbox without booking it, with a reason (owner answer 1).
 * The books are balanced elsewhere (a clearing account, the other side of a transfer), and the trust
 * line's balance, never the line count, shows whether the money arrived; the form says so before the
 * commit. One case is not an ignore at all and is caught at the control: a private payment belongs on
 * the owner's current account (2261 in the KMU chart), so the form offers that booking in one click.
 */
import { useId, useState } from 'react';

import { useT } from '../../i18n';
import type { BankInboxLine, DraftTarget, IgnoreReason } from './model';
import { BANK_LINE_IGNORE_REASONS, accountDraft } from './model';
import type { Lookups } from './lookups';

export interface IgnoreFormProps {
  line: BankInboxLine;
  lookups: Lookups;
  busy: boolean;
  canPost: boolean;
  onIgnore: (reason: IgnoreReason, note: string) => void;
  /** Book it to the owner's account instead: the row takes the draft and the panel returns. */
  onBookInstead: (target: DraftTarget) => void;
  onCancel: () => void;
}

/**
 * Where a private payment from the business account goes: the shareholder's current account (2261,
 * "Kontokorrent Gesellschafter", in a GmbH chart that carries it), else the owner's Privatkonto (2850,
 * seeded in the KMU chart). 2260 is NOT a candidate: the seed uses it for payables to employees.
 */
const PRIVATE_ACCOUNTS = ['2261', '2850'];

export function IgnoreForm({ line, lookups, busy, canPost, onIgnore, onBookInstead, onCancel }: IgnoreFormProps) {
  const t = useT();
  const baseId = useId();
  const [reason, setReason] = useState<IgnoreReason>('booked_elsewhere');
  const [note, setNote] = useState('');
  const privateAccount = PRIVATE_ACCOUNTS.map((n) => lookups.chartByNumber.get(n)).find((a) => a !== undefined);
  const noteRequired = reason === 'other';

  return (
    <form
      className="bank-mode bank-ignore"
      aria-labelledby={`${baseId}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || (noteRequired && note.trim() === '')) return;
        onIgnore(reason, note.trim());
      }}
    >
      <h3 id={`${baseId}-title`} className="bank-mode__title">
        {t('bankInbox.ignore.title')}
      </h3>
      {privateAccount !== undefined && line.amountMinor < 0 && (
        <div className="bank-ignore__private">
          <p>{t('bankInbox.ignore.private', { account: `${privateAccount.number} ${privateAccount.name}` })}</p>
          <button type="button" className="btn btn--secondary bank-touch" onClick={() => onBookInstead(accountDraft(line, privateAccount.id, ''))}>
            {t('bankInbox.ignore.bookPrivate')}
          </button>
        </div>
      )}
      <fieldset className="bank-fieldset">
        <legend className="bank-section-title">{t('bankInbox.ignore.reasonLegend')}</legend>
        <ul className="bank-choices">
          {BANK_LINE_IGNORE_REASONS.map((r) => (
            <li key={r}>
              <label className="bank-choice" data-checked={reason === r ? 'true' : 'false'}>
                <input type="radio" name={`${baseId}-reason`} checked={reason === r} onChange={() => setReason(r)} />
                <span className="bank-choice__text">
                  <span className="bank-choice__title">{t(`bankInbox.ignore.reason.${r}.label`)}</span>
                  <span className="bank-choice__meta">{t(`bankInbox.ignore.reason.${r}.hint`)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <label className="bank-field" htmlFor={`${baseId}-note`}>
        <span className="bank-field__label">{noteRequired ? t('bankInbox.ignore.noteRequired') : t('bankInbox.ignore.note')}</span>
        <textarea id={`${baseId}-note`} className="field bank-textarea" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} aria-required={noteRequired || undefined} />
      </label>
      <p className="bank-mode__consequence">{t('bankInbox.ignore.consequence')}</p>
      <div className="bank-mode__actions">
        <button type="submit" className="btn btn--secondary bank-touch bank-commit" disabled={busy || !canPost || (noteRequired && note.trim() === '')}>
          {busy ? t('bankInbox.row.busy') : t('bankInbox.ignore.commit')}
        </button>
        <button type="button" className="btn btn--ghost bank-touch" onClick={onCancel}>
          {t('bankInbox.panel.cancel')}
        </button>
      </div>
    </form>
  );
}
