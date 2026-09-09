/**
 * A33's five verbs (1 read + 4 writes), defined here and spread into `ACTIONS` as ONE line (the
 * `ebillActions` / `fxActions` precedent), so several agents appending to the append-only registry at
 * once collide over a line rather than a block.
 *
 * `bank_channel_connect`, `bank_sync`, `payment_batch_transmit` and `bank_channel_disconnect` are all
 * writes carrying `workspace_id` + `idempotency_key` (P4/§H-TENANT/§H-IDEMPOTENT). `bank_channel_status`
 * is the P5 read model, no write twin. THE LAW lives in the engine, not the descriptions: transmit
 * uploads WITHOUT the SignatureFlag, so the bank authorizes and TILL never holds sole payment
 * authority, and NONE of these verbs marks anything paid (that stays A18's `mark_batch_paid`).
 *
 * There is NO key-export tool and no tool ever returns key material (spec §5, tripwire 3). The
 * connect verb is P8-gated with the same explicitness as transmit (the bank-key confirm is the
 * man-in-the-middle defence). As with `ebill-actions.ts`, the helpers arrive as a parameter rather
 * than an import so the module graph stays acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  connectBankChannel,
  syncBankChannel,
  transmitPaymentBatch,
  getBankChannelStatus,
  disconnectBankChannel,
  setBankSyncSchedule,
  lookupBankDirectory,
} from '../core/banking/ebics/index.js';

export interface EbicsActionHelpers {
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
  INT: { readonly type: 'integer' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The A33 verbs, in append order. */
