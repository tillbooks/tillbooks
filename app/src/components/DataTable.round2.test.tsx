/**
 * DataTable, the round 2 behaviours (D137): K-19 the overflow edges, K-21 one opener and one
 * overflow per row, K-34 the table's own placeholder with the 200ms/300ms thresholds, and the
 * stylesheet facts of K-18, K-20 and K-23. The selection pill (K-14, K-24) has its own guard in
 * `DataTable.selection.test.tsx`.
 *
 * The K-34 blocks assert timing on a presentational component with no read of its own, so they are
 * titled and written in the vocabulary of time and shape, not of reads: the read-in-flight guard is
 * for surfaces that own a transport.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';

import { ThemeProvider, type Theme } from '../app/theme';
import { I18nProvider } from '../i18n';
import { DensityProvider } from '../app/density';
import { DataTable, type DataTableColumn, type DataTableProps } from './DataTable';
import { SKELETON_DELAY_MS, SKELETON_MIN_VISIBLE_MS } from './states/useSkeletonTiming';

interface Invoice {
  id: string;
  number: string;
  customer: string;
  amountMinor: number;
}

const ROWS: Invoice[] = [
  { id: 'a', number: 'RE-001', customer: 'Muster AG', amountMinor: 125000 },
  { id: 'b', number: 'RE-002', customer: 'Beispiel GmbH', amountMinor: -4200 },
];

const COLUMNS: DataTableColumn<Invoice>[] = [
  { key: 'number', header: 'Nummer', render: (r) => r.number },
  { key: 'customer', header: 'Kunde', render: (r) => r.customer },
  { key: 'amount', header: 'Betrag', numeric: true, render: (r) => `CHF ${r.amountMinor}` },
];

type Props = Partial<DataTableProps<Invoice>>;

function Table(props: Props) {
  return (
    <DataTable<Invoice>
      columns={COLUMNS}
      rows={ROWS}
      rowKey={(r) => r.id}
      caption="Rechnungen"
      {...props}
    />
  );
}

function Detail() {
  const { id } = useParams();
  return <p>Rechnung {id} geöffnet</p>;
}

function renderRouted(props: Props, theme: Theme = 'light') {
  return render(
    <ThemeProvider initialTheme={theme}>
      <DensityProvider initialDensity="komfortabel">
        <I18nProvider>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<Table {...props} />} />
              <Route path="/invoices/:id" element={<Detail />} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </DensityProvider>
    </ThemeProvider>,
  );
}

const css = readFileSync(resolve(process.cwd(), 'src/components/DataTable.css'), 'utf8');

describe('DataTable, the route opener (K-21)', () => {
  const href = (r: Invoice) => `/invoices/${r.id}`;

  it('makes the leading cell a real link, and the row itself is no Tab stop', () => {
    renderRouted({ rowHref: href });
    const link = screen.getByRole('link', { name: 'RE-001' });
    expect(link).toHaveAttribute('href', '/invoices/a');
    expect(link).toHaveClass('data-table-open');
    const row = link.closest('tr') as HTMLElement;
    expect(row).not.toHaveAttribute('tabindex');
    expect(row).toHaveClass('data-table-row--clickable');
    // The link sits in the row header, so the row is still named by its own value.
    expect(link.closest('th')).toHaveAttribute('scope', 'row');
  });

  it('a click anywhere on the row follows the link', async () => {
    renderRouted({ rowHref: href });
    await userEvent.click(screen.getByText('Beispiel GmbH'));
    expect(await screen.findByText('Rechnung b geöffnet')).toBeInTheDocument();
  });

  it('the link itself opens by keyboard', async () => {
    renderRouted({ rowHref: href });
    screen.getByRole('link', { name: 'RE-001' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Rechnung a geöffnet')).toBeInTheDocument();
  });

  it('a row whose href is undefined opens nothing and has no link', () => {
    renderRouted({ rowHref: (r) => (r.id === 'a' ? href(r) : undefined) });
    expect(screen.getAllByRole('link')).toHaveLength(1);
    const plain = screen.getByText('RE-002').closest('tr') as HTMLElement;
    expect(plain).not.toHaveClass('data-table-row--clickable');
  });

  it('takes precedence over onRowClick on the same row', async () => {
    const onRowClick = vi.fn();
    renderRouted({ rowHref: href, onRowClick, rowLabel: (r) => `Rechnung ${r.number}` });
    await userEvent.click(screen.getByText('Muster AG'));
    expect(await screen.findByText('Rechnung a geöffnet')).toBeInTheDocument();
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('DataTable, one trailing overflow per row (K-21)', () => {
  const actions = (r: Invoice) => [
    { key: 'delete', label: 'Löschen', danger: true, onSelect: vi.fn() },
    { key: 'edit', label: 'Bearbeiten', onSelect: vi.fn() },
    { key: 'copy', label: `${r.number} kopieren`, onSelect: vi.fn() },
  ];

  it('renders one quiet overflow per row in a trailing cell named for assistive tech', () => {
    renderRouted({ rowActions: actions, rowActionsLabel: (r) => `Aktionen für ${r.number}` });
    expect(screen.getByRole('columnheader', { name: 'Aktionen' })).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'Aktionen für RE-001' });
    expect(trigger).toHaveClass('btn--ghost');
    expect(trigger.closest('td')).toHaveClass('data-table-actions');
    expect(screen.getAllByRole('button', { name: /Aktionen für/ })).toHaveLength(2);
  });

  it('moves the destructive verb last, below a separator', async () => {
    renderRouted({ rowActions: actions, rowActionsLabel: (r) => `Aktionen für ${r.number}` });
    await userEvent.click(screen.getByRole('button', { name: 'Aktionen für RE-001' }));
    const menu = screen.getByRole('menu');
    const labels = within(menu).getAllByRole('menuitem').map((item) => item.textContent);
    expect(labels).toEqual(['Bearbeiten', 'RE-001 kopieren', 'Löschen']);
    const separator = within(menu).getByRole('separator');
    // The separator sits directly before the destructive item.
    expect(separator.nextElementSibling).toHaveTextContent('Löschen');
  });

  it('a row with no other verb shows no trigger at all', () => {
    renderRouted({ rowActions: (r) => (r.id === 'a' ? [] : actions(r)), rowActionsLabel: (r) => `Aktionen für ${r.number}` });
    expect(screen.queryByRole('button', { name: 'Aktionen für RE-001' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Aktionen für RE-002' })).toBeInTheDocument();
  });

  it('opening the overflow never also opens the row', async () => {
    const onRowClick = vi.fn();
    renderRouted({
      onRowClick,
      rowLabel: (r) => `Rechnung ${r.number}`,
      rowActions: actions,
      rowActionsLabel: (r) => `Aktionen für ${r.number}`,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Aktionen für RE-001' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('keeps the totals row aligned with an empty foot cell under the overflow column', () => {
    const { container } = renderRouted({
      rowActions: actions,
      rowActionsLabel: (r) => `Aktionen für ${r.number}`,
      footer: [{ key: 'amount', content: 'CHF 120800' }],
    });
    const foot = container.querySelector('tfoot tr') as HTMLElement;
    expect(foot.children).toHaveLength(COLUMNS.length + 1);
  });

  it.each(['light', 'dark'] as const)('has no axe violations with openers and overflows, %s theme', async (theme) => {
    const { container } = renderRouted(
      { rowHref: (r) => `/invoices/${r.id}`, rowActions: actions, rowActionsLabel: (r) => `Aktionen für ${r.number}` },
      theme,
    );
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('DataTable, the overflow edges (K-19)', () => {
  function withWidths(scrollWidth: number, clientWidth: number, run: () => void) {
    const saved = {
      scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth'),
      clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth'),
    };
    Object.defineProperty(Element.prototype, 'scrollWidth', { configurable: true, get: () => scrollWidth });
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => clientWidth });
    try {
      run();
    } finally {
      if (saved.scrollWidth) Object.defineProperty(Element.prototype, 'scrollWidth', saved.scrollWidth);
      if (saved.clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', saved.clientWidth);
    }
  }

  it('a fitting table draws no edges', () => {
    const { container } = renderRouted({});
    expect(container.querySelector('.data-table-edge')).toBeNull();
    expect(container.querySelector('.data-table-wrap')).not.toHaveAttribute('data-more-end');
  });

  it('an overflowing table marks the side that hides content, and follows the scroll', () => {
    withWidths(1600, 960, () => {
      const { container } = renderRouted({});
      const wrap = container.querySelector('.data-table-wrap') as HTMLElement;
      const frame = container.querySelector('.data-table-frame') as HTMLElement;
      expect(container.querySelectorAll('.data-table-edge')).toHaveLength(2);
      expect(wrap).toHaveAttribute('data-more-end');
      expect(wrap).not.toHaveAttribute('data-more-start');

      frame.scrollLeft = 640;
      fireEvent.scroll(frame);
      expect(wrap).toHaveAttribute('data-more-start');
      expect(wrap).not.toHaveAttribute('data-more-end');

      frame.scrollLeft = 300;
      fireEvent.scroll(frame);
      expect(wrap).toHaveAttribute('data-more-start');
      expect(wrap).toHaveAttribute('data-more-end');
    });
  });

  it('the stylesheet draws the bar at rest and shows an edge only on a side with more', () => {
    expect(css).toMatch(/\.data-table-frame\[data-overflow\]\s*\{[^}]*overflow-x:\s*scroll/);
    expect(css).toMatch(/\.data-table-edge\s*\{[^}]*opacity:\s*0/);
    expect(css).toMatch(/\[data-more-end\] > \.data-table-edge--end/);
    expect(css).toMatch(/\.data-table-edge\s*\{[^}]*pointer-events:\s*none/);
    // Under the sticky page header, over the table: the raised tier.
    expect(css).toMatch(/\.data-table-edge\s*\{[^}]*z-index:\s*var\(--t-z-raised\)/);
  });
});

describe('DataTable, the placeholder takes the table shape and keeps time (K-34)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function Harness({ on }: { on: boolean }) {
    return (
      <ThemeProvider initialTheme="light">
        <DensityProvider initialDensity="komfortabel">
          <I18nProvider>
            <MemoryRouter>
              <Table loading={on} skeletonRows={4} />
            </MemoryRouter>
          </I18nProvider>
        </DensityProvider>
      </ThemeProvider>
    );
  }

  it('draws the head strip and the rows at the row height, in the DOM at once and hidden for 200ms', () => {
    vi.useFakeTimers();
    const { container } = render(<Harness on />);
    const shape = container.querySelector('.data-table-skeleton') as HTMLElement;
    expect(shape).not.toBeNull();
    expect(shape.querySelector('.data-table-skeleton-head')).not.toBeNull();
    expect(shape.querySelectorAll('.data-table-skeleton-row')).toHaveLength(4);
    expect(shape.querySelectorAll('.skeleton')).toHaveLength(4);
    expect(screen.queryByRole('table')).toBeNull();
    expect(shape).toHaveAttribute('data-pending');
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS));
    expect(shape).not.toHaveAttribute('data-pending');
  });

  it('data that lands inside 200ms replaces the shape at once', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Harness on />);
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS - 100));
    rerender(<Harness on={false} />);
    expect(container.querySelector('.data-table-skeleton')).toBeNull();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('a shape that did appear stays 300ms before the data replaces it', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Harness on />);
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS + 40));
    rerender(<Harness on={false} />);
    expect(container.querySelector('.data-table-skeleton')).not.toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    act(() => vi.advanceTimersByTime(SKELETON_MIN_VISIBLE_MS - 41));
    expect(screen.queryByRole('table')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('the stylesheet sizes the strip and the rows from the row tokens and hides the held-back shape', () => {
    expect(css).toMatch(/\.data-table-skeleton-head\s*\{[^}]*height:\s*var\(--t-row-head-h\)/);
    expect(css).toMatch(/\.data-table-skeleton-row\s*\{[^}]*height:\s*var\(--t-row-h\)/);
    expect(css).toMatch(/\.data-table-skeleton\[data-pending\]\s*\{[^}]*visibility:\s*hidden/);
  });
});

describe('DataTable, the stylesheet law of round 2', () => {
  it('K-20: every body cell, the row-header th included, is the row token tall', () => {
    expect(css).toMatch(/\.data-table tbody :is\(td, th\)\s*\{[^}]*height:\s*var\(--t-row-h\)/);
    expect(css).toMatch(/\.data-table tbody :is\(td, th\)\s*\{[^}]*padding:\s*var\(--t-row-pad-y\) var\(--t-cell-pad-x\)/);
    expect(css).toMatch(/\.data-table thead th\s*\{[^}]*height:\s*var\(--t-row-head-h\)/);
  });

  it('K-20: a cell holding a control drops its vertical padding and caps the control at the row', () => {
    expect(css).toMatch(/:has\(>[^)]*\.btn[^{]*\{[^}]*padding-block:\s*0/);
    expect(css).toMatch(/max-height:\s*var\(--t-row-h\)/);
  });

  it('K-18: a figure never wraps and keeps a minimum width', () => {
    const money = /\.data-table :is\(td, th\)\.t-num\s*\{([^}]*)\}/.exec(css);
    expect(money).not.toBeNull();
    expect(money![1]).toMatch(/white-space:\s*nowrap/);
    expect(money![1]).toMatch(/min-width:\s*10ch/);
  });

  it('K-23: heads are 12px, weight 500, dim, and never case-transformed', () => {
    const head = /\.data-table thead th\s*\{([^}]*)\}/.exec(css);
    expect(head).not.toBeNull();
    expect(head![1]).toMatch(/font-size:\s*var\(--t-font-sm\)/);
    expect(head![1]).toMatch(/font-weight:\s*500/);
    expect(head![1]).toMatch(/color:\s*var\(--t-text-dim\)/);
    expect(css).not.toMatch(/text-transform/);
  });

  it('K-23: nothing in the table is bold and dim at once', () => {
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)];
    const boldDim = rules.filter(
      ([, , body]) => /font-weight:\s*(600|700)/.test(body ?? '') && /color:\s*var\(--t-text-dim\)/.test(body ?? ''),
    );
    expect(boldDim.map(([, selector]) => selector?.trim())).toEqual([]);
  });

  it('K-10: the borderless controls carry a transparent border for the focus cue', () => {
    for (const selector of ['.data-table-sort', '.data-table-group-toggle', '.data-table-open']) {
      const rule = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{[^}]*border:\\s*1px solid transparent`);
      expect(css).toMatch(rule);
    }
  });

  it('K-10: a focused row draws a brass line round the whole row, never a side bar', () => {
    expect(css).toMatch(/\.data-table-row--clickable:focus-visible > :first-child:last-child\s*\{[^}]*inset 0 0 0 1px var\(--t-focus-border\)/);
    expect(css).not.toMatch(/inset\s+\d+px\s+0\s+0\s+var\(--t-accent\)/);
  });

  it('K-41: hover moves colour only, on the hover beat, and no local reduced-motion block remains', () => {
    expect(css).toMatch(/transition:\s*background-color var\(--t-motion-hover\)/);
    expect(css).not.toMatch(/transition:\s*all/);
    expect(css).not.toMatch(/prefers-reduced-motion/);
    expect(css).not.toMatch(/\d+(?:\.\d+)?m?s\s+ease\b/);
  });

  it('K-37: no raw font-size, line-height, radius or z-index literal', () => {
    const decls = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(decls).not.toMatch(/font-size:\s*\d/);
    expect(decls).not.toMatch(/line-height:\s*\d/);
    expect(decls).not.toMatch(/border-radius:\s*\d/);
    expect(decls).not.toMatch(/z-index:\s*\d/);
  });
});
