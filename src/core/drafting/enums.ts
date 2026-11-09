/**
 * E06's one §H-ENUM point: the terminal outcome stamp of a draft run. NOT a lifecycle (spec §4:
 * the A10 machine is explicitly not applicable and is not forked, P7): a run happened once and its
 * row says how it ended, so failed work is visible rather than silently lost (US-E06.1 Error).
 *
 * The set is CLOSED (spec §6b Fixed): downstream tooling (the failed-run visibility, the
 * model-mismatch banner) is written against exactly these four values, and a plugin cannot mint a
 * fifth.
 */

export const DRAFT_RUN_STATUSES = ['ok', 'needs_local_runtime', 'needs_mailstore', 'failed'] as const;
export type DraftRunStatus = (typeof DRAFT_RUN_STATUSES)[number];

export function isDraftRunStatus(value: unknown): value is DraftRunStatus {
  return typeof value === 'string' && (DRAFT_RUN_STATUSES as readonly string[]).includes(value);
}
