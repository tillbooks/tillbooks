/**
 * M00's one new verb, `delivery_status`, defined here and spread into `ACTIONS` as one line (the
 * `guidanceActions` / `fxActions` precedent), so several agents appending to the append-only registry
 * at once collide over a line rather than a block.
 *
 * IT IS A READ AND IT IS PRE-WORKSPACE. It describes the PROCESS (how it was started, what it bound,
 * whether the Studio is served, whether a scheduler tick is alive), never any tenant's data, so it is
 * a `depsAction` with no `workspaceId`, joining the `list_concepts` / `verify_backup` workspace-free
 * family. The process facts come from `runtime-state.ts` (a module singleton the host populates); the
 * schema generation is read straight off the opened store's `PRAGMA user_version`, so a caller can
 * tell whether the file it is about to adopt was written by a newer generation of TILL (the
 * `schema_newer_than_runtime` first-run refusal is decided against this number).
 *
 * The wire payload is camelCase like every other verb's (`schemaGeneration`, `scheduler.lastTickAt`),
 * not the snake_case the spec's §4 prose illustrates.
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import { getDeliveryRuntime, TILL_VERSION } from './runtime-state.js';

export interface DeliveryActionHelpers {
  depsAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (deps: ApiDeps, input: ActionInput) => Result,
  ): ActionDef;
  depsSchema(props: Record<string, unknown>, required: string[]): JsonSchema;
}

/** The file's schema generation, read off the opened store. 0 on a pre-generation file. */
function schemaGenerationOf(deps: ApiDeps): number {
  const value = deps.store.db.pragma('user_version', { simple: true });
  return typeof value === 'number' ? value : 0;
}

/** The M00 verb, in append order (one entry). */
export function deliveryActions(h: DeliveryActionHelpers): readonly ActionDef[] {
  const { depsAction, depsSchema } = h;

  return [
    depsAction(
      'delivery_status',
      'read',
      'Inspect the running TILL delivery process: mode (up | mcp | serve | agent_session), version, the schema generation of the open database, the path of the open database file (dbPath, ":memory:" on an ephemeral run), the bound loopback host and port, whether the built Studio is served, and the local scheduler (enabled, last tick, next tick). Pre-workspace: it describes the process, not any tenant, so it takes no workspaceId. In agent_session mode your books run inside the agent runtime and residency is the runtime vendor, not your machine (M00 US-M00.6).',
      depsSchema({}, []),
      (deps) => {
        const rt = getDeliveryRuntime();
        // M03 (V2, the Trust data-location line): the path of the file the process actually opened,
        // read off the live handle rather than re-resolved from env, so it cannot disagree with the
        // books being served. better-sqlite3 reports ':memory:' for an ephemeral run.
        const name = (deps.store.db as unknown as { name?: unknown }).name;
        return ok({
          mode: rt.mode,
          version: TILL_VERSION,
          schemaGeneration: schemaGenerationOf(deps),
          dbPath: typeof name === 'string' ? name : null,
          host: rt.host,
          port: rt.port,
          studioServed: rt.studioServed,
          scheduler: {
            enabled: rt.scheduler.enabled,
            lastTickAt: rt.scheduler.lastTickAt,
            nextTickAt: rt.scheduler.nextTickAt,
          },
        });
      },
    ),
  ];
}
