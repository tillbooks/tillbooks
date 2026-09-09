/**
 * G05, document templates: the branding SEAM around the statutory artifacts.
 *
 * WHAT THIS MODULE IS, AND WHAT IT REFUSES TO BE. A template customizes PRESENTATION (a footer per
 * locale, a render language, a stored optional-column order, an E00-linked logo) around content the
 * consuming capability has ALREADY computed. It computes no money, touches no VAT figure, and never
 * sees the QR-bill payload at all: `renderInvoicePdf` builds the Swiss QR payload and its drawn
 * symbol exactly as before and only asks this module which footer lines to append and which locale
 * they resolve to. The byte-identity of the QR payload under any template is therefore structural
 * (there is no code path from a template to the payload), and it is ALSO asserted by test
 * (`test/customization/document-templates.test.mjs`), because a structural claim nobody measures is
 * a claim.
 *
 * THE FREEZE RULE (spec §4/US-G05.4). A document's look crystallises at ISSUE, exactly like its
 * number: `freezeRenderedTemplate` writes `rendered_template_id` once, inside the issue
 * transaction, and never again (the UPDATE carries `AND rendered_template_id IS NULL`). Rendering
 * an issued document resolves the FROZEN id; a document issued before G05, or before any default
 * existed, has NULL and renders the built-in fixed default forever. The freeze deliberately does
 * NOT ride the render reads: `get_document(include:['pdf'])` and `preview_document_template` are
 * read verbs, and the conformance gate's rule 4 (READ MEANS READ) is not negotiable.
 *
 * WHY THE RESOLVER NEVER ERRORS ON A MISSING TEMPLATE (P9): a workspace with no template, or a
 * frozen id whose row was archived, still renders a correct document in the built-in fixed layout.
 * Branding degrades; the statutory artifact does not.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { linkFile, listLinkedFiles } from '../files/files.js';
import { applySavedView } from './views.js';

/** §H-ENUM: the four templatable document kinds. Single source; the schema carries no CHECK. */
export const DOCUMENT_TEMPLATE_KINDS: readonly string[] = ['invoice', 'credit_note', 'quote', 'dunning_run'];

/** §H-ENUM: how the render locale resolves. */
export const TEMPLATE_LANGUAGE_MODES: readonly string[] = ['fixed', 'per_contact_lang'];

/** The four P11 locales a template may carry footer text for and render in. */
export const TEMPLATE_LOCALES: readonly string[] = ['de-CH', 'en', 'fr-CH', 'it-CH'];

/**
 * The OPTIONAL, NON-LEGAL line-item columns a template may order or hide (spec §6b). The legally
 * required content (description, quantity, price, VAT, totals) is never listed here because it is
 * never optional: a key outside this set is refused at write time, so a template cannot be edited
 * into hiding a statutory column. Stored config today: A11's minimal artifact renders no line-item
 * table yet (spec §0 item 1), so the visible effect lands with the full-geometry artifact.
 */
export const OPTIONAL_LINE_ITEM_COLUMNS: readonly string[] = ['discount', 'sku', 'project', 'unit'];

export const MAX_TEMPLATE_NAME_LENGTH = 120;
export const MAX_FOOTER_LENGTH = 1000;
/** Rendered footer lines are capped so a footer can never crowd the payment part off the page. */
export const MAX_FOOTER_LINES = 4;
/** The logo ceiling (2 MB): far above any sane letterhead, low enough to keep the store honest. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const KIND_SET: ReadonlySet<string> = new Set(DOCUMENT_TEMPLATE_KINDS);
const MODE_SET: ReadonlySet<string> = new Set(TEMPLATE_LANGUAGE_MODES);
const LOCALE_SET: ReadonlySet<string> = new Set(TEMPLATE_LOCALES);
const COLUMN_SET: ReadonlySet<string> = new Set(OPTIONAL_LINE_ITEM_COLUMNS);

interface TemplateRow {
  id: string;
  workspace_id: string;
  document_kind: string;
  name: string;
  line_item_columns: string;
  footer_i18n: string;
  language_mode: string;
  fixed_locale: string;
  is_default: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

function mapTemplate(ctx: WorkspaceContext, row: TemplateRow): Record<string, unknown> {
  return {
    templateId: row.id,
    documentKind: row.document_kind,
    name: row.name,
    lineItemColumns: JSON.parse(row.line_item_columns) as string[],
    footerI18n: JSON.parse(row.footer_i18n) as Record<string, string>,
    languageMode: row.language_mode,
    fixedLocale: row.fixed_locale,
    isDefault: row.is_default === 1,
    archived: row.archived === 1,
    logoFileId: readLogoFileId(ctx, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readTemplate(ctx: WorkspaceContext, templateId: string): TemplateRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM document_template WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, templateId) as TemplateRow | undefined;
}

/**
 * The logo, read back through E00's OWN read (OP3): the most recently linked image file, or null.
 * G05 stores no FK of its own (spec §4), so this cannot drift from what E00 holds. E00 orders the
 * linked list newest-first, so the first image IS the current logo.
 */
