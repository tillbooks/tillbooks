/**
 * Tabs, the shared WAI-ARIA tablist (D118 B2).
 *
 * The APG contract is asserted: roving tabindex (one Tab stop), arrow keys with wraparound plus
 * Home/End, `aria-selected`, each tab wired to its panel via `aria-controls` / `aria-labelledby`, and
 * inactive panels hidden but mounted. axe clean in both themes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

describe('Tabs, one shared panel rendered by the caller', () => {
  function SharedHost({ theme = 'light' }: { theme?: Theme }) {
    const [active, setActive] = useState('live');
    return (
      <ThemeProvider initialTheme={theme}>
        <Tabs
          tabs={[
            { id: 'live', label: 'Laufend' },
            { id: 'archive', label: 'Archiv' },
          ]}
          activeId={active}
          onChange={setActive}
          label="Journal"
        >
          {active === 'live' ? <p>Laufende Buchungen</p> : <p>Archivierte Buchungen</p>}
        </Tabs>
      </ThemeProvider>
    );
  }

  it('renders one tabpanel labelled by the active tab, and only the active tab controls it', async () => {
    render(<SharedHost />);
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    const live = screen.getByRole('tab', { name: 'Laufend' });
    const archive = screen.getByRole('tab', { name: 'Archiv' });
    const panel = screen.getByRole('tabpanel', { name: 'Laufend' });
    expect(panel).toHaveTextContent('Laufende Buchungen');
    expect(live).toHaveAttribute('aria-controls', panel.id);
    expect(archive).not.toHaveAttribute('aria-controls');

    await userEvent.click(archive);
    const after = screen.getByRole('tabpanel', { name: 'Archiv' });
    expect(after).toHaveTextContent('Archivierte Buchungen');
    expect(archive).toHaveAttribute('aria-controls', after.id);
    expect(live).not.toHaveAttribute('aria-controls');
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme) => {
    const { container } = render(<SharedHost theme={theme} />);
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('Tabs, vertical orientation', () => {
  it('reports aria-orientation and walks with the up and down arrows', async () => {
    function Vertical() {
      const [active, setActive] = useState('address');
      return (
        <Tabs tabs={items()} activeId={active} onChange={setActive} label="Kategorien" orientation="vertical" />
      );
    }
    const { container } = render(<Vertical />);
    expect(screen.getByRole('tablist', { name: 'Kategorien' })).toHaveAttribute('aria-orientation', 'vertical');
    expect(container.querySelector('.tabs')).toHaveClass('tabs--vertical');
    screen.getByRole('tab', { name: 'Adresse' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('tab', { name: 'Kontakte' })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('tab', { name: 'Adresse' })).toHaveFocus();
  });

  it('keeps one Tab stop on the first tab when activeId names no tab', () => {
    render(<Tabs tabs={items()} activeId="missing" onChange={() => undefined} label="Kontaktdetails" />);
    expect(screen.getByRole('tab', { name: 'Adresse' })).toHaveAttribute('tabindex', '0');
  });
});

describe('Tabs, the stylesheet (K-11)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/components/Tabs.css'), 'utf8');

  it('sits in the control band and marks the active tab with the tinted pill', () => {
    expect(css).toMatch(/\.tabs-tab\s*\{[^}]*height:\s*var\(--t-control-h\)/);
    const active = /\.tabs-tab--active,[^{]*\{([^}]*)\}/.exec(css);
    expect(active).not.toBeNull();
    expect(active![1]).toMatch(/background:\s*var\(--t-accent-soft\)/);
    expect(active![1]).toMatch(/color:\s*var\(--t-accent\)/);
  });

  it('draws no accent bar: no accent border and no inset accent shadow', () => {
    expect(css).not.toMatch(/border-(?:left|right|bottom)[^;]*--t-accent/);
    expect(css).not.toMatch(/inset[^;]*--t-accent/);
  });

  it('gives each tab a transparent border for the focus cue and colour-only hover transitions', () => {
    expect(css).toMatch(/\.tabs-tab\s*\{[^}]*border:\s*1px solid transparent/);
    expect(css).toMatch(/transition:[^;]*var\(--t-motion-hover\)/);
  });
});
