/**
 * D142 under B2: a Beleg dropped on a bank line's row, or picked with "Beleg anhängen" in its strip or
 * its overflow, is attached to THAT line. The same two calls E00's attachment panel makes
 * (`LinkedFiles`, imported for its file reader, never edited): `files_upload` files the bytes, then
 * `files_link` says they evidence the bank line (`entityKind: 'bank_txn'`). Two calls, not one, so "the
 * upload landed but the link did not" stays a state the person is told about rather than one that
 * cannot happen.
 *
 * Keys are per INTENT, the composer's C7 pattern (critic round 2): one intent is "this file on this
 * line", the file known by its name, size, type and last change. Its upload key and its link key are
 * minted on the first try, reused on every retry, and dropped only when both calls landed, so a retry
 * after a lost answer replays the upload (the same stored file) and the link instead of filing the
 * bytes twice. Once attached, the same file again is a new intent with new keys.
 *
 * A41.3 follow-ups: on an OPEN line that holds no assigned receipt, a person who may assign (`useAssignBeleg`'s
 * gate) gets the second call `assign_beleg_file` instead of `files_link` (`attachAssign`): the engine files the
 * upload on the line, captures it and assigns it as the person's receipt in ONE act, under
 * `belege.drop_on_open_line` (`assign` by default; `file` keeps the link only). The same per-intent keys: the
 * link key is that call's key, so a retry replays it. A receipt already booked elsewhere is asked for exactly as
 * before (N02: the refusal's `override` hint, then the same call with `bookAgain` and the reason).
 *
 * The gate is E00's own (D62 / F8): filing bytes costs `manage_files`, linking them costs the line's
 * own edit right, derived from the kind through the engine's `editCapabilityForKind`. A person missing
 * either half is never offered the drop or the picker (hidden, never shown then refused).
 */
import { useCallback, useRef, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, editCapabilityForKind, useCapabilities } from '../../lib/capabilities';
import { readFileAsUpload } from '../Files/model';
import type { BookAgainConfirmation } from '../../lib/receiptHolders';

export interface AttachReceipt {
  /** The person may attach a Beleg to a bank line (both halves of the gate). */
  canAttach: boolean;
  /** The line an attach is running for, or null. */
  busyLine: string | null;
  /**
   * Upload, then link to the line. Resolves to the refusal, or null when both calls landed. N02 R1:
   * `confirmation` is the person's reason for booking a receipt a second time (a booked line only: an
   * open line is judged when it is booked), sent with the link.
   */
  attach: (bankTxnId: string, file: File, confirmation?: BookAgainConfirmation) => Promise<Err | null>;
  /**
   * A41.3 follow-ups: upload, then `assign_beleg_file` (filed, captured and assigned in one act). Resolves to the
   * refusal, or to what the engine did: `assigned` (the line now holds the person's assignment) or not (the
   * setting files only, or the file states no amount under `assign_if_stated`).
   */
  attachAssign: (bankTxnId: string, file: File, confirmation?: BookAgainConfirmation) => Promise<{ refusal: Err | null; assigned: boolean; notAssigned: string | null }>;
}

/** One attach intent: this file on this line (a File is known by what it is, not by its object). */
function intentOf(bankTxnId: string, file: File): string {
  return JSON.stringify([bankTxnId, file.name, file.size, file.type, file.lastModified]);
}

export function useAttachReceipt(workspaceId: string | null): AttachReceipt {
  const client = useClient();
  const { can } = useCapabilities();
  const canAttach = can(CAP.manageFiles) && can(editCapabilityForKind('bank_txn'));
  const [busyLine, setBusyLine] = useState<string | null>(null);
  // Each open intent's two keys, kept across retries and dropped once the attach landed.
  const keys = useRef(new Map<string, { upload: string; link: string }>());

  const send = useCallback(
    async (bankTxnId: string, file: File, confirmation: BookAgainConfirmation | undefined, assign: boolean): Promise<{ refusal: Err | null; assigned: boolean; notAssigned: string | null }> => {
      if (workspaceId === null) return { refusal: null, assigned: false, notAssigned: null };
      setBusyLine(bankTxnId);
      const intent = intentOf(bankTxnId, file);
      const key = keys.current.get(intent) ?? { upload: crypto.randomUUID(), link: crypto.randomUUID() };
      keys.current.set(intent, key);
      try {
        const payload = await readFileAsUpload(file);
        const uploaded = await client.call('files_upload', {
          workspaceId,
          ...payload,
          title: payload.filename,
          idempotencyKey: key.upload,
        });
        if (isErr(uploaded.body)) return { refusal: uploaded.body, assigned: false, notAssigned: null };
        const stored = (uploaded.body as unknown as { file: { id: string } }).file;
        if (assign) {
          const assigned = await client.call('assign_beleg_file', { workspaceId, bankTxnId, fileId: stored.id, idempotencyKey: key.link, ...(confirmation ?? {}) });
          if (isErr(assigned.body)) return { refusal: assigned.body, assigned: false, notAssigned: null };
          keys.current.delete(intent);
          const body = assigned.body as unknown as { assignmentId?: unknown; notAssigned?: unknown };
          return { refusal: null, assigned: typeof body.assignmentId === 'string', notAssigned: typeof body.notAssigned === 'string' ? body.notAssigned : null };
        }
        const linked = await client.call('files_link', {
          workspaceId,
          fileId: stored.id,
          entityKind: 'bank_txn',
          entityId: bankTxnId,
          idempotencyKey: key.link,
          ...(confirmation ?? {}),
        });
        if (isErr(linked.body)) return { refusal: linked.body, assigned: false, notAssigned: null };
        keys.current.delete(intent);
        return { refusal: null, assigned: false, notAssigned: null };
      } finally {
        setBusyLine(null);
      }
    },
    [client, workspaceId],
  );
  const attach = useCallback(
    async (bankTxnId: string, file: File, confirmation?: BookAgainConfirmation): Promise<Err | null> => (await send(bankTxnId, file, confirmation, false)).refusal,
    [send],
  );
  const attachAssign = useCallback((bankTxnId: string, file: File, confirmation?: BookAgainConfirmation) => send(bankTxnId, file, confirmation, true), [send]);

  return { canAttach, busyLine, attach, attachAssign };
}
