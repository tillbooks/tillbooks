/**
 * D178 point 13: the Übersicht's widgets under the key figures. Each one is a card with all five states:
 * a skeleton in its own shape, an empty state that says what is missing and offers the first step, a
 * read error with "Erneut versuchen", a padlock when the person's role may not read the source, and the
 * figures.
 *
 * WHERE EVERY FIGURE COMES FROM. The charts read ONE `dashboard_series` call (the twelve months ending
 * with the range's month; the top expenses over the same twelve months), whose sums the engine tests
 * against the ledger. The open creditors are A17's `list_vendor_bills`, the open tasks `tasks_list`.
 * Nothing here adds, rounds or reclassifies a figure; the charts only draw what the engine answered.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { formatDate, formatMoney, useI18n } from '../../i18n';
import { EmptyState, ErrorBanner, PermissionDenied, Skeleton, useSkeletonHold } from '../../components/states';
import { InOutBars } from '../../components/charts/InOutBars';
import { Donut } from '../../components/charts/Donut';
import { LineChart } from '../../components/charts/LineChart';
import { RankBars } from '../../components/charts/RankBars';
import { ResultBars } from '../../components/charts/ResultBars';
import { BalanceLines } from '../../components/charts/BalanceLines';
import { HelpHint } from '../../components/HelpHint';
import { Segmented } from '../../components/Segmented';
import { usePref } from '../../lib/prefs';
import type { CompareMode, OverviewWidgetId } from './layout';

// --- the reads ------------------------------------------------------------------------------------

export type Load<T> = { state: 'loading' } | { state: 'error'; denied: boolean } | { state: 'ready'; data: T };

/** One read with its states. `run` answers the raw body; `parse` reads it or answers null (a failed read). */
function useRead<T>(run: (() => Promise<{ body: unknown }>) | null, parse: (body: unknown) => T | null): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (run === null) return undefined;
    let live = true;
    setLoad({ state: 'loading' });
    void run().then(({ body }) => {
      if (!live) return;
      if (isErr(body as never)) {
        setLoad({ state: 'error', denied: (body as { error?: unknown }).error === 'permission_denied' });
        return;
      }
      const data = parse(body);
      setLoad(data === null ? { state: 'error', denied: false } : { state: 'ready', data });
    });
    return () => {
      live = false;
    };
    // `parse` is a module-level function; `run` changes with what it asks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, tick]);
  return [load, useCallback(() => setTick((n) => n + 1), [])];
}

export interface SeriesView {
  from: string;
  to: string;
  currency: string;
  bankAccounts: number;
  months: { month: string; inMinor: number; outMinor: number }[];
  topExpenses: { accountId: string; number: string; name: string; amountMinor: number }[];
  otherExpensesMinor: number;
  /** Σ of the expense accounts with a debit balance: the ring's whole. */
  grossExpenseMinor: number;
  /** Σ of the expense accounts with a credit balance (zero or negative). */
  expenseReductionsMinor: number;
  expenseTotalMinor: number;
  /** D186: the Erfolgsrechnung per month with the same month a year earlier; null from an older engine. */
  result: { month: string; revenueMinor: number; expenseMinor: number; previousYear: { revenueMinor: number; expenseMinor: number } }[] | null;
  /** D186: the bank and the books at each month end; null without the right to read bank lines. */
  balances: { month: string; date: string; bankMinor: number | null; bookedMinor: number }[] | null;
  /** D186: the expenses by vendor; null without the right to read bank lines. */
  topVendors: { name: string; contactId: string | null; amountMinor: number }[] | null;
  otherVendorsMinor: number;
  unattributedExpenseMinor: number;
  /** D186: the parts the engine left out for want of `read_sales` (a padlock, not an empty card). */
  omitted: string[];
}

