/**
 * F02's six verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `signActions` precedent), so several agents appending to the append-only registry at once collide
 * over a line rather than a block.
 *
 * Four are operator writes/reads gated by A24 `portal.manage` (create, revoke, list) and `send`
 * (`portal_grant_send`, the P8 outbound half): they are `ctxAction`s. TWO are TOKEN-authenticated and
 * pre-workspace, so they are `depsAction`s the `accept_invite` shape: `portal_resolve` (the single
 * verb the hosted page calls) and `portal_quote_accept` (an external customer accepting a quote,
 * which delegates to C02's real accept). The token IS the authorisation, and the grant binds the
 * workspace (§H-TENANT), so neither carries a `workspaceId`.
 *
 * NO verb here holds an `ActionInvoker`: `portal_quote_accept` reaches C02's `acceptQuote` engine
 * function DIRECTLY (the quote engine reaches A10 directly, never back through the dispatch), so
 * there is no capability to launder and F02 opens no second write path.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  createGrant,
  sendGrant,
  revokeGrant,
  listGrants,
  resolveToken,
  portalQuoteAccept,
} from '../core/portal/index.js';

export interface PortalActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  depsAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (deps: ApiDeps, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  depsSchema(props: Record<string, unknown>, required: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The F02 verbs, in append order. */
export function portalActions(h: PortalActionHelpers): readonly ActionDef[] {
  const { ctxAction, depsAction, ctxSchema, depsSchema, STR, BOOL } = h;

  const SCOPES = {
    type: 'array',
    items: {
      type: 'object',
      properties: { kind: STR, id: STR },
    },
  } as const;

  return [
    ctxAction(
      'portal_grant_create',
      'write',
      'Gib einem Kunden Portal-Zugang frei: mint a scoped, expiring, tokened grant for a C00 contact. scopes is an explicit entity list ([{kind:"invoice"|"quote"|"document", id}] or {kind:"all_invoices"}); every id must be THIS contact\'s own record (invalid_scope otherwise, H-TENANT + per-contact fence). The token is CSPRNG >=256-bit; only its SHA-256 hash is stored, and the row carries NO usable link. The one-time link is returned once as tokenOnce/localLink and is never re-derivable. expiresAt in the past is refused; longer than the 90-day max is CLAMPED and flagged (clamped:true). Created draft (P8): handing the link over is portal_grant_send. Posts nothing (OP4: mints the local artifact and stops, hosted:false/reason:cloud_tier).',
      ctxSchema(
        { contactId: STR, scopes: SCOPES, expiresAt: STR, kind: STR, actor: STR, idempotencyKey: STR },
        ['contactId', 'scopes', 'expiresAt'],
      ),
      (ctx, input) => createGrant(ctx, as(input)),
    ),
    ctxAction(
      'portal_grant_send',
      'write',
      'Sende den Portal-Link (P8 outbound, draft-gated): hands the grant link over and activates it (draft -> active). Confirm-gated (needs_confirmation without confirmed:true, for humans and agents alike). OP4 boundary: no transport in the MIT core, so it degrades honestly to sent:false/reason:cloud_tier and the token is NOT re-derivable here (the operator received the one-time link at create). A revoked or expired grant is refused before any write.',
      ctxSchema({ grantId: STR, confirmed: BOOL, idempotencyKey: STR }, ['grantId']),
      (ctx, input) => sendGrant(ctx, as(input)),
    ),
    ctxAction(
      'portal_grant_revoke',
      'write',
      'Widerrufe einen Portal-Zugang: stamps revoked_at so any resolve of the token now denies. The row is NEVER deleted (the grant history is the revDSG access trail). Revoking an already-revoked grant is a no-op returning the original state. Not destructive: it revokes, it does not delete.',
      ctxSchema({ grantId: STR, actor: STR, idempotencyKey: STR }, ['grantId']),
      (ctx, input) => revokeGrant(ctx, as(input)),
    ),
    ctxAction(
      'portal_grant_list',
      'read',
      'Liste die Portal-Freigaben (P5): every grant, optionally per contact, each with its derived status (draft/active/revoked/expired) and its hosted:false truth (the same shape an agent and the panel both see). savedViewId applies a saved view (G00): its stored filters merge underneath any filter named explicitly here.',
      ctxSchema({ contactId: STR, savedViewId: STR }),
      (ctx, input) => listGrants(ctx, as(input)),
    ),
    depsAction(
      'portal_resolve',
      'write',
      'Löse einen Portal-Token auf (the single verb the hosted page calls; agents call it to test a grant end to end): hashes the presented token, loads the grant, enforces expiry/revocation and the THREE FENCES (workspace -> contact -> scope), and returns ONLY the scoped read model: invoices (number, dates, total + open amount from A11/A14, QR reference read verbatim), quotes (C02 state), documents (E00 metadata). An expired or revoked token, or one scoped to another contact, returns grant_denied indistinguishably (no oracle). Token-authenticated, pre-workspace: no workspaceId. Computes no money, posts nothing; every resolve/denial lands in audit_log.',
      depsSchema({ token: STR }, ['token']),
      (deps, input) => resolveToken(deps, as(input)),
    ),
    depsAction(
      'portal_quote_accept',
      'write',
      'Nimm eine Offerte über das Portal an (US-F02.3): fence-checks the token (the quote must be in scope AND belong to the grant\'s contact) then DELEGATES to C02\'s real accept (the A10 sent -> accepted transition) with actor portal:<grantId>. F02 owns no quote state and hand-rolls no invoice. Idempotent via idempotencyKey: a same-key re-accept returns the original, never a second acceptance (no double-issue). C02\'s own errors (invalid_transition on a non-sent quote, quote_expired) surface unchanged. A refused accept writes zero rows. Token-authenticated, pre-workspace: no workspaceId.',
      depsSchema({ token: STR, quoteId: STR, idempotencyKey: STR }, ['token', 'quoteId']),
      (deps, input) => portalQuoteAccept(deps, as(input)),
    ),
  ];
}
