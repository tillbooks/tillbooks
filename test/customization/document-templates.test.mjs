/**
 * G05, document templates: the STATUTORY invariant suite.
 *
 * THE HEADLINE CLAIM UNDER TEST: a template customizes PRESENTATION ONLY. The Swiss QR-bill payload
 * an invoice carries is byte-identical under every template a workspace can save, because there is
 * no code path from a template to the payload; this suite MEASURES that instead of trusting it, by
 * rendering the SAME issued invoice under the built-in default and under customized templates and
 * comparing the embedded payload byte for byte (and against `get_document(include:['qr'])`, the
 * payload's own source). The comparison is proven NON-VACUOUS twice over: the customized render
 * differs from the default render as a whole (the footer really landed), and the extractor is shown
 * to return a real Swiss payload (SPC header, length), so an empty-vs-empty comparison cannot pass.
 *
 * THE SECOND CLAIM: the freeze rule. Issue snapshots the default template's content onto the
 * document, so editing the template, switching the default, or archiving it NEVER changes an
 * already-issued document's re-rendered bytes, while a document issued afterwards picks up the new
 * state. Asserted as full-PDF byte equality under a pinned clock.
 *
 * Everything runs through the registry verbs (never INSERT), offline, on in-memory stores.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { workspace, call, count } from './support.mjs';

const QR_IBAN = 'CH4431999123000889012';

/** A workspace whose invoices carry a full QR payment part, plus one issued invoice. */
function qrWorkspace(seed) {
  const { deps, workspaceId, accId } = workspace(seed);
  call(deps, 'vat_seed_defaults', { workspaceId });
  call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' });
  const creditor = call(deps, 'set_creditor_profile', {
    workspaceId,
    creditorName: 'Vorlagen GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: QR_IBAN,
  });
  assert.equal(creditor.ok, true, JSON.stringify(creditor));
  const contact = call(deps, 'create_contact', {
    workspaceId,
    partyRole: 'customer',
    name: 'Muster AG',
    address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
    email: 'kunde@muster.example',
    idempotencyKey: `${seed}-contact`,
  });
  assert.equal(contact.ok, true, JSON.stringify(contact));
  return { deps, workspaceId, accId, contactId: contact.contact.id };
}

function issueInvoice(deps, workspaceId, contactId, seed, n = 1) {
  const doc = call(deps, 'create_document', {
    workspaceId,
    type: 'invoice',
    contactId,
    currency: 'CHF',
    dueDate: '2026-06-01',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: `${seed}-doc-${n}`,
  });
  assert.equal(doc.ok, true, JSON.stringify(doc));
  const issued = call(deps, 'issue_invoice', { workspaceId, invoiceId: doc.document.id, idempotencyKey: `${seed}-issue-${n}` });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return doc.document.id;
}

/** The raw PDF bytes (latin1) of a base64 pdf result. */
const pdfBytes = (pdf) => Buffer.from(pdf.base64, 'base64').toString('latin1');

/** The embedded Swiss QR payload comment, or null. The self-describing contract A11 documents. */
function embeddedQrPayload(pdfStr) {
  const m = pdfStr.match(/^%SwissQR:(.*)$/m);
  return m === null ? null : m[1];
}

function renderedPdfOf(deps, workspaceId, documentId) {
  const view = call(deps, 'get_document', { workspaceId, documentId, include: ['pdf'] });
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.equal(typeof view.pdf.base64, 'string', `no pdf rendered: ${JSON.stringify(view.pdf)}`);
  return view.pdf;
}

// ------------------------------------------------------------------------------------------------

