/**
 * G06, notifications & inbox: the ONE delivery surface every other capability's events land on.
 *
 * WHAT THIS MODULE IS. An OP8 CONSUMER, not a second engine: `deliverNotification` is the action a
 * G01 rule targets, and everything else here is the queue around what it delivered (list, mark
 * read, archive), the per-recipient preference switchboard, and the OP4 digest renderer. G06 owns
 * no reminder logic, no trigger schedule and no poll loop: E03 (and every emitting spec) decides
 * WHEN something is worth telling, G01 decides WHETHER a rule fires, this module only delivers.
 *
 * WHAT THIS MODULE IS NOT. It never touches the journal (no `_rappen` column, no `postEntry`, no
 * `recordPayment`, asserted by `test/notifications/no-money-path.test.mjs`) and it never opens a
 * socket: the OSS core wires NO notification transmitter port, so `runDigest` renders the local
 * artifact and answers `{transmitted:false, reason:'cloud_tier'}` (Pattern OP4, honest degradation
 * P9). The import-boundary half of the same test proves the absence statically.
 *
 * TENANCY AND SELF-SCOPE (§H-TENANT + spec §5): every query filters on `ctx.workspaceId`, and an
 * inbox is not a shared mailbox: the list and the mutations bind `user_id` to `ctx.actor`
 * structurally, so a foreign notification id answers the same `notification_not_found` a
 * nonexistent one does. A verb that ACCEPTS a `userId` refuses a foreign one with `forbidden`;
 * the two admin verbs (`setPreference`/`listPreferences`/`runDigest` on another user) assert A24's
 * `manage_members` live through the capability port.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { automationEventDef, AUTOMATION_EVENT_IDS } from '../automation/events.js';
import { entityKindDef, ENTITY_KIND_IDS, tenantColumnOf } from '../customization/entities.js';
import { applySavedView } from '../customization/views.js';
import {
  isInboxItemStatus,
  isNotificationChannel,
  isDigestCadence,
  WILDCARD_EVENT,
} from './enums.js';
import type { NotificationChannel, DigestCadence } from './enums.js';

// --- Rows and views ----------------------------------------------------------------------------

export interface InboxItemRow {
  id: string;
  workspace_id: string;
  user_id: string;
  event: string;
  entity_kind: string | null;
  entity_id: string | null;
  summary_i18n_key: string;
  summary_params: string;
  status: string;
  delivered_via: string;
  digest_run_id: string | null;
  created_at: string;
  read_at: string | null;
  archived_at: string | null;
}

/** The one wire shape every verb answers an inbox item with, so the faces cannot drift (P5). */
export interface InboxItemView {
  id: string;
  userId: string;
  event: string;
  entityKind: string | null;
  entityId: string | null;
  summaryI18nKey: string;
  summaryParams: Record<string, unknown>;
  status: string;
  deliveredVia: string;
  digestRunId: string | null;
  createdAt: string;
  readAt: string | null;
  archivedAt: string | null;
  /** Query-time day grouping for display (never a stored batch, US-G06.5). */
  day: string;
}

function mapItem(row: InboxItemRow): InboxItemView {
  let params: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.summary_params);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      params = parsed as Record<string, unknown>;
    }
  } catch {
    // A row written by this module always carries valid JSON; a hand-edited one reads as {}.
  }
  return {
    id: row.id,
    userId: row.user_id,
    event: row.event,
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    summaryI18nKey: row.summary_i18n_key,
    summaryParams: params,
    status: row.status,
    deliveredVia: row.delivered_via,
    digestRunId: row.digest_run_id,
    createdAt: row.created_at,
    readAt: row.read_at,
    archivedAt: row.archived_at,
    day: row.created_at.slice(0, 10),
  };
}

interface PrefRow {
  id: string;
  user_id: string;
  event: string;
  channel: string;
  enabled: number;
  digest: string;
  updated_at: string;
}

/** One preference the panel renders: stored or the synthesised wildcard default (`stored:false`). */
export interface NotificationPrefView {
  userId: string;
  event: string;
  channel: string;
  enabled: boolean;
  digest: string;
  stored: boolean;
}

function mapPref(row: PrefRow): NotificationPrefView {
  return {
    userId: row.user_id,
    event: row.event,
    channel: row.channel,
    enabled: row.enabled === 1,
    digest: row.digest,
    stored: true,
  };
}

// --- Shared helpers ----------------------------------------------------------------------------

