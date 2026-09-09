/**
 * G00, the Anpassung surface: every custom field and every shared view on every entity, in one place.
 *
 * WHY A SCREEN AT ALL, against the canon's high bar for adding one. No existing surface can answer
 * "what does this workspace already record that TILL did not ship with?", and that is the question an
 * operator has to answer twice: before defining a field, so they do not add `segment` next to someone
 * else's `kundensegment`, and before granting `manage_custom_fields` to a role, so governance knows
 * what the grant covers. A per-entity panel on each of fifteen screens answers it fifteen times and
 * therefore never.
 *
 * TWO TABS, FIELDS AND VIEWS, and the tab strip is not decoration: they are separate capabilities
 * (`manage_custom_fields`, `manage_saved_views`), so a role scoped to one still gets a working screen
 * with the other half read-only. Each panel hides its own write controls independently, which is the
 * canon's rule: never show a control that will always reject on click.
 *
 * THE DRAFT BANNER IS GLYPH-AND-TEXT, never colour alone (WCAG 2.2 AA), and it is the visible half of
 * P8: a field an agent defined is on this screen, marked, and does nothing until a human releases it.
 * That is the whole point of draft-by-default, and hiding it here would make the mechanism invisible
 * to the only person who can act on it.
 */
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCapabilities, CAP } from '../../lib/capabilities';
import { useT, useI18n } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Tabs } from '../../components/Tabs';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton } from '../../components/states';
import { CustomFieldRow, labelFor, type FieldDefDto } from './CustomFieldRow';
import { SavedViewPicker, type SavedViewDto } from './SavedViewPicker';
import './Customization.css';

/** §H-IDEMPOTENT: a retry with the same key never double-acts. */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * The entity kinds G00's OP3 registry carries, in the order the panels render.
 *
 * MIRRORED, NOT INVENTED: this is `ENTITY_KINDS` in `src/core/customization/entities.ts`, and the
 * engine refuses anything outside it with `unknown_entity_kind`, so a drift here costs a rejection
 * the operator can read rather than a silent wrong write. A registry read verb would remove the
 * mirror entirely and is the right follow-up; it is not worth a tenth tool in this build.
 */
