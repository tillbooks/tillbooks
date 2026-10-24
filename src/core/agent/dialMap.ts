/**
 * A35 §4b: which verbs the dial governs at the transport seam, and the consequence sentence each of
 * them carries (`ActionDef.consequence`, one field, three consumers: G16's palette review, the MCP
 * client's confirmation prose, and the Vorschlag card).
 *
 * THE MAP IS THE CLOSED §H-ENUM SOURCE. A verb absent from it is not dial-governed: the transport
 * dispatch runs it exactly as before (A24 still gates it). Every mapped verb REQUIRES at least one
 * input field beyond `workspaceId`, asserted in `test/agent/trust.test.mjs` ("the dial map is
 * closed and sane"), so a bare-tenant probe can never draft a garbage payload.
 *
 * G00's engine-side P8 (an agent-authored `define_field` lands `draft = 1`) predates this wiring and
 * STAYS: an embedder calling `action.run` directly bypasses the transport seam, and the in-process
 * belt is what still drafts for them.
 */

import { CONSEQUENCE_FOR_VERB, consequenceFor, type Consequence } from './consequences.js';
import type { WorkspaceContext } from '../context.js';
import { SETTINGS, dialCapabilityForSetting } from '../settings/registry.js';

export { CONSEQUENCE_FOR_FAMILY, CONSEQUENCE_FOR_VERB, consequenceFor } from './consequences.js';
export type { Consequence, Reversibility } from './consequences.js';

