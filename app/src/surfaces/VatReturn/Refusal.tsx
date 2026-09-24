/**
 * S6: one refusal shape, five causes.
 *
 * Defined once and used five times, so the product gives ONE answer to one kind of problem rather
 * than five improvised ones. Each says what is missing rather than what failed, and each ends in a
 * control: a refusal that leaves the operator with nothing to click is a dead end wearing an
 * explanation.
 *
 * THE FIFTH CAUSE IS NOT IN THE UX DESIGN. `abrechnung.ts` refuses an IST workspace outright with
 * `unsupported` / `ist_timing_not_implemented`, because handing an Ist filer the Soll figures would
 * be a wrong return that looks right, which is the worst outcome available on a page whose output a
 * human signs. The design's rows 3.1 and 3.2 assume Ist computes. It does not, and a surface that
 * treated the refusal as a generic error would tell the filer nothing they could act on.
 */
import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { rateLabel, type Refusal } from './model';

/**
 * EVERY REFUSAL REPLACES THE TABLE, and the design expected two of them to sit above surviving
 * figures. They cannot: `computeVatReturn` returns the refusal INSTEAD of a payload in all five
 * cases, so on a refused read there are no figures to leave on screen. Stated here rather than
 * faked with a blank table.
 *
 * THE REFUSAL DOES NOT ALWAYS COME FROM THE RETURN READ. `listVatPeriods` shares the
 * `needs_vat_config` and `permission_denied` gates and runs first, so on an unconfigured or
 * unreadable workspace it is the PERIOD list that refuses and the return read never runs. This panel
 * is the same panel either way, deliberately: the operator is being told one thing, and which of two
 * reads discovered it is not a fact they can act on.
 */
export function RefusalPanel({ refusal }: { refusal: Refusal }) {
  const t = useT();

  if (refusal.kind === 'permissionDenied') {
    return (
      <div className="state-panel panel" role="note">
        <h2 className="state-title">{t('vat.return.refusal.deniedTitle')}</h2>
        <p className="state-body">{t('vat.return.refusal.denied')}</p>
      </div>
    );
  }

  const body =
    refusal.kind === 'needsConfig'
      ? t('vat.return.needsConfig')
      : refusal.kind === 'saldoSplit'
        ? t('vat.return.saldoSplitRequired', { count: refusal.rates.length })
        : refusal.kind === 'saldoRateNotValidForPeriod'
          ? t('vat.return.saldoRateNotValid', {
              rate: refusal.rateBp === null ? '' : rateLabel(refusal.rateBp),
            })
          : t('vat.return.istNotImplemented');

  const ctaLabel =
    refusal.kind === 'needsConfig' ? t('vat.return.needsConfigCta') : t('vat.return.checkVatSettingsCta');

  return (
    <div className="state-panel panel vr-refusal" role="note">
      <h2 className="state-title">{t(`vat.return.refusal.title.${refusal.kind}`)}</h2>
      <p className="state-body">{body}</p>
      {/* The Ist refusal's citation lives in the STRUCTURED field, never inline in the sentence
          (G17 §4b / corpus-critic F8), matching the two election-surface renders of the same key.
          A SIBLING of the message paragraph, not a child (re-critic R1): the browser flow's
          `flat(.state-body textContent) === M.istNotImplemented` comparison reads the paragraph as
          the message alone, and the structured field is structurally separate copy anyway. */}
      {refusal.kind === 'istTiming' && (
        <p className="vr-refusal-cite">
          <cite className="vat-binding-cite">{t('vat.return.istNotImplementedCite')}</cite>
        </p>
      )}
      {refusal.kind === 'saldoSplit' && refusal.rates.length > 0 && (
        <ul className="vr-refusal-rates">
          {refusal.rates.map((r) => (
            <li key={r.position}>
              {t('vat.return.saldoRateRow', { position: r.position, rate: rateLabel(r.rateBp) })}
            </li>
          ))}
        </ul>
      )}
      <Link className="btn btn--secondary btn--sm" to="/vat">
        {ctaLabel}
      </Link>
    </div>
  );
}
