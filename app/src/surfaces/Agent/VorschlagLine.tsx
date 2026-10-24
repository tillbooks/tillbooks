/**
 * The Vorschlag line (D167 point 3, owner pick 3B): ONE component, rendered by Pendenzen (where a
 * Vorschlag is decided) and by the `/agent` Vorschläge tab, so both read the same.
 *
 * It replaces the Vorschlag card the owner rejected ("a lot of text, huge buttons that make no sense,
 * and Details is just code"). On its face, one line: the agent mark, the drafted verb in words, ONE
 * key figure, an (i) whose real tooltip holds the engine's consequence sentence (D156, the commit
 * points `aria-describedby` at the same words), "Genehmigen" as a SECONDARY button (a list spends no
 * accent; one primary per screen) and a ⋯. Everything else is one click away:
 *
 *  - Details: a disclosure of label and value pairs (the pinned figures, the payload in words, who
 *    proposed it when, and the Freigabe level READ from the dial). Never JSON, never the verb in code.
 *  - "Genehmigen und künftig automatisch": only for a holder of `manage_agent_dial` who did not draft
 *    it, never on a changed record, and confirmed in place with the grant sentence (D103: a grant is
 *    explicit, attributed and revocable, so the person reads that before it happens).
 *  - Ablehnen: destructive, last, confirmed in place with the optional reason (J5.6).
 *
 * WHAT YOU APPROVED IS WHAT RUNS (critic N1, D162): a record that changed since the proposal shows one
 * line saying so and no Genehmigen; rejecting stays possible. A bank-line Vorschlag links to its line.
 *
 * D178 (21.10.2026): Pendenzen's ONE row pattern, the `compact` line. The line and the hub's `AttentionRow`
 * share the five slots (glyph, title over one meta line, (i), one button, ⋯) and one type scale. Pendenzen
 * hands in the `mark` (the batch box takes the glyph slot), the `meta` (amount, target, date in the one
 * format of its rows), a per-row `status` while a batch runs and, for a Vorschlag that can no longer be
 * approved, the one `recovery` (the line in the bank) and the one stale wording; the explanation then sits
 * behind the (i). With `bankLineInMenu` the link to the bank line moves into the ⋯. The `/agent` queue
 * keeps its visible stale sentence (critic N4 L4): only Pendenzen moves it behind the (i).
 */
import { useEffect, useId, useLayoutEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useI18n, formatDate, formatMoney } from '../../i18n';
import { useCan, useCapabilities } from '../../lib/capabilities';
import { useConsequence } from '../../lib/approval-tiers';
import { OverflowMenu, type OverflowMenuItem } from '../../components/OverflowMenu';
import { Status } from '../../components/Status';
import { Tooltip } from '../../components/Tooltip';
import { AgentMarkGlyph } from '../../components/icons';
import { InfoGlyph } from '../../components/states/glyphs';
import { LABELLED_VERBS, type DraftedAction, type VorschlagFigures } from './model';
import { argumentRows, bankLineOf, essentials, keyFigure, payloadAmount, payloadTitle, type AccountNameMap, type DetailRow } from './vorschlagDetails';
import type { DialLevels } from './useDialLevels';
import '../../components/ConsequenceLine.css';
import './VorschlagLine.css';

type T = (key: string, params?: Record<string, string | number>) => string;

/** The meta line's separator. Non-breaking spaces: the meta line is a flex row, which trims plain ones. */
const SEP = '\u00a0·\u00a0';

/** Which exits the mounting surface may offer (Pendenzen: exactly the ones the engine declared). */
export interface VorschlagOffers {
  approve: boolean;
  approveAllow: boolean;
  reject: boolean;
}

const ALL_OFFERS: VorschlagOffers = { approve: true, approveAllow: true, reject: true };

