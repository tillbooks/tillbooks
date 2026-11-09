/**
 * J07, Lager -> Bestand & Alarme (`/inventory-alerts`): the read-only inventory agent surface.
 *
 * Left, a report picker over the whole J00-J06 cluster: the unified alerts feed, stock position, low
 * stock, reorder candidates, slow movers, anomalies, valuation status / drift and cycle-count status.
 * Right, a per-report filter bar (a date for the valuation cut-off and the anomaly look-back) and the
 * selected report's totals strip plus its preview table. Every report is a PURE READ MCP verb: the
 * surface computes nothing, it renders what the engine returns (integer Rappen formatted to CHF at the
 * edge, severity as a chip).
 *
 * The five states (loading, empty, error, list, no-workspace) follow the house discipline; there is no
 * permission gate here because every verb is a read the engine already gates on read_master_data.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, useTStrict, formatMoney } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState, NoWorkspaceState } from '../../components/states';
import { Status, type StatusKind } from '../../components/Status';
import { Tabs } from '../../components/Tabs';
import './InventoryAlerts.css';

/** Format an integer-Rappen figure to a CHF string at the render edge only. */
const chf = (rappen: number) => (rappen / 100).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

interface ReportDef {
  id: string;
  verb: string;
  /** Extra, non-workspace input the verb needs. */
  input?: Record<string, unknown>;
  needsSince?: boolean;
  needsAsOf?: boolean;
  rows: (body: Record<string, unknown>) => Record<string, unknown>[];
  columns: [string, string][];
  totals?: (body: Record<string, unknown>) => { labelKey: string; value: string }[];
}

const REPORTS: ReportDef[] = [
  {
    id: 'alerts',
    verb: 'inventory_alerts',
    rows: (b) => arr(b.alerts),
    columns: [
      ['severity', 'inventory.alerts.col.severity'],
      ['type', 'inventory.alerts.col.type'],
      ['title', 'inventory.alerts.col.title'],
      ['summary', 'inventory.alerts.col.summary'],
      ['suggested_action', 'inventory.alerts.col.action'],
    ],
    totals: (b) => {
      const c = (b.counts_by_severity ?? {}) as { critical?: number; warning?: number; info?: number };
      return [
        { labelKey: 'inventory.alerts.total.critical', value: String(c.critical ?? 0) },
        { labelKey: 'inventory.alerts.total.warning', value: String(c.warning ?? 0) },
        { labelKey: 'inventory.alerts.total.info', value: String(c.info ?? 0) },
      ];
    },
  },
  {
    id: 'stockPosition',
    verb: 'inventory_stock_position',
    input: { include_valuation: true },
    rows: (b) => arr(b.rows),
    columns: [
      ['item_name', 'inventory.alerts.col.item'],
      ['item_number', 'inventory.alerts.col.sku'],
      ['location_name', 'inventory.alerts.col.location'],
      ['qty', 'inventory.alerts.col.qty'],
      ['extended_value_rappen', 'inventory.alerts.col.value'],
    ],
    totals: (b) => {
      const t = (b.totals ?? {}) as { count?: number; qty?: number; value_rappen?: number };
      return [
        { labelKey: 'inventory.alerts.total.positions', value: String(t.count ?? 0) },
        { labelKey: 'inventory.alerts.total.qty', value: String(t.qty ?? 0) },
        { labelKey: 'inventory.alerts.total.value', value: chf(t.value_rappen ?? 0) },
      ];
    },
  },
  {
    id: 'lowStock',
    verb: 'inventory_low_stock',
    rows: (b) => arr(b.items),
    columns: [
      ['item_name', 'inventory.alerts.col.item'],
      ['current_qty', 'inventory.alerts.col.currentQty'],
      ['reorder_point', 'inventory.alerts.col.reorderPoint'],
      ['shortfall_qty', 'inventory.alerts.col.shortfall'],
      ['estimated_days_of_cover', 'inventory.alerts.col.daysOfCover'],
    ],
  },
  {
    id: 'reorderCandidates',
    verb: 'inventory_reorder_candidates',
    rows: (b) => arr(b.candidates),
    columns: [
      ['item_name', 'inventory.alerts.col.item'],
      ['current_qty', 'inventory.alerts.col.currentQty'],
      ['shortfall_qty', 'inventory.alerts.col.shortfall'],
      ['suggested_qty', 'inventory.alerts.col.suggestedQty'],
      ['estimated_days_of_cover', 'inventory.alerts.col.daysOfCover'],
    ],
  },
  {
    id: 'slowMovers',
    verb: 'inventory_slow_movers',
    rows: (b) => arr(b.items),
    columns: [
      ['item_name', 'inventory.alerts.col.item'],
      ['current_qty', 'inventory.alerts.col.currentQty'],
      ['days_idle', 'inventory.alerts.col.daysIdle'],
      ['extended_value_rappen', 'inventory.alerts.col.value'],
    ],
  },
  {
    id: 'anomalies',
    verb: 'inventory_anomalies',
    needsSince: true,
    rows: (b) => arr(b.anomalies),
    columns: [
      ['severity', 'inventory.alerts.col.severity'],
      ['type', 'inventory.alerts.col.type'],
      ['summary', 'inventory.alerts.col.summary'],
    ],
    totals: (b) => {
      const c = (b.counts_by_severity ?? {}) as { critical?: number; warning?: number; info?: number };
      return [
        { labelKey: 'inventory.alerts.total.critical', value: String(c.critical ?? 0) },
        { labelKey: 'inventory.alerts.total.warning', value: String(c.warning ?? 0) },
      ];
    },
  },
  {
    id: 'valuationStatus',
    verb: 'inventory_valuation_status',
    needsAsOf: true,
    // A single-object report: wrap the top-level body as one row.
    rows: (b) => (typeof b.status === 'string' ? [b] : []),
    columns: [
      ['status', 'inventory.alerts.col.status'],
      ['current_value_rappen', 'inventory.alerts.col.currentValue'],
      ['last_posted_value_rappen', 'inventory.alerts.col.lastPosted'],
      ['drift_rappen', 'inventory.alerts.col.drift'],
      ['drift_pct', 'inventory.alerts.col.driftPct'],
    ],
  },
  {
    id: 'cycleCounts',
    verb: 'inventory_cycle_count_status',
    rows: (b) => arr(b.sessions),
    columns: [
      ['session_id', 'inventory.alerts.col.session'],
      ['status', 'inventory.alerts.col.status'],
      ['freeze_at', 'inventory.alerts.col.freezeAt'],
      ['uncounted_count', 'inventory.alerts.col.uncounted'],
      ['overdue', 'inventory.alerts.col.overdue'],
    ],
  },
];

