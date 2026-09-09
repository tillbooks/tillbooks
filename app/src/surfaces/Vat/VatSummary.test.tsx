import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { VatSummary } from './VatSummary';
import type { VatSummary as VatSummaryModel } from './types';

/**
 * A11-G2: `currency` is passed explicitly even though every case here is a franc one. It used to be
 * absent, and `formatMoney` silently defaulted to CHF, so these franc assertions passed over a
 * component that could not label a EUR document at all. Naming it here keeps the default out of the
 * test suite too; the currency behaviour itself lives in `vat-currency.test.tsx`.
 */
function renderSummary(summary: VatSummaryModel, currency = 'CHF') {
  return render(
    <I18nProvider initialLocale="en">
      <MemoryRouter>
        <VatSummary summary={summary} currency={currency} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe('VatSummary (S10)', () => {
  it('reads the honest empty for an all-untaxed document, not a bare "no data"', () => {
    renderSummary({ rows: [], totalTaxMinor: 0 });
    expect(screen.getByText('No VAT on this document')).toBeInTheDocument();
  });

  it('shows one row per rate with base and tax, and the total (reconciles to the line sum)', () => {
    renderSummary({
      rows: [
        { key: 'rate:810', kind: 'output', rateBp: 810, baseMinor: 154000, taxMinor: 12475 },
        { key: 'rate:260', kind: 'output', rateBp: 260, baseMinor: 50000, taxMinor: 1300 },
      ],
      totalTaxMinor: 13775,
    });
    expect(screen.getByText('8.1%')).toBeInTheDocument();
    expect(screen.getByText(/Base CHF 1'540\.00/)).toBeInTheDocument();
    expect(screen.getByText("CHF 124.75")).toBeInTheDocument();
    // The total is the sum of the row taxes.
    const total = screen.getByText('Total VAT').closest('div');
    expect(total).toHaveTextContent('CHF 137.75');
  });

  it('badges reverse-charge and import rows distinctly, never as an output rate', () => {
    renderSummary({
      rows: [{ key: 'reverse_charge', kind: 'reverse_charge', rateBp: 810, baseMinor: 200000, taxMinor: 16200 }],
      totalTaxMinor: 16200,
    });
    expect(screen.getByText('Reverse charge')).toBeInTheDocument();
    expect(screen.queryByText('8.1%')).not.toBeInTheDocument();
  });

  it('gives the two 0% kinds distinct labels, never a shared "0.0%" row (M31)', () => {
    const { container } = renderSummary({
      rows: [
        { key: 'zero', kind: 'zero', rateBp: 0, baseMinor: 50000, taxMinor: 0 },
        { key: 'exempt', kind: 'exempt', rateBp: 0, baseMinor: 20000, taxMinor: 0 },
      ],
      totalTaxMinor: 0,
    });
    // Each 0% kind carries its own humanized label, so neither reads a bare "0.0%".
    expect(screen.getByText('Zero-rated export')).toBeInTheDocument();
    expect(screen.getByText('Exempt (no input deduction)')).toBeInTheDocument();
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
    // The badge uses the scoped class, never the VatSettings `.vat-badge` pill.
    expect(container.querySelector('.vat-badge')).toBeNull();
    expect(container.querySelectorAll('.vat-summary-badge')).toHaveLength(2);
  });

  it('has no axe violations', async () => {
    const { container } = renderSummary({
      rows: [{ key: 'rate:810', kind: 'output', rateBp: 810, baseMinor: 100000, taxMinor: 8100 }],
      totalTaxMinor: 8100,
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
