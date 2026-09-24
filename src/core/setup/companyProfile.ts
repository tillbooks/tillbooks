/**
 * A00 creditor profile and profile read.
 *
 * A QR-bill (A11) needs a creditor with a structured address and an IBAN. A00 validates and stores;
 * A11 renders. The values are freely entered, but the IBAN validation rule and the structured-address
 * requirement are compliance-fixed (§6b).
 *
 * STRUCTURED-ONLY IS ALREADY IN FORCE; it is NOT a pending deadline. This header used to say
 * "mandatory from 30 Sep 2026", which was wrong twice over: the QR-bill scheme has no 2026 milestone
 * for addresses, and 2026-09-30 is a payments-side pain.001 cutoff that drifted in from the spec text
 * (A09 §3 and the research table already carry that correction). SIX retired the combined address
 * with IG QR-bill v2.3, in force since 21.11.2025, which is exactly what `core/sales/qrbill.ts` is
 * pinned to. The two files now agree.
 *
 * Primary source (fetched 2026-07-25):
 *  - "Swiss Implementation Guidelines for the QR-bill: Documentation of changes between versions 2.2
 *    and 2.3", cover page, verbatim: `Version 2.3, valid from 21 November 2025`
 *    (six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-delta-guide-v2.3-en.pdf)
 *  - Same document, ch. 4.2.2 "Data elements in the QR-bill", p. 8 of 9, verbatim:
 *    `Removal of address type "K": Combined address fields.`
 *  - Same document, ch. 4.3.1 "Use of address information", p. 9 of 9, verbatim (the struck-out
 *    combined-fields alternative elided at the ellipsis):
 *    `The address of the parties involved ... can only be delivered in a structured way`
 *  - six-group.com/.../payment-standardization/standards/qr-bill.html, verbatim:
 *    `Entry into force date: Nov 21, 2025`
 *
 * DELIBERATELY NOT a date constant, unlike `QR_IBAN_CHF_ONLY_FROM` in `core/sales/invoice.ts`. That
 * one needs a boundary because the v2.4 CHF-only rule bites in the FUTURE and both currencies stay
 * representable either side of it. This rule is already current AND the combined form is not
 * representable in TILL at all: `QrStructuredAddress` is the only address type in the codebase and
 * `addressLines` emits a literal `S`. A cutover constant here would gate nothing.
 *
 * EITHER KIND OF IBAN (M-2). Per the SIX Implementation Guidelines the reference type follows from
 * the IBAN and the two are mutually exclusive: a QR reference (QRR) may be used ONLY with a QR-IBAN,
 * whose QR-IID falls in the reserved range 30000-31999, and the Structured Creditor Reference (SCOR,
 * ISO 11649) may be used ONLY with a plain IBAN. Both are fully valid QR-bills. This verb used to
 * refuse anything that was not a QR-IBAN, which made the (correct) SCOR path in `core/sales`
 * unreachable and left every business without a QR-IBAN unable to invoice at all. It now accepts any
 * valid IBAN and lets `buildQrBill` derive the reference type, which is where that decision belongs.
 *
 * The column therefore holds an IBAN of EITHER kind, and since 2026-07-25 it is called
 * `workspace.creditor_iban` and says so, next to `creditor_name` and `creditor_address`. It was
 * `qr_iban` for as long as only one kind was storable; existing files are carried across by
 * generation 2 in `core/store/migrations.ts`.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { isValidIban } from './iban.js';
import { firstDisallowedQrChar } from '../sales/qrbill.js';
import { LEGAL_FORMS } from './enums.js';
import { isLedgerLocked } from './ledgerLock.js';

export interface CreditorAddress {
  street: string;
  buildingNo: string;
  zip: string;
  town: string;
  country: string;
}

export interface SetCreditorProfileInput {
  /**
   * The creditor name. OPTIONAL since F-09 (2026-09-06): an absent name defaults to the workspace's
   * company name, which is what it is for every SME that does not invoice under a second name. An
   * explicit blank string is still `invalid_name`: a caller that names a field and leaves it empty
   * has made a mistake, and a silent default would hide it.
   */
  creditorName?: string;
  /**
   * The structured QR-bill address. OPTIONAL since F-09 (2026-09-06): the first-hour path captures
   * the IBAN with the company name and legal form on ONE panel (J1.1 ideal step 3), and the address
   * is needed only when the first QR-bill renders. An ABSENT address (undefined, null, or an object
   * whose five fields are all blank) leaves the stored address untouched and saves the name and IBAN;
   * `buildQrBill` still refuses `needs_creditor_address` at render time, so nothing filing-grade can
   * go out without it. A PARTIAL address (some fields filled, some blank) is still refused with
   * `needs_structured_address`: half an address is a mistake, not a deferral.
   */
  address?: CreditorAddress | Partial<CreditorAddress> | null;
  /**
   * The creditor IBAN, a QR-IBAN or a plain one. The field keeps its name because it is the
   * agent-facing wire name of `set_creditor_profile` and renaming it would break every caller; what
   * changed is what it accepts. `iban` is accepted as an alias so an agent that spells it the honest
   * way is not refused.
   */
  qrIban?: string;
  /** Alias for `qrIban`. When both are given, this one wins: it is the less ambiguous spelling. */
  iban?: string;
}

