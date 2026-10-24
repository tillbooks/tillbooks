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
import { postEntry, previewPostingLines } from '../ledger/postEntry.js';
import type { LineInput } from '../ledger/postEntry.js';
import { reverseOwnedEntry } from '../ledger/reverseEntry.js';
import { recordPayment, reversePayment, PAYMENT_INTENTS, settledMinor, writeOffThresholdOf, openGuthabenOf, recordRefundNetting } from '../payments/payment.js';
import { resolveRole, isRejection } from '../payments/accounts.js';
import { computeLineTax, buildVatLines, mirrorVatLine, vatIntentRules } from '../vat/applyVat.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { RATE_MAX_SCALED, RATE_SCALE, formatRate, isCurrencyCode } from '../fx/rateMath.js';
import { reimburseClaim } from '../hr/claims.js';
import { MAX_TARGET_ITEMS, planAllocations, planContact, planExpenseClaims } from './bankTargets.js';
import type { AllocationDocView, BankTargetRemainder, ClaimView } from './bankTargets.js';
import { FX_COUNTER_LEG_CONSEQUENCE, bankTargetRefusal } from './bankTargetCatalogue.js';
import { anzahlungVatClearingsOf, anzahlungVatCorrectionsOfLink, clearAnzahlungVat, planAnzahlungVat, refundableVatGuthabenOf } from './anzahlungVat.js';
import { getSetting } from '../settings/settings.js';
import type { AnzahlungVatPlan } from './anzahlungVat.js';
import type { BankTargetConsequence } from './bankTargetCatalogue.js';
import { settledOnVendorBill } from '../purchase/reads.js';
import { invoiceSettlementFigures, planInvoiceSettlement } from './qrMatch.js';
import { markBatchPaid, liveBatchOfBill } from './pain001.js';
import { expandEntry } from '../ledger/compose.js';
import { pinFor } from '../agent/vorschlagPin.js';
import { appendDraftHistory } from '../agent/draftHistory.js';
import { DRAFT_SUPERSEDED_REASON } from '../agent/draftedActions.js';
import type { ComposeExpandOk } from '../ledger/compose.js';
import { counterpartyKeyOf } from './bankProposals.js';
import { directionOf, factorAmountMinor, invalidViaReason, readLiveRule, recipeOfRow, restLegIndex } from './bankStandards.js';
import {
  BankAbort,
  BANK_LINE_IGNORE_REASONS,
  BANK_LINE_REMAINDER_MODES,
  BOOK_BANK_LINE_TARGET_KINDS,
  CONTACT_BOOKING_MODES,
  CONTACT_COUNTERPARTY_KINDS,
  DRAFT_LINE_DECIDED_REASON,
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
import { duplicateDecisionPending } from './statementDedupe.js';
import type {
  ActiveLink,
  BankLineAllocation,
  BankLineIgnoreReason,
  BankLineLeg,
  BankLineLegFx,
  BankLineRemainderMode,
  BankLineState,
  BankTxnRow,
  BookableBankLineTarget,
  BookBankLineTarget,
  ContactBookingMode,
  ContactCounterpartyKind,
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
    const remainder = t['remainder'];
    if (remainder !== undefined && !(BANK_LINE_REMAINDER_MODES as readonly unknown[]).includes(remainder)) {
      return { error: err('invalid_input', { field: 'target.remainder', allowed: [...BANK_LINE_REMAINDER_MODES] }) };
    }
    const w = t['writeOffAccountId'];
    if (w !== undefined && (typeof w !== 'string' || w.length === 0)) return { error: err('invalid_input', { field: 'target.writeOffAccountId' }) };
    // D178 E3 (A39 §17.2): several documents, each with the cash applied to it, instead of one documentId.
    if (t['allocations'] !== undefined) {
      if (t['documentId'] !== undefined) {
        return { error: err('invalid_input', { field: 'target.allocations', reason: 'name documentId (one document) or allocations (several), not both' }) };
      }
      if (w !== undefined) return { error: err('invalid_input', { field: 'target.writeOffAccountId', reason: 'with allocations a write-off books to the A14 role account; leave it out' }) };
      const raw = t['allocations'];
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TARGET_ITEMS) {
        return { error: err('invalid_input', { field: 'target.allocations', reason: `one to ${MAX_TARGET_ITEMS} documents` }) };
      }
      const allocations: BankLineAllocation[] = [];
      for (let i = 0; i < raw.length; i += 1) {
        const a = raw[i] as Record<string, unknown> | null;
        if (typeof a !== 'object' || a === null || Array.isArray(a)) return { error: err('invalid_input', { field: `target.allocations[${i}]` }) };
        const g = requireString(a['documentId'], `target.allocations[${i}].documentId`);
        if (g) return { error: g };
        const amount = a['amountMinor'];
        if (!Number.isSafeInteger(amount) || (amount as number) <= 0) {
          return { error: err('invalid_input', { field: `target.allocations[${i}].amountMinor`, reason: 'a positive amount in Rappen' }) };
        }
        allocations.push({ documentId: a['documentId'] as string, amountMinor: amount as number });
      }
      return {
        target: {
          kind: 'open_item',
          allocations,
          ...(remainder !== undefined ? { remainder: remainder as BankLineRemainderMode } : {}),
        },
      };
    }
    const g = requireString(t['documentId'], 'target.documentId');
    if (g) return { error: g };
    return {
      target: {
        kind: 'open_item',
        documentId: t['documentId'] as string,
        ...(remainder !== undefined ? { remainder: remainder as BankLineRemainderMode } : {}),
        ...(w !== undefined ? { writeOffAccountId: w as string } : {}),
      },
    };
  }
  if (kind === 'contact') {
    // D178 E3 (A39 §17.1): a line booked to a contact with no document.
    const g =
      requireString(t['contactId'], 'target.contactId') ??
      (t['overrideReason'] !== undefined ? optionalText(t['overrideReason'], 'target.overrideReason') : null);
    if (g) return { error: g };
    const cpk = t['counterpartyKind'];
    if (cpk !== undefined && !(CONTACT_COUNTERPARTY_KINDS as readonly unknown[]).includes(cpk)) {
      return { error: err('invalid_input', { field: 'target.counterpartyKind', allowed: [...CONTACT_COUNTERPARTY_KINDS] }) };
    }
    const mode = t['mode'];
    if (mode !== undefined && !(CONTACT_BOOKING_MODES as readonly unknown[]).includes(mode)) {
      return { error: err('invalid_input', { field: 'target.mode', allowed: [...CONTACT_BOOKING_MODES] }) };
    }
    const refundVat = t['refundVat'];
    if (refundVat !== undefined && refundVat !== 'reverse' && refundVat !== 'keep') {
      return { error: err('invalid_input', { field: 'target.refundVat', allowed: ['reverse', 'keep'] }) };
    }
    const beyond = t['beyondGuthaben'];
    if (beyond !== undefined && typeof beyond !== 'boolean') {
      return { error: err('invalid_input', { field: 'target.beyondGuthaben', expected: 'boolean' }) };
    }
    return {
      target: {
        kind: 'contact',
        contactId: t['contactId'] as string,
        ...(cpk !== undefined ? { counterpartyKind: cpk as ContactCounterpartyKind } : {}),
        ...(mode !== undefined ? { mode: mode as ContactBookingMode } : {}),
        ...(typeof t['overrideReason'] === 'string' ? { overrideReason: t['overrideReason'] as string } : {}),
        ...(refundVat !== undefined ? { refundVat: refundVat as 'reverse' | 'keep' } : {}),
        ...(beyond === true ? { beyondGuthaben: true } : {}),
      },
    };
  }
  if (kind === 'expense_claims') {
    // D178 E3 (A39 §17.3): approved Spesen paid from a debit line through E02's reimbursement path.
    const raw = t['claimIds'];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TARGET_ITEMS) {
      return { error: err('invalid_input', { field: 'target.claimIds', reason: `one to ${MAX_TARGET_ITEMS} expense claims` }) };
    }
    for (let i = 0; i < raw.length; i += 1) {
      const g = requireString(raw[i], `target.claimIds[${i}]`);
      if (g) return { error: g };
    }
    return { target: { kind: 'expense_claims', claimIds: [...(raw as string[])] } };
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
  if (kind === 'rule') {
    // D175 (A39 §14.2): the SHAPE only. The amounts are checked against the rule's recipe by `expandRule`,
    // which needs the line, and the expansion then passes through this function again as `accounts`.
    const g = requireString(t['standardId'], 'target.standardId');
    if (g) return { error: g };
    const asksRaw = t['asks'] ?? {};
    if (typeof asksRaw !== 'object' || asksRaw === null || Array.isArray(asksRaw)) {
      return { error: err('invalid_input', { field: 'target.asks', reason: 'an object of amounts in Rappen keyed by the leg index' }) };
    }
    const asks: Record<string, number> = {};
    for (const [k, v] of Object.entries(asksRaw as Record<string, unknown>)) {
      if (!/^(0|[1-9]\d*)$/.test(k)) return { error: err('invalid_input', { field: `target.asks.${k}`, reason: 'a key is a leg index' }) };
      if (v === null || v === undefined) continue;
      if (!Number.isSafeInteger(v)) return { error: err('invalid_input', { field: `target.asks.${k}`, reason: 'an amount in Rappen' }) };
      asks[k] = v as number;
    }
    return { target: { kind: 'rule', standardId: t['standardId'] as string, asks } };
  }
  const via = t['viaAccountId'];
  if (via !== undefined && (typeof via !== 'string' || via.length === 0)) return { error: err('invalid_input', { field: 'target.viaAccountId' }) };
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
    // D178 E3 (A39 §17.4): the leg's amount in the transaction currency. Shape only here; the rules (one
    // foreign currency, no MWST, an income or expense account, the line's direction) need the line.
    let fx: BankLineLegFx | undefined;
    if (l['fx'] !== undefined) {
      const f = l['fx'] as Record<string, unknown> | null;
      if (typeof f !== 'object' || f === null || Array.isArray(f)) return { error: err('invalid_input', { field: `target.legs[${i}].fx` }) };
      if (!isCurrencyCode(f['currency'])) {
        return { error: err('invalid_input', { field: `target.legs[${i}].fx.currency`, reason: 'an ISO 4217 code such as USD' }) };
      }
      if (!Number.isSafeInteger(f['amountMinor']) || (f['amountMinor'] as number) <= 0) {
        return { error: err('invalid_input', { field: `target.legs[${i}].fx.amountMinor`, reason: 'a positive amount in the minor unit of the currency' }) };
      }
      fx = { currency: f['currency'] as string, amountMinor: f['amountMinor'] as number };
    }
    legs.push({
      accountId: l['accountId'] as string,
      amountMinor: amount as number,
      ...(taxCode !== undefined ? { taxCode } : {}),
      ...(typeof l['description'] === 'string' ? { description: l['description'] as string } : {}),
      ...(fx !== undefined ? { fx } : {}),
    });
  }
  const ack = t['acknowledgeFx'];
  if (ack !== undefined && typeof ack !== 'boolean') return { error: err('invalid_input', { field: 'target.acknowledgeFx' }) };
  return {
    target: {
      kind: 'accounts',
      legs,
      ...(typeof via === 'string' ? { viaAccountId: via } : {}),
      ...(ack === true ? { acknowledgeFx: true } : {}),
    },
  };
}

// --- D175: a Buchungsregel, expanded ---------------------------------------------------------------

type AccountsTarget = Extract<BookBankLineTarget, { kind: 'accounts' }>;
type RuleTarget = Extract<BookBankLineTarget, { kind: 'rule' }>;

/**
 * D175 (A39 §14.2): a `rule` target as the `accounts` target it stands for, on THIS line. Every asked leg
 * takes its amount from `asks` (positive Rappen, in the line's direction unless the leg runs `against`
 * it), the rest leg the line amount minus the others (either sign), in the recipe's order, routed through
 * the rule's Durchlaufkonto when it has one. Refuses `rule_not_found` (another workspace's rule, a
 * superseded one, an id that names nothing), `rule_not_applicable` (the rule's counterparty or direction
 * is not the line's: the match text is NOT checked, the person may pick a rule whose text the line lacks),
 * `ask_missing` (an asked leg without a positive amount), `rest_is_zero`, and `invalid_input` for an ask
 * keyed to a leg that is not asked. D176: a `same` leg takes the amount of the asked leg it names (in its
 * own direction, `against` read per leg); a Vorlage on a bank line refuses `wrong_scope`, and a "Nicht
 * buchen" rule refuses `wrong_outcome` (`ignore_bank_line` with the rule's reason, note and `standardId`
 * decides such a line). Reads only; the booking validates the expansion like any other.
 */
