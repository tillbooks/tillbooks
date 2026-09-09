/**
 * G08 §6, the feedback context: one dialog, opened from three places.
 *
 * The shell rail's footer, the `ErrorBanner`'s "Report this error" and the `ErrorBoundary` all open
 * the SAME `FeedbackDialog`, so there is one code path and one set of states rather than three
 * near-copies drifting apart. The provider owns the open/closed state and, crucially, the element
 * that opened it, because WCAG 2.2 asks for focus to come back where it started and only the opener
 * knows where that was.
 *
 * `useFeedback()` returns `null` outside a provider ON PURPOSE. `ErrorBanner` reads this context
 * itself instead of taking an `onReport` prop, which is what keeps its 19 call sites untouched, and
 * a good number of those render it in tests with no provider in scope. A throwing hook would turn a
 * missing provider into a crashed surface; returning null turns it into one absent quiet link.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { DiagnosticEntry } from '../../../src/core/support/redact.js';
import type { FeedbackKind } from '../../../src/core/support/report.js';
import { FeedbackDialog, type OpenMailto } from './FeedbackDialog';

export type { FeedbackKind };

/** What an entry point knows about the thing being reported. Every field is optional: the rail
 *  footer supplies none of it, and a report with none of it is still a valid report. */
export interface FeedbackRequest {
  /** Preselected kind. The rail entry opens on `idea`, the two error entry points on `bug`. */
  readonly kind?: FeedbackKind;
  /** Prefilled subject, so the person does not retype the failure they are looking at. */
  readonly subject?: string;
  /**
   * The crash or rejection detail, ALREADY through `redactEntry`. It is held in memory, rendered
   * verbatim in the dialog before anything happens, and travels only if the box stays ticked
   * (§4, gate 2). Nothing here is written to the journal by the act of opening this dialog.
   */
  readonly diagnostic?: DiagnosticEntry;
  /** The `clientError` payload forwarded to the engine verbs. Codes and names only. */
  readonly clientError?: Record<string, unknown>;
  /**
   * The crash path (§2, US-G08.7). Compose the report and the `mailto:` URI entirely in the browser
   * and call no verb at all: a crash reporter that needs a working backend to report a broken
   * backend is not a crash reporter.
   */
  readonly localOnly?: boolean;
}

export interface FeedbackApi {
  /** Open the dialog. Safe to call from an event handler; the opener is captured for focus return. */
  readonly open: (request?: FeedbackRequest) => void;
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

/**
 * Access the feedback dialog, or `null` when no provider is mounted.
 *
 * Callers render their entry point only when this is non-null, so a component tree without the
 * provider simply has no feedback affordance instead of throwing.
 */
export function useFeedback(): FeedbackApi | null {
  return useContext(FeedbackContext);
}

export function FeedbackProvider({
  children,
  previewDebounceMs,
  openMailto,
}: {
  children: ReactNode;
  /** Debounce before the `preview_feedback` round trip. Tests pass 0. */
  previewDebounceMs?: number;
  /** Seam for handing the `mailto:` URI to the OS. Tests pass a spy. */
  openMailto?: OpenMailto;
}) {
  const [request, setRequest] = useState<FeedbackRequest | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const open = useCallback((next: FeedbackRequest = {}) => {
    // Captured BEFORE the dialog mounts and steals focus, because after that the answer is the
    // dialog itself and the trail back to the button is gone.
    const active = typeof document === 'undefined' ? null : document.activeElement;
    opener.current = active instanceof HTMLElement ? active : null;
    setRequest(next);
  }, []);

  const close = useCallback(() => setRequest(null), []);

  const api = useMemo<FeedbackApi>(() => ({ open }), [open]);

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      {request !== null && (
        <FeedbackDialog
          request={request}
          onClose={close}
          opener={opener.current}
          previewDebounceMs={previewDebounceMs}
          openMailto={openMailto}
        />
      )}
    </FeedbackContext.Provider>
  );
}
