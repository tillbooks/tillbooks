/**
 * G20 runbook templates: the cutover canon as SHIPPED PRODUCT DATA (US-G20.2 / US-G20.6), the G10
 * locale-pack precedent (shipped data read by verbs, never markdown a consultant re-types).
 *
 * THE TYPES LIVE IN `src/core/checklists/types.ts` SINCE G22 (D127) and are re-exported here
 * unchanged, so G20's canon, registry and `project.ts` import exactly what they always did. G22's
 * checklist items extend the same base (`RunbookTemplateItemBase`), which is how the two families
 * share one vocabulary for owner, due date, prerequisite, evidence and the undeletable mark.
 *
 * A template instantiates into `implementation_task` rows: each item carries an owner kind, an owner
 * ref, a due date computed as an OFFSET from the project's cutover date (negative = before cutover),
 * a prerequisite, the evidence it requires and a contingency note. Two item kinds are load-bearing:
 *   - `undeletable: true` marks the go/no-go and rollback tasks, which the engine refuses to delete
 *     (only `not_applicable` with a recorded reason, US-G20.2): the canon can be waived consciously,
 *     never dropped silently.
 *   - `deadlineRule` marks the statutory-deadline tasks whose due date is NOT an offset from cutover
 *     but a computed function of the fiscal year (the 180-day Umsatzabstimmung/Finalisierung, the
 *     240-day Berichtigung under Art. 72 MWSTG, and the prior-year Umsatzabstimmung produced from a
 *     G13 archive). The engine computes these dates at instantiation.
 *
 * Nothing in `project.ts` switches on a template id: a template is a list of items, and the engine
 * loops over the list. Adding a template is adding a row to TEMPLATE_REGISTRY.
 */

export type {
  RunbookPhase,
  RunbookOwnerKind,
  DeadlineRule,
  RunbookTemplateItemBase,
  RunbookTemplateItem,
  RunbookTemplate,
} from '../../checklists/types.js';
