/**
 * The Wave-0 SQLite schema (data model §D0).
 *
 * Columns are snake_case; the engine and MCP/REST interfaces are camelCase and map at this boundary
 * only. Money is stored as INTEGER Rappen, booleans as INTEGER 0/1, timestamps/dates as ISO-8601 TEXT.
 * `IF NOT EXISTS` keeps applying the schema idempotent.
 *
 * `journal_entry.source` carries the reconciled §D0 enum
 * `manual|invoice|payment|import|agent|reversal|close|fx|purchase`. Enum values are enforced by the
 * engine (the single §H-ENUM source of truth, `VALID_SOURCES` in `../ledger/postEntry.ts`), not by
 * CHECK constraints, so a spec that legitimately adds a value does so in one place without a
 * migration. A17 added `purchase` that way, and deliberately did NOT add it to the agent-facing
 * `POST_ENTRY_SOURCES` allow-list, so a caller cannot mint an entry claiming to be a vendor bill
 * without a `vendor_bill` row behind it.
 */

import { PAYMENT_SCHEMA_SQL } from '../payments/schema.js';
import { DEBTORS_SCHEMA_SQL } from '../debtors/schema.js';
import { BANKING_SCHEMA_SQL } from '../banking/schema.js';
import { ACCESS_SCHEMA_SQL } from '../access/schema.js';
import { CUSTOMIZATION_SCHEMA_SQL } from '../customization/schema.js';
import { AUTOMATION_SCHEMA_SQL } from '../automation/schema.js';
import { SALES_SCHEMA_SQL } from '../sales/schema.js';
import { CONTACT_ACTIVITY_SCHEMA_SQL } from '../sales/contactActivitySchema.js';
import { PURCHASE_SCHEMA_SQL } from '../purchase/schema.js';
import { CAPTURE_SCHEMA_SQL } from '../purchase/captureSchema.js';
import { FILES_SCHEMA_SQL } from '../files/schema.js';
// G18 US-G18.4: the E00 chunk-upload lane tables (upload sessions, provisional chunks, large-blob
// segments). Appended at the END of the SCHEMA_SQL union: it references only `workspace`, which
// CORE_SCHEMA_SQL creates first, so its position after SYNC_SCHEMA_SQL is safe.
import { FILE_UPLOAD_SCHEMA_SQL } from '../files/uploadSchema.js';
import { DUNNING_SCHEMA_SQL } from '../dunning/schema.js';
import { RECURRING_SCHEMA_SQL } from '../recurring/schema.js';
import { QR_MATCH_SCHEMA_SQL } from '../banking/qrMatchSchema.js';
import { CAMT_SCHEMA_SQL } from '../banking/camtSchema.js';
import { PAIN001_SCHEMA_SQL } from '../banking/pain001Schema.js';
// A25 review & export: the entry_review sidecar (one table, one index), kept in A25's own module.
import { REVIEW_SCHEMA_SQL } from '../review/schema.js';
import { AGENT_SCHEMA_SQL } from '../agent/schema.js';
// G10 migration maps: the map/template tables plus the minimal migration_plan seam G09 extends.
import { MIGRATION_SCHEMA_SQL } from '../migration/schema.js';
// G03 onboarding: the one wizard resume-pointer table, kept in G03's own module (the same pattern).
import { ONBOARDING_SCHEMA_SQL } from '../onboarding/schema.js';
// M03 deployment journeys: the one move-checklist resume-pointer table (the G03 pattern verbatim).
import { MOVE_SCHEMA_SQL } from '../move/schema.js';
// B00: the projects master's two tables, kept in B00's own module (the A14/A19/A24/G00/C00/E00 pattern).
import { PROJECTS_SCHEMA_SQL } from '../projects/schema.js';
// G13 GL archive: the four gl_archive_* tables, the purge gate, and the immutability triggers.
import { GL_ARCHIVE_SCHEMA_SQL } from '../migration/archiveSchema.js';
// G19 extraction companion: the one export-completeness manifest table, in its own module (the
// archiveSchema.ts precedent), concatenated below. Stores no credential or session state, ever.
import { EXTRACTION_MANIFEST_SCHEMA_SQL } from '../migration/manifestSchema.js';
// E03 tasks & reminders: the capability's DDL sits in its own module (the A14/A19 pattern).
import { TASKS_SCHEMA_SQL } from '../tasks/schema.js';
// B01 time tracking: time_entry + rate_card, kept in B01's own module (the same pattern).
import { TIME_SCHEMA_SQL } from '../time/schema.js';
// C01 leads & deals: the capability's DDL sits in its own module (the A14/A19 pattern).
import { DEALS_SCHEMA_SQL } from '../deals/schema.js';
// D01 inventory / stock: the five OP2 tables (locations, movements, valuation runs, stocktake + lines).
import { STOCK_SCHEMA_SQL } from '../stock/schema.js';
// D03 sales orders & delivery notes: five operational tables (orders, lines, notes, note lines, and
// the so_line_invoice double-billing guard). No posting path, the A14/A19/D01 module-owned DDL pattern.
import { SALES_ORDER_SCHEMA_SQL } from '../sales/salesOrderSchema.js';
// D02 purchasing: seven tables (PO + lines, goods receipts + lines, matches, revisions, supplier
// prices). No posting path (P3), DISJOINT from A17's own vendor_bill schema; the module-owned DDL pattern.
import { PURCHASE_ORDER_SCHEMA_SQL } from '../purchase/purchaseOrderSchema.js';
// I01 Advanced Purchase Order (OP14): the versioning + amendment tables, ADDITIVE to D02's live
// purchase_order/po_line; the module-owned DDL pattern, DISJOINT from purchaseOrderSchema.ts.
import { PO_VERSION_SCHEMA_SQL } from '../purchase/poVersionSchema.js';
// E02 HR-lite: employees, absences and expense claims; the module-owned DDL pattern.
import { HR_SCHEMA_SQL } from '../hr/schema.js';
// B04 retainers & mandates: the mandate agreement + its append-only drawdown ledger; module-owned DDL.
import { RETAINER_SCHEMA_SQL } from '../retainers/schema.js';
// E01 e-signature: the sign_request lifecycle table, DDL beside the code that writes it.
import { SIGN_SCHEMA_SQL } from '../sign/schema.js';
// F02 customer portal: the portal_grant table (shared with F03), DDL beside the code that writes it.
import { PORTAL_SCHEMA_SQL } from '../portal/schema.js';
// F03 vendor portal: remittance_advice + remittance_advice_line, the snapshot tables F03 owns beside
// the shared F02 portal_grant. Module-owned DDL, the F02 pattern.
import { REMITTANCE_SCHEMA_SQL } from '../portal/remittanceSchema.js';
// F01 report builder: saved_reports + report_runs (+ the in-store artifact blob), module-owned DDL.
import { REPORTBUILDER_SCHEMA_SQL } from '../reportbuilder/schema.js';
// E04 local mail store: mail_account/mail_thread/mail_message/mail_draft, locators and hashes only,
// never a body and never a credential (OP6). Module-owned DDL, the E03 pattern.
import { MAIL_SCHEMA_SQL } from '../mail/schema.js';
import { VOICE_SCHEMA_SQL } from '../voice/schema.js';
import { DRAFTING_SCHEMA_SQL } from '../drafting/schema.js';
// G04 data freedom: the single `backups` registry table, DDL beside the code that writes it.
import { DATA_SCHEMA_SQL } from '../data/schema.js';
// G05 document templates: the document_template table, DDL beside the code that writes it.
import { DOCUMENT_TEMPLATE_SCHEMA_SQL } from '../customization/documentTemplateSchema.js';
// G06 notifications & inbox: inbox_item / notification_pref / digest_run, DDL beside the code.
import { NOTIFICATIONS_SCHEMA_SQL } from '../notifications/schema.js';
// G02 plugins: plugin_manifests / plugin_capability_registrations, DDL beside the code.
import { PLUGINS_SCHEMA_SQL } from '../plugins/schema.js';
// G05 section 10 dispatch texts and send log: dispatch_texts / dispatches, DDL beside the code.
import { DISPATCH_SCHEMA_SQL } from '../customization/dispatchSchema.js';
// A34 payroll hand-off: payroll_handoff_exports / wage_journal_posts, DDL beside the code (append-only).
import { PAYROLL_HANDOFF_SCHEMA_SQL } from '../payroll/handoffSchema.js';
// A32 eBill issuing: ebill_config / ebill_deliveries / ebill_delivery_events, DDL beside the code.
import { EBILL_SCHEMA_SQL } from '../sales/ebillSchema.js';
import { EBICS_SCHEMA_SQL } from '../banking/ebics/schema.js';
import { MANAGED_SCHEMA_SQL } from '../banking/managed/schema.js';
// H00 fixed-asset categories: the asset_category master + its case-insensitive code index, DDL
// beside the code that writes it (the A14/A19/B00 module-owned pattern). A01's account/cost_center
// tables are referenced, so this joins AFTER the core schema that creates them.
import { ASSETS_SCHEMA_SQL } from '../assets/schema.js';
// H01 the Asset Master: the asset table, references asset_category (H00) and account (A01), so it
// joins AFTER both. Its own module so a concurrent asset-cluster branch never edits H00's string.
import { ASSET_MASTER_SCHEMA_SQL } from '../assets/masterSchema.js';
// H02 asset acquisition: the asset_transaction sub-ledger table, references asset (H01) and
// journal_entry (A02), so it joins AFTER both. Its own module (the H00/H01 module-owned pattern) so a
// concurrent asset-cluster branch never edits H01's string, and it carries its own append-only triggers.
import { ASSET_TRANSACTION_SCHEMA_SQL } from '../assets/transactionSchema.js';
// H04 depreciation runs: the run HEADER + per-asset LINE tables, DDL beside the code that writes it
// (the H00/H01/H02 module-owned pattern). The line table is append-only (its own triggers); the run
// header advances status only (a status-transition trigger). REFERENCES asset + journal_entry, so it
// joins AFTER the asset master + the ledger schema that create them.
import { DEPRECIATION_RUN_SCHEMA_SQL } from '../assets/depreciationRunSchema.js';
// I00 requisitions: the requisition + line + approval-event/task + conversion tables, the cluster-I
// procure-to-pay root. No posting path (P3), DISJOINT from D02's own purchase_order schema; the
// module-owned DDL pattern. It REFERENCES A01's cost_center, D00's item, B00's project and C00's
// contact, so it joins AFTER the core + sales + projects schema that create them.
import { PROCUREMENT_SCHEMA_SQL } from '../procurement/schema.js';
// J00 warehouses & locations: the warehouse master table + its indexes, DDL beside the code that
// writes it (the H00 module-owned pattern). The location HIERARCHY rides D01's existing stock_location
// table via ADDITIVE_COLUMNS below, so no second location table is created (spec §4 Reconciliation).
import { INVENTORY_SCHEMA_SQL } from '../inventory/schema.js';
// H03 depreciation: the per-workspace method-enablement flag (the pure engine holds no state). Its
// own module so a concurrent asset-cluster branch never edits H00/H01's string.
import { DEPRECIATION_SCHEMA_SQL } from '../assets/depreciation/schema.js';
// J01 lot & serial tracking: the `lot` and `serial` master tables, DDL beside the code that writes it
// (the J00/H00 module-owned pattern). Both REFERENCE item (core) and stock_location (D01), so this
// joins AFTER the core + stock schema that create them.
import { TRACKING_SCHEMA_SQL } from '../inventory/trackingSchema.js';
// H05 asset transfer & location: the asset_location master + the append-only asset_transfer history.
// Both REFERENCE asset (H01), so this joins AFTER ASSET_MASTER_SCHEMA_SQL. Its own module (the
// H00/H01/H02 module-owned pattern) so a concurrent asset-cluster branch never edits H01/H02's string.
// The asset_transfer table deliberately carries NO journal_entry_id: a transfer is non-posting (§4).
import { ASSET_TRANSFER_SCHEMA_SQL } from '../assets/transferSchema.js';
// H08 simple maintenance log: the append-oriented asset_maintenance_log table. REFERENCES asset (H01),
// so this joins AFTER ASSET_MASTER_SCHEMA_SQL. Its own module (the H00/H01/H05 module-owned pattern).
// Non-posting: the table carries NO journal_entry_id (the captured cost is TCO metadata, never a GL row).
import { MAINTENANCE_SCHEMA_SQL } from '../assets/maintenanceSchema.js';
// J02 inventory movement ledger: the append-only immutability triggers on D01's stock_movement + the
// inventory_config negative-stock policy table. Its own module (the J00/J01 module-owned DDL pattern),
// concatenated LAST so stock_movement (from STOCK_SCHEMA_SQL) exists by the time the triggers create.
import { MOVEMENT_SCHEMA_SQL } from '../inventory/movementSchema.js';
// I02 goods receipt: the goods_receipt_doc / _line / _event document tables plus the over-receipt
// policy row. Its own module (the I00/J00/J01 module-owned DDL pattern). It REFERENCES D02's
// purchase_order + po_line, D01's stock_location + stock_movement, D02's goods_receipt_line (the
// shared received-quantity trail) and J01's lot + serial, so it joins AFTER all of those.
import { RECEIPT_SCHEMA_SQL } from '../procurement/receiptSchema.js';
// J03 valuation policy: the append-only dated method assignment (the OR 958c Stetigkeit trail, with
// its own immutability triggers) + the per-workspace method enablement. Concatenated after the J02
// ledger, so `item` and `stock_movement` exist by the time the FK references are created.
import { VALUATION_SCHEMA_SQL } from '../inventory/valuationSchema.js';
// I03 landed-cost voucher tables. Concatenated LAST: they reference `account` (A01), `journal_entry`
// (A02), `contact` (A09), `item` (D00), `stock_location` + `stock_movement` (D01/J02) and I02's
// `goods_receipt_doc_line`, so every parent table must already exist by the time these FKs are made.
import { LANDED_COST_SCHEMA_SQL } from '../procurement/landedCostSchema.js';
// I04 three-way match: the three_way_match / _line tables + their append-only triggers. Its own
// module (the I00/I02/J00 module-owned DDL pattern). It REFERENCES vendor_bill (A17), purchase_order
// + po_line (D02/I01) and goods_receipt_doc_line (I02), so it joins AFTER all of those.
import { THREE_WAY_MATCH_SCHEMA_SQL } from '../procurement/threeWayMatchSchema.js';
// J06 valuation-run / GL-link tables. Concatenated LAST: they reference `workspace`, `account` (A01),
// `journal_entry` (A02), `item` (D00) and `stock_location` (J00), so every parent must already exist.
import { RECONCILIATION_SCHEMA_SQL } from '../inventory/reconciliationSchema.js';

