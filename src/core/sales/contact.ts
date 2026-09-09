/**
 * A09 contacts, EXTENDED by C00 into the CRM spine (companies + people, roles, tags, segments,
 * dedupe/merge, the OP5 activity log).
 *
 * A09 gave the financial core a flat customers/vendors master: the handful of facts a Swiss invoice
 * and its QR-bill consume (structured address, MWST number, default currency, payment terms). C00
 * EXTENDS that same row rather than forking it, adding a second orthogonal axis (`kind`
 * company|person), an employer link, free-text roles/segments, a language, a merge tombstone and the
 * per-contact E06 consent flag. There is still no ledger posting here: master data is not a financial
 * event, so a contact is mutable, archive is a soft flag, and a merge has zero financial effect (P3,
 * upheld by the absence of any `postEntry` call in this module and its siblings).
 *
 * Columns are snake_case, the verb surface is camelCase, and the two meet only in `mapContact`.
 * Creates accept an optional idempotencyKey (§H-IDEMPOTENT); every row stamps workspace_id
 * (§H-TENANT). The activity log, merge and anonymise verbs live in the sibling modules
 * `contactActivity.ts`, `contactMerge.ts` and `contactImport.ts` and reuse the helpers exported here.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { CURRENCIES } from '../setup/enums.js';
import { baseCurrencyOf } from '../fx/rates.js';
import { applySavedView } from '../customization/views.js';
import { firstDisallowedQrChar } from './qrbill.js';

/** The ESTV UID/MWST format an auditor checks verbatim (spec §6b, fixed). */
const VAT_NUMBER_RE = /^CHE-\d{3}\.\d{3}\.\d{3} MWST$/;
/** The bare UID core, without the MWST suffix, used by the free-text parser. */
const VAT_CORE_RE = /(CHE-\d{3}\.\d{3}\.\d{3})/;

const PARTY_ROLES: ReadonlySet<string> = new Set(['customer', 'vendor', 'both']);

/**
 * C00's `CONTACT_KIND`, the §H-ENUM single source of truth (spec §6b, fixed: the employer-link
 * validation and the merge FK re-point logic branch on it structurally, not as a preference).
 */
export const CONTACT_KINDS: readonly string[] = ['company', 'person'];
const CONTACT_KIND_SET: ReadonlySet<string> = new Set(CONTACT_KINDS);

/** The languages a contact's correspondence may be in (P11). de-CH/it-CH carry the region (§H-ENUM). */
const CONTACT_LANGS: ReadonlySet<string> = new Set(['de-CH', 'en', 'fr-CH', 'it-CH']);

/** Tag hygiene (US-C00.2): trimmed, at most 40 chars each, at most 50 per contact. */
const MAX_TAG_LEN = 40;
const MAX_TAGS_PER_CONTACT = 50;

export interface ContactAddress {
  street?: string;
  houseNo?: string;
  zip?: string;
  city?: string;
  country?: string;
}

export interface CreateContactInput {
  partyRole: string;
  name?: string;
  address?: ContactAddress;
  vatNumber?: string;
  email?: string;
  defaultCurrency?: string;
  paymentTermsDays?: number;
  description?: string;
  idempotencyKey?: string;
  // C00 CRM extension fields.
  kind?: string;
  companyContactId?: string;
  roles?: string[];
  segments?: string[];
  lang?: string;
  ledgerGroundingEnabled?: boolean;
}

export interface ContactPatch {
  partyRole?: string;
  name?: string;
  address?: ContactAddress;
  vatNumber?: string;
  email?: string;
  defaultCurrency?: string;
  paymentTermsDays?: number;
  // C00 CRM extension fields.
  kind?: string;
  companyContactId?: string | null;
  roles?: string[];
  segments?: string[];
  lang?: string | null;
  ledgerGroundingEnabled?: boolean;
}

