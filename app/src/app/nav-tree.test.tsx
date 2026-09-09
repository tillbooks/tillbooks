/**
 * The tree rail's behaviour (D118 A1): the WAI-ARIA keyboard model, the default-collapsed shape, the
 * deep-link auto-expand and the per-user persistence. Rendered around `NavTree` alone (not the whole
 * Shell), so these assertions are about the tree and nothing else.
 *
 * The keyboard map under test, from the WAI-ARIA APG treeview pattern:
 *   Down/Up  move between visible rows        Home/End jump to first/last visible row
 *   Right    expand, then step to first child Left     collapse, then step out to the parent
 *   Enter/Space activate a leaf or toggle a node
 * with a single Tab stop (roving tabindex) over the whole tree.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { I18nProvider } from '../i18n';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type Transport } from '../lib/client';
import { WorkspaceProvider } from './workspace';
import { NavTree } from './NavTree';

const idle: Transport = async () => ({ status: 200, body: { ok: true, total: 0 } });

/** Echoes the current path so a navigation from the tree is observable. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname}</div>;
}

// A null workspace keeps the async AttentionBadge path dormant (it renders sync with no client call),
// and nav-prefs then keys its overrides under the shared "global" scope, which is all these tests
// need except the cross-workspace leak test, which passes real ids and flushes the badge's fetch.
function renderTree(initialPath = '/overview', workspaceId: string | null = null) {
  return render(
    <I18nProvider>
      <TillClientProvider client={new TillClient(idle)}>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
              <Route
                path="*"
                element={
                  <>
                    <NavTree />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </TillClientProvider>
    </I18nProvider>,
  );
}

const treeitems = () => screen.getAllByRole('treeitem');

/** Focus a treeitem inside act: focusing fires the roving-tabindex onFocus handler (a setState). */
const focusItem = (el: HTMLElement): void => {
  act(() => {
    el.focus();
  });
};

beforeEach(() => {
  window.localStorage.clear();
});

describe('the default-collapsed shape (the rail never scrolls)', () => {
  it('shows only the six daily leaves and the nine group headers on a fresh workspace', () => {
    renderTree('/overview');
    const rows = treeitems();
    // 6 always-visible daily leaves + 9 collapsed group headers = 15 rows, well under a scroll.
    expect(rows).toHaveLength(15);
    expect(rows.length).toBeLessThanOrEqual(18);
  });

  it('keeps exactly one node in the tab order (roving tabindex)', () => {
    renderTree('/overview');
    const inTabOrder = treeitems().filter((el) => el.getAttribute('tabindex') === '0');
    expect(inTabOrder).toHaveLength(1);
  });
});

describe('keyboard navigation (WAI-ARIA treeview)', () => {
  it('moves down and up between visible rows', async () => {
    renderTree('/overview');
    focusItem(treeitems()[0]);
    await userEvent.keyboard('{ArrowDown}');
    expect(treeitems()[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(treeitems()[0]).toHaveFocus();
  });

  it('jumps to the first and last visible row with Home and End', async () => {
    renderTree('/overview');
    focusItem(treeitems()[3]);
    await userEvent.keyboard('{Home}');
    expect(treeitems()[0]).toHaveFocus();
    await userEvent.keyboard('{End}');
    const rows = treeitems();
    expect(rows[rows.length - 1]).toHaveFocus();
  });

  it('expands with Right, steps into the first child, then collapses with Left', async () => {
    renderTree('/overview');
    const stammdaten = screen.getByRole('treeitem', { name: 'Stammdaten' });
    focusItem(stammdaten);

    await userEvent.keyboard('{ArrowRight}'); // expand in place, focus stays
    expect(stammdaten).toHaveAttribute('aria-expanded', 'true');
    expect(stammdaten).toHaveFocus();

    await userEvent.keyboard('{ArrowRight}'); // step to first child
    expect(screen.getByRole('treeitem', { name: 'Konten' })).toHaveFocus();

    await userEvent.keyboard('{ArrowLeft}'); // from a leaf, step out to the parent
    expect(stammdaten).toHaveFocus();

    await userEvent.keyboard('{ArrowLeft}'); // collapse in place
    expect(stammdaten).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('treeitem', { name: 'Konten' })).toBeNull();
  });

  it('toggles a node with Space', async () => {
    renderTree('/overview');
    const berichte = screen.getByRole('treeitem', { name: 'Berichte' });
    focusItem(berichte);
    expect(berichte).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard(' ');
    expect(berichte).toHaveAttribute('aria-expanded', 'true');
  });

  it('activates a leaf with Enter, navigating to its route', async () => {
    renderTree('/overview');
    focusItem(screen.getByRole('treeitem', { name: 'Agent' }));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('loc')).toHaveTextContent('/agent');
  });
});