export function expandRule(ctx: WorkspaceContext, row: BankTxnRow, target: Pick<RuleTarget, 'standardId' | 'asks'>): { target: AccountsTarget } | { error: Err } {
  const rule = readLiveRule(ctx, target.standardId);
  if (rule === undefined) return { error: err('rule_not_found', { standardId: target.standardId }) };
  if (rule.scope !== 'bank') {
    return { error: err('wrong_scope', { standardId: rule.id, scope: rule.scope, reason: 'a Vorlage books in the composer (post_entry with template), never a bank line' }) };
  }
  if (rule.outcome === 'ignore') {
    return {
      error: err('wrong_outcome', {
        standardId: rule.id,
        outcome: rule.outcome,
        ignoreReason: rule.ignore_reason,
        reason: 'this rule says "Nicht buchen": decide the line with ignore_bank_line and the rule\'s reason, note and standardId',
      }),
    };
  }
  const key = counterpartyKeyOf(row, readBankTxnDetail(ctx, row.id));
  if (key !== rule.counterparty_key || directionOf(row) !== rule.direction) {
    return {
      error: err('rule_not_applicable', {
        standardId: rule.id,
        bankTxnId: row.id,
        reason: key !== rule.counterparty_key ? 'the rule is for another counterparty' : 'the rule is for the other direction',
      }),
    };
  }
  const legs = recipeOfRow(rule);
  if (legs === null) return { error: err('rule_not_applicable', { standardId: rule.id, bankTxnId: row.id, reason: 'recipe_unreadable' }) };
  for (const k of Object.keys(target.asks)) {
    // D177: a computed (`factor`) leg takes an ask too: the person's override of the computed amount.
    const kind = legs[Number(k)]?.amount.kind;
    if (kind !== 'ask' && kind !== 'factor') {
      return { error: err('invalid_input', { field: `target.asks.${k}`, reason: 'this leg of the rule is neither asked nor computed' }) };
    }
  }
  const restAt = restLegIndex(legs);
  const out: BankLineLeg[] = [];
  let others = 0;
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i]!;
    let amountMinor = 0;
    if (leg.amount.kind === 'factor') {
      // D177 (A39 §16.1): the person's override when given, else round-half-up(|line| x num / den). Either
      // must be positive: a line too small for the fraction asks the person (`computed: true`).
      const given = target.asks[String(i)];
      const amount = given !== undefined ? given : factorAmountMinor(row.amount_minor, leg.amount.num, leg.amount.den);
      if (amount === null) return { error: err('rule_not_applicable', { standardId: rule.id, bankTxnId: row.id, legIndex: i, reason: 'factor_overflow' }) };
      if (amount <= 0) {
        return { error: err('ask_missing', { standardId: rule.id, legIndex: i, label: leg.amount.label, computed: true }) };
      }
      amountMinor = leg.against === true ? -amount : amount;
      others += amountMinor;
    } else if (leg.amount.kind === 'ask' || leg.amount.kind === 'same') {
      // D176: `same` reads the asked leg it names (the recipe check guarantees that leg asks).
      const askedAt = leg.amount.kind === 'same' ? leg.amount.legIndex : i;
      const asked = legs[askedAt]!.amount;
      const given = target.asks[String(askedAt)];
      if (given === undefined || given <= 0) {
        return { error: err('ask_missing', { standardId: rule.id, legIndex: askedAt, label: asked.kind === 'ask' ? asked.label : '' }) };
      }
      amountMinor = leg.against === true ? -given : given;
      others += amountMinor;
    }
    out.push({
      accountId: leg.accountId,
      amountMinor,
      ...(leg.taxCode !== null ? { taxCode: leg.taxCode } : {}),
      ...(leg.description !== undefined ? { description: leg.description } : {}),
    });
  }
  const rest = row.amount_minor - others;
  if (rest === 0) return { error: err('rest_is_zero', { standardId: rule.id, legIndex: restAt, reason: 'the asked amounts leave nothing for the rest leg' }) };
  out[restAt] = { ...out[restAt]!, amountMinor: rest };
  return { target: { kind: 'accounts', legs: out, ...(rule.via_account_id !== null ? { viaAccountId: rule.via_account_id } : {}) } };
}

// --- D175: compose_entry for a bank line -----------------------------------------------------------

export interface ComposeBankLineInput {
  bankTxnId?: string;
  target?: unknown;
}

/** D178 E3 (A39 §17.5): one journal line of a previewed booking, with its account number and CHF. */
export type BankPreviewLine = LineInput & {
  readonly accountNumber: string;
  readonly currency: string;
  readonly fxRate: string | null;
  readonly baseDebit: number;
  readonly baseCredit: number;
};

/**
 * D178 E3 (A39 §17.5): what `book_bank_line` would do with ANY target on this line, beside the composer's
 * lines: whether it would book now (`bookable`, else `blockedBy` names the refusal and `verdict` carries its
 * sentence), the deviation and the remainder outcomes, the documents, the contact, the claims, the FX
 * conversion, and the consequence the caller must acknowledge. Built from the same plans the booking books
 * from; for a settlement the verdict and the lines come from the booking itself, run and rolled back.
 */
export type BankBookingPreview = {
  readonly targetKind: BookBankLineTarget['kind'];
  readonly bookable: boolean;
  readonly blockedBy: string | null;
  readonly verdict: { readonly ok: true } | Err;
  /** Line minus what the target accounts for (legs, allocations or claims); null where it means nothing. */
  readonly deviationMinor: number | null;
  readonly remainder: BankTargetRemainder | null;
  readonly remainderOptions: BankLineRemainderMode[];
  readonly documents: AllocationDocView[];
  readonly contact: {
    contactId: string;
    name: string;
    counterpartyKind: ContactCounterpartyKind;
    mode: ContactBookingMode;
    settingMode: ContactBookingMode;
    overridden: boolean;
    accountNumber: string | null;
  } | null;
  readonly claims: ClaimView[];
  readonly fx: { currency: string; foreignMinor: number; baseMinor: number; rate: string; conversionLines: BankPreviewLine[] } | null;
  /** Every entry the booking would post, in order, each with its own lines (a Spesen booking posts one per claim). */
  readonly entries: { currency: string; lines: BankPreviewLine[] }[];
  readonly warnings: string[];
  readonly consequences: BankTargetConsequence[];
  /** What the caller must acknowledge on the target before it books (`fx_counter_leg`: `acknowledgeFx: true`). */
  readonly acknowledgementsRequired: string[];
};

/** `compose_entry`'s answer for a bank line: the composer's answer, the line, and the expanded target. */
export type ComposeBankLineOk = ComposeExpandOk & {
  readonly bankTxnId: string;
  /** The `accounts` target a `rule` expands to on this line (the target itself when given as `accounts`); null when it could not be expanded. */
  readonly target: AccountsTarget | null;
  /** D178 E3 (A39 §17.5): the booking preview for every target kind. */
  readonly booking?: BankBookingPreview;
};

/** The empty preview a refusal starts from. */
function bookingPreviewOf(kind: BookBankLineTarget['kind'], verdict: { ok: true } | Err, extra: Partial<BankBookingPreview> = {}): BankBookingPreview {
  return {
    targetKind: kind,
    bookable: verdict.ok,
    blockedBy: verdict.ok ? null : (verdict as Err).error,
    verdict,
    deviationMinor: null,
    remainder: null,
    remainderOptions: [],
    documents: [],
    contact: null,
    claims: [],
    fx: null,
    entries: [],
    warnings: [],
    consequences: [],
    acknowledgementsRequired: [],
    ...extra,
  };
}

/** Lines as a preview shows them, read off posted rows (the settlement preview's rolled-back booking). */
function previewLinesOfEntry(ctx: WorkspaceContext, entryId: string): { currency: string; lines: BankPreviewLine[] } {
  const rows = ctx.store.db
    .prepare(
      `SELECT l.account_id AS account, a.number AS number, l.debit_minor AS debit, l.credit_minor AS credit, l.currency AS currency,
              l.fx_rate AS fxRate, l.base_debit_minor AS baseDebit, l.base_credit_minor AS baseCredit, l.tax_code AS taxCode,
              l.tax_base_minor AS taxBase, l.tax_amount_minor AS taxAmount
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id AND e.workspace_id = ? JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? ORDER BY l.rowid`,
    )
    .all(ctx.workspaceId, entryId) as {
    account: string;
    number: string;
    debit: number;
    credit: number;
    currency: string;
    fxRate: string | null;
    baseDebit: number;
    baseCredit: number;
    taxCode: string | null;
    taxBase: number | null;
    taxAmount: number | null;
  }[];
  return {
    currency: rows[0]?.currency ?? baseCurrencyOf(ctx),
    lines: rows.map((r) => ({
      account: r.account,
      ...(r.debit > 0 ? { debit: r.debit } : {}),
      ...(r.credit > 0 ? { credit: r.credit } : {}),
      ...(r.taxCode !== null ? { taxCode: r.taxCode } : {}),
      ...(r.taxBase !== null ? { taxBase: r.taxBase } : {}),
      ...(r.taxAmount !== null ? { taxAmount: r.taxAmount } : {}),
      accountNumber: r.number,
      currency: r.currency,
      fxRate: r.fxRate,
      baseDebit: r.baseDebit,
      baseCredit: r.baseCredit,
    })),
  };
}

/** Plain composer lines as preview lines (an entry in `currency`; CHF equal to the amounts in the base). */
function previewLinesOf(ctx: WorkspaceContext, lines: readonly LineInput[], currency: string, base?: readonly { baseDebit: number; baseCredit: number }[], fxRate: string | null = null): BankPreviewLine[] {
  const numberOf = ctx.store.db.prepare('SELECT number FROM account WHERE workspace_id = ? AND id = ?');
  return lines.map((l, i) => ({
    ...l,
    accountNumber: (numberOf.get(ctx.workspaceId, l.account) as { number: string } | undefined)?.number ?? '',
    currency,
    fxRate,
    baseDebit: base?.[i]?.baseDebit ?? (l.debit ?? 0),
    baseCredit: base?.[i]?.baseCredit ?? (l.credit ?? 0),
  }));
}

/**
 * D178 E3 (A39 §17.5): run the booking of a settlement, contact or Spesen target and roll it back, keeping
 * only its answer and the lines of every entry it posted. The same code a direct call runs, so the preview
 * IS the booking; nothing it wrote survives (the D177-C1 dry run, extended to read its lines first).
 */
function dryRunCapture(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  target: BookableBankLineTarget,
): { result: Result<BookBankLineOk>; entries: { currency: string; lines: BankPreviewLine[] }[] } {
  try {
    ctx.store.discardingChanges(() =>
      ctx.store.tx(() => {
        const result = runGuarded(() => performBooking(ctx, row, target, {}));
        let entries: { currency: string; lines: BankPreviewLine[] }[] = [];
        if (result.ok) {
          const done = result as unknown as BookBankLineOk;
          const ids = done.entryIds ?? [
            ...(done.entryId !== null ? [done.entryId] : []),
            ...done.paymentIds.map((p) => paymentEntryOf(ctx, p)).filter((e): e is string => e !== null && e !== done.entryId),
          ];
          entries = ids.map((id) => previewLinesOfEntry(ctx, id));
        }
        throw new DryRunDone(result, entries);
      }),
    );
  } catch (e) {
    if (e instanceof DryRunDone) return { result: e.result as Result<BookBankLineOk>, entries: e.entries };
    throw e;
  }
  return { result: err('internal_error', { reason: 'the dry run answered nothing' }), entries: [] };
}

/**
 * D178 E3 (A39 §17.5): the preview of a target that is not booked to accounts: the plan's figures (the
 * documents and deviation, the contact and mode, the claims) and the booking's own verdict and lines.
 */
