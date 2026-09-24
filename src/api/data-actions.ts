/**
 * G04's eight verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` precedent),
 * so several agents appending to the append-only registry at once collide over a line rather than a
 * block.
 *
 * FOUR ARE ctx verbs (they operate on an existing workspace and gate on `manage_data_export`):
 * `export_workspace`, `create_backup`, `list_backups`, `delete_backup`. FOUR are deps verbs, each
 * pre-workspace for a stated reason: `verify_backup` inspects an arbitrary file (no tenant to scope
 * to), `list_restorable_backups` lists the artefact directory of THIS machine (F-06, J7.2: what a
 * fresh install can see before it has a workspace, so the restore door can name the generation
 * before the act), `get_api_catalog` describes the software contract (not tenant data), and
 * `restore_backup` MINTS the tenant, so like `create_workspace`/`onboard_client` it cannot be
 * resolved against a workspace that does not exist yet (spec §0a.4). Restore's safety is instead the
 * never-overwrite rule, the P8 `confirmed` gate and the pre-commit invariant check inside the engine.
 *
 * `backupDir` is resolved per request from `deps.backupDir` (injected in tests / by the host) or
 * `resolveBackupDir()` (the env-honouring default), the same shape G08 uses for its support dir.
 * The helpers arrive as a parameter rather than an import, so the module graph stays acyclic:
 * `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema, ApiDeps } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { err } from '../core/result.js';
import type { PortDeps, CatalogAction } from '../core/data/index.js';
import {
  exportWorkspace,
  createBackup,
  listBackups,
  verifyBackup,
  restoreBackup,
  deleteBackup,
  getApiCatalog,
  listRestorableBackups,
} from '../core/data/index.js';
import { resolveBackupDir } from './db-path.js';
import { applySavedView } from '../core/customization/index.js';

export interface DataActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
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
  /** The whole tool surface, as catalog rows, resolved lazily so `ACTIONS` is fully built first. */
  catalogActions: () => CatalogAction[];
}

/** The A24 capability gating the four workspace-scoped artifact verbs. */
export const MANAGE_DATA_EXPORT = 'manage_data_export';

function portDeps(store: ApiDeps['store'], clock: ApiDeps['clock'], ids: ApiDeps['ids'], actor: string, deps: ApiDeps): PortDeps {
  // M01/D111 (security review F2): thread `identitySource` so `restore_backup`'s composed
  // `createWorkspace` fires the served-mode D111 gate (deny a stranger, seat a member). Absent on a
  // local caller, so the single-machine flow is unchanged.
  return { store, clock, ids, actor, backupDir: deps.backupDir ?? resolveBackupDir(), identitySource: deps.identitySource };
}

/**
 * M01 (security review F3): the two MACHINE-STATE reads are refused to a served subject. On a served
 * instance `list_restorable_backups` reads the whole machine backup directory (every tenant's bundle
 * path, id, timestamp and entry count) and `verify_backup` inspects an ARBITRARY absolute path (an
 * existence oracle for the container). Both were written for the single-machine first-run door where
 * the only actor is the file holder; across the served trust boundary they disclose §H-TENANT state
 * to any authenticated subject, strangers included. A served subject therefore sees NONE of it (its
 * own workspace's backups remain reachable through the workspace-scoped `list_backups`, gated on
 * `manage_data_export`). A LOCAL operator keeps the arbitrary-path behaviour the verbs were built for.
 */
function refuseServedMachineRead(deps: ApiDeps): Result | undefined {
  if (deps.identitySource === 'served_subject') {
    return err('permission_denied', { capability: MANAGE_DATA_EXPORT, role: null });
  }
  return undefined;
}

/**
 * M01 (security review F2/F3, D59 critic decision, fail-closed): `restore_backup` is refused to EVERY
 * served subject, member or stranger. Restore is a LOCAL operator action; a served browser subject has
 * no restore path in the rc. This fence sits at the TOP of the verb, BEFORE `restoreBackup` runs its
 * read-only `verifyBackup` pre-flight, so the UNCONFIRMED plan branch cannot become an existence oracle
 * (`/etc` vs `/nope`) or leak a foreign bundle's entry count (the F3 plan bypass), AND a served member
 * can no longer be SEATED as owner of a copy of another mandate's books (the F2 cross-tenant read).
 * Threading `identitySource` into the composed `createWorkspace` (portability.ts) still denies a
 * stranger as belt-and-braces, but the primary gate is here.
 *
 * DEFERRED (owner decision, not implemented in the rc): a looser policy could allow a served MEMBER to
 * restore ONLY a bundle whose manifest `workspaceId` they hold `manage_data_export` on. Until that is
 * decided in DECISIONS.md, served restore is denied outright.
 */
function refuseServedRestore(deps: ApiDeps): Result | undefined {
  if (deps.identitySource === 'served_subject') {
    return err('permission_denied', { capability: MANAGE_DATA_EXPORT, role: null });
  }
  return undefined;
}

/** From a ctx verb: the workspace context already carries store/clock/ids/actor. */
function fromCtx(ctx: WorkspaceContext, deps: ApiDeps): PortDeps {
  return portDeps(ctx.store, ctx.clock, ctx.ids, ctx.actor, deps);
}

