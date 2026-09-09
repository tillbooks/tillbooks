/**
 * A12, the Serien surface: every recurring invoice schedule, and what each period of it produced.
 *
 * WHY A RAIL ITEM AND NOT A BELEGE TAB. The Belege tab set is a set of document TYPES, and a Serie
 * is not a document: it is the standing instruction that produces one per period. A12's code does
 * not live inside A10's screen (the argument G00 and G01 recorded for their own rail items), and a
 * Serie is configured once and then visited rarely, exactly the Verkauf group's slowest rhythm.
 *
 * THE PERMISSION STORY MIRRORS THE ENGINE EXACTLY (the F5 padlock idiom). Every A12 write is gated
 * on `issue`, so every write control here is pre-disabled without it, with the reason stated beside
 * the control in a `.lock-note`, never hung on a hover-only `title`. There is no ungated stop
 * button here, unlike Automatisierungen, because the engine gates `pause` too: a schedule's default
 * output is a review draft, not an unattended posting, so the emergency-stop argument does not
 * carry, and the screen must not promise a control the engine would refuse.
 *
 * THE RUN HISTORY IS THE PROVENANCE (spec §4): a generated invoice's link to its Serie lives in the
 * run log, so the detail panel lists each period with its outcome and links the produced document
 * into the Belege surface, where A10's own screen takes over. BOTH operator responses to a waiting
 * skipped draft are legal there (spec §4b): issue it by hand and the next tick settles the period
 * as issued; discard it and the next tick settles it as `discarded`, which this history renders as
 * its own outcome rather than an error.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCapabilities, CAP } from '../../lib/capabilities';
import { useT, formatDate, formatMoney } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton } from '../../components/states';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { SavedViewPicker, type SavedViewDto } from '../Customization/SavedViewPicker';
import {
  RecurringEditor,
  EMPTY_EDITOR,
  nextFirstOfMonth,
  parsePriceMinor,
  parseQuantityMilli,
  type ContactOption,
  type EditorValue,
} from './RecurringEditor';
import type { VatCode } from '../Vat/types';
import './Recurring.css';

/** §H-IDEMPOTENT: a retry with the same key never mints a second schedule. */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export interface ScheduleLineDto {
  itemId?: string | null;
  description?: string | null;
  quantityMilli?: number;
  unitPriceMinor: number;
  taxCode?: string | null;
}

export interface ScheduleDto {
  id: string;
  name: string | null;
  contactId: string;
  /** Resolved by the engine's list read; null when the contact was since removed or anonymised. */
  contactName: string | null;
  lines: ScheduleLineDto[];
  currency: string | null;
  notes: string | null;
  dueDays: number | null;
  interval: 'monthly' | 'quarterly' | 'yearly' | 'custom';
  customDays: number | null;
  anchorDate: string;
  nextRunDate: string;
  endDate: string | null;
  maxOccurrences: number | null;
  occurrencesDone: number;
  autoIssue: boolean;
  status: 'active' | 'paused' | 'ended';
  /** The latest run's outcome and error (critic C5): how a dead schedule is visible on the LIST. */
  lastOutcome: 'drafted' | 'issued' | 'discarded' | 'skipped_locked' | 'failed' | null;
  lastError: string | null;
}