function composeSettlement(ctx: WorkspaceContext, row: BankTxnRow, given: Exclude<BookableBankLineTarget, { kind: 'accounts' }>): Result<ComposeBankLineOk> {
  const bank = bankLedgerOf(ctx, row.bank_account_id);
  let extra: Partial<BankBookingPreview> = {};
  if (bank !== undefined) {
    if (given.kind === 'open_item' && given.allocations !== undefined) {
      const planned = planAllocations(ctx, row, bank.ledgerAccountId, { allocations: given.allocations, ...(given.remainder !== undefined ? { remainder: given.remainder } : {}) });
      if ('plan' in planned) {
        extra = {
          deviationMinor: planned.plan.deviationMinor,
          remainder: planned.plan.remainder,
          remainderOptions: planned.plan.remainderOptions,
          documents: planned.plan.documents,
        };
      }
    } else if (given.kind === 'contact') {
      const planned = planContact(ctx, row, bank.ledgerAccountId, given);
      if ('plan' in planned) {
        const p = planned.plan;
        extra = {
          contact: {
            contactId: p.contactId,
            name: p.contactName,
            counterpartyKind: p.counterpartyKind,
            mode: p.mode,
            settingMode: p.settingMode,
            overridden: p.overridden,
            accountNumber: p.entry?.account.number ?? null,
          },
          ...(p.mode === 'guthaben' ? { remainder: { kind: 'on_account', amountMinor: row.amount_minor } } : {}),
        };
      }
    } else if (given.kind === 'expense_claims') {
      const planned = planExpenseClaims(ctx, row, given.claimIds);
      if ('plan' in planned) extra = { claims: planned.plan.claims, deviationMinor: planned.plan.deviationMinor };
    }
  }
  const run = dryRunCapture(ctx, row, given);
  const verdict: { ok: true } | Err = run.result.ok ? { ok: true } : (run.result as Err);
  const done = run.result.ok ? (run.result as unknown as BookBankLineOk) : null;
  if (done !== null && done.remainder !== null && extra.remainder === undefined) {
    extra = { ...extra, remainder: { kind: done.remainder.kind, amountMinor: done.remainder.amountMinor } };
  }
  const booking = bookingPreviewOf(given.kind, verdict, { ...extra, entries: run.entries, warnings: done?.warnings ?? [] });
  return ok<ComposeBankLineOk>({
    mode: 'expand',
    composed: verdict.ok,
    stamped: false,
    lines: run.entries.flatMap((e) => e.lines),
    captions: [],
    verdict,
    bankTxnId: row.id,
    target: null,
    booking,
  });
}

/**
 * D178 E3 (A39 §17.4, §17.5): the preview of an `accounts` target with a foreign-currency leg: the bank
 * entry's lines through the composer (as any `accounts` booking), the conversion entry's lines with their
 * CHF, the effective rate, and the `fx_counter_leg` consequence the booking needs acknowledged.
 */
function composeFx(ctx: WorkspaceContext, row: BankTxnRow, bankLedgerId: string, target: AccountsTarget): Result<ComposeBankLineOk> {
  const consequenceExtra: Partial<BankBookingPreview> = {
    consequences: [FX_COUNTER_LEG_CONSEQUENCE],
    acknowledgementsRequired: ['fx_counter_leg'],
    // Critic E3-L1: the preview names every warning the booking gives, from the same function.
    warnings: fxBookingWarnings(ctx, row, target),
  };
  const refusedFx = (verdict: Err): Result<ComposeBankLineOk> =>
    ok<ComposeBankLineOk>({
      mode: 'expand',
      composed: false,
      stamped: false,
      lines: [],
      captions: [],
      verdict,
      bankTxnId: row.id,
      target,
      booking: bookingPreviewOf('accounts', verdict, consequenceExtra),
    });
  const planned = planFxAccounts(ctx, row, bankLedgerId, target);
  if ('error' in planned) return refusedFx(planned.error);
  const plan = planned.plan;
  const composed = expandEntry(ctx, { date: lineBookingDate(row), lines: plan.bankLines });
  if (!composed.ok) return composed;
  const conversion = previewPostingLines(ctx, { date: lineBookingDate(row), source: 'camt', lines: plan.conversionLines, currency: plan.currency, fxRate: plan.rate });
  const conversionLines = previewLinesOf(ctx, plan.conversionLines, plan.currency, conversion.ok ? conversion.lines : undefined, plan.rate);
  const acknowledged = target.acknowledgeFx === true;
  const verdict: { ok: true } | Err = !composed.verdict.ok
    ? composed.verdict
    : !conversion.ok
      ? conversion.error
      : acknowledged
        ? { ok: true }
        : bankTargetRefusal('fx_ack_required', { consequence: FX_COUNTER_LEG_CONSEQUENCE, acknowledge: 'target.acknowledgeFx' });
  const base = baseCurrencyOf(ctx);
  const booking = bookingPreviewOf('accounts', verdict, {
    ...consequenceExtra,
    deviationMinor: row.amount_minor - target.legs.reduce((s, l) => s + l.amountMinor, 0),
    fx: { currency: plan.currency, foreignMinor: plan.foreignMinor, baseMinor: plan.baseMinor, rate: plan.rate, conversionLines },
    entries: [
      { currency: plan.currency, lines: conversionLines },
      { currency: base, lines: previewLinesOf(ctx, composed.lines, base) },
    ],
  });
  return ok<ComposeBankLineOk>({ ...composed, verdict, bankTxnId: row.id, target, booking });
}

/**
 * D175 (A39 §14.2): what `book_bank_line` would post for an `accounts` or `rule` target on this line,
 * WITHOUT posting: the rule expanded on the line (`expandRule`), the lines built exactly as the booking
 * builds them (`buildAccountsLines`, the Durchlaufkonto included), then A02's composer (`expandEntry`,
 * which runs `previewPostingLines`, the pre-write half of `postEntry`) stamps them and gives its verdict.
 * So the preview IS the booking (`test/banking/bank-compose-parity.test.mjs`). A refusal the booking would
 * give (`rule_not_found`, `ask_missing`, `rest_is_zero`, `legs_do_not_sum`, `line_not_open`, ...) is the
 * VERDICT of the read, not a failure of it; a malformed input or an unknown line is the read's own refusal.
 * Writes nothing.
 */
