/**
 * The AUTOMATION EVENT REGISTRY (§H-ENUM): every moment a rule may trigger on.
 *
 * THIS TABLE IS THE WHOLE OF WHAT A FUTURE CAPABILITY DOES TO MAKE ITS EVENTS TRIGGERABLE. One row,
 * four facts, and the moment is available to every rule in the product with no further code anywhere.
 * Nothing in `fire.ts`, `rules.ts`, `condition.ts` or `tick.ts` switches on an event, a capability or
 * a table name, and if a future change ever needs one of them to, that is the signal the design went
 * wrong rather than a licence to add a case. This is G00's `ENTITY_KINDS` argument applied to the
 * other half of the automation problem.
 *
 * AND WHAT A FUTURE CAPABILITY DOES TO MAKE ITS VERBS ACTIONABLE IS NOTHING AT ALL. The legal set of
 * actions IS the write half of `ACTIONS`, so a verb is a legal action the instant it is registered,
 * gated by whatever `CAPABILITY_FOR_ACTION` already says about it. There is no allow-list here to
 * maintain and no second enumeration to forget. `registerWriteActions` below receives that set from
 * the registry at module load rather than importing it, which is what keeps the module graph acyclic:
 * `src/api/registry.ts` imports this file and this file must never import it back.
 *
 * `emittedBy` NAMES A WRITE VERB BECAUSE THE HOOK LIVES IN THE SHARED DISPATCH. The spec had all 44
 * emitting verbs call the dispatcher themselves; that is 44 edits, 44 chances to forget one, and it
 * would run the automation INSIDE the emitting verb's transaction, where a failing rule rolls back the
 * invoice that triggered it. The dispatch fires the hook once, after any write verb returns ok, which
 * is after its transaction has committed. See the module note in `fire.ts`.
 *
 * `entityIdPath` IS RESOLVED AGAINST `{ input, result }` and it is what makes the occurrence key
 * stable. `invoice.issued` for invoice X is ONE occurrence however many times the write is redelivered,
 * because both deliveries resolve the same id and therefore the same `event_ref`.
 */

/** One triggerable moment. Four facts, and adding a fifth row is the entire opt-in. */
export interface AutomationEventDef {
  /** The stable id used on the wire as `trigger.event`. */
  readonly event: string;
  /** The registered WRITE verb whose success emits this event. */
  readonly emittedBy: string;
  /** The OP3 entity kind the payload is about, for a condition reading custom fields. */
  readonly entityKind?: string;
  /** Dot path into `{ input, result }` naming the entity this occurrence is about. */
  readonly entityIdPath: string;
}

/**
 * The registry, grouped by the capability that owns each row.
 *
 * Every row here was checked against the verb's real payload rather than against its spec: an
 * `entityIdPath` that resolves to undefined would silently collapse every occurrence of that event
 * onto one `event_ref` and fire a rule exactly once, ever. `test/api/*` proves each path resolves.
 */
