/**
 * A16, the Debitoren verb surface: "welche Rechnungen sind offen?" answered the same way for both faces.
 *
 * Five tools, four of them read models and one write. The write is the aging bucket configuration and
 * nothing else: A16 posts nothing, settles nothing, and sends nothing. The Mahnen action a caller
 * will reach for from this list is deliberately ABSENT here, because it is A15's write verb
 * (`propose_dunning_run`) and duplicating it would be a second dunning path (§5, P8). Recording a
 * payment against an open item is likewise A14's `record_payment`.
 *
 * ONE VOCABULARY across both faces, the rule A14 established. The Studio's word for this surface is
 * **Offene Posten** and the list itself is the **OP-Liste**; a parked customer credit is a
 * **Guthaben**, never "on-account"; the reconciliation target is **1100 Debitoren** by its
 * Kontenrahmen KMU number, never "the receivables account". A tool description is the only thing an
 * agent has to pick a verb with, so it speaks the product's own language.
 *
 * EVERY READ REPORTS ITS OWN RECONCILIATION. `reconciled` is on the response rather than assumed,
 * so an agent that reads this list can tell the human whether the figure it just quoted ties to the
 * ledger. That is the difference between a receivables answer and a plausible one.
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX and A14 both established:
 * the registry is one append-only tool list that several capability branches append to at once, so
 * the smaller the hunk, the cheaper the merge. The helpers arrive as a parameter to keep the module
 * graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  listOpenItems,
  customerBalance,
  agingReport,
  getAgingBucketConfig,
  setAgingBucketConfig,
} from '../core/debtors/index.js';

export interface DebtorActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

export function debtorActions(h: DebtorActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;

  /** The bucket boundaries: a list of day counts, strictly increasing, all positive. */
  const BOUNDARIES = { type: 'array', items: { type: 'integer' } } as const;

  return [
    ctxAction(
      'list_open_items',
      'read',
      `The OP-Liste: every unpaid or partly-paid invoice with its open amount, due date, days overdue and aging bucket, plus every parked customer payment. A parked payment carries its direction: incoming is a Guthaben the customer holds and reads NEGATIVE, outgoing is a refund not yet matched and reads POSITIVE. Reports bucket subtotals in the invoice currency (bucketTotals) and in base currency (baseBucketTotals, the only one that is an amount when several currencies are open), the grand total both ways, and whether the base total reconciles to account 1100 Debitoren as of the same date. Pass asOf to see the receivables exactly as they stood on a past cut-off (payments after it are ignored). Filter by customerId or currency to narrow the table without changing what reconciled means. Reads only.`,
      ctxSchema({ asOf: STR, customerId: STR, currency: STR }),
      (ctx, input) => listOpenItems(ctx, input as never),
    ),
    ctxAction(
      'customer_balance',
      'read',
      `What one customer owes: their total open amount, the split across aging buckets in both the invoice currency and base currency, how many days their oldest overdue item has been outstanding, and any parked payment attached to them. onAccountMinor is reported positive for a Guthaben, so it comes out negative when what is parked is an unmatched refund: read the direction on the row rather than the sign of the total. An unknown customer reads as an empty balance rather than an error. Reads only.`,
      ctxSchema({ customerId: STR, asOf: STR }, ['customerId']),
      (ctx, input) => customerBalance(ctx, input as never),
    ),
    ctxAction(
      'aging_report',
      'read',
      `The receivables summary behind the aging bar: the same open items list_open_items itemises, totalled per bucket and per customer, largest debtor first. byBucket is the invoice-currency sum and baseByBucket the base-currency one, which is the figure that ties to baseTotalOpenMinor in a workspace holding more than one currency. Use it to answer "how much is over 90 days overdue and who owes it" in one call. Carries the same reconciliation flag against 1100 Debitoren. Reads only.`,
      ctxSchema({ asOf: STR }),
      (ctx, input) => agingReport(ctx, input as never),
    ),
    ctxAction(
      'get_aging_bucket_config',
      'read',
      `The day thresholds the aging buckets cut at, and whether this workspace chose them or is on the shipped default of 30/60/90 days. Also returns the bucket keys those boundaries produce. Reads only.`,
      ctxSchema(),
      (ctx) => getAgingBucketConfig(ctx),
    ),
    ctxAction(
      'set_aging_bucket_config',
      'write',
      `Redefine where the aging buckets cut, as a strictly increasing list of positive day counts (the default [30, 60, 90] gives 0-30, 31-60, 61-90 and 90+). This changes the VIEW only: the buckets re-partition the same receivables total and can never change it, and the reconciliation to 1100 Debitoren holds for any boundary set. It is a DACH reporting convention, not a statutory figure, and it is not a dunning deadline (A15 owns those). A repeat call under the same idempotencyKey writes nothing.`,
      ctxSchema({ boundariesDays: BOUNDARIES, idempotencyKey: STR }, ['boundariesDays', 'idempotencyKey']),
      (ctx, input) => setAgingBucketConfig(ctx, input as never),
    ),
  ];
}
