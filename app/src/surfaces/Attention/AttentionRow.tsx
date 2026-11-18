/**
 * THE ONE ROW of Pendenzen (D178, 21.10.2026; the owner: "way too much text and different fonts and
 * layers"). Every item that is not a Vorschlag renders here, and the Vorschlag line (`VorschlagLine`,
 * compact) has the same five slots on the same grid, so the page reads as one list:
 *
 *   (lead) · title and its meta on ONE line (wraps on a phone) · ONE action button · ⋯ · chevron
 *
 *  - The LEAD column holds the kind's glyph (D201: one list, no section head says the kind any more), and
 *    on a Vorschlag the batch box before it.
 *  - The TITLE is the decision, in the owning catalogue's words, and it is plain words, never a button
 *    (N4 M4): the row's one text button is the way in (D152 rule 3), and the ⋯ carries "Öffnen" when that
 *    button acts rather than opens. A statement gap is named short ("Auszug 2 fehlt", its Bankkonto and
 *    "seit" in the meta) and its sentence sits behind the (i).
 *  - The META line carries values only, in one order: the amount (ink, tabular, an outgoing sign in the
 *    danger ink), the facts, and the date or "fällig"/"überfällig" with its date LAST. 13/18 against
 *    the title's 14/20.
 *  - The CHEVRON (D201 pick A) opens everything explanatory IN PLACE under the line (D152 rule 4): why the
 *    item waits, the suggested invoice, the consequence sentence of the write, and an explaining subtitle;
 *    the action points `aria-describedby` at the same consequence.
 *  - ONE action as a real button: the engine's primary when the person may use it, else the link into the
 *    owning surface. Every row action is the quiet secondary, a Mahnlauf's issue included: the page's one
 *    accent is the batch commit (DESIGN.md accent discipline, the orchestrator's N4 ruling). Every other
 *    exit the ENGINE declared sits in the ⋯ (D207 removed the hub's own "Aufgabe erstellen" and "Referenz
 *    kopieren"; a row with no other exit draws no ⋯); a reason-field exit (Ablehnen, Lücke bestätigen)
 *    confirms in place.
 *
 * Nothing here invents a verb, a label or a key: each arrives on the item (`decisionOptions`), and an
 * option whose clearing capability the person lacks is hidden, never shown and then refused.
 */
import { useId, useState, type ReactNode } from 'react';

import { useI18n, formatDate } from '../../i18n';
import { ChevronRightGlyph } from '../../components/icons';
import { useCapabilities } from '../../lib/capabilities';
import { OverflowMenu, type OverflowMenuItem } from '../../components/OverflowMenu';
import { formatItemParams, itemSubtitle, itemTitle, queueName } from './itemText';
import { Amount } from './Amount';
import { pickAction, reasonSentence, rowConsequence, visibleOptions, type DecisionOption } from './RowDecision';
import { REMAINDER_KIND, type Item } from './model';
import { Field } from '../../components/Field';
import { useAskReason } from '../../lib/useAskReason';

/** The meta line's separator. Non-breaking spaces: the meta line is a flex row, which trims plain ones. */
const SEP = ' · ';

/**
 * Queues whose subtitle EXPLAINS (a sentence about money chaining or the next step with the bank, or who
 * owns a checklist step) rather than naming facts: it moves behind the (i), and the meta line keeps values.
 */
const EXPLAINING_SUBTITLE: ReadonlySet<string> = new Set(['bank_statement_gap', 'bank_fetch_failed', 'bank_activation', 'bank_keys_review', 'checklist_items_due']);

/**
 * A statement gap, short (the fresh-eyes judge, N4 M5 M6): the title names the statement ("Auszug 2 fehlt",
 * "Auszug 1/2026 doppelt"), the meta its Bankkonto and since when (or "2 Salden"). The owning catalogue's
 * long sentence stays the Übersicht's; here it is the (i)'s, as the subtitle already is.
 */
