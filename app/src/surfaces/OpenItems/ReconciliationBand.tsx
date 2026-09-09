/**
 * D-S5, the reconciliation mismatch band, and D-S1's passing statement.
 *
 * A16's designed REFUSAL state, and it is not an error: the read succeeded and every figure on
 * screen is correct. What failed is the agreement between two independent derivations, one from
 * `document` and `payment_allocation` and one from `journal_line`, and the engine reports it rather
 * than hiding it. So the band answers the three questions an error UI owes: what happened (the list
 * and 1100 differ by CHF 12.50), why (one of a short named list), and the one action that recovers.
 *
 * FOUR RULES GOVERN THE PASSING MARK, AND TWO OVERRULE THE SPEC.
 *
 *  - It is a statement about the WORKSPACE, not about what is on screen. `reconciled` compares
 *    figures computed over ALL items while the total above it may be filtered, so when a filter is
 *    active the mark moves onto a second quiet line carrying the workspace figure, labelled as such.
 *    Putting it beside a filtered total would claim the ledger validated a figure it has never seen.
 *  - It carries NO COLOUR when it passes. A16 §6 asks for teal, "the one go/confirmed accent", and
 *    `brand/DESIGN.md` spends the accent budget on focus, the selected item and the single primary
 *    action, with money and status each carrying their own semantics and neither borrowing it. Green
 *    on everything makes green the background and dulls the genuinely urgent red.
 *  - When it FAILS the header line is replaced rather than recoloured: the header carries no
 *    reconciliation line at all, and this band carries the whole statement including its colour. One
 *    status, one place, one treatment.
 *  - It is never colour-only and never glyph-only. Glyph plus words, always, so it survives a
 *    grayscale printout, which is a real Treuhänder artefact.
 *
 * WHAT THE BAND MUST NEVER DO. It must not state a tolerance: `reconciled` is exact and boolean, and
 * copy saying a few Rappen are normal would license the drift the whole capability exists to detect.
 * It must not offer a correction: A16 writes nothing to the ledger, and a correction is a reversing
 * entry in the Journal.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useT, formatMoney } from '../../i18n';
import { CheckGlyph, WarnGlyph } from './glyphs';

export interface ReconciledLineProps {
  /** True when the caller is showing a narrowed set, which moves the statement onto its own line. */
  filtered: boolean;
  workspaceBaseTotalOpenMinor: number;
  baseCurrency: string;
}

/** The passing statement: a check glyph plus a sentence, dim, uncoloured, and always in words. */
export function ReconciledLine({ filtered, workspaceBaseTotalOpenMinor, baseCurrency }: ReconciledLineProps) {
  const t = useT();
  return (
    <p className="oi-reconciled">
      <CheckGlyph className="oi-reconciled-glyph" aria-label={t('openItems.reconciled.glyph')} />
      <span>
        {filtered
          ? t('openItems.reconciled.filteredTotal', {
              total: formatMoney(workspaceBaseTotalOpenMinor, baseCurrency),
            })
          : t('openItems.reconciled.statement')}
      </span>
    </p>
  );
}

export interface ReconciliationBandProps {
  /** The signed difference, list minus ledger, in base-currency Rappen. */
  differenceMinor: number;
  listMinor: number;
  ledgerMinor: number;
  baseCurrency: string;
  /**
   * The currencies in view. The FX-plus-Skonto checklist line renders only when there is more than
   * one, because a base-currency-only workspace can never reach that corner and a permanent caveat
   * would train the operator to discount the one statement on this surface that has to stay
   * trustworthy.
   */
  currencies: readonly string[];
}

export function ReconciliationBand({
  differenceMinor,
  listMinor,
  ledgerMinor,
  baseCurrency,
  currencies,
}: ReconciliationBandProps) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <div className="oi-mismatch" role="status">
      <WarnGlyph className="oi-mismatch-glyph" aria-hidden="true" focusable="false" />
      <div className="oi-mismatch-body">
        <p className="oi-mismatch-title">
          {t('openItems.mismatch.title', { difference: formatMoney(differenceMinor, baseCurrency) })}
        </p>
        <p className="oi-mismatch-detail">
          {t('openItems.mismatch.body', {
            list: formatMoney(listMinor, baseCurrency),
            ledger: formatMoney(ledgerMinor, baseCurrency),
          })}
        </p>
        <div className="oi-mismatch-actions">
          <Link className="btn btn--secondary btn--sm" to="/journal">
            {t('openItems.mismatch.action')}
          </Link>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {t('openItems.mismatch.disclosure')}
          </button>
        </div>
        {open && (
          <ol className="oi-mismatch-causes">
            <li>{t('openItems.mismatch.cause.direct')}</li>
            <li>{t('openItems.mismatch.cause.document')}</li>
            {currencies.length > 1 && <li>{t('openItems.mismatch.cause.fxSkonto')}</li>}
          </ol>
        )}
      </div>
    </div>
  );
}
