/**
 * G06's engine behaviour, driven through the registry (both faces run the same `action.run`).
 *
 * The suite proves the spec's own §2/§8 acceptance criteria: delivery idempotency (one row per
 * key, ever), preference resolution (exact event beats wildcard beats the virtual default), the
 * honest muted non-delivery, the unknown-event and OP3 refusals, the self-scope fence
 * (`forbidden` on a foreign userId, `notification_not_found` on a foreign item), the
 * unread -> read -> archived progression with its archived-is-immutable rule, the preference
 * validation pair (`invalid_channel`, `inbox_is_always_instant`), the digest's channel gate
 * (`digest_channel_required`), its empty-window honesty, and that a rendered digest is NEVER
 * transmitted in the OSS core (`transmitted:false, reason:'cloud_tier'`), plus §H-TENANT
 * isolation across two workspaces.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { setPreference, listPreferences, runDigest } from '../../dist/core/notifications/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

// The fixture actor is `agent` (freshDeps), so `agent` is the self every scoped verb sees.
function world() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, call };
}

function deliver(call, overrides = {}, key = 'seed') {
  const res = call('notifications_deliver', {
    userId: 'agent',
    event: 'task.due',
    summaryI18nKey: 'notifications.summary.task_due',
    summaryParams: { title: 'Offerte nachfassen' },
    idempotencyKey: `nt-${key}`,
    ...overrides,
  });
  assert.equal(res.ok, true, `notifications_deliver refused: ${JSON.stringify(res)}`);
  return res;
}

test('G06: deliver is idempotent on rows: one key, one inbox_item, however often it replays', () => {
  const { deps, workspaceId, call } = world();
  const first = deliver(call, {}, 'idem');
  const replay = deliver(call, {}, 'idem');
  assert.equal(replay.notificationId, first.notificationId, 'a replay minted a second id');
  const n = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM inbox_item WHERE workspace_id = ?')
    .get(workspaceId);
  assert.equal(n.n, 1, 'the same idempotency key wrote a second row');
  // A DIFFERENT key is a genuinely new delivery.
  deliver(call, {}, 'idem2');
  const n2 = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM inbox_item WHERE workspace_id = ?')
    .get(workspaceId);
  assert.equal(n2.n, 2);
});

test('G06: an event outside the automation registry is refused with unknown_event, never a 500', () => {
  const { call } = world();
  const res = call('notifications_deliver', {
    userId: 'agent',
    event: 'unicorn.spotted',
    summaryI18nKey: 'x',
    idempotencyKey: 'nt-ue',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_event');
  assert.ok(Array.isArray(res.known) && res.known.includes('task.due'), 'the refusal names the real set');
});

test('G06: the OP3 pair is validated against the registry and the workspace, both sides', () => {
  const { call } = world();
  const unknown = call('notifications_deliver', {
    userId: 'agent', event: 'task.due', entityKind: 'unicorn', entityId: 'x',
    summaryI18nKey: 'k', idempotencyKey: 'nt-op3a',
  });
  assert.equal(unknown.error, 'unknown_entity_kind');
  const missing = call('notifications_deliver', {
    userId: 'agent', event: 'task.due', entityKind: 'contact', entityId: 'not-there',
    summaryI18nKey: 'k', idempotencyKey: 'nt-op3b',
  });
  assert.equal(missing.error, 'entity_not_found');
  const half = call('notifications_deliver', {
    userId: 'agent', event: 'task.due', entityKind: 'contact',
    summaryI18nKey: 'k', idempotencyKey: 'nt-op3c',
  });
  assert.equal(half.error, 'invalid_input');
});

test('G06: preference resolution: exact event beats wildcard beats the built-in default (US-G06.3)', () => {
  const { call } = world();
  // Virtual default: inbox on. Nothing stored yet.
  const d1 = deliver(call, { event: 'invoice.issued', summaryI18nKey: 'k1' }, 'pr1');
  assert.equal(d1.delivered, true);
  // Stored wildcard OFF mutes every event without its own row...
  const wc = call('notifications_set_preference', {
    userId: 'agent', channel: 'inbox', enabled: false, idempotencyKey: 'nt-prw',
  });
  assert.equal(wc.ok, true);
  const muted = call('notifications_deliver', {
    userId: 'agent', event: 'invoice.issued', summaryI18nKey: 'k2', idempotencyKey: 'nt-pr2',
  });
  assert.equal(muted.ok, true, 'a muted delivery must be a SUCCESSFUL non-delivery');
  assert.equal(muted.delivered, false);
  assert.equal(muted.reason, 'muted');
  assert.equal(muted.notificationId, null, 'a muted delivery wrote a row anyway');
  // ...and an explicit per-event row ON wins over the wildcard OFF.
  const explicit = call('notifications_set_preference', {
    userId: 'agent', event: 'invoice.issued', channel: 'inbox', enabled: true, idempotencyKey: 'nt-pre',
  });
  assert.equal(explicit.ok, true);
  const d2 = deliver(call, { event: 'invoice.issued', summaryI18nKey: 'k3' }, 'pr3');
  assert.equal(d2.delivered, true);
  // Another event still falls back to the wildcard OFF.
  const still = call('notifications_deliver', {
    userId: 'agent', event: 'task.due', summaryI18nKey: 'k4', idempotencyKey: 'nt-pr4',
  });
  assert.equal(still.delivered, false);
});

test('G06: the list is self-scoped, newest first, with the live unreadCount and the day grouping', () => {
  const { call } = world();
  deliver(call, { summaryI18nKey: 'a' }, 'l1');
  deliver(call, { event: 'invoice.issued', summaryI18nKey: 'b' }, 'l2');
  const listed = call('notifications_list', { userId: 'agent' });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.items.length, 2);
  assert.equal(listed.unreadCount, 2);
  assert.equal(listed.items[0].day, listed.items[0].createdAt.slice(0, 10));
  // A foreign userId is forbidden: an inbox is not a shared mailbox (US-G06.2).
  const foreign = call('notifications_list', { userId: 'somebody-else' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'forbidden');
  const clearForeign = call('notifications_mark_all_read', { userId: 'somebody-else', idempotencyKey: 'nt-lf' });
  assert.equal(clearForeign.error, 'forbidden');
  // The status filter narrows; the unreadCount stays the whole truth.
  const read = call('notifications_mark_read', {
    notificationId: listed.items[0].id, idempotencyKey: 'nt-l3',
  });
  assert.equal(read.ok, true);
  const unreadOnly = call('notifications_list', { userId: 'agent', status: 'unread' });
  assert.equal(unreadOnly.items.length, 1);
  assert.equal(unreadOnly.unreadCount, 1);
});

test('G06: unread -> read -> archived; archived is outside the mutable set (US-G06.2)', () => {
  const { call } = world();
  const d = deliver(call, {}, 'm1');
  // Mark read stamps read_at; a second mark is a successful state assertion.
  const read = call('notifications_mark_read', { notificationId: d.notificationId, idempotencyKey: 'nt-m2' });
  assert.equal(read.ok, true);
  const again = call('notifications_mark_read', { notificationId: d.notificationId, idempotencyKey: 'nt-m3' });
  assert.equal(again.ok, true);
  // Archive; then marking the ARCHIVED item read is refused (spec §2 Error).
  const archived = call('notifications_archive', { notificationId: d.notificationId, idempotencyKey: 'nt-m4' });
  assert.equal(archived.ok, true);
  const refused = call('notifications_mark_read', { notificationId: d.notificationId, idempotencyKey: 'nt-m5' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'notification_not_found');
  // unread -> archived directly is allowed (archiving does not require reading first).
  const d2 = deliver(call, { summaryI18nKey: 'direct' }, 'm6');
  const direct = call('notifications_archive', { notificationId: d2.notificationId, idempotencyKey: 'nt-m7' });
  assert.equal(direct.ok, true);
  assert.equal(direct.status, 'archived');
  const archivedList = call('notifications_list', { userId: 'agent', status: 'archived' });
  assert.equal(archivedList.items.length, 2);
});

test('G06: mark_all_read clears the whole unread set in one call and replays as a no-op', () => {
  const { call } = world();
  deliver(call, { summaryI18nKey: 'a' }, 'a1');
  deliver(call, { event: 'invoice.issued', summaryI18nKey: 'b' }, 'a2');
  const cleared = call('notifications_mark_all_read', { userId: 'agent', idempotencyKey: 'nt-a3' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.markedCount, 2);
  const replay = call('notifications_mark_all_read', { userId: 'agent', idempotencyKey: 'nt-a3' });
  assert.equal(replay.markedCount, 2, 'the replay must answer the memo, not re-count');
  assert.equal(call('notifications_list', { userId: 'agent' }).unreadCount, 0);
});

test('G06: the preference validation pair: invalid_channel and inbox_is_always_instant', () => {
  const { call } = world();
  const badChannel = call('notifications_set_preference', {
    userId: 'agent', channel: 'pigeon', enabled: true, idempotencyKey: 'nt-p1',
  });
  assert.equal(badChannel.error, 'invalid_channel');
  const badCadence = call('notifications_set_preference', {
    userId: 'agent', channel: 'inbox', enabled: true, digest: 'daily', idempotencyKey: 'nt-p2',
  });
  assert.equal(badCadence.error, 'inbox_is_always_instant');
  const badEvent = call('notifications_set_preference', {
    userId: 'agent', event: 'unicorn.spotted', channel: 'email', enabled: true, idempotencyKey: 'nt-p3',
  });
  assert.equal(badEvent.error, 'unknown_event');
  // The upsert really upserts: same (event, channel) twice is one row, second value wins.
  const on = call('notifications_set_preference', {
    userId: 'agent', event: 'task.due', channel: 'email', enabled: true, digest: 'daily', idempotencyKey: 'nt-p4',
  });
  assert.equal(on.ok, true);
  const off = call('notifications_set_preference', {
    userId: 'agent', event: 'task.due', channel: 'email', enabled: false, digest: 'weekly', idempotencyKey: 'nt-p5',
  });
  assert.equal(off.ok, true);
  assert.equal(off.preference.enabled, false);
  assert.equal(off.preference.digest, 'weekly');
});

test('G06: list_preferences answers the synthesised wildcard defaults plus overrides, never an empty screen', () => {
  const { call } = world();
  const fresh = call('notifications_list_preferences', { userId: 'agent' });
  assert.equal(fresh.ok, true);
  const wildcards = fresh.preferences.filter((p) => p.event === '*');
  assert.equal(wildcards.length, 3, 'the three channels arrive even with nothing stored');
  const inbox = wildcards.find((p) => p.channel === 'inbox');
  assert.equal(inbox.enabled, true, 'the in-app inbox defaults ON');
  assert.equal(inbox.stored, false, 'the default is synthesised, not seeded');
  const email = wildcards.find((p) => p.channel === 'email');
  assert.equal(email.enabled, false, 'outbound defaults OFF');
  assert.ok(fresh.knownEvents.includes('task.due'), 'the panel gets the registry to render rows from');
  // A stored override arrives alongside, flagged stored:true.
  call('notifications_set_preference', {
    userId: 'agent', event: 'deal.stage_changed', channel: 'inbox', enabled: false, idempotencyKey: 'nt-lp1',
  });
  const after = call('notifications_list_preferences', { userId: 'agent' });
  const override = after.preferences.find((p) => p.event === 'deal.stage_changed');
  assert.equal(override.stored, true);
  assert.equal(override.enabled, false);
});

test('G06: the digest gate: inbox has no digest concept, and an unknown channel is invalid', () => {
  const { call } = world();
  const inbox = call('notifications_run_digest', {
    userId: 'agent', channel: 'inbox', periodStart: '2026-07-01', periodEnd: '2026-07-31', idempotencyKey: 'nt-d1',
  });
  assert.equal(inbox.error, 'digest_channel_required');
  const bad = call('notifications_run_digest', {
    userId: 'agent', channel: 'pigeon', periodStart: '2026-07-01', periodEnd: '2026-07-31', idempotencyKey: 'nt-d2',
  });
  assert.equal(bad.error, 'invalid_channel');
});

test('G06: an empty window still runs (auditable), is never transmitted, and renders no artifact', () => {
  const { deps, workspaceId, call } = world();
  const run = call('notifications_run_digest', {
    userId: 'agent', channel: 'email', periodStart: '2020-01-01', periodEnd: '2020-01-31', idempotencyKey: 'nt-e1',
  });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.status, 'empty');
  assert.equal(run.itemCount, 0);
  assert.equal(run.transmitted, false);
  assert.equal(run.localArtifactRef, null);
  const row = deps.store.db
    .prepare('SELECT * FROM digest_run WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, run.digestRunId);
  assert.equal(row.status, 'empty');
  assert.equal(row.transmitted, 0);
});

test('G06: a rendered digest gathers only digest-opted events, persists the local artifact, and STOPS (OP4)', () => {
  const { deps, workspaceId, call } = world();
  // task.due opts email into daily; invoice.issued stays at the email default (off).
  call('notifications_set_preference', {
    userId: 'agent', event: 'task.due', channel: 'email', enabled: true, digest: 'daily', idempotencyKey: 'nt-g1',
  });
  deliver(call, { summaryI18nKey: 'in-window' }, 'g2');
  deliver(call, { event: 'invoice.issued', summaryI18nKey: 'not-opted' }, 'g3');
  const run = call('notifications_run_digest', {
    userId: 'agent', channel: 'email', periodStart: '2026-07-01', periodEnd: '2026-07-31', idempotencyKey: 'nt-g4',
  });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.status, 'ok');
  assert.equal(run.itemCount, 1, 'only the digest-opted event belongs in the digest');
  assert.equal(run.transmitted, false, 'the OSS core NEVER transmits');
  assert.equal(run.reason, 'cloud_tier');
  assert.equal(run.localArtifactRef, `digest_run:${run.digestRunId}`);
  const row = deps.store.db
    .prepare('SELECT * FROM digest_run WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, run.digestRunId);
  const artifact = JSON.parse(row.artifact_json);
  assert.equal(artifact.items.length, 1);
  assert.equal(artifact.items[0].event, 'task.due');
  // The gathered item is stamped with the run it went into.
  const stamped = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM inbox_item WHERE workspace_id = ? AND digest_run_id = ?')
    .get(workspaceId, run.digestRunId);
  assert.equal(stamped.n, 1);
  // The replay answers the memo: one run row per key, ever.
  const replay = call('notifications_run_digest', {
    userId: 'agent', channel: 'email', periodStart: '2026-07-01', periodEnd: '2026-07-31', idempotencyKey: 'nt-g4',
  });
  assert.equal(replay.digestRunId, run.digestRunId);
  const runs = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM digest_run WHERE workspace_id = ?')
    .get(workspaceId);
  assert.equal(runs.n, 1);
});

test('G06: the admin path asserts manage_members LIVE: a denying port answers forbidden', () => {
  const { deps, workspaceId, call } = world();
  deliver(call, {}, 'mm0');
  const denying = { assert: (capability) => ({ ok: false, error: 'permission_denied', capability }) };
  const ctx = makeContext(deps.store, { workspaceId, actor: 'agent', capabilities: denying, clock: deps.clock, ids: deps.ids });
  const set = setPreference(ctx, { userId: 'teammate', channel: 'email', enabled: true, idempotencyKey: 'nt-mm1' });
  assert.equal(set.ok, false);
  assert.equal(set.error, 'forbidden');
  const listed = listPreferences(ctx, { userId: 'teammate' });
  assert.equal(listed.error, 'forbidden');
  const digest = runDigest(ctx, {
    userId: 'teammate', channel: 'email', periodStart: '2026-07-01', periodEnd: '2026-07-31', idempotencyKey: 'nt-mm2',
  });
  assert.equal(digest.error, 'forbidden');
  // Your OWN row never consults the port at all: the denying port stays silent for self.
  const own = setPreference(ctx, { userId: 'agent', channel: 'email', enabled: true, idempotencyKey: 'nt-mm3' });
  assert.equal(own.ok, true, JSON.stringify(own));
});

test('G06: §H-TENANT: a verb aimed at tenant B can never read or move tenant A rows', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'Tenant A', 'ws-a');
  const b = mintWorkspace(deps, 'Tenant B', 'ws-b');
  const callA = (name, input) => getAction(name).run(deps, { workspaceId: a.workspaceId, ...input });
  const callB = (name, input) => getAction(name).run(deps, { workspaceId: b.workspaceId, ...input });
  const d = callA('notifications_deliver', {
    userId: 'agent', event: 'task.due', summaryI18nKey: 'k', idempotencyKey: 'nt-t1',
  });
  assert.equal(d.ok, true, JSON.stringify(d));
  // The other tenant sees nothing and can mutate nothing, by the same not_found a nonexistent id gets.
  const listedB = callB('notifications_list', { userId: 'agent' });
  assert.equal(listedB.items.length, 0);
  const readB = callB('notifications_mark_read', { notificationId: d.notificationId, idempotencyKey: 'nt-t2' });
  assert.equal(readB.error, 'notification_not_found');
  const archiveB = callB('notifications_archive', { notificationId: d.notificationId, idempotencyKey: 'nt-t3' });
  assert.equal(archiveB.error, 'notification_not_found');
  const listedA = callA('notifications_list', { userId: 'agent' });
  assert.equal(listedA.items.length, 1);
  assert.equal(listedA.items[0].status, 'unread', 'tenant B moved tenant A state');
});

test('G06: the saved-view seam (G00): a stored inbox_item view filters the queue, explicit filters win', () => {
  const { call } = world();
  deliver(call, { summaryI18nKey: 'a' }, 'v1');
  const d2 = deliver(call, { event: 'invoice.issued', summaryI18nKey: 'b' }, 'v2');
  call('notifications_mark_read', { notificationId: d2.notificationId, idempotencyKey: 'nt-v3' });
  const view = call('create_saved_view', {
    entityKind: 'inbox_item',
    name: 'Nur ungelesen',
    filters: { status: 'unread' },
    idempotencyKey: 'nt-v4',
  });
  assert.equal(view.ok, true, JSON.stringify(view));
  const filtered = call('notifications_list', { userId: 'agent', savedViewId: view.savedView.viewId });
  assert.equal(filtered.ok, true, JSON.stringify(filtered));
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].status, 'unread');
  // An explicit filter merges OVER the stored one.
  const explicit = call('notifications_list', {
    userId: 'agent', status: 'read', savedViewId: view.savedView.viewId,
  });
  assert.equal(explicit.items.length, 1);
  assert.equal(explicit.items[0].status, 'read');
});
