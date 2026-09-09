/**
 * I01 (Advanced Purchase Order) OP14 invariants (spec §4/§8). These are the assertions the capability
 * is not allowed to reach `develop` without, and they are written to BITE: each failure mode is shown
 * failing-closed (a refusal that writes ZERO rows and leaves the live PO + version trail untouched)
 * rather than merely returning the right shape.
 *
 * Covered:
 *  - version-1 materialisation on first touch (idempotent, non-destructive);
 *  - the apply path: v1 superseded, v2 active, live lines updated, totals recomputed, one active version;
 *  - PREVIEW EQUALS POST-APPLY (the impact the preview shows is the state apply produces);
 *  - received_qty / billed_qty preserved; qty_below_received and line_has_receipts guards BITE;
 *  - IDEMPOTENT APPLY ON ROWS (a replay under one key mints NO second version);
 *  - THE P8 GATE BITES (a role without manage_master_data cannot apply; zero rows, no artifact);
 *  - one-open-amendment serialisation (amendment_in_progress); no_effective_change;
 *  - §H-TENANT (a cross-tenant amendment/version id is refused);
 *  - PROVENANCE drill-back (requisition_convert_to_po stamps source_document_type/id; a direct PO is null);
 *  - cancel / reject leave the live PO untouched; an applied amendment cannot be cancelled.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

function count(deps, table, workspaceId) {
  return deps.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId).n;
}

/** A workspace (owner = 'studio') with a vendor, a stock-tracked item (cost 90.00) and a location. */
function seed(key) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Einkauf AG', `i01-${key}`);
  const vendor = must(call(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: `${key}-v` }), 'create_contact').contact.id;
  const item = must(call(deps, 'create_item', { workspaceId, name: 'Rohstoff', defaultUnitPriceMinor: 12000, idempotencyKey: `${key}-i` }), 'create_item').item.id;
  deps.store.db.prepare('UPDATE item SET track_stock = 1, cost_price_minor = ? WHERE workspace_id = ? AND id = ?').run(9000, workspaceId, item);
  const location = must(call(deps, 'stock_location_upsert', { workspaceId, name: 'Wareneingang', idempotencyKey: `${key}-l` }), 'stock_location_upsert').location.id;
  return { deps, workspaceId, vendor, item, location };
}

/** A PO for `qty` units at net `unit` Rappen, SENT. Returns the po id and its first line id. */
function sentPo(s, key, qty = 6, unit = 10000) {
  const po = must(call(s.deps, 'po_upsert', { workspaceId: s.workspaceId, supplierContactId: s.vendor, lines: [{ itemId: s.item, qty, unitPriceRappen: unit }], idempotencyKey: `${key}-po` }), 'po_upsert');
  must(call(s.deps, 'po_send', { workspaceId: s.workspaceId, poId: po.poId, idempotencyKey: `${key}-send` }), 'po_send');
  const lineId = call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId: po.poId }).lines[0].id;
  return { poId: po.poId, lineId };
}

// --- version-1 materialisation ------------------------------------------------------------------

test('the first I01 touch materialises version 1, and a second touch adds no version', () => {
  const s = seed('mat');
  const { poId } = sentPo(s, 'mat');
  assert.equal(count(s.deps, 'po_version', s.workspaceId), 0, 'no version before I01 touches the PO');
  const first = must(call(s.deps, 'po_version_list', { workspaceId: s.workspaceId, poId }), 'version_list');
  assert.equal(first.versions.length, 1);
  assert.equal(first.versions[0].versionNumber, 1);
  assert.equal(first.versions[0].status, 'active');
  // A second touch is idempotent: no second v1.
  must(call(s.deps, 'po_version_list', { workspaceId: s.workspaceId, poId }), 'version_list again');
  assert.equal(count(s.deps, 'po_version', s.workspaceId), 1, 'materialisation is idempotent');
});

// --- the apply path -----------------------------------------------------------------------------

