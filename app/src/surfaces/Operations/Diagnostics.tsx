/**
 * Diagnostics & feedback panel (spec G08 §6).
 *
 * On the Betrieb (Operations) surface, alongside E07's Vertrauen panel: a privacy control a user has
 * to go looking for is a privacy control they never find. K-16 (Option A) moved this panel here off
 * `/setup` with the other operational panels; the G08 §6 prose was retargeted to match.
 *
 *  1. **The opt-in switch.** A real labelled checkbox, default off, whose hint states the
 *     destructive consequence BEFORE the click: turning it off deletes what was recorded. A privacy
 *     control whose failure mode is discovered afterwards is not one.
 *  2. **The what-gets-recorded disclosure.** This is the in-product revDSG Art. 19 disclosure and it
 *     renders HERE, in the product, beside the control that enables it, rather than in a linked
 *     document. §6b marks the copy fixed, so the strings are used verbatim and never paraphrased.
 *  3. **The live journal**, a real table rendering each entry with the same field names
 *     `renderReport` uses (Code, Exception, Action, Screen, Fields, Where), so what a user reads
 *     here is what would travel. TWO DISTINCT EMPTY STATES: "not recording" and "recording, nothing
 *     yet" are different facts, and one of them is the user's own setting. Collapsing them would
 *     tell someone who opted in that the feature is off. The cap is stated, because a capped log
 *     that presents as complete is a lie by omission.
 *  4. **The report log**, newest first, every row reading "Prepared". NO ROW EVER READS "sent":
 *     TILL hands a report to the mail client and cannot observe what happens next, and a tick the
 *     product did not earn is exactly what E07 forbids for the trust indicator.
 *
 * All five states render: loading (a skeleton in the journal table's own shape, never a spinner),
 * empty (twice, from two distinct predicates), error (`config_not_writable` naming the path,
 * `journal_not_readable` offering Clear now as the way out), success, and permission-denied (the
 * padlock without A24 `diagnostics.read`). **Clear now stays live in the denied state**, because
 * erasing your own data is never a privilege: that is the one place an RBAC wall would defeat
 * revDSG Art. 32 rather than support it.
 *
 * The files these verbs touch are machine-scope; the `workspaceId` every call carries exists solely
 * so A24 can resolve capabilities (§H-TENANT). `diagnostics.scope` says that on screen rather than
 * letting a user assume a workspace boundary protects a file that it does not.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type SVGProps } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, type I18n } from '../../i18n';
import { ErrorBanner, PermissionDenied, Skeleton, useRevealAfterDelay } from '../../components/states';
import { Modal } from '../../components/Modal';
import './Diagnostics.css';

/** The Clear now confirmation is a consequential dialog. Held as a value so the Modal role travels as
 *  a prop, not a literal attribute on the component (the modal-role source guard). */
const ALERT_DIALOG = 'alertdialog' as const;

/**
 * One redacted journal entry, mirroring `DiagnosticEntry` in `src/core/support/redact.ts`.
 *
 * Re-declared rather than imported, like every other engine shape the Studio reads: the browser
 * bundle never touches engine code. Every field here is named in `diagnostics.captured.list`, which
 * is what the engine's disclosure-completeness test pins, so a field added to the entry without
 * being named in that disclosure fails the build rather than quietly widening what is recorded.
 */
interface DiagnosticEntry {
  at: string;
  kind: string;
  name?: string;
  code?: string;
  action?: string;
  surface?: string;
  detailKeys?: string[];
  frames?: string[];
}

/** One row of `list_feedback`. `state` is `prepared` and the enum has exactly one member (§H-ENUM). */
interface FeedbackRow {
  feedbackId: string;
  subject: string;
  kind: string;
  at: string;
  path: string;
  state: string;
}

/** §H-ENUM, mirrored from `src/core/support/report.ts`. The SET is fixed; only labels are flexible. */
const FEEDBACK_KINDS = ['bug', 'idea', 'question'] as const;

