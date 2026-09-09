/**
 * E04, the local mail store: index, thread reads, draft write-back.
 *
 * WHAT THIS MODULE IS. The floor of the local-correspondence cluster (E04–E07): it turns the mail
 * client the practitioner already runs into a readable index and a writable Drafts folder,
 * without opening a socket and without making a second copy of the mail (OP6). E05 learns a voice
 * from this corpus, E06 drafts against it, E07 proves the no-socket claim; without this module
 * none of them has anything to stand on (spec §1).
 *
 * WHAT THIS MODULE IS NOT. There is NO send verb and NO SMTP anywhere in this repo: the ONLY
 * write that leaves TILL's own storage is `draftWrite`, and it writes to a LOCAL Drafts folder,
 * never a wire (P8 by construction, spec §2 US-E04.4). It never touches the journal: no
 * `_rappen`, no `postEntry`, no `recordPayment` (P3 by absence, asserted by
 * `test/mail/no-egress-and-money-path.test.mjs`). It stamps NO audit rows (spec §7: §H-AUDIT
 * untouched, the G00 posture); the one attributable erasure rides C00's own `contact_anonymise`.
 *
 * THE STORE IS THE AUTHORITY, THE INDEX IS DERIVED. `reindex` deletes rows whose message vanished
 * from the store (self-healing, US-E04.2), `threadGet` reads bodies on demand from `store_ref`
 * and flags `stale:true` when the re-read hash disagrees with `body_sha256` (US-E04.3), and
 * `purgeForContact` erases the index rows referencing a person inside C00's own anonymise
 * transaction (US-E04.5) while the mail store itself stays untouched: TILL erases what TILL
 * derived, and the practitioner's mail client is not ours to delete from.
 *
 * TENANCY (§H-TENANT): every query filters on `ctx.workspaceId`, so a foreign account, thread or
 * draft id answers the same `not_found` a nonexistent one does.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { applySavedView } from '../customization/views.js';
import { ADAPTERS, bodySha256, directionOf, parseHeaders } from './adapters.js';
import type { MailStoreAdapter, WalkedMessage } from './adapters.js';
import { isMailAdapter, isMailBucket, MAIL_ADAPTERS, MAIL_BUCKETS } from './enums.js';
import type { MailBucket } from './enums.js';
import { existsSync, statSync } from 'node:fs';

export interface MailAccountRow {
  id: string;
  workspace_id: string;
  adapter: string;
  address: string;
  store_path: string;
  enabled: number;
  last_indexed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MailThreadRow {
  id: string;
  workspace_id: string;
  account_id: string;
  thread_key: string;
  subject: string | null;
  contact_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MailMessageRow {
  id: string;
  workspace_id: string;
  account_id: string;
  thread_id: string;
  message_id: string;
  subject: string | null;
  from_address: string | null;
  to_address: string | null;
  direction: string;
  sent_at: string | null;
  store_ref: string;
  body_sha256: string;
  contact_id: string | null;
  indexed_at: string;
}

interface MailDraftRow {
  id: string;
  workspace_id: string;
  account_id: string;
  thread_id: string;
  draft_run_id: string | null;
  in_reply_to: string | null;
  store_ref: string;
  body_sha256: string;
  created_at: string;
}

function mapAccount(row: MailAccountRow) {
  return {
    id: row.id,
    adapter: row.adapter,
    address: row.address,
    storePath: row.store_path,
    enabled: row.enabled === 1,
    lastIndexedAt: row.last_indexed_at,
    createdAt: row.created_at,
  };
}

function mapDraft(row: MailDraftRow) {
  return {
    id: row.id,
    threadId: row.thread_id,
    draftRunId: row.draft_run_id,
    inReplyTo: row.in_reply_to,
    storeRef: row.store_ref,
    bodySha256: row.body_sha256,
    createdAt: row.created_at,
  };
}

function readAccount(ctx: WorkspaceContext, accountId: unknown): MailAccountRow | undefined {
  if (typeof accountId !== 'string' || accountId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM mail_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, accountId) as MailAccountRow | undefined;
}

function readThread(ctx: WorkspaceContext, threadId: unknown): MailThreadRow | undefined {
  if (typeof threadId !== 'string' || threadId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM mail_thread WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, threadId) as MailThreadRow | undefined;
}

function adapterOf(row: MailAccountRow): MailStoreAdapter {
  // The stored value passed `isMailAdapter` at connect time; a row edited behind the engine's back
  // still resolves or fails loudly rather than silently reading nothing.
  const adapter = ADAPTERS[row.adapter as keyof typeof ADAPTERS];
  if (adapter === undefined) throw new Error(`mail_account ${row.id} names unknown adapter '${row.adapter}'`);
  return adapter;
}

/* ------------------------------------------------------------------------------------------------
 * connect (US-E04.1)
 * ---------------------------------------------------------------------------------------------- */

