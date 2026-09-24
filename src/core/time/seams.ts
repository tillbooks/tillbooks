/**
 * B01's registrations into B00's two seams, exactly the rows B00 reserved by name:
 *
 *  - the CLOSE GUARD (`src/core/projects/projects.ts`: "B01 registers `open_time` here when its
 *    `time_entries` table exists"): closing a project with OPEN or SUBMITTED time refuses with
 *    `project_has_open_time`, because unapproved hours on a closed project are hours nobody will
 *    ever bill or approve. Approved/locked/billed time does not block a close: it is frozen, and
 *    B02 reads it by project id regardless of project status.
 *
 *  - the COST SOURCE (`src/core/projects/budgetActual.ts`: "B01 `time_entries` ... each register
 *    one source"): a project's actual time cost, derived round-once per entry from the snapshotted
 *    rate (P2), attributed per phase. READ-ONLY by contract: this function only SELECTs.
 *
 * Registration happens at module load, from the barrel: `src/api/time-actions.ts` imports the
 * barrel, so every face of the engine that can move a project through its lifecycle has the guard.
 * The import direction is time -> projects, which is acyclic (projects imports nothing from time).
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import { registerCloseGuard, registerCostSource } from '../projects/index.js';
import type { ProjectRow } from '../projects/index.js';
import { entryValueMinor } from './time.js';

registerCloseGuard((ctx: WorkspaceContext, project: ProjectRow) => {
  const open = ctx.store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM time_entry WHERE workspace_id = ? AND project_id = ? AND status IN ('open', 'submitted')",
    )
    .get(ctx.workspaceId, project.id) as { n: number };
  if (open.n > 0) return err('project_has_open_time', { projectId: project.id, openEntries: open.n });
  return undefined;
});

registerCostSource({
  id: 'b01_time',
  actuals: (ctx: WorkspaceContext, project: ProjectRow) => {
    const rows = ctx.store.db
      .prepare(
        'SELECT phase_id, minutes, rate_minor FROM time_entry WHERE workspace_id = ? AND project_id = ? AND minutes IS NOT NULL',
      )
      .all(ctx.workspaceId, project.id) as { phase_id: string | null; minutes: number; rate_minor: number }[];
    const byPhase = new Map<string | null, { costMinor: number; minutes: number }>();
    for (const row of rows) {
      const bucket = byPhase.get(row.phase_id) ?? { costMinor: 0, minutes: 0 };
      bucket.costMinor += entryValueMinor(row.minutes, row.rate_minor);
      bucket.minutes += row.minutes;
      byPhase.set(row.phase_id, bucket);
    }
    return [...byPhase.entries()].map(([phaseId, sums]) => ({
      phaseId,
      costMinor: sums.costMinor,
      hours: sums.minutes / 60,
    }));
  },
});
