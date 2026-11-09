/**
 * N04 (D183), the daily digest card's lines: every bank line a granted Buchungsregel booked on its own that
 * day, with "Rückgängig" (`reopen_bank_line`: a reversing entry, the line open again, the grant pauses) and
 * "Automatik aus" (`revoke_rule_autobook`), and every line it left to a person with the reason. "Gesehen"
 * is the card's own decision option (AttentionRow). Rendered under the card's row; an empty day has no card.
 * "Rückgängig" is an undo through the bank line's own reopen door, not a commit, so it stays untinted (the accent guard).
 */

import { Link } from 'react-router-dom';

import { formatDate, formatMoney, useI18n } from '../../i18n';
import type { DecisionOption } from './RowDecision';
import type { AutobookDigest, AutobookDigestLine } from './model';

/**
 * A41.3 re-cut v2: one line a live rule would book but that waits for its receipt NOW (`autobook_digest`
 * `waitingForBeleg`), with the engine's reason; a seat without the receipt read right reads one reason only.
 */
export interface WaitingLine {
  bankTxnId: string;
  counterparty: string;
  ruleLabel: string | null;
  amountMinor: number;
  currency: string;
  lineDate: string;
  reason: string;
}

/** The waiting lines of an `autobook_digest` answer, read defensively (empty when absent or unreadable). */
export function parseWaiting(body: unknown): WaitingLine[] {
  const raw = typeof body === 'object' && body !== null ? (body as { waitingForBeleg?: unknown }).waitingForBeleg : undefined;
  if (!Array.isArray(raw)) return [];
  const out: WaitingLine[] = [];
  for (const w of raw as unknown[]) {
    const r = typeof w === 'object' && w !== null ? (w as Record<string, unknown>) : null;
    if (r === null || typeof r.bankTxnId !== 'string' || typeof r.amountMinor !== 'number' || typeof r.currency !== 'string') continue;
    out.push({
      bankTxnId: r.bankTxnId,
      counterparty: typeof r.counterparty === 'string' ? r.counterparty : '',
      ruleLabel: typeof r.ruleLabel === 'string' ? r.ruleLabel : null,
      amountMinor: r.amountMinor,
      currency: r.currency,
      lineDate: typeof r.lineDate === 'string' ? r.lineDate : '',
      reason: typeof r.reason === 'string' ? r.reason : 'no_beleg',
    });
  }
  return out;
}

export interface AutobookDigestLinesProps {
  digest: AutobookDigest;
  /** A41.3: the lines that wait for their receipt now (shown under the newest day's card only). */
  waiting?: readonly WaitingLine[];
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

export function AutobookDigestLines({ digest, onAct, busy, waiting = [] }: AutobookDigestLinesProps) {
  const { t } = useI18n();
  return (
    <>
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
    {waiting.length > 0 && (
      <ul className="att-digest" aria-label={t('attention.item.autobookDigest.waitingTitle', { count: waiting.length })} data-waiting="">
        {waiting.map((w) => (
          <li key={w.bankTxnId} className="att-digest-line">
            <span className="att-digest-what">{t('attention.item.autobookDigest.line', { counterparty: w.counterparty, rule: w.ruleLabel ?? w.counterparty })}</span>
            <span className="att-digest-amount t-num">{formatMoney(Math.abs(w.amountMinor), w.currency)}</span>
            <span className="att-digest-date t-num">{w.lineDate.length >= 10 ? formatDate(w.lineDate.slice(0, 10)) : ''}</span>
            <span className="att-digest-state">
              {t('attention.item.autobookDigest.waiting')}: {t(`attention.item.autobookDigest.waitReason.${w.reason}`)}
            </span>
            <span className="att-digest-acts">
              <Link className="btn btn--ghost btn--sm" to={`/bank?line=${encodeURIComponent(w.bankTxnId)}`}>
                {t('attention.item.autobookDigest.openLine')}
              </Link>
            </span>
          </li>
        ))}
      </ul>
    )}
    </>
  );
}
