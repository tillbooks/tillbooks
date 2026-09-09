/**
 * C4 (D118): the ONE consequence sentence, rendered wherever a governed write is confirmed.
 *
 * A confirm dialog on the money path (post a payment, mark VAT filed) and the Vorschlag card an
 * approver clears an agent's proposal on must say the SAME thing about what the write does, because
 * it IS the same write. This component is the human-confirm half of that: it resolves the verb to its
 * dial capability (the drift-tested projection of `dialMap.ts`) and renders `agent.consequence.*`,
 * the identical catalogue string the Vorschlag card shows. One source, two faces.
 *
 * It renders NOTHING for a verb with no dial capability (an ungoverned write carries no engine
 * sentence, and inventing one in the Studio would be a lie the engine never made): a caller that
 * needs copy for such a confirm keeps its own. The line is quiet by law: neutral ink, a calm glyph,
 * never a coloured badge (the accent and the danger colour are spent on the action button, not here).
 */
import { consequenceKeyForVerb } from '../lib/approval-tiers';
import { useT } from '../i18n';
import './ConsequenceLine.css';

export interface ConsequenceLineProps {
  /** The verb whose consequence this describes, e.g. `post_entry`, `vat_mark_filed`. */
  verb: string;
}

export function ConsequenceLine({ verb }: ConsequenceLineProps) {
  const t = useT();
  const key = consequenceKeyForVerb(verb);
  if (key === null) return null;
  return (
    <p className="consequence-line" data-verb={verb}>
      <span className="consequence-line-glyph" aria-hidden="true">
        ⓘ
      </span>
      <span className="consequence-line-text">{t(key)}</span>
    </p>
  );
}