export interface ContactRow {
  id: string;
  workspace_id: string;
  party_role: string;
  name: string;
  address_street: string | null;
  address_house_no: string | null;
  address_zip: string | null;
  address_city: string | null;
  address_country: string | null;
  vat_number: string | null;
  email: string | null;
  default_currency: string;
  payment_terms_days: number;
  archived: number;
  created_at: string;
  kind: string;
  company_contact_id: string | null;
  roles: string;
  segments: string;
  lang: string | null;
  merged_into_id: string | null;
  ledger_grounding_enabled: number;
}

/** Parse a JSON array column into a string array, tolerant of a NULL or malformed value. */
function parseTags(raw: string | null): string[] {
  if (raw === null || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function mapContact(row: ContactRow) {
  const hasAddress =
    row.address_street !== null ||
    row.address_house_no !== null ||
    row.address_zip !== null ||
    row.address_city !== null ||
    row.address_country !== null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    partyRole: row.party_role,
    name: row.name,
    address: hasAddress
      ? {
          street: row.address_street,
          houseNo: row.address_house_no,
          zip: row.address_zip,
          city: row.address_city,
          country: row.address_country,
        }
      : null,
    vatNumber: row.vat_number,
    email: row.email,
    defaultCurrency: row.default_currency,
    paymentTermsDays: row.payment_terms_days,
    archived: row.archived === 1,
    createdAt: row.created_at,
    // C00 CRM extension fields.
    kind: row.kind,
    companyContactId: row.company_contact_id,
    roles: parseTags(row.roles),
    segments: parseTags(row.segments),
    lang: row.lang,
    mergedIntoId: row.merged_into_id,
    ledgerGroundingEnabled: row.ledger_grounding_enabled === 1,
  };
}

export function readContact(ctx: WorkspaceContext, contactId: string): ContactRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId) as ContactRow | undefined;
}

/**
 * Follow a merge tombstone to the surviving contact (US-C00.4). A merge chain (A merged into B,
 * B merged into C) resolves transitively so a read of A lands on C. Guarded against a cycle (which a
 * one-way `merged_into_id` cannot create, but a hand-edited database could) by a bounded walk.
 */
export function resolveMergeChain(ctx: WorkspaceContext, row: ContactRow): ContactRow {
  let current = row;
  const seen = new Set<string>([current.id]);
  while (current.merged_into_id !== null) {
    const next = readContact(ctx, current.merged_into_id);
    if (next === undefined || seen.has(next.id)) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

/** What a contact id resolves to once a merge tombstone is followed. */
export interface ResolvedContactRef {
  /** The live contact the id lands on. Equal to the id asked for when nothing was merged. */
  id: string;
  /** The live contact's display name, or null when the id names no row in this tenant. */
  name: string | null;
  /** The id the caller passed, when it was a tombstone. Null when nothing was redirected. */
  mergedFrom: string | null;
}

/**
 * THE ONE READ-SIDE RESOLVER for a contact id that an append-only row froze.
 *
 * A14 freezes `payment.counterparty_id` behind a DB immutability trigger (`payment_no_money_update`),
 * so a merge cannot re-point it and must not try: the fact that this money arrived from that row is
 * a fact, and rewriting it would be the destructive edit the ledger forbids. What DOES have to move
 * is every READ of it. Without that, a merged customer's balance and their aging bucket SPLIT across
 * the tombstone and the survivor: the survivor gets dunned while the customer's credit sits under an
 * id `list_contacts` deliberately hides, which is exactly the splitting C00 exists to end.
 *
 * It is ONE function on purpose. The chain walk was previously added to two of eight readers, which
 * is the shape of defect a shared resolver makes impossible: a ninth reader cannot be written without
 * reaching for this, and there is no second copy to forget.
 *
 * A missing row resolves to itself with a null name, which is what the LEFT JOINs it replaces already
 * reported: a read model never turns an unknown id into a rejection (§H-TENANT, a neighbour's ids
 * must not be probeable one call at a time).
 */
export function resolveContactRef(
  ctx: WorkspaceContext,
  contactId: string | null | undefined,
): ResolvedContactRef | null {
  if (contactId === null || contactId === undefined || contactId.length === 0) return null;
  const row = readContact(ctx, contactId);
  if (row === undefined) return { id: contactId, name: null, mergedFrom: null };
  const survivor = resolveMergeChain(ctx, row);
  return {
    id: survivor.id,
    name: survivor.name,
    mergedFrom: survivor.id === row.id ? null : row.id,
  };
}

/**
 * Every contact row that IS one identity: the named contact plus every tombstone that merged into it,
 * transitively. A merge consolidates a relationship onto one row and leaves the duplicates' personal
 * fields sitting in their own rows, so an erasure that only touched the row it was handed would leave
 * the duplicate's name, email and address behind (US-C00.6).
 *
 * Bounded by a seen-set, like `resolveMergeChain`: a one-way `merged_into_id` cannot make a cycle,
 * but a hand-edited database could.
 */
export function mergeIdentityRows(ctx: WorkspaceContext, rootId: string): string[] {
  const out: string[] = [rootId];
  const seen = new Set<string>([rootId]);
  for (let i = 0; i < out.length; i++) {
    const rows = ctx.store.db
      .prepare('SELECT id FROM contact WHERE workspace_id = ? AND merged_into_id = ?')
      .all(ctx.workspaceId, out[i]) as { id: string }[];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row.id);
    }
  }
  return out;
}

