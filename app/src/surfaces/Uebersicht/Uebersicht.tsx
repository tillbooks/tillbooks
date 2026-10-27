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
 * Range presets are computed client-side from the calendar; aligning the year preset to a
 * non-calendar fiscal year is a named refinement for the final UX pass (spec US-F00.3 boundary).
 *
 * D178 points 12 to 14 (N5): the bank action is a tile in the grid with its own button (or a card on
 * top, or the slim D142 bar: `overview.bank_action`); under the key figures sit the cards; the headline
 * figures count up under the Lively motion level, never the cash or a bank figure.
 *
 * D180 (owner, 24.10.2026): the page is arranged IN PLACE. One header icon, Anpassen, turns edit mode on
 * (it becomes Fertig; Escape is its twin). The key figures and the cards are two sortable zones: drag
 * the grip, or Alt+Arrow, or the item's Mehr menu (WCAG 2.5.7). The eye hides an item, which stays in
 * its slot as a ghost until Fertig, so all six cards are on the page while editing and that is the whole
 * card library. A card's width and the bank item's size sit behind Grösse ändern. Every change writes
 * at once through `usePref` (`overview.tiles`, `overview.widgets`, `overview.bank_action`), optimistic
 * and rolled back on a refusal, so there is no save button. Only the two bulk acts, Standard
 * wiederherstellen and applying a saved view, offer Rückgängig.
 *
 * Saved views ride G00's own verbs (`list_saved_views` / `create_saved_view`, entityKind `workspace`,
 * layout `dashboard`): `columns` are the visible key figures in order and `filters` carry the period,
 * the cards and the bank place. Choosing a view writes that layout into the person's preferences and
 * restores its period. Sharing is pre-disabled without `manage_saved_views`, the standing Studio rule:
 * a convenience, not the enforcement, G00's in-engine gate decides.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatMoney, formatDate } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton, useSkeletonHold } from '../../components/states';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Segmented } from '../../components/Segmented';
import { Select } from '../../components/Select';
import { IconButton } from '../../components/IconButton';
import { OverflowMenu } from '../../components/OverflowMenu';
import { ActionFeedback } from '../../components/ActionFeedback';
import { TooltipPortalContext, tooltipConsumedEscape } from '../../components/Tooltip';
import { SortableList } from '../../components/SortableList';
import type { SavedViewDto } from '../Customization/SavedViewPicker';
import { ViewPicker } from './ViewPicker';
import { AttentionStrip } from './AttentionStrip';
import { MandatesStrip } from './MandatesStrip';
import { SetupCard, workspaceHasData } from './SetupCard';
import { HomeDoors } from './HomeDoors';
import { BankBand } from './BankBand';
import { BankTile, bankFigures } from './BankTile';
import { EditItem, FaceSnapshot, Ghost, VisibilityToggle } from './EditControls';
import { ResetGlyph, SaveViewGlyph } from '../../components/icons';
import { OverviewWidget, SERIES_WIDGETS, useSeries } from './widgets';
import {
  arrangement,
  asBankPlace,
  asContent,
  moveSlot,
  moveSlotTo,
  seriesWindow,
  tileArrangement,
  toggleSlot,
  toggleWidth,
  viewLayout,
  withSlots,
  withTileOrder,
  withTiles,
  type BankActionPlace,
  type TileSlot,
  type WidgetSlot,
} from './layout';
import { usePref, type PrefValue } from '../../lib/prefs';
import { useCountUp } from '../../lib/motion';
import { Sparkline } from '../../components/charts/LineChart';
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
  };
}

/**
 * The dashboard-layout saved views `list_saved_views` returned, read defensively into the SHARED
 * picker's DTO (the same `SavedViewDto` Customization and Recurring feed their picker). A view of
 * another layout is not this surface's, and an unreadable row is dropped rather than trusted.
 */
function parseViews(body: unknown): SavedViewDto[] {
  const views = (body as { savedViews?: unknown })?.savedViews;
  if (!Array.isArray(views)) return [];
  return views.filter(
    (v): v is SavedViewDto =>
      v !== null &&
      typeof v === 'object' &&
      typeof (v as { viewId?: unknown }).viewId === 'string' &&
      typeof (v as { name?: unknown }).name === 'string' &&
      (v as { layout?: unknown }).layout === 'dashboard',
  );
}

