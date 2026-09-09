/**
 * G06, notifications & inbox: the barrel `src/api/` imports from (the one door, per the module
 * map's standing rule). Event delivery (the OP8 action target), the self-scoped inbox queue, the
 * per-recipient preference switchboard, and the OP4 digest renderer.
 */

export {
  deliverNotification,
  listInbox,
  markRead,
  markAllRead,
  archiveNotification,
  setPreference,
  listPreferences,
  runDigest,
  resolvePreference,
} from './notifications.js';
export type {
  DeliverNotificationOk,
  ListInboxOk,
  MarkReadOk,
  MarkAllReadOk,
  ArchiveNotificationOk,
  SetPreferenceOk,
  ListPreferencesOk,
  RunDigestOk,
  InboxItemView,
  NotificationPrefView,
} from './notifications.js';
export {
  INBOX_ITEM_STATUSES,
  NOTIFICATION_CHANNELS,
  DIGEST_CADENCES,
  DIGEST_RUN_STATUSES,
  WILDCARD_EVENT,
} from './enums.js';
export { NOTIFICATIONS_SCHEMA_SQL } from './schema.js';
