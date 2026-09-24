/**
 * G05 §10, Versand (`/dispatch`): the Textbausteine editor and the Protokoll, the two tabs the
 * spec draws (§10.6).
 *
 * WHY A ROUTE OF ITS OWN: the spec asked for "Settings → Versand"; there is no such surface (D89,
 * the settings-shaped screen is Setup and is A00's), so it lands as a rail item in the
 * workspace-governance cluster, the DocumentTemplates precedent exactly (spec §0 item 8e).
 *
 * THE SEND LINE, stated where it renders: this surface changes NO send behaviour. The lede says
 * so, because the operator editing the Mahnung text deserves to know the channels, confirmations
 * and recipients stay with the documents. The Protokoll is append-only: no control here (or
 * anywhere) edits or deletes a logged send.
 *
 * TWO LANGUAGES ON ONE SCREEN, deliberately (the §6 discipline): the editor chrome renders in the
 * operator's Studio locale; the text being edited belongs to the slot's locale tab.
 *
 * The preview re-renders on selection and ON SAVE, never per keystroke (§6 verbatim). Permission
 * gates are the Studio convenience over `whoami` (fail-open); the engine is the real gate, and the
 * pre-disabled Speichern carries its reason as a `.lock-note` beside it, never a hover-only title.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Tabs, type TabItem } from '../../components/Tabs';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Select } from '../../components/Select';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { Segmented } from '../../components/Segmented';
import { Status, type StatusKind } from '../../components/Status';
import { formatCalendar } from '../../lib/format';
import './Dispatch.css';

/** The engine's §H-ENUM kinds, mirrored (anything else is refused with unknown_document_kind). */
const KINDS = ['invoice', 'quote', 'dunning_run'] as const;
type Kind = (typeof KINDS)[number];

const KIND_KEY: Record<Kind, string> = { invoice: 'invoice', quote: 'quote', dunning_run: 'dunningRun' };

/** The four render locales (P11), mirrored from the engine's TEMPLATE_LOCALES. */
const LOCALES = ['de-CH', 'en', 'fr-CH', 'it-CH'] as const;

/**
 * The per-kind variable registry, MIRRORED from the engine's DISPATCH_VARIABLES (§H-ENUM): the
 * palette offers exactly what the save would accept, so a chip can never insert a refusal.
 */
const VARIABLES: Record<Kind, readonly string[]> = {
  invoice: ['contact_name', 'company_name', 'invoice_number', 'amount_total', 'currency', 'due_date'],
  quote: ['contact_name', 'company_name', 'quote_number', 'amount_total', 'currency', 'valid_until', 'accept_link'],
  dunning_run: [
    'contact_name',
    'company_name',
    'dunning_level',
    'overdue_total',
    'currency',
    'invoice_numbers',
    'run_date',
  ],
};

const OUTCOMES = ['sent', 'degraded', 'failed', 'artifact_created'] as const;
type Outcome = (typeof OUTCOMES)[number];
const OUTCOME_KEY: Record<Outcome, string> = {
  sent: 'sent',
  degraded: 'degraded',
  failed: 'failed',
  artifact_created: 'artifactCreated',
};
/** Outcome renders as the one Status word, glyph AND text, never colour alone (§10.6, K-22). */
const OUTCOME_KIND: Record<Outcome, StatusKind> = { sent: 'success', degraded: 'warn', failed: 'danger', artifact_created: 'neutral' };

/**
 * The degrade-reason codes the engine emits on a degraded/failed row (§H-ENUM, mirrored from
 * `src/core/sales/invoice.ts` and `src/core/dunning/run.ts`). Each has a `dispatch.log.degradeReason.<code>`
 * key in BOTH locales; the sibling channel/outcome columns are already translated, so this closes the
 * one raw-code leak in the Protokoll. Unknown or future codes fall back to a humanised form of the
 * code itself (`some_new_code` -> `Some new code`), never the raw token, so a new engine reason never
 * shows machine text to an operator.
 */
const DEGRADE_CODES = [
  'needs_customer_email',
  'no_email',
  'settled_since_issue',
  'needs_email_config',
  'needs_email_transport',
  'render_failed',
  'send_failed',
] as const;
const DEGRADE_CODE_SET = new Set<string>(DEGRADE_CODES);