export function composeBankLine(ctx: WorkspaceContext, input: ComposeBankLineInput): Result<ComposeBankLineOk> {
  const guard = requireString(input.bankTxnId, 'bankTxnId');
  if (guard) return guard;
  const validated = validateTarget(input.target);
  if ('error' in validated) return validated.error;
  const given = validated.target;
  // D178 E3 (security review of 1de8bcd23): the preview of a Spesen target answers the claims and that of a
  // contact target the contact, so each asks the read right of what it reveals (`hr.read`, the right
  // `expense_claim_get` declares; `read_master_data`, the right of `get_contact`), the same rule A24
  // declares for `compose_entry`. Asserted before the line is even read, so a seat without it learns nothing.
  if (given.kind === 'expense_claims') {
    const reads = ctx.capabilities.assert('hr.read');
    if (!reads.ok) return reads;
  }
  if (given.kind === 'contact') {
    const reads = ctx.capabilities.assert('read_master_data');
    if (!reads.ok) return reads;
  }
  const row = readBankTxn(ctx, input.bankTxnId as string);
  if (row === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
  const refused = (verdict: Err, target: AccountsTarget | null = null): Result<ComposeBankLineOk> =>
    ok<ComposeBankLineOk>({
      mode: 'expand',
      composed: false,
      stamped: false,
      lines: [],
      captions: [],
      verdict,
      bankTxnId: row.id,
      target,
      booking: bookingPreviewOf(given.kind, verdict),
    });
  const current = lineStateOf(ctx, row);
  if (current.state !== 'open') return refused(lineNotOpen(row, current.state, current.link));
  // D178 E3 (A39 §17.5): every other target previews through its plan and the booking itself.
  if (given.kind !== 'accounts' && given.kind !== 'rule') return composeSettlement(ctx, row, given);
  let target: AccountsTarget;
  if (given.kind === 'rule') {
    const expanded = expandRule(ctx, row, given);
    if ('error' in expanded) return refused(expanded.error);
    const again = validateTarget(expanded.target);
    if ('error' in again) return refused(again.error);
    target = again.target as AccountsTarget;
  } else {
    target = given;
  }
  const bank = bankLedgerOf(ctx, row.bank_account_id);
  if (bank === undefined) return refused(err('needs_bank_account', { bankAccountId: row.bank_account_id }), target);
  if (row.currency !== bank.currency) {
    return refused(err('currency_mismatch', { bankTxnId: row.id, lineCurrency: row.currency, accountCurrency: bank.currency }), target);
  }
  // D178 E3 (A39 §17.4): a leg in the transaction currency books through the conversion entry.
  if (target.legs.some((l) => l.fx !== undefined)) return composeFx(ctx, row, bank.ledgerAccountId, target);
  const deviationMinor = row.amount_minor - target.legs.reduce((s, l) => s + l.amountMinor, 0);
  const built = buildAccountsLines(ctx, row, bank.ledgerAccountId, target.legs, lineBookingDate(row), target.viaAccountId);
  if ('error' in built) {
    return ok<ComposeBankLineOk>({
      mode: 'expand',
      composed: false,
      stamped: false,
      lines: [],
      captions: [],
      verdict: built.error,
      bankTxnId: row.id,
      target,
      booking: bookingPreviewOf('accounts', built.error, { deviationMinor }),
    });
  }
  const base = baseCurrencyOf(ctx);
  const composed = expandEntry(ctx, { date: lineBookingDate(row), lines: built.lines }, row.currency !== base ? { currency: row.currency } : {});
  if (!composed.ok) return composed;
  const warnings = target.legs.some((l) => controlAccountRoleOf(ctx, l.accountId) !== null) ? ['control_account_leg'] : [];
  // A line in its Bankkonto's own foreign currency books at the stored rate: read the CHF the posting
  // would store off the same pre-write half `postEntry` runs.
  const priced =
    row.currency !== base ? previewPostingLines(ctx, { date: lineBookingDate(row), source: 'camt', lines: [...composed.lines], currency: row.currency }) : null;
  return ok<ComposeBankLineOk>({
    ...composed,
    bankTxnId: row.id,
    target,
    booking: bookingPreviewOf('accounts', composed.verdict, {
      deviationMinor,
      warnings,
      entries: [
        {
          currency: row.currency,
          lines: previewLinesOf(ctx, composed.lines, row.currency, priced !== null && priced.ok ? priced.lines : undefined, priced !== null && priced.ok ? priced.fx.rate : null),
        },
      ],
    }),
  });
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
  /**
   * D178 E3: every journal entry the decision posted (a booking to accounts with a foreign counter-leg
   * posts two: the conversion and the bank entry; a settlement its payments' entries). Present on the
   * E3 targets and the FX booking; absent where `entryId` / `paymentIds` already say it all.
   */
  entryIds?: string[];
  /** D178 E3 (A39 §17.1): a `contact` booking's contact, its side, the mode used and whether it overrode the setting. */
  contact?: { contactId: string; counterpartyKind: ContactCounterpartyKind; mode: ContactBookingMode; overridden: boolean; accountNumber: string | null };
  /** D178 E3 (A39 §17.2): a several-document settlement's deviation (line minus allocations). */
  deviationMinor?: number;
  /** D178 E3 (A39 §17.3): the claims a Spesen booking reimbursed. */
  claimIds?: string[];
  /** D178 E3 (A39 §17.4): the counter-leg in the transaction currency and the effective rate it was booked at. */
  fx?: { currency: string; foreignMinor: number; baseMinor: number; rate: string };
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
  const given = validated.target;
  // D178 E3: a contact booking and a Spesen settlement are settlement acts too (A24 keys them on `pay`).
  if (given.kind === 'open_item' || given.kind === 'payment_batch' || given.kind === 'contact' || given.kind === 'expense_claims') {
    const pays = ctx.capabilities.assert('pay');
    if (!pays.ok) return pays;
  }
  if (given.kind === 'expense_claims') {
    const approves = ctx.capabilities.assert('spesen.approve');
    if (!approves.ok) return approves;
  }

  const scopedKey = JSON.stringify(['book_bank_line', input.bankTxnId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<BookBankLineOk>>(ctx.workspaceId, scopedKey, 'book_bank_line');
  if (replayed !== undefined) return replayed;

  const row = readBankTxn(ctx, input.bankTxnId as string);
  if (row === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
  const current = lineStateOf(ctx, row);
  if (current.state !== 'open') return lineNotOpen(row, current.state, current.link);
  // D175: a Buchungsregel is expanded on THIS line before it is validated, then booked as the `accounts`
  // target it stands for (the decision row says `accounts`; the rule id stays in the verb's input).
  let target: BookableBankLineTarget;
  if (given.kind === 'rule') {
    const expanded = expandRule(ctx, row, given);
    if ('error' in expanded) return expanded.error;
    const again = validateTarget(expanded.target);
    if ('error' in again) return again.error;
    target = again.target as BookableBankLineTarget;
  } else {
    target = given;
  }

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'book_bank_line', () =>
      performBooking(ctx, row, target, { text: input.text, ...(given.kind === 'rule' ? { ruleId: given.standardId } : {}) }),
    ),
  );
}

/**
 * D177 (A39 §16.1): `book_bank_line`'s own validation with NOTHING written, the dial's pre-draft screen
 * (`ActionDef.prevalidate`). A governed seat's call is refused here with the very Result a direct call
 * would answer, BEFORE it is pinned or drafted, so a Vorschlag the approval can only fail never reaches a
 * person (the defect behind D177: a draft whose legs carried the wrong sign sat in the queue, unbookable).
 *
 * What it checks: the input guards and the target's shape (`invalid_input`), the line (`not_found`,
 * `line_not_open`), and for an `accounts` or `rule` target everything `compose_entry` checks, which IS the
 * booking's pre-write half (`composeBankLine`: the rule expanded on the line, the legs summing to it, every
 * account and code, the currency, the Durchlaufkonto, and A02's verdict on the lines). A settlement
 * (`open_item`, `payment_batch`) or a match (`existing_entry`) is screened by RUNNING the booking itself
 * (`performBooking`, the very code a direct call runs: the document, run or entry exists in this
 * workspace, is still open, fits the line's currency and amount) inside a transaction that is always
 * rolled back (critic D177-C1), so nothing it wrote survives. A same-key replay answers undefined: the
 * verb would replay its key.
 */
export function prevalidateBookBankLine(ctx: WorkspaceContext, input: BookBankLineInput): Err | undefined {
  const guard =
    requireString(input.bankTxnId, 'bankTxnId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalText(input.text, 'text');
  if (guard) return guard;
  if (input.date !== undefined) return noDateOverride();
  if (typeof input.text === 'string' && input.text.length > MAX_TEXT) return err('invalid_input', { field: 'text', maxLength: MAX_TEXT });
  const validated = validateTarget(input.target);
  if ('error' in validated) return validated.error;
  const scopedKey = JSON.stringify(['book_bank_line', input.bankTxnId, input.idempotencyKey]);
  if (ctx.store.recallIdempotent<Result<BookBankLineOk>>(ctx.workspaceId, scopedKey, 'book_bank_line') !== undefined) {
    // Critic D177-R2-1: the memo answers a genuine retry of a decision still in force. A line that is OPEN
    // again (booked, then reopened) under a key that already decided it would replay the old answer and
    // book nothing, so such a draft is never "screened" (it would supersede a valid Vorschlag).
    return spentKeyOnOpenLine(ctx, input.bankTxnId as string, input.idempotencyKey as string);
  }
  const row = readBankTxn(ctx, input.bankTxnId as string);
  if (row === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
  const current = lineStateOf(ctx, row);
  if (current.state !== 'open') return lineNotOpen(row, current.state, current.link);
  // D178 point 19 (E2): a possible duplicate's booking is never drafted before the person's decision.
  const duplicate = duplicateDecisionPending(ctx, row.id);
  if (duplicate !== null) return duplicate;
  const given = validated.target;
  if (given.kind !== 'accounts' && given.kind !== 'rule') return dryRunBooking(ctx, row, given, input.text);
  const composed = composeBankLine(ctx, { bankTxnId: row.id, target: input.target });
  if (!composed.ok) return composed;
  const verdict = (composed as ComposeBankLineOk).verdict;
  return verdict.ok ? undefined : (verdict as Err);
}

/** Carries a dry run's answer (and, for a preview, the lines it posted) out of the transaction it rolls back. */
class DryRunDone {
  constructor(
    readonly result: Result,
    readonly entries: { currency: string; lines: BankPreviewLine[] }[] = [],
  ) {}
}

/**
 * D177 (critic D177-C1): the booking's answer for a settlement or match target WITHOUT keeping anything:
 * `performBooking` runs inside a transaction that is always rolled back (a savepoint when the caller is in
 * one), and only its answer leaves. Every write it made (the payment, the entry, the link, the audit row,
 * the memo) is undone with it.
 */
function dryRunBooking(ctx: WorkspaceContext, row: BankTxnRow, target: BookableBankLineTarget, text: string | undefined): Err | undefined {
  try {
    // Critic D177-R2-2: every write here is rolled back, so the store's change count must not count it,
    // or an unexpected throw from inside would be reported as a refusal that changed the book.
    ctx.store.discardingChanges(() =>
      ctx.store.tx(() => {
        throw new DryRunDone(runGuarded(() => performBooking(ctx, row, target, { text })));
      }),
    );
  } catch (e) {
    if (e instanceof DryRunDone) return e.result.ok ? undefined : (e.result as Err);
    throw e;
  }
  return undefined;
}

/**
 * The booking itself, INSIDE the caller's transaction, throwing `BankAbort` on any refusal. Shared by
 * `book_bank_line` and the A20 wrappers (`confirm_match`, `create_entry_for_txn`), which memoise under
 * their own verb names.
 */
export function performBooking(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  target: BookableBankLineTarget,
  opts: { text?: string | undefined; ruleId?: string },
): Result<BookBankLineOk> {
  const current = lineStateOf(ctx, row);
  if (current.state !== 'open') abort(lineNotOpen(row, current.state, current.link));
  // D178 point 19 (E2, critic R2-1): a possible duplicate waits for the person's decision, by every path.
  const duplicate = duplicateDecisionPending(ctx, row.id);
  if (duplicate !== null) abort(duplicate);
  const bank = bankLedgerOf(ctx, row.bank_account_id);
  if (bank === undefined) abort(err('needs_bank_account', { bankAccountId: row.bank_account_id }));
  // A line in ANOTHER currency than its Bankkonto (a EUR movement reported on a CHF account) cannot be
  // posted onto that account's ledger account: the conversion the bank applied is not a fact these
  // books hold (§H-FX, A20 note 9). A line in the account's own foreign currency posts at the stored
  // rate. Matching an existing entry compares currencies leg by leg instead.
  if (
    row.currency !== bank.currency &&
    (target.kind === 'accounts' || target.kind === 'open_item' || target.kind === 'contact' || target.kind === 'expense_claims')
  ) {
    abort(err('currency_mismatch', { bankTxnId: row.id, lineCurrency: row.currency, accountCurrency: bank.currency }));
  }
  const warnings = row.reversal_ind === 1 ? ['reversal_line'] : [];
  switch (target.kind) {
    case 'open_item':
      // D178 E3 (A39 §17.2): several documents in one payment; one document keeps its own path.
      if (target.allocations !== undefined) return bookAllocations(ctx, row, bank.ledgerAccountId, target, warnings);
      return bookOpenItem(ctx, row, bank.ledgerAccountId, target as OpenItemTarget, opts, warnings);
    case 'payment_batch':
      return bookPaymentBatch(ctx, row, bank.ledgerAccountId, target.batchId, warnings);
    case 'existing_entry':
      return matchExistingEntry(ctx, row, bank.ledgerAccountId, target.entryId, target.acceptDifference === true ? (target.differenceReason ?? '') : null, warnings);
    case 'accounts':
      // D178 E3 (A39 §17.4): a leg in the transaction currency books through the conversion entry.
      if (target.legs.some((l) => l.fx !== undefined)) {
        return bookToAccountsFx(ctx, row, bank.ledgerAccountId, target, opts, warnings);
      }
      return bookToAccounts(ctx, row, bank.ledgerAccountId, target.legs, opts, warnings, target.viaAccountId);
    case 'contact':
      return bookContact(ctx, row, bank.ledgerAccountId, target, opts, warnings);
    case 'expense_claims':
      return bookExpenseClaims(ctx, row, bank.ledgerAccountId, target.claimIds, warnings);
  }
}

/** The single-document `open_item` target (`documentId` set; `validateTarget` guarantees it). */
type OpenItemTarget = Extract<BookBankLineTarget, { kind: 'open_item' }> & { documentId: string };

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
  target: OpenItemTarget,
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

// --- D178 E3: the new targets (A39 §17.1 to §17.4) -----------------------------------------------------

/** The bank legs of `entryIds` on this line's ledger: what a decision claims. */
function claimsOf(ctx: WorkspaceContext, bankLedgerId: string, entryIds: readonly (string | null)[]): string[] {
  return bankLegsOf(ctx, bankLedgerId, entryIds).map((l) => l.lineId);
}

/** The journal entry an A14 payment posted. */
function paymentEntryOf(ctx: WorkspaceContext, paymentId: string): string | null {
  const row = ctx.store.db
    .prepare('SELECT journal_entry_id AS e FROM payment WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, paymentId) as { e: string | null } | undefined;
  return row?.e ?? null;
}

/**
 * `open_item { allocations[] }` (A39 §17.2): several invoices or bills of ONE contact in ONE A14 payment,
 * from the plan the preview shows (`planAllocations`). Cash left over parks as the contact's Guthaben only
 * when the person chose `on_account`; a partly allocated invoice stays open or is written off within the
 * A14 threshold. Every refusal of the plan aborts the booking before anything is written.
 */
function bookAllocations(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  bankLedgerId: string,
  target: Extract<BookBankLineTarget, { kind: 'open_item' }>,
  warnings: string[],
): Result<BookBankLineOk> {
  const planned = planAllocations(ctx, row, bankLedgerId, { allocations: target.allocations ?? [], ...(target.remainder !== undefined ? { remainder: target.remainder } : {}) });
  if ('error' in planned) abort(planned.error);
  const plan = planned.plan;
  if (plan.refusal !== null) abort(plan.refusal);
  if (plan.payment === null) abort(err('internal_error', { reason: 'an allocation plan without a refusal carries its payment' }));
  const generation = lineGeneration(ctx, row.id);
  const paid = recordPayment(ctx, { ...plan.payment, idempotencyKey: `bankline-${row.id}-g${generation}` });
  if (!paid.ok) abort(paid);
  const paymentId = paid['paymentId'] as string;
  const entryId = typeof paid['entryId'] === 'string' ? (paid['entryId'] as string) : null;
  const remainder: BankLineRemainder = {
    kind: plan.remainder.kind,
    amountMinor: plan.remainder.amountMinor,
    documentOpenMinor: plan.documents.reduce((s, d) => s + d.openAfterMinor, 0),
    feeOpenMinor: null,
  };
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
    claims: claimsOf(ctx, bankLedgerId, [entryId]),
  });
  // A credit's A21 queue row follows its line, naming the first invoice it settled.
  syncCreditRow(ctx, row, 'applied', { invoiceId: plan.documents[0]?.documentId ?? null, paymentId, appliedMode: remainder.kind === 'written_off' ? 'full' : 'partial' });
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
    entryIds: entryId === null ? [] : [entryId],
    deviationMinor: plan.deviationMinor,
  });
}

/**
 * `contact` (A39 §17.1, bexio's "Kundenbuchung"): the plan decides the mode. `guthaben` is ONE A14 payment
 * with the contact as counterparty and no allocation (the whole amount is its Guthaben, applied later by
 * `allocate_payment`); `anzahlung` is ONE A02 entry between the bank and the Anzahlungen account. The
 * contact is recorded on the decision either way, and an override of the setting with its reason.
 */
function bookContact(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  bankLedgerId: string,
  target: Extract<BookBankLineTarget, { kind: 'contact' }>,
  opts: { text?: string | undefined },
  warnings: string[],
): Result<BookBankLineOk> {
  const pays = ctx.capabilities.assert('pay');
  if (!pays.ok) abort(pays);
  const planned = planContact(ctx, row, bankLedgerId, target);
  if ('error' in planned) abort(planned.error);
  const plan = planned.plan;
  const note = plan.overridden ? `abweichend: ${plan.mode}; Grund: ${plan.overrideReason ?? ''}`.slice(0, MAX_TEXT) : null;
  const contactAnswer = {
    contactId: plan.contactId,
    counterpartyKind: plan.counterpartyKind,
    mode: plan.mode,
    overridden: plan.overridden,
    accountNumber: plan.entry?.account.number ?? null,
  };
  // Owner, 21.10.2026: the receipt VAT of a customer Anzahlung, when the setting asks for it. Priced on the
  // base-currency gross: the line itself, or a foreign line's fixed base amount. A foreign Anzahlung held
  // in its own currency (the setting `foreign`) has no base-currency figure to tax and is refused by name.
  const moneyIn = row.credit_debit === 'CRDT';
  const grossBase = plan.entry?.conversion?.baseMinor ?? (row.currency === baseCurrencyOf(ctx) ? row.amount_minor : null);
  let vat: AnzahlungVatPlan | null = null;
  if (plan.counterpartyKind === 'customer' && moneyIn) {
    if (grossBase === null) {
      const wouldTax = planAnzahlungVat(ctx, { counterpartyKind: 'customer', moneyIn, grossBaseMinor: row.amount_minor, date: lineBookingDate(row) });
      if ('error' in wouldTax || wouldTax.vat !== null) {
        abort(err('unsupported', {
          bankTxnId: row.id,
          reason: 'anzahlung_vat_needs_base_currency',
          sentence: {
            en: 'VAT on a prepayment is booked in the book currency: fix the prepayment in it (setting bank.anzahlung_fx_mode fixed), or turn VAT on prepayments off.',
            'de-CH': 'Die MWST auf einer Anzahlung wird in der Buchungswährung gebucht: Halte die Anzahlung darin fest (Einstellung bank.anzahlung_fx_mode fixed) oder schalte die MWST auf Anzahlungen aus.',
          },
        }));
      }
    } else {
      const planned = planAnzahlungVat(ctx, { counterpartyKind: 'customer', moneyIn, grossBaseMinor: grossBase, date: lineBookingDate(row) });
      if ('error' in planned) abort(planned.error);
      vat = planned.vat;
    }
  }
  // Owner, 21.10.2026 (critic E3-R2-2): a REFUND of a customer's Guthaben that carried receipt VAT is an
  // Entgeltsminderung. `bank.anzahlung_vat_refund` decides: `reverse` (the default) corrects the matching
  // share of the receipt VAT automatically, oldest Guthaben first; `refuse` books no refund until the call
  // states the correction (`target.refundVat`); `warn` books the refund and warns. A stated `refundVat`
  // other than the setting's own answer needs `overrideReason` (D172), recorded on the decision's note.
  // D178 E3: a REFUND through the contact target (money back to a customer, or back from a supplier) nets
  // against that contact's open Guthaben in A14, oldest first, so the cash it hands back is no longer there
  // to allocate. A refund larger than the open Guthaben is refused unless the call states it
  // (`target.beyondGuthaben`), which books the rest on account as before.
  const netting: { paymentId: string; amountMinor: number; cashMinor: number }[] = [];
  const isRefund = plan.payment !== null && ((plan.counterpartyKind === 'customer' && !moneyIn) || (plan.counterpartyKind === 'supplier' && moneyIn));
  if (isRefund) {
    const guthaben = openGuthabenOf(ctx, plan.contactId, moneyIn ? 'outgoing' : 'incoming');
    const openMinor = guthaben.reduce((n, g) => n + g.openMinor, 0);
    if (row.amount_minor > openMinor && target.beyondGuthaben !== true) {
      abort(err('refund_exceeds_guthaben', {
        bankTxnId: row.id,
        field: 'target.beyondGuthaben',
        amountMinor: row.amount_minor,
        openGuthabenMinor: openMinor,
        sentence: {
          en: 'This refund is larger than the open credit (Guthaben) of the contact. Book it to an invoice or a credit note, or state that it goes beyond the credit (beyondGuthaben).',
          'de-CH': 'Diese Rückzahlung ist grösser als das offene Guthaben des Kontakts. Buche sie auf eine Rechnung oder Gutschrift, oder gib an, dass sie über das Guthaben hinausgeht (beyondGuthaben).',
        },
      }));
    }
    let left = row.amount_minor;
    for (const g of guthaben) {
      if (left <= 0) break;
      const cash = Math.min(left, g.openMinor);
      netting.push({ paymentId: g.paymentId, amountMinor: g.amountMinor, cashMinor: cash });
      left -= cash;
    }
  }
  let refundCorrection: { paymentId: string; amountMinor: number; cashMinor: number }[] = [];
  if (plan.counterpartyKind === 'customer' && !moneyIn && plan.payment !== null) {
    // Security review: the correction is tied to the Guthaben this refund nets against, at most the cash it
    // hands back from each.
    const vatOpen = new Map(refundableVatGuthabenOf(ctx, plan.contactId).map((o) => [o.paymentId, o] as const));
    const open = netting
      .flatMap((n) => {
        const v = vatOpen.get(n.paymentId);
        return v === undefined ? [] : [{ paymentId: n.paymentId, amountMinor: v.amountMinor, openMinor: Math.min(n.cashMinor, v.openMinor) }];
      })
      .filter((o) => o.openMinor > 0);
    if (open.length > 0) {
      const setting = getSetting<string>(ctx, 'bank.anzahlung_vat_refund');
      const stated = target.refundVat;
      if (setting === 'refuse' && stated === undefined) {
        abort(err('anzahlung_vat_refund_needs_decision', {
          bankTxnId: row.id,
          field: 'target.refundVat',
          allowed: ['reverse', 'keep'],
          guthabenPaymentIds: open.map((o) => o.paymentId),
          sentence: {
            en: 'This refund hands back a prepayment whose VAT was declared. State whether its VAT is corrected (reverse) or kept (keep).',
            'de-CH': 'Diese Rückzahlung gibt eine Anzahlung zurück, deren MWST deklariert wurde. Gib an, ob die MWST korrigiert (reverse) oder belassen (keep) wird.',
          },
        }));
      }
      const own = setting === 'warn' ? 'keep' : 'reverse';
      const act = stated ?? own;
      const reason = typeof target.overrideReason === 'string' ? target.overrideReason.trim() : '';
      // Security review: departing from the setting's answer (or keeping the VAT where the setting asks the
      // call to decide) changes a filed figure, so it needs the setting owner's right, `manage_vat_config`
      // (A24 and the `vat-file` dial family declare the same for a stated `refundVat`), and a reason.
      const departs = stated !== undefined && (setting === 'refuse' ? stated === 'keep' : stated !== own);
      if (departs) {
        const vatRight = ctx.capabilities.assert('manage_vat_config');
        if (!vatRight.ok) abort(vatRight as Err);
        if (reason.length === 0) {
          abort(bankTargetRefusal('reason_required', { field: 'target.overrideReason', settingKey: 'bank.anzahlung_vat_refund', setting, refundVat: stated }));
        }
      }
      if (act === 'reverse') {
        let left = row.amount_minor;
        for (const o of open) {
          if (left <= 0) break;
          const cash = Math.min(left, o.openMinor);
          refundCorrection.push({ paymentId: o.paymentId, amountMinor: o.amountMinor, cashMinor: cash });
          left -= cash;
        }
      } else {
        warnings.push('anzahlung_vat_refund_uncorrected');
      }
    }
  }
  if (plan.payment !== null) {
    const generation = lineGeneration(ctx, row.id);
    const paid = recordPayment(ctx, { ...plan.payment, idempotencyKey: `bankline-${row.id}-g${generation}` });
    if (!paid.ok) abort(paid);
    const paymentId = paid['paymentId'] as string;
    const entryId = typeof paid['entryId'] === 'string' ? (paid['entryId'] as string) : null;
    recordRefundNetting(ctx, paymentId, netting);
    // Owner, 21.10.2026 (setting `bank.anzahlung_vat`, default off): the Umsatzsteuer on a received customer
    // Anzahlung, booked now on 1300 and cleared when A14 applies the Guthaben to the invoice. The decision
    // names this entry (so the raw Storno refuses it, L3); the payment's entry is held by the line's claim.
    let vatEntryId: string | null = null;
    if (vat !== null) {
      const vatPosted = postEntry(ctx, {
        date: lineBookingDate(row),
        source: 'camt',
        description: `MWST auf Anzahlung ${plan.contactName}`.slice(0, MAX_TEXT),
        // MINTED, never derived from the line alone (the A20 rule against a squattable key).
        idempotencyKey: `bankline-entry-${row.id}-${ctx.ids.next('ble')}`,
        lines: vat.lines,
      });
      if (!vatPosted.ok) abort(vatPosted);
      vatEntryId = vatPosted.entryId;
      warnings.push('anzahlung_vat');
    }
    const remainder: BankLineRemainder = { kind: 'on_account', amountMinor: row.amount_minor, documentOpenMinor: null, feeOpenMinor: null };
    const linkId = writeLineLink(ctx, {
      bankTxnId: row.id,
      kind: 'payment',
      targetId: paymentId,
      state: 'booked',
      targetKind: 'contact',
      paymentId,
      entryId: vatEntryId ?? entryId,
      remainderMode: 'on_account',
      remainderMinor: row.amount_minor,
      note: refundNote(note, target),
      contactId: plan.contactId,
      claims: claimsOf(ctx, bankLedgerId, [entryId]),
    });
    // The Entgeltsminderung of a refunded Guthaben (owner, 21.10.2026), dated the refund line's date and
    // recorded against the refund line's decision, whose reopen reverses it.
    const correctionIds: string[] = [];
    for (const c of refundCorrection) {
      const done = clearAnzahlungVat(ctx, { id: c.paymentId, amountMinor: c.amountMinor }, c.cashMinor, { kind: 'refund', date: lineBookingDate(row), linkId });
      if ('error' in done) abort(done.error);
      if (done.entryId !== null) correctionIds.push(done.entryId);
    }
    if (correctionIds.length > 0) warnings.push('anzahlung_vat_refund_corrected');
    syncCreditRow(ctx, row, 'dismissed');
    ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: 'book', actor: ctx.actor, at: ctx.clock.now() });
    return ok<BookBankLineOk>({
      bankTxnId: row.id,
      state: 'booked',
      targetKind: 'contact',
      linkId,
      entryId,
      paymentId,
      paymentIds: [paymentId],
      remainder,
      differenceMinor: null,
      warnings,
      entryIds: [entryId, vatEntryId, ...correctionIds].filter((e): e is string => e !== null),
      contact: contactAnswer,
    });
  }
  const entry = plan.entry;
  if (entry === null) abort(err('internal_error', { reason: 'a contact plan carries a payment or an entry' }));
  const base = baseCurrencyOf(ctx);
  const description = (opts.text ?? entry.description).slice(0, MAX_TEXT);
  // Owner, 21.10.2026: on a Bankkonto in another currency the Anzahlung is FIXED in the base currency at
  // the receipt rate (the default of `bank.anzahlung_fx_mode`): a CONVERSION entry in the line's currency
  // carries the bank leg (claimed by the line) against the realised-FX account, and the base-currency
  // entry books that account against the Anzahlungen account. The decision names the base-currency entry
  // (the raw Storno refuses it, L3) and `reopen_bank_line` reverses both. Without a conversion (a
  // base-currency line, or the setting `foreign`) ONE entry in the line's own currency, as before.
  let conversionId: string | null = null;
  if (entry.conversion !== null) {
    const conv = postEntry(ctx, {
      date: lineBookingDate(row),
      source: 'camt',
      description: `${description}: Umrechnung ${entry.conversion.currency} zum Kurs ${entry.conversion.rate}`.slice(0, MAX_TEXT),
      // MINTED, never derived from the line alone (the A20 rule against a squattable key).
      idempotencyKey: `bankline-entry-${row.id}-${ctx.ids.next('ble')}`,
      lines: entry.conversion.lines,
      currency: entry.conversion.currency,
      fxRate: entry.conversion.rate,
    });
    if (!conv.ok) abort(conv);
    conversionId = conv.entryId;
  }
  const posted = postEntry(ctx, {
    date: lineBookingDate(row),
    source: 'camt',
    description,
    // MINTED, never derived from the line alone (the A20 rule against a squattable key).
    idempotencyKey: `bankline-entry-${row.id}-${ctx.ids.next('ble')}`,
    // The receipt VAT (owner, 21.10.2026) rides the base-currency entry: with the Anzahlungen account there is
    // no application step in TILL, so the manual reclassification to 1100 must reverse it (warned below).
    lines: vat === null ? entry.lines : [...entry.lines, ...vat.lines],
    // A line in its Bankkonto's own currency (the setting `foreign`) books in that currency at the stored
    // rate, exactly as an `accounts` booking does; a fixed Anzahlung's own entry is in the base currency.
    ...(row.currency !== base && entry.conversion === null ? { currency: row.currency } : {}),
  });
  if (!posted.ok) abort(posted);
  const entryId = posted.entryId;
  if (vat !== null) warnings.push('anzahlung_vat', 'anzahlung_vat_clears_on_reclassification');
  const linkId = writeLineLink(ctx, {
    bankTxnId: row.id,
    kind: 'journal_entry',
    targetId: entryId,
    state: 'booked',
    targetKind: 'contact',
    entryId,
    note,
    contactId: plan.contactId,
    claims: claimsOf(ctx, bankLedgerId, [conversionId ?? entryId]),
  });
  syncCreditRow(ctx, row, 'dismissed');
  ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: 'book', actor: ctx.actor, at: ctx.clock.now() });
  return ok<BookBankLineOk>({
    bankTxnId: row.id,
    state: 'booked',
    targetKind: 'contact',
    linkId,
    entryId,
    paymentId: null,
    paymentIds: [],
    remainder: null,
    differenceMinor: null,
    warnings,
    entryIds: conversionId === null ? [entryId] : [conversionId, entryId],
    ...(entry.conversion !== null
      ? { fx: { currency: entry.conversion.currency, foreignMinor: entry.conversion.foreignMinor, baseMinor: entry.conversion.baseMinor, rate: entry.conversion.rate } }
      : {}),
    contact: contactAnswer,
  });
}

