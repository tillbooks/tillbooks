/**
 * E00, file management: the local-first filing spine, and the OP3 link half built over G00's registry.
 *
 * A stored file is NOT an A10 document, and keeping the two apart is the first design decision here
 * rather than a naming preference. A10's `document` is a business document with a lifecycle, a number
 * series and a posting path; this is a byte stream with a checksum, a version chain and a retention
 * date. The repo already spent the word `document` on the former in five places, so E00's object is a
 * FILE (see the spec's §0 for the whole collision list).
 *
 * THREE THINGS ARE STRUCTURAL AND NOT POLICY, and each of them is the reason a statutory claim here is
 * worth anything:
 *
 *  1. **The bytes are content-addressed inside the store.** `storage_ref` IS the sha256, and the blob
 *     is a row. So `getFileContent` re-hashing before it answers is a real check of the real stored
 *     bytes, and erasing a blob happens in the same transaction as its metadata.
 *  2. **A version is a ROW, never an edit.** `newFileVersion` inserts and points backwards; nothing in
 *     this file ever rewrites a prior version's `sha256`, `bytes`, `storage_ref` or `version`. That is
 *     the OR 958f trail, and it is why superseding is not a correction mechanism: the old version stays
 *     readable and stays retained.
 *  3. **Retention outranks deletion while it runs, and deletion outranks retention after.** Those are
 *     the two halves of the same rule (OR 958f Abs. 1 versus the revDSG erasure duty), and they are
 *     both a comparison against one date rather than a status anyone can set.
 *
 * `entityKind` IS VALIDATED AGAINST G00's REGISTRY AND NOT AGAINST A LIST HERE. The spec claimed E00
 * would build the OP3 entity registry; `src/core/customization/entities.ts` shipped it first, carrying
 * `table` and `idColumn` per row, which is precisely what the existence check needs. Declaring a second
 * enumeration would be the §H-ENUM violation the spec spent a paragraph warning about, and it would
 * drift the day a capability added a row to only one of them.
 */

import { createHash } from 'node:crypto';

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { entityKindDef, ENTITY_KIND_IDS, tenantColumnOf } from '../customization/entities.js';
import { IS_HEAD } from './head.js';
import {
  RETENTION_SOURCES,
  accountingRecordDate,
  effectiveRetentionUntil,
  isAccountingEntityKind,
  isPostedAccountingRecord,
  later,
  retentionFloor,
  statutoryRetentionUntil,
} from './retention.js';

/**
 * The largest file this store accepts, in bytes.
 *
 * A real constant rather than the spec's "configured local cap", because nothing configures it and a
 * cap nobody can change is more honest as a named number than as a promised setting. 25 MiB is chosen
 * against what this store is for: a scanned A4 voucher is well under 1 MB, a signed contract PDF under
 * 5, and the ceiling exists so a mis-addressed upload cannot put a video into the ledger file that
 * every other capability shares. The refusal names the limit, so raising it is a one-line change with a
 * visible blast radius rather than a silent success at any size.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** The longest a title or filename may be. Same reasoning as the folder name: an index key. */
const MAX_TEXT = 240;
/** Tags are freeform, but not unbounded: a tag list is a JSON column and a filter target. */
const MAX_TAGS = 50;
const MAX_TAG = 40;

const DEFAULT_MIME = 'application/octet-stream';

export interface StoredFileRow {
  id: string;
  workspace_id: string;
  folder_id: string | null;
  title: string;
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  storage_ref: string;
  tags: string;
  entity_kind: string | null;
  entity_id: string | null;
  retention_until: string | null;
  retention_source: string | null;
  retention_statutory_until: string | null;
  version: number;
  supersedes_id: string | null;
  pending_delete: number;
  created_at: string;
  updated_at: string;
}

/**
 * The ONE projection every file read goes through, so `files_search`, `files_list_linked` and the
 * version history cannot describe the same row differently.
 *
 * `retentionLocked` is DERIVED at read time against the caller's clock rather than stored, for the
 * same reason A10 derives its FX columns off the posted entry: a stored boolean would be a second
 * source of truth for a fact the date already carries, and it would be wrong every day after it was
 * written.
 *
 * IT IS DERIVED FROM BOTH RETENTION COLUMNS AND FROM NO QUERY, which is what keeps it honest AND keeps
 * a list read linear. The schema's invariant is `retention_until >= retention_statutory_until`, so the
 * `later` below is normally the stored retention and the second term is a guard against a row no verb
 * in this module can write. What it deliberately does NOT do is re-derive the floor from the linked
 * record, which would be one extra query PER ROW on the primary screen. The consequence is stated
 * rather than hidden: after `set_fiscal_config` moves `fiscal_year_start`, the guards recompute a floor
 * this projection has not seen, so the list can show a file as released that `files_delete` then
 * refuses. That direction is safe (it never shows a lock the engine would not honour), and the refusal
 * carries the recomputed floor, which is the number the operator needs.
 */
function mapFile(row: StoredFileRow, today: string) {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    sha256: row.sha256,
    storageRef: row.storage_ref,
    tags: parseTags(row.tags),
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    retentionUntil: row.retention_until,
    retentionSource: row.retention_source,
    retentionStatutoryUntil: row.retention_statutory_until,
    retentionLocked: (later(row.retention_until, row.retention_statutory_until) ?? '') >= today,
    version: row.version,
    supersedesId: row.supersedes_id,
    pendingDelete: row.pending_delete === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Read the tags column back.
 *
 * Defensive against a malformed value rather than trusting the column, and the fallback is the empty
 * list rather than a throw: the tags are a filing convenience, and a row whose tags cannot be parsed
 * must still be readable, because it might be the voucher an auditor asked for. `updateFile` is the
 * only writer and it always writes a JSON array, so this branch is unreachable through the verbs; it
 * exists because a hand-edited database is a thing that happens to local-first software.
 */
function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function today(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/** §H-TENANT on every read: a file is only ever resolved inside the caller's workspace. */
function readFile(ctx: WorkspaceContext, id: unknown): StoredFileRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM stored_file WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as StoredFileRow | undefined;
}

function isHead(ctx: WorkspaceContext, id: string): boolean {
  const successor = ctx.store.db
    .prepare('SELECT id FROM stored_file WHERE workspace_id = ? AND supersedes_id = ?')
    .get(ctx.workspaceId, id) as { id: string } | undefined;
  return successor === undefined;
}

// --- Upload ------------------------------------------------------------------------------------

/** Base64, the ordinary alphabet with optional padding. Whitespace is tolerated (wrapped payloads). */
const BASE64_RE = /^[A-Za-z0-9+/\r\n\t ]*={0,2}$/;

/** The exact base64 length of a payload at the cap, whitespace excluded. Four characters per three bytes. */
const MAX_BASE64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4;

/**
 * Would this payload still be over the cap once its whitespace is discounted?
 *
 * THE CAP IS ENFORCED BEFORE ANYTHING IS ALLOCATED, and this scan is why it can be exact. A payload
 * longer than `MAX_BASE64_CHARS` can only be legal by carrying whitespace (a wrapped payload at the
 * cap is about 2.6% longer than the bound), so a bare length test would refuse a file that is
 * genuinely 25 MiB. Counting the significant characters instead is exact in both directions, and it
 * STOPS at the ceiling: a hostile 200 MB payload is refused after reading ~35 M characters, with no
 * intermediate string and no Buffer. Measured on the shipped path before this existed, a 200 MB
 * payload took RSS from 152 MB to 490 MB before `file_too_large` came back; after it, the same call
 * allocates nothing beyond the argument.
 *
 * Reached only when the cheap length test has already tripped, so an ordinary upload never runs it.
 */
function significantLengthExceeds(value: string, ceiling: number): boolean {
  let significant = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // Space, tab, LF, CR: exactly the whitespace `BASE64_RE` tolerates.
    if (code === 32 || code === 9 || code === 10 || code === 13) continue;
    if (++significant > ceiling) return true;
  }
  return false;
}

/**
 * Decode an upload payload into bytes, or say why it cannot be one.
 *
 * `Buffer.from(x, 'base64')` never throws and silently DROPS anything outside the alphabet, so a
 * caller that sent a UTF-8 PDF by mistake would get a shorter, corrupt file stored under a checksum
 * that matches the corruption perfectly. That is the worst possible failure for a store whose whole
 * claim is integrity, so the charset is checked BEFORE the decode and a zero-byte result is refused:
 * an empty file is not a business record, it is a mis-wired upload.
 *
 * THE SIZE CAP IS CHECKED FIRST OF ALL, before the charset scan and before the decode. E00 is the
 * first verb in this product whose input is DESIGNED to be megabytes, so it is the first one where
 * "validate, then measure" costs real memory rather than microseconds. The exact check after the decode
 * stays, because the bound above is an upper bound on the decoded size and the real number is what the
 * refusal should name.
 */