/**
 * `list_feedback` does not return the enum member. It returns the ENGLISH title `renderReport` wrote
 * into the artifact, because the log is the directory and the parser reads `- Kind:` back out of the
 * markdown (`KIND_RE` in `src/core/support/feedback.ts`). Rendering that string straight through put
 * "Something is broken" in the middle of a German table, which is what running the panel showed and
 * no mock would have.
 *
 * The engine side is now FIXED: `listFeedback` runs the title back through `kindFromTitle` and the
 * row carries `bug`, leaving display to whichever face is displaying. This map survives as a
 * backward-compatibility shim, and it earns its place: an artifact written by a pre-fix build still
 * has only the English title in its markdown, and the log IS the directory, so those files are still
 * read. Keyed on `KIND_TITLE`, which §6b fixes, so it cannot drift under a workspace relabel.
 */
const KIND_TITLE_TO_MEMBER: Record<string, string> = {
  'Something is broken': 'bug',
  'An idea': 'idea',
  'A question': 'question',
};

/** §H-ENUM, mirrored from `src/core/support/redact.ts`. */
const ENTRY_KINDS = ['verb_error', 'unhandled_exception', 'transport_error'] as const;

/**
 * The report log paginates here (§6, "at scale"). Client-side view state, deliberately NOT a
 * `saved_views` row: that table is workspace-scoped and keyed on a registered `entity_kind`, and
 * this spec has neither by construction.
 */
const PAGE_SIZE = 20;

function isDenied(error: Err): boolean {
  return error.error === 'permission_denied' || error.error === 'forbidden';
}

/**
 * Humanise an enum value, falling back to the raw value rather than to a dot-path.
 *
 * No raw snake_case reaches the screen (DESIGN.md), but a value from a newer engine must not render
 * as `diagnostics.kind.something_new` either, so an unknown member degrades to itself.
 */
function labelFor(t: I18n['t'], known: readonly string[], prefix: string, value: string): string {
  return known.includes(value) ? t(`${prefix}.${value}`) : value;
}

/** A sheet of paper: the report log's state glyph. Decorative, the adjacent text carries the meaning. */
function DocumentGlyph({ size = 16, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      <path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z" />
      <path d="M14 3v4.5h4.5" />
      <path d="M9 13h6M9 16.5h4" />
    </svg>
  );
}

/**
 * The destructive confirm for Clear now, on the shared `Modal` primitive (D118 B2): it hosts the
 * consequential-dialog role on its own `div`, traps focus, and closes on Escape and the scrim, so the
 * bespoke overlay + hand-rolled Escape handling this panel carried are gone.
 *
 * G08's confirmation carries a title AND a body (`diagnostics.clear.confirm.title` plus `.body`, which
 * says that reports already written are KEPT), so the title is the Modal heading and the body its
 * described-by paragraph. The consequential variant does not dismiss on a stray scrim click. The close
 * control takes its own label (`.confirm.close`), kept distinct from the footer "Abbrechen" so the two
 * cancel affordances stay individually addressable.
 */
function ClearConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const t = useT();
  const bodyId = useId();

  return (
    <Modal
      open
      role={ALERT_DIALOG}
      onClose={onCancel}
      title={t('diagnostics.clear.confirm.title')}
      closeLabel={t('diagnostics.clear.confirm.close')}
      describedById={bodyId}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            {t('setup.cancel')}
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm}>
            {t('diagnostics.action.clear')}
          </button>
        </>
      }
    >
      {/* The body names WHICH of the two erasures this is: the journal goes, the reports stay.
          The user chose to keep those, and deciding for them what they may retain is not ours. */}
      <p id={bodyId} className="diag-confirm-body">
        {t('diagnostics.clear.confirm.body')}
      </p>
    </Modal>
  );
}

/** A panel shell matching the other operational panels' own, so they read as one screen. */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="panel setup-panel" aria-labelledby={headingId}>
      <h2 id={headingId} className="setup-panel-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

const JOURNAL_COLUMNS = ['at', 'kind', 'code', 'name', 'action', 'surface', 'detailKeys', 'frames'] as const;

/**
 * The journal's loading state: the table's own shape (the real head strip over placeholder rows),
 * never a spinner (DESIGN.md). K-34 (D137): it is invisible for the first 200ms, so a local read
 * that answers in ten milliseconds never flashes it.
 */
