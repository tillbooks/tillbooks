/**
 * A17's seven verbs, defined here and spread into `ACTIONS` as ONE line (the `fxActions` /
 * `itemActions` precedent), so several agents appending to the append-only registry at once collide
 * over a line rather than a block.
 *
 * FIVE WRITES AND TWO READS. Every write carries `idempotencyKey`, because every one of them MINTS or
 * MOVES something: a bill, a posting, a receipt reference, a reversal. None of them belongs in the
 * conformance gate's key-exemption list, which is reserved for absolute state-setting writes where a
 * replay re-asserts the same state.
 *
 * THERE IS NO PAY VERB HERE, and its absence is the design. A bill is settled by A14's
 * `record_payment` / `allocate_payment` with `vendorBillId` on the allocation, exactly as an invoice
 * is settled with `documentId`. A `mark_vendor_bill_paid` would be a second settlement path to keep in
 * sync with A14's, and A17 §6b fixes that it does not exist.
 *
 * As with `fx-actions.ts` and `item-actions.ts`, the helpers arrive as a parameter rather than an
 * import, so the module graph stays acyclic: `registry.ts` imports this file and this file must not
 * import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  createVendorBill,
  recordExpense,
  prevalidateRecordExpense,
  postVendorBill,
  attachReceipt,
  voidVendorBill,
  listVendorBills,
  getVendorBill,
} from '../core/purchase/index.js';
import { withAttach } from '../core/files/index.js';
import { attachable } from './chat-belege-actions.js';
import type { ActionKind } from './actionKind.js';
// N01 US-N01.1: the expense account takes an id or its number, resolved at the registry input boundary.
import { ACCOUNT_REF } from './input-boundary.js';

export interface PurchaseActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  /** D158 / N01 US-N01.3: attach the verb's pure pre-draft validation (`ActionDef.prevalidate`). */
  withPrevalidate(def: ActionDef, check: (ctx: WorkspaceContext, input: ActionInput) => Result | undefined): ActionDef;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The fields the two capture verbs share, so the one-shot and the draft cannot drift apart. */
function captureFields(h: PurchaseActionHelpers): Record<string, unknown> {
  const { STR, INT, BOOL } = h;
  return {
    vendorId: STR,
    billDate: STR,
    dueDate: STR,
    supplyDate: STR,
    vendorReference: STR,
    currency: STR,
    amountMinor: INT,
    amountIsGross: BOOL,
    taxCode: STR,
    expenseAccountId: ACCOUNT_REF,
    costCenterId: STR,
    projectId: STR,
    receiptRef: STR,
    fxRate: STR,
    idempotencyKey: STR,
    // N02 (D183): the receipts to link to the vendor bill in the same transaction.
    attach: { type: 'array' },
    // N02 R1: a PERSON books a receipt that already evidences a live booking (an agent: human_only).
    bookAgain: BOOL,
    overrideReason: STR,
  };
}

/** N02: the vendor bill an A17 act created, for the attach seam. */
function billOf(r: Result): string | null {
  return r.ok && typeof r.vendorBillId === 'string' ? r.vendorBillId : null;
}

const CAPTURE_REQUIRED = ['vendorId', 'billDate', 'amountMinor', 'expenseAccountId', 'idempotencyKey'];

