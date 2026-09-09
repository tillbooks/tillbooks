/**
 * The per-line computed-VAT readout (part of S11 / S9's success state).
 *
 * Driven by `vat_preview` (the same `computeLineTax` the agent calls, US-A06.7), so the figure a
 * human sees and the figure an agent previews are one code path. Ordinary lines read net/tax/gross;
 * Bezugsteuer states it books output AND input VAT of the same amount (M29); import shows the
 * assessed tax (M30); the two 0% kinds render distinct humanized labels, never conflated. Figures go
 * through the shared `formatMoney`; the readout is labelled text for assistive tech, never a colour
 * cue.
 *
 * A11-G2, the currency. `vat_preview` answers in the currency of the amount it was handed, and that
 * amount is the LINE the user typed, denominated in the document's currency. So every figure here is
 * a transaction figure and takes the document's label. This used to pass no currency and
 * `formatMoney` defaults to CHF, so a EUR line read `MWST CHF 121.50` for a EUR 121.50 tax: the
 * right number under the wrong unit, which is worse than either mistake alone because it looks
 * checked. Required rather than defaulted, so the next caller that forgets fails to compile instead
 * of shipping a plausible figure. Nothing here converts: the client does not do money.
 */
import { useT, formatMoney } from '../../i18n';
import type { LineVat } from './types';

export interface LineVatReadoutProps {
  vat: LineVat | undefined;
  /** The currency the previewed line is denominated in, which is the document's or the entry's. */
  currency: string;
}

/** A small neutral badge (glyph + word) for the special kinds. Never recoloured (teal is reserved). */
function Badge({ label }: { label: string }) {
  return (
    <span className="vat-line-badge">
      <span aria-hidden="true">· </span>
      {label}
    </span>
  );
}

export function LineVatReadout({ vat, currency }: LineVatReadoutProps) {
  const t = useT();
  if (vat === undefined) return null;

  if (vat.ok !== true) {
    const key = vat.error === 'unknown_tax_code' ? 'vat.error.unknownCode' : 'vat.error.archivedCode';
    return (
      <p className="vat-readout vat-readout-error" role="alert">
        {t(key)}
      </p>
    );
  }

  if (vat.kind === 'none') return null;

  if (vat.kind === 'reverse_charge') {
    return (
      <p className="vat-readout">
        <Badge label={t('vat.line.reverseCharge')} />{' '}
        {t('vat.line.reverseChargePreview', { amount: formatMoney(vat.taxMinor, currency) })}
      </p>
    );
  }

  if (vat.kind === 'import') {
    return (
      <p className="vat-readout">
        <Badge label={t('vat.line.import')} /> {t('vat.line.assessedTax')} {formatMoney(vat.taxMinor, currency)}
      </p>
    );
  }

  if (vat.kind === 'zero') {
    return (
      <p className="vat-readout">
        <Badge label={t('vat.line.zeroRated')} />
      </p>
    );
  }

  if (vat.kind === 'exempt') {
    return (
      <p className="vat-readout">
        <Badge label={t('vat.line.exemptNoDeduction')} />
      </p>
    );
  }

  // Ordinary output / input: net / tax / gross, tabular numerals.
  return (
    <p className="vat-readout vat-readout-figures">
      <span>
        {t('vat.line.tax')} {formatMoney(vat.taxMinor, currency)}
      </span>
      <span>
        {t('vat.line.gross')} {formatMoney(vat.grossMinor, currency)}
      </span>
    </p>
  );
}