test('apply supersedes v1, mints an active v2, updates the live lines and totals, exactly one active', () => {
  const s = seed('apply');
  const { poId, lineId } = sentPo(s, 'apply', 6, 10000);
  const a = must(call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, reason: 'Mehr bestellen', idempotencyKey: 'ap-start' }), 'start');
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, changes: [{ op: 'change', poLineId: lineId, qty: 10, unitPriceRappen: 12000 }], idempotencyKey: 'ap-upd' }), 'update');
  const applied = must(call(s.deps, 'po_amendment_apply', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, idempotencyKey: 'ap-apply' }), 'apply');

  assert.equal(applied.transmitted, false, 'P8: apply renders the artifact but never transmits');
  assert.match(applied.artifactRef, /rev2$/, 'the Rev 2 artifact is minted');
  assert.equal(applied.newVersion.versionNumber, 2);

  // Exactly one active version, and it is v2.
  const active = s.deps.store.db.prepare("SELECT version_number FROM po_version WHERE workspace_id = ? AND po_id = ? AND status = 'active'").all(s.workspaceId, poId);
  assert.equal(active.length, 1);
  assert.equal(active[0].version_number, 2);
  // The live line carries the amended values, and the header total tracks them (10 * 120.00 = 1200.00).
  const po = call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId });
  assert.equal(po.lines[0].qty, 10);
  assert.equal(po.lines[0].unitPriceRappen, 12000);
  assert.equal(po.po.totalRappen, 120000);
  // Invariant: the live lines equal the new active version's lines_snapshot.
  const v2 = must(call(s.deps, 'po_version_get', { workspaceId: s.workspaceId, versionId: applied.newVersion.id }), 'version_get');
  assert.equal(v2.version.lines[0].qty, 10);
  assert.equal(v2.version.lines[0].unitPriceRappen, 12000);
});

test('the preview impact equals the post-apply live state', () => {
  const s = seed('prev');
  const { poId, lineId } = sentPo(s, 'prev', 6, 10000);
  const a = must(call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, idempotencyKey: 'pv-start' }), 'start');
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, changes: [{ op: 'change', poLineId: lineId, qty: 7 }], idempotencyKey: 'pv-upd' }), 'update');
  const preview = must(call(s.deps, 'po_amendment_preview', { workspaceId: s.workspaceId, amendmentId: a.amendment.id }), 'preview');
  const line = preview.impact.lines.find((l) => l.poLineId === lineId);
  assert.equal(line.afterQty, 7);
  // committed-value delta: (7 - 6) * 100.00 = +100.00.
  assert.equal(preview.impact.committedValueDeltaRappen, 10000);
  assert.equal(preview.impact.applicable, true);
  must(call(s.deps, 'po_amendment_apply', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, idempotencyKey: 'pv-apply' }), 'apply');
  const po = call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId });
  assert.equal(po.lines[0].qty, line.afterQty, 'preview afterQty is exactly what apply produced');
});

// --- received_qty preservation + guards ---------------------------------------------------------

test('a partial receipt survives an amendment untouched, and qty cannot drop below received', () => {
  const s = seed('recv');
  const { poId, lineId } = sentPo(s, 'recv', 6, 10000);
  // Receive 4 of 6.
  must(call(s.deps, 'receipt_record', { workspaceId: s.workspaceId, poId, locationId: s.location, lines: [{ poLineId: lineId, qty: 4 }], idempotencyKey: 'rc-1' }), 'receipt');

  // Lowering to 3 (below the 4 received) is refused, and writes nothing.
  const a = must(call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, idempotencyKey: 'rc-start' }), 'start');
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, changes: [{ op: 'change', poLineId: lineId, qty: 3 }], idempotencyKey: 'rc-upd' }), 'update');
  const preview = must(call(s.deps, 'po_amendment_preview', { workspaceId: s.workspaceId, amendmentId: a.amendment.id }), 'preview');
  assert.equal(preview.impact.applicable, false);
  assert.ok(preview.impact.violations.some((v) => v.code === 'qty_below_received'));
  const blocked = call(s.deps, 'po_amendment_apply', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, idempotencyKey: 'rc-apply' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'qty_below_received');
  // Zero rows: no v2 was created, the live line still has qty 6 and received_qty 4.
  assert.equal(count(s.deps, 'po_version', s.workspaceId), 1, 'the blocked apply minted no version');
  const po = call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId });
  assert.equal(po.lines[0].qty, 6);
  assert.equal(po.lines[0].receivedQty, 4);

  // Raising to 9 is allowed, and received_qty is preserved across the apply.
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, changes: [{ op: 'change', poLineId: lineId, qty: 9 }], idempotencyKey: 'rc-upd2' }), 'update raise');
  must(call(s.deps, 'po_amendment_apply', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, idempotencyKey: 'rc-apply2' }), 'apply raise');
  const after = call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId });
  assert.equal(after.lines[0].qty, 9);
  assert.equal(after.lines[0].receivedQty, 4, 'received_qty is never altered by an amendment');
});

