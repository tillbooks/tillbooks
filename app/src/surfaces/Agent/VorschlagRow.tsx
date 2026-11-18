/**
 * D197 point 4 (owner, 12.11.2026): ONE row for a Vorschlag, used by the Vorschläge list on /agent and by
 * the Vorschlag rows of Pendenzen, so the same proposal looks the same on both screens. And ONE selection
 * bar for the ticked rows of either.
 *
 * The row, in the owner's order: the lead (a tick box, only where the row is batchable; empty otherwise),
 * the subject (the counterparty or what it is about) with the act in words, the date, the certainty (three
 * dots and a word, the engine's evidence), a paperclip when a Beleg rides, and the SIGNED amount, right
 * aligned in tabular figures, the minus alone in `--t-danger` (DESIGN.md Money). One fixed height from the
 * density tokens, so the list never jumps. Pendenzen hands in its trailing actions; the list hands in
 * `onSelect` and the row's main area becomes the one button that opens the detail.
 */
import type { KeyboardEvent, ReactNode, Ref } from 'react';

import { formatMoney, useT } from '../../i18n';
import { IconButton } from '../../components/IconButton';
import { Status } from '../../components/Status';
import { VOCABULARY } from '../../components/icons';
import type { BatchTotals } from '../Attention/Batch';
import type { Certainty, RowFacts } from './vorschlagView';
import './VorschlagRow.css';

const AttachGlyph = VOCABULARY.attach.glyph;

/** A signed amount: the figure in ink, the minus alone in `--t-danger`. */
export function SignedAmount({ minor, currency, className }: { minor: number; currency: string; className?: string }) {
  const text = formatMoney(minor, currency);
  const at = minor < 0 ? text.indexOf('-') : -1;
  const cls = ['vrow-amount', 't-money', className ?? ''].filter(Boolean).join(' ');
  if (at < 0) return <span className={cls}>{text}</span>;
  return (
    <span className={cls}>
      {text.slice(0, at)}
      <span className="vrow-sign">-</span>
      {text.slice(at + 1)}
    </span>
  );
}

/** How many of the three dots a certainty fills. */
function dotsOf(c: Certainty): number {
  return c === 'sure' ? 3 : c === 'learned' ? 2 : c === 'check' ? 1 : 0;
}

/** The certainty: three dots and its word, never colour alone; only `check` colours its dot. */
export function CertaintyMark({ certainty, className }: { certainty: Certainty; className?: string }) {
  const t = useT();
  const filled = dotsOf(certainty);
  return (
    <span className={['vrow-cert', className ?? ''].filter(Boolean).join(' ')} data-certainty={certainty}>
      <span className="vrow-cert-dots" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <i key={i} className={i < filled ? 'vrow-cert-dot vrow-cert-dot--on' : 'vrow-cert-dot'} />
        ))}
      </span>
      <span className="vrow-cert-word">{t(`agent.vq.certainty.${certainty}`)}</span>
    </span>
  );
}

export interface VorschlagRowProps {
  facts: RowFacts;
  /** The lead slot: the tick box on a batchable row, nothing otherwise. */
  lead?: ReactNode;
  /** The list: the row's main area is one button that selects it. */
  onSelect?: () => void;
  selected?: boolean;
  mainRef?: Ref<HTMLButtonElement>;
  mainTabIndex?: number;
  onMainKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onMainFocus?: () => void;
  /** Pendenzen: the row's trailing actions (Freigeben, Ablehnen, (i), Mehr). */
  actions?: ReactNode;
  /** A one-line state said under the subject (a batch refusal, a stale row). */
  status?: ReactNode;
  /** The row's history state on /agent (Genehmigt, Abgelehnt, Veraltet), said as a glyph and a word. */
  badge?: ReactNode;
  /** The id of the act, for tests and the browser flows. */
  actionId: string;
  stale?: boolean;
  /** The stale wording of the screen ("Seit dem Vorschlag geändert" in Pendenzen), else "Geändert". */
  staleLabel?: string;
  /**
   * D207: the row opens its details in place (Pendenzen, the Übersicht card): the main button says whether
   * they are open and which element they are. Absent on the /agent list, where the main selects a detail.
   */
  expanded?: boolean;
  controls?: string;
}

