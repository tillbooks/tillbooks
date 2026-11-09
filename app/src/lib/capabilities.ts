/**
 * The Studio's ONE permission source: `whoami`, and nothing else.
 *
 * WHY THIS FILE EXISTS AT ALL, which is the same reason it must stay the only one. Three gates in
 * this Studio used to read a permission field off whatever list happened to be on screen:
 * `Journal.tsx` read `body.canPost` off `list_journal`, `Periods.tsx` read `body.canManage` and
 * `body.canUnlock` off `list_period_locks`. No engine payload has ever carried any of the three, so
 * every expression evaluated `undefined !== false` and all three gates stood open in every build
 * that ever shipped. Declaring those two payloads turned the reads into TS2339, which is how they
 * were found, and each was replaced with an honest constant carrying a comment deferring the real
 * source to A24.
 *
 * This is that source. The lesson was not "declare the payload": that is how the defect was caught,
 * not why it happened. It happened because a permission answer was bolted onto a list read. So the
 * rule is narrower than a type: `whoami` is the only verb in this repo that answers a permission
 * question, and this hook is the only thing that calls it. No surface reads a capability from
 * anywhere else.
 *
 * FAIL-OPEN IN THE STUDIO IS CORRECT, and it is worth being explicit because it looks wrong. If
 * `whoami` has not answered yet, or answered with an error, `can()` returns true and every control
 * renders enabled. The Studio is a CONVENIENCE gate: its job is to tell an operator BEFORE they
 * click that a click will be refused. The real gate is the engine, at `ctxAction` in
 * `src/api/registry.ts`, and it does not consult this file. Failing closed here would grey out a
 * working ledger over a transient read failure while changing nothing about what the engine allows;
 * failing open shows a control that then returns a specific `permission_denied` the surface renders.
 * The expensive mistake is the opposite one: believing this hook IS the enforcement.
 */
import { createContext, useContext } from 'react';

// The ENGINE's own kind-to-capability lookup, imported at runtime rather than mirrored. The module is
// pure (its only import is a type), so this is the `Documents/currency.ts` pattern: the rule on
// screen and the rule at the gate are ONE implementation, and the two cannot disagree. The closure
// guard in `test/style/studio-sees-payloads.test.mjs` holds this import browser-safe.
import { editCapabilityForKind as engineEditCapabilityForKind } from '../../../src/core/customization/entities.js';

/** The `whoami` answer, exactly as the engine sends it. Nothing here is derived in the browser. */
export interface Whoami {
  actor: string;
  /** False when no one has claimed this workspace yet: everything is open and the first invite seats an owner. */
  provisioned: boolean;
  isMember: boolean;
  memberId: string | null;
  userId: string | null;
  /** A built-in role id or a custom `role_def` id, or null when the actor is not a member. */
  role: string | null;
  capabilities: readonly string[];
  /**
   * M01: HOW this session's identity was established. `local_client` on a laptop (the header, if any,
   * was ignored); `served_subject` behind an authenticating reverse proxy. The chrome shows the
   * signed-in subject only in served mode: a local user has no login and must not be shown a fake one.
   *
   * OPTIONAL on this reader type, though the engine always sends it: a test double or an older payload
   * that omits it must read as `local_client` (a laptop), which is the safe default. Render it as
   * `whoami.identitySource ?? 'local_client'`.
   */
  identitySource?: 'local_client' | 'served_subject';
  /** M01: the proxy-attested subject in served mode, or null locally. The chip names it; never parsed. */
  subject?: string | null;
}

export interface Capabilities {
  /** The answer, or null while it is loading or after it failed. */
  whoami: Whoami | null;
  /** Does the actor hold `capability`? True while unknown: see the fail-open note above. */
  can: (capability: string) => boolean;
  /** Re-read after a role change, so a promotion takes effect without a reload. */
  refresh: () => void;
}

/**
 * The permissive default, which is also what a tree with no provider gets.
 *
 * Every component test that renders a surface in isolation lands here, and lands on exactly the
 * behaviour those surfaces had before A24: nothing disabled. That is what makes wiring the three
 * phantom gates to this hook a change with no test churn and no behaviour change on the default
 * path, which is the only shape in which it could land at all.
 */
