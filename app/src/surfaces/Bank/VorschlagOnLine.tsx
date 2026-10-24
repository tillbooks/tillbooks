/**
 * The agent speaks ON THE LINE, in words (the judge's outcome 8). A Vorschlag the agent drafted for
 * this bank line (`list_drafted_actions`, A35) shows in the line's context strip (B2), naming what it
 * would do in the inbox's own vocabulary (the target, the VAT code, the reason) and when it was made.
 *
 * D167: on an OPEN line the strip carries no second Buchen. The row's own Buchen approves the pinned
 * Vorschlag (D162), or, once the person changed the line, books their version first and then closes the
 * Vorschlag; what stays here is the reason line and "Ablehnen", which takes an optional reason the
 * agent's next session reads. On a DECIDED line (a drafted reopen) the row has no Buchen, so the host
 * passes `onApprove` and "Freigeben" stays, with the engine's consequence sentence as its tooltip (C4,
 * D156). The drafting seat never decides its own proposal (`cannot_self_approve`).
 *
 * WHAT YOU APPROVED IS WHAT RUNS (critic N1). When the engine says the record behind the Vorschlag
 * changed since the proposal (`changedSinceProposal`), the strip says so: Buchen then books the line as
 * it stands and closes the stale Vorschlag. Frozen figures, when the drafted verb pins a record, ride on
 * one quiet line under the sentence.
 */
import { useId, useState } from 'react';

import { useT, formatDate } from '../../i18n';
import { Tooltip } from '../../components/Tooltip';
import { useConsequence } from '../../lib/approval-tiers';
import type { BankInboxLine, LineVorschlag } from './model';
import { draftTargetOf } from './model';
import type { Lookups } from './lookups';
import { targetPhrase, taxPhrase } from './lookups';
import { AgentGlyph } from './glyphs';
import { ActionFeedback } from '../../components/ActionFeedback';
import { figuresLine } from '../Agent/model';

export interface VorschlagOnLineProps {
  line: BankInboxLine;
  vorschlag: LineVorschlag;
  lookups: Lookups;
  canDecide: boolean;
  /** The drafting seat is the one looking: it may not approve its own proposal. */
  isOwn: boolean;
  busy: boolean;
  /** "Freigeben", only where the row has no Buchen of its own (a decided line). */
  onApprove?: () => void;
  onReject: (reason: string) => void;
}

/** What the drafted call would do, in the inbox's words. */
export function vorschlagSentence(t: (k: string, p?: Record<string, string | number>) => string, l: Lookups, line: BankInboxLine, v: LineVorschlag): string {
  switch (v.actionTool) {
    case 'book_bank_line': {
      const target = draftTargetOf(v.payload.target);
      if (target === null) return t('bankInbox.vorschlag.bookUnknown');
      const leg = target.kind === 'accounts' && target.legs.length === 1 ? target.legs[0] : undefined;
      const what = targetPhrase(t, l, line, target);
      return leg === undefined ? t('bankInbox.vorschlag.book', { target: what }) : t('bankInbox.vorschlag.bookVat', { target: what, vat: taxPhrase(t, l, leg.taxCode) });
    }
    case 'ignore_bank_line': {
      const reason = typeof v.payload.reason === 'string' ? v.payload.reason : 'other';
      return t('bankInbox.vorschlag.ignore', { reason: t(`bankInbox.ignore.reason.${reason}.label`) });
    }
    case 'reopen_bank_line':
      return t('bankInbox.vorschlag.reopen', { reason: typeof v.payload.reason === 'string' ? v.payload.reason : '' });
    default:
      return t('bankInbox.vorschlag.bookUnknown');
  }
}

export function VorschlagOnLine({ line, vorschlag, lookups, canDecide, isOwn, busy, onApprove, onReject }: VorschlagOnLineProps) {
  const t = useT();
  const baseId = useId();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  // D156: the engine's one consequence for the drafted verb, the sentence the Vorschläge card shows.
  const consequence = useConsequence(vorschlag.actionTool, vorschlag.dialCapability);
  const date = vorschlag.createdAt.length >= 10 ? formatDate(vorschlag.createdAt.slice(0, 10)) : '';
  const changed = vorschlag.changedSinceProposal === true;
  const figures = vorschlag.figures != null ? figuresLine(t, vorschlag.figures) : null;
  const approve =
    onApprove === undefined ? null : (
      <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={onApprove}>
        {busy ? t('bankInbox.row.busy') : t('bankInbox.vorschlag.approve')}
      </button>
    );

  return (
    <section className="bank-vorschlag" aria-labelledby={`${baseId}-title`}>
      <p className="bank-vorschlag__line">
        <span id={`${baseId}-title`} className="bank-vorschlag__kicker">
          <AgentGlyph size={16} />
          {t('bankInbox.vorschlag.kicker')}
          {date !== '' && <span className="bank-vorschlag__date">{t('bankInbox.vorschlag.when', { date })}</span>}
        </span>
        <span className="bank-vorschlag__sentence">{vorschlagSentence(t, lookups, line, vorschlag)}</span>
      </p>
      {figures !== null && <p className="bank-mode__note t-money" data-figures="">{figures}</p>}
      {changed && <ActionFeedback tone="warn" role="note" message={t('agent.card.changed')} />}
      {isOwn ? (
        <p className="bank-mode__note">{t('bankInbox.vorschlag.own')}</p>
      ) : !canDecide ? (
        <p className="bank-mode__note">{t('bankInbox.vorschlag.noRight')}</p>
      ) : rejecting ? (
        <form
          className="bank-vorschlag__reject"
          onSubmit={(e) => {
            e.preventDefault();
            onReject(reason.trim());
          }}
        >
          <label className="bank-field" htmlFor={`${baseId}-reason`}>
            <span className="bank-field__label">{t('bankInbox.vorschlag.rejectReason')}</span>
            <textarea id={`${baseId}-reason`} className="field bank-textarea" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="bank-mode__actions">
            <button type="submit" className="btn btn--secondary btn--sm" disabled={busy}>
              {t('bankInbox.vorschlag.rejectConfirm')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRejecting(false)}>
              {t('bankInbox.panel.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <span className="bank-vorschlag__actions">
          {changed || approve === null ? null : consequence !== null ? <Tooltip content={consequence}>{approve}</Tooltip> : approve}
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setRejecting(true)}>
            {t('bankInbox.vorschlag.reject')}
          </button>
        </span>
      )}
    </section>
  );
}
