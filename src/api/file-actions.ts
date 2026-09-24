/**
 * E00's twelve verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `itemActions` / `contactActions` precedent), so several agents appending to the append-only registry
 * at once collide over a line rather than a block.
 *
 * THE PREFIX IS `files_`, NOT `documents_`, AND THAT IS FORCED RATHER THAN CHOSEN. A10 already owns
 * `create_document` / `update_document` / `get_document` / `list_documents` in this same flat
 * namespace, plus the `document` table, the `/documents` route and the `document` entity kind. A
 * `documents_search` sitting beside `list_documents` is not a cosmetic clash: it is an agent choosing
 * the wrong tool for a question it asked correctly, and an invoice and a stored PDF are different
 * objects with different lifecycles. The spec's §0 records the whole collision list.
 *
 * As with `fx-actions.ts` and `contact-actions.ts`, the helpers arrive as a parameter rather than an
 * import, so the module graph stays acyclic: `registry.ts` imports this file and this file must not
 * import it back.
 *
 * Every write carries `workspaceId` + an idempotency key. The A24 gates are declared once, in
 * `src/core/access/actionCapabilities.ts`, and NOT restated here. Their SHAPE, as of D62, because it is
 * no longer one capability per direction: `read_master_data` for the three list reads and BOTH that and
 * `read_file_content` for `files_get_content` (a viewer sees the filing and may not download it);
 * `manage_files` for the filing writes; the TARGET's own write right for `files_link`, resolved through
 * G00's registry exactly as `set_field_value` is, so attaching a Beleg to a journal entry costs `post`;
 * and both `manage_files` and `manage_settings` for the two verbs that can move a statutory deadline or
 * erase a business record.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  uploadFile,
  updateFile,
  newFileVersion,
  linkFile,
  listLinkedFiles,
  searchFiles,
  getFileContent,
  setFileRetention,
  deleteFile,
  upsertFolder,
  deleteFolder,
  listFolders,
  fileUploadBegin,
  fileUploadChunk,
  fileUploadCommit,
  MAX_FILE_BYTES,
  MAX_MIGRATION_FILE_BYTES,
} from '../core/files/index.js';

export interface FileActionHelpers {
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

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The E00 verbs, in append order. */
export function fileActions(h: FileActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;
  const STR_LIST = { type: 'array', items: STR } as const;
  const PATCH = { type: 'object' } as const;
  const INT = { type: 'integer' } as const;
  const MIB = `${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MiB`;
  const MIGRATION_MB = `${Math.round(MAX_MIGRATION_FILE_BYTES / (1024 * 1024))} MB`;

  return [
    ctxAction(
      'files_upload_begin',
      'write',
      `Open a chunked upload for a file too large for the ${MIB} single-call bound (G18 US-G18.4): declare its name, mediaType, sizeBytes and intent (migration_source), and receive an uploadId plus the per-chunk byte ceiling. The bytes then arrive through files_upload_chunk and the blob is minted only by files_upload_commit once the accumulated sha256 is verified. The migration-class ceiling is ${MIGRATION_MB}; an incomplete session expires after 24 h and never leaves a stored file behind.`,
      ctxSchema(
        { name: STR, mediaType: STR, sizeBytes: INT, intent: STR, idempotencyKey: STR },
        ['name', 'sizeBytes'],
      ),
      (ctx, input) => fileUploadBegin(ctx, as(input)),
    ),
    ctxAction(
      'files_upload_chunk',
      'write',
      `Append one ordered chunk (base64, each within the ${MIB} bound) to an open upload session. Chunks arrive in seq order from 0; a repeated seq is an idempotent no-op and a gap is refused with chunk_out_of_order. The running total may not exceed the declared sizeBytes.`,
      ctxSchema({ uploadId: STR, seq: INT, contentBase64: STR, idempotencyKey: STR }, ['uploadId', 'seq', 'contentBase64']),
      (ctx, input) => fileUploadChunk(ctx, as(input)),
    ),
    ctxAction(
      'files_upload_commit',
      'write',
      'Close an upload session and mint the blob, verifying the accumulated sha256 against the caller-declared one: a mismatch refuses with source_integrity_mismatch and stores nothing. A blob over the single-call bound is kept in segments and is read only through the streaming reader (files_get_content refuses it with file_too_large_use_stream). Idempotent: a replayed commit returns the file it already minted.',
      ctxSchema({ uploadId: STR, sha256: STR, idempotencyKey: STR }, ['uploadId', 'sha256']),
      (ctx, input) => fileUploadCommit(ctx, as(input)),
    ),
    ctxAction(
      'files_upload',
      'write',
      `Store a file on this device: the bytes arrive base64-encoded in contentBase64, are hashed with sha256, and are kept content-addressed inside the ledger so nothing leaves the machine. Optionally filed into a folder and tagged. Refuses a payload that is not base64 (file_unreadable) or larger than ${MIB} (file_too_large), and never trusts a caller-supplied hash.`,
      ctxSchema(
        {
          folderId: STR,
          title: STR,
          filename: STR,
          contentBase64: STR,
          mime: STR,
          tags: STR_LIST,
          idempotencyKey: STR,
        },
        ['contentBase64'],
      ),
      (ctx, input) => uploadFile(ctx, as(input)),
    ),
    ctxAction(
      'files_update',
      'write',
      'Patch a stored file\'s filing metadata: title, tags, folder, or the pendingDelete flag an agent-staged deletion set. Never its bytes: content is corrected by a new version, never by an edit, so sha256, size and version have no path through this verb.',
      ctxSchema({ fileId: STR, patch: PATCH, idempotencyKey: STR }, ['fileId', 'patch']),
      (ctx, input) => updateFile(ctx, as(input)),
    ),
    ctxAction(
      'files_new_version',
      'write',
      'Add a version that supersedes the current one, keeping both. The chain is linear and append-only (OR 958f): the prior version stays readable and stays retained, and superseding a version something already supersedes is refused with not_head_version. Folder, title, tags, the entity link and the retention date all carry forward.',
      ctxSchema({ fileId: STR, contentBase64: STR, mime: STR, filename: STR, idempotencyKey: STR }, [
        'fileId',
        'contentBase64',
      ]),
      (ctx, input) => newFileVersion(ctx, as(input)),
    ),
    ctxAction(
      'files_link',
      'write',
      'Attach a stored file to any record TILL knows (the OP3 linkEntity): entityKind is validated against the shared entity registry and entityId must exist in this workspace. Linking to POSTED accounting evidence (a document whose issue posted an entry, a payment, a posted journal entry) derives the OR 958f ten-year lock from the END of the fiscal year that RECORD belongs to, so a future-dated entry is kept longer and a backdated one is kept from its own year. A link to a record that has not posted derives nothing until it posts (D63): a draft, and equally an issued quote or order, which carry a number but no booking. The floor attaches at the posting moment and is then permanent, and a never-posted draft that is deleted leaves no lock behind. The derived date is remembered separately, so it survives a later manual extension and a re-link. Re-linking replaces the link. Requires whatever writing the target itself requires.',
      ctxSchema({ fileId: STR, entityKind: STR, entityId: STR, idempotencyKey: STR }, [
        'fileId',
        'entityKind',
        'entityId',
      ]),
      (ctx, input) => linkFile(ctx, as(input)),
    ),
    ctxAction(
      'files_list_linked',
      'read',
      'Every file attached to one record (the OP3 listLinked), newest first. Current versions only; includeVersions nests each file\'s history underneath it rather than listing a superseded copy as a peer.',
      ctxSchema({ entityKind: STR, entityId: STR, includeVersions: BOOL }, ['entityKind', 'entityId']),
      (ctx, input) => listLinkedFiles(ctx, as(input)),
    ),
    ctxAction(
      'files_search',
      'read',
      'Find stored files by text over title, filename and tags, and by folder, tag, mime or linked entity kind. Every whitespace-separated word in q must match, so a second word narrows. Current versions only, newest first, with a truncation flag past the documented ceiling.',
      ctxSchema({
        q: STR,
        folderId: STR,
        tag: STR,
        entityKind: STR,
        mime: STR,
        includeVersions: BOOL,
      }),
      (ctx, input) => searchFiles(ctx, as(input)),
    ),
    ctxAction(
      'files_get_content',
      'read',
      'Read a stored file back as base64, having re-hashed the bytes and compared them against the stored sha256 first. A mismatch returns integrity_mismatch with both hashes and NO bytes, because serving content the checksum disowns is worse than refusing; a missing blob returns content_not_found. This is the OR 958f Abs. 3 readability half. Needs the file-content right on top of the master-data read: a read-only role may list the filing and not download it.',
      ctxSchema({ fileId: STR }, ['fileId']),
      (ctx, input) => getFileContent(ctx, as(input)),
    ),
    ctxAction(
      'files_set_retention',
      'write',
      'Set or extend how long a file must be kept (Aufbewahrung bis, ISO YYYY-MM-DD). Extending is always allowed; a date below the OR 958f floor is refused with retention_below_statutory and the floor it computed. The floor is remembered separately from the date, so extending a statutory retention by hand cannot erase it and a later re-link to a non-accounting record cannot release the file. A date set by hand is recorded as manual provenance, never as gesetzlich.',
      ctxSchema({ fileId: STR, retentionUntil: STR, idempotencyKey: STR }, ['fileId', 'retentionUntil']),
      (ctx, input) => setFileRetention(ctx, as(input)),
    ),
    ctxAction(
      'files_delete',
      'write',
      'Erase a stored file and its bytes for good, once nothing forbids it: a retention date still in the future refuses with retention_locked (on a superseded version too, and against the recomputed statutory floor rather than only the stored date), and a version something supersedes refuses with not_head_version. Irreversible, so an agent caller gets {staged:true} and a pending badge unless it passes confirmed=true. Re-send the SAME idempotencyKey with confirmed:true to complete a staged deletion: confirmed is part of the replay identity, so the confirm is not swallowed as a repeat of the staging.',
      ctxSchema({ fileId: STR, confirmed: BOOL, idempotencyKey: STR }, ['fileId']),
      (ctx, input) => deleteFile(ctx, as(input)),
    ),
    ctxAction(
      'folders_upsert',
      'write',
      'Create a filing folder, or rename and re-parent an existing one by passing its folderId. The full path is materialised and re-materialised for every descendant in the same transaction, sibling names are unique, and a folder can never become a descendant of itself (folder_cycle).',
      ctxSchema({ folderId: STR, name: STR, parentId: STR, idempotencyKey: STR }),
      (ctx, input) => upsertFolder(ctx, as(input)),
    ),
    ctxAction(
      'folders_delete',
      'write',
      'Delete a filing folder, and only when it holds nothing at all. A folder containing files or child folders is refused with folder_not_empty and both counts: deletion never cascades, because a cascade could erase a retained record nested inside it without ever consulting its retention lock.',
      ctxSchema({ folderId: STR, idempotencyKey: STR }, ['folderId']),
      (ctx, input) => deleteFolder(ctx, as(input)),
    ),
    ctxAction(
      'folders_list',
      'read',
      'The filing tree as a flat list in path order, which is already tree order: each folder carries its depth, its direct file count, its child count, and whether it is deletable, so a client renders the rail from one read and never re-derives the delete rule differently from the engine.',
      ctxSchema(),
      (ctx) => listFolders(ctx),
    ),
  ];
}