// J04 cycle count / stocktake tables. Concatenated AFTER RECONCILIATION_SCHEMA_SQL: they reference
// `workspace`, `item` (D00), `warehouse` + `stock_location` (J00), `lot` + `serial` (J01) and
// `stock_movement` (D01/J02), so every parent must already exist. New table names (`cycle_count_*`),
// so no ADDITIVE_COLUMNS entry: a fresh CREATE carries the full shape.
import { STOCKTAKE_SCHEMA_SQL } from '../inventory/stocktakeSchema.js';
import { ADJUST_SCHEMA_SQL } from '../inventory/adjustSchema.js';
// M02 §I sync/publish contract: the sync_publish_state dial + the append-only sync_outbox, plus the
// transactional-outbox trigger on journal_entry's draft -> posted flip. Concatenated LAST because the
// trigger REFERENCES journal_entry (CORE_SCHEMA_SQL): the referenced table must already exist. Its own
// module (the G04/E00 module-owned DDL pattern), so the contract half never edits another string.
import { SYNC_SCHEMA_SQL } from '../sync/schema.js';
// G20 implementation projects: six governance tables (project, task, decision, sign-off, parallel-run
// declaration + check), all §H-TENANT, none on the money path. References only `workspace` and the
// migration family's `migration_plan`, both created earlier in the union, so its position is safe.
import { IMPLEMENTATION_PROJECT_SCHEMA_SQL } from '../migration/projectSchema.js';
// G22 checklists (D127): three tables (run, run item, append-only sign-off), all §H-TENANT, none on
// the money path, no `_rappen` column. References only `workspace`, so its position is safe.
import { CHECKLISTS_SCHEMA_SQL } from '../checklists/schema.js';

/**
 * Additive column migrations (M-3). `CREATE TABLE IF NOT EXISTS` never widens an EXISTING table, so
 * a column added to `SCHEMA_SQL` after a database file was first created exists only on fresh
 * databases. Every such column is listed here too, and the store applies an idempotent
 * `ALTER TABLE ... ADD COLUMN` on open for any that are missing (guarded by `PRAGMA table_info`).
 * Only constant-default, nullable-or-defaulted columns belong here: that is what SQLite's
 * ALTER TABLE ADD COLUMN supports, and it is exactly what "additive" means.
 */
