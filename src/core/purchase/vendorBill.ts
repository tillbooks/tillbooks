/**
 * A17, vendor bills and expenses: the CREDITOR half of the money path.
 *
 * Before this module TILL could invoice a customer and could not record what it owed. There was not
 * one purchase verb in the registry, so every supplier cost was unbooked and every Rappen of
 * reclaimable Vorsteuer unrecovered. This is the write side of that: capture a supplier bill, post it
 * to 2000 Kreditoren with its input VAT split out to 1170/1171, and let A14 settle it.
 *
 * FOUR RULES SHAPE EVERY LINE BELOW.
 *
 * 1. **A17 COMPUTES NO VAT.** Every figure it stores comes from A06's `computeLineTax` and every leg
 *    it posts comes from A06's `buildVatLines`, which are the same two functions behind the
 *    `vat_preview` verb and A11's issue path. Input VAT lands in a FILED MWST-Abrechnung, and a
 *    second computation is how a filed figure drifts, so there is exactly one. The proof is a test
 *    that compares the stored trace against `vat_preview`'s answer for the same input rather than
 *    against a hand-written expectation.
 *
 * 2. **THE POSTING IS A02's AND THE CORRECTION IS A REVERSING ENTRY.** `postVendorBill` composes the
 *    legs and hands them to `postEntry`; `voidVendorBill` calls `reverseEntry`. Nothing here writes a
 *    journal row, nothing here mutates a posted one, and the DB triggers in `./schema.ts` mean the
 *    bill row itself cannot be edited once it is posted either.
 *
 * 3. **THE ENTRY THAT COMES BACK IS VERIFIED, NOT TRUSTED.** A returned id is a claim; the rows are
 *    the fact. `postVendorBill` reads its own entry back and refuses anything that is not the posting
 *    it planned, which is the check whose absence let a squatted idempotency key substitute a CHF 0.01
 *    entry for a CHF 1'081.00 one on the sales side (A11's own note).
 *
 * 4. **WHAT THE BILL OWES IS `payable_minor`, NOT `gross_minor`.** See `./schema.ts`: Bezugsteuer
 *    credits the net and Einfuhrsteuer credits the assessed tax, so the debt is the amount the ledger
 *    actually credited to 2000 and not the arithmetic total of the trace.
 *
 * THE CONVERSION DATE IS THE BILL DATE. MWSTV Art. 45 Abs. 1 converts at the moment the tax claim
 * arises, and on the purchase side under vereinbarten Entgelten that moment is the supplier's invoice,
 * not our own. A11's `buildInvoicePosting` says the same thing from the other side: "the sales side
 * converts at the invoice date, full stop; the purchase side (A17) will convert at the date the
 * invoice was RECEIVED, which is a different date for the same transaction, by design."
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString, requireDate, optionalDate, optionalId, optionalText } from '../ledger/inputGuards.js';
import { postEntry, statesConversionBasis } from '../ledger/postEntry.js';
import { reverseEntry } from '../ledger/reverseEntry.js';
import { buildVatLines, computeLineTax } from '../vat/applyVat.js';
import type { VatJournalLine } from '../vat/applyVat.js';
import { resolveTax } from '../vat/resolveTax.js';
import { resolveFxRate, baseCurrencyOf } from '../fx/rates.js';
import { ROLE_ACCOUNT_NUMBER } from '../payments/accounts.js';
import { resolveContactRef } from '../sales/contact.js';
import { readProject } from '../projects/index.js';
import { isVendorBillTaxKind, VENDOR_BILL_TAX_KINDS } from './enums.js';
import type { VendorBillStatus } from './enums.js';
import { readVendorBillRow, vendorBillEcho, settledOnVendorBill } from './reads.js';
import type { VendorBillRow } from './reads.js';

/** 2000 Kreditoren, from A14's one role map. A17 states no account number of its own. */
const PAYABLE_ACCOUNT = ROLE_ACCOUNT_NUMBER.payable;

/** The account TYPES a purchase may be booked to: a cost, or a capitalised asset (15xx). */
const EXPENSE_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['expense', 'asset']);

/**
 * Accounts a supplier bill may never name as its cost side (A17-C3).
 *
 * Two sources, and the choice of NUMBERS over a type rule is stated because it was asked: the chart
 * carries no sub-classification below `asset`/`liability`/`expense`/`income`/`equity`, so no type
 * predicate can admit 1500 Maschinen (a legitimate capitalised purchase) while refusing 1020
 * Bankkonto, and both are `asset`. The numbers are the only vocabulary the seed provides.
 *
 *  1. EVERY number in A14's role map, not four hand-picked members of it. These are the accounts
 *     some engine books as a CONSEQUENCE (settlement, Skonto, write-off, FX, VAT), so a bill's cost
 *     side landing on one folds a purchase into a figure another module derives. 1170/1171 are
 *     `asset` rows and pass the type check above, which is why this list exists at all; the same
 *     sentence is true of 1100 Debitoren, whose corruption breaks A16's OP-Liste reconciliation
 *     (measured by the critic), and of the correction accounts 3800/4900/3805/3806/4906.
 *  2. The liquidity and claims block: 1000 Kassenbestand and 1020 Bankkonto (money accounts: a bill
 *     debiting one invents cash no movement produced, which is exactly what A20/A21 reconcile
 *     against a camt statement), 1109 Wertberichtigung Forderungen (the receivable's contra) and
 *     1176 Guthaben Verrechnungssteuer (a tax claim only its own withholding flow may build).
 *
 * DELIBERATELY NOT RESERVED: 1200 Vorräte, 1300 aktive Rechnungsabgrenzung, 1060 Wertpapiere and
 * the 15xx Anlagevermögen. A stock purchase, a prepaid expense and a capitalised asset are exactly
 * what a supplier bill legitimately books to; over-blocking those would refuse real accounting to
 * protect nothing, since no shipped module derives an invariant from them.
 *
 * The Studio's picker mirrors this set (`app/src/surfaces/Bills/model.ts`), and
 * `test/purchase/studio-bills-fixture.test.mjs` holds the two lists identical.
 */
