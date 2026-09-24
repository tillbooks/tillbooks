/**
 * A18, creditor payments: select open A17 bills, generate a pain.001.001.09 credit-transfer
 * initiation, and mark them paid through A14's own settlement path.
 *
 * SPEC RECONCILIATION (this module's first commit corrected the spec against the engine it depends
 * on; the finding is recorded here because it shapes every function below):
 *
 *  1. **A17 captures no creditor IBAN.** The spec assumed "each creditor's IBAN/QR-IBAN + QRR
 *     reference (captured on the vendor bill in A17)". `core/purchase/schema.ts`'s `vendor_bill`
 *     table has no IBAN column, and neither does `contact`. A pain.001 file cannot exist without a
 *     creditor IBAN, so this module adds the one fact that was missing: `creditor_bank_profile`, one
 *     row per vendor, written by `setCreditorBankProfile`. This is a NEW A18-owned verb the spec's
 *     stack-landing did not name; see the denylist sweep below for why it exists and where it lands.
 *  2. **The QRR/SCOR reference is derived from A17's `vendor_reference` field, never invented.**
 *     `vendor_reference` is free text (A17's own words: "what a Kreditoren list is searched by and
 *     what a payment reference quotes"). If it happens to be a valid 27-digit QRR or a valid ISO
 *     11649 SCOR string, `classifyReference` (A14's own, reused rather than reimplemented) says so
 *     and this module uses it structured; otherwise the amount is remitted with unstructured text.
 *     A QR-IBAN creditor account WITHOUT a valid QRR in `vendor_reference` is refused
 *     (`needs_qrr_reference`) rather than guessed, because the SIX Implementation Guidelines forbid
 *     unstructured remittance in combination with a QR-IBAN (CH17) and forbid a QRR reference on a
 *     plain IBAN (RmtInf/Strd/CdtrRefInf/Tp/CdOrPrtry/Cd=SCOR is the only code the plain-IBAN branch
 *     accepts). There is currently no A17 verb that lets an operator correct `vendor_reference` after
 *     a bill is created (`attach_receipt` only ever touches `receipt_ref`), so this is a real,
 *     honestly-stated limitation rather than a defect this module owns: the fix is recording the
 *     bill again with the correct reference, and A17 owes the missing edit path.
 *  3. **`markBatchPaid` calls A14's `recordPayment` ONCE PER ITEM, with the item's allocation INLINE
 *     in that same call**, not a `recordPayment` + `allocatePayment` pair. `recordPayment` already
 *     allocates in the same transaction (its `allocations` input), which is the exact shape A17's own
 *     "Zahlung erfassen" (US-A17.3) uses. A separate `allocatePayment` call is for allocating an
 *     EXISTING parked Guthaben, which is not this batch's situation. The spec's §4 prose ("calls
 *     recordPayment + allocatePayment") described the two VERBS A14 owns, not two calls this module
 *     makes; the code is the more precise statement and this comment corrects the prose.
 *  4. **Only CHF and EUR bills are batchable**, matching the SIX Swiss Payment Standards "payment
 *     type D (domestic)" table exactly (Business Rules SPS 2025 v3.2, Table 3: "V1: CHF/EUR"). A
 *     bill in another currency is refused with `unsupported_currency` rather than silently emitted
 *     as a cross-border "X" payment type, which this module does not implement.
 *  5. **`generatePain001` requires an `idempotencyKey`** (the spec's §5 prose, "all four A18-owned
 *     tools take workspace_id + idempotency_key", though the individual per-tool table row omits
 *     it). It is not strictly load-bearing: regenerating a `generated` batch is naturally idempotent
 *     (the XML is a pure function of immutable stored rows), but the key is still accepted and
 *     memoised for uniformity with the other three writes and so a client never has to special-case
 *     one A18 tool's call shape.
 *  6. **Two reads beyond the spec's four named tools: `getPaymentBatch` and `listPaymentBatches`.**
 *     The GUI needs to re-open a batch it already drafted (after a reload, or before offering Mark
 *     paid on a batch generated in an earlier session), and §6b's own saved-view worked examples
 *     ("Batches awaiting bank confirmation", "Paid this quarter") presuppose a list to filter. G00's
 *     `payment_batch` entity-kind registration (§6b) is unreachable from the GUI without one, so this
 *     is not scope creep, it is what makes the §6b registration real rather than decorative.
 *
 * §H-AUDIT: `payment_batch`/`payment_batch_item` are append-only past `generated` (DB triggers in
 * `./pain001Schema.ts`); the only further write is `markBatchPaid` stamping `posted_payment_id`,
 * which itself delegates every ledger effect to A14 (P3, no second posting path).
 *
 * NO TRANSMIT PATH IN A18 (§7 tripwire, D29). Nothing in this file opens a socket, calls `fetch`, or
 * reaches any transport. `generatePain001` always answers `transmitted:false`; the one transmit path
 * anywhere in this repo is A33's P8-gated `payment_batch_transmit`. Now that A33 has landed, `reason`
 * is `'use_payment_batch_transmit'` when an EBICS channel routes the batch's debtor account and
 * `'no_channel'` otherwise (`hasA33Channel` below is the real detection).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString, requireDate, optionalDate, optionalId } from '../ledger/inputGuards.js';
import { getBankAccount, validateIban } from './bankAccounts.js';
import { listVendorBills, getVendorBill } from '../purchase/index.js';
import { classifyReference, isValidQrrReference, isValidScorReference } from '../payments/reference.js';
import { recordPayment, PAYMENT_INTENTS } from '../payments/index.js';
import { getCompanyProfile } from '../setup/companyProfile.js';
import { resolveContactRef } from '../sales/contact.js';
import { applySavedView } from '../customization/views.js';

// --- §H-ENUM: payment_batch.status, single point -----------------------------------------------

export const PAYMENT_BATCH_STATUSES = ['draft', 'generated', 'paid', 'discarded'] as const;
export type PaymentBatchStatus = (typeof PAYMENT_BATCH_STATUSES)[number];

/** The two currencies the SIX "payment type D (domestic)" table admits (Business Rules SPS 2025 v3.2, Table 3). */
const BATCHABLE_CURRENCIES: ReadonlySet<string> = new Set(['CHF', 'EUR']);

/** Abort a write transaction with a structured cause, so nothing is memoised on a rejection. */
class BatchAbort {
  constructor(public readonly result: Result) {}
}

function runGuarded(body: () => Result): Result {
  try {
    return body();
  } catch (e) {
    if (e instanceof BatchAbort) return e.result;
    throw e;
  }
}

// --- Money-safe decimal helpers (Pattern P2: no floats on the money path) -----------------------

/** Integer Rappen to a fixed two-decimal string ("4820" -> "48.20"), with NO float arithmetic. */
export function minorToDecimalString(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = Math.trunc(abs / 100);
  const cents = abs % 100;
  return `${sign}${major}.${String(cents).padStart(2, '0')}`;
}

