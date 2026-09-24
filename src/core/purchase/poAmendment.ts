/**
 * I01 (Advanced Purchase Order) OP14, the AMENDMENT side: the controlled-change lifecycle over a sent
 * or partially-received D02 purchase order. An amendment walks `draft -> (pending_approval) -> applied`
 * (or `rejected` / `cancelled`), and `apply` is the ONE write that advances the live PO to a new
 * immutable version while freezing the prior one.
 *
 * INVARIANTS this file is responsible for (spec §4, property-tested):
 *  - received_qty / billed_qty on a surviving line are NEVER decreased by an amendment.
 *  - a line with received_qty > 0 cannot be removed (`line_has_receipts`), and a change cannot drop a
 *    line's qty below its received_qty (`qty_below_received`).
 *  - after `apply`, the live `po_line` set equals the new active version's `lines_snapshot`.
 *  - version numbers are strictly increasing and gap-free; exactly one version is active.
 *  - `apply` is idempotent on ROWS: a replay under the same idempotency_key creates NO second version.
 *  - §H-TENANT on every query; money is integer Rappen (P2); NOTHING posts (P3).
 *
 * P8: `apply` re-renders the outbound PO PDF ARTIFACT carrying the new revision and STOPS. It returns
 * `{ transmitted:false }` and never emails the supplier on its own, exactly as D02 `po_send` does: an
 * amended commitment can only reach the supplier through the approval dial, never as a side effect.
 *
 * Every write rides `runTx` (poShared): a REFUSED write THROWS and rolls back to ZERO rows, so a
 * violation leaves the live PO and its version trail untouched.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { resolveFxRate } from '../fx/rates.js';
import { convertMinor } from '../fx/rateMath.js';
import { runTx, readPo, readPoLines, readItemRow, poNotFound } from './poShared.js';
import type { PoRow, PoLineRow } from './poShared.js';
import { isPoAmendmentOp } from './poVersionEnums.js';
import type { PoAmendmentOp } from './poVersionEnums.js';
import {
  ensureVersionedInline,
  readActiveVersion,
  maxVersionNumber,
  insertVersion,
  headerSnapshotOf,
  lineSnapshotsOf,
} from './poVersion.js';

const WRITE_CAP = 'manage_master_data';
const READ_CAP = 'read_master_data';

/** A PO whose status still carries an open commitment an amendment may touch. */
function isAmendableStatus(status: string): boolean {
  return status === 'sent' || status === 'received';
}

export interface PoAmendmentRow {
  id: string;
  workspace_id: string;
  po_id: string;
  from_version_id: string;
  to_version_id: string | null;
  status: string;
  reason: string | null;
  committed_value_delta_rappen: number | null;
  created_by: string | null;
  submitted_by: string | null;
  applied_by: string | null;
  rejected_by: string | null;
  cancelled_by: string | null;
  created_at: string;
  submitted_at: string | null;
  applied_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
  idempotency_key: string | null;
}

export interface PoAmendmentLineRow {
  id: string;
  workspace_id: string;
  amendment_id: string;
  op: string;
  po_line_id: string | null;
  item_id: string | null;
  before_qty: number | null;
  after_qty: number | null;
  before_unit_price_rappen: number | null;
  after_unit_price_rappen: number | null;
  before_description: string | null;
  after_description: string | null;
  tax_code: string | null;
  sort: number;
}

function readAmendment(ctx: WorkspaceContext, id: unknown): PoAmendmentRow | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM po_amendment WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as PoAmendmentRow | undefined;
}

function readAmendmentLines(ctx: WorkspaceContext, amendmentId: string): PoAmendmentLineRow[] {
  return ctx.store.db
    .prepare('SELECT * FROM po_amendment_line WHERE workspace_id = ? AND amendment_id = ? ORDER BY sort, id')
    .all(ctx.workspaceId, amendmentId) as PoAmendmentLineRow[];
}

/** The one open (`draft` | `pending_approval`) amendment for a PO, or undefined. */
function readOpenAmendment(ctx: WorkspaceContext, poId: string): PoAmendmentRow | undefined {
  return ctx.store.db
    .prepare("SELECT * FROM po_amendment WHERE workspace_id = ? AND po_id = ? AND status IN ('draft', 'pending_approval')")
    .get(ctx.workspaceId, poId) as PoAmendmentRow | undefined;
}