export const ADDITIVE_COLUMNS: readonly { table: string; column: string; ddl: string }[] = [
  // G21 (open-items migration): the carry-forward origin on the two money-path documents. Both are
  // `NOT NULL DEFAULT 'native'`, which is exactly what ALTER TABLE ADD COLUMN supports (a constant
  // default), so a pre-G21 `~/.till/till.db` widens on open with NO data migration and every existing
  // row reads 'native'. A `migrated` row posts nothing of its own; its origin selects that the poster
  // never runs (spec §4). SCHEMA_GENERATION is unaffected: this is a shape change, not a data one.
  { table: 'document', column: 'origin', ddl: "origin TEXT NOT NULL DEFAULT 'native'" },
  { table: 'vendor_bill', column: 'origin', ddl: "origin TEXT NOT NULL DEFAULT 'native'" },
  // A11 email send (OP4): the configured outbound relay mode, or NULL when none is configured.
  { table: 'workspace', column: 'email_relay', ddl: 'email_relay TEXT' },
  // A11/P8 (M15): the outbound approval dial (0/NULL = wait for a human confirmation).
  { table: 'workspace', column: 'posting_auto_issue', ddl: 'posting_auto_issue INTEGER NOT NULL DEFAULT 0' },
  // A11: who an invoice was emailed to (the status trail records when; this records to whom).
  { table: 'document', column: 'sent_to_email', ddl: 'sent_to_email TEXT' },
  // M01 (served access): the proxy-attested subject a served identity is recognised by, NULL on every
  // user row written before served mode existed and on every local install. See src/api/served-mode.ts
  // and the module note in src/core/access/schema.ts: this is the whole of served authentication, and
  // the engine never writes a password or a token beside it.
  { table: 'user', column: 'subject', ddl: 'subject TEXT' },
  // M01 US-M01.3 / F-08 (d): is this identity a person or a machine? Constant-defaulted 'human', so a
  // file written before the column existed widens on open with every identity reading as a person; an
  // agent member is created as such by `invite_member` (`kind: 'agent'`) and is the governed seat.
  { table: 'user', column: 'kind', ddl: "kind TEXT NOT NULL DEFAULT 'human'" },
  // A00/A11 (M-3): the creditor IBAN, of EITHER kind. This is the SHAPE half of renaming `qr_iban`,
  // and it belongs here rather than only in a data migration because that is exactly what this list
  // is for: giving an existing file a new nullable column, self-detected via PRAGMA table_info. It
  // cannot carry the stored VALUE across, which is why generation 2 in ./migrations.ts exists too.
  { table: 'workspace', column: 'creditor_iban', ddl: 'creditor_iban TEXT' },
  // A06/A07 (F2): the Leistungsdatum that priced this line's VAT, when it differs from the entry
  // date. `postEntry` has taken a per-line `supplyDate` since the straddle fix and has priced the
  // tax with it ever since; it simply never stored it, so A07 had to fall back to the ENTRY date
  // and merged a 2023 supply invoiced in 2024 into the 8.1% bucket. NULL on every row written
  // before this column existed, which reads as "not recorded" and keeps the old entry-date
  // fallback, so no posted figure changes and §H-AUDIT is untouched.
  { table: 'journal_line', column: 'supply_date', ddl: 'supply_date TEXT' },
  // C00 (contacts / CRM core): the extension columns on A09's `contact` table. C00 EXTENDS A09, it
  // does not fork it, so these widen the existing row rather than living on a second table. Every one
  // is nullable or constant-defaulted, which is all `ALTER TABLE ADD COLUMN` supports and exactly what
  // "additive" means; an A09 book written before C00 gets each column with the value below on open.
  //
  // `kind` defaults to 'company': a bare A09 contact is a party you invoice, which is a company far
  // more often than a named private person, and the CRM adds people as a deliberate act. `roles` and
  // `segments` are JSON arrays defaulting to the empty array. `ledger_grounding_enabled` is the
  // per-contact E06 consent flag (C00 owns the column and `updateContact` is its only write path; E06
  // only ever READS it), and it defaults to 0: consulting a client's books is opt-IN, never assumed.
  { table: 'contact', column: 'kind', ddl: "kind TEXT NOT NULL DEFAULT 'company'" },
  { table: 'contact', column: 'company_contact_id', ddl: 'company_contact_id TEXT' },
  { table: 'contact', column: 'roles', ddl: "roles TEXT NOT NULL DEFAULT '[]'" },
  { table: 'contact', column: 'segments', ddl: "segments TEXT NOT NULL DEFAULT '[]'" },
  { table: 'contact', column: 'lang', ddl: 'lang TEXT' },
  { table: 'contact', column: 'merged_into_id', ddl: 'merged_into_id TEXT' },
  {
    table: 'contact',
    column: 'ledger_grounding_enabled',
    ddl: 'ledger_grounding_enabled INTEGER NOT NULL DEFAULT 0',
  },
  // D00 (products/items master): the fields that turn A09's invoicing-lite item into a real catalog
  // row. Every one is nullable or defaulted, so an item row written by A09 before D00 stays valid and
  // reads as "no SKU / kind unset / not stockable". A REFERENCES clause is admissible on ADD COLUMN
  // because each default is NULL (SQLite: a referencing column added by ALTER must default to NULL),
  // and the parent tables (item_category, item) already exist by the time ensureColumns runs.
  { table: 'item', column: 'item_sku', ddl: 'item_sku TEXT' },
  { table: 'item', column: 'kind', ddl: 'kind TEXT' },
  { table: 'item', column: 'category_id', ddl: 'category_id TEXT REFERENCES item_category(id)' },
  { table: 'item', column: 'cost_price_minor', ddl: 'cost_price_minor INTEGER' },
  { table: 'item', column: 'variant_of_id', ddl: 'variant_of_id TEXT REFERENCES item(id)' },
  { table: 'item', column: 'track_stock', ddl: 'track_stock INTEGER NOT NULL DEFAULT 0' },
  { table: 'item', column: 'reorder_point_qty', ddl: 'reorder_point_qty INTEGER' },
  // A26/A35 (F-08, J5.6): the human's optional reason on a rejected Vorschlag. Nullable, so a file
  // written before 2026-09-05 widens on open with every earlier rejection reading as "no reason given".
  { table: 'agent_action', column: 'reject_reason', ddl: 'reject_reason TEXT' },
  // A15 (D73): the issue-time demand snapshot on `dunning_item`, added after the table first
  // shipped on the capability branch, so a database written by an earlier build of that branch
  // widens on open. Constant-defaulted, which is all ALTER ADD COLUMN supports, and THE TWO ZEROS
  // MEAN DIFFERENT THINGS (critic S2): a `demanded_fee_minor` of 0 reads as "demanded nothing",
  // which under-demands rather than fabricates and is safe as-is; a `principal_minor` of 0 on an
  // ISSUED row would fabricate ("offen CHF 0.00" plus the whole invoice restated as fees), so the
  // N5 itemisation in `dunning/pdf.ts` treats 0 as "not snapshotted" and falls back to
  // `overdue_minor`, reproducing the pre-D73 letter exactly. A merely proposed run self-heals:
  // issue rewrites both columns with real values.
  { table: 'dunning_item', column: 'principal_minor', ddl: 'principal_minor INTEGER NOT NULL DEFAULT 0' },
  { table: 'dunning_item', column: 'demanded_fee_minor', ddl: 'demanded_fee_minor INTEGER NOT NULL DEFAULT 0' },
  // A15 (K-60): the per-level minimum spacing between escalation letters, on `dunning_config`.
  // Constant-defaulted 10, which is all ALTER TABLE ADD COLUMN supports, so a `dunning_config`
  // written before this column existed widens on open with EXISTING rows reading 10, never 0: an
  // old policy keeps the safe cadence rather than silently reopening the three-letters-in-three-days
  // defect the column exists to close. No data migration and no money figure: this gates ADVANCEMENT
  // only; it never touches a posted entry.
  { table: 'dunning_config', column: 'min_interval_days', ddl: 'min_interval_days INTEGER NOT NULL DEFAULT 10' },
  // A13 (credit notes): the invoice a Gutschrift credits, and the invoice position each derived
  // credit line attributes to (§4b.1). Both nullable-with-NULL-default, which is what ALTER TABLE
  // ADD COLUMN supports; a REFERENCES clause is admissible because the default is NULL and the
  // parent table exists by the time ensureColumns runs. Pre-A13 rows read NULL, which is the honest
  // answer: nothing they hold is a credit note.
  { table: 'document', column: 'credited_document_id', ddl: 'credited_document_id TEXT REFERENCES document(id)' },
  { table: 'document_line', column: 'credited_line_position', ddl: 'credited_line_position INTEGER' },
  // A23 (multi-client workspaces): the archived-mandate flag. Constant-defaulted 0, so every book
  // written before A23 opens as active; no data migration, because there is nothing to backfill.
  { table: 'workspace', column: 'archived', ddl: 'archived INTEGER NOT NULL DEFAULT 0' },
  // G12 (Testmandant): the workspace KIND enum and the promotion timestamp. `kind` is constant-
  // defaulted 'live', so every book written before G12 opens as real books (which they are); it
  // additively subsumes G03's `is_demo` boolean. `promoted_at` is NULL on every workspace that was
  // never a Testmandant. Both are exactly what ALTER TABLE ADD COLUMN supports (constant-default /
  // nullable), which is what "additive" means.
  { table: 'workspace', column: 'kind', ddl: "kind TEXT NOT NULL DEFAULT 'live'" },
  { table: 'workspace', column: 'promoted_at', ddl: 'promoted_at TEXT' },
  // C02 (quotes / proposals): the quote-owned columns on the shared A10 `document` row, populated
  // ONLY for `type='quote'` rows, mirroring how A11 owns `sent_to_email` and A13 `credited_document_id`
  // rather than forking a second table (spec §4, "no new tables"). Every one is nullable or constant-
  // defaulted, which is all ALTER TABLE ADD COLUMN supports and exactly what "additive" means; a
  // pre-C02 document reads each as NULL / version 1, which is the honest answer (it is not a quote, or
  // it is a quote from before these columns existed). `deal_id` and `supersedes_id` carry a REFERENCES
  // clause, admissible on ADD COLUMN because each default is NULL and the parent tables (`deal` from
  // C01, `document` itself) exist by the time ensureColumns runs. NONE of these touch a money figure:
  // the totals stay on A10's `subtotal_minor`/`total_minor`, and the tax freeze rides `document_line`.
  { table: 'document', column: 'valid_until', ddl: 'valid_until TEXT' },
  { table: 'document', column: 'deal_id', ddl: 'deal_id TEXT REFERENCES deal(id)' },
  { table: 'document', column: 'intro', ddl: 'intro TEXT' },
  { table: 'document', column: 'outro', ddl: 'outro TEXT' },
  { table: 'document', column: 'version', ddl: 'version INTEGER NOT NULL DEFAULT 1' },
  { table: 'document', column: 'supersedes_id', ddl: 'supersedes_id TEXT REFERENCES document(id)' },
  { table: 'document', column: 'accept_token_hash', ddl: 'accept_token_hash TEXT' },
  { table: 'document', column: 'accepted_by', ddl: 'accepted_by TEXT' },
  { table: 'document', column: 'decline_reason', ddl: 'decline_reason TEXT' },
  // B02 (time -> billing): the A11 invoice line an approved time entry was billed onto, written by
  // B02's `billing_generate_invoice` when it flips status to 'billed' and cleared by
  // `billing_release_time`. Nullable with a NULL default (all ALTER TABLE ADD COLUMN supports),
  // declared here for pre-B02 files and in B01's `time_entry` CREATE TABLE for fresh ones. It touches
  // no money figure: the line amount lives on `document_line`, and B02 never posts.
  { table: 'time_entry', column: 'invoice_line_id', ddl: 'invoice_line_id TEXT' },
  // B03 (the project cost dimension, landed with the cost-rate column): four nullable columns, all
  // REPORTING dimensions that price nothing and post nothing. `vendor_bill.project_id` feeds the
  // expenses/purchases components, `po_line.project_id` the accrued_purchases/committed ones, and
  // the two `cost_rate_minor` columns carry the OP1 cost-rate (card) and its capture snapshot
  // (entry) that value the B03 'cost' basis. Each is NULL on every pre-existing row, which reads as
  // "not tagged / no cost rate", exactly the honest degrade B03 reports. A REFERENCES clause is
  // admissible because the default is NULL and `project` exists by the time ensureColumns runs.
  { table: 'vendor_bill', column: 'project_id', ddl: 'project_id TEXT REFERENCES project(id)' },
  { table: 'po_line', column: 'project_id', ddl: 'project_id TEXT REFERENCES project(id)' },
  { table: 'rate_card', column: 'cost_rate_minor', ddl: 'cost_rate_minor INTEGER' },
  { table: 'time_entry', column: 'cost_rate_minor', ddl: 'cost_rate_minor INTEGER' },
  // G05 (document templates): the freeze pair on A10's shared `document` row and on A15's
  // `dunning_run`. `rendered_template_id` is WHICH template a document was issued under;
  // `rendered_template_snapshot` is the render-relevant content of that template AT ISSUE (footer,
  // language mode, locale, column order, JSON), because an id alone cannot keep an issued
  // document's reprint stable when the very template it froze to is later edited (spec §8, both
  // halves of the freeze property). Both written exactly once, by `freezeRenderedTemplate` inside
  // the issue transaction, never by any other write; NULL on every pre-G05 row, which renders the
  // built-in fixed default, the honest answer. A REFERENCES clause is admissible because the
  // default is NULL and `document_template` exists by the time ensureColumns runs.
  {
    table: 'document',
    column: 'rendered_template_id',
    ddl: 'rendered_template_id TEXT REFERENCES document_template(id)',
  },
  { table: 'document', column: 'rendered_template_snapshot', ddl: 'rendered_template_snapshot TEXT' },
  {
    table: 'dunning_run',
    column: 'rendered_template_id',
    ddl: 'rendered_template_id TEXT REFERENCES document_template(id)',
  },
  { table: 'dunning_run', column: 'rendered_template_snapshot', ddl: 'rendered_template_snapshot TEXT' },
  // J00 warehouses & locations (spec §4 Reconciliation): the location HIERARCHY columns on D01's
  // existing `stock_location` table. J00 EXTENDS stock_location rather than forking a second `location`
  // table, so the `stock_movement.location_id -> stock_location(id)` FK stays intact and every D01
  // movement / on-hand / valuation / stocktake verb keeps working unchanged. Every column is nullable
  // or constant-defaulted, which is all ALTER TABLE ADD COLUMN supports and exactly what "additive"
  // means; a stock_location written by D01 before J00 reads each as NULL / depth 0 / not-a-default,
  // which is the honest answer (a flat location that no warehouse yet owns). `warehouse_id` and
  // `parent_id` carry a REFERENCES clause, admissible on ADD COLUMN because each default is NULL and
  // the parent tables (`warehouse` from INVENTORY_SCHEMA_SQL, `stock_location` itself) exist by the
  // time ensureColumns runs. `path` is the materialised ancestor path ("/rootId/childId/") J00 keeps
  // current on every create / re-parent, so a descendant sweep is one `path LIKE ?` instead of a
  // recursive CTE; NULL until J00's `location_create` writes it.
  { table: 'stock_location', column: 'warehouse_id', ddl: 'warehouse_id TEXT REFERENCES warehouse(id)' },
  { table: 'stock_location', column: 'code', ddl: 'code TEXT' },
  { table: 'stock_location', column: 'description', ddl: 'description TEXT' },
  { table: 'stock_location', column: 'parent_id', ddl: 'parent_id TEXT REFERENCES stock_location(id)' },
  { table: 'stock_location', column: 'location_type', ddl: 'location_type TEXT' },
  { table: 'stock_location', column: 'path', ddl: 'path TEXT' },
  { table: 'stock_location', column: 'depth', ddl: 'depth INTEGER NOT NULL DEFAULT 0' },
  {
    table: 'stock_location',
    column: 'is_default_for_warehouse',
    ddl: 'is_default_for_warehouse INTEGER NOT NULL DEFAULT 0',
  },
  // J01 lot & serial tracking (spec §4): the per-item tracking mode on D00's `item`, and the two
  // EXTENSION-POINT foreign keys on D01's `stock_movement`. `tracking_mode` is constant-defaulted
  // 'none', so every A09/D00 item written before J01 opens as untracked (which it is); the two
  // movement FKs are nullable-with-NULL-default, which is all ALTER TABLE ADD COLUMN supports and
  // exactly what "additive" means. J01 defines the masters and the on-hand-by-lot read model that
  // sums `stock_movement.lot_id`; J02 (the movement ledger) is what actually WRITES a lot- or
  // serial-tagged movement and enforces the reference when the item's mode demands it. A REFERENCES
  // clause is admissible on ADD COLUMN because each default is NULL and the parent tables (`lot` /
  // `serial` from TRACKING_SCHEMA_SQL) exist by the time ensureColumns runs.
  { table: 'item', column: 'tracking_mode', ddl: "tracking_mode TEXT NOT NULL DEFAULT 'none'" },
  { table: 'stock_movement', column: 'lot_id', ddl: 'lot_id TEXT REFERENCES lot(id)' },
  { table: 'stock_movement', column: 'serial_id', ddl: 'serial_id TEXT REFERENCES serial(id)' },
  // I01 (Advanced Purchase Order): the PROVENANCE pair on D02's `purchase_order`, so a PO minted from
  // an I00 requisition (or any future source document) carries a first-class bidirectional link rather
  // than a human-readable note. `source_document_type` is the source KIND ('requisition', ...) and
  // `source_document_id` its id in that kind's own table. Both nullable with a NULL default, which is
  // all ALTER TABLE ADD COLUMN supports and exactly what "additive" means; a PO created directly (no
  // source) reads each as NULL, the honest answer. Declared here for pre-I01 files AND in
  // purchaseOrderSchema.ts's CREATE TABLE for fresh ones, so the two paths never drift. They touch no
  // money figure: the totals stay on the D02 columns and I01 posts nothing (P3).
  { table: 'purchase_order', column: 'source_document_type', ddl: 'source_document_type TEXT' },
  { table: 'purchase_order', column: 'source_document_id', ddl: 'source_document_id TEXT' },
  // J02 movement ledger (spec §4): the four columns that turn D01's stock_movement into the
  // authoritative append-only ledger, added additively rather than forking a second table (which
  // would split on-hand truth from J00's balance-by-location and J01's on-hand-by-lot). All
  // nullable-with-NULL-default, so every stock_movement written by D01 / D03 / stocktake before J02
  // opens unchanged: `movement_type` reads through `COALESCE(movement_type, reason)` in the ledger's
  // own reads, so a legacy row still carries a type. `movement_type` is the authoritative J02
  // §H-ENUM; `reason` (D01, NOT NULL) is kept in step by J02's writer for D01 read + valuation
  // back-compat. `created_by` is the §H-AUDIT actor; `transfer_group_id` links the transfer pair.
  { table: 'stock_movement', column: 'movement_type', ddl: 'movement_type TEXT' },
  { table: 'stock_movement', column: 'transfer_group_id', ddl: 'transfer_group_id TEXT' },
  { table: 'stock_movement', column: 'created_by', ddl: 'created_by TEXT' },
  { table: 'stock_movement', column: 'description', ddl: 'description TEXT' },
  // J02/J03 cost-adjustment seam (I03 landed cost): the two columns that let a movement carry a lump
  // of cost bound to an earlier receipt movement WITHOUT moving quantity. `cost_amount_minor` is the
  // signed Rappen a `landed_cost` movement adds to the value (NULL on every quantity-moving type, and
  // on-hand SUM(qty) never reads it, so it cannot disturb a balance); `ref_movement_id` names the
  // original receipt movement whose FIFO layer / cost pool receives it, so cost follows the goods
  // across a transfer. Both nullable-with-NULL-default, which is all ALTER TABLE ADD COLUMN supports
  // and exactly what "additive" means; every stock_movement written before I03 reads each as NULL,
  // the honest answer (no landed cost, no reference). The REFERENCES clause is admissible on ADD
  // COLUMN because the default is NULL and `stock_movement` exists by the time ensureColumns runs.
  { table: 'stock_movement', column: 'cost_amount_minor', ddl: 'cost_amount_minor INTEGER' },
  { table: 'stock_movement', column: 'ref_movement_id', ddl: 'ref_movement_id TEXT REFERENCES stock_movement(id)' },
  // H04 depreciation run (the H01 parameter gap H03 reported): the two method-specific depreciation
  // parameters the asset master never persisted. `declining_rate_bp` (basis points p.a.) and
  // `total_estimated_units` are what declining_balance / units_of_production need to post from stored
  // state instead of a per-call override. Both nullable-with-NULL-default, which is all ALTER TABLE ADD
  // COLUMN supports and exactly what "additive" means; an asset written before H04 reads each as NULL,
  // which the H03 engine already treats as "no rate / no units" (a 0-charge, honest degrade). Declared
  // in H01's masterSchema CREATE for a fresh database and here for a pre-H04 file, the shared mechanism.
  { table: 'asset', column: 'declining_rate_bp', ddl: 'declining_rate_bp INTEGER' },
  { table: 'asset', column: 'total_estimated_units', ddl: 'total_estimated_units INTEGER' },
  // H04 units of production (D98): the period's produced figure, persisted on the run line because a
  // units amount cannot be re-derived without it and the OR 957a chain has to stay verifiable. The
  // table ships fresh with H04, so the CREATE in depreciationRunSchema already declares it; this is
  // the belt for a database built from an INTERMEDIATE commit of that branch, where
  // `CREATE TABLE IF NOT EXISTS` would leave the column-less table standing and every insert would
  // fail. Costs two lines and removes a class of "works on a fresh file, breaks on mine".
  { table: 'asset_depreciation_line', column: 'units_produced', ddl: 'units_produced INTEGER' },
  // A36 (live bank feed): the G01 automation rule that drives this connection's scheduled sync, or
  // NULL when no cadence is set (the default is OFF). Nullable, so an A33 book written before A36
  // reads it as "no schedule" on open. §H-TENANT rides the ebics_connection row it sits on.
  { table: 'ebics_connection', column: 'sync_rule_id', ddl: 'sync_rule_id TEXT' },
];

