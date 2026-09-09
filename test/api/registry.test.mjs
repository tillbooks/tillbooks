// The registry is the single §H-ENUM source of the tool surface: names unique and stable, every
// intended Wave-0 verb covered (no orphan, no missing), and the post_entry money-path guardrail.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, getAction, POST_ENTRY_SOURCES } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace, manualPost } from './support.mjs';

// The full Wave-0 tool surface, in registry order (append-only). A rename or reorder must be a
// deliberate edit here, so an accidental drift is caught.
const EXPECTED_NAMES = [
  // A00
  'create_workspace',
  'bootstrap_workspace',
  'set_fiscal_config',
  'set_vat_method',
  'set_creditor_profile',
  'get_company_profile',
  'update_company_profile',
  // A01
  'create_account',
  'update_account',
  'archive_account',
  'unarchive_account',
  'delete_account',
  'list_accounts',
  'create_cost_center',
  'archive_cost_center',
  'unarchive_cost_center',
  'delete_cost_center',
  'list_cost_centers',
  // A02
  'post_entry',
  'reverse_entry',
  'save_draft',
  'delete_draft',
  'get_entry',
  'list_journal',
  // A03
  'close_month',
  'reopen_month',
  'close_year',
  'lock_period',
  'unlock_period',
  'get_audit_log',
  'list_period_locks',
  // A05
  'vat_seed_defaults',
  'vat_configure',
  'vat_config',
  'vat_saldo_generations',
  'vat_saldo_eligibility',
  'vat_saldo_declaration_basis',
  'vat_codes',
  'vat_code_upsert',
  'vat_code_deactivate',
  'vat_code_reactivate',
  'account_set_tax_default',
  // A06
  'vat_preview',
  // A07
  'vat_return',
  // Pinned NEXT TO the read it serialises, not at the end: this list mirrors the registry's
  // capability grouping, and A07's block is followed by A09.
  'vat_export_ech0217',
  'vat_periods',
  'vat_mark_filed',
  // A09
  'create_contact',
  'update_contact',
  'archive_contact',
  'unarchive_contact',
  'get_contact',
  'list_contacts',
  'create_item',
  'update_item',
  'archive_item',
  'unarchive_item',
  'get_item',
  'list_items',
  // (D12's `list_workspaces` sat here until A23 migrated it into workspace-actions.ts, at the end.)
  // A10
  'create_document',
  'update_document',
  'transition_document',
  'convert_document',
  'get_document',
  'list_documents',
  // A11
  'issue_invoice',
  'send_invoice',
  // A13, credit notes: the ONLY two credit-note-named tools (D14 parity with A11). Read/list/PDF
  // ride get_document and list_documents; cancel rides transition_document.
  'create_credit_note',
  'issue_credit_note',
  // A32, eBill issuing: the config pair + prepare/transmit/status, spread in after A13.
  'get_ebill_config',
  'set_ebill_config',
  'ebill_prepare',
  'ebill_transmit',
  'ebill_delivery_status',
  // A33, EBICS bank channel
  'bank_channel_connect',
  'bank_sync',
  'payment_batch_transmit',
  'bank_channel_disconnect',
  'bank_channel_status',
  // A36, live bank feed (read: static bank directory; write: scheduled-sync rule linkage)
  'bank_channel_directory',
  'set_bank_sync_schedule',
  // A19 / §H-FX
  'record_exchange_rate',
  'list_exchange_rates',
  'get_exchange_rate',
  // §H-FX, the MWSTV Art. 45 Abs. 5 method lock
  'set_fx_method',
  'get_fx_method',
  // §H-FX, the ESTV/BAZG rate feed
  'describe_rate_feed',
  'import_exchange_rates',
  // A22, FX revaluation: the read model and its poster
  'fx_revaluation',
  'post_fx_revaluation',
  // A14, payments and matching: five reads and three writes, every write carrying an explicit
  // intent (owner decision P9) so money never moves as a side effect of anything.
  'preview_payment',
  'suggest_payment_matches',
  'record_payment',
  'allocate_payment',
  'reverse_payment',
  'get_payment',
  'list_payments',
  'set_write_off_threshold',
  // A16, Debitoren (the OP-Liste and its aging buckets).
  'list_open_items',
  'customer_balance',
  'aging_report',
  'get_aging_bucket_config',
  'set_aging_bucket_config',
  // A19
  'create_bank_account',
  'update_bank_account',
  'set_bank_opening_balance',
  // D43/B2, the read half of the verb above. It sits NEXT TO the write it previews rather than at
  // the end of this list, because the list is the registry's order and the registry groups by
  // capability: the A19 block is followed by A08 and A04, so "appended at the end" was never where a
  // new A19 verb goes.
  'preview_bank_opening_balance',
  'archive_bank_account',
  'unarchive_bank_account',
  'list_bank_accounts',
  'get_bank_account',
  // A08, the financial statements. Five reads: A08 owns no table and posts nothing, so none of
  // these appears in the conformance write scenarios and none carries an idempotency key.
  'trial_balance',
  'balance_sheet',
  'income_statement',
  'general_ledger',
  'export_statement',
  // A04, opening balances (set / preview / import / read).
  'set_opening_balances',
  'preview_opening_import',
  'import_opening_balances',
  'get_opening_balances',
  // G08, feedback and diagnostics.
  'preview_feedback',
  'prepare_feedback',
  'list_feedback',
  'get_diagnostics',
  'set_diagnostics',
  'clear_diagnostics',
  // A24, access control.
  'whoami',
  'list_members',
  'list_roles',
  'invite_member',
  'accept_invite',
  'set_role',
  'revoke_member',
  'define_role',
  'archive_role',
  // G00, the customization framework.
  'define_field',
  'confirm_field',
  'archive_field',
  'list_field_defs',
  'set_field_value',
  'list_field_values',
  'create_saved_view',
  'update_saved_view',
  'delete_saved_view',
  'list_saved_views',
  // G05, document templates. Four writes and three reads; presentation only, the QR payload and
  // every money figure pass through the render seam byte-identical.
  'create_document_template',
  'update_document_template',
  'set_default_document_template',
  'archive_document_template',
  'preview_document_template',
  'list_document_templates',
  'get_document_template',
  // G05 §10, dispatch texts and the cross-document send log (D29). One naturally-idempotent write
  // and two reads; the three send verbs are untouched and merely append log rows.
  'dispatch_text_upsert',
  'dispatch_preview',
  'list_dispatches',
  // G01, automation rules. Seven writes and four reads. `disable_automation_rule` is the only write in
  // this capability that is ungated at the boundary, and it carries its reason in
  // `core/access/actionCapabilities.ts`. `run_due_automations` was the second until the wave critic
  // measured a non-member driving five journal entries through it.
  'create_automation_rule',
  'update_automation_rule',
  'enable_automation_rule',
  'disable_automation_rule',
  'archive_automation_rule',
  'run_due_automations',
  'retry_automation_run',
  'list_automation_rules',
  'get_automation_rule',
  'list_automation_runs',
  'get_automation_run',
  // D00, the products/items master's new verbs (item-actions.ts, spread after automation).
  'delete_item',
  'item_categories_upsert',
  'item_categories_delete',
  'item_categories_list',
  'price_lists_upsert',
  'price_lists_set_price',
  'price_lists_list',
  'price_lists_get',
  'price_resolve',
  // D00 completion: the two removals. Appended after `price_resolve` rather than filed beside
  // `price_lists_set_price`, because `ACTIONS` is append-only and inserting mid-array reorders
  // everything below it.
  'price_lists_unset_price',
  'price_lists_delete',
  // C00, contacts / CRM (extends A09), spread after D00's items.
  'contacts_tag',
  'contacts_log_activity',
  'contacts_timeline',
  'contacts_merge',
  'contacts_import',
  'contacts_anonymise',
  // E03, tasks & reminders (task-actions.ts, spread after C00's contacts): the five lifecycle
  // writes, the bucketed queue read, and tasks_reminders_due, the ONE reminder-trigger surface
  // C01/A16/G06 poll.
  'tasks_create',
  'tasks_update',
  'tasks_complete',
  'tasks_snooze',
  'tasks_cancel',
  'tasks_list',
  'tasks_reminders_due',
  // G06, notifications & inbox (notification-actions.ts, spread after E03's tasks): deliver is the
  // OP8 action a G01 rule targets, the self-scoped queue trio, the preference pair, and the OP4
  // digest that always stops at a local artifact in the OSS core.
  'notifications_deliver',
  'notifications_list',
  'notifications_mark_read',
  'notifications_mark_all_read',
  'notifications_archive',
  'notifications_set_preference',
  'notifications_list_preferences',
  'notifications_run_digest',
  // G02, plugin architecture & extension registry (plugin-actions.ts, spread after G06): the manifest
  // lifecycle (preview/install/enable/disable/uninstall/compat-refresh) and the registry-discovery
  // reads. Five writes gate on manage_plugins (owner-only); the reads ride read_master_data.
  'preview_plugin_install',
  'install_plugin',
  'list_plugins',
  'get_plugin',
  'enable_plugin',
  'disable_plugin',
  'uninstall_plugin',
  'refresh_plugin_compat',
  'search_plugin_registry',
  'get_plugin_registry_entry',
  // C01, leads & deals (deal-actions.ts, spread after E03's tasks): the pipeline lifecycle (create,
  // update, move, mark, log, convert), the §6b configuration pair, and the one board read. Two of
  // the writes hold an invoker (to_quote reaches the quote verb, log_activity's reminder half
  // reaches tasks_create), both gated on deals.write.
  'deals_create',
  'deals_update',
  'deals_move',
  'deals_mark',
  'deals_log_activity',
  'deals_list',
  'deals_to_quote',
  'pipelines_upsert',
  'pipeline_stages_upsert',
  // C02, quotes / proposals (quote-actions.ts). Eight writes (the Offerte lifecycle) and two reads,
  // thin wrappers over A10's shared document machine; no posting path (convert delegates to A10).
  'quotes_create',
  'quotes_update',
  'quotes_send',
  'quotes_accept',
  'quotes_decline',
  'quotes_expire_sweep',
  'quotes_revise',
  'quotes_convert',
  'quotes_get',
  'quotes_list',
  // C03, sales forecasting (forecast-actions.ts, spread after C02's quotes). Four reads and not one
  // write (P5): the pure read model over C01 deals + C02 quotes + A08 actuals.
  'forecast_weighted_pipeline',
  'forecast_sales_kpis',
  'forecast_revenue',
  'forecast_vs_actual',
  // A17, vendor bills and expenses (purchase-actions.ts, spread after C00's contacts). Five writes and
  // two reads, and the first purchase verbs this registry has ever carried. No pay verb: a bill is
  // settled by A14's `record_payment` with `vendorBillId` on the allocation.
  'create_vendor_bill',
  'record_expense',
  'post_vendor_bill',
  'attach_receipt',
  'void_vendor_bill',
  'list_vendor_bills',
  'get_vendor_bill',
  // A31, document capture: the Belegeingang queue that feeds A17/E02 drafts, spread right after A17.
  'capture_document',
  'capture_extract',
  'capture_commit',
  'capture_discard',
  'list_captures',
  'get_capture',
  // A34 payroll hand-off: the employee-master export and the ONE wage-journal posting (P8), plus the
  // union read. `wage_journal_post` is the only path a wage journal reaches the ledger (P3).
  'payroll_handoff_export',
  'wage_journal_post',
  'list_payroll_handoffs',
  // E00, file management, spread after A17's purchase verbs. Eleven writes and four reads. The prefix is
  // `files_` and not `documents_` because A10 owns that noun sixty lines up this same list, and a
  // `documents_search` beside `list_documents` is an agent picking the wrong tool. G18 US-G18.4 added
  // the chunk-upload lane (begin/chunk/commit), the large-file arm of `files_upload`.
  'files_upload_begin',
  'files_upload_chunk',
  'files_upload_commit',
  'files_upload',
  'files_update',
  'files_new_version',
  'files_link',
  'files_list_linked',
  'files_search',
  'files_get_content',
  'files_set_retention',
  'files_delete',
  'folders_upsert',
  'folders_delete',
  'folders_list',
  // E01, e-signature (sign-actions.ts, spread after E00's files). Six writes and two reads over a
  // request lifecycle: draft, send, per-signer events, complete, withdraw, and a draft-only delete.
  'sign_requests_create',
  'sign_requests_send',
  'sign_requests_record_event',
  'sign_requests_complete',
  'sign_requests_withdraw',
  'sign_requests_delete_draft',
  'sign_requests_get',
  'sign_requests_list',
  // F02, customer portal (portal-actions.ts, spread after E01's sign verbs). Four operator verbs and
  // two token-authenticated pre-workspace verbs (`portal_resolve`, `portal_quote_accept`).
  'portal_grant_create',
  'portal_grant_send',
  'portal_grant_revoke',
  'portal_grant_list',
  'portal_resolve',
  'portal_quote_accept',
  // F03, vendor portal (vendor-portal-actions.ts, spread after F02's portalActions). Six
  // workspace-scoped verbs: three portal.manage writes (grant/revoke/remittance-create), three
  // read_master_data reads (grants list + the two token/contact-scoped reads).
  'vendor_portal_grant',
  'vendor_portal_revoke',
  'vendor_portal_grants_list',
  'vendor_portal_pos',
  'vendor_portal_remittance_create',
  'vendor_portal_remittances',
  // A15, Mahnwesen (dunning-actions.ts, spread after E00's files). Four writes and four reads over
  // A16's open items. No delete and no un-issue: a mistaken fee is corrected by reverse_entry.
  'get_dunning_config',
  'set_dunning_config',
  'propose_dunning_run',
  'issue_dunning_run',
  'get_dunning_pdf',
  'send_dunning_run',
  'list_dunning_runs',
  'get_dunning_run',
  // A12, recurring invoices
  'create_recurring_schedule',
  'update_recurring_schedule',
  'pause_recurring_schedule',
  'resume_recurring_schedule',
  'end_recurring_schedule',
  'run_due_recurring',
  'list_recurring_schedules',
  'get_recurring_schedule',
  // A21, QR incoming matching (qr-match-actions.ts, spread after A12's recurring). Four writes and
  // two reads over A19's register, settling only through A14; set_qr_auto_apply is the P8 dial
  // and sits on the G01 denylist (D65 leg (e)).
  'record_incoming_credit',
  'match_qr_payment',
  'apply_qr_match',
  'override_qr_match',
  'list_unmatched_incoming',
  'set_qr_auto_apply',
  // A20, camt reconciliation (camt-actions.ts, spread after A21). Three writes and two reads; a
  // CREDIT never settles here, it is decided in A21's own queue that import_camt routes it into.
  'import_camt',
  'suggest_matches',
  // A36 (live bank feed): the per-txn needs_review emitter and the matching-tuning setter.
  'review_bank_txn',
  'set_camt_matching',
  'confirm_match',
  'create_entry_for_txn',
  'list_reconciliation',
  // F-03 (the booking paths): the statement list the /reconciliation door opens through.
  'list_bank_statements',
  // A18, creditor payments (pain001-actions.ts, spread after A21's QR matching). Five writes and
  // three reads. `set_creditor_bank_profile` and `mark_batch_paid` sit on the G01 denylist (D65 leg
  // (f) and the D77 judgment-confirmation leg, respectively); `discard_payment_batch` is the F4
  // recovery path that abandons a batch that must not be paid.
  'set_creditor_bank_profile',
  'list_payable',
  'create_payment_batch',
  'generate_pain001',
  'get_payment_batch',
  'list_payment_batches',
  'mark_batch_paid',
  'discard_payment_batch',
  // A23, multi-client workspaces. `list_workspaces` (D12) moved here from its inline slot when A23
  // took ownership of the roster: a tool's position is part of its history, not its meaning, and
  // the NAME (the stable external contract) did not change.
  'list_workspaces',
  'get_workspace',
  'onboard_client',
  'archive_workspace',
  // A25, Treuhänder review & export.
  'comment_entry',
  'flag_entry',
  'approve_entry',
  'review_status',
  'prepare_period',
  'export_journal',
  'export_statements',
  'export_vat',
  // A26, agent bookkeeping: the three convenience reads, the dial pair, the queue read (A35), the
  // two inbox verbs, and A35's two human-side writes (the D90 D-1 composer, the D90 D-5 erasure).
  'ledger_qa',
  'month_end_checklist',
  'detect_anomalies',
  'get_agent_dial',
  'set_agent_dial',
  'list_drafted_actions',
  'approve_drafted_action',
  'reject_drafted_action',
  'agent_ask',
  'agent_prose_delete',
  // A35, agent conversation & oversight: three reads over the trace, zero writes.
  'list_agent_sessions',
  'get_agent_session',
  'agent_trust_summary',
  // G10, migration maps (migration-map-actions.ts, spread after A26). The two catalog reads
  // describe the SOFTWARE (adapters with their cleanRoomSource, locale packs) and take no
  // workspaceId; the other six gate on `manage_import`, reads included (spec §3).
  'migration_list_source_adapters',
  'migration_list_locale_packs',
  'migration_suggest_map',
  'migration_set_map',
  'migration_get_map',
  'migration_save_map_template',
  'migration_list_map_templates',
  'migration_apply_map_template',
  // G09, the migration harness: the twelve plan/step verbs, in registry (append) order.
  'migration_discover_source',
  'migration_create_plan',
  'migration_set_scope',
  'migration_get_plan',
  'migration_list_plans',
  'migration_preview_step',
  'migration_trial_load_step',
  'migration_commit_step',
  'migration_record_approval',
  'migration_rollback_step',
  'migration_readiness',
  'migration_abandon_plan',
  'migration_close_plan',
  // G11, the Eröffnungsprüfung: the six check verbs, in registry (append) order. All six gate on
  // `manage_import`, reads included (spec §3).
  'migration_declare_control_total',
  'migration_check_step',
  'migration_get_check',
  'migration_list_checks',
  'migration_waive_control',
  'migration_export_check',
  // G21 open-items AR/AP migration: the control-tie-out read and the money-path import, in append
  // order (spec §5). preview_open_items gates on manage_import; import_open_items on commit_migration.
  'preview_open_items',
  'import_open_items',
  // G12 Testmandant: the trial workspace, its go-productive promotion and its discard, in append order.
  'migration_create_testmandant',
  'migration_get_testmandant',
  'migration_diff_testmandant_to_live',
  'go_productive',
  'discard_testmandant',
  // G03 onboarding: the wizard resume pointer and the demo workspace, in append order.
  'get_onboarding_progress',
  'advance_onboarding_step',
  'create_demo_workspace',
  'discard_demo_workspace',
  // G13 GL archive: the read-only prior-system ledger beside the live one, hard-partitioned.
  'gl_archive_preview',
  'gl_archive_import',
  'gl_archive_query',
  'gl_archive_account_history',
  'gl_archive_periods',
  'gl_archive_purge',
  // G19 extraction companion: two ungated guide reads (depsActions, no workspaceId) then the three
  // manifest verbs (two writes, one read on `manage_import`), in registry (append) order.
  'migration_list_extraction_guides',
  'migration_get_extraction_guide',
  'migration_set_manifest',
  'migration_set_manifest_item',
  'migration_get_manifest',
  // G20 implementation projects: the cutover as a first-class object (prefixed implementation_ because
  // B00 owns the bare project_* names). Eight writes + three reads, spread right after G19.
  'implementation_project_create',
  'implementation_project_get',
  'implementation_project_list',
  'implementation_runbook_instantiate',
  'implementation_task_set',
  'implementation_decision_record',
  'implementation_signoff_record',
  'implementation_parallel_declare',
  'implementation_parallel_check',
  'implementation_parallel_status',
  'implementation_project_close',
  // G22 checklists (D127): three reads and five writes over the vat_period template.
  'checklist_templates',
  'checklist_start',
  'checklist_get',
  'checklist_list',
  'checklist_item_complete',
  'checklist_item_skip',
  'checklist_item_reopen',
  'checklist_abandon',
  // B00 projects master: seven writes and three reads, the cluster-B spine.
  'project_create',
  'project_update',
  'project_set_status',
  'project_delete',
  'project_phase_add',
  'project_phase_update',
  'project_phase_done',
  'project_list',
  'project_get',
  'project_budget_actual',
  // B01, time tracking: the entry lifecycle, the submit/approve/lock chain, the timesheet reads
  // and the versioned rate-card trio.
  'time_start',
  'time_stop',
  'time_log',
  'time_update',
  'time_delete',
  'time_submit',
  'time_approve',
  'time_lock',
  'time_list',
  'time_resolve_rate',
  'rate_card_upsert',
  'rate_card_end',
  'rate_card_list',
  // B02 time -> billing: two writes and two reads, spread after time, in append order.
  'billing_unbilled_preview',
  'billing_generate_invoice',
  'billing_release_time',
  'billing_wip_report',
  // B04 retainers & mandates: five writes and two reads, spread after billing, in append order.
  'retainer_create',
  'retainer_update',
  'retainer_close',
  'retainer_generate_invoice',
  'retainer_run_due',
  'retainer_burndown',
  'retainer_list',
  // B03 job costing / project P&L: four reads and not one write, spread after retainers, in
  // append order (pure P5 read model).
  'costing_project_pl',
  'costing_pl_list',
  'costing_budget_vs_actual',
  'costing_drilldown',
  // F00, dashboards and KPIs: two reads and not one write, spread after costing. Ungated at the
  // boundary on purpose; per-tile RBAC lives inside the engine (see actionCapabilities.ts).
  'dashboard_overview',
  'dashboard_tile',
  // G15, the attention hub: two reads, spread right after the F00 dashboards. Ungated at the boundary
  // on purpose; per-queue RBAC lives inside the engine (see actionCapabilities.ts / compose.ts).
  'attention_summary',
  'attention_list',
  // F01, report builder: six writes and four reads, spread after the F00 dashboards, in append order.
  'reports_save',
  'reports_update',
  'reports_duplicate',
  'reports_delete',
  'reports_run',
  'reports_schedule',
  'reports_preview',
  'reports_sources',
  'reports_list',
  'reports_runs',
  // D01 inventory / stock: six writes and four reads, spread after time, in append order.
  'stock_location_upsert',
  'stock_on_hand',
  'stock_move',
  'stock_low_stock',
  'stock_run_valuation',
  'stock_valuation_report',
  'stock_stocktake_open',
  'stock_stocktake_count',
  'stock_stocktake_report',
  'stock_stocktake_commit',
  // D03, sales orders & delivery notes (in salesOrderActions append order).
  'sales_order_create',
  'sales_order_from_quote',
  'sales_order_confirm',
  'sales_order_cancel',
  'sales_order_invoice',
  'delivery_note_create',
  'delivery_note_issue',
  'delivery_note_render',
  'sales_order_list',
  'sales_order_get',
  'sales_order_backorders',
  // D02, purchasing: PO -> goods receipt -> 3-way match against the A17 vendor bill, plus supplier prices.
  'po_upsert',
  'po_send',
  'po_list',
  'po_get',
  'receipt_record',
  'match_bill',
  'po_open_lines',
  'po_close_short',
  'po_cancel',
  'po_revise',
  'supplier_price_upsert',
  'supplier_price_list',
  // I01, Advanced Purchase Order (OP14, in poAmendmentActions append order).
  'po_version_list',
  'po_version_get',
  'po_version_diff',
  'po_amendment_start',
  'po_amendment_update_lines',
  'po_amendment_preview',
  'po_amendment_submit',
  'po_amendment_apply',
  'po_amendment_cancel',
  'po_amendment_reject',
  // E02, HR-lite (in hrActions append order).
  'hr_employee_upsert',
  'hr_employee_get',
  'hr_employee_list',
  'hr_absence_record',
  'hr_absence_cancel',
  'hr_absence_list',
  'expense_claim_create',
  'expense_line_upsert',
  'expense_claim_submit',
  'expense_claim_approve',
  'expense_claim_reject',
  'expense_claim_reimburse',
  'expense_claim_list',
  'expense_claim_get',
  // E04, local mail store (in mailActions append order): three writes, four reads, and NO send
  // verb, which `test/mail/customization-guards.test.mjs` additionally holds by shape.
  'mail_connect',
  'mail_accounts_list',
  'mail_reindex',
  'mail_threads_list',
  'mail_thread_get',
  'mail_draft_write',
  'mail_drafts_list',
  'voice_build',
  'voice_profile_get',
  'voice_profiles_list',
  'voice_retrieve',
  'runtime_status',
  'runtime_catalog',
  'runtime_select',
  // E06, ledger-grounded drafts (in draftActions append order): two writes, one read, and NO send
  // verb, which `test/drafting/no-financial-write-and-guards.test.mjs` additionally holds by shape.
  'draft_generate',
  'draft_regenerate',
  'draft_list',
  'egress_self_test',
  'egress_status',
  // G04, data freedom (in dataActions append order): four ctx artifact verbs then the three
  // pre-workspace deps verbs (verify inspects a file, restore mints the tenant, catalog describes the
  // software contract).
  'export_workspace',
  'create_backup',
  'list_backups',
  'delete_backup',
  'verify_backup',
  'list_restorable_backups',
  'restore_backup',
  'get_api_catalog',
  // G07, global search: the one cross-entity read.
  'search_global',
  // H00, fixed-asset categories & defaults: the six asset_category_* verbs, spread in last.
  'asset_category_create',
  'asset_category_update',
  'asset_category_archive',
  'asset_category_list',
  'asset_category_get',
  'asset_category_resolve_defaults',
  // H01, the Asset Master: the six asset_* verbs, spread in after the H00 category verbs.
  'asset_create',
  'asset_update',
  'asset_get',
  'asset_list',
  'asset_search',
  'asset_archive',
  // H03, depreciation methods & engine: the three pure reads + the one enablement write, spread in
  // after the H01 master verbs.
  'asset_depreciation_preview',
  'asset_depreciation_schedule',
  'asset_depreciation_methods',
  'asset_depreciation_method_set_enabled',
  // H02, Asset Acquisition (money path): the two capitalisation writes + two sub-ledger reads,
  // appended after the H01 master verbs in the same assetActions spread.
  'asset_acquire',
  'asset_add_capitalisation',
  'asset_transaction_list',
  'asset_transaction_get',
  // H05, Asset Transfer & Location (Wave 12, NON-POSTING): the five asset_location_* CRUD verbs +
  // asset_transfer + asset_transfer_history, appended after the H02 sub-ledger reads in the same
  // assetActions spread.
  'asset_location_create',
  'asset_location_update',
  'asset_location_archive',
  'asset_location_list',
  'asset_location_get',
  'asset_transfer',
  'asset_transfer_history',
  // H04, Depreciation Run & Posting (money path): the three run writes + two run reads, appended after
  // the H02 verbs in the same assetActions spread.
  'asset_depreciation_run_create',
  'asset_depreciation_run_post',
  'asset_depreciation_run_reverse',
  'asset_depreciation_run_get',
  'asset_depreciation_run_list',
  // H06, Asset Disposal (Wave 12): the terminal disposal event, a pure preview + the posting dispose
  // + a disposal-scoped read, appended after the H04 run verbs.
  'asset_disposal_preview',
  'asset_dispose',
  'asset_disposal_get',
  // H07, Asset Ledger & Reconciliation (Wave 12): the four ledger/recon reads + the one opening-balance
  // write, appended after the H06 disposal verbs in the same assetActions spread.
  'asset_ledger_get',
  'asset_ledger_list',
  'asset_reconciliation_report',
  'asset_reconciliation_check',
  'asset_opening_balance',
  // H08, Simple Maintenance Log (Wave 12, NON-POSTING): the five asset_maintenance_log_* verbs, spread
  // in right after the asset cluster (maintenanceActions), in this create/update/cancel/get/list order.
  'asset_maintenance_log_create',
  'asset_maintenance_log_update',
  'asset_maintenance_log_cancel',
  'asset_maintenance_log_get',
  'asset_maintenance_log_list',
  // H09, Asset Reports & Agent Tools (Wave 12, READ-ONLY): the six pure report verbs, spread in right
  // after the maintenance log (assetReportsActions), in this register/forecast/disposal/acquisition/
  // nbv/end-of-life order. Reconciliation + per-asset history are H07's, re-used not re-minted.
  'asset_register_report',
  'asset_depreciation_forecast',
  'asset_disposal_summary',
  'asset_acquisition_summary',
  'asset_nbv_summary',
  'asset_end_of_life_list',
  // I00, requisitions (Wave 14, cluster I root): the eleven requisition_* verbs, spread in last.
  'requisition_upsert',
  'requisition_submit',
  'requisition_approve',
  'requisition_reject',
  'requisition_return',
  'requisition_convert_to_po',
  'requisition_cancel',
  'requisition_close',
  'requisition_get',
  'requisition_list',
  'requisition_my_pending_approvals',
  // J00, warehouses & locations (Wave 13, inventory root): fifteen verbs, spread in after H00.
  'warehouse_create',
  'warehouse_update',
  'warehouse_set_default',
  'warehouse_archive',
  'warehouse_list',
  'warehouse_get',
  'location_create',
  'location_update',
  'location_set_default',
  'location_archive',
  'location_list',
  'location_get',
  'location_tree',
  'inventory_ensure_default_location',
  'inventory_balance_by_location',
  // J01, lot & serial tracking (Wave 13, inventory): eighteen verbs, spread in after J00.
  'item_set_tracking_mode',
  'lot_create',
  'lot_update',
  'lot_set_status',
  'lot_archive',
  'lot_get',
  'lot_list',
  'lot_search',
  'serial_create',
  'serial_create_bulk',
  'serial_update',
  'serial_set_status',
  'serial_archive',
  'serial_get',
  'serial_list',
  'serial_search',
  'inventory_on_hand_by_lot',
  'inventory_available_serials',
  'inventory_move',
  'inventory_transfer',
  'inventory_balance',
  'inventory_movement_list',
  'inventory_movement_get',
  'inventory_get_config',
  'inventory_set_config',
  // I02, the goods receipt (Wave 14): eight writes then five reads, in registry append order.
  'goods_receipt_create',
  'goods_receipt_upsert_lines',
  'goods_receipt_post',
  'goods_receipt_accept_lines',
  'goods_receipt_reject_lines',
  'goods_receipt_reverse',
  'goods_receipt_cancel',
  'goods_receipt_set_config',
  'goods_receipt_preview',
  'goods_receipt_get',
  'goods_receipt_list',
  'goods_receipt_lines_for_match',
  'goods_receipt_get_config',
  // J03, advanced valuation methods: four pure reads over the J02 ledger and three policy writes.
  'inventory_valuation_preview',
  'inventory_valuation_methods',
  'inventory_valuation_layers',
  'inventory_valuation_method_history',
  'inventory_valuation_method_set_enabled',
  'inventory_valuation_set_default',
  'inventory_valuation_set_item_method',
  // J06, valuation run & GL link (OP11): four money-path writes and five reads.
  'inventory_valuation_create',
  'inventory_valuation_post',
  'inventory_valuation_reverse',
  'inventory_valuation_opening',
  'inventory_valuation_get',
  'inventory_valuation_list',
  'inventory_valuation_report',
  'inventory_reconciliation_report',
  'inventory_reconciliation_check',
  // J04, cycle count / stocktake: six money-path writes and three pure reads.
  'inventory_stocktake_create',
  'inventory_stocktake_count',
  'inventory_stocktake_report',
  'inventory_stocktake_approve_lines',
  'inventory_stocktake_request_recount',
  'inventory_stocktake_commit',
  'inventory_stocktake_cancel',
  'inventory_stocktake_get',
  'inventory_stocktake_list',
  // J05, inventory adjustments & reasons: three reason-catalog writes + two reads, then three
  // adjustment writes (single / batch / reverse) + two reads.
  'inventory_reason_create',
  'inventory_reason_update',
  'inventory_reason_archive',
  'inventory_reason_list',
  'inventory_reason_get',
  'inventory_adjust',
  'inventory_adjust_batch',
  'inventory_adjust_reverse',
  'inventory_adjust_list',
  'inventory_adjust_analysis',
  // I03, landed cost allocation: three money-path writes and three pure reads.
  'landed_cost_voucher_create',
  'landed_cost_allocate_confirm',
  'landed_cost_reverse',
  'landed_cost_allocate_preview',
  'landed_cost_list',
  'landed_cost_get',
  // I04, the three-way match (3 writes then 5 reads), appended in registry order.
  'match_three_way_create',
  'match_three_way_override',
  'match_three_way_reverse',
  'match_three_way_evaluate',
  'match_three_way_get',
  'match_three_way_list',
  'match_three_way_exceptions',
  'match_status_for_bill',
  // I05, supplier performance: five pure reads over the live I02 receipts and the D02 po_match trail.
  'supplier_scorecard_get',
  'supplier_performance_rank',
  'supplier_performance_trend',
  'supplier_performance_explain',
  'supplier_performance_alerts',
  // I06, procurement analytics & agent tools: ten pure reads over the live I00-I05 + D02 documents.
  'procurement_open_commitments',
  'procurement_match_status',
  'procurement_spend_summary',
  'procurement_supplier_scorecard',
  'procurement_requisition_pipeline',
  'procurement_grir_clearing',
  'procurement_landed_cost_variance',
  'procurement_po_cycle',
  'procurement_anomalies',
  'procurement_po_history',
  // J07, inventory agent tools & alerts: ten pure reads over the live J00-J06 inventory cluster.
  'inventory_stock_position',
  'inventory_low_stock',
  'inventory_valuation_status',
  'inventory_movement_history',
  'inventory_anomalies',
  'inventory_cycle_count_status',
  'inventory_lot_trace',
  'inventory_slow_movers',
  'inventory_alerts',
  'inventory_reorder_candidates',
  // G17
  'list_concepts',
  'get_concept',
  // M00, packaged local delivery: the one workspace-free read describing the running process.
  'delivery_status',
  // M02, the §I sync/publish contract: two owner publish dials + four consumer reads.
  'get_sync_contract',
  'sync_publish_enable',
  'sync_publish_disable',
  'sync_stream_read',
  'sync_artifact_read',
  'sync_stream_status',
  // M03, deployment journeys: the Move record's resume-pointer pair (the G03 wizard-pointer shape).
  'get_move_state',
  'advance_move_step',
  // N00, the environment landscape (D126, Phase A + Phase B env_copy)
  'env_list',
  'env_status',
  'env_current',
  'env_switch',
  'env_create',
  'env_copy',
  'env_reset',
  'env_delete',
];

