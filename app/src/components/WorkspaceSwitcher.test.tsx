/**
 * WorkspaceSwitcher (D24, variant A): the rail-head picker over `list_workspaces`.
 *
 * The keyboard model mirrors OverflowMenu (the shared APG menu-button pattern), so the same
 * behaviours are asserted here: open positions, wrapping, roving focus, Escape returning focus to
 * the trigger, Tab and outside-click closing. The data states get their own block: loading and
 * error NEVER show the raw workspace id (K-02): the trigger names the last known workspace or holds
 * an empty placeholder, and the menu always keeps the new-workspace way out.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { axe } from 'jest-axe';

import { TillClientProvider } from '../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../lib/client';
import { I18nProvider } from '../i18n';
import { WorkspaceProvider, WorkspaceRoute } from '../app/workspace';
import { watchReads, type WatchedTransport } from '../test-transport';
import { WorkspaceSwitcher, forgetWorkspaceNames, WORKSPACE_NAMES_KEY } from './WorkspaceSwitcher';

/**
 * The engine's REAL `list_workspaces` shape, read from the SHARED fixture file. The root suite
 * (`test/setup/workspaces-fixture.test.mjs`) asserts this fixture against a live engine call, so
 * the app suite can never quietly pass against a shape the engine no longer produces.
 */
import fixture from '../surfaces/Setup/workspaces.fixture.json';

const LIST: RestResponse = { status: 200, body: fixture as unknown as RestResponse['body'] };

type Route = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);

