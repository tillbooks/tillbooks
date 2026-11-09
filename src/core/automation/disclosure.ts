/**
 * G01 §4, the disclosure gate: `read_automations` buys the AUTOMATION facts, never another domain's data.
 *
 * THE DEFECT THIS EXISTS FOR, measured on 29.07.2026 with the shipped `viewer` role. A viewer holds
 * `read_books`, `read_vat`, `read_sales`, `read_master_data` and `read_automations`, and is denied
 * exactly one read domain: `read_members`. A rule whose action is `invite_member` is exactly a
 * `read_members`-domain write, and its payload carries the invitee's email address. The viewer was
 * refused `list_members` and then read `geheim.treuhaender@kanzlei.ch` straight out of
 * `get_automation_run`. The same string was equally readable through `get_automation_rule`, because
 * the rule carries the configured template and the run carries the resolved one, so a fix to the run
 * log alone would have closed a door and left the window open one verb over.
 *
 * WHY THE BOUNDARY CANNOT DO THIS, which is true and is not a reason to leave it undone. A24 gates on
 * the verb and its INPUT; the domain a run touched is a property of the ROW (`action_tool`), which the
 * boundary never sees. That is the same limit `unlock_period` is written around, and this repo's
 * answer to it is already established twice: `unlock_period`'s second gate is state-dependent and
 * lives in the engine, and the saved-view writes assert inside `core/customization/views.ts`. This is
 * the third instance of the same pattern, not a new one.
 *
 * WITHHOLD, DO NOT OMIT, AND SAY SO. A row that carries `actionInput: null, withheld: 'read_members'`
 * states a fact: this firing happened, and its payload belongs to a domain you cannot read. The
 * objection that "a redacted log lies about what was sent" has it backwards. What lies is a log
 * presenting itself as scoped to `read_automations` while serving four other domains' payloads. The
 * automation facts a person needs to supervise the subsystem (what fired, when, as whom, with what
 * outcome and which rejection code) are all still there, and none of them belong to another domain.
 *
 * IT REUSES A24's OWN MAP RATHER THAN RESTATING POLICY. `requiredCapabilitiesFor` is the same
 * function the registry boundary calls, so a capability that appends a verb next month is covered
 * here with nobody editing this file, and the answer here can never disagree with the answer there.
 *
 * THE BAR IS THE ACTION'S OWN CAPABILITY, NOT THE TARGET DOMAIN'S READ CAPABILITY, and this is a
 * deliberate divergence from the shape the critic sketched (`withheld: 'read_members'`). The rule
 * here is: YOU MAY SEE WHAT WAS SENT IF AND ONLY IF YOU COULD HAVE SENT IT YOURSELF. Naming the read
 * domain instead would be better calibrated (a Treuhänder holding `read_members` but not
 * `manage_members` can already see that email in `list_members`, and is refused it here), and it was
 * rejected anyway, because there is no write-verb-to-read-domain map in this repo and building one
 * would be a SECOND policy point beside A24's, maintained by hand, silently wrong for every verb
 * somebody forgot. That is precisely the failure mode that produced both of this week's findings:
 * G1's false exemption and `readCapabilityForKind`'s silent `default:`. A derived answer that is a
 * little too strict beats a hand-kept one that is occasionally too loose, on a subsystem whose whole
 * job is writing to the ledger when nobody is watching.
 *
 * THE COST IS REAL AND IS ACCEPTED: a `viewer` supervising the Verlauf now sees no payloads at all,
 * because a viewer holds no write capability. It still sees every automation fact (which rule, which
 * event, which tool, which status, which rejection code, as whom, when), which is what supervising
 * the subsystem needs, and the withheld field names what would unlock the rest.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER, stated so it is a bounded decision rather than an oversight.
 * The TRIGGER side (`eventRef`, and a condition predicate over the event payload) can name an entity
 * id in a domain the reader lacks: `journal.posted:entry_5` tells a reader without `read_books` that
 * an entry exists. That is an opaque id and not content, the trigger events have no read domain
 * declared on them the way an action verb does, and inventing one would be a second policy point
 * beside A24's map, which is the thing this file exists to avoid. The action payload is where the
 * DATA is, it is exactly derivable, and it is what was measured.
 */

import type { Capability } from '../access/capabilities.js';
import { requiredCapabilitiesFor } from '../access/actionCapabilities.js';
import type { WorkspaceContext } from '../context.js';

/**
 * The first capability the caller lacks for this row's action, or undefined when it may see it all.
 *
 * FAILS CLOSED ON EVERY UNCERTAINTY, and there are two. `requiredCapabilitiesFor` throws on a verb
 * with no declared rule, which a stored row can name after a verb is renamed or retired; and a stored
 * payload may not parse. Both answer `manage_custom_fields`, the capability no built-in role holds,
 * which is the same fail-closed answer `readCapabilityForKind` gives an unknown entity kind. A row
 * naming a verb this build cannot resolve is a row whose domain is unknown, and an unknown domain is
 * never a readable one.
 */
export function withheldCapability(
  ctx: WorkspaceContext,
  actionTool: string,
  actionInput: Record<string, unknown>,
): Capability | undefined {
  let required: readonly Capability[];
  try {
    required = requiredCapabilitiesFor(actionTool, actionInput);
  } catch {
    return 'manage_custom_fields';
  }
  for (const capability of required) {
    if (!ctx.capabilities.assert(capability).ok) return capability;
  }
  return undefined;
}