/** The inverse: a decimal amount string ("48.20") to integer Rappen (4820), or null if malformed. */
export function decimalStringToMinor(value: string): number | null {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(value.trim());
  if (m === null) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 100 + Number(m[3]));
}

// --- XML-safety helpers --------------------------------------------------------------------------

/**
 * XML text escaping for element content. `&`, `<` and `>` are all replaced (`&` first, so an already
 * escaped entity is not double-escaped); `'` and `"` need no escaping in element text. Escaping `>`
 * is not strictly required in content but is the conventional, always-safe choice and is what the
 * code does, so the comment now matches it (N3).
 */
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The restricted reference charset (SIX IG §3.2), for `MsgId`/`PmtInfId`/`InstrId`/`EndToEndId`
 * ONLY: letters, digits, spaces and `'()+,-./:?`. This repo's own ids are minted as
 * `<prefix>_<uuid>` (`core/ids.ts`), and `_` is NOT in that set, so every id reaching one of these
 * four fields is sanitised here rather than assumed clean.
 */
export function toReferenceSafe(raw: string): string {
  const mapped = raw.replace(/_/g, '-');
  const filtered = mapped.replace(/[^A-Za-z0-9 '()+,\-./:?]/g, '');
  // May not start with a space or a slash, may not end with a slash, may not contain "//".
  const noLeading = filtered.replace(/^[ /]+/, '');
  const noTrailing = noLeading.replace(/\/+$/, '');
  return noTrailing.replace(/\/\//g, '-');
}

/** The ISO 20022 ceiling on `MsgId`/`PmtInfId`/`InstrId`/`EndToEndId`: all four are `Max35Text`. */
export const REFERENCE_MAX_LEN = 35;

/**
 * Mint a COMPACT, charset-safe reference for one of the four `Max35Text` elements (F2). This repo's
 * ids are `<prefix>_<uuid>` (`core/ids.ts`), and `<prefix>-<uuid>` is 46-47 characters once the
 * `PB-`/`PMT-`/`II-`/`E2E-` tag is added, well over the 35-character schema ceiling: a file carrying
 * one is rejected in `GrpHdr` and every payment in it fails to execute. The uuid's 128 bits are
 * re-encoded base36 (0-9a-z, all inside the SIX IG §3.2 charset), which is at most 25 characters, so
 * a one-letter tag plus the encoding never exceeds 26. A non-uuid suffix (the `sequenceIdGen` test
 * ids, `pbatch_1`) is short already and is used as-is after charset filtering. The value is a pure
 * function of the immutable id, so a regenerated batch mints the identical reference, which is what
 * keeps `MsgId` (the bank's 90-day duplicate-detection key) stable across regeneration.
 */
export function compactReference(tag: string, id: string): string {
  const suffix = id.slice(id.lastIndexOf('_') + 1);
  const hex = suffix.replace(/-/g, '');
  const core = /^[0-9a-fA-F]{32}$/.test(hex)
    ? BigInt(`0x${hex}`).toString(36)
    : suffix.replace(/[^0-9A-Za-z]/g, '');
  return toReferenceSafe(`${tag}${core}`).slice(0, REFERENCE_MAX_LEN);
}

/**
 * The Swiss "BC number" (bank clearing number, the SAME 5-digit field SIX calls the IID), extracted
 * from a CH/LI IBAN's positions 5-9 (chars 4..9, 0-indexed): `CH93 00762 011623852957` -> `00762`.
 * This is how `DbtrAgt`'s mandatory `ClrSysMmbId`/`MmbId` is resolved WITHOUT a stored BIC: the
 * Implementation Guideline states the Creditor Agent may be omitted and derived from the IBAN, and
 * the same derivation is exactly what a Swiss bank does with the debtor's own IBAN at execution.
 * Returns null for anything that is not a 21-character CH/LI IBAN.
 */
export function swissBcNumberFromIban(iban: string): string | null {
  const normalized = iban.replace(/\s+/g, '').toUpperCase();
  if (normalized.length !== 21) return null;
  if (!normalized.startsWith('CH') && !normalized.startsWith('LI')) return null;
  return normalized.slice(4, 9);
}

// --- setCreditorBankProfile -----------------------------------------------------------------------

export interface SetCreditorBankProfileInput {
  vendorId: string;
  iban: string;
  idempotencyKey: string;
}

interface VendorRow {
  id: string;
  name: string;
  party_role: string;
  archived: number;
  merged_into_id: string | null;
}

/** The vendor, §H-TENANT, merge-tombstone-aware exactly as A14/A17 resolve a counterparty. */
function resolveVendorForProfile(ctx: WorkspaceContext, vendorId: unknown): VendorRow | Result {
  if (typeof vendorId !== 'string' || vendorId.length === 0) {
    return err('needs_vendor', { field: 'vendorId', reason: 'missing' });
  }
  const row = ctx.store.db
    .prepare('SELECT id, name, party_role, archived, merged_into_id FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, vendorId) as VendorRow | undefined;
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
    return err('needs_vendor', { field: 'vendorId', reason: 'party_role', partyRole: row.party_role });
  }
  return row;
}

/**
 * Store, or correct, the IBAN A18 pays a vendor at (§H-ENUM finding 1 above). ONE row per vendor,
 * upserted. `set_creditor_bank_profile` is a D65 leg-(f) verb: it decides who a batch's money
 * ultimately reaches, exactly as `update_bank_account`/`set_creditor_profile` already do for the
 * WORKSPACE's own accounts, so it is on the automation denylist (`core/automation/denylist.ts`)
 * for the identical reason.
 */
export function setCreditorBankProfile(ctx: WorkspaceContext, input: SetCreditorBankProfileInput): Result {
  const guard = requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['set_creditor_bank_profile', input.vendorId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'set_creditor_bank_profile');
  if (replayed !== undefined) return replayed;

  const vendor = resolveVendorForProfile(ctx, input.vendorId);
  if ('ok' in vendor) return vendor;

  const validated = validateIban(input.iban);
  if (!validated.ok) return validated;
  const iban = validated.iban as string;
  const isQrIban = validated.isQrIban === true;

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'set_creditor_bank_profile', () => {
    const existing = ctx.store.db
      .prepare('SELECT id FROM creditor_bank_profile WHERE workspace_id = ? AND contact_id = ?')
      .get(ctx.workspaceId, vendor.id) as { id: string } | undefined;
    const id = existing?.id ?? ctx.ids.next('cbp');
    if (existing === undefined) {
      ctx.store.db
        .prepare(
          `INSERT INTO creditor_bank_profile (id, workspace_id, contact_id, iban, is_qr_iban, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, ctx.workspaceId, vendor.id, iban, isQrIban ? 1 : 0, ctx.actor, ctx.clock.now());
    } else {
      ctx.store.db
        .prepare(
          'UPDATE creditor_bank_profile SET iban = ?, is_qr_iban = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        )
        .run(iban, isQrIban ? 1 : 0, ctx.actor, ctx.clock.now(), id);
    }
    ctx.audit.record({
      entityKind: 'creditor_bank_profile',
      entityId: id,
      action: existing === undefined ? 'create' : 'update',
      actor: ctx.actor,
      at: ctx.clock.now(),
    });
    return ok({ creditorBankProfileId: id, vendorId: vendor.id, iban, isQrIban });
  });
}

interface CreditorProfileRow {
  id: string;
  iban: string;
  is_qr_iban: number;
}

function readCreditorProfile(ctx: WorkspaceContext, vendorId: string): CreditorProfileRow | undefined {
  return ctx.store.db
    .prepare('SELECT id, iban, is_qr_iban FROM creditor_bank_profile WHERE workspace_id = ? AND contact_id = ?')
    .get(ctx.workspaceId, vendorId) as CreditorProfileRow | undefined;
}

/** The last 4 characters of an IBAN, for display without exposing the whole number needlessly. */
function maskIban(iban: string): string {
  return iban.length <= 4 ? iban : `•••• ${iban.slice(-4)}`;
}

// --- listPayableOpenItems --------------------------------------------------------------------------

export interface ListPayableOpenItemsInput {
  dueBy?: string;
  vendorId?: string;
}

/** Is this vendor bill already sitting in a LIVE batch (draft or generated, not yet paid)? */
function liveBatchFor(ctx: WorkspaceContext, vendorBillId: string): string | null {
  const row = ctx.store.db
    .prepare(
      `SELECT pb.id AS batch_id FROM payment_batch_item pbi
         JOIN payment_batch pb ON pb.id = pbi.batch_id AND pb.workspace_id = pbi.workspace_id
        WHERE pbi.workspace_id = ? AND pbi.vendor_bill_id = ? AND pb.status IN ('draft', 'generated')`,
    )
    .get(ctx.workspaceId, vendorBillId) as { batch_id: string } | undefined;
  return row?.batch_id ?? null;
}

/** A17's open Kreditoren, read through A17's OWN read model (P5), plus what A18 adds: payability. */
export function listPayableOpenItems(ctx: WorkspaceContext, input: ListPayableOpenItemsInput = {}): Result {
  const guard = optionalDate(input.dueBy, 'dueBy') ?? optionalId(input.vendorId, 'vendorId');
  if (guard) return guard;

  const listed = listVendorBills(ctx, {
    status: 'posted',
    ...(input.vendorId !== undefined ? { vendorId: input.vendorId } : {}),
  });
  if (!listed.ok) return listed;

  const bills = (listed.bills as ReadonlyArray<Record<string, unknown>>).filter((b) => {
    const openMinor = b.openMinor as number;
    if (openMinor <= 0) return false;
    if (input.dueBy !== undefined) {
      const dueDate = b.dueDate as string | null;
      if (dueDate === null || dueDate > input.dueBy) return false;
    }
    return true;
  });

  const items = bills.map((b) => {
    const vendorId = b.vendorId as string;
    const profile = readCreditorProfile(ctx, vendorId);
    const classified = classifyReference((b.vendorReference as string | null) ?? undefined);
    return {
      billId: b.id as string,
      vendorId,
      vendorName: b.vendorName as string | null,
      currency: b.currency as string,
      amountMinor: b.openMinor as number,
      dueDate: b.dueDate as string | null,
      vendorReference: b.vendorReference as string | null,
      hasCreditorProfile: profile !== undefined,
      // F7: an agent that wrote a creditor profile must be able to read back the full IBAN it stored,
      // not only a four-character mask, before it commits a batch to that destination.
      creditorIban: profile === undefined ? null : profile.iban,
      creditorIbanMasked: profile === undefined ? null : maskIban(profile.iban),
      isQrIban: profile === undefined ? null : profile.is_qr_iban === 1,
      referenceKind: classified.kind,
      referenceValid: classified.valid,
      batchable: BATCHABLE_CURRENCIES.has(b.currency as string),
      alreadyBatchedInto: liveBatchFor(ctx, b.id as string),
    };
  });

  return ok({ items, total: items.length, asOf: listed.asOf, baseCurrency: listed.baseCurrency });
}

// --- createPaymentBatch --------------------------------------------------------------------------

export interface CreatePaymentBatchInput {
  bankAccountId: string;
  itemIds: string[];
  executionDate: string;
  idempotencyKey: string;
}

interface PreparedItem {
  billId: string;
  vendorId: string;
  amountMinor: number;
  currency: string;
  creditorIban: string;
  isQrIban: boolean;
  referenceKind: 'qrr' | 'scor' | 'none';
  referenceValue: string | null;
}

function prepareBatchItems(ctx: WorkspaceContext, itemIds: readonly string[]): PreparedItem[] | Result {
  const prepared: PreparedItem[] = [];
  let batchCurrency: string | null = null;

  for (const billId of itemIds) {
    const got = getVendorBill(ctx, { vendorBillId: billId });
    if (!got.ok) return err('not_found', { vendorBillId: billId });
    const bill = got.vendorBill as Record<string, unknown>;

    if (bill.status !== 'posted') {
      return err('not_payable', { vendorBillId: billId, reason: 'not_posted', status: bill.status });
    }
    const openMinor = bill.openMinor as number;
    if (openMinor <= 0) {
      return err('not_payable', { vendorBillId: billId, reason: 'already_settled' });
    }
    const currency = bill.currency as string;
    if (batchCurrency === null) batchCurrency = currency;
    else if (batchCurrency !== currency) {
      return err('mixed_currency', { expected: batchCurrency, found: currency, vendorBillId: billId });
    }
    if (!BATCHABLE_CURRENCIES.has(currency)) {
      return err('unsupported_currency', { vendorBillId: billId, currency, allowed: [...BATCHABLE_CURRENCIES] });
    }

    const existingBatch = liveBatchFor(ctx, billId);
    if (existingBatch !== null) {
      return err('already_batched', { vendorBillId: billId, batchId: existingBatch });
    }

    const vendorId = bill.vendorId as string;
    const profile = readCreditorProfile(ctx, vendorId);
    if (profile === undefined) {
      return err('needs_creditor_iban', {
        vendorBillId: billId,
        vendorId,
        hint: 'call set_creditor_bank_profile with this vendor and their IBAN before batching this bill',
      });
    }
    const isQrIban = profile.is_qr_iban === 1;

    const classified = classifyReference((bill.vendorReference as string | null) ?? undefined);
    let referenceKind: 'qrr' | 'scor' | 'none';
    let referenceValue: string | null;
    if (isQrIban) {
      // SIX IG (pain.001) CH16/CH17: a QR-IBAN creditor account MUST carry a QRR reference and MUST
      // NOT carry unstructured remittance. Nothing here invents one.
      if (classified.kind !== 'qrr' || !classified.valid) {
        return err('needs_qrr_reference', {
          vendorBillId: billId,
          hint: "this bill's vendorReference is not a valid QRR; record it as the 27-digit reference printed on the paper QR-bill",
        });
      }
      referenceKind = 'qrr';
      referenceValue = classified.value;
    } else if (classified.kind === 'scor' && classified.valid) {
      referenceKind = 'scor';
      referenceValue = classified.value;
    } else if (classified.kind === 'qrr') {
      // A QRR reference is only legal against a QR-IBAN (SIX IG CH16). Refused rather than downgraded.
      return err('invalid_reference', { vendorBillId: billId, reason: 'qrr_reference_on_plain_iban' });
    } else {
      referenceKind = 'none';
      // SIX IG: Ustrd is max 140 characters, one occurrence.
      const text = (bill.vendorReference as string | null) ?? null;
      referenceValue = text === null ? null : text.slice(0, 140);
    }

    prepared.push({
      billId,
      vendorId,
      amountMinor: openMinor,
      currency,
      creditorIban: profile.iban,
      isQrIban,
      referenceKind,
      referenceValue,
    });
  }

  return prepared;
}

/** Read one batch row, §H-TENANT. */
interface BatchRow {
  id: string;
  workspace_id: string;
  bank_account_id: string;
  execution_date: string;
  status: PaymentBatchStatus;
  ctrl_sum_minor: number | null;
  nb_of_txs: number | null;
  msg_id: string | null;
  cre_dt_tm: string;
  idempotency_key: string;
  created_by: string | null;
  created_at: string;
}

function readBatchRow(ctx: WorkspaceContext, batchId: unknown): BatchRow | undefined {
  if (typeof batchId !== 'string' || batchId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM payment_batch WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, batchId) as BatchRow | undefined;
}

interface BatchItemRow {
  id: string;
  batch_id: string;
  vendor_bill_id: string;
  vendor_id: string;
  amount_minor: number;
  currency: string;
  creditor_iban: string;
  is_qr_iban: number;
  reference_kind: 'qrr' | 'scor' | 'none';
  reference_value: string | null;
  posted_payment_id: string | null;
}

function readBatchItems(ctx: WorkspaceContext, batchId: string): BatchItemRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM payment_batch_item WHERE workspace_id = ? AND batch_id = ? ORDER BY rowid')
    .all(ctx.workspaceId, batchId) as BatchItemRow[];
}

/** The read model both the write echoes and `get_payment_batch` answers with. */
function batchEcho(ctx: WorkspaceContext, batchId: string): Record<string, unknown> | null {
  const row = readBatchRow(ctx, batchId);
  if (row === undefined) return null;
  const items = readBatchItems(ctx, batchId);
  return {
    id: row.id,
    bankAccountId: row.bank_account_id,
    executionDate: row.execution_date,
    status: row.status,
    ctrlSumMinor: row.ctrl_sum_minor,
    nbOfTxs: row.nb_of_txs,
    msgId: row.msg_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    items: items.map((it) => {
      const vendor = resolveContactRef(ctx, it.vendor_id);
      return {
        id: it.id,
        vendorBillId: it.vendor_bill_id,
        vendorId: it.vendor_id,
        vendorName: vendor?.name ?? null,
        amountMinor: it.amount_minor,
        currency: it.currency,
        // F7: the destination of the money is the one fact a pre-upload review exists to verify, so
        // the FULL snapshotted IBAN is exposed here (the masked form stays for incidental display).
        creditorIban: it.creditor_iban,
        creditorIbanMasked: maskIban(it.creditor_iban),
        isQrIban: it.is_qr_iban === 1,
        referenceKind: it.reference_kind,
        postedPaymentId: it.posted_payment_id,
      };
    }),
  };
}

/**
 * Draft a batch: validate the debtor account and every item, snapshot each item's creditor IBAN and
 * reference (finding 1/2 above), and write a `draft` batch. No posting, no XML yet (spec §4).
 */
export function createPaymentBatch(ctx: WorkspaceContext, input: CreatePaymentBatchInput): Result {
  const guard =
    requireString(input.bankAccountId, 'bankAccountId') ??
    requireDate(input.executionDate, 'executionDate') ??
    requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  if (!Array.isArray(input.itemIds) || input.itemIds.length === 0) {
    return err('nothing_selected');
  }
  if (!input.itemIds.every((id) => typeof id === 'string' && id.length > 0)) {
    return err('invalid_input', { field: 'itemIds' });
  }
  // F1: the same bill twice in one selection would emit two <CdtTrfTxInf> and the bank would pay the
  // vendor twice. Refused at the door, before anything is read or written. The UNIQUE index on
  // payment_batch_item(workspace_id, batch_id, vendor_bill_id) is the DB floor behind this guard.
  if (new Set(input.itemIds).size !== input.itemIds.length) {
    const seen = new Set<string>();
    const duplicates = [...new Set(input.itemIds.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
    return err('duplicate_item', {
      field: 'itemIds',
      duplicates,
      reason: 'a bill may appear at most once in a batch; two instructions for one bill would pay it twice',
    });
  }

  const scopedKey = JSON.stringify(['create_payment_batch', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'create_payment_batch');
  if (replayed !== undefined) return replayed;

  const holder = ctx.store.db
    .prepare('SELECT id FROM payment_batch WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, input.idempotencyKey) as { id: string } | undefined;
  if (holder !== undefined) {
    return err('idempotency_key_conflict', {
      idempotencyKey: input.idempotencyKey,
      batchId: holder.id,
      reason: 'this key already created a different batch; a retry must repeat the same selection',
    });
  }

  const account = getBankAccount(ctx, { bankAccountId: input.bankAccountId });
  if (!account.ok) return err('needs_bank_account', { reason: 'unknown' });
  const bankAccount = account.bankAccount as Record<string, unknown>;
  if (bankAccount.archived === true) return err('needs_bank_account', { reason: 'archived' });
  if (bankAccount.receiveOnly === true) {
    return err('needs_bank_account', {
      reason: 'receive_only_qr_iban',
      hint: 'a QR-IBAN may only be credited (SIX IG §3.1/§3.3.1); register a plain-IBAN account as the debtor account',
    });
  }

  const prepared = prepareBatchItems(ctx, input.itemIds);
  if (!Array.isArray(prepared)) return prepared;

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'create_payment_batch', () => {
    const batchId = ctx.ids.next('pbatch');
    ctx.store.db
      .prepare(
        `INSERT INTO payment_batch
           (id, workspace_id, bank_account_id, execution_date, status, ctrl_sum_minor, nb_of_txs, msg_id,
            cre_dt_tm, idempotency_key, created_by, created_at)
         VALUES (?, ?, ?, ?, 'draft', NULL, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        batchId,
        ctx.workspaceId,
        input.bankAccountId,
        input.executionDate,
        ctx.clock.now(),
        input.idempotencyKey,
        ctx.actor,
        ctx.clock.now(),
      );
    for (const item of prepared) {
      ctx.store.db
        .prepare(
          `INSERT INTO payment_batch_item
             (id, batch_id, workspace_id, vendor_bill_id, vendor_id, amount_minor, currency,
              creditor_iban, is_qr_iban, reference_kind, reference_value, posted_payment_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          ctx.ids.next('pbitem'),
          batchId,
          ctx.workspaceId,
          item.billId,
          item.vendorId,
          item.amountMinor,
          item.currency,
          item.creditorIban,
          item.isQrIban ? 1 : 0,
          item.referenceKind,
          item.referenceValue,
          ctx.clock.now(),
        );
    }
    ctx.audit.record({ entityKind: 'payment_batch', entityId: batchId, action: 'create', actor: ctx.actor, at: ctx.clock.now() });
    return ok({ batchId, batch: batchEcho(ctx, batchId) });
  });
}

// --- generatePain001 -------------------------------------------------------------------------------

/**
 * A33 (EBICS bank channel) now exists. A batch has a transmit channel when a NON-retired
 * `ebics_connection` routes the batch's debtor bank account (the `ebics_connection_account` join A33's
 * `transmitPaymentBatch` resolves on). When one does, `generatePain001` answers the truthful reason
 * `use_payment_batch_transmit`; otherwise `no_channel` and the file-download path stays the floor.
 * A18 STILL never transmits: the one transmit verb anywhere is A33's P8-gated `payment_batch_transmit`.
 */
function hasA33Channel(ctx: WorkspaceContext, bankAccountId: string): boolean {
  const row = ctx.store.db
    .prepare(
      `SELECT 1 FROM ebics_connection_account a
         JOIN ebics_connection c ON c.id = a.connection_id AND c.workspace_id = a.workspace_id
        WHERE a.workspace_id = ? AND a.bank_account_id = ? AND c.state != 'retired'
        LIMIT 1`,
    )
    .get(ctx.workspaceId, bankAccountId) as { 1: number } | undefined;
  return row !== undefined;
}

interface XmlBuildResult {
  xml: string;
  msgId: string;
  ctrlSumMinor: number;
  nbOfTxs: number;
}

/**
 * Build the pain.001.001.09 XML: a pure function of the batch row (including its stored `cre_dt_tm`,
 * F6), its items, the debtor account and the company profile. Regenerating a `generated` batch
 * reproduces byte-identical output because none of those inputs change after `createPaymentBatch`:
 * in particular `CreDtTm` is the timestamp frozen at creation, not the wall clock at build time, so
 * the byte-identity holds under a moving clock and not only a frozen test one (D73 precedent: what
 * was generated is what re-renders).
 */
function buildPain001Xml(
  ctx: WorkspaceContext,
  batch: BatchRow,
  items: readonly BatchItemRow[],
  debtorIban: string,
  debtorName: string,
): XmlBuildResult {
  const msgId = compactReference('M', batch.id);
  const pmtInfId = compactReference('P', batch.id);
  // F6: stamped once at batch creation and stored, so regeneration is genuinely byte-identical.
  const creDtTm = batch.cre_dt_tm;
  const ctrlSumMinor = items.reduce((n, it) => n + it.amount_minor, 0);
  const nbOfTxs = items.length;
  const currency = items[0]?.currency ?? 'CHF';
  const debtorBc = swissBcNumberFromIban(debtorIban);

  const txLines = items
    .map((it) => {
      const instrId = compactReference('I', it.id);
      const endToEndId = compactReference('E', it.id);
      const amt = minorToDecimalString(it.amount_minor);
      const cdtrIban = it.creditor_iban.replace(/\s+/g, '').toUpperCase();
      const cdtrName = escapeXmlText(resolveContactRef(ctx, it.vendor_id)?.name ?? it.vendor_id);
      const rmtInf =
        it.reference_kind === 'none'
          ? it.reference_value === null
            ? ''
            : `<RmtInf><Ustrd>${escapeXmlText(it.reference_value)}</Ustrd></RmtInf>`
          : it.reference_kind === 'qrr'
            ? `<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Prtry>QRR</Prtry></CdOrPrtry></Tp><Ref>${it.reference_value}</Ref></CdtrRefInf></Strd></RmtInf>`
            : `<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>${it.reference_value}</Ref></CdtrRefInf></Strd></RmtInf>`;
      return (
        `<CdtTrfTxInf>` +
        `<PmtId><InstrId>${instrId}</InstrId><EndToEndId>${endToEndId}</EndToEndId></PmtId>` +
        `<Amt><InstdAmt Ccy="${currency}">${amt}</InstdAmt></Amt>` +
        `<Cdtr><Nm>${cdtrName}</Nm></Cdtr>` +
        `<CdtrAcct><Id><IBAN>${cdtrIban}</IBAN></Id></CdtrAcct>` +
        rmtInf +
        `</CdtTrfTxInf>`
      );
    })
    .join('');

  const debtorAgt =
    debtorBc === null
      ? ''
      : `<DbtrAgt><FinInstnId><ClrSysMmbId><ClrSysId><Cd>CHBCC</Cd></ClrSysId><MmbId>${debtorBc}</MmbId></ClrSysMmbId></FinInstnId></DbtrAgt>`;

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">` +
    `<CstmrCdtTrfInitn>` +
    `<GrpHdr>` +
    `<MsgId>${msgId}</MsgId>` +
    `<CreDtTm>${creDtTm}</CreDtTm>` +
    `<NbOfTxs>${nbOfTxs}</NbOfTxs>` +
    `<CtrlSum>${minorToDecimalString(ctrlSumMinor)}</CtrlSum>` +
    `<InitgPty><Nm>${escapeXmlText(debtorName)}</Nm></InitgPty>` +
    `</GrpHdr>` +
    `<PmtInf>` +
    `<PmtInfId>${pmtInfId}</PmtInfId>` +
    `<PmtMtd>TRF</PmtMtd>` +
    `<BtchBookg>true</BtchBookg>` +
    `<NbOfTxs>${nbOfTxs}</NbOfTxs>` +
    `<CtrlSum>${minorToDecimalString(ctrlSumMinor)}</CtrlSum>` +
    `<ReqdExctnDt><Dt>${batch.execution_date}</Dt></ReqdExctnDt>` +
    `<Dbtr><Nm>${escapeXmlText(debtorName)}</Nm></Dbtr>` +
    `<DbtrAcct><Id><IBAN>${debtorIban.replace(/\s+/g, '').toUpperCase()}</IBAN></Id></DbtrAcct>` +
    debtorAgt +
    `<ChrgBr>SLEV</ChrgBr>` +
    txLines +
    `</PmtInf>` +
    `</CstmrCdtTrfInitn>` +
    `</Document>`;

  return { xml, msgId, ctrlSumMinor, nbOfTxs };
}

/**
 * Independent validation over the PRODUCED TEXT, not the numbers used to build it (the A17
 * `verifyEntryIsOurs` discipline applied to a string instead of DB rows). Checks: the required
 * elements and the namespace are present, BOTH the A-level (GrpHdr) and B-level (PmtInf)
 * `NbOfTxs`/`CtrlSum` occurrences equal what the text's own `CdtTrfTxInf`/`InstdAmt` occurrences
 * sum to, the four reference elements fit `Max35Text` (F2), every IBAN validates (A19's own
 * `validateIban`, not reimplemented), every QRR/SCOR reference passes its check digit (A11's own
 * validators, reused through A14's re-export), and the routing shape is exclusive per transaction
 * (a QRR only against a QR-IBAN, SCOR/Ustrd only against a plain IBAN: SIX IG CH16/CH17).
 *
 * THIS IS NOT A FULL XSD VALIDATOR, but it no longer understates what it does not do. Full XSD
 * conformance against SIX's published schema (`pain.001.001.09.ch.03.xsd`) requires an XML schema
 * engine this MIT-core Node project does not depend on and a network fetch of the schema this test
 * suite cannot perform offline; §8's "Live/compliance verify" against the real XSD is out of scope
 * for this landing and is recorded as such rather than silently claimed. What this function checks
 * is the arithmetic (AM10 CtrlSum, AM18 NbOfTxs), the check digits (CH16 reference), the IBANs
 * (AC01), the `Max35Text` ceilings and the routing-shape exclusivity, independently re-derived from
 * the string A18 is about to hand out: the class of defect that actually broke in production (F2)
 * is now inside that set, where before it was not.
 */
export function validatePain001(xml: string): Result {
  const errors: Record<string, unknown>[] = [];

  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) {
    errors.push({ code: 'missing_xml_declaration' });
  }
  if (!xml.includes('xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"')) {
    errors.push({ code: 'wrong_namespace' });
  }
  for (const required of ['<GrpHdr>', '<MsgId>', '<CreDtTm>', '<PmtInf>', '<PmtMtd>TRF</PmtMtd>', '<CdtTrfTxInf>']) {
    if (!xml.includes(required)) errors.push({ code: 'missing_element', element: required });
  }

  // Max35Text on the four reference elements (F2). This is the class of schema rule an XSD run
  // enforces and the one this landing actually broke in production, so the honest XSD substitute has
  // to look at it. `EndToEndId` is matched before `InstrId` cannot shadow it: both are distinct tags.
  for (const tag of ['MsgId', 'PmtInfId', 'InstrId', 'EndToEndId']) {
    for (const m of xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))) {
      const value = m[1] as string;
      if (value.length > REFERENCE_MAX_LEN) {
        errors.push({ code: 'reference_too_long', element: tag, length: value.length, max: REFERENCE_MAX_LEN });
      }
    }
  }

  // A pain.001 writes NbOfTxs/CtrlSum TWICE: at A level (GrpHdr) and at B level (PmtInf). The old
  // validator used `.exec` (first match only), so a B level that contradicted the single instruction
  // passed (F3). Re-derive against BOTH occurrences with `matchAll`.
  const nbOfTxsMatches = [...xml.matchAll(/<NbOfTxs>(\d+)<\/NbOfTxs>/g)];
  const ctrlSumMatches = [...xml.matchAll(/<CtrlSum>(-?\d+\.\d{2})<\/CtrlSum>/g)];
  const txCount = (xml.match(/<CdtTrfTxInf>/g) ?? []).length;
  const amounts = [...xml.matchAll(/<InstdAmt Ccy="[A-Z]{3}">(-?\d+\.\d{2})<\/InstdAmt>/g)].map(
    (m) => decimalStringToMinor(m[1] as string) ?? 0,
  );
  const summedMinor = amounts.reduce((n, a) => n + a, 0);

  if (nbOfTxsMatches.length === 0) {
    errors.push({ code: 'missing_element', element: 'NbOfTxs' });
  } else {
    for (const m of nbOfTxsMatches) {
      if (Number(m[1]) !== txCount) {
        errors.push({ code: 'nb_of_txs_mismatch', declared: Number(m[1]), actual: txCount });
      }
    }
  }
  if (ctrlSumMatches.length === 0) {
    errors.push({ code: 'missing_element', element: 'CtrlSum' });
  } else {
    for (const m of ctrlSumMatches) {
      if (decimalStringToMinor(m[1] as string) !== summedMinor) {
        errors.push({ code: 'ctrlsum_mismatch', declared: m[1], actualMinor: summedMinor });
      }
    }
  }

  for (const m of xml.matchAll(/<IBAN>([A-Z0-9]+)<\/IBAN>/g)) {
    const validated = validateIban(m[1] as string);
    if (!validated.ok) errors.push({ code: 'invalid_iban', iban: m[1] });
  }
  for (const m of xml.matchAll(/<Prtry>QRR<\/Prtry><\/CdOrPrtry><\/Tp><Ref>(\d+)<\/Ref>/g)) {
    if (!isValidQrrReference(m[1] as string)) errors.push({ code: 'invalid_reference', reference: m[1] });
  }
  for (const m of xml.matchAll(/<Cd>SCOR<\/Cd><\/CdOrPrtry><\/Tp><Ref>([A-Z0-9]+)<\/Ref>/g)) {
    if (!isValidScorReference(m[1] as string)) errors.push({ code: 'invalid_reference', reference: m[1] });
  }

  // Routing-shape exclusivity, re-derived from the PRODUCED TEXT rather than trusted from the input
  // guard (F3/DQ3): SIX IG CH16/CH17. A QRR reference may only accompany a QR-IBAN (CH-IID in
  // 30000-31999); Cd=SCOR and unstructured Ustrd may only accompany a plain IBAN. Each transaction
  // carries its own IBAN and its own RmtInf, so the rule is checkable per <CdtTrfTxInf>.
  for (const tx of xml.split('<CdtTrfTxInf>').slice(1)) {
    const ibanMatch = /<IBAN>([A-Z0-9]+)<\/IBAN>/.exec(tx);
    if (ibanMatch === null) continue;
    const iban = ibanMatch[1] as string;
    const validated = validateIban(iban);
    const creditorIsQrIban = validated.ok && validated.isQrIban === true;
    const carriesQrr = tx.includes('<Prtry>QRR</Prtry>');
    const carriesScor = tx.includes('<Cd>SCOR</Cd>');
    const carriesUstrd = tx.includes('<Ustrd>');
    if (carriesQrr && !creditorIsQrIban) {
      errors.push({ code: 'qrr_on_plain_iban', iban });
    }
    if (creditorIsQrIban && (carriesScor || carriesUstrd || !carriesQrr)) {
      errors.push({ code: 'qr_iban_needs_qrr', iban });
    }
  }

  if (errors.length > 0) return err('invalid_pain001', { errors });
  return ok({});
}

export interface GeneratePain001Input {
  batchId: string;
  idempotencyKey: string;
}

/**
 * Build (or REBUILD) the pain.001.001.09 file for a batch, validate it, and flip `draft` to
 * `generated` on first success. Regenerating an already-`generated` batch reproduces the identical
 * bytes and does not re-flip anything (D73 precedent). `generate_pain001` NEVER transmits (§7).
 */
export function generatePain001(ctx: WorkspaceContext, input: GeneratePain001Input): Result {
  const guard = requireString(input.batchId, 'batchId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['generate_pain001', input.batchId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'generate_pain001');
  if (replayed !== undefined) return replayed;

  const batch = readBatchRow(ctx, input.batchId);
  if (batch === undefined) return err('not_found', { batchId: input.batchId });
  // F5: a PAID batch still handed out a fully valid pain.001 with no signal that the money already
  // moved. Re-uploading that file is a second execution. Only draft/generated may generate; a paid
  // or discarded batch is refused so no second file is ever produced.
  if (batch.status === 'paid') {
    return err('already_paid', {
      batchId: batch.id,
      reason: 'this batch is already paid; regenerating would hand out a file that re-uploads as a second payment',
    });
  }
  if (batch.status === 'discarded') {
    return err('batch_discarded', { batchId: batch.id });
  }
  const items = readBatchItems(ctx, batch.id);
  if (items.length === 0) return err('nothing_selected', { batchId: batch.id });

  const account = getBankAccount(ctx, { bankAccountId: batch.bank_account_id });
  if (!account.ok) return err('needs_bank_account', { reason: 'unknown' });
  const debtorIban = (account.bankAccount as Record<string, unknown>).iban as string;

  const profile = getCompanyProfile(ctx);
  const debtorName = profile.ok ? (((profile.profile as Record<string, unknown>).creditorName as string | null) ?? ((profile.profile as Record<string, unknown>).name as string)) : 'TILL';

  const built = buildPain001Xml(ctx, batch, items, debtorIban, debtorName);
  const validated = validatePain001(built.xml);
  if (!validated.ok) return validated;

  const transmitted = false;
  const reason = hasA33Channel(ctx, batch.bank_account_id) ? 'use_payment_batch_transmit' : 'no_channel';

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'generate_pain001', () => {
    if (batch.status === 'draft') {
      ctx.store.db
        .prepare(
          "UPDATE payment_batch SET status = 'generated', ctrl_sum_minor = ?, nb_of_txs = ?, msg_id = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(built.ctrlSumMinor, built.nbOfTxs, built.msgId, ctx.workspaceId, batch.id);
      ctx.audit.record({ entityKind: 'payment_batch', entityId: batch.id, action: 'update', actor: ctx.actor, at: ctx.clock.now() });
    }
    return ok({
      batchId: batch.id,
      xmlBase64: Buffer.from(built.xml, 'utf8').toString('base64'),
      filename: `pain001-${batch.id}.xml`,
      valid: true,
      warnings: [],
      ctrlSumMinor: built.ctrlSumMinor,
      nbOfTxs: built.nbOfTxs,
      transmitted,
      reason,
      batch: batchEcho(ctx, batch.id),
    });
  });
}

// --- getPaymentBatch / listPaymentBatches -----------------------------------------------------------

/** Read one batch in full: the debtor account, execution date, status, and every item. */
export function getPaymentBatch(ctx: WorkspaceContext, input: { batchId: string }): Result {
  const guard = requireString(input.batchId, 'batchId');
  if (guard) return guard;
  const echo = batchEcho(ctx, input.batchId);
  if (echo === null) return err('not_found', { batchId: input.batchId });
  return ok({ batch: echo });
}

export interface ListPaymentBatchesInput {
  status?: string;
  savedViewId?: string;
}

/** The batch history (finding 6 above): every batch, newest first, optionally filtered by status. */
export function listPaymentBatches(ctx: WorkspaceContext, input: ListPaymentBatchesInput = {}): Result {
  if (input.status !== undefined && !(PAYMENT_BATCH_STATUSES as readonly string[]).includes(input.status)) {
    return err('invalid_input', { field: 'status', allowed: [...PAYMENT_BATCH_STATUSES] });
  }
  const viewed = applySavedView(ctx, 'payment_batch', input);
  if (!viewed.ok) return viewed;
  const filter = viewed.filter;

  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }

  const rows = ctx.store.db
    .prepare(`SELECT id FROM payment_batch WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, rowid DESC`)
    .all(...params) as { id: string }[];

  const batches = rows.map((r) => batchEcho(ctx, r.id)).filter((b): b is Record<string, unknown> => b !== null);
  return ok({ batches, total: batches.length });
}

// --- markBatchPaid ----------------------------------------------------------------------------------

export interface MarkBatchPaidInput {
  batchId: string;
  confirmation: boolean;
  valueDate: string;
  idempotencyKey: string;
  /** A36 F2: the funding bank DEBIT, passed only when the batch is confirmed from the reconciliation
   *  board. When present the debit is LINKED to this settlement (`bank_txn_link` kind `payment_batch`),
   *  so the same debit can no longer be double-booked (a 2nd payment via confirm_match, or a 2nd
   *  journal via create_entry_for_txn). Absent on the plain A18 Payments-surface path, unchanged. */
  bankTxnId?: string;
}

/**
 * Confirm the bank executed a `generated` batch: post ONE outgoing payment per item through A14's
 * `recordPayment` (finding 3 above), each settling its own vendor bill, in ONE outer transaction
 * (better-sqlite3 nests `rememberIdempotent`'s `tx()` as a SAVEPOINT), so a rejection on item 3
 * leaves items 1-2 unposted too: the batch is genuinely atomic, not merely retry-safe. A re-confirm
 * under the same key replays the memoised result; re-confirming a `paid` batch under a NEW key is
 * refused with `already_paid`, never a second payment.
 */
export function markBatchPaid(ctx: WorkspaceContext, input: MarkBatchPaidInput): Result {
  const guard =
    requireString(input.batchId, 'batchId') ??
    requireDate(input.valueDate, 'valueDate') ??
    requireString(input.idempotencyKey, 'idempotencyKey') ??
    optionalId(input.bankTxnId, 'bankTxnId');
  if (guard) return guard;
  if (input.confirmation !== true) {
    return err('confirmation_required', {
      field: 'confirmation',
      reason: 'marking paid reflects a genuine bank confirmation, stated deliberately',
    });
  }

  const scopedKey = JSON.stringify(['mark_batch_paid', input.batchId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'mark_batch_paid');
  if (replayed !== undefined) return replayed;

  const batch = readBatchRow(ctx, input.batchId);
  if (batch === undefined) return err('not_found', { batchId: input.batchId });
  if (batch.status === 'draft') {
    return err('needs_generation', { batchId: batch.id, hint: 'call generate_pain001 before marking paid' });
  }
  if (batch.status === 'paid') {
    return err('already_paid', { batchId: batch.id });
  }

  // A19's `bankAccountId` (a `bank_account` row) is NOT A14's field of the same name (the LEDGER
  // account money moves on, e.g. account 1020). `recordPayment` resolves its `bankAccountId` against
  // the `account` table, so the A19 row's OWN `ledgerAccountId` is what has to travel through.
  const account = getBankAccount(ctx, { bankAccountId: batch.bank_account_id });
  if (!account.ok) return err('needs_bank_account', { reason: 'unknown' });
  const ledgerAccountId = (account.bankAccount as Record<string, unknown>).ledgerAccountId as string;

  const items = readBatchItems(ctx, batch.id);

  // A36 F2: validate and guard the funding bank debit BEFORE any settlement. A debit already linked to
  // a DIFFERENT settlement refuses here (one debit maps to at most one batch, spec §2 US-A36.5): this
  // is the double-settle tripwire, refusing before the batch posts rather than after.
  let fundingTxn: { id: string; credit_debit: string } | undefined;
  if (input.bankTxnId !== undefined) {
    fundingTxn = ctx.store.db
      .prepare('SELECT id, credit_debit FROM bank_txn WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, input.bankTxnId) as { id: string; credit_debit: string } | undefined;
    if (fundingTxn === undefined) return err('not_found', { bankTxnId: input.bankTxnId });
    if (fundingTxn.credit_debit !== 'DBIT') {
      return err('wrong_direction', {
        bankTxnId: input.bankTxnId,
        creditDebit: fundingTxn.credit_debit,
        reason: 'a payment batch is funded by an outgoing bank debit, not a credit',
      });
    }
    const existingLink = ctx.store.db
      .prepare('SELECT kind, target_id FROM bank_txn_link WHERE workspace_id = ? AND bank_txn_id = ?')
      .get(ctx.workspaceId, input.bankTxnId) as { kind: string; target_id: string } | undefined;
    if (existingLink !== undefined && existingLink.target_id !== batch.id) {
      return err('already_matched', {
        bankTxnId: input.bankTxnId,
        kind: existingLink.kind,
        targetId: existingLink.target_id,
        reason: 'this bank debit is already settled; one debit maps to at most one batch',
      });
    }
  }

  return runGuarded(() =>
    ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'mark_batch_paid', () => {
      const paymentIds: string[] = [];
      for (const item of items) {
        const posted = recordPayment(ctx, {
          direction: 'outgoing',
          date: input.valueDate,
          amountMinor: item.amount_minor,
          currency: item.currency,
          bankAccountId: ledgerAccountId,
          counterpartyKind: 'supplier',
          counterpartyId: item.vendor_id,
          ...(item.reference_value !== null ? { reference: item.reference_value } : {}),
          allocations: [{ vendorBillId: item.vendor_bill_id, amountMinor: item.amount_minor }],
          intent: PAYMENT_INTENTS.record,
          source: 'manual',
          idempotencyKey: `pain001-item-${item.id}`,
        });
        if (!posted.ok) throw new BatchAbort(posted);
        const paymentId = (posted as unknown as { paymentId: string }).paymentId;
        ctx.store.db
          .prepare('UPDATE payment_batch_item SET posted_payment_id = ? WHERE workspace_id = ? AND id = ?')
          .run(paymentId, ctx.workspaceId, item.id);
        paymentIds.push(paymentId);
      }
      ctx.store.db
        .prepare("UPDATE payment_batch SET status = 'paid' WHERE workspace_id = ? AND id = ?")
        .run(ctx.workspaceId, batch.id);
      // A36 F2: record the funding-debit link INSIDE the settlement transaction, so the debit is
      // marked matched atomically with the batch being paid. `bank_txn_link_one_per_txn` (UNIQUE)
      // enforces at most one link per debit at the storage layer; the pre-check above already refused a
      // link to a different settlement, so this insert is fresh.
      if (fundingTxn !== undefined) {
        ctx.store.db
          .prepare(
            `INSERT INTO bank_txn_link (id, workspace_id, bank_txn_id, kind, target_id, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(ctx.ids.next('btlk'), ctx.workspaceId, fundingTxn.id, 'payment_batch', batch.id, ctx.actor, ctx.clock.now());
      }
      ctx.audit.record({ entityKind: 'payment_batch', entityId: batch.id, action: 'update', actor: ctx.actor, at: ctx.clock.now() });
      return ok({ batchId: batch.id, paymentIds, batch: batchEcho(ctx, batch.id) });
    }),
  );
}

// --- discardPaymentBatch ----------------------------------------------------------------------------

export interface DiscardPaymentBatchInput {
  batchId: string;
  confirmation?: boolean;
  idempotencyKey: string;
}

/**
 * Abandon a batch that must not be paid (F4), moving it to the terminal `discarded` status. Without
 * this verb a bill drafted against a mistyped-but-check-digit-valid IBAN, or a batch whose second
 * (generate) step failed in the Studio flow, was trapped forever: `payment_batch_status_is_one_way`
 * forbids generated -> draft, `payment_batch_no_delete` forbids removal, and `liveBatchFor` kept the
 * bill flagged `already_batched`, so the only forward move was `mark_batch_paid`, i.e. booking a
 * payment that was never made.
 *
 * A `draft` batch discards freely. A `generated` batch has already produced a file an operator may
 * hold, so discarding it requires `confirmation: true`, the same deliberate-act discipline
 * `mark_batch_paid` uses. A `paid` batch cannot be discarded (the money moved); a `discarded` batch
 * is already terminal. Because `liveBatchFor` selects only `draft`/`generated`, a discarded batch's
 * bills become payable again immediately, with no row deleted (§H-AUDIT append-only).
 */
export function discardPaymentBatch(ctx: WorkspaceContext, input: DiscardPaymentBatchInput): Result {
  const guard = requireString(input.batchId, 'batchId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;

  const scopedKey = JSON.stringify(['discard_payment_batch', input.batchId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'discard_payment_batch');
  if (replayed !== undefined) return replayed;

  const batch = readBatchRow(ctx, input.batchId);
  if (batch === undefined) return err('not_found', { batchId: input.batchId });
  if (batch.status === 'paid') {
    return err('already_paid', { batchId: batch.id, reason: 'a paid batch cannot be discarded; the money has moved' });
  }
  if (batch.status === 'discarded') {
    return err('already_discarded', { batchId: batch.id });
  }
  if (batch.status === 'generated' && input.confirmation !== true) {
    return err('confirmation_required', {
      field: 'confirmation',
      reason: 'this batch already produced a pain.001 file; discarding it is a deliberate act',
    });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'discard_payment_batch', () => {
    ctx.store.db
      .prepare("UPDATE payment_batch SET status = 'discarded' WHERE workspace_id = ? AND id = ?")
      .run(ctx.workspaceId, batch.id);
    ctx.audit.record({ entityKind: 'payment_batch', entityId: batch.id, action: 'update', actor: ctx.actor, at: ctx.clock.now() });
    return ok({ batchId: batch.id, batch: batchEcho(ctx, batch.id) });
  });
}
