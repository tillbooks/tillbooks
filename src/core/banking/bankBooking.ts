/**
 * A39, the decisions on a bank line (spec §4.3 and §4.4): book it, ignore it, undo it.
 *
 * PATTERN P3 IN FULL. Nothing here posts on its own: an `accounts` booking is ONE A02 `postEntry`, an
 * `open_item` settlement ONE A14 `recordPayment`, a generated batch A18's `markBatchPaid`, an undo A02's
 * `reverseOwnedEntry` or A14's `reversePayment`. What this module owns is the DECISION (the link and its
 * decision row, written through `bankLines.ts`), never the money.
 *
 * NO DATE OVERRIDE (spec L5). A line books on its booking date and its booking is reversed on the date of
 * what it reverses; A03's `period_locked` passes through unchanged (`reopen_month` lifts a soft lock, a
 * sealed period waits for period reopen). Matching, ignoring and reopening a matched or ignored line
 * post nothing and work in any period.
 *
 * ONE STATE, CHECKED BEFORE ANY WRITE. A decision is only taken on an `open` line; a second decision on
 * a decided line refuses `line_not_open` naming the state and the link (`staleProposal: true`), never an
 * `ok` that echoes someone else's decision (walk B14.3: an approved stale Vorschlag reported executed).
 * A same-key replay is answered from the memo before that check, so a retry is still free.
 *
 * NEVER MEMOISE A REFUSAL. `rememberIdempotent` stores whatever its compute returns, so every refusal
 * found inside the transaction is THROWN as a `BankAbort` and unwrapped outside it (the A14/A21 idiom):
 * nothing commits, nothing replays, and a transient refusal (a locked period) stays retryable.
 *
 * MONEY KEYS. An entry's key is MINTED (the A20/A11 rule: a key derived from the line alone could be
 * squatted by a `post_entry` call and would then replay someone else's entry); a payment's key is
 * DERIVED from the line and its decision generation, because A14's per-workspace key uniqueness turns
 * a squat into a refusal, never into wrong money (the A21 precedent). The line-state guard is what
 * stops a second booking under a fresh key.
 *
 * §H-TENANT on every query; the workspace-scoped readers answer `not_found` for another tenant's id.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { requireString, optionalText } from '../ledger/inputGuards.js';
import { postEntry } from '../ledger/postEntry.js';
import type { LineInput } from '../ledger/postEntry.js';
import { reverseOwnedEntry } from '../ledger/reverseEntry.js';
import { recordPayment, reversePayment, PAYMENT_INTENTS, settledMinor, writeOffThresholdOf } from '../payments/payment.js';
import { resolveRole, isRejection } from '../payments/accounts.js';
import { computeLineTax, buildVatLines, mirrorVatLine, vatIntentRules } from '../vat/applyVat.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { settledOnVendorBill } from '../purchase/reads.js';
import { invoiceSettlementFigures, planInvoiceSettlement } from './qrMatch.js';
import { markBatchPaid, liveBatchOfBill } from './pain001.js';
import {
  BankAbort,
  BANK_LINE_IGNORE_REASONS,
  BANK_LINE_REMAINDER_MODES,
  BOOK_BANK_LINE_TARGET_KINDS,
  HAS_REVERSAL_SQL,
  bankLegsOf,
  reversalOf,
  controlAccountRoleOf,
  claimedLegs,
  lineBookingDate,
  lineGeneration,
  lineStateOf,
  readBankTxn,
  readBankTxnDetail,
  signedAmountOf,
  supersedeActiveLink,
  writeLineLink,
} from './bankLines.js';
import type {
  ActiveLink,
  BankLineIgnoreReason,
  BankLineLeg,
  BankLineRemainderMode,
  BankLineState,
  BankTxnRow,
  BookBankLineTarget,
} from './bankLines.js';

// --- Internals -----------------------------------------------------------------------------------

/** Abort the memoised write with a structured cause: nothing commits, nothing replays (one class, in bankLines). */
export { BankAbort };

/** Run a memoised write that may throw `BankAbort`; the abort's refusal is returned, never memoised. */
export function runBankGuarded<T extends Result>(body: () => T): T | Err {
  return runGuarded(body);
}

function runGuarded<T extends Result>(body: () => T): T | Err {
  try {
    return body();
  } catch (e) {
    if (e instanceof BankAbort) return e.result;
    throw e;
  }
}

function abort(result: Err): never {
  throw new BankAbort(result);
}

const MAX_TEXT = 500;
const MAX_LEGS = 20;

function bankLedgerOf(
  ctx: WorkspaceContext,
  bankAccountId: string,
): { ledgerAccountId: string; archived: boolean; currency: string } | undefined {
  const row = ctx.store.db
    .prepare('SELECT ledger_account_id, archived, currency FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, bankAccountId) as { ledger_account_id: string; archived: number; currency: string } | undefined;
  return row === undefined ? undefined : { ledgerAccountId: row.ledger_account_id, archived: row.archived === 1, currency: row.currency };
}

/** A decided line's refusal, naming what decided it (walk B14.3). */
function lineNotOpen(row: BankTxnRow, state: BankLineState, link: ActiveLink | null): Err {
  return err('line_not_open', {
    bankTxnId: row.id,
    state,
    linkId: link?.linkId ?? null,
    targetKind: link?.targetKind ?? null,
    entryId: link?.entryId ?? null,
    paymentId: link?.paymentId ?? null,
    staleProposal: true,
    reason: 'this line is already decided; reopen_bank_line undoes the decision first',
  });
}

// --- The target, validated -----------------------------------------------------------------------

function validateTarget(raw: unknown): { target: BookBankLineTarget } | { error: Err } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: err('invalid_input', { field: 'target' }) };
  }
  const t = raw as Record<string, unknown>;
  const kind = t['kind'];
  if (typeof kind !== 'string' || !(BOOK_BANK_LINE_TARGET_KINDS as readonly string[]).includes(kind)) {
    return { error: err('invalid_input', { field: 'target.kind', allowed: [...BOOK_BANK_LINE_TARGET_KINDS] }) };
  }
  if (kind === 'open_item') {
    const g = requireString(t['documentId'], 'target.documentId');
    if (g) return { error: g };
    const remainder = t['remainder'];
    if (remainder !== undefined && !(BANK_LINE_REMAINDER_MODES as readonly unknown[]).includes(remainder)) {
      return { error: err('invalid_input', { field: 'target.remainder', allowed: [...BANK_LINE_REMAINDER_MODES] }) };
    }
    const w = t['writeOffAccountId'];
    if (w !== undefined && (typeof w !== 'string' || w.length === 0)) return { error: err('invalid_input', { field: 'target.writeOffAccountId' }) };
    return {
      target: {
        kind: 'open_item',
        documentId: t['documentId'] as string,
        ...(remainder !== undefined ? { remainder: remainder as BankLineRemainderMode } : {}),
        ...(w !== undefined ? { writeOffAccountId: w as string } : {}),
      },
    };
  }
  if (kind === 'payment_batch') {
    const g = requireString(t['batchId'], 'target.batchId');
    if (g) return { error: g };
    return { target: { kind: 'payment_batch', batchId: t['batchId'] as string } };
  }
  if (kind === 'existing_entry') {
    const g = requireString(t['entryId'], 'target.entryId') ?? optionalText(t['differenceReason'], 'target.differenceReason');
    if (g) return { error: g };
    const a = t['acceptDifference'];
    if (a !== undefined && typeof a !== 'boolean') return { error: err('invalid_input', { field: 'target.acceptDifference' }) };
    const reason = typeof t['differenceReason'] === 'string' ? (t['differenceReason'] as string).trim() : '';
    // Critic A39-12 (owner decision): accepting a difference is a stated judgment, so it carries its
    // reason, recorded on the decision; the amount stays unbounded (the owner wants the flexibility).
    if (a === true && reason.length === 0) {
      return { error: err('invalid_input', { field: 'target.differenceReason', reason: 'state why the difference is accepted' }) };
    }
    if (reason.length > MAX_TEXT) return { error: err('invalid_input', { field: 'target.differenceReason', maxLength: MAX_TEXT }) };
    return {
      target: {
        kind: 'existing_entry',
        entryId: t['entryId'] as string,
        ...(a === true ? { acceptDifference: true, differenceReason: reason } : {}),
      },
    };
  }
  const legsRaw = t['legs'];
  if (!Array.isArray(legsRaw) || legsRaw.length === 0 || legsRaw.length > MAX_LEGS) {
    return { error: err('invalid_input', { field: 'target.legs', reason: `one to ${MAX_LEGS} legs` }) };
  }
  const legs: BankLineLeg[] = [];
  for (let i = 0; i < legsRaw.length; i += 1) {
    const l = legsRaw[i] as Record<string, unknown> | null;
    if (typeof l !== 'object' || l === null || Array.isArray(l)) return { error: err('invalid_input', { field: `target.legs[${i}]` }) };
    const g =
      requireString(l['accountId'], `target.legs[${i}].accountId`) ??
      optionalText(l['taxCode'], `target.legs[${i}].taxCode`) ??
      optionalText(l['description'], `target.legs[${i}].description`);
    if (g) return { error: g };
    const amount = l['amountMinor'];
    if (!Number.isSafeInteger(amount) || amount === 0) {
      return { error: err('invalid_input', { field: `target.legs[${i}].amountMinor`, reason: 'a non-zero amount in Rappen' }) };
    }
    const taxCode = typeof l['taxCode'] === 'string' && l['taxCode'].length > 0 && l['taxCode'] !== 'none' ? (l['taxCode'] as string) : undefined;
    legs.push({
      accountId: l['accountId'] as string,
      amountMinor: amount as number,
      ...(taxCode !== undefined ? { taxCode } : {}),
      ...(typeof l['description'] === 'string' ? { description: l['description'] as string } : {}),
    });
  }
  return { target: { kind: 'accounts', legs } };
}

