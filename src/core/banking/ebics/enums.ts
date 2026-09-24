/**
 * A33, EBICS bank channel: the §H-ENUM single sources of truth for the channel and its order log.
 *
 * Each list is owned at exactly one point (spec §7) and validated at the verb boundary, never as a
 * SQLite CHECK, matching the §D0 convention A32's `ebillEnums.ts` set: a CHECK would be a second
 * enumeration point, which §6b forbids. Adding a value is one edit here plus a test.
 *
 * NONE of these enums is TILL's invention where a protocol owns it. `EBICS_ORDER_TYPE` is the EBICS
 * 3.0 / SMPG administrative and banking order-type set (BTU/BTD plus the ceremony types INI/HIA/HPB
 * and the protocol/admin types HAC/SPR); it is mirrored from the spec, never extended. The channel
 * `state` machine and the order `status`/`direction` lists are TILL's local lifecycle, owned here.
 */

/**
 * The channel lifecycle (spec §4 state machine): `draft -> keys_generated -> ini_sent ->
 * pending_bank_activation -> active`, with three departures from `active` each with a way back:
 * `bank_keys_changed` (re-confirm returns to `active`), `blocked` (SPR / bank-side; re-initialization
 * is the exit), `retired` (terminal). Every non-terminal state has an exit; no orphans.
 */
export const EBICS_CONNECTION_STATE = [
  'draft',
  'keys_generated',
  'ini_sent',
  'pending_bank_activation',
  'active',
  'bank_keys_changed',
  'blocked',
  'retired',
] as const;
export type EbicsConnectionState = (typeof EBICS_CONNECTION_STATE)[number];

/** The order log's two travel directions (spec §4). */
export const EBICS_ORDER_DIRECTION = ['upload', 'download'] as const;
export type EbicsOrderDirection = (typeof EBICS_ORDER_DIRECTION)[number];

/**
 * The EBICS 3.0 / SMPG order types A33 uses (spec §3/§4), mirrored from the specification, never
 * invented: the ceremony types (INI/HIA/HPB), the banking order types (BTU upload / BTD download),
 * and the protocol/admin types (HAC customer protocol, SPR standby/block). H3K is deliberately absent
 * ("order type H3K is not supported in Switzerland", SMPG §6.1).
 */
export const EBICS_ORDER_TYPE = ['INI', 'HIA', 'HPB', 'BTU', 'BTD', 'HAC', 'SPR'] as const;
export type EbicsOrderType = (typeof EBICS_ORDER_TYPE)[number];

/**
 * The order-log row status (spec §4). `intent` is the durable pre-upload trace whose missing
 * successor IS `transmit_in_doubt` (a DERIVED read-model state, never stored). `ok` covers a
 * completed non-payment order (a download, a ceremony step, an SPR); `pending_release` is a
 * transmitted payment file awaiting the bank's out-of-channel release; `bank_rejected` carries the
 * bank's business reason; `failed` reopens the transmit path.
 */
export const EBICS_ORDER_STATUS = ['intent', 'ok', 'pending_release', 'bank_rejected', 'failed'] as const;
export type EbicsOrderStatus = (typeof EBICS_ORDER_STATUS)[number];

export function isEbicsConnectionState(v: unknown): v is EbicsConnectionState {
  return typeof v === 'string' && (EBICS_CONNECTION_STATE as readonly string[]).includes(v);
}

export function isEbicsOrderStatus(v: unknown): v is EbicsOrderStatus {
  return typeof v === 'string' && (EBICS_ORDER_STATUS as readonly string[]).includes(v);
}

/**
 * The signature/encryption procedures and default key length agreed with the institution (SMPG §3.4),
 * captured PER CONNECTION, never a unilateral TILL constant. The default is the supported variation
 * (A005 electronic signature, X002 authentication, E002 encryption, 2048-bit). A client that
 * generates bigger keys uninvited may simply be refused, so this is a captured parameter, not a floor.
 */
export const EBICS_DEFAULT_KEY_PARAMS = Object.freeze({
  electronicSignature: 'A005',
  authentication: 'X002',
  encryption: 'E002',
  keyLength: 2048,
});

/** SMPG §6.1: TILL's own X.509 certificates carry unlimited validity so client-side expiry never strands a channel. */
export const EBICS_UNLIMITED_VALIDITY = '9999-12-31';

/** The camt message names A33 hands to A20 verbatim (spec §3/§4); routing reads the bytes, never edits them. */
export const CAMT_STATEMENT_MSG_NAMES = ['camt.053', 'camt.054', 'camt.052'] as const;
