/**
 * The Favoriten section (D118 A3, rebuilt by D178): pin and unpin, the WCAG 2.5.7 keyboard reorder, the
 * favourites-only alias, the ONE active row per `nav.active_rule`, the three favourite styles, the
 * folding sections, a refused write, the one-time import of the D118 browser keys, and an axe scan in
 * both themes.
 *
 * The section and the Menü are rendered TOGETHER (the pin star lives on the menu's leaves, the lane
 * above), under the real rail model and the real preference store, against a fake engine that keeps
 * one value per person per workspace (`rail-test-kit.tsx`). So "persisted" here means "the engine holds
 * it", the way it does in the Studio. SYNTHETIC BY CONSTRUCTION.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { resetPrefsModuleForTests, type PrefValue } from '../lib/prefs';
import type { Theme } from './theme';
import { FavouritesRail } from './FavouritesRail';
import { MenuSection } from './NavTree';
import {
  NAV_EXPANDED_KEY_PREFIX,
  NAV_FAVOURITES_KEY_PREFIX,
  NAV_RAIL_KEY_PREFIX,
  readNavFavourites,
  resetNavPrefsForTests,
} from './nav-prefs';
import { fakePrefsEngine, renderWithRail, type FakePrefsEngine } from './rail-test-kit';

const WS = 'ws_a';

/** The rail's middle band, as the Shell mounts it, inside the navigation landmark. */
const RAIL = (
  <nav aria-label="Hauptnavigation">
    <FavouritesRail />
    <MenuSection />
  </nav>
);

/** Let the preference store's read and any write in flight land inside act. */
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

function engineWith(prefs: Record<string, unknown> = {}): FakePrefsEngine {
  const engine = fakePrefsEngine();
  for (const [key, value] of Object.entries(prefs)) engine.put(WS, key, value as PrefValue);
  return engine;
}

async function renderRail(
  path = '/overview',
  { engine = engineWith(), workspaceId = WS, theme = 'light' as Theme }: { engine?: FakePrefsEngine; workspaceId?: string; theme?: Theme } = {},
) {
  const view = renderWithRail(RAIL, { path, engine, workspaceId, theme });
  await settle();
  return view;
}

