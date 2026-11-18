/**
 * The Vorschlag line of Pendenzen and of the Übersicht's suggestions card (D167, D178, D197, D207), drawn as
 * the ONE Vorschlag row the /agent list draws (`VorschlagRow`), so the same proposal reads the same on every
 * screen.
 *
 * D207 (owner, 16.11.2026):
 *
 *  - A CLICK ON THE ROW OPENS ITS DETAILS BELOW (Enter and Space on the row too): the bank line's text, the
 *    proposed booking, why, who and when, and the two ways on as icons ("In Bankzeilen öffnen", "Beleg
 *    ansehen"). The details open and close with the Arrive and leave height motion (`.motion-height`, 0fr to
 *    1fr) and are `inert` while closed. The chevron at the row's end turns and is named "Details".
 *  - THREE ICONS, ONE WORD EACH: Freigeben, "Freigeben und künftig automatisch" (only where the caller hands
 *    `onAutomate`: a bank booking to accounts), Ablehnen. The hover says the name and nothing else; what
 *    Freigeben does (D156's consequence sentence) is one of the details.
 *  - NO OVERFLOW MENU. "Zur Bankzeile" became the details icon; "Referenz kopieren" and "Aufgabe erstellen"
 *    are gone.
 *
 * WHAT YOU APPROVED IS WHAT RUNS (critic N1, D162): a record that changed since the proposal keeps Freigeben in
 * place, disabled (`aria-disabled`, faint) with its reason on the tooltip, and the one way on beside it.
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ChevronRightGlyph } from '../../components/icons';
import { formatDate, useI18n } from '../../i18n';
import { useCan, useCapabilities } from '../../lib/capabilities';
import { useConsequence } from '../../lib/approval-tiers';
import { IconButton } from '../../components/IconButton';
import { Tooltip } from '../../components/Tooltip';
import { Status } from '../../components/Status';
import { ReceiptHolderNotice } from '../../components/BookAgain';
import { LABELLED_VERBS, type DraftedAction } from './model';
import { bankLineOf, bookingLegs, readbackRows, type AccountNameMap, type DetailRow } from './vorschlagDetails';
import type { DialLevels } from './useDialLevels';
import { VorschlagBelege, useBelegOpen } from './VorschlagBelege';
import { VorschlagRow } from './VorschlagRow';
import { RejectControl } from './RejectControl';
import { rowFacts, type RowFacts, type VorschlagItem } from './vorschlagView';
import '../../components/ConsequenceLine.css';
import './VorschlagLine.css';

type T = (key: string, params?: Record<string, string | number>) => string;

/** Which exits the mounting surface may offer (Pendenzen: exactly the ones the engine declared). */
export interface VorschlagOffers {
  approve: boolean;
  reject: boolean;
}

const ALL_OFFERS: VorschlagOffers = { approve: true, reject: true };

export interface VorschlagLineProps {
  action: DraftedAction;
  onApprove: (actionId: string) => void;
  onReject: (actionId: string) => void;
  /**
   * D207: "Freigeben und künftig automatisch": books the line and saves a Buchungsregel from it. Only a bank
   * booking to accounts carries it (`automatable`); absent, the row shows two icons.
   */
  onAutomate?: (actionId: string) => void;
  /** In-flight guard so a double press cannot fire twice while the verb runs. */
  busy?: boolean;
  /** Kept for callers; the Freigabe level lives on Berechtigungen, never as a note on a working row (D197). */
  dial?: DialLevels | null;
  /** The chart's names (`useAccountNames`), so the details name an account, never its id. */
  accountNames?: AccountNameMap;
  offers?: VorschlagOffers;
  /** The roving focus's target: the row itself. */
  titleRef?: (el: HTMLButtonElement | null) => void;
  titleTabIndex?: number;
  titleCurrent?: boolean;
  onTitleFocus?: () => void;
  /** The lead slot's content (the batch box and the kind's glyph), empty otherwise. */
  mark?: ReactNode;
  /** The row's facts as Pendenzen read them off the engine (the subject, the signed amount, the date). */
  facts?: Partial<RowFacts>;
  /** The one way on for a Vorschlag that can no longer be approved (the line in the bank). */
  recovery?: { label: string; onClick: () => void } | null;
  /** The title in place of the drafted thing's own text (the counterparty leads it, N4 M3). */
  titleText?: string;
  /** The one stale wording, said under the subject of a Vorschlag that can no longer be approved. */
  staleText?: string;
  /** This line's part in a running batch: running, approved, or refused with the reason. */
  status?: VorschlagStatus | null;
  /** N03, a mined rule: the approve and reject words ("Regel anlegen", "Nicht vorschlagen"). */
  approveLabel?: string;
  rejectLabel?: string;
  /** N03, a mined rule: rows that lead the details (the bookings it was found in). */
  extraDetails?: DetailRow[];
  /** Controlled: whether the details are open (Pendenzen opens a row to show its rule confirm). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Shown first in the open details: the rule confirm of `attention.auto_rule_confirm = always`, a retry. */
  detailSlot?: ReactNode;
  /** Where "In Bankzeilen öffnen" leads; by default the bank line the Vorschlag names, none without one. */
  bankHref?: string | null;
}