function decodeContent(contentBase64: unknown): { bytes: Buffer } | Result {
  if (typeof contentBase64 !== 'string' || contentBase64.length === 0) {
    return err('file_unreadable', { field: 'contentBase64', reason: 'missing' });
  }
  if (contentBase64.length > MAX_BASE64_CHARS && significantLengthExceeds(contentBase64, MAX_BASE64_CHARS)) {
    // No `bytes`, deliberately: nothing was decoded, so there is no measured size to report and
    // reporting an estimate as a fact is how a refusal starts lying. `max` is the actionable half.
    return err('file_too_large', { max: MAX_FILE_BYTES, base64Chars: contentBase64.length, useLane: 'files_upload_begin' });
  }
  if (!BASE64_RE.test(contentBase64)) {
    return err('file_unreadable', { field: 'contentBase64', reason: 'not_base64' });
  }
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.byteLength === 0) return err('file_unreadable', { field: 'contentBase64', reason: 'empty' });
  if (bytes.byteLength > MAX_FILE_BYTES) {
    // The single-call bound is exceeded: name the chunk lane so a caller with a real large file knows
    // the supported route (G18 US-G18.4) rather than being told only that its upload is too big.
    return err('file_too_large', { bytes: bytes.byteLength, max: MAX_FILE_BYTES, useLane: 'files_upload_begin' });
  }
  return { bytes };
}

function isDecoded(value: { bytes: Buffer } | Result): value is { bytes: Buffer } {
  return 'bytes' in value && Buffer.isBuffer((value as { bytes: Buffer }).bytes);
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateText(value: unknown, field: string): Result | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return err('invalid_input', { field });
  if (value.trim().length === 0) return err('invalid_input', { field, reason: 'empty' });
  if (value.length > MAX_TEXT) return err('invalid_input', { field, reason: 'too_long', max: MAX_TEXT });
  return null;
}

/**
 * Normalise a tag list: trimmed, de-duplicated case-insensitively, bounded.
 *
 * Case-PRESERVING de-duplication, the `contacts_tag` shape: `Versicherung` and `versicherung` are one
 * tag and the first spelling wins, because a filter offering both would split the very set the tag
 * exists to gather.
 */
function normaliseTags(raw: unknown): string[] | Result {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return err('invalid_input', { field: 'tags' });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') return err('invalid_input', { field: 'tags', reason: 'not_a_string' });
    const tag = entry.trim();
    if (tag.length === 0) continue;
    if (tag.length > MAX_TAG) return err('invalid_input', { field: 'tags', reason: 'too_long', max: MAX_TAG });
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > MAX_TAGS) return err('invalid_input', { field: 'tags', reason: 'too_many', max: MAX_TAGS });
  return out;
}

function isTagList(value: string[] | Result): value is string[] {
  return Array.isArray(value);
}

