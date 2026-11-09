/**
 * "Mahnlauf ausstellen" from a Pendenzen row: the governed confirm (DESIGN.md D118 C4; the orchestrator's
 * N4 ruling). Issuing a run books its Mahngebühren, a write in the top tiers, so nothing leaves the
 * surface before a person has read what it does and said yes to it here:
 *
 *  - the ONE consequence sentence, the engine's own for `issue_dunning_run` (`ConsequenceLine`, the same
 *    words the Vorschlag card, the MCP description and `/dunning` carry; never a sentence written here);
 *  - the run's own facts, read from `get_dunning_run` when the confirm opens: how many Mahnungen, how many
 *    invoices, and the fees it books per currency (or that it books none);
 *  - one commit, which alone sends the write. It wears the money tint exactly when the issue BOOKS a fee
 *    (the `/dunning` rule, `willBook`); a run with no fee posts nothing and its commit is the plain primary.
 *    A fee-bearing issue also needs the right to post, and the commit says so before the click.
 *
 * Escape, the close control and Abbrechen leave with nothing written. A run that cannot be read cannot be
 * issued from here (its facts would be missing): the confirm says so and the run stays in `/dunning`.
 */
import { useEffect, useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useCan, CAP } from '../../lib/capabilities';
import { useI18n, formatMoney } from '../../i18n';
import { Modal } from '../../components/Modal';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { parseRun, type DunningRunView } from '../Dunning/model';

/** The consequential-confirm role travels as a prop value (the modal-role guard reads a bare `<Modal>`). */
const ALERT_DIALOG = 'alertdialog' as const;

/** The meta separator, non-breaking. */
const SEP = ' · ';

/** The fees an issue of this run books, per currency: every fee-bearing item whose fee is not yet booked. */
export function feesToBook(run: DunningRunView): { currency: string; minor: number }[] {
  const sums = new Map<string, number>();
  for (const item of run.items) {
    if (item.feeMinor > 0 && !item.feeBooked) sums.set(item.currency, (sums.get(item.currency) ?? 0) + item.feeMinor);
  }
  return [...sums.entries()].map(([currency, minor]) => ({ currency, minor }));
}

export interface IssueDunningConfirmProps {
  /** The run to issue, or null while no confirm is open. */
  runId: string | null;
  workspaceId: string;
  /** Another act is in flight: the commit waits. */
  busy: boolean;
  /** The one commit: sends `issue_dunning_run` (the caller makes the call). */
  onConfirm: () => void;
  onClose: () => void;
}

export function IssueDunningConfirm({ runId, workspaceId, busy, onConfirm, onClose }: IssueDunningConfirmProps) {
  const { t } = useI18n();
  const client = useClient();
  const canPost = useCan(CAP.post);
  const describedBy = useId();
  const [run, setRun] = useState<DunningRunView | 'loading' | 'failed'>('loading');

  useEffect(() => {
    if (runId === null) return;
    let live = true;
    setRun('loading');
    void (async () => {
      const res = await client.call('get_dunning_run', { workspaceId, runId });
      if (!live) return;
      const parsed = isErr(res.body) ? null : parseRun(res.body);
      setRun(parsed ?? 'failed');
    })();
    return () => {
      live = false;
    };
  }, [client, runId, workspaceId]);

  const view = typeof run === 'object' ? run : null;
  const fees = view === null ? [] : feesToBook(view);
  const willBook = fees.length > 0;
  const blocked = view === null || busy || (willBook && !canPost);

  const facts: string[] = [];
  if (view !== null) {
    const letters = view.debtors.length;
    const invoices = view.items.length;
    facts.push(letters === 1 ? t('attention.dunning.confirm.lettersOne') : t('attention.dunning.confirm.letters', { count: letters }));
    facts.push(invoices === 1 ? t('attention.dunning.confirm.invoicesOne') : t('attention.dunning.confirm.invoices', { count: invoices }));
  }

  return (
    <Modal
      open={runId !== null}
      onClose={onClose}
      role={ALERT_DIALOG}
      title={t('attention.dunning.confirm.title')}
      closeLabel={t('attention.dunning.confirm.close')}
      describedById={describedBy}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('attention.dunning.confirm.cancel')}
          </button>
          <button
            type="button"
            className={willBook ? 'btn btn--accent' : 'btn btn--primary'}
            data-money-commit={willBook ? 'issue_dunning_run' : undefined}
            data-dunning-confirm=""
            disabled={blocked}
            onClick={onConfirm}
          >
            {t('attention.dunning.confirm.yes')}
          </button>
        </>
      }
    >
      <div id={describedBy} className="att-dunning-confirm">
        {run === 'loading' && (
          <p className="att-dunning-confirm-dim" role="status">
            {t('attention.dunning.confirm.loading')}
          </p>
        )}
        {run === 'failed' && <p role="alert">{t('attention.dunning.confirm.failed')}</p>}
        {view !== null && (
          <>
            <p className="att-dunning-confirm-facts">{facts.join(SEP)}</p>
            <p className="att-dunning-confirm-fees">
              {willBook
                ? t('attention.dunning.confirm.fees', { amounts: fees.map((f) => formatMoney(f.minor, f.currency)).join(SEP) })
                : t('attention.dunning.confirm.noFees')}
            </p>
            {willBook && !canPost && <p>{t('attention.dunning.confirm.needsPost')}</p>}
          </>
        )}
        <ConsequenceLine verb="issue_dunning_run" />
      </div>
    </Modal>
  );
}
