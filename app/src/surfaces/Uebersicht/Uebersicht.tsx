/**
 * F00, Übersicht (`/uebersicht`): the KPI tile wall, and the Studio landing page.
 *
 * ONE read (`dashboard_overview`) renders the whole grid: every tile arrives with its value, its
 * as-of, its drill descriptor and its structured state, so this surface composes NOTHING itself. A
 * degraded tile (`ok:false`) is HIDDEN behind the "Weitere Kacheln" hint (spec US-F00.5: an
 * unconfigured module is "not applicable", never a fake zero); an OMITTED tile (RBAC, US-F00.6) is
 * a single neutral footnote, because the omission already happened server-side and repeating it per
 * tile would turn a permission boundary into a wall of warnings.
 *
 * The saved-view picker and Ansicht speichern ride G00's own verbs (`list_saved_views` /
 * `create_saved_view`, entityKind `workspace`, layout `dashboard`); F00 only passes the chosen
 * `savedViewId` back into the read. Sharing is pre-disabled without `manage_saved_views`, the
 * standing Studio rule: a convenience, not the enforcement, G00's in-engine gate decides.
 *
 * Range presets are computed client-side from the calendar; aligning the year preset to a
 * non-calendar fiscal year is a named refinement for the final UX pass (spec US-F00.3 boundary).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton } from '../../components/states';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { AttentionStrip } from './AttentionStrip';
import { MandatesStrip } from './MandatesStrip';
import { SetupCard, workspaceHasData } from './SetupCard';
import { HomeDoors } from './HomeDoors';
import './Uebersicht.css';

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();

export interface DrillDescriptor {
  studioRoute: string;
  mcpTool: string;
  params: Record<string, unknown>;
}

export interface DashboardTileView {
  tile: string;
  ok: boolean;
  error?: string;
  valueRappen?: number;
  valueBp?: number | null;
  currency?: string;
  asOf?: string;
  range?: { from: string; to: string };
  trendBp?: number | null;
  glyph?: string;
  drill?: DrillDescriptor;
  detail?: Record<string, unknown>;
}

interface OverviewView {
  tiles: DashboardTileView[];
  omitted: { tile: string; error: string }[];
  viewFallback: boolean;
}

/** Read the engine's payload defensively: a shape this surface cannot read is a failed READ. */
function parseOverview(body: unknown): OverviewView | null {
  if (body === null || typeof body !== 'object') return null;
  const tiles = (body as { tiles?: unknown }).tiles;
  const omitted = (body as { omitted?: unknown }).omitted;
  if (!Array.isArray(tiles) || !Array.isArray(omitted)) return null;
  const parsed: DashboardTileView[] = [];
  for (const raw of tiles) {
    if (raw === null || typeof raw !== 'object') return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.tile !== 'string' || typeof t.ok !== 'boolean') return null;
    parsed.push(t as unknown as DashboardTileView);
  }
  return {
    tiles: parsed,
    omitted: omitted.filter(
      (o): o is { tile: string; error: string } =>
        o !== null && typeof o === 'object' && typeof (o as { tile?: unknown }).tile === 'string',
    ),
    viewFallback: (body as { viewFallback?: unknown }).viewFallback === true,
  };
}

interface SavedView {
  id: string;
  name: string;
}

function parseViews(body: unknown): SavedView[] {
  const views = (body as { savedViews?: unknown })?.savedViews;
  if (!Array.isArray(views)) return [];
  return views
    .filter(
      (v): v is { viewId: string; name: string; layout: string } =>
        v !== null &&
        typeof v === 'object' &&
        typeof (v as { viewId?: unknown }).viewId === 'string' &&
        typeof (v as { name?: unknown }).name === 'string',
    )
    .filter((v) => v.layout === 'dashboard')
    .map((v) => ({ id: v.viewId, name: v.name }));
}

export type RangePreset = 'month' | 'quarter' | 'year' | 'custom';