function makeTransport(routes: Record<string, Route>): WatchedTransport {
  const base: Transport = async (action, input) => {
    const route = routes[action];
    if (route === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof route === 'function' ? route(input) : route;
  };
  // Watched so the loading test can prove the list read it asserts over actually started.
  return watchReads(base);
}

/** Show where the router currently is, so navigation is assertable. */
function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderSwitcher({
  initialId = 'ws_1' as string | null,
  routes = { list_workspaces: LIST } as Record<string, Route>,
  initialPath = '/accounts',
} = {}) {
  // The plain MemoryRouter, not `createMemoryRouter`: the data router builds a fetch Request per
  // navigation, and jsdom's AbortSignal is not the undici one, so programmatic navigation explodes
  // in the environment rather than in the code under test.
  const transport = makeTransport(routes);
  const utils = render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <WorkspaceProvider initialId={initialId}>
          <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
              <Route path="/w/:workspaceId" element={<WorkspaceRoute />} />
              <Route
                path="*"
                element={
                  <div>
                    <button type="button">before</button>
                    <WorkspaceSwitcher />
                    <LocationProbe />
                  </div>
                }
              />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { ...utils, transport };
}

async function openedTrigger(name = 'Arbeitsbereich wechseln: Muster Grafik') {
  const trigger = await screen.findByRole('button', { name });
  await userEvent.click(trigger);
  return trigger;
}

beforeEach(() => {
  // The last-known-name cache outlives a render (in memory and in storage), so every test starts
  // with no name remembered.
  forgetWorkspaceNames();
  window.localStorage.clear();
});

describe('WorkspaceSwitcher: rendering states', () => {
  it('renders NOTHING while no workspace is selected', () => {
    renderSwitcher({ initialId: null });
    expect(screen.queryByRole('button', { name: /Arbeitsbereich wechseln/ })).toBeNull();
  });

  it('never shows the raw id while the list is loading: an empty placeholder instead (K-02)', async () => {
    const { transport } = renderSwitcher({
      routes: { list_workspaces: () => new Promise<RestResponse>(() => {}) },
    });
    await transport.started('list_workspaces');
    const trigger = screen.getByRole('button', { name: 'Arbeitsbereich wechseln' });
    expect(trigger).not.toHaveTextContent('ws_1');
    expect(trigger.querySelector('.ws-switcher-skeleton')).not.toBeNull();
  });

  it('shows the LAST KNOWN name while a later load is in flight, never the raw id (K-02)', async () => {
    window.localStorage.setItem(WORKSPACE_NAMES_KEY, JSON.stringify({ ws_1: 'Muster Grafik' }));
    const { transport } = renderSwitcher({
      routes: { list_workspaces: () => new Promise<RestResponse>(() => {}) },
    });
    await transport.started('list_workspaces');
    expect(screen.getByRole('button', { name: 'Arbeitsbereich wechseln: Muster Grafik' })).toHaveTextContent('Muster Grafik');
  });

  it('remembers the names a list read returned, for the next load', async () => {
    renderSwitcher();
    await screen.findByRole('button', { name: 'Arbeitsbereich wechseln: Muster Grafik' });
    const stored = JSON.parse(window.localStorage.getItem(WORKSPACE_NAMES_KEY) ?? '{}') as Record<string, string>;
    expect(stored.ws_1).toBe('Muster Grafik');
  });

  it('names the CURRENT workspace on the trigger once the list has loaded', async () => {
    renderSwitcher();
    const trigger = await screen.findByRole('button', { name: 'Arbeitsbereich wechseln: Muster Grafik' });
    expect(trigger).toHaveTextContent('Muster Grafik');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('never shows the raw id when the current id is unknown to the list (K-02)', async () => {
    const { transport } = renderSwitcher({ initialId: 'ws_unknown' });
    await transport.started('list_workspaces');
    await userEvent.click(screen.getByRole('button', { name: 'Arbeitsbereich wechseln' }));
    // The list did load (the menu has the rows), and the trigger still names no machine id.
    expect(await screen.findAllByRole('menuitem')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Arbeitsbereich wechseln' })).not.toHaveTextContent('ws_unknown');
  });

  it('lists ALL workspaces with a currency + created-date meta line, plus the new-workspace item below a separator', async () => {
    renderSwitcher();
    await openedTrigger();

    const items = screen.getAllByRole('menuitem');
    // Three fixture workspaces plus "Neuer Arbeitsbereich".
    expect(items).toHaveLength(4);
    // The meta line now carries the two facts that actually tell two sets of books apart: the base
    // currency and the created date (D15 format), NOT the raw ws_<uuid>, which wrapped over two lines
    // at rail width and carried near-zero recognition value (D33 defect 2).
    expect(items[0]).toHaveTextContent('Beispiel Bau AG');
    expect(items[0]).toHaveTextContent('EUR · 16.07.2026');
    expect(items[2]).toHaveTextContent('Muster Grafik');
    expect(items[2]).toHaveTextContent('CHF · 16.07.2026');
    expect(items[3]).toHaveTextContent('Neuer Arbeitsbereich');
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('drops the raw ws_<uuid> from the meta line, keeping it to a single truncating span', async () => {
    renderSwitcher();
    await openedTrigger();

    const metas = document.querySelectorAll('.ws-switcher-item-meta');
    // One meta span per workspace row (the new-workspace item has none).
    expect(metas).toHaveLength(3);
    metas.forEach((meta) => {
      // No raw id leaks into the meta line: that id is exactly what wrapped at rail width.
      expect(meta.textContent).not.toMatch(/ws_/);
      // Kept to a single line via CSS truncation, so a long value ellipses instead of wrapping.
      expect(meta).toHaveClass('ws-switcher-item-meta');
    });
  });

  it('marks the CURRENT workspace with aria-current and no other item', async () => {
    renderSwitcher();
    await openedTrigger();

    const current = screen.getByRole('menuitem', { name: /Muster Grafik/ });
    expect(current).toHaveAttribute('aria-current', 'true');
    const marked = screen.getAllByRole('menuitem').filter((el) => el.hasAttribute('aria-current'));
    expect(marked).toHaveLength(1);
  });

  it('a single-workspace list shows that one row (current) plus the new-workspace item', async () => {
    const single = { ...fixture, workspaces: [fixture.workspaces[2]] };
    renderSwitcher({ routes: { list_workspaces: { status: 200, body: single as unknown as RestResponse['body'] } } });
    await openedTrigger();

    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('aria-current', 'true');
    expect(items[1]).toHaveTextContent('Neuer Arbeitsbereich');
  });

  it('on a load error the trigger shows no raw id and the menu still offers the way to Setup', async () => {
    renderSwitcher({ routes: { list_workspaces: { status: 422, body: { ok: false, error: 'transport_error' } } } });
    const trigger = await screen.findByRole('button', { name: 'Arbeitsbereich wechseln' });
    expect(trigger).not.toHaveTextContent('ws_1');
    await userEvent.click(trigger);

    expect(screen.getByText('Die Liste der Arbeitsbereiche konnte nicht geladen werden.')).toBeInTheDocument();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Neuer Arbeitsbereich');
  });

  it('the load error offers a retry that refetches and recovers the list (no dead end)', async () => {
    let calls = 0;
    const route = () => {
      calls += 1;
      return calls === 1
        ? { status: 422, body: { ok: false, error: 'transport_error' } as const }
        : LIST;
    };
    renderSwitcher({ routes: { list_workspaces: route as Route } });
    const trigger = await screen.findByRole('button', { name: 'Arbeitsbereich wechseln' });
    await userEvent.click(trigger);

    // The failed read is not a dead end: a retry control sits beside the sentence.
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));

    // The refetch succeeds: the trigger now names the current workspace and the full list is back.
    expect(await screen.findByRole('button', { name: 'Arbeitsbereich wechseln: Muster Grafik' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(4);
  });
});

describe('WorkspaceSwitcher: each mandate carries its Pendenzen count (K-03)', () => {
  const summary = (totals: Record<string, number | null>) => (input: Record<string, unknown>) => ({
    status: 200,
    body: { ok: true, total: totals[String(input.workspaceId)] ?? 0 } as unknown as RestResponse['body'],
  });

  it('shows a positive count on its row, and nothing for zero or a denied read', async () => {
    const [first, second, third] = fixture.workspaces;
    renderSwitcher({
      routes: {
        list_workspaces: LIST,
        attention_summary: summary({ [first.workspaceId]: 8, [second.workspaceId]: 0, [third.workspaceId]: null }),
      },
    });
    await openedTrigger();
    const rows = screen.getAllByRole('menuitem');
    await waitFor(() => expect(rows[0].querySelector('.ws-switcher-item-count')).not.toBeNull());
    expect(within(rows[0]).getByRole('img', { name: '8 Pendenzen' })).toHaveTextContent('8');
    // A true zero and a denied read (total null) show nothing: never a placeholder, never a fake zero.
    expect(rows[1].querySelector('.ws-switcher-item-count')).toBeNull();
    expect(rows[2].querySelector('.ws-switcher-item-count')).toBeNull();
  });

  it('reads the counts only when the menu opens', async () => {
    const { transport } = renderSwitcher({ routes: { list_workspaces: LIST, attention_summary: summary({}) } });
    await screen.findByRole('button', { name: 'Arbeitsbereich wechseln: Muster Grafik' });
    expect(transport.asked.filter((a) => a === 'attention_summary')).toHaveLength(0);
    await openedTrigger();
    await transport.started('attention_summary', 3);
  });
});

describe('WorkspaceSwitcher: navigation', () => {
  it('selecting a workspace navigates to /w/:workspaceId and the WorkspaceRoute adopts it', async () => {
    renderSwitcher();
    await openedTrigger();

    await userEvent.click(screen.getByRole('menuitem', { name: /Beispiel Bau AG/ }));

    // The WorkspaceRoute adopts ws_3 and redirects back into the app; the trigger now names it.
    expect(await screen.findByRole('button', { name: 'Arbeitsbereich wechseln: Beispiel Bau AG' })).toBeInTheDocument();
  });

  it('"Neuer Arbeitsbereich" leads to Setup\'s CREATE form, never the current profile (F-09, J1.5)', async () => {
    renderSwitcher();
    await openedTrigger();

    await userEvent.click(screen.getByRole('menuitem', { name: 'Neuer Arbeitsbereich' }));

    // `?new=1` is what makes Setup render the create form instead of the current mandate's profile
    // with its name field focused (the J1.5 measurement typed the new mandate's name into Seeblick).
    expect(screen.getByTestId('location')).toHaveTextContent('/setup?new=1');
  });
});

describe('WorkspaceSwitcher: the shared menu-button keyboard model', () => {
  it('Enter opens the menu and puts focus on the FIRST item', async () => {
    renderSwitcher();
    const trigger = await screen.findByRole('button', { name: /Muster Grafik/ });
    trigger.focus();
    await userEvent.keyboard('{Enter}');

    expect(screen.getByRole('menuitem', { name: /Beispiel Bau AG/ })).toHaveFocus();
  });

  it('Space opens the menu and puts focus on the first item', async () => {
    renderSwitcher();
    const trigger = await screen.findByRole('button', { name: /Muster Grafik/ });
    trigger.focus();
    await userEvent.keyboard(' ');

    expect(screen.getByRole('menuitem', { name: /Beispiel Bau AG/ })).toHaveFocus();
  });

  it('ArrowDown opens at the first item, ArrowUp opens at the LAST (the new-workspace item)', async () => {
    renderSwitcher();
    const trigger = await screen.findByRole('button', { name: /Muster Grafik/ });
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /Beispiel Bau AG/ })).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Neuer Arbeitsbereich' })).toHaveFocus();
  });

  it('arrow keys move between items and wrap at both ends', async () => {
    renderSwitcher();
    await openedTrigger();

    expect(screen.getByRole('menuitem', { name: /Beispiel Bau AG/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /Alpstein Treuhand GmbH/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Neuer Arbeitsbereich' })).toHaveFocus();

    // Wraps forward from the last item back to the first, and backward again.
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /Beispiel Bau AG/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Neuer Arbeitsbereich' })).toHaveFocus();
  });

  it('Home and End jump to the first and last item', async () => {
    renderSwitcher();
    await openedTrigger();

    await userEvent.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Neuer Arbeitsbereich' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: /Beispiel Bau AG/ })).toHaveFocus();
  });

  it('focus is ROVING: exactly one item is tabbable at a time', async () => {
    renderSwitcher();
    await openedTrigger();

    const tabbable = () => screen.getAllByRole('menuitem').filter((el) => el.getAttribute('tabindex') === '0');
    expect(tabbable()).toHaveLength(1);
    await userEvent.keyboard('{ArrowDown}');
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toHaveTextContent('Alpstein Treuhand GmbH');
  });

  it('Escape closes the menu and returns focus TO THE TRIGGER, not the body', async () => {
    renderSwitcher();
    const trigger = await openedTrigger();
    await userEvent.keyboard('{ArrowDown}');

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('Tab closes the menu and lets focus move on', async () => {
    renderSwitcher();
    await openedTrigger();

    await userEvent.tab();

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a pointer press outside closes the menu without stealing focus back', async () => {
    renderSwitcher();
    const trigger = await openedTrigger();
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'before' }));

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).not.toHaveFocus();
  });

  it('clicking the trigger a second time closes the menu', async () => {
    renderSwitcher();
    const trigger = await openedTrigger();
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await userEvent.click(trigger);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('WorkspaceSwitcher: accessibility', () => {
  it('the open menu has no axe violations', async () => {
    const { container } = renderSwitcher();
    await openedTrigger();
    await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });
});