/** A sortable ISO day or instant: `YYYY-MM-DD` prefix and parseable. Refused, never coerced. */
function isValidInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  const parsed = value.length === 10 ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
  return !Number.isNaN(parsed);
}

/** Widen a date-only window edge to the instant it means; a full instant passes through. */
function windowStart(value: string): string {
  return value.length === 10 ? `${value}T00:00:00.000Z` : value;
}
function windowEnd(value: string): string {
  return value.length === 10 ? `${value}T23:59:59.999Z` : value;
}

/**
 * The structural self-scope check (spec §5): an inbox is not a shared mailbox. `forbidden` and not
 * `permission_denied`, because this is not a role capability an admin could grant around: there is
 * no cross-user inbox read in the product at all.
 */
function requireSelf(ctx: WorkspaceContext, userId: unknown): Result | undefined {
  if (typeof userId !== 'string' || userId.length === 0) return err('invalid_input', { field: 'userId' });
  if (userId !== ctx.actor) return err('forbidden', { userId, actor: ctx.actor });
  return undefined;
}

/**
 * Self, or A24 `manage_members` for the admin-configures-a-teammate path (spec §5), asserted LIVE
 * through the capability port so a demoted admin's next call fails with nothing to invalidate.
 */
function requireSelfOrManageMembers(ctx: WorkspaceContext, userId: unknown): Result | undefined {
  if (typeof userId !== 'string' || userId.length === 0) return err('invalid_input', { field: 'userId' });
  if (userId === ctx.actor) return undefined;
  const allowed = ctx.capabilities.assert('manage_members');
  if (!allowed.ok) return err('forbidden', { userId, capability: 'manage_members' });
  return undefined;
}

/**
 * Prove an OP3 link target is real, workspace-scoped on both sides (the E03 `checkEntityLink`
 * shape). The column names are interpolated from G00's compile-time registry row, never from the
 * caller.
 */
function checkEntityLink(ctx: WorkspaceContext, entityKind: string, entityId: unknown): Result | undefined {
  const def = entityKindDef(entityKind);
  if (def === undefined) {
    return err('unknown_entity_kind', { entityKind, known: [...ENTITY_KIND_IDS] });
  }
  if (typeof entityId !== 'string' || entityId.length === 0) {
    return err('invalid_input', { field: 'entityId' });
  }
  const target = ctx.store.db
    .prepare(`SELECT ${def.idColumn} AS id FROM ${def.table} WHERE ${tenantColumnOf(def)} = ? AND ${def.idColumn} = ?`)
    .get(ctx.workspaceId, entityId);
  if (target === undefined) return err('entity_not_found', { entityKind: def.kind, entityId });
  return undefined;
}

/**
 * The preference resolution (spec §4): the exact `event` row wins, else the stored `'*'` wildcard
 * row, else the VIRTUAL default (reconciled §0.3): the in-app inbox is on and instant, outbound
 * channels are off until somebody opts in. Nothing is seeded, so nothing can drift.
 */
export function resolvePreference(
  ctx: WorkspaceContext,
  userId: string,
  event: string,
  channel: NotificationChannel,
): { enabled: boolean; digest: DigestCadence } {
  const row = ctx.store.db
    .prepare(
      `SELECT enabled, digest FROM notification_pref
        WHERE workspace_id = ? AND user_id = ? AND event = ? AND channel = ?`,
    )
    .get(ctx.workspaceId, userId, event, channel) as { enabled: number; digest: string } | undefined;
  if (row !== undefined) return { enabled: row.enabled === 1, digest: row.digest as DigestCadence };
  const wildcard = ctx.store.db
    .prepare(
      `SELECT enabled, digest FROM notification_pref
        WHERE workspace_id = ? AND user_id = ? AND event = ? AND channel = ?`,
    )
    .get(ctx.workspaceId, userId, WILDCARD_EVENT, channel) as { enabled: number; digest: string } | undefined;
  if (wildcard !== undefined) return { enabled: wildcard.enabled === 1, digest: wildcard.digest as DigestCadence };
  return channel === 'inbox' ? { enabled: true, digest: 'instant' } : { enabled: false, digest: 'instant' };
}

function readItem(ctx: WorkspaceContext, notificationId: unknown): InboxItemRow | undefined {
  if (typeof notificationId !== 'string' || notificationId.length === 0) return undefined;
  // `user_id = ctx.actor` IS the self-scope: a foreign user's id answers the same not_found a
  // nonexistent one does, so nothing can be probed across users or tenants.
  return ctx.store.db
    .prepare('SELECT * FROM inbox_item WHERE workspace_id = ? AND id = ? AND user_id = ?')
    .get(ctx.workspaceId, notificationId, ctx.actor) as InboxItemRow | undefined;
}

