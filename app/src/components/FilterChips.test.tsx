/**
 * FilterChips, a multi-select row of facets (K-11, D137).
 *
 * Asserted: a named group of real toggle buttons (`aria-pressed`), any number on at once, the
 * selection handed back in the chips' own order, an optional tabular count, the pill when on, and axe
 * clean in both themes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { ThemeProvider, type Theme } from '../app/theme';
import { FilterChips, type FilterChip } from './FilterChips';

type State = 'open' | 'paid' | 'overdue';

const CHIPS: FilterChip<State>[] = [
  { value: 'open', label: 'Offen', count: 12 },
  { value: 'paid', label: 'Bezahlt', count: 40 },
  { value: 'overdue', label: 'Überfällig', count: 3 },
];

function Host({
  theme = 'light',
  initial = [],
  onChange,
}: {
  theme?: Theme;
  initial?: State[];
  onChange?: (next: State[]) => void;
}) {
  const [selected, setSelected] = useState<State[]>(initial);
  return (
    <ThemeProvider initialTheme={theme}>
      <FilterChips
        chips={CHIPS}
        selected={selected}
        onChange={(next) => {
          setSelected(next);
          onChange?.(next);
        }}
        label="Status"
      />
    </ThemeProvider>
  );
}

describe('FilterChips, the toggle contract', () => {
  it('is a named group of toggle buttons, off by default', () => {
    render(<Host />);
    expect(screen.getByRole('group', { name: 'Status' })).toBeInTheDocument();
    for (const name of [/Offen/, /Bezahlt/, /Überfällig/]) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('turns several facets on at once and reports them in the chips order, not the click order', async () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Überfällig/ }));
    await userEvent.click(screen.getByRole('button', { name: /Offen/ }));
    expect(onChange).toHaveBeenLastCalledWith(['open', 'overdue']);
    expect(screen.getByRole('button', { name: /Offen/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Überfällig/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Bezahlt/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('turns a facet off again, down to none', async () => {
    const onChange = vi.fn();
    render(<Host initial={['paid']} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Bezahlt/ }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByRole('button', { name: /Bezahlt/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggles from the keyboard with Space and Enter (native buttons)', async () => {
    render(<Host />);
    screen.getByRole('button', { name: /Offen/ }).focus();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('button', { name: /Offen/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: /Offen/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the optional count as a tabular figure after the label', () => {
    render(<Host />);
    const chip = screen.getByRole('button', { name: /Offen/ });
    const count = chip.querySelector('.filter-chip-count');
    expect(count).toHaveTextContent('12');
    expect(count).toHaveClass('t-num');
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme) => {
    const { container } = render(<Host theme={theme} initial={['open']} />);
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('FilterChips, the stylesheet', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/components/FilterChips.css'), 'utf8');

  it('is a 24px round chip', () => {
    expect(css).toMatch(/\.filter-chip\s*\{[^}]*height:\s*24px/);
    expect(css).toMatch(/\.filter-chip\s*\{[^}]*border-radius:\s*var\(--t-radius-full\)/);
  });

  it('wears the selected-item pill when on: accent-soft ground, accent ink', () => {
    const on = /\.filter-chip\[aria-pressed='true'\][^{]*\{([^}]*)\}/.exec(css);
    expect(on).not.toBeNull();
    expect(on![1]).toMatch(/background:\s*var\(--t-accent-soft\)/);
    expect(on![1]).toMatch(/color:\s*var\(--t-accent\)/);
  });

  it('keeps the visual chip at 24px but gives it a hit area of at least 32px (the D116 dense floor)', () => {
    // jsdom has no layout (getBoundingClientRect is all zeros there), so the geometry is read off the
    // stylesheet, the way the repo's style guards do: the chip's own height plus the ::after box that
    // extends it above and below. A pseudo-element is part of its element's hit-testing box, so a
    // press on the extension lands on the button.
    const chip = /\.filter-chip\s*\{([^}]*)\}/.exec(css);
    const hit = /\.filter-chip::after\s*\{([^}]*)\}/.exec(css);
    expect(chip).not.toBeNull();
    expect(hit).not.toBeNull();
    const visual = Number(/height:\s*(\d+)px/.exec(chip![1])?.[1]);
    expect(visual).toBe(24);
    expect(hit![1]).toMatch(/position:\s*absolute/);
    expect(hit![1]).toMatch(/content:\s*''/);
    const inset = /inset:\s*(-?\d+)px\s+(-?\d+)(?:px)?/.exec(hit![1]);
    expect(inset).not.toBeNull();
    const extension = -Number(inset![1]);
    // The ::after is placed against the PADDING box, inside the border, so the border does not count
    // toward the extension (a -4px inset over a 1px border measured a 30px target in the browser).
    const border = Number(/border:\s*(\d+)px/.exec(chip![1])?.[1] ?? 0);
    expect(visual - 2 * border + 2 * extension).toBeGreaterThanOrEqual(32);
    // The chip is the containing block of its hit box, and the row gap keeps neighbouring rows'
    // extensions from overlapping.
    expect(chip![1]).toMatch(/position:\s*relative/);
    expect(css).toMatch(/\.filter-chips\s*\{[^}]*gap:\s*var\(--t-space-1\)/);
  });

  it('draws the focus cue on its own border', () => {
    expect(css).toMatch(/\.filter-chip:focus-visible\s*\{[^}]*border-color:\s*var\(--t-focus-border\)/);
  });
});
