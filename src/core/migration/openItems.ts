/**
 * G21, open-items AR/AP migration: the `origin='migrated'` carry-forward writer.
 *
 * THE ONE SENTENCE THIS MODULE EXISTS TO MAKE STRUCTURALLY TRUE: a migrated open item posts NOTHING
 * of its own. Its ONLY ledger effect is the single 1100 (AR) or 2000 (AP) line inside A04's opening
 * entry. `importOpenItems` calls `postEntry` ZERO times and leaves every migrated row's
 * `posted_entry_id` / `entry_id` NULL. It writes the row DIRECTLY at its lifecycle state through
 * `createMigratedDocument` / `createMigratedVendorBill`, which hold no reference to any poster: the
 * A10/A17 posting seam is not invoked with a no-op, it is bypassed by construction.
 *
 * The two control tie-outs feed G11's `ar_control` / `ap_control` (which read A16's `list_open_items`
 * and A17's `list_vendor_bills` reconciliation, never a second derivation): after import the migrated
 * detail must equal the opening 1100 / 2000 line to the Rappen, ZERO tolerance, no plug posting. A
 * nonzero difference is an honest red control (G11's three-status model, `not_asserted` never green),
 * resolved by fixing the data, never by a balancing entry.
 *
 * THE SOLL/IST VAT FORK IS DERIVED FROM THE WORKSPACE FILING METHOD, never a per-item dial (US-G21.3,
 * §6b Fixed). This module simply STORES the resolved `code + base + tax` on each line (P6): under Soll
 * the migrated invoice posts no output VAT of its own (it posts nothing; the 2200 liability arrived
 * via A04's opening TB), and under Ist A14 recognises VAT on the paid portion off those stored values
 * when it settles the item. Nothing here branches on the timing, which is exactly what keeps the two
 * from being got backwards (the D59 defect class).
 *
 * D112 Q2: prior-year detail is a per-migration user choice (`priorYearDetail: 'live' | 'archive'`).
 * Open items at the Stichtag are ALWAYS live (both paths). A row flagged `settled` (an already-closed
 * prior-year item, carried only for the record) is refused under `archive` (it belongs in the G13
 * read-only archive) and, under `live`, written to the terminal settled state so it posts NOTHING and
 * nets to ZERO open, never double-recognising revenue.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { loadPlan } from './plan.js';
import { createMigratedDocument } from '../sales/index.js';
import { listOpenItems, receivablesBalanceAsOf } from '../debtors/index.js';
import {
  createMigratedVendorBill,
  listVendorBills,
  payablesBalanceAsOf,
} from '../purchase/index.js';
import { resolveTax } from '../vat/index.js';
import { baseCurrencyOf, resolveFxRate } from '../fx/rates.js';
import { convertMinor } from '../fx/rateMath.js';
import type { ResolvedRate } from '../fx/rates.js';
// The control account NUMBERS come from A14's one role map, never a KMU literal typed here: the
// migration locale fence forbids a Swiss account number in any file outside locale/ch/, and "Swiss is
// a pack" stays true because 1100/2000 have exactly one definition in the repo.
import { ROLE_ACCOUNT_NUMBER } from '../payments/accounts.js';

// The debtors/purchase writers live in modules G21 legitimately calls; the origin seam that lets a
// migrated row exist without a posting is theirs (document.ts / vendorBill.ts), this file only
// composes them into an import.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The two sides an open-items import can carry. */
const SIDES = ['ar', 'ap'] as const;
type Side = (typeof SIDES)[number];

/** The per-migration prior-year detail choice (D112 Q2), a first-class option, default archive. */
const PRIOR_YEAR_DETAIL = ['live', 'archive'] as const;
type PriorYearDetail = (typeof PRIOR_YEAR_DETAIL)[number];

/** One resolved AR/AP line as it arrives from G10 mapping (P6: the tax is a stored value). */
export interface OpenItemLineInput {
  description?: string | null;
  /** NET amount, integer Rappen. */
  netMinor: number;
  /** The resolved VAT for the line, integer Rappen (0 for none/zero/exempt). */
  taxMinor: number;
  /** The G10-mapped tax code (A14 Ist / A07 read it). */
  taxCode?: string | null;
  /** The Leistungsdatum that priced the VAT (P6 / §H-VAT-TRACE). Defaults to the item's issue date. */
  supplyDate?: string | null;
}