test('tool names are unique', () => {
  const names = ACTIONS.map((a) => a.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool name in the registry');
});

test('the tool list is stable and covers every intended verb (no orphan, no missing)', () => {
  const names = ACTIONS.map((a) => a.name);
  assert.deepEqual(names, EXPECTED_NAMES);
  assert.equal(ACTIONS.length, EXPECTED_NAMES.length);
});

test('every action is well-formed and getAction resolves each name', () => {
  for (const a of ACTIONS) {
    assert.ok(a.name && typeof a.name === 'string');
    assert.ok(a.kind === 'read' || a.kind === 'write', `${a.name} has a valid kind`);
    assert.equal(typeof a.run, 'function', `${a.name} has a run`);
    assert.equal(a.inputSchema.type, 'object', `${a.name} has an object schema`);
    assert.equal(getAction(a.name), a);
  }
  assert.equal(getAction('no_such_tool'), undefined);
});

test('ctx-based tools require workspaceId in their input schema', () => {
  // The pre-workspace (deps-based) tools. `accept_invite` (A24) joins the three setup verbs for a
  // structural reason rather than a convenience one: the actor redeeming an invite is not a member
  // of the workspace yet, so there is no capability to resolve and no tenant to resolve it against.
  // The token is the authorisation, and it expires.
  const preWorkspace = new Set([
    'create_workspace',
    'bootstrap_workspace',
    'list_workspaces',
    'accept_invite',
    // A23: onboarding MINTS the tenant (the create_workspace shape), so there is no workspaceId on
    // the input for the boundary to resolve.
    'onboard_client',
    // G10: the two catalog reads describe the SOFTWARE (which source formats TILL can read, which
    // locale packs are registered), not any workspace's data, so there is no tenant on the input
    // to resolve: the G04 §2 US-G04.4 reasoning, restated where their `ungated(...)` rows live in
    // `actionCapabilities.ts`.
    'migration_list_source_adapters',
    'migration_list_locale_packs',
    // G19: the two extraction-guide reads describe the SOFTWARE (the shipped per-source guides and
    // the tactic ladder), not any workspace, so there is no tenant on the input to resolve, the
    // `migration_list_source_adapters` reasoning exactly; their `ungated(...)` rows live in
    // `actionCapabilities.ts`.
    'migration_list_extraction_guides',
    'migration_get_extraction_guide',
    // F02: the two token-authenticated portal verbs are pre-workspace exactly like `accept_invite`.
    // The grant binds the workspace (§H-TENANT) and the single-use token is the authorisation, so
    // neither carries a `workspaceId` for the boundary to resolve.
    'portal_resolve',
    'portal_quote_accept',
    // G03: minting the demo IS minting the tenant (the create_workspace/onboard_client shape), so
    // there is no workspaceId on the input for the boundary to resolve. `discard_demo_workspace`
    // is NOT here: it names its tenant in the input and re-states the boundary's checks in-engine
    // (its success deletes that tenant, so the boundary's not-found check would break the replay).
    'create_demo_workspace',
    // G04: the three pre-workspace data-freedom verbs. `verify_backup` inspects an ARBITRARY file (no
    // tenant on the input), `get_api_catalog` describes the software contract (not workspace data), and
    // `restore_backup` MINTS the tenant (the create_workspace shape), so none carries a workspaceId for
    // the boundary to resolve (spec §0a.4).
    'verify_backup',
    // F-06 (2026-09-05): `list_restorable_backups` lists THIS machine's backup directory for the
    // pre-workspace restore door, so it carries no workspaceId either.
    'list_restorable_backups',
    'get_api_catalog',
    'restore_backup',
    // G17: the Begriffe corpus is a build-time constant, identical in every workspace on the
    // planet, so there is no tenant on the input to resolve. A workspaceId here would imply the
    // explanation of a statutory election CAN differ per workspace, the one property G17's design
    // forbids outright (§6c); the reason is restated where their `ungated(...)` rows live in
    // `actionCapabilities.ts`.
    'list_concepts',
    'get_concept',
    // M00: `delivery_status` describes the running process, not a tenant, and the first-run flow
    // calls it before any ledger exists, so it carries no workspaceId for the boundary to resolve.
    'delivery_status',
  ]);
  for (const a of ACTIONS) {
    if (preWorkspace.has(a.name)) {
      assert.ok(!a.inputSchema.required.includes('workspaceId'), `${a.name} must not require workspaceId`);
    } else {
      assert.ok(a.inputSchema.required.includes('workspaceId'), `${a.name} must require workspaceId`);
    }
  }
});

test('post_entry exposes only the business sources', () => {
  assert.deepEqual([...POST_ENTRY_SOURCES].sort(), ['agent', 'import', 'invoice', 'manual', 'payment']);
  assert.ok(!POST_ENTRY_SOURCES.includes('reversal'));
  assert.ok(!POST_ENTRY_SOURCES.includes('close'));
  // A22: `fx` is engine-only, written only by post_fx_revaluation (with its next-period reversal and
  // fx_revaluation run row), never forgeable through the agent-facing post_entry boundary.
  assert.ok(!POST_ENTRY_SOURCES.includes('fx'));
});

test('post_entry rejects source=reversal, source=close, and reversesEntryId before the verb', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const post = getAction('post_entry');
  const base = manualPost(accId, 'k');

  // A caller trying to forge a reversal directly through the post tool is rejected at the boundary.
  const reversal = post.run(deps, { workspaceId, ...base, source: 'reversal', idempotencyKey: 'k1' });
  assert.equal(reversal.ok, false);
  assert.equal(reversal.error, 'invalid_source');

  // A caller trying to forge a year-close sealing entry is likewise rejected.
  const close = post.run(deps, { workspaceId, ...base, source: 'close', idempotencyKey: 'k2' });
  assert.equal(close.ok, false);
  assert.equal(close.error, 'invalid_source');

  // Even with a valid business source, a reversesEntryId (the reversal slot) is forbidden here.
  const slot = post.run(deps, { workspaceId, ...base, source: 'manual', reversesEntryId: 'entry_1', idempotencyKey: 'k3' });
  assert.equal(slot.ok, false);
  assert.equal(slot.error, 'forbidden_field');

  // An unknown source is rejected too.
  const bogus = post.run(deps, { workspaceId, ...base, source: 'wire', idempotencyKey: 'k4' });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.error, 'invalid_source');

  // Control: a plain business post succeeds, so the guard rejects only what it must.
  const good = post.run(deps, { workspaceId, ...base, source: 'manual', idempotencyKey: 'k5' });
  assert.equal(good.ok, true);
  assert.ok(good.entryId);
});