const ENTITY_KINDS = [
  'contact',
  'item',
  'bank_account',
  'account',
  'cost_center',
  'document',
  'payment',
  'journal_entry',
  // G01, added with its row in `entities.ts`. `test/style/studio-mirrors-engine-enums.test.mjs` is
  // what makes this mirror safe to keep: registering the kind and forgetting this list is a red gate
  // rather than a panel nobody can reach.
  'automation_rule',
  // A17, added with its row in `entities.ts` by the same route G01's was.
  'vendor_bill',
  // A15, added with its row in `entities.ts` by the same route.
  'dunning_run',
  // A12, added with its row in `entities.ts` by the same route.
  'recurring_schedule',
  // A21, added with its row in `entities.ts` by the same route: review-decision metadata on the
  // Abgleich queue (a review note, a "reviewed by"), never a shadow of the matching columns.
  'reconciliation_match',
  // A20, added with its row in `entities.ts` by the same route: a category tag or a "reviewed by"
  // reference on an imported bank transaction, never a shadow of its imported-fact columns.
  'bank_txn',
  // A18, added with its row in `entities.ts` by the same route: a payment run's own metadata (a
  // purpose note, an approver name), never the pain.001 payload or the settlement it triggers.
  'payment_batch',
  // A23, added with its row in `entities.ts` by the same route: per-mandate metadata a Treuhänder
  // hangs on the client book itself (a mandate type, an engagement-letter date), never the fiscal
  // config or the archived flag, which stay single-sourced on the row.
  'workspace',
  // A25, added with its row in `entities.ts` by the same route: a custom field on a review event (a
  // "Risk" or "Follow-up" tag on an entry_review row), never a shadow of the immutable journal it
  // annotates.
  'entry_review',
  // G10, added with its row in `entities.ts` by the same route: annotation on a Zuordnungsvorlage
  // (a "Mandant" note, a "Quellsystem-Version" select), never the mapping entries themselves,
  // which only the G10 map verbs write.
  'migration_map_template',
  // G09, added with its rows in `entities.ts` by the same route: annotation on a migration plan or
  // step (a "Verantwortlich" note, a "Quellsystem" select), never the plan/step machine's own fields.
  'migration_plan',
  'migration_step',
  // G11, added with its row in `entities.ts` by the same route: annotation on a persisted
  // Eröffnungsprüfung (a "Von Treuhänder geprüft" text, a "Freigabe erteilt am" date), never the
  // control snapshot or its hash, which stay append-only.
  'migration_check',
  // G19, added with its row in `entities.ts` by the same route: annotation on an export manifest (a
  // "Wer exportiert" assignee, a per-item note), never the item statuses, fileIds or deletion clock,
  // which stay the manifest's own columns and JSON.
  'migration_extraction_manifest',
  // G13, added with its row in `entities.ts` by the same route: annotation on an archived
  // prior-system entry (a Treuhänder's Prüfvermerk during due diligence), never the archived
  // values themselves, which sit behind BEFORE-triggers and cannot move.
  'gl_archive_entry',
  // B00, added with its rows in `entities.ts` by the same route: a "Projekttyp" or "Health" select
  // on a project, a "Verantwortlich" contact_ref on a phase, never the PROJECT_STATUS machine or
  // the money-path budget columns, which stay single-sourced on the row.
  'project',
  'project_phase',
  // E03, added with its row in `entities.ts` by the same route: a `priority` select or a
  // workspace-defined category on a task, never a shadow of the fixed status enum, which every
  // consumer of the queue hard-codes.
  'task',
  // B01, added with its row in `entities.ts` by the same route: a "Work type" select or an
  // internal cost-center override on a time entry, never a shadow of the fixed status machine,
  // the rate snapshot columns or the ArG record columns, which stay single-sourced on the row.
  'time_entry',
  // C01, added with its row in `entities.ts` by the same route: an "Umsatzquelle" select or a
  // "Partner" contact_ref on a deal, never a shadow of the fixed DEAL_STATUSES enum or the frozen
  // §H-FX value trio, which stay single-sourced on the row.
  'deal',
  // D01, added with its rows in `entities.ts` by the same route: a zone/aisle or contact-person
  // field on a stock location, a counted-by/condition note on a stocktake session, never the fixed
  // STOCK_REASON / VALUATION_METHOD / STOCKTAKE_STATUS enums, which stay single-sourced.
  'stock_location',
  'stocktake',
  // C02, added with its rows in `entities.ts` by the same route: a "Projekt-Referenz" or
  // "Vertriebskanal" on a quote, a delivery-lead-time or supplier-SKU on a quote line, never a shadow
  // of the fixed document status/type or the OR Art. 3 binding window, which stay single-sourced.
  'quote',
  'quote_line',
  // D03, added with its rows in `entities.ts` by the same route: an "Interne Projekt-Referenz" or
  // "Priorität" on a sales order, a "Frachtführer" or "Tracking-Nummer" on a delivery note, never a
  // shadow of the fixed SO_STATUS/DN_STATUS enums or the order -> delivery -> invoice sequencing.
  'sales_order',
  'delivery_note',
  // D02, added with its row in `entities.ts` by the same route: a requisition reference or
  // "Projektbezug" tag on a purchase order, never a shadow of qty/price/tax or the fixed PO_STATUS.
  'po',

  // E02, added with its rows in `entities.ts` by the same route: a cost-center note or badge number
  // on an employee, an internal project reference or "Genehmigungsnotiz" on an expense claim, and
  // saved views over the three Personal tabs (employee/absence/expense_claim), never a shadow of the
  // AHV number, the absence kind/status enums or the claim status machine, which stay single-sourced.
  'employee',
  'absence',
  'expense_claim',
  // B04, added with its row in `entities.ts` by the same route: an account-manager tag or a
  // "Vertragsreferenz" on a mandate, plus saved views over the Mandate tab, never a shadow of the
  // period/status or draw-kind enums or the coverage/cap/rollover computation, which stay single-sourced.
  'retainer',
  // E01, added with its row in `entities.ts` by the same route: an internal reference or a
  // contract-type tag on a sign request, plus saved views over the request list, never a shadow of
  // the fixed SIGN_REQUEST_STATUS / SIGNATURE_LEVEL enums or the sha256 integrity anchor, which
  // stay single-sourced on the row.
  'sign_request',
  // F02, added with its row in `entities.ts` by the same route: a "Grund der Freigabe" note or an
  // "angefragt von" reference on a portal grant, plus saved views over the Portal-Zugang list, never
  // a shadow of the token, the scopes that gate what a customer sees, or the expiry, which stay
  // single-sourced on the row and out of the resolver's three-fence check.
  'portal_grant',
  // F03, added with its row in `entities.ts` by the same route: a custom field ANNOTATES a remittance
  // advice, never a shadow of its frozen snapshot money columns, which the immutability trigger holds.
  'remittance_advice',
  // F01, added with its row in `entities.ts` by the same route: a "Mandant" note or a "Freigabe
  // erteilt" field on a retained report run, never a shadow of the run status/format enums or the
  // definition-hash trail, which stay single-sourced on the row.
  'report_run',
  // E04, added with its row in `entities.ts` by the same drift-guarded route. The engine's
  // `fieldTypes` slice on this kind refuses free-form types at define time, so the panel's type
  // picker simply sees the refusal the operator can read.
  'mail_thread',
  // G04, added with its row in `entities.ts` by the same drift-guarded route: a backup-history row is
  // an OP3 kind so a "Reason" tag or a "Keep until" date can be hung on it and queried later.
  'backup',
  // G05, added with its row in `entities.ts` by the same route: an internal owner/approval note or
  // a "Verwendungszweck" tag on a document template, never the kind/language enums, the default
  // flag or the frozen snapshot, which stay single-sourced on the row.
  'document_template',
  // G06, added with its row in `entities.ts` by the same route: saved views over the /inbox queue
  // ("Nur ungelesen", "Nur Rechnungen") and annotation fields on a delivered moment, never the
  // status/delivered_via/event columns, which stay single-sourced on the row.
  'inbox_item',
  // G07, added with its row in `entities.ts` by the same route: the attachment-only hook a saved
  // search hangs off (it rides the workspace table's self-tenant shape), never itself a search
  // target; the engine's `fieldTypes` slice bounds it to select/multiselect/bool/date.
  'global_search',
  // G02: an installed plugin carries annotation fields (an internal "support contact", a "reviewed
  // by" reference) and saved views over the Erweiterungen list, never the manifest contract columns
  // (capabilities/permissions/sha256/status/compat_range), which stay single-sourced on the row.
  'plugin',
  // G05 §10, added with its row in `entities.ts` by the same route: annotation on a send-log row
  // (a follow-up note on a disputed send, a "Klärung offen" select), never the logged send itself,
  // which stays append-only through the verb surface.
  'dispatch',
  // A31: a capture (Belegeingang queue row) carries annotation fields (a "Projektbezug" tag, a
  // scanning-batch reference) and saved views, never the extraction-truth columns (status/provenance/
  // confidence or any CAPTURE_FIELD_KEY value), which the reserved-key list keeps off limits.
  'capture',
  // A34: a payroll hand-off record carries annotation fields (a "Provider" select, a "Periode-Notiz")
  // and saved views over the history, never a person's wage (the entity is the export event) and
  // never the AHV gate (§6b Fixed, revDSG Art. 6).
  'payroll_handoff',
  // A32: an eBill delivery carries annotation fields (a "Freigabe-Referenz", a "Kanal-Notiz") and
  // saved views over the delivery read model, never the payload bytes or the mirrored partner status,
  // which stay single-sourced (§H-ENUM) or mirrored verbatim.
  'ebill_delivery',
  // A33: custom fields annotate an EBICS channel (a contract number, the relationship manager as a
  // contact_ref), and saved views group the order log (spec §6b); the payload/keys/state stay fixed.
  'ebics_connection',
  'ebics_order',
  // A37: custom fields annotate a managed (bLink) channel (the cost center paying the tier, the bank
  // relationship contact as a contact_ref), and saved views group the managed order log (spec §6b);
  // the consent reference, scopes and state stay fixed (the EBICS twins one rail over).
  'managed_connection',
  'managed_order',
  // H00, added with its row in `entities.ts` by the same drift-guarded route: a fixed-asset category
  // carries annotation fields (an "Anlageklasse" tag, an internal owner note) and saved views over
  // the category list, never the depreciation trio, the residual bounds or the three GL accounts,
  // which stay single-sourced on the row.
  'asset_category',
  // H01, added with its row in `entities.ts` by the same drift-guarded route: a fixed asset carries
  // annotation fields (an insurance-policy number, a location detail) and saved views over the
  // register, never the financial baseline (cost, the depreciation trio, the three GL accounts) or
  // the status machine, which stay single-sourced on the row.
  'asset',
  // I00, added with its row in `entities.ts` by the same drift-guarded route: a requisition carries
  // annotation fields (a "Beschaffungsgrund" note, a budget-line tag) and saved views over the
  // Anforderungen list, never the status machine, urgency, the estimated totals or the converted
  // quantity, which stay single-sourced on the row.
  'requisition',
  // J00, added with its row in `entities.ts` by the same drift-guarded route: a warehouse carries
  // annotation fields (a "Region" tag, a site-manager reference) and saved views over the warehouse
  // list, never the code, default flag or address. Locations ride the `stock_location` kind above.
  'warehouse',
  // J01, added with their rows in `entities.ts` by the same drift-guarded route: a lot (batch) and a
  // serial (unit) carry annotation fields and saved views over the Lots / Serials lists, never the
  // number, status, expiry or the derived on-hand.
  'lot',
  'serial',
  // H05, added with its row in `entities.ts` by the same drift-guarded route: a fixed-asset location
  // carries annotation fields (a "Gebäude" tag, a zone hint) and saved views over the Locations list,
  // never the code, active flag or parent link. The transfer history rides the `asset` kind above.
  'asset_location',
  // I02, added with its row in `entities.ts` by the same drift-guarded route: a goods receipt carries
  // annotation fields (a carrier, a delivery-note number, a pallet count) and saved views over the
  // Wareneingänge list, never the status machine, the received quantity, the inspection state or the
  // movement link, which are the receipt's real columns and the reason it is a money-path document.
  'goods_receipt',
  // G20, added with its rows in `entities.ts` by the same drift-guarded route: an implementation
  // project, a task and a sign-off carry annotation fields (an internal mandate number, an external
  // PM reference) and saved views over the tasks/roster, never the phase, task status, sign-off kind
  // or the append-only rows themselves.
  'implementation_project',
  'implementation_task',
  'implementation_signoff',
] as const;

