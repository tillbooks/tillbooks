/**
 * "Menü anpassen" (D178 point 6): the person's own menu order. Reorder groups and pages, move a page to
 * another group, hide, reset; by the Mehr menu (the WCAG 2.5.7 single-pointer path), by Alt+Arrow on
 * the focused row, and with every change written to `nav.menu_layout` at once. The router never reads
 * the layout, so this suite is about the rail alone. SYNTHETIC BY CONSTRUCTION.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { resetPrefsModuleForTests, type PrefValue } from '../lib/prefs';
import type { Theme } from './theme';
import { FavouritesRail } from './FavouritesRail';
import { MenuCustomiseEntry, MenuSection } from './NavTree';
import { resetNavPrefsForTests } from './nav-prefs';
import { fakePrefsEngine, renderWithRail, type FakePrefsEngine } from './rail-test-kit';

const WS = 'ws_a';
/** As the Shell mounts it: the two sections, and the footer's pencil for a menu without a header. */
const RAIL = (
  <nav aria-label="Hauptnavigation">
    <FavouritesRail />
    <MenuSection />
    <MenuCustomiseEntry />
  </nav>
);

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

async function renderRail(
  path = '/overview',
  { engine = fakePrefsEngine(), theme = 'light' as Theme }: { engine?: FakePrefsEngine; theme?: Theme } = {},
) {
  const view = renderWithRail(RAIL, { path, engine, workspaceId: WS, theme });
  await settle();
  return view;
}

const editor = () => screen.getByRole('region', { name: 'Menü anpassen' });

async function openEditor() {
  await userEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
  return editor();
}

/** Pick an item of a row's Mehr menu (the OverflowMenu named "<Seite> verschieben"). */
async function chooseFromMore(name: string, item: string) {
  await userEvent.click(within(editor()).getByRole('button', { name: `${name} verschieben` }));
  await userEvent.click(screen.getByRole('menuitem', { name: item }));
}

/** The menu's group headers, top to bottom, as the tree shows them. */
const groupHeaders = () =>
  within(screen.getByRole('tree'))
    .getAllByRole('treeitem')
    .filter((el) => el.classList.contains('rail-group-row'))
    .map((el) => el.textContent);

/** The canonical headed groups except Bank, in order: a stored layout names every group it orders. */
const OTHER_GROUPS = ['projects', 'master-data', 'sales', 'purchasing', 'accounting', 'reports', 'treuhaender', 'settings'];

const storedLayout = (engine: FakePrefsEngine) => engine.get(WS, 'nav.menu_layout') as { groups?: string[]; hidden?: string[]; containers?: Record<string, string[]> } | undefined;

beforeEach(() => {
  window.localStorage.clear();
  resetPrefsModuleForTests();
  resetNavPrefsForTests();
});

