import { describe, it, expect } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { axe } from 'jest-axe';

import { I18nProvider } from '../i18n';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type Transport, type RestResponse } from '../lib/client';
import { ThemeProvider, type Theme } from './theme';
import { DensityProvider } from './density';
import { WorkspaceProvider, WorkspaceRoute } from './workspace';
import { Shell } from './Shell';
import { Placeholder } from './Placeholder';
import { NAV_ITEMS } from './nav';

/** The engine's real `list_workspaces` shape; the root suite pins it against a live engine call. */
import workspacesFixture from '../surfaces/Setup/workspaces.fixture.json';

const LIST: RestResponse = { status: 200, body: workspacesFixture as unknown as RestResponse['body'] };

function makeClient(routes: Record<string, RestResponse> = { list_workspaces: LIST }): TillClient {
  const transport: Transport = async (action) =>
    routes[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
  return new TillClient(transport);
}

/** Build a memory router around the Shell so NavLink and Outlet have their router context. The rail
 *  footer renders the theme toggle, so a ThemeProvider wraps the tree; the rail-head workspace
 *  switcher reads the client and the workspace, so those providers wrap it too. With no
 *  `workspaceId` the switcher renders nothing and the shell reads exactly as before. The plain
 *  MemoryRouter, not `createMemoryRouter`: the data router builds a fetch Request per navigation,
 *  and jsdom's AbortSignal is not the undici one, so programmatic navigation explodes in the
 *  environment rather than in the code under test. */
/** F-02: the shell's WorkspaceResolver reads `list_workspaces` once per load and adopts the newest
 *  workspace when none is selected, so a render is only settled after that one async read (and the
 *  reads the adopted workspace triggers: the switcher's list, the badge's summary) has landed. One
 *  macrotask flush inside `act` settles every immediately-resolving transport in this file. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderShell(
  initialPath = '/setup',
  { workspaceId = null as string | null, client = makeClient(), theme = 'light' as Theme } = {},
) {
  const rendered = render(
    <ThemeProvider initialTheme={theme}>
      <DensityProvider initialDensity="komfortabel">
      <TillClientProvider client={client}>
        <I18nProvider>
          <WorkspaceProvider initialId={workspaceId}>
            <MemoryRouter initialEntries={[initialPath]}>
              <Routes>
                <Route path="/w/:workspaceId" element={<WorkspaceRoute />} />
                <Route path="/" element={<Shell />}>
                  {NAV_ITEMS.map((item) => (
                    <Route
                      key={item.path}
                      path={item.path.replace(/^\//, '')}
                      element={<Placeholder titleKey={item.labelKey} />}
                    />
                  ))}
                </Route>
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>
      </DensityProvider>
    </ThemeProvider>,
  );
  await settle();
  return rendered;
}

/** Expand a collapsed group/parent treeitem by clicking its header, if it is not already open. */
async function expandNode(name: string): Promise<void> {
  const item = screen.getByRole('treeitem', { name });
  if (item.getAttribute('aria-expanded') === 'false') await userEvent.click(item);
}

describe('Shell rail: the collapsible tree (D118 A1)', () => {
  it('renders a role=tree with the daily surfaces always visible and headed groups collapsed', async () => {
    await renderShell('/overview');
    const tree = screen.getByRole('tree', { name: 'Hauptnavigation' });
    // A headerless daily cluster is never collapsible: its leaves are always on screen.
    expect(within(tree).getByRole('treeitem', { name: 'Übersicht' })).toBeInTheDocument();
    expect(within(tree).getByRole('treeitem', { name: 'Aufgaben' })).toBeInTheDocument();
    expect(within(tree).getByRole('treeitem', { name: 'Agent' })).toBeInTheDocument();
    // A headed group starts collapsed, so it shows its header but not its destinations.
    const stammdaten = within(tree).getByRole('treeitem', { name: 'Stammdaten' });
    expect(stammdaten).toHaveAttribute('aria-expanded', 'false');
    expect(within(tree).queryByRole('treeitem', { name: 'Konten' })).toBeNull();
  });

  it('overrides the link role on every tree node, so a parent is a heading and never a link', async () => {
    await renderShell('/overview');
    const tree = screen.getByRole('tree', { name: 'Hauptnavigation' });
    // The whole rail is a treeview: destinations are treeitems, not links, and a parent has no
    // destination at all. Both together are the W1 invariant (link count == destination count).
    expect(within(tree).queryAllByRole('link')).toHaveLength(0);
  });

  it('expands a group on click to reveal its destinations', async () => {
    await renderShell('/overview');
    await userEvent.click(screen.getByRole('treeitem', { name: 'Stammdaten' }));
    expect(screen.getByRole('treeitem', { name: 'Stammdaten' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('treeitem', { name: 'Konten' })).toBeInTheDocument();
    // The A2 fold: the inventory family sits behind a Lager parent, collapsed inside the group.
    const lager = screen.getByRole('treeitem', { name: 'Lager' });
    expect(lager).toHaveAttribute('aria-expanded', 'false');
    // A parent is a heading, not a link: no href behind it (W1). Its child /inventory stays hidden
    // while it is collapsed, so only the parent matches here.
    expect(lager).not.toHaveAttribute('href');
  });

  it('auto-expands the ancestor chain of a deep link so the active item is visible', async () => {
    // /vat is nested two levels deep: Buchhaltung > MWST > Einstellungen. Both must open on load.
    await renderShell('/vat');
    expect(screen.getByRole('treeitem', { name: 'Buchhaltung' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('treeitem', { name: 'MWST' })).toHaveAttribute('aria-expanded', 'true');
    const mwst = screen.getByRole('group', { name: 'MWST' });
    const active = within(mwst).getByRole('treeitem', { name: 'Einstellungen' });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active).toHaveAttribute('aria-selected', 'true');
  });

  it('marks the active surface with aria-current and aria-selected (not colour alone)', async () => {
    await renderShell('/accounts');
    const active = screen.getByRole('treeitem', { name: 'Konten' });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active).toHaveAttribute('aria-selected', 'true');
  });

  it('offers the theme toggle in the rail footer', async () => {
    await renderShell();
    expect(screen.getByRole('button', { name: 'Design wechseln' })).toBeInTheDocument();
  });

  it('offers the density toggle in the rail footer, beside the theme toggle (B3)', async () => {
    await renderShell();
    const theme = screen.getByRole('button', { name: 'Design wechseln' });
    // Komfortabel is the default, so the control offers the trip TO the compact view.
    const density = screen.getByRole('button', { name: 'Kompakte Ansicht' });
    expect(density).toBeInTheDocument();
    // Twins in one footer: same parent, and the density control keeps its own accessible state.
    expect(density.parentElement).toBe(theme.parentElement);
    expect(density).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders the routed surface in main', async () => {
    await renderShell('/journal');
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { name: 'Journal', level: 1 })).toBeInTheDocument();
  });

  it('has no axe violations in the light theme', async () => {
    const { container } = await renderShell('/vat', { theme: 'light' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the dark theme with nested levels on screen', async () => {
    const { container } = await renderShell('/vat', { theme: 'dark' });
    // Open one more group so a collapsed and an expanded subtree are both present for the scan.
    await expandNode('Stammdaten');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Shell: the nested MWST rail parent (owner decision W1)', () => {
  it('renders MWST as a heading, never as a link, because it has no destination', async () => {
    await renderShell('/mwst');
    const tree = screen.getByRole('tree', { name: 'Hauptnavigation' });
    expect(within(tree).getByRole('treeitem', { name: 'MWST' })).toBeInTheDocument();
    expect(within(tree).queryByRole('link', { name: 'MWST' })).toBeNull();
  });

  it('holds both children in a group the parent names, Abrechnung leading', async () => {
    await renderShell('/mwst');
    const sub = screen.getByRole('group', { name: 'MWST' });
    const labels = within(sub)
      .getAllByRole('treeitem')
      .map((el) => el.textContent);
    expect(labels).toEqual(['Abrechnung', 'Einstellungen']);
  });

  it('marks a nested child active with aria-current, exactly like a top-level item', async () => {
    await renderShell('/mwst');
    const mwst = screen.getByRole('group', { name: 'MWST' });
    expect(within(mwst).getByRole('treeitem', { name: 'Abrechnung' })).toHaveAttribute('aria-current', 'page');
    // The sibling is not dragged along by the shared parent.
    expect(within(mwst).getByRole('treeitem', { name: 'Einstellungen' })).not.toHaveAttribute('aria-current');
  });

  it('still routes the untouched /vat path from the nested child', async () => {
    await renderShell('/vat');
    const mwst = screen.getByRole('group', { name: 'MWST' });
    expect(within(mwst).getByRole('treeitem', { name: 'Einstellungen' })).toHaveAttribute('aria-current', 'page');
  });

  it('has no axe violations with the third level on screen', async () => {
    const { container } = await renderShell('/mwst');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Shell: the rail-head workspace switcher (D24, variant A)', () => {
  it('does not render the switcher while no workspace is selected', async () => {
    // F-02: with workspaces on the ledger the resolver would adopt the newest one; an EMPTY ledger is
    // the state in which nothing is selected after the load settles.
    const empty: RestResponse = { status: 200, body: { ok: true, workspaces: [] } };
    await renderShell('/setup', { workspaceId: null, client: makeClient({ list_workspaces: empty }) });
    expect(screen.queryByRole('button', { name: /Arbeitsbereich wechseln/ })).toBeNull();
  });

  it('renders the switcher in the rail head, naming the current workspace', async () => {
    await renderShell('/journal', { workspaceId: 'ws_1' });
    const nav = screen.getByRole('navigation', { name: 'Hauptnavigation' });
    const trigger = await within(nav).findByRole('button', { name: 'Arbeitsbereich wechseln: Muster Grafik' });
    expect(trigger).toHaveTextContent('Muster Grafik');
  });

  it('switching workspaces from the rail adopts the target workspace and stays in the app', async () => {
    await renderShell('/journal', { workspaceId: 'ws_1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Arbeitsbereich wechseln: Muster Grafik' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Alpstein Treuhand GmbH/ }));

    // `/w/ws_2` adopted the workspace and redirected back into the shell.
    expect(await screen.findByRole('button', { name: 'Arbeitsbereich wechseln: Alpstein Treuhand GmbH' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Hauptnavigation' })).toBeInTheDocument();
  });

  it('offers the way to a new workspace below a separator', async () => {
    await renderShell('/journal', { workspaceId: 'ws_1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Arbeitsbereich wechseln: Muster Grafik' }));

    // Scoped to the switcher menu: the A4 rail resizer is also a role="separator" in the frame.
    expect(within(screen.getByRole('menu')).getByRole('separator')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Neuer Arbeitsbereich' }));

    // /setup renders the Setup placeholder inside this harness's router.
    expect(await screen.findByRole('heading', { name: 'Einrichtung', level: 1 })).toBeInTheDocument();
  });

  it('has no axe violations with the switcher menu open', async () => {
    const { container } = await renderShell('/journal', { workspaceId: 'ws_1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Arbeitsbereich wechseln: Muster Grafik' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Shell: the G16 frame additions', () => {
  it('offers a skip link to the main content as a focusable bypass', async () => {
    await renderShell();
    const skip = screen.getByRole('link', { name: 'Zum Inhalt springen' });
    expect(skip).toHaveAttribute('href', '#main-content');
  });

  it('carries the command-palette trigger in the rail head', async () => {
    await renderShell();
    expect(screen.getByRole('button', { name: /Suchen/ })).toBeInTheDocument();
  });

  it('renders the /agent rail entry with no badge when no count is provided', async () => {
    await renderShell();
    const nav = screen.getByRole('navigation', { name: 'Hauptnavigation' });
    expect(within(nav).getByRole('treeitem', { name: 'Agent' })).toBeInTheDocument();
  });

  it('toggles the responsive drawer from the hamburger', async () => {
    await renderShell();
    const hamburger = screen.getByRole('button', { name: 'Menü' });
    expect(hamburger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(hamburger);
    expect(hamburger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    expect(hamburger).toHaveAttribute('aria-expanded', 'false');
  });

  it('traps focus inside the collapse drawer while it is open (spec: a focus-trapped overlay drawer)', async () => {
    await renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Menü' }));
    const nav = screen.getByRole('navigation', { name: 'Hauptnavigation' });
    // Opening the drawer moves focus into it.
    expect(nav.contains(document.activeElement)).toBe(true);
    // Shift+Tab from the first control wraps to the last, and Tab forward stays inside: focus never
    // walks out onto the surface behind the scrim (the gap this closes let it reach the content).
    await userEvent.tab({ shift: true });
    expect(nav.contains(document.activeElement)).toBe(true);
    await userEvent.tab();
    expect(nav.contains(document.activeElement)).toBe(true);
  });

  it('shows the trust indicator in the rail footer, glyph plus accessible name', async () => {
    await renderShell();
    expect(screen.getByLabelText('Lokal, keine Verbindung')).toBeInTheDocument();
  });

  it('has no axe violations with the drawer open', async () => {
    const { container } = await renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Menü' }));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Shell: the M01 signed-in-identity chip (G15 slot)', () => {
  /** A served `whoami`: identity attested by a reverse proxy, so the chip names the subject. */
  const SERVED: RestResponse = {
    status: 200,
    body: {
      ok: true,
      actor: 'member:u_1',
      provisioned: true,
      isMember: true,
      memberId: 'm_1',
      userId: 'u_1',
      role: 'bookkeeper',
      capabilities: ['read_master_data'],
      identitySource: 'served_subject',
      subject: 'dominic@example.ch',
    } as unknown as RestResponse['body'],
  };

  /** A local `whoami`: no proxy, no login. The chip must render nothing. */
  const LOCAL: RestResponse = {
    status: 200,
    body: {
      ok: true,
      actor: 'studio',
      provisioned: true,
      isMember: true,
      memberId: 'm_1',
      userId: 'u_1',
      role: 'owner',
      capabilities: ['read_master_data'],
      identitySource: 'local_client',
      subject: null,
    } as unknown as RestResponse['body'],
  };

  it('shows the identity chip in the rail footer in served mode, naming the subject', async () => {
    const client = makeClient({ list_workspaces: LIST, whoami: SERVED });
    await renderShell('/journal', { workspaceId: 'ws_1', client });
    expect(
      await screen.findByRole('button', { name: 'Angemeldet als dominic@example.ch' }),
    ).toBeInTheDocument();
  });

  it('renders NO identity chip in local mode, even after whoami resolves', async () => {
    const client = makeClient({ list_workspaces: LIST, whoami: LOCAL });
    await renderShell('/journal', { workspaceId: 'ws_1', client });
    // Wait for the switcher (also client-driven) so whoami's effect has flushed, then assert absence.
    await screen.findByRole('button', { name: /Arbeitsbereich wechseln/ });
    expect(screen.queryByRole('button', { name: /Angemeldet als/ })).toBeNull();
  });
});
