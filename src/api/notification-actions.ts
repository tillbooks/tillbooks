/**
 * G06's eight verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `taskActions` precedent), so several agents appending to the append-only registry at once
 * collide over a line rather than a block.
 *
 * Six writes and two reads. `notifications_deliver` is the OP8 ACTION TARGET: a G01 rule names it
 * and G01's engine calls it through the shared dispatch, so it is a legal automation action by
 * construction (the write half of `ACTIONS` IS the legal set) and none of the eight sits on the
 * denylist: nothing here is irreversible (archive is reversible state), statutory, membership-
 * deciding, tenant-crossing, self-administering or payment-touching, and a rule that mutes or
 * clears its author's own inbox wields no power the preference switchboard does not already grant.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  deliverNotification,
  listInbox,
  markRead,
  markAllRead,
  archiveNotification,
  setPreference,
  listPreferences,
  runDigest,
} from '../core/notifications/index.js';

export interface NotificationActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
}

/** The registry's documented cast: the JSON input is handed to the verb as its typed input. */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The G06 verbs, in append order (the §5 table order). */
export function notificationActions(h: NotificationActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;

  return [
    ctxAction(
      'notifications_deliver',
      'write',
      'Stelle ein Ereignis in den Posteingang zu (the OP8 action target a G01 rule names, US-G06.1): validates the event against the single automation-event registry, resolves the recipient\'s notification preference (exact event row, else the * wildcard, else the built-in default: inbox on), and inserts ONE unread inbox_item, or answers delivered:false reason muted when the recipient silenced the moment (never an error). An entityKind/entityId pair links back to the source record (OP3, workspace-scoped). Nothing is ever transmitted here: outbound channels are the digest\'s OP4 business.',
      ctxSchema(
        {
          userId: STR,
          event: STR,
          entityKind: STR,
          entityId: STR,
          summaryI18nKey: STR,
          summaryParams: { type: 'object' },
          idempotencyKey: STR,
        },
        ['userId', 'event', 'summaryI18nKey', 'idempotencyKey'],
      ),
      (ctx, input) => deliverNotification(ctx, as(input)),
    ),
    ctxAction(
      'notifications_list',
      'read',
      'Der Posteingang (P5, US-G06.2): the caller\'s own inbox items newest first, each with its query-time day grouping, plus the live unreadCount (the bell figure). Self-scoped structurally: userId must be the caller\'s own (forbidden otherwise). status filters unread|read|archived, bucket filters to one ISO day, savedViewId applies a stored G00 view over the inbox_item kind (its filters merge underneath explicit ones).',
      ctxSchema({ userId: STR, status: STR, bucket: STR, savedViewId: STR }, ['userId']),
      (ctx, input) => listInbox(ctx, as(input)),
    ),
    ctxAction(
      'notifications_mark_read',
      'write',
      'Markiere eine Benachrichtigung als gelesen (US-G06.2): unread wird read und read_at gestempelt. Self-scoped: a foreign user\'s item answers the same notification_not_found a nonexistent one does; an ARCHIVED item is outside the mutable set and is refused the same way. Marking an already-read item read is a successful state assertion.',
      ctxSchema({ notificationId: STR, idempotencyKey: STR }, ['notificationId']),
      (ctx, input) => markRead(ctx, as(input)),
    ),
    ctxAction(
      'notifications_mark_all_read',
      'write',
      'Alle als gelesen markieren (US-G06.2): clears the caller\'s whole unread set in one call and answers how many rows moved. Self-scoped structurally: userId must be the caller\'s own (forbidden otherwise).',
      ctxSchema({ userId: STR, idempotencyKey: STR }, ['userId']),
      (ctx, input) => markAllRead(ctx, as(input)),
    ),
    ctxAction(
      'notifications_archive',
      'write',
      'Archiviere eine Benachrichtigung (US-G06.2): unread oder read wird archived (reading first is not required), reversible via the Archiv filter. Self-scoped: a foreign item answers notification_not_found; archiving an archived item is a successful state assertion.',
      ctxSchema({ notificationId: STR, idempotencyKey: STR }, ['notificationId']),
      (ctx, input) => archiveNotification(ctx, as(input)),
    ),
    ctxAction(
      'notifications_set_preference',
      'write',
      'Setze eine Benachrichtigungs-Einstellung (US-G06.3): upserts one (recipient, event, channel) row; event omitted writes the * wildcard row every unlisted event falls back to. channel is inbox|email|push (invalid_channel otherwise); the in-app inbox is ALWAYS instant, so any other cadence on it answers inbox_is_always_instant. Setting another user\'s preference asserts manage_members (an admin configuring a teammate\'s defaults); your own needs only membership.',
      ctxSchema(
        { userId: STR, event: STR, channel: STR, enabled: BOOL, digest: STR, idempotencyKey: STR },
        ['userId', 'channel', 'enabled'],
      ),
      (ctx, input) => setPreference(ctx, as(input)),
    ),
    ctxAction(
      'notifications_list_preferences',
      'read',
      'Die Benachrichtigungs-Einstellungen (P5, US-G06.3): the three wildcard rows first (stored where a row exists, the built-in default where none does: inbox on, email and push off), then every stored per-event override, plus the registry\'s known events so a panel renders each at its inherited default rather than an empty screen. Reading another user\'s preferences asserts manage_members.',
      ctxSchema({ userId: STR }, ['userId']),
      (ctx, input) => listPreferences(ctx, as(input)),
    ),
    ctxAction(
      'notifications_run_digest',
      'write',
      'Erzeuge eine Zusammenfassung (OP4, US-G06.4): gathers the recipient\'s inbox items in the window whose preference opted the outbound channel (email|push) into a digest cadence, renders ONE local digest artifact, and persists the digest_run honesty record. The OSS core wires no transmitter, so the answer is always transmitted:false with the reason named (cloud_tier, or empty when the window held nothing: an empty digest is never transmitted). channel inbox answers digest_channel_required. Running another user\'s digest asserts manage_members.',
      ctxSchema(
        { userId: STR, channel: STR, periodStart: STR, periodEnd: STR, idempotencyKey: STR },
        ['userId', 'channel', 'periodStart', 'periodEnd', 'idempotencyKey'],
      ),
      (ctx, input) => runDigest(ctx, as(input)),
    ),
  ];
}