// --- book_bank_line --------------------------------------------------------------------------------

export interface BookBankLineInput {
  bankTxnId?: string;
  target?: unknown;
  text?: string;
  /** Refused when present (spec L5): a line books on its own booking date. */
  date?: unknown;
  idempotencyKey?: string;
}

export type BankLineRemainder = {
  kind: 'none' | 'open' | 'written_off' | 'on_account';
  amountMinor: number;
  documentOpenMinor: number | null;
  feeOpenMinor: number | null;
};

export type BookBankLineOk = {
  bankTxnId: string;
  state: 'booked' | 'matched';
  targetKind: BookBankLineTarget['kind'];
  linkId: string;
  entryId: string | null;
  paymentId: string | null;
  /** Every payment the decision created or matched (one, or a batch's items). */
  paymentIds: string[];
  remainder: BankLineRemainder | null;
  /** Line minus entry leg, when an existing entry was matched with `acceptDifference`. */
  differenceMinor: number | null;
  /** Stable codes a surface may render: `reversal_line`, `accepted_difference`, `control_account_leg`. */
  warnings: string[];
};

/**
 * Book one bank line (spec §4.3). Credits and debits the same way; the target decides what happens.
 * Capabilities: `post` always, and `pay` too for a settlement (`open_item`, `payment_batch`), the gate
 * the A24 declaration keys on the same input (spec §0.1 D-A39.4).
 */
export function bookBankLine(ctx: WorkspaceContext, input: BookBankLineInput): Result<BookBankLineOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.bankTxnId, 'bankTxnId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalText(input.text, 'text');
  if (guard) return guard;
  if (input.date !== undefined) return noDateOverride();
  if (typeof input.text === 'string' && input.text.length > MAX_TEXT) {
    return err('invalid_input', { field: 'text', maxLength: MAX_TEXT });
  }
  const validated = validateTarget(input.target);
  if ('error' in validated) return validated.error;
  const target = validated.target;
  if (target.kind === 'open_item' || target.kind === 'payment_batch') {
    const pays = ctx.capabilities.assert('pay');
    if (!pays.ok) return pays;
  }

  const scopedKey = JSON.stringify(['book_bank_line', input.bankTxnId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<BookBankLineOk>>(ctx.workspaceId, scopedKey, 'book_bank_line');
  if (replayed !== undefined) return replayed;

  const row = readBankTxn(ctx, input.bankTxnId as string);
  if (row === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
  const current = lineStateOf(ctx, row);
  if (current.state !== 'open') return lineNotOpen(row, current.state, current.link);

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'book_bank_line', () =>
      performBooking(ctx, row, target, { text: input.text }),
    ),
  );
}

/**
 * The booking itself, INSIDE the caller's transaction, throwing `BankAbort` on any refusal. Shared by
 * `book_bank_line` and the A20 wrappers (`confirm_match`, `create_entry_for_txn`), which memoise under
 * their own verb names.
 */
export function performBooking(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  target: BookBankLineTarget,
  opts: { text?: string | undefined },
): Result<BookBankLineOk> {
  const current = lineStateOf(ctx, row);
  if (current.state !== 'open') abort(lineNotOpen(row, current.state, current.link));
  const bank = bankLedgerOf(ctx, row.bank_account_id);
  if (bank === undefined) abort(err('needs_bank_account', { bankAccountId: row.bank_account_id }));
  // A line in ANOTHER currency than its Bankkonto (a EUR movement reported on a CHF account) cannot be
  // posted onto that account's ledger account: the conversion the bank applied is not a fact these
  // books hold (§H-FX, A20 note 9). A line in the account's own foreign currency posts at the stored
  // rate. Matching an existing entry compares currencies leg by leg instead.
  if (row.currency !== bank.currency && (target.kind === 'accounts' || target.kind === 'open_item')) {
    abort(err('currency_mismatch', { bankTxnId: row.id, lineCurrency: row.currency, accountCurrency: bank.currency }));
  }
  const warnings = row.reversal_ind === 1 ? ['reversal_line'] : [];
  switch (target.kind) {
    case 'open_item':
      return bookOpenItem(ctx, row, bank.ledgerAccountId, target, opts, warnings);
    case 'payment_batch':
      return bookPaymentBatch(ctx, row, bank.ledgerAccountId, target.batchId, warnings);
    case 'existing_entry':
      return matchExistingEntry(ctx, row, bank.ledgerAccountId, target.entryId, target.acceptDifference === true ? (target.differenceReason ?? '') : null, warnings);
    case 'accounts':
      return bookToAccounts(ctx, row, bank.ledgerAccountId, target.legs, opts, warnings);
  }
}

