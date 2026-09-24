/**
 * E03's `task.due` tick source: the ONE row `TICK_SOURCES` reserved for this capability by name
 * (`src/core/automation/tick.ts`: "E03 adds `{ events: ['task.due'], due(...) { ... } }`").
 *
 * WHY A TICK SOURCE AND NOT AN `emittedBy` VERB. A reminder becomes due by TIME PASSING, not by any
 * write succeeding, so the event registry's "emittedBy names a write verb" contract cannot carry
 * it; it fires from `run_due_automations` exactly as the `schedule.*` cadences do. The predicate is
 * `dueReminderRows`, the SAME query `tasks_reminders_due` answers with, so "in the poll set" and
 * "fires the trigger" cannot drift apart (US-E03.6).
 *
 * THE OCCURRENCE KEY makes one due-moment ONE occurrence however many ticks see it: the eventRef is
 * `task.due:<taskId>:<effective instant>`, where the effective instant is the snooze expiry when
 * the reminder was snoozed and the reminder itself otherwise. A repeated tick recomputes the same
 * key and `automation_run_once` refuses the second claim (`already_accounted`); a SNOOZE moves the
 * effective instant, so the reminder resurfacing after a snooze is a genuinely new occurrence,
 * which is what "resurfaces at a better moment" means (US-E03.5).
 *
 * All imports from the automation module are TYPE-ONLY, so the runtime graph stays acyclic:
 * `tick.ts` imports this file's VALUE, this file imports only its types back, which erase.
 */

import type { WorkspaceContext } from '../context.js';
import type { TickSource } from '../automation/tick.js';
import type { AutomationEvent, RuleRow } from '../automation/fire.js';
import { dueReminderRows, mapTask } from './tasks.js';

export const taskDueTickSource: TickSource = {
  events: ['task.due'],

  due(ctx: WorkspaceContext, _rule: RuleRow, _lastFiredAt: string | null, asOf: string): AutomationEvent[] {
    return dueReminderRows(ctx, asOf).map((row) => {
      const effectiveAt = row.snoozed_until !== null && row.snoozed_until > (row.reminder_at as string)
        ? row.snoozed_until
        : (row.reminder_at as string);
      const task = mapTask(row);
      return {
        event: 'task.due',
        entityKind: 'task',
        entityId: row.id,
        // `input`/`result` are what a condition and an action template read for a verb event; a
        // tick occurrence has no verb, so the task itself rides both a `task` field and `result`,
        // the `schedule` payload shape one source over.
        payload: { input: {}, result: { task }, task },
        eventRef: `task.due:${row.id}:${effectiveAt}`,
      };
    });
  },
};