function gapWords(t: (key: string, params?: Record<string, string | number>) => string, item: Item): { title: string; meta: string[] } | null {
  if (item.queueId !== 'bank_statement_gap') return null;
  const p = formatItemParams(item.titleParams);
  const variant = item.titleKey.split('.').pop() ?? '';
  const title =
    variant === 'titleConflicting'
      ? t('attention.gap.conflicting', p)
      : variant === 'titleIncomplete'
        ? t('attention.gap.incomplete', p)
        : variant.startsWith('titleUnknown')
          ? t(variant === 'titleUnknownDay' ? 'attention.gap.unknownOne' : 'attention.gap.unknownMany', p)
          : variant.startsWith('titleOne')
            ? t('attention.gap.one', p)
            : t('attention.gap.many', p);
  const meta: string[] = [];
  if (typeof p.bank === 'string' && p.bank !== '') meta.push(p.bank);
  if (variant === 'titleConflicting') meta.push(t('attention.gap.twoBalances'));
  else if (variant === 'titleIncomplete') meta.push(t('attention.gap.partsMissing'));
  else if (typeof p.fromDate === 'string' && p.fromDate !== '') meta.push(t('attention.gap.since', { date: p.fromDate }));
  return { title, meta };
}

/** Do two deep links open the same place? */
function samePlace(a: { route: string; params: Record<string, string> } | undefined, b: { route: string; params: Record<string, string> }): boolean {
  if (a === undefined || a.route !== b.route) return false;
  const keys = new Set([...Object.keys(a.params), ...Object.keys(b.params)]);
  return [...keys].every((k) => a.params[k] === b.params[k]);
}

export interface AttentionRowProps {
  item: Item;
  /** Kept for callers; D186/D201 show no "neu" badge, so it draws nothing. */
  tagged?: boolean;
  /** This row's act is in flight. */
  busy: boolean;
  /** Any act is in flight: every action waits (one at a time, a double press cannot fire twice). */
  locked: boolean;
  /** The provider label key of a collapsed queue, the fallback for its name. */
  collapsedLabelKey?: string;
  onOpen: (link: { route: string; params: Record<string, string> }) => void;
  onAct: (option: DecisionOption, reason?: string) => void;
  /** The roving focus over the whole list lands on the row's way in (the title, or its one button). */
  focusRef?: (el: HTMLButtonElement | null) => void;
  focusTabIndex?: number;
  focusCurrent?: boolean;
  onFocusIn?: () => void;
  /** D201: the row's lead (the kind's glyph); empty when absent. */
  lead?: ReactNode;
  /** D208 point 7: the row's way into its owning place is the section heading's glyph; no link on the row. */
  hideLink?: boolean;
}

