/**
 * H03, Fixed Assets -> Depreciation (`/depreciation`): the side-effect-free preview and projection
 * surface over the pure engine. NOTHING is posted here (H04 posts); this screen answers "what is the
 * depreciation for period P?" and "what does the remaining schedule look like?" for one asset, and
 * lets a setup user enable or disable a method for the workspace.
 *
 * The numbers come straight from `asset_depreciation_preview` / `asset_depreciation_schedule`, so the
 * live next-period figure and the schedule table can never disagree with what H04 will book. Amounts
 * are Rappen formatted to CHF exactly as the register does. Status/finality is glyph + text, never
 * colour alone (WCAG 2.2 AA). No new colour token (design-canon).
 *
 * H01 PARAMETER GAP surfaced honestly: the asset master stores no declining rate or units total yet, so
 * for those two methods the screen exposes an optional input and passes it as a per-call override. The
 * permission gate on the Methods toggles is a convenience (`whoami` fails open); the engine is the gate.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { Select } from '../../components/Select';
import { useWorkspaceId } from '../../app/workspace';
import { formatMoney, useT } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { useCalendarFormat } from '../../lib/format';
import './FixedAssets.css';

const newKey = () => crypto.randomUUID();
// K-71: format through the shared `formatMoney` so de-CH thousands grouping is applied once, in one
// place. A depreciation schedule is the workspace base currency and carries no per-row currency, so
// the base (CHF) is passed explicitly rather than assumed inside the formatter.
const money = (rappen: number): string => formatMoney(rappen, 'CHF');
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The current month as `YYYY-MM`, the default period to preview. */
function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface AssetLite {
  id: string;
  number: string;
  name: string;
  depreciationMethod: string;
  status: string;
  acquisitionCostRappen: number;
  residualValueRappen: number;
  netBookValueRappen: number;
}

interface PreviewResult {
  amountRappen: number;
  isFinal: boolean;
  reason?: string;
  explanation: string;
  remainingLifeMonths?: number;
  remainingUnits?: number;
  projectedNbvAfterRappen: number;
}

interface ScheduleLine {
  period: string;
  amountRappen: number;
  projectedAccumRappen: number;
  projectedNbvRappen: number;
  isFinal: boolean;
}

interface MethodDescriptor {
  key: string;
  requiresUnits: boolean;
  requiresRate: boolean;
  enabled: boolean;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function parseAssets(body: unknown): AssetLite[] {
  const rows = (body as { assets?: unknown })?.assets;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      id: str(r.id),
      number: str(r.number),
      name: str(r.name),
      depreciationMethod: str(r.depreciationMethod) || 'straight_line',
      status: str(r.status) || 'draft',
      acquisitionCostRappen: num(r.acquisitionCostRappen),
      residualValueRappen: num(r.residualValueRappen),
      netBookValueRappen: num(r.netBookValueRappen),
    }))
    .filter((a) => a.id !== '');
}

function parseMethods(body: unknown): MethodDescriptor[] {
  const rows = (body as { methods?: unknown })?.methods;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      key: str(r.key),
      requiresUnits: r.requiresUnits === true,
      requiresRate: r.requiresRate === true,
      enabled: r.enabled !== false,
    }))
    .filter((m) => m.key !== '');
}

