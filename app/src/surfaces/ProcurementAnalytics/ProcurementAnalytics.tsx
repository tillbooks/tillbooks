/**
 * I06, Einkauf -> Auswertungen (`/procurement-analytics`): the Procurement Analytics surface.
 *
 * Left, the standard-report picker (open commitments, match exceptions, spend, supplier scorecards,
 * requisition pipeline, GR/IR clearing, landed-cost variance, PO cycle, anomalies). Right, a filter
 * bar (a date range for the period reports) and the selected report's totals strip plus its preview
 * table. Every report is a PURE READ MCP verb: the surface computes nothing, it only renders what the
 * engine returns (integer Rappen formatted to CHF at the edge).
 *
 * The five states (loading, empty, error, list, no-workspace) follow the house discipline; there is
 * no permission gate here because every verb is a read the engine already gates on read_master_data.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { EmptyState, NoWorkspaceState } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { Tabs } from '../../components/Tabs';
import './ProcurementAnalytics.css';

/** The period filter follows the typing this long after the last change (K-16: live, no Run button). */
const FILTER_DEBOUNCE_MS = 250;

/** Format an integer-Rappen figure to a CHF string at the render edge only. */
const chf = (rappen: number) => (rappen / 100).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A report definition: the verb it runs, whether it needs a period, and how it maps to a preview. */
interface ReportDef {
  id: string;
  verb: string;
  needsPeriod: boolean;
  /** The rows array's field name in the payload, or a function producing rows for the flatter shapes. */
  rows: (body: Record<string, unknown>) => Record<string, unknown>[];
  /** The columns to show, in order: [payload key, i18n column key, numeric?]. Numeric columns
   *  right-align with tabular figures (design law); text columns left-align. */
  columns: [string, string, boolean?][];
  /** Optional totals strip: [i18n label key, value producer]. */
  totals?: (body: Record<string, unknown>) => { labelKey: string; value: string }[];
}

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