function resolveFolder(ctx: WorkspaceContext, folderId: unknown): Result | null {
  if (folderId === undefined || folderId === null) return null;
  if (typeof folderId !== 'string' || folderId.length === 0) return err('invalid_input', { field: 'folderId' });
  const folder = ctx.store.db
    .prepare('SELECT id FROM file_folder WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, folderId);
  return folder === undefined ? err('folder_not_found', { folderId }) : null;
}

/**
 * Write the blob if this workspace does not already hold these exact bytes.
 *
 * `INSERT OR IGNORE` on the (workspace, sha256) key is the whole deduplication story, and it is why
 * uploading the same voucher twice costs one blob: identical bytes have identical hashes, so the second
 * insert is a no-op and both metadata rows point at the one copy. This is also what makes the
 * idempotency guarantee provable ON ROWS rather than on a returned id.
 */
function putBlob(ctx: WorkspaceContext, sha256: string, bytes: Buffer): void {
  ctx.store.db
    .prepare('INSERT OR IGNORE INTO stored_file_blob (workspace_id, sha256, bytes, content) VALUES (?, ?, ?, ?)')
    .run(ctx.workspaceId, sha256, bytes.byteLength, bytes);
}

/**
 * Drop a blob once no metadata row in this workspace still names it.
 *
 * The count is the whole guard. Two versions of a file that happen to hold identical bytes share one
 * blob, and so do two separate uploads of the same voucher, so deleting one row must not take the
 * other's content with it. Called only from inside `deleteFile`'s transaction, AFTER the metadata row
 * is gone, so the count it takes is the count that will be true once the transaction commits.
 */
function dropBlobIfUnreferenced(ctx: WorkspaceContext, sha256: string): void {
  const remaining = (
    ctx.store.db
      .prepare('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ? AND storage_ref = ?')
      .get(ctx.workspaceId, sha256) as { n: number }
  ).n;
  if (remaining === 0) {
    ctx.store.db
      .prepare('DELETE FROM stored_file_blob WHERE workspace_id = ? AND sha256 = ?')
      .run(ctx.workspaceId, sha256);
  }
}

export interface UploadFileInput {
  folderId?: string | null;
  title?: string;
  filename?: string;
  contentBase64: string;
  mime?: string;
  tags?: string[];
  idempotencyKey?: string;
}

export function uploadFile(ctx: WorkspaceContext, input: UploadFileInput): Result {
  const decoded = decodeContent(input.contentBase64);
  if (!isDecoded(decoded)) return decoded;

  for (const [value, field] of [
    [input.title, 'title'],
    [input.filename, 'filename'],
    [input.mime, 'mime'],
  ] as const) {
    const textErr = validateText(value, field);
    if (textErr !== null) return textErr;
  }

  const tags = normaliseTags(input.tags);
  if (!isTagList(tags)) return tags;

  const folderErr = resolveFolder(ctx, input.folderId);
  if (folderErr !== null) return folderErr;

  // A filing needs SOME name, and neither of the two the caller may send is required, so the fallback
  // chain is explicit rather than an empty string: title, else filename, else a stable placeholder the
  // Studio can rename. An unnamed row in a filing cabinet is the one thing a filing cabinet cannot have.
  const filename = input.filename?.trim() ?? input.title?.trim() ?? 'datei';
  const title = input.title?.trim() ?? filename;

  const run = (): Result => {
    const id = ctx.ids.next('file');
    const at = ctx.clock.now();
    const sha256 = sha256Of(decoded.bytes);
    putBlob(ctx, sha256, decoded.bytes);
    ctx.store.db
      .prepare(
        `INSERT INTO stored_file
           (id, workspace_id, folder_id, title, filename, mime, bytes, sha256, storage_ref, tags,
            entity_kind, entity_id, retention_until, retention_source, retention_statutory_until,
            version, supersedes_id, pending_delete, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 1, NULL, 0, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.folderId ?? null,
        title,
        filename,
        input.mime?.trim() ?? DEFAULT_MIME,
        decoded.bytes.byteLength,
        sha256,
        sha256,
        JSON.stringify(tags),
        at,
        at,
      );
    return ok({ file: mapFile(readFile(ctx, id) as StoredFileRow, today(ctx)) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'files_upload', run);
  }
  // The unkeyed path is a transaction too: the blob and its metadata row must land together or not at
  // all, because a blob with no row is unreachable garbage and a row with no blob is a broken record.
  return ctx.store.tx(run);
}

// --- Metadata edit -----------------------------------------------------------------------------

export interface UpdateFilePatch {
  title?: string;
  tags?: string[];
  folderId?: string | null;
  /** Clearing the P8 staged flag IS a metadata edit, and it is the Cancel half of the badge. */
  pendingDelete?: boolean;
}

/**
 * Patch a file's filing metadata. Never its bytes.
 *
 * The columns this verb cannot reach are the point: `sha256`, `storage_ref`, `bytes`, `version` and
 * `supersedes_id` have no branch here, so "the content is corrected by a new version, never by an
 * edit" is a property of the code rather than a rule in a document. A superseded version is still
 * patchable, deliberately: re-filing an old version into the right folder is housekeeping, and refusing
 * it would leave a mis-filed retained record permanently mis-filed.
 */
export function updateFile(
  ctx: WorkspaceContext,
  input: { fileId: string; patch: UpdateFilePatch; idempotencyKey?: string },
): Result {
  const existing = readFile(ctx, input.fileId);
  if (existing === undefined) return err('not_found', { fileId: input.fileId });

  const patch = input.patch ?? {};
  const titleErr = validateText(patch.title, 'title');
  if (titleErr !== null) return titleErr;

  let tags: string[] | undefined;
  if (patch.tags !== undefined) {
    const normalised = normaliseTags(patch.tags);
    if (!isTagList(normalised)) return normalised;
    tags = normalised;
  }

  if (patch.folderId !== undefined) {
    const folderErr = resolveFolder(ctx, patch.folderId);
    if (folderErr !== null) return folderErr;
  }
  if (patch.pendingDelete !== undefined && typeof patch.pendingDelete !== 'boolean') {
    return err('invalid_input', { field: 'pendingDelete' });
  }

  const run = (): Result => {
    const sets: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [ctx.clock.now()];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title.trim());
    }
    if (tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(tags));
    }
    if (patch.folderId !== undefined) {
      sets.push('folder_id = ?');
      params.push(patch.folderId);
    }
    if (patch.pendingDelete !== undefined) {
      sets.push('pending_delete = ?');
      params.push(patch.pendingDelete ? 1 : 0);
    }
    ctx.store.db
      .prepare(`UPDATE stored_file SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`)
      .run(...params, ctx.workspaceId, existing.id);
    return ok({ file: mapFile(readFile(ctx, existing.id) as StoredFileRow, today(ctx)) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'files_update', run);
  }
  return ctx.store.tx(run);
}

// --- Versioning --------------------------------------------------------------------------------

/**
 * Add a version that supersedes the head, inheriting everything about the filing.
 *
 * HEAD-ONLY, and the refusal is what keeps a chain a chain. Superseding a row that something already
 * supersedes would fork the history into a tree, and "which version is current" would stop having an
 * answer, which is the one question this whole capability exists to answer.
 *
 * WHAT IS INHERITED IS THE FILING, NOT THE BYTES: folder, title, tags, the entity link and the
 * retention date all carry forward, because they describe the record and the record has not changed,
 * only its content. `retention_until` carrying forward is the compliance-critical one: a v2 that
 * silently started unretained would let an operator supersede a locked voucher and then delete the
 * copy the ten-year rule was about.
 */
export function newFileVersion(
  ctx: WorkspaceContext,
  input: { fileId: string; contentBase64: string; mime?: string; filename?: string; idempotencyKey?: string },
): Result {
  // Scoped to (this file, this key), the `transitionDocument` pattern, and replayed BEFORE the head
  // guard. Without that order a retried call answers `not_head_version` against the version the first
  // call had itself added, which tells a caller its correct request was wrong.
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.fileId, input.idempotencyKey])
      : undefined;
  if (scopedKey !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'files_new_version');
    if (replayed !== undefined) return replayed;
  }

  const existing = readFile(ctx, input.fileId);
  if (existing === undefined) return err('not_found', { fileId: input.fileId });
  if (!isHead(ctx, existing.id)) {
    return err('not_head_version', { fileId: existing.id, version: existing.version });
  }

  const decoded = decodeContent(input.contentBase64);
  if (!isDecoded(decoded)) return decoded;
  for (const [value, field] of [
    [input.filename, 'filename'],
    [input.mime, 'mime'],
  ] as const) {
    const textErr = validateText(value, field);
    if (textErr !== null) return textErr;
  }

  const run = (): Result => {
    const id = ctx.ids.next('file');
    const at = ctx.clock.now();
    const sha256 = sha256Of(decoded.bytes);
    putBlob(ctx, sha256, decoded.bytes);
    ctx.store.db
      .prepare(
        `INSERT INTO stored_file
           (id, workspace_id, folder_id, title, filename, mime, bytes, sha256, storage_ref, tags,
            entity_kind, entity_id, retention_until, retention_source, retention_statutory_until,
            version, supersedes_id, pending_delete, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        existing.folder_id,
        existing.title,
        input.filename?.trim() ?? existing.filename,
        input.mime?.trim() ?? existing.mime,
        decoded.bytes.byteLength,
        sha256,
        sha256,
        existing.tags,
        existing.entity_kind,
        existing.entity_id,
        existing.retention_until,
        existing.retention_source,
        // The STATUTORY column carries forward too, and it is the one that would be easy to forget: a
        // v2 that inherited the retention date but not its provenance would lose the floor the moment
        // an operator extended it by hand, which is exactly the escape this column exists to close.
        existing.retention_statutory_until,
        existing.version + 1,
        existing.id,
        at,
        at,
      );
    return ok({
      file: mapFile(readFile(ctx, id) as StoredFileRow, today(ctx)),
      supersededId: existing.id,
    });
  };

  if (scopedKey !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'files_new_version', run);
  }
  return ctx.store.tx(run);
}

// --- OP3: the entity link ----------------------------------------------------------------------

/**
 * Attach a file to any record G00's registry knows about (the OP3 `linkEntity`).
 *
 * The existence check is built from the registry row rather than from a branch per kind: `table` and
 * `idColumn` are two of the four facts every row carries, so proving the target is real costs one
 * parameterised query that works for a kind added next year with no change here. It is scoped to the
 * workspace on both sides (§H-TENANT), and a FOREIGN id gets the SAME `entity_not_found` a nonexistent
 * one does, so no id can be probed across tenants.
 *
 * THE COLUMN NAMES ARE INTERPOLATED, and that is safe for exactly one reason worth stating: they come
 * from `entityKindDef`, a compile-time constant table in G00's module, never from the caller. The
 * caller's `entityKind` only ever selects a row; it never becomes SQL. `entityId` is a bound parameter.
 *
 * RE-LINKING REPLACES, because a file has one primary link (§4). The alternative, refusing, would make
 * a mis-filed voucher permanently mis-filed.
 */
export function linkFile(
  ctx: WorkspaceContext,
  input: { fileId: string; entityKind: string; entityId: string; idempotencyKey?: string },
): Result {
  const existing = readFile(ctx, input.fileId);
  if (existing === undefined) return err('not_found', { fileId: input.fileId });

  const def = entityKindDef(input.entityKind);
  if (def === undefined) {
    return err('unknown_entity_kind', { entityKind: input.entityKind, known: [...ENTITY_KIND_IDS] });
  }
  if (typeof input.entityId !== 'string' || input.entityId.length === 0) {
    return err('invalid_input', { field: 'entityId' });
  }
  // `tenantColumnOf` is `workspace_id` everywhere except the self-tenant `workspace` kind (A23),
  // whose primary key IS the tenant: a file links to the current mandate itself, never to another.
  const target = ctx.store.db
    .prepare(`SELECT ${def.idColumn} AS id FROM ${def.table} WHERE ${tenantColumnOf(def)} = ? AND ${def.idColumn} = ?`)
    .get(ctx.workspaceId, input.entityId);
  if (target === undefined) {
    return err('entity_not_found', { entityKind: def.kind, entityId: input.entityId });
  }

  const run = (): Result => {
    const at = ctx.clock.now();
    // THE OR 958f DERIVATION, ANCHORED ON THE RECORD'S OWN DATE and not on this moment. A journal
    // entry may be dated in the future (A02 has no future-date guard) and a payment carries a
    // caller-supplied date, so reading the clock derived a SHORTER answer than the statute demands.
    // The clock is the fallback only where the record has no date of its own, and that fallback is
    // conservative: today's fiscal year end is never earlier than a dated record's.
    //
    // ONLY FROM POSTED EVIDENCE (D63): a link to a still-draft record derives nothing here, because
    // a draft is not yet bookkeeping evidence and the column below is sealed against ever going
    // down. The floor for a draft target attaches when the target posts, in `deriveStatutoryOnPost`.
    const derived =
      isAccountingEntityKind(def.kind) && isPostedAccountingRecord(ctx, def.kind, input.entityId)
        ? statutoryRetentionUntil(ctx, accountingRecordDate(ctx, def.kind, input.entityId) ?? at)
        : null;
    // NEITHER COLUMN EVER GOES DOWN. The statutory column is the durable memory of the statute, so a
    // re-link to a record in an earlier year cannot shorten it; `retention_until` is raised to it, so
    // the invariant `retention_until >= retention_statutory_until` holds after every link. A manual
    // date ABOVE the floor is left exactly as the operator set it, provenance included.
    const statutoryUntil = later(existing.retention_statutory_until, derived);
    const retentionUntil = later(existing.retention_until, statutoryUntil);
    const raisedByStatute = retentionUntil !== existing.retention_until;
    const retentionSource = raisedByStatute ? RETENTION_SOURCES[1] : existing.retention_source;
    ctx.store.db
      .prepare(
        `UPDATE stored_file
            SET entity_kind = ?, entity_id = ?, retention_until = ?, retention_source = ?,
                retention_statutory_until = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        def.kind,
        input.entityId,
        retentionUntil,
        retentionSource,
        statutoryUntil,
        at,
        ctx.workspaceId,
        existing.id,
      );
    return ok({
      file: mapFile(readFile(ctx, existing.id) as StoredFileRow, today(ctx)),
      // "Did this call raise the retention date off the statute?", which is what the drawer reports and
      // what the golden fixture asserts. A link that only RECORDED a floor an existing manual date
      // already covers answers false: nothing an operator can see changed.
      retentionDerived: raisedByStatute,
    });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const scopedKey = JSON.stringify([existing.id, input.idempotencyKey]);
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'files_link', run);
  }
  return ctx.store.tx(run);
}

/** The OP3 `listLinked` read model (P5): everything attached to one record, heads only by default. */
export function listLinkedFiles(
  ctx: WorkspaceContext,
  input: { entityKind: string; entityId: string; includeVersions?: boolean },
): Result {
  const def = entityKindDef(input.entityKind);
  if (def === undefined) {
    return err('unknown_entity_kind', { entityKind: input.entityKind, known: [...ENTITY_KIND_IDS] });
  }
  if (typeof input.entityId !== 'string' || input.entityId.length === 0) {
    return err('invalid_input', { field: 'entityId' });
  }
  // The same ceiling as `files_search`, for the same reason (D34): both reads project the same rows,
  // and a record with years of attachments behind it is exactly the screen that always asks for
  // `includeVersions`. Unbounded here while bounded there was an inconsistency, not a policy.
  const where = `f.workspace_id = ? AND f.entity_kind = ? AND f.entity_id = ? AND ${IS_HEAD('f')}`;
  const params = [ctx.workspaceId, def.kind, input.entityId] as const;
  const rows = ctx.store.db
    .prepare(
      `SELECT f.* FROM stored_file f
        WHERE ${where}
        ORDER BY f.created_at DESC, f.rowid DESC LIMIT ?`,
    )
    .all(...params, FILE_LIST_CEILING + 1) as StoredFileRow[];
  const truncated = rows.length > FILE_LIST_CEILING;
  const day = today(ctx);
  const files = withVersions(ctx, truncated ? rows.slice(0, FILE_LIST_CEILING) : rows, day, input.includeVersions === true);
  const total = truncated
    ? (ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM stored_file f WHERE ${where}`).get(...params) as { n: number }).n
    : files.length;
  return ok({
    files,
    truncated,
    total,
    ceiling: FILE_LIST_CEILING,
    entityKind: def.kind,
    entityId: input.entityId,
  });
}

/**
 * Project head rows, optionally each carrying its own version history.
 *
 * The history is NESTED under its head rather than flattened into the list, and that is a correction to
 * the authored spec worth naming: a flat list containing both v1 and v2 as siblings is a list in which
 * the same record appears twice, which is exactly the ambiguity about "the current version" that the
 * linear chain exists to remove. The drawer expands a head; the list never shows a superseded row as a
 * peer. Oldest first inside the chain, because that is the order a history is read.
 */
function withVersions(
  ctx: WorkspaceContext,
  heads: readonly StoredFileRow[],
  day: string,
  includeVersions: boolean,
) {
  if (!includeVersions) return heads.map((row) => mapFile(row, day));
  // ONE query for the whole call, and it reads only the rows that are IN a chain. This used to be
  // `fileVersions` per head row, and each of those selected the entire `stored_file` table and built
  // its own Map: quadratic in the row count, on the one screen that always passes `includeVersions`.
  // Measured on this machine, median of twenty, one three-version chain present so the nesting path is
  // really exercised: 200 / 400 / 800 / 1000 heads took 53 / 196 / 795 / (~1240 extrapolated) ms
  // before, and take 0.54 / 1.04 / 2.08 / 2.46 ms after. The old curve was a clean quadratic, so at
  // the documented `FILE_LIST_CEILING` of 1000 the primary screen was about 1.2 s of synchronous
  // better-sqlite3 work blocking every other verb in the process.
  const index = versionIndex(ctx, heads);
  return heads.map((row) => ({
    ...mapFile(row, day),
    versions: chainFrom(index, row.id).map((v) => mapFile(v, day)),
  }));
}

/** The rows a chain walk can reach, indexed both directions the walk runs in. */
interface VersionIndex {
  byId: ReadonlyMap<string, StoredFileRow>;
  /** `supersedes_id` to the row that supersedes it: the forward pointer, which the table has no column for. */
  successorOf: ReadonlyMap<string, StoredFileRow>;
}

/**
 * Index the rows that participate in a multi-version chain, plus the `seed` rows already in hand.
 *
 * NOT A FULL TABLE SCAN, and the predicate is the point. A chain walk can only ever reach a row that
 * either supersedes something or is superseded by something, so the query asks for exactly those two
 * sets through the `stored_file_chain` index; every head the caller already holds arrives as a seed.
 * On the ordinary workspace, where almost nothing has been superseded, this returns ZERO rows and
 * nesting the history costs one indexed lookup for the whole page rather than a scan per row.
 *
 * There is no `ORDER BY`: the chain is assembled from the `supersedes_id` pointers in `chainFrom`, so
 * sorting here would be a temp b-tree over the result for an ordering nothing reads. The old
 * `ORDER BY version` was load-bearing only for an implementation that trusted version numbers.
 */
function versionIndex(ctx: WorkspaceContext, seed: readonly StoredFileRow[]): VersionIndex {
  // The BLOBS are not in this table (see `schema.ts`), so no row read here carries file content.
  // §H-TENANT on both halves, including the subquery.
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM stored_file
        WHERE workspace_id = ?
          AND (supersedes_id IS NOT NULL
               OR id IN (SELECT supersedes_id FROM stored_file
                          WHERE workspace_id = ? AND supersedes_id IS NOT NULL))`,
    )
    .all(ctx.workspaceId, ctx.workspaceId) as StoredFileRow[];
  const byId = new Map<string, StoredFileRow>();
  const successorOf = new Map<string, StoredFileRow>();
  for (const row of [...seed, ...rows]) {
    byId.set(row.id, row);
    if (row.supersedes_id !== null) successorOf.set(row.supersedes_id, row);
  }
  return { byId, successorOf };
}

/**
 * The chain the named row sits in, oldest first.
 *
 * Walks BACKWARDS from the named row to the root, then forwards, so the chain is assembled from the
 * pointers that actually exist rather than from an assumption that `version` numbers are contiguous.
 * Both walks are Map lookups: the forward one used to be a linear `find` per step, which made even a
 * single chain quadratic in the table.
 */
function chainFrom(index: VersionIndex, fileId: string): StoredFileRow[] {
  const chain: StoredFileRow[] = [];
  let cursor = index.byId.get(fileId);
  while (cursor !== undefined) {
    chain.unshift(cursor);
    cursor = cursor.supersedes_id === null ? undefined : index.byId.get(cursor.supersedes_id);
  }
  let next = index.successorOf.get(fileId);
  while (next !== undefined) {
    chain.push(next);
    next = index.successorOf.get(next.id);
  }
  return chain;
}

// --- Search ------------------------------------------------------------------------------------

/** `files_search` loads all matching heads up to this ceiling, flagging truncation past it (D34). */
export const FILE_LIST_CEILING = 1000;

/**
 * The search read model (P5).
 *
 * NOT AN FTS5 VIRTUAL TABLE, and the spec's §0 records why: a token-AND match over title, filename and
 * tags is derived, rebuildable and never authoritative, which is all three properties the spec asked
 * of its index, without adding shadow tables to a schema other suites snapshot table by table. It also
 * makes the authored "a malformed FTS query degrades to a substring match" boundary unrepresentable
 * rather than handled: there is no query language to malform.
 *
 * TOKEN-AND, NOT TOKEN-OR: every whitespace-separated token must match somewhere, so a second word
 * narrows the result the way a person expects and the way `q` is actually typed. The LIKE wildcards in
 * a token are escaped, because an operator searching for `100%` is searching for a string.
 */
export function searchFiles(
  ctx: WorkspaceContext,
  filter: {
    q?: string;
    folderId?: string;
    tag?: string;
    entityKind?: string;
    mime?: string;
    includeVersions?: boolean;
  } = {},
): Result {
  const clauses = ['f.workspace_id = ?'];
  const params: (string | number)[] = [ctx.workspaceId];

  // ALWAYS heads: a superseded row is never a peer in a list (see `withVersions`). `includeVersions`
  // decides whether each head carries its history, not whether the list grows.
  clauses.push(IS_HEAD('f'));

  if (typeof filter.q === 'string' && filter.q.trim().length > 0) {
    for (const token of filter.q.trim().split(/\s+/)) {
      const pattern = `%${escapeLike(token.toLowerCase())}%`;
      // LOWER on both sides rather than relying on a collation: SQLite's NOCASE folds ASCII only, so
      // "Versicherung" would match and "Vertrage" with an umlaut would not. Folding both sides in the
      // query is the same amount of work and is right for German.
      clauses.push(
        `(LOWER(f.title) LIKE ? ESCAPE '\\' OR LOWER(f.filename) LIKE ? ESCAPE '\\' OR LOWER(f.tags) LIKE ? ESCAPE '\\')`,
      );
      params.push(pattern, pattern, pattern);
    }
  }
  if (typeof filter.folderId === 'string' && filter.folderId.length > 0) {
    clauses.push('f.folder_id = ?');
    params.push(filter.folderId);
  }
  if (typeof filter.entityKind === 'string' && filter.entityKind.length > 0) {
    clauses.push('f.entity_kind = ?');
    params.push(filter.entityKind);
  }
  if (typeof filter.mime === 'string' && filter.mime.length > 0) {
    clauses.push('f.mime = ?');
    params.push(filter.mime);
  }
  if (typeof filter.tag === 'string' && filter.tag.trim().length > 0) {
    // A tag match is exact-per-element, not a substring of the JSON: the column holds
    // `["versicherung","2026"]`, so the quoted form is what distinguishes the tag `2026` from a title
    // that merely contains 2026, and `versicherung` from `krankenversicherung`.
    clauses.push(`LOWER(f.tags) LIKE ? ESCAPE '\\'`);
    params.push(`%"${escapeLike(filter.tag.trim().toLowerCase())}"%`);
  }

  const where = clauses.join(' AND ');
  const rows = ctx.store.db
    .prepare(`SELECT f.* FROM stored_file f WHERE ${where} ORDER BY f.created_at DESC, f.rowid DESC LIMIT ?`)
    .all(...params, FILE_LIST_CEILING + 1) as StoredFileRow[];
  const truncated = rows.length > FILE_LIST_CEILING;
  const day = today(ctx);
  const files = withVersions(
    ctx,
    truncated ? rows.slice(0, FILE_LIST_CEILING) : rows,
    day,
    filter.includeVersions === true,
  );
  const total = truncated
    ? (
        ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM stored_file f WHERE ${where}`).get(...params) as {
          n: number;
        }
      ).n
    : files.length;
  return ok({ files, truncated, total, ceiling: FILE_LIST_CEILING });
}

