/**
 * OP3, the ENTITY REGISTRY: the attachment surface every custom field and saved view keys against.
 *
 * THE SPEC DEPENDED ON THIS AND IT DID NOT EXIST. G00's header listed OP3 as a dependency, "the entity
 * registry, the attachment surface every OP7/OP10 row keys against". Grepping the tree for it on
 * 29.07.2026 found the A03 audit log's free-text `entity_kind` column and nothing else: no registry, no
 * enumeration, and no contract that an unregistered kind is refused anywhere. So G00 builds it.
 *
 * THIS TABLE IS THE WHOLE OF WHAT A FUTURE CAPABILITY DOES TO OPT IN. One row, four facts, and that
 * capability's records carry custom fields and saved views with no further code anywhere. Nothing in
 * `fields.ts` or `views.ts` switches on an entity kind, and if a future change ever needs it to, that
 * is the signal the design went wrong rather than a licence to add a case: the whole value of this
 * module is that sixty-two waiting specs pay one line each instead of G00 growing sixty-two branches.
 *
 * `editCapability` IS WHY `set_field_value` NEEDS NO POLICY OF ITS OWN. G00 must never open a side door
 * around another capability's RBAC: writing a custom field on a journal entry has to be at least as
 * hard as writing the journal entry. Rather than restate that rule, each row names the capability the
 * owning capability already requires for its own edits, and `CAPABILITY_FOR_ACTION` resolves
 * `set_field_value` through this lookup. The mapping is copied from nothing: each value below is the
 * same capability `actionCapabilities.ts` puts on that entity's own update verb.
 *
 * `table` AND `idColumn` EXIST FOR TWO REASONS, both structural. They let `entityExists` prove a value
 * is being hung on a record that is really there (a value keyed to a deleted id is unreachable garbage
 * that still shows up in an export), and they let the reserved-key list be DERIVED from the real
 * columns rather than hand-maintained, which is what §6b asked for and what keeps it from drifting.
 */

import type { Capability } from '../access/capabilities.js';

/** One customizable entity. Four facts, and adding a fifth row is the entire opt-in. */
export interface EntityKindDef {
  /** The stable id used on the wire as `entityKind`. */
  readonly kind: string;
  /** The base table its records live in. Read for existence checks and for the reserved-key list. */
  readonly table: string;
  /** The primary-key column of that table. */
  readonly idColumn: string;
  /**
   * The column carrying the tenant id (§H-TENANT), when it is not the `workspace_id` every domain
   * table carries. Exactly one table is SELF-TENANT: `workspace`, whose own primary key IS the
   * tenant, so its row reads `tenantColumn: 'id'` and the existence check degenerates to "the
   * record is the current workspace itself", which is the right boundary (a mandate's custom
   * fields live in its own book, never written from inside another). A DECLARED column on the row,
   * never a switch on the kind: G00's central claim survives because `fields.ts` still reads one
   * registry fact per kind (see `tenantColumnOf`).
   */
  readonly tenantColumn?: string;
  /**
   * The capability an actor needs to change this entity's own data, and therefore the capability
   * `set_field_value` inherits. NEVER a G00 capability: a custom field is not a back door.
   */
  readonly editCapability: Capability;
  /**
   * The field TYPES this kind admits, when it admits fewer than all of `FIELD_TYPES`. A DECLARED
   * REGISTRY FACT, not a switch: `defineField` consults it generically (one fact per kind, the
   * `tenantColumn` shape), so G00's central claim survives. Absent means every type, which is the
   * default every ordinary kind keeps. The first consumer is E04's `mail_thread` (spec §6b): a
   * zero-egress kind refuses free-form shapes (`text`, `number`, `money`, `contact_ref`,
   * `entity_ref`) because a free-text field is the one shape that could smuggle a pasted excerpt
   * of confidential correspondence into `custom_field_values` and quietly defeat OP6's
   * index-never-copy and the US-E04.5 erasure property; a bounded enum value cannot hold a body.
   */
  readonly fieldTypes?: readonly string[];
}

/**
 * The registry, in the order the Anpassung surface groups its sections.
 *
 * Master data first, because that is what a workspace actually tags: a "Segment" on a customer, a
 * "Lieferant" reference on an item. The money-path entities are last and are deliberately included
 * rather than withheld: a custom field on a journal entry is data ABOUT the entry, it changes no
 * figure, and refusing it would push people back to the description field where nothing is typed or
 * queryable. `editCapability` is what keeps that honest.
 */
