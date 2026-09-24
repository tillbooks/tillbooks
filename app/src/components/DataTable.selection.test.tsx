/**
 * THE SELECTION GUARD (K-14, K-24, D137): a selected row is the pill on EVERY cell, never a bar.
 *
 * WHAT WENT WRONG. The design law retired the accent bar on the side of a selected row, and it came
 * back through two properties the old guard did not read: `box-shadow: inset 3px 0 0 <accent>` on the
 * warehouse and goods-receipt rows, `border-bottom-color: <accent>` on a contacts tab. And the one
 * surface that did paint the tint (Kontakte) tinted seven of eight cells: its rule said `td`, and the
 * name cell is the row header, a `<th>`. A hole in the middle of the selection.
 *
 * WHAT THIS HOLDS.
 *   - DataTable owns selection: `selection` (a checkbox column) and `isRowCurrent` (the one row a
 *     detail pane shows) stamp `data-selected` on the row and `data-lead` on its leading cell, and the
 *     stylesheet tints `td` AND `th` of such a row, with the accent ink on the leading cell only.
 *   - The checkbox is a real, named checkbox inside a `.check-cell` label (the dense-band target),
 *     its press never opens the row, a blocked row's box is disabled, and select-all reads checked,
 *     mixed or clear.
 *   - DataTable.css paints no bar: no inset side shadow in an accent or status colour, no accent side
 *     border.
 *   - A RATCHET over the Studio: the side bars still standing in surface CSS may only go down. The
 *     surfaces that migrate onto `selection`/`isRowCurrent` lower it; it never rises.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { ThemeProvider, type Theme } from '../app/theme';
import { I18nProvider } from '../i18n';
import { DataTable, type DataTableColumn, type DataTableSelection } from './DataTable';

interface Contact {
  id: string;
  name: string;
  city: string;
  blocked?: boolean;
}

const CONTACTS: Contact[] = [
  { id: 'c1', name: 'Muster AG', city: 'Männedorf' },
  { id: 'c2', name: 'Beispiel GmbH', city: 'Zürich' },
  { id: 'c3', name: 'Gesperrt AG', city: 'Bern', blocked: true },
];

const COLUMNS: DataTableColumn<Contact>[] = [
  { key: 'name', header: 'Name', render: (c) => c.name },
  { key: 'city', header: 'Ort', render: (c) => c.city },
];

function Host({
  theme = 'light',
  initial = [],
  withAll = true,
  onRowClick,
  current,
}: {
  theme?: Theme;
  initial?: string[];
  withAll?: boolean;
  onRowClick?: (c: Contact) => void;
  current?: string;
}) {
  const [selected, setSelected] = useState<string[]>(initial);
  const selection: DataTableSelection<Contact> = {
    isSelected: (c) => selected.includes(c.id),
    onToggle: (c) =>
      setSelected((prev) => (prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id])),
    label: (c) => `${c.name} auswählen`,
    isDisabled: (c) => c.blocked === true,
    allLabel: 'Alle auswählen',
    onToggleAll: withAll
      ? (next) => setSelected(next ? CONTACTS.filter((c) => !c.blocked).map((c) => c.id) : [])
      : undefined,
  };
  return (
    <ThemeProvider initialTheme={theme}>
      <I18nProvider>
        <MemoryRouter>
          <DataTable<Contact>
            columns={COLUMNS}
            rows={CONTACTS}
            rowKey={(c) => c.id}
            caption="Kontakte"
            selection={selection}
            onRowClick={onRowClick}
            rowLabel={(c) => `Kontakt ${c.name}`}
            isRowCurrent={current !== undefined ? (c) => c.id === current : undefined}
          />
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>
  );
}

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest('tr') as HTMLElement;
}

describe('DataTable selection, the checkbox column (K-14)', () => {
  it('puts a real, named checkbox in a .check-cell label at the start of every row', () => {
    render(<Host />);
    const box = screen.getByRole('checkbox', { name: 'Muster AG auswählen' });
    expect(box).toHaveAttribute('type', 'checkbox');
    expect(box.closest('label')).toHaveClass('check-cell');
    expect(box.closest('td')).toHaveClass('data-table-check');
    // The checkbox cell leads the row; the row header stays the identifying column.
    const row = rowOf('Muster AG');
    expect(row.firstElementChild).toBe(box.closest('td'));
    expect(screen.getByText('Muster AG').closest('th')).toHaveAttribute('scope', 'row');
  });

  it('toggles a row, and the row takes the selected treatment', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Beispiel GmbH auswählen' }));
    expect(screen.getByRole('checkbox', { name: 'Beispiel GmbH auswählen' })).toBeChecked();
    expect(rowOf('Beispiel GmbH')).toHaveAttribute('data-selected');
    expect(rowOf('Muster AG')).not.toHaveAttribute('data-selected');
  });

  it('a press on the checkbox never also opens the row', async () => {
    const onRowClick = vi.fn();
    render(<Host onRowClick={onRowClick} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Muster AG auswählen' }));
    expect(onRowClick).not.toHaveBeenCalled();
    // A press elsewhere on the row still opens it.
    await userEvent.click(screen.getByText('Männedorf'));
    expect(onRowClick).toHaveBeenCalledWith(CONTACTS[0]);
  });

  it('a blocked row has a disabled checkbox', () => {
    render(<Host />);
    expect(screen.getByRole('checkbox', { name: 'Gesperrt AG auswählen' })).toBeDisabled();
  });

  it('select-all reads clear, mixed and checked, and selects every selectable row', async () => {
    render(<Host initial={['c1']} />);
    const all = screen.getByRole('checkbox', { name: 'Alle auswählen' }) as HTMLInputElement;
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);

    await userEvent.click(all);
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);
    expect(screen.getByRole('checkbox', { name: 'Beispiel GmbH auswählen' })).toBeChecked();
    // The blocked row is not selectable, so "all" means all that can be.
    expect(screen.getByRole('checkbox', { name: 'Gesperrt AG auswählen' })).not.toBeChecked();

    await userEvent.click(all);
    expect(all.checked).toBe(false);
    expect(screen.getByRole('checkbox', { name: 'Muster AG auswählen' })).not.toBeChecked();
  });

  it('without onToggleAll the header cell names the column for assistive tech', () => {
    render(<Host withAll={false} />);
    expect(screen.queryByRole('checkbox', { name: 'Alle auswählen' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Alle auswählen' })).toBeInTheDocument();
  });
});

describe('DataTable selection, the pill on every cell (K-24)', () => {
  it('stamps the selected row and marks exactly one leading cell, the row header', () => {
    render(<Host initial={['c2']} />);
    const row = rowOf('Beispiel GmbH');
    expect(row).toHaveAttribute('data-selected');
    const leads = row.querySelectorAll('[data-lead]');
    expect(leads).toHaveLength(1);
    expect(leads[0]?.tagName).toBe('TH');
    // No ARIA state on a plain table row: the checkbox carries "selected" for assistive tech.
    expect(row).not.toHaveAttribute('aria-selected');
  });

  it('the current row (a detail pane) wears the same pill and reports aria-current', () => {
    render(<Host current="c1" />);
    const row = rowOf('Muster AG');
    expect(row).toHaveAttribute('data-selected');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(rowOf('Beispiel GmbH')).not.toHaveAttribute('aria-current');
  });

  it.each(['light', 'dark'] as const)('has no axe violations with rows selected, %s theme', async (theme) => {
    const { container } = render(<Host theme={theme} initial={['c1']} current="c2" />);
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});

describe('DataTable selection, the stylesheet', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/components/DataTable.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  it('tints BOTH td and th of a selected row with the accent-soft pill', () => {
    const tint = /\.data-table \.data-table-row\[data-selected\] > :is\(td, th\)\s*\{([^}]*)\}/.exec(css);
    expect(tint).not.toBeNull();
    expect(tint![1]).toMatch(/background:\s*var\(--t-accent-soft\)/);
  });

  it('puts the accent ink on the leading cell only', () => {
    expect(css).toMatch(/\.data-table-row\[data-selected\] > \[data-lead\][^{]*\{[^}]*color:\s*var\(--t-accent\)/);
  });

  it('outranks the hover fill, so a selected row keeps its tint under the pointer', () => {
    // (0,3,1) for the selection against (0,2,1) for the hover: the extra `.data-table` qualifier.
    expect(css).toMatch(/\.data-table-row--clickable:hover > :is\(td, th\)/);
    expect(css).toMatch(/\.data-table \.data-table-row\[data-selected\] > :is\(td, th\)/);
  });

  it('draws no side bar: no inset side shadow in a signal colour, no accent side border', () => {
    expect(css).not.toMatch(/box-shadow:[^;]*inset\s+-?\d+px\s+0\s+0\s+var\(--t-(accent|warn|danger|success)/);
    expect(css).not.toMatch(/border-(left|right|bottom)(-color)?:[^;]*var\(--t-accent/);
  });
});

describe('DataTable selection, the Studio-wide ratchet on side bars', () => {
  // A surface stylesheet that paints a selected or focused row with a side bar: an inset side shadow
  // in the accent or a status colour, or an accent side border. The ceiling is the count measured when
  // this guard landed (23.09.2026, 8 declarations in Periods, Warehouses, Purchasing, Contacts,
  // VatReturn and GoodsReceipt). Migrating a surface onto `selection` / `isRowCurrent` removes its
  // bar; lower the ceiling in the same commit. It never rises. Round 2 Part D (24.09.2026) took it
  // from 8 to 1 (the one left is the VatReturn warn border).
  const CEILING = 1;
  const SIDE_BAR =
    /box-shadow:[^;]*inset\s+-?\d+px\s+0\s+0\s+var\(--t-(?:accent|warn|danger|success)|border-(?:left|right|bottom)(?:-color)?:[^;]*var\(--t-(?:accent|warn)/g;

  function cssFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...cssFiles(path));
      else if (entry.name.endsWith('.css')) out.push(path);
    }
    return out.sort();
  }

  it(`holds the side bars in Studio CSS at or below ${CEILING}`, () => {
    const hits = cssFiles(resolve(process.cwd(), 'src')).flatMap((path) => {
      const source = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      return [...source.matchAll(SIDE_BAR)].map((m) => `${path.split('/src/')[1]}: ${m[0]}`);
    });
    expect(hits.length, hits.join('\n')).toBeLessThanOrEqual(CEILING);
    // The shared components carry none at all.
    expect(hits.filter((hit) => hit.startsWith('components/'))).toEqual([]);
  });
});
