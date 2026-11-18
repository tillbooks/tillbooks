/**
 * D195: the shared DateField. Text in the person's format in, ISO out; an empty field shows its placeholder,
 * never today; an unreadable date is kept as typed and marked, never guessed; the calendar is the browser's own.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { I18nProvider } from '../i18n';
import { DateField } from './DateField';

function field(props: Partial<Parameters<typeof DateField>[0]> = {}) {
  const onChange = vi.fn<(iso: string | null) => void>();
  const view = render(
    <I18nProvider initialLocale="de-CH">
      <DateField value={null} onChange={onChange} ariaLabel="Von" {...props} />
    </I18nProvider>,
  );
  return { onChange, view, input: screen.getByRole('textbox', { name: 'Von' }) as HTMLInputElement };
}

describe('DateField (D195)', () => {
  it('empty: the placeholder of the format, never today', () => {
    const { input } = field();
    expect(input.value).toBe('');
    expect(input).toHaveAttribute('placeholder', 'TT.MM.JJJJ');
  });

  it('shows the value in the chosen format and hands a typed date on as ISO', async () => {
    const { input, onChange } = field({ value: '2026-09-01' });
    expect(input.value).toBe('01.09.2026');
    await userEvent.clear(input);
    await userEvent.type(input, '12.11.2026{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('2026-11-12');
  });

  it('iso and us read and write their own shape', async () => {
    const iso = field({ value: '2026-09-01', format: 'iso', ariaLabel: 'Von' });
    expect(iso.input.value).toBe('2026-09-01');
    iso.view.unmount();
    const us = field({ format: 'us' });
    expect(us.input).toHaveAttribute('placeholder', 'MM/TT/JJJJ');
    await userEvent.type(us.input, '9/1/2026');
    fireEvent.blur(us.input);
    expect(us.onChange).toHaveBeenLastCalledWith('2026-09-01');
  });

  it('an unreadable date stays as typed, marked invalid with the format in words; nothing is sent', async () => {
    const { input, onChange } = field();
    await userEvent.type(input, '31.02.2026');
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('31.02.2026');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Datum als TT.MM.JJJJ');
  });

  it('emptied: no date', async () => {
    const { input, onChange } = field({ value: '2026-09-01' });
    await userEvent.clear(input);
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('the calendar: Alt+ArrowDown and the glyph open the browser picker on the hidden date field, whose pick is the value', async () => {
    const { input, onChange, view } = field();
    const native = view.container.querySelector('input[type="date"]') as HTMLInputElement & { showPicker?: () => void };
    const showPicker = vi.fn();
    native.showPicker = showPicker;
    input.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(showPicker).toHaveBeenCalledTimes(1);
    await userEvent.click(view.container.querySelector('.date-field__glyph') as HTMLElement);
    expect(showPicker).toHaveBeenCalledTimes(2);
    fireEvent.change(native, { target: { value: '2026-10-07' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-10-07');
    // The hidden field is out of the tab order and out of the accessibility tree.
    expect(native).toHaveAttribute('tabindex', '-1');
    expect(native).toHaveAttribute('aria-hidden', 'true');
  });
});
