/**
 * G06's four §H-ENUM points, single-sourced here (the E03 `enums.ts` shape): the inbox item's
 * lifecycle, the fixed delivery channels, the digest cadences, and the digest run outcomes.
 *
 * `NOTIFICATION_CHANNELS` is FIXED by design (spec §6b): every consumer (`notification_pref`,
 * `inbox_item.delivered_via`, `digest_run.channel`) hard-codes these three, and a new delivery
 * mechanism arrives as a new OP8 action verb, never as a fourth channel value.
 */

export const INBOX_ITEM_STATUSES = ['unread', 'read', 'archived'] as const;
export type InboxItemStatus = (typeof INBOX_ITEM_STATUSES)[number];

export function isInboxItemStatus(value: unknown): value is InboxItemStatus {
  return typeof value === 'string' && (INBOX_ITEM_STATUSES as readonly string[]).includes(value);
}

export const NOTIFICATION_CHANNELS = ['inbox', 'email', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export const DIGEST_CADENCES = ['instant', 'hourly', 'daily', 'weekly'] as const;
export type DigestCadence = (typeof DIGEST_CADENCES)[number];

export function isDigestCadence(value: unknown): value is DigestCadence {
  return typeof value === 'string' && (DIGEST_CADENCES as readonly string[]).includes(value);
}

/** One-shot run outcomes, not a lifecycle (spec §4): `ok|empty|failed`. */
export const DIGEST_RUN_STATUSES = ['ok', 'empty', 'failed'] as const;
export type DigestRunStatus = (typeof DIGEST_RUN_STATUSES)[number];

/** The literal wildcard `notification_pref.event` value: "every event without its own row". */
export const WILDCARD_EVENT = '*';