/** The A21 queue row of a credit follows its line: `applied` on a settlement, `dismissed` otherwise. */
function syncCreditRow(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  status: 'applied' | 'dismissed' | 'open',
  patch: { invoiceId?: string | null; paymentId?: string | null; appliedMode?: string | null; reversedPaymentId?: string | null } = {},
): void {
  if (row.credit_id === null) return;
  const credit = ctx.store.db
    .prepare('SELECT status, reversed_payment_ids FROM reconciliation_match WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, row.credit_id) as { status: string; reversed_payment_ids: string } | undefined;
  if (credit === undefined) return;
  let reversed: string[] = [];
  try {
    const parsed = JSON.parse(credit.reversed_payment_ids) as unknown;
    reversed = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    reversed = [];
  }
  if (patch.reversedPaymentId != null && !reversed.includes(patch.reversedPaymentId)) reversed.push(patch.reversedPaymentId);
  const now = ctx.clock.now();
  ctx.store.db
    .prepare(
      `UPDATE reconciliation_match
          SET status = ?, invoice_id = COALESCE(?, invoice_id), payment_id = ?, applied_mode = ?,
              reversed_payment_ids = ?, decided_by = ?, decided_at = ?
        WHERE workspace_id = ? AND id = ?`,
    )
    .run(
      status,
      patch.invoiceId ?? null,
      status === 'applied' ? (patch.paymentId ?? null) : null,
      status === 'applied' ? (patch.appliedMode ?? 'partial') : null,
      JSON.stringify(reversed),
      ctx.actor,
      now,
      ctx.workspaceId,
      row.credit_id,
    );
}

function bookOpenItem(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  bankLedgerId: string,
  target: Extract<BookBankLineTarget, { kind: 'open_item' }>,
  opts: { text?: string | undefined },
  warnings: string[],
): Result<BookBankLineOk> {
  // Critic A39-5, spec L5: a settlement is dated like every other booking of the line, on its booking date.
  void opts;
  const date = lineBookingDate(row);
  const mode = target.remainder;
  if (target.writeOffAccountId !== undefined) {
    // A14 has ONE write-off path, to its role account 3805 (receivable losses); a second account would
    // need a second posting path, which P3 forbids. Naming that account is accepted, any other refuses.
    const role = resolveRole(ctx, 'writeOff');
    const roleId = isRejection(role) ? null : role.id;
    if (roleId === null || roleId !== target.writeOffAccountId) {
      abort(err('unsupported', { field: 'target.writeOffAccountId', reason: 'write_off_books_to_the_a14_role_account', accountId: roleId }));
    }
  }
  const generation = lineGeneration(ctx, row.id);

  if (row.credit_debit === 'CRDT') {
    const fig = invoiceSettlementFigures(ctx, target.documentId, date);
    if (fig === undefined) {
      const isBill = ctx.store.db.prepare('SELECT 1 AS p FROM vendor_bill WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, target.documentId);
      abort(isBill !== undefined
        ? err('wrong_direction', { bankTxnId: row.id, creditDebit: row.credit_debit, reason: 'money arriving settles an invoice, not a vendor bill' })
        : err('not_found', { documentId: target.documentId }));
    }
    if (fig.currency !== row.currency) {
      abort(err('currency_mismatch', { bankTxnId: row.id, lineCurrency: row.currency, documentCurrency: fig.currency }));
    }
    const principal = fig.principalMinor;
    if (principal <= 0 && fig.feesOpenMinor <= 0) abort(err('already_paid', { documentId: fig.documentId, status: fig.status }));
    const dueMinor = principal + fig.feesOpenMinor;
    const surplus = row.amount_minor > dueMinor;
    if (surplus && mode === 'write_off') {
      abort(err('invalid_input', { field: 'target.remainder', reason: 'a surplus parks as a Guthaben (on_account); only a shortfall can be written off' }));
    }
    if (!surplus && row.amount_minor < dueMinor && mode === 'on_account') {
      abort(err('invalid_input', { field: 'target.remainder', reason: 'a shortfall stays open or is written off; on_account is for a surplus' }));
    }
    const plan = planInvoiceSettlement(fig, row.amount_minor, mode === 'write_off');
    if (plan.allocations.length === 0) abort(err('already_paid', { documentId: fig.documentId, status: fig.status }));
    // Critic A39-6: `write_off` is a ONE-CLICK forgiveness, bounded by the same A14 threshold every other
    // one-click path consults (A21's apply `full`, F3). Above it the receivable loss is typed deliberately
    // through record_payment's writeOffMinor, never derived from a remainder word.
    if (plan.writeOffMinor > 0) {
      const thresholdMinor = writeOffThresholdOf(ctx);
      if (plan.writeOffMinor > thresholdMinor) {
        abort(err('write_off_above_threshold', {
          bankTxnId: row.id,
          documentId: fig.documentId,
          writeOffMinor: plan.writeOffMinor,
          thresholdMinor,
          reason: 'leave the rest open (remainder leave_open), or record the settlement through record_payment stating the write-off deliberately',
        }));
      }
    }
    const paid = recordPayment(ctx, {
      direction: 'incoming',
      date,
      amountMinor: row.amount_minor,
      currency: row.currency,
      bankAccountId: bankLedgerId,
      ...(fig.contactId !== null ? { counterpartyKind: 'customer', counterpartyId: fig.contactId } : {}),
      ...(row.reference_value !== null ? { reference: row.reference_value } : {}),
      allocations: plan.allocations,
      source: 'camt',
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: `bankline-${row.id}-g${generation}`,
    });
    if (!paid.ok) abort(paid);
    const paymentId = paid['paymentId'] as string;
    const entryId = typeof paid['entryId'] === 'string' ? (paid['entryId'] as string) : null;
    const remainder: BankLineRemainder =
      plan.surplusMinor > 0
        ? { kind: 'on_account', amountMinor: plan.surplusMinor, documentOpenMinor: plan.documentOpenAfterMinor, feeOpenMinor: plan.feeOpenAfterMinor }
        : plan.writeOffMinor > 0
          ? { kind: 'written_off', amountMinor: plan.writeOffMinor, documentOpenMinor: plan.documentOpenAfterMinor, feeOpenMinor: plan.feeOpenAfterMinor }
          : plan.shortfallMinor > 0
            ? { kind: 'open', amountMinor: plan.shortfallMinor, documentOpenMinor: plan.documentOpenAfterMinor, feeOpenMinor: plan.feeOpenAfterMinor }
            : { kind: 'none', amountMinor: 0, documentOpenMinor: 0, feeOpenMinor: 0 };
    const linkId = writeLineLink(ctx, {
      bankTxnId: row.id,
      kind: 'payment',
      targetId: paymentId,
      state: 'booked',
      targetKind: 'open_item',
      paymentId,
      entryId,
      remainderMode: remainder.kind === 'none' ? null : remainder.kind === 'written_off' ? 'write_off' : remainder.kind === 'on_account' ? 'on_account' : 'leave_open',
      remainderMinor: remainder.amountMinor,
      claims: bankLegsOf(ctx, bankLedgerId, [entryId]).map((l) => l.lineId),
    });
    syncCreditRow(ctx, row, 'applied', { invoiceId: fig.documentId, paymentId, appliedMode: plan.writeOffMinor > 0 ? 'full' : 'partial' });
    ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: 'book', actor: ctx.actor, at: ctx.clock.now() });
    return ok<BookBankLineOk>({
      bankTxnId: row.id,
      state: 'booked',
      targetKind: 'open_item',
      linkId,
      entryId,
      paymentId,
      paymentIds: [paymentId],
      remainder,
      differenceMinor: null,
      warnings,
    });
  }

  // A DEBIT settles a posted vendor bill (A17), never an invoice.
  const bill = ctx.store.db
    .prepare('SELECT id, status, contact_id, currency, payable_minor FROM vendor_bill WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, target.documentId) as
    | { id: string; status: string; contact_id: string; currency: string; payable_minor: number }
    | undefined;
  if (bill === undefined) {
    const isDoc = ctx.store.db.prepare('SELECT 1 AS p FROM document WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, target.documentId);
    abort(isDoc !== undefined
      ? err('wrong_direction', { bankTxnId: row.id, creditDebit: row.credit_debit, reason: 'money leaving settles a vendor bill, not an invoice' })
      : err('not_found', { documentId: target.documentId }));
  }
  if (bill.status !== 'posted') abort(err('not_settleable', { documentId: bill.id, status: bill.status }));
  // Spec §4.3 (lean critic C8): a bill in a live A18 run is paid by that run. Settling it here too would
  // make the run's `markBatchPaid` abort later (or its pain.001 pay it twice): book the run's line
  // through `payment_batch`, or discard the run first.
  const liveRun = liveBatchOfBill(ctx, bill.id);
  if (liveRun !== null) abort(err('already_batched', { vendorBillId: bill.id, batchId: liveRun }));
  if (bill.currency !== row.currency) {
    abort(err('currency_mismatch', { bankTxnId: row.id, lineCurrency: row.currency, documentCurrency: bill.currency }));
  }
  const openMinor = bill.payable_minor - settledOnVendorBill(ctx, bill.id);
  if (openMinor <= 0) abort(err('already_paid', { documentId: bill.id }));
  if (mode === 'write_off') {
    abort(err('unsupported', { field: 'target.remainder', reason: 'write_off_only_on_incoming_invoice_payments' }));
  }
  const allocMinor = Math.min(row.amount_minor, openMinor);
  const surplusMinor = row.amount_minor - allocMinor;
  if (surplusMinor === 0 && row.amount_minor < openMinor && mode === 'on_account') {
    abort(err('invalid_input', { field: 'target.remainder', reason: 'a shortfall stays open; on_account is for a surplus' }));
  }
  const paid = recordPayment(ctx, {
    direction: 'outgoing',
    date,
    amountMinor: row.amount_minor,
    currency: row.currency,
    bankAccountId: bankLedgerId,
    counterpartyKind: 'supplier',
    counterpartyId: bill.contact_id,
    ...(row.reference_value !== null ? { reference: row.reference_value } : {}),
    allocations: [{ vendorBillId: bill.id, amountMinor: allocMinor }],
    source: 'camt',
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: `bankline-${row.id}-g${generation}`,
  });
  if (!paid.ok) abort(paid);
  const paymentId = paid['paymentId'] as string;
  const entryId = typeof paid['entryId'] === 'string' ? (paid['entryId'] as string) : null;
  const billOpenAfter = openMinor - allocMinor;
  const remainder: BankLineRemainder =
    surplusMinor > 0
      ? { kind: 'on_account', amountMinor: surplusMinor, documentOpenMinor: 0, feeOpenMinor: null }
      : billOpenAfter > 0
        ? { kind: 'open', amountMinor: billOpenAfter, documentOpenMinor: billOpenAfter, feeOpenMinor: null }
        : { kind: 'none', amountMinor: 0, documentOpenMinor: 0, feeOpenMinor: null };
  const linkId = writeLineLink(ctx, {
    bankTxnId: row.id,
    kind: 'payment',
    targetId: paymentId,
    state: 'booked',
    targetKind: 'open_item',
    paymentId,
    entryId,
    remainderMode: remainder.kind === 'none' ? null : remainder.kind === 'on_account' ? 'on_account' : 'leave_open',
    remainderMinor: remainder.amountMinor,
    claims: bankLegsOf(ctx, bankLedgerId, [entryId]).map((l) => l.lineId),
  });
  ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: 'book', actor: ctx.actor, at: ctx.clock.now() });
  return ok<BookBankLineOk>({
    bankTxnId: row.id,
    state: 'booked',
    targetKind: 'open_item',
    linkId,
    entryId,
    paymentId,
    paymentIds: [paymentId],
    remainder,
    differenceMinor: null,
    warnings,
  });
}