/**
 * Indexes that name a column `ADDITIVE_COLUMNS` supplies, and why they cannot live in `SCHEMA_SQL`.
 *
 * The store `exec`s `SCHEMA_SQL` BEFORE `applyAdditiveMigrations` widens an existing file, which is
 * the right order (a table has to exist before it can be altered) and makes an index over an additive
 * column impossible to express there: `CREATE INDEX ... ON item (workspace_id, item_sku)` throws
 * `no such column: item_sku` on every database written before D00, and `IF NOT EXISTS` does not help
 * because the index genuinely does not exist yet. `ADDITIVE_COLUMNS` was the SHAPE half of the M-3
 * mechanism for columns; this is the same half for the indexes over them, applied straight after.
 *
 * A UNIQUE index here can FAIL rather than merely be skipped, so each entry has to be able to say why
 * no stored row can violate it. That is a real constraint on what belongs in this list, not a
 * formality: a store that refuses to open is worse than the invariant it was protecting.
 */
export const ADDITIVE_INDEXES: readonly { name: string; ddl: string }[] = [
  // D00 §4 §D declares `sku UNIQUE(workspace)` and, until now, only `skuTaken` enforced it: a
  // read-then-write with no transaction around the pair, so two concurrent writers could both pass the
  // read and both insert. PARTIAL (`WHERE item_sku IS NOT NULL`), because most items carry no article
  // number at all and SQLite treats every NULL as distinct in a unique index only for the NULL column
  // itself; the partial clause states the intent instead of relying on that.
  //
  // No existing row can violate it. `item_sku` did not exist before D00, so every pre-D00 row has NULL
  // and is outside the index, and every write since has gone through `skuTaken`. There is therefore no
  // reachable state with a duplicate, which is why this is created unguarded: a failure here is a real
  // fault about a database this engine did not write, and it must surface rather than be swallowed.
  {
    name: 'item_sku_unique_per_workspace',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS item_sku_unique_per_workspace
          ON item (workspace_id, item_sku) WHERE item_sku IS NOT NULL`,
  },
  // M01: one served subject maps to at most one identity. PARTIAL (`WHERE subject IS NOT NULL`),
  // because every user row written before served mode carries NULL subject and must stay outside the
  // index: a local install has no proxy and no subjects. It can only FAIL on a database that already
  // holds two identities bound to one subject, which `acceptInvite` (served mode) cannot produce (it
  // binds the subject onto exactly the invited user row, and `user_by_subject` would already have
  // refused a second), so a failure here is a real fault worth surfacing rather than swallowing. The
  // column is additive, so this cannot live in a CREATE beside the table: SCHEMA_SQL runs before
  // ensureColumns widens the row.
  {
    name: 'user_by_subject',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS user_by_subject
          ON user (subject) WHERE subject IS NOT NULL`,
  },
  // A13: the reverse lookup "the credit notes of invoice X", read by the over-credit guard on every
  // issue, the invoice-cancel guard, the list filter and A16's netting. The `document_source`
  // pattern exactly: partial (almost every document credits nothing), non-unique (an invoice may
  // carry several partial credits), workspace first (§H-TENANT). It lives here rather than in
  // SCHEMA_SQL because the column itself is additive: on a pre-A13 file SCHEMA_SQL runs before
  // `ensureColumns` widens the table, and an index over a column that does not exist yet throws.
  {
    name: 'document_credited',
    ddl: `CREATE INDEX IF NOT EXISTS document_credited
          ON document (workspace_id, credited_document_id) WHERE credited_document_id IS NOT NULL`,
  },
  // J00: CASE-INSENSITIVE location code uniqueness WITHIN a warehouse (spec §4). PARTIAL over
  // `code IS NOT NULL`, because every stock_location written by D01 before J00 carries NULL code and
  // must stay outside the index: those flat locations never had a code and cannot violate a
  // per-warehouse uniqueness they predate. It can only FAIL on a database whose J00-created locations
  // already collide, which the engine's own `duplicate_code` pre-check prevents, so a failure here is
  // a real fault worth surfacing. The column is additive, so the index cannot live in a CREATE beside
  // the table: SCHEMA_SQL runs before ensureColumns widens the row.
  {
    name: 'stock_location_code_unique_per_warehouse',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS stock_location_code_unique_per_warehouse
          ON stock_location (warehouse_id, lower(code)) WHERE code IS NOT NULL`,
  },
  // J00: EXACTLY ONE default location per warehouse. Partial over `is_default_for_warehouse = 1` so
  // only the default row participates; setting a new default clears the previous in the same
  // transaction. No pre-J00 row is a default (the column defaults to 0), so no stored row can violate
  // it.
  {
    name: 'stock_location_one_default_per_warehouse',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS stock_location_one_default_per_warehouse
          ON stock_location (warehouse_id) WHERE is_default_for_warehouse = 1`,
  },
  // J00: the descendant sweep and the warehouse-scoped tree read both filter on warehouse_id first,
  // so index it (the FK is on the parent side only). Non-unique, partial over rows J00 owns.
  {
    name: 'stock_location_by_warehouse',
    ddl: `CREATE INDEX IF NOT EXISTS stock_location_by_warehouse
          ON stock_location (workspace_id, warehouse_id, path) WHERE warehouse_id IS NOT NULL`,
  },
  // J02: the transfer-pair lookup (both legs of a transfer share one transfer_group_id). Non-unique
  // (two legs per group), partial over the rows J02 owns. The column is additive, so the index cannot
  // live in MOVEMENT_SCHEMA_SQL beside the triggers: SCHEMA_SQL runs before ensureColumns adds the
  // column, and an index over a column that does not exist yet throws.
  {
    name: 'stock_movement_by_transfer_group',
    ddl: `CREATE INDEX IF NOT EXISTS stock_movement_by_transfer_group
          ON stock_movement (workspace_id, transfer_group_id) WHERE transfer_group_id IS NOT NULL`,
  },
  // I03: the landed-cost adjustments that name a receipt movement (both the FIFO fold, which reads the
  // cost per source movement, and I03's own reverse lookup). Non-unique (a movement may receive
  // several cost components), partial over the rows I03 owns. The column is additive, so the index
  // cannot live in a CREATE beside the table: SCHEMA_SQL runs before ensureColumns adds the column.
  {
    name: 'stock_movement_by_ref_movement',
    ddl: `CREATE INDEX IF NOT EXISTS stock_movement_by_ref_movement
          ON stock_movement (workspace_id, ref_movement_id) WHERE ref_movement_id IS NOT NULL`,
  },
];

