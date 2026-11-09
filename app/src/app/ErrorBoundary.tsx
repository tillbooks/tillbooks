/**
 * G08 §2 US-G08.7, the global render boundary.
 *
 * Nothing like this exists today, so a throw inside any surface blanks the document: no message, no
 * reload, no way to tell anyone. This catches it and renders a recoverable panel with **Reload** and
 * **Report this error**.
 *
 * The row the whole design turns on is the one where the engine is unreachable. A crash reporter
 * that needs a working backend to report a broken backend is not a crash reporter, so the report and
 * the `mailto:` URI are composed ENTIRELY IN THE BROWSER, by the same `redactEntry` and
 * `renderReport` the engine calls. Both modules are free of `node:` imports precisely so this works,
 * and the dialog is opened with `localOnly`, which means it calls no verb at all and says plainly
 * that nothing was saved to disk.
 *
 * What travels is `error.name` and install-relative stack FRAMES. `error.message` is dropped,
 * always: `guarded()` attaches `message: e.message` to every `unexpected_error`, and an exception
 * raised inside a posting path can carry an amount, a counterparty name or an IBAN in that string.
 * Dropping it is `redactEntry`'s job, not this file's, which is why the error object is handed
 * straight to it rather than picked apart here. A throw that is not an `Error` (a string, a plain
 * object) records `<non-error>` rather than `undefined`.
 */
import { Component, type ReactNode } from 'react';
import { useRouteError } from 'react-router-dom';

import { redactEntry, type DiagnosticEntry } from '../../../src/core/support/redact.js';
import { useT } from '../i18n';
import { useFeedback } from '../components/FeedbackProvider';
import { AlertGlyph } from '../components/states/glyphs';

/**
 * The browser's install root.
 *
 * `redactEntry` collapses every frame outside it to `<external>`, which in a bundle means anything
 * not served by this origin. It is the browser's analogue of the package root the engine passes: an
 * absolute frame is what would otherwise carry a path, and a path is what carries a username.
 */
function installRoot(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** Redact a caught throw into the bounded entry shape. The only place the Studio does this. */
export function diagnosticFor(error: unknown, surface: string | undefined, at: string): DiagnosticEntry {
  return redactEntry(
    { kind: 'unhandled_exception', at, surface, error },
    { installRoot: installRoot() },
  );
}

/**
 * The panel itself. A function component, so it can read i18n and the feedback context; the class
 * below exists only because catching a render throw still requires one.
 */
function CrashPanel({ diagnostic }: { diagnostic: DiagnosticEntry }) {
  const t = useT();
  const feedback = useFeedback();

  return (
    <div className="crash-panel panel" role="alert">
      <div className="crash-head">
        {/* Glyph AND text. A crash announced by a red box alone reads as nothing in grayscale. */}
        <AlertGlyph className="crash-glyph" size={24} />
        <h1 className="crash-title">{t('crash.title')}</h1>
      </div>
      <p className="crash-body">{t('crash.body')}</p>
      <div className="crash-foot">
        <button type="button" className="btn btn--secondary" onClick={() => window.location.reload()}>
          {t('crash.action.reload')}
        </button>
        {feedback !== null && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() =>
              feedback.open({
                kind: 'bug',
                subject: t('crash.title'),
                diagnostic,
                // No verb is called: the engine is exactly what may be broken here.
                localOnly: true,
              })
            }
          >
            {t('crash.action.report')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The route-level crash element, and the reason it has to exist.
 *
 * `ErrorBoundary` below wraps `<RouterProvider>` from the OUTSIDE, and React Router catches a route
 * render throw before it can ever reach an ancestor boundary. So until this landed, a real crash
 * rendered the router's own developer page: "Unexpected Application Error!", an English stack, ten
 * frames of bundler internals, and a note addressed to "Hey developer". No reload, no report link,
 * no shell, no theme. US-G08.7 could not complete.
 *
 * The `ErrorBoundary` unit test passed throughout, because it mounts the boundary directly around a
 * throwing child, which is the one arrangement the real application never has. It took running the
 * app to see it, which is the whole argument for the /ux-architect gate.
 *
 * Both paths now render the SAME panel: this one for anything inside the route tree, the class for
 * anything outside it (a provider throwing during its own render).
 */
export function RouteCrash() {
  const error = useRouteError();
  const at = new Date().toISOString();
  // `useRouteError` gives no matched pattern, and `location.pathname` is an entity id. Recording
  // nothing beats recording something that links two reports to one set of books.
  return <CrashPanel diagnostic={diagnosticFor(error, undefined, at)} />;
}

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** The matched route PATTERN, never `location.pathname`: a concrete route is an entity id. */
  readonly surface?: string;
}

interface ErrorBoundaryState {
  readonly caught: boolean;
  readonly error: unknown;
  readonly at: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { caught: false, error: undefined, at: '' };

  /**
   * The raw throw is held, not the redacted entry: redaction needs `props.surface` and this is
   * static. Nothing is rendered from the raw value; `render` redacts before anything reaches the
   * screen, and `redactEntry` is what drops `error.message`.
   */
  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { caught: true, error, at: new Date().toISOString() };
  }

  override render() {
    const { caught, error, at } = this.state;
    if (!caught) return this.props.children;
    return <CrashPanel diagnostic={diagnosticFor(error, this.props.surface, at)} />;
  }
}