/** Humanise a degrade code for the fallback: `settled_since_issue` -> `Settled since issue`. */
function humaniseDegradeCode(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface SavedText {
  documentKind: Kind;
  locale: string;
  subject: string;
  body: string;
}

interface LogRow {
  dispatchId: string;
  documentKind: Kind;
  documentId: string | null;
  dunningRunId: string | null;
  recipientEmail: string | null;
  channel: string;
  outcome: Outcome;
  degradeReason: string | null;
  sentAt: string;
}

interface Preview {
  subject: string;
  body: string;
  defaulted: boolean;
}

function parseTexts(body: unknown): SavedText[] {
  const texts = (body as { texts?: unknown })?.texts;
  if (!Array.isArray(texts)) return [];
  return texts
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
    .filter((x) => KINDS.includes(x.documentKind as Kind))
    .map((x) => ({
      documentKind: x.documentKind as Kind,
      locale: typeof x.locale === 'string' ? x.locale : 'de-CH',
      subject: typeof x.subject === 'string' ? x.subject : '',
      body: typeof x.body === 'string' ? x.body : '',
    }));
}

function parseRows(body: unknown): LogRow[] {
  const rows = (body as { dispatches?: unknown })?.dispatches;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
    .filter((x) => typeof x.dispatchId === 'string')
    .map((x) => ({
      dispatchId: x.dispatchId as string,
      documentKind: (KINDS.includes(x.documentKind as Kind) ? x.documentKind : 'invoice') as Kind,
      documentId: typeof x.documentId === 'string' ? x.documentId : null,
      dunningRunId: typeof x.dunningRunId === 'string' ? x.dunningRunId : null,
      recipientEmail: typeof x.recipientEmail === 'string' ? x.recipientEmail : null,
      channel: typeof x.channel === 'string' ? x.channel : 'smtp',
      outcome: (OUTCOMES.includes(x.outcome as Outcome) ? x.outcome : 'sent') as Outcome,
      degradeReason: typeof x.degradeReason === 'string' ? x.degradeReason : null,
      sentAt: typeof x.sentAt === 'string' ? x.sentAt : '',
    }));
}

/** `dd.mm.yyyy` from an ISO timestamp: the Swiss written-date convention, no time-zone maths. */

export function Dispatch() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const canManage = can(CAP.manageDispatchTexts);

  const [tab, setTab] = useState<'texts' | 'log'>('texts');
  const [kind, setKind] = useState<Kind>('invoice');
  const [locale, setLocale] = useState<string>('de-CH');
  const [texts, setTexts] = useState<SavedText[]>([]);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<'' | Outcome>('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [writeError, setWriteError] = useState<Err | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);
    const listed = await client.call('list_dispatches', { workspaceId });
    if (isErr(listed.body)) {
      if (listed.body.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }
    setTexts(parseTexts(listed.body));
    setRows(parseRows(listed.body));
    setLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The resolved sample preview for one slot: re-rendered on selection and on save, never per keystroke. */
  const renderPreview = useCallback(
    async (forKind: Kind, forLocale: string) => {
      if (workspaceId === null) return;
      const response = await client.call('dispatch_preview', {
        workspaceId,
        documentKind: forKind,
        locale: forLocale,
      });
      if (isErr(response.body)) {
        setPreview(null);
        return;
      }
      const messages = (response.body as unknown as { messages: Preview[] }).messages;
      setPreview(messages[0] ?? null);
    },
    [client, workspaceId],
  );

  /** Prefill the editor from the saved slot (or empty when the built-in default is in force). */
  const pickSlot = useCallback(
    (forKind: Kind, forLocale: string) => {
      setWriteError(null);
      const slot = texts.find((x) => x.documentKind === forKind && x.locale === forLocale);
      setSubject(slot?.subject ?? '');
      setBodyText(slot?.body ?? '');
      void renderPreview(forKind, forLocale);
    },
    [texts, renderPreview],
  );

  // The editor follows the loaded state: on first load and on slot switches.
  useEffect(() => {
    if (!loading && !failed && !denied) pickSlot(kind, locale);
  }, [loading, failed, denied, kind, locale, pickSlot]);

  const save = useCallback(async () => {
    if (workspaceId === null || subject.trim() === '' || bodyText.trim() === '') return;
    setWriteError(null);
    setSaved(false);
    setBusy(true);
    // Naturally idempotent (spec §10.4): the verb asserts the absolute state of one slot, so there
    // is deliberately NO idempotencyKey here.
    const response = await client.call('dispatch_text_upsert', {
      workspaceId,
      documentKind: kind,
      locale,
      subject,
      body: bodyText,
    });
    setBusy(false);
    if (isErr(response.body)) {
      setWriteError(response.body);
      return;
    }
    setSaved(true);
    await load();
    void renderPreview(kind, locale);
  }, [client, workspaceId, kind, locale, subject, bodyText, load, renderPreview]);

  /** Insert a variable chip into the body at the cursor (keyboard-reachable: chips are buttons). */
  const insertVariable = useCallback(
    (name: string) => {
      const token = `{{${name}}}`;
      const field = bodyRef.current;
      if (field === null) {
        setBodyText((current) => `${current}${token}`);
        return;
      }
      const start = field.selectionStart ?? bodyText.length;
      const end = field.selectionEnd ?? bodyText.length;
      setBodyText((current) => `${current.slice(0, start)}${token}${current.slice(end)}`);
      field.focus();
    },
    [bodyText],
  );

  const errorMessage = (error: Err): string => {
    if (error.error === 'unknown_variable') {
      const valid = Array.isArray((error as unknown as { valid?: unknown }).valid)
        ? ((error as unknown as { valid: string[] }).valid ?? []).join(', ')
        : '';
      return t('dispatch.err.unknownVariable', {
        variable: String((error as unknown as { variable?: unknown }).variable ?? ''),
        valid,
      });
    }
    if (error.error === 'permission_denied') return t('dispatch.needsPermission');
    return t('errors.fallback');
  };

  /**
   * The human label for a row's degrade reason. A known code resolves through the catalogue in the
   * operator's locale; a prefixed code (`render_failed:<detail>`) resolves on its head so the detail
   * never bleeds machine text into the cell; anything unknown is humanised from the code itself.
   */
  const degradeReasonLabel = (code: string): string => {
    const head = code.split(':')[0] ?? code;
    return DEGRADE_CODE_SET.has(head) ? t(`dispatch.log.degradeReason.${head}`) : humaniseDegradeCode(head);
  };

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('dispatch.permissionDenied.read')} />;

  const slotSaved = texts.some((x) => x.documentKind === kind && x.locale === locale);
  const visibleRows = outcomeFilter === '' ? rows : rows.filter((r) => r.outcome === outcomeFilter);

  const textsTab = (
    <div className="dispatch-body">
      <div className="dispatch-main">
        {/* The document kind and the locale pick which slot the one editor shows: two to five sibling
            values each, so two Segmented controls (K-11), the chosen value a neutral raise. */}
        <div className="dispatch-pickers">
          <Segmented
            label={t('dispatch.tab.texts')}
            options={KINDS.map((k) => ({ value: k, label: t(`dispatch.kind.${KIND_KEY[k]}`) }))}
            value={kind}
            onChange={(k) => {
              setKind(k);
              setSaved(false);
            }}
          />
          <Segmented
            label={t('dispatch.texts.localeTabs')}
            options={LOCALES.map((l) => ({ value: l, label: l }))}
            value={locale}
            onChange={(l) => {
              setLocale(l);
              setSaved(false);
            }}
          />
        </div>

        {!slotSaved && <p className="dispatch-muted">{t('dispatch.texts.defaultInUse')}</p>}

        <form
          className="dispatch-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="dispatch-field">
            <span>{t('dispatch.texts.subject')}</span>
            <input
              className="field"
              type="text"
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                setSaved(false);
              }}
            />
          </label>
          <label className="dispatch-field">
            <span>{t('dispatch.texts.body')}</span>
            <textarea
              className="field"
              ref={bodyRef}
              rows={7}
              value={bodyText}
              onChange={(e) => {
                setBodyText(e.target.value);
                setSaved(false);
              }}
            />
          </label>

          <fieldset className="dispatch-field">
            <legend>{t('dispatch.texts.variables')}</legend>
            <p className="dispatch-muted">{t('dispatch.texts.variablesHint')}</p>
            <div className="dispatch-chips">
              {VARIABLES[kind].map((name) => (
                <button
                  key={name}
                  type="button"
                  className="dispatch-chip"
                  onClick={() => insertVariable(name)}
                >
                  {`{{${name}}}`}
                </button>
              ))}
            </div>
          </fieldset>

          {writeError !== null && <ErrorBanner message={errorMessage(writeError)} />}
          {saved && <p role="status" className="dispatch-muted">{t('dispatch.texts.saved')}</p>}

          <div className="dispatch-actions">
            {/* A text save is not a money write, so it is the primary, never the tinted commit (K-08). */}
            <button
              type="submit"
              className="btn btn--primary"
              disabled={!canManage || busy || subject.trim() === '' || bodyText.trim() === ''}
            >
              {t('dispatch.texts.save')}
            </button>
            {!canManage && <p className="lock-note">{t('dispatch.needsPermission')}</p>}
          </div>
        </form>
      </div>

      <aside className="dispatch-preview" aria-labelledby="dispatch-preview-title">
        <h2 id="dispatch-preview-title" className="dispatch-preview-title">
          {t('dispatch.texts.preview')}
        </h2>
        <p className="dispatch-muted">{t('dispatch.texts.previewHint')}</p>
        {preview !== null && (
          <>
            <p className="dispatch-muted">
              {preview.defaulted ? t('dispatch.texts.previewDefault') : t('dispatch.texts.previewSaved')}
            </p>
            <p className="dispatch-preview-subject">{preview.subject}</p>
            <p className="dispatch-preview-body">{preview.body}</p>
          </>
        )}
      </aside>
    </div>
  );

  // The Protokoll columns for the shared DataTable. All text, left-aligned: no money column here.
  // The result cell is glyph + label (never colour alone, §10.6); the document cell links out.
  const logColumns: DataTableColumn<LogRow>[] = [
    { key: 'date', header: t('dispatch.log.date'), render: (row) => formatCalendar(row.sentAt) },
    { key: 'kind', header: t('dispatch.log.kind'), render: (row) => t(`dispatch.kind.${KIND_KEY[row.documentKind]}`) },
    { key: 'recipient', header: t('dispatch.log.recipient'), render: (row) => row.recipientEmail ?? '' },
    { key: 'channel', header: t('dispatch.log.channel'), render: (row) => t(`dispatch.log.channelName.${row.channel}`) },
    {
      key: 'result',
      header: t('dispatch.log.result'),
      render: (row) => (
        <>
          <Status kind={OUTCOME_KIND[row.outcome]} label={t(`dispatch.log.outcome.${OUTCOME_KEY[row.outcome]}`)} />
          {row.degradeReason !== null && (
            <span className="dispatch-muted"> ({degradeReasonLabel(row.degradeReason)})</span>
          )}
        </>
      ),
    },
    {
      key: 'document',
      header: t('dispatch.log.document'),
      render: (row) =>
        row.documentId !== null ? (
          <Link className="link-inline" to={`/documents/${row.documentId}`}>{t('dispatch.log.open')}</Link>
        ) : row.dunningRunId !== null ? (
          <Link className="link-inline" to="/dunning">{t('dispatch.log.openRun')}</Link>
        ) : null,
    },
  ];

  const logTab = (
    <div className="dispatch-main">
      <div className="dispatch-filter">
        <span>{t('dispatch.log.filterLabel')}</span>
        <Select
          value={outcomeFilter}
          onChange={(val) => setOutcomeFilter(val as '' | Outcome)}
          options={[
            { value: '', label: t('dispatch.log.filterAll') },
            ...OUTCOMES.map((o) => ({ value: o, label: t(`dispatch.log.outcome.${OUTCOME_KEY[o]}`) })),
          ]}
          ariaLabel={t('dispatch.log.filterLabel')}
        />
      </div>
      <DataTable
        columns={logColumns}
        rows={visibleRows}
        rowKey={(row) => row.dispatchId}
        caption={t('dispatch.log.caption')}
        emptyState={<EmptyState title={t('dispatch.log.empty')} hint={t('dispatch.log.emptyHint')} />}
      />
    </div>
  );

  // Each top-level panel handles the shared loading/failed states in place, so the tab strip stays
  // in view while the read is in flight instead of the whole surface blanking to a skeleton.
  const panelBody = (content: React.ReactNode) =>
    loading ? <Skeleton rows={4} labelKey="dispatch.loading" /> : failed ? null : content;

  const tabs: TabItem[] = [
    { id: 'texts', label: t('dispatch.tab.texts'), panel: panelBody(textsTab) },
    { id: 'log', label: t('dispatch.tab.log'), panel: panelBody(logTab) },
  ];

  return (
    <section className="dispatch" aria-labelledby="dispatch-title">
      <SurfaceHeader
        title={t('dispatch.title')}
        titleId="dispatch-title"
        help={<SurfaceHelp surface="Dispatch" />}
      />
      {/* The send line, in place: what this surface can NEVER change. */}
      <p className="dispatch-lede">{t('dispatch.lede')}</p>

      {failed && <ErrorBanner context="read" onRetry={() => void load()} />}

      <Tabs
        tabs={tabs}
        activeId={tab}
        onChange={(id) => setTab(id as 'texts' | 'log')}
        label={t('dispatch.title')}
      />
    </section>
  );
}
export default Dispatch;
