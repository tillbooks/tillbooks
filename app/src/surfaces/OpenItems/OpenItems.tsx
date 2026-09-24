/**
 * A16, Offene Posten (`/open-items`): D-S1 the OP-Liste, D-S2 the Nach-Kunde tab, and the bands.
 *
 * WHY THIS IS A RAIL ITEM AND NOT A TAB ON BELEGE (owner decision B3). A16 §6's bias was a tab, and
 * it does not hold for three reasons in order of weight. A Guthaben row is NOT a document: the engine
 * builds it from a `payment` with `documentId: null`, and `/documents`'s tab set is a set of document
 * TYPES, so an open-items tab would be the one member that is not a type and that holds objects the
 * other tabs cannot hold. The two surfaces also answer different questions about the same rows,
 * "what did I send" against "what is still owed, and does it tie to 1100", and the second carries an
 * `asOf` cut-off, a bucket partition and a ledger reconciliation that mean nothing on the first. And
 * A16's own spec header says `Axis: sales`, so Verkauf is where it belongs.
 *
 * THIS SURFACE HAS NO PRIMARY ACTION, and that is deliberate rather than unfinished. A16 writes
 * nothing to the ledger, so the accent is spent on the focus ring and the selected tab only, which is
 * exactly the DESIGN.md budget. A surface that invents a primary action to fill a top-right slot is
 * chrome pretending to be a capability. The one accent spend in the whole capability is D-S4's
 * Speichern, and D-S4 is a popover over this surface rather than part of it.
 *
 * THE MAHNSTUFE AND THE BOOKED FEE ARE SHOWN, INLINE, NOT AS A COLUMN (K-29). A15 is landed: the
 * engine returns a real `dunningLevel` (the highest ISSUED level for the document as of the date) and
 * a real `dunningFeeMinor` (the booked Mahngebühr still riding the row, part of `openMinor`). A whole
 * Mahnstufe column would read 0 on most rows of most workspaces and buy an empty column with the
 * table's width, so the level rides the document cell as a word-only chip only WHEN it is non-zero,
 * and the fee rides the Offen cell as a muted "davon Mahngebühr" sub-line only when a fee is booked.
 * Nothing is invented and nothing is summed in the browser: both figures render verbatim from the
 * read verb (finding INV-4's old "A15 is unbuilt" premise is dead, and the comment that stated it
 * was the K-29 defect).
 *
 * WHAT THE ENGINE DOES NOT TELL US, said rather than invented. `list_open_items` carries no
 * permission field of any kind, so the design's "pre-disable the write control with the missing right
 * named inline" is not buildable here: a Studio that read `body.canConfigure` would be reading a
 * field the engine has never sent, which is the exact defect that left three affordances permanently
 * enabled (`canPost`, `canManage`, `canUnlock`, each tested `x !== false`). A denied READ renders the
 * shared padlock panel; a denied WRITE renders its own sentence where the operator attempted it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, useTRich, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { OverflowMenu, type OverflowMenuItem } from '../../components/OverflowMenu';
import { Select } from '../../components/Select';
import { Tabs } from '../../components/Tabs';
import { useCan, CAP } from '../../lib/capabilities';
import { HelpHint } from '../../components/HelpHint';
import { AgingTiles } from './AgingTiles';
import { BucketBoundaries } from './BucketBoundaries';
import { CustomerTable } from './CustomerTable';
import { CalendarGlyph } from './glyphs';
import { ReconciledLine, ReconciliationBand } from './ReconciliationBand';
import {
  customerLabelKey,
  itemsInBucket,
  parkedKindKey,
  parseAging,
  parseOpenItems,
  todayIso,
  type AgingView,
  type OpenItem,
  type OpenItemsView,
} from './model';
import './OpenItems.css';

/** The two URL-backed tabs. `document` is the absence of the parameter, never a second value. */
type Tab = 'document' | 'customer';

