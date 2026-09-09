/**
 * A11 shapes and pure helpers for the invoice surfaces (editor, QR panel, PDF overlay, send dialog).
 *
 * These MIRROR the live engine responses, read off the running engine rather than assumed: this repo
 * has shipped four defects from the Studio guessing a key the engine never sends (`vatCodes` vs
 * `taxCodes`, the profile wrapper, `address` vs `creditorAddress`, `null` vs `undefined`). Every shape
 * below is pinned by the drift guard in `test/sales/invoice-gui-fixture.test.mjs` against the real
 * `issue_invoice` / `get_document(include:['qr','pdf'])` / `send_invoice` responses.
 *
 * The one shape trap worth naming: the QR arrives in TWO different envelopes.
 *   - `issue_invoice` answers `qr: { available: true, swissQrPayload, referenceType, reference,
 *     igVersion }` or `qr: { available: false, reason: '<error code>' }`.
 *   - `get_document(include:['qr'])` answers `qr: { swissQrPayload, ... }` on success and the RAW
 *     rejection `{ ok: false, error, ... }` on failure, with no `available` key at all.
 * `readQr` below normalises both, so no caller has to remember which verb it called.
 *
 * No money is computed here: the engine owns the money, these helpers only format and derive dates.
 */

import {
  renderSwissQrCodeSvg,
  buildSwissQrCodeGraphic,
  SwissQrPayloadTooLongError,
  SWISS_QR_MIN_MODULE_SIZE_MM,
} from '../../../../src/core/sales/swiss-qr-graphic.js';

import { qrConsequence, type QrConsequence } from './currency';
import type { DocumentDto } from './model';

/** The Swiss QR-bill payload as the engine emits it (`buildQrBillPayload`, IG v2.3). */
export interface QrBillDto {
  /** The Swiss Payments Code: the exact string that goes INTO the QR graphic, byte for byte. */
  swissQrPayload: string;
  referenceType: 'QRR' | 'SCOR' | 'NON';
  reference: string;
  igVersion: string;
}

/** The rendered PDF artifact (`renderInvoicePdf`). `pdfaProfile` is deliberately null (A32-OI1, D31). */
export interface InvoicePdfDto {
  base64: string;
  byteLength: number;
  hasQrBill: boolean;
  /** The named cause when the artifact carries no payment part, or null when it does. */
  qrUnavailable: { code: string; detail: string } | null;
  /** The drawn symbol's measurements, or null when none was drawn. */
  qrGraphic: {
    version: number;
    moduleCount: number;
    moduleSizeMm: number;
    meetsMinimumModuleSize: boolean;
    sizePt: number;
  } | null;
  pdfaProfile: string | null;
}

/** A normalised QR read: either the bill, or the engine's reason it has none. Never a guess. */
export type QrState =
  | { kind: 'available'; bill: QrBillDto }
  | { kind: 'unavailable'; reason: string };

/**
 * Normalise whichever QR envelope arrived (see the module note) into one `QrState`.
 * An absent `qr` key is `not_requested`: the caller asked without `include:['qr']`.
 */
export function readQr(raw: unknown): QrState {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return { kind: 'unavailable', reason: 'not_requested' };
  }
  const q = raw as Record<string, unknown>;
  // The get_document failure arm is the raw rejection: `{ ok: false, error }`.
  if (q.ok === false) return { kind: 'unavailable', reason: String(q.error ?? 'unexpected_error') };
  // The issue_invoice arm carries an explicit availability flag plus a reason when false.
  if (q.available === false) return { kind: 'unavailable', reason: String(q.reason ?? 'unexpected_error') };
  if (typeof q.swissQrPayload !== 'string' || q.swissQrPayload === '') {
    return { kind: 'unavailable', reason: 'not_available' };
  }
  return {
    kind: 'available',
    bill: {
      swissQrPayload: q.swissQrPayload,
      referenceType: (q.referenceType as QrBillDto['referenceType']) ?? 'NON',
      reference: typeof q.reference === 'string' ? q.reference : '',
      igVersion: typeof q.igVersion === 'string' ? q.igVersion : '',
    },
  };
}

/** Normalise the `pdf` include the same way: the artifact, or the engine's reason there is none. */
export type PdfState =
  | { kind: 'available'; pdf: InvoicePdfDto }
  | { kind: 'unavailable'; reason: string };

