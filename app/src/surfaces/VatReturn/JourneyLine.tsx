/**
 * The journey at rest, in ONE line (D152, the owner's pick for this surface):
 *
 *   Schritt 3 von 6: exportieren (i) ›
 *
 * The line names the NEXT thing the filer does, derived by `journeyPosition` from facts the surface
 * already holds (the figures, the export verb's answer or the G22 evidence, the attestation, the
 * `vat_filed` lock, the A38 settlement). The sentence that explains the step sits behind the (i), the
 * shared Tooltip on an icon button that names it through `aria-describedby` (DESIGN.md "Words on
 * demand"). The full six-step strip, with its done words, the G22 dates and "Zur Checkliste", sits
 * behind the chevron, a disclosure the filer opens on purpose ("A list never opens itself").
 *
 * STEP 4 STAYS THE DOOR OUT (owner decision W4). When step 4 is the next step, its words on the line
 * ARE the ePortal link, so the one handoff the surface is built around is on the working surface the
 * moment it matters. In every other state the link is one chevron away, inside the strip, unchanged.
 *
 * A RUNNING PERIOD says so on the line ("Periode läuft noch"), and the (i) adds why "Als eingereicht
 * markieren" is not offered yet: the sentence that used to sit under the strip as its own paragraph.
 */
import { useId, useState } from 'react';

import { useT, useTRich } from '../../i18n';
import { Tooltip } from '../../components/Tooltip';
import { InfoGlyph } from '../../components/states/glyphs';
import { CheckGlyph, ChevronGlyph, ExternalGlyph } from './glyphs';
import { JourneyStrip, type JourneyRun } from './JourneyStrip';
import { journeyPosition } from './model';
import type { SettlementState } from './Settlement';

export interface JourneyLineProps {
  /** Step 1 behind: the figures are on screen. */
  computed: boolean;
  /** Step 2 done in the strip: the bridge resolved and left nothing unexplained. */
  checked: boolean;
  /** The export verb answered with a file for this period, in this session. */
  exportedNow: boolean;
  /** Step 5 behind: the period carries a filing lock. */
  marked: boolean;
  /** The period has not ended yet. */
  running: boolean;
  run: JourneyRun | null;
  settlement: SettlementState | null;
}

export function JourneyLine({ computed, checked, exportedNow, marked, running, run, settlement }: JourneyLineProps) {
  const t = useT();
  const tRich = useTRich();
  const [open, setOpen] = useState(false);
  const moreId = useId();

  const { step, total } = journeyPosition({
    computed,
    exported: exportedNow || (run?.exportedAt ?? null) !== null,
    attested: (run?.attestedAt ?? null) !== null,
    marked,
    settlement,
  });

  const why = step === null ? t(`vat.return.steps.why.done${total}`) : t(`vat.return.steps.why.${step}`);
  const explain = running && !marked ? `${why} ${t('vat.return.periodNotEnded')}` : why;

  return (
    <div className="vr-steps">
      <p className="vr-steps-line">
        {step === null ? (
          <>
            <CheckGlyph className="vr-steps-glyph" />
            <span className="vr-steps-words">{t('vat.return.steps.allDone', { total })}</span>
          </>
        ) : step === 4 ? (
          <span className="vr-steps-words">
            {tRich('vat.return.steps.line', {
              n: step,
              total,
              step: (
                <a className="vr-step-link link-inline" href={t('vat.return.journey.portalUrl')} target="_blank" rel="noreferrer noopener">
                  {t('vat.return.steps.next.4')}
                  <ExternalGlyph className="vr-step-external" size={14} />
                </a>
              ),
            })}
          </span>
        ) : (
          <span className="vr-steps-words">{t('vat.return.steps.line', { n: step, total, step: t(`vat.return.steps.next.${step}`) })}</span>
        )}
        {running && !marked && <span className="vr-steps-running">{t('vat.return.steps.running')}</span>}
        <span className="vr-steps-info">
          <Tooltip placement="bottom" content={explain}>
            <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={t('vat.return.steps.info')}>
              <InfoGlyph size={16} />
            </button>
          </Tooltip>
        </span>
        <button
          type="button"
          className={`btn btn--ghost btn--icon btn--sm vr-steps-toggle${open ? ' vr-steps-toggle--on' : ''}`}
          aria-label={t('vat.return.steps.disclosure')}
          aria-expanded={open}
          aria-controls={moreId}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronGlyph className="vr-chevron" size={16} />
        </button>
      </p>
      <div id={moreId} className="vr-steps-more" hidden={!open}>
        <JourneyStrip computed={computed} checked={checked} marked={marked} run={run} settlement={settlement} />
      </div>
    </div>
  );
}
