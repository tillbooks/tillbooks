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
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { resetPrefsModuleForTests } from '../lib/prefs';
import { NavTree } from './NavTree';
import { resetNavPrefsForTests } from './nav-prefs';
import { fakePrefsEngine, renderWithRail, type FakePrefsEngine } from './rail-test-kit';

// A null workspace keeps the async AttentionBadge path dormant (it renders sync with no client call)
// and the preference store detached (one shared value per key, never an engine call), which is all
// these tests need except the persistence ones, which pass a real workspace and a fake engine.
function renderTree(initialPath = '/overview', workspaceId: string | null = null, engine?: FakePrefsEngine) {
  return renderWithRail(<NavTree />, { path: initialPath, workspaceId, engine });
}

/** D210: the compact menu hides Lager, Anlagen and Projekte; a test of those rows opens the whole menu. */
async function renderAllAreas(initialPath = '/overview') {
  const engine = fakePrefsEngine();
  engine.put('ws_a', 'nav.menu_scope', 'all');
  const view = renderTree(initialPath, 'ws_a', engine);
  await waitFor(() => expect(header('Projekte')).toBeInTheDocument());
  return view;
}

/** Let the preference store's read (and a write in flight) land inside act. */
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const treeitems = () => screen.getAllByRole('treeitem');

/** Focus a treeitem inside act: focusing fires the roving-tabindex onFocus handler (a setState). */
const focusItem = (el: HTMLElement): void => {
  act(() => {
    el.focus();
  });
};

/** The collapsible HEADER treeitem for a group/parent name. A heading may share its label with the
 *  leaf it lands on (e.g. the "Projekte" group and its /projects leaf; `nav-labels.test.ts` allows only
 *  that), so once expanded a plain getByRole can be ambiguous. The header is the one node with
 *  aria-expanded, and that is what this picks. */
const header = (name: string): HTMLElement => {
  const match = screen.getAllByRole('treeitem', { name }).find((el) => el.hasAttribute('aria-expanded'));
  if (match === undefined) throw new Error(`no expandable header named ${name}`);
  return match;
};

beforeEach(() => {
  window.localStorage.clear();
  resetPrefsModuleForTests();
  resetNavPrefsForTests();
});

describe('the default-collapsed shape (the rail never scrolls)', () => {
  it('shows only the two daily leaves and the five group headers on a fresh workspace', () => {
    renderTree('/overview');
    const rows = treeitems();
    // D210: 2 always-visible daily leaves + 5 collapsed group headers = 7 rows, well under a scroll.
    expect(rows).toHaveLength(7);
    expect(rows.map((el) => el.textContent?.trim())).toEqual(
      expect.arrayContaining(['Übersicht', 'Pendenzen', 'Bank', 'Verkauf', 'Einkauf', 'Buchhaltung', 'Stammdaten']),
    );
    expect(screen.queryByRole('treeitem', { name: 'Projekte' })).toBeNull();
  });

  it('shows Projekte, Lager and Anlagen once the menu scope is all', async () => {
    await renderAllAreas('/overview');
    expect(treeitems()).toHaveLength(8);
    expect(header('Projekte')).toBeInTheDocument();
  });

  it('keeps exactly one node in the tab order (roving tabindex)', () => {
    renderTree('/overview');
    const inTabOrder = treeitems().filter((el) => el.getAttribute('tabindex') === '0');
    expect(inTabOrder).toHaveLength(1);
  });
});

describe('D201: a group opens with a height animation, its rows mounted and inert while closed', () => {
  it('keeps a closed group body mounted, inert and hidden from assistive tech, and opens it in place', async () => {
    renderTree('/overview');
    const stammdaten = header('Stammdaten');
    const body = stammdaten.nextElementSibling as HTMLElement;
    expect(body).toHaveClass('rail-tree-body');
    // Closed: the rows are in the DOM (so the height can animate) but inert and out of the a11y tree.
    expect(body.hasAttribute('data-open')).toBe(false);
    expect(body.hasAttribute('inert')).toBe(true);
    expect(body).toHaveAttribute('aria-hidden', 'true');
    expect(body.querySelector('[data-tree-navid="contacts"]')).not.toBeNull();
    expect(screen.queryByRole('treeitem', { name: 'Kontakte' })).toBeNull();
    expect(stammdaten).not.toHaveAttribute('aria-owns');
    // Open: the same element, now live, owned by its header.
    await userEvent.click(stammdaten.querySelector('.rail-chevron')!);
    expect(body.hasAttribute('data-open')).toBe(true);
    expect(body.hasAttribute('inert')).toBe(false);
    expect(body).not.toHaveAttribute('aria-hidden');
    expect(screen.getByRole('treeitem', { name: 'Kontakte' })).toBeInTheDocument();
    expect(header('Stammdaten')).toHaveAttribute('aria-owns', body.querySelector('[role="group"]')!.id);
  });

  it('never marks a leaf inside a closed group as the current page', () => {
    // /journal lights the Journal leaf and opens Buchhaltung; no other mounted row carries the mark.
    renderTree('/journal');
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
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
    expect(screen.getByRole('treeitem', { name: 'Kontakte' })).toHaveFocus();

    await userEvent.keyboard('{ArrowLeft}'); // from a leaf, step out to the parent
    expect(stammdaten).toHaveFocus();

    await userEvent.keyboard('{ArrowLeft}'); // collapse in place
    expect(stammdaten).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('treeitem', { name: 'Kontakte' })).toBeNull();
  });

  it('toggles a node with Space', async () => {
    renderTree('/overview');
    const buchhaltung = screen.getByRole('treeitem', { name: 'Buchhaltung' });
    focusItem(buchhaltung);
    expect(buchhaltung).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard(' ');
    expect(buchhaltung).toHaveAttribute('aria-expanded', 'true');
  });

  it('activates a leaf with Enter, navigating to its route', async () => {
    renderTree('/overview');
    focusItem(screen.getByRole('treeitem', { name: 'Pendenzen' }));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('loc')).toHaveTextContent('/attention');
  });
});

