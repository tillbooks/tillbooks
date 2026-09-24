/**
 * E01's two §H-ENUM enums and the transition matrix, single-sourced (the E03 `enums.ts` shape).
 *
 * `SIGN_REQUEST_STATUS` is a LEGAL-TRACKING state machine: an auditor or a court reads it to
 * establish when and how a document was signed, so it is fixed (spec §6b) and no workspace can
 * redefine it. `SIGNATURE_LEVEL` is a legal classification anchored to ZertES / OR Art. 14 Abs.
 * 2bis, not a business taxonomy: `qes` is the level equivalent to a handwritten signature, `ses`
 * is everything below it.
 *
 * THE MATRIX IS DATA, NOT BRANCHES, so the engine and the transition-matrix test read the SAME
 * source and an edge added here is automatically held by both. The one deliberate asymmetry:
 * `draft -> signed` is legal (the manual/no-provider completion path, US-E01.4: `send` returned
 * `needs_provider` without transitioning, the operator completes with the wet-ink upload), while
 * `draft -> viewed` and `draft -> declined` are NOT, because a signer can neither view nor decline
 * an invitation that never went out.
 */

export const SIGN_REQUEST_STATUSES = ['draft', 'sent', 'viewed', 'signed', 'declined', 'expired'] as const;
export type SignRequestStatus = (typeof SIGN_REQUEST_STATUSES)[number];

export function isSignRequestStatus(value: unknown): value is SignRequestStatus {
  return typeof value === 'string' && (SIGN_REQUEST_STATUSES as readonly string[]).includes(value);
}

export const SIGNATURE_LEVELS = ['ses', 'qes'] as const;
export type SignatureLevel = (typeof SIGNATURE_LEVELS)[number];

export function isSignatureLevel(value: unknown): value is SignatureLevel {
  return typeof value === 'string' && (SIGNATURE_LEVELS as readonly string[]).includes(value);
}

/** Why an `expired` row expired: the deadline passed, or an operator withdrew a sent request. */
export const SIGN_EXPIRED_REASONS = ['deadline', 'withdrawn'] as const;
export type SignExpiredReason = (typeof SIGN_EXPIRED_REASONS)[number];

/**
 * Every legal edge of the machine, keyed by source status. `signed`, `declined` and `expired` are
 * terminal (empty edge sets), asserted by the matrix test rather than merely absent.
 */
export const SIGN_REQUEST_TRANSITIONS: Readonly<Record<SignRequestStatus, readonly SignRequestStatus[]>> = {
  draft: ['sent', 'signed'],
  sent: ['viewed', 'signed', 'declined', 'expired'],
  viewed: ['signed', 'declined', 'expired'],
  signed: [],
  declined: [],
  expired: [],
};

/** Is `from -> to` a legal edge? The ONE membership test every verb below uses. */
export function isLegalSignTransition(from: SignRequestStatus, to: SignRequestStatus): boolean {
  return SIGN_REQUEST_TRANSITIONS[from].includes(to);
}

/** The statuses the open-request guard blocks a second request behind (US-E01.1 Boundary). */
export const OPEN_SIGN_STATUSES = ['draft', 'sent', 'viewed'] as const;