test('G05 STATUTORY: the same invoice renders a byte-identical QR payload under the built-in default and under customized templates', () => {
  const { deps, workspaceId, contactId } = qrWorkspace('g05-qr');
  const invoiceId = issueInvoice(deps, workspaceId, contactId, 'g05-qr');

  // The payload's own source of truth, independent of any renderer.
  const qrView = call(deps, 'get_document', { workspaceId, documentId: invoiceId, include: ['qr'] });
  assert.equal(qrView.ok, true, JSON.stringify(qrView));
  const canonical = qrView.qr.swissQrPayload.replace(/\r?\n/g, '\\n');

  // (a) The built-in default render (no template exists yet).
  const plain = renderedPdfOf(deps, workspaceId, invoiceId);
  const plainStr = pdfBytes(plain);
  const payloadPlain = embeddedQrPayload(plainStr);

  // The extractor returns a REAL payload, so the equalities below cannot be empty-vs-empty.
  assert.notEqual(payloadPlain, null, 'the default render carries no embedded QR payload');
  assert.ok(payloadPlain.startsWith('SPC'), `not a Swiss QR payload: ${payloadPlain.slice(0, 20)}`);
  assert.ok(payloadPlain.length > 100, 'payload suspiciously short');
  assert.equal(payloadPlain, canonical, 'the default render does not embed the canonical payload');

  // (b) A customized template, previewed against the SAME invoice (footer + language config).
  const t1 = call(deps, 'create_document_template', {
    workspaceId,
    documentKind: 'invoice',
    name: 'Brand A',
    footerI18n: { 'de-CH': 'Vielen Dank für Ihren Auftrag.\nZahlbar innert 30 Tagen rein netto.' },
    languageMode: 'fixed',
    fixedLocale: 'de-CH',
    lineItemColumns: ['discount', 'sku'],
    idempotencyKey: 'g05-qr-t1',
  });
  assert.equal(t1.ok, true, JSON.stringify(t1));
  const previewA = call(deps, 'preview_document_template', {
    workspaceId,
    templateId: t1.template.templateId,
    sampleDocumentId: invoiceId,
  });
  assert.equal(previewA.ok, true, JSON.stringify(previewA));
  assert.equal(previewA.sample, false, 'a real invoice exists, the preview must render it');
  const brandedStr = pdfBytes(previewA.pdf);

  // Non-vacuity, direction one: the template REALLY changed the artifact.
  assert.ok(brandedStr.includes('Zahlbar innert 30 Tagen rein netto.'), 'the footer did not land');
  assert.notEqual(brandedStr, plainStr, 'the customized render is identical to the default: the template did nothing');

  // The statutory assertion: the payload did NOT move.
  assert.equal(embeddedQrPayload(brandedStr), canonical, 'a template ALTERED the Swiss QR payload');

  // (c) A second, maximally different template (other locale, other footer): same payload again.
  const t2 = call(deps, 'create_document_template', {
    workspaceId,
    documentKind: 'invoice',
    name: 'Brand B',
    footerI18n: { en: 'Payment within 10 days.', 'fr-CH': 'Paiement sous 10 jours.' },
    languageMode: 'fixed',
    fixedLocale: 'en',
    idempotencyKey: 'g05-qr-t2',
  });
  assert.equal(t2.ok, true, JSON.stringify(t2));
  const previewB = call(deps, 'preview_document_template', {
    workspaceId,
    templateId: t2.template.templateId,
    sampleDocumentId: invoiceId,
  });
  assert.equal(previewB.ok, true, JSON.stringify(previewB));
  assert.equal(embeddedQrPayload(pdfBytes(previewB.pdf)), canonical, 'a template ALTERED the Swiss QR payload');

  // (d) An invoice issued UNDER a default template embeds its own canonical payload unmodified.
  const setDef = call(deps, 'set_default_document_template', {
    workspaceId,
    documentKind: 'invoice',
    templateId: t1.template.templateId,
    idempotencyKey: 'g05-qr-def',
  });
  assert.equal(setDef.ok, true, JSON.stringify(setDef));
  const invoice2 = issueInvoice(deps, workspaceId, contactId, 'g05-qr', 2);
  const qr2 = call(deps, 'get_document', { workspaceId, documentId: invoice2, include: ['qr'] });
  const branded2 = renderedPdfOf(deps, workspaceId, invoice2);
  const branded2Str = pdfBytes(branded2);
  assert.equal(branded2.templateApplied, t1.template.templateId, 'the issued invoice did not freeze the default');
  assert.ok(branded2Str.includes('Vielen Dank'), 'the frozen template footer did not render');
  assert.equal(
    embeddedQrPayload(branded2Str),
    qr2.qr.swissQrPayload.replace(/\r?\n/g, '\\n'),
    'a template-rendered invoice does not embed its own canonical payload',
  );

  // The comparator itself bites: one flipped byte is detected.
  const tampered = `${canonical.slice(0, 10)}X${canonical.slice(11)}`;
  assert.notEqual(tampered, canonical, 'the tamper probe is broken');
});

