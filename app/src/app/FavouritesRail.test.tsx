/**
 * The Favoriten lane (D118 A3): pin/unpin, the WCAG 2.5.7 keyboard reorder, the favourites-only
 * alias with the canonical name as tooltip, per-user persistence, and an axe scan in both themes.
 *
 * The lane and the tree are rendered TOGETHER (the pin star lives on tree leaves, the lane above),
 * because the two halves of A3 are one flow: a user pins in the tree and the surface appears in the
 * lane. A null workspace keeps the async AttentionBadge dormant and keys the store under the shared
 * "global" scope, which is all these tests need.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { I18nProvider } from '../i18n';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type Transport } from '../lib/client';
import { ThemeProvider, type Theme } from './theme';
import { WorkspaceProvider } from './workspace';
import { NavTree } from './NavTree';
import { FavouritesRail } from './FavouritesRail';
import {
  NAV_FAVOURITES_KEY_PREFIX,
  readNavFavourites,
  writeNavFavourites,
} from './nav-prefs';

const idle: Transport = async () => ({ status: 200, body: { ok: true, total: 0 } });

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname}</div>;
}

function renderRail(
  initialPath = '/overview',
  { workspaceId = null as string | null, theme = 'light' as Theme } = {},
) {
  return render(
    <ThemeProvider initialTheme={theme}>
      <I18nProvider>
        <TillClientProvider client={new TillClient(idle)}>
          <WorkspaceProvider initialId={workspaceId}>
            <MemoryRouter initialEntries={[initialPath]}>
              <Routes>
                <Route
                  path="*"
                  element={
                    <>
                      <FavouritesRail />
                      <NavTree />
                      <LocationProbe />
                    </>
                  }
                />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </TillClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

/** The Favoriten section, once it exists (it renders nothing while empty). */
const lane = () => screen.getByRole('region', { name: 'Favoriten' });

beforeEach(() => {
  window.localStorage.clear();
});

describe('the lane appears only when non-empty', () => {
  it('renders nothing with no favourites', () => {
    renderRail('/overview');
    expect(screen.queryByRole('region', { name: 'Favoriten' })).toBeNull();
  });

  it('appears once a leaf is pinned from the tree', async () => {
    renderRail('/overview');
    // Übersicht is an always-visible daily leaf; pin it via its star.
    await userEvent.click(screen.getByRole('button', { name: 'Übersicht zu den Favoriten hinzufügen' }));
    expect(lane()).toBeInTheDocument();
    expect(within(lane()).getByRole('link', { name: 'Übersicht' })).toBeInTheDocument();
  });
});

