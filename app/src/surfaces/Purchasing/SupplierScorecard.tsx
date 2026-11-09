/**
 * I05, the Suppliers -> Scorecard tab of Einkauf (`/purchasing`).
 *
 * A PURE READ surface over the five `supplier_*` verbs: a period selector, a supplier picker, the
 * overall score badge with a traffic light, one card per core metric (each a glyph AND a label, never
 * colour alone, spec §6 / brand DESIGN.md), the top contributing exceptions with their document ids,
 * a ranked peer leaderboard, and the open threshold alerts. Nothing here writes: the tab issues only
 * the read verbs, and the engine recomputes every number from the live I02 receipts and D02 matches.
 *
 * THE PERMISSION GATE IS THE ENGINE'S (the standing Studio rule): this tab renders under the same
 * `read_master_data` the rest of Einkauf reads with, so a member who reached the surface may read the
 * scorecard too. A denied read degrades to the surface's own PermissionDenied, handled by the parent.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { EmptyState, ErrorBanner, Skeleton } from '../../components/states';
import { Select } from '../../components/Select';
import { Status, type StatusKind } from '../../components/Status';

/** The metric vocabulary the engine admits (mirrors PERFORMANCE_METRICS), overall first for the badge. */
const METRIC_ORDER = [
  'otif_pct',
  'on_time_pct',
  'in_full_pct',
  'avg_delay_days',
  'qty_variance_pct',
  'price_variance_pct',
  'match_override_rate',
  'rejection_rate',
] as const;

/** Glyph per traffic light: never colour alone (WCAG 2.2, brand law). */
/** A metric's traffic light as the one `Status` word (K-22): the glyph and the word, never colour alone. */
const LIGHT_KIND: Record<string, StatusKind> = { green: 'success', amber: 'warn', red: 'danger', none: 'neutral' };

interface MetricView {
  id: string;
  value: number | null;
  unit: 'pct' | 'days' | 'score';
  normalised: number | null;
  status: 'green' | 'amber' | 'red' | 'none';
  weight: number | null;
}

interface ScorecardException {
  kind: string;
  receiptNumber?: string;
  poId?: string;
  matchId?: string;
  detail: Record<string, number | string>;
}

interface Scorecard {
  supplier: { id: string; name: string };
  period: { from: string; to: string; windowDays: number };
  counts: { receipts: number; lines: number; matches: number };
  empty: boolean;
  metrics: MetricView[];
  overallScore: number | null;
  activityCount: number;
  previous: { from: string; to: string; overallScore: number | null };
  trendDelta: number | null;
  exceptions: ScorecardException[];
}

interface RankRow {
  supplierId: string;
  name: string;
  score: number | null;
  metricValue: number | null;
  activityCount: number;
  previousDelta: number | null;
}

