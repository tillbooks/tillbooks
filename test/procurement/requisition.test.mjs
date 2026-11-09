// I00, requisitions: the engine invariants I01 and the procure-to-pay chain depend on.
//
// Proves every §2/§7 rule: draft create with exact integer estimated totals, the validation set
// (empty lines, zero qty, negative amount, missing free-text description, bad urgency, unknown
// references), the full state machine (submit -> pending/auto-approve, approve/reject/return,
// partial + full convert, cancel, close), the open-quantity invariant (converted never exceeds
// requested), conversion into a REAL D02 purchase order with an immutable link, §H-TENANT on every
// read/write, idempotency on ROWS (a double submit/convert never doubles events or POs), and the
// pure policy evaluator. I00 has NO posting path (P3 by absence): estimated costs are operational.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createCostCenter } from '../../dist/core/accounts/index.js';
import { createContact, createItem } from '../../dist/core/sales/index.js';
import {
  evaluateApprovalPolicy,
  requisitionUpsert,
  requisitionSubmit,
  requisitionApprove,
  requisitionReject,
  requisitionReturn,
  requisitionConvertToPo,
  requisitionCancel,
  requisitionClose,
  requisitionGet,
  requisitionList,
  requisitionMyPendingApprovals,
} from '../../dist/core/procurement/index.js';

const AT = '2026-08-07T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  const vendor = createContact(ctx, { partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: 'v1' }).contact.id;
  const item = createItem(ctx, { name: 'Rohstoff', defaultUnitPriceMinor: 12000, idempotencyKey: 'i1' }).item.id;
  const count = (table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId).n;
  return { ctx, store, workspaceId, deps, vendor, item, count };
}

/** A valid single-line draft (2 units of a free-text line at CHF 50.00 each = 10000 Rappen). */
function draftInput(over = {}, key = 'r-seed') {
  return {
    neededBy: '2026-09-01',
    urgency: 'normal',
    description: 'Werkstattbedarf',
    lines: [{ description: 'Schmiermittel', qtyMilli: 2000, estimatedUnitCostRappen: 5000 }],
    idempotencyKey: key,
    ...over,
  };
}

// --- happy create + exact integer totals (US-I00.1) --------------------------------------------

test('upsert creates a numbered draft with the exact integer estimated total', () => {
  const { ctx } = setup();
  const created = requisitionUpsert(ctx, draftInput());
  assert.equal(created.ok, true);
  assert.equal(created.requisition.status, 'draft');
  assert.match(created.requisition.number, /^REQ-2026-0001$/);
  // trunc(2000 * 5000 / 1000) = 10000 Rappen.
  assert.equal(created.requisition.lines[0].estimatedTotalRappen, 10000);
  assert.equal(created.requisition.totalEstimatedRappen, 10000);
  assert.equal(created.requisition.lines[0].openQtyMilli, 2000);
});

test('the header total is the exact sum of line totals, no float drift', () => {
  const { ctx } = setup();
  const created = requisitionUpsert(
    ctx,
    draftInput({
      lines: [
        { description: 'A', qtyMilli: 3000, estimatedUnitCostRappen: 333 }, // trunc(999.999)=999
        { description: 'B', qtyMilli: 1000, estimatedUnitCostRappen: 1 }, // 1
      ],
    }),
  );
  assert.equal(created.requisition.lines[0].estimatedTotalRappen, 999);
  assert.equal(created.requisition.lines[1].estimatedTotalRappen, 1);
  assert.equal(created.requisition.totalEstimatedRappen, 1000);
});

// --- validation set (US-I00.7) -----------------------------------------------------------------

test('validation refuses empty lines, zero qty, negative amount, missing description, bad urgency, unknown refs', () => {
  const { ctx, item } = setup();
  assert.equal(requisitionUpsert(ctx, draftInput({ lines: [] }, 'e1')).error, 'invalid_line');
  assert.equal(
    requisitionUpsert(ctx, draftInput({ lines: [{ description: 'x', qtyMilli: 0, estimatedUnitCostRappen: 1 }] }, 'e2')).error,
    'invalid_qty',
  );
  assert.equal(
    requisitionUpsert(ctx, draftInput({ lines: [{ description: 'x', qtyMilli: 1000, estimatedUnitCostRappen: -5 }] }, 'e3')).error,
    'invalid_amount',
  );
  // Free-text line (no item) with no description.
  assert.equal(
    requisitionUpsert(ctx, draftInput({ lines: [{ qtyMilli: 1000, estimatedUnitCostRappen: 1 }] }, 'e4')).error,
    'description_required',
  );
  assert.equal(requisitionUpsert(ctx, draftInput({ urgency: 'urgent' }, 'e5')).error, 'invalid_urgency');
  assert.equal(
    requisitionUpsert(ctx, draftInput({ lines: [{ itemId: 'nope', description: 'x', qtyMilli: 1000, estimatedUnitCostRappen: 1 }] }, 'e6'))
      .error,
    'invalid_reference',
  );
  // An item line inherits the item as a valid reference.
  const okItem = requisitionUpsert(ctx, draftInput({ lines: [{ itemId: item, description: 'Rohstoff', qtyMilli: 1000, estimatedUnitCostRappen: 100 }] }, 'e7'));
  assert.equal(okItem.ok, true);
});

