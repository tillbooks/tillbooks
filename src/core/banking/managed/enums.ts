/**
 * A37, managed bank connectivity (the bLink relay behind A33's verbs): the §H-ENUM single sources of
 * truth for the managed channel and its order log.
 *
 * Same discipline as A33's `ebics/enums.ts` (spec A37 §7): each list is owned at exactly one point,
 * validated at the verb boundary, never as a SQLite CHECK (a CHECK would be a second enumeration
 * point). Adding a value is one edit here plus a test. NONE of these is credential-shaped: the
 * managed provider set names a platform, the state machine is TILL's local lifecycle, and neither
 * ever encodes a token, a certificate, or a password (spec §3 clause 1, tripwire 2).
 */

/**
 * The managed provider set (spec §4 data model, `managed_connection.provider`). v1 is bLink only;
 * SIX's central Swiss open-finance platform is the one relay the local seam routes to. Adding a
 * provider is one value here plus a test, never a schema migration.
 */
export const MANAGED_PROVIDER = ['blink'] as const;
export type ManagedProvider = (typeof MANAGED_PROVIDER)[number];

/**
 * The managed connection lifecycle (spec §4 state machine): `draft -> consent_pending -> active`,
 * with two departures from `active` each with a way back: `consent_revoked` (the customer revoked at
 * the bank; reconnect re-enters `consent_pending`), `suspended` (the vendor contract lapsed; the
 * owner-side condition clears back to `active`). `retired` is terminal. Every non-terminal state has
 * an exit; no orphans. There is deliberately no `keys_generated`-equivalent: the managed rail holds
 * no local key material, so there is no local ceremony to reach an intermediate state for.
 */
export const MANAGED_CONNECTION_STATE = [
  'draft',
  'consent_pending',
  'active',
  'consent_revoked',
  'suspended',
  'retired',
] as const;
export type ManagedConnectionState = (typeof MANAGED_CONNECTION_STATE)[number];

/** The order log's two travel directions (spec §4), mirroring A33's shape so the read model is one path. */
export const MANAGED_ORDER_DIRECTION = ['upload', 'download'] as const;
export type ManagedOrderDirection = (typeof MANAGED_ORDER_DIRECTION)[number];

/**
 * The managed order-log kinds (spec §4): the relay-facing operations the append-only log records. No
 * protocol invents these; they name what the local seam did (asked for consent, fetched statements,
 * folded a status report, submitted a payment, read the delivery log).
 */
export const MANAGED_ORDER_KIND = [
  'consent',
  'statements',
  'status_report',
  'payment_submit',
  'delivery_log',
] as const;
export type ManagedOrderKind = (typeof MANAGED_ORDER_KIND)[number];

/**
 * The order-log row status (spec §4), the A33 order-status set verbatim so the panel renders both
 * rails identically. `intent` is the durable pre-submit trace whose missing successor IS
 * `transmit_in_doubt` (a DERIVED read-model state, never stored); `ok` covers a completed non-payment
 * order; `pending_release` is a submitted payment awaiting the customer's release at the bank;
 * `bank_rejected` carries the bank's business reason; `failed` reopens the submit path.
 */
export const MANAGED_ORDER_STATUS = ['intent', 'ok', 'pending_release', 'bank_rejected', 'failed'] as const;
export type ManagedOrderStatus = (typeof MANAGED_ORDER_STATUS)[number];

/** The consent scopes a managed connection may carry (spec §4): AIS for data, PSS for payment submission. */
export const MANAGED_SCOPE = ['ais', 'pss'] as const;
export type ManagedScope = (typeof MANAGED_SCOPE)[number];

/**
 * The `channelKind` union at the ONE shared source (spec §7): verb inputs and status payloads both
 * read it, so a rail is data and never a second vocabulary. `ebics` is A33/A36; `managed_blink` is
 * this capability. Default is `ebics`, so every existing call is unchanged.
 */
export const CHANNEL_KIND = ['ebics', 'managed_blink'] as const;
export type ChannelKind = (typeof CHANNEL_KIND)[number];

export function isManagedConnectionState(v: unknown): v is ManagedConnectionState {
  return typeof v === 'string' && (MANAGED_CONNECTION_STATE as readonly string[]).includes(v);
}

export function isManagedOrderStatus(v: unknown): v is ManagedOrderStatus {
  return typeof v === 'string' && (MANAGED_ORDER_STATUS as readonly string[]).includes(v);
}

export function isChannelKind(v: unknown): v is ChannelKind {
  return typeof v === 'string' && (CHANNEL_KIND as readonly string[]).includes(v);
}
