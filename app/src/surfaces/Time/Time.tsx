/**
 * B01, Zeit (`/time`): timers, the timesheet, the submit/approve/lock chain, and the Tarife card.
 *
 * WHY IT IS A ROUTE OF ITS OWN (spec §6): no existing surface hosts a live timer plus a timesheet;
 * it is the cluster-B entry point beside `/projects`. The Tarife card lives here as a SECTION
 * rather than on Setup, because Setup is A00's surface (the reconciled spec records the move).
 *
 * THE PERMISSION GATES HERE ARE A CONVENIENCE AND NOT THE ENFORCEMENT (the standing Studio rule):
 * `whoami` is the one source, it fails open, and the engine is the real gate. Freigeben/Sperren
 * are HIDDEN without `time.approve` (spec §6: never shown-then-rejected), the capture controls
 * follow `time.write`, and the Tarife form follows `manage_master_data`.
 *
 * The `no_rate_defined` refusal renders as the honest empty-state hint "Bitte zuerst einen Tarif
 * hinterlegen" pointing at the Tarife card below, never as a silent 0-rate entry (US-B01.5).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, formatMoney } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton, useSkeletonHold } from '../../components/states';
import { Status, type StatusKind } from '../../components/Status';
import { formatCalendar } from '../../lib/format';
import { LockGlyph } from '../../components/states/glyphs';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Select } from '../../components/Select';
import { ActorLabel } from '../../lib/useMemberNames';
import { useSeatLabel } from './seatLabels';
import {
  RATE_CARD_SCOPES,
  formatMinutes,
  parseEntries,
  parseRateCards,
  type RateCard,
  type TimeEntry,
} from './model';
import { Unbilled } from './Unbilled';
import { Retainers } from './Retainers';
import './Time.css';

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();

interface ProjectRef {
  id: string;
  code: string;
  name: string;
}

function parseProjects(body: unknown): ProjectRef[] {
  const raw = (body as { projects?: unknown })?.projects;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is { id: string; code?: string; name?: string } => p !== null && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string')
    .map((p) => ({ id: p.id, code: typeof p.code === 'string' ? p.code : '', name: typeof p.name === 'string' ? p.name : '' }));
}

interface SavedView {
  id: string;
  name: string;
}

function parseViews(body: unknown): SavedView[] {
  const raw = (body as { savedViews?: unknown })?.savedViews;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is { viewId?: string; id?: string; name: string } => v !== null && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string')
    .map((v) => ({ id: (v.viewId ?? v.id ?? '') as string, name: v.name }))
    .filter((v) => v.id !== '');
}

interface LogDraft {
  projectId: string;
  date: string;
  minutes: string;
  billable: boolean;
  notes: string;
}

const EMPTY_LOG: LogDraft = { projectId: '', date: '', minutes: '', billable: true, notes: '' };

/**
 * An entry's state as the one `Status` word (K-22): open has nothing to act on yet, submitted waits
 * for approval, approved and billed are done, a locked period is out of play. An icon-set glyph
 * beside the word, never a text glyph.
 */
const TIME_STATUS_KIND: Record<TimeEntry['status'], StatusKind> = {
  open: 'neutral',
  submitted: 'pending',
  approved: 'success',
  locked: 'inactive',
  billed: 'success',
};

interface RateDraft {
  scope: string;
  scopeRef: string;
  rate: string;
  validFrom: string;
}

const EMPTY_RATE: RateDraft = { scope: 'default', scopeRef: '', rate: '', validFrom: '' };