// --- deliver -----------------------------------------------------------------------------------

export interface DeliverNotificationInput {
  userId: string;
  event: string;
  entityKind?: string;
  entityId?: string;
  summaryI18nKey: string;
  summaryParams?: Record<string, unknown>;
  idempotencyKey: string;
}

export type DeliverNotificationOk = {
  delivered: boolean;
  notificationId: string | null;
  reason: string | null;
  item: InboxItemView | null;
};

/**
 * The OP8 action target (US-G06.1): one fired rule, one inbox row, or an honest `delivered:false`
 * when the recipient muted the moment. Never transmits anything (reconciled §0.7): the in-app
 * inbox is the whole local effect, and outbound channels belong to `runDigest` on the cloud tier.
 */
export function deliverNotification(ctx: WorkspaceContext, input: DeliverNotificationInput): Result<DeliverNotificationOk> {
  if (typeof input.userId !== 'string' || input.userId.length === 0) {
    return err('invalid_input', { field: 'userId' });
  }
  if (automationEventDef(input.event) === undefined) {
    return err('unknown_event', { event: input.event, known: [...AUTOMATION_EVENT_IDS] });
  }
  if (typeof input.summaryI18nKey !== 'string' || input.summaryI18nKey.trim().length === 0) {
    return err('invalid_input', { field: 'summaryI18nKey' });
  }
  if (input.summaryParams !== undefined && (input.summaryParams === null || typeof input.summaryParams !== 'object' || Array.isArray(input.summaryParams))) {
    return err('invalid_input', { field: 'summaryParams' });
  }
  if ((input.entityKind === undefined) !== (input.entityId === undefined)) {
    return err('invalid_input', { field: input.entityKind === undefined ? 'entityKind' : 'entityId' });
  }
  if (input.entityKind !== undefined) {
    const refused = checkEntityLink(ctx, input.entityKind, input.entityId);
    if (refused !== undefined) return refused as Result<DeliverNotificationOk>;
  }
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }

  const run = (): Result<DeliverNotificationOk> => {
    const pref = resolvePreference(ctx, input.userId, input.event, 'inbox');
    if (!pref.enabled) {
      // A muted delivery is a successful non-delivery (US-G06.3), never an error: the rule that
      // fired is fine, the recipient just chose silence for this moment.
      return ok<DeliverNotificationOk>({ delivered: false, notificationId: null, reason: 'muted', item: null });
    }
    const id = ctx.ids.next('ntf');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO inbox_item (
           id, workspace_id, user_id, event, entity_kind, entity_id,
           summary_i18n_key, summary_params, status, delivered_via, digest_run_id,
           created_at, read_at, archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unread', 'inbox', NULL, ?, NULL, NULL)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.userId,
        input.event,
        input.entityKind ?? null,
        input.entityId ?? null,
        input.summaryI18nKey.trim(),
        JSON.stringify(input.summaryParams ?? {}),
        now,
      );
    const row = ctx.store.db
      .prepare('SELECT * FROM inbox_item WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, id) as InboxItemRow;
    return ok<DeliverNotificationOk>({ delivered: true, notificationId: id, reason: null, item: mapItem(row) });
  };

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'notifications_deliver', run);
}

// --- list --------------------------------------------------------------------------------------

export interface ListInboxInput {
  userId: string;
  status?: string;
  bucket?: string;
  savedViewId?: string;
}

export type ListInboxOk = {
  items: InboxItemView[];
  unreadCount: number;
};