export interface VorschlagLineProps {
  action: DraftedAction;
  onApprove: (actionId: string, allowFuture: boolean) => void;
  /** `reason` is the human's optional sentence (F-08, J5.6): "No, and tell it why". */
  onReject: (actionId: string, reason?: string) => void;
  /** In-flight guard so a double press cannot fire twice while the verb runs. */
  busy?: boolean;
  /** The dial as `get_agent_dial` read it; null or absent leaves the Freigabe row out. */
  dial?: DialLevels | null;
  /** The chart's names (`useAccountNames`), so Details name an account, never its id. */
  accountNames?: AccountNameMap;
  offers?: VorschlagOffers;
  /** Pendenzen's own triage items (Aufgabe erstellen, Referenz kopieren) join the same ⋯. */
  extraMenuItems?: OverflowMenuItem[];
  /** Pendenzen: the line sits among other kinds of rows, so its meta line names the agent in words. */
  showOrigin?: boolean;
  /**
   * The roving focus's target: the title button on /agent; in Pendenzen's compact line, whose title is words
   * and never a button (the fresh-eyes judge, N4 M4), the row's one action button.
   */
  titleRef?: (el: HTMLButtonElement | null) => void;
  titleTabIndex?: number;
  titleCurrent?: boolean;
  onTitleFocus?: () => void;
  /** D178, Pendenzen's compact line: one row pattern, the stale sentence behind the (i), the slots below. */
  compact?: boolean;
  /** D178, Pendenzen: the glyph slot's content in place of the agent mark (the batch box). */
  mark?: ReactNode;
  /** D178, Pendenzen: the meta line in the hub's one format (amount, target, date) in place of the essentials. */
  meta?: ReactNode;
  /** D178, Pendenzen: the date, said LAST after the line's own essentials (the hub's one order). */
  metaTail?: ReactNode;
  /** D178, compact: the one way on for a Vorschlag that can no longer be approved (the line in the bank). */
  recovery?: { label: string; onClick: () => void } | null;
  /** N4 M3, compact: the title in place of the drafted thing's own text (the counterparty leads it). */
  titleText?: string;
  /** D178, compact: the one stale wording, said under the row of a Vorschlag that can no longer be approved. */
  staleText?: string;
  /** D178, Pendenzen: this line's part in a running batch: running, approved, or refused with the reason. */
  status?: VorschlagStatus | null;
  /** D178, Pendenzen: the bank-line link sits in the ⋯ instead of the meta line. */
  bankLineInMenu?: boolean;
}

/** One line's part in a batch approval (D178 point 5). */
export interface VorschlagStatus {
  tone: 'running' | 'ok' | 'error';
  text: string;
}

/**
 * The meta line's essentials, cut with an ellipsis where the line is short. The tooltip with the full text
 * is there ONLY when the text is actually cut (D167 polish 11): a tooltip repeating what is fully on screen
 * is noise. Measured on layout and on every resize.
 */
