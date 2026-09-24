import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { TaxCodePicker } from './TaxCodePicker';
import type { VatCode } from './types';

const CODES: VatCode[] = [
  { code: 'UST81', kind: 'output', rateBp: 810, formLine: '303', label: 'Umsatzsteuer 8.1% (Normalsatz)', active: true },
  { code: 'VST-M', kind: 'input', rateBp: 0, formLine: '400', label: 'Vorsteuer Material', active: true },
  { code: 'BEZUG', kind: 'reverse_charge', rateBp: 810, formLine: '383', label: 'Bezugsteuer (Art. 45)', active: true },
  { code: 'EXPORT0', kind: 'zero', rateBp: 0, formLine: '220', label: 'Export, echt befreit', active: true },
];

function renderPicker(props: Partial<React.ComponentProps<typeof TaxCodePicker>> = {}) {
  return render(
    <I18nProvider initialLocale="en">
      <MemoryRouter>
        <TaxCodePicker ariaLabel="Tax code 1" codes={CODES} value="" onChange={vi.fn()} {...props} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe('TaxCodePicker, the five states', () => {
  it('loading: renders a disabled real select inside the caller skeleton', () => {
    // LOADING-PROOF-EXEMPT: The picker takes its loading state as a prop and the CALLER owns the
    // read, so this test has no request of its own to prove.
    renderPicker({ disabled: true });
    expect(screen.getByRole('combobox', { name: 'Tax code 1' })).toBeDisabled();
  });

  it('empty/unconfigured: no dropdown, a banner-CTA into /vat instead (P9)', () => {
    renderPicker({ needsConfig: true });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('VAT is not set up for this workspace yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up VAT' })).toHaveAttribute('href', '/vat');
  });

  it('error: an archived/unknown selected code flags inline via aria-describedby, and stays selectable', async () => {
    renderPicker({ value: 'OLD77', invalidCode: true, id: 'p1' });
    const select = screen.getByRole('combobox', { name: 'Tax code 1' });
    expect(select).toHaveAttribute('aria-invalid', 'true');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Code archived, choose another.');
    expect(select).toHaveAttribute('aria-describedby', alert.id);
    // The archived code survives as the trigger's value and as an option, so the draft still shows
    // what it carried.
    expect(select).toHaveTextContent('OLD77');
    await userEvent.click(select);
    expect(screen.getByRole('option', { name: 'OLD77' })).toBeInTheDocument();
  });

  it('success: the shared Select (K-30), options grouped by kind, onChange fires with the chosen code', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });
    const trigger = screen.getByRole('combobox', { name: 'Tax code 1' });
    // The same control family as every other select in the Studio, on the shared control height.
    expect(trigger).toHaveClass('select-trigger');
    await userEvent.click(trigger);
    // Grouped so each group stays short (the Hick fix, not a second control).
    expect(screen.getByRole('group', { name: 'Output VAT' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Special' })).toBeInTheDocument();
    // The humanized label leads, the raw code trails but stays visible.
    const option = screen.getByRole('option', { name: /Umsatzsteuer 8\.1% \(Normalsatz\) · UST81/ });
    await userEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('UST81');
  });

  it('permission-denied: read-only text of the current code, no dropdown', () => {
    renderPicker({ value: 'UST81', readOnly: true });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('UST81')).toBeInTheDocument();
  });

  it('has no axe violations in the success state', async () => {
    const { container } = renderPicker({ id: 'p1' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
