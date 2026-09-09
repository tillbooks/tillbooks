/**
 * AccountCombobox: the keyboard-first account picker (F-03, J3.7).
 *
 * J3.7's ideal path is "type 6500, Enter", so that is the first assertion, and the ARIA combobox
 * contract is asserted rather than assumed (aria-activedescendant is the part that regresses
 * silently). The exact-code rule is asserted against a chart where "6500" is a prefix of another
 * number, because that is the case a prefix-only picker gets wrong.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { AccountCombobox, Combobox, rankOptions } from './AccountCombobox';

const CHART = [
  { id: 'acc_1020', number: '1020', name: 'Bank' },
  { id: 'acc_6500', number: '6500', name: 'Büromaterial' },
  { id: 'acc_65001', number: '65001', name: 'Büromaterial Filiale' },
  { id: 'acc_6510', number: '6510', name: 'Telefon' },
  { id: 'acc_2000', number: '2000', name: 'Kreditoren' },
];

describe('AccountCombobox', () => {
  it('carries the WAI-ARIA combobox contract', () => {
    render(<AccountCombobox ariaLabel="Konto 1" accounts={CHART} value="" onChange={() => undefined} />);
    const box = screen.getByRole('combobox', { name: 'Konto 1' });
    expect(box).toHaveAttribute('aria-autocomplete', 'list');
    expect(box).toHaveAttribute('aria-expanded', 'false');
    expect(box.getAttribute('aria-controls')).toBeTruthy();
  });

  it('types "6500" and Enter lands on 6500 even when 65001 shares the prefix', async () => {
    const onChange = vi.fn();
    render(<AccountCombobox ariaLabel="Konto 1" accounts={CHART} value="" onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: 'Konto 1' });
    await userEvent.type(box, '6500');
    expect(box).toHaveAttribute('aria-expanded', 'true');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['6500Büromaterial', '65001Büromaterial Filiale']);
    expect(box.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('acc_6500');
    expect(box).toHaveAttribute('aria-expanded', 'false');
  });

  it('Tab accepts the exact number and moves on, so the composer stays keyboard-first', async () => {
    const onChange = vi.fn();
    render(
      <>
        <AccountCombobox ariaLabel="Konto 1" accounts={CHART} value="" onChange={onChange} />
        <input aria-label="Soll 1" />
      </>,
    );
    const box = screen.getByRole('combobox', { name: 'Konto 1' });
    await userEvent.type(box, '6510');
    await userEvent.tab();
    expect(onChange).toHaveBeenCalledWith('acc_6510');
    expect(screen.getByRole('textbox', { name: 'Soll 1' })).toHaveFocus();
  });

  it('ArrowDown walks the list and Enter picks the active row; Escape restores the old value', async () => {
    const onChange = vi.fn();
    render(<AccountCombobox ariaLabel="Konto 1" accounts={CHART} value="acc_1020" onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: 'Konto 1' });
    expect(box).toHaveValue('1020 Bank');
    await userEvent.clear(box);
    await userEvent.type(box, 'Büro');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('acc_65001');
    await userEvent.clear(box);
    await userEvent.type(box, 'Tel');
    await userEvent.keyboard('{Escape}');
    expect(box).toHaveAttribute('aria-expanded', 'false');
    // Escape restores the display of the value the caller still holds (acc_1020 here: the
    // component is controlled and the test never re-rendered it).
    expect(box).toHaveValue('1020 Bank');
  });

  it('a digit query never matches a name, and an emptied field clears the value on blur', async () => {
    expect(rankOptions(CHART.map((a) => ({ id: a.id, code: a.number, label: a.name })), '20').map((o) => o.id)).toEqual(['acc_2000']);
    const onChange = vi.fn();
    render(
      <>
        <AccountCombobox ariaLabel="Konto 1" accounts={CHART} value="acc_1020" onChange={onChange} />
        <button type="button">weiter</button>
      </>,
    );
    const box = screen.getByRole('combobox', { name: 'Konto 1' });
    await userEvent.clear(box);
    await userEvent.tab();
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('offers an inline create row when nothing matches and the caller provides one', async () => {
    const onCreate = vi.fn();
    render(
      <Combobox
        ariaLabel="Kunde"
        options={[{ id: 'c1', label: 'Rialto Bar' }]}
        value=""
        onChange={() => undefined}
        onCreate={onCreate}
        createLabel={(q) => `„${q}“ als Kunde anlegen`}
      />,
    );
    const box = screen.getByRole('combobox', { name: 'Kunde' });
    await userEvent.type(box, 'Mara Design GmbH');
    const create = screen.getByRole('option', { name: '„Mara Design GmbH“ als Kunde anlegen' });
    expect(box.getAttribute('aria-activedescendant')).toBe(create.id);
    await userEvent.keyboard('{Enter}');
    expect(onCreate).toHaveBeenCalledWith('Mara Design GmbH');
  });

  // Critic F5 (2026-09-05): the no-match row sat inside role="listbox" as a bare li[aria-disabled]
  // and axe reported aria-required-children and listitem. DESIGN.md says a violation fails the
  // build, so every state the list can take is asserted. Put the row back to a bare li and the
  // third state fails.
  it('has no axe violations closed, open with matches, open with no match, and with the create row', async () => {
    const closed = render(<AccountCombobox ariaLabel="Konto 1" accounts={CHART} value="" onChange={() => undefined} noMatchLabel="Kein Konto passt." />);
    expect(await axe(closed.container)).toHaveNoViolations();
    const box = screen.getByRole('combobox', { name: 'Konto 1' });
    await userEvent.type(box, '65');
    expect(box).toHaveAttribute('aria-expanded', 'true');
    expect(await axe(closed.container)).toHaveNoViolations();
    await userEvent.clear(box);
    await userEvent.type(box, 'zzz');
    expect(screen.getByRole('option', { name: 'Kein Konto passt.' })).toHaveAttribute('aria-disabled', 'true');
    // The active descendant never points at the disabled row.
    expect(box.getAttribute('aria-activedescendant')).toBeNull();
    expect(await axe(closed.container)).toHaveNoViolations();
    closed.unmount();
    const create = render(
      <Combobox ariaLabel="Kunde" options={[{ id: 'c1', label: 'Rialto Bar' }]} value="" onChange={() => undefined} onCreate={() => undefined} createLabel={(q) => `„${q}“ anlegen`} />,
    );
    await userEvent.type(screen.getByRole('combobox', { name: 'Kunde' }), 'Mara');
    expect(screen.getByRole('option', { name: '„Mara“ anlegen' })).toBeInTheDocument();
    expect(await axe(create.container)).toHaveNoViolations();
  });
});