/** Contacts naming `contactId` as their employer. The FK a merge re-points and an edit must respect. */
export function employeesOf(ctx: WorkspaceContext, contactId: string): string[] {
  return (
    ctx.store.db
      .prepare('SELECT id FROM contact WHERE workspace_id = ? AND company_contact_id = ?')
      .all(ctx.workspaceId, contactId) as { id: string }[]
  ).map((r) => r.id);
}

/** True once the address carries enough for a QR-bill (street, ZIP, town). */
function hasStructuredAddress(address: ContactAddress | undefined): boolean {
  return Boolean(address && address.street && address.zip && address.city);
}

/**
 * Reject a value that leaves the Swiss QR Code permitted character set (SIX IG v2.3 §4.1.1). This is
 * the INGRESS half of the injection guard: a contact's name and structured address ARE the QR-bill's
 * Ultimate Debtor block, and the email is the eBill `AltPmt` identifier, so a CR or an LF stored here
 * would later inject an SPC element and shift `Amt` into the guideline's open, pay-any-amount form.
 * `validateQrBill` and the encoder refuse it at the far end too; refusing it here means the bad row
 * never lands, so an operator learns at the point of typing instead of at the point of billing.
 */
function validateQrCharset(field: string, value: string | null | undefined): Result | null {
  if (value == null || value.length === 0) return null;
  const bad = firstDisallowedQrChar(value);
  if (bad === null) return null;
  return err('illegal_character', {
    field,
    codePoint: `U+${bad.codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
    reason: 'outside the Swiss QR-bill character set (SIX IG v2.3 §4.1.1)',
  });
}

/** Every contact field that reaches the QR-bill payload, checked against §4.1.1. */
function validateContactCharset(input: {
  name?: string | undefined;
  address?: ContactAddress | undefined;
  email?: string | null | undefined;
}): Result | null {
  return (
    validateQrCharset('name', input.name) ??
    validateQrCharset('address.street', input.address?.street) ??
    validateQrCharset('address.houseNo', input.address?.houseNo) ??
    validateQrCharset('address.zip', input.address?.zip) ??
    validateQrCharset('address.city', input.address?.city) ??
    validateQrCharset('address.country', input.address?.country) ??
    validateQrCharset('email', input.email)
  );
}

/** Validate the scalar contact fields shared by create and update. Returns the first rejection. */
function validateContactFields(input: {
  name?: string | undefined;
  vatNumber?: string | null | undefined;
  defaultCurrency?: string | undefined;
  paymentTermsDays?: number | undefined;
  kind?: string | undefined;
  lang?: string | null | undefined;
}): Result | null {
  if (input.name !== undefined && input.name.trim().length === 0) {
    return err('invalid_input', { field: 'name' });
  }
  if (input.vatNumber !== undefined && input.vatNumber !== null && !VAT_NUMBER_RE.test(input.vatNumber)) {
    return err('invalid_vat_number', { expected: 'CHE-###.###.### MWST' });
  }
  if (input.defaultCurrency !== undefined && !CURRENCIES.has(input.defaultCurrency)) {
    return err('invalid_currency', { defaultCurrency: input.defaultCurrency });
  }
  if (
    input.paymentTermsDays !== undefined &&
    (!Number.isInteger(input.paymentTermsDays) || input.paymentTermsDays < 0)
  ) {
    return err('invalid_input', { field: 'paymentTermsDays' });
  }
  if (input.kind !== undefined && !CONTACT_KIND_SET.has(input.kind)) {
    return err('invalid_contact_kind', { kind: input.kind, allowed: [...CONTACT_KINDS] });
  }
  if (input.lang !== undefined && input.lang !== null && !CONTACT_LANGS.has(input.lang)) {
    return err('invalid_lang', { lang: input.lang });
  }
  return null;
}

/**
 * The employer link (US-C00.1), TOTAL rather than one-shot.
 *
 * A `company_contact_id` must reference an existing contact in THIS tenant (§H-TENANT) whose `kind`
 * is `company`, and only a PERSON may name one. Three rules, and each one was a hole:
 *
 *  - a person cannot be an employer (this was the only rule enforced);
 *  - a company cannot HAVE an employer, so the org tree is one level and a cycle (two companies each
 *    other's employer) is unreachable by construction rather than checked for;
 *  - a merge TOMBSTONE cannot be an employer, or the link points at a row `list_contacts` hides and
 *    the drawer's Personen section names a company nobody can open.
 *
 * `subjectKind` is the kind the contact will HAVE after the write, not the kind it has now: a patch
 * that sets `kind` and `companyContactId` in one call has to be judged on its result.
 */
function validateEmployer(
  ctx: WorkspaceContext,
  companyContactId: string | null | undefined,
  subjectKind: string,
): Result | null {
  if (companyContactId === undefined || companyContactId === null || companyContactId.length === 0) return null;
  if (subjectKind === 'company') {
    return err('employer_only_on_person', { companyContactId, kind: subjectKind });
  }
  const employer = readContact(ctx, companyContactId);
  if (employer === undefined) return err('not_found', { companyContactId });
  if (employer.merged_into_id !== null) {
    return err('employer_merged', {
      companyContactId,
      survivorId: resolveMergeChain(ctx, employer).id,
    });
  }
  if (employer.kind !== 'company') return err('employer_must_be_company', { companyContactId });
  return null;
}

/**
 * Normalise a tag list (US-C00.2): trim, drop the empties, dedupe (case-preserving, keeping the first
 * spelling seen), and enforce the length limits. Returns the clean list, or a rejection Result.
 */
export function normalizeTags(field: string, values: string[] | undefined): string[] | Result {
  if (values === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') return err('invalid_input', { field });
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_TAG_LEN) return err('tag_too_long', { field, tag: trimmed, max: MAX_TAG_LEN });
    const dedupeKey = trimmed.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(trimmed);
  }
  if (out.length > MAX_TAGS_PER_CONTACT) return err('too_many_tags', { field, max: MAX_TAGS_PER_CONTACT });
  return out;
}

function isRejection(value: string[] | Result): value is Result {
  return !Array.isArray(value);
}

/**
 * US-A09.4: parse a free-text customer description into structured fields. The name is the first
 * comma-part (stripped of a leading "Kunde "/"Kundin " label); the rest are classified by shape into
 * VAT number, ZIP + town, payment terms, or street + house number.
 */
function parseContactDescription(text: string): {
  name?: string;
  address?: ContactAddress;
  vatNumber?: string;
  paymentTermsDays?: number;
} {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return {};

  const address: ContactAddress = {};
  const parsed: { name?: string; address?: ContactAddress; vatNumber?: string; paymentTermsDays?: number } = {};

  const name = (parts[0] ?? '').replace(/^(Kundin|Kunde)\s+/i, '').trim();
  if (name.length > 0) parsed.name = name;

  for (const part of parts.slice(1)) {
    const vat = part.match(VAT_CORE_RE);
    if (vat) {
      parsed.vatNumber = `${vat[1]} MWST`;
      continue;
    }
    const zipCity = part.match(/^(\d{4})\s+(.+)$/);
    if (zipCity) {
      address.zip = zipCity[1] ?? '';
      address.city = (zipCity[2] ?? '').trim();
      continue;
    }
    const terms = part.match(/(\d+)\s*Tage/i);
    if (terms) {
      parsed.paymentTermsDays = Number(terms[1]);
      continue;
    }
    const streetHouse = part.match(/^(.+?)\s+(\d+\s*[a-zA-Z]?)$/);
    if (streetHouse) {
      address.street = (streetHouse[1] ?? '').trim();
      address.houseNo = (streetHouse[2] ?? '').replace(/\s+/g, '');
      continue;
    }
  }

  if (address.street !== undefined || address.zip !== undefined || address.city !== undefined) {
    address.country = address.country ?? 'CH';
    parsed.address = address;
  }
  return parsed;
}

export function createContact(ctx: WorkspaceContext, input: CreateContactInput): Result {
  if (!PARTY_ROLES.has(input.partyRole)) {
    return err('invalid_party_role', { partyRole: input.partyRole });
  }

  let name = input.name;
  let address = input.address;
  let vatNumber = input.vatNumber;
  let paymentTermsDays = input.paymentTermsDays;

  // US-A09.4: fall back to the free-text parse only when a structured name is absent.
  if ((name === undefined || name.trim().length === 0) && typeof input.description === 'string') {
    const parsed = parseContactDescription(input.description);
    name = name ?? parsed.name;
    address = address ?? parsed.address;
    vatNumber = vatNumber ?? parsed.vatNumber;
    paymentTermsDays = paymentTermsDays ?? parsed.paymentTermsDays;
  }

  if (name === undefined || name.trim().length === 0) {
    return err('invalid_input', { field: 'name' });
  }
  const invalid = validateContactFields({
    name,
    vatNumber,
    defaultCurrency: input.defaultCurrency,
    paymentTermsDays,
    kind: input.kind,
    lang: input.lang,
  });
  if (invalid) return invalid;
  // Runs on the RESOLVED values, so the free-text parse (US-A09.4) cannot smuggle an illegal
  // character in behind the structured path.
  const illegal = validateContactCharset({ name, ...(address !== undefined ? { address } : {}), email: input.email });
  if (illegal) return illegal;

  const kind = input.kind ?? 'company';
  // A person may name an employer; a company never does (US-C00.1). The employer must itself be a
  // live company that exists in this tenant.
  const employerBad = validateEmployer(ctx, input.companyContactId, kind);
  if (employerBad) return employerBad;

  const roles = normalizeTags('roles', input.roles);
  if (isRejection(roles)) return roles;
  const segments = normalizeTags('segments', input.segments);
  if (isRejection(segments)) return segments;

  const run = (): Result => {
    const id = ctx.ids.next('contact');
    ctx.store.db
      .prepare(
        `INSERT INTO contact (
           id, workspace_id, party_role, name,
           address_street, address_house_no, address_zip, address_city, address_country,
           vat_number, email, default_currency, payment_terms_days, created_at,
           kind, company_contact_id, roles, segments, lang, ledger_grounding_enabled
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.partyRole,
        name.trim(),
        address?.street ?? null,
        address?.houseNo ?? null,
        address?.zip ?? null,
        address?.city ?? null,
        address?.country ?? null,
        vatNumber ?? null,
        input.email ?? null,
        // §H-FX. Resolved from `workspace.base_currency`, not written as a literal. This column is a
        // SEED: it is the currency the documents raised against this party inherit, so a franc
        // stamped into a EUR book here is wrong once now and wrong again on every invoice afterwards.
        // The column's own `DEFAULT 'CHF'` never applies (this statement always names the column).
        input.defaultCurrency ?? baseCurrencyOf(ctx),
        paymentTermsDays ?? 0,
        ctx.clock.now(),
        kind,
        input.companyContactId ?? null,
        JSON.stringify(roles),
        JSON.stringify(segments),
        input.lang ?? null,
        input.ledgerGroundingEnabled === true ? 1 : 0,
      );
    const contact = mapContact(readContact(ctx, id) as ContactRow);
    return hasStructuredAddress(address)
      ? ok({ contact })
      : ok({ contact, warning: 'needs_structured_address' });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'create_contact', run);
  }
  return run();
}

