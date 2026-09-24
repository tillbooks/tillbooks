/**
 * C00's contacts / CRM verbs, defined here and spread into `ACTIONS` as one line (the `fxActions`
 * precedent).
 *
 * A09 already exposes the contact CRUD (`create_contact`, `update_contact`, `get_contact`,
 * `list_contacts`, `archive_contact`, `unarchive_contact`) and the C00 engine EXTENDS those in
 * place, so they are not re-declared here. What is genuinely NEW is C00's CRM surface: tag/segment,
 * the OP5 activity log and its timeline, dedupe/merge, CSV import, and the revDSG anonymise path.
 *
 * As with `fx-actions.ts` and `customization-actions.ts`, the helpers arrive as a parameter rather
 * than an import, so the module graph stays acyclic: `registry.ts` imports this file and this file
 * must not import it back. Every write carries `workspace_id` + an idempotency key and gates on
 * A24 (`manage_master_data` for writes, `read_master_data` for the timeline read), which is the
 * contact entity's own capability: merge and anonymise are elevated in the spec, realized as
 * `manage_master_data` in the A24 model shipped today (a finer split is a future A24 retrofit).
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  tagContact,
  logActivity,
  contactTimeline,
  mergeContacts,
  importContacts,
  anonymiseContact,
} from '../core/sales/index.js';

export interface ContactActionHelpers {
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

/** The C00 CRM verbs, in append order. */
export function contactActions(h: ContactActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  const STR_LIST = { type: 'array', items: STR } as const;
  const ROWS = { type: 'array' } as const;

  return [
    ctxAction(
      'contacts_tag',
      'write',
      'Tag a contact: merge role and segment values into its roles/segments (deduplicated, case-preserving). Unlike update_contact, which sets the arrays absolutely, this UNIONS the new values into the existing set. Tags are free-text (trimmed, at most 40 chars each, at most 50 per contact), never a fixed enum.',
      ctxSchema({ contactId: STR, roles: STR_LIST, segments: STR_LIST, idempotencyKey: STR }, ['contactId']),
      (ctx, input) => tagContact(ctx, input as never),
    ),
    ctxAction(
      'contacts_log_activity',
      'write',
      'Log a note, call, email, meeting or task on a contact (the OP5 activity seam). occurredAt may be backdated but never future-dated; the stream is append-only (a wrong note is corrected by a new note). kind is one of note|call|email|meeting|task.',
      ctxSchema(
        { contactId: STR, dealId: STR, kind: STR, body: STR, occurredAt: STR, idempotencyKey: STR },
        ['contactId', 'kind', 'body'],
      ),
      (ctx, input) => logActivity(ctx, input as never),
    ),
    ctxAction(
      'contacts_timeline',
      'read',
      "Read a contact's activity timeline, newest first (P5). Following a merge chain, a read of a merged-away contact returns the survivor's consolidated timeline.",
      ctxSchema({ contactId: STR }, ['contactId']),
      (ctx, input) => contactTimeline(ctx, input as never),
    ),
    ctxAction(
      'contacts_merge',
      'write',
      'Merge a duplicate contact into a survivor: re-points every live foreign key that names the source (documents, activities, employer links) to the target and tombstones the source. No posting and no journal effect. It does NOT freeze what an already-issued invoice re-renders as: A11 keeps no snapshot and reads the live contact row, so the survivor identity is what a re-rendered QR-bill carries. When the two roles differ the survivor is promoted to partyRole "both" and the result says so. Idempotent; a self-merge or a tombstone target is refused.',
      ctxSchema({ sourceId: STR, targetId: STR, idempotencyKey: STR }, ['sourceId', 'targetId']),
      (ctx, input) => mergeContacts(ctx, input as never),
    ),
    ctxAction(
      'contacts_import',
      'write',
      'Import already-parsed contact rows with duplicate detection. Each row is validated like create_contact; rows matching an existing contact on email, UID, or name+postcode come back in duplicates[] (never auto-merged) so the operator resolves each. Returns {created, createdIds, skipped, duplicates}.',
      ctxSchema({ rows: ROWS, idempotencyKey: STR }, ['rows', 'idempotencyKey']),
      (ctx, input) => importContacts(ctx, input as never),
    ),
    ctxAction(
      'contacts_anonymise',
      'write',
      'Anonymise a contact on a valid revDSG deletion request, bounded by OR 958f: blanks the personal fields and redacts the activity bodies while keeping the row ids so posted-document FKs stay intact. Erases the whole merge identity (the contact plus every duplicate merged into it), so pass the SURVIVOR: a merge tombstone is refused and names it. Refuses while any unsettled receivable or obligation is still live (draft, issued, sent, accepted, confirmed, partially_paid), because an unpaid claim is an overriding interest and OR 958f Abs. 3 needs the retained record to stay readable.',
      ctxSchema({ contactId: STR, idempotencyKey: STR }, ['contactId', 'idempotencyKey']),
      (ctx, input) => anonymiseContact(ctx, input as never),
    ),
  ];
}
