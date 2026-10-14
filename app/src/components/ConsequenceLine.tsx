/**
 * C4 (D118): the ONE consequence sentence, rendered wherever a governed write is confirmed.
 *
 * A confirm dialog on the money path (post a payment, mark VAT filed) and the Vorschlag card an
 * approver clears an agent's proposal on must say the SAME thing about what the write does, because
 * it IS the same write. This component is the human-confirm half of that: it renders the engine's
 * own consequence for the verb (D156, the one catalogue in `src/core/agent/consequences.ts`, projected
 * into `command-source.generated.json`), the identical sentence the Vorschlag card and the MCP tool
 * description carry. One source, every face.
 *
 * It renders NOTHING for a verb with no engine consequence (an ungoverned write carries no engine
 * sentence, and inventing one in the Studio would be a lie the engine never made): a caller that
 * needs copy for such a confirm keeps its own. The line is quiet by law: neutral ink, a calm glyph,
 * never a coloured badge (the accent and the danger colour are spent on the action button, not here).
 */
import { useConsequence } from '../lib/approval-tiers';
import { InfoGlyph } from './states/glyphs';
import { Tooltip } from './Tooltip';
import './ConsequenceLine.css';

export interface ConsequenceLineProps {
  /** The verb whose consequence this describes, e.g. `post_entry`, `vat_mark_filed`. */
  verb: string;
  /**
   * `line` (the default, unchanged): the sentence as a quiet line. `tooltip`: an (i) icon button whose
   * real tooltip holds the SAME sentence (the A1 composer, on the owner's order; D152 amends the D118 C4
   * rendering for that surface). The sentence, its key and the null-for-ungoverned rule are identical.
   */
  variant?: 'line' | 'tooltip';
  /** `tooltip` only: the (i) button's accessible name (already localised), e.g. "Was Buchen bewirkt". */
  triggerLabel?: string;
  /**
   * `tooltip` only: an id for a hidden copy of the sentence, so the commit button beside the (i) can
   * point `aria-describedby` at the very same words.
   */
  describedById?: string;
}

export function ConsequenceLine({ verb, variant = 'line', triggerLabel, describedById }: ConsequenceLineProps) {
  const sentence = useConsequence(verb);
  if (sentence === null) return null;
  if (variant === 'tooltip') {
    return (
      <span className="consequence-tip" data-verb={verb}>
        <Tooltip content={sentence}>
          <button type="button" className="btn btn--ghost btn--icon consequence-tip-trigger" aria-label={triggerLabel}>
            <InfoGlyph size={16} />
          </button>
        </Tooltip>
        {describedById !== undefined && (
          <span id={describedById} hidden>
            {sentence}
          </span>
        )}
      </span>
    );
  }
  return (
    <p className="consequence-line" data-verb={verb}>
      <InfoGlyph className="consequence-line-glyph" size={16} />
      <span className="consequence-line-text">{sentence}</span>
    </p>
  );
}