/** One line's part in a batch approval (D178 point 5). */
export interface VorschlagStatus {
  tone: 'running' | 'ok' | 'error';
  text: string;
}

export function verbLabelOf(t: T, verb: string): string {
  return LABELLED_VERBS.has(verb) ? t(`agent.verb.${verb}`) : verb.replace(/_/g, ' ');
}

/** A drafted action read as a listed Vorschlag (the facts it does not carry are absent, never guessed). */
function asItem(action: DraftedAction): VorschlagItem {
  const maybe = action as Partial<VorschlagItem>;
  return {
    ...action,
    batchable: maybe.batchable === true,
    certainty: maybe.certainty ?? null,
    evidenceReasons: maybe.evidenceReasons ?? [],
    resolvedAt: maybe.resolvedAt ?? null,
    resolvedBy: maybe.resolvedBy ?? null,
    closureKind: maybe.closureKind ?? null,
    decidedUnderGrant: maybe.decidedUnderGrant ?? null,
  };
}

export function VorschlagLine({
  action,
  onApprove,
  onReject,
  onAutomate,
  busy = false,
  accountNames,
  offers = ALL_OFFERS,
  titleRef,
  titleTabIndex,
  titleCurrent,
  onTitleFocus,
  mark,
  facts: factsOverride,
  recovery = null,
  titleText,
  staleText,
  status = null,
  approveLabel,
  rejectLabel,
  extraDetails = [],
  open: openProp,
  onOpenChange,
  detailSlot,
  bankHref,
}: VorschlagLineProps) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const detailsId = useId();
  // The self-approve ban, VISIBLE at the surface: the drafting actor never sees an approve control
  // (the engine's cannot_self_approve still bites underneath). Lacking the right and being the
  // drafting actor are two different reasons and get two different sentences (critic F15).
  const whoami = useCapabilities().whoami;
  const isDraftingActor = whoami?.actor === action.actor;
  const canDecide = useCan('manage_agent_dial') && !isDraftingActor;
  const changed = action.changedSinceProposal === true;
  const [openOwn, setOpenOwn] = useState(false);
  const open = openProp ?? openOwn;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenOwn(next);
    onOpenChange?.(next);
  };
  // The details mount on the first open and stay, so closing can play its height; a row never opened reads
  // nothing (no Beleg preview is fetched for a closed row).
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  const item = asItem(action);
  const capability = action.dialCapability ?? '';
  const facts: RowFacts = { ...rowFacts(t, locale, item, accountNames, titleText), ...factsOverride };
  const title = facts.subject;
  // D156: the engine's one consequence for the drafted verb, said in the details.
  const consequence = useConsequence(action.actionTool, capability);
  const bankLine = bankLineOf(action);
  const bankLink = bankHref !== undefined ? bankHref : bankLine !== null ? `/bank?line=${encodeURIComponent(bankLine)}` : null;
  const belege = action.belege ?? [];
  const beleg = useBelegOpen(action.actionId);

  let decisions: ReactNode = null;
  if (status?.tone === 'running') {
    decisions = (
      <span className="vorschlag-line-hint" role="status">
        {status.text}
      </span>
    );
  } else if (status?.tone === 'ok') {
    decisions = <Status kind="success" label={status.text} />;
  } else if (canDecide) {
    decisions = (
      <>
        {offers.approve && (
          <IconButton
            icon="approve"
            small
            className={changed ? 'vorschlag-approve vdet-approve--disabled' : 'vorschlag-approve'}
            name={approveLabel ?? t('agent.vq.approve')}
            context={changed ? t('agent.vq.staleReason') : ''}
            aria-disabled={changed || busy ? true : undefined}
            onClick={() => {
              if (!changed && !busy) onApprove(action.actionId);
            }}
          />
        )}
        {offers.approve && onAutomate !== undefined && !changed && (
          <IconButton
            icon="rule"
            small
            className="vorschlag-automate"
            name={t('agent.line.automate')}
            context=""
            aria-disabled={busy ? true : undefined}
            onClick={() => {
              if (!busy) onAutomate(action.actionId);
            }}
          />
        )}
        {changed && recovery !== null && <IconButton icon="open" small className="vorschlag-recovery" name={recovery.label} context="" onClick={recovery.onClick} />}
        {offers.reject && (
          <RejectControl small context="" busy={busy} {...(rejectLabel !== undefined ? { name: rejectLabel } : {})} onReject={() => onReject(action.actionId)} />
        )}
      </>
    );
  } else if (changed && recovery !== null) {
    decisions = <IconButton icon="open" small className="vorschlag-recovery" name={recovery.label} context="" onClick={recovery.onClick} />;
  } else if (isDraftingActor) {
    decisions = <span className="vorschlag-line-hint">{t('agent.card.selfHint')}</span>;
  } else {
    decisions = (
      <Link className="link-inline vorschlag-line-hint" to="/members">
        {t('agent.card.needs')}
      </Link>
    );
  }

  // Under the subject: a batch's refusal. A stale line says so in the certainty's place, as on /agent.
  const statusLine = status?.tone === 'error' ? <Status kind="warn" label={status.text} className="vorschlag-line-status" /> : null;

  // THE DETAILS. A bank booking says its line and its legs; anything else its read-back. Then why, who and when.
  const legs = bookingLegs(t, action, accountNames, facts.currency);
  const lineText = (action as Partial<VorschlagItem>).lineFacts?.text ?? (typeof action.payload.text === 'string' ? action.payload.text : null);
  const rows: DetailRow[] = [];
  if (lineText !== null && lineText !== '') rows.push({ key: '__line', label: t('agent.line.bankLine'), value: lineText });
  if (legs.length === 0) {
    rows.push(...readbackRows(t, locale, action, { accountNames, extra: extraDetails, omit: ['text'] }).filter((r) => r.key !== '__proposed'));
  } else {
    rows.push(...extraDetails);
  }
  if (action.agentReason !== undefined && action.agentReason !== null && action.agentReason.trim() !== '') {
    rows.push({ key: '__why', label: t('agent.line.why'), value: t('agent.line.agentReason', { text: action.agentReason.trim() }) });
  }
  const date = action.createdAt.length >= 10 ? formatDate(action.createdAt.slice(0, 10)) : action.createdAt;
  rows.push({ key: '__who', label: t('agent.line.who'), value: t('agent.line.whoValue', { actor: action.actor === 'system' ? 'TILL' : t('agent.line.agentActor'), date }) });
  if (consequence !== null && consequence !== '') rows.push({ key: '__does', label: t('agent.line.does'), value: consequence });

  const toggle = () => setOpen(!open);

  return (
    <article className="vorschlag-line" data-action-id={action.actionId} data-changed={changed ? 'true' : undefined} data-open={open ? 'true' : undefined}>
      <VorschlagRow
        actionId={action.actionId}
        facts={{ ...facts, stale: changed && status?.tone !== 'error' }}
        lead={mark}
        stale={changed}
        // D207: the row itself is the roving stop AND the disclosure; Enter and Space open it like a click.
        onSelect={toggle}
        expanded={open}
        controls={detailsId}
        selected={titleCurrent === true}
        {...(titleRef !== undefined ? { mainRef: titleRef } : {})}
        {...(titleTabIndex !== undefined ? { mainTabIndex: titleTabIndex } : {})}
        {...(onTitleFocus !== undefined ? { onMainFocus: onTitleFocus } : {})}
        {...(staleText !== undefined ? { staleLabel: staleText } : {})}
        status={statusLine}
        actions={
          <>
            {decisions}
            <span className="vrow-disclose-cell">
              <Tooltip content={t('agent.line.details')}>
                <button
                  type="button"
                  className="btn btn--ghost btn--icon btn--sm vrow-disclose"
                  aria-expanded={open}
                  aria-controls={open ? detailsId : undefined}
                  onClick={toggle}
                >
                  <ChevronRightGlyph size={16} />
                  <span className="visually-hidden">{t('agent.line.detailsOf', { title })}</span>
                </button>
              </Tooltip>
            </span>
          </>
        }
      />

      {/* N02 R1: the receipt is already booked elsewhere; approving books it a second time (with a reason). */}
      {action.receiptHolders !== undefined && action.receiptHolders.length > 0 && (
        <ReceiptHolderNotice holders={action.receiptHolders} className="vorschlag-line-changed" />
      )}

      <div id={detailsId} className="motion-height vorschlag-line-drawer" data-open={open ? 'true' : 'false'} inert={!open}>
        <div>
          {mounted && (
            <div className="vorschlag-line-details">
              {detailSlot}
              <dl className="vorschlag-readback" aria-label={t('agent.line.detailsOf', { title })}>
                {rows.map((row) => (
                  <div className="vorschlag-readback-row" key={row.key}>
                    <dt>{row.label}</dt>
                    <dd title={row.title}>{row.value}</dd>
                  </div>
                ))}
                {legs.length > 0 && (
                  <div className="vorschlag-readback-row" key="__legs">
                    <dt>{t('agent.line.booking')}</dt>
                    <dd className="vorschlag-legs">
                      {legs.map((leg, i) => (
                        <span key={i} className="vorschlag-leg">
                          <span className="vorschlag-leg-account">{leg.account}</span>
                          {leg.amount !== null && <span className="vorschlag-leg-amount t-money">{leg.amount}</span>}
                          {leg.taxCode !== null && <span className="vorschlag-leg-tax">{leg.taxCode}</span>}
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
              {belege.length > 0 && <VorschlagBelege actionId={action.actionId} belege={belege} canPreview={canDecide} />}
              {(bankLink !== null || (belege.length > 0 && canDecide)) && (
                <div className="vorschlag-line-ways">
                  {bankLink !== null && <IconButton icon="open" small name={t('agent.line.openInBank')} context="" onClick={() => navigate(bankLink)} />}
                  {belege.length > 0 && canDecide && (
                    <IconButton icon="attach" small name={t('agent.line.viewBeleg')} context="" onClick={() => void beleg.open(belege[0] as (typeof belege)[number])} />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