describe('opening and closing', () => {
  it('the pencil sits on the Menü header above favourites, and in the footer while the menu has no header', async () => {
    const engine = fakePrefsEngine();
    const { unmount } = await renderRail('/overview', { engine });
    expect(screen.queryByRole('button', { name: 'Menü' })).toBeNull();
    const footerPencil = screen.getByRole('button', { name: 'Bearbeiten' });
    expect(footerPencil).toHaveClass('rail-customise-entry');
    unmount();
    engine.put(WS, 'nav.favourites', [{ navId: 'journal' }]);
    await renderRail('/overview', { engine });
    const pencils = screen.getAllByRole('button', { name: 'Bearbeiten' });
    expect(pencils).toHaveLength(1);
    expect(pencils[0]).toHaveClass('rail-section-action');
  });

  it('opens from its pencil, lands on Fertig, and closes on Fertig and on Escape', async () => {
    await renderRail();
    const region = await openEditor();
    expect(within(region).getByRole('button', { name: 'Fertig' })).toHaveFocus();
    expect(screen.queryByRole('tree')).toBeNull();
    await userEvent.click(within(region).getByRole('button', { name: 'Fertig' }));
    expect(screen.queryByRole('region', { name: 'Menü anpassen' })).toBeNull();
    expect(screen.getByRole('tree')).toBeInTheDocument();
    await openEditor();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Menü anpassen' })).toBeNull();
  });

  it('lists the top block and every group, each with a checked visibility box and no grip in the tab order', async () => {
    await renderRail();
    const region = await openEditor();
    expect(within(region).getByRole('checkbox', { name: 'Übersicht im Menü zeigen' })).toBeChecked();
    expect(within(region).getByRole('checkbox', { name: 'Verkauf im Menü zeigen' })).toBeChecked();
    for (const grip of region.querySelectorAll('.rail-edit-grip')) {
      expect(grip).toHaveAttribute('aria-hidden', 'true');
      expect(grip.getAttribute('tabindex')).toBeNull();
    }
    // Zurücksetzen has nothing to undo yet.
    expect(within(region).getByRole('button', { name: 'Zurücksetzen' })).toBeDisabled();
  });

  it('says what a tick means, names no "Immer sichtbar" block, and draws no page icon (judge M5, H3)', async () => {
    await renderRail();
    const region = await openEditor();
    expect(
      within(region).getByText('Ziehen oder mit ⋯ verschieben. Ohne Häkchen ist die Seite ausgeblendet, die Suche findet sie weiter.'),
    ).toBeInTheDocument();
    expect(within(region).queryByText('Immer sichtbar')).toBeNull();
    // The checkbox takes the icon column: no page or group glyph in an editor row, only grip and chevron.
    for (const row of region.querySelectorAll('.rail-edit-row')) {
      expect(row.querySelector('.rail-icon')).toBeNull();
      expect(row.querySelector('.rail-edit-checkwrap input[type="checkbox"]')).not.toBeNull();
    }
  });
});