function amendmentView(a: PoAmendmentRow) {
  return {
    id: a.id,
    poId: a.po_id,
    fromVersionId: a.from_version_id,
    toVersionId: a.to_version_id,
    status: a.status,
    reason: a.reason,
    committedValueDeltaRappen: a.committed_value_delta_rappen,
    createdBy: a.created_by,
    submittedBy: a.submitted_by,
    appliedBy: a.applied_by,
    rejectedBy: a.rejected_by,
    cancelledBy: a.cancelled_by,
    createdAt: a.created_at,
  };
}

// --- Impact (pure) -----------------------------------------------------------------------------

interface PerLineImpact {
  poLineId: string | null;
  op: PoAmendmentOp;
  itemId: string | null;
  beforeQty: number | null;
  afterQty: number | null;
  beforeUnitPriceRappen: number | null;
  afterUnitPriceRappen: number | null;
  beforeDescription: string | null;
  afterDescription: string | null;
  beforeValueRappen: number;
  afterValueRappen: number;
  receivedQty: number;
  violation: string | null;
}

interface Impact {
  perLine: PerLineImpact[];
  committedValueDeltaRappen: number;
  violations: { code: string; poLineId: string | null }[];
  effectiveChange: boolean;
}

/**
 * Compute the structured impact of an amendment against the CURRENT live lines (P5, pure: no write).
 * The authoritative "before" is always the live line at this instant, never the image captured at
 * update time, so a preview and the apply that follows read the same truth.
 */
function computeImpact(ctx: WorkspaceContext, amendment: PoAmendmentRow): Impact {
  const live = new Map(readPoLines(ctx, amendment.po_id).map((l) => [l.id, l]));
  const ops = readAmendmentLines(ctx, amendment.id);
  const perLine: PerLineImpact[] = [];
  const violations: { code: string; poLineId: string | null }[] = [];
  let delta = 0;
  let effective = false;

  for (const op of ops) {
    if (op.op === 'add') {
      const afterQty = op.after_qty ?? 0;
      const afterPrice = op.after_unit_price_rappen ?? 0;
      const afterValue = afterQty * afterPrice;
      delta += afterValue;
      effective = true;
      perLine.push({
        poLineId: null, op: 'add', itemId: op.item_id,
        beforeQty: null, afterQty, beforeUnitPriceRappen: null, afterUnitPriceRappen: afterPrice,
        beforeDescription: null, afterDescription: op.after_description,
        beforeValueRappen: 0, afterValueRappen: afterValue, receivedQty: 0, violation: null,
      });
      continue;
    }
    const line = op.po_line_id !== null ? live.get(op.po_line_id) : undefined;
    if (line === undefined) {
      violations.push({ code: 'line_not_found', poLineId: op.po_line_id });
      perLine.push({
        poLineId: op.po_line_id, op: op.op as PoAmendmentOp, itemId: null,
        beforeQty: null, afterQty: null, beforeUnitPriceRappen: null, afterUnitPriceRappen: null,
        beforeDescription: null, afterDescription: null,
        beforeValueRappen: 0, afterValueRappen: 0, receivedQty: 0, violation: 'line_not_found',
      });
      continue;
    }
    const beforeValue = line.qty * line.unit_price_rappen;
    if (op.op === 'remove') {
      let violation: string | null = null;
      if (line.received_qty > 0 || line.billed_qty > 0) {
        violation = 'line_has_receipts';
        violations.push({ code: 'line_has_receipts', poLineId: line.id });
      }
      delta -= beforeValue;
      effective = true;
      perLine.push({
        poLineId: line.id, op: 'remove', itemId: line.item_id,
        beforeQty: line.qty, afterQty: null, beforeUnitPriceRappen: line.unit_price_rappen, afterUnitPriceRappen: null,
        beforeDescription: line.description, afterDescription: null,
        beforeValueRappen: beforeValue, afterValueRappen: 0, receivedQty: line.received_qty, violation,
      });
      continue;
    }
    // op.op === 'change'
    const afterQty = op.after_qty ?? line.qty;
    const afterPrice = op.after_unit_price_rappen ?? line.unit_price_rappen;
    const afterDesc = op.after_description ?? line.description;
    const afterValue = afterQty * afterPrice;
    let violation: string | null = null;
    if (afterQty < line.received_qty) {
      violation = 'qty_below_received';
      violations.push({ code: 'qty_below_received', poLineId: line.id });
    }
    const changed = afterQty !== line.qty || afterPrice !== line.unit_price_rappen || afterDesc !== line.description;
    if (changed) effective = true;
    delta += afterValue - beforeValue;
    perLine.push({
      poLineId: line.id, op: 'change', itemId: line.item_id,
      beforeQty: line.qty, afterQty, beforeUnitPriceRappen: line.unit_price_rappen, afterUnitPriceRappen: afterPrice,
      beforeDescription: line.description, afterDescription: afterDesc,
      beforeValueRappen: beforeValue, afterValueRappen: afterValue, receivedQty: line.received_qty, violation,
    });
  }

  return { perLine, committedValueDeltaRappen: delta, violations, effectiveChange: effective };
}

