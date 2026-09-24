/**
 * G04.4, the API catalog: a machine-readable description of TILL's whole data-access surface.
 *
 * `getApiCatalog` turns the live action registry into an OpenAPI 3.x document, so an agent or
 * integrator can discover every MCP tool and its REST twin (route, input shape, read/write, required
 * capability) without reading source. It is GENERATED on every call from the SAME registry the P4
 * parity check reads (`registry.ts`'s `buildCatalogActions`), never hand-maintained, so it can never
 * drift from the surface it describes (spec §4).
 *
 * WHY THE ROWS ARRIVE AS AN ARGUMENT. `registry.ts` imports this module; this module must not import
 * it back, or the graph is a cycle. So the caller (the `get_api_catalog` action in `data-actions.ts`)
 * resolves the rows lazily against the fully-built `ACTIONS` array and hands them in. This module
 * knows the SHAPE of a catalog row (`CatalogAction`) and how to render it, not where the array lives.
 */

import { ok, err } from '../result.js';
import type { Result } from '../result.js';

/** The minimal input-schema shape a catalog row carries (registry's `JsonSchema`, structurally). */
export interface CatalogInputSchema {
  type: string;
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: boolean;
}

/**
 * One tool, as the catalog sees it: its wire name, whether it reads or writes, its one-line summary,
 * its input schema, and the A24 capabilities it requires (empty for a pre-workspace or ungated verb).
 * `registry.ts` builds these from `ACTIONS` at request time.
 */
export interface CatalogAction {
  name: string;
  kind: 'read' | 'write';
  summary: string;
  /** A35: the consequence sentence on a dial-governed money-path write; absent elsewhere. */
  consequence?: string;
  inputSchema: CatalogInputSchema;
  capabilities: readonly string[];
}

/** The OpenAPI vendor extension carrying the two facts REST cannot express in a stock field. */
interface TillOperationExtension {
  'x-till-kind': 'read' | 'write';
  'x-till-capabilities': readonly string[];
}

/**
 * Render every registered tool as an OpenAPI 3.1 document. Each tool becomes one `POST /api/<name>`
 * operation whose request body is the tool's input schema and whose `x-till-*` extensions carry the
 * read/write hint and the required capabilities the P4 registry knows and stock OpenAPI does not.
 *
 * A generation failure (a malformed row that slipped past CI) returns
 * `{ok:false, error:'catalog_generation_failed'}` rather than a stale or partial document (P9,
 * spec US-G04.4 error path). The `actor` is unused: the catalog describes the software contract, not
 * any workspace's data, so any authenticated actor may read it and there is no RBAC gate here.
 */
export function getApiCatalog(actions: readonly CatalogAction[]): Result {
  try {
    const paths: Record<string, unknown> = {};
    for (const action of actions) {
      const extension: TillOperationExtension = {
        'x-till-kind': action.kind,
        'x-till-capabilities': [...action.capabilities],
      };
      paths[`/api/${action.name}`] = {
        post: {
          operationId: action.name,
          summary: action.summary,
          // A35 (critic F11): a dial-governed money-path write states what it irreversibly does, in
          // the operation's own description slot, so a machine reader of the catalog sees the same
          // consequence sentence an MCP client sees on tools/list.
          ...(action.consequence === undefined ? {} : { description: `CONSEQUENCE: ${action.consequence}` }),
          requestBody: {
            required: action.inputSchema.required.length > 0,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: action.inputSchema.properties,
                  required: action.inputSchema.required,
                  additionalProperties: action.inputSchema.additionalProperties ?? true,
                },
              },
            },
          },
          responses: {
            '200': { description: 'The verb succeeded; the body is its Result with ok:true.' },
            '422': { description: 'The verb rejected; the body is its Result with ok:false and an error code.' },
          },
          ...extension,
        },
      };
    }
    const openapi = {
      openapi: '3.1.0',
      info: {
        title: 'TILL data-access API',
        version: TILL_VERSION,
        description:
          'Every MCP tool and its REST twin, generated from the live registry. Each operation carries x-till-kind (read/write) and x-till-capabilities (the A24 capabilities required).',
      },
      // The catalog's own contract note: a plugin (OP9) that registers a tool appears here on the very
      // next fetch, listed under this same section. It is empty on a fresh install, shown rather than
      // omitted (spec US-G04.4 empty path).
      'x-till-plugin-routes': [] as unknown[],
      paths,
    };
    // `toolCount` is a top-level convenience the Studio's API-catalog control reads directly, so it
    // does not have to walk `paths` to show "N tools"; it equals the number of path entries.
    return ok({ openapi, toolCount: actions.length });
  } catch (e) {
    return err('catalog_generation_failed', { message: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * The till version stamped into artifacts and the catalog. It mirrors the value `mcp.ts` reports as
 * the server version (the package version), kept here as the single G04 source so a manifest and the
 * catalog agree. `till_version` is INFORMATIONAL on restore (only `schema_version` gates, spec
 * §0a.6), so a plain constant is correct: it is reported, never compared.
 */
export const TILL_VERSION = '0.0.0';
