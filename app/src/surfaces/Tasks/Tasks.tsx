/**
 * E03, Aufgaben (`/tasks`): the cross-entity due/overdue queue.
 *
 * WHY IT IS A ROUTE OF ITS OWN (spec §6, bar deliberately high): the queue's whole value is being
 * CROSS-entity. No existing surface (contacts, pipeline, documents) can host "everything due
 * today" without misfiling it under one module. Everything entity-scoped rides existing surfaces;
 * this screen is the one place the buckets meet.
 *
 * FOUR SECTIONS, one read. `tasks_list` answers every row WITH its bucket (derived in the engine
 * at query time, never cached), and the surface only groups. Every row action (Bearbeiten, the ✓,
 * Zurückstellen, Abbrechen) is a real button in a sensible tab order; status is always glyph AND
 * label, never colour alone (WCAG 2.2 AA).
 *
 * THE PERMISSION GATES HERE ARE A CONVENIENCE AND NOT THE ENFORCEMENT (the standing Studio rule):
 * `whoami` is the one source, it fails open, and the engine is the real gate. The ✓ stays enabled
 * for the ASSIGNEE even without `tasks.write`, because the engine's completion rule is
 * "tasks.write OR assignee" and pre-disabling the very allowance the engine makes would be the
 * Studio inventing a stricter policy than the product has.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2)
 *
 * The page header and its right-aligned controls (the saved-view picker and the primary create
 * action) are the shared `SurfaceHeader`. Create and edit both run through the shared `DetailDrawer`,
 * which adds the focus trap, Escape and scrim the old inline forms lacked, and stops the editor from
 * shoving the whole queue down the page. What stays deliberately bespoke is the ARCHETYPE: this is a
 * card queue, not a columnar ledger, so `DataTable` does not fit (see the report), and the four
 * bucket sections keep their own `<h2>`-headed `<ul>` of elevated row panels. The ✓ / Zurückstellen /
 * Abbrechen row actions and the one-field snooze form stay inline as queue quick-actions, where the
 * work finishes. No `Provenance`/`ConsequenceLine`: a task has no engine consequence sentence and no
 * provenance line to show here.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate } from '../../i18n';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { ActionFeedback } from '../../components/ActionFeedback';
import { DetailDrawer } from '../../components/DetailDrawer';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import './Tasks.css';

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();

export interface TaskItem {
  id: string;
  title: string;
  notes: string | null;
  assigneeUserId: string;
  dueAt: string | null;
  reminderAt: string | null;
  snoozedUntil: string | null;
  status: string;
  entityKind: string | null;
  entityId: string | null;
  recurrenceRule: string | null;
  bucket: string;
}

/** Read the engine's list payload defensively: a shape this surface cannot read is a failed READ. */
function parseTasks(body: unknown): TaskItem[] | null {
  if (body === null || typeof body !== 'object') return null;
  const tasks = (body as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return null;
  const items: TaskItem[] = [];
  for (const raw of tasks) {
    if (raw === null || typeof raw !== 'object') return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.id !== 'string' || typeof t.title !== 'string' || typeof t.bucket !== 'string') return null;
    items.push({
      id: t.id,
      title: t.title,
      notes: typeof t.notes === 'string' ? t.notes : null,
      assigneeUserId: typeof t.assigneeUserId === 'string' ? t.assigneeUserId : '',
      dueAt: typeof t.dueAt === 'string' ? t.dueAt : null,
      reminderAt: typeof t.reminderAt === 'string' ? t.reminderAt : null,
      snoozedUntil: typeof t.snoozedUntil === 'string' ? t.snoozedUntil : null,
      status: typeof t.status === 'string' ? t.status : 'open',
      entityKind: typeof t.entityKind === 'string' ? t.entityKind : null,
      entityId: typeof t.entityId === 'string' ? t.entityId : null,
      recurrenceRule: typeof t.recurrenceRule === 'string' ? t.recurrenceRule : null,
      bucket: t.bucket,
    });
  }
  return items;
}

interface SavedView {
  id: string;
  name: string;
}

