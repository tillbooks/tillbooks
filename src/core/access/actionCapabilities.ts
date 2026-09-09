/**
 * A24 §4, the action-to-capability map: the gate every agent-facing write passes.
 *
 * WHY THE MAP AND NOT SIXTY-TWO EDITS. The spec's §4 says `assertCapability` is "called at the top
 * of every write verb across the whole product". Written that way it would be sixty-two separate
 * edits across nine capability modules, sixty-two chances to forget one, and no mechanism at all
 * for noticing the sixty-third when it lands next week. Written as ONE map keyed by tool name, and
 * asserted at the registry boundary that both faces already funnel through, it is one edit, one
 * place to read the whole policy, and, because `assertEveryWriteIsGated` runs at module load, a
 * verb that forgets to declare a gate is a crash on import rather than an open door in production.
 *
 * `UNGATED` IS A VALUE, NOT AN ABSENCE. A write that should not require a capability says so
 * explicitly with the reason attached, so the exemption is a conscious line in a reviewed diff.
 * That is the same shape `IDEMPOTENCY_KEY_EXEMPT` uses in the conformance contract, and for the
 * same reason: an omission and a decision must not look alike.
 *
 * THIS MODULE MUST NOT IMPORT `src/api/registry.ts`. The dependency runs the other way (the
 * registry imports this file and calls the check with its own list of write names), which is what
 * keeps the module graph acyclic. It is also what lets `capabilities.ts` stay the §H-ENUM source of
 * truth without the enum having to know anything about MCP.
 */

import type { Capability } from './capabilities.js';
// G00's OP3 registry, for `set_field_value`'s inherited capability. This is a leaf import and creates
// no cycle: `entities.ts` imports only the `Capability` TYPE back, which erases at compile time, so
// nothing runs in the other direction.
import { ENTITY_KINDS, editCapabilityForKind, entityKindDef } from '../customization/entities.js';
import type { EntityKindDef } from '../customization/entities.js';

/**
 * The READ capability a G00 verb inherits for an entity kind: the read twin of `editCapabilityForKind`.
 *
 * G00's three reads (`list_field_defs`, `list_field_values`, `list_saved_views`) arrived while D50's
 * read gate was being built and were caught by `assertEveryActionIsGated` on import, which is that
 * guard doing exactly the job it was widened for. Lumping them into one domain was the easy answer
 * and the wrong one: reading the custom fields stored ON a journal entry is reading that entry, so
 * it belongs to the entry's domain and not to a customization shelf. `set_field_value` already
 * inherits the entity's EDIT capability for the mirror-image reason ("a custom field is not a back
 * door"), so a custom field must not become a side door on the way in either.
 *
 * The mapping lives HERE rather than in `entities.ts` because `EntityKindDef` and its rows are G00's
 * file, and because WHO may read what is A24 policy: the same division of labour G00's own note
 * draws when it says it registers capabilities but does not decide who holds them. `entityKindDef`
 * is a leaf import of a type-erasing module, so the graph stays acyclic.
 *
 * IT SWITCHES ON THE EDIT CAPABILITY AND NEVER ON THE KIND, which is what keeps G00's central claim
 * ("nothing in `fields.ts` or `views.ts` may switch on a kind, and one row is the entire opt-in")
 * true when a capability opts in. Registering `automation_rule` needed no branch anywhere in G00; it
 * needed one case HERE, because it brought an edit capability this map had never been shown, and the
 * map is A24 policy about who may read what. A kind whose edit capability is already listed still
 * costs exactly one row and nothing else.
 *
 * FAILS CLOSED ON AN UNKNOWN KIND, and to the same answer G00 chose for the write side:
 * `manage_custom_fields`. The gate runs BEFORE the verb, so it has to answer for an input the verb
 * would itself reject with `unknown_entity_kind`, and no built-in role holds that capability, so the
 * branch grants nothing. Answering a READ domain instead would be more permissive than any real row.
 */
const READ_FOR_EDIT_CAPABILITY: ReadonlyMap<Capability, Capability> = new Map([
  ['manage_master_data', 'read_master_data'],
  // The chart and the cost centres are the SHAPE of the books, which is the same reading that put
  // `list_accounts` and `list_cost_centers` behind `read_books`.
  ['manage_chart', 'read_books'],
  ['issue', 'read_sales'],
  ['pay', 'read_sales'],
  ['post', 'read_books'],
  ['manage_automations', 'read_automations'],
  // G02: a plugin is workspace configuration, so the custom fields and saved views hung on one read
  // exactly as the installed-plugin list does (`list_plugins` -> `read_master_data`, the G05
  // document-template precedent). The read twin is a softer domain than the edit capability
  // deliberately: browsing what is installed is not the same act as installing third-party code.
  ['manage_plugins', 'read_master_data'],
  // A15: a dunning run is the chase half of the receivable, so reading one (and the custom fields
  // and saved views hung on it) is exactly as hard as reading the open items it chases.
  ['dun', 'read_sales'],
  // A23: the workspace roster row. Its edit capability is `manage_settings` (governing the mandate),
  // and its read twin is the domain `get_workspace` and `get_company_profile` already answer to:
  // reading the custom fields on a client book is reading the book's own profile row.
  ['manage_settings', 'read_master_data'],
  // A25: a review event annotates a journal entry, so reading the custom fields hung on one is
  // reading the books, the same answer `review_status` itself gives.
  ['review', 'read_books'],
  // G10: a Zuordnungsvorlage's own list read gates on `manage_import` (the migration-map block
  // below states why the data reads take the write capability), so the custom fields hung on one
  // read exactly as hard as the template list they annotate. The read twin IS the edit capability
  // here, deliberately: migration mapping has no softer read domain.
  ['manage_import', 'manage_import'],
  // G13: an archive entry IS the books, historical or not, so the custom fields a Treuhänder hangs
  // on one (a Prüfvermerk during due diligence) read exactly as the books read. The edit twin is
  // `commit_migration` because annotating imported history is as hard as importing it.
  ['commit_migration', 'read_books'],
  // E01: the custom fields and saved views hung on a sign request read exactly as the request list
  // itself does, and E01's two reads (`sign_requests_get`/`_list`) answer `read_master_data` (a
  // sign request annotates an E00 filing, the `files_search` reasoning), so the G00 reads resolve
  // to the same domain.
  ['sign.write', 'read_master_data'],
  // F02: a portal grant annotates the customer relationship (the Portal-Zugang panel lives on the C00
  // contact detail), so the custom fields and saved views hung on one read exactly as `portal_grant_list`
  // itself does, which takes `read_master_data`. The edit twin is `portal.manage`.
  ['portal.manage', 'read_master_data'],
  // E03: the custom fields and saved views hung on a task read exactly as the queue itself does,
  // which is the read twin `tasks_list` declares below. The E03 pair is its own domain (task rows
  // are produced by no other capability's writes), so both halves are E03 names.
  ['tasks.write', 'tasks.read'],
  // B01: the E03 reasoning one register over. Time rows are produced only by B01's writes, so the
  // custom fields and saved views hung on a time entry read exactly as the timesheet itself does.
  ['time.write', 'time.read'],
  // C01: the custom fields and saved views hung on a deal read exactly as the board itself does,
  // which is the read twin `deals_list` declares below. The C01 pair is its own domain (deal rows
  // are produced by no other capability's writes), so both halves are C01 names, the E03 shape.
  ['deals.write', 'deals.read'],
  // E02: `employee` and `absence` are edited under `hr.manage`, `expense_claim` under `spesen.submit`
  // (its base drafting write). All three read as the personnel domain: reading the custom fields hung
  // on an employee, an absence or a claim is exactly as sensitive as reading the record itself, which
  // is `hr.read` (and the self-scoping filter narrows even that to the caller's own rows).
  ['hr.manage', 'hr.read'],
  ['spesen.submit', 'hr.read'],
  // B04: a retainer is a billing surface on the Zeit route, so the custom fields and saved views hung
  // on a mandate read exactly as the billing reads do (`billing.read`, the read domain B02's own reads
  // and the retainer reads below both use). The read twin is a softer domain than the edit capability
  // deliberately: seeing a mandate's annotations is not the same act as governing the mandate.
  ['retainer.manage', 'billing.read'],
  // F01: a report_run's edit capability is `reports.run` (annotating a run is exactly as hard as
  // producing one), and its read twin is `reports.read`, the domain F01's own metadata reads answer:
  // reading the custom fields hung on a run is reading the run list. The F01 pair is its own domain
  // (run rows are produced by no other capability's writes), the E03/C01 shape.
  ['reports.run', 'reports.read'],
  // G05: a document template is workspace configuration (the A23 `manage_settings` reasoning one
  // register over), so the custom fields and saved views hung on one read exactly as the template
  // list itself does: `read_master_data`, the domain G05's own three reads answer. The edit twin is
  // `manage_document_templates`, because annotating a template is exactly as hard as editing one.
  ['manage_document_templates', 'read_master_data'],
  // G05 §10: the send-log row is workspace correspondence infrastructure whose reads
  // (`list_dispatches`, `dispatch_preview`) answer `read_master_data`, so the custom fields and
  // saved views hung on a dispatch read exactly as the Protokoll itself does. The edit twin is
  // `manage_dispatch_texts`: annotating a send is exactly as hard as managing the outbound voice.
  ['manage_dispatch_texts', 'read_master_data'],
  // E04: the label field and saved views hung on a mail thread read exactly as the queue itself
  // does (`mail_threads_list`, `mail.read`), and writing one is exactly as hard as the thread's own
  // write half. The E04 pair is its own domain (mail rows are produced by no other capability's
  // writes), the E03/C01/F01 shape, and deliberately the STRICTEST: no softer domain may ever
  // answer for correspondence metadata.
  ['mail.write', 'mail.read'],
  // G04: a backup-history row's edit capability is `manage_data_export`, and its read twin is the
  // same name (the `manage_import` self-map shape): reading the custom fields a Treuhänder hangs on a
  // backup (a "Reason" tag, a "Keep until" date, spec §6b) is exactly as hard as reading the backup
  // history that `list_backups` gates on `manage_data_export`. There is no softer read domain for the
  // portability surface, so the read twin IS the edit capability, deliberately.
  ['manage_data_export', 'manage_data_export'],
  // G20: the implementation project/task/sign-off kinds edit under `manage_implementation`, so the
  // custom fields and saved views hung on one read exactly as hard as the project itself does. There is
  // no softer read domain for the implementation surface (a project's phase, blockers and sign-offs are
  // the governing record), so the read twin IS the edit capability, the `manage_import` / `manage_data_export`
  // self-map shape.
  ['manage_implementation', 'manage_implementation'],
  // A31: the `capture` entity kind edits under `manage_files` (a capture is a document-store record,
  // the E00 write right), so the custom fields and saved views hung on a capture read exactly as hard
  // as the filing itself does. `read_master_data` is the `files_search` read domain, the same twin
  // E01/F02 use for a filing-adjacent kind.
  ['manage_files', 'read_master_data'],
]);

export function readCapabilityForKind(kind: unknown): Capability {
  const def = entityKindDef(kind);
  if (def === undefined) return 'manage_custom_fields';
  // Safe as a `??` rather than a silent hole, because `assertEveryEntityKindHasAReadDomain` below has
  // already refused to load on a registered kind this map does not answer. The fallback is what an
  // unregistered kind gets, and it grants nothing.
  return READ_FOR_EDIT_CAPABILITY.get(def.editCapability) ?? 'manage_custom_fields';
}

/**
 * A REGISTERED ENTITY KIND WHOSE READ DOMAIN IS UNKNOWN IS A CRASH, NOT A QUIET DENIAL.
 *
 * The lookup above used to be a `switch` with a `default:` that answered `manage_custom_fields`, and
 * the critic measured what that meant: no built-in role holds that capability, so a kind whose edit
 * capability the switch had never been shown would silently make its three G00 reads owner-only. It
 * fails CLOSED, so it is not a security hole; it is a SILENT one, which is the harder kind to find.
 *
 * NOTHING IS BROKEN TODAY and that is precisely why this is worth writing now. All nine rows in
 * `ENTITY_KINDS` resolve to one of the six capabilities above, so the `default:` branch is currently
 * unreachable. It becomes reachable the moment a capability registers a kind with a new edit
 * capability, which is a one-line change in G00's registry that its author has no reason to connect
 * to a file in A24. E02 (`hr.manage`), G05 (`manage_document_templates`) and A25 (`review`/`export`)
 * are each already scheduled to do exactly that. A latent defect with three known future triggers is
 * worth one load-time assertion, and this is the repo's own idiom: `assertEveryActionIsGated` exists
 * because the same argument was made about a missing capability declaration.
 *
 * Called at module load below, so a kind with no read domain fails the import of every face of the
 * engine at once, with the kind and the capability named.
 */
export function assertEveryEntityKindHasAReadDomain(kinds: readonly EntityKindDef[]): void {
  const unmapped = kinds
    .filter((k) => !READ_FOR_EDIT_CAPABILITY.has(k.editCapability))
    .map((k) => `${k.kind} (editCapability '${k.editCapability}')`);
  if (unmapped.length > 0) {
    throw new Error(
      'A24: these G00 entity kinds have no READ domain, so their reads would silently resolve to ' +
        '`manage_custom_fields`, which no built-in role holds, making them owner-only with no ' +
        `error anywhere. Add a row to READ_FOR_EDIT_CAPABILITY: ${unmapped.join(', ')}.`,
    );
  }
}

assertEveryEntityKindHasAReadDomain(ENTITY_KINDS);

/**
 * THE CLOSED SET OF REASONS A VERB MAY BE EXEMPT, and why a free-text reason was not enough.
 *
 * `assertEveryActionIsGated` can only ever catch a MISSING declaration. It cannot catch a WRONG one,
 * because a `reason` is prose and prose is not checkable, and on 29.07.2026 the wave critic found two
 * exemptions whose prose was simply false: `run_due_automations` ("each firing is separately gated
 * against its own rule author, so the tick itself confers nothing", which gates the AUTHOR and says
 * nothing about the caller) and `create_saved_view` ("needs only the read access the caller already
 * has", which assumed an access nothing checked). Both were written in good faith and both read
 * plausibly. Neither would have survived being made to pick a category from this list.
 *
 * A SHAPE IS NOT A LABEL: each one below carries a check against a fact derived from the registry,
 * enforced at module load in `assertEveryActionIsGated`. The vocabulary is deliberately small and
 * closed, so the pressure on an author with a verb that fits none of them is to gate the verb rather
 * than to invent a sixth shape. Adding one is a reviewed change to this type, which is the point.
 *
 * AND THE RULE THAT SPANS ALL FIVE: no shape permits a verb that can INVOKE another verb as a
 * different actor. That is enforced separately by `assertActionInvokersAreGated`, because an ungated
 * verb holding an `ActionInvoker` is a capability-laundering machine by construction, whatever
 * category its author picked. It is the single rule that would have caught G1 on the day it landed.
 */
export type ExemptionShape =
  /** No tenant exists yet to resolve a capability against. Checked: must NOT reach the ctx gate. */
  | 'pre_workspace'
  /** Tells the caller only what the caller already is. Checked: must be a READ. */
  | 'self_scoped_read'
  /** Writes outside the tenant entirely (a file on this computer). Checked: must be a ctx verb. */
  | 'machine_scope'
  /** The real rule is state-dependent, so the engine refuses. Checked: must be a ctx verb. */
  | 'asserted_in_engine'
  /** Can only ever PREVENT a write, never cause one. Checked: must be a WRITE. */
  | 'prevents_only';

/** A verb this repo deliberately does not gate: which of the five shapes, and the reason in words. */
export interface Ungated {
  readonly ungated: true;
  readonly shape: ExemptionShape;
  readonly reason: string;
}

export function ungated(shape: ExemptionShape, reason: string): Ungated {
  return { ungated: true, shape, reason };
}

export function isUngated(rule: CapabilityRule): rule is Ungated {
  return typeof rule === 'object' && (rule as Ungated).ungated === true;
}

/**
 * What one action requires: a capability, ALL OF several, an explicit exemption, or a function of
 * the INPUT.
 *
 * THE ARRAY FORM IS "ALL OF", AND IT EXISTS BECAUSE THE ONE-CAPABILITY FORM WAS LYING. A verb whose
 * engine body unconditionally asserts a capability the declaration does not name is a verb whose
 * Roles-tab checkbox is wrong: measured on 29.07.2026 with a custom role holding exactly the
 * declared capability, five verbs refused. `record_payment` declared `pay` and answered
 * `permission_denied (needs post)`, because settling a payment posts a balanced entry through
 * `postEntry`, which asserts `post` for every caller that reaches it however indirectly. Collapsing
 * that to `post` alone would make `pay` decorative (a Treuhänder with `post` and no `pay` could
 * settle); declaring `pay` alone is the lie. Both are required, so both are declared.
 *
 * The function form exists for exactly one verb and would be over-engineering for any other.
 * `transition_document` is a single tool covering issue / send / accept / decline / confirm /
 * cancel, and issuing an invoice posts a balanced VAT entry through the A10 delegate while
 * declining a quote writes a status. Gating the whole verb on the strictest of those would deny a
 * viewer-adjacent role the ability to decline a quote; gating it on the loosest would let a role
 * without `send` put a document in front of a customer by naming the target state instead of
 * calling `send_invoice`. That second one is a real bypass, so the rule reads the target.
 *
 * WHAT A DECLARATION PROMISES, stated exactly, because the guard below measures this sentence:
 * holding EVERY capability named here is enough to get past the boundary AND past every
 * UNCONDITIONAL in-engine assert. It does not promise the verb will succeed: a further,
 * STATE-dependent capability may still refuse (see `unlock_period`), and that refusal names the
 * capability it wanted. A state-dependent gate cannot live at the boundary, which sees the input
 * and never the database.
 */
export type CapabilityRule =
  | Capability
  | readonly Capability[]
  | Ungated
  | ((input: Record<string, unknown>) => Capability);

/**
 * EVERY verb in `ACTIONS`, read and write, grouped by the capability module that owns it.
 *
 * READS USED TO BE ABSENT, and the header of this file used to defend that as policy. It was a hole.
 * The wave critic measured a NON-MEMBER of a provisioned workspace calling nine read verbs and
 * getting `ok` from all nine, `export_statement` included, which is a complete CSV of the ledger.
 * `revoke_member` promised to "remove a member's access" and removed only the writes. D50 answered
 * it with one read capability per DOMAIN; `capabilities.ts` carries the domains and the rule that
 * decides which one a verb belongs to.
 *
 * Three reads are `ungated`, each for a structural reason rather than a convenience:
 * `whoami` (a caller must be able to learn that it holds nothing, or the Studio cannot render a
 * denial), `list_workspaces` (pre-workspace, there is no tenant to resolve against), and
 * `preview_feedback` (whose write twin `prepare_feedback` is ungated for G08's own reason).
 *
 * `list_feedback` and `get_diagnostics` declare `diagnostics.read`, which they were ALREADY gated on
 * inside `src/api/support-actions.ts`. Declaring it here does not double-gate them: it makes the
 * boundary agree with the engine, which is the property `declared-gate-matches-enforced` measures.
 * `preview_feedback` and `prepare_feedback` keep their in-engine gate rather than gaining one here,
 * because theirs is conditional on the `includeDiagnostics` FLAG and not on the verb.
 */
