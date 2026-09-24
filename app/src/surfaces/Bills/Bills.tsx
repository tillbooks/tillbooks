/**
 * A17, Kreditoren (`/bills`): the payables list, and the one screen where a supplier bill is captured.
 *
 * WHY THIS IS A RAIL ITEM IN ITS OWN GROUP. It is the first purchase surface in the product, and the
 * existing groups are the wrong home for it in three different ways: Verkauf is what a CUSTOMER owes,
 * Bank is where money moves rather than where an obligation lives, and Buchhaltung is the journal and
 * the statements. A Kreditor is the mirror of a Debitor, so it sits at the same level in the rail, in an
 * Einkauf group that A18 (creditor payment files) and A20's purchase side will join.
 *
 * ONE PRIMARY ACTION, AND IT IS THE CAPTURE. "Rechnung erfassen" opens the editor, and everything else
 * on this screen is a row action or a filter. The accent is spent there and nowhere else, which is
 * DESIGN.md's whole budget for a surface.
 *
 * THE PAY BUTTON NAVIGATES TO A14's OWN MATCHER, not a second one. It routes to `/payments/new` with
 * `direction=outgoing` and the bill's open amount seeded on the URL (D113): the same Werkbank the
 * OP-Liste and the invoice detail open, and `suggest_payment_matches` now ranks open BILLS for an
 * outgoing payment, so the candidate list inside it is the engine's and not this surface's. A17 owns no
 * pay verb and no payment UI: settlement is A14's `record_payment`, which is the whole reason there is
 * no second settlement path to keep in sync.
 *
 * THE RECONCILIATION BAND IS THE POINT OF THE LIST, not decoration. A payables list that does not tie
 * back to account 2000 Kreditoren is a spreadsheet, and an auditor cannot use it. `reconciled` compares
 * two independent derivations (the bills and their allocations against the posted balance of 2000), so
 * a movement A17 does not model shows up as a stated difference rather than as a silently wrong total.
 *
 * EVERY FIGURE IS THE ENGINE'S. `openMinor` per row, `baseTotalOpenMinor` in the header, the buckets in
 * the tiles: none of them is computed in the browser, and none of them is re-signed here either.
 *
 * OPEN PAYABLES ARE SHOWN POSITIVE (K-39, D137, DESIGN.md §Money). A Treuhänderin reads on Kreditoren
 * what she owes, and the Übersicht tile and the payment run already show that figure positive; this
 * surface used to print it with a minus, which read as a credit with the supplier. So every amount is
 * printed exactly as the engine sends it: an open bill is positive, and the minus is left to the one
 * case that really is a credit (an overpaid bill whose `openMinor` the engine reports below zero, a
 * credit note or a reversal), with the sign in the text and never a filled red row. Display only: no
 * engine value, sign or total changes.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2)
 *
 * The payables list is the shared `DataTable` (frame overflow, sticky header, density and the loading,
 * empty and data states in one place); the two money columns are `numeric`, so they right-align with
 * the shared tabular `.t-num` class, and a voided row dims through the `rowClassName` hook. The page
 * header and the primary "Rechnung erfassen" action are the shared `SurfaceHeader`. The bespoke table,
 * head and drawer CSS is deleted; what remains is genuinely surface-specific: the reconciliation band,
 * the open-total line, the overdue note beside the shared `Status` word and the two-select filter
 * toolbar. The row itself opens the bill (K-21) and its one overflow holds the pay verb. The status/vendor
 * filter row is NOT the shared `FilterBar` (that primitive leads with a free-text search this surface
 * has no read wired for, and inventing one is out of D118 B2 scope): it stays two selects that drive
 * the server-side read. The transport error keeps its own surface copy above the table rather than
 * DataTable's error slot, so a failed read never renders as an empty ledger.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan, CAP } from '../../lib/capabilities';
import { useT, useTRich, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Select } from '../../components/Select';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import type { OverflowMenuItem } from '../../components/OverflowMenu';
import { Status, type StatusKind } from '../../components/Status';
import { BillEditor } from './BillEditor';
import { COMMIT_TARGET_CLASS, useCommitAck } from '../../lib/motion';
import { VENDOR_BILL_STATUSES, parseBills, type BillsView, type VendorBill } from './model';
import './Bills.css';

/**
 * The Status kind for a bill's display word (K-22). The glyph carries the state; the word is the
 * engine's `displayStatus`, translated. An open bill past its due date is the one that needs attention.
 */