/** One AR open item (a customer invoice open at the Stichtag), already G10-mapped. */
export interface OpenItemArRow {
  /** The mapped customer contact id. */
  contactId: string;
  /** The SOURCE document number, stored verbatim (no native series consumed). */
  number: string;
  issueDate: string;
  dueDate?: string | null;
  currency: string;
  lines: OpenItemLineInput[];
  /** The declared invoice total, if the source stated one. Σ(net+tax) must equal it (P9). */
  declaredTotalMinor?: number;
  /** D112 Q2 'live': this item was already settled in the old system; carry it for the record only. */
  settled?: boolean;
}

/** One AP open item (a supplier bill open at the Stichtag), already G10-mapped. */
export interface OpenItemApRow {
  vendorId: string;
  /** The SOURCE bill number, stored verbatim as vendor_reference. */
  number: string;
  billDate: string;
  dueDate?: string | null;
  supplyDate?: string | null;
  currency: string;
  netMinor: number;
  taxAmountMinor: number;
  grossMinor: number;
  /** What the bill owes (the AP mirror of an AR open amount). Defaults to grossMinor. */
  payableMinor?: number;
  taxCode?: string | null;
  /** The cost account the row was mapped to (G10). Never booked (a migrated bill posts nothing). */
  expenseAccountId: string;
  settled?: boolean;
}

export interface ImportOpenItemsInput {
  planId: string;
  side: string;
  rows: unknown;
  priorYearDetail?: string;
  idempotencyKey: string;
}

export interface PreviewOpenItemsInput {
  planId: string;
  side: string;
  rows: unknown;
  priorYearDetail?: string;
}

// --- Validation helpers -------------------------------------------------------------------------

function isSide(value: unknown): value is Side {
  return typeof value === 'string' && (SIDES as readonly string[]).includes(value);
}

function priorYearDetailOf(value: unknown): PriorYearDetail | Result {
  if (value === undefined) return 'archive';
  if (typeof value !== 'string' || !(PRIOR_YEAR_DETAIL as readonly string[]).includes(value)) {
    return err('invalid_input', { field: 'priorYearDetail', allowed: [...PRIOR_YEAR_DETAIL] });
  }
  return value as PriorYearDetail;
}

/** A structured refusal that NAMES the offending row (P9). Collected across the batch, atomic. */
interface RowRefusal {
  rowIndex: number;
  number: string | null;
  reason: string;
  detail?: Record<string, unknown>;
}