describe('deep-link auto-expand', () => {
  it('opens the ancestor chain so a deep-linked leaf is visible without a stored preference', async () => {
    await renderAllAreas('/inventory-alerts');
    expect(screen.getByRole('treeitem', { name: 'Stammdaten' })).toHaveAttribute('aria-expanded', 'true');
    // The Lager parent names no leaf since D152 (its landing leaf is "Lagerbestand", the warehouses
    // leaf "Lagerorte"), so it is the one treeitem with that name. Both being open is what makes the
    // deep-linked alert row visible.
    expect(screen.getByRole('treeitem', { name: 'Lager' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('treeitem', { name: 'Lagerbestand' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'Lagerorte' })).toBeInTheDocument();
    const lager = screen.getByRole('group', { name: 'Lager' });
    expect(within(lager).getByRole('treeitem', { name: 'Bestand & Alarme' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('per-user persistence (the nav.expanded preference, per person per workspace)', () => {
  it('remembers an expanded group across a reload', async () => {
    const engine = fakePrefsEngine();
    const { unmount } = renderTree('/overview', 'ws_a', engine);
    await settle();
    await userEvent.click(screen.getByRole('treeitem', { name: 'Stammdaten' }));
    expect(screen.getByRole('treeitem', { name: 'Stammdaten' })).toHaveAttribute('aria-expanded', 'true');
    await settle();
    expect(engine.get('ws_a', 'nav.expanded')).toEqual({ 'master-data': true });
    unmount();

    // A fresh mount reads the stored override from the engine: still open.
    renderTree('/overview', 'ws_a', engine);
    await waitFor(() => expect(screen.getByRole('treeitem', { name: 'Stammdaten' })).toHaveAttribute('aria-expanded', 'true'));
  });

  it('does not leak one workspace expansion into another (keyed per workspace)', async () => {
    const engine = fakePrefsEngine();
    const { unmount } = renderTree('/overview', 'ws_a', engine);
    await settle();
    await userEvent.click(screen.getByRole('treeitem', { name: 'Stammdaten' }));
    await settle();
    unmount();

    renderTree('/overview', 'ws_b', engine);
    await settle();
    expect(screen.getByRole('treeitem', { name: 'Stammdaten' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a toggle the engine refused for the session, so the rail still works', async () => {
    const engine = fakePrefsEngine();
    engine.refuseAll('invalid_pref_value');
    renderTree('/overview', 'ws_a', engine);
    await settle();
    await userEvent.click(screen.getByRole('treeitem', { name: 'Stammdaten' }));
    await settle();
    expect(engine.get('ws_a', 'nav.expanded')).toBeUndefined();
    expect(screen.getByRole('treeitem', { name: 'Stammdaten' })).toHaveAttribute('aria-expanded', 'true');
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
    // A group header stays a <div>, not an <a>: it routes via the router on click (D135) yet adds no
    // anchor, so the rail's anchor count still equals its destination count.
    expect(screen.getByRole('treeitem', { name: 'Stammdaten' }).tagName).toBe('DIV');
  });

  it('a plain click routes in place (no full page load), a modifier click is left to the browser', async () => {
    renderTree('/overview');
    const leaf = screen.getByRole('treeitem', { name: 'Pendenzen' });
    await userEvent.click(leaf);
    expect(screen.getByTestId('loc')).toHaveTextContent('/attention');
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
    expect(screen.getByTestId('loc')).toHaveTextContent('/attention');
  });

  it('the pin star inside a leaf toggles the favourite without navigating', async () => {
    renderTree('/overview');
    const star = screen.getByRole('button', { name: 'Pendenzen zu den Favoriten hinzufügen' });
    await userEvent.click(star);
    expect(screen.getByRole('button', { name: 'Pendenzen aus den Favoriten entfernen' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('loc')).toHaveTextContent('/overview');
  });

  it('renders NO badge on the Pendenzen leaf when the queue is empty (a count or nothing, never a dash)', async () => {
    renderTree('/overview', 'ws_1');
    await settle();
    const leaf = screen.getByRole('treeitem', { name: 'Pendenzen' });
    expect(within(leaf).queryByRole('img')).toBeNull();
    expect(leaf.textContent).not.toContain('-');
  });
});

describe('D201: a header opens its overview page and expands, the chevron only toggles', () => {
  it('opens a group header on its overview page and expands it on a row click, the header lit', async () => {
    renderTree('/overview');
    const stammdaten = header('Stammdaten');
    expect(stammdaten).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(stammdaten);
    // Menu pick A (D201): the header lands on the area overview, not on its first page (D135).
    expect(screen.getByTestId('loc')).toHaveTextContent('/area/master-data');
    expect(header('Stammdaten')).toHaveAttribute('aria-expanded', 'true');
    // The overview has no leaf: the header carries the one mark, and the tab stop.
    expect(header('Stammdaten')).toHaveAttribute('aria-current', 'page');
    expect(document.querySelectorAll('[aria-current]')).toHaveLength(1);
    expect(header('Stammdaten')).toHaveAttribute('tabindex', '0');
  });

  it('folds the group on a second click while its overview is open, without leaving it', async () => {
    renderTree('/overview');
    await userEvent.click(header('Stammdaten'));
    await userEvent.click(header('Stammdaten'));
    expect(header('Stammdaten')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('loc')).toHaveTextContent('/area/master-data');
  });

  it('opens a nested parent on its own overview page', async () => {
    await renderAllAreas('/overview');
    await userEvent.click(header('Stammdaten')); // open the group first
    await userEvent.click(header('Lager'));
    expect(screen.getByTestId('loc')).toHaveTextContent('/area/lager-group');
    expect(header('Lager')).toHaveAttribute('aria-expanded', 'true');
    expect(header('Stammdaten')).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens the group of an overview a deep link lands on', async () => {
    await renderAllAreas('/area/lager-group');
    expect(header('Stammdaten')).toHaveAttribute('aria-expanded', 'true');
    expect(header('Lager')).toHaveAttribute('aria-expanded', 'true');
    expect(header('Lager')).toHaveAttribute('aria-current', 'page');
  });

  it('toggles with the chevron WITHOUT navigating, so a peek never leaves the page', () => {
    renderTree('/overview');
    const chevronOf = (name: string): Element => {
      const el = header(name).querySelector('.rail-chevron');
      if (el === null) throw new Error(`no chevron on ${name}`);
      return el;
    };
    fireEvent.click(chevronOf('Stammdaten'));
    expect(header('Stammdaten')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('loc')).toHaveTextContent('/overview'); // never navigated
    fireEvent.click(chevronOf('Stammdaten')); // and it collapses again, still on /overview
    expect(header('Stammdaten')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('loc')).toHaveTextContent('/overview');
  });

  it('opens the overview and expands on Enter', async () => {
    renderTree('/overview');
    focusItem(header('Buchhaltung'));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('loc')).toHaveTextContent('/area/accounting');
    expect(header('Buchhaltung')).toHaveAttribute('aria-expanded', 'true');
  });

  it('leaves Space a pure toggle: it opens the group but does not navigate', async () => {
    renderTree('/overview');
    focusItem(header('Buchhaltung'));
    await userEvent.keyboard(' ');
    expect(header('Buchhaltung')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('loc')).toHaveTextContent('/overview');
  });
});

describe('a group and the page that shares its navId (Projekte, Einkauf) keep apart', () => {
  it('keeps ONE tab stop and steps from the Projekte header down to the Projekte page', async () => {
    await renderAllAreas('/time');
    const group = header('Projekte');
    expect(group).toHaveAttribute('aria-expanded', 'true');
    // The open page (Zeiterfassung) holds the tab stop; the group and its same-id page do not both.
    expect(treeitems().filter((el) => el.getAttribute('tabindex') === '0')).toHaveLength(1);
    focusItem(group);
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    const page = screen.getAllByRole('treeitem', { name: 'Projekte' }).find((el) => !el.hasAttribute('aria-expanded'))!;
    expect(page).toHaveFocus();
    expect(page).toHaveAttribute('aria-level', '2');
  });
});

describe('D135: the top-level headed groups behave as an accordion (unchanged by D201)', () => {
  it('collapses an open sibling group when another top-level group opens', async () => {
    renderTree('/overview');
    await userEvent.click(header('Stammdaten'));
    expect(header('Stammdaten')).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(header('Buchhaltung'));
    expect(header('Buchhaltung')).toHaveAttribute('aria-expanded', 'true');
    // At most one top-level group open at a time: Stammdaten closed when Buchhaltung opened.
    expect(header('Stammdaten')).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not apply the accordion to nested parents (they keep their independent state)', async () => {
    await renderAllAreas('/overview');
    await userEvent.click(header('Stammdaten')); // open the group
    await userEvent.click(header('Lager'));
    await userEvent.click(header('Anlagen'));
    // Two sibling parents inside one group stay open together: only top-level groups are exclusive.
    expect(header('Lager')).toHaveAttribute('aria-expanded', 'true');
    expect(header('Anlagen')).toHaveAttribute('aria-expanded', 'true');
  });
});