export const RESERVED_EXPENSE_ACCOUNTS: ReadonlySet<string> = new Set([
  ...Object.values(ROLE_ACCOUNT_NUMBER),
  '1000',
  '1020',
  '1109',
  '1176',
]);

/**
 * `journal_entry.source` for a vendor bill.
 *
 * Its OWN source and not `manual`, because `list_journal` filters on it and because a Kreditoren
 * posting is a distinct business event from a hand-typed entry. It is deliberately NOT added to
 * `POST_ENTRY_SOURCES` (the agent-facing allow-list on `post_entry`), which is what makes P3
 * structural here: a caller cannot mint an entry claiming to be a vendor bill without a bill row
 * behind it, exactly as `reversal` and `close` are kept off that boundary.
 */
const PURCHASE_SOURCE = 'purchase';

export interface CreateVendorBillInput {
  vendorId: string;
  billDate: string;
  dueDate?: string;
  /** The Leistungsdatum. Defaults to the bill date, which is what prices the VAT (A06). */
  supplyDate?: string;
  vendorReference?: string;
  currency?: string;
  /** Rappen, positive. The figure on the paper bill. */
  amountMinor: number;
  /** True (the default) when `amountMinor` is the gross: a paper bill states its total. */
  amountIsGross?: boolean;
  taxCode?: string | null;
  expenseAccountId: string;
  costCenterId?: string;
  /**
   * B03, the project cost dimension: the B00 project this purchase belongs to. A REPORTING tag,
   * exactly like `costCenterId` beside it: it prices nothing and appears on no journal leg.
   */
  projectId?: string;
  receiptRef?: string;
  /** The rate to convert into base currency. Absent, §H-FX resolves it for the bill date. */
  fxRate?: string;
  idempotencyKey: string;
}

export interface PostVendorBillInput {
  vendorBillId: string;
  idempotencyKey: string;
}

export interface AttachReceiptInput {
  vendorBillId: string;
  receiptRef: string;
  idempotencyKey: string;
}

export interface VoidVendorBillInput {
  vendorBillId: string;
  reason?: string;
  date?: string;
  idempotencyKey: string;
}

/** Abort a write transaction with a structured cause, so nothing is memoised on a rejection. */
class BillAbort {
  constructor(public readonly result: Result) {}
}

function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof BillAbort) return e.result;
    throw e;
  }
}

function isPositiveMinor(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

interface AccountRow {
  id: string;
  number: string;
  name: string;
  type: string;
  archived: number;
}

function readAccount(ctx: WorkspaceContext, id: unknown): AccountRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT id, number, name, type, archived FROM account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as AccountRow | undefined;
}

/**
 * Resolve 2000 Kreditoren, or say which number to restore.
 *
 * Looked up by NUMBER through A14's role map rather than hard-coded here, so the payable account has
 * ONE definition in the repo and a workspace that archived it is told exactly what is missing instead
 * of having a posting invent an account the Treuhänder never approved.
 */
