/**
 * S1, the Zahlungen list (`/payments`), and the entry point every other A14 surface opens from.
 *
 * Why this surface exists at all, against A14 §6's original "no new top-level screen": a **Guthaben
 * belongs to no document**. With payments reachable only from an invoice, an over-payment parked as
 * a credit would have no entry point anywhere in the product, and `list_payments` and
 * `reverse_payment` would have no GUI twin at all. That is the "affordance unreachable" defect class
 * this product has already shipped twice. Owner decision P1 (D38).
 *
 * The five states are all here and none of them is a placeholder: loading (skeleton rows matching
 * the real columns), empty (two distinct copies, because "you have no payments" and "no payments
 * match this filter" lead to different next actions), error (banner plus retry), success (the
 * table), and permission-denied (rows still read; the write controls are pre-disabled with the
 * reason inline, never shown and then rejected).
 *
 * Two things the row layout is deliberately doing:
 *
 *  - the status set is **Gebucht** and **Storniert** ONLY. A payment carrying a credit is still
 *    posted, so "Guthaben" is a chip ALONGSIDE the status, never a status word that replaces it and
 *    hides the settlement the same payment performed.
 *  - the Gegenpartei column is what makes a Guthaben findable. A credit belongs to somebody, and
 *    that somebody has to be visible in the list (P12b).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { OverflowMenu } from '../../components/OverflowMenu';
import { useCan, CAP } from '../../lib/capabilities';
import { asArray, allocationSummary, type Payment } from './model';
import { reversePaymentRequest } from './intent';
import { newIdempotencyKey } from './amount';
import { PaymentDetail } from './PaymentDetail';
import { ReverseDialog } from './ReverseDialog';
import { COMMIT_TARGET_CLASS, useCommitAck } from '../../lib/motion';
import './Payments.css';

/** The three URL-backed tabs (P5). `all` is the absence of the parameter, never a third value. */
const TABS = ['all', 'incoming', 'outgoing'] as const;
type Tab = (typeof TABS)[number];

function tabFrom(value: string | null): Tab {
  return TABS.includes(value as Tab) && value !== null ? (value as Tab) : 'all';
}