/** The calendar window of a preset around `today` (an ISO day). */
export function presetRange(preset: RangePreset, today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const pad = (n: number) => String(n).padStart(2, '0');
  const endOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (preset === 'month') {
    return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(endOfMonth(year, month))}` };
  }
  if (preset === 'quarter') {
    const q0 = Math.floor((month - 1) / 3) * 3 + 1;
    return { from: `${year}-${pad(q0)}-01`, to: `${year}-${pad(q0 + 2)}-${pad(endOfMonth(year, q0 + 2))}` };
  }
  // 'year' and the 'custom' seed: the calendar year.
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** `8250` -> `82.5 %`: basis points to one display decimal, rounded once, locale-stable. */
function formatBp(bp: number): string {
  const tenths = Math.round(Math.abs(bp) / 10);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  const sign = bp < 0 ? '-' : '';
  return `${sign}${whole}${frac === 0 ? '' : `.${frac}`} %`;
}

/** Trend: glyph AND signed figure, never colour or shape alone (WCAG 2.2 AA). */
function trendOf(trendBp: number | null | undefined): { glyph: string; label: string } | null {
  if (trendBp === null || trendBp === undefined) return null;
  const glyph = trendBp > 0 ? '▲' : trendBp < 0 ? '▼' : '–';
  return { glyph, label: formatBp(trendBp) };
}

export function Uebersicht() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const { can } = useCapabilities();

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [preset, setPreset] = useState<RangePreset>('month');
  const [custom, setCustom] = useState<{ from: string; to: string }>(() => presetRange('month', today));
  const range = preset === 'custom' ? custom : presetRange(preset, today);

  const [overview, setOverview] = useState<OverviewView | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewId, setViewId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [rangeError, setRangeError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveShared, setSaveShared] = useState(false);
  const [saveFailed, setSaveFailed] = useState<string | null>(null);

  const canShare = can(CAP.manageSavedViews);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    if (range.from > range.to) {
      setRangeError(true);
      return;
    }
    setRangeError(false);
    setLoading(true);
    setFailed(false);
    const [wall, savedViews] = await Promise.all([
      client.call('dashboard_overview', {
        workspaceId,
        from: range.from,
        to: range.to,
        ...(viewId === '' ? {} : { savedViewId: viewId }),
      }),
      client.call('list_saved_views', { workspaceId, entityKind: 'workspace' }),
    ]);
    if (isErr(wall.body)) {
      setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseOverview(wall.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setOverview(parsed);
    // The picker degrades honestly: a refused view read leaves the picker empty, the wall intact.
    if (!isErr(savedViews.body)) setViews(parseViews(savedViews.body));
    setLoading(false);
  }, [client, workspaceId, range.from, range.to, viewId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveView = useCallback(async () => {
    if (workspaceId === null || overview === null || saveName.trim() === '') return;
    setSaveFailed(null);
    const rendered = overview.tiles.filter((tile) => tile.ok).map((tile) => tile.tile);
    const response = await client.call('create_saved_view', {
      workspaceId,
      entityKind: 'workspace',
      name: saveName.trim(),
      layout: 'dashboard',
      columns: rendered,
      filters: { rangePreset: preset },
      ...(saveShared ? { shared: true } : {}),
      idempotencyKey: newKey(),
    });
    if (isErr(response.body)) {
      setSaveFailed(response.body.error);
      return;
    }
    const created = (response.body as unknown as { savedView?: { viewId?: string } }).savedView;
    setSaving(false);
    setSaveName('');
    setSaveShared(false);
    if (typeof created?.viewId === 'string') setViewId(created.viewId);
    else await load();
  }, [client, workspaceId, overview, saveName, saveShared, preset, load]);

  if (workspaceId === null) return <NoWorkspaceState />;

  const shown = overview?.tiles.filter((tile) => tile.ok) ?? [];
  const hiddenCount = (overview?.tiles.length ?? 0) - shown.length;

  return (
    <section className="uebersicht" aria-labelledby="uebersicht-title">
      {/* F-13 (J2.5): a member of several mandates sees every mandate's waiting count here, on the
          one personalised home (D118 A5); it renders nothing for a single workspace. */}
      <MandatesStrip />
      {/* D90 D-2: the dashboard's top row names the waiting work, fed by G15's attention_summary. */}
      <AttentionStrip />
      <SurfaceHeader
        title={t('dashboard.route.title')}
        titleId="uebersicht-title"
        help={<SurfaceHelp surface="Uebersicht" />}
        // F-05: the daily doors (Buchen, Sichern, and the demo while the books are empty) are the
        // home's header actions, always visible, so the collapsed rail never hides them.
        actions={<HomeDoors fresh={overview !== null && !workspaceHasData(overview.tiles)} />}
      />
      <div className="uebersicht-controls">
        <div className="uebersicht-range" role="group" aria-label={t('dashboard.range.label')}>
          {(['month', 'quarter', 'year', 'custom'] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={p === preset ? 'uebersicht-preset is-active' : 'uebersicht-preset'}
              aria-pressed={p === preset}
              onClick={() => setPreset(p)}
            >
              {t(`dashboard.range.${p}`)}
            </button>
          ))}
        </div>
        {preset === 'custom' ? (
          <div className="uebersicht-custom">
            <label>
              {t('dashboard.range.from')}
              <input
                type="date"
                value={custom.from}
                onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
              />
            </label>
            <label>
              {t('dashboard.range.to')}
              <input
                type="date"
                value={custom.to}
                onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              />
            </label>
          </div>
        ) : null}
        <label className="uebersicht-view">
          {t('dashboard.view.label')}
          <select value={viewId} onChange={(e) => setViewId(e.target.value)}>
            <option value="">{t('dashboard.view.default')}</option>
            {views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="uebersicht-save" onClick={() => setSaving((s) => !s)}>
          {t('dashboard.view.save')}
        </button>
      </div>

      <p className="uebersicht-caption">
        {formatDate(range.from)} – {formatDate(range.to)}
      </p>

      {rangeError ? <p className="uebersicht-range-error" role="alert">{t('dashboard.error.invalid_range')}</p> : null}
      {overview?.viewFallback ? <p className="uebersicht-note">{t('dashboard.view.fallback_note')}</p> : null}

      {saving ? (
        <div className="uebersicht-save-form">
          <label>
            {t('dashboard.view.name')}
            <input type="text" value={saveName} onChange={(e) => setSaveName(e.target.value)} maxLength={120} />
          </label>
          <label className="uebersicht-share">
            <input
              type="checkbox"
              checked={saveShared}
              disabled={!canShare}
              onChange={(e) => setSaveShared(e.target.checked)}
            />
            {t('dashboard.view.shared')}
          </label>
          <button type="button" onClick={() => void saveView()} disabled={saveName.trim() === ''}>
            {t('dashboard.view.confirm')}
          </button>
          {saveFailed !== null ? <span role="alert" className="uebersicht-save-error">{t('dashboard.view.save_failed')}</span> : null}
        </div>
      ) : null}

      {!loading && !failed && overview !== null ? <SetupCard tiles={overview.tiles} /> : null}

      {loading ? (
        <Skeleton rows={4} height={96} />
      ) : failed ? (
        <ErrorBanner onRetry={() => void load()} />
      ) : overview === null ? null : shown.length === 0 ? (
        <EmptyState title={t('dashboard.empty.title')} hint={t('dashboard.empty.hint')} />
      ) : (
        <ul className="uebersicht-grid">
          {shown.map((tile) => {
            const trend = trendOf(tile.trendBp);
            const value =
              typeof tile.valueRappen === 'number'
                ? formatMoney(tile.valueRappen, tile.currency ?? 'CHF')
                : typeof tile.valueBp === 'number'
                  ? formatBp(tile.valueBp)
                  : '–';
            const caption = tile.asOf !== undefined ? formatDate(tile.asOf) : tile.range !== undefined ? `${formatDate(tile.range.from)} – ${formatDate(tile.range.to)}` : '';
            return (
              <li key={tile.tile}>
                <button
                  type="button"
                  className="uebersicht-tile"
                  onClick={() => {
                    if (tile.drill !== undefined) navigate(tile.drill.studioRoute);
                  }}
                >
                  <span className="uebersicht-tile-head">
                    <span aria-hidden="true" className="uebersicht-glyph">
                      {tile.glyph ?? ''}
                    </span>
                    <span className="uebersicht-label">{t(`dashboard.tile.${tile.tile}`)}</span>
                  </span>
                  <span className="uebersicht-value">{value}</span>
                  {trend !== null ? (
                    <span className="uebersicht-trend" aria-label={t('dashboard.trend.label', { value: trend.label })}>
                      <span aria-hidden="true">{trend.glyph}</span> {trend.label}
                    </span>
                  ) : null}
                  <span className="uebersicht-asof">{caption}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && hiddenCount > 0 ? <p className="uebersicht-note">{t('dashboard.more_tiles')}</p> : null}
      {!loading && (overview?.omitted.length ?? 0) > 0 ? (
        <p className="uebersicht-note">{t('dashboard.omitted_note')}</p>
      ) : null}
    </section>
  );
}

export default Uebersicht;
