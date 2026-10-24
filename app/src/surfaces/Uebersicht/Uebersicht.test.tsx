/**
 * F00, the Übersicht tile wall (spec §8): the per-tile states (skeleton, zero state,
 * degraded-hidden with the "Weitere Kacheln" hint, success with the trend glyph+figure, omitted
 * footnote), range validation, the saved-view picker, tile drill navigation, Als Ansicht speichern
 * sending G00 the visible tiles and the layout, and the D180 edit mode (moves by keyboard and by
 * the Mehr menu, hide and show through ghosts, card width, bank size, reset with Rückgängig). The
 * transport is canned per action, so every assertion is about what the surface sends and renders,
 * not about the engine.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import { Uebersicht, presetRange, drillHref } from './index';
import { PrefsProvider, PrefsStore, type PrefValue } from '../../lib/prefs';
import type { SortableListProps } from '../../components/SortableList';

/**
 * The drag seam (D180): the real SortableList renders, and each list's `onReorder` is kept by its class
 * name, so a test can finish a drag the way dnd-kit's onDragEnd would without simulating pointer
 * geometry jsdom does not have. `reorderOf` (the event-to-reorder step) is covered in
 * `components/SortableList.test.tsx`.
 */
const reorders = vi.hoisted(() => new Map<string, (id: string, overId: string) => void>());
vi.mock('../../components/SortableList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/SortableList')>();
  return {
    ...actual,
    SortableList: (props: SortableListProps) => {
      reorders.set(props.className, props.onReorder);
      return actual.SortableList(props);
    },
  };
});

/**
 * Let the drag context finish its own mount work (its live region and its droppable registry) inside
 * act, before a test goes on to something that does not wait, like axe.
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The headline count-up (D178 point 14) is a Lively animation; these tests are about states and
// figures, so the root runs Calm and every figure is final from its first frame. The count-up itself
// is proven in `lib/motion-levels.test.tsx`.
beforeEach(() => {
  document.documentElement.setAttribute('data-motion', 'calm');
});

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

const DRILL = (route: string) => ({ studioRoute: route, mcpTool: 'aging_report', params: { workspaceId: 'ws_test' } });

const TILES = [
  {
    tile: 'revenue',
    ok: true,
    valueRappen: 3000000,
    currency: 'CHF',
    range: { from: '2026-07-01', to: '2026-07-31' },
    trendBp: 250,
    glyph: '◆',
    drill: DRILL('/reports'),
    detail: {},
  },
  {
    tile: 'cash',
    ok: true,
    valueRappen: 1250000,
    currency: 'CHF',
    asOf: '2026-07-31',
    glyph: '●',
    drill: DRILL('/bank-accounts'),
    detail: {},
  },
  {
    tile: 'ar_aging',
    ok: true,
    valueRappen: 850000,
    currency: 'CHF',
    asOf: '2026-07-31',
    glyph: '◧',
    drill: DRILL('/open-items'),
    detail: {},
  },
  {
    tile: 'utilisation',
    ok: true,
    valueBp: 8250,
    currency: 'CHF',
    range: { from: '2026-07-01', to: '2026-07-31' },
    glyph: '◔',
    drill: DRILL('/time'),
    detail: { totalMinutes: 0 },
  },
  { tile: 'mwst_due', ok: false, error: 'needs_vat_config', glyph: '▣' },
  { tile: 'stock_value', ok: false, error: 'needs_stock_items', glyph: '▦' },
] as const;

/** D178 point 13: the series behind the charts, twelve months, as `dashboard_series` answers it. */
const SERIES = {
  workspaceId: 'ws_test',
  from: '2025-08-01',
  to: '2026-07-31',
  currency: 'CHF',
  bankAccounts: 1,
  months: Array.from({ length: 12 }, (_, i) => {
    const y = i < 5 ? 2025 : 2026;
    const m = ((i + 7) % 12) + 1;
    return { month: `${y}-${String(m).padStart(2, '0')}`, from: '', to: '', inMinor: (i + 1) * 100_00, outMinor: (12 - i) * 50_00 };
  }),
  totals: { inMinor: 0, outMinor: 0 },
  topExpenses: [
    { accountId: 'acc_6000', number: '6000', name: 'Raumaufwand', amountMinor: 24_000_00 },
    { accountId: 'acc_6500', number: '6500', name: 'Verwaltungsaufwand', amountMinor: 8_000_00 },
  ],
  otherExpensesMinor: 2_000_00,
  expenseTotalMinor: 34_000_00,
};

const BILLS = {
  bills: [
    { id: 'b1', vendorName: 'Papeterie Muster AG', dueDate: '2026-07-10', openMinor: 1_081_00, currency: 'CHF', overdue: true, status: 'posted' },
    { id: 'b2', vendorName: 'Strom Beispiel AG', dueDate: '2026-08-15', openMinor: 240_00, currency: 'CHF', overdue: false, status: 'posted' },
    { id: 'b3', vendorName: 'Bezahlt GmbH', dueDate: '2026-06-01', openMinor: 0, currency: 'CHF', overdue: false, status: 'posted' },
  ],
  baseTotalOpenMinor: 1_321_00,
  baseCurrency: 'CHF',
};

const TASKS = {
  tasks: [
    { id: 't1', title: 'MWST-Abrechnung prüfen', dueAt: '2026-07-01T00:00:00.000Z', bucket: 'overdue' },
    { id: 't2', title: 'Belege ablegen', dueAt: null, bucket: 'upcoming' },
    { id: 't3', title: 'Erledigt', dueAt: null, bucket: 'done' },
  ],
  total: 3,
};

const happyCanned = (): Canned => ({
  dashboard_overview: ok({ workspaceId: 'ws_test', tiles: [...TILES], omitted: [] }),
  list_saved_views: ok({ entityKind: 'workspace', savedViews: [] }),
  dashboard_series: ok(SERIES),
  list_vendor_bills: ok(BILLS),
  tasks_list: ok(TASKS),
});

/** A freshly minted workspace: the wall loads, but every tile is a zero-state or degraded one, the
 *  engine's honest answer for an empty ledger. This is where the K-13 setup card belongs. */
const FRESH_TILES = [
  { tile: 'revenue', ok: true, valueRappen: 0, currency: 'CHF', range: { from: '2026-07-01', to: '2026-07-31' }, trendBp: null, glyph: '◆', drill: DRILL('/reports'), detail: {} },
  { tile: 'cash', ok: true, valueRappen: 0, currency: 'CHF', asOf: '2026-07-31', glyph: '●', drill: DRILL('/bank-accounts'), detail: {} },
  { tile: 'utilisation', ok: true, valueBp: null, currency: 'CHF', range: { from: '2026-07-01', to: '2026-07-31' }, glyph: '◔', drill: DRILL('/time'), detail: {} },
  { tile: 'stock_value', ok: false, error: 'needs_stock_items', glyph: '▦' },
] as const;