/**
 * The DATA migrations (M-3, second half), and why they had to exist.
 *
 * `ADDITIVE_COLUMNS` above widens a table's SHAPE. It cannot touch a row, and until now nothing
 * needed to: every change to this schema had been a new nullable column. Widening the §H-FX rate
 * scale from 1e8 to 1e12 is the first change that alters what an EXISTING stored number MEANS, and
 * silently redefining a stored number is the one thing a ledger must never do. `rate_scaled = 94120000`
 * meant 0.9412 before and means 0.00009412 after, which is a rate wrong by four orders of magnitude
 * on a column the money math reads.
 *
 * So the store carries a schema GENERATION in `PRAGMA user_version` (0 on every database written
 * before this, since nothing ever set it) and runs the migrations above the file's generation, once,
 * in one transaction with the version bump. A crash mid-migration leaves the old generation and the
 * old rows, so the next open retries; it never leaves half-converted money.
 *
 * The rate migration is written as "recompute rate_scaled from rate", NOT as "multiply by 10^4".
 * `exchange_rate.rate` is the canonical decimal string and the authoritative value, `rate_scaled` is
 * its cache, so recomputing restores the invariant that the two agree without the migration needing
 * to know what the old scale was. That also makes it idempotent: running it on an already-correct
 * row changes nothing.
 *
 * Generation 2 is the RENAME of `workspace.qr_iban` to `workspace.creditor_iban`, which needs both
 * halves of the mechanism: `ADDITIVE_COLUMNS` gives an old file the new column (shape) and the data
 * migration carries the stored IBAN into it and retires the old one (rows). See ./migrations.ts.
 *
 * Generation 3 needs no shape change at all, only rows: `saveDraft` stamped a literal 'CHF' on every
 * draft line, so a book kept in any other currency holds drafts denominated in a currency the money
 * was never in. It is fenced to `status = 'draft'`, because a POSTED line reading 'CHF' in a EUR book
 * is an ordinary foreign-currency posting whose §H-FX history must not be touched.
 *
 * Generation 4 is the first change that alters a table's SHAPE in a way `ADDITIVE_COLUMNS` cannot
 * express: it retires the `DEFAULT 'CHF'` on `journal_line.currency`. SQLite has no
 * `ALTER TABLE ... ALTER COLUMN`, so removing a default means rebuilding the table, and rebuilding
 * the ledger's hottest table means carrying its three immutability triggers across intact. The
 * migration therefore derives the new table definition from the file's OWN stored DDL and replays
 * the triggers captured from `sqlite_master`, rather than trusting a second hand-written copy of
 * either, and it verifies its own output before the transaction is allowed to commit.
 *
 * Generation 5 is F11, multi-rate Saldo, and it is a change of MEANING before it is a change of
 * shape. `vat_saldo_rate` held CURRENT configuration: `configureVat` deleted and rewrote the whole
 * set on every call, and every reader was entitled to treat a row count as "how many
 * Saldosteuersätze this workspace has". Multi-rate Saldo needs the APPROVAL HISTORY instead, because
 * under Saldo the rate is never stamped on a journal line and the history is the only evidence of
 * what a filed period was computed with.
 *
 * The previous attempt at this added validity columns to `vat_saldo_rate` and left the name alone.
 * Three independent reviews later, two queries OUTSIDE the change were still counting its rows as
 * current state: one refused a lawful eCH-0217 export for a workspace that had held exactly one rate
 * its whole life, the other silently reported no Ziffer at all on every preview. Both were invisible
 * to the suite, because both files were outside the diff every review was scoped to.
 *
 * So the table does not change meaning under its old name. It is DROPPED, its rows lifted into
 * `vat_saldo_generation` + `vat_saldo_generation_rate`, and any query still naming `vat_saldo_rate`
 * now fails loudly with `no such table` instead of quietly answering the wrong question. That is the
 * whole point of the rename: a stale reader is a test failure rather than a wrong figure on a signed
 * form. `test/vat/saldo-table-encapsulation.test.mjs` keeps it that way by refusing any SQL naming
 * these tables outside `src/core/vat/saldoGenerations.ts`.
 *
 * The same generation versions the METHOD (`vat_method_era`), which is the field that decides which
 * of the two branches in `computeVatReturn` runs at all. Versioning the rates and leaving the method
 * undated preserves the history and makes it unreachable: after a lawful MWSTG Art. 37 Abs. 4 switch
 * the method branch is taken before any rate is read, and every earlier Saldo period recomputes
 * under effektiv.
 */
// Generation 6 (F5-C1): no DDL at all. It is the first purely ROW-level generation: stored
// automation rules whose `action_tool` the denylist has since denied are disabled once, with an
// audit line each. See `disableDeniedAutomationRules` in `./migrations.ts`.
export const SCHEMA_GENERATION = 6;

const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspace (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  legal_form        TEXT,
  base_currency     TEXT NOT NULL DEFAULT 'CHF',
  fiscal_year_start TEXT NOT NULL DEFAULT '01-01',
  vat_method        TEXT,
  vat_accounting    TEXT,
  vat_registered    INTEGER NOT NULL DEFAULT 0,
  creditor_name     TEXT,
  creditor_address  TEXT,
  -- The creditor IBAN, of EITHER kind. Called qr_iban until 2026-07-25, when only a QR-IBAN was
  -- storable because setCreditorProfile refused anything else; M-2 lifted that, so the name had
  -- outlived the meaning and was actively misleading readers into thinking a plain IBAN could not
  -- live here. buildQrBill derives the reference type from the value (QRR from a QR-IBAN, SCOR from
  -- a plain one), which is where that decision belongs. Existing files are carried across by
  -- generation 2 in ./migrations.ts.
  creditor_iban     TEXT,
  uid               TEXT,
  mwst_no           TEXT,
  -- A11 email send (OP4): the configured outbound relay mode (e.g. 'local' SMTP), or NULL when none
  -- is configured (sendInvoice then degrades to needs_email_config, never a silent failure).
  email_relay       TEXT,
  -- A11/P8 (M15): the outbound approval dial. 1 lets an agent send without a per-invoice human
  -- confirmation; 0/NULL (the safe default) makes send_invoice wait for a confirmation.
  posting_auto_issue INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  is_demo           INTEGER NOT NULL DEFAULT 0,
  -- A23: a retired mandate. A FLAG and never a delete (OR Art. 958f retention is per-client and
  -- survives the end of the mandate): the shared boundary refuses writes into an archived
  -- workspace with workspace_archived, reads keep answering, and unarchive flips it back.
  archived          INTEGER NOT NULL DEFAULT 0,
  -- G12: what KIND of workspace this is (demo | sandbox | live). The single-sourced enum's home is
  -- WORKSPACE_KINDS in core/migration/testmandant.ts (no CHECK here, the §D0 convention). It
  -- additively subsumes G03's is_demo boolean: live is real books (the default every existing
  -- workspace opens as), sandbox is a Testmandant trial-loaded by G09, demo is G03's sample data.
  -- The only transition is sandbox -> live, once, through go_productive.
  kind              TEXT NOT NULL DEFAULT 'live',
  -- G12: when a Testmandant was promoted to real books. NULL on every workspace that never was one.
  promoted_at       TEXT
);

CREATE TABLE IF NOT EXISTS account (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id),
  number              TEXT NOT NULL,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL,
  vat_code_default    TEXT,
  cost_center_allowed INTEGER NOT NULL DEFAULT 0,
  archived            INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, number)
);

CREATE TABLE IF NOT EXISTS cost_center (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, code)
);