/** Verb name -> the governing dial capability (one of A26's `DIAL_CAPABILITIES`). */
export const DIAL_CAPABILITY_FOR_ACTION: Readonly<Record<string, string>> = {
  // post: the double-entry journal itself. A reversal is a posting (it mints an entry).
  post_entry: 'post',
  reverse_entry: 'post',
  // issue: the moment a document becomes immutable and legally outward-facing.
  issue_invoice: 'issue',
  issue_credit_note: 'issue',
  // send: the outbound act a customer sees.
  send_invoice: 'send',
  // dun: the escalating reminder loop over A16's open items.
  propose_dunning_run: 'dun',
  discard_dunning_run: 'dun', // D161.3: removes a proposed run and frees its day
  issue_dunning_run: 'dun',
  send_dunning_run: 'dun',
  // pay: the settlement half of the money path.
  record_payment: 'pay',
  allocate_payment: 'pay',
  reverse_payment: 'pay',
  // vat-file: the statutory filing mark. Strong-default ask (D103).
  vat_mark_filed: 'vat-file',
  // customize: the structural write an agent most commonly wants.
  define_field: 'customize',
  // plugin-install: third-party code into the workspace. Strong-default ask (D103).
  install_plugin: 'plugin-install',
  // D160.5: the two other writes that START third-party code. `enable_plugin` re-registers a disabled
  // plugin's capabilities and starts its sandbox; `refresh_plugin_compat` does the same for an
  // `incompatible` plugin whose range the core satisfies again. Ungoverned, a plugin a person stopped
  // could be started again by an agent with no Vorschlag. The stop button (`disable_plugin`) stays
  // free: see NOT_DIAL_GOVERNED.
  enable_plugin: 'plugin-install',
  refresh_plugin_compat: 'plugin-install',
  // D161.1 (owner, 11.10.2026): the access verbs. Uninstalling removes the manifest and the grants for
  // good (only an audit row remains) and there is no verb that brings the same install back, so it
  // waits for the person like the install it undoes.
  uninstall_plugin: 'plugin-install',

  // pay: the rest of the settlement surface, every verb that moves money out or matches a bank fact
  // to an open item. Each one settles or transmits, and none can be recalled once it has run.
  mark_batch_paid: 'pay',
  payment_batch_transmit: 'pay',
  apply_qr_match: 'pay',
  override_qr_match: 'pay',
  confirm_match: 'pay',
  expense_claim_reimburse: 'pay',
  // post: the rest of the ledger surface, every verb that mints a journal entry (an original posting
  // or a reversing one). A reversal is a posting: it mints an entry and cannot itself be un-posted.
  create_entry_for_txn: 'post',
  wage_journal_post: 'post',
  // D171: the wage journal's undo mints the mirror, a posting like every sibling reverse.
  wage_journal_reverse: 'post',
  post_vendor_bill: 'post',
  post_fx_revaluation: 'post',
  // A38: the five entry-minting writes (an accrual posts a pair, a Storno posts the mirror pair, a
  // provision is formed, released and reversed). The drafts and discards mint nothing and are not
  // governed, the H04 `asset_depreciation_run_create` precedent.
  accrual_post: 'post',
  accrual_reverse: 'post',
  provision_post: 'post',
  provision_release: 'post',
  provision_reverse: 'post',
  provision_release_reverse: 'post',
  fx_revaluation_reverse: 'post',
  vat_settlement_post: 'post',
  vat_settlement_reverse: 'post',
  expense_claim_approve: 'post',
  // D168: the approve's undo mints the mirror, a posting like every sibling reverse above.
  expense_claim_reverse: 'post',
  asset_acquire: 'post',
  asset_add_capitalisation: 'post',
  asset_depreciation_run_post: 'post',
  asset_depreciation_run_reverse: 'post',
  asset_dispose: 'post',
  // D170: the register's undo mints the mirror, a posting like every sibling reverse above.
  asset_transaction_reverse: 'post',
  inventory_valuation_post: 'post',
  inventory_valuation_reverse: 'post',
  landed_cost_allocate_confirm: 'post',
  landed_cost_reverse: 'post',
  // D169: the dunning fee's undo mints the mirror, a posting like every sibling reverse above.
  dunning_fee_reverse: 'post',

  // close-period: sealing an accounting period against further posting. A hard seal (close_year, and
  // a hard lock_period) cannot be reopened; a soft lock is reversible but still a governed write.
  close_year: 'close-period',
  lock_period: 'close-period',
  // F-08 (b), 2026-09-05: the SOFT close and its reopening join the family. A soft close is reversible,
  // but it is still the act that refuses every later posting into the month, and its reopening is the
  // act that lets postings back into a month a human had declared done. Both were absent, so an agent
  // closed and reopened months at will with no Vorschlag and no human screen (measured in J4.6, where
  // the ungoverned close_month then made the human's own approval fail period_locked). unlock_period
  // is reopen_month's twin over a soft lock_period (the lock itself is governed above), so it joins
  // for the same reason: undoing a human's seal is a governed act whether the seal was soft or hard.
  close_month: 'close-period',
  reopen_month: 'close-period',
  unlock_period: 'close-period',
  // go-live: the migration cutover into the real books. The least-reversible act in the product.
  go_productive: 'go-live',
  import_open_items: 'go-live',

  // customize, the membership verbs (D123, governance critic F3, 2026-09-05). D50 seats the local
  // `agent` as an owner on every local install, so the governed seat held `manage_members` and these
  // four executed at once with a trace row and no Vorschlag: an agent could seat a person as `owner`,
  // and the ungoverned seat it minted became real the moment someone redeemed the token. Who may see
  // the books, and with which rights, is the workspace's structure the way a field definition is (the
  // G01 denylist already classes all four as governing acts), so a governed seat PROPOSES a membership
  // change and the human approves it. The approval replays as the approver (P3), which restores the
  // premise "the inviter is human" by construction rather than by assumption. A governed seat may still
  // invite any kind: the invite drafts like any other governed write. `accept_invite` stays outside the
  // map: it takes no `workspaceId` (pre-tenant, F8) and redeems a token a human already issued.
  invite_member: 'customize',
  set_role: 'customize',
  revoke_member: 'customize',
  define_role: 'customize',
  // D142, critic F4: the daily statement fetch's schedule is a governing setting of the same kind. It
  // decides when the owner's bank is contacted unattended and WHO that fetch runs as (the setter, since
  // critic F1), so a governed seat proposes it and the human approves; the approval replays as the
  // human, who then becomes the fetch's actor.
  set_bank_sync_schedule: 'customize',
  // A36 §4.7 (D150): "nothing is missing in this statement gap" decides whether the books are complete,
  // so a governed seat proposes it and a person approves (the engine also refuses a governed seat, so an
  // `auto` dial cannot make it an agent's act alone; the approval replays as the person).
  confirm_statement_gap: 'pay',
  revoke_statement_gap_confirmation: 'pay',

  // A39, the bank inbox (spec A39 D-A39.4): the two single-capability writes (their `agent.verb.*`
  // labels live in the Studio, which `test/attention/verb-labels.test.mjs` requires of every name-mapped
  // verb). `book_bank_line` stays input-keyed below: its consequence depends on its target (post for
  // accounts and matches, pay for settlements). `reopen_bank_line` keeps the stricter `pay` (it can
  // reverse a settlement).
  ignore_bank_line: 'post',
  // D178 point 19: an agent may PROPOSE a duplicate answer; a person with post approves it.
  resolve_possible_duplicate: 'post',
  reopen_bank_line: 'pay',
  // D167 (A39 §13.1): a standard steers the bulk button (its lines read `sure`), so a governed seat
  // proposes it and a person approves, under `post` like a booking to accounts.
  set_bank_standard: 'post',
  clear_bank_standard: 'post',

  // The governance check of 28.09.2026 (one appended block). A static reference graph over `src/`
  // (`test/agent/dial-covers-entry-minting.test.mjs`) found these write verbs reaching `postEntry`
  // with no dial mapping, so an agent at the default `ask` minted an entry with no Vorschlag. That
  // test now derives the minting verbs from the code, so the next one fails there, not in a review.
  // post: A17's other two entry-minting verbs. `void_vendor_bill` reverses a posted bill's purchase
  // entry (a reversal is a posting); `record_expense` is the one-step twin of `post_vendor_bill`.
  void_vendor_bill: 'post',
  record_expense: 'post',
  // post: the opening seeds that book into the live journal (owner decision, 28.09.2026: govern them).
  // `set_opening_balances` joined them under D158 (below).
  set_bank_opening_balance: 'post',
  asset_opening_balance: 'post',
  inventory_valuation_opening: 'post',
  import_opening_balances: 'post',
  // go-live: the migration steps commit migrated data into the live books and reverse it again, the
  // cutover family `import_open_items` and `go_productive` already sit in.
  migration_commit_step: 'go-live',
  migration_rollback_step: 'go-live',
  // customize: letting an automation rule fire (non-author critic R3-2, owner decision 28.09.2026). A rule
  // fires its verb as its AUTHOR, internally, outside the seam; an agent seat enabling its own rule at
  // `ask` had a `post_entry` rule post and an `issue_invoice` rule issue with no Vorschlag. The input is
  // only the rule id, so the verb it fires cannot be read here: `customize` is the input-only answer.
  // The transport seam reads the STORED rule (`ruleTier.ts`, D141.5 R4-1) and drafts at the stricter of
  // this and the tier of the verb the rule fires. The approval replays as the human, so every rule that
  // starts to fire has a human behind it.
  enable_automation_rule: 'customize',

  // pay: the master data that decides WHO a payment reaches (critic phase0-installable r1, P0.4e-5b).
  // Neither verb moves money itself, but each redirects every later payment that relies on it, and the
  // human then approves a batch or an invoice whose payee they may not re-check. So a governed seat
  // proposes the change and the human approves it at the pay tier. `set_creditor_bank_profile` is the
  // IBAN a vendor is paid AT (every later pain.001 batch reads it); its QR-bill twin
  // `set_creditor_profile` has no required field, so it is input-keyed below (on its IBAN fields).
  set_creditor_bank_profile: 'pay',

  // --- D156 point 3 (10.10.2026): what cannot be undone, one appended block ----------------------
  // Until this block only 77 of the 448 writes ran through the dial, and the local agent sits in the
  // owner seat, so it anonymised and merged contacts, deleted files and hard-deleted master data with
  // no Vorschlag. `test/agent/dial-covers-irreversible.test.mjs` derives the population from the G01
  // denylist's leg tags (`NOT_AUTOMATABLE_LEGS`): every leg (a) and leg (f) verb is governed here, by
  // an input-keyed rule below, or named in `NOT_DIAL_GOVERNED` with its reason.
  //
  // erase: the act removes something for good, and no verb brings it back.
  contacts_anonymise: 'erase', // blanks a person's data and notes across the whole merge identity
  contacts_merge: 'erase', // re-points everything onto the survivor and tombstones the duplicate; no unmerge
  files_delete: 'erase', // the metadata row and the bytes, once retention has run out
  delete_account: 'erase', // hard delete of a never-posted account
  delete_cost_center: 'erase', // hard delete of an unreferenced cost centre
  delete_draft: 'erase', // hard delete of an unposted journal draft
  delete_item: 'erase', // hard delete of an unreferenced item
  item_categories_delete: 'erase', // hard delete of an empty category
  price_lists_delete: 'erase', // the list and every dated price row it holds
  price_lists_unset_price: 'erase', // one dated price row, or all of them for the item
  sign_requests_delete_draft: 'erase', // hard delete of an unsent signature request
  time_delete: 'erase', // hard delete of an open or submitted ArG working-time row
  project_delete: 'erase', // hard delete of a draft project and its phases
  discard_testmandant: 'erase', // hard delete of the trial workspace and every row under it
  discard_orphan_testmandant: 'erase', // the same, for a trial workspace no plan links any more
  discard_demo_workspace: 'erase', // hard delete of a demo workspace and every row under it
  gl_archive_purge: 'erase', // destroys archived periods after the OR 958f retention
  env_reset: 'erase', // wipes an environment's data root and rebuilds it
  env_delete: 'erase', // removes an environment's data root
  env_copy: 'erase', // replaces the target environment's data with the copy
  // Two writes OUTSIDE the denylist that delete for good all the same (G01 lets a rule fire them, a
  // separate question): a backup is the way back for everything else, and a report's run history is
  // gone with its definition. Governed so "what cannot be undone waits for you" holds for them too.
  delete_backup: 'erase', // the backup or export file on disk and its history row
  reports_delete: 'erase', // the definition and its run history; retained E00 documents stay
  // share: consent for data leaving this machine or for outside access to it. A family of its own
  // rather than `customize`: a grant of `customize` at `auto` (fields, roles, schedules) must not
  // quietly also let the agent publish the books or open them to a supplier, and the consequence is
  // not "the earlier setting is not kept" but "what was shared stays shared".
  sync_publish_enable: 'share', // starts egress: the publish stream, backfilled with past postings
  vendor_portal_grant: 'share', // a live token link into a supplier's orders and payment advices
  // D157 (owner decision 3): the customer-portal SEND is the governed act. A grant minted by
  // portal_grant_create is a draft whose token opens nothing (`isLive` in grants.ts requires the
  // hand-over), so the create left the dial (NOT_DIAL_GOVERNED below) and this is where access opens.
  portal_grant_send: 'share', // activates the link: from then on it opens the records it names
  // D156 critic F2: the outbound writes the population sweep found ungoverned. Each sends a document
  // to someone outside, or mints the link that lets them act on it, and each had an in-verb confirm
  // the agent could set itself.
  ebill_transmit: 'send', // the invoice into the customer's e-banking over the eBill service
  quotes_send: 'send', // numbers and freezes the quote and mints its online accept link
  sign_requests_send: 'send', // the document to the e-signing service
  // The bank channel: TILL generates the keys and sends the bank its INI/HIA setup; once active,
  // statements and (on the managed rail) payments flow over it. The pay tier, the rail money takes.
  bank_channel_connect: 'pay',
  // go-live: the two declarations that a cutover is finished. Neither has a reopen verb.
  implementation_project_close: 'go-live',
  migration_close_plan: 'go-live',
  // D156 Q6 (owner via coordinator, 10.10.2026): the G09 approval a money-path commit is gated on. The
  // local agent holds `commit_migration`, so it recorded the "human approval" itself. Now its call
  // drafts, the approval replays as the human, and a human-granted go-live=auto still lets a
  // permissioned service identity commit unattended (G09 §5).
  migration_record_approval: 'go-live',

  // --- D158 (10.10.2026): the five irreversible writes the D156 sweep missed, one appended block ------
  // A non-author critic found them: the coverage test built its population from denylist legs (a) and
  // (f) plus an erasing-name pattern, which never sees a seal, a lock or an issue. It now also reads
  // every `final` consequence and every seal/lock/commit/issue/close/finalise/post name.
  //
  // post: the opening position, ONE posted entry per year. Its old written exception (drafting it
  // returned 200 for an unbalanced set before the verb's own `unbalanced` refusal, breaking A04's
  // REST/MCP parity) is fixed at the root: the seam runs the verb's own checks first
  // (`ActionDef.prevalidate`), so an invalid set is refused with the same 422 drafted or direct.
  set_opening_balances: 'post',
  // close-period: locks the period's approved time as the ArG working-time record. No verb unlocks it,
  // and locked time is never billable (B02 and B04 bill only `approved` time).
  time_lock: 'close-period',
  // close-period: the two stocktake commits seal the count at its freeze date and mint every difference
  // as a stock movement. D01's committed session is the OR 958c Bestandesnachweis; J04's is only when it
  // is a FULL stocktake (a cycle count returns `bestandesnachweis: null`). A sealed session never reopens;
  // the stock is corrected by a new adjustment. NOT `post`: neither mints a journal entry (the valuation
  // run books later, governed under post), and `post` is the family of the verbs that do (the accent
  // guard, test/style/accent-money-commit-only.test.mjs, reads it so). The seal of a period-end record
  // is the close family's act, the same tier as `time_lock`.
  stock_stocktake_commit: 'close-period',
  inventory_stocktake_commit: 'close-period',
  // issue: the delivery note leaves stock and the order counts the goods as delivered. `issued` is
  // terminal, no verb lowers `delivered_qty`, and an order with an issued note can no longer be cancelled.
  delivery_note_issue: 'issue',
  // close-period: surfaced by the widened sweep. Abandoning a checklist run retires that period's
  // checklist for good: the run is unique per template and period, so `checklist_start` hands back the
  // abandoned run and never a fresh one, and the period's close or MWST checklist stops asking.
  checklist_abandon: 'close-period',

  // --- D158 critic round 1: the population now holds denylist leg (b) and `abandon` names ----------
  // erase (owner decision 11.10.2026, was go-live): abandoning deletes the Testmandant these books
  // created for good, through the same guarded path as `discard_testmandant`, beside it in this family.
  // `abandonPlan` refuses only a CLOSED plan, so it also moves a live plan to `abandoned`, and
  // `closePlan` then refuses `plan_not_live` for good. Its confirm step is satisfied by the approval
  // (APPROVAL_CONFIRMS_FIELD below).
  migration_abandon_plan: 'erase',
  // close-period: A25's sign-off on a posted entry, the judgment the period lock and the filing exports
  // stand on (denylist leg (b)). It is metadata a later `flag_entry` supersedes, but a person signs it:
  // the governed seat proposes and the approval replays as the human. NOT `post`: it mints no entry.
  approve_entry: 'close-period',
  // pay: D02's three-way match accepts a supplier bill against what arrived (with `override`, over the
  // price tolerance). There is no unmatch for a `po_match`, the billed quantity then blocks
  // `goods_receipt_reverse` (`line_already_billed`), and a fully billed order closes. It moves no money
  // itself; it decides that a bill the pay run settles was owed. NOT `post`: it mints no entry.
  match_bill: 'pay',

  // --- D161 (owner, 11.10.2026): the approval map, one appended block -----------------------------
  // D160 set the boundary by consequence: every write tagged books, statutory, outbound, access or erase
  // in `docs/planning/reversibility/map.json` waits for the person by default. These are the ones that
  // did not yet; `test/agent/dial-covers-d161.test.mjs` reads the map and holds every one governed (by
  // name here, by an input-keyed rule below, or in NOT_DIAL_GOVERNED with the reason it cannot be).
  //
  // vat-file: the MWST elections and settings. Each decides what a return computes (method, timing,
  // registration, the Art. 88 basis, the Art. 45 rate basis), so they sit with the filing claim itself,
  // under its strong default, rather than with `customize`, which a person grants to let the agent shape
  // fields and roles.
  set_vat_method: 'vat-file',
  vat_configure: 'vat-file',
  vat_saldo_declaration_basis: 'vat-file',
  set_fx_method: 'vat-file',
  // customize: the rate table the books read when they convert, the role list, the outward templates and
  // texts, and re-driving a stuck automation run (the rule family's floor; `ruleTier.ts` still drafts
  // it at the stricter tier of the verb the stored run fires).
  record_exchange_rate: 'customize',
  import_exchange_rates: 'customize',
  archive_role: 'customize',
  update_document_template: 'customize',
  set_default_document_template: 'customize',
  dispatch_text_upsert: 'customize',
  retry_automation_run: 'customize',
  // pay: the bank feed, the payment runs before they are paid, the three-way match, the matching queue,
  // the payee master data, the auto-settle switch, the write-off offer (D161.3) and the approval of a
  // purchase request (D161.3: it commits money once the order follows).
  bank_sync: 'pay',
  create_bank_account: 'pay',
  record_incoming_credit: 'pay',
  set_qr_auto_apply: 'pay',
  import_camt: 'pay',
  import_camt_files: 'pay',
  // D178 (A20 §11.4): the one statement door for every format, `import_camt`'s family.
  import_bank_statement: 'pay',
  // D178 (A20 §11.3, security review): a CSV mapping decides how every later import reads amounts and
  // signs (a swapped debit and credit column is a wrong bank fact on every line), so an agent's change of
  // it waits for a person with the pay right, exactly like the import it steers.
  set_bank_csv_mapping: 'pay',
  create_payment_batch: 'pay',
  generate_pain001: 'pay',
  discard_payment_batch: 'pay',
  liquidity_plan_draft_batches: 'pay',
  match_three_way_create: 'pay',
  match_three_way_override: 'pay',
  match_three_way_reverse: 'pay',
  set_write_off_threshold: 'pay',
  requisition_approve: 'pay',
  // erase: D161.3, `bank_channel_disconnect` destroys the channel's EBICS keys in the keystore on
  // `retire` and nothing restores them (a reconnect mints a new connection with new keys and a new INI
  // letter). Erase, not pay: the act is the destruction, the stop of the money rail is its side effect.
  // `block` is the milder mode of the same verb and drafts with it; one verb, one family.
  bank_channel_disconnect: 'erase',
  agent_prose_delete: 'erase',
  mail_reindex: 'erase',
  // issue: a binding document comes into being (an accepted quote, a signed document) or an invoice
  // schedule starts, ends or runs. `end_recurring_schedule` per D159.5.
  sign_requests_complete: 'issue',
  // The customer-portal accept, by an agent seat holding a live token (coordinator, D161 follow-up). It
  // takes no workspaceId: the transport seam resolves the grant's workspace from the token hash for this
  // one named verb (`TOKEN_WORKSPACE_VERBS`, src/api/agent-gate.ts) and drafts there; a bad token is
  // refused by the verb exactly as before. The hosted page and every person are not the agent seat.
  portal_quote_accept: 'issue',
  resume_recurring_schedule: 'issue',
  end_recurring_schedule: 'issue',
  // send: the purchase-order documents a supplier receives, and the notices a person receives.
  po_send: 'send',
  po_amendment_apply: 'send',
  requisition_convert_to_po: 'send',
  notifications_deliver: 'send',
  notifications_run_digest: 'send',
  // share: what a supplier sees in the portal, a feedback report leaving the machine, and access to the
  // person's own mail store.
  vendor_portal_remittance_create: 'share',
  prepare_feedback: 'share',
  mail_connect: 'share',
  // plugin-install: third-party code starting, leaving or flipping state. `enable_plugin`,
  // `refresh_plugin_compat` (D160.5) and `uninstall_plugin` (D161.1) are governed above, on one line each.
  // close-period: the statutory record. Sign-offs (time, stocktake lines, checklist items) and the
  // Belege the OR 958f retention binds (a receipt on a bill, a file version, a file linked to a record).
  inventory_stocktake_approve_lines: 'close-period',
  // (`time_approve` is close-period too, by an input-keyed rule below: an empty selection approves
  // nothing and the verb refuses it, so drafting it would break A04's REST/MCP parity.)
  checklist_item_skip: 'close-period',
  checklist_item_reopen: 'close-period',
  attach_receipt: 'close-period',
  files_new_version: 'close-period',
  files_link: 'close-period',
  // go-live: the cutover's own record. `migration_waive_control` per D159.5.
  migration_waive_control: 'go-live',
  gl_archive_import: 'go-live',
  // stock (new family, D161): thirteen writes that move or value stock and mint no journal entry.
  receipt_record: 'stock',
  goods_receipt_post: 'stock',
  goods_receipt_accept_lines: 'stock',
  goods_receipt_reverse: 'stock',
  stock_move: 'stock',
  stock_run_valuation: 'stock',
  inventory_move: 'stock',
  inventory_transfer: 'stock',
  inventory_valuation_set_default: 'stock',
  inventory_valuation_set_item_method: 'stock',
  inventory_adjust: 'stock',
  inventory_adjust_batch: 'stock',
  inventory_adjust_reverse: 'stock',
};

