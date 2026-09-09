/**
 * A32's five verbs (2 reads + 3 writes), defined here and spread into `ACTIONS` as ONE line (the
 * `fxActions` / `captureActions` precedent), so several agents appending to the append-only registry
 * at once collide over a line rather than a block.
 *
 * `set_ebill_config` asserts an ABSOLUTE state, so it is naturally idempotent and carries NO
 * idempotency key (it is listed in the conformance gate's key-exemption list with a reason). The two
 * moving writes (`ebill_prepare`, `ebill_transmit`) each carry `idempotencyKey`. There is no
 * `create_ebill_delivery`/`list_ebill_deliveries`/`enroll_ebill`: creation IS preparation, listing
 * rides the one status read, and enrollment is a commercial step, never software (spec §3/§5). The
 * connector-facing `mirrorEbillPartnerStatus` seam is deliberately NOT a verb (spec §4): status truth
 * flows from the partner's events, never from a caller's assertion.
 *
 * As with `capture-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  setEbillConfig,
  getEbillConfig,
  prepareEbill,
  transmitEbill,
  getEbillDeliveryStatus,
} from '../core/sales/index.js';

export interface EbillActionHelpers {
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

/** The A32 verbs, in append order. */
export function ebillActions(h: EbillActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;

  return [
    ctxAction(
      'get_ebill_config',
      'read',
      'Read the workspace eBill configuration (the eBill-Biller-ID the owner received from a certified network partner at enrollment), or null when none is set. Enrollment happens with the partner, not in TILL.',
      ctxSchema({}, []),
      (ctx) => getEbillConfig(ctx),
    ),
    ctxAction(
      'set_ebill_config',
      'write',
      'Record the eBill-Biller-ID after enrolling with a certified network partner (a commercial step outside the product). Validates the SWP billerPid shape (41 followed by 15 digits) and upserts the one config row per workspace; a malformed id returns invalid_biller_pid and persists nothing. Naturally idempotent (asserts an absolute state), so it takes no idempotency key. Posts nothing.',
      ctxSchema({ billerPid: STR }, ['billerPid']),
      (ctx, input) => setEbillConfig(ctx, as(input)),
    ),
    ctxAction(
      'ebill_prepare',
      'write',
      "Turn an issued invoice (issued, sent, or partially_paid) into an eBill delivery payload on disk, carrying A11's QR reference unchanged. Files the A11 PDF as an E00 document (entity_kind ebill_delivery, OR 958f retention) and records an ebill_deliveries row (status prepared) with the payload's conformance facts (PDF/A profile, eBill addressing, byte length) recorded, never claimed. Refuses a draft/cancelled/settled invoice (invalid_state) and an invoice with no payment part (needs_qr_bill), writing nothing. Idempotent by outcome: at most one active (non-failed) delivery per invoice, so a re-prepare returns the existing row and its stored artifact regardless of key. Posts nothing.",
      ctxSchema({ invoiceId: STR, idempotencyKey: STR }, ['invoiceId', 'idempotencyKey']),
      (ctx, input) => prepareEbill(ctx, as(input)),
    ),
    ctxAction(
      'ebill_transmit',
      'write',
      "Transmit a prepared delivery through the owner-gated cloud connector (P8: outbound, draft-by-default; pass confirmed=true or enable the workspace dial). Guard order: no connector returns the honest {transmitted:false, reason:'cloud_tier'} and the artifact stays downloadable; then needs_biller_pid; then needs_confirmation; then payload_not_conformant if the payload is not PDF/A-3b, not eBill-addressed, or over 10 MB (nothing non-conformant is ever transmitted). On acknowledgement records the business case and drives the invoice issued->sent (A10) only from issued. Idempotent: a transmitted delivery never resubmits; transmission is at-least-once via a stored correlation id. Posts nothing.",
      ctxSchema({ deliveryId: STR, confirmed: BOOL, idempotencyKey: STR }, ['deliveryId', 'idempotencyKey']),
      (ctx, input) => transmitEbill(ctx, as(input)),
    ),
    ctxAction(
      'ebill_delivery_status',
      'read',
      'Track eBill deliveries: one by deliveryId (with its mirrored partner-status event trail), or a filtered list by invoiceId, local status (prepared|submitting|transmitted|failed), mirrored partner status (NWP_PENDING|OPEN|APPROVED|REJECTED|COMPLETED), or created-at range, newest first. Read-only.',
      ctxSchema(
        { deliveryId: STR, invoiceId: STR, status: STR, partnerStatus: STR, from: STR, to: STR, savedViewId: STR },
        [],
      ),
      (ctx, input) => getEbillDeliveryStatus(ctx, as(input)),
    ),
  ];
}
