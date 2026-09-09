/**
 * B04 §H-ENUM: the single source for the retainer capability's closed enumerations.
 *
 * THREE ENUMS, nothing else, so the Studio mirror, the verb boundary and the tests all read the same
 * answer and an OP7 custom field can never fork any of them (spec §6b, fixed). None is a CHECK
 * constraint in the schema (the §D0 convention B01/B00 established): the enum lives here, validated at
 * the verb boundary, so the list stays in exactly one place.
 *
 * `RETAINER_STATUS` carries `draft` for completeness of the state machine (spec §4:
 * `draft -> active -> ended`), but the shipped verb set produces only `active` (create) and `ended`
 * (close): there is no `draft -> active` verb, so `draft` is the reserved pre-activation state, never
 * minted today. `generateInvoice`/`runDue` act only on `active` retainers.
 *
 * `RETAINER_DRAW_KIND` is the drawdown ledger's row taxonomy (spec §4 data model). `fee` is the
 * periodic Pauschale draw (one per retainer-period, the §H-IDEMPOTENT uniqueness guard); `time` is a
 * consumed-coverage or overage portion of a B01 entry; `carryover_out`/`carryover_in` are the paired
 * minute-conservation rows that roll unused coverage into the following period (US-B04.5).
 */

export const RETAINER_PERIODS = ['monthly', 'quarterly'] as const;
export type RetainerPeriod = (typeof RETAINER_PERIODS)[number];

export function isRetainerPeriod(value: unknown): value is RetainerPeriod {
  return typeof value === 'string' && (RETAINER_PERIODS as readonly string[]).includes(value);
}

export const RETAINER_STATUSES = ['draft', 'active', 'ended'] as const;
export type RetainerStatus = (typeof RETAINER_STATUSES)[number];

export function isRetainerStatus(value: unknown): value is RetainerStatus {
  return typeof value === 'string' && (RETAINER_STATUSES as readonly string[]).includes(value);
}

export const RETAINER_DRAW_KINDS = ['fee', 'time', 'carryover_in', 'carryover_out'] as const;
export type RetainerDrawKind = (typeof RETAINER_DRAW_KINDS)[number];

export function isRetainerDrawKind(value: unknown): value is RetainerDrawKind {
  return typeof value === 'string' && (RETAINER_DRAW_KINDS as readonly string[]).includes(value);
}
