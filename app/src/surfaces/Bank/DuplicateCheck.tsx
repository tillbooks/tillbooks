/**
 * D178 point 19 (A20 §11.4, owner 21.10.2026: "flag possible duplicates to be approved by the user"): the
 * question a flagged bank line asks before anything books it, in the detail area under the facts card.
 *
 * It names every stored line the new one may be (the format it came in through, its date, its amount, and
 * why in a few words), and offers the two answers `resolve_possible_duplicate` takes: "Duplikat" (the line
 * is ignored with the reason `duplicate`, Rückgängig in the status line) and "Kein Duplikat" (a normal line
 * again). Until answered, Buchen stays disabled and says why (the engine refuses `duplicate_decision_pending`
 * anyway). A new line on a day a statement already covers, with nothing to name, asks the same question.
 */
import { useT, formatDate, formatMoney } from '../../i18n';
import { StatusWarnGlyph } from '../../components/icons';
import type { BankInboxLine } from './model';
import type { DuplicateFlagView } from './statementFacts';

export interface DuplicateCheckProps {
  line: BankInboxLine;
  flag: DuplicateFlagView;
  busy: boolean;
  canDecide: boolean;
  onDecide: (decision: 'duplicate' | 'distinct', otherBankTxnId: string | null) => void;
  /** Open a candidate line (a deep link to it). */
  onShowLine: (bankTxnId: string) => void;
}

const FORMAT_LABEL: Readonly<Record<string, string>> = { camt: 'camt.053', camt053: 'camt.053', camt054: 'camt.054', mt940: 'MT940', csv: 'CSV' };

export function DuplicateCheck({ line, flag, busy, canDecide, onDecide, onShowLine }: DuplicateCheckProps) {
  const t = useT();
  const first = flag.candidates[0]?.bankTxnId ?? null;
  const titleId = `dup-${line.bankTxnId}`;
  return (
    <div className="bank-dup" role="group" aria-labelledby={titleId} data-duplicate-for={line.bankTxnId}>
      <p id={titleId} className="bank-dup__title">
        <StatusWarnGlyph size={16} className="bank-dup__glyph" />
        {flag.candidates.length > 0 ? t('bankInbox.duplicate.title') : t('bankInbox.duplicate.titleCovered')}
      </p>
      {flag.candidates.length > 0 ? (
        <ul className="bank-dup__list">
          {flag.candidates.map((c) => (
            <li key={c.bankTxnId} className="bank-dup__candidate" data-candidate={c.bankTxnId}>
              <span className="bank-dup__what">
                {[FORMAT_LABEL[c.format] ?? c.format, c.date === null ? '' : formatDate(c.date)].filter((x) => x !== '').join(' · ')}
                {' · '}
                <span className="t-money">
                  {c.amountMinor < 0 ? '−' : ''}
                  {formatMoney(Math.abs(c.amountMinor), c.currency)}
                </span>
              </span>
              <span className="bank-dup__why">{t(`bankInbox.duplicate.reason.${c.reason}`)}</span>
              <button type="button" className="link-inline bank-dup__show" onClick={() => onShowLine(c.bankTxnId)}>
                {t('bankInbox.duplicate.show')}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="bank-dup__why">{t(`bankInbox.duplicate.reason.${flag.reason}`)}</p>
      )}
      <span className="bank-dup__answers">
        <button type="button" className="btn btn--secondary btn--sm" disabled={busy || !canDecide} onClick={() => onDecide('duplicate', first)}>
          {t('bankInbox.duplicate.isDuplicate')}
        </button>
        <button type="button" className="btn btn--secondary btn--sm" disabled={busy || !canDecide} onClick={() => onDecide('distinct', null)}>
          {t('bankInbox.duplicate.isDistinct')}
        </button>
      </span>
    </div>
  );
}