/** Read the engine's series defensively: a shape this surface cannot read is a failed read. */
export function parseSeries(body: unknown): SeriesView | null {
  const b = body as Partial<SeriesView> | null;
  if (b === null || typeof b !== 'object' || !Array.isArray(b.months) || !Array.isArray(b.topExpenses)) return null;
  if (typeof b.expenseTotalMinor !== 'number' || typeof b.otherExpensesMinor !== 'number') return null;
  return {
    from: String(b.from ?? ''),
    to: String(b.to ?? ''),
    currency: typeof b.currency === 'string' ? b.currency : 'CHF',
    bankAccounts: typeof b.bankAccounts === 'number' ? b.bankAccounts : 0,
    months: b.months,
    topExpenses: b.topExpenses,
    otherExpensesMinor: b.otherExpensesMinor,
    grossExpenseMinor: typeof b.grossExpenseMinor === 'number' ? b.grossExpenseMinor : b.expenseTotalMinor,
    expenseReductionsMinor: typeof b.expenseReductionsMinor === 'number' ? b.expenseReductionsMinor : 0,
    expenseTotalMinor: b.expenseTotalMinor,
    result: Array.isArray(b.result) ? b.result : null,
    balances: Array.isArray(b.balances) ? b.balances : null,
    topVendors: Array.isArray(b.topVendors) ? b.topVendors : null,
    otherVendorsMinor: typeof b.otherVendorsMinor === 'number' ? b.otherVendorsMinor : 0,
    unattributedExpenseMinor: typeof b.unattributedExpenseMinor === 'number' ? b.unattributedExpenseMinor : 0,
    omitted: Array.isArray((b as { omitted?: unknown }).omitted) ? ((b as { omitted: unknown[] }).omitted.filter((x) => typeof x === 'string') as string[]) : [],
  };
}

/** The charts' one read, or null-run when no shown widget needs it. */
export function useSeries(workspaceId: string, span: { from: string; to: string }, needed: boolean): [Load<SeriesView>, () => void] {
  const client = useClient();
  const run = useMemo(
    () => (needed ? () => client.call('dashboard_series', { workspaceId, from: span.from, to: span.to }) : null),
    [client, workspaceId, span.from, span.to, needed],
  );
  return useRead(run, parseSeries);
}

interface BillRow {
  id: string;
  vendorName: string | null;
  dueDate: string | null;
  openMinor: number;
  currency: string;
  overdue: boolean;
  status: string;
}

interface CreditorsView {
  bills: BillRow[];
  totalMinor: number;
  currency: string;
}

function parseCreditors(body: unknown): CreditorsView | null {
  const b = body as { bills?: unknown; baseTotalOpenMinor?: unknown; baseCurrency?: unknown } | null;
  if (b === null || typeof b !== 'object' || !Array.isArray(b.bills)) return null;
  const open = (b.bills as BillRow[])
    .filter((r) => r !== null && typeof r === 'object' && r.status === 'posted' && typeof r.openMinor === 'number' && r.openMinor > 0)
    .sort((x, y) => (x.dueDate ?? '9999').localeCompare(y.dueDate ?? '9999'));
  return {
    bills: open,
    totalMinor: typeof b.baseTotalOpenMinor === 'number' ? b.baseTotalOpenMinor : 0,
    currency: typeof b.baseCurrency === 'string' ? b.baseCurrency : 'CHF',
  };
}

interface TaskRow {
  id: string;
  title: string;
  dueAt: string | null;
  bucket: string;
}

const BUCKET_ORDER: Record<string, number> = { overdue: 0, today: 1, upcoming: 2 };

function parseTasks(body: unknown): TaskRow[] | null {
  const b = body as { tasks?: unknown } | null;
  if (b === null || typeof b !== 'object' || !Array.isArray(b.tasks)) return null;
  return (b.tasks as TaskRow[])
    .filter((r) => r !== null && typeof r === 'object' && typeof r.title === 'string' && r.bucket !== 'done')
    .sort((x, y) => (BUCKET_ORDER[x.bucket] ?? 3) - (BUCKET_ORDER[y.bucket] ?? 3) || (x.dueAt ?? '9999').localeCompare(y.dueAt ?? '9999'));
}

/** How many rows a list widget shows; the link under it opens the whole list. */
const LIST_ROWS = 5;

// --- the card -------------------------------------------------------------------------------------