function parseViews(body: unknown): SavedView[] {
  const views = (body as { savedViews?: unknown })?.savedViews;
  if (!Array.isArray(views)) return [];
  return views
    .filter((v): v is { viewId?: string; id?: string; name: string } => v !== null && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string')
    .map((v) => ({ id: (v.viewId ?? v.id ?? '') as string, name: v.name }))
    .filter((v) => v.id !== '');
}

/** A datetime-local value to a sortable ISO instant; empty stays absent. */
function toInstant(value: string): string | undefined {
  if (value === '') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** ○ Offen · ◐ In Arbeit · ✓ Erledigt · ✕ Abgebrochen: glyph AND label, never colour alone. */
const STATUS_GLYPH: Record<string, string> = { open: '○', doing: '◐', done: '✓', cancelled: '✕' };

const BUCKETS = ['overdue', 'today', 'upcoming', 'done'] as const;

interface Draft {
  title: string;
  assigneeUserId: string;
  dueAt: string;
  reminderAt: string;
  recurrenceRule: string;
}

const EMPTY_DRAFT: Draft = { title: '', assigneeUserId: '', dueAt: '', reminderAt: '', recurrenceRule: '' };

/** The editor drawer is either creating a new task or editing one by id; closed is `null`. */
type Editor = { mode: 'create' } | { mode: 'edit'; taskId: string; title: string };

export function Tasks() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can, whoami } = useCapabilities();

  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewId, setViewId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [snoozingId, setSnoozingId] = useState<string | null>(null);
  const [snoozeUntil, setSnoozeUntil] = useState('');

  const canWrite = can(CAP.tasksWrite);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const [listed, savedViews] = await Promise.all([
      client.call('tasks_list', { workspaceId, ...(viewId === '' ? {} : { savedViewId: viewId }) }),
      client.call('list_saved_views', { workspaceId, entityKind: 'task' }),
    ]);
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseTasks(listed.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setTasks(parsed);
    // The picker degrades honestly: a refused view read leaves the picker empty, the queue intact.
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

  /** Open the drawer to create a fresh task (clears any stale field values and write error). */
  const openCreate = useCallback(() => {
    setWriteError(null);
    setDraft(EMPTY_DRAFT);
    setEditor({ mode: 'create' });
  }, []);

  /** Open the drawer to edit a task, seeding the form from the row. */
  const openEdit = useCallback((task: TaskItem) => {
    setWriteError(null);
    setDraft({
      title: task.title,
      assigneeUserId: task.assigneeUserId,
      dueAt: task.dueAt?.slice(0, 10) ?? '',
      reminderAt: '',
      recurrenceRule: task.recurrenceRule ?? '',
    });
    setEditor({ mode: 'edit', taskId: task.id, title: task.title });
  }, []);

  const closeEditor = useCallback(() => setEditor(null), []);

  const create = useCallback(async () => {
    const body = await write('tasks_create', {
      title: draft.title,
      assigneeUserId: draft.assigneeUserId === '' ? (whoami?.actor ?? 'studio') : draft.assigneeUserId,
      ...(draft.dueAt === '' ? {} : { dueAt: draft.dueAt }),
      ...(toInstant(draft.reminderAt) === undefined ? {} : { reminderAt: toInstant(draft.reminderAt) }),
      ...(draft.recurrenceRule === '' ? {} : { recurrenceRule: draft.recurrenceRule.trim() }),
      idempotencyKey: newKey(),
    });
    if (body !== null) {
      setEditor(null);
      setDraft(EMPTY_DRAFT);
    }
  }, [write, draft, whoami]);

  const saveEdit = useCallback(
    async (taskId: string) => {
      const patch: Record<string, unknown> = { title: draft.title };
      if (draft.assigneeUserId !== '') patch.assigneeUserId = draft.assigneeUserId;
      patch.dueAt = draft.dueAt === '' ? null : draft.dueAt;
      patch.reminderAt = toInstant(draft.reminderAt) ?? null;
      const body = await write('tasks_update', { taskId, patch, idempotencyKey: newKey() });
      if (body !== null) setEditor(null);
    },
    [write, draft],
  );

  const complete = useCallback(
    async (task: TaskItem) => {
      // A contact-linked completion logs itself onto the OP5 timeline (US-E03.2): the queue is
      // where work finishes, and the relationship memory should say so without a second step.
      const body = await write('tasks_complete', {
        taskId: task.id,
        ...(task.entityKind === 'contact' ? { logActivity: true } : {}),
        idempotencyKey: newKey(),
      });
      if (body !== null && body.seriesEnded === true) setNotice(t('tasks.recurring.series_ended'));
    },
    [write, t],
  );

  const snooze = useCallback(
    async (taskId: string) => {
      const until = toInstant(snoozeUntil);
      if (until === undefined) return;
      const body = await write('tasks_snooze', { taskId, until, idempotencyKey: newKey() });
      if (body !== null) {
        setSnoozingId(null);
        setSnoozeUntil('');
      }
    },
    [write, snoozeUntil],
  );

  const errorMessage = (error: Err): string => {
    const known = ['reminder_in_past', 'reminder_after_due', 'snooze_in_past', 'recurrence_invalid', 'task_not_open', 'invalid_status_transition'];
    if (known.includes(error.error)) return t(`tasks.error.${error.error}`);
    if (error.error === 'permission_denied') return t('tasks.error.permissionDenied.write');
    return t('errors.fallback');
  };

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('tasks.error.permissionDenied.read')} />;

  const editorFields = (value: Draft, onChange: (next: Draft) => void, idPrefix: string) => (
    <div className="tasks-editor-fields">
      <label className="tasks-field">
        <span>{t('tasks.field.title')}</span>
        <input
          id={`${idPrefix}-title`}
          type="text"
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
          required
        />
      </label>
      <label className="tasks-field">
        <span>{t('tasks.field.assignee')}</span>
        <input
          id={`${idPrefix}-assignee`}
          type="text"
          value={value.assigneeUserId}
          placeholder={whoami?.actor ?? ''}
          onChange={(e) => onChange({ ...value, assigneeUserId: e.target.value })}
        />
      </label>
      <label className="tasks-field">
        <span>{t('tasks.field.due')}</span>
        <input id={`${idPrefix}-due`} type="date" value={value.dueAt} onChange={(e) => onChange({ ...value, dueAt: e.target.value })} />
      </label>
      <label className="tasks-field">
        <span>{t('tasks.field.reminder')}</span>
        <input
          id={`${idPrefix}-reminder`}
          type="datetime-local"
          value={value.reminderAt}
          onChange={(e) => onChange({ ...value, reminderAt: e.target.value })}
        />
      </label>
    </div>
  );

  const section = (bucket: (typeof BUCKETS)[number]) => {
    const rows = tasks.filter((task) => task.bucket === bucket);
    return (
      <section key={bucket} className={`tasks-section tasks-section--${bucket}`} aria-labelledby={`tasks-h-${bucket}`}>
        <h2 id={`tasks-h-${bucket}`} className="tasks-section-title">
          {t(`tasks.bucket.${bucket}`)}
          <span className="tasks-count">{rows.length}</span>
        </h2>
        {rows.length === 0 ? (
          <p className="tasks-section-empty">{t('tasks.section.empty')}</p>
        ) : (
          <ul className="tasks-rows">
            {rows.map((task) => {
              const live = task.status === 'open' || task.status === 'doing';
              const mayComplete = canWrite || whoami === null || whoami.actor === task.assigneeUserId;
              return (
                <li key={task.id} className="tasks-row">
                  <div className="tasks-row-main">
                    <span className="tasks-status">
                      <span aria-hidden="true">{STATUS_GLYPH[task.status] ?? '○'}</span> {t(`tasks.status.${task.status}`)}
                    </span>
                    <span className="tasks-row-title">{task.title}</span>
                    {task.recurrenceRule !== null && (
                      <span className="tasks-badge" title={task.recurrenceRule}>
                        <span aria-hidden="true">↻</span> {t('tasks.recurring.badge')}
                      </span>
                    )}
                    <span className="tasks-meta">
                      {task.dueAt !== null && <span>{t('tasks.field.due')}: {formatDate(task.dueAt.slice(0, 10))}</span>}
                      {task.reminderAt !== null && (
                        <span>
                          {t('tasks.field.reminder')}: {formatDate(task.reminderAt.slice(0, 10))}
                          {task.snoozedUntil !== null && ` (${t('tasks.snoozed', { until: formatDate(task.snoozedUntil.slice(0, 10)) })})`}
                        </span>
                      )}
                      <span>{t('tasks.field.assignee')}: {task.assigneeUserId}</span>
                    </span>
                  </div>
                  {live && (
                    <div className="tasks-row-actions">
                      {canWrite && (
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => openEdit(task)}
                        >
                          {t('tasks.action.edit')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={!mayComplete}
                        aria-label={`${t('tasks.action.complete')}: ${task.title}`}
                        onClick={() => void complete(task)}
                      >
                        ✓ {t('tasks.action.complete')}
                      </button>
                      {canWrite && task.reminderAt !== null && (
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => {
                            setSnoozingId(snoozingId === task.id ? null : task.id);
                            setSnoozeUntil('');
                          }}
                        >
                          {t('tasks.action.snooze')}
                        </button>
                      )}
                      {canWrite && (
                        <button type="button" className="btn btn--secondary btn--sm" onClick={() => void write('tasks_cancel', { taskId: task.id, idempotencyKey: newKey() })}>
                          {t('tasks.action.cancel')}
                        </button>
                      )}
                    </div>
                  )}
                  {snoozingId === task.id && (
                    <form
                      className="tasks-editor"
                      aria-label={t('tasks.snooze.label', { title: task.title })}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void snooze(task.id);
                      }}
                    >
                      <label className="tasks-field">
                        <span>{t('tasks.snooze.until')}</span>
                        <input type="datetime-local" value={snoozeUntil} onChange={(e) => setSnoozeUntil(e.target.value)} required />
                      </label>
                      <div className="tasks-editor-actions">
                        <button type="submit" className="btn btn--primary btn--sm">
                          {t('tasks.action.snooze')}
                        </button>
                        <button type="button" className="btn btn--secondary btn--sm" onClick={() => setSnoozingId(null)}>
                          {t('tasks.editor.discard')}
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  };

  const headerActions = (
    <>
      {views.length > 0 && (
        <label className="tasks-view-picker">
          <span>{t('tasks.view.label')}</span>
          <select value={viewId} onChange={(e) => setViewId(e.target.value)}>
            <option value="">{t('tasks.view.all')}</option>
            {views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {canWrite && (
        <button type="button" className="btn btn--primary" onClick={openCreate}>
          {t('tasks.action.create')}
        </button>
      )}
    </>
  );

  return (
    <section className="tasks" aria-labelledby="tasks-title">
      <SurfaceHeader
        title={t('tasks.route.title')}
        titleId="tasks-title"
        help={<SurfaceHelp surface="Tasks" />}
        actions={headerActions}
      />

      {notice !== null && (
        <ActionFeedback
          tone="info"
          message={notice}
          onDismiss={() => setNotice(null)}
          dismissLabel={t('tasks.notice.dismiss')}
        />
      )}
      {/* The write error rides the surface for the inline quick-actions (complete, snooze, cancel);
          while the editor drawer is open it shows INSIDE the drawer instead, above the fields. */}
      {writeError !== null && editor === null && <ErrorBanner message={errorMessage(writeError)} />}
      {failed && <ErrorBanner message={t('tasks.error.transport')} onRetry={() => void load()} />}

      {loading ? (
        <div role="status" aria-busy="true" aria-live="polite">
          <span className="tasks-sr">{t('tasks.loading')}</span>
          <Skeleton rows={4} />
        </div>
      ) : failed ? null : tasks.length === 0 ? (
        <EmptyState
          title={t('tasks.empty')}
          {...(canWrite ? { action: { label: t('tasks.action.create'), onClick: openCreate } } : {})}
        />
      ) : (
        BUCKETS.map((bucket) => section(bucket))
      )}

      {editor !== null && canWrite && (
        <DetailDrawer
          open
          onClose={closeEditor}
          title={editor.mode === 'create' ? t('tasks.editor.createTitle') : t('tasks.editor.label', { title: editor.title })}
          closeLabel={t('tasks.editor.close')}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={closeEditor}>
                {t('tasks.editor.discard')}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  if (editor.mode === 'create') void create();
                  else void saveEdit(editor.taskId);
                }}
              >
                {t('tasks.editor.save')}
              </button>
            </>
          }
        >
          {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
          {editorFields(draft, setDraft, editor.mode === 'create' ? 'create' : `edit-${editor.taskId}`)}
          {editor.mode === 'create' && (
            <label className="tasks-field">
              <span>{t('tasks.field.recurrence')}</span>
              <input
                type="text"
                value={draft.recurrenceRule}
                placeholder="FREQ=MONTHLY"
                onChange={(e) => setDraft({ ...draft, recurrenceRule: e.target.value })}
              />
            </label>
          )}
        </DetailDrawer>
      )}
    </section>
  );
}
export default Tasks;
