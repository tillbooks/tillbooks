/**
 * WorkspacesPanel (D24, variant B): the Setup surface's workspace management list.
 *
 * The four data states (loading, error with retry, rows, empty), the "Aktiv" chip sitting on the
 * active row and nowhere else, whole-row navigation to `/w/:workspaceId`, the footer handing over
 * to the surface's existing create affordance, and the `onlyWhenPopulated` mode the no-workspace
 * face uses. The fixture is the SHARED `workspaces.fixture.json`, pinned against a live engine
 * call by the root suite (`test/setup/workspaces-fixture.test.mjs`).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { axe } from 'jest-axe';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { watchReads, type WatchedTransport } from '../../test-transport';
import { WorkspacesPanel, type WorkspacesPanelProps } from './Workspaces';
import fixture from './workspaces.fixture.json';

const LIST: RestResponse = { status: 200, body: fixture as unknown as RestResponse['body'] };

type Route = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);

function makeTransport(routes: Record<string, Route>): WatchedTransport {
  const base: Transport = async (action, input) => {
    const route = routes[action];
    if (route === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof route === 'function' ? route(input) : route;
  };
  // Watched so a loading test can prove the read it asserts over actually started.
  return watchReads(base);
}

/** Show where the router currently is, so row navigation is assertable without more routes. */
function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderPanel(
  props: Partial<WorkspacesPanelProps> = {},
  routes: Record<string, Route> = { list_workspaces: LIST },
) {
  const transport = makeTransport(routes);
  const utils = render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider>
        <MemoryRouter initialEntries={['/setup']}>
          <WorkspacesPanel activeId="ws_1" onNewWorkspace={() => {}} {...props} />
          <LocationProbe />
        </MemoryRouter>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { ...utils, transport };
}

describe('WorkspacesPanel: the four data states', () => {
  it('renders the loading skeleton while list_workspaces is pending', async () => {
    const { transport } = renderPanel({}, { list_workspaces: () => new Promise<RestResponse>(() => {}) });
    expect(screen.getByRole('heading', { name: 'Arbeitsbereiche' })).toBeInTheDocument();
    // The panel paints its skeleton on the first commit, so the assertion below would hold just as
    // well over a panel that never listed anything. Waiting for the read is what makes it a claim
    // about a load in progress.
    await transport.started('list_workspaces');
    const status = await screen.findByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
  });

  it('renders an error banner whose retry refetches the list', async () => {
    let calls = 0;
    const route = () => {
      calls += 1;
      return calls === 1 ? { status: 422, body: { ok: false, error: 'transport_error' } as const } : LIST;
    };
    renderPanel({}, { list_workspaces: route as Route });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    // Flush the refetch inside act, then assert the rows.
    await act(async () => {});

    expect(await screen.findByRole('button', { name: 'Arbeitsbereich Muster Grafik öffnen' })).toBeInTheDocument();
  });

  it('renders every workspace as a row: name over id, currency and created date (dd.mm.yyyy)', async () => {
    renderPanel();
    const row = await screen.findByRole('button', { name: 'Arbeitsbereich Beispiel Bau AG öffnen' });
    expect(row).toHaveTextContent('Beispiel Bau AG');
    expect(row).toHaveTextContent('ws_3 · EUR · 16.07.2026');
    expect(screen.getByRole('button', { name: 'Arbeitsbereich Alpstein Treuhand GmbH öffnen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arbeitsbereich Muster Grafik öffnen' })).toBeInTheDocument();
  });

  it('says there are none yet when the engine lists none', async () => {
    const empty = { ...fixture, workspaces: [] };
    renderPanel({}, { list_workspaces: { status: 200, body: empty as unknown as RestResponse['body'] } });
    expect(await screen.findByText('Noch keine Arbeitsbereiche vorhanden.')).toBeInTheDocument();
  });
});

describe('WorkspacesPanel: the active row', () => {
  it('marks the ACTIVE workspace with the Aktiv chip and aria-current, and no other row', async () => {
    renderPanel({ activeId: 'ws_1' });
    const active = await screen.findByRole('button', { name: 'Arbeitsbereich Muster Grafik öffnen' });
    expect(within(active).getByText('Aktiv')).toBeInTheDocument();
    expect(active).toHaveAttribute('aria-current', 'true');

    const other = screen.getByRole('button', { name: 'Arbeitsbereich Beispiel Bau AG öffnen' });
    expect(within(other).queryByText('Aktiv')).toBeNull();
    expect(other).not.toHaveAttribute('aria-current');
    expect(screen.getAllByText('Aktiv')).toHaveLength(1);
  });

  it('a single-workspace list is one row carrying the chip', async () => {
    const single = { ...fixture, workspaces: [fixture.workspaces[2]] };
    renderPanel({ activeId: 'ws_1' }, { list_workspaces: { status: 200, body: single as unknown as RestResponse['body'] } });
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(screen.getByText('Aktiv')).toBeInTheDocument();
  });
});

describe('WorkspacesPanel: navigation and the create hand-over', () => {
  it('a row navigates to /w/:workspaceId', async () => {
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Arbeitsbereich Beispiel Bau AG öffnen' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/w/ws_3');
  });

  it('the footer "Neuer Arbeitsbereich" hands over to the existing create affordance', async () => {
    const onNew = vi.fn();
    renderPanel({ onNewWorkspace: onNew });
    await userEvent.click(await screen.findByRole('button', { name: 'Neuer Arbeitsbereich' }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});

describe('WorkspacesPanel: onlyWhenPopulated (the no-workspace face)', () => {
  it('renders nothing while loading', async () => {
    const { transport } = renderPanel(
      { onlyWhenPopulated: true },
      { list_workspaces: () => new Promise<RestResponse>(() => {}) },
    );
    // Absence is the cheapest assertion to satisfy: a panel that never read anything renders
    // nothing too. The wait is what makes this "silent WHILE loading" rather than "silent".
    await transport.started('list_workspaces');
    expect(screen.queryByRole('heading', { name: 'Arbeitsbereiche' })).toBeNull();
  });

  it('renders nothing on a load error', async () => {
    renderPanel({ onlyWhenPopulated: true }, { list_workspaces: { status: 422, body: { ok: false, error: 'transport_error' } } });
    // Give the load a beat to settle; the panel must stay absent, not flash an error.
    await act(async () => {});
    expect(screen.queryByRole('heading', { name: 'Arbeitsbereiche' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders nothing while the engine lists none', async () => {
    const empty = { ...fixture, workspaces: [] };
    renderPanel({ onlyWhenPopulated: true }, { list_workspaces: { status: 200, body: empty as unknown as RestResponse['body'] } });
    await act(async () => {});
    expect(screen.queryByRole('heading', { name: 'Arbeitsbereiche' })).toBeNull();
  });

  it('appears once the list is populated', async () => {
    renderPanel({ onlyWhenPopulated: true });
    expect(await screen.findByRole('heading', { name: 'Arbeitsbereiche' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('WorkspacesPanel: accessibility', () => {
  it('the populated panel has no axe violations', async () => {
    const { container } = renderPanel();
    await screen.findByRole('button', { name: 'Arbeitsbereich Muster Grafik öffnen' });
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