const freshCanned = (): Canned => ({
  dashboard_overview: ok({ workspaceId: 'ws_test', tiles: [...FRESH_TILES], omitted: [] }),
  list_saved_views: ok({ entityKind: 'workspace', savedViews: [] }),
  dashboard_series: ok({ ...SERIES, bankAccounts: 0, months: SERIES.months.map((m) => ({ ...m, inMinor: 0, outMinor: 0 })), topExpenses: [], otherExpensesMinor: 0, expenseTotalMinor: 0 }),
  list_vendor_bills: ok({ bills: [], baseTotalOpenMinor: 0, baseCurrency: 'CHF' }),
  tasks_list: ok({ tasks: [], total: 0 }),
});

/** Saved views as `list_saved_views` returns them: one personal and one shared DASHBOARD view, plus
 *  one of another layout that this surface must NOT offer. The shape is G00's `SavedViewDto`, the
 *  same the shared SavedViewPicker consumes on Customization and Recurring. */
const SAVED_VIEWS = [
  { viewId: 'v_personal', name: 'Nur Umsatz', shared: false, layout: 'dashboard', entityKind: 'workspace', ownerActor: 'a1', filters: {}, sort: [], columns: [], isDefault: false },
  { viewId: 'v_shared', name: 'Büro-Ansicht', shared: true, layout: 'dashboard', entityKind: 'workspace', ownerActor: null, filters: {}, sort: [], columns: [], isDefault: false },
  { viewId: 'v_ledger', name: 'Kontenliste', shared: false, layout: 'ledger', entityKind: 'workspace', ownerActor: 'a1', filters: {}, sort: [], columns: [], isDefault: false },
] as const;

/** Renders the current pathname, so a drill click is asserted on the ROUTER and not on a spy. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

/** The detached preference store of the last `renderSurface` that was given prefs. */
let lastStore: PrefsStore | undefined;

