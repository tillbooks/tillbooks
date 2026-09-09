/**
 * S5, the "Als eingereicht markieren" gate.
 *
 * IT RECORDS A CLAIM, IT DOES NOT TRANSMIT ANYTHING, and the copy says so in the first sentence.
 * There is no ESTV submission API: eCH-0217 is a file format, not a transport. What this button does
 * is apply A03's hard lock and record that the operator says they filed. A dialog that let the filer
 * believe TILL had sent something would be the single most damaging misreading available here.
 *
 * THE UNEXPLAINED DIFFERENCE IS RESTATED BEHIND A CHECKBOX THAT GATES CONFIRM (owner decision W2).
 * That is the forgiveness rule applied at the one moment it can still change the outcome. It warns,
 * it does not block: the filer can always acknowledge and proceed, because filing is a statutory
 * obligation with a deadline and the bridge is TILL's own heuristic.
 *
 * THE OVERLAY IS THE SHARED `Modal` PRIMITIVE (D118 B2), as an alertdialog. The primitive hosts the
 * role on a `div` (W3C "ARIA in HTML" permits an alert-style dialog role on `div`, not on `aside`),
 * traps focus, returns it to the opener on close, and, being an alertdialog, does NOT dismiss on a
 * scrim click: a consequential question is answered with a control, not by clicking away. The
 * bespoke `.vr-overlay` / `.vr-dialog` chrome the surface once carried is gone; only the dialog's
 * own content classes remain here.
 */
import { useId, useState } from 'react';

import { useT, formatMoney, formatDate } from '../../i18n';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { Modal } from '../../components/Modal';
import { periodTitle } from './model';

/** A consequential confirm is an alertdialog. Held as a value so the role travels as a prop, never
 *  as a literal attribute the modal-role guard scans for. */
const ALERT_DIALOG = 'alertdialog' as const;

export interface MarkFiledDialogProps {
  period: string;
  periodStart: string;
  periodEnd: string;
  payableMinor: number;
  creditMinor: number;
  currency: string;
  /** The unexplained remainder, or 0 when the bridge left nothing open. */
  unexplainedMinor: number;
  pending: boolean;
  /** A failure from the write, rendered inside the dialog so nothing the operator did is lost. */
  failed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function MarkFiledDialog({
  period,
  periodStart,
  periodEnd,
  payableMinor,
  creditMinor,
  currency,
  unexplainedMinor,
  pending,
  failed,
  onConfirm,
  onCancel,
}: MarkFiledDialogProps) {
  const t = useT();
  const bodyId = useId();
  const ackId = useId();
  const [acknowledged, setAcknowledged] = useState(false);

  const needsAck = unexplainedMinor !== 0;
  const blocked = needsAck && !acknowledged;
  const label = periodTitle(period);

  return (
    <Modal
      open
      role={ALERT_DIALOG}
      title={t('vat.return.confirmTitle', { period: label })}
      closeLabel={t('vat.return.confirmClose')}
      onClose={onCancel}
      describedById={bodyId}
      footer={
        <>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onCancel}>
            {t('vat.return.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={blocked || pending}
            onClick={onConfirm}
          >
            {pending ? t('vat.return.markFiledPending') : t('vat.return.markFiled')}
          </button>
        </>
      }
    >
      <p id={bodyId} className="vr-dialog-body">
        {t('vat.return.confirmBody')}
      </p>
      <p className="vr-dialog-body">{t('vat.return.confirmIrreversible')}</p>
      {/* C4: the statutory-filing consequence, the identical sentence the agent's Vorschlag carries. */}
      <ConsequenceLine verb="vat_mark_filed" />

      <dl className="vr-dialog-facts">
        <div>
          <dt>{t('vat.return.confirmPeriod')}</dt>
          <dd>
            {label}, {formatDate(periodStart)} {t('vat.return.rangeTo')} {formatDate(periodEnd)}
          </dd>
        </div>
        <div>
          <dt>{creditMinor > 0 ? t('vat.return.credit') : t('vat.return.payable')}</dt>
          <dd>{formatMoney(creditMinor > 0 ? creditMinor : payableMinor, currency)}</dd>
        </div>
      </dl>

      {needsAck && (
        <p className="vr-dialog-ack">
          <input
            id={ackId}
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <label htmlFor={ackId}>
            {t('vat.return.confirmAck', { amount: formatMoney(unexplainedMinor, currency) })}
          </label>
        </p>
      )}

      {failed && (
        <p className="vr-dialog-error" role="alert">
          {t('vat.return.markFiledFailed')}
        </p>
      )}
    </Modal>
  );
}