export function VorschlagRow({
  facts,
  lead,
  onSelect,
  selected = false,
  mainRef,
  mainTabIndex,
  onMainKeyDown,
  onMainFocus,
  actions,
  status,
  badge,
  actionId,
  stale = false,
  staleLabel,
  expanded,
  controls,
}: VorschlagRowProps) {
  const t = useT();
  const cells = (
    <>
      <span className="vrow-subject">
        <span className="vrow-subject-text">{facts.subject}</span>
        {facts.kind !== facts.subject && (
          <span className="vrow-kind" data-figure="key">
            {facts.kind}
          </span>
        )}
        {status}
      </span>
      {badge !== undefined && <span className="vrow-badge">{badge}</span>}
      {/* The record's business date; a proposal date (no business date) reads dim (D197 judge, point 10). */}
      <span className={facts.dateIsProposal === true ? 'vrow-date vrow-date--proposal t-num' : 'vrow-date t-num'}>{facts.date ?? ''}</span>
      <span className="vrow-cert-cell">
        {facts.stale ? <Status kind="warn" label={staleLabel ?? t('agent.vq.staleRow')} className="vrow-stale" /> : facts.certainty !== null ? <CertaintyMark certainty={facts.certainty} /> : null}
      </span>
      <span className="vrow-clip">
        {facts.hasBeleg ? (
          <>
            <AttachGlyph size={16} />
            <span className="visually-hidden">{t('agent.vq.withBeleg')}</span>
          </>
        ) : null}
      </span>
      <span className="vrow-amount-cell">{facts.amountMinor !== null ? <SignedAmount minor={facts.amountMinor} currency={facts.currency} /> : null}</span>
    </>
  );
  return (
    <div
      className={['vrow', selected ? 'vrow--selected' : '', expanded === true ? 'vrow--open' : '', facts.ibanChange === true ? 'vrow--iban' : '', onSelect !== undefined ? 'vrow--select' : '', actions !== undefined ? 'vrow--actions' : ''].filter(Boolean).join(' ')}
      data-action-id={actionId}
      data-stale={stale ? 'true' : undefined}
    >
      {/* The row is the size container; this grid inside it is what a narrow row rearranges. */}
      <div className="vrow-grid">
        <span className="vrow-lead">
          {lead}
          {/* DESIGN.md C3: the agent is named in words, never by a mark alone. */}
          <span className="visually-hidden">{t('agent.line.origin')}</span>
        </span>
        {onSelect !== undefined ? (
          <button
            type="button"
            className="vrow-main"
            ref={mainRef}
            tabIndex={mainTabIndex}
            aria-current={selected ? 'true' : undefined}
            {...(expanded !== undefined ? { 'aria-expanded': expanded, ...(expanded && controls !== undefined ? { 'aria-controls': controls } : {}) } : {})}
            onClick={onSelect}
            onKeyDown={onMainKeyDown}
            onFocus={onMainFocus}
          >
            {cells}
          </button>
        ) : (
          <div className="vrow-main">{cells}</div>
        )}
        {actions !== undefined && <span className="vrow-actions">{actions}</span>}
      </div>
    </div>
  );
}

export interface VorschlagSelectionBarProps {
  /** How many rows are ticked. */
  count: number;
  /** The ticked rows' money per currency, in and out apart (`batchTotalsOf`). */
  totals: BatchTotals;
  /** The worded batch commit (a money commit keeps its word, DESIGN.md "Icon vocabulary"). */
  approveLabel?: string;
  onApprove?: () => void;
  /**
   * The screen's own commit in place of the quiet one. Pendenzen hands in its batch commit, the one button
   * the accent guard lets claim the booking an approval replays (`test/style/accent-money-commit-only`);
   * a list elsewhere spends no accent (D167), so the default commit here is the secondary.
   */
  commit?: ReactNode;
  /** Ablehnen for every ticked row, when the screen offers it (the one-step `RejectControl`). */
  reject?: ReactNode;
  /** Clear the ticks, when the screen offers it. */
  onClear?: () => void;
  running?: boolean;
  /** Show "n ausgewählt" (the list); Pendenzen's head line names its own count. */
  showCount?: boolean;
  /** The default commit is the screen's one primary (the list), not the quiet secondary. */
  primary?: boolean;
}

/**
 * The selection bar: the count, the signed sum per currency, Freigeben for all (in words), Ablehnen for all
 * and clear. Nothing in it is ever pre-ticked; the caller mounts it while rows are ticked (the list) or
 * holds it at 0 and disabled (Pendenzen's head line).
 */
export function VorschlagSelectionBar({ count, totals, approveLabel, onApprove, commit, reject, onClear, running = false, showCount = true, primary = false }: VorschlagSelectionBarProps) {
  const t = useT();
  const sums = totals.perCurrency.map((c) => ({ currency: c.currency, net: c.inMinor - c.outMinor }));
  return (
    <span className="vsel">
      {showCount && (
        <span className="vsel-count" aria-live="polite">
          {t('agent.vq.selected', { count })}
        </span>
      )}
      {count > 0 &&
        sums.map((s) => (
          <span key={s.currency} className="vsel-sum" data-sum-currency={s.currency}>
            <SignedAmount minor={s.net} currency={s.currency} />
          </span>
        ))}
      {commit ?? (
        <button type="button" className={primary ? 'btn btn--primary btn--sm vsel-approve' : 'btn btn--secondary btn--sm vsel-approve'} disabled={running || count === 0} onClick={onApprove}>
          {approveLabel}
        </button>
      )}
      {reject}
      {onClear !== undefined && <IconButton icon="close" small name={t('agent.vq.clearSelection')} context={t('agent.vq.selected', { count })} onClick={onClear} disabled={running} />}
    </span>
  );
}
