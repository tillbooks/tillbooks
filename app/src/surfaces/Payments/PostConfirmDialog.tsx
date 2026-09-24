/**
 * The P9 confirmation dialog: one deliberate look before money moves.
 *
 * This dialog is a PRESENTATION of an intent that already exists on the wire. It does not create the
 * intent, it does not carry it, and it cannot withhold it: `intent.ts` attaches the token with no
 * parameter for it, so a suppressed dialog and a shown one produce the identical request body. What
 * the checkbox changes is whether a person is asked, and nothing else.
 *
 * That separation is the whole point of D38's answer, and it is worth restating where somebody might
 * be tempted to "simplify" by passing `confirmed` down to the request builder: a server-side
 * preference was rejected precisely because it would imply the preference could change the contract.
 *
 * The checkbox is deliberately NOT pre-ticked. A person who wants to stop being asked says so; a
 * default that silently stops asking is the same failure as a destructive action with no confirm.
 */
import { useId, useState } from 'react';

import { useT } from '../../i18n';
import { ConsequenceLine } from '../../components/ConsequenceLine';

export interface PostConfirmDialogProps {
  /** The already-formatted amount, e.g. `CHF 1'081.00`. Formatting belongs to the caller. */
  amount: string;
  /**
   * C4: the payment verb this confirm precedes (`record_payment` or `allocate_payment`). It sources
   * the shared consequence sentence, the same one an approver reads when clearing an agent's drafted
   * payment. Optional so the dialog degrades to its own copy when a caller has no verb to name.
   */
  verb?: string;
  busy?: boolean;
  /** `suppress` is the checkbox. It governs the dialog and never the request. */
  onConfirm: (suppress: boolean) => void;
  onCancel: () => void;
}

export function PostConfirmDialog({ amount, verb, busy = false, onConfirm, onCancel }: PostConfirmDialogProps) {
  const t = useT();
  const titleId = useId();
  const checkboxId = useId();
  const [suppress, setSuppress] = useState(false);

  return (
    <div className="pay-confirm-overlay" role="presentation" onClick={onCancel}>
      <div
        className="pay-confirm panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <p id={titleId} className="pay-confirm-message">
          {t('payment.confirm.post', { amount })}
        </p>
        <p className="pay-confirm-detail">{t('payment.confirm.postDetail')}</p>
        {/* C4: the same consequence sentence a human and the agent both read for this write. */}
        {verb !== undefined && <ConsequenceLine verb={verb} />}

        <label className="pay-confirm-suppress" htmlFor={checkboxId}>
          <input
            id={checkboxId}
            type="checkbox"
            checked={suppress}
            onChange={(event) => setSuppress(event.target.checked)}
          />
          <span>{t('payment.confirm.postSuppress')}</span>
        </label>

        <div className="pay-confirm-foot">
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            {t('payment.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => onConfirm(suppress)}>
            {t('payment.post')}
          </button>
        </div>
      </div>
    </div>
  );
}