/**
 * The governed verbs whose effect reaches beyond the workspace they name: an environment is a data root
 * on this host. The transport seam resolves their level with `instanceEffectiveDialLevel` (dial.ts):
 * `auto` only when every workspace on the instance granted it.
 */
export const INSTANCE_WIDE_DIAL_ACTIONS: ReadonlySet<string> = new Set(['env_reset', 'env_delete', 'env_copy']);

/**
 * THE DELIBERATE EXCLUSIONS (D156 point 4): high-risk or irreversible writes the dial does NOT govern,
 * each with the reason, a statement about the code a reader can check. `dial-covers-irreversible.test.mjs`
 * requires every ungoverned leg (a) and leg (f) verb, and every ungoverned write whose name says it
 * deletes, discards, purges, resets, merges or revokes, to be listed here, and drops a stale entry.
 */
export const NOT_DIAL_GOVERNED: Readonly<Record<string, string>> = {
  restore_backup:
    'pre-workspace: it takes no workspaceId, so the transport seam has no tenant whose dial it could read, and it only ever creates a brand-new workspace (never overwrites one); without confirmed:true it returns a plan and writes nothing',
  implementation_signoff_record:
    'spec law (G20 P8): a sign-off is never draftable; the engine refuses the agent seat with signoff_needs_human rather than staging it',
  vendor_portal_revoke:
    'the stop direction: it ends outside access and keeps the grant row (the revDSG trail); access comes back only through a new vendor_portal_grant, which is governed under share',
  sync_publish_disable:
    'the egress stop button: it stops publishing and keeps the published rows; publishing resumes only through sync_publish_enable, which is governed under share',
  portal_grant_revoke:
    'the stop direction for a customer grant: the row is never deleted, and a new grant is a fresh act',
  // D157 (owner decision 3): preparing a draft link is free for the agent; sending it waits for you.
  portal_grant_create:
    'a draft link opens nothing until portal_grant_send, which stays governed: the grant is minted as a draft (minted_draft = 1, no sent_at), its token resolves to grant_denied, and kind is not an input, so a caller cannot mint a vendor grant that is live at mint',
  folders_delete:
    'deletes only an EMPTY folder (folder_not_empty otherwise, never a cascade), which folders_upsert recreates exactly',
  delete_saved_view:
    'a display preference: a view mints no state and holds no history',
  // D178 point 7: the name says reset, the act is the caller's own look returning to its default.
  prefs_reset:
    'a per-person display preference (ui-state): it removes only the calling seat\'s own stored value, never another person\'s, and prefs_set puts it back',
  clear_diagnostics:
    'the local error journal kept for bug reports, not a business record; written reports are kept',
  capture_discard:
    'a terminal flag on a capture, not a delete: the E00 document survives, and re-uploading the same bytes recovers it',
  accrual_discard:
    'retires an unposted draft; the row stays on record as discarded with its reason',
  provision_discard:
    'retires an unposted draft; the row stays on record as discarded with its reason',
  // D156 critic F2: the writes whose name says they send, transmit, publish, export, connect, grant,
  // sync or open a portal, and that stay ungoverned, each for a reason about what leaves the machine.
  export_workspace:
    'writes an export bundle to a local directory on this machine; nothing is transmitted',
  payroll_handoff_export:
    'writes a local CSV or JSON file for the payroll provider; TILL transmits nothing, a person hands it over',
  portal_resolve:
    'the verb the outside token holder calls: pre-workspace (no workspaceId, the token names the grant), so the seam has no dial to read; it only reads what a governed grant already opened',
  ebill_prepare:
    'writes the eBill payload and its PDF to local storage only; nothing leaves until ebill_transmit, which is governed under send',
  set_ebill_config:
    "records the workspace's own eBill biller id, a local setting naming who sends, never who is paid (the QR IBAN is set_creditor_profile, governed under pay)",
  // D158: the writes the widened sweep surfaced (a seal, lock, commit, issue, close, finalise or post
  // in the name) that stay ungoverned, each for a reason about what the verb does in the code.
  capture_commit:
    'turns a reviewed capture into a DRAFT vendor bill or expense line and books nothing; the booking is post_vendor_bill or expense_claim_approve, both governed under post',
  files_upload_commit:
    'finishes a chunked upload into a NEW file and changes nothing that already exists; removing the file again is files_delete, governed under erase',
  po_close_short:
    'waives the open remainder of a sent or received purchase order: nothing is booked or sent to the supplier, the order keeps its rows, and a waived quantity is ordered again on a new purchase order. It also ends three-way matching for the order: match_bill needs a sent or received order, so a received line still unbilled can no longer be matched (its bill is still posted and paid through the governed verbs)',
  requisition_close:
    'settles an internal purchase request once it was converted: nothing is booked or sent, and the purchase orders it produced are untouched; new demand is a new requisition',
  // D158 critic round 1: the leg (b) writes the widened population surfaced that stay ungoverned.
  accrual_create:
    'saves an unposted DRAFT and books nothing; the booking is accrual_post, governed under post, and a draft is retired with accrual_discard',
  provision_create:
    'saves an unposted DRAFT and books nothing; the booking is provision_post, governed under post, and a draft is retired with provision_discard',
  retainer_close:
    'ends a mandate (OR 404 Abs. 1 makes it terminable at any time) and books nothing; without skipFinal it refuses while a closed period is unbilled, and a skipped period can still be billed on an ordinary invoice',
  // D160.5: the stop button of the plugin family, whose start directions are governed above
  // (`uninstall_plugin` is governed too since D161.1: it removes the install for good).
  disable_plugin:
    'the stop direction for third-party code: it sweeps the plugin\'s registrations and stops its sandbox, keeping the manifest and grants; starting it again is enable_plugin, governed under plugin-install',
  // D161: the two human-only writes. Neither drafts, because a drafted approval or dial grant would be
  // approved by the same person it asks; the engine refuses the governed seat on the ACTOR for both.
  approve_drafted_action:
    'human-only: approveDraftedAction refuses every governed seat with cannot_self_approve before it reads the row, and A24 step 0 denies the governed seat manage_agent_dial; an approval is the human act a Vorschlag waits for, so drafting one would ask the same person twice',
  set_agent_dial:
    'human-only: setAgentDial refuses every governed seat with cannot_self_grant, writeDialLevel throws for one, and A24 step 0 denies the governed seat manage_agent_dial; a dial grant is the human act that decides what drafts, so it cannot itself be a draft',
};

