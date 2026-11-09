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
 * AT REST IT IS ONE LINE (D152, the owner's pick, after the bank trust line):
 *
 *   ⚠ Abstimmung MWST-Konten: CHF 4.01 ungeklärt (i) ›      or      ✓ Abstimmung MWST-Konten: stimmt überein (i) ›
 *
 * The verdict and its one figure stay on the working surface. The sentence that explains it sits
 * behind the (i), the shared Tooltip on an icon button that names it through `aria-describedby`; the
 * arithmetic (Ziff. 399, the movement on the account, the remainder) and the door into the entries sit
 * behind the chevron, a disclosure the operator opens on purpose. It used to open itself on a
 * difference; under "A list never opens itself" it no longer does, and the warn glyph and the word
 * "ungeklärt" on the line are what make the difference impossible to miss. The confirm dialog still
 * restates the amount behind its checkbox, which is where W2 put the friction. The non-check (Saldo)
 * and the missing account have no arithmetic, so they carry no chevron and no glyph: their words say
 * what they are, and their sentence is behind the (i).
 *
 * ON SALDO NOTHING IS CHECKED AND NO FIGURE IS SHOWN. The payload still carries a `driftMinor`, and
 * on the recorded one-rate fixture it is CHF -532.29 sitting right beside `applicable: false`.
 * Printing it would report a discrepancy the engine explicitly declined to compute.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';

import { useT, useTRich, formatMoney } from '../../i18n';
import { Tooltip } from '../../components/Tooltip';
import { InfoGlyph } from '../../components/states/glyphs';
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
  const tRich = useTRich();
  const bodyId = useId();
  // Closed on load, in every state (D152 rule 5). The warn glyph and the words carry a difference.
  const [open, setOpen] = useState(false);
  const warn = bridge.kind === 'open';

  const verdict =
    bridge.kind === 'match'
      ? t('vat.return.recon.match')
      : bridge.kind === 'open'
        ? tRich('vat.return.recon.open', {
            amount: <span className="t-money">{formatMoney(bridge.unexplainedMinor, currency)}</span>,
          })
        : bridge.kind === 'noAccount'
          ? t('vat.return.recon.noAccountShort')
          : t('vat.return.recon.notApplicableShort');

  const explain =
    bridge.kind === 'match'
      ? t('vat.return.recon.matchNote')
      : bridge.kind === 'open'
        ? t('vat.return.recon.noCauses')
        : bridge.kind === 'noAccount'
          ? t('vat.return.recon.noAccount')
          : t('vat.return.recon.notApplicable');

  // The non-check and the missing account have no arithmetic to disclose, so they carry no chevron.
  const expandable = bridge.kind === 'match' || bridge.kind === 'open';

  return (
    <div className={warn ? 'vr-recon vr-recon--warn' : 'vr-recon'}>
      <p className="vr-recon-line">
        {warn && <WarnGlyph className="vr-recon-glyph" />}
        {bridge.kind === 'match' && <CheckGlyph className="vr-recon-glyph" />}
        <span className="vr-recon-verdict">{verdict}</span>
        <span className="vr-recon-info">
          <Tooltip placement="bottom" content={explain}>
            <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={t('vat.return.recon.info')}>
              <InfoGlyph size={16} />
            </button>
          </Tooltip>
        </span>
        {bridge.kind === 'noAccount' && (
          <Link className="link-inline" to="/accounts">{t('vat.return.recon.noAccountCta')}</Link>
        )}
        {expandable && (
          <button
            type="button"
            className={`btn btn--ghost btn--icon btn--sm vr-recon-toggle${open ? ' vr-recon-toggle--on' : ''}`}
            aria-label={t('vat.return.recon.disclosure')}
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronGlyph className="vr-chevron" size={16} />
          </button>
        )}
      </p>

      {expandable && (
        <div id={bodyId} className="vr-recon-body panel" hidden={!open}>
          {/* A `p`, not an `h3`: the bridge sits ABOVE the form's `h2` sections, so a heading here
              would jump h1 to h3 and then back (axe `heading-order`). It labels one group of three
              figures inside a panel, which is a caption rather than a document section. */}
          <p className="vr-recon-group">{t('vat.return.recon.group.output')}</p>
          <dl className="vr-recon-rows">
            <div className="vr-recon-row">
              <dt>{t('vat.return.recon.line399')}</dt>
              <dd className="vr-num t-money">{formatMoney(bridge.returnMinor, currency)}</dd>
            </div>
            <div className="vr-recon-row">
              <dt>{t('vat.return.recon.booked', { account: bridge.account })}</dt>
              <dd className="vr-num t-money">{formatMoney(bridge.bookedMinor, currency)}</dd>
            </div>
            <div className={warn ? 'vr-recon-row vr-recon-row--warn' : 'vr-recon-row'}>
              <dt>{t('vat.return.recon.unexplained')}</dt>
              <dd className="vr-num t-money">{formatMoney(bridge.unexplainedMinor, currency)}</dd>
            </div>
          </dl>
          {/* No "explained" rows: the engine attributes nothing, so there is nothing to list. The
              (i) on the line says so plainly instead of leaving the operator to wonder. */}
          {warn && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={onInvestigate}>
              {t('vat.return.recon.investigate')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