export const CAPABILITY_FOR_ACTION: Readonly<Record<string, CapabilityRule>> = {
  // --- A00, company & fiscal setup -------------------------------------------------------------
  create_workspace: ungated('pre_workspace', 'Pre-workspace: there is no tenant yet to resolve a capability against.'),
  bootstrap_workspace: ungated('pre_workspace', 'Pre-workspace: mints the tenant the capability would be resolved in.'),
  set_fiscal_config: 'manage_settings',
  set_vat_method: 'manage_settings',
  set_creditor_profile: 'manage_settings',
  update_company_profile: 'manage_settings',

  // --- A01, chart of accounts & cost centres ---------------------------------------------------
  create_account: 'manage_chart',
  update_account: 'manage_chart',
  archive_account: 'manage_chart',
  unarchive_account: 'manage_chart',
  delete_account: 'manage_chart',
  create_cost_center: 'manage_chart',
  archive_cost_center: 'manage_chart',
  unarchive_cost_center: 'manage_chart',
  delete_cost_center: 'manage_chart',

  // --- A02, the double-entry journal -----------------------------------------------------------
  // These four are the only entries whose engine code ALSO asserts `post`. The boundary check and
  // the in-engine check are not redundant: A04's import and A19's opening balance reach `postEntry`
  // through their own verbs, so only the inner one sees that second call.
  post_entry: 'post',
  reverse_entry: 'post',
  save_draft: 'post',
  delete_draft: 'post',

  // --- A03, periods and the close --------------------------------------------------------------
  close_month: 'manage_periods',
  reopen_month: 'manage_periods',
  close_year: 'manage_periods',
  lock_period: 'manage_periods',
  // THE UNCONDITIONAL MINIMUM, which is `manage_periods` and not `unlock_period`. `unlockPeriod`
  // asserts `manage_periods` at the top for every caller and asserts `unlock_period` only after it
  // has read the lock and found an unsealed HARD one. That second gate is state-dependent, so it
  // cannot be declared here: the boundary sees the input and never the database. Declaring
  // `unlock_period` alone was measurably wrong (a role holding exactly it was refused, wanting
  // `manage_periods`), and declaring both would deny a `manage_periods` role the soft-lock clear it
  // has always been allowed. The narrower gate still fires, still refuses, and still names itself.
  unlock_period: 'manage_periods',

  // --- A05/A06/A07, MWST -----------------------------------------------------------------------
  vat_seed_defaults: 'manage_vat_config',
  vat_configure: 'manage_vat_config',
  vat_code_upsert: 'manage_vat_config',
  vat_code_deactivate: 'manage_vat_config',
  vat_code_reactivate: 'manage_vat_config',
  account_set_tax_default: 'manage_vat_config',
  // F11, and the one line in this file that a critic overturned. It was added at integration time
  // as `manage_vat_config` alone, reasoning that electing a declaration basis is configuration like
  // the rest of this block and that `vat_mark_filed` still guards what is told to the ESTV. The
  // second half of that is false. The verb has no filed-period guard, so it moves the figure of an
  // ALREADY FILED Steuerperiode: under the Saldosteuersatzmethode no rate is ever stamped on a line,
  // so a return is recomputed from the rule that governed the period, and changing that rule changes
  // a number a person has signed and sent. `manage_vat_config` is held by `bookkeeper`; `vat_file`
  // is not. A bookkeeper deliberately denied the filing capability could therefore move a figure the
  // Treuhänder filed.
  //
  // BOTH are required, which is the honest answer and not a compromise between two. The election is
  // a configuration act, so `manage_vat_config`; it is also a decision about what will be declared
  // to the ESTV, so `vat_file`. `owner` and `treuhaender` hold both, `bookkeeper` holds one, and the
  // line stays right whichever way the F11 filed-period guard lands: if that guard arrives, this is
  // still the capability a filing-basis election belongs to, and if it does not, this is the only
  // thing standing between a bookkeeper and a filed figure.
  vat_saldo_declaration_basis: ['manage_vat_config', 'vat_file'],
  // The one statutory statement in the product: this tells the ESTV a period was filed and applies
  // the A03 hard lock. Its own capability, held by owner and Treuhänder and by nobody else by default.
  vat_mark_filed: 'vat_file',

  // --- A09, contacts & items -------------------------------------------------------------------
  create_contact: 'manage_master_data',
  update_contact: 'manage_master_data',
  archive_contact: 'manage_master_data',
  unarchive_contact: 'manage_master_data',
  create_item: 'manage_master_data',
  update_item: 'manage_master_data',
  archive_item: 'manage_master_data',
  unarchive_item: 'manage_master_data',
  // D00, the products/items master's new writes: master-data edits, gated like the A09 item CRUD they
  // extend. delete_item is a master-data delete fenced by the engine's reference census, not a ledger
  // delete, so it stays on `manage_master_data` rather than earning a stricter capability.
  delete_item: 'manage_master_data',
  item_categories_upsert: 'manage_master_data',
  item_categories_delete: 'manage_master_data',
  price_lists_upsert: 'manage_master_data',
  price_lists_set_price: 'manage_master_data',
  price_lists_unset_price: 'manage_master_data',
  price_lists_delete: 'manage_master_data',

  // --- C00, contacts / CRM (extends A09) -------------------------------------------------------
  // A contact is master data, so its CRM writes gate on the contact entity's own edit capability,
  // `manage_master_data`, exactly as A09's create/update do. The timeline read gates on
  // `read_master_data`, the read twin of the master-data domain, so seeing a relationship's history
  // is exactly as hard as reading the contact it belongs to.
  contacts_tag: 'manage_master_data',
  contacts_log_activity: 'manage_master_data',
  contacts_import: 'manage_master_data',
  // THE TWO ELEVATED ONES, ON THE SPEC'S OWN `contacts.merge` SINCE THE F5 RETROFIT (30.07.2026).
  // This block used to gate both on `manage_master_data` alone and carried the deferral in its own
  // comment ("a finer split is a future A24 retrofit"). The ALL-OF is `record_payment`'s shape and is
  // honest on both halves: a merge re-points master data, so `manage_master_data`; it also mints a
  // one-way tombstone (and anonymise erases personal data under revDSG), so the elevated right. The
  // built-in bundles that held `manage_master_data` gained `contacts.merge` in the same commit, so no
  // shipped role's effective surface moved; what the split buys is that a custom role can now keep
  // ordinary master-data edits and NOT the two destructive-adjacent verbs. Both also remain on
  // `NOT_AUTOMATABLE` and both keep their typed GUI confirm step: the capability asks whether the
  // actor MAY, the confirm asks whether a human said so on this occasion.
  contacts_merge: ['manage_master_data', 'contacts.merge'],
  contacts_anonymise: ['manage_master_data', 'contacts.merge'],
  contacts_timeline: 'read_master_data',

  // --- B00, projects master --------------------------------------------------------------------
  // A project is master data (the spec's `project.manage` has no A24 name; spec §0 records the
  // mapping, the C00 deferral shape: a finer split is a future A24 retrofit). Every write gates on
  // `manage_master_data`, including the draft-only `project_delete`, which is a master-data delete
  // fenced by the engine's own census, the `delete_item` reasoning verbatim. The reads sit in the
  // `read_master_data` section below with the other registers.
  project_create: 'manage_master_data',
  project_update: 'manage_master_data',
  project_set_status: 'manage_master_data',
  project_delete: 'manage_master_data',
  project_phase_add: 'manage_master_data',
  project_phase_update: 'manage_master_data',
  project_phase_done: 'manage_master_data',

  // --- D01, inventory / stock ------------------------------------------------------------------
  // The OPERATIONAL writes are master data: a location is a register row, and a stock movement is an
  // OP2 quantity ledger entry that never posts to the account ledger, so both gate on
  // `manage_master_data` (the `create_item`/`project_create` reasoning). The stocktake writes are the
  // same act one register over: opening, counting and committing an Inventur mint no journal row (the
  // commit's differences become `stock_movement` rows through the shared movement path), so they too
  // gate on `manage_master_data`. `stock_stocktake_commit` is additionally P8-relevant and on the
  // automation denylist (a human owns the OR 958c Abs. 2 Bestandesnachweis), which is a different
  // question from the capability: the capability asks whether the actor MAY, the denylist keeps a rule
  // from firing it silently.
  stock_location_upsert: 'manage_master_data',
  stock_move: 'manage_master_data',
  stock_stocktake_open: 'manage_master_data',
  stock_stocktake_count: 'manage_master_data',
  stock_stocktake_commit: 'manage_master_data',
  // REPORT-ONLY since K68: it computes and returns the period-end inventory valuation and writes its
  // own `stock_valuation_run` row, but mints NO journal entry. J06 `inventory_valuation_post` is now
  // the sole path inventory value reaches the GL, so this no longer touches A02 `postEntry` and must
  // not require `post`: a read-only actor asking for a harmless valuation report should not be denied.
  // It gates on `read_master_data`, the SAME right its closest sibling `stock_valuation_report` (D01's
  // own stock valuation READ, below) carries: both summarise the OP2 stock position without opening
  // the journal. It stays on the automation denylist so an unattended rule does not fire the run.
  stock_run_valuation: 'read_master_data',

  // --- J00, warehouses & locations (Wave 13, inventory root) -----------------------------------
  // Plain master data, no money path: a warehouse and a location are register rows, and every J00
  // write mints no journal entry, so all nine gate on `manage_master_data` (the stock_location_upsert
  // reasoning one register over). `inventory_ensure_default_location` is a write (it may seat the
  // MAIN/DEFAULT pair), so it gates too. The six reads sit in read_master_data below.
  warehouse_create: 'manage_master_data',
  warehouse_update: 'manage_master_data',
  warehouse_set_default: 'manage_master_data',
  warehouse_archive: 'manage_master_data',
  location_create: 'manage_master_data',
  location_update: 'manage_master_data',
  location_set_default: 'manage_master_data',
  location_archive: 'manage_master_data',
  inventory_ensure_default_location: 'manage_master_data',

  // --- J01, lot & serial tracking (Wave 13, inventory, plain master data, no money path) --------
  // A lot and a serial are register rows, and every J01 write mints no journal entry (on-hand stays
  // a derived SUM over the OP2 movement ledger), so all ten writes gate on `manage_master_data` (the
  // `warehouse_create` / `stock_location_upsert` reasoning one register over). `item_set_tracking_mode`
  // edits an item's own master-data column, so it takes the item's own `manage_master_data` right. The
  // eight reads sit in read_master_data below.
  item_set_tracking_mode: 'manage_master_data',
  lot_create: 'manage_master_data',
  lot_update: 'manage_master_data',
  lot_set_status: 'manage_master_data',
  lot_archive: 'manage_master_data',
  serial_create: 'manage_master_data',
  serial_create_bulk: 'manage_master_data',
  serial_update: 'manage_master_data',
  serial_set_status: 'manage_master_data',
  serial_archive: 'manage_master_data',

  // --- J02, the inventory movement ledger (Wave 13, inventory, MONEY-PATH quantity truth) ---------
  // A movement is the OP2 non-posting quantity ledger: it records quantity, never money on the
  // account ledger (valuation reaches the books only through J06 -> A02, out of scope here), so the
  // three writes gate on `manage_master_data`, the SAME right D01's `stock_move` and the stocktake
  // writes carry one register over. `inventory_set_config` flips the workspace negative-stock posture
  // (plain policy, no journal entry), and it too gates on `manage_master_data` so the whole J02 write
  // surface sits on one capability rather than fragmenting the inventory role. The four reads sit in
  // read_master_data below.
  inventory_move: 'manage_master_data',
  inventory_transfer: 'manage_master_data',
  inventory_set_config: 'manage_master_data',

  // --- J03, advanced valuation methods (Wave 13, inventory, MONEY-PATH valuation basis) ----------
  // These three write VALUATION POLICY, never a journal entry: J03 posts nothing at all, and the
  // figure they shape reaches the books only through J06, which carries `post`. So they are not
  // `post`, and they are no longer `manage_master_data` either.
  //
  // OWNER DECISION, 2026-08-11, taken after the valuation critic. They shipped on
  // `manage_master_data` because the register had no better name; the owner minted `inventory.setup`
  // (the id the spec asked for) instead. Choosing weighted average over FIFO decides the inventory
  // figure on the balance sheet, and `manage_master_data` is the same right that covers renaming an
  // item. The decisive asymmetry: `treuhaender` does NOT hold `manage_master_data`, so the mandate
  // answerable for the Bilanz could not choose the basis while the day-to-day bookkeeper could. Both
  // built-ins hold `inventory.setup`; `agent` holds neither it nor a way around it. The reasoning
  // and the group choice live beside the id in `capabilities.ts`.
  inventory_valuation_method_set_enabled: 'inventory.setup',
  inventory_valuation_set_default: 'inventory.setup',
  inventory_valuation_set_item_method: 'inventory.setup',

  // J06, the valuation run & GL link (MONEY PATH, OP11). Creating a draft chooses and computes the
  // basis, so it is `inventory.setup` (the same compliance right that chooses the method). Posting,
  // reversing and the opening baseline move the balance-sheet inventory figure through A02, so they
  // are `post`: the engine's `postEntry` asserts `post`, and the boundary matches it. Since K68 this
  // is the SOLE path inventory value reaches the GL (D01's `stock_run_valuation` is report-only).
  inventory_valuation_create: 'inventory.setup',
  inventory_valuation_post: 'post',
  inventory_valuation_reverse: 'post',
  inventory_valuation_opening: 'post',

  // --- J04, cycle count / stocktake (Wave 13, inventory, MONEY-PATH quantity truth) ----------------
  // A stocktake mints stock QUANTITY changes, never money on the account ledger: every non-zero
  // variance is committed EXCLUSIVELY through J02 `inventory_move` (movement_type adjustment), and the
  // financial effect arrives later through J06 -> A02. So the six writes gate on `manage_master_data`,
  // the SAME right `inventory_move` and D01's `stock_stocktake_commit` carry. Commit is not `post`
  // precisely because it reaches the movement ledger, not the journal: `inventory_move` itself asserts
  // `manage_master_data`, and the boundary matches it. The three reads sit in read_master_data below.
  inventory_stocktake_create: 'manage_master_data',
  inventory_stocktake_count: 'manage_master_data',
  inventory_stocktake_approve_lines: 'manage_master_data',
  inventory_stocktake_request_recount: 'manage_master_data',
  inventory_stocktake_commit: 'manage_master_data',
  inventory_stocktake_cancel: 'manage_master_data',

  // --- J05, inventory adjustments & reasons (Wave 13, inventory, MONEY-PATH quantity truth) --------
  // The reason catalog is master data and the adjustment mint moves stock QUANTITY, never money on the
  // account ledger: every J05 adjustment is minted EXCLUSIVELY through J02 `inventory_move`
  // (movement_type adjustment), which itself asserts `manage_master_data`. So the six writes gate on
  // `manage_master_data`, the SAME right `inventory_move` and the J04 stocktake writes carry, and the
  // boundary matches the engine. The four reads sit in read_master_data below.
  inventory_reason_create: 'manage_master_data',
  inventory_reason_update: 'manage_master_data',
  inventory_reason_archive: 'manage_master_data',
  inventory_adjust: 'manage_master_data',
  inventory_adjust_batch: 'manage_master_data',
  inventory_adjust_reverse: 'manage_master_data',

  // --- E00, file management --------------------------------------------------------------------
  // THE FILING WRITES, ON THEIR OWN CAPABILITY SINCE 30.07.2026 (F8, owner-decided). This block said
  // `manage_master_data` for all six and defended it as "E00 has no verb the master-data right does not
  // already describe honestly". The critic measured what that cost: `treuhaender` holds `post` and NOT
  // `manage_master_data`, so the fiduciary who keeps the books could post an entry and was refused
  // `files_upload` for the Buchungsbeleg behind it. Widening `manage_master_data` would have handed that
  // mandate the contacts, items and bank-account registers too, so the name is split instead.
  //
  // WHAT `files_upload` REQUIRES, and why an upload cannot borrow the F8 rule. An upload has no link
  // yet, so there is no entity whose right it could inherit: the file arrives before anybody knows what
  // it evidences, which is the ordinary order of work and the reason `entity_kind` is nullable. Its own
  // capability is the only honest answer, because the alternatives all break something measurable:
  // `post` would refuse a sales clerk with `issue` attaching a PDF to an invoice; the strictest right in
  // the product would make the filing cabinet owner-only; and there is no ANY-OF form in `CapabilityRule`
  // (see below) with which to say "whoever may write something here". `manage_files` is therefore a
  // right to CONTRIBUTE evidence, and it deliberately does not include the right to READ the bytes
  // back: that is `read_file_content`, F7, and conflating the two would have reopened it.
  files_upload: 'manage_files',
  // G18 US-G18.4: the chunk-upload lane is the large-file arm of `files_upload`, so it INHERITS E00's
  // existing filing right and mints no new capability. A contributor who may store a Beleg may store a
  // 300 MB GL export the same way, one bounded chunk at a time.
  files_upload_begin: 'manage_files',
  files_upload_chunk: 'manage_files',
  files_upload_commit: 'manage_files',
  files_update: 'manage_files',
  files_new_version: 'manage_files',
  folders_upsert: 'manage_files',
  folders_delete: 'manage_files',

  // ATTACHING FOLLOWS THE TARGET'S OWN WRITE RIGHT (F8), which is `set_field_value`'s rule applied to
  // the other kind of data ABOUT a record. Linking a file to a journal entry is exactly as hard as
  // writing that journal entry (`post`), to a contact as hard as writing the contact
  // (`manage_master_data`), and to an invoice as hard as issuing one. That is what makes the Treuhänder
  // case work without widening anything: it already holds `post`.
  //
  // IT READS G00's REGISTRY RATHER THAN RESTATING A POLICY, which is the constraint on this change. One
  // row in `ENTITY_KINDS` remains the entire opt-in, so a capability that registers a kind next year
  // cannot forget to gate the files hung on it, and this map cannot drift from the one
  // `set_field_value` uses because it IS the one `set_field_value` uses. It fails closed on an unknown
  // kind, to `manage_custom_fields`, which no built-in holds and which the verb itself then refuses with
  // `unknown_entity_kind`.
  //
  // `manage_files` is NOT additionally required here, and that is a deliberate line rather than an
  // oversight. `CapabilityRule`'s function form yields ONE capability, and widening it to an ALL-OF
  // would put a second declaration on the one verb whose gate is already input-dependent. The residual
  // is that a role holding `post` and not `manage_files` could re-point an existing file's link, which
  // is the same shape G00 accepted for `set_field_value` and is bounded by the fact that it cannot put
  // a file there in the first place.
  files_link: (input) => editCapabilityForKind(input.entityKind),

  // THE TWO ELEVATED ONES, AND THE PAIR IS A REAL SEPARATION RATHER THAN A FORMALITY. E00 asked for
  // `documents.admin` on exactly these two, and the closest the shipped model comes is BOTH the filing
  // right and the governance one, which is not a compromise: `bookkeeper` and `treuhaender` both hold
  // `manage_files` and neither holds `manage_settings`, so either can file, tag and supersede every
  // voucher in the workspace and neither can shorten a statutory retention or erase a business record.
  // That is the line `documents.admin` was drawn for.
  //
  // `manage_settings` and not `manage_periods`, which was the other candidate: a retention date is
  // not a period lock. It does not decide what may be POSTED, it decides how long the evidence
  // behind a posting must survive, and it is a workspace-wide compliance setting in the same family
  // as the aging buckets and the write-off threshold that already sit on this capability.
  //
  // `files_delete` is additionally P8 draft-gated inside the verb for an agent actor, which is a
  // different question from this one: the capability asks whether the actor MAY, the P8 gate asks
  // whether a human has said so on this occasion. An agent that holds both capabilities still stages.
  files_set_retention: ['manage_files', 'manage_settings'],
  files_delete: ['manage_files', 'manage_settings'],

  // --- A10/A11, documents and invoices ---------------------------------------------------------
  create_document: 'issue',
  update_document: 'issue',
  convert_document: 'issue',
  issue_invoice: 'issue',
  send_invoice: 'send',
  // A13: document issuance has always been `issue` (`post` gates raw journal writes), and both
  // credit-note verbs carry the same gate as the create/issue pair they mirror.
  create_credit_note: 'issue',
  issue_credit_note: 'issue',
  // See `CapabilityRule`: the target state decides, so `to: 'sent'` cannot be used to route around
  // `send_invoice`'s own gate.
  transition_document: (input) => (input.to === 'sent' ? 'send' : 'issue'),

  // --- A32, eBill issuing ----------------------------------------------------------------------
  // The config write is `manage_settings` (the `set_creditor_profile` / `set_dunning_config` twin: a
  // workspace-configuration write), its read `read_sales` (the `get_dunning_config` config-read twin).
  // `ebill_prepare` is `issue`: preparing an outward-facing delivery artifact from an ISSUED invoice is
  // exactly the `delivery_note_render` posture, an OP4 local artifact an agent may build freely. Only
  // `ebill_transmit` is `send`, the outbound step, gated identically to `send_invoice` (P8 in-engine).
  // `ebill_delivery_status` is `read_sales`, the document read domain (D50). The connector-facing
  // `mirrorEbillPartnerStatus` seam is not a verb, so it is not mapped here (spec §4).
  get_ebill_config: 'read_sales',
  set_ebill_config: 'manage_settings',
  ebill_prepare: 'issue',
  ebill_transmit: 'send',
  ebill_delivery_status: 'read_sales',

  // A33, EBICS bank channel (spec §3: "all three verbs gate behind A24's banking-write capability").
  // `pay` IS that banking-write capability, the `create_payment_batch`/`generate_pain001`/`import_camt`
  // precedent: connect/sync/transmit/disconnect all sit in the payment-traffic domain and none posts
  // (P3 by delegation), so `pay` alone is the honest declaration (settlement's `['pay','post']` pair
  // belongs to `mark_batch_paid`, which A33 never calls). The status read is `read_books`, the
  // `get_payment_batch`/`list_payment_batches` domain it joins. The "deliberate human act" of the key
  // ceremony is enforced by the in-engine P8 gate plus the automation denylist, not by a rarer capability.
  bank_channel_connect: 'pay',
  bank_sync: 'pay',
  payment_batch_transmit: 'pay',
  bank_channel_disconnect: 'pay',
  bank_channel_status: 'read_books',
  // A36: the bank directory is a build-time constant (opens no socket, reads no tenant data), but it
  // is called with a workspaceId, so it is gated as a banking read alongside its sibling
  // `bank_channel_status` rather than exempted: the actor running the connect wizard holds `read_books`.
  bank_channel_directory: 'read_books',
  // A36: link/unlink the scheduled-sync rule pointer. Banking-write, the same capability as the
  // `bank_sync` verb it schedules; it fires no rule and moves no money.
  set_bank_sync_schedule: 'pay',

  // --- A12, recurring invoices -----------------------------------------------------------------
  // Every write takes `issue`, the same right the schedule's OUTPUT requires: a schedule is a
  // standing instruction to create (and maybe issue) invoices, so configuring one must never be
  // cheaper than doing the thing it automates. The tick doubly so: the CALLER needs `issue` here
  // at the boundary, and each generation then re-resolves the schedule AUTHOR's own capabilities
  // live through the shared dispatch (the G01 fire-path model), so neither identity is on faith.
  // A second fact leans on this block: the tick's conditional due-date re-assert swallows the
  // draft-only `update_document` refusal, which is safe ONLY while `update_document` and
  // `issue_invoice` resolve alike (both `issue`, above); the F3 probe pins that equality.
  create_recurring_schedule: 'issue',
  update_recurring_schedule: 'issue',
  pause_recurring_schedule: 'issue',
  resume_recurring_schedule: 'issue',
  end_recurring_schedule: 'issue',
  run_due_recurring: 'issue',

  // --- A22 / H-FX, exchange rates --------------------------------------------------------------
  record_exchange_rate: 'post',
  import_exchange_rates: 'post',
  // The MWSTV Art. 45 conversion basis is a tax election, not a rate, so it belongs with the VAT
  // config: that reasoning stands. What did not stand is declaring ONLY that, because `setFxMethod`
  // (`src/core/fx/method.ts`) opens with `assert('post')` and a role holding exactly
  // `manage_vat_config` was refused. Both are declared until that assert is revisited, which is a
  // change to an FX engine file this remediation does not own. Declaring the engine's real
  // requirement never widens a gate; changing the engine to match a declaration could.
  set_fx_method: ['manage_vat_config', 'post'],
  // A22, FX revaluation. `post_fx_revaluation` books journal entries through `postEntry` (which
  // asserts `post` for every caller that reaches it), so it gates on `post`, the same as every other
  // poster on the money path. `fx_revaluation` reads the ledger's monetary-position balances, so it
  // gates on `read_books`, the read twin the A08 statements and `list_journal` already use.
  post_fx_revaluation: 'post',
  fx_revaluation: 'read_books',

  // --- A14, payments ---------------------------------------------------------------------------
  // ALL THREE POST. `recordPayment` books the settlement through `postEntry`, and `postEntry`
  // asserts `post` for every caller that reaches it, so these verbs have always required `post` as
  // well as `pay`. Declaring `pay` alone put a checkbox on the Roles tab that did not describe the
  // engine. Collapsing to `post` alone would be the opposite error: `pay` would gate nothing, and a
  // Treuhänder deliberately given `post` without `pay` could settle invoices.
  record_payment: ['pay', 'post'],
  allocate_payment: ['pay', 'post'],
  reverse_payment: ['pay', 'post'],
  // Not in that list on purpose, and measured rather than assumed: this one writes a threshold and
  // reaches no poster, so `pay` alone really is sufficient.
  set_write_off_threshold: 'pay',

  // --- A17, vendor bills and expenses ----------------------------------------------------------
  // ALL FIVE ON `post`, and the draft is not the exception it looks like. `create_vendor_bill` writes
  // no journal row, but the row it writes IS the posting in waiting: it carries the tax code, the
  // expense account and the amount, and `post_vendor_bill` takes no further input, so an actor who can
  // draft has already decided what will be booked. `record_expense`, `post_vendor_bill` and
  // `void_vendor_bill` reach `postEntry`/`reverseEntry`, which assert `post` themselves, so declaring
  // anything narrower for those three would put a checkbox on the Roles tab that does not describe the
  // engine (the exact defect the wave critic measured on A14's `pay`-only declaration).
  //
  // `attach_receipt` is D60's E00 rule applied one capability over: attaching data ABOUT an entity
  // requires whatever writing that entity requires. A Buchungsbeleg on a bill therefore needs `post`,
  // the same answer E00 reached for a journal-entry attachment, and the same answer G00 reached when
  // `set_field_value` inherited the entity's edit capability.
  //
  // NO `pay` ANYWHERE HERE, deliberately: A17 owns no settlement verb, so there is nothing for it to
  // gate. Paying a bill is `record_payment`, which is gated on ['pay', 'post'] above and unchanged.
  create_vendor_bill: 'post',
  record_expense: 'post',
  post_vendor_bill: 'post',
  attach_receipt: 'post',
  void_vendor_bill: 'post',

  // --- A31, document capture -------------------------------------------------------------------
  // NO NEW RIGHTS INVENTED (spec §3, the P1 proposal). Intake, re-extract and discard are E00
  // document-store operations plus queue bookkeeping, so they gate on E00's own write right
  // (`manage_files`, the F8 name for `documents.write`); the reads gate on the filing read domain
  // (`read_master_data`, the `files_search` reasoning). `capture_commit` is gated by the DELEGATED
  // verb's own capability, the `transition_document` function-form shape: the bill path reaches A17
  // `create_vendor_bill` (which self-asserts `post`), the expense path reaches E02 (which self-asserts
  // `spesen.submit`), so declaring the delegated verb's right at the boundary makes the Roles tab
  // honest AND cannot let a caller widen what calling A17/E02 directly would allow. Posting the
  // committed DRAFT stays A17's separately-gated `post_vendor_bill` (P8); A31 mints no dial level.
  capture_document: 'manage_files',
  capture_extract: 'manage_files',
  capture_discard: 'manage_files',
  capture_commit: (input) =>
    (input.target as { kind?: unknown } | undefined)?.kind === 'expense_line' ? 'spesen.submit' : 'post',
  list_captures: 'read_master_data',
  get_capture: 'read_master_data',

  // --- A18, creditor payments (pain.001) ---------------------------------------------------------
  // `set_creditor_bank_profile` is master data (a vendor's IBAN), gated the way A19's
  // `update_bank_account` gates the WORKSPACE's own bank details: `manage_master_data`, no `pay`
  // needed because it reaches no poster. It is on the automation denylist for the reason A19's own
  // verb is (D65 leg f), not for the reason `pay`-gated verbs are.
  set_creditor_bank_profile: 'manage_master_data',
  // `create_payment_batch`/`generate_pain001` write no journal row and reach no poster (the
  // `record_incoming_credit` shape, measured not assumed): a batch is a draft artefact until
  // `mark_batch_paid` settles it, so `pay` alone is the honest declaration for both.
  create_payment_batch: 'pay',
  generate_pain001: 'pay',
  // ALL-OF, the `record_payment` shape verbatim: `markBatchPaid` calls A14's `recordPayment`, which
  // asserts `post` for every caller that reaches it however indirectly, so both are required.
  mark_batch_paid: ['pay', 'post'],
  // `discard_payment_batch` abandons a batch that must not be paid; it writes no journal row and
  // reaches no poster (the `create_payment_batch` shape), so `pay` alone is the honest declaration.
  discard_payment_batch: 'pay',

  // --- A16, Debitoren --------------------------------------------------------------------------
  set_aging_bucket_config: 'manage_settings',

  // --- A15, Mahnwesen --------------------------------------------------------------------------
  // The policy is a workspace-wide convention about a read_sales figure, the aging-bucket and
  // write-off-threshold family, so its write sits with theirs.
  set_dunning_config: 'manage_settings',
  // Proposing persists a reviewable draft and nothing else: `dun` alone.
  propose_dunning_run: 'dun',
  // THE UNCONDITIONAL MINIMUM (the `unlock_period` shape). Issuing books a Mahngebühr ONLY when
  // the config says so, and the boundary sees the input and never the config row, so `post` cannot
  // be declared here without denying a fee-less workspace's `dun` role the issue it has always
  // been allowed. The engine asserts `post` before any write when a fee WILL be booked
  // (`issueDunningRun`), and that refusal names the capability it wanted.
  issue_dunning_run: 'dun',
  // The ALL-OF (`record_payment`'s shape): operating dunning AND putting a letter in front of a
  // customer. An agent holds `dun` and not `send`, exactly as it cannot `send_invoice`.
  send_dunning_run: ['dun', 'send'],

  // --- A21, QR incoming matching ---------------------------------------------------------------
  // The queue row is settlement bookkeeping, not master data, so recording a credit sits on `pay`
  // alone: it writes no journal row and reaches no poster (the `set_write_off_threshold` shape,
  // measured not assumed: `recordIncomingCredit` asserts `pay` and nothing else). Apply and
  // override are `record_payment`'s ALL-OF verbatim, because they ARE record_payment and
  // reverse_payment with a queue row around them: the engine's postEntry asserts `post` on every
  // path, and declaring `pay` alone would repeat the exact defect the wave critic measured on A14.
  record_incoming_credit: 'pay',
  apply_qr_match: ['pay', 'post'],
  override_qr_match: ['pay', 'post'],
  // The dial is a workspace convention AND the switch that lets money move unattended, so it takes
  // BOTH the settings right and the settlement right: a settings-only role must not be able to arm
  // unattended settlement it could never perform itself.
  set_qr_auto_apply: ['manage_settings', 'pay'],

  // --- A20, camt reconciliation --------------------------------------------------------------------
  // `import_camt` is the `record_incoming_credit` shape (measured, not assumed): it writes no journal
  // row itself and reaches no poster directly, though a routed credit's registration inherits
  // recordIncomingCredit's own `pay` assert internally. `pay` alone.
  import_camt: 'pay',
  // `confirm_match` and `create_entry_for_txn` are `apply_qr_match`'s ALL-OF verbatim: the settlement
  // branch reaches `recordPayment`, which asserts `post` through `postEntry` on every path, and the
  // manual-entry branch asserts `post` directly (`postEntry`'s own gate). Declaring `pay` alone on
  // `confirm_match` would repeat A14's own measured defect; `create_entry_for_txn` never reaches `pay`
  // internally, but a bank-fact posting is a settlement act on the same surface, so both are declared
  // on `post` at minimum, and `confirm_match` additionally asserts `pay` itself (the
  // `applyQrMatch`/`overrideQrMatch` precedent).
  confirm_match: ['pay', 'post'],
  create_entry_for_txn: 'post',
  // A36 (live bank feed). `review_bank_txn` is a banking-write signal on a bank_txn (the `import_camt`
  // neighbourhood): it books nothing but touches the reconciliation surface, so `pay`. `set_camt_matching`
  // is a settings write that arms no unattended settlement (unlike `set_qr_auto_apply`), so `manage_settings`
  // alone.
  review_bank_txn: 'pay',
  set_camt_matching: 'manage_settings',

  // --- A19, bank accounts ----------------------------------------------------------------------
  create_bank_account: 'manage_master_data',
  update_bank_account: 'manage_master_data',
  archive_bank_account: 'manage_master_data',
  unarchive_bank_account: 'manage_master_data',
  // This one POSTS: it books the opening balance as a real balanced journal entry.
  set_bank_opening_balance: 'post',

  // --- A04, opening balances -------------------------------------------------------------------
  set_opening_balances: 'post',
  import_opening_balances: 'post',

  // --- A23, multi-client workspaces ------------------------------------------------------------
  // `onboard_client` is the `create_workspace` shape exactly: it MINTS the tenant a capability
  // would be resolved in, so there is nothing on the input to resolve one against. What it adds
  // over a bare create (the owner seating) is what CLOSES the ungated window, not what widens it.
  onboard_client: ungated('pre_workspace', 'Pre-workspace: mints the tenant the capability would be resolved in (the create_workspace shape), then seats its owners.'),
  // G03: the same shape as onboard_client, and the same closing move: what it adds over a bare
  // create (owner seating plus the kind='demo' stamp) narrows the ungated window, never widens it,
  // and the minted workspace can never promote into real books (G12's go_productive refuses it).
  create_demo_workspace: ungated('pre_workspace', 'Pre-workspace: mints the demo tenant the capability would be resolved in (the create_workspace/onboard_client shape), then seats its caller as owner.'),
  // Retiring a mandate is workspace GOVERNANCE, not bookkeeping: the same family as the aging
  // buckets, the write-off threshold and the retention lock, and the same answer. Among the
  // built-ins only `owner` holds `manage_settings`, which is the spec's "owner only" made real
  // without minting a capability for a domain `manage_settings` already describes honestly.
  // No new name, per the registry's own rule: a capability adds one only when it brings a domain
  // that does not exist.
  archive_workspace: 'manage_settings',

  // --- A24, this capability --------------------------------------------------------------------
  invite_member: 'manage_members',
  set_role: 'manage_members',
  revoke_member: 'manage_members',
  define_role: 'manage_members',
  archive_role: 'manage_members',
  accept_invite: ungated('pre_workspace', 'Pre-workspace: the accepter is not a member yet, and the token IS the authorisation.'),

  // --- G17, in-product guidance ----------------------------------------------------------------
  // The two corpus reads join `accept_invite`'s workspace-free family for a DIFFERENT reason with
  // the reason written down: the Begriffe corpus is a build-time constant, identical in every
  // workspace, so there is no tenant row to scope and no capability that could meaningfully guard
  // it. A workspace scope here would imply the explanation of a statutory election CAN differ per
  // workspace, which is the property G17's design forbids outright (§6c). The panel a viewer reads
  // and the payload an agent cites must be one string, for every actor, in every workspace.
  list_concepts: ungated('pre_workspace', 'The Begriffe corpus is a build-time constant, not tenant data: identical in every workspace, so there is no tenant to resolve a capability against and nothing a role could be denied.'),
  get_concept: ungated('pre_workspace', 'Same as list_concepts: the corpus is the wording of record, identical everywhere; a capability gate would only make an explanation unreadable to the actor who most needs it.'),

  // --- M00, packaged local delivery ------------------------------------------------------------
  // `delivery_status` describes the PROCESS (mode, bound port, scheduler tick), not any tenant, and
  // it precedes any workspace: the first-run flow calls it before a ledger even exists. There is no
  // tenant to resolve a capability against, and the facts it returns (the loopback address, whether
  // a scheduler is alive) are the same for every actor on the machine, so it joins the pre-workspace
  // exempt family for the same structural reason `list_concepts` does.
  delivery_status: ungated('pre_workspace', 'Describes the running delivery process, not tenant data, and precedes any workspace (the first-run flow calls it before a ledger exists): there is no tenant to resolve a capability against.'),

  // --- G05, document templates -----------------------------------------------------------------
  // The template lifecycle is a governing act over the workspace's outward face (what every future
  // invoice looks like), the `manage_custom_fields` shape: its own capability, held by nobody by
  // default. The reads sit in `read_master_data` (a template is workspace configuration, the
  // `manage_settings` twin), and `preview_document_template` inherits the domain of the write it
  // previews nothing of: it is a pure read over the template plus an already-issued document's own
  // render, so the configuration domain answers for it too.
  create_document_template: 'manage_document_templates',
  update_document_template: 'manage_document_templates',
  set_default_document_template: 'manage_document_templates',
  archive_document_template: 'manage_document_templates',
  list_document_templates: 'read_master_data',
  get_document_template: 'read_master_data',
  preview_document_template: 'read_master_data',

  // --- G05 §10, dispatch texts and the send log ------------------------------------------------
  // The saved outbound text is the workspace's VOICE the way the template is its LOOK, so the one
  // write takes its own governance capability (owner-only by default, the
  // `manage_document_templates` shape). The two reads sit in `read_master_data` (spec §10.3: the
  // preview and the Protokoll stay readable to any workspace member, `viewer` included).
  dispatch_text_upsert: 'manage_dispatch_texts',
  dispatch_preview: 'read_master_data',
  list_dispatches: 'read_master_data',

  // --- G00, the customization framework --------------------------------------------------------
  // Defining, releasing or retiring a custom field is ADMINISTRATION, not data entry: it changes the
  // shape of what every record of that kind can carry. Its own capability, held by nobody by default.
  define_field: 'manage_custom_fields',
  confirm_field: 'manage_custom_fields',
  archive_field: 'manage_custom_fields',
  // WRITING A CUSTOM VALUE INHERITS THE OWNING ENTITY'S CAPABILITY, and this is the whole reason the
  // function form exists for a second verb. A custom field must never be a side door: putting a note
  // on a journal entry has to be exactly as hard as writing the journal entry, or `viewer` gains a
  // write surface by the back way. The answer is a lookup in G00's OP3 registry rather than a policy
  // restated here, so a capability that registers a new entity kind cannot forget to gate its fields.
  set_field_value: (input) => editCapabilityForKind(input.entityKind),
  // THE UNCONDITIONAL MINIMUM, which is the entity kind's READ domain, and the second exemption in
  // this file that the ungated audit found to be false. It read "Saving a private filter is a
  // preference and needs only the read access the caller already has". That sentence assumes the
  // caller HAS read access, and nothing checked it. Measured through `callTool` on 29.07.2026: an
  // actor whose `whoami` reported `isMember:false, capabilities:[]`, refused `list_documents` and
  // refused `list_saved_views` on `read_sales`, nonetheless wrote a `saved_view` row naming
  // `entity_kind='document'` into that workspace and got `ok` back. A stranger cannot read the
  // documents but could store a filter over them in somebody else's tenant.
  //
  // This is `unlock_period`'s shape exactly: declare the minimum the boundary CAN see, and leave the
  // narrower state-dependent gate where the state is. The `shared` half of the old reason was never
  // wrong and is untouched: `assertMayPublish` in `core/customization/views.ts` still refuses
  // `manage_saved_views` for a published view, and the same measurement confirmed it already did.
  // `readCapabilityForKind` is the same lookup `list_saved_views` uses, so saving a filter over a
  // kind is exactly as hard as listing the filters over it, which is the symmetry that was missing.
  create_saved_view: (input) => readCapabilityForKind(input.entityKind),
  // The other two take a `viewId` and never a kind, so the boundary cannot resolve a domain for them:
  // it sees the input and never the database. Their gate is ownership, it is genuinely
  // state-dependent, and `views.ts` enforces it (`row.owner_actor !== ctx.actor` refuses, and a
  // shared view goes through `assertMayPublish`). Measured: a non-member gets `not_found` for a view
  // it does not own, and with `create_saved_view` now gated it can no longer manufacture one.
  update_saved_view: ungated('asserted_in_engine', 'Conditional on ownership: asserted in core/customization/views.ts.'),
  delete_saved_view: ungated('asserted_in_engine', 'Conditional on ownership: asserted in core/customization/views.ts.'),
  // G00's THREE READS, which arrived on `claude/wave-f2-integration` while D50's read gate was being
  // built and were caught here by `assertEveryActionIsGated` refusing to load. They inherit the
  // OWNING ENTITY'S read domain by the same argument that makes `set_field_value` inherit its edit
  // capability: reading the custom fields stored on a journal entry is reading that entry, and a
  // custom field must not be a side door in either direction. `readCapabilityForKind` is the read
  // twin of `editCapabilityForKind`, defined at the top of this file because who may read what is
  // A24 policy rather than G00's registry.
  list_field_defs: (input) => readCapabilityForKind(input.entityKind),
  list_field_values: (input) => readCapabilityForKind(input.entityKind),
  // A saved view is a filter OVER an entity kind, and its rows name that kind's records, so it
  // travels with the kind as well. A role that cannot read documents has no use for, and no claim
  // on, the workspace's saved document filters.
  list_saved_views: (input) => readCapabilityForKind(input.entityKind),

  // --- G01, automation rules -------------------------------------------------------------------
  // Defining or reshaping an automation is ADMINISTRATION of the sharpest kind in this product: it
  // decides what the ledger does when nobody is watching. Its own capability, held by nobody by
  // default, and NOT granted to any built-in bundle.
  create_automation_rule: 'manage_automations',
  update_automation_rule: 'manage_automations',
  archive_automation_rule: 'manage_automations',
  // STARTING a rule is administration; STOPPING one is not, and this asymmetry is the safety design
  // rather than an inconsistency. Enabling requires the capability because it puts a rule back to
  // writing unattended.
  enable_automation_rule: 'manage_automations',
  // THE STOP BUTTON IS THE ONE CONTROL WITH NO GATE, and the reason is the shape of the two failure
  // modes rather than a judgement about who deserves it. Disabling a rule only ever PREVENTS a write
  // and can never cause one, so an over-open stop button is a nuisance, while an over-closed one is a
  // rule writing to an append-only ledger that the person watching it cannot halt. Because enabling
  // IS gated, the low-privilege direction is always the safe one: anyone may stop a rule, only an
  // administrator may start it, and nobody can use this to turn automation on.
  disable_automation_rule: ungated(
    'prevents_only',
    'A stop button that requires a permission is not a stop button. Disabling only ever prevents a write; re-enabling requires manage_automations, so the ungated direction is always the safe one (G01 section 4).',
  ),
  // THE TICK, AND THE ONE EXEMPTION IN THIS FILE THAT WAS MEASURABLY FALSE. It read:
  //
  //   "Asks 'is anything due' and fires only what already was. Each firing is separately gated
  //    against its own rule author, so the tick itself confers nothing."
  //
  // The second sentence is not an argument for exempting the TICK. A firing runs as the RULE'S
  // AUTHOR, so "separately gated" gates the author and says nothing at all about the caller; and
  // "fires only what already was" was false, because `asOf` came from the caller, so "already due"
  // was whatever the caller said. Measured on 29.07.2026 through `callTool`: an actor whose `whoami`
  // reported `isMember:false, capabilities:[]`, refused `post_entry` and refused
  // `list_automation_rules`, drove FIVE journal entries into a workspace it held nothing in, one per
  // tick, by walking `asOf` forward a day at a time. Each call minted a distinct `event_ref`, so
  // neither the UNIQUE index nor the derived idempotency key stopped it.
  //
  // `manage_automations`, AND THE ROUTE TO THAT ANSWER IS WORTH RECORDING, because the obvious
  // alternative is measurably wrong. `read_automations` looks like the natural fit ("is anything
  // due" is the question `list_automation_rules` answers statically) and it answers the old comment's
  // real fear, that a locked-down workspace could no longer tick, since every built-in holds it. It
  // was tried and `test/access/permission-boundary.test.mjs` refuted it in one run: that suite holds
  // EVERY gated write to "a viewer is refused", `viewer` holds `read_automations`, and the tick is a
  // write that causes ledger writes. Gating a write on a read domain would have bought this fix by
  // spending a standing invariant, which is the worse trade.
  //
  // The right answer was already written four lines up in this same block. `enable_automation_rule`
  // is administration "because it puts a rule back to writing unattended", and the tick is the thing
  // that MAKES a schedule rule write unattended: it is the same act, so it takes the same capability.
  // The old comment's objection, that no built-in holds `manage_automations` so the engine would stop
  // working, is overstated: `owner` holds every capability, the Studio's tick lives on the
  // Automations administration surface, and a workspace that wants a headless ticker grants that
  // identity the capability deliberately, which is what a permission system is for.
  //
  // THE CLAMP IS THE OTHER HALF AND NEITHER HALF IS REDUNDANT. `runDueAutomations` now refuses an
  // `asOf` ahead of the injected clock (`core/automation/tick.ts`), so even a member holding this
  // capability cannot manufacture due-ness. A capability decides WHO may ask; the clock decides WHAT
  // is true. Fixing only the first would leave any viewer able to drive the ledger forward at will,
  // and fixing only the second would leave a total stranger able to drive it at the real cadence.
  run_due_automations: 'manage_automations',
  // The repair path for a stuck `running` row (G01 §4, `core/automation/fire.ts`). Same capability as
  // the tick and for the same reason, sharpened: a retry does not merely let time pass, it CAUSES a
  // write the engine had already declined to make. It is safe to offer at all only because the
  // derived idempotency key is deterministic, so a lost invocation that had in fact committed cannot
  // happen twice; it is safe to offer to THIS capability only because whoever holds it could have
  // authored the rule that fired in the first place.
  retry_automation_run: 'manage_automations',

  // --- A25, Treuhänder review & export ---------------------------------------------------------
  // THE THREE REVIEW ACTS take the capability the spec reserved for them from day one: they write
  // review metadata that carries the fiduciary's judgment, and `treuhaender`/`owner` hold it while
  // `bookkeeper` and `agent` do not (sign-off on the books one keeps is self-review, and P8 keeps
  // the agent out of sign-off entirely; `approve_entry` is additionally on G01's denylist).
  comment_entry: 'review',
  flag_entry: 'review',
  approve_entry: 'review',
  // `prepare_period` is DELIBERATELY `post` and not `review`, and the asymmetry is US-A25.5's whole
  // design: the agent readies the period (packet + machine flags) so the human just reviews. The
  // flags it writes are data ABOUT journal entries, so it takes what writing a journal entry takes,
  // the same inheritance rule `files_link` and `set_field_value` apply to a `journal_entry` target.
  // What `review` protects is the JUDGMENT (a sign-off, a dismissal-by-approval), and prepare can
  // express none of it: it can only ever add machine flags and read counts.
  prepare_period: 'post',
  // The coverage read annotates the books, so it reads as the books do: `read_books` is what lets
  // the bookkeeper see what the Treuhänder queried and the viewer see the state of the period.
  review_status: 'read_books',
  // THE EXPORTS ARE READS WITH A WRITE-GRADE CONSEQUENCE: each hands over a file someone outside
  // the workspace will rely on, so each takes `export` (the fiduciary filing right) AND the domain
  // read it reproduces, the `files_get_content` ALL-OF shape: a role that may export figures it
  // cannot read on screen is not a role anyone wants, and `viewer` (which holds the read domains)
  // must not gain a bulk export by the back way beyond the A08 single-statement read it already has.
  export_journal: ['export', 'read_books'],
  export_statements: ['export', 'read_books'],
  export_vat: ['export', 'read_vat'],

  // --- A26, agent bookkeeping ------------------------------------------------------------------
  // The dial and the inbox decisions are the human-oversight surface for the agent, all three gated
  // on `manage_agent_dial` (owner-only by default). `set_agent_dial` arms or disarms unattended
  // execution, and approve/reject ARE the second-actor review that makes draft-and-ask meaningful, so
  // both must be at least as hard to reach as the dial itself (§3: "the dial settings themselves
  // remain human-gated, manage_agent_dial, owner-only by default").
  //
  // `approve_drafted_action` REPLAYS a stored verb as the approver, so it holds an `ActionInvoker` and
  // `assertActionInvokersAreGated` (called in `src/api/agent-actions.ts`) would refuse to load if it
  // were ungated: a real capability here is not optional. RBAC on the replayed verb is re-checked
  // against the approver at run time (P3), so this gate is the door and the underlying verb's own
  // capability is the second lock.
  set_agent_dial: 'manage_agent_dial',
  approve_drafted_action: 'manage_agent_dial',
  reject_drafted_action: 'manage_agent_dial',
  // `agent_prose_delete` erases the conversation record's prose (D90 D-5): governance over the agent
  // surface, so it sits with the dial verbs rather than with the reads it erases beside.
  agent_prose_delete: 'manage_agent_dial',
  // `list_drafted_actions` shows a proposal's full payload (ledger arguments included), so it reads
  // as the books do. A bookkeeper without `manage_agent_dial` still SEES the queue (the design's row
  // 2.5: a pending proposal is a fact about the workspace); only deciding it is owner-gated above.
  list_drafted_actions: 'read_books',
  // `agent_ask` is a WRITE only because it persists the asker's own sentence (D90 D-5); everything
  // it can execute is one of the three A26 read models, so it rides the same `read_books` they do.
  // No drafting, posting or dial write is reachable from it, asserted in test/agent/ask.test.mjs.
  agent_ask: 'read_books',

  // --- A35, agent conversation & oversight ------------------------------------------------------
  // The trace renders every argument of every ledger write an agent made, so reading it IS reading
  // the books: `read_books`, the `get_audit_log` twin. A35 mints no capability of its own.
  list_agent_sessions: 'read_books',
  get_agent_session: 'read_books',
  agent_trust_summary: 'read_books',

  // --- G08, feedback & diagnostics -------------------------------------------------------------
  // All three exemptions are G08's own §3 reasoning, restated here because this is the file where an
  // exemption has to be defended rather than assumed.
  prepare_feedback: ungated(
    'machine_scope',
    'Reporting a bug is not a privilege, and gating it silences the restricted-role user most likely to hit one.',
  ),
  set_diagnostics: ungated('machine_scope', 'Changing your own privacy setting is self-determination, not administration.'),
  clear_diagnostics: ungated(
    'machine_scope',
    'Erasing your own data must never require a permission: an RBAC wall here would defeat revDSG Art. 32 rather than support it.',
  ),

  // --- G10, migration maps and the locale seam ------------------------------------------------
  // Writes AND the three data reads all gate on `manage_import` (spec §2's permission-denied
  // states cover suggest/get/list explicitly): a migration map names how a client's whole chart
  // and tax world will land in the books, so READING one is import-scoped work, not a general
  // bookkeeping read, and the D50 domain rule's answer ("the domain whose writes produce the
  // data") is this capability's own domain, which did not exist before this block.
  migration_set_map: 'manage_import',
  migration_save_map_template: 'manage_import',
  migration_apply_map_template: 'manage_import',
  migration_suggest_map: 'manage_import',
  migration_get_map: 'manage_import',
  migration_list_map_templates: 'manage_import',
  // The two catalog reads describe the SOFTWARE (which formats TILL reads, which locale packs are
  // registered), never workspace data, the G04 §2 US-G04.4 reasoning: both are depsActions with no
  // tenant on the input, so there is nothing to resolve a capability against and nothing to leak.
  migration_list_source_adapters: ungated(
    'pre_workspace',
    'Describes the software (readable source formats and their cleanRoomSource), not any workspace: there is no tenant on the input to resolve a capability against.',
  ),
  migration_list_locale_packs: ungated(
    'pre_workspace',
    'Describes the software (registered locale packs), not any workspace: there is no tenant on the input to resolve a capability against.',
  ),

  // --- G09, the migration harness -------------------------------------------------------------
  // Every verb, WRITES and READS alike, gates on `manage_import` (spec §3: "manage_import gates
  // discovery, planning, scoping, mapping, preview, trial-load and every read"). A plan names how a
  // whole foreign book lands in the ledger, so reading one is import-scoped work, not a general
  // bookkeeping read, and this is the same domain G10's block one section up established. The
  // SECOND capability, `commit_migration`, is deliberately NOT the boundary gate: it is checked in
  // the engine on a MONEY-PATH commit only (a CRUD import needs no human), mirroring how G04 splits
  // manage_data_export from manage_data_restore, so the two are distinct capabilities and the
  // boundary stays legible.
  migration_create_plan: 'manage_import',
  migration_set_scope: 'manage_import',
  migration_trial_load_step: 'manage_import',
  migration_commit_step: 'manage_import',
  migration_record_approval: 'manage_import',
  migration_rollback_step: 'manage_import',
  migration_abandon_plan: 'manage_import',
  // G18 R4: the boundary gate is `manage_import` like every migration verb; the stronger
  // `commit_migration` is asserted INSIDE closePlan (a close acts on books that already went live).
  migration_close_plan: 'manage_import',
  migration_discover_source: 'manage_import',
  migration_get_plan: 'manage_import',
  migration_list_plans: 'manage_import',
  migration_preview_step: 'manage_import',
  migration_readiness: 'manage_import',

  // --- G11 Eröffnungsprüfung -------------------------------------------------------------------
  // Every verb, writes and reads alike, gates on `manage_import` (spec §3: declaring, checking,
  // waiving and exporting all sit inside the import domain G10/G09 established one block up; a
  // check names how a client's whole opening position ties to a foreign book, so READING one is
  // import-scoped work, not a general bookkeeping read). Waiving is deliberately not a stronger
  // capability: the waiver is recorded, surfaced in readiness and carried into the Prüfbericht, so
  // its safety comes from visibility, not from a second gate.
  migration_declare_control_total: 'manage_import',
  migration_check_step: 'manage_import',
  migration_get_check: 'manage_import',
  migration_list_checks: 'manage_import',
  migration_waive_control: 'manage_import',
  migration_export_check: 'manage_import',

  // --- G21 open-items AR/AP migration ---------------------------------------------------------
  // `import_open_items` carries an open receivables/payables position across as origin=migrated
  // documents / vendor bills: a MONEY-PATH commit, so the registry boundary gates it on
  // `commit_migration` (the same right that commits A04's opening entry and every other money-path
  // migration step, spec §3: no new capability), which the engine also asserts. `preview_open_items`
  // computes the control tie-out without writing, import-scoped work like the G09/G11 reads, on
  // `manage_import`.
  preview_open_items: 'manage_import',
  import_open_items: 'commit_migration',

  // --- G12 Testmandant --------------------------------------------------------------------------
  // Creating, reading and diffing a Testmandant, and discarding a trial, gate on `manage_import`
  // like the rest of the import domain (spec §3): a Testmandant is a trial workspace, still import
  // material, not real books. `go_productive` is the exception and gates on BOTH `promote_workspace`
  // AND `commit_migration` (a readonly array is an AND at the boundary): going productive mints real
  // books (the G04 `manage_data_restore` analogy) and commits money-path data (the G09 analogy), so
  // it demands both. The type-to-confirm and the after-any-commit `commit_migration` escalation on
  // discard are STATE-dependent and enforced in-engine, where the database is visible (see the note
  // above on `unlock_period`); the boundary asserts what holding these capabilities guarantees.
  migration_create_testmandant: 'manage_import',
  migration_get_testmandant: 'manage_import',
  migration_diff_testmandant_to_live: 'manage_import',
  go_productive: ['promote_workspace', 'commit_migration'],
  discard_testmandant: 'manage_import',

  // --- G19, the extraction companion core -------------------------------------------------------
  // The two guide reads describe the SOFTWARE (which per-source export guides TILL ships, their
  // tactic ladder and the Datenherausgabe letter), never workspace data: both are depsActions with
  // no tenant on the input, the `migration_list_source_adapters` / `migration_list_locale_packs`
  // reasoning exactly, so there is nothing to resolve a capability against and nothing to leak. The
  // manifest verbs, the two writes AND the read, gate on `manage_import` like the rest of the import
  // domain: an export manifest names how a whole foreign book leaves the old system, so reading one
  // is import-scoped work, not a general bookkeeping read (the G09/G11 reasoning).
  migration_list_extraction_guides: ungated(
    'pre_workspace',
    'Describes the software (the shipped per-source extraction guides and the tactic ladder), not any workspace: there is no tenant on the input to resolve a capability against.',
  ),
  migration_get_extraction_guide: ungated(
    'pre_workspace',
    'Describes the software (one shipped extraction guide, its items, deletion clock and letter template), not any workspace: there is no tenant on the input to resolve a capability against.',
  ),
  migration_set_manifest: 'manage_import',
  migration_set_manifest_item: 'manage_import',
  migration_get_manifest: 'manage_import',

  // --- G20, implementation projects ------------------------------------------------------------
  // The project/task/decision/parallel-run declaration + check writes gate on `manage_implementation`
  // (spec §3), the migration family's own governing right for the cutover. `implementation_signoff_record`
  // is the ONE exception: it rides `commit_migration` (US-G20.5), because signing IS the human half of
  // committing money-path steps, and the engine additionally refuses a non-human actor (P8). Reads:
  // `implementation_project_get` and `implementation_parallel_status` gate on `manage_implementation`
  // (all project reads beyond the roster), while `implementation_project_list` (the roster metadata
  // row) gates on the softer `read_master_data`, so a mandate member can compose the cross-client
  // roster and a caller lacking `manage_implementation` gets a hidden-state metadata row rather than a
  // refusal that drops the mandate from the count (US-G20.4). `implementation_project_close` is
  // confirm-gated and denylisted from automation besides.
  implementation_project_create: 'manage_implementation',
  implementation_project_get: 'manage_implementation',
  implementation_project_list: 'read_master_data',
  implementation_runbook_instantiate: 'manage_implementation',
  implementation_task_set: 'manage_implementation',
  implementation_decision_record: 'manage_implementation',
  implementation_signoff_record: 'commit_migration',
  implementation_parallel_declare: 'manage_implementation',
  implementation_parallel_check: 'manage_implementation',
  implementation_parallel_status: 'manage_implementation',
  implementation_project_close: 'manage_implementation',

  // --- G22, checklists (D127) --------------------------------------------------------------------
  // The five writes gate on `manage_checklists`, granted to the built-in bundles that hold `post`: a
  // checklist moves no money, and walking the MWST period IS bookkeeping. The three reads ride
  // `read_books` (the `month_end_checklist` domain: a run's state is a reading of the books). Item 8
  // of the MWST template acts through `vat_mark_filed`, which keeps its own `vat_file` gate here: the
  // checklist never wraps the statutory mark.
  checklist_templates: 'read_books',
  checklist_start: 'manage_checklists',
  checklist_get: 'read_books',
  checklist_list: 'read_books',
  checklist_item_complete: 'manage_checklists',
  checklist_item_skip: 'manage_checklists',
  checklist_item_reopen: 'manage_checklists',
  checklist_abandon: 'manage_checklists',

  // --- G03, onboarding & the demo workspace -----------------------------------------------------
  // The wizard pair rides the register the wrapped A00 steps already live in: the resume pointer's
  // read is the `get_company_profile` domain (`read_master_data`), its write the `set_fiscal_config`
  // domain (`manage_settings`), because the person walking the setup wizard IS the person holding
  // the setup capabilities, and a resume pointer must never be easier or harder to touch than the
  // steps it remembers. `discard_demo_workspace` demands `manage_settings` on the demo (workspace
  // lifecycle, the `archive_workspace` precedent), but the check runs IN THE ENGINE, not here: the
  // verb is a depsAction because its success deletes its own tenant, so the boundary's
  // workspace_not_found check would break the §H-IDEMPOTENT replay of a completed discard.
  // `core/onboarding/demo.ts` asserts the gate through the same `capabilityPort` this boundary
  // wires, after the same existence check, so holding the capability guarantees the same thing
  // either way. `create_demo_workspace` is with the pre-workspace exemptions further up.
  get_onboarding_progress: 'read_master_data',
  advance_onboarding_step: 'manage_settings',
  discard_demo_workspace: ungated(
    'asserted_in_engine',
    'Demands manage_settings, asserted in core/onboarding/demo.ts through the same capabilityPort: the verb deletes its own tenant, so the boundary cannot both resolve the workspace and honour the replay of a completed discard.',
  ),
  // --- G04 data freedom -------------------------------------------------------------------------
  // The four workspace-scoped artifact verbs gate on `manage_data_export`, WRITES and the LIST read
  // alike: a backup or export puts the WHOLE workspace into a portable file, so reading the backup
  // history is export-scoped governance work, not a general bookkeeping read (the `manage_import`
  // reasoning one family over: "reading one is import-scoped work"). `delete_backup` is housekeeping
  // over that same registry, so it rides the same gate rather than a stronger one (a backup file
  // carries no legal retention lock of its own, spec §6b).
  export_workspace: 'manage_data_export',
  create_backup: 'manage_data_export',
  list_backups: 'manage_data_export',
  delete_backup: 'manage_data_export',
  // The three PRE-WORKSPACE verbs. `verify_backup` inspects an arbitrary file (a deliberate exception
  // to read-scoping, stated once in the spec: there is no tenant on the input). `get_api_catalog`
  // describes the software's data-access contract, not any workspace's data (US-G04.4: no RBAC gate
  // by design). `restore_backup` MINTS the tenant, so like `create_workspace`/`onboard_client` there
  // is no workspace yet to resolve a capability against; its fences are the never-overwrite rule, the
  // P8 `confirmed` gate and the pre-commit invariant re-check inside the engine (spec §0a.4). The
  // reserved name `manage_data_restore` records the intent without pretending to gate here.
  verify_backup: ungated('pre_workspace', 'Inspects an ARBITRARY file, not this workspace`s data: there is no tenant on the input to resolve a capability against.'),
  list_restorable_backups: ungated('pre_workspace', 'Lists the bundle manifests in THIS MACHINE`s backup directory (machine state, the same posture as delivery_status), for the first-run restore door before any workspace exists: there is no tenant to resolve a capability against, and the read opens no database and verifies nothing.'),
  get_api_catalog: ungated('pre_workspace', 'Describes the software`s data-access contract (every tool + REST route), not any workspace`s data, so any authenticated actor may read it (US-G04.4).'),
  restore_backup: ungated('pre_workspace', 'Mints the tenant the capability would be resolved in (the create_workspace shape). Fenced instead by never-overwriting an existing workspace, the P8 confirmed gate, and the pre-commit balance + referential-integrity re-check.'),

  // --- M02, the §I sync/publish contract -------------------------------------------------------
  // The two publish dials gate on `manage_sync` (owner): flipping egress on/off for the whole workspace
  // is a governing consent act, not a bookkeeping one, and both are also on G01's NOT_AUTOMATABLE
  // denylist. `get_sync_contract` reports the publish POSTURE the Settings panel and the E07 trust line
  // render, so it rides `read_master_data` (any member may see whether their books are publishing), the
  // settings-read twin. The three RAW stream reads gate on `sync.read`: the publish stream is an
  // integration surface a plain member does not see by default, so `read_master_data` is deliberately
  // too soft for them and `sync.read` is the narrow capability the managed tier's role holds.
  sync_publish_enable: 'manage_sync',
  sync_publish_disable: 'manage_sync',
  get_sync_contract: 'read_master_data',
  sync_stream_read: 'sync.read',
  sync_artifact_read: 'sync.read',
  sync_stream_status: 'sync.read',

  // --- M03, deployment journeys ----------------------------------------------------------------
  // The move-checklist resume pointer rides the G03 onboarding-pointer registers exactly (spec
  // §3.1): the read is any member's (`read_master_data`, the `get_onboarding_progress` twin), the
  // write gates on `manage_settings` (the A23/G03 workspace-lifecycle precedent), because the
  // person driving a move IS the person holding the settings capabilities, and a resume pointer
  // must never be easier or harder to touch than the journey it remembers.
  get_move_state: 'read_master_data',
  advance_move_step: 'manage_settings',

  // --- E03, tasks & reminders ------------------------------------------------------------------
  // Four of the five writes gate on `tasks.write`, E03's own name (spec §5): a task never posts,
  // so no money capability applies, and riding `manage_master_data` would make chasing a follow-up
  // require the contacts register. `tasks_complete` is the exception BY DESIGN (US-E03.2): the
  // rule is "`tasks.write` OR being the assignee", the boundary sees the input and never the row's
  // assignee, so it is the `update_saved_view` shape: ungated here, asserted in `completeTask`,
  // which refuses any actor holding neither leg with the port's own `permission_denied`.
  tasks_create: 'tasks.write',
  tasks_update: 'tasks.write',
  tasks_complete: ungated(
    'asserted_in_engine',
    'Conditional on the row: tasks.write OR being the assignee, asserted in core/tasks/tasks.ts (completeTask), the update_saved_view shape.',
  ),
  tasks_snooze: 'tasks.write',
  tasks_cancel: 'tasks.write',
  // The two reads take E03's read domain (D50 rule: a read belongs to the domain whose writes
  // produce the data, and only E03's writes produce task rows). Deliberately NOT in the viewer
  // anchor: the queue is operational work, not the books (see `capabilities.ts`).
  tasks_list: 'tasks.read',
  tasks_reminders_due: 'tasks.read',

  // --- G06, notifications & inbox --------------------------------------------------------------
  // `notifications_deliver` gates on `manage_automations` (spec §5): it is the OP8 action a G01
  // rule fires, so a manual or agent call is functionally a rule-firing simulation, and it writes
  // into ANOTHER user's inbox, which no self-scope can admit. Everything else is self-scoped
  // STRUCTURALLY (an inbox is not a shared mailbox, US-G06.2): the engine binds every query and
  // mutation to the caller's own `user_id` (a foreign `userId` answers `forbidden`, a foreign
  // notification id answers `notification_not_found`), and the admin path (preferences/digest for
  // another user) asserts `manage_members` LIVE through the capability port. A role capability
  // here would let an admin grant a cross-user inbox read that the product deliberately does not
  // have, which is why these are `ungated(asserted_in_engine)` and not a `notifications.*` pair.
  notifications_deliver: 'manage_automations',
  notifications_list: ungated(
    'asserted_in_engine',
    'Self-scoped structurally: the query binds user_id to the caller (forbidden on a foreign userId), asserted in core/notifications/notifications.ts (listInbox).',
  ),
  notifications_mark_read: ungated(
    'asserted_in_engine',
    'Self-scoped structurally: the row lookup binds user_id to the caller (a foreign item answers notification_not_found), asserted in core/notifications/notifications.ts (markRead).',
  ),
  notifications_mark_all_read: ungated(
    'asserted_in_engine',
    'Self-scoped structurally: userId must be the caller (forbidden otherwise), asserted in core/notifications/notifications.ts (markAllRead).',
  ),
  notifications_archive: ungated(
    'asserted_in_engine',
    'Self-scoped structurally: the row lookup binds user_id to the caller (a foreign item answers notification_not_found), asserted in core/notifications/notifications.ts (archiveNotification).',
  ),
  notifications_set_preference: ungated(
    'asserted_in_engine',
    'Own preferences need only membership; another user`s assert manage_members in core/notifications/notifications.ts (setPreference), the tasks_complete shape.',
  ),
  notifications_list_preferences: ungated(
    'asserted_in_engine',
    'Own preferences need only membership; another user`s assert manage_members in core/notifications/notifications.ts (listPreferences).',
  ),
  notifications_run_digest: ungated(
    'asserted_in_engine',
    'Own digest needs only membership; another user`s asserts manage_members in core/notifications/notifications.ts (runDigest). Renders a local artifact and never transmits (OP4).',
  ),

  // --- G02, plugin architecture & extension registry -------------------------------------------
  // The five WRITES gate on `manage_plugins` (spec §5): installing, enabling, disabling,
  // uninstalling or refreshing the compat of third-party code that reaches the ledger through the
  // agent transport is the single most consequential admin act in the product, owner-only by
  // default. The five READS ride `read_master_data` (D50 rule: a plugin is workspace configuration,
  // the `list_document_templates -> read_master_data` twin), so every member incl. `viewer` may
  // browse the Erweiterungen panel read-only while only an owner may install (US-G02.1
  // permission-denied: the list stays visible, the Installieren control is pre-disabled).
  // `preview_plugin_install` inherits the domain of the write it previews (D50), which is
  // `install_plugin`, so it is `manage_plugins`: parsing an untrusted third-party manifest to review
  // the scopes it wants is the install decision, gated to those who can install.
  preview_plugin_install: 'manage_plugins',
  install_plugin: 'manage_plugins',
  enable_plugin: 'manage_plugins',
  disable_plugin: 'manage_plugins',
  uninstall_plugin: 'manage_plugins',
  refresh_plugin_compat: 'manage_plugins',
  list_plugins: 'read_master_data',
  get_plugin: 'read_master_data',
  search_plugin_registry: 'read_master_data',
  get_plugin_registry_entry: 'read_master_data',

  // --- E01, e-signature ------------------------------------------------------------------------
  // Five of the six writes gate on `sign.write`, E01's own name (spec §5): a sign request never
  // posts, so no money capability applies, and riding `manage_files` would make chasing a
  // signature require version/retention/delete power over every file. `sign_requests_send` is the
  // ONE outbound verb and takes BOTH names (the `files_set_retention` ALL-OF shape): `sign.send`
  // is the mandate to disclose signer data to a provider, split from `sign.write` exactly as A11
  // splits `send` from `issue`, so a Treuhänder may prepare without transmitting (US-E01.2).
  sign_requests_create: 'sign.write',
  sign_requests_send: ['sign.write', 'sign.send'],
  sign_requests_record_event: 'sign.write',
  sign_requests_complete: 'sign.write',
  sign_requests_withdraw: 'sign.write',
  sign_requests_delete_draft: 'sign.write',
  // The two reads take the filing read domain (D50 rule, by delegation): a sign request annotates
  // an E00 filing, so reading one is reading the filing register, the same answer `files_search`
  // and `files_list_linked` give. No `sign.read` name is minted (see `capabilities.ts`).
  sign_requests_get: 'read_master_data',
  sign_requests_list: 'read_master_data',

  // --- F02, customer portal --------------------------------------------------------------------
  // The three operator writes gate on `portal.manage`, F02's own name (spec §5): a grant exposes a
  // customer's own records outside the device, a governing act over the relationship. `portal_grant_send`
  // takes the SAME single capability, not a second one: the outbound half is P8's confirm gate INSIDE
  // the verb (the OSS core wires no transport), not an A24 `.send` split like E01's. The list read
  // takes `read_master_data` (the panel lives on the C00 contact detail, so seeing a customer's grants
  // is part of seeing the customer; it is also the read twin a custom field on a grant inherits).
  portal_grant_create: 'portal.manage',
  portal_grant_send: 'portal.manage',
  portal_grant_revoke: 'portal.manage',
  portal_grant_list: 'read_master_data',
  // The TWO token-authenticated verbs are pre-workspace `depsAction`s (the `accept_invite` shape): the
  // grant binds the workspace (§H-TENANT) and the single-use token hash IS the authorisation, so there
  // is no tenant session to resolve a capability against. `portal_resolve` triple-fences every read
  // inside the verb; `portal_quote_accept` fence-checks then delegates to C02's own `issue`-gated
  // acceptance path via the engine (never through the dispatch, so no capability is laundered).
  portal_resolve: ungated('pre_workspace', 'Token-authenticated: the grant binds the workspace and the single-use token hash IS the authorisation. Pre-workspace, so there is no tenant session to resolve a capability against; the resolver triple-fences every read itself.'),
  portal_quote_accept: ungated('pre_workspace', 'Token-authenticated: the grant binds the workspace and the token IS the authorisation. Pre-workspace; it fence-checks scope + contact, then delegates to C02\'s real accept.'),

  // --- F03, vendor portal ----------------------------------------------------------------------
  // The grant lifecycle and the remittance-advice write gate on `portal.manage`, the SAME F02 name
  // (spec §5, reconciled: the draft said `portal.write`, which F02 never minted): a vendor grant
  // exposes a supplier's own POs and payment status outside the device, and a remittance advice files
  // a derived Beleg about a supplier payment, both governing acts over the relationship. Unlike F02's
  // token reads, F03's two scoped reads are WORKSPACE-scoped `ctxAction`s (the token is a SECOND fence
  // WITHIN the workspace, spec §5 reconciled), so they gate on `read_master_data` like `portal_grant_list`:
  // seeing what a supplier's grant exposes is part of seeing the supplier, and it is the read twin a
  // custom field on the grant/advice inherits. The list read takes `read_master_data` for the same reason.
  vendor_portal_grant: 'portal.manage',
  vendor_portal_revoke: 'portal.manage',
  vendor_portal_remittance_create: 'portal.manage',
  vendor_portal_grants_list: 'read_master_data',
  vendor_portal_pos: 'read_master_data',
  vendor_portal_remittances: 'read_master_data',

  // --- B01, time tracking ----------------------------------------------------------------------
  // The entry lifecycle gates on `time.write`, B01's own name (the E03 shape): a time entry never
  // posts, so no money capability applies, and riding `manage_master_data` would make a
  // freelancer's agent need the contacts register to log an hour. The SIGN-OFF pair takes
  // `time.approve` alone (the A25 `review` shape: what it protects is the judgment, and an
  // approver role need not hold the capture right). The rate cards are billing MASTER DATA and
  // gate exactly as D00's price lists do; their reads take the master-data read twin. The two
  // time reads take B01's own read domain (D50 rule: only B01's writes produce time rows), and
  // `time_resolve_rate` reads the rate REGISTER through the timesheet surface, priced facts about
  // hours, so it stays on `time.read` beside the list it prices.
  time_start: 'time.write',
  time_stop: 'time.write',
  time_log: 'time.write',
  time_update: 'time.write',
  time_delete: 'time.write',
  time_submit: 'time.write',
  time_approve: 'time.approve',
  time_lock: 'time.approve',
  time_list: 'time.read',
  time_resolve_rate: 'time.read',
  rate_card_upsert: 'manage_master_data',
  rate_card_end: 'manage_master_data',
  rate_card_list: 'read_master_data',

  // --- B02, time -> billing --------------------------------------------------------------------
  // The two WRITES gate on `billing.generate`, B02's own name (spec §2 US-B02.5). Generation is a
  // single-capability gate and NOT an ALL-OF with `issue`: B02's own engine calls `createDocument`
  // directly (the boundary check keys on the TOOL name, and the internal engine call trips no second
  // assert), and it POSTS NOTHING (a draft), so no `post` or `issue` capability fires beneath it.
  // `billing_release_time` takes the same write right (spec §2: "requires the same write right");
  // it only reverts a draft's entries and posts nothing either. The two READS gate on `billing.read`
  // (D50 rule: only B02's own reads produce the unbilled/WIP model), the read twin held by all three
  // built-ins so a Treuhänder can read WIP without the sales-surface `billing.generate`.
  billing_generate_invoice: 'billing.generate',
  billing_release_time: 'billing.generate',
  billing_unbilled_preview: 'billing.read',
  billing_wip_report: 'billing.read',

  // --- B04, retainers & mandates ---------------------------------------------------------------
  // Every WRITE gates on `retainer.manage`, B04's own name (spec §5): create/update/close the mandate,
  // and generate/run-due the periodic Pauschale invoice. Generation is a single-capability gate and
  // NOT an ALL-OF with `issue`: B04's engine calls `createDocument` directly (the boundary keys on the
  // TOOL name, the internal call trips no second assert) and POSTS NOTHING (an A11 draft), so no
  // `post`/`issue` fires beneath it, the `billing_generate_invoice` reasoning one register over. The
  // two READS gate on `billing.read` (D50 rule: a retainer is a billing surface, and its reads are
  // produced by its own billing-adjacent writes), the read twin held by all three built-ins.
  retainer_create: 'retainer.manage',
  retainer_update: 'retainer.manage',
  retainer_close: 'retainer.manage',
  retainer_generate_invoice: 'retainer.manage',
  retainer_run_due: 'retainer.manage',
  retainer_burndown: 'billing.read',
  retainer_list: 'billing.read',

  // --- B03, job costing / project P&L ----------------------------------------------------------
  // Four reads, no writes (pure P5). All four take `costing.read`, B03's own read domain,
  // deliberately SEPARATE from B00's membership-gated project reads (D50 rule: only B03's own
  // computation produces the margin model, and the cost basis is where employee pay-rate data
  // will surface once the OP1 cost-rate column lands, the revDSG data-minimization gate of
  // spec B03 §3). Project MASTER data stays readable without it; only the profitability layer gates.
  costing_project_pl: 'costing.read',
  costing_pl_list: 'costing.read',
  costing_budget_vs_actual: 'costing.read',
  costing_drilldown: 'costing.read',

  // --- F00, dashboards & KPIs ------------------------------------------------------------------
  // Two reads, no writes (pure P5), and the gate is PER TILE, not per verb, which is why both are
  // `asserted_in_engine` rather than a domain name. The dashboard spans SIX read domains at once
  // (`read_books`, `read_sales`, `read_vat`, `read_master_data`, `time.read`, `costing.read`), and
  // any single boundary capability would lie in one of two directions: gating on a financial domain
  // would deny an operations-only role (`time.read` alone) the utilisation tile its role permits,
  // and gating on any one loose domain would let a role without `read_books` receive revenue and
  // cash figures its own source verbs would refuse. So `src/core/dashboards/dashboards.ts` asserts
  // each tile's registry capability set via `ctx.capabilities` before that tile's fan-out: the
  // overview OMITS refused tiles server-side (`omitted:[{tile, error:'permission_denied'}]`, the
  // honest shape agents can read), and `dashboard_tile` refuses outright. A caller holding NO read
  // domain gets an all-omitted, zero-figure response: the verb discloses nothing the caller's own
  // source verbs would not answer.
  dashboard_overview: ungated(
    'asserted_in_engine',
    'Per-tile RBAC: each tile asserts its source verbs’ own read gates in the engine and is omitted server-side when refused; no single boundary capability can state a six-domain rule.',
  ),
  dashboard_tile: ungated(
    'asserted_in_engine',
    'Per-tile RBAC: the engine asserts the requested tile’s own source-verb gates and answers permission_denied outright when the caller lacks one.',
  ),

  // --- G15, the attention hub ------------------------------------------------------------------
  // Two reads, no writes (pure P5), and the gate is PER QUEUE, not per verb, exactly as F00's
  // dashboards are per tile. The hub composes several module work queues, each behind its own read
  // domain (today read_sales for both A21 and A15; more as providers register), so any single
  // boundary capability would lie in one of two directions: gating on one domain would deny a role a
  // queue it may read, and gating on the loosest would leak a queue a role may not. So the engine
  // filters each provider by `ctx.capabilities.assert(readCapability)` before composing: a denied
  // queue is ABSENT from the payload (no count, no row), and an actor holding no provider's read gets
  // { visibleQueues:0, total:null }. Inventing a `read_attention` capability would create a right
  // grantable while every underlying right is denied (a padlock onto an empty room), so there is none.
  attention_summary: ungated(
    'asserted_in_engine',
    'Per-queue RBAC: the engine filters each provider by its own read capability before composing; a denied queue is omitted from queues[] and top[], and no single boundary capability can state the union rule.',
  ),
  attention_list: ungated(
    'asserted_in_engine',
    'Per-queue RBAC: attention_list applies the same per-provider read filter as attention_summary before paging; a denied queue contributes no items and no fixed boundary capability can state the union rule.',
  ),

  // --- F01, report builder ---------------------------------------------------------------------
  // Writes gate on `reports.write` (building/editing/scheduling), except `reports_run` on
  // `reports.run` (US-F01.4: a role may run existing reports without building new ones). The metadata
  // reads gate on `reports.read`. `reports_preview` and `reports_run` ADDITIONALLY assert the composed
  // source's own read gates in the engine (see `assertSourceReadable` in core/reportbuilder/reports.ts),
  // so a report never reads past the caller's own A24 domains: the F00 dashboards posture. `reports_run`
  // therefore holds `reports.run` at the boundary AND asserts the source read gate live per run, which
  // is the input-dependent second gate this file's `unlock_period` note describes, not an unconditional
  // one, so it is declared as the single boundary capability here and refuses with the source's own
  // capability at run time.
  reports_save: 'reports.write',
  reports_update: 'reports.write',
  reports_duplicate: 'reports.write',
  reports_delete: 'reports.write',
  reports_schedule: 'reports.write',
  reports_run: 'reports.run',
  reports_sources: 'reports.read',
  reports_list: 'reports.read',
  reports_runs: 'reports.read',
  // `reports_preview` computes a source read model like the dashboards do, so its RBAC is the source's,
  // asserted in the engine; a fixed F01 read capability at the boundary would either deny a caller the
  // preview of a source it can read or leak one it cannot.
  reports_preview: ungated(
    'asserted_in_engine',
    'Per-source RBAC: reports_preview computes a REPORT_SOURCES read model and the engine asserts that source’s own read gates before computing; no fixed boundary capability can state the per-source rule.',
  ),

  // --- C01, leads & deals ----------------------------------------------------------------------
  // Every write gates on `deals.write`, C01's own name (spec §5): a deal never posts, so no money
  // capability applies, and riding `manage_master_data` would make working the funnel require the
  // chart-adjacent registers (the E03 argument one register over). The two verbs that DELEGATE
  // re-check the delegated verb's own gate live through the dispatch invoker (`deals_to_quote`
  // reaches the quote verb's `issue`, `deals_log_activity`'s reminder half reaches `tasks_create`'s
  // `tasks.write`), so neither name here is ever the only fence on what the delegation mints.
  deals_create: 'deals.write',
  deals_update: 'deals.write',
  deals_move: 'deals.write',
  deals_mark: 'deals.write',
  deals_log_activity: 'deals.write',
  deals_to_quote: 'deals.write',
  pipelines_upsert: 'deals.write',
  pipeline_stages_upsert: 'deals.write',
  // The board read takes C01's read domain (D50 rule: a read belongs to the domain whose writes
  // produce the data, and only C01's writes produce deal rows). Deliberately NOT in the viewer
  // anchor: the funnel is relationship work, not the books (see `capabilities.ts`).
  deals_list: 'deals.read',

  // --- C02, quotes / proposals -----------------------------------------------------------------
  // A quote is an A10 document rider, so its writes take the SAME `issue` capability A10's own
  // `create_document`/`convert_document` and A11's `issue_invoice` take: a quote is as hard to raise
  // as any other document, and `deals_to_quote`'s delegation re-checks this exact gate live. `send`
  // for `quotes_send` mirrors A11's `send_invoice` and `transition_document`'s `to==='sent'` branch:
  // it is the P8 outbound act (issuing a quote posts NOTHING, so no `issue`-only privilege is lost by
  // fusing the two-hop). `quotes_convert` on `issue` covers the target type's create right too, since
  // both `order` and `invoice` create on `issue`. The token form of `quotes_accept` is still gated:
  // A24 covers every verb, and the token is the second fence (a valid single-use hash) on top of it.
  // The two reads take `read_sales`, the document read domain (D50).
  quotes_create: 'issue',
  quotes_update: 'issue',
  quotes_send: 'send',
  quotes_accept: 'issue',
  quotes_decline: 'issue',
  quotes_expire_sweep: 'issue',
  quotes_revise: 'issue',
  quotes_convert: 'issue',
  quotes_get: 'read_sales',
  quotes_list: 'read_sales',

  // --- D03 sales orders & delivery notes --------------------------------------------------------
  // The eight writes gate on `issue`, the sales-document write capability C02 quotes and A11 invoices
  // already use: a sales order is the operational sibling of a quote, and `sales_order_invoice`
  // delegates to A10 createDocument, whose own create right is `issue`, so nothing is laundered.
  // `delivery_note_issue` additionally trips D01's `manage_master_data` assertion inside stock.move
  // (shipping touches inventory), which is the second, engine-level fence. The three reads take
  // `read_sales`, the document read domain (D50). No verb here is UNGATED.
  sales_order_create: 'issue',
  sales_order_from_quote: 'issue',
  sales_order_confirm: 'issue',
  sales_order_cancel: 'issue',
  sales_order_invoice: 'issue',
  delivery_note_create: 'issue',
  delivery_note_issue: 'issue',
  delivery_note_render: 'issue',
  sales_order_list: 'read_sales',
  sales_order_get: 'read_sales',
  sales_order_backorders: 'read_sales',

  // --- D02 purchasing (PO -> goods receipt -> 3-way match, supplier prices) ----------------------
  // The eight writes gate on `manage_master_data`, NOT `post`: D02 posts nothing (P3, the whole
  // financial effect is A17->A02 on the vendor bill), so `post` would overstate its authority, and
  // `issue` is the sales-document write, wrong side of the ledger. `manage_master_data` is the honest
  // fit and the same capability D01's `stock_move` gates on, so `receipt_record` carries one coherent
  // gate: it additionally trips D01's own `manage_master_data` assertion inside stock.move (receiving
  // touches inventory). `match_bill` with `override:true` additionally asserts `post` INSIDE the engine
  // (a variance override on Vorsteuer-bearing goods is a money-authority judgment); `match_bill` is
  // also denylisted from automation (tripwire #3). The four reads take `read_master_data`, the domain
  // twin `manage_master_data` resolves to. No verb here is UNGATED.
  po_upsert: 'manage_master_data',
  po_send: 'manage_master_data',
  receipt_record: 'manage_master_data',
  match_bill: 'manage_master_data',
  po_close_short: 'manage_master_data',
  po_cancel: 'manage_master_data',
  po_revise: 'manage_master_data',
  supplier_price_upsert: 'manage_master_data',
  po_list: 'read_master_data',
  po_get: 'read_master_data',
  po_open_lines: 'read_master_data',
  supplier_price_list: 'read_master_data',

  // --- I01 Advanced Purchase Order (OP14 versioning + amendment) --------------------------------
  // I01 layers controlled versioning over the live D02 PO. Every WRITE gates on `manage_master_data`,
  // the same capability the whole D02 purchasing surface uses (`po_upsert` and its siblings above), so
  // a role that may edit a PO may amend it; the reads ride `read_master_data`. `po_amendment_apply` is
  // the outward-claim edge: it re-renders the P8 outbound artifact (transmitted:false) and, denied the
  // capability, writes zero rows and mints no artifact. NOTHING here posts (P3).
  po_amendment_start: 'manage_master_data',
  po_amendment_update_lines: 'manage_master_data',
  po_amendment_submit: 'manage_master_data',
  po_amendment_apply: 'manage_master_data',
  po_amendment_cancel: 'manage_master_data',
  po_amendment_reject: 'manage_master_data',
  po_version_list: 'read_master_data',
  po_version_get: 'read_master_data',
  po_version_diff: 'read_master_data',
  po_amendment_preview: 'read_master_data',

  // --- E02 HR-lite (employees, absences, expense claims) ----------------------------------------
  // The roster and absence WRITES gate on `hr.manage`. `hr_employee_upsert` additionally asserts
  // `hr.sensitive` IN-ENGINE when, and only when, the input carries an AHV number: that gate is
  // input-dependent, so it cannot live at the boundary (the `unlock_period` shape, which declares its
  // unconditional minimum `manage_periods` and asserts the stricter `unlock_period` in-engine on the
  // state that needs it). The claim DRAFTING writes gate on `spesen.submit`. `expense_claim_approve`
  // POSTS the reimbursement via A02 `postEntry` (which asserts `post` for every caller that reaches
  // it), so it declares the ALL-OF `['spesen.approve','post']`, the `record_payment` shape: the
  // review right AND the posting right, both honest. `expense_claim_reimburse` PAYS via A14
  // `recordPayment` (which asserts `post`) as an outgoing settlement, so it declares
  // `['spesen.approve','pay','post']`, the settlement half named beside the review right. `reject`
  // shares the review right (`spesen.approve`). Every read gates on `hr.read`, the personnel domain,
  // and the list/get reads self-scope in-engine to the caller's own rows unless they also hold
  // `hr.manage` (absences, all claims) or `spesen.approve` (the approval queue).
  hr_employee_upsert: 'hr.manage',
  hr_absence_record: 'hr.manage',
  hr_absence_cancel: 'hr.manage',
  expense_claim_create: 'spesen.submit',
  expense_line_upsert: 'spesen.submit',
  expense_claim_submit: 'spesen.submit',
  expense_claim_approve: ['spesen.approve', 'post'],
  expense_claim_reject: 'spesen.approve',
  expense_claim_reimburse: ['spesen.approve', 'pay', 'post'],
  hr_employee_get: 'hr.read',
  hr_employee_list: 'hr.read',
  hr_absence_list: 'hr.read',
  expense_claim_list: 'hr.read',
  expense_claim_get: 'hr.read',

  // --- A34 payroll hand-off ---------------------------------------------------------------------
  // The export gates on `hr.manage` at the boundary (the widest employee-master read); `hr.sensitive`
  // is asserted IN-ENGINE only to DECIDE AHV inclusion, never to demand it, so an actor with
  // `hr.manage` but not `hr.sensitive` still exports (without AHV, and the artifact says so). That is
  // the `hr_employee_upsert` shape one family over: the boundary declares the unconditional minimum,
  // the engine asserts the conditional right. `wage_journal_post` posts through A02, which self-asserts
  // `post`, so `post` is the boundary right too. `list_payroll_handoffs` is a personnel-data read.
  payroll_handoff_export: 'hr.manage',
  wage_journal_post: 'post',
  list_payroll_handoffs: 'hr.read',

  // --- E04 local mail store ---------------------------------------------------------------------
  // `mail_connect` and `mail_draft_write` gate on `mail.write` (pointing TILL at Art. 321
  // correspondence, and putting words into the practitioner's Drafts folder, are both governing
  // acts over the correspondence). `mail_reindex` is a WRITE that gates on the READ capability,
  // per the spec's own US-E04.2: the index is DERIVED state, so re-deriving it discloses nothing
  // the holder could not already read through `mail_thread_get`, and demanding `mail.write` for it
  // would force the read-only agent loop (poll, read, summarise) to hold the draft-writing right.
  // The four reads are the correspondence read domain (`mail.read`, deliberately absent from
  // `READ_CAPABILITIES`: a viewer of the books has no claim on confidential mail).
  mail_connect: 'mail.write',
  mail_reindex: 'mail.read',
  mail_draft_write: 'mail.write',
  mail_accounts_list: 'mail.read',
  mail_threads_list: 'mail.read',
  mail_thread_get: 'mail.read',
  mail_drafts_list: 'mail.read',

  // --- E05 voice profile + OP6 local runtime ----------------------------------------------------
  // `voice_build` and `runtime_select` gate on `voice.write` (learning a voice points the local
  // model at Art. 321 material; selecting the model changes how every draft is produced). The five
  // reads are the voice read domain (`voice.read`, the `mail.read` shape and deliberately absent
  // from `READ_CAPABILITIES`): `voice_retrieve` hands back exemplar BODIES read from the mail
  // store, so it is exactly as sensitive as `mail_thread_get`, and the status/catalog reads sit in
  // the same domain because what model runs over confidential mail is part of the same story.
  voice_build: 'voice.write',
  runtime_select: 'voice.write',
  voice_profile_get: 'voice.read',
  voice_profiles_list: 'voice.read',
  voice_retrieve: 'voice.read',
  runtime_status: 'voice.read',
  runtime_catalog: 'voice.read',

  // --- E06 ledger-grounded drafts ---------------------------------------------------------------
  // Both writes gate on `draft.write` (a single-capability gate for the composed act, the
  // `billing_generate_invoice` reasoning: generating a draft is the unit a role is granted).
  // Grounding a draft in the books ADDITIONALLY asserts `read_sales` in-engine at generation time
  // (spec US-E06.2: someone who may not see the books may not launder them through a draft), so
  // the registry gate here is deliberately not an ALL-OF: an actor without `read_sales` still
  // generates, ungrounded. `draft_list` is correspondence metadata plus the draft body read from
  // the same store `mail_thread_get` reads, so it rides `mail.read`, exactly as sensitive.
  draft_generate: 'draft.write',
  draft_regenerate: 'draft.write',
  draft_list: 'mail.read',

  // --- E07 the offline proof --------------------------------------------------------------------
  // Both READS gate on `egress.read` and nothing narrower, which is a deliberate choice the spec
  // defends (§5): an agent auditing our zero-egress claim on the user's behalf is a use we WANT.
  // `egress_self_test` runs the real E04/E05/E06 loop and produces a draft, but it is declared a
  // read (readOnlyHint) and gated as one: the draft lands in the practitioner's OWN local Drafts via
  // E06's already-idempotent path (disclosed to no one), and `generateDraft`'s own in-engine
  // `read_sales` assert still governs whether the draft may be GROUNDED, so a holder of `egress.read`
  // alone cannot launder the books through the self-test. `egress_status` reads no rows at all. A
  // non-member holds neither capability and gets the padlock (US-E07.1 permission-denied).
  egress_self_test: 'egress.read',
  egress_status: 'egress.read',

  // --- G13 GL archive ---------------------------------------------------------------------------
  // The import gates on `commit_migration` on BOTH faces (the engine asserts it too, so the G09
  // seam path agrees): importing a foreign book's history is money-path-adjacent even though it
  // posts nothing. The PREVIEW gates on `manage_import` like G09's own `migration_preview_step`,
  // NOT on `read_books`: it renders the not-yet-imported source export, which is plan material a
  // viewer of the books holds no right to; the three ARCHIVE reads are with the other read verbs
  // below under `read_books` (the archive IS the books, historical or not), kept in the read block
  // so the D50 rule reads whole. The purge gates on `purge_archive`, the owner-only third fence
  // beside the confirm gate and the automation denylist.
  gl_archive_preview: 'manage_import',
  gl_archive_import: 'commit_migration',
  gl_archive_purge: 'purge_archive',

  // ===============================================================================================
  // THE READS (D50). One capability per domain; see `READ_CAPABILITIES` in `capabilities.ts` for
  // the rule that places a verb, which is the part the other 74 specs extend.
  // ===============================================================================================

  // --- read_books: the ledger, and everything derived from or shaped by it ----------------------
  // The chart and the cost centres are in here rather than in `read_master_data` because they are
  // the SHAPE of the books rather than a register beside them, which is the same reading that put
  // their writes behind `manage_chart` rather than `manage_master_data`.
  list_accounts: 'read_books',
  list_cost_centers: 'read_books',
  get_entry: 'read_books',
  list_journal: 'read_books',
  get_audit_log: 'read_books',
  list_period_locks: 'read_books',
  trial_balance: 'read_books',
  balance_sheet: 'read_books',
  income_statement: 'read_books',
  general_ledger: 'read_books',
  // The one the critic exported the whole ledger through.
  export_statement: 'read_books',
  get_opening_balances: 'read_books',
  // Two PREVIEWS of a posting, so they take the posting's domain and not the domain of the thing
  // they name. `preview_bank_opening_balance` names a bank account and previews a journal entry.
  preview_opening_import: 'read_books',
  preview_bank_opening_balance: 'read_books',
  // C03's four reads (US-C03.6): AGGREGATE reporting over the pipeline, gated like A08's statements
  // and not like the board. `deals.read` was the tempting answer because the sources are deals, but
  // the spec's boundary is exactly the other way around: someone allowed to work the pipeline is not
  // thereby allowed the workspace-wide revenue picture, and `forecast_vs_actual` reads A08's posted
  // revenue outright. One of the four reads C02 quote figures too; a separate `read_sales` leg was
  // declined because splitting one capability's four reads across two rights would make the Prognose
  // surface half-render, which is the shown-then-rejected shape §6 forbids.
  forecast_weighted_pipeline: 'read_books',
  forecast_sales_kpis: 'read_books',
  forecast_revenue: 'read_books',
  forecast_vs_actual: 'read_books',
  // A17's two reads, by the rule in `capabilities.ts`: a read belongs to the domain whose WRITES
  // produce the data it returns, and A17's writes are posting writes gated on `post`, whose read twin
  // in `READ_FOR_EDIT_CAPABILITY` above is `read_books`. `read_sales` was the tempting answer because a
  // bill looks like a document, but the sales domain is what a customer sees and owes; a vendor bill is
  // the books. A `read_purchases` domain was declined for the same reason `capabilities.ts` gives about
  // adding names: a capability adds one only when it brings a domain that does not exist, and this one
  // does not. It also means the `viewer` seat and all three built-in mandates can read the Kreditoren
  // without a role edit, which is the honest default for a figure that is already in the trial balance.
  list_vendor_bills: 'read_books',
  get_vendor_bill: 'read_books',
  // A18's three reads: the payable list mirrors list_vendor_bills exactly (it IS a filtered view
  // over the same rows), and a payment batch is a Kreditoren artefact, not a sales one.
  list_payable: 'read_books',
  get_payment_batch: 'read_books',
  list_payment_batches: 'read_books',
  // G13's three ARCHIVE reads (spec §3): the archive IS the books, historical or not, so querying
  // the prior system's journal is exactly as hard as querying the live one. The archive adds no new
  // read right, and every payload carries its prior-system provenance label so a holder of
  // `read_books` can never mistake an archive figure for a TILL-computed one.
  gl_archive_query: 'read_books',
  gl_archive_account_history: 'read_books',
  gl_archive_periods: 'read_books',

  // --- A26's reads: the agent's Q&A / checklist / anomaly models, and the dial view --------------
  // The three convenience reads are read models OVER THE LEDGER (A02/A08) and the figures derived from
  // it, so they sit in `read_books` by the domain rule (a read belongs to the domain whose writes
  // produce the data it returns): `ledger_qa` answers a turnover / open-items / VAT question from the
  // posted journal, `month_end_checklist` aggregates drafts and a VAT preview, and `detect_anomalies`
  // reads the posted entries. Each returns only totals and drill-down ids, never per-party detail, so
  // `read_books` is the honest substrate rather than a widening to `read_sales`.
  ledger_qa: 'read_books',
  month_end_checklist: 'read_books',
  detect_anomalies: 'read_books',
  // The RAW dial view is owner-facing (§4), so it is gated on the same capability that WRITES the dial
  // rather than on a read domain: seeing exactly what the agent may auto-execute is an oversight act,
  // not a bookkeeping read, and no built-in but `owner` holds `manage_agent_dial`. (`whoami` still
  // surfaces the RESOLVED subset relevant to the calling actor without this capability, §4.)
  get_agent_dial: 'manage_agent_dial',

  // --- read_vat: the MWST configuration, its evidence, and every figure computed from it --------
  vat_config: 'read_vat',
  vat_codes: 'read_vat',
  vat_saldo_generations: 'read_vat',
  // A05's eligibility comparison (G17 design §8d): the measured half is the same journal read as
  // `vat_return` (Ziffer 299 via computeVatReturn), so it travels with the figure it foreshadows.
  vat_saldo_eligibility: 'read_vat',
  vat_preview: 'read_vat',
  vat_return: 'read_vat',
  vat_export_ech0217: 'read_vat',
  vat_periods: 'read_vat',

  // --- read_sales: documents, settlement, and what is still owed --------------------------------
  get_document: 'read_sales',
  list_documents: 'read_sales',
  preview_payment: 'read_sales',
  suggest_payment_matches: 'read_sales',
  get_payment: 'read_sales',
  list_payments: 'read_sales',
  list_open_items: 'read_sales',
  customer_balance: 'read_sales',
  aging_report: 'read_sales',
  // Configuration OF a read_sales figure, so it travels with the figure.
  get_aging_bucket_config: 'read_sales',
  // A15's four reads, by the domain rule: a dunning run's data is produced by dunning's own writes
  // over the receivables, and the receivables are read_sales. The config read travels with the
  // figure it configures, the `get_aging_bucket_config` precedent; the letter PDF is the run's
  // frozen rows rendered, no wider than the run itself.
  get_dunning_config: 'read_sales',
  list_dunning_runs: 'read_sales',
  get_dunning_run: 'read_sales',
  get_dunning_pdf: 'read_sales',
  // A21's two reads, by the same domain rule: the queue is the settlement side of the receivable
  // (the `suggest_payment_matches` family), and the score names invoices and open amounts, which
  // are read_sales facts. The dial state rides the list payload, so no separate config read exists.
  match_qr_payment: 'read_sales',
  list_unmatched_incoming: 'read_sales',
  // A20's two reads, the same domain rule applied to the shared reconciliation surface: proposals and
  // the matched/unmatched/partial board both describe settlement facts (invoices, vendor bills,
  // payments), which are read_sales.
  suggest_matches: 'read_sales',
  list_reconciliation: 'read_sales',
  list_bank_statements: 'read_sales',

  // --- read_master_data: the registers, and the workspace's own party record -------------------
  get_company_profile: 'read_master_data',
  // A23: the roster entry is the company profile's lighter sibling, so it takes the same domain.
  // Every built-in bundle and the viewer anchor hold it, which is what a switcher header needs.
  get_workspace: 'read_master_data',
  get_contact: 'read_master_data',
  list_contacts: 'read_master_data',
  get_item: 'read_master_data',
  list_items: 'read_master_data',
  // D00 reads: the category tree, the price lists, and the agent-primary resolver. All are master-data
  // reads, gated like get_item/list_items.
  item_categories_list: 'read_master_data',
  price_lists_list: 'read_master_data',
  price_lists_get: 'read_master_data',
  price_resolve: 'read_master_data',
  // B00: the projects register and its two reads-with-figures. `project_budget_actual` stays in
  // this domain by the D50 rule: the data it returns is produced by the master-data writes above
  // (budgets) and by the registered read-only cost sources, and a preview/report inherits the
  // domain of the writes that produced its rows.
  project_list: 'read_master_data',
  project_get: 'read_master_data',
  project_budget_actual: 'read_master_data',
  // D01's four reads, by the D50 domain rule: on-hand, the low-stock list, the valuation report and
  // the stocktake diff are all produced by D01's own master-data writes (movements, locations,
  // stocktakes), so they read as hard as the registers they summarise. `stock_valuation_report`
  // stays here rather than in `read_books`: it reports the OP2 stock position and only names the
  // already-posted ledger total, it does not open the journal.
  stock_on_hand: 'read_master_data',
  stock_low_stock: 'read_master_data',
  stock_valuation_report: 'read_master_data',
  stock_stocktake_report: 'read_master_data',
  // J00's six reads, by the same D50 domain rule: warehouses, locations, the tree and the
  // balance-by-location read model are produced by J00's own master-data writes and the OP2 movement
  // ledger, so they read as hard as the registers they summarise.
  warehouse_list: 'read_master_data',
  warehouse_get: 'read_master_data',
  location_list: 'read_master_data',
  location_get: 'read_master_data',
  location_tree: 'read_master_data',
  inventory_balance_by_location: 'read_master_data',
  // J01's eight reads, by the same D50 domain rule: lots, serials, their searches and the two derived
  // read models (on-hand-by-lot, available-serials) are produced by J01's own master-data writes and
  // the OP2 movement ledger, so they read as hard as the registers they summarise.
  lot_get: 'read_master_data',
  lot_list: 'read_master_data',
  lot_search: 'read_master_data',
  serial_get: 'read_master_data',
  serial_list: 'read_master_data',
  serial_search: 'read_master_data',
  inventory_on_hand_by_lot: 'read_master_data',
  inventory_available_serials: 'read_master_data',
  // J02 movement-ledger reads: on-hand SUM, the movement history, one movement, and the policy read.
  inventory_balance: 'read_master_data',
  inventory_movement_list: 'read_master_data',
  inventory_movement_get: 'read_master_data',
  inventory_get_config: 'read_master_data',
  // J05's four reads: the reason catalog (list + one), the adjustment history and the analysis
  // aggregation. All summarise the reason master and the inventory_adjustment linkage over the J02
  // ledger the master-data writes produce, so they read as hard as the registers behind them and none
  // writes anything.
  inventory_reason_list: 'read_master_data',
  inventory_reason_get: 'read_master_data',
  inventory_adjust_list: 'read_master_data',
  inventory_adjust_analysis: 'read_master_data',
  // J03's four valuation reads, by the same D50 domain rule: the preview, the layer inspection, the
  // method registry and the Stetigkeit history all summarise the item master and the J02 ledger the
  // master-data writes produce, so they read as hard as the registers behind them. None of them
  // writes anything, so none needs a write right to answer.
  inventory_valuation_preview: 'read_master_data',
  inventory_valuation_methods: 'read_master_data',
  inventory_valuation_layers: 'read_master_data',
  inventory_valuation_method_history: 'read_master_data',
  // J06's five reads: a run and its lines, the run list, the detailed valuation report, and the two
  // reconciliation reads. Each summarises the J02 ledger, the J03 valuation and the A02 balances, so
  // it reads as hard as those registers; none writes anything. `reconciliation_check` returns a
  // structured drift / valuation_missing error but is still a pure read of the same sources.
  inventory_valuation_get: 'read_master_data',
  inventory_valuation_list: 'read_master_data',
  inventory_valuation_report: 'read_master_data',
  inventory_reconciliation_report: 'read_master_data',
  inventory_reconciliation_check: 'read_master_data',
  // J04's three cycle-count / stocktake reads: the variance report, one session, the session list.
  // Each summarises the J02 ledger snapshot and the session's own lines, so it reads as hard as the
  // inventory register behind it; none writes anything (P5).
  inventory_stocktake_report: 'read_master_data',
  inventory_stocktake_get: 'read_master_data',
  inventory_stocktake_list: 'read_master_data',
  // J07's ten agent tools & alerts: all PURE READS over the whole J00-J06 cluster. Each summarises the
  // J02 movement ledger, the J03/J06 valuation and the J04 sessions and owns no table, so it reads as
  // hard as the inventory registers behind it (`read_master_data`, the J00-J06 read domain) and none
  // writes anything (P5). There is no separate inventory-read / alerts right in Phase 1.
  inventory_stock_position: 'read_master_data',
  inventory_low_stock: 'read_master_data',
  inventory_valuation_status: 'read_master_data',
  inventory_movement_history: 'read_master_data',
  inventory_anomalies: 'read_master_data',
  inventory_cycle_count_status: 'read_master_data',
  inventory_lot_trace: 'read_master_data',
  inventory_slow_movers: 'read_master_data',
  inventory_alerts: 'read_master_data',
  inventory_reorder_candidates: 'read_master_data',
  list_bank_accounts: 'read_master_data',
  get_bank_account: 'read_master_data',
  // A12: a schedule is sales configuration and its run log names invoices, so both reads travel
  // with the documents they generate.
  list_recurring_schedules: 'read_sales',
  get_recurring_schedule: 'read_sales',
  // E00's LIST reads. A stored file is master data ABOUT a record, and the rule in `capabilities.ts`
  // puts a read in the domain whose writes produce the data it returns, so seeing that a voucher exists,
  // what it is called, when it was filed and how long it must be kept is a master-data read.
  files_search: 'read_master_data',
  files_list_linked: 'read_master_data',
  folders_list: 'read_master_data',

  // E00's CONTENT read, and the one place in this file where the D50 domain rule is deliberately
  // overridden by a decision (F7, owner-decided 30.07.2026). This block used to end with the argument
  // that `read_master_data` was enough because "OR 958f Abs. 3 and GeBüV Art. 6 make availability a
  // duty, and a voucher that only an administrator can open is a voucher the bookkeeper who has to
  // reconcile it cannot read". The availability half of that is right and is preserved: `bookkeeper`,
  // `treuhaender` and `agent` all hold `read_file_content`. What the argument missed is that
  // `VIEWER_CAPABILITIES` holds `read_master_data`, so a READ-ONLY INVITE could download every byte in
  // the workspace. The critic reproduced it end to end with an AHV number inside the payload.
  //
  // BOTH, in the ALL-OF form, because a role that may download a file it cannot list is not a role
  // anyone wants: `read_master_data` is how a caller obtains a `fileId` at all, and requiring it here
  // keeps a custom bundle from expressing "may fetch bytes by guessing an id".
  //
  // WHAT THIS IS NOT: per-file sensitivity. The owner declined that explicitly, so there is no
  // classification column and no `hr.sensitive` check here; that name stays reserved for E02 / A34 and
  // E00's spec §0 carries it as a named follow-up.
  files_get_content: ['read_master_data', 'read_file_content'],
  // The rate register and the election that reads off it. `set_fx_method`'s WRITE sits with the VAT
  // config because it is a tax election; reading the current basis is reading the rate register.
  list_exchange_rates: 'read_master_data',
  get_exchange_rate: 'read_master_data',
  get_fx_method: 'read_master_data',
  describe_rate_feed: 'read_master_data',

  // --- read_automations: what the unattended subsystem is configured to do, and what it did ------
  // A NEW DOMAIN RATHER THAN A HOME IN AN EXISTING ONE, by the rule in `capabilities.ts`: these four
  // return `automation_rule` and `automation_run` rows, and the writes that produce those rows are
  // G01's own. Nothing in the ledger, the registers, the sales surface or the membership produces
  // them, so no existing domain owns them.
  //
  // AND DELIBERATELY NOT `manage_automations`, which was the shortcut. G01 leaves
  // `disable_automation_rule` ungated on the argument that "a stop button that requires a permission
  // is not a stop button", and a rule can only be stopped by its `ruleId`, which comes from
  // `list_automation_rules` and nowhere else. Declaring these on the administrator capability would
  // have re-gated the stop button through its own input, which is the same shape of bypass
  // `transition_document` reads the target state to prevent.
  list_automation_rules: 'read_automations',
  get_automation_rule: 'read_automations',
  // The run log travels with the rules rather than with the domain each firing wrote into, because
  // the domain a run touched is a property of the ROW (its `action_tool`) and the boundary sees the
  // input and never the database, which is the same limit `unlock_period` is written around. See the
  // note in `core/automation/runs.ts` on what that means for a custom role holding this capability
  // without the target's own read domain.
  list_automation_runs: 'read_automations',
  get_automation_run: 'read_automations',

  // --- read_members: who has access, and what the roles mean -----------------------------------
  // The capability D50 was decided FOR. It is what makes "a Treuhänder who sees the books and not
  // the member list" expressible, and no built-in but `owner` holds it.
  list_members: 'read_members',
  list_roles: 'read_members',

  // --- G08 reads, on the gate they already had --------------------------------------------------
  list_feedback: 'diagnostics.read',
  get_diagnostics: 'diagnostics.read',

  // --- G07, global search -----------------------------------------------------------------------
  // The F00 `dashboard_overview` posture, restated for search: no single boundary capability can
  // state a nine-domain rule without lying in one direction (gating on any one domain would refuse
  // an operations-only role the task hits its role permits, or serve a role without `read_books`
  // the vendor-bill hits its own source verb would refuse). So `src/core/search/searchGlobal.ts`
  // asserts each kind's own registry `readCapability` via `ctx.capabilities` before that kind's
  // fan-out and OMITS refused kinds silently (US-G07.5: no count, no placeholder, no signal). A
  // caller holding no read domain gets `{ok:true, results:[]}`: the verb discloses nothing the
  // caller's own list verbs would not answer.
  search_global: ungated(
    'asserted_in_engine',
    'Per-kind RBAC: the engine asserts each searchable kind`s own read capability and silently omits refused kinds; no single boundary capability can state a nine-domain rule.',
  ),

  // --- H00, fixed-asset categories & defaults --------------------------------------------------
  // A category is MASTER DATA (it carries GL-account and depreciation defaults, never a posting), so
  // its writes gate on `manage_master_data`, exactly as A09's item CRUD and D00's item_categories do,
  // and its reads on the master-data read twin `read_master_data`. The spec's persona table names a
  // future `assets.setup` capability for a finer split; that has no A24 name yet (the B00 `project.manage`
  // / C00 deferral shape), so a finer split is a future A24 retrofit and the honest gate today is the
  // master-data domain the category actually lives in.
  asset_category_create: 'manage_master_data',
  asset_category_update: 'manage_master_data',
  asset_category_archive: 'manage_master_data',
  asset_category_list: 'read_master_data',
  asset_category_get: 'read_master_data',
  asset_category_resolve_defaults: 'read_master_data',

  // --- H01, the Asset Master -------------------------------------------------------------------
  // An asset is MASTER DATA carrying a financial baseline, not a posting (the acquisition journal is
  // H02, depreciation H03/H04), so its writes gate on `manage_master_data` exactly as its H00 category
  // does, and its reads on the master-data read twin `read_master_data`. The spec's persona table
  // (§3: A creates + descriptively updates when permitted) is the same future `assets.setup` split
  // H00 deferred; the honest gate today is the master-data domain the asset lives in.
  asset_create: 'manage_master_data',
  asset_update: 'manage_master_data',
  asset_archive: 'manage_master_data',
  asset_list: 'read_master_data',
  asset_get: 'read_master_data',
  asset_search: 'read_master_data',

  // --- H02, Asset Acquisition (the MONEY PATH: it posts the capitalisation journal) ------------
  // Unlike the H00/H01 master-data writes, `asset_acquire` and `asset_add_capitalisation` POST a
  // balanced GL journal through A02, so they gate on `post` exactly as A17's `create_vendor_bill` and
  // A22's `post_fx_revaluation` do: the honest capability is the posting domain, and the engine's own
  // `postEntry` asserts `post` again on the inner call (the A02 boundary/engine double-gate note). The
  // spec's persona table names a finer `assets.acquire` right; that has no A24 name yet (the H00
  // `assets.setup` deferral shape), so a finer split is a future A24 retrofit and the honest gate today
  // is `post`. The two sub-ledger READS expose ledger-linked events (a journal_entry_id and a booked
  // cost), so they ride the read-books domain `read_books` (the `post` -> `read_books` twin), not the
  // master-data read the register list uses.
  asset_acquire: 'post',
  asset_add_capitalisation: 'post',
  asset_transaction_list: 'read_books',
  asset_transaction_get: 'read_books',
  // --- H05, Asset Transfer & Location (NON-POSTING master data) --------------------------------
  // A location is master data and a transfer posts NOTHING (it moves an asset between places /
  // custodians and creates no journal), so every H05 write gates on `manage_master_data` and every
  // read on its twin `read_master_data`, the H00/H01 asset-cluster posture one entity over. The spec's
  // §3 persona table names a finer `assets.transfer` right; that has no A24 name yet (the H00
  // `assets.setup` deferral shape), so a finer split is a future A24 retrofit and the honest gate today
  // is the master-data domain the asset and its location live in. This also makes `set_field_value` on
  // the `asset_location` G00 kind inherit `manage_master_data`, which `READ_FOR_EDIT_CAPABILITY`
  // already resolves to `read_master_data` (the asset / item / warehouse row).
  asset_location_create: 'manage_master_data',
  asset_location_update: 'manage_master_data',
  asset_location_archive: 'manage_master_data',
  asset_location_list: 'read_master_data',
  asset_location_get: 'read_master_data',
  asset_transfer: 'manage_master_data',
  asset_transfer_history: 'read_master_data',
  // --- H04, Depreciation Run & Posting (the MONEY PATH: it posts the period-end depreciation journal) -
  // The three run WRITES post (or reverse) a balanced GL journal through A02, so they gate on `post`
  // exactly as H02's acquisition does; the engine's own `postEntry` / `reverseEntry` asserts `post`
  // again on the inner call (the A02 boundary/engine double-gate). Create writes no journal but is a
  // step of the same posting workflow and stages the figures that will post, so it rides `post` too
  // (the spec's finer `assets.depreciation` right has no A24 name yet, the H00 `assets.setup` deferral
  // shape). The two run READS expose ledger-linked events (a journal_entry_id and booked amounts), so
  // they ride the read-books domain, the `post` -> `read_books` twin, not the master-data read.
  asset_depreciation_run_create: 'post',
  asset_depreciation_run_post: 'post',
  asset_depreciation_run_reverse: 'post',
  asset_depreciation_run_get: 'read_books',
  asset_depreciation_run_list: 'read_books',
  // --- H06, Asset Disposal (the MONEY PATH: it posts the terminal disposal journal) -------------
  // `asset_dispose` posts a balanced GL journal through A02 (clearing cost + accumulated depreciation,
  // recognising proceeds and the book gain/loss), so it gates on `post` exactly as H02's acquisition
  // and H04's run do; the engine's own `postEntry` asserts `post` again on the inner call (the A02
  // boundary/engine double-gate). The preview and the get expose a ledger-linked event (proposed or
  // posted journal lines and booked amounts), so they ride the read-books domain, the `post` ->
  // `read_books` twin, not the master-data read. The spec's persona table names a finer `assets.dispose`
  // right; that has no A24 name yet (the H00 `assets.setup` deferral shape), so the honest gate today is
  // the posting domain the disposal lives in.
  asset_disposal_preview: 'read_books',
  asset_dispose: 'post',
  asset_disposal_get: 'read_books',
  // --- H07, Asset Ledger & Reconciliation (the OP11 guarantee for fixed assets) -----------------
  // The four READS expose ledger-linked, GL-reconciled figures (asset_transaction rows with journal ids,
  // control-account balances), so they ride the read-books domain exactly as H02/H04/H06's sub-ledger
  // reads do, not the master-data read. `asset_opening_balance` POSTS a balanced opening journal through
  // A02, so it gates on `post` exactly as H02's acquisition does; the engine's own `postEntry` asserts
  // `post` again on the inner call (the A02 boundary/engine double-gate). The spec's persona table names
  // finer `assets.read` / `assets.reconcile` rights; those have no A24 name yet (the H00 `assets.setup`
  // deferral shape), so the honest gate today is the read-books / posting domain the ledger lives in.
  asset_ledger_get: 'read_books',
  asset_ledger_list: 'read_books',
  asset_reconciliation_report: 'read_books',
  asset_reconciliation_check: 'read_books',
  asset_opening_balance: 'post',
  // --- H08, Simple Maintenance Log (NON-POSTING: an append-oriented per-asset service log) -------
  // The log posts NOTHING to the GL (the captured cost is descriptive TCO metadata), so it is
  // master-data-grade exactly like the H05 location/transfer verbs, not a `post` money-path verb. Its
  // three writes gate on `manage_master_data` and its two reads on `read_master_data`. The §3 persona
  // table names a finer `assets.maintain` right; that has no A24 name yet (the H00 `assets.setup`
  // deferral shape H05/H06 also carry), so the honest gate today is the master-data domain the log and
  // its asset live in. This also makes any future `set_field_value` on an `asset_maintenance_log` G00
  // kind inherit `manage_master_data`, which `READ_FOR_EDIT_CAPABILITY` resolves to `read_master_data`.
  asset_maintenance_log_create: 'manage_master_data',
  asset_maintenance_log_update: 'manage_master_data',
  asset_maintenance_log_cancel: 'manage_master_data',
  asset_maintenance_log_get: 'read_master_data',
  asset_maintenance_log_list: 'read_master_data',
  // --- H09, Asset Reports & Agent Tools (READ-ONLY: pure reports over the H00-H08 cluster) --------
  // The split follows the figures each report exposes, the same reasoning H07 uses. The disposal and
  // acquisition summaries surface ledger-linked, GL-reconciled figures (asset_transaction rows with
  // journal ids, proceeds, gain/loss), so they ride `read_books`, the read twin H02/H06's own
  // sub-ledger reads already use. The register, forecast, NBV roll-up and end-of-life list read the
  // asset master (and the pure H03 projector), master data exactly like `asset_list` /
  // `asset_depreciation_schedule`, so they ride `read_master_data`. All six post nothing.
  asset_register_report: 'read_master_data',
  asset_depreciation_forecast: 'read_master_data',
  asset_nbv_summary: 'read_master_data',
  asset_end_of_life_list: 'read_master_data',
  asset_disposal_summary: 'read_books',
  asset_acquisition_summary: 'read_books',
  // --- I00, requisitions (the internal-demand document, no money path) -------------------------
  // A requisition is an OPERATIONAL document that opens the procure-to-pay chain: it posts nothing and
  // emits no outward artifact, and its OWN writes are master-data-grade, exactly as D02's purchase
  // order is (`po_upsert` gates on `manage_master_data`). So every requisition WRITE gates on
  // `manage_master_data` and every READ on the master-data read twin `read_master_data`, which is also
  // what makes `requisition_convert_to_po` coherent: it calls `po_upsert`, which asserts the same
  // capability. The spec's persona table names finer `procurement.requisition.write` / `procurement.
  // approve` / `procurement.convert` rights; those have no A24 name yet (the B00 `project.manage` /
  // H00 `assets.setup` deferral shape), so a finer split (segregating requester / approver / buyer) is
  // a future A24 retrofit and the honest gate today is the master-data domain the document lives in.
  // This also makes `set_field_value` on the `requisition` G00 kind inherit `manage_master_data`, which
  // `READ_FOR_EDIT_CAPABILITY` already resolves to `read_master_data` (the item/contact/po row).
  requisition_upsert: 'manage_master_data',
  requisition_submit: 'manage_master_data',
  requisition_approve: 'manage_master_data',
  requisition_reject: 'manage_master_data',
  requisition_return: 'manage_master_data',
  requisition_convert_to_po: 'manage_master_data',
  requisition_cancel: 'manage_master_data',
  requisition_close: 'manage_master_data',
  requisition_get: 'read_master_data',
  requisition_list: 'read_master_data',
  requisition_my_pending_approvals: 'read_master_data',

  // --- I02, the goods receipt (the physical-receipt document; money path by way of J02) ---------
  // A goods receipt moves STOCK, and the one verb that actually does so, J02's `inventory_move`,
  // gates on `manage_master_data`. Gating I02 anywhere weaker would let a holder reach through the
  // document to a movement they could not write directly, and gating it stronger (`post`) would
  // claim a ledger act that I02 deliberately does not perform: it writes no journal entry at all
  // (P3, valuation flows J03 -> J06 -> A02 and input tax arises on the A17 vendor bill). So the
  // whole surface sits on the D02/I01/J02 purchasing vocabulary: writes on `manage_master_data`,
  // reads on the master-data read twin. The spec's `purchasing.receive` / `inventory.write` scopes
  // have no A24 name (the I00/H00 deferral shape); segregating "may receive goods" from "may edit
  // master data" is a future A24 retrofit, recorded here rather than invented locally. This also
  // makes `set_field_value` on the `goods_receipt` G00 kind inherit `manage_master_data`, which
  // `READ_FOR_EDIT_CAPABILITY` already resolves to `read_master_data`.
  goods_receipt_create: 'manage_master_data',
  goods_receipt_upsert_lines: 'manage_master_data',
  goods_receipt_post: 'manage_master_data',
  goods_receipt_accept_lines: 'manage_master_data',
  goods_receipt_reject_lines: 'manage_master_data',
  goods_receipt_reverse: 'manage_master_data',
  goods_receipt_cancel: 'manage_master_data',
  goods_receipt_set_config: 'manage_master_data',
  goods_receipt_preview: 'read_master_data',
  goods_receipt_get: 'read_master_data',
  goods_receipt_list: 'read_master_data',
  goods_receipt_lines_for_match: 'read_master_data',
  goods_receipt_get_config: 'read_master_data',

  // --- I03, landed cost allocation (money path: J02 cost movements + one A02 entry) --------------
  // The three writes capitalise freight/duty onto inventory and post the GL reclassification. They
  // gate on `procurement.landed_cost`, the A24 name minted for this surface: choosing what enters
  // acquisition cost is a balance-sheet judgment the spec's §3 gives to G (bookkeeper), T
  // (Treuhänder) and A (agent), and NOT to `manage_master_data` (which also renames an item). The
  // engine asserts the same capability, so the map and the verb agree. The three reads are pure
  // calculations over the voucher and the ledger, so they gate on the master-data read twin.
  landed_cost_voucher_create: 'procurement.landed_cost',
  landed_cost_allocate_confirm: 'procurement.landed_cost',
  landed_cost_reverse: 'procurement.landed_cost',
  landed_cost_allocate_preview: 'read_master_data',
  landed_cost_list: 'read_master_data',
  landed_cost_get: 'read_master_data',
  // --- I04, three-way match ---------------------------------------------------------------------
  // Recording a match clears a bill for payment, so `create` gates on the dedicated `purchasing.match`
  // capability. `override` is the ALL-OF form (the `contacts_merge` precedent): it asserts BOTH
  // `purchasing.match` and the stronger `purchasing.match_override` in the engine, so a routine matcher
  // cannot force a variance through. `reverse` gates on `purchasing.match_override` alone (undoing a
  // permanent record is the same money-authority as overriding one). The five reads ride
  // `read_master_data`, the D02 purchasing read domain.
  match_three_way_create: 'purchasing.match',
  match_three_way_override: ['purchasing.match', 'purchasing.match_override'],
  match_three_way_reverse: 'purchasing.match_override',
  match_three_way_evaluate: 'read_master_data',
  match_three_way_get: 'read_master_data',
  match_three_way_list: 'read_master_data',
  match_three_way_exceptions: 'read_master_data',
  match_status_for_bill: 'read_master_data',

  // --- I05, supplier performance ----------------------------------------------------------------
  // Five PURE READS over the live I02 receipts and the D02 po_match trail. They gate on the same
  // master-data read twin the D02/I01/I02 purchasing reads use (`read_master_data`), which is what the
  // spec's illustrative `purchasing.read` / `purchasing.analytics` resolves to in this codebase: a
  // supplier scorecard is a read of the purchasing domain, not a new permission surface.
  supplier_scorecard_get: 'read_master_data',
  supplier_performance_rank: 'read_master_data',
  supplier_performance_trend: 'read_master_data',
  supplier_performance_explain: 'read_master_data',
  supplier_performance_alerts: 'read_master_data',

  // --- I06, procurement analytics & agent tools -------------------------------------------------
  // Ten PURE READS over the live I00-I05 + D02 documents (open commitments, match status, spend,
  // supplier scorecard, requisition pipeline, GR/IR clearing, landed-cost variance, PO cycle,
  // anomalies, PO history). They own no table and post nothing, so they gate on the same master-data
  // read twin the whole purchasing read surface uses (`read_master_data`), which is what the spec's
  // illustrative `procurement.read` / `procurement.reports` / `procurement.analytics` resolves to in
  // this codebase: procurement analytics is a read of the purchasing domain, not a new permission.
  procurement_open_commitments: 'read_master_data',
  procurement_match_status: 'read_master_data',
  procurement_spend_summary: 'read_master_data',
  procurement_supplier_scorecard: 'read_master_data',
  procurement_requisition_pipeline: 'read_master_data',
  procurement_grir_clearing: 'read_master_data',
  procurement_landed_cost_variance: 'read_master_data',
  procurement_po_cycle: 'read_master_data',
  procurement_anomalies: 'read_master_data',
  procurement_po_history: 'read_master_data',

  // --- H03, depreciation methods & engine -------------------------------------------------------
  // The preview/schedule/methods reads are pure calculations over the asset master, so they gate on
  // the same master-data read twin the register does. Enabling/disabling a method is a setup act (the
  // spec's `assets.setup`, which has no A24 name yet, the H00/H01 posture): the honest gate today is
  // `manage_master_data`, the domain the asset and its category configuration live in.
  asset_depreciation_preview: 'read_master_data',
  asset_depreciation_schedule: 'read_master_data',
  asset_depreciation_methods: 'read_master_data',
  asset_depreciation_method_set_enabled: 'manage_master_data',

  // --- The ungated reads, each with the reason it is one ----------------------------------------
  whoami: ungated(
    'self_scoped_read',
    'A caller must be able to learn that it holds NOTHING. Gating this would mean a non-member could not be told it is a non-member, and the Studio could not render the denial it is about to receive.',
  ),
  list_workspaces: ungated(
    'pre_workspace',
    'Pre-workspace: there is no tenant on the input to resolve a capability against, which is the same reason it is a depsAction.',
  ),
  preview_feedback: ungated(
    'machine_scope',
    'Its write twin `prepare_feedback` is ungated because reporting a bug is not a privilege. Gating the preview would silence exactly the restricted-role user most likely to hit one. Reading recorded DIAGNOSTICS is a separate question and is still gated on `diagnostics.read` inside the verb, on the input flag rather than on the verb.',
  ),

  // --- N00, the environment landscape (D126) ---------------------------------------------------
  // The three READS gate on `landscape.read`, the four WRITES on `landscape.manage` (D-ENV-7). The
  // family is ctxAction precisely so these resolve at the A24 boundary against the caller's workspace
  // membership: managing the host-level landscape is an owner act, and the load guard forbids a real
  // capability on a pre-workspace depsAction. The ops themselves ignore the ledger and work on the
  // control file; the workspace is the actor's membership context, not the target of the write.
  env_list: 'landscape.read',
  env_status: 'landscape.read',
  env_current: 'landscape.read',
  env_switch: 'landscape.manage',
  env_create: 'landscape.manage',
  env_reset: 'landscape.manage',
  env_delete: 'landscape.manage',
  // env_copy (Phase B) gates on `landscape.manage` like its siblings, EXCEPT the owner-only
  // secret-retaining override: `retainSecrets=true` produces a full-fidelity clone that can still touch
  // a real bank, so it resolves to `landscape.retain_secrets` (owner-only, not in any built-in bundle),
  // unreachable by an agent seat or any non-owner. The raw sanitization LEVEL is the D-ENV-4 default and
  // is NOT owner-gated; retaining the SECRET floor is. `env_create policy=copy` routes through
  // `env_create` above (`landscape.manage`); its own retain override is refused to non-owners by the
  // engine only, so create-with-retain is deliberately not offered over the wire (use copy after create).
  env_copy: (input) => (input.retainSecrets === true ? 'landscape.retain_secrets' : 'landscape.manage'),
};

