/**
 * The Setup surface: the Firmenprofil and the first-hour setup work, and nothing else.
 *
 * K-16 (Option A) split the old twelve-panel scroll in two. The operational, read-once panels (the
 * offline-trust proof, the runtime line, sync and hosting, data and backup, the implementation
 * roster, diagnostics and feedback) moved to the new Betrieb surface at `/operations`. What stays
 * here is the profile face: `CompanyProfile` owns both of its faces (create a workspace on first
 * run, or edit the profile afterwards), including the Arbeitsbereiche list, so the first-run screen
 * stays the single call to action it was designed to be.
 */
import { CompanyProfile } from './CompanyProfile';

export function Setup() {
  return <CompanyProfile />;
}