export function ebicsActions(h: EbicsActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL, INT } = h;

  const HOST = {
    type: 'object',
    properties: { url: STR, hostId: STR, partnerId: STR, userId: STR },
    additionalProperties: false,
  } as const;
  const ID_ARRAY = { type: 'array', items: STR } as const;
  const DATE_RANGE = { type: 'object', properties: { from: STR, to: STR }, additionalProperties: false } as const;
  // A37: the consent scopes the managed (bLink) connect wizard may request ('ais'|'pss'), the §H-ENUM
  // set validated in the engine. AIS is data access; PSS adds payment submission.
  const SCOPES = { type: 'array', items: STR } as const;

  return [
    ctxAction(
      'bank_channel_connect',
      'write',
      "Open or advance a bank channel, EBICS by default or the managed bLink rail with channelKind='managed_blink' (A37). P8-gated: pass confirm=true or enable the approval dial. EBICS (the SMPG 6.1 key ceremony, keyed to the bank CONTRACT host/partner/user, never an account): from nothing generate three RSA key pairs locally, create the connection, route the given A19 accounts, and file the INI letter as a document to sign and post to the bank (state keys_generated; with a transport wired it sends INI+HIA and lands pending_bank_activation); from pending_bank_activation run HPB and, with confirmBankKeys=true and a hash match, flip to active (a mismatch is bank_keys_mismatch, a hard stop). Managed (channelKind='managed_blink', keyed to the bank via bankRef with scopes ['ais'] or ['ais','pss']): with the owner-gated cloud tier ON it asks the relay for a fresh consent URL and lands consent_pending, and the next poll flips to active once the customer grants consent in their own e-banking; with the tier OFF it returns the OP4 shape {ok:false,error:'cloud_tier'} with no side effects. TILL never sees, asks for, or stores a bank credential on either rail; never returns key material; posts nothing.",
      ctxSchema(
        {
          channelKind: STR,
          connectionId: STR,
          host: HOST,
          bankRef: STR,
          scopes: SCOPES,
          routeBankAccountIds: ID_ARRAY,
          confirm: BOOL,
          confirmBankKeys: BOOL,
          keyLength: INT,
          idempotencyKey: STR,
        },
        ['idempotencyKey'],
      ),
      (ctx, input) => connectBankChannel(ctx, as(input)),
    ),
    ctxAction(
      'bank_sync',
      'write',
      "Pull pending camt.053/054 statements (plus the pain.002 status report and the HAC customer protocol) over an active EBICS channel and hand each statement to A20's import BYTE-FOR-BYTE, routed to the right A19 account by its IBAN. Persists every fetched file as a document before acknowledging the bank (crash-durable), and re-sync is A20's dedupe no-op. A statement whose IBAN matches no routed account is surfaced as unmatched_account, never dropped. With no transport wired it reports needs_bank_transport and the file path stands. Writes statements only through A20; posts nothing.",
      ctxSchema({ connectionId: STR, bankAccountId: STR, dateRange: DATE_RANGE, idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input) => syncBankChannel(ctx, as(input)),
    ),
    ctxAction(
      'payment_batch_transmit',
      'write',
      "Upload a generated A18 pain.001 payment batch to the bank over EBICS (BTU). P8-gated: pass confirm=true or enable the approval dial. Submits WITHOUT the authorizing signature flag, so the bank's own out-of-channel release authorizes it and TILL never holds sole payment authority; the batch shows pending_release. NEVER marks anything paid (paid comes from the camt debit via A20). Idempotent at the order level via an intent row committed before any upload: a double call delivers nothing and returns the existing order; a crash mid-upload surfaces transmit_in_doubt and blocks retransmission until the bank's protocol resolves it. A rejection lands bank_rejected with the bank's reason (recover by regenerating in A18). No channel routed to the batch's account returns needs_bank_channel and the file path stands. Posts nothing.",
      ctxSchema({ batchId: STR, confirm: BOOL, idempotencyKey: STR }, ['batchId', 'idempotencyKey']),
      (ctx, input) => transmitPaymentBatch(ctx, as(input)),
    ),
    ctxAction(
      'bank_channel_disconnect',
      'write',
      "Retire or block an EBICS bank channel (P8-gated: pass confirm=true or enable the approval dial). retire is the local, terminal close: the channel flips to retired, its order history stays readable, and its keys are destroyed. block is the emergency stop: it issues the SPR administrative order and blocks the EBICS channel only (the file path stays open); re-initialisation via bank_channel_connect is the way back. Both idempotent. Posts nothing.",
      ctxSchema({ connectionId: STR, mode: STR, confirm: BOOL, idempotencyKey: STR }, ['connectionId', 'mode', 'idempotencyKey']),
      (ctx, input) => disconnectBankChannel(ctx, as(input)),
    ),
    ctxAction(
      'bank_channel_status',
      'read',
      'Read EBICS channel health: per channel the connection state, last sync, any pending INI letter, uploads awaiting bank release, unmatched fetched statements, in-doubt uploads, recent bank_rejected orders, and the recent order log. Optionally scoped to one bank account, or filtered by order status (a saved view over the ebics_order log applies its stored status filter; an explicit status wins). A blocked channel is labelled as blocking only the EBICS channel, the file path still open. Read-only.',
      ctxSchema({ bankAccountId: STR, status: STR, savedViewId: STR }, []),
      (ctx, input) => getBankChannelStatus(ctx, as(input)),
    ),
    ctxAction(
      'bank_channel_directory',
      'read',
      "Look up a Swiss bank in TILL's static, in-package EBICS directory for the connect wizard (A36): substring or BIC match over the curated set, returning each bank's names, BIC, the marketing name of its EBICS channel, the segments it offers EBICS to, where to post the signed INI letter, known protocol quirks, and an EXPLICITLY UNVERIFIED fee note (verified:false always). The per-contract host URL and Host ID are null in v1 (the bank issues them on your signed EBICS contract; enter them in the manual fields). Reads static data only: opens NO socket, needs no idempotency key, is never a gate on the ceremony. An empty query returns the whole set; no match returns an empty array, not an error.",
      ctxSchema({ query: STR }, []),
      (ctx, input) => lookupBankDirectory(ctx, as(input)),
    ),
    ctxAction(
      'set_bank_sync_schedule',
      'write',
      "Link or unlink the G01 automation rule that drives this EBICS connection's scheduled sync (A36 US-A36.3). The channel panel's Automatischer Abruf toggle creates a schedule rule whose action is bank_sync for this connectionId through G01's rule verbs, then calls this to store the linkage on the connection so the status card shows the cadence and a retire clears it. Pass ruleId to link (the rule must have action bank_sync and not be archived), or omit/null to unlink. Creates, enables or fires NO rule (that is G01's surface); default is OFF. Idempotent; banking-write. Posts nothing.",
      ctxSchema({ connectionId: STR, ruleId: STR, idempotencyKey: STR }, ['connectionId', 'idempotencyKey']),
      (ctx, input) => setBankSyncSchedule(ctx, as(input)),
    ),
  ];
}
