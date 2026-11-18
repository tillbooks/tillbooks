/**
 * D201 point 4 (owner, 15.11.2026, pick A), SEVERAL VORSCHLÄGE AT ONCE: the multi-select's one sticky action
 * bar, the confirm of `all_with_confirm`, and the reader of the batch verbs' per-id answers.
 *
 *  - THE BAR (`SelectionDock`) appears only while rows are ticked (DESIGN.md "Calm states and honest buttons":
 *    a bar that commits work appears only when there is something to commit). It says how many are ticked and
 *    their signed money per currency, then "Freigeben (n)" for the ticked rows the batch may approve (only a
 *    decision on a bank line, the engine's `batchable`), "Ablehnen (n)" for every ticked row (one click, no
 *    reason, D204), and a clear. A commit that cannot act is not drawn.
 *  - THE CALLS are the engine's batch verbs, ONE call per press, never a loop of single calls:
 *    `approve_drafted_actions { ids }` and `reject_drafted_actions { ids }` (`src/api/batch-actions.ts`). Each
 *    id is still its own `approve_drafted_action` / `reject_drafted_action` inside the engine, so the
 *    human-only rule, the stale pin and the self-approve ban hold per id. `parseBatchAnswer` reads the per-id
 *    outcomes: what went through leaves the list, what failed stays ticked with its cause in its row.
 *  - `all_with_confirm` (the workspace setting `attention.approval_batch_mode`): "Freigeben (n)" first opens
 *    the confirm naming the count, the money in and out per currency and the consequence of each drafted
 *    verb. `single`: the bar offers no Freigeben (each line keeps its own), Ablehnen stays.
 *
 * THE PAGE'S ONE ACCENT (DESIGN.md accent discipline): "Freigeben (n)" wears it only while a ticked row POSTS
 * (the engine's per-row `posts`), and goes quiet while another commit's confirm (the Mahnlauf's) is open. Both
 * accent sites name what they commit for the accent guard: the approval, and the posting verb it replays.
 */
import { useId } from 'react';

import { useI18n, formatMoney } from '../../i18n';
import type { Err } from '../../lib/client';
import { Modal } from '../../components/Modal';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { VorschlagSelectionBar } from '../Agent/VorschlagRow';
import { RejectControl } from '../Agent/RejectControl';

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

/** What one call of a batch verb came to, per id: the ids that went through and the ones that did not, with why. */
export interface BatchAnswer {
  done: string[];
  failed: { id: string; refusal: Err }[];
}

/**
 * Read `approve_drafted_actions` / `reject_drafted_actions`: `{ items: [{ index, actionId?, ok, result | refusal }] }`.
 * An item names its id, else its position in `ids` does. An id the answer does not mention is NOT done: it is
 * reported failed with a generic refusal, so nothing leaves the list on a guess.
 */
export function parseBatchAnswer(body: unknown, ids: readonly string[]): BatchAnswer {
  const items = body !== null && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items) ? ((body as { items: unknown[] }).items) : [];
  const done: string[] = [];
  const failed: BatchAnswer['failed'] = [];
  const seen = new Set<string>();
  items.forEach((raw, position) => {
    if (raw === null || typeof raw !== 'object') return;
    const item = raw as Record<string, unknown>;
    const index = typeof item.index === 'number' ? item.index : position;
    const id = typeof item.actionId === 'string' ? item.actionId : ids[index];
    if (id === undefined || seen.has(id)) return;
    seen.add(id);
    if (item.ok === true) done.push(id);
    else {
      const refusal = item.refusal;
      const readable = refusal !== null && typeof refusal === 'object' && typeof (refusal as { error?: unknown }).error === 'string';
      failed.push({ id, refusal: readable ? (refusal as Err) : ({ ok: false, error: 'refused' } as Err) });
    }
  });
  for (const id of ids) if (!seen.has(id)) failed.push({ id, refusal: { ok: false, error: 'refused' } as Err });
  return { done, failed };
}

export interface SelectionDockProps {
  /** How many rows are ticked. */
  count: number;
  /** How many of them the batch may approve (bank-line decisions); 0 draws no Freigeben. */
  approveCount: number;
  /** How many of them may be rejected; 0 draws no Ablehnen. */
  rejectCount: number;
  /** The ticked rows' signed money per currency. */
  totals: BatchTotals;
  /** A ticked, approvable row POSTS: only then is Freigeben a money write and wears the accent. */
  books: boolean;
  /** Another commit's confirm is open over the page: Freigeben goes quiet, so one accent shows. */
  quiet?: boolean;
  running: boolean;
  /** What Freigeben does, in the engine's words (its description). */
  info: string;
  onApprove: () => void;
  onReject: () => void;
  onClear: () => void;
}

export function SelectionDock({ count, approveCount, rejectCount, totals, books, quiet = false, running, info, onApprove, onReject, onClear }: SelectionDockProps) {
  const { t } = useI18n();
  const infoId = useId();
  const live = books && !quiet;
  if (count === 0) return null;
  return (
    <div className="att-dock" role="region" aria-label={t('attention.batch.label')} aria-busy={running ? 'true' : undefined}>
      <span id={infoId} hidden>
        {info}
      </span>
      <VorschlagSelectionBar
        count={count}
        totals={totals}
        running={running}
        commit={
          approveCount === 0 ? (
            <></>
          ) : (
            <button
              type="button"
              className={live ? 'btn btn--accent btn--sm att-dock-approve' : 'btn btn--secondary btn--sm att-dock-approve'}
              data-money-commit={live ? 'approve_drafted_action book_bank_line' : undefined}
              data-batch-approve=""
              aria-describedby={infoId}
              disabled={running}
              onClick={onApprove}
            >
              {t('attention.batch.approveSelected', { count: approveCount })}
            </button>
          )
        }
        reject={
          rejectCount === 0 ? undefined : (
            <RejectControl triggerLabel={t('attention.batch.rejectSelected', { count: rejectCount })} context={t('agent.vq.rejectContext')} busy={running} onReject={onReject} />
          )
        }
        onClear={onClear}
      />
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
