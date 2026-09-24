/**
 * G11, `row_count` (spec §4): source rows against the RECORDED row outcomes, the audit trail G09
 * writes per committed row into `migration_step_row` (created + skipped + failed), which is exactly
 * what makes a step's row count CHECKABLE rather than claimed.
 *
 * Before any load has recorded outcomes there is nothing to count, so the control reports NOTHING
 * rather than fabricating a comparison (spec §4, reconciled): the trial-load counts G09 stores do
 * not partition every row, and a control that compared against a partial partition would fail on a
 * correct import, which is worse than staying silent about a question nobody has answered yet.
 */

import type { ControlModule } from './registry.js';

export const rowCount: ControlModule = {
  kind: 'row_count',
  declarable: false,
  appliesTo: () => true,
  compute(ctx, _plan, step, env) {
    const recorded = (
      ctx.store.db
        .prepare('SELECT COUNT(*) AS n FROM migration_step_row WHERE workspace_id = ? AND step_id = ?')
        .get(ctx.workspaceId, step.id) as { n: number }
    ).n;
    if (recorded === 0) return [];
    const sourceRows = env.rows.length;
    const diff = recorded - sourceRows;
    return [
      {
        scope: 'workspace',
        computedMinor: recorded,
        inputsPresent: true,
        selfStatus: diff === 0 ? 'passed' : 'failed',
        detail:
          diff === 0
            ? `${recorded} Zeilen verarbeitet, ${sourceRows} in der Quelle`
            : `${recorded} Zeilen verarbeitet, aber ${sourceRows} in der Quelle (Differenz ${diff})`,
      },
    ];
  },
};
