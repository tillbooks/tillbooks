/**
 * The Setup surface: the Firmenprofil and the first-hour setup work, and nothing else.
 *
 * K-16 (Option A) split the old twelve-panel scroll in two. The operational, read-once panels (the
 * offline-trust proof, the runtime line, sync and hosting, data and backup, the implementation
 * roster, diagnostics and feedback) moved to the new Betrieb surface at `/operations`. What stays
 * here is the profile face: `CompanyProfile` owns both of its faces (create a workspace on first
 * run, or edit the profile afterwards), including the Arbeitsbereiche list, so the first-run screen
 * stays the single call to action it was designed to be.
 *
 * D172: below the profile, once a workspace exists, the Einstellungen section lists every setting of
 * the workspace settings registry (`WorkspaceSettings`). On first run there is no workspace and no
 * section, so the create face stays the single call to action.
 */
import { useWorkspaceId } from '../../app/workspace';
import { CompanyProfile } from './CompanyProfile';
import { WorkspaceSettings } from './WorkspaceSettings';

export function Setup() {
  const workspaceId = useWorkspaceId();
  return (
    <>
      <CompanyProfile />
      {workspaceId !== null && (
        <div className="setup-surface">
          <WorkspaceSettings workspaceId={workspaceId} />
        </div>
      )}
    </>
  );
}