function JournalSkeleton() {
  const t = useT();
  const revealRef = useRevealAfterDelay();
  return (
    <div ref={revealRef} className="diag-table-wrap skeleton-region" role="status" aria-busy="true" aria-live="polite" data-pending="">
      <span className="visually-hidden">{t('states.loading.label')}</span>
      <table className="diag-table">
        <caption className="visually-hidden">{t('diagnostics.journal.title')}</caption>
        <thead>
          <tr>
            {JOURNAL_COLUMNS.map((column) => (
              <th key={column} scope="col">
                {t(`diagnostics.col.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[0, 1, 2].map((row) => (
            <tr key={row}>
              {JOURNAL_COLUMNS.map((column) => (
                <td key={column}>
                  <span className="skeleton diag-skeleton-cell" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The journal itself: one row per entry, in the order a report would carry them. */
function JournalTable({ entries }: { entries: readonly DiagnosticEntry[] }) {
  const t = useT();
  const none = t('diagnostics.value.none');
  return (
    <div className="diag-table-wrap">
      <table className="diag-table">
        <caption className="visually-hidden">{t('diagnostics.journal.title')}</caption>
        <thead>
          <tr>
            {JOURNAL_COLUMNS.map((column) => (
              <th key={column} scope="col">
                {t(`diagnostics.col.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={`${entry.at}-${index}`}>
              <td>
                {/* P11: the visible date goes through the shared formatter and never inlines a
                    separator; the machine-readable ISO instant stays on the element itself. */}
                <time dateTime={entry.at}>{formatDate(entry.at)}</time>
              </td>
              <td>{labelFor(t, ENTRY_KINDS, 'diagnostics.kind', entry.kind)}</td>
              <td>{entry.code ?? none}</td>
              <td>{entry.name ?? none}</td>
              <td>{entry.action ?? none}</td>
              <td>{entry.surface ?? none}</td>
              <td>{(entry.detailKeys ?? []).join(', ') || none}</td>
              <td>
                {(entry.frames ?? []).length === 0 ? (
                  none
                ) : (
                  <ul className="diag-frames">
                    {(entry.frames ?? []).map((frame) => (
                      <li key={frame}>
                        <code>{frame}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type JournalState =
  | { kind: 'loading' }
  | { kind: 'denied' }
  | { kind: 'error'; error: Err }
  | { kind: 'ready'; capture: boolean; configReadable: boolean; entries: DiagnosticEntry[] };

/** Panel 1: the opt-in, the disclosure, and the live journal. */
function DiagnosticsPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const client = useClient();
  const captureId = useId();
  const hintId = useId();
  const [state, setState] = useState<JournalState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [confirming, setConfirming] = useState(false);
  const clearRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const resp = await client.call('get_diagnostics', { workspaceId });
    if (isErr(resp.body)) {
      setState(isDenied(resp.body) ? { kind: 'denied' } : { kind: 'error', error: resp.body });
      return;
    }
    const body = resp.body as {
      capture?: boolean;
      configReadable?: boolean;
      entries?: DiagnosticEntry[];
    };
    setState({
      kind: 'ready',
      capture: body.capture === true,
      // Absent means readable: only a parse failure reports the negative, and defaulting the other
      // way would put a "could not read your settings" notice on every healthy install.
      configReadable: body.configReadable !== false,
      entries: body.entries ?? [],
    });
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Flip the stored preference.
   *
   * On rejection the switch STAYS WHERE IT WAS, because `state.capture` is the only thing driving
   * it: the failure mode of a privacy control has to be the private one. `config_not_writable`
   * names the path it could not write, rather than saying the setting "could not be saved".
   */
  async function onToggle(next: boolean) {
    setBusy(true);
    setWriteError(null);
    const resp = await client.call('set_diagnostics', { workspaceId, capture: next });
    setBusy(false);
    if (isErr(resp.body)) {
      setWriteError(resp.body);
      return;
    }
    await load();
  }

  async function onClear() {
    setConfirming(false);
    setBusy(true);
    setWriteError(null);
    const resp = await client.call('clear_diagnostics', { workspaceId });
    setBusy(false);
    if (isErr(resp.body)) {
      setWriteError(resp.body);
      return;
    }
    await load();
    clearRef.current?.focus();
  }

  const clearButton = (
    <button
      type="button"
      className="btn btn--secondary"
      ref={clearRef}
      disabled={busy}
      onClick={() => setConfirming(true)}
    >
      {t('diagnostics.action.clear')}
    </button>
  );

  /** The fixed Art. 19 disclosure. Rendered in every state: it explains the control, not the data. */
  const disclosure = (
    <div className="diag-disclosure">
      <h3 className="diag-subtitle">{t('diagnostics.captured.title')}</h3>
      <p className="diag-prose">{t('diagnostics.captured.list')}</p>
      <p className="diag-prose">{t('diagnostics.captured.never')}</p>
      <p className="diag-prose diag-prose-dim">{t('diagnostics.at_rest')}</p>
    </div>
  );

  return (
    <Panel title={t('diagnostics.title')}>
      {/* §H-TENANT stated on screen: these files are machine-scope, and the workspace every call
          carries is there only so A24 can resolve capabilities. */}
      <p className="diag-prose diag-prose-dim">{t('diagnostics.scope')}</p>

      {state.kind === 'ready' && (
        <div className="diag-switch">
          <input
            id={captureId}
            type="checkbox"
            className="diag-switch-box"
            checked={state.capture}
            disabled={busy}
            aria-describedby={hintId}
            onChange={(event) => void onToggle(event.target.checked)}
          />
          <label htmlFor={captureId}>{t('diagnostics.capture.label')}</label>
          {/* The consequence is stated BEFORE the click, so the destruction is disclosed rather
              than discovered: turning this off deletes what was recorded. */}
          <p id={hintId} className="field-hint diag-switch-hint">
            {t('diagnostics.capture.hint')}
          </p>
        </div>
      )}

      {state.kind === 'ready' && !state.configReadable && (
        <p className="field-hint" role="status">
          {t('diagnostics.error.config_unreadable')}
        </p>
      )}

      {writeError !== null && (
        <ErrorBanner
          error={writeError}
          message={
            writeError.error === 'config_not_writable'
              ? t('diagnostics.error.config_not_writable', { path: String(writeError.path ?? '') })
              : undefined
          }
          onRetry={() => void load()}
        />
      )}

      {disclosure}

      <h3 className="diag-subtitle">{t('diagnostics.journal.title')}</h3>

      {state.kind === 'loading' && <JournalSkeleton />}

      {state.kind === 'denied' && (
        /* The padlock, with Clear now still in the panel foot below it. Reading what was recorded
           is gated; erasing it is not, and never will be. The switch is absent here rather than
           rendered off: `set_diagnostics` is ungated, but its CURRENT value comes from the read
           that was just refused, and a switch drawn in a position we cannot verify is a lie. */
        <PermissionDenied title={t('diagnostics.title')} body={t('diagnostics.denied.body')} />
      )}

      {state.kind === 'error' && (
        <ErrorBanner
          error={state.error}
          context="read"
          message={
            state.error.error === 'journal_not_readable'
              ? t('diagnostics.error.journal_not_readable', { path: String(state.error.path ?? '') })
              : undefined
          }
          onRetry={() => void load()}
        />
      )}

      {state.kind === 'ready' &&
        (state.entries.length > 0 ? (
          <JournalTable entries={state.entries} />
        ) : (
          /* TWO distinct empty states from two distinct predicates. Capture off names the switch as
             its next action; capture on says nothing has happened since. One sentence for both
             would tell a user who opted in that the feature is off. */
          <p className="diag-empty" role="status">
            {state.capture ? t('diagnostics.empty.on') : t('diagnostics.empty.off')}
          </p>
        ))}

      <div className="diag-journal-foot">
        <p className="field-hint">{t('diagnostics.cap')}</p>
        {clearButton}
      </div>

      {confirming && <ClearConfirm onConfirm={() => void onClear()} onCancel={() => setConfirming(false)} />}
    </Panel>
  );
}

type LogState =
  | { kind: 'loading' }
  | { kind: 'denied' }
  | { kind: 'error'; error: Err }
  | { kind: 'ready'; reports: FeedbackRow[] };

const LOG_COLUMNS = ['subject', 'kind', 'at', 'state', 'actions'] as const;

/** Panel 2: the reports already written, newest first, none of them claiming to have been sent. */
function FeedbackLogPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const client = useClient();
  const [state, setState] = useState<LogState>({ kind: 'loading' });
  const [page, setPage] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const resp = await client.call('list_feedback', { workspaceId });
    if (isErr(resp.body)) {
      setState(isDenied(resp.body) ? { kind: 'denied' } : { kind: 'error', error: resp.body });
      return;
    }
    const body = resp.body as { reports?: FeedbackRow[] };
    setState({ kind: 'ready', reports: body.reports ?? [] });
    setPage(0);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Copy one artifact's path.
   *
   * Never "reveal in Finder": a browser tab cannot perform it, and an affordance that does nothing
   * is worse than none. The path is also rendered in the row as selectable text, so a machine with
   * no clipboard API still has a way to get it.
   */
  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(path);
    } catch {
      /* No clipboard permission or no API: the visible path in the row is the fallback. */
    }
  }

  const reports = state.kind === 'ready' ? state.reports : [];
  const pageCount = Math.max(1, Math.ceil(reports.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const from = current * PAGE_SIZE;
  const visible = reports.slice(from, from + PAGE_SIZE);

  return (
    <Panel title={t('feedback.log.title')}>
      {/* The honesty rule, stated once and unconditionally: no row below claims a send, because the
          handoff to the mail client is fire and forget and TILL never observes it. */}
      <p className="diag-prose diag-prose-dim">{t('feedback.log.cannot_confirm')}</p>

      {state.kind === 'loading' && (
        <Skeleton rows={2} height={36} />
      )}

      {state.kind === 'denied' && <PermissionDenied title={t('feedback.log.title')} />}

      {state.kind === 'error' && <ErrorBanner error={state.error} context="read" onRetry={() => void load()} />}

      {state.kind === 'ready' &&
        (reports.length === 0 ? (
          <p className="diag-empty" role="status">
            {t('feedback.log.empty')}
          </p>
        ) : (
          <>
            <div className="diag-table-wrap">
              <table className="diag-table">
                <caption className="visually-hidden">{t('feedback.log.title')}</caption>
                <thead>
                  <tr>
                    {LOG_COLUMNS.map((column) => (
                      <th key={column} scope="col">
                        {t(`feedback.log.col.${column}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((report) => (
                    <tr key={report.feedbackId}>
                      <td>
                        <span className="diag-log-subject">{report.subject}</span>
                        <code className="diag-log-path">{report.path}</code>
                      </td>
                      <td>
                        {labelFor(
                          t,
                          FEEDBACK_KINDS,
                          'feedback.kind',
                          KIND_TITLE_TO_MEMBER[report.kind] ?? report.kind,
                        )}
                      </td>
                      <td>
                        <time dateTime={report.at}>{formatDate(report.at)}</time>
                      </td>
                      <td>
                        {/* Glyph plus text, never colour alone, and the only state there is. */}
                        <span className="diag-state">
                          <DocumentGlyph />
                          {t('feedback.log.state.prepared')}
                        </span>
                      </td>
                      <td>
                        {/* The accessible name STARTS with the visible label (WCAG 2.5.3), so a
                            voice-control user can say what they read while a screen reader still
                            hears which report the button belongs to. */}
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          aria-label={t('feedback.log.copyPathFor', { subject: report.subject })}
                          onClick={() => void copyPath(report.path)}
                        >
                          {t('feedback.action.copy_path')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="field-hint" role="status">
              {copied !== null ? t('feedback.log.copied') : ''}
            </p>

            {reports.length > PAGE_SIZE && (
              <div className="diag-pager">
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  disabled={current === 0}
                  onClick={() => setPage(current - 1)}
                >
                  {t('feedback.log.page.prev')}
                </button>
                <p className="field-hint">
                  {t('feedback.log.page.status', {
                    from: from + 1,
                    to: from + visible.length,
                    total: reports.length,
                  })}
                </p>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  disabled={current >= pageCount - 1}
                  onClick={() => setPage(current + 1)}
                >
                  {t('feedback.log.page.next')}
                </button>
              </div>
            )}
          </>
        ))}
    </Panel>
  );
}

/**
 * The Diagnostics & feedback block on the Betrieb (Operations) surface.
 *
 * With no workspace selected the block is absent rather than broken: all six verbs are `ctxAction`
 * registrations that resolve A24 capabilities through a workspace, so there is nothing to call yet.
 * Creating the workspace brings this back on the same screen.
 */
export function Diagnostics() {
  const workspaceId = useWorkspaceId();
  if (workspaceId === null || workspaceId === '') return null;
  return (
    <>
      <DiagnosticsPanel workspaceId={workspaceId} />
      <FeedbackLogPanel workspaceId={workspaceId} />
    </>
  );
}
