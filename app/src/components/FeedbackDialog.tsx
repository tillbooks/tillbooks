/**
 * G08 §6, the feedback dialog. One component, three entry points, five states.
 *
 * Three things here are load-bearing rather than decorative, and each is stated where it is built:
 *
 * 1. **The renderer is imported, not reimplemented.** `renderReport` and `buildMailto` come from
 *    `src/core/support/report.ts`, the same pure module the engine compiles in. A privacy preview
 *    rendered by a second code path is a preview that can drift into a lie, and the crash path needs
 *    a report it can compose with the engine dead. That file carries zero `node:` imports precisely
 *    so this import is possible, and a test on the engine side asserts the property.
 * 2. **The two gates stay separate (§4).** `capture` governs recording to disk and lives in the
 *    engine; the checkbox here governs only what TRAVELS, and it is ticked AFTER the exact payload
 *    has been rendered in front of the person. Nothing this dialog does writes to the journal.
 * 3. **Copying is an explicit press (§3).** The clipboard is an egress channel: managers persist it
 *    and Universal Clipboard forwards it to other devices. So there is a labelled button and the
 *    copy beside it names the consequence, and nothing lands on the clipboard as a side effect of
 *    the primary action.
 *
 * The success state renders **Copy report** and the artifact path UNCONDITIONALLY. A browser cannot
 * observe whether a `mailto:` handler exists, so a delivery mechanism we cannot see must never be
 * the only exit.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  buildMailto,
  renderReport,
  FEEDBACK_KINDS,
  MESSAGE_MAX,
  SUBJECT_MAX,
  type FeedbackKind,
  type ReportEnvironment,
} from '../../../src/core/support/report.js';
import type { DiagnosticEntry } from '../../../src/core/support/redact.js';
import { useI18n } from '../i18n';
import { useClient } from '../lib/client-context';
import { isErr } from '../lib/client';
import { useWorkspaceId } from '../app/workspace';
import type { FeedbackRequest } from './FeedbackProvider';
import './FeedbackDialog.css';

/** Handing the URI to the OS. A seam, so a test can assert the payload without jsdom navigating. */
export type OpenMailto = (uri: string) => void;

