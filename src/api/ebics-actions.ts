/**
 * A33 + A36, the EBICS bank channel verbs (download only since A36), defined here and spread into
 * `ACTIONS` as ONE line (the `ebillActions` / `fxActions` precedent), so several agents appending to
 * the append-only registry at once collide over a line rather than a block.
 *
 * `bank_channel_connect`, `bank_sync`, `payment_batch_transmit`, `bank_channel_disconnect` and
 * `set_bank_sync_schedule` are writes carrying `workspace_id` + `idempotency_key`
 * (P4/§H-TENANT/§H-IDEMPOTENT). `bank_channel_status` is the P5 read model. No verb was added or
 * removed by A36: `payment_batch_transmit` now refuses `upload_disabled` for a batch routed over EBICS
 * and `set_bank_sync_schedule` refuses a rule, while their degrade and unlink paths stay valid.
 *
 * There is NO key-export tool and no tool ever returns key material (tripwire 3). As with
 * `ebill-actions.ts`, the helpers arrive as a parameter rather than an import so the module graph
 * stays acyclic.
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
import { confirmStatementGap, revokeStatementGapConfirmation } from '../core/banking/index.js';
import type { ActionKind } from './actionKind.js';

export interface EbicsActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
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

const BANK_SYNC_SUMMARY =
  "Fetch the new day-end camt.053 statements (version 08) over an active EBICS channel, on demand (the Studio's Kontoauszüge abrufen, or when the owner asks) and, under till up, once a day by the scheduler (D142, set_bank_sync_schedule); never by an automation rule. Persists the bank's container and every new statement as documents first, then imports each one through import_camt by its account IBAN, then sends the bank's receipt, so nothing fetched is lost and nothing counts twice. On an EBICS-fed account a statement is imported only as the successor of the newest statement in the books or as the filler of a hole, by number and balances; a copy of one already there is already_imported; others wait (gap_refused, before_feed_start, not_day_end_statement, unsupported_multipage_statement, unmatched_account) and are retried from the stored bytes at every sync, or are refused for good (overlap_refused). A statement whose number skips some but whose balances chain imports with notice statement_number_jump and jump {after, statement, skipped} naming the missing numbers, which the owner imports by hand if they exist. Each call needs a fresh idempotencyKey; dateRange is refused (unsupported_date_range). Answers download_refused (not_granted, busy, too_large, other, with the bank's raw code), untrusted_response, bank_keys_changed or channel_unreachable in words. One fetch per connection at a time: a second call while one runs answers sync_in_progress. With no transport wired it reports needs_bank_transport. Posts nothing.";

/**
 * D142: give a verb a `runAsync` that hands the call to the host's off-thread runner when one is wired
 * (`till up`: a worker thread on its own SQLite connection) and otherwise runs the verb in process, so
 * the answer is the verb's own either way. Only `bank_sync` takes it.
 */