/**
 * D156 point 5: the verbs whose own confirm step an APPROVED draft satisfies. Approving a Vorschlag is
 * the human confirmation these verbs ask for (P8), so the approval replay sets the field to `true`
 * (`approveDraftedAction`); without it an approved `env_delete` drafted with no `confirmed` would
 * replay as a plan and be marked executed while nothing happened, and an approved `gl_archive_purge`
 * would fail `needs_confirmation`. The stored payload is untouched. An AGENT passing the field itself
 * changes nothing: the dial drafts the call first (asserted in `dial-covers-irreversible.test.mjs`).
 */
export const APPROVAL_CONFIRMS_FIELD: Readonly<Record<string, string>> = {
  files_delete: 'confirmed',
  discard_testmandant: 'confirmed',
  discard_orphan_testmandant: 'confirmed',
  discard_demo_workspace: 'confirmed',
  gl_archive_purge: 'confirmed',
  env_reset: 'confirmed',
  env_delete: 'confirmed',
  env_copy: 'confirmed',
  implementation_project_close: 'confirmed',
  migration_close_plan: 'confirmed',
  // D158 critic round 1: abandoning a plan is governed (under erase since 11.10.2026), and the approval
  // is its confirm.
  migration_abandon_plan: 'confirmed',
  // The governed verbs that carried a confirm step before D156 (coordinator follow-up, 10.10.2026).
  // Each flag is the P8 "a person said yes on this occasion" step, which the approval is: an agent
  // drafting `wage_journal_post` without `confirm` was approved, replayed as a PREVIEW and marked
  // executed while nothing posted; `migration_rollback_step` and `confirm_statement_gap` failed
  // `needs_confirmation` after the human had approved.
  send_invoice: 'confirmed',
  issue_dunning_run: 'confirmed',
  send_dunning_run: 'confirmed',
  apply_qr_match: 'confirmed',
  override_qr_match: 'confirmed',
  mark_batch_paid: 'confirmation',
  payment_batch_transmit: 'confirm',
  confirm_statement_gap: 'confirmed',
  revoke_statement_gap_confirmation: 'confirmed',
  wage_journal_post: 'confirm',
  expense_claim_approve: 'confirm',
  expense_claim_reimburse: 'confirm',
  migration_rollback_step: 'confirmed',
  // D156 critic F2. bank_channel_connect's OTHER flag, `confirmBankKeys` (with the hashes compared
  // against the bank's paper letter), is not set: it replays exactly as drafted, on the card.
  portal_grant_send: 'confirmed',
  ebill_transmit: 'confirmed',
  sign_requests_send: 'confirmed',
  bank_channel_connect: 'confirm',
  // D161: the two newly governed verbs that carry a confirm step. Without the field an approved
  // `bank_channel_disconnect` replays into `needs_confirmation` (its dial check reads the workspace's
  // `posting_auto_issue`, not the agent dial), and an approved discard of a GENERATED payment run
  // refuses `confirmation_required`.
  bank_channel_disconnect: 'confirm',
  discard_payment_batch: 'confirmation',
};

