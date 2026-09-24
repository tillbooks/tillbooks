/**
 * A15's reminder letter: a deterministic render over the FROZEN rows of an issued run, per debtor.
 *
 * NOTHING BINARY IS STORED, AND THE DEMAND IS FROZEN AT ISSUE (D73, owner-decided 31.07.2026).
 * Every FIGURE this letter states comes from issue-time snapshot columns (`overdue_minor`,
 * `principal_minor`, `demanded_fee_minor`, `interest_minor`) that no later write touches: in
 * particular, the C8 fee recovery flips `fee_booked` on the LEDGER side and never the demand, so a
 * reprint of a sent run states exactly the amounts that were mailed, which is what a dispute or a
 * Betreibung needs the reprint to be. A fee recovered after sending joins the NEXT escalation
 * letter (through A16's open item) or ordinary collection, never this one.
 *
 * THE PARTY BLOCKS ARE LIVE, AND THE CLAIM IS DELIBERATELY NO WIDER THAN THAT (critic S4): the
 * creditor block, the debtor block and the QR payload's parties and IBAN read the CURRENT
 * `workspace` and `contact` rows, so an operator who changes bank or address after sending gets a
 * reprint whose figures match the mailed letter while its sender block and payment slip carry the
 * new party data. Freezing those too would mean snapshotting two addresses and an IBAN onto every
 * run; until somebody needs that, the honest sentence is: THE FIGURES ARE EVIDENCE, THE PARTY
 * BLOCKS ARE CURRENT. A fee recovered later never changes any figure. `get_dunning_pdf` remains a
 * true READ (no artifact to version, the A08 export posture), and what `send` retries render
 * between transport attempts is byte-stable because nothing writes between them.
 *
 * THE PAYMENT PART IS PER INVOICE, NOT PER DEBTOR, and the reason is the reference regime: under a
 * QR-IBAN the QRR reference is mandatory and names ONE receivable, so an aggregated per-debtor QR
 * is structurally impossible there. Each overdue invoice therefore gets its own payment-part page,
 * amount = its still-open amount + its fee share, reference = the SAME QRR/SCOR the original
 * invoice carries (seeded from the invoice number, exactly as A11 seeds it), so an incoming payment
 * still matches the invoice through A14/A21. A QR that cannot be built (foreign currency, the v2.4
 * QR-IBAN CHF-only cutover, a charset the IG forbids) degrades to a named reason on the page,
 * never a crash and never a fabricated code: A11's rule that a false explanation on a real letter
 * is worse than none.
 *
 * The letter's fixed legal content (creditor block, overdue list, fee, Verzugszins note, payment
 * part) is the compliance floor G05 may later reskin but never omit (§6b). The register is Sie:
 * this is correspondence to a third party, not the Studio's own de-CH du surface.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireString } from '../ledger/inputGuards.js';
import { isValidIban, isQrIban } from '../setup/iban.js';
import {
  buildQrBillPayload,
  validateQrBill,
  buildQrrReference,
  buildScorReference,
  isQrCurrency,
  buildSwissQrCodeGraphic,
  renderSwissQrCodePdfOps,
  SwissQrPayloadTooLongError,
  QR_IBAN_CHF_ONLY_FROM,
  PT_PER_MM,
} from '../sales/index.js';
import type { BuildQrBillInput, QrReferenceType, QrStructuredAddress } from '../sales/index.js';
import { readRun } from './reads.js';
import type { ItemRow } from './reads.js';
// G05: the template seam (layout-only footer lines on the letter page; see the A11 note).
import { resolveRenderTemplate } from '../customization/documentTemplates.js';

/** The QRR regime is CHF-only from the v2.4 cutover; the same constant A11 pins. */
const QR_REFERENCE_CURRENCY = 'CHF';

/** Where the payment-part page places the symbol: the same lower-left position A11 uses. */
const QR_X_PT = 20 * PT_PER_MM;
const QR_Y_PT = 15 * PT_PER_MM;