/**
 * EVERY capability an action requires for this input. Empty means explicitly ungated.
 *
 * Throws on an action with no rule at all. That path is unreachable once the load-time guard
 * below has run, and it is written as a throw rather than as a
 * permissive empty array so that "unreachable" stays true if the check is ever moved: failing
 * closed on an unknown verb is the only safe direction for this function.
 */
export function requiredCapabilitiesFor(
  actionName: string,
  input: Record<string, unknown>,
): readonly Capability[] {
  const rule = CAPABILITY_FOR_ACTION[actionName];
  if (rule === undefined) {
    throw new Error(`A24: no capability rule declared for action "${actionName}".`);
  }
  if (isUngated(rule)) return [];
  if (Array.isArray(rule)) return rule;
  return [typeof rule === 'function' ? rule(input) : (rule as Capability)];
}

/** What the load-time guard needs to know about one registered action. */
export interface GatedAction {
  readonly name: string;
  /** False for a `depsAction`: a pre-workspace verb never reaches the ctx boundary that gates. */
  readonly reachesTheGate: boolean;
  /** The registry's own `kind`. Needed to check a `self_scoped_read` really is one. */
  readonly kind: 'read' | 'write';
}

/**
 * What each exemption shape PROMISES about the verb, as a predicate over the registry's own facts.
 *
 * This is the whole of the answer to "nothing anywhere measures an `ungated()` reason against
 * behaviour". It does not measure behaviour, which a load-time check cannot do; it measures the
 * exemption's CATEGORY against a structural fact, which is the part that was free all along and that
 * nobody was collecting. A verb mislabelled to get past this is a verb somebody had to mislabel on
 * purpose, in a reviewed diff, which is the same standard `ungated` itself was introduced to meet.
 */
