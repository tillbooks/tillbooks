/**
 * E04's seven verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `taskActions` / `fileActions` precedent), so several agents appending to the append-only
 * registry at once collide over a line rather than a block.
 *
 * Three writes (connect a store, reindex it, write a draft back) and four reads. THERE IS NO
 * `mail_send` TOOL AND THERE WILL NOT BE ONE (spec §5): the only write that leaves TILL's own
 * storage is the draft, and it lands in the mail client's LOCAL Drafts folder where the human
 * reviews and sends it in the app they already use. `mailstore.purgeForContact` is deliberately
 * NOT a tool either: erasure belongs to C00 `contacts_anonymise`, and a second entry point into
 * erasure is exactly the drift §H-ENUM discipline exists to prevent.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  connectMailStore,
  listMailAccounts,
  reindexMailStore,
  listMailThreads,
  getMailThread,
  writeMailDraft,
  listMailDrafts,
} from '../core/mail/index.js';

export interface MailActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The E04 verbs, in append order. */
export function mailActions(h: MailActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;

  return [
    ctxAction(
      'mail_connect',
      'write',
      'Verbinde einen lokalen Mail-Speicher: point TILL at the store a mail client on this machine already writes (adapter apple_mail reads .emlx, thunderbird reads Maildir and mbox). Takes NO credential and never signs in anywhere: an unreadable path answers needs_mailstore, a readable path that matches no adapter answers unknown_mail_adapter. The same store under the same address stays ONE account.',
      ctxSchema({ adapter: STR, storePath: STR, address: STR, idempotencyKey: STR }, ['adapter', 'storePath', 'address']),
      (ctx, input) => connectMailStore(ctx, as(input)),
    ),
    ctxAction(
      'mail_accounts_list',
      'read',
      'Die verbundenen Mail-Konten (P5): adapter, address, store path, enabled, and when each was last indexed, plus the supported adapter list for the connect affordance.',
      ctxSchema(),
      (ctx) => listMailAccounts(ctx),
    ),
    ctxAction(
      'mail_reindex',
      'write',
      'Lies den Mail-Speicher neu ein: walk the store and derive the index (threads and messages keyed on Message-ID), storing a locator and a sha256 per message and NEVER a body (OP6 index-never-copy). Senders matching a contact e-mail resolve to that contact; unknown senders stay indexed with none. Messages deleted in the mail client leave the index (the store is the authority); unparseable ones are skipped and counted, never fatal. Answers { indexed, skipped, removed, skippedReasons }.',
      ctxSchema({ accountId: STR, idempotencyKey: STR }, ['accountId']),
      (ctx, input) => reindexMailStore(ctx, as(input)),
    ),
    ctxAction(
      'mail_threads_list',
      'read',
      'Die Korrespondenz-Warteschlange (P5, computed at query time): threads with their bucket derived from newest-message direction versus newest draft (needs_reply, drafted, done; recent and all as views), filterable by account or contact. savedViewId applies a G00 saved view; its stored filters merge underneath any filter named explicitly here.',
      ctxSchema({ accountId: STR, bucket: STR, contactId: STR, savedViewId: STR }),
      (ctx, input) => listMailThreads(ctx, as(input)),
    ),
    ctxAction(
      'mail_thread_get',
      'read',
      'Ein Thread mit seinen Nachrichten, bodies read ON DEMAND from the mail store via each store_ref, never from SQLite. A message whose locator no longer resolves answers error message_moved while the rest of the thread still renders; a body whose re-read hash disagrees with the indexed sha256 comes back flagged stale:true.',
      ctxSchema({ threadId: STR }, ['threadId']),
      (ctx, input) => getMailThread(ctx, as(input)),
    ),
    ctxAction(
      'mail_draft_write',
      'write',
      'Schreibe einen Entwurf in den Entwurfsordner des Mail-Programms: renders an RFC-5322 reply (From the account address, To the counterpart, In-Reply-To the newest inbound message) into the local Drafts folder and persists locator + hash, not the body. The human reviews and sends it in their own mail app: TILL has no send verb and no SMTP anywhere (P8 by construction). One idempotency key writes exactly ONE Drafts message however often it is called; an unwritable folder answers drafts_not_writable.',
      ctxSchema({ threadId: STR, body: STR, inReplyTo: STR, draftRunId: STR, idempotencyKey: STR }, ['threadId', 'body']),
      (ctx, input) => writeMailDraft(ctx, as(input)),
    ),
    ctxAction(
      'mail_drafts_list',
      'read',
      'Die von TILL zurückgeschriebenen Entwürfe (P5): locator, hash, draft-run provenance and reply target per draft, for one thread or across the workspace, newest first.',
      ctxSchema({ threadId: STR }),
      (ctx, input) => listMailDrafts(ctx, as(input)),
    ),
  ];
}