describe('deep-link auto-expand', () => {
  it('opens the ancestor chain so a deep-linked leaf is visible without a stored preference', () => {
    renderTree('/inventory-alerts');
    expect(screen.getByRole('treeitem', { name: 'Stammdaten' })).toHaveAttribute('aria-expanded', 'true');
    // "Lager" names both the parent and its landing leaf (/inventory); the parent is the one that
    // carries aria-expanded. Both being open is what makes the deep-linked alert row visible.
    const lagerParent = screen.getAllByRole('treeitem', { name: 'Lager' }).find((el) => el.hasAttribute('aria-expanded'));
    expect(lagerParent).toHaveAttribute('aria-expanded', 'true');
    const lager = screen.getByRole('group', { name: 'Lager' });
    expect(within(lager).getByRole('treeitem', { name: 'Bestand & Alarme' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('per-user persistence', () => {
  it('remembers an expanded group across a reload', async () => {
    const { unmount } = renderTree('/overview');
    await userEvent.click(screen.getByRole('treeitem', { name: 'Stammdaten' }));
    expect(screen.getByRole('treeitem', { name: 'Stammdaten' })).toHaveAttribute('aria-expanded', 'true');
    unmount();

    // A fresh mount reads the stored override: still open.
    renderTree('/overview');
    expect(screen.getByRole('treeitem', { name: 'Stammdaten' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('does not leak one workspace expansion into another (keyed per workspace)', async () => {
    const { unmount } = renderTree('/overview', 'ws_a');
    await userEvent.click(screen.getByRole('treeitem', { name: 'Stammdaten' }));
    unmount();

    renderTree('/overview', 'ws_b');
    // A real workspace fires the attention count; let it settle so its setState stays inside act.
    await act(async () => {});
    expect(screen.getByRole('treeitem', { name: 'Stammdaten' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('F-05: leaves are real links, headers are sentence case, the badge is a count or nothing', () => {
  it('renders every leaf as an <a href> that still carries the treeitem semantics', () => {
    renderTree('/overview');
    const leaf = screen.getByRole('treeitem', { name: 'Übersicht' });
    expect(leaf.tagName).toBe('A');
    expect(leaf).toHaveAttribute('href', '/overview');
    expect(leaf).toHaveAttribute('aria-current', 'page');
    expect(leaf).toHaveAttribute('tabindex', '0');
    // A group header stays a heading, never a link: the link count equals the destination count.
    expect(screen.getByRole('treeitem', { name: 'Stammdaten' }).tagName).toBe('DIV');
  });

  it('a plain click routes in place (no full page load), a modifier click is left to the browser', async () => {
    renderTree('/overview');
    const leaf = screen.getByRole('treeitem', { name: 'Aufgaben' });
    await userEvent.click(leaf);
    expect(screen.getByTestId('loc')).toHaveTextContent('/tasks');
    // With a modifier held the handler steps aside: the click keeps its default (the browser's own
    // new-tab behaviour on a real href) and the in-app route does not move.
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, button: 0 });
    // Read the verdict AFTER React's root handler ran (a document listener bubbles later), then
    // cancel the event ourselves so jsdom does not attempt the real navigation it cannot do.
    let leftToBrowser: boolean | null = null;
    const observe = (event: Event): void => {
      leftToBrowser = !event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener('click', observe);
    act(() => {
      screen.getByRole('treeitem', { name: 'Übersicht' }).dispatchEvent(modified);
    });
    document.removeEventListener('click', observe);
    expect(leftToBrowser).toBe(true);
    expect(screen.getByTestId('loc')).toHaveTextContent('/tasks');
  });

  it('the pin star inside a leaf toggles the favourite without navigating', async () => {
    renderTree('/overview');
    const star = screen.getByRole('button', { name: 'Aufgaben zu den Favoriten hinzufügen' });
    await userEvent.click(star);
    expect(screen.getByRole('button', { name: 'Aufgaben aus den Favoriten entfernen' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('loc')).toHaveTextContent('/overview');
  });

  it('renders NO badge on the Pendenzen leaf when the queue is empty (a count or nothing, never a dash)', async () => {
    renderTree('/overview', 'ws_1');
    await act(async () => {});
    const leaf = screen.getByRole('treeitem', { name: 'Pendenzen' });
    expect(within(leaf).queryByRole('img')).toBeNull();
    expect(leaf.textContent).not.toContain('-');
  });
});