/** The queue read model (P5, US-G06.2): newest first, self-scoped, with the live unread count. */
export function listInbox(ctx: WorkspaceContext, input: ListInboxInput): Result<ListInboxOk> {
  const notSelf = requireSelf(ctx, input.userId);
  if (notSelf !== undefined) return notSelf as Result<ListInboxOk>;

  // The G00 seam: a stored view's filters merge UNDERNEATH anything named explicitly here. The
  // recipient is never view-controlled: self-scope is structural, so a stored `userId` is ignored.
  const applied = applySavedView(ctx, 'inbox_item', {
    savedViewId: input.savedViewId,
    status: input.status,
    bucket: input.bucket,
  });
  if (!applied.ok) return applied;
  const filter = applied.filter;

  if (filter.status !== undefined && !isInboxItemStatus(filter.status)) {
    return err('invalid_input', { field: 'status' });
  }
  if (filter.bucket !== undefined && (typeof filter.bucket !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(filter.bucket))) {
    return err('invalid_input', { field: 'bucket' });
  }

  let sql = 'SELECT * FROM inbox_item WHERE workspace_id = ? AND user_id = ?';
  const params: unknown[] = [ctx.workspaceId, input.userId];
  if (filter.status !== undefined) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  if (filter.bucket !== undefined) {
    sql += " AND substr(created_at, 1, 10) = ?";
    params.push(filter.bucket);
  }
  sql += ' ORDER BY created_at DESC, id DESC';
  const rows = ctx.store.db.prepare(sql).all(...params) as InboxItemRow[];

  const unread = ctx.store.db
    .prepare("SELECT COUNT(*) AS n FROM inbox_item WHERE workspace_id = ? AND user_id = ? AND status = 'unread'")
    .get(ctx.workspaceId, input.userId) as { n: number };

  return ok<ListInboxOk>({ items: rows.map(mapItem), unreadCount: unread.n });
}

// --- mark read / mark all read / archive -------------------------------------------------------

export type MarkReadOk = { notificationId: string; status: string };

/**
 * `unread -> read` (US-G06.2). Marking an already-read item read is a successful state assertion;
 * an ARCHIVED item is outside the mutable set and answers `notification_not_found` (spec §2).
 */
export function markRead(ctx: WorkspaceContext, input: { notificationId: string; idempotencyKey?: string }): Result<MarkReadOk> {
  const run = (): Result<MarkReadOk> => {
    const row = readItem(ctx, input.notificationId);
    if (row === undefined || row.status === 'archived') {
      return err('notification_not_found', { notificationId: input.notificationId }) as Result<MarkReadOk>;
    }
    if (row.status === 'unread') {
      ctx.store.db
        .prepare("UPDATE inbox_item SET status = 'read', read_at = ? WHERE workspace_id = ? AND id = ?")
        .run(ctx.clock.now(), ctx.workspaceId, row.id);
    }
    return ok<MarkReadOk>({ notificationId: row.id, status: 'read' });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'notifications_mark_read', run);
  }
  return ctx.store.tx(run);
}

export type MarkAllReadOk = { markedCount: number };

/** The one-call queue clear (US-G06.2): every unread item of the CALLER becomes read. */
export function markAllRead(ctx: WorkspaceContext, input: { userId: string; idempotencyKey?: string }): Result<MarkAllReadOk> {
  const notSelf = requireSelf(ctx, input.userId);
  if (notSelf !== undefined) return notSelf as Result<MarkAllReadOk>;
  const run = (): Result<MarkAllReadOk> => {
    const outcome = ctx.store.db
      .prepare(
        "UPDATE inbox_item SET status = 'read', read_at = ? WHERE workspace_id = ? AND user_id = ? AND status = 'unread'",
      )
      .run(ctx.clock.now(), ctx.workspaceId, input.userId);
    return ok<MarkAllReadOk>({ markedCount: outcome.changes });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'notifications_mark_all_read', run);
  }
  return ctx.store.tx(run);
}

export type ArchiveNotificationOk = { notificationId: string; status: string };

/**
 * `unread|read -> archived` (US-G06.2, reading first is not required). Archiving an archived item
 * is a successful state assertion: "make sure this is out of the queue" asserts a state.
 */
export function archiveNotification(
  ctx: WorkspaceContext,
  input: { notificationId: string; idempotencyKey?: string },
): Result<ArchiveNotificationOk> {
  const run = (): Result<ArchiveNotificationOk> => {
    const row = readItem(ctx, input.notificationId);
    if (row === undefined) {
      return err('notification_not_found', { notificationId: input.notificationId }) as Result<ArchiveNotificationOk>;
    }
    if (row.status !== 'archived') {
      ctx.store.db
        .prepare("UPDATE inbox_item SET status = 'archived', archived_at = ? WHERE workspace_id = ? AND id = ?")
        .run(ctx.clock.now(), ctx.workspaceId, row.id);
    }
    return ok<ArchiveNotificationOk>({ notificationId: row.id, status: 'archived' });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'notifications_archive', run);
  }
  return ctx.store.tx(run);
}

// --- preferences -------------------------------------------------------------------------------

export interface SetPreferenceInput {
  userId: string;
  event?: string;
  channel: string;
  enabled: boolean;
  digest?: string;
  idempotencyKey?: string;
}

