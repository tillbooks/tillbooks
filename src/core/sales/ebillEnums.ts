/**
 * A32, eBill issuing: the §H-ENUM single sources of truth for the delivery record.
 *
 * Each list is owned at exactly one point (spec §7) and validated at the verb boundary, never as a
 * SQLite CHECK, matching the §D0 convention D00's `itemEnums.ts` set: a CHECK would be a second
 * enumeration point, which §6b forbids. Adding a value is one edit here plus a test.
 *
 * `EBILL_PARTNER_STATUS` is DIFFERENT in kind: TILL does NOT own it. It is the SWP business-case
 * status enum (`swp-nwp-api-v1-swagger.yaml`, fetched 2026-07-20), MIRRORED verbatim. The list is
 * kept only so a label can be rendered; `mirrorEbillPartnerStatus` stores whatever the partner
 * reported, and an UNKNOWN reported value survives round-trip rather than being dropped (spec §7,
 * asserted by test). TILL never forks, renames, or extends a status another system owns.
 */

/** The local delivery machine's states (spec §4). `failed` is terminal for a row; a successor is a fresh prepare. */
export const EBILL_DELIVERY_STATUS = ['prepared', 'submitting', 'transmitted', 'failed'] as const;
export type EbillDeliveryStatus = (typeof EBILL_DELIVERY_STATUS)[number];

/**
 * The SWP `X-BCFORMAT` value TILL emits. Only `qrbill` is enabled: it is the one format A11 already
 * produces the substrate for (the embedded Swiss QR Code). The other swagger values
 * (`yellowbill`, `fscmxml`, `zugferd.*`) are known and deliberately not enabled until a partner
 * contract makes one real (spec §3/§4).
 */
export const EBILL_FORMAT = ['qrbill'] as const;
export type EbillFormat = (typeof EBILL_FORMAT)[number];

/**
 * The SWP `X-BCFUNCTION` value TILL emits. Only `bill`; `reminder`/`creditnote`/`advice` arrive with
 * the A15/A13 riders (spec §3).
 */
export const EBILL_BC_FUNCTION = ['bill'] as const;
export type EbillBcFunction = (typeof EBILL_BC_FUNCTION)[number];

/**
 * The SWP business-case status enum, MIRRORED verbatim (not owned). Stored as reported; an unknown
 * value is surfaced as-is, never coerced into this list.
 */
export const EBILL_PARTNER_STATUS = ['NWP_PENDING', 'OPEN', 'APPROVED', 'REJECTED', 'COMPLETED'] as const;
export type EbillPartnerStatus = (typeof EBILL_PARTNER_STATUS)[number];

export function isEbillDeliveryStatus(v: unknown): v is EbillDeliveryStatus {
  return typeof v === 'string' && (EBILL_DELIVERY_STATUS as readonly string[]).includes(v);
}

/** The SWP `billerPid` shape: `41` followed by 15 digits (swagger `billerPid` pattern `41[0-9]{15}`). */
export const BILLER_PID_PATTERN = /^41[0-9]{15}$/;

/**
 * The interface recommendation's cap: "The size must not exceed 10 MB after being signed by the NWP"
 * (InterfaceRecommendationSIXeBill-1.01.pdf, §3 grounding). The swagger itself defines no size limit;
 * this is the voluntary recommendation, enforced at the transmit boundary.
 */
export const EBILL_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

/** The PDF/A profile the SWP submission requires ("Create business case in PDF/A-3b-format"). */
export const EBILL_REQUIRED_PDFA_PROFILE = 'PDF/A-3b';
