/**
 * D02 purchase-order lifecycle (spec §2/§4): create/edit (`po.upsert`), send (`po.send`, P8), close
 * short (`po.closeShort`), cancel (`po.cancel`), revise (`po.revise`), and the P5 read models
 * (`po.list`, `po.get`, `po.openLines`). The PO is its OWN document reusing Pattern P7's transition
 * discipline on `purchase_order.status`/`PO_STATUS` (`poEnums.ts`), never an A10 document kind.
 *
 * PATTERN P3, IN FULL: nothing here posts. D02 resolves the EXPECTED tax code (A05, P6) and stores
 * txn + CHF base + rate (§H-FX via A19), but the VAT ledger and every journal write stay with A17->A02
 * on the vendor bill. Money is integer Rappen (P2). Every write rides `runTx` (commit-on-ok,
 * §H-IDEMPOTENT), so a REFUSED write leaves ZERO rows.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { resolveTax } from '../vat/resolveTax.js';
import { resolveFxRate } from '../fx/rates.js';
import { convertMinor } from '../fx/rateMath.js';
import { applySavedView } from '../customization/views.js';
import { readProject } from '../projects/index.js';
import { isPoTransitionAllowed } from './poEnums.js';
import type { PoStatus } from './poEnums.js';
import {
  runTx,
  readPo,
  readPoLines,
  contactExists,
  readItemRow,
  poNotFound,
} from './poShared.js';
import type { PoRow, PoLineRow } from './poShared.js';
import { resolveSupplierPrice } from './supplierPrices.js';

const WRITE_CAP = 'manage_master_data';

function today(ctx: WorkspaceContext): string {
  return ctx.clock.now().slice(0, 10);
}

/** Add whole days to an ISO date (UTC), for `expected_on` from the longest lead time. */
function dateAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- Line resolution ---------------------------------------------------------------------------

export interface PoLineInput {
  itemId?: string;
  description?: string;
  qty?: number;
  unitPriceRappen?: number;
  taxCode?: string | null;
  /**
   * B03, the project cost dimension: the B00 project this ordered line is for. A REPORTING tag
   * (D02 stays off the money path): B03's accrued_purchases/committed components read it.
   */
  projectId?: string | null;
}

interface ResolvedLine {
  itemId: string | null;
  description: string | null;
  qty: number;
  unitPriceRappen: number;
  unitPriceBaseRappen: number;
  taxCode: string | null;
  projectId: string | null;
  priceSource: 'explicit' | 'supplier' | 'item_cost' | null;
  leadTimeDays: number | null;
}

/**
 * Validate and price every line ONCE at upsert (P5 snapshot, never a cache that can drift). Each line:
 * item reference checked (§H-TENANT); qty a positive integer; price either the caller's explicit value
 * or `resolveSupplierPrice`'s snapshot (US-D02.7 pre-fill); tax code the line's or the item default,
 * validated + resolved through A05 (P6, §H-VAT-TRACE); FX converted to CHF base per unit (§H-FX).
 */