/** Escape the LIKE wildcards in a caller-supplied search token. See `folders.ts` for the same guard. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// --- The read path: OR 958f Abs. 3 / GeBüV Art. 6 ----------------------------------------------

/**
 * Return a stored file's bytes, having proved they are the bytes that were stored.
 *
 * THIS IS THE HALF OF OR 958f MOST SOFTWARE SKIPS. Abs. 3 permits electronic retention only "soweit
 * dadurch die Übereinstimmung mit den zugrunde liegenden Geschäftsvorfällen und Sachverhalten
 * gewährleistet ist und wenn sie jederzeit wieder lesbar gemacht werden können", and GeBüV Art. 6
 * (Verfügbarkeit) is the availability duty. Keeping bytes IN is only the first half of the duty; being
 * able to produce them, provably unaltered, is the other.
 *
 * So the hash is RE-COMPUTED here and compared, on every read, rather than trusted from the column.
 * A mismatch returns `integrity_mismatch` and NO BYTES: serving content the checksum disowns would be
 * the single worst thing this module could do, because the caller would then file it, print it, or
 * hand it to an auditor believing it is the record. The refusal is the honest answer and it is
 * actionable; a silent success is neither.
 *
 * A READ with no write twin. It mutates nothing, which is asserted by the conformance gate's snapshot
 * rule rather than promised here.
 */
