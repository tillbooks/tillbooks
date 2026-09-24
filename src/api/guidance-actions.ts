/**
 * G17's two verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` precedent),
 * so several agents appending to the append-only registry at once collide over a line rather than a
 * block.
 *
 * BOTH ARE READS AND BOTH ARE WORKSPACE-FREE, and the second property is the one that needs its
 * reason written down. §H-TENANT protects tenant data; the Begriffe corpus is a build-time constant,
 * identical in every workspace on the planet, so there is no tenant row to scope and giving the
 * verbs a `workspaceId` would imply the corpus CAN differ per workspace, which is exactly the
 * property that must never exist for the explanation of a statutory election (a workspace-editable
 * or workspace-scoped wording would let one operator's explanation become another's evidence). They
 * are therefore `depsAction`s, joining `accept_invite`'s small workspace-free family for a
 * different reason with the reason stated.
 *
 * G17 MINTS NO WRITE VERB, NO TABLE AND NO ROUTE, asserted over the registry by
 * `test/guidance/registry-shape.test.mjs`: that absence is what makes the product-tour genre
 * unbuildable rather than merely banned (design §7b).
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { Result } from '../core/result.js';
import { listConcepts, getConcept } from '../core/guidance/index.js';

export interface GuidanceActionHelpers {
  depsAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (deps: ApiDeps, input: ActionInput) => Result,
  ): ActionDef;
  depsSchema(props: Record<string, unknown>, required: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** The G17 verbs, in append order. */
export function guidanceActions(h: GuidanceActionHelpers): readonly ActionDef[] {
  const { depsAction, depsSchema, STR } = h;

  return [
    depsAction(
      'list_concepts',
      'read',
      'List the Begriffe: TILL\'s authored explanations of its Swiss accounting vocabulary (Saldosteuersatz, Vorsteuer, Steuerperiode, ...). Filter by area or a per-token query; returns key, localized term and area, never the bodies. Workspace-free: the corpus is identical in every workspace.',
      depsSchema({ area: STR, query: STR, locale: STR }, []),
      (_deps, input) => listConcepts(input),
    ),
    depsAction(
      'get_concept',
      'read',
      'Read one Begriff in one locale: the authored body (THE WORDING OF RECORD for explaining this term: cite it rather than paraphrasing), its statutory citations as a structured list, related terms, and an explicit not-implemented flag where TILL does not cover the subject. Unknown keys return a structured not_found naming the nearest keys; nothing is ever generated. Workspace-free: the corpus is identical in every workspace.',
      depsSchema({ key: STR, locale: STR }, ['key']),
      (_deps, input) => getConcept(input),
    ),
  ];
}