/** From a deps verb (pre-workspace): the raw deps carry store/clock/ids/actor. */
function fromDeps(deps: ApiDeps): PortDeps {
  return portDeps(deps.store, deps.clock, deps.ids, deps.actor, deps);
}

export function dataActions(h: DataActionHelpers): readonly ActionDef[] {
  const { ctxAction, depsAction, ctxSchema, depsSchema, STR, BOOL, catalogActions } = h;
  const ARR = { type: 'array', items: STR } as const;

  return [
    ctxAction(
      'export_workspace',
      'write',
      'Export the whole workspace to a documented, open .tillexport bundle (one JSONL file per table plus a manifest and FORMAT.md) a human can read without TILL. Optional scope names a subset of tables. Not a restore source.',
      ctxSchema({ scope: ARR, idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input, deps) => exportWorkspace(fromCtx(ctx, deps), input as never),
    ),
    ctxAction(
      'create_backup',
      'write',
      'Take a point-in-time .tillbackup snapshot: a tenant-scoped SQLite file plus a re-hashed manifest, recorded in the backup history. The byte-perfect artifact restore_backup consumes. An optional planId links the backup to a Datenübernahme plan (once it has reached planned), satisfying the migration commit gate’s pre-migration-backup leg; a planId in another workspace refuses.',
      ctxSchema({ planId: STR, idempotencyKey: STR }, ['idempotencyKey']),
      (ctx, input, deps) => createBackup(fromCtx(ctx, deps), input as never),
    ),
    ctxAction(
      'list_backups',
      'read',
      'List this workspace`s backups and exports, newest first, with size, timestamp, actor and status. Optional kind (backup|export) or status (complete|failed) narrows the list. savedViewId applies a saved preset (G00): its stored filters are merged underneath any filter named explicitly here.',
      ctxSchema({ kind: STR, status: STR, savedViewId: STR }),
      (ctx, input, deps) => {
        // The G00 seam, one unconditional call, the shape `listAccounts`/`list_workspaces` use: the
        // `backup` kind (spec §6b) can store a saved preset over its history, and this is where it is
        // applied. An explicit filter named here wins over the stored one.
        const viewed = applySavedView(ctx, 'backup', {
          savedViewId: input.savedViewId as string | undefined,
          kind: input.kind as string | undefined,
          status: input.status as string | undefined,
        });
        if (!viewed.ok) return viewed;
        return listBackups(fromCtx(ctx, deps), { workspaceId: ctx.workspaceId, ...viewed.filter } as never);
      },
    ),
    ctxAction(
      'delete_backup',
      'write',
      'Delete a local backup/export artifact and its history row. Storage housekeeping only: a backup file carries no legal retention lock of its own.',
      ctxSchema({ backupId: STR, idempotencyKey: STR }, ['backupId', 'idempotencyKey']),
      (ctx, input, deps) =>
        deleteBackup(fromCtx(ctx, deps), {
          workspaceId: ctx.workspaceId,
          backupId: String(input.backupId ?? ''),
          idempotencyKey: input.idempotencyKey as string,
        }),
    ),
    depsAction(
      'verify_backup',
      'read',
      'Verify a .tillbackup/.tillexport file`s per-table checksums and schema-version compatibility without writing anything, reporting entry count and whether every posted entry balances.',
      depsSchema({ source: STR }, ['source']),
      (deps, input) => refuseServedMachineRead(deps) ?? verifyBackup(fromDeps(deps), { source: String(input.source ?? '') }),
    ),
    depsAction(
      'list_restorable_backups',
      'read',
      'List the .tillbackup bundles in this machine`s backup directory (the support dir`s backups/, or TILL_BACKUP_DIR), newest first, with each one`s creation time, schema generation, entry count and whether this runtime can restore it, plus the generation this runtime expects. Pre-workspace: the restore door on a fresh install reads it. Lists no exports (an export is not a restore source) and verifies nothing (verify_backup does).',
      depsSchema({}, []),
      (deps) => refuseServedMachineRead(deps) ?? listRestorableBackups(fromDeps(deps)),
    ),
    depsAction(
      'restore_backup',
      'write',
      'Restore a .tillbackup into a brand-new workspace: composes create_workspace, bulk-loads every table preserving ids, and re-verifies balance + referential integrity before commit (all-or-nothing). Agent-staged: pass confirmed:true to proceed, else it returns a plan and writes nothing. Never overwrites an existing workspace.',
      depsSchema({ source: STR, newWorkspaceName: STR, idempotencyKey: STR, confirmed: BOOL }, [
        'source',
        'newWorkspaceName',
      ]),
      (deps, input) => refuseServedRestore(deps) ?? restoreBackup(fromDeps(deps), input as never),
    ),
    depsAction(
      'get_api_catalog',
      'read',
      'Return an OpenAPI 3.x document of every MCP tool and its REST twin (route, input shape, read/write, required capability), generated from the live registry. Describes the software contract, not workspace data.',
      depsSchema({}, []),
      () => getApiCatalog(catalogActions()),
    ),
  ];
}
