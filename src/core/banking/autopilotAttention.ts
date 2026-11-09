/**
 * N04 (D183), the Pendenzen cards of the autopilot: ONE queue, `autopilot`, holding
 *  - one card per Swiss day with automatic bookings or lines a granted rule left to a person ("Automatisch
 *    gebucht (3)"), until somebody marks the day seen ("Gesehen"). Each line carries what the card's own
 *    buttons need: "Rückgängig" is `reopen_bank_line` (a reversing entry, the line open again, the grant
 *    paused by the reopen hook) and "Automatik aus" is `revoke_rule_autobook`. An empty day has no card.
 *  - one note per Dauerbuchung run that did not run as set (skipped: a locked period, a cleared or invalid
 *    Vorlage; proposed instead of posted: the right was gone, the Vorlage changed), until it is marked seen.
 * The offer itself is a Vorschlag and lives in the Vorschläge queue (`vorschlaege.ts`, `autobookOffer`).
 * Reads only; every exit is an existing verb. §H-TENANT: every read is the workspace's own.
 */

import type { WorkspaceContext } from '../context.js';
import type { AttentionAutobookDigest, AttentionItem, QueueProvider } from '../attention/types.js';
import { autobookDigest, unseenDigestDays } from './autobook.js';
import { SCHEDULE_RUN_REASONS, scheduleRunNotes } from '../ledger/vorlageSchedule.js';

const QUEUE = 'autopilot';
const DIGEST_KIND = 'autobook_digest';
const NOTE_KIND = 'vorlage_schedule_run';

/** Is the grant still live (neither paused nor revoked)? "Automatik aus" applies only then. */
function grantLive(ctx: WorkspaceContext, grantId: string): boolean {
  const row = ctx.store.db
    .prepare('SELECT 1 AS l FROM rule_autobook_grant WHERE workspace_id = ? AND id = ? AND suspended_at IS NULL AND revoked_at IS NULL')
    .get(ctx.workspaceId, grantId);
  return row !== undefined;
}

function digestItem(ctx: WorkspaceContext, day: string): AttentionItem | null {
  const read = autobookDigest(ctx, { date: day });
  if (!read.ok) return null;
  const all = [...read.booked, ...read.notBooked];
  if (all.length === 0) return null;
  const digest: AttentionAutobookDigest = {
    day,
    lines: all.map((l) => ({
      bankTxnId: l.bankTxnId,
      standardId: l.standardId,
      counterparty: l.counterparty,
      ruleLabel: l.ruleLabel,
      amountMinor: l.amountMinor,
      currency: l.currency,
      lineDate: l.lineDate,
      entryId: l.entryId,
      stands: l.stands,
      reason: l.reason,
      grantLive: grantLive(ctx, l.grantId),
    })),
  };
  const deepLink = { route: '/bank', params: {} };
  return {
    queueId: QUEUE,
    entityKind: DIGEST_KIND,
    entityId: day,
    titleKey: 'attention.item.autobookDigest.title',
    titleParams: { count: read.booked.length },
    subtitleKey: 'attention.item.autobookDigest.subtitle',
    subtitleParams: { date: day, notBooked: read.notBooked.length },
    since: day,
    urgency: 'open',
    deepLink,
    decisionOptions: [
      { id: 'seen', verb: 'autopilot_mark_seen', labelKey: 'attention.act.seen', role: 'secondary', input: { kind: 'digest', ref: day }, capability: 'read_sales' },
    ],
    reasonCode: null,
    reasonKey: null,
    consequenceKey: null,
    consequence: null,
    autobookDigest: digest,
  };
}

export const autopilotProvider: QueueProvider = {
  queueId: QUEUE,
  labelKey: 'attention.queue.autopilot',
  area: 'bank',
  // A digest and a schedule note are read and closed ("Gesehen"); nothing waits on a decision.
  kind: 'note',
  readCapability: 'read_sales',
  rank: 14,
  freshness: 'stored',
  dismissal: 'module_dismiss',
  deepLinkRoute: '/bank',
  count(ctx: WorkspaceContext): number {
    return unseenDigestDays(ctx).length + scheduleRunNotes(ctx).length;
  },
  list(ctx: WorkspaceContext, opts: { limit: number }): AttentionItem[] {
    const out: AttentionItem[] = [];
    for (const d of unseenDigestDays(ctx)) {
      const item = digestItem(ctx, d.day);
      if (item !== null) out.push(item);
    }
    for (const n of scheduleRunNotes(ctx)) {
      const deepLink: { route: string; params: Record<string, string> } = n.actionId !== null ? { route: '/agent', params: { action: n.actionId } } : { route: '/journal', params: {} };
      out.push({
        queueId: QUEUE,
        entityKind: NOTE_KIND,
        entityId: n.runId,
        titleKey: `attention.item.scheduleNote.title.${n.outcome === 'skipped' ? 'skipped' : 'proposed'}`,
        titleParams: { label: n.label ?? '', period: n.period },
        subtitleKey: 'attention.item.scheduleNote.subtitle',
        subtitleParams: { date: n.dueDate, reason: n.reason },
        since: n.dueDate,
        urgency: 'open',
        deepLink,
        decisionOptions: [
          { id: 'seen', verb: 'autopilot_mark_seen', labelKey: 'attention.act.seen', role: 'secondary', input: { kind: 'schedule_run', ref: n.runId }, capability: 'read_sales' },
        ],
        reasonCode: n.reason,
        // A Vorlage's own refusal (an asked amount missing, ...) reads as "the Vorlage could not book".
        reasonKey: `attention.item.scheduleNote.reason.${(SCHEDULE_RUN_REASONS as readonly string[]).includes(n.reason) ? n.reason : 'invalid'}`,
        consequenceKey: null,
        consequence: null,
      });
    }
    return out.slice(0, opts.limit);
  },
};
