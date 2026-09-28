/**
 * TaxCodeCombobox and the PickerButton under it: the MWST code picked the way an account is picked,
 * from the keyboard. The contract asserted here is the one the bank inbox leans on in a dense row:
 * the trigger is a button that says it opens a listbox; opening it puts focus IN the search field;
 * typing a code, a rate or a kind filters; the arrows walk; Enter picks and hands focus back to the
 * trigger; Escape closes without a change. The codes lead with the ones that fit the money's
 * direction, and "Ohne MWST" is always a real answer. Every code below is invented for this file.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { I18nProvider } from '../i18n';
import { TaxCodeCombobox, type TaxCodeLike } from './TaxCodeCombobox';

const CODES: TaxCodeLike[] = [
  { code: 'UST81', kind: 'output', rateBp: 810, label: 'Umsatzsteuer Normalsatz' },
  { code: 'VST-M', kind: 'input', rateBp: 0, label: 'Vorsteuer Material, Waren, Dienstleistungen' },
  { code: 'VST-I', kind: 'input', rateBp: 0, label: 'Vorsteuer Investitionen' },
  { code: 'BEZUG', kind: 'reverse_charge', rateBp: 810, label: 'Bezugsteuer Dienstleistungen Ausland' },
];

function renderPicker(props: Partial<Parameters<typeof TaxCodeCombobox>[0]> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <I18nProvider initialLocale="de-CH">
      <TaxCodeCombobox label="MWST, Alpina Telecom AG" codes={CODES} value="" onChange={onChange} direction="out" {...props} />
      <button type="button">Buchen</button>
    </I18nProvider>,
  );
  const trigger = screen.getByRole('button', { name: 'MWST, Alpina Telecom AG' });
  return { ...utils, onChange, trigger };
}

describe('TaxCodeCombobox', () => {
  it('is a button that says it opens a listbox, showing "Ohne MWST" when no code is set', () => {
    const { trigger } = renderPicker();
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('Ohne MWST');
  });

  it('opens with the search field focused, and the codes for money out lead', async () => {
    const { trigger } = renderPicker();
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const search = screen.getByRole('combobox');
    expect(search).toHaveFocus();
    const groups = screen.getAllByRole('group');
    const labels = groups.map((g) => g.getAttribute('aria-labelledby')).map((id) => document.getElementById(id ?? '')?.textContent);
    expect(labels).toEqual(['Aktuell', 'Passend für Ausgänge', 'Weitere Codes']);
    const out = groups[1] as HTMLElement;
    expect(within(out).getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Ohne MWST'),
      expect.stringContaining('VST-M'),
      expect.stringContaining('VST-I'),
      expect.stringContaining('BEZUG'),
    ]);
    // The sale code is still there, one group down: a refund booked against it is legitimate.
    expect(within(groups[2] as HTMLElement).getByRole('option')).toHaveTextContent('UST81');
  });

  it('types a code, walks with the arrows, and Enter picks and returns focus to the trigger', async () => {
    const { trigger, onChange } = renderPicker();
    await userEvent.click(trigger);
    await userEvent.keyboard('VST');
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining('VST-M'), expect.stringContaining('VST-I')]);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('VST-I');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('finds a code by its rate', async () => {
    const { trigger } = renderPicker({ direction: 'in' });
    await userEvent.click(trigger);
    await userEvent.keyboard('8.1');
    const found = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(found.some((text) => text.includes('UST81'))).toBe(true);
  });

  it('Escape closes without a change and hands focus back', async () => {
    const { trigger, onChange } = renderPicker();
    await userEvent.click(trigger);
    await userEvent.keyboard('VST{Escape}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('picks "Ohne MWST" as the empty code', async () => {
    const { trigger, onChange } = renderPicker({ value: 'VST-M' });
    expect(trigger).toHaveTextContent('VST-M');
    await userEvent.click(trigger);
    await userEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Ohne MWST') === true) as HTMLElement);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('opens from the keyboard with ArrowDown on the trigger', async () => {
    const { trigger } = renderPicker();
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('has no axe violations while open', async () => {
    const { trigger, baseElement } = renderPicker();
    await userEvent.click(trigger);
    // The popover is portaled to <body> (a dense row clips an in-place popup), so it sits outside
    // any landmark in this bare render, as Modal's own suite notes; every other rule applies.
    expect(await axe(baseElement, { rules: { region: { enabled: false } } })).toHaveNoViolations();
  });
});
