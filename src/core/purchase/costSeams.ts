/**
 * A17's and D02's registrations into B00's cost-source seam, the rows
 * `src/core/projects/budgetActual.ts` reserved by name (`a17_bills`, `d02_purchases`) when the seam
 * shipped empty. They exist since the project cost dimension landed: `vendor_bill.project_id` and
 * `po_line.project_id` are the tags these queries read.
 *
 * READ-ONLY by the seam's contract: both sources only SELECT. Both answer BASE-currency Rappen
 * (`base_net_minor` is read off the posted entry, `unit_price_base_rappen` is the creation-time
 * §H-FX conversion), which is what the subtree rollup requires. Neither can attribute to a PHASE
 * (bills and PO lines carry a project tag, not a phase tag), so every row buckets `phaseId: null`,
 * exactly what the seam defined for phase-unattributable cost.
 *
 * The derivation mirrors B03's components so B00's budget actual and B03's cost-to-date cannot
 * disagree: posted project bills at base net (B03 `expenses` + `purchases` together: matched or
 * not, a posted bill is booked cost) PLUS the received-not-yet-billed accrual at PO base price
 * (B03 `accrued_purchases`), which drops as the matched bill enters `billed_qty`, so a Franken is
 * never counted twice across the two terms.
 *
 * Registration happens at module load from the barrel, the B01 `seams.ts` shape; the import
 * direction is purchase -> projects, which is acyclic (projects imports nothing from purchase).
 */

import type { WorkspaceContext } from '../context.js';
import { registerCostSource } from '../projects/index.js';
import type { ProjectRow } from '../projects/index.js';

registerCostSource({
  id: 'a17_bills',
  actuals: (ctx: WorkspaceContext, project: ProjectRow) => {
    const row = ctx.store.db
      .prepare(
        `SELECT COALESCE(SUM(base_net_minor), 0) AS total
           FROM vendor_bill
          WHERE workspace_id = ? AND project_id = ? AND status = 'posted'`,
      )
      .get(ctx.workspaceId, project.id) as { total: number };
    if (row.total === 0) return [];
    return [{ phaseId: null, costMinor: row.total, hours: 0 }];
  },
});

registerCostSource({
  id: 'd02_purchases',
  actuals: (ctx: WorkspaceContext, project: ProjectRow) => {
    // The accrual: received-but-not-yet-billed quantity at the PO's own base price. The billed
    // share left this term the moment the 3-way match raised billed_qty, and entered the books as
    // the matched A17 bill the a17_bills source above already counts.
    const row = ctx.store.db
      .prepare(
        `SELECT COALESCE(SUM(MAX(0, l.received_qty - l.billed_qty) * l.unit_price_base_rappen), 0) AS total
           FROM po_line l
           JOIN purchase_order po ON po.id = l.po_id AND po.workspace_id = l.workspace_id
          WHERE l.workspace_id = ? AND l.project_id = ? AND po.status <> 'cancelled'`,
      )
      .get(ctx.workspaceId, project.id) as { total: number };
    if (row.total === 0) return [];
    return [{ phaseId: null, costMinor: row.total, hours: 0 }];
  },
});