function resolveLines(ctx: WorkspaceContext, supplierContactId: string, currency: string, lines: PoLineInput[]): Result {
  const day = today(ctx);
  const fx = resolveFxRate(ctx, { currency, date: day });
  if (!fx.ok) return fx;
  const rateScaled = fx.resolved.rateScaled;

  const resolved: ResolvedLine[] = [];
  for (const line of lines) {
    let itemId: string | null = null;
    if (line.itemId !== undefined && line.itemId !== null && line.itemId.length > 0) {
      if (readItemRow(ctx, line.itemId) === undefined) return err('invalid_reference', { itemId: line.itemId });
      itemId = line.itemId;
    }
    if (typeof line.qty !== 'number' || !Number.isInteger(line.qty) || line.qty <= 0) {
      return err('invalid_qty', { qty: line.qty });
    }

    // Price: explicit wins; else the supplier resolver (only possible for an item line); else 0 for a
    // free-text line with no price given.
    let unitPriceRappen: number;
    let priceSource: ResolvedLine['priceSource'];
    let leadTimeDays: number | null = null;
    if (typeof line.unitPriceRappen === 'number') {
      if (!Number.isInteger(line.unitPriceRappen) || line.unitPriceRappen < 0) return err('invalid_input', { field: 'unitPriceRappen' });
      unitPriceRappen = line.unitPriceRappen;
      priceSource = 'explicit';
    } else if (itemId !== null) {
      const resolvedPrice = resolveSupplierPrice(ctx, { supplierContactId, itemId, at: day });
      if (resolvedPrice === null) return err('invalid_reference', { itemId });
      unitPriceRappen = resolvedPrice.priceRappen;
      priceSource = resolvedPrice.source;
      leadTimeDays = resolvedPrice.leadTimeDays;
    } else {
      unitPriceRappen = 0;
      priceSource = null;
    }

    // Tax: the line's code or the item default, resolved + validated once through A05 (unknown => err).
    const item = itemId !== null ? readItemRow(ctx, itemId) : undefined;
    const wantTax: string | null = line.taxCode !== undefined ? line.taxCode : (item?.default_tax_code ?? null);
    const taxRes = resolveTax(ctx, { taxCode: wantTax });
    if (!taxRes.ok) return taxRes;
    const taxCode = (taxRes as unknown as { code: string | null }).code;

    // The B03 project tag: §H-TENANT via readProject (workspace-fenced), unknown or cross-tenant
    // refused the same way. A reporting dimension only; it prices nothing here.
    let projectId: string | null = null;
    if (line.projectId !== undefined && line.projectId !== null && line.projectId.length > 0) {
      if (readProject(ctx, line.projectId) === undefined) return err('invalid_reference', { projectId: line.projectId });
      projectId = line.projectId;
    }

    resolved.push({
      itemId,
      description: line.description ?? item?.name ?? null,
      qty: line.qty,
      unitPriceRappen,
      unitPriceBaseRappen: convertMinor(unitPriceRappen, rateScaled),
      taxCode,
      projectId,
      priceSource,
      leadTimeDays,
    });
  }
  return ok({ lines: resolved, fxRate: fx.resolved.rate, isBase: currency === fx.resolved.baseCurrency });
}

// --- Views -------------------------------------------------------------------------------------

function lineView(l: PoLineRow) {
  return {
    id: l.id,
    itemId: l.item_id,
    description: l.description,
    qty: l.qty,
    unitPriceRappen: l.unit_price_rappen,
    unitPriceBaseRappen: l.unit_price_base_rappen,
    taxCode: l.tax_code,
    projectId: l.project_id,
    receivedQty: l.received_qty,
    billedQty: l.billed_qty,
    openQty: Math.max(0, l.qty - l.received_qty),
    sort: l.sort,
  };
}

function poView(po: PoRow) {
  return {
    id: po.id,
    number: po.number,
    supplierContactId: po.supplier_contact_id,
    status: po.status,
    revision: po.revision,
    currency: po.currency,
    totalRappen: po.total_rappen,
    totalBaseRappen: po.total_base_rappen,
    fxRate: po.fx_rate,
    expectedOn: po.expected_on,
    sentArtifactRef: po.sent_artifact_ref,
    note: po.note,
    sourceDocumentType: po.source_document_type,
    sourceDocumentId: po.source_document_id,
  };
}

/** The full read for one PO (P5): header, lines, its receipts and its match records. */
function poDetail(ctx: WorkspaceContext, poId: string): Result {
  const po = readPo(ctx, poId);
  if (po === undefined) return poNotFound(poId);
  const lines = readPoLines(ctx, poId).map(lineView);
  const receipts = ctx.store.db
    .prepare('SELECT id, location_id, received_at, note FROM goods_receipt WHERE workspace_id = ? AND po_id = ? ORDER BY received_at, id')
    .all(ctx.workspaceId, poId) as { id: string; location_id: string; received_at: string; note: string | null }[];
  const matches = ctx.store.db
    .prepare('SELECT id, bill_id, status, qty_variance, price_variance_rappen, expected_base_rappen, bill_base_rappen, overridden_by, matched_at FROM po_match WHERE workspace_id = ? AND po_id = ? ORDER BY matched_at, id')
    .all(ctx.workspaceId, poId) as Record<string, unknown>[];
  return ok({
    po: poView(po),
    lines,
    receipts: receipts.map((r) => ({ id: r.id, locationId: r.location_id, receivedAt: r.received_at, note: r.note })),
    matches: matches.map((m) => ({
      id: m.id,
      billId: m.bill_id,
      status: m.status,
      qtyVariance: m.qty_variance,
      priceVarianceRappen: m.price_variance_rappen,
      expectedBaseRappen: m.expected_base_rappen,
      billBaseRappen: m.bill_base_rappen,
      overriddenBy: m.overridden_by,
      matchedAt: m.matched_at,
    })),
  });
}

