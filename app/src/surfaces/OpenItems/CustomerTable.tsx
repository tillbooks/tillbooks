/**
 * D-S2, the Nach-Kunde tab, and D-S3, the customer row expanded.
 *
 * WHY THIS TAB EXISTS (INV-2). `list_open_items` has NO row ceiling: at a thousand open items it
 * returns a thousand. Nobody works a thousand-row OP-Liste top to bottom, and an at-scale answer of
 * "it virtualises" has not answered the question. `aging_report.byCustomer` collapses the axis to one
 * row per customer, largest debtor first, which is the shape of the question anyone actually asks. A
 * thousand items across a Swiss SME's customer base is tens of rows.
 *
 * THE COLUMN IS "LÄNGSTE ÜBERFÄLLIGKEIT", NOT "ÄLTESTER VERZUG". Verzug is an OR Art. 102 fact that
 * belongs to A15, and a rule with an exception that the design itself breaks is a rule a builder will
 * ignore, so the word appears nowhere on this surface. `oldestOverdueDays` is a count of days past a
 * due date and the column says exactly that, without borrowing a legal term.
 *
 * THE EXPANSION AFFORDANCE IS THE SHIPPED CHEVRON, in the same shape `Payments.tsx` uses for its own
 * expandable rows, with the expanded row rendered as a sibling `<tr>` carrying a `colSpan` cell.
 *
 * ZUWEISEN HANGS OFF EACH PARKED ROW, NEVER OFF THE AGGREGATE. `customer_balance` returns `items`,
 * which may hold several parked rows with different `paymentId`s, and `/payments/new?allocate=<id>` takes
 * exactly one. One button on an aggregate could not say which payment it opens, so the aggregate
 * figure is a figure and the action sits where the id is unambiguous.
 *
 * THE ROW THAT BELONGS TO NOBODY has NO expand control at all: `customer_balance` requires a customer
 * id, so there is nothing to expand to, and an expander that opens an empty panel is the dead end the
 * canon names first. No shipped write verb can produce such a row today, and the branch is here
 * because the read model types it, not because a workspace has one.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { ErrorBanner, Skeleton } from '../../components/states';
import { ChevronGlyph } from './glyphs';
import {
  customerLabelKey,
  onAccountNoteKey,
  parkedKindKey,
  parseCustomerBalance,
  type CustomerAging,
  type CustomerBalanceView,
  type OpenItem,
} from './model';

export interface CustomerTableProps {
  rows: readonly CustomerAging[];
  baseCurrency: string;
  asOf: string;
  /** The customer whose row is expanded, from `?expand=`, or null. */
  expandedId: string | null;
  onToggle: (customerId: string | null) => void;
}

