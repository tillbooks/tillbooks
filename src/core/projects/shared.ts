/**
 * B00's shared internals: the phase row shape and its one mapper, in a dependency-free leaf module
 * so `projects.ts` (which embeds phases in `getProject`) and `phases.ts` (which writes them) both
 * import DOWN and the module graph stays acyclic (the A25 `shared.ts` pattern).
 */

export interface PhaseRow {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  sort: number;
  budget_minor: number;
  budget_hours: number;
  milestone_on: string | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
}

export function mapPhase(row: PhaseRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    name: row.name,
    sort: row.sort,
    budgetMinor: row.budget_minor,
    budgetHours: row.budget_hours,
    milestoneOn: row.milestone_on,
    doneAt: row.done_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
