/**
 * The five-step journey, and step 4 is the door out of the product.
 *
 * WHY A PROGRESS STRIP EARNS ITS SPACE ON EXACTLY THIS SURFACE. There is no ESTV submission API and
 * there never has been: eCH-0217 is a file FORMAT, not a transport. So step 4 of 5 happens in a
 * browser tab on a government portal, and TILL cannot observe it. Without the strip, "Als
 * eingereicht markieren" reads like a Submit button, which is the single most damaging misreading
 * available on this screen.
 *
 * ONLY THREE STEPS CAN EVER RENDER AS DONE, and that is the point rather than a limitation:
 *
 *   1 berechnet   the return came back with figures                       observable
 *   2 geprüft     the bridge resolved AND nothing is unexplained          observable
 *   3 exportiert  NEVER done: a browser download does not report back     not observable
 *   4 eingereicht NEVER done: estv.admin.ch does not report back          not observable
 *   5 markiert    a hard period lock with reason `vat_filed` exists       observable
 *
 * Rendering "exportiert" with a tick off a click on a download button would be a small lie of
 * exactly the kind the data-honesty rule exists to stop. Steps 3 and 4 are therefore rendered as
 * steps in a process, not as achievements.
 *
 * STEP 4 IS ITSELF THE LINK (owner decision W4). An earlier draft put it in the overflow menu, which
 * made the one handoff the whole surface is built around the hardest thing on the screen to find.
 * The URL lives in the i18n file so it can be corrected without a code change.
 */
import { Link } from 'react-router-dom';

import { useT, formatDate } from '../../i18n';
import { ExternalGlyph } from './glyphs';
import type { SettlementState } from './Settlement';

/** Who stood behind the attestation: the D13 seat kind, or a served member with the display name A24 knows. */
export interface JourneyActor {
  kind: string;
  name: string | null;
}

/**
 * The G22 checklist run for the shown period (D127), when one exists. `exportedAt` is the ISO day the
 * ENGINE recorded the export evidence (`checklist_item_complete` re-ran the export and bound its hash),
 * never a download click; `attestedAt` is the date the human stood behind in the Attest dialog, and
 * `attestedBy` who they were.
 */
export interface JourneyRun {
  runId: string;
  exportedAt: string | null;
  attestedAt: string | null;
  /** The attesting actor, null when no live attestation exists. Spec §6: "bestätigt am {date} durch {actor}". */
  attestedBy: JourneyActor | null;
}

export interface JourneyStripProps {
  /** Step 1: the figures are on screen. */
  computed: boolean;
  /** Step 2: the bridge resolved and left nothing unexplained. */
  checked: boolean;
  /** Step 5: the period carries a filing lock. */
  marked: boolean;
  /** The checklist run for this period. Absent or null: the strip renders exactly as before. */
  run?: JourneyRun | null;
  /**
   * Step 6 (A38, D129 leg 2): the MWST-Saldierung of the filed period, rendered only when the
   * surface hands the panel's state over. Absent or null: five steps, exactly as before, because a
   * workspace whose settlement read refused has no sixth step to show and no sixth step to fake.
   */
  settlement?: SettlementState | null;
}

const FIVE_STEPS = ['1', '2', '3', '4', '5'] as const;
const SIX_STEPS = ['1', '2', '3', '4', '5', '6'] as const;

export function JourneyStrip({ computed, checked, marked, run = null, settlement = null }: JourneyStripProps) {
  const t = useT();
  // Step 3 is done ONLY off the engine's recorded verb evidence (plan finding 1): the file the
  // checklist bound, not the button that downloaded one. Step 4 is never done: it is attested.
  const exportedAt = run?.exportedAt ?? null;
  const attestedAt = run?.attestedAt ?? null;
  const attestedBy = run?.attestedBy ?? null;
  // The actor in words, the way the run detail resolves it: a member by name, a seat by its kind
  // (DESIGN.md C3: an agent origin is named, a machine id never reaches the screen).
  const who = (actor: JourneyActor | null): string =>
    actor !== null && actor.kind === 'member' && actor.name !== null ? actor.name : t(`vat.return.journey.actor.${actor?.kind ?? 'unknown'}`);
  // Step 6 is done off the ENGINE's settlement row (the posted date), never off a button click.
  const settledAt = settlement !== null && settlement.posted ? settlement.postedAt : null;
  const done: Record<string, boolean> = { '1': computed, '2': checked, '3': exportedAt !== null, '4': false, '5': marked, '6': settledAt !== null };
  const steps: readonly string[] = settlement === null ? FIVE_STEPS : SIX_STEPS;
  const portalUrl = t('vat.return.journey.portalUrl');

  return (
    <>
      <ol className="vr-journey" aria-label={t('vat.return.journey.label')}>
        {steps.map((step) => {
          const isDone = done[step] === true;
          const label = t(`vat.return.journey.${step}`);
          const mark =
            step === '3' && exportedAt !== null
              ? t('vat.return.journey.exportedAt', { date: formatDate(exportedAt) })
              : step === '4' && attestedAt !== null
                ? t('vat.return.journey.attestedAt', { date: formatDate(attestedAt), who: who(attestedBy) })
                : step === '6' && settledAt !== null
                  ? t('vat.return.journey.settledAt', { date: formatDate(settledAt) })
                  : isDone
                    ? t('vat.return.journey.done')
                    : null;
          return (
            <li key={step} className={isDone ? 'vr-step vr-step--done' : 'vr-step'} data-attested={step === '4' && attestedAt !== null ? 'true' : undefined}>
              <span className="vr-step-no" aria-hidden="true">
                {step}
              </span>
              {step === '4' ? (
                <a className="vr-step-link" href={portalUrl} target="_blank" rel="noreferrer noopener">
                  {label}
                  <ExternalGlyph className="vr-step-external" size={14} />
                </a>
              ) : (
                <span className="vr-step-label">{label}</span>
              )}
              {/* The done marker is a WORD, not a colour and not a tick alone. */}
              {mark !== null && <span className="vr-step-done-mark">{mark}</span>}
            </li>
          );
        })}
      </ol>
      {run !== null && (
        <p className="vr-journey-run">
          <Link to={`/checklisten?run=${encodeURIComponent(run.runId)}`}>{t('vat.return.journey.openRun')}</Link>
        </p>
      )}
    </>
  );
}
