/**
 * D210's G15 provider, `tasks_due`: the E03 tasks still to do (open or doing) that are due within the
 * look-ahead window, `due` until their date and `overdue` after it. The window is the workspace setting
 * `attention.tasks_due_days` (D172, default 14; 0 lists none, so Pendenzen shows no Aufgaben). A task
 * snoozed past now waits, as it does in `tasks_reminders_due`; a task without a due date is never late,
 * so it stays on the Aufgaben page only.
 *
 * WHY. The owner read Aufgaben and Pendenzen as one thing ("what waits for me"), two rows apart in the
 * menu. D210 folds the due tasks into Pendenzen' Erledigen section and drops the Aufgaben row; `/tasks`
 * keeps the full list and every task's own actions. The row only links there: it settles nothing.
 *
 * Read-only, one workspace (§H-TENANT): every query is scoped by `ctx.workspaceId`.
 */

import type { WorkspaceContext } from '../context.js';
import type { AttentionItem, QueueProvider } from '../attention/types.js';
import { getSetting } from '../settings/index.js';

/** The workspace setting that holds the look-ahead window (D172; 0 turns the queue off). */
export const TASKS_DUE_WINDOW_SETTING = 'attention.tasks_due_days';

/** Hoisted const, so the audit-vocabulary scraper does not read this provider as an audit emitter. */
const TASK_ENTITY_KIND = 'task';

interface DueTaskRow {
  id: string;
  title: string;
  due_at: string;
  created_at: string;
}

function addDaysIso(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dueTasks(ctx: WorkspaceContext): DueTaskRow[] {
  const days = getSetting<number>(ctx, TASKS_DUE_WINDOW_SETTING);
  if (typeof days !== 'number' || days <= 0) return [];
  const now = ctx.clock.now();
  const today = now.slice(0, 10);
  // Compared on the day: a due date with a time still belongs to its day.
  const horizon = addDaysIso(today, days);
  return ctx.store.db
    .prepare(
      `SELECT id, title, due_at, created_at FROM task
        WHERE workspace_id = ? AND status IN ('open', 'doing') AND due_at IS NOT NULL
          AND substr(due_at, 1, 10) <= ?
          AND (snoozed_until IS NULL OR snoozed_until <= ?)
        ORDER BY due_at, created_at, id`,
    )
    .all(ctx.workspaceId, horizon, now) as DueTaskRow[];
}

export const tasksDueProvider: QueueProvider = {
  queueId: 'tasks_due',
  labelKey: 'attention.queue.tasksDue',
  area: 'tasks',
  readCapability: 'tasks.read',
  rank: 55,
  freshness: 'live',
  dismissal: 'act_only',
  deepLinkRoute: '/tasks',
  count(ctx: WorkspaceContext): number {
    return dueTasks(ctx).length;
  },
  list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[] {
    const today = ctx.clock.now().slice(0, 10);
    return dueTasks(ctx)
      .slice(0, opts.limit)
      .map((row) => {
        // The Aufgaben page lists every task; it takes no task parameter, so the link names none (critic r1 LOW).
        const deepLink = { route: '/tasks', params: {} };
        return {
          queueId: 'tasks_due',
          entityKind: TASK_ENTITY_KIND,
          entityId: row.id,
          titleKey: 'attention.item.taskDue.title',
          titleParams: { title: row.title },
          since: row.created_at,
          dueAt: row.due_at,
          urgency: row.due_at.slice(0, 10) < today ? 'overdue' : 'due',
          deepLink,
          decisionOptions: [{ id: 'open', verb: null, labelKey: 'attention.act.openTask', role: 'link', input: {}, deepLink }],
        } satisfies AttentionItem;
      });
  },
};