export function CustomerTable({ rows, baseCurrency, asOf, expandedId, onToggle }: CustomerTableProps) {
  const t = useT();
  return (
    <div className="oi-table-wrap">
      <table className="oi-table">
        <thead>
          <tr>
            <th scope="col">{t('openItems.column.customer')}</th>
            <th scope="col" className="oi-num">
              {t('openItems.column.itemCount')}
            </th>
            <th scope="col" className="oi-num">
              {t('openItems.column.oldestOverdue')}
            </th>
            <th scope="col" className="oi-num">
              {t('openItems.column.open')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <CustomerRow
              key={row.customerId ?? 'none'}
              row={row}
              baseCurrency={baseCurrency}
              asOf={asOf}
              expanded={row.customerId !== null && expandedId === row.customerId}
              onToggle={() =>
                onToggle(row.customerId !== null && expandedId === row.customerId ? null : row.customerId)
              }
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface CustomerRowProps {
  row: CustomerAging;
  baseCurrency: string;
  asOf: string;
  expanded: boolean;
  onToggle: () => void;
}

function CustomerRow({ row, baseCurrency, asOf, expanded, onToggle }: CustomerRowProps) {
  const t = useT();
  const missing = customerLabelKey(row.customerName);
  const name = missing === null ? (row.customerName ?? '') : t(missing);

  return (
    <>
      <tr>
        <th scope="row" className="oi-customer-cell">
          {/* No expand control at all when there is no id: `customer_balance` has nothing to open. */}
          {row.customerId === null ? (
            <span className="oi-customer-name">{name}</span>
          ) : (
            <button
              type="button"
              className={`oi-expander${expanded ? ' oi-expander--on' : ''}`}
              aria-expanded={expanded}
              onClick={onToggle}
            >
              <ChevronGlyph className="oi-expander-glyph" />
              <span className="oi-customer-name">{name}</span>
            </button>
          )}
        </th>
        <td className="oi-num">{row.openItemCount}</td>
        <td className="oi-num">
          {row.oldestOverdueDays === 0 ? t('openItems.noOverdue') : t('openItems.days', { n: row.oldestOverdueDays })}
        </td>
        <td className="oi-num oi-money t-money">{formatMoney(row.baseTotalOpenMinor, baseCurrency)}</td>
      </tr>
      {expanded && row.customerId !== null && (
        <tr className="oi-expansion-row">
          <td colSpan={4}>
            <CustomerBalancePanel customerId={row.customerId} asOf={asOf} />
          </td>
        </tr>
      )}
    </>
  );
}

/** D-S3: one customer's items and their signed parked position, read from `customer_balance`. */
function CustomerBalancePanel({ customerId, asOf }: { customerId: string; asOf: string }) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [view, setView] = useState<CustomerBalanceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    const response = await client.call('customer_balance', { workspaceId, customerId, asOf });
    if (isErr(response.body)) {
      setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseCustomerBalance(response.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setView(parsed);
    setLoading(false);
  }, [client, workspaceId, customerId, asOf]);

  useEffect(() => {
    void load();
  }, [load]);

  // The nested items table, on the shared DataTable (frame overflow, sticky header, density). The
  // panel above owns loading/error/empty, so this renders only settled rows. Every figure comes
  // VERBATIM from `customer_balance` via `formatMoney`; nothing is summed in the browser.
  const itemColumns: DataTableColumn<OpenItem>[] = [
    {
      key: 'document',
      header: t('openItems.column.document'),
      render: (item) =>
        item.kind === 'document' && item.documentId !== null ? (
          <Link className="oi-doc-link link-inline" to={`/documents/${item.documentId}`}>{item.number ?? ''}</Link>
        ) : (
          <span className="oi-chip">{t(parkedKindKey(item))}</span>
        ),
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
      render: (item) => formatMoney(item.openMinor, item.currency),
    },
    {
      key: 'actions',
      header: t('openItems.rowActions'),
      headerHidden: true,
      // Zuweisen hangs off each parked row (never an aggregate): `/payments/new?allocate=<id>` takes
      // exactly one payment id. This surface performs no allocation; it navigates to where it happens.
      render: (item) =>
        item.kind === 'on_account' && item.paymentId !== null ? (
          <Link className="btn btn--ghost btn--sm" to={`/payments/new?allocate=${item.paymentId}`}>
            {t('openItems.assignCredit')}
          </Link>
        ) : null,
    },
  ];

  if (loading) return <Skeleton rows={3} />;
  if (failed || view === null) {
    return <ErrorBanner message={t('openItems.error.transport')} onRetry={() => void load()} />;
  }

  return (
    <div className="oi-expansion">
      <dl className="oi-figures">
        <div className="oi-figure">
          <dt>{t('openItems.balance.total')}</dt>
          <dd className="oi-money t-money">{formatMoney(view.baseTotalOpenMinor, view.baseCurrency)}</dd>
        </div>
        {view.onAccountMinor !== 0 && (
          <div className="oi-figure">
            <dt>
              {view.onAccountMinor > 0
                ? t('openItems.kind.onAccount.credit')
                : t('openItems.kind.onAccount.refund')}
            </dt>
            <dd className="oi-money">
              <span className="t-money">{formatMoney(Math.abs(view.onAccountMinor), view.baseCurrency)}</span>{' '}
              {/* The parenthetical is what stops the pair reading as a contradiction: without it an
                  operator sees a second figure beside a total and cannot tell whether it is counted.
                  The two signs contribute in opposite directions, so they get two sentences. */}
              <span className="oi-figure-note">({t(onAccountNoteKey(view.onAccountMinor))})</span>
            </dd>
          </div>
        )}
        <div className="oi-figure">
          <dt>{t('openItems.column.oldestOverdue')}</dt>
          <dd>
            {view.oldestOverdueDays === 0
              ? t('openItems.noOverdue')
              : t('openItems.days', { n: view.oldestOverdueDays })}
          </dd>
        </div>
      </dl>

      <DataTable
        columns={itemColumns}
        rows={view.items}
        rowKey={(item) => item.documentId ?? item.paymentId ?? ''}
        caption={t('openItems.balance.itemsCaption')}
      />
    </div>
  );
}