/** The nine types, single-sourced in `core/customization/fields.ts` and mirrored for the picker. */
const FIELD_TYPES = [
  'text',
  'number',
  'money',
  'date',
  'bool',
  'select',
  'multiselect',
  'contact_ref',
  'entity_ref',
] as const;

type Tab = 'fields' | 'views';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  | { kind: 'ok'; defs: readonly FieldDefDto[]; views: readonly SavedViewDto[] };

interface Feedback {
  tone: 'success' | 'error';
  text: string;
}

interface DraftField {
  entityKind: string;
  key: string;
  labelDe: string;
  labelEn: string;
  type: string;
  options: string;
}

const EMPTY_DRAFT: DraftField = {
  entityKind: 'contact',
  key: '',
  labelDe: '',
  labelEn: '',
  type: 'text',
  options: '',
};

export function Customization() {
  const t = useT();
  const { locale } = useI18n();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const caps = useCapabilities();
  const keyInputId = useId();
  const kindSelectId = useId();
  const typeSelectId = useId();
  const titleId = useId();

  const [tab, setTab] = useState<Tab>('fields');
  const [entityKind, setEntityKind] = useState<string>('contact');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<DraftField | null>(null);
  const [previewValue, setPreviewValue] = useState<unknown>(null);
  const [selectedView, setSelectedView] = useState<string | null>(null);

  const canManageFields = caps.can(CAP.manageCustomFields);
  const canManageViews = caps.can(CAP.manageSavedViews);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setState({ kind: 'loading' });
    const [defsResponse, viewsResponse] = await Promise.all([
      // Drafts and archived defs are asked for EXPLICITLY: this is the one screen where a field an
      // agent staged, and a field somebody retired, both have to be visible to be acted on.
      client.call('list_field_defs', { workspaceId, entityKind, includeArchived: true, includeDrafts: true }),
      client.call('list_saved_views', { workspaceId, entityKind }),
    ]);
    if (isErr(defsResponse.body)) return setState({ kind: 'error', error: defsResponse.body });
    if (isErr(viewsResponse.body)) return setState({ kind: 'error', error: viewsResponse.body });
    const defsBody = defsResponse.body as unknown as { fieldDefs: readonly FieldDefDto[] };
    const viewsBody = viewsResponse.body as unknown as { savedViews: readonly SavedViewDto[] };
    setState({ kind: 'ok', defs: defsBody.fieldDefs, views: viewsBody.savedViews });
  }, [client, workspaceId, entityKind]);

  useEffect(() => {
    void load();
  }, [load]);

  const liveDefs = useMemo(
    () => (state.kind === 'ok' ? state.defs.filter((d) => !d.archived && !d.draft) : []),
    [state],
  );
  const draftDefs = useMemo(() => (state.kind === 'ok' ? state.defs.filter((d) => d.draft) : []), [state]);
  const archivedDefs = useMemo(
    () => (state.kind === 'ok' ? state.defs.filter((d) => d.archived) : []),
    [state],
  );
  // Read the saved views safely for the always-mounted panel: the Tabs primitive keeps both panels
  // in the tree (the inactive one `hidden`), so the views panel is built even while a field read is
  // still in flight. It falls back to an empty list until the load resolves.
  const views: readonly SavedViewDto[] = state.kind === 'ok' ? state.views : [];

  async function submitDraft() {
    if (draft === null) return;
    setBusy(true);
    setFeedback(null);
    const options = draft.options
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
    const response = await client.call('define_field', {
      workspaceId,
      entityKind: draft.entityKind,
      key: draft.key,
      labelI18n: { 'de-CH': draft.labelDe, en: draft.labelEn },
      type: draft.type,
      ...(options.length > 0 ? { options } : {}),
      idempotencyKey: newIdempotencyKey(),
    });
    setBusy(false);
    if (isErr(response.body)) {
      // The engine's own code, rendered inline on the panel that owns the input, never a toast and
      // never a stack trace. An unmapped code falls back to its own text rather than to silence.
      setFeedback({ tone: 'error', text: t(`customization.error.${response.body.error}`) });
      return;
    }
    setDraft(null);
    setFeedback({ tone: 'success', text: t('customization.fields.saved') });
    await load();
  }

  async function runFieldAction(action: 'confirm_field' | 'archive_field', fieldDefId: string) {
    setBusy(true);
    setFeedback(null);
    const response = await client.call(action, { workspaceId, fieldDefId, idempotencyKey: newIdempotencyKey() });
    setBusy(false);
    if (isErr(response.body)) {
      setFeedback({ tone: 'error', text: t(`customization.error.${response.body.error}`) });
      return;
    }
    const referenced = (response.body as unknown as { referencingViews?: number }).referencingViews ?? 0;
    setFeedback({
      tone: 'success',
      text:
        action === 'confirm_field'
          ? t('customization.fields.confirmed')
          : referenced > 0
            ? t('customization.warn.referenced', { n: String(referenced) })
            : t('customization.fields.archived'),
    });
    await load();
  }

  async function deleteView(viewId: string) {
    setBusy(true);
    setFeedback(null);
    const response = await client.call('delete_saved_view', {
      workspaceId,
      viewId,
      idempotencyKey: newIdempotencyKey(),
    });
    setBusy(false);
    if (isErr(response.body)) {
      setFeedback({ tone: 'error', text: t(`customization.error.${response.body.error}`) });
      return;
    }
    setFeedback({ tone: 'success', text: t('customization.views.deleted') });
    await load();
  }

  if (workspaceId === null) {
    return <NoWorkspaceState body={t('customization.noWorkspaceHint')} />;
  }

  // Loading and error take the whole panel area (the DataTable convention): a title over a skeleton
  // would lie about what is on screen. Rendered inside BOTH panels so the tab strip stays put while a
  // read is in flight; the inactive panel is `hidden`, so its copy is out of the accessibility tree.
  const panelBody = (content: ReactNode): ReactNode => {
    if (state.kind === 'loading') {
      // Row skeletons in the final list shape, never a bare spinner: the page does not jump when the
      // answer arrives. Three separate blocks, so the load is announced as more than one placeholder.
      return (
        <div className="customization__skeletons">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      );
    }
    if (state.kind === 'error') {
      return <ErrorBanner error={state.error} onRetry={() => void load()} />;
    }
    return content;
  };

  // The live field list as a Studio DataTable: label, key, type, and a right-hand action column that
  // is hidden by name only (a screen reader still gets "Aktionen"). One accent-free secondary control
  // per row, gated by the field capability (hide, never show-then-reject).
  const fieldColumns: DataTableColumn<FieldDefDto>[] = [
    {
      key: 'label',
      header: t('customization.fields.colLabel'),
      render: (def) => <span className="customization__field-label">{labelFor(def, locale)}</span>,
    },
    { key: 'key', header: t('customization.fields.key'), render: (def) => <code>{def.key}</code> },
    {
      key: 'type',
      header: t('customization.fields.typeLabel'),
      render: (def) => t(`customization.fields.type.${def.type}`),
    },
    {
      key: 'actions',
      header: t('customization.actionsColumn'),
      headerHidden: true,
      align: 'end',
      render: (def) =>
        canManageFields ? (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={busy}
            aria-label={`${t('customization.fields.archive')}: ${labelFor(def, locale)}`}
            onClick={() => void runFieldAction('archive_field', def.fieldDefId)}
          >
            {t('customization.fields.archive')}
          </button>
        ) : null,
    },
  ];

  const viewColumns: DataTableColumn<SavedViewDto>[] = [
    { key: 'name', header: t('customization.views.colName'), render: (view) => view.name },
    {
      key: 'scope',
      header: t('customization.views.colScope'),
      render: (view) =>
        view.shared ? t('customization.views.shared') : t('customization.views.personal'),
    },
    {
      key: 'actions',
      header: t('customization.actionsColumn'),
      headerHidden: true,
      align: 'end',
      // A shared view needs the capability; a personal one is the caller's own, so the control is
      // offered for it either way and the engine still has the final say.
      render: (view) =>
        !view.shared || canManageViews ? (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={busy}
            aria-label={`${t('customization.views.delete')}: ${view.name}`}
            onClick={() => void deleteView(view.viewId)}
          >
            {t('customization.views.delete')}
          </button>
        ) : null,
    },
  ];

  const fieldsPanel = (
    <div className="customization__panel">
      {panelBody(
        <>
          {canManageFields ? (
            draft === null ? (
              <button type="button" className="btn btn--accent" onClick={() => setDraft({ ...EMPTY_DRAFT, entityKind })}>
                {t('customization.fields.create')}
              </button>
            ) : (
              <form
                className="customization__form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitDraft();
                }}
              >
                <label htmlFor={keyInputId}>
                  <span>{t('customization.fields.key')}</span>
                  <input
                    className="field"
                    id={keyInputId}
                    value={draft.key}
                    onChange={(e) => setDraft({ ...draft, key: e.currentTarget.value })}
                    required
                  />
                </label>
                <label>
                  <span>{t('customization.fields.labelDe')}</span>
                  <input
                    className="field"
                    value={draft.labelDe}
                    onChange={(e) => setDraft({ ...draft, labelDe: e.currentTarget.value })}
                    required
                  />
                </label>
                <label>
                  <span>{t('customization.fields.labelEn')}</span>
                  <input
                    className="field"
                    value={draft.labelEn}
                    onChange={(e) => setDraft({ ...draft, labelEn: e.currentTarget.value })}
                    required
                  />
                </label>
                <label htmlFor={typeSelectId}>
                  <span>{t('customization.fields.typeLabel')}</span>
                  <select
                    className="field"
                    id={typeSelectId}
                    value={draft.type}
                    onChange={(e) => setDraft({ ...draft, type: e.currentTarget.value })}
                  >
                    {FIELD_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(`customization.fields.type.${type}`)}
                      </option>
                    ))}
                  </select>
                </label>
                {draft.type === 'select' || draft.type === 'multiselect' ? (
                  <label>
                    <span>{t('customization.fields.options')}</span>
                    <input
                      className="field"
                      value={draft.options}
                      onChange={(e) => setDraft({ ...draft, options: e.currentTarget.value })}
                      required
                    />
                  </label>
                ) : null}
                <div className="customization__form-actions">
                  <button type="submit" className="btn btn--accent" disabled={busy}>
                    {t('customization.fields.save')}
                  </button>
                  <button type="button" className="btn btn--secondary" onClick={() => setDraft(null)} disabled={busy}>
                    {t('customization.cancel')}
                  </button>
                </div>
              </form>
            )
          ) : null}

          {draftDefs.length > 0 ? (
            <div className="customization__drafts">
              {draftDefs.map((def) => (
                <p key={def.fieldDefId} className="customization__draft-banner">
                  {/* Glyph AND text: the state is never carried by colour alone. */}
                  <span aria-hidden="true">◷</span> {labelFor(def, locale)}{' '}
                  {t('customization.fields.draft_banner')}
                  {/*
                    A CONFIRMATION WITH NO REFUSAL IS NOT A DECISION. This banner is the human half of
                    P8: an agent changed the schema and a person is being asked to approve it. Offering
                    only "Freigeben" makes the only reachable answer yes, and the only way to say no
                    was to release the field and then archive it, which is two writes and a moment
                    where the unwanted field is live on every screen.

                    "Verwerfen" is `archive_field`, which is the same verb the live list uses and is
                    non-destructive by design: the def survives, flagged, and any values already
                    captured against it are kept. There is no separate delete, and inventing one for
                    this button would put a destructive path on the screen for the first time.
                  */}
                  {canManageFields ? (
                    <span className="customization__draft-actions">
                      <button
                        type="button"
                        className="btn btn--accent btn--sm"
                        disabled={busy}
                        onClick={() => void runFieldAction('confirm_field', def.fieldDefId)}
                      >
                        {t('customization.fields.confirm')}
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={busy}
                        aria-label={`${t('customization.fields.discard')}: ${labelFor(def, locale)}`}
                        onClick={() => void runFieldAction('archive_field', def.fieldDefId)}
                      >
                        {t('customization.fields.discard')}
                      </button>
                    </span>
                  ) : null}
                </p>
              ))}
            </div>
          ) : null}

          {liveDefs.length === 0 && draftDefs.length === 0 ? (
            <EmptyState
              title={t('customization.fields.empty', { entity: t(`customization.entity.${entityKind}`) })}
            />
          ) : liveDefs.length > 0 ? (
            <DataTable
              caption={t('customization.fields.title')}
              columns={fieldColumns}
              rows={liveDefs as FieldDefDto[]}
              rowKey={(def) => def.fieldDefId}
            />
          ) : null}

          {archivedDefs.length > 0 ? (
            <details className="customization__archived">
              <summary>{t('customization.fields.archivedTitle', { n: String(archivedDefs.length) })}</summary>
              <p className="customization__hint">{t('customization.fields.archivedHint')}</p>
              <ul>
                {archivedDefs.map((def) => (
                  <li key={def.fieldDefId}>
                    {labelFor(def, locale)} <code>{def.key}</code>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {/* The shared component, consumed on the screen that ships it. This is a live preview of
              exactly what a host surface renders per def, which is how G00 proves the component works
              embedded rather than only asserting that it will. */}
          {liveDefs.length > 0 ? (
            <div className="customization__preview">
              <h2>{t('customization.fields.preview')}</h2>
              {liveDefs.map((def) => (
                <CustomFieldRow
                  key={def.fieldDefId}
                  def={def}
                  value={previewValue}
                  locale={locale}
                  disabled
                  onChange={setPreviewValue}
                />
              ))}
            </div>
          ) : null}
        </>,
      )}
    </div>
  );

  const viewsPanel = (
    <div className="customization__panel">
      {panelBody(
        <>
          <SavedViewPicker
            views={views}
            selected={selectedView}
            label={t('customization.views.title')}
            defaultOptionLabel={t('customization.views.standard')}
            personalGroupLabel={t('customization.views.personal')}
            sharedGroupLabel={t('customization.views.shared')}
            onSelect={setSelectedView}
          />
          <DataTable
            caption={t('customization.views.title')}
            columns={viewColumns}
            rows={views as SavedViewDto[]}
            rowKey={(view) => view.viewId}
            emptyState={<EmptyState title={t('customization.views.empty')} />}
          />
        </>,
      )}
    </div>
  );

  return (
    <section className="customization" aria-labelledby={titleId}>
      <SurfaceHeader
        title={t('customization.tab.title')}
        titleId={titleId}
        subtitle={t('customization.lede')}
        help={<SurfaceHelp surface="Customization" />}
      />

      <label className="customization__kind" htmlFor={kindSelectId}>
        <span>{t('customization.entityKind')}</span>
        <select
          className="field"
          id={kindSelectId}
          value={entityKind}
          onChange={(e) => {
            setEntityKind(e.currentTarget.value);
            setSelectedView(null);
          }}
        >
          {ENTITY_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`customization.entity.${kind}`)}
            </option>
          ))}
        </select>
      </label>

      {/*
        A FAILURE IS ANNOUNCED ASSERTIVELY, a success politely. One element carried `role="status"`
        for both, and a polite live region is queued behind whatever is already being spoken, so a
        refusal could arrive long after the person moved on. The Zugriff surface already splits it.
      */}
      {feedback !== null ? (
        <p
          className={`customization__feedback customization__feedback--${feedback.tone}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}

      <Tabs
        label={t('customization.tab.title')}
        activeId={tab}
        onChange={(id) => setTab(id as Tab)}
        tabs={[
          { id: 'fields', label: t('customization.fields.title'), panel: fieldsPanel },
          { id: 'views', label: t('customization.views.title'), panel: viewsPanel },
        ]}
      />
    </section>
  );
}

export default Customization;
