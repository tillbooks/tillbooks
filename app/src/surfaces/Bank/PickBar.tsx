/**
 * The bulk bar: what happens to the lines picked with the row checkboxes (the judge's outcome 1,
 * "multi-select"). It books the picked lines that are ready (a target, in balance, the right to book
 * it, and no agent Vorschlag waiting on them, which only its approval may book) and says how many stay
 * behind; or it ignores all of them with ONE reason. "Anderer Grund" is left out on purpose: it asks
 * for a note in the person's own words, which belongs to one line, not to a batch.
 *
 * Every write is the agent's own verb, once per line (`book_bank_line`, `ignore_bank_line`), each with
 * its own idempotency key, so a refused line keeps its refusal on its row and the others still land.
 */
import { useId, useState } from 'react';

import { useT } from '../../i18n';
import { Select } from '../../components/Select';
import { BANK_LINE_IGNORE_REASONS, type IgnoreReason } from './model';
import { plural } from './lookups';

export interface PickBarProps {
  count: number;
  /** Of the picked lines, how many can be booked as they stand. */
  ready: number;
  busy: boolean;
  canPost: boolean;
  onBook: () => void;
  onIgnore: (reason: IgnoreReason) => void;
  onClear: () => void;
}

const BULK_REASONS = BANK_LINE_IGNORE_REASONS.filter((r) => r !== 'other');

export function PickBar({ count, ready, busy, canPost, onBook, onIgnore, onClear }: PickBarProps) {
  const t = useT();
  const baseId = useId();
  const [ignoring, setIgnoring] = useState(false);
  const [reason, setReason] = useState<IgnoreReason>('booked_elsewhere');

  return (
    <section className="bank-pickbar" aria-label={t('bankInbox.pick.label')}>
      <p className="bank-pickbar__count" role="status">
        {plural(t, 'bankInbox.pick.count', count)}
      </p>
      {ignoring ? (
        <>
          <label className="bank-pickbar__field" htmlFor={`${baseId}-reason`}>
            <span className="bank-field__label">{t('bankInbox.pick.ignoreReason')}</span>
            <Select
              id={`${baseId}-reason`}
              ariaLabel={t('bankInbox.pick.ignoreReason')}
              value={reason}
              onChange={(v) => setReason(v as IgnoreReason)}
              options={BULK_REASONS.map((r) => ({ value: r, label: t(`bankInbox.ignore.reason.${r}.label`) }))}
            />
          </label>
          <button type="button" className="btn btn--secondary bank-touch" disabled={busy || !canPost} onClick={() => onIgnore(reason)}>
            {busy ? t('bankInbox.row.busy') : plural(t, 'bankInbox.pick.ignoreConfirm', count)}
          </button>
          <button type="button" className="btn btn--ghost bank-touch" disabled={busy} onClick={() => setIgnoring(false)}>
            {t('bankInbox.panel.cancel')}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn btn--secondary bank-touch" disabled={busy || ready === 0} onClick={onBook}>
            {busy ? t('bankInbox.row.busy') : ready === 0 ? t('bankInbox.row.book') : plural(t, 'bankInbox.pick.book', ready)}
          </button>
          <button type="button" className="btn btn--secondary bank-touch" disabled={busy || !canPost} onClick={() => setIgnoring(true)}>
            {t('bankInbox.pick.ignore')}
          </button>
          <button type="button" className="btn btn--ghost bank-touch" disabled={busy} onClick={onClear}>
            {t('bankInbox.pick.clear')}
          </button>
          {ready < count && <p className="bank-pickbar__note">{plural(t, 'bankInbox.pick.notReady', count - ready)}</p>}
        </>
      )}
    </section>
  );
}