export function getFileContent(ctx: WorkspaceContext, input: { fileId: string }): Result {
  const file = readFile(ctx, input.fileId);
  if (file === undefined) return err('not_found', { fileId: input.fileId });

  // G18 US-G18.4: a migration-class blob (over the single-call bound) is stored in segments and is
  // NOT served base64 in one shot, because that would materialise the whole file. It is read through
  // the streaming byte-range reader (`readBlobByteSource`) instead. The refusal names the lane so a
  // caller that reached here by mistake knows where to go; the Studio never surfaces it, because it
  // always uses the chunk/stream lane above the bound.
  if (file.bytes > MAX_FILE_BYTES) {
    return err('file_too_large_use_stream', { fileId: file.id, bytes: file.bytes, max: MAX_FILE_BYTES });
  }

  // A34 (§US-A34.1), the E00-side sensitivity seam. A stored `payroll_handoff` artifact carries the
  // employee master, so reading it BACK is gated exactly like the employee data it holds: `hr.manage`
  // always, plus `hr.sensitive` when the artifact INCLUDED AHV numbers (read from the export record's
  // own `ahv_included` flag, never by scanning the bytes). This is the one place E00 branches content
  // reads on a kind; the owner deliberately left `hr.sensitive` reserved for exactly this (no general
  // per-file classification model exists). Raw SQL against the A34 table, so `files.ts` takes no
  // import from the payroll module (no cycle).
  if (file.entity_kind === 'payroll_handoff') {
    const manage = ctx.capabilities.assert('hr.manage');
    if (!manage.ok) return err('forbidden', { capability: 'hr.manage', entityKind: 'payroll_handoff', fileId: file.id });
    const rec = ctx.store.db
      .prepare('SELECT ahv_included FROM payroll_handoff_exports WHERE workspace_id = ? AND artifact_document_id = ?')
      .get(ctx.workspaceId, file.id) as { ahv_included: number } | undefined;
    if (rec !== undefined && rec.ahv_included === 1) {
      const sensitive = ctx.capabilities.assert('hr.sensitive');
      if (!sensitive.ok) return err('forbidden', { capability: 'hr.sensitive', entityKind: 'payroll_handoff', fileId: file.id });
    }
  }

  const blob = ctx.store.db
    .prepare('SELECT content, bytes FROM stored_file_blob WHERE workspace_id = ? AND sha256 = ?')
    .get(ctx.workspaceId, file.storage_ref) as { content: Buffer; bytes: number } | undefined;
  if (blob === undefined) {
    return err('content_not_found', { fileId: file.id, storageRef: file.storage_ref });
  }

  const bytes = Buffer.isBuffer(blob.content) ? blob.content : Buffer.from(blob.content as unknown as Uint8Array);
  const actual = sha256Of(bytes);
  if (actual !== file.sha256) {
    // Deliberately reports BOTH hashes. The operator's next question is "which of my copies is right",
    // and the stored expectation plus what is actually on disk is what answers it.
    return err('integrity_mismatch', {
      fileId: file.id,
      expected: file.sha256,
      actual,
      bytes: bytes.byteLength,
    });
  }

  return ok({
    fileId: file.id,
    filename: file.filename,
    mime: file.mime,
    bytes: bytes.byteLength,
    sha256: file.sha256,
    version: file.version,
    contentBase64: bytes.toString('base64'),
  });
}

// --- Retention and deletion --------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Set or extend the retention date.
 *
 * EXTENDING IS ALWAYS ALLOWED; SHORTENING BELOW THE STATUTORY FLOOR IS NOT. The floor is computed in
 * `retention.ts` from the workspace's own fiscal year and the linked record's own date, so this verb
 * holds no statutory arithmetic of its own. Setting a date at or above the floor is recorded as
 * `manual`, which is what the drawer renders as provenance: an operator who deliberately keeps a record
 * for twenty years should not see it labelled "gesetzlich".
 *
 * IT WRITES `retention_until` AND NEVER `retention_statutory_until`. The provenance flip is what a
 * legitimate extension is FOR, and while that flip was the only record of the derivation, the
 * extension disarmed the rail: extend, re-link to a contact, and both this guard and `deleteFile`
 * found a null floor. The statutory column is untouched here on purpose, and the request has already
 * been proved to be at or above it, so the invariant survives the write.
 */
