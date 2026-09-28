/**
 * A2, the bank inbox: the read models the surface renders and the pure rules it applies.
 *
 * EVERY FIGURE IS THE ENGINE'S. The lines, their one state, the proposal with its certainty and its
 * reason, the receipt count and the per-account balance truth come from `list_bank_inbox`; the VAT
 * split of a leg comes from `vat_preview` and a settlement's legs from `preview_payment`. What this
 * file adds is arrangement, never arithmetic the engine did not do: which verb target a row's draft
 * becomes, which words a reason code reads as, and where each leg of a VAT split sits (Soll or Haben),
 * mirroring `buildVatLines` (A06) exactly as `buildAccountsLines` (A39) calls it. That one mirror is
 * the interim for a `preview_bank_line` read the engine does not have yet; it is recorded as an
 * engine request in the A2 report, and replacing it is a one-function change here.
 *
 * The engine's types are imported as TYPES (erased at build), so the Studio reads the shapes the
 * engine declares and the bundle gains no engine code (`studio-sees-payloads.test.mjs`).
 */
import type { BankAccountBalance, BankInboxLine, ListBankInboxOk } from '../../../../src/core/banking/bankInbox';
import type { BankLineProposal } from '../../../../src/core/banking/bankProposals';

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
  'history',
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
}

export interface TaxCode {
  code: string;
  kind: string;
  rateBp: number;
  label: string;
}

export interface InvoiceOption {
  documentId: string;
  number: string | null;
  contactName: string | null;
  openMinor: number;
  currency: string;
}