export function updateContact(
  ctx: WorkspaceContext,
  input: { contactId: string; patch: ContactPatch },
): Result {
  const existing = readContact(ctx, input.contactId);
  if (existing === undefined) return err('not_found', { contactId: input.contactId });
  // A TOMBSTONE IS NOT EDITABLE, and this refuses rather than redirects on purpose. `getContact`
  // redirects a READ to the survivor because a read cannot damage the row it lands on. A patch sets
  // fields absolutely, and the name and address it would set are the Ultimate Debtor block of every
  // invoice the survivor carries: silently applying an edit meant for the retired duplicate to a
  // different, live party is worse than naming the id the caller should have used (US-C00.4).
  if (existing.merged_into_id !== null) {
    return err('contact_merged', {
      contactId: input.contactId,
      survivorId: resolveMergeChain(ctx, existing).id,
    });
  }

  const patch = input.patch ?? {};
  if (patch.partyRole !== undefined && !PARTY_ROLES.has(patch.partyRole)) {
    return err('invalid_party_role', { partyRole: patch.partyRole });
  }
  const invalid = validateContactFields(patch);
  if (invalid) return invalid;
  const illegal = validateContactCharset(patch);
  if (illegal) return illegal;

  const nextKind = patch.kind ?? existing.kind;
  // A company that employs people cannot become a person: `validateEmployer` checked the employer's
  // kind at LINK time only, so this was the same invariant reachable from the other end, one call
  // later, with the link already written (US-C00.1).
  if (nextKind === 'person' && existing.kind === 'company') {
    const employees = employeesOf(ctx, input.contactId);
    if (employees.length > 0) {
      return err('employer_must_be_company', {
        contactId: input.contactId,
        reason: 'has_employees',
        employeeCount: employees.length,
      });
    }
  }

  // A contact may not become its own employer, and a re-pointed employer must still be a live company.
  // Judged on the EFFECTIVE link after the patch, not on the patch alone: `{kind:'company'}` with no
  // `companyContactId` in it would otherwise turn a linked person into a company that has an employer.
  const nextEmployer =
    patch.companyContactId !== undefined ? patch.companyContactId : existing.company_contact_id;
  if (nextEmployer !== null && nextEmployer.length > 0) {
    if (nextEmployer === input.contactId) {
      return err('employer_must_be_company', { companyContactId: nextEmployer });
    }
    const employerBad = validateEmployer(ctx, nextEmployer, nextKind);
    if (employerBad) return employerBad;
  }

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const push = (col: string, value: string | number | null): void => {
    sets.push(`${col} = ?`);
    params.push(value);
  };
  if (patch.partyRole !== undefined) push('party_role', patch.partyRole);
  if (patch.name !== undefined) push('name', patch.name.trim());
  if (patch.address !== undefined) {
    push('address_street', patch.address.street ?? null);
    push('address_house_no', patch.address.houseNo ?? null);
    push('address_zip', patch.address.zip ?? null);
    push('address_city', patch.address.city ?? null);
    push('address_country', patch.address.country ?? null);
  }
  if (patch.vatNumber !== undefined) push('vat_number', patch.vatNumber);
  if (patch.email !== undefined) push('email', patch.email);
  if (patch.defaultCurrency !== undefined) push('default_currency', patch.defaultCurrency);
  if (patch.paymentTermsDays !== undefined) push('payment_terms_days', patch.paymentTermsDays);
  if (patch.kind !== undefined) push('kind', patch.kind);
  if (patch.companyContactId !== undefined) push('company_contact_id', patch.companyContactId);
  if (patch.lang !== undefined) push('lang', patch.lang);
  if (patch.ledgerGroundingEnabled !== undefined) {
    push('ledger_grounding_enabled', patch.ledgerGroundingEnabled === true ? 1 : 0);
  }
  if (patch.roles !== undefined) {
    const roles = normalizeTags('roles', patch.roles);
    if (isRejection(roles)) return roles;
    push('roles', JSON.stringify(roles));
  }
  if (patch.segments !== undefined) {
    const segments = normalizeTags('segments', patch.segments);
    if (isRejection(segments)) return segments;
    push('segments', JSON.stringify(segments));
  }

  if (sets.length > 0) {
    ctx.store.db
      .prepare(`UPDATE contact SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`)
      .run(...params, ctx.workspaceId, input.contactId);
  }
  return ok({ contact: mapContact(readContact(ctx, input.contactId) as ContactRow) });
}