test('a line that carries receipts cannot be removed (line_has_receipts), and writes zero rows', () => {
  const s = seed('rm');
  const { poId, lineId } = sentPo(s, 'rm', 6, 10000);
  must(call(s.deps, 'receipt_record', { workspaceId: s.workspaceId, poId, locationId: s.location, lines: [{ poLineId: lineId, qty: 2 }], idempotencyKey: 'rm-rc' }), 'receipt');
  const a = must(call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, idempotencyKey: 'rm-start' }), 'start');
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, changes: [{ op: 'remove', poLineId: lineId }], idempotencyKey: 'rm-upd' }), 'update');
  const blocked = call(s.deps, 'po_amendment_apply', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, idempotencyKey: 'rm-apply' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'line_has_receipts');
  assert.equal(count(s.deps, 'po_version', s.workspaceId), 1, 'no version minted');
  assert.equal(count(s.deps, 'po_line', s.workspaceId), 1, 'the received line still exists');
});

// --- idempotent apply on ROWS -------------------------------------------------------------------

test('apply is idempotent on ROWS: a replay under one key mints NO second version', () => {
  const s = seed('idem');
  const { poId, lineId } = sentPo(s, 'idem', 6, 10000);
  const a = must(call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, idempotencyKey: 'id-start' }), 'start');
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, changes: [{ op: 'change', poLineId: lineId, qty: 8 }], idempotencyKey: 'id-upd' }), 'update');
  const first = must(call(s.deps, 'po_amendment_apply', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, idempotencyKey: 'id-apply' }), 'apply 1');
  const replay = must(call(s.deps, 'po_amendment_apply', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, idempotencyKey: 'id-apply' }), 'apply replay');
  assert.equal(first.newVersion.id, replay.newVersion.id, 'the replay returns the SAME version, not a new one');
  assert.equal(count(s.deps, 'po_version', s.workspaceId), 2, 'exactly v1 + v2, never a third row on replay');
  const active = s.deps.store.db.prepare("SELECT COUNT(*) AS n FROM po_version WHERE workspace_id = ? AND po_id = ? AND status = 'active'").get(s.workspaceId, poId).n;
  assert.equal(active, 1);
});

// --- THE P8 GATE BITES --------------------------------------------------------------------------

test('a role without manage_master_data cannot apply an amendment: P8 gate bites, zero rows', () => {
  const s = seed('gate');
  const { poId, lineId } = sentPo(s, 'gate', 6, 10000);
  const a = must(call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, idempotencyKey: 'g-start' }), 'start');
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, changes: [{ op: 'change', poLineId: lineId, qty: 9 }], idempotencyKey: 'g-upd' }), 'update');

  // Narrow the 'agent' seat to `viewer` (reads only) through the product's own flow, then act as it.
  must(call(s.deps, 'invite_member', { workspaceId: s.workspaceId, email: 'agent@example.test', role: 'viewer', idempotencyKey: 'g-invite' }), 'invite');
  const seat = call(s.deps, 'list_members', { workspaceId: s.workspaceId }).members.find((m) => m.actorId === 'agent');
  must(call(s.deps, 'set_role', { workspaceId: s.workspaceId, memberId: seat.memberId, role: 'viewer' }), 'set_role');
  s.deps.actor = 'agent';

  const denied = call(s.deps, 'po_amendment_apply', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, idempotencyKey: 'g-apply' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'permission_denied');
  assert.equal(denied.capability, 'manage_master_data');
  // The refusal wrote nothing: no v2, the amendment is still draft, the live line unchanged.
  assert.equal(count(s.deps, 'po_version', s.workspaceId), 1, 'the denied apply minted no version, no artifact');
  s.deps.actor = 'studio';
  assert.equal(call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId }).lines[0].qty, 6);
});

// --- serialisation + no_effective_change --------------------------------------------------------

test('only one open amendment per PO (amendment_in_progress), and a zero-delta amendment is refused', () => {
  const s = seed('serial');
  const { poId, lineId } = sentPo(s, 'serial', 6, 10000);
  const a = must(call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, idempotencyKey: 'se-start' }), 'start');
  const second = call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, idempotencyKey: 'se-start2' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'amendment_in_progress');

  // An amendment with a change that alters nothing is not applicable.
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, changes: [{ op: 'change', poLineId: lineId, qty: 6 }], idempotencyKey: 'se-upd' }), 'update noop');
  const noop = call(s.deps, 'po_amendment_apply', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, idempotencyKey: 'se-apply' });
  assert.equal(noop.ok, false);
  assert.equal(noop.error, 'no_effective_change');
});

