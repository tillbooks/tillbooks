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

  describe('strictGroups (D167, the bank row)', () => {
    const STRICT = { label: 'Vorsteuer (Geld raus)', otherLabel: 'Weitere' };
    const groupLabels = () =>
      screen.getAllByRole('group').map((g) => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent);

    it('money out: "Ohne MWST" alone first, then only the input codes, the rest under Weitere', async () => {
      const { trigger } = renderPicker({ strictGroups: STRICT, value: 'VST-M' });
      await userEvent.click(trigger);
      const list = screen.getByRole('listbox');
      expect(within(list).getAllByRole('option')[0]).toHaveTextContent('Ohne MWST');
      expect(groupLabels()).toEqual(['Vorsteuer (Geld raus)', 'Weitere']);
      const [own, other] = screen.getAllByRole('group') as HTMLElement[];
      expect(within(own as HTMLElement).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('VST-M'), expect.stringContaining('VST-I')]);
      // Bezugsteuer and the sale code are legitimate, one group down.
      expect(within(other as HTMLElement).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('UST81'), expect.stringContaining('BEZUG')]);
      // The chosen code carries its check, and no "Aktuell" group repeats it.
      expect(within(list).getAllByRole('option', { selected: true })).toHaveLength(1);
      expect(within(list).getByRole('option', { selected: true })).toHaveTextContent('VST-M');
    });

    it('money in: the output codes lead under their own label', async () => {
      const { trigger, onChange } = renderPicker({ strictGroups: { label: 'Umsatzsteuer (Geld rein)', otherLabel: 'Weitere' }, direction: 'in' });
      await userEvent.click(trigger);
      expect(groupLabels()).toEqual(['Umsatzsteuer (Geld rein)', 'Weitere']);
      expect(within(screen.getAllByRole('group')[0] as HTMLElement).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('UST81')]);
      await userEvent.click(within(screen.getAllByRole('group')[0] as HTMLElement).getByRole('option'));
      expect(onChange).toHaveBeenCalledWith('UST81');
    });

    it('"Ohne MWST" picks the empty code, and the list stays axe-clean', async () => {
      const { trigger, onChange, baseElement } = renderPicker({ strictGroups: STRICT, value: 'VST-I' });
      await userEvent.click(trigger);
      expect(await axe(baseElement, { rules: { region: { enabled: false } } })).toHaveNoViolations();
      await userEvent.click(screen.getAllByRole('option')[0] as HTMLElement);
      expect(onChange).toHaveBeenCalledWith('');
    });
  });

  describe('humanLabels (D167, the bank row): words, never the code', () => {
    // The default set's shape, in the engine's seed order (Investitionen before Material), invented labels.
    const SEED: TaxCodeLike[] = [
      { code: 'UST81', kind: 'output', rateBp: 810, label: 'Umsatzsteuer 8.1% (Normalsatz)', formLine: '303' },
      { code: 'UST26', kind: 'output', rateBp: 260, label: 'Umsatzsteuer 2.6% (reduziert)', formLine: '313' },
      { code: 'VST-I', kind: 'input', rateBp: 0, label: 'Vorsteuer Investitionen', formLine: '405' },
      { code: 'VST-I26', kind: 'input', rateBp: 260, label: 'Vorsteuer Investitionen 2.6%', formLine: '405' },
      { code: 'VST-I38', kind: 'input', rateBp: 380, label: 'Vorsteuer Investitionen 3.8%', formLine: '405' },
      { code: 'VST-M', kind: 'input', rateBp: 0, label: 'Vorsteuer Material', formLine: '400' },
      { code: 'VST-M26', kind: 'input', rateBp: 260, label: 'Vorsteuer Material 2.6%', formLine: '400' },
      { code: 'VST-M38', kind: 'input', rateBp: 380, label: 'Vorsteuer Material 3.8%', formLine: '400' },
    ];
    const STRICT = { label: 'Vorsteuer (Geld raus)', otherLabel: 'Weitere' };
    const ownRows = () => within(screen.getAllByRole('group')[0] as HTMLElement).getAllByRole('option');

    it('money out: the Material family first, then Betriebsaufwand, each 8.1, 2.6, 3.8 in words with its family hint', async () => {
      const { trigger } = renderPicker({ codes: SEED, strictGroups: STRICT, humanLabels: { date: '2026-10-05' } });
      await userEvent.click(trigger);
      const rows = ownRows();
      expect(rows.map((o) => o.querySelector('.combobox__label')?.textContent)).toEqual([
        'Vorsteuer 8.1 %',
        'Vorsteuer 2.6 %',
        'Vorsteuer 3.8 %',
        'Vorsteuer 8.1 %',
        'Vorsteuer 2.6 %',
        'Vorsteuer 3.8 %',
      ]);
      expect(rows.map((o) => o.querySelector('.combobox__meta')?.textContent)).toEqual([
        ...Array(3).fill('Material, Waren, Dienstleistungen'),
        ...Array(3).fill('Betriebsaufwand, Investitionen'),
      ]);
      // No row prints a code.
      expect(rows.every((o) => !/VST|UST/.test(o.textContent ?? ''))).toBe(true);
    });

    it('a zero-rate Vorsteuer code names the Normalsatz of the supply date: 7.7 % before 2024', async () => {
      const { trigger } = renderPicker({ codes: SEED, strictGroups: STRICT, humanLabels: { date: '2023-11-20' } });
      await userEvent.click(trigger);
      expect(ownRows()[0]?.querySelector('.combobox__label')?.textContent).toBe('Vorsteuer 7.7 %');
      expect(ownRows()[1]?.querySelector('.combobox__label')?.textContent).toBe('Vorsteuer 2.5 %');
    });

    it('money in: Umsatzsteuer in words with its rate hint', async () => {
      const { trigger } = renderPicker({ codes: SEED, direction: 'in', strictGroups: { label: 'Umsatzsteuer (Geld rein)', otherLabel: 'Weitere' }, humanLabels: { date: '2026-10-05' } });
      await userEvent.click(trigger);
      expect(ownRows().map((o) => `${o.querySelector('.combobox__label')?.textContent} / ${o.querySelector('.combobox__meta')?.textContent}`)).toEqual([
        'Umsatzsteuer 8.1 % / Normalsatz',
        'Umsatzsteuer 2.6 % / reduziert',
      ]);
    });

    it('polish 7: the field tells the Betriebsaufwand family from Material, and "Ohne MWST" never claims "ausgenommen"', async () => {
      const { trigger } = renderPicker({ codes: SEED, strictGroups: STRICT, value: 'VST-I26', humanLabels: { date: '2026-10-05' } });
      expect(trigger).toHaveTextContent('Vorsteuer 2.6 % (Betrieb)');
      await userEvent.click(trigger);
      const none = within(screen.getByRole('listbox')).getAllByRole('option')[0] as HTMLElement;
      expect(none).toHaveTextContent('Ohne MWST');
      expect(none.textContent ?? '').not.toMatch(/ausgenommen/i);
    });

    it('the trigger reads the chosen code in words, and the code is still found by typing it', async () => {
      const { trigger, onChange } = renderPicker({ codes: SEED, strictGroups: STRICT, value: 'VST-M26', humanLabels: { date: '2026-10-05' } });
      expect(trigger).toHaveTextContent('Vorsteuer 2.6 %');
      expect(trigger).not.toHaveTextContent('VST');
      await userEvent.click(trigger);
      await userEvent.keyboard('VST-I38');
      expect(screen.getAllByRole('option').map((o) => o.querySelector('.combobox__label')?.textContent)).toEqual(['Vorsteuer 3.8 %']);
      await userEvent.keyboard('{Enter}');
      expect(onChange).toHaveBeenCalledWith('VST-I38');
    });
  });
});
