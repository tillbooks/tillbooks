/**
 * G03, onboarding: the first-run wizard's resume pointer and the demo workspace.
 *
 * A thin orchestration module ABOVE `setup`, `vat`, `sales`, `access` and `migration`: it sequences
 * verbs those modules own and adds no import pipeline and no posting logic of its own (the G09-G13
 * harness owns migration; A10/A11 own the demo's postings). The barrel is the only thing
 * `src/api/` imports from, matching every other engine area.
 */

export { getOnboardingProgress, advanceOnboardingStep, ONBOARDING_PATHS, isOnboardingPath } from './progress.js';
export type { OnboardingPath, OnboardingProgressOk, AdvanceOnboardingStepInput, AdvanceOnboardingStepOk } from './progress.js';
export { createDemoWorkspace, discardDemoWorkspace } from './demo.js';
export type {
  CreateDemoWorkspaceInput,
  CreateDemoWorkspaceOk,
  DiscardDemoWorkspaceInput,
  DiscardDemoWorkspaceOk,
} from './demo.js';
export { ONBOARDING_SCHEMA_SQL } from './schema.js';
