/**
 * A11-G2: every figure in the VAT controls wears the currency it is actually in.
 *
 * Both components rendered their money through `formatMoney(minor)` with no second argument, and
 * that argument defaults to CHF. On a CHF document that is invisible, which is why it survived. On a
 * EUR document it put `Total MWST CHF 121.50` on screen, where 121.50 is the EUR tax: a figure that
 * is true in neither currency, on an immutable posted record, in the panel a person reads before
 * filing an MWST return.
 *
 * WHICH currency, and why it is the transaction one. Every figure these two components render comes
 * out of `vat_preview`, which answers in the currency of the amount it was handed, and that amount
 * is a document line the user typed in the document's currency. So the figures ARE transaction
 * figures and the document's currency is the only true label for them. The francs the books hold are
 * a different number (`vat-currency-eur.fixture.json`: EUR 121.50 against CHF 114.36) and they now
 * DO reach the Studio, as `baseTaxMinor` on `get_document` and `list_documents`, derived from the
 * posted rows. S3 prints them in the M11 panel above this one. They still do not reach `vat_preview`,
 * which is what these two components render, so this panel has no franc figure of its own and
 * deriving one would be the client doing money: §H-FX rounds once per side and allocates by largest
 * remainder, so a client-side multiplication is a second opinion about the ledger's own rounding.
 *
 * `neverShowsTheFrancFigure` is therefore not a nice-to-have. It is the assertion that fails if a
 * later hand decides the panel "should really show CHF" and reaches for the rate to get there.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { I18nProvider } from '../../i18n';
import { VatSummary } from './VatSummary';
import { LineVatReadout } from './LineVatReadout';
import type { LineVat, VatSummary as VatSummaryModel } from './types';
import eur from './vat-currency-eur.fixture.json';

function renderSummary(summary: VatSummaryModel, currency: string) {
  return render(
    <I18nProvider initialLocale="en">
      <MemoryRouter>
        <VatSummary summary={summary} currency={currency} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

function renderReadout(vat: LineVat, currency: string) {
  return render(
    <I18nProvider initialLocale="en">
      <LineVatReadout vat={vat} currency={currency} />
    </I18nProvider>,
  );
}

/** The pinned EUR invoice as one taxed summary row, so no figure below is a typed literal. */
const eurSummary: VatSummaryModel = {
  rows: [
    {
      key: 'rate:810',
      kind: 'output',
      rateBp: 810,
      baseMinor: eur.netMinor,
      taxMinor: eur.transactionTaxMinor,
    },
  ],
  totalTaxMinor: eur.transactionTaxMinor,
};

/** The same invoice's line, in the shape `vat_preview` answers. */
const eurLine: LineVat = {
  ok: true,
  kind: 'output',
  netMinor: eur.netMinor,
  taxMinor: eur.transactionTaxMinor,
  grossMinor: eur.transactionTotalMinor,
  rateBp: 810,
  deductible: false,
  formLine: '303',
  trace: { taxCode: 'UST81', taxBaseMinor: eur.netMinor, taxAmountMinor: eur.transactionTaxMinor },
};

/** `1436` inside `CHF 114.36`, as it would appear had somebody converted. Never on screen. */
const francFigure = /114\.36/;

describe('VatSummary currency (A11-G2)', () => {
  it('labels the base, the row tax and the total in the DOCUMENT currency', () => {
    renderSummary(eurSummary, eur.currency);
    expect(screen.getByText(/Base EUR 1'500\.00/)).toBeInTheDocument();
    // Twice: the row's tax and the panel total, which coincide on a single-rate document. They are
    // separate `formatMoney` calls and the defect hit both, so a single-element matcher would let
    // half a fix through.
    expect(screen.getAllByText('EUR 121.50')).toHaveLength(2);
    const total = screen.getByText('Total VAT').closest('div');
    expect(total).toHaveTextContent('EUR 121.50');
  });

  it('never labels a EUR figure CHF, in any of the three places it prints money', () => {
    const { container } = renderSummary(eurSummary, eur.currency);
    // Not "no CHF next to the total": no CHF anywhere in the panel. The defect showed up three
    // times per row and a spot check on one of them is how two of the three would survive a fix.
    expect(container.textContent).not.toMatch(/CHF/);
    expect(screen.queryByText('CHF 121.50')).not.toBeInTheDocument();
  });

  it('never shows the franc figure the books hold, because it was never sent (no derivation)', () => {
    const { container } = renderSummary(eurSummary, eur.currency);
    // The ledger's own CHF VAT for this invoice. It is real, it is what an MWST return needs, and
    // it reaches no read model the Studio can call. A panel showing it here would have computed it.
    expect(eur.baseTaxMinor).not.toBe(eur.transactionTaxMinor);
    expect(container.textContent).not.toMatch(francFigure);
  });

  it('still reads CHF on a franc document, which is the case that hid the bug', () => {
    renderSummary(
      { rows: [{ key: 'rate:810', kind: 'output', rateBp: 810, baseMinor: 150000, taxMinor: 12150 }], totalTaxMinor: 12150 },
      'CHF',
    );
    expect(screen.getAllByText('CHF 121.50')).toHaveLength(2);
  });

  it('takes the currency from the caller, never from a guess about the figures', () => {
    // A third currency, so a fix that special-cased EUR (or that kept CHF as a fallback anywhere)
    // fails here. The component knows nothing about which currencies exist and must not.
    renderSummary({ ...eurSummary }, 'USD');
    expect(screen.getAllByText('USD 121.50')).toHaveLength(2);
    expect(screen.getByText(/Base USD 1'500\.00/)).toBeInTheDocument();
  });
});

describe('LineVatReadout currency (A11-G2)', () => {
  it('labels tax and gross in the DOCUMENT currency on an ordinary line', () => {
    renderReadout(eurLine, eur.currency);
    expect(screen.getByText(/VAT EUR 121\.50/)).toBeInTheDocument();
    expect(screen.getByText(/Gross EUR 1'621\.50/)).toBeInTheDocument();
  });

  it('labels the Bezugsteuer figure too, which states an amount booked twice (M29)', () => {
    renderReadout({ ...eurLine, kind: 'reverse_charge', taxMinor: 16200 }, eur.currency);
    expect(screen.getByText(/output and input VAT of EUR 162\.00 each/)).toBeInTheDocument();
  });

  it('labels the assessed import tax, the one figure the engine does not derive from a rate (M30)', () => {
    renderReadout({ ...eurLine, kind: 'import', netMinor: 0, taxMinor: 15500, grossMinor: 15500 }, eur.currency);
    expect(screen.getByText(/Assessed tax EUR 155\.00/)).toBeInTheDocument();
  });

  it('never labels a EUR line CHF, and never converts it', () => {
    const { container } = renderReadout(eurLine, eur.currency);
    expect(container.textContent).not.toMatch(/CHF/);
    expect(container.textContent).not.toMatch(francFigure);
  });

  it('still reads CHF on a franc line, which is the case that hid the bug', () => {
    renderReadout(eurLine, 'CHF');
    expect(screen.getByText(/VAT CHF 121\.50/)).toBeInTheDocument();
  });
});