// --- Writers -----------------------------------------------------------------------------------

function nextPoNumber(ctx: WorkspaceContext): string {
  const row = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM purchase_order WHERE workspace_id = ?').get(ctx.workspaceId) as { n: number };
  return `PO-${String(row.n + 1).padStart(4, '0')}`;
}

function totalsOf(ctx: WorkspaceContext, resolved: ResolvedLine[]): { totalRappen: number; totalBaseRappen: number; expectedOn: string | null } {
  let totalRappen = 0;
  let totalBaseRappen = 0;
  let maxLead: number | null = null;
  for (const l of resolved) {
    totalRappen += l.qty * l.unitPriceRappen;
    totalBaseRappen += l.qty * l.unitPriceBaseRappen;
    if (l.leadTimeDays !== null) maxLead = maxLead === null ? l.leadTimeDays : Math.max(maxLead, l.leadTimeDays);
  }
  return { totalRappen, totalBaseRappen, expectedOn: maxLead === null ? null : dateAddDays(today(ctx), maxLead) };
}

/**
 * Reconcile a PO's lines to the newly resolved set, PRESERVING line identity (US-D02.6). A `po_line`
 * that already carries receipts is UPDATED IN PLACE rather than deleted and re-inserted, because
 * `goods_receipt_line.po_line_id` references it: a delete would break that FK and orphan the minted
 * D01 movements the whole discipline exists to protect. Matches new lines to existing ones by
 * `item_id` (first unclaimed). Refuses `qty_below_received` when a line with receipts is removed or its
 * ordered qty drops below what was received. Returns the totals, or an err Result.
 */