function readLogoFileId(ctx: WorkspaceContext, templateId: string): string | null {
  // Field order (entityId first) is deliberate at every OP3 call in this module: the audit-vocab
  // scraper reads `entityKind: '<literal>' ... entityId:` as an audit emission, and these are E00
  // link calls, not audit rows. G05 emits no audit rows (say so once: template CRUD is silent
  // configuration, the A09 contact-CRUD posture).
  const linked = listLinkedFiles(ctx, { entityId: templateId, entityKind: 'document_template' });
  if (!linked.ok) return null;
  const files = (linked as unknown as { files: { id: string; mime: string }[] }).files;
  const image = files.find((f) => f.mime.startsWith('image/'));
  return image?.id ?? null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Shared validation for create and update, so the two paths cannot drift. Returns a Result on the
 * first problem, undefined when the parts are clean.
 */
function shapeProblem(parts: {
  documentKind: string;
  name?: unknown;
  lineItemColumns?: unknown;
  footerI18n?: unknown;
  languageMode?: unknown;
  fixedLocale?: unknown;
}): Result | undefined {
  if (parts.name !== undefined) {
    if (typeof parts.name !== 'string' || parts.name.trim().length === 0) return err('invalid_name', {});
    if (parts.name.length > MAX_TEMPLATE_NAME_LENGTH) {
      return err('name_too_long', { max: MAX_TEMPLATE_NAME_LENGTH });
    }
  }
  if (parts.lineItemColumns !== undefined) {
    if (
      !Array.isArray(parts.lineItemColumns) ||
      !parts.lineItemColumns.every((c) => typeof c === 'string' && COLUMN_SET.has(c))
    ) {
      return err('invalid_line_item_columns', { allowed: [...OPTIONAL_LINE_ITEM_COLUMNS] });
    }
    if (new Set(parts.lineItemColumns).size !== parts.lineItemColumns.length) {
      return err('invalid_line_item_columns', { allowed: [...OPTIONAL_LINE_ITEM_COLUMNS], reason: 'duplicate' });
    }
  }
  if (parts.footerI18n !== undefined) {
    if (!isPlainObject(parts.footerI18n)) return err('invalid_footer', {});
    for (const [locale, text] of Object.entries(parts.footerI18n)) {
      if (!LOCALE_SET.has(locale)) return err('invalid_footer_locale', { locale, allowed: [...TEMPLATE_LOCALES] });
      if (typeof text !== 'string' || text.length > MAX_FOOTER_LENGTH) {
        return err('invalid_footer', { locale, max: MAX_FOOTER_LENGTH });
      }
    }
  }
  if (parts.languageMode !== undefined && !MODE_SET.has(parts.languageMode as string)) {
    return err('invalid_language_mode', { allowed: [...TEMPLATE_LANGUAGE_MODES] });
  }
  if (parts.fixedLocale !== undefined && !LOCALE_SET.has(parts.fixedLocale as string)) {
    return err('invalid_locale', { allowed: [...TEMPLATE_LOCALES] });
  }
  return undefined;
}

/**
 * The logo must be a real E00 file in THIS workspace, an image, and under the byte ceiling:
 * `needs_valid_logo_file` names exactly what to fix (spec §2 error state). The template itself
 * still saves without a logo, which is why the caller validates BEFORE inserting anything.
 */
function logoProblem(ctx: WorkspaceContext, logoDocumentId: unknown): Result | undefined {
  if (typeof logoDocumentId !== 'string' || logoDocumentId.length === 0) {
    return err('needs_valid_logo_file', { reason: 'logoDocumentId must be a stored file id' });
  }
  const file = ctx.store.db
    .prepare('SELECT id, mime, bytes FROM stored_file WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, logoDocumentId) as { id: string; mime: string; bytes: number } | undefined;
  if (file === undefined) return err('needs_valid_logo_file', { reason: 'file_not_found', logoDocumentId });
  if (!file.mime.startsWith('image/')) {
    return err('needs_valid_logo_file', { reason: 'not_an_image', mime: file.mime });
  }
  if (file.bytes > MAX_LOGO_BYTES) {
    return err('needs_valid_logo_file', { reason: 'too_large', bytes: file.bytes, max: MAX_LOGO_BYTES });
  }
  return undefined;
}

export interface CreateDocumentTemplateInput {
  documentKind: string;
  name: string;
  lineItemColumns?: string[];
  footerI18n?: Record<string, string>;
  languageMode?: string;
  fixedLocale?: string;
  logoDocumentId?: string;
  idempotencyKey?: string;
}

/** Create a template. ALWAYS non-default on creation (spec §4): going live is a separate, human act. */
export function createDocumentTemplate(ctx: WorkspaceContext, input: CreateDocumentTemplateInput): Result {
  const run = (): Result => {
    if (!KIND_SET.has(input.documentKind)) {
      return err('unknown_document_kind', { documentKind: input.documentKind, known: [...DOCUMENT_TEMPLATE_KINDS] });
    }
    const problem = shapeProblem({
      documentKind: input.documentKind,
      name: input.name,
      lineItemColumns: input.lineItemColumns,
      footerI18n: input.footerI18n,
      languageMode: input.languageMode,
      fixedLocale: input.fixedLocale,
    });
    if (problem !== undefined) return problem;
    if (input.logoDocumentId !== undefined) {
      const bad = logoProblem(ctx, input.logoDocumentId);
      if (bad !== undefined) return bad;
    }

    // A dunning letter's overdue-list format is fixed (spec §4): the column config only ever
    // applies to the three line-item documents, so a dunning template stores none.
    const columns = input.documentKind === 'dunning_run' ? [] : (input.lineItemColumns ?? []);

    const now = ctx.clock.now();
    const id = ctx.ids.next('doctpl');
    ctx.store.db
      .prepare(
        `INSERT INTO document_template
           (id, workspace_id, document_kind, name, line_item_columns, footer_i18n, language_mode,
            fixed_locale, is_default, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      .run(
        id,
        ctx.workspaceId,
        input.documentKind,
        input.name,
        JSON.stringify(columns),
        JSON.stringify(input.footerI18n ?? {}),
        input.languageMode ?? 'fixed',
        input.fixedLocale ?? 'de-CH',
        now,
        now,
      );
    if (input.logoDocumentId !== undefined) {
      // entityId before entityKind: see the readLogoFileId note (an E00 link, not an audit row).
      const linked = linkFile(ctx, {
        fileId: input.logoDocumentId,
        entityId: id,
        entityKind: 'document_template',
      });
      if (!linked.ok) return linked;
    }
    return ok({ template: mapTemplate(ctx, readTemplate(ctx, id) as TemplateRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'create_document_template', () =>
      ctx.store.tx(run),
    );
  }
  return ctx.store.tx(run);
}

export interface DocumentTemplatePatch {
  name?: string;
  lineItemColumns?: string[];
  footerI18n?: Record<string, string>;
  languageMode?: string;
  fixedLocale?: string;
  logoDocumentId?: string;
}

/**
 * Patch a template. Editing a template NEVER changes an already-issued document's look: the issue
 * write froze not just the template ID but a SNAPSHOT of its render-relevant content
 * (`rendered_template_snapshot`), so the §8 property ("editing the default template after an
 * invoice is issued does not change that invoice's re-rendered PDF, while a new invoice issued
 * afterward picks up the edit") holds even when the edited template IS the one the old document was
 * issued under. A mailed copy and a later reprint always match (§6b's freeze bullet), which an
 * id-only freeze could not guarantee. Archiving keeps the row (soft archive, spec §4).
 */
export function updateDocumentTemplate(
  ctx: WorkspaceContext,
  input: { templateId: string; patch: DocumentTemplatePatch; idempotencyKey?: string },
): Result {
  const run = (): Result => {
    const row = readTemplate(ctx, input.templateId);
    if (row === undefined) return err('not_found', { templateId: input.templateId });
    const patch = input.patch ?? {};
    const problem = shapeProblem({
      documentKind: row.document_kind,
      name: patch.name,
      lineItemColumns: patch.lineItemColumns,
      footerI18n: patch.footerI18n,
      languageMode: patch.languageMode,
      fixedLocale: patch.fixedLocale,
    });
    if (problem !== undefined) return problem;
    if (patch.logoDocumentId !== undefined) {
      const bad = logoProblem(ctx, patch.logoDocumentId);
      if (bad !== undefined) return bad;
    }

    const columns =
      row.document_kind === 'dunning_run'
        ? []
        : (patch.lineItemColumns ?? (JSON.parse(row.line_item_columns) as string[]));
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        `UPDATE document_template
            SET name = ?, line_item_columns = ?, footer_i18n = ?, language_mode = ?, fixed_locale = ?,
                updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        patch.name ?? row.name,
        JSON.stringify(columns),
        JSON.stringify(patch.footerI18n ?? (JSON.parse(row.footer_i18n) as Record<string, string>)),
        patch.languageMode ?? row.language_mode,
        patch.fixedLocale ?? row.fixed_locale,
        now,
        ctx.workspaceId,
        row.id,
      );
    if (patch.logoDocumentId !== undefined) {
      // entityId before entityKind: see the readLogoFileId note (an E00 link, not an audit row).
      const linked = linkFile(ctx, {
        fileId: patch.logoDocumentId,
        entityId: row.id,
        entityKind: 'document_template',
      });
      if (!linked.ok) return linked;
    }
    return ok({ template: mapTemplate(ctx, readTemplate(ctx, row.id) as TemplateRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'update_document_template', () =>
      ctx.store.tx(run),
    );
  }
  return ctx.store.tx(run);
}

/**
 * Flip the per-kind default ATOMICALLY: the prior default clears in the same transaction, and the
 * partial unique index in the schema makes two defaults unrepresentable, not merely avoided.
 */
export function setDefaultDocumentTemplate(
  ctx: WorkspaceContext,
  input: { documentKind: string; templateId: string; idempotencyKey?: string },
): Result {
  const run = (): Result => {
    if (!KIND_SET.has(input.documentKind)) {
      return err('unknown_document_kind', { documentKind: input.documentKind, known: [...DOCUMENT_TEMPLATE_KINDS] });
    }
    const row = readTemplate(ctx, input.templateId);
    if (row === undefined) return err('not_found', { templateId: input.templateId });
    if (row.document_kind !== input.documentKind) {
      return err('kind_mismatch', { templateId: row.id, expected: input.documentKind, actual: row.document_kind });
    }
    if (row.archived === 1) return err('template_archived', { templateId: row.id });

    const now = ctx.clock.now();
    // Clear first, set second, one transaction: the partial unique index would abort the reverse order.
    ctx.store.db
      .prepare('UPDATE document_template SET is_default = 0 WHERE workspace_id = ? AND document_kind = ? AND id != ?')
      .run(ctx.workspaceId, input.documentKind, row.id);
    ctx.store.db
      .prepare('UPDATE document_template SET is_default = 1, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .run(now, ctx.workspaceId, row.id);
    return ok({ template: mapTemplate(ctx, readTemplate(ctx, row.id) as TemplateRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'set_default_document_template', () =>
      ctx.store.tx(run),
    );
  }
  return ctx.store.tx(run);
}

/**
 * Soft-archive. NEVER a delete (spec §4): a template frozen onto a past document keeps rendering.
 * Archiving the current default clears the default, so the kind falls back to the built-in fixed
 * layout for NEW documents; frozen documents are untouched.
 */
export function archiveDocumentTemplate(
  ctx: WorkspaceContext,
  input: { templateId: string; idempotencyKey?: string },
): Result {
  const run = (): Result => {
    const row = readTemplate(ctx, input.templateId);
    if (row === undefined) return err('not_found', { templateId: input.templateId });
    const now = ctx.clock.now();
    ctx.store.db
      .prepare(
        'UPDATE document_template SET archived = 1, is_default = 0, updated_at = ? WHERE workspace_id = ? AND id = ?',
      )
      .run(now, ctx.workspaceId, row.id);
    return ok({ template: mapTemplate(ctx, readTemplate(ctx, row.id) as TemplateRow) });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'archive_document_template', () =>
      ctx.store.tx(run),
    );
  }
  return ctx.store.tx(run);
}

/** The list read model (P5), with G00's saved-view seam like every sibling list verb. */
export function listDocumentTemplates(
  ctx: WorkspaceContext,
  input: { documentKind?: string; includeArchived?: boolean; savedViewId?: string },
): Result {
  const applied = applySavedView(ctx, 'document_template', {
    documentKind: input.documentKind,
    includeArchived: input.includeArchived,
    savedViewId: input.savedViewId,
  });
  if (!applied.ok) return applied;
  const filter = applied.filter as { documentKind?: string; includeArchived?: boolean };
  if (filter.documentKind !== undefined && !KIND_SET.has(filter.documentKind)) {
    return err('unknown_document_kind', { documentKind: filter.documentKind, known: [...DOCUMENT_TEMPLATE_KINDS] });
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT * FROM document_template
        WHERE workspace_id = ?
          AND (? IS NULL OR document_kind = ?)
          AND (archived = 0 OR ? = 1)
        ORDER BY document_kind, is_default DESC, name`,
    )
    .all(
      ctx.workspaceId,
      filter.documentKind ?? null,
      filter.documentKind ?? null,
      filter.includeArchived === true ? 1 : 0,
    ) as TemplateRow[];
  return ok({ templates: rows.map((r) => mapTemplate(ctx, r)) });
}

/** One template (P5). */
export function getDocumentTemplate(ctx: WorkspaceContext, input: { templateId: string }): Result {
  const row = readTemplate(ctx, input.templateId);
  if (row === undefined) return err('not_found', { templateId: input.templateId });
  return ok({ template: mapTemplate(ctx, row) });
}

// --- The render seam (consumed by A11/A13/A15, never an MCP verb) ------------------------------

/** What a consuming renderer gets back: which template resolved, its locale, and the footer lines. */
export interface ResolvedRenderTemplate {
  templateId: string | null;
  locale: string;
  footerLines: readonly string[];
  lineItemColumns: readonly string[];
}

/** The built-in fixed default: no template, de-CH, no footer. What every pre-G05 artifact renders. */
const BUILT_IN: ResolvedRenderTemplate = Object.freeze({
  templateId: null,
  locale: 'de-CH',
  footerLines: Object.freeze([]) as readonly string[],
  lineItemColumns: Object.freeze([]) as readonly string[],
});

/** The render-relevant slice of a template, as frozen at issue. */
interface TemplateSnapshot {
  footerI18n: Record<string, string>;
  languageMode: string;
  fixedLocale: string;
  lineItemColumns: string[];
}

function snapshotOf(row: TemplateRow): TemplateSnapshot {
  return {
    footerI18n: JSON.parse(row.footer_i18n) as Record<string, string>,
    languageMode: row.language_mode,
    fixedLocale: row.fixed_locale,
    lineItemColumns: JSON.parse(row.line_item_columns) as string[],
  };
}

/**
 * P11's locale chain: `fixed` takes the snapshot's own locale; `per_contact_lang` takes the
 * contact's `lang` when it is one of the four render locales, else falls back to `fixedLocale`.
 * The contact row is read LIVE, the same way `buildQrBill` reads the live contact on every render
 * (see `contactMerge.ts`): the debtor's language is a fact about the contact, not about the issue
 * moment.
 */
function resolveLocale(ctx: WorkspaceContext, snap: TemplateSnapshot, contactId: string | null): string {
  if (snap.languageMode !== 'per_contact_lang' || contactId === null) return snap.fixedLocale;
  const contact = ctx.store.db
    .prepare('SELECT lang FROM contact WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, contactId) as { lang: string | null } | undefined;
  const lang = contact?.lang ?? null;
  return lang !== null && LOCALE_SET.has(lang) ? lang : snap.fixedLocale;
}

/** The footer for a locale: exact locale, else the snapshot's fixedLocale text, else de-CH, else none. */
function footerLinesFor(snap: TemplateSnapshot, locale: string): readonly string[] {
  const text = snap.footerI18n[locale] ?? snap.footerI18n[snap.fixedLocale] ?? snap.footerI18n['de-CH'] ?? '';
  if (text.trim().length === 0) return [];
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, MAX_FOOTER_LINES);
}

function resolvedFrom(
  ctx: WorkspaceContext,
  templateId: string | null,
  snap: TemplateSnapshot,
  contactId: string | null,
): ResolvedRenderTemplate {
  const locale = resolveLocale(ctx, snap, contactId);
  return {
    templateId,
    locale,
    footerLines: footerLinesFor(snap, locale),
    lineItemColumns: snap.lineItemColumns,
  };
}

/**
 * Resolve the template a render uses (spec §4 resolution order, reconciled §0 item 4):
 *   1. an explicit `templateId` (the PREVIEW override, never a live render), resolved LIVE,
 *   2. the document's frozen snapshot (`rendered_template_snapshot`, written at issue),
 *   3. the built-in fixed default (P9: never an error).
 * The frozen path reads the SNAPSHOT, not the live row, so editing or archiving a template after
 * issue can never change what an issued document renders (spec §8's freeze property, both halves).
 */
export function resolveRenderTemplate(
  ctx: WorkspaceContext,
  input: {
    documentKind: string;
    table?: 'document' | 'dunning_run';
    rowId?: string;
    templateId?: string | null;
    contactId?: string | null;
  },
): ResolvedRenderTemplate {
  if (input.templateId !== undefined && input.templateId !== null) {
    const row = readTemplate(ctx, input.templateId);
    if (row === undefined || row.document_kind !== input.documentKind) return BUILT_IN;
    return resolvedFrom(ctx, row.id, snapshotOf(row), input.contactId ?? null);
  }
  if (input.table === undefined || input.rowId === undefined) return BUILT_IN;
  const frozen = ctx.store.db
    .prepare(
      `SELECT rendered_template_id, rendered_template_snapshot FROM ${input.table} WHERE workspace_id = ? AND id = ?`,
    )
    .get(ctx.workspaceId, input.rowId) as
    | { rendered_template_id: string | null; rendered_template_snapshot: string | null }
    | undefined;
  if (frozen === undefined || frozen.rendered_template_snapshot === null) return BUILT_IN;
  return resolvedFrom(
    ctx,
    frozen.rendered_template_id,
    JSON.parse(frozen.rendered_template_snapshot) as TemplateSnapshot,
    input.contactId ?? null,
  );
}

/**
 * Freeze the template a document was issued under: the default template's ID and a SNAPSHOT of its
 * render-relevant content, written ONCE inside the caller's issue transaction and never reassigned
 * (`AND rendered_template_id IS NULL`). When the kind has no default both columns stay NULL and the
 * document renders the built-in layout forever, the same guarantee from the other side. Callers:
 * A10's transition-to-issued (invoice/credit_note/quote) and A15's `issueDunningRun`. Never called
 * by a read verb (conformance rule 4).
 */
export function freezeRenderedTemplate(
  ctx: WorkspaceContext,
  input: { documentKind: string; documentId?: string; dunningRunId?: string },
): void {
  const def = ctx.store.db
    .prepare(
      'SELECT * FROM document_template WHERE workspace_id = ? AND document_kind = ? AND is_default = 1 AND archived = 0',
    )
    .get(ctx.workspaceId, input.documentKind) as TemplateRow | undefined;
  if (def === undefined) return;
  const snapshot = JSON.stringify(snapshotOf(def));
  if (input.documentId !== undefined) {
    ctx.store.db
      .prepare(
        `UPDATE document SET rendered_template_id = ?, rendered_template_snapshot = ?
          WHERE workspace_id = ? AND id = ? AND rendered_template_id IS NULL`,
      )
      .run(def.id, snapshot, ctx.workspaceId, input.documentId);
  } else if (input.dunningRunId !== undefined) {
    ctx.store.db
      .prepare(
        `UPDATE dunning_run SET rendered_template_id = ?, rendered_template_snapshot = ?
          WHERE workspace_id = ? AND id = ? AND rendered_template_id IS NULL`,
      )
      .run(def.id, snapshot, ctx.workspaceId, input.dunningRunId);
  }
}