/**
 * The tiles the band renders instead of the grid (D142): `bank_inbox` is the Bankeingang, a queue with
 * its own doors, not a figure among figures. It joins the tile zone as the bank ITEM (D180).
 */
const BANK = 'bank_inbox';

/**
 * Where a tile's click lands: its Studio route WITH the drill's params as a query string, so the
 * surface opens on what the figure counted (the drill used to drop them). `workspaceId` is the Studio's
 * own context, never a URL parameter, and only plain values travel.
 */
export function drillHref(drill: DrillDescriptor): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(drill.params ?? {})) {
    if (key === 'workspaceId') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') query.set(key, String(value));
  }
  const qs = query.toString();
  return qs === '' ? drill.studioRoute : `${drill.studioRoute}?${qs}`;
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

/**
 * A headline money figure that counts up under Lively (D178 point 14). While it moves, assistive tech
 * reads the final figure and the moving one is hidden from it; once landed it is plain text.
 */
function HeadlineMoney({ minor, currency }: { minor: number; currency: string }) {
  const shown = useCountUp(minor);
  if (shown === minor) return <>{formatMoney(minor, currency)}</>;
  return (
    <>
      <span className="visually-hidden">{formatMoney(minor, currency)}</span>
      <span aria-hidden="true">{formatMoney(shown, currency)}</span>
    </>
  );
}

/**
 * B5 (D178): the key-figure grid's column count on a wide home, chosen so no row is left nearly empty
 * (nine tiles are three rows of three, never four, four and one). Four unless three fills the last
 * row better; below the wide breakpoint the grid fills automatically.
 */
export function balancedColumns(count: number): number {
  const fill = (cols: number) => (count % cols === 0 ? 1 : (count % cols) / cols);
  return fill(3) > fill(4) ? 3 : 4;
}

/** Tiles whose figure never counts up: a bank or cash figure is something a person acts on. */
const STILL_TILES: ReadonlySet<string> = new Set(['cash', BANK]);

/** Trend: glyph AND signed figure, never colour or shape alone (WCAG 2.2 AA). */
function trendOf(trendBp: number | null | undefined): { glyph: string; label: string } | null {
  if (trendBp === null || trendBp === undefined) return null;
  const glyph = trendBp > 0 ? '▲' : trendBp < 0 ? '▼' : '–';
  return { glyph, label: formatBp(trendBp) };
}

/** A key figure's face: label, value, trend, the cash trend line and its as-of. */
function TileBody({ tile, cashTrend }: { tile: DashboardTileView; cashTrend: number[] | null }) {
  const t = useT();
  const trend = trendOf(tile.trendBp);
  const isMoney = typeof tile.valueRappen === 'number';
  const value =
    typeof tile.valueRappen === 'number' ? (
      STILL_TILES.has(tile.tile) ? (
        formatMoney(tile.valueRappen, tile.currency ?? 'CHF')
      ) : (
        <HeadlineMoney minor={tile.valueRappen} currency={tile.currency ?? 'CHF'} />
      )
    ) : typeof tile.valueBp === 'number' ? (
      formatBp(tile.valueBp)
    ) : (
      '–'
    );
  const caption =
    tile.asOf !== undefined ? formatDate(tile.asOf) : tile.range !== undefined ? `${formatDate(tile.range.from)} – ${formatDate(tile.range.to)}` : '';
  return (
    <>
      <span className="uebersicht-tile-head">
        <span aria-hidden="true" className="uebersicht-glyph">
          {tile.glyph ?? ''}
        </span>
        <span className="uebersicht-label">{t(`dashboard.tile.${tile.tile}`)}</span>
      </span>
      {/* A money figure is a money cell: tabular and never wrapped (K-18, the core's .t-money). */}
      <span className={isMoney ? 'uebersicht-value t-money' : 'uebersicht-value'}>{value}</span>
      {trend !== null ? (
        <span className="uebersicht-trend" aria-label={t('dashboard.trend.label', { value: trend.label })}>
          <span aria-hidden="true">{trend.glyph}</span> {trend.label}
        </span>
      ) : null}
      {tile.tile === 'cash' && cashTrend !== null ? <Sparkline values={cashTrend} /> : null}
      <span className="uebersicht-asof">{caption}</span>
    </>
  );
}

