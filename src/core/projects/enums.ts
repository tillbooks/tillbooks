/**
 * B00 §H-ENUM: the single source for the project master's closed enumerations.
 *
 * The status machine is PERSISTED STATE OWNED HERE, deliberately not P7: a project is a master, not
 * a document, so the A10 document machine does not apply (spec §4). The enum and its transition
 * table live in this one file with nothing else, so the Studio mirror, the verb boundary and the
 * tests all read the same answer, and an OP7 custom field can never fork it (spec §6b, fixed).
 */

export const PROJECT_STATUSES = ['draft', 'active', 'on_hold', 'closed'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === 'string' && (PROJECT_STATUSES as readonly string[]).includes(value);
}

/**
 * The legal transitions, exactly the spec §4 list: draft→active, active⇄on_hold, active→closed,
 * on_hold→closed, and the A24-gated, audit-logged reopen closed→active. Everything else is
 * `invalid_transition`, including a self-transition: "make it active again" on an active project is
 * a no-op the caller should not be asking for, and answering ok would hide a race.
 */
export const PROJECT_TRANSITIONS: readonly { readonly from: ProjectStatus; readonly to: ProjectStatus }[] = [
  { from: 'draft', to: 'active' },
  { from: 'active', to: 'on_hold' },
  { from: 'on_hold', to: 'active' },
  { from: 'active', to: 'closed' },
  { from: 'on_hold', to: 'closed' },
  { from: 'closed', to: 'active' },
];

export function isLegalTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_TRANSITIONS.some((t) => t.from === from && t.to === to);
}