test('a description-only amendment is effective and still mints a new version (US-I01.8)', () => {
  const s = seed('desc');
  const { poId, lineId } = sentPo(s, 'desc', 6, 10000);
  const a = must(call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, idempotencyKey: 'de-start' }), 'start');
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, changes: [{ op: 'change', poLineId: lineId, description: 'Rohstoff, Charge B' }], idempotencyKey: 'de-upd' }), 'update');
  const applied = must(call(s.deps, 'po_amendment_apply', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, idempotencyKey: 'de-apply' }), 'apply');
  assert.equal(applied.newVersion.versionNumber, 2);
  assert.equal(applied.committedValueDeltaRappen, 0, 'a non-financial change moves no committed value');
});

// --- §H-TENANT ----------------------------------------------------------------------------------

test('a cross-tenant amendment / version id is refused (§H-TENANT)', () => {
  const s = seed('ten');
  const { poId, lineId } = sentPo(s, 'ten', 6, 10000);
  const a = must(call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, idempotencyKey: 'tn-start' }), 'start');
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, changes: [{ op: 'change', poLineId: lineId, qty: 8 }], idempotencyKey: 'tn-upd' }), 'update');
  const applied = must(call(s.deps, 'po_amendment_apply', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, idempotencyKey: 'tn-apply' }), 'apply');

  // A SECOND workspace in the same store cannot see or touch the first's amendment/version.
  const other = mintWorkspace(s.deps, 'Fremd AG', 'i01-ten-other');
  const otherWs = other.workspaceId;
  assert.equal(call(s.deps, 'po_amendment_preview', { workspaceId: otherWs, amendmentId: a.amendment.id }).error, 'not_found');
  assert.equal(call(s.deps, 'po_version_get', { workspaceId: otherWs, versionId: applied.newVersion.id }).error, 'not_found');
  assert.equal(call(s.deps, 'po_amendment_apply', { workspaceId: otherWs, amendmentId: a.amendment.id, idempotencyKey: 'tn-x' }).error, 'not_found');
});

// --- provenance drill-back ----------------------------------------------------------------------

test('requisition_convert_to_po stamps source_document_type/id; a directly-created PO carries null', () => {
  const s = seed('prov');
  // A directly-created PO has no source document.
  const direct = must(call(s.deps, 'po_upsert', { workspaceId: s.workspaceId, supplierContactId: s.vendor, lines: [{ itemId: s.item, qty: 2, unitPriceRappen: 5000 }], idempotencyKey: 'pr-direct' }), 'direct po');
  const directGet = call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId: direct.poId });
  assert.equal(directGet.po.sourceDocumentType, null);
  assert.equal(directGet.po.sourceDocumentId, null);

  // A requisition converted to a PO stamps the provenance pair for real drill-back.
  const req = must(call(s.deps, 'requisition_upsert', { workspaceId: s.workspaceId, neededBy: '2026-09-01', urgency: 'normal', description: 'Nachschub', lines: [{ itemId: s.item, description: 'Rohstoff', qtyMilli: 5000, estimatedUnitCostRappen: 9000, preferredSupplierId: s.vendor }], idempotencyKey: 'pr-req' }), 'req upsert').requisition;
  must(call(s.deps, 'requisition_submit', { workspaceId: s.workspaceId, requisitionId: req.id, idempotencyKey: 'pr-sub' }), 'submit');
  must(call(s.deps, 'requisition_approve', { workspaceId: s.workspaceId, requisitionId: req.id, idempotencyKey: 'pr-appr' }), 'approve');
  const conv = must(call(s.deps, 'requisition_convert_to_po', { workspaceId: s.workspaceId, requisitionId: req.id, lines: [{ lineId: req.lines[0].id, qtyMilli: 5000 }], supplierContactId: s.vendor, idempotencyKey: 'pr-conv' }), 'convert');
  const convGet = call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId: conv.purchaseOrderId });
  assert.equal(convGet.po.sourceDocumentType, 'requisition');
  assert.equal(convGet.po.sourceDocumentId, req.id, 'the PO drills straight back to its requisition');
});

// --- cancel / reject leave the live PO untouched ------------------------------------------------