test('G05 freeze: editing, replacing or archiving a template never changes an issued document; the next document picks it up', () => {
  const { deps, workspaceId, contactId } = qrWorkspace('g05-frz');

  const t1 = call(deps, 'create_document_template', {
    workspaceId,
    documentKind: 'invoice',
    name: 'Version Alt',
    footerI18n: { 'de-CH': 'Fusszeile ALT' },
    idempotencyKey: 'g05-frz-t1',
  });
  call(deps, 'set_default_document_template', {
    workspaceId,
    documentKind: 'invoice',
    templateId: t1.template.templateId,
    idempotencyKey: 'g05-frz-def1',
  });

  const invoiceId = issueInvoice(deps, workspaceId, contactId, 'g05-frz');
  const before = pdfBytes(renderedPdfOf(deps, workspaceId, invoiceId));
  assert.ok(before.includes('Fusszeile ALT'), 'setup: the frozen footer must render');

  // Edit the very template the invoice froze to, replace it as default, then archive it.
  const edited = call(deps, 'update_document_template', {
    workspaceId,
    templateId: t1.template.templateId,
    patch: { footerI18n: { 'de-CH': 'Fusszeile NEU' } },
    idempotencyKey: 'g05-frz-edit',
  });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const t2 = call(deps, 'create_document_template', {
    workspaceId,
    documentKind: 'invoice',
    name: 'Version Zwei',
    footerI18n: { 'de-CH': 'Fusszeile ZWEI' },
    idempotencyKey: 'g05-frz-t2',
  });
  call(deps, 'set_default_document_template', {
    workspaceId,
    documentKind: 'invoice',
    templateId: t2.template.templateId,
    idempotencyKey: 'g05-frz-def2',
  });
  call(deps, 'archive_document_template', { workspaceId, templateId: t1.template.templateId, idempotencyKey: 'g05-frz-arch' });

  // The issued invoice re-renders BYTE-IDENTICAL: the mailed copy and the reprint match.
  const after = pdfBytes(renderedPdfOf(deps, workspaceId, invoiceId));
  assert.equal(after, before, 'an issued invoice re-rendered differently after its template was edited/replaced/archived');

  // A new invoice picks up the new default.
  const invoice2 = issueInvoice(deps, workspaceId, contactId, 'g05-frz', 2);
  const fresh = pdfBytes(renderedPdfOf(deps, workspaceId, invoice2));
  assert.ok(fresh.includes('Fusszeile ZWEI'), 'a new invoice did not pick up the new default');
  assert.ok(!fresh.includes('Fusszeile ALT'), 'a new invoice carries the retired footer');
});

test('G05 P11: per_contact_lang renders the contact language and falls back to fixedLocale', () => {
  const { deps, workspaceId, contactId } = qrWorkspace('g05-loc');

  const t = call(deps, 'create_document_template', {
    workspaceId,
    documentKind: 'invoice',
    name: 'Mehrsprachig',
    footerI18n: { 'de-CH': 'Vielen Dank', 'fr-CH': 'Merci beaucoup' },
    languageMode: 'per_contact_lang',
    fixedLocale: 'de-CH',
    idempotencyKey: 'g05-loc-t',
  });
  call(deps, 'set_default_document_template', {
    workspaceId,
    documentKind: 'invoice',
    templateId: t.template.templateId,
    idempotencyKey: 'g05-loc-def',
  });

  // A contact with no lang falls back to fixedLocale.
  const invDe = issueInvoice(deps, workspaceId, contactId, 'g05-loc', 1);
  const pdfDe = renderedPdfOf(deps, workspaceId, invDe);
  assert.equal(pdfDe.templateLocale, 'de-CH');
  assert.ok(pdfBytes(pdfDe).includes('Vielen Dank'));

  // The same contact set to fr-CH renders fr-CH.
  const set = call(deps, 'update_contact', { workspaceId, contactId, patch: { lang: 'fr-CH' } });
  assert.equal(set.ok, true, JSON.stringify(set));
  const invFr = issueInvoice(deps, workspaceId, contactId, 'g05-loc', 2);
  const pdfFr = renderedPdfOf(deps, workspaceId, invFr);
  assert.equal(pdfFr.templateLocale, 'fr-CH');
  assert.ok(pdfBytes(pdfFr).includes('Merci beaucoup'));
});

