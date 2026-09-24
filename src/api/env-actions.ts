/**
 * The `env_*` verb family: the agent + REST face of the environment landscape (D126, Phase A), defined
 * here and spread into `ACTIONS` as one line (the `dataActions` precedent), so several agents appending
 * to the append-only registry collide over a line rather than a block.
 *
 * WHY THESE ARE ctx VERBS THOUGH THE LANDSCAPE IS HOST-LEVEL. An environment sits ABOVE any single
 * workspace, so the operations themselves work on the host-level control file (via `deps.supportDir`),
 * not on the caller's ledger. But A24 resolves a capability only against a workspace, and the load
 * guard (`assertEveryActionIsGated`) forbids declaring a real capability on a pre-workspace
 * `depsAction` (it could never be enforced at the boundary). So the family is `ctxAction`: the caller
 * names its current workspace, `landscape.manage` / `landscape.read` are resolved against THAT
 * membership (managing the landscape is an owner act), and the op then ignores the ledger and works on
 * the control file. This is the only shape that gives the write verbs a real, enforced A24 gate.
 *
 * IDEMPOTENCY is host-level, under the `_system` pseudo-tenant (the `restore_backup` precedent), and
 * ONLY a successful confirmed write is memoized, so a failed seed never burns a key. The unconfirmed
 * (P8) call returns a plan and is never memoized. The engine owns every rule; this file only maps the
 * wire object to `LandscapeDeps` and threads idempotency.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import type { ActionDef, ActionInput, JsonSchema, ApiDeps } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { err } from '../core/result.js';
import { resolveDbPath, resolveSupportDir } from './db-path.js';
import {
  envList,
  envStatus,
  envCurrent,
  envSwitch,
  envCreate,
  envReset,
  envDelete,
  envCopy,
  defaultSeeders,
  type LandscapeDeps,
} from '../core/landscape/index.js';

export interface EnvActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
  INT: { readonly type: 'integer' };
}

/** The A24 capabilities gating the family: management (writes) and read. */
export const LANDSCAPE_MANAGE = 'landscape.manage';
export const LANDSCAPE_READ = 'landscape.read';

/** The repo root, so the default `seeblick` seeder can find `scripts/seed-demo-rich.mjs` + `dist/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Build the host-level `LandscapeDeps` for one request from the workspace context and the api deps. */
function landscapeDeps(ctx: WorkspaceContext, deps: ApiDeps): LandscapeDeps {
  const supportDir = deps.supportDir ?? resolveSupportDir();
  return {
    supportDir,
    environmentsRoot: join(supportDir, 'environments'),
    mainDbPath: resolveDbPath(),
    actor: ctx.actor,
    now: () => ctx.clock.now(),
    seeders: defaultSeeders(REPO_ROOT),
    // Phase B (the copy path) reuses portability.ts, which re-mints ids and stamps the copy.
    ids: ctx.ids,
    clock: ctx.clock,
  };
}

/**
 * P8 + host-level idempotency for a confirmed landscape write. The unconfirmed call runs straight
 * through (the op returns a plan and changes nothing). A confirmed call with a key replays a prior
 * SUCCESS and otherwise runs once and memoizes ONLY on success, so a failed seed does not burn the key
 * and a duplicate delivery cannot re-run a reset. Keyed on `_system` (the `restore_backup` shape).
 */