export function AttentionRow({
  item,
  busy,
  locked,
  collapsedLabelKey,
  onOpen,
  onAct,
  focusRef,
  focusTabIndex,
  focusCurrent,
  onFocusIn,
  lead,
  hideLink = false,
}: AttentionRowProps) {
  const { t, locale } = useI18n();
  const { can, whoami } = useCapabilities();
  const consequenceId = useId();
  const reasonFieldId = useId();
  const detailId = useId();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<DecisionOption | null>(null);
  const [reason, setReason] = useState('');

  const remainder = item.entityKind === REMAINDER_KIND;
  const checklist = item.queueId === 'checklist_items_due';
  const gap = remainder ? null : gapWords(t, item);
  const title = gap !== null
    ? gap.title
    : remainder
    ? t('attention.remainder.title', { count: item.count, queue: queueName(t, locale, item.queueId) })
    : checklist
      ? t('attention.row.checklistTitle', {
          template: String(item.subtitleParams?.template ?? ''),
          period: String(item.titleParams.period ?? ''),
          title: String(item.titleParams.title ?? ''),
        })
      : itemTitle(t, item);
  const visible = visibleOptions(item.decisionOptions ?? [], can).filter((o) => !hideLink || o.role !== 'link');
  const action = pickAction(visible);
  const rest = visible.filter((o) => o !== action);
  const consequence = rowConsequence(item, locale);
  const why = reasonSentence(t, item, whoami?.actor ?? null);
  const hint = visible.find((o) => o.hintKey !== undefined)?.hintKey;
  const subtitle = remainder ? null : itemSubtitle(t, item);
  const explains = EXPLAINING_SUBTITLE.has(item.queueId);
  const info = [
    explains ? subtitle : null,
    why,
    item.suggestedInvoiceNumber ? t('attention.act.suggested', { number: item.suggestedInvoiceNumber }) : null,
    consequence,
    hint !== undefined ? t(hint) : null,
  ].filter((s): s is string => s !== null && s !== '');

  // One order everywhere: amount, facts, "neu", then the date (or fällig/überfällig with its date) last.
  const meta: ReactNode[] = [];
  if (item.amountMinor !== undefined && item.currency !== undefined) {
    meta.push(<Amount key="amount" minor={item.amountMinor} currency={item.currency} />);
  }
  if (gap !== null) gap.meta.forEach((fact, i) => meta.push(<span key={`gap-${i}`} className={i === 0 ? 'att-row-sub' : undefined}>{fact}</span>));
  if (!explains && subtitle !== null && subtitle !== '') meta.push(<span key="sub" className="att-row-sub">{subtitle}</span>);
  if (item.collapsedWithQueueId !== undefined) {
    meta.push(
      <span key="collapsed">{t('attention.collapsedWith', { queue: queueName(t, locale, item.collapsedWithQueueId, collapsedLabelKey) })}</span>,
    );
  }
  // A gap says since when in its facts; "fällig" on it would be a second, vaguer date (N4 M5 M6).
  if (item.urgency !== 'open' && gap === null) {
    const date = item.dueAt !== undefined && /^\d{4}-\d{2}-\d{2}/.test(item.dueAt) ? formatDate(item.dueAt.slice(0, 10)) : null;
    const word =
      item.urgency === 'overdue'
        ? date === null ? t('attention.urgency.overdue') : t('attention.row.overdueSince', { date })
        : date === null ? t('attention.urgency.due') : t('attention.row.dueOn', { date });
    meta.push(
      <span key="urgency" className={`att-row-urgency att-row-urgency--${item.urgency}`}>
        {word}
      </span>,
    );
  }

  const run = (option: DecisionOption) => {
    if (option.role === 'link' || option.verb === null) {
      if (option.deepLink !== undefined) onOpen(option.deepLink);
      return;
    }
    if (option.reasonField) {
      setReason('');
      setConfirming(option);
      return;
    }
    onAct(option);
  };

  // The title is words, not a way in (N4 M4): when the row's one button acts rather than opens, and no
  // other exit already opens the owning place, the ⋯ carries "Öffnen".
  const opensOwner = (o: DecisionOption | null) => o !== null && o.role === 'link' && samePlace(o.deepLink, item.deepLink);
  // A row with no exit of its own still has one way in: "Öffnen" as its button (never a bare title).
  const fallbackOpen = action === null && !remainder && !hideLink && item.deepLink.route !== '';
  const needsOpen = !remainder && !hideLink && action !== null && !opensOwner(action) && !rest.some(opensOwner) && item.deepLink.route !== '';
  const menu: OverflowMenuItem[] = [
    ...(needsOpen ? [{ key: 'open-owner', label: t('attention.overflow.open'), onSelect: () => onOpen(item.deepLink) }] : []),
    ...rest.map((option) => ({
      key: option.id,
      label: t(option.labelKey),
      danger: option.role === 'danger',
      disabled: locked && option.role !== 'link',
      onSelect: () => run(option),
    })),
  ];

  const commit = (option: DecisionOption) => {
    setConfirming(null);
    // An empty note is no reason (the hub sends none, D204).
    onAct(option, reason.trim());
  };


  return (
    <div
      className="att-row"
      data-queue={item.queueId}
      data-row-count={item.count}
      data-urgency={item.urgency}
      aria-busy={busy ? 'true' : undefined}
    >
      <div className="att-row-line">
        <span className="att-lead" aria-hidden="true">
          {lead}
        </span>
        <div className="att-row-text">
          <span className="att-row-title att-row-title--text">{title}</span>
          {meta.length > 0 && (
            <span className="att-row-meta">
              {meta.flatMap((part, i) => (i === 0 ? [part] : [<span key={`sep-${i}`} aria-hidden="true">{SEP}</span>, part]))}
            </span>
          )}
        </div>
        {consequence !== null && (
          <span id={consequenceId} hidden>
            {consequence}
          </span>
        )}
        <div className="att-row-action">
          {action !== null && (
            <button
              type="button"
              ref={focusRef}
              tabIndex={focusTabIndex}
              aria-current={focusCurrent ? 'true' : undefined}
              onFocus={onFocusIn}
              className="btn btn--secondary btn--sm"
              data-option={action.id}
              disabled={locked && action.role !== 'link'}
              aria-describedby={consequence !== null && action.verb !== null ? consequenceId : undefined}
              onClick={() => run(action)}
            >
              {t(action.labelKey)}
            </button>
          )}
          {fallbackOpen && (
            <button
              type="button"
              ref={focusRef}
              tabIndex={focusTabIndex}
              aria-current={focusCurrent ? 'true' : undefined}
              onFocus={onFocusIn}
              className="btn btn--secondary btn--sm"
              onClick={() => onOpen(item.deepLink)}
            >
              {t('attention.overflow.open')}
            </button>
          )}
          {busy && <span className="att-row-busy">{t('attention.act.busy')}</span>}
        </div>
        <span className="att-row-more">{menu.length > 0 && <OverflowMenu quiet label={t('attention.overflow.label', { title })} items={menu} />}</span>
        <span className="att-disclose-cell">
          {info.length > 0 && (
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm att-disclose"
              aria-expanded={open}
              aria-controls={open ? detailId : undefined}
              onClick={() => setOpen((v) => !v)}
            >
              <ChevronRightGlyph size={16} />
              <span className="visually-hidden">{t('attention.row.details', { title })}</span>
            </button>
          )}
        </span>
      </div>
      {open && info.length > 0 && (
        <div id={detailId} className="att-row-detail motion-reveal--under">
          {info.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}
      {confirming !== null && (
        <div className="att-row-confirm" role="group" aria-label={t(confirming.labelKey)}>
          {/* D204: the confirm never waits for a reason; the note shows only when the workspace asks. */}
          <AskedReason>
            <Field label={t('attention.act.reasonLabel')}>
              <input
                id={reasonFieldId}
                className="field"
                type="text"
                value={reason}
                placeholder={t(confirming.reasonPlaceholderKey ?? 'attention.act.reasonPlaceholder')}
                disabled={locked}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commit(confirming);
                  } else if (e.key === 'Escape') {
                    setConfirming(null);
                  }
                }}
              />
            </Field>
          </AskedReason>
          <div className="form-actions att-row-confirm-actions">
            <button
              type="button"
              className={confirming.role === 'danger' ? 'btn btn--danger btn--sm' : 'btn btn--secondary btn--sm'}
              disabled={locked}
              onClick={() => commit(confirming)}
            >
              {t(confirming.confirmLabelKey ?? 'attention.act.rejectConfirm')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirming(null)}>
              {t('attention.act.rejectKeep')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * D204: the optional note of a confirm, mounted only while the confirm is open (so the reason setting is
 * read on that click, not by every row), and shown only when `audit.ask_reason` is `optional`.
 */
function AskedReason({ children }: { children: ReactNode }) {
  return useAskReason() ? <>{children}</> : null;
}