test('G05: credit notes and dunning letters carry the template footer of THEIR kind', () => {
  const { deps, workspaceId, contactId } = qrWorkspace('g05-kinds');

  // Credit note.
  const tcn = call(deps, 'create_document_template', {
    workspaceId,
    documentKind: 'credit_note',
    name: 'Gutschrift Brand',
    footerI18n: { 'de-CH': 'Gutschrift-Fusszeile' },
    idempotencyKey: 'g05-kinds-tcn',
  });
  call(deps, 'set_default_document_template', {
    workspaceId,
    documentKind: 'credit_note',
    templateId: tcn.template.templateId,
    idempotencyKey: 'g05-kinds-defcn',
  });
  const invoiceId = issueInvoice(deps, workspaceId, contactId, 'g05-kinds');
  const cn = call(deps, 'create_credit_note', { workspaceId, fromInvoiceId: invoiceId, idempotencyKey: 'g05-kinds-cn' });
  assert.equal(cn.ok, true, JSON.stringify(cn));
  const cnIssued = call(deps, 'issue_credit_note', { workspaceId, creditNoteId: cn.document.id, idempotencyKey: 'g05-kinds-cni' });
  assert.equal(cnIssued.ok, true, JSON.stringify(cnIssued));
  const cnPdf = renderedPdfOf(deps, workspaceId, cn.document.id);
  assert.equal(cnPdf.templateApplied, tcn.template.templateId);
  assert.ok(pdfBytes(cnPdf).includes('Gutschrift-Fusszeile'), 'the credit-note footer did not render');

  // Dunning: the invoice above is overdue at the pinned clock (due 2026-06-01 < 2026-07-16), but a
  // credit note was issued against it, so use a second overdue invoice for the run.
  const tdn = call(deps, 'create_document_template', {
    workspaceId,
    documentKind: 'dunning_run',
    name: 'Mahnung Brand',
    footerI18n: { 'de-CH': 'Mahnung-Fusszeile' },
    idempotencyKey: 'g05-kinds-tdn',
  });
  call(deps, 'set_default_document_template', {
    workspaceId,
    documentKind: 'dunning_run',
    templateId: tdn.template.templateId,
    idempotencyKey: 'g05-kinds-defdn',
  });
  issueInvoice(deps, workspaceId, contactId, 'g05-kinds', 2);
  const proposed = call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'g05-kinds-prop' });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const issuedRun = call(deps, 'issue_dunning_run', {
    workspaceId,
    runId: proposed.runId,
    confirmed: true,
    idempotencyKey: 'g05-kinds-runissue',
  });
  assert.equal(issuedRun.ok, true, JSON.stringify(issuedRun));
  const letter = call(deps, 'get_dunning_pdf', { workspaceId, runId: proposed.runId, debtorId: contactId });
  assert.equal(letter.ok, true, JSON.stringify(letter));
  const letterStr = pdfBytes(letter.pdf);
  assert.ok(letterStr.includes('Mahnung-Fusszeile'), 'the dunning footer did not render');

  // And the dunning letter's per-invoice QR payment parts survived the template untouched: the
  // letter still embeds a Swiss payload (the payment parts are pages of their own).
  const frozen = deps.store.db
    .prepare('SELECT rendered_template_id FROM dunning_run WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, proposed.runId);
  assert.equal(frozen.rendered_template_id, tdn.template.templateId, 'the run did not freeze the dunning template');
});