/**
 * Reject a value that leaves the Swiss QR Code permitted character set (SIX IG v2.3 §4.1.1).
 *
 * This is the CREDITOR half of the injection guard, the twin of `validateContactCharset` in
 * `core/sales/contact.ts`. The creditor name and structured address ARE the QR-bill's Creditor
 * block, and the payload is elements joined with CR+LF, so a CR or an LF stored here would later
 * inject an SPC element, shift everything below it by one, and leave `Amt` empty: the guideline's
 * OPEN form, payable with any amount the payer types. `validateQrBill` and the encoder refuse it at
 * the far end too, but refusing it HERE means the bad row never lands, so an operator learns at the
 * point of typing rather than at the point of billing.
 *
 * The character set is defined ONCE, in `core/sales/qrbill.ts`, and imported. A second table here
 * would be a second thing to keep in step with the guideline, which is how the two halves of a rule
 * drift apart.
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

/** Every creditor field that reaches the QR-bill payload, checked against §4.1.1. */
function validateCreditorCharset(input: { creditorName: string; address: CreditorAddress | undefined }): Result | null {
  return (
    validateQrCharset('creditorName', input.creditorName) ??
    validateQrCharset('address.street', input.address?.street) ??
    validateQrCharset('address.buildingNo', input.address?.buildingNo) ??
    validateQrCharset('address.zip', input.address?.zip) ??
    validateQrCharset('address.town', input.address?.town) ??
    validateQrCharset('address.country', input.address?.country)
  );
}

function isStructuredAddress(address: unknown): address is CreditorAddress {
  if (typeof address !== 'object' || address === null) return false;
  const a = address as Record<string, unknown>;
  return (['street', 'buildingNo', 'zip', 'town', 'country'] as const).every(
    (field) => typeof a[field] === 'string' && (a[field] as string).length > 0,
  );
}

/** An address the caller did not give: absent, null, or every one of the five fields blank. */
function isAbsentAddress(address: unknown): boolean {
  if (address === undefined || address === null) return true;
  if (typeof address !== 'object') return false;
  const a = address as Record<string, unknown>;
  return (['street', 'buildingNo', 'zip', 'town', 'country'] as const).every(
    (field) => a[field] === undefined || a[field] === null || (typeof a[field] === 'string' && (a[field] as string).trim().length === 0),
  );
}

