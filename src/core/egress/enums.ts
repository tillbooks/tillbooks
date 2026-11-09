/**
 * E07's one §H-ENUM point (spec §7), single-sourced here so no verb, registry, or Studio surface
 * redeclares it.
 *
 * `EGRESS_STATE` is the closed set of things the trust indicator can honestly say:
 *
 *   `local`     the probe is installed AND has observed zero outbound sockets this session. The
 *               claim the whole cluster exists to make, and it is only ever said when it is measured.
 *   `unknown`   the probe could not install, so nothing is being observed. An UNVERIFIED claim
 *               renders as unverified, never as optimism (spec US-E07.2 Error): the failure mode of
 *               a trust indicator must be honesty, not a hopeful default.
 *   `violated`  the probe observed at least one outbound socket. We report our OWN violation loudly
 *               rather than degrade the claim quietly (spec US-E07.1 Error): a test that cannot fail
 *               is not evidence.
 *
 * There is deliberately no fourth state and no per-workspace customization of these three (spec §6b:
 * the enum is fixed at its single source, no custom state and no custom transition), because a
 * customizable trust state is a trust state that can be made to lie.
 */

export const EGRESS_STATES = ['local', 'unknown', 'violated'] as const;
export type EgressState = (typeof EGRESS_STATES)[number];

export function isEgressState(value: unknown): value is EgressState {
  return typeof value === 'string' && (EGRESS_STATES as readonly string[]).includes(value);
}