const SHAPE_REQUIRES: Readonly<Record<ExemptionShape, (a: GatedAction) => string | undefined>> = {
  pre_workspace: (a) =>
    a.reachesTheGate
      ? 'it takes a workspaceId, so a tenant DOES exist to resolve a capability against'
      : undefined,
  self_scoped_read: (a) => (a.kind === 'read' ? undefined : 'it is a WRITE, and a write is not a read of yourself'),
  machine_scope: (a) =>
    a.reachesTheGate ? undefined : 'a pre-workspace verb is `pre_workspace`, not `machine_scope`',
  asserted_in_engine: (a) =>
    a.reachesTheGate
      ? undefined
      : 'it never reaches a ctx, so there is no `ctx.capabilities` for the engine to assert on',
  prevents_only: (a) => (a.kind === 'write' ? undefined : 'a READ prevents nothing, so this shape is not its reason'),
};

/**
 * NO EXEMPTION SURVIVES AN `ActionInvoker`, and this is the rule that would have caught G1.
 *
 * A verb holding an invoker can cause any other verb to run AS A DIFFERENT ACTOR, so its own gate is
 * the only thing standing between a caller and every capability every rule author holds. Whatever
 * category such a verb's author picks, the category is wrong: the exemption launders capabilities by
 * construction. `run_due_automations` was exempt for eleven days on a reason that argued the firings
 * were "separately gated", which is true and irrelevant, because they are gated against the AUTHOR.
 *
 * THE FACT COMES FROM THE API LAYER AND THE RULE LIVES HERE, which is the same handshake
 * `assertEveryActionIsGated` and `registerWriteActions` both use: core must not import
 * `src/api/registry.ts`, so the caller that knows which verbs were built with an invoker hands the
 * list over at module load. `src/api/automation-actions.ts` is that caller, and it collects the names
 * structurally (a verb can only obtain an invoker by going through its `firingAction` helper) rather
 * than from a list somebody maintains.
 */
