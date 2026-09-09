/**
 * R-S9, the reconciliation: one line when it holds, a band that names the failing check when it does
 * not. The most important element on this surface and the easiest to get wrong.
 *
 * FOUR RULES GOVERN IT, and two of them overrule A08 §6.
 *
 * 1. PER NAMED CHECK, not one badge. The engine returns `reconciles` (an AND) and `reconciliation`,
 *    an object of named booleans that differ per report. The passing state collapses them into one
 *    sentence, because seven green ticks is noise. The failing state does not: a Bilanz whose Aktiven
 *    and Passiven differ is a bucketing bug in the report, and a Bilanz whose ledger does not net to
 *    zero is a corrupt database. `statements.ts:30-36` says so explicitly, and the two need different
 *    sentences because they are different problems.
 *
 * 2. THE PASSING STATE CARRIES NO COLOUR. A08 §6 asks for a "teal CheckCircle, the one accent". That
 *    contradicts `brand/DESIGN.md`, where the accent budget is three items and status "neither borrows
 *    the accent": colour is spent on attention and an all-clear is not attention. This is the same
 *    call the A16/A19 slice made against the same instruction, and making it the same way twice is
 *    what "one design language" means in practice.
 *
 * 3. WHEN A CHECK FAILS THE LINE IS REPLACED, not recoloured. One status, one place, one treatment.
 *    The figures below still render: they are the truth about the rows, and hiding them would leave
 *    the operator with a problem and no evidence.
 *
 * 4. THE WORDING NEVER PROMISES MORE THAN THE CHECK PERFORMED. The passing sentence is "Stimmt mit
 *    dem Journal überein", a comparison that held. Never "geprüft", "korrekt", "verifiziert" or
 *    "OR-konform": the flags compare two derivations over the same rows, and a green reconciliation
 *    "is not evidence that an account sits in the RIGHT section". A07 shipped four filing-grade
 *    defects that every one of them reported `reconciled: true`.
 *
 * NEITHER STATE IS COLOUR-ONLY OR GLYPH-ONLY. Glyph plus words, always, so the whole thing survives
 * the grayscale printout that is a real Treuhänder artefact.
 *
 * NO FIGURE IS COMPUTED HERE. The A08 design's copy deck interpolated a `{difference}` into two of
 * the mismatch sentences, and the engine returns no difference on any of the four reports: only
 * booleans. Deriving one in the browser would be the GUI doing arithmetic on money, which this
 * surface refuses everywhere else (INV-9). So the sentences name what happened and where to look, and
 * the figures the operator needs are on the statement below.
 */
import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { HelpHint } from '../../components/HelpHint';
import { AlertGlyph, CheckGlyph } from './glyphs';
import { failedChecks, mismatchKey, reconciledKey, type ReportTab } from './model';

export interface ReconciliationProps {
  tab: ReportTab;
  reconciles: boolean;
  reconciliation: Record<string, boolean>;
}

/** The passing line: a glyph, one sentence, and the hint that says what it does NOT prove (R21). */
export function ReconciledLine({ tab }: { tab: ReportTab }) {
  const t = useT();
  const sentence = t(reconciledKey(tab));
  return (
    <p className="rp-reconciled">
      <CheckGlyph className="rp-reconciled-glyph" aria-label={sentence} />
      <span>{sentence}</span>
      <HelpHint
        label={t('reports.reconciled.hintLabel')}
        title={t('reports.reconciled.hintTitle')}
        body={t('reports.reconciled.hintBody')}
      />
    </p>
  );
}

/** R-S9's band: which check failed, what that specific failure means, and the one way out. */
export function ReconciliationBand({ reconciliation }: { reconciliation: Record<string, boolean> }) {
  const t = useT();
  const failed = failedChecks(reconciliation);
  if (failed.length === 0) return null;
  return (
    <div className="rp-mismatch" role="status">
      <p className="rp-mismatch-head">
        <AlertGlyph className="rp-mismatch-glyph" aria-label={t('reports.mismatch.title')} />
        <span>{t('reports.mismatch.title')}</span>
      </p>
      <ul className="rp-mismatch-list">
        {failed.map((check) => (
          <li key={check}>{t(mismatchKey(check))}</li>
        ))}
      </ul>
      <Link className="btn btn--secondary btn--sm" to="/journal">
        {t('reports.mismatch.action')}
      </Link>
    </div>
  );
}

/** The one element the shell renders: the line, or the band, never both and never neither. */
export function Reconciliation({ tab, reconciles, reconciliation }: ReconciliationProps) {
  return reconciles ? <ReconciledLine tab={tab} /> : <ReconciliationBand reconciliation={reconciliation} />;
}
