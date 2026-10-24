/**
 * A2, the bank inbox: the read models the surface renders and the pure rules it applies.
 *
 * EVERY FIGURE IS THE ENGINE'S. The lines, their one state, the proposal with its certainty and its
 * reason, the receipt count and the per-account balance truth come from `list_bank_inbox`; the lines an
 * `accounts` booking posts, its VAT legs included, come from `compose_entry` (`bankCompose.ts`, the
 * Journal composer's read, D152 amendment). What this file adds is arrangement, never arithmetic the
 * engine did not do: which verb target a row's draft becomes and which words a reason code reads as.
 *
 * The engine's types are imported as TYPES (erased at build), so the Studio reads the shapes the
 * engine declares and the bundle gains no engine code (`studio-sees-payloads.test.mjs`).
 */
import type { BankAccountBalance, BankInboxLine, ListBankInboxOk } from '../../../../src/core/banking/bankInbox';
import type { BankLineProposal } from '../../../../src/core/banking/bankProposals';
// The ONE asset-range predicate the composer and the bill drawer read too (owner D152 point 5, 04.10.2026).
// An explicit `.ts` specifier: root suites import this module through Node's type stripping.
import { isVatAssetAccount } from '../Journal/composerPayload.ts';
// Type-only: the root suites load this module straight through Node's type stripping, which cannot
// follow the Agent model's JSON and i18n imports, so the parser below stays local.
import type { VorschlagFigures } from '../Agent/model';

export type { BankAccountBalance, BankInboxLine, BankLineProposal };

// --- The closed enumerations, mirrored (guarded by test/style/studio-mirrors-engine-enums.test.mjs) ---

/** A bank line's one state (`bankLines.ts`). */
export const BANK_LINE_STATES = ['open', 'booked', 'matched', 'ignored'] as const;
export type LineState = (typeof BANK_LINE_STATES)[number];

/** Why a line is ignored (`bankLines.ts`); the ignore form offers exactly these. */
export const BANK_LINE_IGNORE_REASONS = ['booked_elsewhere', 'clearing_account', 'before_start', 'duplicate', 'other'] as const;
export type IgnoreReason = (typeof BANK_LINE_IGNORE_REASONS)[number];

/** How sure a proposal is (`bankProposals.ts`). */
export const BANK_PROPOSAL_CERTAINTIES = ['sure', 'learned', 'check', 'open'] as const;
export type Certainty = (typeof BANK_PROPOSAL_CERTAINTIES)[number];

/** Why a proposal says what it says (`bankProposals.ts`); every one has a sentence in both locales. */
export const BANK_PROPOSAL_REASONS = [
  'existing_entry_reference',
  'existing_entry_amount_date',
  'qr_reference_exact',
  'qr_reference_amount_differs',
  'payment_batch_reference',
  'payment_batch_total_differs',
  'payment_batch_item',
  'payment_batch_item_amount_differs',
  'vendor_bill_reference',
  'vendor_bill_amount',
  'own_account_transfer',
  'own_account_transfer_booked',
  // D167: the counterparty's standard (certainty sure, the bulk button books it) and the journal rung.
  'standard',
  // D175: a Buchungsregel that asks for an amount (never bookable as it stands, never bulk) and the chooser.
  'rule_needs_amount',
  'several_rules',
  // D176: a "Nicht buchen" rule proposes ignoring the line with its reason and note.
  'rule_ignore',
  // D177 (A39 §16.1): a rule whose only unknowns are computed (`factor`) legs: prefilled, one click, `check`.
  'rule_computed',
  'history',
  'journal_history',
  'model_suggested',
  'no_proposal',
] as const;
export type ReasonCode = (typeof BANK_PROPOSAL_REASONS)[number];

/**
 * A14's control accounts by number (`payments/accounts.ts` ROLE_ACCOUNT_NUMBER: receivable 1100,
 * payable 2000). Money booked straight onto one moves a receivable or a payable with no document behind
 * it: a typed leg there books with the warning `control_account_leg`, which the panel shows BEFORE the
 * commit.
 */
export const CONTROL_ACCOUNT_NUMBERS: readonly string[] = ['1100', '2000'];

/** What happens to the part of a settlement that does not match the open amount (`bankLines.ts`). */
export const BANK_LINE_REMAINDER_MODES = ['leave_open', 'write_off', 'on_account'] as const;
export type RemainderMode = (typeof BANK_LINE_REMAINDER_MODES)[number];

// --- Option reads (other capabilities' verbs) -----------------------------------------------------

export interface BankAccountOption {
  id: string;
  name: string;
  iban: string;
  currency: string;
  ledgerAccountId: string | null;
}

export interface ChartAccount {
  id: string;
  number: string;
  name: string;
  vatCodeDefault: string | null;
  /** The chart's account type (`kmuSeed.ts` AccountType), or null when the read did not carry it. */
  type: string | null;
}

/** The KMU VAT accounts (`kmuSeed.ts`: 1170 / 1171 Vorsteuer, 2200 / 2201 Umsatzsteuer): never a VAT target. */
export const VAT_ACCOUNT_NUMBERS: readonly string[] = ['1170', '1171', '2200', '2201'];

/**
 * True when a VAT code can apply to a booking on this account (B2: the row's MWST shows only "where a
 * code can apply"; owner, 01.10.2026: "asset accounts get MWST"). The composer's rule exactly
 * (`Journal/composerPayload.ts isTaxBearing`): an Erfolgskonto (type income or expense) or an asset account
 * 12xx or 14xx to 17xx (`isVatAssetAccount`, the one shared predicate: Vorräte and Anlagevermögen), never a VAT account, and false for everything else, an account of unknown type
 * included. A default code is a pre-fill for an account that qualifies, never a reason to qualify. The
 * Bank adds one exclusion the composer cannot know: a Bankkonto's own ledger account (`bankLedgerIds`).
 */
export function vatCanApply(
  account: Pick<ChartAccount, 'id' | 'type' | 'number'> | undefined,
  bankLedgerIds: ReadonlySet<string> = new Set(),
): boolean {
  if (account === undefined || vatNeverApplies(account, bankLedgerIds)) return false;
  if (account.type === 'income' || account.type === 'expense') return true;
  return isVatAssetAccount(account);
}

/**
 * The code a leg takes when its account is chosen: the account's default where a code can apply (else
 * whatever the leg held), and none where it cannot, so a hidden MWST cell never carries a value.
 */
export function taxCodeOnChoosing(
  account: Pick<ChartAccount, 'id' | 'type' | 'number' | 'vatCodeDefault'> | undefined,
  held: string,
  bankLedgerIds: ReadonlySet<string> = new Set(),
): string {
  if (!vatCanApply(account, bankLedgerIds)) return '';
  return account?.vatCodeDefault ?? held;
}

/** A VAT account or a Bankkonto's ledger account: MWST is never offered there, whatever the leg holds. */
export function vatNeverApplies(account: Pick<ChartAccount, 'id' | 'number'>, bankLedgerIds: ReadonlySet<string> = new Set()): boolean {
  return VAT_ACCOUNT_NUMBERS.includes(account.number) || bankLedgerIds.has(account.id);
}