export interface RunDto {
  id: string;
  periodKey: string;
  documentId: string | null;
  documentNumber: string | null;
  documentStatus: string | null;
  outcome: 'drafted' | 'issued' | 'discarded' | 'skipped_locked' | 'failed';
  error: string | null;
  ranAt: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  | {
      kind: 'ok';
      schedules: readonly ScheduleDto[];
      views: readonly SavedViewDto[];
      contacts: readonly ContactOption[];
      taxCodes: readonly VatCode[];
    };

interface Feedback {
  tone: 'success' | 'error';
  text: string;
}

/** Status as glyph AND text, never colour or shape alone (WCAG 2.2 AA; the DESIGN.md status set). */
const STATUS_MARK: Record<ScheduleDto['status'], string> = {
  active: '●',
  paused: '‖',
  ended: '□',
};

const OUTCOME_MARK: Record<RunDto['outcome'], string> = {
  drafted: '◐',
  issued: '✓',
  discarded: '⊘',
  skipped_locked: '–',
  failed: '✕',
};

/** The template's total per period, for the list column: one glance answers "how much is this Serie". */
function templateTotalMinor(lines: readonly ScheduleLineDto[]): number {
  return lines.reduce((sum, line) => {
    const quantity = line.quantityMilli ?? 1000;
    return sum + Math.round((line.unitPriceMinor * quantity) / 1000);
  }, 0);
}

export function Recurring() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const caps = useCapabilities();

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedViewId, setSavedViewId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ scheduleId: string | null; value: EditorValue } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ scheduleId: string; runs: readonly RunDto[] } | null>(null);

  const canIssue = caps.can(CAP.issue);

  /**
   * An engine rejection in the operator's words: A12's own catalogue first, then the SHARED
   * `errors.*` catalogue that carries the cross-cutting codes (`permission_denied`, `store_busy`),
   * and only then the bare code, which is at least the string a person can search for and quote.
   */
  const reason = useCallback(
    (code: string): string => {
      const ownKey = `recurring.error.${code}`;
      const own = t(ownKey);
      if (own !== ownKey) return own;
      const sharedKey = `errors.${code}`;
      const shared = t(sharedKey);
      if (shared !== sharedKey) return shared;
      return code;
    },
    [t],
  );

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setState({ kind: 'loading' });
    const [schedulesRes, viewsRes, contactsRes, codesRes] = await Promise.all([
      client.call('list_recurring_schedules', {
        workspaceId,
        ...(savedViewId !== null ? { savedViewId } : {}),
      }),
      client.call('list_saved_views', { workspaceId, entityKind: 'recurring_schedule' }),
      client.call('list_contacts', { workspaceId, partyRole: 'customer' }),
      // The A05 codes for the per-line picker, the same read the Belege editor performs.
      client.call('vat_codes', { workspaceId }),
    ]);
    if (isErr(schedulesRes.body)) return setState({ kind: 'error', error: schedulesRes.body });
    const schedules = (schedulesRes.body as unknown as { schedules: readonly ScheduleDto[] }).schedules;
    // The pickers degrade to empty rather than failing the list: a viewer without the master-data
    // read still sees the Serien, which is the read this screen exists for. An empty tax-code list
    // is NOT silent, though: the picker itself renders its needs-config CTA into /vat.
    const views = isErr(viewsRes.body)
      ? []
      : (viewsRes.body as unknown as { savedViews: readonly SavedViewDto[] }).savedViews;
    const contacts = isErr(contactsRes.body)
      ? []
      : (contactsRes.body as unknown as { contacts: readonly { id: string; name: string }[] }).contacts;
    const taxCodes = isErr(codesRes.body)
      ? []
      : ((codesRes.body as unknown as { taxCodes: readonly VatCode[] }).taxCodes ?? []);
    setState({ kind: 'ok', schedules, views, contacts, taxCodes });
  }, [client, workspaceId, savedViewId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(
    async (scheduleId: string) => {
      const response = await client.call('get_recurring_schedule', { workspaceId, scheduleId });
      if (isErr(response.body)) {
        setFeedback({ tone: 'error', text: reason(response.body.error) });
        return;
      }
      const runs = (response.body as unknown as { runs: readonly RunDto[] }).runs;
      setDetail({ scheduleId, runs });
    },
    [client, workspaceId, reason],
  );

  async function saveEditor(value: EditorValue) {
    setBusy(true);
    setEditorError(null);
    setFeedback(null);
    // F-03 (J3.8): a position left without a description carries the series name.
    const fallbackDescription = value.name.trim();
    const lines = value.lines
      .filter((line) => line.unitPrice.trim() !== '' || line.description.trim() !== '')
      .map((line) => ({
        ...(line.description.trim() !== ''
          ? { description: line.description.trim() }
          : fallbackDescription !== ''
            ? { description: fallbackDescription }
            : {}),
        ...(parseQuantityMilli(line.quantity) !== null ? { quantityMilli: parseQuantityMilli(line.quantity) } : {}),
        unitPriceMinor: parsePriceMinor(line.unitPrice) ?? -1,
        ...(line.taxCode !== '' ? { taxCode: line.taxCode } : {}),
      }));
    // A malformed price is caught HERE, on the field that owns it, more precisely than the engine's
    // needs_positions could say it.
    if (lines.some((line) => line.unitPriceMinor < 0)) {
      setBusy(false);
      setEditorError('needs_positions');
      return;
    }
    const shared = {
      ...(value.name.trim() !== '' ? { name: value.name.trim() } : {}),
      ...(value.contactId !== '' ? { contactId: value.contactId } : {}),
      lines,
      interval: value.interval,
      ...(value.interval === 'custom' ? { customDays: Number(value.customDays) } : {}),
      anchorDate: value.anchorDate,
      ...(value.endDate !== '' ? { endDate: value.endDate } : {}),
      ...(value.maxOccurrences !== '' ? { maxOccurrences: Number(value.maxOccurrences) } : {}),
      ...(value.dueDays !== '' ? { dueDays: Number(value.dueDays) } : {}),
      autoIssue: value.autoIssue,
      ...(value.notes.trim() !== '' ? { notes: value.notes.trim() } : {}),
    };
    const response =
      editing?.scheduleId != null
        ? await client.call('update_recurring_schedule', {
            workspaceId,
            scheduleId: editing.scheduleId,
            patch: shared,
          })
        : await client.call('create_recurring_schedule', {
            workspaceId,
            ...shared,
            idempotencyKey: newIdempotencyKey(),
          });
    setBusy(false);
    if (isErr(response.body)) {
      setEditorError(response.body.error);
      return;
    }
    setEditing(null);
    setFeedback({ tone: 'success', text: t('recurring.saved') });
    await load();
  }

  async function control(
    action: 'pause_recurring_schedule' | 'resume_recurring_schedule' | 'end_recurring_schedule',
    scheduleId: string,
  ) {
    setBusy(true);
    setFeedback(null);
    const response = await client.call(action, { workspaceId, scheduleId });
    setBusy(false);
    if (isErr(response.body)) {
      setFeedback({ tone: 'error', text: reason(response.body.error) });
      return;
    }
    setFeedback({
      tone: 'success',
      text: t(
        action === 'pause_recurring_schedule'
          ? 'recurring.paused'
          : action === 'resume_recurring_schedule'
            ? 'recurring.resumed'
            : 'recurring.endedNow',
      ),
    });
    await load();
    if (detail?.scheduleId === scheduleId) await openDetail(scheduleId);
  }

  async function tickNow() {
    setBusy(true);
    setFeedback(null);
    const response = await client.call('run_due_recurring', { workspaceId });
    setBusy(false);
    if (isErr(response.body)) {
      setFeedback({ tone: 'error', text: reason(response.body.error) });
      return;
    }
    // "Erstellt wurden 1 Rechnungen" is what a `{n}`-into-a-plural-sentence template produces on the
    // single most common outcome, and `t()` has no plural rule to reach for. The copy is therefore
    // written so it reads correctly for EVERY count, and the zero case gets its own sentence, because
    // "Neue Rechnungen: 0" answers a different question than the one a person pressing this button
    // asked ("was anything due?").
    const generated = (response.body as unknown as { generated?: number }).generated ?? 0;
    setFeedback({
      tone: 'success',
      text: generated === 0 ? t('recurring.tick.nothingDue') : t('recurring.tick.done', { n: String(generated) }),
    });
    await load();
    if (detail !== null) await openDetail(detail.scheduleId);
  }

  function startEdit(schedule: ScheduleDto) {
    setEditorError(null);
    setEditing({
      scheduleId: schedule.id,
      value: {
        name: schedule.name ?? '',
        contactId: schedule.contactId,
        lines: schedule.lines.map((line) => ({
          description: line.description ?? '',
          quantity: String((line.quantityMilli ?? 1000) / 1000),
          unitPrice: (line.unitPriceMinor / 100).toFixed(2),
          taxCode: line.taxCode ?? '',
        })),
        interval: schedule.interval,
        customDays: String(schedule.customDays ?? 30),
        anchorDate: schedule.anchorDate,
        endDate: schedule.endDate ?? '',
        maxOccurrences: schedule.maxOccurrences === null ? '' : String(schedule.maxOccurrences),
        dueDays: schedule.dueDays === null ? '' : String(schedule.dueDays),
        autoIssue: schedule.autoIssue,
        notes: schedule.notes ?? '',
      },
    });
  }

  const detailSchedule = useMemo(
    () =>
      state.kind === 'ok' && detail !== null
        ? (state.schedules.find((s) => s.id === detail.scheduleId) ?? null)
        : null,
    [state, detail],
  );

  /**
   * Who the Serie bills, in words. `contactName` is null when the contact was removed or
   * anonymised, and the id underneath it is a machine string no operator can read or act on, so it
   * never reaches the screen: the row says the customer is gone, which is the fact.
   */
  const customerName = (schedule: ScheduleDto): string => schedule.contactName ?? t('recurring.customerGone');

  /** What the row is called: the given name, else the customer. Never blank, and never an id. */
  const displayName = (schedule: ScheduleDto): string => schedule.name ?? customerName(schedule);

  // The schedule LIST, on the shared DataTable (D118 B2): the frame overflow, the sticky header, the
  // density and the numeric right-alignment are the primitive's now. The name stays a real button so
  // the row's history is keyboard-reachable, and the row is NOT itself click-to-open, because its
  // controls column carries its own buttons that a row-level click would swallow.
  const columns: DataTableColumn<ScheduleDto>[] = [
    {
      key: 'name',
      header: t('recurring.col.name'),
      render: (schedule) => (
        <button
          type="button"
          className="recurring__nameLink"
          onClick={() => void openDetail(schedule.id)}
          aria-expanded={detail?.scheduleId === schedule.id}
        >
          {displayName(schedule)}
        </button>
      ),
    },
    { key: 'customer', header: t('recurring.col.customer'), render: (schedule) => customerName(schedule) },
    {
      key: 'interval',
      header: t('recurring.col.interval'),
      render: (schedule) =>
        `${t(`recurring.interval.${schedule.interval}`)}${
          schedule.interval === 'custom' && schedule.customDays !== null
            ? ` (${t('recurring.customDaysShort', { n: String(schedule.customDays) })})`
            : ''
        }`,
    },
    {
      key: 'amount',
      header: t('recurring.col.amount'),
      numeric: true,
      render: (schedule) => formatMoney(templateTotalMinor(schedule.lines), schedule.currency ?? 'CHF'),
    },
    {
      key: 'nextRun',
      header: t('recurring.col.nextRun'),
      render: (schedule) => (schedule.status === 'ended' ? '' : formatDate(schedule.nextRunDate)),
    },
    {
      key: 'status',
      header: t('recurring.col.status'),
      render: (schedule) => (
        <>
          <span aria-hidden="true">{STATUS_MARK[schedule.status]}</span>{' '}
          {t(`recurring.status.${schedule.status}`)}
          {schedule.autoIssue ? <span className="recurring__badge">{t('recurring.autoIssueBadge')}</span> : null}
          {/* C5: a schedule whose LAST run failed or waits behind a lock says so on the list, with the
              reason, instead of hiding the fact in the per-schedule history. Dimmed prose, not an alarm
              colour: the words carry the state. */}
          {schedule.status !== 'ended' &&
          (schedule.lastOutcome === 'failed' || schedule.lastOutcome === 'skipped_locked') ? (
            <span className="recurring__reason">
              {' '}
              {t(`recurring.outcome.${schedule.lastOutcome}`)}
              {schedule.lastError !== null ? `: ${reason(schedule.lastError)}` : ''}
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: 'controls',
      header: t('recurring.col.controls'),
      render: (schedule) =>
        schedule.status !== 'ended' ? (
          <span className="recurring__controls">
            <button type="button" disabled={!canIssue || busy} onClick={() => startEdit(schedule)}>
              {t('recurring.action.edit')}
            </button>
            {schedule.status === 'active' ? (
              <button
                type="button"
                disabled={!canIssue || busy}
                onClick={() => void control('pause_recurring_schedule', schedule.id)}
              >
                {t('recurring.action.pause')}
              </button>
            ) : (
              <button
                type="button"
                disabled={!canIssue || busy}
                onClick={() => void control('resume_recurring_schedule', schedule.id)}
              >
                {t('recurring.action.resume')}
              </button>
            )}
            <button
              type="button"
              disabled={!canIssue || busy}
              onClick={() => void control('end_recurring_schedule', schedule.id)}
            >
              {t('recurring.action.end')}
            </button>
          </span>
        ) : null,
    },
  ];

  // The per-schedule run history, on the same DataTable: period, outcome (glyph AND text) and the
  // link into the produced document (A10's screen takes over there).
  const historyColumns: DataTableColumn<RunDto>[] = [
    { key: 'period', header: t('recurring.col.period'), render: (run) => formatDate(run.periodKey) },
    {
      key: 'outcome',
      header: t('recurring.col.outcome'),
      render: (run) => (
        <>
          <span aria-hidden="true">{OUTCOME_MARK[run.outcome]}</span> {t(`recurring.outcome.${run.outcome}`)}
          {run.error !== null ? <span className="recurring__reason"> {reason(run.error)}</span> : null}
        </>
      ),
    },
    {
      key: 'document',
      header: t('recurring.col.document'),
      render: (run) =>
        run.documentId !== null ? (
          <Link to={`/documents/${run.documentId}`}>{run.documentNumber ?? t('recurring.history.draft')}</Link>
        ) : (
          ''
        ),
    },
  ];

  if (workspaceId === null) {
    return <NoWorkspaceState body={t('recurring.noWorkspaceHint')} />;
  }

  return (
    <section className="recurring">
      <SurfaceHeader
        title={t('recurring.title')}
        subtitle={t('recurring.lede')}
        help={<SurfaceHelp surface="Recurring" />}
      />

      {feedback !== null ? (
        <p
          className={`recurring__feedback recurring__feedback--${feedback.tone}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}

      {state.kind === 'loading' ? (
        <div className="recurring__skeletons">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : state.kind === 'error' ? (
        <ErrorBanner error={state.error} onRetry={() => void load()} />
      ) : (
        <div className="recurring__panel">
          <div className="recurring__actions">
            {editing === null ? (
              <button
                type="button"
                className="btn btn--accent"
                disabled={!canIssue}
                onClick={() => {
                  setEditorError(null);
                  // F-03 (J3.8): a new series starts next month unless told otherwise.
                  setEditing({ scheduleId: null, value: { ...EMPTY_EDITOR, anchorDate: nextFirstOfMonth(new Date()) } });
                }}
              >
                {t('recurring.new')}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--secondary"
              disabled={!canIssue || busy}
              onClick={() => void tickNow()}
            >
              {t('recurring.tick.now')}
            </button>
            {state.views.length > 0 ? (
              <SavedViewPicker
                views={state.views}
                selected={savedViewId}
                label={t('recurring.savedView')}
                defaultOptionLabel={t('recurring.savedViewDefault')}
                personalGroupLabel={t('recurring.savedViewPersonal')}
                sharedGroupLabel={t('recurring.savedViewShared')}
                onSelect={setSavedViewId}
              />
            ) : null}
            {!canIssue ? <p className="lock-note">{t('recurring.needsPermission')}</p> : null}
          </div>

          {editing !== null ? (
            <RecurringEditor
              contacts={state.contacts}
              taxCodes={state.taxCodes}
              initial={editing.value}
              busy={busy}
              errorCode={editorError}
              onSave={(value) => void saveEditor(value)}
              onCancel={() => setEditing(null)}
            />
          ) : null}

          <DataTable
            columns={columns}
            rows={[...state.schedules]}
            rowKey={(schedule) => schedule.id}
            caption={t('recurring.title')}
            // Ended is a resolved state somebody chose, not a fault, so the row is dimmed (never an
            // alarm colour); the glyph and words already carry the status for a screen reader.
            rowClassName={(schedule) => (schedule.status === 'ended' ? 'recurring-row--ended' : undefined)}
            emptyState={<EmptyState title={t('recurring.empty.title')} hint={t('recurring.empty.hint')} />}
          />

          {detail !== null && detailSchedule !== null ? (
            <section className="recurring__detail" aria-label={t('recurring.history.title')}>
              <h2>
                {t('recurring.history.title')}: {displayName(detailSchedule)}
              </h2>
              {detail.runs.length === 0 ? (
                <p className="recurring__historyEmpty">{t('recurring.history.empty')}</p>
              ) : (
                <>
                  <DataTable
                    columns={historyColumns}
                    rows={[...detail.runs]}
                    rowKey={(run) => run.id}
                    caption={t('recurring.history.title')}
                  />
                  {/* Spec §4b, said where the operator acts: a waiting draft may be issued by hand
                      or discarded, and either way the Serie carries on by itself. */}
                  {detail.runs.some((run) => run.outcome === 'skipped_locked') ? (
                    <p className="recurring__hint">{t('recurring.history.skippedHint')}</p>
                  ) : null}
                </>
              )}
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setDetail(null)}>
                {t('recurring.history.close')}
              </button>
            </section>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default Recurring;