/** What a bulk act (reset, a view applied) replaced, so its Rückgängig can put it back. */
interface Snapshot {
  tiles: PrefValue;
  widgets: PrefValue;
  bank: string;
  preset: RangePreset;
  custom: { from: string; to: string };
  viewId: string | null;
}

const BANK_PLACES: readonly BankActionPlace[] = ['tile', 'card', 'bar'];

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
  const [views, setViews] = useState<SavedViewDto[]>([]);
  // The saved view last applied, shown in the picker until the layout is changed again.
  const [viewId, setViewId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [rangeError, setRangeError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveShared, setSaveShared] = useState(false);
  const [saveFailed, setSaveFailed] = useState<string | null>(null);

  // D180: the edit mode, its announcements, and the one bulk feedback with its Rückgängig.
  const [editing, setEditing] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [feedback, setFeedback] = useState<{ message: string; undo: Snapshot } | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  // The control that held the focus when an item moved: put back after the reorder renders.
  const refocus = useRef<HTMLElement | null>(null);

  const canShare = can(CAP.manageSavedViews);

  // D178 points 12 and 13, D180: the person's arrangement of this home.
  const [contentPref] = usePref<string>('overview.content');
  const [bankPref, setBankPref, bankMeta] = usePref<string>('overview.bank_action');
  const [widgetsPref, setWidgetsPref, widgetsMeta] = usePref<PrefValue>('overview.widgets');
  const [tilesPref, setTilesPref, tilesMeta] = usePref<PrefValue>('overview.tiles');
  const content = asContent(contentPref);
  const bankPlace = asBankPlace(bankPref);
  const slots = arrangement(content, widgetsPref);
  const shownSlots = slots.filter((slot) => slot.on);
  const window12 = seriesWindow(range.to);
  const needsSeries = content === 'trends' || shownSlots.some((slot) => SERIES_WIDGETS.has(slot.id));
  const [series, reloadSeries] = useSeries(workspaceId ?? '', window12, workspaceId !== null && needsSeries);

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
      client.call('dashboard_overview', { workspaceId, from: range.from, to: range.to }),
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
  }, [client, workspaceId, range.from, range.to]);

  useEffect(() => {
    void load();
  }, [load]);

  // After an item moved, the control that moved it keeps the focus (a reorder can move its node).
  useEffect(() => {
    const el = refocus.current;
    refocus.current = null;
    if (el !== null && el.isConnected && document.activeElement !== el) el.focus();
  });

  const wall = overview?.tiles.filter((tile) => tile.tile !== BANK) ?? [];
  // D178 point 12: the bank action's figures, from the same answer (null when omitted or degraded).
  const bankTile = bankFigures(overview?.tiles.find((tile) => tile.tile === BANK));
  const shown = wall.filter((tile) => tile.ok);
  const hiddenCount = wall.length - shown.length;
  // The bank is in the read (ok or degraded) unless RBAC omitted it: a degraded bank keeps its band,
  // whose own error state reads again; an omitted one is only the omitted footnote.
  const bankInRead = overview?.tiles.some((tile) => tile.tile === BANK) === true;
  const byTile = new Map(shown.map((tile) => [tile.tile, tile]));
  // The bank item leads the tile zone by default, where the bank tile always stood.
  const available = [...(bankInRead ? [BANK] : []), ...shown.map((tile) => tile.tile)];
  const tileSlots = tileArrangement(tilesPref, available);
  const bankOn = tileSlots.find((slot) => slot.id === BANK)?.on ?? true;

  const tileName = (id: string): string => (id === BANK ? t('dashboard.bank.title') : t(`dashboard.tile.${id}`));
  const cardName = (id: string): string => t(`dashboard.widget.name.${id}`);

  const snapshot = (): Snapshot => ({ tiles: tilesPref, widgets: widgetsPref, bank: bankPlace, preset, custom, viewId });

  /** Any single change: written at once, announced, and the last bulk feedback retired. */
  const changed = (message: string): void => {
    setAnnouncement(message);
    setFeedback(null);
    setViewId(null);
  };
  const writeTiles = (next: TileSlot[], message: string): void => {
    void setTilesPref(withTiles(tilesPref, next) as unknown as PrefValue);
    changed(message);
  };
  const writeCards = (next: WidgetSlot[], message: string): void => {
    void setWidgetsPref(withSlots(next) as unknown as PrefValue);
    changed(message);
  };
  const moved = (name: string, list: readonly { id: string }[], id: string): string =>
    t('dashboard.edit.announce.moved', { name, position: list.findIndex((s) => s.id === id) + 1, count: list.length });

  const moveTile = (index: number, delta: -1 | 1): void => {
    const slot = tileSlots[index];
    if (slot === undefined) return;
    refocus.current = document.activeElement as HTMLElement | null;
    const next = moveSlot(tileSlots, index, delta);
    writeTiles(next, moved(tileName(slot.id), next, slot.id));
  };
  const moveCard = (index: number, delta: -1 | 1): void => {
    const slot = slots[index];
    if (slot === undefined) return;
    refocus.current = document.activeElement as HTMLElement | null;
    const next = moveSlot(slots, index, delta);
    writeCards(next, moved(cardName(slot.id), next, slot.id));
  };
  const dropTile = (id: string, overId: string): void => {
    const next = moveSlotTo(tileSlots, id, overId);
    writeTiles(next, moved(tileName(id), next, id));
  };
  const dropCard = (id: string, overId: string): void => {
    const next = moveSlotTo(slots, id, overId);
    writeCards(next, moved(cardName(id), next, id));
  };
  const toggleTile = (slot: TileSlot): void =>
    writeTiles(toggleSlot(tileSlots, slot.id), t(slot.on ? 'dashboard.edit.announce.hidden' : 'dashboard.edit.announce.shown', { name: tileName(slot.id) }));
  const toggleCard = (slot: WidgetSlot): void =>
    writeCards(toggleSlot(slots, slot.id), t(slot.on ? 'dashboard.edit.announce.hidden' : 'dashboard.edit.announce.shown', { name: cardName(slot.id) }));
  const resizeCard = (slot: WidgetSlot): void =>
    writeCards(toggleWidth(slots, slot.id), t(slot.w === 'full' ? 'dashboard.edit.announce.half' : 'dashboard.edit.announce.full', { name: cardName(slot.id) }));
  const placeBank = (place: BankActionPlace): void => {
    void setBankPref(place);
    changed(t(`dashboard.edit.announce.bank.${place}`));
  };

  /** Put back what a bulk act replaced. */
  const restore = (before: Snapshot): void => {
    void setTilesPref(before.tiles);
    void setWidgetsPref(before.widgets);
    void setBankPref(before.bank);
    setPreset(before.preset);
    setCustom(before.custom);
    setViewId(before.viewId);
    setFeedback(null);
    setAnnouncement(t('dashboard.edit.undone'));
  };

  const isDefault = tilesMeta.isDefault && widgetsMeta.isDefault && bankMeta.isDefault;
  // While the layout matches neither the standard nor the view last applied, the picker says so.
  const customised = viewId === null && !isDefault;
  const resetLayout = (): void => {
    const before = snapshot();
    void tilesMeta.reset();
    void widgetsMeta.reset();
    void bankMeta.reset();
    setViewId(null);
    setFeedback({ message: t('dashboard.edit.resetDone'), undo: before });
  };

  const applyView = (id: string | null): void => {
    if (id === null) {
      resetLayout();
      return;
    }
    const view = views.find((v) => v.viewId === id);
    if (view === undefined) return;
    const before = snapshot();
    const layout = viewLayout(view);
    if (layout.tiles !== undefined) void setTilesPref(layout.tiles as unknown as PrefValue);
    else if (layout.tileOrder !== undefined) void setTilesPref(withTiles(tilesPref, withTileOrder(tileSlots, layout.tileOrder)) as unknown as PrefValue);
    if (layout.widgets !== undefined) void setWidgetsPref(layout.widgets as unknown as PrefValue);
    if (layout.bankAction !== undefined) void setBankPref(layout.bankAction);
    if (layout.rangePreset !== undefined) setPreset(layout.rangePreset);
    if (layout.custom !== undefined) setCustom(layout.custom);
    setViewId(id);
    setFeedback({ message: t('dashboard.edit.viewApplied', { name: view.name }), undo: before });
  };

  const saveView = useCallback(async () => {
    if (workspaceId === null || saveName.trim() === '') return;
    setSaveFailed(null);
    const response = await client.call('create_saved_view', {
      workspaceId,
      entityKind: 'workspace',
      name: saveName.trim(),
      layout: 'dashboard',
      columns: tileSlots.filter((slot) => slot.on).map((slot) => slot.id),
      filters: {
        rangePreset: preset,
        ...(preset === 'custom' ? { from: custom.from, to: custom.to } : {}),
        widgets: withSlots(slots),
        bankAction: bankPlace,
        tiles: withTiles(tilesPref, tileSlots),
      },
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
    await load();
    if (typeof created?.viewId === 'string') setViewId(created.viewId);
  }, [client, workspaceId, saveName, saveShared, preset, custom, tilesPref, tileSlots, slots, bankPlace, load]);

  const toggleButton = (): HTMLElement | null => rootRef.current?.querySelector<HTMLElement>('[data-edit-toggle]') ?? null;
  const startEditing = (): void => {
    setEditing(true);
    setAnnouncement(t('dashboard.edit.announce.start'));
  };
  const stopEditing = (): void => {
    setEditing(false);
    setAnnouncement(t('dashboard.edit.announce.end'));
    toggleButton()?.focus();
  };
  const onRootKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // The Escape that only closed a tooltip bubble is spent on it; the next one leaves the mode.
    if (event.key !== 'Escape' || event.defaultPrevented || tooltipConsumedEscape(event)) return;
    if (saving) {
      event.preventDefault();
      setSaving(false);
      return;
    }
    if (editing) {
      event.preventDefault();
      stopEditing();
    }
  };

  // K-34: nothing before 200ms, and a skeleton that appeared stays at least 300ms.
  const showSkeleton = useSkeletonHold(loading);

  if (workspaceId === null) return <NoWorkspaceState />;

  // The trend line on the cash tile under "Verlauf": the running net of the series' months.
  const cashTrend =
    content === 'trends' && series.state === 'ready'
      ? series.data.months.reduce<number[]>((acc, m) => [...acc, (acc[acc.length - 1] ?? 0) + m.inMinor - m.outMinor], [])
      : null;
  const rangeOptions = (['month', 'quarter', 'year', 'custom'] as const).map((p) => ({ value: p, label: t(`dashboard.range.${p}`) }));

  // Outside edit mode the zones hold what shows; inside, every slot (hidden ones as ghosts), and the bank
  // item sits in the tile zone whatever its place.
  const gridSlots = editing
    ? tileSlots
    : tileSlots.filter((slot) => slot.on && (slot.id !== BANK || (bankPlace === 'tile' && bankTile !== null)));
  const cardSlots = editing ? slots : shownSlots;
  const ready = !failed && overview !== null;

  const bankTools = (
    <OverflowMenu
      icon="resize"
      quiet
      portal
      className="uebersicht-bank-size"
      label={t('dashboard.edit.bankSize', { name: tileName(BANK) })}
      tooltip={t('dashboard.edit.bankSizeTip', { place: t(`dashboard.edit.bankPlace.${bankPlace}`) })}
      items={BANK_PLACES.map((place) => ({
        key: place,
        label: t(`dashboard.edit.bankPlace.${place}`),
        onSelect: () => placeBank(place),
        checked: place === bankPlace,
      }))}
    />
  );

  const tileItem = (slot: TileSlot, index: number): ReactNode => {
    const name = tileName(slot.id);
    const tools = (
      <>
        <VisibilityToggle name={name} on={slot.on} onToggle={() => toggleTile(slot)} />
        {slot.id === BANK ? bankTools : null}
      </>
    );
    let face: ReactNode;
    if (editing && !slot.on) {
      face = <Ghost name={name} />;
    } else if (slot.id === BANK) {
      // A degraded bank (its figures did not read) is still arrangeable: a plain face with its name.
      face = bankTile === null ? <Ghost name={name} state={t('dashboard.edit.unavailable')} /> : <BankTile figures={bankTile} variant="tile" />;
    } else {
      const tile = byTile.get(slot.id);
      if (tile === undefined) return null;
      const drill = tile.drill;
      // A tile that drills is a real control: the Wave 1 `.panel--interactive` treatment gives it a
      // pointer, a resting control shadow and a hover-lift. A tile with no drill, and every tile while
      // editing, is inert, so arranging never navigates away.
      face =
        drill !== undefined ? (
          <button
            type="button"
            className="uebersicht-tile panel--interactive"
            // While editing the same button stays mounted (inside the item's inert face), so switching
            // modes never remounts the figure or replays its count-up.
            onClick={() => {
              if (!editing) navigate(drillHref(drill));
            }}
          >
            <TileBody tile={tile} cashTrend={cashTrend} />
          </button>
        ) : (
          <div className="uebersicht-tile uebersicht-tile--inert">
            <TileBody tile={tile} cashTrend={cashTrend} />
          </div>
        );
    }
    return (
      <EditItem
        key={slot.id}
        id={slot.id}
        name={name}
        editing={editing}
        as="li"
        index={index}
        count={gridSlots.length}
        onMove={(delta) => moveTile(index, delta)}
        tools={tools}
        ghost={editing && !slot.on}
      >
        {face}
      </EditItem>
    );
  };

  const cardItem = (slot: WidgetSlot, index: number): ReactNode => {
    const name = cardName(slot.id);
    const full = slot.w === 'full';
    return (
      <EditItem
        key={slot.id}
        id={slot.id}
        name={name}
        editing={editing}
        as="div"
        className={full ? 'uebersicht-card uebersicht-widget--full' : 'uebersicht-card'}
        index={index}
        count={cardSlots.length}
        onMove={(delta) => moveCard(index, delta)}
        ghost={editing && !slot.on}
        tools={
          <>
            <VisibilityToggle name={name} on={slot.on} onToggle={() => toggleCard(slot)} />
            <IconButton
              icon="resize"
              small
              context={t(full ? 'dashboard.edit.widthHalf' : 'dashboard.edit.widthFull', { name })}
              aria-pressed={full}
              onClick={() => resizeCard(slot)}
            />
          </>
        }
      >
        {editing && !slot.on ? (
          <Ghost name={name} />
        ) : (
          <OverviewWidget id={slot.id} workspaceId={workspaceId} series={series} reloadSeries={reloadSeries} />
        )}
      </EditItem>
    );
  };

  /**
   * What follows the pointer while an item is dragged: a DOM clone of the item's own face (never a
   * serialised string), lifted. Nothing mounts a second time, so a card never reads again for its
   * preview, and the slot it left reads as the drop placeholder.
   */
  const overlayOf = (id: string): ReactNode => {
    const face = rootRef.current?.querySelector(`[data-slot="${id}"] .uebersicht-item__face`);
    if (face === null || face === undefined) return null;
    return <FaceSnapshot face={face} />;
  };

  return (
    // Every tooltip on this surface opens in the overlay layer: flipped and held 8px inside the viewport,
    // so a corner icon's bubble never runs off the page or widens it.
    <TooltipPortalContext.Provider value={true}>
    <section
      className={editing ? 'uebersicht is-editing' : 'uebersicht'}
      aria-labelledby="uebersicht-title"
      ref={rootRef}
      onKeyDown={onRootKeyDown}
    >
      {/* F-13 (J2.5): a member of several mandates sees every mandate's waiting count here, on the
          one personalised home (D118 A5); it renders nothing for a single workspace. */}
      <MandatesStrip />
      <SurfaceHeader
        title={t('dashboard.route.title')}
        titleId="uebersicht-title"
        help={<SurfaceHelp surface="Uebersicht" />}
        // F-05: the daily doors (Buchen, Sichern, and the demo while the books are empty) are the
        // home's header actions, always visible, so the collapsed rail never hides them.
        actions={<HomeDoors fresh={overview !== null && !workspaceHasData(overview.tiles)} />}
      />
      {/* K-13: on a fresh, data-less workspace the setup steps are the point of the page, so they
          lead, directly under the header and ABOVE the range controls. */}
      {!loading && ready ? <SetupCard tiles={overview.tiles} /> : null}
      {/* D142: the Bankeingang band, or the bank card, above the range controls because it is current
          work, not a figure of the chosen period. While editing, the bank item sits in the tile zone. */}
      {/* Only where the read returned the bank: an omitted one is the footnote's, like any tile. */}
      {!editing && bankOn && bankPlace === 'bar' && bankInRead ? <BankBand /> : null}
      {!editing && bankOn && bankPlace === 'card' && bankTile !== null ? <BankTile figures={bankTile} variant="card" /> : null}
      {/* A degraded bank in the card place shows the band, whose own error state reads again (as in the bar). */}
      {!editing && bankOn && bankPlace === 'card' && bankTile === null && bankInRead ? <BankBand /> : null}
      <div className="uebersicht-controls">
        {/* K-11/K-12 (D137): the range is the shared Segmented control, four sibling values of one
            view. Its chosen segment is a neutral raise. */}
        <Segmented className="uebersicht-range" label={t('dashboard.range.label')} options={rangeOptions} value={preset} onChange={setPreset} />
        {/* B5 (D178): at phone width the four segments overflow the gutter, so the same choice is the
            shared Select there; CSS shows exactly one of the two. */}
        <Select
          className="uebersicht-range-select"
          ariaLabel={t('dashboard.range.label')}
          options={rangeOptions}
          value={preset}
          onChange={(next) => setPreset(next as RangePreset)}
        />
        {preset === 'custom' ? (
          <div className="uebersicht-custom">
            <label>
              {t('dashboard.range.from')}
              <input type="date" className="field" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            </label>
            <label>
              {t('dashboard.range.to')}
              <input type="date" className="field" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </label>
          </div>
        ) : null}
        {/* The SHARED saved-view picker, shown only once a dashboard view exists: with none, a lone
            "Standardansicht" option is noise. Choosing a view applies its layout and its period. */}
        {views.length > 0 ? (
          <ViewPicker
            views={views}
            selected={viewId}
            customised={customised}
            label={t('dashboard.view.label')}
            defaultOptionLabel={t('dashboard.view.default')}
            customisedLabel={t('dashboard.view.customised')}
            personalGroupLabel={t('dashboard.view.personalGroup')}
            sharedGroupLabel={t('dashboard.view.sharedGroup')}
            onSelect={applyView}
          />
        ) : null}
        {ready ? (
          <div className="uebersicht-controls__tools">
            <IconButton
              icon={editing ? 'done' : 'customize'}
              context={t(editing ? 'dashboard.edit.done' : 'dashboard.edit.customize')}
              data-edit-toggle=""
              onClick={editing ? stopEditing : startEditing}
            />
            <OverflowMenu
              icon="more"
              quiet
              portal
              label={t('dashboard.edit.pageMore')}
              tooltip={t('dashboard.edit.pageMoreTip')}
              items={[
                { key: 'save', label: t('dashboard.edit.saveView'), glyph: <SaveViewGlyph size={16} />, onSelect: () => setSaving(true) },
                { key: 'reset', label: t('dashboard.edit.reset'), glyph: <ResetGlyph size={16} />, onSelect: resetLayout, disabled: isDefault },
              ]}
            />
          </div>
        ) : null}
      </div>

      {saving ? (
        <form
          className="uebersicht-save-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveView();
          }}
        >
          <label>
            {t('dashboard.view.name')}
            {/* The field opens because the person asked for it, so it takes the focus. */}
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input type="text" className="field" value={saveName} onChange={(e) => setSaveName(e.target.value)} maxLength={120} autoFocus />
          </label>
          <label className="uebersicht-share">
            <input type="checkbox" checked={saveShared} disabled={!canShare} onChange={(e) => setSaveShared(e.target.checked)} />
            {t('dashboard.view.shared')}
          </label>
          <IconButton icon="done" type="submit" small name={t('dashboard.edit.saveConfirm')} context={t('dashboard.edit.saveConfirmContext')} disabled={saveName.trim() === ''} />
          <IconButton icon="close" small context={t('dashboard.edit.saveCancel')} onClick={() => setSaving(false)} />
          {saveFailed !== null ? (
            <span role="alert" className="uebersicht-save-error">
              {t('dashboard.view.save_failed')}
            </span>
          ) : null}
        </form>
      ) : null}

      {/* The period caption and, beside it, the one quiet line a bulk act leaves (with its Rückgängig):
          the line shares the caption's row, so nothing below it moves. */}
      <div className="uebersicht-caption-row">
        <p className="uebersicht-caption">
          {formatDate(range.from)} – {formatDate(range.to)}
        </p>
        {feedback !== null ? (
          <ActionFeedback tone="success" message={feedback.message} className="uebersicht-feedback">
            <button type="button" className="btn btn--ghost btn--sm uebersicht-feedback__undo" onClick={() => restore(feedback.undo)}>
              {t('dashboard.edit.undo')}
            </button>
          </ActionFeedback>
        ) : null}
      </div>

      {rangeError ? (
        <p className="uebersicht-range-error" role="alert">
          {t('dashboard.error.invalid_range')}
        </p>
      ) : null}

      {showSkeleton ? (
        // K-34: eight tiles in the wall's own 4 x 2 shape, not four full-width bars that grow later.
        <div className="uebersicht-grid-skeleton">
          <Skeleton rows={8} columns={4} height={112} />
        </div>
      ) : failed ? (
        // K-35: a failed READ says so (no "prüfe die Eingaben" on a page load) and can be reported.
        <ErrorBanner context="read" message={t('dashboard.error.read')} onRetry={() => void load()} />
      ) : overview === null ? null : shown.length === 0 ? (
        // K-33: the first booking is what fills the wall, so the empty state offers it.
        <EmptyState title={t('dashboard.empty.title')} hint={t('dashboard.empty.hint')} action={{ label: t('command.post_entry.label'), to: '/journal?new=1' }} />
      ) : (
        <SortableList
          ids={gridSlots.map((slot) => slot.id)}
          onReorder={dropTile}
          className="uebersicht-grid"
          strategy="rect"
          style={{ ['--uebersicht-cols' as string]: balancedColumns(gridSlots.length) }}
          ariaLabel={editing ? t('dashboard.edit.tilesLabel') : undefined}
          renderOverlay={overlayOf}
          overlayClassName="uebersicht-overlay"
          touch="longPress"
        >
          {gridSlots.map((slot, i) => tileItem(slot, i))}
        </SortableList>
      )}

      {/* D90 D-2, placed by the B5 judge (D178): the waiting work, one line per item, BELOW the title and
          the key figures, fed by G15's attention_summary. */}
      <AttentionStrip />

      {/* D178 point 13, D180: the cards, in the person's order and width. */}
      {ready && cardSlots.length > 0 ? (
        <SortableList
          ids={cardSlots.map((slot) => slot.id)}
          onReorder={dropCard}
          className="uebersicht-widgets"
          as="div"
          strategy="rect"
          renderOverlay={overlayOf}
          overlayClassName="uebersicht-overlay"
          touch="longPress"
        >
          {cardSlots.map((slot, i) => cardItem(slot, i))}
        </SortableList>
      ) : null}

      {!loading && hiddenCount > 0 ? <p className="uebersicht-note">{t('dashboard.more_tiles')}</p> : null}
      {!loading && (overview?.omitted.length ?? 0) > 0 ? <p className="uebersicht-note">{t('dashboard.omitted_note')}</p> : null}

      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </section>
    </TooltipPortalContext.Provider>
  );
}

export default Uebersicht;