export interface TaxCode {
  code: string;
  kind: string;
  rateBp: number;
  label: string;
  /** The ESTV Ziffer (400, 405, 303 ...): the MWST picker tells the Vorsteuer families apart by it. */
  formLine?: string;
}

export interface InvoiceOption {
  documentId: string;
  number: string | null;
  /** D178 N3: the customer, so a several-invoice settlement offers one contact's invoices together. */
  contactId?: string | null;
  contactName: string | null;
  openMinor: number;
  currency: string;
}

export interface BillOption {
  vendorBillId: string;
  reference: string | null;
  /** D178 N3: the vendor, so a several-bill settlement offers one contact's bills together. */
  vendorId?: string | null;
  vendorName: string | null;
  openMinor: number;
  currency: string;
}

/** A pending agent proposal (`list_drafted_actions`), narrowed to the bank-line verbs. */
export interface LineVorschlag {
  actionId: string;
  actor: string;
  actionTool: string;
  dialCapability: string | null;
  /** The line the drafted bank-line verb names. */
  bankTxnId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  /** Critic N1: the figures frozen at the proposal (null when the verb pins no record). */
  figures?: VorschlagFigures | null;
  /** Critic N1: the pinned record changed since the proposal; approving would run nothing. */
  changedSinceProposal?: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Critic N1: the figures frozen at the proposal, read defensively (the Agent model's own shape). */
function parseFigures(raw: unknown): VorschlagFigures | null {
  const f = rec(raw);
  if (f === null) return null;
  return {
    number: str(f.number),
    numberPending: f.numberPending === true,
    counterparty: str(f.counterparty),
    recipient: str(f.recipient),
    amountMinor: num(f.amountMinor),
    amountBasis: f.amountBasis === 'net' || f.amountBasis === 'amount' ? f.amountBasis : null,
    currency: str(f.currency),
    taxMinor: num(f.taxMinor),
    grossMinor: num(f.grossMinor),
    lineCount: num(f.lineCount),
  };
}

/** `list_bank_inbox`, read defensively: an unreadable body is `null`, never a guessed list. */
export function parseInbox(body: unknown): ListBankInboxOk | null {
  const r = rec(body);
  if (r === null || !Array.isArray(r.lines) || !Array.isArray(r.summary)) return null;
  return {
    lines: r.lines as BankInboxLine[],
    nextCursor: str(r.nextCursor),
    total: num(r.total) ?? (r.lines as unknown[]).length,
    summary: r.summary as BankAccountBalance[],
    // D178 E3 (A39 §17.6): the per-direction counts, when the engine answered them.
    ...((): { directionCounts?: { in: number; out: number } } => {
      const dc = rec(r.directionCounts);
      const inN = num(dc?.in);
      const outN = num(dc?.out);
      return inN === null || outN === null ? {} : { directionCounts: { in: inN, out: outN } };
    })(),
  };
}

/** `list_bank_accounts` answers `{ bankAccounts: [...] }` (A19 `listBankAccounts`). */
export function parseBankAccounts(body: unknown): BankAccountOption[] {
  const r = rec(body);
  if (r === null || !Array.isArray(r.bankAccounts)) return [];
  const out: BankAccountOption[] = [];
  for (const raw of r.bankAccounts as unknown[]) {
    const a = rec(raw);
    if (a === null) continue;
    const id = str(a.id);
    if (id === null || a.archived === true) continue;
    out.push({
      id,
      name: str(a.name) ?? id,
      iban: str(a.iban) ?? '',
      currency: str(a.currency) ?? 'CHF',
      ledgerAccountId: str(a.ledgerAccountId),
    });
  }
  return out;
}

export function parseChart(body: unknown): ChartAccount[] {
  const r = rec(body);
  if (r === null || !Array.isArray(r.accounts)) return [];
  const out: ChartAccount[] = [];
  for (const raw of r.accounts as unknown[]) {
    const a = rec(raw);
    if (a === null || a.archived === true) continue;
    const id = str(a.id);
    const number = str(a.number);
    if (id === null || number === null) continue;
    out.push({ id, number, name: str(a.name) ?? '', vatCodeDefault: str(a.vatCodeDefault), type: str(a.type) });
  }
  return out.sort((x, y) => x.number.localeCompare(y.number, 'de-CH', { numeric: true }));
}

export function parseTaxCodes(body: unknown): TaxCode[] {
  const r = rec(body);
  if (r === null || !Array.isArray(r.taxCodes)) return [];
  const out: TaxCode[] = [];
  for (const raw of r.taxCodes as unknown[]) {
    const c = rec(raw);
    if (c === null || c.active === false) continue;
    const code = str(c.code);
    if (code === null) continue;
    const formLine = str(c.formLine);
    out.push({ code, kind: str(c.kind) ?? 'none', rateBp: num(c.rateBp) ?? 0, label: str(c.label) ?? code, ...(formLine !== null ? { formLine } : {}) });
  }
  return out;
}

export function parseInvoices(body: unknown): InvoiceOption[] {
  const r = rec(body);
  if (r === null || !Array.isArray(r.items)) return [];
  const out: InvoiceOption[] = [];
  for (const raw of r.items as unknown[]) {
    const i = rec(raw);
    if (i === null || i.kind !== 'document') continue;
    const documentId = str(i.documentId);
    const openMinor = num(i.openMinor);
    const currency = str(i.currency);
    if (documentId === null || openMinor === null || openMinor <= 0 || currency === null) continue;
    out.push({ documentId, number: str(i.number), contactId: str(i.customerId), contactName: str(i.customerName), openMinor, currency });
  }
  return out;
}

export function parseBills(body: unknown): BillOption[] {
  const r = rec(body);
  if (r === null || !Array.isArray(r.bills)) return [];
  const out: BillOption[] = [];
  for (const raw of r.bills as unknown[]) {
    const b = rec(raw);
    if (b === null) continue;
    const vendorBillId = str(b.id);
    const openMinor = num(b.openMinor);
    const currency = str(b.currency);
    if (vendorBillId === null || openMinor === null || openMinor <= 0 || currency === null) continue;
    out.push({ vendorBillId, reference: str(b.vendorReference), vendorId: str(b.vendorId), vendorName: str(b.vendorName), openMinor, currency });
  }
  return out;
}

/** D177: a generated payment run a money-out line can settle (`list_payment_batches`, status generated). */
export interface BatchOption {
  batchId: string;
  bankAccountId: string;
  executionDate: string | null;
  totalMinor: number | null;
  itemCount: number;
}

export function parseBatches(body: unknown): BatchOption[] {
  const r = rec(body);
  if (r === null || !Array.isArray(r.batches)) return [];
  const out: BatchOption[] = [];
  for (const raw of r.batches as unknown[]) {
    const b = rec(raw);
    const batchId = str(b?.id);
    if (b === null || batchId === null || b.status !== 'generated') continue;
    out.push({
      batchId,
      bankAccountId: str(b.bankAccountId) ?? '',
      executionDate: str(b.executionDate),
      totalMinor: num(b.ctrlSumMinor),
      itemCount: Array.isArray(b.items) ? (b.items as unknown[]).length : (num(b.nbOfTxs) ?? 0),
    });
  }
  return out;
}

/** The bank-line verbs a pending proposal can carry, keyed on the line it names. */
const LINE_VERBS: ReadonlySet<string> = new Set(['book_bank_line', 'ignore_bank_line', 'reopen_bank_line']);

export function parseVorschlaege(body: unknown): LineVorschlag[] {
  const r = rec(body);
  if (r === null || !Array.isArray(r.actions)) return [];
  const out: LineVorschlag[] = [];
  for (const raw of r.actions as unknown[]) {
    const a = rec(raw);
    if (a === null || a.status !== 'pending') continue;
    const tool = str(a.actionTool);
    const payload = rec(a.payload) ?? {};
    const actionId = str(a.actionId);
    if (tool === null || actionId === null) continue;
    const bankTxnId = LINE_VERBS.has(tool) ? str(payload.bankTxnId) : null;
    if (bankTxnId === null) continue;
    out.push({
      actionId,
      actor: str(a.actor) ?? '',
      actionTool: tool,
      dialCapability: str(a.dialCapability),
      bankTxnId,
      payload,
      createdAt: str(a.createdAt) ?? '',
      figures: parseFigures(a.figures),
      changedSinceProposal: a.changedSinceProposal === true,
    });
  }
  return out;
}

// --- The row draft: what a line will be booked to ----------------------------------------------------

/** One leg of an accounts booking, in Rappen, in the LINE's direction (positive). */
export interface DraftLeg {
  accountId: string;
  amountMinor: number;
  /** '' books the leg without VAT. */
  taxCode: string;
  /**
   * D178 E3 (A39 §17.4): the leg's amount in the card transaction's currency, a counter-leg booked at the
   * effective rate behind the `fx_counter_leg` consequence. `amountMinor` stays the CHF the bank booked.
   */
  fx?: { currency: string; amountMinor: number };
}

/**
 * D175: one amount a Buchungsregel asks for at booking time, as the person typed it. `legIndex` is the
 * recipe leg's index (the key of the engine's `asks` record), `label` the rule's word for it
 * ("Bruttoumsatz"), `value` the field's raw text: kept verbatim, so a refusal or a zero rest never eats it.
 */
export interface RuleAsk {
  legIndex: number;
  label: string;
  value: string;
  /**
   * D177 (A39 §16.1): a COMPUTED leg (`factor`). `minor` is the engine's figure in Rappen
   * (`reasonParams.computed`), or null for a rule picked by hand (the engine figures it at compose and at
   * booking; the Studio computes nothing, D152). While `value` is '' the leg books the computed figure and
   * nothing is sent for it; a typed `value` is the person's override, sent as `asks[legIndex]`.
   */
  computed?: ComputedLeg;
  /**
   * D177: the person took over a computed leg ("von dir"): `value` is theirs, even while empty (an empty
   * override is a missing amount, never the engine's figure). "berechnen" clears it.
   */
  override?: boolean;
}

/** D177: what a `factor` leg is made of, in words only (`explain`), never used for a figure. */
export interface FactorExplain {
  vatBp?: number;
  feeBp?: number;
}

/** D177: what the Studio knows of a computed leg: the engine's figure (when it said one) and its formula. */
export interface ComputedLeg {
  minor: number | null;
  /** The rule's factor, for the formula in the tooltip ("× 1081 / 180"); absent when the rule is unread. */
  num?: number;
  den?: number;
  explain?: FactorExplain;
}

/** D177: a computed amount the engine proposes for a rule's factor leg (`reasonParams.computed`). */
export interface ComputedAmount {
  legIndex: number;
  label: string;
  amountMinor: number;
  explain: FactorExplain | null;
}

/** True when a rule's ask is a computed leg the person has not overridden. */
export function isComputedAsIs(ask: RuleAsk): boolean {
  return ask.computed !== undefined && ask.override !== true;
}

/** D178 E3 (A39 §17.1): how a contact booking parks the money (`bank.contact_booking_mode`). */
export const CONTACT_BOOKING_MODES = ['guthaben', 'anzahlung'] as const;
export type ContactBookingMode = (typeof CONTACT_BOOKING_MODES)[number];

/** D178 E3 (A39 §17.2): one document of a several-document settlement and the cash applied to it. */
export interface DraftAllocation {
  documentId: string;
  amountMinor: number;
}

export type DraftTarget =
  /**
   * `viaAccountId` (D175): the whole entry routes through this Durchlaufkonto, which nets to zero.
   * `acknowledgeFx` (D178 E3, A39 §17.4): the person read the `fx_counter_leg` consequence of an FX leg.
   */
  | { kind: 'accounts'; legs: DraftLeg[]; viaAccountId?: string; acknowledgeFx?: boolean }
  /**
   * D175: book by a Buchungsregel. The ENGINE expands it (`expandRule`): each asked leg takes the typed
   * amount, the rest leg the line minus the others. The Studio checks only "is every ask a positive
   * number" (D152); every other figure comes from `compose_entry` and `book_bank_line`.
   */
  | { kind: 'rule'; standardId: string; asks: RuleAsk[] }
  /**
   * D176: a "Nicht buchen" rule's proposal. Never a `book_bank_line` target: the row decides it with
   * `ignore_bank_line` and the rule's reason, note and id (`ignoreInputOf`), so its next step is kept.
   */
  | { kind: 'ignore'; reason: IgnoreReason; note: string; standardId: string }
  | { kind: 'open_item'; documentId: string; remainder: RemainderMode | null }
  /**
   * D178 E3 (A39 §17.2): several invoices (money in) or bills (money out) of ONE contact in one payment, sent
   * as `open_item { allocations, remainder }`. The deviation and what may remain are the engine's preview.
   */
  | { kind: 'allocations'; allocations: DraftAllocation[]; remainder: RemainderMode | null }
  /**
   * D178 E3 (A39 §17.1): bexio's Kundenbuchung, a line booked to a contact with no document. `mode` null
   * books in the workspace setting's mode; a differing mode needs `overrideReason` (D172).
   */
  | { kind: 'contact'; contactId: string; contactName?: string; mode: ContactBookingMode | null; overrideReason: string }
  /** D178 E3 (A39 §17.3): approved Spesen paid from a debit line through E02's reimbursement. */
  | {
      kind: 'expense_claims';
      claimIds: string[];
      /** Display only (never sent): the chosen claims' total, so the footer's figures show before the preview. */
      totalMinor?: number;
    }
  | { kind: 'payment_batch'; batchId: string }
  /** `differenceReason` is required with `acceptDifference` (critic A39-12): the books keep why. */
  | {
      kind: 'existing_entry';
      entryId: string;
      acceptDifference: boolean;
      differenceReason?: string;
      /** Display only (never sent): the picked entry's date and text, so the row and the ack name it. */
      entryDate?: string;
      entryText?: string;
    };

/** Where a row's target came from: the engine's proposal as it stands, the person, or the agent. */
export type DraftSource = 'proposal' | 'edited' | 'agent';

export interface RowDraft {
  target: DraftTarget | null;
  source: DraftSource;
  /**
   * D175: on a `several_rules` line the person chose "Anders buchen": the row shows the whole "Worauf
   * buchen?" list instead of the rule chooser.
   */
  other?: boolean;
}

/** The line's absolute amount in Rappen (the engine's `amount_minor`). */
export function absAmount(line: Pick<BankInboxLine, 'amountMinor'>): number {
  return Math.abs(line.amountMinor);
}

/** True for money in (a credit). */
export function isCredit(line: Pick<BankInboxLine, 'amountMinor'>): boolean {
  return line.amountMinor > 0;
}

/** The engine's proposal as a row draft. */
export function draftFromProposal(line: BankInboxLine): RowDraft {
  return { target: proposalTarget(line), source: 'proposal' };
}

/**
 * The agent's pending Vorschlag as a row draft: a drafted `book_bank_line` puts its target on the row,
 * so the row shows what the agent would book before anyone opens it. Any other drafted verb (ignore,
 * reopen) leaves the row's own proposal in place.
 */
export function draftFromVorschlag(v: LineVorschlag | undefined): RowDraft | null {
  if (v === undefined) return null;
  if (v.actionTool !== 'book_bank_line') return null;
  const target = draftTargetOf(v.payload.target);
  return target === null ? null : { target, source: 'agent' };
}

/** Any engine-shaped `target` (a proposal's, a Vorschlag's payload) as a draft target. */
export function draftTargetOf(
  raw: unknown,
  askLabels: readonly { legIndex: number; label: string }[] = [],
  computed: readonly ComputedAmount[] = [],
): DraftTarget | null {
  const t = rec(raw);
  if (t === null) return null;
  switch (t.kind) {
    case 'accounts': {
      if (!Array.isArray(t.legs)) return null;
      const legs: DraftLeg[] = [];
      for (const rawLeg of t.legs as unknown[]) {
        const l = rec(rawLeg);
        const accountId = str(l?.accountId);
        const amountMinor = num(l?.amountMinor);
        if (l === null || accountId === null || amountMinor === null) return null;
        const fx = rec(l.fx);
        const fxCurrency = str(fx?.currency);
        const fxMinor = num(fx?.amountMinor);
        legs.push({ accountId, amountMinor, taxCode: str(l.taxCode) ?? '', ...(fxCurrency !== null && fxMinor !== null ? { fx: { currency: fxCurrency, amountMinor: fxMinor } } : {}) });
      }
      if (legs.length === 0) return null;
      const via = str(t.viaAccountId);
      const ack = t.acknowledgeFx === true ? { acknowledgeFx: true } : {};
      return via === null ? { kind: 'accounts', legs, ...ack } : { kind: 'accounts', legs, viaAccountId: via, ...ack };
    }
    case 'rule': {
      // D175: `asks` is a record legIndex to Rappen on the wire (empty on a proposal, filled on an agent's
      // Vorschlag); the labels come from the proposal's `reasonParams.asks`.
      const standardId = str(t.standardId);
      if (standardId === null) return null;
      const filled = rec(t.asks) ?? {};
      const indexes = new Set<number>([...askLabels.map((a) => a.legIndex), ...computed.map((c) => c.legIndex)]);
      for (const k of Object.keys(filled)) if (/^\d+$/.test(k)) indexes.add(Number(k));
      const asks = [...indexes]
        .sort((a, b) => a - b)
        .map((legIndex): RuleAsk => {
          const v = num(filled[String(legIndex)]);
          const c = computed.find((x) => x.legIndex === legIndex);
          const label = askLabels.find((a) => a.legIndex === legIndex)?.label ?? c?.label ?? '';
          // D177: a computed leg's override is the one figure sent; an override equal to the figure is none.
          const value = v === null || (c !== undefined && v === c.amountMinor) ? '' : minorToField(v);
          return c === undefined
            ? { legIndex, label, value }
            : { legIndex, label, value, computed: { minor: c.amountMinor, ...(c.explain !== null ? { explain: c.explain } : {}) }, ...(value !== '' ? { override: true } : {}) };
        });
      return { kind: 'rule', standardId, asks };
    }
    case 'ignore': {
      // D176: the "Nicht buchen" rule's proposal: its reason, note and rule, decided by ignore_bank_line.
      const standardId = str(t.standardId);
      const reason = BANK_LINE_IGNORE_REASONS.find((r) => r === t.reason);
      if (standardId === null || reason === undefined) return null;
      return { kind: 'ignore', reason, note: str(t.note) ?? '', standardId };
    }
    case 'open_item': {
      const remainder = BANK_LINE_REMAINDER_MODES.find((m) => m === t.remainder) ?? null;
      if (Array.isArray(t.allocations)) {
        const allocations: DraftAllocation[] = [];
        for (const raw of t.allocations as unknown[]) {
          const a = rec(raw);
          const documentId = str(a?.documentId);
          const amountMinor = num(a?.amountMinor);
          if (documentId === null || amountMinor === null) return null;
          allocations.push({ documentId, amountMinor });
        }
        return { kind: 'allocations', allocations, remainder };
      }
      const documentId = str(t.documentId);
      if (documentId === null) return null;
      return { kind: 'open_item', documentId, remainder };
    }
    case 'contact': {
      const contactId = str(t.contactId);
      if (contactId === null) return null;
      const mode = CONTACT_BOOKING_MODES.find((m) => m === t.mode) ?? null;
      return { kind: 'contact', contactId, mode, overrideReason: str(t.overrideReason) ?? '' };
    }
    case 'expense_claims': {
      if (!Array.isArray(t.claimIds)) return null;
      const claimIds = (t.claimIds as unknown[]).filter((c): c is string => typeof c === 'string' && c !== '');
      return claimIds.length === 0 ? null : { kind: 'expense_claims', claimIds };
    }
    case 'payment_batch': {
      const batchId = str(t.batchId);
      return batchId === null ? null : { kind: 'payment_batch', batchId };
    }
    case 'existing_entry': {
      const entryId = str(t.entryId);
      if (entryId === null) return null;
      const reason = str(t.differenceReason);
      return reason === null
        ? { kind: 'existing_entry', entryId, acceptDifference: t.acceptDifference === true }
        : { kind: 'existing_entry', entryId, acceptDifference: t.acceptDifference === true, differenceReason: reason };
    }
    default:
      return null;
  }
}

/** The one-leg accounts draft a picked account makes, with its VAT code. */
export function accountDraft(line: BankInboxLine, accountId: string, taxCode: string): DraftTarget {
  return { kind: 'accounts', legs: [{ accountId, amountMinor: absAmount(line), taxCode }] };
}

/** D175: an asked amount as the engine takes it: a positive number of Rappen, else null. */
export function askMinor(ask: Pick<RuleAsk, 'value'>): number | null {
  const v = parseMoneyInput(ask.value);
  return v === null || v <= 0 ? null : v;
}

/** True when the draft can be sent as it stands (every leg has an account and the legs sum up). */
export function isBookable(line: BankInboxLine, target: DraftTarget | null): boolean {
  if (target === null) return false;
  // D175 (D152): the Studio checks only that every ask is a positive number; the rest is the engine's.
  // D177: a computed leg left as the engine figured it needs nothing; an override must be positive too.
  if (target.kind === 'rule') return target.asks.every((a) => isComputedAsIs(a) || askMinor(a) !== null);
  // D176: an ignore is decided as it stands.
  if (target.kind === 'ignore') return true;
  // An accepted difference states its reason, or the engine refuses it (critic A39-12).
  if (target.kind === 'existing_entry') return !target.acceptDifference || (target.differenceReason ?? '').trim() !== '';
  // D178 E3: the engine's preview decides the deviation; the Studio checks only what is plainly missing.
  if (target.kind === 'allocations') return target.allocations.length > 0 && target.allocations.every((a) => a.amountMinor > 0);
  if (target.kind === 'expense_claims') return target.claimIds.length > 0;
  // A mode other than the setting's carries its reason (the pane sends `mode` only when it differs).
  if (target.kind === 'contact') return target.mode === null || target.overrideReason.trim() !== '';
  if (target.kind !== 'accounts') return true;
  if (target.legs.length === 0 || target.legs.some((l) => l.accountId === '' || l.amountMinor === 0)) return false;
  return target.legs.reduce((s, l) => s + l.amountMinor, 0) === absAmount(line);
}

/** The `target` object `book_bank_line` takes, straight from the draft. */
export function bookTargetOf(target: DraftTarget): Record<string, unknown> {
  switch (target.kind) {
    case 'accounts':
      return {
        kind: 'accounts',
        legs: target.legs.map((l) => ({
          accountId: l.accountId,
          amountMinor: l.amountMinor,
          ...(l.taxCode !== '' ? { taxCode: l.taxCode } : {}),
          ...(l.fx !== undefined ? { fx: { currency: l.fx.currency, amountMinor: l.fx.amountMinor } } : {}),
        })),
        ...(target.viaAccountId !== undefined && target.viaAccountId !== '' ? { viaAccountId: target.viaAccountId } : {}),
        ...(target.acknowledgeFx === true && target.legs.some((l) => l.fx !== undefined) ? { acknowledgeFx: true } : {}),
      };
    case 'allocations':
      return {
        kind: 'open_item',
        allocations: target.allocations.map((a) => ({ documentId: a.documentId, amountMinor: a.amountMinor })),
        ...(target.remainder !== null ? { remainder: target.remainder } : {}),
      };
    case 'contact':
      return {
        kind: 'contact',
        contactId: target.contactId,
        ...(target.mode !== null ? { mode: target.mode } : {}),
        ...(target.mode !== null && target.overrideReason.trim() !== '' ? { overrideReason: target.overrideReason.trim() } : {}),
      };
    case 'expense_claims':
      return { kind: 'expense_claims', claimIds: [...target.claimIds] };
    case 'rule':
      // `Record<legIndex, amountMinor>` (A39 §14.2). Only a bookable draft is sent, so every ask is positive.
      // D177: a computed leg the person left alone is not sent: the engine computes it again.
      return {
        kind: 'rule',
        standardId: target.standardId,
        asks: Object.fromEntries(target.asks.filter((a) => !isComputedAsIs(a)).map((a) => [String(a.legIndex), askMinor(a) ?? 0])),
      };
    case 'ignore':
      // Never sent to book_bank_line (the engine refuses `wrong_outcome`); `ignoreInputOf` is the input.
      return { kind: 'ignore', standardId: target.standardId };
    case 'open_item':
      return target.remainder === null ? { kind: 'open_item', documentId: target.documentId } : { kind: 'open_item', documentId: target.documentId, remainder: target.remainder };
    case 'payment_batch':
      return { kind: 'payment_batch', batchId: target.batchId };
    case 'existing_entry':
      return target.acceptDifference
        ? { kind: 'existing_entry', entryId: target.entryId, acceptDifference: true, differenceReason: (target.differenceReason ?? '').trim() }
        : { kind: 'existing_entry', entryId: target.entryId };
  }
}

/** D176: the `ignore_bank_line` input a "Nicht buchen" proposal is decided with (reason, note, the rule). */
export function ignoreInputOf(target: Extract<DraftTarget, { kind: 'ignore' }>): Record<string, unknown> {
  return { reason: target.reason, ...(target.note !== '' ? { note: target.note } : {}), standardId: target.standardId };
}

/**
 * D176: what a row books a proposal as. A COMPLETE rule's proposal arrives as the `accounts` target it stands
 * for; when that rule names a next step (a follow-up Vorlage) and the person changed nothing, it is booked as
 * the `rule` target instead, so the decision records the rule and the line then offers the next step. The
 * figures are the same: the engine expands the rule to exactly the proposal's target. A rule whose code was
 * dropped on a foreign-currency line (`vatDropped`) stays the accounts target it was proposed as.
 */
export function bookingTargetFor(
  line: BankInboxLine,
  target: DraftTarget,
  rule: Pick<BankStandard, 'id' | 'followUpStandardId'> | undefined,
): DraftTarget {
  const params = (line.proposal?.reasonParams ?? {}) as Record<string, unknown>;
  if ((line.proposal?.reasonCode as string | undefined) !== 'standard' || params.vatDropped === true) return target;
  if (rule === undefined || rule.followUpStandardId === null || params.standardId !== rule.id) return target;
  if (target.kind !== 'accounts' || targetKey(target) !== targetKey(proposalTarget(line))) return target;
  return { kind: 'rule', standardId: rule.id, asks: [] };
}

/** D176: the next step a decided line offers (`list_bank_inbox` `followUp`), read defensively. */
export function lineFollowUp(line: BankInboxLine): { standardId: string; label: string } | null {
  const raw = rec((line as BankInboxLine & { followUp?: unknown }).followUp);
  const standardId = str(raw?.standardId);
  return raw === null || standardId === null ? null : { standardId, label: str(raw.label) ?? '' };
}

/** The dial family a booking falls under (the engine's input-keyed rule): post, or pay for a settlement. */
export function bookCapability(target: DraftTarget): 'post' | 'pay' {
  return target.kind === 'open_item' || target.kind === 'payment_batch' || target.kind === 'allocations' || target.kind === 'contact' || target.kind === 'expense_claims' ? 'pay' : 'post';
}

/** A stable key for "is this the proposal as the engine made it". */
export function targetKey(target: DraftTarget | null): string {
  if (target === null) return '';
  switch (target.kind) {
    case 'accounts':
      return `accounts:${target.viaAccountId ?? ''}:${target.legs.map((l) => `${l.accountId}/${l.taxCode}/${l.amountMinor}${l.fx !== undefined ? `/${l.fx.currency}${l.fx.amountMinor}` : ''}`).join('|')}${target.acknowledgeFx === true ? ':fx' : ''}`;
    case 'allocations':
      return `allocations:${target.allocations.map((a) => `${a.documentId}/${a.amountMinor}`).join('|')}:${target.remainder ?? ''}`;
    case 'contact':
      return `contact:${target.contactId}:${target.mode ?? ''}`;
    case 'expense_claims':
      return `expense_claims:${target.claimIds.join('|')}`;
    case 'rule':
      return `rule:${target.standardId}:${target.asks.map((a) => `${a.legIndex}=${a.value}`).join('|')}`;
    case 'ignore':
      return `ignore:${target.standardId}:${target.reason}`;
    case 'open_item':
      return `open_item:${target.documentId}:${target.remainder ?? ''}`;
    case 'payment_batch':
      return `payment_batch:${target.batchId}`;
    case 'existing_entry':
      return `existing_entry:${target.entryId}:${target.acceptDifference ? 1 : 0}`;
  }
}

/**
 * D167 polish 8: a target's ACCOUNTS, without the MWST codes. The source glyph follows the account only: a
 * person who changes just the MWST of TILL's (or the agent's) suggestion still books to the account that
 * source named, so its glyph stays.
 */
export function accountsKey(target: DraftTarget | null): string {
  if (target === null) return '';
  // D175: the rule decides the source, not the amounts typed into it.
  if (target.kind === 'rule') return `rule:${target.standardId}`;
  return target.kind === 'accounts' ? `accounts:${target.viaAccountId ?? ''}:${target.legs.map((l) => `${l.accountId}/${l.amountMinor}`).join('|')}` : targetKey(target);
}

/** The certainty a row shows: the engine's, or "edited" once the person changed the proposal. */
export type RowCertainty = Certainty | 'edited' | 'agent';

/** The engine's proposal as a draft target, or null. A rule target takes its ask labels off the reason. */
export function proposalTarget(line: BankInboxLine): DraftTarget | null {
  return line.proposal === null || line.proposal.target === null ? null : draftTargetOf(line.proposal.target, ruleAsksOf(line), ruleComputedOf(line));
}

/** D177 (A39 §16.1): the computed amounts a `rule_computed` proposal carries (`reasonParams.computed`). */
export function ruleComputedOf(line: BankInboxLine): ComputedAmount[] {
  const raw = (line.proposal?.reasonParams as Record<string, unknown> | undefined)?.computed;
  if (!Array.isArray(raw)) return [];
  const out: ComputedAmount[] = [];
  for (const item of raw as unknown[]) {
    const c = rec(item);
    const legIndex = num(c?.legIndex);
    const amountMinor = num(c?.amountMinor);
    if (c === null || legIndex === null || amountMinor === null) continue;
    const e = rec(c.explain);
    const vatBp = num(e?.vatBp);
    const feeBp = num(e?.feeBp);
    const explain = e === null ? null : { ...(vatBp !== null ? { vatBp } : {}), ...(feeBp !== null ? { feeBp } : {}) };
    out.push({ legIndex, label: str(c.label) ?? '', amountMinor, explain });
  }
  return out;
}

/** D175: the amounts a `rule_needs_amount` proposal asks for (`reasonParams.asks`), read defensively. */
export function ruleAsksOf(line: BankInboxLine): { legIndex: number; label: string }[] {
  const raw = (line.proposal?.reasonParams as Record<string, unknown> | undefined)?.asks;
  if (!Array.isArray(raw)) return [];
  const out: { legIndex: number; label: string }[] = [];
  for (const item of raw as unknown[]) {
    const a = rec(item);
    const legIndex = num(a?.legIndex);
    if (a === null || legIndex === null) continue;
    out.push({ legIndex, label: str(a.label) ?? '' });
  }
  return out;
}

/** D175: the rules a `several_rules` proposal names (`reasonParams.standardIds`), in the engine's order. */
export function severalRuleIds(line: BankInboxLine): string[] {
  const raw = (line.proposal?.reasonParams as Record<string, unknown> | undefined)?.standardIds;
  return Array.isArray(raw) ? (raw as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

/** D175: every live rule for the line's counterparty and direction (`list_bank_inbox` `ruleIds`). */
export function lineRuleIds(line: BankInboxLine): string[] {
  const raw = (line as BankInboxLine & { ruleIds?: unknown }).ruleIds;
  return Array.isArray(raw) ? (raw as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

/**
 * D177 (A39 §16.1): the ONE agent Vorschlag a line shows. The engine names it (`vorschlagActionId`, the
 * newest pending bank-line draft for the line); a book drafted before D177 may hold two, and the other is
 * never shown as a second Vorschlag. Without the field (an older engine) the first the queue lists, as before.
 */
export function lineVorschlag(line: BankInboxLine, byLine: ReadonlyMap<string, readonly LineVorschlag[]>): LineVorschlag | undefined {
  const pending = byLine.get(line.bankTxnId) ?? [];
  if (pending.length === 0) return undefined;
  const named = str((line as BankInboxLine & { vorschlagActionId?: unknown }).vorschlagActionId);
  const hit = named === null ? undefined : pending.find((v) => v.actionId === named);
  return hit ?? pending[0];
}

/** D175: the rule a proposal used (`reasonParams.standardId`), or null. */
export function proposalRuleId(line: BankInboxLine): string | null {
  return str((line.proposal?.reasonParams as Record<string, unknown> | undefined)?.standardId);
}

/**
 * D175: the line waits on the person to pick one of several rules: a `several_rules` proposal, nothing
 * chosen yet, and "Anders buchen" not taken.
 */
export function needsRuleChoice(line: BankInboxLine, draft: RowDraft | undefined): boolean {
  const code: string = line.proposal?.reasonCode ?? '';
  return code === 'several_rules' && line.state === 'open' && draft?.other !== true && (draft?.target ?? null) === null;
}

/** True when the row still shows the engine's proposal exactly (the person changed nothing). */
export function isUntouched(line: BankInboxLine, draft: RowDraft | undefined): boolean {
  return draft === undefined || targetKey(draft.target) === targetKey(proposalTarget(line));
}

/**
 * D144 (A39 §12): the row shows a model's suggestion as it stands, so it carries the AI disclosure
 * (a transparency design choice; EU AI Act Art. 50 is our reading, not legal clearance). Once the
 * person changed the target it is their booking, not the model's.
 */
export function isModelSuggestion(line: BankInboxLine, draft: RowDraft | undefined): boolean {
  return line.proposal?.reasonCode === 'model_suggested' && isUntouched(line, draft);
}

export function rowCertainty(line: BankInboxLine, draft: RowDraft | undefined): RowCertainty {
  if (isUntouched(line, draft)) return line.proposal?.certainty ?? 'open';
  if (draft === undefined || draft.target === null) return 'open';
  return draft.source === 'agent' ? 'agent' : 'edited';
}

/**
 * D167 (pick 2A): where a prefilled account came from, as ONE small glyph before it. `standard` is the
 * person's own standard for the counterparty (★), `history` the bank's or the journal's past bookings
 * (↻), `agent` an agent's pending Vorschlag (◇), `model` the local model's suggestion (the D144 "KI"
 * case, unchanged). `null` when the person chose it themselves (no glyph means "you chose it"), when the
 * line has no target, and for every other rung, whose certainty glyph says the rest.
 */
export type PrefillSource = 'standard' | 'history' | 'agent' | 'model';

export function prefillSource(line: BankInboxLine, draft: RowDraft | undefined, agentTarget: DraftTarget | null = null): PrefillSource | null {
  const target = draft === undefined ? proposalTarget(line) : draft.target;
  if (target === null) return null;
  if (draft?.source === 'agent') return 'agent';
  // The ACCOUNT decides, not how it was picked nor its MWST (polish 8): re-picking TILL's suggestion after
  // × (from "Vorschläge", or the same account from "Konten"), or changing only its MWST, keeps the line's
  // own source and glyph. Any other account is the person's own choice.
  if (agentTarget !== null && accountsKey(agentTarget) === accountsKey(target)) return 'agent';
  // D175: a rule the person picked from the chooser is still the rule's booking: ★.
  if (target.kind === 'rule' || target.kind === 'ignore') return 'standard';
  if (accountsKey(target) !== accountsKey(proposalTarget(line))) return null;
  // A string, not the engine's union: the D167 codes land with the engine's own branch.
  const code: string = line.proposal?.reasonCode ?? '';
  if (code === 'standard' || code === 'rule_needs_amount' || code === 'rule_ignore' || code === 'rule_computed') return 'standard';
  if (code === 'history' || code === 'journal_history') return 'history';
  if (code === 'model_suggested') return 'model';
  return null;
}

/**
 * D167: the live standard for the line's counterparty and direction (`list_bank_inbox` carries it as
 * `standardId`), read defensively so a line from an engine without the field reads as "none".
 */
export function lineStandardId(line: BankInboxLine): string | null {
  const raw = (line as BankInboxLine & { standardId?: unknown }).standardId;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * D175 (A39 §14.1): how a recipe leg is amounted. Exactly one leg of a rule is the `rest` (the line minus
 * the others, worked out by the engine); every other leg is `ask`ed at booking time under its label, or
 * (D176) takes the SAME amount as another asked leg.
 */
export type RecipeAmount =
  | { kind: 'rest' }
  | { kind: 'ask'; label: string }
  | { kind: 'same'; legIndex: number }
  /**
   * D177 (A39 §16.1): a COMPUTED amount: round-half-up(|line| x num / den) in Rappen, the person may
   * override it at booking time. `explain` is words only (the MWST and fee rates in basis points).
   */
  | { kind: 'factor'; label: string; num: number; den: number; explain?: FactorExplain };

/** D176: the side a Vorlage's leg books on (`RECIPE_SIDES`, bankStandards.ts). */
export const RECIPE_SIDES = ['debit', 'credit'] as const;
export type RecipeSide = (typeof RECIPE_SIDES)[number];

/** D176: a rule speaks on a bank line (`bank`) or is a Vorlage in the composer (`manual`). */
export const BANK_RULE_SCOPES = ['bank', 'manual'] as const;
export type RuleScope = (typeof BANK_RULE_SCOPES)[number];

/** D176: a bank rule books its legs, or proposes "Nicht buchen". */
export const BANK_RULE_OUTCOMES = ['legs', 'ignore'] as const;
export type RuleOutcome = (typeof BANK_RULE_OUTCOMES)[number];

/** D175: one leg of a Buchungsregel, the engine's `RecipeLeg` (mirrored as a shape, never as figures). */
export interface RecipeLeg {
  accountId: string;
  taxCode: string | null;
  amount: RecipeAmount;
  /** An asked leg that runs against the line's direction (a fee, a cost). */
  against?: boolean;
  /** D176: a Vorlage's leg states its side. */
  side?: RecipeSide;
  description?: string;
}

/** A recipe leg as `list_bank_standards` names it. */
export interface StandardLeg extends RecipeLeg {
  accountNumber: string;
  accountName: string;
}

/** The longest ask label the engine takes (A39 §14.1). */
export const ASK_LABEL_MAX = 40;

/**
 * A live Buchungsregel (`list_bank_standards`, D167 widened by D175 §14.1). A D167 row reads as a one-leg
 * recipe whose leg is the rest, so every reader sees one shape. `invalidReason` is set when a leg's or the
 * via account's account or code no longer holds: such a rule is silent on the rows and the sheet says why.
 */
export interface BankStandard {
  id: string;
  /** D176: `bank` or `manual` (a Vorlage). */
  scope: RuleScope;
  /** D176: `legs`, or `ignore` ("Nicht buchen", bank scope only). */
  outcome: RuleOutcome;
  /** '' for a Vorlage (it has no counterparty). */
  counterpartyKey: string;
  counterpartyLabel: string;
  /** null for a Vorlage (it has no direction). */
  direction: 'in' | 'out' | null;
  label: string | null;
  matchText: string | null;
  viaAccountId: string | null;
  viaAccountNumber: string | null;
  viaAccountName: string | null;
  legs: StandardLeg[];
  invalidReason: string | null;
  /** D176: an ignore rule's reason and note. */
  ignoreReason: IgnoreReason | null;
  ignoreNote: string | null;
  /** D176: the Vorlage offered as the next step, while one is live. */
  followUpStandardId: string | null;
  followUpLabel: string | null;
  /** The rest leg, kept for the D167 readers ('' for an ignore rule, which has no legs). */
  accountId: string;
  accountNumber: string;
  accountName: string;
  taxCode: string | null;
}

function parseRecipeAmount(raw: unknown): RecipeAmount | null {
  const a = rec(raw);
  if (a === null) return null;
  if (a.kind === 'rest') return { kind: 'rest' };
  if (a.kind === 'ask') return { kind: 'ask', label: str(a.label) ?? '' };
  if (a.kind === 'same') {
    const legIndex = num(a.legIndex);
    return legIndex === null ? null : { kind: 'same', legIndex };
  }
  if (a.kind === 'factor') {
    // D177: positive safe integers only (the engine's `shapeLegs` refuses anything else as `factor`).
    const n = num(a.num);
    const d = num(a.den);
    if (n === null || d === null || !Number.isSafeInteger(n) || !Number.isSafeInteger(d) || n <= 0 || d <= 0) return null;
    const e = rec(a.explain);
    const vatBp = num(e?.vatBp);
    const feeBp = num(e?.feeBp);
    const explain = e === null ? undefined : { ...(vatBp !== null ? { vatBp } : {}), ...(feeBp !== null ? { feeBp } : {}) };
    return { kind: 'factor', label: str(a.label) ?? '', num: n, den: d, ...(explain !== undefined ? { explain } : {}) };
  }
  return null;
}

/** `list_bank_standards` answers `{ standards: [...] }`; an unreadable or refused read is no standards. */
export function parseStandards(body: unknown): BankStandard[] {
  const r = rec(body);
  if (r === null || !Array.isArray(r.standards)) return [];
  const out: BankStandard[] = [];
  for (const raw of r.standards as unknown[]) {
    const s = rec(raw);
    const id = str(s?.id);
    const outcome: RuleOutcome = s?.outcome === 'ignore' ? 'ignore' : 'legs';
    // D176: an ignore rule names no account (it has no legs).
    const accountId = str(s?.accountId) ?? (outcome === 'ignore' ? '' : null);
    if (s === null || id === null || accountId === null) continue;
    const accountNumber = str(s.accountNumber) ?? '';
    const accountName = str(s.accountName) ?? '';
    const taxCode = str(s.taxCode);
    const legs: StandardLeg[] = [];
    if (Array.isArray(s.legs)) {
      for (const rawLeg of s.legs as unknown[]) {
        const l = rec(rawLeg);
        const legAccount = str(l?.accountId);
        const amount = parseRecipeAmount(l?.amount);
        if (l === null || legAccount === null || amount === null) continue;
        const description = str(l.description);
        legs.push({
          accountId: legAccount,
          taxCode: str(l.taxCode),
          amount,
          ...(l.side === 'debit' || l.side === 'credit' ? { side: l.side } : {}),
          ...(l.against === true ? { against: true } : {}),
          ...(description !== null ? { description } : {}),
          accountNumber: str(l.accountNumber) ?? '',
          accountName: str(l.accountName) ?? '',
        });
      }
    }
    // A D167 engine (or a D167 row) names no legs: it is the one-leg recipe whose leg is the rest. An ignore
    // rule has none, on purpose.
    if (legs.length === 0 && outcome === 'legs') legs.push({ accountId, taxCode, amount: { kind: 'rest' }, accountNumber, accountName });
    const scope: RuleScope = s.scope === 'manual' ? 'manual' : 'bank';
    out.push({
      id,
      scope,
      outcome,
      counterpartyKey: str(s.counterpartyKey) ?? '',
      counterpartyLabel: str(s.counterpartyLabel) ?? '',
      direction: scope === 'manual' ? null : s.direction === 'in' ? 'in' : 'out',
      label: str(s.label),
      matchText: str(s.matchText),
      viaAccountId: str(s.viaAccountId),
      viaAccountNumber: str(s.viaAccountNumber),
      viaAccountName: str(s.viaAccountName),
      legs,
      invalidReason: str(s.invalidReason),
      ignoreReason: BANK_LINE_IGNORE_REASONS.find((r) => r === s.ignoreReason) ?? null,
      ignoreNote: str(s.ignoreNote),
      followUpStandardId: str(s.followUpStandardId),
      followUpLabel: str(s.followUpLabel),
      accountId,
      accountNumber,
      accountName,
      taxCode,
    });
  }
  return out;
}

/**
 * D175: a bank-line `compose_entry` answers a refusal the booking would give (`rest_is_zero`,
 * `ask_missing`, `rule_not_found`, ...) as its VERDICT, inside an ok answer with `composed: false`
 * (`bankBooking.ts composeBankLine`), never as a failed read. The verdict's refusal, or null.
 */
export function composeVerdictError(answer: { verdict?: unknown } | null | undefined): { ok: false; error: string } | null {
  const v = rec(answer?.verdict);
  if (v === null || v.ok !== false || typeof v.error !== 'string') return null;
  return v as { ok: false; error: string };
}

/**
 * True for a proposal "Alle vorgeschlagenen buchen" and the pick bar may send: `sure` (a reference, or
 * the person's standard) and untouched. The ENGINE's `attention` must say `sure` too (critic D167-7): it
 * folds in a pending agent Vorschlag on the line, so a line an agent drafted is never bulk-booked even
 * while the Studio's own Vorschläge read has not landed, or for a seat that may not make it.
 */
export function isSureAndUntouched(line: BankInboxLine, draft: RowDraft | undefined): boolean {
  return (
    line.state === 'open' &&
    line.attention === 'sure' &&
    line.proposal?.certainty === 'sure' &&
    isUntouched(line, draft) &&
    isBookable(line, proposalTarget(line))
  );
}

// --- The balance line (spec L4) --------------------------------------------------------------------------

export type TrustTone = 'ok' | 'pending' | 'difference' | 'unknown';

export interface TrustView {
  tone: TrustTone;
  /** bank = books + open + difference, each in the account's currency. */
  bank: number | null;
  books: number | null;
  openCount: number;
  openSum: number;
  difference: number | null;
  statementDate: string | null;
  reason: BankAccountBalance['reason'];
}

/**
 * The balance line's figures and tone for one account, read straight off the engine's summary (L4):
 * `differenceMinor = bank - ledger - open` at the latest statement date. Nothing else is explained away:
 * an ignored line whose money is not on the books, an entry no line backs, an accepted difference and a
 * line matched to an entry dated after the statement all show as a difference. `trustIdentityHolds`
 * re-checks the identity so a payload that broke it renders as "cannot be judged", never as a sum that
 * does not add up on screen.
 */
export function trustView(b: BankAccountBalance): TrustView {
  const base = {
    bank: b.bankBalanceMinor,
    books: b.ledgerBalanceMinor,
    openCount: b.openCount,
    openSum: b.openSumMinor,
    difference: b.differenceMinor,
    statementDate: b.statementDate,
    reason: b.reason,
  };
  if (!b.judgeable || !trustIdentityHolds(b)) return { ...base, tone: 'unknown' };
  if (b.differenceMinor !== 0) return { ...base, tone: 'difference' };
  return { ...base, tone: b.openCount > 0 ? 'pending' : 'ok' };
}

/** The engine's identity, re-checked: bank = books + open + difference. */
export function trustIdentityHolds(b: BankAccountBalance): boolean {
  if (b.bankBalanceMinor === null || b.ledgerBalanceMinor === null || b.differenceMinor === null) return false;
  return b.bankBalanceMinor === b.ledgerBalanceMinor + b.openSumMinor + b.differenceMinor;
}

// --- Money input -----------------------------------------------------------------------------------

/**
 * A typed amount in Rappen: "1'234.50", "1234,5", "-12" all read; anything else is null (the field
 * shows it as invalid and Buchen stays off). A negative runs against the line (a fee netted out).
 */
export function parseMoneyInput(raw: string): number | null {
  const cleaned = raw.trim().replace(/[\s'’]/g, '').replace(',', '.');
  const m = /^(-)?(\d{1,12})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (m === null) return null;
  const minor = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -minor : minor;
}

/** Rappen back into the plain decimal a field holds ("89.90", "-5.00"). */
export function minorToField(minor: number): string {
  const abs = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// --- Dates -------------------------------------------------------------------------------------------

/** The date a line is shown and sorted by: the booking date, else the value date. */
export function lineDate(line: Pick<BankInboxLine, 'bookingDate' | 'valueDate'>): string | null {
  return line.bookingDate ?? line.valueDate;
}

/** "23.09." for a row, the year only in the panel. */
export function shortDate(iso: string | null): string {
  if (iso === null || iso.length < 10) return '';
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
}

/** ISO date `days` away from `iso`. */
export function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two ISO dates. */
export function daysBetween(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/** The IBAN a camt file names (`<Acct><Id><IBAN>`), read before import to pick the account. */
export function ibanOfCamt(xml: string): string | null {
  const acct = /<(?:\w+:)?Acct>[\s\S]*?<(?:\w+:)?IBAN>\s*([A-Z0-9 ]+?)\s*<\/(?:\w+:)?IBAN>/i.exec(xml);
  return acct === null ? null : (acct[1] ?? '').replace(/\s+/g, '').toUpperCase();
}

/** "CH93 0076 2011 6238 5295 7": an IBAN in groups of four. */
export function formatIban(iban: string): string {
  return iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

/**
 * A payment reference the way it is printed on a Swiss QR-bill: a 27-digit QR reference in blocks
 * of five counted from the right (so the first block has two digits), a creditor reference (RF) in
 * blocks of four. Anything else is shown as it came.
 */
export function formatReference(kind: string, value: string): string {
  const compact = value.replace(/\s+/g, '');
  if (kind !== 'SCOR' && /^\d{27}$/.test(compact)) {
    return `${compact.slice(0, 2)} ${compact.slice(2).replace(/(\d{5})(?=\d)/g, '$1 ')}`;
  }
  if (kind !== 'QRR' && /^RF\d{2}[A-Z0-9]{1,21}$/i.test(compact)) return compact.toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
  return value;
}