export function setCreditorProfile(ctx: WorkspaceContext, input: SetCreditorProfileInput): Result {
  // The tenant row exists for every `WorkspaceContext` the boundary hands in (the tenant check runs
  // before the verb), so this read needs no refusal of its own: a missing row only means an empty
  // default, and the UPDATE below then touches nothing.
  const row = ctx.store.db
    .prepare('SELECT name, creditor_name, creditor_address, creditor_iban FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as
    | { name: string; creditor_name: string | null; creditor_address: string | null; creditor_iban: string | null }
    | undefined;

  // The creditor name defaults to the company name (F-09); an explicit blank is still a mistake.
  if (input.creditorName !== undefined && (typeof input.creditorName !== 'string' || input.creditorName.trim().length === 0)) {
    return err('invalid_name');
  }
  // An OMITTED name preserves the stored creditor name and only falls back to the company name on the
  // first save (when none is stored yet). Reading `row?.name` alone would clobber a distinct second
  // invoicing name on any follow-up call that carries only the address, the same erase the IBAN had.
  const creditorName = input.creditorName === undefined ? (row?.creditor_name ?? row?.name ?? '') : input.creditorName.trim();
  if (creditorName.length === 0) return err('invalid_name');

  // F-09: no address given keeps whatever is stored (possibly nothing); a partial one is refused.
  const addressGiven = !isAbsentAddress(input.address);
  if (addressGiven && !isStructuredAddress(input.address)) {
    return err('needs_structured_address');
  }
  // After the fields are known to exist and before anything is written: a refusal must store nothing.
  const illegal = validateCreditorCharset({ creditorName, address: addressGiven ? (input.address as CreditorAddress) : undefined });
  if (illegal !== null) return illegal;
  // An OMITTED IBAN preserves the stored one, mirroring the address preserve below. Without the
  // `row?.creditor_iban` default, a follow-up call that carries only the address wrote `null` here
  // and silently erased the account: the SME configured the way the verb advertised, added the
  // address, and the first QR-bill refused `needs_qr_iban`. The trailing `?? undefined` keeps a
  // "no IBAN anywhere" case out of `isValidIban`, so an early address-first save is not refused.
  const iban = input.iban ?? input.qrIban ?? row?.creditor_iban ?? undefined;
  // Only the IBAN's own validity is checked here. Whether it is a QR-IBAN decides the REFERENCE
  // TYPE, not whether it may be stored, and that decision belongs to `buildQrBill`.
  if (iban !== undefined && !isValidIban(iban)) {
    return err('invalid_iban', { iban });
  }
  const storedAddress = addressGiven ? JSON.stringify(input.address) : (row?.creditor_address ?? null);
  ctx.store.db
    .prepare('UPDATE workspace SET creditor_name = ?, creditor_address = ?, creditor_iban = ? WHERE id = ?')
    .run(creditorName, storedAddress, iban ?? null, ctx.workspaceId);
  return ok();
}

/** ESTV UID (`CHE-###.###.###`) and the VAT number (`CHE-###.###.### MWST`), format-checked offline. */
const UID_RE = /^CHE-\d{3}\.\d{3}\.\d{3}$/;
const MWST_NO_RE = /^CHE-\d{3}\.\d{3}\.\d{3} MWST$/;

export interface UpdateCompanyProfileInput {
  name?: string;
  legalForm?: string;
  uid?: string;
  mwstNo?: string;
}

/**
 * Update the company identity fields. `uid` and `mwstNo` are shape-validated against the ESTV formats
 * (offline format check only, no UID-register lookup, §3). Nothing here posts.
 */
export function updateCompanyProfile(ctx: WorkspaceContext, input: UpdateCompanyProfileInput): Result {
  if (input.name !== undefined && input.name.trim().length === 0) return err('invalid_name');
  if (input.legalForm !== undefined && !LEGAL_FORMS.has(input.legalForm)) {
    return err('invalid_legal_form', { legalForm: input.legalForm });
  }
  if (input.uid !== undefined && input.uid !== null && !UID_RE.test(input.uid)) {
    return err('invalid_uid', { uid: input.uid, expected: 'CHE-###.###.###' });
  }
  if (input.mwstNo !== undefined && input.mwstNo !== null && !MWST_NO_RE.test(input.mwstNo)) {
    return err('invalid_mwst_no', { mwstNo: input.mwstNo, expected: 'CHE-###.###.### MWST' });
  }

  const sets: string[] = [];
  const params: (string | null)[] = [];
  const push = (col: string, value: string | null): void => {
    sets.push(`${col} = ?`);
    params.push(value);
  };
  if (input.name !== undefined) push('name', input.name.trim());
  if (input.legalForm !== undefined) push('legal_form', input.legalForm);
  if (input.uid !== undefined) push('uid', input.uid);
  if (input.mwstNo !== undefined) push('mwst_no', input.mwstNo);
  if (sets.length > 0) {
    ctx.store.db.prepare(`UPDATE workspace SET ${sets.join(', ')} WHERE id = ?`).run(...params, ctx.workspaceId);
  }
  return ok();
}

interface WorkspaceRow {
  id: string;
  name: string;
  legal_form: string | null;
  base_currency: string;
  fiscal_year_start: string;
  vat_method: string | null;
  vat_accounting: string | null;
  creditor_name: string | null;
  creditor_address: string | null;
  creditor_iban: string | null;
  uid: string | null;
  mwst_no: string | null;
  created_at: string;
}

export function getCompanyProfile(ctx: WorkspaceContext): Result {
  const row = ctx.store.db
    .prepare('SELECT * FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as WorkspaceRow | undefined;
  if (row === undefined) {
    return err('not_found', { workspaceId: ctx.workspaceId });
  }
  return ok({
    profile: {
      workspaceId: row.id,
      name: row.name,
      legalForm: row.legal_form,
      baseCurrency: row.base_currency,
      fiscalYearStart: row.fiscal_year_start,
      vatMethod: row.vat_method,
      vatAccounting: row.vat_accounting,
      creditorName: row.creditor_name,
      creditorAddress: row.creditor_address === null ? null : JSON.parse(row.creditor_address),
      // The stored creditor IBAN, of EITHER kind (M-2), under the one name it has.
      //
      // This used to ship a second key, `qrIban`, carrying the same value: the read name the Studio
      // was written against, kept alive for one slot because dropping it in the same pass as the
      // column rename would have broken surfaces other agents held. Every reader has since moved,
      // so the alias is gone. Two keys for one row field is a permanent invitation to write code
      // against the wrong one, and the name was wrong besides: the column holds a QR-IBAN or a plain
      // one, and a plain one is what makes a SCOR bill.
      //
      // The INPUT alias on `set_creditor_profile` is a different question and stays: it is a
      // published agent-facing wire name, and callers that send it are outside this repo.
      creditorIban: row.creditor_iban,
      uid: row.uid,
      mwstNo: row.mwst_no,
      createdAt: row.created_at,
      // §H-FX: base currency and fiscal-year start freeze once an entry is posted. The read reports
      // it so a client can disable the two controls AT the control, instead of letting the operator
      // type a change and only learn at save time that `set_fiscal_config` refuses it.
      ledgerLocked: isLedgerLocked(ctx),
    },
  });
}