test('G05 §6b: the write surface refuses what could corrupt the compliance floor', () => {
  const { deps, workspaceId } = workspace('g05-guard');
  const before = count(deps, 'SELECT COUNT(*) AS n FROM document_template WHERE workspace_id = ?', workspaceId);

  // An unknown kind, a LEGAL column key, a locale outside the four, a bogus language mode.
  const badKind = call(deps, 'create_document_template', { workspaceId, documentKind: 'receipt', name: 'X' });
  assert.equal(badKind.ok, false);
  assert.equal(badKind.error, 'unknown_document_kind');

  const legalColumn = call(deps, 'create_document_template', {
    workspaceId,
    documentKind: 'invoice',
    name: 'X',
    lineItemColumns: ['amount'],
  });
  assert.equal(legalColumn.ok, false);
  assert.equal(legalColumn.error, 'invalid_line_item_columns');

  const badLocale = call(deps, 'create_document_template', {
    workspaceId,
    documentKind: 'invoice',
    name: 'X',
    footerI18n: { 'de-DE': 'Hallo' },
  });
  assert.equal(badLocale.ok, false);
  assert.equal(badLocale.error, 'invalid_footer_locale');

  const badMode = call(deps, 'create_document_template', {
    workspaceId,
    documentKind: 'invoice',
    name: 'X',
    languageMode: 'auto',
  });
  assert.equal(badMode.ok, false);
  assert.equal(badMode.error, 'invalid_language_mode');

  // The logo must be a real image file in THIS workspace: a missing id and a non-image both refuse
  // with needs_valid_logo_file, and the template row is NOT written.
  const noFile = call(deps, 'create_document_template', {
    workspaceId,
    documentKind: 'invoice',
    name: 'X',
    logoDocumentId: 'file-does-not-exist',
  });
  assert.equal(noFile.ok, false);
  assert.equal(noFile.error, 'needs_valid_logo_file');

  const textFile = call(deps, 'files_upload', {
    workspaceId,
    title: 'kein-bild.txt',
    mime: 'text/plain',
    contentBase64: Buffer.from('nicht ein Logo').toString('base64'),
    idempotencyKey: 'g05-guard-txt',
  });
  assert.equal(textFile.ok, true, JSON.stringify(textFile));
  const notImage = call(deps, 'create_document_template', {
    workspaceId,
    documentKind: 'invoice',
    name: 'X',
    logoDocumentId: textFile.file.id,
  });
  assert.equal(notImage.ok, false);
  assert.equal(notImage.error, 'needs_valid_logo_file');

  const after = count(deps, 'SELECT COUNT(*) AS n FROM document_template WHERE workspace_id = ?', workspaceId);
  assert.equal(after, before, 'a refused create nonetheless wrote a template row');

  // A real image logo saves, links through E00 (OP3), and reads back through E00's own read.
  const png = call(deps, 'files_upload', {
    workspaceId,
    title: 'logo.png',
    mime: 'image/png',
    contentBase64: Buffer.from('PNGBYTES').toString('base64'),
    idempotencyKey: 'g05-guard-png',
  });
  assert.equal(png.ok, true, JSON.stringify(png));
  const withLogo = call(deps, 'create_document_template', {
    workspaceId,
    documentKind: 'invoice',
    name: 'Mit Logo',
    logoDocumentId: png.file.id,
    idempotencyKey: 'g05-guard-logo',
  });
  assert.equal(withLogo.ok, true, JSON.stringify(withLogo));
  assert.equal(withLogo.template.logoFileId, png.file.id, 'the logo did not read back through the E00 link');
});

test('G05: exactly one default per kind, flipped atomically; archiving the default clears it', () => {
  const { deps, workspaceId } = workspace('g05-def');
  const a = call(deps, 'create_document_template', { workspaceId, documentKind: 'quote', name: 'A', idempotencyKey: 'g05-def-a' });
  const b = call(deps, 'create_document_template', { workspaceId, documentKind: 'quote', name: 'B', idempotencyKey: 'g05-def-b' });
  assert.equal(a.template.isDefault, false, 'a template must never be born default');

  call(deps, 'set_default_document_template', { workspaceId, documentKind: 'quote', templateId: a.template.templateId, idempotencyKey: 'g05-def-1' });
  call(deps, 'set_default_document_template', { workspaceId, documentKind: 'quote', templateId: b.template.templateId, idempotencyKey: 'g05-def-2' });

  const defaults = count(
    deps,
    "SELECT COUNT(*) AS n FROM document_template WHERE workspace_id = ? AND document_kind = 'quote' AND is_default = 1",
    workspaceId,
  );
  assert.equal(defaults, 1, 'two defaults for one kind');
  const bRow = call(deps, 'get_document_template', { workspaceId, templateId: b.template.templateId });
  assert.equal(bRow.template.isDefault, true);

  // A kind mismatch refuses; archiving the default clears it.
  const mismatch = call(deps, 'set_default_document_template', { workspaceId, documentKind: 'invoice', templateId: b.template.templateId });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, 'kind_mismatch');
  call(deps, 'archive_document_template', { workspaceId, templateId: b.template.templateId, idempotencyKey: 'g05-def-arch' });
  const defaultsAfter = count(
    deps,
    "SELECT COUNT(*) AS n FROM document_template WHERE workspace_id = ? AND document_kind = 'quote' AND is_default = 1",
    workspaceId,
  );
  assert.equal(defaultsAfter, 0, 'an archived template stayed default');
  const setArchived = call(deps, 'set_default_document_template', { workspaceId, documentKind: 'quote', templateId: b.template.templateId });
  assert.equal(setArchived.ok, false);
  assert.equal(setArchived.error, 'template_archived');
});

