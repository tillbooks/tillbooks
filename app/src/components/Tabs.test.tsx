/**
 * Tabs, the shared WAI-ARIA tablist (D118 B2).
 *
 * The APG contract is asserted: roving tabindex (one Tab stop), arrow keys with wraparound plus
 * Home/End, `aria-selected`, each tab wired to its panel via `aria-controls` / `aria-labelledby`, and
 * inactive panels hidden but mounted. axe clean in both themes.
 */
import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { ThemeProvider, type Theme } from '../app/theme';
import { Tabs, type TabItem } from './Tabs';

function items(): TabItem[] {
  return [
    { id: 'address', label: 'Adresse', panel: <p>Adressfelder</p> },
    { id: 'contacts', label: 'Kontakte', panel: <p>Ansprechpersonen</p> },
    { id: 'notes', label: 'Notizen', panel: <input aria-label="Notiz" /> },
  ];
}

function Host({ theme = 'light', initial = 'address' }: { theme?: Theme; initial?: string }) {
  const [active, setActive] = useState(initial);
  return (
    <ThemeProvider initialTheme={theme}>
      <Tabs tabs={items()} activeId={active} onChange={setActive} label="Kontaktdetails" />
    </ThemeProvider>
  );
}

describe('Tabs, the ARIA contract', () => {
  it('is a labelled tablist of tabs, each wired to its panel', () => {
    render(<Host />);
    const list = screen.getByRole('tablist', { name: 'Kontaktdetails' });
    expect(list).toBeInTheDocument();

    const first = screen.getByRole('tab', { name: 'Adresse' });
    const panel = screen.getByRole('tabpanel', { name: 'Adresse' });
    expect(first).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', first.id);
  });

  it('marks exactly the active tab selected and shows only its panel', () => {
    render(<Host />);
    expect(screen.getByRole('tab', { name: 'Adresse' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Kontakte' })).toHaveAttribute('aria-selected', 'false');
    // Only the active panel is exposed; the others are mounted but hidden.
    expect(screen.getByRole('tabpanel', { name: 'Adresse' })).toBeVisible();
    expect(screen.queryByRole('tabpanel', { name: 'Kontakte' })).toBeNull();
  });

  it('is a single Tab stop: only the active tab is tabbable', () => {
    render(<Host />);
    expect(screen.getByRole('tab', { name: 'Adresse' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Kontakte' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tab', { name: 'Notizen' })).toHaveAttribute('tabindex', '-1');
  });

  it('selects on click', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('tab', { name: 'Kontakte' }));
    expect(screen.getByRole('tab', { name: 'Kontakte' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Kontakte' })).toBeVisible();
  });

  it('moves selection and focus with the arrow keys, wrapping at both ends', async () => {
    render(<Host />);
    screen.getByRole('tab', { name: 'Adresse' }).focus();

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Kontakte' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Kontakte' })).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Notizen' })).toHaveFocus();

    // Wraps forward to the first.
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Adresse' })).toHaveFocus();

    // And backward to the last.
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Notizen' })).toHaveFocus();
  });

  it('Home and End jump to the first and last tab', async () => {
    render(<Host initial="contacts" />);
    screen.getByRole('tab', { name: 'Kontakte' }).focus();

    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Notizen' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Notizen' })).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Adresse' })).toHaveFocus();
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme) => {
    const { container } = render(<Host theme={theme} />);
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