/**
 * `expense_claims` (A39 §17.3): approved Spesen paid from a debit line, each through E02's OWN
 * reimbursement (`reimburseClaim`, the function `expense_claim_reimburse` runs), dated the line's booking
 * date, from the line's Bankkonto: one A14 payment per claim clearing 2260 (D95). Never a second posting
 * path. The line claims every payment's bank leg (their sum is the line, by the plan's check).
 */
function bookExpenseClaims(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  bankLedgerId: string,
  claimIds: readonly string[],
  warnings: string[],
): Result<BookBankLineOk> {
  const pays = ctx.capabilities.assert('pay');
  if (!pays.ok) abort(pays);
  const planned = planExpenseClaims(ctx, row, claimIds);
  if ('error' in planned) abort(planned.error);
  if (planned.plan.refusal !== null) abort(planned.plan.refusal);
  const date = lineBookingDate(row);
  const paymentIds: string[] = [];
  for (const claim of planned.plan.claims) {
    const paid = reimburseClaim(
      ctx,
      {
        claimId: claim.claimId,
        bankAccountId: bankLedgerId,
        confirm: true,
        // MINTED: E02 memoises under (claim, key), and no caller can know this one.
        idempotencyKey: `bankline-spesen-${row.id}-${ctx.ids.next('bls')}`,
      },
      { date, source: 'camt' },
    );
    if (!paid.ok) abort(paid as Err);
    if (paid['alreadyReimbursed'] === true || typeof paid['paymentId'] !== 'string') {
      abort(bankTargetRefusal('claim_not_approved', { claimId: claim.claimId, status: 'reimbursed' }));
    }
    paymentIds.push(paid['paymentId'] as string);
  }
  const entryIds = paymentIds.map((p) => paymentEntryOf(ctx, p)).filter((e): e is string => e !== null);
  const linkId = writeLineLink(ctx, {
    bankTxnId: row.id,
    kind: 'payment',
    targetId: paymentIds[0] as string,
    state: 'booked',
    targetKind: 'expense_claims',
    paymentId: paymentIds[0] ?? null,
    entryId: entryIds[0] ?? null,
    claims: claimsOf(ctx, bankLedgerId, entryIds),
  });
  ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: 'book', actor: ctx.actor, at: ctx.clock.now() });
  return ok<BookBankLineOk>({
    bankTxnId: row.id,
    state: 'booked',
    targetKind: 'expense_claims',
    linkId,
    entryId: entryIds[0] ?? null,
    paymentId: paymentIds[0] ?? null,
    paymentIds,
    remainder: null,
    differenceMinor: null,
    warnings,
    entryIds,
    claimIds: planned.plan.claims.map((c) => c.claimId),
  });
}

