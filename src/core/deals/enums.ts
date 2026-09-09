/**
 * C01 §H-ENUM: the single source for the deal spine's closed enumerations.
 *
 * `DEAL_STATUSES` is deliberately GLOBAL and fixed while the stage names are per-pipeline rows
 * (spec §6b): C03 forecasting and the quote-conversion eligibility both key off exactly these three
 * values, so a workspace can rename its funnel but never mint a fourth terminal state. `open` is a
 * legal `deals_mark` target on purpose: a misclicked "won" must be reversible by writing the row
 * again (the denylist's own criterion for what stays automatable), so reopening is a first-class
 * transition rather than a support incident.
 *
 * `STAGE_OUTCOMES` is the flag a `pipeline_stage` row may carry: entering such a stage is what
 * derives a terminal `status`, and ONLY `markDeal` may perform that move (spec §2, one door).
 */

export const DEAL_STATUSES = ['open', 'won', 'lost'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

const DEAL_STATUS_SET: ReadonlySet<string> = new Set(DEAL_STATUSES);

export function isDealStatus(value: unknown): value is DealStatus {
  return typeof value === 'string' && DEAL_STATUS_SET.has(value);
}

/** What a `pipeline_stage.outcome` may hold besides NULL: the stage that wins, the stage that loses. */
export const STAGE_OUTCOMES = ['won', 'lost'] as const;
export type StageOutcome = (typeof STAGE_OUTCOMES)[number];

const STAGE_OUTCOME_SET: ReadonlySet<string> = new Set(STAGE_OUTCOMES);

export function isStageOutcome(value: unknown): value is StageOutcome {
  return typeof value === 'string' && STAGE_OUTCOME_SET.has(value);
}