export interface BillOption {
  vendorBillId: string;
  reference: string | null;
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
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** `list_bank_inbox`, read defensively: an unreadable body is `null`, never a guessed list. */
export function parseInbox(body: unknown): ListBankInboxOk | null {
  const r = rec(body);
  if (r === null || !Array.isArray(r.lines) || !Array.isArray(r.summary)) return null;
  return {
    lines: r.lines as BankInboxLine[],
    nextCursor: str(r.nextCursor),
    total: num(r.total) ?? (r.lines as unknown[]).length,
    summary: r.summary as BankAccountBalance[],
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
    out.push({ id, number, name: str(a.name) ?? '', vatCodeDefault: str(a.vatCodeDefault) });
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
    out.push({ code, kind: str(c.kind) ?? 'none', rateBp: num(c.rateBp) ?? 0, label: str(c.label) ?? code });
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
    out.push({ documentId, number: str(i.number), contactName: str(i.customerName), openMinor, currency });
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
    out.push({ vendorBillId, reference: str(b.vendorReference), vendorName: str(b.vendorName), openMinor, currency });
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
}

export type DraftTarget =
  | { kind: 'accounts'; legs: DraftLeg[] }
  | { kind: 'open_item'; documentId: string; remainder: RemainderMode | null }
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
  const p = line.proposal;
  if (p === null || p.target === null) return { target: null, source: 'proposal' };
  return { target: draftTargetOf(p.target), source: 'proposal' };
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
export function draftTargetOf(raw: unknown): DraftTarget | null {
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
        legs.push({ accountId, amountMinor, taxCode: str(l.taxCode) ?? '' });
      }
      return legs.length === 0 ? null : { kind: 'accounts', legs };
    }
    case 'open_item': {
      const documentId = str(t.documentId);
      if (documentId === null) return null;
      const remainder = BANK_LINE_REMAINDER_MODES.find((m) => m === t.remainder) ?? null;
      return { kind: 'open_item', documentId, remainder };
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

/** True when the draft can be sent as it stands (every leg has an account and the legs sum up). */
export function isBookable(line: BankInboxLine, target: DraftTarget | null): boolean {
  if (target === null) return false;
  // An accepted difference states its reason, or the engine refuses it (critic A39-12).
  if (target.kind === 'existing_entry') return !target.acceptDifference || (target.differenceReason ?? '').trim() !== '';
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
        legs: target.legs.map((l) => (l.taxCode === '' ? { accountId: l.accountId, amountMinor: l.amountMinor } : { accountId: l.accountId, amountMinor: l.amountMinor, taxCode: l.taxCode })),
      };
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

/** The dial family a booking falls under (the engine's input-keyed rule): post, or pay for a settlement. */
export function bookCapability(target: DraftTarget): 'post' | 'pay' {
  return target.kind === 'open_item' || target.kind === 'payment_batch' ? 'pay' : 'post';
}

/** A stable key for "is this the proposal as the engine made it". */
export function targetKey(target: DraftTarget | null): string {
  if (target === null) return '';
  switch (target.kind) {
    case 'accounts':
      return `accounts:${target.legs.map((l) => `${l.accountId}/${l.taxCode}/${l.amountMinor}`).join('|')}`;
    case 'open_item':
      return `open_item:${target.documentId}:${target.remainder ?? ''}`;
    case 'payment_batch':
      return `payment_batch:${target.batchId}`;
    case 'existing_entry':
      return `existing_entry:${target.entryId}:${target.acceptDifference ? 1 : 0}`;
  }
}

/** The certainty a row shows: the engine's, or "edited" once the person changed the proposal. */
export type RowCertainty = Certainty | 'edited' | 'agent';

/** The engine's proposal as a draft target, or null. */
export function proposalTarget(line: BankInboxLine): DraftTarget | null {
  return line.proposal === null || line.proposal.target === null ? null : draftTargetOf(line.proposal.target);
}

/** True when the row still shows the engine's proposal exactly (the person changed nothing). */
export function isUntouched(line: BankInboxLine, draft: RowDraft | undefined): boolean {
  return draft === undefined || targetKey(draft.target) === targetKey(proposalTarget(line));
}

export function rowCertainty(line: BankInboxLine, draft: RowDraft | undefined): RowCertainty {
  if (isUntouched(line, draft)) return line.proposal?.certainty ?? 'open';
  if (draft === undefined || draft.target === null) return 'open';
  return draft.source === 'agent' ? 'agent' : 'edited';
}

/** True for a proposal "Alle sicheren buchen" may send: reference-proven and untouched. */
export function isSureAndUntouched(line: BankInboxLine, draft: RowDraft | undefined): boolean {
  return (
    line.state === 'open' &&
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

// --- The Soll/Haben preview of an accounts booking ------------------------------------------------------

/** One journal line the preview shows. */
export interface PreviewLine {
  accountId: string;
  debit: number;
  credit: number;
}

/** A leg's VAT figures, as `vat_preview` answers them (A06 `computeLineTax`). */
export interface VatFigures {
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  kind: string;
  deductible: boolean;
  formLine: string | null;
}

export interface VatAccounts {
  /** 1170, Vorsteuer auf Material und Dienstleistungen. */
  input: string | null;
  /** 1171, Vorsteuer auf Investitionen (ESTV Ziffer 405). */
  investment: string | null;
  /** 2200, geschuldete MWST. */
  output: string | null;
}

/** The kinds whose natural direction is money in (`bankBooking.ts` NATURAL_IN_KINDS). */
const NATURAL_IN_KINDS: ReadonlySet<string> = new Set(['output', 'zero', 'exempt']);

/** The input a leg's `vat_preview` takes: gross for every kind but Bezugsteuer, whose paid amount is the base. */
export function vatPreviewInput(leg: DraftLeg, kind: string | null): { amountMinor: number; amountIsGross: boolean; taxCode: string } {
  return { amountMinor: Math.abs(leg.amountMinor), amountIsGross: kind !== 'reverse_charge', taxCode: leg.taxCode };
}

/**
 * The balanced line set an accounts booking posts, leg by leg, as `buildAccountsLines` builds it:
 * `buildVatLines` per taxed leg (Vorsteuer, Umsatzsteuer, Bezugsteuer, Einfuhrsteuer, the saldo fold
 * when `deductible` is false), a leg against its code's natural direction mirrored, and every bank leg
 * merged into ONE bank line first. Returns null while a taxed leg's figures are not in yet.
 */
export function composeAccountsPreview(
  lineSignedMinor: number,
  legs: readonly DraftLeg[],
  bankLedgerId: string,
  vat: ReadonlyMap<number, VatFigures>,
  vatAccounts: VatAccounts,
): PreviewLine[] | null {
  const moneyIn = lineSignedMinor > 0;
  const out: (PreviewLine & { bank: boolean })[] = [];
  const push = (accountId: string | null, debit: number, credit: number, bank = false) => {
    out.push({ accountId: accountId ?? '', debit, credit, bank });
  };
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i] as DraftLeg;
    const legIn = leg.amountMinor > 0 ? moneyIn : !moneyIn;
    const abs = Math.abs(leg.amountMinor);
    const figures = leg.taxCode === '' ? null : vat.get(i);
    if (leg.taxCode !== '' && figures === undefined) return null;
    if (figures === null || figures === undefined || figures.kind === 'none') {
      if (legIn) {
        push(leg.accountId, 0, abs);
        push(bankLedgerId, abs, 0, true);
      } else {
        push(leg.accountId, abs, 0);
        push(bankLedgerId, 0, abs, true);
      }
      continue;
    }
    const naturalIn = NATURAL_IN_KINDS.has(figures.kind);
    const inputVat = figures.formLine === '405' ? vatAccounts.investment : vatAccounts.input;
    const built: (PreviewLine & { bank: boolean })[] = [];
    const add = (accountId: string | null, debit: number, credit: number, bank = false) => built.push({ accountId: accountId ?? '', debit, credit, bank });
    if (figures.kind === 'reverse_charge') {
      add(leg.accountId, figures.netMinor, 0);
      add(bankLedgerId, 0, figures.netMinor, true);
      add(vatAccounts.output, 0, figures.taxMinor);
      if (figures.deductible) add(inputVat, figures.taxMinor, 0);
      else add(leg.accountId, figures.taxMinor, 0);
    } else if (figures.kind === 'import') {
      if (figures.deductible) add(inputVat, figures.taxMinor, 0);
      else add(leg.accountId, figures.taxMinor, 0);
      add(bankLedgerId, 0, figures.taxMinor, true);
    } else if (naturalIn) {
      add(bankLedgerId, figures.grossMinor, 0, true);
      add(leg.accountId, 0, figures.netMinor);
      if (figures.taxMinor !== 0) add(vatAccounts.output, 0, figures.taxMinor);
    } else if (figures.deductible && figures.taxMinor !== 0) {
      add(leg.accountId, figures.netMinor, 0);
      add(inputVat, figures.taxMinor, 0);
      add(bankLedgerId, 0, figures.grossMinor, true);
    } else {
      add(leg.accountId, figures.grossMinor, 0);
      add(bankLedgerId, 0, figures.grossMinor, true);
    }
    const mirrored = legIn === naturalIn ? built : built.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
    out.push(...mirrored);
  }
  let bankNet = 0;
  const merged: PreviewLine[] = [];
  for (const l of out) {
    if (l.bank) {
      bankNet += l.debit - l.credit;
      continue;
    }
    if (l.debit === 0 && l.credit === 0) continue;
    merged.push({ accountId: l.accountId, debit: l.debit, credit: l.credit });
  }
  const bankLine: PreviewLine = bankNet >= 0 ? { accountId: bankLedgerId, debit: bankNet, credit: 0 } : { accountId: bankLedgerId, debit: 0, credit: -bankNet };
  return [bankLine, ...merged];
}

/** True when a preview balances (Soll equals Haben): the one check a composed preview must pass. */
export function previewBalances(lines: readonly PreviewLine[]): boolean {
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  return debit === credit;
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