// --- submit policy: pending vs auto-approve (US-I00.2) -----------------------------------------

test('submit of a positive estimate goes pending_approval with an open task and a submitted event', () => {
  const { ctx, count } = setup();
  const r = requisitionUpsert(ctx, draftInput()).requisition;
  const submitted = requisitionSubmit(ctx, { requisitionId: r.id, idempotencyKey: 's1' });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.requisition.status, 'pending_approval');
  assert.equal(submitted.requisition.openTasks.length, 1);
  assert.equal(submitted.requisition.approvalEvents.some((e) => e.decision === 'submitted'), true);
  assert.equal(count('requisition_approval_task'), 1);
});

test('submit of a zero estimate auto-approves with an auto_approved event and no open task', () => {
  const { ctx } = setup();
  const r = requisitionUpsert(ctx, draftInput({ lines: [{ description: 'Freebie', qtyMilli: 1000, estimatedUnitCostRappen: 0 }] })).requisition;
  const submitted = requisitionSubmit(ctx, { requisitionId: r.id, idempotencyKey: 's2' });
  assert.equal(submitted.requisition.status, 'approved');
  assert.equal(submitted.requisition.openTasks.length, 0);
  assert.equal(submitted.requisition.approvalEvents.some((e) => e.decision === 'auto_approved'), true);
});

test('submit is refused for a non-draft (invalid_transition)', () => {
  const { ctx } = setup();
  const r = requisitionUpsert(ctx, draftInput()).requisition;
  requisitionSubmit(ctx, { requisitionId: r.id, idempotencyKey: 's3' });
  const again = requisitionSubmit(ctx, { requisitionId: r.id, idempotencyKey: 's4' });
  assert.equal(again.error, 'invalid_transition');
});

// --- approve / reject / return (US-I00.3) ------------------------------------------------------

test('approve completes the task and moves the requisition to approved', () => {
  const { ctx } = setup();
  const r = requisitionUpsert(ctx, draftInput()).requisition;
  requisitionSubmit(ctx, { requisitionId: r.id, idempotencyKey: 's5' });
  const approved = requisitionApprove(ctx, { requisitionId: r.id, idempotencyKey: 'a1' });
  assert.equal(approved.requisition.status, 'approved');
  assert.equal(approved.requisition.openTasks.length, 0);
  assert.equal(approved.requisition.approvalEvents.some((e) => e.decision === 'approved'), true);
});

test('reject requires a reason and is terminal; return sends it back to draft, re-submittable', () => {
  const { ctx } = setup();
  const r = requisitionUpsert(ctx, draftInput()).requisition;
  requisitionSubmit(ctx, { requisitionId: r.id, idempotencyKey: 's6' });
  assert.equal(requisitionReject(ctx, { requisitionId: r.id, idempotencyKey: 'x1' }).error, 'reason_required');
  const rejected = requisitionReject(ctx, { requisitionId: r.id, reason: 'over budget', idempotencyKey: 'rj1' });
  assert.equal(rejected.requisition.status, 'rejected');

  const r2 = requisitionUpsert(ctx, draftInput({}, 'r2')).requisition;
  requisitionSubmit(ctx, { requisitionId: r2.id, idempotencyKey: 's7' });
  const returned = requisitionReturn(ctx, { requisitionId: r2.id, reason: 'add a supplier', idempotencyKey: 'rt1' });
  assert.equal(returned.requisition.status, 'draft');
  // A fresh cycle: prior events remain queryable.
  assert.equal(returned.requisition.approvalEvents.some((e) => e.decision === 'returned'), true);
  const resubmit = requisitionSubmit(ctx, { requisitionId: r2.id, idempotencyKey: 's8' });
  assert.equal(resubmit.requisition.status, 'pending_approval');
});

// --- convert to PO (US-I00.4) ------------------------------------------------------------------

function approvedTwoLine(ctx, vendor, key = 'cv') {
  const r = requisitionUpsert(
    ctx,
    draftInput(
      {
        lines: [
          { description: 'Position A', qtyMilli: 4000, estimatedUnitCostRappen: 2500, preferredSupplierId: vendor },
          { description: 'Position B', qtyMilli: 2000, estimatedUnitCostRappen: 1000, preferredSupplierId: vendor },
        ],
      },
      `${key}-up`,
    ),
  ).requisition;
  requisitionSubmit(ctx, { requisitionId: r.id, idempotencyKey: `${key}-sub` });
  requisitionApprove(ctx, { requisitionId: r.id, idempotencyKey: `${key}-app` });
  return requisitionGet(ctx, { requisitionId: r.id }).requisition;
}

