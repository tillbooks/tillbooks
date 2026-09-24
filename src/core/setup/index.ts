/**
 * A00, company & fiscal setup: workspace minting, fiscal config, and the creditor profile.
 * bootstrapWorkspace (agent one-call setup) and updateCompanyProfile are the next A00 increment.
 */

export {
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  archiveWorkspace,
  unarchiveWorkspace,
  setFiscalConfig,
  setVatMethod,
} from './workspace.js';
export type { SetupDeps, CreateWorkspaceInput, WorkspaceSummary } from './workspace.js';
export { onboardClient } from './onboarding.js';
export type { OnboardClientInput } from './onboarding.js';
export { setCreditorProfile, getCompanyProfile, updateCompanyProfile } from './companyProfile.js';
export type { CreditorAddress, SetCreditorProfileInput, UpdateCompanyProfileInput } from './companyProfile.js';
export { bootstrapWorkspace, parseBootstrapDescription } from './bootstrap.js';
export type { BootstrapWorkspaceInput } from './bootstrap.js';
export { isValidIban, isQrIban, normalizeIban } from './iban.js';
