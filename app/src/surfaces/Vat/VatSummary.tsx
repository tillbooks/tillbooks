/**
 * S10, the per-document VAT summary panel.
 *
 * One row per rate (Basis -> MWST), then the total. The total is the SUM of the per-line taxes, which
 * reconciles to the line readouts to the Rappen by construction (A06 §8): a mismatch would be an
 * engine bug, never a UI re-round. An all-untaxed document reads "Keine MWST auf diesem Beleg", an
 * honest empty, not a bare "No data". Reverse-charge and import rows carry their badge (glyph + word),
 * never a colour swap. Display-only: its single link opens /vat for the curious.
 *
 * A11-G2, the currency. Every figure here comes out of `vat_preview`, which answers in the currency
 * of the amount it was handed, and that amount is a line the user typed in the DOCUMENT's currency.
 * So these are transaction figures and the document's currency is their only true label. This used
 * to pass no currency at all, and `formatMoney` defaults to CHF, which on a EUR invoice printed
 * `Gebucht CHF 1'526.16` and `Total MWST CHF 121.50` on the same screen: the second figure was the
 * EUR tax under a franc label, true in neither currency, on an immutable posted record.
 *
 * `currency` is REQUIRED, not optional with a default, because a default is what caused this: a
 * missing argument was a wrong number rather than a compile error. The next call site that forgets
 * will not build.
 *
 * The franc figure an MWST filing needs is a DIFFERENT number (CHF 114.36 against EUR 121.50 on the
 * pinned fixture), and it is no longer unreachable: `get_document` and `list_documents` now send
 * `baseTaxMinor`, derived at read time from the posted rows, and S3's M11 panel prints it directly
 * above this one. So the reader does see both, each in its own currency and neither pretending to be
 * the other.
 *
 * That does NOT make it this panel's figure. Everything here comes from `vat_preview`, which has no
 * franc answer to give: it prices an amount it was handed and never touches the ledger, so there is
 * nothing base-currency-shaped on its response to render. The only way to put francs in THIS panel
 * would be to multiply the rate out, and that is the one thing it must not do, because §H-FX rounds
 * ONCE per side and allocates back by largest remainder (src/core/ledger/postEntry.ts): on the
 * pinned two-rate document the books hold CHF 19.91 and the product yields CHF 19.92. The franc
 * figure belongs where it is derived, one panel up.
 */
import { Link } from 'react-router-dom';

import { useT, formatMoney } from '../../i18n';
import type { VatSummary as VatSummaryModel } from './types';
import { formatRatePct } from './format';
import { SurfaceHelp } from '../../components/SurfaceHelp';

export interface VatSummaryProps {
  summary: VatSummaryModel;
  /** The currency every figure below is denominated in: the document's, never the workspace's. */
  currency: string;
}

/**
 * The kinds that carry a humanized label + badge instead of a bare rate percentage. The two 0% kinds
 * (zero-rated export, Ziffer 220, and exempt, Ziffer 230) MUST NOT share the "0.0%" label: they
 * report on different ESTV Ziffern, so each gets its own distinct label and its own summary row
 * (M31, keyed by kind in `summariseVat`). Reverse-charge and import badge distinctly for the same
 * reason (spec §6). The label keys match `LineVatReadout` so the readout and the summary agree.
 */
const BADGED_LABEL_KEY: Record<string, string> = {
  reverse_charge: 'vat.line.reverseCharge',
  import: 'vat.line.import',
  zero: 'vat.line.zeroRated',
  exempt: 'vat.line.exemptNoDeduction',
};

export function VatSummary({ summary, currency }: VatSummaryProps) {
  const t = useT();

  if (summary.rows.length === 0) {
    return (
      <p className="vat-summary-empty" data-testid="vat-summary-empty">
        {t('vat.doc.noVat')}
      </p>
    );
  }

  return (
    <section className="vat-summary panel" aria-label={t('vat.doc.summary')}>
      <header className="vat-summary-head">
        <h3 className="vat-summary-title">
          {t('vat.doc.summary')}
          <SurfaceHelp surface="Vat" />
        </h3>
        <Link className="vat-summary-link" to="/vat">
          {t('vat.doc.perRate')}
        </Link>
      </header>
      <dl className="vat-summary-rows">
        {summary.rows.map((row) => {
          const labelKey = BADGED_LABEL_KEY[row.kind];
          return (
            <div className="vat-summary-row" key={row.key}>
              <dt>
                {labelKey !== undefined ? (
                  <span className="vat-summary-badge">
                    <span aria-hidden="true">· </span>
                    {t(labelKey)}
                  </span>
                ) : (
                  formatRatePct(row.rateBp)
                )}
                <span className="vat-summary-base">
                  {' '}
                  {t('vat.doc.base')} {formatMoney(row.baseMinor, currency)}
                </span>
              </dt>
              <dd>{formatMoney(row.taxMinor, currency)}</dd>
            </div>
          );
        })}
      </dl>
      <div className="vat-summary-total">
        <span>{t('vat.doc.totalTax')}</span>
        <span className="vat-summary-total-value">{formatMoney(summary.totalTaxMinor, currency)}</span>
      </div>
    </section>
  );
}