function applyPoLines(ctx: WorkspaceContext, poId: string, existing: PoLineRow[], resolved: ResolvedLine[]): Result {
  const claimed = new Set<number>();
  const plan = resolved.map((r) => {
    let matchIdx = -1;
    if (r.itemId !== null) {
      matchIdx = existing.findIndex((e, i) => !claimed.has(i) && e.item_id === r.itemId);
      if (matchIdx >= 0) claimed.add(matchIdx);
    }
    return { r, existing: matchIdx >= 0 ? existing[matchIdx]! : undefined };
  });

  // A superseded line that carried receipts/bills and found no home in the new set is an orphan.
  for (let i = 0; i < existing.length; i++) {
    const e = existing[i]!;
    if (!claimed.has(i) && (e.received_qty > 0 || e.billed_qty > 0)) {
      return err('qty_below_received', { poLineId: e.id, receivedQty: e.received_qty, reason: 'line_removed_with_receipts' });
    }
  }
  // A matched line whose new ordered qty falls below what was already received is refused.
  for (const p of plan) {
    if (p.existing !== undefined && p.r.qty < p.existing.received_qty) {
      return err('qty_below_received', { poLineId: p.existing.id, qty: p.r.qty, receivedQty: p.existing.received_qty });
    }
  }

  // Delete only the unmatched, receipt-free existing lines (safe: no FK points at them).
  const keptIds = new Set(plan.filter((p) => p.existing !== undefined).map((p) => p.existing!.id));
  for (const e of existing) {
    if (!keptIds.has(e.id)) ctx.store.db.prepare('DELETE FROM po_line WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, e.id);
  }
  // Update matched lines in place (identity + received/billed preserved); insert the genuinely new ones.
  plan.forEach((p, i) => {
    if (p.existing !== undefined) {
      ctx.store.db
        .prepare('UPDATE po_line SET item_id = ?, description = ?, qty = ?, unit_price_rappen = ?, unit_price_base_rappen = ?, tax_code = ?, project_id = ?, sort = ? WHERE workspace_id = ? AND id = ?')
        .run(p.r.itemId, p.r.description, p.r.qty, p.r.unitPriceRappen, p.r.unitPriceBaseRappen, p.r.taxCode, p.r.projectId, i, ctx.workspaceId, p.existing.id);
    } else {
      ctx.store.db
        .prepare(
          `INSERT INTO po_line (id, workspace_id, po_id, item_id, description, qty, unit_price_rappen, unit_price_base_rappen, tax_code, received_qty, billed_qty, project_id, sort)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
        )
        .run(ctx.ids.next('poline'), ctx.workspaceId, poId, p.r.itemId, p.r.description, p.r.qty, p.r.unitPriceRappen, p.r.unitPriceBaseRappen, p.r.taxCode, p.r.projectId, i);
    }
  });
  return ok(totalsOf(ctx, resolved));
}

export interface PoUpsertInput {
  poId?: string;
  supplierContactId?: string;
  currency?: string;
  lines?: PoLineInput[];
  note?: string | null;
  /**
   * I01 provenance: the source document this PO is minted from (e.g. an I00 requisition). Set ONLY on
   * CREATE (a PO's origin never changes); ignored on an update. Both must be present together.
   */
  sourceDocumentType?: string | null;
  sourceDocumentId?: string | null;
  idempotencyKey?: string;
}

export function poUpsert(ctx: WorkspaceContext, input: PoUpsertInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;

  const isUpdate = typeof input.poId === 'string' && input.poId.length > 0;

  // Every state guard lives INSIDE `run` so `runTx` replays a stored success before the guard can
  // reject a retry (§H-IDEMPOTENT), and a genuine refusal THROWS and rolls back to ZERO rows.
  const run = (): Result => {
    const now = ctx.clock.now();
    let existing: PoRow | undefined;
    if (isUpdate) {
      existing = readPo(ctx, input.poId);
      if (existing === undefined) return poNotFound(input.poId);
      // Editing a PO after `sent` is refused; changes go through po_revise (US-D02.1 error).
      if (existing.status !== 'draft') return err('invalid_transition', { poId: input.poId, status: existing.status });
    } else {
      if (!contactExists(ctx, input.supplierContactId)) return err('invalid_reference', { supplierContactId: input.supplierContactId });
    }

    const currency = input.currency ?? (existing ? existing.currency : 'CHF');
    const supplierContactId = existing ? existing.supplier_contact_id : (input.supplierContactId as string);
    const resolvedLines = resolveLines(ctx, supplierContactId, currency, input.lines ?? []);
    if (!resolvedLines.ok) return resolvedLines;
    const resolved = (resolvedLines as unknown as { lines: ResolvedLine[] }).lines;
    const fxRate = (resolvedLines as unknown as { fxRate: string }).fxRate;
    const isBase = (resolvedLines as unknown as { isBase: boolean }).isBase;

    let poId: string;
    let created: boolean;
    let existingLines: PoLineRow[];
    if (isUpdate) {
      poId = input.poId as string;
      created = false;
      existingLines = readPoLines(ctx, poId);
    } else {
      poId = ctx.ids.next('po');
      created = true;
      existingLines = [];
      // Provenance is a matched pair or nothing: never a half-link.
      const srcType = typeof input.sourceDocumentType === 'string' && input.sourceDocumentType.length > 0 ? input.sourceDocumentType : null;
      const srcId = typeof input.sourceDocumentId === 'string' && input.sourceDocumentId.length > 0 ? input.sourceDocumentId : null;
      ctx.store.db
        .prepare(
          `INSERT INTO purchase_order (id, workspace_id, number, supplier_contact_id, status, revision, currency, total_rappen, total_base_rappen, fx_rate, expected_on, sent_artifact_ref, note, source_document_type, source_document_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'draft', 1, ?, 0, 0, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(poId, ctx.workspaceId, nextPoNumber(ctx), supplierContactId, currency, isBase ? null : fxRate, input.note ?? null, srcType, srcId, now, now);
    }
    // Reconcile lines PRESERVING identity so a revised PO's receipts (goods_receipt_line FK) are never
    // orphaned; refuses qty_below_received (US-D02.6).
    const applied = applyPoLines(ctx, poId, existingLines, resolved);
    if (!applied.ok) return applied;
    const totals = applied as unknown as { totalRappen: number; totalBaseRappen: number; expectedOn: string | null };
    ctx.store.db
      .prepare('UPDATE purchase_order SET total_rappen = ?, total_base_rappen = ?, expected_on = ?, fx_rate = ?, note = COALESCE(?, note), updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(totals.totalRappen, totals.totalBaseRappen, totals.expectedOn, isBase ? null : fxRate, input.note ?? null, now, ctx.workspaceId, poId);

    const detail = poDetail(ctx, poId);
    if (!detail.ok) return detail;
    const withId = { ...(detail as unknown as Record<string, unknown>), poId };
    // po.drafted fires only on CREATE (result.draftedPoId present), never on every draft edit.
    return ok(created ? { ...withId, draftedPoId: poId } : withId);
  };

  return runTx(ctx, 'po_upsert', input.idempotencyKey, run);
}

export interface PoSendInput {
  poId?: string;
  idempotencyKey?: string;
}

/**
 * `draft -> sent` (P7). Renders the outbound PDF ARTIFACT reference and stops (Pattern P8): it returns
 * `{ transmitted:false }` and NEVER emails the supplier on its own. The OSS core produces the artifact
 * reference; a host/cloud tier renders the file and, only with the approval dial, transmits it.
 */
export function poSend(ctx: WorkspaceContext, input: PoSendInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;

  const run = (): Result => {
    const po = readPo(ctx, input.poId);
    if (po === undefined) return poNotFound(input.poId);
    if (!isPoTransitionAllowed(po.status, 'sent')) return err('invalid_transition', { poId: po.id, from: po.status, to: 'sent' });
    // A zero-line PO cannot leave draft (spec §2 boundary).
    if (readPoLines(ctx, po.id).length === 0) return err('no_lines', { poId: po.id });
    const artifactRef = `po-artifact/${po.id}/rev${po.revision}`;
    ctx.store.db
      .prepare("UPDATE purchase_order SET status = 'sent', sent_artifact_ref = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(artifactRef, ctx.clock.now(), ctx.workspaceId, po.id);
    const detail = poDetail(ctx, po.id);
    if (!detail.ok) return detail;
    return ok({ ...(detail as unknown as Record<string, unknown>), sentPoId: po.id, artifactRef, transmitted: false });
  };

  return runTx(ctx, 'po_send', input.idempotencyKey, run);
}

export interface PoSimpleInput {
  poId?: string;
  reason?: string | null;
  idempotencyKey?: string;
}

/** `po.closeShort`: waive the remaining open quantity, `sent -> closed` (US-D02.4). */
export function poCloseShort(ctx: WorkspaceContext, input: PoSimpleInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;

  const run = (): Result => {
    const po = readPo(ctx, input.poId);
    if (po === undefined) return poNotFound(input.poId);
    if (!isPoTransitionAllowed(po.status, 'closed')) return err('invalid_transition', { poId: po.id, from: po.status, to: 'closed' });
    ctx.store.db
      .prepare("UPDATE purchase_order SET status = 'closed', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(ctx.clock.now(), ctx.workspaceId, po.id);
    const detail = poDetail(ctx, po.id);
    if (!detail.ok) return detail;
    return ok({ ...(detail as unknown as Record<string, unknown>), closedPoId: po.id });
  };

  return runTx(ctx, 'po_close_short', input.idempotencyKey, run);
}

/** `po.cancel`: `draft|sent -> cancelled`, ONLY while nothing has been received (US-D02.5). */
export function poCancel(ctx: WorkspaceContext, input: PoSimpleInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;

  const run = (): Result => {
    const po = readPo(ctx, input.poId);
    if (po === undefined) return poNotFound(input.poId);
    if (!isPoTransitionAllowed(po.status, 'cancelled')) return err('invalid_transition', { poId: po.id, from: po.status, to: 'cancelled' });
    // has_receipts guard: a PO with any receipt leaves through close-short, never cancel (US-D02.5).
    if (readPoLines(ctx, po.id).some((l) => l.received_qty > 0)) return err('has_receipts', { poId: po.id });
    ctx.store.db
      .prepare("UPDATE purchase_order SET status = 'cancelled', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(ctx.clock.now(), ctx.workspaceId, po.id);
    const detail = poDetail(ctx, po.id);
    if (!detail.ok) return detail;
    return ok({ ...(detail as unknown as Record<string, unknown>), cancelledPoId: po.id });
  };

  return runTx(ctx, 'po_cancel', input.idempotencyKey, run);
}

/**
 * `po.revise`: the revise edge `sent -> draft` (US-D02.6). Snapshots the current header + lines into
 * `po_revision` (append-only, §H-AUDIT), increments `revision`, then re-opens as a draft. `received_qty`
 * and `billed_qty` survive untouched (they belong to receipts/matches, not the edit); the subsequent
 * re-send rides the P8-gated `po_send`, so a revision can never leak to the supplier without the dial.
 */
export function poRevise(ctx: WorkspaceContext, input: PoSimpleInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;

  const run = (): Result => {
    const po = readPo(ctx, input.poId);
    if (po === undefined) return poNotFound(input.poId);
    // Only `sent` is revisable (spec §2 error): draft/received/closed/cancelled are refused.
    if (!isPoTransitionAllowed(po.status, 'draft')) return err('invalid_transition', { poId: po.id, from: po.status, to: 'draft' });
    const lines = readPoLines(ctx, po.id);
    const snapshot = JSON.stringify({ header: po, lines });
    ctx.store.db
      .prepare('INSERT INTO po_revision (id, workspace_id, po_id, revision, revised_by, revised_at, reason, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.ids.next('porev'), ctx.workspaceId, po.id, po.revision, ctx.actor, ctx.clock.now(), input.reason ?? null, snapshot, ctx.clock.now());
    ctx.store.db
      .prepare("UPDATE purchase_order SET status = 'draft', revision = revision + 1, sent_artifact_ref = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(ctx.clock.now(), ctx.workspaceId, po.id);
    const detail = poDetail(ctx, po.id);
    if (!detail.ok) return detail;
    return ok({ ...(detail as unknown as Record<string, unknown>), poId: po.id, revision: po.revision + 1 });
  };

  return runTx(ctx, 'po_revise', input.idempotencyKey, run);
}

// --- Reads -------------------------------------------------------------------------------------

export function poList(ctx: WorkspaceContext, input: { status?: string; supplierContactId?: string; savedViewId?: string }): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  // A `po` saved view (G00) merges its stored filters UNDERNEATH any filter named explicitly here.
  const viewed = applySavedView(ctx, 'po', {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.supplierContactId !== undefined ? { supplierContactId: input.supplierContactId } : {}),
    ...(input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {}),
  });
  if (!viewed.ok) return viewed;
  const f = viewed.filter as { status?: string; supplierContactId?: string };
  const clauses: string[] = ['workspace_id = ?'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof f.status === 'string' && f.status.length > 0) {
    clauses.push('status = ?');
    params.push(f.status);
  }
  if (typeof f.supplierContactId === 'string' && f.supplierContactId.length > 0) {
    clauses.push('supplier_contact_id = ?');
    params.push(f.supplierContactId);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM purchase_order WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`)
    .all(...params) as PoRow[];
  return ok({ pos: rows.map(poView) });
}

export function poGet(ctx: WorkspaceContext, input: { poId?: string; savedViewId?: string }): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  return poDetail(ctx, typeof input.poId === 'string' ? input.poId : '');
}

/**
 * `po.openLines` (P5): every PO line with `received_qty < qty` on a `sent` PO, with
 * `open_qty = qty - received_qty`. The backorder queue (US-D02.4); an agent polls it after a receipt.
 */
export function poOpenLines(ctx: WorkspaceContext, input: { supplierContactId?: string; savedViewId?: string }): Result {
  const capable = ctx.capabilities.assert('read_master_data');
  if (!capable.ok) return capable;
  const viewed = applySavedView(ctx, 'po', {
    ...(input.supplierContactId !== undefined ? { supplierContactId: input.supplierContactId } : {}),
    ...(input.savedViewId !== undefined ? { savedViewId: input.savedViewId } : {}),
  });
  if (!viewed.ok) return viewed;
  const f = viewed.filter as { supplierContactId?: string };
  const clauses: string[] = ["po.workspace_id = ?", "po.status = 'sent'", 'l.received_qty < l.qty'];
  const params: unknown[] = [ctx.workspaceId];
  if (typeof f.supplierContactId === 'string' && f.supplierContactId.length > 0) {
    clauses.push('po.supplier_contact_id = ?');
    params.push(f.supplierContactId);
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT l.id AS lineId, l.po_id AS poId, po.number AS poNumber, po.supplier_contact_id AS supplierContactId,
              l.item_id AS itemId, l.description AS description, l.qty AS qty, l.received_qty AS receivedQty,
              (l.qty - l.received_qty) AS openQty
         FROM po_line l JOIN purchase_order po ON po.id = l.po_id AND po.workspace_id = l.workspace_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY po.created_at, l.sort`,
    )
    .all(...params) as Record<string, unknown>[];
  return ok({ lines: rows });
}

export type { PoStatus };
