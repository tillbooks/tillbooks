/**
 * D160/D161: THE COVERAGE PREDICATE BEHIND THE APPROVAL CLAIM, in ONE place.
 *
 * The public claim (D160.4 as narrowed in D162) is "By default, your agent waits for your OK before it
 * books anything, moves your money, grants access or deletes your data for good." It is true
 * exactly when every write whose consequence tag is `books`, `statutory`, `outbound`, `access` or
 * `erase` is governed by the dial by default (D160.1 (a) to (e)), or is excluded for one of the two
 * reasons accepted for a tagged write (human-only: the engine already refuses the agent seat).
 *
 * Two suites import this, so the rule cannot drift between them:
 *   - `test/agent/dial-covers-d161.test.mjs` holds the engine to it;
 *   - `test/web/positioning-claims.test.mjs` holds the COPY to it, so the claim fails the build the
 *     moment the code stops backing it.
 *
 * The population is read from the registry (`write:<class>:<tag>` on every registration line), which
 * `test/planning/reversibility-map-parity.test.mjs` holds equal to the reviewed map
 * (`docs/planning/reversibility/map.json`). Reading the registry keeps this module free of private
 * docs; the positioning suite checks the two populations are the same set.
 *
 * `uncovered()` is a function of the maps it is handed, so a bite test can weaken one and watch the
 * write surface by name.
 */

import { ACTIONS } from '../../dist/api/registry.js';
import { DIAL_CAPABILITY_FOR_ACTION, INPUT_KEYED_DIAL_RULES, NOT_DIAL_GOVERNED } from '../../dist/core/agent/index.js';

/**
 * The tags the claim names, written out here rather than read from `GATED_CONSEQUENCE_TAGS`: if the
 * engine's list ever shrank, a predicate built on it would shrink with it and stay green. The
 * positioning suite asserts the engine's list still equals this one.
 */
export const CLAIMED_TAGS = Object.freeze(['books', 'statutory', 'outbound', 'access', 'erase']);
const CLAIMED = new Set(CLAIMED_TAGS);

/** Every registered write tagged as gated by default (D160.1), sorted. */
export const TAGGED = Object.freeze(
  ACTIONS.filter((a) => a.kind === 'write' && CLAIMED.has(a.consequenceTag))
    .map((a) => a.name)
    .sort(),
);

/**
 * The only reasons a TAGGED write may stay off the dial, each a statement about the code. D161 records
 * both as human-only. (`portal_quote_accept`, once a third, is governed: the seam resolves its token.)
 */
export const TAGGED_EXCLUSIONS = Object.freeze({
  approve_drafted_action: /^human-only: approveDraftedAction refuses every governed seat/,
  set_agent_dial: /^human-only: setAgentDial refuses every governed seat/,
});

/**
 * The tagged writes that run with no Vorschlag: neither governed by name, nor by an input-keyed rule,
 * nor excluded for an accepted reason. An empty list is the claim being true.
 */
export function uncovered(
  byName = DIAL_CAPABILITY_FOR_ACTION,
  inputKeyed = INPUT_KEYED_DIAL_RULES,
  excluded = NOT_DIAL_GOVERNED,
  population = TAGGED,
) {
  const keyed = new Set(inputKeyed.map((r) => r.action));
  return population.filter((verb) => {
    if (byName[verb] !== undefined || keyed.has(verb)) return false;
    const pattern = TAGGED_EXCLUSIONS[verb];
    return !(pattern !== undefined && typeof excluded[verb] === 'string' && pattern.test(excluded[verb]));
  });
}
