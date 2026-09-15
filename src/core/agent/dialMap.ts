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
  asset_acquire: 'post',
  asset_add_capitalisation: 'post',
  asset_depreciation_run_post: 'post',
  asset_depreciation_run_reverse: 'post',
  asset_dispose: 'post',
  inventory_valuation_post: 'post',
  inventory_valuation_reverse: 'post',
  landed_cost_allocate_confirm: 'post',
  landed_cost_reverse: 'post',
  // set_opening_balances is deliberately NOT dial-governed: it is the one setup-time / pre-productive
  // opening verb, and drafting it at the transport seam would return 200 for a structurally-complete
  // but UNBALANCED input, before the verb's own `unbalanced` refusal runs. That breaks A04's
  // REST/MCP parity contract (test/opening/opening-api.test.mjs), whose body must BE the registry
  // Result (a 422). No other governed verb has a conformance twin asserting a pre-validation refusal.

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
  /** One sentence for the reader: why this input is the governed one. */
  readonly why: string;
}

export const INPUT_KEYED_DIAL_RULES: ReadonlyArray<InputKeyedDialRule> = [
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
];

/**
 * The dial capability governing ONE CALL: the name-keyed map first, then the input-keyed rules.
 * `undefined` means the call is not dial-governed and the transport runs it exactly as before.
 */
export function dialCapabilityForCall(name: string, input: Readonly<Record<string, unknown>>): string | undefined {
  const byName = DIAL_CAPABILITY_FOR_ACTION[name];
  if (byName !== undefined) return byName;
  for (const rule of INPUT_KEYED_DIAL_RULES) {
    if (rule.action === name && rule.when(input)) return rule.capability;
  }
  return undefined;
}

/**
 * The consequence sentence per mapped verb: what the write irreversibly does, in the caller's
 * language (English, like `summary`; the Studio's de-CH sentence lives in the Agent surface
 * catalogue, keyed by dial capability). Applied onto the built `ACTIONS` by `registry.ts`;
 * a name here that resolves to no action THROWS at load, so the map cannot rot.
 */