/** What an `accounts` target with foreign-currency legs books: both entries' lines and the effective rate. */
export interface FxBookingPlan {
  currency: string;
  foreignMinor: number;
  baseMinor: number;
  rate: string;
  /** The realised-FX account the conversion runs through (A14's role, by the line's direction). */
  conversionAccountId: string;
  /** The conversion entry, in `currency` at `rate`: each FX leg against the conversion account. */
  conversionLines: LineInput[];
  /** The bank entry, in the base currency: the bank against the conversion account and every base leg. */
  bankLines: LineInput[];
}

/**
 * D178 E3 (A39 §17.4): the plan of an `accounts` booking whose legs carry `fx`. Pure reads. Because an
 * entry carries ONE currency (A02 §H-FX), the counter-legs in the transaction currency are booked in a
 * CONVERSION entry against the realised-FX account (4906 on a debit line, 3806 on a credit line) at the
 * EFFECTIVE rate (their CHF divided by their foreign amount, twelve decimals), and the bank entry books the
 * bank against that same account in CHF beside every base leg. The realised-FX account nets to zero, and
 * no foreign line ever lands on a balance-sheet account: the bank ledger only holds CHF, so neither A22's
 * revaluation nor A40's liquidity sees a foreign position that does not exist.
 */
export function planFxAccounts(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  bankLedgerId: string,
  target: Extract<BookBankLineTarget, { kind: 'accounts' }>,
): { plan: FxBookingPlan } | { error: Err } {
  const base = baseCurrencyOf(ctx);
  if (row.currency !== base) return { error: bankTargetRefusal('fx_leg_needs_base_line', { bankTxnId: row.id, lineCurrency: row.currency, baseCurrency: base }) };
  if (target.viaAccountId !== undefined) {
    return { error: err('invalid_input', { field: 'target.viaAccountId', reason: 'a booking with a foreign-currency leg runs through the conversion entry, not a Durchlaufkonto' }) };
  }
  const fxLegs = target.legs.map((l, i) => ({ leg: l, i })).filter((x) => x.leg.fx !== undefined);
  const currency = fxLegs[0]!.leg.fx!.currency;
  // An own-account transfer is never part of a booking with a foreign leg: it books on its own, where the
  // transfer guard of `bookToAccounts` (critic A39R2-2) can see it.
  for (let i = 0; i < target.legs.length; i += 1) {
    const own = ctx.store.db
      .prepare('SELECT 1 AS p FROM bank_account WHERE workspace_id = ? AND ledger_account_id = ? LIMIT 1')
      .get(ctx.workspaceId, target.legs[i]!.accountId);
    if (own !== undefined) {
      return { error: err('invalid_input', { field: `target.legs[${i}].accountId`, reason: 'a transfer between own accounts books on its own, without a foreign-currency leg' }) };
    }
  }
  for (const { leg, i } of fxLegs) {
    const fx = leg.fx!;
    if (fx.currency !== currency || fx.currency === base) {
      return { error: bankTargetRefusal('fx_currency_mismatch', { field: `target.legs[${i}].fx.currency`, currency: fx.currency, expectedCurrency: currency, baseCurrency: base }) };
    }
    if (leg.taxCode !== undefined) return { error: bankTargetRefusal('fx_leg_vat_refused', { field: `target.legs[${i}].taxCode`, taxCode: leg.taxCode }) };
    if (leg.amountMinor <= 0) {
      return { error: err('invalid_input', { field: `target.legs[${i}].amountMinor`, reason: "a foreign-currency leg runs in the line's direction" }) };
    }
    const account = ctx.store.db
      .prepare('SELECT id, number, type, archived FROM account WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, leg.accountId) as { id: string; number: string; type: string; archived: number } | undefined;
    if (account === undefined) return { error: err('not_found', { field: `target.legs[${i}].accountId`, accountId: leg.accountId }) };
    if (account.archived === 1) return { error: err('account_archived', { accountId: leg.accountId }) };
    if (account.type !== 'income' && account.type !== 'expense') {
      return { error: bankTargetRefusal('invalid_fx_leg_account', { field: `target.legs[${i}].accountId`, accountId: account.id, accountNumber: account.number, accountType: account.type }) };
    }
  }
  const moneyIn = row.credit_debit === 'CRDT';
  const role = resolveRole(ctx, moneyIn ? 'salesFxRealised' : 'purchaseFxRealised');
  if (isRejection(role)) return { error: role as Err };
  const baseMinor = fxLegs.reduce((s, x) => s + x.leg.amountMinor, 0);
  const foreignMinor = fxLegs.reduce((s, x) => s + x.leg.fx!.amountMinor, 0);
  // THE EFFECTIVE RATE: the CHF the bank booked for these legs over their foreign amount, half up at twelve
  // decimals. Its conversion of the foreign total gives back the CHF exactly (checked below), so nothing is
  // left for a revaluation to find.
  const scaled = (BigInt(baseMinor) * RATE_SCALE * 2n + BigInt(foreignMinor)) / (BigInt(foreignMinor) * 2n);
  if (scaled <= 0n || scaled > RATE_MAX_SCALED) {
    return { error: err('invalid_input', { field: 'target.legs', reason: 'the CHF and foreign amounts give no usable rate' }) };
  }
  const rate = formatRate(scaled);
  // The conversion entry: each FX leg in the transaction currency against the conversion account.
  const conversionLines: LineInput[] = [];
  for (const { leg } of fxLegs) {
    const f = leg.fx!.amountMinor;
    conversionLines.push(moneyIn ? { account: leg.accountId, credit: f } : { account: leg.accountId, debit: f });
  }
  conversionLines.push(moneyIn ? { account: role.id, debit: foreignMinor } : { account: role.id, credit: foreignMinor });
  const previewed = previewPostingLines(ctx, { date: lineBookingDate(row), source: 'camt', lines: conversionLines, currency, fxRate: rate });
  if (!previewed.ok) return { error: previewed.error };
  // Every FX leg's CHF must be what the one rate gives it (an entry has one rate, allocated by largest
  // remainder); the conversion account's CHF must be the legs' total.
  const yielded = previewed.lines.slice(0, fxLegs.length).map((l) => l.baseDebit + l.baseCredit);
  const convBase = previewed.lines[fxLegs.length]!;
  const mismatch = fxLegs.some((x, k) => yielded[k] !== x.leg.amountMinor) || convBase.baseDebit + convBase.baseCredit !== baseMinor;
  if (mismatch) {
    return {
      error: bankTargetRefusal('fx_leg_amounts_inconsistent', {
        rate,
        legs: fxLegs.map((x, k) => ({ legIndex: x.i, amountMinor: x.leg.amountMinor, foreignMinor: x.leg.fx!.amountMinor, yieldedMinor: yielded[k] ?? null })),
      }),
    };
  }
  // The bank entry: the FX legs collapse into ONE leg on the conversion account (their CHF, no MWST),
  // beside every base leg, built exactly as any `accounts` booking.
  const bankLegs: BankLineLeg[] = [
    { accountId: role.id, amountMinor: baseMinor, description: `Umrechnung ${currency}` },
    ...target.legs.filter((l) => l.fx === undefined),
  ];
  const built = buildAccountsLines(ctx, row, bankLedgerId, bankLegs, lineBookingDate(row));
  if ('error' in built) return { error: built.error };
  return { plan: { currency, foreignMinor, baseMinor, rate, conversionAccountId: role.id, conversionLines, bankLines: built.lines } };
}

/**
 * D178 E3 (A39 §17.4): book an `accounts` target with foreign-currency legs: the caller's acknowledgement of
 * the `fx_counter_leg` consequence first, then the CONVERSION entry and the BANK entry (`planFxAccounts`),
 * one decision. The decision names the conversion entry (so the raw Storno refuses it, L3) and claims the
 * bank entry's bank leg; `reopen_bank_line` reverses both.
 */
function bookToAccountsFx(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  bankLedgerId: string,
  target: Extract<BookBankLineTarget, { kind: 'accounts' }>,
  opts: { text?: string | undefined; ruleId?: string },
  warnings: string[],
): Result<BookBankLineOk> {
  const planned = planFxAccounts(ctx, row, bankLedgerId, target);
  if ('error' in planned) abort(planned.error);
  const plan = planned.plan;
  if (target.acknowledgeFx !== true) {
    abort(bankTargetRefusal('fx_ack_required', { consequence: FX_COUNTER_LEG_CONSEQUENCE, acknowledge: 'target.acknowledgeFx' }));
  }
  // Critic E3-L1: one source for these warnings, shared with the preview (`composeFx`). `performBooking`
  // has already put `reversal_line` first when the line carries the reversal flag.
  for (const w of fxBookingWarnings(ctx, row, target)) if (!warnings.includes(w)) warnings.push(w);
  const date = lineBookingDate(row);
  const description = (opts.text ?? defaultBankText(ctx, row)).slice(0, MAX_TEXT);
  const major = (minor: number) => (minor / 100).toFixed(2);
  const conversion = postEntry(ctx, {
    date,
    source: 'camt',
    description: `${description}: Umrechnung ${plan.currency} ${major(plan.foreignMinor)} zum Kurs ${plan.rate}`.slice(0, MAX_TEXT),
    // MINTED, never derived from the line alone (the A20 rule against a squattable key).
    idempotencyKey: `bankline-entry-${row.id}-${ctx.ids.next('ble')}`,
    lines: plan.conversionLines,
    currency: plan.currency,
    fxRate: plan.rate,
  });
  if (!conversion.ok) abort(conversion);
  const bankEntry = postEntry(ctx, {
    date,
    source: 'camt',
    description,
    idempotencyKey: `bankline-entry-${row.id}-${ctx.ids.next('ble')}`,
    lines: plan.bankLines,
  });
  if (!bankEntry.ok) abort(bankEntry);
  const linkId = writeLineLink(ctx, {
    bankTxnId: row.id,
    kind: 'journal_entry',
    targetId: conversion.entryId,
    state: 'booked',
    targetKind: 'accounts',
    entryId: conversion.entryId,
    ruleId: opts.ruleId ?? null,
    claims: claimsOf(ctx, bankLedgerId, [bankEntry.entryId]),
  });
  syncCreditRow(ctx, row, 'dismissed');
  ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: 'book', actor: ctx.actor, at: ctx.clock.now() });
  return ok<BookBankLineOk>({
    bankTxnId: row.id,
    state: 'booked',
    targetKind: 'accounts',
    linkId,
    entryId: conversion.entryId,
    paymentId: null,
    paymentIds: [],
    remainder: null,
    differenceMinor: null,
    warnings,
    entryIds: [conversion.entryId, bankEntry.entryId],
    fx: { currency: plan.currency, foreignMinor: plan.foreignMinor, baseMinor: plan.baseMinor, rate: plan.rate },
  });
}

