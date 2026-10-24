/**
 * D178 point 5, APPROVING SEVERAL BANK VORSCHLÄGE: the batch controls on the section's head line (the
 * fresh-eyes judge, N4 M2: no separate "Vorschläge" row without an end) and the confirm of "Alle genehmigen". The batch never adds a verb: the page runs the existing `approve_drafted_action` once
 * per row, one after the other, so the human-only rule (D161), the stale pin (D162) and the self-approve
 * ban hold per item exactly as for a single approval. It reaches only the rows the ENGINE marks `batchable`
 * (a decision on a bank line, critic N4 M1). This module only draws the controls.
 *
 *  - `tick` (the default): a head box that ticks every batchable row ONLY when the person ticks it, and
 *    "Ausgewählte genehmigen (n)", disabled at 0. Nothing is ever ticked on arrival (D152 rule 5). The
 *    explicit ticks are the confirmation (DESIGN.md bans blanket confirmation); an (i) beside the commit
 *    says what approving does and what is selected (N4 H2).
 *  - `single`: no bar at all (each line keeps its own Genehmigen).
 *  - `all_with_confirm`: "Alle genehmigen (n)", which opens an alertdialog naming the count, the money per
 *    currency (in and out apart, never one absolute sum, never a guessed currency) and the consequence
 *    sentence of every drafted verb, before anything runs.
 *
 * "Alle" says what it covers (critic N4 L1): while the section holds more rows behind its cursor, the bar
 * says "angezeigte", because only the rows on screen can be ticked.
 *
 * THE PAGE'S ONE ACCENT (DESIGN.md accent discipline, the orchestrator's N4 ruling): the batch commit is
 * the single primary on Pendenzen. "Ausgewählte genehmigen (n)" wears the accent once a row is ticked (at 0
 * it is the quiet, disabled secondary, and the page has no accent at all); under `all_with_confirm` the
 * opener stays quiet and the accent sits on the commit inside the confirm. While another commit's confirm
 * (the Mahnlauf's) is open over the page, the batch commit goes quiet too. Both name what they commit for
 * the accent guard: the approval, and the posting verb it replays (`approve_drafted_action book_bank_line`).
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';

import { useI18n, formatMoney } from '../../i18n';
import { Modal } from '../../components/Modal';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { IconButton } from '../../components/IconButton';
import type { BatchMode } from './model';

/** The money of the batch per currency, in and out apart, and how many rows carry no amount. */
export interface BatchTotals {
  perCurrency: { currency: string; inMinor: number; outMinor: number }[];
  withoutAmount: number;
}

/** Sum signed amounts per currency, in and out apart; a row without both an amount and a currency counts apart. */
export function batchTotalsOf(rows: readonly { amountMinor?: number; currency?: string }[]): BatchTotals {
  const sums = new Map<string, { inMinor: number; outMinor: number }>();
  let withoutAmount = 0;
  for (const row of rows) {
    if (typeof row.amountMinor !== 'number' || typeof row.currency !== 'string' || row.currency === '') {
      withoutAmount += 1;
      continue;
    }
    const s = sums.get(row.currency) ?? { inMinor: 0, outMinor: 0 };
    if (row.amountMinor >= 0) s.inMinor += row.amountMinor;
    else s.outMinor += -row.amountMinor;
    sums.set(row.currency, s);
  }
  return { perCurrency: [...sums.entries()].map(([currency, s]) => ({ currency, ...s })), withoutAmount };
}

export interface BatchBarProps {
  mode: BatchMode;
  /** How many rows the bar acts on (the batchable bank Vorschläge on screen). */
  rowCount: number;
  selectedCount: number;
  running: boolean;
  /** More rows sit behind the section's cursor: "Alle" covers the shown ones only, and says so. */
  partial: boolean;
  onToggleAll: (checked: boolean) => void;
  onApproveSelected: () => void;
  onApproveAll: () => void;
  /** Another commit's confirm is open over the page: the batch commit goes quiet, so one accent shows. */
  quiet?: boolean;
  /**
   * A ticked row POSTS (the engine's `posts`, critic N4 R2-M2): only then is the commit a money write, wears
   * the accent and claims the booking. Ticking only rows that book nothing (a line set aside, a match to an
   * entry already in the books) leaves it the quiet secondary.
   */
  books?: boolean;
  /** The bar's own sub-head, "Vorschläge n" (B5: the section head keeps its glyph and count apart). */
  heading: ReactNode;
  /** The section glyph, kept in the lead column when the mode has no select-all box. */
  glyph: ReactNode;
  /**
   * What the batch commit does (N4 H2): the engine's consequence of the approved verbs (the row (i)'s own
   * source), then the selection's count and its signed money per currency. The (i) shows it and the commit
   * is described by it (D152): ticking rows is the confirmation, so there is no dialog in `tick`.
   */
  info: string;
}

