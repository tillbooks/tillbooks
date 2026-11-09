import { beforeEach, describe, it, expect } from 'vitest';
import { act } from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { axe } from 'jest-axe';

import { I18nProvider } from '../i18n';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type Transport } from '../lib/client';
import { WorkspaceProvider } from './workspace';
import { IconRail } from './IconRail';
import { RailStateProvider, resetNavPrefsForTests } from './nav-prefs';
import { resetPrefsModuleForTests } from '../lib/prefs';
import { fakePrefsEngine, renderWithRail } from './rail-test-kit';

beforeEach(() => {
  window.localStorage.clear();
  resetPrefsModuleForTests();
  resetNavPrefsForTests();
});

/** Focus a trigger the way a keyboard user would land on it. Wrapped in act, because focusing opens
 *  the flyout (a state update) and the strict console guard rejects an update that escapes act. */
function focus(el: HTMLElement): void {
  act(() => {
    el.focus();
  });
}

/** Surfaces the current pathname so a navigation is observable without a full route table. */
function LocationDisplay() {
  const location = useLocation();
  return <output data-testid="path">{location.pathname}</output>;
}

const quiet: Transport = async () => ({ status: 200, body: { ok: true, visibleQueues: 1, total: 0, top: [] } });

// A null workspace keeps the Pendenzen icon's live count dormant (no read), which is all the flyout
// tests need; the count tests below pass a real workspace and a transport of their own.
function renderIconRail(initialPath = '/journal', { workspaceId = null, transport = quiet }: { workspaceId?: string | null; transport?: Transport } = {}) {
  return render(
    <I18nProvider>
      <TillClientProvider client={new TillClient(transport)}>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter initialEntries={[initialPath]}>
            {/* A landmark so an axe scan has the region it expects; the Shell supplies the real nav. */}
            <nav aria-label="Hauptnavigation">
              <RailStateProvider>
                <IconRail />
              </RailStateProvider>
            </nav>
            <LocationDisplay />
          </MemoryRouter>
        </WorkspaceProvider>
      </TillClientProvider>
    </I18nProvider>,
  );
}

const path = () => screen.getByTestId('path').textContent;