/**
 * The governed verbs with a confirm-like input the approval deliberately does NOT set, each with the
 * reason. `dial-covers-irreversible.test.mjs` requires every governed verb with such a field to sit in
 * exactly one of the two maps.
 */
export const APPROVAL_CONFIRM_NOT_SET: Readonly<Record<string, string>> = {
  go_productive:
    'confirmedName is a type-to-confirm against the legal name, not a flag: the approval replays the name the agent drafted, so the card shows it and a wrong one refuses confirm_name_mismatch rather than promoting',
};

/**
 * INPUT-KEYED DIAL RULES (G22, non-author critic 2026-09-09): a verb whose consequence depends on
 * its INPUT and not only on its name. `checklist_item_complete` records a routine sign-off on most
 * items, but with `evidence.kind === 'filed_attestation'` (the `eportal_filed` item) it records the
 * statutory "filed in the ESTV ePortal" claim, the same claim `vat_mark_filed` acts on. Governing
 * the whole verb by name would draft the agent's OWN verb items (`vat_return_computed`,
 * `ech0217_exported`, the ones the template hands to the agent) under a strong-default ask, so the
 * rule keys on the input and resolves to the SAME capability as `vat_mark_filed` (`vat-file`, D103
 * strong-default ask). `dialCapabilityForCall` is the ONE resolver the transport seam and the hub
 * read; the name-keyed map stays the closed §H-ENUM for every consumer that lists governed verbs.
 */
export interface InputKeyedDialRule {
  /** The registry verb name. */
  readonly action: string;
  /** The governing dial capability when `when` holds (one of A26's `DIAL_CAPABILITIES`). */
  readonly capability: string;
  /** The input predicate; a false answer leaves the call ungoverned, exactly as before. */
  readonly when: (input: Readonly<Record<string, unknown>>) => boolean;
  /**
   * Critic round 3 (N2): a predicate read against the BOOK, for a verb whose consequence depends on
   * what the workspace holds rather than on its input. Only the transport seam evaluates it.
   */
  readonly whenBook?: (ctx: WorkspaceContext, input: Readonly<Record<string, unknown>>) => boolean;
  /** One sentence for the reader: why this input is the governed one. */
  readonly why: string;
}

/**
 * The `update_recurring_schedule` patch keys that decide WHICH invoices an auto-issuing schedule issues,
 * to whom, or when (D141.2 and the critic's F3). `autoIssue: true` is governed beside them.
 */
export const RECURRING_GOVERNED_PATCH_KEYS: readonly string[] = [
  'contactId',
  'lines',
  'templateDocumentId',
  'currency',
  'interval',
  'customDays',
  'anchorDate',
  'endDate',
  'maxOccurrences',
];