const REPORTS: ReportDef[] = [
  {
    id: 'openCommitments',
    verb: 'procurement_open_commitments',
    needsPeriod: false,
    rows: (b) => arr(b.rows),
    columns: [
      ['poNumber', 'procurement.analytics.col.po'],
      ['supplierName', 'procurement.analytics.col.supplier'],
      ['openQty', 'procurement.analytics.col.openQty', true],
      ['openValueRappen', 'procurement.analytics.col.openValue', true],
      ['agingBucket', 'procurement.analytics.col.aging'],
    ],
    totals: (b) => {
      const t = (b.totals ?? {}) as { count?: number; open_value_rappen?: number };
      return [
        { labelKey: 'procurement.analytics.total.count', value: String(t.count ?? 0) },
        { labelKey: 'procurement.analytics.total.openValue', value: chf(t.open_value_rappen ?? 0) },
      ];
    },
  },
  {
    id: 'matchStatus',
    verb: 'procurement_match_status',
    needsPeriod: false,
    rows: (b) => arr(b.exceptions),
    columns: [
      ['poNumber', 'procurement.analytics.col.po'],
      ['supplierName', 'procurement.analytics.col.supplier'],
      ['status', 'procurement.analytics.col.status'],
      ['priceVarianceRappen', 'procurement.analytics.col.priceVariance', true],
      ['suggestedNextAction', 'procurement.analytics.col.nextAction'],
    ],
    totals: (b) => [{ labelKey: 'procurement.analytics.total.matchStatus', value: String(b.status ?? '') }],
  },
  {
    id: 'spendSummary',
    verb: 'procurement_spend_summary',
    needsPeriod: true,
    rows: (b) => arr(b.rows),
    columns: [
      ['label', 'procurement.analytics.col.group'],
      ['document_count', 'procurement.analytics.col.docs', true],
      ['ordered_rappen', 'procurement.analytics.col.ordered', true],
      ['received_rappen', 'procurement.analytics.col.received', true],
      ['billed_rappen', 'procurement.analytics.col.billed', true],
    ],
    totals: (b) => {
      const g = (b.grand_total ?? {}) as { billed_rappen?: number };
      return [{ labelKey: 'procurement.analytics.total.billed', value: chf(g.billed_rappen ?? 0) }];
    },
  },
  {
    id: 'supplierScorecard',
    verb: 'procurement_supplier_scorecard',
    needsPeriod: true,
    rows: (b) => arr(b.rows),
    columns: [
      ['supplierName', 'procurement.analytics.col.supplier'],
      ['overallScore', 'procurement.analytics.col.score', true],
      ['onTimeDeliveryPct', 'procurement.analytics.col.onTime', true],
      ['openCommitmentRappen', 'procurement.analytics.col.openValue', true],
      ['spendInPeriodRappen', 'procurement.analytics.col.spend', true],
    ],
  },
  {
    id: 'requisitionPipeline',
    verb: 'procurement_requisition_pipeline',
    needsPeriod: false,
    rows: (b) => arr(b.rows),
    columns: [
      ['number', 'procurement.analytics.col.requisition'],
      ['status', 'procurement.analytics.col.status'],
      ['daysInStatus', 'procurement.analytics.col.daysInStatus', true],
      ['totalEstimatedRappen', 'procurement.analytics.col.estimated', true],
    ],
    totals: (b) => {
      const c = (b.conversion ?? {}) as { conversion_rate_pct?: number | null };
      return [{ labelKey: 'procurement.analytics.total.conversion', value: `${c.conversion_rate_pct ?? 0}%` }];
    },
  },
  {
    id: 'grirClearing',
    verb: 'procurement_grir_clearing',
    needsPeriod: false,
    rows: (b) => {
      const rni = (b.received_not_invoiced ?? {}) as { count?: number; residual_value_rappen?: number };
      const inr = (b.invoiced_not_received ?? {}) as { count?: number; residual_value_rappen?: number };
      return [
        { side: 'RNI', count: rni.count ?? 0, residualValueRappen: rni.residual_value_rappen ?? 0 },
        { side: 'INR', count: inr.count ?? 0, residualValueRappen: inr.residual_value_rappen ?? 0 },
      ];
    },
    columns: [
      ['side', 'procurement.analytics.col.side'],
      ['count', 'procurement.analytics.col.count', true],
      ['residualValueRappen', 'procurement.analytics.col.residual', true],
    ],
    totals: (b) => [
      { labelKey: 'procurement.analytics.total.netExposure', value: chf(Number(b.net_exposure_rappen ?? 0)) },
      { labelKey: 'procurement.analytics.total.grirStatus', value: String(b.status ?? '') },
    ],
  },
  {
    id: 'landedCostVariance',
    verb: 'procurement_landed_cost_variance',
    needsPeriod: true,
    rows: (b) => arr(b.rows),
    columns: [
      ['number', 'procurement.analytics.col.voucher'],
      ['effectiveDate', 'procurement.analytics.col.date'],
      ['plannedMinor', 'procurement.analytics.col.planned', true],
      ['capitalizedMinor', 'procurement.analytics.col.capitalized', true],
      ['varianceMinor', 'procurement.analytics.col.variance', true],
    ],
  },
  {
    id: 'poCycle',
    verb: 'procurement_po_cycle',
    needsPeriod: true,
    rows: (b) =>
      arr(b.groups).map((g) => {
        const r = (g.order_to_first_receipt ?? {}) as { avg_days?: number | null };
        const m = (g.order_to_full_match ?? {}) as { avg_days?: number | null };
        return { label: g.label, completed_count: g.completed_count, toReceipt: r.avg_days ?? null, toMatch: m.avg_days ?? null };
      }),
    columns: [
      ['label', 'procurement.analytics.col.group'],
      ['completed_count', 'procurement.analytics.col.completed', true],
      ['toReceipt', 'procurement.analytics.col.toReceipt', true],
      ['toMatch', 'procurement.analytics.col.toMatch', true],
    ],
  },
  {
    id: 'anomalies',
    verb: 'procurement_anomalies',
    needsPeriod: false,
    rows: (b) => arr(b.anomalies),
    columns: [
      ['severity', 'procurement.analytics.col.severity'],
      ['type', 'procurement.analytics.col.type'],
      ['summary', 'procurement.analytics.col.summary'],
    ],
  },
];

const MONEY_KEY = /(rappen|minor)$/i;