export function Time() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can, whoami } = useCapabilities();
  // K-38: a seat is named through the shared rule, never printed as "user_1".
  const seatLabel = useSeatLabel();

  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [totalMinutes, setTotalMinutes] = useState(0);
  const [billableMinor, setBillableMinor] = useState(0);
  const [cards, setCards] = useState<RateCard[]>([]);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewId, setViewId] = useState('');
  const [loading, setLoading] = useState(true);
  // K-34: the table's own skeleton, never before 200ms and never for less than 300ms once shown.
  const showSkeleton = useSkeletonHold(loading);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [timerProjectId, setTimerProjectId] = useState('');
  const [logging, setLogging] = useState(false);
  const [logDraft, setLogDraft] = useState<LogDraft>(EMPTY_LOG);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMinutes, setEditMinutes] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [rateDraft, setRateDraft] = useState<RateDraft>(EMPTY_RATE);
  const [endingCardId, setEndingCardId] = useState<string | null>(null);
  const [endDate, setEndDate] = useState('');

  const canWrite = can(CAP.timeWrite);
  const canApprove = can(CAP.timeApprove);
  const canRates = can(CAP.manageMasterData);

  const me = whoami?.userId ?? whoami?.actor ?? 'studio';

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [listed, rateCards, projectList, savedViews] = await Promise.all([
      client.call('time_list', { workspaceId, ...(viewId === '' ? {} : { savedViewId: viewId }) }),
      client.call('rate_card_list', { workspaceId }),
      client.call('project_list', { workspaceId }),
      client.call('list_saved_views', { workspaceId, entityKind: 'time_entry' }),
    ]);
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseEntries(listed.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setEntries(parsed.entries);
    setTotalMinutes(parsed.totalMinutes);
    setBillableMinor(parsed.billableMinor);
    // Sections degrade honestly: a refused register read leaves its section empty, the sheet intact.
    if (!isErr(rateCards.body)) setCards(parseRateCards(rateCards.body));
    if (!isErr(projectList.body)) setProjects(parseProjects(projectList.body));
    if (!isErr(savedViews.body)) setViews(parseViews(savedViews.body));
    setLoading(false);
  }, [client, workspaceId, viewId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a write, surface the engine's own refusal, and re-read on success. */
  const write = useCallback(
    async (action: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      if (workspaceId === null) return null;
      setWriteError(null);
      const response = await client.call(action, { workspaceId, ...input });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return null;
      }
      await load();
      return response.body as unknown as Record<string, unknown>;
    },
    [client, workspaceId, load],
  );

  const projectLabel = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    return (id: string) => {
      const p = byId.get(id);
      return p === undefined ? id : `${p.code} ${p.name}`.trim();
    };
  }, [projects]);

  const running = entries.find((e) => e.endedAt === null && e.userId === me) ?? entries.find((e) => e.endedAt === null);
  const noCards = cards.length === 0;

  const startTimer = useCallback(async () => {
    if (timerProjectId === '') return;
    await write('time_start', { userId: me, projectId: timerProjectId, idempotencyKey: newKey() });
  }, [write, me, timerProjectId]);

  const logTime = useCallback(async () => {
    const minutes = Number(logDraft.minutes);
    const body = await write('time_log', {
      userId: me,
      projectId: logDraft.projectId,
      startedAt: logDraft.date,
      minutes: Number.isFinite(minutes) ? Math.trunc(minutes) : logDraft.minutes,
      billable: logDraft.billable,
      ...(logDraft.notes === '' ? {} : { notes: logDraft.notes }),
      idempotencyKey: newKey(),
    });
    if (body !== null) {
      setLogging(false);
      setLogDraft(EMPTY_LOG);
    }
  }, [write, me, logDraft]);

  const saveEdit = useCallback(
    async (entryId: string) => {
      const minutes = Number(editMinutes);
      const body = await write('time_update', {
        entryId,
        patch: {
          ...(editMinutes === '' ? {} : { minutes: Number.isFinite(minutes) ? Math.trunc(minutes) : editMinutes }),
          notes: editNotes === '' ? null : editNotes,
        },
        idempotencyKey: newKey(),
      });
      if (body !== null) setEditingId(null);
    },
    [write, editMinutes, editNotes],
  );

  const approveSubmitted = useCallback(async () => {
    const submitted = entries.filter((e) => e.status === 'submitted' && e.startedAt.startsWith(period)).map((e) => e.id);
    if (submitted.length === 0) return;
    await write('time_approve', { entryIds: submitted, idempotencyKey: newKey() });
  }, [write, entries, period]);

  const upsertRate = useCallback(async () => {
    const rate = Math.round(Number(rateDraft.rate) * 100);
    const body = await write('rate_card_upsert', {
      scope: rateDraft.scope,
      ...(rateDraft.scope === 'default' || rateDraft.scopeRef === '' ? {} : { scopeRef: rateDraft.scopeRef }),
      rateMinor: Number.isFinite(rate) ? rate : rateDraft.rate,
      validFrom: rateDraft.validFrom,
      idempotencyKey: newKey(),
    });
    if (body !== null) setRateDraft(EMPTY_RATE);
  }, [write, rateDraft]);

  const errorMessage = (error: Err): string => {
    const known = [
      'timer_already_running',
      'timer_not_running',
      'entry_locked',
      'invalid_minutes',
      'no_rate_defined',
      'nothing_to_submit',
      'nothing_to_lock',
      'rate_card_overlap',
      'invalid_rate_card',
      'rate_card_already_ended',
      'invalid_transition',
      'project_not_found',
    ];
    if (known.includes(error.error)) return t(`time.error.${error.error}`);
    if (error.error === 'permission_denied') return t('time.error.permissionDenied.write');
    return t('errors.fallback');
  };

  // The timesheet columns for the shared DataTable (D118 B2). Duration and rate are numeric, so they
  // right-align with tabular figures; the status is the Status word (K-22). Every row verb (Stoppen,
  // Bearbeiten, Löschen) sits behind the row's ONE overflow (K-21): the sheet used to carry up to
  // three buttons on every line, 128 on one screen.
  const timesheetColumns: DataTableColumn<TimeEntry>[] = [
    { key: 'date', header: t('time.col.date'), render: (entry) => formatCalendar(entry.startedAt) },
    {
      key: 'project',
      header: t('time.col.project'),
      render: (entry) => (
        <>
          {projectLabel(entry.projectId)}
          {entry.notes !== null && <span className="time-notes"> · {entry.notes}</span>}
        </>
      ),
    },
    {
      key: 'user',
      header: t('time.col.user'),
      render: (entry) => {
        const actor = seatLabel(entry.userId);
        return <ActorLabel actor={actor} tooltip={t('time.actorTooltip', { id: actor.id })} />;
      },
    },
    {
      key: 'duration',
      header: t('time.col.duration'),
      numeric: true,
      render: (entry) => (entry.minutes === null ? t('time.timer.badge') : formatMinutes(entry.minutes)),
    },
    {
      key: 'rate',
      header: t('time.col.rate'),
      numeric: true,
      render: (entry) => formatMoney(entry.rateMinor, entry.rateCurrency),
    },
    {
      key: 'status',
      header: t('time.col.status'),
      render: (entry) => <Status kind={TIME_STATUS_KIND[entry.status]} label={t(`time.status.${entry.status}`)} />,
    },
  ];

  // K-21: the row's verbs, behind one overflow; Löschen last and marked destructive.
  const entryActions = (entry: TimeEntry) => {
    const editable = entry.status === 'open' || entry.status === 'submitted';
    return [
      ...(entry.endedAt === null
        ? [{ key: 'stop', label: t('time.timer.stop'), onSelect: () => void write('time_stop', { entryId: entry.id, idempotencyKey: newKey() }) }]
        : []),
      ...(editable && entry.endedAt !== null
        ? [
            {
              key: 'edit',
              label: t('time.action.edit'),
              onSelect: () => {
                setEditingId(entry.id);
                setEditMinutes(entry.minutes === null ? '' : String(entry.minutes));
                setEditNotes(entry.notes ?? '');
              },
            },
          ]
        : []),
      ...(editable
        ? [
            {
              key: 'delete',
              label: t('time.action.delete'),
              danger: true,
              onSelect: () => void write('time_delete', { entryId: entry.id, idempotencyKey: newKey() }),
            },
          ]
        : []),
    ];
  };
  const editing = editingId === null ? undefined : entries.find((entry) => entry.id === editingId);

  // The Tarife (rate cards) columns for the shared DataTable. The rate is numeric; the actions column
  // hosts the Beenden control and its inline end-date form.
  const rateColumns: DataTableColumn<RateCard>[] = [
    { key: 'scope', header: t('time.rates.col.scope'), render: (card) => t(`time.rates.scope.${card.scope}`) },
    {
      key: 'ref',
      header: t('time.rates.col.ref'),
      render: (card) => (card.scope === 'project' ? projectLabel(card.scopeRef ?? '') : card.scopeRef ?? '–'),
    },
    {
      key: 'rate',
      header: t('time.rates.col.rate'),
      numeric: true,
      render: (card) => formatMoney(card.rateMinor, card.currency),
    },
    {
      key: 'validity',
      header: t('time.rates.col.validity'),
      render: (card) => (
        <>
          {formatDate(card.validFrom)}
          {card.validTo !== null && ` – ${formatDate(card.validTo)}`}
        </>
      ),
    },
    {
      key: 'actions',
      header: t('time.col.actions'),
      headerHidden: true,
      align: 'end',
      render: (card) => (
        <span className="time-actions">
          {canRates && card.validTo === null && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                setEndingCardId(endingCardId === card.id ? null : card.id);
                setEndDate('');
              }}
            >
              {t('time.rates.action.end')}
            </button>
          )}
          {endingCardId === card.id && (
            <form
              className="time-editor"
              aria-label={t('time.rates.action.end')}
              onSubmit={(e) => {
                e.preventDefault();
                void write('rate_card_end', { rateCardId: card.id, validTo: endDate, idempotencyKey: newKey() }).then((body) => {
                  if (body !== null) setEndingCardId(null);
                });
              }}
            >
              <label className="time-field">
                <span>{t('time.rates.field.validTo')}</span>
                <input className="field" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
              </label>
              <button type="submit" className="btn btn--secondary btn--sm">
                {t('time.rates.action.end')}
              </button>
            </form>
          )}
        </span>
      ),
    },
  ];

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('time.error.permissionDenied.read')} />;

  const submittedInPeriod = entries.filter((e) => e.status === 'submitted' && e.startedAt.startsWith(period)).length;

  return (
    <section className="time" aria-labelledby="time-title">
      <SurfaceHeader
        title={t('time.route.title')}
        titleId="time-title"
        help={<SurfaceHelp surface="Time" />}
        actions={
          views.length > 0 ? (
            <div className="time-view-picker">
              <span>{t('time.view.label')}</span>
              <Select
                value={viewId}
                onChange={(val) => setViewId(val)}
                options={[
                  { value: '', label: t('time.view.all') },
                  ...views.map((view) => ({ value: view.id, label: view.name })),
                ]}
                ariaLabel={t('time.view.label')}
              />
            </div>
          ) : undefined
        }
      />

      {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
      {failed && <ErrorBanner context="read" message={t('time.error.transport')} onRetry={() => void load()} />}

      {canWrite && (
        <div className="time-capture">
          {running !== undefined ? (
            <div className="time-timer time-timer--running">
              <Status
                className="time-timer-label"
                kind="pending"
                label={t('time.timer.running', { project: projectLabel(running.projectId) })}
              />
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void write('time_stop', { entryId: running.id, idempotencyKey: newKey() })}
              >
                {t('time.timer.stop')}
              </button>
            </div>
          ) : (
            <form
              className="time-timer"
              aria-label={t('time.timer.start')}
              onSubmit={(e) => {
                e.preventDefault();
                void startTimer();
              }}
            >
              <div className="time-field">
                <span>{t('time.field.project')}</span>
                <Select
                  value={timerProjectId}
                  onChange={(val) => setTimerProjectId(val)}
                  options={[
                    { value: '', label: t('time.field.projectPlaceholder') },
                    ...projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
                  ]}
                  ariaLabel={t('time.field.project')}
                />
              </div>
              <button type="submit" className="btn btn--primary btn--sm" disabled={timerProjectId === ''}>
                {t('time.timer.start')}
              </button>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setLogging(!logging)}>
                {t('time.action.log')}
              </button>
            </form>
          )}

          {logging && (
            <form
              className="time-editor"
              aria-label={t('time.action.log')}
              onSubmit={(e) => {
                e.preventDefault();
                void logTime();
              }}
            >
              <div className="time-field">
                <span>{t('time.field.project')}</span>
                <Select
                  value={logDraft.projectId}
                  onChange={(val) => setLogDraft({ ...logDraft, projectId: val })}
                  options={[
                    { value: '', label: t('time.field.projectPlaceholder') },
                    ...projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
                  ]}
                  ariaLabel={t('time.field.project')}
                />
              </div>
              <label className="time-field">
                <span>{t('time.field.date')}</span>
                <input
                  className="field"
                  type="date"
                  value={logDraft.date}
                  onChange={(e) => setLogDraft({ ...logDraft, date: e.target.value })}
                  required
                />
              </label>
              <label className="time-field">
                <span>{t('time.field.minutes')}</span>
                <input
                  className="field"
                  type="number"
                  min={1}
                  max={1440}
                  value={logDraft.minutes}
                  onChange={(e) => setLogDraft({ ...logDraft, minutes: e.target.value })}
                  required
                />
              </label>
              <label className="time-field time-field--check">
                <input
                  type="checkbox"
                  checked={logDraft.billable}
                  onChange={(e) => setLogDraft({ ...logDraft, billable: e.target.checked })}
                />
                <span>{t('time.field.billable')}</span>
              </label>
              <label className="time-field">
                <span>{t('time.field.notes')}</span>
                <input className="field" type="text" value={logDraft.notes} onChange={(e) => setLogDraft({ ...logDraft, notes: e.target.value })} />
              </label>
              <div className="time-editor-actions">
                <button type="submit" className="btn btn--secondary btn--sm">
                  {t('time.editor.save')}
                </button>
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => setLogging(false)}>
                  {t('time.editor.discard')}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {canWrite && noCards && !loading && (
        <p className="time-hint" role="note">
          {t('time.error.no_rate_defined')} <a className="link-inline" href="#time-rates">{t('time.rates.title')}</a>
        </p>
      )}

      {showSkeleton ? (
        // The sheet's own shape while the read is in flight (K-34), named for a screen reader.
        <div role="status" aria-live="polite">
          <span className="visually-hidden">{t('time.loading')}</span>
          <DataTable columns={timesheetColumns} rows={[]} rowKey={(entry) => entry.id} loading skeletonRows={4} />
        </div>
      ) : failed ? null : projects.length === 0 ? (
        <EmptyState
          title={t('time.empty.noProjects.title')}
          hint={t('time.empty.noProjects.body')}
          action={{ label: t('time.empty.noProjects.cta'), to: '/projects' }}
        />
      ) : entries.length === 0 ? (
        // K-33: the first entry is one step away, so the empty sheet offers it.
        <EmptyState
          title={t('time.empty.title')}
          hint={t('time.empty.body')}
          {...(canWrite ? { action: { label: t('time.action.log'), onClick: () => setLogging(true) } } : {})}
        />
      ) : (
        <>
          <div className="time-totals" role="status">
            <span>
              {t('time.totals.minutes')}: <b>{formatMinutes(totalMinutes)}</b>
            </span>
            <span>
              {t('time.totals.billable')}: <b className="t-money">{formatMoney(billableMinor, 'CHF')}</b>
            </span>
          </div>
          <DataTable
            columns={timesheetColumns}
            rows={entries}
            rowKey={(entry) => entry.id}
            caption={t('time.tableCaption')}
            rowActions={canWrite ? entryActions : undefined}
            rowActionsLabel={(entry) => t('time.rowActions', { date: formatCalendar(entry.startedAt), project: projectLabel(entry.projectId) })}
            isRowCurrent={(entry) => entry.id === editingId}
          />

          {/* The one entry being edited, opened from its row's overflow: the form stands under the
              sheet rather than inside a cell, so the row keeps its height (K-20). */}
          {editing !== undefined && (
            <form
              className="time-editor"
              aria-label={t('time.editor.label')}
              onSubmit={(e) => {
                e.preventDefault();
                void saveEdit(editing.id);
              }}
            >
              <label className="time-field">
                <span>{t('time.field.minutes')}</span>
                <input className="field" type="number" min={1} max={1440} value={editMinutes} onChange={(e) => setEditMinutes(e.target.value)} />
              </label>
              <label className="time-field">
                <span>{t('time.field.notes')}</span>
                <input className="field" type="text" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
              </label>
              <div className="time-editor-actions">
                <button type="submit" className="btn btn--secondary btn--sm">
                  {t('time.editor.save')}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditingId(null)}>
                  {t('time.editor.discard')}
                </button>
              </div>
            </form>
          )}

          {(canWrite || canApprove) && (
            <div className="time-period" aria-label={t('time.period.label')}>
              <label className="time-field">
                <span>{t('time.period.label')}</span>
                <input className="field" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
              </label>
              {canWrite && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => void write('time_submit', { period, idempotencyKey: newKey() })}
                >
                  {t('time.action.submit')}
                </button>
              )}
              {canApprove && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  disabled={submittedInPeriod === 0}
                  onClick={() => void approveSubmitted()}
                >
                  {t('time.action.approve')}
                </button>
              )}
              {canApprove && (
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => void write('time_lock', { period, idempotencyKey: newKey() })}
                >
                  <LockGlyph size={14} /> {t('time.action.lock')}
                </button>
              )}
            </div>
          )}
        </>
      )}

      <section id="time-rates" className="time-rates" aria-labelledby="time-rates-title">
        <h2 id="time-rates-title" className="time-rates-title">
          {t('time.rates.title')}
        </h2>
        {showSkeleton ? (
          <Skeleton rows={2} height={36} />
        ) : cards.length === 0 ? (
          <p className="time-rates-empty">{t('time.rates.empty')}</p>
        ) : (
          <DataTable columns={rateColumns} rows={cards} rowKey={(card) => card.id} caption={t('time.rates.tableCaption')} />
        )}

        {canRates && (
          <form
            className="time-editor time-rates-form"
            aria-label={cards.length === 0 ? t('time.rates.addDefault') : t('time.rates.add')}
            onSubmit={(e) => {
              e.preventDefault();
              void upsertRate();
            }}
          >
            <label className="time-field">
              <span>{t('time.rates.col.scope')}</span>
              <Select
                value={rateDraft.scope}
                onChange={(val) => setRateDraft({ ...rateDraft, scope: val })}
                options={RATE_CARD_SCOPES.map((scope) => ({
                  value: scope,
                  label: t(`time.rates.scope.${scope}`),
                }))}
                ariaLabel={t('time.rates.col.scope')}
              />
            </label>
            {rateDraft.scope !== 'default' && (
              <label className="time-field">
                <span>{t('time.rates.col.ref')}</span>
                {rateDraft.scope === 'project' ? (
                  <Select
                    value={rateDraft.scopeRef}
                    onChange={(val) => setRateDraft({ ...rateDraft, scopeRef: val })}
                    options={[
                      { value: '', label: t('time.field.projectPlaceholder') },
                      ...projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
                    ]}
                    ariaLabel={t('time.rates.col.ref')}
                  />
                ) : (
                  <input
                    className="field"
                    type="text"
                    value={rateDraft.scopeRef}
                    onChange={(e) => setRateDraft({ ...rateDraft, scopeRef: e.target.value })}
                    required
                  />
                )}
              </label>
            )}
            <label className="time-field">
              <span>{t('time.rates.field.rate')}</span>
              <input
                className="field"
                type="number"
                min="0.05"
                step="0.05"
                value={rateDraft.rate}
                onChange={(e) => setRateDraft({ ...rateDraft, rate: e.target.value })}
                required
              />
            </label>
            <label className="time-field">
              <span>{t('time.rates.field.validFrom')}</span>
              <input
                className="field"
                type="date"
                value={rateDraft.validFrom}
                onChange={(e) => setRateDraft({ ...rateDraft, validFrom: e.target.value })}
                required
              />
            </label>
            <button type="submit" className="btn btn--secondary btn--sm">
              {cards.length === 0 ? t('time.rates.addDefault') : t('time.rates.add')}
            </button>
          </form>
        )}
      </section>

      {/* B02: the Unverrechnet panel and the WIP card, a disjoint component mounted here (spec §6:
          billing selection is a time decision, so it lives on the time route). */}
      <Unbilled />

      {/* B04: the Mandate tab (retainers), a disjoint component mounted here (spec §6: a retainer's
          drawdown is a time decision, so it lives on the time route beside billing). */}
      <Retainers />

    </section>
  );
}
export default Time;
