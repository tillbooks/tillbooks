/**
 * G05's seven verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` /
 * `customizationActions` precedent), so several agents appending to the append-only registry at
 * once collide over a line rather than a block.
 *
 * Four writes (create/update/set-default/archive, all gated on `manage_document_templates`) and
 * three reads (`readOnlyHint`). `archive_document_template` is NOT destructive: it soft-archives,
 * and a template frozen onto a past document keeps rendering, which is why the description says so.
 *
 * THE STATUTORY LINE IS IN THE DESCRIPTIONS ON PURPOSE: a template customizes PRESENTATION only.
 * The Swiss QR-bill payload, the VAT figures and every legal content block are produced by the
 * consuming capability (A11/A13/A15) and pass through byte-identical whatever template is chosen;
 * an agent reading the tool list must never be led to believe a template could alter a payable
 * figure. `test/customization/document-templates.test.mjs` measures the claim.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  archiveDocumentTemplate,
  createDocumentTemplate,
  getDocumentTemplate,
  listDocumentTemplates,
  previewDocumentTemplate,
  setDefaultDocumentTemplate,
  updateDocumentTemplate,
} from '../core/customization/index.js';

export interface DocumentTemplateActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
}

/** The registry's documented cast: the JSON input is handed to the verb as its typed input. */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The G05 verbs, in append order (the §5 table order). */
export function documentTemplateActions(h: DocumentTemplateActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL } = h;
  const OBJ = { type: 'object' } as const;
  const STR_LIST = { type: 'array', items: STR } as const;

  return [
    ctxAction(
      'create_document_template',
      'write',
      'Create a document template (invoice, credit_note, quote or dunning_run): footer text per locale, render language (fixed or per contact), an ordered set of OPTIONAL non-legal line-item columns, and an E00 logo file linked via entityKind document_template. Always saved as a NON-default draft: going live is a separate set_default_document_template call a human confirms. Presentation only: the Swiss QR-bill payload, VAT figures and legal content are produced by the document itself and pass through byte-identical under every template.',
      ctxSchema(
        {
          documentKind: STR,
          name: STR,
          lineItemColumns: STR_LIST,
          footerI18n: OBJ,
          languageMode: STR,
          fixedLocale: STR,
          logoDocumentId: STR,
          idempotencyKey: STR,
        },
        ['documentKind', 'name'],
      ),
      (ctx, input) => createDocumentTemplate(ctx, as(input)),
    ),
    ctxAction(
      'update_document_template',
      'write',
      'Update a template (name, footer, language, optional columns, logo). NEVER changes an already-issued document: issue froze the template content onto the document, so a mailed copy and a later reprint always match; only documents issued after the edit pick it up.',
      ctxSchema({ templateId: STR, patch: OBJ, idempotencyKey: STR }, ['templateId', 'patch']),
      (ctx, input) => updateDocumentTemplate(ctx, as(input)),
    ),
    ctxAction(
      'set_default_document_template',
      'write',
      "Make a template THE default for its document kind: the prior default clears in the same atomic write (at most one default per kind), and every document of that kind issued afterwards freezes to it. Wide-effect and reviewable: this changes the workspace's outward face.",
      ctxSchema({ documentKind: STR, templateId: STR, idempotencyKey: STR }, ['documentKind', 'templateId']),
      (ctx, input) => setDefaultDocumentTemplate(ctx, as(input)),
    ),
    ctxAction(
      'archive_document_template',
      'write',
      'Soft-archive a template (and clear it as default). NOT destructive: a template frozen onto an already-issued document keeps rendering that document forever; archiving only removes it from the active list and from new defaults.',
      ctxSchema({ templateId: STR, idempotencyKey: STR }, ['templateId']),
      (ctx, input) => archiveDocumentTemplate(ctx, as(input)),
    ),
    ctxAction(
      'preview_document_template',
      'read',
      "Render a template preview as PDF bytes, mutating nothing: against sampleDocumentId, else the most recent real document of the template's kind, else synthetic MUSTER-watermarked sample data that is never a payable document (no fabricated QR code; a missing QR-IBAN surfaces A11's own needs_qr_iban cause).",
      ctxSchema({ templateId: STR, sampleDocumentId: STR }, ['templateId']),
      (ctx, input) => previewDocumentTemplate(ctx, as(input)),
    ),
    ctxAction(
      'list_document_templates',
      'read',
      'List document templates, newest defaults first per kind: id, kind, name, default/archived flags, footer locales, language mode, and the linked logo file id. documentKind narrows to one kind; includeArchived includes archived rows; savedViewId applies a saved view (G00).',
      ctxSchema({ documentKind: STR, includeArchived: BOOL, savedViewId: STR }, []),
      (ctx, input) => listDocumentTemplates(ctx, as(input)),
    ),
    ctxAction(
      'get_document_template',
      'read',
      'One template with its full configuration: footer text per locale, language mode, fixed locale, optional column order, default/archived flags, and the linked logo file id.',
      ctxSchema({ templateId: STR }, ['templateId']),
      (ctx, input) => getDocumentTemplate(ctx, as(input)),
    ),
  ];
}
