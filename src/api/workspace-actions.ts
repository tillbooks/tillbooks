/**
 * A23, multi-client workspaces: the Treuhänder's roster verbs, defined here and spread into
 * `ACTIONS` as one line (the `fxActions` precedent).
 *
 * Four verbs, two shapes:
 *
 *  - `list_workspaces` and `onboard_client` are `depsAction`s, PRE-WORKSPACE by construction: the
 *    first exists because a reloaded client holds no `workspaceId` yet and must re-find its books
 *    (D12), the second because it MINTS the tenant a capability would be resolved in (the
 *    `create_workspace` precedent). `list_workspaces` lived inline in `registry.ts` under a D12
 *    banner until A23 took ownership and migrated it here.
 *  - `get_workspace` and `archive_workspace` are ordinary ctx verbs.
 *
 * SWITCHING IS DELIBERATELY NOT A VERB. The active scope is a session property: the human sets it
 * in the switcher, the agent has it fixed at bind time, and every tool call carries `workspaceId`.
 * The dispatcher only serves registered actions, so there is nothing for a session-switch route to
 * dispatch to, and that absence is the design (A23 §5).
 *
 * ARCHIVE IS A FLAG, NEVER A DELETE. `archive_workspace` covers both directions through its
 * `archived` boolean; the read-only consequence for every OTHER write verb is enforced at the
 * shared `ctxAction` boundary in `registry.ts` (`workspace_archived`), not per verb.
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX and A14 both established:
 * the registry is the one append-only tool list and several agents append to it at once, so the
 * smaller the hunk the cheaper the merge. The helpers arrive as a parameter to keep the module
 * graph acyclic.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import { makeContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { err } from '../core/result.js';
import { applySavedView } from '../core/customization/index.js';
import {
  listWorkspaces,
  getWorkspace,
  onboardClient,
  archiveWorkspace,
  unarchiveWorkspace,
} from '../core/setup/index.js';

export interface WorkspaceActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  depsAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (deps: ApiDeps, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  depsSchema(props: Record<string, unknown>, required: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
}

/** The A23 verbs, in append order. */
export function workspaceActions(h: WorkspaceActionHelpers): readonly ActionDef[] {
  const { ctxAction, depsAction, ctxSchema, depsSchema, STR, BOOL } = h;

  const as = <T>(input: ActionInput): T => input as unknown as T;

  return [
    depsAction(
      'list_workspaces',
      'read',
      'List the workspaces in this database this session may open (id, name, currency, fiscal year start), so a client can re-open one. Archived mandates are hidden unless includeArchived is true; a provisioned workspace is listed only for its accepted members. savedViewId applies a saved roster view (G00): pass savedViewWorkspaceId (the book the view is stored in) beside it; stored filters merge underneath any named explicitly here.',
      depsSchema({ includeArchived: BOOL, savedViewId: STR, savedViewWorkspaceId: STR }, []),
      (deps, input) => {
        let filter = as<{ includeArchived?: boolean; savedViewId?: string }>(input);
        if (typeof input.savedViewId === 'string' && input.savedViewId.length > 0) {
          // The G00 seam. The roster read is pre-workspace, but a saved view is a per-workspace row
          // (it lives in the book whose roster cut it names), so applying one needs the book it is
          // stored in. DELIBERATELY NOT named `workspaceId`: on every other verb that field is the
          // TENANT the read is scoped to, and this read is cross-tenant by design (the conformance
          // tenant-declaration rule holds that line). Resolution runs through the same
          // `applySavedView` every list verb uses.
          const workspaceId = input.savedViewWorkspaceId;
          if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
            return err('invalid_input', { field: 'savedViewWorkspaceId' });
          }
          const exists = deps.store.db.prepare('SELECT 1 FROM workspace WHERE id = ?').get(workspaceId);
          if (exists === undefined) return err('workspace_not_found', { workspaceId });
          const ctx = makeContext(deps.store, {
            workspaceId,
            actor: deps.actor,
            clock: deps.clock,
            ids: deps.ids,
          });
          const applied = applySavedView(ctx, 'workspace', filter);
          if (!applied.ok) return applied;
          filter = applied.filter;
        }
        return listWorkspaces({ store: deps.store, actor: deps.actor }, filter);
      },
    ),
    ctxAction(
      'get_workspace',
      'read',
      'Read one workspace roster entry for the switcher header: name, legal form, base currency, fiscal year start, archived flag and creation date. Lighter than get_company_profile, which returns the full fiscal and creditor configuration.',
      ctxSchema(),
      (ctx) => getWorkspace(ctx),
    ),
    depsAction(
      'onboard_client',
      'write',
      'Onboard a new client workspace (ein neues Mandat) in one call: mints the workspace via create_workspace with its Kontenrahmen KMU chart, seeds the tax codes and sets the VAT method when vatMethod and vatAccounting are given together, and seats the operator as accepted owner (A24). Idempotent per key: replaying returns the existing workspace, never a duplicate client.',
      depsSchema(
        {
          name: STR,
          legalForm: STR,
          fiscalYearStart: STR,
          baseCurrency: STR,
          vatMethod: STR,
          vatAccounting: STR,
          idempotencyKey: STR,
        },
        ['name', 'idempotencyKey'],
      ),
      (deps, input) => onboardClient(deps, as(input)),
    ),
    ctxAction(
      'archive_workspace',
      'write',
      'Archivieren: retire a finished mandate (archived:true) or put it back in play (archived:false). A reversible flag, never a delete: the books stay intact and exportable (OR 958f), reads keep answering, and every OTHER write into an archived workspace returns workspace_archived.',
      ctxSchema({ archived: BOOL, idempotencyKey: STR }, ['archived', 'idempotencyKey']),
      (ctx, input) =>
        input.archived === false
          ? unarchiveWorkspace(ctx, as(input))
          : archiveWorkspace(ctx, as(input)),
    ),
  ];
}
