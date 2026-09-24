/**
 * Error state: says what failed and what the operator can do, never a stack trace.
 *
 * Accepts an engine rejection `Err` (`{ ok:false, error, ... }`) and maps its `error` code to a
 * friendly i18n message under `errors.<code>`, falling back to `errors.fallback`. `role="alert"`
 * announces it to assistive tech.
 *
 * ONE GLYPH, ONE GROUND (K-35, D137). The banner used to open with a warning triangle AND a text "!",
 * inside a red box: two exclamation marks and a border shouting over the page. Now the glyph alone
 * carries the danger colour (so the state is still never colour alone: a shape and the words), the
 * title reads in the text ink at 600, and the banner lies on `--t-danger-soft` with no border. Retry
 * and "Report this error" sit in one row, 16px apart.
 *
 * READ OR WRITE (K-35). A failed WRITE is "Aktion fehlgeschlagen" and its generic sentence asks the
 * person to check their input. A failed READ has no input to check: the Übersicht tiles answered a
 * page load with "prüfe die Eingaben". `context="read"` gives a read its own title and its own
 * generic sentence; `DataTable` passes it, because a table's error is always its read.
 *
 * G08 §6: it also carries **Report this error**, and it reads the feedback context ITSELF rather
 * than taking an `onReport` prop, which is what keeps its 19 call sites untouched. The offer is not
 * unconditional. It appears for
 *
 *   - the `DEFECT_SHAPED_CODES` from `src/core/support/redact.ts`, imported rather than mirrored so
 *     the Studio and the engine cannot drift on what counts as a defect, and
 *   - any code with no `errors.<code>` message at all, which today renders the generic fallback
 *     sentence with **no way out whatsoever**.
 *
 * A mistyped field keeps its own recovery and gets no report link: journaling every rejection would
 * bury one real defect under a hundred form validations, and offering to report one would train the
 * person to ignore the offer.
 */
import { isDefectShaped } from '../../../../src/core/support/redact.js';
import type { Err } from '../../lib/client';
import { useI18n } from '../../i18n';
import { useFeedback } from '../FeedbackProvider';
import { AlertGlyph } from './glyphs';
import './states.css';

/** What failed: a write the person asked for, or a read the page made on its own. */
export type ErrorContext = 'action' | 'read';

export interface ErrorBannerProps {
  /** The engine rejection to explain. Its `error` code drives the friendly message. */
  error?: Err;
  /** Override the mapped body copy entirely. */
  message?: string;
  /** Optional retry affordance. */
  onRetry?: () => void;
  /**
   * A failed write (`action`, the default) or a failed read (`read`): decides the title and the
   * generic sentence an unmapped code falls back to. A read never asks the person to check input.
   */
  context?: ErrorContext;
}

export function ErrorBanner({ error, message, onRetry, context = 'action' }: ErrorBannerProps) {
  const { t } = useI18n();
  const feedback = useFeedback();
  const code = error?.error;
  const fallbackKey = context === 'read' ? 'errors.read_fallback' : 'errors.fallback';
  const body = message ?? (code !== undefined ? t(`errors.${code}`) : t(fallbackKey));
  // A key that has no dedicated message falls back to the generic sentence, never the raw code.
  const unmapped = body === `errors.${code}`;
  const resolved = unmapped ? t(fallbackKey) : body;
  const title = t(context === 'read' ? 'states.error.readTitle' : 'states.error.title');

  // The unmapped case is the one that most needs the offer: the generic sentence is all the person
  // gets, and without this there is nothing else on the banner at all.
  const reportable =
    feedback !== null && code !== undefined && (isDefectShaped(code) || unmapped);

  return (
    <div className="error-banner panel" role="alert" data-context={context}>
      <AlertGlyph className="error-glyph" size={20} />
      <div className="error-content">
        <p className="error-title">{title}</p>
        <p className="error-body">{resolved}</p>
        {(onRetry !== undefined || reportable) && (
          <div className="error-actions">
            {onRetry !== undefined && (
              <button type="button" className="error-retry" onClick={onRetry}>
                {t('states.error.retry')}
              </button>
            )}
            {reportable && (
              <button
                type="button"
                className="error-report"
                onClick={() =>
                  feedback.open({
                    kind: 'bug',
                    subject: t('errors.report_this'),
                    // Codes and names only. The banner has no exception object and no route pattern
                    // to hand over, so nothing is invented to fill the gap.
                    clientError: { kind: 'verb_error', code },
                  })
                }
              >
                {t('errors.report_this')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