/**
 * `contacts_tag` (US-C00.2): merge role/segment values into the json arrays, deduplicated and
 * case-preserving. Unlike `updateContact`, which sets the arrays absolutely, this UNIONS the new
 * values into the existing set, which is what a "tag this contact" gesture means. Naturally
 * idempotent (a set union), and it still carries a key so the conformance gate holds it to §H-IDEMPOTENT.
 *
 * A TOMBSTONE REDIRECTS to the survivor, where `updateContact` refuses, and the line between them is
 * additive versus absolute. A tag is a union: landing it on the survivor adds a value and destroys
 * none, exactly as `logActivity` lands a note on the survivor. A patch replaces, so it has to name
 * the row it means. Tagging the tombstone itself would write to a row no list ever shows.
 */
export function tagContact(
  ctx: WorkspaceContext,
  input: { contactId: string; roles?: string[]; segments?: string[]; idempotencyKey?: string },
): Result {
  const named = readContact(ctx, input.contactId);
  if (named === undefined) return err('not_found', { contactId: input.contactId });
  const existing = resolveMergeChain(ctx, named);
  const contactId = existing.id;

  const run = (): Result => {
    const sets: string[] = [];
    const params: string[] = [];
    if (input.roles !== undefined) {
      const merged = normalizeTags('roles', [...parseTags(existing.roles), ...input.roles]);
      if (isRejection(merged)) return merged;
      sets.push('roles = ?');
      params.push(JSON.stringify(merged));
    }
    if (input.segments !== undefined) {
      const merged = normalizeTags('segments', [...parseTags(existing.segments), ...input.segments]);
      if (isRejection(merged)) return merged;
      sets.push('segments = ?');
      params.push(JSON.stringify(merged));
    }
    if (sets.length > 0) {
      ctx.store.db
        .prepare(`UPDATE contact SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`)
        .run(...params, ctx.workspaceId, contactId);
    }
    const contact = mapContact(readContact(ctx, contactId) as ContactRow);
    return contactId === input.contactId
      ? ok({ contact })
      : ok({ contact, mergedFrom: input.contactId });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'contacts_tag', run);
  }
  return run();
}