test('a full convert creates a real D02 PO, links it, and moves the requisition to converted', () => {
  const { ctx, vendor, store, workspaceId, count } = setup();
  const r = approvedTwoLine(ctx, vendor);
  const conv = requisitionConvertToPo(ctx, {
    requisitionId: r.id,
    lines: r.lines.map((l) => ({ lineId: l.id, qtyMilli: l.qtyMilli })),
    idempotencyKey: 'c1',
  });
  assert.equal(conv.ok, true);
  assert.equal(conv.requisition.status, 'converted');
  // A real purchase_order row exists and carries the two lines.
  const po = store.db.prepare('SELECT * FROM purchase_order WHERE workspace_id = ? AND id = ?').get(workspaceId, conv.purchaseOrderId);
  assert.ok(po, 'the D02 purchase order row exists');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM po_line WHERE workspace_id = ? AND po_id = ?').get(workspaceId, conv.purchaseOrderId).n, 2);
  // The immutable conversion link.
  assert.equal(count('requisition_conversion'), 1);
  assert.equal(conv.requisition.conversions[0].purchaseOrderId, conv.purchaseOrderId);
  // Every line fully converted, zero open.
  assert.equal(conv.requisition.lines.every((l) => l.openQtyMilli === 0), true);
});

test('a partial convert leaves partially_converted with the correct open quantity', () => {
  const { ctx, vendor } = setup();
  const r = approvedTwoLine(ctx, vendor, 'cp');
  const lineA = r.lines[0];
  const conv = requisitionConvertToPo(ctx, {
    requisitionId: r.id,
    lines: [{ lineId: lineA.id, qtyMilli: 1000 }], // 1 of 4 units
    idempotencyKey: 'cp1',
  });
  assert.equal(conv.requisition.status, 'partially_converted');
  const freshA = conv.requisition.lines.find((l) => l.id === lineA.id);
  assert.equal(freshA.convertedQtyMilli, 1000);
  assert.equal(freshA.openQtyMilli, 3000);
});

test('over-conversion and non-whole-unit quantities are refused, and a mixed selection needs a supplier', () => {
  const { ctx, vendor } = setup();
  const r = approvedTwoLine(ctx, vendor, 'co');
  const lineA = r.lines[0];
  assert.equal(
    requisitionConvertToPo(ctx, { requisitionId: r.id, lines: [{ lineId: lineA.id, qtyMilli: 9000 }], idempotencyKey: 'co1' }).error,
    'over_conversion',
  );
  // 1500 milli is 1.5 units, not a whole-unit multiple.
  assert.equal(
    requisitionConvertToPo(ctx, { requisitionId: r.id, lines: [{ lineId: lineA.id, qtyMilli: 1500 }], idempotencyKey: 'co2' }).error,
    'invalid_qty',
  );

  // A line with no preferred supplier and no override cannot resolve a PO supplier.
  const noSup = requisitionUpsert(ctx, draftInput({ lines: [{ description: 'X', qtyMilli: 1000, estimatedUnitCostRappen: 100 }] }, 'ns-up')).requisition;
  requisitionSubmit(ctx, { requisitionId: noSup.id, idempotencyKey: 'ns-sub' });
  requisitionApprove(ctx, { requisitionId: noSup.id, idempotencyKey: 'ns-app' });
  const got = requisitionGet(ctx, { requisitionId: noSup.id }).requisition;
  assert.equal(
    requisitionConvertToPo(ctx, { requisitionId: noSup.id, lines: [{ lineId: got.lines[0].id, qtyMilli: 1000 }], idempotencyKey: 'ns1' }).error,
    'missing_supplier',
  );
});

test('convert of a non-approved requisition is invalid_transition', () => {
  const { ctx, vendor } = setup();
  const r = requisitionUpsert(ctx, draftInput({ lines: [{ description: 'X', qtyMilli: 1000, estimatedUnitCostRappen: 100, preferredSupplierId: vendor }] })).requisition;
  const got = requisitionGet(ctx, { requisitionId: r.id }).requisition;
  assert.equal(
    requisitionConvertToPo(ctx, { requisitionId: r.id, lines: [{ lineId: got.lines[0].id, qtyMilli: 1000 }], idempotencyKey: 'nt1' }).error,
    'invalid_transition',
  );
});

// --- cancel / close (US-I00.5) -----------------------------------------------------------------

