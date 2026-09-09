/**
 * S3, the payment detail, expanded inside its S1 row and deep-linkable at `/payments?payment=<id>`.
 *
 * A read surface: its only actions are links and the row's own overflow. The design cut a dedicated
 * detail ROUTE rather than lose the addressability, which is why the expansion is driven by a URL
 * parameter and not by component state.
 *
 * Every terminal thing here links, because a terminal state that cannot be opened is a dead end and
 * this product has shipped that defect (A10-G6, a converted document whose chip was a bare span).
 * The allocation links to its document by NUMBER, and the payment links to its journal entry by id,
 * which also closes A10-G17's generic `/journal` link.
 *
 * The empty state is the load-bearing one: an unallocated payment reads as its Guthaben WITH its
 * owner, never as a blank panel and never as a credit belonging to nobody (P12b).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { Skeleton } from '../../components/states';
import { Provenance, type ProvenanceOrigin } from '../../components/Provenance';
import { PaymentError } from './PaymentError';
import { asArray, type Payment, type PaymentAllocation } from './model';

/**
 * C3: a payment's origin from its `source`. The A18 sources are `manual`, `camt` (a bank-statement
 * import) and `qr`; none is an agent seat, so an agent-authored payment is named by its `createdBy`
 * actor, not by colour. A `camt` row reads as an import; the rest read as a human hand.
 */
function paymentOrigin(source: string): ProvenanceOrigin {
  return source === 'camt' ? 'import' : 'human';
}

export function PaymentDetail({ paymentId }: { paymentId: string }) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [payment, setPayment] = useState<Payment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setError(null);
    const response = await client.call('get_payment', { workspaceId, paymentId });
    if (isErr(response.body)) {
      setError(response.body);
      setLoading(false);
      return;
    }
    setPayment((response.body.payment ?? null) as Payment | null);
    setLoading(false);
  }, [client, workspaceId, paymentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Skeleton rows={2} />;
  if (error !== null) return <PaymentError error={error} onRetry={() => void load()} />;
  if (payment === null) return null;

  const allocations = asArray<PaymentAllocation>(payment.allocations);
  // `manual` is a human word and gets humanised; `camt` and `qr` are IT terms and stay as they are
  // (D56), so the raw enum never reaches the screen for the one value that reads as jargon.
  const sourceLabel = payment.source === 'manual' ? t('payment.detail.sourceValue.manual') : payment.source;

  return (
    <div className="pay-detail">
      <h4 className="pay-detail-title">{t('payment.detail.allocations')}</h4>

      {allocations.length === 0 ? (
        <p className="pay-detail-empty">
          {t('payment.empty.allocations')}{' '}
          {payment.onAccountMinor > 0 &&
            t('payment.onAccount.for', {
              amount: formatMoney(payment.onAccountMinor, payment.currency),
              name: payment.counterparty?.name ?? '',
            })}
        </p>
      ) : (
        <ul className="pay-detail-list">
          {allocations.map((allocation) => (
            <li key={allocation.id}>
              {/* The link honours the allocation's targetKind, mirroring PaymentAllocator: a vendor
                  bill is not a document and routes to /bills, a booked Mahngebühr is not routable at
                  all (its target is a dunning_item row) so it stands as plain text, and everything
                  else is a customer document. A blind /documents/:id 404s a supplier-bill payment. */}
              {allocation.targetKind === 'vendor_bill' ? (
                <Link to={`/bills?bill=${allocation.targetId}`} className="pay-link">
                  {allocation.targetNumber}
                </Link>
              ) : allocation.targetKind === 'dunning_fee' ? (
                <span className="pay-cand-fee">{allocation.targetNumber}</span>
              ) : (
                <Link to={`/documents/${allocation.targetId}`} className="pay-link">
                  {allocation.targetNumber}
                </Link>
              )}
              <span className="pay-num">{formatMoney(allocation.amountMinor, payment.currency)}</span>
              {allocation.skontoMinor > 0 && (
                <span className="pay-dim">
                  {`${t('payment.skonto')} ${formatMoney(allocation.skontoMinor, payment.currency)}`}
                </span>
              )}
              {allocation.writeoffMinor > 0 && (
                <span className="pay-dim">
                  {`${t('payment.writeOff.noun')} ${formatMoney(allocation.writeoffMinor, payment.currency)}`}
                </span>
              )}
              {/* The Ist line: the only place a human sees US-A14.5's automatic stamp outside A07. */}
              {allocation.recognizedAt !== null && allocation.taxAmountMinor !== null && (
                <span className="pay-dim">
                  {t('payment.preview.istVat', {
                    date: formatDate(allocation.recognizedAt),
                    amount: formatMoney(allocation.taxAmountMinor, payment.currency),
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="pay-detail-meta">
        <Link to={`/journal?entry=${payment.journalEntryId}`} className="pay-link">
          {t('payment.detail.journalEntry')}
        </Link>
        <span className="pay-dim">{`${t('payment.detail.source')}: ${sourceLabel}`}</span>
        {payment.reference.display !== null && <span className="pay-dim">{payment.reference.display}</span>}
      </p>

      {/* C3: who recorded this payment and when, from the read model's own header (`created_by`/
          `created_at`). The timestamp is always present; a legacy row with no actor shows the neutral
          "unbekannt" form, never a fabricated name. */}
      {payment.createdAt != null && (
        <Provenance
          origin={paymentOrigin(payment.source)}
          actor={payment.createdBy}
          timestamp={payment.createdAt}
        />
      )}
    </div>
  );
}
