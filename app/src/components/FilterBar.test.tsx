/**
 * FilterBar, the shared filter/search row (D118 B2).
 *
 * The contract: a labelled search landmark, a hand-rolled search input that reports every keystroke,
 * a slot for the surface's own filters, and a Clear affordance that appears only while a filter is
 * active so a filtered-empty list is never a dead end. axe clean in both themes.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { ThemeProvider, type Theme } from '../app/theme';
import { FilterBar } from './FilterBar';

function renderBar(props: Partial<React.ComponentProps<typeof FilterBar>> = {}, theme: Theme = 'light') {
  return render(
    <ThemeProvider initialTheme={theme}>
      <FilterBar
        searchValue=""
        onSearchChange={() => {}}
        searchLabel="Kontakte durchsuchen"
        searchPlaceholder="Suchen"
        {...props}
      />
    </ThemeProvider>,
  );
}

describe('FilterBar', () => {
  it('is a labelled search landmark with a named search field', () => {
    renderBar();
    const region = screen.getByRole('search');
    expect(region).toHaveAccessibleName('Kontakte durchsuchen');
    expect(screen.getByRole('searchbox', { name: 'Kontakte durchsuchen' })).toBeInTheDocument();
  });

  it('reports every keystroke to the caller', async () => {
    const onSearchChange = vi.fn();
    renderBar({ onSearchChange });
    await userEvent.type(screen.getByRole('searchbox'), 'AG');
    expect(onSearchChange).toHaveBeenCalledTimes(2);
    expect(onSearchChange).toHaveBeenLastCalledWith('G');
  });

  it('renders a slot for the surface`s own filters', () => {
    renderBar({
      children: (
        <label>
          Rolle
          <select aria-label="Rolle">
            <option>Alle</option>
          </select>
        </label>
      ),
    });
    expect(screen.getByRole('combobox', { name: 'Rolle' })).toBeInTheDocument();
  });

  it('shows Clear only once the search is non-empty, and fires it', async () => {
    const onClear = vi.fn();
    const { rerender } = renderBar({ searchValue: '', onClear, clearLabel: 'Filter zurücksetzen' });
    expect(screen.queryByRole('button', { name: 'Filter zurücksetzen' })).toBeNull();

    rerender(
      <ThemeProvider initialTheme="light">
        <FilterBar
          searchValue="Muster"
          onSearchChange={() => {}}
          searchLabel="Kontakte durchsuchen"
          onClear={onClear}
          clearLabel="Filter zurücksetzen"
        />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('shows Clear when a filter behind the slot is active even with an empty search box', () => {
    renderBar({ searchValue: '', onClear: vi.fn(), clearLabel: 'Zurücksetzen', active: true });
    expect(screen.getByRole('button', { name: 'Zurücksetzen' })).toBeInTheDocument();
  });

  it('never shows Clear when no onClear handler is given', () => {
    renderBar({ searchValue: 'Muster' });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme) => {
    const { container } = renderBar(
      { searchValue: 'Muster', onClear: vi.fn(), clearLabel: 'Zurücksetzen' },
      theme,
    );
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