/**
 * `payment_batch` (spec §4.3, L6): a debit of the run's own Bankkonto in the run's currency. A line equal to
 * the run total accounts for every item payment; otherwise its EndToEndId must name one item of the run
 * (the value A18 froze on `payment_batch_item.end_to_end_id` and sent, never derived from the item id,
 * which a restore re-mints: A18 F9) with that item's amount, and it accounts for that item's
 * payment only (camt.053 "mit Details von Sammelaufträgen" books one line per payment). A `generated` run
 * is first marked paid by A18's `markBatchPaid`, dated the line's booking date, and the line reads
 * `booked`; a `paid` run is matched and posts nothing. Either way the decision is written here, through
 * the one link writer: `markBatchPaid` writes no link.
 */
function bookPaymentBatch(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  bankLedgerId: string,
  batchId: string,
  warnings: string[],
): Result<BookBankLineOk> {
  if (row.credit_debit !== 'DBIT') {
    abort(err('wrong_direction', { bankTxnId: row.id, creditDebit: row.credit_debit, reason: 'a payment run is funded by an outgoing bank debit' }));
  }
  const batch = ctx.store.db
    .prepare('SELECT id, status, bank_account_id, ctrl_sum_minor FROM payment_batch WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, batchId) as { id: string; status: string; bank_account_id: string; ctrl_sum_minor: number | null } | undefined;
  if (batch === undefined) abort(err('not_found', { batchId }));
  if (batch.bank_account_id !== row.bank_account_id) {
    abort(err('wrong_bank_account', { batchId: batch.id, batchBankAccountId: batch.bank_account_id, lineBankAccountId: row.bank_account_id }));
  }
  if (batch.status === 'draft') abort(err('needs_generation', { batchId: batch.id }));
  if (batch.status === 'discarded') abort(err('batch_discarded', { batchId: batch.id }));
  const readItems = () =>
    ctx.store.db
      .prepare(
        `SELECT i.id AS id, i.amount_minor AS amountMinor, i.currency AS currency, i.posted_payment_id AS paymentId,
                i.end_to_end_id AS endToEndId, p.status AS paymentStatus, p.journal_entry_id AS entryId
           FROM payment_batch_item i LEFT JOIN payment p ON p.workspace_id = i.workspace_id AND p.id = i.posted_payment_id
          WHERE i.workspace_id = ? AND i.batch_id = ? ORDER BY i.seq, i.rowid`,
      )
      .all(ctx.workspaceId, batch.id) as {
      id: string;
      amountMinor: number;
      currency: string;
      paymentId: string | null;
      endToEndId: string | null;
      paymentStatus: string | null;
      entryId: string | null;
    }[];
  const items = readItems();
  const batchCurrency = items[0]?.currency ?? row.currency;
  if (batchCurrency !== row.currency) {
    // Spec L6 (lean critic C9, parked): a run in another currency than its line (EUR payments from a CHF
    // account) is never booked here; the fix names the parked path.
    abort(err('currency_mismatch', {
      bankTxnId: row.id,
      batchId: batch.id,
      lineCurrency: row.currency,
      batchCurrency,
      fix: 'mark the run paid in /creditor-payments, ignore this line as booked_elsewhere, and book the exchange difference by hand',
    }));
  }
  const total = batch.ctrl_sum_minor ?? items.reduce((sum, i) => sum + i.amountMinor, 0);
  let chosenIds: string[];
  if (row.amount_minor === total) {
    chosenIds = items.map((i) => i.id);
  } else {
    const e2e = readBankTxnDetail(ctx, row.id)?.end_to_end_id ?? null;
    const item = e2e === null ? undefined : items.find((i) => i.endToEndId === e2e);
    if (item === undefined) {
      abort(err('amount_mismatch', {
        bankTxnId: row.id,
        batchId: batch.id,
        batchStatus: batch.status,
        lineAmountMinor: row.amount_minor,
        batchTotalMinor: total,
        reason: 'the line is neither the run total nor one of its payments named by EndToEndId',
      }));
    }
    if (item.amountMinor !== row.amount_minor) {
      abort(err('amount_mismatch', { bankTxnId: row.id, batchId: batch.id, batchStatus: batch.status, itemId: item.id, lineAmountMinor: row.amount_minor, itemAmountMinor: item.amountMinor }));
    }
    chosenIds = [item.id];
  }

  let state: 'booked' | 'matched' = 'matched';
  if (batch.status === 'generated') {
    // A18 books ONE payment per item of the run, dated the line's booking date; it writes no link.
    // K1: the key is derivable from the line and its generation, and `mark_batch_paid` is public, so the
    // run is marked paid in this composite's own idempotency scope: a `mark_batch_paid` made first under
    // the same key (at a value date of its own) can no longer be replayed as this line's booking.
    const paid = ctx.store.innerWrite('book_bank_line', () =>
      markBatchPaid(ctx, {
        batchId: batch.id,
        confirmation: true,
        valueDate: lineBookingDate(row),
        idempotencyKey: `bankline-${row.id}-g${lineGeneration(ctx, row.id)}`,
      }),
    );
    if (!paid.ok) abort(paid as Err);
    state = 'booked';
  }
  const chosen = readItems().filter((i) => chosenIds.includes(i.id));
  if (chosen.some((i) => i.paymentId === null || i.paymentStatus !== 'posted')) {
    abort(err('batch_payments_not_posted', { batchId: batch.id, reason: 'a payment of this run was reversed or never posted; settle the rest by hand' }));
  }
  // Critic A39-2: the run's payments are claimed LEG by leg, so a payment already matched to another line
  // takes it off the table: no leg backs two lines.
  const legs = bankLegsOf(ctx, bankLedgerId, chosen.map((i) => i.entryId));
  const claimed = claimedLegs(ctx);
  const taken = legs.find((l) => claimed.lineIds.has(l.lineId));
  if (taken !== undefined) {
    abort(err('batch_already_linked', { batchId: batch.id, entryId: taken.entryId, bankTxnId: claimed.holderOf.get(taken.lineId) ?? null }));
  }
  const linkId = writeLineLink(ctx, {
    bankTxnId: row.id,
    kind: 'payment_batch',
    targetId: batch.id,
    state,
    targetKind: 'payment_batch',
    claims: legs.map((l) => l.lineId),
  });
  ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: state === 'booked' ? 'book' : 'confirm', actor: ctx.actor, at: ctx.clock.now() });
  return ok<BookBankLineOk>({
    bankTxnId: row.id,
    state,
    targetKind: 'payment_batch',
    linkId,
    entryId: null,
    paymentId: null,
    paymentIds: chosen.map((i) => i.paymentId as string),
    remainder: null,
    differenceMinor: null,
    warnings,
  });
}