export function OpenItems() {
  const t = useT();
  const tRich = useTRich();
  const client = useClient();
  const navigate = useNavigate();
  const workspaceId = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  /**
   * THE PADLOCK (A24, F5 retrofit). The ONE write this surface owns, `set_aging_bucket_config`, is
   * `manage_settings`, so the boundaries editor is absent without it. Everything else here reads.
   */
  const canManageSettings = useCan(CAP.manageSettings);

  const tab: Tab = params.get('by') === 'customer' ? 'customer' : 'document';
  const asOfParam = params.get('asOf');
  const customerParam = params.get('customer');
  const currencyParam = params.get('currency');
  const bucketParam = params.get('bucket');
  const expandedId = params.get('expand');
  const boundariesOpen = params.get('boundaries') === '1';

  const [view, setView] = useState<OpenItemsView | null>(null);
  const [aging, setAging] = useState<AgingView | null>(null);
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

    const asOfInput = asOfParam === null ? {} : { asOf: asOfParam };
    const response =
      tab === 'customer'
        ? await client.call('aging_report', { workspaceId, ...asOfInput })
        : await client.call('list_open_items', {
            workspaceId,
            ...asOfInput,
            ...(customerParam === null ? {} : { customerId: customerParam }),
            ...(currencyParam === null ? {} : { currency: currencyParam }),
          });

    if (isErr(response.body)) {
      // A24: a missing capability is its own state, not an error banner. Only a denied READ is here.
      if (response.body.error === 'permission_denied' || response.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }

    if (tab === 'customer') {
      const parsed = parseAging(response.body);
      if (parsed === null) setFailed(true);
      setAging(parsed);
      setView(null);
    } else {
      const parsed = parseOpenItems(response.body);
      if (parsed === null) setFailed(true);
      setView(parsed);
      setAging(null);
    }
    setLoading(false);
  }, [client, workspaceId, tab, asOfParam, customerParam, currencyParam]);

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

  const resetFilters = useCallback(() => {
    const next = new URLSearchParams(params);
    for (const key of ['customer', 'currency', 'bucket']) next.delete(key);
    setParams(next, { replace: false });
  }, [params, setParams]);

  /** Stable, so the popover's Escape and press-outside listeners are not re-registered per render. */
  const closeBoundaries = useCallback(() => setParam('boundaries', null), [setParam]);

  const visibleItems = useMemo(
    () => (view === null ? [] : itemsInBucket(view.items, bucketParam)),
    [view, bucketParam],
  );

  /** The currency codes offered by the filter, from the rows the engine actually returned. */
  const currencyOptions = useMemo(() => {
    if (view === null) return [];
    return currencyParam === null ? view.currencies : [...new Set([currencyParam, ...view.currencies])].sort();
  }, [view, currencyParam]);

  /**
   * The customers offered by the filter, from the rows the engine actually returned.
   *
   * NARROWING IS A SERVER-SIDE READ, so a filtered answer holds only the chosen customer's rows and
   * the option list collapses to that one customer. That is fine and it is the same trick the
   * currency picker plays: the selected value is folded in so the control can always show what it
   * is set to. What it CANNOT do is name a customer whose filter matched nothing, because no row
   * came back carrying the name. The id is then the only fact in hand, and it is shown as one
   * rather than leaving a blank control over an empty table.
   *
   * Rows with no customer at all are not offered: `?customer=` takes an id, and there is no id to
   * send for them.
   */
  const customerOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const item of view?.items ?? []) {
      if (item.customerId === null) continue;
      const known = byId.get(item.customerId);
      if (known === undefined || known === '') byId.set(item.customerId, item.customerName ?? '');
    }
    if (customerParam !== null && !byId.has(customerParam)) byId.set(customerParam, '');
    return [...byId.entries()]
      .map(([id, name]) => ({ id, label: name === '' ? t('openItems.filter.customerById', { id }) : name }))
      .sort((a, b) => a.label.localeCompare(b.label, 'de-CH'));
  }, [view, customerParam, t]);

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('openItems.error.permissionDenied.read')} />;

  const asOf = view?.asOf ?? aging?.asOf ?? asOfParam ?? '';
  const historical = asOf !== '' && asOf !== todayIso();
  const baseCurrency = view?.baseCurrency ?? aging?.baseCurrency ?? '';
  const total = view?.baseTotalOpenMinor ?? aging?.baseTotalOpenMinor ?? 0;
  const workspaceTotal = view?.workspaceBaseTotalOpenMinor ?? aging?.baseTotalOpenMinor ?? 0;
  const reconciled = view?.reconciled ?? aging?.reconciled ?? false;
  const differenceMinor = view?.reconciliationDifferenceMinor ?? aging?.reconciliationDifferenceMinor ?? 0;
  const ledgerMinor = view?.receivablesBalanceMinor ?? aging?.receivablesBalanceMinor ?? 0;
  const boundaries = view?.boundariesDays ?? aging?.boundariesDays ?? [];
  const filtered = view?.filtered ?? false;
  const settled = !loading && !failed && (view !== null || aging !== null);
  const filterActive = customerParam !== null || currencyParam !== null || bucketParam !== null;

  /**
   * The OP-Liste columns for the shared DataTable (frame overflow, sticky header, density, `.t-num`).
   *
   * NO `<tfoot>` TOTAL ROW, and that is a money-path decision rather than an omission. The one honest
   * aggregate is the BASE-currency total, and it is already rendered verbatim in the header, labelled
   * as a base figure. The "Offen" column shows each row in its OWN currency (a mixed workspace holds
   * francs beside euros), so a column-position total under it would be a face sum that adds francs to
   * euros: exactly the fabrication finding F11 removed and the whole surface polices. Every figure
   * below renders VERBATIM from the read verb via `formatMoney`; nothing is summed in the browser.
   */
  const itemColumns: DataTableColumn<OpenItem>[] = [
    {
      key: 'document',
      header: t('openItems.column.document'),
      render: (item) => {
        const label = item.number ?? t(parkedKindKey(item));
        // The document number is the row's opener: a text link in the ink at 500, underlined on hover
        // (K-12), never the accent on every row. A parked row belongs to no document, so it names its
        // kind as a word and carries no link.
        const primary =
          item.kind === 'document' && item.documentId !== null ? (
            <Link className="oi-doc-link link-inline" to={`/documents/${item.documentId}`}>{label}</Link>
          ) : (
            <span className="oi-chip">{label}</span>
          );
        // The Mahnstufe rides here as a quiet word (K-22: no chip for a word), and ONLY when the
        // document has actually been dunned (level > 0). A "Mahnstufe 0" would imply a dunning
        // decision nothing has made.
        return item.dunningLevel > 0 ? (
          <span className="oi-doc-cell">
            {primary}
            <span className="oi-dunning-chip">{t('openItems.dunningLevel', { level: item.dunningLevel })}</span>
          </span>
        ) : (
          primary
        );
      },
    },
    {
      key: 'customer',
      header: t('openItems.column.customer'),
      render: (item) => {
        const missing = customerLabelKey(item.customerName);
        return missing === null ? (item.customerName ?? '') : t(missing);
      },
    },
    {
      key: 'issueDate',
      header: t('openItems.column.issueDate'),
      render: (item) => (item.issueDate === null ? t('openItems.noDate') : formatDate(item.issueDate)),
    },
    {
      key: 'dueDate',
      header: t('openItems.column.dueDate'),
      render: (item) => (item.dueDate === null ? t('openItems.noDueDate') : formatDate(item.dueDate)),
    },
    {
      key: 'open',
      header: t('openItems.column.open'),
      numeric: true,
      // The row's own currency, never converted here: a EUR row that printed francs would be the
      // whole failure at once. Verbatim from `openMinor`/`currency`. The booked Mahngebühr rides a
      // muted sub-line so the operator can see which part of the open amount is fee (K-29); it is
      // part of `openMinor` already, never added to it here.
      render: (item) => (
        <span className="oi-open-cell">
          {formatMoney(item.openMinor, item.currency)}
          {item.dunningFeeMinor > 0 && (
            <small className="oi-fee-note">
              {t('openItems.dunningFee', { amount: formatMoney(item.dunningFeeMinor, item.currency) })}
            </small>
          )}
        </span>
      ),
    },
    {
      key: 'daysOverdue',
      header: t('openItems.column.daysOverdue'),
      numeric: true,
      render: (item) => (item.overdue ? t('openItems.days', { n: item.daysOverdue }) : t('openItems.noOverdue')),
    },
  ];

  /**
   * The row's one overflow (K-21), through DataTable's `rowActions`. This surface owns NO allocation
   * control (A14 owns the allocator): the action is an entry point that navigates to where the write
   * actually happens. No posting here.
   */
  const itemActions = (item: OpenItem): OverflowMenuItem[] =>
    item.kind === 'on_account' && item.paymentId !== null
      ? [
          {
            key: 'assign',
            label: t('openItems.assignCredit'),
            onSelect: () => navigate(`/payments/new?allocate=${item.paymentId ?? ''}`),
          },
        ]
      : item.documentId !== null
        ? [
            {
              key: 'record',
              label: t('openItems.recordPayment'),
              onSelect: () => navigate(`/documents/${item.documentId ?? ''}`),
            },
          ]
        : [];

  /**
   * The header actions slot for the shared SurfaceHeader: the ONE write A16 owns, the bucket-
   * boundaries popover, still anchored to `.oi-popover-anchor` so it opens under the control that
   * summoned it rather than at the bottom of the surface. Absent without `manage_settings` (A24).
   */
  const headerActions = canManageSettings ? (
    <div className="oi-popover-anchor">
      <OverflowMenu
        label={t('openItems.headerActions')}
        items={[
          {
            key: 'boundaries',
            label: t('openItems.editBoundaries'),
            onSelect: () => setParam('boundaries', '1'),
          },
        ]}
      />
      {boundariesOpen && (
        <BucketBoundaries
          onClose={closeBoundaries}
          onSaved={() => {
            closeBoundaries();
            void load();
          }}
        />
      )}
    </div>
  ) : undefined;

  return (
    <section className="oi" aria-labelledby="oi-title">
      {/*
        THE POPOVER IS ANCHORED IN THE HEADER ACTIONS, beside the control that opens it, and not at
        the bottom of the surface. `.oi-popover-anchor` (built above) is the containing block
        `.oi-popover` positions against, so D-S4 opens under the header overflow where the operator
        is already looking, rather than below the tiles and the entire table.
      */}
      <SurfaceHeader
        title={t('openItems.title')}
        titleId="oi-title"
        help={<SurfaceHelp surface="OpenItems" />}
        actions={headerActions}
      />

      {/*
        The header total is ALWAYS the base-currency figure, labelled as such, because that is the
        figure the reconciliation is about. `totalOpenMinor` is a face sum and is never rendered as a
        headline: in a mixed workspace it adds francs to euros, and in a single-currency one it
        equals the base figure anyway.

        During loading and during an error it renders NOTHING rather than `CHF 0.00`. An unavailable
        figure is an explicit muted state, never a plausible number.
      */}
      <div className="oi-summary">
        {loading ? (
          <p className="oi-total oi-total--pending" aria-hidden="true">
            <span className="oi-total-skeleton" />
          </p>
        ) : settled ? (
          <p className="oi-total oi-money">
            {tRich('openItems.headerTotal', {
              total: <span className="t-money">{formatMoney(total, baseCurrency)}</span>,
            })}
          </p>
        ) : null}
        {settled && reconciled && (
          <ReconciledLine
            filtered={filtered}
            workspaceBaseTotalOpenMinor={workspaceTotal}
            baseCurrency={baseCurrency}
          />
        )}
      </div>

      {/* K-11: the two views of the list are the shared Tabs; the filters and the list are its panel. */}
      <Tabs
        label={t('openItems.title')}
        tabs={[
          { id: 'document', label: t('openItems.tab.byDocument') },
          { id: 'customer', label: t('openItems.tab.byCustomer') },
        ]}
        activeId={tab}
        onChange={(id) => setParam('by', id === 'customer' ? 'customer' : null)}
      >
      <div className="oi-panel">
      <div className="oi-toolbar">
        <div className="oi-filters">
          <label className="oi-filter" htmlFor="oi-as-of">
            <span>{t('openItems.asOf')}</span>
            <input
              id="oi-as-of"
              className="field"
              type="date"
              value={asOfParam ?? asOf}
              onChange={(event) => setParam('asOf', event.target.value === '' ? null : event.target.value)}
            />
          </label>

          {/*
            The Kunde picker, and it renders on the Nach-Beleg tab only, exactly as Währung does.
            `aging_report` takes no `customerId`, so a picker on the Nach-Kunde tab would be a
            control the read cannot honour, and that tab already answers the question per customer.
          */}
          {tab === 'document' && (
            <div className="oi-filter">
              <span>{t('openItems.column.customer')}</span>
              <Select
                id="oi-customer"
                value={customerParam ?? ''}
                onChange={(value) => setParam('customer', value === '' ? null : value)}
                options={[
                  { value: '', label: t('openItems.filter.allCustomers') },
                  ...customerOptions.map((option) => ({ value: option.id, label: option.label })),
                ]}
                ariaLabel={t('openItems.column.customer')}
              />
            </div>
          )}

          {tab === 'document' && (
            <div className="oi-filter">
              <span>{t('openItems.column.currency')}</span>
              <Select
                id="oi-currency"
                value={currencyParam ?? ''}
                onChange={(value) => setParam('currency', value === '' ? null : value)}
                options={[
                  { value: '', label: t('openItems.filter.allCurrencies') },
                  ...currencyOptions.map((code) => ({ value: code, label: code })),
                ]}
                ariaLabel={t('openItems.column.currency')}
              />
            </div>
          )}
        </div>
      </div>

      {historical && (
        <div className="oi-asof-band" role="status">
          <CalendarGlyph className="oi-asof-glyph" />
          <span>{t('openItems.asOfBanner.text', { date: formatDate(asOf) })}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setParam('asOf', null)}>
            {t('openItems.asOfBanner.action')}
          </button>
        </div>
      )}

      {settled && !reconciled && (
        <ReconciliationBand
          differenceMinor={differenceMinor}
          listMinor={workspaceTotal}
          ledgerMinor={ledgerMinor}
          baseCurrency={baseCurrency}
          currencies={view?.currencies ?? []}
        />
      )}

      {failed && <ErrorBanner message={t('openItems.error.transport')} onRetry={() => void load()} />}

      {loading ? (
        <>
          <div className="oi-tiles oi-tiles--pending" role="status" aria-busy="true" aria-live="polite">
            <span className="oi-sr">{t('openItems.loading')}</span>
            {[0, 1, 2, 3].map((n) => (
              <span key={n} className="oi-tile oi-tile--skeleton" />
            ))}
          </div>
          <div className="oi-table-wrap">
            <Skeleton rows={6} />
          </div>
        </>
      ) : failed ? null : tab === 'customer' ? (
        aging === null ? null : aging.byCustomer.length === 0 ? (
          <EmptyState
            title={t('openItems.empty.nothingOpen.title')}
            hint={t('openItems.empty.nothingOpen.hint')}
            action={{ label: t('openItems.empty.nothingOpen.action'), to: '/documents' }}
          />
        ) : (
          <CustomerTable
            rows={aging.byCustomer}
            baseCurrency={aging.baseCurrency}
            asOf={aging.asOf}
            expandedId={expandedId}
            onToggle={(id) => setParam('expand', id)}
          />
        )
      ) : view === null ? null : (
        <>
          {/*
            THE TILES ARE A SUMMARY OF ROWS, so with no rows to summarise they are four `CHF 0.00`
            figures stacked over an empty panel. `bucketTotals` is computed over the FILTERED set,
            so a filter that matched nothing zeroes every tile and the unfiltered figures are simply
            not in the payload.

            The condition is `view.items`, NOT `visibleItems`, and the difference is the whole care
            here: a bucket click that matched nothing leaves rows in the payload, and the tiles are
            then the only way back out of the empty view the operator just created.
          */}
          {view.items.length > 0 && (
            <div className="oi-tile-group">
              {/* K-27: the tiles' own label, left over them, with its help trigger right beside it,
                  instead of a lone question mark 440px away at the right edge. */}
              <div className="oi-tile-head">
                <span className="oi-tile-heading">{t('openItems.tiles.heading')}</span>
                <HelpHint
                  label={t('openItems.tiles.help.label')}
                  title={t('openItems.tiles.help.title')}
                  body={t('openItems.tiles.help.body')}
                />
              </div>
              <AgingTiles
                boundaries={boundaries}
                baseBucketTotals={view.baseBucketTotals}
                baseCurrency={view.baseCurrency}
                items={view.items}
                selected={bucketParam}
                onSelect={(bucket) => setParam('bucket', bucket)}
              />
            </div>
          )}

          {visibleItems.length === 0 ? (
            filterActive ? (
              <EmptyState
                title={t('openItems.empty.filtered.title')}
                hint={t('openItems.empty.filtered.hint')}
                filtered={{ onClear: resetFilters, clearLabel: t('openItems.empty.filtered.action') }}
              />
            ) : (
              <EmptyState
                title={t('openItems.empty.nothingOpen.title')}
                hint={t('openItems.empty.nothingOpen.hint')}
                action={{ label: t('openItems.empty.nothingOpen.action'), to: '/documents' }}
              />
            )
          ) : (
            <DataTable
              columns={itemColumns}
              rows={visibleItems}
              rowKey={(item) => item.documentId ?? item.paymentId ?? ''}
              caption={t('openItems.table.caption')}
              rowActions={itemActions}
              rowActionsLabel={(item) =>
                t('openItems.rowActionsFor', { row: item.number ?? t(parkedKindKey(item)) })
              }
            />
          )}
        </>
      )}
      </div>
      </Tabs>

    </section>
  );
}
