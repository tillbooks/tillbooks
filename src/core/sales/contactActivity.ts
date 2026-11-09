/**
 * C00's OP5 activity-log seam: `logActivity` and the `contactTimeline` read model.
 *
 * This is the "what happened with this relationship" memory a freelancer can trust (US-C00.3): a
 * note, call, email, meeting or task logged against a contact, appended to `contact_activity` and
 * read back newest-first. The seam is deliberately reusable: C01 deal events and E03 task completions
 * later drop entries through THIS verb rather than growing a parallel timeline, so the timeline stays
 * one source of truth (spec §6b, `ACTIVITY_KIND` is fixed for exactly that reason).
 *
 * The stream is APPEND-ONLY: there is no update or delete verb (a wrong note is corrected by a new
 * note), which mirrors the §H-AUDIT spirit without being a hash chain. Every row carries workspace_id
 * (§H-TENANT). `occurred_at` may be BACKDATED (a call logged after the fact) but never future-dated.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { readContact, resolveMergeChain } from './contact.js';

/**
 * `ACTIVITY_KIND`, the §H-ENUM single source of truth (spec §6b, fixed): the OP5 kinds C01 and E03
 * import by value rather than redeclare, so a workspace-defined kind cannot fork the timeline.
 */
export const ACTIVITY_KINDS: readonly string[] = ['note', 'call', 'email', 'meeting', 'task'];
const ACTIVITY_KIND_SET: ReadonlySet<string> = new Set(ACTIVITY_KINDS);

interface ActivityRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  deal_id: string | null;
  kind: string;
  body: string;
  occurred_at: string;
  user_id: string | null;
  created_at: string;
}

function mapActivity(row: ActivityRow) {
  return {
    id: row.id,
    contactId: row.contact_id,
    dealId: row.deal_id,
    kind: row.kind,
    body: row.body,
    occurredAt: row.occurred_at,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}

/**
 * Append one activity to a contact's timeline (the OP5 seam). `occurred_at` defaults to now and may
 * be backdated, but a future `occurred_at` is refused: a relationship memory records what happened,
 * not what is planned. `kind` is validated at the single §H-ENUM point.
 */
export function logActivity(
  ctx: WorkspaceContext,
  input: {
    contactId: string;
    dealId?: string;
    kind: string;
    body: string;
    occurredAt?: string;
    idempotencyKey?: string;
  },
): Result {
  const contact = readContact(ctx, input.contactId);
  if (contact === undefined) return err('not_found', { contactId: input.contactId });
  if (!ACTIVITY_KIND_SET.has(input.kind)) {
    return err('invalid_activity_kind', { kind: input.kind, allowed: [...ACTIVITY_KINDS] });
  }
  if (typeof input.body !== 'string' || input.body.trim().length === 0) {
    return err('invalid_input', { field: 'body' });
  }

  const now = ctx.clock.now();
  const occurredAt = input.occurredAt ?? now;
  // Compared as ISO strings, which sort chronologically; a full timestamp and a bare day both work.
  if (occurredAt > now) return err('occurred_in_future', { occurredAt, now });

  // A merge tombstone is not a place to hang new history: land the entry on the survivor so the
  // timeline stays consolidated (US-C00.4).
  const target = resolveMergeChain(ctx, contact);

  const run = (): Result => {
    const id = ctx.ids.next('activity');
    ctx.store.db
      .prepare(
        `INSERT INTO contact_activity (
           id, workspace_id, contact_id, deal_id, kind, body, occurred_at, user_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        target.id,
        input.dealId ?? null,
        input.kind,
        input.body,
        occurredAt,
        ctx.actor,
        now,
      );
    const row = ctx.store.db
      .prepare('SELECT * FROM contact_activity WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, id) as ActivityRow;
    return ok({ activity: mapActivity(row) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'contacts_log_activity', run);
  }
  return run();
}

/** One indexed mail message as a timeline SOURCE row (E04, US-E04.6): metadata only, never a body. */
interface MailTimelineRow {
  id: string;
  contact_id: string;
  thread_id: string;
  subject: string | null;
  direction: string;
  sent_at: string | null;
  indexed_at: string;
}

/**
 * The timeline read model (P5), newest-first. Following the merge chain means a read of a tombstone
 * returns the survivor's consolidated timeline, which is the whole point of a merge.
 *
 * E04 EXTENDS THE SOURCES, NOT THE TABLE (US-E04.6): indexed mail from enabled `mail_account`s is
 * unioned in AT QUERY TIME, one entry per `mail_message` resolved to this contact, carrying the
 * SUBJECT and direction and never the body (OP6 index-never-copy; logging every message through
 * OP5 would copy bodies into `contact_activity.body` and flood a hand-curated timeline). E04
 * writes ZERO `contact_activity` rows; a mail entry is distinguishable by `source: 'mail'`, and a
 * manual entry's shape is byte-for-byte what it was before E04 existed. With no enabled account
 * the union contributes nothing and the timeline degrades to manual-only silently.
 */
export function contactTimeline(ctx: WorkspaceContext, input: { contactId: string }): Result {
  const contact = readContact(ctx, input.contactId);
  if (contact === undefined) return err('not_found', { contactId: input.contactId });
  const target = resolveMergeChain(ctx, contact);
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM contact_activity
        WHERE workspace_id = ? AND contact_id = ?
        ORDER BY occurred_at DESC, created_at DESC`,
    )
    .all(ctx.workspaceId, target.id) as ActivityRow[];

  const mailRows = ctx.store.db
    .prepare(
      `SELECT m.id, m.contact_id, m.thread_id, m.subject, m.direction, m.sent_at, m.indexed_at
         FROM mail_message m
         JOIN mail_account a ON a.id = m.account_id AND a.enabled = 1
        WHERE m.workspace_id = ? AND m.contact_id = ?
        ORDER BY m.sent_at DESC`,
    )
    .all(ctx.workspaceId, target.id) as MailTimelineRow[];

  const merged = [
    ...rows.map((row) => ({ ...mapActivity(row), sortAt: row.occurred_at })),
    ...mailRows.map((row) => ({
      id: row.id,
      contactId: row.contact_id,
      source: 'mail' as const,
      kind: 'email',
      threadId: row.thread_id,
      subject: row.subject,
      direction: row.direction,
      occurredAt: row.sent_at ?? row.indexed_at,
      sortAt: row.sent_at ?? row.indexed_at,
    })),
  ]
    .sort((a, b) => (a.sortAt < b.sortAt ? 1 : a.sortAt > b.sortAt ? -1 : 0))
    .map(({ sortAt: _sortAt, ...entry }) => entry);

  return ok({ activities: merged });
}
