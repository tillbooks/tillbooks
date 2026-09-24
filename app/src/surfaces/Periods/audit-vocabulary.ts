/**
 * The A03 audit-log vocabulary: every `entityKind` and `action` the engine can stamp into the chain.
 *
 * This MIRRORS the engine the same way `lib/client.ts` mirrors the REST types: the browser bundle
 * never imports engine code, so the vocabulary is re-declared here rather than imported. The mirror
 * is not trusted to stay honest by convention. `audit-vocabulary.test.ts` scans the engine source for
 * audit emissions and fails if this list drifts, and asserts every entry below has a de-CH and an en
 * translation. Between the two, a raw `audit.action.*` key can no longer reach a user.
 *
 * Emitters, as of the scan:
 *   `workspace` / `create`                 src/core/setup/workspace.ts
 *   `entry`     / `post|reverse|close`     src/core/ledger/postEntry.ts (via `auditAction`)
 *   `period_lock` / `lock|unlock`          src/core/ledger/periods.ts, src/core/ledger/yearClose.ts
 *   `exchange_rate` / `record`             src/core/fx/rates.ts
 *   `fx_method_election` / `elect`         src/core/fx/method.ts
 *   `payment` / `post|allocate|reverse`    src/core/payments/payment.ts
 *   `bank_account` / `create|update|archive`  src/core/banking/bankAccounts.ts
 *   `saldo_declaration_election` / `elect`  src/core/vat/saldoDeclaration.ts
 *
 * §H-FX added the fifth emitter: a recorded rate is a statutory input to every foreign-currency
 * posting, so the chain stamps who entered which rate and when. Without the entry below the Objekt
 * column rendered a raw `audit.entityKind.exchange_rate` at a user, and the filter dropdown offered
 * no way to isolate the rate history at all.
 *
 * The §H-FX method lock and the A14 payments engine added the next two, and they are worth naming
 * precisely because a near-miss label would be worse than the raw token:
 *   - `elect` is MWSTV Art. 45 Abs. 5: the workspace picks the conversion basis (Tageskurs,
 *     Monatsmittelkurs or the Art. 45 Abs. 4 group rate) that governs a whole Steuerperiode. It
 *     chooses a rule, it does not record a rate. `record` on `exchange_rate` is the rate.
 *   - `allocate` assigns money that ALREADY landed (and was already booked by `post`) to open
 *     documents. It posts no journal entry at all, so the label must not read like a payment.
 *
 * A19 added the bank-account emitter, and its two new actions need the same care:
 *   - `update` changes master data on the account (name, IBAN, currency, the ledger account it
 *     books to). It touches no posting, so "Geändert" and not "Gebucht" or "Erfasst".
 *   - `archive` retires an account and is never a DELETE: `bank_txn` and `reconciliation_match`
 *     keep a durable reference to the row. "Archiviert" matches how VatSettings already words a
 *     retired code, and it must not read as `lock`, which names a period lock and is reversible.
 *
 * F11 added `saldo_declaration_election`, the MWSTV Art. 88 Abs. 6 choice to declare the whole
 * taxable turnover at the highest approved Saldosteuersatz instead of splitting it per activity
 * (Abs. 1). It reuses `elect`, because it is the same shape of decision as the Art. 45 Abs. 5 FX
 * election: one absolute value governing one Steuerperiode. The row is UPSERTed one per
 * Steuerperiode, so the audit trail is the ONLY evidence that a withdrawn year was ever elected.
 *
 * Its label is the one place a near miss would do real damage, so the obvious word is refused:
 *   - NOT "Abrechnungsart". That is the Sachüberschrift of MWSTG Art. 39 and names the
 *     vereinbart/vereinnahmt choice, which VatSettings already labels "Abrechnungsart" and Setup
 *     "MWST-Abrechnungsart". Two concepts under one word in the Objektart dropdown is worse than
 *     the raw token, which at least looks broken.
 *   - NOT "Abrechnungsmethode" either: MWSTG Art. 36 gives that heading to effektiv versus Saldo,
 *     the choice that decides whether this election can exist at all.
 *   - "Saldo-Deklarationsbasis" names the OBJECT and not the act, the way `fx_method_election`
 *     reads "Umrechnungsmethode" and not "Methodenwahl", and the "Saldo" qualifier is what keeps
 *     "Basis" from being read as the ist/soll one.
 *
 * A24 added the two access emitters, `workspace_member` and `role_def`, and this is the first time
 * the audit trail carries something that is not about money at all. It has to: OR bookkeeping
 * responsibility rests with defined persons, so a role change is exactly the kind of act the chain
 * exists to make attributable, and revDSG least-privilege is unauditable if nobody can see when a
 * mandate widened. Four new actions, three of which needed a decision rather than a word:
 *   - `claim_owner` is the ONE moment a workspace stops being ungated. It is stamped when the first
 *     invite seats its caller as owner, and it is deliberately not `create`: `create` on a
 *     `workspace` is minting the books, this is somebody taking charge of books that already exist.
 *     It should be legible years later as the row that explains why everything before it was open.
 *   - `invite` and not `create`: nothing is granted yet. A pending member holds no capability until
 *     the invite is redeemed, and a label reading "Erstellt" would suggest access already exists.
 *   - `set_role` and not `update`: `update` is a master-data edit (an account renamed, an IBAN
 *     corrected). Moving somebody from Nur lesen to Buchhaltung is the single most consequential row
 *     in this table, and it must not read like a typo correction.
 *   - `revoke` and not `archive`: `archive` is reversible and preserves the row for reference, which
 *     is what `archive_role` does. Revoking a membership DELETES the grant, and the difference is
 *     the whole point of the two verbs.
 */