export const ENTITY_KINDS: readonly EntityKindDef[] = [
  { kind: 'contact', table: 'contact', idColumn: 'id', editCapability: 'manage_master_data' },
  { kind: 'item', table: 'item', idColumn: 'id', editCapability: 'manage_master_data' },
  { kind: 'bank_account', table: 'bank_account', idColumn: 'id', editCapability: 'manage_master_data' },
  { kind: 'account', table: 'account', idColumn: 'id', editCapability: 'manage_chart' },
  { kind: 'cost_center', table: 'cost_center', idColumn: 'id', editCapability: 'manage_chart' },
  { kind: 'document', table: 'document', idColumn: 'id', editCapability: 'issue' },
  { kind: 'payment', table: 'payment', idColumn: 'id', editCapability: 'pay' },
  { kind: 'journal_entry', table: 'journal_entry', idColumn: 'id', editCapability: 'post' },
  // G01, and the first row added by a capability OTHER than the one that owns this file, which is
  // what this module was built to make cheap. G01's own agent could not write it (`entities.ts` was
  // not its file) and reported the gap against itself instead. Verified against
  // `src/core/automation/schema.ts` rather than copied from that report: the table really is
  // `automation_rule` and its primary key really is `id`.
  { kind: 'automation_rule', table: 'automation_rule', idColumn: 'id', editCapability: 'manage_automations' },
  // A17, the creditor side, and the second row added by a capability other than the one that owns this
  // file. `post` and not `manage_master_data`: a vendor bill is not master data, it is a posting in
  // waiting, and `actionCapabilities.ts` gates all five A17 writes on `post` for exactly that reason.
  // Verified against `src/core/purchase/schema.ts` rather than copied from a report: the table really is
  // `vendor_bill` and its primary key really is `id`. `READ_FOR_EDIT_CAPABILITY` already answers `post`,
  // so its three G00 reads resolve to `read_books` with no edit in A24.
  { kind: 'vendor_bill', table: 'vendor_bill', idColumn: 'id', editCapability: 'post' },
  // A15, the spec's own §6b examples (an Inkassobüro reference, a follow-up owner). `dun` because a
  // dunning run's OWN writes gate on `dun`, so a custom field on one is exactly as hard to write as
  // the run it annotates; the read side resolves through READ_FOR_EDIT_CAPABILITY's `dun` row
  // (`read_sales`), which A24's load-time guard demands in the same commit. Verified against
  // `src/core/dunning/schema.ts`: the table really is `dunning_run` and its primary key is `id`.
  { kind: 'dunning_run', table: 'dunning_run', idColumn: 'id', editCapability: 'dun' },
  // A12, and the third row added by a capability other than the one that owns this file. `issue`
  // and not `manage_master_data`: a schedule is an invoice generator, and every A12 write is gated
  // on `issue` in `actionCapabilities.ts`, so a custom field on a schedule is exactly as hard to
  // write as the schedule itself. Verified against `src/core/recurring/schema.ts`: the table
  // really is `recurring_schedule` and its primary key really is `id`. `READ_FOR_EDIT_CAPABILITY`
  // already answers `issue` with `read_sales`, so the G00 reads resolve with no edit in A24.
  { kind: 'recurring_schedule', table: 'recurring_schedule', idColumn: 'id', editCapability: 'issue' },
  // A21, the matching queue's review-decision metadata (spec §6b: a review note, a "reviewed by"
  // reference, never a shadow of the matching columns). `pay` because the row's OWN writes gate on
  // `pay`: annotating a match decision is exactly as hard as making one, the A15 reasoning one
  // capability over. The read side resolves through READ_FOR_EDIT_CAPABILITY's `pay` row
  // (`read_sales`). Verified against `src/core/banking/qrMatchSchema.ts`: the table really is
  // `reconciliation_match` and its primary key really is `id`.
  { kind: 'reconciliation_match', table: 'reconciliation_match', idColumn: 'id', editCapability: 'pay' },
  // A20, the imported transaction (spec §6b: an internal category tag, a "reviewed by" reference,
  // never `bank_statement` or `reconciliation_match`'s own matching columns, which A20 §6b Fixed
  // reserves). `pay` for the A15/A21 reasoning one capability over: annotating a bank txn is exactly
  // as hard as deciding it (`confirm_match`/`create_entry_for_txn` both gate on `pay`+`post`, and the
  // A21 row it may already carry gates on `pay`). Verified against `src/core/banking/camtSchema.ts`:
  // the table really is `bank_txn` and its primary key really is `id`.
  { kind: 'bank_txn', table: 'bank_txn', idColumn: 'id', editCapability: 'pay' },
  // A18, creditor payments: a payment run's own metadata (spec §6b: a purpose note, an approver
  // name, an internal batch reference distinct from the bank's own MsgId). `pay` because the row's
  // OWN writes (`create_payment_batch`) gate on `pay`, the same reasoning A21's `reconciliation_match`
  // row one line up gives. Verified against `core/banking/pain001Schema.ts`: the table really is
  // `payment_batch` and its primary key really is `id`.
  { kind: 'payment_batch', table: 'payment_batch', idColumn: 'id', editCapability: 'pay' },
  // A23, the client roster (spec §6b: per-mandate metadata a Treuhänder hangs on a client book, e.g.
  // a mandate type, an engagement-letter date, a risk rating; never `legal_form`, `vat_method`,
  // `base_currency` or `archived`, which stay single-sourced on the row itself). `manage_settings`
  // because the workspace's OWN lifecycle write (`archive_workspace`) gates on it: annotating a
  // mandate is exactly as hard as governing one. `READ_FOR_EDIT_CAPABILITY` gains the matching
  // `read_master_data` row in the same commit (the `get_company_profile` domain: the roster entry is
  // the profile's lighter sibling). Verified against `src/core/store/schema.ts`: the table really is
  // `workspace` and its primary key really is `id`.
  { kind: 'workspace', table: 'workspace', idColumn: 'id', editCapability: 'manage_settings', tenantColumn: 'id' },
  // A25 review & export. `review` because a review event's OWN writes (comment/flag/approve) gate on
  // `review`: hanging a custom "Risk" or "Follow-up" field on a review row is exactly as hard as
  // writing the row it annotates, the A15/A21 reasoning one capability over. The read side resolves
  // through READ_FOR_EDIT_CAPABILITY's `review` row (`read_books`, added in the same commit, which
  // the A24 load-time guard demands): review metadata annotates the books, so reading its fields is
  // reading the books. Verified against `src/core/review/schema.ts`: the table really is
  // `entry_review` and its primary key really is `id`.
  { kind: 'entry_review', table: 'entry_review', idColumn: 'id', editCapability: 'review' },
  // G10, the Zuordnungsvorlage (spec §6b: a "Mandant" note, a "Quellsystem-Version" select, so a
  // Treuhänder can annotate which template fits which vintage of a source system). `manage_import`
  // because the template's OWN writes gate on it; `READ_FOR_EDIT_CAPABILITY` gains the matching
  // row in the same commit (the A24 load-time guard demands it). The table is OPERATOR-scoped by
  // design (its whole purpose is to cross client workspaces, fenced by carrying no client
  // figures), so its `tenantColumn` is the provenance column `created_in_workspace_id`: custom
  // fields attach from the workspace a template was created in, and the deliberate absence of a
  // `workspace_id` column is what keeps the generic §H-TENANT probe honest about the design.
  // Verified against `src/core/migration/schema.ts`: the table really is `migration_map_template`
  // and its primary key really is `id`.
  {
    kind: 'migration_map_template',
    table: 'migration_map_template',
    idColumn: 'id',
    editCapability: 'manage_import',
    tenantColumn: 'created_in_workspace_id',
  },
  // G09, the migration harness (spec §4/§6b): a plan and a step are both OP3 kinds, so a Treuhänder
  // can hang a "Verantwortlich für die Übernahme" text or a "Quellsystem" select on either and query
  // it later when auditing how a client's data arrived. `manage_import` because the plan/step's OWN
  // writes gate on it, so a custom field is exactly as hard to write as the record it annotates;
  // `READ_FOR_EDIT_CAPABILITY` already answers `manage_import` -> `manage_import` (the G10 row), which
  // the A24 load-time guard demands. Both tables are workspace_id-scoped, so no tenantColumn override.
  // Verified against `src/core/migration/schema.ts`: the tables are `migration_plan` / `migration_step`
  // and each primary key is `id`.
  { kind: 'migration_plan', table: 'migration_plan', idColumn: 'id', editCapability: 'manage_import' },
  { kind: 'migration_step', table: 'migration_step', idColumn: 'id', editCapability: 'manage_import' },
  // G11 Eröffnungsprüfung (spec §4/§6b): a persisted check is an OP3 kind, so a Treuhänder can hang
  // a text "Von Treuhänder geprüft" or a date "Freigabe erteilt am" on the artifact they sign and
  // query it later across mandates. `manage_import` because the check's OWN writes gate on it (the
  // G09/G10 reasoning one row up); `READ_FOR_EDIT_CAPABILITY` already answers `manage_import` ->
  // `manage_import` (the G10 row), which the A24 load-time guard demands. Custom fields annotate
  // the check record; the snapshot in `controls` and its hash stay append-only and untouchable.
  // Verified against `src/core/migration/schema.ts`: the table really is `migration_check`, its
  // primary key really is `id`, and it is workspace_id-scoped, so no tenantColumn override.
  { kind: 'migration_check', table: 'migration_check', idColumn: 'id', editCapability: 'manage_import' },
  // G19, the extraction companion (spec §4/§6b): the export-completeness manifest is an OP3 kind, so
  // a Treuhänder can hang a "Wer exportiert" assignee or a per-item note as custom fields and save
  // views over the checklist ("Offene Exporte", "Blockiert"). A custom field ANNOTATES; the item
  // statuses, the E00 fileIds and the deletion clock stay the manifest's own columns/JSON.
  // `manage_import` because the manifest's OWN writes gate on it, so a custom field is exactly as
  // hard to write as the record it annotates; `READ_FOR_EDIT_CAPABILITY` already answers
  // `manage_import` -> `manage_import` (the G10 row), which the A24 load-time guard demands. Verified
  // against `src/core/migration/manifestSchema.ts`: the table really is
  // `migration_extraction_manifest`, its primary key really is `id`, and it is workspace_id-scoped,
  // so no tenantColumn override.
  { kind: 'migration_extraction_manifest', table: 'migration_extraction_manifest', idColumn: 'id', editCapability: 'manage_import' },
  // G13 GL archive (spec §6b): an archive entry carries custom FIELDS (a "Prüfvermerk" a Treuhänder
  // attaches during due diligence) and saved VIEWS ("Vorsystem 2023", "Unbalancierte Einträge" over
  // `gl_archive_query`). A field ANNOTATES, it never alters: the archived values themselves sit
  // behind BEFORE-triggers and cannot move, so this row opens no door GeBüV Art. 9 closed.
  // `commit_migration` because importing the entry is what minted it, so annotating imported history
  // is exactly as hard as importing it; the read side resolves through `READ_FOR_EDIT_CAPABILITY`'s
  // `commit_migration` row (`read_books`), which the A24 load-time guard demands in the same commit.
  // Verified against `src/core/migration/archiveSchema.ts`: the table really is `gl_archive_entry`
  // and its primary key really is `id`.
  { kind: 'gl_archive_entry', table: 'gl_archive_entry', idColumn: 'id', editCapability: 'commit_migration' },
  // B00, projects master (spec §4/§6b): a project AND its phase are both OP3 kinds, so documents
  // (E00), tasks (E03), activities and OP7 custom fields ("Projekttyp" select, "Health" indicator,
  // a phase-level "Verantwortlich" contact_ref) attach to either, and OP10 saved views scope the
  // Projekte list. `manage_master_data` because the project's OWN writes gate on it in
  // `actionCapabilities.ts`, so a custom field on a project is exactly as hard to write as the
  // project; `READ_FOR_EDIT_CAPABILITY` already answers `manage_master_data` -> `read_master_data`
  // (the C00/D00 row), so the G00 reads resolve with no new A24 edit. Verified against
  // `src/core/projects/schema.ts`: the tables really are `project` / `project_phase` and each
  // primary key really is `id`; both are workspace_id-scoped, so no tenantColumn override. A custom
  // field can never express `PROJECT_STATUS` or any other §H-ENUM state (spec §6b, fixed).
  { kind: 'project', table: 'project', idColumn: 'id', editCapability: 'manage_master_data' },
  { kind: 'project_phase', table: 'project_phase', idColumn: 'id', editCapability: 'manage_master_data' },
  // E03 tasks & reminders (spec §6b: a `priority` select, a `project_tag` text, workspace-defined
  // task categories as select/multiselect fields, never a shadow of the fixed `status` enum). The
  // spec's own §7 claimed this row already existed; it did not, so E03 registers it (reconciled
  // 04.08.2026). `tasks.write` because a task's OWN writes gate on it: annotating a task is exactly
  // as hard as editing one. `READ_FOR_EDIT_CAPABILITY` gains the matching `tasks.read` row in the
  // same commit, which the A24 load-time guard demands. Verified against `src/core/tasks/schema.ts`:
  // the table really is `task` and its primary key really is `id`; workspace_id-scoped, so no
  // tenantColumn override.
  { kind: 'task', table: 'task', idColumn: 'id', editCapability: 'tasks.write' },
  // B01 time tracking (spec §6b: a "Work type" select beyond the base billable flag, an internal
  // cost-center override, a client-visible-notes flag; never a shadow of the fixed status machine,
  // the rate snapshot columns or the ArG record columns, which every one of §6b's Fixed bullets
  // reserves). `time.write` because an entry's OWN writes gate on it: annotating captured time is
  // exactly as hard as capturing it. `READ_FOR_EDIT_CAPABILITY` gains the matching `time.read` row
  // in the same commit, which the A24 load-time guard demands. Verified against
  // `src/core/time/schema.ts`: the table really is `time_entry` and its primary key really is
  // `id`; workspace_id-scoped, so no tenantColumn override.
  { kind: 'time_entry', table: 'time_entry', idColumn: 'id', editCapability: 'time.write' },
  // C01 leads & deals (spec §4/§6b: an "Umsatzquelle" select, a "Partner" contact_ref, a board
  // grouping tag, never a shadow of the fixed DEAL_STATUSES enum or the frozen §H-FX trio, which
  // stay single-sourced on the row). The spec's own §4 claimed this row already existed; it did
  // not, so C01 registers it (reconciled 04.08.2026, the E03 shape one row up). `deals.write`
  // because a deal's OWN writes gate on it: annotating a deal is exactly as hard as editing one.
  // `READ_FOR_EDIT_CAPABILITY` gains the matching `deals.read` row in the same commit, which the
  // A24 load-time guard demands. Verified against `src/core/deals/schema.ts`: the table really is
  // `deal` and its primary key really is `id`; workspace_id-scoped, so no tenantColumn override.
  { kind: 'deal', table: 'deal', idColumn: 'id', editCapability: 'deals.write' },
  // D01 inventory / stock (spec §4/§6b): a stock LOCATION and a STOCKTAKE session are both OP3 kinds,
  // so custom fields (a zone/aisle or contact-person on a location, a counted-by note on a stocktake)
  // and saved views attach to either, and an operator files the committed stocktake as an E00 Inventar
  // via `files_link` on `entity_kind: stocktake`. `manage_master_data` because each kind's OWN writes
  // gate on it in `actionCapabilities.ts`, so a custom field is exactly as hard to write as the row it
  // annotates; `READ_FOR_EDIT_CAPABILITY` already answers `manage_master_data` -> `read_master_data`
  // (the C00/D00/B00 row), so the G00 reads resolve with no new A24 edit. A custom field can never
  // express `STOCK_REASON`, `VALUATION_METHOD` or `STOCKTAKE_STATUS` (spec §6b, fixed §H-ENUMs).
  // Verified against `src/core/stock/schema.ts`: the tables are `stock_location` / `stocktake_session`
  // and each primary key is `id`; both are workspace_id-scoped, so no tenantColumn override. The
  // `item` kind (registered above) is the third D01 attachment surface and is already present.
  { kind: 'stock_location', table: 'stock_location', idColumn: 'id', editCapability: 'manage_master_data' },
  { kind: 'stocktake', table: 'stocktake_session', idColumn: 'id', editCapability: 'manage_master_data' },
  // C02 quotes / proposals (spec §4/§6b): a quote AND its line are both OP3 kinds, so a "Projekt-
  // Referenz" or "Vertriebskanal" tag attaches to the quote and a delivery-lead-time or supplier-SKU
  // to a line, plus OP10 saved views over the Offerten list. The spec's own §4/OP3 claimed `quote` was
  // already registered; it was NOT (reconciled 2026-08-04), so C02 registers BOTH. Each rides the
  // SHARED A10 table its rows live in (`document` / `document_line`), the same table A10's own
  // `document` kind uses, because a quote is a document `type='quote'` and its lines are
  // `document_line` rows: distinct custom-field NAMESPACES on a shared table, never a fork. `issue`
  // because a quote's OWN writes gate on `issue` (a custom field is exactly as hard to write as the
  // quote it annotates); `READ_FOR_EDIT_CAPABILITY` already answers `issue` -> `read_sales`, so the
  // G00 reads resolve with no new A24 edit. A custom field can never express `document.status`/`.type`
  // or the OR Art. 3 binding window (spec §6b, fixed §H-ENUMs). Verified against
  // `src/core/store/schema.ts`: the tables are `document` / `document_line`, each primary key is `id`,
  // and both are workspace_id-scoped, so no tenantColumn override.
  { kind: 'quote', table: 'document', idColumn: 'id', editCapability: 'issue' },
  { kind: 'quote_line', table: 'document_line', idColumn: 'id', editCapability: 'issue' },
  // D03 sales orders & delivery notes (spec §4/§6b/§7): a sales order and a delivery note are both
  // OP3 kinds, so a "Interne Projekt-Referenz"/"Priorität" on an order and a "Frachtführer"/
  // "Tracking-Nummer" on a delivery note attach as custom fields, plus OP10 saved views over the
  // Aufträge list. The spec's own §7 claimed `sales_order` was already registered and `delivery_note`
  // was "added there"; NEITHER existed (reconciled 2026-08-04), so D03 registers BOTH. Each rides its
  // OWN table (`sales_order` / `delivery_note`), unlike the quote pair which shares A10's `document`.
  // `issue` because an order's OWN writes gate on `issue` (a custom field is exactly as hard to write
  // as the order it annotates, the C02 reasoning one family over); `READ_FOR_EDIT_CAPABILITY` already
  // answers `issue` -> `read_sales`, so the G00 reads resolve with no new A24 edit. A custom field can
  // never express `SO_STATUS`/`DN_STATUS` or the order -> delivery -> invoice sequencing (spec §6b,
  // fixed §H-ENUMs). Verified against `src/core/sales/salesOrderSchema.ts`: the tables really are
  // `sales_order` / `delivery_note`, each primary key is `id`, and both are workspace_id-scoped, so no
  // tenantColumn override. E00 links (the rendered Lieferschein) key against `delivery_note`.
  { kind: 'sales_order', table: 'sales_order', idColumn: 'id', editCapability: 'issue' },
  { kind: 'delivery_note', table: 'delivery_note', idColumn: 'id', editCapability: 'issue' },
  // D02 purchasing (spec §4/§6b): the purchase order is an OP3 kind, so an internal requisition
  // reference, a "Projektbezug" tag or a buyer note attach as custom fields, plus OP10 saved views
  // over the Einkauf list. The spec's own §4 CLAIMED `po` was already registered; it was NOT
  // (reconciled 2026-08-04, the D03 shape one family over), so D02 registers it. `manage_master_data`
  // because a PO's OWN writes gate on it in `actionCapabilities.ts` (D02 posts nothing, so `post` is
  // wrong and `issue` is sales-side): a custom field on a PO is exactly as hard to write as the PO it
  // annotates; `READ_FOR_EDIT_CAPABILITY` already answers `manage_master_data` -> `read_master_data`
  // (the C00/D00/D01 row), so the G00 reads resolve with no new A24 edit. A custom field can never
  // express `qty`, `unit_price_rappen`, `tax_code` or `purchase_order.status` (spec §6b, fixed §H-ENUMs).
  // Verified against `src/core/purchase/purchaseOrderSchema.ts`: the table really is `purchase_order`
  // and its primary key really is `id`; workspace_id-scoped, so no tenantColumn override.
  { kind: 'po', table: 'purchase_order', idColumn: 'id', editCapability: 'manage_master_data' },

  // E02 HR-lite (spec §4/§6b): `employee` and `expense_claim` are OP7 custom-field surfaces (a "cost
  // center note" or badge number on a person, a "Genehmigungsnotiz" or project reference on a claim),
  // and all three (`employee`/`absence`/`expense_claim`) are OP10 saved-view surfaces over the three
  // Personal tabs. The spec's §4/§7 claimed `expense_claim` was already registered; it was NOT
  // (reconciled 2026-08-04), so E02 registers all THREE. `employee`/`absence` edit under `hr.manage`
  // (their own writes gate on it, so a custom field is exactly as hard to write as the record it
  // annotates); `expense_claim` edits under `spesen.submit` (its base drafting write). A custom field
  // can never express `ahv_nr`, the absence `kind`/`status` §H-ENUM, or the claim `status` machine
  // (spec §6b Fixed): the reserved-key list is derived from the real columns, and the self-scoping
  // read gate (`hr_absence_list`/`expense_claim_list`) is never widened by a saved view.
  // `READ_FOR_EDIT_CAPABILITY` gains the `hr.manage -> hr.read` and `spesen.submit -> hr.read` rows
  // in the same commit, which the A24 load-time guard demands. Verified against `src/core/hr/schema.ts`:
  // the tables are `employee` / `absence` / `expense_claim`, each primary key is `id`, and all three
  // are workspace_id-scoped, so no tenantColumn override.
  { kind: 'employee', table: 'employee', idColumn: 'id', editCapability: 'hr.manage' },
  { kind: 'absence', table: 'absence', idColumn: 'id', editCapability: 'hr.manage' },
  { kind: 'expense_claim', table: 'expense_claim', idColumn: 'id', editCapability: 'spesen.submit' },
  // B04 retainers & mandates (spec §4/§6b): the mandate agreement is an OP3 kind, so a Treuhänder can
  // hang an account-manager tag, a "Vertragsreferenz" or a renewal-review date on it and query it
  // later across mandates, plus OP10 saved views over the Mandate list. `retainer.manage` because the
  // retainer's OWN writes gate on it: a custom field on a mandate is exactly as hard to write as the
  // mandate it annotates; `READ_FOR_EDIT_CAPABILITY` gains the `retainer.manage -> billing.read` row
  // in the same commit (a retainer is a billing surface), which the A24 load-time guard demands. A
  // custom field can never express the `period`/`status` or draw `kind` §H-ENUM, or the
  // coverage/cap/rollover computation (spec §6b, fixed). Verified against
  // `src/core/retainers/schema.ts`: the table really is `retainer` and its primary key really is
  // `id`; workspace_id-scoped, so no tenantColumn override.
  { kind: 'retainer', table: 'retainer', idColumn: 'id', editCapability: 'retainer.manage' },
  // E01 e-signature (spec §6b: an internal reference number, the counterparty's legal entity name,
  // a contract-type tag; never a shadow of the fixed SIGN_REQUEST_STATUS or SIGNATURE_LEVEL
  // §H-ENUMs, both legal-tracking states). The spec's §6b used to claim this row already existed;
  // it did NOT (reconciled 2026-08-04, the E03/C01 shape), so E01 registers it, and E03 tasks
  // ("chase the signer") and OP5 activities can now link to a request. `sign.write` because a
  // request's OWN writes gate on it: annotating a sign request is exactly as hard as editing one.
  // `READ_FOR_EDIT_CAPABILITY` gains the matching `read_master_data` row in the same commit (the
  // filing read domain E01's own reads answer), which the A24 load-time guard demands. Verified
  // against `src/core/sign/schema.ts`: the table really is `sign_request` and its primary key
  // really is `id`; workspace_id-scoped, so no tenantColumn override.
  { kind: 'sign_request', table: 'sign_request', idColumn: 'id', editCapability: 'sign.write' },
  // F02 customer portal (spec §4/§6b): a portal grant is a new OP3 kind, so an operator can hang an
  // internal "Grund der Freigabe" note, an "angefragt von" contact reference, or a ticket-number tag
  // on one and query it later for a revDSG access-trail review, plus OP10 saved views over the
  // Portal-Zugang list ("Bald ablaufend", "Nicht gehostet"). A custom field can NEVER express the
  // token, the scopes that gate what a customer sees, or the expiry (spec §6b Fixed: the reserved-key
  // list is derived from the real columns, and a field plays no part in the resolver's three-fence
  // check). `portal.manage` because a grant's OWN writes gate on it, so a custom field on a grant is
  // exactly as hard to write as the grant it annotates; `READ_FOR_EDIT_CAPABILITY` gains the matching
  // `portal.manage -> read_master_data` row in the same commit, which the A24 load-time guard demands.
  // Verified against `src/core/portal/schema.ts`: the table really is `portal_grant`, its primary key
  // really is `id`, and it is workspace_id-scoped, so no tenantColumn override. F03 shares the table
  // with `kind='vendor'` but keys its own custom fields off the same `portal_grant` entity kind.
  { kind: 'portal_grant', table: 'portal_grant', idColumn: 'id', editCapability: 'portal.manage' },
  // F03 vendor portal (spec §4/§6b): a remittance advice is a NEW OP3 kind F03 owns, so an E00
  // artifact (the rendered Zahlungsavis) links against it and OP10 saved views scope the advice
  // history ("Advices issued this quarter"). A custom field ANNOTATES an advice; it can NEVER express
  // the snapshot money columns (`total_rappen`/`amount_base_rappen`/`fx_rate`), which the reserved-key
  // list derives from the real columns and which the immutability trigger freezes. `portal.manage`
  // because the advice's OWN write (`vendor_portal_remittance_create`) gates on it, so a custom field
  // on an advice is exactly as hard to write as the advice it annotates; `READ_FOR_EDIT_CAPABILITY`
  // already answers `portal.manage -> read_master_data` (the F02 row), so the G00 reads resolve with
  // no new A24 edit. Verified against `src/core/portal/remittanceSchema.ts`: the table really is
  // `remittance_advice`, its primary key really is `id`, and it is workspace_id-scoped, so no
  // tenantColumn override.
  { kind: 'remittance_advice', table: 'remittance_advice', idColumn: 'id', editCapability: 'portal.manage' },
  // F01 report builder (spec §7): a report_run is an OP3 kind so E00 documents can link a RETAINED run
  // (files_link entity_kind:'report_run') and a Treuhänder can hang a "Mandant" or "Freigabe erteilt"
  // custom field on a run they filed. `reports.run` because the run's OWN write (reports_run) gates on
  // it: annotating a run is exactly as hard as producing it, the retainer/sign reasoning one capability
  // over. `READ_FOR_EDIT_CAPABILITY` gains the matching `reports.run -> reports.read` row in the same
  // commit, which the A24 load-time guard demands. Verified against
  // `src/core/reportbuilder/schema.ts`: the table really is `report_runs` and its primary key really is
  // `id`; workspace_id-scoped, so no tenantColumn override. E00 currently classifies only
  // document/payment/journal_entry as accounting records, so a linked run's OR 958f auto-lock is an
  // E00 follow-up; the LINK, the document_id and the delete-refusal-when-locked are live today.
  { kind: 'report_run', table: 'report_runs', idColumn: 'id', editCapability: 'reports.run' },
  // E04 local mail store (spec §6b): a mail thread is an OP3 kind so a practitioner or agent can
  // hang ONE purely-local classifier on it (a triage label, a priority) and save views over the
  // Korrespondenz queue. `mail.write` because the thread's own writes gate on it: labelling
  // confidential correspondence is exactly as hard as drafting against it, and
  // `READ_FOR_EDIT_CAPABILITY` gains the matching `mail.read` row in the same commit, which the
  // A24 load-time guard demands. `fieldTypes` is the zero-egress inversion (§6b "fixed unless
  // provably leak-safe"): select/multiselect/bool/date only, because a bounded value cannot hold a
  // body, so it cannot leak one and cannot survive as orphaned personal data either
  // (`custom_field_value` rows on a thread join both the reindex self-heal and the C00 erasure
  // purge). Verified against `src/core/mail/schema.ts`: the table really is `mail_thread` and its
  // primary key really is `id`; workspace_id-scoped, so no tenantColumn override.
  {
    kind: 'mail_thread',
    table: 'mail_thread',
    idColumn: 'id',
    editCapability: 'mail.write',
    fieldTypes: ['select', 'multiselect', 'bool', 'date'],
  },
  // G04 data freedom (spec §6b): a backup-history row is an OP3 kind, so a Treuhänder can hang a
  // "Reason" select ("pre-migration", "year-end archive") or a "Keep until" date on a backup and
  // query it later, plus OP10 saved presets over the backup history. A custom field ANNOTATES; it
  // never touches what a backup FAITHFULLY copies (spec §6b Fixed). `manage_data_export` because the
  // row's OWN writes (create_backup/export_workspace/delete_backup) gate on it, so a field on a
  // backup is exactly as hard to write as the backup it annotates; `READ_FOR_EDIT_CAPABILITY` gains
  // the `manage_data_export -> manage_data_export` self-map in the same commit (there is no softer
  // read domain for the portability surface), which the A24 load-time guard demands. Verified
  // against `src/core/data/schema.ts`: the table really is `backups`, its primary key really is
  // `id`, and it is workspace_id-scoped, so no tenantColumn override.
  { kind: 'backup', table: 'backups', idColumn: 'id', editCapability: 'manage_data_export' },
  // G05 document templates (spec §4/§6b): a template is an OP3 kind, which is what gives it three
  // things in one line: custom fields (an internal "Owner"/approval note, a "Verwendungszweck" tag
  // on a seasonal template), saved views over the Vorlagen list ("Archivierte Offerten-Vorlagen"),
  // and the E00 LOGO link (`files_link` validates entityKind against this registry, so the logo is
  // an ordinary stored_file linked here: storage has exactly one owner and G05 duplicates no FK).
  // `manage_document_templates` because the template's OWN writes gate on it, so a custom field on
  // a template is exactly as hard to write as the template it annotates; `READ_FOR_EDIT_CAPABILITY`
  // gains the matching `read_master_data` row in the same commit, which the A24 load-time guard
  // demands. A custom field can never express `document_kind`, `language_mode`, `is_default` or the
  // frozen snapshot (spec §6b Fixed): the reserved-key list is derived from the real columns.
  // Verified against `src/core/customization/documentTemplateSchema.ts`: the table really is
  // `document_template` and its primary key really is `id`; workspace_id-scoped, so no tenantColumn
  // override.
  {
    kind: 'document_template',
    table: 'document_template',
    idColumn: 'id',
    editCapability: 'manage_document_templates',
  },
  // G06 notifications & inbox (spec §6b): an inbox item is the OP3 kind SAVED VIEWS key against
  // ("Nur ungelesen", "Nur Rechnungen" on the /inbox route), and a custom field on one annotates a
  // delivered moment without touching what was delivered. `manage_automations` because the row is
  // MINTED by the automation engine's delivery action (`notifications_deliver` gates on exactly
  // this capability), so annotating a delivery artifact is exactly as hard as managing the rules
  // that mint it; the read side resolves through `READ_FOR_EDIT_CAPABILITY`'s existing
  // `manage_automations -> read_automations` row, so no new A24 name is needed. The fixed columns
  // (`status`, `delivered_via`, `event`) are protected by the derived reserved-key list. Verified
  // against `src/core/notifications/schema.ts`: the table really is `inbox_item` and its primary
  // key really is `id`; workspace_id-scoped, so no tenantColumn override.
  { kind: 'inbox_item', table: 'inbox_item', idColumn: 'id', editCapability: 'manage_automations' },
  // G07 global search (spec §4): the ATTACHMENT-ONLY kind a saved search hangs off. A saved view
  // attaches to the KIND, not to a record, so `global_search` exists purely so
  // `create_saved_view({entityKind:'global_search', filters:{q, entityKinds}})` has a registry row
  // to validate against; it is never itself a search-adapter target. It rides the `workspace`
  // table's self-tenant shape (the A23 row's reasoning: the one record a workspace-level kind can
  // honestly point at is the workspace itself), so the G00 existence check resolves and a custom
  // field hung here annotates the workspace row, exactly as the `workspace` kind further up already
  // allows. `manage_settings` for the same reason as that row (annotating the workspace is
  // governing it); `READ_FOR_EDIT_CAPABILITY` already answers `manage_settings` ->
  // `read_master_data`. `fieldTypes` is the E04 bounded-shape posture: this kind is a saved-search
  // hook, not a data surface, so free-form field shapes (text/number/money/refs) have nothing
  // legitimate to annotate here and a bounded value cannot be misused as one.
  {
    kind: 'global_search',
    table: 'workspace',
    idColumn: 'id',
    tenantColumn: 'id',
    editCapability: 'manage_settings',
    fieldTypes: ['select', 'multiselect', 'bool', 'date'],
  },
  // G02 plugins (spec §4/§6b): an installed plugin is an OP3 kind, so an operator can hang an internal
  // "support contact" or "reviewed by" custom field on one, link a support-ticket document (E00), or
  // save views over the Erweiterungen list ("Nur inkompatible", "Nur Berichtsquellen"). A custom field
  // ANNOTATES; it can NEVER express the manifest contract (`capabilities`, `permissions`, `sha256`,
  // `status`, `compat_range`), which §6b Fixed reserves and the reserved-key list derives from the real
  // columns. `manage_plugins` because a plugin's OWN writes gate on it (installing third-party code is
  // owner-only by default), so a custom field on a plugin is exactly as hard to write as the plugin it
  // annotates; the read side resolves through READ_FOR_EDIT_CAPABILITY's `manage_plugins -> read_master_data`
  // row (a plugin is workspace configuration, the G05 document-template precedent), which the A24
  // load-time guard demands in the same commit. Verified against `src/core/plugins/schema.ts`: the table
  // really is `plugin_manifests`, its primary key really is `id`, and it is workspace_id-scoped, so no
  // tenantColumn override.
  { kind: 'plugin', table: 'plugin_manifests', idColumn: 'id', editCapability: 'manage_plugins' },
  // G05 §10, the send-log row (spec §10.6b: a follow-up note on a disputed send, a "Klärung offen"
  // select), NEVER the logged send itself: `dispatches` is append-only through the verb surface and
  // its own columns (recipient, resolved text, outcome, sent_at) stay untouchable by any
  // customization. `manage_dispatch_texts` because the dispatch surface's OWN write gates on it, so
  // annotating a send is exactly as hard as managing the outbound voice; the read side resolves
  // through READ_FOR_EDIT_CAPABILITY's `manage_dispatch_texts -> read_master_data` row, which the
  // A24 load-time guard demands in the same commit. Verified against
  // `src/core/customization/dispatchSchema.ts`: the table really is `dispatches`, its primary key
  // really is `id`, and it is workspace_id-scoped, so no tenantColumn override.
  { kind: 'dispatch', table: 'dispatches', idColumn: 'id', editCapability: 'manage_dispatch_texts' },
  // A31 document capture (spec §4/§6b): a capture is an OP3 kind, so an operator can hang an internal
  // "Projektbezug" tag, a scanning-batch reference or a "checked against order" note on a queue row and
  // save views over the Belegeingang ("Zu prüfen diese Woche", "Committed without Swico data"). A custom
  // field ANNOTATES; it can NEVER express a CAPTURE_FIELD_KEY value or shadow `status`/`provenance`/
  // `confidence` (spec §6b Fixed: the reserved-key list is derived from the real columns, so the
  // extraction-truth columns are off limits). `manage_files` because a capture's OWN writes gate on it
  // (a capture is a document-store record, the E00 write right): a custom field on a capture is exactly
  // as hard to write as the capture it annotates. `READ_FOR_EDIT_CAPABILITY` gains the matching
  // `manage_files -> read_master_data` row in the same commit, which the A24 load-time guard demands.
  // Verified against `src/core/purchase/captureSchema.ts`: the table really is `captures`, its primary
  // key really is `id`, and it is workspace_id-scoped, so no tenantColumn override.
  { kind: 'capture', table: 'captures', idColumn: 'id', editCapability: 'manage_files' },
  // A34 payroll hand-off (spec §4/§6b): the export EVENT is an OP3 kind, so an operator can hang a
  // "Provider" select or a "Periode-Notiz" text on a hand-off record and save views over the history
  // ("Exporte ohne AHV", "Gebuchte Monate"). A custom field ANNOTATES the export event; it can NEVER
  // carry a person's wage (the entity is the export, not the people in it) nor widen the AHV gate
  // (§6b Fixed, revDSG Art. 6). `hr.manage` because the export's OWN write gates on it, so a custom
  // field on a hand-off is exactly as hard to write as the hand-off it annotates, and it reuses the
  // existing `hr.manage -> hr.read` READ_FOR_EDIT row (E02). Verified against
  // `src/core/payroll/handoffSchema.ts`: the table really is `payroll_handoff_exports`, its primary
  // key really is `id`, and it is workspace_id-scoped, so no tenantColumn override.
  { kind: 'payroll_handoff', table: 'payroll_handoff_exports', idColumn: 'id', editCapability: 'hr.manage' },
  // A32, the eBill delivery record (spec §6b): custom fields annotate a delivery (a "Freigabe-Referenz"
  // text, a "Kanal-Notiz", a select tagging why a customer prefers eBill) and saved views group the
  // delivery read model ("Abgelehnte eBill-Zustellungen", "Übermittelt, noch nicht freigegeben"). A
  // field can NEVER express `status`, `partner_status` or the payload bytes (spec §6b Fixed: single-
  // sourced under §H-ENUM or mirrored verbatim from the partner). `issue` because a delivery's OWN
  // writes gate on it (`ebill_prepare`): annotating a delivery is exactly as hard as preparing one.
  // `READ_FOR_EDIT_CAPABILITY` already answers `issue` with `read_sales`, so the G00 reads resolve with
  // no new A24 row. Verified against `src/core/sales/ebillSchema.ts`: the table really is
  // `ebill_deliveries`, its primary key is `id`, and it is workspace_id-scoped (no tenantColumn override).
  { kind: 'ebill_delivery', table: 'ebill_deliveries', idColumn: 'id', editCapability: 'issue' },
  // A33, the EBICS bank channel (spec §4/§6b). TWO kinds, the shared-file OP3 edit §3 names:
  // `ebics_connection` so E00 documents (the INI letter, fetched statements), E03 tasks and OP7 custom
  // fields (a contract number, the relationship manager as a contact_ref, an internal review note) can
  // attach to a channel; `ebics_order` so §6b's saved views over the order log have a registered kind.
  // A custom field can NEVER express host/partner/user IDs, key references, hashes, BTF parameters or
  // the state enum (spec §6b Fixed, tripwire). `pay` is the banking-write capability the channel's OWN
  // verbs gate on (`bank_channel_connect` etc.), the `payment_batch` precedent one capability over.
  // The registry names the ENTITY; `ebics_order` maps to the TABLE `ebics_order_log` (stated here so
  // the two never drift, spec §4). Verified against `src/core/banking/ebics/schema.ts`.
  { kind: 'ebics_connection', table: 'ebics_connection', idColumn: 'id', editCapability: 'pay' },
  { kind: 'ebics_order', table: 'ebics_order_log', idColumn: 'id', editCapability: 'pay' },
  // A37, the managed bank channel (spec §4/§6b), the EBICS twins one rail over. TWO kinds:
  // `managed_connection` so E00 documents (the fetched bLink statements), E03 tasks and OP7 custom
  // fields (the cost center paying the tier, the bank relationship contact as a contact_ref) can
  // attach to a managed channel; `managed_order` so §6b's saved views over the order log ("Pending
  // release", "Rejected this quarter") have a registered kind. A custom field can NEVER express the
  // provider, bank_ref, consent reference, scopes or the state enum (spec §6b Fixed, tripwire). `pay`
  // is the banking-write capability the channel's OWN verbs gate on (the `ebics_connection` precedent
  // one rail over). The registry names the ENTITY; `managed_order` maps to the TABLE `managed_order_log`
  // (stated here so the two never drift). Verified against `src/core/banking/managed/schema.ts`.
  { kind: 'managed_connection', table: 'managed_connection', idColumn: 'id', editCapability: 'pay' },
  { kind: 'managed_order', table: 'managed_order_log', idColumn: 'id', editCapability: 'pay' },
  // H00, fixed-asset categories (spec §6): a category is an OP3 kind, so an operator can hang an
  // internal "Anlagenklasse"/"Kostenstellen-Hinweis" custom field on one and save views over the
  // Settings list ("Nur aktive", "Ohne Restwert"). A custom field ANNOTATES; it can NEVER express the
  // depreciation method, useful life, residual rule or the three GL account ids (those are the
  // category's real columns and the reserved-key list is derived from them). `manage_master_data`
  // because a category's OWN writes gate on it, so a custom field on a category is exactly as hard to
  // write as the category it annotates; `READ_FOR_EDIT_CAPABILITY` already answers `manage_master_data`
  // -> `read_master_data` (the item/contact row), so the G00 reads resolve with no new A24 edit.
  // Verified against `src/core/assets/schema.ts`: the table really is `asset_category`, its primary
  // key really is `id`, and it is workspace_id-scoped, so no tenantColumn override.
  { kind: 'asset_category', table: 'asset_category', idColumn: 'id', editCapability: 'manage_master_data' },
  // H01, the fixed-asset master (spec §2/§6): an asset is an OP3 kind, so an operator can hang an
  // internal "Versicherungspolice"/"Standort-Detail" custom field on one and save views over the
  // Register ("Nur aktive", "Anschaffung 2026"). A custom field ANNOTATES; it can NEVER express the
  // financial baseline (acquisition cost/date, the depreciation trio, the three GL account ids) or the
  // status machine, which are the asset's real columns and the reserved-key list is derived from them,
  // so a field can never smuggle a second, mutable copy of a value the immutability rule freezes.
  // `manage_master_data` because the asset's OWN writes gate on it (the H00 asset_category precedent
  // one entity up), so a custom field on an asset is exactly as hard to write as the asset it
  // annotates; `READ_FOR_EDIT_CAPABILITY` already answers `manage_master_data` -> `read_master_data`,
  // so the G00 reads resolve with no new A24 edit. Verified against `src/core/assets/masterSchema.ts`:
  // the table really is `asset`, its primary key really is `id`, and it is workspace_id-scoped, so no
  // tenantColumn override.
  { kind: 'asset', table: 'asset', idColumn: 'id', editCapability: 'manage_master_data' },
  // I00, requisitions (spec §6): the internal-demand document is an OP3 kind, so an operator can hang
  // an internal reference, a "Beschaffungsgrund" or a budget-line tag on one and save views over the
  // Einkauf -> Anforderungen list ("Meine Anforderungen", "Wartet auf Freigabe"). A custom field
  // ANNOTATES; it can NEVER express the status machine, urgency, the estimated totals or the
  // converted quantity (those are the requisition's real columns and the reserved-key list is derived
  // from them). `manage_master_data` because a requisition's OWN writes gate on it (the D02 `po` row
  // one family over), so a custom field is exactly as hard to write as the requisition it annotates;
  // `READ_FOR_EDIT_CAPABILITY` already answers `manage_master_data` -> `read_master_data` (the item/
  // contact/po row), so the G00 reads resolve with no new A24 edit. Verified against
  // `src/core/procurement/schema.ts`: the table really is `requisition`, its primary key really is
  // `id`, and it is workspace_id-scoped, so no tenantColumn override.
  { kind: 'requisition', table: 'requisition', idColumn: 'id', editCapability: 'manage_master_data' },
  // I02, goods receipts (spec §6): the physical-receipt document is an OP3 kind, so an operator can
  // hang a carrier, a delivery-note number or a pallet count on one and save views over the Einkauf
  // -> Wareneingänge list ("Offene Entwürfe", "Zur Prüfung"). A custom field ANNOTATES; it can
  // NEVER express the status machine, the received quantity, the inspection state or the movement
  // link, which are the receipt's real columns and the reason it is a money-path document.
  // `manage_master_data` because the receipt's OWN writes gate on it (the D02 `po` row one family
  // over, and J02's `inventory_move` the receipt writes through), so a custom field on a receipt is
  // exactly as hard to write as the receipt it annotates; `READ_FOR_EDIT_CAPABILITY` already answers
  // `manage_master_data` -> `read_master_data`, so the G00 reads resolve with no new A24 edit.
  // Verified against `src/core/procurement/receiptSchema.ts`: the table really is
  // `goods_receipt_doc`, its primary key really is `id`, and it is workspace_id-scoped, so no
  // tenantColumn override.
  { kind: 'goods_receipt', table: 'goods_receipt_doc', idColumn: 'id', editCapability: 'manage_master_data' },
  // J00, warehouses (spec §4/§6): a warehouse is an OP3 kind, so an operator can hang an internal
  // "Standort-Verantwortlicher" contact_ref or a "Region" select on one and save views over the
  // Warehouses list. A custom field ANNOTATES; it can NEVER express the code, the default flag or the
  // address, which are the warehouse's real columns and off limits to the reserved-key list.
  // `manage_master_data` because a warehouse's OWN writes gate on it, so a custom field on a warehouse
  // is exactly as hard to write as the warehouse it annotates; `READ_FOR_EDIT_CAPABILITY` already
  // answers `manage_master_data` -> `read_master_data` (the item/stock_location row), so the G00 reads
  // resolve with no new A24 edit. The location HIERARCHY rides D01's existing `stock_location` kind
  // (already registered above), which J00 extends rather than replacing, so no second kind is added
  // for locations. Verified against `src/core/inventory/schema.ts`: the table really is `warehouse`,
  // its primary key really is `id`, and it is workspace_id-scoped, so no tenantColumn override.
  { kind: 'warehouse', table: 'warehouse', idColumn: 'id', editCapability: 'manage_master_data' },
  // J01, lot & serial tracking (spec §4/§6): a lot (a batch) and a serial (an individually identified
  // unit) are both OP3 kinds, so an operator can hang an internal "Charge geprüft von" or a
  // "Rücknahmegrund" custom field on either and save views over the Lots / Serials lists. A custom
  // field ANNOTATES; it can NEVER express the number, the status lifecycle, the expiry, or the derived
  // on-hand (those are the record's real columns and off limits to the reserved-key list, and a
  // quantity column does not exist on either table at all: §H-STOCK-AUDIT keeps on-hand derived).
  // `manage_master_data` because each kind's OWN writes gate on it (the `warehouse` / `stock_location`
  // reasoning one register over), so a custom field on a lot or serial is exactly as hard to write as
  // the record it annotates; `READ_FOR_EDIT_CAPABILITY` already answers `manage_master_data` ->
  // `read_master_data` (the item/warehouse row), so the G00 reads resolve with no new A24 edit.
  // Verified against `src/core/inventory/trackingSchema.ts`: the tables really are `lot` / `serial`,
  // each primary key is `id`, and both are workspace_id-scoped, so no tenantColumn override.
  { kind: 'lot', table: 'lot', idColumn: 'id', editCapability: 'manage_master_data' },
  { kind: 'serial', table: 'serial', idColumn: 'id', editCapability: 'manage_master_data' },
  // H05, the fixed-asset location master (spec §6): a location is an OP3 kind, so an operator can hang
  // an internal "Gebäude"/"Zonen-Hinweis" custom field on one and save views over the Locations list
  // ("Nur aktive", "Nach Standort"). A custom field ANNOTATES; it can NEVER express the code, the
  // active flag or the parent link, which are the location's real columns and off limits to the
  // reserved-key list. `manage_master_data` because a location's OWN writes gate on it (the H00
  // asset_category / J00 warehouse precedent), so a custom field on a location is exactly as hard to
  // write as the location it annotates; `READ_FOR_EDIT_CAPABILITY` already answers `manage_master_data`
  // -> `read_master_data`, so the G00 reads resolve with no new A24 edit. The TRANSFER history is not a
  // customization surface (it is append-only per-asset evidence, keyed off the `asset` kind's own
  // detail view), so H05 registers only the location kind. Verified against
  // `src/core/assets/transferSchema.ts`: the table really is `asset_location`, its primary key really
  // is `id`, and it is workspace_id-scoped, so no tenantColumn override.
  { kind: 'asset_location', table: 'asset_location', idColumn: 'id', editCapability: 'manage_master_data' },
  // G20, implementation projects (spec §4/§6b): a project, a task and a sign-off are OP3 kinds, so a
  // Treuhänder can hang an internal mandate number, an external PM reference or a per-task note as
  // custom fields and save views over the tasks/roster ("Meine Unterschriften", "Blockiert"). A custom
  // field ANNOTATES; it can NEVER express the phase, the task status, the sign-off kind, the bound hash
  // or the append-only rows themselves (those are the record's own columns, single-sourced under
  // §H-ENUM or frozen by the append-only triggers, and off limits to the reserved-key list).
  // `manage_implementation` because each kind's OWN writes gate on it (a sign-off rides `commit_migration`
  // at the verb, but the `implementation_signoff` ENTITY's custom fields are governance annotations on a
  // project record, so they take the project capability, the `payroll_handoff -> hr.manage` shape where
  // the annotation right differs from the verb's own gate). `READ_FOR_EDIT_CAPABILITY` gains the
  // `manage_implementation -> manage_implementation` self-map in the same commit (there is no softer read
  // domain for the implementation surface, the `manage_import` / `manage_data_export` self-map shape),
  // which the A24 load-time guard demands. Verified against `src/core/migration/projectSchema.ts`: the
  // tables are `implementation_project` / `implementation_task` / `implementation_signoff`, each primary
  // key is `id`, and all three are workspace_id-scoped, so no tenantColumn override.
  { kind: 'implementation_project', table: 'implementation_project', idColumn: 'id', editCapability: 'manage_implementation' },
  { kind: 'implementation_task', table: 'implementation_task', idColumn: 'id', editCapability: 'manage_implementation' },
  { kind: 'implementation_signoff', table: 'implementation_signoff', idColumn: 'id', editCapability: 'manage_implementation' },
];

