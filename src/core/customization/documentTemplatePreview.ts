/**
 * G05's preview verb, in its OWN module so the import graph stays a DAG: the consuming renderers
 * (`sales/invoice.ts`, `sales/creditNote.ts`, `dunning/pdf.ts`) import `documentTemplates.ts` for
 * the template seam, and preview needs to CALL those renderers, so it lives one module out rather
 * than making `documentTemplates.ts` import its own consumers.
 *
 * A PURE READ (spec §4, conformance rule 4): renders against an existing document's own render path
 * with the template OVERRIDE, or against synthetic sample data when no document of that kind exists
 * yet, and mutates nothing. The synthetic sample is stamped with a diagonal MUSTER watermark and
 * NEVER carries a payable QR code (spec US-G05.2: when no QR-IBAN is configured the sample names
 * A11's own `needs_qr_iban` cause; when one is configured the sample still fabricates no code,
 * because a fabricated-but-scannable payment part on a Muster is a bill somebody can pay).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { renderInvoicePdf, buildMinimalPdf, pdfEscape } from '../sales/invoice.js';
import { renderCreditNotePdf } from '../sales/creditNote.js';
import { renderDunningPdf } from '../dunning/pdf.js';
import { resolveRenderTemplate } from './documentTemplates.js';

interface TemplateRowLite {
  id: string;
  document_kind: string;
  archived: number;
}

/** The most recent real, non-draft document of a type, or undefined. */
function latestDocumentOf(ctx: WorkspaceContext, type: string): string | undefined {
  const row = ctx.store.db
    .prepare(
      `SELECT id FROM document
        WHERE workspace_id = ? AND type = ? AND number IS NOT NULL AND status NOT IN ('draft', 'cancelled')
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, type) as { id: string } | undefined;
  return row?.id;
}

/** The most recent issued/sent dunning run and one of its debtors, or undefined. */
function latestDunningTarget(ctx: WorkspaceContext): { runId: string; debtorId: string } | undefined {
  const row = ctx.store.db
    .prepare(
      `SELECT i.run_id AS runId, i.debtor_id AS debtorId
         FROM dunning_item i JOIN dunning_run r ON r.id = i.run_id AND r.workspace_id = i.workspace_id
        WHERE i.workspace_id = ? AND r.status IN ('issued', 'sent')
        ORDER BY r.run_date DESC, i.rowid ASC LIMIT 1`,
    )
    .get(ctx.workspaceId) as { runId: string; debtorId: string } | undefined;
  return row;
}

const KIND_SAMPLE_TITLE: Readonly<Record<string, string>> = {
  invoice: 'Rechnung MUSTER-2026-001',
  credit_note: 'Gutschrift MUSTER-2026-001',
  quote: 'Offerte MUSTER-2026-001',
  dunning_run: 'Zahlungserinnerung (MUSTER)',
};

/**
 * The synthetic sample: canned lines, a placeholder amount, the template's footer, and a diagonal
 * MUSTER watermark. Never a payable document, so never a QR symbol: the QR line names the honest
 * state instead (`needs_qr_iban` when A00 is unconfigured, A11's own cause; a Muster note otherwise).
 */
function sampleBodyPdf(
  ctx: WorkspaceContext,
  documentKind: string,
  footerLines: readonly string[],
): string {
  const ws = ctx.store.db
    .prepare('SELECT creditor_iban FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { creditor_iban: string | null } | undefined;
  const hasIban = typeof ws?.creditor_iban === 'string' && ws.creditor_iban.length > 0;

  const bodyLines = [
    KIND_SAMPLE_TITLE[documentKind] ?? 'MUSTER',
    'Muster-Position: Beratung, CHF 1000.00',
    'Betrag: CHF 1077.00',
    documentKind === 'invoice' || documentKind === 'dunning_run'
      ? hasIban
        ? 'QR-Zahlteil: nicht Teil der Muster-Vorschau'
        : 'QR-bill: not available (needs_qr_iban)'
      : '',
  ].filter((l) => l.length > 0);

  const text = bodyLines
    .map((line, i) => `BT /F1 12 Tf 60 ${760 - i * 20} Td (${pdfEscape(line)}) Tj ET`)
    .join('\n');
  const footerOps = footerLines
    .map((line, i) => `BT /F1 9 Tf 60 ${240 - i * 14} Td (${pdfEscape(line)}) Tj ET`)
    .join('\n');
  // The watermark: 60pt text rotated 45 degrees across the page body, drawn in light grey inside
  // its own q/Q pair so the fill colour leaks into nothing else. A Muster is visibly a Muster.
  const watermark = `q 0.85 g BT /F1 60 Tf 0.7071 0.7071 -0.7071 0.7071 140 300 Tm (${pdfEscape('MUSTER')}) Tj ET Q`;
  const content = [text, footerOps, watermark].filter((p) => p.length > 0).join('\n');
  return buildMinimalPdf(content, null);
}

/**
 * Preview a template (spec US-G05.2): against `sampleDocumentId`, else the most recent real
 * document of the template's kind, else synthetic sample data. Read-only in every branch.
 */
export function previewDocumentTemplate(
  ctx: WorkspaceContext,
  input: { templateId: string; sampleDocumentId?: string },
): Result {
  const template = ctx.store.db
    .prepare('SELECT id, document_kind, archived FROM document_template WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.templateId) as TemplateRowLite | undefined;
  if (template === undefined) return err('not_found', { templateId: input.templateId });
  const kind = template.document_kind;

  // A real document of the kind, when one exists, rendered by ITS OWN render path with the
  // template override: what the preview shows is what the artifact would be, not a facsimile.
  if (kind === 'invoice' || kind === 'credit_note') {
    const documentId = input.sampleDocumentId ?? latestDocumentOf(ctx, kind);
    if (documentId !== undefined) {
      const rendered =
        kind === 'invoice'
          ? renderInvoicePdf(ctx, documentId, { templateId: template.id })
          : renderCreditNotePdf(ctx, documentId, { templateId: template.id });
      if (rendered.ok) {
        const pdf = rendered.pdf as { base64: string; byteLength: number; templateLocale?: string };
        return ok({
          pdf: { base64: pdf.base64, byteLength: pdf.byteLength },
          sample: false,
          sourceDocumentId: documentId,
          templateId: template.id,
          locale: pdf.templateLocale ?? 'de-CH',
        });
      }
      // An explicitly named sample document that cannot render is the caller's error to hear about;
      // the automatic pick degrades to the synthetic sample instead (P9).
      if (input.sampleDocumentId !== undefined) return rendered;
    }
  }

  if (kind === 'dunning_run' && input.sampleDocumentId === undefined) {
    const target = latestDunningTarget(ctx);
    if (target !== undefined) {
      const rendered = renderDunningPdf(ctx, {
        runId: target.runId,
        debtorId: target.debtorId,
        templateId: template.id,
      });
      if (rendered.ok) {
        const pdf = rendered.pdf as { base64: string; byteLength: number };
        return ok({
          pdf: { base64: pdf.base64, byteLength: pdf.byteLength },
          sample: false,
          sourceDocumentId: target.runId,
          templateId: template.id,
          locale: resolveRenderTemplate(ctx, { documentKind: kind, templateId: template.id }).locale,
        });
      }
    }
  }

  // No real document yet (or a quote, which has no renderer today, spec §0 item 2): the synthetic
  // MUSTER sample, under the candidate template's own locale and footer.
  const resolved = resolveRenderTemplate(ctx, { documentKind: kind, templateId: template.id });
  const pdf = sampleBodyPdf(ctx, kind, resolved.footerLines);
  const base64 = Buffer.from(pdf, 'latin1').toString('base64');
  return ok({
    pdf: { base64, byteLength: Buffer.byteLength(pdf, 'latin1') },
    sample: true,
    sourceDocumentId: null,
    templateId: template.id,
    locale: resolved.locale,
  });
}
