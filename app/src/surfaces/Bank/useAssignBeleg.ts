/**
 * A41.3 re-cut v2 (D184, I-B), the Studio's half of the receipt assignment: a PERSON says which captured receipt
 * is the Beleg of an OPEN bank line (`assign_beleg`, "Anhängen" of a candidate group, "Zuordnen" in the review
 * view), takes it back (`release_beleg`, "Lösen") and vouches for a capture's figures (`confirm_capture_figures`,
 * "Zahlen bestätigen"). All three are human-only in the engine; the Studio seat is the person's.
 *
 * A41.3 follow-ups: a FILED file (a drop on the row, "Abgelegt, nicht zugeordnet", or the new version a move left
 * on the line, "Neue Version, bitte zuordnen") is assigned with `assign_beleg_file` (`assignFile`): the engine
 * captures it and assigns it in one act. The drop itself runs through `useAttachReceipt.attachAssign`, which keeps
 * D142's per-intent keys and the N02 receipt rule.
 *
 * A BOOKED line keeps `files_link` (the engine refuses `assign_beleg` there with `line_not_open`).
 */
import { useCallback, useRef } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, editCapabilityForKind, useCapabilities } from '../../lib/capabilities';
import type { ConfirmEntry } from '../../lib/expectedFigures';

export interface AssignBeleg {
  /** A person may assign on an open line: filing AND the line's edit right, and both reads (receipts, bank lines). */
  canAssign: boolean;
  /** `assign_beleg` with these documents (a candidate group); null when it landed. */
  assign: (bankTxnId: string, fileIds: readonly string[]) => Promise<Err | null>;
  /**
   * `assign_beleg_file` with one filed file (captured and assigned in one act); null when it landed. The key is per
   * intent (this file on this line), kept across retries until it lands.
   */
  assignFile: (bankTxnId: string, fileId: string) => Promise<Err | null>;
  /** `release_beleg`; null when it landed. */
  release: (bankTxnId: string) => Promise<Err | null>;
  /**
   * `confirm_capture_figures` over the captures exactly as displayed (`confirmEntryOf` of the read that rendered
   * them); null when it landed. A stale refusal (`figures_changed`) is the host's to reload and ask again.
   */
  confirm: (entries: readonly ConfirmEntry[]) => Promise<Err | null>;
}

export function useAssignBeleg(workspaceId: string | null): AssignBeleg {
  const client = useClient();
  const { can } = useCapabilities();
  const canAssign = can(CAP.manageFiles) && can(editCapabilityForKind('bank_txn')) && can(CAP.readMasterData) && can(CAP.readSales);

  const assign = useCallback(
    async (bankTxnId: string, fileIds: readonly string[]): Promise<Err | null> => {
      if (workspaceId === null) return null;
      const { body } = await client.call('assign_beleg', { workspaceId, bankTxnId, fileIds: [...fileIds], idempotencyKey: crypto.randomUUID() });
      return isErr(body) ? body : null;
    },
    [client, workspaceId],
  );

  const fileKeys = useRef(new Map<string, string>());
  const assignFile = useCallback(
    async (bankTxnId: string, fileId: string): Promise<Err | null> => {
      if (workspaceId === null) return null;
      const intent = JSON.stringify([bankTxnId, fileId]);
      const key = fileKeys.current.get(intent) ?? crypto.randomUUID();
      fileKeys.current.set(intent, key);
      const { body } = await client.call('assign_beleg_file', { workspaceId, bankTxnId, fileId, idempotencyKey: key });
      if (isErr(body)) return body;
      fileKeys.current.delete(intent);
      return null;
    },
    [client, workspaceId],
  );

  const release = useCallback(
    async (bankTxnId: string): Promise<Err | null> => {
      if (workspaceId === null) return null;
      const { body } = await client.call('release_beleg', { workspaceId, bankTxnId, idempotencyKey: crypto.randomUUID() });
      return isErr(body) ? body : null;
    },
    [client, workspaceId],
  );

  const confirm = useCallback(
    async (entries: readonly ConfirmEntry[]): Promise<Err | null> => {
      if (workspaceId === null || entries.length === 0) return null;
      const { body } = await client.call('confirm_capture_figures', { workspaceId, captures: [...entries], idempotencyKey: crypto.randomUUID() });
      return isErr(body) ? body : null;
    },
    [client, workspaceId],
  );

  return { canAssign, assign, assignFile, release, confirm };
}