CREATE TABLE IF NOT EXISTS journal_entry (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspace(id),
  date              TEXT NOT NULL,
  ref               TEXT,
  description        TEXT,
  status            TEXT NOT NULL,
  reverses_entry_id TEXT REFERENCES journal_entry(id),
  idempotency_key   TEXT,
  source            TEXT NOT NULL,
  created_by        TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journal_line (
  id                TEXT PRIMARY KEY,
  entry_id          TEXT NOT NULL REFERENCES journal_entry(id),
  account_id        TEXT NOT NULL REFERENCES account(id),
  cost_center_id    TEXT REFERENCES cost_center(id),
  debit_minor       INTEGER NOT NULL DEFAULT 0,
  credit_minor      INTEGER NOT NULL DEFAULT 0,
  -- No DEFAULT, deliberately, and this is the one currency column in the schema without one.
  -- workspace.base_currency and contact.default_currency default to CHF because a Swiss book
  -- starting in francs is a real convenience with no wrong answer hidden behind it. A LINE's
  -- currency is a per-row FACT about money that actually moved, and no value is right when the
  -- writer failed to state one. Both writers do state it (postEntry from applyFx, saveDraft from
  -- baseCurrencyOf), so a default could only ever absorb a THIRD path's omission and book a
  -- plausible franc line. A NOT NULL violation an operator can see beats a wrong currency nobody
  -- notices. Existing files are rebuilt by generation 4 in ./migrations.ts.
  currency          TEXT NOT NULL,
  base_debit_minor  INTEGER NOT NULL DEFAULT 0,
  base_credit_minor INTEGER NOT NULL DEFAULT 0,
  fx_rate           TEXT,
  tax_code          TEXT,
  tax_base_minor    INTEGER,
  tax_amount_minor  INTEGER,
  -- The Leistungsdatum (supply date) that priced this line's VAT, or NULL when the entry date
  -- governs. A06 section 3: the rate in force on the SUPPLY date governs, not the one on the
  -- booking date, so filing a December supply in January prices it at the old rate and reports it
  -- on the old ESTV Ziffer. postEntry has taken this per line and priced with it since the
  -- straddle fix, but stored nothing, so A07 fell back to the entry date and silently merged the
  -- two vintages into one bucket: a 2023 supply invoiced in 2024 was declared on Ziffer 303 at
  -- 8.1% carrying tax computed at 7.7%, Ziffer 302 never appeared, and ESTV's cross-foot of Ziffer
  -- 303 against its own turnover came out short. It is per LINE, not per entry, because one
  -- compound entry may legitimately mix supply periods.
  --
  -- NULL is not "unknown, refuse": it is "the entry date governs", which is the ordinary case and
  -- what every row written before this column existed means. Existing files get the column from
  -- ADDITIVE_COLUMNS with NULL throughout, so no posted figure moves.
  supply_date       TEXT
);

-- journal_line is the largest table in any real book and it grows without bound, and until
-- 2026-07-25 it carried NO explicit index at all: only the implicit primary key on id. Every read
-- that filtered on anything else was a full scan of the whole ledger.
--
-- Measured on a 10'000-entry / 30'000-line book, before and after, running the REAL statements and
-- with no ANALYZE, because nothing in this codebase ever runs one:
--
--   list_journal (4 correlated subqueries per entry)   29'427 ms  ->  27.6 ms
--   list_journal filtered by account                    3'825 ms  ->   4.1 ms
--   list_documents (2 correlated subqueries per doc)    1'727 ms  ->  56.0 ms
--   list_accounts (in_use per row)                       52.1 ms  -> 0.056 ms
--   list_cost_centers (in_use per row)                    4.7 ms  -> 0.006 ms
--   get_entry / posting read-backs                        0.7 ms  -> 0.004 ms
--
-- The three columns are the three FOREIGN KEYS, which is not a coincidence: SQLite indexes the
-- parent side of a reference and never the child side, so every "what points at this row?" question
-- scans. entry_id answers it for the read models (getEntry, the four correlated subqueries in
-- listJournal, the two in DOCUMENT_SELECT, every posting read-back); account_id and
-- cost_center_id answer it for the usage guards behind the GUI's Archive-XOR-Delete decision and
-- for the chart's in_use flag, both of which ask about the accounts NOBODY posted to, and that is
-- exactly the question a scan has to read the entire table to answer.
--
-- Three single-column indexes, and deliberately not more:
--
--  * Making the entry index a COMPOSITE (entry_id, account_id) was measured and is worse, on the
--    READ side, which is the surprise. It does fix one statement (the receivable read-back in
--    issueInvoice, 0.180 ms -> 0.002 ms) but a wider key fits fewer entries per index page, and the
--    journal list pays for it: 28.2 ms -> 32.9 ms. That is the hottest read in the app made slower
--    to speed up a statement that runs once per invoice issue, at a size nobody can perceive.
--  * A WIDE covering entry index carrying the money columns was measured and buys nothing at all:
--    journal list 28.2 -> 28.9 ms, document list 56.0 -> 57.2 ms, and the FX method election gets
--    WORSE (1.76 -> 3.26 ms). Covering is also already true where it actually pays, without any
--    widening: EXISTS(SELECT 1 ...) and COUNT(*) read no column beyond the one they filter on, so
--    SQLite reports these as COVERING INDEX against the single-column form.
--  * tax_code and fx_rate are filtered by exactly one statement each (a tax-code edit, an FX
--    method election), both rare, both already around a millisecond. An index bought on faith is a
--    permanent write cost against a hypothetical read.
--
-- The write cost that IS paid, and it is not small in relative terms. Measured by INTERLEAVING
-- 10'000 posts across four ledgers in one process, batch by batch, so a load spike hits every arm
-- equally: a sequential before/after put the overhead at anywhere from 5% to 100% depending on what
-- else the machine was doing, and was measuring the machine as much as the indexes. Interleaved, the
-- per-post deltas are stable across runs:
--
--   no indexes                                    0.042 ms/post
--   entry_id                                                     +8 us/post
--   entry_id + account_id                                       +36 us/post
--   all three, as shipped                         0.086 ms/post  +44 us/post
--
-- So a post of an entry plus three lines roughly DOUBLES, and account_id is most of it. It is still
-- the right trade twice over: in absolute terms a post stays under a tenth of a millisecond on a
-- 30'000-line ledger, and the same account_id index turns a 52 ms chart-of-accounts render into a
-- 0.06 ms one. Even at one post per chart render that is 40 microseconds spent to save 52
-- milliseconds. What it is NOT is free, and a fourth index would have to clear the same bar.
--
-- Two statements were made SLOWER by these indexes, both because the planner has no table statistics
-- to work from. Both are FIXED now, per-statement, and neither is a residual anyone has to live with:
--
--  * close_year's P&L sweep got slower, 9.2 ms -> 15.2 ms. With no statistics the planner drives it
--    off journal_line_account as a full index scan plus a row fetch each, where even a plain table
--    scan was cheaper. FIXED in ../ledger/yearClose.ts, and not by asking for a different index: the
--    join ORDER is pinned, FROM journal_entry e CROSS JOIN journal_line l INDEXED BY
--    journal_line_entry ON l.entry_id = e.id, so the outer loop is the table the selective fence
--    actually lives on (one workspace, one year, posted, not a close) and a rejected entry's lines
--    are never fetched at all. Re-measured interleaved, 10'000 entries / 30'000 lines, 21 scored
--    rounds, median: 13.73 ms as-is -> 3.29 ms, which is what a full ANALYZE reaches (3.34 ms).
--    NOT INDEXED was the obvious lever and only manages 8.63 ms, because a scan still reads every
--    line of every year; do not "simplify" the shipped form back to it. The gain scales with how
--    much of the book lies OUTSIDE the closed year (1.65x when none of it does, 7.45x at 90%), so a
--    single-year fixture hides it: see the table on SqliteStore.close() before re-measuring.
--  * issueInvoice's receivable read-back (WHERE entry_id = ? AND account_id = ?) lands on
--    journal_line_account rather than journal_line_entry, 0.180 ms where 0.002 was available. Still
--    4x better than the 0.66 ms scan it replaced, and both index-set fixes for it cost more
--    elsewhere. FIXED in ../sales/invoice.ts with INDEXED BY journal_line_entry on the statement.
--
-- Both would ALSO have gone away if the store ran ANALYZE or PRAGMA optimize. It does not, and that
-- is now a SETTLED decision rather than an open question: see the note on SqliteStore.close() in
-- ./sqlite-store.ts, which measures what statistics buy (nothing perceptible either way) against
-- what they cost (ANALYZE is a write, and under D12's second writer it was measured waiting 5410 ms
-- before failing SQLITE_BUSY, on the close path). Per-statement levers take no lock, cannot go
-- stale, and are visible in the statement they affect. For the receivable read-back the hint is
-- measurably BETTER than statistics (7.2 us against 11.8 us), and for the sweep it draws level with
-- them. Both are pinned by tests: test/ledger/year-close-query-plan.test.mjs reads the sweep out of
-- the COMPILED module and asserts its plan, and test/core/journal-line-indexes.test.mjs pins this
-- index set exactly, which is what makes INDEXED BY safe as a hard constraint (drop the index and
-- the statement stops preparing, so the pin reddens first).
--
-- No data migration accompanies these (./migrations.ts is unchanged and SCHEMA_GENERATION stays
-- at 4). CREATE INDEX IF NOT EXISTS is not CREATE TABLE IF NOT EXISTS: on a file that lacks the
-- index it BUILDS it over the rows already there, so an existing ~/.till/till.db is fixed by the
-- open itself. There is no stored value to derive and nothing per-row to transform, so a generation
-- whose apply did nothing would be a lie in the version history. It is also self-healing on every
-- open, exactly like the triggers below, and the generation-4 rebuild replays whatever
-- sqlite_master holds, so it carries these across without knowing they exist.
CREATE INDEX IF NOT EXISTS journal_line_entry ON journal_line (entry_id);

CREATE INDEX IF NOT EXISTS journal_line_account ON journal_line (account_id);

-- PARTIAL, unlike the other two: a cost centre is optional and most lines carry none, so indexing
-- their NULLs would be write cost bought for rows no query ever asks about. cost_center_id = ?
-- implies IS NOT NULL, so the planner still uses it for both the usage guard and the in_use
-- flag. Measured interleaved against the unconditional form: identical reads, and +14 microseconds
-- per post for the NULLs nothing ever asks about.
CREATE INDEX IF NOT EXISTS journal_line_cost_center ON journal_line (cost_center_id)
WHERE cost_center_id IS NOT NULL;

-- §H-FX, the rate store (data model §D0: the exchange_rate table A19/A20/A22 read). A rate is
-- reference data, not a posting: it is not append-only, but it IS write-once per key, because a rate
-- that already priced a posting must never change under it (see recordExchangeRate).
--
-- The pair convention is the ordinary FX one: the rate column is the price of ONE unit of
-- base_currency expressed in quote_currency, so EUR/CHF 0.9412 means 1 EUR = 0.9412 CHF. The
-- workspace LEDGER base currency is therefore the QUOTE side, and the engine only stores rows whose
-- quote_currency is that base currency (a row nothing can resolve is refused rather than kept).
--
-- rate is the canonical decimal STRING (what the audit trail and journal_line.fx_rate carry) and
-- rate_scaled is the same value as an exact integer at RATE_SCALE, 1e12 (what the money math uses).
-- Both are derived from the one scaled integer at write time, so they cannot disagree.
--
-- The STRING is the authoritative one, and rate_scaled is its cache. That is what makes the scale a
-- migratable property rather than a permanent decision: SCALE_MIGRATIONS below recomputes the
-- integer from the string when the scale generation changes, and nothing has to remember what the
-- old scale was. Widening from 1e8 to 1e12 on 2026-07-25 is the first such change, made so the four
-- currencies the ESTV-named BAZG series publishes at nine decimal places (IDR, KHR, COP, LBP) can be
-- booked at all.
--
-- source is the §D0 enum manual|rate_api (HOW the row got here: a human typed it, or a feed wrote
-- it); provenance is the free-text citation of WHERE the rate came from, so an auditor can retrace
-- it. Unique per (workspace, pair, validity date, source), which is what makes recording a rate
-- twice a genuine no-op (§H-IDEMPOTENT).
--
-- method is ADDITIVE to §D0 and is the compliance-bearing field: MWSTV Art. 45 (SR 641.201) admits
-- the ESTV Monatsmittelkurs, the ESTV Tageskurs für den Verkauf von Devisen, a domestic bank rate
-- ONLY where the ESTV publishes none (Abs. 3bis), and a group rate for group members applied
-- group-wide (Abs. 4). Abs. 5 then binds the chosen method for at least one Steuerperiode, which
-- MWSTG Art. 34 Abs. 2 fixes as the calendar year. Without this column the books could not say WHICH
-- admissible method priced them, which is the one thing an ESTV control asks.
CREATE TABLE IF NOT EXISTS exchange_rate (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  base_currency  TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate           TEXT NOT NULL,
  rate_scaled    INTEGER NOT NULL,
  as_of          TEXT NOT NULL,
  source         TEXT NOT NULL,
  method         TEXT,
  provenance     TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT,
  UNIQUE (workspace_id, base_currency, quote_currency, as_of, source)
);

CREATE INDEX IF NOT EXISTS exchange_rate_resolution
ON exchange_rate (workspace_id, base_currency, quote_currency, as_of DESC);

-- §H-FX, the MWSTV Art. 45 Abs. 5 method lock: which admissible conversion basis a workspace has
-- ELECTED, per Steuerperiode. MWSTG Art. 34 Abs. 2 makes the Steuerperiode the calendar year, so
-- tax_period is a four-digit year and nothing finer.
--
-- One row per period the workspace actually chose in, not one per year: an election CARRIES FORWARD
-- until it is changed (a taxable person does not re-elect annually), so the basis governing a date is
-- the newest row whose tax_period is on or before that date's year. A period before the first row
-- is unelected, and nothing is enforced there.
--
-- The row is not history: it is the current claim for its period, and it stops being writable the
-- moment the period holds a posted foreign-currency entry (see core/fx/method.ts). Books already
-- made are never re-based, which is what Abs. 5 is for.
CREATE TABLE IF NOT EXISTS fx_method_election (
  workspace_id   TEXT NOT NULL REFERENCES workspace(id),
  tax_period     TEXT NOT NULL,
  method         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  created_by     TEXT,
  PRIMARY KEY (workspace_id, tax_period)
);

-- A22, the FX revaluation RUN log. One row per period end a workspace has revalued, and it is the
-- single source of truth for the H-IDEMPOTENT "a period end is revalued at most once" contract: the
-- UNIQUE (workspace_id, period_end) makes a second post either an idempotent replay (same key) or an
-- already_posted refusal (different key). It carries the posted revaluation entry and its
-- next-period reversal (a real H-AUDIT linked pair in journal_entry, never a mutation), so a run is
-- fully reconstructable from the ledger it links to. A zero-diff period posts nothing and writes NO
-- row, so it stays re-runnable once a rate is recorded.
CREATE TABLE IF NOT EXISTS fx_revaluation (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspace(id),
  period_end             TEXT NOT NULL,
  entry_id               TEXT REFERENCES journal_entry(id),
  reversal_id            TEXT REFERENCES journal_entry(id),
  total_unrealised_minor INTEGER NOT NULL,
  idempotency_key        TEXT NOT NULL,
  posted_at              TEXT NOT NULL,
  posted_by              TEXT,
  UNIQUE (workspace_id, period_end)
);

CREATE TABLE IF NOT EXISTS tax_code (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  code          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  rate_bp       INTEGER NOT NULL DEFAULT 0,
  method        TEXT,
  esa_form_line TEXT,
  label         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  valid_from    TEXT,
  UNIQUE (workspace_id, code)
);

-- F11. ONE ESTV Bewilligung, and the day it started governing.
--
-- vat_saldo_rate lived here until generation 5 and held CURRENT configuration, rewritten wholesale
-- on every save. It is GONE rather than extended, so a query that still names it fails loudly. See
-- the generation-5 note in this file's header for why that is the point and not a courtesy.
--
-- valid_from is an inclusive ISO day; valid_to is the inclusive last day, NULL while open. The FIRST
-- generation a workspace ever records opens at '0001-01-01', because before it there was no approval
-- at all and refusing a 2019 correction return on the ground that nothing governed 2019 teaches
-- nobody anything. Only a LATER approval plants a boundary, and a boundary is what makes a period
-- that straddles it refusable instead of quietly computed from the wrong grant.
CREATE TABLE IF NOT EXISTS vat_saldo_generation (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  valid_from   TEXT NOT NULL,
  valid_to     TEXT,
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  PRIMARY KEY (workspace_id, valid_from)
);

-- One approved Saldosteuersatz inside one Bewilligung (MWSTV Art. 86 Abs. 1: a rate is granted for
-- every Tätigkeit above 10 percent of taxable turnover). position is the 1-based ordinal and drives
-- the ESTV Ziffer, 1st -> 323, 2nd -> 333; a 3rd has no Ziffer on the current form, so form_line is
-- NULL there. The V vom 21. Aug. 2024 (AS 2024 485, in force 1.1.2025) repealed MWSTV Art. 87 and
-- with it the old two-rate cap, so a third rate is reachable configuration and not a theoretical one.
--
-- THE UNIQUE ON rate_bp IS LOAD-BEARING, and it is here because the previous design argued for it in
-- a comment instead. The account mapping resolves a Tätigkeit's rate to a position ONCE, at write
-- time. With two positions carrying one rate that resolution is ambiguous, and the failure mode is
-- not an error: it silently merges two Tätigkeiten onto one rate and a Ziffer disappears from the
-- form. Enforced by the schema, the ambiguity cannot exist to be resolved.
CREATE TABLE IF NOT EXISTS vat_saldo_generation_rate (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  valid_from   TEXT NOT NULL,
  position     INTEGER NOT NULL,
  rate_bp      INTEGER NOT NULL,
  form_line    TEXT,
  PRIMARY KEY (workspace_id, valid_from, position),
  UNIQUE (workspace_id, valid_from, rate_bp)
);

-- One Tätigkeit inside one Bewilligung, and the rate POSITION the ESTV approved for it.
--
-- SEVERAL TÄTIGKEITEN MAY SHARE ONE SALDOSTEUERSATZ, which is why this is a table and not a column
-- on the rate. MWSTV Art. 86 Abs. 3: "Die Umsätze von Tätigkeiten mit gleichem Saldosteuersatz sind
-- bei der Abklärung, ob die 10-Prozent-Grenze überschritten wird, zusammenzuzählen." Abs. 4 says it
-- again ("der Umsatz mehrerer Tätigkeiten, für die der gleiche Saldosteuersatz festgelegt ist"). A
-- model of one Tätigkeit per rate contradicts the article it claims to implement, and the eCH-0217
-- lane already needs the identity: from 01.01.2025 every Saldo turnover row carries the ESTV's
-- five-character Tätigkeitscode (activity_code here), and Kap. 5.3.6 says the same rate may repeat
-- across rows.
--
-- activity_id is the operator's stable handle, not a mint: it is what carries a Tätigkeit's account
-- mapping across a later Bewilligung without going through the rate, which is how the previous
-- design lost an account to the wrong rate on a reorder.
CREATE TABLE IF NOT EXISTS vat_saldo_activity (
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  valid_from    TEXT NOT NULL,
  activity_id   TEXT NOT NULL,
  position      INTEGER NOT NULL,
  name          TEXT NOT NULL,
  activity_code TEXT,
  PRIMARY KEY (workspace_id, valid_from, activity_id)
);

-- MWSTV Art. 84 Abs. 3, the bookkeeping obligation: "Steuerpflichtige Personen, denen mehrere
-- Saldosteuersätze bewilligt wurden, müssen die Erträge für jeden dieser Saldosteuersätze separat
-- verbuchen." TILL discharges it through the CHART: an Ertragskonto belongs to one Tätigkeit, and
-- the turnover booked on it is that Tätigkeit's.
--
-- Deliberately NOT a tax code on the line. A posted line is immutable, so a code stamped on it could
-- never be corrected when the ESTV reassigns a Tätigkeit, and the correction would have to be a
-- reversing entry for a reporting change that moved no money.
--
-- THE PRIMARY KEY IS THE INVARIANT: (workspace_id, valid_from, account_id) makes one account belong
-- to at most one Tätigkeit per generation, so turnover cannot be attributed twice or split by
-- accident. A second row for the same account is a constraint failure, not a double count.
CREATE TABLE IF NOT EXISTS vat_saldo_activity_account (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  valid_from   TEXT NOT NULL,
  account_id   TEXT NOT NULL REFERENCES account(id),
  activity_id  TEXT NOT NULL,
  PRIMARY KEY (workspace_id, valid_from, account_id)
);

-- MWSTV Art. 88 Abs. 6, the voluntary simplification: "Die steuerpflichtige Person kann den gesamten
-- Umsatz aus steuerbaren Leistungen freiwillig zum höchsten bewilligten Saldosteuersatz abrechnen."
--
-- It is an ELECTION, so the engine never applies it on its own: it names it in a hint and this table
-- records that a person chose it. Stored PER STEUERPERIODE (the calendar year, MWSTG Art. 34 Abs. 2)
-- and NOT on the Bewilligung, which was the offered alternative. Withdrawing a voluntary
-- simplification is lawful at the next Steuerperiode; recorded on the Bewilligung it would plant a
-- generation boundary inside the period and refuse the whole quarter for a change that moved no
-- money. Same shape as fx_method_election above, for the same reason.
CREATE TABLE IF NOT EXISTS vat_saldo_declaration_election (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  tax_period   TEXT NOT NULL,
  basis        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  PRIMARY KEY (workspace_id, tax_period)
);

-- Which Abrechnungsmethode governed which days (MWSTG Art. 36 effektiv / Art. 37 Saldo, and Art. 39
-- soll / ist).
--
-- The method used to be read off workspace.vat_method, undated, by every consumer. That is the one
-- field that decides which of the two branches in computeVatReturn runs at all, so leaving it
-- undated while dating everything else preserves the rate history and makes it UNREACHABLE: the
-- branch is taken before a rate is read. Measured on the previous attempt, a filed Saldo half-year
-- of CHF 67.02 became CHF 81.00 the moment the workspace lawfully left Saldo, with nothing refusing,
-- warning, or recording which figure was filed.
--
-- MWSTG Art. 37 Abs. 4: "Wechsel sind jeweils auf Beginn einer Steuerperiode möglich." So a change
-- is lawful, dated, and rare. Like the Saldo generations, the FIRST era opens at '0001-01-01'.
CREATE TABLE IF NOT EXISTS vat_method_era (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  valid_from   TEXT NOT NULL,
  valid_to     TEXT,
  method       TEXT NOT NULL,
  timing       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_by   TEXT,
  PRIMARY KEY (workspace_id, valid_from)
);

CREATE TABLE IF NOT EXISTS period_lock (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  period       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  locked_at    TEXT NOT NULL,
  locked_by    TEXT,
  reason       TEXT,
  PRIMARY KEY (workspace_id, period)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  entity_kind  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  actor        TEXT,
  at           TEXT NOT NULL,
  prev_hash    TEXT,
  hash         TEXT NOT NULL
);

-- The audit chain's tail anchor (A03). One row per workspace holding the chain length and head hash.
-- A bare prev/hash chain cannot detect TAIL truncation (deleting the last rows leaves a valid shorter
-- prefix), so getAuditLog cross-checks the walked length + last hash against this anchor: a truncated
-- or wholly-deleted log then fails to verify. It raises the bar on tampering (a forger must now also
-- rewrite this row); the external, out-of-band anchor is the cloud archive export (OP4, out of scope).
CREATE TABLE IF NOT EXISTS audit_head (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
  row_count    INTEGER NOT NULL,
  head_hash    TEXT NOT NULL
);

-- A09 owns the base (the invoicing-lite party record); C00 (contacts / CRM core) owns the extension
-- columns below created_at. They live on the SAME physical table because C00 extends A09 rather than
-- forking it: party_role (A09's customer|vendor|both axis) and kind (C00's company|person axis) are
-- two orthogonal facts about one row. A book created before C00 gets these columns from
-- ADDITIVE_COLUMNS on open; this list is the fresh-DB path, kept in sync the way journal_line's
-- supply_date is in both places. roles/segments are JSON arrays; merged_into_id, when set, makes the
-- row a merge tombstone (one-way, US-C00.4) that lists exclude and reads redirect through.
CREATE TABLE IF NOT EXISTS contact (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id),
  party_role         TEXT NOT NULL,
  name               TEXT NOT NULL,
  address_street     TEXT,
  address_house_no   TEXT,
  address_zip        TEXT,
  address_city       TEXT,
  address_country    TEXT,
  vat_number         TEXT,
  email              TEXT,
  default_currency   TEXT NOT NULL DEFAULT 'CHF',
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  archived           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'company',
  company_contact_id TEXT,
  roles              TEXT NOT NULL DEFAULT '[]',
  segments           TEXT NOT NULL DEFAULT '[]',
  lang               TEXT,
  merged_into_id     TEXT,
  ledger_grounding_enabled INTEGER NOT NULL DEFAULT 0
);

