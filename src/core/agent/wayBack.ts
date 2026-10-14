/**
 * D159: THE WAY BACK. For a write, the verbs that undo or correct it.
 *
 * The reversibility class on a verb's registration (`write:<class>:<tag>`, see `src/api/actionKind.ts`) is
 * a claim; this map is the evidence a reader can check against the code. Each entry names the registered
 * write verbs that take the act back:
 *
 *   - a `reversible` write lists the verb that changes it back (`archive_account` -> `unarchive_account`,
 *     `pause_recurring_schedule` -> `resume_recurring_schedule`);
 *   - a `correctable` write lists the verb that books or issues the linked correction
 *     (`post_entry` -> `reverse_entry`, `issue_invoice` -> `issue_credit_note`);
 *   - a `final` write has NO entry: there is no way back inside TILL, which is what `final` means.
 *
 * Every reversible and correctable write has an entry. The D161 method rulings, which `wayBackProblems`
 * enforces and the registry asserts at load:
 *
 *   - `'self'` (calling the verb again) is the way back of a REVERSIBLE absolute setter, and of a
 *     CORRECTABLE write listed in `SELF_CORRECTABLE`, where a second call books a fresh record and the
 *     earlier one stays visible. It is never a licence for "call it again" on anything else;
 *   - an EXPLICIT EMPTY way back (`[]`) is legal only for an upload session that lapses by itself, listed
 *     in `LAPSES_BY_ITSELF`;
 *   - a `final` write lists nothing;
 *   - every named verb is a registered write.
 *
 * The entries are generated from the reviewed map (`docs/planning/reversibility/map.json`); where that map
 * contradicts a ruling, `MAP_RESOLUTIONS` names the verb, what the map said and what stands here, and the
 * private parity suite (`test/planning/reversibility-map-parity.test.mjs`) holds every other entry equal
 * to the map.
 *
 * Pure data plus a pure check: this module imports nothing from `src/api/` (core never imports the
 * registry), so the registered verbs are handed in.
 */

/** The marker for a way back that is calling the verb again (see the rulings above). */
export const WAY_BACK_SELF = 'self';

/**
 * D161: the CORRECTABLE writes whose way back is calling them again: a second call books a fresh record
 * and the earlier one stays visible. The reviewed map marks these by naming the verb itself (or `'self'`);
 * here they all read `'self'`. A reversible setter needs no entry; a correctable write naming `'self'`
 * without one is refused.
 */
export const SELF_CORRECTABLE: readonly string[] = [
  'vat_configure',
  'comment_entry',
  'propose_dunning_run',
  'liquidity_plan_propose',
  'contacts_log_activity',
  'deals_update',
  'deals_move',
  'deals_mark',
  'pipelines_upsert',
  'pipeline_stages_upsert',
  'update_recurring_schedule',
  'delivery_note_create',
  'attach_receipt',
  'capture_extract',
  'supplier_price_upsert',
  'inventory_valuation_set_default',
  'inventory_valuation_set_item_method',
  'inventory_valuation_create',
  'payroll_handoff_export',
  'project_set_status',
  'time_update',
  'rate_card_upsert',
  'hr_employee_upsert',
  'expense_line_upsert',
  'asset_transfer',
  'asset_depreciation_run_create',
  'migration_set_scope',
  'migration_trial_load_step',
  'migration_check_step',
  'migration_set_manifest',
  'implementation_task_set',
  'implementation_decision_record',
  'implementation_parallel_declare',
  'voice_build',
  'transition_document',
];

/**
 * D161: the upload sessions that lapse by themselves (an upload nobody finishes expires and leaves no
 * file), the only writes that carry an explicit empty way back.
 */
export const LAPSES_BY_ITSELF: readonly string[] = ['files_upload_begin', 'files_upload_chunk'];

/**
 * Where the reviewed map contradicts a D161 ruling, what it said and why the entry here differs. The parity
 * suite exempts exactly these verbs from map equality, so a new contradiction cannot slip in silently.
 */