/** An alert's severity as the one `Status` word (K-22): bad, needs attention, or nothing to act on. */
const SEVERITY_KIND: Record<string, StatusKind> = { critical: 'danger', warning: 'warn', info: 'neutral' };

/** The date filters follow the typing this long after the last change (K-16: live, no Run button). */
const FILTER_DEBOUNCE_MS = 250;

const MONEY_KEY = /(rappen|value)$/i;
const PCT_KEY = /_pct$/i;
/** A column that holds a figure: right-aligned with tabular digits via DataTable's `numeric`. */
const NUMERIC_KEY = /(qty|_rappen$|_value$|_pct$|reorder_point|days|count)/i;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function InventoryAlerts() {
  const t = useT();
  const tStrict = useTStrict();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [reportId, setReportId] = useState<string>(REPORTS[0].id);
  const [asOf, setAsOf] = useState('2026-12-31');
  const [since, setSince] = useState('2026-01-01');
  // What the fields show, committed to the query 250ms after the last change (K-16).
  const [asOfDraft, setAsOfDraft] = useState(asOf);
  const [sinceDraft, setSinceDraft] = useState(since);
  useEffect(() => {
    if (asOfDraft === asOf && sinceDraft === since) return undefined;
    const timer = setTimeout(() => {
      setAsOf(asOfDraft);
      setSince(sinceDraft);
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [asOfDraft, sinceDraft, asOf, since]);
  const [body, setBody] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Err | null>(null);

  const report = useMemo(() => REPORTS.find((r) => r.id === reportId) ?? REPORTS[0], [reportId]);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setError(null);
    const input: Record<string, unknown> = { workspaceId, ...(report.input ?? {}) };
    if (report.needsSince === true) input.since = since;
    if (report.needsAsOf === true) input.as_of = asOf;
    const res = await client.call(report.verb, input);
    setLoading(false);
    if (isErr(res.body)) {
      setError(res.body);
      setBody(null);
      return;
    }
    setBody(res.body as unknown as Record<string, unknown>);
  }, [client, workspaceId, report, since, asOf]);

  useEffect(() => {
    void load();
  }, [load]);

  if (workspaceId === null) return <NoWorkspaceState body={t('inventory.alerts.noWorkspace')} />;

  const rows = body === null ? [] : report.rows(body);
  const totals = body !== null && report.totals !== undefined ? report.totals(body) : [];

  // The alert feed carries machine tokens (severity / type / suggested_action) and a structured
  // payload; the surface localizes those tokens and rebuilds the money-bearing summary at the edge
  // rather than rendering the engine's English prose or raw minor units.
  const titleLabel = (row: Record<string, unknown>): string => {
    const type = row.type;
    if (type === 'lot_near_expiry') {
      const expired = isRecord(row.payload) && row.payload.expired === true;
      return tStrict(expired ? 'inventory.alerts.headline.lot_expired' : 'inventory.alerts.type.lot_near_expiry');
    }
    return typeof type === 'string' ? tStrict(`inventory.alerts.type.${type}`) : '–';
  };

  const summaryLabel = (row: Record<string, unknown>): string => {
    if (row.type === 'valuation_drift') {
      const drift = isRecord(row.payload) ? row.payload.driftRappen : undefined;
      if (typeof drift === 'number') return formatMoney(drift, 'CHF');
    }
    return typeof row.summary === 'string' ? row.summary : '–';
  };

  const cell = (row: Record<string, unknown>, key: string): string => {
    const v = row[key];
    if (key === 'severity' && typeof v === 'string') return tStrict(`inventory.alerts.severity.${v}`);
    if (key === 'type' && typeof v === 'string') return tStrict(`inventory.alerts.type.${v}`);
    if (key === 'suggested_action' && typeof v === 'string') return tStrict(`inventory.alerts.action.${v}`);
    if (key === 'title') return titleLabel(row);
    if (key === 'summary') return summaryLabel(row);
    if (v === null || v === undefined) return '–';
    if (typeof v === 'boolean') return v ? t('inventory.alerts.yes') : t('inventory.alerts.no');
    if (typeof v === 'number' && PCT_KEY.test(key)) return `${v}%`;
    if (typeof v === 'number' && MONEY_KEY.test(key)) return chf(v);
    return String(v);
  };

  // The active report's columns, mapped onto DataTable: figures right-align with tabular digits, the
  // severity value renders as the surface's status chip, everything else is text formatted at the edge.
  const columns: DataTableColumn<Record<string, unknown>>[] = report.columns.map(([key, labelKey]) => ({
    key,
    header: t(labelKey),
    numeric: NUMERIC_KEY.test(key),
    render: (row) =>
      key === 'severity' && typeof row[key] === 'string' ? (
        <Status kind={SEVERITY_KIND[String(row[key])] ?? 'neutral'} label={cell(row, key)} />
      ) : (
        cell(row, key)
      ),
  }));

  return (
    <div className="invalerts">
      <SurfaceHeader
        title={t('inventory.alerts.title')}
        subtitle={t('inventory.alerts.subtitle')}
        help={<SurfaceHelp surface="InventoryAlerts" />}
      />

      {/* The report list is the vertical Tabs (K-11): one view of the surface at a time, the chosen
          report the pill, the arrow keys moving between them. */}
      <Tabs
        orientation="vertical"
        label={t('inventory.alerts.reportsLabel')}
        tabs={REPORTS.map((r) => ({ id: r.id, label: t(`inventory.alerts.report.${r.id}`) }))}
        activeId={reportId}
        onChange={setReportId}
      >
        <section className="invalerts__main">
          {(report.needsSince === true || report.needsAsOf === true) && (
            <div className="invalerts__filters">
              {report.needsAsOf === true && (
                <label>
                  {t('inventory.alerts.asOf')}
                  <input className="field" type="date" value={asOfDraft} onChange={(e) => setAsOfDraft(e.target.value)} />
                </label>
              )}
              {report.needsSince === true && (
                <label>
                  {t('inventory.alerts.since')}
                  <input className="field" type="date" value={sinceDraft} onChange={(e) => setSinceDraft(e.target.value)} />
                </label>
              )}
            </div>
          )}

          {totals.length > 0 && (
            <div className="invalerts__totals" role="status">
              {totals.map((tt) => (
                <div key={tt.labelKey} className="invalerts__total">
                  <span className="invalerts__total-label">{t(tt.labelKey)}</span>
                  <span className="invalerts__total-value t-money">{tt.value}</span>
                </div>
              ))}
            </div>
          )}

          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => String(rows.indexOf(row))}
            caption={t(`inventory.alerts.report.${report.id}`)}
            loading={loading}
            error={error ?? undefined}
            onRetry={() => void load()}
            emptyState={
              <EmptyState title={t('inventory.alerts.emptyTitle')} hint={t('inventory.alerts.emptyHint')} />
            }
          />
        </section>
      </Tabs>
    </div>
  );
}