/**
 * Critic M6 (lean): an own-account transfer whose sides the banks book in DIFFERENT months cannot be one
 * entry. Matching side two to the entry side one booked would put this account's movement in side one's
 * month, a difference the period's bank reconciliation (G22) can never clear, since neither side can be
 * re-dated (L5). Refused by name: take side one back and book each side on its own day through a transit
 * account. Same-month transfers match as before; the split-date booking itself is parked (spec §10).
 */
function refuseTransferAcrossMonths(ctx: WorkspaceContext, row: BankTxnRow, bankLedgerId: string, entry: { id: string; date: string }): void {
  const lineDate = lineBookingDate(row);
  if (entry.date.slice(0, 7) === lineDate.slice(0, 7)) return;
  const other = ctx.store.db
    .prepare(
      `SELECT ba.id AS bankAccountId FROM journal_line jl
         JOIN bank_account ba ON ba.workspace_id = ? AND ba.ledger_account_id = jl.account_id
        WHERE jl.entry_id = ? AND jl.account_id <> ? LIMIT 1`,
    )
    .get(ctx.workspaceId, entry.id, bankLedgerId) as { bankAccountId: string } | undefined;
  if (other === undefined) return;
  const holder = ctx.store.db
    .prepare('SELECT bank_txn_id AS t FROM bank_line_claim WHERE workspace_id = ? AND entry_id = ? AND released_at IS NULL ORDER BY rowid LIMIT 1')
    .get(ctx.workspaceId, entry.id) as { t: string } | undefined;
  abort(err('transfer_crosses_period', {
    bankTxnId: row.id,
    entryId: entry.id,
    entryDate: entry.date,
    lineDate,
    otherBankAccountId: other.bankAccountId,
    otherBankTxnId: holder?.t ?? null,
    reason: 'the other side of this transfer is booked in another month; reopen it and book each side on its own day through a transit account',
  }));
}

function matchExistingEntry(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  bankLedgerId: string,
  entryId: string,
  /** The stated reason when a difference is accepted, else null (critic A39-12). */
  acceptDifference: string | null,
  warnings: string[],
): Result<BookBankLineOk> {
  const entry = ctx.store.db
    .prepare('SELECT id, date, status, reverses_entry_id FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, entryId) as { id: string; date: string; status: string; reverses_entry_id: string | null } | undefined;
  if (entry === undefined || entry.status !== 'posted') abort(err('not_found', { entryId }));
  if (entry.reverses_entry_id !== null) abort(err('entry_is_reversal', { entryId, reversesEntryId: entry.reverses_entry_id }));
  const reversal = reversalOf(ctx, entryId);
  if (reversal !== null) abort(err('entry_reversed', { entryId, reversalEntryId: reversal }));
  refuseTransferAcrossMonths(ctx, row, bankLedgerId, entry);

  // THE GUARD (walk B9.3): the entry must book THIS account with THIS signed amount, and its leg must
  // not already back another line. Before A39 any posted entry linked, of any amount, on any account,
  // including one already closing a second line, and the line read "Zugeordnet" while the ledger
  // missed the movement.
  const legs = ctx.store.db
    .prepare(
      `SELECT id, debit_minor - credit_minor AS signed, currency FROM journal_line
        WHERE entry_id = ? AND account_id = ? ORDER BY rowid`,
    )
    .all(entryId, bankLedgerId) as { id: string; signed: number; currency: string }[];
  if (legs.length === 0) abort(err('entry_not_on_bank_account', { entryId, ledgerAccountId: bankLedgerId }));
  const claimed = claimedLegs(ctx);
  const free = legs.filter((l) => !claimed.lineIds.has(l.id));
  if (free.length === 0) {
    abort(err('entry_already_linked', { entryId, bankTxnId: claimed.holderOf.get(legs[0]!.id) ?? null }));
  }
  const signed = signedAmountOf(row);
  // Critic A39-12 (owner decision): a difference may be accepted in AMOUNT, never in DIRECTION. Money in
  // matches a debit of the bank account, money out a credit; the other side is a different movement.
  const sameDirection = free.filter((l) => l.currency === row.currency && Math.sign(l.signed) === Math.sign(signed));
  if (sameDirection.length === 0) {
    abort(err('direction_mismatch', {
      bankTxnId: row.id,
      entryId,
      lineAmountMinor: signed,
      entryAmountMinor: free[0]!.signed,
      lineCurrency: row.currency,
      entryCurrency: free[0]!.currency,
      reason: 'the entry moves the bank account the other way; it is not this line',
    }));
  }
  // Critic A39R2-8: WHICH legs the line accounts for. One leg carrying exactly the line's amount is that
  // line's (an entry recording two bank movements backs two lines, each on its own leg, walk B9.3);
  // otherwise the line accounts for EVERY free leg of the entry on this account, and their sum must be
  // the line's amount or go through an accepted difference. A leg left unclaimed while the line holds the
  // rest would show as a difference the bank does not have (probe q8 (ii)).
  const exact = sameDirection.find((l) => l.signed === signed);
  const chosen = exact !== undefined ? [exact] : sameDirection;
  const total = chosen.reduce((sum, l) => sum + l.signed, 0);
  let differenceMinor: number | null = null;
  if (total !== signed) {
    if (acceptDifference === null) {
      abort(err('amount_mismatch', {
        bankTxnId: row.id,
        entryId,
        lineAmountMinor: signed,
        entryAmountMinor: total,
        lineCurrency: row.currency,
        entryCurrency: chosen[0]!.currency,
        reason: 'the entry does not book this movement on the bank account; pass acceptDifference: true with a differenceReason to link it anyway, recorded',
      }));
    }
    differenceMinor = signed - total;
    warnings.push('accepted_difference');
  }
  const leg = chosen[0]!;
  const acceptedReason = differenceMinor !== null ? acceptDifference : null;
  const linkId = writeLineLink(ctx, {
    bankTxnId: row.id,
    kind: 'journal_entry',
    targetId: entryId,
    state: 'matched',
    targetKind: 'existing_entry',
    entryId,
    journalLineId: leg.id,
    acceptDifference: differenceMinor !== null,
    differenceMinor,
    note: acceptedReason,
    claims: chosen.map((l) => l.id),
  });
  syncCreditRow(ctx, row, 'dismissed');
  ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: 'confirm', actor: ctx.actor, at: ctx.clock.now() });
  return ok<BookBankLineOk>({
    bankTxnId: row.id,
    state: 'matched',
    targetKind: 'existing_entry',
    linkId,
    entryId,
    paymentId: null,
    paymentIds: [],
    remainder: null,
    differenceMinor,
    warnings,
  });
}

