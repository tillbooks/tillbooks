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
 *    posted, so "Guthaben" is a note ALONGSIDE the status, never a status word that replaces it and
 *    hides the settlement the same payment performed.
 *  - the Gegenpartei column is what makes a Guthaben findable. A credit belongs to somebody, and
 *    that somebody has to be visible in the list (P12b).
 *
 * ONE ROW, ONE LINE (K-26, D137). The list is the shared DataTable: a row is the row height, the
 * whole row opens the payment in a drawer (its allocations, its journal entry, its reversal), and the
 * other verbs sit behind the row's one overflow. The only verb left on the row itself is "Zuweisen" on
 * a payment still carrying a Guthaben, beside the amount it would assign: a credit is never a dead
 * label. The direction is a Segmented control (K-11): three sibling values of one list, not tabs.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { DetailDrawer } from '../../components/DetailDrawer';
import type { OverflowMenuItem } from '../../components/OverflowMenu';
import { Segmented } from '../../components/Segmented';
import { Status } from '../../components/Status';
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
  const expanded = expandedId === null ? null : (payments.find((p) => p.id === expandedId) ?? null);

  /**
   * The row's other verbs, behind its ONE overflow (K-21). Stornieren only for a payment that is not
   * already reversed (`already_reversed` is unreachable from the GUI by construction), destructive and
   * so last; the F03 Zahlungsavis for an OUTGOING payment when the user holds portal.manage (absent
   * otherwise, never shown and then rejected).
   */
  const paymentActions = (payment: Payment): OverflowMenuItem[] => {
    if (payment.status === 'reversed') return [];
    return [
      ...(canAdvise && payment.direction === 'outgoing'
        ? [{ key: 'advice', label: t('payment.createAdvice'), onSelect: () => void createAdvice(payment) }]
        : []),
      ...(canPay ? [{ key: 'reverse', label: t('payment.reverse'), onSelect: () => setReversing(payment), danger: true }] : []),
    ];
  };

  /**
   * The list columns. Every figure is the engine's, verbatim through `formatMoney` in the payment's
   * own currency; the amount column is `numeric`, so it right-aligns in tabular figures and never
   * wraps (K-18). A Guthaben rides the "Zugewiesen an" cell as a note with its live "Zuweisen".
   */
  const columns: DataTableColumn<Payment>[] = [
    { key: 'date', header: t('payment.column.date'), render: (payment) => formatDate(payment.date) },
    {
      key: 'direction',
      header: t('payment.column.direction'),
      render: (payment) => t(`payment.direction.${payment.direction}`),
    },
    {
      key: 'counterparty',
      header: t('payment.column.counterparty'),
      render: (payment) => payment.counterparty?.name ?? '',
    },
    {
      key: 'amount',
      header: t('payment.column.amount'),
      numeric: true,
      render: (payment) => formatMoney(payment.amountMinor, payment.currency),
    },
    {
      key: 'allocatedTo',
      header: t('payment.column.allocatedTo'),
      render: (payment) => {
        const summary = allocationSummary(payment);
        const allocated =
          summary.kind === 'one' ? (
            summary.value
          ) : summary.kind === 'many' ? (
            t('payment.documentCount', { n: summary.value })
          ) : (
            <span className="pay-dim">{t('payment.empty.allocations')}</span>
          );
        if (payment.onAccountMinor <= 0) return allocated;
        // A live action, never a dead label: a Guthaben the user cannot act on is the
        // terminal-state-as-dead-end defect (A10-G6) wearing different clothes.
        return (
          <span className="pay-allocated">
            {summary.kind !== 'none' && <span>{allocated}</span>}
            <span className="pay-credit t-money">
              {t('payment.onAccount.chip', { amount: formatMoney(payment.onAccountMinor, payment.currency) })}
            </span>
            {canPay && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={(event) => {
                  event.stopPropagation();
                  openAllocate(payment.id);
                }}
              >
                {t('payment.allocate')}
              </button>
            )}
          </span>
        );
      },
    },
    {
      key: 'status',
      header: t('payment.column.status'),
      // K-22: the shared Status word. Never colour alone, never a glyph standing in for a word.
      render: (payment) => (
        <Status
          kind={payment.status === 'reversed' ? 'inactive' : 'success'}
          label={t(`payment.status.${payment.status}`)}
        />
      ),
    },
  ];

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

      {/* K-11: the direction is three sibling values of one list, so a Segmented control. */}
      <div className="pay-toolbar">
        <Segmented<Tab>
          label={t('payment.column.direction')}
          options={TABS.map((value) => ({ value, label: t(`payment.direction.${value}`) }))}
          value={tab}
          onChange={(value) => setParam('direction', value === 'all' ? null : value)}
        />
      </div>

      {error !== null && (
        <ErrorBanner message={t('payment.error.transport')} onRetry={() => void load()} />
      )}

      {error === null && (
        <DataTable<Payment>
          columns={columns}
          rows={payments}
          rowKey={(payment) => payment.id}
          caption={t('payment.caption')}
          loading={loading}
          skeletonRows={4}
          onRowClick={(payment) => setParam('payment', payment.id)}
          rowLabel={(payment) =>
            t('payment.openRow', {
              date: formatDate(payment.date),
              amount: formatMoney(payment.amountMinor, payment.currency),
            })
          }
          rowActions={paymentActions}
          rowActionsLabel={(payment) =>
            t('payment.rowActionsFor', {
              date: formatDate(payment.date),
              amount: formatMoney(payment.amountMinor, payment.currency),
            })
          }
          rowClassName={(payment) =>
            [payment.status === 'reversed' ? 'pay-row--reversed' : '', payment.id === justRecorded ? COMMIT_TARGET_CLASS : '']
              .filter(Boolean)
              .join(' ') || undefined
          }
          emptyState={
            isFiltered ? (
              <EmptyState
                title={t('payment.empty.filtered')}
                hint={t('payment.empty.filteredHint')}
                filtered={{ onClear: () => setParam('direction', null), clearLabel: t('payment.resetFilter') }}
              />
            ) : (
              <EmptyState
                title={t('payment.empty.list')}
                hint={t('payment.empty.listHint')}
                {...(canPay ? { action: { label: t('payment.record'), onClick: openRecord } } : {})}
              />
            )
          }
        />
      )}

      {/* K-26: the detail opens in the drawer, not as a second row pushed into the list. */}
      <DetailDrawer
        open={expanded !== null}
        onClose={() => setParam('payment', null)}
        title={
          expanded === null
            ? ''
            : t('payment.detail.title', {
                date: formatDate(expanded.date),
                amount: formatMoney(expanded.amountMinor, expanded.currency),
              })
        }
        closeLabel={t('payment.close')}
      >
        {expanded !== null && (
          <div className="pay-drawer">
            {expanded.status === 'reversed' && expanded.reversedAt !== null && (
              <p className="pay-drawer-note">
                <Link to={`/journal?entry=${expanded.reversalEntryId ?? ''}`} className="pay-link link-inline">
                  {t('payment.reversedLink', { date: formatDate(expanded.reversedAt) })}
                </Link>
              </p>
            )}
            <PaymentDetail paymentId={expanded.id} />
          </div>
        )}
      </DetailDrawer>

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