function statusKind(displayStatus: string, overdue: boolean): StatusKind {
  if (overdue) return 'warn';
  switch (displayStatus) {
    case 'paid':
      return 'success';
    case 'void':
      return 'inactive';
    case 'posted':
    case 'partly_paid':
      return 'pending';
    default:
      return 'neutral';
  }
}

export function Bills() {
  const t = useT();
  const tRich = useTRich();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  /**
   * A24, the courtesy gate (spec §6): `record_payment` requires `pay`, so a row's pay action is
   * offered DISABLED to an actor who does not hold it, never offered and then rejected. This is an
   * actor-level fact, identical for every row, so it is read once here rather than per row. It fails
   * open while `whoami` is unresolved; the engine's gate is the one that decides.
   */
  const canPay = useCan(CAP.pay);

  const statusParam = params.get('status');
  const vendorParam = params.get('vendor');
  const billParam = params.get('bill');
  const creating = params.get('new') === '1';

  /**
   * "Zahlung erfassen" NAVIGATES to A14's Werkbank matcher (D113), the bill's open amount and the
   * direction seeded on the URL, rather than opening a forked overlay here. The candidate list, the
   * posting preview, the confirmation and the write are all A14's: this surface only says which
   * payment it is about, and now it says so with a link.
   */
  const openPay = useCallback(
    (bill: VendorBill) => {
      const query = new URLSearchParams({ direction: 'outgoing', amount: (bill.openMinor / 100).toFixed(2) });
      if (bill.vendorReference !== null) query.set('reference', bill.vendorReference);
      navigate(`/payments/new?${query.toString()}`);
    },
    [navigate],
  );

  const [view, setView] = useState<BillsView | null>(null);
  // The Commit moment (D122 D-I): the bill the editor just posted or captured lands in the list.
  const [justSavedId, setJustSavedId] = useState<string | null>(null);
  useCommitAck(justSavedId, view);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const response = await client.call('list_vendor_bills', {
      workspaceId,
      ...(statusParam === null ? {} : { status: statusParam }),
      ...(vendorParam === null ? {} : { vendorId: vendorParam }),
    });
    if (isErr(response.body)) {
      // A24: a missing capability is its own state, not an error banner. Only a denied READ is here.
      if (response.body.error === 'permission_denied' || response.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseBills(response.body);
    if (parsed === null) setFailed(true);
    setView(parsed);
    setLoading(false);
  }, [client, workspaceId, statusParam, vendorParam]);

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

  const closeDrawer = useCallback(() => {
    const next = new URLSearchParams(params);
    for (const key of ['new', 'bill']) next.delete(key);
    setParams(next, { replace: false });
  }, [params, setParams]);

  /** The vendors offered by the filter, from the rows the engine actually returned. */
  const vendorOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const bill of view?.bills ?? []) {
      if (byId.get(bill.vendorId) === undefined || byId.get(bill.vendorId) === '') {
        byId.set(bill.vendorId, bill.vendorName ?? '');
      }
    }
    // The selected value is folded in so the control can always show what it is set to, even when the
    // narrowed read came back with no rows carrying its name. The same trick A16's currency filter uses.
    if (vendorParam !== null && !byId.has(vendorParam)) byId.set(vendorParam, '');
    return [...byId.entries()]
      .map(([id, name]) => ({ id, label: name === '' ? t('bills.filter.vendorById', { id }) : name }))
      .sort((a, b) => a.label.localeCompare(b.label, 'de-CH'));
  }, [view, vendorParam, t]);

  const selected = useMemo(
    () => (billParam === null ? null : (view?.bills.find((b) => b.id === billParam) ?? null)),
    [view, billParam],
  );
  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('bills.error.permissionDenied.read')} />;

  const settled = !loading && !failed && view !== null;
  const filterActive = statusParam !== null || vendorParam !== null;

  /**
   * The list columns. Text left-aligns; every money column is `numeric`, so DataTable right-aligns it,
   * gives it the shared tabular `.t-num` class and keeps the figure on one line (K-18). EVERY FIGURE IS
   * THE ENGINE'S, printed verbatim from the row (`grossMinor`, `openMinor`) with its own sign: an open
   * payable reads positive (K-39), and only a figure the engine sends below zero carries a minus. The
   * row's OWN currency is used, never converted in the browser.
   */
  const columns: DataTableColumn<VendorBill>[] = [
    {
      key: 'reference',
      header: t('bills.column.reference'),
      // The leading cell names the row; the row itself opens the drawer (K-21), so the cell holds no
      // button of its own.
      render: (bill) => bill.vendorReference ?? t('bills.noReference'),
    },
    { key: 'vendor', header: t('bills.vendor'), render: (bill) => bill.vendorName ?? t('bills.unknownVendor') },
    { key: 'billDate', header: t('bills.billDate'), render: (bill) => formatDate(bill.billDate) },
    {
      key: 'dueDate',
      header: t('bills.dueDate'),
      render: (bill) => (bill.dueDate === null ? t('bills.noDueDate') : formatDate(bill.dueDate)),
    },
    {
      key: 'gross',
      header: t('bills.column.gross'),
      numeric: true,
      render: (bill) => formatMoney(bill.grossMinor, bill.currency),
    },
    {
      key: 'open',
      header: t('bills.column.open'),
      numeric: true,
      render: (bill) => (bill.status === 'posted' ? formatMoney(bill.openMinor, bill.currency) : ''),
    },
    {
      key: 'status',
      header: t('bills.column.status'),
      render: (bill) => {
        const overdue = bill.overdue && bill.openMinor > 0;
        return (
          <span className="bills-status">
            <Status
              kind={statusKind(bill.displayStatus, overdue)}
              label={t(`bills.status.${bill.displayStatus}`)}
            />
            {overdue && (
              <span className="bills-overdue">{t('bills.overdueDays', { n: bill.daysOverdue })}</span>
            )}
          </span>
        );
      },
    },
  ];

  /**
   * Every verb besides opening sits behind the row's one overflow (K-21). "Zahlung erfassen" appears
   * only on a row that HAS an open amount: a settled or voided bill offering a pay action is a control
   * whose only outcome is a rejection. It is pre-disabled for an actor without `pay`, never offered and
   * then refused (A24, spec §6). A row with nothing to offer renders no trigger at all.
   */
  const rowActions = (bill: VendorBill): OverflowMenuItem[] => {
    const payable = bill.status === 'posted' && bill.openMinor > 0;
    if (!payable) return [];
    return [
      {
        key: 'pay',
        label: canPay ? t('bills.pay') : t('bills.payDenied'),
        onSelect: () => openPay(bill),
        disabled: !canPay,
      },
    ];
  };
  const rowName = (bill: VendorBill) => bill.vendorReference ?? t('bills.noReference');

  return (
    <section className="bills" aria-labelledby="bills-title">
      <SurfaceHeader
        title={t('bills.title')}
        titleId="bills-title"
        help={<SurfaceHelp surface="Bills" />}
        actions={
          <button type="button" className="btn btn--primary" onClick={() => setParam('new', '1')}>
            {t('bills.new')}
          </button>
        }
      />

      {/*
        The header total is the BASE-currency open figure, labelled as such, because that is the figure
        the reconciliation is about. It stays a surface-specific line (not the SurfaceHeader subtitle)
        so its three honest states survive: a skeleton while loading, the verbatim engine figure when
        settled, and NOTHING during an error rather than a plausible `CHF 0.00`.
      */}
      {loading ? (
        <p className="bills-total bills-total--pending" aria-hidden="true">
          <span className="bills-total-skeleton" />
        </p>
      ) : settled ? (
        <p className="bills-total">
          {tRich('bills.headerTotal', {
            total: <span className="t-money">{formatMoney(view.baseTotalOpenMinor, view.baseCurrency)}</span>,
          })}
        </p>
      ) : null}

      <div className="bills-toolbar">
        <div className="bills-filter">
          <span>{t('bills.column.status')}</span>
          <Select
            id="bills-status"
            value={statusParam ?? ''}
            onChange={(value) => setParam('status', value === '' ? null : value)}
            options={[
              { value: '', label: t('bills.filter.allStatuses') },
              ...VENDOR_BILL_STATUSES.map((status) => ({ value: status, label: t(`bills.status.${status}`) })),
            ]}
            ariaLabel={t('bills.column.status')}
          />
        </div>

        <div className="bills-filter">
          <span>{t('bills.vendor')}</span>
          <Select
            id="bills-vendor"
            value={vendorParam ?? ''}
            onChange={(value) => setParam('vendor', value === '' ? null : value)}
            options={[
              { value: '', label: t('bills.filter.allVendors') },
              ...vendorOptions.map((option) => ({ value: option.id, label: option.label })),
            ]}
            ariaLabel={t('bills.vendor')}
          />
        </div>
      </div>

      {/*
        THE RECONCILIATION IS ONLY MEANINGFUL OVER THE WHOLE WORKSPACE, so the band is suppressed on a
        filtered list: comparing a subset to the ledger would report a false mismatch on every filter.
        The engine says which figure its mark is about with `filtered`, and this reads it.
      */}
      {settled && !view.reconciled && !view.filtered && (
        <div className="bills-band" role="status">
          <p>
            {tRich('bills.reconciliation.mismatch', {
              difference: <span className="t-money">{formatMoney(view.reconciliationDifferenceMinor, view.baseCurrency)}</span>,
              list: <span className="t-money">{formatMoney(view.workspaceBaseTotalOpenMinor, view.baseCurrency)}</span>,
              ledger: <span className="t-money">{formatMoney(view.payablesBalanceMinor, view.baseCurrency)}</span>,
            })}
          </p>
          <p className="bills-dim">{t('bills.reconciliation.hint')}</p>
        </div>
      )}

      {/*
        The transport error stays a SURFACE-level banner (its own copy and retry), rendered above the
        table area rather than through DataTable's error slot, so the failed read never falls through
        to DataTable's empty state ("no bills yet") and mislabels a failure as an empty ledger. On a
        failure the table is not mounted, matching the shipped behaviour.
      */}
      {failed && <ErrorBanner message={t('bills.error.transport')} onRetry={() => void load()} />}

      {!failed && (
        <DataTable
          columns={columns}
          rows={view?.bills ?? []}
          rowKey={(bill) => bill.id}
          caption={t('bills.list.caption')}
          onRowClick={(bill) => setParam('bill', bill.id)}
          rowLabel={(bill) => t('bills.rowOpen', { row: rowName(bill) })}
          rowActions={rowActions}
          rowActionsLabel={(bill) => t('bills.rowActionsFor', { row: rowName(bill) })}
          loading={loading}
          skeletonRows={6}
          // A voided bill is DIMMED, not struck through: the row and its reversing entry both survive
          // on purpose (OR 957a). The class joins the base row class; DataTable ships no state CSS.
          rowClassName={(bill) =>
            [bill.status === 'void' ? 'bills-row--void' : '', bill.id === justSavedId ? COMMIT_TARGET_CLASS : '']
              .filter(Boolean)
              .join(' ') || undefined
          }
          emptyState={
            filterActive ? (
              <EmptyState
                title={t('bills.empty.filtered.title')}
                hint={t('bills.empty.filtered.hint')}
                filtered={{
                  onClear: () => setParams(new URLSearchParams()),
                  clearLabel: t('bills.empty.filtered.action'),
                }}
              />
            ) : (
              <EmptyState
                title={t('bills.empty.title')}
                hint={t('bills.empty.hint')}
                action={{ label: t('bills.new'), onClick: () => setParam('new', '1') }}
              />
            )
          }
        />
      )}

      {(creating || selected !== null) && (
        <BillEditor
          bill={selected}
          onClose={closeDrawer}
          onSaved={(billId) => {
            setJustSavedId(billId ?? null);
            void load();
          }}
        />
      )}

    </section>
  );
}