describe('pin and unpin', () => {
  it('pins from the tree and persists the pin', async () => {
    renderRail('/overview');
    await userEvent.click(screen.getByRole('button', { name: 'Aufgaben zu den Favoriten hinzufügen' }));
    expect(readNavFavourites(null).map((f) => f.navId)).toEqual(['tasks']);
  });

  it('unpins from the lane, removing the row and clearing the store', async () => {
    writeNavFavourites(null, [{ navId: 'tasks' }]);
    renderRail('/overview');
    expect(within(lane()).getByRole('link', { name: 'Aufgaben' })).toBeInTheDocument();
    await userEvent.click(within(lane()).getByRole('button', { name: 'Aufgaben aus den Favoriten entfernen' }));
    expect(screen.queryByRole('region', { name: 'Favoriten' })).toBeNull();
    expect(readNavFavourites(null)).toEqual([]);
  });

  it('reflects the pinned state on the tree star (aria-pressed)', async () => {
    renderRail('/overview');
    const tree = screen.getByRole('tree');
    const star = within(tree).getByRole('button', { name: 'Agent zu den Favoriten hinzufügen' });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(star);
    // The same tree star now offers to unpin (once pinned, the lane also shows an unpin button, so
    // scope this assertion to the tree).
    expect(within(tree).getByRole('button', { name: 'Agent aus den Favoriten entfernen' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('the WCAG 2.5.7 keyboard reorder (move up / move down)', () => {
  beforeEach(() => {
    writeNavFavourites(null, [{ navId: 'overview' }, { navId: 'tasks' }, { navId: 'agent' }]);
  });

  it('offers a move-up and a move-down button on each favourite', () => {
    renderRail('/overview');
    // Three rows, each with move up + move down (plus rename + unpin).
    expect(within(lane()).getAllByRole('button', { name: /nach oben verschieben/ })).toHaveLength(3);
    expect(within(lane()).getAllByRole('button', { name: /nach unten verschieben/ })).toHaveLength(3);
  });

  it('disables move-up on the first row and move-down on the last (the ends are fixed)', () => {
    renderRail('/overview');
    const rows = within(lane()).getAllByRole('listitem');
    expect(within(rows[0]).getByRole('button', { name: /nach oben verschieben/ })).toBeDisabled();
    expect(within(rows[2]).getByRole('button', { name: /nach unten verschieben/ })).toBeDisabled();
  });

  it('moves a favourite down with the keyboard and persists the new order', async () => {
    renderRail('/overview');
    const before = within(lane()).getAllByRole('listitem').map((li) => within(li).getByRole('link').textContent);
    expect(before).toEqual(['Übersicht', 'Aufgaben', 'Agent']);

    // Focus the first row's move-down button and activate it with the keyboard (Enter).
    const moveDown = within(lane()).getByRole('button', { name: 'Übersicht nach unten verschieben' });
    moveDown.focus();
    await userEvent.keyboard('{Enter}');

    const after = within(lane()).getAllByRole('listitem').map((li) => within(li).getByRole('link').textContent);
    expect(after).toEqual(['Aufgaben', 'Übersicht', 'Agent']);
    // Persisted, so it survives a reload.
    expect(readNavFavourites(null).map((f) => f.navId)).toEqual(['tasks', 'overview', 'agent']);
  });

  it('moves a favourite up with the keyboard', async () => {
    renderRail('/overview');
    const moveUp = within(lane()).getByRole('button', { name: 'Agent nach oben verschieben' });
    moveUp.focus();
    await userEvent.keyboard(' ');
    const after = within(lane()).getAllByRole('listitem').map((li) => within(li).getByRole('link').textContent);
    expect(after).toEqual(['Übersicht', 'Agent', 'Aufgaben']);
  });
});

describe('the favourites-only alias (canonical name survives as tooltip)', () => {
  beforeEach(() => {
    writeNavFavourites(null, [{ navId: 'overview' }]);
  });

  it('renames a favourite in place and keeps the canonical name as the title tooltip', async () => {
    renderRail('/overview');
    await userEvent.click(within(lane()).getByRole('button', { name: 'Übersicht umbenennen' }));
    const field = within(lane()).getByRole('textbox');
    await userEvent.clear(field);
    await userEvent.type(field, 'Mein Start');
    await userEvent.keyboard('{Enter}');

    const link = within(lane()).getByRole('link', { name: 'Mein Start' });
    expect(link).toBeInTheDocument();
    // The canonical name survives as the tooltip.
    expect(link).toHaveAttribute('title', 'Übersicht');
    // Persisted as an alias on the pin.
    expect(readNavFavourites(null)).toEqual([{ navId: 'overview', alias: 'Mein Start' }]);
  });

  it('does NOT rename the canonical tree row (aliases are favourites-only)', async () => {
    renderRail('/overview');
    await userEvent.click(within(lane()).getByRole('button', { name: 'Übersicht umbenennen' }));
    const field = within(lane()).getByRole('textbox');
    await userEvent.clear(field);
    await userEvent.type(field, 'Mein Start');
    await userEvent.keyboard('{Enter}');

    // The tree still shows the canonical label: the shared vocabulary is untouched.
    const tree = screen.getByRole('tree');
    expect(within(tree).getByRole('treeitem', { name: 'Übersicht' })).toBeInTheDocument();
    expect(within(tree).queryByRole('treeitem', { name: 'Mein Start' })).toBeNull();
  });

  it('cancels a rename on Escape, leaving the canonical label', async () => {
    renderRail('/overview');
    await userEvent.click(within(lane()).getByRole('button', { name: 'Übersicht umbenennen' }));
    const field = within(lane()).getByRole('textbox');
    await userEvent.clear(field);
    await userEvent.type(field, 'Verworfen');
    await userEvent.keyboard('{Escape}');
    expect(within(lane()).getByRole('link', { name: 'Übersicht' })).toBeInTheDocument();
    expect(readNavFavourites(null)).toEqual([{ navId: 'overview' }]);
  });

  it('clears the alias when the field is emptied', async () => {
    writeNavFavourites(null, [{ navId: 'overview', alias: 'Mein Start' }]);
    renderRail('/overview');
    expect(within(lane()).getByRole('link', { name: 'Mein Start' })).toBeInTheDocument();
    await userEvent.click(within(lane()).getByRole('button', { name: 'Übersicht umbenennen' }));
    const field = within(lane()).getByRole('textbox');
    await userEvent.clear(field);
    await userEvent.keyboard('{Enter}');
    expect(within(lane()).getByRole('link', { name: 'Übersicht' })).toBeInTheDocument();
    expect(readNavFavourites(null)).toEqual([{ navId: 'overview' }]);
  });
});

describe('navigation and active state', () => {
  it('routes to the surface when a favourite is clicked', async () => {
    writeNavFavourites(null, [{ navId: 'agent' }]);
    renderRail('/overview');
    await userEvent.click(within(lane()).getByRole('link', { name: 'Agent' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/agent');
  });

  it('marks the active favourite with aria-current', () => {
    writeNavFavourites(null, [{ navId: 'agent' }]);
    renderRail('/agent');
    expect(within(lane()).getByRole('link', { name: 'Agent' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('per-user persistence across workspaces', () => {
  it('keys favourites per workspace (no leak between books)', async () => {
    writeNavFavourites('ws_a', [{ navId: 'agent' }]);
    const { unmount } = renderRail('/overview', { workspaceId: 'ws_a' });
    expect(within(lane()).getByRole('link', { name: 'Agent' })).toBeInTheDocument();
    // A real workspace fires the attention count; let it settle so its setState stays inside act.
    await act(async () => {});
    unmount();

    renderRail('/overview', { workspaceId: 'ws_b' });
    await act(async () => {});
    expect(screen.queryByRole('region', { name: 'Favoriten' })).toBeNull();
  });

  it('files a pin under the per-workspace localStorage key', async () => {
    renderRail('/overview', { workspaceId: 'ws_c' });
    await act(async () => {});
    await userEvent.click(screen.getByRole('button', { name: 'Agent zu den Favoriten hinzufügen' }));
    expect(window.localStorage.getItem(`${NAV_FAVOURITES_KEY_PREFIX}ws_c`)).toContain('agent');
  });
});

describe('accessibility (jest-axe, both themes)', () => {
  beforeEach(() => {
    writeNavFavourites(null, [{ navId: 'overview' }, { navId: 'tasks' }, { navId: 'agent' }]);
  });

  it('has no axe violations in the light theme', async () => {
    const { container } = renderRail('/overview', { theme: 'light' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the dark theme', async () => {
    const { container } = renderRail('/overview', { theme: 'dark' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('names the region and lists the favourites as list items', () => {
    renderRail('/overview');
    expect(lane()).toBeInTheDocument();
    expect(within(lane()).getAllByRole('listitem')).toHaveLength(3);
  });
});
