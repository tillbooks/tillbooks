// D202 point 5 (owner, 15.11.2026): what an agent seat's call on a PROTECTED (human-only) setting answers
// through the transport since D202 reversed D183 for proposals. The agent never applies it: the call is a
// person-only Vorschlag (`drafted: true`, `reason: person_only`) or a refusal (an ask-first question, the open
// cap, a missing right). Suites that held D183's "refused, also as a proposal" assert this instead, beside
// their own row counts (the stored setting unchanged).

import assert from 'node:assert/strict';

/** True when the answer applied nothing: a person-only Vorschlag, a refusal, or a no-op answered `unchanged`. */
export function proposedOrRefused(res) {
  if (res === null || typeof res !== 'object') return false;
  if (res.ok === false) return true;
  if (res.unchanged === true && res.changed === false) return true;
  return res.drafted === true && res.reason === 'person_only' && res.changed !== true;
}

/** Assert the agent's call on a protected setting applied nothing (see the module note). */
export function assertNotApplied(res, label = '') {
  assert.ok(proposedOrRefused(res), `${label}: a protected setting is only proposed by the agent, never applied: ${JSON.stringify(res).slice(0, 300)}`);
}

/** The pending person-only settings Vorschläge of a workspace. */
export function settingsDrafts(db, workspaceId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND action_tool IN ('settings_set', 'settings_reset')")
    .get(workspaceId).n;
}
