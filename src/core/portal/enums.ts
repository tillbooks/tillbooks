/**
 * F02's two §H-ENUM enums, single-sourced (the E01 `enums.ts` shape).
 *
 * `PORTAL_GRANT_KIND` is the audience a grant is minted for. F02 builds the CUSTOMER side; F03
 * (vendor portal) SHARES this table and this enum, so the kind is a fixed classification, not a
 * per-workspace taxonomy (spec §6b, fixed). `PORTAL_SCOPE_KIND` is what gates which confidential
 * financial and legal records a token can reach, so it too is fixed and single-sourced (spec §6b,
 * fixed): a customizable scope list would reopen the exact leak this capability exists to close.
 *
 * BOTH ARE ENFORCED BY THE ENGINE, NOT BY CHECK CONSTRAINTS (the E03/C00/E01 pattern): the single
 * source of truth is this file, so a spec that legitimately adds a value does so in one place
 * without a migration.
 */

/** The audience a grant is minted for. F03 shares the table with `vendor`. */
export const PORTAL_GRANT_KINDS = ['customer', 'vendor'] as const;
export type PortalGrantKind = (typeof PORTAL_GRANT_KINDS)[number];

export function isPortalGrantKind(value: unknown): value is PortalGrantKind {
  return typeof value === 'string' && (PORTAL_GRANT_KINDS as readonly string[]).includes(value);
}

/**
 * The kinds of record a scope entry may name. `invoice`/`quote`/`document` are entity-explicit
 * (they carry an `id`); the rest are WILDCARDS (no id): `all_invoices` is F02's customer wildcard,
 * an explicit opt-in flagged in the create UI ("gibt alle künftigen Rechnungen frei", spec US-F02.5
 * boundary), and `pos.read`/`remittance.read` are F03's VENDOR scope set (spec F03 §4/§7). A vendor
 * grant names no explicit entity: it exposes exactly the grant contact's OWN open POs (D02) and its
 * remittance advices (A14/A17), so the scope is a read capability, not an entity reference, and
 * carries no id and passes no per-entity contact fence. The vendor read verbs enforce the
 * contact fence on the grant's own `contact_id` instead (F03 spec §2 US-F03.2). Both wildcard sets
 * are single-sourced here (§H-ENUM), so a spec that adds one adds it in one place.
 */
export const PORTAL_SCOPE_KINDS = [
  'invoice',
  'quote',
  'document',
  'all_invoices',
  'pos.read',
  'remittance.read',
] as const;
export type PortalScopeKind = (typeof PORTAL_SCOPE_KINDS)[number];

export function isPortalScopeKind(value: unknown): value is PortalScopeKind {
  return typeof value === 'string' && (PORTAL_SCOPE_KINDS as readonly string[]).includes(value);
}

/** The scope kinds that carry an entity id (everything except the wildcard kinds). */
export const PORTAL_ID_SCOPE_KINDS = ['invoice', 'quote', 'document'] as const;

/**
 * The WILDCARD scope kinds: they carry no id and pass no per-entity contact fence at create time,
 * because the fence they ride is the grant's own `contact_id` at read time. `all_invoices` is F02's
 * (every one of a customer's invoices); `pos.read`/`remittance.read` are F03's vendor read set.
 */
export const PORTAL_WILDCARD_SCOPE_KINDS = ['all_invoices', 'pos.read', 'remittance.read'] as const;
export type PortalWildcardScopeKind = (typeof PORTAL_WILDCARD_SCOPE_KINDS)[number];
/** The scope kinds that carry an entity id (the complement of the wildcard set). */
export type PortalIdScopeKind = (typeof PORTAL_ID_SCOPE_KINDS)[number];

export function isPortalWildcardScopeKind(value: unknown): value is PortalWildcardScopeKind {
  return typeof value === 'string' && (PORTAL_WILDCARD_SCOPE_KINDS as readonly string[]).includes(value);
}

/** F03's vendor scope set, single-sourced (spec F03 §4/§7). */
export const VENDOR_PORTAL_SCOPE_KINDS = ['pos.read', 'remittance.read'] as const;

/**
 * The maximum validity window of a grant, in days (spec §2 boundary / §3 revDSG minimisation). A
 * longer `expiresAt` is CLAMPED to this and the response flags `clamped:true`, never refused: the
 * operator's intent to share is honoured, the over-long window is not. Ninety days is the default
 * the spec names; it is a single constant here rather than a per-workspace setting, because no such
 * setting is built yet and the clamp must exist from birth (spec §6b: the clamp is a workspace
 * compliance setting outside the OP7-OP10 customization surface).
 */
export const PORTAL_MAX_VALIDITY_DAYS = 90;