export function ProcurementAnalytics() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [reportId, setReportId] = useState<string>(REPORTS[0].id);
  const [fromDate, setFromDate] = useState('2026-01-01');
  const [toDate, setToDate] = useState('2026-12-31');
  // What the fields show, committed to the query 250ms after the last change (K-16).
  const [fromDraft, setFromDraft] = useState(fromDate);
  const [toDraft, setToDraft] = useState(toDate);
  useEffect(() => {
    if (fromDraft === fromDate && toDraft === toDate) return undefined;
    const timer = setTimeout(() => {
      setFromDate(fromDraft);
      setToDate(toDraft);
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fromDraft, toDraft, fromDate, toDate]);
  const [body, setBody] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Err | null>(null);

  const report = useMemo(() => REPORTS.find((r) => r.id === reportId) ?? REPORTS[0], [reportId]);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setError(null);
    const input: Record<string, unknown> = { workspaceId };
    if (report.needsPeriod) {
      input.from_date = fromDate;
      input.to_date = toDate;
      if (report.id === 'spendSummary') input.group_by = 'supplier';
    }
    if (report.id === 'anomalies') input.since = fromDate;
    const res = await client.call(report.verb, input);
    setLoading(false);
    if (isErr(res.body)) {
      setError(res.body);
      setBody(null);
      return;
    }
    setBody(res.body as unknown as Record<string, unknown>);
  }, [client, workspaceId, report, fromDate, toDate]);

  useEffect(() => {
    void load();
  }, [load]);

  if (workspaceId === null) return <NoWorkspaceState body={t('procurement.analytics.noWorkspace')} />;

  const rows = body === null ? [] : report.rows(body);
  const totals = body !== null && report.totals !== undefined ? report.totals(body) : [];

  const cell = (row: Record<string, unknown>, key: string): string => {
    const v = row[key];
    if (v === null || v === undefined) return '–';
    if (typeof v === 'number' && MONEY_KEY.test(key)) return chf(v);
    return String(v);
  };

  // The engine's report rows carry no stable id, so key them by position within the current report.
  type AnalyticsRow = Record<string, unknown> & { __rowKey: string };
  const keyedRows: AnalyticsRow[] = rows.map((row, i) => ({ ...row, __rowKey: String(i) }));
  const columns: DataTableColumn<AnalyticsRow>[] = report.columns.map(([key, labelKey, numeric]) => ({
    key,
    header: t(labelKey),
    numeric: numeric ?? false,
    render: (row) => cell(row, key),
  }));

  return (
    <div className="procanalytics">
      <SurfaceHeader
        title={t('procurement.analytics.title')}
        subtitle={t('procurement.analytics.subtitle')}
        help={<SurfaceHelp surface="ProcurementAnalytics" />}
      />

      {/* The report list is the vertical Tabs (K-11): one view of the surface at a time, the chosen
          report the pill, the arrow keys moving between them. */}
      <Tabs
        orientation="vertical"
        label={t('procurement.analytics.reportsLabel')}
        tabs={REPORTS.map((r) => ({ id: r.id, label: t(`procurement.analytics.report.${r.id}`) }))}
        activeId={reportId}
        onChange={setReportId}
      >
        <section className="procanalytics__main">
          {report.needsPeriod && (
            <div className="procanalytics__filters">
              <label>
                {t('procurement.analytics.from')}
                <input className="field" type="date" value={fromDraft} onChange={(e) => setFromDraft(e.target.value)} />
              </label>
              <label>
                {t('procurement.analytics.to')}
                <input className="field" type="date" value={toDraft} onChange={(e) => setToDraft(e.target.value)} />
              </label>
            </div>
          )}

          {totals.length > 0 && (
            <div className="procanalytics__totals" role="status">
              {totals.map((tt) => (
                <div key={tt.labelKey} className="procanalytics__total">
                  <span className="procanalytics__total-label">{t(tt.labelKey)}</span>
                  <span className="procanalytics__total-value t-money">{tt.value}</span>
                </div>
              ))}
            </div>
          )}

          <DataTable
            columns={columns}
            rows={keyedRows}
            rowKey={(row) => row.__rowKey}
            caption={t(`procurement.analytics.report.${report.id}`)}
            loading={loading}
            error={error ?? undefined}
            onRetry={() => void load()}
            emptyState={
              <EmptyState
                title={t('procurement.analytics.emptyTitle')}
                hint={t('procurement.analytics.emptyHint')}
              />
            }
            skeletonRows={5}
          />
        </section>
      </Tabs>
    </div>
  );
}