export function BatchBar({ mode, rowCount, selectedCount, running, partial, onToggleAll, onApproveSelected, onApproveAll, quiet = false, books = false, heading, glyph, info }: BatchBarProps) {
  const { t } = useI18n();
  const infoId = useId();
  // The commit wears the accent once a row is ticked, unless a confirm over the page holds the one accent.
  const live = selectedCount > 0 && books && !quiet;
  const boxRef = useRef<HTMLInputElement | null>(null);
  const allTicked = rowCount > 0 && selectedCount === rowCount;
  const someTicked = selectedCount > 0 && selectedCount < rowCount;
  useEffect(() => {
    if (boxRef.current !== null) boxRef.current.indeterminate = someTicked;
  }, [someTicked]);
  if (mode === 'single') return null;
  return (
    <div className="att-batch" role="group" aria-label={t('attention.batch.label')}>
      <span className="att-lead">
        {mode === 'tick' ? (
          // K-14 (D137): the box keeps its 16px look; its hit area reaches 44px (CSS). It takes the section
          // glyph's place, as a row's box takes its lead (the design judge's rule).
          <label className="att-check">
            <input
              ref={boxRef}
              type="checkbox"
              className="att-batch-box"
              aria-label={t(partial ? 'attention.batch.selectShown' : 'attention.batch.selectAll')}
              checked={allTicked}
              disabled={running || rowCount === 0}
              onChange={(e) => onToggleAll(e.target.checked)}
            />
          </label>
        ) : (
          glyph
        )}
      </span>
      {heading}
      <span className="att-info att-batch-info">
        <IconButton icon="info" small context={info} />
      </span>
      <span id={infoId} hidden>
        {info}
      </span>
      {mode === 'tick' ? (
        <button
          type="button"
          className={live ? 'btn btn--accent btn--sm att-batch-approve' : 'btn btn--secondary btn--sm att-batch-approve'}
          data-money-commit={live ? 'approve_drafted_action book_bank_line' : undefined}
          data-batch-approve=""
          aria-describedby={infoId}
          disabled={running || selectedCount === 0}
          onClick={onApproveSelected}
        >
          {t('attention.batch.approveSelected', { count: selectedCount })}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn--secondary btn--sm att-batch-approve"
          data-batch-approve=""
          aria-describedby={infoId}
          disabled={running || rowCount === 0}
          onClick={onApproveAll}
        >
          {t(partial ? 'attention.batch.approveShown' : 'attention.batch.approveAll', { count: rowCount })}
        </button>
      )}
    </div>
  );
}

export interface BatchConfirmProps {
  open: boolean;
  /** A row of the batch POSTS (critic N4 R2-M2): only then does the commit wear the money accent. */
  books: boolean;
  count: number;
  totals: BatchTotals;
  /** The drafted verbs in the batch, each once: their consequence sentences are read before approving. */
  verbs: string[];
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * The consequential-confirm role travels to the shared Modal as a prop value, never as a literal
 * attribute on the component, so the modal-role guard reads a bare `<Modal>` (the EntryDrawer precedent).
 */
const ALERT_DIALOG = 'alertdialog' as const;

export function BatchConfirm({ open, books, count, totals, verbs, onConfirm, onClose }: BatchConfirmProps) {
  const { t } = useI18n();
  const describedBy = useId();
  // Per currency, money in and money out apart: never one absolute sum, never a currency guessed.
  const flows = totals.perCurrency.flatMap((c) => [
    ...(c.inMinor > 0 ? [t('attention.batch.confirm.in', { amount: formatMoney(c.inMinor, c.currency) })] : []),
    ...(c.outMinor > 0 ? [t('attention.batch.confirm.out', { amount: formatMoney(c.outMinor, c.currency) })] : []),
  ]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      role={ALERT_DIALOG}
      title={t('attention.batch.confirm.title', { count })}
      closeLabel={t('attention.batch.confirm.close')}
      describedById={describedBy}
      footer={
        <button
          type="button"
          className={books ? 'btn btn--accent' : 'btn btn--primary'}
          data-money-commit={books ? 'approve_drafted_action book_bank_line' : undefined}
          data-batch-confirm=""
          onClick={onConfirm}
        >
          {t('attention.batch.confirm.yes', { count })}
        </button>
      }
    >
      <div id={describedBy} className="att-batch-confirm">
        {flows.length > 0 && <p className="att-batch-confirm-total">{flows.join(' · ')}</p>}
        {totals.withoutAmount > 0 && <p>{t('attention.batch.confirm.withoutAmount', { count: totals.withoutAmount })}</p>}
        <p>{t('attention.batch.confirm.each')}</p>
        {verbs.map((verb) => (
          <ConsequenceLine key={verb} verb={verb} />
        ))}
      </div>
    </Modal>
  );
}