/** Escape a text string for a PDF literal (backslash and the two parentheses). */
function pdfEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** `CHF 1'234.55` for the letter body: the P11 print form, minor units in, apostrophe grouping. */
function letterMoney(minor: number, currency: string): string {
  const negative = minor < 0;
  const absolute = Math.abs(Math.trunc(minor));
  const whole = Math.floor(absolute / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${currency} ${negative ? '-' : ''}${whole}.${String(absolute % 100).padStart(2, '0')}`;
}

/** `31.12.2026` for the letter body. */
function letterDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y !== undefined && m !== undefined && d !== undefined ? `${d}.${m}.${y}` : iso;
}

/** The letter title per escalation level: the vocabulary the debtor actually receives. */
export function letterTitle(level: number): string {
  const titles = ['Zahlungserinnerung', '2. Mahnung', '3. und letzte Mahnung'];
  return titles[Math.min(Math.max(level, 1), 3) - 1]!;
}

interface WorkspaceRow {
  creditor_name: string | null;
  creditor_address: string | null;
  creditor_iban: string | null;
}

interface ContactAddressRow {
  name: string;
  address_street: string | null;
  address_house_no: string | null;
  address_zip: string | null;
  address_city: string | null;
  address_country: string | null;
  email: string | null;
}

/** One page's text lines, rendered top-down from a y start with a fixed leading. */
function pageContent(lines: readonly { text: string; size?: number }[], extraOps?: string): string {
  let y = 780;
  const parts: string[] = [];
  for (const line of lines) {
    const size = line.size ?? 10;
    y -= size + 5;
    if (line.text.length > 0) {
      parts.push(`BT /F1 ${size} Tf 60 ${y} Td (${pdfEscape(line.text)}) Tj ET`);
    }
  }
  if (extraOps !== undefined) parts.push(extraOps);
  return parts.join('\n');
}

/** Assemble a minimal, valid multi-page PDF from per-page content streams (A11's builder, paged). */
function buildPdf(pages: readonly string[]): string {
  const objects: string[] = [];
  const pageObjectIds: number[] = [];
  // Object 1: catalog, object 2: pages, object 3: font; page/content pairs follow.
  const fontId = 3;
  let nextId = 4;
  for (const _ of pages) {
    pageObjectIds.push(nextId);
    nextId += 2;
  }
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  // /WinAnsiEncoding so the umlauts in the letter survive (critic C7): the content stream is
  // latin1, and a base-14 Type1 font with NO /Encoding resolves through StandardEncoding, where
  // 0xFC is `ae` and every ü on a Swiss reminder corrupts. Same fix, same reason, as
  // `src/core/reports/export.ts`; A11's invoice PDF shares the family defect and is filed with the
  // orchestrator rather than edited here (not this capability's file).
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pages.forEach((content, i) => {
    const pageId = pageObjectIds[i]!;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return pdf;
}

interface QrPart {
  documentId: string;
  number: string | null;
  hasQr: boolean;
  reason: string | null;
  ops: string | null;
  amountMinor: number;
  currency: string;
  reference: string | null;
}

/** Resolve one item's payment part, or the named reason it has none. Never throws, never invents. */
function resolveItemQr(
  item: ItemRow,
  iban: string | null,
  creditor: QrStructuredAddress | null,
  debtor: QrStructuredAddress,
  runDate: string,
): QrPart {
  // THE PAYMENT PART ASKS FOR THE FROZEN DEMAND (C6 + D73): the item's open claim plus the fee
  // exactly as it stood at issue (`demanded_fee_minor`, which equals the fee iff it booked then).
  // A period-skipped fee is deferred, not demanded, and a recovery later never changes this slip:
  // a customer who scans it must never overpay into an unexplained Guthaben, and a reprint must be
  // the mailed slip.
  const amountMinor = item.overdue_minor + item.demanded_fee_minor;
  const base: Omit<QrPart, 'hasQr' | 'reason' | 'ops' | 'reference'> = {
    documentId: item.document_id,
    number: item.number,
    amountMinor,
    currency: item.currency,
  };
  const none = (reason: string): QrPart => ({ ...base, hasQr: false, reason, ops: null, reference: null });

  if (iban === null || iban.length === 0 || !isValidIban(iban)) return none('needs_qr_iban');
  if (creditor === null) return none('needs_creditor_address');
  if (!isQrCurrency(item.currency)) return none('unsupported_currency');
  if (amountMinor <= 0) return none('zero_open');
  if (item.number === null) return none('no_invoice_number');
  if (isQrIban(iban) && item.currency !== QR_REFERENCE_CURRENCY && runDate >= QR_IBAN_CHF_ONLY_FROM) {
    return none('qr_iban_chf_only');
  }

  const referenceType: QrReferenceType = isQrIban(iban) ? 'QRR' : 'SCOR';
  const reference =
    referenceType === 'QRR' ? buildQrrReference(item.number) : buildScorReference(item.number);

  const qrInput: BuildQrBillInput = {
    iban,
    creditor,
    amountMinor,
    currency: item.currency,
    debtor,
    referenceType,
    reference,
    unstructuredMessage: `${letterTitle(item.level)} Rechnung ${item.number}`,
    billingInfo: null,
    ebillIdentifier: null,
  };
  const issues = validateQrBill(qrInput);
  if (issues.length > 0) return none(`invalid_qr_bill:${issues[0]!.field}`);

  try {
    const payload = buildQrBillPayload(qrInput).swissQrPayload;
    const symbol = buildSwissQrCodeGraphic(payload);
    const ops = renderSwissQrCodePdfOps(symbol, { xPt: QR_X_PT, yPt: QR_Y_PT });
    return { ...base, hasQr: true, reason: null, ops, reference };
  } catch (e) {
    if (e instanceof SwissQrPayloadTooLongError) return none('swiss_qr_payload_too_long');
    throw e;
  }
}

export interface RenderDunningPdfInput {
  runId?: string;
  debtorId?: string;
  /** G05 preview override only: render under this template instead of the run's frozen snapshot. */
  templateId?: string;
}

/**
 * The letter for one debtor of one issued run: page 1 the reminder, then one payment-part page per
 * overdue invoice. A `proposed` run has no letter (M-1's shape: the figures have not frozen), and
 * a missing creditor block refuses with the A00 CTA rather than printing a letter with no sender.
 */
export function renderDunningPdf(ctx: WorkspaceContext, input: RenderDunningPdfInput): Result {
  const guard = requireString(input.runId, 'runId') ?? requireString(input.debtorId, 'debtorId');
  if (guard) return guard;

  const run = readRun(ctx, input.runId as string);
  if (run === undefined) return err('not_found', { runId: input.runId });
  if (run.status === 'proposed') {
    return err('not_available', { runId: run.id, status: run.status, reason: 'proposed_run_has_no_letter' });
  }

  const items = ctx.store.db
    .prepare(
      `SELECT * FROM dunning_item WHERE workspace_id = ? AND run_id = ? AND debtor_id = ?
        ORDER BY due_date, number`,
    )
    .all(ctx.workspaceId, run.id, input.debtorId) as ItemRow[];
  if (items.length === 0) return err('not_found', { runId: run.id, debtorId: input.debtorId });

  const ws = ctx.store.db
    .prepare('SELECT creditor_name, creditor_address, creditor_iban FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as WorkspaceRow | undefined;
  if (ws === undefined || ws.creditor_name === null || ws.creditor_address === null) {
    return err('needs_creditor_address', { runId: run.id });
  }
  const creditorParsed = JSON.parse(ws.creditor_address) as {
    street?: string;
    buildingNo?: string;
    zip?: string;
    town?: string;
    country?: string;
  };
  const creditor: QrStructuredAddress = {
    name: ws.creditor_name,
    street: creditorParsed.street ?? null,
    buildingNo: creditorParsed.buildingNo ?? null,
    postalCode: creditorParsed.zip ?? '',
    town: creditorParsed.town ?? '',
    country: creditorParsed.country ?? '',
  };

  const contact = ctx.store.db
    .prepare(
      `SELECT name, address_street, address_house_no, address_zip, address_city, address_country, email
         FROM contact WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, input.debtorId) as ContactAddressRow | undefined;
  if (contact === undefined) return err('not_found', { debtorId: input.debtorId });
  const debtor: QrStructuredAddress = {
    name: contact.name,
    street: contact.address_street,
    buildingNo: contact.address_house_no,
    postalCode: contact.address_zip ?? '',
    town: contact.address_city ?? '',
    country: contact.address_country ?? '',
  };

  const level = Math.max(...items.map((i) => i.level));
  // C6 + D73: every figure on this letter is the FROZEN demand. `demanded_fee_minor` is the fee as
  // it stood at issue; a period-skipped fee is on the record but in no total, no fee line and no
  // payment part, and a recovery later books it without ever revisiting this letter.
  const demandedFee = (i: ItemRow) => i.demanded_fee_minor;
  const totalsByCurrency = new Map<string, number>();
  for (const i of items) {
    totalsByCurrency.set(i.currency, (totalsByCurrency.get(i.currency) ?? 0) + i.overdue_minor + demandedFee(i));
  }
  const feeTotal = items.reduce((n, i) => n + demandedFee(i), 0);
  const interestTotal = items.reduce((n, i) => n + (i.interest_minor ?? 0), 0);

  // Page 1: the reminder. Fixed legal content: sender, recipient, date, title, the overdue list,
  // fee, interest note, and the request to pay.
  const letter: { text: string; size?: number }[] = [
    { text: ws.creditor_name, size: 11 },
    { text: `${creditor.street ?? ''} ${creditor.buildingNo ?? ''}`.trim() },
    { text: `${creditor.postalCode} ${creditor.town}`.trim() },
    { text: '' },
    { text: contact.name },
    { text: `${debtor.street ?? ''} ${debtor.buildingNo ?? ''}`.trim() },
    { text: `${debtor.postalCode} ${debtor.town}`.trim() },
    { text: '' },
    { text: `${creditor.town}, ${letterDate(run.run_date)}` },
    { text: '' },
    { text: letterTitle(level), size: 14 },
    { text: '' },
    { text: 'Sehr geehrte Damen und Herren' },
    { text: '' },
    { text: 'Für die folgenden Rechnungen konnten wir noch keinen Zahlungseingang feststellen:' },
    { text: '' },
  ];
  for (const i of items) {
    const due = i.due_date === null ? '' : `, fällig am ${letterDate(i.due_date)}`;
    // N5: earlier Mahngebühren are ITEMISED, never silently folded into the invoice's own figure.
    // The debtor must be able to reconcile the "offen" amount against the invoice they hold, so
    // the line states the invoice residual and the already-charged fees separately whenever the
    // claim carries both.
    //
    // `principal_minor = 0` ON AN ISSUED ITEM MEANS "NOT SNAPSHOTTED", NOT "PAID" (critic S2): the
    // column arrived by ALTER TABLE with DEFAULT 0, so a run issued under a pre-D73 build of this
    // branch carries 0 here, and subtracting it would print "offen CHF 0.00, zzgl. bereits
    // verrechnete Mahngebühren <the whole invoice>": prose claiming a paid invoice on a letter a
    // Betreibungsamt may see. A REAL snapshot is always positive (issue only keeps items whose
    // principal is), so 0 is unambiguous, and falling back to `overdue_minor` reproduces the
    // pre-D73 letter exactly. A run only PROPOSED before the migration self-heals: issue rewrites
    // both columns.
    const principalMinor = i.principal_minor > 0 ? i.principal_minor : i.overdue_minor;
    const priorFees = i.overdue_minor - principalMinor;
    const open =
      priorFees > 0
        ? `offen ${letterMoney(principalMinor, i.currency)}, zzgl. bereits verrechnete Mahngebühren ${letterMoney(priorFees, i.currency)}`
        : `offen ${letterMoney(i.overdue_minor, i.currency)}`;
    letter.push({
      text: `Rechnung ${i.number ?? i.document_id}${due}: ${open} (${i.days_overdue} Tage überfällig)`,
    });
  }
  letter.push({ text: '' });
  if (feeTotal > 0) {
    const feeCurrency = items.find((i) => demandedFee(i) > 0)?.currency ?? 'CHF';
    letter.push({ text: `Mahngebühr: ${letterMoney(feeTotal, feeCurrency)}` });
  }
  for (const [currency, total] of totalsByCurrency) {
    letter.push({ text: `Total offener Betrag: ${letterMoney(total, currency)}`, size: 11 });
  }
  if (interestTotal > 0) {
    const noteCurrency = items.find((i) => (i.interest_minor ?? 0) > 0)?.currency ?? 'CHF';
    letter.push({ text: '' });
    letter.push({
      text: `Hinweis: Der aufgelaufene Verzugszins (Art. 104 OR) beträgt ${letterMoney(interestTotal, noteCurrency)}. Er ist in den obigen Beträgen nicht enthalten.`,
    });
  }
  letter.push({ text: '' });
  letter.push({
    text: 'Wir bitten Sie, den offenen Betrag mit den beiliegenden Zahlteilen zu begleichen.',
  });
  letter.push({ text: 'Sollte sich Ihre Zahlung mit diesem Schreiben kreuzen, betrachten Sie es bitte als gegenstandslos.' });
  letter.push({ text: '' });
  letter.push({ text: 'Freundliche Grüsse' });
  letter.push({ text: ws.creditor_name });

  // G05: the template seam, the A11 shape. Footer lines only, resolved from the snapshot frozen at
  // issue (or the preview override). Every FIGURE above stays the frozen demand, and the per-invoice
  // payment parts below are untouched: the footer joins the letter page, never a Zahlteil page.
  const tpl = resolveRenderTemplate(ctx, {
    documentKind: 'dunning_run',
    table: 'dunning_run',
    rowId: run.id,
    ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
    contactId: input.debtorId ?? null,
  });
  if (tpl.footerLines.length > 0) {
    letter.push({ text: '' });
    for (const line of tpl.footerLines) letter.push({ text: line, size: 9 });
  }

  // One payment-part page per invoice.
  const qrParts = items.map((i) => resolveItemQr(i, ws.creditor_iban, creditor, debtor, run.run_date));
  const pages: string[] = [pageContent(letter)];
  for (const part of qrParts) {
    const head: { text: string; size?: number }[] = [
      { text: `Zahlteil zu Rechnung ${part.number ?? part.documentId}`, size: 12 },
      { text: `Betrag: ${letterMoney(part.amountMinor, part.currency)}` },
      part.reference !== null ? { text: `Referenz: ${part.reference}` } : { text: '' },
      part.hasQr
        ? { text: '' }
        : { text: `Zahlteil nicht verfügbar (${part.reason ?? 'unbekannt'}). Bitte verwenden Sie den Zahlteil der ursprünglichen Rechnung.` },
    ];
    pages.push(pageContent(head, part.ops ?? undefined));
  }

  const pdf = buildPdf(pages);
  const pdfBase64 = Buffer.from(pdf, 'latin1').toString('base64');
  return ok({
    pdf: {
      base64: pdfBase64,
      byteLength: Buffer.byteLength(pdf, 'latin1'),
      pages: pages.length,
      level,
      debtorEmail: contact.email,
      qrParts: qrParts.map((p) => ({
        documentId: p.documentId,
        number: p.number,
        amountMinor: p.amountMinor,
        currency: p.currency,
        hasQr: p.hasQr,
        reason: p.reason,
        reference: p.reference,
      })),
    },
  });
}