export interface ConnectMailInput {
  adapter: string;
  storePath: string;
  address: string;
  idempotencyKey?: string;
}

/**
 * Point TILL at a mail store another application already writes. TAKES NO CREDENTIAL PARAMETER,
 * BY DESIGN (spec §4): there is no password to request because there is no provider to sign in
 * to. An unreadable path is `needs_mailstore`; a readable path that matches no adapter's shape is
 * `unknown_mail_adapter` (P9, never a 500).
 */
export function connectMailStore(ctx: WorkspaceContext, input: ConnectMailInput): Result {
  if (!isMailAdapter(input.adapter)) {
    return err('invalid_input', { field: 'adapter', allowed: [...MAIL_ADAPTERS] });
  }
  if (typeof input.storePath !== 'string' || input.storePath.length === 0) {
    return err('invalid_input', { field: 'storePath' });
  }
  if (typeof input.address !== 'string' || !input.address.includes('@')) {
    return err('invalid_input', { field: 'address' });
  }
  let readable = false;
  try {
    readable = existsSync(input.storePath) && statSync(input.storePath).isDirectory();
  } catch {
    readable = false;
  }
  if (!readable) return err('needs_mailstore', { storePath: input.storePath });
  if (!ADAPTERS[input.adapter].looksLike(input.storePath)) {
    return err('unknown_mail_adapter', { storePath: input.storePath, adapter: input.adapter });
  }

  const run = (): Result => {
    // Natural idempotency beyond the key (US-E04.1 Boundary): the same store under the same
    // address is ONE account however often it is connected. A DIFFERENT store or address is a
    // second account; mail_account is many-per-workspace.
    const existing = ctx.store.db
      .prepare('SELECT * FROM mail_account WHERE workspace_id = ? AND adapter = ? AND store_path = ? AND address = ?')
      .get(ctx.workspaceId, input.adapter, input.storePath, input.address) as MailAccountRow | undefined;
    if (existing !== undefined) {
      return ok({ accountId: existing.id, account: mapAccount(existing), created: false });
    }
    const id = ctx.ids.next('mailacc');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO mail_account (id, workspace_id, adapter, address, store_path, enabled, last_indexed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      )
      .run(id, ctx.workspaceId, input.adapter, input.address, input.storePath, now, now);
    const row = readAccount(ctx, id) as MailAccountRow;
    return ok({ accountId: id, account: mapAccount(row), created: true });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'mail_connect', run);
  }
  return ctx.store.tx(run);
}

/** The connected accounts (P5). The GUI's Konto panel and every agent loop start here. */
export function listMailAccounts(ctx: WorkspaceContext): Result {
  const rows = ctx.store.db
    .prepare('SELECT * FROM mail_account WHERE workspace_id = ? ORDER BY created_at')
    .all(ctx.workspaceId) as MailAccountRow[];
  return ok({ accounts: rows.map(mapAccount), supportedAdapters: [...MAIL_ADAPTERS] });
}

/* ------------------------------------------------------------------------------------------------
 * reindex (US-E04.2)
 * ---------------------------------------------------------------------------------------------- */

