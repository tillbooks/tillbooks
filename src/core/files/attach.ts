/**
 * N02 (D183), THE ATTACH SEAM: a booking and its Beleg in ONE act.
 *
 * Four acts take `attach: [{fileId} | {sourcePath}]` (`ATTACH_TARGET_KIND`): `post_entry` links to the
 * journal entry it posts, `book_bank_line` to the bank line it books (the D142 convention: the floor
 * follows the booking), `create_vendor_bill` and `record_expense` to the vendor bill they create. The link
 * rides INSIDE the act's transaction: an attachment that cannot be linked rolls the booking back, and a
 * booking that is refused stores no file. Every path that stores bytes goes through E00's own upload
 * (blob deduplicated, size-capped), and every link through `linkFile`, so the OR 958f derivation is the
 * one `files_link` makes.
 *
 * WHICH ROW A KNOWN RECEIPT USES. A file has ONE primary link and re-linking replaces it, so a known
 * receipt is resolved, oldest twin first: one already on THIS record is left as it is; an unlinked one (a
 * Beleg ohne Buchung) is linked itself; one that evidences ANOTHER record is never moved off it, the act
 * links a second filing row over the same bytes (`addFilingRowFor`).
 *
 * WHETHER A SECOND BOOKING IS ALLOWED is not decided here: every link goes through `linkFile`, whose
 * receipt guard (`receiptGuard.ts`, R1) judges it, with this act's `bookAgain` + `overrideReason` or the
 * approval's. A release passes its own reservation's place in the queue, so only earlier reservations
 * count against it.
 *
 * DRAFTED ACTS (`prepareDraftAttach`). When the dial drafts the act, the verb's `prevalidate` has already
 * run (a refused draft stores nothing); then each `sourcePath` is read ONCE and stored as a PENDING file
 * (`pending.ts`), and the Vorschlag's payload is rewritten to `{fileId}` before it is queued. A same-key
 * replay reuses the Vorschlag's stored entries and reads nothing, so the payload stays byte-identical.
 * Only the approval replay of that Vorschlag can link a pending file; a file dropped through a link onto a
 * pending Vorschlag is bound the same way and linked to the act's record when it is approved.
 *
 * A24 (spec §4a.3): the act's own gate as today, plus `manage_files` when the act stores new bytes (the
 * `files_upload` right) and the target's own write right (the `files_link` rule), so attaching never
 * needs less than linking would.
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Err, Result } from '../result.js';
import { getSetting } from '../settings/settings.js';
import { editCapabilityForKind } from '../customization/entities.js';
import { approvingActionIds } from '../agent/approving.js';
import { isPluginCallActor } from '../plugins/callScope.js';
import { readConfinedFile, parseRoots, type ConfinedFile, type LocalFileGrant } from './sourcePath.js';

import {
  addFilingRowFor,
  fileContentRefusal,
  fileView,
  headFilesBySha,
  isPendingFile,
  linkFile,
  storedFileRow,
  uploadFileBytes,
  type StoredFileRow,
} from './files.js';
import { releasePendingFile } from './files.js';
import { bindPending, pendingFilesOf, pendingRowOf, rebindDropped, storePendingBytes, sweepPendingFiles } from './pending.js';
import { liveCaptureOfDocument, settleCaptureByBooking } from '../purchase/captureHold.js';
import { withLineAttachIntent } from '../banking/belegAssignmentStore.js';
import {
  receiptHolders,
  ReceiptGuardAbort,
  settledByBankInput,
  type ReceiptHolder,
  type ReservationMark,
} from './receiptGuard.js';

/** The four acts that take `attach`, and the entity kind each links its Beleg to. */
export const ATTACH_TARGET_KIND = {
  post_entry: 'journal_entry',
  book_bank_line: 'bank_txn',
  create_vendor_bill: 'vendor_bill',
  record_expense: 'vendor_bill',
} as const;
export type AttachAct = keyof typeof ATTACH_TARGET_KIND;

