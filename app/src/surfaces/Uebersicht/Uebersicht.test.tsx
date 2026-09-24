/**
 * F00, the Übersicht tile wall (spec §8): the per-tile states (skeleton, zero state,
 * degraded-hidden with the "Weitere Kacheln" hint, success with the trend glyph+figure, omitted
 * footnote), range validation, the saved-view picker with its fallback note, tile drill
 * navigation, and Ansicht speichern sending G00 exactly the rendered tile set. The transport is
 * canned per action, so every assertion is about what the surface sends and renders, not about
 * the engine.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import { Uebersicht, presetRange } from './index';

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

const happyCanned = (): Canned => ({
  dashboard_overview: ok({ workspaceId: 'ws_test', tiles: [...TILES], omitted: [] }),
  list_saved_views: ok({ entityKind: 'workspace', savedViews: [] }),
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

function renderSurface(canned: Canned | Transport) {
  const transport = typeof canned === 'function' ? canned : fakeTransport(canned);
  const client = new TillClient(transport);
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={['/overview']}>
            <Routes>
              <Route path="*" element={<><Uebersicht /><LocationProbe /></>} />
            </Routes>
          </MemoryRouter>
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

  it('an unresolvable saved view falls back with the neutral note, never a broken grid', async () => {
    const canned = happyCanned();
    canned.dashboard_overview = ok({ workspaceId: 'ws_test', tiles: [...TILES], omitted: [], viewFallback: true });
    renderSurface(canned);
    await screen.findByText("CHF 12'500.00");
    expect(screen.getByText(/Standardansicht wird angezeigt/)).toBeInTheDocument();
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

  it('the shared saved-view picker lists only dashboard views and drives the read by savedViewId', async () => {
    const reads: Record<string, unknown>[] = [];
    const canned = happyCanned();
    canned.list_saved_views = ok({ entityKind: 'workspace', savedViews: [...SAVED_VIEWS] });
    const inner = fakeTransport(canned);
    const transport: Transport = async (action, input) => {
      if (action === 'dashboard_overview') reads.push((input ?? {}) as Record<string, unknown>);
      return inner(action, input);
    };
    renderSurface(transport);
    await screen.findByText("CHF 12'500.00");
    const picker = await screen.findByRole('combobox', { name: 'Ansicht' });
    await userEvent.click(picker); // the custom Select portals its listbox open
    // Only the dashboard-layout views are offered; a ledger-layout view is not this surface's.
    expect(screen.getByRole('option', { name: 'Nur Umsatz' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Büro-Ansicht' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Kontenliste' })).toBeNull();
    // Choosing a view passes its id straight into the wall read (the engine merges its filters).
    await userEvent.click(screen.getByRole('option', { name: 'Büro-Ansicht' })); // v_shared
    await waitFor(() => expect(reads.some((i) => i.savedViewId === 'v_shared')).toBe(true));
  });

  it('Ansicht speichern sends G00 exactly the rendered tile set under layout dashboard', async () => {
    let saved: Record<string, unknown> | null = null;
    const canned = happyCanned();
    canned.create_saved_view = (input) => {
      saved = input;
      return ok({ savedView: { viewId: 'view_1', name: 'Meine', layout: 'dashboard', columns: [] } });
    };
    renderSurface(canned);
    await screen.findByText("CHF 12'500.00");
    await userEvent.click(screen.getByRole('button', { name: 'Ansicht speichern' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Meine Startseite');
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(saved).not.toBeNull());
    expect(saved).toMatchObject({
      entityKind: 'workspace',
      layout: 'dashboard',
      name: 'Meine Startseite',
      columns: ['revenue', 'cash', 'ar_aging', 'utilisation'],
    });
    expect((saved as unknown as { shared?: unknown }).shared).toBeUndefined();
  });

  it('the success state has no axe violations', async () => {
    const { container } = renderSurface(happyCanned());
    await screen.findByText("CHF 12'500.00");
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

