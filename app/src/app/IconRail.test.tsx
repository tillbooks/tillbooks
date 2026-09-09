import { describe, it, expect } from 'vitest';
import { act } from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { axe } from 'jest-axe';

import { I18nProvider } from '../i18n';
import { IconRail } from './IconRail';

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

function renderIconRail(initialPath = '/journal') {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        {/* A landmark so an axe scan has the region it expects; the Shell supplies the real nav. */}
        <nav aria-label="Hauptnavigation">
          <IconRail />
        </nav>
        <LocationDisplay />
      </MemoryRouter>
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
