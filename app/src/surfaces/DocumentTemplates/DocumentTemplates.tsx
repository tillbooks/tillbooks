/**
 * G05, Vorlagen (`/document-templates`): branded document templates per kind (Rechnung, Gutschrift,
 * Offerte, Mahnung), with the live Vorschau pane beside the editor.
 *
 * WHY IT IS A ROUTE OF ITS OWN: the spec asked for "Settings → Branding"; there is no such surface
 * (D89, the settings-shaped screen is Setup and is A00's), so it lands as a rail item in the
 * workspace-governance cluster, the G00/G01/E05 precedent (see nav.ts).
 *
 * THE STATUTORY LINE, stated where it renders: a template changes PRESENTATION only. The Swiss
 * QR-bill payload, the VAT figures and the legal content are produced by the document itself and
 * pass through byte-identical under every template; the lede says so, because the operator
 * branding an invoice deserves to know what CANNOT break.
 *
 * TWO LANGUAGES ON ONE SCREEN, deliberately (spec §6): the editor chrome renders in the operator's
 * own Studio locale; the Vorschau pane renders in whatever locale the template resolves
 * (fixedLocale, or the sample contact's language). They are never the same control.
 *
 * The preview re-renders ON SAVE and on selection, never per keystroke (spec §6). The permission
 * gates are the Studio convenience over `whoami` (fail-open); the engine is the real gate, and the
 * pre-disabled controls carry the reason as a `.lock-note` beside them, never a hover-only title.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import './DocumentTemplates.css';

/** A fresh key per write, so a retry after a transport failure is a retry and not a second write. */
const newKey = () => crypto.randomUUID();

/** The engine's §H-ENUM kinds, mirrored (the engine refuses anything else with unknown_document_kind). */
const KINDS = ['invoice', 'credit_note', 'quote', 'dunning_run'] as const;
type Kind = (typeof KINDS)[number];

/** i18n key suffix per kind (`docTemplate.kind.*`, the spec §6 names). */
const KIND_KEY: Record<Kind, string> = {
  invoice: 'invoice',
  credit_note: 'creditNote',
  quote: 'quote',
  dunning_run: 'dunningRun',
};

/** The four render locales (P11), mirrored from the engine's TEMPLATE_LOCALES. */
const LOCALES = ['de-CH', 'en', 'fr-CH', 'it-CH'] as const;

/** The OPTIONAL, non-legal columns the engine admits; legal columns are never on offer. */
const COLUMNS = ['discount', 'sku', 'project', 'unit'] as const;

interface Template {
  templateId: string;
  documentKind: Kind;
  name: string;
  lineItemColumns: string[];
  footerI18n: Record<string, string>;
  languageMode: 'fixed' | 'per_contact_lang';
  fixedLocale: string;
  isDefault: boolean;
  archived: boolean;
  logoFileId: string | null;
}

interface Editor {
  templateId: string | null;
  name: string;
  footerI18n: Record<string, string>;
  languageMode: 'fixed' | 'per_contact_lang';
  fixedLocale: string;
  lineItemColumns: string[];
  logoFileId: string | null;
  pendingLogo: { base64: string; mime: string; name: string } | null;
}

interface Preview {
  base64: string;
  sample: boolean;
  locale: string;
}

function parseTemplates(body: unknown): Template[] {
  const templates = (body as { templates?: unknown })?.templates;
  if (!Array.isArray(templates)) return [];
  return templates
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
    .filter((x) => typeof x.templateId === 'string' && KINDS.includes(x.documentKind as Kind))
    .map((x) => ({
      templateId: x.templateId as string,
      documentKind: x.documentKind as Kind,
      name: typeof x.name === 'string' ? x.name : '',
      lineItemColumns: Array.isArray(x.lineItemColumns) ? (x.lineItemColumns as string[]) : [],
      footerI18n:
        x.footerI18n !== null && typeof x.footerI18n === 'object' ? (x.footerI18n as Record<string, string>) : {},
      languageMode: x.languageMode === 'per_contact_lang' ? 'per_contact_lang' : 'fixed',
      fixedLocale: typeof x.fixedLocale === 'string' ? x.fixedLocale : 'de-CH',
      isDefault: x.isDefault === true,
      archived: x.archived === true,
      logoFileId: typeof x.logoFileId === 'string' ? x.logoFileId : null,
    }));
}

function emptyEditor(): Editor {
  return {
    templateId: null,
    name: '',
    footerI18n: {},
    languageMode: 'fixed',
    fixedLocale: 'de-CH',
    lineItemColumns: [],
    logoFileId: null,
    pendingLogo: null,
  };
}