export function assertActionInvokersAreGated(names: readonly string[]): void {
  const laundering = names.filter((n) => {
    const rule = CAPABILITY_FOR_ACTION[n];
    return rule === undefined || isUngated(rule);
  });
  if (laundering.length > 0) {
    throw new Error(
      'A24: these verbs can INVOKE another verb as a different actor and are ungated, which makes ' +
        'the exemption a capability-laundering hole regardless of the reason attached. Gate them: ' +
        `${laundering.join(', ')}.`,
    );
  }
}

/**
 * The fail-closed check, run at module load in `src/api/registry.ts`.
 *
 * This is what makes "you cannot un-gate posting" structural rather than a convention. A capability
 * that appends a verb to `ACTIONS` and does not declare its gate here cannot be imported at all: the
 * MCP server, the REST twins, the Studio bridge and every root suite fail on the same line, at
 * start-up, with the verb named.
 *
 * IT COVERS READS AS OF D50, and that is the change that matters most for what comes next. The old
 * check ran over the write names only, so the fifty ungated reads it did not look at were invisible
 * to it: the guard was silent about the exact defect the wave critic found. A24 is referenced by 74
 * of 90 specs, so a read verb appended next month by a capability that never read this file has to
 * be a crash on import rather than an open door nobody audits. It now is.
 *
 * THE THIRD CHECK IS THE SUBTLE ONE. A declared capability on a verb that never reaches the ctx
 * boundary is worse than no declaration, because it reads on the Roles tab as a gate and enforces
 * nothing. A `depsAction` is pre-workspace by construction (there is no tenant to resolve a
 * capability against), so it may only ever be `ungated(reason)`.
 */
