import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MultiSelect, Select } from './Select';

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie', disabled: true },
];

describe('Select', () => {
  it('shows the selected label and opens a listbox of options on click', async () => {
    render(<Select value="b" onChange={() => {}} options={OPTIONS} ariaLabel="Letter" />);
    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    expect(trigger).toHaveTextContent('Bravo');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('option', { name: 'Alpha' })).toBeInTheDocument();
    // The selected option is marked, and it is the accent (aria-selected).
    expect(screen.getByRole('option', { name: 'Bravo' })).toHaveAttribute('aria-selected', 'true');
  });

  it('commits the clicked option and closes', async () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={OPTIONS} ariaLabel="Letter" />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Letter' }));
    await userEvent.click(screen.getByRole('option', { name: 'Alpha' }));
    expect(onChange).toHaveBeenCalledWith('a');
    expect(screen.queryByRole('option')).toBeNull(); // closed
  });

  it('a disabled option cannot be chosen', async () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={OPTIONS} ariaLabel="Letter" />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Letter' }));
    await userEvent.click(screen.getByRole('option', { name: 'Charlie' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drives selection from the keyboard: ArrowDown opens and moves, Enter commits', async () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={OPTIONS} ariaLabel="Letter" />);
    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}'); // opens, active = a
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{ArrowDown}'); // active = b (c is disabled and skipped)
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('closes on Escape without committing', async () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={OPTIONS} ariaLabel="Letter" />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Letter' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('option')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders a leading ungrouped option and grouped sections together', async () => {
    render(
      <Select
        value=""
        onChange={() => {}}
        options={[{ value: '', label: 'Default' }]}
        groups={[{ label: 'Team', options: [{ value: 't1', label: 'One' }] }]}
        ariaLabel="View"
      />,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'View' }));
    expect(screen.getByRole('option', { name: 'Default' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Team' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'One' })).toBeInTheDocument();
  });

  it('shows the placeholder when the value matches no option', () => {
    render(<Select value="" onChange={() => {}} options={OPTIONS} placeholder="Pick one" ariaLabel="Letter" />);
    expect(screen.getByRole('combobox', { name: 'Letter' })).toHaveTextContent('Pick one');
  });

  it('carries validation state (aria-invalid + aria-describedby)', () => {
    render(
      <>
        <Select value="a" onChange={() => {}} options={OPTIONS} ariaLabel="Letter" invalid describedBy="err" />
        <span id="err">Required</span>
      </>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveAccessibleDescription('Required');
  });

  it('Escape on an open list is not seen by an ancestor (does not close a drawer)', async () => {
    const onAncestorEscape = vi.fn();
    render(
      <div onKeyDown={(e) => e.key === 'Escape' && onAncestorEscape()}>
        <Select value="a" onChange={() => {}} options={OPTIONS} ariaLabel="Letter" />
      </div>,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Letter' }));
    await userEvent.keyboard('{Escape}'); // closes the list only
    expect(screen.queryByRole('option')).toBeNull();
    expect(onAncestorEscape).not.toHaveBeenCalled();
  });
});

describe('MultiSelect (the Einstellungen redesign, 18.11.2026)', () => {
  it('shows its short label, ticks several options in the order of the list, and stays open while ticking', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<MultiSelect values={['b']} onChange={onChange} options={OPTIONS.slice(0, 2)} ariaLabel="Letters" displayLabel="1 von 2" />);
    const trigger = screen.getByRole('combobox', { name: 'Letters' });
    expect(trigger).toHaveTextContent('1 von 2');
    await userEvent.click(trigger);
    expect(screen.getByRole('listbox', { name: 'Letters' })).toHaveAttribute('aria-multiselectable', 'true');
    expect(screen.getByRole('option', { name: 'Bravo' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'false');
    await userEvent.click(screen.getByRole('option', { name: 'Alpha' }));
    expect(onChange).toHaveBeenLastCalledWith(['a', 'b']);
    expect(screen.getByRole('listbox', { name: 'Letters' })).toBeInTheDocument();
    rerender(<MultiSelect values={['a', 'b']} onChange={onChange} options={OPTIONS.slice(0, 2)} ariaLabel="Letters" displayLabel="2 von 2" />);
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['b']);
  });
});