export const ALLOW_ALL: Capabilities = {
  whoami: null,
  can: () => true,
  refresh: () => undefined,
};

export const CapabilitiesContext = createContext<Capabilities>(ALLOW_ALL);

export function useCapabilities(): Capabilities {
  return useContext(CapabilitiesContext);
}

/** The common case: one capability, one boolean. */
export function useCan(capability: string): boolean {
  return useContext(CapabilitiesContext).can(capability);
}

/** The capability ids the Studio gates on, so a typo is a compile error rather than a silent true. */
export const CAP = {
  readMasterData: 'read_master_data',
  post: 'post',
  pay: 'pay',
  issue: 'issue',
  send: 'send',
  // A15's capability: proposing and issuing a Mahnlauf. Sending additionally requires `send`,
  // mirroring the engine's ALL-OF on `send_dunning_run`.
  dun: 'dun',
  managePeriods: 'manage_periods',
  unlockPeriod: 'unlock_period',
  vatFile: 'vat_file',
  manageVatConfig: 'manage_vat_config',
  manageChart: 'manage_chart',
  manageMasterData: 'manage_master_data',
  // C00's elevated right (F5 retrofit): merge and anonymise require this AND `manageMasterData`,
  // mirroring the engine's ALL-OF declaration.
  contactsMerge: 'contacts.merge',
  // I04 three-way match: recording a match (create) needs `purchasingMatch`; overriding an
  // out-of-tolerance match and reversing a permanent one need `purchasingMatchOverride`. The Studio
  // pre-disables the Confirm / Override controls behind these; the engine gate decides.
  purchasingMatch: 'purchasing.match',
  purchasingMatchOverride: 'purchasing.match_override',
  // E00's pair (F7 / F8). Two names because they are two acts: `manageFiles` is the right to CONTRIBUTE
  // evidence and `readFileContent` the right to open it, and a read-only invite holds neither.
  manageFiles: 'manage_files',
  readFileContent: 'read_file_content',
  manageSettings: 'manage_settings',
  manageMembers: 'manage_members',
  manageCustomFields: 'manage_custom_fields',
  manageSavedViews: 'manage_saved_views',
  manageAutomations: 'manage_automations',
  // G02, the plugin lifecycle. Gates install/enable/disable/uninstall/compat-refresh: installing
  // third-party code that reaches the ledger through the agent transport is owner-only by default, so
  // the Erweiterungen write controls disable behind this while the list stays browsable read-only.
  managePlugins: 'manage_plugins',
  // G10/G09, the migration family. `manageImport` gates the whole harness (discovery through
  // trial-load and every read); `commitMigration` is the stronger, distinct right the engine checks
  // on a money-path commit and, after any commit, on rollback and abandon.
  manageImport: 'manage_import',
  commitMigration: 'commit_migration',
  // G20, implementation projects. Gates the project/task/decision/parallel-run writes and all project
  // reads beyond the roster metadata row; sign-offs ride `commitMigration` (signing is the human half
  // of committing). Owner-only by default: the Migration surface leads with the project when one is
  // open, and the sign-off controls are DISABLED (not hidden) with "Braucht commit_migration" for an
  // actor without it, while the engine gate decides.
  manageImplementation: 'manage_implementation',
  // G22 (D127), checklists. Gates the five `checklist_*` writes (start, complete, skip, reopen,
  // abandon); held by bookkeeper, treuhaender and agent by default. The Studio hides the start
  // button and disables the row actions without it, naming the right; the engine gate decides.
  manageChecklists: 'manage_checklists',
  // G12's owner-only promotion right: going productive with a Testmandant. Required TOGETHER with
  // `commitMigration`; the Studio disables the control when either is missing and names the one it
  // lacks, but the engine gate (plus the engine-side type-to-confirm) is what decides.
  promoteWorkspace: 'promote_workspace',
  // G13's owner-only purge right: destroying archived history after OR 958f expires. The Studio
  // gate is a courtesy that hides nothing (the periods stay visible); the engine gate decides.
  purgeArchive: 'purge_archive',
  // E03's pair. Two names because they are two acts, the E00 shape: `tasksRead` gates the queue and
  // the reminder poll (the padlock state on `/tasks`), `tasksWrite` the five lifecycle writes. The
  // assignee-completion allowance is the ENGINE's (asserted in `completeTask`), so the Studio only
  // ever pre-disables the ✓ for an actor holding neither leg.
  tasksRead: 'tasks.read',
  tasksWrite: 'tasks.write',
  // B01's trio. `timeRead` gates the timesheet (the padlock state on `/time`), `timeWrite` the
  // entry lifecycle, and `timeApprove` the Freigeben/Sperren pair, which the surface HIDES rather
  // than disables for a holder-less actor (spec §6: never shown-then-rejected). Rate cards ride
  // `manageMasterData`, the engine's own gate.
  timeRead: 'time.read',
  timeWrite: 'time.write',
  timeApprove: 'time.approve',
  // C01's pair, the E03 shape one register over: `dealsRead` gates the board (the padlock state on
  // `/deals`), `dealsWrite` the eight pipeline writes. The delegated halves (quote, reminder task)
  // are re-gated by the ENGINE through the dispatch, so the Studio only ever pre-disables.
  dealsRead: 'deals.read',
  dealsWrite: 'deals.write',
  // B02's pair, the time trio one register over: `billingRead` gates the Unverrechnet panel and the
  // WIP card on `/time`, `billingGenerate` the Rechnungsentwurf-erstellen CTA (hidden without it,
  // spec §6: never shown-then-rejected). The engine is the real gate; the Studio only pre-hides.
  billingRead: 'billing.read',
  billingGenerate: 'billing.generate',
  // B04: `retainerManage` gates the Mandate tab's create/generate/close/run-due controls on `/time`
  // (hidden without it, spec §6: never shown-then-rejected). The Mandate reads ride `billingRead`, the
  // shared billing read domain. The engine is the real gate; the Studio only pre-hides.
  retainerManage: 'retainer.manage',
  // B03's read, the `billingRead` shape one register over: `costingRead` gates the Projekterfolg
  // panel and the Marge column on the projects list (hidden without it, spec §6: never
  // shown-then-rejected). The engine's `costing.read` gate is the one that decides.
  costingRead: 'costing.read',
  // E01's pair, the A11 issue/send split: `signWrite` gates the Signatur section's lifecycle
  // controls (the request CTA is hidden without it, spec §6: never shown-then-rejected), and
  // `signSend` gates Senden specifically, which renders DISABLED with the Berechtigung-fehlt hint
  // rather than hidden (US-E01.2: a Treuhänder who prepares must see that sending exists and what
  // it needs). The engine's ALL-OF on `sign_requests_send` is the gate that decides.
  signWrite: 'sign.write',
  signSend: 'sign.send',
  // F02: `portalManage` gates the Portal-Zugang panel's create/send/revoke controls on the contact
  // detail (hidden without it, spec §6: never shown-then-rejected). The list read rides
  // `read_master_data` (the panel lives on the contact detail); the engine's `portal.manage` gate is
  // the one that decides.
  portalManage: 'portal.manage',
  // F01's trio: `reportsRead` gates the Berichte surface's saved-report list, source picker and run
  // history; `reportsWrite` gates the create/edit/duplicate/delete/schedule controls (hidden without
  // it, spec §6: never shown-then-rejected); `reportsRun` gates Ausführen/Herunterladen (disabled with
  // the Berechtigung-fehlt hint without it). The engine's own gates are the ones that decide.
  reportsRead: 'reports.read',
  reportsWrite: 'reports.write',
  reportsRun: 'reports.run',
  // E04's pair, the E03 shape at the product's strictest register: `mailRead` gates the
  // Korrespondenz queue and thread reads (the padlock state on `/correspondence`), `mailWrite`
  // the connect affordance, the draft write-back and the per-thread label. Held by `agent` only
  // among the built-ins (Art. 321 correspondence is not the bookkeeping mandate); the engine is
  // the real gate, as always.
  mailRead: 'mail.read',
  mailWrite: 'mail.write',
  // E05's pair, the E04 shape at the same register: `voiceRead` gates the Schreibstil panel's
  // reads (the padlock state on `/writing-style`); `voiceWrite` the learn/rebuild action and the
  // model picker's confirm (without it the picker renders read-only rather than disappearing, so a
  // read-only user still sees what is selected, spec §6). The engine is the real gate, as always.
  voiceRead: 'voice.read',
  voiceWrite: 'voice.write',
  // E06's write: `draftWrite` gates Entwurf erstellen / Neu erstellen on the Korrespondenz draft
  // pane (hidden without it, spec §6: never shown-then-rejected). Reading the runs rides
  // `mailRead`, the pane's own read domain. The engine is the real gate, as always.
  draftWrite: 'draft.write',
  // A16's read domain (D50), mirrored for E06's facts block: the grounding statement and the
  // verification figures never render for a viewer without it (US-E06.2: someone who may not see
  // the books may not read them off a draft pane). The engine additionally refuses grounding
  // in-verb for such an actor.
  readSales: 'read_sales',
  // G05's write gate: the template lifecycle (Neu / Speichern / Als Standard festlegen /
  // Archivieren) on `/document-templates`. Without it the controls render pre-disabled with the
  // requires-admin tooltip (never shown-then-rejected); reads ride `readMasterData`, so the list
  // and the preview stay open to every member. The engine is the real gate, as always.
  manageDocumentTemplates: 'manage_document_templates',
  // G05 §10's write gate: the Textbausteine editor's Speichern on `/dispatch`. Without it the
  // control renders pre-disabled with the requires-admin note; the Protokoll and the preview ride
  // `readMasterData`, so both tabs stay readable to every member. The engine is the real gate.
  manageDispatchTexts: 'manage_dispatch_texts',
  // E07's read domain: `egressRead` gates the Vertrauen panel and the trust indicator (the padlock
  // state on the Setup Vertrauen block and, once G15 places it, the shell-rail signal). Held by every
  // member incl. viewer (the engine puts it in READ_CAPABILITIES): a trust indicator must be visible
  // to everyone who can see anything, and it discloses no tenant data. The engine is the real gate.
  egressRead: 'egress.read',
  // I03's write gate: the Landed Costs surface's create / confirm / reverse controls. Without it the
  // controls render pre-disabled (spec §6: never shown-then-rejected); the list and preview ride
  // `readMasterData`, so every member can browse. The engine's `procurement.landed_cost` gate decides.
  procurementLandedCost: 'procurement.landed_cost',
  // A25's pair, the Treuhänder review/export. `review` gates the Prüfung surface's comment / flag /
  // approve controls (the padlock state on `/review`); `export` gates the three filing exports on
  // `/export` (the padlock state there). Both are held by `treuhaender`/`owner` by default. The
  // engine's own `review` / `export` gates are the ones that decide; the Studio only pre-hides. The
  // Periode-sperren button additionally rides `managePeriods` (A03), disabled with its reason named.
  review: 'review',
  export: 'export',
  // D126, the environment landscape. `landscapeRead` gates the Umgebungen surface (its padlock state)
  // and the shell environment indicator; `landscapeManage` gates every write (create / copy / reset /
  // switch / delete), which the surface pre-disables with the missing-right hint. main additionally
  // shows a padlock and NO destructive controls regardless of the right, because its protection is a
  // property of the environment's guard tier, not of the actor. The engine's `env_*` gates decide.
  landscapeRead: 'landscape.read',
  landscapeManage: 'landscape.manage',
} as const;