export function assertEveryActionIsGated(actions: readonly GatedAction[]): void {
  const missing = actions.filter((a) => CAPABILITY_FOR_ACTION[a.name] === undefined).map((a) => a.name);
  if (missing.length > 0) {
    throw new Error(
      'A24: these actions declare no capability in CAPABILITY_FOR_ACTION ' +
        `(add a capability or an explicit ungated(reason)): ${missing.join(', ')}.`,
    );
  }

  const known = new Set(actions.map((a) => a.name));
  const stale = Object.keys(CAPABILITY_FOR_ACTION).filter((name) => !known.has(name));
  if (stale.length > 0) {
    throw new Error(
      `A24: CAPABILITY_FOR_ACTION names actions the registry does not hold: ${stale.join(', ')}.`,
    );
  }

  // Safe to index unchecked: the `missing` check above has already thrown on any absent rule.
  const unenforceable = actions
    .filter((a) => !a.reachesTheGate && !isUngated(CAPABILITY_FOR_ACTION[a.name] as CapabilityRule))
    .map((a) => a.name);
  if (unenforceable.length > 0) {
    throw new Error(
      'A24: these pre-workspace actions declare a capability that can never be enforced, because ' +
        'they carry no workspace to resolve one against. Say ungated(shape, reason) instead, or make ' +
        `them ctx verbs: ${unenforceable.join(', ')}.`,
    );
  }

  // THE FOURTH CHECK, AND THE ONLY ONE THAT LOOKS AT AN EXEMPTION'S CONTENT. The three above measure
  // whether a rule EXISTS and whether it is enforceable; this one measures whether the stated reason
  // for not having one is consistent with what the registry says the verb is. See `SHAPE_REQUIRES`.
  const mislabelled: string[] = [];
  for (const action of actions) {
    const rule = CAPABILITY_FOR_ACTION[action.name] as CapabilityRule;
    if (!isUngated(rule)) continue;
    const problem = SHAPE_REQUIRES[rule.shape](action);
    if (problem !== undefined) {
      mislabelled.push(`${action.name} claims '${rule.shape}' but ${problem}`);
    }
  }
  if (mislabelled.length > 0) {
    throw new Error(
      `A24: these exemptions claim a shape the registry contradicts: ${mislabelled.join('; ')}.`,
    );
  }
}
