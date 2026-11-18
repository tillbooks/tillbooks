/**
 * "Stornieren" (a booked line), "Abgleich lösen" (a matched line) and "Wieder zu buchen" (an ignored
 * line): every undo is `reopen_bank_line` (spec §4.4, L3). A booked line's entry or
 * payment is REVERSED by a new posting and the line returns to the inbox; a matched or an ignored line
 * only has its decision superseded, nothing posts; a line booked to a payment run keeps the run's
 * payments. The old decision stays on record with who and when. D204: no reason is needed; the form
 * states the consequence before the commit, and offers the why only when `audit.ask_reason` is
 * `optional` (never required).
 */
import { useId, useState } from 'react';

import { useT } from '../../i18n';
import type { BankInboxLine } from './model';
import { useAskReason } from '../../lib/useAskReason';

export interface ReopenFormProps {
  line: BankInboxLine;
  busy: boolean;
  canReopen: boolean;
  onReopen: (reason: string | undefined) => void;
  onCancel: () => void;
}

const REASONS = ['wrongAccount', 'wrongVat', 'wrongItem', 'double', 'other'] as const;
const IGNORED_REASONS = ['ignoredByMistake', 'other'] as const;
type Reason = (typeof REASONS)[number] | (typeof IGNORED_REASONS)[number];

export function ReopenForm({ line, busy, canReopen, onReopen, onCancel }: ReopenFormProps) {
  const t = useT();
  const baseId = useId();
  const askReason = useAskReason();
  const ignored = line.state === 'ignored';
  const reasons: readonly Reason[] = ignored ? IGNORED_REASONS : REASONS;
  const [reason, setReason] = useState<Reason>(ignored ? 'ignoredByMistake' : 'wrongAccount');
  const [note, setNote] = useState('');
  const matched = line.state === 'matched';
  const settlement = line.decision?.paymentId !== null && line.decision?.paymentId !== undefined;
  const batch = line.decision?.targetKind === 'payment_batch';
  const variant = ignored ? 'Ignored' : matched ? 'Matched' : '';
  const consequence = ignored
    ? 'bankInbox.reopen.consequenceIgnored'
    : matched
      ? 'bankInbox.reopen.consequenceMatched'
      : batch
        ? 'bankInbox.reopen.consequenceBatch'
        : settlement
          ? 'bankInbox.reopen.consequenceSettlement'
          : 'bankInbox.reopen.consequenceBooked';
  const text = !askReason ? '' : reason === 'other' ? note.trim() : [t(`bankInbox.reopen.reason.${reason}`), note.trim()].filter((s) => s !== '').join(': ');

  return (
    <form
      className="bank-mode bank-reopen"
      aria-labelledby={`${baseId}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        onReopen(text === '' ? undefined : text);
      }}
    >
      <h3 id={`${baseId}-title`} className="bank-mode__title">
        {t(`bankInbox.reopen.title${variant}`)}
      </h3>
      {askReason && (
      <fieldset className="bank-fieldset">
        <legend className="bank-section-title">{t('bankInbox.reopen.why')}</legend>
        <ul className="bank-choices">
          {reasons.map((r) => (
            <li key={r}>
              <label className="bank-choice" data-checked={reason === r ? 'true' : 'false'}>
                <input type="radio" name={`${baseId}-reason`} checked={reason === r} onChange={() => setReason(r)} />
                <span className="bank-choice__title">{t(`bankInbox.reopen.reason.${r}`)}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      )}
      {askReason && (
      <label className="bank-field" htmlFor={`${baseId}-note`}>
        <span className="bank-field__label">{t('bankInbox.reopen.note')}</span>
        <textarea id={`${baseId}-note`} className="field bank-textarea" rows={2} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      )}
      <p className="bank-mode__consequence">{t(consequence)}</p>
      <div className="bank-mode__actions">
        <button type="submit" className="btn btn--secondary bank-touch bank-commit" disabled={busy || !canReopen}>
          {busy ? t('bankInbox.row.busy') : t(`bankInbox.reopen.commit${variant}`)}
        </button>
        <button type="button" className="btn btn--ghost bank-touch" onClick={onCancel}>
          {t('bankInbox.panel.cancel')}
        </button>
      </div>
    </form>
  );
}