export function isAttachAct(name: string): name is AttachAct {
  return Object.prototype.hasOwnProperty.call(ATTACH_TARGET_KIND, name);
}

/** The most attachments one act takes: a receipt, its delivery note, a scan of the back. */
export const MAX_ATTACHMENTS = 10;

export type AttachEntry = { fileId: string } | { sourcePath: string };

/** What one linked attachment reports on the act's result. */
export interface AttachedFile {
  fileId: string;
  sha256: string;
  mime: string;
  filename: string;
  /** True when the bytes were already stored (a known receipt). */
  duplicate: boolean;
  /** The row whose bytes this one shares, when a second filing row was linked. */
  duplicateOf: string | null;
  /** True when the receipt was already on this very record: nothing changed. */
  alreadyLinked: boolean;
  /**
   * Critic F1: the capture (Beleg ohne Buchung) this booking took its receipt from and closed as booked
   * (`files.capture_on_attach = close`), else null.
   */
  settledCaptureId: string | null;
  retentionUntil: string | null;
}

/** Abort the act's transaction with a structured cause (the `CaptureAbort` / `BillAbort` pattern). */
class AttachAbort {
  constructor(public readonly result: Err) {}
}

function isErr(value: unknown): value is Err {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

/** Validate the `attach` input's shape. Absent or null is no attachment at all. */
export function parseAttach(raw: unknown): AttachEntry[] | Err {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return err('invalid_input', { field: 'attach', reason: 'not_an_array' }) as Err;
  if (raw.length > MAX_ATTACHMENTS) return err('invalid_input', { field: 'attach', reason: 'too_many', max: MAX_ATTACHMENTS }) as Err;
  const out: AttachEntry[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return err('invalid_input', { field: 'attach', index, reason: 'not_an_object' }) as Err;
    }
    const e = entry as Record<string, unknown>;
    const hasFile = e.fileId !== undefined;
    const hasPath = e.sourcePath !== undefined;
    if (hasFile === hasPath) {
      return err('invalid_input', { field: 'attach', index, reason: 'exactly_one_of', fields: ['fileId', 'sourcePath'] }) as Err;
    }
    if (hasFile) {
      if (typeof e.fileId !== 'string' || e.fileId.length === 0) return err('invalid_input', { field: 'attach', index, reason: 'fileId' }) as Err;
      out.push({ fileId: e.fileId });
    } else {
      if (typeof e.sourcePath !== 'string' || e.sourcePath.length === 0) {
        return err('invalid_input', { field: 'attach', index, reason: 'sourcePath' }) as Err;
      }
      out.push({ sourcePath: e.sourcePath });
    }
  }
  return out;
}

/** The lexical roots `sourcePath` may read from, from `files.source_roots` (human-only). */
export function sourceRoots(ctx: WorkspaceContext, grant: LocalFileGrant | undefined): string[] {
  if (grant === undefined) return [];
  return parseRoots(getSetting<string>(ctx, 'files.source_roots'), grant.home);
}

/**
 * One confined read under this workspace's roots: the shared door for `files_upload`, `capture_document`
 * and `attach`. A PLUGIN call never reads by path, whatever host it runs under: a plugin runs in an OS
 * jail precisely so it cannot read this computer's files, and the engine must not read them on its
 * behalf (the chat uploads folder is the default root).
 */
export function readSourcePath(
  ctx: WorkspaceContext,
  grant: LocalFileGrant | undefined,
  sourcePath: unknown,
  field = 'sourcePath',
): { file: ConfinedFile } | Err {
  const host = isPluginCallActor(ctx.actor) ? undefined : grant;
  return readConfinedFile({ sourcePath, roots: sourceRoots(ctx, host), grant: host, field });
}

