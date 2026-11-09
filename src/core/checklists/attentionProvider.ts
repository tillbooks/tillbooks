/**
 * G22's G15 provider, `checklist_items_due`: every open item of an open run due within the look-ahead
 * window (14 days by default, the workspace setting `checklists.attention_window_days`, D172), `due`
 * until its date and `overdue` after it (spec §2 story 7). An abandoned run contributes nothing; a
 * done run has no open item to contribute.
 *
 * THE COUNT IS THE DERIVATION, NOT A LIST LENGTH TRUNCATED BY A LIMIT: a system check item is stored
 * `open` forever and only the live read knows it passed, so a SQL count over stored rows would show
 * an erfüllt check as pending. The open runs of a workspace are few (one per period per template), so
 * deriving them all on every hub read is the honest price. `list` pages the same derived set.
 *
 * The row cannot settle an item: its only option is the link into the run, where the item's own
 * action lives (a verb, a sign-off dialog, a deep link to the owning surface).
 */

import type { WorkspaceContext } from '../context.js';
import type { AttentionItem, QueueProvider } from '../attention/types.js';
import { addDays } from './deadlines.js';
import { deriveRun, openRunRows, type ChecklistItemView, type ChecklistRunView } from './runs.js';
import { getSetting, settingDef } from '../settings/index.js';

/** The workspace setting that holds the look-ahead window (D172, the settings registry's seed entry). */
export const CHECKLIST_DUE_WINDOW_SETTING = 'checklists.attention_window_days';

/**
 * How far ahead the hub looks by DEFAULT: an item due within this window is `due`. The registry entry
 * is the source; this export stays for readers that want the default without a workspace.
 */
export const CHECKLIST_DUE_WINDOW_DAYS = settingDef(CHECKLIST_DUE_WINDOW_SETTING)?.default as number;

/** Hoisted const, so the audit-vocabulary scraper does not read this provider as an audit emitter. */
const CHECKLIST_ITEM_ENTITY_KIND = 'checklist_run_item';

/**
 * The row's subtitle names who the step is for IN WORDS (beta launch P0.4b). It used to interpolate
 * the raw `ownerKind` into one sentence, so Pendenzen read "zuständig: human". The engine has no
 * locale, so it picks a KEY per owner kind and the Studio's catalogue says the words ("du", "ein
 * Agent", "das System"); an owner kind with no key of its own falls back to the template alone.
 */
export const CHECKLIST_SUBTITLE_KEY_BY_OWNER: Readonly<Record<string, string>> = {
  human: 'attention.item.checklistItem.subtitleOwner.human',
  agent: 'attention.item.checklistItem.subtitleOwner.agent',
  system: 'attention.item.checklistItem.subtitleOwner.system',
};
const CHECKLIST_SUBTITLE_FALLBACK_KEY = 'attention.item.checklistItem.subtitle';

interface DueItem {
  readonly run: ChecklistRunView;
  readonly item: ChecklistItemView;
  readonly overdue: boolean;
}

function dueItems(ctx: WorkspaceContext): DueItem[] {
  const today = ctx.clock.now().slice(0, 10);
  const horizon = addDays(today, getSetting<number>(ctx, CHECKLIST_DUE_WINDOW_SETTING));
  const out: DueItem[] = [];
  for (const row of openRunRows(ctx)) {
    const run = deriveRun(ctx, row);
    if (run.status !== 'open') continue;
    for (const item of run.items) {
      if (item.status !== 'open' || item.dueAt === null || item.dueAt > horizon) continue;
      out.push({ run, item, overdue: item.dueAt < today });
    }
  }
  out.sort((a, b) => (a.item.dueAt ?? '').localeCompare(b.item.dueAt ?? '') || a.item.position - b.item.position);
  return out;
}

export const checklistItemsDueProvider: QueueProvider = {
  queueId: 'checklist_items_due',
  labelKey: 'attention.queue.checklistItemsDue',
  area: 'accounting',
  readCapability: 'read_books',
  rank: 50,
  freshness: 'live',
  dismissal: 'act_only',
  deepLinkRoute: '/checklisten',
  count(ctx: WorkspaceContext): number {
    return dueItems(ctx).length;
  },
  list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[] {
    return dueItems(ctx)
      .slice(0, opts.limit)
      .map(({ run, item, overdue }) => {
        const deepLink = { route: '/checklisten', params: { run: run.runId } };
        return {
          queueId: 'checklist_items_due',
          entityKind: CHECKLIST_ITEM_ENTITY_KIND,
          entityId: item.runItemId,
          titleKey: 'attention.item.checklistItem.title',
          titleParams: { period: run.periodLabel, title: item.title },
          subtitleKey: CHECKLIST_SUBTITLE_KEY_BY_OWNER[item.ownerKind] ?? CHECKLIST_SUBTITLE_FALLBACK_KEY,
          subtitleParams: { template: run.templateLabel },
          since: run.createdAt,
          dueAt: item.dueAt ?? run.periodEnd,
          urgency: overdue ? 'overdue' : 'due',
          deepLink,
          decisionOptions: [
            { id: 'open', verb: null, labelKey: 'attention.act.openChecklist', role: 'link', input: {}, deepLink },
          ],
        } satisfies AttentionItem;
      });
  },
};