export function readPdf(raw: unknown): PdfState {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return { kind: 'unavailable', reason: 'not_requested' };
  }
  const p = raw as Record<string, unknown>;
  if (p.ok === false) return { kind: 'unavailable', reason: String(p.error ?? 'unexpected_error') };
  if (typeof p.base64 !== 'string' || p.base64 === '') {
    return { kind: 'unavailable', reason: 'not_available' };
  }
  return {
    kind: 'available',
    pdf: {
      base64: p.base64,
      byteLength: typeof p.byteLength === 'number' ? p.byteLength : 0,
      hasQrBill: p.hasQrBill === true,
      qrUnavailable: (p.qrUnavailable ?? null) as InvoicePdfDto['qrUnavailable'],
      qrGraphic: (p.qrGraphic ?? null) as InvoicePdfDto['qrGraphic'],
      pdfaProfile: typeof p.pdfaProfile === 'string' ? p.pdfaProfile : null,
    },
  };
}

/**
 * The scannable payment code for the S3 panel: the SAME renderer the invoice PDF draws with, given
 * the SAME payload the engine emitted, so the code on screen and the code on the artifact are one
 * symbol described once (`test/sales/qr-wiring-decode.test.mjs` decodes both and compares them).
 *
 * The Studio renders it rather than receiving a rendered string because the accessible name has to
 * be translated and the engine has no locale. `swiss-qr-graphic.ts` is pure TypeScript with no
 * runtime dependencies, so bundling it into the browser costs nothing but the encoder itself.
 *
 * The panel used to draw nothing and say so, which was the honest thing to do while no verified
 * encoder existed. One exists now, so the honest thing is the code.
 */
export type QrGraphicState =
  | { kind: 'drawn'; svg: string; tooDense: boolean }
  | { kind: 'undrawable'; reason: string };

export function renderPaymentQr(payload: string, ariaLabel: string): QrGraphicState {
  try {
    // ONE encode per call. The symbol is built here for the density flag and handed to the renderer,
    // which used to be given the payload and build the very same symbol a second time. Encoding is
    // the expensive part of drawing a QR (the rest is a division and some string concatenation), so
    // that hidden second pass doubled the cost of every panel render. The memo in `InvoiceArtifacts`
    // cut how OFTEN this runs; only passing the symbol down cuts what one run costs.
    const symbol = buildSwissQrCodeGraphic(payload);
    return {
      svg: renderSwissQrCodeSvg(symbol, { ariaLabel }),
      kind: 'drawn',
      // IG 6.3 asks for at least 0.4 mm per printed module while IG 6.4 fixes the code at 46 mm for
      // every version, and the two cannot both hold at version 25 (46/117 = 0.393 mm). The code is
      // still drawn (46 mm is unconditional); the panel says the print may be marginal, because the
      // fix is to shorten the additional information and only a human can decide to.
      tooDense: symbol.moduleSizeMm < SWISS_QR_MIN_MODULE_SIZE_MM,
    };
  } catch (error) {
    // A payload past IG 6.2's 997-character ceiling has no symbol at all. Saying which, rather than
    // showing an empty box, is the difference between a fixable problem and a mystery.
    if (error instanceof SwissQrPayloadTooLongError) return { kind: 'undrawable', reason: 'payload_too_long' };
    throw error;
  }
}

/**
 * The reference in its human display form, per SIX IG v2.3 (verified 2026-07-25 against
 * six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.3-en.pdf):
 *  - QRR (27 digits): blocks of 5 counted from the RIGHT, so the short block leads.
 *  - SCOR (`RF` + 2 check digits + body): blocks of 4 counted from the LEFT.
 * The reference is generated, never typed, so this is display only (ST2).
 */
export function formatQrReference(reference: string, referenceType: string): string {
  const clean = reference.replace(/\s/g, '');
  if (clean === '') return '';
  if (referenceType === 'QRR') {
    const blocks: string[] = [];
    let rest = clean;
    while (rest.length > 5) {
      blocks.unshift(rest.slice(-5));
      rest = rest.slice(0, -5);
    }
    blocks.unshift(rest);
    return blocks.join(' ');
  }
  if (referenceType === 'SCOR') {
    return (clean.match(/.{1,4}/g) ?? [clean]).join(' ');
  }
  return clean;
}

/**
 * The due date derived from an issue date plus the customer's payment terms, as an ISO date. Pure
 * calendar arithmetic in UTC (no locale, no clock): the value goes on the wire as ISO and is rendered
 * by `formatDate`. Returns null when either input is missing, so nothing is ever fabricated.
 */
