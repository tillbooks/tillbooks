/**
 * B00, the projects master: the barrel `src/api/` imports from.
 */

export {
  createProject,
  updateProject,
  setProjectStatus,
  deleteProject,
  listProjects,
  getProject,
  readProject,
  mapProject,
  registerCloseGuard,
} from './projects.js';
export type { CreateProjectInput, ProjectPatch, ProjectRow, CloseGuard } from './projects.js';
export { addPhase, updatePhase, phaseDone } from './phases.js';
export type { AddPhaseInput, PhasePatch } from './phases.js';
export { mapPhase } from './shared.js';
export type { PhaseRow } from './shared.js';
export { projectBudgetActual, registerCostSource } from './budgetActual.js';
export type { CostSource } from './budgetActual.js';
export { PROJECT_STATUSES, PROJECT_TRANSITIONS, isProjectStatus, isLegalTransition } from './enums.js';
export type { ProjectStatus } from './enums.js';
export { PROJECTS_SCHEMA_SQL } from './schema.js';
