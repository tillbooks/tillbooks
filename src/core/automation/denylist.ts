/**
 * THE VERBS NO RULE MAY EVER FIRE, in a module of their own so every enforcement point can import
 * them without a cycle.
 *
 * This lived in `rules.ts` until the F5 critic measured what that cost (F5-C1, 30.07.2026,
 * `docs/critique/f5-critic.md`): `rules.ts` imports `fire.ts` (for `isSelfTriggering`), so the fire
 * path could not import the denylist back without a circular import, and it simply did not. The
 * denylist was enforced at SAVE time only, while `evaluateAndFire` and `retryAutomationRun` invoked
 * whatever `action_tool` the stored row carried. Every verb the F5 pass added was a legal, saveable
 * action one commit earlier, so the branch created the exact population it failed to protect: the
 * critic fired `close_year` (a fiscal year sealed, nothing walks it back), `unlock_period`,
 * `set_role` and `create_workspace` from stored rows, all `status ok`. Three layers now consult this
 * set: the save path (`rules.ts`), the fire path and its retry (`fire.ts`), and the one-time data
 * migration that disables stored rules naming a denied verb (`store/migrations.ts`).
 *
 * `isRegisteredWriteAction` is a permissive test by design: the legal set of actions IS the write half
 * of `ACTIONS`, so a capability makes its verbs automatable by doing nothing at all. That is the right
 * default and it is documented as such in `events.ts`. It is not a complete answer, because it says
 * only "is this a write", and some writes must never be reached by a stored template firing at 03:00.
 *
 * THE CRITERION, stated so the list can be argued with. C00's remediation authored it with two legs
 * and named `close_year` and `unlock_period` as "the next real candidates... not C00's remediation to
 * make"; the F5 retrofit pass (30.07.2026, `docs/planning/f5-retrofit-survey.md`) made that call
 * across all write verbs. A verb belongs here when:
 *
 *  (a) its effect cannot be undone by another verb;
 *  (b) it discharges a legal duty a human has to own;
 *  (c) it decides WHO may act in the workspace, in either direction;
 *  (d) it acts outside the tenant the rule lives in, so the fire path's §H-TENANT overwrite cannot
 *      bind it;
 *  (e) it administers the unattended subsystem itself;
 *  (f) it alters a payment destination (D65, owner-decided 30.07.2026): who receives money, or what
 *      a counterparty is told to pay.
 *
 * The entries, by leg:
 *
 *  - (a) `contacts_merge` mints a one-way tombstone; `contacts_anonymise` erases personal data. Both
 *    are C00's, both are spec-forbidden, and a revDSG erasure path must stay outside the
 *    customization system entirely (§6b Fixed).
 *  - (a) the hard deletes (`delete_account`, `delete_cost_center`, `delete_draft`, `delete_item`,
 *    `item_categories_delete`) destroy a row with no reversing verb, and D00's later pair
 *    (`price_lists_delete`, `price_lists_unset_price`) destroys dated pricing history the same way.
 *    `files_delete` erases a business record and its bytes for good. `archive_*` is the automatable
 *    counterpart of every one of these and stays automatable.
 *  - (a) `close_year` hard-seals a fiscal year and sweeps the P&L into equity; no verb reopens it.
 *  - (b) `vat_mark_filed` records a filing with the ESTV and hard-locks the months, and
 *    `vat_saldo_declaration_basis` moves the figure of a Steuerperiode that is or will be declared
 *    (the F11 finding: under Saldo a return is recomputed from the rule that governed the period). A
 *    statutory statement is not something a rule gets to make. `unlock_period` is the same leg from
 *    the other side: prising open a hard lock protecting filed figures at 03:00, with nobody
 *    watching, removes a statutory protection a human has to own.
 *  - (c) `revoke_member` removes a person's access, and the same lockout is reachable by two other
 *    names: `set_role` (demote to `viewer`) and `define_role` (strip the bundle every holder
 *    resolves). Listing one of the three and not the others would make the entry decorative.
 *    `invite_member` is the other direction of the same decision: who may see the books is a
 *    decision a person makes, and A24's own asymmetry says granting is the guarded direction.
 *  - (d) `create_workspace`, `bootstrap_workspace` and `accept_invite` take no `workspaceId`, so
 *    `evaluateAndFire`'s tenant overwrite binds NOTHING: a rule naming one would mint tenants or
 *    redeem invite tokens outside the workspace it lives in, ungated, because pre-workspace verbs
 *    resolve no capability at all.
 *  - (e) `create_automation_rule`, `update_automation_rule` and `enable_automation_rule` let a rule
 *    mint, retarget or switch on rules: `enable` is the direct bypass of the P8 gate (an
 *    agent-authored rule lands disabled so a HUMAN enables it), and `update` can retarget an
 *    enabled, human-approved rule's action so the approval goes stale without a human.
 *    `run_due_automations` and `retry_automation_run` re-drive the fire path from inside a firing;
 *    both hold an `ActionInvoker`, and D50's remediation gated the tick precisely so it is never
 *    driven by an unattended caller.
 *  - (e) A12's recurring schedules are a SECOND standing unattended writer, and the same leg binds
 *    them for the same reasons. `create_recurring_schedule` lets a rule mint an invoice generator
 *    no human approved; `update_recurring_schedule` can retarget an approved schedule's contact,
 *    amount or `autoIssue` so the approval goes stale (the `update_automation_rule` argument
 *    verbatim); and `run_due_recurring` re-drives a generation loop from inside a firing, the
 *    shape D50 gated `run_due_automations` for. The three lifecycle directions stay automatable
 *    per D66 (owner-decided 30.07.2026): `pause_recurring_schedule` and `end_recurring_schedule`
 *    are STOP buttons, and `resume_recurring_schedule` can neither retarget the template nor flip
 *    `autoIssue`, so it restores only what a person already configured; the run log records every
 *    generated occurrence and the 24-period cap bounds any catch-up burst. No data migration
 *    accompanies these three entries: the verbs land in the same commit, so no stored rule can
 *    predate their denial.
 *  - (f) `set_creditor_profile` rewrites `workspace.creditor_iban`, the field every QR bill is built
 *    from, and `send_invoice` stays deliberately automatable as the showcase: the critic's C8 probe
 *    composed the two into "one rule repoints the payee, the showcase mails QR bills payable to it",
 *    with not one denied verb involved. `update_bank_account` can rewrite a Bankkonto's IBAN and
 *    details, which D65 names explicitly ("bank-account details used in payment instructions"): A18
 *    creditor payments builds payment instructions from exactly those rows.
 *  - (f) `set_creditor_bank_profile` (A18) is the vendor payment-target verb this note used to say
 *    did not exist yet. It writes the ONE fact `create_payment_batch`'s pain.001 instruction reaches
 *    a vendor at (A17's `vendor_bill` carries no IBAN, so A18 added this table). A rule that could
 *    fire it would let a stored template repoint where a future payment run's money goes, with
 *    nobody watching, which is leg (f) verbatim. `create_payment_batch` and `generate_pain001`
 *    themselves stay OFF this list and are §6b's accepted automation actions: neither can choose or
 *    change a creditor's IBAN, they only ever consume whatever `set_creditor_bank_profile` already
 *    set, through a verb that IS gated here. The A18 critic's DQ1 held this stance defensible only
 *    ONCE a discard path existed (an unattended `create_payment_batch` would otherwise lock every
 *    payable into an undiscardable batch whose only exit was to pay it). `discard_payment_batch`
 *    (F4) is that path, so the stance now holds: an automated draft is fully recoverable, and the
 *    money still moves only at `mark_batch_paid`, which is denied below. Recorded as D82.
 *
 * G10 migration maps: all three writes (`migration_set_map`, `migration_save_map_template`,
 * `migration_apply_map_template`) are DELIBERATELY automatable, and the spec says so rather than
 * leaving it to the permissive default (§6b: G10 "accepts automation actions naming its own write
 * verbs ... a rule that applies a house template when a plan is created is the plausible one"). No
 * leg holds: a map is configuration corrected by writing it again (not (a)); it discharges no
 * statute (the COMMIT that consumes a map is G09's, behind its own gates, not (b)); it decides no
 * membership (not (c)); every verb takes `workspaceId`, so the fire path's tenant overwrite binds
 * them (not (d), and the operator-scoped template a firing can reach is only ever the RULE
 * AUTHOR's own, because the firing runs as the author); they administer nothing unattended (not
 * (e)); and a map names ledger accounts and tax codes, never an IBAN or payment destination (not
 * (f)). A wrong map still cannot become a wrong posting unattended: setMap validates every target
 * at write, and the unmapped-balance gate blocks G09's preview regardless of who wrote the map.
 *
 * C01 leads & deals: all eight writes (`deals_create`, `deals_update`, `deals_move`, `deals_mark`,
 * `deals_log_activity`, `deals_to_quote`, `pipelines_upsert`, `pipeline_stages_upsert`) are
 * DELIBERATELY automatable, and the spec says so rather than leaving it to the permissive default
 * (§6b: every deals verb is nameable as an automation action). No leg holds: a deal is
 * pre-financial state corrected by writing it again, `deals_mark` included, because `open` is a
 * legal target that reopens a closed deal (not (a)); it discharges no statute (not (b)); decides
 * no membership (not (c)); every verb takes `workspaceId`, so the tenant overwrite binds (not
 * (d)); administers nothing unattended (not (e)); and names no payment destination (not (f)).
 * `deals_to_quote` deserves its own sentence: it delegates through the dispatch AS THE RULE
 * AUTHOR, so the quote verb's own `issue` gate is re-checked live against them, and what it mints
 * is a DRAFT document that A10's lifecycle gates before any money exists.
 *
 * D03 sales orders & delivery notes: all eight writes (`sales_order_create`, `sales_order_from_quote`,
 * `sales_order_confirm`, `sales_order_cancel`, `sales_order_invoice`, `delivery_note_create`,
 * `delivery_note_issue`, `delivery_note_render`) are DELIBERATELY automatable, and spec §5/§6b names
 * the five consequence-bearing ones as accepted rule actions ("when a confirmed order`s Priorität is
 * hoch, auto-create the delivery note"). No leg holds: an order is operational state a cancel walks
 * back (not (a)); it discharges no statute, D03 POSTS NOTHING (not (b)); decides no membership (not
 * (c)); every verb takes `workspaceId`, so the tenant overwrite binds (not (d)); administers nothing
 * unattended (not (e)); and names no payment destination (not (f)). Two ride behind a second fence
 * already: `delivery_note_issue` is P8-gated (stock leaves the shelf) AND trips D01`s
 * `manage_master_data` inside stock.move, and `sales_order_invoice` only ever mints an A11 DRAFT that
 * A10`s lifecycle gates before any money exists, the `deals_to_quote` shape one family over.
 * `delivery_note_render` files a local Beleg and transmits nothing (OP4).
 *
 * E02 HR-lite: all fourteen verbs are DELIBERATELY automatable, and spec §5/§6b names the four
 * consequence-bearing ones (`expense_claim_approve`, `expense_claim_reject`, `expense_claim_reimburse`,
 * `hr_absence_record`) as accepted rule actions, the auto-approve-under-threshold automation being the
 * worked example. No leg holds, and the reasoning is worth stating because approve and reimburse look
 * like leg (b)/(f) candidates. `expense_claim_approve` posts a REVERSIBLE liability (a wrong approval
 * is walked back by an A02 reversing entry plus a fresh claim), it is NOT a statutory statement to any
 * authority (not (b)), and the two controls a stored-input `confirm:true` might seem to bypass both
 * still bind on every firing: the `self_approval` refusal (a firing runs as its rule author, so a
 * rule cannot approve its author`s own claim) and the `spesen.approve` capability re-checked live
 * against that author. `expense_claim_reimburse` is NOT leg (f): it changes NO payment destination
 * (the payee is the claim`s own employee contact, fixed at approval, and the verb names no IBAN), and
 * in the OSS core it TRANSMITS NOTHING (`transmitted:false, reason:'cloud_tier'`), so an automated
 * reimburse books a reversible 2000 Kreditoren settlement and prepares a LOCAL file a human must
 * still transmit: no money leaves the business unattended. It is also idempotent (paid at most once).
 * The other ten writes are reversible drafts/records over personnel data, gated by `hr.manage`/
 * `spesen.submit` re-checked against the firing`s author. `mark_batch_paid`-style money movement, the
 * D77 shape, simply does not exist in E02: transmission is the cloud tier`s, not a verb here.
 *
 * DELIBERATELY NOT HERE, so the omissions are on the record rather than forgotten:
 * `delete_saved_view` destroys a display preference and no record; `folders_delete` only ever
 * deletes an EMPTY folder that `folders_upsert` recreates exactly; `files_set_retention` refuses to
 * shorten below the statutory floor and a manual extension can be lowered again, so leg (a) does not
 * hold; `archive_role` strips nothing from its holders (`resolveCapabilities` does not consult
 * `archived`); `disable_automation_rule` and `archive_automation_rule` are the STOP directions and
 * must stay automatable or the denylist becomes a blanket; `send_invoice` is the automation
 * showcase itself (issue, then send); `create_bank_account` mints a NEW register row and repoints
 * nothing that exists, so leg (f) does not hold (and the row it mints has never been told to a
 * counterparty); `update_company_profile` alters what an invoice SAYS (name, UID, MWST number),
 * never where money goes; and `account_set_tax_default` defaults a tax code onto future postings,
 * which alters figures a reversible posting carries, not a destination.
 */
