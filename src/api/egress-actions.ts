/**
 * E07's two verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `mailActions` / `voiceActions` / `draftActions` precedent), so several agents appending to the
 * append-only registry at once collide over a line rather than a block.
 *
 * BOTH ARE READS, and both are deliberately readable by an AGENT (spec §5): an agent auditing our
 * zero-egress claim on the user's behalf is a use we WANT, not one we guard against, so `egress.read`
 * gates them and nothing narrower. `egress_self_test` is a `read` (readOnlyHint:true) with no
 * idempotencyKey even though it RUNS the drafting loop: it mints nothing of its own and produces a
 * draft only through E06's already-idempotent path, into the practitioner's own local Drafts folder
 * (spec §5). It is inert on an empty workspace (it returns `needs_setup`), which is what keeps it
 * honest under the conformance "a read mutates nothing" rule.
 *
 * There is deliberately NO third verb for the CI gate (US-E07.3) or the limits copy (US-E07.4): the
 * CI probe runs on every build without being asked, and the limits list is fixed i18n content the
 * Vertrauen panel renders, not computed state. Both are the flagged exceptions in the spec's §2
 * coverage table.
 *
 * As with `draft-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { egressSelfTest, egressStatus } from '../core/egress/index.js';

export interface EgressActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
}

/** The E07 verbs, in append order. */
export function egressActions(h: EgressActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema } = h;

  return [
    ctxAction(
      'egress_self_test',
      'read',
      'Run the offline proof (OP6): install a socket-level probe over every network vector (TCP, UDP, DNS, TLS, HTTP(S), fetch, WebSocket, subprocess) and run a REAL end-to-end draft generation (E04 mail read -> E05 voice retrieve -> E06 compose -> E04 Drafts write) under it. Reports honestly: passed:true with socketsOpened:0 when the whole loop opened zero sockets (the claim, measured, and it holds with wifi on or off because the probe counts sockets and does not depend on the network being down); egress_violated with the offenders named when any socket was opened (we report our own violation loudly, never degrade the claim quietly); needs_setup naming what is missing (mail_store, voice_profile, local_runtime, draftable_thread) when a real run cannot be attempted; self_test_incomplete when the loop could not finish for a non-egress reason. Produces a draft in the practitioner\'s own local Drafts folder; mints nothing else. Reads egress.read; deliberately readable by an agent auditing the claim.',
      ctxSchema(),
      (ctx) => egressSelfTest(ctx),
    ),
    ctxAction(
      'egress_status',
      'read',
      'The standing trust indicator (P5, observed never stored): the egress state of THIS process. state=local when the probe is installed and has observed zero outbound sockets this session, violated when it has seen one or more (with the offenders), unknown when the probe could not install (an unverified claim renders as unverified, never as optimism). socketsOpened is the observed count and since is when the observer started. Scoped to the TILL process, NOT the Mac: the mail app uses the internet (that is how mail arrives); this reports only what TILL itself did. Reads egress.read.',
      ctxSchema(),
      (ctx) => egressStatus(ctx),
    ),
  ];
}