/**
 * The balanced line set of an `accounts` booking, built leg by leg with A06's `buildVatLines`, exactly
 * as a manual journal line is (spec §4.3): the bank legs are merged into one, and A02's post-boundary
 * VAT gate re-verifies every trace when the entry posts. Exported for the preview a surface shows.
 */
export function buildAccountsLines(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  bankLedgerId: string,
  legs: readonly BankLineLeg[],
  supplyDate: string,
): { lines: LineInput[] } | { error: Err } {
  const sum = legs.reduce((s, l) => s + l.amountMinor, 0);
  if (sum !== row.amount_minor) {
    return { error: err('legs_do_not_sum', { bankTxnId: row.id, expectedMinor: row.amount_minor, sumMinor: sum }) };
  }
  const base = baseCurrencyOf(ctx);
  const moneyIn = row.credit_debit === 'CRDT';
  const out: LineInput[] = [];
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i]!;
    const account = ctx.store.db
      .prepare('SELECT id, archived FROM account WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, leg.accountId) as { id: string; archived: number } | undefined;
    if (account === undefined) return { error: err('not_found', { field: `target.legs[${i}].accountId`, accountId: leg.accountId }) };
    if (account.archived === 1) return { error: err('account_archived', { accountId: leg.accountId }) };
    if (account.id === bankLedgerId) {
      return { error: err('invalid_input', { field: `target.legs[${i}].accountId`, reason: 'a leg cannot book the line to its own bank account' }) };
    }
    const legIn = leg.amountMinor > 0 ? moneyIn : !moneyIn;
    const abs = Math.abs(leg.amountMinor);
    if (leg.taxCode === undefined) {
      out.push(legIn ? { account: leg.accountId, credit: abs } : { account: leg.accountId, debit: abs });
      out.push(legIn ? { account: bankLedgerId, debit: abs } : { account: bankLedgerId, credit: abs });
      continue;
    }
    if (row.currency !== base) {
      return {
        error: err('unsupported', {
          field: `target.legs[${i}].taxCode`,
          reason: 'vat_on_foreign_currency_bank_line',
          hint: 'post the foreign-currency VAT entry with post_entry, then match the line to it (existing_entry)',
        }),
      };
    }
    const probe = computeLineTax(ctx, { amountMinor: abs, amountIsGross: true, taxCode: leg.taxCode, supplyDate });
    if (!probe.ok) return { error: probe };
    const kind = probe['kind'] as string;
    if (kind === 'none') {
      out.push(legIn ? { account: leg.accountId, credit: abs } : { account: leg.accountId, debit: abs });
      out.push(legIn ? { account: bankLedgerId, debit: abs } : { account: bankLedgerId, credit: abs });
      continue;
    }
    // A06's kind rules, shared with `compose_entry` (D152 amendment): the natural direction (an output,
    // zero-rated or exempt code books money in), and the pricing (Bezugsteuer, Art. 45: the foreign
    // supplier charged no Swiss VAT, so the amount paid IS the base and the tax is owed on top; every
    // other kind is paid gross).
    const rules = vatIntentRules(kind);
    const naturalIn = rules.direction === 'output';
    let built: LineInput[];
    try {
      built = buildVatLines(ctx, {
        counterAccount: bankLedgerId,
        revenueOrExpenseAccount: leg.accountId,
        amountMinor: abs,
        amountIsGross: !rules.pricesOnBase,
        taxCode: leg.taxCode,
        direction: rules.direction,
        supplyDate,
      }) as LineInput[];
    } catch (e) {
      return { error: err('vat_lines_refused', { field: `target.legs[${i}].taxCode`, reason: e instanceof Error ? e.message : String(e) }) };
    }
    // A leg running against its code's natural direction (a refund on an input code, a customer refund
    // on an output code) is the SAME booking mirrored: the tax is reduced, never invented.
    out.push(...(legIn === naturalIn ? built : built.map(mirrorVatLine)));
  }
  // Merge every bank leg into one line: the entry names the bank movement once, with the line's amount.
  let bankNet = 0;
  const merged: LineInput[] = [];
  for (const l of out) {
    if (l.account === bankLedgerId && l.taxCode === undefined) {
      bankNet += (l.debit ?? 0) - (l.credit ?? 0);
      continue;
    }
    if ((l.debit ?? 0) === 0 && (l.credit ?? 0) === 0) continue;
    merged.push(l);
  }
  if (bankNet !== signedAmountOf(row)) {
    return { error: err('vat_split_mismatch', { bankTxnId: row.id, expectedMinor: signedAmountOf(row), bankLegMinor: bankNet }) };
  }
  merged.unshift(bankNet >= 0 ? { account: bankLedgerId, debit: bankNet } : { account: bankLedgerId, credit: -bankNet });
  return { lines: merged };
}