export type SetPreferenceOk = { preference: NotificationPrefView };

/**
 * Upsert one `(recipient, event, channel)` preference row (US-G06.3). `event` omitted writes the
 * wildcard row every unlisted event falls back to. The in-app inbox is ALWAYS instant (spec §6b
 * Fixed): a cadence other than `instant` on `channel:'inbox'` answers `inbox_is_always_instant`.
 */
export function setPreference(ctx: WorkspaceContext, input: SetPreferenceInput): Result<SetPreferenceOk> {
  const denied = requireSelfOrManageMembers(ctx, input.userId);
  if (denied !== undefined) return denied as Result<SetPreferenceOk>;
  if (!isNotificationChannel(input.channel)) {
    return err('invalid_channel', { channel: input.channel, known: ['inbox', 'email', 'push'] });
  }
  if (typeof input.enabled !== 'boolean') return err('invalid_input', { field: 'enabled' });
  const digest = input.digest ?? 'instant';
  if (!isDigestCadence(digest)) return err('invalid_input', { field: 'digest' });
  if (input.channel === 'inbox' && digest !== 'instant') {
    return err('inbox_is_always_instant', { channel: input.channel, digest });
  }
  const event = input.event ?? WILDCARD_EVENT;
  if (event !== WILDCARD_EVENT && automationEventDef(event) === undefined) {
    return err('unknown_event', { event, known: [...AUTOMATION_EVENT_IDS] });
  }

  const run = (): Result<SetPreferenceOk> => {
    const now = ctx.clock.now();
    const existing = ctx.store.db
      .prepare(
        'SELECT id FROM notification_pref WHERE workspace_id = ? AND user_id = ? AND event = ? AND channel = ?',
      )
      .get(ctx.workspaceId, input.userId, event, input.channel) as { id: string } | undefined;
    if (existing === undefined) {
      ctx.store.db
        .prepare(
          `INSERT INTO notification_pref (id, workspace_id, user_id, event, channel, enabled, digest, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ctx.ids.next('npref'), ctx.workspaceId, input.userId, event, input.channel, input.enabled ? 1 : 0, digest, now, now);
    } else {
      ctx.store.db
        .prepare('UPDATE notification_pref SET enabled = ?, digest = ?, updated_at = ? WHERE id = ?')
        .run(input.enabled ? 1 : 0, digest, now, existing.id);
    }
    const row = ctx.store.db
      .prepare(
        `SELECT id, user_id, event, channel, enabled, digest, updated_at FROM notification_pref
          WHERE workspace_id = ? AND user_id = ? AND event = ? AND channel = ?`,
      )
      .get(ctx.workspaceId, input.userId, event, input.channel) as PrefRow;
    return ok<SetPreferenceOk>({ preference: mapPref(row) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'notifications_set_preference', run);
  }
  return ctx.store.tx(run);
}

export type ListPreferencesOk = {
  preferences: NotificationPrefView[];
  knownEvents: string[];
};

/**
 * The read model behind the preferences panel (US-G06.3): the three wildcard rows FIRST (stored
 * where a row exists, synthesised at the virtual default where none does, reconciled §0.3), then
 * every stored per-event override, then the registry's known events so the panel can render each
 * at its inherited default rather than an empty screen.
 */
export function listPreferences(ctx: WorkspaceContext, input: { userId: string }): Result<ListPreferencesOk> {
  const denied = requireSelfOrManageMembers(ctx, input.userId);
  if (denied !== undefined) return denied as Result<ListPreferencesOk>;

  const stored = ctx.store.db
    .prepare(
      `SELECT id, user_id, event, channel, enabled, digest, updated_at FROM notification_pref
        WHERE workspace_id = ? AND user_id = ? ORDER BY event, channel`,
    )
    .all(ctx.workspaceId, input.userId) as PrefRow[];

  const wildcards: NotificationPrefView[] = (['inbox', 'email', 'push'] as const).map((channel) => {
    const row = stored.find((p) => p.event === WILDCARD_EVENT && p.channel === channel);
    if (row !== undefined) return mapPref(row);
    const fallback = resolvePreference(ctx, input.userId, WILDCARD_EVENT, channel);
    return {
      userId: input.userId,
      event: WILDCARD_EVENT,
      channel,
      enabled: fallback.enabled,
      digest: fallback.digest,
      stored: false,
    };
  });
  const overrides = stored.filter((p) => p.event !== WILDCARD_EVENT).map(mapPref);

  return ok<ListPreferencesOk>({
    preferences: [...wildcards, ...overrides],
    knownEvents: [...AUTOMATION_EVENT_IDS],
  });
}

// --- digest ------------------------------------------------------------------------------------

export interface RunDigestInput {
  userId: string;
  channel: string;
  periodStart: string;
  periodEnd: string;
  idempotencyKey: string;
}

export type RunDigestOk = {
  digestRunId: string;
  status: string;
  itemCount: number;
  transmitted: boolean;
  reason: string | null;
  localArtifactRef: string | null;
};

/**
 * The OP4 outbound half (US-G06.4): gather the window, render ONE local digest artifact, persist
 * the `digest_run` honesty record, and STOP. The OSS core wires no transmitter, so `transmitted`
 * is always false here with the reason named (`cloud_tier`), exactly like E01's e-sign artifact.
 * An empty window still runs (auditable) and is never transmitted.
 */
export function runDigest(ctx: WorkspaceContext, input: RunDigestInput): Result<RunDigestOk> {
  const denied = requireSelfOrManageMembers(ctx, input.userId);
  if (denied !== undefined) return denied as Result<RunDigestOk>;
  if (!isNotificationChannel(input.channel)) {
    return err('invalid_channel', { channel: input.channel, known: ['inbox', 'email', 'push'] });
  }
  if (input.channel === 'inbox') {
    // The in-app inbox has no digest concept (US-G06.3's boundary): local delivery is always
    // immediate and always complete, so digesting it would silently weaken US-G06.5.
    return err('digest_channel_required', { channel: input.channel, known: ['email', 'push'] });
  }
  if (typeof input.periodStart !== 'string' || !isValidInstant(input.periodStart)) {
    return err('invalid_input', { field: 'periodStart' });
  }
  if (typeof input.periodEnd !== 'string' || !isValidInstant(input.periodEnd)) {
    return err('invalid_input', { field: 'periodEnd' });
  }
  const start = windowStart(input.periodStart);
  const end = windowEnd(input.periodEnd);
  if (start > end) return err('invalid_input', { field: 'periodEnd' });
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const channel = input.channel as NotificationChannel;

  const run = (): Result<RunDigestOk> => {
    const rows = ctx.store.db
      .prepare(
        `SELECT * FROM inbox_item
          WHERE workspace_id = ? AND user_id = ? AND created_at >= ? AND created_at <= ?
          ORDER BY created_at, id`,
      )
      .all(ctx.workspaceId, input.userId, start, end) as InboxItemRow[];
    // "Matching" (spec §4): the rows whose preference opted THIS channel into a digest cadence.
    const matched = rows.filter((row) => {
      const pref = resolvePreference(ctx, input.userId, row.event, channel);
      return pref.enabled && pref.digest !== 'instant';
    });

    const id = ctx.ids.next('dgst');
    const now = ctx.clock.now();
    const status = matched.length === 0 ? 'empty' : 'ok';
    const artifact =
      matched.length === 0
        ? null
        : JSON.stringify({
            userId: input.userId,
            channel,
            periodStart: start,
            periodEnd: end,
            items: matched.map((row) => ({
              event: row.event,
              summaryI18nKey: row.summary_i18n_key,
              summaryParams: row.summary_params,
              entityKind: row.entity_kind,
              entityId: row.entity_id,
              createdAt: row.created_at,
            })),
          });
    const artifactRef = matched.length === 0 ? null : `digest_run:${id}`;
    ctx.store.db
      .prepare(
        `INSERT INTO digest_run (
           id, workspace_id, user_id, channel, period_start, period_end,
           item_count, status, local_artifact_ref, artifact_json, transmitted, rendered_at, transmitted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`,
      )
      .run(id, ctx.workspaceId, input.userId, channel, start, end, matched.length, status, artifactRef, artifact, now);
    if (matched.length > 0) {
      const stamp = ctx.store.db.prepare('UPDATE inbox_item SET digest_run_id = ? WHERE workspace_id = ? AND id = ?');
      for (const row of matched) stamp.run(id, ctx.workspaceId, row.id);
    }
    return ok<RunDigestOk>({
      digestRunId: id,
      status,
      itemCount: matched.length,
      transmitted: false,
      // An empty run has nothing to transmit; a rendered one is held at the OP4 gate (§0.7).
      reason: matched.length === 0 ? 'empty' : 'cloud_tier',
      localArtifactRef: artifactRef,
    });
  };

  return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'notifications_run_digest', run);
}
