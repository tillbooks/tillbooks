/**
 * H09, Fixed Assets -> Reports (`/asset-reports`): the READ-ONLY reporting lens over the whole
 * fixed-asset cluster (H00-H08). One surface, a tab per standard report:
 *
 *   Register (US-H09.1)      the filterable register + totals footer
 *   Forecast (US-H09.2)      a multi-period depreciation projection
 *   Disposals (US-H09.4)     the gain/loss pack for a date range
 *   Acquisitions (US-H09.5)  what was capitalised in a range
 *   NBV by dimension (US-H09.7)
 *   End of life (US-H09.8)   assets fully depreciated or approaching residual
 *
 * Each tab drives one pure MCP read verb and renders the shared DataTable with a totals footer (D118
 * B2). Every figure renders VERBATIM from the read verb; nothing is recomputed here. This surface
 * POSTS NOTHING; `whoami` is not consulted (the engine is the real gate, the standing Studio rule) and
 * the reports fail open to an error banner with retry. The tab strip is the shared Tabs primitive; a
 * panel loads its report ONLY while selected (its component mounts when the tab activates), so the six
 * reads are not fired at once. Reconciliation and per-asset history are their own H07 surfaces.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { Select } from '../../components/Select';
import { useWorkspaceId } from '../../app/workspace';
import { formatDate, formatMoney, useT } from '../../i18n';
import { useCalendarFormat } from '../../lib/format';
import { Status } from '../../components/Status';
import { assetStatusKind } from './AssetRegister';
import { EmptyState, ErrorBanner, NoWorkspaceState } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { DataTable, type DataTableColumn, type DataTableFooterCell } from '../../components/DataTable';
import { Tabs } from '../../components/Tabs';
import './FixedAssets.css';

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
// K-71: format through the shared `formatMoney` so de-CH thousands grouping is applied once, in one
// place. These asset reports are kept in the workspace base currency and carry no per-row currency,
// so the base (CHF) is passed explicitly rather than assumed inside the formatter.
const money = (rappen: number): string => formatMoney(rappen, 'CHF');

/** A report row is an untyped read-model record; the column renderers pull fields by name. */
type Row = Record<string, unknown>;

type ReportTab = 'register' | 'forecast' | 'disposals' | 'acquisitions' | 'nbv' | 'endOfLife';
const TABS: ReportTab[] = ['register', 'forecast', 'disposals', 'acquisitions', 'nbv', 'endOfLife'];