/** Is `contactId` a customer (or both) in this workspace? Drives the AR `contact_unmapped` refusal. */
function customerRole(ctx: WorkspaceContext, contactId: unknown): 'ok' | 'missing' | 'wrong_role' {
  if (typeof contactId !== 'string' || contactId.length === 0) return 'missing';
  const row = ctx.store.db
    .prepare('SELECT party_role, archived, merged_into_id FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId) as
    | { party_role: string; archived: number; merged_into_id: string | null }
    | undefined;
  if (row === undefined || row.merged_into_id !== null || row.archived === 1) return 'missing';
  return row.party_role === 'customer' || row.party_role === 'both' ? 'ok' : 'wrong_role';
}

function vendorRole(ctx: WorkspaceContext, vendorId: unknown): 'ok' | 'missing' | 'wrong_role' {
  if (typeof vendorId !== 'string' || vendorId.length === 0) return 'missing';
  const row = ctx.store.db
    .prepare('SELECT party_role, archived, merged_into_id FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, vendorId) as
    | { party_role: string; archived: number; merged_into_id: string | null }
    | undefined;
  if (row === undefined || row.merged_into_id !== null || row.archived === 1) return 'missing';
  return row.party_role === 'vendor' || row.party_role === 'both' ? 'ok' : 'wrong_role';
}

/**
 * The rate that values one row in base currency, or a `needs_fx_rate` refusal. A base-currency row is
 * the identity (rateScaled 1). A foreign row with no admissible rate at the Stichtag is REFUSED, never
 * converted at a guessed 1.0 (§H-FX). The rate is resolved at the item's own date, which is what A16
 * then re-resolves for the migrated receivable's base.
 */
function baseRateFor(ctx: WorkspaceContext, currency: string, date: string): ResolvedRate | 'needs_fx_rate' {
  const resolution = resolveFxRate(ctx, { currency, date });
  if (!resolution.ok) return 'needs_fx_rate';
  return resolution.resolved;
}

/** Does the tax code resolve to something at the supply date? Drives `tax_unresolved` (P6). */
function taxResolves(ctx: WorkspaceContext, taxCode: string | null | undefined, supplyDate: string): boolean {
  if (taxCode === undefined || taxCode === null || taxCode === 'none') return true;
  const resolved = resolveTax(ctx, { taxCode, supplyDate });
  if (!resolved.ok) return false;
  // A code that resolves to `none` at the supply date resolved to nothing usable (P6).
  return resolved.kind !== 'none';
}

interface PreparedAr {
  input: Parameters<typeof createMigratedDocument>[1];
  openBaseMinor: number;
}
interface PreparedAp {
  input: Parameters<typeof createMigratedVendorBill>[1];
  openBaseMinor: number;
}

/** Validate one AR row, returning either the prepared writer input or a structured refusal. */
function prepareArRow(
  ctx: WorkspaceContext,
  row: unknown,
  index: number,
  priorYear: PriorYearDetail,
): PreparedAr | RowRefusal {
  const r = row as OpenItemArRow;
  const number = typeof r?.number === 'string' ? r.number : null;
  const refuse = (reason: string, detail?: Record<string, unknown>): RowRefusal => ({
    rowIndex: index,
    number,
    reason,
    ...(detail !== undefined ? { detail } : {}),
  });

  if (r === null || typeof r !== 'object') return refuse('invalid_row');
  if (typeof r.number !== 'string' || r.number.length === 0) return refuse('invalid_row', { field: 'number' });
  if (typeof r.issueDate !== 'string' || !ISO_DATE.test(r.issueDate)) return refuse('invalid_row', { field: 'issueDate' });
  if (typeof r.currency !== 'string' || r.currency.length === 0) return refuse('invalid_row', { field: 'currency' });
  if (!Array.isArray(r.lines) || r.lines.length === 0) return refuse('invalid_row', { field: 'lines' });

  const role = customerRole(ctx, r.contactId);
  if (role !== 'ok') return refuse('contact_unmapped', { contactId: r.contactId, cause: role });

  let subtotal = 0;
  let tax = 0;
  for (const [i, line] of r.lines.entries()) {
    if (!Number.isSafeInteger(line?.netMinor) || line.netMinor < 0) return refuse('invalid_row', { line: i + 1, field: 'netMinor' });
    if (!Number.isSafeInteger(line?.taxMinor) || line.taxMinor < 0) return refuse('invalid_row', { line: i + 1, field: 'taxMinor' });
    const supplyDate = line.supplyDate ?? r.issueDate;
    if (!taxResolves(ctx, line.taxCode ?? null, supplyDate)) {
      return refuse('tax_unresolved', { line: i + 1, taxCode: line.taxCode ?? null, supplyDate });
    }
    subtotal += line.netMinor;
    tax += line.taxMinor;
  }
  const total = subtotal + tax;
  if (r.declaredTotalMinor !== undefined && r.declaredTotalMinor !== total) {
    return refuse('open_item_total_mismatch', { declaredTotalMinor: r.declaredTotalMinor, computedTotalMinor: total });
  }

  if (r.settled === true && priorYear === 'archive') {
    return refuse('prior_year_detail_archived', {
      hint: 'settled prior-year detail belongs in the read-only G13 archive; import it with priorYearDetail=live to carry it as a settled migrated item',
    });
  }

  const rate = baseRateFor(ctx, r.currency, r.issueDate);
  if (rate === 'needs_fx_rate') return refuse('needs_fx_rate', { currency: r.currency, asOf: r.issueDate });
  const openBaseMinor = convertMinor(total, rate.rateScaled);

  return {
    input: {
      type: 'invoice',
      contactId: r.contactId,
      number: r.number,
      issueDate: r.issueDate,
      dueDate: r.dueDate ?? null,
      currency: r.currency,
      lines: r.lines.map((l) => ({
        description: l.description ?? null,
        netMinor: l.netMinor,
        taxMinor: l.taxMinor,
        taxCode: l.taxCode ?? null,
        supplyDate: l.supplyDate ?? r.issueDate,
      })),
      ...(r.settled === true ? { settled: true } : {}),
    },
    // A settled (net-to-zero-open) item contributes ZERO to the control: it is not open.
    openBaseMinor: r.settled === true ? 0 : openBaseMinor,
  };
}

/** Validate one AP row, returning either the prepared writer input or a structured refusal. */
function prepareApRow(
  ctx: WorkspaceContext,
  row: unknown,
  index: number,
  priorYear: PriorYearDetail,
): PreparedAp | RowRefusal {
  const r = row as OpenItemApRow;
  const number = typeof r?.number === 'string' ? r.number : null;
  const refuse = (reason: string, detail?: Record<string, unknown>): RowRefusal => ({
    rowIndex: index,
    number,
    reason,
    ...(detail !== undefined ? { detail } : {}),
  });

  if (r === null || typeof r !== 'object') return refuse('invalid_row');
  if (typeof r.number !== 'string' || r.number.length === 0) return refuse('invalid_row', { field: 'number' });
  if (typeof r.billDate !== 'string' || !ISO_DATE.test(r.billDate)) return refuse('invalid_row', { field: 'billDate' });
  if (typeof r.currency !== 'string' || r.currency.length === 0) return refuse('invalid_row', { field: 'currency' });
  for (const field of ['netMinor', 'taxAmountMinor', 'grossMinor'] as const) {
    if (!Number.isSafeInteger(r[field]) || (r[field] as number) < 0) return refuse('invalid_row', { field });
  }

  const role = vendorRole(ctx, r.vendorId);
  if (role !== 'ok') return refuse('vendor_unmapped', { vendorId: r.vendorId, cause: role });

  if (r.netMinor + r.taxAmountMinor !== r.grossMinor) {
    return refuse('open_item_total_mismatch', {
      netMinor: r.netMinor,
      taxAmountMinor: r.taxAmountMinor,
      grossMinor: r.grossMinor,
    });
  }
  const payableMinor = r.payableMinor ?? r.grossMinor;
  if (!Number.isSafeInteger(payableMinor) || payableMinor < 0 || payableMinor > r.grossMinor) {
    return refuse('invalid_row', { field: 'payableMinor' });
  }

  const supplyDate = r.supplyDate ?? r.billDate;
  if (!taxResolves(ctx, r.taxCode ?? null, supplyDate)) {
    return refuse('tax_unresolved', { taxCode: r.taxCode ?? null, supplyDate });
  }

  if (r.settled === true && priorYear === 'archive') {
    return refuse('prior_year_detail_archived', {
      hint: 'settled prior-year detail belongs in the read-only G13 archive; import it with priorYearDetail=live to carry it as a settled migrated bill',
    });
  }

  const rate = baseRateFor(ctx, r.currency, r.billDate);
  if (rate === 'needs_fx_rate') return refuse('needs_fx_rate', { currency: r.currency, asOf: r.billDate });

  // A settled bill owes nothing (net-to-zero open, D112 Q2 'live'); an open one owes its payable.
  const effectivePayable = r.settled === true ? 0 : payableMinor;
  const openBaseMinor = convertMinor(effectivePayable, rate.rateScaled);
  const isForeign = r.currency !== baseCurrencyOf(ctx);

  return {
    input: {
      vendorId: r.vendorId,
      vendorReference: r.number,
      billDate: r.billDate,
      dueDate: r.dueDate ?? null,
      supplyDate: r.supplyDate ?? null,
      currency: r.currency,
      netMinor: r.netMinor,
      taxAmountMinor: r.taxAmountMinor,
      grossMinor: r.grossMinor,
      payableMinor: effectivePayable,
      taxCode: r.taxCode ?? null,
      expenseAccountId: r.expenseAccountId,
      baseNetMinor: convertMinor(r.netMinor, rate.rateScaled),
      baseTaxMinor: convertMinor(r.taxAmountMinor, rate.rateScaled),
      baseGrossMinor: convertMinor(r.grossMinor, rate.rateScaled),
      basePayableMinor: openBaseMinor,
      // A17 stores the rate the base figures were struck at, so the Kreditoren list shows a foreign
      // migrated bill at the same rate it reconciles against 2000 (a base-currency bill stamps none).
      ...(isForeign ? { fxRate: rate.rate } : {}),
    },
    openBaseMinor,
  };
}

// --- The control tie-out (feeds G11's ar_control / ap_control) -----------------------------------

interface ControlView {
  kind: 'ar_control' | 'ap_control';
  controlAccountNumber: string;
  controlAccountMinor: number;
  migratedOpenMinor: number;
  differenceMinor: number;
  status: 'passed' | 'failed' | 'not_asserted';
}

/**
 * Compute the tie-out for one side, exactly as G11 does: the workspace's open total (A16/A17's own
 * reconciliation figure) against the posted balance of the control account. `hypotheticalExtraMinor`
 * lets `previewOpenItems` add the proposed batch WITHOUT writing, so an operator sees the tie-out
 * before committing. Integer-Rappen subtraction, ZERO tolerance, never a plug (§4).
 */
function controlFor(ctx: WorkspaceContext, side: Side, asOf: string, hypotheticalExtraMinor: number): ControlView {
  if (side === 'ar') {
    const read = listOpenItems(ctx, { asOf });
    const open = (read.ok ? (read.workspaceBaseTotalOpenMinor as number) : 0) + hypotheticalExtraMinor;
    const control = receivablesBalanceAsOf(ctx, asOf);
    return finishControl('ar_control', ROLE_ACCOUNT_NUMBER.receivable, control, open);
  }
  const read = listVendorBills(ctx, {});
  const open = (read.ok ? (read.workspaceBaseTotalOpenMinor as number) : 0) + hypotheticalExtraMinor;
  const control = payablesBalanceAsOf(ctx, asOf);
  return finishControl('ap_control', ROLE_ACCOUNT_NUMBER.payable, control, open);
}

function finishControl(
  kind: 'ar_control' | 'ap_control',
  number: string,
  controlAccountMinor: number,
  migratedOpenMinor: number,
): ControlView {
  const differenceMinor = migratedOpenMinor - controlAccountMinor;
  // G11's three-status honesty carried verbatim: nothing loaded is `not_asserted` (never green);
  // a Rappen-exact tie is `passed`; any nonzero difference is `failed`.
  const status: ControlView['status'] =
    migratedOpenMinor === 0 && controlAccountMinor === 0 ? 'not_asserted' : differenceMinor === 0 ? 'passed' : 'failed';
  return { kind, controlAccountNumber: number, controlAccountMinor, migratedOpenMinor, differenceMinor, status };
}

// --- The verbs ----------------------------------------------------------------------------------

interface Prepared {
  side: Side;
  ar: PreparedAr[];
  ap: PreparedAp[];
  refusals: RowRefusal[];
  proposedOpenMinor: number;
  asOf: string;
}

/** Shared validation for both verbs: load the plan, resolve the Stichtag, and prepare every row. */
function prepareBatch(ctx: WorkspaceContext, input: PreviewOpenItemsInput): Prepared | Result {
  if (typeof input.planId !== 'string' || input.planId.length === 0) return err('invalid_input', { field: 'planId' });
  if (!isSide(input.side)) return err('invalid_input', { field: 'side', allowed: [...SIDES] });
  if (!Array.isArray(input.rows)) return err('invalid_input', { field: 'rows' });
  const priorYear = priorYearDetailOf(input.priorYearDetail);
  if (typeof priorYear !== 'string') return priorYear;

  const plan = loadPlan(ctx, input.planId);
  if (plan === undefined) return err('not_found', { planId: input.planId });
  // The Stichtag: the plan's cutover date, or today when the plan has not set one yet.
  const asOf = plan.cutover_date ?? ctx.clock.now().slice(0, 10);

  const ar: PreparedAr[] = [];
  const ap: PreparedAp[] = [];
  const refusals: RowRefusal[] = [];
  let proposedOpenMinor = 0;

  input.rows.forEach((row, index) => {
    if (input.side === 'ar') {
      const prepared = prepareArRow(ctx, row, index, priorYear);
      if ('reason' in prepared) refusals.push(prepared);
      else {
        ar.push(prepared);
        proposedOpenMinor += prepared.openBaseMinor;
      }
    } else {
      const prepared = prepareApRow(ctx, row, index, priorYear);
      if ('reason' in prepared) refusals.push(prepared);
      else {
        ap.push(prepared);
        proposedOpenMinor += prepared.openBaseMinor;
      }
    }
  });

  return { side: input.side, ar, ap, refusals, proposedOpenMinor, asOf };
}

/**
 * Preview an open-items import: compute the ar/ap control delta the batch WOULD produce, and surface
 * every refusal, WITHOUT writing a row (US-G21.1/2, spec §5). READ MEANS READ.
 */
export function previewOpenItems(ctx: WorkspaceContext, input: PreviewOpenItemsInput): Result {
  const prepared = prepareBatch(ctx, input);
  if ('ok' in prepared) return prepared;
  const control = controlFor(ctx, prepared.side, prepared.asOf, prepared.proposedOpenMinor);
  return ok({
    side: prepared.side,
    asOf: prepared.asOf,
    validCount: prepared.side === 'ar' ? prepared.ar.length : prepared.ap.length,
    refusals: prepared.refusals,
    control,
  });
}

/**
 * Import open items (AR or AP): write each valid row as a migrated document / vendor bill that posts
 * NOTHING, atomic and idempotent (§H-IDEMPOTENT). If ANY row refuses, the whole batch refuses and
 * writes nothing, so the tie-out is never left half-loaded and a re-run under the same key replays
 * the ORIGINAL outcome (spec §7 idempotent-on-rows).
 */
export function importOpenItems(ctx: WorkspaceContext, input: ImportOpenItemsInput): Result {
  // Every write rides the existing commit_migration capability (A24, spec §3: no new capability).
  // Asserted in the engine like A04/A13's opening/archive commits, so the rejection is one code on
  // both faces even though the registry boundary also gates it.
  const cap = ctx.capabilities.assert('commit_migration');
  if (!cap.ok) return cap;

  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  const scopedKey = JSON.stringify(['import_open_items', input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result>(ctx.workspaceId, scopedKey, 'import_open_items');
  if (replayed !== undefined) return replayed;

  const prepared = prepareBatch(ctx, input);
  if ('ok' in prepared) return prepared;

  // A single bad row refuses the WHOLE import (nothing is written), so the control can never be left
  // half-loaded and the caller sees every offending row named at once (P9).
  if (prepared.refusals.length > 0) {
    return err('open_items_refused', {
      side: prepared.side,
      refusals: prepared.refusals,
      reason: 'no row was imported: fix the named rows and retry',
    });
  }

  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'import_open_items', () => {
    const imported: Array<Record<string, unknown>> = [];
    if (prepared.side === 'ar') {
      for (const item of prepared.ar) {
        const written = createMigratedDocument(ctx, item.input);
        if (!written.ok) return written;
        imported.push({ documentId: written.documentId, number: item.input.number, openBaseMinor: item.openBaseMinor });
      }
    } else {
      for (const item of prepared.ap) {
        const written = createMigratedVendorBill(ctx, item.input);
        if (!written.ok) return written;
        imported.push({ vendorBillId: written.vendorBillId, number: item.input.vendorReference, openBaseMinor: item.openBaseMinor });
      }
    }
    // The tie-out is read AFTER the write (no hypothetical): it is now A16/A17's own reconciliation,
    // exactly the figure G11's ar_control/ap_control will read.
    const control = controlFor(ctx, prepared.side, prepared.asOf, 0);
    return ok({ side: prepared.side, asOf: prepared.asOf, importedCount: imported.length, imported, control });
  });
}