export function archiveContact(ctx: WorkspaceContext, input: { contactId: string }): Result {
  const result = ctx.store.db
    .prepare('UPDATE contact SET archived = 1 WHERE workspace_id = ? AND id = ?')
    .run(ctx.workspaceId, input.contactId);
  if (result.changes === 0) return err('not_found', { contactId: input.contactId });
  return ok({ contact: mapContact(readContact(ctx, input.contactId) as ContactRow) });
}

export function unarchiveContact(ctx: WorkspaceContext, input: { contactId: string }): Result {
  const result = ctx.store.db
    .prepare('UPDATE contact SET archived = 0 WHERE workspace_id = ? AND id = ?')
    .run(ctx.workspaceId, input.contactId);
  if (result.changes === 0) return err('not_found', { contactId: input.contactId });
  return ok({ contact: mapContact(readContact(ctx, input.contactId) as ContactRow) });
}

/**
 * Read one contact, following a merge chain transitively (US-C00.4): a read of a tombstone lands on
 * the survivor and reports `mergedFrom` so a caller (and the Studio) can say the id it asked for was
 * redirected.
 */
export function getContact(ctx: WorkspaceContext, input: { contactId: string }): Result {
  const row = readContact(ctx, input.contactId);
  if (row === undefined) return err('not_found', { contactId: input.contactId });
  const resolved = resolveMergeChain(ctx, row);
  if (resolved.id !== row.id) {
    return ok({ contact: mapContact(resolved), mergedFrom: row.id });
  }
  return ok({ contact: mapContact(resolved) });
}

