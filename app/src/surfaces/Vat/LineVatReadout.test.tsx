import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { I18nProvider } from '../../i18n';
import { LineVatReadout } from './LineVatReadout';
import type { LineVat } from './types';
// The error stand-in is the SAME fixture the engine drift guard pins to the live rejection
// (test/vat/vat-preview-fixture.test.mjs), so the LineVatErr shape cannot silently drift (m4).
import vatPreviewError from './vat-preview-error.fixture.json';

function ok(over: Partial<Extract<LineVat, { ok: true }>> = {}): LineVat {
  return {
    ok: true,
    kind: 'output',
    netMinor: 100000,
    taxMinor: 8100,
    grossMinor: 108100,
    rateBp: 810,
    deductible: false,
    formLine: '303',
    trace: { taxCode: 'UST81', taxBaseMinor: 100000, taxAmountMinor: 8100 },
    ...over,
  };
}

/**
 * A11-G2: `currency` is passed explicitly, even in the franc cases below. It used to be absent and
 * `formatMoney` defaulted to CHF, so these assertions held over a readout that mislabelled every
 * foreign line. The currency behaviour itself is exercised in `vat-currency.test.tsx`.
 */
function renderReadout(vat: LineVat | undefined, currency = 'CHF') {
  return render(
    <I18nProvider initialLocale="en">
      <LineVatReadout vat={vat} currency={currency} />
    </I18nProvider>,
  );
}

describe('LineVatReadout', () => {
  it('renders nothing for an absent or none line', () => {
    const { container } = renderReadout(undefined);
    expect(container).toBeEmptyDOMElement();
    const { container: c2 } = renderReadout(ok({ kind: 'none' }));
    expect(c2).toBeEmptyDOMElement();
  });

  it('shows tax and gross for an ordinary line (the same figures vat_preview returns)', () => {
    renderReadout(ok());
    expect(screen.getByText(/VAT CHF 81\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Gross CHF 1'081\.00/)).toBeInTheDocument();
  });

  it('states that Bezugsteuer books output AND input VAT of the same amount (M29)', () => {
    renderReadout(ok({ kind: 'reverse_charge', taxMinor: 16200 }));
    expect(screen.getByText(/Reverse charge/)).toBeInTheDocument();
    expect(screen.getByText(/output and input VAT of CHF 162\.00 each/)).toBeInTheDocument();
  });

  it('shows the assessed tax for an import line, never a rate-derived figure (M30)', () => {
    renderReadout(ok({ kind: 'import', netMinor: 0, taxMinor: 15500, grossMinor: 15500 }));
    expect(screen.getByText(/Import VAT/)).toBeInTheDocument();
    expect(screen.getByText(/Assessed tax CHF 155\.00/)).toBeInTheDocument();
  });

  it('renders the two 0% kinds with DISTINCT humanized labels, never conflated', () => {
    const { unmount } = renderReadout(ok({ kind: 'zero', taxMinor: 0 }));
    expect(screen.getByText('Zero-rated export')).toBeInTheDocument();
    unmount();
    renderReadout(ok({ kind: 'exempt', taxMinor: 0 }));
    expect(screen.getByText('Exempt (no input deduction)')).toBeInTheDocument();
  });

  it('announces an unknown-code error inline (the drift-guarded rejection fixture)', () => {
    renderReadout(vatPreviewError as LineVat);
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown VAT code.');
  });
});