describe('IconRail: the collapsed icon strip and its flyouts (D118 A4)', () => {
  it('renders a single-destination surface as a link icon and a headed group as a disclosure icon', () => {
    renderIconRail();
    // A daily surface: a plain icon button, no popup.
    const overview = screen.getByRole('button', { name: 'Übersicht' });
    expect(overview).not.toHaveAttribute('aria-haspopup');
    // A headed group: a disclosure that owns a flyout.
    const group = screen.getByRole('button', { name: 'Stammdaten' });
    expect(group).toHaveAttribute('aria-haspopup', 'true');
    expect(group).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a group flyout on focus and lists that group destinations', () => {
    renderIconRail();
    const group = screen.getByRole('button', { name: 'Stammdaten' });
    focus(group);
    expect(group).toHaveAttribute('aria-expanded', 'true');
    const flyout = screen.getByRole('group', { name: 'Stammdaten' });
    // The flyout is a disclosure, never a modal dialog (the modal-role guard forbids that here).
    expect(flyout).not.toHaveAttribute('role', 'dialog');
    expect(within(flyout).getByRole('button', { name: 'Konten' })).toBeInTheDocument();
  });

  it('closes the flyout on Escape and returns focus to the icon', () => {
    renderIconRail();
    const group = screen.getByRole('button', { name: 'Stammdaten' });
    focus(group);
    expect(screen.getByRole('group', { name: 'Stammdaten' })).toBeInTheDocument();
    fireEvent.keyDown(group, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Stammdaten' })).toBeNull();
    expect(document.activeElement).toBe(group);
  });

  it('navigates when a flyout destination is chosen', async () => {
    renderIconRail();
    const group = screen.getByRole('button', { name: 'Stammdaten' });
    focus(group);
    await userEvent.click(within(screen.getByRole('group', { name: 'Stammdaten' })).getByRole('button', { name: 'Konten' }));
    expect(path()).toBe('/accounts');
  });

  it('navigates directly when a single-destination icon is clicked', async () => {
    renderIconRail();
    await userEvent.click(screen.getByRole('button', { name: 'Übersicht' }));
    expect(path()).toBe('/overview');
  });

  it('marks the active surface with aria-current, never colour alone', () => {
    renderIconRail('/overview');
    expect(screen.getByRole('button', { name: 'Übersicht' })).toHaveAttribute('aria-current', 'page');
  });

  it('has no axe violations with a flyout open', async () => {
    const { container } = renderIconRail();
    focus(screen.getByRole('button', { name: 'Stammdaten' }));
    expect(screen.getByRole('group', { name: 'Stammdaten' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('IconRail: the Pendenzen icon carries the live waiting-work count (collapsed rail)', () => {
  const summary = (total: number | null): Transport => async () => ({
    status: 200,
    body: { ok: true, visibleQueues: total === null ? 0 : 2, total, top: [] },
  });

  it('puts the count in the accessible NAME and on the icon, never colour alone', async () => {
    const { container } = renderIconRail('/journal', { workspaceId: 'ws_icon', transport: summary(3) });
    const icon = await screen.findByRole('button', { name: 'Pendenzen, 3 offen' });
    expect(within(icon).getByText('3')).toHaveAttribute('aria-hidden', 'true');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('caps the figure at 99+', async () => {
    renderIconRail('/journal', { workspaceId: 'ws_icon', transport: summary(250) });
    expect(await screen.findByRole('button', { name: 'Pendenzen, 99+ offen' })).toHaveTextContent('99+');
  });

  it('shows nothing for a true zero and for a denied actor: the plain name, no figure', async () => {
    for (const total of [0, null]) {
      const { unmount } = renderIconRail('/journal', { workspaceId: `ws_${String(total)}`, transport: summary(total) });
      await act(async () => {});
      const icon = screen.getByRole('button', { name: 'Pendenzen' });
      expect(icon.querySelector('.rail-icon-count')).toBeNull();
      unmount();
    }
  });

  it('a failed read says so in words and shows no stale number', async () => {
    renderIconRail('/journal', { workspaceId: 'ws_icon', transport: async () => ({ status: 422, body: { ok: false, error: 'boom' } }) });
    const icon = await screen.findByRole('button', { name: /Pendenzen, Die Anzahl Pendenzen konnte nicht geladen werden/ });
    expect(icon.querySelector('.rail-icon-count')).toHaveTextContent('!');
  });
});

describe('IconRail: the favourites lead the strip, and one row is lit (D178, US-G16.15)', () => {
  function seeded(favourites: { navId: string }[], extra: Record<string, unknown> = {}) {
    const engine = fakePrefsEngine();
    engine.put('ws_a', 'nav.favourites', favourites);
    for (const [key, value] of Object.entries(extra)) engine.put('ws_a', key, value as never);
    return engine;
  }
  const strip = (
    <nav aria-label="Hauptnavigation">
      <IconRail />
    </nav>
  );

  it('puts the pinned pages first, in the person\'s order, as link icons in a named group', async () => {
    renderWithRail(strip, { path: '/overview', engine: seeded([{ navId: 'journal' }, { navId: 'bank-inbox' }]) });
    const pins = await screen.findByRole('group', { name: 'Favoriten' });
    const names = within(pins).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Journal', 'Bankzeilen']);
    expect(within(pins).getByRole('button', { name: 'Journal' })).not.toHaveAttribute('aria-haspopup');
  });

  it('lights only the favourite for a pinned, open page under the default rule', async () => {
    const { container } = renderWithRail(strip, { path: '/journal', engine: seeded([{ navId: 'journal' }]) });
    const pins = await screen.findByRole('group', { name: 'Favoriten' });
    expect(within(pins).getByRole('button', { name: 'Journal' })).toHaveAttribute('aria-current', 'page');
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Buchhaltung' })).not.toHaveAttribute('aria-current');
  });

  it('marks the group instead under the tree rule, and the favourite stays plain', async () => {
    const { container } = renderWithRail(strip, {
      path: '/journal',
      engine: seeded([{ navId: 'journal' }], { 'nav.active_rule': 'tree' }),
    });
    const pins = await screen.findByRole('group', { name: 'Favoriten' });
    expect(screen.getByRole('button', { name: 'Buchhaltung' })).toHaveAttribute('aria-current', 'true');
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
    expect(within(pins).getByRole('button', { name: 'Journal' })).not.toHaveAttribute('aria-current');
  });

  it('leaves a hidden group out of the strip', async () => {
    renderWithRail(strip, { path: '/overview', engine: seeded([{ navId: 'journal' }], { 'nav.menu_layout': { hidden: ['group:sales'] } }) });
    await screen.findByRole('group', { name: 'Favoriten' });
    expect(screen.queryByRole('button', { name: 'Verkauf' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stammdaten' })).toBeInTheDocument();
  });
});