function impactView(impact: Impact) {
  return {
    lines: impact.perLine,
    committedValueDeltaRappen: impact.committedValueDeltaRappen,
    violations: impact.violations,
    effectiveChange: impact.effectiveChange,
    applicable: impact.violations.length === 0 && impact.effectiveChange,
  };
}

// --- Writers -----------------------------------------------------------------------------------

export interface AmendmentStartInput {
  poId?: string;
  reason?: string;
  idempotencyKey?: string;
}

/** `po_amendment_start`: open a draft amendment against a sent/partially-received PO (US-I01.2). */
export function poAmendmentStart(ctx: WorkspaceContext, input: AmendmentStartInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;

  const run = (): Result => {
    const po = readPo(ctx, input.poId);
    if (po === undefined) return poNotFound(input.poId);
    if (!isAmendableStatus(po.status)) return err('invalid_transition', { poId: po.id, status: po.status });
    // Materialise version 1 first so the trail is continuous even for a legacy D02 PO (US-I01.1).
    const active = ensureVersionedInline(ctx, po);
    if (readOpenAmendment(ctx, po.id) !== undefined) return err('amendment_in_progress', { poId: po.id });
    // At least one open line (ordered qty still above received) must exist, or there is nothing to amend.
    const hasOpen = readPoLines(ctx, po.id).some((l) => l.qty - l.received_qty > 0);
    if (!hasOpen) return err('nothing_open', { poId: po.id });

    const id = ctx.ids.next('poamd');
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO po_amendment (id, workspace_id, po_id, from_version_id, to_version_id, status, reason, committed_value_delta_rappen, created_by, created_at, idempotency_key)
         VALUES (?, ?, ?, ?, NULL, 'draft', ?, NULL, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, po.id, active.id, input.reason ?? null, ctx.actor ?? null, now, input.idempotencyKey ?? null);
    return ok({ amendment: amendmentView(readAmendment(ctx, id) as PoAmendmentRow) });
  };

  return runTx(ctx, 'po_amendment_start', input.idempotencyKey, run);
}

export interface AmendmentChangeOp {
  op?: string;
  poLineId?: string;
  itemId?: string;
  qty?: number;
  unitPriceRappen?: number;
  description?: string | null;
  taxCode?: string | null;
}

export interface AmendmentUpdateLinesInput {
  amendmentId?: string;
  changes?: AmendmentChangeOp[];
  idempotencyKey?: string;
}