function stagedWrite(ctx: WorkspaceContext, input: ActionInput, verb: string, run: () => Result): Result {
  // M01 (security review F1): THE LANDSCAPE IS A PROPERTY OF THE HOST, MANAGED BY THE FILE HOLDER.
  // Every `env_*` WRITE (env_switch, env_create, env_reset, env_delete, env_copy) funnels through here,
  // and each one operates on the host-level control file and arbitrary data roots, not on a tenant's
  // ledger. A served OWNER is a CUSTOMER of the instance, not its operator: `env_create dbPath=...`
  // renames a synthetic ledger over any host path and `env_delete` rmSyncs a registered root plus its
  // sidecars, so a served subject reaching these verbs is a host-level arbitrary write/delete. Refuse
  // the whole family (plan and confirmed alike) for a served subject, the same reasoning `served-mode.ts`
  // gives for trust configuration (spec §6b, D42). The three `landscape.read` verbs do NOT route through
  // here and stay available. A LOCAL caller (identitySource absent or `local_client`) is unaffected.
  if (ctx.identitySource === 'served_subject') {
    return err('permission_denied', { capability: LANDSCAPE_MANAGE, role: null, reason: 'landscape_is_host_scoped' });
  }
  const confirmed = input.confirmed === true;
  const key = typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0 ? input.idempotencyKey : undefined;
  if (!confirmed || key === undefined) return run();

  const prior = ctx.store.recallIdempotent<Result>('_system', key, verb);
  if (prior !== undefined) return prior;

  const result = run();
  if (result.ok) {
    ctx.store.tx(() => {
      ctx.store.db
        .prepare('INSERT INTO idempotency (workspace_id, key, verb, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('_system', key, verb, JSON.stringify(result), ctx.clock.now());
    });
  }
  return result;
}

export function envActions(h: EnvActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL, INT } = h;
  return [
    ctxAction(
      'env_list',
      'read',
      'List every TILL environment in the landscape with its code channel, data policy, guard tier, runtime target, tier rank, last refresh, size and which one is current. Standard tiers (main, test, develop) are pinned first, then named environments. Fails loud if the landscape control file fails its integrity check.',
      ctxSchema(),
      (ctx, _input, deps) => envList(landscapeDeps(ctx, deps)),
    ),
    ctxAction(
      'env_status',
      'read',
      'Detail one environment: its data freshness, guard tier, runtime target, recorded code channel and drift against the built one, and whether its data root exists. Fails loud on a landscape integrity mismatch.',
      ctxSchema({ name: STR }, ['name']),
      (ctx, input, deps) => envStatus(landscapeDeps(ctx, deps), { name: input.name }),
    ),
    ctxAction(
      'env_current',
      'read',
      'The active environment for this face, and whether it is read-only (only a served/hosted env is read-only from a local face; a local main is the real books and stays writable, D135).',
      ctxSchema(),
      (ctx, _input, deps) => envCurrent(landscapeDeps(ctx, deps)),
    ),
    ctxAction(
      'env_switch',
      'write',
      'Set the active environment for this face. Switching to a served (hosted) env records the pointer and marks the face read-only; a local main stays writable (D135). Destructive env-wide verbs stay refused on main regardless. Unconfirmed, returns a plan and changes nothing (P8).',
      ctxSchema({ name: STR, confirmed: BOOL, idempotencyKey: STR }, ['name']),
      (ctx, input, deps) => stagedWrite(ctx, input, 'env_switch', () => envSwitch(landscapeDeps(ctx, deps), input)),
    ),
    ctxAction(
      'env_create',
      'write',
      'Create a new environment and populate its data root per its policy: synthetic (seeded, seed selectable, default the Seeblick golden ledger) or live (an empty ledger). policy=copy is Phase B. Refuses a data root that collides with an existing environment or aliases main`s volume. Unconfirmed, returns a plan and changes nothing (P8).',
      ctxSchema(
        {
          name: STR,
          policy: STR,
          codeChannel: STR,
          source: STR,
          seed: STR,
          dbPath: STR,
          guardTier: STR,
          runtimeTarget: STR,
          tierRank: INT,
          sanitize: STR,
          scope: STR,
          scaleFactor: INT,
          // NB: no `retainSecrets` here. The owner-only secret-retaining override lives ONLY on env_copy
          // (which carries the landscape.retain_secrets sub-gate); env_create policy=copy always
          // neutralizes and refuses a retainSecrets request (see copy.ts envCreateCopy).
          confirmed: BOOL,
          idempotencyKey: STR,
        },
        ['name', 'policy'],
      ),
      (ctx, input, deps) => stagedWrite(ctx, input, 'env_create', () => envCreate(landscapeDeps(ctx, deps), input)),
    ),
    ctxAction(
      'env_copy',
      'write',
      'Copy data one-way from a source environment into a lower one, sanitized. scope is instance (every workspace) or mandate:<workspaceId> (one workspace, others in the target untouched). sanitize is raw (verbatim), pseudonymize (deterministic PII masking, valid CH test IBANs, amounts intact unless scaleFactor is given) or structure_synthetic (structure kept, amounts and transactions replaced). Build-then-swap: a failed copy leaves the prior target intact. Refuses target=main and refuses a source whose tier rank is not strictly above the target (down-only). The SECRET FLOOR always neutralizes live access secrets (bank/EBICS/token) regardless of level; the owner-only retainSecrets override lifts it. Refuses a copy into the active env without force. Unconfirmed, returns the exact plan and changes nothing (P8).',
      ctxSchema(
        {
          source: STR,
          target: STR,
          scope: STR,
          sanitize: STR,
          scaleFactor: INT,
          retainSecrets: BOOL,
          force: BOOL,
          confirmed: BOOL,
          idempotencyKey: STR,
        },
        ['source', 'target'],
      ),
      (ctx, input, deps) => stagedWrite(ctx, input, 'env_copy', () => envCopy(landscapeDeps(ctx, deps), input)),
    ),
    ctxAction(
      'env_reset',
      'write',
      'Wipe and repopulate an environment from its data policy, build-then-swap: a new db file is seeded and gated (foreign-key check plus a balance re-foot) and swapped in only on success, so a failed reset leaves the prior environment intact. Refused on main (by data root, not just name) and on the active env without force. Reset of a copy-policy env is Phase B. Unconfirmed, returns a plan and changes nothing (P8).',
      ctxSchema({ name: STR, seed: STR, force: BOOL, confirmed: BOOL, idempotencyKey: STR }, ['name']),
      (ctx, input, deps) => stagedWrite(ctx, input, 'env_reset', () => envReset(landscapeDeps(ctx, deps), input)),
    ),
    ctxAction(
      'env_delete',
      'write',
      'Remove a named environment`s data root and its landscape entry. Refused on main always, on a standard tier without force (use reset), and on the active environment (switch away first). Unconfirmed, returns a plan and changes nothing (P8).',
      ctxSchema({ name: STR, force: BOOL, confirmed: BOOL, idempotencyKey: STR }, ['name']),
      (ctx, input, deps) => stagedWrite(ctx, input, 'env_delete', () => envDelete(landscapeDeps(ctx, deps), input)),
    ),
  ];
}
