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
 * The gate is E00's own (D62 / F8): filing bytes costs `manage_files`, linking them costs the line's
 * own edit right, derived from the kind through the engine's `editCapabilityForKind`. A person missing
 * either half is never offered the drop or the picker (hidden, never shown then refused).
 */
import { useCallback, useRef, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, editCapabilityForKind, useCapabilities } from '../../lib/capabilities';
import { readFileAsUpload } from '../Files/model';

export interface AttachReceipt {
  /** The person may attach a Beleg to a bank line (both halves of the gate). */
  canAttach: boolean;
  /** The line an attach is running for, or null. */
  busyLine: string | null;
  /** Upload, then link to the line. Resolves to the refusal, or null when both calls landed. */
  attach: (bankTxnId: string, file: File) => Promise<Err | null>;
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

  const attach = useCallback(
    async (bankTxnId: string, file: File): Promise<Err | null> => {
      if (workspaceId === null) return null;
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
        if (isErr(uploaded.body)) return uploaded.body;
        const stored = (uploaded.body as unknown as { file: { id: string } }).file;
        const linked = await client.call('files_link', {
          workspaceId,
          fileId: stored.id,
          entityKind: 'bank_txn',
          entityId: bankTxnId,
          idempotencyKey: key.link,
        });
        if (isErr(linked.body)) return linked.body;
        keys.current.delete(intent);
        return null;
      } finally {
        setBusyLine(null);
      }
    },
    [client, workspaceId],
  );

  return { canAttach, busyLine, attach };
}