export const MAP_RESOLUTIONS: Readonly<Record<string, { readonly map: readonly string[]; readonly why: string }>> = {
  fx_revaluation_reverse: { map: ['post_entry'], why: 'classed final, and a final write lists no way back' },
  issue_dunning_run: { map: ['reverse_entry (the fee only)'], why: 'classed final; the map named prose, not a verb' },
  inventory_valuation_create: { map: [], why: 'a correctable write needs a way back: a fresh draft run; the earlier draft stays listed and a stale one refuses to post' },
  asset_depreciation_run_create: { map: [], why: 'a correctable write needs a way back: a create over corrected asset data is a new run (the selection hash covers every amount); the draft stays listed' },
  migration_check_step: { map: [], why: 'a correctable write needs a way back: every check is an append-only snapshot, so a re-run adds one; or the control is waived' },
  payroll_handoff_export: { map: [], why: 'a correctable write needs a way back: every export is its own payroll_handoff record with an audit row, so a corrected export is a new one' },
  time_update: { map: [], why: 'a correctable write needs a way back: a second patch while the entry is open or submitted (no edit history is kept: a reviewer may prefer reversible)' },
  migration_set_scope: { map: [], why: 'a correctable write needs a way back: re-including a class recreates its step at the discovery default map, which migration_set_map refines' },
  review_bank_txn: { map: [], why: 'the signal stands; the line it flagged is resolved by booking or ignoring it' },
  reject_drafted_action: { map: [], why: 'the rejection stands in the trace; the agent\'s next proposal of the same call is approved instead' },
};

/**
 * Write verb -> the registered write verbs that undo or correct it, `['self']` (see the rulings above), or
 * `[]` for a lapsing upload session. One entry per reversible and correctable write, none for a final one.
 */