export const AUTOMATION_EVENTS: readonly AutomationEventDef[] = [
  // --- A02, the double-entry journal -----------------------------------------------------------
  { event: 'journal.posted', emittedBy: 'post_entry', entityKind: 'journal_entry', entityIdPath: 'result.entryId' },
  { event: 'journal.reversed', emittedBy: 'reverse_entry', entityKind: 'journal_entry', entityIdPath: 'input.entryId' },

  // --- A03, periods ----------------------------------------------------------------------------
  { event: 'period.closed', emittedBy: 'close_month', entityIdPath: 'input.period' },
  { event: 'period.reopened', emittedBy: 'reopen_month', entityIdPath: 'input.period' },

  // --- A07, MWST -------------------------------------------------------------------------------
  { event: 'vat.period_filed', emittedBy: 'vat_mark_filed', entityIdPath: 'input.period' },

  // --- A09, contacts & items -------------------------------------------------------------------
  { event: 'contact.created', emittedBy: 'create_contact', entityKind: 'contact', entityIdPath: 'result.contact.id' },

  // --- A10/A11, documents and invoices ---------------------------------------------------------
  { event: 'document.created', emittedBy: 'create_document', entityKind: 'document', entityIdPath: 'result.document.id' },
  { event: 'invoice.issued', emittedBy: 'issue_invoice', entityKind: 'document', entityIdPath: 'input.invoiceId' },
  { event: 'invoice.sent', emittedBy: 'send_invoice', entityKind: 'document', entityIdPath: 'input.invoiceId' },
  // A13 (spec §5): the `invoice.issued` pattern. A `credit_note.cancelled` event is DEFERRED with
  // A10's cancel event: cancellation rides the shared transition_document, which emits none today.
  { event: 'credit_note.issued', emittedBy: 'issue_credit_note', entityKind: 'document', entityIdPath: 'input.creditNoteId' },

  // --- A32, eBill issuing (spec §5) ------------------------------------------------------------
  // TWO of the four spec events register here, and only two: the automation dispatch keys an event to
  // a registered WRITE verb (module note above), and `ebill.rejected`/`ebill.completed` fire from
  // `mirrorEbillPartnerStatus`, the connector-facing seam that is deliberately NOT a registered verb
  // (spec §4). They ride the cloud connector's mirror seam, not the OSS-core write dispatch, exactly as
  // A13's `credit_note.cancelled` is deferred; they land with the connector. Both paths below were
  // checked against the verb's REAL payload: `ebill_prepare` answers `{ delivery: { id, ... } }` so
  // `result.delivery.id` resolves (a re-prepare returns the existing active row's id, one occurrence);
  // `ebill_transmit` answers `transmittedDeliveryId`, which is the delivery id ONLY on a real transmit
  // and NULL on the cloud_tier no-op / needs_confirmation / failure, so the honest OP4 degradation
  // emits no `ebill.transmitted` occurrence (the `dunning.proposed` null-collapse, used deliberately).
  { event: 'ebill.prepared', emittedBy: 'ebill_prepare', entityKind: 'ebill_delivery', entityIdPath: 'result.delivery.id' },
  { event: 'ebill.transmitted', emittedBy: 'ebill_transmit', entityKind: 'ebill_delivery', entityIdPath: 'result.transmittedDeliveryId' },

  // --- A14, payments ---------------------------------------------------------------------------
  { event: 'payment.recorded', emittedBy: 'record_payment', entityKind: 'payment', entityIdPath: 'result.paymentId' },
  { event: 'payment.reversed', emittedBy: 'reverse_payment', entityKind: 'payment', entityIdPath: 'input.paymentId' },

  // --- A17, vendor bills -----------------------------------------------------------------------
  // FOUR ROWS FOR FOUR WRITE VERBS, because this registry keys an event to exactly ONE emitting verb.
  // A17's spec named three events and has four writes that a rule could sensibly react to; folding
  // `record_expense` onto `vendor_bill.drafted` would have made the auto-post-under-threshold rule fire
  // against a bill that is already posted, so the one-shot path gets its own moment.
  //
  // Every `entityIdPath` below was checked against the verb's REAL payload rather than its spec:
  // `create_vendor_bill` answers `{ vendorBillId, vendorBill }`, and the other three answer
  // `{ vendorBillId, ... }`, so `result.vendorBillId` resolves for all four. A path that resolved to
  // undefined would collapse every occurrence onto one `event_ref` and fire a rule exactly once, ever.
  { event: 'vendor_bill.drafted', emittedBy: 'create_vendor_bill', entityKind: 'vendor_bill', entityIdPath: 'result.vendorBillId' },
  { event: 'vendor_bill.recorded', emittedBy: 'record_expense', entityKind: 'vendor_bill', entityIdPath: 'result.vendorBillId' },
  { event: 'vendor_bill.posted', emittedBy: 'post_vendor_bill', entityKind: 'vendor_bill', entityIdPath: 'input.vendorBillId' },
  { event: 'vendor_bill.voided', emittedBy: 'void_vendor_bill', entityKind: 'vendor_bill', entityIdPath: 'input.vendorBillId' },

  // --- A15, dunning ----------------------------------------------------------------------------
  // Three rows for the three lifecycle moments. Every `entityIdPath` below was checked against the
  // verb's REAL payload rather than its spec: `propose_dunning_run` answers `{ runId, ... }` (and a
  // nothing-overdue propose answers `runId: null`, which resolves to null and emits no occurrence,
  // exactly right: an empty proposal is a non-event); issue and send both take `runId` as input.
  { event: 'dunning.proposed', emittedBy: 'propose_dunning_run', entityKind: 'dunning_run', entityIdPath: 'result.runId' },
  { event: 'dunning.issued', emittedBy: 'issue_dunning_run', entityKind: 'dunning_run', entityIdPath: 'input.runId' },
  { event: 'dunning.sent', emittedBy: 'send_dunning_run', entityKind: 'dunning_run', entityIdPath: 'input.runId' },

  // --- A21, QR incoming matching ---------------------------------------------------------------
  // Three rows for the three decision moments (spec §5). `needs_review` rides the RECORD verb and
  // resolves from `result.needsReviewCreditId`, which the engine sets null for a `high`-scored
  // credit, so a credit the machine is confident about emits no review occurrence (the
  // `dunning.proposed` null-collapse, used deliberately). Apply and override resolve from input:
  // both verbs require `creditId`.
  { event: 'qr_match.needs_review', emittedBy: 'record_incoming_credit', entityKind: 'reconciliation_match', entityIdPath: 'result.needsReviewCreditId' },
  { event: 'qr_match.applied', emittedBy: 'apply_qr_match', entityKind: 'reconciliation_match', entityIdPath: 'input.creditId' },
  { event: 'qr_match.overridden', emittedBy: 'override_qr_match', entityKind: 'reconciliation_match', entityIdPath: 'input.creditId' },

  // --- A20, camt reconciliation ------------------------------------------------------------------
  // A per-txn `bank_txn.needs_review` cannot ride `import_camt`, because the dispatch resolves ONE
  // entity id per firing and N unmatched txns would collapse onto one `event_ref` and fire once, ever
  // (the `events.ts` warning above, verbatim). A36 closed this at its root: the event rides A36's
  // dedicated `review_bank_txn` verb, one call per booked debit, resolving `result.needsReviewTxnId`
  // (null-collapsed like `qr_match.needs_review`, so a txn with a good proposal emits no occurrence).
  { event: 'bank_statement.imported', emittedBy: 'import_camt', entityIdPath: 'result.statementId' },
  { event: 'bank_txn.needs_review', emittedBy: 'review_bank_txn', entityKind: 'bank_txn', entityIdPath: 'result.needsReviewTxnId' },
  { event: 'bank_txn.matched', emittedBy: 'confirm_match', entityKind: 'bank_txn', entityIdPath: 'input.bankTxnId' },
  { event: 'bank_txn.booked', emittedBy: 'create_entry_for_txn', entityKind: 'bank_txn', entityIdPath: 'input.bankTxnId' },

  // --- A18, creditor payments ---------------------------------------------------------------------
  // Three rows for the three lifecycle moments (spec §6b): create_payment_batch and generate_pain001
  // are ACCEPTED automation actions (neither posts), mark_batch_paid is not (denylist.ts, the D77
  // judgment-confirmation leg) but still emits its own event so a rule can react to a batch being
  // paid (e.g. a notification) without being able to CAUSE the paying. Every path checked against the
  // verb's real payload: all three answer `{ batchId, ... }`, the createPaymentBatch/generatePain001
  // pair from `result.batchId`, mark_batch_paid's own input also carries `batchId`.
  { event: 'payment_batch.created', emittedBy: 'create_payment_batch', entityKind: 'payment_batch', entityIdPath: 'result.batchId' },
  { event: 'payment_batch.generated', emittedBy: 'generate_pain001', entityKind: 'payment_batch', entityIdPath: 'result.batchId' },
  { event: 'payment_batch.paid', emittedBy: 'mark_batch_paid', entityKind: 'payment_batch', entityIdPath: 'input.batchId' },

  // --- A33, EBICS bank channel (spec §5/§6b) --------------------------------------------------------
  // Four moments a rule may react to, each on a null-collapsing path (the deals `wonDef` shape) so an
  // occurrence fires ONLY on the real event: `bank_channel.activated` rides `bank_channel_connect` but
  // its path is `result.activatedConnectionId`, set only when the channel flips to active (every other
  // connect outcome collapses); `bank_channel.sync_completed` rides every successful `bank_sync`;
  // `payment_batch.transmitted` rides `payment_batch_transmit` on `result.transmittedBatchId`, set only
  // on a real upload (a needs_bank_channel/needs_bank_transport degrade collapses); `bank_rejected`
  // rides `bank_sync` on `result.rejectedBatchId`, set only when the sync folded a pain.002 rejection.
  { event: 'bank_channel.activated', emittedBy: 'bank_channel_connect', entityKind: 'ebics_connection', entityIdPath: 'result.activatedConnectionId' },
  { event: 'bank_channel.sync_completed', emittedBy: 'bank_sync', entityKind: 'ebics_connection', entityIdPath: 'result.connectionId' },
  { event: 'payment_batch.transmitted', emittedBy: 'payment_batch_transmit', entityKind: 'payment_batch', entityIdPath: 'result.transmittedBatchId' },
  { event: 'payment_batch.bank_rejected', emittedBy: 'bank_sync', entityKind: 'payment_batch', entityIdPath: 'result.rejectedBatchId' },

  // --- A22, FX revaluation (spec §5/§6b) -------------------------------------------------------
  // Two moments a rule may react to. `fx.rate_set` rides `record_exchange_rate` (the reconciled
  // canonical rate verb) and resolves from `result.rateId`, which the verb returns on both the fresh
  // and the idempotent-replay path. `fx.revaluation_posted` rides `post_fx_revaluation` and resolves
  // from `result.entryId`; a zero-diff period posts nothing and answers `entryId: null`, which
  // resolves to null and emits no occurrence (the `dunning.proposed` null-collapse, used
  // deliberately). No `entityKind` on either: the custom-field attachment surface for these entities
  // is G00's `ENTITY_KINDS` (spec §6b, declared not built here), so a condition reading a custom
  // field off the payload is deferred with it rather than pointed at an unregistered kind.
  { event: 'fx.rate_set', emittedBy: 'record_exchange_rate', entityIdPath: 'result.rateId' },
  { event: 'fx.revaluation_posted', emittedBy: 'post_fx_revaluation', entityIdPath: 'result.entryId' },

  // --- A23, multi-client workspaces ------------------------------------------------------------
  // TWO ROWS FOR ONE VERB, told apart by the RESULT PATH. `archive_workspace` covers both
  // directions through its `archived` boolean, and the engine puts the workspace id under
  // `archivedWorkspaceId` on an archive and `unarchivedWorkspaceId` on an unarchive, only ever one
  // of the two per call, so the other row's path resolves to nothing and emits no occurrence (the
  // `dunning.proposed` null-collapse, used deliberately). Both checked against the verb's REAL
  // payload in `src/core/setup/workspace.ts`. The verb's REQUIRED `idempotencyKey` is what keeps a
  // second genuine archive of the same mandate a second occurrence (the `close_month` argument in
  // `fire.ts`, verbatim: archive/unarchive is a repeatable pair on one entity id). There is
  // deliberately NO `workspace.created`: this registry keys an event to a registered verb, and no
  // A00 row exists; if one is ever wanted it is A00's row on `create_workspace`, not A23's.
  { event: 'workspace.archived', emittedBy: 'archive_workspace', entityKind: 'workspace', entityIdPath: 'result.archivedWorkspaceId' },
  { event: 'workspace.unarchived', emittedBy: 'archive_workspace', entityKind: 'workspace', entityIdPath: 'result.unarchivedWorkspaceId' },

  // --- A25, review & export --------------------------------------------------------------------
  // Four rows for the four write verbs; the exports are READS and can emit nothing (the dispatch
  // hook fires only on a write's success), and the lock moment belongs to A03's `lock_period`,
  // which emits no event today, so A25 does not mint one for a verb it does not own. Every
  // `entityIdPath` below was checked against the verb's REAL payload: comment/flag/approve answer
  // `{ reviewId, ... }`, and `prepare_period` keys its occurrence on the period it prepared, the
  // `period.closed` shape, so a re-prepare of one period is ONE occurrence however often it re-runs.
  { event: 'review.entry_commented', emittedBy: 'comment_entry', entityKind: 'entry_review', entityIdPath: 'result.reviewId' },
  { event: 'review.entry_flagged', emittedBy: 'flag_entry', entityKind: 'entry_review', entityIdPath: 'result.reviewId' },
  { event: 'review.entry_approved', emittedBy: 'approve_entry', entityKind: 'entry_review', entityIdPath: 'result.reviewId' },
  { event: 'review.period_prepared', emittedBy: 'prepare_period', entityIdPath: 'input.period' },

  // --- A26, agent bookkeeping (§6b: A26 emits, so a rule elsewhere can react) -------------------
  // The two inbox resolutions a rule may sensibly react to (e.g. notify when a drafted action is
  // executed or rejected). Both resolve from `input.actionId`, which both verbs require, so the
  // occurrence key is stable. A26 EMITS these but its own verbs are on the denylist, so a rule may
  // react to a resolution without being able to CAUSE one, the same shape A18's `payment_batch.paid`
  // uses. `agent_action.drafted` has no emitting verb (the enqueue is an engine seam the dial calls,
  // not a registered tool), so it is deliberately absent.
  { event: 'agent_action.executed', emittedBy: 'approve_drafted_action', entityKind: 'agent_action', entityIdPath: 'input.actionId' },
  { event: 'agent_action.rejected', emittedBy: 'reject_drafted_action', entityKind: 'agent_action', entityIdPath: 'input.actionId' },

  // --- G10, migration maps (spec §6b: OP8) ------------------------------------------------------
  // Two moments a rule may react to. `migration.map_completed` rides `migration_set_map` and
  // resolves from `result.completedMapId`, which the engine sets null while the map still has
  // blocking entries, so an incomplete save emits no occurrence (the `dunning.proposed`
  // null-collapse, used deliberately: the event names the COMPLETION, not the save).
  // `migration.template_applied` resolves from `input.templateId`, which the verb requires. Both
  // checked against the verbs' REAL payloads in `core/migration/maps.ts`. `entityKind` only on the
  // template event: `migration_map_template` is the OP3-registered kind; the map row is not
  // registered. The plausible rule (spec §6b) is "apply the house template when a plan is created",
  // and both of G10's non-template writes stay legal automation ACTIONS as well (see denylist.ts).
  { event: 'migration.map_completed', emittedBy: 'migration_set_map', entityIdPath: 'result.completedMapId' },
  { event: 'migration.template_applied', emittedBy: 'migration_apply_map_template', entityKind: 'migration_map_template', entityIdPath: 'input.templateId' },

  // --- G09, the migration harness (spec §6b: OP8) ----------------------------------------------
  // The moments a rule may react to whose emitter is a WRITE verb with a resolvable id. A rule that
  // trial-loads every class when a plan reaches `planned` is the plausible one (§6b). The spec's
  // other listed moments (`step_previewed`, `step_failed`, `step_diverged`, `plan_went_live`) are
  // NOT registered here: `preview` is a READ verb, and failure/divergence/go-live are DERIVED states
  // no single successful write verb emits, so registering them would break the "emittedBy names a
  // write verb whose success emits this" contract the whole table rests on. They arrive when a verb
  // that owns each transition does. `entityKind` sits only on the events about an OP3-registered kind
  // (`migration_plan`, `migration_step`), so a condition can read a custom field on the entity.
  { event: 'migration.plan_created', emittedBy: 'migration_create_plan', entityKind: 'migration_plan', entityIdPath: 'result.planId' },
  { event: 'migration.step_trial_loaded', emittedBy: 'migration_trial_load_step', entityKind: 'migration_step', entityIdPath: 'input.stepId' },
  { event: 'migration.step_committed', emittedBy: 'migration_commit_step', entityKind: 'migration_step', entityIdPath: 'input.stepId' },

  // --- G11 Eröffnungsprüfung (spec §6b: OP8) ---------------------------------------------------
  // Three moments a rule may react to (notify the Treuhänder on a clean check, page someone on a
  // failed one, surface every waiver). `check_clean` and `check_failed` both ride
  // `migration_check_step` and resolve through the dunning.proposed NULL-COLLAPSE, deliberately:
  // the verb's result carries `cleanCheckId` only when every control passed or was waived and
  // `failedCheckId` only when at least one failed, so each event names the MOMENT and an
  // occurrence exists only when that moment happened. Checked against the verb's REAL payload in
  // `core/migration/check.ts`. `entityKind` on the check events (`migration_check` is the
  // OP3-registered kind); the control row is not registered, so `control_waived` resolves from
  // `input.controlId` with no kind, the `review.period_prepared` shape.
  { event: 'migration.check_clean', emittedBy: 'migration_check_step', entityKind: 'migration_check', entityIdPath: 'result.cleanCheckId' },
  { event: 'migration.check_failed', emittedBy: 'migration_check_step', entityKind: 'migration_check', entityIdPath: 'result.failedCheckId' },
  { event: 'migration.control_waived', emittedBy: 'migration_waive_control', entityIdPath: 'input.controlId' },

  // --- G13 GL archive (spec §6b: OP8) ----------------------------------------------------------
  // Two moments a rule may REACT to; G13 accepts no automation ACTIONS at all (both its writes are
  // on the denylist). The import keys its occurrence on the step it archived (`input.stepId`, which
  // the verb requires; `entityKind` is `migration_step`, the OP3-registered kind, NOT
  // `gl_archive_entry`, because one import lands thousands of entries and the occurrence is the
  // step's). The purge resolves from `result.record.recordId`, the purge record the engine mints,
  // so a refusal (an err result) emits nothing: the event names the DESTRUCTION, not the attempt.
  { event: 'migration.archive_imported', emittedBy: 'gl_archive_import', entityKind: 'migration_step', entityIdPath: 'input.stepId' },
  { event: 'migration.archive_purged', emittedBy: 'gl_archive_purge', entityIdPath: 'result.record.recordId' },

  // --- G12 Testmandant (spec §6b: OP8) ---------------------------------------------------------
  // Three moments a rule may REACT to. `migration_create_testmandant` is the one G12 write a rule may
  // also ACT with (§6b); the other two are on the denylist. Each keys its occurrence on the WORKSPACE
  // it concerns (the OP3-registered `workspace` kind). `testmandant_created` resolves from
  // `result.createdTestmandantId`, set on the mint path and absent on the idempotent return, so
  // re-provisioning the same trial emits nothing new. `went_productive` resolves from
  // `result.promotedWorkspaceId`, which the engine sets null on the staged and already-live paths
  // (the `dunning.proposed` null-collapse), so exactly the moment a promotion happened emits one.
  // `testmandant_discarded` resolves from `result.discardedWorkspaceId`.
  { event: 'migration.testmandant_created', emittedBy: 'migration_create_testmandant', entityKind: 'workspace', entityIdPath: 'result.createdTestmandantId' },
  { event: 'migration.went_productive', emittedBy: 'go_productive', entityKind: 'workspace', entityIdPath: 'result.promotedWorkspaceId' },
  { event: 'migration.testmandant_discarded', emittedBy: 'discard_testmandant', entityKind: 'workspace', entityIdPath: 'result.discardedWorkspaceId' },

  // --- G19, the extraction companion (spec §6b: OP8) -------------------------------------------
  // Two moments a rule may REACT to, both riding `migration_set_manifest_item` (the G11
  // check_clean/check_failed shape: one verb, two events). `extraction_item_recorded` resolves from
  // `result.manifestId` (always set on a successful record) and keys its occurrence on the
  // OP3-registered `migration_extraction_manifest` kind, so a condition can read a custom field on
  // the manifest. `extraction_complete` resolves from `result.completedManifestId`, which the engine
  // sets ONLY on the write that made the manifest first complete and null otherwise (the
  // `dunning.proposed` null-collapse), so the event names the COMPLETION and fires once. G19 accepts
  // no destructive automation ACTION (there is none), so nothing here is denylisted.
  { event: 'migration.extraction_item_recorded', emittedBy: 'migration_set_manifest_item', entityKind: 'migration_extraction_manifest', entityIdPath: 'result.manifestId' },
  { event: 'migration.extraction_complete', emittedBy: 'migration_set_manifest_item', entityIdPath: 'result.completedManifestId' },

  // --- B00, projects master (spec §6b: OP8) ----------------------------------------------------
  // Three moments a rule may react to ("when a project is created, add a review phase"; "when a
  // milestone is done, log an activity"). Every `entityIdPath` below was checked against the verb's
  // REAL payload in `core/projects/`: `createProject` answers `{ project }` so the create resolves
  // from `result.project.id`; set_status and phase_done key on the id the caller passed, which both
  // verbs require. `entityKind` names the OP3-registered kind so a condition can read a custom
  // field off the entity (`project_phase` for the milestone event).
  { event: 'project.created', emittedBy: 'project_create', entityKind: 'project', entityIdPath: 'result.project.id' },
  { event: 'project.status_changed', emittedBy: 'project_set_status', entityKind: 'project', entityIdPath: 'input.projectId' },
  { event: 'project.phase_milestone_done', emittedBy: 'project_phase_done', entityKind: 'project_phase', entityIdPath: 'input.phaseId' },

  // --- B01, time tracking (spec §5/§6b: OP8) ---------------------------------------------------
  // The three timesheet lifecycle moments. The dispatch resolves ONE occurrence id per firing, so
  // the period-scoped verbs key on `input.period` (the `period.closed` shape: a submit sweeps N
  // entries and the occurrence is the period's, the exact collapse the A20 comment above warns
  // about), and `time_approve` keys on `result.approvalRef`, the engine's deterministic sorted-set
  // key, checked against the verb's REAL payload in `core/time/time.ts`. No `entityKind` on the
  // period events (a period is not an OP3 kind); none on the approve event either, because its id
  // is a SET key and a condition reading custom fields off one entry would be reading the wrong
  // thing. The plausible rules (spec §6b): notify on submit, auto-approve a trusted project's
  // sheet, lock the period when the month closes.
  { event: 'time_entry.submitted', emittedBy: 'time_submit', entityIdPath: 'input.period' },
  { event: 'time_entry.approved', emittedBy: 'time_approve', entityIdPath: 'result.approvalRef' },
  { event: 'time_entry.locked', emittedBy: 'time_lock', entityIdPath: 'input.period' },
  // --- B02, time -> billing (spec §5 automation, §6b: OP8) -------------------------------------
  // `time_entry.billed` rides `billing_generate_invoice` and resolves from `result.invoiceId` (the
  // draft it created), so every occurrence is ONE invoice however often the write is redelivered.
  // `time_entry.released` rides `billing_release_time` and resolves from `result.invoiceId` too (the
  // verb always returns the invoice whose lines it released). No `entityKind`: the id is the invoice,
  // not a single time entry, so a condition reading a `time_entry` custom field off one would read the
  // wrong thing (the `time_entry.approved` reasoning). The spec's target rule is "propose a billing
  // run": trigger `time_entry.approved`, action `billing_generate_invoice`, which stops at a draft.
  { event: 'time_entry.billed', emittedBy: 'billing_generate_invoice', entityIdPath: 'result.invoiceId' },
  { event: 'time_entry.released', emittedBy: 'billing_release_time', entityIdPath: 'result.invoiceId' },
  // --- E03, tasks & reminders (spec §6b: OP8) --------------------------------------------------
  // `task.completed` rides `tasks_complete` and resolves from `input.taskId`, which the verb
  // requires, so the occurrence key is stable; a replay under the same idempotency key is the same
  // occurrence. `entityKind` is `task`, the OP3-registered kind E03 itself adds, so a condition
  // can read a custom field (a `priority` select) off the completed task. `tasks_cancel`
  // deliberately emits nothing: a cancellation is a retraction, and a rule chasing retracted work
  // is the noise the queue exists to end. ALL FIVE E03 writes stay automatable (§6b: "E03 accepts
  // automation actions naming any of its own MCP write verbs"): no denylist leg holds, because a
  // task is corrected by writing it again (not a), discharges no statute (not b), decides no
  // membership (not c), is tenant-bound (not d), administers nothing unattended (not e) and names
  // no payment destination (not f).
  { event: 'task.completed', emittedBy: 'tasks_complete', entityKind: 'task', entityIdPath: 'input.taskId' },
  // `task.due` has NO emitting verb, the `schedule.*` shape: a reminder becomes due by time
  // passing, so it fires from the tick through E03's `TICK_SOURCES` row
  // (`src/core/tasks/tickSource.ts`), reading the SAME predicate `tasks_reminders_due` answers
  // with. The occurrence key is `task.due:<taskId>:<effective instant>`, so one due-moment fires
  // once however many ticks see it, and a snooze expiry is a genuinely new occurrence.
  { event: 'task.due', emittedBy: '', entityKind: 'task', entityIdPath: '' },

  // --- C01, leads & deals (spec §6b: OP8) ------------------------------------------------------
  // Three moments a rule may react to ("when a deal enters Offerte, log a follow-up"; "when a deal
  // is won, create a task"). `deal.stage_changed` rides `deals_move` and resolves from
  // `input.dealId`, which the verb requires. The two TERMINAL moments ride `deals_mark` and are
  // told apart by the RESULT PATH (the `workspace.archived` shape): the engine sets `wonDealId`
  // only when the call actually closed the deal as won and `lostDealId` only on a genuine loss,
  // each null otherwise, so a no-change re-mark and a reopen both emit nothing (the
  // `dunning.proposed` null-collapse, used deliberately). `deals_move` CANNOT reach a terminal
  // stage (it refuses with `terminal_stage_use_mark`), so the stage-changed and won/lost moments
  // cannot double-fire from one act. `entityKind` is `deal`, the OP3-registered kind C01 itself
  // adds, so a condition can read a custom field off the deal. Every path checked against the
  // verbs' REAL payloads in `core/deals/deals.ts`.
  { event: 'deal.stage_changed', emittedBy: 'deals_move', entityKind: 'deal', entityIdPath: 'input.dealId' },
  { event: 'deal.won', emittedBy: 'deals_mark', entityKind: 'deal', entityIdPath: 'result.wonDealId' },
  { event: 'deal.lost', emittedBy: 'deals_mark', entityKind: 'deal', entityIdPath: 'result.lostDealId' },

  // --- C02, quotes / proposals (spec §5: OP8, the six `quote.*` aliases of A10's `document.*`) ---
  // FIVE of the six ride a single-quote write and resolve from a path checked against the verb's
  // REAL payload. `entityKind` is `document` (a quote IS a document row, the OP3 `quote` kind keys the
  // custom fields), so a rule condition can read a quote's custom field. `quote.sent`/`accepted`/
  // `declined` return the quote view, so `result.document.id` resolves; `quote.converted` returns the
  // NEW target's view plus `sourceDocumentId` (the quote), which is the entity the moment is about;
  // `quote.superseded` returns the new draft plus `supersededId` (the retired old version).
  //
  // The SIXTH, `quote.expired`, is DEFERRED on the A20 `bank_txn.needs_review` precedent (§0 of the
  // reconciled spec): its only emitter is the BULK `quotes_expire_sweep`, which touches N quotes in
  // one call, and the dispatch resolves ONE entity id per firing, so N expiries would collapse onto
  // one `event_ref` and fire a rule once, ever. An individual expiry is observable on the read.
  { event: 'quote.sent', emittedBy: 'quotes_send', entityKind: 'document', entityIdPath: 'result.document.id' },
  { event: 'quote.accepted', emittedBy: 'quotes_accept', entityKind: 'document', entityIdPath: 'result.document.id' },
  { event: 'quote.declined', emittedBy: 'quotes_decline', entityKind: 'document', entityIdPath: 'result.document.id' },
  { event: 'quote.converted', emittedBy: 'quotes_convert', entityKind: 'document', entityIdPath: 'result.sourceDocumentId' },
  { event: 'quote.superseded', emittedBy: 'quotes_revise', entityKind: 'document', entityIdPath: 'result.supersededId' },

  // --- E01, e-signature (spec §6b: OP8, the five sign_request.* moments) -------------------------
  // `sent` and `signed` ride their own verbs (the A17 one-verb-one-event shape). The THREE provider
  // events share ONE verb (`sign_requests_record_event`), so they key on DISJOINT result paths: the
  // verb answers `viewedSignRequestId` / `declinedSignRequestId` / `expiredSignRequestId` only for
  // the outcome that actually happened, and the dispatch skips a row whose path resolves to nothing
  // (its documented behaviour). A rule condition can read a custom field off the request (OP7: the
  // `sign_request` kind is registered). `sign_request.expired` fires from the RECORDED provider
  // event only: a manual withdraw and the lazy deadline sweep do not fire it (the `quote.expired`
  // deferral reasoning: a sweep inside a read verb has no dispatch to ride).
  { event: 'sign_request.sent', emittedBy: 'sign_requests_send', entityKind: 'sign_request', entityIdPath: 'input.signRequestId' },
  { event: 'sign_request.viewed', emittedBy: 'sign_requests_record_event', entityKind: 'sign_request', entityIdPath: 'result.viewedSignRequestId' },
  { event: 'sign_request.declined', emittedBy: 'sign_requests_record_event', entityKind: 'sign_request', entityIdPath: 'result.declinedSignRequestId' },
  { event: 'sign_request.expired', emittedBy: 'sign_requests_record_event', entityKind: 'sign_request', entityIdPath: 'result.expiredSignRequestId' },
  { event: 'sign_request.signed', emittedBy: 'sign_requests_complete', entityKind: 'sign_request', entityIdPath: 'input.signRequestId' },

  // --- F02, customer portal (spec §5/§6b: OP8, the two portal_grant.* moments) ------------------
  // `created` and `revoked` ride their own single-grant verbs (the A17 one-verb-one-event shape) and
  // resolve from `result.grantId`, checked against the verbs' REAL payloads in `core/portal/grants.ts`
  // (both answer `{ grantId, ... }`). `entityKind` is `portal_grant`, the OP3 kind F02 registers, so a
  // rule condition can read a custom field off the grant (e.g. "when an invoice's AutoPortal field is
  // true and invoice.posted fires, portal_grant_create scoped to it"). There is no `portal_grant.sent`
  // event: sending transmits nothing in the OSS core (OP4), so the observable moment is the create.
  // `portal_quote_accept` emits nothing here: it is a pre-workspace token verb the fire path cannot
  // drive (it is on the denylist, leg d), so it has no dispatch to ride.
  { event: 'portal_grant.created', emittedBy: 'portal_grant_create', entityKind: 'portal_grant', entityIdPath: 'result.grantId' },
  { event: 'portal_grant.revoked', emittedBy: 'portal_grant_revoke', entityKind: 'portal_grant', entityIdPath: 'result.grantId' },

  // --- F03, vendor portal (spec §6b: OP8, the one accepted automation moment) --------------------
  // `remittance_advice.created` rides `vendor_portal_remittance_create` and resolves from
  // `result.adviceId`, checked against the verb's REAL payload in `core/portal/vendorPortal.ts`. This
  // is the ONE F03 automation surface: `vendor_portal_remittance_create` is the accepted rule action
  // (the "auto-draft an advice for every supplier payment" worked example), still artifact-and-stop
  // (OP4, non-posting by construction). `entityKind` is `remittance_advice`, the OP3 kind F03
  // registers, so a rule condition can read a custom field off the advice. There is deliberately NO
  // `vendor_portal_grant.*` event and no vendor grant/revoke automation action: a grant's scope is a
  // revDSG Art. 6 data-minimisation decision a human or an explicit agent call owns, so both are on
  // the denylist (see `denylist.ts`), NOT emitters here.
  { event: 'remittance_advice.created', emittedBy: 'vendor_portal_remittance_create', entityKind: 'remittance_advice', entityIdPath: 'result.adviceId' },

  // --- D01, inventory / stock (spec §6b: OP8) --------------------------------------------------
  // `stock.low_stock_reached` rides `stock_move` and resolves from `result.lowStockReachedItemId`,
  // which the engine sets to the item id ONLY on a DOWNWARD crossing of the D00 reorder point (a move
  // that drives total on-hand from above the reorder point to at/below it) and null otherwise (the
  // `dunning.proposed` null-collapse, used deliberately): a move that does not cross emits no
  // occurrence, so a rule fires once per crossing rather than once per movement. Checked against
  // `recordStockMove`'s real payload in `core/stock/movements.ts`. `entityKind` is `item`, the
  // OP3-registered kind, so a condition can read a custom field off the item. A transfer nets zero on
  // total on-hand and so never crosses. The plausible rule (§6b) is "when an item goes low, draft a
  // D02 purchase"; `stock_move` and `stock_location_upsert` stay legal automation ACTIONS, while
  // `stock_run_valuation` and `stock_stocktake_commit` are on the denylist.
  { event: 'stock.low_stock_reached', emittedBy: 'stock_move', entityKind: 'item', entityIdPath: 'result.lowStockReachedItemId' },

  // --- D03, sales orders & delivery notes (spec §5/§6b: OP8) ----------------------------------
  // The six fulfilment moments. Each `entityKind` is the OP3-registered D03 kind so a rule condition
  // can read a custom field off the order (or note). FOUR of them ride a null-collapse id (the D01
  // low-stock precedent): the engine sets the id ONLY on the transition that actually happened and
  // null otherwise, so a rule fires once per real move rather than once per verb call. A single
  // `delivery_note_issue` may advance the order to `partially_delivered` OR `delivered`, so both
  // events ride it and the engine's `partiallyDeliveredOrderId`/`deliveredOrderId` collapse decides
  // which fires. `sales_order.confirmed` rides confirm (always set on success); `sales_order.invoiced`
  // fires only when a `sales_order_invoice` call brought the order fully invoiced (`invoicedOrderId`);
  // `sales_order.cancelled` rides cancel (`cancelledOrderId`); `delivery_note.issued` rides every
  // successful issue. All checked against the verbs' real payloads in `core/sales/*`.
  { event: 'sales_order.confirmed', emittedBy: 'sales_order_confirm', entityKind: 'sales_order', entityIdPath: 'result.confirmedOrderId' },
  { event: 'sales_order.partially_delivered', emittedBy: 'delivery_note_issue', entityKind: 'sales_order', entityIdPath: 'result.partiallyDeliveredOrderId' },
  { event: 'sales_order.delivered', emittedBy: 'delivery_note_issue', entityKind: 'sales_order', entityIdPath: 'result.deliveredOrderId' },
  { event: 'sales_order.invoiced', emittedBy: 'sales_order_invoice', entityKind: 'sales_order', entityIdPath: 'result.invoicedOrderId' },
  { event: 'sales_order.cancelled', emittedBy: 'sales_order_cancel', entityKind: 'sales_order', entityIdPath: 'result.cancelledOrderId' },
  { event: 'delivery_note.issued', emittedBy: 'delivery_note_issue', entityKind: 'delivery_note', entityIdPath: 'result.deliveryNoteIssuedId' },

  // --- D02, purchasing (spec §5/§6b: OP8) -------------------------------------------------------
  // The five PO moments a rule may trigger on. `entityKind:'po'` is the OP3-registered D02 kind, so a
  // rule condition can read a custom field (or `total_base_rappen`) off the order, which is what the
  // spec's auto-send-under-threshold worked example needs. Each rides a null-collapse id (the D03/D01
  // precedent): the engine sets the id ONLY when the moment actually happened and null otherwise, so a
  // firing is one per real move. `po.drafted` rides `po_upsert` but fires on CREATE only
  // (`draftedPoId` is absent on a draft EDIT); `po.received` fires only when a receipt brought the PO
  // fully received (`receivedPoId`); `po.closed` rides the operator's `po_close_short` (a match-driven
  // close is a control outcome, not a trigger, and the registry keys ONE emitting verb per event);
  // `po.cancelled` rides cancel. `match_bill` deliberately emits NO event and is denylisted as an
  // action: a variance override is a human judgment, never an automation trigger or target. All
  // checked against the verbs' real payloads in `core/purchase/*`.
  { event: 'po.drafted', emittedBy: 'po_upsert', entityKind: 'po', entityIdPath: 'result.draftedPoId' },
  { event: 'po.sent', emittedBy: 'po_send', entityKind: 'po', entityIdPath: 'result.sentPoId' },
  { event: 'po.received', emittedBy: 'receipt_record', entityKind: 'po', entityIdPath: 'result.receivedPoId' },
  { event: 'po.closed', emittedBy: 'po_close_short', entityKind: 'po', entityIdPath: 'result.closedPoId' },
  { event: 'po.cancelled', emittedBy: 'po_cancel', entityKind: 'po', entityIdPath: 'result.cancelledPoId' },

  // --- E02, HR-lite (§5/§6b). Each keys its occurrence on the CLAIM (or absence) id, which the
  // verb returns only on the outcome that actually happened: `expense_claim_approve` returns
  // `result.claimId` only on a CONFIRMED approval (the P8 preview returns none), so a preview emits
  // no `approved` occurrence, the `dunning.proposed`/null shape. These five are what the auto-approve
  // automation (§6b worked example) and any reactive rule trigger on; E02 ACCEPTS its own verbs as
  // rule actions (see `denylist.ts`), so a firing is a stored invocation of an existing verb.
  { event: 'expense_claim.submitted', emittedBy: 'expense_claim_submit', entityKind: 'expense_claim', entityIdPath: 'result.claimId' },
  { event: 'expense_claim.approved', emittedBy: 'expense_claim_approve', entityKind: 'expense_claim', entityIdPath: 'result.claimId' },
  { event: 'expense_claim.rejected', emittedBy: 'expense_claim_reject', entityKind: 'expense_claim', entityIdPath: 'result.claimId' },
  { event: 'expense_claim.reimbursed', emittedBy: 'expense_claim_reimburse', entityKind: 'expense_claim', entityIdPath: 'result.claimId' },
  { event: 'absence.recorded', emittedBy: 'hr_absence_record', entityKind: 'absence', entityIdPath: 'result.absenceId' },

  // --- B04, retainers & mandates (spec §5) -----------------------------------------------------
  // TWO ROWS FOR ONE EMITTING VERB, `retainer_generate_invoice`, told apart by their id path.
  // `retainer.invoice_generated` fires per generated period, keyed on the retainer (`input.retainerId`);
  // its REQUIRED `idempotencyKey` discriminates two genuine periods of one retainer (the `close_month`
  // argument, since the retainer id repeats across periods). `retainer.over_cap` rides the SAME verb
  // but resolves from `result.overCapRef`, which the engine sets to the retainer id ONLY when
  // `over_cap_minutes > 0` and null otherwise, so a within-cap period emits no over-cap occurrence (the
  // `dunning.proposed` null-collapse, used deliberately). Neither rides `retainer_run_due`: that bulk
  // verb generates many periods per call and the dispatch resolves ONE entity id per firing, so N
  // periods would collapse onto one event_ref and fire once ever (the A20 `import_camt` warning,
  // verbatim); the single-retainer generate path is the automation moment. `entityKind:'retainer'` is
  // the OP3-registered B04 kind, so a rule condition can read a custom field off the mandate.
  { event: 'retainer.invoice_generated', emittedBy: 'retainer_generate_invoice', entityKind: 'retainer', entityIdPath: 'input.retainerId' },
  { event: 'retainer.over_cap', emittedBy: 'retainer_generate_invoice', entityKind: 'retainer', entityIdPath: 'result.overCapRef' },

  // --- G04, data freedom (spec §6b: scheduled backups) -----------------------------------------
  // `create_backup` is a callable action any rule may name (a G01 time-based trigger drives the
  // "back up nightly" cadence). It also EMITS `backup.created` so a reactive rule can chain off a
  // completed backup, keyed on the new backup id. Only the SUCCESS event is registered: the shared
  // hook fires only after a write returns `ok`, and a failed backup returns `{ok:false}`, so
  // `backup.failed` has no success moment to ride (spec §0a.7). `entityKind:'backup'` is the
  // OP3-registered G04 kind, so a rule condition can read a custom field off the backup row.
  { event: 'backup.created', emittedBy: 'create_backup', entityKind: 'backup', entityIdPath: 'result.backupId' },
  // --- G05, document templates (spec §5/§6b: OP8) ----------------------------------------------
  // Four lifecycle moments a rule may react to ("when a new fr-CH template is approved, make it the
  // default for quotes"), and `set_default_document_template` is also a legal rule ACTION (it is a
  // registered write verb and not denylisted; `draft_by_default` stays true per P8, a workspace-wide
  // default change being a wide-effect, reviewable write). Names follow the registry's own
  // convention (`vendor_bill.posted`), not the spec's original camelCase sketch (reconciled §0
  // item 5). Every `entityIdPath` was checked against the verb's REAL payload in
  // `core/customization/documentTemplates.ts`: create answers `{ template: { templateId, ... } }`,
  // and the other three require `templateId` as input. `entityKind` is the OP3-registered
  // `document_template`, so a rule condition can read a custom field off the template (the
  // "tagged Approved:true" §6b example).
  { event: 'document_template.created', emittedBy: 'create_document_template', entityKind: 'document_template', entityIdPath: 'result.template.templateId' },
  { event: 'document_template.updated', emittedBy: 'update_document_template', entityKind: 'document_template', entityIdPath: 'input.templateId' },
  { event: 'document_template.default_changed', emittedBy: 'set_default_document_template', entityKind: 'document_template', entityIdPath: 'input.templateId' },
  { event: 'document_template.archived', emittedBy: 'archive_document_template', entityKind: 'document_template', entityIdPath: 'input.templateId' },
  // G05 §10 (spec §0 item 8b): the spec's sketched `dispatch.recorded` cannot exist here, because
  // this registry keys ONE event to ONE emitting verb (the A17 four-rows rule) and the log rows are
  // appended by THREE send verbs whose moments are already triggerable (`invoice.sent`,
  // `dunning.sent`, `quote.sent` above). What §10 registers is the voice-change moment: a rule may
  // react to a saved text changing ("when the Mahnung text changes, notify the owner"). The
  // `entityIdPath` was checked against the verb's REAL payload: `dispatch_text_upsert` answers
  // `{ dispatchText: { dispatchTextId, ... } }`. No `entityKind`: `dispatch_text` is deliberately
  // not an OP3 kind (the editable text needs no custom fields; the LOG's kind is `dispatch`).
  { event: 'dispatch_text.updated', emittedBy: 'dispatch_text_upsert', entityIdPath: 'result.dispatchText.dispatchTextId' },

  // --- A31, document capture (spec §5/§6b: OP8) ------------------------------------------------
  // Four moments a rule may react to. `capture.received` fires ONCE at intake completion and is the
  // §6b worked example's trigger ("when a fully machine-read small bill arrives, auto-commit it to a
  // draft"); `capture.needs_review` rides re-extraction; both key on the capture the moment is about.
  // Every `entityIdPath` was checked against the verb's REAL payload in `core/purchase/capture.ts`:
  // `capture_document` answers `{ captureId, ... }` (result.captureId), and the other three take
  // `captureId` as input. `entityKind` is the OP3-registered `capture` kind, so a rule condition can
  // read a custom field (or the live fields on the payload) off the capture. Each event is keyed to
  // exactly ONE emitting verb (the registry's one-verb-per-row rule), so `needs_review` is the
  // re-extraction moment and intake's own is `received`. A31 ACCEPTS `capture_extract`,
  // `capture_commit` and `capture_discard` as rule actions (none posts; commit stops at a draft), so
  // none is on the denylist.
  { event: 'capture.received', emittedBy: 'capture_document', entityKind: 'capture', entityIdPath: 'result.captureId' },
  { event: 'capture.needs_review', emittedBy: 'capture_extract', entityKind: 'capture', entityIdPath: 'input.captureId' },
  { event: 'capture.committed', emittedBy: 'capture_commit', entityKind: 'capture', entityIdPath: 'input.captureId' },
  { event: 'capture.discarded', emittedBy: 'capture_discard', entityKind: 'capture', entityIdPath: 'input.captureId' },

  // --- A34 payroll hand-off (spec §5, deliberately thin: emits, accepts no rule ACTION). --------
  // The export emits when the artifact is produced (`result.exportId`); the wage posting emits when
  // A02 actually posts (`result.entryId`), which a dial-off PREVIEW never carries, so a preview emits
  // nothing (`dispatchAutomationEvent` skips an unresolved id). `wage_journal_post` is on the
  // denylist as a rule ACTION (a posting), but it still EMITS an event a rule may react to (e.g. a
  // notification), which is the one-way relationship §5 intends.
  { event: 'payroll.handoff_exported', emittedBy: 'payroll_handoff_export', entityKind: 'payroll_handoff', entityIdPath: 'result.exportId' },
  { event: 'payroll.wage_journal_posted', emittedBy: 'wage_journal_post', entityKind: 'journal_entry', entityIdPath: 'result.entryId' },

  // --- G20, implementation projects (spec §6b: OP8) --------------------------------------------
  // Four moments a rule may REACT to (never CAUSE: `implementation_signoff_record` and
  // `implementation_project_close` are on the denylist, a rule engine must not sign or close). The
  // phase is DERIVED, so `project.phase_changed` rides `implementation_task_set` (the write a rule
  // watches for progress) and resolves through the null-collapse `result.phaseChangedTo`, set only when
  // a task write advanced the derived phase; other transitions (a linked plan's G19 manifest, G12
  // go_productive) are observed on the next read. `project.task_blocked` rides the same verb on
  // `result.blockedTaskId`, set only when the task became blocked. `project.signoff_recorded` rides the
  // sign-off verb on `result.signoffId` (always set on success). `project.parallel_check_failed` rides
  // the check verb on `result.failedCheckId`, set only when at least one figure failed (the
  // `migration.check_failed` null-collapse). `entityKind` names the OP3-registered kind so a condition
  // can read a custom field off the entity.
  { event: 'project.phase_changed', emittedBy: 'implementation_task_set', entityKind: 'implementation_project', entityIdPath: 'result.phaseChangedTo' },
  { event: 'project.task_blocked', emittedBy: 'implementation_task_set', entityKind: 'implementation_task', entityIdPath: 'result.blockedTaskId' },
  { event: 'project.signoff_recorded', emittedBy: 'implementation_signoff_record', entityKind: 'implementation_signoff', entityIdPath: 'result.signoffId' },
  { event: 'project.parallel_check_failed', emittedBy: 'implementation_parallel_check', entityKind: 'implementation_project', entityIdPath: 'result.failedCheckId' },

  // --- N00, the environment landscape (D126) ---------------------------------------------------
  // Four host-level moments a rule may REACT to (never CAUSE: all four env_* writes are on the
  // denylist, a rule engine must never create, switch, reset or wipe an environment at 03:00). Each
  // resolves from the CONFIRMED result, which a P8 PLAN (staged) call does not carry, so an
  // unconfirmed plan emits no occurrence (the `dunning.proposed` null-collapse, used deliberately):
  // the event names the executed act, not the preview. No `entityKind`: an environment is host-level,
  // not an OP3 workspace entity kind (the `period.closed` shape).
  { event: 'environment.created', emittedBy: 'env_create', entityIdPath: 'result.environment.name' },
  { event: 'environment.switched', emittedBy: 'env_switch', entityIdPath: 'result.active' },
  { event: 'environment.reset', emittedBy: 'env_reset', entityIdPath: 'result.name' },
  { event: 'environment.deleted', emittedBy: 'env_delete', entityIdPath: 'result.name' },
  // Phase B: a copy finished. Resolves from the CONFIRMED result`s `target` (a P8 plan carries none, so
  // an unconfirmed preview emits nothing). No entityKind: an environment is host-level (the env_* shape).
  { event: 'environment.copied', emittedBy: 'env_copy', entityIdPath: 'result.target' },

  // --- G01, the cadences. No emitting verb: `tick.ts` produces these. --------------------------
  { event: 'schedule.daily', emittedBy: '', entityIdPath: '' },
  { event: 'schedule.weekly', emittedBy: '', entityIdPath: '' },
  { event: 'schedule.monthly', emittedBy: '', entityIdPath: '' },
];