export function dueDateFrom(issueDateIso: string | null, termsDays: number | null): string | null {
  if (issueDateIso === null || issueDateIso === '' || termsDays === null) return null;
  const base = new Date(`${issueDateIso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + termsDays);
  return base.toISOString().slice(0, 10);
}

/** The contact address as `list_contacts`/`get_contact` send it (null when nothing is stored). */
export interface ContactAddress {
  street: string | null;
  houseNo: string | null;
  zip: string | null;
  city: string | null;
  country: string | null;
}

export interface InvoiceContact {
  id: string;
  name: string;
  email?: string | null;
  address?: ContactAddress | null;
  paymentTermsDays?: number | null;
}

/**
 * Which structured-address fields the QR-bill needs and this contact lacks (M10). Since IG v2.3 the
 * structured form is the ONLY permitted one (ST1), so an incomplete address is a fixable error and
 * never an unstructured fallback. `houseNo` is optional in the IG (a street without a number is
 * valid), so it is not required here.
 */
export function missingAddressFields(contact: InvoiceContact | undefined): string[] {
  const a = contact?.address ?? null;
  const required: [keyof ContactAddress, string][] = [
    ['street', 'street'],
    ['zip', 'zip'],
    ['city', 'city'],
    ['country', 'country'],
  ];
  return required
    .filter(([key]) => {
      const value = a === null ? null : a[key];
      return value === null || value === undefined || String(value).trim() === '';
    })
    .map(([, label]) => label);
}

/**
 * Everything the draft editor can honestly say about QR readiness BEFORE issue. A draft has no
 * QR-bill at all (the engine refuses one: the reference is seeded from the real invoice number, so a
 * draft-time preview would show a reference that changes at issue). So the editor shows readiness,
 * never a fabricated code.
 *
 * The currency half of readiness is `qrConsequence`, the SAME function the currency picker warns
 * with (M13), so the checklist and the control can never disagree about whether a bill is possible.
 * The picker owns the full explanation, next to the control that causes it; this panel carries the
 * one-line checklist entry, because saying it twice at length is noise, not emphasis.
 */
export interface QrReadiness {
  /** Structured-address fields the customer is missing (M10). */
  missingCustomerAddress: string[];
  /** What the chosen currency and the configured IBAN do to the payment part. */
  consequence: QrConsequence;
}

export function qrReadiness(input: {
  contact: InvoiceContact | undefined;
  /** The workspace's creditor IBAN, or null when none is configured. */
  iban: string | null;
  currency: string;
  /** The invoice date: the QR-bill is judged by its own issue date, never by today. */
  issueDate: string;
}): QrReadiness {
  return {
    missingCustomerAddress: missingAddressFields(input.contact),
    consequence: qrConsequence({ currency: input.currency, iban: input.iban, issueDate: input.issueDate }),
  };
}

/** True when nothing blocks the QR-bill: the panel then says so in one line instead of listing gaps. */
export function isQrReady(readiness: QrReadiness): boolean {
  return readiness.missingCustomerAddress.length === 0 && readiness.consequence.kind === 'qr';
}

/** One reason this invoice will carry no payment part: a copy key, its parameters, and the way out. */
export interface QrGapLine {
  key: string;
  /** Parameters for the copy. `fields` is a comma-joined list of raw field NAMES, localised by the caller. */
  fields?: string[];
  /** An ISO date the copy interpolates, already raw: the caller formats it (D15). */
  date?: string;
  wayOut?: { to: string; labelKey: string };
}

/**
 * Every reason a draft's payment part will be missing, derived ONCE (A11-G11).
 *
 * The readiness panel used to own this list inline, roughly 900 px below Ausstellen and off the
 * bottom of the screen: a user could issue an unpayable invoice without ever having seen the words.
 * The issue dialog now names the same gaps at the moment of the irreversible act, and both read
 * this, so the two can never drift into telling different stories about the same draft.
 *
 * `currency` is not interpolated here. The copy takes it as a parameter and the caller has it.
 */
export function qrGapLines(readiness: QrReadiness): QrGapLine[] {
  const lines: QrGapLine[] = [];
  if (readiness.consequence.kind === 'no_iban') {
    lines.push({ key: 'invoice.qr.needsIban', wayOut: { to: '/setup', labelKey: 'invoice.qr.toSetup' } });
  }
  if (readiness.missingCustomerAddress.length > 0) {
    lines.push({
      key: 'invoice.qr.missingAddress',
      fields: readiness.missingCustomerAddress,
      wayOut: { to: '/contacts', labelKey: 'invoice.qr.fixAddress' },
    });
  }
  if (readiness.consequence.kind === 'unsupported_currency') {
    lines.push({ key: 'invoice.qr.unsupportedCurrency' });
  }
  if (readiness.consequence.kind === 'qr_iban_chf_only') {
    lines.push({ key: 'invoice.qr.qrIbanChfOnly', date: readiness.consequence.effectiveFrom });
  }
  return lines;
}

/**
 * The i18n key for an engine rejection this slice knows how to explain (A10-G13: an engine error must
 * name what blocked the step and the way out, never collapse to one generic sentence). An unknown code
 * returns null and the caller falls back to the generic banner, which is honest about not knowing.
 */
export const INVOICE_ERROR_KEYS: Record<string, string> = {
  needs_qr_iban: 'invoice.error.needsQrIban',
  needs_creditor_address: 'invoice.error.needsCreditorAddress',
  needs_customer_address: 'invoice.error.needsCustomerAddress',
  needs_customer: 'invoice.error.needsCustomer',
  needs_customer_email: 'invoice.error.needsCustomerEmail',
  needs_email_config: 'invoice.error.needsEmailConfig',
  // US-A11.5 requires these two to be told apart: `needs_email_config` is "nothing is set up",
  // `needs_email_transport` is "something is named but no channel is wired to it". They share a
  // remedy (download the PDF) but not a cause, and only one of them is fixed in Setup.
  needs_email_transport: 'invoice.error.needsEmailTransport',
  // A11-G3: the send refuses an invoice whose PDF carries no payment part, because a Swiss customer
  // cannot pay it. It used to read as a save failure, which named neither the gap nor the remedy.
  needs_qr_bill: 'invoice.error.needsQrBill',
  // A11-G1: the ONE code that must never read as "nothing happened". A prior attempt reached the
  // transport and its outcome is unknown, so an email may already be with the customer and the
  // engine refuses the retry on purpose (src/core/sales/invoice.ts, the `dispatching` guard).
  send_outcome_unknown: 'invoice.error.sendOutcomeUnknown',
  needs_confirmation: 'invoice.error.needsConfirmation',
  needs_fx_rate: 'invoice.error.needsFxRate',
  // The two §H-FX refusals a currency choice can produce at issue time, and the SIX v2.4 cutover the
  // QR path produces. All three used to fall through to "the document could not be updated", which
  // told an operator holding a EUR invoice precisely nothing.
  fx_method_not_elected: 'invoice.error.fxMethodNotElected',
  fx_method_locked: 'invoice.error.fxMethodLocked',
  qr_iban_chf_only: 'invoice.error.qrIbanChfOnly',
  unsupported_currency: 'invoice.error.unsupportedCurrency',
  zero_total: 'invoice.error.zeroTotal',
  invalid_qr_bill: 'invoice.error.invalidQrBill',
  not_available: 'invoice.error.notAvailable',
  email_send_failed: 'invoice.error.sendFailed',
  not_an_invoice: 'invoice.error.notAnInvoice',
};

export function invoiceErrorKey(code: string): string | null {
  return INVOICE_ERROR_KEYS[code] ?? null;
}

/**
 * Where a human fixes a missing payment part, given the engine's own reason code.
 *
 * The creditor's IBAN and address live in Setup; the customer and their address live in Contacts.
 * Every other cause (an unsupported currency, the v2.4 QR-IBAN cutover, a zero total, a payload the
 * symbol cannot carry) is fixed on the document itself or not at all, so it gets NO link rather than
 * a link to somewhere that cannot help.
 */
export function qrGapWayOut(reason: unknown): { to: string; labelKey: string } | null {
  switch (reason) {
    case 'needs_qr_iban':
      return { to: '/setup', labelKey: 'invoice.qr.toSetup' };
    // A missing creditor ADDRESS is also fixed in Setup, but "IBAN hinterlegen" would send the
    // operator to check the one field that is not the problem, which is the whole defect this
    // family exists to stop.
    case 'needs_creditor_address':
      return { to: '/setup', labelKey: 'invoice.qr.fixCreditorAddress' };
    case 'needs_customer_address':
    case 'needs_customer':
      return { to: '/contacts', labelKey: 'invoice.qr.fixAddress' };
    default:
      return null;
  }
}

/**
 * The copy key behind a `needs_qr_bill` refusal's OWN reason (A11-G3's remainder).
 *
 * `sendInvoice` refuses to mail an invoice whose PDF carries no payment part, and it hands back the
 * cause the render already computed (`reason` + `detail`, `src/core/sales/invoice.ts`). The dialog
 * used to discard both and print one generic remedy ("check the IBAN and both addresses"), which is
 * a guess where the engine had already produced the answer: an unpayable EUR invoice was told to
 * check an IBAN that was perfectly fine.
 *
 * Unknown or unmappable reasons return null and the caller says so plainly instead of inventing a
 * cause. `reason` is typed `unknown` because it arrives off the wire on an index-signature `Err`.
 */
export function qrGapKey(reason: unknown): string | null {
  return typeof reason === 'string' ? invoiceErrorKey(reason) : null;
}

/** True for a document that has posted and is therefore an invoice artifact (QR + PDF exist). */
export function hasInvoiceArtifacts(doc: DocumentDto): boolean {
  return doc.type === 'invoice' && doc.status !== 'draft' && doc.number !== null;
}
