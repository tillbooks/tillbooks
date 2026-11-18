/**
 * The area overview (D201, menu pick A): one page of tiles per menu group and nested parent, a live
 * search on top, and every tile hands the page it opens the way back (the SurfaceHeader back slot).
 *
 * Rendered inside the rail's real model (`renderWithRail`), so the overview reads the same personal
 * tree the rail does. SYNTHETIC BY CONSTRUCTION: no data beyond the shipped navigation model.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { axe } from 'jest-axe';

import { resetPrefsModuleForTests } from '../../lib/prefs';
import { resetNavPrefsForTests } from '../../app/nav-prefs';
import { fakePrefsEngine, renderWithRail } from '../../app/rail-test-kit';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { GroupOverview } from './GroupOverview';

/** D210: the compact menu leaves Lager, Anlagen and Projekte out of the rail (and so out of the tiles). */
async function renderAllAreas(path: string) {
  const engine = fakePrefsEngine();
  engine.put('ws_a', 'nav.menu_scope', 'all');
  const view = renderWithRail(
    <Routes>
      <Route path="area/:groupId" element={<GroupOverview />} />
    </Routes>,
    { path, workspaceId: 'ws_a', engine },
  );
  await waitFor(() => expect(document.querySelectorAll('.group-tile').length).toBeGreaterThan(0));
  return view;
}

function renderArea(path: string) {
  return renderWithRail(
    <Routes>
      <Route path="area/:groupId" element={<GroupOverview />} />
      <Route path="accounts" element={<SurfaceHeader title="Konten" />} />
      <Route path="inventory" element={<SurfaceHeader title="Bestand" />} />
    </Routes>,
    { path, workspaceId: null },
  );
}

beforeEach(() => {
  window.localStorage.clear();
  resetPrefsModuleForTests();
  resetNavPrefsForTests();
});

describe('GroupOverview: the tiles of one menu area (D201)', () => {
  it('shows every compact page of a group as a tile (D210: Lager and Anlagen are scope all)', () => {
    renderArea('/area/master-data');
    expect(screen.getByRole('heading', { level: 1, name: 'Stammdaten' })).toBeInTheDocument();
    const own = screen.getByRole('list', { name: 'Stammdaten' });
    expect(within(own).getByRole('link', { name: 'Kontakte' })).toHaveAttribute('href', '/contacts');
    expect(within(own).getAllByRole('link')).toHaveLength(4);
    expect(screen.queryByRole('list', { name: 'Lager' })).toBeNull();
    expect(document.querySelector('.surface-header-count')).toHaveTextContent('4');
    // Every tile carries its page icon; no helper sentence sits on a tile.
    for (const tile of document.querySelectorAll('.group-tile')) {
      expect(tile.querySelector('.group-tile-icon svg')).not.toBeNull();
      expect(tile.querySelectorAll('.group-tile-name')).toHaveLength(1);
    }
  });

  it('shows the parents’ pages under their own names once the menu scope is all', async () => {
    await renderAllAreas('/area/master-data');
    const own = screen.getByRole('list', { name: 'Stammdaten' });
    expect(within(own).getByRole('link', { name: 'Kontakte' })).toBeInTheDocument();
    // The nested parents follow as their own sections, a heading and their tiles.
    expect(screen.getByRole('heading', { level: 2, name: 'Lager' })).toBeInTheDocument();
    const lager = screen.getByRole('list', { name: 'Lager' });
    expect(within(lager).getAllByRole('link')).toHaveLength(10);
    expect(screen.getByRole('list', { name: 'Anlagen' })).toBeInTheDocument();
    // The header counts the pages: four of its own, ten under Lager, seven under Anlagen.
    expect(document.querySelector('.surface-header-count')).toHaveTextContent('21');
  });

  it('serves a nested parent too, with its own pages only', () => {
    renderArea('/area/lager-group');
    expect(screen.getByRole('heading', { level: 1, name: 'Lager' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /./ }).filter((a) => a.classList.contains('group-tile'))).toHaveLength(10);
  });

  it('filters the tiles as you type, accent-tolerant, with a filtered-empty state and the way back', async () => {
    renderArea('/area/accounting');
    const search = screen.getByRole('searchbox');
    await userEvent.type(search, 'jour');
    const tiles = [...document.querySelectorAll('.group-tile')].map((a) => a.textContent);
    expect(tiles.length).toBeGreaterThan(0);
    for (const name of tiles) expect(name?.toLowerCase()).toContain('jour');
    await userEvent.clear(search);
    await userEvent.type(search, 'zzz');
    expect(document.querySelectorAll('.group-tile')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(document.querySelectorAll('.group-tile').length).toBeGreaterThan(5);
  });

  it('hands the page a tile opens the way back to this overview (the SurfaceHeader back slot)', async () => {
    renderArea('/area/accounting');
    await userEvent.click(screen.getByRole('link', { name: 'Konten' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/accounts');
    const back = screen.getByRole('link', { name: 'Zurück zu Buchhaltung' });
    expect(back).toHaveAttribute('href', '/area/accounting');
    await userEvent.click(back);
    expect(screen.getByRole('heading', { level: 1, name: 'Buchhaltung' })).toBeInTheDocument();
  });

  it('shows the not-found detour for an area that does not exist', () => {
    renderArea('/area/nowhere');
    expect(screen.getByRole('heading', { name: 'Diese Adresse gibt es nicht.', level: 2 })).toBeInTheDocument();
  });

  it('shows a short state on a tile when the caller knows one cheaply', () => {
    renderWithRail(<GroupOverview areaId="bank" states={{ 'bank-inbox': '11 offen' }} />, { workspaceId: null });
    const inbox = document.querySelector('.group-tile[href="/bank"]') as HTMLElement;
    expect(within(inbox).getByText('11 offen')).toBeInTheDocument();
    // Only the page the caller named carries a state.
    expect(document.querySelectorAll('.group-tile-state')).toHaveLength(1);
  });

  it('has no axe violations', async () => {
    const { container } = renderArea('/area/sales');
    expect(await axe(container)).toHaveNoViolations();
  });
});