/** The Favoriten section, once it exists (it renders nothing while empty). */
const lane = () => screen.getByRole('region', { name: 'Favoriten' });
const tree = () => screen.getByRole('tree');
/** Open a favourite's Mehr menu (named after what it shows) and pick Umbenennen. */
async function rename(shown: string) {
  await userEvent.click(within(lane()).getByRole('button', { name: `${shown}: verschieben, umbenennen oder entfernen` }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Umbenennen' }));
}

const laneTitles = () => within(lane()).getAllByRole('listitem').map((li) => within(li).getByRole('link').textContent);

beforeEach(() => {
  window.localStorage.clear();
  resetPrefsModuleForTests();
  resetNavPrefsForTests();
});

describe('the section appears only when non-empty', () => {
  it('renders nothing with no favourites, and the menu stands alone without its header (judge M3)', async () => {
    await renderRail();
    expect(screen.queryByRole('region', { name: 'Favoriten' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Menü' })).toBeNull();
    expect(tree()).toBeInTheDocument();
  });

  it('a Menü folded before the last pin went is shown unfolded: without a header it could not be opened', async () => {
    await renderRail('/overview', { engine: engineWith({ 'nav.sections': { menu: true } }) });
    expect(tree()).toBeInTheDocument();
  });

  it('appears once a leaf is pinned from the tree, the Menü header with it, and the engine holds the pin', async () => {
    const { engine } = await renderRail();
    await userEvent.click(screen.getByRole('button', { name: 'Übersicht zu den Favoriten hinzufügen' }));
    expect(within(lane()).getByRole('link', { name: 'Übersicht' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Menü' })).toHaveAttribute('aria-expanded', 'true');
    await settle();
    expect(engine.get(WS, 'nav.favourites')).toEqual([{ navId: 'overview' }]);
    // The palette reads the same pins synchronously.
    expect(readNavFavourites(WS).map((f) => f.navId)).toEqual(['overview']);
  });
});

describe('pin and unpin', () => {
  it('unpins from the lane, removing the row and clearing the pin', async () => {
    const { engine } = await renderRail('/overview', { engine: engineWith({ 'nav.favourites': [{ navId: 'tasks' }] }) });
    await userEvent.click(within(lane()).getByRole('button', { name: 'Aufgaben aus den Favoriten entfernen' }));
    expect(screen.queryByRole('region', { name: 'Favoriten' })).toBeNull();
    await settle();
    expect(engine.get(WS, 'nav.favourites')).toEqual([]);
  });

  it('reflects the pinned state on the tree star (aria-pressed)', async () => {
    await renderRail();
    const star = within(tree()).getByRole('button', { name: 'Agent zu den Favoriten hinzufügen' });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(star);
    expect(within(tree()).getByRole('button', { name: 'Agent aus den Favoriten entfernen' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('drops a pin whose surface this build does not know (validated on every read)', async () => {
    await renderRail('/overview', { engine: engineWith({ 'nav.favourites': [{ navId: 'gone-surface' }, { navId: 'agent' }] }) });
    expect(laneTitles()).toEqual(['Agent']);
  });
});

describe('the WCAG 2.5.7 reorder: Nach oben / Nach unten under Mehr, and Alt+Arrow', () => {
  const three = () => engineWith({ 'nav.favourites': [{ navId: 'overview' }, { navId: 'tasks' }, { navId: 'agent' }] });
  const more = (name: string) => within(lane()).getByRole('button', { name: `${name}: verschieben, umbenennen oder entfernen` });

  it('offers a Mehr menu on each favourite, its ends disabled, and only the unpin star as a glyph button', async () => {
    await renderRail('/overview', { engine: three() });
    for (const name of ['Übersicht', 'Aufgaben', 'Agent']) expect(more(name)).toBeInTheDocument();
    await userEvent.click(more('Übersicht'));
    expect(screen.getByRole('menuitem', { name: 'Nach oben' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: 'Nach unten' })).not.toHaveAttribute('aria-disabled');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(more('Agent'));
    expect(screen.getByRole('menuitem', { name: 'Nach unten' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    const row = within(lane()).getAllByRole('listitem')[0]!;
    const glyphButtons = within(row).getAllByRole('button').filter((b) => (b.textContent ?? '').trim() === '');
    expect(glyphButtons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Übersicht: verschieben, umbenennen oder entfernen',
      'Übersicht aus den Favoriten entfernen',
    ]);
  });

  it('moves a favourite down by keyboard through Mehr, and the engine keeps the new order', async () => {
    const { engine } = await renderRail('/overview', { engine: three() });
    expect(laneTitles()).toEqual(['Übersicht', 'Aufgaben', 'Agent']);
    act(() => more('Übersicht').focus());
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Nach unten' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(laneTitles()).toEqual(['Aufgaben', 'Übersicht', 'Agent']);
    await settle();
    expect(engine.get(WS, 'nav.favourites')).toEqual([{ navId: 'tasks' }, { navId: 'overview' }, { navId: 'agent' }]);
  });

  it('moves the focused favourite up with Alt+ArrowUp', async () => {
    await renderRail('/overview', { engine: three() });
    act(() => within(lane()).getByRole('link', { name: 'Agent' }).focus());
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(laneTitles()).toEqual(['Übersicht', 'Agent', 'Aufgaben']);
  });
});

describe('the favourites-only alias (the canonical name survives as the tooltip)', () => {
  it('renames in place, keeps the canonical name as the title, and leaves the menu row alone', async () => {
    const { engine } = await renderRail('/overview', { engine: engineWith({ 'nav.favourites': [{ navId: 'overview' }] }) });
    await rename('Übersicht');
    const field = within(lane()).getByRole('textbox');
    await userEvent.clear(field);
    await userEvent.type(field, 'Mein Start');
    await userEvent.keyboard('{Enter}');
    const link = within(lane()).getByRole('link', { name: 'Mein Start' });
    expect(link).toHaveAttribute('title', 'Übersicht');
    expect(within(tree()).getByRole('treeitem', { name: 'Übersicht' })).toBeInTheDocument();
    expect(within(tree()).queryByRole('treeitem', { name: 'Mein Start' })).toBeNull();
    await settle();
    expect(engine.get(WS, 'nav.favourites')).toEqual([{ navId: 'overview', alias: 'Mein Start' }]);
  });

  it('cancels on Escape, and an emptied field clears the alias', async () => {
    const { engine } = await renderRail('/overview', {
      engine: engineWith({ 'nav.favourites': [{ navId: 'overview', alias: 'Mein Start' }] }),
    });
    await rename('Mein Start');
    await userEvent.type(within(lane()).getByRole('textbox'), 'x');
    await userEvent.keyboard('{Escape}');
    expect(within(lane()).getByRole('link', { name: 'Mein Start' })).toBeInTheDocument();
    await rename('Mein Start');
    await userEvent.clear(within(lane()).getByRole('textbox'));
    await userEvent.keyboard('{Enter}');
    expect(within(lane()).getByRole('link', { name: 'Übersicht' })).toBeInTheDocument();
    await settle();
    expect(engine.get(WS, 'nav.favourites')).toEqual([{ navId: 'overview' }]);
  });
});

describe('ONE active row per nav.active_rule (D178 point 16)', () => {
  const pinnedJournal = (rule?: string, extra: Record<string, unknown> = {}) =>
    engineWith({ 'nav.favourites': [{ navId: 'journal' }, { navId: 'agent' }], ...(rule === undefined ? {} : { 'nav.active_rule': rule }), ...extra });
  const current = (container: HTMLElement) => container.querySelectorAll('[aria-current="page"]');
  const accounting = () => within(tree()).getAllByRole('treeitem', { name: 'Buchhaltung' }).find((el) => el.hasAttribute('aria-expanded'))!;

  it('favourite (default): only the favourite lights, and the menu does not open to the page', async () => {
    const { container } = await renderRail('/journal', { engine: pinnedJournal() });
    expect(current(container)).toHaveLength(1);
    expect(within(lane()).getByRole('link', { name: 'Journal' })).toHaveAttribute('aria-current', 'page');
    expect(accounting()).toHaveAttribute('aria-expanded', 'false');
  });

  it('tree: only the menu row lights, and the menu opens to it', async () => {
    const { container } = await renderRail('/journal', { engine: pinnedJournal('tree') });
    expect(current(container)).toHaveLength(1);
    expect(within(tree()).getByRole('treeitem', { name: 'Journal' })).toHaveAttribute('aria-current', 'page');
    expect(within(lane()).getByRole('link', { name: 'Journal' })).not.toHaveAttribute('aria-current');
    expect(accounting()).toHaveAttribute('aria-expanded', 'true');
  });

  it('both_soft: the favourite carries the pill, the menu row only accent ink, still ONE aria-current', async () => {
    const { container } = await renderRail('/journal', { engine: pinnedJournal('both_soft') });
    expect(current(container)).toHaveLength(1);
    expect(within(lane()).getByRole('link', { name: 'Journal' })).toHaveAttribute('aria-current', 'page');
    const menuRow = within(tree()).getByRole('treeitem', { name: 'Journal' });
    expect(menuRow).not.toHaveAttribute('aria-current');
    expect(menuRow).toHaveAttribute('data-soft-current');
  });

  it('an unpinned page lights its menu row under every rule', async () => {
    for (const rule of ['favourite', 'tree', 'both_soft']) {
      const { container, unmount } = await renderRail('/periods', { engine: pinnedJournal(rule) });
      expect(current(container)).toHaveLength(1);
      expect(within(tree()).getByRole('treeitem', { name: 'Perioden' })).toHaveAttribute('aria-current', 'page');
      unmount();
    }
  });

  it('falls back to the menu row when the Favoriten section is folded', async () => {
    const { container } = await renderRail('/journal', { engine: pinnedJournal(undefined, { 'nav.sections': { favourites: true } }) });
    expect(current(container)).toHaveLength(1);
    expect(within(tree()).getByRole('treeitem', { name: 'Journal' })).toHaveAttribute('aria-current', 'page');
  });

  it('falls back to the favourite when the page is hidden in the menu (a pinned, hidden page)', async () => {
    const { container } = await renderRail('/journal', {
      engine: pinnedJournal('tree', { 'nav.menu_layout': { hidden: ['journal'] } }),
    });
    expect(current(container)).toHaveLength(1);
    expect(within(lane()).getByRole('link', { name: 'Journal' })).toHaveAttribute('aria-current', 'page');
    expect(within(tree()).queryByRole('treeitem', { name: 'Journal' })).toBeNull();
  });

  it('lights nothing for a hidden, unpinned page opened by a link (it has no row)', async () => {
    const { container } = await renderRail('/periods', { engine: engineWith({ 'nav.menu_layout': { hidden: ['periods'] } }) });
    expect(current(container)).toHaveLength(0);
  });
});

describe('the three favourite styles (D178 point 15)', () => {
  const styled = (style?: string) =>
    engineWith({ 'nav.favourites': [{ navId: 'journal' }], ...(style === undefined ? {} : { 'nav.favourite_style': style }) });
  const row = () => within(lane()).getByRole('listitem');

  it('icon_star (default): the page icon in the slot and a filled star at the right edge', async () => {
    await renderRail('/overview', { engine: styled() });
    const link = within(row()).getByRole('link');
    expect(link.querySelector('svg.rail-icon')).not.toBeNull();
    expect(link.querySelector('.rail-fav-slot-star')).toBeNull();
    expect(link.querySelector('.rail-fav-star')).not.toBeNull();
  });

  it('star_only: the star takes the icon slot and there is no trailing star', async () => {
    await renderRail('/overview', { engine: styled('star_only') });
    const link = within(row()).getByRole('link');
    expect(link.querySelector('.rail-fav-slot-star')).not.toBeNull();
    expect(link.querySelector('.rail-fav-star')).toBeNull();
  });

  it('icon_only: the icon alone, the unpin star only among the hover controls', async () => {
    await renderRail('/overview', { engine: styled('icon_only') });
    const link = within(row()).getByRole('link');
    expect(link.querySelector('.rail-fav-star, .rail-fav-slot-star')).toBeNull();
    expect(within(row()).getByRole('button', { name: 'Journal aus den Favoriten entfernen' })).toBeInTheDocument();
  });

  it('reserves no grip column: the grip overlays the slot and is hidden from assistive tech', async () => {
    await renderRail('/overview', { engine: styled() });
    const grip = row().querySelector('.rail-fav-grip');
    expect(grip).not.toBeNull();
    expect(grip).toHaveAttribute('aria-hidden', 'true');
    expect(grip?.getAttribute('tabindex')).toBeNull();
    // The link is the row's first child: nothing sits before it in the flow.
    expect(row().firstElementChild).toHaveClass('rail-fav-link');
  });
});

describe('the header styles (D178 point 17)', () => {
  const header = (name: string) => within(tree()).getAllByRole('treeitem', { name }).find((el) => el.hasAttribute('aria-expanded'))!;

  it('text_14_bold (default) and label_12: a group header carries no icon', async () => {
    for (const style of [undefined, 'label_12']) {
      const { unmount } = await renderRail('/overview', {
        engine: engineWith({ 'nav.favourites': [{ navId: 'agent' }], ...(style === undefined ? {} : { 'nav.group_header_style': style }) }),
      });
      expect(header('Stammdaten').querySelector('.rail-icon')).toBeNull();
      expect(screen.getByRole('button', { name: 'Favoriten' }).querySelector('.rail-icon')).toBeNull();
      unmount();
    }
  });

  it('icon_14: every group header carries a group icon; a section header keeps its chevron in the icon column', async () => {
    await renderRail('/overview', {
      engine: engineWith({ 'nav.favourites': [{ navId: 'agent' }], 'nav.group_header_style': 'icon_14' }),
    });
    expect(header('Stammdaten').querySelector('.rail-icon')).not.toBeNull();
    for (const name of ['Favoriten', 'Menü']) {
      const toggle = screen.getByRole('button', { name });
      expect(toggle.querySelector('.rail-icon')).toBeNull();
      expect(toggle.firstElementChild).toHaveClass('rail-section-chevron');
    }
  });

  it('a section header is a step quieter than a group: its own label class, never the group header type (judge M1)', async () => {
    await renderRail('/overview', { engine: engineWith({ 'nav.favourites': [{ navId: 'agent' }] }) });
    for (const name of ['Favoriten', 'Menü']) {
      const toggle = screen.getByRole('button', { name });
      expect(toggle.querySelector('.rail-section-label')).not.toBeNull();
      expect(toggle.querySelector('.rail-header-label')).toBeNull();
      expect(toggle).not.toHaveClass('rail-header-row');
    }
  });
});

describe('EXACTLY ONE aria-current, whatever is folded (judge M4) and one open group (judge L6)', () => {
  const pinnedJournal = (extra: Record<string, unknown> = {}) =>
    engineWith({ 'nav.favourites': [{ navId: 'journal' }, { navId: 'agent' }], ...extra });
  const marks = (container: HTMLElement) => [...container.querySelectorAll('[aria-current]')];
  const groupRow = (name: string) => within(tree()).getAllByRole('treeitem', { name }).find((el) => el.hasAttribute('aria-expanded'))!;

  it('both sections folded: the header of the section that would light carries aria-current="location"', async () => {
    for (const [rule, holder] of [['favourite', 'Favoriten'], ['tree', 'Menü']] as const) {
      const { container, unmount } = await renderRail('/journal', {
        engine: pinnedJournal({ 'nav.active_rule': rule, 'nav.sections': { favourites: true, menu: true } }),
      });
      expect(marks(container)).toHaveLength(1);
      expect(screen.getByRole('button', { name: holder })).toHaveAttribute('aria-current', 'location');
      unmount();
    }
  });

  it('a group the person closed over the lit row carries aria-current="location" instead', async () => {
    const { container } = await renderRail('/journal', {
      engine: pinnedJournal({ 'nav.active_rule': 'tree', 'nav.expanded': { accounting: false } }),
    });
    expect(marks(container)).toHaveLength(1);
    expect(groupRow('Buchhaltung')).toHaveAttribute('aria-expanded', 'false');
    expect(groupRow('Buchhaltung')).toHaveAttribute('aria-current', 'location');
  });

  it('the lit row\'s group opens and a group opened by hand closes: one open group under the tree rule', async () => {
    const { container } = await renderRail('/journal', {
      engine: pinnedJournal({ 'nav.active_rule': 'tree', 'nav.expanded': { sales: true } }),
    });
    expect(groupRow('Buchhaltung')).toHaveAttribute('aria-expanded', 'true');
    expect(groupRow('Verkauf')).toHaveAttribute('aria-expanded', 'false');
    // Opening Verkauf by its chevron closes Buchhaltung, whose header then stands in for the page.
    const chevron = groupRow('Verkauf').querySelector('.rail-chevron')!;
    await userEvent.click(chevron);
    expect(groupRow('Verkauf')).toHaveAttribute('aria-expanded', 'true');
    expect(groupRow('Buchhaltung')).toHaveAttribute('aria-expanded', 'false');
    expect(marks(container)).toHaveLength(1);
    expect(groupRow('Buchhaltung')).toHaveAttribute('aria-current', 'location');
  });

  it('every rule, Favoriten folded: the tree row lights and its group opens', async () => {
    for (const rule of ['favourite', 'tree', 'both_soft']) {
      const { container, unmount } = await renderRail('/journal', {
        engine: pinnedJournal({ 'nav.active_rule': rule, 'nav.sections': { favourites: true }, 'nav.expanded': { sales: true } }),
      });
      expect(marks(container)).toHaveLength(1);
      expect(within(tree()).getByRole('treeitem', { name: 'Journal' })).toHaveAttribute('aria-current', 'page');
      expect(groupRow('Verkauf')).toHaveAttribute('aria-expanded', 'false');
      unmount();
    }
  });
});

describe('Entfernen under Mehr (judge H2)', () => {
  it('unpins from the Mehr menu, the path while the unpin star steps out in Menü anpassen', async () => {
    const { engine } = await renderRail('/overview', { engine: engineWith({ 'nav.favourites': [{ navId: 'tasks' }, { navId: 'agent' }] }) });
    await userEvent.click(within(lane()).getByRole('button', { name: 'Aufgaben: verschieben, umbenennen oder entfernen' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Entfernen' }));
    expect(laneTitles()).toEqual(['Agent']);
    await settle();
    expect(engine.get(WS, 'nav.favourites')).toEqual([{ navId: 'agent' }]);
  });
});

describe('the folding sections persist (nav.sections)', () => {
  it('folds Favoriten and Menü, and both stay folded after a reload', async () => {
    const engine = engineWith({ 'nav.favourites': [{ navId: 'agent' }] });
    const { unmount } = await renderRail('/overview', { engine });
    await userEvent.click(screen.getByRole('button', { name: 'Favoriten' }));
    await userEvent.click(screen.getByRole('button', { name: 'Menü' }));
    expect(screen.getByRole('button', { name: 'Favoriten' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(lane()).queryByRole('list')).toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();
    await settle();
    expect(engine.get(WS, 'nav.sections')).toEqual({ favourites: true, menu: true });
    unmount();

    await renderRail('/overview', { engine });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Menü' })).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.getByRole('button', { name: 'Favoriten' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('unfolding both returns to the default (nothing stored that differs from it)', async () => {
    const engine = engineWith({ 'nav.favourites': [{ navId: 'agent' }], 'nav.sections': { menu: true } });
    await renderRail('/overview', { engine });
    await userEvent.click(screen.getByRole('button', { name: 'Menü' }));
    await settle();
    expect(engine.get(WS, 'nav.sections')).toEqual({});
  });
});

describe('a refused write never breaks the rail (storage refused)', () => {
  it('keeps the pin for the session and says once that it could not be saved', async () => {
    const engine = engineWith();
    engine.refuseAll('invalid_pref_value');
    await renderRail('/overview', { engine });
    await userEvent.click(screen.getByRole('button', { name: 'Agent zu den Favoriten hinzufügen' }));
    await settle();
    expect(engine.get(WS, 'nav.favourites')).toBeUndefined();
    expect(within(lane()).getByRole('link', { name: 'Agent' })).toBeInTheDocument();
    const note = within(lane()).getByText(/Deine Favoriten konnten nicht gespeichert werden/);
    expect(note).toHaveAttribute('role', 'status');
  });
});

describe('per person per workspace (a workspace switch)', () => {
  it('keys favourites per workspace (no leak between books)', async () => {
    const engine = engineWith({ 'nav.favourites': [{ navId: 'agent' }] });
    const { unmount } = await renderRail('/overview', { engine });
    expect(within(lane()).getByRole('link', { name: 'Agent' })).toBeInTheDocument();
    unmount();
    await renderRail('/overview', { engine, workspaceId: 'ws_b' });
    expect(screen.queryByRole('region', { name: 'Favoriten' })).toBeNull();
  });
});

describe('the one-time import of the D118 browser keys (US-G16.14)', () => {
  it('moves the pins, the open groups and the rail width into the engine once, then clears them', async () => {
    window.localStorage.setItem(`${NAV_FAVOURITES_KEY_PREFIX}${WS}`, JSON.stringify([{ navId: 'agent', alias: 'KI' }]));
    window.localStorage.setItem(`${NAV_EXPANDED_KEY_PREFIX}${WS}`, JSON.stringify({ sales: true }));
    window.localStorage.setItem(`${NAV_RAIL_KEY_PREFIX}${WS}`, JSON.stringify({ width: 320, collapsed: false }));
    const engine = engineWith();
    await renderRail('/overview', { engine });
    await waitFor(() => expect(engine.get(WS, 'nav.favourites')).toEqual([{ navId: 'agent', alias: 'KI' }]));
    await waitFor(() => expect(engine.get(WS, 'nav.rail')).toEqual({ width: 320, collapsed: false }));
    expect(engine.get(WS, 'nav.expanded')).toEqual({ sales: true });
    expect(window.localStorage.getItem(`${NAV_FAVOURITES_KEY_PREFIX}${WS}`)).toBeNull();
    expect(window.localStorage.getItem(`${NAV_EXPANDED_KEY_PREFIX}${WS}`)).toBeNull();
    expect(window.localStorage.getItem(`${NAV_RAIL_KEY_PREFIX}${WS}`)).toBeNull();
    expect(await within(lane()).findByRole('link', { name: 'KI' })).toBeInTheDocument();
  });

  it('keeps the engine value when the person already has one, and discards a value that does not parse', async () => {
    window.localStorage.setItem(`${NAV_FAVOURITES_KEY_PREFIX}${WS}`, JSON.stringify([{ navId: 'tasks' }]));
    window.localStorage.setItem(`${NAV_EXPANDED_KEY_PREFIX}${WS}`, 'not json');
    const engine = engineWith({ 'nav.favourites': [{ navId: 'agent' }] });
    await renderRail('/overview', { engine });
    await waitFor(() => expect(window.localStorage.getItem(`${NAV_FAVOURITES_KEY_PREFIX}${WS}`)).toBeNull());
    expect(engine.get(WS, 'nav.favourites')).toEqual([{ navId: 'agent' }]);
    expect(window.localStorage.getItem(`${NAV_EXPANDED_KEY_PREFIX}${WS}`)).toBeNull();
    expect(engine.get(WS, 'nav.expanded')).toBeUndefined();
  });
});

describe('accessibility (jest-axe, both themes)', () => {
  const seeded = () => engineWith({ 'nav.favourites': [{ navId: 'overview' }, { navId: 'tasks' }, { navId: 'agent' }] });

  it('has no axe violations in the light theme, with a favourite lit', async () => {
    const { container } = await renderRail('/tasks', { engine: seeded(), theme: 'light' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the dark theme, under the icon_14 header style', async () => {
    const engine = seeded();
    engine.put(WS, 'nav.group_header_style', 'icon_14');
    const { container } = await renderRail('/overview', { engine, theme: 'dark' });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('names the region and lists the favourites as list items', async () => {
    await renderRail('/overview', { engine: seeded() });
    expect(within(lane()).getAllByRole('listitem')).toHaveLength(3);
  });
});