-- A09 owns the invoicing-lite columns; D00 EXTENDS the table with the products/items master fields
-- (item_sku .. reorder_point_qty). On an existing database these arrive through ADDITIVE_COLUMNS, so
-- they appear here for a fresh database and as documentation. default_unit_price_minor is the SALES
-- price (D00's sales_price_rappen); cost_price_minor is the Einstandspreis. All new fields are
-- nullable/defaulted so every A09 create_item that predates D00 stays valid.
CREATE TABLE IF NOT EXISTS item (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspace(id),
  name                     TEXT NOT NULL,
  default_unit_price_minor INTEGER NOT NULL DEFAULT 0,
  currency                 TEXT NOT NULL DEFAULT 'CHF',
  default_tax_code         TEXT,
  revenue_account_id       TEXT REFERENCES account(id),
  unit                     TEXT,
  archived                 INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL,
  item_sku                 TEXT,
  kind                     TEXT,
  category_id              TEXT REFERENCES item_category(id),
  cost_price_minor         INTEGER,
  variant_of_id            TEXT REFERENCES item(id),
  track_stock              INTEGER NOT NULL DEFAULT 0,
  reorder_point_qty        INTEGER
);

-- A10 document lifecycle: the shared quote/order/invoice/credit_note object. One table, four
-- OP3-registered types (§4). The number is NULL while draft and assigned gap-free on a SUCCESSFUL
-- issue (D32); status is the P7 §H-ENUM value list, enforced by the engine, not a CHECK constraint.
-- source_document_id links a convert target back to its source; posted_entry_id links an issued
-- financial document to its journal entry so cancel knows what to reverse (§H-AUDIT). Totals are net
-- integer Rappen (P2); A10 posts no VAT itself, the A11/A13 delegate owns the tax legs. Every row
-- carries workspace_id (§H-TENANT).
CREATE TABLE IF NOT EXISTS document (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspace(id),
  type               TEXT NOT NULL,
  number             TEXT,
  status             TEXT NOT NULL,
  contact_id         TEXT REFERENCES contact(id),
  currency           TEXT NOT NULL DEFAULT 'CHF',
  source_document_id TEXT REFERENCES document(id),
  posted_entry_id    TEXT REFERENCES journal_entry(id),
  subtotal_minor     INTEGER NOT NULL DEFAULT 0,
  tax_minor          INTEGER NOT NULL DEFAULT 0,
  total_minor        INTEGER NOT NULL DEFAULT 0,
  issue_date         TEXT,
  due_date           TEXT,
  notes              TEXT,
  -- A11 additive column: who an invoice was emailed to (sendInvoice, §5). The status trail records
  -- WHEN 'sent' happened; this records to WHOM. Nullable; only invoices ever populate it.
  sent_to_email      TEXT,
  -- A13 additive column: the invoice a Gutschrift credits. NULL for every other type and for a
  -- credit-note draft made through the generic verb (which can therefore never post). Written ONLY
  -- by createCreditNote; the over-credit guard, the invoice-cancel guard and A16's netting all read
  -- it. ADDITIVE_COLUMNS carries it onto pre-A13 files; document_credited in ADDITIVE_INDEXES
  -- covers the reverse lookup.
  credited_document_id TEXT REFERENCES document(id),
  -- C02 additive columns (spec section 4): quote-owned state on the shared row, populated ONLY for
  -- type=quote. Declared here for a FRESH database and repeated in ADDITIVE_COLUMNS so a pre-C02
  -- file widens on open. None is a money figure. version/supersedes_id carry the revision chain;
  -- accept_token_hash is the single-use e-accept secret's hash (never the token); accepted_by /
  -- decline_reason the acceptance/decline record. valid_until is the OR Art. 3 binding window.
  valid_until        TEXT,
  deal_id            TEXT REFERENCES deal(id),
  intro              TEXT,
  outro              TEXT,
  version            INTEGER NOT NULL DEFAULT 1,
  supersedes_id      TEXT REFERENCES document(id),
  accept_token_hash  TEXT,
  accepted_by        TEXT,
  decline_reason     TEXT,
  -- G21 additive column: the carry-forward origin (native | migrated). A native document is the
  -- ordinary A10 one that posts on issue; a migrated one is an open item brought across from an old
  -- system at a cutover, created directly at 'issued' with posted_entry_id NULL and posting NOTHING
  -- (its only ledger effect is A04's aggregate 1100 opening line). Declared here for a FRESH database
  -- and repeated in ADDITIVE_COLUMNS so a pre-G21 file widens on open, reading every existing row as
  -- 'native' (which they are). It selects whether the poster runs, so it is a fixed §H-ENUM and never
  -- a custom field (spec §6b Fixed).
  origin             TEXT NOT NULL DEFAULT 'native',
  created_at         TEXT NOT NULL
);

-- The GAP B self-join (src/core/sales/document.ts, DOCUMENT_SELECT). Every document read carries a
-- correlated subquery looking for the document converted OUT of this one, and with no index that
-- subquery was a full table scan of document run once per output row: QUADRATIC in document count,
-- and the entire residual cost of list_documents after the journal_line indexes landed.
--
-- Measured interleaved (four arms, one process, batches alternated, median round), on 10'000
-- entries / 30'000 lines:
--
--   documents         500      1000      2000      4000
--   no index       17.0 ms   65.8 ms   248.2 ms  1524.8 ms
--   with this       1.6 ms    3.1 ms     6.0 ms    20.6 ms
--
-- D34 caps list_documents at 1000 rows, so 65.8 -> 3.1 ms is the figure that ships; the wider curve
-- is there to show the shape, because a scan-per-row does not degrade gracefully.
--
-- PARTIAL, and for two reasons rather than one:
--
--  * Write cost. Most documents were converted out of nothing, so an unconditional index buys entries
--    for rows the subquery never seeks. Measured transactionally (batches of 100 inserts, which is
--    how saveDraft actually writes), at a 5% conversion rate: partial +0.07 us/insert (+2%),
--    unconditional +1.17 us/insert (+30%). At 30%: +0.70 us (+18%) against +1.45 us (+37%). Two
--    independent runs agreed to within 0.05 us.
--  * The plan it does NOT capture, which matters more. TILL is one SQLite file per workspace, so
--    workspace_id holds exactly ONE distinct value and buys no selectivity whatever. With no
--    statistics the planner cannot know that, and given an unconditional index it drives
--    list_documents' OUTER query off it as SEARCH d USING INDEX (workspace_id=?): a b-tree walk plus
--    a row fetch to return every row a plain SCAN already returned (3.089 ms against 2.913 ms). A
--    partial index is INADMISSIBLE there, because WHERE d.workspace_id = ? does not imply
--    source_document_id IS NOT NULL. So the outer plan stays right BY CONSTRUCTION instead of by
--    the planner guessing well, which is the same statistics-free failure that regressed close_year.
--
-- Column order is workspace_id first, matching exchange_rate_resolution and §H-TENANT. Both orders
-- were measured, on reads and on writes, and were identical to within noise, so the tie goes to the
-- house convention. source_document_id = ? implies IS NOT NULL, so the convert-target lookup
-- (document.ts, findConvertTarget) gets the index for its OUTER query too.
--
-- No data migration: see the note on the journal_line indexes above. CREATE INDEX IF NOT EXISTS
-- builds and POPULATES the index over rows already on disk, so an existing ~/.till/till.db is fixed
-- by the open itself and SCHEMA_GENERATION stays at 4.
CREATE INDEX IF NOT EXISTS document_source ON document (workspace_id, source_document_id)
WHERE source_document_id IS NOT NULL;

-- A document's positions (A10 carries enough for totals + convert-cloning; A11 enriches the invoice
-- line). Amounts are integer Rappen; line_total_minor = quantity_milli * unit_price_minor / 1000,
-- rounded half away from zero, computed by the engine (never a float on the money path).
CREATE TABLE IF NOT EXISTS document_line (
  id               TEXT PRIMARY KEY,
  document_id      TEXT NOT NULL REFERENCES document(id),
  workspace_id     TEXT NOT NULL REFERENCES workspace(id),
  position         INTEGER NOT NULL,
  item_id          TEXT REFERENCES item(id),
  description      TEXT,
  quantity_milli   INTEGER NOT NULL DEFAULT 1000,
  unit_price_minor INTEGER NOT NULL DEFAULT 0,
  line_total_minor INTEGER NOT NULL DEFAULT 0,
  tax_code         TEXT,
  supply_date      TEXT,
  -- A13 §4b.1: the invoice position this credit line derives from. Written ONLY by
  -- createCreditNote's derivation (no edit path exists: updateDocument refuses line patches on an
  -- FK-carrying credit note), read by the per-line over-credit cap and the per-class closure. NULL
  -- everywhere else.
  credited_line_position INTEGER
);