function bookToAccounts(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  bankLedgerId: string,
  legs: readonly BankLineLeg[],
  opts: { text?: string | undefined },
  warnings: string[],
): Result<BookBankLineOk> {
  const date = lineBookingDate(row);
  const built = buildAccountsLines(ctx, row, bankLedgerId, legs, lineBookingDate(row));
  if ('error' in built) abort(built.error);
  // Critic A39R2-2: an own-account transfer is booked ONCE. A leg onto another own Bankkonto's ledger while
  // an unclaimed leg with this line's signed amount already sits on THIS ledger, in a live entry that also
  // books that account, is the transfer the other side already booked: refuse and name it to match. This
  // is the engine's own guard, so booking every `sure` proposal of one inbox read cannot post it twice.
  const ownLedgers = new Map(
    (
      ctx.store.db
        .prepare('SELECT id, ledger_account_id FROM bank_account WHERE workspace_id = ? AND id <> ?')
        .all(ctx.workspaceId, row.bank_account_id) as { id: string; ledger_account_id: string }[]
    ).map((a) => [a.ledger_account_id, a.id]),
  );
  for (const leg of legs) {
    const otherBankAccountId = ownLedgers.get(leg.accountId);
    if (otherBankAccountId === undefined) continue;
    const booked = ctx.store.db
      .prepare(
        `SELECT jl.entry_id AS entryId FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
          WHERE e.workspace_id = ? AND e.status = 'posted' AND e.reverses_entry_id IS NULL AND jl.account_id = ?
            AND (jl.debit_minor - jl.credit_minor) = ? AND jl.currency = ?
            AND EXISTS (SELECT 1 FROM journal_line o WHERE o.entry_id = e.id AND o.account_id = ?)
            AND NOT EXISTS (SELECT 1 FROM bank_line_claim c WHERE c.workspace_id = e.workspace_id AND c.journal_line_id = jl.id AND c.released_at IS NULL)
            AND NOT ${HAS_REVERSAL_SQL('e.id', 'e.workspace_id')}
          ORDER BY jl.rowid LIMIT 1`,
      )
      .get(ctx.workspaceId, bankLedgerId, signedAmountOf(row), row.currency, leg.accountId) as { entryId: string } | undefined;
    if (booked !== undefined) {
      abort(err('transfer_already_booked', {
        bankTxnId: row.id,
        entryId: booked.entryId,
        otherBankAccountId,
        reason: 'the other side already booked this transfer; match it with target existing_entry',
      }));
    }
  }
  // Critic A39-11 (owner decision): a hand-typed leg onto the Debitoren or Kreditoren control account is
  // allowed (a correction, an opening difference), but it moves a receivable or payable with no document,
  // so the answer says so; settling an open item is `open_item`.
  if (legs.some((l) => controlAccountRoleOf(ctx, l.accountId) !== null)) warnings.push('control_account_leg');
  const base = baseCurrencyOf(ctx);
  const detail = ctx.store.db
    .prepare('SELECT counterparty_name, remittance_text FROM bank_txn_detail WHERE workspace_id = ? AND bank_txn_id = ?')
    .get(ctx.workspaceId, row.id) as { counterparty_name: string | null; remittance_text: string | null } | undefined;
  const fallback = [detail?.counterparty_name ?? row.payer_name, detail?.remittance_text ?? row.entry_ref]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(', ');
  const description = (opts.text ?? (fallback.length > 0 ? `Bank: ${fallback}` : `Bankbuchung ${row.entry_ref ?? row.id}`)).slice(0, MAX_TEXT);
  const posted = postEntry(ctx, {
    date,
    source: 'camt',
    description,
    // MINTED, never derived from the line alone (the A20 rule against a squattable key).
    idempotencyKey: `bankline-entry-${row.id}-${ctx.ids.next('ble')}`,
    lines: built.lines,
    ...(row.currency !== base ? { currency: row.currency } : {}),
  });
  if (!posted.ok) abort(posted);
  const entryId = posted.entryId;
  // Critic A39-1: the booking claims its BANK leg only (the merged one), never the whole entry, so the
  // other side of an own-account transfer stays claimable by that account's line.
  const linkId = writeLineLink(ctx, {
    bankTxnId: row.id,
    kind: 'journal_entry',
    targetId: entryId,
    state: 'booked',
    targetKind: 'accounts',
    entryId,
    claims: bankLegsOf(ctx, bankLedgerId, [entryId]).map((l) => l.lineId),
  });
  syncCreditRow(ctx, row, 'dismissed');
  ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: 'book', actor: ctx.actor, at: ctx.clock.now() });
  return ok<BookBankLineOk>({
    bankTxnId: row.id,
    state: 'booked',
    targetKind: 'accounts',
    linkId,
    entryId,
    paymentId: null,
    paymentIds: [],
    remainder: null,
    differenceMinor: null,
    warnings,
  });
}

// --- ignore_bank_line -------------------------------------------------------------------------------

export interface IgnoreBankLineInput {
  bankTxnId?: string;
  reason?: string;
  note?: string;
  idempotencyKey?: string;
}

export type IgnoreBankLineOk = {
  bankTxnId: string;
  state: 'ignored';
  linkId: string | null;
  reason: string;
  alreadyIgnored: boolean;
};

/**
 * Ignore a line (owner answer 1): it leaves the inbox and every line count; the balance comparison
 * shows whether its money reached the books elsewhere. A credit's A21 row is dismissed with it (a
 * dismissed credit IS an ignored line). An already ignored line answers ok with `alreadyIgnored`;
 * `reopen_bank_line` brings it back.
 */
export function ignoreBankLine(ctx: WorkspaceContext, input: IgnoreBankLineInput): Result<IgnoreBankLineOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.bankTxnId, 'bankTxnId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    requireString(input.reason, 'reason') ??
    optionalText(input.note, 'note');
  if (guard) return guard;
  if (!(BANK_LINE_IGNORE_REASONS as readonly string[]).includes(input.reason as string)) {
    return err('invalid_input', { field: 'reason', allowed: [...BANK_LINE_IGNORE_REASONS] });
  }
  if (typeof input.note === 'string' && input.note.length > MAX_TEXT) return err('invalid_input', { field: 'note', maxLength: MAX_TEXT });
  const scopedKey = JSON.stringify(['ignore_bank_line', input.bankTxnId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<IgnoreBankLineOk>>(ctx.workspaceId, scopedKey, 'ignore_bank_line');
  if (replayed !== undefined) return replayed;
  const row = readBankTxn(ctx, input.bankTxnId as string);
  if (row === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
  const current = lineStateOf(ctx, row);
  if (current.state === 'ignored') {
    return ok<IgnoreBankLineOk>({
      bankTxnId: row.id,
      state: 'ignored',
      linkId: current.link?.linkId ?? null,
      reason: current.link?.ignoreReason ?? 'other',
      alreadyIgnored: true,
    });
  }
  if (current.state !== 'open') return lineNotOpen(row, current.state, current.link);
  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'ignore_bank_line', () => {
      const linkId = writeLineLink(ctx, {
        bankTxnId: row.id,
        kind: 'ignored',
        targetId: input.reason as string,
        state: 'ignored',
        targetKind: 'ignore',
        ignoreReason: input.reason as BankLineIgnoreReason,
        note: input.note ?? null,
      });
      syncCreditRow(ctx, row, 'dismissed');
      ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: 'discard', actor: ctx.actor, at: ctx.clock.now() });
      return ok<IgnoreBankLineOk>({ bankTxnId: row.id, state: 'ignored', linkId, reason: input.reason as string, alreadyIgnored: false });
    }),
  );
}

/** Retire the line's decision on record (superseded, never deleted; its claims released with it). */
function retireDecision(ctx: WorkspaceContext, row: BankTxnRow, reason: string): string | null {
  return supersedeActiveLink(ctx, row.id, reason)?.linkId ?? null;
}

/** Spec L5: the refusal for a `date` field the lean verbs no longer take. */
function noDateOverride(): Err {
  return err('invalid_input', {
    field: 'date',
    reason: 'a bank line books, and is reversed, on its own date; a locked month is reopened with reopen_month, a sealed period waits for period reopen',
  });
}

// --- reopen_bank_line -------------------------------------------------------------------------------