export const INPUT_KEYED_DIAL_RULES: ReadonlyArray<InputKeyedDialRule> = [
  // Critic round 3 (N2): resetting a slot a person SAVED text for deletes that text, and the only way
  // back is saving it again through the governed dispatch_text_upsert. A slot with no saved text changes
  // nothing. So the reset drafts under `customize` exactly when the book holds a saved row: the input
  // cannot say, the book can (`whenBook`); the input-only answer is free.
  {
    action: 'dispatch_text_reset',
    capability: 'customize',
    when: () => false,
    whenBook: (ctx, input) =>
      typeof input.documentKind === 'string' &&
      typeof input.locale === 'string' &&
      ctx.store.db
        .prepare('SELECT 1 AS present FROM dispatch_texts WHERE workspace_id = ? AND document_kind = ? AND locale = ?')
        .get(ctx.workspaceId, input.documentKind, input.locale) !== undefined,
    why: 'Resetting a slot a person saved text for deletes that text, and getting it back means saving it again through the governed dispatch_text_upsert; a slot with no saved text changes nothing and stays free.',
  },
  {
    action: 'checklist_item_complete',
    capability: 'vat-file',
    when: (input) => {
      const evidence = input.evidence;
      return typeof evidence === 'object' && evidence !== null && (evidence as { kind?: unknown }).kind === 'filed_attestation';
    },
    why: 'The ePortal attestation is the statutory filing claim vat_mark_filed acts on; an agent may draft it for the owner, never record it alone.',
  },
  {
    action: 'checklist_item_complete',
    capability: 'post',
    when: (input) => {
      const evidence = input.evidence;
      const kind = typeof evidence === 'object' && evidence !== null ? (evidence as { kind?: unknown }).kind : undefined;
      return kind === 'statements_signoff' || kind === 'gv_attestation';
    },
    why: 'The statements sign-off and the GV attestation put a person behind the year\'s figures (G22 §10.1, the close templates); an agent drafts them at the post tier for the owner, never records them alone.',
  },

  // --- A39, the bank inbox (spec A39 §0.1 D-A39.4), one appended block -----------------------------
  // `book_bank_line`'s consequence depends on its TARGET, so it is keyed on the input: booking a line to
  // accounts or matching an existing entry is `post`, settling an open item or a payment run is `pay`.
  // The two single-capability A39 writes sit in the name map above.
  {
    action: 'book_bank_line',
    capability: 'post',
    when: (input) => {
      const t = input.target;
      const kind = typeof t === 'object' && t !== null ? (t as { kind?: unknown }).kind : undefined;
      // D175: a `rule` target is expanded into an `accounts` booking, so it rides the same tier.
      return typeof input.bankTxnId === 'string' && (kind === 'accounts' || kind === 'existing_entry' || kind === 'rule');
    },
    why: 'Booking a bank line to accounts (directly or by a Buchungsregel) or matching it to an existing entry puts a posting behind a bank fact; an agent drafts it at the post tier.',
  },
  {
    action: 'book_bank_line',
    capability: 'pay',
    when: (input) => {
      const t = input.target;
      const kind = typeof t === 'object' && t !== null ? (t as { kind?: unknown }).kind : undefined;
      // D178 E3: a contact booking (a Guthaben or an Anzahlung) and a Spesen reimbursement settle with a party too.
      return typeof input.bankTxnId === 'string' && (kind === 'open_item' || kind === 'payment_batch' || kind === 'contact' || kind === 'expense_claims');
    },
    why: 'Settling an invoice, a vendor bill, a payment run, a contact\'s Guthaben or Anzahlung, or expense claims from a bank line moves money between parties; an agent drafts it at the pay tier.',
  },
  // Security review (D178 E3): a contact booking that states how a refund treats the receipt VAT
  // (`target.refundVat`) can change a filed figure, so an agent drafts it at the vat-file tier too.
  {
    action: 'book_bank_line',
    capability: 'vat-file',
    when: (input) => {
      const t = input.target;
      return typeof input.bankTxnId === 'string' && typeof t === 'object' && t !== null && (t as { kind?: unknown }).kind === 'contact' && (t as { refundVat?: unknown }).refundVat !== undefined;
    },
    why: 'Stating how a refund of a prepayment treats its declared VAT can change a filed MWST figure; an agent drafts it at the vat-file tier.',
  },

  // --- The governance check of 28.09.2026, one appended block --------------------------------------
  // `transition_document` is A10's engine verb: `issue_invoice` and `issue_credit_note` are wrappers
  // over its `to: 'issued'` edge, so governing the wrappers by name while the engine verb stayed open
  // let an agent issue an invoice with no Vorschlag by naming the engine. Its `to: 'cancelled'` edge
  // reverses the posted entry. Keyed on the input because the other edges (sent, accepted, declined,
  // confirmed, and the quote verbs' own transitions) mint nothing. Issuing or cancelling a quote or an
  // order drafts too, which over-governs a non-posting edge in exchange for needing no row read here.
  {
    action: 'transition_document',
    capability: 'issue',
    when: (input) => typeof input.documentId === 'string' && input.to === 'issued',
    why: 'Issuing freezes the document, consumes its number and posts it; issue_invoice is a wrapper over this edge, so it drafts at the same tier.',
  },
  {
    action: 'transition_document',
    capability: 'post',
    when: (input) => typeof input.documentId === 'string' && input.to === 'cancelled',
    why: 'Cancelling an issued invoice or credit note posts its reversing entry; an agent drafts it at the post tier.',
  },
  // Critic B1 (claude/rmap-land): `quotes_accept` is governed under `issue` (D161), and the quote's
  // `accepted` edge of the engine verb reaches the same binding status (the verb now routes it through
  // `acceptQuote`), so naming the engine verb must draft at the same tier. Only a quote has the edge.
  {
    action: 'transition_document',
    capability: 'issue',
    when: (input) => typeof input.documentId === 'string' && input.to === 'accepted',
    why: 'Accepting a quote makes it binding for both sides (OR Art. 1 and 3); quotes_accept is a wrapper over this edge, so it drafts at the same tier.',
  },
  // A12: an auto-issuing schedule issues invoices on every tick, INTERNALLY, as its author (the invoker
  // dispatch never meets the dial). Measured 28.09.2026: an agent created one with `autoIssue: true`,
  // ran `run_due_recurring`, and two numbered invoices posted with no Vorschlag. So the schedule is
  // governed where it is authored: turning auto-issue on, or changing WHAT an auto-issuing schedule
  // issues and to whom, drafts under `issue` (owner decision, 28.09.2026). The approval replays as the
  // human approver (P3), so an auto-issuing schedule always has a human behind it. A draft-only
  // schedule stays free for the agent: its tick makes review drafts, which mint nothing.
  {
    action: 'create_recurring_schedule',
    capability: 'issue',
    when: (input) => typeof input.interval === 'string' && input.autoIssue === true,
    why: 'An auto-issuing schedule issues and posts an invoice on every tick with no further confirmation; an agent drafts it for the owner.',
  },
  {
    action: 'update_recurring_schedule',
    capability: 'issue',
    when: (input) => {
      const patch = input.patch;
      if (typeof input.scheduleId !== 'string' || typeof patch !== 'object' || patch === null) return false;
      const p = patch as Record<string, unknown>;
      // Without the row, a template change cannot tell an auto-issuing schedule from a draft-only one,
      // so every template change drafts: redirecting a human's auto-issuing schedule to another
      // customer or price would otherwise issue on the next tick with no Vorschlag. The CADENCE keys
      // join (non-author critic F3, owner decision 28.09.2026): retiming a human's auto-issuing
      // schedule to `customDays: 1` from today issued a not-yet-due invoice at once and one a day
      // after. Payment terms (`dueDays`), the name and the notes decide no invoice and stay free.
      return p.autoIssue === true || RECURRING_GOVERNED_PATCH_KEYS.some((k) => k in p);
    },
    why: 'Turning auto-issue on, or changing what a schedule issues, to whom, or when, decides invoices the tick will issue unattended; an agent drafts it for the owner.',
  },
  // D141 follow-up 4 (critic F1): `contacts_merge` re-points the source's recurring schedules onto the
  // target, which is the same retarget `update_recurring_schedule {contactId}` drafts under `issue`. The
  // merge's own tier is `erase`, which the owner may set to `auto` on its own, so a merge that moves an
  // auto-issuing schedule drafts under `issue` too. Read against the book: only the source's schedules
  // can say whether the merge changes who an unattended tick bills. A paused schedule counts (resume is
  // free, D66); an ended one never issues again; a draft-only schedule's tick makes review drafts only.
  {
    action: 'contacts_merge',
    capability: 'issue',
    when: () => false,
    whenBook: (ctx, input) =>
      typeof input.sourceId === 'string' &&
      ctx.store.db
        .prepare("SELECT 1 AS p FROM recurring_schedule WHERE workspace_id = ? AND contact_id = ? AND auto_issue = 1 AND status != 'ended' LIMIT 1")
        .get(ctx.workspaceId, input.sourceId) !== undefined,
    why: 'The merge moves an auto-issuing schedule onto the target contact, so the next tick issues invoices to a different party unattended; an agent drafts it for the owner, as it drafts a schedule contact change.',
  },
];