export const CONSEQUENCE_FOR_ACTION: Readonly<Record<string, string>> = {
  post_entry: 'Posts an immutable journal entry; the only correction afterwards is a reversing entry.',
  reverse_entry: 'Posts an immutable reversing entry against a posted one; it cannot be un-posted.',
  issue_invoice: 'Freezes the invoice and assigns its number; an issued invoice can only be credited, never edited.',
  issue_credit_note: 'Freezes the credit note, assigns its number and posts its ledger effect.',
  send_invoice: 'Hands the invoice to the outbound transport; a sent invoice cannot be unsent.',
  propose_dunning_run: 'Freezes a reminder run proposal over the open items as of the given date.',
  issue_dunning_run: 'Freezes the reminder run, advances each debtor one dunning level and books any fee.',
  send_dunning_run: 'Hands the reminder letters to the outbound transport; sent reminders cannot be unsent.',
  record_payment: 'Books a payment against the ledger and settles the allocated open items.',
  allocate_payment: 'Applies a recorded payment to open items; the settlement posts to the ledger.',
  reverse_payment: 'Posts a reversing entry against the payment and reopens what it had settled.',
  vat_mark_filed: 'Marks the VAT period as filed with the ESTV; a filed period is closed to correction runs.',
  define_field: 'Adds a workspace-visible custom field to every record of the chosen kind.',
  install_plugin: 'Installs third-party code into the workspace with the scopes it was granted.',
  // pay: the settlement surface beyond record/allocate/reverse_payment.
  mark_batch_paid: 'Confirms the bank paid the batch and settles every bill in it.',
  payment_batch_transmit: 'Uploads the payment batch to the bank over EBICS; the bank releases it and the upload cannot be recalled.',
  apply_qr_match: 'Settles the invoice from the queued credit and posts the payment; the settlement can only be undone by a reversal.',
  override_qr_match: 'Re-points or reverses a queued match, moving money between debtors through a reversing payment.',
  confirm_match: 'Settles the bank debit against its vendor bills and posts the payment.',
  expense_claim_reimburse: 'Pays the employee for an approved expense claim; a reimbursed claim is never paid twice.',
  // post: the ledger surface beyond post/reverse_entry.
  create_entry_for_txn: 'Books an unmatched bank transaction as a journal entry; the only correction is a reversing entry.',
  wage_journal_post: 'Posts the month\'s aggregate wage journal as one balanced entry; a wrong journal is reversed, never edited.',
  post_vendor_bill: 'Posts the draft vendor bill to the ledger; the only correction afterwards is a reversing entry.',
  post_fx_revaluation: 'Posts the period-end unrealised currency gain or loss, with its automatic next-period reversal.',
  accrual_post: 'Posts the accrual and its automatic next-period reversal as one pair; the only correction afterwards is a reversing pair.',
  accrual_reverse: 'Posts the mirror pair against a posted accrual so every account nets to zero, without rewriting history.',
  provision_post: 'Posts the provision as an immutable entry; it is released or reversed later, never edited.',
  provision_release: 'Posts the release of part or all of the provision against the target account; a release is undone only by a reversal.',
  provision_reverse: 'Posts a reversing entry against the provision formation; it cannot be un-posted.',
  provision_release_reverse: 'Posts a reversing entry against one release of the provision, restoring its open balance; it cannot be un-posted.',
  fx_revaluation_reverse: 'Books the mirror of the period-end currency revaluation and its own next-day reversal; the original entries stay on record.',
  vat_settlement_post: 'Transfers the filed period\'s VAT balances from 2200, 1170 and 1171 to 2201 inside the filed period; the filed return does not change, and the only correction is a reversing entry.',
  vat_settlement_reverse: 'Reverses the VAT settlement with a mirror entry dated the period end; the settlement stays on record as reversed.',
  expense_claim_approve: 'Approves the expense claim and posts the reimbursement liability to the ledger.',
  asset_acquire: 'Capitalises the asset and posts its acquisition entry; the financial fields lock afterwards.',
  asset_add_capitalisation: 'Posts additional cost onto an acquired asset and raises its book value.',
  asset_depreciation_run_post: 'Posts the depreciation run across every asset in it; a double-post never double-counts.',
  asset_depreciation_run_reverse: 'Posts a reversing entry against a posted depreciation run, without rewriting history.',
  asset_dispose: 'Posts the asset\'s disposal and the resulting gain or loss; the asset leaves every future depreciation run.',
  inventory_valuation_post: 'Posts the inventory valuation delta and updates the balance-sheet inventory figure.',
  inventory_valuation_reverse: 'Posts the mirror of a valuation run and restores the baseline the next run measures against.',
  landed_cost_allocate_confirm: 'Allocates the voucher across its targets and posts the balanced landed-cost entry.',
  landed_cost_reverse: 'Posts the compensating reversal of a confirmed landed-cost allocation, without editing the original.',
  // set_opening_balances stays ungoverned (see the note in DIAL_CAPABILITY_FOR_ACTION above).
  // close-period: sealing a period against further posting.
  close_year: 'Sweeps the year\'s profit or loss into equity and seals the fiscal year; a sealed year cannot be reopened.',
  lock_period: 'Locks the period against further posting; a hard lock seals it permanently and cannot be unlocked.',
  close_month: 'Soft-closes the month: every later posting into it is refused until a human reopens it.',
  reopen_month: 'Reopens a soft-closed month, so postings into a month a human had declared done are accepted again.',
  unlock_period: 'Lifts a soft period lock, so postings into a period a human had locked are accepted again; a hard seal refuses.',
  // go-live: the migration cutover into the real books.
  go_productive: 'Promotes the trial workspace to real books in place; the cutover is irreversible.',
  import_open_items: 'Writes the migrated open AR and AP items into the live opening balance; the batch cannot be un-imported.',
  // customize: the membership verbs (D123).
  invite_member: 'Seats a person or an agent in the workspace with the chosen role; whoever redeems the token sees the books from then on.',
  set_role: 'Changes what a member may see and do in the workspace; the new rights apply on their next call.',
  revoke_member: 'Removes a member\'s access to the workspace; the lockout applies on their next call.',
  define_role: 'Redefines which capabilities a role holds, for every member who has that role.',
  // G22 checklists (D118 C4 on every write; no money moves, and none is governed BY NAME, but each
  // states what it records so the MCP client and the palette read the same sentence the dialog
  // shows). The ePortal attestation input of checklist_item_complete is governed under vat-file
  // through INPUT_KEYED_DIAL_RULES above.
  checklist_start: 'Creates the checklist run for the period with every item and its statutory due date; a run is abandoned, never deleted.',
  checklist_item_complete: 'Records the item as done under your name, binding the evidence the engine computed or the sign-off you stand behind; the ePortal attestation is the statutory filing claim and drafts for the owner under the vat-file dial.',
  checklist_item_skip: 'Marks the item as not applicable with your reason; it stays visible in the run and in the audit log.',
  checklist_item_reopen: 'Reopens the item and voids its live sign-off; the earlier sign-off stays on record as voided.',
  checklist_abandon: 'Abandons the run with your reason; it stays listed and stops feeding the attention hub.',
};