-- The status trail (§4): auditable even though only the *ledger* entry is immutable. One append-row
-- per status change (create stamps null -> draft), so an auditor can read the document's whole life.
CREATE TABLE IF NOT EXISTS document_status_history (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES document(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  actor        TEXT,
  at           TEXT NOT NULL
);

-- Document numbering (D32, OR Art. 957 ff.): gap-free, monotonic per type per YEAR, one counter per
-- (workspace, type, year) that resets each year. The counter is consumed only on a successful issue
-- (the transition transaction increments it), so a rejected or rolled-back issue leaves no gap.
CREATE TABLE IF NOT EXISTS document_number_seq (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  type         TEXT NOT NULL,
  year         TEXT NOT NULL,
  next_value   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, type, year)
);

-- Idempotency is scoped per (workspace, verb, key): the same key means "the same operation" only
-- within one verb, so reusing a key across a document's saveDraft -> postEntry lifecycle (or a
-- reversal that borrows the original post's key) can never silently replay the wrong verb's result.
CREATE TABLE IF NOT EXISTS idempotency (
  workspace_id TEXT NOT NULL,
  key          TEXT NOT NULL,
  verb         TEXT NOT NULL,
  result_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, verb, key)
);

-- Reversed-once (§6b reversal mechanics): at most one entry may reverse a given entry, enforced at
-- the DB layer so even a cross-process TOCTOU race cannot post two reversals of the same entry.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entry_one_reversal
ON journal_entry (reverses_entry_id)
WHERE reverses_entry_id IS NOT NULL;

-- Immutability (§H-AUDIT, risk R3), enforced at the DB layer so no code path, ORM, plugin, or raw
-- statement can update or delete a posted entry, or add / change / remove a posted line. A posting
-- writes its rows while the entry is still 'draft' and flips to 'posted' as the last step, so these
-- triggers never fire on the legitimate post. Correction is by reversal only (a new entry).
CREATE TRIGGER IF NOT EXISTS journal_entry_no_update_posted
BEFORE UPDATE ON journal_entry
WHEN OLD.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'posted_immutable');
END;

CREATE TRIGGER IF NOT EXISTS journal_entry_no_delete_posted
BEFORE DELETE ON journal_entry
WHEN OLD.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'posted_immutable');
END;

CREATE TRIGGER IF NOT EXISTS journal_line_no_insert_posted
BEFORE INSERT ON journal_line
WHEN (SELECT status FROM journal_entry WHERE id = NEW.entry_id) = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'posted_immutable');
END;

CREATE TRIGGER IF NOT EXISTS journal_line_no_update_posted
BEFORE UPDATE ON journal_line
WHEN (SELECT status FROM journal_entry WHERE id = OLD.entry_id) = 'posted'
   OR (SELECT status FROM journal_entry WHERE id = NEW.entry_id) = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'posted_immutable');
END;

CREATE TRIGGER IF NOT EXISTS journal_line_no_delete_posted
BEFORE DELETE ON journal_line
WHEN (SELECT status FROM journal_entry WHERE id = OLD.entry_id) = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'posted_immutable');
END;
`;

/**
 * The applied schema: the Wave-0 core above, plus each capability's own DDL appended.
 *
 * A capability that owns tables keeps their DDL in its own module (A14: `core/payments/schema.ts`)
 * and joins it here. That keeps the money-path DDL beside the code that writes it, and it keeps
 * concurrent capability branches from all editing one 300-line string.
 */
export const SCHEMA_SQL = `${CORE_SCHEMA_SQL}\n${PAYMENT_SCHEMA_SQL}\n${DEBTORS_SCHEMA_SQL}\n${BANKING_SCHEMA_SQL}\n${ACCESS_SCHEMA_SQL}\n${CUSTOMIZATION_SCHEMA_SQL}\n${AUTOMATION_SCHEMA_SQL}\n${SALES_SCHEMA_SQL}\n${CONTACT_ACTIVITY_SCHEMA_SQL}\n${PURCHASE_SCHEMA_SQL}\n${CAPTURE_SCHEMA_SQL}\n${FILES_SCHEMA_SQL}\n${DUNNING_SCHEMA_SQL}\n${RECURRING_SCHEMA_SQL}\n${QR_MATCH_SCHEMA_SQL}\n${CAMT_SCHEMA_SQL}\n${PAIN001_SCHEMA_SQL}\n${REVIEW_SCHEMA_SQL}\n${AGENT_SCHEMA_SQL}\n${MIGRATION_SCHEMA_SQL}\n${ONBOARDING_SCHEMA_SQL}\n${MOVE_SCHEMA_SQL}\n${GL_ARCHIVE_SCHEMA_SQL}\n${EXTRACTION_MANIFEST_SCHEMA_SQL}\n${PROJECTS_SCHEMA_SQL}\n${TASKS_SCHEMA_SQL}\n${TIME_SCHEMA_SQL}\n${DEALS_SCHEMA_SQL}\n${STOCK_SCHEMA_SQL}\n${SALES_ORDER_SCHEMA_SQL}\n${PURCHASE_ORDER_SCHEMA_SQL}\n${HR_SCHEMA_SQL}\n${RETAINER_SCHEMA_SQL}\n${SIGN_SCHEMA_SQL}\n${PORTAL_SCHEMA_SQL}\n${REMITTANCE_SCHEMA_SQL}\n${REPORTBUILDER_SCHEMA_SQL}\n${MAIL_SCHEMA_SQL}\n${VOICE_SCHEMA_SQL}\n${DRAFTING_SCHEMA_SQL}\n${DATA_SCHEMA_SQL}\n${DOCUMENT_TEMPLATE_SCHEMA_SQL}\n${NOTIFICATIONS_SCHEMA_SQL}\n${PLUGINS_SCHEMA_SQL}\n${DISPATCH_SCHEMA_SQL}\n${PAYROLL_HANDOFF_SCHEMA_SQL}\n${EBILL_SCHEMA_SQL}\n${EBICS_SCHEMA_SQL}\n${MANAGED_SCHEMA_SQL}\n${ASSETS_SCHEMA_SQL}\n${ASSET_MASTER_SCHEMA_SQL}\n${PROCUREMENT_SCHEMA_SQL}\n${INVENTORY_SCHEMA_SQL}\n${DEPRECIATION_SCHEMA_SQL}\n${TRACKING_SCHEMA_SQL}\n${ASSET_TRANSACTION_SCHEMA_SQL}\n${PO_VERSION_SCHEMA_SQL}\n${ASSET_TRANSFER_SCHEMA_SQL}\n${MAINTENANCE_SCHEMA_SQL}\n${MOVEMENT_SCHEMA_SQL}\n${DEPRECIATION_RUN_SCHEMA_SQL}\n${RECEIPT_SCHEMA_SQL}\n${VALUATION_SCHEMA_SQL}\n${LANDED_COST_SCHEMA_SQL}\n${THREE_WAY_MATCH_SCHEMA_SQL}\n${RECONCILIATION_SCHEMA_SQL}\n${STOCKTAKE_SCHEMA_SQL}\n${ADJUST_SCHEMA_SQL}\n${SYNC_SCHEMA_SQL}\n${IMPLEMENTATION_PROJECT_SCHEMA_SQL}\n${CHECKLISTS_SCHEMA_SQL}\n${FILE_UPLOAD_SCHEMA_SQL}`;