// --- The creditor IBAN (critic phase0-installable r1, P0.4e-5b), one appended rule -----------------
// `set_creditor_profile` writes the IBAN every future QR-bill of the workspace pays into. An agent seat
// executed it directly, so it could redirect every customer payment with no human, and the human then
// approved an `issue_invoice` draft whose payee they may not re-check. The verb has no required field
// (the IBAN, the name and the address each save alone), so it is keyed on the input: a call that names
// the IBAN or the QR-IBAN drafts at the pay tier. The creditor name and address alone decide no
// payment's destination and stay free (the agent may still help complete them).
(INPUT_KEYED_DIAL_RULES as InputKeyedDialRule[]).push({
  action: 'set_creditor_profile',
  capability: 'pay',
  when: (input) => input.iban !== undefined || input.qrIban !== undefined,
  why: 'The creditor IBAN is where every future QR-bill of the workspace is paid; an agent drafts a change to it for the owner, never makes it alone.',
});

// --- A Bankkonto's payment details (D156 point 3, the denylist's leg (f)), one appended rule -------
// `update_bank_account` renames a Bankkonto or rewrites its IBAN, currency or linked ledger account. The
// IBAN is the debtor account every later pain.001 run is built from and the currency and ledger account
// decide where its bank lines book, so a governed seat proposes a change to any of the three and the
// human approves it at the pay tier. The predicate is the engine's own `wantsKeyChange` test
// (`bankAccounts.ts`): a field PRESENT in the input, whatever its value, so a call resending the same
// IBAN drafts too (over-governing, the `set_creditor_profile` shape, in exchange for reading no row
// here). A rename alone is cosmetic and stays free.
(INPUT_KEYED_DIAL_RULES as InputKeyedDialRule[]).push({
  action: 'update_bank_account',
  capability: 'pay',
  when: (input) =>
    typeof input.bankAccountId === 'string' &&
    (input.iban !== undefined || input.currency !== undefined || input.ledgerAccountId !== undefined),
  why: "A Bankkonto's IBAN, currency or ledger account decides where payment runs debit and where its bank lines book; an agent drafts a change for the owner. A rename stays free.",
});

// --- D161 (owner, 11.10.2026), the input-keyed half of the approval map, one appended block --------
// Four verbs whose schema requires no field beyond the tenant, so the name map cannot hold them (the
// "no bare-tenant draftable" rule in test/agent/trust.test.mjs), or whose consequence depends on the
// input. Each predicate is the input that carries the governed act.
(INPUT_KEYED_DIAL_RULES as InputKeyedDialRule[]).push(
  {
    // D161.3: the VAT number is printed into the Swico billing information of every QR-bill rendered
    // from now on, the QR-bills of invoices already issued and still open included (`invoice.ts` reads
    // `workspace.mwst_no` live). Name, legal form and UID alone stay free.
    action: 'update_company_profile',
    capability: 'vat-file',
    when: (input) => input.mwstNo !== undefined,
    why: 'The MWST number reaches the QR-bills of open invoices when they are rendered again; an agent drafts a change to it for the owner.',
  },
  {
    // Either door of C02's accept (by id, or by the single-use token) makes the quote binding; a call
    // naming neither is refused by the verb itself (`invalid_input`) and writes nothing.
    action: 'quotes_accept',
    capability: 'issue',
    when: (input) =>
      (typeof input.quoteId === 'string' && input.quoteId.length > 0) || (typeof input.token === 'string' && input.token.length > 0),
    why: 'Accepting makes the quote binding and spends its accept link; an agent drafts it for the owner.',
  },
  {
    // The two scheduler ticks take only the tenant (and an optional asOf), so every call is the governed
    // one. Governed for the AGENT SEAT's own call only: the `till up` scheduler runs the automation tick
    // as `system` through `action.run`, and a rule or the approval replay dispatches through
    // `invokerFor`, none of which meets the transport seam (asserted in dial-covers-d161.test.mjs).
    action: 'run_due_recurring',
    capability: 'issue',
    when: () => true,
    why: 'The recurring tick makes every due invoice and issues the auto-issuing ones; an agent drafts the tick for the owner.',
  },
  {
    // The sign-off on working time (ArG). Keyed on a NON-EMPTY selection: `entryIds: []` approves nothing
    // and the verb refuses it itself (`invalid_input`) without writing, so the call answers the same
    // refusal on every face (conformance rule 7) instead of drafting a Vorschlag that can only fail.
    action: 'time_approve',
    capability: 'close-period',
    when: (input) => Array.isArray(input.entryIds) && input.entryIds.length > 0,
    why: 'Approving working time signs it off in the approver\'s name and makes it billable; an agent drafts it for the owner.',
  },
  {
    action: 'run_due_automations',
    capability: 'customize',
    when: () => true,
    why: "The automation tick fires every due rule in its author's name, unattended; an agent drafts the tick for the owner.",
  },
);

// --- D172, the workspace settings registry, generated: one rule per dial family in use per verb ------
// A setting's change drafts under the dial family its registry row declares (`dialCapability`): a display
// preference under `customize`, a setting that changes what money does under its money family, exactly as
// the per-capability config verbs do (`set_qr_auto_apply` is `pay`, `set_fx_method` is `vat-file`). Keyed
// on `key`; an unknown key resolves to `customize` and the verb then refuses it `unknown_setting`. Only the
// families the registry actually uses (plus `customize`, the floor) get a rule, so no rule exists that can
// never match.
for (const action of ['settings_set', 'settings_reset']) {
  const families = [...new Set<string>(['customize', ...SETTINGS.map((s) => s.dialCapability)])];
  for (const capability of families) {
    (INPUT_KEYED_DIAL_RULES as InputKeyedDialRule[]).push({
      action,
      capability,
      // A call without a non-blank reason is not drafted: the verb refuses it reason_required and writes
      // nothing, so a Vorschlag that could only fail at approval is never queued (critic D172 r1).
      when: (input) =>
        typeof input.key === 'string' && input.key.length > 0 && typeof input.reason === 'string' && input.reason.trim().length > 0 &&
        dialCapabilityForSetting(input.key) === capability,
      why: 'A workspace setting decides how TILL behaves for everyone from the next action on; an agent drafts a change for the owner at the tier of what the setting governs.',
    });
  }
}

/**
 * The INPUT-ONLY tier of an automation-rule write (non-author critic R3-2, owner decision 28.09.2026),
 * or undefined when the write lets nothing new fire. The transport seam does not stop here: it reads
 * the stored rule through `governedDialCapability` (`ruleTier.ts`, D141.5 R4-1), where this answer stays
 * one candidate and `customize` is a floor, so a template-only patch or an enable cannot fall back to
 * `customize` alone. A rule fires its verb as its author,
 * internally, outside the seam, so the write that makes a rule fire, or changes what a firing rule does,
 * is governed at the tier of the verb it fires (`post` for a `post_entry` rule, `issue` for an
 * `issue_invoice` rule), and at `customize` when that verb is not dial-governed or cannot be read from
 * the input. `update_automation_rule` is governed on any trigger, condition or action change: the rule
 * may be a human's ENABLED rule, which then fires the new action as that human.
 */