const defaultOpenMailto: OpenMailto = (uri) => {
  window.location.href = uri;
};

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusablesIn(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * The environment block for a browser-composed report.
 *
 * `version` is `unknown` on purpose. The crash path cannot ask the engine what version it is (that
 * is the situation it exists for) and the Studio bundle carries no version constant, so the honest
 * answer is that we do not know. A plausible wrong number in a bug report is worse than a blank.
 */
function browserEnv(locale: string): ReportEnvironment {
  return {
    version: typeof __TILL_VERSION__ === 'string' ? __TILL_VERSION__ : 'unknown',
    runtime: 'browser',
    platform: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
    locale,
    client: 'studio',
  };
}

const DETAILS_MARKER = '## Error details\n\n';

/** Pull the error-details section out of a rendered report, so the checkbox's "shown below" is true. */
function errorDetailsOf(report: string): string {
  const at = report.indexOf(DETAILS_MARKER);
  return at === -1 ? report.trimEnd() : report.slice(at + DETAILS_MARKER.length).trimEnd();
}

type Problem = 'required' | 'too_long' | null;

function problemOf(value: string, max: number): Problem {
  if (value.trim() === '') return 'required';
  if (value.length > max) return 'too_long';
  return null;
}

/** Why the diagnostics checkbox is not available. Both leave the report itself sendable (§2). */
type IncludeBlock = 'denied' | 'not_enabled' | null;

interface Outcome {
  readonly report: string;
  readonly mailto: string;
  readonly truncated: boolean;
  /** Present only when the engine actually wrote the artifact. */
  readonly path: string | undefined;
  readonly saved: boolean;
  /** The rejection code that stopped the write, when there was one. */
  readonly reason: string | undefined;
}

function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.randomUUID === 'function') return c.randomUUID();
  return `fb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface FeedbackDialogProps {
  readonly request: FeedbackRequest;
  readonly onClose: () => void;
  /** The control that opened the dialog. Focus goes back to it on close (WCAG 2.2). */
  readonly opener: HTMLElement | null;
  readonly previewDebounceMs?: number;
  readonly openMailto?: OpenMailto;
}

export function FeedbackDialog({
  request,
  onClose,
  opener,
  previewDebounceMs = 400,
  openMailto = defaultOpenMailto,
}: FeedbackDialogProps) {
  const { t, locale } = useI18n();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const titleId = useId();
  const subjectId = useId();
  const subjectHintId = useId();
  const messageId = useId();
  const messageHintId = useId();
  const kindName = useId();

  const dialogRef = useRef<HTMLDivElement>(null);
  // One instant and one key for the whole life of the dialog: the report must not change under the
  // person while they read it, and a repeat submit after a rejected one must not mint a second file.
  const openedAt = useRef(new Date().toISOString()).current;
  const idempotencyKey = useRef(newIdempotencyKey()).current;

  const [kind, setKind] = useState<FeedbackKind>(request.kind ?? 'bug');
  const [subject, setSubject] = useState(request.subject ?? '');
  const [message, setMessage] = useState('');
  const [include, setInclude] = useState(request.diagnostic !== undefined);
  const [includeBlock, setIncludeBlock] = useState<IncludeBlock>(null);
  const [previewDetails, setPreviewDetails] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [copied, setCopied] = useState(false);

  const localOnly = request.localOnly === true;
  const subjectProblem = problemOf(subject, SUBJECT_MAX);
  const messageProblem = problemOf(message, MESSAGE_MAX);
  const blocked = subjectProblem !== null || messageProblem !== null;

  /**
   * The report as this browser would compose it. It is the crash path's primary payload and the
   * fallback for every path where the engine refuses, so it is always available and never depends
   * on a round trip having succeeded.
   */
  const local = useMemo(() => {
    const diagnostics: readonly DiagnosticEntry[] | undefined = include
      ? request.diagnostic === undefined
        ? []
        : [request.diagnostic]
      : undefined;
    const report = renderReport({
      kind,
      subject,
      message,
      at: openedAt,
      env: browserEnv(locale),
      diagnostics,
    });
    const mail = buildMailto(`[${kind}] ${subject}`, message);
    return { report, mailto: mail.mailto, truncated: mail.truncated };
  }, [include, request.diagnostic, kind, subject, message, openedAt, locale]);

  /** Both rejections disable the box and leave the report sendable: the wall is on the data. */
  const applyDiagnosticsRejection = useCallback((code: string): boolean => {
    if (code === 'permission_denied') {
      setIncludeBlock('denied');
      setInclude(false);
      return true;
    }
    if (code === 'diagnostics_not_enabled') {
      setIncludeBlock('not_enabled');
      setInclude(false);
      return true;
    }
    return false;
  }, []);

  const clientError = request.clientError;

  // Debounced preview. This is what makes "exactly what would travel" true rather than claimed: the
  // block below the checkbox is the engine's own rendering, not a second guess at it.
  useEffect(() => {
    if (localOnly || outcome !== null) return undefined;
    if (blocked) {
      setPreviewDetails(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await client.call('preview_feedback', {
            workspaceId,
            kind,
            subject,
            message,
            includeDiagnostics: include,
            clientError,
            locale,
          });
          if (cancelled) return;
          if (isErr(res.body)) {
            applyDiagnosticsRejection(res.body.error);
            setPreviewDetails(null);
            return;
          }
          const report = res.body.report;
          setPreviewDetails(typeof report === 'string' ? errorDetailsOf(report) : null);
        } catch {
          // A dead transport is not a reason to break the form: the local compose still stands.
          if (!cancelled) setPreviewDetails(null);
        }
      })();
    }, previewDebounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    localOnly,
    outcome,
    blocked,
    client,
    workspaceId,
    kind,
    subject,
    message,
    include,
    clientError,
    locale,
    previewDebounceMs,
    applyDiagnosticsRejection,
  ]);

  const finish = useCallback(
    (next: Outcome) => {
      setOutcome(next);
      openMailto(next.mailto);
    },
    [openMailto],
  );

  const submit = useCallback(async () => {
    if (blocked || busy) return;
    setFieldError(null);
    if (localOnly) {
      // §2 US-G08.7: with the engine unreachable there is nothing to call, so the browser is the
      // whole path. The state says plainly that nothing was saved.
      finish({ ...local, path: undefined, saved: false, reason: undefined });
      return;
    }
    setBusy(true);
    try {
      const res = await client.call('prepare_feedback', {
        workspaceId,
        kind,
        subject,
        message,
        includeDiagnostics: include,
        clientError,
        locale,
        idempotencyKey,
      });
      const body = res.body;
      if (isErr(body)) {
        // A rejection must never cost the person their words, so these three stay in the form.
        if (applyDiagnosticsRejection(body.error)) return;
        if (body.error === 'invalid_input') {
          setFieldError(typeof body.field === 'string' ? body.field : 'message');
          return;
        }
        finish({ ...local, path: undefined, saved: false, reason: body.error });
        return;
      }
      finish({
        report: typeof body.report === 'string' ? body.report : local.report,
        mailto: typeof body.mailto === 'string' ? body.mailto : local.mailto,
        truncated: body.truncated === true,
        path: typeof body.path === 'string' ? body.path : undefined,
        saved: true,
        reason: undefined,
      });
    } catch {
      finish({ ...local, path: undefined, saved: false, reason: 'transport_error' });
    } finally {
      setBusy(false);
    }
  }, [
    blocked,
    busy,
    localOnly,
    finish,
    local,
    client,
    workspaceId,
    kind,
    subject,
    message,
    include,
    clientError,
    locale,
    idempotencyKey,
    applyDiagnosticsRejection,
  ]);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, []);

  // Escape closes, Tab cycles. Neither is inherited from `ConfirmDialog`, which has neither.
  useEffect(() => {
    const node = dialogRef.current;
    if (node === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusablesIn(node);
      if (items.length === 0) return;
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index === -1) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && index === 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && index === items.length - 1) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Focus lands in the dialog on open and again when the state swaps the controls out from under it.
  useEffect(() => {
    dialogRef.current?.focus();
  }, [outcome]);

  // And goes back where it came from on the way out.
  useEffect(() => () => opener?.focus(), [opener]);

  const details = include ? (previewDetails ?? (localOnly ? errorDetailsOf(local.report) : null)) : null;

  // Portaled to `document.body` (K-28, D137): the dialog is opened from inside drawers ("Report this
  // error" on a drawer's banner), and a portal is what lets its palette-tier z-index outrank the drawer
  // overlay instead of competing inside the drawer's own stacking context.
  return createPortal(
    <div className="fb-overlay" role="presentation" onClick={onClose}>
      <div
        className="fb-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="fb-title">
          {t('feedback.title')}
        </h2>

        {outcome === null ? (
          <form
            className="fb-body"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset className="fb-kinds">
              <legend className="fb-legend">{t('feedback.kind.label')}</legend>
              {FEEDBACK_KINDS.map((option) => (
                <label className="fb-kind" key={option}>
                  <input
                    type="radio"
                    name={kindName}
                    value={option}
                    checked={kind === option}
                    onChange={() => setKind(option)}
                  />
                  <span>
                    {option === 'bug'
                      ? t('feedback.kind.bug')
                      : option === 'idea'
                        ? t('feedback.kind.idea')
                        : t('feedback.kind.question')}
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="fb-field">
              <label htmlFor={subjectId}>{t('feedback.field.subject.label')}</label>
              <input
                id={subjectId}
                className="field"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                aria-invalid={subjectProblem !== null}
                aria-describedby={subjectProblem === null ? undefined : subjectHintId}
              />
              {/* D15: the reason the primary action is unavailable is INLINE under the field it is
                  about, never a tooltip on a disabled control nobody can hover with a keyboard. */}
              {subjectProblem !== null && (
                <p className="fb-problem" id={subjectHintId}>
                  {subjectProblem === 'required'
                    ? t('feedback.field.subject.required')
                    : t('feedback.field.subject.too_long')}
                </p>
              )}
              {fieldError === 'subject' && <p className="fb-problem">{t('errors.invalid_input')}</p>}
            </div>

            <div className="fb-field">
              <label htmlFor={messageId}>{t('feedback.field.message.label')}</label>
              <textarea
                id={messageId}
                className="field"
                rows={6}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                aria-invalid={messageProblem !== null}
                aria-describedby={messageProblem === null ? undefined : messageHintId}
              />
              {messageProblem !== null && (
                <p className="fb-problem" id={messageHintId}>
                  {messageProblem === 'required'
                    ? t('feedback.field.message.required')
                    : t('feedback.field.message.too_long')}
                </p>
              )}
              {fieldError === 'message' && <p className="fb-problem">{t('errors.invalid_input')}</p>}
            </div>

            <div className="fb-diagnostics">
              <label className="fb-check">
                <input
                  type="checkbox"
                  checked={include}
                  disabled={includeBlock !== null}
                  onChange={(event) => setInclude(event.target.checked)}
                />
                <span>{t('feedback.diagnostics.include')}</span>
              </label>
              {includeBlock !== null && (
                <p className="fb-problem">
                  {includeBlock === 'denied'
                    ? t('feedback.diagnostics.denied')
                    : t('feedback.diagnostics.turn_on')}
                </p>
              )}
              <p className="fb-legend">{t('feedback.diagnostics.preview')}</p>
              {details === null ? (
                <p className="fb-none">{t('feedback.diagnostics.none')}</p>
              ) : (
                <pre className="fb-preview">{details}</pre>
              )}
            </div>

            <p className="fb-notice">{t('feedback.recipient.notice')}</p>

            <div className="fb-foot">
              <button type="button" className="btn btn--secondary" onClick={onClose}>
                {t('feedback.action.cancel')}
              </button>
              {/* The one accent on this surface. The rail entry and "Report this error" stay quiet
                  so this stays the thing the eye finds. */}
              <button type="submit" className="btn btn--primary" disabled={blocked || busy}>
                {t('feedback.action.open_mail')}
              </button>
            </div>
          </form>
        ) : (
          <div className="fb-body">
            {outcome.saved ? (
              <>
                <h3 className="fb-subtitle">{t('feedback.saved.title')}</h3>
                <p>{t('feedback.saved.body')}</p>
              </>
            ) : (
              <p className="fb-problem">{t('feedback.crash_path.not_saved')}</p>
            )}
            {/* The cause, in the person's own language. Two literals rather than a built
                `errors.${code}` key: a dynamic lookup that misses renders the dot-path. */}
            {outcome.reason !== undefined && (
              <p className="fb-problem">
                {outcome.reason === 'transport_error'
                  ? t('errors.transport_error')
                  : t('errors.fallback')}
              </p>
            )}
            {outcome.truncated && <p>{t('feedback.saved.truncated')}</p>}
            <p>{t('feedback.saved.no_mail_app')}</p>
            {outcome.path !== undefined && (
              <p className="fb-path">
                {t('feedback.saved.path')} <code>{outcome.path}</code>
              </p>
            )}
            <p className="fb-notice">{t('feedback.copy.clipboard_note')}</p>
            {copied && (
              <p className="fb-copied" role="status">
                {t('feedback.copy.done')}
              </p>
            )}
            <div className="fb-foot">
              <button type="button" className="btn btn--secondary" onClick={() => void copy(outcome.report)}>
                {t('feedback.action.copy')}
              </button>
              {outcome.path !== undefined && (
                <button type="button" className="btn btn--secondary" onClick={() => void copy(outcome.path as string)}>
                  {t('feedback.action.copy_path')}
                </button>
              )}
              <button type="button" className="btn btn--secondary" onClick={() => openMailto(outcome.mailto)}>
                {t('feedback.action.open_mail')}
              </button>
              <button type="button" className="btn btn--secondary" onClick={onClose}>
                {t('feedback.action.close')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