test('cancel and reject leave the live PO untouched; an applied amendment cannot be cancelled', () => {
  const s = seed('cxl');
  const { poId, lineId } = sentPo(s, 'cxl', 6, 10000);

  // Cancel a draft: live PO untouched, a new amendment may then start.
  const a1 = must(call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, idempotencyKey: 'cx-s1' }), 'start');
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a1.amendment.id, changes: [{ op: 'change', poLineId: lineId, qty: 20 }], idempotencyKey: 'cx-u1' }), 'update');
  const cancelled = must(call(s.deps, 'po_amendment_cancel', { workspaceId: s.workspaceId, amendmentId: a1.amendment.id, reason: 'Vertippt', idempotencyKey: 'cx-c1' }), 'cancel');
  assert.equal(cancelled.amendment.status, 'cancelled');
  assert.equal(call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId }).lines[0].qty, 6, 'cancel touches no live line');
  assert.equal(count(s.deps, 'po_version', s.workspaceId), 1, 'cancel mints no version');

  // Reject a submitted amendment.
  const a2 = must(call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, idempotencyKey: 'cx-s2' }), 'start 2');
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a2.amendment.id, changes: [{ op: 'change', poLineId: lineId, qty: 12 }], idempotencyKey: 'cx-u2' }), 'update 2');
  must(call(s.deps, 'po_amendment_submit', { workspaceId: s.workspaceId, amendmentId: a2.amendment.id, idempotencyKey: 'cx-sub2' }), 'submit 2');
  const missingReason = call(s.deps, 'po_amendment_reject', { workspaceId: s.workspaceId, amendmentId: a2.amendment.id, idempotencyKey: 'cx-r2a' });
  assert.equal(missingReason.error, 'invalid_input', 'reject requires a reason');
  const rejected = must(call(s.deps, 'po_amendment_reject', { workspaceId: s.workspaceId, amendmentId: a2.amendment.id, reason: 'Zu teuer', idempotencyKey: 'cx-r2' }), 'reject');
  assert.equal(rejected.amendment.status, 'rejected');
  assert.equal(call(s.deps, 'po_get', { workspaceId: s.workspaceId, poId }).lines[0].qty, 6, 'reject touches no live line');

  // Apply a third amendment, then prove an applied amendment cannot be cancelled.
  const a3 = must(call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, idempotencyKey: 'cx-s3' }), 'start 3');
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a3.amendment.id, changes: [{ op: 'change', poLineId: lineId, qty: 7 }], idempotencyKey: 'cx-u3' }), 'update 3');
  must(call(s.deps, 'po_amendment_apply', { workspaceId: s.workspaceId, amendmentId: a3.amendment.id, idempotencyKey: 'cx-a3' }), 'apply 3');
  const tooLate = call(s.deps, 'po_amendment_cancel', { workspaceId: s.workspaceId, amendmentId: a3.amendment.id, idempotencyKey: 'cx-c3' });
  assert.equal(tooLate.ok, false);
  assert.equal(tooLate.error, 'invalid_transition');
});

// --- version diff -------------------------------------------------------------------------------

test('version_diff reports the exact line-level change between two versions', () => {
  const s = seed('diff');
  const { poId, lineId } = sentPo(s, 'diff', 6, 10000);
  const v1 = must(call(s.deps, 'po_version_list', { workspaceId: s.workspaceId, poId }), 'list').versions[0].id;
  const a = must(call(s.deps, 'po_amendment_start', { workspaceId: s.workspaceId, poId, idempotencyKey: 'df-start' }), 'start');
  must(call(s.deps, 'po_amendment_update_lines', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, changes: [{ op: 'change', poLineId: lineId, qty: 11 }], idempotencyKey: 'df-upd' }), 'update');
  const applied = must(call(s.deps, 'po_amendment_apply', { workspaceId: s.workspaceId, amendmentId: a.amendment.id, idempotencyKey: 'df-apply' }), 'apply');
  const diff = must(call(s.deps, 'po_version_diff', { workspaceId: s.workspaceId, fromVersionId: v1, toVersionId: applied.newVersion.id }), 'diff');
  assert.equal(diff.fromVersion, 1);
  assert.equal(diff.toVersion, 2);
  const lineChange = diff.lineChanges.find((l) => l.poLineId === lineId);
  assert.equal(lineChange.op, 'changed');
  const qtyChange = lineChange.changes.find((c) => c.field === 'qty');
  assert.equal(qtyChange.from, 6);
  assert.equal(qtyChange.to, 11);
});
