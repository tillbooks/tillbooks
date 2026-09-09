/**
 * C03, Prognose (`/forecast`): the read-only forecasting lens over the C01 pipeline.
 *
 * FOUR READS, NO WRITES. The surface renders `forecast_weighted_pipeline` (with the Gruppierung
 * switch: stage/month/quarter plus any confirmed select/multiselect custom field on `deal`, read
 * from G00), the KPI strip (`forecast_sales_kpis` over the trailing twelve months), the per-month
 * revenue forecast (`forecast_revenue`, three labelled components so the composition is visible),
 * and the vs-actual reconciliation (`forecast_vs_actual`, ▲/▼ glyph AND label, never colour
 * alone). It calls not one write verb: C03 is a pure read model (P5) and this surface honours it.
 *
 * DATA HONESTY. `sample: 0` KPIs render as "–" with "Zu wenig Daten", never a fake 0 % (a zero
 * conversion rate is a claim, and one the engine did not make). The disclaimer "Prognose, keine
 * Buchhaltungszahl." is ALWAYS rendered: only the vs-actual Ist column is posted A08 revenue.
 * FX-excluded quotes render as a ⚠-badged list, so a degraded total says what it excludes.
 *
 * THE PERMISSION GATE HERE IS A CONVENIENCE AND NOT THE ENFORCEMENT (the standing Studio rule):
 * the engine gates every forecast verb on `read_books`, and a denial renders the shared padlock
 * panel, never an empty forecast that looks like "no deals exist".
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn, type DataTableFooterCell } from '../../components/DataTable';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import './Forecast.css';

interface PipelineRow {
  key: string;
  label: string;
  dealCount: number;
  valueBaseMinor: number;
  weightedMinor: number;
}

interface PipelineModel {
  groupBy: string;
  rows: PipelineRow[];
  totalDealCount: number;
  totalValueBaseMinor: number;
  totalWeightedMinor: number;
  baseCurrency: string;
}

interface KpiModel {
  conversionRateBp: number | null;
  avgDealSizeMinor: number | null;
  avgCycleDays: number | null;
  sample: number;
  baseCurrency: string;
}

interface RevenueRow {
  periodKey: string;
  weightedOpenMinor: number;
  wonUninvoicedMinor: number;
  openQuotesMinor: number;
  totalMinor: number;
}

interface RevenueModel {
  rows: RevenueRow[];
  totalMinor: number;
  totalOpenQuotesMinor: number;
  excluded: { quoteId: string; reason: string }[];
  baseCurrency: string;
}

interface VsActualModel {
  actualRevenueMinor: number;
  wonInPeriodMinor: number;
  deltaMinor: number;
  wonNotInvoicedMinor: number;
  invoicedWithoutDealMinor: number;
  sample: number;
  baseCurrency: string;
}

/** Read a payload defensively: a shape this surface cannot read is a failed READ (the Deals rule). */
function parsePipeline(body: unknown): PipelineModel | null {
  const b = body as Record<string, unknown> | null;
  if (b === null || typeof b !== 'object' || !Array.isArray(b.rows)) return null;
  if (typeof b.totalWeightedMinor !== 'number' || typeof b.baseCurrency !== 'string') return null;
  return {
    groupBy: typeof b.groupBy === 'string' ? b.groupBy : 'stage',
    rows: (b.rows as PipelineRow[]).filter((r) => typeof r?.key === 'string'),
    totalDealCount: typeof b.totalDealCount === 'number' ? b.totalDealCount : 0,
    totalValueBaseMinor: typeof b.totalValueBaseMinor === 'number' ? b.totalValueBaseMinor : 0,
    totalWeightedMinor: b.totalWeightedMinor,
    baseCurrency: b.baseCurrency,
  };
}

function parseRevenue(body: unknown): RevenueModel | null {
  const b = body as Record<string, unknown> | null;
  if (b === null || typeof b !== 'object' || !Array.isArray(b.rows)) return null;
  return {
    rows: (b.rows as RevenueRow[]).filter((r) => typeof r?.periodKey === 'string'),
    totalMinor: typeof b.totalMinor === 'number' ? b.totalMinor : 0,
    totalOpenQuotesMinor: typeof b.totalOpenQuotesMinor === 'number' ? b.totalOpenQuotesMinor : 0,
    excluded: Array.isArray(b.excluded) ? (b.excluded as { quoteId: string; reason: string }[]) : [],
    baseCurrency: typeof b.baseCurrency === 'string' ? b.baseCurrency : 'CHF',
  };
}

interface GroupField {
  key: string;
  label: string;
}