/** `po_amendment_update_lines`: set the amendment's change operations (US-I01.3). Replaces the set. */
export function poAmendmentUpdateLines(ctx: WorkspaceContext, input: AmendmentUpdateLinesInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;

  const run = (): Result => {
    const amendment = readAmendment(ctx, input.amendmentId);
    if (amendment === undefined) return err('not_found', { amendmentId: input.amendmentId });
    if (amendment.status !== 'draft') return err('invalid_transition', { amendmentId: amendment.id, status: amendment.status });
    const changes = Array.isArray(input.changes) ? input.changes : [];
    const live = new Map(readPoLines(ctx, amendment.po_id).map((l) => [l.id, l]));

    // Validate the whole batch BEFORE writing (a refusal writes zero rows).
    interface Planned { op: PoAmendmentOp; line?: PoLineRow; itemId: string | null; qty: number | null; price: number | null; description: string | null; taxCode: string | null }
    const planned: Planned[] = [];
    for (const c of changes) {
      if (!isPoAmendmentOp(c.op)) return err('invalid_input', { field: 'op', value: c.op });
      if (c.op === 'add') {
        if (typeof c.qty !== 'number' || !Number.isInteger(c.qty) || c.qty <= 0) return err('invalid_qty', { qty: c.qty });
        if (typeof c.unitPriceRappen !== 'number' || !Number.isInteger(c.unitPriceRappen) || c.unitPriceRappen < 0) return err('invalid_input', { field: 'unitPriceRappen' });
        let itemId: string | null = null;
        if (typeof c.itemId === 'string' && c.itemId.length > 0) {
          if (readItemRow(ctx, c.itemId) === undefined) return err('invalid_reference', { itemId: c.itemId });
          itemId = c.itemId;
        }
        if (itemId === null && (typeof c.description !== 'string' || c.description.length === 0)) {
          return err('invalid_input', { field: 'description', reason: 'add_needs_item_or_description' });
        }
        planned.push({ op: 'add', itemId, qty: c.qty, price: c.unitPriceRappen, description: c.description ?? null, taxCode: c.taxCode ?? null });
        continue;
      }
      // change | remove: the target line must be a live line of THIS PO (§H-TENANT via the live map).
      const line = typeof c.poLineId === 'string' ? live.get(c.poLineId) : undefined;
      if (line === undefined) return err('not_found', { poLineId: c.poLineId });
      if (c.op === 'remove') {
        planned.push({ op: 'remove', line, itemId: line.item_id, qty: null, price: null, description: null, taxCode: null });
        continue;
      }
      // change: qty/price when supplied must be valid; a NULL means "keep the live value".
      let qty: number | null = null;
      if (c.qty !== undefined) {
        if (!Number.isInteger(c.qty) || (c.qty as number) <= 0) return err('invalid_qty', { qty: c.qty });
        qty = c.qty;
      }
      let price: number | null = null;
      if (c.unitPriceRappen !== undefined) {
        if (!Number.isInteger(c.unitPriceRappen) || (c.unitPriceRappen as number) < 0) return err('invalid_input', { field: 'unitPriceRappen' });
        price = c.unitPriceRappen;
      }
      const description = c.description !== undefined ? c.description : null;
      planned.push({ op: 'change', line, itemId: line.item_id, qty, price, description, taxCode: null });
    }

    ctx.store.db.prepare('DELETE FROM po_amendment_line WHERE workspace_id = ? AND amendment_id = ?').run(ctx.workspaceId, amendment.id);
    planned.forEach((p, i) => {
      ctx.store.db
        .prepare(
          `INSERT INTO po_amendment_line (id, workspace_id, amendment_id, op, po_line_id, item_id, before_qty, after_qty, before_unit_price_rappen, after_unit_price_rappen, before_description, after_description, tax_code, sort)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.ids.next('poamdl'), ctx.workspaceId, amendment.id, p.op,
          p.line?.id ?? null, p.itemId,
          p.line?.qty ?? null, p.qty,
          p.line?.unit_price_rappen ?? null, p.price,
          p.line?.description ?? null, p.description,
          p.taxCode, i,
        );
    });
    return ok({ amendment: amendmentView(amendment), changeCount: planned.length });
  };

  return runTx(ctx, 'po_amendment_update_lines', input.idempotencyKey, run);
}

/** `po_amendment_preview` (P5, pure): the structured impact of the amendment. Never writes. */
export function poAmendmentPreview(ctx: WorkspaceContext, input: { amendmentId?: string }): Result {
  const capable = ctx.capabilities.assert(READ_CAP);
  if (!capable.ok) return capable;
  const amendment = readAmendment(ctx, input.amendmentId);
  if (amendment === undefined) return err('not_found', { amendmentId: input.amendmentId });
  return ok({ amendmentId: amendment.id, poId: amendment.po_id, impact: impactView(computeImpact(ctx, amendment)) });
}

/** The first blocking violation code, or a `no_effective_change` refusal, or null when applicable. */
function guardApplicable(impact: Impact): Result | null {
  if (impact.violations.length > 0) {
    const first = impact.violations[0]!;
    return err(first.code, { poLineId: first.poLineId });
  }
  if (!impact.effectiveChange) return err('no_effective_change', {});
  return null;
}

export interface AmendmentActionInput {
  amendmentId?: string;
  reason?: string;
  idempotencyKey?: string;
}

/** `po_amendment_submit`: draft -> pending_approval, for a workspace that gates apply (US-I01.4). */
export function poAmendmentSubmit(ctx: WorkspaceContext, input: AmendmentActionInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;

  const run = (): Result => {
    const amendment = readAmendment(ctx, input.amendmentId);
    if (amendment === undefined) return err('not_found', { amendmentId: input.amendmentId });
    if (amendment.status !== 'draft') return err('invalid_transition', { amendmentId: amendment.id, status: amendment.status });
    const blocked = guardApplicable(computeImpact(ctx, amendment));
    if (blocked !== null) return blocked;
    ctx.store.db
      .prepare("UPDATE po_amendment SET status = 'pending_approval', submitted_by = ?, submitted_at = ? WHERE workspace_id = ? AND id = ?")
      .run(ctx.actor ?? null, ctx.clock.now(), ctx.workspaceId, amendment.id);
    return ok({ amendment: amendmentView(readAmendment(ctx, amendment.id) as PoAmendmentRow) });
  };

  return runTx(ctx, 'po_amendment_submit', input.idempotencyKey, run);
}

/**
 * `po_amendment_apply`: advance the live PO to a new immutable version (US-I01.4). The single write
 * that supersedes the active version, updates the live tables, mints version N+1, and re-renders the
 * P8-gated outbound artifact. Idempotent on ROWS through `runTx`.
 */
export function poAmendmentApply(ctx: WorkspaceContext, input: AmendmentActionInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;

  const run = (): Result => {
    const amendment = readAmendment(ctx, input.amendmentId);
    if (amendment === undefined) return err('not_found', { amendmentId: input.amendmentId });
    if (amendment.status !== 'draft' && amendment.status !== 'pending_approval') {
      return err('invalid_transition', { amendmentId: amendment.id, status: amendment.status });
    }
    const po = readPo(ctx, amendment.po_id);
    if (po === undefined) return poNotFound(amendment.po_id);
    if (!isAmendableStatus(po.status)) return err('invalid_transition', { poId: po.id, status: po.status });

    const impact = computeImpact(ctx, amendment);
    const blocked = guardApplicable(impact);
    if (blocked !== null) return blocked;

    const active = readActiveVersion(ctx, po.id);
    if (active === undefined) return err('po_version_no_active', { poId: po.id });

    // The scaled rate for THIS PO's currency, resolved once at apply (spec invariant 6). CHF -> RATE_ONE.
    const fx = resolveFxRate(ctx, { currency: po.currency, date: ctx.clock.now().slice(0, 10) });
    if (!fx.ok) return fx;
    const rateScaled = (fx as unknown as { resolved: { rateScaled: bigint } }).resolved.rateScaled;

    // 1. Freeze the current active version.
    ctx.store.db.prepare("UPDATE po_version SET status = 'superseded' WHERE workspace_id = ? AND id = ?").run(ctx.workspaceId, active.id);

    // 2. Apply the operations to the live po_line set, preserving received_qty / billed_qty on survivors.
    const liveById = new Map(readPoLines(ctx, po.id).map((l) => [l.id, l]));
    let nextSort = Math.max(0, ...[...liveById.values()].map((l) => l.sort)) + 1;
    for (const item of impact.perLine) {
      if (item.op === 'remove' && item.poLineId !== null) {
        ctx.store.db.prepare('DELETE FROM po_line WHERE workspace_id = ? AND id = ?').run(ctx.workspaceId, item.poLineId);
      } else if (item.op === 'change' && item.poLineId !== null) {
        const afterQty = item.afterQty as number;
        const afterPrice = item.afterUnitPriceRappen as number;
        const afterBase = convertMinor(afterPrice, rateScaled);
        ctx.store.db
          .prepare('UPDATE po_line SET qty = ?, unit_price_rappen = ?, unit_price_base_rappen = ?, description = ? WHERE workspace_id = ? AND id = ?')
          .run(afterQty, afterPrice, afterBase, item.afterDescription, ctx.workspaceId, item.poLineId);
      } else if (item.op === 'add') {
        const afterQty = item.afterQty as number;
        const afterPrice = item.afterUnitPriceRappen as number;
        const afterBase = convertMinor(afterPrice, rateScaled);
        ctx.store.db
          .prepare(
            `INSERT INTO po_line (id, workspace_id, po_id, item_id, description, qty, unit_price_rappen, unit_price_base_rappen, tax_code, received_qty, billed_qty, project_id, sort)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?)`,
          )
          .run(ctx.ids.next('poline'), ctx.workspaceId, po.id, item.itemId, item.afterDescription, afterQty, afterPrice, afterBase, null, nextSort++);
      }
    }

    // 3. Recompute the PO totals from the new live lines, bump the revision, mint the new P8 artifact.
    const newLines = readPoLines(ctx, po.id);
    let totalRappen = 0;
    let totalBaseRappen = 0;
    for (const l of newLines) {
      totalRappen += l.qty * l.unit_price_rappen;
      totalBaseRappen += l.qty * l.unit_price_base_rappen;
    }
    const newRevision = po.revision + 1;
    const artifactRef = `po-artifact/${po.id}/rev${newRevision}`;
    ctx.store.db
      .prepare('UPDATE purchase_order SET total_rappen = ?, total_base_rappen = ?, revision = ?, sent_artifact_ref = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(totalRappen, totalBaseRappen, newRevision, artifactRef, ctx.clock.now(), ctx.workspaceId, po.id);

    // 4. Mint version N+1 (active) from the updated live state, linked to this amendment.
    const updatedPo = readPo(ctx, po.id) as PoRow;
    const versionNumber = maxVersionNumber(ctx, po.id) + 1;
    const newVersion = insertVersion(ctx, po.id, versionNumber, headerSnapshotOf(updatedPo), lineSnapshotsOf(newLines), artifactRef, amendment.id);

    // 5. Close the amendment.
    ctx.store.db
      .prepare("UPDATE po_amendment SET status = 'applied', to_version_id = ?, committed_value_delta_rappen = ?, applied_by = ?, applied_at = ? WHERE workspace_id = ? AND id = ?")
      .run(newVersion.id, impact.committedValueDeltaRappen, ctx.actor ?? null, ctx.clock.now(), ctx.workspaceId, amendment.id);

    return ok({
      amendment: amendmentView(readAmendment(ctx, amendment.id) as PoAmendmentRow),
      newVersion: { id: newVersion.id, versionNumber: newVersion.version_number, status: newVersion.status },
      poId: po.id,
      revision: newRevision,
      artifactRef,
      transmitted: false,
      committedValueDeltaRappen: impact.committedValueDeltaRappen,
    });
  };

  return runTx(ctx, 'po_amendment_apply', input.idempotencyKey, run);
}

/** `po_amendment_cancel`: abandon a draft/pending amendment, live PO untouched (US-I01.6). */
export function poAmendmentCancel(ctx: WorkspaceContext, input: AmendmentActionInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;

  const run = (): Result => {
    const amendment = readAmendment(ctx, input.amendmentId);
    if (amendment === undefined) return err('not_found', { amendmentId: input.amendmentId });
    if (amendment.status !== 'draft' && amendment.status !== 'pending_approval') {
      return err('invalid_transition', { amendmentId: amendment.id, status: amendment.status });
    }
    ctx.store.db
      .prepare("UPDATE po_amendment SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, reason = COALESCE(?, reason) WHERE workspace_id = ? AND id = ?")
      .run(ctx.actor ?? null, ctx.clock.now(), input.reason ?? null, ctx.workspaceId, amendment.id);
    return ok({ amendment: amendmentView(readAmendment(ctx, amendment.id) as PoAmendmentRow) });
  };

  return runTx(ctx, 'po_amendment_cancel', input.idempotencyKey, run);
}

/** `po_amendment_reject`: an approver refuses a draft/pending amendment with a reason (US-I01.6). */
export function poAmendmentReject(ctx: WorkspaceContext, input: AmendmentActionInput): Result {
  const capable = ctx.capabilities.assert(WRITE_CAP);
  if (!capable.ok) return capable;

  const run = (): Result => {
    const amendment = readAmendment(ctx, input.amendmentId);
    if (amendment === undefined) return err('not_found', { amendmentId: input.amendmentId });
    if (amendment.status !== 'draft' && amendment.status !== 'pending_approval') {
      return err('invalid_transition', { amendmentId: amendment.id, status: amendment.status });
    }
    if (typeof input.reason !== 'string' || input.reason.length === 0) return err('invalid_input', { field: 'reason' });
    ctx.store.db
      .prepare("UPDATE po_amendment SET status = 'rejected', rejected_by = ?, rejected_at = ?, reason = ? WHERE workspace_id = ? AND id = ?")
      .run(ctx.actor ?? null, ctx.clock.now(), input.reason, ctx.workspaceId, amendment.id);
    return ok({ amendment: amendmentView(readAmendment(ctx, amendment.id) as PoAmendmentRow) });
  };

  return runTx(ctx, 'po_amendment_reject', input.idempotencyKey, run);
}
