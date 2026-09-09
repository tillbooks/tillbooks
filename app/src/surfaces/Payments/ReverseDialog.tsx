/**
 * S6, the Storno confirm.
 *
 * The word is **stornieren** everywhere and the confirm is labelled Stornieren, never "Löschen": a
 * correction is a reversing entry, and the copy says so in the same breath as it says the original
 * is kept. It carries a date field because the reversal posts on its OWN date, not the original's.
 *
 * It also states, in one sentence, that a payment is always reversed whole. That sentence is there
 * so a user hunting for a partial undo finds the answer here instead of looking for a control that
 * does not exist.
 *
 * On failure the dialog STAYS OPEN with the date intact (P26). A dialog that vanishes on rejection
 * makes the user rebuild the whole decision before they can try again.
 */
import { useState } from 'react';

import type { Err } from '../../lib/client';
import { useT, formatMoney, formatDate } from '../../i18n';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { ConfirmDialog } from './ConfirmDialog';
import { PaymentError } from './PaymentError';
import { allocationSummary, type Payment } from './model';

export interface ReverseDialogProps {
  payment: Payment;
  error: Err | null;
  onConfirm: (date: string) => void;
  onCancel: () => void;
}

export function ReverseDialog({ payment, error, onConfirm, onCancel }: ReverseDialogProps) {
  const t = useT();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const summary = allocationSummary(payment);

  return (
    <ConfirmDialog
      message={t('payment.confirm.reverse', {
        date: formatDate(payment.date),
        amount: formatMoney(payment.amountMinor, payment.currency),
        number: summary.kind === 'one' ? summary.value : t('payment.documentCount', { n: summary.value }),
      })}
      confirmLabel={t('payment.reverse')}
      onConfirm={() => onConfirm(date)}
      onCancel={onCancel}
    >
      <p className="pay-confirm-detail">{t('payment.confirm.reverseWhole')}</p>
      {/* C4: a Storno is a posting write (`reverse_payment`, dial capability `pay`), so it carries the
          SAME consequence sentence a human reads at the record/allocate confirm and an approver reads
          clearing an agent's proposal. Self-guards to null for a verb with no dial capability. */}
      <ConsequenceLine verb="reverse_payment" />
      <label className="pay-field">
        <span>{t('payment.confirm.reverseDate')}</span>
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </label>
      {error !== null && <PaymentError error={error} currency={payment.currency} />}
    </ConfirmDialog>
  );
}
