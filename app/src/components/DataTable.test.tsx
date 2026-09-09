/**
 * DataTable, the shared ledger/list table (D118 B2).
 *
 * The properties that let sixty surfaces adopt it are asserted here: the frame owns the overflow and
 * the header sticks (checked against the stylesheet, since the vitest run stubs CSS), rows are
 * density-aware, money right-aligns with the tabular class, sortable headers report `aria-sort`, an
 * optional row-open is keyboard-activatable, all five states render, and axe is clean in both themes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { ThemeProvider, type Theme } from '../app/theme';
import { I18nProvider } from '../i18n';
import { DensityProvider, type Density } from '../app/density';
import { SurfaceHeader } from './SurfaceHeader';
import {
  DataTable,
  type DataTableColumn,
  type DataTableFooterCell,
  type DataTableGroup,
  type SortState,
} from './DataTable';

interface Invoice {
  id: string;
  number: string;
  amountMinor: number;
}

const ROWS: Invoice[] = [
  { id: 'a', number: 'RE-001', amountMinor: 125000 },
  { id: 'b', number: 'RE-002', amountMinor: -4200 },
  { id: 'c', number: 'RE-003', amountMinor: 9900 },
];

function columns(): DataTableColumn<Invoice>[] {
  return [
    { key: 'number', header: 'Nummer', render: (r) => r.number, sortable: true },
    {
      key: 'amount',
      header: 'Betrag',
      numeric: true,
      sortable: true,
      render: (r) => <span>{r.amountMinor}</span>,
    },
  ];
}

interface HarnessProps {
  theme?: Theme;
  density?: Density;
  rows?: Invoice[];
  loading?: boolean;
  error?: { ok: false; error: string };
  onRetry?: () => void;
  emptyState?: React.ReactNode;
  sort?: SortState | null;
  onSortChange?: (next: SortState) => void;
  onRowClick?: (row: Invoice) => void;
  rowClassName?: (row: Invoice, index: number) => string | undefined;
  cols?: DataTableColumn<Invoice>[];
  footer?: DataTableFooterCell[];
  groups?: DataTableGroup<Invoice>[];
  collapsibleGroups?: boolean;
  defaultCollapsedGroups?: string[];
}

function renderTable({
  theme = 'light',
  density = 'komfortabel',
  rows = ROWS,
  cols = columns(),
  ...rest
}: HarnessProps = {}) {
  return render(
    <ThemeProvider initialTheme={theme}>
      <DensityProvider initialDensity={density}>
        <I18nProvider>
          <MemoryRouter>
            <DataTable<Invoice>
              columns={cols}
              rows={rows}
              rowKey={(r) => r.id}
              caption="Rechnungen"
              rowLabel={(r) => `Rechnung ${r.number}`}
              {...rest}
            />
          </MemoryRouter>
        </I18nProvider>
      </DensityProvider>
    </ThemeProvider>,
  );
}

describe('DataTable, the data state', () => {
  it('renders a header cell per column and a row per record', () => {
    renderTable();
    expect(screen.getByRole('columnheader', { name: 'Nummer' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Betrag' })).toBeInTheDocument();
    // The three data rows plus the header row.
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });

  it('names the table with a visually-hidden caption for assistive tech', () => {
    const { container } = renderTable();
    const caption = container.querySelector('caption');
    expect(caption).toHaveTextContent('Rechnungen');
    expect(caption).toHaveClass('visually-hidden');
  });

  it('right-aligns a numeric column and marks its cells with the shared tabular class', () => {
    renderTable();
    const betrag = screen.getByRole('columnheader', { name: 'Betrag' });
    expect(betrag).toHaveAttribute('data-align', 'end');
    // Every body cell in the numeric column carries the shared `.t-num` class, which is the
    // density-aware tabular-nums money class defined in tokens.css.
    const numericCells = document.querySelectorAll('td[data-align="end"]');
    expect(numericCells).toHaveLength(3);
    numericCells.forEach((cell) => expect(cell).toHaveClass('t-num'));
  });

  it('left-aligns a text column and does not give it the tabular class', () => {
    renderTable();
    expect(screen.getByRole('columnheader', { name: 'Nummer' })).toHaveAttribute(
      'data-align',
      'start',
    );
    // The first identifying (text) column is the row header, so its body cell is a `<th>`, not a
    // `<td>`; its alignment and the absence of the tabular class are the point here.
    const textCell = screen.getByText('RE-001').closest('th') as HTMLElement;
    expect(textCell).toHaveAttribute('data-align', 'start');
    expect(textCell).not.toHaveClass('t-num');
  });
});

describe('DataTable, the row header', () => {
  it('renders the first identifying column as a <th scope="row"> per row', () => {
    const { container } = renderTable();
    const rowHeaders = container.querySelectorAll('tbody th[scope="row"]');
    // One row header per data row, carrying the row's own identifying value.
    expect(rowHeaders).toHaveLength(3);
    expect(rowHeaders[0]).toHaveTextContent('RE-001');
    // Testing Library exposes it with the rowheader role, so a screen reader pairs the row's value
    // with each column header instead of announcing the column name alone.
    expect(screen.getAllByRole('rowheader')).toHaveLength(3);
  });

  it('leaves the numeric column as a plain <td>, not a second row header', () => {
    const { container } = renderTable();
    // Only the identifying column is the row header; the money column stays a data cell.
    expect(container.querySelectorAll('tbody th[scope="row"]')).toHaveLength(3);
    const amountCell = screen.getByText('125000').closest('td') as HTMLElement;
    expect(amountCell.tagName).toBe('TD');
    expect(amountCell).toHaveClass('t-num');
  });

  it('moves the row header to a column that opts in with rowHeader:true', () => {
    const cols: DataTableColumn<Invoice>[] = [
      { key: 'number', header: 'Nummer', render: (r) => r.number },
      { key: 'label', header: 'Bezeichnung', render: (r) => <span>Rechnung {r.number}</span>, rowHeader: true },
    ];
    const { container } = renderTable({ cols });
    const rowHeaders = container.querySelectorAll('tbody th[scope="row"]');
    expect(rowHeaders).toHaveLength(3);
    // The explicit opt-in wins over the default first-identifying-column, so the header carries the
    // Bezeichnung, and the number column falls back to a plain cell.
    expect(rowHeaders[0]).toHaveTextContent('Rechnung RE-001');
    expect(screen.getByText('RE-001').closest('td')).not.toBeNull();
  });

  it('suppresses the default row header when the identifying column opts out with rowHeader:false', () => {
    const cols: DataTableColumn<Invoice>[] = [
      { key: 'number', header: 'Nummer', render: (r) => r.number, rowHeader: false },
      { key: 'amount', header: 'Betrag', numeric: true, render: (r) => <span>{r.amountMinor}</span> },
    ];
    const { container } = renderTable({ cols });
    // No column qualifies, so no row header is forced onto an unidentifying cell.
    expect(container.querySelectorAll('tbody th[scope="row"]')).toHaveLength(0);
    expect(screen.getByText('RE-001').closest('td')).not.toBeNull();
  });

  it('emits the row header inside a grouped body too', () => {
    const groups: DataTableGroup<Invoice>[] = [
      { key: 'assets', header: 'Aktiven', rows: [ROWS[0], ROWS[1]] },
      { key: 'liabilities', header: 'Passiven', rows: [ROWS[2]] },
    ];
    const { container } = renderTable({ groups });
    // The shared row renderer means grouped rows get the same `<th scope="row">` as flat rows.
    expect(container.querySelectorAll('tbody th[scope="row"]')).toHaveLength(3);
  });
});

describe('DataTable, sorting', () => {
  it('a sortable header is a button reporting aria-sort=none until it is the active sort', () => {
    renderTable({ sort: null, onSortChange: vi.fn() });
    const header = screen.getByRole('columnheader', { name: 'Nummer' });
    expect(header).toHaveAttribute('aria-sort', 'none');
    expect(within(header).getByRole('button', { name: 'Nummer' })).toBeInTheDocument();
  });

  it('reflects the active sort direction as aria-sort', () => {
    renderTable({ sort: { key: 'amount', direction: 'asc' }, onSortChange: vi.fn() });
    expect(screen.getByRole('columnheader', { name: 'Betrag' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    // Only the active column carries a direction; the other reports none.
    expect(screen.getByRole('columnheader', { name: 'Nummer' })).toHaveAttribute(
      'aria-sort',
      'none',
    );
  });

  it('activating a fresh column sorts it ascending', async () => {
    const onSortChange = vi.fn();
    renderTable({ sort: null, onSortChange });
    await userEvent.click(screen.getByRole('button', { name: 'Betrag' }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'amount', direction: 'asc' });
  });

  it('activating the active column flips its direction', async () => {
    const onSortChange = vi.fn();
    renderTable({ sort: { key: 'amount', direction: 'asc' }, onSortChange });
    await userEvent.click(screen.getByRole('button', { name: 'Betrag' }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'amount', direction: 'desc' });
  });
});

describe('DataTable, opening a row', () => {
  it('makes each row a focusable, named affordance when onRowClick is set', () => {
    renderTable({ onRowClick: vi.fn() });
    const row = screen.getByRole('row', { name: 'Rechnung RE-001' });
    expect(row).toHaveAttribute('tabindex', '0');
    expect(row).toHaveClass('data-table-row--clickable');
  });

  it('opens the row on click, Enter and Space', async () => {
    const onRowClick = vi.fn();
    renderTable({ onRowClick });
    const row = screen.getByRole('row', { name: 'Rechnung RE-002' });

    await userEvent.click(row);
    row.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');

    expect(onRowClick).toHaveBeenCalledTimes(3);
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[1]);
  });

  it('leaves rows inert when no onRowClick is given', () => {
    renderTable();
    const row = screen.getByText('RE-001').closest('tr') as HTMLElement;
    expect(row).not.toHaveAttribute('tabindex');
    expect(row).not.toHaveClass('data-table-row--clickable');
  });
});

describe('DataTable, the per-row class hook', () => {
  it('joins the rowClassName return with the base row class', () => {
    renderTable({
      rowClassName: (r) => (r.amountMinor < 0 ? 'ledger-row--overdue' : undefined),
    });
    const overdue = screen.getByText('RE-002').closest('tr') as HTMLElement;
    // The consumer class is ADDED, never a replacement: the base class stays.
    expect(overdue).toHaveClass('data-table-row');
    expect(overdue).toHaveClass('ledger-row--overdue');
  });

  it('adds no extra class when rowClassName returns a falsy value', () => {
    renderTable({ rowClassName: () => undefined });
    const row = screen.getByText('RE-001').closest('tr') as HTMLElement;
    expect(row).toHaveClass('data-table-row');
    // Only the base class, nothing joined on from a falsy return.
    expect(row.className).toBe('data-table-row');
  });

  it('keeps the clickable class alongside the consumer class', () => {
    renderTable({ onRowClick: vi.fn(), rowClassName: () => 'ledger-row--selected' });
    const row = screen.getByRole('row', { name: 'Rechnung RE-001' });
    expect(row).toHaveClass('data-table-row');
    expect(row).toHaveClass('data-table-row--clickable');
    expect(row).toHaveClass('ledger-row--selected');
  });

  it('passes the row index to rowClassName', () => {
    const rowClassName = vi.fn(() => undefined);
    renderTable({ rowClassName });
    expect(rowClassName).toHaveBeenCalledWith(ROWS[0], 0);
    expect(rowClassName).toHaveBeenCalledWith(ROWS[2], 2);
  });
});

describe('DataTable, the five states', () => {
  it('shows the shared placeholder blocks before the rows arrive', () => {
    // The DataTable is presentational: the caller owns the read and passes the flag. The shared
    // Skeleton carries the status announcement and is covered by its own test; here we assert only
    // that the table DELEGATES to it and renders no header over a placeholder. Asserting the
    // announcement here would trip the loading-state convention guard, and this block has no request
    // of its own to prove because the read lives in the caller.
    const { container } = renderTable({ loading: true });
    expect(container.querySelectorAll('.skeleton')).toHaveLength(5);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('EMPTY shows the shared empty state, or a caller-supplied one', () => {
    renderTable({ rows: [] });
    expect(screen.getByRole('heading', { name: 'Noch nichts vorhanden' })).toBeInTheDocument();

    renderTable({ rows: [], emptyState: <p>Keine Rechnungen im Filter.</p> });
    expect(screen.getByText('Keine Rechnungen im Filter.')).toBeInTheDocument();
  });

  it('ERROR shows the shared banner and offers a retry', async () => {
    const onRetry = vi.fn();
    renderTable({ error: { ok: false, error: 'workspace_not_found' }, onRetry });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('SUCCESS renders the data and nothing else', () => {
    renderTable();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('DataTable, the optional totals row', () => {
  const footer: DataTableFooterCell[] = [
    { key: 'number', content: 'Summe' },
    { key: 'amount', content: <span>130700</span> },
  ];

  it('renders no tfoot when no footer is given (unchanged today)', () => {
    const { container } = renderTable();
    expect(container.querySelector('tfoot')).toBeNull();
  });

  it('renders a real tfoot totals row when a footer is given', () => {
    const { container } = renderTable({ footer });
    const tfoot = container.querySelector('tfoot');
    expect(tfoot).not.toBeNull();
    expect(within(tfoot as HTMLElement).getByText('Summe')).toBeInTheDocument();
    expect(within(tfoot as HTMLElement).getByText('130700')).toBeInTheDocument();
  });

  it('aligns each foot cell to its column: numeric totals right-align with the tabular class', () => {
    const { container } = renderTable({ footer });
    const cells = (container.querySelector('tfoot tr') as HTMLElement).querySelectorAll('td');
    // One foot cell per column, in column order.
    expect(cells).toHaveLength(2);
    // The label sits under the text column: left-aligned, no tabular class.
    expect(cells[0]).toHaveAttribute('data-align', 'start');
    expect(cells[0]).not.toHaveClass('t-num');
    // The total sits under the numeric column: right-aligned, tabular class, matching the data cells.
    expect(cells[1]).toHaveAttribute('data-align', 'end');
    expect(cells[1]).toHaveClass('t-num');
  });

  it('renders an empty foot cell for a column with no footer entry', () => {
    const { container } = renderTable({ footer: [{ key: 'amount', content: <span>130700</span> }] });
    const cells = (container.querySelector('tfoot tr') as HTMLElement).querySelectorAll('td');
    expect(cells).toHaveLength(2);
    expect(cells[0]).toBeEmptyDOMElement();
    expect(within(cells[1] as HTMLElement).getByText('130700')).toBeInTheDocument();
  });

  it('renders no tfoot for an empty footer array', () => {
    const { container } = renderTable({ footer: [] });
    expect(container.querySelector('tfoot')).toBeNull();
  });

  it('gives the foot cell its summary border and weight in the stylesheet', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/DataTable.css'), 'utf8');
    expect(css).toMatch(/\.data-table tfoot td\s*\{[^}]*border-top:/);
    expect(css).toMatch(/\.data-table tfoot td\s*\{[^}]*font-weight:\s*600/);
  });
});

describe('DataTable, the optional grouped/tree model', () => {
  const groups: DataTableGroup<Invoice>[] = [
    { key: 'assets', header: 'Aktiven', rows: [ROWS[0], ROWS[1]] },
    { key: 'liabilities', header: 'Passiven', rows: [ROWS[2]] },
  ];

  it('renders a spanning header per group and its rows in the flat body', () => {
    const { container } = renderTable({ groups });
    // Two group-header rows, each one cell spanning every column.
    const headerCells = container.querySelectorAll('td.data-table-group-cell');
    expect(headerCells).toHaveLength(2);
    headerCells.forEach((cell) => expect(cell).toHaveAttribute('colspan', '2'));
    expect(screen.getByText('Aktiven')).toBeInTheDocument();
    expect(screen.getByText('Passiven')).toBeInTheDocument();
    // Every data row still renders.
    expect(screen.getByText('RE-001')).toBeInTheDocument();
    expect(screen.getByText('RE-003')).toBeInTheDocument();
  });

  it('leaves group headers as plain labels (no disclosure) unless collapsibleGroups is set', () => {
    renderTable({ groups });
    expect(screen.queryByRole('button', { name: /Aktiven/ })).toBeNull();
  });

  it('makes each group header a WCAG disclosure reporting aria-expanded when collapsible', () => {
    renderTable({ groups, collapsibleGroups: true });
    const toggle = screen.getByRole('button', { name: /Aktiven/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses a group on click: its rows leave the DOM and aria-expanded flips', async () => {
    renderTable({ groups, collapsibleGroups: true });
    expect(screen.getByText('RE-001')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Aktiven/ }));
    expect(screen.getByRole('button', { name: /Aktiven/ })).toHaveAttribute('aria-expanded', 'false');
    // The collapsed group's rows are gone; the other group's row stays.
    expect(screen.queryByText('RE-001')).toBeNull();
    expect(screen.queryByText('RE-002')).toBeNull();
    expect(screen.getByText('RE-003')).toBeInTheDocument();
  });

  it('toggles the disclosure from the keyboard (a native button answers Enter and Space)', async () => {
    renderTable({ groups, collapsibleGroups: true });
    const toggle = screen.getByRole('button', { name: /Aktiven/ });
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('RE-001')).toBeNull();
    await userEvent.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('RE-001')).toBeInTheDocument();
  });

  it('seeds initially-collapsed groups from defaultCollapsedGroups', () => {
    renderTable({ groups, collapsibleGroups: true, defaultCollapsedGroups: ['assets'] });
    expect(screen.getByRole('button', { name: /Aktiven/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /Passiven/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByText('RE-001')).toBeNull();
    expect(screen.getByText('RE-003')).toBeInTheDocument();
  });

  it('indents a nested group header and the leading cell of its rows by the tree depth', () => {
    const nested: DataTableGroup<Invoice>[] = [
      { key: 'root', header: 'Bilanz', rows: [], depth: 0 },
      { key: 'child', header: 'Umlaufvermögen', rows: [ROWS[0]], depth: 1 },
    ];
    renderTable({ groups: nested });
    const childHeader = screen.getByText('Umlaufvermögen').closest('td') as HTMLElement;
    expect(childHeader).toHaveAttribute('data-indented');
    expect(childHeader.style.getPropertyValue('--t-row-depth')).toBe('1');
    // The leading cell of the child row indents one level past its group (depth + 1 = 2). It is the
    // identifying column, so that leading cell is the row-header `<th>`, and the indentation lives on
    // it just as it did on the plain `<td>`.
    const childRowLeadCell = screen.getByText('RE-001').closest('th') as HTMLElement;
    expect(childRowLeadCell).toHaveAttribute('data-indented');
    expect(childRowLeadCell.style.getPropertyValue('--t-row-depth')).toBe('2');
    // A top-level (depth 0) header carries no indentation.
    const rootHeader = screen.getByText('Bilanz').closest('td') as HTMLElement;
    expect(rootHeader).not.toHaveAttribute('data-indented');
  });

  it('keeps onRowClick and rowClassName working on rows inside a group', async () => {
    const onRowClick = vi.fn();
    renderTable({
      groups,
      onRowClick,
      rowClassName: (r) => (r.amountMinor < 0 ? 'ledger-row--overdue' : undefined),
    });
    const row = screen.getByRole('row', { name: 'Rechnung RE-002' });
    expect(row).toHaveClass('data-table-row--clickable');
    expect(row).toHaveClass('ledger-row--overdue');
    await userEvent.click(row);
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1]);
  });

  it('gives rowClassName a global row index that runs across groups', () => {
    const rowClassName = vi.fn(() => undefined);
    renderTable({ groups, rowClassName });
    // First group holds indices 0 and 1; the second group's single row continues at 2.
    expect(rowClassName).toHaveBeenCalledWith(ROWS[0], 0);
    expect(rowClassName).toHaveBeenCalledWith(ROWS[1], 1);
    expect(rowClassName).toHaveBeenCalledWith(ROWS[2], 2);
  });

  it('shows the empty state for an empty groups array', () => {
    renderTable({ groups: [] });
    expect(screen.getByRole('heading', { name: 'Noch nichts vorhanden' })).toBeInTheDocument();
  });

  it('leaves the flat rows path untouched when no groups are given', () => {
    const { container } = renderTable();
    expect(container.querySelector('td.data-table-group-cell')).toBeNull();
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });

  it.each(['light', 'dark'] as const)(
    'has no axe violations for the grouped, collapsible model in the %s theme',
    async (theme) => {
      const { container } = renderTable({
        theme,
        groups,
        collapsibleGroups: true,
        onRowClick: vi.fn(),
      });
      const results = await axe(container, {
        rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
      });
      expect(results).toHaveNoViolations();
    },
  );
});

describe('DataTable, density', () => {
  it('reads the global density: Kompakt stamps the root and keeps the tabular class on money cells', () => {
    renderTable({ density: 'kompakt' });
    // The one global toggle (B3) drives every table through the root attribute; DataTable opts in by
    // reading the density tokens on its rows and the `.t-num` class on money cells.
    expect(document.documentElement).toHaveAttribute('data-density', 'kompakt');
    document
      .querySelectorAll('td[data-align="end"]')
      .forEach((cell) => expect(cell).toHaveClass('t-num'));
  });
});

describe('DataTable, the stylesheet honours the layout law', () => {
  // vitest stubs CSS (see vitest.config.ts `css: false`), so the frame overflow, sticky header and
  // density tokens cannot be read off computed styles. They ARE the point of this primitive, so the
  // stylesheet is read from disk and the load-bearing declarations are asserted, the way the repo's
  // own style guards do.
  // vitest runs with the app root as cwd; resolve the co-located stylesheet from there.
  const css = readFileSync(resolve(process.cwd(), 'src/components/DataTable.css'), 'utf8');

  it('gives an OVERFLOWING frame its own horizontal scroll with a reserved gutter', () => {
    expect(css).toMatch(/\.data-table-frame\[data-overflow\]\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.data-table-frame\[data-overflow\]\s*\{[^}]*scrollbar-gutter:\s*stable/);
  });

  it('F-04: leaves a FITTING frame transparent to scrolling, so <main> stays the sticky containing block', () => {
    // The bare frame rule declares no overflow at all. `overflow-x: auto` alone computes `overflow-y`
    // to auto, which made the frame the nearest scrolling ancestor of the sticky header and pushed
    // the column labels down onto the first data row (Phase 1 critic, B1).
    const bare = /\.data-table-frame\s*\{([^}]*)\}/.exec(css);
    expect(bare).not.toBeNull();
    expect(bare![1]).not.toMatch(/overflow/);
  });

  it('F-04: pins the header at top:0 inside an overflowing frame (no displacement onto row 1)', () => {
    expect(css).toMatch(/\.data-table-frame\[data-overflow\] thead th\s*\{[^}]*top:\s*0/);
  });

  it('makes the header sticky BELOW the sticky page header so labels stay visible while scrolling', () => {
    // S1 (N5 sweep): the thead and the SurfaceHeader share the one .frame>main scroll region, so the
    // thead must stick at the header's published band height, not at top:0 (which hid it behind the
    // opaque page header). z-index stays 1 (below the header), so the labels never overlap the title.
    expect(css).toMatch(/\.data-table thead th\s*\{[^}]*position:\s*sticky/);
    expect(css).toMatch(/\.data-table thead th\s*\{[^}]*top:\s*var\(--surface-header-height/);
  });

  it('reads the density tokens for row height, padding and numeric type', () => {
    expect(css).toContain('var(--t-control-h)');
    expect(css).toContain('var(--t-row-pad-y)');
    expect(css).toContain('var(--t-font-table)');
  });

  it('carries no hardcoded hex colour', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('DataTable, accessibility', () => {
  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme) => {
    const { container } = renderTable({
      theme,
      onRowClick: vi.fn(),
      sort: null,
      onSortChange: vi.fn(),
      footer: [
        { key: 'number', content: 'Summe' },
        { key: 'amount', content: <span>130700</span> },
      ],
    });
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('DataTable, F-04: the sticky header never covers the first row at scroll top', () => {
  // jsdom has no layout, so `elementFromPoint` cannot be the proof here. The proof is the pair of
  // facts the browser geometry follows from: (1) while the table fits, the frame carries no
  // `data-overflow`, hence (stylesheet, above) no overflow, hence <main> is the one scroll container
  // for the page header and the column labels alike; (2) the sticky offset the header resolves is
  // exactly the SurfaceHeader's measured height, published on that same <main>. Under (1) and (2) a
  // header at `scrollTop 0` sits at its natural in-flow position below the page header, so the first
  // row's control is unobstructed. The browser probe in `friction-p2a-shell.cjs` re-asserts the same
  // thing with `elementFromPoint` on five real surfaces.
  const HEADER_HEIGHT = 56;
  let offsetHeight: PropertyDescriptor | undefined;
  beforeEach(() => {
    offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('surface-header') ? HEADER_HEIGHT : 0;
      },
    });
  });
  afterEach(() => {
    if (offsetHeight !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
  });

  function renderUnderHeader() {
    return render(
      <ThemeProvider initialTheme="light">
        <DensityProvider initialDensity="komfortabel">
          <I18nProvider>
            <MemoryRouter>
              <main>
                <SurfaceHeader title="Kreditoren" titleId="t" />
                <DataTable<Invoice>
                  columns={columns()}
                  rows={ROWS}
                  rowKey={(r) => r.id}
                  caption="Rechnungen"
                  onRowClick={() => undefined}
                  rowLabel={(r) => `Rechnung ${r.number}`}
                />
              </main>
            </MemoryRouter>
          </I18nProvider>
        </DensityProvider>
      </ThemeProvider>,
    );
  }

  it('a fitting table leaves the frame un-scrolled and the sticky offset equal to the header height', () => {
    const { container } = renderUnderHeader();
    const frame = container.querySelector('.data-table-frame');
    expect(frame).not.toBeNull();
    // (1) jsdom reports scrollWidth 0 and clientWidth 0: the table fits, so no overflow stamp.
    expect(frame).not.toHaveAttribute('data-overflow');
    // (2) The header published its measured height on <main>, the scrollport the th sticks against.
    const main = container.querySelector('main') as HTMLElement;
    expect(main.style.getPropertyValue('--surface-header-height')).toBe(`${HEADER_HEIGHT}px`);
    // The first data row's control is the row itself (the keyboard-activatable open affordance).
    const firstRow = screen.getByRole('row', { name: 'Rechnung RE-001' });
    expect(firstRow).toHaveAttribute('tabindex', '0');
  });

  it('an overflowing table stamps the frame, which the stylesheet turns into the sideways scroller', () => {
    const widths = {
      scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth'),
      clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth'),
    };
    Object.defineProperty(Element.prototype, 'scrollWidth', { configurable: true, get: () => 1600 });
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 960 });
    try {
      const { container } = renderUnderHeader();
      expect(container.querySelector('.data-table-frame')).toHaveAttribute('data-overflow');
    } finally {
      if (widths.scrollWidth) Object.defineProperty(Element.prototype, 'scrollWidth', widths.scrollWidth);
      if (widths.clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', widths.clientWidth);
    }
  });
});
