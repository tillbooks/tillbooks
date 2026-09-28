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
 * The channel lifecycle (A36 §4.2, no new value): `draft -> keys_generated -> ini_sent ->
 * pending_bank_activation -> active`, with three departures from `active` each with a way back:
 * `bank_keys_changed` (the reviewed confirm returns to `active`), `blocked` (LOCAL only since A36; the
 * reviewed confirm is the exit), `retired` (terminal). Every non-terminal state has an exit.
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
 * The EBICS 3.0 / SMPG order types the channel uses since A36 (§4.5, download only), mirrored from the
 * specification, never invented: the version probe (HEV), the ceremony types (INI, HIA, HPB) and the
 * one banking order type, the download BTD (its receipt is recorded as a BTD row). BTU, HAC and SPR
 * left with the upload and the bank-side block (D-A36.11, D-A36.12). H3K is deliberately absent
 * ("order type H3K is not supported in Switzerland", SMPG §6.1).
 */
export const EBICS_ORDER_TYPE = ['INI', 'HIA', 'HPB', 'HEV', 'BTD'] as const;
export type EbicsOrderType = (typeof EBICS_ORDER_TYPE)[number];

/**
 * The order-log row status (§4.5). `ok`: a step the bank completed, or a member outcome that is FINAL
 * (`imported`, `already_imported`, `overlap_refused`); `failed`: a refused step, or a member outcome that
 * is re-run at the next sync (`bank_reason` names the code). The upload statuses left with BTU.
 */
export const EBICS_ORDER_STATUS = ['ok', 'failed'] as const;
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

/** The camt message the channel hands to A20 verbatim (A36 D-A36.3: camt.053 only, D140). */
export const CAMT_STATEMENT_MSG_NAMES = ['camt.053'] as const;
