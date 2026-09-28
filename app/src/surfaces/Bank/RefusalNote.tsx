/**
 * A refusal, in place, with its one fix: WHAT happened (the title), WHY (the body) and the control
 * that recovers, right under the thing that was refused. The typed input stays exactly where it was
 * (the canon's "a failed action never destroys entered input"). A code `errors.ts` cannot explain,
 * and any refusal only the shared catalogue may word (`sharedRefusalKey`), gives way to the shared
 * `ErrorBanner`, which offers "Diesen Fehler melden" (G08).
 */
import { Link } from 'react-router-dom';

import type { Err } from '../../lib/client';
import { useT } from '../../i18n';
import { ErrorBanner } from '../../components/states';
import { AlertGlyph } from '../../components/states/glyphs';
import { explainRefusal, type RefusalAction, type RefusalContext } from './errors';

export interface RefusalNoteProps {
  error: Err;
  context: RefusalContext;
  /** Runs the fix the refusal names (accept the difference, show the other line, ...). */
  onAction?: (action: RefusalAction) => void;
}

export function RefusalNote({ error, context, onAction }: RefusalNoteProps) {
  const t = useT();
  const refusal = explainRefusal(t, error, context);
  if (refusal.unmapped) return <ErrorBanner error={error} />;
  const action = refusal.action;
  return (
    <div className="bank-refusal" role="alert" data-code={refusal.code}>
      <AlertGlyph className="bank-refusal__glyph" size={20} />
      <div className="bank-refusal__content">
        <p className="bank-refusal__title">{refusal.title}</p>
        {refusal.body !== null && <p className="bank-refusal__body">{refusal.body}</p>}
        {action !== null &&
          (action.kind === 'link' ? (
            <Link className="btn btn--secondary btn--sm bank-refusal__action" to={action.to}>
              {action.label}
            </Link>
          ) : (
            <button type="button" className="btn btn--secondary btn--sm bank-refusal__action" onClick={() => onAction?.(action)}>
              {action.kind === 'ignore'
                ? t('bankInbox.error.action.ignore')
                : action.kind === 'match-entry'
                  ? t('bankInbox.error.action.matchEntry')
                  : action.kind === 'accept-difference'
                  ? t('bankInbox.error.action.acceptDifference')
                  : action.kind === 'leave-open'
                    ? t('bankInbox.error.action.leaveOpen')
                  : action.kind === 'show-line'
                    ? t('bankInbox.error.action.showLine')
                    : action.kind === 'import-for'
                      ? t('bankInbox.error.action.importFor', { name: action.name })
                      : t('bankInbox.error.action.reload')}
            </button>
          ))}
      </div>
    </div>
  );
}
