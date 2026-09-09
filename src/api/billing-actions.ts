/**
 * B02's four verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `timeActions` precedent), so several agents appending to the append-only registry at once collide
 * over a line rather than a block.
 *
 * Two writes (`billing_generate_invoice` turns approved unbilled time into an A11 invoice DRAFT and
 * flips the entries to `billed`; `billing_release_time` reverts a cancelled draft's entries to the
 * pile) and two reads (`billing_unbilled_preview`, `billing_wip_report`). Both writes carry
 * `workspaceId` + an idempotency key and gate on A24 `billing.generate`; both reads gate on
 * `billing.read`. B02 POSTS NOTHING: generation delegates to A10 `createDocument` (a draft), and A11
 * -> A02 own the only journal entry, at issue (P3, P8 draft-only output).
 *
 * As with `time-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { unbilledPreview, generateInvoice, releaseLines, wipReport } from '../core/billing/index.js';

export interface BillingActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
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

/** The B02 verbs, in append order. */
export function billingActions(h: BillingActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;

  return [
    ctxAction(
      'billing_unbilled_preview',
      'read',
      'Unverrechnete freigegebene Zeit anzeigen (B02): the approved, billable, not-yet-billed time_entry pile (B01), grouped contact then project then phase, each entry valued round-once (P2) from its snapshotted rate and every subtotal an integer sum. Filter by contactId, projectId, a throughDate cut on started_at, or a groupBy hint. An empty pile is { groups: [], totalRappen: 0 }, a healthy state. B02 invoicing input; gated on the A24 billing.read capability.',
      ctxSchema({ contactId: STR, projectId: STR, throughDate: STR, groupBy: STR }),
      (ctx, input) => unbilledPreview(ctx, as(input)),
    ),
    ctxAction(
      'billing_generate_invoice',
      'write',
      'Rechnungsentwurf aus Zeit erstellen (B02): turns the selected approved+billable+unbilled entries (one contact, one currency) into an A11 invoice DRAFT and flips them approved to billed with invoice_line_id set, in one transaction. Delegates to A10 createDocument (P3: no journal entry, no VAT amount, no total minted here; A11 to A02 post at issue). groupBy (entry|phase|project|day) shapes the lines; each line is qty 1 with the group value as its price, so preview equals line equals WIP to the Rappen. Refuses empty_selection, mixed_contacts, currency_mismatch, already_billed (strict, no partial invoice); idempotent on idempotencyKey. Always stops at a draft (P8); gated on A24 billing.generate.',
      ctxSchema(
        {
          contactId: STR,
          timeEntryIds: { type: 'array', items: STR },
          groupBy: STR,
          throughDate: STR,
          actor: STR,
          idempotencyKey: STR,
        },
        ['contactId', 'timeEntryIds', 'idempotencyKey'],
      ),
      (ctx, input) => generateInvoice(ctx, as(input)),
    ),
    ctxAction(
      'billing_release_time',
      'write',
      'Zeit aus einem Entwurf freigeben (B02): reverts the entries backing a DRAFT invoice (by invoiceId or lineIds) from billed to approved and clears invoice_line_id, returning them to the unbilled pile and WIP. Called by A11 cancel and directly. Refuses a finalised invoice with invoice_not_draft (corrections there are A11 credit notes); releasing already-released lines is a no-op (idempotent). Gated on A24 billing.generate.',
      ctxSchema(
        { invoiceId: STR, lineIds: { type: 'array', items: STR }, actor: STR, idempotencyKey: STR },
        ['idempotencyKey'],
      ),
      (ctx, input) => releaseLines(ctx, as(input)),
    ),
    ctxAction(
      'billing_wip_report',
      'read',
      'WIP-Bericht der angefangenen Arbeiten (B02): approved-but-unbilled value as of a date, per project and its client, purely (P5). wipRappen is the integer sum of round-once entry values, plus minutes and the oldest entry age. Informational only: B02 never posts the OR 960c entry, a Treuhänder posts it manually from these numbers. Gated on A24 billing.read.',
      ctxSchema({ asOf: STR, projectId: STR, contactId: STR }),
      (ctx, input) => wipReport(ctx, as(input)),
    ),
  ];
}
