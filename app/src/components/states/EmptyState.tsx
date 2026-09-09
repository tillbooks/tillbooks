/**
 * Empty state: says what this is and what to do first, never a bare "No data".
 *
 * Copy comes from i18n keys (defaults) or explicit strings passed by the caller. An optional action
 * (label + handler) invites the first step. The glyph is decorative; the text carries the meaning.
 */
import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { InboxGlyph } from './glyphs';

/** An in-place first step (open a drawer, seed a table). */
export interface EmptyActionButton {
  label: string;
  onClick: () => void;
}

/** A first step that lives on another surface, e.g. "set up a workspace" pointing at `/setup`. */
export interface EmptyActionLink {
  label: string;
  to: string;
}

export type EmptyAction = EmptyActionButton | EmptyActionLink;

function isLink(action: EmptyAction): action is EmptyActionLink {
  return 'to' in action;
}

export interface EmptyStateProps {
  /** Title copy, or an i18n key resolved by the caller. Defaults to the shared empty title. */
  title?: string;
  /** What-to-do-first copy. Defaults to the shared empty hint. */
  hint?: string;
  /** The first action. A handler for an in-place step, a `to` route for a step on another surface. */
  action?: EmptyAction;
}

export function EmptyState({ title, hint, action }: EmptyStateProps) {
  const t = useT();
  return (
    <div className="state-panel panel">
      <InboxGlyph className="state-glyph" size={24} />
      <h2 className="state-title">{title ?? t('states.empty.title')}</h2>
      <p className="state-body">{hint ?? t('states.empty.hint')}</p>
      {/*
        `btn--secondary`, by owner decision (D21, chosen over an Artifact showing both variants).
        Every state panel (empty and permission-denied alike) wears the same quiet button, and the
        accent stays reserved for the surfaces' own primary actions. The CTA still reads as a real
        control (surface fill, strong border), and since a state panel shows exactly one action,
        prominence relative to siblings is not in play.
      */}
      {action !== undefined &&
        (isLink(action) ? (
          <Link className="btn btn--secondary" to={action.to}>
            {action.label}
          </Link>
        ) : (
          <button type="button" className="btn btn--secondary" onClick={action.onClick}>
            {action.label}
          </button>
        ))}
    </div>
  );
}
