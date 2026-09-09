/**
 * D03's §H-ENUM points, one place each (spec §4/§7). Validated at the verb boundary through a
 * transition table, never a CHECK constraint, so the vocabulary and the legal moves live in exactly
 * one place and §6b's "a custom field can never express status" holds by construction (the D01
 * `enums.ts` precedent). Pattern P7's discipline on D03's OWN columns, NOT new A10 document kinds.
 *
 * `SO_STATUS` is the sales-order lifecycle the OR 957a audit chain reads; `DN_STATUS` is the delivery
 * note's (an issued note is immutable, §H-AUDIT: a correction is a D01 `return` movement, never an
 * edit). The transition TABLES below are the single source every verb consults: `confirm` and
 * `cancel` are guarded moves a caller commands, while `delivery_issue` and `invoice` DERIVE the next
 * status from the line quantities (see `salesOrders.ts`) rather than naming a target, so the table
 * gates the commands and the derivation stays honest against it.
 */

/** The sales-order lifecycle. Terminal states are `invoiced` and `cancelled`. */
export const SO_STATUSES = [
  'draft',
  'confirmed',
  'partially_delivered',
  'delivered',
  'invoiced',
  'cancelled',
] as const;
export type SoStatus = (typeof SO_STATUSES)[number];
const SO_STATUS_SET: ReadonlySet<string> = new Set(SO_STATUSES);
export function isSoStatus(x: unknown): x is SoStatus {
  return typeof x === 'string' && SO_STATUS_SET.has(x);
}

/** The delivery-note lifecycle. `issued` is terminal (immutable Beleg); `cancelled` is draft-only. */
export const DN_STATUSES = ['draft', 'issued', 'cancelled'] as const;
export type DnStatus = (typeof DN_STATUSES)[number];
const DN_STATUS_SET: ReadonlySet<string> = new Set(DN_STATUSES);
export function isDnStatus(x: unknown): x is DnStatus {
  return typeof x === 'string' && DN_STATUS_SET.has(x);
}

/**
 * The COMMANDED sales-order transitions (Pattern P7). `confirm` moves a draft into one of the three
 * post-confirm states the engine derives (a pure-service order lands straight in `delivered`, a mixed
 * order in `partially_delivered`, an all-stock order in `confirmed`). `cancel` is draft/confirmed only
 * (the `has_deliveries` guard blocks even those when an issued note exists). Delivery and invoice do
 * NOT appear here: they derive the next status from quantities and write it directly, and the engine
 * asserts the FROM state is one this map already reaches.
 */
export const SO_TRANSITIONS: Readonly<Record<SoStatus, readonly SoStatus[]>> = {
  draft: ['confirmed', 'partially_delivered', 'delivered', 'cancelled'],
  confirmed: ['partially_delivered', 'delivered', 'cancelled'],
  partially_delivered: ['delivered', 'invoiced'],
  delivered: ['invoiced'],
  invoiced: [],
  cancelled: [],
};

/** True if `from -> to` is a legal sales-order transition. */
export function soCanTransition(from: SoStatus, to: SoStatus): boolean {
  return SO_TRANSITIONS[from].includes(to);
}

/** The one delivery-note transition table. `draft -> issued | cancelled`; `issued` is terminal. */
export const DN_TRANSITIONS: Readonly<Record<DnStatus, readonly DnStatus[]>> = {
  draft: ['issued', 'cancelled'],
  issued: [],
  cancelled: [],
};

export function dnCanTransition(from: DnStatus, to: DnStatus): boolean {
  return DN_TRANSITIONS[from].includes(to);
}