/**
 * The registered OP3 entity kinds, as a literal union so a caller's typo is a compile error rather
 * than a silent padlock (`can()` on a name nobody holds fails closed).
 *
 * This IS a second spelling of the engine's kind list, and it is accepted for exactly one reason:
 * TypeScript needs the literals at compile time and the engine registry types its ids as `string`.
 * It cannot drift silently: the Files component tests assert this list equals the engine's
 * `ENTITY_KIND_IDS` exactly, so a kind registered next year fails a test until it is added here.
 * The CAPABILITY half is not mirrored at all: `editCapabilityForKind` below is the engine's own
 * function.
 */
export const ENTITY_KINDS = [
  'contact',
  'item',
  'bank_account',
  'account',
  'cost_center',
  'document',
  'payment',
  'journal_entry',
  'automation_rule',
  // A17, with its row in the engine's `entities.ts` (editCapability 'post'). The Files drift test
  // holds this union equal to the engine registry, which is how the kind arrived here.
  'vendor_bill',
  // A15, with its row in the engine's `entities.ts` (editCapability 'dun'), by the same route.
  'dunning_run',
  // A12, with its row in the engine's `entities.ts` (editCapability 'issue'), by the same route.
  'recurring_schedule',
  // A21, with its row in the engine's `entities.ts` (editCapability 'pay'), by the same route.
  'reconciliation_match',
  // A20, with its row in the engine's `entities.ts` (editCapability 'pay'), by the same route.
  'bank_txn',
  // A18, with its row in the engine's `entities.ts` (editCapability 'pay'), by the same route.
  'payment_batch',
  // A23, with its row in the engine's `entities.ts` (editCapability 'manage_settings', the
  // self-tenant kind: linking or annotating targets only ever the current mandate itself).
  'workspace',
  // A25, with its row in the engine's `entities.ts` (editCapability 'review'): custom fields on a
  // review event, by the same route the Files drift test holds equal to the engine registry.
  'entry_review',
  // G10, with its row in the engine's `entities.ts` (editCapability 'manage_import'): custom fields
  // on a Zuordnungsvorlage (a "Mandant" note, a "Quellsystem-Version" select), by the same route.
  'migration_map_template',
  // G09, the migration harness's plan and step (editCapability 'manage_import'): a Treuhänder can
  // hang a "Verantwortlich" or "Quellsystem" field on either, by the same route the Files drift test
  // holds equal to the engine registry.
  'migration_plan',
  'migration_step',
  // G11, the persisted Eröffnungsprüfung (editCapability 'manage_import'): a linked working paper
  // or a "Von Treuhänder geprüft" field on the check a Treuhänder signs, by the same route.
  'migration_check',
  // G19, the export manifest (editCapability 'manage_import'): a "Wer exportiert" assignee or a
  // per-item note on the manifest, by the same route the Files drift test holds equal to the engine
  // registry.
  'migration_extraction_manifest',
  // G13, with its row in the engine's `entities.ts` (editCapability 'commit_migration'): a custom
  // field ANNOTATES an archived entry (a Treuhänder's Prüfvermerk), it never alters the archived
  // values, which sit behind BEFORE-triggers. By the same route the Files drift test holds equal.
  'gl_archive_entry',
  // B00, with its rows in the engine's `entities.ts` (editCapability 'manage_master_data'): a
  // "Projekttyp" select on a project or a "Verantwortlich" contact_ref on a phase, by the same
  // route the Files drift test holds equal to the engine registry.
  'project',
  'project_phase',
  // E03, with its row in the engine's `entities.ts` (editCapability 'tasks.write'): a `priority`
  // select or a workspace category on a task, by the same route the drift test holds equal.
  'task',
  // B01, with its row in the engine's `entities.ts` (editCapability 'time.write'): a "Work type"
  // select or an internal cost-center override on a time entry, by the same route the Files drift
  // test holds equal to the engine registry.
  'time_entry',
  // C01, with its row in the engine's `entities.ts` (editCapability 'deals.write'): an
  // "Umsatzquelle" select or a "Partner" contact_ref on a deal, by the same route the Files drift
  // test holds equal to the engine registry.
  'deal',
  // D01, with its rows in the engine's `entities.ts` (editCapability 'manage_master_data'): a
  // zone/aisle field on a stock location, a counted-by note on a stocktake, by the same route the
  // Files drift test holds equal to the engine registry.
  'stock_location',
  'stocktake',
  // C02, with its rows in the engine's `entities.ts` (editCapability 'issue'): a "Projekt-Referenz"
  // on a quote or a delivery-lead-time on a quote line, by the same route the Files drift test holds
  // this union equal to the engine registry.
  'quote',
  'quote_line',
  // D03, with its rows in the engine's `entities.ts` (editCapability 'issue'): an "Interne Projekt-
  // Referenz"/"Priorität" on a sales order and a "Frachtführer"/"Tracking-Nummer" on a delivery note,
  // by the same route the Files drift test holds this union equal to the engine registry.
  'sales_order',
  'delivery_note',
  // D02, with its row in the engine's `entities.ts` (editCapability 'manage_master_data'): a
  // requisition reference or "Projektbezug" tag on a purchase order, by the same route the drift test
  // holds this union equal to the engine registry.
  'po',

  // E02 HR-lite, with their rows in the engine's `entities.ts` (editCapability 'hr.manage' for
  // employee/absence, 'spesen.submit' for expense_claim): a cost-center note on an employee, a
  // "Genehmigungsnotiz" on a claim, saved views over the three Personal tabs, by the same route the
  // Files drift test holds this union equal to the engine registry.
  'employee',
  'absence',
  'expense_claim',
  // B04, with its row in the engine's `entities.ts` (editCapability 'retainer.manage'): an
  // account-manager tag or a "Vertragsreferenz" on a mandate, plus saved views over the Mandate tab,
  // by the same route the Files drift test holds this union equal to the engine registry.
  'retainer',
  // E01, with its row in the engine's `entities.ts` (editCapability 'sign.write'): an internal
  // reference or a contract-type tag on a sign request, plus saved views over the request list, by
  // the same route the Files drift test holds this union equal to the engine registry.
  'sign_request',
  // F02, with its row in the engine's `entities.ts` (editCapability 'portal.manage'): a "Grund der
  // Freigabe" note or an "angefragt von" reference on a portal grant, plus saved views over the
  // Portal-Zugang list, by the same route the Files drift test holds this union equal to the engine
  // registry.
  'portal_grant',
  // F03, with its row in the engine's `entities.ts` (editCapability 'portal.manage'): a custom field
  // ANNOTATES a remittance advice (never its frozen snapshot money columns), plus saved views over
  // the advice history, by the same route the Files drift test holds this union equal to the engine
  // registry.
  'remittance_advice',
  // F01, with its row in the engine's `entities.ts` (editCapability 'reports.run'): a "Mandant" note
  // or a "Freigabe erteilt" field on a retained report run, plus the E00 link for a retained artifact,
  // by the same route the Files drift test holds this union equal to the engine registry.
  'report_run',
  // E04, with its row in the engine's `entities.ts` (editCapability 'mail.write', and the one row
  // carrying a `fieldTypes` slice: select/multiselect/bool/date only, the zero-egress inversion): a
  // triage label on a thread, plus saved views over the Korrespondenz queue, by the same route the
  // Files drift test holds this union equal to the engine registry.
  'mail_thread',
  // G04, with its row in the engine's `entities.ts` (editCapability 'manage_data_export'): a "Reason"
  // select or a "Keep until" date ANNOTATES a backup-history row (never what the backup faithfully
  // copies), plus saved presets over the backup history, by the same route the Files drift test holds
  // this union equal to the engine registry.
  'backup',
  // G05, with its row in the engine's `entities.ts` (editCapability 'manage_document_templates'):
  // the LOGO rides the E00 link against this kind, plus an owner/approval note and saved views over
  // the Vorlagen list, by the same route the Files drift test holds this union equal to the engine
  // registry.
  'document_template',
  // G06, with its row in the engine's `entities.ts` (editCapability 'manage_automations'): saved
  // views over the /inbox queue and annotation fields on a delivered moment, by the same route the
  // Files drift test holds this union equal to the engine registry.
  'inbox_item',
  // G07, with its row in the engine's `entities.ts` (editCapability 'manage_settings'): the
  // attachment-only hook a saved global search hangs off, riding the workspace table's self-tenant
  // shape. Registered here so the union stays exactly the engine registry (the Files drift test).
  'global_search',
  // G02, with its row in the engine's `entities.ts` (editCapability 'manage_plugins'): saved views
  // and annotation fields over an installed extension, plus a linked support-ticket document, by the
  // same route the Files drift test holds this union equal to the engine registry.
  'plugin',
  // G05 §10, with its row in the engine's `entities.ts` (editCapability 'manage_dispatch_texts'):
  // saved views and annotation fields over a send-log row (a follow-up note on a disputed send),
  // never the logged send itself, by the same route the Files drift test holds this union equal to
  // the engine registry.
  'dispatch',
  // A31, with its row in the engine's `entities.ts` (editCapability 'manage_files'): custom fields
  // and saved views over the Belegeingang queue, by the same route the Files drift test holds this
  // union equal to the engine registry.
  'capture',
  // A34, with its row in the engine's `entities.ts` (editCapability 'hr.manage'): custom fields and
  // saved views over the payroll hand-off history, held equal to the engine registry by the Files
  // drift test.
  'payroll_handoff',
  // A32, with its row in the engine's `entities.ts` (editCapability 'issue'): custom fields and saved
  // views over an eBill delivery record, by the same route the Files drift test holds this union equal
  // to the engine registry.
  'ebill_delivery',
  // A33, with their rows in the engine's `entities.ts` (editCapability 'pay'): `ebics_connection`
  // (the channel; custom fields + E00 links) and `ebics_order` (the order-log read model; saved
  // views), held equal to the engine registry by the Files drift test.
  'ebics_connection',
  'ebics_order',
  // A37, with their rows in the engine's `entities.ts` (editCapability 'pay'): `managed_connection`
  // (the bLink channel; custom fields + E00 links) and `managed_order` (the order-log read model;
  // saved views), the EBICS twins one rail over, held equal to the engine registry by the Files drift test.
  'managed_connection',
  'managed_order',
  // H00, with its row in the engine's `entities.ts` (editCapability 'manage_master_data'): a
  // fixed-asset category carries custom fields and saved views, held equal to the engine registry by
  // the Files drift test.
  'asset_category',
  // H01, with its row in the engine's `entities.ts` (editCapability 'manage_master_data'): a fixed
  // asset carries custom fields and saved views over the register, held equal to the engine registry
  // by the Files drift test.
  'asset',
  // I00, with its row in the engine's `entities.ts` (editCapability 'manage_master_data'): the
  // internal-demand requisition carries custom fields and saved views over the Einkauf list, held
  // equal to the engine registry by the Files drift test.
  'requisition',
  // J00, with its row in the engine's `entities.ts` (editCapability 'manage_master_data'): a warehouse
  // carries custom fields and saved views, held equal to the engine registry by the Files drift test.
  // Locations ride the already-listed `stock_location` kind, which J00 extends, so no second kind.
  'warehouse',
  // J01, with their rows in the engine's `entities.ts` (editCapability 'manage_master_data'): a lot
  // (batch) and a serial (unit) carry custom fields and saved views over the Lots / Serials lists,
  // held equal to the engine registry by the Files drift test.
  'lot',
  'serial',
  // H05, with its row in the engine's `entities.ts` (editCapability 'manage_master_data'): a
  // fixed-asset location carries custom fields and saved views over the Locations list, held equal to
  // the engine registry by the Files drift test. The transfer history rides the `asset` kind, so no
  // second kind is added for transfers.
  'asset_location',
  // I02, with its row in the engine's `entities.ts` (editCapability 'manage_master_data'): a goods
  // receipt carries custom fields and saved views over the Wareneingänge list, held equal to the
  // engine registry by the Files drift test.
  'goods_receipt',
  // G20, with its rows in the engine's `entities.ts` (editCapability 'manage_implementation'): a
  // project, a task and a sign-off carry custom fields (an internal mandate number, an external PM
  // reference) and saved views over the tasks/roster, held equal to the engine registry by the Files
  // drift test.
  'implementation_project',
  'implementation_task',
  'implementation_signoff',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * The A24 capability that writing a target record ITSELF requires: `post` for a journal entry,
 * `pay` for a payment, `issue` for a document, `manage_master_data` for a contact. The one lookup
 * `files_link` and `set_field_value` gate on, answered by the engine's own map, so a surface that
 * needs "may this actor write data ABOUT this record" asks the same source the refusal would come
 * from.
 */
export function editCapabilityForKind(kind: EntityKind): string {
  return engineEditCapabilityForKind(kind);
}
