/**
 * D161.2: A PLUGIN'S CALL IS NEVER A PERSON'S CALL.
 *
 * The bridge (`runPluginToolCall`, `sandbox.ts`) dispatches a plugin's tool call AS the member who
 * installed the plugin, so A24 binds the call to that member's rights. Every human-only check reads
 * the actor, and the installer is a person, so before this scope plugin code passed them all: a G20
 * sign-off, a statement-gap confirmation, a dial grant, an approval of a drafted action.
 *
 * While the bridge runs a call, the plugin's actor is on this stack, and `isGovernedSeat`
 * (`access/capability.ts`, the ONE rule every human-only check reads, `actorIsHuman` included) answers
 * true for it: the plugin is a machine, exactly like the agent seat. The engine is synchronous (one
 * SQLite connection, no awaits inside a verb), so nothing else runs while the scope is open, and it is
 * closed in a `finally`, so it never outlives the call: the installer acting in person is a person
 * again. Only the plugin's own actor is marked; a check about another actor (a stored `updated_by`, a
 * candidate list) answers as before.
 *
 * Kept free of imports so `access/capability.ts` can read it without a module cycle.
 */

const activePluginActors: string[] = [];

/** Run `call` with `actor` marked as a plugin's (a governed, non-human seat) for its whole duration. */
export function withinPluginCall<T>(actor: string, call: () => T): T {
  activePluginActors.push(actor);
  try {
    return call();
  } finally {
    activePluginActors.pop();
  }
}

/** Is `actor` the actor of a plugin call that is running right now? */
export function isPluginCallActor(actor: string): boolean {
  return activePluginActors.length > 0 && activePluginActors.includes(actor);
}