interface Alert {
  supplierId: string;
  name: string;
  metric: string;
  value: number;
  threshold: number;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

const WINDOWS = [30, 90, 365] as const;

interface Props {
  contacts: Map<string, string>;
}

export function SupplierScorecard({ contacts }: Props) {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [windowDays, setWindowDays] = useState<number>(90);
  const [supplierId, setSupplierId] = useState('');
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [ranking, setRanking] = useState<RankRow[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const suppliers = useMemo(() => [...contacts.entries()], [contacts]);

  const loadOverview = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setFailed(false);
    const [ranked, alerted] = await Promise.all([
      client.call('supplier_performance_rank', { workspaceId, metric: 'overall_score', windowDays, minActivity: 1 }),
      client.call('supplier_performance_alerts', { workspaceId, windowDays }),
    ]);
    if (isErr(ranked.body)) setFailed(true);
    else setRanking(asArray<RankRow>((ranked.body as { rows?: unknown }).rows));
    if (!isErr(alerted.body)) setAlerts(asArray<Alert>((alerted.body as { alerts?: unknown }).alerts));
    setLoading(false);
  }, [client, workspaceId, windowDays]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const loadScorecard = useCallback(
    async (id: string) => {
      if (workspaceId === null || id === '') {
        setScorecard(null);
        return;
      }
      const res = await client.call('supplier_scorecard_get', { workspaceId, supplierId: id, windowDays });
      if (!isErr(res.body)) setScorecard(res.body as unknown as Scorecard);
      else setScorecard(null);
    },
    [client, workspaceId, windowDays],
  );

  useEffect(() => {
    void loadScorecard(supplierId);
  }, [supplierId, loadScorecard]);

  const metricLabel = (id: string) => t(`po.scorecard.metric.${id}`);
  const formatValue = (m: MetricView): string => {
    if (m.value === null) return t('po.scorecard.noData');
    if (m.unit === 'days') return `${m.value} ${t('po.scorecard.unit.days')}`;
    if (m.unit === 'pct') return `${m.value}%`;
    return `${m.value}`;
  };
  const lightLabel = (status: string) => t(`po.scorecard.light.${status}`);

  return (
    <section className="po-scorecard" aria-label={t('po.tab.scorecard')}>
      <div className="po-scorecard-controls">
        <div className="po-field">
          <span>{t('po.scorecard.supplier')}</span>
          <Select
            value={supplierId}
            onChange={setSupplierId}
            options={[
              { value: '', label: t('po.scorecard.supplierPick') },
              ...suppliers.map(([id, name]) => ({ value: id, label: name })),
            ]}
            ariaLabel={t('po.scorecard.supplier')}
          />
        </div>
        <div className="po-field">
          <span>{t('po.scorecard.window')}</span>
          <Select
            value={String(windowDays)}
            onChange={(value) => setWindowDays(Number.parseInt(value, 10))}
            options={WINDOWS.map((w) => ({ value: String(w), label: t(`po.scorecard.windowDays`, { n: w }) }))}
            ariaLabel={t('po.scorecard.window')}
          />
        </div>
      </div>

      {failed && <ErrorBanner context="read" message={t('po.scorecard.error')} onRetry={() => void loadOverview()} />}

      {supplierId !== '' && scorecard !== null && (
        <div className="po-scorecard-card">
          <header className="po-scorecard-head">
            <h3>{scorecard.supplier.name}</h3>
            <div className="po-scorecard-overall" aria-label={t('po.scorecard.metric.overall_score')}>
              <span className="po-scorecard-overall-value">
                {scorecard.overallScore === null ? t('po.scorecard.noData') : scorecard.overallScore}
              </span>
              {scorecard.trendDelta !== null && (
                <span className="po-scorecard-delta">
                  {scorecard.trendDelta >= 0 ? '▲' : '▼'} {Math.abs(scorecard.trendDelta)}
                </span>
              )}
            </div>
          </header>

          {scorecard.empty ? (
            <EmptyState title={t('po.scorecard.emptyWindow')} hint={t('po.scorecard.emptyWindowHint')} />
          ) : (
            <>
              <dl className="po-scorecard-metrics">
                {METRIC_ORDER.map((id) => {
                  const m = scorecard.metrics.find((x) => x.id === id);
                  if (m === undefined) return null;
                  return (
                    <div key={id} className="po-scorecard-metric" data-status={m.status}>
                      <dt>{metricLabel(id)}</dt>
                      <dd>
                        <span className="po-scorecard-metric-value">{formatValue(m)}</span>
                        <Status kind={LIGHT_KIND[m.status] ?? 'neutral'} label={lightLabel(m.status)} />
                      </dd>
                    </div>
                  );
                })}
              </dl>

              {scorecard.exceptions.length > 0 && (
                <div className="po-scorecard-exceptions">
                  <h4>{t('po.scorecard.exceptions')}</h4>
                  <ul>
                    {scorecard.exceptions.slice(0, 8).map((e, i) => (
                      <li key={i}>
                        <Status kind="warn" label={t(`po.scorecard.exception.${e.kind}`)} />
                        {typeof e.detail.delayDays === 'number' && ` (${e.detail.delayDays} ${t('po.scorecard.unit.days')})`}
                        {e.receiptNumber !== undefined && ` · ${e.receiptNumber}`}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {alerts.length > 0 && (
        <div className="po-scorecard-alerts" role="status">
          <h4>{t('po.scorecard.alertsTitle')}</h4>
          <ul>
            {alerts.map((a, i) => (
              <li key={i}>
                <Status kind="warn" label={`${a.name}: ${metricLabel(a.metric)} ${a.value} <> ${a.threshold}`} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="po-scorecard-rank">
        <h4>{t('po.scorecard.leaderboard')}</h4>
        {loading ? (
          <Skeleton rows={3} height={36} />
        ) : ranking.length === 0 ? (
          <EmptyState title={t('po.scorecard.emptyRank')} />
        ) : (
          <table className="po-table">
            <thead>
              <tr>
                <th>{t('po.scorecard.rankSupplier')}</th>
                <th>{t('po.scorecard.rankScore')}</th>
                <th>{t('po.scorecard.rankActivity')}</th>
                <th>{t('po.scorecard.rankDelta')}</th>
              </tr>
            </thead>
            <tbody>
              {ranking.map((r) => (
                <tr key={r.supplierId} className={supplierId === r.supplierId ? 'po-scorecard-rank--active' : undefined}>
                  <td>
                    {/* The row's opener in the text ink at 500, the underline only on hover (K-12). */}
                    <button
                      type="button"
                      className="po-linkish link-inline"
                      aria-current={supplierId === r.supplierId ? 'true' : undefined}
                      onClick={() => setSupplierId(r.supplierId)}
                    >
                      {r.name}
                    </button>
                  </td>
                  <td>{r.score === null ? t('po.scorecard.noData') : r.score}</td>
                  <td>{r.activityCount}</td>
                  <td>{r.previousDelta === null ? '' : `${r.previousDelta >= 0 ? '▲' : '▼'} ${Math.abs(r.previousDelta)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export default SupplierScorecard;