function renderSurface(canned: Canned | Transport, prefs?: Record<string, PrefValue>) {
  const transport = typeof canned === 'function' ? canned : fakeTransport(canned);
  const client = new TillClient(transport);
  const surface = (
    <MemoryRouter initialEntries={['/overview']}>
      <Routes>
        <Route path="*" element={<><Uebersicht /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>
  );
  let store: PrefsStore | undefined;
  if (prefs !== undefined) {
    // A detached store: the person's preferences without an engine (D178 points 12 and 13).
    store = new PrefsStore(null, null, { useCache: false });
    for (const [key, value] of Object.entries(prefs)) store.seed(key, value);
  }
  lastStore = store;
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          {store === undefined ? surface : <PrefsProvider store={store}>{surface}</PrefsProvider>}
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

describe('Uebersicht: the tile wall states', () => {
  it('loading: the skeleton is a read in flight, not a default', async () => {
    const transport = watchReads(neverSettles);
    renderSurface(transport);
    await transport.started('dashboard_overview');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('success: money tiles format Rappen, ratio tiles format basis points, the trend carries glyph AND figure', async () => {
    renderSurface(happyCanned());
    expect(await screen.findByText("CHF 30'000.00")).toBeInTheDocument();
    expect(screen.getByText("CHF 12'500.00")).toBeInTheDocument();
    expect(screen.getByText('82.5 %')).toBeInTheDocument();
    // The trend is glyph plus the signed figure, never colour or shape alone.
    expect(screen.getByLabelText(/2\.5 %/)).toHaveTextContent('▲');
  });

  it('degraded tiles are hidden behind the "Weitere Kacheln" hint, never rendered as fake zeros', async () => {
    renderSurface(happyCanned());
    await screen.findByText("CHF 12'500.00");
    expect(screen.queryByText('MWST fällig')).not.toBeInTheDocument();
    expect(screen.queryByText('Lagerwert')).not.toBeInTheDocument();
    expect(screen.getByText(/Weitere Kacheln werden mit der Einrichtung/)).toBeInTheDocument();
  });

  it('omitted tiles produce ONE neutral footnote (the omission already happened server-side)', async () => {
    const canned = happyCanned();
    canned.dashboard_overview = ok({
      workspaceId: 'ws_test',
      tiles: [TILES[3]],
      omitted: [{ tile: 'revenue', error: 'permission_denied' }],
    });
    renderSurface(canned);
    await screen.findByText('82.5 %');
    expect(screen.getByText('Weitere Kacheln erfordern zusätzliche Rechte.')).toBeInTheDocument();
    expect(screen.queryByText('Umsatz')).not.toBeInTheDocument();
  });

  it('a custom range with the end before the start is an inline error, and no read is sent for it', async () => {
    const seen: string[] = [];
    const inner = fakeTransport(happyCanned());
    const transport: Transport = async (action, input) => {
      seen.push(`${action}:${String((input as { from?: unknown }).from ?? '')}`);
      return inner(action, input);
    };
    renderSurface(transport);
    await screen.findByText("CHF 12'500.00");
    // K-11: the range is the shared Segmented control, a radio group.
    await userEvent.click(screen.getByRole('radio', { name: 'Benutzerdefiniert' }));
    const from = screen.getByLabelText('Von');
    const to = screen.getByLabelText('Bis');
    await userEvent.clear(from);
    // A far-future start keeps the range unconditionally end-before-start against ANY default
    // `to` (the current-period end), so this stays hermetic against the clock. A concrete
    // near-term date (e.g. the current month end) would momentarily form a VALID range while
    // `to` still holds its default, firing a spurious read on whichever month the test runs in.
    await userEvent.type(from, '2099-12-31');
    await userEvent.clear(to);
    await userEvent.type(to, '2026-01-01');
    expect(await screen.findByRole('alert')).toHaveTextContent('Enddatum liegt vor dem Startdatum.');
    expect(seen.some((s) => s === 'dashboard_overview:2099-12-31')).toBe(false);
  });

  it('clicking a tile drills to its source route', async () => {
    renderSurface(happyCanned());
    await screen.findByText("CHF 12'500.00");
    await userEvent.click(screen.getByRole('button', { name: /Debitoren offen/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/open-items');
  });

  it('a drillable tile is a button; a tile with no drill is inert and not a button', async () => {
    const canned = happyCanned();
    canned.dashboard_overview = ok({
      workspaceId: 'ws_test',
      tiles: [
        { tile: 'cash', ok: true, valueRappen: 1250000, currency: 'CHF', asOf: '2026-07-31', glyph: '●', drill: DRILL('/bank-accounts'), detail: {} },
        // No `drill`: an inert tile. It must render its figure but never as a clickable control.
        { tile: 'revenue', ok: true, valueRappen: 3000000, currency: 'CHF', range: { from: '2026-07-01', to: '2026-07-31' }, glyph: '◆', detail: {} },
      ],
      omitted: [],
    });
    renderSurface(canned);
    await screen.findByText("CHF 12'500.00");
    // The drillable tile is a real control.
    expect(screen.getByRole('button', { name: /Flüssige Mittel/ })).toBeInTheDocument();
    // The inert tile shows its figure but is NOT a button, so it never reads as clickable.
    expect(screen.getByText("CHF 30'000.00")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Umsatz/ })).toBeNull();
  });

  it('with no saved dashboard views the picker is hidden, not a lone default option', async () => {
    // happyCanned() returns savedViews: [], the common case.
    renderSurface(happyCanned());
    await screen.findByText("CHF 12'500.00");
    expect(screen.queryByRole('combobox', { name: 'Ansicht' })).toBeNull();
  });

  it('the shared saved-view picker lists only dashboard views; choosing one applies its layout and its period (D180)', async () => {
    const reads: Record<string, unknown>[] = [];
    const canned = happyCanned();
    const views = [
      SAVED_VIEWS[0],
      {
        ...SAVED_VIEWS[1],
        filters: { rangePreset: 'year', widgets: [{ id: 'open_tasks', on: true, w: 'full' }], bankAction: 'tile' },
        columns: ['cash', 'revenue'],
      },
      SAVED_VIEWS[2],
    ];
    canned.list_saved_views = ok({ entityKind: 'workspace', savedViews: views });
    const inner = fakeTransport(canned);
    const transport: Transport = async (action, input) => {
      if (action === 'dashboard_overview') reads.push((input ?? {}) as Record<string, unknown>);
      return inner(action, input);
    };
    renderSurface(transport, {});
    await screen.findByText("CHF 12'500.00");
    const picker = await screen.findByRole('combobox', { name: 'Ansicht' });
    await userEvent.click(picker); // the custom Select portals its listbox open
    // Only the dashboard-layout views are offered; a ledger-layout view is not this surface's.
    expect(screen.getByRole('option', { name: 'Nur Umsatz' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Büro-Ansicht' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Kontenliste' })).toBeNull();
    await userEvent.click(screen.getByRole('option', { name: 'Büro-Ansicht' })); // v_shared
    // The period comes back (it used to be saved and never restored) and the wall reads the year.
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Jahr' })).toBeChecked());
    await waitFor(() => expect(reads.some((i) => String(i.from).endsWith('-01-01') && String(i.to).endsWith('-12-31'))).toBe(true));
    // The view's layout lands in the person's preferences: its tiles in its order, the rest hidden.
    const tiles = () => [...document.querySelectorAll('.uebersicht-grid > li')].map((li) => li.getAttribute('data-slot'));
    await waitFor(() => expect(tiles()).toEqual(['cash', 'revenue']));
    expect(lastStore?.value('overview.widgets')).toEqual([{ id: 'open_tasks', on: true, w: 'full' }]);
    expect(document.querySelector('[data-slot="open_tasks"]')).toHaveClass('uebersicht-widget--full');
    expect(screen.getByText('Ansicht «Büro-Ansicht» angewendet.')).toBeInTheDocument();
    // Rückgängig puts the layout and the period back.
    await userEvent.click(screen.getByRole('button', { name: 'Rückgängig' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Monat' })).toBeChecked());
    expect(tiles()).toEqual(['revenue', 'cash', 'ar_aging', 'utilisation']);
  });

  it('Als Ansicht speichern sends G00 the visible tiles in order and the layout, under layout dashboard', async () => {
    let saved: Record<string, unknown> | null = null;
    const canned = happyCanned();
    canned.create_saved_view = (input) => {
      saved = input;
      return ok({ savedView: { viewId: 'view_1', name: 'Meine', layout: 'dashboard', columns: [] } });
    };
    renderSurface(canned, { 'overview.tiles': [{ id: 'cash', on: true }, { id: 'utilisation', on: false }] });
    await screen.findByText("CHF 12'500.00");
    await userEvent.click(screen.getByRole('button', { name: 'Mehr zur Übersicht' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Als Ansicht speichern' }));
    // The name field takes the focus; the check saves.
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await userEvent.type(screen.getByLabelText('Name'), 'Meine Startseite');
    await userEvent.click(screen.getByRole('button', { name: 'Fertig', description: 'Ansicht speichern' }));
    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved).toMatchObject({
      entityKind: 'workspace',
      layout: 'dashboard',
      name: 'Meine Startseite',
      columns: ['cash', 'revenue', 'ar_aging'],
      filters: {
        rangePreset: 'month',
        bankAction: 'tile',
        tiles: [
          { id: 'cash', on: true },
          { id: 'utilisation', on: false },
          { id: 'revenue', on: true },
          { id: 'ar_aging', on: true },
        ],
        widgets: [
          { id: 'expense_donut', on: true },
          { id: 'money_in_out', on: true },
          { id: 'open_creditors', on: true },
          { id: 'open_tasks', on: true },
          { id: 'cash_flow', on: false },
          { id: 'expense_bars', on: false },
        ],
      },
    });
    expect((saved as unknown as { shared?: unknown }).shared).toBeUndefined();
    // No text button is left in the header to save with.
    expect(screen.queryByRole('button', { name: 'Ansicht speichern' })).toBeNull();
  });

  it('the success state has no axe violations', async () => {
    const { container } = renderSurface(happyCanned());
    await screen.findByText("CHF 12'500.00");
    await settle();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a fresh, data-less workspace shows the K-13 setup card above the wall', async () => {
    window.localStorage.clear();
    renderSurface(freshCanned());
    expect(await screen.findByRole('heading', { name: 'Ersteinrichtung' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Firmenprofil vervollständigen/ })).toHaveAttribute('href', '/setup');
  });

  it('an established workspace with real data never shows the setup card', async () => {
    window.localStorage.clear();
    renderSurface(happyCanned());
    await screen.findByText("CHF 12'500.00");
    expect(screen.queryByRole('heading', { name: 'Ersteinrichtung' })).not.toBeInTheDocument();
  });
});

describe('Uebersicht: the daily doors (F-05)', () => {
  it('Buchen and Sichern are always-visible header links into the composer and the backup panel', async () => {
    renderSurface(happyCanned());
    await screen.findByText("CHF 12'500.00");
    const doors = screen.getByRole('group', { name: 'Häufige Aktionen' });
    expect(within(doors).getByRole('link', { name: 'Buchen' })).toHaveAttribute('href', '/journal?new=1');
    expect(within(doors).getByRole('link', { name: 'Sichern' })).toHaveAttribute('href', '/operations#data-title');
    // An established workspace offers no demo door: a demo is for looking before the books exist.
    expect(within(doors).queryByRole('button', { name: /Demo ausprobieren/ })).toBeNull();
  });

  it('a fresh workspace offers the demo door, which mints the demo and adopts it in place', async () => {
    window.localStorage.clear();
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const inner = fakeTransport({ ...freshCanned(), create_demo_workspace: ok({ workspaceId: 'ws_demo' }) });
    const transport: Transport = async (action, input) => {
      calls.push({ action, input: (input ?? {}) as Record<string, unknown> });
      return inner(action, input);
    };
    renderSurface(transport);
    const demo = await screen.findByRole('button', { name: 'Demo ausprobieren' });
    await userEvent.click(demo);
    await waitFor(() => expect(calls.some((c) => c.action === 'create_demo_workspace')).toBe(true));
    expect(typeof calls.find((c) => c.action === 'create_demo_workspace')?.input.idempotencyKey).toBe('string');
    // The minted workspace is adopted: the wall re-reads under the demo's id, on the same route.
    await waitFor(() =>
      expect(calls.some((c) => c.action === 'dashboard_overview' && c.input.workspaceId === 'ws_demo')).toBe(true),
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/overview');
  });
});

describe('presetRange: the calendar windows', () => {
  it('month, quarter and year derive from the given day', () => {
    expect(presetRange('month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(presetRange('quarter', '2026-08-04')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(presetRange('year', '2026-08-04')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
});

describe('Uebersicht without a workspace', () => {
  it('renders the no-workspace state and calls nothing', () => {
    const spy = vi.fn();
    const client = new TillClient(spy as unknown as Transport);
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId={null}>
            <MemoryRouter>
              <Uebersicht />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Uebersicht: round 2 (K-09, K-11, K-12, K-34, K-35)', () => {
  it('K-11/K-12: the range is a Segmented radio group, "Monat" checked, never a solid brass button', async () => {
    renderSurface(fakeTransport(happyCanned()));
    await screen.findByText("CHF 12'500.00");
    const group = screen.getByRole('radiogroup', { name: 'Zeitraum' });
    expect(group).toHaveClass('segmented');
    expect(screen.getByRole('radio', { name: 'Monat' })).toHaveAttribute('aria-checked', 'true');
  });

  it('a money tile value is a money cell (tabular, never wrapped)', async () => {
    renderSurface(fakeTransport(happyCanned()));
    const value = await screen.findByText("CHF 12'500.00");
    expect(value).toHaveClass('t-money');
  });
});


describe('D142: the Bankeingang band on the wall, and drills that keep their params', () => {
  const BANK_TILE = {
    tile: 'bank_inbox',
    ok: true,
    glyph: '⇄',
    currency: 'CHF',
    open: 5,
    needs: 2,
    sure: 3,
    learned: 0,
    noReceipt: 1,
    accounts: [{ bankAccountId: 'ba_1', name: 'Geschäftskonto', currency: 'CHF', open: 5, needs: 2, sure: 3, noReceipt: 1, inMinor: 10_000, outMinor: 5_000 }],
    lastSyncAt: null,
    syncInProgress: false,
    autoMode: null,
    autoAt: null,
    nextAutoSyncAt: null,
    lastAutoOutcome: null,
    channels: [],
    drill: { studioRoute: '/bank', mcpTool: 'list_bank_inbox', params: { workspaceId: 'ws_test', status: 'open' } },
  };

  it('drillHref turns the drill params into a query string and never carries the workspace', () => {
    expect(drillHref({ studioRoute: '/open-items', mcpTool: 'aging_report', params: { workspaceId: 'ws_test', asOf: '2026-07-31' } })).toBe('/open-items?asOf=2026-07-31');
    expect(drillHref({ studioRoute: '/bank-accounts', mcpTool: 'list_bank_accounts', params: { workspaceId: 'ws_test' } })).toBe('/bank-accounts');
    expect(drillHref({ studioRoute: '/reports', mcpTool: 'income_statement', params: { workspaceId: 'ws_test', nested: { a: 1 }, n: 2 } })).toBe('/reports?n=2');
  });

  it('a tile click lands on its route WITH the drill params (they used to be dropped)', async () => {
    const canned = happyCanned();
    canned.dashboard_overview = ok({
      workspaceId: 'ws_test',
      tiles: [{ tile: 'ar_aging', ok: true, valueRappen: 12_500_00, currency: 'CHF', asOf: '2026-07-31', glyph: '◧', drill: { studioRoute: '/open-items', mcpTool: 'aging_report', params: { workspaceId: 'ws_test', asOf: '2026-07-31' } }, detail: {} }],
      omitted: [],
    });
    const client = new TillClient(fakeTransport(canned));
    function Probe() {
      const location = useLocation();
      return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
    }
    render(
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/overview']}>
              <Routes>
                <Route path="*" element={<><Uebersicht /><Probe /></>} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /Debitoren offen/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/open-items?asOf=2026-07-31');
  });

  it('D178 point 12: by default the bank action is a tile in the grid with its own button to /bank', async () => {
    const canned = happyCanned();
    canned.dashboard_overview = ok({ workspaceId: 'ws_test', tiles: [...TILES, { ...BANK_TILE, waiting: 2 }], omitted: [] });
    renderSurface(canned);
    const button = await screen.findByRole('link', { name: 'Bankzeilen buchen' });
    expect(button).toHaveAttribute('href', '/bank');
    expect(button).toHaveClass('btn', 'btn--secondary');
    const grid = document.querySelector('.uebersicht-grid') as HTMLElement;
    expect(within(grid).getByRole('heading', { name: /Bank/ })).toBeInTheDocument();
    // B5: ONE figure, stated once.
    expect(within(grid).getByText('5 offen')).toBeInTheDocument();
    expect(grid.querySelector('.uebersicht-bank')?.textContent?.match(/5/g)).toHaveLength(1);
    expect(grid.querySelector('.uebersicht-bank.is-waiting')).not.toBeNull();
    // The D142 band is the third place, not the default: no band above the wall.
    expect(document.querySelector('.bank-band')).toBeNull();
  });

  it('nothing open: the tile is quiet, no colour, a plain way to the bank', async () => {
    const canned = happyCanned();
    canned.dashboard_overview = ok({ workspaceId: 'ws_test', tiles: [...TILES, { ...BANK_TILE, open: 0, waiting: 0 }], omitted: [] });
    renderSurface(canned);
    expect(await screen.findByText('0 offen')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zur Bank' })).toHaveClass('btn--ghost');
    expect(document.querySelector('.uebersicht-bank.is-waiting')).toBeNull();
  });

  it('the bank action as a card on top, or as the slim D142 band, by the person\'s preference', async () => {
    const canned = happyCanned();
    canned.dashboard_overview = ok({ workspaceId: 'ws_test', tiles: [...TILES, { ...BANK_TILE, waiting: 1 }], omitted: [] });
    canned.dashboard_tile = ok({ workspaceId: 'ws_test', tile: BANK_TILE });
    const card = renderSurface(canned, { 'overview.bank_action': 'card' });
    expect(await screen.findByRole('link', { name: 'Bankzeilen buchen' })).toBeInTheDocument();
    expect(document.querySelector('.uebersicht-bank--card')).not.toBeNull();
    expect(document.querySelector('.uebersicht-grid .uebersicht-bank')).toBeNull();
    card.unmount();
    renderSurface(canned, { 'overview.bank_action': 'bar' });
    expect(await screen.findByRole('link', { name: '5 offene Bankbuchungen' })).toHaveAttribute('href', '/bank');
    expect(document.querySelector('.uebersicht-bank')).toBeNull();
  });
});

describe('D178 point 13: the widgets under the key figures', () => {
  it('the default content: the expense ring, money in and out, open creditors and open tasks, in that order', async () => {
    renderSurface(happyCanned());
    expect(await screen.findByRole('img', { name: /Aufwände total CHF 34'000.00/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Geld rein CHF .* pro Monat/ })).toBeInTheDocument();
    const titles = [...document.querySelectorAll('.uebersicht-widgets .uebersicht-widget__title')].map((h) => h.textContent);
    expect(titles).toEqual(['Grösste Aufwände', 'Geld rein und raus', 'Offene Kreditoren', 'Offene Aufgaben']);
    // The ring names every part with amount and share; the rest is one "Übrige".
    expect(screen.getAllByText('6000 Raumaufwand').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Übrige').length).toBeGreaterThan(0);
    // Open creditors: only open posted bills, oldest due first, the total from the engine.
    expect(await screen.findByRole('link', { name: 'Papeterie Muster AG' })).toHaveAttribute('href', '/bills?bill=b1');
    expect(screen.queryByText('Bezahlt GmbH')).toBeNull();
    expect(screen.getByText("CHF 1'321.00")).toBeInTheDocument();
    // Open tasks: the done one is not listed, the overdue one first.
    const tasks = within(screen.getByRole('region', { name: 'Offene Aufgaben' })).getAllByRole('link');
    expect(tasks[0]).toHaveTextContent('MWST-Abrechnung prüfen');
    expect(screen.queryByText('Erledigt')).toBeNull();
  });

  it('the series is read once, for the twelve months ending with the range', async () => {
    const seen: Record<string, unknown>[] = [];
    const inner = fakeTransport(happyCanned());
    renderSurface(async (action, input) => {
      if (action === 'dashboard_series') seen.push(input as Record<string, unknown>);
      return inner(action, input);
    });
    await screen.findByRole('img', { name: /Aufwände total/ });
    expect(seen).toHaveLength(1);
    const asked = seen[0] as { from: string; to: string };
    expect(asked.to.slice(8)).toMatch(/^(28|29|30|31)$/);
    expect(Number(asked.to.slice(0, 4)) * 12 + Number(asked.to.slice(5, 7)) - (Number(asked.from.slice(0, 4)) * 12 + Number(asked.from.slice(5, 7)))).toBe(11);
  });

  it('empty: no bank account and no expenses say so and offer the first step', async () => {
    renderSurface(freshCanned());
    expect(await screen.findByText('Noch kein Bankkonto.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bankkonto erfassen' })).toHaveAttribute('href', '/bank-accounts');
    expect(screen.getByText('Noch keine Aufwände.')).toBeInTheDocument();
    expect(await screen.findByText('Keine offenen Kreditoren.')).toBeInTheDocument();
    expect(await screen.findByText('Keine offenen Aufgaben.')).toBeInTheDocument();
  });

  it('error: a failed series read offers a retry that reads again; a refused one is a padlock', async () => {
    let calls = 0;
    const canned = happyCanned();
    canned.dashboard_series = () => {
      calls += 1;
      return calls === 1 ? { status: 500, body: { ok: false, error: 'internal' } } : ok(SERIES);
    };
    canned.tasks_list = { status: 403, body: { ok: false, error: 'permission_denied', capability: 'tasks.read' } };
    renderSurface(canned);
    const region = await screen.findByRole('region', { name: 'Geld rein und raus' });
    await userEvent.click(await within(region).findByRole('button', { name: /Erneut versuchen/ }));
    expect(await screen.findByRole('img', { name: /Geld rein CHF/ })).toBeInTheDocument();
    expect(await within(screen.getByRole('region', { name: 'Offene Aufgaben' })).findByText('Dir fehlt das Recht, diese Zahlen zu lesen.')).toBeInTheDocument();
  });

  it('the other contents: Verlauf shows cash flow and expense bars with a trend line on the cash tile; Nur Kennzahlen none', async () => {
    const trends = renderSurface(happyCanned(), { 'overview.content': 'trends' });
    expect(await screen.findByRole('img', { name: /Geldfluss pro Monat/ })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Grösste Aufwände' })).toBeInTheDocument();
    expect(document.querySelector('.uebersicht-tile .chart-sparkline')).not.toBeNull();
    trends.unmount();
    renderSurface(happyCanned(), { 'overview.content': 'figures' });
    await screen.findByText("CHF 12'500.00");
    expect(document.querySelector('.uebersicht-widgets')).toBeNull();
  });

  it('the ring states one figure; the expense accounts in credit are explained behind the (i), never drawn or dropped', async () => {
    const canned = happyCanned();
    canned.dashboard_series = ok({ ...SERIES, grossExpenseMinor: 34_000_00, expenseReductionsMinor: -4_000_00, expenseTotalMinor: 30_000_00 });
    renderSurface(canned);
    const region = await screen.findByRole('region', { name: 'Grösste Aufwände' });
    expect(await within(region).findByRole('img', { name: /Aufwände total CHF 34'000.00/ })).toBeInTheDocument();
    expect(within(region).queryByText(/30'000.00/)).toBeNull();
    await userEvent.click(within(region).getByRole('button', { name: 'Wie die grössten Aufwände gerechnet sind' }));
    expect(await screen.findByText(/zusammen CHF -4'000.00\. Mit ihnen beträgt der Aufwand in der Erfolgsrechnung CHF 30'000.00/)).toBeInTheDocument();
  });

  it('the waiting work sits below the key figures, not above the title', async () => {
    renderSurface({ ...happyCanned(), attention_summary: ok({ visibleQueues: 1, total: 3, top: [] }) });
    await screen.findByText("CHF 12'500.00");
    const title = screen.getByRole('heading', { level: 1, name: 'Übersicht' });
    const grid = document.querySelector('.uebersicht-grid') as HTMLElement;
    const strip = await waitFor(() => {
      const el = document.querySelector('.att-strip');
      expect(el).not.toBeNull();
      return el as Element;
    });
    expect(title.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(grid.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the key-figure grid is balanced: nine tiles are three rows of three', async () => {
    const { balancedColumns } = await import('./Uebersicht');
    expect([4, 5, 6, 7, 8, 9, 10].map(balancedColumns)).toEqual([4, 3, 3, 4, 4, 3, 4]);
  });

  it('the widgets have no axe violations', async () => {
    const { container } = renderSurface(happyCanned());
    await screen.findByRole('img', { name: /Aufwände total/ });
    await screen.findByRole('link', { name: 'Papeterie Muster AG' });
    await settle();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('D180: the edit mode, in place', () => {
  const BANK = {
    tile: 'bank_inbox',
    ok: true,
    glyph: '⇄',
    currency: 'CHF',
    open: 5,
    waiting: 2,
    needs: 2,
    sure: 3,
    learned: 0,
    noReceipt: 1,
    accounts: [{ bankAccountId: 'ba_1', name: 'Geschäftskonto', currency: 'CHF', open: 5, needs: 2, sure: 3, noReceipt: 1, inMinor: 10_000, outMinor: 5_000 }],
    lastSyncAt: null,
    syncInProgress: false,
    autoMode: null,
    autoAt: null,
    nextAutoSyncAt: null,
    lastAutoOutcome: null,
    channels: [],
    drill: { studioRoute: '/bank', mcpTool: 'list_bank_inbox', params: { workspaceId: 'ws_test' } },
  };
  const withBank = (): Canned => {
    const canned = happyCanned();
    canned.dashboard_overview = ok({ workspaceId: 'ws_test', tiles: [...TILES, BANK], omitted: [] });
    canned.dashboard_tile = ok({ workspaceId: 'ws_test', tile: BANK });
    return canned;
  };
  const tiles = () => [...document.querySelectorAll('.uebersicht-grid > li')].map((li) => li.getAttribute('data-slot'));
  const cards = () => [...document.querySelectorAll('.uebersicht-widgets > .uebersicht-card')].map((el) => el.getAttribute('data-slot'));
  const live = () => document.querySelector('.uebersicht > p[aria-live="polite"]')?.textContent ?? '';
  const startEditing = async () => {
    await screen.findByRole('img', { name: /Aufwände total/ });
    // The two list cards read on their own: wait for both, so no read lands outside the test's act.
    await screen.findByRole('link', { name: 'Papeterie Muster AG' });
    await screen.findByText('MWST-Abrechnung prüfen');
    await userEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
  };

  it('one icon opens it and becomes Fertig; every card shows, the hidden ones as ghosts; Escape closes it and hands the focus back', async () => {
    renderSurface(happyCanned(), {});
    await startEditing();
    const done = screen.getByRole('button', { name: 'Fertig' });
    expect(done).toHaveFocus();
    expect(live()).toMatch(/ziehe am Griff oder verschiebe mit Alt/);
    // A grip per item, hidden from assistive tech.
    expect(document.querySelectorAll('.uebersicht-grip[aria-hidden="true"]').length).toBe(4 + 6);
    // All six cards are on the page: the two the content does not show wait as ghosts, in words.
    expect(cards()).toEqual(['expense_donut', 'money_in_out', 'open_creditors', 'open_tasks', 'cash_flow', 'expense_bars']);
    expect(document.querySelectorAll('.uebersicht-card.is-ghost')).toHaveLength(2);
    expect(document.querySelector('[data-slot="cash_flow"] .uebersicht-ghost__name')).toHaveTextContent('Geldfluss');
    expect(document.querySelectorAll('.uebersicht-ghost__state')).toHaveLength(2);
    // While editing a tile never drills away.
    const faces = [...document.querySelectorAll('.uebersicht-grid button.uebersicht-tile')];
    expect(faces.length).toBe(4);
    // Every item's face is inert while editing: no tab stop, no pointer, in a tile or a card.
    for (const face of faces) expect(face.closest('.uebersicht-item__face')).toHaveAttribute('inert');
    expect(screen.getByRole('link', { name: 'Papeterie Muster AG' }).closest('.uebersicht-item__face')).toHaveAttribute('inert');
    // The edit bar is never inside the inert face.
    expect(document.querySelector('.uebersicht-item__face .uebersicht-item__bar')).toBeNull();
    await userEvent.click(faces[0] as HTMLElement);
    expect(screen.getByTestId('location')).toHaveTextContent('/overview');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Anpassen' })).toHaveFocus();
    expect(document.querySelector('.uebersicht-grip')).toBeNull();
    expect(document.querySelector('.uebersicht-item__face[inert]')).toBeNull();
    expect(cards()).toEqual(['expense_donut', 'money_in_out', 'open_creditors', 'open_tasks']);
  });

  it('Alt+Arrow moves a key figure, writes overview.tiles at once, keeps the focus on it and says where it went', async () => {
    renderSurface(happyCanned(), {});
    await startEditing();
    const hide = screen.getByRole('button', { name: 'Ausblenden', description: 'Debitoren offen' });
    act(() => hide.focus());
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(tiles()).toEqual(['revenue', 'ar_aging', 'cash', 'utilisation']);
    expect(lastStore?.value('overview.tiles')).toEqual([
      { id: 'revenue', on: true },
      { id: 'ar_aging', on: true },
      { id: 'cash', on: true },
      { id: 'utilisation', on: true },
    ]);
    expect(screen.getByRole('button', { name: 'Ausblenden', description: 'Debitoren offen' })).toHaveFocus();
    expect(live()).toBe('Debitoren offen verschoben, Platz 2 von 4.');
    // The order holds outside edit mode too.
    await userEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(tiles()).toEqual(['revenue', 'ar_aging', 'cash', 'utilisation']);
  });

  it('a card moves by Alt+Arrow and by its Mehr menu (the single-pointer path), and the pref follows', async () => {
    renderSurface(happyCanned(), {});
    await startEditing();
    act(() => screen.getByRole('button', { name: 'Ausblenden', description: 'Offene Kreditoren' }).focus());
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(cards().slice(0, 4)).toEqual(['expense_donut', 'open_creditors', 'money_in_out', 'open_tasks']);
    await userEvent.click(screen.getByRole('button', { name: 'Mehr zu Offene Aufgaben' }));
    expect(screen.getByRole('menuitem', { name: 'Nach vorne' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Nach vorne' }));
    expect(cards().slice(0, 4)).toEqual(['expense_donut', 'open_creditors', 'open_tasks', 'money_in_out']);
    const stored = lastStore?.value('overview.widgets') as { id: string }[];
    expect(stored.map((s) => s.id).slice(0, 4)).toEqual(['expense_donut', 'open_creditors', 'open_tasks', 'money_in_out']);
    // The first item cannot go further forward.
    await userEvent.click(screen.getByRole('button', { name: 'Mehr zu Grösste Aufwände (Ring)' }));
    expect(screen.getByRole('menuitem', { name: 'Nach vorne' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('the eye hides a card into a ghost in its own slot, shows it again from there, and a hidden card is gone after Fertig', async () => {
    renderSurface(happyCanned(), {});
    await startEditing();
    await userEvent.click(screen.getByRole('button', { name: 'Ausblenden', description: 'Offene Aufgaben' }));
    expect(screen.queryByRole('region', { name: 'Offene Aufgaben' })).toBeNull();
    expect(document.querySelector('[data-slot="open_tasks"]')).toHaveClass('is-ghost');
    expect(cards()[3]).toBe('open_tasks');
    expect(live()).toBe('Offene Aufgaben ausgeblendet.');
    await userEvent.click(screen.getByRole('button', { name: 'Einblenden', description: 'Offene Aufgaben' }));
    expect(await screen.findByRole('region', { name: 'Offene Aufgaben' })).toBeInTheDocument();
    // A card of another content joins from its ghost: the library is the page.
    await userEvent.click(screen.getByRole('button', { name: 'Einblenden', description: 'Geldfluss' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ausblenden', description: 'Offene Kreditoren' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(cards()).toEqual(['expense_donut', 'money_in_out', 'open_tasks', 'cash_flow']);
    expect(await screen.findByRole('img', { name: /Geldfluss pro Monat/ })).toBeInTheDocument();
    expect(document.querySelector('.uebersicht-ghost')).toBeNull();
  });

  it('a hidden key figure is gone outside edit mode; a stored tile the read did not return never appears', async () => {
    renderSurface(happyCanned(), { 'overview.tiles': [{ id: 'stock_value', on: true }, { id: 'cash', on: false }] });
    await screen.findByText("CHF 8'500.00");
    expect(tiles()).toEqual(['revenue', 'ar_aging', 'utilisation']);
    expect(screen.queryByText("CHF 12'500.00")).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
    expect(tiles()).toEqual(['cash', 'revenue', 'ar_aging', 'utilisation']);
    expect(document.querySelector('[data-slot="stock_value"]')).toBeNull();
  });

  it('Grösse ändern spans a card over the whole row and back', async () => {
    renderSurface(happyCanned(), {});
    await startEditing();
    const resize = screen.getByRole('button', { name: 'Grösse ändern', description: 'Geld rein und raus: volle Breite' });
    expect(resize).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(resize);
    expect(document.querySelector('[data-slot="money_in_out"]')).toHaveClass('uebersicht-widget--full');
    expect(screen.getByRole('button', { name: 'Grösse ändern', description: 'Geld rein und raus: halbe Breite' })).toHaveAttribute('aria-pressed', 'true');
    expect((lastStore?.value('overview.widgets') as { id: string; w?: string }[]).find((s) => s.id === 'money_in_out')).toEqual({ id: 'money_in_out', on: true, w: 'full' });
    expect(live()).toBe('Geld rein und raus jetzt volle Breite.');
    await userEvent.click(screen.getByRole('button', { name: 'Grösse ändern', description: 'Geld rein und raus: halbe Breite' }));
    expect(document.querySelector('[data-slot="money_in_out"]')).not.toHaveClass('uebersicht-widget--full');
  });

  it('the bank item sits in the tile zone while editing, and its size menu moves it to the slim bar', async () => {
    renderSurface(withBank(), {});
    await startEditing();
    expect(tiles()[0]).toBe('bank_inbox');
    await userEvent.click(screen.getByRole('button', { name: 'Grösse ändern: Bank' }));
    expect(screen.getByRole('menuitemradio', { name: 'Kachel' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Schmale Leiste' }));
    expect(live()).toBe('Bank jetzt als schmale Leiste.');
    expect(lastStore?.value('overview.bank_action')).toBe('bar');
    // Still in the tile zone while editing; at its new place once done.
    expect(tiles()[0]).toBe('bank_inbox');
    expect(document.querySelector('.bank-band')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(tiles()).not.toContain('bank_inbox');
    expect(await screen.findByRole('link', { name: '5 offene Bankbuchungen' })).toHaveAttribute('href', '/bank');
  });

  it('Standard wiederherstellen resets tiles, cards and the bank place at once, and Rückgängig brings them back', async () => {
    renderSurface(happyCanned(), {
      'overview.tiles': [{ id: 'utilisation', on: true }],
      'overview.widgets': [{ id: 'open_tasks', on: true, w: 'full' }],
      'overview.bank_action': 'card',
    });
    await screen.findByRole('img', { name: /Aufwände total/ });
    expect(tiles()[0]).toBe('utilisation');
    await userEvent.click(screen.getByRole('button', { name: 'Mehr zur Übersicht' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Standard wiederherstellen' }));
    expect(screen.getByText('Standard wiederhergestellt.')).toBeInTheDocument();
    expect(tiles()).toEqual(['revenue', 'cash', 'ar_aging', 'utilisation']);
    expect(cards()).toEqual(['expense_donut', 'money_in_out', 'open_creditors', 'open_tasks']);
    expect(lastStore?.value('overview.bank_action')).toBe('tile');
    await userEvent.click(screen.getByRole('button', { name: 'Rückgängig' }));
    expect(tiles()[0]).toBe('utilisation');
    expect(cards()[0]).toBe('open_tasks');
    expect(lastStore?.value('overview.bank_action')).toBe('card');
    expect(screen.queryByText('Standard wiederhergestellt.')).toBeNull();
    // With nothing changed there is nothing to restore.
    await userEvent.click(screen.getByRole('button', { name: 'Mehr zur Übersicht' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Standard wiederherstellen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mehr zur Übersicht' }));
    expect(screen.getByRole('menuitem', { name: 'Standard wiederherstellen' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('a finished drag writes the new order at once (the drag-end seam)', async () => {
    renderSurface(happyCanned(), {});
    await startEditing();
    act(() => reorders.get('uebersicht-grid')?.('utilisation', 'revenue'));
    expect(tiles()).toEqual(['utilisation', 'revenue', 'cash', 'ar_aging']);
    expect((lastStore?.value('overview.tiles') as { id: string }[]).map((s) => s.id)).toEqual(['utilisation', 'revenue', 'cash', 'ar_aging']);
    expect(live()).toBe('Auslastung verschoben, Platz 1 von 4.');
    act(() => reorders.get('uebersicht-widgets')?.('open_tasks', 'expense_donut'));
    expect(cards()[0]).toBe('open_tasks');
    expect((lastStore?.value('overview.widgets') as { id: string }[])[0]?.id).toBe('open_tasks');
  });

  it('entering and leaving edit mode reads nothing again: no card remounts, no series re-read', async () => {
    const calls: string[] = [];
    const inner = fakeTransport(happyCanned());
    renderSurface(async (action, input) => {
      calls.push(action);
      return inner(action, input);
    }, {});
    await screen.findByRole('link', { name: 'Papeterie Muster AG' });
    await screen.findByText('MWST-Abrechnung prüfen');
    const before = calls.length;
    const ring = screen.getByRole('img', { name: /Aufwände total/ });
    await userEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    await settle();
    expect(calls.slice(before)).toEqual([]);
    // The same chart node: nothing was remounted.
    expect(screen.getByRole('img', { name: /Aufwände total/ })).toBe(ring);
  });

  it('Escape with a tooltip open closes only the tooltip; the next Escape leaves edit mode', async () => {
    renderSurface(happyCanned(), {});
    await startEditing();
    const hide = screen.getByRole('button', { name: 'Ausblenden', description: 'Umsatz' });
    act(() => hide.focus());
    // The bubble opens in the overlay layer, so it is looked up afresh each time.
    const tip = () => document.getElementById(hide.getAttribute('aria-describedby') ?? '')?.closest('[role="tooltip"]');
    expect(tip()).toHaveClass('is-open');
    await userEvent.keyboard('{Escape}');
    expect(tip()).not.toHaveClass('is-open');
    expect(screen.getByRole('button', { name: 'Fertig' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Anpassen' })).toBeInTheDocument();
  });

  it('a degraded bank keeps its band (its own error state); a bank RBAC omitted is no band and no card', async () => {
    const degraded = happyCanned();
    degraded.dashboard_overview = ok({ workspaceId: 'ws_test', tiles: [...TILES, { tile: 'bank_inbox', ok: false, error: 'needs_bank_account', glyph: '⇄' }], omitted: [] });
    degraded.dashboard_tile = ok({ workspaceId: 'ws_test', tile: BANK });
    const first = renderSurface(degraded, { 'overview.bank_action': 'bar' });
    expect(await screen.findByRole('link', { name: '5 offene Bankbuchungen' })).toBeInTheDocument();
    await settle();
    first.unmount();
    const omitted = happyCanned();
    omitted.dashboard_overview = ok({ workspaceId: 'ws_test', tiles: [...TILES], omitted: [{ tile: 'bank_inbox', error: 'permission_denied' }] });
    omitted.dashboard_tile = ok({ workspaceId: 'ws_test', tile: BANK });
    renderSurface(omitted, { 'overview.bank_action': 'bar' });
    await screen.findByText("CHF 12'500.00");
    await settle();
    expect(document.querySelector('.bank-band')).toBeNull();
    expect(document.querySelector('.uebersicht-bank')).toBeNull();
    expect(screen.getByText('Weitere Kacheln erfordern zusätzliche Rechte.')).toBeInTheDocument();
  });

  it('a view saved before D180 (columns and a period only) orders its tiles and hides neither the bank nor the rest', async () => {
    const canned = withBank();
    canned.list_saved_views = ok({
      entityKind: 'workspace',
      savedViews: [{ ...SAVED_VIEWS[0], columns: ['revenue', 'cash'], filters: { rangePreset: 'year' } }],
    });
    renderSurface(canned, {});
    await screen.findByText("CHF 12'500.00");
    await userEvent.click(await screen.findByRole('combobox', { name: 'Ansicht' }));
    await userEvent.click(screen.getByRole('option', { name: 'Nur Umsatz' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Jahr' })).toBeChecked());
    expect(tiles()).toEqual(['revenue', 'cash', 'bank_inbox', 'ar_aging', 'utilisation']);
    expect(screen.getByRole('link', { name: 'Bankzeilen buchen' })).toBeInTheDocument();
  });

  it('a custom period round-trips through a saved view', async () => {
    let saved: Record<string, unknown> | null = null;
    const canned = happyCanned();
    canned.create_saved_view = (input) => {
      saved = input;
      return ok({ savedView: { viewId: 'view_c', name: 'Frühling', layout: 'dashboard', columns: [] } });
    };
    renderSurface(canned, {});
    await screen.findByText("CHF 12'500.00");
    await userEvent.click(screen.getByRole('radio', { name: 'Benutzerdefiniert' }));
    const from = screen.getByLabelText('Von');
    const to = screen.getByLabelText('Bis');
    await userEvent.clear(to);
    await userEvent.type(to, '2026-04-30');
    await userEvent.clear(from);
    await userEvent.type(from, '2026-02-01');
    await userEvent.click(screen.getByRole('button', { name: 'Mehr zur Übersicht' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Als Ansicht speichern' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Frühling{Enter}');
    await waitFor(() => expect(saved).not.toBeNull());
    expect((saved as unknown as { filters: Record<string, unknown> }).filters).toMatchObject({ rangePreset: 'custom', from: '2026-02-01', to: '2026-04-30' });
    const { viewLayout } = await import('./layout');
    expect(viewLayout({ filters: (saved as unknown as { filters: unknown }).filters }).custom).toEqual({ from: '2026-02-01', to: '2026-04-30' });
  });

  it('after a change to an applied view the picker names no view, and Standardansicht still resets', async () => {
    const canned = happyCanned();
    canned.list_saved_views = ok({ entityKind: 'workspace', savedViews: [{ ...SAVED_VIEWS[0], filters: { rangePreset: 'month', widgets: [], bankAction: 'tile' }, columns: ['cash'] }] });
    renderSurface(canned, {});
    await screen.findByText("CHF 12'500.00");
    const picker = await screen.findByRole('combobox', { name: 'Ansicht' });
    await userEvent.click(picker);
    await userEvent.click(screen.getByRole('option', { name: 'Nur Umsatz' }));
    expect(picker).toHaveTextContent('Nur Umsatz');
    await userEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Einblenden', description: 'Umsatz' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fertig' }));
    expect(picker).not.toHaveTextContent('Nur Umsatz');
    // Never an empty trigger: the customised state has its own word.
    expect(picker).toHaveTextContent('Angepasst');
    await userEvent.click(picker);
    await userEvent.click(screen.getByRole('option', { name: 'Standardansicht' }));
    expect(screen.getByText('Standard wiederhergestellt.')).toBeInTheDocument();
    expect(tiles()).toEqual(['revenue', 'cash', 'ar_aging', 'utilisation']);
    expect(picker).toHaveTextContent('Standardansicht');
  });

  it('the page Mehr rows carry their glyph beside the words', async () => {
    renderSurface(happyCanned(), {});
    await screen.findByText("CHF 12'500.00");
    await userEvent.click(screen.getByRole('button', { name: 'Mehr zur Übersicht' }));
    for (const name of ['Als Ansicht speichern', 'Standard wiederherstellen']) {
      expect(screen.getByRole('menuitem', { name }).querySelector('.overflow-menu-item-glyph svg')).not.toBeNull();
    }
  });

  it('the bank size menu has no axe violations while it is open', async () => {
    const { container } = renderSurface(withBank(), {});
    await startEditing();
    await userEvent.click(screen.getByRole('button', { name: 'Grösse ändern: Bank' }));
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
    await settle();
    // The open menu is portalled onto the body, so the whole body is checked. `region` is the one rule
    // left out: it asks a full page for landmarks, and this harness mounts a bare surface plus a probe.
    expect(await axe(document.body, { rules: { region: { enabled: false } } })).toHaveNoViolations();
    expect(container).toBeInTheDocument();
  });

  it('the drag preview is a DOM clone: a vendor name with markup stays text, and no element is created', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const canned = happyCanned();
    canned.list_vendor_bills = ok({ ...BILLS, bills: [{ ...BILLS.bills[0], vendorName: hostile }] });
    renderSurface(canned, {});
    await screen.findByText(hostile);
    await userEvent.click(screen.getByRole('button', { name: 'Anpassen' }));
    const face = document.querySelector('[data-slot="open_creditors"] .uebersicht-item__face') as Element;
    // A structure only the DOM can hold: a <p> inside a <p>. Serialising it and parsing it again (any
    // innerHTML round trip) splits it into siblings, so this subtree tells a clone from a re-parse.
    const outer = document.createElement('p');
    outer.className = 'probe-outer';
    const inner = document.createElement('p');
    inner.className = 'probe-inner';
    outer.appendChild(inner);
    face.appendChild(outer);
    const setter = vi.spyOn(Element.prototype, 'innerHTML', 'set');
    const { FaceSnapshot } = await import('./EditControls');
    const preview = render(<FaceSnapshot face={face} />).container.querySelector('.uebersicht-overlay-face') as HTMLElement;
    expect(setter).not.toHaveBeenCalled();
    setter.mockRestore();
    expect(preview.querySelector('p.probe-outer > p.probe-inner')).not.toBeNull();
    expect(preview).toHaveAttribute('aria-hidden', 'true');
    expect(preview.textContent).toContain(hostile);
    expect(preview.querySelector('img')).toBeNull();
    // The clone carries no ids (the original is still on the page) and no inert.
    expect(preview.querySelector('[id], [inert], [aria-labelledby], [aria-describedby]')).toBeNull();
  });

  it('the edit mode has no axe violations', async () => {
    const { container } = renderSurface(withBank(), {});
    await startEditing();
    await screen.findByRole('link', { name: 'Papeterie Muster AG' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
