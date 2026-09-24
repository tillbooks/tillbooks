/**
 * Permission-denied state: a padlock panel stating the missing right.
 *
 * Glyph plus text, never colour alone. The caller passes the specific right that is missing so the
 * operator knows exactly what to request; a default sentence covers the generic case.
 */
import { useT } from '../../i18n';
import { LockGlyph } from './glyphs';

export interface PermissionDeniedProps {
  /** Title copy override. Defaults to the shared no-access title. */
  title?: string;
  /** The specific missing right, or a full sentence. Defaults to the shared permission body. */
  body?: string;
  /** Optional escape hatch (e.g. "request access", "back to overview"), so the state is not a dead end. */
  action?: { label: string; onClick: () => void };
}

export function PermissionDenied({ title, body, action }: PermissionDeniedProps) {
  const t = useT();
  return (
    <div className="state-panel panel" role="note">
      <LockGlyph className="state-glyph" size={24} />
      <h2 className="state-title">{title ?? t('states.permission.title')}</h2>
      <p className="state-body">{body ?? t('states.permission.body')}</p>
      {/*
        `btn--secondary`, deliberately NOT the accent. This action is an escape hatch out of a state
        the operator should not be in ("request access", "back to overview"), not the thing the
        screen wants them to do. Spending the accent here would say "do this" about a surface they
        cannot use. A real border still makes it unmistakably interactive, never a ghost.
      */}
      {action !== undefined && (
        <button type="button" className="btn btn--secondary" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** Alias kept for callers that reach for the literal `Padlock` name. */
export const Padlock = PermissionDenied;
