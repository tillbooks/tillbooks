/**
 * N02 (D183): the drop page's two calls, `POST /studio-drop/resolve` and `POST /studio-drop/redeem`
 * (`src/api/drop-face.ts`). They are NOT registry verbs, so they do not go through `TillClient`: the
 * redemption is the one deliberate exception to the MCP/REST parity pair, reachable only with the
 * Studio key, so no agent can redeem the link it minted. The header is the same one every REST call
 * carries (`studioKeyHeaders`).
 */
import { studioKeyHeaders, STUDIO_KEY_REFUSALS } from '../../lib/studio-key';
import type { BookAgainConfirmation } from '../../lib/receiptHolders';

/** Mirrors `DROP_RESOLVE_PATH` / `DROP_REDEEM_PATH` in `src/api/drop-face.ts`. */
export const DROP_RESOLVE_PATH = '/studio-drop/resolve';
export const DROP_REDEEM_PATH = '/studio-drop/redeem';

/** Mirrors `DropTargetView` in `src/core/files/dropLink.ts`. */
export interface DropTarget {
  kind: 'journal_entry' | 'vendor_bill' | 'bank_txn' | 'drafted_action';
  id: string;
  number: string | null;
  text: string | null;
  date: string | null;
  amountMinor: number | null;
  currency: string | null;
  actionTool: string | null;
  route: string;
}

/** Mirrors `ResolvedDropLink`. */
export interface DropLink {
  state: 'ready' | 'used' | 'expired';
  linkId: string;
  workspaceId: string;
  expiresAt: string;
  usedAt: string | null;
  fileId: string | null;
  target: DropTarget;
}

/** What a redemption answers on success. */
export interface DropDone {
  fileId: string;
  mime: string;
  filename: string;
  duplicate: boolean;
  duplicateOf: string | null;
  holder: { fileId: string; entityKind: string | null; entityId: string | null } | null;
  pending: boolean;
  target: DropTarget;
}

export type DropAnswer<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unpaired' }
  | { kind: 'refused'; status: number; error: string; body: Record<string, unknown> }
  | { kind: 'transport' };

async function post<T>(path: string, body: Record<string, unknown>, pick: (raw: Record<string, unknown>) => T): Promise<DropAnswer<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...studioKeyHeaders() },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'transport' };
  }
  let raw: Record<string, unknown>;
  try {
    raw = (await response.json()) as Record<string, unknown>;
  } catch {
    return { kind: 'transport' };
  }
  const error = typeof raw.error === 'string' ? raw.error : null;
  if (response.status === 401 && error !== null && (STUDIO_KEY_REFUSALS as readonly string[]).includes(error)) return { kind: 'unpaired' };
  if (raw.ok === true) return { kind: 'ok', value: pick(raw) };
  return { kind: 'refused', status: response.status, error: error ?? 'unknown', body: raw };
}

export function resolveDrop(token: string): Promise<DropAnswer<DropLink>> {
  return post(DROP_RESOLVE_PATH, { token }, (raw) => raw.link as DropLink);
}

/**
 * The drop. N02 R1: `confirmation` is the person's reason for attaching a receipt that is already booked
 * elsewhere (the redemption answered `receipt_already_booked` with an override hint first).
 */
export function redeemDrop(token: string, contentBase64: string, filename: string, confirmation?: BookAgainConfirmation): Promise<DropAnswer<DropDone>> {
  return post(DROP_REDEEM_PATH, { token, contentBase64, filename, ...(confirmation ?? {}) }, (raw) => raw as unknown as DropDone);
}

/** A file as base64, read in the browser (the redemption body is JSON, like every Studio call). */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const url = String(reader.result ?? '');
      const comma = url.indexOf(',');
      resolve(comma === -1 ? '' : url.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}