function editorOf(template: Template): Editor {
  return {
    templateId: template.templateId,
    name: template.name,
    footerI18n: { ...template.footerI18n },
    languageMode: template.languageMode,
    fixedLocale: template.fixedLocale,
    lineItemColumns: [...template.lineItemColumns],
    logoFileId: template.logoFileId,
    pendingLogo: null,
  };
}

export function DocumentTemplates() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const canManage = can(CAP.manageDocumentTemplates);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [kind, setKind] = useState<Kind>('invoice');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [footerLocale, setFooterLocale] = useState<string>('de-CH');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const listed = await client.call('list_document_templates', { workspaceId, includeArchived: true });
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    setTemplates(parseTemplates(listed.body));
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The Vorschau, re-rendered on selection and on save, never per keystroke (spec §6). */
  const renderPreview = useCallback(
    async (templateId: string) => {
      if (workspaceId === null) return;
      const response = await client.call('preview_document_template', { workspaceId, templateId });
      if (isErr(response.body)) {
        setPreview(null);
        return;
      }
      const body = response.body as unknown as {
        pdf: { base64: string };
        sample: boolean;
        locale: string;
      };
      setPreview({ base64: body.pdf.base64, sample: body.sample === true, locale: body.locale });
    },
    [client, workspaceId],
  );

  const pick = useCallback(
    (template: Template) => {
      setWriteError(null);
      setEditor(editorOf(template));
      setFooterLocale(template.fixedLocale);
      void renderPreview(template.templateId);
    },
    [renderPreview],
  );

  const save = useCallback(async () => {
    if (workspaceId === null || editor === null || editor.name.trim() === '') return;
    setWriteError(null);
    setBusy(true);

    // The logo is an ordinary E00 file: upload first, then hand the id to the template write.
    let logoDocumentId: string | undefined;
    if (editor.pendingLogo !== null) {
      const uploaded = await client.call('files_upload', {
        workspaceId,
        title: editor.pendingLogo.name,
        mime: editor.pendingLogo.mime,
        contentBase64: editor.pendingLogo.base64,
        idempotencyKey: newKey(),
      });
      if (isErr(uploaded.body)) {
        setWriteError(uploaded.body);
        setBusy(false);
        return;
      }
      logoDocumentId = (uploaded.body as unknown as { file: { id: string } }).file.id;
    }

    const fields = {
      name: editor.name.trim(),
      footerI18n: editor.footerI18n,
      languageMode: editor.languageMode,
      fixedLocale: editor.fixedLocale,
      // The dunning letter's list format is fixed; the engine ignores columns for it anyway.
      ...(kind === 'dunning_run' ? {} : { lineItemColumns: editor.lineItemColumns }),
      ...(logoDocumentId !== undefined ? { logoDocumentId } : {}),
    };
    const response =
      editor.templateId === null
        ? await client.call('create_document_template', {
            workspaceId,
            documentKind: kind,
            ...fields,
            idempotencyKey: newKey(),
          })
        : await client.call('update_document_template', {
            workspaceId,
            templateId: editor.templateId,
            patch: fields,
            idempotencyKey: newKey(),
          });
    setBusy(false);
    if (isErr(response.body)) {
      setWriteError(response.body);
      return;
    }
    const saved = (response.body as unknown as { template: { templateId: string } }).template.templateId;
    await load();
    setEditor(null);
    void renderPreview(saved);
  }, [client, workspaceId, editor, kind, load, renderPreview]);

  const setDefault = useCallback(
    async (templateId: string) => {
      if (workspaceId === null) return;
      setWriteError(null);
      const response = await client.call('set_default_document_template', {
        workspaceId,
        documentKind: kind,
        templateId,
        idempotencyKey: newKey(),
      });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return;
      }
      await load();
    },
    [client, workspaceId, kind, load],
  );

  const archive = useCallback(
    async (templateId: string) => {
      if (workspaceId === null) return;
      setWriteError(null);
      const response = await client.call('archive_document_template', {
        workspaceId,
        templateId,
        idempotencyKey: newKey(),
      });
      if (isErr(response.body)) {
        setWriteError(response.body);
        return;
      }
      if (editor?.templateId === templateId) setEditor(null);
      await load();
    },
    [client, workspaceId, editor, load],
  );

  const pickLogo = useCallback((file: File | undefined) => {
    if (file === undefined) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      const base64 = url.slice(url.indexOf(',') + 1);
      setEditor((current) =>
        current === null ? null : { ...current, pendingLogo: { base64, mime: file.type, name: file.name } },
      );
    };
    reader.readAsDataURL(file);
  }, []);

  const errorMessage = (error: Err): string => {
    if (error.error === 'needs_valid_logo_file') return t('docTemplate.needsValidLogoFile');
    if (error.error === 'permission_denied') return t('docTemplate.needsPermission');
    if (error.error === 'invalid_line_item_columns') return t('docTemplate.invalidColumns');
    if (error.error === 'template_archived') return t('docTemplate.archivedRefusal');
    return t('errors.fallback');
  };

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('docTemplate.permissionDenied.read')} />;

  const ofKind = templates.filter((x) => x.documentKind === kind);
  const active = ofKind.filter((x) => !x.archived);

  // The template list is the shared DataTable (frame overflow, sticky header, density and the five
  // states), so the bespoke `<ul>` and its row CSS are gone. A row opens the editor beside the live
  // Vorschau; the per-row lifecycle controls (Als Standard festlegen, Archivieren) live in the last
  // column and stop the row-open click, so they stay independent affordances inside a clickable row.
  const columns: DataTableColumn<Template>[] = [
    { key: 'name', header: t('docTemplate.name'), render: (template) => template.name },
    {
      key: 'status',
      header: t('docTemplate.statusCol'),
      render: (template) =>
        template.isDefault ? (
          <span className="doctpl-badge">
            <span aria-hidden="true">★</span> {t('docTemplate.default')}
          </span>
        ) : template.archived ? (
          <span className="doctpl-muted">{t('docTemplate.archived')}</span>
        ) : null,
    },
    {
      key: 'actions',
      header: t('docTemplate.actionsCol'),
      headerHidden: true,
      align: 'end',
      render: (template) =>
        template.archived ? null : (
          <span className="doctpl-row-actions" onClick={(e) => e.stopPropagation()}>
            {!template.isDefault && (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={!canManage || busy}
                onClick={() => void setDefault(template.templateId)}
              >
                {t('docTemplate.setDefault')}
              </button>
            )}
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              disabled={!canManage || busy}
              onClick={() => void archive(template.templateId)}
            >
              {t('docTemplate.archive')}
            </button>
          </span>
        ),
    },
  ];

  const list = (
    <DataTable
      columns={columns}
      rows={ofKind}
      rowKey={(template) => template.templateId}
      caption={t('docTemplate.listCaption')}
      onRowClick={pick}
      rowLabel={(template) => template.name}
      rowClassName={(template) => (template.archived ? 'doctpl-row--archived' : undefined)}
      emptyState={<></>}
    />
  );

  const editorPanel = editor !== null && (
    <form
      className="doctpl-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="doctpl-field">
        <span>{t('docTemplate.name')}</span>
        <input type="text" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} />
      </label>

      <fieldset className="doctpl-field">
        <legend>{t('docTemplate.logo')}</legend>
        {editor.logoFileId !== null && editor.pendingLogo === null && (
          <p className="doctpl-muted">{t('docTemplate.logoCurrent')}</p>
        )}
        {editor.pendingLogo !== null && <p className="doctpl-muted">{editor.pendingLogo.name}</p>}
        {/* A plain file input: keyboard-operable by construction, never drag-and-drop-only. */}
        <input
          type="file"
          accept="image/*"
          aria-label={t('docTemplate.uploadLogo')}
          onChange={(e) => pickLogo(e.target.files?.[0])}
        />
        <p className="doctpl-muted">{t('docTemplate.logoNote')}</p>
      </fieldset>

      <fieldset className="doctpl-field">
        <legend>{t('docTemplate.footer')}</legend>
        <div className="doctpl-locale-tabs" role="tablist" aria-label={t('docTemplate.footer')}>
          {LOCALES.map((locale) => (
            <button
              key={locale}
              type="button"
              role="tab"
              aria-selected={footerLocale === locale}
              className={`doctpl-tab${footerLocale === locale ? ' doctpl-tab--active' : ''}`}
              onClick={() => setFooterLocale(locale)}
            >
              {locale}
            </button>
          ))}
        </div>
        <textarea
          rows={3}
          aria-label={t('docTemplate.footerFor', { locale: footerLocale })}
          value={editor.footerI18n[footerLocale] ?? ''}
          onChange={(e) =>
            setEditor({ ...editor, footerI18n: { ...editor.footerI18n, [footerLocale]: e.target.value } })
          }
        />
      </fieldset>

      <fieldset className="doctpl-field">
        <legend>{t('docTemplate.languageMode.label')}</legend>
        <label className="doctpl-radio">
          <input
            type="radio"
            name="doctpl-lang"
            checked={editor.languageMode === 'fixed'}
            onChange={() => setEditor({ ...editor, languageMode: 'fixed' })}
          />{' '}
          {t('docTemplate.languageMode.fixed')}
        </label>
        <label className="doctpl-radio">
          <input
            type="radio"
            name="doctpl-lang"
            checked={editor.languageMode === 'per_contact_lang'}
            onChange={() => setEditor({ ...editor, languageMode: 'per_contact_lang' })}
          />{' '}
          {t('docTemplate.languageMode.perContactLang')}
        </label>
        <label className="doctpl-field">
          <span>{t('docTemplate.fixedLocale')}</span>
          <select value={editor.fixedLocale} onChange={(e) => setEditor({ ...editor, fixedLocale: e.target.value })}>
            {LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {locale}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      {kind !== 'dunning_run' && (
        <fieldset className="doctpl-field">
          <legend>{t('docTemplate.columns')}</legend>
          <p className="doctpl-muted">{t('docTemplate.columnsNote')}</p>
          {COLUMNS.map((column) => (
            <label key={column} className="doctpl-check">
              <input
                type="checkbox"
                checked={editor.lineItemColumns.includes(column)}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    lineItemColumns: e.target.checked
                      ? [...editor.lineItemColumns, column]
                      : editor.lineItemColumns.filter((c) => c !== column),
                  })
                }
              />{' '}
              {t(`docTemplate.column.${column}`)}
            </label>
          ))}
        </fieldset>
      )}

      <div className="doctpl-actions">
        <button type="submit" className="btn btn--accent" disabled={!canManage || busy || editor.name.trim() === ''}>
          {t('docTemplate.save')}
        </button>
        <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => setEditor(null)}>
          {t('docTemplate.cancel')}
        </button>
      </div>
    </form>
  );

  const previewPane = (
    <aside className="doctpl-preview" aria-labelledby="doctpl-preview-title">
      <h2 id="doctpl-preview-title" className="doctpl-preview-title">
        {t('docTemplate.preview')}
      </h2>
      {preview === null ? (
        <p className="doctpl-muted">{t('docTemplate.previewHint')}</p>
      ) : (
        <>
          {preview.sample && <p className="doctpl-muted">{t('docTemplate.samplePreview')}</p>}
          <p className="doctpl-muted">{t('docTemplate.previewLocale', { locale: preview.locale })}</p>
          <object
            className="doctpl-preview-pdf"
            type="application/pdf"
            data={`data:application/pdf;base64,${preview.base64}`}
            aria-label={t('docTemplate.previewAria')}
          >
            <p className="doctpl-muted">{t('docTemplate.previewFallback')}</p>
          </object>
        </>
      )}
    </aside>
  );

  const newTemplate = (
    <button
      type="button"
      className="btn btn--accent"
      disabled={!canManage || busy}
      onClick={() => {
        setWriteError(null);
        setEditor(emptyEditor());
        setFooterLocale('de-CH');
      }}
    >
      {t('docTemplate.new')}
    </button>
  );

  return (
    <section className="doctpl" aria-labelledby="doctpl-title">
      <SurfaceHeader
        title={t('docTemplate.title')}
        titleId="doctpl-title"
        help={<SurfaceHelp surface="DocumentTemplates" />}
        actions={
          <>
            {newTemplate}
            {!canManage && <p className="lock-note">{t('docTemplate.needsPermission')}</p>}
          </>
        }
      />
      {/* The statutory line, in place: what a template can NEVER change. */}
      <p className="doctpl-lede">{t('docTemplate.lede')}</p>

      <div className="doctpl-kinds" role="tablist" aria-label={t('docTemplate.title')}>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            className={`doctpl-tab${kind === k ? ' doctpl-tab--active' : ''}`}
            onClick={() => {
              setKind(k);
              setEditor(null);
              setPreview(null);
            }}
          >
            {t(`docTemplate.kind.${KIND_KEY[k]}`)}
          </button>
        ))}
      </div>

      {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
      {failed && <ErrorBanner message={t('errors.fallback')} onRetry={() => void load()} />}

      {loading ? (
        <Skeleton rows={4} labelKey="docTemplate.loading" />
      ) : failed ? null : (
        <div className="doctpl-body">
          <div className="doctpl-main">
            {active.length === 0 && editor === null ? (
              <EmptyState title={t('docTemplate.empty')} hint={t('docTemplate.emptyHint')} />
            ) : (
              list
            )}
            {editorPanel}
          </div>
          {previewPane}
        </div>
      )}
    </section>
  );
}
export default DocumentTemplates;
