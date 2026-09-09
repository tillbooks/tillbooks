/**
 * A18's eight verbs, defined here and spread into `ACTIONS` as ONE line (the `fxActions` / `purchaseActions`
 * precedent), so several agents appending to the append-only registry at once collide over a line rather
 * than a block.
 *
 * FIVE WRITES, THREE READS. `set_creditor_bank_profile` is not in A18's spec stack-landing list; it exists
 * because A17 captures no creditor IBAN (see the reconciliation note atop `core/banking/pain001.ts`).
 * `get_payment_batch`/`list_payment_batches` are likewise additions beyond the spec's four named tools:
 * the GUI needs a way to re-read a batch it already created (after a navigation, a reload, or before
 * offering Mark paid on a batch generated in an earlier session), and §6b's own saved-view worked
 * examples ("Batches awaiting bank confirmation") presuppose a list to filter.
 *
 * `generate_pain001` IS A WRITE, not the `R` its own spec table row suggests. It flips
 * `payment_batch.status` from `draft` to `generated`, a real state mutation, and §6b names it as an
 * ACCEPTED automation action, which only a registered WRITE verb can be (`core/automation/events.ts`:
 * "the legal set of actions IS the write half of ACTIONS"). Declaring it `read` would make it both
 * un-automatable (contradicting §6b) and unable to emit `payment_batch.generated` (emission fires only
 * for `kind === 'write'`, `src/api/registry.ts`).
 *
 * As with `purchase-actions.ts`, the helpers arrive as a parameter so the module graph stays acyclic:
 * `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  setCreditorBankProfile,
  listPayableOpenItems,
  createPaymentBatch,
  generatePain001,
  getPaymentBatch,
  listPaymentBatches,
  markBatchPaid,
  discardPaymentBatch,
} from '../core/banking/index.js';

export interface Pain001ActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The A18 verbs, in append order. */
export function pain001Actions(h: Pain001ActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;

  return [
    ctxAction(
      'set_creditor_bank_profile',
      'write',
      "Set (or correct) the IBAN a vendor is paid at. A17's vendor bill carries no IBAN of its own; this is where a creditor's bank details live so create_payment_batch can build a pain.001 instruction. Validates the IBAN (A19's validateIban) and derives whether it is a QR-IBAN, which decides whether the bill's own vendorReference must be a QRR (a QR-IBAN never accepts free-text remittance). This alters who a future payment reaches: it is on the automation denylist (D65 leg f), mirroring update_bank_account and set_creditor_profile.",
      ctxSchema({ vendorId: STR, iban: STR, idempotencyKey: STR }, ['vendorId', 'iban', 'idempotencyKey']),
      (ctx, input) => setCreditorBankProfile(ctx, as(input)),
    ),
    ctxAction(
      'list_payable',
      'read',
      "The bills a payment run could pick up: every posted A17 vendor bill still open, each flagged with whether its vendor has a creditor_bank_profile, whether that IBAN is a QR-IBAN, what reference kind the bill's own vendorReference classifies as (qrr/scor/free_text/none), whether the currency is one create_payment_batch admits (CHF/EUR), and whether the bill already sits in a live (not yet paid) batch. dueBy filters to bills due on or before a date; vendorId to one vendor.",
      ctxSchema({ dueBy: STR, vendorId: STR }),
      (ctx, input) => listPayableOpenItems(ctx, as(input)),
    ),
    ctxAction(
      'create_payment_batch',
      'write',
      'Draft a payment batch from open A17 bills: validates the debtor account (A19, must not be a QR-IBAN, which is receive-only), that every bill is posted and open, that every bill shares one currency (CHF or EUR; a mixed selection is refused with mixed_currency), that every vendor has a creditor_bank_profile, and that a QR-IBAN vendor has a valid QRR reference on the bill. Snapshots each item so a later generate_pain001 is byte-reproducible even if the vendor profile changes afterward. Posts nothing.',
      ctxSchema(
        { bankAccountId: STR, itemIds: { type: 'array', items: STR }, executionDate: STR, idempotencyKey: STR },
        ['bankAccountId', 'itemIds', 'executionDate', 'idempotencyKey'],
      ),
      (ctx, input) => createPaymentBatch(ctx, as(input)),
    ),
    ctxAction(
      'generate_pain001',
      'write',
      "Build (or rebuild) the batch's pain.001.001.09 XML, validate it, and flip the batch from draft to generated on first success; regenerating an already-generated batch reproduces byte-identical output (nothing about it changes after creation). Only a valid file is ever returned. NEVER transmits: always answers transmitted:false, with reason 'use_payment_batch_transmit' when an A33 EBICS channel routes the batch's debtor account (transmit is A33's payment_batch_transmit, P8-gated) or 'no_channel' otherwise (the file-download path is then the floor).",
      ctxSchema({ batchId: STR, idempotencyKey: STR }, ['batchId', 'idempotencyKey']),
      (ctx, input) => generatePain001(ctx, as(input)),
    ),
    ctxAction(
      'get_payment_batch',
      'read',
      'Read one payment batch in full: its debtor account, execution date, status, control sum and every item with its vendor, amount, full and masked creditor IBAN (the destination a pre-upload review verifies) and settlement.',
      ctxSchema({ batchId: STR }, ['batchId']),
      (ctx, input) => getPaymentBatch(ctx, as(input)),
    ),
    ctxAction(
      'list_payment_batches',
      'read',
      "The payment-run history, newest first: every batch with its status, control sum and item count. status filters the lifecycle (draft/generated/paid). savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here (e.g. 'Batches awaiting bank confirmation' as status=generated, 'Paid this quarter' as status=paid with a date range on the client).",
      ctxSchema({ status: STR, savedViewId: STR }),
      (ctx, input) => listPaymentBatches(ctx, as(input)),
    ),
    ctxAction(
      'mark_batch_paid',
      'write',
      "Confirm the bank executed a generated batch: posts one outgoing payment per item through A14's recordPayment (debit 2000 Kreditoren / credit the debtor bank account), each settling its own vendor bill, atomically for the whole batch. Requires confirmation:true, because marking paid must reflect a genuine bank confirmation, never a side effect. Idempotent per batch: a re-confirm under the same key replays the same result and never double-pays.",
      ctxSchema(
        { batchId: STR, confirmation: BOOL, valueDate: STR, idempotencyKey: STR, bankTxnId: STR },
        ['batchId', 'confirmation', 'valueDate', 'idempotencyKey'],
      ),
      (ctx, input) => markBatchPaid(ctx, as(input)),
    ),
    ctxAction(
      'discard_payment_batch',
      'write',
      "Abandon a batch that must not be paid, moving it to the terminal 'discarded' status so its bills become payable again. A draft batch discards freely; a generated batch has already produced a pain.001 file, so discarding it requires confirmation:true. A paid batch cannot be discarded (already_paid) and a discarded one is already terminal (already_discarded). Deletes no row (append-only); this is the recovery path for a batch drafted against a mistyped IBAN or one whose generate step failed, without it the only forward move was to book a payment that was never made. Posts nothing.",
      ctxSchema({ batchId: STR, confirmation: BOOL, idempotencyKey: STR }, ['batchId', 'idempotencyKey']),
      (ctx, input) => discardPaymentBatch(ctx, as(input)),
    ),
  ];
}