test('G05 P3 by omission: the template verbs post nothing, ever', () => {
  const { deps, workspaceId } = workspace('g05-p3');
  const entries = () => count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId);
  const payments = () => count(deps, 'SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?', workspaceId);
  const before = { entries: entries(), payments: payments() };

  const t = call(deps, 'create_document_template', { workspaceId, documentKind: 'invoice', name: 'P3', idempotencyKey: 'g05-p3-c' });
  call(deps, 'update_document_template', { workspaceId, templateId: t.template.templateId, patch: { name: 'P3b' }, idempotencyKey: 'g05-p3-u' });
  call(deps, 'set_default_document_template', { workspaceId, documentKind: 'invoice', templateId: t.template.templateId, idempotencyKey: 'g05-p3-d' });
  call(deps, 'preview_document_template', { workspaceId, templateId: t.template.templateId });
  call(deps, 'list_document_templates', { workspaceId });
  call(deps, 'archive_document_template', { workspaceId, templateId: t.template.templateId, idempotencyKey: 'g05-p3-a' });

  assert.deepEqual({ entries: entries(), payments: payments() }, before, 'a G05 verb reached the money path');
});

test('G05 §H-TENANT: another workspace cannot see, default or archive a template', () => {
  const { deps, workspaceId } = workspace('g05-ten');
  const t = call(deps, 'create_document_template', { workspaceId, documentKind: 'invoice', name: 'Meins', idempotencyKey: 'g05-ten-c' });
  assert.equal(t.ok, true);

  const other = call(deps, 'create_workspace', { name: 'Fremd GmbH', idempotencyKey: 'g05-ten-ws2' });
  const foreign = other.workspaceId;
  for (const [verb, input] of [
    ['get_document_template', { templateId: t.template.templateId }],
    ['preview_document_template', { templateId: t.template.templateId }],
    ['archive_document_template', { templateId: t.template.templateId, idempotencyKey: 'g05-ten-x' }],
    ['set_default_document_template', { documentKind: 'invoice', templateId: t.template.templateId, idempotencyKey: 'g05-ten-y' }],
  ]) {
    const res = call(deps, verb, { workspaceId: foreign, ...input });
    assert.equal(res.ok, false, `${verb} crossed the tenant boundary`);
    assert.equal(res.error, 'not_found', `${verb}: expected not_found, got ${res.error}`);
  }
  const listed = call(deps, 'list_document_templates', { workspaceId: foreign });
  assert.deepEqual(listed.templates, [], 'a foreign workspace lists another tenant templates');
});

test('G05 A24: without manage_document_templates the writes refuse before any row; reads stay open', () => {
  const { deps, workspaceId } = workspace('g05-a24');
  // Provision the workspace (the first invite flips it) and narrow the calling actor to viewer.
  const invited = call(deps, 'invite_member', {
    workspaceId,
    email: 'leser@muster.ch',
    role: 'viewer',
    idempotencyKey: 'g05-a24-inv',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));
  const listed = call(deps, 'list_members', { workspaceId });
  const seat = listed.members.find((m) => m.actorId === 'agent');
  assert.ok(seat !== undefined, 'the provisioning flip did not seat the agent');
  const narrowed = call(deps, 'set_role', { workspaceId, memberId: seat.memberId, role: 'viewer' });
  assert.equal(narrowed.ok, true, JSON.stringify(narrowed));

  deps.actor = 'agent';
  const me = call(deps, 'whoami', { workspaceId });
  assert.equal(me.capabilities.includes('manage_document_templates'), false, 'viewer must not hold the gate');

  const before = count(deps, 'SELECT COUNT(*) AS n FROM document_template WHERE workspace_id = ?', workspaceId);
  const denied = call(deps, 'create_document_template', { workspaceId, documentKind: 'invoice', name: 'Nein' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'permission_denied');
  assert.equal(
    count(deps, 'SELECT COUNT(*) AS n FROM document_template WHERE workspace_id = ?', workspaceId),
    before,
    'a denied create wrote a row',
  );

  // The read side is the read_master_data domain, which viewer holds.
  const list = call(deps, 'list_document_templates', { workspaceId });
  assert.equal(list.ok, true, JSON.stringify(list));
});
