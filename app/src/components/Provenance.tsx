/**
 * C3 (D118): the quiet provenance line, one component for every detail view.
 *
 * A35 already records WHO did a thing and by which verb; the surfaces never showed it. This is that
 * fact, placed at the point of judgement (the detail, not a glyph column on every list row, which
 * would be a wall of noise no one reads). It answers three questions and no more: who acted (a member
 * seat, or the agent), by what act and when, and where the full A35 trace is.
 *
 * IT IS QUIET BY LAW (brand DESIGN.md, and the audit's own wording): neutral ink, a calm glyph, never
 * a coloured badge. An agent origin is named in words ("durch den Agenten"), never signalled by
 * colour alone. The trace link renders ONLY when a trace exists (an agent-authored row); a plain
 * human edit carries actor and time and no link, because there is no agent trace to point at.
 */
import { Link } from 'react-router-dom';

import { useT, formatDate } from '../i18n';
import { AgentMarkGlyph, PointGlyph } from './icons';
import './Provenance.css';

/** Who a row came from. `import` is a migrated row; `unknown` is an actor the read did not name. */
export type ProvenanceOrigin = 'human' | 'agent' | 'import' | 'unknown';

export interface ProvenanceProps {
  origin: ProvenanceOrigin;
  /** The acting member seat, or null when the read model does not name one. */
  actor?: string | null;
  /**
   * The act, humanized by the caller (a verb label or a short phrase like "Entwurf angenommen"). It
   * is shown parenthetically after the actor. Optional: absent when the surface has only who and when.
   */
  action?: string | null;
  /** ISO date or datetime. Rendered as TT.MM.JJJJ; anything shorter than a date is shown verbatim. */
  timestamp: string;
  /**
   * A link INTO the A35 trace for an agent-authored row (e.g. `/agent?session=...`). Rendered only
   * when present, so a human edit shows no link. When absent on an agent origin, no link is invented.
   */
  traceHref?: string;
}

/** TT.MM.JJJJ for a real ISO date; the raw value for anything the formatter cannot parse. */
function shownDate(timestamp: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(timestamp) ? formatDate(timestamp.slice(0, 10)) : timestamp;
}

export function Provenance({ origin, actor, action, timestamp, traceHref }: ProvenanceProps) {
  const t = useT();

  // Who: the agent is named in words; a human/import row names its seat when the read gave one.
  // The D13 `studio` seat is a transport, not a person, and printing its raw key ("Erfasst durch
  // studio", J3.5) is the DESIGN.md "humanize machine labels" violation; it is named in words. A
  // real member seat (a name, or a served `member:` id the read model chose to send) renders as sent.
  const who =
    origin === 'agent'
      ? t('provenance.byAgent')
      : origin === 'import'
        ? t('provenance.byImport')
        : actor === 'studio'
          ? t('provenance.byStudio')
          : actor !== null && actor !== undefined && actor !== ''
            ? t('provenance.byActor', { actor })
            : t('provenance.byUnknown');

  return (
    <p className="provenance" data-origin={origin}>
      {origin === 'agent' ? (
        <AgentMarkGlyph className="provenance-glyph" size={16} />
      ) : (
        <PointGlyph className="provenance-glyph" size={16} />
      )}
      <span className="provenance-text">
        {who}
        {action !== null && action !== undefined && action !== '' ? ` (${action})` : ''}
        {', '}
        {shownDate(timestamp)}
      </span>
      {traceHref !== undefined && (
        <Link className="provenance-trace" to={traceHref}>
          {t('provenance.trace')}
        </Link>
      )}
    </p>
  );
}
