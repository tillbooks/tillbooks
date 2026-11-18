import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
import { ROUTE_REGISTRY } from './nav';

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
  initialPath = '/overview',
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
                  {ROUTE_REGISTRY.map((item) => (
                    <Route
                      key={item.path}
                      path={item.path.replace(/^\//, '')}
                      element={<Placeholder titleKey={item.labelKey} />}
                    />
                  ))}
                  {/* D201: a group header opens its area overview (stood in for by a placeholder here). */}
                  <Route path="area/:groupId" element={<Placeholder titleKey="nav.overview" />} />
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
    expect(within(tree).getByRole('treeitem', { name: 'Pendenzen' })).toBeInTheDocument();
    // D210: Suche, Agent and Aufgaben left the tree (palette, gear and Pendenzen carry them).
    for (const gone of ['Suche', 'Agent', 'Aufgaben']) expect(within(tree).queryByRole('treeitem', { name: gone })).toBeNull();
    // A headed group starts collapsed, so it shows its header but not its destinations.
    const stammdaten = within(tree).getByRole('treeitem', { name: 'Stammdaten' });
    expect(stammdaten).toHaveAttribute('aria-expanded', 'false');
    expect(within(tree).queryByRole('treeitem', { name: 'Kontakte' })).toBeNull();
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
    // D201: the click also opened the area overview, whose header now wears the mark.
    expect(screen.getByRole('treeitem', { name: 'Stammdaten' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('treeitem', { name: 'Kontakte' })).toBeInTheDocument();
    // D210: the compact menu leaves the Lager and Anlagen parents out of Stammdaten.
    expect(screen.queryByRole('treeitem', { name: 'Lager' })).toBeNull();
    expect(screen.queryByRole('treeitem', { name: 'Anlagen' })).toBeNull();
  });

  it('auto-expands the ancestor chain of a deep link so the active item is visible', async () => {
    // D210: /mwst is one leaf of Buchhaltung; the group must open on load so the leaf shows.
    await renderShell('/mwst');
    expect(screen.getByRole('treeitem', { name: 'Buchhaltung' })).toHaveAttribute('aria-expanded', 'true');
    const accounting = screen.getByRole('group', { name: 'Buchhaltung' });
    const active = within(accounting).getByRole('treeitem', { name: 'MWST' });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active).toHaveAttribute('aria-selected', 'true');
  });

  it('marks the active surface with aria-current and aria-selected (not colour alone)', async () => {
    await renderShell('/accounts');
    const active = screen.getByRole('treeitem', { name: 'Konten' });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active).toHaveAttribute('aria-selected', 'true');
  });

  it('D210: light or dark is a checkbox item in the status menu beside the density, and switches the theme', async () => {
    await renderShell();
    const footer = document.querySelector('.rail-footer') as HTMLElement;
    expect(within(footer).queryByRole('button', { name: 'Design wechseln' })).toBeNull();
    await userEvent.click(within(footer).getByRole('button', { name: /^Lokal/ }));
    const item = screen.getByRole('menuitemcheckbox', { name: 'Dunkles Design' });
    const before = document.documentElement.getAttribute('data-theme');
    expect(item).toHaveAttribute('aria-checked', before === 'dark' ? 'true' : 'false');
    await userEvent.click(item);
    expect(document.documentElement.getAttribute('data-theme')).toBe(before === 'dark' ? 'light' : 'dark');
  });

  it('keeps the rail footer to ONE row: the company, the status dot, then the icon buttons (K-01, D204)', async () => {
    await renderShell('/overview', { workspaceId: 'ws_1' });
    const footer = document.querySelector('.rail-footer') as HTMLElement;
    // D204: no second row and no pill borders: everything is a direct child of the one footer row.
    expect(footer.querySelector('.rail-footer-row')).toBeNull();
    expect(footer.firstElementChild).toHaveClass('ws-switcher');
    const dot = within(footer).getByRole('button', { name: /^Lokal/ });
    // D210: the settings gear closes the row (light or dark moved into the dot's menu).
    const gear = within(footer).getByRole('button', { name: 'Einstellungen' });
    expect(footer.children[1]?.contains(dot)).toBe(true);
    expect(footer.lastElementChild?.contains(gear)).toBe(true);
    expect(within(footer).queryByRole('link')).toBeNull();
  });

  it('D210: the footer gear opens the Einstellungen page, and wears the mark while it is open', async () => {
    await renderShell('/overview', { workspaceId: 'ws_1' });
    const footer = document.querySelector('.rail-footer') as HTMLElement;
    const gear = within(footer).getByRole('button', { name: 'Einstellungen' });
    expect(gear).not.toHaveAttribute('aria-current');
    await userEvent.click(gear);
    expect(await screen.findByRole('heading', { name: 'Alle Einstellungen', level: 1 })).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: 'Einstellungen' })).toHaveAttribute('aria-current', 'page');
  });

  it('D204: the status is a dot whose accessible name carries the words, and a click opens its menu', async () => {
    await renderShell('/overview', { workspaceId: 'ws_1' });
    const footer = document.querySelector('.rail-footer') as HTMLElement;
    const dot = within(footer).getByRole('button', { name: /^Lokal/ });
    expect(dot).toHaveAttribute('aria-haspopup', 'menu');
    expect(dot).toHaveTextContent('');
    expect(dot.querySelector('.rail-env-dot')).not.toBeNull();
    await userEvent.click(dot);
    expect(screen.getByRole('menuitem', { name: 'Umgebungen verwalten' })).toBeInTheDocument();
  });

  it('offers the density switch in the status pill menu, and the collapse only in the rail head (B3, A4, D201)', async () => {
    await renderShell();
    await userEvent.click(screen.getByRole('button', { name: /^Lokal/ }));
    // Komfortabel is the default, so the checkbox item reads unchecked.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Kompakte Ansicht' })).toHaveAttribute('aria-checked', 'false');
    // One act, one place (D152 rule 3): the visible head toggle replaced the menu item.
    expect(screen.queryByRole('menuitem', { name: 'Navigation einklappen' })).toBeNull();
  });

  it('D201: the visible toggle in the rail head collapses to the icon strip and expands again, naming itself', async () => {
    await renderShell();
    const head = document.querySelector('.rail-head-row') as HTMLElement;
    const collapse = within(head).getByRole('button', { name: 'Navigation einklappen' });
    // Its words on hover and focus: the second line is its description, never the name twice.
    expect(collapse).toHaveAccessibleDescription('Nur Symbole zeigen');
    // The single-pointer, non-dragging alternative to the splitter (WCAG 2.5.7).
    await userEvent.click(collapse);
    expect(document.querySelector('.rail--icon')).not.toBeNull();
    const expand = screen.getByRole('button', { name: 'Navigation ausklappen' });
    expect(expand.closest('.rail-head')).not.toBeNull();
    expect(expand).toHaveAccessibleDescription('Namen zeigen');
    await userEvent.click(expand);
    expect(document.querySelector('.rail--icon')).toBeNull();
  });

  it('D204: the footer icon buttons name themselves on hover and focus', async () => {
    await renderShell();
    const footer = document.querySelector('.rail-footer') as HTMLElement;
    expect(within(footer).getByRole('button', { name: 'Einstellungen' })).toHaveAccessibleDescription('Alle Einstellungen dieses Arbeitsbereichs');
  });

  it('D187 option B: a pointer resting on the collapsed strip slides the whole menu open, and leaving folds it back', async () => {
    await renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Navigation einklappen' }));
    const rail = document.getElementById('studio-rail') as HTMLElement;
    expect(rail).toHaveClass('rail--icon', 'rail--floating');
    // The page keeps the strip's place while the rail floats.
    expect(document.querySelector('.rail-peek-spacer')).not.toBeNull();
    vi.useFakeTimers();
    try {
      act(() => {
        fireEvent.pointerEnter(rail, { pointerType: 'mouse' });
      });
      // Not yet: a quick pass across the strip opens nothing.
      expect(rail).not.toHaveClass('rail--peek');
      act(() => {
        vi.advanceTimersByTime(200);
      });
    } finally {
      vi.useRealTimers();
    }
    // The open rail mounts the full chrome (the switcher, the tree), whose reads land asynchronously.
    await settle();
    expect(rail).toHaveClass('rail--peek');
    expect(rail).not.toHaveClass('rail--icon');
    // The real tree, with its labels.
    expect(within(rail).getByRole('tree')).toBeInTheDocument();
    act(() => {
      fireEvent.pointerLeave(rail, { pointerType: 'mouse' });
    });
    await settle();
    expect(rail).not.toHaveClass('rail--peek');
    expect(rail).toHaveClass('rail--icon');
  });

  it('opens "Menü anpassen" from the status pill menu, the second door to the menu editor (D178)', async () => {
    await renderShell();
    await userEvent.click(screen.getByRole('button', { name: /^Lokal/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Menü anpassen' }));
    const editor = screen.getByRole('region', { name: 'Menü anpassen' });
    expect(within(editor).getByRole('button', { name: 'Fertig' })).toHaveFocus();
    // The rail's model rides on the nav band: the editor shows every favourite grip.
    expect(document.querySelector('.rail-nav')).toHaveAttribute('data-customising');
    expect(document.querySelector('.rail-nav')).toHaveAttribute('data-header-style', 'icon_14');
  });

  it('has no head tagline: the wordmark and the toggle share one row, the switcher is in the footer (K-01, D201)', async () => {
    await renderShell('/overview', { workspaceId: 'ws_1' });
    const row = document.querySelector('.rail-head-row') as HTMLElement;
    expect(within(row).getByText('TILL Studio')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Navigation einklappen' })).toBeInTheDocument();
    expect(row.querySelector('.ws-switcher-trigger')).toBeNull();
    expect(document.querySelector('.rail-footer .ws-switcher-trigger')).not.toBeNull();
    expect(screen.queryByText(/Schweizer Buchhaltung/)).toBeNull();
  });

  it('renders the routed surface in main', async () => {
    await renderShell('/journal');
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { name: 'Journal', level: 1 })).toBeInTheDocument();
  });

  it('has no axe violations in the light theme', async () => {
    const { container } = await renderShell('/mwst', { theme: 'light' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the dark theme with nested levels on screen', async () => {
    const { container } = await renderShell('/mwst', { theme: 'dark' });
    // Open one more group so a collapsed and an expanded subtree are both present for the scan.
    await expandNode('Stammdaten');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Shell: MWST is one leaf in Buchhaltung (D210, was the nested W1 parent)', () => {
  it('renders MWST as a leaf with its own destination, no group behind it', async () => {
    await renderShell('/mwst');
    const tree = screen.getByRole('tree', { name: 'Hauptnavigation' });
    const mwst = within(tree).getByRole('treeitem', { name: 'MWST' });
    expect(mwst).not.toHaveAttribute('aria-expanded');
    expect(within(tree).queryByRole('group', { name: 'MWST' })).toBeNull();
    expect(within(tree).queryByRole('treeitem', { name: 'MWST-Einstellungen' })).toBeNull();
  });

  it('marks the leaf active with aria-current, like any other item', async () => {
    await renderShell('/mwst');
    expect(screen.getByRole('treeitem', { name: 'MWST' })).toHaveAttribute('aria-current', 'page');
  });

  it('still routes the untouched /vat path, with no rail row lit for it', async () => {
    await renderShell('/vat');
    expect(within(screen.getByRole('main')).getByRole('heading', { name: 'MWST-Einstellungen', level: 1 })).toBeInTheDocument();
    expect(document.querySelectorAll('.rail-nav [aria-current="page"]')).toHaveLength(0);
  });

  it('has no axe violations with the leaf on screen', async () => {
    const { container } = await renderShell('/mwst');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Shell: the rail-footer workspace switcher (D24, variant A; D201)', () => {
  it('does not render the switcher while no workspace is selected', async () => {
    // F-02: with workspaces on the ledger the resolver would adopt the newest one; an EMPTY ledger is
    // the state in which nothing is selected after the load settles.
    const empty: RestResponse = { status: 200, body: { ok: true, workspaces: [] } };
    await renderShell('/setup', { workspaceId: null, client: makeClient({ list_workspaces: empty }) });
    expect(screen.queryByRole('button', { name: /Arbeitsbereich wechseln/ })).toBeNull();
  });

  it('renders the switcher in the rail footer, naming the current workspace, its menu opening upward (D201)', async () => {
    await renderShell('/journal', { workspaceId: 'ws_1' });
    const nav = screen.getByRole('navigation', { name: 'Hauptnavigation' });
    const trigger = await within(nav).findByRole('button', { name: 'Arbeitsbereich wechseln: Muster Grafik' });
    expect(trigger).toHaveTextContent('Muster Grafik');
    expect(trigger.closest('.rail-footer')).not.toBeNull();
    await userEvent.click(trigger);
    expect(screen.getByRole('menu').closest('.ws-switcher-pop')).toHaveClass('ws-switcher-pop--up');
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

  it('keeps the /agent door off the rail (D210), still routed behind the palette', async () => {
    await renderShell();
    const nav = screen.getByRole('navigation', { name: 'Hauptnavigation' });
    expect(within(nav).queryByRole('treeitem', { name: 'Agent' })).toBeNull();
  });

  it('toggles the responsive drawer from the hamburger', async () => {
    await renderShell();
    const hamburger = screen.getByRole('button', { name: 'Navigation' });
    expect(hamburger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(hamburger);
    expect(hamburger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    expect(hamburger).toHaveAttribute('aria-expanded', 'false');
  });

  it('traps focus inside the collapse drawer while it is open (spec: a focus-trapped overlay drawer)', async () => {
    await renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Navigation' }));
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

  it('shows the trust state in the rail footer pill: a dot plus its words, never the dot alone', async () => {
    await renderShell();
    const footer = document.querySelector('.rail-footer') as HTMLElement;
    const pill = within(footer).getByRole('button', { name: /^Lokal/ });
    expect(pill.querySelector('.rail-env-dot')).not.toBeNull();
    expect(pill).toHaveTextContent('');
  });

  it('has no axe violations with the drawer open', async () => {
    const { container } = await renderShell();
    await userEvent.click(screen.getByRole('button', { name: 'Navigation' }));
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