/** Bytes in hand, whatever brought them (a confined read, a drop). */
export interface BytesInHand {
  bytes: Buffer;
  mime: string;
  filename: string;
  sha256: string;
}

/** One attachment after its I/O: an existing file, or bytes read from a path. */
type Prepared = { kind: 'file'; fileId: string } | { kind: 'bytes'; file: BytesInHand; index: number };

/**
 * Is this pending file one the CURRENT approval may link? Only the approval replay of the Vorschlag it
 * waits on (`withApproving` in `../agent/approving.ts`) may.
 */
function approvedPending(ctx: WorkspaceContext, fileId: string): boolean {
  const row = pendingRowOf(ctx, fileId);
  return row !== undefined && row.action_id !== null && approvingActionIds().includes(row.action_id);
}

/**
 * The I/O half, BEFORE any write: read each path (confined), resolve each id, and check the rights.
 * A refusal here leaves the book untouched.
 */
function prepareAttachments(
  ctx: WorkspaceContext,
  grant: LocalFileGrant | undefined,
  entries: readonly AttachEntry[],
  targetKind: string,
): Prepared[] | Err {
  if (entries.some((e) => 'sourcePath' in e)) {
    const capable = ctx.capabilities.assert('manage_files');
    if (!capable.ok) return capable as Err;
  }
  if (entries.length > 0) {
    const capable = ctx.capabilities.assert(editCapabilityForKind(targetKind));
    if (!capable.ok) return capable as Err;
  }
  const out: Prepared[] = [];
  for (const [index, entry] of entries.entries()) {
    if ('sourcePath' in entry) {
      const read = readSourcePath(ctx, grant, entry.sourcePath, 'attach');
      if (isErr(read)) return { ...read, index } as Err;
      out.push({ kind: 'bytes', file: read.file, index });
    } else {
      // A pending file is not a filed row at all: only the approval of the Vorschlag it waits on may
      // name it; to anything else it reads as absent, exactly like a foreign id.
      const row = storedFileRow(ctx, entry.fileId);
      if (row === undefined && !(isPendingFile(ctx, entry.fileId) && approvedPending(ctx, entry.fileId))) {
        return err('not_found', { field: 'attach', index, fileId: entry.fileId }) as Err;
      }
      // Security review: naming an existing file copies it into another record, whose rules then govern
      // reading it (a second filing row under a journal entry is not a payroll artifact any more). So the
      // caller, the proposing agent included, must be able to READ that file itself.
      if (row !== undefined) {
        const canRead = ctx.capabilities.assert('read_file_content');
        if (!canRead.ok) return { ...(canRead as Err), field: 'attach', index } as Err;
        const refused = fileContentRefusal(ctx, row);
        if (refused !== null) return { ...(refused as Err), field: 'attach', index } as Err;
      }
      out.push({ kind: 'file', fileId: entry.fileId });
    }
  }
  return out;
}

/** A release's place: its own Vorschlag and its reservation's position (only earlier ones count). */
interface ReleaseMark {
  exceptActionId: string | null;
  reservationBefore: ReservationMark;
}

function linkOrAbort(ctx: WorkspaceContext, fileId: string, entityKind: string, entityId: string, release?: ReleaseMark): void {
  // The receipt guard runs inside `linkFile` (R1), with this call's confirmation from the frame.
  const linked = linkFile(ctx, { fileId, entityKind, entityId, ...(release !== undefined ? { receipt: release } : {}) });
  if (!linked.ok) throw new AttachAbort(linked as Err);
}

function report(
  ctx: WorkspaceContext,
  fileId: string,
  extra: Pick<AttachedFile, 'duplicate' | 'duplicateOf' | 'alreadyLinked'> & { settledCaptureId?: string | null },
): AttachedFile {
  const view = fileView(ctx, fileId);
  return {
    fileId,
    sha256: view?.sha256 ?? '',
    mime: view?.mime ?? '',
    filename: view?.filename ?? '',
    duplicate: extra.duplicate,
    duplicateOf: extra.duplicateOf,
    alreadyLinked: extra.alreadyLinked,
    settledCaptureId: extra.settledCaptureId ?? null,
    retentionUntil: view?.retentionUntil ?? null,
  };
}