const BY_KIND: ReadonlyMap<string, EntityKindDef> = new Map(ENTITY_KINDS.map((e) => [e.kind, e]));

/** The tenant column an existence check scopes by: `workspace_id` unless the row declares its own. */
export function tenantColumnOf(def: EntityKindDef): string {
  return def.tenantColumn ?? 'workspace_id';
}

/** The registry row for a kind, or undefined when it is not registered. */
export function entityKindDef(kind: unknown): EntityKindDef | undefined {
  return typeof kind === 'string' ? BY_KIND.get(kind) : undefined;
}

/** Every registered kind id, for the Studio's picker and for a validation message that names them. */
export const ENTITY_KIND_IDS: readonly string[] = ENTITY_KINDS.map((e) => e.kind);

/**
 * The capability `set_field_value` inherits for a kind.
 *
 * FAILS CLOSED ON AN UNKNOWN KIND, and the fallback is deliberate rather than arbitrary. The
 * capability gate at the registry boundary runs BEFORE the verb, so it has to answer for an input the
 * verb would itself reject with `unknown_entity_kind`. Answering `manage_custom_fields` treats
 * "you named an entity that does not exist" as an administrative act, which is the shape of the
 * mistake, and it can never be more permissive than the real answer would have been: no registry row
 * carries a G00 capability, so this branch grants nothing that any real row would have granted.
 */
export function editCapabilityForKind(kind: unknown): Capability {
  return entityKindDef(kind)?.editCapability ?? 'manage_custom_fields';
}
