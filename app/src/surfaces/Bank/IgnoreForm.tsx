/**
 * "Ignorieren": take the line out of the inbox without booking it (owner answer 1), in ONE click (D196
 * point 2, founder 12.11.2026: a reason list was too much to think about). No reason picker: the line is
 * ignored with the workspace's `bank.ignore_default_reason` (D172, default `other`), or the reason the
 * caller opened the form on. A note is optional, behind the comment icon. The trust line's balance, never
 * the line count, shows whether the money arrived; the button's tooltip says so. One case is not an ignore
 * at all and is caught at the control: a private payment belongs on the owner's current account (2261 in
 * the KMU chart), so the form offers that booking in one click.
 */
import { useId, useState } from 'react';

import { useT } from '../../i18n';
import { IconButton } from '../../components/IconButton';
import type { BankInboxLine, DraftTarget, IgnoreReason } from './model';
import { accountDraft } from './model';
import type { Lookups } from './lookups';
import { useIgnoreDefaultReasonState } from './useIgnoreDefaultReason';

export interface IgnoreFormProps {
  line: BankInboxLine;
  lookups: Lookups;
  busy: boolean;
  canPost: boolean;
  /** The reason to record instead of the workspace default (a caller that already knows why). */
  initialReason?: IgnoreReason;
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

export function IgnoreForm({ line, lookups, busy, canPost, initialReason, onIgnore, onBookInstead, onCancel }: IgnoreFormProps) {
  const t = useT();
  const baseId = useId();
  const defaultReason = useIgnoreDefaultReasonState();
  const reason = initialReason ?? defaultReason.reason;
  // Critic D196 L4: the one click waits until the workspace default is known (a named reason needs no wait).
  const ready = initialReason !== undefined || defaultReason.ready;
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const privateAccount = PRIVATE_ACCOUNTS.map((n) => lookups.chartByNumber.get(n)).find((a) => a !== undefined);

  return (
    <form
      className="bank-mode bank-ignore"
      aria-labelledby={`${baseId}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || !ready) return;
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
      {noteOpen && (
        <label className="bank-field" htmlFor={`${baseId}-note`}>
          <span className="bank-field__label">{t('bankInbox.ignore.note')}</span>
          <textarea id={`${baseId}-note`} className="field bank-textarea" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
        </label>
      )}
      <div className="bank-mode__actions">
        <button
          type="submit"
          className="btn btn--secondary bank-touch bank-commit"
          disabled={busy || !canPost || !ready}
          title={t('bankInbox.ignore.consequence')}
        >
          {busy ? t('bankInbox.row.busy') : t('bankInbox.ignore.commit')}
        </button>
        {!noteOpen && <IconButton icon="comment" name={t('bankInbox.ignore.addNote')} context={t('bankInbox.ignore.note')} onClick={() => setNoteOpen(true)} />}
        <button type="button" className="btn btn--ghost bank-touch" onClick={onCancel}>
          {t('bankInbox.panel.cancel')}
        </button>
      </div>
    </form>
  );
}