const BY_EVENT: ReadonlyMap<string, AutomationEventDef> = new Map(
  AUTOMATION_EVENTS.map((e) => [e.event, e]),
);

/** Every event id whose source is a write verb, indexed by that verb. One verb may emit several. */
const BY_VERB: ReadonlyMap<string, readonly AutomationEventDef[]> = (() => {
  const m = new Map<string, AutomationEventDef[]>();
  for (const e of AUTOMATION_EVENTS) {
    if (e.emittedBy.length === 0) continue;
    const list = m.get(e.emittedBy);
    if (list === undefined) m.set(e.emittedBy, [e]);
    else list.push(e);
  }
  return m;
})();

/** The registry row for an event id, or undefined when it is not registered. */
export function automationEventDef(event: unknown): AutomationEventDef | undefined {
  return typeof event === 'string' ? BY_EVENT.get(event) : undefined;
}

/** Every registered event id, for the Studio's picker and for a message that names them. */
export const AUTOMATION_EVENT_IDS: readonly string[] = AUTOMATION_EVENTS.map((e) => e.event);

/** The events a given write verb emits on success. Empty for the vast majority of verbs. */
export function eventsEmittedBy(actionName: string): readonly AutomationEventDef[] {
  return BY_VERB.get(actionName) ?? [];
}