export function setFileRetention(
  ctx: WorkspaceContext,
  input: { fileId: string; retentionUntil: string; idempotencyKey?: string },
): Result {
  const existing = readFile(ctx, input.fileId);
  if (existing === undefined) return err('not_found', { fileId: input.fileId });
  if (typeof input.retentionUntil !== 'string' || !ISO_DATE_RE.test(input.retentionUntil)) {
    return err('invalid_input', { field: 'retentionUntil', reason: 'expected ISO YYYY-MM-DD' });
  }

  const floor = retentionFloor(ctx, existing);
  if (floor !== null && input.retentionUntil < floor) {
    return err('retention_below_statutory', {
      fileId: existing.id,
      requested: input.retentionUntil,
      statutoryFloor: floor,
      entityKind: existing.entity_kind,
    });
  }

  const run = (): Result => {
    const at = ctx.clock.now();
    ctx.store.db
      .prepare(
        'UPDATE stored_file SET retention_until = ?, retention_source = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
      )
      .run(input.retentionUntil, RETENTION_SOURCES[0], at, ctx.workspaceId, existing.id);
    // Moving a statutory deadline is exactly the kind of act the A03 chain exists to make attributable
    // years later, so it is stamped. An ordinary metadata edit is not, matching the A09/C00 precedent
    // where CRUD is silent and the consequential acts are not.
    ctx.audit.record({
      entityKind: 'stored_file',
      entityId: existing.id,
      action: 'file_retention',
      actor: ctx.actor,
      at,
    });
    return ok({ file: mapFile(readFile(ctx, existing.id) as StoredFileRow, today(ctx)) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const scopedKey = JSON.stringify([existing.id, input.idempotencyKey]);
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'files_set_retention', run);
  }
  return ctx.store.tx(run);
}

/**
 * Erase a file: the metadata row, and its blob once nothing else references it.
 *
 * THREE GUARDS, IN THIS ORDER, AND THE ORDER IS THE DESIGN.
 *
 *  1. **Retention beats erasure while it runs.** The comparison is against
 *     `effectiveRetentionUntil`, the SAME expression `setFileRetention` refuses below, and never
 *     against the stored column on its own. It refuses on a SUPERSEDED version too: OR 958f retains
 *     the trail and not merely the current copy, so "v2 exists" is not a reason v1 may go.
 *  2. **A version that something supersedes may not be deleted out from under its successor.** Left
 *     unguarded, deleting v1 would leave v2 pointing at a row that is not there, and the history an
 *     auditor reads would have a hole in the middle that nothing records.
 *  3. **P8: an agent's delete is STAGED, not done.** This is the one irreversible verb in E00, and the
 *     actor that reaches it most often is an autonomous one. Without `confirmed: true` an agent gets
 *     `{ok: true, staged: true}` and a human sees a badge; a human at the Studio deletes directly,
 *     because a confirm dialog they already clicked is not made safer by a second flag.
 *
 * `confirmed` IS PART OF THE IDEMPOTENCY KEY, and leaving it out was a defect rather than a detail.
 * The staged answer was remembered under `[fileId, key]`, so the CONFIRM arriving under the same key
 * replayed "staged" and the file survived, while the identical call under a fresh key erased it. The
 * staged payload's own `reason` invites exactly that retry, so the shape encouraged the failure it
 * produced. Folded in, a confirm is a different call with a different answer, and each of the two is
 * still replay-safe on its own.
 *
 * The erasure itself is the revDSG half of the rule: once the statutory period has run, the duty flips
 * from keeping to deleting, and the metadata row and the blob are both really deleted.
 *
 * WHAT ERASURE DOES NOT DO, stated because the claim above is easy to over-read: SQLite frees the
 * blob's pages inside the database file and does not shrink the file itself, and E00 offers no
 * `VACUUM`. The bytes are unreachable through every verb, no read can return them and no backup taken
 * afterwards contains them in a live page, but the file on disk keeps the size it grew to until
 * something reclaims it. A reclaim path (and `PRAGMA secure_delete`, which would zero the freed pages
 * rather than merely release them) belongs to whoever owns the store, and E00's spec §0 records it as
 * a named follow-up rather than leaving the stronger reading standing here.
 */
export function deleteFile(
  ctx: WorkspaceContext,
  input: { fileId: string; confirmed?: boolean; idempotencyKey?: string },
): Result {
  const confirmed = input.confirmed === true;
  const scopedKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0
      ? JSON.stringify([input.fileId, input.idempotencyKey, confirmed])
      : undefined;

  // Replay a completed delete BEFORE any state-dependent guard, the `transitionDocument` pattern:
  // retrying a committed erasure returns the original answer instead of a `not_found` on the row it
  // already removed (§H-IDEMPOTENT).
  //
  // EXCEPT a staged answer for a row that is gone. `{staged: true}` is a promise that a deletion is
  // pending on a file that is still there, and the file can have been erased since the staging: the
  // same key with `confirmed: true`, a fresh key, or a human at the Studio. Replaying the stale
  // promise would report a pending deletion of nothing, so the staged shape alone re-checks
  // existence and falls through to the honest `not_found` below. A completed erasure still replays
  // as it always did.
  if (scopedKey !== undefined) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'files_delete');
    if (replayed !== undefined) {
      const staleStaged =
        replayed.ok === true &&
        (replayed as { staged?: boolean }).staged === true &&
        readFile(ctx, input.fileId) === undefined;
      if (!staleStaged) return replayed;
    }
  }

  const existing = readFile(ctx, input.fileId);
  if (existing === undefined) return err('not_found', { fileId: input.fileId });

  const day = today(ctx);
  // AGAINST THE RECOMPUTED FLOOR, NEVER AGAINST THE STORED COLUMN ALONE. `effectiveRetentionUntil` is
  // the same expression `setFileRetention` refuses below, which is the whole of the fix for two
  // separate escapes: a manual extension followed by a re-link left the stored column as the only
  // record of a statutory date it had already overwritten, and a `fiscal_year_start` change left this
  // guard reading a column the other guard had recomputed.
  const lockedUntil = effectiveRetentionUntil(ctx, existing);
  if (lockedUntil !== null && lockedUntil >= day) {
    return err('retention_locked', {
      fileId: existing.id,
      retentionUntil: lockedUntil,
      storedRetentionUntil: existing.retention_until,
      statutoryFloor: retentionFloor(ctx, existing),
      retentionSource: existing.retention_source,
      version: existing.version,
    });
  }
  const successor = ctx.store.db
    .prepare('SELECT id FROM stored_file WHERE workspace_id = ? AND supersedes_id = ?')
    .get(ctx.workspaceId, existing.id) as { id: string } | undefined;
  if (successor !== undefined) {
    return err('not_head_version', { fileId: existing.id, supersededBy: successor.id });
  }

  // P8. `agent` is the D13 actor a `till mcp` session runs as; a human at the Studio is `studio`.
  const staging = ctx.actor === 'agent' && !confirmed;

  const run = (): Result => {
    const at = ctx.clock.now();
    if (staging) {
      ctx.store.db
        .prepare('UPDATE stored_file SET pending_delete = 1, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(at, ctx.workspaceId, existing.id);
      return ok({
        staged: true,
        fileId: existing.id,
        reason: 'irreversible_delete_requires_confirmation',
        // Says what to send, because the answer that told a caller to retry is the answer that used to
        // swallow the retry. Re-sending the SAME key with `confirmed: true` now completes the erasure.
        confirmWith: { fileId: existing.id, confirmed: true },
      });
    }
    ctx.store.db.prepare('DELETE FROM stored_file WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, existing.id);
    // AFTER the metadata row is gone, so the reference count it takes is the count that will hold once
    // this transaction commits.
    dropBlobIfUnreferenced(ctx, existing.storage_ref);
    ctx.audit.record({
      entityKind: 'stored_file',
      entityId: existing.id,
      action: 'file_delete',
      actor: ctx.actor,
      at,
    });
    return ok({ deleted: true, fileId: existing.id, sha256: existing.sha256 });
  };

  if (scopedKey !== undefined) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'files_delete', run);
  }
  return ctx.store.tx(run);
}

/**
 * The version history of ONE chain, oldest first (P5).
 *
 * Reached through `includeVersions` on the two list reads rather than as a verb of its own: the drawer
 * needs it for one file at a time, and nesting it under the head it belongs to is the same data without
 * a further verb whose only caller would be one panel. A LIST read never calls this per row; it builds
 * one `versionIndex` and walks it (see `withVersions`).
 */
export function fileVersions(ctx: WorkspaceContext, fileId: string): StoredFileRow[] {
  const row = readFile(ctx, fileId);
  if (row === undefined) return [];
  // The named row is the seed, so a file that has never been superseded is its own one-row chain
  // without the index having to return anything at all.
  return chainFrom(versionIndex(ctx, [row]), fileId);
}

/**
 * Re-point every file link that names `fromId` at `toId`, for ONE entity kind. Returns the row count.
 *
 * THE E00 HALF OF A C00 MERGE, and it lives here because the column it writes is E00's. `stored_file`
 * carries a POLYMORPHIC link (`entity_kind` plus `entity_id`), so C00's `MERGE_REPOINT_FKS` cannot
 * express it: that table is a list of `{table, column}` pairs and an unconditional
 * `UPDATE stored_file SET entity_id = ?` would re-point a file attached to an ITEM or a JOURNAL ENTRY
 * whose id happened to equal the merged-away contact's. The predicate on `entity_kind` is what makes
 * the write safe, and it belongs to the module that owns the discriminator.
 *
 * Measured before this existed: after merging contact A into B, `files_list_linked('contact', B)`
 * returned nothing and `files_list_linked('contact', A)` still returned the file, because C00 re-points
 * every live FK that names the source and E00 had added one and registered it nowhere. The C00-side call
 * is recorded as a named handoff in E00's spec §0; this function is the half E00 can land on its own.
 *
 * §H-TENANT, and idempotent by construction: a second run finds no row still naming `fromId`.
 */
export function repointFileLinks(
  ctx: WorkspaceContext,
  input: { entityKind: string; fromId: string; toId: string },
): number {
  const def = entityKindDef(input.entityKind);
  if (def === undefined) return 0;
  if (typeof input.fromId !== 'string' || input.fromId.length === 0) return 0;
  if (typeof input.toId !== 'string' || input.toId.length === 0) return 0;
  if (input.fromId === input.toId) return 0;
  const res = ctx.store.db
    .prepare(
      `UPDATE stored_file SET entity_id = ?, updated_at = ?
        WHERE workspace_id = ? AND entity_kind = ? AND entity_id = ?`,
    )
    .run(input.toId, ctx.clock.now(), ctx.workspaceId, def.kind, input.fromId);
  return res.changes;
}

// --- G18 US-G18.4: the chunk-upload lane -------------------------------------------------------

/**
 * The migration-class ceiling, in bytes. A blob may reach 500 MB through the chunk lane, well past the
 * 25 MiB single-call bound `MAX_FILE_BYTES` keeps on every ordinary surface. The two bounds are
 * deliberately different numbers: the small bound protects the shared ledger file from a mis-addressed
 * upload, and the large one is the honest ceiling for a real GL history a migration must carry.
 */
export const MAX_MIGRATION_FILE_BYTES = 500 * 1024 * 1024;