/** Resolve a counterpart address to a live C00 contact, or null: an unknown sender is not an error. */
function resolveContact(ctx: WorkspaceContext, address: string | undefined): string | null {
  if (address === undefined) return null;
  const row = ctx.store.db
    .prepare(
      `SELECT id FROM contact
        WHERE workspace_id = ? AND merged_into_id IS NULL AND lower(email) = ?
        ORDER BY created_at LIMIT 1`,
    )
    .get(ctx.workspaceId, address.toLowerCase()) as { id: string } | undefined;
  return row?.id ?? null;
}

export interface ReindexInput {
  accountId: string;
  idempotencyKey?: string;
}

/**
 * Walk the store and derive the index: upsert `mail_message` (keyed `message_id` per account) and
 * `mail_thread`, storing a LOCATOR and a HASH only, never a body (OP6 "index, never copy").
 * A message the adapter cannot parse is skipped and counted, never fatal (one malformed `.emlx`
 * must not cost the user their morning); a message deleted in the mail client disappears from the
 * index because the store is the authority (self-healing, asserted by test).
 */
export function reindexMailStore(ctx: WorkspaceContext, input: ReindexInput): Result {
  const account = readAccount(ctx, input.accountId);
  if (account === undefined) return err('not_found', { accountId: input.accountId });
  if (!existsSync(account.store_path)) return err('needs_mailstore', { storePath: account.store_path });
  const adapter = adapterOf(account);

  const run = (): Result => {
    const walked: WalkedMessage[] = adapter.walk(account.store_path);
    const now = ctx.clock.now();
    let indexed = 0;
    let skipped = 0;
    const skippedReasons: Record<string, number> = {};
    const skip = (reason: string) => {
      skipped += 1;
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
    };
    const seenMessageIds = new Set<string>();

    for (const message of walked) {
      if (message.raw.length === 0) {
        skip('unreadable');
        continue;
      }
      const headers = parseHeaders(message.raw);
      if (headers === undefined) {
        skip('unparseable');
        continue;
      }
      // A missing Message-ID is repaired rather than fatal: the content hash is a stable identity
      // for exactly as long as the message itself is unchanged, which is all the index promises.
      const messageId = headers.messageId ?? `sha256:${bodySha256(message.raw)}`;
      if (seenMessageIds.has(messageId)) {
        skip('duplicate_message_id');
        continue;
      }
      seenMessageIds.add(messageId);

      const threadKey = headers.referenceRoot ?? headers.inReplyTo ?? messageId;
      const direction = directionOf(headers.fromAddress, account.address);
      const counterpart = direction === 'inbound' ? headers.fromAddress : headers.toAddress;
      const contactId = resolveContact(ctx, counterpart);

      let thread = ctx.store.db
        .prepare('SELECT * FROM mail_thread WHERE account_id = ? AND thread_key = ?')
        .get(account.id, threadKey) as MailThreadRow | undefined;
      if (thread === undefined) {
        const threadId = ctx.ids.next('mailthr');
        ctx.store.db
          .prepare(
            `INSERT INTO mail_thread (id, workspace_id, account_id, thread_key, subject, contact_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(threadId, ctx.workspaceId, account.id, threadKey, headers.subject ?? null, contactId, now, now);
        thread = ctx.store.db
          .prepare('SELECT * FROM mail_thread WHERE account_id = ? AND thread_key = ?')
          .get(account.id, threadKey) as MailThreadRow;
      } else if (thread.contact_id === null && contactId !== null) {
        ctx.store.db
          .prepare('UPDATE mail_thread SET contact_id = ?, updated_at = ? WHERE id = ?')
          .run(contactId, now, thread.id);
      }

      const sha = bodySha256(message.raw);
      const existing = ctx.store.db
        .prepare('SELECT id FROM mail_message WHERE account_id = ? AND message_id = ?')
        .get(account.id, messageId) as { id: string } | undefined;
      if (existing === undefined) {
        ctx.store.db
          .prepare(
            `INSERT INTO mail_message (
               id, workspace_id, account_id, thread_id, message_id, subject, from_address,
               to_address, direction, sent_at, store_ref, body_sha256, contact_id, indexed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ctx.ids.next('mailmsg'),
            ctx.workspaceId,
            account.id,
            thread.id,
            messageId,
            headers.subject ?? null,
            headers.fromAddress ?? null,
            headers.toAddress ?? null,
            direction,
            headers.sentAt ?? null,
            message.storeRef,
            sha,
            contactId,
            now,
          );
      } else {
        // The locator and the hash refresh on every walk: a message moved by the client (mbox
        // compaction, folder move) keeps ONE row that simply points at the new location.
        ctx.store.db
          .prepare(
            `UPDATE mail_message SET thread_id = ?, subject = ?, direction = ?, sent_at = ?,
                    store_ref = ?, body_sha256 = ?, contact_id = ?, indexed_at = ?
              WHERE id = ?`,
          )
          .run(thread.id, headers.subject ?? null, direction, headers.sentAt ?? null, message.storeRef, sha, contactId, now, existing.id);
      }
      indexed += 1;
    }

    // Self-healing: a message no longer in the store leaves the index (the user's own deletion
    // behaviour, honoured for free), then threads with no messages go, then drafts and custom
    // field values hung on those threads: derived state never outlives its source.
    const ids = [...seenMessageIds];
    const placeholders = ids.map(() => '?').join(', ');
    const removed = ctx.store.db
      .prepare(
        ids.length === 0
          ? 'DELETE FROM mail_message WHERE account_id = ?'
          : `DELETE FROM mail_message WHERE account_id = ? AND message_id NOT IN (${placeholders})`,
      )
      .run(account.id, ...ids).changes;
    const emptyThreads = ctx.store.db
      .prepare(
        `SELECT id FROM mail_thread WHERE account_id = ?
           AND NOT EXISTS (SELECT 1 FROM mail_message m WHERE m.thread_id = mail_thread.id)`,
      )
      .all(account.id) as { id: string }[];
    for (const dead of emptyThreads) {
      ctx.store.db.prepare('DELETE FROM mail_draft WHERE thread_id = ?').run(dead.id);
      ctx.store.db
        .prepare(`DELETE FROM custom_field_value WHERE entity_kind = 'mail_thread' AND entity_id = ?`)
        .run(dead.id);
      ctx.store.db.prepare('DELETE FROM mail_thread WHERE id = ?').run(dead.id);
    }
    // E05 (spec US-E05.3): a voice exemplar is DERIVED from this index exactly as the index is
    // derived from the store, so an exemplar whose source message just left the index leaves with
    // it, in the same self-healing sweep. SQL only, deliberately no import of the voice module:
    // `voice_retrieve` is a pure read (conformance rule 4), so THIS write path is where the
    // corpus's dead rows are erased, and deletion in the mail client stays authoritative (OP6).
    ctx.store.db
      .prepare(
        `DELETE FROM voice_exemplar
          WHERE workspace_id = ? AND source_kind = 'sent_mail'
            AND source_ref NOT IN (SELECT id FROM mail_message WHERE workspace_id = ?)`,
      )
      .run(ctx.workspaceId, ctx.workspaceId);

    ctx.store.db
      .prepare('UPDATE mail_account SET last_indexed_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, account.id);
    return ok({ accountId: account.id, indexed, skipped, removed, skippedReasons });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'mail_reindex', run);
  }
  return ctx.store.tx(run);
}

/* ------------------------------------------------------------------------------------------------
 * thread reads (US-E04.3)
 * ---------------------------------------------------------------------------------------------- */

interface ThreadFacts {
  lastMessageAt: string | null;
  lastDirection: string | null;
  messageCount: number;
  latestDraftAt: string | null;
}

/** The derivation behind every bucket, stated once. */
function bucketOfThread(facts: ThreadFacts): Exclude<MailBucket, 'recent' | 'all'> {
  if (facts.lastDirection === 'inbound') {
    const answered =
      facts.latestDraftAt !== null &&
      (facts.lastMessageAt === null || facts.latestDraftAt >= facts.lastMessageAt);
    return answered ? 'drafted' : 'needs_reply';
  }
  return 'done';
}

export interface ThreadsListFilter {
  accountId?: string;
  bucket?: string;
  contactId?: string;
  savedViewId?: string;
}

/**
 * The thread queue (P5): a COMPUTED read model, never a cached table. `needs_reply` is derived at
 * query time from newest-message direction versus newest draft (spec §2), so it cannot go stale.
 * The G00 seam is one unconditional `applySavedView` call, the `listTasks` shape.
 */
export function listMailThreads(ctx: WorkspaceContext, filter: ThreadsListFilter = {}): Result {
  const viewed = applySavedView(ctx, 'mail_thread', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;

  if (filter.bucket !== undefined && !isMailBucket(filter.bucket)) {
    return err('invalid_input', { field: 'bucket', allowed: [...MAIL_BUCKETS] });
  }
  if (filter.accountId !== undefined && readAccount(ctx, filter.accountId) === undefined) {
    return err('not_found', { accountId: filter.accountId });
  }

  const clauses = ['t.workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.accountId !== undefined) {
    clauses.push('t.account_id = ?');
    params.push(filter.accountId);
  }
  if (filter.contactId !== undefined) {
    clauses.push('t.contact_id = ?');
    params.push(filter.contactId);
  }

  const rows = ctx.store.db
    .prepare(
      `SELECT t.*,
              (SELECT MAX(m.sent_at) FROM mail_message m WHERE m.thread_id = t.id) AS last_message_at,
              (SELECT m.direction FROM mail_message m WHERE m.thread_id = t.id
                ORDER BY m.sent_at DESC, m.indexed_at DESC LIMIT 1) AS last_direction,
              (SELECT COUNT(*) FROM mail_message m WHERE m.thread_id = t.id) AS message_count,
              (SELECT MAX(d.created_at) FROM mail_draft d WHERE d.thread_id = t.id) AS latest_draft_at
         FROM mail_thread t
        WHERE ${clauses.join(' AND ')}
        ORDER BY last_message_at DESC`,
    )
    .all(...params) as (MailThreadRow & {
    last_message_at: string | null;
    last_direction: string | null;
    message_count: number;
    latest_draft_at: string | null;
  })[];

  const items = rows.map((row) => {
    const facts: ThreadFacts = {
      lastMessageAt: row.last_message_at,
      lastDirection: row.last_direction,
      messageCount: row.message_count,
      latestDraftAt: row.latest_draft_at,
    };
    return {
      id: row.id,
      accountId: row.account_id,
      subject: row.subject,
      contactId: row.contact_id,
      lastMessageAt: facts.lastMessageAt,
      lastDirection: facts.lastDirection,
      messageCount: facts.messageCount,
      draftReady: facts.latestDraftAt !== null,
      bucket: bucketOfThread(facts),
    };
  });

  const bucket = filter.bucket;
  const filtered =
    bucket === undefined || bucket === 'all'
      ? items
      : bucket === 'recent'
        ? items.slice(0, 50)
        : items.filter((item) => item.bucket === bucket);
  return ok({ items: filtered, total: filtered.length });
}

/**
 * One thread with its messages, BODIES READ ON DEMAND from `store_ref`, never from SQLite (OP6).
 * A locator that no longer resolves yields `error:'message_moved'` for THAT message while the
 * thread still renders the rest; a body whose re-read hash disagrees with `body_sha256` comes
 * back flagged `stale:true`, because a draft built on it would be built on sand (US-E04.3).
 */
export function getMailThread(ctx: WorkspaceContext, input: { threadId: string }): Result {
  const thread = readThread(ctx, input.threadId);
  if (thread === undefined) return err('not_found', { threadId: input.threadId });
  const account = readAccount(ctx, thread.account_id);
  if (account === undefined) return err('not_found', { accountId: thread.account_id });
  const adapter = adapterOf(account);

  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM mail_message WHERE workspace_id = ? AND thread_id = ?
        ORDER BY sent_at, indexed_at`,
    )
    .all(ctx.workspaceId, thread.id) as MailMessageRow[];

  const messages = rows.map((row) => {
    const base = {
      id: row.id,
      messageId: row.message_id,
      subject: row.subject,
      fromAddress: row.from_address,
      toAddress: row.to_address,
      direction: row.direction,
      sentAt: row.sent_at,
      contactId: row.contact_id,
      storeRef: row.store_ref,
    };
    const raw = adapter.readBody(account.store_path, row.store_ref);
    if (raw === undefined) return { ...base, body: null, error: 'message_moved' as const };
    const stale = bodySha256(raw) !== row.body_sha256;
    return stale ? { ...base, body: raw, stale: true as const } : { ...base, body: raw };
  });

  const drafts = ctx.store.db
    .prepare('SELECT * FROM mail_draft WHERE workspace_id = ? AND thread_id = ? ORDER BY created_at')
    .all(ctx.workspaceId, thread.id) as MailDraftRow[];

  return ok({
    thread: {
      id: thread.id,
      accountId: thread.account_id,
      subject: thread.subject,
      contactId: thread.contact_id,
    },
    messages,
    drafts: drafts.map(mapDraft),
  });
}

/* ------------------------------------------------------------------------------------------------
 * draft write-back (US-E04.4)
 * ---------------------------------------------------------------------------------------------- */

export interface DraftWriteInput {
  threadId: string;
  body: string;
  inReplyTo?: string;
  draftRunId?: string;
  idempotencyKey?: string;
}

/**
 * Render an RFC-5322 message into the mail client's own Drafts folder and persist the locator plus
 * the hash, NOT the body (OP6). The practitioner opens their mail app, reads it, edits it, presses
 * send: TILL HAS NO SEND VERB AND NO SMTP, so P8 holds by construction rather than by policy.
 * Re-submitting the same `idempotencyKey` returns the original row and writes NO second message
 * into Drafts: a duplicate draft in a therapist's Drafts folder is a real harm (§H-IDEMPOTENT).
 */
export function writeMailDraft(ctx: WorkspaceContext, input: DraftWriteInput): Result {
  const thread = readThread(ctx, input.threadId);
  if (thread === undefined) return err('not_found', { threadId: input.threadId });
  if (typeof input.body !== 'string' || input.body.trim().length === 0) {
    return err('invalid_input', { field: 'body' });
  }
  const account = readAccount(ctx, thread.account_id);
  if (account === undefined) return err('not_found', { accountId: thread.account_id });
  const adapter = adapterOf(account);

  const run = (): Result => {
    // The reply target: the counterpart of the newest inbound message, else the thread's last
    // known address. A thread with no resolvable recipient still drafts (the human fills To: in
    // their client); an index is not entitled to block a reply over derived metadata.
    const newestInbound = ctx.store.db
      .prepare(
        `SELECT * FROM mail_message WHERE thread_id = ? AND direction = 'inbound'
          ORDER BY sent_at DESC, indexed_at DESC LIMIT 1`,
      )
      .get(thread.id) as MailMessageRow | undefined;
    const to = newestInbound?.from_address ?? null;
    const inReplyTo = input.inReplyTo ?? newestInbound?.message_id ?? null;
    const subject = thread.subject ?? '';
    const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`.trim();
    const now = ctx.clock.now();
    const draftId = ctx.ids.next('maildft');

    const headers = [
      `From: ${account.address}`,
      ...(to === null ? [] : [`To: ${to}`]),
      `Subject: ${replySubject}`,
      `Date: ${new Date(now).toUTCString()}`,
      `Message-ID: <${draftId}@till.local>`,
      ...(inReplyTo === null ? [] : [`In-Reply-To: <${inReplyTo}>`, `References: <${thread.thread_key}>`]),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'X-Unsent: 1',
    ];
    const raw = `${headers.join('\r\n')}\r\n\r\n${input.body}`;

    let storeRef: string;
    try {
      storeRef = adapter.writeDraft(account.store_path, raw);
    } catch {
      // P9: an unwritable Drafts folder is a structured refusal, and the caller (E06's draft_runs
      // when it lands) records the failure so the work is not silently lost.
      return err('drafts_not_writable', { storePath: account.store_path });
    }

    ctx.store.db
      .prepare(
        `INSERT INTO mail_draft (id, workspace_id, account_id, thread_id, draft_run_id, in_reply_to, store_ref, body_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draftId,
        ctx.workspaceId,
        account.id,
        thread.id,
        input.draftRunId ?? null,
        inReplyTo,
        storeRef,
        bodySha256(raw),
        now,
      );
    const row = ctx.store.db
      .prepare('SELECT * FROM mail_draft WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, draftId) as MailDraftRow;
    return ok({ draftId, draft: mapDraft(row) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'mail_draft_write', run);
  }
  return ctx.store.tx(run);
}

export interface DraftReplaceInput {
  draftId: string;
  body: string;
  draftRunId?: string;
  idempotencyKey?: string;
}

/**
 * Replace an existing TILL-written draft in the mail client's Drafts folder (US-E06.4: regenerate
 * is ONE message, never a growing pile). Same composition as `writeMailDraft`, same OP6 posture
 * (locator + hash persisted, never a body), and the mail_draft ROW is updated in place so the
 * thread keeps one draft identity across regenerations. A draft whose locator no longer resolves
 * is `draft_gone`: once the human sent or deleted it in their own client, it is theirs, and TILL
 * does not re-create it (the caller offers a fresh write instead).
 */
export function replaceMailDraft(ctx: WorkspaceContext, input: DraftReplaceInput): Result {
  if (typeof input.draftId !== 'string' || input.draftId.length === 0) {
    return err('invalid_input', { field: 'draftId' });
  }
  if (typeof input.body !== 'string' || input.body.trim().length === 0) {
    return err('invalid_input', { field: 'body' });
  }
  const draft = ctx.store.db
    .prepare('SELECT * FROM mail_draft WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.draftId) as MailDraftRow | undefined;
  if (draft === undefined) return err('not_found', { draftId: input.draftId });
  const thread = readThread(ctx, draft.thread_id);
  if (thread === undefined) return err('not_found', { threadId: draft.thread_id });
  const account = readAccount(ctx, draft.account_id);
  if (account === undefined) return err('not_found', { accountId: draft.account_id });
  const adapter = adapterOf(account);

  const run = (): Result => {
    // The store is the authority: a draft the user already sent or deleted is gone, not re-minted.
    if (adapter.readBody(account.store_path, draft.store_ref) === undefined) {
      return err('draft_gone', { draftId: draft.id });
    }
    const newestInbound = ctx.store.db
      .prepare(
        `SELECT * FROM mail_message WHERE thread_id = ? AND direction = 'inbound'
          ORDER BY sent_at DESC, indexed_at DESC LIMIT 1`,
      )
      .get(thread.id) as MailMessageRow | undefined;
    const to = newestInbound?.from_address ?? null;
    const inReplyTo = draft.in_reply_to ?? newestInbound?.message_id ?? null;
    const subject = thread.subject ?? '';
    const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`.trim();
    const now = ctx.clock.now();

    const headers = [
      `From: ${account.address}`,
      ...(to === null ? [] : [`To: ${to}`]),
      `Subject: ${replySubject}`,
      `Date: ${new Date(now).toUTCString()}`,
      `Message-ID: <${draft.id}.${input.draftRunId ?? 'r'}@till.local>`,
      ...(inReplyTo === null ? [] : [`In-Reply-To: <${inReplyTo}>`, `References: <${thread.thread_key}>`]),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'X-Unsent: 1',
    ];
    const raw = `${headers.join('\r\n')}\r\n\r\n${input.body}`;

    let storeRef: string;
    try {
      storeRef = adapter.replaceDraft(account.store_path, draft.store_ref, raw);
    } catch {
      return err('drafts_not_writable', { storePath: account.store_path });
    }

    ctx.store.db
      .prepare(
        `UPDATE mail_draft SET store_ref = ?, body_sha256 = ?, draft_run_id = COALESCE(?, draft_run_id)
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(storeRef, bodySha256(raw), input.draftRunId ?? null, ctx.workspaceId, draft.id);
    const row = ctx.store.db
      .prepare('SELECT * FROM mail_draft WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, draft.id) as MailDraftRow;
    return ok({ draftId: draft.id, draft: mapDraft(row) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'mail_draft_replace', run);
  }
  return ctx.store.tx(run);
}

/** The drafts TILL has written back, per thread or across the workspace (P5). */
export function listMailDrafts(ctx: WorkspaceContext, input: { threadId?: string } = {}): Result {
  if (input.threadId !== undefined && readThread(ctx, input.threadId) === undefined) {
    return err('not_found', { threadId: input.threadId });
  }
  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (input.threadId !== undefined) {
    clauses.push('thread_id = ?');
    params.push(input.threadId);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM mail_draft WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`)
    .all(...params) as MailDraftRow[];
  return ok({ drafts: rows.map(mapDraft), total: rows.length });
}

/* ------------------------------------------------------------------------------------------------
 * erasure (US-E04.5): internal, called INSIDE C00's anonymise transaction, never its own MCP tool
 * ---------------------------------------------------------------------------------------------- */

/**
 * Purge every index row referencing the given contact identity: the threads resolved to the
 * person, every message in them (and any stray message row carrying the contact id), the drafts
 * written against them, and the `custom_field_value` rows hung on those threads (§6b). The mail
 * STORE ITSELF IS UNTOUCHED: TILL erases what TILL derived; the practitioner's mail client is not
 * ours to delete from (spec §2 US-E04.5 Boundary). A mail index keyed to a person IS personal
 * data (revDSG Art. 6); leaving it behind would make C00's erasure a lie.
 *
 * DELIBERATELY NOT AN MCP TOOL: erasure is C00 `contacts_anonymise`'s single entry point, and
 * this runs inside that verb's transaction so a purge failure fails the whole anonymise rather
 * than half-erasing (a partial erasure is worse than a refused one because it reports success).
 */
export function purgeMailForContact(ctx: WorkspaceContext, contactIds: readonly string[]): {
  threads: number;
  messages: number;
  drafts: number;
  fieldValues: number;
} {
  if (contactIds.length === 0) return { threads: 0, messages: 0, drafts: 0, fieldValues: 0 };
  const placeholders = contactIds.map(() => '?').join(', ');
  const threadIds = (
    ctx.store.db
      .prepare(
        `SELECT DISTINCT t.id FROM mail_thread t
          WHERE t.workspace_id = ? AND (
            t.contact_id IN (${placeholders})
            OR EXISTS (SELECT 1 FROM mail_message m WHERE m.thread_id = t.id AND m.contact_id IN (${placeholders}))
          )`,
      )
      .all(ctx.workspaceId, ...contactIds, ...contactIds) as { id: string }[]
  ).map((r) => r.id);

  let threads = 0;
  let messages = 0;
  let drafts = 0;
  let fieldValues = 0;
  for (const threadId of threadIds) {
    fieldValues += ctx.store.db
      .prepare(`DELETE FROM custom_field_value WHERE workspace_id = ? AND entity_kind = 'mail_thread' AND entity_id = ?`)
      .run(ctx.workspaceId, threadId).changes;
    drafts += ctx.store.db
      .prepare('DELETE FROM mail_draft WHERE workspace_id = ? AND thread_id = ?')
      .run(ctx.workspaceId, threadId).changes;
    messages += ctx.store.db
      .prepare('DELETE FROM mail_message WHERE workspace_id = ? AND thread_id = ?')
      .run(ctx.workspaceId, threadId).changes;
    threads += ctx.store.db
      .prepare('DELETE FROM mail_thread WHERE workspace_id = ? AND id = ?')
      .run(ctx.workspaceId, threadId).changes;
  }
  // A stray message row whose thread resolved to nobody but whose own contact matched: erased too,
  // so no row referencing the person survives anywhere in this cluster.
  messages += ctx.store.db
    .prepare(`DELETE FROM mail_message WHERE workspace_id = ? AND contact_id IN (${placeholders})`)
    .run(ctx.workspaceId, ...contactIds).changes;
  return { threads, messages, drafts, fieldValues };
}