/** This month `YYYY-MM`, the forecast selector's default from. */
const thisPeriod = (): string => new Date().toISOString().slice(0, 7);
/** `n` months forward of a `YYYY-MM`. */
function addMonths(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const yearStart = (): string => `${new Date().getUTCFullYear()}-01-01`;
const yearEnd = (): string => `${new Date().getUTCFullYear()}-12-31`;

/**
 * K-16: a report's filters apply live, 250ms after the last change (the Journal's rhythm), where each
 * tab used to need a solid "Anwenden" click. The value settles only when its CONTENT changes, so a
 * fresh object with the same fields never re-reads the report.
 */
const FILTER_DEBOUNCE_MS = 250;
function useSettled<T>(value: T): T {
  const key = JSON.stringify(value);
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => {
      setSettled((prev) => (JSON.stringify(prev) === key ? prev : value));
    }, FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
    // Keyed on the serialised content: `value` itself is a fresh object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return settled;
}

/** A tiny hook: run an MCP read verb with a params builder, exposing { data, loading, failed, reload }. */
function useReport<T>(
  verb: string,
  buildParams: () => Record<string, unknown>,
  parse: (body: unknown) => T | null,
  deps: unknown[],
) {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    const res = await client.call(verb, { workspaceId, ...buildParams() });
    if (isErr(res.body)) {
      setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parse(res.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setData(parsed);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId, verb, ...deps]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, failed, reload: load, workspaceId };
}

function rowsOf(body: unknown, key: string): Row[] {
  const o = body as Record<string, unknown>;
  const raw = o !== null && typeof o === 'object' ? o[key] : undefined;
  return Array.isArray(raw) ? raw.filter((r): r is Row => r !== null && typeof r === 'object') : [];
}

/**
 * A report body: the filter row, then the shared DataTable which owns loading, empty, error and the
 * frame. `failed` renders the error banner above the table; the table then shows nothing while data
 * is null. Keeps every report's shape identical.
 */
function ReportBody({
  filters,
  failed,
  onRetry,
  errorMessage,
  loading,
  columns,
  rows,
  rowKey,
  footer,
  emptyTitle,
  emptyHint,
}: {
  filters: ReactNode;
  failed: boolean;
  onRetry: () => void;
  errorMessage: string;
  loading: boolean;
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey: (r: Row) => string;
  footer?: DataTableFooterCell[];
  emptyTitle: string;
  emptyHint: string;
}) {
  return (
    <>
      {filters}
      {failed && <ErrorBanner message={errorMessage} onRetry={onRetry} />}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={rowKey}
        loading={loading}
        footer={rows.length > 0 ? footer : undefined}
        emptyState={<EmptyState title={emptyTitle} hint={emptyHint} />}
      />
    </>
  );
}

// --- Register --------------------------------------------------------------------------------------

function RegisterReport() {
  const t = useT();
  const [q, setQ] = useState('');
  const applied = useSettled(q.trim());
  const { data, loading, failed, reload } = useReport(
    'asset_register_report',
    () => ({ filter: applied.length > 0 ? { q: applied } : {}, limit: 500 }),
    (body) => ({ rows: rowsOf(body, 'rows'), totals: (body as Record<string, unknown>).totals ?? {}, message: str((body as Record<string, unknown>).message) }),
    [applied],
  );
  const totals = (data?.totals ?? {}) as Record<string, unknown>;
  const columns: DataTableColumn<Row>[] = [
    { key: 'number', header: t('assets.reports.register.col.number'), render: (r) => <span className="fa-code">{str(r.number)}</span> },
    { key: 'name', header: t('assets.reports.register.col.name'), render: (r) => str(r.name) },
    { key: 'category', header: t('assets.reports.register.col.category'), render: (r) => str(r.categoryCode) },
    {
      key: 'status',
      header: t('assets.reports.register.col.status'),
      render: (r) => (
        <Status kind={assetStatusKind(str(r.status) || 'draft')} label={t(`assets.reports.status.${str(r.status)}`)} />
      ),
    },
    { key: 'cost', header: t('assets.reports.register.col.cost'), numeric: true, render: (r) => money(num(r.acquisitionCostRappen)) },
    { key: 'accum', header: t('assets.reports.register.col.accum'), numeric: true, render: (r) => money(num(r.accumulatedDeprRappen)) },
    { key: 'nbv', header: t('assets.reports.register.col.nbv'), numeric: true, render: (r) => money(num(r.netBookValueRappen)) },
  ];
  return (
    <ReportBody
      filters={
        <div className="fa-filters">
          <label htmlFor="fa-rep-q">{t('assets.reports.register.search')}</label>
          <input className="field"
            id="fa-rep-q"
            type="search"
            value={q}
            placeholder={t('assets.reports.register.searchHint')}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      }
      failed={failed}
      onRetry={() => void reload()}
      errorMessage={t('assets.reports.error.transport')}
      loading={loading}
      columns={columns}
      rows={data?.rows ?? []}
      rowKey={(r) => str(r.id)}
      footer={[
        { key: 'number', content: t('assets.reports.register.totals', { count: String(num(totals.count)) }) },
        { key: 'cost', content: money(num(totals.costRappen)) },
        { key: 'accum', content: money(num(totals.accumRappen)) },
        { key: 'nbv', content: money(num(totals.nbvRappen)) },
      ]}
      emptyTitle={t('assets.reports.empty.title')}
      emptyHint={t('assets.reports.empty.hint')}
    />
  );
}

// --- Forecast --------------------------------------------------------------------------------------

function ForecastReport() {
  const t = useT();
  const cal = useCalendarFormat();
  const [from, setFrom] = useState(thisPeriod());
  const [to, setTo] = useState(addMonths(thisPeriod(), 11));
  const [groupBy, setGroupBy] = useState('none');
  const applied = useSettled({ from, to, groupBy });
  const { data, loading, failed, reload } = useReport(
    'asset_depreciation_forecast',
    () => ({ fromPeriod: applied.from, toPeriod: applied.to, groupBy: applied.groupBy }),
    (body) => ({
      periods: rowsOf(body, 'periods'),
      total: num((body as Record<string, unknown>).totalProjectedRappen),
      reaching: num((body as Record<string, unknown>).assetsReachingResidual),
      warnings: Array.isArray((body as Record<string, unknown>).warnings) ? ((body as Record<string, unknown>).warnings as string[]) : [],
    }),
    [applied],
  );
  const columns: DataTableColumn<Row>[] = [
    { key: 'period', header: t('assets.reports.forecast.col.period'), render: (r) => cal.month(str(r.period)) },
    { key: 'amount', header: t('assets.reports.forecast.col.amount'), numeric: true, render: (r) => money(num(r.totalAmountRappen)) },
  ];
  return (
    <>
      <div className="fa-filters">
        <label htmlFor="fa-fc-from">{t('assets.reports.forecast.from')}</label>
        <input className="field" id="fa-fc-from" type="month" value={from} onChange={(e) => setFrom(e.target.value)} />
        <label htmlFor="fa-fc-to">{t('assets.reports.forecast.to')}</label>
        <input className="field" id="fa-fc-to" type="month" value={to} onChange={(e) => setTo(e.target.value)} />
        <label htmlFor="fa-fc-group">{t('assets.reports.forecast.groupBy')}</label>
        <Select
          id="fa-fc-group"
          value={groupBy}
          onChange={(value) => setGroupBy(value)}
          options={[
            { value: 'none', label: t('assets.reports.forecast.group.none') },
            { value: 'category', label: t('assets.reports.forecast.group.category') },
            { value: 'location', label: t('assets.reports.forecast.group.location') },
          ]}
          ariaLabel={t('assets.reports.forecast.groupBy')}
        />
      </div>
      {(data?.warnings ?? []).includes('production_data_required') && (
        <div className="fa-note" role="status">
          {t('assets.reports.forecast.productionDataRequired')}
        </div>
      )}
      {failed && <ErrorBanner message={t('assets.reports.forecast.invalidPeriodRange')} onRetry={() => void reload()} />}
      {(data?.periods.length ?? 0) > 0 && !loading && (
        <p className="fa-hint">
          {t('assets.reports.forecast.summary', {
            total: money(num(data?.total)),
            reaching: String(num(data?.reaching)),
          })}
        </p>
      )}
      <DataTable
        columns={columns}
        rows={data?.periods ?? []}
        rowKey={(r) => str(r.period)}
        loading={loading}
        footer={
          (data?.periods.length ?? 0) > 0
            ? [{ key: 'amount', content: money(num(data?.total)) }]
            : undefined
        }
        emptyState={<EmptyState title={t('assets.reports.empty.title')} hint={t('assets.reports.forecast.emptyHint')} />}
      />
    </>
  );
}

// --- Disposals -------------------------------------------------------------------------------------

function DisposalsReport() {
  const t = useT();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(yearEnd());
  const applied = useSettled({ from, to });
  const { data, loading, failed, reload } = useReport(
    'asset_disposal_summary',
    () => ({ fromDate: applied.from, toDate: applied.to }),
    (body) => ({ disposals: rowsOf(body, 'disposals'), totals: (body as Record<string, unknown>).totals ?? {} }),
    [applied],
  );
  const totals = (data?.totals ?? {}) as Record<string, unknown>;
  const columns: DataTableColumn<Row>[] = [
    {
      key: 'asset',
      header: t('assets.reports.disposals.col.asset'),
      render: (r) => (
        <>
          <span className="fa-code">{str(r.assetNumber)}</span> {str(r.name)}
        </>
      ),
    },
    { key: 'date', header: t('assets.reports.disposals.col.date'), render: (r) => formatDate(str(r.disposalDate)) },
    { key: 'nbv', header: t('assets.reports.disposals.col.nbv'), numeric: true, render: (r) => money(num(r.nbvAtDisposalRappen)) },
    { key: 'proceeds', header: t('assets.reports.disposals.col.proceeds'), numeric: true, render: (r) => money(num(r.proceedsRappen)) },
    {
      key: 'gainLoss',
      header: t('assets.reports.disposals.col.gainLoss'),
      numeric: true,
      render: (r) => {
        const gl = num(r.gainLossRappen);
        return <span className={gl > 0 ? 'fa-gain' : gl < 0 ? 'fa-loss' : undefined}>{money(gl)}</span>;
      },
    },
  ];
  return (
    <ReportBody
      filters={
        <div className="fa-filters">
          <label htmlFor="fa-dp-from">{t('assets.reports.range.from')}</label>
          <input className="field" id="fa-dp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <label htmlFor="fa-dp-to">{t('assets.reports.range.to')}</label>
          <input className="field" id="fa-dp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      }
      failed={failed}
      onRetry={() => void reload()}
      errorMessage={t('assets.reports.error.transport')}
      loading={loading}
      columns={columns}
      rows={data?.disposals ?? []}
      rowKey={(r) => str(r.transactionId)}
      footer={[
        { key: 'asset', content: t('assets.reports.disposals.totals', { count: String(num(totals.count)) }) },
        { key: 'proceeds', content: money(num(totals.proceedsRappen)) },
        {
          key: 'gainLoss',
          content: (
            <span className={num(totals.netGainLossRappen) >= 0 ? 'fa-gain' : 'fa-loss'}>
              {money(num(totals.netGainLossRappen))}
            </span>
          ),
        },
      ]}
      emptyTitle={t('assets.reports.disposals.emptyTitle')}
      emptyHint={t('assets.reports.disposals.emptyHint')}
    />
  );
}

// --- Acquisitions ----------------------------------------------------------------------------------

function AcquisitionsReport() {
  const t = useT();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(yearEnd());
  const applied = useSettled({ from, to });
  const { data, loading, failed, reload } = useReport(
    'asset_acquisition_summary',
    () => ({ fromDate: applied.from, toDate: applied.to }),
    (body) => ({ acquisitions: rowsOf(body, 'acquisitions'), totals: (body as Record<string, unknown>).totals ?? {} }),
    [applied],
  );
  const totals = (data?.totals ?? {}) as Record<string, unknown>;
  const columns: DataTableColumn<Row>[] = [
    {
      key: 'asset',
      header: t('assets.reports.acquisitions.col.asset'),
      render: (r) => (
        <>
          <span className="fa-code">{str(r.assetNumber)}</span> {str(r.name)}
        </>
      ),
    },
    { key: 'date', header: t('assets.reports.acquisitions.col.date'), render: (r) => formatDate(str(r.acquisitionDate)) },
    { key: 'category', header: t('assets.reports.acquisitions.col.category'), render: (r) => str(r.categoryCode) },
    { key: 'source', header: t('assets.reports.acquisitions.col.source'), render: (r) => t(`assets.reports.acquisitions.source.${str(r.source)}`) },
    { key: 'cost', header: t('assets.reports.acquisitions.col.cost'), numeric: true, render: (r) => money(num(r.costRappen)) },
  ];
  return (
    <ReportBody
      filters={
        <div className="fa-filters">
          <label htmlFor="fa-ac-from">{t('assets.reports.range.from')}</label>
          <input className="field" id="fa-ac-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <label htmlFor="fa-ac-to">{t('assets.reports.range.to')}</label>
          <input className="field" id="fa-ac-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      }
      failed={failed}
      onRetry={() => void reload()}
      errorMessage={t('assets.reports.error.transport')}
      loading={loading}
      columns={columns}
      rows={data?.acquisitions ?? []}
      rowKey={(r) => str(r.transactionId)}
      footer={[
        { key: 'asset', content: t('assets.reports.acquisitions.totals', { count: String(num(totals.count)) }) },
        { key: 'cost', content: money(num(totals.costRappen)) },
      ]}
      emptyTitle={t('assets.reports.acquisitions.emptyTitle')}
      emptyHint={t('assets.reports.acquisitions.emptyHint')}
    />
  );
}

// --- NBV by dimension ------------------------------------------------------------------------------

function NbvReport() {
  const t = useT();
  const [groupBy, setGroupBy] = useState('category');
  const applied = useSettled(groupBy);
  const { data, loading, failed, reload } = useReport(
    'asset_nbv_summary',
    () => ({ groupBy: applied }),
    (body) => ({ groups: rowsOf(body, 'groups'), grandTotal: (body as Record<string, unknown>).grandTotal ?? {} }),
    [applied],
  );
  const total = (data?.grandTotal ?? {}) as Record<string, unknown>;
  const columns: DataTableColumn<Row>[] = [
    { key: 'group', header: t('assets.reports.nbv.col.group'), render: (r) => str(r.key) },
    { key: 'count', header: t('assets.reports.nbv.col.count'), numeric: true, render: (r) => num(r.count) },
    { key: 'cost', header: t('assets.reports.nbv.col.cost'), numeric: true, render: (r) => money(num(r.sumCostRappen)) },
    { key: 'accum', header: t('assets.reports.nbv.col.accum'), numeric: true, render: (r) => money(num(r.sumAccumRappen)) },
    { key: 'nbv', header: t('assets.reports.nbv.col.nbv'), numeric: true, render: (r) => money(num(r.sumNbvRappen)) },
  ];
  return (
    <ReportBody
      filters={
        <div className="fa-filters">
          <label htmlFor="fa-nbv-group">{t('assets.reports.nbv.groupBy')}</label>
          <Select
            id="fa-nbv-group"
            value={groupBy}
            onChange={(value) => setGroupBy(value)}
            options={[
              { value: 'category', label: t('assets.reports.nbv.group.category') },
              { value: 'location', label: t('assets.reports.nbv.group.location') },
              { value: 'status', label: t('assets.reports.nbv.group.status') },
              { value: 'method', label: t('assets.reports.nbv.group.method') },
            ]}
            ariaLabel={t('assets.reports.nbv.groupBy')}
          />
        </div>
      }
      failed={failed}
      onRetry={() => void reload()}
      errorMessage={t('assets.reports.error.transport')}
      loading={loading}
      columns={columns}
      rows={data?.groups ?? []}
      rowKey={(r) => str(r.key)}
      footer={[
        { key: 'group', content: t('assets.reports.nbv.totalLabel') },
        { key: 'count', content: num(total.count) },
        { key: 'cost', content: money(num(total.sumCostRappen)) },
        { key: 'accum', content: money(num(total.sumAccumRappen)) },
        { key: 'nbv', content: money(num(total.sumNbvRappen)) },
      ]}
      emptyTitle={t('assets.reports.empty.title')}
      emptyHint={t('assets.reports.empty.hint')}
    />
  );
}

// --- End of life -----------------------------------------------------------------------------------

function EndOfLifeReport() {
  const t = useT();
  const [months, setMonths] = useState('12');
  const [status, setStatus] = useState('approaching');
  const applied = useSettled({ months, status });
  const { data, loading, failed, reload } = useReport(
    'asset_end_of_life_list',
    () =>
      applied.status === 'fully_depreciated'
        ? { status: 'fully_depreciated' }
        : { status: 'approaching', withinMonths: Number(applied.months) || 12 },
    (body) => ({ assets: rowsOf(body, 'assets'), mode: str((body as Record<string, unknown>).mode) }),
    [applied],
  );
  const approaching = data?.mode === 'approaching';
  const columns: DataTableColumn<Row>[] = [
    {
      key: 'asset',
      header: t('assets.reports.endOfLife.col.asset'),
      render: (r) => (
        <>
          <span className="fa-code">{str(r.number)}</span> {str(r.name)}
        </>
      ),
    },
    { key: 'nbv', header: t('assets.reports.endOfLife.col.nbv'), numeric: true, render: (r) => money(num(r.netBookValueRappen)) },
    ...(approaching
      ? ([
          { key: 'remaining', header: t('assets.reports.endOfLife.col.remaining'), numeric: true, render: (r: Row) => num(r.remainingMonths) },
          { key: 'next', header: t('assets.reports.endOfLife.col.next'), numeric: true, render: (r: Row) => money(num(r.nextDepreciationRappen)) },
        ] as DataTableColumn<Row>[])
      : []),
  ];
  return (
    <ReportBody
      filters={
        <div className="fa-filters">
          <label htmlFor="fa-eol-status">{t('assets.reports.endOfLife.mode')}</label>
          <Select
            id="fa-eol-status"
            value={status}
            onChange={(value) => setStatus(value)}
            options={[
              { value: 'approaching', label: t('assets.reports.endOfLife.approaching') },
              { value: 'fully_depreciated', label: t('assets.reports.endOfLife.fullyDepreciated') },
            ]}
            ariaLabel={t('assets.reports.endOfLife.mode')}
          />
          {status === 'approaching' && (
            <>
              <label htmlFor="fa-eol-months">{t('assets.reports.endOfLife.withinMonths')}</label>
              <input className="field" id="fa-eol-months" type="number" min={1} max={60} value={months} onChange={(e) => setMonths(e.target.value)} />
            </>
          )}
        </div>
      }
      failed={failed}
      onRetry={() => void reload()}
      errorMessage={t('assets.reports.error.transport')}
      loading={loading}
      columns={columns}
      rows={data?.assets ?? []}
      rowKey={(r) => str(r.assetId)}
      emptyTitle={t('assets.reports.endOfLife.emptyTitle')}
      emptyHint={t('assets.reports.endOfLife.emptyHint')}
    />
  );
}

const RENDERERS: Record<ReportTab, () => ReactElement> = {
  register: RegisterReport,
  forecast: ForecastReport,
  disposals: DisposalsReport,
  acquisitions: AcquisitionsReport,
  nbv: NbvReport,
  endOfLife: EndOfLifeReport,
};

export function AssetReports() {
  const t = useT();
  const workspaceId = useWorkspaceId();
  const [tab, setTab] = useState<ReportTab>('register');

  if (workspaceId === null) return <NoWorkspaceState body={t('assets.reports.noWorkspace')} />;

  // The panel loads its report ONLY while selected: an inactive panel renders nothing, so its
  // useReport never mounts and the six reads are not fired at once. Switching mounts the new report.
  const tabs = TABS.map((name) => {
    const Active = RENDERERS[name];
    return { id: name, label: t(`assets.reports.tab.${name}`), panel: name === tab ? <Active /> : null };
  });

  return (
    <div className="fa">
      <SurfaceHeader
        title={t('assets.reports.title')}
        subtitle={t('assets.reports.explainer')}
        help={<SurfaceHelp surface="FixedAssets" />}
      />
      <Tabs tabs={tabs} activeId={tab} onChange={(id) => setTab(id as ReportTab)} label={t('assets.reports.title')} />
    </div>
  );
}

export default AssetReports;