/**
 * Link an EXISTING row to the target under the one-primary-link rule: on this record already, nothing;
 * unlinked and free, the row itself; HELD (by another record, or as the document of a capture still under
 * review, critic F1), a second filing row over the same bytes, so a Beleg is never moved off what holds
 * it. A capture whose receipt a booking took is then closed as booked (`files.capture_on_attach`), so it
 * leaves Belege ohne Buchung and can never be committed into a second booking of the same receipt.
 */
function linkExisting(ctx: WorkspaceContext, row: StoredFileRow, kind: string, targetId: string, duplicate: boolean): AttachedFile {
  if (row.entity_kind === kind && row.entity_id === targetId) {
    return report(ctx, row.id, { duplicate, duplicateOf: null, alreadyLinked: true });
  }
  const capture = row.entity_kind === null ? liveCaptureOfDocument(ctx, row.id) : undefined;
  if (row.entity_kind === null && capture === undefined) {
    linkOrAbort(ctx, row.id, kind, targetId);
    return report(ctx, row.id, { duplicate, duplicateOf: null, alreadyLinked: false });
  }
  const sibling = addFilingRowFor(ctx, row.id);
  if (sibling === undefined) throw new AttachAbort(err('not_found', { field: 'attach', fileId: row.id }) as Err);
  linkOrAbort(ctx, sibling, kind, targetId);
  let settled: string | null = null;
  if (capture !== undefined && getSetting<string>(ctx, 'files.capture_on_attach') === 'close') {
    if (settleCaptureByBooking(ctx, capture.id, { entityKind: kind, entityId: targetId, fileId: sibling })) settled = capture.id;
  }
  return report(ctx, sibling, { duplicate: true, duplicateOf: row.id, alreadyLinked: false, settledCaptureId: settled });
}

/**
 * The twin a known receipt resolves to, in order: one already on this record; an unlinked row no
 * capture holds; any other (held: it gets a second filing row).
 */
function pickTwin(ctx: WorkspaceContext, twins: readonly StoredFileRow[], kind: string | null, targetId: string | null): StoredFileRow | undefined {
  return (
    twins.find((t) => kind !== null && t.entity_kind === kind && t.entity_id === targetId) ??
    twins.find((t) => t.entity_kind === null && liveCaptureOfDocument(ctx, t.id) === undefined) ??
    twins[0]
  );
}

/**
 * N02: link bytes in hand to a record that already exists (the drop page onto a booking), under the same
 * known-receipt rule as `attach`. Runs inside the caller's transaction; answers the refusal instead of
 * throwing.
 */
export function attachBytes(ctx: WorkspaceContext, file: BytesInHand, kind: string, targetId: string): AttachedFile | Err {
  try {
    // A41.3 re-cut v3, the write-order rule: a twin filing row may be written before the link is refused, so the
    // whole link runs in its own (save)point and a refusal rolls the twin back with it.
    return ctx.store.tx(() => linkBytes(ctx, { kind: 'bytes', file, index: 0 }, kind, targetId));
  } catch (e) {
    if (e instanceof AttachAbort) return e.result;
    throw e;
  }
}

/** Link bytes read from a path: resolve a known receipt by its twins, else store and link a new file. */
function linkBytes(ctx: WorkspaceContext, p: Extract<Prepared, { kind: 'bytes' }>, kind: string, targetId: string): AttachedFile {
  const twin = pickTwin(ctx, headFilesBySha(ctx, p.file.sha256), kind, targetId);
  if (twin !== undefined) return linkExisting(ctx, twin, kind, targetId, true);
  const stored = uploadFileBytes(ctx, p.file.bytes, { filename: p.file.filename, title: p.file.filename, mime: p.file.mime });
  if (!stored.ok) throw new AttachAbort(stored as Err);
  const fileId = (stored as unknown as { file: { id: string } }).file.id;
  linkOrAbort(ctx, fileId, kind, targetId);
  return report(ctx, fileId, { duplicate: false, duplicateOf: null, alreadyLinked: false });
}

