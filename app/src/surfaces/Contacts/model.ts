/**
 * Shared shapes and pure helpers for the Contacts surface (A09, customers & vendors).
 *
 * These mirror the engine read model (camelCase per the Module 1 interface decision, G00). The
 * browser never imports engine code, so the shapes are re-declared here and kept deliberately
 * tolerant: an unknown extra field is ignored, a missing optional falls back to a safe default, and
 * an address that arrives flat (addressStreet) or nested (address.street) both resolve.
 */

/** The customer/vendor axis (spec A09 §4, a fixed §H-ENUM: A14 payments and A17 vendor bills route off it). */
export type PartyRole = 'customer' | 'vendor' | 'both';

/** Fixed render/select order for the role. */
export const PARTY_ROLES: readonly PartyRole[] = ['customer', 'vendor', 'both'];

/**
 * Currencies offered for a contact's default, mirroring the engine's `CURRENCIES` enum
 * (`src/core/setup/enums.ts`), which admits three.
 *
 * GBP used to be a fourth option here. `validateContactFields` rejects it with `invalid_currency`
 * (pinned by `test/sales/contact.test.mjs`), so picking it and pressing Speichern could only ever
 * produce an error banner: a dead end the form itself offered. Currency drift between this list and
 * the engine's is held shut by `Contacts.base-currency.test.tsx`, which reads the enum off disk.
 *
 * Which code is PRESELECTED is not decided here. It is the workspace base currency, read from
 * `get_company_profile`, so the GUI agrees with what `createContact` resolves for an unnamed
 * currency instead of overriding it with a literal.
 */
export const CURRENCIES: readonly string[] = ['CHF', 'EUR', 'USD'];

/**
 * C00's company|person axis, a fixed §H-ENUM mirroring the engine's `CONTACT_KINDS`
 * (`src/core/sales/contact.ts`). Distinct from `PartyRole`: a row carries BOTH, because "is this a
 * firm or a human" and "do I bill them or do they bill me" are orthogonal facts.
 */
export type ContactKind = 'company' | 'person';

/** Fixed render/select order for the kind. */
export const CONTACT_KINDS: readonly ContactKind[] = ['company', 'person'];

/**
 * C00's `ACTIVITY_KIND`, mirroring the engine's single enum point (`src/core/sales/contactActivity.ts`).
 * The OP5 timeline is one source of truth, so this list is fixed rather than workspace-defined.
 */
export type ActivityKind = 'note' | 'call' | 'email' | 'meeting' | 'task';

export const ACTIVITY_KINDS: readonly ActivityKind[] = ['note', 'call', 'email', 'meeting', 'task'];

/** One entry on a contact's timeline, as `contacts_timeline` sends it. */
export interface Activity {
  id: string;
  contactId: string;
  dealId?: string | null;
  kind: ActivityKind;
  body: string;
  occurredAt: string;
  userId?: string | null;
  createdAt?: string;
}

/** The SIX QR-bill structured-address shape (spec A09 §3, fixed by the Implementation Guidelines). */
export interface Address {
  street?: string;
  houseNo?: string;
  zip?: string;
  city?: string;
  country?: string;
}

export interface Contact {
  id: string;
  partyRole: PartyRole;
  name: string;
  address?: Address | null;
  vatNumber?: string | null;
  email?: string | null;
  defaultCurrency?: string | null;
  paymentTermsDays?: number | null;
  description?: string | null;
  archived?: boolean;
  createdAt?: string;
  // C00 CRM extension fields. All optional: a row written before C00 carries none of them, and the
  // read model is kept deliberately tolerant (an absent kind reads as a company, the engine default).
  kind?: ContactKind;
  companyContactId?: string | null;
  roles?: string[];
  segments?: string[];
  lang?: string | null;
  mergedIntoId?: string | null;
  /** E06 consent (C00-owned column): may a ledger-grounded draft consult this client's books. */
  ledgerGroundingEnabled?: boolean;
}

/** A contact's kind, defaulting to the engine's own default when the row predates C00. */
export function kindOf(contact: Contact): ContactKind {
  return contact.kind === 'person' ? 'person' : 'company';
}

/** A contact's tag list for one axis, always an array so callers need no guard. */
export function tagsOf(contact: Contact, axis: 'roles' | 'segments'): string[] {
  const raw = contact[axis];
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/** Every distinct segment across the loaded contacts, sorted, for the filter chips. */
export function allSegments(contacts: readonly Contact[]): string[] {
  const seen = new Set<string>();
  for (const c of contacts) for (const s of tagsOf(c, 'segments')) seen.add(s);
  return [...seen].sort((a, b) => a.localeCompare(b, 'de-CH'));
}

/**
 * Resolve a contact's structured address whether the read model nests it under `address` or carries
 * it as flat `addressStreet`/`addressHouseNo`/... columns. Always returns an object, never null, so
 * callers can read fields without a guard.
 */
export function addressOf(contact: Record<string, unknown>): Address {
  const nested = contact.address;
  if (nested !== null && typeof nested === 'object') {
    return nested as Address;
  }
  return {
    street: asString(contact.addressStreet),
    houseNo: asString(contact.addressHouseNo),
    zip: asString(contact.addressZip),
    city: asString(contact.addressCity),
    country: asString(contact.addressCountry),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** True only when every structured-address field is present: the QR-bill readiness condition. */
export function isQrReady(contact: Contact): boolean {
  const a = addressOf(contact as unknown as Record<string, unknown>);
  return (
    isFilled(a.street) &&
    isFilled(a.houseNo) &&
    isFilled(a.zip) &&
    isFilled(a.city) &&
    isFilled(a.country)
  );
}

function isFilled(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The ESTV UID format `CHE-###.###.###` with an optional ` MWST` suffix (spec A09 §3, fixed). Empty
 * is allowed (a name-only contact is valid): the caller only rejects a non-empty malformed value.
 */
const VAT_RE = /^CHE-\d{3}\.\d{3}\.\d{3}( MWST)?$/;

export function isValidVatNumber(value: string): boolean {
  const v = value.trim();
  return v === '' || VAT_RE.test(v);
}

/** Case-insensitive match of a query against a contact's name, city, MWST number or email. */
export function matchesSearch(contact: Contact, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const a = addressOf(contact as unknown as Record<string, unknown>);
  const haystack = [contact.name, a.city, contact.vatNumber, contact.email]
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/** A short, stable idempotency key for agent-safe writes (§H-IDEMPOTENT). */
export function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