export function Payments() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  /**
   * THE PADLOCK (A24, F5 retrofit). Recording, allocating and reversing all declare
   * ['pay', 'post'] at the engine (settling posts a balanced entry through postEntry), so the
   * courtesy gate demands BOTH, exactly as the boundary will. Affordances are absent without them;
   * fail-open while `whoami` is unresolved, because the engine decides.
   *
   * BOTH HOOKS UNCONDITIONALLY, combined after (F5-N1): `useCan(a) && useCan(b)` short-circuits
   * the second hook call, which is safe only while `useCan` is a bare `useContext` and breaks the
   * render the day it grows a slot-allocating hook, on exactly the restricted role the padlock
   * exists for.
   */
  const holdsPay = useCan(CAP.pay);
  const holdsPost = useCan(CAP.post);
  const canPay = holdsPay && holdsPost;
  // F03: filing a Zahlungsavis for a supplier payment gates on `portal.manage` (the same right the
  // vendor-portal panel uses). It is independent of pay/post: an operator may manage portal access
  // without being able to move money.
  const canAdvise = useCan(CAP.portalManage);

  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);
  const [reversing, setReversing] = useState<Payment | null>(null);
  const [rowError, setRowError] = useState<Err | null>(null);

  const tab = tabFrom(params.get('direction'));
  const expandedId = params.get('payment');
  // The Commit moment (D122 D-I): the workbench hands over the id it just recorded in router state;
  // the row lands once the list has rendered it.
  const location = useLocation();
  const justRecorded = (location.state as { justRecorded?: string } | null)?.justRecorded ?? null;
  useCommitAck(justRecorded, payments);

  // The matcher is a route now (D113): recording a payment or allocating a Guthaben NAVIGATES to
  // `/payments/new`, which survives a reload and is shareable, rather than toggling a drawer here.
  const openRecord = useCallback(() => navigate('/payments/new'), [navigate]);
  const openAllocate = useCallback(
    (paymentId: string) => navigate(`/payments/new?allocate=${encodeURIComponent(paymentId)}`),
    [navigate],
  );

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setDenied(false);

    const response = await client.call('list_payments', {
      workspaceId,
      ...(tab === 'all' ? {} : { direction: tab }),
    });

    if (isErr(response.body)) {
      // A24: a missing capability is its own state, not an error banner. The rows would still read
      // if the read were permitted, so only a denied READ reaches here.
      if (response.body.error === 'permission_denied' || response.status === 403) setDenied(true);
      else setError(response.body);
      setLoading(false);
      return;
    }

    setPayments(asArray<Payment>(response.body.payments));
    setLoading(false);
  }, [client, workspaceId, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params);
      if (value === null) next.delete(key);
      else next.set(key, value);
      setParams(next, { replace: false });
    },
    [params, setParams],
  );

  const confirmReverse = useCallback(
    async (payment: Payment, date: string) => {
      if (workspaceId === null) return;
      setRowError(null);
      const response = await client.call(
        'reverse_payment',
        reversePaymentRequest({
          workspaceId,
          paymentId: payment.id,
          date,
          idempotencyKey: newIdempotencyKey(),
        }),
      );
      if (isErr(response.body)) {
        // S6 stays OPEN on failure with the date intact (P26): a dialog that vanishes on rejection
        // makes the user rebuild the whole decision to try again.
        setRowError(response.body);
        return;
      }
      setReversing(null);
      void load();
    },
    [client, workspaceId, load],
  );

  // F03 (US-F03.3): file a remittance advice for a supplier payment. Artifact-and-stop (OP4): the
  // engine snapshots the A14 allocation and files a local Beleg, transmitting nothing. Idempotent per
  // payment, so a double click never mints a second advice.
  const createAdvice = useCallback(
    async (payment: Payment) => {
      if (workspaceId === null) return;
      setRowError(null);
      const response = await client.call('vendor_portal_remittance_create', {
        workspaceId,
        paymentId: payment.id,
        idempotencyKey: newIdempotencyKey(),
      });
      if (isErr(response.body)) {
        setRowError(response.body);
        return;
      }
      void load();
    },
    [client, workspaceId, load],
  );

  const isFiltered = tab !== 'all';

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('payment.error.permission_denied')} />;

  return (
    <section className="pay" aria-labelledby="pay-title">
      <SurfaceHeader
        title={t('payment.title')}
        titleId="pay-title"
        help={<SurfaceHelp surface="Payments" />}
        actions={
          canPay ? (
            <button type="button" className="btn btn--primary" onClick={openRecord}>
              {t('payment.record')}
            </button>
          ) : undefined
        }
      />

      <div className="pay-toolbar" role="tablist" aria-label={t('payment.title')}>
        {TABS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={`pay-tab${tab === value ? ' pay-tab--on' : ''}`}
            onClick={() => setParam('direction', value === 'all' ? null : value)}
          >
            {t(`payment.direction.${value}`)}
          </button>
        ))}
      </div>

      {error !== null && (
        <ErrorBanner message={t('payment.error.transport')} onRetry={() => void load()} />
      )}

      {loading ? (
        <div className="pay-table-wrap">
          <Skeleton rows={4} />
        </div>
      ) : payments.length === 0 && error === null ? (
        isFiltered ? (
          <EmptyState
            title={t('payment.empty.filtered')}
            action={{ label: t('payment.resetFilter'), onClick: () => setParam('direction', null) }}
          />
        ) : (
          <EmptyState
            title={t('payment.empty.list')}
            {...(canPay ? { action: { label: t('payment.record'), onClick: openRecord } } : {})}
          />
        )
      ) : (
        <div className="pay-table-wrap">
          <table className="pay-table">
            <caption className="pay-sr">{t('payment.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('payment.column.date')}</th>
                <th scope="col">{t('payment.column.direction')}</th>
                <th scope="col">{t('payment.column.counterparty')}</th>
                <th scope="col" className="pay-num">
                  {t('payment.column.amount')}
                </th>
                <th scope="col">{t('payment.column.allocatedTo')}</th>
                <th scope="col">{t('payment.column.status')}</th>
                <th scope="col">
                  <span className="pay-sr">{t('payment.title')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <PaymentRow
                  commitTarget={payment.id === justRecorded}
                  key={payment.id}
                  payment={payment}
                  canPay={canPay}
                  canAdvise={canAdvise}
                  expanded={expandedId === payment.id}
                  onToggle={() => setParam('payment', expandedId === payment.id ? null : payment.id)}
                  onAllocate={() => openAllocate(payment.id)}
                  onReverse={() => setReversing(payment)}
                  onCreateAdvice={() => void createAdvice(payment)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reversing !== null && (
        <ReverseDialog
          payment={reversing}
          error={rowError}
          onConfirm={(date) => void confirmReverse(reversing, date)}
          onCancel={() => {
            setReversing(null);
            setRowError(null);
          }}
        />
      )}
    </section>
  );
}

function PaymentRow({
  payment,
  commitTarget,
  canPay,
  canAdvise,
  expanded,
  onToggle,
  onAllocate,
  onReverse,
  onCreateAdvice,
}: {
  payment: Payment;
  /** The row the Commit moment lands (D122 D-I): the payment just recorded. */
  commitTarget: boolean;
  /** A24 ['pay', 'post'] (F5): Stornieren and the Guthaben allocation are absent without both. */
  canPay: boolean;
  /** A24 portal.manage (F03): the Zahlungsavis action on an outgoing (supplier) payment. */
  canAdvise: boolean;
  expanded: boolean;
  onToggle: () => void;
  onAllocate: () => void;
  onReverse: () => void;
  onCreateAdvice: () => void;
}) {
  const t = useT();
  const summary = useMemo(() => allocationSummary(payment), [payment]);
  const reversed = payment.status === 'reversed';

  return (
    <>
      <tr className={['pay-row', reversed ? 'pay-row--reversed' : '', commitTarget ? COMMIT_TARGET_CLASS : ''].filter(Boolean).join(' ')}>
        <td>{formatDate(payment.date)}</td>
        <td>{t(`payment.direction.${payment.direction}`)}</td>
        <td>{payment.counterparty?.name ?? ''}</td>
        <td className="pay-num">{formatMoney(payment.amountMinor, payment.currency)}</td>
        <td>
          {summary.kind === 'one' ? (
            summary.value
          ) : summary.kind === 'many' ? (
            t('payment.documentCount', { n: summary.value })
          ) : (
            <span className="pay-dim">{t('payment.empty.allocations')}</span>
          )}
        </td>
        <td>
          {/* Word-only chip (D19/U4). Never colour alone, and never a glyph standing in for a word. */}
          <span className="pay-chip">{t(`payment.status.${payment.status}`)}</span>
        </td>
        <td className="pay-row-actions">
          <button type="button" className="pay-expand" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? '⌃' : '⌄'}
            <span className="pay-sr">{payment.date}</span>
          </button>
          {/* Stornieren lives ONLY behind the overflow, and only for a payment that is not already
              reversed: `already_reversed` is therefore unreachable from the GUI by construction. The
              F03 Zahlungsavis joins it for an OUTGOING (supplier) payment when the user holds
              portal.manage (padlock: absent otherwise, never shown-then-rejected). */}
          {!reversed && (canPay || (canAdvise && payment.direction === 'outgoing')) && (
            <OverflowMenu
              label={t('payment.title')}
              items={[
                ...(canAdvise && payment.direction === 'outgoing'
                  ? [{ key: 'advice', label: t('payment.createAdvice'), onSelect: onCreateAdvice }]
                  : []),
                ...(canPay ? [{ key: 'reverse', label: t('payment.reverse'), onSelect: onReverse, danger: true }] : []),
              ]}
            />
          )}
        </td>
      </tr>

      {payment.onAccountMinor > 0 && (
        <tr className="pay-row-credit">
          <td colSpan={7}>
            {/* A live action, never a dead label: a Guthaben the user cannot act on is the
                terminal-state-as-dead-end defect (A10-G6) wearing different clothes. */}
            <span className="pay-credit-chip">
              {t('payment.onAccount.for', {
                amount: formatMoney(payment.onAccountMinor, payment.currency),
                name: payment.counterparty?.name ?? '',
              })}
            </span>
            {canPay && (
              <button type="button" className="btn btn--ghost pay-credit-action" onClick={onAllocate}>
                {t('payment.allocate')}
              </button>
            )}
          </td>
        </tr>
      )}

      {reversed && payment.reversedAt !== null && (
        <tr className="pay-row-credit">
          <td colSpan={7}>
            <Link to={`/journal?entry=${payment.reversalEntryId ?? ''}`} className="pay-link">
              {t('payment.reversedLink', { date: formatDate(payment.reversedAt) })}
            </Link>
          </td>
        </tr>
      )}

      {expanded && (
        <tr className="pay-row-detail">
          <td colSpan={7}>
            <PaymentDetail paymentId={payment.id} />
          </td>
        </tr>
      )}
    </>
  );
}