function resolvePayableAccount(ctx: WorkspaceContext): AccountRow | Result {
  const row = ctx.store.db
    .prepare('SELECT id, number, name, type, archived FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, PAYABLE_ACCOUNT) as AccountRow | undefined;
  if (row === undefined || row.archived === 1) {
    return err('needs_account', {
      role: 'payable',
      number: PAYABLE_ACCOUNT,
      reason: row === undefined ? 'missing' : 'archived',
    });
  }
  return row;
}

/**
 * The vendor, and why a customer-only contact is REFUSED rather than accepted.
 *
 * Booking a purchase against a party that is only a customer is the mirror of a defect this repo has
 * already recorded on the sales side (an invoice issued to a vendor-role contact breaks the 1100
 * reconciliation). The fix a caller needs is one call to `contacts_tag`, so the rejection names it.
 * A MERGE TOMBSTONE is refused with the survivor named, exactly as A14 refuses one for a payment's
 * counterparty: `contact_id` on a bill is re-pointed by a merge, but a caller who names a retired id
 * should be told which one is live rather than silently redirected.
 */
function resolveVendor(ctx: WorkspaceContext, vendorId: unknown): { id: string; name: string } | Result {
  if (typeof vendorId !== 'string' || vendorId.length === 0) {
    return err('needs_vendor', { field: 'vendorId', reason: 'missing' });
  }
  const row = ctx.store.db
    .prepare('SELECT id, name, party_role, archived, merged_into_id FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, vendorId) as
    | { id: string; name: string; party_role: string; archived: number; merged_into_id: string | null }
    | undefined;
  // §H-TENANT: a foreign contact and a nonexistent one get the SAME answer, so no id is probeable
  // across tenants.
  if (row === undefined) return err('needs_vendor', { field: 'vendorId', reason: 'unknown' });
  if (row.merged_into_id !== null) {
    return err('needs_vendor', {
      field: 'vendorId',
      reason: 'merged',
      vendorId,
      survivorId: resolveContactRef(ctx, vendorId)?.id ?? row.merged_into_id,
    });
  }
  if (row.archived === 1) return err('needs_vendor', { field: 'vendorId', reason: 'archived' });
  if (row.party_role !== 'vendor' && row.party_role !== 'both') {
    return err('needs_vendor', {
      field: 'vendorId',
      reason: 'party_role',
      partyRole: row.party_role,
      hint: 'a bill is owed to a vendor: give this contact the vendor role (contacts_tag) or name another',
    });
  }
  return { id: row.id, name: row.name };
}

/**
 * The tax code, checked for SIDE before anything is booked.
 *
 * A06's input branch will happily book an output, zero-rated or exempt code: `deductible` is false for
 * all three, so the whole gross folds into the expense account carrying a trace that reports on ESTV
 * Ziffer 302, 220 or 230. Those Ziffern are statements about TURNOVER. A purchase reported there is a
 * wrong filed figure that balances perfectly, which is exactly the class of defect that survives
 * review, so the code is refused at the door with the kinds a purchase admits named.
 */
function guardTaxCodeSide(ctx: WorkspaceContext, taxCode: string | null, supplyDate: string): Result | null {
  if (taxCode === null || taxCode === 'none') return null;
  const resolved = resolveTax(ctx, { taxCode, supplyDate });
  if (!resolved.ok) return resolved;
  const kind = resolved.kind as string;
  if (!isVendorBillTaxKind(kind)) {
    return err('needs_input_tax_code', {
      field: 'taxCode',
      taxCode,
      kind,
      allowedKinds: [...VENDOR_BILL_TAX_KINDS],
      hint: 'an output, zero-rated or exempt code describes turnover; a purchase carries an input, Bezugsteuer or Einfuhrsteuer code, or none at all',
    });
  }
  return null;
}

/** The default due date: the vendor's payment terms from the bill date, or the bill date itself. */
function defaultDueDate(ctx: WorkspaceContext, vendorId: string, billDate: string): string {
  const row = ctx.store.db
    .prepare('SELECT payment_terms_days FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, vendorId) as { payment_terms_days: number | null } | undefined;
  const days = row?.payment_terms_days ?? null;
  if (days === null || !Number.isSafeInteger(days) || days <= 0) return billDate;
  const at = Date.parse(`${billDate}T00:00:00.000Z`);
  if (Number.isNaN(at)) return billDate;
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

/** The computed figures a bill stores, all from A06 and none of them arithmetic of A17's own. */
interface BillFigures {
  netMinor: number;
  taxAmountMinor: number;
  grossMinor: number;
  payableMinor: number;
  lines: VatJournalLine[];
  vorsteuerDeductible: boolean;
  kind: string;
  formLine: string | null;
  rateBp: number;
}

/**
 * Compute the figures and the legs for one bill, through A06 and only A06.
 *
 * `payableMinor` is read off the legs rather than assumed: it is the sum of what the counter account
 * is CREDITED, which is the gross for ordinary Vorsteuer, the net for Bezugsteuer and the assessed tax
 * for Einfuhrsteuer. Deriving it from the legs means the debt and the ledger cannot disagree even when
 * a future A05 kind books a shape neither of them anticipated.
 */
function figuresFor(
  ctx: WorkspaceContext,
  input: {
    amountMinor: number;
    amountIsGross: boolean;
    taxCode: string | null;
    supplyDate: string;
    expenseAccountId: string;
    payableAccountId: string;
    costCenterId?: string | undefined;
  },
): BillFigures | Result {
  const computed = computeLineTax(ctx, {
    amountMinor: input.amountMinor,
    amountIsGross: input.amountIsGross,
    taxCode: input.taxCode,
    supplyDate: input.supplyDate,
  });
  if (!computed.ok) return computed;

  let lines: VatJournalLine[];
  try {
    lines = buildVatLines(ctx, {
      counterAccount: input.payableAccountId,
      revenueOrExpenseAccount: input.expenseAccountId,
      amountMinor: input.amountMinor,
      amountIsGross: input.amountIsGross,
      taxCode: input.taxCode,
      direction: 'input',
      supplyDate: input.supplyDate,
      ...(input.costCenterId !== undefined ? { costCenterId: input.costCenterId } : {}),
    });
  } catch (e) {
    // `buildVatLines` throws a structured cause (a missing 1170/1171/2200, an unknown code) rather
    // than returning a Result. Surfaced as a P9 rejection so the caller reads a code, not a stack.
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith('missing_vat_account:')) {
      return err('needs_account', { role: 'vatAccount', number: message.split(': ')[1] ?? null, reason: 'missing' });
    }
    return err('vat_build_failed', { reason: message });
  }

  const payableMinor = lines
    .filter((l) => l.account === input.payableAccountId)
    .reduce((n, l) => n + (l.credit ?? 0) - (l.debit ?? 0), 0);

  return {
    netMinor: computed.netMinor as number,
    taxAmountMinor: computed.taxMinor as number,
    grossMinor: computed.grossMinor as number,
    payableMinor,
    lines,
    // Under Saldo (MWSTG Art. 37) the flat rate already imputes input tax, so nothing is separately
    // reclaimable and the expense books gross. That is REPORTED rather than refused: the booking is
    // correct and the operator is entitled to know the Vorsteuer was not split out.
    vorsteuerDeductible: computed.deductible as boolean,
    kind: computed.kind as string,
    formLine: (computed.formLine as string | null) ?? null,
    rateBp: computed.rateBp as number,
  };
}

/** Everything `createVendorBill` and `recordExpense` both validate, resolved once. */
interface PreparedBill {
  vendor: { id: string; name: string };
  expense: AccountRow;
  payable: AccountRow;
  billDate: string;
  dueDate: string;
  supplyDate: string;
  currency: string;
  amountIsGross: boolean;
  taxCode: string | null;
  figures: BillFigures;
}

function prepare(ctx: WorkspaceContext, input: CreateVendorBillInput): PreparedBill | Result {
  const guard =
    requireString(input.vendorId, 'vendorId') ??
    requireDate(input.billDate, 'billDate') ??
    optionalDate(input.dueDate, 'dueDate') ??
    optionalDate(input.supplyDate, 'supplyDate') ??
    requireString(input.expenseAccountId, 'expenseAccountId') ??
    optionalId(input.costCenterId, 'costCenterId') ??
    optionalId(input.projectId, 'projectId') ??
    optionalText(input.vendorReference, 'vendorReference') ??
    optionalText(input.receiptRef, 'receiptRef') ??
    requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!isPositiveMinor(input.amountMinor)) return err('invalid_input', { field: 'amountMinor' });
  if (input.amountIsGross !== undefined && typeof input.amountIsGross !== 'boolean') {
    return err('invalid_input', { field: 'amountIsGross' });
  }
  if (input.taxCode !== undefined && input.taxCode !== null && typeof input.taxCode !== 'string') {
    return err('invalid_input', { field: 'taxCode' });
  }

  const vendor = resolveVendor(ctx, input.vendorId);
  if ('ok' in vendor) return vendor;

  const expense = readAccount(ctx, input.expenseAccountId);
  if (expense === undefined || expense.archived === 1) {
    return err('needs_account', { field: 'expenseAccountId', reason: expense === undefined ? 'unknown' : 'archived' });
  }
  if (!EXPENSE_ACCOUNT_TYPES.has(expense.type)) {
    // A purchase is a cost or a capitalised asset. Debiting revenue or equity with a supplier bill
    // balances and reports nonsense, and the operator cannot see it in the totals.
    return err('needs_account', {
      field: 'expenseAccountId',
      reason: 'not_an_expense_or_asset_account',
      accountNumber: expense.number,
      accountType: expense.type,
    });
  }
  if (RESERVED_EXPENSE_ACCOUNTS.has(expense.number)) {
    // 1170 and 1171 are asset accounts, so they PASS the type check, and booking the cost side of a
    // bill onto one would silently double the Vorsteuer figure this module then reads back off the
    // entry. 2000 would corrupt the payable the same way, and 2200 would put purchase tax on the
    // output line. Refused by NUMBER, which is where those four accounts are already defined once.
    return err('needs_account', {
      field: 'expenseAccountId',
      reason: 'reserved_account',
      accountNumber: expense.number,
      hint: 'the Kreditoren and MWST accounts are booked by the engine; name the cost or asset account the purchase belongs to',
    });
  }

  if (input.costCenterId !== undefined) {
    const cc = ctx.store.db
      .prepare('SELECT id, archived FROM cost_center WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, input.costCenterId) as { id: string; archived: number } | undefined;
    if (cc === undefined || cc.archived === 1) {
      return err('invalid_reference', { field: 'costCenterId' });
    }
  }

  // §H-TENANT via readProject (workspace-fenced): a cross-tenant or unknown project is refused the
  // same way, so no project id is probeable through a bill.
  if (input.projectId !== undefined && readProject(ctx, input.projectId) === undefined) {
    return err('invalid_reference', { field: 'projectId' });
  }

  const payable = resolvePayableAccount(ctx);
  if ('ok' in payable) return payable;

  const billDate = input.billDate;
  const supplyDate = input.supplyDate ?? billDate;
  const taxCode = input.taxCode ?? null;
  const sideErr = guardTaxCodeSide(ctx, taxCode, supplyDate);
  if (sideErr) return sideErr;

  const base = baseCurrencyOf(ctx);
  const currency = input.currency ?? base;
  if (typeof currency !== 'string') return err('invalid_input', { field: 'currency' });

  const amountIsGross = input.amountIsGross ?? true;
  const figures = figuresFor(ctx, {
    amountMinor: input.amountMinor,
    amountIsGross,
    taxCode,
    supplyDate,
    expenseAccountId: expense.id,
    payableAccountId: payable.id,
    ...(input.costCenterId !== undefined ? { costCenterId: input.costCenterId } : {}),
  });
  if ('ok' in figures) return figures;

  return {
    vendor,
    expense,
    payable,
    billDate,
    dueDate: input.dueDate ?? defaultDueDate(ctx, vendor.id, billDate),
    supplyDate,
    currency,
    amountIsGross,
    taxCode,
    figures,
  };
}

// --- createVendorBill -----------------------------------------------------------------------------

/**
 * Write a DRAFT bill. No posting, no ledger effect, nothing in a period lock's way.
 *
 * This is the agent's entry point (P8): an agent drafts and a human posts, so the two-step pair is
 * what keeps an unattended caller draft-first by default. `recordExpense` is the human one-shot.
 */
export function createVendorBill(ctx: WorkspaceContext, input: CreateVendorBillInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;

  const guard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const scopedKey = JSON.stringify(['create_vendor_bill', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'create_vendor_bill');
  if (replayed !== undefined) return replayed;

  // The raw key is unique per workspace at the DB layer, which is STRONGER than the memo above: the
  // memo replays an identical retry, this refuses a key reused for a DIFFERENT bill. Checked here so
  // the refusal is a P9 Result naming the bill that already holds the key rather than a driver
  // constraint escaping as a throw.
  const holder = ctx.store.db
    .prepare('SELECT id FROM vendor_bill WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, input.idempotencyKey) as { id: string } | undefined;
  if (holder !== undefined) {
    return err('idempotency_key_conflict', {
      idempotencyKey: input.idempotencyKey,
      vendorBillId: holder.id,
      reason: 'this key already created a different bill; a retry must repeat the same input',
    });
  }

  const prepared = prepare(ctx, input);
  if ('ok' in prepared) return prepared;

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'create_vendor_bill', () => {
    const id = insertDraft(ctx, input, prepared);
    ctx.audit.record({
      entityKind: 'vendor_bill',
      entityId: id,
      action: 'create',
      actor: ctx.actor,
      at: ctx.clock.now(),
    });
    return ok({ vendorBill: vendorBillEcho(ctx, id), vendorBillId: id });
  });
}

function insertDraft(ctx: WorkspaceContext, input: CreateVendorBillInput, prepared: PreparedBill): string {
  const id = ctx.ids.next('vbill');
  ctx.store.db
    .prepare(
      `INSERT INTO vendor_bill
         (id, workspace_id, contact_id, bill_date, due_date, supply_date, vendor_reference, currency,
          amount_is_gross, net_minor, tax_code, tax_amount_minor, gross_minor, payable_minor,
          expense_account_id, cost_center_id, project_id, receipt_ref, status, base_net_minor, base_tax_minor,
          base_gross_minor, base_payable_minor, fx_rate, entry_id, reversal_entry_id, void_reason,
          idempotency_key, created_by, created_at, posted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft',
               NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL)`,
    )
    .run(
      id,
      ctx.workspaceId,
      prepared.vendor.id,
      prepared.billDate,
      prepared.dueDate,
      prepared.supplyDate,
      input.vendorReference ?? null,
      prepared.currency,
      prepared.amountIsGross ? 1 : 0,
      prepared.figures.netMinor,
      prepared.taxCode,
      prepared.figures.taxAmountMinor,
      prepared.figures.grossMinor,
      prepared.figures.payableMinor,
      prepared.expense.id,
      input.costCenterId ?? null,
      input.projectId ?? null,
      input.receiptRef ?? null,
      input.idempotencyKey,
      ctx.actor,
      ctx.clock.now(),
    );
  return id;
}

// --- postVendorBill -------------------------------------------------------------------------------

/**
 * Post an existing draft: the ONE place a vendor bill reaches the ledger.
 *
 * The figures are RE-COMPUTED from the stored input rather than replayed from the stored output, and
 * that is deliberate: a draft can sit for a week, and if the workspace's VAT method or a rate era
 * changed in between, the booking must be the one that is correct at the supply date now, not the one
 * a stale preview cached. The stored figures are then refreshed to match what was actually posted, so
 * the row and the entry agree by construction.
 */
export function postVendorBill(ctx: WorkspaceContext, input: PostVendorBillInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.vendorBillId, 'vendorBillId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['post_vendor_bill', input.vendorBillId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'post_vendor_bill');
  if (replayed !== undefined) return replayed;

  const bill = readVendorBillRow(ctx, input.vendorBillId);
  if (bill === undefined) return err('not_found', { vendorBillId: input.vendorBillId });
  // A REPLAY UNDER A DIFFERENT KEY IS NOT AN ERROR TO HIDE: it is the one shape that would
  // double-post, and it is refused with the entry the bill already carries so the caller can see
  // there is nothing left to do.
  if (bill.status === 'posted') {
    return err('already_posted', { vendorBillId: bill.id, entryId: bill.entry_id });
  }
  if (bill.status === 'void') return err('already_void', { vendorBillId: bill.id });

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'post_vendor_bill', () => {
      const posted = postBillRow(ctx, bill);
      if (!posted.ok) throw new BillAbort(posted);
      return posted;
    }),
  );
}

/**
 * The shared post: used by `postVendorBill` and, unchanged, by `recordExpense`.
 *
 * ONE implementation, which is what makes the spec's §8 claim ("`recordExpense` produces an identical
 * posting to a separate create + post pair") a property of the code rather than a promise about it.
 */
function postBillRow(ctx: WorkspaceContext, bill: VendorBillRow): Result {
  const payable = resolvePayableAccount(ctx);
  if ('ok' in payable) return payable;

  const supplyDate = bill.supply_date ?? bill.bill_date;
  const sideErr = guardTaxCodeSide(ctx, bill.tax_code, supplyDate);
  if (sideErr) return sideErr;

  const figures = figuresFor(ctx, {
    amountMinor: bill.amount_is_gross === 1 ? bill.gross_minor : bill.net_minor,
    amountIsGross: bill.amount_is_gross === 1,
    taxCode: bill.tax_code,
    supplyDate,
    expenseAccountId: bill.expense_account_id,
    payableAccountId: payable.id,
    ...(bill.cost_center_id !== null ? { costCenterId: bill.cost_center_id } : {}),
  });
  if ('ok' in figures) return figures;

  // §H-FX at the BILL date (MWSTV Art. 45 Abs. 1 on the purchase side). No admissible rate means the
  // whole post is refused with the pair, the date and the verb that fixes it, never converted at a
  // guess.
  const base = baseCurrencyOf(ctx);
  const resolution = resolveFxRate(ctx, {
    currency: bill.currency,
    date: bill.bill_date,
    ...(bill.fx_rate !== null ? { explicitRate: bill.fx_rate } : {}),
  });
  if (!resolution.ok) return resolution;
  const fx = resolution.resolved;

  // MINTED, never derived from the bill id. `invoice-post-<documentId>` was computable by anyone
  // holding the document id, and any post-capable caller could occupy the slot first (A11's own
  // note). The bill's `entry_id` remains the link between the two.
  const postingKey = `vendor-bill-post-${bill.id}-${ctx.ids.next('vbk')}`;
  const posted = postEntry(ctx, {
    date: bill.bill_date,
    source: PURCHASE_SOURCE,
    ...(bill.vendor_reference !== null ? { ref: bill.vendor_reference } : {}),
    description: `Kreditorenrechnung ${bill.vendor_reference ?? bill.id}`,
    idempotencyKey: postingKey,
    lines: figures.lines,
    ...(statesConversionBasis({ currency: bill.currency, baseCurrency: base })
      ? { currency: bill.currency, fxRate: fx.rate }
      : {}),
  });
  if (!posted.ok) return posted;
  const entryId = posted.entryId;

  const mismatch = verifyEntryIsOurs(ctx, entryId, {
    date: bill.bill_date,
    lines: figures.lines,
  });
  if (mismatch !== null) {
    return err('posting_verification_failed', {
      vendorBillId: bill.id,
      entryId,
      mismatch,
      reason: 'the entry under this posting key is not this bill: refusing to post against it',
    });
  }

  // THE BASE FIGURES ARE READ OFF THE POSTED ENTRY, never recomputed, and the three rules are:
  //
  //   base_gross   = the entry's total base DEBIT. Universal across every A05 kind: an ordinary
  //                  Vorsteuer bill debits net + tax, a Bezugsteuer bill debits net + the deduction
  //                  leg (or net + tax into the cost when it is not deductible), an Einfuhrsteuer
  //                  bill debits the assessed tax, and each of those IS that bill's gross.
  //   base_tax     = the base movement on 1170 + 1171, which is A02's own stated rule ("the CHF
  //                  figure an MWST filing needs is already stored as a value, the base movement on
  //                  2200 / 1170, never recomputed"). It is ZERO under Saldo, and that is the fact
  //                  rather than a gap: MWSTG Art. 37 imputes input tax into the flat rate, so
  //                  nothing was booked to Vorsteuer and `vorsteuerDeductible:false` says why.
  //   base_net     = base_gross - base_tax, so the three are internally consistent by construction
  //                  instead of each being rounded independently against the others.
  //
  // §H-FX converts once per SIDE on the side total and allocates back by largest remainder, so a
  // per-line multiplication is NOT what the ledger holds, and a Kreditoren reconciliation built on one
  // would be a Rappen out on a foreign bill.
  const basePayable = Math.abs(baseMovementOn(ctx, entryId, payable.id));
  const baseTax = Math.abs(
    baseMovementOn(ctx, entryId, accountIdByNumber(ctx, ROLE_ACCOUNT_NUMBER.inputVat)) +
      baseMovementOn(ctx, entryId, accountIdByNumber(ctx, ROLE_ACCOUNT_NUMBER.inputVatInvestment)),
  );
  const baseGross = totalBaseDebit(ctx, entryId);

  ctx.store.db
    .prepare(
      `UPDATE vendor_bill
          SET status = 'posted', net_minor = ?, tax_amount_minor = ?, gross_minor = ?, payable_minor = ?,
              base_net_minor = ?, base_tax_minor = ?, base_gross_minor = ?, base_payable_minor = ?,
              fx_rate = ?, entry_id = ?, posted_at = ?
        WHERE workspace_id = ? AND id = ? AND status = 'draft'`,
    )
    .run(
      figures.netMinor,
      figures.taxAmountMinor,
      figures.grossMinor,
      figures.payableMinor,
      baseGross - baseTax,
      baseTax,
      baseGross,
      basePayable,
      statesConversionBasis({ currency: bill.currency, baseCurrency: base }) ? fx.rate : null,
      entryId,
      ctx.clock.now(),
      ctx.workspaceId,
      bill.id,
    );

  ctx.audit.record({
    entityKind: 'vendor_bill',
    entityId: bill.id,
    action: 'post',
    actor: ctx.actor,
    at: ctx.clock.now(),
  });

  return ok({
    vendorBillId: bill.id,
    entryId,
    vendorBill: vendorBillEcho(ctx, bill.id),
    // Said out loud, because MWSTG Art. 37 is the difference between reclaiming the Vorsteuer and
    // booking it as a cost, and an operator on Saldo is entitled to see which happened.
    vorsteuerDeductible: figures.vorsteuerDeductible,
    ...(figures.vorsteuerDeductible ? {} : { vorsteuerReason: 'saldo_method' }),
  });
}

/** An account id by its KMU number, or null. §H-TENANT on the lookup. */
function accountIdByNumber(ctx: WorkspaceContext, number: string): string | null {
  const row = ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number) as { id: string } | undefined;
  return row?.id ?? null;
}

/** The entry's total base debit, which for a vendor-bill entry is that bill's base gross. */
function totalBaseDebit(ctx: WorkspaceContext, entryId: string): number {
  const row = ctx.store.db
    .prepare(
      'SELECT COALESCE(SUM(base_debit_minor), 0) AS total FROM journal_line INDEXED BY journal_line_entry WHERE entry_id = ?',
    )
    .get(entryId) as { total: number };
  return row.total;
}

/** The net BASE movement on one account within one entry. Zero when the account is absent. */
function baseMovementOn(ctx: WorkspaceContext, entryId: string, accountId: string | null): number {
  if (accountId === null) return 0;
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(base_debit_minor - base_credit_minor), 0) AS net
         FROM journal_line INDEXED BY journal_line_entry WHERE entry_id = ? AND account_id = ?`,
    )
    .get(entryId, accountId) as { net: number };
  return row.net;
}

/**
 * Read back what A02 actually wrote and refuse anything that is not the posting we planned.
 *
 * The FULL line set as a multiset, plus the date and the source, and not one aggregate: a summed
 * payable says nothing about the counter-accounts, nothing about credits on the same account, and
 * nothing about the date. An independent critic walked through A11's one-aggregate version of this
 * check three ways, and this is the shape that replaced it.
 */
function verifyEntryIsOurs(
  ctx: WorkspaceContext,
  entryId: string,
  expected: { date: string; lines: readonly VatJournalLine[] },
): Record<string, unknown> | null {
  const entry = ctx.store.db
    .prepare('SELECT id, status, date, source FROM journal_entry WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, entryId) as { id: string; status: string; date: string; source: string } | undefined;
  if (entry === undefined) return { reason: 'entry_absent' };
  if (entry.status !== 'posted') return { reason: 'entry_not_posted', status: entry.status };
  if (entry.source !== PURCHASE_SOURCE) return { reason: 'wrong_source', source: entry.source };
  if (entry.date !== expected.date) return { reason: 'wrong_date', date: entry.date };

  const rows = ctx.store.db
    .prepare(
      `SELECT account_id, debit_minor, credit_minor FROM journal_line INDEXED BY journal_line_entry
        WHERE entry_id = ?`,
    )
    .all(entryId) as { account_id: string; debit_minor: number; credit_minor: number }[];
  const key = (a: string, d: number, c: number) => `${a}|${d}|${c}`;
  const want = new Map<string, number>();
  for (const l of expected.lines) {
    const k = key(l.account, l.debit ?? 0, l.credit ?? 0);
    want.set(k, (want.get(k) ?? 0) + 1);
  }
  for (const r of rows) {
    const k = key(r.account_id, r.debit_minor, r.credit_minor);
    const n = want.get(k);
    if (n === undefined) return { reason: 'unexpected_line', accountId: r.account_id };
    if (n === 1) want.delete(k);
    else want.set(k, n - 1);
  }
  if (want.size > 0) return { reason: 'missing_line', count: want.size };

  const totals = ctx.store.db
    .prepare(
      'SELECT COALESCE(SUM(base_debit_minor),0) AS d, COALESCE(SUM(base_credit_minor),0) AS c FROM journal_line WHERE entry_id = ?',
    )
    .get(entryId) as { d: number; c: number };
  if (totals.d !== totals.c) return { reason: 'unbalanced', debitMinor: totals.d, creditMinor: totals.c };
  return null;
}

// --- recordExpense --------------------------------------------------------------------------------

/**
 * The human one-shot: create and post in ONE transaction (US-A17.1).
 *
 * A thin composition and not a second implementation: it inserts the same draft row
 * `createVendorBill` inserts and calls the same `postBillRow` `postVendorBill` calls. If the post is
 * refused, the whole transaction rolls back and no draft is left behind, which is the difference
 * between a one-shot and two calls a caller has to clean up after.
 *
 * This is the write surface A06 §5 names as A17's VAT-carrying tool, and the entry that retires
 * `record_expense` from `PENDING_TOOLS`.
 */
export function recordExpense(ctx: WorkspaceContext, input: CreateVendorBillInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['record_expense', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'record_expense');
  if (replayed !== undefined) return replayed;

  const holder = ctx.store.db
    .prepare('SELECT id FROM vendor_bill WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, input.idempotencyKey) as { id: string } | undefined;
  if (holder !== undefined) {
    return err('idempotency_key_conflict', {
      idempotencyKey: input.idempotencyKey,
      vendorBillId: holder.id,
      reason: 'this key already created a different bill; a retry must repeat the same input',
    });
  }

  const prepared = prepare(ctx, input);
  if ('ok' in prepared) return prepared;

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'record_expense', () => {
      const id = insertDraft(ctx, input, prepared);
      const bill = readVendorBillRow(ctx, id);
      if (bill === undefined) throw new BillAbort(err('not_found', { vendorBillId: id }));
      const posted = postBillRow(ctx, bill);
      // The throw is the ONLY way to roll a better-sqlite3 transaction back, so a rejection
      // discovered after the draft insert leaves no draft and memoises nothing.
      if (!posted.ok) throw new BillAbort(posted);
      ctx.audit.record({
        entityKind: 'vendor_bill',
        entityId: id,
        action: 'create',
        actor: ctx.actor,
        at: ctx.clock.now(),
      });
      return posted;
    }),
  );
}

// --- attachReceipt --------------------------------------------------------------------------------

/**
 * Attach the Buchungsbeleg reference to a bill, draft or posted.
 *
 * A17 stores a POINTER and not a file: the file lifecycle is E00's, and a receipt store A17 invented
 * would be a second one. OR 958f Abs. 1 requires the Belege to be kept for ten years; what this
 * column does is make the bill say WHICH one, so the retention rail has something to hold.
 *
 * It is the one write that touches a posted row, and it moves exactly one column. The DB trigger
 * permits that column and refuses every accounting one, so this cannot become an edit path.
 */
export function attachReceipt(ctx: WorkspaceContext, input: AttachReceiptInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.vendorBillId, 'vendorBillId') ??
    requireString(input.receiptRef, 'receiptRef') ??
    requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['attach_receipt', input.vendorBillId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'attach_receipt');
  if (replayed !== undefined) return replayed;

  const bill = readVendorBillRow(ctx, input.vendorBillId);
  if (bill === undefined) return err('not_found', { vendorBillId: input.vendorBillId });
  if (bill.status === 'void') return err('already_void', { vendorBillId: bill.id });

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'attach_receipt', () => {
    ctx.store.db
      .prepare('UPDATE vendor_bill SET receipt_ref = ? WHERE workspace_id = ? AND id = ?')
      .run(input.receiptRef, ctx.workspaceId, bill.id);
    ctx.audit.record({
      entityKind: 'vendor_bill',
      entityId: bill.id,
      action: 'update',
      actor: ctx.actor,
      at: ctx.clock.now(),
    });
    return ok({ vendorBillId: bill.id, receiptRef: input.receiptRef, vendorBill: vendorBillEcho(ctx, bill.id) });
  });
}

// --- voidVendorBill -------------------------------------------------------------------------------

/**
 * Correct a bill the only way an append-only ledger permits: post its reversal (§H-AUDIT, OR 957a).
 *
 * A DRAFT has no entry, so voiding one books nothing and simply retires the record. That is the
 * discard path, and it leaves the row saying what happened to it rather than deleting it.
 *
 * A bill with any settlement against it is REFUSED (`already_settled`). Reversing the purchase entry
 * under a payment that cleared it would leave the payment allocated to a bill that no longer exists in
 * the books, and 2000 Kreditoren would carry the difference silently. A14's `reverse_payment` is the
 * first step, and the rejection says so.
 */
export function voidVendorBill(ctx: WorkspaceContext, input: VoidVendorBillInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard =
    requireString(input.vendorBillId, 'vendorBillId') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalDate(input.date, 'date') ??
    optionalText(input.reason, 'reason');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['void_vendor_bill', input.vendorBillId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'void_vendor_bill');
  if (replayed !== undefined) return replayed;

  const bill = readVendorBillRow(ctx, input.vendorBillId);
  if (bill === undefined) return err('not_found', { vendorBillId: input.vendorBillId });
  if (bill.status === 'void') {
    return err('already_void', { vendorBillId: bill.id, reversalEntryId: bill.reversal_entry_id });
  }

  const settled = settledOnVendorBill(ctx, bill.id);
  if (settled > 0) {
    return err('already_settled', {
      vendorBillId: bill.id,
      settledMinor: settled,
      hint: 'reverse the payment first (reverse_payment), then void the bill',
    });
  }

  const date = input.date ?? ctx.clock.now().slice(0, 10);

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'void_vendor_bill', () => {
      let reversalId: string | null = null;
      if (bill.status === 'posted' && bill.entry_id !== null) {
        const reversed = reverseEntry(ctx, {
          entryId: bill.entry_id,
          date,
          idempotencyKey: JSON.stringify(['vendor_bill_reversal', bill.id]),
        });
        if (!reversed.ok) throw new BillAbort(reversed);
        reversalId = reversed.reversalId;
      }
      ctx.store.db
        .prepare(
          "UPDATE vendor_bill SET status = 'void', reversal_entry_id = ?, void_reason = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(reversalId, input.reason ?? null, ctx.workspaceId, bill.id);
      ctx.audit.record({
        entityKind: 'vendor_bill',
        entityId: bill.id,
        action: 'reverse',
        actor: ctx.actor,
        at: ctx.clock.now(),
      });
      return ok({
        vendorBillId: bill.id,
        reversalEntryId: reversalId,
        voidedAt: date,
        vendorBill: vendorBillEcho(ctx, bill.id),
      });
    }),
  );
}

// --- G21: the migrated open-item (Kreditor) writer ----------------------------------------------

export interface CreateMigratedVendorBillInput {
  /** The already-mapped vendor (validated here for the vendor role); written to `contact_id`. */
  vendorId: string;
  /** The SOURCE system's own bill number, stored verbatim as `vendor_reference`. */
  vendorReference: string;
  billDate: string;
  dueDate?: string | null;
  supplyDate?: string | null;
  currency: string;
  netMinor: number;
  taxAmountMinor: number;
  grossMinor: number;
  /** What the migrated bill OWES, and therefore what a payment settles (the AP mirror of an AR open
   *  amount). Its sum against the 2000 opening line is the `ap_control` tie-out. */
  payableMinor: number;
  taxCode?: string | null;
  /** The cost account the row was mapped to (G10). A migrated bill posts NOTHING, so this leg is
   *  never booked; the column is stored because A17's schema requires it and the Kreditoren list
   *  shows it. */
  expenseAccountId: string;
  /** Base-currency figures, resolved by the caller through §H-FX (identity for a base-currency row). */
  baseNetMinor: number;
  baseTaxMinor: number;
  baseGrossMinor: number;
  basePayableMinor: number;
  fxRate?: string | null;
}

/**
 * Write a migrated open Kreditor DIRECTLY at `status='posted'`, `origin='migrated'`, `entry_id` NULL,
 * posting NOTHING (US-G21.2). The AP mirror of `createMigratedDocument`: `postVendorBill` is
 * structurally bypassed, `postEntry` is never called, and the bill's only ledger effect is the
 * aggregate 2000 Kreditoren line A04 already posted. Its `payable_minor` is the debt A14 settles and
 * the figure the `ap_control` tie-out sums against 2000.
 *
 * Runs inside a transaction the CALLER (`importOpenItems`) opened, which owns the idempotency key and
 * the mapping guards; this validates the vendor role and the cost account and does the write.
 */
export function createMigratedVendorBill(ctx: WorkspaceContext, input: CreateMigratedVendorBillInput): Result {
  const vendor = resolveVendor(ctx, input.vendorId);
  if ('ok' in vendor) return vendor;
  const expense = readAccount(ctx, input.expenseAccountId);
  if (expense === undefined || expense.archived === 1) {
    return err('needs_account', { field: 'expenseAccountId', reason: expense === undefined ? 'unknown' : 'archived' });
  }
  for (const [field, value] of [
    ['netMinor', input.netMinor],
    ['taxAmountMinor', input.taxAmountMinor],
    ['grossMinor', input.grossMinor],
    ['payableMinor', input.payableMinor],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return err('invalid_input', { field, reason: 'integer Rappen, not negative' });
    }
  }

  const id = ctx.ids.next('vbill');
  const at = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO vendor_bill
         (id, workspace_id, contact_id, bill_date, due_date, supply_date, vendor_reference, currency,
          amount_is_gross, net_minor, tax_code, tax_amount_minor, gross_minor, payable_minor,
          expense_account_id, cost_center_id, project_id, receipt_ref, status, origin, base_net_minor,
          base_tax_minor, base_gross_minor, base_payable_minor, fx_rate, entry_id, reversal_entry_id,
          void_reason, idempotency_key, created_by, created_at, posted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'posted', 'migrated', ?, ?, ?, ?, ?, NULL, NULL,
               NULL, NULL, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.workspaceId,
      vendor.id,
      input.billDate,
      input.dueDate ?? null,
      input.supplyDate ?? null,
      input.vendorReference,
      input.currency,
      input.netMinor,
      input.taxCode ?? null,
      input.taxAmountMinor,
      input.grossMinor,
      input.payableMinor,
      expense.id,
      input.baseNetMinor,
      input.baseTaxMinor,
      input.baseGrossMinor,
      input.basePayableMinor,
      input.fxRate ?? null,
      ctx.actor,
      at,
      at,
    );

  ctx.audit.record({
    entityKind: 'vendor_bill',
    entityId: id,
    action: 'create',
    actor: ctx.actor,
    at: ctx.clock.now(),
  });

  return ok({ vendorBillId: id, vendorBill: vendorBillEcho(ctx, id) });
}

export { PURCHASE_SOURCE };
export type { VendorBillStatus };