export function AssetDepreciation() {
  const t = useT();
  const cal = useCalendarFormat();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const canManage = can(CAP.manageMasterData);

  const [assets, setAssets] = useState<AssetLite[]>([]);
  const [methods, setMethods] = useState<MethodDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const [assetId, setAssetId] = useState('');
  const [period, setPeriod] = useState(currentPeriod());
  const [unitsThisPeriod, setUnitsThisPeriod] = useState('');
  const [rateBp, setRateBp] = useState('');
  const [totalUnits, setTotalUnits] = useState('');

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [lines, setLines] = useState<ScheduleLine[]>([]);
  const [scheduleWarning, setScheduleWarning] = useState<string | null>(null);
  const [calcError, setCalcError] = useState<Err | null>(null);
  const [methodError, setMethodError] = useState<Err | null>(null);

  const selected = useMemo(() => assets.find((a) => a.id === assetId) ?? null, [assets, assetId]);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    const [listed, meth] = await Promise.all([
      client.call('asset_list', { workspaceId }),
      client.call('asset_depreciation_methods', { workspaceId }),
    ]);
    if (isErr(listed.body)) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setAssets(parseAssets(listed.body));
    if (!isErr(meth.body)) setMethods(parseMethods(meth.body));
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const overrideFor = useCallback(
    (id: string): { unitsByAsset?: Record<string, number>; paramsByAsset?: Record<string, unknown> } => {
      const out: { unitsByAsset?: Record<string, number>; paramsByAsset?: Record<string, unknown> } = {};
      const units = Number(unitsThisPeriod.trim());
      if (unitsThisPeriod.trim() !== '' && Number.isFinite(units)) out.unitsByAsset = { [id]: units };
      const params: Record<string, number> = {};
      const rate = Number(rateBp.trim());
      if (rateBp.trim() !== '' && Number.isFinite(rate)) params.decliningRateBp = rate;
      const total = Number(totalUnits.trim());
      if (totalUnits.trim() !== '' && Number.isFinite(total)) params.totalEstimatedUnits = total;
      if (Object.keys(params).length > 0) out.paramsByAsset = { [id]: params };
      return out;
    },
    [unitsThisPeriod, rateBp, totalUnits],
  );

  const runPreview = useCallback(async () => {
    if (workspaceId === null || assetId === '') return;
    setCalcError(null);
    setScheduleWarning(null);
    const ov = overrideFor(assetId);
    const forecast = ov.unitsByAsset ? { [period]: ov.unitsByAsset[assetId] } : undefined;
    const [prev, sched] = await Promise.all([
      client.call('asset_depreciation_preview', { workspaceId, period, assetIds: [assetId], ...ov }),
      client.call('asset_depreciation_schedule', {
        workspaceId,
        assetId,
        fromPeriod: period,
        ...(ov.paramsByAsset ? { params: ov.paramsByAsset[assetId] } : {}),
        ...(forecast ? { unitsForecast: forecast } : {}),
      }),
    ]);
    if (isErr(prev.body)) {
      setCalcError(prev.body);
      setPreview(null);
      setLines([]);
      return;
    }
    const results = (prev.body as { results?: unknown }).results;
    setPreview(Array.isArray(results) && results[0] ? (results[0] as PreviewResult) : null);
    if (!isErr(sched.body)) {
      const body = sched.body as { lines?: unknown; warning?: unknown };
      setLines(Array.isArray(body.lines) ? (body.lines as ScheduleLine[]) : []);
      setScheduleWarning(typeof body.warning === 'string' ? body.warning : null);
    } else {
      setLines([]);
    }
  }, [client, workspaceId, assetId, period, overrideFor]);

  // Recompute whenever the asset or period changes (and on first selection).
  useEffect(() => {
    if (assetId !== '' && PERIOD_RE.test(period)) void runPreview();
    else {
      setPreview(null);
      setLines([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, period]);

  const toggleMethod = useCallback(
    async (m: MethodDescriptor) => {
      if (workspaceId === null) return;
      setMethodError(null);
      const res = await client.call('asset_depreciation_method_set_enabled', {
        workspaceId,
        methodKey: m.key,
        enabled: !m.enabled,
        idempotencyKey: newKey(),
      });
      if (isErr(res.body)) {
        setMethodError(res.body);
        return;
      }
      const meth = await client.call('asset_depreciation_methods', { workspaceId });
      if (!isErr(meth.body)) setMethods(parseMethods(meth.body));
    },
    [client, workspaceId],
  );

  const scheduleColumns: DataTableColumn<ScheduleLine>[] = [
    { key: 'period', header: t('assets.depreciation.schedule.period'), render: (l) => cal.month(l.period) },
    { key: 'amount', header: t('assets.depreciation.schedule.amount'), numeric: true, render: (l) => money(l.amountRappen) },
    { key: 'accum', header: t('assets.depreciation.schedule.accum'), numeric: true, render: (l) => money(l.projectedAccumRappen) },
    { key: 'nbv', header: t('assets.depreciation.schedule.nbv'), numeric: true, render: (l) => money(l.projectedNbvRappen) },
    {
      key: 'final',
      header: t('assets.depreciation.schedule.final'),
      render: (l) => (l.isFinal ? t('assets.depreciation.schedule.final') : ''),
    },
  ];

  const methodColumns: DataTableColumn<MethodDescriptor>[] = [
    { key: 'method', header: t('assets.depreciation.methods.col.method'), render: (m) => t(`assets.depreciation.method.${m.key}`) },
    {
      key: 'requires',
      header: t('assets.depreciation.methods.col.requires'),
      render: (m) => (
        <>
          {m.requiresUnits ? t('assets.depreciation.methods.requiresUnits') : ''}
          {m.requiresRate ? t('assets.depreciation.methods.requiresRate') : ''}
        </>
      ),
    },
    {
      key: 'enabled',
      header: t('assets.depreciation.methods.col.enabled'),
      render: (m) => (
        <label className="fa-toggle">
          <input
            type="checkbox"
            checked={m.enabled}
            disabled={!canManage || m.key === 'none'}
            aria-label={`${t(`assets.depreciation.method.${m.key}`)} ${t('assets.depreciation.methods.enabled')}`}
            onChange={() => void toggleMethod(m)}
          />
          <span>{m.enabled ? t('assets.depreciation.yes') : t('assets.depreciation.no')}</span>
        </label>
      ),
    },
  ];

  if (workspaceId === null) return <NoWorkspaceState body={t('assets.depreciation.noWorkspace')} />;

  const method = selected?.depreciationMethod ?? '';
  const showUnits = method === 'units_of_production';
  const showRate = method === 'declining_balance';

  return (
    <div className="fa">
      <SurfaceHeader
        title={t('assets.depreciation.title')}
        subtitle={t('assets.depreciation.subtitle')}
        help={<SurfaceHelp surface="FixedAssets" />}
      />

      {failed && <ErrorBanner message={t('assets.depreciation.error.transport')} onRetry={() => void load()} />}

      {loading ? (
        <Skeleton rows={4} />
      ) : assets.length === 0 ? (
        <EmptyState title={t('assets.depreciation.empty.title')} hint={t('assets.depreciation.empty.hint')} />
      ) : (
        <>
          <div className="fa-filters">
            <div className="fa-field-inline">
              <span>{t('assets.depreciation.assetLabel')}</span>
              <Select
                ariaLabel={t('assets.depreciation.assetLabel')}
                value={assetId}
                onChange={(value) => setAssetId(value)}
                options={[
                  { value: '', label: t('assets.depreciation.chooseAsset') },
                  ...assets.map((a) => ({ value: a.id, label: `${a.number} ${a.name}` })),
                ]}
              />
            </div>
            <label className="fa-field-inline">
              <span>{t('assets.depreciation.period')}</span>
              <input
                className="field"
                type="month"
                aria-label={t('assets.depreciation.period')}
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
              />
            </label>
            {showUnits && (
              <label className="fa-field-inline">
                <span>{t('assets.depreciation.unitsThisPeriod')}</span>
                <input className="field" type="number" min={0} value={unitsThisPeriod} onChange={(e) => setUnitsThisPeriod(e.target.value)} />
              </label>
            )}
            {showUnits && (
              <label className="fa-field-inline">
                <span>{t('assets.depreciation.totalUnits')}</span>
                <input className="field" type="number" min={0} value={totalUnits} onChange={(e) => setTotalUnits(e.target.value)} />
              </label>
            )}
            {showRate && (
              <label className="fa-field-inline">
                <span>{t('assets.depreciation.rateBp')}</span>
                <input className="field" type="number" min={0} value={rateBp} onChange={(e) => setRateBp(e.target.value)} />
              </label>
            )}
            <button type="button" className="btn btn--ghost" onClick={() => void runPreview()} disabled={assetId === ''}>
              {t('assets.depreciation.refresh')}
            </button>
          </div>

          {(showUnits || showRate) && <p className="fa-hint">{t('assets.depreciation.paramHint')}</p>}

          {calcError && <ErrorBanner error={calcError} />}

          {selected !== null && preview !== null && (
            <section className="fa-summary" aria-label={t('assets.depreciation.nextAmount')}>
              <dl className="fa-summary-grid">
                <div>
                  <dt>{t('assets.depreciation.methodLabel')}</dt>
                  <dd>{t(`assets.depreciation.method.${method}`)}</dd>
                </div>
                <div>
                  <dt>{t('assets.depreciation.cost')}</dt>
                  <dd className="fa-num t-money">{money(selected.acquisitionCostRappen)}</dd>
                </div>
                <div>
                  <dt>{t('assets.depreciation.residual')}</dt>
                  <dd className="fa-num t-money">{money(selected.residualValueRappen)}</dd>
                </div>
                <div>
                  <dt>{t('assets.depreciation.nbv')}</dt>
                  <dd className="fa-num t-money">{money(selected.netBookValueRappen)}</dd>
                </div>
                <div>
                  <dt>{t('assets.depreciation.nextAmount')}</dt>
                  <dd className="fa-num fa-amount t-money">{money(preview.amountRappen)}</dd>
                </div>
                <div>
                  <dt>{t('assets.depreciation.isFinal')}</dt>
                  <dd>{preview.isFinal ? t('assets.depreciation.yes') : t('assets.depreciation.no')}</dd>
                </div>
                {typeof preview.remainingLifeMonths === 'number' && (
                  <div>
                    <dt>{t('assets.depreciation.remainingLife')}</dt>
                    <dd className="fa-num">{preview.remainingLifeMonths}</dd>
                  </div>
                )}
                {typeof preview.remainingUnits === 'number' && (
                  <div>
                    <dt>{t('assets.depreciation.remainingUnits')}</dt>
                    <dd className="fa-num">{preview.remainingUnits}</dd>
                  </div>
                )}
              </dl>
              <p className="fa-hint">{t(preview.reason ? `assets.depreciation.reason.${preview.reason}` : preview.explanation)}</p>
            </section>
          )}

          {selected !== null && (
            <section aria-label={t('assets.depreciation.schedule.title')}>
              <h2 className="fa-drawer-subtitle">{t('assets.depreciation.schedule.title')}</h2>
              {scheduleWarning === 'units_forecast_required' ? (
                <p className="fa-hint">{t('assets.depreciation.schedule.incomplete')}</p>
              ) : lines.length === 0 ? (
                <p className="fa-hint">{t('assets.depreciation.schedule.empty')}</p>
              ) : (
                <DataTable columns={scheduleColumns} rows={lines} rowKey={(l) => l.period} />
              )}
            </section>
          )}

          <section aria-label={t('assets.depreciation.methods.title')} className="fa-methods">
            <h2 className="fa-drawer-subtitle">{t('assets.depreciation.methods.title')}</h2>
            <p className="fa-hint">{t('assets.depreciation.methods.hint')}</p>
            {methodError && <ErrorBanner error={methodError} />}
            <DataTable columns={methodColumns} rows={methods} rowKey={(m) => m.key} />
          </section>
        </>
      )}
    </div>
  );
}

export default AssetDepreciation;