export const WAY_BACK: Readonly<Record<string, readonly string[]>> = {
  create_workspace: ['archive_workspace'],
  bootstrap_workspace: ['archive_workspace'],
  set_fiscal_config: ['self'],
  set_vat_method: ['self'],
  set_creditor_profile: ['self'],
  update_company_profile: ['self'],
  create_account: ['delete_account', 'archive_account'],
  update_account: ['self', 'account_set_tax_default'],
  archive_account: ['unarchive_account'],
  unarchive_account: ['archive_account'],
  create_cost_center: ['delete_cost_center', 'archive_cost_center'],
  archive_cost_center: ['unarchive_cost_center'],
  unarchive_cost_center: ['archive_cost_center'],
  post_entry: ['reverse_entry'],
  reverse_entry: ['post_entry'],
  save_draft: ['self', 'delete_draft'],
  close_month: ['reopen_month'],
  reopen_month: ['close_month', 'lock_period'],
  lock_period: ['unlock_period', 'close_month'],
  unlock_period: ['lock_period', 'close_month'],
  vat_seed_defaults: ['vat_code_deactivate'],
  vat_configure: ['self'],
  vat_saldo_declaration_basis: ['self'],
  vat_code_upsert: ['vat_code_deactivate'],
  vat_code_deactivate: ['vat_code_reactivate'],
  vat_code_reactivate: ['vat_code_deactivate'],
  account_set_tax_default: ['self'],
  record_exchange_rate: ['import_exchange_rates'],
  set_fx_method: ['self'],
  import_exchange_rates: ['record_exchange_rate'],
  post_fx_revaluation: ['fx_revaluation_reverse'],
  set_opening_balances: ['reverse_entry'],
  import_opening_balances: ['reverse_entry'],
  onboard_client: ['archive_workspace'],
  archive_workspace: ['self'],
  comment_entry: ['self'],
  flag_entry: ['approve_entry'],
  approve_entry: ['flag_entry'],
  prepare_period: ['approve_entry'],
  set_agent_dial: ['self'],
  reject_drafted_action: ['approve_drafted_action'],
  agent_ask: ['agent_prose_delete'],
  reports_save: ['reports_delete'],
  reports_update: ['self'],
  reports_duplicate: ['reports_delete'],
  reports_run: ['reports_delete'],
  reports_schedule: ['self'],
  set_ebill_config: ['self'],
  set_bank_sync_schedule: ['self'],
  confirm_statement_gap: ['revoke_statement_gap_confirmation'],
  revoke_statement_gap_confirmation: ['confirm_statement_gap'],
  accrual_create: ['accrual_discard'],
  accrual_post: ['accrual_reverse'],
  accrual_reverse: ['accrual_create', 'accrual_post'],
  accrual_discard: ['accrual_create'],
  provision_create: ['provision_discard'],
  provision_post: ['provision_reverse', 'provision_release'],
  provision_release: ['provision_release_reverse'],
  provision_reverse: ['provision_create', 'provision_post'],
  provision_release_reverse: ['provision_release'],
  provision_discard: ['provision_create'],
  vat_settlement_post: ['vat_settlement_reverse'],
  vat_settlement_reverse: ['vat_settlement_post'],
  record_payment: ['reverse_payment'],
  allocate_payment: ['reverse_payment'],
  reverse_payment: ['record_payment'],
  set_write_off_threshold: ['self'],
  set_aging_bucket_config: ['self'],
  create_bank_account: ['archive_bank_account', 'update_bank_account'],
  update_bank_account: ['self'],
  set_bank_opening_balance: ['reverse_entry'],
  archive_bank_account: ['unarchive_bank_account'],
  unarchive_bank_account: ['archive_bank_account'],
  set_dunning_config: ['self'],
  propose_dunning_run: ['self'],
  record_incoming_credit: ['override_qr_match'],
  apply_qr_match: ['override_qr_match', 'reverse_payment'],
  override_qr_match: ['apply_qr_match'],
  set_qr_auto_apply: ['self'],
  review_bank_txn: ['book_bank_line', 'ignore_bank_line'],
  set_camt_matching: ['self'],
  confirm_match: ['reopen_bank_line'],
  create_entry_for_txn: ['reopen_bank_line'],
  book_bank_line: ['reopen_bank_line', 'reverse_payment'],
  ignore_bank_line: ['reopen_bank_line'],
  reopen_bank_line: ['book_bank_line', 'ignore_bank_line'],
  suggest_bank_lines: ['book_bank_line', 'ignore_bank_line'],
  set_creditor_bank_profile: ['self'],
  create_payment_batch: ['discard_payment_batch'],
  generate_pain001: ['discard_payment_batch'],
  mark_batch_paid: ['reverse_payment'],
  discard_payment_batch: ['create_payment_batch'],
  liquidity_skonto_set: ['self'],
  liquidity_flow_set: ['self'],
  liquidity_plan_propose: ['self'],
  liquidity_plan_draft_batches: ['discard_payment_batch'],
  create_contact: ['archive_contact'],
  update_contact: ['self'],
  archive_contact: ['unarchive_contact'],
  unarchive_contact: ['archive_contact'],
  create_document: ['transition_document'],
  update_document: ['self'],
  convert_document: ['update_document', 'transition_document', 'create_document'],
  issue_invoice: ['issue_credit_note', 'transition_document'],
  create_credit_note: ['transition_document'],
  issue_credit_note: ['transition_document'],
  // D161 (claude/rmap-gov): correctable; a wrong issued document is cancelled by a second call (to=cancelled
  // books the reversing entry, the original stays on record) or corrected by a credit note.
  transition_document: ['self', 'issue_credit_note'],
  contacts_tag: ['update_contact'],
  contacts_log_activity: ['self'],
  contacts_import: ['archive_contact'],
  deals_create: ['deals_mark'],
  deals_update: ['self'],
  deals_move: ['self'],
  deals_mark: ['self', 'deals_move'],
  deals_log_activity: ['contacts_log_activity'],
  deals_to_quote: ['transition_document', 'quotes_create'],
  pipelines_upsert: ['self'],
  pipeline_stages_upsert: ['self'],
  quotes_create: ['transition_document'],
  quotes_update: ['self'],
  quotes_send: ['quotes_revise', 'transition_document'],
  quotes_decline: ['quotes_revise'],
  quotes_expire_sweep: ['quotes_revise'],
  quotes_revise: ['quotes_send'],
  quotes_convert: ['update_document', 'transition_document', 'create_document'],
  sign_requests_create: ['sign_requests_delete_draft'],
  sign_requests_record_event: ['sign_requests_create', 'sign_requests_send'],
  sign_requests_withdraw: ['sign_requests_create', 'sign_requests_send'],
  portal_grant_create: ['portal_grant_revoke'],
  portal_grant_revoke: ['portal_grant_create', 'portal_grant_send'],
  create_recurring_schedule: ['pause_recurring_schedule', 'end_recurring_schedule'],
  update_recurring_schedule: ['self'],
  pause_recurring_schedule: ['resume_recurring_schedule'],
  resume_recurring_schedule: ['pause_recurring_schedule'],
  end_recurring_schedule: ['create_recurring_schedule'],
  run_due_recurring: ['issue_credit_note', 'transition_document'],
  retainer_create: ['retainer_close'],
  retainer_update: ['self'],
  retainer_close: ['retainer_create'],
  retainer_generate_invoice: ['update_document', 'transition_document'],
  retainer_run_due: ['update_document', 'transition_document'],
  sales_order_create: ['sales_order_cancel'],
  sales_order_from_quote: ['sales_order_cancel'],
  sales_order_cancel: ['sales_order_create', 'sales_order_confirm'],
  sales_order_invoice: ['update_document', 'transition_document'],
  delivery_note_create: ['self'],
  create_vendor_bill: ['void_vendor_bill'],
  record_expense: ['void_vendor_bill'],
  post_vendor_bill: ['void_vendor_bill'],
  attach_receipt: ['self'],
  void_vendor_bill: ['create_vendor_bill', 'post_vendor_bill'],
  capture_document: ['capture_discard'],
  capture_extract: ['self', 'capture_discard'],
  capture_commit: ['void_vendor_bill', 'expense_line_upsert'],
  capture_discard: ['capture_document'],
  vendor_portal_revoke: ['vendor_portal_grant'],
  po_upsert: ['po_cancel'],
  po_send: ['po_revise', 'po_cancel'],
  po_cancel: ['po_upsert', 'po_send'],
  po_revise: ['po_send'],
  supplier_price_upsert: ['self'],
  po_amendment_start: ['po_amendment_cancel'],
  po_amendment_update_lines: ['self'],
  po_amendment_submit: ['po_amendment_cancel', 'po_amendment_reject'],
  po_amendment_apply: ['po_amendment_start', 'po_amendment_update_lines', 'po_amendment_submit'],
  po_amendment_cancel: ['po_amendment_start'],
  po_amendment_reject: ['po_amendment_start'],
  requisition_upsert: ['requisition_cancel'],
  requisition_submit: ['requisition_return', 'requisition_cancel'],
  requisition_approve: ['requisition_cancel'],
  requisition_reject: ['requisition_upsert', 'requisition_submit'],
  requisition_return: ['requisition_submit'],
  requisition_convert_to_po: ['po_cancel', 'requisition_upsert'],
  requisition_cancel: ['requisition_upsert', 'requisition_submit'],
  requisition_close: ['requisition_upsert', 'requisition_submit'],
  goods_receipt_create: ['goods_receipt_cancel'],
  goods_receipt_upsert_lines: ['self'],
  goods_receipt_post: ['goods_receipt_reverse'],
  goods_receipt_accept_lines: ['goods_receipt_reverse'],
  goods_receipt_reject_lines: ['goods_receipt_create', 'goods_receipt_post'],
  goods_receipt_reverse: ['goods_receipt_create', 'goods_receipt_post'],
  goods_receipt_cancel: ['goods_receipt_create'],
  goods_receipt_set_config: ['self'],
  landed_cost_allocate_confirm: ['landed_cost_reverse'],
  landed_cost_reverse: ['landed_cost_voucher_create', 'landed_cost_allocate_confirm'],
  match_three_way_create: ['match_three_way_reverse'],
  match_three_way_override: ['match_three_way_reverse'],
  match_three_way_reverse: ['match_three_way_create', 'match_three_way_override'],
  create_item: ['delete_item', 'archive_item'],
  update_item: ['self'],
  archive_item: ['unarchive_item'],
  unarchive_item: ['archive_item'],
  item_categories_upsert: ['self', 'item_categories_delete'],
  price_lists_upsert: ['self', 'price_lists_delete'],
  price_lists_set_price: ['price_lists_unset_price'],
  stock_location_upsert: ['location_archive'],
  stock_move: ['inventory_adjust', 'inventory_move'],
  stock_stocktake_count: ['self'],
  warehouse_create: ['warehouse_set_default', 'warehouse_archive'],
  warehouse_update: ['self'],
  warehouse_set_default: ['self'],
  warehouse_archive: ['warehouse_create'],
  location_create: ['location_set_default', 'location_archive'],
  location_update: ['self'],
  location_set_default: ['self'],
  location_archive: ['stock_location_upsert', 'location_set_default'],
  inventory_ensure_default_location: ['warehouse_set_default', 'warehouse_archive'],
  item_set_tracking_mode: ['self'],
  lot_create: ['lot_archive'],
  lot_update: ['self'],
  lot_set_status: ['self'],
  lot_archive: ['lot_set_status'],
  serial_create: ['serial_set_status'],
  serial_create_bulk: ['serial_set_status'],
  serial_update: ['self'],
  serial_set_status: ['self'],
  serial_archive: ['serial_set_status'],
  inventory_move: ['inventory_adjust', 'serial_set_status'],
  inventory_transfer: ['inventory_adjust', 'stock_move'],
  inventory_set_config: ['self'],
  inventory_valuation_method_set_enabled: ['self'],
  inventory_valuation_set_default: ['self'],
  inventory_valuation_set_item_method: ['self'],
  inventory_valuation_create: ['self'],
  inventory_valuation_post: ['inventory_valuation_reverse'],
  inventory_valuation_reverse: ['inventory_valuation_create', 'inventory_valuation_post'],
  inventory_valuation_opening: ['inventory_valuation_reverse'],
  inventory_stocktake_create: ['inventory_stocktake_cancel'],
  inventory_stocktake_count: ['self', 'inventory_stocktake_request_recount', 'inventory_stocktake_approve_lines'],
  inventory_stocktake_approve_lines: ['inventory_stocktake_count'],
  inventory_stocktake_request_recount: ['inventory_stocktake_count', 'inventory_stocktake_approve_lines'],
  inventory_stocktake_cancel: ['inventory_stocktake_create'],
  inventory_reason_create: ['inventory_reason_archive'],
  inventory_reason_update: ['self'],
  inventory_reason_archive: ['inventory_reason_update'],
  inventory_adjust: ['inventory_adjust_reverse'],
  inventory_adjust_batch: ['inventory_adjust_reverse'],
  inventory_adjust_reverse: ['inventory_adjust'],
  tasks_create: ['tasks_cancel'],
  tasks_update: ['tasks_complete', 'tasks_snooze'],
  tasks_complete: ['tasks_update', 'tasks_cancel'],
  tasks_snooze: ['self', 'tasks_update'],
  tasks_cancel: ['tasks_create'],
  payroll_handoff_export: ['self'],
  wage_journal_post: ['reverse_entry'],
  project_create: ['project_delete'],
  project_update: ['self'],
  project_set_status: ['self'],
  project_phase_add: ['project_phase_update', 'project_delete'],
  project_phase_update: ['self'],
  time_start: ['time_delete'],
  time_stop: ['time_update', 'time_delete'],
  time_log: ['time_delete'],
  time_update: ['self'],
  time_submit: ['time_update', 'time_delete'],
  rate_card_upsert: ['self', 'rate_card_end'],
  rate_card_end: ['rate_card_upsert'],
  billing_generate_invoice: ['billing_release_time', 'transition_document'],
  billing_release_time: ['billing_generate_invoice'],
  hr_employee_upsert: ['self'],
  hr_absence_record: ['hr_absence_cancel'],
  hr_absence_cancel: ['hr_absence_record'],
  expense_claim_create: ['expense_claim_reject'],
  expense_line_upsert: ['self', 'expense_claim_reject'],
  expense_claim_submit: ['expense_claim_reject'],
  expense_claim_approve: ['reverse_entry'],
  expense_claim_reject: ['expense_claim_create'],
  expense_claim_reimburse: ['reverse_payment'],
  asset_category_create: ['asset_category_archive'],
  asset_category_update: ['self'],
  asset_category_archive: ['asset_category_create'],
  asset_create: ['asset_archive'],
  asset_update: ['self'],
  asset_archive: ['asset_create'],
  asset_depreciation_method_set_enabled: ['self'],
  asset_acquire: ['reverse_entry'],
  asset_add_capitalisation: ['reverse_entry'],
  asset_location_create: ['asset_location_archive'],
  asset_location_update: ['self'],
  asset_location_archive: ['asset_location_create'],
  asset_transfer: ['self'],
  asset_depreciation_run_create: ['self'],
  asset_depreciation_run_post: ['asset_depreciation_run_reverse'],
  asset_depreciation_run_reverse: ['asset_depreciation_run_create', 'asset_depreciation_run_post'],
  asset_dispose: ['reverse_entry', 'asset_create', 'asset_opening_balance'],
  asset_opening_balance: ['reverse_entry'],
  asset_maintenance_log_create: ['asset_maintenance_log_cancel'],
  asset_maintenance_log_update: ['self'],
  asset_maintenance_log_cancel: ['asset_maintenance_log_create'],
  migration_set_map: ['self'],
  migration_apply_map_template: ['migration_set_map'],
  migration_create_plan: ['migration_abandon_plan'],
  migration_set_scope: ['self', 'migration_set_map'],
  migration_trial_load_step: ['self', 'discard_testmandant'],
  migration_commit_step: ['migration_rollback_step'],
  migration_record_approval: ['discard_testmandant', 'migration_rollback_step'],
  migration_rollback_step: ['migration_commit_step'],
  migration_declare_control_total: ['migration_check_step', 'migration_waive_control'],
  migration_check_step: ['self', 'migration_waive_control'],
  migration_waive_control: ['migration_declare_control_total'],
  migration_create_testmandant: ['discard_testmandant'],
  create_demo_workspace: ['discard_demo_workspace'],
  gl_archive_import: ['migration_rollback_step'],
  migration_set_manifest: ['self'],
  migration_set_manifest_item: ['self'],
  implementation_runbook_instantiate: ['implementation_task_set'],
  implementation_task_set: ['self'],
  implementation_decision_record: ['self'],
  implementation_parallel_declare: ['self'],
  implementation_parallel_check: ['implementation_signoff_record'],
  export_workspace: ['delete_backup'],
  create_backup: ['delete_backup'],
  restore_backup: ['archive_workspace'],
  sync_publish_disable: ['sync_publish_enable'],
  advance_move_step: ['self'],
  env_switch: ['self'],
  env_create: ['env_delete'],
  invite_member: ['revoke_member'],
  accept_invite: ['revoke_member'],
  set_role: ['self'],
  revoke_member: ['invite_member', 'accept_invite'],
  define_role: ['self', 'archive_role'],
  archive_role: ['define_role'],
  define_field: ['archive_field'],
  confirm_field: ['archive_field'],
  archive_field: ['define_field'],
  set_field_value: ['self'],
  create_saved_view: ['delete_saved_view', 'update_saved_view'],
  update_saved_view: ['self'],
  create_document_template: ['archive_document_template'],
  update_document_template: ['files_link', 'files_delete'],
  set_default_document_template: ['archive_document_template', 'create_document_template'],
  archive_document_template: ['create_document_template', 'set_default_document_template'],
  dispatch_text_upsert: ['self', 'dispatch_text_reset'],
  dispatch_text_reset: ['dispatch_text_upsert'],
  create_automation_rule: ['archive_automation_rule', 'disable_automation_rule'],
  update_automation_rule: ['self'],
  enable_automation_rule: ['disable_automation_rule'],
  disable_automation_rule: ['enable_automation_rule'],
  archive_automation_rule: ['create_automation_rule'],
  notifications_set_preference: ['self'],
  install_plugin: ['uninstall_plugin', 'disable_plugin'],
  enable_plugin: ['disable_plugin'],
  disable_plugin: ['enable_plugin'],
  refresh_plugin_compat: ['disable_plugin'],
  files_upload_begin: [],
  files_upload_chunk: [],
  files_upload_commit: ['files_delete'],
  files_upload: ['files_delete'],
  files_update: ['self'],
  files_new_version: ['files_delete'],
  files_set_retention: ['self'],
  folders_upsert: ['self', 'folders_delete'],
  folders_delete: ['folders_upsert'],
  checklist_start: ['checklist_abandon'],
  checklist_item_complete: ['checklist_item_reopen'],
  checklist_item_skip: ['checklist_item_reopen', 'checklist_item_complete'],
  checklist_item_reopen: ['checklist_item_complete'],
  voice_build: ['self'],
  runtime_select: ['self'],
  draft_generate: ['draft_regenerate'],
};

