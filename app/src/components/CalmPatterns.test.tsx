/**
 * D187, the owner's picks (09.11.2026): the shared pieces every swept page uses. Filter chips with
 * "+ Filter" (Listen A), the "N Hinweise" chip (Hinweise A), a setting row with its explanation and
 * "Standard" (Einstellungen A), a table row that opens in place (Arbeitsflächen B), and fields sized to
 * what they hold.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { I18nProvider } from '../i18n';
import { DataTable } from './DataTable';
import { Field } from './Field';
import { FilterBar, type FilterFacet } from './FilterBar';
import { HintsChip } from './HintsChip';
import { SettingGroup, SettingRow } from './SettingRow';

function wrap(ui: React.ReactNode) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

function Facets({ onStatus }: { onStatus?: (v: string | null) => void }) {
  const [status, setStatus] = useState<string | null>('open');
  const [archived, setArchived] = useState<string | null>(null);
  const facets: FilterFacet[] = [
    {
      key: 'status',
      label: 'Status',
      options: [
        { value: 'open', label: 'Offen' },
        { value: 'paid', label: 'Bezahlt' },
      ],
      value: status,
      onChange: (v) => {
        setStatus(v);
        onStatus?.(v);
      },
    },
    { key: 'archived', label: 'Archivierte', options: [{ value: '1', label: 'Archivierte' }], value: archived, onChange: setArchived },
  ];
  return <FilterBar searchValue="" onSearchChange={() => {}} searchLabel="Belege suchen" facets={facets} />;
}

describe('D187 calm patterns', () => {
  it('Listen A: a set facet is a chip with its value and a remove control; the rest sit under + Filter', async () => {
    const user = userEvent.setup();
    const onStatus = vi.fn();
    wrap(<Facets onStatus={onStatus} />);
    expect(screen.getByRole('button', { name: 'Status ändern' })).toHaveTextContent('Offen');
    await user.click(screen.getByRole('button', { name: 'Filter hinzufügen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Archivierte' }));
    expect(screen.queryByRole('button', { name: 'Filter hinzufügen' })).toBeNull();
    const removes = screen.getAllByRole('button', { name: 'Entfernen' });
    expect(removes).toHaveLength(2);
    await user.click(removes[0]!);
    expect(onStatus).toHaveBeenLastCalledWith(null);
    await user.click(screen.getByRole('button', { name: 'Filter hinzufügen' }));
    expect(screen.getByRole('menuitem', { name: 'Status: Bezahlt' })).toBeInTheDocument();
  });

  it('Hinweise A: the notices fold into one counted chip that opens on click and closes on Escape', async () => {
    const user = userEvent.setup();
    wrap(
      <HintsChip
        hints={[
          { key: 'a', title: 'Der MCP-Agent ist Eigentümer', body: 'Gib ihm eine engere Rolle.' },
          { key: 'b', title: 'Einladungen brauchen eine Online-Instanz' },
        ]}
      />,
    );
    const chip = screen.getByRole('button', { name: /2 Hinweise/ });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Gib ihm eine engere Rolle.')).not.toBeVisible();
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Gib ihm eine engere Rolle.')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
  });

  it('Einstellungen A: a row shows its explanation, and "Standard" only while the value is not the default', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    const { rerender } = wrap(
      <SettingGroup title="Darstellung">
        <SettingRow label="Farbschema" description="Hell, dunkel oder wie dein Gerät.">
          <span>control</span>
        </SettingRow>
      </SettingGroup>,
    );
    expect(screen.getByRole('heading', { name: 'Darstellung' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Farbschema' })).toHaveAccessibleDescription('Hell, dunkel oder wie dein Gerät.');
    expect(screen.queryByRole('button', { name: 'Standard' })).toBeNull();
    rerender(
      <I18nProvider>
        <SettingRow label="Farbschema" reset={{ defaultLabel: 'System', onReset }}>
          <span>control</span>
        </SettingRow>
      </I18nProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Standard' }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('Arbeitsflächen B: a row opens in place under itself, one at a time', async () => {
    const user = userEvent.setup();
    const rows = [
      { id: 'a', name: 'Kaffeebohnen' },
      { id: 'b', name: 'Mühle' },
    ];
    wrap(
      <DataTable
        columns={[{ key: 'name', header: 'Artikel', render: (r: (typeof rows)[number]) => r.name }]}
        rows={rows}
        rowKey={(r) => r.id}
        expand={{ label: (r) => `Bewegungen von ${r.name}`, render: (r) => <p>Detail {r.name}</p> }}
      />,
    );
    const first = screen.getByRole('button', { name: 'Bewegungen von Kaffeebohnen: Aufklappen' });
    await user.click(first);
    expect(screen.getByText('Detail Kaffeebohnen')).toBeInTheDocument();
    expect(first).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByText('Mühle'));
    expect(screen.queryByText('Detail Kaffeebohnen')).toBeNull();
    expect(screen.getByText('Detail Mühle')).toBeInTheDocument();
  });

  it('a Field is as wide as what it holds: name by default, the size it is given otherwise', () => {
    wrap(
      <>
        <Field label="Name">
          <input className="field" />
        </Field>
        <Field label="PLZ" size="code">
          <input className="field" />
        </Field>
      </>,
    );
    expect(screen.getByLabelText('Name').closest('.form-row')).toHaveClass('form-row--name');
    expect(screen.getByLabelText('PLZ').closest('.form-row')).toHaveClass('form-row--code');
  });
});
