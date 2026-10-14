/**
 * D161: the writes D161 newly governs, plus the D161.3 product calls, with the family each sits in.
 *
 * Shared by `test/agent/dial-covers-d161.test.mjs` (the engine, held to the registry) and
 * `test/planning/reversibility-map-d161.test.mjs` (the same writes held to the reviewed, private
 * `docs/planning/reversibility/map.json`). It reads nothing, so it ships in the public mirror.
 */

/** The 66 writes D161 newly governs, plus the D161.3 product calls, with the family each sits in. */
export const D161_FAMILY = Object.freeze({
  // statutory (14)
  set_vat_method: 'vat-file',
  vat_configure: 'vat-file',
  vat_saldo_declaration_basis: 'vat-file',
  set_fx_method: 'vat-file',
  quotes_accept: 'issue',
  sign_requests_complete: 'issue',
  portal_quote_accept: 'issue',
  inventory_stocktake_approve_lines: 'close-period',
  time_approve: 'close-period',
  migration_waive_control: 'go-live',
  gl_archive_import: 'go-live',
  files_link: 'close-period',
  checklist_item_skip: 'close-period',
  checklist_item_reopen: 'close-period',
  // books (32)
  record_exchange_rate: 'customize',
  import_exchange_rates: 'customize',
  bank_sync: 'pay',
  create_bank_account: 'pay',
  record_incoming_credit: 'pay',
  import_camt: 'pay',
  import_camt_files: 'pay',
  create_payment_batch: 'pay',
  generate_pain001: 'pay',
  discard_payment_batch: 'pay',
  liquidity_plan_draft_batches: 'pay',
  resume_recurring_schedule: 'issue',
  end_recurring_schedule: 'issue',
  run_due_recurring: 'issue',
  attach_receipt: 'close-period',
  receipt_record: 'stock',
  goods_receipt_post: 'stock',
  goods_receipt_accept_lines: 'stock',
  goods_receipt_reverse: 'stock',
  match_three_way_create: 'pay',
  match_three_way_override: 'pay',
  match_three_way_reverse: 'pay',
  stock_move: 'stock',
  stock_run_valuation: 'stock',
  inventory_move: 'stock',
  inventory_transfer: 'stock',
  inventory_valuation_set_default: 'stock',
  inventory_valuation_set_item_method: 'stock',
  inventory_adjust: 'stock',
  inventory_adjust_batch: 'stock',
  inventory_adjust_reverse: 'stock',
  files_new_version: 'close-period',
  // outbound (12)
  vendor_portal_remittance_create: 'share',
  po_send: 'send',
  po_amendment_apply: 'send',
  requisition_convert_to_po: 'send',
  prepare_feedback: 'share',
  update_document_template: 'customize',
  set_default_document_template: 'customize',
  dispatch_text_upsert: 'customize',
  run_due_automations: 'customize',
  retry_automation_run: 'customize',
  notifications_deliver: 'send',
  notifications_run_digest: 'send',
  // access (6)
  set_qr_auto_apply: 'pay',
  archive_role: 'customize',
  enable_plugin: 'plugin-install',
  uninstall_plugin: 'plugin-install',
  refresh_plugin_compat: 'plugin-install',
  mail_connect: 'share',
  // erase (2)
  agent_prose_delete: 'erase',
  mail_reindex: 'erase',
  // D161.3, the product calls (tagged stop or internal in the map, governed by owner decision)
  bank_channel_disconnect: 'erase',
  update_company_profile: 'vat-file',
  set_write_off_threshold: 'pay',
  requisition_approve: 'pay',
});