/**
 * Critic E3-L1: the warnings a booking with a foreign-currency leg answers, in the order the booking gives
 * them: `reversal_line` (a reversal-flagged line), `control_account_leg` (a leg on 1100/2000) and
 * `fx_counter_leg`. The preview and the booking both read them here, so they cannot disagree.
 */
function fxBookingWarnings(ctx: WorkspaceContext, row: BankTxnRow, target: Extract<BookBankLineTarget, { kind: 'accounts' }>): string[] {
  const out = row.reversal_ind === 1 ? ['reversal_line'] : [];
  if (target.legs.some((l) => controlAccountRoleOf(ctx, l.accountId) !== null)) out.push('control_account_leg');
  out.push('fx_counter_leg');
  return out;
}

/** The decision note with a stated refund-VAT choice that differs from the setting, and its reason. */
function refundNote(note: string | null, target: Extract<BookBankLineTarget, { kind: 'contact' }>): string | null {
  if (target.beyondGuthaben === true) note = (note === null ? 'Rückzahlung über das Guthaben hinaus' : `${note}; Rückzahlung über das Guthaben hinaus`).slice(0, MAX_TEXT);
  if (target.refundVat === undefined) return note;
  const reason = typeof target.overrideReason === 'string' ? target.overrideReason.trim() : '';
  const stated = `MWST bei Rückzahlung: ${target.refundVat}${reason.length > 0 ? `; Grund: ${reason}` : ''}`;
  return (note === null ? stated : `${note}; ${stated}`).slice(0, MAX_TEXT);
}