/** The registry facts `wayBackProblems` needs about one verb (an `ActionDef` satisfies it). */
export interface WayBackAction {
  readonly name: string;
  readonly kind: 'read' | 'write';
  readonly reversibility?: 'reversible' | 'correctable' | 'final';
}

/** The two D161 marker lists, handed in so the check can be exercised on a fixture. */
export interface WayBackMarks {
  readonly selfCorrectable: readonly string[];
  readonly lapsesByItself: readonly string[];
}

/**
 * Every way the map disagrees with the registry or with the D161 rulings, one line each; empty when it is
 * sound. The registry throws at load on a non-empty answer, so a renamed verb cannot leave a dead entry.
 *
 * Checked: each key is a registered write; each way back is a registered write, or `'self'`; a list holds
 * no duplicate and does not name its own key (that is what `'self'` is for); `'self'` stands only on a
 * reversible write or on a correctable one in `selfCorrectable`; an empty list only on a write in
 * `lapsesByItself`; a final write has no entry; every reversible and correctable write HAS one; and each
 * marker names a write that uses it.
 */
export function wayBackProblems(
  actions: readonly WayBackAction[],
  map: Readonly<Record<string, readonly string[]>> = WAY_BACK,
  marks: WayBackMarks = { selfCorrectable: SELF_CORRECTABLE, lapsesByItself: LAPSES_BY_ITSELF },
): string[] {
  const writes = new Map(actions.filter((a) => a.kind === 'write').map((a) => [a.name, a] as const));
  const has = (list: readonly string[], verb: string): boolean => list.includes(verb);
  const problems: string[] = [];
  for (const [verb, ways] of Object.entries(map)) {
    const action = writes.get(verb);
    if (action === undefined) {
      problems.push(`${verb}: not a registered write verb`);
      continue;
    }
    if (action.reversibility === 'final') {
      problems.push(`${verb}: classed final, yet has a way-back entry (a final write lists nothing)`);
      continue;
    }
    if (ways.length === 0 && !has(marks.lapsesByItself, verb)) {
      problems.push(`${verb}: an empty way back, which only an upload session that lapses by itself may carry (LAPSES_BY_ITSELF)`);
    }
    if (ways.length > 0 && has(marks.lapsesByItself, verb)) problems.push(`${verb}: listed as lapsing by itself, yet names a way back`);
    if (new Set(ways).size !== ways.length) problems.push(`${verb}: names the same way back twice`);
    for (const way of ways) {
      if (way === WAY_BACK_SELF) {
        const selfOk = action.reversibility === 'reversible' || (action.reversibility === 'correctable' && has(marks.selfCorrectable, verb));
        if (!selfOk) {
          problems.push(
            `${verb}: 'self' is only for a write classed reversible, or a correctable one in SELF_CORRECTABLE; this one is ${action.reversibility ?? 'unclassified'}`,
          );
        }
      } else if (way === verb) {
        problems.push(`${verb}: names itself; use '${WAY_BACK_SELF}'`);
      } else if (!writes.has(way)) {
        problems.push(`${verb}: way back '${way}' is not a registered write verb`);
      }
    }
  }
  for (const action of writes.values()) {
    if (action.reversibility === undefined) problems.push(`${action.name}: an unclassified write`);
    else if (action.reversibility !== 'final' && !Object.prototype.hasOwnProperty.call(map, action.name)) {
      problems.push(`${action.name}: classed ${action.reversibility}, yet has no way back`);
    }
  }
  for (const verb of marks.selfCorrectable) {
    const action = writes.get(verb);
    if (action?.reversibility !== 'correctable' || !(map[verb] ?? []).includes(WAY_BACK_SELF)) {
      problems.push(`${verb}: in SELF_CORRECTABLE, but not a correctable write whose way back names '${WAY_BACK_SELF}'`);
    }
  }
  for (const verb of marks.lapsesByItself) {
    if (!writes.has(verb) || (map[verb] ?? ['?']).length !== 0) {
      problems.push(`${verb}: in LAPSES_BY_ITSELF, but not a write with an explicit empty way back`);
    }
  }
  return problems;
}
