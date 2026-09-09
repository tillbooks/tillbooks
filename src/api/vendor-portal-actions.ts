/**
 * F03's six verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` / `portalActions`
 * precedent), so several agents appending to the append-only registry at once collide over a line
 * rather than a block.
 *
 * ALL SIX ARE `ctxAction`s (spec §5, reconciled): every verb carries `workspaceId`. Unlike F02's two
 * pre-workspace token verbs, F03's scoped reads (`vendor_portal_pos`, `vendor_portal_remittances`)
 * are workspace-scoped, and the grant token is a SECOND fence WITHIN the workspace, so no ungated
 * pre-workspace read path exists. Three are `portal.manage` writes (grant / revoke / remittance
 * create), three are `read_master_data` reads (grants list + the two scoped reads). The gates live in
 * `src/core/access/actionCapabilities.ts`.
 *
 * `vendor_portal_grant` / `vendor_portal_revoke` are THIN wrappers over F02's shared grant engine
 * passing `kind='vendor'`: F03 opens no second grant path (spec §4). They are DENYLISTED as automation
 * actions (a grant's scope is a revDSG data-minimisation decision, `denylist.ts`), while
 * `vendor_portal_remittance_create` stays automatable as F03's one accepted rule action.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  vendorPortalGrant,
  vendorPortalRevoke,
  vendorPortalGrantsList,
  vendorPortalListPOs,
  vendorPortalListRemittances,
  createRemittanceAdvice,
} from '../core/portal/index.js';

export interface VendorPortalActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The F03 verbs, in append order. */
export function vendorPortalActions(h: VendorPortalActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;

  return [
    ctxAction(
      'vendor_portal_grant',
      'write',
      'Gib einem Lieferanten Portal-Zugang frei (US-F03.1): mint a scoped, expiring vendor grant over F02\'s shared grant engine (kind=vendor, no second token path). The contact must be a SUPPLIER (party_role vendor|both), else contact_not_found (the same opaque code a missing contact returns, no oracle). scopes default to the vendor set [{kind:"pos.read"},{kind:"remittance.read"}]. The token is CSPRNG >=256-bit; only its SHA-256 hash is stored and the one-time link is returned once (tokenOnce/localLink), never re-derivable. expiresAt in the past is refused (expiry_in_past); longer than the 90-day max is CLAMPED (clamped:true). Posts nothing (OP4: mints the local artifact and stops, hosted:false/reason:cloud_tier). idempotencyKey replays the original grant.',
      ctxSchema(
        {
          contactId: STR,
          expiresAt: STR,
          scopes: { type: 'array', items: { type: 'object', properties: { kind: STR, id: STR } } },
          actor: STR,
          idempotencyKey: STR,
        },
        ['contactId', 'expiresAt'],
      ),
      (ctx, input) => vendorPortalGrant(ctx, as(input)),
    ),
    ctxAction(
      'vendor_portal_revoke',
      'write',
      'Widerrufe einen Lieferanten-Portalzugang (US-F03.4): stamps revoked_at so any read of the token now denies as grant_invalid. Fenced to kind=vendor (a non-vendor id returns not_found), so the vendor verb never touches a customer grant. The row is NEVER deleted (the grant history is the revDSG access trail). Revoking an already-revoked grant is a no-op returning the original state.',
      ctxSchema({ grantId: STR, actor: STR, idempotencyKey: STR }, ['grantId']),
      (ctx, input) => vendorPortalRevoke(ctx, as(input)),
    ),
    ctxAction(
      'vendor_portal_grants_list',
      'read',
      'Liste die Lieferanten-Portalfreigaben (P5): every vendor grant, optionally per contact and per status (draft/active/revoked/expired), each with its hosted:false truth. Reuses F02\'s grant read model filtered to kind=vendor; savedViewId applies a G00 saved view over the portal_grant entity kind.',
      ctxSchema({ contactId: STR, status: STR, savedViewId: STR }),
      (ctx, input) => vendorPortalGrantsList(ctx, as(input)),
    ),
    ctxAction(
      'vendor_portal_pos',
      'read',
      'Liste die offenen Bestellungen eines Lieferanten (US-F03.2, P5): a scoped read model over D02 purchase_orders + po_lines, filtered to the supplier\'s own contact, status IN (sent, received) only (draft/closed/cancelled are D02 internal state, never exposed), and workspace_id (H-TENANT). Pass grantToken for the supplier/agent path (the grant\'s own contact_id is the fence; an expired/revoked/foreign token returns grant_invalid, no oracle; the grant must carry the pos.read scope) OR contactId for the operator "Sichtbar für Lieferant" preview. Reads only, mutates nothing.',
      ctxSchema({ grantToken: STR, contactId: STR }),
      (ctx, input) => vendorPortalListPOs(ctx, as(input)),
    ),
    ctxAction(
      'vendor_portal_remittance_create',
      'write',
      'Erstelle ein Zahlungsavis (US-F03.3): SNAPSHOT the A14 payment and its A17 vendor-bill allocations into a remittance_advice + per-bill lines (integer-Rappen values copied verbatim, per-line H-FX txn+base+rate), and file a rendered advice artifact into E00 (artifact_document_id). POSTS NOTHING: A14 already posted the payment (P3 by having no posting at all). The paymentId must be an OUTGOING supplier settlement with >=1 vendor-bill allocation, else payment_not_found (opaque, no cross-supplier oracle). idempotencyKey (scoped by paymentId) replays the same advice; without a key a re-file supersedes the current advice (supersedes_id), never a silent overwrite. Artifact-and-stop (OP4: transmitted:false/reason:cloud_tier).',
      ctxSchema({ paymentId: STR, actor: STR, idempotencyKey: STR }, ['paymentId']),
      (ctx, input) => createRemittanceAdvice(ctx, as(input)),
    ),
    ctxAction(
      'vendor_portal_remittances',
      'read',
      'Liste die Zahlungsavise eines Lieferanten (US-F03.3 portal read, P5): the remittance advices scoped to the supplier\'s own contact, same fences as vendor_portal_pos (grantToken requires the remittance.read scope, or contactId for the operator preview). Each advice carries its per-bill lines with txn+base+rate. savedViewId applies a G00 saved view over remittance_advice (its stored presets never widen the contact fence). Reads only.',
      ctxSchema({ grantToken: STR, contactId: STR, savedViewId: STR }),
      (ctx, input) => vendorPortalListRemittances(ctx, as(input)),
    ),
  ];
}
