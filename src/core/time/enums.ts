/**
 * B01 §H-ENUM: the single source for the time spine's closed enumerations.
 *
 * TWO ENUMS AND ONE TRANSITION TABLE, nothing else, so the Studio mirror, the verb boundary and the
 * tests all read the same answer and an OP7 custom field can never fork either list (spec §6b,
 * fixed). The status machine is PERSISTED STATE OWNED HERE, deliberately not P7: a time entry is a
 * working-time record, not a document, so the A10 machine does not apply (the B00 reasoning).
 *
 * `billed` is IN the enum and OUT of this capability's reach: B01's own verbs advance an entry no
 * further than `locked`. B02 sets `billed` when the entry lands on an invoice line, which is why the
 * transition table below carries `locked -> billed` although no B01 verb performs it: the table
 * describes the machine, not this capability's keys to it.
 *
 * THE B02 RESERVED §H-ENUM TOUCH (04.08.2026, B02 build). B02 owns exactly one forward transition,
 * `approved -> billed`, and its release inverse `billed -> approved` (A11 cancels a time-backed draft
 * and B02 returns the entries to the unbilled pile). These are the ONLY two rows any capability other
 * than B01 adds here, and they are B02's whole write into this file (spec §4 state machine, §6b fixed).
 * `billed -> approved` is the single edge that leaves `billed`, and it leaves it only backwards, to the
 * state the entry was billed FROM: an entry never leaves `billed` toward anything new.
 */

export const TIME_STATUSES = ['open', 'submitted', 'approved', 'locked', 'billed'] as const;
export type TimeStatus = (typeof TIME_STATUSES)[number];

export function isTimeStatus(value: unknown): value is TimeStatus {
  return typeof value === 'string' && (TIME_STATUSES as readonly string[]).includes(value);
}

/**
 * The legal transitions, exactly the spec §4 chain: `open→submitted→approved→locked→billed`. A
 * strictly forward chain, deliberately: un-submitting is an edit story (`time_update` works on
 * `submitted`), un-approving does not exist (an approval a later verb could hollow out would not be
 * an approval). The one edge that runs backward is B02's `billed -> approved` release: an invoice
 * draft that carried a time-backed line was cancelled, so the entry returns to the unbilled pile.
 */
export const TIME_TRANSITIONS: readonly { readonly from: TimeStatus; readonly to: TimeStatus }[] = [
  { from: 'open', to: 'submitted' },
  { from: 'submitted', to: 'approved' },
  { from: 'approved', to: 'locked' },
  { from: 'locked', to: 'billed' },
  // B02 (reserved touch): approved time becomes an A11 invoice line, and a cancelled draft releases it.
  { from: 'approved', to: 'billed' },
  { from: 'billed', to: 'approved' },
];

export function isLegalTimeTransition(from: TimeStatus, to: TimeStatus): boolean {
  return TIME_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/** The statuses `time_update`/`time_delete` may still touch. From approval onward, time is frozen. */
export const EDITABLE_TIME_STATUSES: readonly TimeStatus[] = ['open', 'submitted'];

/**
 * The rate-card scopes, in PRECEDENCE ORDER: `resolveRate` (OP1) answers the first scope that has a
 * valid card, client before project before employee before default. NO `role` scope, reconciled
 * 04.08.2026: the engine has no employee-role register to resolve a role card against (A24 roles are
 * access roles, not billing roles); a billing-role scope arrives with an HR master (E02).
 */
export const RATE_CARD_SCOPES = ['client', 'project', 'employee', 'default'] as const;
export type RateCardScope = (typeof RATE_CARD_SCOPES)[number];

export function isRateCardScope(value: unknown): value is RateCardScope {
  return typeof value === 'string' && (RATE_CARD_SCOPES as readonly string[]).includes(value);
}
