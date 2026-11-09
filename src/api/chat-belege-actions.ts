/**
 * N02's two verbs (one write, one read), defined here and spread into `ACTIONS` as ONE line (the
 * `fxActions` / `settingsActions` precedent), so several agents appending to the append-only registry at
 * once collide over a line rather than a block. The helpers arrive as a parameter to keep the module
 * graph acyclic: `registry.ts` imports this file and this file must not import it back.
 *
 * `files_drop_link` mints the one-time link; its REDEMPTION is deliberately not here (spec §4a.7): the
 * drop page redeems through the Studio-key-seated drop face (`drop-face.ts`), so no MCP client can redeem
 * a link it minted. `belegeingang_status` reads the watched folder's last scan.
 *
 * `attachable` is the other half of N02's surface: it lets the four acts' drafts store a `sourcePath`
 * receipt once, pending, before the Vorschlag is queued (`ActionDef.prepareDraft`).
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { err } from '../core/result.js';
import {
  belegeingangStatus,
  fileContentRefusal,
  mintDropLink,
  prepareDraftAttach,
  previewVorschlagBeleg,
  storedFileRow,
  vorschlagBelege,
  type AttachAct,
} from '../core/files/index.js';
import { approvalPointer, APPROVAL_PATH } from './approval-pointer.js';
import { holdersForSeat, storedVorschlagHolders } from '../core/files/receiptGuard.js';
import type { ActionKind } from './actionKind.js';

export interface ChatBelegeActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/**
 * The Studio this agent's human opens the link in: this process's own when it serves one (`till up`),
 * else a live `till up` on this machine (its lock), else none. The same lookup the approval pointer makes.
 */
function studioBase(deps: ApiDeps): string | null {
  const name = (deps.store.db as unknown as { name?: unknown }).name;
  const pointer = approvalPointer({ supportDir: deps.supportDir, ownDbPath: typeof name === 'string' ? name : null });
  if (pointer.url === null || pointer.sameLedger === false) return null;
  return pointer.url.endsWith(APPROVAL_PATH) ? pointer.url.slice(0, -APPROVAL_PATH.length) : pointer.url;
}

/**
 * N02 (D183, critic round 2): `list_drafted_actions` names, on every pending Vorschlag, the Belege its
 * approval will link (`belege`: proposed, dropped or named), so a person never approves a ten-year
 * retention lock blind. Metadata only; the bytes are `files_pending_preview`. Applied at the action layer
 * so the A26 engine read stays as it is.
 */
export function withBelege(ctx: WorkspaceContext, listed: Result): Result {
  if (!listed.ok || !Array.isArray(listed.actions)) return listed;
  const withHolders = withReceiptHolders(ctx, listed.actions as Record<string, unknown>[]);
  // Security review: only a caller who may read file content learns which Belege wait, and never a filed
  // one whose own gates (the payroll sensitivity seam) refuse that caller.
  if (!ctx.capabilities.assert('read_file_content').ok) return { ...listed, actions: withHolders } as Result;
  const actions = withHolders.map((row) => {
    if (row.status !== 'pending' || typeof row.actionId !== 'string') return row;
    const payload = row.payload;
    const attach = typeof payload === 'object' && payload !== null ? (payload as { attach?: unknown }).attach : undefined;
    const belege = vorschlagBelege(ctx, row.actionId, attach).filter((b) => {
      if (b.pending) return true;
      const file = storedFileRow(ctx, b.fileId);
      return file !== undefined && fileContentRefusal(ctx, file) === null;
    });
    return belege.length > 0 ? { ...row, belege } : row;
  });
  return { ...listed, actions } as Result;
}

/**
 * R1 (N02): the receipt holders a pending Vorschlag's card shows ("Dieser Beleg ist bereits bei ...
 * gebucht"): the list its approval is judged against (`vorschlag_receipt_holders`). The record each holder
 * is, never a file id: a decider without `read_file_content` still learns that the receipt is booked.
 */
function withReceiptHolders(ctx: WorkspaceContext, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    if (row.status !== 'pending' || typeof row.actionId !== 'string') return row;
    const holders = storedVorschlagHolders(ctx, row.actionId);
    if (holders.length === 0) return row;
    // A41.3 v3 + r4 C1: one redaction (`holdersForSeat`) for the card and the refusals: an assignment hold carries
    // its assignment, line and source for a seat that reads receipts ("Lösen"), one marker for any other seat.
    return {
      ...row,
      receiptHolders: holdersForSeat(ctx, holders).map((h) => ({
        entityKind: h.entityKind,
        entityId: h.entityId,
        reservedBy: h.reservedBy,
        ...(h.assignmentId !== undefined ? { assignmentId: h.assignmentId } : {}),
        ...(h.bankTxnId !== undefined ? { bankTxnId: h.bankTxnId } : {}),
        ...(h.source !== undefined ? { source: h.source } : {}),
      })),
    };
  });
}