/** Every object kind the audit log can name. Drives the filter dropdown and the Objekt column. */
export const AUDIT_ENTITY_KINDS = [
  'workspace',
  'entry',
  'payment',
  'period_lock',
  'exchange_rate',
  'fx_method_election',
  // A22 FX revaluation. The run row is the audit record of a period-end OR 960a revaluation: it
  // stamps `post` (the word every money-path booking uses) when the closing-rate gain/loss is posted
  // and its next-period reversal linked. Its own object kind and not `entry`, because it names the
  // revaluation RUN a human confirmed, not the individual journal entry the run produced.
  'fx_revaluation',
  // A38 MWST-Saldierung (D129 leg 2). The settlement row is the audit record of a filed period's
  // VAT balances moving to 2201: it stamps `post` when the transfer books inside the filed period
  // and `reverse` when its Storno does. Its own object kind and not `entry`, because it names the
  // settled PERIOD a human confirmed, not the journal entry the settlement produced.
  'vat_settlement',
  'bank_account',
  'saldo_declaration_election',
  'workspace_member',
  'role_def',
  // C00 contacts/CRM. The second non-money emitter after A24's two, and it is here for the revDSG
  // reason rather than an accounting one: a merge consolidates a client's whole history onto one row
  // and an anonymise erases personal data for good, so both have to be attributable to a person and
  // a moment years later. Neither touches the journal.
  'contact',
  // A17 vendor bills, the creditor half of the money path. It emits `create` on the draft, `post` on
  // the booking, `update` on a receipt reference and `reverse` on a void, so it needs no new ACTION,
  // only the object kind. `vendor_bill` and not `bill`: it is the engine's own entity kind, and the
  // filter has to send the value the engine stores.
  'vendor_bill',
  // E00 file management, and the third non-money emitter. Only the two consequential verbs stamp the
  // chain, the same split A09/C00 use: filing, tagging and superseding are silent CRUD, while erasing
  // a business record and moving a statutory retention deadline are exactly the acts that have to be
  // attributable to a person and a moment ten years later.
  'stored_file',
  // G22 checklists (D127). A run is a governance object over the MWST period: starting it, completing
  // or skipping an item, reopening one and abandoning the run are attributable acts (who stood behind
  // "eingereicht", and when), so the run stamps the chain although it posts nothing.
  'checklist_run',
  // G01/F5. The one emitter that is a MIGRATION rather than a verb: generation 6 disables a stored
  // rule whose action the denylist has since denied, and that act has to be attributable ("the
  // system, on upgrade, at this moment") or a workspace finds a rule switched off with no trace of
  // by whom. Ordinary rule CRUD stays silent, exactly as A09's contact CRUD does.
  'automation_rule',
  // A21 QR matching. The queue row IS the audit record of which credit settled which invoice
  // (spec §6b fixed), so its three decision moments stamp the chain: recording a credit
  // (`record`, the word `exchange_rate` already uses for the same shape of act), applying a match
  // and overriding one (their own words below), and flipping the auto-apply dial, the one flip
  // that decides whether money may move unattended.
  'reconciliation_match',
  // A20 camt reconciliation. Two new object kinds: `bank_statement` for the imported file itself
  // (its own `import` row, spec §0 note 7's dedupe fact made attributable), `bank_txn` for the
  // decision on one imported entry (`confirm`/`book` below). Neither is `reconciliation_match`: a
  // camt entry that names a CREDIT never gets a row here at all, it becomes an A21 queue row and
  // stamps THAT chain instead (spec §0 note 2, A20 mints no second matching machine).
  'bank_statement',
  'bank_txn',
  // A18 creditor payments. `creditor_bank_profile` is the vendor IBAN A17 never captured (a payment
  // destination, D65 leg f), so every write to it is attributable, the same reasoning A19's
  // `bank_account` emitter already carries for the workspace's own accounts. `payment_batch` stamps
  // `create` on the draft and `update` on generating the pain.001 and on marking it paid: no new
  // ACTION word, only the two object kinds.
  'creditor_bank_profile',
  'payment_batch',
  // A25 review. A review event is the fiduciary's attributable act on one posting: who queried,
  // who flagged, who signed off, and when. The ledger row itself never moves (the sidecar boundary),
  // so this chain entry is the ONLY place the sign-off is evidenced, which is exactly what the
  // audit trail is for. "Prüfvermerk" names the OBJECT (the review note), not the act.
  'entry_review',
  // B00 projects. The one emitter is the REOPEN of a closed project (US-B00.5): every ordinary
  // transition is visible on the row itself, but "who put a closed project back in play, and when"
  // has to be attributable after the row has long since moved on, which is exactly what the chain
  // is for. Ordinary project CRUD stays silent, the A09/C00 split.
  'project',
  // E03 tasks. The fourth non-money emitter, and its four stamped moments are the operational
  // lifecycle a workspace may later have to reconstruct ("who cancelled the MWST preparation duty,
  // and when"): create, edit/reopen, complete, cancel. Snooze stays silent, the A09 CRUD reasoning:
  // hiding a reminder for three days moves no obligation.
  'task',
  // E02 HR-lite. Three attributable object kinds: an `employee` (create/edit of a personnel record),
  // an `absence` (recorded, cancelled), and an `expense_claim` (the money-path lifecycle: create,
  // submit, approve, reject, reimburse, and reverse_reimbursement when the reimbursement payment is
  // reversed). "Who approved this Spesen, and when" has to be attributable long after the claim row
  // has moved on, which is exactly what the chain is for.
  'employee',
  'absence',
  'expense_claim',
  // E01 e-signature. The signature request is the attributable object of a legal act: who sent a
  // document out for signature, who signed, who withdrew it and when a request lapsed all have to be
  // reconstructable long after the row moved on, which is exactly what the chain is for. Ordinary
  // draft edits stay silent, the A09/C00 CRUD split.
  'sign_request',
  // F02 customer portal. A portal grant is the attributable object of a revDSG access decision: who
  // opened a customer's portal access (`create`), handed the link over (`send`), revoked it
  // (`revoke`), and every token resolve (`view`) or denial (`deny`) and every portal quote acceptance
  // (`accept`) all have to be reconstructable long after the row moved on, which is exactly what the
  // access trail is for.
  'portal_grant',
  // F03 vendor portal. A remittance advice is the attributable object of a supplier-facing act: who
  // filed a Zahlungsavis for a payment, and when, has to be reconstructable long after the row moved
  // on. The one stamped action is `create` (an advice is an immutable snapshot; a correction is a new
  // superseding advice, itself a `create`), so no new ACTION word, only the object kind.
  'remittance_advice',
  // F01 report builder. A retained run is filed into E00 through `linkFile({ entityKind:
  // 'report_run', entityId })`, so the run is a linkable/attributable object the emission scan sees.
  // F01 itself posts nothing (P3): the consequential stamp on a filed run is `stored_file`'s, the
  // `stored_file` precedent one kind over, and the run's own vocabulary exists so the filter dropdown
  // and the entry column render a word rather than the raw `report_run` key.
  'report_run',
  // G02 plugins. An installed plugin is the attributable object of two auditable acts: a version
  // supersede (`update`, the manifest replaced in place by a newer version) and an uninstall
  // (`delete`, the row removed for good). Both are recorded in the append-only chain BEFORE the row
  // changes, so what a third-party extension was, and when it was superseded or removed, stays
  // reconstructable long after the manifest table moved on. No new ACTION word, only the object kind.
  'plugin',
  // A31 document capture. A capture queue row is the attributable object of four auditable acts:
  // `intake` (a document entered the queue), `extract` (its fields were re-run or corrected),
  // `commit` (it became an A17/E02 draft) and `discard`. Each is recorded in the append-only chain,
  // so who moved a Beleg through the queue, and when, stays reconstructable. A31 posts nothing (P3);
  // the money-path stamp is A17's/E02's when the committed draft is later posted.
  'capture',
  // A34 payroll hand-off. The engine emits `entityKind:'payroll_handoff'` on `export` (the artifact
  // was produced) and on `post` (a wage journal reached the ledger), so the kind is named here and in
  // both locales, or the AuditPanel renders the raw key and `audit-vocabulary.test.ts` reddens.
  'payroll_handoff',
  // H02 asset acquisition. The sub-ledger transaction is the attributable object of a capitalisation:
  // the engine stamps `post` when an acquisition or additional-capitalisation writes its
  // asset_transaction row alongside the balanced A02 journal. The GL entry keeps its own `entry` row
  // (A02); this kind exists so "who capitalised this asset, and when" is legible on the register's
  // own object, and so the AuditPanel renders a word rather than the raw `asset_transaction` key.
  'asset_transaction',
  // I02 goods receipt. The receipt document is the attributable object of the physical entry of goods:
  // the engine stamps `create`, `update` (a draft line edit), `post`, `approve` / `reject` (the
  // inspection decisions), `reverse`, `cancel` and `flag` (an accepted over-delivery, A25's word:
  // nothing is undone, the receipt is merely marked as carrying a discrepancy) on it. NO new ACTION
  // word is needed, and that is deliberate: every one of those already means here exactly what it
  // means everywhere else, and minting `received` / `accepted` synonyms would split the vocabulary
  // for no gain. The stock
  // movements the post writes are J02's own append-only rows; this kind is what makes "who received
  // these goods, and when" legible on the receipt itself.
  'goods_receipt',
  // I05 landed costs. The voucher is the attributable object of a capitalisation decision: the
  // engine stamps `create` on the draft, `post` when the freight/duty/handling amounts flow into
  // the inventory value with their balanced entry, and `reverse` on the undo. No new ACTION word.
  // The engine emits the kind through a const (`SOURCE_DOC_TYPE` in src/core/procurement/
  // landed_cost.ts), the one indirected kind among the literal emitters; the guard resolves that
  // indirection since the K-6 hardening, so removing this entry reddens the suite by name.
  'landed_cost_voucher',
  // H08 maintenance log. The log is the attributable object of a service event: the engine stamps
  // `create`, `update` and `cancel` on it. It posts NOTHING (the captured cost is descriptive TCO
  // metadata), so no `post` word is emitted; this kind exists so the AuditPanel renders a word rather
  // than the raw `asset_maintenance_log` key and "who logged this maintenance, and when" stays legible.
  'asset_maintenance_log',
  // J04 cycle count / stocktake. The session is the attributable object of a Bestandesnachweis: the
  // engine stamps `create` (a stocktake was opened at a freeze date), `commit` (its variances were
  // posted as OP13 movements, the money-path moment OR 958c Abs. 2 rests on) and `cancel`. It posts
  // no journal itself (the quantity movements are J02's append-only rows), so no `post` word; this
  // kind exists so "who committed this Inventur, and when" stays legible on the session's own object.
  'cycle_count_session',
  // J05 inventory adjustments & reasons. Two attributable objects: the reason code (the engine stamps
  // `create`, `update`, `archive` as its catalog is managed) and the adjustment record (the engine
  // stamps `create` on a manual adjustment and `reverse` on its linked reversal). Neither posts a
  // journal itself (the quantity movements are J02's append-only rows), so no `post` word; these kinds
  // exist so "who wrote this shrinkage off, and when" and "who changed this reason code" stay legible.
  'inventory_reason_code',
  'inventory_adjustment',
  // G18 cutover. The migration plan is the attributable object of the go-live acts: the R5 documents
  // commit-arm links a retained Beleg to the plan (a `stored_file` link stamps the plan), and the
  // go-live freeze and the plan close are the same shape of attributable moment. Its own object kind
  // so "who ran this Übernahme, and when" stays legible on the plan itself, and so the AuditPanel
  // renders a word rather than the raw `migration_plan` key.
  'migration_plan',
  // M02: the §I sync publish dial. Not a data record and not a ledger effect: a workspace-level egress
  // posture whose enable/disable an owner and an auditor both need to see in the trail.
  'sync',
  // A38, Abgrenzungen und Rückstellungen. Two money-path emitters: an accrual stamps `create`,
  // `post` (the pair), `reverse` (the Storno pair) and `discard`; a provision stamps the same plus
  // `release`. Their own object kinds and not `entry`, for the A22 reason: they name the Abgrenzung
  // or Rückstellung a human described, not the individual journal entries it produced.
  'accrual',
  'provision',
] as const;