/** The A17 verbs, in append order. */
export function purchaseActions(h: PurchaseActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, withPrevalidate, STR } = h;
  const capture = captureFields(h);

  return [
    attachable(ctxAction(
      'create_vendor_bill',
      'write:correctable:internal',
      'Erfasse eine Kreditorenrechnung als Entwurf (a draft vendor bill: no posting, no ledger effect). amountMinor is integer Rappen and is the GROSS on the paper bill unless amountIsGross is false; taxCode is an input-side code (VST-M, VST-I, BEZUG, IMPORT) or absent for a vendor that charges no MWST. projectId tags the purchase to a B00 project for the B03 Projekterfolg (a reporting dimension like costCenterId: it prices nothing and appears on no journal leg). This is the agent path (P8): draft first, then post_vendor_bill as a separate, deliberate step. attach: [{fileId} | {sourcePath}] links each receipt to the bill in the same transaction (sourcePath: a PDF or image under files.source_roots, local TILL only; a receipt that already evidences a live booking refuses receipt_already_booked naming the holders unless a person passes bookAgain with an overrideReason, files.duplicate_beleg; an agent call is proposed instead); with attach the call is governed by the stricter of its own dial and files_link\'s.',
      ctxSchema(capture, CAPTURE_REQUIRED),
      (ctx, input, deps) => withAttach(ctx, deps.localFiles, 'create_vendor_bill', input, () => createVendorBill(ctx, as(input)), billOf),
    ), 'create_vendor_bill'),
    // N01 US-N01.3 (D158): a governed seat's expense is screened like a direct call BEFORE it is drafted
    // (`prevalidateRecordExpense`: the capture checks, the rate, and the posting through A02's preview), so
    // an expense the verb would refuse is refused at once and never queued as a Vorschlag.
    attachable(withPrevalidate(ctxAction(
      'record_expense',
      'write:correctable:books',
      'Capture AND post a supplier bill or expense in one step (the human default): the same input as create_vendor_bill, composed with post_vendor_bill in ONE transaction, so a refused posting leaves no draft behind. Posts the expense or asset net plus 1170/1171 Vorsteuer against 2000 Kreditoren gross, stamping the §H-VAT-TRACE the MWST-Abrechnung reads. Under the Saldo method (MWSTG Art. 37) nothing is separately reclaimed and the expense books gross: the result says so with vorsteuerDeductible:false. expenseAccountId takes the account id or its number (6500). An agent seat whose expense is drafted is refused at draft time with exactly the refusals a direct call gets. attach: [{fileId} | {sourcePath}] links each receipt to the bill in the same transaction, exactly as on create_vendor_bill.',
      ctxSchema(capture, CAPTURE_REQUIRED),
      (ctx, input, deps) => withAttach(ctx, deps.localFiles, 'record_expense', input, () => recordExpense(ctx, as(input)), billOf),
    ), (ctx, input) => prevalidateRecordExpense(ctx, as(input))), 'record_expense'),
    ctxAction(
      'post_vendor_bill',
      'write:correctable:books',
      'Post an existing draft bill to the ledger (bucht die Kreditorenrechnung). The figures are recomputed from the stored input at the supply date, so a draft that sat across a rate change or a VAT-method change books what is correct now rather than what a stale preview cached. Refuses already_posted with the entry the bill already carries, and period_locked when the bill date falls in a locked period.',
      ctxSchema({ vendorBillId: STR, idempotencyKey: STR }, ['vendorBillId', 'idempotencyKey']),
      (ctx, input) => postVendorBill(ctx, as(input)),
    ),
    ctxAction(
      'attach_receipt',
      'write:correctable:books',
      'Record which Beleg belongs to a bill (OR 958f: the receipt is kept for ten years, and this is what says WHICH one). A reference, not a file: file storage is E00 and A17 stores the pointer. Permitted on a posted bill, because a Buchungsbeleg is filed after the booking at least as often as before it; it is the only column a posted bill will let you change.',
      ctxSchema({ vendorBillId: STR, receiptRef: STR, idempotencyKey: STR, bookAgain: { type: 'boolean' }, overrideReason: { type: 'string' } }, [
        'vendorBillId',
        'receiptRef',
        'idempotencyKey',
      ]),
      (ctx, input) => attachReceipt(ctx, as(input)),
    ),
    ctxAction(
      'void_vendor_bill',
      'write:correctable:books',
      'Storniere eine Kreditorenrechnung: posts the faithful reversing entry (OR 957a) and flips the bill to void. Never deletes and never edits the original. A DRAFT is simply retired (nothing was booked, so nothing is reversed). A bill with any payment against it is refused with already_settled: reverse the payment first, or 2000 Kreditoren silently carries the difference.',
      ctxSchema({ vendorBillId: STR, reason: STR, date: STR, idempotencyKey: STR }, [
        'vendorBillId',
        'idempotencyKey',
      ]),
      (ctx, input) => voidVendorBill(ctx, as(input)),
    ),
    ctxAction(
      'list_vendor_bills',
      'read',
      'Die Kreditoren: every vendor bill with its open amount, due date, days overdue and aging bucket, plus the tie-back to account 2000. `reconciled` compares two independent derivations (the bills and their allocations against the posted balance of 2000), so a movement A17 does not model shows up as a stated difference rather than as a silently wrong total. status filters the lifecycle (draft/posted/void); settlementStatus filters the derived payment state (unpaid/partly_paid/paid). savedViewId applies a G00 saved view underneath the explicit filters.',
      ctxSchema({ status: STR, settlementStatus: STR, vendorId: STR, from: STR, to: STR, savedViewId: STR }),
      (ctx, input) => listVendorBills(ctx, as(input)),
    ),
    ctxAction(
      'get_vendor_bill',
      'read',
      'Read one vendor bill: its figures and stored input-VAT trace, the journal entry it posted (and the reversal when it has one), its derived settlement status and open amount, and every payment that touched it.',
      ctxSchema({ vendorBillId: STR }, ['vendorBillId']),
      (ctx, input) => getVendorBill(ctx, as(input)),
    ),
  ];
}
