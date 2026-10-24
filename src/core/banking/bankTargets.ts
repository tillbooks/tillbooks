/**
 * D178 E3 (A39 §17.1 to §17.3): the PLANS of the new bank-line booking targets, pure reads.
 *
 * A plan answers, for one open line and one target, everything a person or an agent needs before the
 * click: the contact and the mode a `contact` target books in, the documents and the deviation
 * ("Abweichung") of a several-document `open_item`, the claims of an `expense_claims` target, and the
 * refusal the booking would give. `bankBooking.ts` books FROM the same plan (the A14 payment input, the
 * entry lines), so what the preview says is what the booking does; it never re-derives a figure.
 *
 * Nothing here writes, posts or memoises. Every query binds `workspace_id` (§H-TENANT): another tenant's
 * contact, document or claim reads as `not_found`, exactly like an id that names nothing.
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Err } from '../result.js';
import type { LineInput } from '../ledger/postEntry.js';
import { PAYMENT_INTENTS, SETTLEABLE_STATUSES, writeOffThresholdOf } from '../payments/payment.js';
import type { AllocationInput, RecordPaymentInput } from '../payments/payment.js';
import { ROLE_ACCOUNT_NUMBER, resolveRole, isRejection } from '../payments/accounts.js';
import { resolveContactRef } from '../sales/contact.js';
import { settledOnVendorBill } from '../purchase/reads.js';
import { readClaimRow } from '../hr/reads.js';
import { claimPostingReversal } from '../hr/claims.js';
import { baseCurrencyOf, resolveFxRate } from '../fx/rates.js';
import { convertMinor } from '../fx/rateMath.js';
import { getSetting } from '../settings/settings.js';
import { invoiceSettlementFigures, planInvoiceSettlement } from './qrMatch.js';
import { liveBatchOfBill } from './pain001.js';
import { bankTargetRefusal, foreignCurrencySettlementRefusal } from './bankTargetCatalogue.js';
import { controlAccountRoleOf, lineBookingDate } from './bankLines.js';
import type {
  BankLineAllocation,
  BankLineRemainderMode,
  BankTxnRow,
  ContactBookingMode,
  ContactCounterpartyKind,
} from './bankLines.js';

/** At most this many documents or claims in one booking (a bound, not a business rule). */
export const MAX_TARGET_ITEMS = 50;

/** The longest override reason a decision's note carries. */
const MAX_REASON = 500;

/** A payment input as the booking hands it to A14, without the key (minted or derived by the booker). */
export type PlannedPayment = Omit<RecordPaymentInput, 'idempotencyKey'>;

// --- `contact` (A39 §17.1) --------------------------------------------------------------------------

export interface ContactPlan {
  contactId: string;
  contactName: string;
  counterpartyKind: ContactCounterpartyKind;
  /** The mode this booking uses, and the workspace setting it was compared to. */
  mode: ContactBookingMode;
  settingMode: ContactBookingMode;
  overridden: boolean;
  overrideReason: string | null;
  /** `guthaben`: the A14 payment (no allocation: the whole amount is the contact's Guthaben). */
  payment: PlannedPayment | null;
  /** `anzahlung`: the Anzahlungen account and the entry's lines (bank against it). */
  entry: {
    account: { id: string; number: string; name: string };
    /** The entry's lines: in the line's currency, or (fixed) the base-currency side against the conversion account. */
    lines: LineInput[];
    description: string;
    /**
     * Owner, 21.10.2026 (setting `bank.anzahlung_fx_mode` = `fixed`, the default): an Anzahlung received on a
     * Bankkonto in another currency is FIXED in the base currency at the receipt rate. It is a
     * non-monetary item, never revalued, so it is booked like the FX counter-leg: a conversion entry in the
     * line's currency (the bank against the realised-FX account) beside the base-currency entry `lines`
     * (that account against the Anzahlungen account). Null when the line is in the base currency or the
     * setting is `foreign` (held in the foreign currency, revalued like any foreign position).
     */
    conversion: { currency: string; rate: string; foreignMinor: number; baseMinor: number; conversionAccountId: string; lines: LineInput[] } | null;
  } | null;
}

/** The settings key of the Anzahlungen account a side books to. */
export function anzahlungSettingKey(kind: ContactCounterpartyKind): string {
  return kind === 'customer' ? 'bank.anzahlung_customer_account' : 'bank.anzahlung_supplier_account';
}

