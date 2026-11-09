/**
 * A41.3 re-cut v2 (D184, I-F, security review 07.11.2026): WHERE A CAPTURE'S BYTES CAME FROM, recorded at
 * intake (`captures.intake_seat`). A Swiss QR code backs an unattended booking only on a document a person
 * brought in, because an agent can make a PDF carrying a QR bill of its own.
 *
 *  - `machine`: the executing seat is governed (the agent, a served agent member, a plugin call) or `system`,
 *    OR the intake is the replay of a drafted action whose DRAFTER was such a seat (a person approving an
 *    agent's upload approves it, the bytes are still the agent's). Read from the approval in flight
 *    (`approvingActionIds`, the drafted row's own `actor`), engine-side: no caller input can set it.
 *  - `folder`: the Belegeingang scan (`files/belegeingang.ts`) marks its own intakes (`withinFolderIntake`, a
 *    scoped binder no input reaches). Whether a folder receipt's QR code is trusted is the human-only setting
 *    `belege.qr_trust_folder` (default `on`: it is the owner's own receipt channel).
 *  - `person`: anything else, a person's own capture.
 *
 * A LEAF beside `captureHold.ts`: it imports only the governed-seat rule and the approval marker.
 */

import type { WorkspaceContext } from '../context.js';
import { isGovernedSeat } from '../access/capability.js';
import { approvingActionIds } from '../agent/approving.js';

export const INTAKE_SEATS = ['person', 'folder', 'machine'] as const;
export type IntakeSeat = (typeof INTAKE_SEATS)[number];

let folderDepth = 0;

/** Run `fn`, the Belegeingang folder's own intake of one file, marked as a folder intake. */
export function withinFolderIntake<T>(fn: () => T): T {
  folderDepth += 1;
  try {
    return fn();
  } finally {
    folderDepth -= 1;
  }
}

/** Is `actor` a machine seat (governed, or the system)? */
function machine(ctx: WorkspaceContext, actor: string): boolean {
  return actor === 'system' || isGovernedSeat(ctx.store, actor);
}

/**
 * Is the act running now a MACHINE's, by the same rule as the intake seat: a governed or system executor, or the
 * approval replay of a governed seat's draft (security review: a person approving an agent's act does not make it
 * the person's own decision). Read by `capture_discard` (a machine never releases a person's assignment).
 */
export function isMachineAct(ctx: WorkspaceContext): boolean {
  return intakeSeatOf(ctx) === 'machine';
}

/** Where the bytes of an intake running now came from (see the module note). */
export function intakeSeatOf(ctx: WorkspaceContext): IntakeSeat {
  if (machine(ctx, ctx.actor)) return 'machine';
  for (const actionId of approvingActionIds()) {
    const row = ctx.store.db.prepare('SELECT actor FROM agent_action WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, actionId) as { actor: string } | undefined;
    // An approval of a row this workspace cannot read is no proof of a person: fail closed.
    if (row === undefined || machine(ctx, row.actor)) return 'machine';
  }
  return folderDepth > 0 ? 'folder' : 'person';
}