function Essentials({ text }: { text: string }) {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  const tipId = useId();
  // ONE stable structure whether cut or not (the span never moves, so measuring it cannot flip the layout
  // it measures): measured on layout, on a text change and on every resize of its own box.
  useLayoutEffect(() => {
    if (el !== null) setCut(el.scrollWidth > el.clientWidth + 1);
  }, [el, text]);
  useEffect(() => {
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setCut(el.scrollWidth > el.clientWidth + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  const show = cut && open;
  return (
    <span className="tooltip-wrap vorschlag-line-essentials">
      <span
        ref={setEl}
        className="vorschlag-line-figure t-money"
        data-figure="key"
        data-cut={cut ? 'true' : undefined}
        tabIndex={cut ? 0 : undefined}
        aria-describedby={cut ? tipId : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        {text}
      </span>
      {cut && (
        <span role="tooltip" id={tipId} className={`tooltip tooltip-top${show ? ' is-open' : ''}`}>
          {text}
        </span>
      )}
    </span>
  );
}

export function verbLabelOf(t: T, verb: string): string {
  return LABELLED_VERBS.has(verb) ? t(`agent.verb.${verb}`) : verb.replace(/_/g, ' ');
}

/** The pinned figures (D162) as read-back rows, only the ones the engine could derive. */
function figureRows(t: T, f: VorschlagFigures): DetailRow[] {
  const currency = f.currency ?? 'CHF';
  const rows: DetailRow[] = [];
  if (f.amountMinor !== null) {
    rows.push({ key: '__amount', label: f.amountBasis === 'net' ? t('agent.card.figure.net') : t('agent.field.amount'), value: formatMoney(f.amountMinor, currency), money: true });
  }
  if (f.taxMinor !== null && f.grossMinor !== null) {
    rows.push({ key: '__vat', label: t('agent.card.figure.vat'), value: formatMoney(f.taxMinor, currency), money: true });
    rows.push({ key: '__gross', label: t('agent.card.figure.gross'), value: formatMoney(f.grossMinor, currency), money: true });
  }
  if (f.number !== null || f.numberPending) rows.push({ key: '__number', label: t('agent.card.figure.number'), value: f.number ?? t('agent.card.figure.draft') });
  if (f.counterparty !== null) rows.push({ key: '__counterparty', label: t('agent.card.figure.counterparty'), value: f.counterparty });
  if (f.recipient !== null) rows.push({ key: '__recipient', label: t('agent.card.figure.recipient'), value: f.recipient });
  if (f.lineCount !== null) rows.push({ key: '__lines', label: t('agent.card.figure.lines'), value: String(f.lineCount) });
  return rows;
}

export function VorschlagLine({
  action,
  onApprove,
  onReject,
  busy = false,
  dial = null,
  accountNames,
  offers = ALL_OFFERS,
  extraMenuItems = [],
  showOrigin = false,
  titleRef,
  titleTabIndex,
  titleCurrent,
  onTitleFocus,
  compact = false,
  mark,
  meta,
  metaTail,
  recovery = null,
  titleText,
  staleText,
  status = null,
  bankLineInMenu = false,
}: VorschlagLineProps) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const detailsId = useId();
  const consequenceId = useId();
  const reasonId = useId();
  // The self-approve ban, VISIBLE at the surface: the drafting actor never sees an approve control
  // (the engine's cannot_self_approve still bites underneath). Lacking the right and being the
  // drafting actor are two different reasons and get two different sentences (critic F15).
  const whoami = useCapabilities().whoami;
  const isDraftingActor = whoami?.actor === action.actor;
  const canDecide = useCan('manage_agent_dial') && !isDraftingActor;
  const changed = action.changedSinceProposal === true;
  const [showDetails, setShowDetails] = useState(false);
  const [confirming, setConfirming] = useState<'reject' | 'grant' | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const capability = action.dialCapability ?? '';
  const verb = verbLabelOf(t, action.actionTool);
  // D167 polish 11: the title is the THING (the entry's or payment's own text), the verb moves to the meta.
  const thing = payloadTitle(action.payload);
  const title = titleText ?? thing?.text ?? verb;
  // Compact (Pendenzen): the roving focus sits on the row's one action button, the title is words.
  const focusOnAction = compact
    ? { ref: titleRef, tabIndex: titleTabIndex, 'aria-current': titleCurrent ? ('true' as const) : undefined, onFocus: onTitleFocus }
    : {};
  // D156: the engine's one consequence for the drafted verb (its own entry, else the tier the seam
  // stored), the identical sentence a human confirm of the same verb and the MCP description carry.
  const consequence = useConsequence(action.actionTool, capability);
  // D162 point 1: the pinned essentials (accounts in words, counterparty, total) on the line's face; a
  // verb with none of them keeps its one key figure (a period, a number).
  const figure = essentials(t, locale, action, accountNames) ?? keyFigure(t, locale, action);
  const bankLine = bankLineOf(action);
  const level = dial?.get(capability) ?? null;

  const details = (): DetailRow[] => {
    const figures = action.figures ?? null;
    const rows: DetailRow[] = [];
    const omit = new Set<string>();
    if (bankLine !== null) omit.add('bankTxnId'); // the link names the line; its id is no fact for a person
    // D167 polish 11: the title's text is not repeated, and the entry's source is no fact here (it read
    // "Manuell" beside "von Agent").
    if (thing !== null) omit.add(thing.key);
    omit.add('source');
    const hasLegs = Array.isArray(action.payload.lines) || (action.payload.target !== null && typeof action.payload.target === 'object' && Array.isArray((action.payload.target as { legs?: unknown }).legs));
    if (figures !== null) {
      rows.push(...figureRows(t, figures));
    } else {
      // Critic F4: the money the draft moves leads the read-back, formatted, never buried.
      // ...unless the legs below already carry every figure (polish 11: no "Betrag" row repeating them).
      const lead = hasLegs ? null : payloadAmount(action.payload);
      if (lead !== null) {
        const currency = typeof action.payload.currency === 'string' ? action.payload.currency : 'CHF';
        rows.push({ key: '__lead', label: t('agent.field.amount'), value: formatMoney(lead, currency), money: true });
        omit.add('amountMinor');
      }
    }
    rows.push(...argumentRows(t, locale, action.payload, action.payloadLabels ?? {}, omit, accountNames));
    const date = action.createdAt.length >= 10 ? formatDate(action.createdAt.slice(0, 10)) : action.createdAt;
    rows.push({ key: '__proposed', label: t('agent.line.proposed'), value: t('agent.line.proposedValue', { date, actor: t('agent.line.agentActor') }) });
    if (level !== null) {
      const word =
        level.effective === 'auto' ? t('agent.line.levelAuto') : level.strongDefault ? t('agent.line.levelAskAlways') : t('agent.line.levelAsk');
      rows.push({ key: '__level', label: t('agent.line.level'), value: word, link: { to: '/agent?tab=berechtigungen', label: t('agent.line.levelLink') } });
    }
    return rows;
  };

  const menu: OverflowMenuItem[] = [
    { key: 'details', label: showDetails ? t('agent.line.hideDetails') : t('agent.line.details'), onSelect: () => setShowDetails((v) => !v) },
    ...(bankLineInMenu && bankLine !== null
      ? [{ key: 'bank-line', label: t('agent.line.toBankLine'), onSelect: () => navigate(`/bank?line=${encodeURIComponent(bankLine)}`) }]
      : []),
    ...(canDecide && !changed && offers.approveAllow
      ? [{ key: 'approve-allow', label: t('agent.card.approveAllow'), onSelect: () => setConfirming('grant'), disabled: busy }]
      : []),
    ...extraMenuItems,
    ...(canDecide && offers.reject
      ? [{ key: 'reject', label: t('agent.card.reject'), onSelect: () => setConfirming('reject'), danger: true, disabled: busy }]
      : []),
  ];

  let actionSlot: ReactNode = null;
  if (status?.tone === 'running') {
    actionSlot = (
      <span className="vorschlag-line-hint" role="status">
        {status.text}
      </span>
    );
  } else if (status?.tone === 'ok') {
    actionSlot = <Status kind="success" label={status.text} />;
  } else if (compact && changed) {
    // D178 (the design judge): ONE way on where Genehmigen would be, the line in the bank; the stale
    // wording is said under the row and the explanation sits behind the (i).
    actionSlot =
      recovery !== null ? (
        <button type="button" className="btn btn--secondary btn--sm vorschlag-recovery" {...focusOnAction} onClick={recovery.onClick}>
          {recovery.label}
        </button>
      ) : null;
  } else if (canDecide && !changed && offers.approve) {
    actionSlot = (
      <button
        type="button"
        className="btn btn--secondary btn--sm vorschlag-approve"
        {...focusOnAction}
        disabled={busy}
        aria-describedby={consequence !== null ? consequenceId : undefined}
        onClick={() => onApprove(action.actionId, false)}
      >
        {t('agent.card.approve')}
      </button>
    );
  } else if (isDraftingActor) {
    actionSlot = <span className="vorschlag-line-hint">{t('agent.card.selfHint')}</span>;
  } else if (!canDecide) {
    actionSlot = (
      <Link className="link-inline vorschlag-line-hint" to="/members">
        {t('agent.card.needs')}
      </Link>
    );
  }

  const strong = level?.strongDefault === true || capability === 'vat-file' || capability === 'plugin-install';

  // Pendenzen: a batch refused this line, or it can no longer be approved: one line, in words. In the
  // compact row it is a slot of the row, read after the title and BEFORE the one way on, so a phone (and a
  // screen reader) meets the reason before the button.
  const statusLine =
    status?.tone === 'error' ? (
      <Status kind="warn" label={status.text} className="vorschlag-line-status" />
    ) : compact && changed && staleText !== undefined ? (
      <Status kind="warn" label={staleText} className="vorschlag-line-status" />
    ) : null;
  const statusInRow = compact && statusLine !== null;

  return (
    <article className="vorschlag-line" data-action-id={action.actionId} data-changed={changed ? 'true' : undefined}>
      <div className={statusInRow ? 'vorschlag-line-row vorschlag-line-row--status' : 'vorschlag-line-row'}>
        <span className="vorschlag-line-lead">
          {mark ?? <AgentMarkGlyph className="vorschlag-line-mark" size={16} aria-hidden="true" />}
          {/* DESIGN.md C3: the agent is named in words, never by the mark alone; on screen the ◇ says it. */}
          {!showOrigin && <span className="visually-hidden">{t('agent.line.origin')}</span>}
        </span>
        <div className="vorschlag-line-text">
          {compact ? (
            // Pendenzen: the title is words; Details open from the ⋯ (N4 M4).
            <span className="vorschlag-line-title vorschlag-line-title--text">{title}</span>
          ) : (
            <button
              type="button"
              ref={titleRef}
              className="vorschlag-line-title"
              aria-expanded={showDetails}
              aria-controls={showDetails ? detailsId : undefined}
              aria-current={titleCurrent ? 'true' : undefined}
              tabIndex={titleTabIndex}
              onFocus={onTitleFocus}
              onClick={() => setShowDetails((v) => !v)}
            >
              {title}
            </button>
          )}
          {meta !== undefined ? (
            <span className="vorschlag-line-meta vorschlag-line-meta--hub">{meta}</span>
          ) : (showOrigin || thing !== null || figure !== null || (bankLine !== null && !bankLineInMenu) || metaTail !== undefined) && (
            <span className="vorschlag-line-meta" data-figure={figure !== null ? 'true' : undefined}>
              {/* The essentials lead (total first): the line cuts from the end, so what the person must
                  see before Genehmigen is never the part that is cut. The verb and the origin are "soft":
                  a narrow line drops them whole, separators included. */}
              {figure !== null && <Essentials text={figure} />}
              {figure !== null && (showOrigin || thing !== null) && <span className="vorschlag-line-soft" aria-hidden="true">{SEP}</span>}
              {thing !== null && <span className="vorschlag-line-verb vorschlag-line-soft">{verb}</span>}
              {thing !== null && showOrigin && <span className="vorschlag-line-soft" aria-hidden="true">{SEP}</span>}
              {showOrigin && <span className="vorschlag-line-origin vorschlag-line-soft">{t('agent.line.origin')}</span>}
              {bankLine !== null && !bankLineInMenu && (
                <>
                  {(showOrigin || thing !== null || figure !== null) && <span aria-hidden="true">{SEP}</span>}
                  <Link className="link-inline" to={`/bank?line=${encodeURIComponent(bankLine)}`}>
                    {t('agent.line.toBankLine')}
                  </Link>
                </>
              )}
              {metaTail !== undefined && (
                <>
                  {(showOrigin || thing !== null || figure !== null) && <span aria-hidden="true">{SEP}</span>}
                  <span className="vorschlag-line-date">{metaTail}</span>
                </>
              )}
            </span>
          )}
        </div>
        {statusInRow && statusLine}
        {(consequence !== null || (compact && changed)) && (
          <span className="consequence-tip vorschlag-line-tip">
            {/* Compact (Pendenzen): the explanation of a changed Vorschlag joins the consequence here. */}
            <Tooltip content={compact && changed ? [t('agent.card.changed'), consequence].filter((s) => s !== null).join(' ') : consequence}>
              <button type="button" className="btn btn--ghost btn--icon btn--sm consequence-tip-trigger" aria-label={t('agent.line.consequence')}>
                <InfoGlyph size={16} />
              </button>
            </Tooltip>
            {consequence !== null && (
              <span id={consequenceId} className="vorschlag-consequence" hidden>
                {consequence}
              </span>
            )}
          </span>
        )}
        <div className="vorschlag-line-actions">{actionSlot}</div>
        <OverflowMenu quiet className="vorschlag-line-more" label={t('agent.line.more', { title })} items={menu} />
      </div>

      {/* /agent: the record changed since the proposal, said in full (critic N4 L4). */}
      {!compact && changed && <Status kind="warn" label={t('agent.card.changed')} className="vorschlag-line-changed" />}
      {/* Outside Pendenzen a refused line says so under the row. */}
      {!statusInRow && statusLine}

      {showDetails && (
        <dl id={detailsId} className="vorschlag-readback" aria-label={t('agent.line.detailsOf', { title })}>
          {details().map((row) => (
            <div className="vorschlag-readback-row" key={row.key}>
              <dt>{row.label}</dt>
              {/* One type size for money and words (polish 11); the figures stay tabular by the row's CSS. */}
              <dd title={row.title}>
                {row.value}
                {row.link !== undefined && (
                  <>
                    {SEP}
                    <Link className="link-inline" to={row.link.to}>
                      {row.link.label}
                    </Link>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {confirming === 'reject' && (
        <div className="vorschlag-confirm" role="group" aria-label={t('agent.card.reject')}>
          <p>{t('agent.card.rejectConfirm')}</p>
          <label className="vorschlag-reason" htmlFor={reasonId}>
            <span className="vorschlag-reason-label">{t('agent.card.rejectReasonLabel')}</span>
          </label>
          <textarea
            id={reasonId}
            className="field"
            rows={2}
            maxLength={500}
            value={rejectReason}
            disabled={busy}
            placeholder={t('agent.card.rejectReasonHint')}
            onChange={(event) => setRejectReason(event.target.value)}
          />
          <div className="vorschlag-confirm-actions">
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={busy}
              onClick={() => {
                setConfirming(null);
                const reason = rejectReason.trim();
                onReject(action.actionId, reason.length > 0 ? reason : undefined);
              }}
            >
              {t('agent.card.rejectYes')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirming(null)}>
              {t('agent.card.rejectNo')}
            </button>
          </div>
        </div>
      )}

      {confirming === 'grant' && (
        <div className="vorschlag-confirm" role="group" aria-label={t('agent.card.approveAllow')}>
          <p>{t('agent.line.grantConfirm', { capability: capability !== '' ? t(`agent.capability.${capability}`) : title })}</p>
          {strong && <p className="vorschlag-line-hint">{t('agent.trust.strongReason')}</p>}
          <div className="vorschlag-confirm-actions">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={busy}
              onClick={() => {
                setConfirming(null);
                onApprove(action.actionId, true);
              }}
            >
              {t('agent.line.grantYes')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirming(null)}>
              {t('agent.line.grantNo')}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