/** Link one explicitly named file: a pending one this approval releases is linked itself. */
function linkNamed(ctx: WorkspaceContext, fileId: string, kind: string, targetId: string): AttachedFile {
  if (isPendingFile(ctx, fileId)) {
    if (!approvedPending(ctx, fileId)) throw new AttachAbort(err('not_found', { field: 'attach', fileId }) as Err);
    // R1: the release is judged as ITS reservation: only reservations queued before it count.
    const mark = ctx.store.db
      .prepare('SELECT action_id, created_at, rowid FROM stored_file_pending WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, fileId) as { action_id: string | null; created_at: string; rowid: number } | undefined;
    if (mark === undefined || !releasePendingFile(ctx, fileId)) throw new AttachAbort(err('not_found', { field: 'attach', fileId }) as Err);
    linkOrAbort(ctx, fileId, kind, targetId, { exceptActionId: mark.action_id, reservationBefore: { createdAt: mark.created_at, rowid: mark.rowid } });
    return report(ctx, fileId, { duplicate: false, duplicateOf: null, alreadyLinked: false });
  }
  const row = storedFileRow(ctx, fileId);
  if (row === undefined) throw new AttachAbort(err('not_found', { field: 'attach', fileId }) as Err);
  return linkExisting(ctx, row, kind, targetId, false);
}

/**
 * The pending files bound to the Vorschlag whose approval is replaying THIS act (a drop onto the
 * Vorschlag), which the payload does not name: matched by verb and idempotency key, so a nested act of
 * another kind never takes them.
 */
function droppedOntoApproval(ctx: WorkspaceContext, act: AttachAct, idempotencyKey: unknown, named: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const actionId of approvingActionIds()) {
    const row = ctx.store.db
      .prepare('SELECT action_tool, idempotency_key FROM agent_action WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, actionId) as { action_tool: string; idempotency_key: string | null } | undefined;
    if (row === undefined || row.action_tool !== act) continue;
    if (typeof idempotencyKey === 'string' && row.idempotency_key !== null && row.idempotency_key !== idempotencyKey) continue;
    for (const pending of pendingFilesOf(ctx, actionId)) {
      if (!named.has(pending.id)) out.push(pending.id);
    }
  }
  return out;
}

/**
 * Run an act with its attachments in ONE transaction. `act` is the verb itself; `targetOf` names the
 * record its result created or booked. An act without `attach` (and outside any approval) runs exactly as
 * before, untouched.
 */
export function withAttach(
  ctx: WorkspaceContext,
  grant: LocalFileGrant | undefined,
  act: AttachAct,
  input: Record<string, unknown>,
  run: () => Result,
  targetOf: (result: Result) => string | null,
): Result {
  const entries = parseAttach(input.attach);
  if (isErr(entries)) return entries;
  const approving = approvingActionIds().length > 0;
  if (entries.length === 0 && !approving) return run();
  const kind = ATTACH_TARGET_KIND[act];
  const prepared = prepareAttachments(ctx, grant, entries, kind);
  if (isErr(prepared)) return prepared;
  try {
    return ctx.store.tx(() => {
      // A41.3 re-cut v2 (D184, I-D): the decision writer runs inside `run`, BEFORE the links below, so a
      // booking that attaches a line's assigned receipt is told so and consumes the assignment.
      const intent = act === 'book_bank_line' && typeof input.bankTxnId === 'string' ? (input.bankTxnId as string) : null;
      const intentIds = prepared.filter((p) => p.kind === 'file').map((p) => (p as { fileId: string }).fileId);
      const result = intent === null ? run() : withLineAttachIntent(ctx, intent, intentIds, run);
      if (!result.ok) return result;
      const named = new Set(prepared.filter((p) => p.kind === 'file').map((p) => (p as { fileId: string }).fileId));
      const dropped = approving ? droppedOntoApproval(ctx, act, input.idempotencyKey, named) : [];
      if (prepared.length === 0 && dropped.length === 0) return result;
      const targetId = targetOf(result);
      if (targetId === null) throw new AttachAbort(err('attach_target_missing', { act }) as Err);
      const attached: AttachedFile[] = [];
      for (const p of prepared) {
        attached.push(p.kind === 'bytes' ? linkBytes(ctx, p, kind, targetId) : linkNamed(ctx, p.fileId, kind, targetId));
      }
      for (const fileId of dropped) attached.push(linkNamed(ctx, fileId, kind, targetId));
      return { ...result, attached } as Result;
    });
  } catch (e) {
    if (e instanceof AttachAbort) return e.result;
    if (e instanceof ReceiptGuardAbort) return e.result;
    throw e;
  }
}

/** What the transport seam does with a drafted act's attachments (see `ActionDef.prepareDraft`). */
export interface DraftAttachPrep {
  /** Inside the draft's transaction, before the enqueue: store what the draft needs, answer its payload. */
  stage(): { payload: Record<string, unknown> } | { refusal: Err };
  /** Inside the same transaction, after the enqueue: bind the stored files to the Vorschlag. */
  settle(drafted: Result): void;
  /** R1: the receipt holders this draft would meet, for the card (stored on a fresh Vorschlag). */
  holders?(): ReceiptHolder[];
}

function attachIdsOf(attach: unknown): string[] {
  if (!Array.isArray(attach)) return [];
  return attach
    .map((e) => (typeof e === 'object' && e !== null ? (e as { fileId?: unknown }).fileId : undefined))
    .filter((id): id is string => typeof id === 'string');
}

function settleDraft(ctx: WorkspaceContext, act: AttachAct, key: unknown, fileIds: readonly string[], drafted: Result): void {
  if (!drafted.ok) return;
  const pendingIds = fileIds.filter((id) => isPendingFile(ctx, id));
  if (drafted.replayed === true) {
    // A replay answered with an existing Vorschlag: anything this call stored unbound is dropped again.
    if (pendingIds.some((id) => pendingRowOf(ctx, id)?.action_id === null)) sweepPendingFiles(ctx);
    return;
  }
  if (typeof drafted.actionId !== 'string') return;
  const actionId = drafted.actionId;
  bindPending(ctx, pendingIds, actionId);
  // Critic F8: files a person DROPPED onto the Vorschlag this one replaces follow it, whether it was
  // voided as stale under the same key or replaced as the newer proposal for the same bank line (D177).
  const predecessors = Array.isArray(drafted.supersededActionIds)
    ? drafted.supersededActionIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (typeof key === 'string' && key.length > 0) {
    const stale = ctx.store.db
      .prepare("SELECT id FROM agent_action WHERE workspace_id = ? AND action_tool = ? AND idempotency_key = ? AND status = 'stale' AND id <> ?")
      .all(ctx.workspaceId, act, key, actionId) as { id: string }[];
    predecessors.push(...stale.map((r) => r.id));
  }
  if (predecessors.length > 0) rebindDropped(ctx, predecessors, actionId);
}

/**
 * The drafted half (spec §4): read each `sourcePath` once, store it PENDING, rewrite the payload to
 * `{fileId}`. Undefined when the call carries no attachment (the draft queues exactly as before). Called
 * by the transport seam AFTER the verb's `prevalidate`, with the agent seat's own context.
 */
export function prepareDraftAttach(
  ctx: WorkspaceContext,
  grant: LocalFileGrant | undefined,
  act: AttachAct,
  input: Record<string, unknown>,
): DraftAttachPrep | Err | undefined {
  const entries = parseAttach(input.attach);
  if (isErr(entries)) return entries;
  const key = input.idempotencyKey;
  // No attachment: the payload queues unchanged, and only the drop rebind (critic F8) runs after it.
  if (entries.length === 0) {
    return { stage: () => ({ payload: input }), settle: (drafted) => settleDraft(ctx, act, key, [], drafted) };
  }

  // A same-key replay reuses the Vorschlag's stored entries: nothing is read and the payload is the one
  // already queued (the enqueue then answers the existing Vorschlag).
  if (typeof key === 'string' && key.length > 0) {
    const existing = ctx.store.db
      .prepare(
        `SELECT payload_json FROM agent_action
          WHERE workspace_id = ? AND action_tool = ? AND idempotency_key = ? AND status <> 'stale'
          ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1`,
      )
      .get(ctx.workspaceId, act, key) as { payload_json: string } | undefined;
    if (existing !== undefined) {
      let stored: unknown;
      try {
        stored = (JSON.parse(existing.payload_json) as { attach?: unknown }).attach;
      } catch {
        stored = undefined;
      }
      const attach = Array.isArray(stored) ? stored : [];
      return {
        stage: () => ({ payload: { ...input, attach } }),
        settle: (drafted) => settleDraft(ctx, act, key, attachIdsOf(attach), drafted),
      };
    }
  }

  const prepared = prepareAttachments(ctx, grant, entries, ATTACH_TARGET_KIND[act]);
  if (isErr(prepared)) return prepared;
  const stagedIds: string[] = [];
  const holders: ReceiptHolder[] = [];
  // R1 at draft time: the target a booking would link to (a bank line is named; the others do not exist
  // yet), and what a bank booking's input already says it settles (E1 before its decision exists).
  const target = { kind: ATTACH_TARGET_KIND[act], id: act === 'book_bank_line' && typeof input.bankTxnId === 'string' ? input.bankTxnId : null };
  const alsoSettled = act === 'book_bank_line' ? settledByBankInput(ctx, input.target) : undefined;
  const collect = (sha256: string, exceptFileIds: readonly string[]): void => {
    holders.push(...receiptHolders(ctx, sha256, { target, exceptFileIds, ...(alsoSettled !== undefined ? { alsoSettled } : {}) }));
  };
  return {
    holders: () => holders,
    stage: () => {
      // Opportunistic: a rejected or replaced Vorschlag's files go before new ones are stored.
      sweepPendingFiles(ctx);
      const attach: { fileId: string }[] = [];
      for (const p of prepared) {
        if (p.kind === 'file') {
          const row = storedFileRow(ctx, p.fileId);
          if (row !== undefined) collect(row.sha256, []);
          attach.push({ fileId: p.fileId });
          continue;
        }
        // A known receipt is named by its stored row and resolved at approval (one primary link). It
        // makes no reservation: the approval-time check judges it (R1).
        const twin = pickTwin(ctx, headFilesBySha(ctx, p.file.sha256), null, null);
        if (twin !== undefined) {
          collect(p.file.sha256, []);
          attach.push({ fileId: twin.id });
          continue;
        }
        const stored = storePendingBytes(ctx, p.file.bytes, { filename: p.file.filename, title: p.file.filename, mime: p.file.mime }, { actionId: null, source: 'draft' });
        if (isErr(stored)) return { refusal: stored };
        const fileId = (stored as { fileId: string }).fileId;
        stagedIds.push(fileId);
        // Every live reservation of another Vorschlag is earlier than this one (it was made just now).
        collect(p.file.sha256, [fileId]);
        attach.push({ fileId });
      }
      return { payload: { ...input, attach } };
    },
    settle: (drafted) => settleDraft(ctx, act, key, stagedIds, drafted),
  };
}