/**
 * N02 (D183): let a drafted act store its `sourcePath` receipts once, pending, and queue the Vorschlag
 * with `{fileId}` entries (spec §4). The transport seam calls `prepareDraft` after the verb's own
 * `prevalidate`, with the agent seat's context; the files it stores are bound to the Vorschlag in the
 * same transaction.
 */
export function attachable<D extends ActionDef>(def: D, act: AttachAct): D {
  def.prepareDraft = (deps, ctx, input) => prepareDraftAttach(ctx, deps.localFiles, act, input);
  return def;
}

export function chatBelegeActions(h: ChatBelegeActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  const TARGET = { type: 'object', properties: { kind: STR, id: STR }, required: ['kind', 'id'] } as const;
  return [
    ctxAction(
      'files_drop_link',
      'write:reversible:internal',
      "Mint a one-time link a person opens in the TILL Studio to drop ONE receipt (PDF, JPEG, PNG, HEIC or WebP) onto a booking, for a chat client that cannot hand TILL a file by path (Claude Desktop). target.kind: journal_entry, vendor_bill, bank_txn (the record the Beleg is linked to), or drafted_action (a pending Vorschlag of post_entry, book_bank_line, create_vendor_bill or record_expense: the file is held and linked when the Vorschlag is approved, discarded when it is not). Answers url (null when no Studio runs on this machine: start till up), path /drop/<token>, and expiresAt (files.drop_link_hours, 24 by default). Single use, bound to that one target; the link table keeps only the token's hash. A same-key replay answers the same link and token while it is open; once it is used or expired the token is removed from TILL entirely and a replay answers token null. Only a person in the Studio can redeem it: there is no MCP tool for the drop. Needs manage_files and the target's own write right. Refuses entity_not_found, invalid_target (a Vorschlag of another verb), invalid_state (a Vorschlag already decided), drop_link_used.",
      ctxSchema({ target: TARGET, idempotencyKey: STR }, ['target', 'idempotencyKey']),
      (ctx, input, deps) => {
        // Local-only (spec header): the drop page is served by the local Studio, and served mode mounts
        // no drop face, so a link minted there could never be redeemed.
        if (deps.identitySource === 'served_subject') {
          return err('drop_link_local_only', { reason: 'a drop link is redeemed in the local TILL Studio; a served TILL takes the receipt as contentBase64' });
        }
        const minted = mintDropLink(ctx, input);
        if (!minted.ok) return minted;
        const base = studioBase(deps);
        return { ...minted, url: base === null || typeof minted.path !== 'string' ? null : `${base}${minted.path}` };
      },
    ),
    ctxAction(
      'files_pending_preview',
      'read',
      "Read ONE Beleg a pending Vorschlag will link when it is approved (list_drafted_actions names them under belege: files the agent attached, files a person dropped through a link, existing files the payload names), as base64 after re-hashing it against its sha256 (integrity_mismatch otherwise). For the person who decides the Vorschlag: it needs manage_agent_dial, which an agent seat never holds, and read_file_content. Refuses not_found for a file that is not one of that Vorschlag's Belege, invalid_state for a Vorschlag already decided. Reads only.",
      ctxSchema({ actionId: STR, fileId: STR }, ['actionId', 'fileId']),
      (ctx, input) => previewVorschlagBeleg(ctx, input),
    ),
    ctxAction(
      'belegeingang_status',
      'read',
      'The Belegeingang: the watched folder (files.belegeingang_folder), whether it is scanned (files.belegeingang_scan) and what happens to a captured file (files.belegeingang_after), and what the last scheduler scan saw: state (ok, off, folder_missing, folder_invalid, folder_shared when two workspaces name one folder, no_actor, not_local, never_scanned), lastScanAt, captured and duplicates in that scan, errors (each file it could not take, with the refusal code), and waitingCaptures (Belege ohne Buchung still to review). Reads only.',
      ctxSchema(),
      (ctx) => belegeingangStatus(ctx),
    ),
  ];
}
