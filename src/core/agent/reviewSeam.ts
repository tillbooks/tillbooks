/**
 * The A25 seam, WIRED to the real Treuhänder review module at batch-1 integration.
 *
 * US-A26.5 (detect_anomalies) may FLAG a suspect entry and US-A26.7 composes A25's `prepare_period`.
 * A26 was built concurrently with A25 (review & export) against this NARROW interface so it could
 * gate STANDALONE, behind a safe local default that DECLINED (`review_unavailable`). Now that A25 has
 * landed, the default is backed by A25's exported `flagEntry`/`preparePeriod`: the interface is
 * unchanged, so nothing in A26's own logic moves, and the two integration points reach the real
 * `entry_review` sidecar instead of a stub.
 *
 * SIGNATURE ADAPTATION. A25's `flagEntry`/`preparePeriod` REQUIRE an `idempotencyKey` (they collapse
 * a redelivered call onto one `entry_review` row); the seam does not carry one, because the agent
 * flags an ENTRY and prepares a PERIOD, and each is a single logical occurrence. So the seam derives
 * a DETERMINISTIC key from the entity it acts on (`agent-flag:<entryId>`, `agent-prepare:<period>`):
 * flagging the same anomaly twice records ONE flag, and a period re-prepare replays A25's stored
 * packet rather than duplicating it, which is exactly the occurrence semantics A25 already documents.
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { flagEntry as reviewFlagEntry, preparePeriod as reviewPreparePeriod } from '../review/index.js';

export interface ReviewSeam {
  /** Flag a suspect entry for Treuhänder review (A25). Returns the flag, or a rejection. */
  flagEntry(ctx: WorkspaceContext, input: { entryId: string; reason: string }): Result;
  /** Produce A25's review packet for a period (US-A26.7 composes this). */
  preparePeriod(ctx: WorkspaceContext, input: { period: string }): Result;
}

/**
 * The wired seam: both operations reach A25's real review module. The idempotency key is derived from
 * the entity (see the module note) so the seam stays a single-occurrence call from A26's side.
 */
export const reviewSeam: ReviewSeam = {
  flagEntry: (ctx, input) =>
    reviewFlagEntry(ctx, {
      entryId: input.entryId,
      reason: input.reason,
      idempotencyKey: `agent-flag:${input.entryId}`,
    }),
  preparePeriod: (ctx, input) =>
    reviewPreparePeriod(ctx, {
      period: input.period,
      idempotencyKey: `agent-prepare:${input.period}`,
    }),
};