function WidgetCard({ id, title, caption, info, tools, children }: { id: string; title: string; caption?: string; info?: ReactNode; tools?: ReactNode; children: ReactNode }) {
  const titleId = `uebersicht-widget-${id}`;
  return (
    <section className="panel uebersicht-widget" aria-labelledby={titleId}>
      <header className="uebersicht-widget__head">
        <span className="uebersicht-widget__titlebar">
          <h2 id={titleId} className="uebersicht-widget__title">
            {title}
          </h2>
          {info}
        </span>
        {tools !== undefined || caption !== undefined ? (
          <span className="uebersicht-widget__aside">
            {caption !== undefined ? <span className="uebersicht-asof">{caption}</span> : null}
            {tools}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** The non-success states every widget shares; `null` means "render the data". */
function useStateBody<T>(load: Load<T>, reload: () => void, skeleton: ReactNode): ReactNode | null {
  const { t } = useI18n();
  const showSkeleton = useSkeletonHold(load.state === 'loading');
  if (load.state === 'loading') return showSkeleton ? skeleton : <div className="uebersicht-widget__pending" aria-busy="true" />;
  if (load.state === 'error') {
    return load.denied ? (
      <PermissionDenied body={t('dashboard.widget.denied')} />
    ) : (
      <ErrorBanner context="read" message={t('dashboard.widget.error')} onRetry={reload} />
    );
  }
  return null;
}

// --- month labels ---------------------------------------------------------------------------------

function monthLabels(locale: string, month: string): { label: string; longLabel: string } {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1));
  return {
    label: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(date),
    longLabel: new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date),
  };
}

// --- the widgets ----------------------------------------------------------------------------------

interface SeriesWidgetProps {
  series: Load<SeriesView>;
  reload: () => void;
}

function seriesCaption(series: Load<SeriesView>, t: (k: string, p?: Record<string, string | number>) => string): string | undefined {
  return series.state === 'ready' ? t('dashboard.widget.window', { from: formatDate(series.data.from), to: formatDate(series.data.to) }) : undefined;
}

function ExpenseParts({ series, reload, form }: SeriesWidgetProps & { form: 'donut' | 'bars' }) {
  const { t } = useI18n();
  const state = useStateBody(series, reload, <Skeleton rows={1} height={160} />);
  const id = form === 'donut' ? 'expense_donut' : 'expense_bars';
  // D186: by expense account (default) or by vendor, the person's `overview.expense_by`.
  const [byPref, setBy] = usePref<string>('overview.expense_by');
  const canVendor = series.state === 'ready' && series.data.topVendors !== null;
  const by = byPref === 'vendor' && canVendor ? 'vendor' : 'account';
  let body = state;
  if (body === null && series.state === 'ready') {
    const s = series.data;
    if (s.grossExpenseMinor <= 0) {
      body = <EmptyState title={t('dashboard.widget.expenses.empty')} hint={t('dashboard.widget.expenses.emptyHint')} action={{ label: t('command.post_entry.label'), to: '/journal?new=1' }} />;
    } else {
      const parts =
        by === 'vendor' && s.topVendors !== null
          ? s.topVendors.map((v) => ({ key: v.contactId ?? `name:${v.name}`, label: v.name, valueMinor: v.amountMinor }))
          : s.topExpenses.map((e) => ({ key: e.accountId, label: `${e.number} ${e.name}`, valueMinor: e.amountMinor }));
      if (by === 'vendor') {
        if (s.otherVendorsMinor > 0) parts.push({ key: 'rest', label: t('dashboard.widget.expenses.rest'), valueMinor: s.otherVendorsMinor });
        if (s.unattributedExpenseMinor > 0) parts.push({ key: 'none', label: t('dashboard.widget.expensesBy.unattributed'), valueMinor: s.unattributedExpenseMinor });
      } else if (s.otherExpensesMinor > 0) parts.push({ key: 'rest', label: t('dashboard.widget.expenses.rest'), valueMinor: s.otherExpensesMinor });
      const chart =
        form === 'donut' ? (
          <Donut
            parts={parts.map((p) => (p.key === 'rest' || p.key === 'none' ? { ...p, rest: true } : p))}
            totalMinor={s.grossExpenseMinor}
            currency={s.currency}
            summary={t('dashboard.widget.expenses.summary', { total: formatMoney(s.grossExpenseMinor, s.currency), count: by === 'vendor' ? (s.topVendors?.length ?? 0) : s.topExpenses.length })}
            labels={{
              total: t('dashboard.widget.expenses.total'),
              part: t('dashboard.widget.expenses.account'),
              amount: t('dashboard.widget.amount'),
              share: t('dashboard.widget.expenses.share'),
              table: t('dashboard.widget.asTable'),
            }}
          />
        ) : (
          <RankBars rows={parts} currency={s.currency} label={t('dashboard.widget.expenses.title')} />
        );
      body = chart;
    }
  }
  // B5 (D178): ONE labelled figure on the card; how it is formed, and the expense accounts in credit
  // that are not part of it, sit behind the (i).
  const info =
    series.state === 'ready' && series.data.grossExpenseMinor > 0 ? (
      <HelpHint
        label={t('dashboard.widget.expenses.infoLabel')}
        title={t('dashboard.widget.expenses.infoTitle')}
        body={
          t('dashboard.widget.expenses.info', { gross: formatMoney(series.data.grossExpenseMinor, series.data.currency) }) +
          (series.data.expenseReductionsMinor < 0
            ? `\n\n${t('dashboard.widget.expenses.infoReductions', {
                reductions: formatMoney(series.data.expenseReductionsMinor, series.data.currency),
                net: formatMoney(series.data.expenseTotalMinor, series.data.currency),
              })}`
            : '')
        }
      />
    ) : undefined;
  const switcher = canVendor ? (
    <Segmented
      label={t('dashboard.widget.expensesBy.label')}
      options={[
        { value: 'account', label: t('dashboard.widget.expensesBy.account') },
        { value: 'vendor', label: t('dashboard.widget.expensesBy.vendor') },
      ]}
      value={by}
      onChange={(next) => void setBy(next)}
    />
  ) : undefined;
  return (
    <WidgetCard id={id} title={t('dashboard.widget.expenses.title')} caption={seriesCaption(series, t)} info={info} tools={switcher}>
      {body}
    </WidgetCard>
  );
}

/** D186: turnover and expense per month, the previous year as a tick, the estimate on the last month. */
function RevenueMonths({ series, reload, compare, estimateMinor }: SeriesWidgetProps & { compare: CompareMode; estimateMinor: number }) {
  const { t, locale } = useI18n();
  const state = useStateBody(series, reload, <Skeleton rows={1} height={180} />);
  let body = state;
  if (body === null && series.state === 'ready') {
    const s = series.data;
    const rows = s.result ?? [];
    if (rows.every((m) => m.revenueMinor === 0 && m.expenseMinor === 0)) {
      body = <EmptyState title={t('dashboard.widget.expenses.empty')} hint={t('dashboard.widget.expenses.emptyHint')} action={{ label: t('command.post_entry.label'), to: '/journal?new=1' }} />;
    } else {
      const last = rows.length - 1;
      body = (
        <ResultBars
          points={rows.map((m, i) => ({
            key: m.month,
            ...monthLabels(locale, m.month),
            revenueMinor: m.revenueMinor,
            expenseMinor: m.expenseMinor,
            ...(compare === 'previous_year' ? { previousRevenueMinor: m.previousYear.revenueMinor } : {}),
            ...(i === last && estimateMinor > 0 ? { estimateMinor } : {}),
          }))}
          currency={s.currency}
          summary={t('dashboard.widget.result.summary', {
            revenue: formatMoney(rows.reduce((n, m) => n + m.revenueMinor, 0), s.currency),
            expense: formatMoney(rows.reduce((n, m) => n + m.expenseMinor, 0), s.currency),
          })}
          labels={{
            revenue: t('dashboard.widget.result.revenue'),
            expense: t('dashboard.widget.result.expense'),
            estimate: t('dashboard.widget.result.estimate'),
            previous: t('dashboard.widget.result.previous'),
            period: t('dashboard.widget.month'),
            table: t('dashboard.widget.asTable'),
          }}
        />
      );
    }
  }
  return (
    <WidgetCard id="revenue_months" title={t('dashboard.widget.result.title')} caption={seriesCaption(series, t)}>
      {body}
    </WidgetCard>
  );
}

/** D186: the bank and the books at each month end. */
function BalanceHistory({ series, reload }: SeriesWidgetProps) {
  const { t, locale } = useI18n();
  const state = useStateBody(series, reload, <Skeleton rows={1} height={180} />);
  let body = state;
  if (body === null && series.state === 'ready') {
    const s = series.data;
    if (s.balances === null && s.omitted.includes('balances')) {
      body = <PermissionDenied body={t('dashboard.widget.denied')} />;
    } else if (s.bankAccounts === 0 || s.balances === null || s.balances.length === 0) {
      body = <SeriesEmpty s={s} />;
    } else {
      const latest = s.balances[s.balances.length - 1];
      body = (
        <BalanceLines
          points={s.balances.map((b) => ({ key: b.month, ...monthLabels(locale, b.month), bankMinor: b.bankMinor, bookedMinor: b.bookedMinor }))}
          currency={s.currency}
          summary={
            latest === undefined
              ? ''
              : latest.bankMinor === null
                ? t('dashboard.widget.balance.summaryNoBank', { booked: formatMoney(latest.bookedMinor, s.currency) })
                : t('dashboard.widget.balance.summary', { bank: formatMoney(latest.bankMinor, s.currency), booked: formatMoney(latest.bookedMinor, s.currency) })
          }
          labels={{ bank: t('dashboard.widget.balance.bank'), booked: t('dashboard.widget.balance.booked'), period: t('dashboard.widget.month'), table: t('dashboard.widget.asTable') }}
        />
      );
    }
  }
  return (
    <WidgetCard id="balance_history" title={t('dashboard.widget.balance.title')} caption={seriesCaption(series, t)}>
      {body}
    </WidgetCard>
  );
}

function SeriesEmpty({ s }: { s: SeriesView }) {
  const { t } = useI18n();
  if (s.bankAccounts === 0) {
    return <EmptyState title={t('dashboard.widget.money.noBank')} hint={t('dashboard.widget.money.noBankHint')} action={{ label: t('dashboard.widget.money.addBank'), to: '/bank-accounts' }} />;
  }
  return <EmptyState title={t('dashboard.widget.money.empty')} hint={t('dashboard.widget.money.emptyHint')} action={{ label: t('dashboard.widget.money.toBank'), to: '/bank' }} />;
}

function MoneyInOut({ series, reload }: SeriesWidgetProps) {
  const { t, locale } = useI18n();
  const state = useStateBody(series, reload, <Skeleton rows={1} height={180} />);
  let body = state;
  if (body === null && series.state === 'ready') {
    const s = series.data;
    if (s.bankAccounts === 0 || s.months.every((m) => m.inMinor === 0 && m.outMinor === 0)) {
      body = <SeriesEmpty s={s} />;
    } else {
      body = (
        <InOutBars
          points={s.months.map((m) => ({ key: m.month, ...monthLabels(locale, m.month), inMinor: m.inMinor, outMinor: m.outMinor }))}
          currency={s.currency}
          summary={t('dashboard.widget.money.summary', {
            in: formatMoney(s.months.reduce((n, m) => n + m.inMinor, 0), s.currency),
            out: formatMoney(s.months.reduce((n, m) => n + m.outMinor, 0), s.currency),
          })}
          labels={{ in: t('dashboard.widget.money.in'), out: t('dashboard.widget.money.out'), period: t('dashboard.widget.month'), table: t('dashboard.widget.asTable') }}
        />
      );
    }
  }
  return (
    <WidgetCard id="money_in_out" title={t('dashboard.widget.money.title')} caption={seriesCaption(series, t)}>
      {body}
    </WidgetCard>
  );
}

function CashFlow({ series, reload }: SeriesWidgetProps) {
  const { t, locale } = useI18n();
  const state = useStateBody(series, reload, <Skeleton rows={1} height={180} />);
  let body = state;
  if (body === null && series.state === 'ready') {
    const s = series.data;
    if (s.bankAccounts === 0 || s.months.every((m) => m.inMinor === 0 && m.outMinor === 0)) {
      body = <SeriesEmpty s={s} />;
    } else {
      body = (
        <LineChart
          points={s.months.map((m) => ({ key: m.month, ...monthLabels(locale, m.month), valueMinor: m.inMinor - m.outMinor }))}
          currency={s.currency}
          summary={t('dashboard.widget.cashflow.summary', { net: formatMoney(s.months.reduce((n, m) => n + m.inMinor - m.outMinor, 0), s.currency) })}
          labels={{ period: t('dashboard.widget.month'), value: t('dashboard.widget.cashflow.net'), table: t('dashboard.widget.asTable') }}
        />
      );
    }
  }
  return (
    <WidgetCard id="cash_flow" title={t('dashboard.widget.cashflow.title')} caption={seriesCaption(series, t)}>
      {body}
    </WidgetCard>
  );
}

function OpenCreditors({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const client = useClient();
  const run = useMemo(() => () => client.call('list_vendor_bills', { workspaceId }), [client, workspaceId]);
  const [load, reload] = useRead(run, parseCreditors);
  const state = useStateBody(load, reload, <Skeleton rows={LIST_ROWS} height={24} />);
  let body = state;
  if (body === null && load.state === 'ready') {
    const v = load.data;
    body =
      v.bills.length === 0 ? (
        <EmptyState title={t('dashboard.widget.creditors.empty')} hint={t('dashboard.widget.creditors.emptyHint')} action={{ label: t('dashboard.widget.creditors.capture'), to: '/bills' }} />
      ) : (
        <>
          <ul className="uebersicht-list">
            {v.bills.slice(0, LIST_ROWS).map((b) => (
              <li key={b.id}>
                <Link to={`/bills?bill=${encodeURIComponent(b.id)}`} className="uebersicht-list__name">
                  {b.vendorName ?? t('dashboard.widget.creditors.unnamed')}
                </Link>
                <span className="uebersicht-list__meta">
                  {b.dueDate === null ? '' : b.overdue ? t('dashboard.widget.overdueSince', { date: formatDate(b.dueDate) }) : t('dashboard.widget.dueOn', { date: formatDate(b.dueDate) })}
                </span>
                <span className="uebersicht-list__amount t-money">{formatMoney(b.openMinor, b.currency)}</span>
              </li>
            ))}
          </ul>
          <p className="uebersicht-widget__foot">
            <span>
              {t('dashboard.widget.creditors.total')} <span className="t-money">{formatMoney(v.totalMinor, v.currency)}</span>
            </span>
            <Link to="/bills">{t('dashboard.widget.creditors.all', { count: v.bills.length })}</Link>
          </p>
        </>
      );
  }
  return (
    <WidgetCard id="open_creditors" title={t('dashboard.widget.creditors.title')}>
      {body}
    </WidgetCard>
  );
}

function OpenTasks({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n();
  const client = useClient();
  const run = useMemo(() => () => client.call('tasks_list', { workspaceId }), [client, workspaceId]);
  const [load, reload] = useRead(run, parseTasks);
  const state = useStateBody(load, reload, <Skeleton rows={LIST_ROWS} height={24} />);
  let body = state;
  if (body === null && load.state === 'ready') {
    const rows = load.data;
    body =
      rows.length === 0 ? (
        <EmptyState title={t('dashboard.widget.tasks.empty')} hint={t('dashboard.widget.tasks.emptyHint')} action={{ label: t('dashboard.widget.tasks.create'), to: '/tasks' }} />
      ) : (
        <>
          <ul className="uebersicht-list">
            {rows.slice(0, LIST_ROWS).map((task) => (
              <li key={task.id}>
                <Link to="/tasks" className="uebersicht-list__name">
                  {task.title}
                </Link>
                <span className={task.bucket === 'overdue' ? 'uebersicht-list__meta is-overdue' : 'uebersicht-list__meta'}>
                  {task.dueAt === null ? '' : task.bucket === 'overdue' ? t('dashboard.widget.overdueSince', { date: formatDate(task.dueAt.slice(0, 10)) }) : task.bucket === 'today' ? t('dashboard.widget.tasks.today') : t('dashboard.widget.dueOn', { date: formatDate(task.dueAt.slice(0, 10)) })}
                </span>
              </li>
            ))}
          </ul>
          <p className="uebersicht-widget__foot">
            <span />
            <Link to="/tasks">{t('dashboard.widget.tasks.all', { count: rows.length })}</Link>
          </p>
        </>
      );
  }
  return (
    <WidgetCard id="open_tasks" title={t('dashboard.widget.tasks.title')}>
      {body}
    </WidgetCard>
  );
}

/** Which shown widgets draw from the series read. */
export const SERIES_WIDGETS: ReadonlySet<OverviewWidgetId> = new Set(['expense_donut', 'money_in_out', 'cash_flow', 'expense_bars', 'revenue_months', 'balance_history']);

/** One widget by id. */
export function OverviewWidget({
  id,
  workspaceId,
  series,
  reloadSeries,
  compare = 'previous_year',
  estimateMinor = 0,
}: {
  id: OverviewWidgetId;
  workspaceId: string;
  series: Load<SeriesView>;
  reloadSeries: () => void;
  compare?: CompareMode;
  estimateMinor?: number;
}) {
  switch (id) {
    case 'revenue_months':
      return <RevenueMonths series={series} reload={reloadSeries} compare={compare} estimateMinor={estimateMinor} />;
    case 'balance_history':
      return <BalanceHistory series={series} reload={reloadSeries} />;
    case 'expense_donut':
      return <ExpenseParts series={series} reload={reloadSeries} form="donut" />;
    case 'expense_bars':
      return <ExpenseParts series={series} reload={reloadSeries} form="bars" />;
    case 'money_in_out':
      return <MoneyInOut series={series} reload={reloadSeries} />;
    case 'cash_flow':
      return <CashFlow series={series} reload={reloadSeries} />;
    case 'open_creditors':
      return <OpenCreditors workspaceId={workspaceId} />;
    case 'open_tasks':
      return <OpenTasks workspaceId={workspaceId} />;
    default:
      return null;
  }
}