/** The default text of a booking from a bank line: the counterparty and the remittance, else the line's reference. */
function defaultBankText(ctx: WorkspaceContext, row: BankTxnRow): string {
  const detail = ctx.store.db
    .prepare('SELECT counterparty_name, remittance_text FROM bank_txn_detail WHERE workspace_id = ? AND bank_txn_id = ?')
    .get(ctx.workspaceId, row.id) as { counterparty_name: string | null; remittance_text: string | null } | undefined;
  const fallback = [detail?.counterparty_name ?? row.payer_name, detail?.remittance_text ?? row.entry_ref]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(', ');
  return fallback.length > 0 ? `Bank: ${fallback}` : `Bankbuchung ${row.entry_ref ?? row.id}`;
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
 *
 * D175 (A39 §14.2): with `viaAccountId` the entry runs through that Durchlaufkonto: the bank leg against
 * it for the line amount, then each leg against it with the leg's own VAT expansion (unchanged), one
 * Durchlaufkonto line per leg, so it nets to zero inside the one entry. The Durchlaufkonto must pass the
 * account check (`invalid_account` with the field `target.viaAccountId`): not archived, no Bankkonto's
 * ledger, no control or VAT account, no income or expense account, and no leg's own account.
 */
export function buildAccountsLines(
  ctx: WorkspaceContext,
  row: BankTxnRow,
  bankLedgerId: string,
  legs: readonly BankLineLeg[],
  supplyDate: string,
  viaAccountId?: string,
): { lines: LineInput[] } | { error: Err } {
  const sum = legs.reduce((s, l) => s + l.amountMinor, 0);
  if (sum !== row.amount_minor) {
    return { error: err('legs_do_not_sum', { bankTxnId: row.id, expectedMinor: row.amount_minor, sumMinor: sum }) };
  }
  if (viaAccountId !== undefined) {
    const via = ctx.store.db
      .prepare('SELECT id, number, type, archived FROM account WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, viaAccountId) as { id: string; number: string; type: string | null; archived: number } | undefined;
    if (via === undefined) return { error: err('not_found', { field: 'target.viaAccountId', accountId: viaAccountId }) };
    const invalid = via.id === bankLedgerId ? 'bank_ledger' : invalidViaReason(ctx, via);
    if (invalid !== null) return { error: err('invalid_account', { field: 'target.viaAccountId', accountId: via.id, accountNumber: via.number, reason: invalid }) };
    if (legs.some((l) => l.accountId === via.id)) {
      return { error: err('invalid_account', { field: 'target.viaAccountId', accountId: via.id, accountNumber: via.number, reason: 'via_is_a_leg' }) };
    }
  }
  // Every leg books against this account: the bank's ledger, or the Durchlaufkonto.
  const counter = viaAccountId ?? bankLedgerId;
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
      out.push(legIn ? { account: counter, debit: abs } : { account: counter, credit: abs });
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
      out.push(legIn ? { account: counter, debit: abs } : { account: counter, credit: abs });
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
        counterAccount: counter,
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
  if (viaAccountId !== undefined) {
    // The Durchlaufkonto keeps ONE line per leg (each leg's counter-line), so a reader sees which leg each
    // movement belongs to; the bank moves once, against it, for the line amount.
    let viaNet = 0;
    const kept: LineInput[] = [];
    for (const l of out) {
      if ((l.debit ?? 0) === 0 && (l.credit ?? 0) === 0) continue;
      if (l.account === viaAccountId && l.taxCode === undefined) viaNet += (l.debit ?? 0) - (l.credit ?? 0);
      kept.push(l);
    }
    if (viaNet !== signedAmountOf(row)) {
      return { error: err('vat_split_mismatch', { bankTxnId: row.id, expectedMinor: signedAmountOf(row), bankLegMinor: viaNet }) };
    }
    const amount = Math.abs(viaNet);
    const head: LineInput[] =
      viaNet >= 0
        ? [{ account: bankLedgerId, debit: amount }, { account: viaAccountId, credit: amount }]
        : [{ account: bankLedgerId, credit: amount }, { account: viaAccountId, debit: amount }];
    return { lines: [...head, ...kept] };
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
  opts: { text?: string | undefined; ruleId?: string },
  warnings: string[],
  viaAccountId?: string,
): Result<BookBankLineOk> {
  const date = lineBookingDate(row);
  const built = buildAccountsLines(ctx, row, bankLedgerId, legs, lineBookingDate(row), viaAccountId);
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
    // Critic D175-C5: the Buchungsregel that booked the line, on the decision row itself.
    ruleId: opts.ruleId ?? null,
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
  /**
   * D176: the "Nicht buchen" Buchungsregel the person accepts. Recorded on the decision (`rule_id`), so the
   * rule's next step (its follow-up Vorlage) is offered once the line is ignored. It must be a live bank rule
   * of this workspace with the outcome `ignore`, for the line's counterparty and direction.
   */
  standardId?: string;
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
/**
 * D177 (critic D177-C1): `ignore_bank_line`'s own validation with NOTHING written, the dial's pre-draft
 * screen (`ActionDef.prevalidate`): the input guards, the reason and the note, the line (`not_found`,
 * `line_not_open`), and the §15.6 `standardId` checks, answering the direct call's own refusal. An already
 * ignored line answers nothing (the direct call answers ok, `alreadyIgnored`), and so does a same-key replay.
 */
export function prevalidateIgnoreBankLine(ctx: WorkspaceContext, input: IgnoreBankLineInput): Err | undefined {
  const screened = screenIgnore(ctx, input);
  if ('error' in screened) return screened.error;
  // Critic D177-R2-1: as for a booking, a key whose decision was undone does not screen a new one.
  if ('replayed' in screened) return spentKeyOnOpenLine(ctx, input.bankTxnId as string, input.idempotencyKey as string);
  return undefined;
}

/**
 * Critic D177-R2-1: the pre-draft screen's answer for an idempotency key whose memo exists. While the line
 * is still decided the memo is a genuine retry (undefined: the verb replays it). While the line is OPEN
 * again, the key already decided it once and its replay would answer that old decision and do nothing, so
 * the draft is refused `idempotency_key_conflict` (a new decision takes a new key) and never counts as
 * screened.
 */
function spentKeyOnOpenLine(ctx: WorkspaceContext, bankTxnId: string, idempotencyKey: string): Err | undefined {
  const row = readBankTxn(ctx, bankTxnId);
  if (row === undefined || lineStateOf(ctx, row).state !== 'open') return undefined;
  return err('idempotency_key_conflict', {
    bankTxnId: row.id,
    idempotencyKey,
    reason: 'this key already decided the line before it was reopened; its replay would decide nothing. Propose the new decision under a new key',
  });
}

/** The checks `ignore_bank_line` makes before it writes, shared with its pre-draft screen. */
function screenIgnore(
  ctx: WorkspaceContext,
  input: IgnoreBankLineInput,
): { error: Err } | { replayed: Result<IgnoreBankLineOk> } | { already: IgnoreBankLineOk } | { row: BankTxnRow; scopedKey: string } {
  const guard =
    requireString(input.bankTxnId, 'bankTxnId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    requireString(input.reason, 'reason') ??
    optionalText(input.note, 'note') ??
    (input.standardId !== undefined ? requireString(input.standardId, 'standardId') : null);
  if (guard) return { error: guard };
  if (!(BANK_LINE_IGNORE_REASONS as readonly string[]).includes(input.reason as string)) {
    return { error: err('invalid_input', { field: 'reason', allowed: [...BANK_LINE_IGNORE_REASONS] }) };
  }
  if (typeof input.note === 'string' && input.note.length > MAX_TEXT) return { error: err('invalid_input', { field: 'note', maxLength: MAX_TEXT }) };
  const scopedKey = JSON.stringify(['ignore_bank_line', input.bankTxnId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<IgnoreBankLineOk>>(ctx.workspaceId, scopedKey, 'ignore_bank_line');
  if (replayed !== undefined) return { replayed };
  const row = readBankTxn(ctx, input.bankTxnId as string);
  if (row === undefined) return { error: err('not_found', { bankTxnId: input.bankTxnId }) };
  const current = lineStateOf(ctx, row);
  if (current.state === 'ignored') {
    return {
      already: {
        bankTxnId: row.id,
        state: 'ignored',
        linkId: current.link?.linkId ?? null,
        reason: current.link?.ignoreReason ?? 'other',
        alreadyIgnored: true,
      },
    };
  }
  if (current.state !== 'open') return { error: lineNotOpen(row, current.state, current.link) };
  if (input.standardId !== undefined) {
    const rule = readLiveRule(ctx, input.standardId);
    if (rule === undefined) return { error: err('rule_not_found', { standardId: input.standardId }) };
    if (rule.scope !== 'bank') return { error: err('wrong_scope', { standardId: rule.id, scope: rule.scope, reason: 'a Vorlage never decides a bank line' }) };
    if (rule.outcome !== 'ignore') {
      return { error: err('wrong_outcome', { standardId: rule.id, outcome: rule.outcome, reason: 'this rule books its legs: book_bank_line with target {kind: rule}' }) };
    }
    if (counterpartyKeyOf(row, readBankTxnDetail(ctx, row.id)) !== rule.counterparty_key || directionOf(row) !== rule.direction) {
      return { error: err('rule_not_applicable', { standardId: rule.id, bankTxnId: row.id, reason: 'the rule is for another counterparty or direction' }) };
    }
  }
  return { row, scopedKey };
}

export function ignoreBankLine(ctx: WorkspaceContext, input: IgnoreBankLineInput): Result<IgnoreBankLineOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const screened = screenIgnore(ctx, input);
  if ('error' in screened) return screened.error;
  if ('replayed' in screened) return screened.replayed;
  if ('already' in screened) return ok<IgnoreBankLineOk>(screened.already);
  const { row, scopedKey } = screened;
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
        ...(input.standardId !== undefined ? { ruleId: input.standardId } : {}),
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
  /** D177: the Vorschläge the undone decision had closed as "Zeile entschieden" and that are pending again. */
  revivedActionIds?: string[];
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
          // D178 E3: a Spesen settlement created one payment per claim; every one of them is the
          // decision's, read off its own claims (the declared bank legs), never guessed.
          const paymentIds = link.targetKind === 'expense_claims' ? paymentsOfLink(ctx, link.linkId) : [link.paymentId];
          for (const paymentId of paymentIds) {
            reverseOnePayment(ctx, row, paymentId);
            reversedPaymentIds.push(paymentId);
          }
          // Owner, 21.10.2026: a Guthaben whose receipt VAT was booked. Reversing the payment unwound its
          // applications, so every VAT clearing they posted is reversed, then the receipt VAT (the entry the
          // decision names when it is not the payment's own).
          if (link.targetKind === 'contact') {
            // A refund line's own Entgeltsminderung corrections (owner, 21.10.2026).
            for (const correction of anzahlungVatCorrectionsOfLink(ctx, link.linkId)) {
              if (reversalOf(ctx, correction) !== null) continue;
              reverseOneEntry(ctx, row, correction, input.reason as string);
              reversedEntryIds.push(correction);
            }
            for (const clearing of anzahlungVatClearingsOf(ctx, link.paymentId)) {
              if (reversalOf(ctx, clearing) !== null) continue;
              reverseOneEntry(ctx, row, clearing, input.reason as string);
              reversedEntryIds.push(clearing);
            }
            const paymentEntry = paymentEntryOf(ctx, link.paymentId);
            if (link.entryId !== null && link.entryId !== paymentEntry) {
              reverseOneEntry(ctx, row, link.entryId, input.reason as string);
              reversedEntryIds.push(link.entryId);
            }
          }
          creditPaymentReversed = link.paymentId;
        } else if (link.kind === 'journal_entry' && link.entryId !== null) {
          // D178 E3: a booking with a foreign counter-leg posted a conversion entry (the decision's
          // `entryId`) and a bank entry (its claim); both are the decision's and both are reversed.
          for (const entryId of entriesOfLink(ctx, link.linkId, link.entryId)) {
            reverseOneEntry(ctx, row, entryId, input.reason as string);
            reversedEntryIds.push(entryId);
          }
        }
      }
      syncCreditRow(ctx, row, 'open', { reversedPaymentId: creditPaymentReversed });
      ctx.audit.record({ entityKind: 'bank_txn', entityId: row.id, action: 'reopen', actor: ctx.actor, at: ctx.clock.now() });
      // D177 (the UX walk): undoing the decision gives back the Vorschläge it closed.
      const revivedActionIds = supersededLinkId === null ? [] : reviveLineDraftsOnReopen(ctx, row, supersededLinkId);
      return ok<ReopenBankLineOk>({
        bankTxnId: row.id,
        previousState: current.state,
        state: 'open',
        supersededLinkId,
        reversedEntryIds,
        reversedPaymentIds,
        warnings,
        alreadyOpen: false,
        ...(revivedActionIds.length > 0 ? { revivedActionIds } : {}),
      });
    }),
  );
}

/** D177: the reason a Vorschlag keeps when the undo of the decision that closed it cannot give it back. */
export const DRAFT_NOT_REVIVED_STALE = 'Zeile entschieden; nach Rückgängig nicht wiederhergestellt, weil sich die Daten seither geändert haben';
export const DRAFT_NOT_REVIVED_INVALID = 'Zeile entschieden; nach Rückgängig nicht wiederhergestellt, weil der Vorschlag so nicht mehr gebucht werden kann';

/**
 * D177 (the UX walk on a real-shaped book, 16.10.2026): an UNDO restores the state before it. When
 * `reopen_bank_line` undoes a decision (an ignore, or a booking it reverses), every Vorschlag THAT
 * decision closed as "Zeile entschieden" (`closed_by_link_id`) is pending again, in the reopen's own
 * transaction, tenant-bound, and its drafting call's trace resolution is cleared. Only a draft that can
 * still run: not committed (D165), its pin unchanged since it was drafted (else it stays rejected, with
 * the reason saying the data changed since), and passing the same screen as at draft time (the verb's
 * `prevalidate`; else it stays rejected, with the reason saying it can no longer book). A draft a person
 * rejected or a newer one replaced ("ersetzt") is never touched: only the decision's own closures are.
 * A draft that stays rejected loses its `closed_by_link_id`, so a later reopen never considers it again.
 */
function reviveLineDraftsOnReopen(ctx: WorkspaceContext, row: BankTxnRow, linkId: string): string[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT id, action_tool, payload_json, pin_digest FROM agent_action
        WHERE workspace_id = ? AND status = 'rejected' AND reject_reason = ? AND closed_by_link_id = ? AND committed_at IS NULL
        ORDER BY created_at, rowid`,
    )
    .all(ctx.workspaceId, DRAFT_LINE_DECIDED_REASON, linkId) as { id: string; action_tool: string; payload_json: string; pin_digest: string | null }[];
  const revive = ctx.store.db.prepare(
    `UPDATE agent_action SET status = 'pending', resolved_at = NULL, resolved_by = NULL, reject_reason = NULL, closure_kind = NULL, closed_by_link_id = NULL
      WHERE workspace_id = ? AND id = ? AND status = 'rejected' AND closed_by_link_id = ?`,
  );
  const keepStmt = ctx.store.db.prepare('UPDATE agent_action SET reject_reason = ?, closed_by_link_id = NULL WHERE workspace_id = ? AND id = ?');
  // Critic D177-R4-1: a Vorschlag that stays closed says why in its history too.
  const keep = {
    run(reason: string, workspaceId: string, id: string): void {
      keepStmt.run(reason, workspaceId, id);
      appendDraftHistory(ctx, id, { event: 'not_revived', at: ctx.clock.now(), by: ctx.actor, undoneLinkId: linkId, reason });
    },
  };
  const trace = ctx.store.db.prepare('UPDATE agent_call SET resolved_by = NULL, resolved_at = NULL, entity_ref = NULL WHERE workspace_id = ? AND agent_action_id = ?');
  const revived: string[] = [];
  for (const r of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(r.payload_json) as Record<string, unknown>;
    } catch {
      keep.run(DRAFT_NOT_REVIVED_INVALID, ctx.workspaceId, r.id);
      continue;
    }
    if (payload['bankTxnId'] !== row.id) continue;
    if (r.pin_digest !== null && pinFor(ctx, r.action_tool, payload)?.digest !== r.pin_digest) {
      keep.run(DRAFT_NOT_REVIVED_STALE, ctx.workspaceId, r.id);
      continue;
    }
    const screened =
      r.action_tool === 'book_bank_line'
        ? prevalidateBookBankLine(ctx, payload as BookBankLineInput)
        : r.action_tool === 'ignore_bank_line'
          ? prevalidateIgnoreBankLine(ctx, payload as IgnoreBankLineInput)
          : err('invalid_input', { field: 'actionTool' });
    if (screened !== undefined) {
      keep.run(DRAFT_NOT_REVIVED_INVALID, ctx.workspaceId, r.id);
      continue;
    }
    if (revive.run(ctx.workspaceId, r.id, linkId).changes === 0) continue;
    // Critic D177-R4-1: the round trip stays on record (closed by the decision, revived by its undo). The
    // drafting call's trace describes the CURRENT state, so its resolution is cleared.
    appendDraftHistory(ctx, r.id, { event: 'revived', at: ctx.clock.now(), by: ctx.actor, undoneLinkId: linkId });
    trace.run(ctx.workspaceId, r.id);
    revived.push(r.id);
  }
  // Critic D177-R4-2: one pending Vorschlag per seat and line, as at draft time. Among a seat's pending
  // Vorschläge for the line (the revived ones included), the newest stays and every older one is
  // "ersetzt" by it, recorded exactly as a draft-time supersede.
  const pendingOfLine = (
    ctx.store.db
      .prepare(
        `SELECT id, actor, payload_json FROM agent_action
          WHERE workspace_id = ? AND status = 'pending' AND committed_at IS NULL AND action_tool IN ('book_bank_line', 'ignore_bank_line')
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(ctx.workspaceId) as { id: string; actor: string; payload_json: string }[]
  ).filter((p) => {
    try {
      return (JSON.parse(p.payload_json) as { bankTxnId?: unknown }).bankTxnId === row.id;
    } catch {
      return false;
    }
  });
  const newestOfSeat = new Map<string, string>();
  const supersede = ctx.store.db.prepare(
    `UPDATE agent_action SET status = 'rejected', resolved_at = ?, resolved_by = ?, reject_reason = ?, closure_kind = 'superseded'
      WHERE workspace_id = ? AND id = ? AND status = 'pending' AND committed_at IS NULL`,
  );
  const superseded = new Set<string>();
  for (const p of pendingOfLine) {
    const newest = newestOfSeat.get(p.actor);
    if (newest === undefined) {
      newestOfSeat.set(p.actor, p.id);
      continue;
    }
    const now = ctx.clock.now();
    if (supersede.run(now, ctx.actor, DRAFT_SUPERSEDED_REASON, ctx.workspaceId, p.id).changes === 0) continue;
    appendDraftHistory(ctx, p.id, { event: 'closed', kind: 'superseded', at: now, by: ctx.actor, reason: DRAFT_SUPERSEDED_REASON, replacedBy: newest });
    ctx.store.db.prepare('UPDATE agent_call SET resolved_by = ?, resolved_at = ?, entity_ref = ? WHERE workspace_id = ? AND agent_action_id = ?').run(ctx.actor, now, newest, ctx.workspaceId, p.id);
    superseded.add(p.id);
  }
  return revived.filter((id) => !superseded.has(id));
}

/**
 * D178 E3: the entries a BOOKED journal decision created: its own `entryId` first, then every other
 * entry whose bank leg the decision claims and that a bank line posted (source `camt`): the bank entry of a
 * booking with a foreign counter-leg. For every other booking the claim names the same entry, so this is
 * the one entry it always was.
 */
function entriesOfLink(ctx: WorkspaceContext, linkId: string, entryId: string): string[] {
  const claimed = ctx.store.db
    .prepare(
      `SELECT c.entry_id AS e FROM bank_line_claim c JOIN journal_entry e ON e.id = c.entry_id AND e.workspace_id = c.workspace_id
        WHERE c.workspace_id = ? AND c.link_id = ? AND e.source = 'camt' ORDER BY c.rowid`,
    )
    .all(ctx.workspaceId, linkId) as { e: string }[];
  const out = [entryId];
  for (const c of claimed) if (!out.includes(c.e)) out.push(c.e);
  return out;
}

/** D178 E3: the posted payments whose entries a decision claims (a Spesen settlement's one per claim). */
function paymentsOfLink(ctx: WorkspaceContext, linkId: string): string[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT p.id AS id FROM bank_line_claim c
         JOIN payment p ON p.workspace_id = c.workspace_id AND p.journal_entry_id = c.entry_id
        WHERE c.workspace_id = ? AND c.link_id = ? AND p.status = 'posted' ORDER BY c.rowid`,
    )
    .all(ctx.workspaceId, linkId) as { id: string }[];
  return [...new Set(rows.map((r) => r.id))];
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