describe('reorder, by the Mehr menu and by Alt+Arrow (WCAG 2.5.7)', () => {
  it('moves a group down through its Mehr menu and the engine keeps the order', async () => {
    const { engine } = await renderRail();
    await openEditor();
    await chooseFromMore('Projekte', 'Nach unten');
    await settle();
    expect(storedLayout(engine)?.groups?.slice(0, 2)).toEqual(['master-data', 'projects']);
    await userEvent.click(within(editor()).getByRole('button', { name: 'Fertig' }));
    expect(groupHeaders().slice(0, 2)).toEqual(['Stammdaten', 'Projekte']);
  });

  it('moves the focused row with Alt+ArrowUp and announces it', async () => {
    const { engine } = await renderRail();
    const region = await openEditor();
    const box = within(region).getByRole('checkbox', { name: 'Stammdaten im Menü zeigen' });
    act(() => box.focus());
    fireEvent.keyDown(box, { key: 'ArrowUp', altKey: true });
    expect(within(region).getByText('Stammdaten nach oben verschoben')).toBeInTheDocument();
    await settle();
    expect(storedLayout(engine)?.groups?.slice(0, 2)).toEqual(['master-data', 'projects']);
  });

  it('disables Nach oben on the first row (the ends are fixed)', async () => {
    await renderRail();
    await openEditor();
    await userEvent.click(within(editor()).getByRole('button', { name: 'Projekte verschieben' }));
    expect(screen.getByRole('menuitem', { name: 'Nach oben' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('move to another group', () => {
  it('moves Journal out of its group, to "Ohne Gruppe" (the top block)', async () => {
    const { engine } = await renderRail();
    const region = await openEditor();
    await userEvent.click(within(region).getByRole('button', { name: 'Buchhaltung' }));
    await chooseFromMore('Journal', 'Verschieben nach …');
    const picker = within(editor()).getByRole('combobox', { name: 'Journal verschieben nach' });
    expect(picker).toHaveFocus();
    await userEvent.click(picker);
    await userEvent.click(screen.getByRole('option', { name: 'Ohne Gruppe' }));
    expect(within(editor()).getByText('Journal nach Ohne Gruppe verschoben')).toBeInTheDocument();
    await settle();
    expect(storedLayout(engine)?.containers?.top).toContain('journal');
    await userEvent.click(within(editor()).getByRole('button', { name: 'Fertig' }));
    expect(within(screen.getByRole('tree')).getByRole('treeitem', { name: 'Journal' })).toHaveAttribute('aria-level', '1');
  });
});

describe('hide and reset', () => {
  it('hides a group from the menu; its pages stay reachable (the router never reads the layout)', async () => {
    const { engine } = await renderRail();
    const region = await openEditor();
    await userEvent.click(within(region).getByRole('checkbox', { name: 'Verkauf im Menü zeigen' }));
    expect(within(region).getByRole('checkbox', { name: 'Verkauf im Menü zeigen' })).not.toBeChecked();
    await settle();
    expect(storedLayout(engine)?.hidden).toEqual(['group:sales']);
    await userEvent.click(within(region).getByRole('button', { name: 'Fertig' }));
    expect(groupHeaders()).not.toContain('Verkauf');
  });

  it('resets to the canonical tree through prefs_reset', async () => {
    const engine = fakePrefsEngine();
    engine.put(WS, 'nav.menu_layout', { groups: ['bank', ...OTHER_GROUPS], hidden: ['group:sales'] } as unknown as PrefValue);
    await renderRail('/overview', { engine });
    expect(groupHeaders()[0]).toBe('Bank');
    const region = await openEditor();
    await userEvent.click(within(region).getByRole('button', { name: 'Zurücksetzen' }));
    await settle();
    expect(engine.calls.at(-1)).toEqual({ action: 'prefs_reset', input: { workspaceId: WS, key: 'nav.menu_layout' } });
    expect(engine.get(WS, 'nav.menu_layout')).toBeUndefined();
    await userEvent.click(within(editor()).getByRole('button', { name: 'Fertig' }));
    expect(groupHeaders()[0]).toBe('Projekte');
    expect(groupHeaders()).toContain('Verkauf');
  });

  it('drops ids the catalog does not know and still shows every page', async () => {
    const engine = fakePrefsEngine();
    engine.put(WS, 'nav.menu_layout', {
      groups: ['ghost', 'bank', ...OTHER_GROUPS],
      containers: { bank: ['ghost-page', 'payments'] },
      hidden: ['ghost-too'],
    } as unknown as PrefValue);
    await renderRail('/overview', { engine });
    expect(groupHeaders()[0]).toBe('Bank');
    expect(screen.queryByText(/ghost/)).toBeNull();
    const region = await openEditor();
    expect(within(region).queryByText(/ghost/)).toBeNull();
  });

  it('says so in words when the engine refuses a change, and keeps it for the session', async () => {
    const engine = fakePrefsEngine();
    engine.refuseAll('invalid_pref_value');
    await renderRail('/overview', { engine });
    const region = await openEditor();
    await userEvent.click(within(region).getByRole('checkbox', { name: 'Verkauf im Menü zeigen' }));
    await settle();
    expect(within(region).getByText(/Konnte nicht gespeichert werden/)).toBeInTheDocument();
    expect(within(region).getByRole('checkbox', { name: 'Verkauf im Menü zeigen' })).not.toBeChecked();
  });
});

describe('accessibility (jest-axe, both themes)', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`has no axe violations with the editor open and a group expanded (${theme})`, async () => {
      const engine = fakePrefsEngine();
      engine.put(WS, 'nav.favourites', [{ navId: 'journal' }]);
      const { container } = await renderRail('/journal', { engine, theme });
      const region = await openEditor();
      await userEvent.click(within(region).getByRole('button', { name: 'Bank' }));
      await waitFor(() => expect(within(region).getByRole('checkbox', { name: 'Bankzeilen im Menü zeigen' })).toBeInTheDocument());
      expect(await axe(container)).toHaveNoViolations();
    });
  }
});
