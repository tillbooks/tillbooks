/**
 * I01 (Advanced Purchase Order) OP14: the ten versioning + amendment verbs (six writes, four reads),
 * defined here and spread into `ACTIONS` as ONE line (the `purchaseOrderActions` / `requisitionActions`
 * precedent), so several agents appending to the append-only registry at once collide over a line
 * rather than a block.
 *
 * NEW FILE, DISJOINT from D02's `purchase-order-actions.ts`: I01 LAYERS OP14 versioning over the live
 * D02 purchase order without touching D02's public verbs. Every verb is a thin adapter over
 * `core/purchase`'s I01 engine (`poVersion.ts` / `poAmendment.ts`), which opens NO posting path (P3)
 * and re-renders the P8 outbound artifact on apply (transmitted:false) exactly as D02 `po_send` does.
 *
 * NO verb here holds an `ActionInvoker`: the engine reaches D02's tables and A19 DIRECTLY, never back
 * through the dispatch, so there is no capability to launder. The helpers arrive as a parameter, so the
 * module graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { poVersionList, poVersionGet, poVersionDiff } from '../core/purchase/poVersion.js';
import {
  poAmendmentStart,
  poAmendmentUpdateLines,
  poAmendmentPreview,
  poAmendmentSubmit,
  poAmendmentApply,
  poAmendmentCancel,
  poAmendmentReject,
} from '../core/purchase/poAmendment.js';

export interface PoAmendmentActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The I01 version + amendment verbs, in append order. */
export function poAmendmentActions(h: PoAmendmentActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;

  // One amendment change operation: `change` edits a live line's qty/price/description (a NULL field
  // keeps the live value), `add` inserts a new line (item or free text), `remove` drops an open line.
  const AMENDMENT_CHANGES = {
    type: 'array',
    items: {
      type: 'object',
      properties: { op: STR, poLineId: STR, itemId: STR, qty: INT, unitPriceRappen: INT, description: STR, taxCode: STR },
      required: ['op'],
    },
  } as const;

  return [
    ctxAction(
      'po_version_list',
      'read',
      'Liste die Versionshistorie einer Bestellung (OP14, P5): the ordered version trail (1..N) of a purchase order, each row carrying its number, status (active | superseded), the amendment reason that produced it, actor, timestamp and the frozen sent artifact. Materialises version 1 on first touch, so a legacy D02 PO created before I01 shows a complete history. An empty PO id is refused (not_found).',
      ctxSchema({ poId: STR }, ['poId']),
      (ctx, input) => poVersionList(ctx, as(input)),
    ),
    ctxAction(
      'po_version_get',
      'read',
      'Lies eine einzelne, eingefrorene PO-Version (OP14, P5): the full immutable snapshot (header + lines) of ONE version, exactly as it stood when that version became active. The Treuhänder-Rekonstruktion of the commitment at a point in time (OR 957a). A version id from another workspace is refused (not_found, §H-TENANT).',
      ctxSchema({ versionId: STR }, ['versionId']),
      (ctx, input) => poVersionGet(ctx, as(input)),
    ),
    ctxAction(
      'po_version_diff',
      'read',
      'Vergleiche zwei Versionen derselben Bestellung (OP14, P5): the exact header- and line-level changes (qty, price, description, added, removed, tax) between two versions, in a structured form for GUI and agents. Pure. Two versions of DIFFERENT purchase orders are refused (invalid_reference); an unknown version id is not_found.',
      ctxSchema({ fromVersionId: STR, toVersionId: STR }, ['fromVersionId', 'toVersionId']),
      (ctx, input) => poVersionDiff(ctx, as(input)),
    ),
    ctxAction(
      'po_amendment_start',
      'write',
      'Beginne eine Änderung an einer gesendeten oder teilweise erhaltenen Bestellung (OP14): opens a DRAFT amendment linked to the current active version. No live PO data is mutated yet. Materialises version 1 first if needed (US-I01.1). A PO that is draft/closed/cancelled is refused (invalid_transition); a PO with no open quantity left is nothing_open; a second amendment while one is already draft/pending_approval is amendment_in_progress (one open amendment per PO). Off the money path (P3); idempotent.',
      ctxSchema({ poId: STR, reason: STR, actor: STR, idempotencyKey: STR }, ['poId']),
      (ctx, input) => poAmendmentStart(ctx, as(input)),
    ),
    ctxAction(
      'po_amendment_update_lines',
      'write',
      'Setze die Änderungspositionen einer Entwurfs-Änderung (OP14): replaces the amendment`s set of change operations. Each op is change (edit a live line`s qty/unitPriceRappen/description; a field left out keeps the live value), add (a new line: itemId or free-text description, qty > 0, unitPriceRappen >= 0), or remove (drop an open line). Only a DRAFT amendment is editable (invalid_transition otherwise). A poLineId that is not a live line of this PO is not_found; an unknown itemId is invalid_reference; qty <= 0 is invalid_qty. Validated as a batch: a refusal writes zero rows.',
      ctxSchema({ amendmentId: STR, changes: AMENDMENT_CHANGES, actor: STR, idempotencyKey: STR }, ['amendmentId']),
      (ctx, input) => poAmendmentUpdateLines(ctx, as(input)),
    ),
    ctxAction(
      'po_amendment_preview',
      'read',
      'Zeige die Auswirkung einer Änderung, bevor sie angewandt wird (OP14, P5, pure): per-line before/after qty and unit price, the committed-value delta in Rappen, and the violation list (qty_below_received when a line would fall below its received quantity, line_has_receipts when a received line would be removed). Nothing is written. The same impact the apply enforces, so preview and apply never disagree.',
      ctxSchema({ amendmentId: STR }, ['amendmentId']),
      (ctx, input) => poAmendmentPreview(ctx, as(input)),
    ),
    ctxAction(
      'po_amendment_submit',
      'write',
      'Reiche eine Änderung zur Genehmigung ein (OP14, draft -> pending_approval): for a workspace that gates material amendments before they become the live commitment. Requires a valid, effective impact (a zero-delta amendment is no_effective_change; a blocking violation is returned by its code). Only a DRAFT amendment can be submitted (invalid_transition). Idempotent.',
      ctxSchema({ amendmentId: STR, actor: STR, idempotencyKey: STR }, ['amendmentId']),
      (ctx, input) => poAmendmentSubmit(ctx, as(input)),
    ),
    ctxAction(
      'po_amendment_apply',
      'write',
      'Wende eine Änderung an und erzeuge die nächste PO-Version (OP14): supersedes the current active version, updates the live purchase_order + po_line to the amended values (received_qty and billed_qty on surviving lines are NEVER touched), mints version N+1 (active) with the frozen snapshot, and RE-RENDERS the outbound PO artifact carrying the new revision. P8: it returns { transmitted:false } and never emails the supplier on its own; an amended commitment reaches the supplier only through the approval dial. Applies from draft or pending_approval. Refuses qty_below_received / line_has_receipts / no_effective_change (a refusal writes zero rows). Idempotent on ROWS: a replay under the same idempotencyKey creates NO second version.',
      ctxSchema({ amendmentId: STR, actor: STR, idempotencyKey: STR }, ['amendmentId']),
      (ctx, input) => poAmendmentApply(ctx, as(input)),
    ),
    ctxAction(
      'po_amendment_cancel',
      'write',
      'Verwirf eine Entwurfs- oder eingereichte Änderung (OP14): status -> cancelled, the live PO untouched, and a new amendment may then be started. An already-applied amendment cannot be cancelled (invalid_transition); a further corrective amendment is required. Idempotent.',
      ctxSchema({ amendmentId: STR, reason: STR, actor: STR, idempotencyKey: STR }, ['amendmentId']),
      (ctx, input) => poAmendmentCancel(ctx, as(input)),
    ),
    ctxAction(
      'po_amendment_reject',
      'write',
      'Lehne eine Änderung als Genehmiger ab (OP14): status -> rejected with a mandatory reason, the live PO untouched. Allowed from draft or pending_approval; an applied amendment cannot be rejected (invalid_transition). A missing reason is invalid_input. Idempotent.',
      ctxSchema({ amendmentId: STR, reason: STR, actor: STR, idempotencyKey: STR }, ['amendmentId', 'reason']),
      (ctx, input) => poAmendmentReject(ctx, as(input)),
    ),
  ];
}