function automationRuleTier(action: string, input: Readonly<Record<string, unknown>>): string | undefined {
  const tierOf = (ruleAction: unknown): string => {
    if (typeof ruleAction !== 'object' || ruleAction === null) return 'customize';
    const a = ruleAction as { tool?: unknown; inputTemplate?: unknown };
    if (typeof a.tool !== 'string' || a.tool === 'create_automation_rule' || a.tool === 'update_automation_rule') return 'customize';
    const template = typeof a.inputTemplate === 'object' && a.inputTemplate !== null ? (a.inputTemplate as Record<string, unknown>) : {};
    return dialCapabilityForCall(a.tool, template) ?? 'customize';
  };
  if (action === 'create_automation_rule') {
    if (typeof input.name !== 'string' || input.enabled === false) return undefined;
    return tierOf(input.action);
  }
  if (action === 'update_automation_rule') {
    const patch = input.patch;
    if (typeof input.ruleId !== 'string' || typeof patch !== 'object' || patch === null) return undefined;
    const p = patch as Record<string, unknown>;
    if (!('trigger' in p) && !('condition' in p) && !('action' in p)) return undefined;
    return 'action' in p ? tierOf(p.action) : 'customize';
  }
  return undefined;
}

/** Every tier an automation-rule write can resolve to, in resolution order (`customize` last). */
const AUTOMATION_RULE_TIERS: readonly string[] = [
  ...new Set([...Object.values(DIAL_CAPABILITY_FOR_ACTION).filter((c) => c !== 'customize'), 'customize']),
];

// --- The governance check of 28.09.2026 (critic R3-2), generated: one rule per tier per verb --------
for (const action of ['create_automation_rule', 'update_automation_rule']) {
  for (const capability of AUTOMATION_RULE_TIERS) {
    (INPUT_KEYED_DIAL_RULES as InputKeyedDialRule[]).push({
      action,
      capability,
      when: (input) => automationRuleTier(action, input) === capability,
      why: 'A rule fires its verb as its author, outside the seam; a write that makes a rule fire, or changes what a firing rule does, drafts at the tier of the verb it fires.',
    });
  }
}

/**
 * Whether ANY rule for this verb is book-keyed (`whenBook`). A caller that holds no book (the plugin
 * bridge) cannot evaluate such a rule, so it must fail CLOSED on the verb (round-4 critic N1).
 */
export function hasBookKeyedDialRule(name: string): boolean {
  return INPUT_KEYED_DIAL_RULES.some((r) => r.action === name && r.whenBook !== undefined);
}

/**
 * The capabilities the BOOK-keyed rules (`whenBook`, critic round 3 N2) give ONE call, read against the
 * book. The transport seam adds them through `governedDialCapability` (ruleTier.ts); a reader without a
 * book (`dialCapabilityForCall`) sees such a rule as not matching, which is the free answer a no-op
 * deserves, while `dialCapabilitiesForVerb` still names the capability, so the verb counts as governable.
 */
export function stateKeyedDialCapabilities(ctx: WorkspaceContext, name: string, input: Readonly<Record<string, unknown>>): string[] {
  return INPUT_KEYED_DIAL_RULES.filter((r) => r.action === name && r.whenBook !== undefined && r.whenBook(ctx, input)).map((r) => r.capability);
}

/**
 * The dial capability governing ONE CALL: the name-keyed map first, then the input-keyed rules.
 * `undefined` means the call is not dial-governed and the transport runs it exactly as before.
 */
export function dialCapabilityForCall(
  name: string,
  input: Readonly<Record<string, unknown>>,
  rules: ReadonlyArray<InputKeyedDialRule> = INPUT_KEYED_DIAL_RULES,
): string | undefined {
  return dialCapabilitiesForCall(name, input, rules)[0];
}

/**
 * How severe a dial capability's act is, most severe first: the irreversible seal of a period, the
 * cutover into the real books, an erasure, the statutory filing claim, money leaving, a frozen numbered
 * document, an outbound send, data shared outside, a reminder, a posting, then the two configuration
 * families. It orders the
 * candidates of a call that matches SEVERAL input-keyed rules (critic R3 on cl-periods: the FIRST
 * match used to win, so an extra input field matching an earlier, looser rule could move a call to
 * a weaker dial). A capability missing here sorts last; a guard test holds it equal to the dial set.
 */
export const DIAL_SEVERITY: readonly string[] = [
  'close-period',
  'go-live',
  // D156: an erasure has no way back at all, so it outranks every family with a correction.
  'erase',
  'vat-file',
  'pay',
  'issue',
  'send',
  // D156: data leaving the machine is an outbound act, beside `send`.
  'share',
  'dun',
  'post',
  // D161: stock moves value without an entry, below the posting it never makes.
  'stock',
  'plugin-install',
  'customize',
];

function severityOf(capability: string): number {
  const i = DIAL_SEVERITY.indexOf(capability);
  return i === -1 ? DIAL_SEVERITY.length : i;
}

/**
 * EVERY dial capability that governs one call, most severe first: the name-keyed one when the verb has
 * it (a by-name verb is governed by its name alone, whatever its input), else every input-keyed rule
 * that matches, never only the first. `dialCapabilityForCall` answers the most severe of them for a
 * reader without a book (the hub's label); the transport seam (`governedDialCapability`) reads the
 * book and drafts when ANY of them would (`strictestDialCapability`), so no rule order and no extra
 * input field can ever make a call looser than its strictest match.
 */
export function dialCapabilitiesForCall(
  name: string,
  input: Readonly<Record<string, unknown>>,
  rules: ReadonlyArray<InputKeyedDialRule> = INPUT_KEYED_DIAL_RULES,
): string[] {
  const byName = DIAL_CAPABILITY_FOR_ACTION[name];
  if (byName !== undefined) return [byName];
  const matched = new Set<string>();
  for (const rule of rules) {
    if (rule.action === name && rule.when(input)) matched.add(rule.capability);
  }
  return [...matched].sort((a, b) => severityOf(a) - severityOf(b));
}

/**
 * Every dial capability a verb CAN be governed under, most severe first: its name-keyed family, else
 * every capability one of its input-keyed rules names. Empty for a verb the dial never governs. The
 * transport seam reads it for a call whose input is too incomplete to say which rule applies (D156
 * critic F1): such a call to a verb that can be governed is refused, never run past the dial.
 */
export function dialCapabilitiesForVerb(name: string, rules: ReadonlyArray<InputKeyedDialRule> = INPUT_KEYED_DIAL_RULES): string[] {
  const byName = DIAL_CAPABILITY_FOR_ACTION[name];
  if (byName !== undefined) return [byName];
  const caps = new Set(rules.filter((r) => r.action === name).map((r) => r.capability));
  return [...caps].sort((a, b) => severityOf(a) - severityOf(b));
}

/**
 * D156: the consequence of every verb that carries one, RESOLVED from the one catalogue in
 * `consequences.ts` (the verb's own entry, else its name-keyed dial family's). This is the set of verbs
 * the MCP descriptions, `_meta`, the API catalog and the Studio projection carry: every name-keyed
 * governed verb plus every verb with an entry of its own (the input-keyed ones and the G22 checklist
 * verbs). An input-keyed verb with no entry of its own resolves per CALL through `consequenceFor`.
 */
export const CONSEQUENCE_ENTRY_FOR_ACTION: Readonly<Record<string, Consequence>> = Object.fromEntries(
  [...new Set([...Object.keys(DIAL_CAPABILITY_FOR_ACTION), ...Object.keys(CONSEQUENCE_FOR_VERB)])]
    .map((verb) => [verb, consequenceFor(verb, DIAL_CAPABILITY_FOR_ACTION[verb])] as const)
    .filter((pair): pair is readonly [string, Consequence] => pair[1] !== undefined),
);

/**
 * The English consequence sentence per verb, a PROJECTION of `CONSEQUENCE_ENTRY_FOR_ACTION` (D156).
 * Applied onto the built `ACTIONS` by `registry.ts` (`ActionDef.consequence`), which the MCP tool
 * description ends with; a name here that resolves to no action THROWS at load, so the map cannot rot.
 */
export const CONSEQUENCE_FOR_ACTION: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CONSEQUENCE_ENTRY_FOR_ACTION).map(([verb, c]) => [verb, c.en]),
);