export function listContacts(
  ctx: WorkspaceContext,
  filter: {
    query?: string;
    partyRole?: string;
    includeArchived?: boolean;
    kind?: string;
    segment?: string;
    role?: string;
    savedViewId?: string;
  } = {},
): Result {
  // The G00 seam, one unconditional call, exactly as `listDocuments` makes it (F5 retrofit: the
  // `contact` kind could store views that no verb applied). The view's filters merge UNDER the
  // caller's explicit ones, so an explicit filter always wins.
  const viewed = applySavedView(ctx, 'contact', filter);
  if (!viewed.ok) return viewed;
  filter = viewed.filter;
  // Tombstones (a set `merged_into_id`) never appear in a list: the survivor already carries their
  // history, and a merged-away row in a picker is exactly the confusion the merge was meant to end.
  const clauses = ['workspace_id = ?', 'merged_into_id IS NULL'];
  const params: string[] = [ctx.workspaceId];
  if (!filter.includeArchived) clauses.push('archived = 0');
  if (filter.partyRole !== undefined) {
    clauses.push('party_role = ?');
    params.push(filter.partyRole);
  }
  if (filter.kind !== undefined) {
    clauses.push('kind = ?');
    params.push(filter.kind);
  }
  // Segment and role are membership tests over the JSON arrays. A LIKE on the serialised array is a
  // pragmatic filter for the local-first store (no JSON1 dependency); the exact membership is
  // re-checked in the mapper below so a substring collision cannot leak a wrong row.
  if (filter.segment !== undefined) {
    clauses.push('segments LIKE ?');
    params.push(`%${JSON.stringify(filter.segment).slice(1, -1)}%`);
  }
  if (filter.role !== undefined) {
    clauses.push('roles LIKE ?');
    params.push(`%${JSON.stringify(filter.role).slice(1, -1)}%`);
  }
  if (filter.query !== undefined && filter.query.length > 0) {
    clauses.push('(name LIKE ? OR vat_number LIKE ? OR email LIKE ?)');
    const like = `%${filter.query}%`;
    params.push(like, like, like);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM contact WHERE ${clauses.join(' AND ')} ORDER BY name`)
    .all(...params) as ContactRow[];
  let contacts = rows.map(mapContact);
  // Exact membership, so a `LIKE '%newsletter%'` cannot return a contact tagged 'newsletter_paused'.
  if (filter.segment !== undefined) {
    contacts = contacts.filter((c) => c.segments.includes(filter.segment as string));
  }
  if (filter.role !== undefined) {
    contacts = contacts.filter((c) => c.roles.includes(filter.role as string));
  }
  return ok({ contacts });
}