/** A cadence event fires from the tick rather than from a verb. */
export function isScheduleEvent(event: string): boolean {
  return event.startsWith('schedule.');
}

/**
 * The registered WRITE verbs, handed over by `src/api/registry.ts` at module load.
 *
 * A MUTABLE MODULE SLOT IS THE HONEST SHAPE HERE, not a shortcut. `ACTIONS` genuinely is a
 * process-wide constant, the dependency has to run api -> core to stay acyclic, and the alternative
 * (threading the whole action list through every engine signature) would put an api concern in the
 * parameter list of verbs that have nothing to do with it. `assertEveryWriteIsGated` is the same
 * shape: a load-time handshake between the registry and a core module that cannot see it.
 *
 * AN EMPTY SET MEANS "NOT CONFIGURED", NOT "NO VERBS ARE WRITES", and the difference is load-bearing.
 * An embedder using the core without `src/api/` reaches `createAutomationRule` with nothing
 * registered; answering "that tool is not a write verb" would be a lie about the tool. It answers
 * `automation_unavailable` instead, which is the honest degradation `emailRelay` uses for the same
 * class of missing host wiring.
 */
let writeActions: ReadonlySet<string> | undefined;

export function registerWriteActions(names: readonly string[]): void {
  writeActions = new Set(names);
}

/** Has a host wired the action registry? False means refuse, never "no". */
export function automationActionsConfigured(): boolean {
  return writeActions !== undefined && writeActions.size > 0;
}

/** Is `tool` a registered WRITE verb, and therefore a legal rule action? */
export function isRegisteredWriteAction(tool: unknown): boolean {
  return typeof tool === 'string' && writeActions !== undefined && writeActions.has(tool);
}

/** Every legal action name, for the Studio's action picker. Sorted so the list is stable. */
export function registeredWriteActions(): readonly string[] {
  return writeActions === undefined ? [] : [...writeActions].sort();
}

/**
 * Read a dot path out of a plain object graph. Returns undefined for any miss.
 *
 * Deliberately does NOT walk arrays by index and does not resolve prototype properties: a path is a
 * configuration value, and a configuration value that can reach `constructor` or `__proto__` is a
 * prototype-pollution read on a graph an untrusted caller supplied.
 */
export function readPath(source: unknown, path: string): unknown {
  if (path.length === 0) return undefined;
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
