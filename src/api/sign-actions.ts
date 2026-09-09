/**
 * E01's eight verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `taskActions` / `fileActions` precedent), so several agents appending to the append-only registry
 * at once collide over a line rather than a block.
 *
 * The six writes are the whole sign-request lifecycle (create, send, record_event, complete,
 * withdraw, delete_draft); the two reads are the tracking surface (get, list). `sign_requests_send`
 * is the ONE outbound verb and it is doubly gated: A24 requires `sign.send` on top of `sign.write`
 * (the ALL-OF shape), and P8 requires `confirmed:true` for human and agent callers identically.
 * With no transmitter wired (the MIT core's only state) it degrades to `needs_provider` and the
 * request stays a draft (OP4): nothing leaves the device.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  createSignRequest,
  sendSignRequest,
  recordSignRequestEvent,
  completeSignRequest,
  withdrawSignRequest,
  deleteDraftSignRequest,
  getSignRequest,
  listSignRequests,
} from '../core/sign/index.js';

export interface SignActionHelpers {
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

/** The E01 verbs, in append order. */
export function signActions(h: SignActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;

  return [
    ctxAction(
      'sign_requests_create',
      'write',
      'Fordere eine Signatur an: creates a draft sign request on an E00 file (fileId, the current head version) for one signer (signerContactId, must carry an email), at a signature level (ses or qes, the ZertES/OR Art. 14 classification), with an optional message and expiry. Writes the provider-agnostic local artifact (OP4); nothing is transmitted. One open request per signer and file (request_already_open); a superseded file version is refused (not_head_version).',
      ctxSchema(
        {
          fileId: STR,
          signerContactId: STR,
          signatureLevel: STR,
          message: STR,
          expiresAt: STR,
          idempotencyKey: STR,
        },
        ['fileId', 'signerContactId', 'signatureLevel'],
      ),
      (ctx, input) => createSignRequest(ctx, as(input)),
    ),
    ctxAction(
      'sign_requests_send',
      'write',
      'Sende die Signaturanfrage an den Anbieter: the ONE outbound e-sign verb (draft -> sent). P8 confirm-gated (needs_confirmation without confirmed true, for humans and agents alike), and honest about the OP4 boundary: with no e-sign provider wired (the OSS-core default) it returns needs_provider with the local artifact and the request stays a draft, for the manual wet-ink path via sign_requests_complete.',
      ctxSchema({ signRequestId: STR, confirmed: BOOL, idempotencyKey: STR }, ['signRequestId']),
      (ctx, input) => sendSignRequest(ctx, as(input)),
    ),
    ctxAction(
      'sign_requests_record_event',
      'write',
      'Erfasse ein Statusereignis auf einer Signaturanfrage: viewed (sent -> viewed; recording viewed twice is a no-op), declined (sent|viewed -> declined, with optional declinedReason: also the manual "Als abgelehnt markieren" in the drawer), or expired (sent|viewed -> expired, a provider deadline event). Optional evidence is appended to the event trail of the local artifact. Every illegal edge answers invalid_transition.',
      ctxSchema(
        {
          signRequestId: STR,
          status: STR,
          declinedReason: STR,
          evidence: { type: 'object' },
          idempotencyKey: STR,
        },
        ['signRequestId', 'status'],
      ),
      (ctx, input) => recordSignRequestEvent(ctx, as(input)),
    ),
    ctxAction(
      'sign_requests_complete',
      'write',
      'Markiere als signiert und lege die signierte Fassung ab: verifies originalSha256 against the requested file version (document_hash_mismatch on a swapped file), then delegates to E00 files_new_version so the signed PDF becomes a new version of the SAME file (supersedes_id, retention carried forward per OR 958f). Legal from draft (the manual wet-ink path when no provider is wired), sent and viewed (the provider path). E01 never writes file bytes itself.',
      ctxSchema(
        {
          signRequestId: STR,
          signedContentBase64: STR,
          originalSha256: STR,
          mime: STR,
          idempotencyKey: STR,
        },
        ['signRequestId', 'signedContentBase64', 'originalSha256'],
      ),
      (ctx, input) => completeSignRequest(ctx, as(input)),
    ),
    ctxAction(
      'sign_requests_withdraw',
      'write',
      'Ziehe eine gesendete Signaturanfrage zurück: sent|viewed -> expired with expired_reason withdrawn (no seventh status is minted, §H-ENUM stays six states). A draft is not withdrawn but discarded via sign_requests_delete_draft; a terminal request answers invalid_transition.',
      ctxSchema({ signRequestId: STR, idempotencyKey: STR }, ['signRequestId']),
      (ctx, input) => withdrawSignRequest(ctx, as(input)),
    ),
    ctxAction(
      'sign_requests_delete_draft',
      'write',
      'Verwirf einen Signatur-Entwurf: deletes a draft request that never went anywhere. Only a draft may be deleted (invalid_transition otherwise); sent and later states are withdrawn or completed, never erased, because their event trail is evidence.',
      ctxSchema({ signRequestId: STR, idempotencyKey: STR }, ['signRequestId']),
      (ctx, input) => deleteDraftSignRequest(ctx, as(input)),
    ),
    ctxAction(
      'sign_requests_get',
      'read',
      'Eine Signaturanfrage mit ihrem lokalen Artefakt (the OP4 envelope incl. the event trail). Reading an overdue open request persists its expiry first (lazy sweep, no background daemon in the OSS core).',
      ctxSchema({ signRequestId: STR }, ['signRequestId']),
      (ctx, input) => getSignRequest(ctx, as(input)),
    ),
    ctxAction(
      'sign_requests_list',
      'read',
      'Die Signaturanfragen-Liste (P5): filterable by file (the per-file list in the drawer), status (the "Offene Signaturen" tracking filter) or signer. savedViewId applies a saved view (G00): its stored filters merge underneath any filter named explicitly here. Listing persists overdue expiries first (lazy sweep).',
      ctxSchema({ fileId: STR, status: STR, signerContactId: STR, savedViewId: STR }),
      (ctx, input) => listSignRequests(ctx, as(input)),
    ),
  ];
}