/** Confirmed select/multiselect defs on `deal`, for the Gruppierung switch (G00, read-only). */
function parseGroupFields(body: unknown): GroupField[] {
  const defs = (body as { fieldDefs?: unknown })?.fieldDefs;
  if (!Array.isArray(defs)) return [];
  return defs
    .filter(
      (d): d is { key: string; type: string; labelI18n?: Record<string, string> } =>
        d !== null && typeof d === 'object' && typeof (d as { key?: unknown }).key === 'string',
    )
    .filter((d) => d.type === 'select' || d.type === 'multiselect')
    .map((d) => ({ key: d.key, label: d.labelI18n?.['de-CH'] ?? d.labelI18n?.en ?? d.key }));
}

/** ISO day `days` back from now: the KPI window is the trailing twelve months. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The previous CLOSED month ('YYYY-MM'): the default vs-actual period. */
function previousMonth(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

const HORIZONS = [3, 6, 12, 24] as const;

export function Forecast() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [groupBy, setGroupBy] = useState('stage');
  const [horizon, setHorizon] = useState<number>(6);
  const [period, setPeriod] = useState(previousMonth());

  const [pipeline, setPipeline] = useState<PipelineModel | null>(null);
  const [kpis, setKpis] = useState<KpiModel | null>(null);
  const [revenue, setRevenue] = useState<RevenueModel | null>(null);
  const [vsActual, setVsActual] = useState<VsActualModel | null>(null);
  const [groupFields, setGroupFields] = useState<GroupField[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [readError, setReadError] = useState<Err | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    setReadError(null);
    const [pipelineRes, kpiRes, revenueRes, vsRes, fieldsRes] = await Promise.all([
      client.call('forecast_weighted_pipeline', { workspaceId, groupBy }),
      client.call('forecast_sales_kpis', { workspaceId, from: isoDaysAgo(365), to: isoDaysAgo(0) }),
      client.call('forecast_revenue', { workspaceId, horizonMonths: horizon }),
      client.call('forecast_vs_actual', { workspaceId, period }),
      client.call('list_field_defs', { workspaceId, entityKind: 'deal' }),
    ]);
    const responses = [pipelineRes, kpiRes, revenueRes, vsRes];
    if (responses.some((r) => isErr(r.body) && ((r.body as Err).error === 'permission_denied' || r.status === 403))) {
      setDenied(true);
      setLoading(false);
      return;
    }
    // A NAMED rejection of one read (invalid_period from the period picker, a stale groupBy after a
    // field was archived) keeps the rest of the surface alive and offers the way out inline.
    const named = responses.find((r) => isErr(r.body));
    if (named !== undefined) setReadError(named.body as Err);

    const parsedPipeline = isErr(pipelineRes.body) ? null : parsePipeline(pipelineRes.body);
    const parsedRevenue = isErr(revenueRes.body) ? null : parseRevenue(revenueRes.body);
    if (parsedPipeline === null && named === undefined) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setPipeline(parsedPipeline);
    setRevenue(parsedRevenue);
    setKpis(isErr(kpiRes.body) ? null : (kpiRes.body as unknown as KpiModel));
    setVsActual(isErr(vsRes.body) ? null : (vsRes.body as unknown as VsActualModel));
    if (!isErr(fieldsRes.body)) setGroupFields(parseGroupFields(fieldsRes.body));
    setLoading(false);
  }, [client, workspaceId, groupBy, horizon, period]);

  useEffect(() => {
    void load();
  }, [load]);

  // The named-read recovery: return every filter (group-by, horizon, period) to its default. This is
  // a RESET, not a retry of the same rejected input, so it carries the `reset` label, not the generic
  // "try again". Changing the filters re-runs `load` through its dependency on them.
  const resetFilters = useCallback(() => {
    setGroupBy('stage');
    setHorizon(6);
    setPeriod(previousMonth());
  }, []);

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('forecast.denied')} />;

  const currency = pipeline?.baseCurrency ?? 'CHF';
  const quoteOnlyFunnel = (revenue?.totalOpenQuotesMinor ?? 0) > 0 || (revenue?.excluded.length ?? 0) > 0;
  const isEmpty = pipeline !== null && pipeline.totalDealCount === 0 && !quoteOnlyFunnel;

  const bucketLabel = (row: PipelineRow): string => {
    if (row.key !== 'none') return row.label;
    return groupBy === 'month' || groupBy === 'quarter' ? t('forecast.bucket.no_date') : t('forecast.bucket.none');
  };

  const delta = vsActual?.deltaMinor ?? 0;
  const deltaGlyph = delta > 0 ? '▲' : delta < 0 ? '▼' : '=';
  const deltaLabel = delta > 0 ? t('forecast.vsActual.over') : delta < 0 ? t('forecast.vsActual.under') : t('forecast.vsActual.even');

  // The pipeline and revenue breakdowns are the shared DataTable (frame overflow, sticky header,
  // density, tabular figures). The totals row rides DataTable's tfoot via `footer`. The weighted
  // total keeps the accent ink through a wrapping span, since DataTable's tfoot is neutral by default.
  const pipelineColumns: DataTableColumn<PipelineRow>[] = [
    { key: 'group', header: t('forecast.pipelineTable.col.group'), render: (row) => bucketLabel(row) },
    { key: 'count', header: t('forecast.pipelineTable.col.count'), numeric: true, render: (row) => row.dealCount },
    { key: 'value', header: t('forecast.pipelineTable.col.value'), numeric: true, render: (row) => formatMoney(row.valueBaseMinor, currency) },
    { key: 'weighted', header: t('forecast.pipelineTable.col.weighted'), numeric: true, render: (row) => formatMoney(row.weightedMinor, currency) },
  ];
  const pipelineFooter: DataTableFooterCell[] =
    pipeline === null
      ? []
      : [
          { key: 'group', content: t('forecast.pipelineTable.total') },
          { key: 'count', content: pipeline.totalDealCount },
          { key: 'value', content: formatMoney(pipeline.totalValueBaseMinor, currency) },
          { key: 'weighted', content: <span className="forecast-total">{formatMoney(pipeline.totalWeightedMinor, currency)}</span> },
        ];

  const revenueColumns: DataTableColumn<RevenueRow>[] = [
    { key: 'period', header: t('forecast.revenue.col.period'), render: (row) => row.periodKey },
    { key: 'weighted', header: t('forecast.revenue.col.weighted'), numeric: true, render: (row) => formatMoney(row.weightedOpenMinor, revenue?.baseCurrency ?? currency) },
    { key: 'wonUninvoiced', header: t('forecast.revenue.col.wonUninvoiced'), numeric: true, render: (row) => formatMoney(row.wonUninvoicedMinor, revenue?.baseCurrency ?? currency) },
    { key: 'openQuotes', header: t('forecast.revenue.col.openQuotes'), numeric: true, render: (row) => formatMoney(row.openQuotesMinor, revenue?.baseCurrency ?? currency) },
    { key: 'total', header: t('forecast.revenue.col.total'), numeric: true, render: (row) => <span className="forecast-total">{formatMoney(row.totalMinor, revenue?.baseCurrency ?? currency)}</span> },
  ];

  return (
    <section className="forecast" aria-labelledby="forecast-title">
      <SurfaceHeader
        title={t('forecast.route.title')}
        titleId="forecast-title"
        help={<SurfaceHelp surface="Forecast" />}
        /* The §3 boundary, always on screen: only the Ist column below is an accounting figure. */
        subtitle={t('forecast.disclaimer')}
      />
      <div className="forecast-controls">
        <label className="forecast-field">
          <span>{t('forecast.group.label')}</span>
          <select className="field" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            <option value="stage">{t('forecast.group.stage')}</option>
            <option value="month">{t('forecast.group.month')}</option>
            <option value="quarter">{t('forecast.group.quarter')}</option>
            {groupFields.length > 0 && (
              <optgroup label={t('forecast.group.custom')}>
                {groupFields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label className="forecast-field">
          <span>{t('forecast.horizon.label')}</span>
          <select className="field" value={String(horizon)} onChange={(e) => setHorizon(Number.parseInt(e.target.value, 10))}>
            {HORIZONS.map((months) => (
              <option key={months} value={String(months)}>
                {t('forecast.horizon.months', { count: months })}
              </option>
            ))}
          </select>
        </label>
        <label className="forecast-field">
          <span>{t('forecast.period.label')}</span>
          <input className="field" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </label>
      </div>

      {loading && <Skeleton rows={6} labelKey="forecast.loading" />}
      {!loading && failed && <ErrorBanner onRetry={() => void load()} />}
      {!loading && !failed && readError !== null && (
        <div className="forecast-read-error">
          <ErrorBanner
            error={readError}
            message={
              ['invalid_horizon', 'invalid_range', 'invalid_group_by', 'invalid_period', 'not_found'].includes(readError.error)
                ? t(`forecast.error.${readError.error}`)
                : undefined
            }
          />
          {/* The way out the spec names: reset the filter, not "try again" on the same bad input. */}
          <button type="button" className="btn btn--secondary forecast-reset" onClick={resetFilters}>
            {t('forecast.error.reset')}
          </button>
        </div>
      )}

      {!loading && !failed && isEmpty && (
        <EmptyState
          title={t('forecast.empty')}
          hint={t('forecast.emptyHint')}
          action={{ label: t('forecast.emptyCta'), to: '/deals' }}
        />
      )}

      {!loading && !failed && !isEmpty && (
        <>
          {/* (2) the KPI strip: agent-first numbers, human-visible (US-C03.2). */}
          <section className="forecast-kpis panel" aria-label={t('forecast.kpi.title')}>
            <div className="forecast-kpi">
              <span className="forecast-kpi-label">{t('forecast.kpi.conversion')}</span>
              <span className="forecast-kpi-value">
                {kpis?.conversionRateBp == null ? '–' : `${(kpis.conversionRateBp / 100).toFixed(1)} %`}
              </span>
              {kpis !== null && kpis.sample === 0 && <span className="forecast-kpi-hint">{t('forecast.kpi.no_sample')}</span>}
            </div>
            <div className="forecast-kpi">
              <span className="forecast-kpi-label">{t('forecast.kpi.avg_deal')}</span>
              <span className="forecast-kpi-value">
                {kpis?.avgDealSizeMinor == null ? '–' : formatMoney(kpis.avgDealSizeMinor, kpis.baseCurrency)}
              </span>
              {kpis !== null && kpis.sample === 0 && <span className="forecast-kpi-hint">{t('forecast.kpi.no_sample')}</span>}
            </div>
            <div className="forecast-kpi">
              <span className="forecast-kpi-label">{t('forecast.kpi.cycle')}</span>
              <span className="forecast-kpi-value">{kpis?.avgCycleDays == null ? '–' : kpis.avgCycleDays}</span>
              {/* At an empty sample the dash is honest only if it SAYS so, the way the other two KPIs
                  do; otherwise the reader sees the trailing-12-months window under a bare dash. */}
              <span className="forecast-kpi-hint">
                {kpis !== null && kpis.sample === 0 ? t('forecast.kpi.no_sample') : t('forecast.kpi.window')}
              </span>
            </div>
          </section>

          {/* (1) the weighted-pipeline table with the Gruppierung switch (US-C03.1). */}
          {pipeline !== null && pipeline.rows.length > 0 && (
            <section className="panel forecast-panel" aria-label={t('forecast.pipelineTable.title')}>
              <h2>{t('forecast.pipelineTable.title')}</h2>
              <DataTable
                columns={pipelineColumns}
                rows={pipeline.rows}
                rowKey={(row) => row.key}
                footer={pipelineFooter}
              />
            </section>
          )}

          {/* (3) the horizon forecast: three labelled components per month (US-C03.3). */}
          {revenue !== null && (
            <section className="panel forecast-panel" aria-label={t('forecast.revenue.title')}>
              <h2>{t('forecast.revenue.title')}</h2>
              <DataTable columns={revenueColumns} rows={revenue.rows} rowKey={(row) => row.periodKey} />
              {revenue.excluded.length > 0 && (
                <ul className="forecast-excluded" aria-label={t('forecast.excluded.fx')}>
                  {revenue.excluded.map((entry) => (
                    <li key={entry.quoteId}>
                      <span aria-hidden="true">⚠</span> {t('forecast.excluded.fx')} ({entry.quoteId})
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* (4) the vs-actual reconciliation: glyph AND label, never colour alone (US-C03.4). */}
          {vsActual !== null && (
            <section className="panel forecast-panel" aria-label={t('forecast.vsActual.title')}>
              <h2>{t('forecast.vsActual.title')}</h2>
              <dl className="forecast-vs">
                <div>
                  <dt>{t('forecast.vsActual.actual')}</dt>
                  <dd className="num">{formatMoney(vsActual.actualRevenueMinor, vsActual.baseCurrency)}</dd>
                </div>
                <div>
                  <dt>{t('forecast.vsActual.pipeline')}</dt>
                  <dd className="num">{formatMoney(vsActual.wonInPeriodMinor, vsActual.baseCurrency)}</dd>
                </div>
                <div>
                  <dt>{t('forecast.vsActual.delta')}</dt>
                  <dd className="num">
                    <span aria-hidden="true">{deltaGlyph}</span> {formatMoney(vsActual.deltaMinor, vsActual.baseCurrency)}{' '}
                    <span className="forecast-delta-label">{deltaLabel}</span>
                  </dd>
                </div>
                <div>
                  <dt>{t('forecast.vsActual.wonNotInvoiced')}</dt>
                  <dd className="num">{formatMoney(vsActual.wonNotInvoicedMinor, vsActual.baseCurrency)}</dd>
                </div>
                <div>
                  <dt>{t('forecast.vsActual.invoicedWithoutDeal')}</dt>
                  <dd className="num">{formatMoney(vsActual.invoicedWithoutDealMinor, vsActual.baseCurrency)}</dd>
                </div>
              </dl>
            </section>
          )}
        </>
      )}
    </section>
  );
}

export default Forecast;