/** Every action the audit log can name. */
export const AUDIT_ACTIONS = [
  'create',
  'post',
  'allocate',
  'reverse',
  'close',
  'lock',
  'unlock',
  'record',
  'elect',
  'update',
  'archive',
  'unarchive',
  'claim_owner',
  'invite',
  'set_role',
  'revoke',
  // C00. Both are their own word rather than reusing one above, and for the same reason `revoke` is
  // not `archive`: a merge is not an `update` (it retires one row onto another, one-way, and moves
  // every reference with it), and an anonymise is not a `revoke` or an `archive` (the row survives so
  // the posted documents keep their party, while the person inside it is erased). Reading either as a
  // master-data edit years later would understate exactly the acts this chain exists to record.
  'contact_merge',
  'contact_anonymise',
  // E00. Neither reuses a word above, and the near misses are why. `file_delete` is not `archive`:
  // archiving is reversible and keeps the row, while this erases the metadata AND the bytes, which is
  // the one irreversible act in the capability. `file_retention` is not `lock` or `elect`: a period
  // lock decides what may be posted and an election picks a tax rule, while this moves the date on
  // which a business record stops having to exist. Reading either as a master-data edit years later
  // would understate exactly the two acts this chain is stamping them for.
  'file_delete',
  'file_retention',
  // F5. Not `archive` and not `revoke`: the rule row survives, nothing about WHO may act moved, and
  // what changed is only whether the rule may keep firing unattended. Reading it as either would
  // overstate a one-column flip the operator can see on the Automations surface.
  'disable',
  // A21. Three words, each refused a near miss:
  //   - `apply` is not `allocate`: A14's `allocate` assigns an already-booked payment's Guthaben,
  //     while `apply` is the matching DECISION that causes the A14 booking in the first place. The
  //     resulting payment stamps its own `post`/`allocate` rows; this one records who decided.
  //   - `override` is not `reverse`: the reversal it drives stamps `reverse` on the PAYMENT
  //     already; this row records the human veto on the MATCH, which may also re-point or dismiss
  //     and so is wider than any one payment's undoing.
  //   - `set_auto_apply` is not `elect` (that word is tax-loaded: MWSTV elections) and not
  //     `disable` (the flip goes both ways, and the ON direction is the consequential one): it is
  //     the dial that decides whether money may move unattended.
  'apply',
  'override',
  'set_auto_apply',
  // A20. `import` stamps the statement fact itself, once per genuinely new camt file (a re-import
  // dedupes and stamps nothing, the same shape `record` on `exchange_rate` uses for a duplicate
  // rate). `confirm` and `book` are the two decisions a DEBIT txn can reach, neither a near miss of
  // a word above: `confirm` is not `apply` (A21's word for a CREDIT decision on the OTHER queue) and
  // settles through A14 underneath it; `book` is not `post` (the journal entry it causes stamps its
  // own `entry`/`post` row already) and records that THIS txn was the reason a manual entry exists.
  'import',
  'confirm',
  'book',
  // A38. Two words, each refused a near miss:
  //   - `release` is not `reverse`: an Auflösung is a NEW posting (Dr provision / Cr target) that
  //     consumes the provision, never a mirror of the formation; the formation's mirror IS `reverse`.
  //   - `discard` is not `archive` (nothing is hidden for reference; a draft that never posted is
  //     retired for good) and not `cancel` (E03's word for a duty): it records that a described
  //     accrual or provision was withdrawn before it ever reached the journal.
  'release',
  //   - `release_reverse` is not `reverse`: it mirrors ONE release (`provision_release_reverse`), the
  //     provision stands with its balance restored; `reverse` mirrors the formation itself.
  'release_reverse',
  'discard',
  // A25. Three words, each refused a near miss:
  //   - `comment` is not `record`: `record` mints a statutory input (a rate, a credit), while a
  //     comment only ever asks a question about a posting that already exists.
  //   - `flag` is not `override` or `reverse`: nothing is undone, the entry is merely marked as
  //     questioned until someone answers with an approval or a reversing entry.
  //   - `approve` is not `confirm`: `confirm` is A20's settlement decision about whose money
  //     arrived; this is the fiduciary sign-off that a posting was checked, the row the period
  //     lock then stands on.
  'comment',
  'flag',
  'approve',
  // G12. `go_productive` is not `create` and not `update`: creating a workspace stamps its own
  // `create` row, while this records the ONE irreversible transition a Testmandant makes, the moment
  // its `kind` moves sandbox -> live and it becomes real books. Reading it as an `update` years later
  // would understate exactly the act (the least reversible in the product) this chain exists to stamp.
  'go_productive',
  // B00. `reopen` is not `unlock` (that word is A03's, about what may be POSTED in a period) and
  // not `unarchive` (nothing was hidden; a closed project is fully visible): it is the gated step
  // that puts a finished piece of work back in play so it can attract bookings again.
  // E03. Three words, each refused a near miss:
  //   - `complete` is not `close` (period-loaded) and not `approve` (A25's fiduciary sign-off on a
  //     posting): it records that a duty was finished, by whom.
  //   - `cancel` is not `archive` (reversible, row kept for reference) and not `revoke`
  //     (membership-loaded): a cancelled task is terminally "wird nicht erledigt".
  //   - `reopen` is not `update`: resurrecting a finished duty is the one edit that un-finishes
  //     work, and reading it as a retitle years later would understate it.
  'complete',
  'cancel',
  'reopen',
  // G22: an item marked not applicable with a reason (the conscious waiver, never a silent drop).
  'skip',
  // E02 HR-lite. Three words for the Spesen money-path, each refused a near miss:
  //   - `submit` is not `record`: a claim is handed on for review, no statutory input is minted.
  //   - `reject` is not `cancel` or `flag`: it terminally refuses a submitted claim with a reason,
  //     distinct from the claimant abandoning a draft and from A25's question-only flag on a posting.
  //   - `reimburse` is not `pay` (the A14 payment stamps its own row) and not `allocate`: it records
  //     that THIS claim was the reason an outgoing settlement exists. `approve` reuses A25's word (a
  //     sign-off that a posting was checked, which is exactly what approving a claim is).
  //   - `reverse_reimbursement` is not `reverse` (that word is the PAYMENT's own row, stamped by A14
  //     when reverse_payment undoes the outgoing settlement): it records the claim-side consequence,
  //     the reimbursed->approved walk-back that keeps the claim in step with the reopened 2260
  //     liability (D95). Its own word so the audit trail names WHICH act, the claim revert or the
  //     payment reversal, a reader is looking at.
  'submit',
  'reject',
  'reimburse',
  'reverse_reimbursement',
  // E01 e-signature lifecycle: `send` a request out, a signer `view`s it then `sign`s or `decline`s
  // it, the sender `withdraw`s it, a request `expire`s unsigned, and `delete` removes a never-sent
  // draft. Each is the attributable moment of a legal act on the signature request. `record_event`
  // emits `view` and `decline` through a status ternary, and since the conditional scrape landed in
  // `audit-vocabulary.test.ts` the coverage suite reads both branches: removing either word below
  // now fails the scan instead of passing silently.
  'send',
  'view',
  'sign',
  'decline',
  'withdraw',
  'expire',
  'delete',
  // F02 customer portal. Two words, each refused a near miss:
  //   - `deny` is not `revoke` (an operator ends access) and not `reject`: it records that a presented
  //     token was refused at resolve/accept time (expired, revoked, or scoped to another contact), the
  //     revDSG access-trail entry for an attempt that saw nothing. `create`/`send`/`revoke`/`view`
  //     reuse the words above (minting the grant, handing the link over, ending access, a successful
  //     token resolve is a read of the scoped data).
  //   - `accept` is not `approve` (A25's fiduciary sign-off on a posting) and not `confirm` (A20's
  //     settlement decision): it records that a customer accepted a quote THROUGH the portal, the
  //     attributable portal act on top of C02's own transition trail.
  'deny',
  'accept',
  // A31 document capture. Four words, each refused a near miss:
  //   - `intake` is not `import` (A20/A04 bulk-load a foreign dataset) and not `create`: it records
  //     that ONE supplier document entered the Belegeingang queue and was hashed and stored.
  //   - `extract` is the re-run/correction of a capture's proposed fields; no existing word names it
  //     (`update` is a generic record edit, and a capture's field history is append-only, not edited).
  //   - `commit` is not `post` (A31 posts nothing, P3) and not `book`/`confirm`: it records that a
  //     reviewed capture became an A17/E02 DRAFT. The posting of that draft is A17's own `post`.
  //   - `discard` is not `delete` (the E00 document survives) and not `cancel`/`reject`: it records
  //     that a queue row was set aside as not bookable, terminally but recoverably by re-upload.
  'intake',
  'extract',
  'commit',
  'discard',
  // A34: `export` records that a payroll hand-off ARTIFACT was produced (it is not `create`, which is
  // a data record, nor `post`, which is a ledger effect: an export writes a file, not a booking).
  // A34's wage-journal posting records `post` (already above), the money-path stamp it deserves.
  'export',
  // M02: `enable` records that a workspace owner turned the §I sync publish stream ON (the egress
  // consent act). Its OFF twin reuses `disable` (above), the same generic toggle the automation-rule
  // pause records: an auditor reads "Sync publishing enabled / disabled" from the entityKind + action.
  'enable',
] as const;

export type AuditEntityKind = (typeof AUDIT_ENTITY_KINDS)[number];
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
