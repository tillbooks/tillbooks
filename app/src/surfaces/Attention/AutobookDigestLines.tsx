/**
 * N04 (D183), the daily digest card's lines: every bank line a granted Buchungsregel booked on its own that
 * day, with "Rückgängig" (`reopen_bank_line`: a reversing entry, the line open again, the grant pauses) and
 * "Automatik aus" (`revoke_rule_autobook`), and every line it left to a person with the reason. "Gesehen"
 * is the card's own decision option (AttentionRow). Rendered under the card's row; an empty day has no card.
 * "Rückgängig" is an undo through the bank line's own reopen door, not a commit, so it stays untinted (the accent guard).
 */

import { formatDate, formatMoney, useI18n } from '../../i18n';
import type { DecisionOption } from './RowDecision';
import type { AutobookDigest, AutobookDigestLine } from './model';

export interface AutobookDigestLinesProps {
  digest: AutobookDigest;
  /** Runs one decision through the hub's own act (feedback, re-read). */
  onAct: (option: DecisionOption) => void;
  busy: boolean;
}

/** The two per-line decisions, as hub options (verb + input), keyed per line so a double click replays. */
export function undoOption(line: AutobookDigestLine, reason: string): DecisionOption {
  return {
    id: 'undo',
    verb: 'reopen_bank_line',
    labelKey: 'attention.act.undo',
    role: 'danger',
    input: { bankTxnId: line.bankTxnId, reason, idempotencyKey: `attention:autobook-undo:${line.bankTxnId}:${line.entryId ?? ''}` },
  } as DecisionOption;
}

export function autobookOffOption(line: AutobookDigestLine, day: string): DecisionOption {
  return {
    id: 'autobook_off',
    verb: 'revoke_rule_autobook',
    labelKey: 'attention.act.autobookOff',
    role: 'secondary',
    input: { standardId: line.standardId, idempotencyKey: `attention:autobook-off:${line.standardId}:${day}` },
  } as DecisionOption;
}

export function AutobookDigestLines({ digest, onAct, busy }: AutobookDigestLinesProps) {
  const { t } = useI18n();
  return (
    <ul className="att-digest" aria-label={t('attention.item.autobookDigest.title', { count: digest.lines.filter((l) => l.entryId !== null).length })}>
      {digest.lines.map((line) => {
        const rule = line.ruleLabel ?? line.counterparty;
        const booked = line.entryId !== null;
        return (
          <li key={line.bankTxnId} className="att-digest-line" data-booked={booked ? '' : undefined}>
            <span className="att-digest-what">{t('attention.item.autobookDigest.line', { counterparty: line.counterparty, rule })}</span>
            <span className="att-digest-amount t-num">{formatMoney(Math.abs(line.amountMinor), line.currency)}</span>
            <span className="att-digest-date t-num">{formatDate(line.lineDate.slice(0, 10))}</span>
            {booked ? (
              line.stands ? (
                <span className="att-digest-acts">
                  <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => onAct(undoOption(line, t('attention.act.undo')))}>
                    {t('attention.act.undo')}
                  </button>
                  {line.grantLive ? (
                    <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => onAct(autobookOffOption(line, digest.day))}>
                      {t('attention.act.autobookOff')}
                    </button>
                  ) : null}
                </span>
              ) : (
                <span className="att-digest-state">{t('attention.item.autobookDigest.undone')}</span>
              )
            ) : (
              <span className="att-digest-state">
                {t('attention.item.autobookDigest.notBooked')}: {t(`attention.item.autobookDigest.reason.${line.reason ?? 'refused'}`)}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