/** Accounts a prepayment never sits on: the VAT accounts (A05 posts them) and the settlement account. */
const NOT_A_PREPAYMENT_ACCOUNT: ReadonlySet<string> = new Set([
  ROLE_ACCOUNT_NUMBER.inputVat,
  ROLE_ACCOUNT_NUMBER.inputVatInvestment,
  ROLE_ACCOUNT_NUMBER.outputVat,
  '2201',
]);

/**
 * The plan of a `contact` target on this line. Refuses `not_found`, `counterparty_merged`,
 * `contact_archived`, `reason_required`, `needs_anzahlung_account` and `invalid_anzahlung_account`.
 */
export function planContact(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  bankLedgerId: string,
  target: { contactId: string; counterpartyKind?: ContactCounterpartyKind; mode?: ContactBookingMode; overrideReason?: string },
): { plan: ContactPlan } | { error: Err } {
  const contact = ctx.store.db
    .prepare('SELECT id, name, party_role, archived, merged_into_id FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, target.contactId) as
    | { id: string; name: string; party_role: string; archived: number; merged_into_id: string | null }
    | undefined;
  if (contact === undefined) return { error: err('not_found', { field: 'target.contactId', contactId: target.contactId }) };
  if (contact.merged_into_id !== null) {
    return {
      error: bankTargetRefusal('counterparty_merged', {
        field: 'target.contactId',
        contactId: contact.id,
        survivorId: resolveContactRef(ctx, contact.id)?.id ?? contact.merged_into_id,
      }),
    };
  }
  if (contact.archived === 1) return { error: bankTargetRefusal('contact_archived', { field: 'target.contactId', contactId: contact.id }) };
  const moneyIn = row.credit_debit === 'CRDT';
  const counterpartyKind: ContactCounterpartyKind =
    target.counterpartyKind ?? (contact.party_role === 'vendor' ? 'supplier' : contact.party_role === 'customer' ? 'customer' : moneyIn ? 'customer' : 'supplier');

  const settingMode = getSetting<ContactBookingMode>(ctx, 'bank.contact_booking_mode');
  const mode = target.mode ?? settingMode;
  const overridden = target.mode !== undefined && target.mode !== settingMode;
  const reason = typeof target.overrideReason === 'string' ? target.overrideReason.trim() : '';
  if (overridden && reason.length === 0) {
    return { error: bankTargetRefusal('reason_required', { field: 'target.overrideReason', settingKey: 'bank.contact_booking_mode', settingMode, mode }) };
  }
  if (reason.length > MAX_REASON) return { error: err('invalid_input', { field: 'target.overrideReason', maxLength: MAX_REASON }) };

  const base = {
    contactId: contact.id,
    contactName: contact.name,
    counterpartyKind,
    mode,
    settingMode,
    overridden,
    overrideReason: overridden ? reason : null,
  };
  if (mode === 'guthaben') {
    // A14 books a payment in the base currency: a Guthaben from a Bankkonto in another currency would put
    // francs on that account's ledger. Refused by name; the Anzahlung books in the account's currency.
    if (row.currency !== baseCurrencyOf(ctx)) {
      return { error: foreignCurrencySettlementRefusal({ field: 'target.mode', bankTxnId: row.id, lineCurrency: row.currency, mode }) };
    }
    return {
      plan: {
        ...base,
        payment: {
          direction: moneyIn ? 'incoming' : 'outgoing',
          date: lineBookingDate(row),
          amountMinor: row.amount_minor,
          currency: row.currency,
          bankAccountId: bankLedgerId,
          counterpartyKind,
          counterpartyId: contact.id,
          ...(row.reference_value !== null ? { reference: row.reference_value } : {}),
          source: 'camt',
          intent: PAYMENT_INTENTS.record,
        },
        entry: null,
      },
    };
  }

  // `anzahlung`: the configured account, resolved by NUMBER in this workspace (a setting holds a number,
  // never an id: the default must mean the same account in every book).
  const settingKey = anzahlungSettingKey(counterpartyKind);
  const number = getSetting<string>(ctx, settingKey).trim();
  const account = ctx.store.db
    .prepare('SELECT id, number, name, type, archived FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number) as { id: string; number: string; name: string; type: string; archived: number } | undefined;
  if (number.length === 0 || account === undefined || account.archived === 1) {
    return {
      error: bankTargetRefusal('needs_anzahlung_account', {
        settingKey,
        accountNumber: number,
        reason: account === undefined ? 'missing' : 'archived',
      }),
    };
  }
  const wantedType = counterpartyKind === 'customer' ? 'liability' : 'asset';
  const isBankLedger =
    ctx.store.db.prepare('SELECT 1 AS p FROM bank_account WHERE workspace_id = ? AND ledger_account_id = ? LIMIT 1').get(ctx.workspaceId, account.id) !==
    undefined;
  if (account.type !== wantedType || isBankLedger || account.id === bankLedgerId || controlAccountRoleOf(ctx, account.id) !== null || NOT_A_PREPAYMENT_ACCOUNT.has(account.number)) {
    return {
      error: bankTargetRefusal('invalid_anzahlung_account', {
        settingKey,
        accountNumber: account.number,
        accountType: account.type,
        expectedType: wantedType,
      }),
    };
  }
  const amount = row.amount_minor;
  const label = counterpartyKind === 'customer' ? 'Anzahlung Kunde' : 'Anzahlung Lieferant';
  const accountView = { id: account.id, number: account.number, name: account.name };
  const description = `${label} ${contact.name}`;
  const bookCurrency = baseCurrencyOf(ctx);
  if (row.currency !== bookCurrency && getSetting<string>(ctx, 'bank.anzahlung_fx_mode') === 'fixed') {
    // Fixed in the base currency at the receipt rate (owner, 21.10.2026): the bank leg stays in the
    // account's currency (a real foreign position), the Anzahlung is a base-currency figure, and the
    // realised-FX account between them nets to zero.
    const resolved = resolveFxRate(ctx, { currency: row.currency, date: lineBookingDate(row) });
    if (!resolved.ok) return { error: resolved };
    const rate = resolved.resolved.rate;
    const baseMinor = convertMinor(amount, resolved.resolved.rateScaled);
    if (baseMinor <= 0) return { error: err('invalid_input', { field: 'target', reason: 'the line converts to nothing in the base currency' }) };
    const role = resolveRole(ctx, moneyIn ? 'salesFxRealised' : 'purchaseFxRealised');
    if (isRejection(role)) return { error: role as Err };
    const conversionLines: LineInput[] = moneyIn
      ? [
          { account: bankLedgerId, debit: amount },
          { account: role.id, credit: amount },
        ]
      : [
          { account: role.id, debit: amount },
          { account: bankLedgerId, credit: amount },
        ];
    const lines: LineInput[] = moneyIn
      ? [
          { account: role.id, debit: baseMinor },
          { account: account.id, credit: baseMinor },
        ]
      : [
          { account: account.id, debit: baseMinor },
          { account: role.id, credit: baseMinor },
        ];
    return {
      plan: {
        ...base,
        payment: null,
        entry: { account: accountView, lines, description, conversion: { currency: row.currency, rate, foreignMinor: amount, baseMinor, conversionAccountId: role.id, lines: conversionLines } },
      },
    };
  }
  const lines: LineInput[] = moneyIn
    ? [
        { account: bankLedgerId, debit: amount },
        { account: account.id, credit: amount },
      ]
    : [
        { account: account.id, debit: amount },
        { account: bankLedgerId, credit: amount },
      ];
  return { plan: { ...base, payment: null, entry: { account: accountView, lines, description, conversion: null } } };
}

// --- several documents per line (A39 §17.2) ---------------------------------------------------------

export interface AllocationDocView {
  documentId: string;
  kind: 'invoice' | 'vendor_bill';
  contactId: string | null;
  currency: string;
  /** What the document still asks: an invoice's open principal plus its live Mahngebühren; a bill's open amount. */
  openMinor: number;
  allocatedMinor: number;
  /** Written off on this document (an invoice, `remainder: write_off`). */
  writeOffMinor: number;
  /** What stays open on it after the booking. */
  openAfterMinor: number;
}

export type BankTargetRemainder = {
  kind: 'none' | 'open' | 'written_off' | 'on_account';
  amountMinor: number;
};

export interface AllocationPlan {
  documents: AllocationDocView[];
  contactId: string | null;
  /** Line amount minus the sum of the allocations: above 0 cash left over, below 0 over-allocated. */
  deviationMinor: number;
  remainder: BankTargetRemainder;
  /** What `remainder` may be NOW for this line and these allocations (empty while over-allocated). */
  remainderOptions: BankLineRemainderMode[];
  /** The A14 payment (every allocation in one), or null when the plan is refused. */
  payment: PlannedPayment | null;
  /** The refusal the booking would give, or null when it would book. */
  refusal: Err | null;
}

/**
 * The plan of `open_item { allocations[] }`. A shape or lookup failure is `{ error }` (nothing to show);
 * a domain refusal (the deviation, the threshold) still answers the documents and the deviation, with
 * `refusal` set, so a surface can say why Buchen is disabled beside the figures.
 */
export function planAllocations(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  bankLedgerId: string,
  target: { allocations: readonly BankLineAllocation[]; remainder?: BankLineRemainderMode },
): { plan: AllocationPlan } | { error: Err } {
  const moneyIn = row.credit_debit === 'CRDT';
  const date = lineBookingDate(row);
  const mode = target.remainder;
  const writeOff = mode === 'write_off';
  if (!moneyIn && writeOff) {
    return { error: err('unsupported', { field: 'target.remainder', reason: 'write_off_only_on_incoming_invoice_payments' }) };
  }
  // The one A14 payment books in the base currency (the Guthaben rule of `planContact`).
  if (row.currency !== baseCurrencyOf(ctx)) {
    return { error: foreignCurrencySettlementRefusal({ field: 'target.allocations', bankTxnId: row.id, lineCurrency: row.currency }) };
  }
  const docs: AllocationDocView[] = [];
  const paymentAllocations: AllocationInput[] = [];
  const seen = new Set<string>();
  let contactId: string | null | undefined;
  let writeOffMinor = 0;
  /** What `remainder: write_off` would forgive on these allocations (the option is offered within A14's threshold). */
  let writeOffIfChosenMinor = 0;
  for (let i = 0; i < target.allocations.length; i += 1) {
    const a = target.allocations[i]!;
    if (seen.has(a.documentId)) return { error: err('invalid_input', { field: `target.allocations[${i}].documentId`, reason: 'duplicate_document' }) };
    seen.add(a.documentId);
    let view: AllocationDocView;
    if (moneyIn) {
      const fig = invoiceSettlementFigures(ctx, a.documentId, date);
      if (fig === undefined) {
        const isBill = ctx.store.db.prepare('SELECT 1 AS p FROM vendor_bill WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, a.documentId);
        return {
          error:
            isBill !== undefined
              ? bankTargetRefusal('wrong_direction', { field: `target.allocations[${i}].documentId`, documentId: a.documentId, creditDebit: row.credit_debit })
              : err('not_found', { field: `target.allocations[${i}].documentId`, documentId: a.documentId }),
        };
      }
      if (fig.currency !== row.currency) {
        return { error: err('currency_mismatch', { bankTxnId: row.id, documentId: fig.documentId, lineCurrency: row.currency, documentCurrency: fig.currency }) };
      }
      const due = fig.principalMinor + fig.feesOpenMinor;
      if (!SETTLEABLE_STATUSES.has(fig.status) && fig.feesOpenMinor <= 0) {
        return { error: err(due <= 0 ? 'already_paid' : 'not_settleable', { documentId: fig.documentId, status: fig.status }) };
      }
      if (due <= 0) return { error: err('already_paid', { documentId: fig.documentId, status: fig.status }) };
      if (a.amountMinor > due) {
        return { error: bankTargetRefusal('allocation_exceeds_open', { field: `target.allocations[${i}].amountMinor`, documentId: fig.documentId, openMinor: due, allocatedMinor: a.amountMinor }) };
      }
      // The invoice's ONE settlement order (A39 D-A39.2): the document up to its A14 cap, then each live
      // Mahngebühr; `write_off` forgives the principal shortfall on this document only.
      const settle = planInvoiceSettlement(fig, a.amountMinor, writeOff);
      paymentAllocations.push(...settle.allocations);
      writeOffMinor += settle.writeOffMinor;
      writeOffIfChosenMinor += writeOff ? settle.writeOffMinor : planInvoiceSettlement(fig, a.amountMinor, true).writeOffMinor;
      view = {
        documentId: fig.documentId,
        kind: 'invoice',
        contactId: fig.contactId,
        currency: fig.currency,
        openMinor: due,
        allocatedMinor: a.amountMinor,
        writeOffMinor: settle.writeOffMinor,
        openAfterMinor: settle.shortfallMinor,
      };
    } else {
      const bill = ctx.store.db
        .prepare('SELECT id, status, contact_id, currency, payable_minor FROM vendor_bill WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, a.documentId) as { id: string; status: string; contact_id: string; currency: string; payable_minor: number } | undefined;
      if (bill === undefined) {
        const isDoc = ctx.store.db.prepare('SELECT 1 AS p FROM document WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, a.documentId);
        return {
          error:
            isDoc !== undefined
              ? bankTargetRefusal('wrong_direction', { field: `target.allocations[${i}].documentId`, documentId: a.documentId, creditDebit: row.credit_debit })
              : err('not_found', { field: `target.allocations[${i}].documentId`, documentId: a.documentId }),
        };
      }
      if (bill.status !== 'posted') return { error: err('not_settleable', { documentId: bill.id, status: bill.status }) };
      const liveRun = liveBatchOfBill(ctx, bill.id);
      if (liveRun !== null) return { error: err('already_batched', { vendorBillId: bill.id, batchId: liveRun }) };
      if (bill.currency !== row.currency) {
        return { error: err('currency_mismatch', { bankTxnId: row.id, documentId: bill.id, lineCurrency: row.currency, documentCurrency: bill.currency }) };
      }
      const open = bill.payable_minor - settledOnVendorBill(ctx, bill.id);
      if (open <= 0) return { error: err('already_paid', { documentId: bill.id }) };
      if (a.amountMinor > open) {
        return { error: bankTargetRefusal('allocation_exceeds_open', { field: `target.allocations[${i}].amountMinor`, documentId: bill.id, openMinor: open, allocatedMinor: a.amountMinor }) };
      }
      paymentAllocations.push({ vendorBillId: bill.id, amountMinor: a.amountMinor });
      view = {
        documentId: bill.id,
        kind: 'vendor_bill',
        contactId: bill.contact_id,
        currency: bill.currency,
        openMinor: open,
        allocatedMinor: a.amountMinor,
        writeOffMinor: 0,
        openAfterMinor: open - a.amountMinor,
      };
    }
    // ONE contact per booking (A14's X1 rule on the receivable side, and one payee on the payable side):
    // compared through C00's merge chain, so a document of a since-merged contact is the same party.
    const party = view.contactId === null ? null : (resolveContactRef(ctx, view.contactId)?.id ?? view.contactId);
    if (contactId === undefined) contactId = party;
    else if (contactId !== party) {
      return { error: bankTargetRefusal('allocation_contact_mismatch', { field: `target.allocations[${i}].documentId`, documentId: view.documentId, contactId: party, expectedContactId: contactId }) };
    }
    docs.push(view);
  }
  const allocated = docs.reduce((s, d) => s + d.allocatedMinor, 0);
  const deviationMinor = row.amount_minor - allocated;
  const shortfallMinor = docs.reduce((s, d) => s + d.openAfterMinor, 0);
  const threshold = writeOffThresholdOf(ctx);

  const remainderOptions: BankLineRemainderMode[] =
    deviationMinor > 0
      ? ['on_account']
      : deviationMinor < 0
        ? []
        : ['leave_open', ...(moneyIn && writeOffIfChosenMinor > 0 && writeOffIfChosenMinor <= threshold ? (['write_off'] as const) : [])];

  let refusal: Err | null = null;
  if (deviationMinor < 0) {
    refusal = bankTargetRefusal('allocations_exceed_line', { bankTxnId: row.id, lineAmountMinor: row.amount_minor, allocatedMinor: allocated, deviationMinor });
  } else if (deviationMinor > 0 && mode !== 'on_account') {
    refusal = bankTargetRefusal('deviation_needs_remainder', { bankTxnId: row.id, deviationMinor, remainderOptions });
  } else if (deviationMinor === 0 && mode === 'on_account') {
    refusal = err('invalid_input', { field: 'target.remainder', reason: 'nothing is left over for a Guthaben: on_account is for cash left over' });
  } else if (deviationMinor > 0 && (contactId === null || contactId === undefined)) {
    refusal = err('needs_counterparty', { bankTxnId: row.id, onAccountMinor: deviationMinor });
  } else if (writeOffMinor > threshold) {
    refusal = err('write_off_above_threshold', {
      bankTxnId: row.id,
      writeOffMinor,
      thresholdMinor: threshold,
      reason: 'leave the rest open (remainder leave_open), or record the settlement through record_payment stating the write-off deliberately',
    });
  }

  const remainder: BankTargetRemainder =
    deviationMinor > 0
      ? { kind: 'on_account', amountMinor: deviationMinor }
      : writeOffMinor > 0
        ? { kind: 'written_off', amountMinor: writeOffMinor }
        : shortfallMinor > 0
          ? { kind: 'open', amountMinor: shortfallMinor }
          : { kind: 'none', amountMinor: 0 };

  const payment: PlannedPayment | null =
    refusal !== null
      ? null
      : {
          direction: moneyIn ? 'incoming' : 'outgoing',
          date,
          amountMinor: row.amount_minor,
          currency: row.currency,
          bankAccountId: bankLedgerId,
          counterpartyKind: moneyIn ? 'customer' : 'supplier',
          ...(contactId !== null && contactId !== undefined ? { counterpartyId: contactId } : {}),
          ...(row.reference_value !== null ? { reference: row.reference_value } : {}),
          allocations: paymentAllocations,
          source: 'camt',
          intent: PAYMENT_INTENTS.record,
        };
  return { plan: { documents: docs, contactId: contactId ?? null, deviationMinor, remainder, remainderOptions, payment, refusal } };
}

// --- Spesen (A39 §17.3) --------------------------------------------------------------------------------

export interface ClaimView {
  claimId: string;
  title: string;
  employeeId: string;
  status: string;
  totalMinor: number;
}

export interface ClaimsPlan {
  claims: ClaimView[];
  totalMinor: number;
  /** Line amount minus the claims' total: Spesen book only at 0. */
  deviationMinor: number;
  refusal: Err | null;
}

/**
 * The plan of an `expense_claims` target: a DEBIT line in the base currency settling APPROVED claims whose
 * totals equal it. A shape or lookup failure is `{ error }`; a total that differs answers the claims with
 * `refusal` set (`amount_mismatch`), so the figures still show.
 */
export function planExpenseClaims(ctx: WorkspaceContext, row: BankTxnRow, claimIds: readonly string[]): { plan: ClaimsPlan } | { error: Err } {
  if (row.credit_debit !== 'DBIT') {
    return { error: bankTargetRefusal('wrong_direction', { bankTxnId: row.id, creditDebit: row.credit_debit, reason: 'an expense claim is reimbursed by money going out' }) };
  }
  const base = baseCurrencyOf(ctx);
  if (row.currency !== base) {
    return { error: err('currency_mismatch', { bankTxnId: row.id, lineCurrency: row.currency, claimCurrency: base, reason: 'claims are reimbursed in the base currency' }) };
  }
  const claims: ClaimView[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < claimIds.length; i += 1) {
    const id = claimIds[i]!;
    if (seen.has(id)) return { error: err('invalid_input', { field: `target.claimIds[${i}]`, reason: 'duplicate_claim' }) };
    seen.add(id);
    const claim = readClaimRow(ctx, id);
    if (claim === undefined) return { error: err('not_found', { field: `target.claimIds[${i}]`, claimId: id }) };
    if (claim.status !== 'approved') {
      return { error: bankTargetRefusal('claim_not_approved', { field: `target.claimIds[${i}]`, claimId: claim.id, status: claim.status }) };
    }
    const reversal = claimPostingReversal(ctx, claim);
    if (reversal !== null) {
      return {
        error: err('claim_posting_reversed', {
          claimId: claim.id,
          reversalEntryId: reversal,
          hint: "the claim's posting was reversed in the journal, so nothing is owed: close the claim with expense_claim_reverse",
        }),
      };
    }
    claims.push({ claimId: claim.id, title: claim.title, employeeId: claim.employee_id, status: claim.status, totalMinor: claim.total_base_minor ?? 0 });
  }
  const totalMinor = claims.reduce((s, c) => s + c.totalMinor, 0);
  const deviationMinor = row.amount_minor - totalMinor;
  const refusal =
    deviationMinor === 0
      ? null
      : bankTargetRefusal('amount_mismatch', { bankTxnId: row.id, lineAmountMinor: row.amount_minor, claimsTotalMinor: totalMinor, deviationMinor });
  return { plan: { claims, totalMinor, deviationMinor, refusal } };
}
