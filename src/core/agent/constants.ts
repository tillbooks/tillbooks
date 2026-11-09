/**
 * A35's tuning constants, named and defended in ONE place so no surface, verb or test restates a
 * magic number. Every value here is a STARTING position for measurement, flagged as such in the
 * design's derived-versus-invented ledger (design §0), not a derived fact.
 */

/**
 * A connectionless caller (the REST twin) joins the actor's open session, or a new one after this
 * idle gap. An MCP connection needs no gap: one connection is one session, keyed by its transport
 * key, so a session is never something the CLIENT chooses (a client that could pick its own session
 * id could hide a call in a session nobody reads).
 */
export const SESSION_IDLE_MINUTES = 30;

/**
 * Calls arriving within this gap of the open turn's last call join that turn; a longer silence opens
 * a new one. It mirrors how an agent works one instruction (a burst of calls, then quiet). This is a
 * DISPLAY grouping only, never a correctness boundary: no invariant may depend on where a turn
 * breaks, and the trace-completeness assertion counts CALLS, not turns.
 */
export const TURN_GAP_SECONDS = 120;

/**
 * The trace (sessions, turns, calls, and with them any prose, D90 D-5) is pruned past this age.
 * Pruning never touches a ledger effect: the statutory record is A03's audit chain, which is
 * permanent. Never shorter than the open fiscal year by construction (24 months > 12).
 */
export const TRACE_RETENTION_MONTHS = 24;

/** The trust table's default evidence window. Every figure states its window; this is the default. */
export const TRUST_WINDOW_DAYS = 90;

/**
 * D90 D-3: after this many approvals with ZERO rejections inside the window, the trust row offers
 * the D103 grant act once. Defended: twenty is two-plus working weeks of daily approvals, so the
 * suggestion is earned by a rhythm rather than by one good afternoon; and it deliberately equals the
 * queue's grouping threshold so the surface carries one scale, not two. A declined suggestion stores
 * a per-capability dismissal and never returns.
 */
export const TRUST_SUGGEST_THRESHOLD = 20;