function offloadable(action: ActionDef): ActionDef {
  return {
    ...action,
    runAsync: (deps, input) => (deps.bankSyncRunner !== undefined ? deps.bankSyncRunner(deps, input) : Promise.resolve(action.run(deps, input))),
  };
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
  // A36: the bank-key hash set the human reviewed on the HPB compare step (the Studio's two-step
  // confirm). Opaque here: the engine validates its shape strictly, so the schema stays permissive.
  const EXPECTED_BANK_KEY_HASHES = { type: 'object' } as const;

  return [
    ctxAction(
      'bank_channel_connect',
      'write:final:outbound',
      "Open or advance a bank channel, EBICS 3.0 (H005) by default or the managed bLink rail with channelKind='managed_blink' (A37). Human only: pass confirm=true (P8); never fired by an automation rule. EBICS, keyed to the bank contract (host, partnerId, userId), never an account: the routed accounts are checked first (camt054_lines_refused; a sandbox or demo workspace is trial_workspace_refused; one live connection per subscriber in the database, live_connection_exists), then HEV (a host without H005 is unsupported_ebics_version), then three RSA 2048 key pairs with self-signed X.509 certificates are generated locally, the electronic-signature private key is dropped at once, the connection and the INI letter (the certificate hashes to sign and post) are filed, and INI and HIA are sent as two legs. The answer is pending_bank_activation, ini_sent (a lost answer: call again with connectionId to resend only the unconfirmed leg), or a refusal in words: init_refused (wrong partner or user ID, H005 not enabled, or already initialised), certificate_refused, key_exchange_refused. With connectionId: resends unconfirmed legs, runs HPB, and without confirmBankKeys returns the bank's key and certificate hashes for the owner to compare with ZKB's published sheet; with confirmBankKeys=true and expectedBankKeyHashes set to exactly that reviewed set it pins them and activates, only if a fresh HPB equals them (else bank_keys_mismatch, nothing pinned). The same reviewed confirm resumes a bank_keys_changed or locally blocked channel. Under till up TILL checks once a day by itself whether the bank has activated the access (bank_channel_status activation.bankReady, D143); the comparison and the confirm stay the human's. Never returns key material; posts nothing.",
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
          expectedBankKeyHashes: EXPECTED_BANK_KEY_HASHES,
          keyLength: INT,
          idempotencyKey: STR,
        },
        ['idempotencyKey'],
      ),
      (ctx, input) => connectBankChannel(ctx, as(input)),
    ),
    // D142: `bank_sync` may run off the main thread (the verb stays in its registry place, in order).
    offloadable(
      ctxAction(
        'bank_sync',
        'write:final:books',
        BANK_SYNC_SUMMARY,
        ctxSchema({ connectionId: STR, bankAccountId: STR, dateRange: DATE_RANGE, idempotencyKey: STR }, ['idempotencyKey']),
        (ctx, input) => syncBankChannel(ctx, as(input)),
      ),
    ),
    ctxAction(
      'payment_batch_transmit',
      'write:final:outbound',
      "Hand a generated A18 pain.001 payment batch to a bank channel that uploads payments. The EBICS channel downloads statements only: a batch whose debtor account is routed over EBICS is refused upload_disabled before anything is sent (upload the pain.001 in eBanking and release it there). A batch whose account is routed over the managed bLink rail (A37) is submitted there, P8-gated (confirm=true). With no channel it returns needs_bank_channel and the file path stands. Never marks anything paid (paid comes from the camt debit). Posts nothing.",
      ctxSchema({ batchId: STR, confirm: BOOL, idempotencyKey: STR }, ['batchId', 'idempotencyKey']),
      (ctx, input) => transmitPaymentBatch(ctx, as(input)),
    ),
    ctxAction(
      'bank_channel_disconnect',
      'write:final:stop',
      "Retire or block an EBICS bank channel (P8-gated: pass confirm=true or enable the approval dial). retire is the local, terminal close: the channel flips to retired, its order history stays readable, and its keys are destroyed. block is local only: TILL stops using the channel at once and sends nothing to the bank (a block at ZKB is the owner's phone call); the reviewed bank-key confirm through bank_channel_connect is the way back. Both idempotent. Posts nothing.",
      ctxSchema({ connectionId: STR, mode: STR, confirm: BOOL, idempotencyKey: STR }, ['connectionId', 'mode', 'idempotencyKey']),
      (ctx, input) => disconnectBankChannel(ctx, as(input)),
    ),
    ctxAction(
      'bank_channel_status',
      'read',
      'Read EBICS channel health: per channel the connection state, the INI and HIA legs, the keystore state, the pending INI letter, per routed account the newest statement in the books (number, year, date, closing balance) and lastNumberJump (the numbers skipped right before the newest statement the channel imported, null once they are in the books or the next statement followed normally), every downloaded statement still waiting with the reason it waits (a gap, before the feed start, an unrouted IBAN, a split statement) and the facts it names, the last sync, whether a fetch is running right now (syncInProgress, syncStartedAt: one fetch per connection at a time, D142), the daily automatic fetch (autoSync: mode, atTime, nextAt, the last automatic attempt, attemptsToday), the short name of the bank (bankName), the daily activation check while ZKB has not activated the access yet (activation: checking, lastCheckAt (the last HPB the bank answered), lastAttemptAt, nextCheckAt, lastOutcome, bankReady; D143), and the recent order log. When activation.bankReady is true the bank has answered and the keys must be compared: tell the human to open the bank accounts screen (/bank-accounts) and compare the bank key hashes with the sheet the bank published, then confirm (bank_channel_connect with confirmBankKeys). That comparison is an act of the human; never confirm the keys yourself. Optionally scoped to one bank account, or the order log filtered by status (a saved view applies its stored status filter; an explicit status wins). Read-only.',
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
      'write:reversible:outbound',
      "Set the daily automatic statement fetch of an EBICS connection (D142): mode 'daily' or 'off' and atTime as a Swiss local time HH:MM (default 07:00; an active connection that never set a mode is fetched daily). Under till up the scheduler then fetches once a day at that time, catches up at start when TILL was closed, and retries a bank that did not answer or was busy hourly, at most three attempts a day; till serve has no scheduler. No automation rule fetches statements: passing a ruleId is refused sync_schedule_parked, and the call also clears a rule pointer an older build stored. Idempotent; banking-write. Posts nothing.",
      ctxSchema({ connectionId: STR, ruleId: STR, mode: STR, atTime: STR, idempotencyKey: STR }, ['connectionId', 'idempotencyKey']),
      (ctx, input) => setBankSyncSchedule(ctx, as(input)),
    ),
    // A36 §4.7 (D150): the one act that closes a statement gap without a statement.
    ctxAction(
      'confirm_statement_gap',
      'write:reversible:human-only',
      "Confirm that nothing is missing in a statement gap of a Bankkonto (A36 §4.7, D150): the day-end statements afterStatementId and beforeStatementId are neighbours in the books, their numbers skip, and the later one opens exactly on the earlier one's closing balance (difference 0), so the skipped numbers are days without bookings or bookings that cancel out. Human only: a person at the button passes confirmed=true and a reason; an agent seat is refused human_only (propose it to the person instead). Refuses gap_has_waiting_statement when a downloaded statement inside the gap does not chain (it proves money the books do not explain), and gap_not_chained when the balances do not chain (the missing statements carry money that is not in the books: import them, such a gap can never be confirmed) and gap_not_found when the gap was filled or the two statements are not neighbours. Appends one confirmation row and its audit entry; changes no statement and posts nothing. A confirmed gap leaves bank_channel_status statementGaps and the attention hub; a statement found later still imports. Idempotent per key; a gap already confirmed answers alreadyConfirmed.",
      ctxSchema(
        { bankAccountId: STR, afterStatementId: STR, beforeStatementId: STR, reason: STR, confirmed: BOOL, idempotencyKey: STR },
        ['bankAccountId', 'afterStatementId', 'beforeStatementId', 'reason', 'idempotencyKey'],
      ),
      (ctx, input) => confirmStatementGap(ctx, as(input)),
    ),
    ctxAction(
      'revoke_statement_gap_confirmation',
      'write:reversible:human-only',
      'Withdraw the confirmation that a statement gap holds nothing (A36 §4.7, D150), so the gap is an attention item again. Human only (confirmed=true, a reason; an agent seat is refused human_only). Appends a withdrawal row beside the confirmation, which stays; a gap that is not confirmed answers notConfirmed without a row, and a gap filled since answers gap_not_found. Changes no statement, posts nothing. Idempotent per key.',
      ctxSchema(
        { bankAccountId: STR, afterStatementId: STR, beforeStatementId: STR, reason: STR, confirmed: BOOL, idempotencyKey: STR },
        ['bankAccountId', 'afterStatementId', 'beforeStatementId', 'reason', 'idempotencyKey'],
      ),
      (ctx, input) => revokeStatementGapConfirmation(ctx, as(input)),
    ),
  ];
}