export interface ReopenBankLineInput {
  bankTxnId?: string;
  reason?: string;
  /** Refused when present (spec L5): a reversal is dated like what it reverses. */
  date?: unknown;
  idempotencyKey?: string;
}

export type ReopenBankLineOk = {
  bankTxnId: string;
  previousState: BankLineState;
  state: 'open';
  supersededLinkId: string | null;
  reversedEntryIds: string[];
  reversedPaymentIds: string[];
  /** Stable codes: `batch_payments_kept` (a run booked from the line keeps its payments). */
  warnings: string[];
  alreadyOpen: boolean;
};

/**
 * Undo a line decision without editing history (spec §4.4, L3, walk B11.2 and B14.5). In ONE transaction
 * the decision is superseded first (never deleted; its claims are released by the same stamp), then what
 * it CREATED is reversed through its owner: an `accounts` booking by `reverseOwnedEntry(...,
 * 'reopen_bank_line')`, an `open_item` settlement by A14's `reversePayment`, both on the original's date.
 * A reversal refusal rolls the supersession back with it: a transfer entry whose other bank leg the other
 * account's line still holds refuses `owned_by reopen_bank_line` naming that line (reopen side two, then
 * side one). A matched or an ignored line only has its decision superseded and posts nothing. A run
 * booked from the line keeps its payments (D-A39.3). The line is `open` again and a credit's A21 row
 * follows it.
 */
export function reopenBankLine(ctx: WorkspaceContext, input: ReopenBankLineInput): Result<ReopenBankLineOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.bankTxnId, 'bankTxnId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    requireString(input.reason, 'reason');
  if (guard) return guard;
  if (input.date !== undefined) return noDateOverride();
  if ((input.reason as string).length > MAX_TEXT) return err('invalid_input', { field: 'reason', maxLength: MAX_TEXT });
  const scopedKey = JSON.stringify(['reopen_bank_line', input.bankTxnId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<ReopenBankLineOk>>(ctx.workspaceId, scopedKey, 'reopen_bank_line');
  if (replayed !== undefined) return replayed;
  const row = readBankTxn(ctx, input.bankTxnId as string);
  if (row === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
  const current = lineStateOf(ctx, row);
  if (current.state === 'open' || current.link === null) {
    return ok<ReopenBankLineOk>({
      bankTxnId: row.id,
      previousState: 'open',
      state: 'open',
      supersededLinkId: null,
      reversedEntryIds: [],
      reversedPaymentIds: [],
      warnings: [],
      alreadyOpen: true,
    });
  }
  // Reversing a PAYMENT reopens settled open items: that is a settlement act, so it needs `pay`.
  const link = current.link;
  const reversesPayment = current.state === 'booked' && link.kind === 'payment' && link.paymentId !== null;
  if (reversesPayment) {
    const pays = ctx.capabilities.assert('pay');
    if (!pays.ok) return pays;
  }

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'reopen_bank_line', () => {
      // Critic M2 (lean): what to reverse is decided from the line AS THIS TRANSACTION MEETS IT. The read
      // above ran before the write lock; another window may have reopened (and rebooked) the line since.
      // A line already open again answers `alreadyOpen`; a line decided anew refuses `line_not_open`
      // naming its live decision, and nothing is superseded or reversed on the stale snapshot.
      const fresh = lineStateOf(ctx, row);
      if (fresh.state === 'open' || fresh.link === null) {
        return ok<ReopenBankLineOk>({
          bankTxnId: row.id,
          previousState: 'open',
          state: 'open',
          supersededLinkId: null,
          reversedEntryIds: [],
          reversedPaymentIds: [],
          warnings: [],
          alreadyOpen: true,
        });
      }
      if (fresh.link.linkId !== link.linkId) {
        abort(err('line_not_open', {
          bankTxnId: row.id,
          state: fresh.state,
          linkId: fresh.link.linkId,
          targetKind: fresh.link.targetKind,
          staleProposal: true,
          reason: 'the line was decided again since it was read; read it again and reopen that decision',
        }));
      }
      const reversedEntryIds: string[] = [];
      const reversedPaymentIds: string[] = [];
      const warnings: string[] = [];
      // L3: supersede FIRST, so the claims this decision holds are released before the reversal's
      // chokepoint looks for a live claim on the entry.
      const supersededLinkId = retireDecision(ctx, row, input.reason as string);
      let creditPaymentReversed: string | null = null;
      // What the decision CREATED is reversed, read off the DECISION's own declared references (never a
      // link's `target_id`, which a G04 restore does not remap, critic A39R2-1).
      if (current.state === 'booked') {
        if (link.kind === 'payment_batch') {
          warnings.push('batch_payments_kept');
        } else if (link.kind === 'payment' && link.paymentId !== null) {
          reverseOnePayment(ctx, row, link.paymentId);
          reversedPaymentIds.push(link.paymentId);
          creditPaymentReversed = link.paymentId;
        } else if (link.kind === 'journal_entry' && link.entryId !== null) {
          reverseOneEntry(ctx, row, link.entryId, input.reason as string);
          reversedEntryIds.push(link.entryId);
        }
      }
      syncCreditRow(ctx, row, 'open', { reversedPaymentId: creditPaymentReversed });
      ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: 'reopen', actor: ctx.actor, at: ctx.clock.now() });
      return ok<ReopenBankLineOk>({
        bankTxnId: row.id,
        previousState: current.state,
        state: 'open',
        supersededLinkId,
        reversedEntryIds,
        reversedPaymentIds,
        warnings,
        alreadyOpen: false,
      });
    }),
  );
}

/** Reverse the payment a line settled, on the payment's own date (A14). Aborts on any refusal. */
function reverseOnePayment(ctx: WorkspaceContext, row: BankTxnRow, paymentId: string): void {
  const payment = ctx.store.db
    .prepare('SELECT date FROM payment WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, paymentId) as { date: string } | undefined;
  if (payment === undefined) abort(err('not_found', { paymentId }));
  // K1: the key is derivable from the line and the payment, so the Storno runs in this composite's own
  // idempotency scope: a `reverse_payment` made first under the same key (at a date of its own) is no
  // longer replayed as this reopen's reversal; the payment is then already reversed and the reopen says so.
  const undone = ctx.store.innerWrite('reopen_bank_line', () =>
    reversePayment(ctx, {
      paymentId,
      date: payment.date,
      intent: PAYMENT_INTENTS.reverse,
      idempotencyKey: `bankline-reopen-${row.id}-${paymentId}`,
    }),
  );
  if (!undone.ok) abort(undone as Err);
}

/** Reverse the entry a line booked, on the entry's own date, as its owner. Aborts on any refusal. */
function reverseOneEntry(ctx: WorkspaceContext, row: BankTxnRow, entryId: string, reason: string): void {
  const entry = ctx.store.db
    .prepare('SELECT date FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, entryId) as { date: string } | undefined;
  if (entry === undefined) abort(err('not_found', { entryId }));
  const reversed = reverseOwnedEntry(
    ctx,
    {
      entryId,
      date: entry.date,
      description: `Storno Bankzeile: ${reason}`.slice(0, MAX_TEXT),
      idempotencyKey: `bankline-reopen-${row.id}-${ctx.ids.next('blr')}`,
    },
    'reopen_bank_line',
  );
  if (!reversed.ok) abort(reversed);
}

/** Exposed for the wrappers and the tests: the settled amount of a document (A14's own read). */
export function documentSettledMinor(ctx: WorkspaceContext, documentId: string): number {
  return settledMinor(ctx, 'document', documentId);
}
