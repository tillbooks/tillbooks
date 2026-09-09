/**
 * S4, the Abstimmung: whether the return agrees with the books, and what a difference is made of.
 *
 * A BRIDGE, NOT A BOOLEAN. A binary "reconciled" badge is the wrong instrument here for a structural
 * reason: in three of the four method x timing combinations a difference against the ledger is
 * either expected or meaningless. Effektiv x Soll reconciles cleanly; Saldo is not comparable at all
 * (Art. 37 makes the VAT invoiced and the VAT owed different figures by construction); and Ist does
 * not compute at all today. A red badge firing every period on most configurations is not a warning,
 * it is noise that trains the operator to ignore it. So the verdict sits on the REMAINDER.
 *
 * ONE CHECK, NOT THREE, AND THE SURFACE SAYS SO. The design asks for three checks (Umsatzsteuer,
 * Vorsteuer, Netto) and for the difference to be attributed to named causes. The engine sends one
 * comparison, Ziff. 399 against the movement on 2200, and no attribution at all. Rendering three
 * headings over one figure, or an "explained" row with nothing behind it, would be the surface
 * claiming work the engine did not do. Everything the engine cannot attribute lands in `ungeklärt`,
 * which the design itself names as the honest degradation.
 *
 * AN UNEXPLAINED DIFFERENCE WARNS, IT DOES NOT BLOCK (owner decision W2). Filing is a statutory
 * obligation with a deadline; this bridge is TILL's own heuristic. A check that locks a correct
 * filer out of recording a lawful filing creates steady pressure to weaken the check until it stops
 * firing, which is how a safety feature dies. The warn state is loud and the confirm dialog restates
 * the amount behind a checkbox, and that is where the friction belongs.
 *
 * ON SALDO NOTHING IS CHECKED AND NO FIGURE IS SHOWN. The payload still carries a `driftMinor`, and
 * on the recorded one-rate fixture it is CHF -532.29 sitting right beside `applicable: false`.
 * Printing it would report a discrepancy the engine explicitly declined to compute.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';

import { useT, formatMoney } from '../../i18n';
import { CheckGlyph, ChevronGlyph, WarnGlyph } from './glyphs';
import type { Bridge } from './model';

export interface AbstimmungProps {
  bridge: Bridge;
  currency: string;
  /** The drill-down into the movements the bridge could not attribute. */
  onInvestigate: () => void;
}

export function Abstimmung({ bridge, currency, onInvestigate }: AbstimmungProps) {
  const t = useT();
  const bodyId = useId();
  // Collapsed when there is nothing to look at, open when there is. The bridge is not a panel the
  // operator has to remember to open on the one occasion it matters.
  const [open, setOpen] = useState(bridge.kind === 'open');
  const warn = bridge.kind === 'open';

  const verdict =
    bridge.kind === 'match'
      ? t('vat.return.recon.match')
      : bridge.kind === 'open'
        ? t('vat.return.recon.open', { amount: formatMoney(bridge.unexplainedMinor, currency) })
        : bridge.kind === 'noAccount'
          ? t('vat.return.recon.noAccountShort')
          : t('vat.return.recon.notApplicableShort');

  // The non-check and the missing account have no arithmetic to disclose, so they render as one
  // line with no disclosure control at all rather than as a triangle over an empty panel.
  const expandable = bridge.kind === 'match' || bridge.kind === 'open';

  return (
    <section className={warn ? 'vr-recon vr-recon--warn panel' : 'vr-recon panel'}>
      <div className="vr-recon-head">
        {warn ? <WarnGlyph className="vr-recon-glyph" /> : <CheckGlyph className="vr-recon-glyph" />}
        {expandable ? (
          <button
            type="button"
            className="vr-recon-toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
          >
            <span>{verdict}</span>
            <ChevronGlyph className={open ? 'vr-chevron vr-chevron--open' : 'vr-chevron'} />
          </button>
        ) : (
          <p className="vr-recon-verdict">{verdict}</p>
        )}
      </div>

      {bridge.kind === 'notApplicable' && <p className="vr-recon-note">{t('vat.return.recon.notApplicable')}</p>}
      {bridge.kind === 'noAccount' && (
        <p className="vr-recon-note">
          {t('vat.return.recon.noAccount')}{' '}
          <Link to="/accounts">{t('vat.return.recon.noAccountCta')}</Link>
        </p>
      )}

      {expandable && open && (
        <div id={bodyId} className="vr-recon-body">
          {/* A `p`, not an `h3`: the bridge sits ABOVE the form's `h2` sections, so a heading here
              would jump h1 to h3 and then back (axe `heading-order`). It labels one group of three
              figures inside a panel, which is a caption rather than a document section. */}
          <p className="vr-recon-group">{t('vat.return.recon.group.output')}</p>
          <dl className="vr-recon-rows">
            <div className="vr-recon-row">
              <dt>{t('vat.return.recon.line399')}</dt>
              <dd className="vr-num">{formatMoney(bridge.returnMinor, currency)}</dd>
            </div>
            <div className="vr-recon-row">
              <dt>{t('vat.return.recon.booked', { account: bridge.account })}</dt>
              <dd className="vr-num">{formatMoney(bridge.bookedMinor, currency)}</dd>
            </div>
            <div className={warn ? 'vr-recon-row vr-recon-row--warn' : 'vr-recon-row'}>
              <dt>{t('vat.return.recon.unexplained')}</dt>
              <dd className="vr-num">{formatMoney(bridge.unexplainedMinor, currency)}</dd>
            </div>
          </dl>
          {/* No "explained" rows: the engine attributes nothing, so there is nothing to list. The
              copy says that plainly instead of leaving the operator to wonder where the causes are. */}
          <p className="vr-recon-note">
            {warn ? t('vat.return.recon.noCauses') : t('vat.return.recon.matchNote')}
          </p>
          {warn && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={onInvestigate}>
              {t('vat.return.recon.investigate')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