/** Each chunk is itself within the single-call bound, so a chunk decode reuses the ordinary path. */
export const MAX_CHUNK_BYTES = MAX_FILE_BYTES;

/** An abandoned upload session expires 24 h after its last activity and never mints a blob. */
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** The intents a chunk-upload session may declare. Bounded, but not an A24 gate: a hint, not a right. */
const UPLOAD_INTENTS: readonly string[] = ['migration_source'];

const HEX64_RE = /^[0-9a-f]{64}$/;

interface UploadSessionRow {
  id: string;
  workspace_id: string;
  filename: string;
  title: string;
  mime: string;
  size_bytes: number;
  intent: string;
  received_bytes: number;
  status: string;
  committed_file_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

function readUploadSession(ctx: WorkspaceContext, uploadId: string): UploadSessionRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM file_upload_session WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, uploadId) as UploadSessionRow | undefined;
}

/** A timestamp `ms` after `iso`, kept as an ISO string (the clock's own shape). */
function isoPlus(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

/**
 * Sweep every expired OPEN session for this workspace, deleting its provisional chunks so an abandoned
 * upload never leaves a phantom blob. Called at the head of every chunk-lane verb: the sweep is lazy
 * (there is no background job in a local-first engine), and it only ever removes `file_upload_chunk`
 * rows, never a committed `stored_file` or a `stored_file_blob`, because those are content-addressed
 * and a committed session is terminal.
 */
function sweepExpiredUploads(ctx: WorkspaceContext): void {
  const now = ctx.clock.now();
  const stale = ctx.store.db
    .prepare("SELECT id FROM file_upload_session WHERE workspace_id = ? AND status = 'open' AND expires_at < ?")
    .all(ctx.workspaceId, now) as Array<{ id: string }>;
  for (const s of stale) {
    ctx.store.db.prepare('DELETE FROM file_upload_chunk WHERE workspace_id = ? AND upload_id = ?').run(ctx.workspaceId, s.id);
    ctx.store.db
      .prepare("UPDATE file_upload_session SET status = 'aborted', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, ctx.workspaceId, s.id);
  }
}

export interface FileUploadBeginInput {
  name?: string;
  filename?: string;
  title?: string;
  mediaType?: string;
  mime?: string;
  sizeBytes?: number;
  intent?: string;
  idempotencyKey?: string;
}

/**
 * Open a chunk-upload session (US-G18.4). Declares the file's name, media type, declared size and
 * intent; mints nothing in the file store yet. The chunks arrive through `fileUploadChunk` and the
 * blob is minted only by `fileUploadCommit`, which verifies the accumulated sha256.
 */
export function fileUploadBegin(ctx: WorkspaceContext, input: FileUploadBeginInput): Result {
  sweepExpiredUploads(ctx);
  const name = (input.name ?? input.filename ?? input.title)?.trim();
  const nameErr = validateText(name, 'name');
  if (nameErr !== null) return nameErr;
  const mediaType = (input.mediaType ?? input.mime)?.trim();
  if (mediaType !== undefined) {
    const mimeErr = validateText(mediaType, 'mediaType');
    if (mimeErr !== null) return mimeErr;
  }
  if (typeof input.sizeBytes !== 'number' || !Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    return err('invalid_input', { field: 'sizeBytes' });
  }
  if (input.sizeBytes > MAX_MIGRATION_FILE_BYTES) {
    return err('file_too_large', { sizeBytes: input.sizeBytes, max: MAX_MIGRATION_FILE_BYTES });
  }
  const intent = (input.intent ?? 'migration_source').trim();
  if (!UPLOAD_INTENTS.includes(intent)) return err('invalid_input', { field: 'intent', allowed: UPLOAD_INTENTS });

  const run = (): Result => {
    const id = ctx.ids.next('upload');
    const at = ctx.clock.now();
    const expiresAt = isoPlus(at, UPLOAD_TTL_MS);
    ctx.store.db
      .prepare(
        `INSERT INTO file_upload_session
           (id, workspace_id, filename, title, mime, size_bytes, intent, received_bytes, status,
            committed_file_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'open', NULL, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, name as string, name as string, mediaType ?? DEFAULT_MIME, input.sizeBytes, intent, at, at, expiresAt);
    return ok({ uploadId: id, expiresAt, chunkMaxBytes: MAX_CHUNK_BYTES, sizeBytes: input.sizeBytes });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'files_upload_begin', run);
  }
  return ctx.store.tx(run);
}

export interface FileUploadChunkInput {
  uploadId?: string;
  seq?: number;
  contentBase64?: string;
  idempotencyKey?: string;
}

/**
 * Append one ordered chunk to an open session (US-G18.4). Chunks arrive in `seq` order starting at 0;
 * a repeat of a `seq` already stored is an idempotent no-op (the retried network call), and a gap is
 * refused with `chunk_out_of_order`. Each chunk is itself within the single-call bound. The running
 * total may not exceed the declared size, so a session cannot grow without limit.
 */
export function fileUploadChunk(ctx: WorkspaceContext, input: FileUploadChunkInput): Result {
  sweepExpiredUploads(ctx);
  if (typeof input.uploadId !== 'string' || input.uploadId.length === 0) return err('invalid_input', { field: 'uploadId' });
  if (typeof input.seq !== 'number' || !Number.isInteger(input.seq) || input.seq < 0) return err('invalid_input', { field: 'seq' });
  const session = readUploadSession(ctx, input.uploadId);
  if (session === undefined) return err('not_found', { uploadId: input.uploadId });
  if (session.status !== 'open') return err('upload_not_open', { uploadId: session.id, status: session.status });
  if (session.expires_at < ctx.clock.now()) return err('upload_expired', { uploadId: session.id, expiresAt: session.expires_at });

  const decoded = decodeContent(input.contentBase64);
  if (!isDecoded(decoded)) return decoded;

  const run = (): Result => {
    const existing = ctx.store.db
      .prepare('SELECT bytes FROM file_upload_chunk WHERE workspace_id = ? AND upload_id = ? AND seq = ?')
      .get(ctx.workspaceId, session.id, input.seq) as { bytes: number } | undefined;
    if (existing !== undefined) {
      // Idempotent replay of an already-received chunk: report the current total, write nothing.
      return ok({ uploadId: session.id, seq: input.seq, receivedBytes: session.received_bytes, duplicate: true });
    }
    const nextSeq = (
      ctx.store.db
        .prepare('SELECT COUNT(*) AS n FROM file_upload_chunk WHERE workspace_id = ? AND upload_id = ?')
        .get(ctx.workspaceId, session.id) as { n: number }
    ).n;
    if (input.seq !== nextSeq) return err('chunk_out_of_order', { uploadId: session.id, expected: nextSeq, got: input.seq });

    const newTotal = session.received_bytes + decoded.bytes.byteLength;
    if (newTotal > session.size_bytes) {
      return err('upload_size_exceeded', { uploadId: session.id, declared: session.size_bytes, wouldBe: newTotal });
    }
    if (newTotal > MAX_MIGRATION_FILE_BYTES) {
      return err('file_too_large', { uploadId: session.id, wouldBe: newTotal, max: MAX_MIGRATION_FILE_BYTES });
    }
    const at = ctx.clock.now();
    ctx.store.db
      .prepare('INSERT INTO file_upload_chunk (workspace_id, upload_id, seq, content, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ctx.workspaceId, session.id, input.seq, decoded.bytes, decoded.bytes.byteLength, at);
    ctx.store.db
      .prepare('UPDATE file_upload_session SET received_bytes = ?, updated_at = ?, expires_at = ? WHERE workspace_id = ? AND id = ?')
      .run(newTotal, at, isoPlus(at, UPLOAD_TTL_MS), ctx.workspaceId, session.id);
    return ok({ uploadId: session.id, seq: input.seq, receivedBytes: newTotal });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'files_upload_chunk', run);
  }
  return ctx.store.tx(run);
}

export interface FileUploadCommitInput {
  uploadId?: string;
  sha256?: string;
  idempotencyKey?: string;
}

/**
 * Close a session and mint the blob (US-G18.4). Reads the chunks in `seq` order, accumulates the
 * sha256 and the total size, and refuses `source_integrity_mismatch` when the accumulated hash does
 * not match the caller's declared `sha256` (the E00 integrity posture, applied at entry, so corrupt
 * bytes never become a stored record). A blob at or under the single-call bound is stored as one row
 * exactly like an ordinary upload; a larger one is stored in ordered segments so the streaming reader
 * can serve it a piece at a time. Idempotent: a replayed commit returns the file it already minted.
 */
export function fileUploadCommit(ctx: WorkspaceContext, input: FileUploadCommitInput): Result {
  sweepExpiredUploads(ctx);
  if (typeof input.uploadId !== 'string' || input.uploadId.length === 0) return err('invalid_input', { field: 'uploadId' });
  if (typeof input.sha256 !== 'string' || !HEX64_RE.test(input.sha256.toLowerCase())) {
    return err('invalid_input', { field: 'sha256', reason: 'not_sha256_hex' });
  }
  // A same-key replay returns the EXACT stored result, byte for byte (the §H-IDEMPOTENT contract the
  // conformance gate proves: a replay is indistinguishable from the first call). This is checked before
  // the already-committed branch below, so a retried commit under its own key never gets the annotated
  // `alreadyCommitted` shape; that branch is only for a NEW key against a session someone else finished.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, input.idempotencyKey, 'files_upload_commit');
    if (replayed !== undefined) return replayed;
  }
  const session = readUploadSession(ctx, input.uploadId);
  if (session === undefined) return err('not_found', { uploadId: input.uploadId });
  if (session.status === 'committed' && session.committed_file_id !== null) {
    const done = readFile(ctx, session.committed_file_id);
    if (done !== undefined) return ok({ file: mapFile(done, today(ctx)), uploadId: session.id, alreadyCommitted: true });
  }
  if (session.status !== 'open') return err('upload_not_open', { uploadId: session.id, status: session.status });
  if (session.expires_at < ctx.clock.now()) return err('upload_expired', { uploadId: session.id, expiresAt: session.expires_at });
  const declaredSha = input.sha256.toLowerCase();

  const run = (): Result => {
    const chunks = ctx.store.db
      .prepare('SELECT seq, content, bytes FROM file_upload_chunk WHERE workspace_id = ? AND upload_id = ? ORDER BY seq ASC')
      .all(ctx.workspaceId, session.id) as Array<{ seq: number; content: Buffer; bytes: number }>;
    if (chunks.length === 0) return err('upload_empty', { uploadId: session.id });
    // The seqs must be a contiguous 0..n-1 run: a hole means a lost chunk and the hash would be wrong.
    const hash = createHash('sha256');
    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i] as { seq: number; content: Buffer; bytes: number };
      if (c.seq !== i) return err('chunk_out_of_order', { uploadId: session.id, missing: i });
      const buf = Buffer.isBuffer(c.content) ? c.content : Buffer.from(c.content as unknown as Uint8Array);
      hash.update(buf);
      total += buf.byteLength;
    }
    if (total > MAX_MIGRATION_FILE_BYTES) return err('file_too_large', { uploadId: session.id, bytes: total, max: MAX_MIGRATION_FILE_BYTES });
    const actual = hash.digest('hex');
    if (actual !== declaredSha) {
      // NO blob is minted: the integrity check bites at entry, exactly as `getFileContent` bites at
      // exit. The session stays open so the caller can re-send the corrupt chunk and retry.
      return err('source_integrity_mismatch', { uploadId: session.id, expected: declaredSha, actual });
    }

    const id = ctx.ids.next('file');
    const at = ctx.clock.now();
    if (total <= MAX_FILE_BYTES) {
      // Small enough to store as one row: read the (few) chunks back and concatenate, so the ordinary
      // single-blob read path serves it. Bounded by the single-call bound, so no large allocation.
      const whole = Buffer.concat(
        chunks.map((c) => (Buffer.isBuffer(c.content) ? c.content : Buffer.from(c.content as unknown as Uint8Array))),
      );
      putBlob(ctx, actual, whole);
    } else {
      // Migration-class: keep the content as ordered segments (one per received chunk), so the read
      // reader yields one segment at a time and peak read memory is one chunk, not the whole file.
      for (const c of chunks) {
        const buf = Buffer.isBuffer(c.content) ? c.content : Buffer.from(c.content as unknown as Uint8Array);
        ctx.store.db
          .prepare('INSERT OR IGNORE INTO stored_file_segment (workspace_id, sha256, seq, content, bytes) VALUES (?, ?, ?, ?, ?)')
          .run(ctx.workspaceId, actual, c.seq, buf, buf.byteLength);
      }
    }
    ctx.store.db
      .prepare(
        `INSERT INTO stored_file
           (id, workspace_id, folder_id, title, filename, mime, bytes, sha256, storage_ref, tags,
            entity_kind, entity_id, retention_until, retention_source, retention_statutory_until,
            version, supersedes_id, pending_delete, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, '[]', NULL, NULL, NULL, NULL, NULL, 1, NULL, 0, ?, ?)`,
      )
      .run(id, ctx.workspaceId, session.title, session.filename, session.mime, total, actual, actual, at, at);
    // The provisional chunks are gone the moment the content is content-addressed.
    ctx.store.db.prepare('DELETE FROM file_upload_chunk WHERE workspace_id = ? AND upload_id = ?').run(ctx.workspaceId, session.id);
    ctx.store.db
      .prepare("UPDATE file_upload_session SET status = 'committed', committed_file_id = ?, received_bytes = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(id, total, at, ctx.workspaceId, session.id);
    return ok({ file: mapFile(readFile(ctx, id) as StoredFileRow, today(ctx)), uploadId: session.id });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'files_upload_commit', run);
  }
  return ctx.store.tx(run);
}

/**
 * Read a stored blob as a stream of byte chunks, WITHOUT materialising the whole file (US-G18.4).
 *
 * A migration-class blob lives in `stored_file_segment` rows, so this yields one segment at a time and
 * peak memory is one segment (at most one upload chunk), independent of the total source size. A blob
 * at or under the single-call bound lives in the ordinary single `stored_file_blob` row, so this
 * yields it in fixed `sliceBytes` pieces (subarray views, no copy). Either way the adapters' streaming
 * `parseStream` consumes an `AsyncIterable<Uint8Array>` and never sees the whole file at once. §H-TENANT:
 * every read is scoped to the workspace.
 */
export async function* readBlobByteSource(
  ctx: WorkspaceContext,
  fileId: string,
  sliceBytes = 1024 * 1024,
): AsyncGenerator<Uint8Array> {
  const file = readFile(ctx, fileId);
  if (file === undefined) return;
  const segments = ctx.store.db
    .prepare('SELECT seq, content FROM stored_file_segment WHERE workspace_id = ? AND sha256 = ? ORDER BY seq ASC')
    .all(ctx.workspaceId, file.storage_ref) as Array<{ seq: number; content: Buffer }>;
  if (segments.length > 0) {
    for (const s of segments) {
      yield Buffer.isBuffer(s.content) ? s.content : Buffer.from(s.content as unknown as Uint8Array);
    }
    return;
  }
  const blob = ctx.store.db
    .prepare('SELECT content FROM stored_file_blob WHERE workspace_id = ? AND sha256 = ?')
    .get(ctx.workspaceId, file.storage_ref) as { content: Buffer } | undefined;
  if (blob === undefined) return;
  const buf = Buffer.isBuffer(blob.content) ? blob.content : Buffer.from(blob.content as unknown as Uint8Array);
  for (let i = 0; i < buf.byteLength; i += sliceBytes) {
    yield buf.subarray(i, Math.min(i + sliceBytes, buf.byteLength));
  }
}

/** Is this stored file a migration-class blob (over the single-call bound), read only through the stream? */
export function fileIsStreamOnly(ctx: WorkspaceContext, fileId: string): boolean {
  const file = readFile(ctx, fileId);
  return file !== undefined && file.bytes > MAX_FILE_BYTES;
}

/**
 * The SYNCHRONOUS byte-range reader (G18 US-G18.4). better-sqlite3 is synchronous, so the migration
 * harness reads a migration-class blob's ordered segments one at a time inside a verb, yielding each as
 * a chunk without ever concatenating the whole file. A blob at or under the single-call bound is
 * yielded from its single `stored_file_blob` row in `sliceBytes` pieces (subarray views, no copy). Peak
 * memory is one segment (at most one upload chunk), independent of source size. §H-TENANT on the read.
 */
export function* readBlobSegmentsSync(
  ctx: WorkspaceContext,
  fileId: string,
  sliceBytes = 1024 * 1024,
): Generator<Uint8Array> {
  const file = readFile(ctx, fileId);
  if (file === undefined) return;
  const segments = ctx.store.db
    .prepare('SELECT seq, content FROM stored_file_segment WHERE workspace_id = ? AND sha256 = ? ORDER BY seq ASC')
    .all(ctx.workspaceId, file.storage_ref) as Array<{ seq: number; content: Buffer }>;
  if (segments.length > 0) {
    for (const s of segments) {
      yield Buffer.isBuffer(s.content) ? s.content : Buffer.from(s.content as unknown as Uint8Array);
    }
    return;
  }
  const blob = ctx.store.db
    .prepare('SELECT content FROM stored_file_blob WHERE workspace_id = ? AND sha256 = ?')
    .get(ctx.workspaceId, file.storage_ref) as { content: Buffer } | undefined;
  if (blob === undefined) return;
  const buf = Buffer.isBuffer(blob.content) ? blob.content : Buffer.from(blob.content as unknown as Uint8Array);
  for (let i = 0; i < buf.byteLength; i += sliceBytes) {
    yield buf.subarray(i, Math.min(i + sliceBytes, buf.byteLength));
  }
}