test('cancel works on a draft, and after any conversion it is refused with has_conversions', () => {
  const { ctx, vendor } = setup();
  const draft = requisitionUpsert(ctx, draftInput({}, 'cn')).requisition;
  assert.equal(requisitionCancel(ctx, { requisitionId: draft.id, idempotencyKey: 'cn1' }).requisition.status, 'cancelled');

  const r = approvedTwoLine(ctx, vendor, 'cc');
  requisitionConvertToPo(ctx, { requisitionId: r.id, lines: [{ lineId: r.lines[0].id, qtyMilli: 1000 }], idempotencyKey: 'cc-conv' });
  assert.equal(requisitionCancel(ctx, { requisitionId: r.id, idempotencyKey: 'cc1' }).error, 'has_conversions');
  // Close instead.
  assert.equal(requisitionClose(ctx, { requisitionId: r.id, idempotencyKey: 'cc2' }).requisition.status, 'closed');
});

// --- idempotency on ROWS (§H-IDEMPOTENT) -------------------------------------------------------

test('a double upsert / submit / convert under one key never doubles rows', () => {
  const { ctx, vendor, count, store, workspaceId } = setup();
  // upsert
  const a = requisitionUpsert(ctx, draftInput({}, 'idem'));
  const b = requisitionUpsert(ctx, draftInput({}, 'idem'));
  assert.equal(a.requisition.id, b.requisition.id);
  assert.equal(count('requisition'), 1);

  // submit
  const r = approvedTwoLine(ctx, vendor, 'id2');
  const c1 = requisitionConvertToPo(ctx, { requisitionId: r.id, lines: [{ lineId: r.lines[0].id, qtyMilli: 1000 }], idempotencyKey: 'idc' });
  const c2 = requisitionConvertToPo(ctx, { requisitionId: r.id, lines: [{ lineId: r.lines[0].id, qtyMilli: 1000 }], idempotencyKey: 'idc' });
  assert.equal(c1.purchaseOrderId, c2.purchaseOrderId, 'a replayed convert returns the SAME PO');
  // Exactly ONE PO and ONE conversion for that key, and converted qty advanced once (1000, not 2000).
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM purchase_order WHERE workspace_id = ?').get(workspaceId).n, 1);
  assert.equal(count('requisition_conversion'), 1);
  const line = requisitionGet(ctx, { requisitionId: r.id }).requisition.lines.find((l) => l.id === r.lines[0].id);
  assert.equal(line.convertedQtyMilli, 1000);
});

// --- §H-TENANT ---------------------------------------------------------------------------------

test('a requisition is invisible to another workspace (get + list)', () => {
  const { ctx, store, deps } = setup();
  const r = requisitionUpsert(ctx, draftInput()).requisition;
  const otherWs = createWorkspace(deps, { name: 'Other AG', idempotencyKey: 'ws2' }).workspaceId;
  const otherCtx = makeContext(store, { workspaceId: otherWs, actor: 'user_2', clock: deps.clock, ids: deps.ids });
  assert.equal(requisitionGet(otherCtx, { requisitionId: r.id }).error, 'not_found');
  assert.equal(requisitionList(otherCtx, {}).requisitions.length, 0);
});

// --- reads: list filters + my pending approvals ------------------------------------------------

test('list filters by status and my_pending_approvals surfaces the open task', () => {
  const { ctx } = setup();
  const draft = requisitionUpsert(ctx, draftInput({}, 'l1')).requisition;
  const pending = requisitionUpsert(ctx, draftInput({}, 'l2')).requisition;
  requisitionSubmit(ctx, { requisitionId: pending.id, idempotencyKey: 'l2s' });

  assert.equal(requisitionList(ctx, { status: 'draft' }).requisitions.length, 1);
  assert.equal(requisitionList(ctx, { status: ['draft', 'pending_approval'] }).requisitions.length, 2);
  assert.equal(requisitionList(ctx, { requesterId: 'user_1' }).requisitions.length, 2);

  const inbox = requisitionMyPendingApprovals(ctx, {});
  assert.equal(inbox.tasks.length, 1);
  assert.equal(inbox.tasks[0].requisitionId, pending.id);
  assert.equal(inbox.tasks[0].number, pending.number);
  // The cancelled draft is not in a status filter for pending, and never had a task.
  assert.equal(requisitionList(ctx, { q: draft.number }).requisitions.length, 1);
});

// --- the pure policy evaluator (§7 invariant 7) ------------------------------------------------

test('evaluateApprovalPolicy is pure and deterministic', () => {
  assert.deepEqual(evaluateApprovalPolicy({ amountRappen: 0 }), { decision: 'auto_approve', steps: [] });
  const a = evaluateApprovalPolicy({ amountRappen: 5000 });
  const b = evaluateApprovalPolicy({ amountRappen: 5000 });
  assert.equal(a.decision, 'require_approval');
  assert.equal(a.steps.length, 1);
  assert.deepEqual(a, b);
});