export const NOT_AUTOMATABLE: ReadonlySet<string> = new Set([
  // (a) irreversible
  'contacts_merge',
  'contacts_anonymise',
  'delete_account',
  'delete_cost_center',
  'delete_draft',
  'delete_item',
  'item_categories_delete',
  'price_lists_delete',
  'price_lists_unset_price',
  'files_delete',
  // (a) E01: a hard delete of a sign-request draft with no reversing verb. Everything else E01
  // ships stays automatable per its §6b (`sign_requests_create` through `sign_requests_withdraw`
  // are its ACCEPTED actions: an accepted quote can drop a signature request unattended), and the
  // one outbound verb, `sign_requests_send`, carries its own P8 confirm gate INSIDE the verb, so a
  // rule that fires it still stops at the draft; no automation bypasses the approval dial.
  'sign_requests_delete_draft',
  // (a) B01: a hard delete of a working-time row with no reversing verb, and the row is an ArG
  // Art. 46 record while it lives. The engine already refuses past `submitted`, so what this entry
  // denies is a stored template erasing not-yet-frozen hours at 03:00. Everything else B01 ships
  // stays automatable per its §6b (`time_approve`, `time_lock`, `rate_card_upsert`,
  // `rate_card_end` are its ACCEPTED actions; a firing still runs against the rule author's A24,
  // so a rule cannot approve what its author could not).
  'time_delete',
  'close_year',
  // (b) statutory acts a human owns
  'vat_mark_filed',
  'vat_saldo_declaration_basis',
  'unlock_period',
  // (b) A25: the Treuhänder's sign-off on a checked entry. It discharges no statute by itself, but
  // it is the judgment the A03 lock and the filing exports then stand on, and a stored template
  // approving entries at 03:00 is exactly the "self-review fails toward whatever fired last"
  // failure the review layer exists to prevent. `comment_entry`, `flag_entry` and `prepare_period`
  // stay automatable (metadata that can only ever ADD a question, never settle one); the three
  // `export_*` tools are READS, which the fire path refuses structurally.
  'approve_entry',
  // (c) who may act
  'revoke_member',
  'set_role',
  'define_role',
  'invite_member',
  // (c) applied to a money JUDGMENT (D77, 31.07.2026, answering the A21 critic's F1/F2). Both
  // verbs carry a `confirmed` field, and a stored rule's `action_input` is caller input: a rule
  // author could write `confirmed: true` once and the gate would never bind again, settling a
  // medium-confidence match, or reversing a human's settlement and repointing the money onto
  // another debtor, unattended, triggered by the very event that says a human must look. D77's
  // line: a SEND confirmation dispatches an artefact whose content the invariants bound (D70:
  // `send_invoice` and `send_dunning_run` stay automatable, the rule author owns the outcome),
  // while a JUDGMENT confirmation decides a question the engine itself scored as undecided, about
  // whose money arrived. Only the second is denied. Unattended matching rides exclusively the
  // capability's own designed path: the auto-apply dial, which takes live `high` scores only and
  // is itself denied below.
  'apply_qr_match',
  'override_qr_match',
  // (c) A18's own judgment confirmation, the same D77 shape one capability over. `mark_batch_paid`
  // carries `confirmation:true`, and what it asserts is not a stored predicate but "the bank actually
  // executed this transfer", a fact no rule's condition over stored fields can know. A stored
  // `action_input` could set `confirmation:true` once and settle every future batch unattended,
  // posting outgoing payments with nobody having looked at a bank statement. `create_payment_batch`
  // and `generate_pain001` stay automatable (§6b): neither posts, and generating is the dispatch a
  // human then reviews before the confirm, exactly D77's "dispatch confirmation" half.
  'mark_batch_paid',
  // (c) A33, EBICS bank channel (spec §5/§6b, tripwire 4). `payment_batch_transmit` moves REAL-WORLD
  // money to the bank: it must never fire from a stored predicate, the exact reasoning `mark_batch_paid`
  // gives one line up. `bank_channel_connect` and `bank_channel_disconnect` are a key ceremony and its
  // emergency stop, deliberate and rare human acts that assert a comparison against a paper letter only
  // a human holds. `bank_sync` stays OFF this list deliberately (§6b): it is idempotent, non-posting,
  // and scheduled egress to the bank from a G01 rule is the whole point of the "daily sync" story, the
  // ONE and only network-egress verb on this surface a rule may fire.
  'payment_batch_transmit',
  'bank_channel_connect',
  'bank_channel_disconnect',
  // (d) outside the tenant
  'create_workspace',
  'bootstrap_workspace',
  // A23's composite onboarding is leg (d) verbatim: pre-workspace, so `evaluateAndFire`'s tenant
  // overwrite binds nothing and a rule naming it would mint tenants (and seat owners in them)
  // outside the workspace it lives in. `archive_workspace` stays OFF this list deliberately: it is
  // a reversible per-tenant state flip the §H-TENANT overwrite fully binds, and A23 §6b names it an
  // accepted automation action.
  'onboard_client',
  'accept_invite',
  // (d) G04: `restore_backup` is pre-workspace (it MINTS the tenant, the `create_workspace` shape), so
  // `evaluateAndFire`'s §H-TENANT overwrite binds nothing and a rule naming it would mint a whole
  // workspace outside the one the rule lives in. Spec §6b fixed states it explicitly ("no OP8 rule may
  // name restore_backup"): minting a new workspace is a human act, and it is P8-staged besides.
  // `create_backup` and `export_workspace` stay automatable (spec §6b: scheduled backups are the
  // worked example); both are §H-TENANT-bound writes that add nothing to the ledger. `delete_backup`
  // stays automatable too (housekeeping over a file with no retention lock). `verify_backup` and
  // `get_api_catalog` are READS the fire path refuses structurally.
  'restore_backup',
  // (d) F02: `portal_quote_accept` is a pre-workspace TOKEN verb (the `accept_invite` shape): it takes
  // no `workspaceId`, so `evaluateAndFire`'s tenant overwrite binds NOTHING, and a rule naming it would
  // act on a grant's own workspace through a token, outside the workspace the rule lives in, ungated
  // (a pre-workspace verb resolves no capability). It authenticates by a single-use token a rule's
  // stored `action_input` cannot meaningfully hold anyway. `portal_grant_create`, `portal_grant_send`
  // and `portal_grant_revoke` stay automatable (spec §5/§6b names all three as accepted rule actions):
  // create mints a reversible draft grant (P8), send transmits NOTHING in the OSS core (OP4) and only
  // activates it, and revoke is a STOP direction (the `disable_automation_rule` reasoning). `portal_resolve`
  // is a READ the fire path refuses structurally.
  'portal_quote_accept',
  // (a)+(c) F03: a vendor grant's SCOPE is a revDSG Art. 6 data-minimisation decision (who may see a
  // supplier's own POs and payment status, and for how long), which spec §6b reserves for a human or
  // an explicit agent call, never a stored predicate firing at 03:00. `vendor_portal_grant` mints
  // that access and `vendor_portal_revoke` ends it; neither is an accepted automation action here
  // (spec §6b: "vendor_portal_grant and vendor_portal_revoke are deliberately not accepted automation
  // actions"). This diverges DELIBERATELY from F02, whose `portal_grant_create`/`portal_grant_revoke`
  // stay automatable: F03 makes a different data-minimisation call for the creditor audience and says
  // so. `vendor_portal_remittance_create` is NOT here: it is F03's ONE accepted automation action (the
  // §6b worked example), non-posting by construction and artifact-and-stop. The two token reads
  // (`vendor_portal_pos`, `vendor_portal_remittances`) are READS the fire path refuses structurally.
  'vendor_portal_grant',
  'vendor_portal_revoke',
  // (e) self-administration of the unattended subsystem
  'create_automation_rule',
  'update_automation_rule',
  'enable_automation_rule',
  'run_due_automations',
  'retry_automation_run',
  // (e) continued: A12's unattended generator (see the module note above; D66 keeps pause/resume/end out)
  'create_recurring_schedule',
  'update_recurring_schedule',
  'run_due_recurring',
  // (e) continued: B04's retainer tick, the `run_due_recurring` shape one capability over.
  // `retainer_run_due` re-drives a bulk generation loop over every active retainer, minting draft
  // invoices unattended, which is a human-or-cron act (the same leg D50 gated the automation and
  // recurring ticks for). `retainer_generate_invoice` and `retainer_close` stay automatable, exactly
  // as spec §5 states: a single-period generate is bounded and idempotent per period (the fee-draw
  // guard), and close is a stop button; create/update stay automatable as reversible configuration.
  'retainer_run_due',
  // (e) A21's auto-apply dial is a second unattended-money gate beside P8's rule approval: a rule
  // that can switch it ON lets a later `apply_qr_match` firing move money with no live `high`
  // score confirmation from any human, which is `enable_automation_rule` by another name.
  'set_qr_auto_apply',
  // E04's ALL THREE writes, by the cluster's own §6b inversion rather than by one of the six legs:
  // zero-egress specs are "fixed unless provably leak-safe", and E04 declares that
  // `automation_rules.action` may target NO `mail_*` write, because `mail_draft_write` sits one
  // hop from a channel that could transmit if any future action wrapped it carelessly, and the
  // only fully honest answer is not to expose the hook rather than to trust every action author
  // forever. `mail_connect` points TILL at Art. 321 material (a rule must never widen what is
  // indexed) and `mail_reindex` re-walks that material unattended; both are denied with it so the
  // cluster's automation surface is empty rather than merely narrow. E04 also emits NO automation
  // trigger event, so there is nothing mail-shaped to fire ON either. No data migration
  // accompanies these entries: the verbs land in the same commit, so no stored rule can predate
  // their denial. The four `mail_*` reads are READS the fire path refuses structurally.
  'mail_connect',
  'mail_reindex',
  'mail_draft_write',
  // E05's BOTH writes, the E04 §6b inversion one module over: `voice_build` re-reads the Art. 321
  // corpus and re-learns the voice unattended (a rule must never widen or refresh what the model
  // has been shown without a human deciding to), and `runtime_select` changes WHICH model produces
  // every future draft, which is exactly the agent-initiated change P8 exists to keep a human in
  // front of (spec §5 keeps `runtime.register` off the wire for the same reason). E05 emits no
  // automation trigger event either, so the cluster's automation surface stays empty rather than
  // merely narrow. The five `voice_*`/`runtime_*` reads are READS the fire path refuses
  // structurally.
  'voice_build',
  'runtime_select',
  // E06's BOTH writes, closing the cluster's §6b inversion: `draft_generate` delegates to the very
  // `writeMailDraft` whose denial two entries up this posture rests on, so a rule allowed to fire
  // the wrapper would make that entry decorative, and `draft_regenerate` is the same act again.
  // The E06 spec's original automation bullets were reconciled OUT on this ground (spec §6b,
  // 2026-08-05): the nightly-drafts use case runs as an AGENT calling `draft_generate` over MCP
  // under its own session, RBAC and the consent asymmetry, never as a stored template firing at
  // 03:00. E06 emits no automation trigger event either, so the cluster's automation surface stays
  // empty rather than merely narrow. The one E06 read is a READ the fire path refuses structurally.
  'draft_generate',
  'draft_regenerate',
  // (f) alters a payment destination (D65)
  'set_creditor_profile',
  'update_bank_account',
  'set_creditor_bank_profile',
  // (b) A22's period-end statutory valuation. `post_fx_revaluation` posts the OR Art. 960a
  // closing-rate revaluation of every open FC position and dates its own auto-reversal: a period-end
  // Bilanzstichtag act a human owns and confirms per occasion (Pattern P8, spec §6b), never a
  // template firing unattended at 03:00. `record_exchange_rate` stays automatable as §6b's accepted
  // action (a rule may feed a rate in); posting the revaluation off it is the step that is withheld,
  // the same shape A19 withholds `set_bank_opening_balance` from automation.
  'post_fx_revaluation',
  // (b) A34: `wage_journal_post` posts the month's aggregate wage journal into the live ledger
  // through A02 `postEntry`, a period-end statutory booking a human owns and confirms per occasion
  // (Pattern P8), never a template firing unattended at 03:00 (spec §5: "an auto-firing wage posting
  // is exactly the kind of unattended money write the P8 dial exists to prevent"). The
  // `post_fx_revaluation` / `approve_entry` shape. `payroll_handoff_export` stays automatable (a local
  // artifact, no posting) and `list_payroll_handoffs` is a read the fire path refuses structurally.
  'wage_journal_post',
  // (e) A26's own oversight surface is the safety rail, and a rail a rule can operate is no rail.
  // `set_agent_dial` arms or disarms unattended agent execution: a rule flipping it to `auto` would
  // let the safety valve disable itself (§6b Fixed, verbatim). `approve_drafted_action` holds an
  // `ActionInvoker` and IS the second-actor review that makes draft-and-ask mean anything: a rule
  // firing it would collapse that separation, approving drafts with nobody looking. `reject_drafted_action`
  // is the other half of the same human decision on the inbox, and letting a rule silently discard
  // drafted actions would hide the agent's proposals from the person meant to see them. All three are
  // owner-only (`manage_agent_dial`) anyway, so only an owner-authored rule could ever reach them,
  // which is exactly the case this denial closes.
  'set_agent_dial',
  'approve_drafted_action',
  'reject_drafted_action',
  // (e) A35's two human-side writes over the same surface. `agent_ask` is a person speaking to their
  // books through the composer: a rule asking questions on a schedule would manufacture conversation
  // turns nobody had, polluting the one record meant to show what actually happened. `agent_prose_delete`
  // erases the user's own words (D90 D-5): an unattended eraser of a conversation record is the exact
  // opposite of an oversight surface.
  'agent_ask',
  'agent_prose_delete',
  // (b)+(c) G09, the migration harness. Committing a foreign book into the real ledger, reversing
  // it, or discarding a migration are human acts, mirroring D65/D77 and G04 §6b's exclusion of
  // restore_backup. `migration_commit_step` posts the opening position into the live books (leg b,
  // a statutory Eröffnungsbilanz a human owns); `migration_record_approval` IS the human sign-off
  // that gates a money-path commit, and a stored rule approving its own check hash at 03:00 is the
  // "self-review fails toward whatever fired last" failure the approval exists to prevent (leg c on
  // a money judgment, the A25 `approve_entry` shape one family over); `migration_rollback_step`
  // posts reversing entries against the live ledger and `migration_abandon_plan` discards a plan
  // that has moved the books. `migration_create_plan`, `migration_set_scope` and
  // `migration_trial_load_step` stay automatable (§6b: a rule that trial-loads a plan on `planned`
  // is the plausible one): none touches the live books, trial-load writes only the Testmandant.
  'migration_commit_step',
  'migration_record_approval',
  'migration_rollback_step',
  'migration_abandon_plan',
  // G18 R4: `migration_close_plan` moves a plan live -> closed, the recorded human judgment that the
  // übernahme is finished (US-G18.6). A rule closing a plan at 03:00 would declare a cutover done
  // that no person confirmed: it is the same class as commit/rollback/abandon above (a human act with
  // a confirm gate), and a denied verb cannot be an automation action.
  'migration_close_plan',
  // G11 Eröffnungsprüfung. `migration_declare_control_total` states what the OLD SYSTEM said, the
  // Inventar of the opening position (OR 958c Abs. 2): a stored rule declaring expectations
  // unattended would manufacture the very evidence the check exists to demand, the leg-c shape
  // `migration_record_approval` above already names, and US-G11.5 gives the story to the operator
  // personas alone. `migration_waive_control` IS the human judgment that sets a control aside: a
  // rule waiving controls at 03:00 is a silent waiver with a stored excuse, and a silent waiver is
  // a deleted control (spec §6b Fixed). `migration_check_step` deliberately STAYS automatable:
  // re-running a check is safe and idempotent, and spec §6b names it as the accepted automation
  // action (a rule that re-checks a plan nightly can only surface facts, never assert or bury one).
  'migration_declare_control_total',
  'migration_waive_control',
  // G21 open-items migration. `import_open_items` posts an opening AR/AP position into the live books
  // as origin=migrated documents/bills (leg b, the statutory Eröffnungsbilanz a human owns, the
  // `migration_commit_step` reasoning): a rule importing an opening position unattended is the exact
  // failure the commit gate exists to prevent. `preview_open_items` STAYS automatable (it writes
  // nothing; re-previewing a batch can only surface facts, the `migration_check_step` shape).
  'import_open_items',
  // G13 GL archive (spec §5/§6b). `gl_archive_purge` destroys records: even lawfully, after the
  // OR 958f retention has run out, destruction is a HUMAN act with a recorded reason, the exact
  // shape of G04's excluded restore_backup one family over; a rule purging history at 03:00 is
  // the failure the confirm gate exists to prevent, and a denied verb cannot be its action.
  // `gl_archive_import` is denied for the same reason its G09 twin is: the archive arrives through
  // `migration_commit_step` (denied above, leg b/c), and letting a rule call the import DIRECTLY
  // would be a side door around that commit gate. G13 accepts no automation actions at all (§6b);
  // its two events (`migration.archive_imported` / `migration.archive_purged`) are for REACTING.
  'gl_archive_import',
  'gl_archive_purge',
  // G12 Testmandant (spec §5/§6b). `go_productive` mints real books out of a trial, the least
  // reversible act in the product, and `discard_testmandant` hard-deletes a workspace: both are
  // HUMAN acts, the exact shape of G04's excluded restore_backup one family over (D65's principle).
  // A rule going productive or discarding a trial at 03:00 is the failure the type-to-confirm and the
  // confirm gate exist to prevent. `migration_create_testmandant` deliberately STAYS automatable
  // (spec §6b): a rule that provisions a Testmandant on a `planned` plan only creates a disposable
  // workspace, it asserts nothing and destroys nothing.
  'go_productive',
  'discard_testmandant',
  // G03 (spec §6b): the demo pair. `create_demo_workspace` is leg (d) verbatim (pre-workspace, no
  // `workspaceId`, so `evaluateAndFire`'s tenant overwrite binds nothing and a rule naming it would
  // mint tenants outside the workspace it lives in, the `create_workspace`/`onboard_client` shape).
  // `discard_demo_workspace` hard-deletes a workspace: the `discard_testmandant` reasoning verbatim,
  // a human evaluation act behind a confirm gate, never a stored predicate firing at 03:00.
  // `advance_onboarding_step` deliberately STAYS automatable: an absolute GUI resume pointer that
  // asserts nothing, destroys nothing and gates nothing.
  'create_demo_workspace',
  'discard_demo_workspace',
  // (a) B00's hard delete, the `delete_item` shape: a draft project (and its draft phases) erased
  // with no reversing verb. Every other B00 write stays automatable, which is spec §6b's accepted
  // list (`project_update`, `project_set_status`, `project_phase_add`, `project_phase_done`) plus
  // the harmless `project_create`: a status change is reversible through the machine itself and the
  // reopen leg is A24-gated and audit-logged, so a rule cannot move anything a human cannot see and
  // undo.
  'project_delete',
  // (b) D01's period-end statutory acts (spec §5/§6b), the `post_fx_revaluation` shape. `stock_run_valuation`
  // posts the OR Art. 960c inventory delta through A02 at a Bilanzstichtag and reverses the prior run:
  // a human owns and confirms the valuation per occasion (P8), never a template at 03:00.
  // `stock_stocktake_commit` seals the OR 958c Abs. 2 Bestandesnachweis and mints the counted
  // adjustments: the count is a physical human act, and a rule committing it would file an Inventar
  // nobody performed. Every other D01 write stays automatable (§6b): `stock_move` and
  // `stock_location_upsert` are the accepted actions, so a low-stock rule can draft a movement.
  'stock_run_valuation',
  'stock_stocktake_commit',
  // J04's enhanced stocktake commit, the `stock_stocktake_commit` shape exactly: it seals the OR 958c
  // Abs. 2 Bestandesnachweis and mints every counted variance as an OP13 / J02 adjustment. The count
  // is a physical human act, so a rule committing it unattended would file an Inventur nobody
  // performed and move on-hand no person confirmed. Every OTHER J04 write STAYS automatable (an agent
  // may open a cycle-count session, record counts and request a recount from a scanner feed): only the
  // commit, the one act that mints stock and files the statutory count, belongs to a person.
  'inventory_stocktake_commit',
  // (b)+(c) D02's 3-way match (spec §5/§6b, tripwire #3). `match_bill` is the money-judgment control
  // activity of purchasing: matching a Vorsteuer-bearing vendor bill against what was ordered and
  // received, with an `override` that FORCES a match past the tolerance gate. A stored rule's
  // `action_input` is caller input, so a rule author could set `override:true` once and settle every
  // future over-tolerance bill unattended, which is exactly the internal control the whole module
  // exists to provide (the A25 `approve_entry` / A21 `apply_qr_match` shape one family over). It is
  // excluded from OP8's accepted-actions allowlist by name: D02 accepts only `po_send`,
  // `receipt_record`, `po_close_short` and `po_cancel` as rule actions (all reversible, none a money
  // judgment), and the override additionally needs `post` INSIDE the engine, which a firing runs
  // against the rule author's A24 but which the denylist forecloses before that even matters.
  'match_bill',
  // (b) I02's reversal (owner decision, 11.08.2026), the `stock_stocktake_commit` shape one family
  // over. `goods_receipt_reverse` is the ONE I02 verb that REMOVES quantity that was already
  // recognised: it writes compensating J02 movements, negative trail rows and a `received_qty`
  // rollback, and it is the only I02 write whose effect a later reader cannot distinguish from
  // "the goods never arrived". A stored predicate firing that at 03:00 would silently un-receive
  // stock a human had already accepted, and the refusal it depends on (`line_already_billed`) only
  // covers the case where I04 got there first.
  //
  // Every OTHER I02 write deliberately STAYS automatable, and that is the point of the capability
  // rather than an oversight: agent-native receiving from an ASN feed, a scanner event or a supplier
  // portal is US-I02.6, and each of those acts is self-correcting. `goods_receipt_create` and
  // `_upsert_lines` touch no stock at all (a draft is inert), `_post` and `_accept_lines` ADD
  // quantity that a human can see on the receipt and undo through this very verb, `_reject_lines`
  // and `_cancel` remove nothing that ever existed, and `_set_config` is plain policy. The
  // asymmetry is exactly the one the D01 pair draws: a rule may draft and record a movement, but the
  // act that walks a recognised quantity back belongs to a person.
  'goods_receipt_reverse',
  // (b) I03's confirm and reverse (the `match_bill` / `goods_receipt_reverse` shape). Confirming a
  // landed-cost allocation POSTS a balanced A02 entry that lifts the inventory figure on the balance
  // sheet and decides what enters OR 960 acquisition cost: a money judgment a stored rule must not
  // make at 03:00 (the same class as `match_bill`, which also needs `post` inside the engine). Its
  // reverse walks that posting back and is the one act whose effect a later reader cannot distinguish
  // from "the cost was never capitalised" (the `goods_receipt_reverse` reasoning). The DRAFT verbs
  // (`landed_cost_voucher_create` and the reads) touch no money and stay automatable, so an
  // agent-native pipeline can still collect the costs and propose the allocation a human confirms.
  'landed_cost_allocate_confirm',
  'landed_cost_reverse',
  // (f)+(e) M02's two publish dials, the egress-consent shape one family over from `set_creditor_profile`
  // and `set_agent_dial`. `sync_publish_enable` turns ON any egress of the ledger from the local file
  // (the one act that starts the publish stream leaving the machine), and `sync_publish_disable` is its
  // emergency stop: a rail a rule can operate is no rail, so neither may fire from a stored predicate.
  // Enabling is a workspace-owner CONSENT act (§I, spec §6b Fixed: publishing default OFF, egress is
  // consent), and letting a rule flip it at 03:00 would falsify the local-first posture for an install
  // whose owner never chose to publish. Both are owner-only (`manage_sync`) anyway, so only an
  // owner-authored rule could ever reach them, which is exactly the case this denial closes. The four
  // stream READS (`get_sync_contract`, `sync_stream_read`, `sync_artifact_read`, `sync_stream_status`)
  // are reads the fire path refuses structurally.
  'sync_publish_enable',
  'sync_publish_disable',
  // (b)+(a) G20 implementation projects (spec §5/§6b). `implementation_signoff_record` is the HUMAN
  // half of an act: every sign-off kind (conversion_date, go_nogo, rollback_trigger, source_cancellation,
  // ...) is a person's signature the safety case rests on, so a rule signing at 03:00 would forge the
  // one thing the agent/human split exists to keep human (the `migration_record_approval` leg-c/b shape).
  // `implementation_project_close` seals the implementation as finished, requiring the Stabilisierung
  // exit and the closing sign-offs: a rule closing a project would declare a cutover done that no person
  // confirmed (the `migration_close_plan` reasoning one family over). A denied verb cannot be an
  // automation action. Every OTHER G20 write STAYS automatable (§6b): a rule may instantiate the runbook
  // when a project is created, set a task, record a decision, declare figures or re-run a parallel check,
  // because none signs, closes or moves money.
  'implementation_signoff_record',
  'implementation_project_close',
  // (e)+(a) N00, the environment landscape (D126). All four env_* writes administer the host-level
  // landscape, the leg-(e) shape (`set_agent_dial` / `sync_publish_enable` one register over: a rail a
  // rule can operate is no rail). `env_reset` and `env_delete` are additionally leg (a): a reset
  // rebuilds a data root and a delete removes one, and a rule firing either at 03:00 would silently
  // wipe an environment, the exact failure the concept names ("a scheduled agent must never silently
  // wipe an environment"). `env_create` provisions a data root and `env_switch` redirects the whole
  // face to a different environment: both reshape the landscape unattended. All four still EMIT their
  // events above, so a rule may react to a landscape change (e.g. a notification) without being able
  // to cause one, the `go_productive` / `mark_batch_paid` shape. `env.copy` and its overrides land on
  // this list in Phase B. No data migration accompanies these: the verbs land in the same commit, so
  // no stored rule can predate their denial.
  'env_create',
  'env_switch',
  'env_reset',
  'env_delete',
  // env_copy (Phase B) and its overrides: a rule that fired a copy at 03:00 would move real client data
  // across a trust boundary unattended (and, with the owner-only retain override, live access secrets).
  // Denylisted like its siblings; a "skill/workflow from us" still invokes it interactively under the
  // owner`s seat. It EMITS `environment.copied` (events.ts), so a rule may react to a copy, never cause one.
  'env_copy',
]);

/** Is `tool` a verb a rule may never name as its action? */
export function isNotAutomatable(tool: unknown): boolean {
  return typeof tool === 'string' && NOT_AUTOMATABLE.has(tool);
}
